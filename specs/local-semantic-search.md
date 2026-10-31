# Technical Spec: Local Semantic Search (project memory)

**Status:** #86 implementation in PR #250 (index, search, UI). #234 implementation in PR #299 (section 8.4).
**Author:** Claude Code (spec writer for the coordinator).
**Date:** 2026-10-20
**Tracking:** #82 (this spec). Builds: #86 (index), #233 (built-in embedding model). Feeds: #234 (project memory for Summary and Enhance). Depends on: #230 (folders, PR #235), #231 (tags, PR #237), PR #228 (MLX worker HTTP shim).
**Scope:** `apps/server/src/lib/search/` (new), `apps/server/src/lib/mlx-embed/` (new), `apps/server/src/routes/search.ts` (new), migration 43 in `apps/server/src/lib/schema.ts`, `apps/server/src/lib/db.ts`, the `--embed` mode of `scripts/mlx_asr_server.py`, the Electron build (`resources/bin/darwin-arm64/vec0.dylib`), the Models page and a search box on the Meetings page.
**Baseline:** `origin/main` at `6663abfa`, plus PR #235 head `37e77403` (worktree `openstyle-folders`), plus PR #228 head `2e6dfcdd` (`origin/feat/local-mlx-llm`). Prefixes: `M:` = main, `F:` = PR #235, `L:` = PR #228. A path with no prefix is the same on main and PR #235. Every `file:line` was read on these trees on 2026-10-20. Re-verify before you implement.
**Rules:** ASD-STE100. No em-dashes. `file:line` for code claims. A URL for external claims. UNVERIFIED for claims with no proof. Owner decisions in #82, #86, #230, #231, #233 and #234 are final. This spec records them. It does not re-open them.

**Table of contents**

1. [Goal and non-goals](#1-goal-and-non-goals)
2. [Decisions](#2-decisions)
3. [Data model](#3-data-model)
4. [Chunking](#4-chunking)
5. [Embedding runtime](#5-embedding-runtime)
6. [Indexing flow](#6-indexing-flow)
7. [Query flow](#7-query-flow)
8. [Retrieval API](#8-retrieval-api)
9. [Failure modes](#9-failure-modes)
10. [Privacy](#10-privacy)
11. [Packaging and signing](#11-packaging-and-signing)
12. [Test plan and Done-when](#12-test-plan-and-done-when)
13. [Open questions](#13-open-questions)
14. [Appendix A: probe output](#appendix-a-probe-output)

---

## 1. Goal and non-goals

### 1.1 Goal

A user types a question about past meetings. Openstyle finds the meeting passages with the same meaning, also when the words are different. All work stays on the Mac. Search needs only an embedding model. It works with no LLM (#86 update, #229).

The same index is "project memory". Summary and Enhance of a meeting in a folder get related context from the other meetings in that folder (#234). Search, Summary and Enhance use one retrieval API (section 8).

### 1.2 Goals

- G1. One vector index for all meetings in the existing `freestyle.db`. A folder is a filter at query time, not a second store (#82 update).
- G2. The index updates itself when meeting text changes. Unchanged chunks are not embedded again (#86 update).
- G3. A built-in MLX embedding model with download, Use and Delete on the Models page, like the built-in LLM of PR #228 (#233 scope).
- G4. A search box on the Meetings page, scoped to all meetings, one folder or unfiled meetings.
- G5. One retrieval API for search (v1), Summary and Enhance (#234).
- G6. If sqlite-vec does not load, search is off. Everything else works (#82 owner decision 2).

### 1.3 Non-goals (v1)

- Hybrid search (FTS5 + vectors), a reranker, the "ask" answer (#91) and the MCP server (#95). **Status 2026-10-31: the hybrid and the reranker are reversed** for the meeting chat agent by `specs/meeting-chat-agent.md` section 7.4, with the numbers of `specs/meeting-chat-agent-p0-report.md` section 3. Nothing is built in the search UI yet. The "ask" answer is the chat agent. The MCP server stays a non-goal.
- The own-server embedding path (oMLX `Qwen3-Embedding`). #233 says "built-in MLX first". Its vectors need their own index (#233 research comment).
- A BLOB-scan fallback (#82 owner decision 2).
- Embedding the summary markdown or the meeting title. The title lowers recall@10 by 0.013 to 0.067 (#233 spike, check 7).
- Windows and Linux. The MLX worker is Apple silicon only (`AGENTS.md:52`).
- Dictation history. v1 indexes meetings only. Dictation is a later issue (D17).

---

## 2. Decisions

### 2.1 Owner decisions (final, recorded here)

| # | Decision | Source |
|---|---|---|
| D1 | sqlite-vec 0.1.9 in the existing SQLite file. `folder_id` is the vec0 partition key. | [#82 comment 6297621008](https://github.com/Maheidem/openstyle/issues/82#issuecomment-6297621008) |
| D2 | If the dylib fails to load, search is off. One code path, no BLOB fallback. The app shows it. The error is logged. Meetings, Enhance and Summary keep working. #234 retrieval is off too. | [#82 comment 6297621008](https://github.com/Maheidem/openstyle/issues/82#issuecomment-6297621008) |
| D3 | One index. Each chunk row stores `meeting_id`, `folder_id` and tags. A move changes only the folder column. No re-embedding. | [#82 body, update 2026-10-20](https://github.com/Maheidem/openstyle/issues/82) |
| D4 | The embedding model id is stored with each vector. A model change means a full re-index, never a mix. | [#82 body](https://github.com/Maheidem/openstyle/issues/82), [#86 body](https://github.com/Maheidem/openstyle/issues/86) |
| D5 | Each chunk row stores a text hash. Re-index a meeting when its text changes (transcribe, re-transcribe, Enhance, manual edit). Skip unchanged chunks by hash. | [#86 body](https://github.com/Maheidem/openstyle/issues/86) |
| D6 | Search works with no LLM. | [#82 body](https://github.com/Maheidem/openstyle/issues/82), [#86 body](https://github.com/Maheidem/openstyle/issues/86) |
| D7 | Model: EmbeddingGemma 2, bf16 weights. 8 GB Macs: the same model as a 4-bit text-only conversion, in the same vector space. | [#233 comment 6299816580](https://github.com/Maheidem/openstyle/issues/233#issuecomment-6299816580) |
| D8 | Vectors: 768 dims, int8 storage, cosine. Vectors only, no plain-RRF hybrid. | [#233 comment 6299816580](https://github.com/Maheidem/openstyle/issues/233#issuecomment-6299816580) |
| D9 | Document prompt `title: none \| text: <chunk>`. Query prompt `task: search result \| query: <query>`. The meeting title never goes in `title:`. | [#233 comment 6299816580](https://github.com/Maheidem/openstyle/issues/233#issuecomment-6299816580) |
| D10 | Bundle size: build the real worker bundle first, measure the mlx-vlm growth (+410 MB site-packages), then decide or slim. | [#233 comment 6299816580](https://github.com/Maheidem/openstyle/issues/233#issuecomment-6299816580) |
| D11 | Chunks of about 300 tokens with 15% overlap. | [#233 research comment 6297569951](https://github.com/Maheidem/openstyle/issues/233#issuecomment-6297569951), spike chunker `chunk.py:12` |
| D12 | The embedding route is `/v1/embeddings` in the HTTP shim of PR #228. | [#233 body, Scope](https://github.com/Maheidem/openstyle/issues/233) |
| D13 | v1 retrieval users: search, Summary and Enhance. Summary gets a separate labeled context block. Enhance starts with names and terms only, through the existing context and vocabulary path. The inspector shows meeting ids and chunk ids. | [#234 body](https://github.com/Maheidem/openstyle/issues/234) |
| D14 | A meeting is in zero or one folder. Tags are horizontal and many per meeting. | [#230 body](https://github.com/Maheidem/openstyle/issues/230), [#231 body](https://github.com/Maheidem/openstyle/issues/231) |
| D15 | #234 quality gate: meeting-benchmarks with and without retrieval, then the council. The benchmark folder is fixed (6 meetings + 2 controls). | [#234 body](https://github.com/Maheidem/openstyle/issues/234), [#234 comment 6298292180](https://github.com/Maheidem/openstyle/issues/234#issuecomment-6298292180) |
| D16 | int8 scale: the fixed scale `x * 127` on unit vectors (S6). No calibration scale. | Owner, 2026-10-20 (answer to the former open question Q1) |
| D17 | Dictation history: v1 indexes meetings only. Dictation is a later issue. | Owner, 2026-10-20 (answer to the former Q3) |
| D18 | vec0 slot growth after deletes: accept it in v1. Track the file size (9.4). No rebuild yet. | Owner, 2026-10-20 (answer to the former Q4) |
| D19 | Model hosting: use existing Hugging Face repos that other providers publish. The owner does not publish his own conversions. Repos: 5.3. | Owner, 2026-10-20 (answer to the former Q2). Repo facts: HF API, read 2026-10-20 (5.3) |
| D20 | 8 GB Macs: ship the bf16 text-only model (`embeddinggemma-2-bf16-text`) on every Mac for now. Switch 8 GB Macs to a 4-bit model only when a provider publishes a text-only 4-bit MLX repo. This replaces the 4-bit part of D7 until then. | Owner, 2026-10-20 (answer to the former Q1) |
| D21 | Search box place: the Meetings page header. The search is scoped by the folder that is selected in the folder tree (PR #235); with no folder selected, it searches all meetings. | Owner, 2026-10-20 (answer to the former Q1) |

### 2.2 Spec decisions (made here, with the reason)

| # | Decision | Reason |
|---|---|---|
| S1 | The vec0 partition key is `folder_id TEXT`. The real folder uuid is the key. No integer surrogate. | vec0 accepts a TEXT partition key, and a folder-scoped k=10 query takes about 1.2 ms on 46,000 rows (Appendix A, probes P1 2a, P2). |
| S2 | Unfiled meetings use the empty string `''` as the partition value, not NULL. | `folder_id IS NULL` is not pushed into the KNN. It is a post-filter on the top 10 of all rows: 0 rows at 47,000 rows in 208 ms (P1 6f). `folder_id = ''` returns 10 rows in about 1.1 ms (P2). A folder id is never `''` (`F:packages/validations/src/meeting-folders.ts:3`, `min(1)`). |
| S3 | A move deletes and inserts the vec0 rows of the meeting with the stored vectors. It does not embed again. | vec0 0.1.9 refuses `UPDATE` of a partition key: "UPDATE on partition key columns are not supported yet." (P1 5a, P2). Read, delete and insert in one transaction works (P1 5d). This keeps D3: no re-embedding. |
| S4 | vec0 table option `chunk_size=64`. | With the default chunk size (1024), one transaction that inserts rows of alternating partitions made 1,820 vector chunks and a 1,511 MB file for 47,000 rows (P1 8a). With per-meeting batches, `chunk_size=64` gives the smallest file (38.4 MB vs 44.6 MB), the same query speed, and less growth after re-index (39.3 MB vs 51.1 MB) (P2). |
| S5 | Tags live in a join table `meeting_tags` (owned by #231). The KNN filters with `meeting_id IN (...)`. The vec0 row does not hold a tags column. | vec0 metadata columns take one scalar value and only `=`, `!=`, `<`, `<=`, `>`, `>=` (P1 4i: `LIKE` is illegal). `meeting_id IN (...)` is pushed into the KNN: 10 rows from the 3 meetings (P3). A tag edit then changes no vector row. The tags of a chunk are the tags of its meeting, read by join. |
| S6 | int8 quantization is a fixed scale in TypeScript: `clamp(round(x * 127), -127, 127)` on the L2-normalized vector. It is not `vec_quantize_int8()`. | An index that grows one meeting at a time cannot use a corpus-wide scale. The spike's `int8unit` arm uses this formula (`evalret.py:45-46`) and is within one query of f32 (section 2.3). `vec_quantize_int8(v,'unit')` gives other values on 355 of 768 dims (P1 3h). Owner decision D16 accepts this scale. |
| S7 | Speaker labels are not in the embedded text. | The spike measured text without labels (`chunk.py:22`). A label ("Them 2") is noise for retrieval. A rename would change every chunk hash (`F:apps/server/src/routes/meetings.ts:1857` rewrites the transcript on rename) and force a re-embed. |
| S8 | Source text per segment: `enhanced_text` when it is not empty, else `text`, read through `loadMergedTranscript`. | The spike used the same rule (`chunk.py:19-20`). `loadMergedTranscript` is the one loader of the transcript UI, Enhance, Summary and export (`apps/server/src/lib/meetings/transcript-io.ts:122-126`). It also removes echo and hallucination rows. |
| S9 | The embedding worker is its own process (`--embed`), not a route in the LLM process. | Search must work with no LLM (D6). The LLM worker stops when the user picks another LLM (`L:apps/server/src/lib/mlx-llm/server.ts:143-144`). The shim serves one request at a time (`L:scripts/mlx_asr_server.py:638-639`), so a search query must not wait behind a long LLM generation. |
| S10 | The server adds the prompts. The worker embeds the text it gets. | The worker stays a plain OpenAI-style endpoint. A later own-server path can use the same client. |
| S11 | Chunk ids come from `AUTOINCREMENT`. They are never used again. | A reused rowid can collide with a vec0 row that the garbage step (6.6) did not delete yet. |
| S12 | The vec0 table is created at run time after a successful load, not in a migration. | Migrations run inside one transaction for every user (`apps/server/src/lib/schema.ts:170-180` on `F:`). A migration that needs the extension fails where the dylib is missing (Linux CI). Without the extension, any read of the vec0 table fails with "no such module: vec0" (P1 9b). |

### 2.3 Spike numbers behind D7, D8 and S6

From #233 spike (`spike233-results.md`, hard set, vectors only, recall@10 / MRR@10, EmbeddingGemma 2 bf16):

| Dims | Vectors | PT | EN |
|---|---|---|---|
| 768 | f32 | 0.613 / 0.346 | 0.716 / 0.436 |
| 768 | int8 (corpus-wide scale) | 0.613 / 0.352 | 0.716 / 0.439 |
| 768 | int8unit (x * 127, S6) | 0.613 / 0.346 | 0.703 / 0.427 |
| 256 | f32 | 0.507 / 0.296 | 0.635 / 0.360 |

One EN query is 0.0135. So `int8unit` is one EN query below int8 and f32.

---

## 3. Data model

### 3.1 Current state

- One `DatabaseSync` per process (`apps/server/src/lib/db.ts:24`). WAL, `foreign_keys = ON` (`db.ts:26-30`). `initSchema` runs after the pragmas (`db.ts:32`).
- `SCHEMA_VERSION = 41` on PR #235 (`F:apps/server/src/lib/schema.ts:14`). Main is at 40 (`AGENTS.md:50`). Migration 41 creates `meeting_folders` with `id TEXT PRIMARY KEY` and adds `meetings.folder_id TEXT REFERENCES meeting_folders(id) ON DELETE RESTRICT` (`F:schema.ts:1121-1141`). The server makes the id with `randomUUID()` (`F:apps/server/src/routes/meeting-folders.ts:70`).
- `meeting_segments` has `text` and `enhanced_text` (`schema.ts:784-794`, `:843`). It cascades from `meetings`.
- A folder with meetings cannot be deleted (`F:meeting-folders.ts:129-139`). So a partition is empty before its folder goes.
- Moves: `POST /api/meetings/move` sets `meetings.folder_id` for up to 200 meetings, also `null` (`F:meeting-folders.ts:145-187`, `:175-177`; schema `F:packages/validations/src/meeting-folders.ts:50-53`).

### 3.2 Migration 43 (plain tables, always created)

`SCHEMA_VERSION` becomes 43. Main took 41 (folders, PR #235) and 42 (tags, PR #237) first. These tables need no extension.

```sql
-- One row per chunk of a meeting. id is the vec0 rowid (S11).
CREATE TABLE IF NOT EXISTS meeting_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,        -- 0..n-1 in transcript order
  segment_ids TEXT NOT NULL,       -- JSON array of meeting_segments.id, in order
  char_start INTEGER NOT NULL,     -- offset in the first segment's text (split segment, 4.4)
  char_end INTEGER,                -- end offset in the last segment's text; NULL = to the end
  start_ms INTEGER,
  end_ms INTEGER,
  token_estimate INTEGER NOT NULL,
  text_hash TEXT NOT NULL,         -- sha256(CHUNKER_VERSION, DOC_PROMPT, chunk text)
  model_id TEXT NOT NULL,          -- catalog id of the embedding model (D4)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_chunks_meeting
  ON meeting_chunks(meeting_id, model_id, ordinal);

-- Ids whose vec0 row must go (6.6). Filled by the trigger, also on cascade.
CREATE TABLE IF NOT EXISTS meeting_chunk_gc (chunk_id INTEGER PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS meeting_chunks_ad AFTER DELETE ON meeting_chunks
BEGIN
  INSERT OR IGNORE INTO meeting_chunk_gc(chunk_id) VALUES (old.id);
END;

-- What the index holds for each meeting. The indexer compares it with the DB.
CREATE TABLE IF NOT EXISTS meeting_index_state (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,       -- 6.3
  folder_key TEXT NOT NULL,        -- partition value of the vec0 rows; '' = unfiled
  chunk_count INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  error_kind TEXT,                 -- last failure (9.x), NULL when ok
  attempts INTEGER NOT NULL DEFAULT 0
);
```

- The trigger also fires when a meeting delete cascades to `meeting_chunks` (P3, last line: gc rows `[1,2]`).
- Migration 45 (#286) adds `kind TEXT NOT NULL DEFAULT 'transcript' CHECK(kind IN ('transcript', 'meta', 'summary'))` to `meeting_chunks`. A `meta` chunk holds the title and the tags. A `summary` chunk holds summary text. These chunks have `segment_ids = []` and no times (4.6). Old rows read as `transcript`.
- `tags (id, name)` and `meeting_tags (meeting_id, tag_id, source)` belong to #231 (migration 42, PR #237). This spec only reads them (S5). The `tags` filter takes tag names and matches any of them.

### 3.3 The vec0 table (created at run time, S12)

The search module runs this after the extension loads (6.1):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS meeting_chunk_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,                 -- = meeting_chunks.id; bind as BigInt
  folder_id TEXT PARTITION KEY,                 -- meetings.folder_id, '' when unfiled (S2)
  embedding INT8[768] DISTANCE_METRIC=cosine,   -- D8, quantized by S6
  meeting_id TEXT,                              -- metadata: =, !=, IN
  model_id TEXT,                                -- metadata: = current model only
  chunk_size=64                                 -- S4
);
```

Binding rules (proven in P1):

- `chunk_id` must be a `BigInt`. A JS number fails: "Only integers are allows for primary key values" (P1 3a). The same trap applies to an integer partition key (#82 storage comment). S1 uses TEXT, so this applies only to `chunk_id`.
- The vector must go through `vec_int8(?)` with an `Int8Array` buffer. A raw blob is read as float32 and fails (P1 3f).
- The query vector must be int8 too. A float32 query on the int8 column fails (P1 4j).
- vec0 rows take part in transactions. A `ROLLBACK` removes them (P1 5f).

### 3.4 Size

| Item | 1,000 one-hour meetings (46,000 chunks, #233 estimate) | Source |
|---|---|---|
| vec0 file share, `chunk_size=64` | 38.4 MB | P2, variant B |
| After 10% of meetings re-indexed | 39.3 MB | P2, variant B |
| `meeting_chunks` rows | about 7 MB (UNVERIFIED: about 150 bytes per row) | estimate |

The chunk text is not stored. A snippet is built from the segments at read time (7.3).

---

## 4. Chunking

Code: `apps/server/src/lib/search/chunker.ts`. It is a pure function. It runs on Linux CI.

### 4.1 Input

- `loadMergedTranscript(meetingId, row.audio_dir, db)` (`transcript-io.ts:89-145`). The spike did not merge (`chunk.py:16`). The merge removes echo rows that would make duplicate chunks.
- For each merged segment: `id`, `enhancedText ?? text` (S8, same rule as `apps/server/src/lib/meetings/workflow/chunking.ts:95-98`), `startMs`, `endMs`. Skip segments with no id or blank text, as `loadHashRows` does (`apps/server/src/lib/meetings/input-hash.ts:73-74`).
- No speaker label in the text (S7).

### 4.2 Token count without a tokenizer

The server does not load the Gemma tokenizer (vocab 262,144, #233 spike check 2). It estimates:

```ts
// CJK ideographs, kana and Hangul count 1 token each. Other text counts 1 token per 4 characters.
export function estimateEmbedTokens(text: string): number;
```

- The rule extends `estimateTokens` (`chunking.ts:13-15`, `length / 4`). That rule alone under-counts Japanese.
- The worker returns the real token count of each input (5.2). The indexer logs the mean ratio real/estimate for each run (numbers only). The #233 build check measures it on fictional PT, EN and JA text (12.4). The ratio for Portuguese is UNVERIFIED.
- The worker truncates at 512 tokens (spike `embed.py:23`). The chunk cap (400 estimated tokens) keeps a margin of 28% below that limit.

### 4.3 Rules

Constants: `CHUNK_TARGET_TOKENS = 300`, `CHUNK_MAX_TOKENS = 400`, `CHUNK_OVERLAP_TOKENS = 45` (15% of 300, D11), `CHUNKER_VERSION = 1`.

1. Join whole segments, in transcript order, with one space. Stop before the segment that would pass 300 estimated tokens.
2. A chunk always holds at least one segment or one piece (4.4).
3. Overlap: the next chunk starts with the last whole segments of the previous chunk, up to 45 tokens. This is the overlap shape of `chunkTranscript` (`chunking.ts:128-136`).
4. A tail chunk below 40 tokens joins the previous chunk, if the result stays at or below 400 tokens. The spike dropped such tails (`chunk.py:26`). Dropping text loses content, so this spec keeps it.
5. A meeting with no text gives no chunks. Its state row still records `chunk_count = 0`.

The spike used fixed windows of 300 tokens with step 255 across segment edges (`chunk.py:12`, `:23-32`). Whole-segment chunks are a change. Evidence that segments are short: the spike had 8,175 segments and 1,390 chunks of step 255 (`spike233-results.md`, Data). That is about 43 tokens per segment (derived). So most chunks hold 5 to 7 segments.

### 4.4 Long segments

A segment above 300 estimated tokens is split.

- Split it into sentences with `Intl.Segmenter(language, { granularity: "sentence" })`. `language` is `meetings.language`, else `"en"`. It needs no package. It works in Electron 39 Node for PT and JA (Appendix A, P5).
- Pack sentences into pieces of up to 300 tokens with 45 tokens of overlap. A sentence above 400 tokens is cut at word edges (`Intl.Segmenter` with `"word"`).
- `char_start` and `char_end` record the piece inside the segment text (3.2).

### 4.5 Output and hash

```ts
interface Chunk {
  ordinal: number;
  segmentIds: string[];
  charStart: number;
  charEnd: number | null;
  startMs: number | null;
  endMs: number | null;
  text: string;            // never stored (3.4)
  tokenEstimate: number;
  textHash: string;        // sha256 of JSON [CHUNKER_VERSION, DOC_PROMPT, text]
}
```

A change of `CHUNKER_VERSION` or `DOC_PROMPT` changes every hash. That re-embeds all chunks, as a model change does.

### 4.6 Title, tags and summary (#286)

Code: `buildMeetingChunks` in `apps/server/src/lib/search/source.ts`.

1. The transcript chunks come first, with ordinal 0 to n-1 (4.3).
2. Then one `meta` chunk. Its text is the title, a line break, then `Tags: <tag>, <tag>`. A meeting with no title and no tags has no meta chunk.
3. Then the `summary` chunks. The summary Markdown (`meeting_summaries.markdown`) is one long segment for the chunker. So the chunker cuts it by sentences into pieces of up to 300 tokens (4.4). `char_start` and `char_end` record the piece inside the summary text.
4. The document prompt stays `title: none | text: ` (D9). The spike showed lower recall with the meeting title in `title:`. So the title goes into the text of the meta chunk.
5. The text hash of a meta or summary chunk is sha256 of JSON `[CHUNKER_VERSION, DOC_PROMPT, kind, text]`. A transcript chunk keeps the hash of 4.5, so an upgrade embeds only the new meta and summary chunks.
6. Result: a tag, title or summary change embeds only the chunks of that kind. A transcript change does not embed the meta or summary chunks again (D5).

---

## 5. Embedding runtime

### 5.1 Current state (PR #228)

- LLM mode: `mlx_asr_worker --llm --model <hfId> --port <port>` (`L:scripts/mlx_asr_server.py:1111-1132`). It loads the model, binds `127.0.0.1`, prints one JSON ready line, serves `GET /v1/models` and `POST /v1/chat/completions` (`:1027-1072`, `:1083-1108`). It exits when stdin closes (`:1075-1080`). `freeze_support()` runs first (`:1153-1159`).
- Server: one serialized start chain, a reserved free port, `HF_HUB_OFFLINE=1`, a ready timeout, SIGTERM then SIGKILL, an idle unload (`L:apps/server/src/lib/mlx-llm/server.ts:125-167`, `:203-212`, `:293`, `:382-399`).
- Catalog, download with allow patterns, status, cancel and delete (`L:apps/server/src/lib/mlx-llm/constants.ts:32-91`, `L:mlx-llm/models.ts:109-171`). Routes under `/api/mlx-llm` (`L:apps/server/src/routes/mlx-llm.ts:37-106`).
- Worker pins in `MLX_WORKER_BUILD_SPEC` (`L:apps/server/src/lib/mlx-asr/runtime.ts:47-48`).

### 5.2 Worker: `--embed` mode

Start: `mlx_asr_worker --embed --model <hfId> --port <port>`.

- Load with `mlx_vlm.embedding_loader.load_embedding_model(path)`, as the spike did (`embed.py:5`, `:9`). Then drop the non-text towers: set `vision_tower`, `embed_vision`, `audio_tower`, `embed_audio` to `None`, run `gc.collect()` and `mx.clear_cache()` (`bench.py:8-9`). Keep bf16. Never cast to float16 (#233 research comment).
- Tokenizer: `AutoTokenizer.from_pretrained(path)`, padding right, `truncation=True`, `max_length=512` (`embed.py:23`).
- Ready line: `{"type":"ready","model":"<hfId>","port":<port>,"dims":768}`. Errors before ready: `{"type":"error","error":"<msg>"}` and exit 1, as in LLM mode.
- Reuse the LLM-mode handler shape: stdlib `http.server`, one request at a time, stdin watch, SIGTERM.

Routes:

- `GET /v1/models` returns `{"object":"list","data":[{"id":"<hfId>","object":"model"}]}`.
- `POST /v1/embeddings`:

| Field | Rule |
|---|---|
| `model` | Ignored. The loaded model answers. |
| `input` | An array of 1 to 32 strings. A single string is one input. Anything else gives 400. |
| `encoding_format` | `"float"` (default). Other values give 400. |
| `dimensions` | Absent or 768. Other values give 400. |

Response 200:

```json
{
  "object": "list",
  "model": "<hfId>",
  "data": [{ "object": "embedding", "index": 0, "embedding": [0.0123, "... 768 floats"] }],
  "usage": { "prompt_tokens": 412, "total_tokens": 412 },
  "openstyle": { "tokens": [206, 206], "truncated": [false, false] }
}
```

- `embedding` is the `text_embeds` output as float32, L2-normalized (`embed.py:24`). The worker normalizes again if the norm differs from 1 by more than 1e-3.
- `openstyle.tokens` is the real token count of each input before truncation. `openstyle.truncated` marks inputs above 512 tokens. OpenAI clients ignore the extra key.
- Errors: 400 `{"error":{"message","type":"invalid_request_error"}}`; 500 `{"error":{"message","type":"server_error"}}`. A NaN in any output is a 500 (spike check 3 saw 0 NaN; the guard stays).
- Unknown paths give 404.

Build (`scripts/build_mlx_asr_worker.sh`): add `mlx-vlm==0.7.8` (and `mlx-embeddings==0.1.0` only if the loader needs it). Raise `transformers>=5.14` to `>=5.18`: EmbeddingGemma 2 needs 5.18 for its tokenizer (#233 research comment; spike check 1). mlx stays 0.32.3: `mlx-vlm 0.7.8` needs `mlx>=0.32.3` (#233 research comment). The PR #228 spec says "Do not add mlx-vlm (needs mlx>=0.32.4)" (`L:specs/local-mlx-llm.md:34`). That note is about 0.7.9. Update it. Owner gate D10 applies before merge (12.4).

### 5.3 Catalog and download

`apps/server/src/lib/mlx-embed/constants.ts`:

```ts
export const MLX_EMBED_PROVIDER_ID = "local-mlx-embed";
export interface MlxEmbedModelDef {
  id: string;            // catalog id, stored as model_id (D4)
  hfId: string;
  displayName: string;
  dims: 768;
  quant: "bf16" | "4bit";
  sizeBytes: number;     // from the HF API tree at build time
  forLowMemory: boolean; // true for the 4-bit text-only model
}
```

| Id | HF repo | Use |
|---|---|---|
| `embeddinggemma-2-bf16-text` | `jayyun98/embeddinggemma-2-text-270m-mlx-bf16`, pinned at revision `186ecf2d29e743e0e9de0da677b13d54f76de6b3` (D19) | Default on every Mac (D20) |
| `embeddinggemma-2-4bit-text` | Not in v1. No text-only 4-bit MLX repo exists (D19, D20). Add it when a provider publishes one. | — |

Repo facts (HF API `api/models/<repo>?blobs=true`, `config.json` and the safetensors header, read 2026-10-20). All repos: license Apache-2.0, not gated, base model `google/embeddinggemma-2` (Apache-2.0, not gated, revision `914f7f89`).

| Repo | Quant | Weights | Towers in the weights | Note |
|---|---|---|---|---|
| `jayyun98/embeddinggemma-2-text-270m-mlx-bf16` | bf16 | 0.542 GB | Text only: 413 tensors, all `language_model.*` | Created 2026-10-06. `verification.json`: min cosine 0.99996 vs the fp32 source on 768 dims. README loads it with `mlx_vlm.embedding_loader.load_embedding_model`. |
| `gahabeen/embeddinggemma-2-text-270m-mlx-bf16` | bf16 | 0.542 GB | Text only | Byte-equal copy of the jayyun98 repo (same LFS sha256 `7bb43077...`). Created one day later. Fallback mirror. |
| `mlx-community/embeddinggemma-2-bf16` | bf16 | 1.489 GB | Text 0.542 + vision 0.335 + audio 0.610 GB | The spike repo (snapshot `1a4ffddb`). |
| `mlx-community/embeddinggemma-2-8bit` | 8-bit affine, g64 | 1.234 GB | Text + vision + audio (towers stay bf16) | |
| `mlx-community/embeddinggemma-2-4bit` | 4-bit affine, g64 | 1.098 GB | Text 0.153 + vision 0.335 + audio 0.610 GB | The 0.945 GB of towers stay bf16. |

- Loader version: the README of the text-only repo and of the mlx-community repos pins mlx-vlm git commit `3d87e884`. mlx-vlm 0.7.8 is not a descendant of that commit (GitHub compare: diverged, 64 ahead, 4 behind). `stefanschmidt/embeddinggemma-2-bf16` reports mlx-vlm 0.7.8 with the mlx-community bf16 weights. No repo names mlx-embeddings 0.1.0. The #233 build check proved the load on 2026-10-20: mlx-vlm 0.7.8 loads the text-only repo at `186ecf2d` (768 dims), and the frozen worker gives the same vectors as the unfrozen venv (3 fictional sentences, cosine 1.0).
- The text-only repo has no tower weights, but its `config.json` still has `vision_config` and `audio_config`. The tower drop of 5.2 is then a no-op. Keep it, so the worker also accepts a full repo.
- The text-only bf16 repo (0.542 GB) is smaller than the mlx-community 4-bit repo (1.098 GB) on disk.
- The allow list for the download is the file list above plus the config and tokenizer files. Record it at build time from the HF API tree.

- Download, progress, cancel, delete and the completeness check reuse the PR #228 path (`L:mlx-llm/models.ts:109-171`, allow patterns at `:132`). The allow list for these repos is UNVERIFIED. Read the HF API tree at build time and record it.
- The mlx-community 4-bit repo holds 0.945 GB of image and audio towers. The text tower is 0.153 GB (spike check 4, and the safetensors header read on 2026-10-20). That is why D7 says "text-only conversion".
- The two models are one vector space (D7). The index still treats them as two model ids. A switch is a full re-index (D4).

### 5.4 Server provider and lifecycle

`apps/server/src/lib/mlx-embed/server.ts` copies `mlx-llm/server.ts`:

- `ensureMlxEmbedWorker(modelId)`: one serialized chain, reserved port, `HF_HUB_OFFLINE=1`, ready timeout 180 s, SIGTERM then SIGKILL after 5 s, stop on host exit. A model that is not on disk is an error, not a download.
- Keep-alive: unload after 5 minutes idle. On a Mac with RAM <= 8 GiB, unload as soon as the index queue is empty and no query ran for 30 s. Reason: the LLM worker alone used 3.1 GiB RSS with Qwen3.5 4B (`L:specs/local-mlx-llm.md:138`). Peak memory with ASR + LLM + embedding is UNVERIFIED (spike check 4).
- Built (PR #242 and #86): `apps/server/src/lib/mlx-embed/client.ts` holds `embedTexts` (prompts, batches of 16, count and dims check). `apps/server/src/lib/search/embedder.ts` holds `quantizeInt8` and `embedInt8`, the int8 step. The sketch below was the plan:

```ts
export type EmbedKind = "document" | "query";
export const DOC_PROMPT = "title: none | text: ";        // D9
export const QUERY_PROMPT = "task: search result | query: "; // D9
export const EMBED_BATCH = 16;
/** Adds the prompt, calls POST /v1/embeddings, checks dims, quantizes (S6). */
export function embedTexts(texts: string[], kind: EmbedKind, signal: AbortSignal):
  Promise<{ vectors: Int8Array[]; tokens: number[]; modelId: string }>;
export function quantizeInt8(v: Float32Array): Int8Array; // clamp(round(x*127), -127, 127)
```

- Plain `fetch` with a Zod check of the response. The AI SDK is not used: there is no structured output and no retry ladder to reuse.
- Batch 16: the spike measured 194 to 229 chunks/s (bf16) and a peak of 1.50 GB at batch 16 (spike checks 4 and 5). One batch then takes about 80 ms, so a query waits at most about one batch.
- A response with a wrong count or wrong dims is an error (`embed_bad_response`), never a partial write.

### 5.5 Routes and UI

- `/api/mlx-embed`: `GET /status`, `POST /models/:id/download`, `POST /models/:id/cancel`, `DELETE /models/:id`, `POST /models/:id/use`. Same shapes as `/api/mlx-llm` (`L:routes/mlx-llm.ts:37-106`).
- `use` writes the setting `search_embedding_model` (new key in `packages/validations/src/settings-keys.ts`). An empty value means "no model". Search is then off with reason `no_model`.
- Models page: a group "Search model · On-device", rows like the LLM rows (download, progress, Use, Delete). Use on a new model shows: "The search index is built again. This takes some minutes." i18n in all locales plus `template.json` (`AGENTS.md:120`).

---

## 6. Indexing flow

Code: `apps/server/src/lib/search/indexer.ts`, `vec-store.ts`, `extension.ts`.

### 6.1 Start

1. `getDb()` opens the file with `{ allowExtension: true }` (`db.ts:24`). This option exists only in the constructor (P1 1a: without it, "extension loading is not allowed").
2. Right after the pragmas (`db.ts:26-30`), `tryLoadSqliteVec(instance)`:
   - Find `vec0.dylib` by a candidate list, the shape of `ffmpegBinaryCandidates` (`M:apps/server/src/lib/audio/decode.ts:98-119`): `process.resourcesPath/bin/vec0.dylib`, then `cwd/resources/bin/<platform>-<arch>/vec0.dylib`. The env var `OPENSTYLE_SQLITE_VEC_PATH` comes first (tests). The utility process gets `resourcesPath` from `OPENSTYLE_RESOURCES_PATH` (`M:apps/electron/src/server-host/entry.ts:21-26`, `M:apps/electron/src/main/server-host.ts:207-208`).
   - `instance.loadExtension(path)`, then always `instance.enableLoadExtension(false)`, also after a failure. After that call, a second load fails (P1 1c). The SQL function `load_extension()` is "not authorized" before and after (P4).
   - Check `select vec_version()` equals `v0.1.9` (P1 1d). Another value is a failure (`extension_version`).
   - Never throw. Record `{ state: "loaded" | "failed", reason, path, vecVersion }`. Log a failure once at error level, with the path and the SQLite message.
3. `initSchema` runs as today (`db.ts:32`). Migration 43 creates the plain tables (3.2).
4. If loaded: `CREATE VIRTUAL TABLE IF NOT EXISTS meeting_chunk_vec ...` (3.3). A failure here sets `state: "failed"`, reason `vec_table`.
5. `startServer` starts the indexer after the boot sweeps (`F:apps/server/src/index.ts:218-233`). It runs only when search is on (9.1).

### 6.2 Triggers

A trigger is a hint. The source hash is the truth (6.3). The indexer must be correct with no trigger at all.

`notifyMeetingChanged(meetingId)` adds the id to an in-memory set and wakes the queue. Call it at every site that writes `transcript.md`, because the code already follows the rule "every route that changes what renders must refresh transcript.md" (`F:apps/server/src/routes/meetings.ts:1854-1857`):

| Site | Event |
|---|---|
| `F:meetings.ts:939-944` | Transcribe done (also re-transcribe: `:1346-1365` deletes the old segments) |
| `F:meetings.ts:790-793`, `:905-910` | Transcribe cancelled (partial transcript kept) |
| `F:meetings.ts:1518-1529` | Retry failed chunks |
| `F:meetings.ts:1643` | Diarize (labels only, so the hash does not change) |
| `F:meetings.ts:1857` | Speaker rename (labels only) |
| `F:apps/server/src/lib/meetings/workflow/nodes/save.ts:273` | Enhance saved `enhanced_text` (`save.ts:121-127`) |
| `F:meeting-folders.ts:175-177` | Move to another folder or out of folders. Built: the move route moves the vectors in its own transaction (6.5), so a move needs no queue slot. |
| `F:meetings.ts:1998` | Meeting delete (cascade fills `meeting_chunk_gc`) |
| `setMeetingTags` (`PUT /:id/tags`) and `addSuggestedTags` (Enhance tag step), `apps/server/src/lib/meetings/tags.ts` | Tag change (meta chunk, #286) |
| `save.ts` SW3 | Summary write (summary chunks, #286). The meeting can have no `audio_dir`, so no `transcript.md` write sends the hint. |
| `PATCH /:id` with `title`, `PUT /:id/calendar`, `DELETE /:id/calendar` | Title change (meta chunk, #286) |

- Built: `writeTranscriptMarkdown` (`apps/server/src/lib/meetings/transcript-io.ts`) calls `notifyMeetingChanged`, so every site of this table that writes the file sends the hint. The delete route calls it too, so the gc drains soon.
- No route edits segment text by hand today (`F:meetings.ts` route list: `.patch("/:id")` changes `title`, `language`, `context` only, `:1246-1262`). A future manual-edit route must call `notifyMeetingChanged`. The boot scan (6.3) catches a missed call.
- An import starts a transcribe job (`AGENTS.md:31`), so it uses the transcribe trigger.

### 6.3 Queue and reconcile

The queue holds meeting ids. One worker loop handles one meeting at a time.

Sources of work:

1. The in-memory set from 6.2.
2. A boot scan, in the background: every meeting where `meeting_index_state` is missing, or `model_id` differs from the current model, or `folder_key` differs from `COALESCE(meetings.folder_id, '')`.
3. A slow scan of all meetings, one meeting per second while idle: compute the source hash and compare it with `source_hash`. This catches text changes with no trigger.

`source_hash = sha256(JSON [CHUNKER_VERSION, modelId, [[segmentId, sourceText], ...], metaText, summary])` over the input of 4.1 and 4.6. `metaText` is the text of the meta chunk or null. `summary` is the summary Markdown or null.

Gates before a meeting starts:

- The meeting has no job: `!hasJob(id)` (`apps/server/src/lib/meetings/job-registry.ts:70`). A transcribe job and a workflow run both hold the slot (`F:meetings.ts:1363`; `F:apps/server/src/lib/meetings/workflow/runner.ts:200`, `:592`). So the index waits until Enhance and Summary end, and embeds the final text once.
- No meeting job runs at all. Add `activeJobCount()` to `job-registry.ts`. Reason: the GPU and memory go to the job first.
- No dictation runs: `isDictationActive()` (`apps/server/src/lib/dictation-activity.ts:21`). The loop also checks it between batches and waits with `waitForDictationIdle` (`:73`).
- The meeting status is not `recording` or `transcribing`.

### 6.4 One meeting

1. Read the meeting row and the current model id. Build the chunks (4).
2. Compare with `meeting_index_state`:
   - Same `source_hash`, same model, same `folder_key`: done.
   - Same hash and model, other folder: run the move (6.5) and stop.
3. Read the existing `meeting_chunks` rows of the meeting for the current model. A new chunk with a `text_hash` equal to an existing row keeps that row and its vector (D5).
4. Embed the other chunks with `embedTexts(..., "document")`, in batches of 16. Check the abort signal between batches.
5. Write in one transaction (`withTransaction`, `db.ts:61-75`):
   - Compute the source hash again. If it changed, roll back and put the meeting back in the queue.
   - Delete `meeting_chunks` rows that are not kept, and all rows of other model ids for this meeting. The trigger fills `meeting_chunk_gc`.
   - Update `ordinal`, `segment_ids`, offsets and times of kept rows.
   - Insert new `meeting_chunks` rows. Insert their vec0 rows with `BigInt(id)`, `folder_key`, `vec_int8(?)`, `meeting_id`, `model_id`.
   - Drain the gc ids of this meeting (6.6).
   - Upsert `meeting_index_state` with `error_kind = NULL`, `attempts = 0`.
6. Insert all rows of one meeting in this one transaction. Never interleave rows of two meetings. Reason: S4 and P1 8a.

### 6.5 Move

In one transaction, for each vec0 row of the meeting: read `embedding`, delete the row, insert it again with the new `folder_id` (S3, P1 5d). Then set `folder_key`. Built: `POST /api/meetings/move` calls `moveMeetingIndex` inside its own transaction, so the folder column and the vectors change together. The indexer also runs the move when it finds a `folder_key` that differs. A query drops a hit whose meeting is no longer in the scope folder. A move of 46 rows is in the same range as a re-index of one meeting (P2: 100 meetings of 46 rows in about 400 ms). No embedding call.

### 6.6 Garbage collection

`meeting_chunk_gc` holds ids whose vec0 row must go. The indexer deletes `meeting_chunk_vec` rows by `chunk_id` (BigInt), then the gc rows, in one transaction. It drains the table at start and after each meeting. The delete of a search model also drains it (9.2). When search is off, the table grows. It drains at the next start with search on. vec0 rows have no foreign key, so this is the only delete path for vectors.

### 6.7 Progress, cancel and crash safety

- Progress: `GET /api/search/status` (7.4) counts eligible meetings, meetings whose state matches, meetings in error, and the queue length.
- Cancel: one `AbortController` per meeting. It aborts when the meeting gets a job, when it is deleted, at server stop, and when the model changes. The meeting goes back to the queue, except after a delete. Nothing is written for an aborted meeting.
- Crash safety: the write of one meeting is one transaction (6.4 step 5). A crash before it loses only embedding work. A crash inside it rolls back (P1 5f). The boot scan finds the meeting again (6.3).
- Errors: a failed meeting gets `error_kind` and `attempts + 1`. It waits 1 minute, 5 minutes, then 30 minutes. After 3 failures it waits for the next text change or model change.

### 6.8 Model change

`search_embedding_model` changes:

1. The queue aborts the current meeting.
2. Every `meeting_index_state.model_id` now differs, so the boot-scan rule selects all meetings.
3. Queries filter `model_id = <current>` (7.2). Meetings not done yet are not in the results. Results never mix two models (D4).
4. Each meeting deletes its old-model rows in its own write (6.4 step 5).
5. The status reports "Re-indexing N of M". At about 200 chunks/s, 46,000 chunks take about 4 minutes on an M5 Max (spike check 5). A base M1 or M2 is slower (UNVERIFIED).

---

## 7. Query flow

### 7.1 Steps

1. Validate: query text 1 to 1,000 characters after trim; `k` 1 to 50 (default 10).
2. If search is off, answer with the state (7.4). No embedding call.
3. `embedTexts([text], "query")`. Prompt D9. Quantize S6.
4. Run the KNN (7.2).
5. Join `meeting_chunks` and `meetings` on the hit ids. Drop hits with no `meeting_chunks` row (a gc row not drained yet).
6. Build snippets (7.3). Answer.

### 7.2 SQL

```sql
SELECT chunk_id, meeting_id, distance
  FROM meeting_chunk_vec
 WHERE embedding MATCH vec_int8(?)
   AND k = ?
   AND model_id = ?                    -- always (D4)
   AND folder_id = ?                   -- scope folder or '' (unfiled); absent for "all"
   AND meeting_id != ?                 -- optional exclude (8.1)
   AND meeting_id IN (?, ?, ...)       -- optional, tags (S5)
 ORDER BY distance;
```

- `score = 1 - distance` (cosine distance; a vector to itself gives distance 0, P1 4k).
- Never use `folder_id IN (...)`. vec0 then returns k rows for each partition: 20 rows for 2 folders (P3).
- Exclude several meetings with one `!=` for each id, up to 5. More ids: ask for `k + 46 * n` and filter in SQL after the KNN.
- Tags: resolve the tag set to meeting ids from `meeting_tags` (any tag matches). Up to 500 ids go in one `IN` list. More ids: run one KNN per 500 ids and merge by score.
- Speed on 46,000 rows (P2, Electron runtime): one folder about 1.0 to 1.4 ms, all meetings about 25 ms. The embedding call is the larger cost (UNVERIFIED for a cold worker; 12.4 measures the load time).

### 7.3 Snippet

Read the current text of `segment_ids` (`COALESCE(NULLIF(enhanced_text,''), text)`), cut by `char_start` and `char_end`, join with spaces, and cut to 400 characters. If the text changed after the index write, the snippet shows the new text and the meeting is already in the queue.

- A `meta` hit: the current title and tags, as in 4.6.
- A `summary` hit: the current summary Markdown, cut by `char_start` and `char_end`.

### 7.4 Routes and UI

`apps/server/src/routes/search.ts`, mounted at `/search` in `apps/server/src/routes/index.ts` (next to `.route("/meetings", ...)`, `F:routes/index.ts:47-49`). Schemas in `packages/validations/src/search.ts`.

- `GET /api/search/status` returns `{ state: "on" | "off", reason: SearchOffReason | null, model_id, vec_version, meetings: { eligible, indexed, failed, queued }, index: { db_bytes, vector_chunks, embedded_chunks } }` (`index` from 9.4, D18). `embedded_chunks` counts the chunks that this server process sent to the model. The E2E (12.3 steps 4 and 6) reads it to prove that no embedding call ran.
- `POST /api/search/meetings` with `{ query, folder_id?: string | "none", tags?: string[], k? }` returns `{ status: "ok", hits: [{ chunk_id, kind, meeting_id, meeting_title, started_at, folder_id, score, start_ms, end_ms, snippet }] }` (`kind`: `transcript`, `meta` or `summary`, 4.6), or `{ status: "off", reason }` with 200, so the UI renders a state, not an error. `folder_id: "none"` means unfiled, as the list filter of PR #235 (`F:meetings.ts:1109`).
- Errors: 400 bad input; 503 `{ code: "worker_unavailable" }` when the embedding worker does not start.
- UI: a search box in the Meetings page header. Its scope follows the folder filter of PR #235. A result shows the meeting title, date, snippet and score order. A transcript hit also shows its time. A meta hit shows "Title and tags". A summary hit shows "Summary". When search is off, the box is disabled and shows the reason text (9.1). i18n as in 5.5.
- A click on a result opens the meeting (#286):
  - A transcript hit selects the Transcript tab. The transcript scrolls to the segment that starts nearest to `start_ms` (the first segment of the chunk) and marks it (`data-search-hit`).
  - A summary hit selects the Summary tab.
  - A meta hit opens the meeting at the top.

---

## 8. Retrieval API

Code: `apps/server/src/lib/search/retrieve.ts`. Search (7), Summary and Enhance (#234) call only this API. It reads the index. It never writes it.

### 8.1 Contract

```ts
export type RetrievalScope =
  | { kind: "all" }
  | { kind: "folder"; folderId: string }
  | { kind: "unfiled" };

export type RetrievalQuery =
  | { kind: "text"; text: string }        // search: embeds with QUERY_PROMPT
  | { kind: "meeting"; meetingId: string }; // Summary, Enhance: the meeting's own chunks

export interface RetrieveInput {
  query: RetrievalQuery;
  scope: RetrievalScope;
  tags?: readonly string[];               // tag names, any-of (S5)
  k: number;                              // 1..50
  excludeMeetingIds?: readonly string[];  // Summary and Enhance pass their own meeting
  signal?: AbortSignal;
}

export interface RetrievalHit {
  chunkId: number;
  meetingId: string;
  score: number;        // 1 - cosine distance
  ordinal: number;
  kind: "transcript" | "meta" | "summary"; // 4.6
  startMs: number | null; // null for meta and summary
  endMs: number | null;
}

export type RetrieveResult =
  | { status: "ok"; modelId: string; hits: RetrievalHit[] }
  | { status: "off"; reason: SearchOffReason }
  | { status: "error"; kind: "worker_unavailable" | "embed_bad_response" | "cancelled" };

export type SearchOffReason =
  | "unsupported_platform"   // not darwin-arm64
  | "extension_missing"      // no vec0.dylib found
  | "extension_load_failed"  // dlopen or init error
  | "extension_version"      // vec_version() is not v0.1.9
  | "vec_table"              // CREATE VIRTUAL TABLE failed
  | "no_model";              // no embedding model chosen or on disk

export function retrieve(input: RetrieveInput): Promise<RetrieveResult>;
/** Text of hits for prompts and snippets (7.3). No text is stored. */
export function hitText(hit: RetrievalHit, maxChars: number): string;
```

- Hits are sorted by score, highest first. A chunk id appears once.
- `query.kind = "meeting"`:
  - If the meeting's `meeting_index_state` matches its current source hash and model, use up to 8 of its stored vectors, evenly spaced by ordinal. Read them with `SELECT embedding FROM meeting_chunk_vec WHERE chunk_id = ?`.
  - Else build the chunks now (4, 4.6), pick up to 8, and embed them with `DOC_PROMPT`. Do not store them. Reason: during a workflow run the meeting holds its job slot, so the indexer has not indexed it yet (6.3).
  - Run one KNN per vector, merge by the highest score per chunk, keep the top `k`.
- A scope `folder` with an unknown folder gives `ok` with no hits.

### 8.2 Users

| User | Call | Uses from the result |
|---|---|---|
| Search (v1) | `query: text`, scope from the UI, `k: 10` | hits and `hitText` for snippets |
| Summary (#234) | `query: meeting`, `scope: folder` of the meeting, `excludeMeetingIds: [self]`, `k` from the #234 benchmark | `hitText` of the hits, in a separate labeled block (8.3) |
| Enhance (#234) | the same call | only the meeting ids of the hits, for names and terms (8.3) |

An unfiled meeting has no folder, so Summary and Enhance skip retrieval.

### 8.3 #234 hook-in (design frame; #234 owns the details)

- Where: `prepare` builds the inputs of every LLM node once (`F:apps/server/src/lib/meetings/workflow/nodes/prepare.ts:154-177`). It already reads `context` (`:158`) and the vocabulary (`:107`). It calls `retrieve()` once, when the meeting has a folder and search is on. An `off` or `error` result means "no project memory". It never fails the run (D2).
- Enhance, names and terms only (D13): for the hit meetings, collect confirmed speaker names (`meeting_speakers.display_name`) and `extractContextTerms(meetings.context)` (`apps/server/src/lib/meetings/context-terms.ts:166`). Merge them into the vocabulary terms of the correct prompt (`F:apps/server/src/lib/meetings/workflow/prompts.ts:27-33`, block `:29-31`). Cap them at `CONTEXT_TERMS_MAX` (`context-terms.ts:36`). No chunk text reaches Enhance. Reason: cross-segment copying (#185 round r185-4) and invented completions (#211), as #234 says.
- Summary: a new block next to `withContext` (`prompts.ts:135-140`), with this label: "Earlier meetings in this folder. Reference only. This text is not part of this meeting." It holds `hitText` of the hits with the meeting title and date, under a token cap that the #234 benchmark sets.
- Record: the run stores `{ modelId, meetingIds, chunkIds }` of the retrieval in the run record, so the inspector shows it (D13). No text is stored.
- Gate: D15.

### 8.4 #234 as built (PR #299)

Code: `apps/server/src/lib/meetings/workflow/folder-memory.ts`.

- On by default: setting `meeting_project_memory` (a missing row means on; only `"false"` turns it off; owner order 2026-10-26, reverses the 2026-10-22 default-off). The 3-run Gemma 4 E2B benchmark on the #234 folder lost summary items and made more owner errors with it on (see #234). Off means no `retrieve()` call and prompts byte-equal to main. Settings > Meetings has a switch (owner order 2026-10-26) that writes the same key.

- `prepare` calls `loadFolderMemory` once, only for a meeting with a folder. It calls `retrieve()` only when `searchState()` is `on` and an earlier meeting of the folder has `summary` or `transcript` rows for the search model. Reason: a `meeting` query of a meeting that is not indexed embeds up to 8 chunks, and that work is useless when the folder has no index rows.
- The call: `query: meeting`, `scope: folder`, `excludeMeetingIds: [self, ...later]`, `k: 12`, a 60 s timeout joined with the run signal. "Later" = a folder meeting whose `COALESCE(started_at, created_at)` is after this meeting's. Reason: the block says "Earlier meetings", and a later meeting holds facts that did not exist yet. A meeting with no time counts as earlier. The index-row check above looks only at earlier meetings.
- Kinds: `summary` and `transcript` only (MEM decision on #234, 2026-10-21). `meta` hits and hits of the meeting itself are dropped after the call.
- Summary block: at most 6 snippets, each `hitText(hit, 320)` with the white space collapsed, at most 2,000 characters with the label. The label is "Earlier meetings in this folder (for context only; do not copy; facts of THIS meeting come only from its transcript):". One line per snippet, oldest meeting first: `- <YYYY-MM-DD> (earlier summary|earlier transcript): <text>`. No title (the #239 benchmark found folder words read as a company). The block goes after the context block of the `single` and `reduce` prompts only. `map` prompts and the transcript never get it.
- Enhance: `extractFolderTerms` takes the names and terms of the used snippets (capitalized words that do not start a sentence, a name at the start of a sentence, mixed-case words, acronyms; no day or month names), most frequent first, at most 20. They join the vocabulary of the correct prompt after the user's own terms (`mergeTerms`). No snippet text reaches the correct prompt (test `workflow-folder-memory.test.ts`).
- Record: `llm_runs.result_json.retrieval = { modelId, meetingIds, chunkIds }` of the used snippets. `LlmRunInfo.retrieval` reads it. The run view of the inspector lists the ids. No new table, no migration.
- Off, error, timeout or no hit: `null`, a log line with the reason, and the same prompts as before #234.

---

## 9. Failure modes

### 9.1 Search off

One switch: `searchState()` returns `on`, or `off` with a `SearchOffReason` (8.1).

| Cause | Reason | What the user sees | What keeps working |
|---|---|---|---|
| Not darwin-arm64 (Linux CI, Windows, Intel) | `unsupported_platform` | Search box disabled: "Search is not available on this computer." | Everything else |
| `vec0.dylib` not found | `extension_missing` | Same text, plus "Reinstall Openstyle." | Everything else |
| dlopen or init error | `extension_load_failed` | Same as above | Everything else |
| `vec_version()` is not `v0.1.9` | `extension_version` | Same as above | Everything else |
| vec0 table not created | `vec_table` | Same as above | Everything else |
| No embedding model | `no_model` | "Download a search model in Models." with a link | Everything else; the index waits |

- In all off states: meetings, Enhance and Summary run as today. #234 retrieval is off (D2). The indexer does not run. `meeting_chunk_gc` keeps growing until search is on again.
- Only `extension.ts` and `vec-store.ts` touch the vec0 table. Each call checks the state first. Reason: a read without the module fails with "no such module: vec0" (P1 9b). `DROP TABLE` also fails without it (P1 9d). `PRAGMA integrity_check` stays `ok` (P1 9e).
- The dylib has `minos 14.0` (`vtool -show-build`). The app's `LSMinimumSystemVersion` is `14.0` (`mac.minimumSystemVersion` in `electron-builder.yml`, issue #274), so the gap is closed: macOS 12 and 13 cannot start the app.

### 9.2 Model missing or deleted

- Delete of a model (built in #286): stop the worker, and set `search_embedding_model` to empty when it is the search model (state `no_model`). Then, in one transaction, delete all index rows of that model id: `meeting_chunks` (the trigger fills `meeting_chunk_gc`), `meeting_index_state`, and the vec0 rows through the gc drain (6.6). With search off, the gc ids wait for the next start with search on. Rows of other model ids stay. A later Use of the same model id indexes every meeting again.
- The indexer handles the delete separately. The delete sends a hint (`notifySearchModelDeleted`). The indexer aborts the meeting that embeds with that model, empties its queue, and runs the boot scan again at the next Use. The write transaction checks the model again, so an embed that ends after the delete writes nothing. A worker stop caused by the delete is not a failure: no `error_kind` is recorded.
- The snapshot is incomplete: `ensureMlxEmbedWorker` refuses it, as `ensureMlxLlmWorker` does (`L:mlx-llm/server.ts:145-149`).

### 9.3 Worker down

- Start fails or the ready timeout passes: the query answers 503 `worker_unavailable`. The indexer marks the meeting `worker_unavailable` and backs off (6.7).
- The worker dies during a batch: the fetch fails, the meeting aborts with no write, and the next call starts the worker again (one start chain).
- A bad response (wrong count, wrong dims, NaN) is `embed_bad_response`. Nothing is written.

### 9.4 Database size and health

- Growth: about 38 MB of vectors for 1,000 one-hour meetings, plus slots that deletes leave (P2: +0.9 MB after 10% of meetings re-indexed with `chunk_size=64`). D18 accepts this growth in v1. No rebuild in v1.
- Track the size: after each gc drain (6.6), the indexer logs the database file size and the row count of `meeting_chunk_vec_vector_chunks00` (numbers only). `GET /api/search/status` returns them as `index: { db_bytes, vector_chunks }`. A later issue adds a rebuild if the data shows a need.
- The insert pattern of S4 is a rule, not an option. P1 8a shows 1,511 MB when it is broken.
- A delete of a meeting removes its base rows by cascade at once. Its vectors go at the next gc drain (6.6). Until then, the query join drops them (7.1 step 5).

---

## 10. Privacy

- No meeting text, chunk text, query text or snippet goes to a log, an error message, a trace or a URL. This follows the gateway rule (`M:specs/meeting-enhance-agentic.md:2093`). Logs may hold: meeting id, chunk counts, token counts, timings, error kinds, the dylib path and the SQLite error message.
- The worker logs only counts and errors on stderr. It must not log `input`.
- The worker binds `127.0.0.1` only. The search routes sit behind the existing trust boundary: trusted origin, CORS allowlist and bearer auth (`AGENTS.md:48`).
- The query text is not stored. The index stores no text (3.4).
- MLflow export: the retrieval record of #234 holds ids only (D13).
- No network call: the worker runs with `HF_HUB_OFFLINE=1` (`L:mlx-llm/server.ts:293`). Only the model download goes to Hugging Face, as for the other built-in models.

---

## 11. Packaging and signing

### 11.1 Current state

- `extraResources` copies `resources/bin/${platform}-${arch}` to `Contents/Resources/bin`, outside `app.asar` (`apps/electron/electron-builder.yml:36-40`). `node_modules/**` is not shipped (`:28`). So the npm `getLoadablePath()` path does not exist in the app (#82 storage comment).
- `resources/bin/` is not in git (`.gitignore:47`). `build:mac` runs `compile:native` and `download:ffmpeg` before the build (`apps/electron/package.json:25`).
- The helper processes inherit `entitlements.mac.plist`, which disables library validation (`electron-builder.yml:53-54`; `apps/electron/build/entitlements.mac.plist:16`).
- The npm dylib: `Mach-O 64-bit dynamically linked shared library arm64`, 161,896 bytes, `Signature=adhoc`, `flags=0x20002(adhoc,linker-signed)`, links only `libSystem.B.dylib`, sha256 `193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793` (commands in this session on `sqlite-vec-darwin-arm64@0.1.9`).

### 11.2 Changes

1. Add `sqlite-vec-darwin-arm64` `0.1.9` (exact) as a devDependency of `apps/electron`.
2. New script `apps/electron/scripts/copy-sqlite-vec.mjs`. It copies `vec0.dylib` to `resources/bin/darwin-arm64/vec0.dylib`. It checks the sha256 above and fails on a mismatch. It does nothing on other platforms. Run it in `build:mac` after `compile:native`, and add a `copy:sqlite-vec` script for local dev. Add the script to `knip.jsonc` if knip reports it.
3. The signed build re-signs the nested dylib. The installed `Resources/bin/ffmpeg` shows `Authority=Openstyle Release` (#82 storage comment). The dylib must show the same.
4. The macOS CI build job (`.github/workflows/build.yml:259`) already checks helpers in the app (`:414`, `:437`). Add: `test -f "$app/Contents/Resources/bin/vec0.dylib"` and `codesign -dv` on it.

### 11.3 First build check (blocks #86)

The #82 storage comment says the load in a real `utilityProcess` of a signed app is NOT tested. P1 ran under Electron 39.8.10 as Node (`ELECTRON_RUN_AS_NODE=1`), not in a utility process of a signed app. So the first build must prove:

1. `pnpm --filter @openstyle/electron build:mac` with the release certificate.
2. `codesign -dv --verbose=2 Openstyle.app/Contents/Resources/bin/vec0.dylib` shows `Authority=Openstyle Release` and `flags=0x10000(runtime)`.
3. Start the built app isolated (live-testing skill, Test Runner, quiet mode). `GET /api/search/status` returns `vec_version: "v0.1.9"` and no `extension_*` reason.
4. Rename the dylib in a copy of the app. The same call returns `extension_missing`. Meetings still open, and Enhance still starts.

---

## 12. Test plan and Done-when

Rules: fictional meetings only in tests and E2E. Real meetings only through the meeting-benchmarks skill, read-only, numbers only. Local app runs go through `scripts/test-runner/run.sh`. Take the GPU lock before MLX loads.

### 12.1 Unit tests (server, run on Linux CI)

- `chunker.test.ts`: whole segments; overlap of 45 tokens; long segment split by sentences (PT, EN, JA fictional text); tail merge; enhanced text wins; empty meeting; stable `text_hash`; a `CHUNKER_VERSION` change changes every hash.
- `estimate-tokens.test.ts`: CJK counts 1 per character; Latin text counts 1 per 4 characters.
- `quantize.test.ts`: `quantizeInt8` gives `clamp(round(x*127))`; values at ±1 give ±127.
- `embedder.test.ts` with a fake worker: prompts D9 added; batches of 16; wrong dims or count is `embed_bad_response`; abort between batches.

### 12.2 Server tests

Two modes, both on Linux CI:

- **OFF mode** (the default; no dylib): migration 43 creates the plain tables and no vec0 table; `GET /api/search/status` returns `off` with `unsupported_platform` or `extension_missing`; `POST /api/search/meetings` returns `{ status: "off" }`; transcribe, Enhance and Summary routes pass unchanged; a meeting delete fills `meeting_chunk_gc`; no code path reads `meeting_chunk_vec`.
- **ON mode**: add `sqlite-vec-linux-x64@0.1.9` as a server devDependency and set `OPENSTYLE_SQLITE_VEC_PATH` in these test files only. It is never packaged. Tests: load and `enableLoadExtension(false)`; vec0 table created; index of a fictional meeting with a fake embedder; second run embeds 0 chunks (hash skip); Enhance text change embeds only changed chunks; move keeps the vectors (byte-equal read back) and changes the partition; unfiled uses `''`; delete drains gc; model change re-indexes and queries never mix model ids; crash in the write (thrown inside the transaction) leaves the old state; BigInt binding; folder scope, exclude and tag `IN` filters.

### 12.3 E2E (isolated app, fictional meetings)

Seed 6 fictional meetings: 3 in folder "Aurora" (PT and EN), 2 in folder "Atlas", 1 unfiled. One Aurora meeting says, in other words, "the launch moves to Friday".

1. Download the search model on the Models page and press Use. Screenshot the row.
2. Wait for `meetings.indexed = 6` in `GET /api/search/status`.
3. Search "when is the release date" in folder Aurora. The first hit is the "Friday" chunk. Screenshot the result list. Read back the hit `chunk_id` from `meeting_chunks`.
4. Move that meeting to Atlas. Read back: the vec0 row has `folder_id` = Atlas, the vector bytes are equal, and no embedding call ran (worker request count from the fake count in the status, or the worker log line count).
5. Search in Aurora again: that meeting is gone. Search in Atlas: it is there.
6. Restart the app. The status shows 6 indexed and the queue at 0 (no re-embed).

### 12.4 Done-when per issue

**#82 (this spec):** the spec is in `specs/local-semantic-search.md`, and Appendix A holds the real probe output. The owner answers the open questions or accepts the defaults.

**#233 (built-in embedding model):**

1. D10 gate: build the real PyInstaller worker with `mlx-vlm==0.7.8`. Record the archive size before and after. The owner decides or the build drops unused packages.
2. `pip check` clean, `mlx.__version__ == 0.32.3`, `transformers >= 5.18` in the frozen worker.
3. The frozen worker `--embed` with each catalog model answers `POST /v1/embeddings` with 768 floats per input, norm 1 ± 1e-3, no NaN. Record the load time and the peak RSS.
4. Token check: the ratio of `openstyle.tokens` to `estimateEmbedTokens` on 100 fictional PT, EN and JA chunks. Each language within 0.75 to 1.33. Else change the estimate rule.
5. Peak memory with the ASR worker and the LLM worker loaded, on the owner's Mac. Record it.
6. E2E in an isolated app: download the model, press Use, and read back the vector count and dims (#233 body).

**#86 (index):**

1. The first build check passes (11.3).
2. Server tests of 12.2 pass in CI, OFF and ON mode.
3. E2E 12.3 passes, with screenshots and the read-back values.
4. A benchmark run on a read-only copy of the owner's DB (meeting-benchmarks skill): index all meetings, record chunk count, time, file growth, and recall@10 on the hard query set of the spike with the whole-segment chunker (4.3). The result must be within 2 queries of the spike row "EG2 bf16, 768, int8unit". Else review the chunker.

**#234 (hook-in):**

1. `retrieve({ query: meeting, scope: folder })` is called once in `prepare`, only for a meeting in a folder with search on.
2. Enhance gets names and terms only. A test checks that no chunk text reaches the correct prompt.
3. The Summary prompt has the labeled block. The run record holds `meetingIds` and `chunkIds`. The inspector shows them.
4. E2E with fictional meetings (#234 body): a Summary of a new Aurora meeting cites the earlier "Friday" decision. A meeting outside the folder does not get it. Read back from the run record.
5. With search off (dylib renamed), Summary and Enhance run with no retrieval and no error.
6. meeting-benchmarks with and without retrieval on the D15 folder, then the council. Release only on consensus.

---

## 13. Open questions

Only items that no owner decision covers.

None. The owner answered every open question on 2026-10-20 (D16 to D21).

---

## Appendix A: probe output

Synthetic random vectors only. No meeting data. Scripts and output files are in the coordinator scratchpad, folder `spec82/`: `probe.mjs` (P1), `probe-layout.mjs` (P2), `probe-filters.mjs` (P3), `probe-sqlfn.mjs` (P4), and the `*.txt` outputs. Package: `sqlite-vec@0.1.9` from npm (`sqlite-vec-darwin-arm64/vec0.dylib`). Runtimes: Homebrew Node 22.23.2 (SQLite 3.53.4) and Electron 39.8.10 as Node (`ELECTRON_RUN_AS_NODE=1`, Node 22.22.1, SQLite 3.51.2), the app's own runtime. Mac: Apple M5 Max.

Command shape:

```
DY=$PWD/node_modules/sqlite-vec-darwin-arm64/vec0.dylib
EL=<repo>/node_modules/.pnpm/electron@39.8.10/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
/opt/homebrew/opt/node@22/bin/node probe.mjs "$DY"
ELECTRON_RUN_AS_NODE=1 "$EL" probe.mjs "$DY"
```

### P1. Features, binding, filters, move, timing (`probe.mjs`)

Section 6 inserts 46,000 rows in ONE transaction, alternating 25 folders and NULL row by row. That is the bad pattern of S4. Its timings and size show that pattern, not the production layout. P2 shows the production layout.

Electron 39.8.10 as Node:

```
runtime: {"node":"22.22.1","electron":"39.8.10","sqlite":"3.51.2"}
1a load without allowExtension: ERROR ERR_INVALID_STATE extension loading is not allowed
1b load with allowExtension: OK
1c second load after enableLoadExtension(false): ERROR ERR_INVALID_STATE extension loading is not allowed
1d vec_version(): v0.1.9
2a create vec0 (text partition key, int8[768] cosine, text metadata, aux): OK
2b shadow tables: ["meeting_chunk_vec","meeting_chunk_vec_auxiliary","meeting_chunk_vec_chunks","meeting_chunk_vec_info","meeting_chunk_vec_metadatachunks00","meeting_chunk_vec_metadatachunks01","meeting_chunk_vec_metadatatext00","meeting_chunk_vec_metadatatext01","meeting_chunk_vec_rowids","meeting_chunk_vec_vector_chunks00"]
3a chunk_id as JS number: ERROR ERR_SQLITE_ERROR Only integers are allows for primary key values on meeting_chunk_vec
3b chunk_id as BigInt: {"lastInsertRowid":2,"changes":1}
3c folder_id NULL (unfiled): {"lastInsertRowid":3,"changes":1}
3d folder_id '' (empty string): {"lastInsertRowid":4,"changes":1}
3e embedding via vec_quantize_int8(float32 blob,'unit'): {"lastInsertRowid":5,"changes":1}
3f raw Int8 blob without vec_int8(): ERROR ERR_SQLITE_ERROR Inserted vector for the "" column is expected to be of type , but a float32 vector was provided.
3g rows: [{"chunk_id":2,"folder_id":"6f1c2c1e-0b9a-4f4e-9d61-1a2b3c4d5e6f","meeting_id":"m-a"},{"chunk_id":3,"folder_id":null,"meeting_id":"m-b"},{"chunk_id":4,"folder_id":"","meeting_id":"m-c"},{"chunk_id":5,"folder_id":"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d","meeting_id":"m-d"}]
3h vec_quantize_int8 'unit' equals JS round(x*127): {"differingDims":355,"sqlFirst5":[4,3,-1,0,1],"jsFirst5":[5,4,-1,1,2]}
4a KNN folder_id = F1: [[2,"6f1c2c1e-0b9a-4f4e-9d61-1a2b3c4d5e6f"]]
4b KNN folder_id IS NULL: [[3,null]]
4c KNN folder_id = '': [[4,""]]
4d KNN no folder filter (all partitions): [[4,""],[5,"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d"],[3,null],[2,"6f1c2c1e-0b9a-4f4e-9d61-1a2b3c4d5e6f"]]
4e KNN meeting_id != 'm-a': [[4,"m-c"],[5,"m-d"],[3,"m-b"]]
4f KNN meeting_id IN ('m-a','m-d'): [[5,"m-d"],[2,"m-a"]]
4g KNN meeting_id IN (subquery): [[2,"m-a"]]
4h KNN model_id = 'eg2' AND folder_id = F2: [[5,"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d"]]
4i KNN meeting_id LIKE: ERROR ERR_SQLITE_ERROR An illegal WHERE constraint was provided on a vec0 metadata column in a KNN query. Only one of EQUALS, GREATER_THAN, LESS_THAN_OR_EQUAL, LESS_THAN, GREATER_THAN_OR_EQUAL, NOT_EQUALS is allowed.
4j KNN with float32 query against int8 column: ERROR ERR_SQLITE_ERROR Query vector for the "embedding" column is expected to be of type int8, but a float32 vector was provided.
4k distance of a vector to itself (cosine): {"chunk_id":7,"distance":0}
5a UPDATE partition key folder_id F1 -> F2 (chunk 2): ERROR ERR_SQLITE_ERROR UPDATE on partition key columns are not supported yet. 
5b UPDATE metadata meeting_id (chunk 2): {"lastInsertRowid":7,"changes":1}
5c rows after updates: [[2,"6f1c2c1e-0b9a-4f4e-9d61-1a2b3c4d5e6f","m-z"],[3,null,"m-b"],[4,"","m-c"],[5,"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d","m-d"],[7,"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d","m-e"]]
5d move by read vector + delete + insert (no re-embed): {"chunk_id":2,"folder_id":"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d"}
5e DELETE WHERE meeting_id = (metadata): 1
5f rollback removes vec0 inserts: {"before":4,"after":4}
6a insert 46,000 rows, one transaction (ms): 10654
6b insert 1,000 rows into a 46k table, one transaction (ms): 81
6c k=10 one folder (~1,800 rows): {"medianMs":1.27,"rows":10}
6d k=10 one folder, exclude one meeting: {"medianMs":1.21,"rows":10}
6e k=10 all 47k rows: {"medianMs":197.77,"rows":10}
6f k=10 unfiled (folder_id IS NULL): {"medianMs":208.48,"rows":0}
7 vec0 top10 equals JS brute-force cosine top10 (int8, one folder): 10/10 queries
8a DB file size after 47k int8 rows (MB, before checkpoint of WAL): 1511.3
9a sqlite_master read without extension: 10
9b SELECT from vec0 table without extension: ERROR ERR_SQLITE_ERROR no such module: vec0
9c SELECT from a shadow table without extension: 47000
9d DROP vec0 table without extension: ERROR ERR_SQLITE_ERROR no such module: vec0
9e PRAGMA integrity_check without extension: {"integrity_check":"ok"}
```

Node 22.23.2 gave the same results for every line except the timings: 6a 10,599 ms, 6b 97 ms, 6c 1.31 ms, 6d 1.28 ms, 6e 240.56 ms, 6f 202.74 ms (0 rows), 8a 1,511.3 MB.

Shadow tables after P1 section 6 (Node 22): `meeting_chunk_vec_chunks` 1,820 rows; `meeting_chunk_vec_vector_chunks00` 1,820 rows; `sum(length(vectors))` = 1,431,306,240 bytes. 1,820 chunks x 1,024 slots x 768 bytes = 1,431,306,240. So each vector chunk held about 26 rows.

Notes on P1:

- 4b passes only because the table is small. 6f shows that `IS NULL` is a post-filter: 0 rows at scale (S2).
- 5e shows that `DELETE ... WHERE meeting_id = ?` works on a metadata column. The indexer still deletes by `chunk_id` (6.6), because the gc ids are known.

### P2. Storage layout under the production insert order (`probe-layout.mjs`)

1,000 meetings x 46 int8[768] rows. One transaction per meeting. Each meeting is in a random folder of 25 folders or unfiled (`''`). Then 100 meetings are deleted and inserted again. Then one `UPDATE` of `folder_id`.

Node 22.23.2, four variants:

```
A_partition_default runtime: {"node":"22.23.2","electron":null,"sqlite":"3.53.4"}
A_partition_default insert 1,000 meetings x 46 rows, one transaction per meeting (ms): 3369
A_partition_default vector chunks / file MB: {"chunks":54,"mb":44.6}
A_partition_default rows in the timed folder: 1978
A_partition_default k=10 one folder: {"medianMs":1.25,"rows":10}
A_partition_default k=10 one folder, exclude one meeting: {"medianMs":1.21,"rows":10}
A_partition_default k=10 unfiled ('' sentinel): {"medianMs":1.09,"rows":10}
A_partition_default k=10 all meetings: {"medianMs":26.73,"rows":10}
A_partition_default re-index 100 meetings (delete 46 + insert 46 each) (ms): 469
A_partition_default after churn: vector chunks / file MB / rows: {"chunks":62,"mb":51.1,"rows":46000}
A_partition_default UPDATE folder_id of one row: {"result":"ERROR UPDATE on partition key columns are not supported yet. ","before":"00000000-0000-4000-8000-000000000006","after":"00000000-0000-4000-8000-000000000006"}
B_partition_chunk64 runtime: {"node":"22.23.2","electron":null,"sqlite":"3.53.4"}
B_partition_chunk64 insert 1,000 meetings x 46 rows, one transaction per meeting (ms): 3361
B_partition_chunk64 vector chunks / file MB: {"chunks":730,"mb":38.4}
B_partition_chunk64 rows in the timed folder: 1978
B_partition_chunk64 k=10 one folder: {"medianMs":1.04,"rows":10}
B_partition_chunk64 k=10 one folder, exclude one meeting: {"medianMs":1.12,"rows":10}
B_partition_chunk64 k=10 unfiled ('' sentinel): {"medianMs":1.03,"rows":10}
B_partition_chunk64 k=10 all meetings: {"medianMs":24.8,"rows":10}
B_partition_chunk64 re-index 100 meetings (delete 46 + insert 46 each) (ms): 402
B_partition_chunk64 after churn: vector chunks / file MB / rows: {"chunks":748,"mb":39.3,"rows":46000}
B_partition_chunk64 UPDATE folder_id of one row: {"result":"ERROR UPDATE on partition key columns are not supported yet. ","before":"00000000-0000-4000-8000-000000000006","after":"00000000-0000-4000-8000-000000000006"}
C_metadata_default runtime: {"node":"22.23.2","electron":null,"sqlite":"3.53.4"}
C_metadata_default insert 1,000 meetings x 46 rows, one transaction per meeting (ms): 3519
C_metadata_default vector chunks / file MB: {"chunks":45,"mb":40.7}
C_metadata_default rows in the timed folder: 1978
C_metadata_default k=10 one folder: {"medianMs":20.14,"rows":10}
C_metadata_default k=10 one folder, exclude one meeting: {"medianMs":23.04,"rows":10}
C_metadata_default k=10 unfiled ('' sentinel): {"medianMs":5.68,"rows":10}
C_metadata_default k=10 all meetings: {"medianMs":23.93,"rows":10}
C_metadata_default re-index 100 meetings (delete 46 + insert 46 each) (ms): 448
C_metadata_default after churn: vector chunks / file MB / rows: {"chunks":46,"mb":41.5,"rows":46000}
C_metadata_default UPDATE folder_id of one row: {"result":{"lastInsertRowid":50600,"changes":1},"before":"00000000-0000-4000-8000-000000000006","after":"00000000-0000-4000-8000-000000000007"}
D_metadata_chunk256 runtime: {"node":"22.23.2","electron":null,"sqlite":"3.53.4"}
D_metadata_chunk256 insert 1,000 meetings x 46 rows, one transaction per meeting (ms): 3589
D_metadata_chunk256 vector chunks / file MB: {"chunks":180,"mb":41.2}
D_metadata_chunk256 rows in the timed folder: 1978
D_metadata_chunk256 k=10 one folder: {"medianMs":21.51,"rows":10}
D_metadata_chunk256 k=10 one folder, exclude one meeting: {"medianMs":27.02,"rows":10}
D_metadata_chunk256 k=10 unfiled ('' sentinel): {"medianMs":7.75,"rows":10}
D_metadata_chunk256 k=10 all meetings: {"medianMs":33.37,"rows":10}
D_metadata_chunk256 re-index 100 meetings (delete 46 + insert 46 each) (ms): 664
D_metadata_chunk256 after churn: vector chunks / file MB / rows: {"chunks":181,"mb":41.5,"rows":46000}
D_metadata_chunk256 UPDATE folder_id of one row: {"result":{"lastInsertRowid":50600,"changes":1},"before":"00000000-0000-4000-8000-000000000006","after":"00000000-0000-4000-8000-000000000007"}
```

Electron 39.8.10 as Node, variants B and A:

```
B_partition_chunk64 runtime: {"node":"22.22.1","electron":"39.8.10","sqlite":"3.51.2"}
B_partition_chunk64 insert 1,000 meetings x 46 rows, one transaction per meeting (ms): 3256
B_partition_chunk64 vector chunks / file MB: {"chunks":730,"mb":38.4}
B_partition_chunk64 rows in the timed folder: 1978
B_partition_chunk64 k=10 one folder: {"medianMs":1.16,"rows":10}
B_partition_chunk64 k=10 one folder, exclude one meeting: {"medianMs":1.41,"rows":10}
B_partition_chunk64 k=10 unfiled ('' sentinel): {"medianMs":1.36,"rows":10}
B_partition_chunk64 k=10 all meetings: {"medianMs":26.32,"rows":10}
B_partition_chunk64 re-index 100 meetings (delete 46 + insert 46 each) (ms): 387
B_partition_chunk64 after churn: vector chunks / file MB / rows: {"chunks":748,"mb":39.3,"rows":46000}
B_partition_chunk64 UPDATE folder_id of one row: {"result":"ERROR UPDATE on partition key columns are not supported yet. ","before":"00000000-0000-4000-8000-000000000006","after":"00000000-0000-4000-8000-000000000006"}
A_partition_default runtime: {"node":"22.22.1","electron":"39.8.10","sqlite":"3.51.2"}
A_partition_default insert 1,000 meetings x 46 rows, one transaction per meeting (ms): 3486
A_partition_default vector chunks / file MB: {"chunks":54,"mb":44.6}
A_partition_default rows in the timed folder: 1978
A_partition_default k=10 one folder: {"medianMs":1.02,"rows":10}
A_partition_default k=10 one folder, exclude one meeting: {"medianMs":1.02,"rows":10}
A_partition_default k=10 unfiled ('' sentinel): {"medianMs":0.98,"rows":10}
A_partition_default k=10 all meetings: {"medianMs":25.25,"rows":10}
A_partition_default re-index 100 meetings (delete 46 + insert 46 each) (ms): 398
A_partition_default after churn: vector chunks / file MB / rows: {"chunks":62,"mb":51.1,"rows":46000}
A_partition_default UPDATE folder_id of one row: {"result":"ERROR UPDATE on partition key columns are not supported yet. ","before":"00000000-0000-4000-8000-000000000006","after":"00000000-0000-4000-8000-000000000006"}
```

Notes on P2:

- A partition key makes a folder query about 20 times faster than a metadata column (about 1 ms vs 20 ms). This supports D1.
- A 1,000-row insert: P1 6b gives 81 to 97 ms in one transaction. P2 gives about 3.3 to 3.5 s for 46,000 rows in 1,000 transactions, which is about 73 ms per 1,000 rows.

### P3. Filter push-down and the cascade trigger (`probe-filters.mjs`, on the P2 variant B file)

Electron 39.8.10 as Node:

```
runtime: {"node":"22.22.1","electron":"39.8.10","sqlite":"3.51.2"}
3 meetings in the folder of chunk 7777: ["m111","m142","m149"]
meeting_id = one meeting (46 rows): {"rows":10,"meetings":["m142"]}
meeting_id IN (3 meetings), all partitions: {"rows":10,"meetings":["m111","m142","m149"]}
meeting_id IN (3 meetings) AND folder_id = F: {"rows":10,"meetings":["m111","m142","m149"]}
folder_id = F AND meeting_id != the query's meeting: {"rows":10,"meetings":["m719","m383","m334","m522","m254","m545","m695","m666","m111"]}
folder_id IN (F, ''): {"rows":20,"meetings":["m273","m572","m367","m107","m691","m36","m58","m211","m231","m169","m719","m383","m334","m522","m254","m545","m695","m666","m111"]}
cascade delete fires the AFTER DELETE trigger (gc rows): [1,2]
```

The query vector is a stored vector of a meeting in folder F. With `meeting_id != <that meeting>`, all 10 rows come from other meetings. So the exclude is pushed down.

### P4. SQL `load_extension()` (`probe-sqlfn.mjs`)

```
before loadExtension, allowExtension=true: SQL load_extension() ERROR not authorized
after enableLoadExtension(false): SQL load_extension() ERROR not authorized
runtime {"node":"22.22.1","electron":"39.8.10","sqlite":"3.51.2"}
```

### P5. `Intl.Segmenter` in Electron 39 Node (fictional text)

```
["A Lívia disse que o projeto Aurora sai na sexta.","O Rafael concordou?","Sim."] ["明日は会議です。","資料を送ります。"] 74.2 en-US
```

The last two values are `process.versions.icu` and the default locale.
