---
name: eval-lab
description: Turn knobs on Openstyle meeting ASR and measure each change - run a grid of knob values on a frozen private corpus (silver-14-s34, silver-14-s33), log every cell to MLflow with a full snapshot, keep per-span results privately, then find the best runs and compare two runs. Use when you must measure a meeting ASR knob or code change, run a grid search, reproduce a past ASR result, or answer "which setup is best".
---

# Eval Lab (meeting ASR)

The code is in `scripts/meeting-v2/eval/lab/`. One command: `pnpm lab <command>`.

The lab supersedes these older procedures for meeting ASR: the arm runs of the silver-gold skill (`pnpm meeting:silver:arm`, `run_arm.sh`, `score_arms.mts`) and ASR-only runs of `pnpm meeting:eval`. They stay in the repo. Use `pnpm meeting:eval` for the LLM stages (Enhance, Summarize).

## Hard rules

1. Numbers and keys only. The console, MLflow and the repo get ids, knob values, hashes and numbers. Never meeting text, span text, names or terms.
2. The owner name comes from the env only: `LAB_OWNER_NAME`. A grid says `"owner_name": "env"`, never the name. MLflow gets `set:<salted fingerprint>`.
3. Private data lives in `~/.openstyle-eval/lab/` (folders 0700, files 0600): corpora, the ASR cache, the run items. `labHome()` refuses a path in the repo. Never copy it into the repo, a PR or a chat.
4. The MLflow URI comes from the env only: `LAB_MLFLOW_URI` or `SILVER_MLFLOW_URI`. No default. Never write the LAN address in the repo.
5. A run counts only after the read-back. `pnpm lab run` reads every run back from the server and fails on any lost value.
6. GPU: the lab takes `/tmp/openstyle-gpu.lock` itself (queue `/tmp/openstyle-gpu.queue`) for each transcription. Never take the lock by hand before it. Stop a run with SIGINT to the PID you started. Never stop processes of other sessions.
7. The lab never downloads a model. A model must be in the eval HF cache (`~/Library/Application Support/Openstyle-eval/hf`).
8. Compare runs only on the same basis: corpus hash, gold hash, scorer version and meetings. `pnpm lab compare` prints a WARN when they differ.

## Setup (once per worktree)

```bash
pnpm install --frozen-lockfile
pnpm turbo build --filter=@openstyle/server     # the lab refuses a stale build
# A new worktree has no diarizer files: copy them from the main checkout.
M=<main checkout>/apps/electron/resources
cp -R $M/bin/darwin-arm64 apps/electron/resources/bin/
cp -R $M/models/speaker-diarization $M/models/silero-vad apps/electron/resources/models/
export OPENSTYLE_MLX_LLM_WORKER=/tmp/meeting-eval/worker-<version>/mlx_asr_worker/mlx_asr_worker
export LAB_MLFLOW_URI=<MLflow server>  LAB_OWNER_NAME=<owner first name>
```

## Commands

| Command | What it does |
|---|---|
| `pnpm lab knobs` | Lists the knobs (name, how applied, default, values) and the inputs that are "not a knob yet". |
| `pnpm lab corpus build <name> [--gold-dir d] [--gold-suffix s] [--audio-dir d] [--meetings id8,...]` | Writes the manifest, freezes a private copy of the gold keys (`--gold-suffix silver-3.3` takes the `<id8>.silver-3.3.json` backups) and freezes the seed DB (vocabulary, languages, meetings rows; never the owner name). |
| `pnpm lab corpus check <name>` | Checks every audio, seed and gold hash and the file modes. `pnpm lab run` does the same check for its meetings. |
| `pnpm lab run <grid.json> [--dry-run] [--force] [--port n]` | Runs each cell. A cell with a FINISHED run of the same snapshot hash is skipped (`--force` runs it again). |
| `pnpm lab list [--filter knob=value] [--metrics m,...]` | One row per run, with the knobs that differ. |
| `pnpm lab best --metric <m> [--top N] [--asc/--desc] [--filter knob=value]` | The best runs and their knob values. WER, insertions, wall time and RSS are lower-is-better. |
| `pnpm lab compare <runA> <runB>` | Metric deltas (B - A), meetings better/worse/same on span hits, span flips, changed knobs, basis WARN lines. |
| `pnpm lab show <run>` | Params, `lab.*` tags, pooled metrics, local items. A run id prefix is enough. |

## Write a grid

A grid file is JSON (`grids/` has examples):

```json
{
  "name": "owner-name-short",
  "stage": "asr",
  "corpus": "silver-14-s34",
  "meetings": ["ab518a0c", "c838735c"],
  "base": { "vocabulary": "corpus" },
  "grid": { "owner_name": ["unset", "env"], "max_attendee_names": [0, 20] },
  "cells": [{ "asr_model": "qwen3-0.6b-8bit" }]
}
```

- Cells = the cartesian product of `grid` plus the explicit `cells`, each over `base`, then over the knob defaults. Equal cells run once.
- `meetings` is optional (default: all of the corpus). Start with the 2 shortest meetings (`ab518a0c` 927 s, `c838735c` 1394 s), then run the full corpus for the winner.
- Run `--dry-run` first: it prints each cell, its snapshot hash and SKIP or "would run".
- Resume and SKIP: the snapshot hash holds the git sha and the `labVersion` (`scripts/meeting-v2/eval/lab/snapshot.mts`). A rerun is a SKIP only at the same commit. After any commit, the grid runs again. The ASR cache can still serve the transcripts (a cache hit took about 6 s for 14 meetings), so the cost is mostly scoring. This is on purpose: the code version is part of the experiment setup.

## Add a knob

1. Find where the app reads the input (a setting, a DB row, an env var). If it is a constant, the knob needs an app change first: a small env override that keeps the default (see `OPENSTYLE_ASR_MAX_ATTENDEE_NAMES` and `OPENSTYLE_ASR_ATTENDEE_NAME_FORM` in `apps/server/src/lib/meetings/bias-terms.ts`, with a server test).
2. Add an entry to `KNOBS` in `knobs.mts`: name, `apply`, target, default (the shipped value), values text, check.
3. If the `apply` kind is new, apply it in `asr.mts` (`applyDbKnobs`, `envKnobs` or the run name).
4. Every knob is in the ASR cache key and the snapshot without more work. Run `pnpm meeting:eval:test`.

## What a run records

- MLflow experiment `openstyle-lab-asr`. Params = every knob value. Tags `lab.*` = snapshot hash, git sha/branch/dirty flag/diff hash/untracked hash, code hash, worker and diarizer hashes, model ids and HF revisions, corpus manifest hash, gold hash/kinds/verified counts, scorer and lab versions, machine, times, local items folder.
- Metrics: `spans_<group>` (recall %, plus `_hits` and `_n`) for all, high, person, term, other, in_vocab, not_in_vocab, person_no_owner and verified; `wer`, `wer_eligible` (+ errors, ref, edit counts); `possible_insertions` and `ins_*`; `segments`; `cell_wall_s`, `asr_wall_s`, `asr_fresh_meetings`, `asr_cached_meetings`; `peak_rss_worker_mb` and `peak_rss_tree_mb` when a meeting was transcribed; per meeting `m.<id8>.<metric>`.
- Env knobs of the meeting bias: `max_attendee_names` (`OPENSTYLE_ASR_MAX_ATTENDEE_NAMES`, default 20; it counts people) and `attendee_name_form` (`OPENSTYLE_ASR_ATTENDEE_NAME_FORM`): `full` (default, the shipped app), `first` (the owner name as is, then the first word of each attendee name; the old arm B2) or `both` (per person: full name, then first name). An unknown value acts as `full`. Both values are in the ASR cache key and the snapshot, so each form has its own transcripts.
- `spans_person_no_owner` leaves out the spans of the owner name of the run. With `owner_name=unset` it leaves out nothing, so compare it only between runs that both set the owner name.
- Verified spans (owner ear check, silver-3.4: `verified`, `verified_source`, `verified_text`, `verified_unsure` on a gold span): a verified span scores as high and uses `verified_text` when present. `spans_verified_n` is always logged; the rate and hits only when n > 0. `spans_verified_unsure` counts the unsure answers. Since silver-3.5 a span can hold `verified_none` (the owner hears no named entity there). The scorers leave such a span out of every count (all, high, labels, vocab, verified, the insertion support) and log its count as `spans_verified_none` (tag `lab.gold_verified_none`). A verified span may keep `verifier_conflict` and `alt_text` (silver-3.4 and later). Bias: the first 30 verified spans come only from B2/B3 disagreements, so `spans_verified` favours the arm whose spelling the owner picked there. Read it next to `spans_all`, never alone.
- `~/.openstyle-eval/lab/runs/<run id>/`: `snapshot.json`, `items.jsonl` (one scored span per line: id8, channel, start, end, label, confidence, in-vocab, hit), `meetings.jsonl`.

## The ASR cache

`~/.openstyle-eval/lab/asr/cache/<meeting id>.<key>.db`. The key holds every knob, the audio sha256, the content of `apps/server/src` and `packages/*/src`, the worker, the diarizer and its models, the run name and the lab files that apply the knobs (`asr.mts`, `knobs.mts`). A cache hit is always valid, so grids and repeats reuse transcriptions. `meta/` keeps the ASR wall time of each entry.

## Acceptance check (expected output, 2026-10-29)

| Command | Expected |
|---|---|
| `pnpm meeting:eval:test` | `pass 110`, `fail 0` (after the server build) |
| `pnpm meeting:silver:test` | `Ran 15 tests ... OK`, then `Ran 7 tests ... OK` |
| `pnpm lab corpus check silver-14-s34` | `61/61 OK` |
| `pnpm lab run scripts/meeting-v2/eval/lab/grids/shipped-s33.json` (14 meetings, owner name set) | `spans_all 82.7 (1152/1393)`, `READ BACK OK` |
| The same command again, at the same commit | `SKIP (run <id> has this snapshot)` |
| The same command after a new commit | No SKIP. The grid runs again. The ASR cache serves the transcripts, so only scoring costs time. |

## Known facts

- Corpora (2026-10-29, 14 work meetings, 80 vocabulary rows, audio from `~/Library/Application Support/Openstyle-eval/audio/`; the app copies go away after 30 days):
  - `silver-14-s34`: the current keys, goldKind silver-3.4, goldHash `69dd82895b94`, 30 verified spans (5 with `verified_text`), 4 verified_unsure, 1396 scored spans. Use it for new work.
  - `silver-14-s33`: the silver-3.3 backups, goldHash `c143902811c4`, 1393 scored spans. The acceptance number lives here.
  - `silver-14`: the first manifest. It pointed at the live gold folder, so its check fails since the 3.4 keys landed (`goldHash c143902811c4 (now 69dd82895b94)`). Since then a corpus freezes its own copy of the keys. Keep it: runs B and C of 2026-10-29 refer to it.
- The validator of the keys: `SILVER_KEYS=~/.openstyle-eval/gold-silver pnpm meeting:silver:validate --kind <goldKind>` gives `14/14 pass` (with no witness corpus on the Mac, it takes the ids from the key files). It knows silver-2 to silver-3.6. Its tests: `pnpm meeting:silver:test`.
- ASR repeat runs are byte-identical, so a cache hit gives the same metrics as a fresh run.
- A full 14-meeting ASR run takes 20 to 27 min. Run it in the background and check the log.

- Reference runs (MLflow experiment `openstyle-lab-asr`). Cite these as baselines:
  - silver-3.3, shipped config: run `d5971004` (fresh, after the rebase, clean tree). Runs `1fa07dd3` (made at the pre-rebase sha `cf42c1ac`) and `d2a3dead` (`lab.git_dirty=true`) have equal metrics (1152/1393). Do not cite them as the baseline.
  - silver-3.4, shipped config: run `e40bae04` (1150/1396, `spans_verified` 10/30).

## Environment

- A fresh shell has no MLflow URI. Before any `lab` command, set `SILVER_MLFLOW_URI` (or `LAB_MLFLOW_URI`) in the env. Never write the address into the repo.
- Set `LAB_OWNER_NAME` for cells with `owner_name=env`. The owner fingerprint in MLflow (`set:<salted fingerprint>`) must match, or the snapshot differs.
- The MLflow REST endpoint `experiments/get-by-name` accepts GET only. A POST gives 405.

## Troubleshooting

- `no dev worker at .../dist/mlx_asr_worker`: set `OPENSTYLE_MLX_LLM_WORKER` (setup).
- `the server build is older than ...`: `pnpm turbo build --filter=@openstyle/server --force`. Without `--force`, a turbo cache hit restores an old `dist/` (old mtime) after a rebase, and the check fails again (seen 2026-10-29).
- `missing .../fluidaudio-diarize`: copy the diarizer files (setup).
- `corpus check failed: audio ...`: the private audio changed. Find out why before you build a new corpus under a new name.
- `port ... is in use`: pass `--port <base>` (the lab uses base+2 and base+3).
- `read-back of run ... differs`: the run is marked FAILED. Check the server, then run the grid again (the cell is not skipped).

## Cleanup

- The lab deletes its scratch profile after each cell.
- Keep `~/.openstyle-eval/lab/runs/` and the MLflow runs: they are the ledger.
- The ASR cache holds meeting text. Delete old entries only when you need the disk: `rm -rf ~/.openstyle-eval/lab/asr/cache ~/.openstyle-eval/lab/asr/meta`.
