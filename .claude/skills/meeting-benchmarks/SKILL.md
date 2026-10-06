---
name: meeting-benchmarks
description: Measure the meeting transcription pipeline on the owner's real recorded meetings, read-only and private, and compare runs (baseline vs a change). Use when a change touches meeting transcription, chunking, diarization, enhance or summary, or when asked to prove a meeting quality change.
---

# Meeting benchmarks on real meetings

Real meetings hold private conversations. The procedure reads them, copies them into a scratch profile, and reports **numbers only**. Read `.claude/skills/live-testing/SKILL.md` first. Its isolation rules apply here too.

The scripts are in `scripts/meeting-v2/`. They came from `specs/meeting-transcription-v2.md` (phases 0a and 0b).

## Privacy rules (hard)

1. The real folder `~/Library/Application Support/Openstyle/meetings` and the real DB are read only. Read the DB only with `sqlite3 -readonly ... ".backup ..."`.
2. Never print, log, commit or report transcript text or audio. Report counts, durations, hashes and ids only.
3. Copy only these rows into the scratch DB: vocabulary, the `languages` setting, the own server rows, and the default voice and LLM model rows. Never copy API keys. Do not use a cloud model. A cloud model would send the meeting text off the Mac.
4. Leave `OPENSTYLE_LOG_DIR` unset, so the request trace (which has text) stays off the disk.

## Proof meetings

Pick them by length only. Do not read their text.
- Short (fast loop): `2943c36a-532e-4db9-af09-b5e66f0bdf2d` (425 s)
- Long (final run): `9243bea0-567f-443b-bf3b-9980f69993fd` (3580 s)

## Commands

```bash
# 1. Scratch profile under /tmp/meeting-v2 (meeting copies + seeded scratch DB)
./scripts/meeting-v2/setup-scratch.sh <shortId> <longId>

# 2. One run. R0 = current pipeline, diarization off; R0d = diarization on.
SCRATCH=/tmp/meeting-v2 node scripts/meeting-v2/run-baseline.mjs --meeting <id> --run R0 --port 4787

# 3. Diarizer wall time (3 runs, median)
SCRATCH=/tmp/meeting-v2 node scripts/meeting-v2/measure-diarizer.mjs --meeting <id> --runs 3

# 4. Check that each metrics file is complete
jq -e 'has("wallSeconds") and has("chunks") and has("labeled") and has("termHits") and has("dupJoins") and has("contiguousCuts") and has("filtered") and has("empty") and has("failed") and has("langMismatch")' /tmp/meeting-v2/baseline/*/metrics.json
```

`run-baseline.mjs` starts its own server from `apps/electron` (so the diarizer resolves), resets the scratch DB, transcribes, and writes `metrics.json` in `/tmp/meeting-v2/baseline/<run>-<meetingId>/`. Each run of a phase gets its own run name (for example `R3b-<id>`).

## Metrics

| Metric | Meaning |
|---|---|
| `wallSeconds` | Time from the transcribe call to status `transcribed` |
| `chunks` | Chunk count per channel (mic, system) and total |
| `labeled` | Chunks with a speaker label, and the number of distinct speakers |
| `failed`, `empty`, `filtered` | Chunks that failed, came back empty, or were dropped by merge filters |
| `termHits` | How many vocabulary terms appear spelled right (count only) |
| `dupJoins` | Duplicate words at chunk joins |
| `contiguousCuts` | Cuts with no pause between chunks |
| `langMismatch` | Chunks whose detected language differs from the meeting language |
| `textHash` | Hash of the transcript text. Equal hashes mean identical text. |

## Baseline (2026-10-06, main at `f320740`, Qwen3-ASR on the owner's oMLX)

| Meeting | Run | wallSeconds | chunks | labeled | failed | under 3 s | termHits | contiguousCuts | Diarizer |
|---|---|---|---|---|---|---|---|---|---|
| short | R0 / R0d | 12.03 / 14.03 | 37 | 0 / 14 (1) | 0 | 5 | 3 | 0 | 0.92 s (0.22 %) |
| long | R0 / R0d | 96.19 / 100.20 | 247 | 0 / 59 (5) | 0 | 22 | 30 | 0 | 4.39 s (0.12 %) |

Compare every new phase with this table. Diarization on (R0d) changes only the labels. The text hash is equal to R0.

## Report shape

Give a table like the one above for the new run next to the baseline. State the deltas. List anything the owner must read himself (for example the side-by-side text). The owner reads the text on his own Mac; the agent never shows it.

## For pi children

A pi brief must say: "Read `.claude/skills/meeting-benchmarks/SKILL.md` and `.claude/skills/live-testing/SKILL.md` first." The scripts exist on `main` only after the meeting v2 branch merges. Until then, they are on `feat/meeting-transcription-v2`.
