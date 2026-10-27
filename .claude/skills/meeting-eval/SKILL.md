---
name: meeting-eval
description: Run the Openstyle meeting eval for one LLM on both gold meetings with one command, then judge the outputs blind. Use when you must measure a model on the gold meetings (5578edb0, ca70f895), compare models, or repeat the overnight sweep. Read meeting-benchmarks for the details of the tool.
---

# Meeting eval: one model, both gold meetings

This skill wraps `pnpm meeting:eval` (see `.claude/skills/meeting-benchmarks/SKILL.md` for all flags). One command runs one model on both gold meetings. A second tool hides the model names for the judge.

## Hard rules

1. Report numbers only. Never quote meeting text in chat, a commit or a PR.
2. Never call the owner's oMLX server. Only the built-in MLX models run.
3. Never take the GPU lock yourself before `run.sh`. `pnpm meeting:eval` queues in `/tmp/openstyle-gpu.queue` and takes `/tmp/openstyle-gpu.lock` itself. A lock you hold blocks your own run.
4. Never run two evals at once. Another session may hold the lock for up to 90 minutes (the app-check run has a 5400 s timeout). Read `/tmp/openstyle-gpu.lock/owner`.
5. Work in your own worktree. Do not commit `eval-baselines/*.json` unless the lead says so.
6. Delete `pack/`, `runs/` and `arms/` when the judging ends. They hold real meeting text.

## Known facts

- Eval home (outside `/tmp`): `~/Library/Application Support/Openstyle-eval/`.
  - `hf/`: the model cache. Env `OPENSTYLE_EVAL_HF_HOME` overrides it, but only with a folder under `/tmp` or the eval home. The tool refuses any other path (`--hf-cache must be under /tmp or ...`). It was `/tmp/meeting-eval/hf` until 2026-10-25. The macOS tmp cleanup deleted blobs of 5 models at 00:00 that day.
  - `audio/<meeting id>/{mic,system}.wav,sync.json`: a private copy of the gold audio.
  - `out/<model>-<date>/`: the default output of `run.sh`.
- `--out` and `--hf-cache` accept `/tmp` or the eval home. No other place.
- Gold meetings: `5578edb0` (831 s) and `ca70f895` (2142 s). Gold files are in `~/.openstyle-eval/gold/<id8>.json`.
- The eval reads the wav from the real profile `~/Library/Application Support/Openstyle/meetings/<id>/`. The app retention sweep (30 days) deleted the wav of gold meetings `2943c36a` and `9243bea0`. Only `5578edb0` and `ca70f895` have a private copy. `run.sh` checks both places. If only the private copy exists, `run.sh` stops and asks the owner to restore the wav. The guard hook blocks an agent from writing into the real profile. Mark the gold meetings `retention_exempt` once PR #329 merges.
- The ASR transcripts come from the cache `/tmp/meeting-eval/asr/cache/`. A cache hit needs the same worker, diarizer and server code (same ASR hash). Without a hit, the run transcribes first and takes much longer. This cache is in `/tmp` and can vanish too.
- Run time, measured 2026-10-25 with `gemma-4-e4b-qat-4bit`, transcripts cached: Enhance and Summarize 244.7 s and 271.3 s (run 1), 93.8 s and 228.0 s (run 2, total 321.8 s). Peak RSS of the LLM worker 6.75 GB. `elapsed_sec` in the `run.sh` output includes the wait for the GPU lock (934 s in run 2, of which about 10 min was queue). Run 3 (dev_senior review, same model): Enhance 93.9 s and 236.1 s, `elapsed_sec=1000` with about 12 min of queue behind an app-check run; same scores. Unverified for other models.
- The ASR hash includes the worker binary. A new worker build (or `OPENSTYLE_MLX_LLM_WORKER` set to another build) misses the cache and transcribes both meetings again (2026-10-26: 28 s and 70 s). Delete the cache entries of a throwaway worker after the run: they hold meeting text.
- Run time, measured 2026-10-26 with `gemma-4-e2b-qat-4bit` (no queue, transcription included): Enhance and Summarize 36.7 s and 96.8 s, peak RSS 4.36 / 4.45 GB, `elapsed_sec=388`. Hard fails 1 (5578edb0, `claim:c1`) and 0.
- A pack with one model gives one blind label (`A`). The blind step only hides names when you pass two or more models (`run.sh model-a,model-b`).
- Cache damage found 2026-10-25 (snapshot links with no blob): `models--mlx-community--gemma-4-E2B-it-qat-4bit` (6 links), `models--mlx-community--Qwen3.5-0.8B-8bit` (5), `models--mlx-community--Qwen3.5-4B-OptiQ-4bit` (6). Find them again with:
  `find "$HOME/Library/Application Support/Openstyle-eval/hf/hub" -path '*snapshots*' -type l ! -exec test -e {} \; -print`
  Repair (not run, unverified): delete the damaged `models--...` folder. Then run `pnpm meeting:eval --models <id>` without `--no-download`. The tool prints the size and downloads the model.

## Run

```bash
# Needs: node_modules, a fresh server build, the diarizer files, a worker.
.claude/skills/meeting-eval/scripts/run.sh <model-id> [out-dir]
# example
.claude/skills/meeting-eval/scripts/run.sh gemma-4-e4b-qat-4bit
```

`run.sh` does these steps:

1. It checks the gold wav files (real profile, then the private copy).
2. It warns about dangling cache links for the model.
3. It picks the newest worker in `/tmp/meeting-eval/worker-*/` (or `OPENSTYLE_MLX_LLM_WORKER`). It checks the diarizer files and `node_modules`. It builds the server (`pnpm turbo build --filter=@openstyle/server`).
4. It runs `pnpm meeting:eval --models <id> --meetings 5578edb0,ca70f895 --gold --keep --no-download`. The tool takes and releases the GPU lock.
5. It prints the elapsed seconds and `results.md`.

Abort rule: a `trap` on `EXIT`, `INT` and `TERM` removes `pack/`, `arms/` and `runs/` of the out dir when the run does not finish (failure, Ctrl-C, `kill`). It then removes the out dir if it is empty. It signals the whole process tree, so `eval.mts` releases the GPU lock. A finished run keeps `pack/` for the blind step. `kill -9` skips the trap and leaves the lock and the files: remove them by hand.

Traps:

- `meeting:eval failed: the server build is older than apps/server/src`. Run `pnpm turbo build --filter=@openstyle/server`. `run.sh` does this.
- A new worktree has no diarizer files. Copy `apps/electron/resources/bin/darwin-arm64/fluidaudio-diarize` and `apps/electron/resources/models/speaker-diarization` from the main checkout. Without them the server skips diarization with no error.
- The worker copy in `/tmp/meeting-eval/worker-*` is also under `/tmp`, so the tmp cleanup can remove it. Copy it again when it is missing.
- A new worktree has no worker build. Copy the shipped one: `cp -R ~/.cache/freestyle/mlx-asr/runtime/darwin-arm64/mlx_asr_worker /tmp/meeting-eval/worker-<version>/`.
- Do not use `pkill`. The guard hook blocks it. Kill a PID that you started.
- A `GPU lock: queued` line is normal. The run waits and checks every 30 s.

## Expected output

The log tail of a good run (2026-10-25, `gemma-4-e4b-qat-4bit`):

```
model gemma-4-e4b-qat-4bit: in /Users/maheidem/Library/Application Support/Openstyle-eval/hf
transcription 5578edb0: cached (c1e10c7699afb1ae)
transcription ca70f895: cached (2b70d21a5312640c)
GPU lock taken: gemma-4-e4b-qat-4bit
run gemma-4-e4b-qat-4bit 5578edb0: exit 0
run gemma-4-e4b-qat-4bit ca70f895: exit 0
GPU lock released
self-check ok: 2 runs, 2 meetings
gemma-4-e4b-qat-4bit 5578edb0: hard fails 1 (...)
gemma-4-e4b-qat-4bit ca70f895: hard fails 0 (...)
floor: none
elapsed_sec=934
```

The hard fail of `5578edb0` is the gold key `claim:c1` (a must-not-claim hit in the summary).

`results.md` scorecard of the same run (pooled over both meetings): ASR WER 0.0066, Enhance WER 0.0069 (delta -0.0003), summary matched 8/11, tags P 0.80 R 0.80, speakers correct 3/6.

There is no `Downloading` line. A download line means the cache path is wrong.

## Blind judgment step

Who judges: Claude subagents that you start. A judge sees only the judge folder. The lead (you) keeps the mapping.

The judge harness was rebuilt on 2026-10-26 after an owner review of 22 items. The old harness (one judge, one big rubric, cut compare lines, fault sums) picked main 3 of 3 where the owner saw a near tie. Its defects: 9 changed lines per meeting were hidden, quotes had 3 words of context, a fault sum punished the longer summary, and nothing checked order bias or the judge itself.

The harness now works like this:

- `transcript.md`: the RAW transcript, one line id per segment. Every summary task reads it, so the judge has the full context.
- `corrections.md`: every line that an arm changed, in full, with 2 full lines before and after. No cap.
- One task file per judge call: `TASK-corrections.md`, `TASK-decisions.md`, `TASK-actionItems.md`, `TASK-openQuestions.md`, `TASK-keyPoints.md`. Each call judges one section, item by item, against the transcript (decided / not decided, correct / wrong owner / wrong due / not an action, open / answered, supported / unsupported).
- For decisions, action items and open questions, the judge also makes a reference list from the transcript. `score` reports precision (good items / items) and recall (covered reference items / reference items) per section. It never sums faults, so a longer summary is not punished for its length.
- Verdict: summary F1 (pooled over the 3 sections) within 0.10 is a near tie. Corrections: the arm that is best on more changed lines is ahead.

Rubric rule (owner, 2026-10-26): Enhance removes exact repeated words, so `JUDGE.md` tells the judge to count a removed exact repeat as neutral. Traps found 2026-10-26:
- The compare files hide changed lines after a limit ("+9 more"). A judge cannot see them, and one hidden line held a real harm. For a close call, list the lines where the arms differ in a non-repeat way and ask the owner.
- One judge per meeting is noise: 3 fresh judges per meeting split 2 to 1 on both gold meetings. Use 3 judges, each with its own `--seed`, in separate out folders.
- To compare two code versions (not two models), run `meeting:eval` once per version (check out each commit, build, run with its own `--out`; pass `--port` when 4800 is busy), then copy both packs into one pack folder with neutral slugs (not words such as "main", which `scrub` would also replace in the meeting text).

```bash
OUT=<out-dir of run.sh>
B=.claude/skills/meeting-eval/scripts/blind.py
# Models of one out folder:
python3 -I $B make --pack "$OUT/pack" --meeting <id8>
# Builds of the same model (one out folder per build):
python3 -I $B make --arm main=<out-main> --arm split=<out-split> --meeting <id8> --tag -j1
```

Each call writes `<root>/judge<tag>/<id8>/` and the mapping `<root>/blind-map<tag>-<id8>.json` (mode 0600, outside the judge folder). `<root>` is `$OUT` with `--pack`, else the parent folder of the first arm.

1. Start one fresh judge subagent per task file (5 per meeting). Brief: "Read `<judge dir>/TASK-<name>.md` and follow it. Read nothing else outside that folder." Do not give the judge the map path. Start them in parallel.
2. Each judge writes `<name>.json` in the judge folder.
3. Score and unblind: `python3 -I $B score --map <root>/blind-map<tag>-<id8>.json`. It prints the numbers per arm and writes `<map>.score.json`.
4. Use 3 judge folders per meeting (`--tag -j1`, `-j2`, `-j3`: each gets its own random order). Report the verdict of each.
5. Order-swap test: `make ... --swap-of <map of j1> --tag -swap`, judge it, score it, then `python3 -I $B consistency --a <j1 score> --b <swap score>`. A good judge gives the same verdict per item in both orders.
6. Planted-error test: `make ... --plant --tag -plant`. The tool plants an invented decision, an invented owner, an invented due date, a lost negation, a changed number and a swapped name in one arm. `score` prints `plants caught: n/m`. A judge that misses planted errors cannot be trusted on that meeting.
7. Report numbers per arm. Use a model only if it has 0 hard fails on both meetings, or say why not.

Calibration against the owner (2026-10-26, E2B, both gold meetings): see `## Calibration` below.

## Cleanup

```bash
rm -rf "$OUT/runs" "$OUT/pack" "$OUT/arms" "$OUT"/judge* "$OUT"/blind-map*.json
```

Keep `results.md` and `results.json` (numbers only). Remove the GPU lock only if you hold it and the run died: `rm -rf /tmp/openstyle-gpu.lock` (check `owner` first).

## Calibration

Measured 2026-10-26 against 22 owner answers (16 Summarize questions on main vs split, 6 correction lines on main vs branch), E2B, both gold meetings, 3 fresh Claude judges per harness. A cell is one question for one arm (32 Summarize cells, 6 correction lines).

| | Old harness | New, round 1 | New, round 2 |
|---|---|---|---|
| Summarize cells agree (per judge) | 21, 20, 21 of 32 | 21, 19, 20 of 32 | 25, 23, 25 of 32 |
| Correction lines agree (per judge) | 3, 3, 3 of 6 | 4, 4, 4 of 6 | (same judges) |
| Summarize verdict | main better (5 of 6 judge-meetings) | near tie (5 of 6) | near tie (4 of 6) |
| Planted errors caught | not tested | 12 of 12 | 6 of 6 (summary) |
| Order swap, same verdict per item | not tested | 30 of 32 items, 178 of 178 marks | not run |

- Round 2 uses the rubric in this file now. Its 3 rubric rules come from the same owner answers (a to-do is not a decision; a question for a later call stays open; coverage needs the same task). The round-2 numbers are in-sample. Check them on a new owner review before you trust them.
- The correction line winner comes from the marks. A free "best" pick changed with the label order (10 of 60 lines the same after a swap).
- The old harness hid 9 changed lines per meeting and showed the model name in the compare header.
- Disagreements left in round 2: the point of contact at the end of ca70f895 (the transcript says one thing, the owner knows another), and one action item that the judge counts as covered by a different task.

## Update this skill

After each run, add new traps, the measured run time of the model and any new fixed ids here.
