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

Who judges: a Claude subagent that you start. The judge sees only the relabeled files. The lead (you) keeps the mapping.

```bash
OUT=<out-dir of run.sh>
for m in 5578edb0 ca70f895; do
  python3 -I .claude/skills/meeting-eval/scripts/blind.py make --pack "$OUT/pack" --meeting $m
done
```

Each call writes `$OUT/judge/<id8>/{A..F}.compare.md`, `{A..F}.summary.md` and `JUDGE.md`. It writes the mapping to `$OUT/blind-map-<id8>.json` (mode 0600), outside the judge folder. It replaces the model names in the text with `MODEL`.

1. Start one judge subagent per meeting. Brief: "Read `$OUT/judge/<id8>/JUDGE.md` and follow it. Read nothing else. Write `scores.json` in that folder." Do not give the judge the map path.
2. The judge writes `scores.json` with fixes, harms, neutral, summary faults and rank per label.
3. Unblind:
   `python3 -I .claude/skills/meeting-eval/scripts/blind.py reveal --map "$OUT/blind-map-<id8>.json" --scores "$OUT/judge/<id8>/scores.json"`
4. Report numbers per model. Use a model only if it has 0 hard fails on both meetings, or say why not.

Models compare only inside one `pack/`. To compare models, pass them as one comma list: `run.sh model-a,model-b`. Then all packs land in one `pack/` folder.

## Cleanup

```bash
rm -rf "$OUT/runs" "$OUT/pack" "$OUT/arms" "$OUT/judge" "$OUT"/blind-map-*.json
```

Keep `results.md` and `results.json` (numbers only). Remove the GPU lock only if you hold it and the run died: `rm -rf /tmp/openstyle-gpu.lock` (check `owner` first).

## Update this skill

After each run, add new traps, the measured run time of the model and any new fixed ids here.
