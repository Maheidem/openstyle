"""Merge the gemini-3.5-flash-lite fill chunks into corpus/<id8>/gemini.json. Counts only.

Run: python3 -I gemini_merge.py [--write] [--fill id8:ch:k,...] [--redo id8:ch:k,...]
FILL and REDO have no default: give one of them or both (the chunks of your fill run).
Without --write it is a dry run.
- Fill chunks (FILL) are added. A re-run chunk-0 (REDO) replaces the old chunk only when the new one is not flagged.
- Every chunk gets "model". Stitch rule of gemini_stitch.py, applied again over the new chunk set:
  a segment of chunk k is kept when k*600 s <= midpoint (k >= 1) and midpoint < (k+1)*600 s when chunk k+1 exists.
- Clock check (time_quality) as in gemini_stitch.py: unique 4-gram anchors vs h1+h3; good p80 <= 5 s, coarse <= 30 s.
- --write first copies the current file to $SILVER_WORK/cloud/bak/<id8>.gemini.before-fill.json (mode 600), once.
"""
import json, os, re, sys, glob, shutil, statistics
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

CORP = P.CORPUS
IDS = P.meeting_ids()
CLOUD = os.path.join(P.WORK, "cloud")
NEW = "gemini-3.5-flash-lite"
OLD = "gemini-4-argon"
CH = 600000


def _chunks(flag):
    a = sys.argv[sys.argv.index(flag) + 1]
    return {(m, ch, int(k)) for m, ch, k in (x.split(":") for x in a.split(",") if x)}


FILL = _chunks("--fill") if "--fill" in sys.argv else set()
REDO = _chunks("--redo") if "--redo" in sys.argv else set()
if not FILL and not REDO:
    raise SystemExit("give --fill id8:ch:k,... and/or --redo id8:ch:k,... (the chunks of the fill run)")
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


print("| meeting | chunks before -> after | added | replaced | kept old (new flagged) | flagged after | anchors | median s | p80 s | quality |")
print("|---|---|---|---|---|---|---|---|---|---|")
tot = dict(chunks=0, flag=0, new=0)
for m in IDS:
    p = f"{CORP}/{m}/gemini.json"
    g = J(p)
    meta = {(c["channel"], c["chunk"]): dict(c, model=c.get("model", OLD)) for c in g["chunks"]}
    segs = {ch: [dict(s) for s in g["channels"][ch]] for ch in ("mic", "system")}
    nb = len(meta); add = rep = keep = 0
    mv = set(g.get("modelVersion") or [])
    for (mm, ch, k) in sorted(FILL | REDO):
        if mm != m:
            continue
        r = J(f"{CLOUD}/raw/{NEW}/{m}_{ch}_{k}.json")
        if meta.get((ch, k), {}).get("model") == NEW:
            continue  # already merged (rerun)
        if (ch, k) in meta and (m, ch, k) in REDO:
            if r["flag"]:
                keep += 1
                continue
            segs[ch] = [s for s in segs[ch] if s.get("chunk") != k]
            rep += 1
        else:
            assert (ch, k) not in meta, (m, ch, k)
            add += 1
        segs[ch] += [dict(s, chunk=k) for s in r["segments"]]
        if r.get("modelVersion"):
            mv.add(r["modelVersion"])
        u = r["usage"]
        meta[(ch, k)] = {"channel": ch, "chunk": k, "startMs": int(r["startS"] * 1000), "endMs": int(r["endS"] * 1000), "h1Words": r["h1_words"],
                         "words": r["gem_words"], "ratio": r["ratio"], "flag": r["flag"], "finishReason": r["finishReason"], "attempt": r.get("attempt", 1),
                         "promptTokens": u.get("promptTokenCount", 0), "outputTokens": u.get("candidatesTokenCount", 0),
                         "thinkingTokens": u.get("thoughtsTokenCount", 0), "model": NEW}
    chans = {}
    for ch in ("mic", "system"):
        ks = {k for (c, k) in meta if c == ch}
        out = []
        for s in segs[ch]:
            k = s["chunk"]
            lo = k * CH if k else -10 ** 12
            hi = (k + 1) * CH if (k + 1) in ks else 10 ** 12
            if lo <= (s["startMs"] + s["endMs"]) / 2 < hi:
                out.append(s)
        out.sort(key=lambda s: (s["startMs"], s["endMs"]))
        chans[ch] = out
    diffs = []
    for ch in ("mic", "system"):
        gseq = [tt for s in chans[ch] for tt in token_times(s["text"], s["startMs"], s["endMs"])]
        gg = grams(gseq)
        for hn in ("h1", "h3"):
            hseq = [tt for s in J(f"{CORP}/{m}/{hn}.json")["channels"][ch] for tt in token_times(s["text"], s["startMs"], s["endMs"])]
            hg = grams(hseq)
            diffs += [abs(gseq[ii[0]][1] - hseq[hg[g_][0]][1]) for g_, ii in gg.items() if len(ii) == 1 and len(hg.get(g_, [])) == 1]
    diffs.sort()
    p80 = diffs[int(0.8 * (len(diffs) - 1))] if diffs else None
    med = statistics.median(diffs) if diffs else None
    w3 = 100 * sum(d <= 3000 for d in diffs) / len(diffs) if diffs else 0
    q = "bad" if p80 is None or len(diffs) < 20 else "good" if p80 <= 5000 else "coarse" if p80 <= 30000 else "bad"
    ml = sorted(meta.values(), key=lambda c: (c["channel"], c["chunk"]))
    nf = sum(c["flag"] for c in ml)
    tot["chunks"] += len(ml); tot["flag"] += nf; tot["new"] += sum(c["model"] == NEW for c in ml)
    print(f"| {m} | {nb} -> {len(ml)} | {add} | {rep} | {keep} | {nf} | {len(diffs)} | {'-' if med is None else round(med/1000,1)} | "
          f"{'-' if p80 is None else round(p80/1000,1)} | {q} |")
    models = sorted({c["model"] for c in ml})
    eng = ("Gemini API (Files API upload + generateContent), temperature 0, JSON schema output, verbatim prompt, no speaker names; "
           "600 s chunks with 5 s overlap (mp3 16 kHz mono 48 kbps); gemini-4-argon thinkingLevel low")
    if NEW in models:
        eng += f"; fill chunks by {NEW} (thinkingLevel low, same prompt), see chunks[].model"
    out = dict(g, engine=eng, model=" + ".join(models), modelVersion=sorted(mv),
               time_basis=(f"own timestamps (MM:SS per item, relative to the chunk) + chunk start; stitched by item midpoint at the chunk "
                           f"boundary. Clock check vs h1+h3 unique 4-gram anchors: n={len(diffs)}, median={'-' if med is None else f'{med/1000:.1f}s'}, "
                           f"p80={'-' if p80 is None else f'{p80/1000:.1f}s'}, within3s={w3:.0f}%; good p80<=5s, coarse p80<=30s"),
               time_quality=q, chunks=ml, channels=chans)
    if WRITE:
        os.makedirs(f"{CLOUD}/bak", mode=0o700, exist_ok=True)
        b = f"{CLOUD}/bak/{m}.gemini.before-fill.json"
        if not os.path.exists(b):
            shutil.copy2(p, b); os.chmod(b, 0o600)
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.chmod(p + ".tmp", 0o600); os.replace(p + ".tmp", p)
        J(p)
print(f"\ntotal chunks {tot['chunks']}, flagged {tot['flag']}, chunks by {NEW}: {tot['new']}")
