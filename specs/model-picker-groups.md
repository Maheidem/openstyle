# Technical Spec: Model Pickers Grouped by Who Runs the Model

**Status:** Shipped in 2.12.0. Migration 36 verified on the owner's real DB after the update (2026-10-05).
**Author:** _TBD_
**Date:** 2026-10-05
**Scope:** `apps/server/src/routes/models.ts`, `routes/settings.ts`, a new `routes/servers.ts`, `lib/streaming`, `lib/llm`, `lib/schema.ts`, `packages/validations`, and the Models page in `apps/electron/src/renderer/src/pages/models`.
**Baseline:** `main` at the merge of release 2.11.2 (`8cafa17`). Every `file:line` below was read on that tree. Re-verify before you implement.

Writing rules: Simplified Technical English. One instruction per sentence. No em-dashes.

---

## 1. Problem and goals

The model pickers mix three things. The "On your Mac" list shows models that Openstyle runs next to models that an oMLX server runs. The "Your API key" row hides the cloud providers behind a name that describes the payment method. One user server (oMLX at `127.0.0.1:8123`) is configured in three places with three texts. The transcription list also offers models that cannot transcribe (embedding, reranker, text-to-speech).

### Decisions (user, 2026-10-05)

1. Group every model picker by WHO RUNS THE MODEL. There are three groups: **Built into Openstyle**, **Your own server**, **Cloud provider**. "Your API key" is renamed.
2. In the own-server list, hide the models that do not fit the role. Add a **Show all models** toggle. The role filter uses server data when the server gives it, and name rules when it does not (section 4).
3. The same structure applies to transcription and to all LLM roles. Deliberate deviation: LLM roles show two rows, because Openstyle has no built-in LLM (3.1, open question 2).
4. Keep it simple for users. This document is the spec. No code is written yet.

### Goals

- G1. A user can tell from the first screen who runs a model and where the data goes.
- G2. One server has one place for its address and key, for all roles.
- G3. A role never lists a model that cannot do the role, unless the user asks to see all models.
- G4. No existing setting or selected model breaks silently (section 6).

### Non-goals

- New providers, new model types, or changes to the worker build.
- Streaming transcription from an own server (follow-up, section 13).
- Changes to onboarding (section 9).
- Renaming internal helper functions (follow-up, section 13).
- Hosting models for the user. Openstyle never starts or stops an own server.

---

## 2. Current behavior

### 2.1 Roles and pickers

**Roles.** There is one transcription role: the default `voice` model. It serves dictation (`lib/transcription-pipeline.ts:117,131-132`), the stream route (`routes/stream.ts:99`) and meetings (`lib/meetings/transcriber.ts:348`). There are four LLM roles: `cleanup`, `remix`, `meetingSummarize`, `meetingEnhance` (`packages/validations/src/llm-task-profiles.ts:9-14`). Each role uses the default `llm` model, unless the task has a `modelOverride` (`lib/llm/task-profiles.ts:272-306`).

**Pickers.** There are three pickers. Onboarding has none.
- Transcription: `TranscriptionPicker` shows two rows (`pages/models/transcription-picker.tsx:81-96`).
- LLM default: `CleanupTierPicker` shows two rows (`pages/models/model-list.tsx:842-904`).
- Per-task override: a `Select` that lists every configured `llm` row (`pages/models/task-profiles-section.tsx:133,311-320`).

The two top rows read "On {{phrase}}" and "Your API key" (`locales/en.json:711-712`). A third screen, `ModelList`, opens after a click. It filters by `source` only (`model-list.tsx:295-317`).

### 2.2 The mixed list

`buildVoiceRows` builds the voice rows. It adds the Whisper and MLX rows first. It then pushes one row per oMLX model with the meta text "On-device · oMLX" (`model-list.tsx:158-182`, text at `:174`). Those rows sit in the same list as the built-in rows, because the list filter is `source === "local"` (`model-list.tsx:309`).

The LLM list does the same with `local-llm` models. Their meta text is "On-device" (`model-list.tsx:218-236`, text at `:228`). The server may be on another machine.

### 2.3 No role filter

`fetchOmlxModels` lists every id from `<root>/v1/models` and sets `type: "voice"` for all of them (`routes/models.ts:94-126`, `:122`). The comment says oMLX "reports no modality" (`routes/models.ts:89-93`). This is not true for the whole oMLX API (section 4). The `/omlx/test` route repeats the same claim (`routes/settings.ts:247-248`). The result on the installed 2.11.2 app: Qwen3-Embedding, Qwen3-Reranker, Qwen3.8-27B and Qwen3-TTS appear as transcription models, and the default voice model is `omlx/Qwen3-TTS` (installed DB, read-only query 2026-10-05).

oMLX models never appear for LLM roles. The LLM provider registry has no `omlx` entry (`lib/llm/registry.ts:244-279` is the last entry, lookup at `:288-295`). `createChatModel` then throws `Unsupported provider` (`lib/providers.ts:59-60`).

### 2.4 One server, three configurations

| Settings keys | Used by | Where the user sets it | Code |
|---|---|---|---|
| `omlx_base_url`, `omlx_api_key` | Transcription provider `omlx` | On-device list, voice (`OmlxConnect`) | `settings-keys.ts:50-51`, `streaming/providers/omlx.ts:57,80`, `model-list.tsx:691-704`, shown at `:330` |
| `local_llm_url`, `local_llm_api_key` | LLM provider `local-llm` and its list rows | On-device list, LLM (`LocalLlmConnect`) | `settings-keys.ts:31-32`, `llm/registry.ts:244-279`, `routes/models.ts:55-84`, `model-list.tsx:661-674`, shown at `:326` |
| `openai_stt_base_url`, `openai_stt_api_key` | Only provider `openai` transcription | Cloud list, voice (`OpenaiSttConnect`) | `settings-keys.ts:52-53`, `streaming/providers/openai.ts:27-40`, `model-list.tsx:676-689`, shown at `:327` |

The three forms have three texts and two default URLs (`use-models.ts:184,202`). The installed DB holds `omlx_base_url=http://127.0.0.1:8123`, `local_llm_url=http://localhost:8123` and `openai_stt_base_url=http://localhost:8123/v1`. That is one server. No API key is stored for it.

Side effects that matter for the migration:
- The oMLX provider needs no API key (`lib/api-keys.ts:6`, `streaming/local-providers.ts:10-14`).
- The `openai` provider still needs an OpenAI key in `api_keys`, even when the URL override points at a self-hosted server. The pipeline calls `getApiKey("openai")` first (`transcription-pipeline.ts:152-159`, `api-keys.ts:7-10`).
- Models whose id contains "transcribe" stream to `wss://api.openai.com` (`streaming/providers/openai.ts:19,42-44`). The override applies to batch only. This comes from reading the code. It is not tested.
- The local-LLM lane key already folds `localhost`, `127.0.0.1` and `[::1]`, strips `/v1` and folds default ports (`lib/llm/lane.ts:154-173`).

### 2.5 Other facts

- Configured models are rows in `model_configs(provider, model_id, model_name, type, is_default)`. A default is `is_default = 1` per `type` (`routes/models.ts:347-393`). The per-task override stores `{provider, model_id}` inside the JSON setting `llm_task_assignments` (`validations/llm-task-profiles.ts:145,154`).
- The server strips the provider prefix at the first `/` only (`lib/streaming/types.ts:87-90`). A model id may contain `/` after that first one.
- Cloud keys live in `api_keys` (`lib/api-keys.ts:7`). The cloud list is `BUILTIN_VOICE_MODELS` (`routes/models.ts:150-199`: OpenAI, Groq, Deepgram, ElevenLabs, Soniox) and, for LLMs, the models.dev registry limited to `SUPPORTED_LLM_PROVIDERS` plus gateways (`routes/models.ts:202-209`).
- The built-in group is `whisper` and `mlx` rows (`lib/models.ts:257-336`). There is no built-in LLM (the registry has none).
- Only the app calls the server API. A route with no app caller is dead (project memory). The three test routes `/settings/local-llm/test`, `/openai-stt/test`, `/omlx/test` have one caller each in `use-models.ts:187,196,204`.

---

## 3. New structure per role

### 3.1 Top level: three rows

Each picker opens on three rows. Each row has a title, a one-line subtitle, and a hint. The hint shows the selected model name when the selected model belongs to that group. Otherwise it shows the subtitle detail.

| Row | Title (en) | Subtitle (en) | Hint when nothing selected there |
|---|---|---|---|
| Built into Openstyle | "Built into Openstyle" | "Models that Openstyle downloads and runs on {{phrase}}." | "{{count}} models" |
| Your own server | "Your own server" | "A server that you run: oMLX, LM Studio, vLLM, or any OpenAI-compatible address." | "Not connected" or "{{count}} models" |
| Cloud provider | "Cloud provider" | "A company that runs the model. You need an API key." | "Groq, OpenAI, and more" |

Rules:
- Transcription shows all three rows. The Built-in row is always shown, because Whisper runs on every platform. A device that cannot run a model keeps the existing "Unavailable on this device" hint (`transcription-picker.tsx:63`).
- The LLM roles show two rows: Your own server and Cloud provider. Openstyle has no built-in LLM. Do not show an empty row.
- The own-server row is always visible. It is the way to add a server.
- Exactly one row is active (the group of the current default model).
- The row text uses the group name, never a brand name. The old "On {{phrase}}" key is retired.

### 3.2 What each group lists

| Group | Transcription | LLM roles |
|---|---|---|
| Built into Openstyle | Whisper (whisper.cpp) rows and MLX rows, including custom Hugging Face models from 2.11, with download, cancel, delete and the **Add model** button (`model-list.tsx:361-371`). | Not shown. |
| Your own server | Models from every connected server that fit transcription. | Models from every connected server that fit an LLM role. |
| Cloud provider | Curated cloud voice models (`routes/models.ts:150-199`). A row without a key shows **Add key**. | Registry models of the supported providers, curated first, with the existing "Show all models" expander (`model-list.tsx:307-329`). |

Rules for the Built-in group: it never lists a model that a server runs. It loses the oMLX rows (`model-list.tsx:158-182`).

Rules for the Cloud group: it has no URL field. The OpenAI-compatible URL form is removed (`model-list.tsx:327,676-689`). Its content moves to the own-server group (section 6).

### 3.3 Group screens

Titles: "Built into Openstyle", "Your own server", "Cloud providers". They replace `scopedTitle` (`model-list.tsx:335-342`). The search box and the back button stay.

### 3.4 Empty and error states

| State | Text (en) |
|---|---|
| No server yet (own-server screen) | "Add a server to use the models that it runs." |
| Server reachable, no model fits the role (transcription) | "{{server}} has no speech-to-text model. Select Show all models to see every model." |
| Server reachable, no model fits the role (LLM) | "{{server}} has no chat model. Select Show all models to see every model." |
| Server not reachable (row) | "Not reachable. Check that the server is running." with a **Retry** button |
| Server answered 401 or 403 | "The server needs an API key." |
| Server answered but has no `/v1/models` | "This address does not look like an OpenAI-compatible server." |
| Selected model not listed by its server | "This server does not list this model any more." |
| Selected model does not fit the role | "This model cannot transcribe. Pick a speech-to-text model." (LLM: "This model cannot write text. Pick a chat model.") |
| Duplicate address when you add a server | "This server is already in your list." |
| Cloud group, no key | Unchanged: **Add key** button. |

---

## 4. Which models belong to a role

### 4.1 What the user's oMLX server reports (read-only, 2026-10-05, oMLX 0.7.0)

`GET http://127.0.0.1:8123/v1/models` returns 6 entries. Each entry has exactly five fields: `id`, `object`, `created`, `owned_by` (always `omlx`) and `max_model_len`. The response schema `ModelInfo` in `/openapi.json` has the same five fields. It has no type, task, modality or capability field. The ids are the user aliases: `Qwen3-ASR`, `Qwen3-Embedding`, `Qwen3.8-27B`, `Qwen3-Reranker`, `Qwen3-TTS`, `MarkItDown`.

The same server has a second endpoint: `GET /v1/models/status` (`/openapi.json`, summary "List Models Status"). It returns 12 entries. Most entries have `id` (the real folder name), `model_alias`, `engine_type`, `model_type`, `config_model_type`, `is_hidden`, `is_helper` and 20 more fields. Some entries have fewer fields (`MarkItDown` has 20 in total, with no `model_alias` or `is_helper`; `Qwen3.5-2B-bf16` has no `model_alias`). Real values:

| `/v1/models` id | status `id` | `model_type` | listed in `/v1/models` |
|---|---|---|---|
| Qwen3-ASR | Qwen3-ASR-1.7B-8bit | `audio_stt` | yes |
| Qwen3-TTS | Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit | `audio_tts` | yes |
| Qwen3-Embedding | Qwen3-Embedding-8B-MLX-oQ4 | `embedding` | yes |
| Qwen3-Reranker | Qwen3-Reranker-0.6B-mlx-8Bit | `reranker` | yes |
| Qwen3.8-27B | Qwen3.8-27B-AWQ-5.0bpw | `vlm` | yes |
| MarkItDown | MarkItDown | `markitdown` | yes |
| bge-m3, Qwen3.5-0.8B, -2B, -4B, -9B, Qwen3.6-35B | various | `embedding`, `vlm` | no (`is_hidden: true`) |

Source of the value set: the oMLX 0.7.0 bundle on this Mac, `/Applications/oMLX.app/Contents/Resources/omlx/model_discovery.py:28` (`llm, vlm, embedding, reranker, audio_stt, audio_tts, audio_sts`) and `server.py:3078-3080` (`markitdown`). The same bundle shows that `/v1/models` skips hidden models and replaces the id with the alias (`server.py:3351-3366`). `/v1/models` answered here without a key (loopback server). `/v1/models/status` uses the stricter check (`server.py:389-396,3414`), so it may answer 401 on a remote server that has a key.

**Decision.** For oMLX the role filter uses server data. The app reads `/v1/models` for the list (it respects the hidden flag) and `/v1/models/status` for the type. It joins them by `model_alias`, then by `id`. If the status call fails, the app uses the name rules in 4.3. The status endpoint is confirmed on oMLX 0.7.0 only. An older oMLX may lack it, so the name-rule fallback is required and has its own test.

### 4.2 Other servers

| Server | List endpoint | Type data | Source |
|---|---|---|---|
| oMLX | `/v1/models` | `/v1/models/status`, field `model_type` | Section 4.1 |
| LM Studio | `/v1/models` | None used. Its `/api/v0/models` only adds the `embeddings` kind, which the `embed` name rule already finds. | Name rules |
| vLLM | `/v1/models` | None known. Not verified: the vLLM docs page does not list the fields (docs.vllm.ai, read 2026-10-05). | Name rules |
| Any other OpenAI-compatible URL | `/v1/models` | None | Name rules |

LM Studio does not support `/v1/audio/transcriptions`. Its docs list five endpoints and none is audio (lmstudio.ai/docs/developer/openai-compat, read 2026-10-05). So an LM Studio server is an LLM server only. This is the reason for many servers (section 5.1).

### 4.3 Kinds and the exact name rules

A model has one `kind`: `speech`, `llm`, `embedding`, `rerank`, `tts`, `other` or `unknown`.

**Server data to kind:**

| Server value | Kind |
|---|---|
| oMLX `llm`, `vlm` | `llm` |
| oMLX `audio_stt` | `speech` |
| oMLX `audio_tts` | `tts` |
| oMLX `audio_sts`, `markitdown` | `other` |
| oMLX `embedding` | `embedding` |
| oMLX `reranker` | `rerank` |

**Name rules** run only for a model that has no server data. Lowercase the id. Split it into tokens at every character that is not a letter or a digit. Apply the first rule that matches:

1. A token equals `markitdown`: `other`.
2. The id contains `embed`, or a token is one of `bge`, `gte`, `minilm`, `mxbai`, `e5`: `embedding`.
3. The id contains `rerank`: `rerank`.
4. A token is one of `tts`, `kokoro`, `orpheus`, `chatterbox`, `outetts`, `bark`, or the id contains `text-to-speech`: `tts`.
5. A token is one of `asr`, `stt`, `whisper`, `parakeet`, `canary`, `sensevoice`, `moonshine`, `voxtral`, `wav2vec`, `wav2vec2`, or the id contains `transcri` or `speech-to-text`: `speech`.
6. Otherwise: `unknown`.

**Role fit:**

| Role | Fits | Shown by default |
|---|---|---|
| Transcription | `speech` | Only `speech`. An `unknown` model is hidden, because most unknown names are chat models. |
| Every LLM role | `llm`, `unknown` | `llm` and `unknown`. An unknown name is more likely a chat model than not. |
| Show all models | all kinds | Every model. Each non-fitting row shows a kind badge: "Embedding", "Reranker", "Text to speech", "Other". |

The selected model is always visible, even when it does not fit.

### 4.4 Test cases (the user's real ids)

| Id | Source | Kind | Transcription | LLM roles |
|---|---|---|---|---|
| `Qwen3-ASR` | server data | `speech` | shown | hidden |
| `Qwen3-ASR-1.7B-8bit` | name | `speech` | shown | hidden |
| `Qwen3-TTS` | server data | `tts` | hidden | hidden |
| `Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` | name | `tts` | hidden | hidden |
| `Qwen3-Embedding` | server data | `embedding` | hidden | hidden |
| `Qwen3-Embedding-8B-MLX-oQ4` | name | `embedding` | hidden | hidden |
| `Qwen3-Reranker` | server data | `rerank` | hidden | hidden |
| `Qwen3-Reranker-0.6B-mlx-8Bit` | name | `rerank` | hidden | hidden |
| `Qwen3.8-27B` | server data (`vlm`) | `llm` | hidden | shown |
| `Qwen3.8-27B` | name (status call failed) | `unknown` | hidden | shown |
| `MarkItDown` | server data | `other` | hidden | hidden |
| `bge-m3` | name | `embedding` | hidden | hidden |
| `openai/whisper-large-v3` (vLLM style) | name | `speech` | shown | hidden |
| `qwen/qwen3-4b` (LM Studio style) | name | `unknown` | hidden | shown |

---

## 5. The "Your own server" model

### 5.1 One server or many

**Decision: a list of servers. Each server has an address and an optional key. To change a server, remove it and add it again.** Reasons:
- LM Studio has no transcription (section 4.2). A user who runs LM Studio for chat and oMLX for speech needs two addresses.
- The current LLM form defaults to the Ollama port (`use-models.ts:184`), so a second server for chat is a normal case.
- One list covers oMLX, LM Studio, vLLM and a plain OpenAI-compatible URL with one form. There is no per-vendor code path.
- A user with one server sees one row. The list costs that user nothing.

Rejected: one global server (breaks the LM Studio plus oMLX case), and one slot per role (keeps the same server in two places).

### 5.2 The server screen

The screen has two parts, top to bottom.
1. **Servers.** One row per server: name, address, status, **Remove**. An **Add server** button opens an inline form with two fields: Address (placeholder `http://127.0.0.1:8123`) and API key (optional).
2. **Models.** One list of models from all connected servers, filtered by the role (section 4.3). Each row shows the model name, the server name when there is more than one server, and a **Use** button. At the bottom: **Show all models (N more)**. It reuses the existing toggle (`model-list.tsx:421-429`) and extends it from the LLM list to this list (`model-list.tsx:307`).

The same screen opens from the transcription picker and from the LLM picker. Only the model filter differs. The server list is the same.

### 5.3 Connection test

The **Add server** form has one button: **Connect**. It runs the probe, then saves only when the probe passes. A failed probe saves nothing and shows the error. This replaces the current flow that saves first and probes second (`use-endpoint-connect.ts:80-109`).

The probe is a server action (section 7):
1. `GET <root>/v1/models` with the key as Bearer, 3 seconds (the value of `REGISTRY_FETCH_TIMEOUT_MS`, `lib/model-registry.ts:10`). It must pass. A non-OK answer gives the error text in 3.4.
2. If step 1 passed, `GET <root>/v1/models/status`, 2 seconds. A valid answer with a `models` array sets the flavor to `oMLX` and gives the types.
3. Otherwise the flavor is `OpenAI-compatible`. The name rules give the kinds.

Step 2 never fails the probe. The server name is computed, never stored: "{{flavor}} ({{host:port}})".

The root is `normalizeOmlxRoot(input)` (`packages/validations/src/omlx.ts:27-32`). It strips trailing slashes and `/v1...`. The existing probe for oMLX also posts an empty form to `/v1/audio/transcriptions` to prove the route exists (`routes/settings.ts:251-264`). That check is dropped. An LLM-only server has no such route, and the check would reject LM Studio.

### 5.4 Duplicate servers

The server identity is `server_key`: the lowercased `normalizeOmlxRoot(url)` with scheme, host, port and path. `localhost`, `127.0.0.1` and `[::1]` fold to one host. A missing port equals the default port of the scheme. `http://h:8123` and `https://h:8123` are two servers. Two proxy paths on one host (`https://gw/a/v1` and `https://gw/b/v1`) are two servers. `POST /api/servers` answers 409 with the id of the existing server.

`llmLaneKey` is not an identity. It returns `host:port` and drops scheme and path (`lib/llm/lane.ts:154-171`). Keep it for lane use only (5.5).

### 5.5 Calls through a server

- Transcription: `POST <root>/v1/audio/transcriptions` with fields `file`, `model`, `response_format`, optional `language` and `prompt`. This is the existing oMLX request (`streaming/providers/omlx.ts:64-76`). vLLM and LiteLLM use the same wire format. oMLX resolves the alias in the `model` field (`audio_routes.py:102-109` in the oMLX bundle).
- LLM: `createOpenAI({ baseURL: <root>/v1 }).chat(model)`. This is the existing `local-llm` call (`llm/registry.ts:244-279`).
- The LLM lane key is the server root. It uses `llmLaneKey(server.base_url)`. Two servers that share `host:port` share one lane, which is the safe direction. Today it reads `local_llm_url` (`llm/lane.ts:176-195`).

---

## 6. Data model and migration

### 6.1 Storage

A new table in schema version 36 (the current version is 35, `lib/schema.ts:13,898`).

```sql
CREATE TABLE IF NOT EXISTS own_servers (
  id         TEXT PRIMARY KEY,          -- "srv_" + 8 hex chars. Never holds "/".
  base_url   TEXT NOT NULL,             -- normalized root, no /v1
  api_key    TEXT,                      -- optional
  flavor     TEXT,                      -- last detected: omlx | openai
  server_key TEXT NOT NULL UNIQUE,      -- identity, see 5.4
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`api_key` has the same trust level as the old `omlx_api_key` and `api_keys.key`. `GET /api/servers` never returns it. The `name` field in the API is computed from flavor and host. It returns `has_key: boolean`.

### 6.2 Configured model ids

Provider id: `server`. Model id: `server/<serverId>/<modelId>`. The model id may contain `/` (LM Studio uses `publisher/name`). The code reads `serverId` up to the second `/` and takes the rest as the model id. The `server` provider replaces `omlx` and `local-llm`. `model_configs` keeps its shape. The `type` column (`voice` or `llm`) tells the role.

Code that names the old ids and must change:
- `streaming/local-providers.ts:10-14` (`LOCAL_STT_PROVIDERS`): replace `omlx` with `server`.
- `streaming/registry.ts:23`: `OmlxTranscriptionProvider` becomes `ServerTranscriptionProvider` with `providerId = "server"`. It resolves the server from the model id.
- `lib/vocabulary-bias.ts:152`: `case "omlx"` becomes `case "server"`.
- `lib/providers.ts:9-17`: add `server` to `PROVIDER_PREFIXED_CHAT_MODELS`, remove `local-llm`.
- `llm/registry.ts:244-279`: the `local-llm` entry becomes `server`. `isLocalProvider` stays true for it.
- `llm/task-profiles.ts:290-296`: the check "local endpoint configured" becomes "the server in the override still exists".
- `llm/lane.ts:176-195`: `llmLaneKeyForProvider(providerId)` gets a second argument, the model id. Callers: `lib/remix-agent.ts:91` and `withLlmLane(provider, opts, fn)` (`lib/llm/lane.ts:504-509`). `withLlmLane` also needs the model id. Its callers are `lib/post-process.ts:223`, `lib/remix-transform.ts:127` and `lib/meetings/llm-call.ts:126`.
- `streaming/providers/openai.ts:27-40`: the override branch is deleted.
- `lib/model-registry.ts:137`: `isCleanupModelSupported` has `if (providerId === "local-llm") return true;`. Replace it with `isLocalProvider(providerId)` so `server` passes. Without this change the default `llm` on provider `server` falls through to the models.dev lookup and returns false. Dictation then logs "Skipping LLM cleanup: unsupported cleanup model" (`lib/post-process.ts:187`), and Remix throws `unsupported-model` (`lib/remix-transform.ts:78`). Test: the default `llm` on provider `server` passes `isCleanupModelSupported`.
- Server credentials: `getChatModelId` strips only `server/`, which leaves `<sid>/<model>`. The `server` registry entry splits that at the first `/`, reads `own_servers` for `base_url` and `api_key`, and passes them to `createOpenAI`.
- `taskContext` and `createSamplingFetch` stay unchanged. `llm/task-profiles.ts:348` uses `isLocalProvider` for the verbatim tier, so `server` keeps `local: true`.
- Transcription bias: M4 moves `openai` rows to `server`. Today `openai` gets the `buildPromptText` bias (`lib/vocabulary-bias.ts:103`), and `omlx` gets a "Technical terms: ..." prompt (`:151-152`). `server` uses the `omlx` bias. `streaming/transcribe-bias.ts:9` passes the prompt through the AI SDK for `openai` and `groq` only. So `ServerTranscriptionProvider` sends the `prompt` field itself, as `omlx.ts:74-76` does.

### 6.3 Migration rules (schema 36, one transaction, runs once)

The migration reads the old settings by their literal key names. It makes no network call.

| # | Input | Rule |
|---|---|---|
| M1 | The three URL settings (`omlx_base_url`, `local_llm_url`, `openai_stt_base_url`) | Build one candidate per non-empty URL, in that order. Normalize each with `normalizeOmlxRoot`. Merge candidates with the same `server_key`. The first URL text wins. Each URL keeps its own key: `omlx_base_url` with `omlx_api_key`, `local_llm_url` with `local_llm_api_key`, `openai_stt_base_url` with `openai_stt_api_key`. A key never moves to a candidate with a different `server_key`. When candidates merge, the key is the first non-empty key among the merged ones, in that order. Insert one `own_servers` row per merged candidate. |
| M2 | `model_configs` rows with `provider = 'omlx'` | Set `provider = 'server'` and `model_id = 'server/<sid>/<old id without "omlx/">'`, where `<sid>` is the server of `omlx_base_url`. Keep `model_name`, `type` and `is_default`. |
| M3 | `model_configs` rows with `provider = 'local-llm'` | Same as M2, with the server of `local_llm_url`. |
| M4 | The default `voice` row with `provider = 'openai'`, when `openai_stt_base_url` is not empty | Rewrite it to `provider = 'server'`, `model_id = 'server/<sid>/<old short id>'`, with the server of that URL. The old row sent every call to that URL (`streaming/providers/openai.ts:28-39`), so the call goes to the same place. Other `openai` rows stay cloud rows. |
| M5 | `llm_task_assignments` JSON: each `modelOverride` with `provider = 'local-llm'` | Rewrite `provider` to `server` and the `model_id` prefix like M3. If the JSON does not parse, leave it unchanged. |
| M5b | UNIQUE collision | `model_configs` has `UNIQUE(provider, model_id, type)` (`lib/schema.ts:285`). An M4 row `openai/X` and an M2 row `omlx/X` can both become `server/<sid>/X`. A plain UPDATE would throw and fail the migration. Merge instead: keep one row, delete the other, and set `is_default = 1` on the kept row when either row had it. |
| M6 | A row in M2, M3 or M4 whose old URL setting is empty | Delete the row. It could not run before either (`omlx.ts:57-62` throws "No oMLX server URL configured"). If it was the default, no default remains and the UI shows "None selected". |
| M7 | The six old settings keys | Leave them in place and unread for one release. Delete them in the next schema migration (follow-up). Migration 36 is one way. M2 to M4 rewrite `model_configs.provider` to `server`, and an older build has no `server` provider, so its default `voice` and default `llm` fail. Do not claim a working downgrade. |

Nothing is selected for the user. The user's installed data after migration:
- One server `srv_xxxxxxxx`, `http://127.0.0.1:8123` (three URLs merge, section 2.4), no key.
- Default `voice`: `server/srv_xxxxxxxx/Qwen3-TTS` (kept, not changed). The new UI shows "This model cannot transcribe" on it (section 3.4, section 7). The user fixes it with one click.
- Default `llm`: `server/srv_xxxxxxxx/Qwen3.8-27B`.
- Row 23 `omlx/mlx-community--Qwen3-ASR-1.7B-8bit` becomes a stale `server/...` row. The server no longer lists it. It is `type = voice`, so the per-task override list (`llm` rows only, `task-profiles-section.tsx:133`) never shows it. The voice picker lists live server models and also injects the selected default even when the server does not list it (`model-list.tsx:165-168,219-221`). Row 23 is not the default, so it stays hidden.

### 6.4 Remove a server

`DELETE /api/servers/:id` deletes the row and every `model_configs` row whose `model_id` starts with `server/<id>/`. This is the same rule as `deleteProvider` for keys (`use-models.ts:832-858`). A task override that points at a removed server falls back to the default model with a warning (`task-profiles.ts:272-306`, extended in 6.2). A removed default leaves "None selected".

---

## 7. Server API

The app is the only client. A new route needs an app caller. A removed route must have no other caller.

**New: `routes/servers.ts`, mounted at `/api/servers`.**

| Route | Purpose | Response |
|---|---|---|
| `GET /` | List servers with a live probe (parallel, 3 s each). | `[{id, name, base_url, has_key, flavor, reachable, error?, models: [{id, kind, kind_source}]}]`. `kind_source` is `server` or `name`. |
| `POST /` | Body `{url, api_key?}`. Probe (5.3), then save. | 201 with the row. 409 `{code: "duplicate", id}`. 502 `{error}`. |
| `DELETE /:id` | Section 6.4. | `{ok: true}` |

The kind rules (4.3) live in one server file, `lib/server-models.ts`. The renderer decides the role fit with a three-line table (`transcription` accepts `speech`, LLM roles accept `llm` and `unknown`). The server sends the kind and never sends display text.

**Changed:**
- `GET /models/available` no longer returns `omlx` or `local-llm` rows. Delete `fetchLocalLlmModels` (`routes/models.ts:55-84`), `fetchOmlxModels` (`:94-127`) and the two call blocks (`:323-337`).
- `/api/settings/local-llm/test`, `/openai-stt/test`, `/omlx/test` are deleted (`routes/settings.ts:191-271`), with their schemas (`validations/src/local-llm.ts`, `openai-stt.ts`, the config parts of `omlx.ts`) and the two validators `openai_stt_base_url` and `omlx_base_url` (`lib/setting-validators.ts:164-173`).
- The six keys leave `SETTINGS_KEYS` (`settings-keys.ts:31-32,50-53`).

**Unchanged:** `/models/configured` (`routes/models.ts:347-401`), `/api/keys`, `/api/mlx-asr/*`, `/api/whisper/*`.

---

## 8. Renderer changes

| File | Change |
|---|---|
| `pages/models/transcription-picker.tsx` and `CleanupTierPicker` in `model-list.tsx:842-904` | Replace the two pickers with one `SourcePicker` with a `role` prop (after the move above). It renders the rows in 3.1. The two components are copies of each other today. |
| `pages/models/transcription-picker.tsx:16` | `LOCAL_PROVIDERS` lists `omlx`. Remove it. The file also exports `recommendedVoiceKey` (`:18`) and `OpenModelSourceButton` (`:103`). `model-list.tsx:54-56` imports both. Move them to another file (for example `pages/models/voice-helpers.tsx`) before the picker is replaced. |
| `pages/models/model-list.tsx:830-839` | `MANAGED_LLM_PROVIDERS`, `isLocalLlm` and `isByokLlm` name `local-llm`. Rewrite them for the `server` provider. |
| `pages/models/model-list.tsx` | Build rows per group. Remove the oMLX rows (`:158-182`), the `local-llm` rows (`:218-236`) and the three connect forms (`:661-828`). `scopedTitle` gets the new titles. Extend "Show all models" to the server list. |
| New `pages/models/servers-section.tsx` | Server rows, Add form, status. |
| `pages/models/use-endpoint-connect.ts` | Replace with `use-servers.ts`: a React Query on `GET /api/servers`, plus add and remove. |
| `pages/models/use-models.ts` | Delete `LOCAL_LLM_CONFIG`, `OPENAI_STT_CONFIG`, `OMLX_CONFIG` (`:181-205`) and the fields `localLlm`, `openaiStt`, `omlx` (`:127-129`). Replace `selectLocalLlmModel` and `selectOmlxModel` (`:603-622`) with one `selectServerModel(serverId, modelId, type)`. |
| `lib/models.ts` | Remove `omlx` and `local-llm` from `VOICE_PROVIDERS`, `LLM_PROVIDERS` and `PROVIDER_DISPLAY_NAMES` (`:81-114`). Remove the `omlx` skip (`:344-346`). |
| `pages/models/utils.ts:8-35` | `groupByProvider` loses the `local-llm` and local-voice skips. It only sees cloud models. |
| `pages/models/index.tsx:113-132` | `onPickCloud` loses the `local-llm` exception (`:118`). Server models use `selectServerModel`. |
| `pages/models/pair-card.tsx:38-56` | "via {{provider}}" shows the server name for a server model. Add a warning line when the default `voice` model is a server model with a kind other than `speech`. |
| `pages/models/task-profiles-section.tsx` | Group the override `Select` with `SelectGroup` labels: Your own server, Cloud provider. `LOCAL_PROVIDER_IDS` becomes `server` (`:57`). |

---

## 9. Onboarding

No change. Onboarding builds the list with no cloud and no server rows (`pages/onboarding/use-onboarding-model.ts:50`) and downloads the recommended Whisper or MLX model. It never shows a picker. Its copy says the model "runs on {{phrase}}" and stays correct. `ON_DEVICE_PHRASE` stays in use (`onboarding.modelSetup`, history, the delete dialog). The "Built into Openstyle" subtitle also uses it.

---

## 10. i18n

New strings go in `locales/en.json` and `locales/template.json` under `models.picker.*` and a new `models.servers.*` block. The other six locales may lag. A missing key falls back to English (`locales/locales.test.ts` header). Do not translate `{{placeholders}}`.

| Key | en |
|---|---|
| `models.picker.builtIn` | Built into Openstyle |
| `models.picker.builtInDesc` | Models that Openstyle downloads and runs on {{phrase}}. |
| `models.picker.ownServer` | Your own server |
| `models.picker.ownServerDesc` | A server that you run: oMLX, LM Studio, vLLM, or any OpenAI-compatible address. |
| `models.picker.ownServerNone` | Not connected |
| `models.picker.cloud` | Cloud provider |
| `models.picker.cloudDesc` | A company that runs the model. You need an API key. |
| `models.servers.title` | Servers |
| `models.servers.add` | Add server |
| `models.servers.connect` | Connect |
| `models.servers.address` | Address |
| `models.servers.keyOptional` | API key (optional) |
| `models.servers.showAll` | Show all models ({{count}} more) |
| `models.servers.kind.embedding` / `rerank` / `tts` / `other` | Embedding / Reranker / Text to speech / Other |

The states in 3.4 each get a key under `models.servers.*`. Retire `models.picker.onDevice`, `yourApiKey`, `ollamaHint`, `browseLocalVoice`, `browseByokVoice`, `browseLocalCleanup`, `browseByokCleanup` (`locales/en.json:711-721`). Replace the browse labels with one label per group.

---

## 11. Testing

### 11.1 Unit and route tests (server)

- `tests/server-models.test.ts`: the table in 4.4, both with server data and with name rules only.
- `tests/servers-route.test.ts`: add (probe pass, fail 401, fail 404, flavor oMLX from a `/v1/models/status` fixture, flavor OpenAI-compatible when that call is missing), duplicate by `localhost` against `127.0.0.1`, `http` against `https` on one port (two servers), key redaction, delete with cascade.
- `tests/migration-servers.test.ts`: one test per rule M1 to M6, plus the installed-data case in 6.3. Fixtures are a copy of the three URLs and the six `model_configs` rows.
- Update `tests/omlx.test.ts` for the `server` provider and `tests/models-available-route.test.ts` for the removed rows.
- Add `isCleanupModelSupported` for provider `server` (section 6.2).
- Update these to the `server` provider (they use `omlx`, `local-llm`, `omlx_base_url` or `local_llm_url`). Server: `trace.test.ts`, `settings-validators.test.ts`, `settings-redaction.test.ts`, `llm-lane.test.ts`, `vocabulary-bias.test.ts`, `dictation-vocab-leak.test.ts`, `history-pause-transcribe.test.ts`, `meeting-llm-timeouts.test.ts`, `meeting-summarize.test.ts`, `llm-task-profiles.test.ts`. Renderer: `pages/models/preset-ops.test.ts:235`. e2e: `import-screen.test.ts` and `meeting-cancel-transcribe.test.ts` (both PUT `omlx_base_url` and seed provider `omlx`), `preset-crud-evidence.test.ts` (`local-llm` at lines 469, 568-569, 1413).
- Docs step: update the old names in `.lore.md`, `AGENTS.md`, `specs/redesign-models-page.md`, `specs/meeting-llm-queue.md` and `specs/llm-task-profiles.md`.

### 11.2 Real end-to-end on this Mac (no mocks)

Rules: the installed app and its DB are never changed. Reads on the user's oMLX are `GET` only. The only write to oMLX is a transcription request. It may load the ASR model into memory on that server.

**A. Server data against the real oMLX (read-only).**
```
curl -s http://127.0.0.1:8123/v1/models
curl -s http://127.0.0.1:8123/v1/models/status
```
Expected: `/v1/models` has 6 entries with 5 fields each. `/v1/models/status` has 12 entries and `model_type` values `audio_stt`, `audio_tts`, `embedding`, `reranker`, `vlm`, `markitdown`.

**B. Isolated server, real probe.** Start `apps/server/dist/startup.js` on an ephemeral port with a throwaway DB and a bearer token, `cwd=apps/electron` (`AGENTS.md`, "Port-4649 isolation"). The pattern is `tests/preset-crud-evidence.test.ts:398-420`. Then:
```
curl -s -X POST $URL/api/servers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"url":"http://localhost:8123/v1"}'
curl -s $URL/api/servers -H "Authorization: Bearer $TOKEN"
```
Expected: 201 with flavor `omlx` and `base_url` `http://localhost:8123`. The list shows `Qwen3-ASR` as `speech`, `Qwen3.8-27B` as `llm`, `Qwen3-Embedding` as `embedding`, `Qwen3-Reranker` as `rerank`, `Qwen3-TTS` as `tts`, `MarkItDown` as `other`, all with `kind_source: "server"`. A second POST of `http://127.0.0.1:8123` gives 409.

**C. Real transcription through the isolated server.** `$SCRATCH` is the session scratchpad directory, not `/tmp`.
```
say -o $SCRATCH/mpg.aiff "The quick brown fox jumps over the lazy dog"
afconvert -f WAVE -d LEI16@16000 $SCRATCH/mpg.aiff $SCRATCH/mpg.wav
curl -s -X POST $URL/api/models/configured -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"server","model_id":"server/<sid>/Qwen3-ASR","model_name":"Qwen3-ASR","type":"voice","is_default":true}'
curl -s -X POST $URL/api/transcribe -H "Authorization: Bearer $TOKEN" -F audio=@$SCRATCH/mpg.wav
```
Expected: JSON text that contains "quick brown fox". Repeat with `Qwen3-TTS` as the default. Expected: an error, and the Models page shows the "cannot transcribe" line.

**D. Migration on a copy of the real data.** The DB uses WAL mode and the installed app runs, so `freestyle.db-wal` holds data that is not in the main file. Make the copy with `sqlite3 -readonly freestyle.db ".backup <scratch>/copy.db"`, or copy all three files (`freestyle.db`, `-wal`, `-shm`). Never open the installed DB for writing. Start the isolated server on the copy. Expected: one `own_servers` row, `model_configs` rows as in 6.3, `GET /api/models/configured` unchanged in count.

**E. Isolated Electron UI proof with screenshots.** Use the pattern of `tests/preset-crud-evidence.test.ts`: own server, throwaway userData, `serverUrl` and `serverToken` in the profile, evidence dir with numbered PNGs and a manifest. Steps and screenshots: (1) transcription picker shows three rows, (2) own-server screen on the migrated copy shows one server and only `Qwen3-ASR`, (3) Show all models reveals the other five with kind badges, (4) the LLM picker shows two rows and `Qwen3.8-27B`, (5) the Cloud screen has no URL field, (6) the selected `Qwen3-TTS` shows the warning, (7) Add server with a bad address shows the error, (8) the per-task override select shows the two groups. Run: `OPENSTYLE_EVIDENCE_DIR=/abs/dir pnpm --filter @openstyle/electron test:e2e tests/model-picker-groups.test.ts`.

## 12. Done when

```
pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck && pnpm --filter @openstyle/electron build
pnpm --filter @openstyle/server test
pnpm --filter @openstyle/electron test
pnpm run knip
pnpm exec biome check
OPENSTYLE_EVIDENCE_DIR=/abs/dir pnpm --filter @openstyle/electron test:e2e tests/model-picker-groups.test.ts
```
The e2e run needs the built app (`out/main/index.js`, used by `launchOpenstyle` in `tests/helpers/e2e-app.ts`) and `apps/server/dist`, as `AGENTS.md:89` says. A second Electron instance registers the global hotkeys of the user. Quit the installed app first, or accept the hotkey overlap. The isolation pattern (ephemeral port, token, throwaway DB) still holds. `pnpm format` is `biome check --write .` and writes repo-wide, so the verify step uses `biome check` only.

The work is done when the commands in 11.2 A to D print the expected output, and the manifest from 11.2 E has no FAIL step. No other command is a substitute.

---

## 13. Open questions and follow-ups

**Open questions (need the owner)**
1. Many servers (this spec) or one global server? The spec recommends many (5.1).
2. Should the LLM pickers show a disabled "Built into Openstyle" row ("Coming later") or hide it (3.1)? The spec hides it.
3. M7 keeps six dead settings for one release. Is a one-release grace period wanted, or delete at once?
4. The migration keeps a default `Qwen3-TTS` voice model as is. Should it switch to a speech model of the same server when one exists? The spec says no: no silent change of a user choice. That model cannot transcribe today, so dictation keeps failing until the user finds the warning on the Models page. Recommendation: show a one-time notice on the dashboard when the default `voice` model is a server model with a kind other than `speech`. Do not switch the model.
5. `voiceProviderCategory` maps the new `server` provider to `local` (`streaming/local-providers.ts:18-22`, sent to the client at `routes/stream.ts:224`). A server on another machine is not local. Is `local` still the right label?

**Follow-ups**
- Delete the six old settings keys in schema 37.
- Rename `normalizeOmlxRoot`, `omlxModelsUrl` and `omlxTranscribeUrl` in `packages/validations/src/omlx.ts` to server names.
- Streaming transcription from an own server (`/v1/audio/transcriptions` with `stream=true` is in the oMLX schema).
- The OpenAI streaming path ignores the old URL override (2.4). The migration removes the override, so the problem ends with it. Verify with a test.
- Use `/v1/models/status` fields `loaded` and `estimated_size` to show "loaded" or "cold start" on a server row.
