"""Align meet.json / krisp.json times to the local audio clock. Prints counts only.

Run: python3 -I align_ext.py [--write]
For each external file: keep <name>.orig.json (first run only), estimate
local = a * ext + b from unique word 4-gram anchors against H1 and H3
(same channel), then a local piecewise correction through the inlier
anchors. Writes startMs for every line, plus time_basis and time_quality.
"""
import json, os, re, sys, random, shutil, statistics
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

CORP = P.CORPUS
IDS = P.meeting_ids()
N = 4            # n-gram size
INLIER = 15000   # ms, RANSAC inlier threshold
GOOD, COARSE = 5000, 30000  # ms, LOO p80 limits (good = fits the +-5 s window)
WRITE = "--write" in sys.argv


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def toks(t):
    return re.findall(r"\w+", (t or "").lower())


files = {(m, n): f"{CORP}/{m}/{n}.json" for m in IDS for n in ("meet", "krisp") if os.path.exists(f"{CORP}/{m}/{n}.json")}
orig = {k: (p[:-5] + ".orig.json") for k, p in files.items()}
src = {k: J(orig[k] if os.path.exists(orig[k]) else p) for k, p in files.items()}
common = set.intersection(*[set(t["speaker"] for t in d["turns"]) for d in src.values()])
assert len(common) == 1, "owner detection failed"
OWNER = next(iter(common))


def ext_x(T):
    """Source time per line: block starts are known; lines inside a block get
    a time by character position up to the next block start (15 chars/s at the end)."""
    known, last = [], None
    for i, t in enumerate(T):
        if t["startMs"] is not None and t["startMs"] != last:
            known.append(i); last = t["startMs"]
    x = [None] * len(T)
    for a, b in zip(known, known[1:] + [None]):
        stop = b if b is not None else len(T)
        lens = [len(T[k]["text"] or "") for k in range(a, stop)]
        tot = sum(lens) or 1
        t0 = T[a]["startMs"]
        span = (T[b]["startMs"] - t0) if b is not None else tot * 1000 / 15
        cum = 0
        for k, c in zip(range(a, stop), lens):
            x[k] = t0 + span * cum / tot
            cum += c
    for k in range(known[0] if known else len(T)):
        x[k] = (T[known[0]]["startMs"] if known else 0)
    nxt = [x[i + 1] if i + 1 < len(T) else x[i] + 1000 * max(1, len(T[i]["text"] or "")) / 15 for i in range(len(T))]
    return x, nxt


def token_times(text, s, e):
    """(token, time) pairs, time by character position in [s, e]."""
    out, L = [], max(1, len(text or ""))
    for mt in re.finditer(r"\w+", (text or "").lower()):
        out.append((mt.group(0), s + (e - s) * mt.start() / L))
    return out


def grams(seq):
    d = {}
    for i in range(len(seq) - N + 1):
        g = tuple(w for w, _ in seq[i:i + N])
        d.setdefault(g, []).append(i)
    return d


def fit(pts, rng):
    best = None
    for _ in range(3000):
        (x1, y1), (x2, y2) = rng.sample(pts, 2)
        if abs(x2 - x1) < 60000:
            continue
        a = (y2 - y1) / (x2 - x1)
        if not 0.97 <= a <= 1.03:
            continue
        b = y1 - a * x1
        inl = [p for p in pts if abs(p[1] - (a * p[0] + b)) <= INLIER]
        if best is None or len(inl) > len(best):
            best = inl
    if not best:  # one-parameter fallback: slope 1, median offset
        b = statistics.median(y - x for x, y in pts)
        best = [p for p in pts if abs(p[1] - p[0] - b) <= INLIER]
    xs = [p[0] for p in best]; ys = [p[1] for p in best]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / vx if vx > 0 and len(best) >= 3 else 1.0
    a = min(1.03, max(0.97, a))
    return a, my - a * mx, best


def local_model(a, b, inl):
    """Global line + residual correction, linear between inlier anchors
    (residuals smoothed by a running median of 3)."""
    pts = sorted((x, y - (a * x + b)) for x, y in inl)
    xs = [p[0] for p in pts]
    rs = [p[1] for p in pts]
    sm = [statistics.median(rs[max(0, i - 1):i + 2]) for i in range(len(rs))]

    def f(x):
        if not xs:
            return a * x + b
        if x <= xs[0]:
            r = sm[0]
        elif x >= xs[-1]:
            r = sm[-1]
        else:
            lo, hi = 0, len(xs) - 1
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if xs[mid] <= x: lo = mid
                else: hi = mid
            w = (x - xs[lo]) / ((xs[hi] - xs[lo]) or 1)
            r = sm[lo] + w * (sm[hi] - sm[lo])
        return a * x + b + r
    return f


def anchor(m, name):
    """Anchor alignment of one external file (input: the .orig.json)."""
    path = files[(m, name)]
    d = src[(m, name)]
    T = d["turns"]
    x, nxt = ext_x(T)
    hy = {n: J(f"{CORP}/{m}/{n}.json") for n in ("h1", "h3")}
    pts = []  # (ext_ms, local_ms, line_index)
    for ch in ("mic", "system"):
        eseq, eline = [], []
        for i, t in enumerate(T):
            if ("mic" if t["speaker"] == OWNER else "system") != ch:
                continue
            tt = token_times(t["text"], x[i], nxt[i])
            eseq += tt; eline += [i] * len(tt)
        eg = grams(eseq)
        for hn, h in hy.items():
            hseq = []
            for s in h["channels"][ch]:
                hseq += token_times(s["text"], s["startMs"], s["endMs"])
            hg = grams(hseq)
            for g, ii in eg.items():
                if len(ii) == 1 and len(hg.get(g, [])) == 1:
                    pts.append((eseq[ii[0]][1], hseq[hg[g][0]][1], eline[ii[0]]))
    rng = random.Random(0)
    n_all = len(pts)
    if n_all < 5:
        a, b, inl, q, p80 = 1.0, 0.0, [], "bad", None
    else:
        a, b, inl3 = fit([(p[0], p[1]) for p in pts], rng)
        inl_set = set(inl3)
        inl = [p for p in pts if (p[0], p[1]) in inl_set]
        # leave-one-line-out error of the full model
        errs = []
        for line in sorted(set(p[2] for p in inl)):
            rest = [(p[0], p[1]) for p in inl if p[2] != line]
            if len(rest) < 3:
                continue
            f = local_model(a, b, rest)
            errs += [abs(f(p[0]) - p[1]) for p in inl if p[2] == line]
        errs.sort()
        p80 = errs[int(0.8 * (len(errs) - 1))] if errs else None
        nl = len(set(p[2] for p in inl))
        q = "bad" if nl < 5 or p80 is None else "good" if p80 <= GOOD else "coarse" if p80 <= COARSE else "bad"
    f = local_model(a, b, [(p[0], p[1]) for p in inl])
    nlines = len(set(p[2] for p in inl))
    basis = (f"anchors: n={nlines} lines ({len(inl)} of {n_all} 4-gram hits vs h1+h3, inliers +-{INLIER//1000}s), "
             f"offset={b/1000:+.1f}s, drift={100*(a-1):+.2f}%, local=piecewise through inlier anchors, "
             f"loo_p80={'-' if p80 is None else f'{p80/1000:.1f}s'}")
    return dict(T=T, x=x, f=f, a=a, b=b, p80=p80, q=q, nlines=nlines, n_inl=len(inl), n_all=n_all, basis=basis)


if __name__ == "__main__":
    report = {}
    for (m, name), path in sorted(files.items()):
        r = anchor(m, name); T, x, f, q, basis = r['T'], r['x'], r['f'], r['q'], r['basis']; d = src[(m, name)]
        report[(m, name)] = (r['nlines'], r['n_inl'], r['n_all'], round(r['b'] / 1000, 1), round(100 * (r['a'] - 1), 2), None if r['p80'] is None else round(r['p80'] / 1000, 1), q,
                             sum(t['startMs'] is None for t in T), len(T))
        if WRITE:
            if not os.path.exists(orig[(m, name)]):
                shutil.copy2(path, orig[(m, name)]); os.chmod(orig[(m, name)], 0o600)
            out = {k: v for k, v in d.items() if k != "turns"}
            out["time_basis"] = basis
            out["time_quality"] = q
            out["turns"] = [dict(t, startMs=int(round(f(x[i])))) for i, t in enumerate(T)]
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(out, fh, ensure_ascii=False, indent=1)
            os.chmod(tmp, 0o600); os.replace(tmp, path)

    print("| meeting | file | anchor lines | inlier hits | all hits | offset s | drift % | LOO p80 s | quality | null lines (orig) | lines |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for (m, n), r in sorted(report.items()):
        print(f"| {m} | {n} | " + " | ".join("-" if v is None else str(v) for v in r) + " |")
