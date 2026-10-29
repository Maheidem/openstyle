"""Span match rule of score_silver.py: the same rule as scoreSpans/spanHits in ../../score.mts.

Input words are the normal form of wer.mts (scoreWords + normalizeWords, joined with spaces).
fold() then folds accents like the vote (normalize_silver3.py). A span is a hit when its words,
without spaces, equal a run of whole window words (the vote's contains rule). One output occurrence
counts for one span only: spans take occurrences in the order of their window end, each the first
free occurrence of its window (this order gives the most hits).

Parity check (score.test.mts calls it): python3 -I span_match.py < cases.json
  in:  {"cases": [{"tol": ms, "spans": [{"channel", "startMs", "endMs", "norm"}],
                   "segs": [{"channel", "start", "end", "norm"}]}]}
  out: {"hits": [[bool, ...], ...]}   (one list per case, spans in input order)
"""
import json, sys, unicodedata


def fold(t):
    """NFKD, then the combining marks go ("josé" is "jose")."""
    return "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))


def span_words(norm):
    return fold(norm).split()


def joined_match(win, i, target):
    """The number of window words from i whose text without spaces equals target, or 0."""
    acc, j = "", i
    while j < len(win) and len(acc) < len(target):
        acc += win[j]
        j += 1
    return j - i if acc == target else 0


def span_hits(spans, segs, tol):
    """spans: [(channel, startMs, endMs, words)]; segs: [(channel, start, end, words)].
    Segments are sorted by (start, input index), as scoreSpans sorts them. Returns one bool per span."""
    segs = [s for _, s in sorted(enumerate(segs), key=lambda x: (x[1][1], x[0]))]
    segs = [(ch, s, max(s, e), w) for ch, s, e, w in segs]
    offset, n = [], 0
    for s in segs:
        offset.append(n)
        n += len(s[3])
    used, hits = set(), [False] * len(spans)
    for k in sorted(range(len(spans)), key=lambda i: (spans[i][2], spans[i][1], i)):
        ch, st, en, words = spans[k]
        target = "".join(words)
        if not target:
            continue
        win = []  # (word, position in all segs): an occurrence's key is the positions of its words
        for si, (sch, s, e, ws) in enumerate(segs):
            if sch == ch and e >= st - tol and s <= en + tol:
                win.extend((w, offset[si] + wi) for wi, w in enumerate(ws))
        wl = [x[0] for x in win]
        for i in range(len(win)):
            m = joined_match(wl, i, target)
            if not m:
                continue
            key = tuple(x[1] for x in win[i:i + m])
            if key in used:
                continue
            used.add(key)
            hits[k] = True
            break
    return hits


if __name__ == "__main__":
    cases = json.load(sys.stdin)["cases"]
    out = []
    for c in cases:
        spans = [(s["channel"], s["startMs"], s["endMs"], span_words(s["norm"])) for s in c["spans"]]
        segs = [(s["channel"], s["start"], s["end"], span_words(s["norm"])) for s in c["segs"]]
        out.append(span_hits(spans, segs, c["tol"]))
    print(json.dumps({"hits": out}))
