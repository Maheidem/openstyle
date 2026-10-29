# Silver gold: span keys from several ASR witnesses

This folder builds and scores **silver gold keys** for real meetings. A silver key comes from a vote of several ASR engines (witnesses), not from the owner's ear. The eval (`pnpm meeting:eval --gold --gold-dir ~/.openstyle-eval/gold-silver`) reads the keys and reports span accuracy (the `## Spans` section of `results.md`). The procedure, the costs and the traps are in the skill `.claude/skills/silver-gold/SKILL.md`.

## Privacy (hard rules)

- The corpus, the witness files, the keys, the arm DBs, the audio, the raw cloud responses and the EG2 caches hold private meeting data. They stay outside the repo, under `~/.openstyle-eval/` (folders 700, files 600).
- `silver_paths.py` refuses a data path inside the repo (it compares real paths without case, so a symlink or a lower-case spelling of the repo path is refused too). `.gitignore` allows only `*.py`, `*.mts`, `*.sh` and `README.md` in this folder. Everywhere, it ignores audio, SQLite, NumPy, pickle and parquet files, `corpus/` and `work/cloud/` folders, `keys/*.json`, key backups (`*.silver-*.json`), the files of an app meeting folder (`sync.json`, `transcript*.md`) and `unsup.txt`/`unsup.tsv`.
- Every script prints counts, ids and seconds only. Never paste meeting text into a chat, a commit, a PR or an MLflow trace.
- The cloud runners send meeting audio to OpenAI or Google. Run them only when the owner approves it for these meetings.
- API keys come from the environment only (`OPENAI_API_KEY`, `GEMINI_API_KEY`). No script reads a key file or prints a key.

## Layout

| Folder | Scripts | Job |
|---|---|---|
| `.` | `silver_paths.py`, `wer.mts`, `test_silver_paths.py` | shared paths and env; the TS bridge to the eval scorer (`scoreChannel`, `scoreWords`, `normalizeWords`); smoke tests |
| `witness/` | `witness.py`, `parakeet.py`, `ctxterms.mts` | local witnesses H1, H2, H3, Parakeet; `app.json`, `context.json` |
| `witness/` | `openai_run.py`, `openai_embed.py`, `openai_build.py` | cloud witness OpenAI gpt-transcribe (no timestamps, EG2-aligned lines) |
| `witness/` | `gemini_run.py`, `gemini_stitch.py`, `gemini_merge.py` | cloud witness Gemini (own timestamps; a fill with a cheaper model) |
| `witness/` | `pilot_wer.py`, `mlflow_check.py` | pick a cloud model on 2 pilot chunks; read the MLflow traces back |
| `align/` | `align_ext.py`, `eg2_embed.py`, `align_eg2.py` | put Meet/Krisp transcripts on the local clock (4-gram anchors, then EmbeddingGemma 2) |
| `vote/` | `normalize_silver3.py`, `normalize_silver2.py`, `validate_silver2.py`, `load_gold_check.mts` | vote the spans (silver-3.3 is current); schema check; repo loader check |
| `score/` | `score_silver.py`, `span_match.py`, `run_arm.sh`, `run_arms.sh`, `score_arms.mts`, `compare_arms.py`, `extract_unsup.mts`, `names.mts` | score every witness and the app against the keys; run and score ASR arms |
| `experiments/` | `vocabmine/`, `eg2rank/`, `nemotron/` | kept experiments: vocabulary suggestion, EG2 audio term rank, Nemotron 3.5 Transcribe feasibility |

## Paths and env (`silver_paths.py`)

| Env | Default | What |
|---|---|---|
| `SILVER_CORPUS` | `~/.openstyle-eval/silver/corpus` | witness files, one folder per meeting (`<id8>/`) |
| `SILVER_KEYS` | `~/.openstyle-eval/gold-silver` | the keys `<id8>.json` and the backups `<id8>.silver-<n>.json` |
| `SILVER_WORK` | `~/.openstyle-eval/silver/work` | `cloud/raw/<model>/`, `cloud/tmp/`, `cloud/cache_oai/`, `cloud/bak/`, `cloud/openai_ledger.json`, `eg2-cache/`, `witness-tmp/`, `experiments/` |
| `SILVER_MEETINGS` | every corpus folder with `app.json` (sorted) | the meetings (id8, comma or space list), in output order |
| `SILVER_ENRICHED_DB` | `~/.openstyle-eval/silver/enriched.db` | optional: an app DB copy with one more Enhance run (`APP_ENH_ENRICHED` in `score_silver.py`) |
| `SILVER_OWNER_NAME` | none | `owner_name` of `context.json` when the app DB has no `owner_name` setting |
| `OPENSTYLE_PROFILE` | `~/Library/Application Support/Openstyle` | the app profile (DB and meeting wavs), read-only |
| `OPENSTYLE_EVAL_HF_HOME` | `~/Library/Application Support/Openstyle-eval/hf` | the model cache (offline mode) |
| `SILVER_ASR_WORKER` | the app's shipped MLX worker | the ASR worker binary |
| `SILVER_MLFLOW_URI` | none (the cloud runners and `mlflow_check.py` stop when it is unset) | the MLflow server of the cloud traces (counts only) |
| `SILVER_MLFLOW_EXPERIMENT` | `openstyle-silver-witnesses` | the MLflow experiment of the cloud traces |
| `SILVER_EVAL_HOME` | `/tmp/meeting-eval` | arm runs: `out/<arm>/raw.db`, `results.{md,json}`, `<arm>.out`, `proof-<arm>-bias.txt`. It must be under `/tmp` or a folder named `meeting-eval` (`run_arm.sh` deletes paths under it) |
| `SILVER_ARMS_KEEP` | `~/.openstyle-eval/silver/arms` | `run_arms.sh` keeps each arm DB here |

## Pipeline

Run the steps from the repo root. Each step that writes has a dry run (no `--write`) that prints the counts only.

| # | Step | Command | Reads | Writes |
|---|---|---|---|---|
| 1 | Local witnesses H1, H2, H3 (GPU lock) | `pnpm meeting:silver:witness <id8,...>` | app DB, meeting wavs | `<id8>/{app,context,h1,h2,h3}.json` |
| 2 | Parakeet witness (GPU lock) | `pnpm meeting:silver:parakeet` | `h1.json` chunks, wavs | `<id8>/parakeet.json` |
| 3 | External transcripts | by hand (see "Not scripted") | Google Meet, Krisp | `<id8>/{meet,krisp}.json` |
| 4 | Clock of Meet/Krisp, anchors | `pnpm meeting:silver:align --write` | `meet/krisp`, `h1`, `h3` | `startMs`, `time_basis`, `time_quality`; first run keeps `<name>.orig.json` |
| 5 | Clock of Meet/Krisp, EG2 | `<EG2 venv python> -I align/eg2_embed.py`, then `python3 -I align/align_eg2.py --write` | `.orig.json`, `h1`, `h3`, wavs | `eg2-cache/<id8>.npz`; `alignedMs` per line |
| 6 | OpenAI witness (cloud) | `OPENAI_API_KEY=... <venv> -I witness/openai_run.py`, then `<EG2 venv> -I witness/openai_embed.py`, `<EG2 venv> -I witness/openai_build.py --write` | wavs, `h1`, `h3` | `cloud/raw/openai-<model>/`, `cache_oai/`, `<id8>/openai.json` |
| 7 | Gemini witness (cloud) | `GEMINI_API_KEY=... <venv> -I witness/gemini_run.py`, then `python3 -I witness/gemini_stitch.py --write`; a fill: `GEM_MODEL=<cheaper> ... gemini_run.py --only id8:ch:k,...`, then `gemini_merge.py --write --fill ... --redo ...` | wavs, `h1`, `h3` | `cloud/raw/<model>/`, `<id8>/gemini.json` |
| 8 | Trace check | `<venv> -I witness/mlflow_check.py [--since <unix ms>]` (text-like counts of span inputs, outputs, attributes and events must all be 0) | MLflow | nothing |
| 9 | Silver-1 keys | a Claude adjudication workflow (see "Not scripted") | witnesses | `<id8>.json` (`goldVersion` "silver-1") |
| 10 | Silver-2 (history) | `python3 -I vote/normalize_silver2.py --write` | silver-1 keys | silver-2 keys; backup `.silver-1.json` |
| 11 | Silver-3.3 vote | `pnpm meeting:silver:vote --v33 --write` | silver-2 and silver-3.2 keys, all witnesses | silver-3.3 keys; backup `.silver-3.2.json` |
| 12 | Check the keys | `pnpm meeting:silver:validate --kind silver-3.3`, `pnpm meeting:silver:load-check` | keys | nothing |
| 13 | Score the witnesses | `pnpm meeting:silver:score` | keys, corpus | stdout tables |
| 14 | Score the app | `pnpm meeting:eval --models <id> --meetings <id8,...> --gold --gold-dir ~/.openstyle-eval/gold-silver --no-download --out /tmp/meeting-eval/out/<name>` | keys, app | `results.md` `## Spans` |
| 15 | ASR arms | `[ENV=...] pnpm meeting:silver:arm <arm>` (or `meeting:silver:arms`), then `pnpm meeting:silver:score-arms <arm>...`, `pnpm meeting:silver:compare-arms <base> <arm>...` | keys, arm DB | `out/<arm>/results.{md,json}` |
| 16 | Review insertions | `pnpm meeting:silver:extract-unsup <arm> <id8,...> <out.json outside the repo>` | arm DB, keys | private JSON (0600) |

Venvs: `requests` + `mlflow` for the cloud runners; `torch` + `sentence-transformers` (EmbeddingGemma 2, `google/embeddinggemma-2`) for the EG2 steps; `jsonschema` for the schema check; `numpy` for the witness and align steps. The repo pins none of them.

## Witness file formats (`$SILVER_CORPUS/<id8>/`)

Common rules: UTF-8 JSON objects. Times are integer milliseconds (`startMs`, `endMs`, `durationMs`), relative to the first sample of the channel wav (16 kHz, mono, 16-bit PCM). The channels are `mic` (the owner, "Me", `mic.wav`) and `system` (the other people, "Them", `system.wav`). Each channel list is in time order.

### app.json

The rows of `meeting_segments` of the app DB (read-only).

```
{ "meeting": "<id8>", "meetingId": "<full id>", "sttModel": "<ASR model of the app>", "language": "<ISO 639-1>",
  "durationMs": <int>, "channels": { "mic": [<segment>], "system": [<segment>] } }
<segment> = { "idx": <int>, "startMs", "endMs", "status": "ok"|"empty"|"filtered"|"failed",
              "speakerLabel": <string|null>, "text": <string|null>, "enhancedText": <string|null> }
```

`empty`: no audio sent (silence gate) or no ASR text. `filtered`: the app removed the text (hallucination, vocabulary leak or duplicate).

### context.json

```
{ "meeting", "meetingId", "language", "calendarTitle": <string|null>, "title": <string|null>,
  "folder": { "name", "description" } | null,
  "attendees": [ { "name": <string|null>, "nameSource": "calendar"|"email"|null, "isOrganizer": <bool> } ],
  "vocabulary": [ { "term", "notes": <string|null> } ],
  "meetingContext": <string|null>, "contextTerms": [<string>], "h2BasePrompt": <string|null>,
  "owner_name": <string|null> }
```

- `nameSource: "email"`: the name comes from the email local part `first.last` (two parts, letters only, 2 or more letters each, title case). Emails are not stored.
- `vocabulary` is in the app's prompt order: longest term first, then newest first.
- `contextTerms`: `extractContextTerms` of `meetingContext` (`apps/server/src/lib/meetings/context-terms.ts`).
- `h2BasePrompt`: `"Technical terms: " + terms.join(", ")`, cut at 900 characters; context terms first, then vocabulary terms (a vocabulary spelling wins on a case-only match), no duplicates. The same prompt as the app (`buildAsrVocabularyBias`, provider `local-mlx`).
- `owner_name`: the app setting `owner_name` (the person who records; not in `attendees`). The silver-3.3 vote trusts its spelling like an attendee name.

### h1.json, h2.json, h3.json, parakeet.json

```
{ "engine", "model": "<HF model id>", "language", "meeting",
  "channels": { "mic": [<hyp segment>], "system": [<hyp segment>] } }
<hyp segment> = { "startMs", "endMs", "text": <string, "" when no text>, "kind": "app"|"gap", "appIdx": <int|null>, "error"?: <string> }
H2 only: "promptTerms": <bool>, "promptContext": <bool>, "echoRetry": <bool>
```

- All four use the same chunks. Match them by position or by `startMs`.
- `kind: "app"`: the times of one app segment (all statuses). `kind: "gap"`: audio that no app segment covers but that has speech-like energy (20 ms frames, more than 15 dB above the channel's 10th percentile and above -55 dBFS, 300 ms away from app segments, runs joined over gaps under 1 s, 500 ms of loud frames, 300 ms padding, cut at the quietest frame between 20 s and 30 s). Gap text is less reliable: models invent short text ("Thank you.") on noise.
- Engines run in the app's shipped MLX worker, one chunk wav per request, with the worker's own loop repair. The app's text filters are NOT applied.
- H1: `mlx-community/Qwen3-ASR-1.7B-8bit`, language name, no context (the neutral witness).
- H2: the same model with the app prompt (`transcriber.ts`): no prompt under 3000 ms; else `h2BasePrompt`; the last 200 characters of the previous app chunk's H2 text as context when the gap is 30 s or less; on a prompt echo, a retry with the terms only. Gap chunks get the terms only.
- H3: `mlx-community/whisper-large-v3-turbo`, language code, no prompt.
- Parakeet: `mlx-community/parakeet-tdt-0.6b-v3`, language code, no context, the H1 chunks.

### gemini.json

```
{ "engine", "model", "modelVersion": [<string>], "language", "meeting", "time_basis", "time_quality": "good"|"coarse"|"bad",
  "chunks": [ { "channel", "chunk", "startMs", "endMs", "h1Words", "words", "ratio", "flag", "finishReason",
                "attempt", "promptTokens", "outputTokens", "thinkingTokens", "model" } ],
  "channels": { "mic": [ { "startMs", "endMs", "text", "chunk" } ], "system": [...] } }
```

- Source: the full channel wav in 600 s chunks with 5 s overlap (chunk k starts at k*600 s - 5 s), mp3 16 kHz mono 48 kbps. Per chunk: Files API upload, `generateContent` (temperature 0, thinking low, JSON schema `[{start, end, text}]`, a verbatim prompt with no speaker names), Files API delete.
- Times: the model's own MM:SS plus the chunk start. Stitch: an item of chunk k (k >= 1) is kept when its midpoint is at or after k*600 s.
- `time_quality`: unique word 4-gram anchors vs H1 and H3; good when p80 of |gemini - local| <= 5 s, coarse <= 30 s.
- `flag`: words / H1 words of the same span outside 0.6 to 1.6. Flagged chunks do not vote. `finishReason: null` = no candidate.

### openai.json

```
{ "engine", "model", "language", "meeting", "time_basis", "time_quality",
  "chunks": [ { "channel", "chunk", "startMs", "endMs", "h1Words", "words", "ratio", "flag", "model", "status",
                "overlapWordsDropped", "usageSeconds", "usd" } ],
  "channels": { "mic": [ { "startMs", "endMs", "text", "chunk", "alignedMs"?: [start, end] } ], "system": [...] } }
```

- Source and chunks as Gemini. `POST /v1/audio/transcriptions`, `response_format` json, temperature 0, no prompt, no language.
- gpt-transcribe gives no timestamps (`verbose_json` returns HTTP 400). So: the head of chunk k is matched to the tail of chunk k-1 and the repeated words are dropped; sentences are merged to lines of 8 to 40 words; EG2 method A (`align_eg2.py`) aligns each line to the H1+H3 chunks of the same channel. `alignedMs` is the matched H1 chunk run; a line without a match has no `alignedMs`.
- `time_quality` (method B, lines vs 22.5 s audio windows): good when A and B agree within 10 s for >= 70 % of the lines that both match; bad when < 30 % or the median |A-B| > 60 s; else coarse. Use `alignedMs` (line pairs), not a +-3 s window on `startMs`.

### meet.json, krisp.json

```
{ "source", "match_basis", "time_basis", "time_quality",
  "turns": [ { "speaker", "startMs", "text", "alignedMs": [start, end] | null } ] }
```

- `<name>.orig.json` keeps the imported file before alignment (`source`, `match_basis`, `turns` with the source times).
- The owner's speaker label is the one speaker in every Meet/Krisp file. Those turns are `mic`, the rest `system`. Scripts never print the label.

## Gold key schema (silver-3.3)

`validate_silver2.py` holds the full JSON schema. The eval loader (`../gold.mts`) accepts the same fields.

| Field | Type | Notes |
|---|---|---|
| `format` | `"openstyle-gold"` | |
| `goldVersion` | `3` | an integer |
| `goldKind` | `"silver-3.3"` | also `silver-2`, `silver-3`, `silver-3.1`, `silver-3.2` (backups). Compare systems only within one kind. |
| `meeting`, `id8`, `meetingId` | string | `id8` = first 8 characters of `meetingId` |
| `asrHash`, `builtAt`, `verifiedSpans`, `timeToleranceMs` | | as v2 keys |
| `witnesses` | object | `h1`, `h2`, `h3` (+ `parakeet`) `{engine}`; `openai`, `gemini` `{engine, time_basis, time_quality}`; `meet`, `krisp` `{source, time_basis, time_quality}` |
| `transcript.{mic,system}[]` | `{startMs, endMs, text, verified: false, basis[], wer_eligible}` | `basis`: independent witnesses with semi-WER <= 0.15 at the turn; `wer_eligible`: 2 or more in `basis`, one of them not `h1` |
| `spans[]` | `{channel, startMs, endMs, text, label, in_vocab, confidence, witnesses[], verifier_conflict?, alt_text?}` | label: term, product, person, org, place, other. confidence: high, medium, unsure |
| `verification` | `{sampled, agree_text, agree_conf, conflicts_marked_unsure, method}` | the blind verifier sample and the vote method text |

Ear-check fields of a span (silver-3.4 and later; older kinds refuse them): `verified` (true), `verified_source` (`<method>:<batch>:<date>`), `verified_text` (the confirmed spelling, only with `verified`), `verified_unsure` (true). Since silver-3.5: `verified_none` (true, with `verified_source`): the owner hears no named entity there. A span holds at most one of `verified`, `verified_unsure`, `verified_none`. A verified span may keep `verifier_conflict` and `alt_text` (the ear check wins). The scorers leave a `verified_none` span out of every scored count and report its count apart.
| `fixes`, `mustNotChange`, `summary`, `tags`, `speakers` | | as v2 keys (empty or null for silver keys) |

Vote rule (silver-3.3, `normalize_silver3.py`): independent witnesses are h1, h3, parakeet, openai, gemini, meet, krisp (h2 and app do not vote). A witness contains a span when the span's normal words are one run of the same-channel window words (+-3 s; line pairs for meet, krisp and openai). `exact` = the normal words equal a trusted list entry (attendee name or name part, vocabulary term, owner name). high: 3 or more agree, or 2 + exact. medium: 2 agree, or 1 + exact. unsure: otherwise, always with `verifier_conflict`, and when 2 or more witnesses agree on one other spelling (`alt_text`), except a list spelling with a sound-alike `alt_text` (edit ratio >= 0.6), which stays high or medium.

Eval span metric (`scoreSpans`, `../score.mts`): a high or medium span is a hit when its normal words (accents folded, as in the vote) occur in the text of its channel within 3000 ms of the span time, as one run or as one run without spaces (the vote's `contains` rule: whole words only, so "zor" does not match "zorblax"). One output occurrence counts for one span only: spans take occurrences in the order of their window end, each the first free occurrence. `score_silver.py` uses the same rule (`score/span_match.py`); a parity test in `score.test.mts` runs both on the same fictional cases.

## Not scripted

- The import of Google Meet and Krisp transcripts into `meet.json`/`krisp.json`. Krisp recorded only 3 of 14 work meetings; Google Meet transcripts exist for 10 of 14.
- The silver-1 adjudication and the blind verifier: Claude workflows that read the witnesses and wrote the silver-1 keys and `verification`. Claude is the evaluator here, never a step of the app.

## Nemotron 3.5 Transcribe experiment (2026-10-29)

Scripts for the eval of Nemotron 3.5 Transcribe (MLX 4-bit) against the shipped Qwen3-ASR 1.7B.
Every script refuses an output path inside the repo. Transcripts stay private. Output is numbers only.

### serve_openai.py

- It is a small OpenAI-compatible speech server for one local model. It binds to 127.0.0.1 only.
- It answers `POST /v1/audio/transcriptions` and `GET /v1/models`.
- oMLX 0.7.3rc1 bundles mlx-audio 0.5.7. That version has no `nemotron_transcribe` model type.
- The server loads the model with mlx-audio 0.6.2 (pinned at the commit used) in a private venv outside the repo.
- Start it, then set `LAB_ASR_SERVER_URL` and run an Eval Lab grid with the knob `asr_server_model`.
- The `model` field of the request picks the bias mode: `nemotron-ctx`, `nemotron-hot`, `nemotron-plain`, `nemotron-offw`.

### Best prompt

- The official contextual instruction (technical report A.5): "This audio may contain the following words or phrases (some may not be present in the clip): ..."
- Only the meeting terms go in the list, not the full vocabulary.
- The written-form wording follows the instruction: omit fillers and accidental repetitions, keep the remaining spoken wording unchanged.

### Result (silver-3.6, 14 meetings, 1604 spans, real app pipeline)

| Setup | Run | Span hits | Person % | Verified % | WER % | Possible insertions |
|---|---|---|---|---|---|---|
| Qwen3-ASR 1.7B (control) | f60d76b7 | 1222 (76.18%) | 73.26 | 34.31 | 4.09 | 51 |
| Nemotron, A.5 + meeting terms + written form | 5c880731 | 1159 (72.26%) | 77.05 | 38.49 | 12.0 | 259 |
| Nemotron, full vocabulary | 55c31633 | 1050 | 80.42 | - | 13.7 | 694 |
| Nemotron, no prompt | cc95fc18 | 1028 | 39.79 | - | 13.2 | 13 |

Nemotron does not beat the control. The MLX port has no word timestamps, so it cannot replace the aligner or the diarizer.
