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
4. Catalog v1 (curated only, no custom LLM models):

| Id | HF repo | Disk (bytes, HF API) | Family |
|---|---|---|---|
| `qwen3.5-0.8b-4bit` | `mlx-community/Qwen3.5-0.8B-4bit` | 652,029,391 | qwen3_5 |
| `qwen3.5-4b-4bit` | `mlx-community/Qwen3.5-4B-4bit` | 3,061,130,647 | qwen3_5 |
| `qwen3.5-9b-4bit` | `mlx-community/Qwen3.5-9B-4bit` | 5,977,073,303 | qwen3_5 |
| `gemma-4-e2b-4bit` | `mlx-community/gemma-4-e2b-it-4bit` | 3,583,088,661 | gemma4 |
| `gemma-4-e4b-4bit` | `mlx-community/gemma-4-e4b-it-4bit` | 5,179,241,512 | gemma4 |

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

Reuse the speech model code path: `snapshotDownload` into the shared HF cache, `listFiles` sizes, the disk check, the completeness check, cancel and delete (`mlx-asr/models.ts:219-398`). The runtime install is the same managed worker (`runtime.ts`).

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
- LLM rows for the 5 models use the voice row component: size until ready, Download / Cancel / Retry / Use / Delete, progress with bytes, speed and percent. One "Recommended" badge: `qwen3.5-4b-4bit`.
- "Use" sets the default LLM (`model_configs`, provider `local-mlx-llm`, model_id `local-mlx-llm/<id>`, type `llm`).
- The task profiles section lists the local LLM models in the model override picker.
- A keep-alive slider for the LLM next to the MLX memory section.
- i18n: all new keys in `en.json` and the 6 other locales plus `template.json`.
- E2E `model-picker-groups.test.ts:512-524` (exactly 2 LLM rows) changes to include the built-in group.

---

## 5. Proof (definition of done)

1. Unit tests: worker (fake model) and server (registry, lifecycle, routes, catalog).
2. Real worker: `--llm` with `qwen3.5-4b-4bit` answers `/v1/models` and a strict-schema chat completion with valid JSON.
3. Isolated server + isolated app (live-testing skill, quiet mode, Test Runner): download a catalog model from the Models page, press Use, run Meeting Enhance + Summarize on a fictional meeting. Show the llm_calls rows (provider `local-mlx-llm`, finish `stop`, valid JSON) and a screenshot of the Models page row.
4. Dictation latency with the LLM worker loaded stays within 10% of baseline.
5. CI green.
