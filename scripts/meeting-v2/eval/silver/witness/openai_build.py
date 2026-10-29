"""Build corpus/<id8>/openai.json from the raw gpt-transcribe chunks. Counts only.

The model gives text only (no timestamps). Steps:
1. Overlap: chunk k (k >= 1) starts 5 s before k*600 s. Its first 60 words are matched to the last 60 words
   of chunk k-1 (difflib longest block, >= 3 words, inside the first 40 words); the words up to the end of
   that block are dropped. No block = nothing dropped.
2. Lines: split at sentence ends, merge to 8..40 words. Source time x of a line = kept-text start + chunk
   length * character share (a rough clock).
3. Clock: align_eg2.py method A (EmbeddingGemma 2 text-text: cosine of each line to the h1+h3 chunks of
   the same channel, monotonic DP, 2 passes, tau = q0.1 of row max) and method B (lines vs 22.5 s audio
   windows) for time_quality, with the align_eg2 rule: good when A and B agree within 10 s for >= 70 %
   of the lines both match; bad when < 30 % or median |A-B| > 60 s; else coarse. Extra check (report
   only): unique 4-gram anchors vs h1+h3 as in gemini_stitch.py.
Run (EG2 venv): python -I openai_build.py [--write]   (needs $SILVER_WORK/cloud/cache_oai/<id8>.npz from openai_embed.py; without --write a dry run)
"""
import json, os, re, sys, glob, difflib, statistics, random
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

GS = os.path.join(P.HERE, "align")  # align_eg2.py, align_ext.py
CORP = P.CORPUS
IDS = P.meeting_ids()
MODEL = "gpt-transcribe"
RAW = os.path.join(P.WORK, "cloud", "raw", f"openai-{MODEL}")
WRITE = "--write" in sys.argv


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def nw(w):
    return re.sub(r"\W+", "", w.lower())


def lines_of(m):
    """-> {ch: [dict(text, x, chunk)]}, meta list, overlap stats."""
    raws = sorted((J(p) for p in glob.glob(f"{RAW}/{m}_*_*.json")), key=lambda r: (r["channel"], r["chunk"]))
    out, meta, ov = {"mic": [], "system": []}, [], []
    prev = {}
    for r in raws:
        ch, k = r["channel"], r["chunk"]
        words = r["text"].split()
        cut = 0
        if k and ch in prev:
            a = [nw(w) for w in prev[ch][-60:]]
            b = [nw(w) for w in words[:60]]
            mt = difflib.SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b))
            if mt.size >= 3 and mt.b < 40:
                cut = mt.b + mt.size
            ov.append(cut)
        prev[ch] = words
        kept = words[cut:]
        t0 = r["startS"] if (k == 0 or cut == 0) else k * 600.0
        # sentences, merged to 8..40 words
        sents, cur = [], []
        for w in kept:
            cur.append(w)
            if (re.search(r"[.?!]$", w) and len(cur) >= 8) or len(cur) >= 40:
                sents.append(cur); cur = []
        if cur:
            if sents and len(cur) < 8:
                sents[-1] += cur
            else:
                sents.append(cur)
        L = max(1, len(" ".join(kept)))
        pos = 0
        for sw in sents:
            t = " ".join(sw)
            out[ch].append(dict(text=t, x=int(round(1000 * (t0 + (r["endS"] - t0) * pos / L))), chunk=k))
            pos += len(t) + 1
        meta.append({"channel": ch, "chunk": k, "startMs": int(r["startS"] * 1000), "endMs": int(r["endS"] * 1000), "h1Words": r["h1_words"],
                     "words": r["words"], "ratio": r["ratio"], "flag": r["flag"], "model": r["model"], "status": r["status"],
                     "overlapWordsDropped": cut, "usageSeconds": (r["usage"] or {}).get("seconds"), "usd": r["usd"]})
    return out, meta, ov


def token_times(text, s, e):
    L = max(1, len(text or ""))
    return [(mt.group(0), s + (e - s) * mt.start() / L) for mt in re.finditer(r"\w+", (text or "").lower())]


def grams(seq, n=4):
    d = {}
    for i in range(len(seq) - n + 1):
        d.setdefault(tuple(w for w, _ in seq[i:i + n]), []).append(i)
    return d


def main():
    import numpy as np
    sys.path.insert(0, GS)
    import align_eg2 as A
    import align_ext as AX
    print("| meeting | lines | overlap cuts (of k>=1) | matched A | both A,B | agree10s | median abs(A-B) s | quality | anchors | anchor median s | anchor p80 s | flagged chunks |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    allq = {}
    for m in IDS:
        lines, meta, ov = lines_of(m)
        cache = np.load(os.path.join(P.WORK, "cloud", "cache_oai", f"{m}.npz"))
        h1 = J(f"{CORP}/{m}/h1.json")
        res = {"mic": [], "system": []}
        diffsAB = []
        nA = nboth = 0
        for ch in ("mic", "system"):
            T = lines[ch]
            if not T:
                continue
            E = cache[f"oai_{ch}"]; assert len(E) == len(T)
            C1, C3 = cache[f"h1_{ch}"], cache[f"h3_{ch}"]
            n1, n3 = np.abs(C1).sum(1) > 0, np.abs(C3).sum(1) > 0
            S1, S3 = E @ C1.T, E @ C3.T
            Sm = np.where((n1 & n3)[None, :], (S1 + S3) / 2, np.where(n1[None, :], S1, S3))
            Em = np.abs(E).sum(1) > 0
            simA = np.where(~Em[:, None] | ~(n1 | n3)[None, :], -np.inf, Sm)
            colA = [(c["startMs"], c["endMs"]) for c in h1["channels"][ch]]
            simB = np.where(~Em[:, None], -np.inf, E @ cache[f"aud_{ch}"].T)
            colB = [(int(s), int(s) + 22500) for s in cache[f"audstart_{ch}"]]
            xa = np.asarray([t["x"] for t in T], float)

            def two_pass(sim, cols):
                line = None
                for pas in (1, 2):
                    S = sim.copy()
                    if line is not None:
                        a, b = line
                        pred = a * xa + b
                        cs = np.array([c[0] for c in cols]); ce = np.array([c[1] for c in cols])
                        S[(ce[None, :] < pred[:, None] - A.BAND) | (cs[None, :] > pred[:, None] + A.BAND)] = -np.inf
                    rowmax = S.max(1)
                    okr = np.isfinite(rowmax)
                    out = {}
                    if okr.any():
                        tau = float(np.quantile(rowmax[okr], A.TAU_Q))
                        for i, j in A.dp_align(np.where(np.isfinite(S), S - tau, -1e18)):
                            out.setdefault(i, []).append(j)
                    pts = [(xa[i], cols[js[0]][0]) for i, js in out.items()]
                    if len(pts) < 5:
                        return out, (line or (1.0, 0.0))
                    a, b, _ = AX.fit(pts, random.Random(0))
                    line = (a, b)
                return out, line

            mA, lineA = two_pass(simA, colA)
            by = {}
            for i, js in mA.items():
                by.setdefault(js[0], []).append(i)
            tA, al = [None] * len(T), [None] * len(T)
            for i, js in mA.items():
                s0, e0 = colA[js[0]]
                share = sorted(by[js[0]])
                lens = [max(1, len(T[q]["text"])) for q in share]
                tA[i] = int(round(s0 + (e0 - s0) * sum(lens[:share.index(i)]) / sum(lens)))
                al[i] = [colA[js[0]][0], colA[js[-1]][1]]
            mB, _ = two_pass(simB, colB)
            tB = [None] * len(T)
            for i, js in mB.items():
                cen = float(np.mean([colB[b][0] + 11250 for b in js]))
                tB[i] = int(round(cen - min(20000, 1000 * len(T[i]["text"]) / 15) / 2))
            mi = [i for i in range(len(T)) if tA[i] is not None]
            full = list(tA)
            for i in range(len(T)):
                if full[i] is not None:
                    continue
                prv = [q for q in mi if q < i]; nxt = [q for q in mi if q > i]
                if prv and nxt:
                    p, q = prv[-1], nxt[0]
                    w = (xa[i] - xa[p]) / (xa[q] - xa[p]) if xa[q] != xa[p] else (i - p) / (q - p)
                    full[i] = int(round(tA[p] + w * (tA[q] - tA[p])))
                else:
                    full[i] = int(round(lineA[0] * xa[i] + lineA[1]))
            # keep time order (DP is monotonic; interpolation keeps it)
            for i in range(1, len(T)):
                full[i] = max(full[i], full[i - 1])
            nA += len(mi)
            both = [i for i in range(len(T)) if tA[i] is not None and tB[i] is not None]
            nboth += len(both)
            diffsAB += [abs(tA[i] - tB[i]) for i in both]
            for i, t in enumerate(T):
                nxt = full[i + 1] if i + 1 < len(T) else full[i] + 30000
                end = al[i][1] if al[i] else min(max(nxt, full[i] + 1000), full[i] + 30000)
                seg = {"startMs": max(0, full[i]), "endMs": max(max(0, full[i]) + 1, end), "text": t["text"], "chunk": t["chunk"]}
                if al[i]:
                    seg["alignedMs"] = al[i]
                res[ch].append(seg)
            res[ch].sort(key=lambda s: (s["startMs"], s["endMs"]))
        diffsAB.sort()
        agree = 100 * sum(d <= A.AGREE_S for d in diffsAB) / len(diffsAB) if diffsAB else 0.0
        med = statistics.median(diffsAB) if diffsAB else None
        q = "good" if agree >= A.GOOD_P else "bad" if (agree < A.BAD_P or med is None or med > A.BAD_MED) else "coarse"
        # anchor check (report only)
        an = []
        for ch in ("mic", "system"):
            gseq = [tt for s in res[ch] for tt in token_times(s["text"], s["startMs"], s["endMs"])]
            gg = grams(gseq)
            for hn in ("h1", "h3"):
                hseq = [tt for s in J(f"{CORP}/{m}/{hn}.json")["channels"][ch] for tt in token_times(s["text"], s["startMs"], s["endMs"])]
                hg = grams(hseq)
                an += [abs(gseq[ii[0]][1] - hseq[hg[g][0]][1]) for g, ii in gg.items() if len(ii) == 1 and len(hg.get(g, [])) == 1]
        an.sort()
        ap80 = an[int(0.8 * (len(an) - 1))] if an else None
        amed = statistics.median(an) if an else None
        nl = sum(len(v) for v in lines.values())
        nk = sum(1 for x in meta if x["chunk"] > 0)
        print(f"| {m} | {nl} | {sum(1 for c in ov if c)}/{nk} | {nA} | {nboth} | {agree:.1f}% | {'-' if med is None else round(med/1000,1)} | {q} | "
              f"{len(an)} | {'-' if amed is None else round(amed/1000,1)} | {'-' if ap80 is None else round(ap80/1000,1)} | {sum(x['flag'] for x in meta)} |")
        allq[q] = allq.get(q, 0) + 1
        out = {"engine": f"{MODEL} via OpenAI API (POST /v1/audio/transcriptions, response_format json, temperature 0, no prompt, no language); "
                         "600 s chunks with 5 s overlap (mp3 16 kHz mono 48 kbps)",
               "model": MODEL, "language": "en", "meeting": m,
               "time_basis": (f"no timestamps from the model. Lines (sentences merged to 8-40 words) aligned with align_eg2 method A "
                              f"(EmbeddingGemma 2 text-text to h1+h3 chunks, same channel, monotonic DP, 2 passes): matched {nA}/{nl} lines; "
                              f"startMs by character share inside the matched chunk, unmatched lines interpolated; alignedMs = the matched h1 chunk run. "
                              f"Overlap removed by word match to the previous chunk tail ({sum(1 for c in ov if c)}/{nk} cuts). "
                              f"Audio check (method B): both={nboth}, agree10s={agree:.1f}%, median|A-B|={'-' if med is None else f'{med/1000:.1f}s'}; "
                              f"align_eg2 rule good >= 70%, bad < 30% or median > 60 s. Anchor check vs h1+h3 unique 4-grams: n={len(an)}, "
                              f"median={'-' if amed is None else f'{amed/1000:.1f}s'}, p80={'-' if ap80 is None else f'{ap80/1000:.1f}s'}"),
               "time_quality": q, "chunks": meta, "channels": res}
        if WRITE:
            p = f"{CORP}/{m}/openai.json"
            with open(p + ".tmp", "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, indent=1)
            os.chmod(p + ".tmp", 0o600); os.replace(p + ".tmp", p)
            J(p)
    print("\ntime_quality counts:", allq)


if __name__ == "__main__":
    main()
