"""Align meet.json / krisp.json to the local clock with EmbeddingGemma 2. Counts only.

Run: python3 -I align_eg2.py [--write]   (needs $SILVER_WORK/eg2-cache/<id8>.npz from eg2_embed.py; without --write a dry run)
Method A (primary, text-text): cosine of each external line ("query") to
  each local chunk of the same channel ("document"; mean of the H1 and H3
  cosines). A monotonic DP (Needleman-Wunsch style, free gaps, 1-to-many
  and many-to-1) maximizes sum(cos - tau). A matched line gets the start of
  its first matched chunk (lines that share a chunk split it by character
  share). An unmatched line is interpolated between matched lines by its
  source time.
Method B (check, audio-text): the same DP of lines to 22.5 s audio windows
  (hop 7.5 s). B time = mean window center - half the line length (15 chars/s).
Anchors (comparison): align_ext.anchor (rare 4-grams vs H1/H3).
time_quality: good when A and B agree within 10 s for >= 70 % of the lines
  that both match; bad when agreement < 30 % or median |A-B| > 60 s; else coarse.
"""
import json, os, sys, shutil, statistics, random
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # own folder only (-I drops it)
import align_ext as AX

CORP = AX.CORP
CACHE = AX.P.work_dir("eg2-cache")
WRITE = "--write" in sys.argv
TAU_Q = float(os.environ.get("TAU_Q", "0.1"))  # tau = this quantile of the row maxima (pooled sweep: max of agree - disagree lines)
AGREE_S, GOOD_P, BAD_P, BAD_MED = 10000, 70.0, 30.0, 60000
BAND = 60000  # ms, pass-2 band around the pass-1 line fit


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def dp_align(S):
    """S: (n lines, m cols) of score (cos - tau); -inf = forbidden. Returns pairs (i, j)."""
    n, m = S.shape
    NEG = -1e18
    D = np.zeros((n + 1, m + 1))
    Mx = np.full((n + 1, m + 1), NEG)
    bM = np.zeros((n + 1, m + 1), dtype=np.int8)  # 0 diag from D, 1 from M up, 2 from M left
    bD = np.zeros((n + 1, m + 1), dtype=np.int8)  # 0 up, 1 left, 2 match
    for i in range(1, n + 1):
        Si = S[i - 1]
        Dp, Mp = D[i - 1], Mx[i - 1]
        Di, Mi = D[i], Mx[i]
        Di[0] = 0.0
        for j in range(1, m + 1):
            s = Si[j - 1]
            if s > -1e17:
                a, b, c = Dp[j - 1], Mp[j], Mi[j - 1]
                if a >= b and a >= c:
                    Mi[j] = s + a; bM[i, j] = 0
                elif b >= c:
                    Mi[j] = s + b; bM[i, j] = 1
                else:
                    Mi[j] = s + c; bM[i, j] = 2
            u, l, mm = Dp[j], Di[j - 1], Mi[j]
            if u >= l and u >= mm:
                Di[j] = u; bD[i, j] = 0
            elif l >= mm:
                Di[j] = l; bD[i, j] = 1
            else:
                Di[j] = mm; bD[i, j] = 2
    pairs, i, j, state = [], n, m, "D"
    while i > 0 and j > 0:
        if state == "D":
            k = bD[i, j]
            if k == 0: i -= 1
            elif k == 1: j -= 1
            else: state = "M"
        else:
            pairs.append((i - 1, j - 1))
            k = bM[i, j]
            if k == 0: i, j, state = i - 1, j - 1, "D"
            elif k == 1: i -= 1
            else: j -= 1
    return pairs[::-1]


def scores(E, C):
    """cos matrix with zero rows/cols (empty text) forbidden; tau from row maxima."""
    S = E @ C.T
    bad = (np.abs(E).sum(1) == 0)[:, None] | (np.abs(C).sum(1) == 0)[None, :]
    S = np.where(bad, -np.inf, S)
    rowmax = S.max(1) if S.shape[1] else np.zeros(len(S))
    ok = np.isfinite(rowmax)
    tau = float(np.quantile(rowmax[ok], TAU_Q)) if ok.any() else 1.0
    return np.where(bad, -1e18, S - tau), tau


def robust_line(xs, ys):
    """Theil-Sen style: median slope over sampled pairs, then median offset."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    rng = np.random.default_rng(0)
    k = min(20000, len(xs) * (len(xs) - 1) // 2)
    i, j = rng.integers(0, len(xs), k), rng.integers(0, len(xs), k)
    ok = np.abs(xs[i] - xs[j]) > 60000
    a = float(np.median((ys[j] - ys[i])[ok] / (xs[j] - xs[i])[ok])) if ok.any() else 1.0
    return a, float(np.median(ys - a * xs))


def run(m, name, cache):
    d = J(f"{CORP}/{m}/{name}.orig.json")
    T = d["turns"]
    x, _ = AX.ext_x(T)
    chans = ["mic" if t["speaker"] == AX.OWNER else "system" for t in T]
    h1 = J(f"{CORP}/{m}/h1.json")
    xa = np.asarray(x, float)
    li_of = {ch: [i for i, c in enumerate(chans) if c == ch] for ch in ("mic", "system")}
    # similarity matrices per channel: A = text-text (mean h1/h3), B = text-audio
    simA, simB, colA, colB = {}, {}, {}, {}
    for ch, li in li_of.items():
        if not li:
            continue
        E = cache[f"ext_{name}_{ch}"]
        assert len(E) == len(li)
        C1, C3 = cache[f"h1_{ch}"], cache[f"h3_{ch}"]
        n1, n3 = np.abs(C1).sum(1) > 0, np.abs(C3).sum(1) > 0
        S1, S3 = E @ C1.T, E @ C3.T
        Sm = np.where((n1 & n3)[None, :], (S1 + S3) / 2, np.where(n1[None, :], S1, S3))
        Emask = np.abs(E).sum(1) > 0
        simA[ch] = np.where(~Emask[:, None] | ~(n1 | n3)[None, :], -np.inf, Sm)
        colA[ch] = [(c["startMs"], c["endMs"]) for c in h1["channels"][ch]]
        A_ = cache[f"aud_{ch}"]; ws = cache[f"audstart_{ch}"]
        simB[ch] = np.where(~Emask[:, None], -np.inf, E @ A_.T)
        colB[ch] = [(int(s), int(s) + 22500) for s in ws]

    def two_pass(sim, cols, tag):
        """Pass 1: DP on all pairs. Fit local = a*x + b (RANSAC, slope 0.97-1.03).
        Pass 2: DP only on columns within +-BAND of the fitted time."""
        line = None
        for pas in (1, 2):
            out = {}
            for ch, S in sim.items():
                li = li_of[ch]
                S = S.copy()
                if line is not None:
                    a, b = line
                    pred = a * xa[li] + b
                    cs = np.array([c[0] for c in cols[ch]]); ce = np.array([c[1] for c in cols[ch]])
                    far = (ce[None, :] < pred[:, None] - BAND) | (cs[None, :] > pred[:, None] + BAND)
                    S[far] = -np.inf
                rowmax = S.max(1) if S.shape[1] else np.full(len(S), -np.inf)
                okr = np.isfinite(rowmax)
                if not okr.any():
                    continue
                tau = float(np.quantile(rowmax[okr], TAU_Q))
                taus[(tag, ch)] = tau
                for a_, b_ in dp_align(np.where(np.isfinite(S), S - tau, -1e18)):
                    out.setdefault(li[a_], []).append((ch, b_))
            pts = [(xa[i], cols[js[0][0]][js[0][1]][0]) for i, js in out.items()]
            if pas == 1:
                if len(pts) < 5:
                    return out, (1.0, 0.0)
                a, b, _ = AX.fit(pts, random.Random(0))
                line = (a, b)
        if len(pts) >= 5:
            a, b, _ = AX.fit(pts, random.Random(0))
            line = (a, b)
        return out, line

    tA = [None] * len(T); aligned = [None] * len(T); tB = [None] * len(T)
    taus = {}
    mA, lineA = two_pass(simA, colA, "A")
    by_chunk = {}
    for i, js in mA.items():
        by_chunk.setdefault(js[0], []).append(i)
    for i, js in mA.items():
        ch, j0 = js[0]
        s0, e0 = colA[ch][j0]
        share = sorted(by_chunk[js[0]])
        lens = [max(1, len(T[k]["text"] or "")) for k in share]
        pre = sum(lens[:share.index(i)])
        tA[i] = int(round(s0 + (e0 - s0) * pre / sum(lens)))
        aligned[i] = [colA[ch][js[0][1]][0], colA[ch][js[-1][1]][1]]
    mB, lineB = two_pass(simB, colB, "B")
    for i, js in mB.items():
        ch = js[0][0]
        cen = float(np.mean([colB[ch][b][0] + 11250 for _, b in js]))
        dur = min(20000, 1000 * len(T[i]["text"] or "") / 15)
        tB[i] = int(round(cen - dur / 2))
    # interpolate unmatched lines (both channels share one clock)
    mi = [i for i in range(len(T)) if tA[i] is not None]
    A_full = list(tA)
    for i in range(len(T)):
        if tA[i] is not None:
            continue
        prv = [k for k in mi if k < i]; nxt = [k for k in mi if k > i]
        if prv and nxt:
            p, q = prv[-1], nxt[0]
            w = (x[i] - x[p]) / (x[q] - x[p]) if x[q] != x[p] else (i - p) / (q - p)
            A_full[i] = int(round(tA[p] + w * (tA[q] - tA[p])))
        elif prv or nxt:  # outside the matched range: the fitted line
            A_full[i] = int(round(lineA[0] * x[i] + lineA[1]))
        else:
            A_full[i] = int(round(x[i]))
    both = [i for i in range(len(T)) if tA[i] is not None and tB[i] is not None]
    diffs = sorted(abs(tA[i] - tB[i]) for i in both)
    agree = 100 * sum(dd <= AGREE_S for dd in diffs) / len(diffs) if diffs else 0.0
    med = statistics.median(diffs) if diffs else None
    q = "good" if agree >= GOOD_P else "bad" if (agree < BAD_P or med is None or med > BAD_MED) else "coarse"
    aA, bA = lineA
    an = AX.anchor(m, name)
    anc = [an["f"](x[i]) for i in range(len(T))]
    dAnc = statistics.median(abs(A_full[i] - anc[i]) for i in range(len(T)))
    dAncM = statistics.median(abs(tA[i] - anc[i]) for i in mi) if mi else None
    basis = (f"eg2 text-text (method A): monotonic DP of lines to h1+h3 chunks, same channel, tau=q{TAU_Q} of row max, 2 passes (pass 2 within +-{BAND//1000}s of the pass-1 RANSAC line); "
             f"matched={len(mi)}/{len(T)} lines, offset={bA/1000:+.1f}s, drift={100*(aA-1):+.2f}%; unmatched lines interpolated by source time between matched lines, fitted line outside them. "
             f"audio check (method B, eg2 audio-text, 22.5 s windows, hop 7.5 s): both matched={len(both)}, agree10s={agree:.1f}%, "
             f"median|A-B|={'-' if med is None else f'{med/1000:.1f}s'}. anchors (comparison): offset={an['b']/1000:+.1f}s, "
             f"drift={100*(an['a']-1):+.2f}%, median|A-anchor|={dAnc/1000:.1f}s")
    rep = dict(lines=len(T), matchedA=len(mi), matchedB=sum(t is not None for t in tB), both=len(both), agree=round(agree, 1),
               medAB=None if med is None else round(med / 1000, 1), q=q, offA=round(bA / 1000, 1), driftA=round(100 * (aA - 1), 2),
               offAnc=round(an["b"] / 1000, 1), driftAnc=round(100 * (an["a"] - 1), 2), medAAnc=round(dAnc / 1000, 1),
               medAAncMatched=None if dAncM is None else round(dAncM / 1000, 1), qAnc=an["q"],
               tau="/".join(f"{v:.2f}" for k, v in taus.items() if k[0] == "A"))
    out = {k: v for k, v in d.items() if k != "turns"}
    out["time_basis"] = basis
    out["time_quality"] = q
    out["turns"] = [dict(t, startMs=A_full[i], alignedMs=aligned[i]) for i, t in enumerate(T)]
    return rep, out


if __name__ == "__main__":
    rows = []
    for (m, name), path in sorted(AX.files.items()):
        cache = np.load(f"{CACHE}/{m}.npz")
        rep, out = run(m, name, cache)
        rows.append((m, name, rep))
        if WRITE:
            orig = path[:-5] + ".orig.json"
            assert os.path.exists(orig)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(out, fh, ensure_ascii=False, indent=1)
            os.chmod(tmp, 0o600); os.replace(tmp, path)
    cols = list(rows[0][2])
    print("| meeting | file | " + " | ".join(cols) + " |")
    print("|---|---|" + "---|" * len(cols))
    for m, n, r in rows:
        print(f"| {m} | {n} | " + " | ".join("-" if r[c] is None else str(r[c]) for c in cols) + " |")
