# Technical Spec: Built-in Local MLX LLM

**Status:** In progress (PR feat/local-mlx-llm).
**Date:** 2026-10-20
**Scope:** `scripts/mlx_asr_server.py` and its build, `apps/server/src/lib/mlx-llm/` (new), `apps/server/src/lib/llm/*`, `apps/server/src/routes/mlx-llm.ts` (new), `packages/validations`, and the Models page in `apps/electron/src/renderer/src/pages/models`.
**Baseline:** `main` at `ec672607`.
**Research:** `.scratchpad/reports/Bundled local LLM runtime.md` (probes X2, X2b, X2c, X2d) and the 2026-10-19 session maps. Every claim below cites its source there or in code.

Writing rules: Simplified Technical English. One instruction per sentence. No em-dashes.

---

## 1. Problem and decisions

Today every LLM call (dictation cleanup, Meeting Enhance, Summarize) needs a cloud key or an own server (oMLX, LM Studio). The source picker says "Openstyle has no built-in LLM" (`source-picker.tsx:43-46`). A normal user cannot run a capable LLM with zero setup.

### Decisions (owner, 2026-10-19/20)

1. MLX only, Apple silicon only. Same shape as the built-in local MLX speech models.
2. Transport: the worker serves an OpenAI-style HTTP API on `127.0.0.1` (a "shim"). The server talks to it with the AI SDK OpenAI provider, as for an own server. This keeps `json_schema_strict`, the trace log and the LLM inspector.
3. Bundle: the SAME `mlx_asr_worker` archive gets `mlx-lm` and `llguidance`. The server starts it a second time in LLM mode, as a second process. Probe X2b: works frozen, +6.3 MB. Probe X2c: two processes keep dictation at 0.18 s; one process gives 34-37 s.
4. Catalog v1 (curated only, no custom LLM models; owner-approved 2026-10-20). Owner decision 2026-10-20 18:20: the catalog holds only the two Gemma 4 models, and E2B is the recommended model. The three Qwen3.5 models (`qwen3.5-0.8b-8bit`, `qwen3.5-4b-optiq-4bit`, `qwen3.5-9b-6bit`) are removed. The download fetches only the files that mlx-lm loads (§3.2). "Disk" is the sum of those files in the HF API tree of the repo.

| Id | HF repo | Disk (bytes, filtered) | Family | Why this repo |
|---|---|---|---|---|
| `gemma-4-e2b-qat-4bit` (recommended) | `mlx-community/gemma-4-E2B-it-qat-4bit` | 4,361,680,121 | gemma4 | QAT: Google states "similar quality to bf16". |
| `gemma-4-e4b-qat-4bit` | `mlx-community/gemma-4-E4B-it-qat-4bit` | 6,830,817,013 | gemma4 | QAT: Google states "similar quality to bf16". |

Rejected: the Jundot oQ4e repos (an MTP weight file breaks the strict mlx-lm load, and the repo has no license). The Gemma `qat-mobile` repos (`quant_method: gemma` is not supported in mlx-lm 0.32.2).

5. Pins: `mlx==0.32.3`, `mlx-metal==0.32.3`, `mlx-audio==0.5.7`, `mlx-lm==0.32.2`, `llguidance==1.9.1`, `transformers>=5.14`, `huggingface_hub==1.33.0`. A `uv pip compile` resolves with no conflict. mlx-lm 0.31.x crashes at import with transformers 5.14 or later (mlx-lm#1458, fixed in 0.32.0). Do not add mlx-vlm (needs mlx>=0.32.4).

### Goals

- G1. A user can download, select, use and delete each catalog model from the Models page, with the same rows, progress and buttons as a local MLX voice model.
- G2. Dictation cleanup, Meeting Enhance and Summarize run on the local model with strict JSON (llguidance).
- G3. Dictation speed does not change while the LLM runs (separate process, LLM lane yields to dictation).
- G4. The app never sends a request to a model that is not on disk. Failures are typed errors, never a hang.

### Non-goals (v1)

- Custom LLM models, RAM tier auto-pick, onboarding changes, Apple Foundation Models, llama-server.
- Models above 9B. The 26B/27B models stay on own servers.

---

## 2. Worker (`scripts/mlx_asr_server.py`, LLM mode)

### 2.1 Start

`mlx_asr_worker --llm --model <hfId> --port <port>` (or the dev script with the same flags).

- Load with `mlx_lm.load(<hfId>)`, offline (`HF_HUB_OFFLINE=1` from the server).
- Bind `127.0.0.1:<port>` only. The server picks a free port.
- Print one JSON line `{"type":"ready","model":"<hfId>","port":<port>}` on stdout after load. Errors before ready: `{"type":"error","error":"<msg>"}` and exit 1.
- Keep `multiprocessing.freeze_support()` first. Log on stderr.
- Stop on SIGTERM. Also stop when stdin closes (the parent died).

### 2.2 HTTP API (stdlib `http.server`, one request at a time)

- `GET /v1/models` returns `{"object":"list","data":[{"id":"<hfId>","object":"model"}]}`.
- `POST /v1/chat/completions` takes the OpenAI fields the gateway sends: `model`, `messages`, `max_tokens`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `stop`, `response_format` (`json_schema` with `schema`, or `json_object`), `chat_template_kwargs` (`enable_thinking`). Ignore unknown fields. `stream: true` returns 400 (the gateway sends `stream: false`).
- Prompt: `tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=<kwarg, default False>)`.
- Structured output: build the grammar with `llguidance.LLMatcher.grammar_from_json_schema(schema, defaults={"whitespace_flexible": True})`. Apply it as an mlx-lm logits processor with `llguidance.mlx.apply_token_bitmask` (probe X2 harness, `.scratchpad/probe-x2/harness.py:31-59`). Keep `whitespace_flexible: True`: compact whitespace broke the output in probe X2.
- Thinking: send `enable_thinking=False` by default. If the template still emits an empty thinking block, start the grammar after the block ends (Gemma: after `<channel|>`; Qwen: after `</think>`).
- Stop tokens: the tokenizer EOS plus all ids in `generation_config.json` `eos_token_id` (Gemma 4: 1, 106, 50), plus `<|im_end|>` for Qwen.
- Response: OpenAI shape with `id`, `model` = `<hfId>`, `choices[0].message.content`, `choices[0].finish_reason` = `stop` or `length`, and `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`).
- Errors: 400 `{"error":{"message","type":"invalid_request_error"}}` for a bad request; 500 for a generation error.

### 2.3 Build

`build_mlx_asr_worker.sh` adds `mlx-lm==0.32.2` and `llguidance==1.9.1`, and `--collect-all mlx_lm --collect-all llguidance` (probe X2b). `MLX_WORKER_BUILD_SPEC` (`runtime.ts:47`) gets the two pins. The drift test (`mlx-runtime.test.ts:622`) checks them. The worker version hash changes, so installed apps download the new archive.

---

## 3. Server (`apps/server/src/lib/mlx-llm/`)

### 3.1 Catalog

`constants.ts`: `MLX_LLM_MODELS` with `{id, hfId, family, sizeBytes, contextTokens, maxOutputTokens, recommended?}` for the 5 models of §1. Provider id `local-mlx-llm` (no other provider id starts with it; `registry.ts:450` uses a prefix match).

### 3.2 Downloads and status

Reuse the speech model code path: `snapshotDownload` into the shared HF cache, `listFiles` sizes, the disk check, the completeness check, cancel and delete (`mlx-asr/models.ts`). The runtime install is the same managed worker (`runtime.ts`).

Text-only files (WP6, LLM models only): the LLM download fetches only the repo files that match `MLX_LLM_ALLOW_PATTERNS`. This list is a copy of `DEFAULT_ALLOW_PATTERNS` in mlx-lm 0.32.2 (`mlx_lm/utils.py`): `*.json`, `model*.safetensors`, `*.py`, `tokenizer.model`, `*.tiktoken`, `tiktoken.model`, `*.txt`, `*.jsonl`, `*.jinja`. The match is `fnmatch` style, as in the hub. So README files, `.gitattributes`, `optiq/mtp.safetensors` and `optiq_vision.safetensors` are not fetched. The filtered list is the size total, the disk check and the manifest below. The speech models still fetch the full repo.

Completeness (WP5, the speech and the LLM models): before the fetch, the download writes the `listFiles` result (for an LLM, the filtered list) (path and size of each file) to `openstyle-expected-files.json` in the repo cache dir. A snapshot is complete only when no `blobs/*.incomplete` file is left and every listed file is in the snapshot dir at its size (stat calls only). A snapshot with no list (an older app version or another HF tool) needs every entry to resolve and one `.safetensors` or `.npz` file. A dropped connection ("terminated", ECONNRESET, a socket error) gets 3 more tries after 2 s, 5 s and 10 s. `@huggingface/hub` 2.13 cannot resume a partial file: a new try skips the complete files and fetches the partial file again from 0. After the last failed try, the status is `error`.

### 3.3 Process lifecycle (`server.ts`)

Copy `mlx-asr/server.ts`: one serialized start chain, ready timeout 180 s, SIGTERM then SIGKILL after 5 s, stop on host exit. A different model stops the current LLM worker first. A setting `mlx_llm_keep_alive_minutes` (0-10, -1 = always; default 5) unloads the worker when idle.

### 3.4 Provider

A `PROVIDERS` entry `local-mlx-llm` in `llm/registry.ts`: `createOpenAI({ baseURL: http://127.0.0.1:<port>/v1, apiKey: "local" })` after `ensureLlmWorker(modelId)`. It uses the same fetch wrapper (trace log, overrides).

Split the meaning of `local`:
- `local` stays "no API key, verbatim sampling" (`task-profiles.ts:394`, `model-profiles.ts:155`).
- A new `ownServer` flag is set only for `server`. `lane.ts:188-196` and `task-profiles.ts:303-309` check `ownServer`, not `local`.

Mode ladder `["json_schema_strict","prompt_only"]` and reasoning control `template_kwargs` (as `server`) in `model-profiles.ts`. Lane: one lane `local-mlx-llm`, limit 1, background calls yield to dictation (`lane.ts`).

### 3.5 Routes (`/api/mlx-llm`)

`GET /status` (platformSupported, runtime, models with status/progress, keepAliveMinutes, worker {model, state}), `POST /models/:id/download`, `POST /models/:id/cancel`, `DELETE /models/:id`, `POST /server/start {model}`, `POST /server/stop`. `/api/models/available` lists ready local LLM models as `local-mlx-llm/<id>` with `type: "llm"`.

---

## 4. UI (Models page)

- The LLM source picker gets a built-in group "On-device · MLX" (as voice; `source-picker.tsx:25-32`). Remove the "no built-in LLM" note.
- LLM rows for the 2 models use the voice row component: size until ready, Download / Cancel / Retry / Use / Delete, progress with bytes, speed and percent. One "Recommended" badge: `gemma-4-e2b-qat-4bit`. A model row in `model_configs` (default or not) of a model that is no longer in the catalog is deleted when the server reads the defaults (`mlx-llm/reconcile.ts`). The person then has no default LLM and picks one again. A task override to such a model falls back to the app default.
- "Use" sets the default LLM (`model_configs`, provider `local-mlx-llm`, model_id `local-mlx-llm/<id>`, type `llm`).
- The task profiles section lists the local LLM models in the model override picker.
- A keep-alive slider for the LLM next to the MLX memory section.
- i18n: all new keys in `en.json` and the 6 other locales plus `template.json`.
- E2E `model-picker-groups.test.ts:512-524` (exactly 2 LLM rows) changes to include the built-in group.

---

## 5. Proof (definition of done)

1. Unit tests: worker (fake model) and server (registry, lifecycle, routes, catalog).
2. Real worker: `--llm` with a catalog model answers `/v1/models` and a strict-schema chat completion with valid JSON.
3. Isolated server + isolated app (live-testing skill, quiet mode, Test Runner): download a catalog model from the Models page, press Use, run Meeting Enhance + Summarize on a fictional meeting. Show the llm_calls rows (provider `local-mlx-llm`, finish `stop`, valid JSON) and a screenshot of the Models page row.
4. Dictation latency with the LLM worker loaded stays within 10% of baseline.
5. CI green.

### Status and proof (2026-10-20, PR #228)

- WP1, frozen worker: `--llm` answered a strict-schema chat completion with valid JSON on Qwen3.5 0.8B and Gemma 4 E2B.
- WP2, server: the registry, lifecycle and routes passed with a fake worker.
- WP3, UI: the Models page row was proven in the isolated app.
- Real E2E, isolated server and app: Qwen3.5 4B and Gemma 4 E4B. Download 351 s and 273 s. Meeting Enhance and Summarize ran and succeeded. About 98 and 77 tok/s. Worker RSS 3.1 GiB and 5.2 GiB.
- WP4, per-call enum of ids and labels (`specs/meeting-enhance-agentic.md` 4.0.3 rule 3): Qwen3.5 4B applied 12 of 20 corrections on a fictional 40-segment meeting, with 0 `unknown_id`.
- WP5, download fix: a download that failed with "terminated" left `model.safetensors` as an `.incomplete` blob, and the next POST `/download` reported `ready`. Now a snapshot is complete only when every file of the expected list has its size and no `.incomplete` blob is left (3.2). A dropped connection gets 3 more tries.
- Council on the 4 reference meetings, oMLX Qwen3.8-27B, OLD (main) vs NEW (this PR):
  - r228 (WP4 only): no consensus. Claude SHIP 8/5/45, pi FIX-FIRST 12/10/53, Codex REVERT 10/21/43. A noise run (OLD vs OLD2) then gave 0, 0, 16 and 8 changed lines, against 5, 5, 25 and 23 for OLD vs NEW.
  - r228b (0da84fa8, WP4 + WP7, judged against the noise files): 1, 3, 14 and 28 changed lines. Claude SHIP 7/4/35, pi SHIP 5/5/36, Codex FIX-FIRST 6/5/35. CONSENSUS: no. Codex asks to reject bad full-segment corrections (9243bea0 system:4, mic:80) and to keep the case of technical names ("Tableau", "RAG"; the "RAG" change is also in the noise run). Speaker records are identical in all arms. 0 failed chunks. check-summary passes on all 4.
  - r228c (0f02c8c6, + a guard that drops a correction that lowercases a capitalized name): 1, 3, 20 and 27 changed lines. Claude SHIP 7/4/40, pi FIX-FIRST 12/5/34, Codex REVERT 6/16/29. CONSENSUS: no. The guard dropped 0 corrections: in the "Tableau" and "RAG" regions the raw transcript is in lower case, so NEW missed a capital and did no damage.
  - r228d (the r228c runs judged again; the compare tool now shows 3 unchanged words around each change): Claude FIX-FIRST 14/14/23, pi FIX-FIRST 19/16/16, Codex FIX-FIRST 27/10/14. All three ask to fix the same thing. A trace showed that the code copies the model text unchanged. The raw transcript already has "a external" and "it request". OLD's model output fixes them and NEW's does not, because with the full-segment rule the model copies segments as they are.
  - r228e (47157e66, a prompt that says "list only the segments you change", and "an"/"it's"): it fixed 1 of 4 target segments. The 27B model edited more and damaged meaning in new places (a time, a lost product name, a wrong word). Not judged. Reverted in 2c74d648.
  - Code fixes after r228e: identifySpeakers sends an enum of the shown segment ids per call (66eda28b), and for an id that comes twice the first entry that passes every check wins (5ace8a71). Round r228f measures this HEAD.
  - r228f (2c74d648, 27B, judged by Claude alone): no damage. NEW leaves more raw ASR errors than OLD (missed small fixes such as "an", "it's" and repeats); only one NEW edit (9243bea0 mic:80) may be worse. Meetings 1 to 3 gave the same per-call tokens as r228c. oMLX 0.7.0 to 0.7.1 adds normal variation only (OLD vs OLD3: 8 changed lines).
  - Replay test on 4 chunks, 8 target fixes, 27B at temperature 0: the PR prompt 0/8, main's prompt with the id enums 8/8, main's prompt with one meaningless word change 6/8. The fixes move with any wording change. The schema `text` description has no effect (the local worker does not show the schema to the model, `scripts/mlx_asr_server.py:900-907`). Owner decision 2026-10-20: keep one prompt as is.
  - Gemma 4 E2B on the owner's 3 meetings (peer run X2h, judged by Claude): corrections good (79 edits, mostly exact-repeat removal; about 10 "gonna" to "going to"; 1 small word addition; no lost content), summary correct on spot checks, speakers broken (every identify call ended "length": one entry per line and quotes up to 514 characters). Fixed in 0612ac6e (local-mlx-llm only: maxItems = label count, quote maxLength 160, name maxLength 80) and 4e77a47a ("null" owner or due is missing).
  - Gemma 4 E4B after 66eda28b and 5ace8a71 (peer run X2g): duplicate_id 9 to 0, unknown_segment 12 to 0 on #163.
- Catalog eval (`pnpm meeting:eval`, 4 reference meetings, hard fails summed over the 4 meetings):
  - Run 1 (90a31233, rescored with the checks of 06c6d740): Qwen3.5 0.8B 39 (1 of 4 meetings clean), Qwen3.5 4B 3 (3 of 4), Gemma 4 E2B 6 (1 of 4), Gemma 4 E4B 1 (3 of 4), Qwen3.5 9B 1 (3 of 4), oMLX Qwen3.8-27B 0 (4 of 4). Applied corrections: 25, 31, 90, 95, 65, 117. Peak RSS GB: 1.62, 3.91, 4.43, 6.77, 7.64.
  - Run 2 (06c6d740): Qwen3.5 0.8B 14 (1 of 4), Gemma 4 E2B 6 (1 of 4), Gemma 4 E4B 1 (3 of 4). Applied corrections: 6, 90, 95. Every Gemma hard fail is in the speakers check (E2B 0/1/3/2, E4B 0/1/0/0 per meeting); Qwen3.5 0.8B fails the chunks and summary checks.
  - Owner decision 2026-10-20 18:20: keep only Gemma 4 E2B (recommended) and E4B. A speaker suggestion that only repeats a diarized label is now dropped as `label_echo` (`specs/meeting-enhance-agentic.md` 4.4.2, check 6b).
- Open: item 4 (dictation latency).
