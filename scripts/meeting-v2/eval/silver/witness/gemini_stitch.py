"""Stitch raw Gemini chunks into corpus/<id8>/gemini.json and rate its clock. Counts only.

Run: python3 -I gemini_stitch.py [--write]   (reads $SILVER_WORK/cloud/raw/<GEM_MODEL, default gemini-4-argon>/; without --write a dry run)
Stitch: a segment of chunk k (k >= 1) is kept when its midpoint is at or after k*600 s
(the 5 s overlap before it belongs to chunk k-1); every chunk keeps up to (k+1)*600 s.
Clock check: unique word 4-grams shared with H1 and H3 (same channel; token time by
character position inside a segment). |gemini - local| per anchor.
time_quality: good when p80 <= 5 s, coarse when p80 <= 30 s, else bad (align_ext.py limits).
"""
import json, os, re, sys, glob, statistics
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

CORP = P.CORPUS
IDS = P.meeting_ids()
RAW = os.path.join(P.WORK, "cloud", "raw", os.environ.get("GEM_MODEL", "gemini-4-argon"))
CHUNK = 600000
WRITE = "--write" in sys.argv


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def token_times(text, s, e):
    L = max(1, len(text or ""))
    return [(mt.group(0), s + (e - s) * mt.start() / L) for mt in re.finditer(r"\w+", (text or "").lower())]


def grams(seq, n=4):
    d = {}
    for i in range(len(seq) - n + 1):
        d.setdefault(tuple(w for w, _ in seq[i:i + n]), []).append(i)
    return d


print("| meeting | chunks | flagged (ratio outside 0.6-1.6) | no-candidate | words gemini/h1 | anchors | median s | p80 s | within 3 s | quality |")
print("|---|---|---|---|---|---|---|---|---|---|")
tot = {"chunks": 0, "flag": 0}
for m in IDS:
    raws = sorted((J(p) for p in glob.glob(f"{RAW}/{m}_*_*.json")), key=lambda r: (r["channel"], r["chunk"]))
    chans, meta = {"mic": [], "system": []}, []
    for r in raws:
        k = r["chunk"]
        lo = k * CHUNK if k else -10 ** 12
        hi = (k + 1) * CHUNK if any(x["channel"] == r["channel"] and x["chunk"] == k + 1 for x in raws) else 10 ** 12
        for s in r["segments"]:
            mid = (s["startMs"] + s["endMs"]) / 2
            if lo <= mid < hi:
                chans[r["channel"]].append(dict(s, chunk=k))
        meta.append({"channel": r["channel"], "chunk": k, "startMs": int(r["startS"] * 1000), "endMs": int(r["endS"] * 1000),
                     "h1Words": r["h1_words"], "words": r["gem_words"], "ratio": r["ratio"], "flag": r["flag"],
                     "finishReason": r["finishReason"], "attempt": r.get("attempt", 1),
                     "promptTokens": r["usage"].get("promptTokenCount", 0), "outputTokens": r["usage"].get("candidatesTokenCount", 0),
                     "thinkingTokens": r["usage"].get("thoughtsTokenCount", 0)})
    for ch in chans:
        chans[ch].sort(key=lambda s: (s["startMs"], s["endMs"]))
    # clock check against h1 and h3
    diffs = []
    for ch in ("mic", "system"):
        gseq = [tt for s in chans[ch] for tt in token_times(s["text"], s["startMs"], s["endMs"])]
        gg = grams(gseq)
        for hn in ("h1", "h3"):
            hseq = [tt for s in J(f"{CORP}/{m}/{hn}.json")["channels"][ch] for tt in token_times(s["text"], s["startMs"], s["endMs"])]
            hg = grams(hseq)
            for g, ii in gg.items():
                if len(ii) == 1 and len(hg.get(g, [])) == 1:
                    diffs.append(abs(gseq[ii[0]][1] - hseq[hg[g][0]][1]))
    diffs.sort()
    p80 = diffs[int(0.8 * (len(diffs) - 1))] if diffs else None
    med = statistics.median(diffs) if diffs else None
    w3 = 100 * sum(d <= 3000 for d in diffs) / len(diffs) if diffs else 0
    q = "bad" if p80 is None or len(diffs) < 20 else "good" if p80 <= 5000 else "coarse" if p80 <= 30000 else "bad"
    nf = sum(x["flag"] for x in meta); nn = sum(x["finishReason"] is None for x in meta)
    tot["chunks"] += len(meta); tot["flag"] += nf
    gw = sum(x["words"] for x in meta); hw = sum(x["h1Words"] for x in meta)
    print(f"| {m} | {len(meta)} | {nf} | {nn} | {gw}/{hw} | {len(diffs)} | {'-' if med is None else round(med/1000,1)} | "
          f"{'-' if p80 is None else round(p80/1000,1)} | {w3:.0f}% | {q} |")
    mv = sorted({r.get("modelVersion") for r in raws if r.get("modelVersion")})
    out = {"engine": "gemini-4-argon via Gemini API (Files API upload + generateContent), temperature 0, thinkingLevel low, "
                     "JSON schema output, verbatim prompt, no speaker names; 600 s chunks with 5 s overlap (mp3 16 kHz mono 48 kbps)",
           "model": "gemini-4-argon", "modelVersion": mv, "language": "en", "meeting": m,
           "time_basis": (f"own timestamps (MM:SS per item, relative to the chunk) + chunk start; stitched by item midpoint at the chunk "
                          f"boundary. Clock check vs h1+h3 unique 4-gram anchors: n={len(diffs)}, median={'-' if med is None else f'{med/1000:.1f}s'}, "
                          f"p80={'-' if p80 is None else f'{p80/1000:.1f}s'}, within3s={w3:.0f}%; good p80<=5s, coarse p80<=30s"),
           "time_quality": q, "chunks": meta, "channels": chans}
    if WRITE:
        p = f"{CORP}/{m}/gemini.json"
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.chmod(p + ".tmp", 0o600); os.replace(p + ".tmp", p)
        J(p)
print(f"\ntotal chunks {tot['chunks']}, flagged {tot['flag']}")
