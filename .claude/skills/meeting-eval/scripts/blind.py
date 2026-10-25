#!/usr/bin/env python3
"""Blind judge tool for pnpm meeting:eval packs (run the eval with --keep).

  blind.py make   --pack <out>/pack --meeting <id8> [--seed N]
  blind.py reveal --map <map file> [--scores <scores.json>]

make:   reads <slug>-<id8>.compare.md and <slug>-<id8>.summary.md of every
        model, relabels the models A-F in random order, removes the model
        names from the text, and writes <out>/judge/<id8>/{A..F}.compare.md,
        {A..F}.summary.md and JUDGE.md. The label-to-model mapping goes to
        <out>/blind-map-<id8>.json (mode 0600), outside the judge folder.
reveal: prints label -> model, with the scores of a scores.json
        ({"A": <any json>, ...}) when given. Run it after the judge writes.

The judge reads only <out>/judge/<id8>/. The judge never reads the map.
The pack holds real meeting text: it stays private (folders 0700, files 0600).
"""
import argparse
import json
import os
import random
import re
import sys
from pathlib import Path

LABELS = "ABCDEF"

JUDGE_MD = """# Blind judge input: meeting {id8}

You judge {n} anonymous outputs ({labels}) of the same meeting.
You see no model names. Do not try to guess them.

Files in this folder, per label X:
- X.compare.md: RAW text against the output, with 3 "around" words per change.
- X.summary.md: the summary of the output.

Steps:
1. Read each X.compare.md. Mark every changed line: fix (spelling, name, term,
   punctuation), harm (meaning change, lost word, wrong name), or neutral.
   Use the "around" words to tell a lost word from a removed repeat.
2. Read each X.summary.md. Check decisions and action items against the
   compare context. Look for invented owners or dates.
3. Write scores.json in this folder, one key per label:
   {{"A": {{"fixes": 0, "harms": 0, "neutral": 0, "summary_faults": 0, "rank": 1}}, ...}}
4. Report numbers only. Never quote meeting text in chat, a commit or a PR.
"""


def private(path: Path, mode: int) -> None:
    os.chmod(path, mode)


def scrub(text: str, names: list[str]) -> str:
    # Longest names first, so a short name inside a long name cannot leave a stub.
    for name in sorted(names, key=len, reverse=True):
        text = re.sub(re.escape(name), "MODEL", text, flags=re.IGNORECASE)
    return text


def make(args: argparse.Namespace) -> int:
    pack = Path(args.pack).resolve()
    out = pack.parent
    id8 = args.meeting
    slugs = sorted(
        p.name[: -len(f"-{id8}.compare.md")]
        for p in pack.glob(f"*-{id8}.compare.md")
        if not p.name.startswith("raw-")
    )
    if not slugs:
        print(f"no compare files for {id8} in {pack} (run the eval with --keep)", file=sys.stderr)
        return 1
    if len(slugs) > len(LABELS):
        print(f"{len(slugs)} models; the tool labels at most {len(LABELS)}", file=sys.stderr)
        return 1
    for s in slugs:
        if not (pack / f"{s}-{id8}.summary.md").is_file():
            print(f"missing {s}-{id8}.summary.md", file=sys.stderr)
            return 1
    order = slugs[:]
    random.Random(args.seed).shuffle(order)
    mapping = {LABELS[i]: s for i, s in enumerate(order)}
    names = slugs + [s.replace("-", " ") for s in slugs]
    jdir = out / "judge" / id8
    jdir.mkdir(parents=True, exist_ok=True)
    private(jdir.parent, 0o700)
    private(jdir, 0o700)
    for label, slug in mapping.items():
        for kind in ("compare", "summary"):
            text = (pack / f"{slug}-{id8}.{kind}.md").read_text()
            dest = jdir / f"{label}.{kind}.md"
            dest.write_text(scrub(text, names))
            private(dest, 0o600)
    jm = jdir / "JUDGE.md"
    jm.write_text(JUDGE_MD.format(id8=id8, n=len(mapping), labels=", ".join(mapping)))
    private(jm, 0o600)
    mp = out / f"blind-map-{id8}.json"
    mp.write_text(json.dumps({"meeting": id8, "seed": args.seed, "map": mapping}, indent=1))
    private(mp, 0o600)
    print(f"judge input: {jdir} ({len(mapping)} labels: {', '.join(mapping)})")
    print(f"mapping (do not show the judge): {mp}")
    return 0


def reveal(args: argparse.Namespace) -> int:
    data = json.loads(Path(args.map).read_text())
    scores = json.loads(Path(args.scores).read_text()) if args.scores else {}
    print(f"meeting {data['meeting']}")
    for label, slug in data["map"].items():
        print(f"{label}\t{slug}\t{json.dumps(scores.get(label), sort_keys=True) if label in scores else '-'}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("--pack", required=True)
    m.add_argument("--meeting", required=True)
    m.add_argument("--seed", type=int, default=None)
    m.set_defaults(fn=make)
    r = sub.add_parser("reveal")
    r.add_argument("--map", required=True)
    r.add_argument("--scores")
    r.set_defaults(fn=reveal)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
