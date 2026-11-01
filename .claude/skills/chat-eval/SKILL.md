---
name: chat-eval
description: Measure the Openstyle meeting chat agent with fixed answer keys on a fictional corpus - 190 gold questions, 147 retrieval queries, retrieval arms (dense V0, FTS5 BM25 hybrid H1/H2/H3, reranker R1), router arms on Gemma 4 E2B (LLM router A1, rules router A3, default slots A5, native tools T1) and the live-chat baseline A0. Logs to MLflow and reads every run back. Use when you must measure a change to retrieve(), the router, the tools or the chat answer, rerun the P0 numbers, or add a model or an arm.
---

# Chat eval (meeting chat agent)

Spec: `specs/meeting-chat-agent.md` (sections 7.4, 8, 9.1). Report: `specs/meeting-chat-agent-p0-report.md`. Code: `scripts/chat-eval/`. One command: `pnpm chat-eval <command>`.

## Hard rules

1. Fixed answer keys. No LLM judge decides pass or fail (spec 8.1). A key is a function in `keys.mts`.
2. The corpus is fictional and built by code from a seed (`corpus.mts`, `bank.mts`). No owner data enters the repo, a key, a log or MLflow.
3. The real stack runs in this process on a scratch profile in `/tmp/chatp0/run/<name>`: the server's own `getDb`, schema, `indexMeeting`, `retrieve` and the MLX workers. The owner's profile, the real DB and port 4649 are never used. Nothing is mocked.
4. GPU: `run.mts` takes `/tmp/openstyle-gpu.lock` itself (queue `/tmp/openstyle-gpu.queue`) for each command. Never take the lock by hand before it. A foreign holder can keep the lock for an hour: the run waits in the queue.
5. Temperature 0 on every model call (the Auto path, `AUTO_TEMPERATURE`), thinking off. Same input gives the same output, so one run per cell is a measure (spec 8.1 rule 5).
6. The MLflow URI comes from the environment only (`CHAT_EVAL_MLFLOW_URI`, else `LAB_MLFLOW_URI`, `SILVER_MLFLOW_URI`, `OKTO_NEURON_MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_URI`). Never write the address in the repo. The experiment is `openstyle-lab-chat-agent-p0`. A run counts only after `logRun` read it back (it throws on any lost value).
7. A new model or model family needs the parameter research of `AGENTS.md` ("model-parameter research rule") before its numbers count.

## Setup (once per worktree)

```bash
pnpm install --frozen-lockfile
pnpm turbo build --filter=@openstyle/server
# vec0.dylib and the diarizer files come from the main checkout (gitignored):
M=<main checkout>/apps/electron/resources
mkdir -p apps/electron/resources/bin apps/electron/resources/models
cp -R $M/bin/darwin-arm64 apps/electron/resources/bin/
cp -R $M/models/speaker-diarization $M/models/silero-vad apps/electron/resources/models/
export OPENSTYLE_MLX_LLM_WORKER=/tmp/meeting-eval/worker-<version>/mlx_asr_worker/mlx_asr_worker   # the shipped worker, also the embed worker
```

Models come from the eval HF cache (`~/Library/Application Support/Openstyle-eval/hf`, read only): `embeddinggemma-2` text tower and `gemma-4-E2B-it-qat-4bit`. Nothing is downloaded by the harness.

Extra, for the arms that need them:

| Arm | Needs |
|---|---|
| R1 reranker | Python 3.12 venv with `mlx-lm==0.32.2` (same pins as `scripts/build_mlx_asr_worker.sh`), the model `Qwen/Qwen3-Reranker-0.6B` (Apache-2.0) in `HF_HOME=/tmp/chatp0/hf-r1`. Env: `CHAT_EVAL_PYTHON` (default `/tmp/chatp0/venv/bin/python`), `CHAT_EVAL_RERANKER_HOME` (snapshot folder). Without the model the arm is skipped. |
| T1 native tools | The dev launcher `CHAT_EVAL_T1_WORKER` (default `/tmp/chatp0/worker-dev/run-worker.sh`): a script that execs the venv python on `scripts/mlx_asr_server.py "$@"`. The harness sets `OPENSTYLE_MLX_LLM_NATIVE_TOOLS=1` itself. The worker exits when its stdin closes: a launcher must keep stdin open. |

## Commands

| Command | What it does |
|---|---|
| `pnpm chat-eval corpus [--write]` | Builds the corpus and the gold set, prints the counts and the two hashes. `--write` saves `corpus.json` and `gold.json` in `~/.openstyle-eval/chat-p0/`. |
| `pnpm chat-eval retrieval [--scale N] [--no-mlflow]` | Loads the corpus into a scratch DB, embeds it with the real embed worker, builds the FTS5 tables, runs the 147 queries and prints the arm tables (recall@1/5/10, MRR, nDCG@10 per language and slice), latency, RSS, index size and the scope/date check. `--scale N` adds N-1 distractor corpora of other seeds (46,000 rows is N=256). |
| `pnpm chat-eval router [--no-mlflow]` | Stage 1 (two router prompts, rules router), stage 2b slot fill, end to end A1/A3/A5 on the shipped worker, then T1 on the dev worker with the flag. |
| `pnpm chat-eval a0 [--no-mlflow]` | The live chat code as it is (arm A0) on the questions with a text, count or not-found key. `CHAT_EVAL_MODEL` selects another catalog id. |
| `pnpm chat-eval:test` | Unit tests of the corpus, the keys, the FTS5 channels, the fusion, the slots and the rules router (no model). |

Results go to `~/.openstyle-eval/chat-p0/<command>-<time>.json` (per-query ranks, per-question rows). They hold fictional ids and numbers only.

## P1 eval (`pnpm chat-eval p1`)

Measures the P1 production code (the real `retrieve()`, `runChatTurn`, `createChatLlm`) on the P0 gold set. Nothing is mocked. The scratch profile is `/tmp/chatp0/run/p1`. The default model is Gemma 4 E2B (`local-mlx-llm/gemma-4-e2b-qat-4bit`). The settings `meeting_chat_enabled` and `chat_native_tools` are `true`, as in the app.

```bash
# once: a scratch HF cache with symlinks to the model folders (read only, never write into the eval cache)
mkdir -p /tmp/chatp1/hf/hub && cd /tmp/chatp1/hf/hub
E="$HOME/Library/Application Support/Openstyle-eval/hf/hub"
ln -sfn "$E/models--jayyun98--embeddinggemma-2-text-270m-mlx-bf16" .
ln -sfn "$E/models--mlx-community--gemma-4-E2B-it-qat-4bit" .
ln -sfn /tmp/chatp0/hf-r1/hub/models--Qwen--Qwen3-Reranker-0.6B .
# run: the dev launcher is the LLM, embed and rerank worker (it execs the venv python on scripts/mlx_asr_server.py)
export OPENSTYLE_EVAL_HF_HOME=/tmp/chatp1/hf
export OPENSTYLE_MLX_LLM_WORKER=<launcher script>      # keeps stdin open; the worker exits when stdin closes
pnpm chat-eval p1 [--no-mlflow] [--only a,b,c] [--limit N] [--scale N]
```

`OPENSTYLE_MLX_RERANK_WORKER` defaults to the same launcher. The command takes the GPU lock itself. The MLflow server comes from the environment (rule 6); the experiment is `openstyle-lab-chat-agent-p1`. The result JSON goes to `~/.openstyle-eval/chat-p1/p1-<time>.json` (saved after every part).

A remote chat LLM (llama.cpp, oMLX or any OpenAI-compatible server): set `CHAT_EVAL_BASE_URL` (server address, from the environment only), `CHAT_EVAL_MODEL` (the name `GET /v1/models` lists) and optionally `CHAT_EVAL_BACKEND` (MLflow tag `backend`, default `remote-openai`). The harness adds one row to the scratch `own_servers` table and sets `server/<id>/<model>` as the default LLM, so the app's own-server provider, the Auto sampling (temperature 0) and `enable_thinking: false` apply as in the app. Embed and rerank stay on the Mac workers, so the Mac GPU lock still applies. MLflow runs carry the tags `backend` and `model`. Latency of a remote GPU does not represent a Mac.

| Part (run `p1-<part>`) | What it measures |
|---|---|
| `retrieval` | 147 queries through the production `retrieve()`, k=10, arms dense, hybrid, hybrid + rerank 15, hybrid + rerank 30: recall@1/5/10, r@10 any, nDCG@10 per language and slice, warm p50/p95, reranker added time, embed and rerank worker RSS |
| `router` | `ROUTER_SYSTEM` + `ROUTER_SCHEMA` (step `chatRoute`) on the 190 gold questions and the 224 blind items: accuracy per set and language, confusion matrix, p50/p95 |
| `slots` | `slotZod` + `slotSystem` (step `chatSlots`) with the gold intent; dates by code (`datesFromQuestion`); accuracy per intent and per arg key. `p1-score.mts` maps corpus ids to production ids |
| `e2e` | `runChatTurn` on the 190 questions, fresh `createChatLlm` per turn, `allowProposals`, history = gold answers. Answer accuracy per type, list F1, cite precision and recall, cite validity (checked against the DB), not-found accuracy, false not-found, tool choice, tool + args, write proposals, router share, native call outcome, calls, latency, RSS, sources dropped, direct writes (data hash before and after) |
| `a0` | Compares the A0 question ids of the saved `a0-*.json` with the gold set. Same ids: the A0 numbers apply. Else run `pnpm chat-eval a0` in its own process |
| `scale` | Only with `--scale N` (or `--only scale`, N=256): retrieve latency at N times the corpus. Slow. It adds the distractor corpora to the same DB, so it runs last |
| `bars` | The table of pass bars from the runs of the same invocation. A part that did not run shows NOT RUN |

`--limit N` takes N items spread over each set (a smoke test). Do not log a smoke run to MLflow (`--no-mlflow`).

### Fast loop on the desktop (P1.1, 2026-10-31)

Heavy GPU work goes to the desktop llama.cpp server (owner rule). One run of `router,slots,e2e,a0,bars` takes about 3 minutes with E4B (the retrieval part is the slow one: skip it when `retrieve()` did not change).

```bash
export OPENSTYLE_EVAL_HF_HOME=/tmp/chatp1/hf OPENSTYLE_MLX_LLM_WORKER=<launcher script>
export CHAT_EVAL_BASE_URL=<desktop address>/v1 CHAT_EVAL_MODEL=gemma4-e4b CHAT_EVAL_BACKEND=desktop-llamacpp   # gemma4-e2b also exists
pnpm chat-eval p1 --only router,slots,e2e,a0,bars                    # gold
pnpm chat-eval p1 --only router,slots,e2e,a0,bars --seed 20271105    # held-out corpus
CHAT_EVAL_IDS=q008,q130 pnpm chat-eval p1 --only e2e --no-mlflow     # single questions
```

- The launcher must point at the `scripts/mlx_asr_server.py` of your own worktree (the launcher of an old worktree breaks when that worktree is removed).
- The desktop model is not fully repeatable: the same code gave 31 to 33 of 35 on lookup + follow-up in three runs. Compare two runs question by question (the result JSON `parts.e2e.data.rows`), not by one number.
- Do not wait on a run with `pgrep -f "chat-eval p1"` inside a command that holds that text: the wait matches itself and never ends. Wait for the result file or use `pgrep -f "[c]hat-eval p1"`.
- `pnpm exec biome` can die with "Linter process terminated abnormally" under the output filter. Use `rtk proxy ./node_modules/.bin/biome check --write <paths>`.
- `rerank` accepts at most 64 documents per call (`_RERANK_MAX_DOCS` in `scripts/mlx_asr_server.py`). A longer list is a 400.

### What P1.1 changed and measured (issue #402)

| Change | Effect on E4B (desktop, gold) |
|---|---|
| Segment pick by the reranker when the question shares no word with the chunk (`rankPieces` in `tools.ts`) | The big one. A PT question on EN meetings picked the first segment, so the snippet (640 characters) and the cite start missed the fact. Lookup + follow-up 31 to 32 of 35, cite precision 0.810 to 0.869 |
| Follow-up query from the earlier question + earlier answer (`followUpQuery`) | q147, q149 fixed; slots 87.5 to 100 (the slot scorer now builds the query like the pipeline) |
| Review kind by code (`reviewKind`) | 3 slot misses fixed, one model call less |
| `refineIntent` (date with a number, "when", who words) | Route gold 85.3 to 94.2, blind set 96.0 unchanged |
| Cheap route (no router and no slot call for a plain question) and no native turn for a plain follow-up | Mac route + slots p95 814 to 561 ms (E4B) |
| Cite start by the reranker (`pickCiteTimes`) | Cite precision 0.849 to 0.884 (gold), 0.795 to 0.841 (held-out) on the desktop |
| Cross-language query rewrite on a weak first search | q103 fixed. q018 stays: the model writes "standard topic" for "tema padrão" |
| Count of mentions by SQL (`countMentions`) | q070 to q072 fixed |
| Question text as the search query (instead of the model words) | Removed. It raised the best score of unanswerable questions on E2B (0.06 to 0.56) and broke the not-found floor |
| Empty-answer retry at a top score of 0.9 | Removed. It fixed nothing after the segment pick, and it broke q130 (not answerable, top score 0.98) in two variants |

The bars (`BARS` in `p1-score.mts`; thresholds are never changed in code):

| Bar | Threshold | Source |
|---|---|---|
| Retrieval nDCG@10, hybrid + rerank 15 | >= 0.65 | report 7 |
| Recall@10 any evidence, hybrid + rerank 15 | >= 85% | report 7 |
| Recall@10 numbers and names slices (rerank 15, rerank 30) | >= 85% each | report 7 |
| Hybrid latency p95 warm, no reranker, 46,000 rows | <= 150 ms | report 7 |
| Reranker added time p95 (15, 30) | <= 400 ms | report 7, decision 3 |
| Reranker worker RAM | <= 1.5 GB | report 7 |
| Route accuracy, blind set / gold set | >= 90% / >= 85% | report 7 |
| Slot accuracy with the gold intent, dates by code | >= 90% | report 7 |
| Tool and args together (190) | >= 85% | report 7 |
| Write proposal (kind and id set, 25) | >= 90% | report 7 |
| Route latency p95 (router + slots) | <= 700 ms | report 7 |
| Answer accuracy lookup + follow-up: 22 A0 questions / 25 + 10 | >= 74% / >= 85% | report 7 |
| Cite validity / invalid cite shown | 100% / 0 | spec 8.7 |
| Not-found accuracy / false not-found | >= 90% / <= 15% | spec 8.7 |
| List F1 (aggregation) | >= 0.85 | spec 8.7 |
| Cite precision (cite `start_ms` inside the gold segment) | >= 0.8 | spec 8.7 |
| Route accuracy on the gold set (spec 8.7 wording) | >= 90% | spec 8.7 |
| Turn latency p95, warm | <= 6 s | spec 8.7 |
| Direct writes by the model | 0 | spec 8.7 |
| Who-said accuracy | reported | spec 8.7 |

Scoring rules that are not obvious:
- A status block has only counts. Its answer passes when `open_actions` equals the size of the gold set (the only fact it shows). The report names this.
- `list_meetings` gives no list block. A meeting-set answer reads the meeting ids of the shown cites.
- A group of equal action items, decisions or questions counts as the gold id when any member is a gold id (the production code groups them).
- Cite precision has three variants: `start` (the bar: `start_ms` of the cite inside the gold segment), `range` (the chunk span of the cite meets the gold segment), `meeting`. A chunk cite starts before its segment, so `start` is strict.
- Cite validity does not trust the cite object: a label in a block must have a cite, the meeting must exist, a `start_ms` must be the start of a real segment or chunk, an item cite must name a known item, a list item label must have a cite.

## Definitions

- recall@k: a transcript chunk that holds the gold segment is in the top k (grade 2). "r@10 any" also counts a summary chunk of the gold meeting that holds the value (grade 1). nDCG@10 uses the gains 2 and 1.
- Slices: names, numbers, concept (a paraphrase with none of the words of the line), asr_names (the line has the ASR spelling, the query the right one), date (a date range in `retrieve()`).
- Router stage 1: intent equals the gold intent. Tool choice: the first tool of the plan (or the first native call) is in the gold plan; for a write question it is the right propose tool. Args: every gold arg matches (`slots.mts` `scoreSlots`).

## Add an arm or a model

1. Retrieval arm: add an `ArmSpec` in `retrieval.mts`; a new channel needs a list in `QueryPass`.
2. Router arm: add the stage in `router-run.mts`; keep the scorer in `slots.mts`.
3. New question type: add it to `gold.mts` with a key that code can score, and a test in `corpus.test.mts` that the corpus supports the key. Change the seed or a bank string only with a new corpus hash: runs with another hash do not compare.
4. Run `pnpm chat-eval:test`, then the command with MLflow on, and check the `READ BACK OK` line.

## Cleanup

`rm -rf /tmp/chatp0/run` (scratch DBs, FTS files). Keep `~/.openstyle-eval/chat-p0/` and the MLflow runs: they are the ledger. The reranker model folder `/tmp/chatp0/hf-r1` is a download: delete it when you do not need arm R1.
