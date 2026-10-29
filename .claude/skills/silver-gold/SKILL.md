---
name: silver-gold
description: Build, check and use silver gold keys (span keys voted from several ASR witnesses) for Openstyle meetings, and score the app or ASR arms against them. Use when you must add meetings to the silver gold, re-vote the keys, add a witness (local or cloud), score a transcription change on names and terms, or compare ASR arms (A/B/B2/B3).
---

# Silver gold: witnesses, vote, score

The code is in `scripts/meeting-v2/eval/silver/` (read its `README.md` for the layout, the file formats and the gold schema). The eval side (`pnpm meeting:eval --gold`, the `## Spans` section) is in `.claude/skills/meeting-benchmarks/SKILL.md`, section "Silver keys".

## Hard rules

1. Local only. The cloud witnesses (`openai_run.py`, `gemini_run.py`) send meeting audio to OpenAI or Google. Run them only when the owner approves it, for the named meetings, in this session. The 2026-10-28 approval covered the 14 work meetings ONCE. It is not a standing approval.
2. Work-meeting audio policy: audio leaves the Mac only with that approval. Never upload a wav anywhere else. Never copy audio, witness files, keys or arm DBs into the repo, a chat, a commit, a PR or an issue.
3. Numbers only. Report counts, ids and percentages. Never quote meeting text, names of attendees or span text. The ledger may hold the owner's own vocabulary terms, nothing else.
4. Keys come from the environment only: `OPENAI_API_KEY`, `GEMINI_API_KEY`. Never write a key to a file. Never print it. After a run, grep the work folder and the logs for the key prefix and report "no key string found".
5. MLflow: set `SILVER_MLFLOW_URI` to the MLflow server (it has no default; the cloud runners stop when it is unset). The experiment is `openstyle-silver-witnesses` (id 70), with counts only (no text in inputs, outputs, attributes or events). A trace counts only after you read it back: `<venv python> -I scripts/meeting-v2/eval/silver/witness/mlflow_check.py --since <unix ms>` must print `text-like outputs 0 inputs 0 attributes 0 events 0` and state `OK`.
6. Private data lives in `~/.openstyle-eval/` (folders 700, files 600). `silver_paths.py` refuses a path inside the repo. Do not change that.
7. GPU queue: `witness.py`, `parakeet.py` and `pnpm meeting:eval` take `/tmp/openstyle-gpu.lock` themselves (queue `/tmp/openstyle-gpu.queue`). Never take the lock by hand before them. Never run two GPU jobs at once. Read `/tmp/openstyle-gpu.lock/owner` first.
8. No writes to the app DB, the meeting folders or the corpus by hand. The keys change only through `normalize_silver3.py --write`, which makes a backup first. Do the dry run (no `--write`) first and read the counts.
9. Stop a run with SIGINT to the PIDs that you started (`run_arm.sh` does this). Never `pkill`.

## Known facts

- Corpus: 14 work meetings (ids in `~/.openstyle-eval/gold-silver/`). Keys: `goldVersion` 3, `goldKind` "silver-3.3", 1606 spans: 1178 high, 215 medium, 213 unsure; 1393 high+medium are scored. 230 spans have `alt_text`. Backups: `<id8>.silver-1/2/3/3.1/3.2.json`.
- Witnesses: H1 (Qwen3-ASR 1.7B, no prompt), H2 (the app prompt), H3 (Whisper large-v3-turbo), Parakeet TDT 0.6B v3 (586 s for 14 meetings), Gemini (125 chunks gemini-4-argon + 29 gemini-3.5-flash-lite), OpenAI gpt-transcribe (154 chunks), Google Meet (10 of 14 meetings), Krisp (3 of 14).
- Costs (2026-10-28): OpenAI gpt-transcribe US$0.0045/min, 84654 billed s = US$6.349 for 14 meetings x 2 channels; with the pilot US$6.37. Gemini 4 Argon about US$0.06 per 600 s chunk. gemini-3.5-flash-lite about US$0.011 per chunk (the 29-chunk fill cost about US$0.42 with its pilot). Compute the cost BEFORE a run; stay under 70 % of the cap; `openai_run.py` stops at 85 % of the cap.
- Model choice for a fill: a 2-chunk pilot (`pilot_wer.py`, WER vs H1). 2026-10-28: gpt-transcribe 5.44 %, gpt-4o-mini-transcribe 6.79 %, gemini-3.5-flash-lite 6.85 %, gemini-4-argon 7.90 %, gemini-3.8-flash 8.02 %, gemini-3.1-flash-lite 14.05 %. Pick the cheapest model within +3 WER points of the best.
- Scores on silver-3.3 (`pnpm meeting:silver:score`, span H+M, n=1393, match rule of 2026-10-29: accents folded, a match without spaces, one output occurrence per span): GEMINI 81.7, APP_RAW 76.2, H2 76.0, H3 75.6, APP_ENH 75.2, H1 73.8, PARAKEET 68.8, OPENAI 64.8. The rule before (exact run only) gave GEMINI 79.1, H3 75.7, APP_RAW 74.2, H2 74.1, APP_ENH 73.2, H1 72.4, PARAKEET 67.8, OPENAI 65.1. Compare systems only within one `goldKind` and one scorer version.
- Arms on silver-3.3 (`score_arms.mts`, pooled hits of 1393, match rule of 2026-10-29): A 1053 (75.6 %), B 1107 (79.5 %), B2 1158 (83.1 %), B3 1152 (82.7 %); the ranking is the same as with the rule before (A 1037, B 1100, B2 1144, B3 1142). 71 scored spans have a twin (same channel, words and turn time): the turn holds the words 2 or more times, so the output must hold them as often. Unsupported name tokens owner/non-owner: A 2/3, B 1/25, B2 9/18, B3 9/22.
- The eval on one meeting: `pnpm meeting:eval --models gemma-4-e2b-qat-4bit --meetings ab518a0c --gold --gold-dir ~/.openstyle-eval/gold-silver --no-download --port 4811 --out /tmp/meeting-eval/out/<name>` took 62 s with no ASR cache (2026-10-29). On main before PR #359: ASR spans 75.6 (31/41), Enhance 78.0 (32/41), 5 unsure skipped; arm A gives the same 31/41. On main with PR #359 (owner and attendee names in the ASR bias): ASR 80.5 (33/41), Enhance 82.9 (34/41).
- An ASR-only arm run of 14 meetings takes 20 to 27 min.

## Procedure

Run every command from the repo root. Set the paths once (the defaults are in `README.md`):

```bash
export SILVER_CORPUS=<corpus folder>        # default ~/.openstyle-eval/silver/corpus
export SILVER_KEYS=~/.openstyle-eval/gold-silver
export SILVER_WORK=~/.openstyle-eval/silver/work
pnpm meeting:silver:test                    # expect: Ran 15 tests ... OK
```

### A. Score a change (no new keys)

1. Build the server: `pnpm turbo build --filter=@openstyle/server`. The eval refuses a stale build.
2. Run the eval: `pnpm meeting:eval --models <id> --meetings <id8,...> --gold --gold-dir ~/.openstyle-eval/gold-silver --no-download --out /tmp/meeting-eval/out/<name>`.
3. Read `## Spans` in `results.md`. Compare with a run of the same command on main.

### B. Compare ASR arms

1. Build the server of the worktree that holds the arm code.
2. Run each arm (ASR only, about 20 to 27 min for 14 meetings): `[ENV=...] pnpm meeting:silver:arm <arm>`. Several arms: `pnpm meeting:silver:arms <arm>:ENV=v;ENV=v ...` (it keeps each DB in `~/.openstyle-eval/silver/arms/`).
3. Score: `pnpm meeting:silver:score-arms <arm> ...`. Expect a pooled table and one `results.{md,json}` per arm in `/tmp/meeting-eval/out/<arm>/`.
4. Compare: `pnpm meeting:silver:compare-arms <base> <arm> ...`. Read recall (All, Person, Person excl. owner) and the unsupported name tokens together: a name gain with many insertions is not a win.
5. Review insertions by ear if needed: `pnpm meeting:silver:extract-unsup <arm> <id8,...> <file outside the repo>`.
6. Keep the arm DBs until the analysis ends. A cleanup forced 3 re-runs on 2026-10-28.

### C. Add meetings or witnesses, then re-vote

1. Local witnesses (GPU lock): `pnpm meeting:silver:witness <id8,...>`, then `pnpm meeting:silver:parakeet`. Set `SILVER_OWNER_NAME` if the app DB has no `owner_name` setting.
2. Meet/Krisp: import by hand into `<id8>/meet.json` / `krisp.json`, then `pnpm meeting:silver:align --write`, then `<EG2 venv python> -I scripts/meeting-v2/eval/silver/align/eg2_embed.py` and `python3 -I scripts/meeting-v2/eval/silver/align/align_eg2.py --write`.
3. Cloud witnesses, only after the owner approves (rule 1): compute the cost, run the pilot (`pilot_wer.py --pilot id8:ch:k,...`), then `openai_run.py` + `openai_embed.py` + `openai_build.py --write`, and `gemini_run.py` + `gemini_stitch.py --write` (+ `gemini_merge.py` for a fill). Then check the traces (rule 5) and the key grep (rule 4).
4. New meetings need silver-1 keys first (a Claude adjudication workflow; see README "Not scripted"), then `python3 -I scripts/meeting-v2/eval/silver/vote/normalize_silver2.py --write`.
5. Vote, dry run first: `pnpm meeting:silver:vote --v33`. Read the transitions and the `before`/`after` counts. Then `pnpm meeting:silver:vote --v33 --write`.
6. Check: `pnpm meeting:silver:validate --kind silver-3.3` (expect `schema check (silver-3.3): 14/14 pass`) and `pnpm meeting:silver:load-check` (expect `parseGold: 14/14 pass` and `loadGold (folder mode + all files): pass`).
7. Score: `pnpm meeting:silver:score > <file outside the repo>`.

## Verify (expected output, 2026-10-29)

| Command | Expected |
|---|---|
| `pnpm meeting:silver:test` | `Ran 15 tests`, `OK`, then `Ran 7 tests`, `OK` |
| `pnpm meeting:eval:test` | `pass 95`, `fail 0` (after the server build) |
| `pnpm meeting:silver:load-check` | `parseGold: 14/14 pass` |
| `pnpm meeting:silver:validate --kind silver-3.3` | `14/14 pass` |
| `pnpm meeting:silver:validate --kind silver-3.4` (the keys since 2026-10-29 15:00; 30 verified spans) | `14/14 pass` |
| `pnpm meeting:silver:vote --v33` (dry run) | `after: {'high': 1178, 'unsure': 213, 'medium': 215}` |
| `pnpm meeting:silver:score` | APP_RAW `76.2 (1062/1393)` in the first table |
| `pnpm meeting:silver:score-arms s33-A s33-B s33-B2 s33-B3` on the kept DBs | All `1053/1393`, `1107/1393`, `1158/1393`, `1152/1393` |

## Traps (from the ledger)

- `calendar_event_id` holds the recurrence split date, not the date of the instance. Do not use it to find a meeting date.
- Krisp recorded only 3 of 14 work meetings. Meet transcripts exist for 10 of 14.
- Gemini HTTP 429 with a spend message = the monthly spending cap of the project (raise the cap). HTTP 402 = the prepaid credits are gone. They need different fixes.
- OpenAI gpt-transcribe gives no timestamps (`verbose_json` = HTTP 400). Its lines get the clock from EG2 alignment (`openai_build.py`); score it on line pairs (`alignedMs`), not on a +-3 s window.
- The owner name must be in the trusted list (silver-3.3). Without it, 94 of 117 owner-name spans were unsure, because engines without the list write a sound-alike spelling.
- A workflow resume reuses only the unchanged prefix of agent calls. Use an `only` filter to redo some items.
- Keep the arm transcripts until the analysis ends.
- The eval refuses a stale server build: `pnpm turbo build --filter=@openstyle/server`.
- A new worktree has no `node_modules`, no diarizer files and no worker. Run `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts`, copy `apps/electron/resources/bin/darwin-arm64` and `apps/electron/resources/models/{speaker-diarization,silero-vad}` from the main checkout, and use the worker in `/tmp/meeting-eval/worker-*` (see the meeting-eval skill).
- The leak filter of the app drops short segments that hold only a name. In the one test (2026-10-29, 2 segments) both were hallucinations on noise, so the drop is useful. Do not "fix" it without a bigger test.
- `run_arm.sh` deletes the shared ASR cache `/tmp/meeting-eval/asr/cache` under the GPU lock (the cache key does not hold the arm env), then starts the eval. If the eval log still shows a cached transcription, the arm run fails: run it again. `SILVER_ARM_DRY_RUN=1` checks the arm name and `SILVER_EVAL_HOME` and deletes nothing.
- A vote change moves every score. Silver-2 to silver-3 lowered all systems by about 8 points. Never compare numbers across `goldKind`.

## Cleanup

- After an arm analysis: `rm -rf /tmp/meeting-eval/out/<arm>/arms /tmp/meeting-eval/<arm>.out /tmp/meeting-eval/proof-<arm>-*.txt`. Keep `results.{md,json}` (numbers only). Delete the kept arm DBs only when the owner says the analysis is over.
- After an eval run: `rm -rf /tmp/meeting-eval/asr/cache/<hash>` of your run (it holds meeting text).
- After a cloud run: `rm -rf $SILVER_WORK/cloud/tmp`; confirm the Gemini Files API list is empty (`gemini_run.py` deletes each upload).
