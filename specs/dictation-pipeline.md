# Technical Spec: Staged dictation cleanup pipeline

**Status:** Approved by the owner on 2026-10-26 with the decisions in section 0. Built on branch `feat/dictation-pipeline` (section 11 has the build result). Sections 1 to 10 are the research draft; where they differ from section 0, section 0 wins.
**Date:** 2026-10-26
**Scope:** `apps/server/src/lib/post-process.ts`, `apps/server/src/lib/editor/` (prompt assembly), `packages/validations/src/cleanup-presets.ts`, a new `apps/server/src/lib/dictation/` module for the stages.
**Baseline:** `main` at `262d3127` (prefix cache for cleanup, #339). Today the cleanup is one LLM call with a system prompt of about 4,000 tokens (medium preset + tone block + language block).
**Owner decisions in force:** (2026-10-26) digit formatting, contact info, line commands, intensity and tone are independent stages. "Specialization over over-prompting. When we deal with smaller models, focus is key." Low and medium intensity stay fast (gate about 1 s p95). High intensity and tone can take more time.
**Prototype and raw data (scratchpad, not in git):** `stages.ts` (code stages), `bench-pipe.ts` (bench), `cases-new.ts` (54 new fictional cases), `prompts/` (stage prompts), `results/*.json`, `judge/`.

Writing rules: Simplified Technical English. Fictional test data only.

---

## 0. Owner decisions (2026-10-26) and how the build applies them

| # | Owner decision | Build |
|---|---|---|
| 1 | Order: code stages first on the raw text, then ONE short cleanup LLM call with the dictation language, then polish (high only), then tone (tone on only), then the dictionary last. | `runDictationPipeline` (`apps/server/src/lib/dictation/pipeline.ts`): S1 line commands, S2 counted lists, S3 contact info, S4 numbers, S5 cleanup, S6 polish, S7 tone, S8 list markers, S9 fragments. `postProcess` applies the dictionary after the pipeline. "One call" is one call per line part, lead-in or list item, as in the measured prototype. |
| 2 | Low = code stages only, no LLM call at all. | Low runs S1 to S4, then the light format in code (filler sounds out, capitals, English "I", a final period), S9. Low also skips the tone stage (no LLM call at all). The model is not started for low. |
| 3 | Medium = code stages + the cleanup LLM call. | As decided. |
| 4 | High: keep the polish stage as it is; the owner accepts its extra edits. | The research polish prompt, unchanged. |
| 5 | Numbers: ALWAYS digits. | S4 writes all counts as digits ("at three" -> "at 3", "two adapters" -> "2 adapters"). Kept as words: the number one alone ("no one", "un café", 一下), ordinals outside dates ("the second item", 第二), es "mil" alone ("mil gracias"), and zh numbers without a unit (十分 "very", 三明治). The bench checks of `date-correction-*` now accept "3". |
| 6 | Bullets for uncounted lists only at high. | S8 runs at high only. |
| 7 | Fragments of 3 words or fewer get no period. | S9, at every intensity (zh: 6 characters or fewer). |
| 8 | Every LLM stage gets the detected dictation language. | `resolveDictationLanguage`: one configured language wins; with several configured languages the text decides (Chinese characters, then common en/es words). When a configured language has no code rules, the LLM stages get the configured list. |
| 9 | Own number tables now (en/es/zh); Recognizers-Text maybe later for fr/pt/ja. | Own tables in `stages/numbers.ts`. No new dependency. |
| 10 | Safety checks after polish and tone: numbers, emails, URLs, paths, and dates/facts where the research found a dropped fact (zh 明天). | `lostTokens` (`dictation/guard.ts`): digits, emails, URLs, paths, and date words (today, tomorrow, weekdays, months; es and zh forms; 星期三 = 周三, 本周 = 这周). A lost token: the stage keeps its input. |
| 11 | App rule: one narrow job per LLM call; rule-like work is code (AGENTS.md "LLM design ethos"). | Each LLM stage has one prompt with one job. |
| 12 | Keep: the prefix cache for the cleanup call (#339), the context budget (#340), the start-error raw-text fallback (#341), the user's Custom prompt, the injection guard, the interactive lane, call recording. Reuse Enhance patterns, not the LangGraph runtime. | Cleanup calls send `X-Openstyle-Prefix-Cache: on`. Polish and tone send no header (`prefixCache: false` on the model), so they do not replace the cached cleanup prefix. Every call goes through the context guard (a long cleanup text is cut into pieces; a polish or tone text that does not fit skips the stage). A model that does not start gives the raw text. Custom keeps the single call with the user's prompt. Cleanup keeps `TRANSCRIPT_EDIT_USER_PROMPT`; polish and tone have a short `<text>` guard. Every call runs in the `interactive` lane. Every call is written to `llm_calls` (scope `dictation`, one run per dictation, the newest 200 runs stay). |

Not built in this branch: an LLM inspector screen for dictation runs (the rows exist; the inspector shows meeting runs only), rules for de/fr/it/ja/pt, the vocabulary guard (4.5).

---

## 1. Summary

1. Build option A: deterministic code stages around one short cleanup LLM call. Optional LLM stages run only for high intensity (polish) and for a destination tone (tone). Each LLM stage has one job and a prompt of 250 to 700 tokens.
2. Put the code stages **before** the cleanup LLM, on the raw transcript: line commands split the text, contact info and spoken numbers become written forms, and counted lists become list items. Measured on Gemma 4 E2B: ITN 52/52, contact 52/52, line commands 20/20, against 16/52, 44/52 and 0/20 for today's prompt (section 6.2).
3. Give every LLM stage the dictation language. Without it, the extra stages translated Spanish and Chinese text to English (section 6.1).
4. Do not add a grammar LLM stage for medium. It gave no gain, it cost 4 bench passes, and it added about 115 ms p50 (section 6.2). The cleanup call already fixes grammar on E2B, also when it is told not to.
5. Result on E2B (81 cases x 4 passes, language known): 240/324 against 144/324 for today. Bench (27 old cases): 52/108 against 36/108. Latency p50/p95: low 93/155 ms, medium 125/232 ms (today 158/373 ms). Blind judge (pass 1, 81 pairs): pipeline 35 wins, today 10 wins, 36 ties.
6. Result on Gemma 4 E4B: 260/324 against 188/324; bench 60/108 against 40/108.
7. Option B (one LLM call per stage) lost on ITN (20/52) and contact info (40/52), and it adds a call. Option C (one call with tagged spans) is not measured. It puts several jobs in one prompt, so it conflicts with the owner rule (section 3).

---

## 2. Problem

A 333-word short prompt beat the 4k-token prompt on the 27-case bench (E2B 36 vs 32 of 108, E4B 60 vs 40, blind judge E2B 13 to 2). The short prompt drops these jobs:

- spoken dates, times, money and percentages as digits;
- contact info: emails, URLs, file paths, phone numbers;
- spoken symbols ("dot", "slash", "underscore");
- "new line" and "new paragraph" commands;
- intensity levels (low, medium, high);
- destination tone rules;
- short fragments without a forced period;
- bullets for uncounted lists.

This spec moves each job to its own stage.

---

## 3. Options

Criteria: **focus** (owner rule: one narrow job per LLM stage), quality, latency, languages, failure modes.

| | A: code stages + short cleanup LLM + optional LLM stages (recommended) | B: one small LLM call per stage | C: one LLM call with structured output (tagged spans), code formats |
|---|---|---|---|
| Focus | High. LLM stages: cleanup, polish, tone, each one job. Rule jobs are code. | High per call, but rule jobs go to an LLM. | Low. One prompt must clean, resolve corrections and tag dates, money, contacts, commands and lists. This is over-prompting by the owner rule. |
| Quality (E2B, measured) | 240/324 (pre-list arm). ITN 52/52, contact 52/52, line 20/20. | ITN 20/52, contact 40/52 (LLM "format" stage, 54 new cases x 4). The guard rejected 28 of 216 format outputs. | Not measured. E2B already mangles spoken contact strings in free text ("Write to Ana lopez.com", "www.puntoejemplo.es"). It must also copy exact spans into JSON. |
| Latency low / medium | 1 LLM call (+1 for each extra line part or list item). E2B p95 155 / 232 ms. | 2 or more calls. E2B p95 292 / 313 ms with one format call. | 1 call with a grammar-constrained JSON answer. Longer output (JSON + span tags). Not measured. |
| Deterministic | Code stages: yes. LLM at temperature 0 was byte-stable in all arms (81/81 cases same in 4 passes). | No. | Partly. |
| Languages | Code per language (en, es, zh done). Other languages pass through the code stages unchanged. | Prompt per language is easy, but small-model accuracy is low. | Same as A for the code part. |
| Main failure mode | A rule misses a form, so the words stay as spoken (safe). A rule false positive changes text (for example an email rule on "meet me at x dot com"; a stop list blocks the common case). | The LLM changes other words or translates. | Bad JSON, lost or shifted spans, wrong tags. |

Order of stages, and why code runs before the LLM (measured, section 6.1 and 6.2):

1. E2B ignores "keep 'new line' as words" and deletes the command (0/20 line cases in every arm that ran the LLM first). A split before the LLM gives 20/20.
2. E2B damages spoken contact strings in Spanish ("ana punto lopez arroba ejemplo punto com" became "Write to Ana lopez.com."). Contact code on the raw text gives 52/52.
3. Raw text is lowercase and has no punctuation. The rules are simpler and safer on it.
4. One risk of code first: a correction inside contact info ("sara at example dot com no wait example dot org"). The LLM then sees two written forms and kept the first. A small code rule now resolves "email + correction cue + domain" (section 4.3).

---

## 4. Recommended design (option A)

### 4.1 Stage order

```
raw transcript (after stripVocabLeak, sanitize)
  -> S1 code: line commands      split into parts at "new line" / "new paragraph"
  -> S2 code: counted lists      split a part into lead-in + items ("one ... two ... three")
  -> S3 code: contact info       emails, URLs, domains, file names, paths, correction in contact info
  -> S4 code: ITN                dates, times, money, percent, phone numbers
  -> S5 LLM: cleanup             one call per part / lead-in / item (punctuation, fillers, corrections, uncounted lists)
  -> join parts                  "\n" / "\n\n", "1. item" lines
  -> S6 LLM: polish              high intensity only
  -> S7 LLM: tone                only when the destination tone is not "off"
  -> S8 code: list markers       high only: numbered -> "- " when nothing was counted
  -> S9 code: fragments          no final period on a raw text of 3 words or less (6 CJK characters)
  -> S10 code: dictionary        applyDictionaryReplacements (unchanged, last)
```

### 4.2 Stage contracts

Every stage is a function `(text, ctx) -> text`. `ctx` holds `raw`, `language`, `intensity`, `tone`, `signal`. A stage never throws. On a fault it returns its input and records the fault (fail-closed, as the Enhance nodes do with their `failed*` results).

| Stage | Owns | Does not own | Languages now | Fallback |
|---|---|---|---|---|
| S1 line commands | en "new line", "new paragraph", "next line"; es "nueva línea", "nuevo párrafo", "punto y aparte", "salto de línea"; zh 换行, 新段落, 另起一段 | anything else | en, es, zh | no command: one part |
| S2 counted lists | markers in order: one..six, first..sixth, uno..seis, primero..sexto, 第一..第六. 3 or more plain numbers, 2 or more ordinals. Each item must have text. | uncounted lists (LLM) | en, es, zh | no match: no split |
| S3 contact info | "dot/punto/点", "at/arroba/艾特", "slash/barra", "colon", "underscore", "dash" inside names; a known last label (TLD or file type); a stop list for the email local part ("me", "us", "office"); correction cue + new domain | phone numbers (S4) | en, es, zh (latin spans) | no match: words stay |
| S4 ITN | en: Month + day [+ year], H [MM] am/pm, "o'clock", N + currency word, N percent, 7+ digit words. es: N de mes [de año], "a las H y media / de la tarde", N + moneda, N por ciento, 7+ digits. zh: 年 with 4 digits, 月/号/日, time with 上午/下午/早上..., N + 块钱/元/美元, 百分之N, 7+ digit characters | bare numbers ("at three", "一个", "two adapters") stay words | en, es, zh | no match: words stay |
| S5 cleanup LLM | punctuation, capitals, fillers, self-corrections, uncounted list layout. Prompt: the 333-word short prompt + one rule: "keep digits, emails, web addresses, file paths and phone numbers exactly as written" + the language block | digits, contacts, commands, tone, polish | all (prompt is language-neutral, language block from settings) | raw part |
| S6 polish LLM | high intensity rewrite: reword, merge, remove empty phrases, keep facts | tone | all | input text (guard) |
| S7 tone LLM | the existing destination tone block (+ email structure block for email) with a short frame prompt | facts, numbers | all | input text (guard) |
| S8 list markers | high only: "1." -> "- " when the raw text has fewer than 2 counting cues | | en, es, zh | unchanged |
| S9 fragments | strip one final "." or "。" from a single-line answer of a very short raw text | | all with spaces; zh by characters | unchanged |
| S10 dictionary | user replacements | | all | unchanged |

Guard for S6 and S7: after the call, the text must still contain every protected token of its input (emails, URLs, paths, numbers). If one is missing, or the answer is empty, the stage returns its input. Measured: 4 of 28 polish answers fell back on E4B, 0 on E2B.

### 4.3 Language coverage

- en, es, zh: code stages done in the prototype.
- App UI locales de, fr, it, ja, pt: S1 to S4 pass through unchanged until rules exist. The cleanup LLM still runs. The command words for these languages need a native check before build (UNVERIFIED lists: de "neue Zeile", "neuer Absatz"; fr "à la ligne", "nouveau paragraphe"; it "a capo", "nuovo paragrafo"; pt "nova linha", "novo parágrafo"; ja 改行).
- Numbers for fr, pt, ja: Microsoft Recognizers-Text has JS cultures for them (section 5). de and it have no JS culture there, so they need own word tables.
- The language must reach every LLM stage. Sources in order: the language hotkey pin, a single configured language, the ASR language (Qwen3-ASR reports one; not checked in this spike), else the auto block. With several configured languages and no ASR language, the stages use the auto block, and round 1 shows the translate risk (section 6.1).

### 4.4 Intensity and tone

| Setting | Stages | LLM calls (E2B p50 / p95, measured) |
|---|---|---|
| low | S1-S5, S9, S10 | 1 (93 / 155 ms) |
| medium (default) | same as low | 1 (125 / 232 ms) |
| high | + S6 polish, S8 | 2 (396 / 494 ms) |
| any + tone | + S7 tone | +1 (medium + tone 207 / 419 ms) |

Extra parts from S1 and items from S2 add one cleanup call each (about 60 to 100 ms with a prefix cache hit).

Low and medium give the same output on E2B in this design. The cleanup call fixes grammar also at low (all arms, including today's prompt, failed both "low keeps the grammar error" cases). A separate grammar stage for medium gave no gain (section 6.2). This is an open decision (section 9).

### 4.5 Custom vocabulary and dictionary

- Vocabulary stays an ASR bias prompt, as today. It does not go into the cleanup prompt, so the system prefix stays fixed and the prefix cache keeps working.
- The dictionary stays the last stage (S10), as today, so no LLM stage can undo a replacement.
- Follow-up (not built): add vocabulary terms to the S6/S7 guard tokens, so that polish or tone cannot change a vocabulary spelling.

### 4.6 Runtime shape and Enhance reuse

- Dictation is synchronous and on the hot path. Use a plain async chain of stage functions, not a LangGraph run. A LangGraph run writes checkpoints to SQLite (`NodeSqliteSaver`, `meetings/workflow/graph.ts`). That cost is not measured here (assumption: it is not needed for a call of less than 1 s that is not resumed).
- Reuse from Enhance: one typed result per stage, fail-closed fallback per stage, the call recorder (`llm_calls`) so the LLM inspector shows each stage, and the `interactive` lane for every dictation stage (`withLlmLane`).
- Prefix cache: the worker keeps one entry (spec llm-runtime-tuning 10). The cleanup prompt hits it (228 of 364 cleanup calls on E2B in the mixed-language bench). Polish and tone calls always missed (0 of 28, 0 of 24), because the cleanup prompt replaces the entry. Their prompts are 280 to 330 tokens, so a miss costs little (polish p50 180 ms, tone p50 97 ms on E2B). A cache with one entry per stage prompt is a possible follow-up.

### 4.7 Latency budget (E2B, p95)

| Part | Budget | Measured |
|---|---|---|
| Code stages S1-S4, S8-S10 | 5 ms | 0 to 1 ms |
| S5 cleanup, one part | 250 ms | 217 ms |
| low / medium total | 1,000 ms (gate) | 155 / 232 ms |
| high total | 1,500 ms (proposal) | 494 ms |
| tone total | 1,500 ms (proposal) | 419 ms |

E4B: medium 461 ms, high 915 ms, medium + tone 783 ms (pre-ng arm).

---

## 5. ITN survey (accessed 2026-10-26)

| Option | License | ITN languages | Runtime | Fit for the TS server | Last release | Risk |
|---|---|---|---|---|---|---|
| Microsoft Recognizers-Text JS (`@microsoft/recognizers-text-suite` 1.3.1), https://github.com/microsoft/Recognizers-Text | MIT | en, zh-cn, es-es, pt-br, fr-fr, ja-jp (local run: de and it returned nothing) | pure JS, 42 MB node_modules | direct: gives spans + values | npm 2023-07-31; JS port frozen | no spoken email/URL/phone; date false positives ("twenty five" -> 20:05, "five five" -> 05:05) |
| NVIDIA NeMo text processing, https://github.com/NVIDIA/NeMo-text-processing | Apache-2.0 | ar, de, en, es, fr, he, hi, hy, ja, ko, mr, pt, ru, sv, vi, zh (no it) | Python + Pynini/OpenFst; pip on macOS not supported (README) | Python worker only | PyPI 1.2.0, 2026-06-05 | heavy dependency; FAR export needs Sparrowhawk (archived) |
| Google Sparrowhawk, https://github.com/google/sparrowhawk | Apache-2.0 | none of its own (runs NeMo grammars) | C++ | native addon | archived, last push 2018-06-16 | dead project |
| sherpa-onnx, https://github.com/k2-fsa/sherpa-onnx | Apache-2.0 | one rule FST: zh numbers | native addon | not usable: ITN runs inside its ASR recognizer only (no plain-text API found, UNVERIFIED) | npm 2.0.1, 2026-10-26 | |
| WeTextProcessing, https://github.com/wenet-e2e/WeTextProcessing | Apache-2.0 | zh, en, ja | Python + Pynini, C++ runtime | Python worker | PyPI 1.2.0, 2026-06-10 | no es |
| wetext, https://github.com/pengzhendong/wetext | Apache-2.0 | zh, en, ja | Python (kaldifst) | Python worker | PyPI 0.1.8, 2026-09-09 | no es; FST source UNVERIFIED |
| chrono-node, https://github.com/wanasit/chrono | MIT | date parsing only, 16 locales | pure JS | direct, detection only | 2.10.3, 2026-10-12 | spelled numbers per locale UNVERIFIED |
| words-to-numbers / written-number / chinese-numbers-converter / nzh (npm) | MIT / MIT / Unlicense / BSD-2 | en / TN only / zh / zh | pure JS | direct for numbers only | 2018 / 2022 / 2022 / 2024 | unmaintained or numbers only |
| Whisper EnglishTextNormalizer, https://github.com/openai/whisper/blob/main/whisper/normalizers/english.py | MIT | en | Python | port only | 20250625 | made for WER scoring; lossy |
| Neural ITN (NVIDIA itn_en_t5, others) | mixed (one is GPL-3.0) | en only | Python/ONNX | not usable | | no multilingual model with a commercial license found (UNVERIFIED as absent) |

Measured with Recognizers-Text (local run, Node 26, fictional inputs): load 35 ms; first call per culture 15 to 210 ms; warm calls 0.01 to 13 ms. It found "march fifteenth at three pm" (XXXX-03-15T15), "twenty five dollars" (25 Dollar), "quince de marzo a las tres de la tarde", "二十五块钱" (25 CNY). It found no email in "john dot smith at example dot com" and no phone number in "five five five one two three four".

Conclusion: no library covers the spoken contact forms, and none covers all app languages in JS. Own rules (as in the prototype) cover en/es/zh today at 0 to 1 ms. Recognizers-Text is a candidate for the number part of fr, pt and ja later, with its date/time recognizer limited to a date context.

---

## 6. Prototype measurements

Method: the app provider (`local-mlx-llm`, task `cleanup`, prefix cache header on), a worker built from `262d3127` with the build script, temperature 0, 4 passes, each run under `/tmp/openstyle-gpu.lock`. Cases: the 27 bench cases (medium) + 54 new fictional cases. The cases are sorted by intensity and tone, so that the prefix cache sees the same prompt run after run, as in real use. Every arm gave the same output in all 4 passes (81/81).

### 6.1 Round 1 (no language given, code after the cleanup LLM or before it)

| E2B | today | post (code after LLM) | pre (contact + ITN before LLM) |
|---|---|---|---|
| All (324) | 140 | 164 | 172 |
| Bench (108) | 32 | 32 | 36 |
| Line commands (20) | 0 | 0 | 0 |
| Contact (52) | 44 | 44 | 48 |

Findings: the cleanup LLM deleted "new line" in every arm. The grammar, polish and tone stages translated es/zh text to English ("It costs 25 dollars", "Please provide the numbers for tomorrow").

### 6.2 Round 2 (language given to every stage; line commands split before the LLM)

Pass counts over 4 passes. The today arm also gets the language (`languages: [lang]`).

| E2B | today | pre (+ grammar stage) | pre-ng (no grammar stage) | pre-list (pre-ng + counted-list code) | llm-fmt (option B, new cases only) |
|---|---|---|---|---|---|
| All (324) | 144 | 228 | 232 | **240** | 136 of 216 |
| Bench (108) | 36 | 40 | 44 | **52** | |
| ITN (52) | 16 | 52 | 52 | 52 | 20 |
| Contact (52) | 44 | 52 | 52 | 52 | 40 |
| Line commands (20) | 0 | 20 | 20 | 20 | 20 |
| Mixed (8) | 0 | 8 | 8 | 8 | 0 |
| Lists, high (16) | 8 | 8 | 8 | 8 | 8 |
| Fragments (16) | 12 | 12 | 12 | 12 | 12 |
| Tone (24) | 16 | 16 | 16 | 16 | 16 |
| Intensity (28) | 12 | 20 | 20 | 20 | 20 |
| New cases by language: en / es / zh | 68 / 20 / 20 | 88 / 60 / 40 | 88 / 60 / 40 | 88 / 60 / 40 | 68 / 32 / 36 |

| E4B | today | pre-ng |
|---|---|---|
| All (324) | 188 | 260 |
| Bench (108) | 40 | 60 |
| ITN / contact / line (52 / 52 / 20) | 40 / 48 / 0 | 52 / 52 / 20 |
| Tone (24) | 20 | 24 |
| Fragments (16) | 16 | 12 |

Latency, wall time per dictation, ms p50 / p95 (code stages included):

| | today E2B | pre-ng E2B | pre-list E2B | pre (grammar) E2B | today E4B | pre-ng E4B |
|---|---|---|---|---|---|---|
| low | 161 / 207 | 88 / 143 | 93 / 155 | 97 / 155 | 399 / 500 | 209 / 284 |
| medium | 158 / 373 | 125 / 228 | 125 / 232 | 260 / 437 | 274 / 787 | 227 / 461 |
| high | 289 / 354 | 392 / 488 | 396 / 494 | 395 / 489 | 717 / 836 | 701 / 915 |
| medium + tone | 274 / 387 | 208 / 409 | 207 / 419 | 311 / 574 | 758 / 1,012 | 437 / 783 |

Input tokens p50: today 4,025; cleanup 675; polish 282; tone 332. Today's arm hit the prefix cache on 192 of 324 calls; misses come from the language block, which changes with each case language in this mixed bench (in real use the language set is fixed).

### 6.3 Blind judge

A fresh Claude subagent judged pass 1 of E2B round 2, today against pre-ng, 81 pairs with a random A/B order (`judge/pairs.json`, `judge/map.json`, `judge/verdicts.json`): **pre-ng 35, today 10, tie 36.**

- Pipeline wins: ITN 9, line commands 5, contact 4, bench 8, intensity 3, tone 2, mixed 2, fragment 1, list 1.
- Today wins: list/high 3 + intensity 2 (the polish stage over-edits: "docs" became "documentation", one zh item merged), tone 2 (zh formal lost "明天"; one very casual answer dropped words), date-correction-en (the judge preferred today's "at 3" to the pipeline's "at three"; the bench check wants "three", so this is the number-style decision in 9.3), recipient-correction-en (the pipeline kept the retracted "marketing"), fragment-es.
- pre-list differs from pre-ng in 3 cases only (2 counted lists fixed, 1 unchanged), so the judge result also holds for it.

### 6.4 Remaining failures (pre-list, E2B)

- Self-corrections and uncounted lists in the cleanup LLM (bench: recipient-correction en/es, superseded-plan es/zh, dictated-list en/es/zh, list-after-correction). These are the cleanup prompt's job. E4B passes more of them (bench 60/108).
- Polish over-edits at high intensity (list-bullets-en, list-bullets-zh).
- Tone stage can drop a fact (tone-work-formal-zh lost 明天). The guard checks digits and contacts only.
- Fragment rule by word count misses a 4-word title ("notas de la reunión").
- Low vs medium: no difference on E2B (section 4.4).

---

## 7. Test plan

1. Unit tests per code stage (`apps/server/tests/dictation-stages.test.ts`): every case in `cases-new.ts`, the false-positive guards ("at three", "一个线缆", "one question and two issues", "meet me at x dot com"), idempotence (a stage run twice gives the same text), and empty input.
2. Bench: extend `apps/server/scripts/post-process-benchmark-cases.ts` with the 54 new cases and a per-case intensity and tone. Gate: pipeline pass count on E2B and E4B not lower than the prototype numbers (E2B 240/324, bench 52/108; E4B 260/324), and 0 language changes.
3. Latency: E2B low/medium p95 under 1,000 ms in the bench and in the real app (app-check skill, fictional dictations).
4. Blind pair judge against the current main on the full case set (Claude subagent), as in 6.3.
5. Real app proof (live-testing skill): dictations with "new line", an email, a date and a counted list, in light and dark; the LLM inspector shows one row per LLM stage.

---

## 8. Build steps (PRs, after the owner review)

1. Code stages S1-S4, S8, S9 as pure functions in `apps/server/src/lib/dictation/stages/` with unit tests. No wiring.
2. Pipeline runner in `post-process.ts`: stage chain, per-stage fallback, the `interactive` lane per call, the call recorder per stage, the context guard per call (existing `splitTextToFit` path for long parts). Replace the presets with the short cleanup prompt for low and medium; keep a setting to return to the old prompt while the bench runs.
3. Polish (high) and tone stages with the guard. Move the tone blocks from the system prompt of the cleanup call to the tone stage.
4. Bench and judge update (7.2, 7.4), then app proof (7.5).
5. Later: rules for de, fr, it, ja, pt (native check of command words), a vocabulary guard, and a prefix cache with one entry per stage prompt.

---

## 9. Open decisions for the owner

1. **Low vs medium.** On E2B the cleanup call fixes grammar at both levels, and a grammar stage did not help. Choose: (a) merge low and medium into one level; (b) keep both names, same stages; (c) make low "code stages + punctuation only" with a stricter prompt and test it.
2. **High intensity polish** over-edits lists and details. Choose: keep it as is, give it a stricter prompt, or let high run only for texts longer than N words.
3. **Number style:** "at three" stays words (current bench expects it), "3 PM" with am/pm becomes digits, Spanish thousands "3500" (RAE style), Chinese "3月15号" keeps 号. Confirm these styles.
4. **Uncounted lists:** bullets only at high (as the old high preset), numbered at medium (as the current bench expects). Confirm.
5. **Fragment rule:** 3 words (6 CJK characters) or less, by count only. Confirm, or move it to the LLM.
6. **Language source** when several languages are configured: use the ASR language for the stages (needs a check that the ASR reports it), or keep the auto block.
7. **Recognizers-Text** for fr/pt/ja numbers (MIT, frozen JS port, 42 MB), or own tables for all languages.

---

## 10. Risks

1. A code rule false positive changes text that the speaker did not dictate as a form. Mitigation: narrow contexts (month, currency word, am/pm, TLD list, stop list), unit tests for the known traps.
2. More LLM calls per dictation when there are line commands or counted items (one call per part). Measured medium p95 stays at 232 ms on E2B; a long dictation with many commands is not measured.
3. Language detection: a wrong language label makes a stage translate. Round 1 shows the effect without a label.
4. The prototype numbers come from 81 fictional cases written for this spike. The new cases test the new stages, so they favour the pipeline. The 27 old cases and the blind judge are the neutral checks.
5. The tone stage can drop a fact that is not a protected token (6.4).

---

## 11. Build result (2026-10-26, branch `feat/dictation-pipeline`)

Method: `apps/server/scripts/benchmark-dictation-pipeline.ts`, the app provider `local-mlx-llm` (task `cleanup`), the worker `Openstyle-eval/worker-split-correct` (main `031df921`, `--context-tokens`), temperature 0, 4 passes, each run under `/tmp/openstyle-gpu.lock`. Arm "main" is the one-call prompt of main (`buildRewritePrompt`, preset + tone + language). Arm "pipeline" is `runDictationPipeline`. 81 cases: the 27 bench cases (medium) and the 54 fictional cases of `scripts/dictation-bench-cases.ts`. The `date-correction-*` checks accept "3" (owner rule: digits). The es and zh `list-after-correction` expectations use the counted-list style of en ("1. Cable"). Both arms are scored with the same checks. Every arm gave the same output in all 4 passes (81/81).

Prompt sizes (real input tokens p50 on E2B, with the text): cleanup 674 (350 words of instructions), polish 317 (151 words), tone 549 (57 words + the destination tone block). Main: 4,025.

| Pass counts (of 4 passes) | E2B main | E2B pipeline | E4B main | E4B pipeline |
|---|---|---|---|---|
| All (324) | 148 | **244** | 192 | **272** |
| Bench (108) | 40 | 52 | 44 | 68 |
| Numbers (52) | 16 | 48 | 40 | 52 |
| Contact (52) | 44 | 52 | 48 | 52 |
| Line commands (20) | 0 | 20 | 0 | 20 |
| Mixed (8) | 0 | 8 | 0 | 8 |
| Lists, high (16) | 8 | 8 | 12 | 8 |
| Fragments (16) | 12 | 12 | 16 | 12 |
| Tone (24) | 16 | 16 | 20 | 24 |
| Intensity (28) | 12 | 28 | 12 | 28 |
| en / es / zh | 84 / 32 / 32 | 112 / 76 / 56 | 92 / 52 / 48 | 120 / 84 / 68 |

Latency per dictation, ms p50 / p95 (code stages included):

| Setting | E2B main | E2B pipeline | E4B main | E4B pipeline |
|---|---|---|---|---|
| low (n=8) | 194 / 312 | 0 / 1 (no LLM call) | 348 / 469 | 0 / 1 |
| medium (n=264) | 145 / 307 | 127 / 250 | 272 / 719 | 232 / 495 |
| high (n=28) | 313 / 459 | 390 / 482 | 694 / 783 | 726 / 862 |
| medium + tone (n=24) | 291 / 391 | 206 / 407 | 717 / 903 | 436 / 747 |

Cleanup prefix cache hits: main 192/324, pipeline 304/424 (cleanup calls only; polish and tone send no header).

Blind pair judge (3 fresh Claude subagents, own random order and sides each, E2B pass 1, 81 pairs, owner rules in the brief): pipeline 36 / 37 / 37 wins, main 12 / 11 / 9, tie 33 / 33 / 35. All 3 agree on 74/81 pairs (pairwise 94 %). By majority: pipeline 37, main 11, tie 33. Main won: a very casual tone answer that dropped "are you" (the guard does not see it), a final period after a URL or email (3 cases; fixed after the judge with `contactEnd`, outputs re-run, same pass counts), `gonna` kept (owner rule: keep casual words), counted list split from the lead-in, `fragment-es` (4 words), `recipient-correction-en`, `list-bullets-zh`.

Remaining failures (pipeline, E2B): self-corrections and uncounted lists in the cleanup call (bench), E2B rewrites some digits back to Chinese numerals (`itn-money-zh`: 25 -> 二十五), the zh formal tone answer drops 明天 and the guard keeps the cleanup text (`tone-work-formal-zh`), polish over-edits lists (`list-bullets-*`), the 3-word fragment rule misses the 4-word `fragment-es`.

Real app (Test Runner, quiet mode, isolated profile, Qwen3-ASR 1.7B + Gemma 4 E2B, fictional audio through `POST /api/transcribe`): low, medium, high and medium + professional tone all 200; History shows the four results in light and dark; `llm_calls` holds 0 calls for low, 2 cleanup for medium, 2 cleanup + 1 polish for high, 1 cleanup + 1 tone for the tone run; 0 Privacy prompts in that run.
