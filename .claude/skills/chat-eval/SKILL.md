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

A cloud chat LLM of the app (2026-11-03): set `CHAT_EVAL_CLOUD_PROVIDER=anthropic` (or another key provider), `CHAT_EVAL_MODEL=claude-opus-5-5` and `CHAT_EVAL_CLOUD_API_KEY` (environment only). The harness writes the key into the `api_keys` table of the scratch DB (where the app's `getApiKey()` reads it) and sets `<provider>/<model>` as the default LLM, so `createChatModel`, the Auto sampling and the provider options apply as in the app. The key is never printed or logged to MLflow; delete `/tmp/chatp0/run` after the run (the scratch DB holds the key). Set `CHAT_EVAL_BACKEND=cloud-opus` for the MLflow tag. Never put the key in a file of the repo. Cloud calls cost money: smoke-test with `CHAT_EVAL_IDS`.

Cost fields (2026-11-03): every `dig` and `e2e` row has `tokens {in, out, cached, cacheWrite, reasoning}` and `usd`. Code: `cost.mts`. The tokens are the sum of `llm_calls` of the run id of the turn (all calls, retries and workers too). `in` holds every input token, cached ones included. USD = plain input x input price + cached x cache-read price + cache write x cache-write price + out x output price, with the prices of `cloud-models.ts` (`cloudLlmPrices`; Anthropic cache prices from https://platform.claude.com/docs/en/about-claude/pricing). A local model or an own server costs 0. The summary line prints `Tokens in/out/cached/cache write; USD total, per digging turn`. MLflow gets `tokens_in`, `tokens_out`, `tokens_cached`, `tokens_cache_write`, `tokens_reasoning`, `usd_total`, `usd_per_turn`. Checked on 2026-11-03: one Opus turn, row tokens (10422 in, 1012 out, 6 calls) equal the sum of the raw API `usage` fields, USD 0.0619 by hand.

Dig rows also hold `evidence {sha, calls[], answerPrompt}`: the call records of the turn (node, step, tokens, latency, the parsed record of each `chatDig` worker) and the messages of the last answer call (the sources that reached it). It sorts a failure into: retrieval miss, evidence present but not used, shape cap, scorer.

| Part (run `p1-<part>`) | What it measures |
|---|---|
| `retrieval` | 147 queries through the production `retrieve()`, k=10, arms dense, hybrid, hybrid + rerank 15, hybrid + rerank 30: recall@1/5/10, r@10 any, nDCG@10 per language and slice, warm p50/p95, reranker added time, embed and rerank worker RSS |
| `router` | `ROUTER_SYSTEM` + `ROUTER_SCHEMA` (step `chatRoute`) on the 190 gold questions and the 224 blind items: accuracy per set and language, confusion matrix, p50/p95 |
| `slots` | `slotZod` + `slotSystem` (step `chatSlots`) with the gold intent; dates by code (`datesFromQuestion`); accuracy per intent and per arg key. `p1-score.mts` maps corpus ids to production ids |
| `e2e` | `runChatTurn` on the 190 questions, fresh `createChatLlm` per turn, `allowProposals`, history = gold answers. Answer accuracy per type, list F1, cite precision and recall, cite validity (checked against the DB), not-found accuracy, false not-found, tool choice, tool + args, write proposals, router share, native call outcome, calls, latency, RSS, sources dropped, direct writes (data hash before and after) |
| `a0` | Compares the A0 question ids of the saved `a0-*.json` with the gold set. Same ids: the A0 numbers apply. Else run `pnpm chat-eval a0` in its own process |
| `clarify` | Only with `--only clarify`. The clarify block (D20) and the map-reduce synthesis. See the section "Clarify and map-reduce" below. Needs the model for the chip follow-ups and the map-reduce items |
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

### The P2 set (chat agent P2, `--set p2`)

Spec 11.6.6. `pnpm chat-eval p1 --set p2 --only router,e2e,threads,widen,bars` runs the P2 set instead of the 190 gold questions. The gold hash stays `1e41bd5cea578222` (a test pins it). `buildP2` in `gold.mts` builds the set from the same corpus; its ids are `p2-001` and up.

| Part of the set | What it is |
|---|---|
| Questions (53) | Lookups at A (12) and F (9), who said at A (8) and F (8), open action items of a person at A (4), meetings of a month at A (6) and F (6). They run through the `e2e` part, so every P1 metric (cite validity, cite precision, list F1, who-said, latency) is reported for the set. A bar with no question of its kind shows NOT RUN, not FAIL. |
| `widen` (24 cases) | The question is asked at the first scope. It must be not found, and the block must offer the next scope (`wider`, by id). Then the question is asked at the next scope, like a click on the button. M to F (8), M to F to A (6), F to A (6), unfiled M to A (4). Rows show offer, chain, answer. Bars: offer at the first scope at least 90%, final answer at least 70%. |
| `threads` (10) | 6 threads at A and 4 at F: a fact, "why?", who said it, a switch to another fact. Real answers go back as history. |

Run it on the desktop first (`CHAT_EVAL_BASE_URL`), then confirm on the Mac with the GPU lock. The default parts of `--set p2` include `widen`; `--only widen` runs it on the gold set too.

### Clarify and map-reduce (`--only clarify`, D20)

`pnpm chat-eval p1 --only clarify,bars [--no-mlflow]` (not in the default parts; run it last, not with `scale`). Code: `p1-clarify.mts` (items, keys, runners), `clarify-corpus.mts` (extra data), `partClarify` in `p1-run.mts`. MLflow run `p1-clarify` in `openstyle-lab-chat-agent-p1`. The base corpus and both hashes stay the same: the extra data is loaded into the scratch DB on top of the base corpus, inside this part only.

Extra fictional data (built by code, no random numbers, ids with the prefix `cl-`):
- Folders "Harbor Mobile" and "Harbor Web" (4 meetings each, with summaries). The base corpus has "Harbor Pricing", so "Harbor" names three folders.
- "Marta Reis" (speaks only in Harbor Mobile and Long Program) and "Marta Lacerda" (only in Harbor Web). The base corpus already has Ana Silvestre / Ana Brandt and Carlos Medeiros / Carlos Okafor.
- Folder "Long Program": 72 meetings, 2 days apart. Each summary holds a cost (5 digits), a supplier name and, for every third meeting, a tester count. All tokens are unique. The first 24 meetings are "early", the last 24 are "late".

Clarify items (27; `CHAT_EVAL_IDS=cl01,nc04` picks single items). Key = function, no judge:
- 10 should-ask items: scope ("What is the latest on Harbor?", PT too), intent ("status?", "what about it?", "tell me more" at Everything, no history), person ("What did Marta/Ana/Carlos say ...").
- 17 should-not-ask items: full folder name, full person name, a fixed-scope question where one person fits, a vague question at a fixed scope, a vague question with an earlier question in the thread, specific questions, and a second question after a clarify block.
- The first block of the turn must be `clarify` with the right `why` (should-ask) or must not be `clarify`. The detector is code and the pipeline returns before any model call, so the first turn needs no model. When the detector fires, the real `runChatTurn` is run too.
- Chips: every `option.ask` is sent as the next turn with the clarify block in the history. It must not return `clarify` again. For items with `chips: "all"` it must not be `not_found` either.
- Metrics: precision, recall (per `why`), false-clarify rate (false clarify of the should-not items), right `why`, chips ok.

False-clarify rate on the existing questions: the detector alone (no model) over the 190 gold questions, the 42 broad turns and the 90 thread turns, with scope and history. It prints the count and up to 10 samples for the base corpus and again with the extra data. Measured on 2026-11-02 (no model): gold 1 of 190 (the write question "Una Ana S. e Anna Silvestri em uma só pessoa." at Everything, a person clarify on a first name), broad 0 of 42, threads 0 of 90.

Map-reduce items (3, scope = folder Long Program): "Give me the story of Long Program.", "What were the key decisions across the program?", "Catch me up on the whole program from the first review.". An item passes when the trace has a `map_reduce` step, no invalid cite (`checkCites`), no text block without a cite, no `not_found`, and the answer names at least one fact of an early meeting and one of a late meeting. Reported: coverage of all facts and of the early and late thirds, the share of answers with the `map_reduce` step, and `sources_dropped` per answer (a map-reduce that works drops none of the digest). There is no switch to turn map-reduce off: compare with the `sources_dropped` number of an older commit.

No new bars: thresholds are the owner's to set (`BARS` stays as it is).

### Broad questions (Ask synthesis, `--only broad`)

`pnpm chat-eval p1 --only broad,bars [--no-mlflow]` runs 29 broad threads (42 turns) from `buildBroad` in `p1-broad.mts`: meeting, folder and Everything scopes, EN and PT, and 8 threads with an elaboration follow-up ("gimme details", "Tell me more", "How did it start?"). It is not in the default parts and not in the gold hash. Keys are made by code from the fictional summaries and facts. A turn passes when:

- **Coverage:** a first answer names at least 50% (meeting) or 40% (folder, Everything) of its must-mention facts (key points, decisions, one fact per meeting).
- **Cites:** no invalid cite and no text block without a cite (`checkCites`).
- **Repeat:** the answer is not a repeat of an earlier answer in the thread (whole text 0.8, or more than half of the sentences at 0.6).
- **Length:** 2 to 9 text blocks and 100 to 1800 characters (an elaboration: 1 to 9 blocks, 40 characters up).
- **Elaboration:** gives an answer. After the second answer `nothing_new` is also right.

`CHAT_EVAL_IDS=b01,b09` picks single threads. The rows hold the pipeline steps (`trace`) for debugging. Bars: `broad.*` in `BARS` (coverage 50%, invalid cites 0, repeats 0, length 90%, not found 10%, elaboration with content 70%).

### Digging questions (Ask research mode D21, `--only dig`)

`pnpm chat-eval p1 --only dig [--no-mlflow]` runs 32 questions (48 turns, spec 11.9.12) on extra fictional data (`dig-corpus.mts`: 3 projects, 13 meetings, ids `dg-*`, loaded on top of the base corpus inside this part). It is not in the default parts and not in the gold hash. Code: `p1-dig.mts` (questions, keys, scoring), `dig.test.mts` (the keys are backed by the data), `partDig` in `p1-run.mts`. MLflow run `p1-dig`.

- Questions: "what are the open items" then "why are they still open?", "what blocked X?", "how did decision Y evolve?", "who pushed for Z and why?", "what changed between the first and the last meeting?", "is anything still unresolved about W?". EN and PT, meeting, folder and Everything scope. 4 controls ask a simple fact and must stay cheap.
- A turn passes when: coverage of the must-mention reasons is at least `minCov`, the answer cites at least half of the meetings that hold a reason, 0 invalid cites, no repeat, length in range, not `not_found`, not `clarify`, and no done item in a list of open items. The row also holds LLM calls, tool calls and latency.
- Headline numbers use the digging turns (not the `fact` setup turns and not the controls). `CHAT_EVAL_IDS=dg01,dg07` picks single questions.
- A key is wrong when the data does not back it: run `pnpm chat-eval:test` after any change of the data or the keys.
- Baseline of 2026-11-02 (spec 11.9.13): digging pass 22.9% on Mac E2B and E4B, 25.7% on desktop E4B; not found 40.0% / 31.4% / 28.6%.
- The bars of spec 11.9.14 (D1 to D17) are in `digBars(tier)` of `p1-score.mts`; the `bars` part shows them as `dig.*`. The tier comes from the model: 2 for E2B (the floor), 4 for E4B and above. The tier sets D1, D2, D8 and the control tool calls and latency. D18 (no regression) is the other parts of the same invocation.
- Research mode is ON in the scratch profile, as in the app. `CHAT_EVAL_RESEARCH=off` writes `chat_research=false`: the old fast path, for the row-by-row diff against main (0 changed rows on e2e, threads, widen, broad, clarify). `CHAT_EVAL_REFLECT=off` runs the loop with no reflect call (code order of the strategies; the "reflect off" arm of 11.9.15).
- The dig part also reports `trigger_recall` (digging turns that ran the loop), `trigger_false_gold` and `trigger_false_broad` (code only, no model: the 190 gold questions and the 42 broad turns), `trigger_false_controls`, `ckpt_ms_p95` (checkpoint write time, D17) and `lang_gap` (D9).
- The 4 controls (`dg29` to `dg32`) share the GPU with the other questions when the part runs with 2 threads, so their p95 is noisy. For D12 run them alone: `CHAT_EVAL_IDS=dg29,dg30,dg31,dg32 CHAT_EVAL_THREADS_PAR=1 pnpm chat-eval p1 --no-mlflow --only dig` on this commit and on main, and compare.
- The desktop llama.cpp server is shared and swaps models: a dig run there can spend minutes in one call (the turn deadline is 240 s in the harness). Use it for a first look; use the Mac for numbers.
- The desktop llama.cpp server can need minutes to swap a model: a first request that waits for a long time is a swap, not a hang. Ping it with one small request before a run.
- `pnpm chat-eval real --db <copy.db> --dig` runs 6 generic digging questions on the 3 folders with the most meetings (named A, B, C in the output). It stops when the chat model is not the local MLX model.

### The blind dig sets (`CHAT_EVAL_DIG_SET=heldout|dev|final`, 2026-11-02, spec 11.9.17)

`CHAT_EVAL_DIG_SET=<name> pnpm chat-eval p1 --only dig` runs 30 questions (about 35 turns, 4 controls) on a second fictional corpus (3 projects, 13 meetings, 8 people). Code: `dig-heldout.mts` (loader and `DIG_SETS`), the data and keys in `dig-heldout.json`, `dig-dev.json`, `dig-final.json`, tests in `dig.test.mts` (every key is in the data). MLflow run `p1-dig-<name>`, tag `chat.arm` = `dig-<name>`. Ids: `hd-*` / `hd01` (heldout), `hv-*` / `hv01` (dev), `hf-*` / `hf01` (final).

- Each set was written by a separate Claude subagent that had NOT seen the research code, the prompts or the other sets. The brief is only the data format and the question kinds (list, why, blocker, evolve, pushed, changed, unresolved). Half of the digging questions use plain words ("what is holding up X", "who wanted Y") on purpose.
- **heldout** was read for fixes on 2026-11-02 (trigger words, worker checks), so it counts as a dev set. **dev** may be read and used for decisions. **final** is read only for the last measure: never print its rows or answers, never tune on it. Report headline numbers from `final`.
- When a set has been read for fixes, write a new one the same way (same brief: `/tmp/chatp1/brief.txt` is the template; no repo access for the subagent).
- 2026-11-02 baseline of main `e6641d0b` (E2B / E4B): original 77.1 / 82.9%, heldout 25.9 / 29.6%, dev 22.6 / 32.3%, final 16.7 / 10.0%. The original set is overfit: #412 was tuned on it.
- To run `main` and a branch side by side use two worktrees (`git worktree add --detach ../x <sha>`, copy `apps/electron/resources/{bin,models}`, own launcher script). Edit the branch while the other one runs. A running `pnpm chat-eval` loads the source at start: never edit `apps/server/src` while a matrix runs on that worktree.

### The tool loop engine (D22, `CHAT_EVAL_ENGINE=loop`, 2026-11-03)

The product code path `apps/server/src/lib/chat/loop/` (spec 11.10, PR 416). `CHAT_EVAL_ENGINE=loop` writes the setting `chat_engine=loop` into the scratch profile, so EVERY part (gold, held-out, threads, broad, clarify, p2, dig) runs the loop. The default is `pipeline` (as in the app). MLflow tag `engine`. Old arms `CHAT_EVAL_DIG_ARM=loop` and `loop-ledger` and the files `loop.mts` and `ledger.mts` are gone: the product code replaced them.

- The first call, the step cap and the result size come from the model profile in code (`loop/profile.ts`). The eval can override: `CHAT_EVAL_LOOP_FIRST=search|list_meetings|auto` (tag `first_call`) and `CHAT_EVAL_LOOP_LEDGER=off`.
- The item ledger exists only for a cloud model. The dig part builds it with `backfillLedger` (the product writer, the model under test) before the questions, and logs `ledger_*` metrics.
- Per-run wrappers live in the session scratchpad, not in the repo. Keys come from a read-only copy of the app DB, in the environment only.

### The dig ladder (cloud model, `CHAT_EVAL_LEVEL`, 2026-11-03)

Measures where a big model loses on the dig turns. Run on the DEV set only (`CHAT_EVAL_DIG_SET=dev`), never on `final`. Set `CHAT_EVAL_LEVEL=L0..L3` (MLflow tags `level` and `arm`).

| Level | Env | What changes |
|---|---|---|
| L0 | none | today's harness |
| L1 | `CHAT_EVAL_CAPS=wide` | `caps.ts` WIDE caps: hit text 2000, worker sources 12 x 1500, source budget 30000, 12 bullets, answer tokens 2000 (3000 synth), score floor 0.3, 12 item workers, 16 meeting workers. Only for a non-local model |
| L2 | `CHAT_EVAL_DIG_ARM=oracle-harness` | no retrieval: every summary and transcript window of the scope is a source; today's answer step and cite check stay |
| L3 | `CHAT_EVAL_DIG_ARM=oracle-plain` | one call with all sources and a plain prompt; no cite check |

Code: `dig-oracle.mts`, `caps.ts` (server). The pass rule has a length gate (scorer v3: digging turns 1 to 15 text blocks, 60 to 3000 characters; fact and control turns up to 500). Scorer v3 also treats a colon as a word break and ignores a mustNot word inside an "Already done:" part (`withoutDoneParts` in `p1-dig.mts`); `pnpm chat-eval rescore` scores the saved answers again with it and tags the run `scorer=v3`. L1 writes up to 12 bullets, so the gate fails some of its turns: read `len_ok` next to `pass`. Opus 5.5 takes no temperature, so a rerun differs (L0 gave 21 of 31 and 22 of 31 on the same code line).

### Re-score (`pnpm chat-eval rescore [--no-mlflow] <result.json...>`)

Scores the saved dig answers again with the fixed rule: the blind keys write 2 of 3 as `minCov` 0.67 and 2/3 is less than 0.67, so the loader (`dig-heldout.mts`) now maps it to `TWO_THIRDS`, as the original set does. Keys and answers do not change. The command prints one line for each file (old pass, new pass, changed turns, `old-rule drift` = rows where the old rule does not give the stored pass, must be 0) and logs `<run name>-rescore` with the tag `rescore_of=<original run id>`. For the `final` set it prints the summary line only, no turn ids.

### Research workers (spec 11.9.17)

The graph has an orchestrator-worker fan-out (`Send`) in `research/graph.ts`, workers in `research/workers.ts`. The research mode starts by code (the words of #412) or when the model picks the pseudo tool `dig_deeper` in the native tool call (`choices.ts`, no extra model call; only with `chat_research` on and `chat_native_tools` on). Then:

- "Why are these open?" after a list: one `item` worker for each of the top 4 items (5 on cloud), ranked by the words of the thread, then by how often the list raised the item. Each worker searches, makes ONE `chatDig` call (schema `chat_dig_item`: up to 3 reasons, each with a source label and a quote) and code checks it (`supported`, `aboutItem` in `workers.ts`). Code composes one bullet for each item, with the reason and its own cite, or "no reason found" (`composeReasons`). No answer call.
- Any other research question: `scout` searches, then one `meeting` worker for each of the best 6 meetings (8 on cloud; the rest of a small scope fills the list). A worker returns who, what, why with a checked quote. The answer call then reads the verified excerpts first, then the summaries of the first and the last meeting, then the other sources.
- At most 2 workers run at once on a local model (`maxConcurrency`). Worker calls count in the 16-call cap; `ANSWER_RESERVE` keeps room for the answer.
- Trace steps: `research:worker:item:reason|none`, `research:worker:meeting:record|none`, `research:join:items|meetings`, `route:native:dig_deeper`.

The open-items list is capped (8 actions + 4 questions, ranked by how many meetings raised an item, then recency, grouped by meeting) unless the turn has `show_all` ("Show all" button). The list block keeps the full `total`; the UI shows "N more items not shown".

Eval metrics: `research.share` of the e2e part (gold questions that ran research: 5 of 190 on E2B, 3 of them the old code false triggers), trace steps above, `CHAT_EVAL_RESEARCH=off` for the old path.

### Real threads (private, `pnpm chat-eval real`)

`pnpm chat-eval real --db <copy.db> --threads <id prefix>,<id prefix> --label after` copies a read-only copy of the owner's DB to `/tmp/chatp0/run/real`, replays the QUESTIONS of the threads through the real pipeline with the default model of that DB (new answers go back as history), deletes the scratch copy, and prints numbers only (sentences, cites, repeat, not found). The answer texts go only to `~/Library/Application Support/Openstyle-eval/chat-real/<label>-<time>.json` (before and after; "before" is what the DB stores). Never commit those texts, never log them to MLflow. Needs the GPU lock and the worker env of the P1 section. `--extra "q1|q2"` adds new questions at scope Everything (D20): the first turn, then the first chip, then the same question with `no_clarify`; the output has a `clarify=` column. A second copy of the DB with the setting `chat_clarify` = `false` gives the answers without a clarify question (the "before" of those questions).

### Multi-turn threads (P1.2, `--only threads`)

`pnpm chat-eval p1 --only threads --no-mlflow` runs 12 threads (`buildThreads` in `gold.mts`, `p1-threads.mts`) of 4 to 5 turns in one fictional meeting: a fact, "why?", "who said that?", a topic switch and "what was this meeting about?". The REAL answer of each turn is the history of the next turn (the gold set uses gold answers). The threads are not in the gold set, so the gold hash is unchanged. Keys: text keys for fact, switch, speaker and topic (the topic key accepts English and Portuguese words). "Why?" has no key (the corpus has no reasons): it passes when it is not a repeat. A repeat is an answer with a word overlap (Jaccard) of 0.8 or more with an earlier answer to another question. The row table lists tool, cites and answer for each turn. Use it to see a follow-up that searches with a stale query.

Tips: run it with at most 4 threads at once (built in). The desktop llama.cpp server can stall for minutes when another job holds it: a first-turn fact with an empty answer and no tool call is a deadline, not a bug. Run the part again before you trust the numbers.

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
