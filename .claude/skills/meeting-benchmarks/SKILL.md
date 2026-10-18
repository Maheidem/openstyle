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
4. `DELETE /api/meetings/<id>` removes the meeting's `audio_dir` folder. Before any DELETE test, run `sqlite3 "$DB" "select audio_dir from meetings"` and check that every path starts with `/tmp/`. If one does not, stop.
5. A screenshot of a meeting page shows the transcript. Never take a screenshot of a real meeting. For UI proof screenshots, use a fictional meeting (seed it as `scripts/site-captures/seed-data.mjs` does) or crop to the control you prove. On 2026-10-06 a pi child saved 3 screenshots with real meeting text; the coordinator deleted them.
6. Leave `OPENSTYLE_LOG_DIR` unset, so the request trace (which has text) stays off the disk.

## Proof meetings

Pick them by length only. Do not read their text.
- Short (fast loop): `2943c36a-532e-4db9-af09-b5e66f0bdf2d` (425 s)
- Long (final run): `9243bea0-567f-443b-bf3b-9980f69993fd` (3580 s)
- Issue #163 meeting (8 chunks; the old Enhance path fails 2 of 8): `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6`

2026-10-17 (issue #185 only): the owner allows the pi and Codex judges to read the compare files of these three meetings, with no per-data-set question. WP11 removes this line.

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

## Enhance and summary runs (issue #185)

The arm is the server build, not a flag. `--arm old|new` only labels the files. Build the server in the worktree of the arm (`pnpm turbo build --filter=@openstyle/server`) and give that worktree to `--server-repo`.

```bash
# 1. Transcribe once (steps above), stop the server, then take a copy:
sqlite3 -readonly /tmp/meeting-v2/test.db ".backup '/tmp/meeting-v2/transcribed.db'"

# 2. One Enhance run (3 per arm and meeting, 6 on the #163 meeting).
#    Every run starts from a fresh copy of transcribed.db.
SCRATCH=/tmp/meeting-v2 node scripts/meeting-v2/run-enhance.mjs --meeting <id> --run <name> \
  --arm old --from-db /tmp/meeting-v2/transcribed.db --summarize --port 4790 \
  [--server-repo <worktree of the arm>]
# writes /tmp/meeting-v2/enhance/<name>-<id8>/{metrics-enhance.json,dump.json,server.log,test.db}

# 3. Check the metrics files, then the dumps of one arm (3 runs):
jq -e 'has("seconds") and has("chunksAttempted") and has("chunksSucceeded") and has("chunksFailed") and has("correctedCount") and has("speakerSuggestions") and has("contextHash")' /tmp/meeting-v2/enhance/*/metrics-enhance.json
node scripts/meeting-v2/check-enhance-metrics.mjs --dumps <d1> <d2> <d3> --out <m.json>

# 4. Compare two arms (X vs Y). Equal `text` hashes first:
jq -S '[.segments[].text]' <dump> | shasum
pnpm meeting:compare-speakers --x <X dump> --y <Y dump> --x-name A --y-name B --out <file.md>

# 5. The summary check alone (run-enhance.mjs --summarize calls it for you):
pnpm meeting:check-summary --db <db> --meeting <id> --arm <old|new> --out <metrics.json>
```

`run-enhance.mjs` prints counts, durations, hashes, ids and paths only. `dump.json` holds private text: never print or commit it. `check-enhance-metrics.mjs` reads `metrics-enhance.json` from the folder of each dump, so keep both files together. Both tools re-read their own output and exit 1 on a mismatch. `check-summary.mts` exits 0 (pass), 1 (a check failed) or 2 (wrong usage, unreadable database or no summary row); with `--arm old` it only measures.

The new-arm branch of `run-enhance.mjs` (202 route, job progress) is UNVERIFIED until the WP5b build exists. WP10b fixes it in the first round if it is wrong.

## How to compare runs

Two committed tools (PR #34; they replace the copy-edited per-run compare
scripts, which is what caused the 2026-10-07 false findings):

```bash
# 1. One proof run per meeting + the stored dumps. Requires the worker
#    override (it refuses without it) and a healthy oMLX.
OPENSTYLE_MLX_ASR_WORKER=$PWD/dist/mlx_asr_worker/mlx_asr_worker \
  ./scripts/meeting-v2/run-proof.sh <RUN> <meetingId> [meetingId ...]
# optional env: SCRATCH (default /tmp/meeting-v2), HF_CACHE (default
# /tmp/meeting-p4b-hf/hf, passed to run-baseline.mjs --hf-cache),
# OMLX_URL (default http://127.0.0.1:8123).
# writes /tmp/meeting-v2/compare/<run-lowercase>-<id8>.json and turns-<id8>.json

# 2. Compare two runs (from the repo root). The run names are CLI
#    arguments, so a stale dump path cannot survive a copy. One word
#    (the package.json script carries the ts-register loader):
pnpm meeting:compare --from R4f --to R4g --meeting all [--out-dir <dir>] [--only-changed]
#    the same tool without pnpm (a pi child without pnpm context):
#    node --import ./scripts/meeting-v2/ts-register.mjs scripts/meeting-v2/compare.mts \
#      --from R4f --to R4g --meeting all
# writes <FROM>-vs-<TO>-<id8>.md (byte-stable format, council-judged).
# --meeting takes an id8, a full uuid, or all (all = every meeting that
# has dumps for BOTH runs). --only-changed skips meetings with no
# changed chunks. Dump dir: /tmp/meeting-v2/compare (MEETING_CMP_DIR env
# overrides).
```

Dump format: `meeting_segments` rows `{source, idx, start_ms, end_ms,
text, speaker_label}` ordered by (source, idx); `turns-<id8>.json` is the
`meeting_diarizer_turns` rows. The **R0d special case**: R0d was R0's
output plus the diarizer labels and the old pipeline is gone from the
code, so `--from R0d` (or `--to R0d`) rebuilds the R0d side offline from
the `r3a-<id8>.json` dump (R3a == R0 output) plus the stored turns with
the winner-overlap rule, and MIC chunks are never labeled (the app
labels the system channel only). The self-check contract below applies
to both sides of every compare; on a failure the tool exits 1 and
writes nothing. Never hand-edit the dumps or the compare files —
re-run the tools.

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

## Metrics are not enough

On 2026-10-07 a run passed every metric (edgeWordsLost 0, multiTurnChunks 0) while every split part had lost its punctuation and both parts of each split had the same speaker label. Always read the compare file (or run the council) before you call a quality run good. Add a metric for each new failure class (punctRatio, splitLabelDistinct).

## Compare tools must check themselves

On 2026-10-07 three false findings came from the compare tooling, not the app: labels rebuilt per original chunk index, mic labels the app never stores, and an R4f file built from the R4e dump (a copy-edited script kept one `r4e-` path). Every compare script must re-read the stored rows of the run it renders and exit non-zero unless (source, idx, start_ms, end_ms, speaker_label) match exactly. Run that self-check before any council reads the files.
