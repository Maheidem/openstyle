# Meeting chat agent: P0 report

Status: DRAFT for owner review. Date: 2026-10-31. Branch `feat/chat-agent-p0`, PR #400. Spec: `specs/meeting-chat-agent.md` (PR #399).
Language: ASD-STE100 Simplified Technical English.
Scope: measurement only. The product code changes are the minimum that the harness needs (section 8). All bars in section 7 are PROPOSED. The owner approves them.

## 0. Summary

1. The harness runs the real stack: the server's own `getDb`, schema, `indexMeeting` and `retrieve`, the shipped MLX embed worker and the shipped MLX LLM worker with Gemma 4 E2B at temperature 0. Nothing is mocked. The corpus is fictional. The answer keys are fixed code. No LLM judge decides a result.
2. Corpus and gold set: 30 meetings, 12 people, 190 questions with fixed keys, 147 retrieval queries (section 2).
3. Retrieval (section 3). Dense vectors alone (V0) find the gold line in the top 10 for 57.8% of the 147 queries. They fail on exact numbers (recall@10 32.4%) and on exact names (62.5%). FTS5 BM25 with RRF (H1) lifts nDCG@10 from 0.452 to 0.498 (+4.6 points). It helps most on names (+9.5) and numbers (+19.7). It does not help on paraphrase questions. The Qwen3-Reranker-0.6B (R1) on top of H1 lifts nDCG@10 to 0.746. It costs 396 ms per query (p50) for 30 candidates, and 207 ms for 15 candidates (nDCG@10 0.668). At 46,000 rows H1 itself takes 68 ms (p50) and 109 ms (p95).
4. The audio tower of EmbeddingGemma 2 (M1) runs under MLX and gives the same vectors as the official PyTorch route. On spoken fictional meetings with a real ASR it did not help: it is 10 points below the text and BM25 fusion on the ASR-error queries. M1 is dropped.
5. Router (section 4). The LLM router on E2B has an intent accuracy of 72.6% on the 190 gold questions and 90.6% on a blind set of 224 questions in 7 languages. A rules router has 93.7% on the gold questions and 56.3% on the blind set. The rules router is overfitted to the questions that its author saw. Slot fill with a strict schema gives 81.0% with the gold intent. Dates are the weak slot (48% for the first day).
6. Native tools (T1) work in the local worker behind a flag. T1 and the structured pipeline (A1) are close: tool choice 66.8% against 75.3%, tool and args together 61.1% against 56.3%. T1 needs one call and is faster (p50 200 ms against 375 ms). No arm wins on both measures. Section 4.5 asks the owner to decide.
7. Baseline A0 (the live chat as it is): 68.1% by key on the 91 gold questions with a meeting or folder scope. It fails on follow-ups (20%), long threads (0%), scope traps (20%) and counts (0%). Section 5.
8. Decisions for the owner: section 9.

## 1. Method

| Item | Value |
|---|---|
| Machine | Apple M5 Max, 128 GB, macOS 27.0.1 |
| Code | branch `feat/chat-agent-p0` (head at the time of the final runs: see the MLflow tag `chat.git_sha`) |
| Embed model | `embeddinggemma-2-bf16-text`, text tower, int8 vectors in sqlite-vec 0.1.9 (`apps/server/src/lib/mlx-embed/constants.ts:46`) |
| LLM | `gemma-4-e2b-qat-4bit`, shipped worker build 2.25.0-alpha.1 (mlx-lm 0.32.2, llguidance 1.9.1), temperature 0, thinking off |
| Corpus | seed 20261031, hash `d43381b7d69e90fd`; gold hash `a02e9c4f5953ae6e` |
| MLflow | experiment `openstyle-lab-chat-agent-p0`. The spec names no experiment, so this follows the eval-lab pattern `openstyle-lab-<stage>`. The server address comes from the environment. Every run was read back (`READ BACK OK` in the logs). |
| Command | `pnpm chat-eval retrieval`, `pnpm chat-eval router`, `pnpm chat-eval a0`, `pnpm chat-eval:test` (skill `.claude/skills/chat-eval/SKILL.md`) |
| GPU | The harness took `/tmp/openstyle-gpu.lock` through the queue for every model run. |

Request shape for the LLM arms: the harness sends to the worker the body that the gateway sends to the local provider (`temperature` 0, `chat_template_kwargs.enable_thinking` false, `response_format` json_schema strict). It does not go through `callUnit`. The worker is the real one. The stage prompts are new.

Determinism: two retrieval runs on the same corpus gave equal numbers for every arm. The embed and the generation are deterministic at temperature 0 (spec 8.1 rule 5).

## 2. Corpus and gold set

| Item | Count |
|---|---|
| Meetings | 30: 4 folders (7, 7, 6, 6 meetings) and 4 unfiled. 20 EN, 6 PT, 4 mixed. 12 weeks. |
| Transcript | 2,689 segments, 107,846 bytes, 3.85 hours. 180 chunks after indexing: 120 transcript, 30 meta, 30 summary. |
| People | 12 (the owner and 11 others). Two pairs share a first name (Ana, Carlos). Each has an ASR spelling. |
| Facts | 150 planted lines in 9 families (quote, date, metric, decision, assign, approve, propose, org, open question). 10 are updates of an earlier fact (knowledge update). 21 lines hold the ASR spelling of a name. |
| Distractors | 6 filler lines before each fact, 2 lines about the subject with no value, a line with a similar number in 60% of the cases, the same vendors in two meetings. |
| Gold questions | 190: lookup 25, who said 20, aggregation 20 (8 lists, 6 review, 6 status), count 10, temporal 20, knowledge update 10, not answerable 30 (15.8%), scope trap 10, follow-up 10, long thread 10 (5 to 10 turns, a planted fact in turn 1), write proposal 25 |
| Keys | text (must-contain groups and must-not tokens after normalization of numbers, dates, accents and number words), id sets with precision and recall, integers, not-found, write proposals (kind and id set) |
| Retrieval queries | 147: names 40, numbers 37, concept 30, ASR-error names 20, date-bounded 20. Half PT and half EN. |

Differences from the spec:

1. The numbers slice has 37 queries, not 40. The corpus has 20 amounts and 16 metrics, plus the numeric decisions. The slice uses all of them.
2. The question text is EN or PT. The router set has 7 languages (section 4). The router blind set is separate from the gold questions.
3. The corpus is small: 180 chunks. The real index has about 46,000 rows (spec 3.1 point 5). Section 3.8 repeats the run at that size for latency and size. Its recall is not usable (it is a duplicate stress).
4. Not built in P0: the R3 helper `best_ms` and the grouping (spec 7.3), the arm C1 (chunk context by code, spec 7.5), and the A0 baseline on E4B, Nemotron and Qwen. The brief of this run did not ask for them.
5. The #233 hard set (spec 7.4.6) is a private set of real meetings. It was not used. The spec bar on it cannot be checked here.

Checks that tests pin (`pnpm chat-eval:test`, 24 tests): same seed gives the same bytes; counts per type; every text key is supported by the evidence in the corpus; every set key points at real ids; the words of the not-answerable questions are not in the corpus; the scorers; the FTS5 channels; the fusion; the slots.

## 3. Retrieval workstream (spec 7.4)

### 3.1 What I read first

SQLite FTS5 documentation, https://www.sqlite.org/fts5.html (read 2026-10-31):

1. On `bm25()`: "The better the match, the numerically smaller the value returned." Appending `ORDER BY bm25(ft)` or `ORDER BY rank` gives the best match first. The constants are k1 = 1.2 and b = 0.75.
2. "FTS5 features four built-in tokenizer modules": `unicode61` (the default), `ascii`, `porter` and `trigram`.
3. `unicode61` folds diacritics of Latin letters with the option `remove_diacritics` (values 0, 1 and 2). This run uses 2.
4. `trigram` "treats each contiguous sequence of three characters as a token, allowing FTS5 to support more general substring matching". "Substrings consisting of fewer than 3 unicode characters do not match any rows when used with a full-text query."
5. The repo already uses a `trigram` table for dictation history (`apps/server/src/lib/schema.ts:965 to 972`).

Issue #233, comment 6299816580 (the reason of SD8): "Search: vectors only. No plain-RRF hybrid (it lowered EN recall@10 from 0.716 to 0.608)." The numbers comment 6299161833 says the set was a hard paraphrase set (75 PT and 74 EN queries) where "BM25 alone" scored recall@10 0.333 (PT) and 0.324 (EN). On such a set BM25 adds noise. The agent asks questions with exact names and numbers. Section 3.9 answers SD8 with numbers.

### 3.2 Arms

| Arm | Retrieval |
|---|---|
| V0 | `retrieve()` as it is: EmbeddingGemma 2 text tower, int8, cosine, k = 50 |
| B1, B2 | BM25 alone, FTS5 `unicode61 remove_diacritics 2` (B1) or `trigram` (B2). Stop words out, each term quoted, OR-joined (`ftsQuery` in `retrieval.mts`). |
| H1 | V0 and B1, RRF k = 60 (`rrf` in `keys.mts`). The unit is the chunk. |
| H2 | V0 and B2, RRF k = 60 |
| H3 | V0, B1 and B2, RRF k = 60 |
| H1w, H1s | H1 with weights 1 and 0.5, and H1 with a normalized score sum (spec 7.4.2 point 2) |
| R1 | the top 30 chunks of H1, reranked by Qwen3-Reranker-0.6B (Apache-2.0, MLX through `mlx-lm`, one forward pass per pair, probability of "yes" against "no") |
| R1c15, R1c10 | the same with the top 15 or 10 candidates. The order is exact (the first N scores of the 30 run). The time is the 30-candidate time times N/30. |
| M1 | the audio tower (section 3.7) |

Grades: 2 = a transcript chunk that holds the gold segment. 1 = a summary chunk of the gold meeting that holds the value. recall@k counts grade 2. "any" counts grade 1 or 2. nDCG@10 uses the gains 2 and 1.

### 3.3 Result (147 queries, 180 chunks)

| arm | lang | r@1 | r@5 | r@10 | r@10 any | MRR@10 | nDCG@10 |
|---|---|---|---|---|---|---|---|
| V0 | all | 28.6 | 50.3 | 57.8 | 75.5 | 0.375 | 0.452 |
| V0 | EN | 33.8 | 60.8 | 67.6 | 85.1 | 0.444 | 0.546 |
| V0 | PT | 23.3 | 39.7 | 47.9 | 65.8 | 0.305 | 0.357 |
| B1 | all | 4.1 | 61.9 | 69.4 | 78.2 | 0.284 | 0.492 |
| B2 | all | 5.4 | 46.3 | 59.9 | 75.5 | 0.232 | 0.409 |
| H1 | all | 22.4 | 55.8 | 68.7 | 82.3 | 0.367 | 0.498 |
| H1 | EN | 25.7 | 63.5 | 74.3 | 83.8 | 0.415 | 0.558 |
| H1 | PT | 19.2 | 47.9 | 63.0 | 80.8 | 0.318 | 0.438 |
| H2 | all | 21.1 | 49.7 | 63.9 | 81.0 | 0.337 | 0.467 |
| H2 | EN / PT | | | 75.7 / 52.1 | 87.8 / 74.0 | | 0.561 / 0.371 |
| H3 | all | 10.9 | 55.1 | 66.0 | 82.3 | 0.297 | 0.467 |
| H1w | all | 25.2 | 53.7 | 66.7 | 81.0 | 0.381 | 0.494 |
| H1s | all | 19.0 | 54.4 | 68.0 | 85.0 | 0.350 | 0.493 |
| R1 (30) | all | 46.9 | 83.7 | 87.1 | 91.2 | 0.636 | 0.746 |
| R1 (30) | EN | 43.2 | 86.5 | 91.9 | 94.6 | 0.624 | 0.764 |
| R1 (30) | PT | 50.7 | 80.8 | 82.2 | 87.7 | 0.647 | 0.727 |
| R1c15 | all | 43.5 | 72.8 | 74.8 | 86.4 | 0.564 | 0.668 |
| R1c10 | all | 41.5 | 66.7 | 68.7 | 82.3 | 0.529 | 0.624 |

BM25 alone has a low recall@1 on purpose of the grading: its first hit is often the short summary chunk (grade 1), which holds the same words as the line.

Per slice, nDCG@10 / recall@10 (%), all languages:

| arm | names (40) | numbers (37) | concept (30) | ASR names (20) | date (20) |
|---|---|---|---|---|---|
| V0 | 0.400 / 62.5 | 0.281 / 32.4 | 0.235 / 36.7 | 0.728 / 85.0 | 0.920 / 100 |
| B1 | 0.536 / 82.5 | 0.732 / 100 | 0.075 / 16.7 | 0.459 / 60.0 | 0.620 / 75.0 |
| B2 | 0.352 / 57.5 | 0.531 / 78.4 | 0.155 / 33.3 | 0.468 / 55.0 | 0.618 / 75.0 |
| H1 | 0.495 / 75.0 | 0.478 / 62.2 | 0.177 / 40.0 | 0.633 / 80.0 | 0.890 / 100 |
| H2 | 0.382 / 60.0 | 0.433 / 54.1 | 0.241 / 50.0 | 0.614 / 75.0 | 0.890 / 100 |
| H3 | 0.429 / 67.5 | 0.507 / 67.6 | 0.168 / 33.3 | 0.565 / 75.0 | 0.820 / 100 |
| R1 (30) | 0.760 / 92.5 | 0.887 / 100 | 0.344 / 46.7 | 0.890 / 100 | 0.913 / 100 |
| R1c15 | 0.700 / 80.0 | 0.698 / 73.0 | 0.317 / 43.3 | 0.827 / 90.0 | 0.914 / 100 |

Reading the slices:

1. Dense vectors fail on exact numbers (32.4%) and are weak on exact names (62.5%). BM25 finds all 37 numbers in the top 10.
2. Dense vectors are better than BM25 on the ASR-spelled names (85.0% against 60.0%) and on paraphrase questions (36.7% against 16.7%). The hybrid keeps part of both.
3. The trigram tokenizer (B2) is worse than the word tokenizer (B1) on names, numbers and PT. It is better on `concept` in the fusion (H2 0.241 against H1 0.177). No slice shows a gain that pays for 3.3 times more index (section 3.5). The word tokenizer wins.
4. The date slice is easy for every dense arm because the date filter leaves one meeting. BM25 is lower (0.620). I did not find the cause.
5. The reranker lifts every slice. It reaches 100% recall@10 on numbers and ASR-spelled names.

### 3.4 Latency and RAM

| Item | Value |
|---|---|
| Query, dense (embed of the query plus KNN) p50 / p95 | 9.1 / 12.0 ms (warm, 180 chunks) |
| BM25 word / trigram p50 | 0.10 / 0.09 ms |
| H1 total p50 / p95 | 9.2 / 12.1 ms |
| Cold first query (the embed worker loads) | 1,337 ms |
| R1 added time per query, 30 candidates, p50 / p95 | 396 / 484 ms (the pairs run one after the other) |
| R1c15 total p50 / p95 | 207 / 251 ms; R1c10: 141 / 170 ms |
| Embed worker RSS peak | 1,231 MB (46 samples) |
| Reranker process RSS peak | 1,481 MB (Python, MLX, 0.6B in bf16); load 376 ms |

The spec expected about 80 ms for the embed of a query batch (spec 3.1 point 5). On this Mac one query takes about 9 ms.

### 3.5 Index size and cost

| Item | Value |
|---|---|
| Embedding 180 chunks | 4.3 s for 3.85 hours of meeting, about 1 s per audio hour (the first meeting includes the worker load) |
| Vectors | 180 x 768 int8 = 138,240 bytes |
| FTS5 word tokenizer, with content | 339,968 bytes = 3.15 x the transcript text (107,846 bytes) |
| FTS5 word tokenizer, contentless | 167,936 bytes = 1.56 x |
| FTS5 trigram, with content / contentless | 1,011,712 bytes (9.38 x) / 839,680 bytes (7.79 x) |

At 30 meetings the ratio is high because a SQLite file has fixed page overhead. Section 3.8 repeats the size at the real index size.

### 3.6 Scope and date filter in `retrieve()` (spec 7.1)

The filter is in `apps/server/src/lib/search/retrieve.ts`: a `meeting` scope and an optional `dateRange`, ANDed with the folder and the tags. A call without the new fields takes the same path as before. A vitest case pins it (`apps/server/tests/search-index.test.ts`, "retrieve: meeting scope and date range"). The existing search tests pass (13 in that file, 22 in the folder-memory file).

Recall@8 of the gold segment on the 47 gold questions that have a meeting scope, a folder scope or a date range. "Before" runs the unscoped search (k = 50) and filters after. "After" passes the filter into `retrieve()` (k = 8).

| group | n | before | after |
|---|---|---|---|
| meeting scope | 20 | 90.0 | 100.0 |
| folder scope | 27 | 88.9 | 92.6 |
| all | 47 | 89.4 | 95.7 |

### 3.7 M1: audio vectors

Two measurements:

1. Spike on the model (agent run, scratch scripts). The model card, https://huggingface.co/google/embeddinggemma-2, lists Transformers, Sentence-Transformers and Safetensors. The audio tower runs under MLX with `mlx-vlm` 0.7.8 (file `mlx_vlm/models/embedding_gemma2/embedding_gemma2.py` has `AudioEncoder`, `embed_audio`). The text and audio towers load by setting `vision_config` to null in `config.json`. Vectors equal the PyTorch reference (cosine at least 0.99986 for audio, 0.99994 for queries). The text vectors equal the current text-only mirror (cosine 1.00000 on 10 queries). Conversions with the audio tower exist: `nativ-community/embeddinggemma-2-bf16` (MLX, 1.49 GB, tested), `Jundot/embeddinggemma-2-oQ8e` (MLX, not tested), `onnx-community/embeddinggemma-2-ONNX` (not tested). Two statements of the spec are REFUTED by this: "whether the audio tower runs under `mlx-vlm` is UNKNOWN" (it runs) and "no other verified local candidates" (the Hub lists the conversions above).
2. Spoken meetings with a real ASR. 10 fictional meetings (7 EN, 3 PT) were spoken with macOS voices (`say -o`, 4 voices per language, room noise at -52 dBFS) and transcribed by the shipped worker with Qwen3-ASR-1.7B-8bit (2.23 s per audio minute). The ASR wrote 6 of the 10 spoken names wrong ("Priya Nandakumar" became "Preyananda Kumar", "Larkspur Travel" became "Marks por traveiro"). 104 windows of 30 s.

| Arm (ASR-error slice, 10 queries) | R@1 | R@5 | R@8 | MRR |
|---|---|---|---|---|
| T text tower on the ASR text | 0.90 | 1.00 | 1.00 | 0.950 |
| L BM25 on the ASR text | 0.70 | 0.80 | 0.80 | 0.750 |
| H = T + L, RRF | 0.70 | 1.00 | 1.00 | 0.820 |
| A audio vectors | 0.60 | 0.70 | 0.70 | 0.654 |
| HA = H + A | 0.70 | 0.80 | 0.90 | 0.760 |
| TA = T + A | 0.70 | 0.80 | 0.90 | 0.758 |

Cost of A (MLX): 0.11 s per audio minute (0.002 x real time), peak RSS 2,944 MB, 768 dimensions per 30 s window = 120 windows per hour = 92 KB per hour at int8. The `names` slice (15 queries) gives the same pattern (HA 0.733 and H 0.733 at R@8).
Verdict against the bar (at least +5 points R@8 over H): HA is 10 points below H. M1 fails. It runs under MLX at a low cost, but the text already carries the name through the rest of the line. Limits: 10 queries (one query is 10 points), synthetic voices, a templated corpus, chunks cut at the known pauses.

### 3.8 Scale

The real index has about 46,000 rows (spec 3.1 point 5). `pnpm chat-eval retrieval --scale 256` loads the gold corpus and 255 more corpora of other seeds as distractors: 7,680 meetings, 46,080 chunks (30,720 transcript, 7,680 meta, 7,680 summary), 990 hours. The extra corpora use the same word banks. The same vendors and subjects come back with other numbers and dates.

Do not read the recall of this run as a size effect. A query like "Kestrel Hosting quote" now matches 256 near-identical lines, and only one is the gold line. Recall@10 falls to 5.4% (V0), 0.7% (BM25 word) and 4.8% (H1) for that reason. The run measures latency, RAM and index size.

| Item | 180 chunks | 46,080 chunks |
|---|---|---|
| Dense query (embed plus KNN over all partitions), p50 / p95 | 9.1 / 12.0 ms | 62.7 / 105.2 ms |
| BM25 word p50 / p95 | 0.10 / 0.17 ms | 3.9 / 28.6 ms |
| BM25 trigram p50 / p95 | 0.09 / 0.19 ms | 5.9 / 36.9 ms |
| H1 total p50 / p95 | 9.2 / 12.1 ms | 68.1 / 109.4 ms |
| H3 total p50 / p95 | 9.3 / 12.3 ms | 75.4 / 137.6 ms |
| Embed worker RSS peak | 1,231 MB | 1,256 MB |
| Embedding time | about 1 s per audio hour | 664 s for 990 hours = 0.67 s per audio hour |
| Vectors (int8) | 138 KB | 35.4 MB |
| FTS5 word, with content, / transcript text | 3.15 x | 2.31 x (64.0 MB) |
| FTS5 word, contentless | 1.56 x | 0.73 x (20.2 MB) |
| FTS5 trigram, with content / contentless | 9.38 x / 7.79 x | 5.39 x / 3.81 x |
| FTS build, word / trigram | 3 / 8 ms | 687 / 3,104 ms |
| SQLite file | | 209 MB |

1. The query time of an unscoped dense search grows from 9 ms to 63 ms at 46,000 rows. The spec counted 1.2 ms for a folder-scoped KNN (`specs/local-semantic-search.md` S1). The all-folders case scans all rows. H1 at 46,000 rows is 68 ms (p50) and 109 ms (p95), below the 150 ms bar.
2. The FTS5 size bar (at most 1.0 x the transcript text) holds only for the contentless word table at this size (0.73 x). A table with its own text copy is 2.31 x. The trigram table is 3.8 to 5.4 x. This supports the word tokenizer and a contentless table.
3. No R1 run at this size: the reranker time depends on the number of candidates, not on the index size.

### 3.9 Answer to SD8 of the search spec

SD8 says "no plain-RRF hybrid". Its reason is a hard paraphrase set where BM25 alone scored 0.32. The same result shows here: on the `concept` slice (paraphrase, 30 queries) V0 has nDCG@10 0.235 and H1 has 0.177. The hybrid is lower. But the chat agent asks for exact names and numbers. On those slices H1 is better than V0 (names +9.5 points, numbers +19.7 points nDCG@10) and the overall nDCG@10 is higher (0.498 against 0.452; EN 0.558 against 0.546; PT 0.438 against 0.357). So SD8 holds for paraphrase search and is reversed for the chat agent. The edit of `specs/local-semantic-search.md` marks the non-goal line as reversed. The search UI stays unchanged.

### 3.10 Bars of spec 7.4.6

| Item | Bar | Measured | Result |
|---|---|---|---|
| H1 against V0 | nDCG@10 not lower in any language; at least +5 points on names and numbers | EN 0.558 / 0.546, PT 0.438 / 0.357; names +9.5, numbers +19.7 | pass |
| Hybrid recall@10 on the #233 hard set | 0.75 PT, 0.80 EN | the set is private; not measured. On the gold set H1 recall@10 is 63.0 PT, 74.3 EN (any evidence: 80.8, 83.8) | not measurable |
| R1 adopted | at least +3 points nDCG@10; no language below V0; added p95 at most 400 ms for 30 candidates; added RAM at most 1.5 GB | +24.8 points; EN and PT above V0; p95 added 484 ms (30), 251 ms (15 candidates); RSS 1,481 MB | fails the time bar with 30 candidates; passes with 15 |
| M1 adopted | at least +5 points R@8 on the ASR-error slice over H1 | -10 points | fail |
| FTS table size | at most 1.0 x the transcript text | word table: 3.15 x with content and 1.56 x contentless at 30 meetings; 2.31 x and 0.73 x at 46,080 chunks | pass only for the contentless word table at the real size |
| Query latency p95, hybrid without reranker, warm | at most 150 ms | 12.1 ms (180 chunks); 109.4 ms (46,080 chunks) | pass |
| No regression | the existing search tests | 13 + 22 tests pass | pass |

## 4. Router and tool arms (spec 2.1, 2.3, 8.5)

### 4.1 Arms

| Arm | What it is |
|---|---|
| A1 | LLM router (json_schema strict, one intent) then the plan table (code), then a strict slot-fill call |
| A3 | rules router, then the same plan table and slot fill |
| A5 | LLM router, then the plan table, with default slots (query = the question) and no slot call |
| T1 | native tool calling in the local worker: the model sees at most 8 tools and the same closed choices, and makes one call. Behind `OPENSTYLE_MLX_LLM_NATIVE_TOOLS=1`. Default off. |

T1 in the worker (`scripts/mlx_asr_server.py`, block "T1"): with the flag on, `tools`, `tool_choice`, assistant `tool_calls` and `tool` messages are accepted. The worker passes `tools` to the chat template, generates, and parses the call with the mlx-lm parser (`mlx_lm/tool_parsers/gemma4.py` in the shipped bundle, `mlx-lm` 0.32.2). It returns `message.tool_calls` and `finish_reason` `tool_calls`. A request with `tools` and `response_format` together gets a 400. With the flag off the worker acts as before. 110 Python tests pass (7 are new). Facts found: the Gemma 4 template puts the tools in the system turn; the template adds no generation prompt after a `tool` message; `tool_choice` "required" is advisory because no grammar can force it; the worker exits when its stdin closes (a launcher must keep stdin open).

### 4.2 Stage 1: intent

Sets: gold = the 190 gold questions (EN, PT). Even and odd halves of the gold ids: prompt v2 was worded after the first run using what I saw in the even half, so the odd half is the check. Extra = 44 items in 7 languages written by me. Heldout = 224 items in 7 languages (4 per intent and language) written by an agent that read only spec sections 1.3 and 2.3 and saw no rule and no prompt. The file is `scripts/chat-eval/router-heldout.json`.

| Router | gold | gold even | gold odd | extra | heldout | p50 / p95 ms |
|---|---|---|---|---|---|---|
| LLM, prompt en (examples in English) | 65.8 | 67.4 | 64.2 | 100.0 | 87.9 | 83 / 98 |
| LLM, prompt ml (examples in 7 languages) | 60.5 | 65.3 | 55.8 | 100.0 | 86.2 | 88 / 104 |
| LLM, prompt v2 (sharper definitions) | 72.6 | 73.7 | 71.6 | 100.0 | 90.6 | 90 / 124 |
| rules | 93.7 | 93.7 | 93.7 | 90.9 | 56.3 | 0 |

Blind set per language (v2 / rules): EN 96.9 / 68.8, PT 87.5 / 56.3, DE 93.8 / 43.8, ES 84.4 / 46.9, FR 90.6 / 65.6, IT 87.5 / 62.5, JA 93.8 / 50.0. There was no invalid JSON in any run.

1. The rules router looks best on the gold questions (93.7%) and loses on the blind set (56.3%). I wrote the rules after I saw the gold questions, and I wrote the 44 extra items with the rules in mind. The blind set is the fair test. The spec says a rules route is used only if it matches the router (spec 2.3 stage 1 point 4). It does not match on unseen phrasing.
2. The prompt with examples in 7 languages (ml) is not better than the English prompt. The spec assumption "examples in the 7 UI languages are needed" is not supported by this data.
3. The gold accuracy of v2 is 72.6%. The misroutes are: lookup to temporal 24, lookup to who_said 14, temporal to lookup 10. "When is the cutover?" reads as a time question. "Who will write the rollback plan?" reads as a who question. Both are defensible labels. A lookup that goes to who_said has the same first tool (`search_chunks`), so only the lookup to temporal case changes the tool.
4. The proposed route bar of spec 8.7 is 90%. The heldout set reaches it (90.6%), the gold set does not (72.6%). The difference is the intent labels of my gold questions. P1 must fix the label rules of "lookup" against "temporal" and "who_said" before it sets a number.

### 4.3 Stage 2b: slot fill with the gold intent (184 questions, status has no slots)

| Intent | n | strict slot fill | default slots (A5) |
|---|---|---|---|
| lookup | 95 | 87.4 | 78.9 |
| who_said | 20 | 95.0 | 100.0 |
| aggregate | 18 | 88.9 | 38.9 |
| review | 6 | 50.0 | 0.0 |
| temporal | 20 | 60.0 | 0.0 |
| write | 25 | 64.0 | 0.0 |
| all | 184 | 81.0 | 55.4 |

Per arg: query 85.2% (n 88), person 100% (8), item 100% (10), meeting 100% (5), folder 100% (5), tag 100% (6), cluster 100% (4), change (the write kind) 84.0% (25), kind (decision or open question) 50.0% (6), first day 48.3% (29), last day 65.5% (29). The slot call took 268 ms (p50) and 592 ms (p95). No invalid JSON. The gold item, meeting or person was in the closed list that code built for 25 of 25 write questions.

1. The slot call is worth its cost for lists, dates and writes (55.4% to 81.0%). For a plain lookup it adds 8.5 points. A5 (no slot call) is the cheapest arm and is useful for lookups only.
2. Dates are the weak slot. E2B does not compute "last week" from a date in the prompt. A closed choice (period, month, day) with the range made by code gave 72.8% overall, below the ISO slots (81.0%). It did not help. A code date parser (`parseDates` in `slots.mts`, EN and PT, no model) matches all 29 gold date args and finds no date in the other questions (a unit test pins it). I wrote it with the gold phrasings in view, so P1 needs a blind date test. Rule-like work stays in code (spec 2.1 point 5).

### 4.4 End to end (190 gold questions)

"Tool" = the first tool of the plan (A arms) or the first native call (T1) is in the gold plan; for a write question it must be the right propose tool. "Args" = every gold arg matches.

| Arm | tool | args | both | p50 / p95 ms | tool, no write | both, no write | tool, write | both, write | tool, no count |
|---|---|---|---|---|---|---|---|---|---|
| A1 (LLM v2 + slots) | 75.3 | 56.3 | 56.3 | 375 / 681 | 72.7 | 55.2 | 92.0 | 64.0 | 79.4 |
| A3 (rules + slots; biased) | 90.5 | 72.1 | 72.1 | 268 / 592 | 89.1 | 73.3 | 100 | 64.0 | 95.6 |
| A5 (LLM v2, default slots) | 75.3 | 46.3 | 46.3 | 95 / 125 | 72.7 | 53.3 | 92.0 | 0.0 | 79.4 |
| T1 (native tools) | 66.8 | 61.1 | 61.1 | 200 / 408 | 61.8 | 56.4 | 100 | 92.0 | 65.0 |

By gold intent, tool / both (A1, T1): lookup 74 / 56 and 48 / 44; who_said 100 / 95 and 75 / 75; aggregate 44 / 44 and 100 / 100; review 100 / 50 and 100 / 100; status 100 / 100 and 100 / 100; temporal 50 / 10 and 55 / 30; write 92 / 64 and 100 / 92.

1. A1 chooses the tool better than T1 for lookup (74% against 48%). T1 gives no call for 19 questions, calls `list_action_items` for 14 lookups and `list_decisions_questions` for 12 lookups. The last choice is defensible for "What did we decide on X?", but the plan table of spec 2.3 does not list it. A score on the final answer (P1) would show if these calls still give the right answer.
2. T1 is better for aggregate (100% against 44%: the plan table has no `list_meetings` first for counts), for review and for write (92% against 64%).
3. A1 depends on the router. With the gold intent, the A1 args are 81.0% (section 4.3). A1 is limited by stage 1.
4. T1 costs one call. Its p50 is 200 ms against 375 ms for A1. The shipped worker peak RSS was 4,558 MB and the dev worker with the flag 4,511 MB.
5. A5 is the fastest (p50 95 ms) and cannot do dates, lists or writes.

### 4.5 Winner and what the owner must decide

By the rule of spec 2.1 point 6 ("the winner stays; the loser is removed") the measure is tool choice and argument accuracy. No arm wins both:

| Measure | A1 | T1 |
|---|---|---|
| tool choice | 75.3 | 66.8 |
| tool and args together | 56.3 | 61.1 |
| write proposals, tool and args | 64.0 | 92.0 |
| p50 latency | 375 ms | 200 ms |
| code in the worker | none | flag, 142 lines, parser of mlx-lm |

My reading: the structured router is held back by the intent labels, not by the model. T1 is held back by the lookup case. A mixed design (T1 for the final choice, with the tools of the plan limited by code) has not been measured. I did not build it. See decision 2 in section 9.

## 5. Baseline A0

Arm A0 is the live chat code as it is (`buildChatContext`, `CHAT_SYSTEM_PROMPT`, lenient parse; `scripts/chat-eval/a0-run.mts`), on E2B at temperature 0. It has no meeting scope and no router. A question with a meeting scope runs with the folder of that meeting, as a live chat in a new meeting of that folder would. It runs on the 91 gold questions that have a meeting or folder scope and a text, count or not-found key.

| Group | n | pass by key (%) |
|---|---|---|
| lookup | 17 | 76.5 |
| who said | 14 | 100.0 |
| knowledge update | 6 | 66.7 |
| follow-up | 5 | 20.0 |
| long thread | 5 | 0.0 |
| temporal (text keys) | 10 | 90.0 |
| count | 4 | 0.0 |
| not answerable | 20 | 95.0 |
| scope trap | 10 | 20.0 |
| answerable, all | 60 | 68.3 |
| not-found keys, all | 31 | 67.7 |
| all | 91 | 68.1 |

1. False not-found rate: 1.7% (1 of 60 answerable questions). All 104 cites that the model gave were in the source list. 73.3% of the answerable answers cite a source from the gold meeting.
2. Latency p50 367 ms, p95 493 ms. The prompt has 1,555 tokens (p50). The LLM worker used 4,516 MB.
3. A0 does well where the folder summaries and 8 retrieved chunks hold the fact (who said 100%, temporal 90%, lookup 76.5%). It fails where the question needs the thread (follow-up 20%, long thread 0%: the live chat sends the last 4 messages as text but the follow-up has no query rewrite), a scope (scope trap 20%: A0 cannot be told to look in one meeting only) or a count (0%).
4. The P1 bar "beat A0 by at least 10 points on lookup and follow-up" has a base of 63.6% (14 of 22 questions). The base is small. P1 must measure A1 on the same questions.

## 6. What this does not show

1. The answer stage (A1 answer call, the cite check, the not-found block) is not built. P0 measures retrieval, router and slots only. A tool call that differs from the gold plan can still give the right answer.
2. One model (E2B). E4B, Nemotron and Qwen are not run in P0.
3. The corpus is templated and small. Real meetings have longer and messier text. The scale run (3.8) adds distractors but not new styles.
4. The gold intent labels are mine. The blind set has labels from a second writer.
5. The retrieval gold uses one segment per query. A query can have other correct lines (the update of an earlier fact is counted as gold for the older version).

## 7. Proposed P1 pass bars (PROPOSED, the owner approves)

The bars below come from the measured numbers. They are the numbers that P1 must reach on the same gold set at the default settings. Spec 8.7 lists targets before P0. This table replaces the guesses with numbers.

| Metric | Measured in P0 | Proposed P1 bar |
|---|---|---|
| Retrieval (tool `search_chunks`) | H1 nDCG@10 0.498; R1c15 0.668 | H1 with R1c15: nDCG@10 at least 0.65; recall@10 any evidence at least 85% on all 147 queries |
| Retrieval, exact numbers and names | V0 32.4% / 62.5%; H1 62.2% / 75.0% | recall@10 at least 85% on both slices (R1 with 30 candidates gives 100% / 92.5%; R1c15 gives 73.0% / 80.0%) |
| Retrieval latency, warm, p95 | H1 12.1 ms at 180 chunks and 109 ms at 46,080 chunks; R1c15 251 ms added | at most 150 ms without the reranker at 46,000 rows; at most 400 ms added by the reranker |
| Reranker RAM | 1,481 MB | at most 1.5 GB added; idle unload like the embed worker |
| Route accuracy (stage 1) | v2: gold 72.6%, blind 90.6% | at least 90% on the blind set and at least 85% on the gold set after the label rules are fixed |
| Slot accuracy with the gold intent | 81.0% (dates 48 to 65%) | at least 90% with dates by code |
| Tool and args together (end to end) | A1 56.3%, T1 61.1% | at least 85% for the arm that stays |
| Write proposal (kind and id set) | A1 64.0%, T1 92.0% | at least 90% |
| Latency of the route, p95 | A1 681 ms, T1 408 ms | at most 700 ms for router and slots together |
| Not-found accuracy, false not-found, cite validity, answer accuracy, list F1 | needs the answer stage | keep the bars of spec 8.7 until P1 measures A1 |
| Beat A0 by 10 points on lookup and follow-up | A0 63.6% on 22 questions (section 5) | at least 74% on the same questions, and at least 85% on the 25 lookup and 10 follow-up questions of the full gold set |

## 8. Product code changes in this PR

| File | Change | Default |
|---|---|---|
| `apps/server/src/lib/search/retrieve.ts` | scope kind `meeting`, option `dateRange`, ANDed with the folder scope and the tags | unchanged without the new fields |
| `apps/server/tests/search-index.test.ts` | one case for the new filters | |
| `scripts/mlx_asr_server.py`, `scripts/test_mlx_asr_server.py` | arm T1, flag `OPENSTYLE_MLX_LLM_NATIVE_TOOLS` | off |
| `specs/local-semantic-search.md` | the "no hybrid, no reranker" non-goal marked as reversed for the chat agent | |
| `scripts/chat-eval/`, `.claude/skills/chat-eval/SKILL.md`, `package.json` (two scripts) | the harness | |

## 9. Decisions for the owner

All six decisions are DECIDED by the owner on 2026-10-31.

1. Bars of section 7: DECIDED 2026-10-31. Approved as proposed. The answer-stage bars stay as in spec 8.7 until P1 measures them.
2. Router: DECIDED 2026-10-31. MIXED design. Native tool calls (T1, flag `OPENSTYLE_MLX_LLM_NATIVE_TOOLS` and its app-side setting) give the tool and the arguments, and the write proposals. Code validates the call (tool name, argument schema, ids exist, scope). On an invalid or missing call, the pipeline falls back to the structured JSON router (A1) and the slot call. Dates come from the code date parser. The gateway must not throw on a `tool-calls` finish (spec 2.1 point 6).
3. Reranker: DECIDED 2026-10-31. Qwen3-Reranker-0.6B with 15 candidates now (added p95 at most 400 ms, RAM at most 1.5 GB, idle unload like the embed worker). P1 also tries a batched reranker with 30 candidates. It switches to 30 only if the measured added p95 stays at most 400 ms.
4. FTS table: DECIDED 2026-10-31. Word tokenizer, CONTENTLESS table. The meeting filter is a join with `meeting_chunks`. The spec text that said the FTS table stores its own copy of the chunk text is updated (spec 7.4.1).
5. M1 (audio tower): DECIDED 2026-10-31. Dropped.
6. Intent labels: DECIDED 2026-10-31. Follow E2B. "When is X?" is `temporal`. "Who will do X?" is `who_said`. The gold labels in `scripts/chat-eval` are fixed to match.

## 10. Reproduce

```bash
pnpm install --frozen-lockfile && pnpm turbo build --filter=@openstyle/server
export OPENSTYLE_MLX_LLM_WORKER=<shipped worker binary>
pnpm chat-eval:test
pnpm chat-eval corpus
pnpm chat-eval retrieval          # add --scale 256 for the scale run
pnpm chat-eval router
pnpm chat-eval a0
```

The MLflow runs are in the experiment `openstyle-lab-chat-agent-p0`: `retrieval-<arm>`, `retrieval-index-cost`, `router-stage1-<router>`, `router-e2e-<arm>`, `router-slot-fill-oracle`, `m1-spoken-<arm>`, `a0-<model>`, and the `-x256` runs. Each carries the git sha, the corpus hash and the gold hash as tags.
