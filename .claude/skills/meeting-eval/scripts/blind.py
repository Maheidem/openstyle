#!/usr/bin/env python3
"""Blind judge tool for pnpm meeting:eval runs (run the eval with --keep).

  blind.py make   (--pack <out>/pack | --arm NAME=<out>[:<model>] ...) --meeting <id8>
                  [--seed N] [--swap-of <map>] [--plant] [--tag T]
  blind.py score  --map <map file>
  blind.py consistency --a <score file> --b <score file>
  blind.py reveal --map <map file>

make:   reads the RAW transcript (<out>/pack/raw-<id8>.json), the enhanced
        transcript (<out>/runs/<model>/<id8>/dump.json) and the summary JSON
        (<out>/runs/<model>/<id8>/test.db) of each arm. It gives each arm a
        label (A-F) in random order and writes the judge folder
        <root>/judge[-<tag>]/<id8>/ with:
          transcript.md      the RAW transcript, one line id per segment
          corrections.md     every line that an arm changed, in full, with
                             2 full lines before and after
          <section>.md       the summary items of every label, one file per
                             section (decisions, actionItems, openQuestions,
                             keyPoints)
          TASK-<task>.md     one focused judge task per file (one judge call)
        The label-to-arm mapping goes to <root>/blind-map[-<tag>]-<id8>.json
        (mode 0600), outside the judge folder.
        --pack: the arms are the models of one out folder (root = <out>).
        --arm:  the arms are out folders of different builds (same model);
                root = the parent folder of the first arm's out folder.
        --swap-of <map>: reuse the arms of an earlier map in the reverse
                label order (the order-swap test).
        --plant: plant known errors in one arm (the planted-error test).
                The map records each planted error and the verdict a good
                judge must give.
score:  unblinds the task outputs (<task>.json in the judge folder), prints
        per arm the correction verdicts and the summary precision and recall
        per section, the plant catch rate, and the verdict. It writes
        <map>.score.json (numbers and item keys only).
consistency: compares the per-item verdicts of two score files of the same
        arms (for example a run and its order swap).
reveal: prints label -> arm.

The judge reads only the judge folder. The judge never reads the map.
The files hold real meeting text: folders 0700, files 0600. Delete the judge
folder, the map and the score file after the judging.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import random
import re
import sqlite3
import sys
from pathlib import Path

LABELS = "ABCDEF"
CONTEXT_LINES = 2
SECTIONS = {
    # section: (item id letter, verdicts that count as a correct item)
    "decisions": ("D", {"decided"}),
    "actionItems": ("T", {"correct"}),
    "openQuestions": ("Q", {"open"}),
    "keyPoints": ("K", {"supported"}),
}
RECALL_SECTIONS = ("decisions", "actionItems", "openQuestions")
TIE_MARGIN = 0.10

# --- Judge tasks (one focused call each) ---------------------------------------------

COMMON = """You are one blind judge. You see {n} anonymous outputs ({labels}) of the
same meeting. You see no model or branch names. Do not try to guess them.
Read only the files that this task names. Do not read other files.
The transcript lines have ids (L001, L002, ...). "Me" is the user who recorded
the meeting. "Them N" is one other speaker (the diarizer label). "Them" with no
number is a speaker with no label.
Write only the JSON file that the task names, in this folder. Use line ids and
item ids in it, never quoted meeting text. Report numbers only in your reply.
"""

TASK_CORRECTIONS = """# Task: transcript corrections, meeting {id8}

{common}
Files: `transcript.md` (the RAW speech-to-text) and `corrections.md` (every line
that one or more labels changed, with the full RAW line, the full line of each
label and 2 full lines before and after).

For each line in corrections.md, give each label one mark for its version of
the line against RAW. Use the context lines and the transcript to decide.
- "fix": it corrects an error of the speech-to-text (spelling, name, term,
  grammar slip, punctuation) and keeps the meaning.
- "harm": it changes the meaning, drops or adds content, or puts a wrong
  word, name or number. A word that the speaker said and that is lost is
  a harm.
- "neutral": no real effect (same text, a style choice, case only).
The removal of an exact repeated word ("the the" to "the") is the expected
product behavior: mark it "neutral", not "fix". Judge the other changes.
Mark each label on its own. Do not pick a winner: the tool compares the marks.

Write `corrections.json`:
{{"lines": {{"L012": {{"marks": {{"A": "fix", "B": "neutral"}}}}, ...}}}}
Give every line id of corrections.md and every label.
"""

SECTION_RUBRIC = {
    "decisions": """Each item claims a decision of this meeting. Give one verdict per item:
- "decided": the people in the meeting made or confirmed this decision (it
  was agreed, not only proposed). A decision confirmed in this meeting that
  was first made earlier also counts.
- "not_decided": it is in the meeting, but nobody agreed to it: only a
  proposal, an opinion, or a fact. A task that one person takes ("I will
  check this with you") is a to-do, not a decision.
- "unsupported": the transcript does not say it, or a fact in it is wrong.
Reference list: the decisions that a complete summary must list.""",
    "actionItems": """Each item claims a follow-up task, with an owner and a due date. Give one
verdict per item:
- "correct": a real follow-up task of this meeting, with the right owner
  (the person who takes the task) and no wrong due date. A speaker label
  ("Me", "Them 2") is a correct owner when that speaker takes the task.
  An empty owner or due is not an error.
- "wrong_owner": a real task, but the owner is not the person who takes it.
- "wrong_due": a real task, but the due date is invented or wrong.
- "not_action": in the meeting, but not a follow-up task of the meeting (it
  was done during the call, or nobody takes it).
- "unsupported": the transcript does not say it.
Reference list: the follow-up tasks that a complete summary must list.""",
    "openQuestions": """Each item claims a question that is still open at the end of the meeting.
Give one verdict per item:
- "open": the meeting raised it and did not answer it.
- "answered": the meeting answered it (the answer can be short or informal).
- "not_question": a statement, not a question. A question that the meeting
  raised and that only a later call can answer is still "open".
- "unsupported": the transcript does not say it.
Reference list: the questions that are still open at the end and that a
complete summary must list.""",
    "keyPoints": """Each item claims a key point of the meeting. Give one verdict per item:
- "supported": the transcript says it and it is right.
- "unsupported": the transcript does not say it, or a fact in it is wrong
  (a wrong name, number, owner or claim).
No reference list for this section.""",
}

TASK_SECTION = """# Task: summary section "{section}", meeting {id8}

{common}
Files: `transcript.md` (the RAW speech-to-text that every summary read) and
`{section}.md` (the "{section}" items of each label, with item ids).

Read the whole transcript first. Then judge each item on its own, against
the transcript. Do not compare the labels with each other. Do not count
items. The number of items is not a quality.

{rubric}
{recall}
Write `{section}.json`:
{example}
Give every item id of {section}.md.
"""

RECALL_STEP = """
Then make the reference list from the transcript alone: each entry gets an
id (R1, R2, ...), the line ids that show it, and a short label of at most 8
words. For each label, give the item id that covers the entry, or null when
no item of that label covers it. An item covers an entry when it says the
same thing, also when its own verdict is not the best. For action items, the
task must be the same task (to share a file and to read that file are two
tasks).
"""

EXAMPLE_RECALL = """{{"items": {{"A-D1": {{"verdict": "decided", "lines": ["L045"]}}, ...}},
 "reference": [{{"id": "R1", "lines": ["L045"], "label": "...", "covered": {{"A": "A-D1", "B": null}}}}, ...]}}"""
EXAMPLE_PLAIN = """{{"items": {{"A-K1": {{"verdict": "supported", "lines": ["L045"]}}, ...}}}}"""

JUDGE_MD = """# Blind judge input: meeting {id8}

This folder holds {ntask} judge tasks. Each task is one focused judge call:
start one fresh judge per task file and tell it: "Read TASK-<name>.md in this
folder and follow it." One judge never does two tasks.

Tasks: {tasks}
"""

# --- Input ---------------------------------------------------------------------------


def private_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)
    os.chmod(p, 0o700)


def write_private(p: Path, text: str) -> None:
    p.write_text(text)
    os.chmod(p, 0o600)


def row_key(s: dict) -> str:
    return f"{s['source']}:{s['idx']}:{s.get('start_ms') if s.get('start_ms') is not None else ''}"


def speaker(s: dict) -> str:
    if s["source"] == "mic":
        return "Me"
    return f"Them {s['speaker_label']}" if s.get("speaker_label") else "Them"


def clock(ms) -> str:
    t = int((ms or 0) / 1000)
    return f"{t // 60:02d}:{t % 60:02d}"


def load_summary(db: Path, id8: str) -> dict:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT summary_json FROM meeting_summaries WHERE meeting_id LIKE ?",
            (f"{id8}%",),
        ).fetchone()
    finally:
        con.close()
    try:
        v = json.loads(row[0]) if row and row[0] else {}
    except json.JSONDecodeError:
        v = {}
    return v if isinstance(v, dict) else {}


def item_text(x) -> str:
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        for k in ("text", "task", "decision", "question", "point"):
            if isinstance(x.get(k), str):
                return x[k]
    return json.dumps(x, ensure_ascii=False)


def summary_items(summary: dict) -> dict:
    """The summary sections as lists of {text, owner, due}."""
    out = {}
    for sec in SECTIONS:
        items = summary.get(sec)
        items = items if isinstance(items, list) else []
        out[sec] = [
            {
                "text": item_text(x),
                "owner": x.get("owner") if isinstance(x, dict) else None,
                "due": x.get("due") if isinstance(x, dict) else None,
            }
            for x in items
        ]
    return out


def load_arm(name: str, out: Path, model: str | None, id8: str) -> dict:
    runs = out / "runs"
    if model is None:
        models = sorted(p.name for p in runs.iterdir() if (p / id8).is_dir())
        if len(models) != 1:
            raise SystemExit(f"arm {name}: {len(models)} models in {runs}; give NAME=<out>:<model>")
        model = models[0]
    rd = runs / model / id8
    dump = json.loads((rd / "dump.json").read_text())
    raw = json.loads((out / "pack" / f"raw-{id8}.json").read_text())
    return {
        "name": name,
        "out": str(out),
        "model": model,
        "raw": raw["segments"],
        "text": {row_key(s): (s.get("enhanced_text") or s.get("text") or "") for s in dump["segments"]},
        "summary": summary_items(load_summary(rd / "test.db", id8)),
    }


def arms_from_args(args) -> tuple[Path, list[dict]]:
    id8 = args.meeting
    if args.pack:
        out = Path(args.pack).resolve().parent
        models = sorted(p.name for p in (out / "runs").iterdir() if (p / id8).is_dir())
        return out, [load_arm(m, out, m, id8) for m in models]
    arms = []
    for spec in args.arm:
        name, _, rest = spec.partition("=")
        path, _, model = rest.partition(":")
        arms.append(load_arm(name, Path(path).resolve(), model or None, id8))
    return Path(arms[0]["out"]).parent, arms


# --- Planted errors ------------------------------------------------------------------

FAKE_DECISIONS = [
    ("The team agreed to move the launch to the second quarter.", ["launch", "quarter"]),
    ("Everyone agreed to drop the mobile app from the scope.", ["mobile"]),
    ("The group decided to hire an outside vendor for the migration.", ["vendor", "migration"]),
]
FAKE_OWNERS = ["Priya", "Viktor", "Ingrid"]
NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def plant(arm: dict, lines: list[dict], rng: random.Random) -> list[dict]:
    """Plant known errors in one arm (in place). Returns the plant records."""
    corpus = " ".join(s["raw"] for s in lines).lower()
    plants = []
    s = arm["summary"]
    # 1. An invented decision at a random place.
    for text, words in FAKE_DECISIONS:
        if not any(w in corpus for w in words):
            pos = rng.randint(0, len(s["decisions"]))
            s["decisions"].insert(pos, {"text": text, "owner": None, "due": None})
            plants.append({"kind": "invented_decision", "section": "decisions", "index": pos, "bad": ["decided"]})
            break
    # 2. An invented owner (a name nobody in the meeting has).
    owned = [i for i, a in enumerate(s["actionItems"]) if a["owner"]]
    fake = next((n for n in FAKE_OWNERS if n.lower() not in corpus), None)
    if owned and fake:
        i = rng.choice(owned)
        s["actionItems"][i]["owner"] = fake
        plants.append({"kind": "wrong_owner", "section": "actionItems", "index": i, "bad": ["correct"]})
    # 3. An invented due date.
    used = {p["index"] for p in plants if p["section"] == "actionItems"}
    undated = [i for i, a in enumerate(s["actionItems"]) if not a["due"] and i not in used]
    if undated and "friday" not in corpus:
        i = rng.choice(undated)
        s["actionItems"][i]["due"] = "by Friday"
        plants.append({"kind": "invented_due", "section": "actionItems", "index": i, "bad": ["correct"]})
    # 4-6. Transcript harms on lines that no arm changed.
    free = [ln for ln in lines if not ln["changed"]]
    rng.shuffle(free)

    def first(pred, edit, kind):
        for ln in free:
            if ln.get("planted"):
                continue
            t = arm["text"].get(ln["key"], ln["raw"])
            if pred(t):
                arm["text"][ln["key"]] = edit(t)
                ln["planted"] = True
                plants.append({"kind": kind, "line": ln["key"], "bad": ["fix", "neutral"]})
                return

    neg = re.compile(r"\b(not|never)\s+|n't\b", re.IGNORECASE)
    first(lambda t: bool(neg.search(t)), lambda t: neg.sub("", t, count=1), "negation_lost")
    num = re.compile(r"\b(\d+)\b")
    numw = re.compile(r"\b(" + "|".join(NUMBER_WORDS) + r")\b", re.IGNORECASE)

    def bump(t):
        if num.search(t):
            return num.sub(lambda m: str(int(m.group(1)) + 3), t, count=1)
        return numw.sub(lambda m: NUMBER_WORDS[(NUMBER_WORDS.index(m.group(1).lower()) + 3) % len(NUMBER_WORDS)], t, count=1)

    first(lambda t: bool(num.search(t) or numw.search(t)), bump, "number_changed")
    names = sorted({w for ln in lines for w in re.findall(r"(?<=\w )([A-Z][a-z]{3,})\b", ln["raw"])})
    if len(names) >= 2:
        def swap(t):
            hit = next(w for w in names if re.search(rf"(?<=\w ){w}\b", t))
            other = next(w for w in names if w != hit)
            return re.sub(rf"(?<=\w ){hit}\b", other, t, count=1)

        first(lambda t: any(re.search(rf"(?<=\w ){w}\b", t) for w in names), swap, "name_swapped")
    return plants


# --- Render --------------------------------------------------------------------------


def word_diff(a: str, b: str) -> str:
    wa, wb = a.split(), b.split()
    parts = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=wa, b=wb, autojunk=False).get_opcodes():
        if op != "equal":
            parts.append(f'"{" ".join(wa[i1:i2]) or "(nothing)"}" -> "{" ".join(wb[j1:j2]) or "(nothing)"}"')
    return "; ".join(parts) or "(same words; spacing only)"


def build_lines(arms: list[dict]) -> list[dict]:
    raw = sorted(arms[0]["raw"], key=lambda s: (s.get("start_ms") or 0, s["source"], s["idx"]))
    for a in arms[1:]:
        other = sorted(a["raw"], key=lambda s: (s.get("start_ms") or 0, s["source"], s["idx"]))
        if [(row_key(s), s.get("text")) for s in other] != [(row_key(s), s.get("text")) for s in raw]:
            raise SystemExit(f"arm {a['name']}: the RAW transcript differs from arm {arms[0]['name']}; the arms are not comparable")
    lines = []
    for i, s in enumerate(raw):
        key = row_key(s)
        lines.append({
            "id": f"L{i + 1:03d}",
            "key": key,
            "time": clock(s.get("start_ms")),
            "who": speaker(s),
            "raw": s.get("text") or "",
            "changed": any(a["text"].get(key, s.get("text") or "") != (s.get("text") or "") for a in arms),
        })
    return lines


def render_transcript(lines) -> str:
    out = ["# RAW transcript (speech-to-text, before any correction)", ""]
    out += [f"{ln['id']} [{ln['time']}] {ln['who']}: {ln['raw'] or '(no text)'}" for ln in lines]
    return "\n".join(out) + "\n"


def render_corrections(lines, labelled) -> tuple[str, list[str]]:
    out = [
        "# Changed lines",
        "",
        "Every line that one or more labels changed. Context lines show RAW text.",
        "",
    ]
    ids = []
    for i, ln in enumerate(lines):
        texts = {lab: a["text"].get(ln["key"], ln["raw"]) for lab, a in labelled}
        if all(t == ln["raw"] for t in texts.values()):
            continue
        ids.append(ln["id"])
        out.append(f"## {ln['id']} [{ln['time']}] {ln['who']}")
        out.append("Before:")
        for c in lines[max(0, i - CONTEXT_LINES):i]:
            out.append(f"> {c['id']} {c['who']}: {c['raw'] or '(no text)'}")
        out.append(f"- RAW: {ln['raw']}")
        for lab, t in texts.items():
            if t == ln["raw"]:
                out.append(f"- {lab}: (same as RAW)")
            else:
                out.append(f"- {lab}: {t}")
                out.append(f"  - {lab} changes: {word_diff(ln['raw'], t)}")
        out.append("After:")
        for c in lines[i + 1:i + 1 + CONTEXT_LINES]:
            out.append(f"> {c['id']} {c['who']}: {c['raw'] or '(no text)'}")
        out.append("")
    return "\n".join(out) + "\n", ids


def render_section(sec, labelled) -> tuple[str, dict]:
    letter = SECTIONS[sec][0]
    out = [f"# Summary section: {sec}", ""]
    index = {}
    for lab, a in labelled:
        items = a["summary"][sec]
        out.append(f"## Label {lab} ({len(items)} items)")
        if not items:
            out.append("(no items)")
        for k, it in enumerate(items):
            iid = f"{lab}-{letter}{k + 1}"
            index[iid] = k
            extra = ""
            if sec == "actionItems":
                extra = f" (owner: {it['owner'] or 'none'}; due: {it['due'] or 'none'})"
            out.append(f"- {iid}: {it['text']}{extra}")
        out.append("")
    return "\n".join(out) + "\n", index


def make(args) -> int:
    id8 = args.meeting
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(1 << 30)
    rng = random.Random(seed)
    root, arms = arms_from_args(args)
    if not 1 <= len(arms) <= len(LABELS):
        print(f"{len(arms)} arms; the tool labels 1 to {len(LABELS)}", file=sys.stderr)
        return 1
    if args.swap_of:
        prev = json.loads(Path(args.swap_of).read_text())
        order = [prev["map"][lab]["name"] for lab in reversed(sorted(prev["map"]))]
        by = {a["name"]: a for a in arms}
        arms = [by[n] for n in order]
    else:
        rng.shuffle(arms)
    lines = build_lines(arms)
    plants = []
    if args.plant:
        target = rng.choice(arms)
        plants = plant(target, lines, rng)
        for p in plants:
            p["arm"] = target["name"]
        keys = {p["line"] for p in plants if "line" in p}
        for ln in lines:
            ln["changed"] = ln["changed"] or ln["key"] in keys
    labelled = list(zip(LABELS, arms))
    tag = f"-{args.tag}" if args.tag else ""
    jdir = root / f"judge{tag}" / id8
    private_dir(jdir.parent)
    private_dir(jdir)
    common = COMMON.format(n=len(arms), labels=", ".join(lab for lab, _ in labelled))
    write_private(jdir / "transcript.md", render_transcript(lines))
    corr, corr_ids = render_corrections(lines, labelled)
    write_private(jdir / "corrections.md", corr)
    write_private(jdir / "TASK-corrections.md", TASK_CORRECTIONS.format(id8=id8, common=common))
    tasks = ["corrections"]
    item_index = {}
    for sec in SECTIONS:
        text, index = render_section(sec, labelled)
        item_index[sec] = index
        write_private(jdir / f"{sec}.md", text)
        recall = sec in RECALL_SECTIONS
        write_private(jdir / f"TASK-{sec}.md", TASK_SECTION.format(
            section=sec, id8=id8, common=common, rubric=SECTION_RUBRIC[sec],
            recall=RECALL_STEP if recall else "",
            example=(EXAMPLE_RECALL if recall else EXAMPLE_PLAIN).format()))
        tasks.append(sec)
    write_private(jdir / "JUDGE.md", JUDGE_MD.format(id8=id8, ntask=len(tasks), tasks=", ".join(f"TASK-{t}.md" for t in tasks)))
    line_keys = {ln["id"]: ln["key"] for ln in lines}
    mp = root / f"blind-map{tag}-{id8}.json"
    write_private(mp, json.dumps({
        "meeting": id8,
        "seed": seed,
        "judge": str(jdir),
        "swapOf": args.swap_of,
        "map": {lab: {"name": a["name"], "out": a["out"], "model": a["model"]} for lab, a in labelled},
        "lineKeys": {i: line_keys[i] for i in corr_ids},
        "plants": plants,
    }, indent=1))
    print(f"judge input: {jdir} ({len(arms)} labels; {len(corr_ids)} changed lines; tasks: {', '.join(tasks)})")
    for sec in SECTIONS:
        counts = [f"{lab} {sum(1 for i in item_index[sec] if i.startswith(lab + '-'))}" for lab, _ in labelled]
        print(f"  {sec}: {', '.join(counts)} items")
    if plants:
        print(f"planted errors: {len(plants)} ({', '.join(p['kind'] for p in plants)})")
    print(f"mapping (do not show the judge): {mp}")
    return 0


# --- Score ---------------------------------------------------------------------------


def rate(a: int, b: int):
    return round(a / b, 3) if b else None


def f1(p, r):
    if p is None or r is None or p + r == 0:
        return None
    return round(2 * p * r / (p + r), 3)


MARK_RANK = {"harm": 0, "neutral": 1, "fix": 2}


def line_best(marks: dict) -> str:
    """The label with the best mark of one line, or "tie"."""
    ranks = {lab: MARK_RANK.get(m, 1) for lab, m in marks.items()}
    if not ranks:
        return "tie"
    top = max(ranks.values())
    winners = [lab for lab, r in ranks.items() if r == top]
    return winners[0] if len(winners) == 1 else "tie"


def score(args) -> int:
    mp = json.loads(Path(args.map).read_text())
    jdir = Path(mp["judge"])
    labels = mp["map"]
    name = {lab: v["name"] for lab, v in labels.items()}
    res = {"meeting": mp["meeting"], "arms": {}, "items": {}, "lines": {}, "plants": []}
    for lab in labels:
        res["arms"][name[lab]] = {"label": lab}
    # Corrections.
    cpath = jdir / "corrections.json"
    if cpath.is_file():
        c = json.loads(cpath.read_text()).get("lines", {})
        missing = [i for i in mp["lineKeys"] if i not in c]
        # The line winner comes from the marks (fix > neutral > harm), never
        # from a judge's free pick: the order-swap test showed that a free
        # "best" pick flips with the label order (2026-10-26).
        best = {i: line_best(c[i].get("marks", {})) for i in mp["lineKeys"] if i in c}
        for lab in labels:
            marks = [c[i]["marks"].get(lab) for i in mp["lineKeys"] if i in c]
            res["arms"][name[lab]]["corrections"] = {
                "fix": marks.count("fix"),
                "harm": marks.count("harm"),
                "neutral": marks.count("neutral"),
                "best": sum(1 for b in best.values() if b == lab),
            }
        res["corrections_ties"] = sum(1 for b in best.values() if b == "tie")
        res["corrections_missing"] = len(missing)
        for i, b in best.items():
            res["lines"][mp["lineKeys"][i]] = {
                "marks": {name[lab]: m for lab, m in c[i].get("marks", {}).items() if lab in name},
                "best": name.get(b, "tie"),
            }
    # Summary sections.
    for sec, (letter, good) in SECTIONS.items():
        path = jdir / f"{sec}.json"
        if not path.is_file():
            continue
        data = json.loads(path.read_text())
        items = data.get("items", {})
        ref = data.get("reference", [])
        for lab in labels:
            mine = {k: v for k, v in items.items() if k.startswith(f"{lab}-")}
            verdicts = [v.get("verdict") for v in mine.values()]
            n_good = sum(1 for v in verdicts if v in good)
            entry = {"items": len(mine), "good": n_good, "precision": rate(n_good, len(mine)),
                     "verdicts": {v: verdicts.count(v) for v in sorted(set(verdicts), key=str)}}
            if sec in RECALL_SECTIONS:
                cov = sum(1 for r in ref if (r.get("covered") or {}).get(lab))
                entry.update({"reference": len(ref), "covered": cov, "recall": rate(cov, len(ref))})
            res["arms"][name[lab]][sec] = entry
            for k, v in mine.items():
                m = re.fullmatch(rf"{lab}-{letter}(\d+)", k)
                if m:
                    res["items"][f"{name[lab]}|{sec}|{int(m.group(1)) - 1}"] = v.get("verdict")
        res.setdefault("reference", {})[sec] = [
            {"lines": r.get("lines", []), "covered": {name[lab]: (r.get("covered") or {}).get(lab) for lab in labels}}
            for r in ref
        ]
    # Pooled precision and recall over the recall sections.
    for arm, v in res["arms"].items():
        secs = [v[s] for s in RECALL_SECTIONS if s in v]
        if not secs:
            continue
        p = rate(sum(s["good"] for s in secs), sum(s["items"] for s in secs))
        r = rate(sum(s["covered"] for s in secs), sum(s["reference"] for s in secs))
        v["summary"] = {"precision": p, "recall": r, "f1": f1(p, r)}
    # Plants.
    for p in mp.get("plants", []):
        task = "corrections" if "line" in p else p["section"]
        if not (jdir / f"{task}.json").is_file():
            continue  # this task was not judged
        if "line" in p:
            got = (res["lines"].get(p["line"]) or {}).get("marks", {}).get(p["arm"])
        else:
            got = res["items"].get(f"{p['arm']}|{p['section']}|{p['index']}")
        res["plants"].append({"kind": p["kind"], "got": got, "caught": got is not None and got not in p["bad"]})
    res["verdict"] = verdict(res)
    out = Path(f"{args.map}.score.json")
    write_private(out, json.dumps(res, indent=1))
    print_score(res)
    print(f"score file: {out}")
    return 0


def verdict(res) -> dict:
    v = {}
    arms = res["arms"]
    f = {a: (x.get("summary") or {}).get("f1") for a, x in arms.items()}
    if len(f) == 2 and None not in f.values():
        (a, fa), (b, fb) = sorted(f.items(), key=lambda kv: -kv[1])
        v["summary"] = "near tie" if fa - fb < TIE_MARGIN else f"{a} better (F1 {fa} vs {fb})"
    best = {a: (x.get("corrections") or {}).get("best") for a, x in arms.items()}
    if len(best) == 2 and None not in best.values():
        (a, wa), (b, wb) = sorted(best.items(), key=lambda kv: -kv[1])
        v["corrections"] = "tie" if wa == wb else f"{a} ahead by {wa - wb} line(s) ({wa} vs {wb}, ties {res.get('corrections_ties')})"
    return v


def print_score(res) -> None:
    print(f"meeting {res['meeting']}")
    for arm, v in res["arms"].items():
        print(f"arm {arm} (label {v['label']})")
        if "corrections" in v:
            c = v["corrections"]
            print(f"  corrections: fix {c['fix']}, harm {c['harm']}, neutral {c['neutral']}, wins {c['best']} lines (by marks)")
        for sec in SECTIONS:
            if sec in v:
                s = v[sec]
                rec = f", recall {s['recall']} ({s['covered']}/{s['reference']})" if "recall" in s else ""
                print(f"  {sec}: precision {s['precision']} ({s['good']}/{s['items']}){rec}; verdicts {s['verdicts']}")
        if "summary" in v:
            print(f"  summary pooled: precision {v['summary']['precision']}, recall {v['summary']['recall']}, F1 {v['summary']['f1']}")
    if res["plants"]:
        caught = sum(1 for p in res["plants"] if p["caught"])
        got = ", ".join(f"{p['kind']}={p['got']}" for p in res["plants"])
        print(f"plants caught: {caught}/{len(res['plants'])} ({got})")
    print(f"verdict: {json.dumps(res['verdict'])}")


def consistency(args) -> int:
    a = json.loads(Path(args.a).read_text())
    b = json.loads(Path(args.b).read_text())
    keys = sorted(set(a["items"]) & set(b["items"]))
    same = sum(1 for k in keys if a["items"][k] == b["items"][k])
    print(f"summary items: {same}/{len(keys)} same verdict ({rate(same, len(keys))})")
    lk = sorted(set(a["lines"]) & set(b["lines"]))
    marks = [(k, arm) for k in lk for arm in a["lines"][k]["marks"]]
    same_m = sum(1 for k, arm in marks if a["lines"][k]["marks"].get(arm) == b["lines"][k]["marks"].get(arm))
    same_b = sum(1 for k in lk if a["lines"][k]["best"] == b["lines"][k]["best"])
    print(f"correction marks: {same_m}/{len(marks)} same ({rate(same_m, len(marks))}); best: {same_b}/{len(lk)} same ({rate(same_b, len(lk))})")
    print(f"verdicts: {json.dumps(a['verdict'])} | {json.dumps(b['verdict'])}")
    return 0


def reveal(args) -> int:
    data = json.loads(Path(args.map).read_text())
    print(f"meeting {data['meeting']}")
    for label, v in data["map"].items():
        print(f"{label}\t{v['name']}\t{v['model']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    src = m.add_mutually_exclusive_group(required=True)
    src.add_argument("--pack")
    src.add_argument("--arm", action="append")
    m.add_argument("--meeting", required=True)
    m.add_argument("--seed", type=int, default=None)
    m.add_argument("--swap-of")
    m.add_argument("--plant", action="store_true")
    m.add_argument("--tag", default="")
    m.set_defaults(fn=make)
    s = sub.add_parser("score")
    s.add_argument("--map", required=True)
    s.set_defaults(fn=score)
    c = sub.add_parser("consistency")
    c.add_argument("--a", required=True)
    c.add_argument("--b", required=True)
    c.set_defaults(fn=consistency)
    r = sub.add_parser("reveal")
    r.add_argument("--map", required=True)
    r.set_defaults(fn=reveal)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
