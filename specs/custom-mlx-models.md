# Technical Spec: Curated + Custom Local MLX Speech Models

**Status:** Draft
**Author:** _TBD_
**Date:** 2026-10-04
**Scope:** `apps/server/src/lib/mlx-asr`, `apps/server/src/routes/mlx-asr.ts`, `packages/validations`, and the Models page in `apps/electron/src/renderer/src/pages/models`.
**Baseline:** `main` at release 2.10.0. Every `file:line` below was read on that tree. Re-verify before you implement.

Writing rules: Simplified Technical English. One instruction per sentence. No em-dashes.

---

## 1. Problem and goals

The MLX model list is hard coded. Four models are listed in `MLX_ASR_MODELS` (`apps/server/src/lib/mlx-asr/constants.ts:30-75`). A user cannot run any other MLX speech model, although the worker can load many more (the code comment at `constants.ts:29` says "Any mlx-audio STT repo works").

### Decisions (user, 2026-10-04)

1. MLX only. The app is Mac-only for now. whisper.cpp keeps its curated list. There is no custom whisper.cpp model.
2. Advanced mode: Hugging Face (HF) search and a paste field (URL or `org/name`). Both go through one validation.
3. An unsupported model family blocks the download. The UI shows a clear reason.
4. The normal flow stays simple. The curated list with a recommendation stays the default. Onboarding stays curated only.
5. This document is the spec. No code is written yet.

### Goals

- G1. A user can find, validate, download, select and delete any supported MLX speech model from HF.
- G2. The app never starts a download that the installed worker cannot load.
- G3. The curated flow does not change.
- G4. A custom model uses the same download, progress, cancel, delete and select code as a curated model.

### Non-goals

- Custom whisper.cpp models.
- Cloud models and non-Mac platforms.
- HF tokens, private repos and gated repos in v1.
- LLM models.
- Revision pinning and update checks (see section 13).
- Changes to the worker build.

---

## 2. Current behavior

**Catalog.** `MlxAsrModelDef` has `id, hfId, displayName, family, sizeBytes, ramRequired, speed, quality, quantized` (`constants.ts:15-27`). `getMlxAsrModel` looks in the curated list and the legacy list only (`constants.ts:95-100`). Legacy models show in pickers only while they are on disk (`models.ts:186-189`).

**Sizes are stale.** The catalog lists `Qwen3-ASR-0.6B-8bit` as 650,000,000 bytes (`constants.ts:36`). HF reports 1,006,229,426 bytes as the sum of `siblings[].size` (HF API, 2026-10-04).

**Routes** (`routes/mlx-asr.ts`):
- `GET /status` returns `models` and `modelDefinitions` from the catalog (`:37-70`).
- `POST /models/:model/download` returns 400 `Unknown MLX ASR model` when the id is not in the catalog (`:71-99`, error at `:76`).
- `POST /models/:model/cancel` (`:100-104`), `DELETE /models/:model` (`:105-109`).
- `POST /server/start` (`:110-142`) and `POST /server/stop` (`:143-146`).

**Download** (`lib/mlx-asr/models.ts`):
- The HF cache root is `HUGGINGFACE_HUB_CACHE`, or `HF_HOME/hub`, or `~/.cache/huggingface/hub` (`:84-91`). The repo dir is `models--org--name` (`:93-95`).
- A model is "downloaded" when any snapshot dir has at least one entry (`:97-117`).
- `downloadMlxModel` ensures the worker runtime first (`:226-248`). It then sums file sizes with `listFiles` (`:263-273`), checks free disk (`:276-282`) and runs `snapshotDownload` with `progressFetch` (`:284-288`). It passes no HF token.
- Cancel aborts and removes the repo dir (`:304-321`). Delete removes the repo dir and the `model_configs` row (`:323-349`).

**Configured models.** A configured MLX model has id `local-mlx/<id>`. `toVoiceModel` builds the same id for the `/available` row (`routes/models.ts:130-140`). The schema only requires non-empty strings (`packages/validations/src/models.ts:3-9`). `GET /available` lists a local MLX model only when its status is `ready` (`routes/models.ts:296-321`). The server strips the provider prefix at the first `/` (`lib/streaming/types.ts:87-90`). So a model id must never contain `/`.

**Worker** (`scripts/mlx_asr_server.py`):
- It loads with `mlx_audio.stt.load(model_id)` (`:159-168`). Node passes `--model <hfId>` (`lib/mlx-asr/server.ts:183`). `startWorker` resolves the id with `getMlxAsrModel` (`server.ts:283`).
- It picks the first prompt alias and the language kwarg that `generate` accepts (`:29-37`, `:171-192`). It retries without prompt kwargs on `TypeError` (`:295-301`).

**Language.** `resolveMlxLanguage` maps ISO codes to English names only when `family === "qwen3-asr"`. Other families get the raw ISO code (`lib/mlx-asr/language.ts:37-45`; name set at `:4-35`).

**Disk accounting.** `getLocalModelCacheDirs` counts only catalog and legacy repo dirs (`lib/local-model-dirs.ts:28-40`).

**UI.** `pages/models/model-list.tsx` builds rows (`:79-160`) and renders `ModelRow` (`:418`) and `DownloadProgress` (`:545`). `lib/models.ts` has per-id `LOCAL_VOICE_NOTES`, `SPEED_RANK`, `QUALITY_RANK` (`:213-236`) and `buildVoiceItems` (`:238-330`). Hooks `selectLocalVoice`, `downloadLocal`, `cancelLocal`, `deleteLocal`, `retryLocalMlx` live in `pages/models/use-models.ts:487-583`. Onboarding pins `RECOMMENDED_MLX_DEF = "qwen3-0.6b-8bit"` (`pages/onboarding/use-onboarding-model.ts:17`). The Models nav entry has the rule `hidden: (ctx) => !ctx.advancedMode` (`pages/help.tsx:127`). With Advanced mode off, the page stays reachable and shows a banner (`locales/en.json:642`, `advancedModeBanner`).

---

## 3. User flow

### 3.1 Normal flow (unchanged)

The Models page shows the curated list. One model carries the "Recommended" badge. Onboarding downloads the recommended curated model and never shows custom models.

### 3.2 Add model (advanced)

The Models page gets an **Add model** button in the on-device section. It is visible only on Apple Silicon (same gate as the MLX rows). It opens a dialog.

The dialog has two inputs that use one validation:
- A search box. The search runs after 400 ms without typing. It shows the top 20 results.
- A paste field. It accepts `org/name`, `https://huggingface.co/org/name` and `https://huggingface.co/org/name/tree/main`.

Each search row shows the name (`org/name`) and the downloads (HF `downloads`). It shows no size, no family and no badge. HF list queries give no size.

When the user selects a row, or submits the paste field, the app calls one endpoint: `POST /custom-models/validate` (section 7). The dialog then shows the family, the size (GB) and a **Supported** or **Blocked** state. A blocked model shows the reason and has no Download button. **Download** calls `POST /custom-models`, which runs the same validation again.

After **Download**, the dialog closes. The model appears in the list with a **Custom** badge and the normal `ModelRow` behavior: progress bar, cancel, retry, select as default, delete. A custom row shows no speed or quality rating and no recommendation. If the user deletes the default voice model, no default voice remains (section 10). The UI shows the existing "no model selected" state.

### 3.3 Empty and error states

| State | Text (en) |
|---|---|
| Empty search box | "Search Hugging Face for MLX speech models, or paste a link." |
| No results | "No speech models found for this search." |
| Offline | "Cannot reach Hugging Face. Check your connection and try again." |
| HF API error (5xx, 429) | "Hugging Face did not answer. Try again in a minute." |
| Repo not found | "This model does not exist on Hugging Face." |
| Gated or private | "This model needs a Hugging Face login. Openstyle cannot download it yet." |
| Unsupported family | "This model type ({{type}}) does not work with the speech engine in this app version." |
| Not a transcriber | "This model does not turn speech into text." |
| Missing config.json | "This repo has no config.json. Openstyle cannot tell what kind of model it is." |
| No weights | "This repo has no weight file (.safetensors or .npz) that the speech engine can load." |
| Custom code in repo | "This model includes its own code. Openstyle does not run code from model repos." |
| Not a link or name | "Enter a Hugging Face link or a name like org/model." |
| Too large for disk | "This model needs {{need}} GB. Only {{free}} GB is free." |
| Already added | "This model is already in your list." |

**i18n.** The app uses 7 locales (`de,en,es,fr,it,ja,pt`) plus `template.json`. New strings go in a new `models.custom.*` block in `locales/en.json` and `locales/template.json`. Other locales follow the process in `locales/README.md`. Do not translate `{{placeholders}}`. The server returns a stable `code` (section 6.3). The renderer maps `code` to a `t()` key. The server never sends display text for these states.

---

## 4. Source of truth for supported families

The server must know which model types the installed worker can load, **before** the user downloads weights. The worker may not be installed yet: `downloadMlxModel` installs the worker first, but validation runs earlier (section 7).

### 4.1 How the worker picks a family

`mlx_audio.utils.load_model` (worker path `_internal/mlx_audio/utils.py`) resolves the family in this order:

1. `model_type` from `config.json`, or the `architecture` key (`model_type_from_config`, `registry.py`).
2. If still empty, the first dash-separated part of the lowercase repo name.
3. `get_model_class`: if the type is not an identity-mapped key of `MODEL_REMAPPING` (`stt/utils.py:82-106`), scan all parts of the repo name. For each part that is a `stt/models` dir name, set `model_type = part`. The scan does not stop there: the last dir match wins. A part that is a remapping key sets the type and ends the loop.
4. Import `mlx_audio.stt.models.<family>`. A missing module gives `ValueError: Model type X not supported for stt.` A missing optional dependency gives `ImportError`.

Two consequences:
- `config.json` is not enough. `mlx-community/parakeet-tdt-0.6b-v3` has no `model_type` in its HF API `config` (HF API, 2026-10-04). It loads because the repo name contains `parakeet`. The server must port steps 1 to 3 line by line.
- A name part can override a correct `model_type`. For example `whisper-x-canary` resolves to `canary`. `resolveSttFamily` must port this, including the override.
- Remapped keys do not always work. `glm` and `vibevoice` stay unmapped and fail unless a name part saves them. `parakeet_tdt` works only because `stt/utils.py:173` special-cases it.

### 4.2 Options

| Option | How | Pro | Con |
|---|---|---|---|
| (a) Static TS list | `SUPPORTED_STT_FAMILIES` in TS, tied to `MLX_WORKER_BUILD_SPEC` | Works before the worker is installed. Easy to review. Needs no worker change. | Can drift from the real worker. |
| (b) Manifest in the archive | Build script writes the families into the archive or `metadata.json` | Always matches the build. | Server can read it only after install. Needs a build change and a worker re-release. |
| (c) Runtime `capabilities` command | Worker prints supported families | Exact, even for remapping. | Needs the worker running before the user can pick a model. Needs a worker re-release. Cannot judge optional dependencies. |

### 4.3 Decision: (a), plus a unit test for the worker spec

Use option (a). The list is a deny-by-default **allowlist**, not a copy of the `stt/models` dir. A family enters the list only after it passes the smoke test in section 12.

Rules:
- The list lives in `apps/server/src/lib/mlx-asr/families.ts`: `SUPPORTED_STT_FAMILIES` (worker key to curated family spelling and display name) and `resolveSttFamily(config, repoName)` (a line-by-line port of steps 1 to 3 above, with the name override). The scan checks name parts against the allowlist, the candidates and the exclusions. It does not copy `MODEL_REMAPPING`.
- The file exports `FAMILIES_FOR_WORKER_SPEC`. It holds the value of `MLX_WORKER_BUILD_SPEC` (`runtime.ts:47`) that the list was reviewed against. A unit test fails when the two differ, like the existing spec test (`tests/mlx-runtime.test.ts:650`). A worker upgrade then forces a human to re-check the list.
- Option (c) stays a follow-up. It would replace the static check with an exact check once the worker is running.

**v1 allowlist.** The three curated families `qwen3_asr`, `sensevoice` and `parakeet`, plus `whisper`. A family is enabled only after its smoke test passes in the frozen worker. Candidates for later: `moonshine` (no MLX repo on HF on 2026-10-04), `voxtral`, `canary`, `wav2vec`, `mms`, `cohere_asr`, `nemotron_asr`, `glmasr`, `granite_speech`, `fun_asr_nano`.

**Explicit exclusions** (checked before the allowlist):
- Not transcribers: `moss_music`, `phonon`. Also any repo whose `config.json` has the key `timestamp_token_id`, and (second guard) any repo whose name contains `forcedaligner` or `aligner`. Reason: `Qwen3-ForcedAligner-0.6B-8bit` has `model_type: qwen3_asr` and the same architecture string as the real ASR repo (HF API, 2026-10-04). A family check alone passes it, but it does not transcribe. Its `config.json` has `timestamp_token_id` and `timestamp_segment_time`. The ASR config has neither. The file `qwen3_forced_aligner.py` is inside `stt/models/qwen3_asr/`, not its own dir.
- `vibevoice_asr`: it loads the tokenizer from a second repo, `Qwen/Qwen2.5-7B`, which our size and disk check does not cover.
- Families that need optional dependencies the frozen worker does not ship. They fail with `ImportError` and nothing can fix that without a worker release. A family stays off the allowlist until its smoke test passes.

---

## 5. Data model

### 5.1 Where to store

Use a **new table** `custom_mlx_models`. A settings key is a flat key-value pair (`AGENTS.md`, Persistence). A list of records with several typed fields does not fit it. A new table also lets a later query join `model_configs` by id.

The migration follows the repo's numbered blocks (`lib/schema.ts`). Current version is 34 (`schema.ts:13`). Add a block `if (currentVersion < 35)` after the v34 block (`schema.ts:871-896`) and raise `SCHEMA_VERSION` to 35. The version must stay above any upstream stamp (`schema.ts:10`).

```sql
CREATE TABLE IF NOT EXISTS custom_mlx_models (
  id            TEXT PRIMARY KEY,          -- "custom--<org>--<name>"
  hf_id         TEXT NOT NULL UNIQUE,      -- "org/name", matches ^[\w.-]+/[\w.-]+$
  display_name  TEXT NOT NULL,             -- repo name part
  family        TEXT NOT NULL,             -- curated spelling, for example "qwen3-asr"
  model_type    TEXT,                      -- raw worker key or config.json model_type, may be NULL
  total_bytes   INTEGER NOT NULL,          -- sum of siblings[].size in bytes
  revision      TEXT NOT NULL,             -- commit sha of the downloaded snapshot
  files_json    TEXT NOT NULL,             -- [{"path":"config.json","size":262}, ...]
  added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 5.2 Id scheme

- `id = "custom--" + org + "--" + name`. HF does not allow `--` in repo names, so the id is unique per repo.
- The id has no `/`, so `stripProviderPrefix` is safe (`streaming/types.ts:87-90`).
- The id cannot equal a curated id. Curated ids never start with `custom--`.
- The configured id is `local-mlx/custom--org--name`. It cannot collide with `local-whisper/*`.
- Case is kept. HF repo ids are case-insensitive on lookup but the cache dir uses the stored case. Reject a second add that differs only in case. Compare lowercase everywhere, including the check against curated ids (section 7, step 3).

### 5.3 Fields

`files_json` is the list of expected files (path and size) from `siblings` of `GET /api/models/<id>?blobs=true`. `total_bytes` is the sum of those sizes. HF `usedStorage` is not used: it counts LFS history (`mlx-community/whisper-large-v3-turbo` reports 3,228,066,988 bytes, its weight file is 1,613,977,612 bytes). Section 8 uses `files_json` and `revision`.

---

## 6. Server API

### 6.1 Search: server proxy

HF calls go through the server. Reasons:
- Only the app calls the server API (memory note "Server API has one client"). The renderer already talks only to the server for data (`AGENTS.md`, IPC tiers).
- All other HF traffic is already server-side (`lib/hf/progress.ts`, `lib/mlx-asr/models.ts`). Proxy errors, timeouts and offline handling reuse `lib/download-guard.ts`.
- One code path serves both search rows and the paste field.
- The renderer CSP would allow direct HF calls (`renderer/index.html:9`, `connect-src ... https:`). That is a reason it is possible, not a reason to do it.

### 6.2 Routes (all under `/api/mlx-asr`)

| Route | Purpose |
|---|---|
| `GET /search?q=<text>` | Proxy to HF. Returns raw hits. See below. |
| `POST /custom-models/validate` | Body `{ "model": "<url or org/name>" }`. Runs validation steps 1 to 10 (section 7). Writes nothing. Returns `{ hfId, family, totalBytes, revision }` or an error `code`. |
| `POST /custom-models` | Same body. Runs the same validation function, inserts the row, starts the download. |

There is no new delete route. `DELETE /models/:model` also deletes the `custom_mlx_models` row (section 10).

`GET /search` calls HF with `filter=mlx&pipeline_tag=automatic-speech-recognition&sort=downloads&limit=20`, and adds `&search=<q>` when `q` is set. The second query below also uses `sort=downloads`. Without it, the top 20 for `q=qwen3` are mostly TTS repos. Checked on 2026-10-04:
- `?library=mlx` does **not** filter. Do not use it.
- `?filter=mlx&pipeline_tag=automatic-speech-recognition&sort=downloads` returns ASR repos (top result `mlx-community/parakeet-tdt-0.6b-v3`, 2,149,552 downloads).
- `?filter=mlx-audio` returns the Qwen3-ASR repos, but their `pipeline_tag` is `None`, and it also returns TTS repos (`Qwen3-TTS-*`). The server runs a second query, `filter=mlx-audio&sort=downloads&limit=20` (plus `search`), and merges the results. It dedupes by `id` and drops rows whose `pipeline_tag` is a non-ASR tag. With `q=qwen3`, `mlx-community/Qwen3-ASR-0.6B-8bit` (222,309 downloads) comes from this second query.

The server answers with `{ id, downloads, pipeline_tag }` for each hit. Search does no validation and never fetches `config.json`.

### 6.3 Errors

Routes return `{ error: string, code: string }`, plus the values a text needs: `modelType` for `unsupported_family`, `needBytes` and `freeBytes` for `no_disk`, `id` for `already_added`. Codes: `invalid_input`, `offline`, `hf_error`, `not_found`, `gated`, `no_config`, `unsupported_family`, `not_transcriber`, `remote_code`, `no_weights`, `too_large`, `no_disk`, `already_added`. The renderer maps `code` to text (section 3.3).

### 6.4 Merge into `/status`

`getMlxCatalogModels()` returns curated models, plus legacy models on disk, plus all rows from `custom_mlx_models` (`models.ts:186-189`). `MlxAsrModelDef` gets an optional field `custom?: { revision: string; files: { path: string; size: number }[] }`. `isMlxModelDownloaded` branches on it (section 8). `hfCacheRoot` (`models.ts:84`) becomes exported. `modelDefinitions` in `GET /status` passes it through (`routes/mlx-asr.ts:52-64`). `getAllMlxModelStatuses` and `GET /available` need no change, because both iterate the catalog (`models.ts:191-193`, `routes/models.ts:310-321`).

For a custom model `ramRequired` is derived: `ceil(totalBytes * 1.5)` shown as "~N GB". `speed` and `quality` are empty. `quantized` is `false`. Repos name quantization in many ways (`8-bit`, `6bit`, `int8`, `bf16`), so v1 does not parse it.

### 6.5 Resolve custom ids

`getMlxAsrModel` (`constants.ts:95-100`) becomes: curated, legacy, then a lookup in `custom_mlx_models`. `constants.ts` must not import `db.ts` (import cycle risk: `models.ts` imports `constants.ts`). Put the lookup in a new `custom-models.ts` and have `getMlxAsrModel` call a registered resolver. Keep one entry point so `server.ts:283` and the routes work for custom ids unchanged.

### 6.6 Zod schemas (`packages/validations/src/models.ts`)

- `addCustomMlxModelSchema = z.object({ model: z.string().trim().min(1).max(300) })`.
- `mlxSearchQuerySchema = z.object({ q: z.string().trim().max(100).optional() })`.
- Export both from the package index. `configureModelSchema` stays as is.

---

## 7. Validation rules

`POST /custom-models/validate` runs steps 1 to 11 in order and writes nothing. `POST /custom-models` runs the same function, then step 11. The first failure stops with its code.

1. **Normalize input.** Trim. Accept only:
   - `^[A-Za-z0-9][\w.-]*/[\w.-]+$` (bare `org/name`), or
   - `https://huggingface.co/<org>/<name>` with an optional `/tree/...`, `/blob/...`, `/resolve/...`, `?...` or `#...` suffix.
   Any other host, any `http:`, any userinfo and any extra path segment before `tree` fails with `invalid_input`. Parse with `new URL`, never with string splitting alone. Output `hfId = "<org>/<name>"`.
2. **Id regex.** `hfId` must match `^[\w.-]+/[\w.-]+$`. Reject `..`, `--` and a leading `.` in either part. This keeps `hfRepoCacheDir` (`models.ts:93-95`) and the id scheme safe.
3. **Not curated.** If `hfId` equals a curated or legacy `hfId` (compare lowercase), return `already_added` and point to the existing row.
4. **Fetch metadata.** `GET https://huggingface.co/api/models/<hfId>?blobs=true` with a 15 s timeout. Send no token. Follow redirects only to `huggingface.co`: use `redirect: "manual"` with a loop and a limit of 3 hops (`resolve/main/config.json` answers 307 to `/api/resolve-cache/...` on the same host). 404 gives `not_found`. Network failure gives `offline`. A 403 gives `gated`. A 401 gives `not_found`: HF answers 401 for a repo that does not exist and for a private repo, so the two cannot be told apart (HF API, 2026-10-04). A real gated repo answers 200 with `gated` set (step 5). A 429 or 5xx gives `hf_error`.
5. **Gated or private.** `gated !== false` or `private === true` gives `gated`. A real gated repo: `pyannote/segmentation-3.0` has `gated: "auto"` (HF API, 2026-10-04).
6. **config.json.** `siblings` must contain `config.json`. If not, `no_config`. Fetch `https://huggingface.co/<hfId>/resolve/main/config.json` (limit 1 MB, parse JSON). The API `config` field is not enough (section 4.1).
7. **Remote code.** Reject (`remote_code`) when any sibling ends in `.py`, or when `config.json`, `tokenizer_config.json` or `preprocessor_config.json` has a top-level `auto_map` key. Fetch the two optional files only when they are in `siblings`. See section 11.
8. **Family.** `family = resolveSttFamily(config, name)`. If `family` is in the exclusion list or `config.json` has `timestamp_token_id` (section 4.3), return `not_transcriber`. If it is not in `SUPPORTED_STT_FAMILIES`, return `unsupported_family` with the raw `model_type` for the message. A TTS repo such as `mlx-community/Kokoro-82M-bf16` has no `model_type` and a name that maps to no STT family. It fails here.
9. **Weights.** `siblings` must hold a top-level `*.safetensors` or `*.npz` file, else `no_weights`. The worker loads only these (`utils.py:181-200`). It never loads `.bin` or `.pkl`.
10. **Size sanity.** `totalBytes` is the sum of `siblings[].size`. It must be at most 8 GiB, else `too_large`. A repo with no file sizes fails with `hf_error`.
11. **Free disk.** `assertEnoughDiskSpace(hfCacheRoot(), total + DOWNLOAD_FREE_BUFFER_BYTES)` (`lib/disk.ts:57`, buffer `:12`). Failure gives `no_disk`. The download path checks again (`models.ts:276-282`).
12. **Insert** the row (section 5.1) and start `downloadMlxModel(id)`. Return `201 { id }`.

The validate route returns `{ hfId, family, totalBytes, revision }` so the dialog can show family and size before the user clicks **Download**.

---

## 8. Download completeness

**Problem.** "Downloaded" means any snapshot dir has any entry (`models.ts:97-117`). A cancelled or crashed download can leave a partial snapshot that reads as `ready`.

**Custom models.** Replace the check with `isCustomModelComplete(def)`:
- The snapshot dir `snapshots/<revision>/` must exist for the stored `revision`.
- Every `path` in `files_json` must exist in that dir with `statSync(...).size === size`. Snapshot files are symlinks into `blobs/`. `statSync` follows them.
- A model that fails the check shows `not_downloaded`. The next Download resumes through `snapshotDownload`.

**Download revision.** v1 downloads `main` (the current behavior, `models.ts:284-288`). It records the sha seen at add time. It does **not** pass `revision` to `snapshotDownload` (the lib supports it: `@huggingface/hub` 2.13.0, `snapshot-download.d.ts`). Reason: the worker calls `load(hfId)` without a revision and expects `refs/main` in the cache. A sha-pinned download does not write `refs/main` (`snapshot-download.ts:87`). Pinning is a follow-up (section 13).

`main` can move between the add and the download. The hub names the snapshot dir by the sha it got (`snapshot-download.ts:85-93`). So after `snapshotDownload` returns, take the sha from the returned snapshot dir name, list the files again, and rewrite `revision` and `files_json` from that. The completeness check then compares against the snapshot that exists, and a finished download never reads as `not_downloaded`.

**Curated models.** Not part of v1 (risk to the working flow). Section 13 lists it as a follow-up: a curated entry would carry an expected file count.

---

## 9. Language and family handling

Store `family` in the curated spelling: `family.replace("_", "-")` (for example `qwen3-asr`). `MlxAsrModelDef.family` then matches the curated models, and `/available` passes one spelling to the UI (`routes/models.ts:315`). Keep the raw worker key in `model_type`.

`resolveMlxLanguage` (`language.ts:42`) stays unchanged. A custom Qwen3-ASR repo gets English language names like the curated models. Other families keep the raw ISO code.

The list row for a custom model shows no language list in v1.

---

## 10. Disk accounting and delete

- `getLocalModelCacheDirs` adds `hfRepoCacheDir(hfId)` for every row in `custom_mlx_models` (`lib/local-model-dirs.ts:36-38`). Settings > Data then counts custom weights. Foreign HF cache dirs stay excluded, as the comment at `local-model-dirs.ts:23-26` requires.
- `deleteMlxModel` already cancels, stops the worker, removes the repo dir and removes the `model_configs` row (`models.ts:323-349`). It resolves the model through `getMlxAsrModel`, so it works for custom ids with the change in section 6.5.
- For a custom model, `deleteMlxModel` also removes the `custom_mlx_models` row. It returns `true` when the row or the dir existed. Today it returns only whether the dir existed (`models.ts:331`, `:348`). A custom row that was cancelled or never downloaded has no dir, and would otherwise answer `ok:false` and stay in the list. The model leaves the list. The user adds it again through the dialog. This differs from a curated model, which stays in the list as `not_downloaded`.
- If the deleted model is the default voice model, the existing row removal in `deleteMlxModel` applies. No fallback exists today (`reconcile.ts:28-67` handles only the unsupported-platform case). The user has no default voice until they select one. v1 adds no fallback. A follow-up can reuse `pickWhisperFallbackId`.
- Cancel during `downloading_model` removes the repo dir (`models.ts:311-318`). For a custom model, cancel keeps the table row. The row shows `not_downloaded` and the user can retry or delete it.

---

## 11. Security

- **Path joins.** `hfId` goes into `hfRepoCacheDir` (`models.ts:93-95`) and into `rmSync` (`:315`, `:333`). Validation (section 7, steps 1 and 2) allows only `[\w.-]` parts and rejects `..`. The server re-checks the stored `hf_id` against the same regex when it reads a row.
- **URL allowlist.** Only `https://huggingface.co`. Metadata calls follow redirects only to `huggingface.co` (section 7, step 4). Weight downloads use `snapshotDownload`, which uses the hub library's own URLs (`models.ts:284-288`).
- **No HF token.** No download call sends a token (`models.ts:284-288`). Gated and private repos are blocked (section 7, step 5).
- **`trust_remote_code`: the old assumption is wrong.** The worker's own loader does not pass `trust_remote_code`. But many `mlx_audio` STT models call `AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)` in their load hooks. This includes the curated `qwen3_asr` (`stt/models/qwen3_asr/qwen3_asr.py:851`), `granite_speech` (`:521`), `glmasr` (`:519`), `qwen2_audio` (`:298`), `fun_asr_nano` (`:700`) and `vibevoice_asr` (`:418`) (worker path `_internal/mlx_audio/stt/models/...`, `grep` on 2026-10-04). With that flag on, `transformers` imports Python code named in an `auto_map` entry of the tokenizer config. That code can come from a `.py` file in the repo, or from another repo (`other/repo--module.Class`). So a malicious repo could run code in the worker.
  - Mitigation in v1: validation step 7 blocks a repo with any `.py` file or any top-level `auto_map` key in `config.json`, `tokenizer_config.json` or `preprocessor_config.json`.
  - The allowlist (section 4.3) is small, so the exposed code paths are few.
  - Residual risk: the three files are read at add time from `main`. A later change to `main` is not re-checked, because the weights are downloaded from `main` after the add. Section 13 lists the sha pin as the fix. The worker runs with `HF_HUB_OFFLINE=1` for custom models (set in the worker `env`, `server.ts:219`), so it cannot fetch extra repos. A test run with `HF_HUB_OFFLINE=1` and `HF_HOME` loaded the model from cache and transcribed (2026-10-04). A custom model with a partial cache must give a clear load error, not a silent network fetch.
  - The worker loads only top-level `*.safetensors`, then `*.npz` (`utils.py:181-200`). It never loads `.bin` or `.pkl`, so v1 does not block them. A repo with neither format fails validation with `no_weights` (section 7, step 9). `.npz` is allowed (for example `whisper-small-mlx`, 240,536 downloads).
- **Size caps.** 8 GiB total (sum of `siblings[].size`), 1 MB for each metadata JSON fetch, 15 s timeouts.
- **Log hygiene.** Do not log the full HF response body.

---

## 12. Testing

### 12.1 Unit tests (`apps/server/tests`)

- `families.test.ts`: `resolveSttFamily` for `qwen3_asr`, `parakeet_tdt` (remap), a repo with no `model_type` and name `parakeet-tdt-0.6b-v3`, `whisper`, a TTS config, and `Qwen3-ForcedAligner` (exclusion by `timestamp_token_id`, and by name). Add cases "name overrides config" (`whisper-x-canary`) and "last dir part wins". Test `FAMILIES_FOR_WORKER_SPEC === MLX_WORKER_BUILD_SPEC`.
- `custom-models-validate.test.ts` with a mocked HF `fetch`: each error code in section 6.3, URL forms (`/tree/main`, `?x`, `http:`, other host, `..`), `.py` sibling, `auto_map`, gated, 404, oversize, no disk, no top-level `*.safetensors` or `*.npz` (`no_weights`), a same-host redirect and a cross-host redirect.
- Worker env test: a custom model starts with `HF_HUB_OFFLINE=1`. A custom model with a partial cache gives a clear load error.
- `custom-models-db.test.ts`: migration v35 on a v34 DB, unique `hf_id`, id scheme, case-only duplicate.
- `mlx-models.test.ts` additions: completeness check with a full, a partial and an empty snapshot dir; catalog merge; `getMlxAsrModel` for a custom id; `getLocalModelCacheDirs` includes custom dirs; a finished download after `main` moved reads as `ready`.
- `language` test: a custom model with family `qwen3-asr` maps ISO to English names.
- `deleteMlxModel` test: a custom row with no dir is removed and the call returns `true`.
- Renderer: row mapping for the `Custom` badge and each `code` to string.

Unit tests alone do not meet the definition of done. Run 12.2 on a Mac.

### 12.2 End-to-end tests on a Mac, against the running server

Start a standalone isolated server with a throwaway `OPENSTYLE_USER_DATA` dir and a throwaway `HF_HOME` (see the port-4649 isolation note in `AGENTS.md`). Use `$TOKEN` for its bearer token and `$BASE` for its URL. The worker runtime must be installed.

| # | Step | Done when |
|---|---|---|
| E1 | Search | `curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/mlx-asr/search?q=qwen3"` lists `mlx-community/Qwen3-ASR-0.6B-8bit` (from the `mlx-audio` query, sorted by downloads). `q=parakeet` lists `mlx-community/parakeet-tdt-0.6b-v3`. |
| E2 | Validate and add a supported, non-curated repo | `POST /api/mlx-asr/custom-models/validate {"model":"https://huggingface.co/mlx-community/whisper-tiny-asr-fp16/tree/main"}` returns `family` `whisper` and `totalBytes`, and creates no row. The same body to `POST /api/mlx-asr/custom-models` returns 201. This repo exists, is not gated, has `model_type: whisper`, safetensors weights and no `.py` files (HF API, 2026-10-04). It has few downloads (687) and may go away. Fallbacks: `mlx-community/whisper-tiny.en-8bit`, `mlx-community/whisper-base-mlx`. Re-check the repo on the day you run the test. |
| E3 | Download and ready | Poll `GET /api/mlx-asr/status` until the model `custom--mlx-community--whisper-tiny-asr-fp16` has `status: "ready"`. The snapshot dir under `$HF_HOME/hub/models--mlx-community--whisper-tiny-asr-fp16/snapshots/` holds every file in `files_json` with the stored size. |
| E4 | Select and transcribe | Make the model the default voice model: `POST /api/models` with `local-mlx/custom--mlx-community--whisper-tiny-asr-fp16` and `is_default` (confirm the transcribe route reads the default when you implement this). `POST /api/mlx-asr/server/start {"modelId":"custom--mlx-community--whisper-tiny-asr-fp16"}`. Create the clip with `say -o clip.aiff "The quick brown fox jumps over the lazy dog"`, convert it to 16 kHz WAV and pad it with about 1 s of silence. `POST /api/transcribe` with the clip. Done when the output, lowercased and stripped of punctuation, contains the nine reference words in order. Do not use WER: the tiny model adds noise and invented text after the sentence, and the result changes between runs (2026-10-04). |
| E5 | UI proof | In the running app: open Models, click Add model, search, paste the URL, watch progress, see the `Custom` badge, select the model, dictate once. Take a screenshot at each step. An API 200 does not prove the screen. |
| E6 | Unsupported | Paste `mlx-community/Kokoro-82M-bf16` (TTS, `pipeline_tag: text-to-speech`). Expect 4xx `unsupported_family`. Paste `mlx-community/Qwen3-ForcedAligner-0.6B-8bit`. Expect `not_transcriber`. No table row and no cache dir exists afterwards. |
| E7 | Gated | Paste `pyannote/segmentation-3.0` (`gated: "auto"`). Expect `gated`. |
| E8 | Bad input | Paste `https://evil.example/mlx-community/x`, `../x/y`, `http://huggingface.co/a/b`. Expect `invalid_input` each time. |
| E9 | Persistence | Stop and start the server. `GET /status` still lists the custom model as `ready`. The configured default still resolves. Transcribe again. |
| E10 | Partial download | Start a download, cancel at 50 percent, check the repo dir is gone. Then truncate one file in a complete snapshot and check the status is `not_downloaded`. |
| E11 | Delete | `DELETE /api/mlx-asr/models/custom--mlx-community--whisper-tiny-asr-fp16`. `ls $HF_HOME/hub` has no `models--mlx-community--whisper-tiny-asr-fp16`. The model is gone from `/status` and `/available`. |
| E12 | Disk line | Settings > Data counts the custom weights while they exist and drops them after delete. |
| E13 | Failed download | Add a model, then go offline during the download. The row stays and shows `error`. Go online and retry: the download finishes. Delete through `DELETE /api/mlx-asr/models/:id` removes the row. |
| E14 | Curated unchanged | Onboarding downloads `qwen3-0.6b-8bit`. Curated rows and the Recommended badge look the same as 2.10.0. |

The whole run is **done** only when E1 to E14 pass with the real output pasted into the PR. If E4 fails for `whisper-tiny-asr-fp16` (for example a missing optional dependency in the frozen worker), mark `whisper` as not allowed in section 4.3 and re-run with another small family.

---

## 13. Rollout, open questions, follow-ups

### Rollout

1. Merge the server pieces (families, table, routes, completeness) with the UI hidden. Run E1 to E4, E6 to E11 and E13 against the API.
2. Merge the UI behind the existing Advanced mode (the Models nav entry is already hidden without Advanced mode, `pages/help.tsx:127`). Run E5, E12 and E14.
3. Ship in a normal release. The allowlist changes with each worker release (`MLX_WORKER_BUILD_SPEC`, `runtime.ts:47`), so a worker bump must include the check in section 4.3.

### Open questions

- Q1. v1 allowlist. Is `whisper` plus the three curated families enough, or does the user want `voxtral` or `canary` in v1? Each needs its own smoke test.
- Q2. The 8 GiB cap. Is it right for the user's disk and RAM? It is a sanity cap, not a RAM check.
- Q4. Delete removes the custom definition (section 10). Does the user prefer to keep it in the list as `not_downloaded`, like a curated model?

Closed: Q3 (`HF_HUB_OFFLINE=1` works, section 11), Q5 (`.npz` is loadable, allowed), Q6 (no size in search rows, section 3.2).

### Follow-ups

- Fix stale curated sizes. `Qwen3-ASR-0.6B-8bit` is 1,006,229,426 bytes on HF, the catalog says 650,000,000 (`constants.ts:36`). Re-measure all four entries and the legacy entry with `?blobs=true`. The same HF call shows `parakeet-tdt-0.6b-v3` at 2,508,649,652 bytes and `SenseVoiceSmall` at 936,477,465 bytes, close to the catalog values (`constants.ts:58`, `:69`).
- Add expected file counts to curated entries and use the section 8 check for them.
- Pin the download to the validated sha and make the worker load that sha. Then the `auto_map` check cannot be bypassed by a later change on `main`.
- A build-script check that compares the worker's `stt/models` dirs and `MODEL_REMAPPING` with the allowlist.
- Option (c): a worker `capabilities` command for an exact runtime check.
- Search sorting and a "recently used" list.
- Update check for custom models (compare `revision` with HF `sha`).
