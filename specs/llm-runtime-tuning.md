# Technical Spec: Local MLX LLM run settings, model pool and fit label

**Status:** Measured. Waits for the owner review. The build PRs come after the review.
**Date:** 2026-10-26
**Scope:** `scripts/mlx_asr_server.py` (LLM mode), `apps/server/src/lib/mlx-llm/`, `apps/server/src/lib/mlx-asr/http-worker.ts`, the Models page.
**Baseline:** `main` at `e675e553` (5 catalog models after #335). Step 1 code: commit `38c6d2a1` on `feat/llm-runtime-tuning`.
**Research:** the two research reports of 2026-10-26 (runtime choice and run settings). The owner approved "keep mlx-lm as a library in our worker".
**Raw numbers:** `eval-baselines/2026-10-26-llm-runtime-tuning.json` (numbers only).

Writing rules: Simplified Technical English. No meeting text in this file.

---

## 1. Summary

1. Keep the mlx-lm defaults for all 5 models: prefill step 2048, no KV quantization, no `max_kv_size`, no MLX cache limit. Each other value lost on speed, memory or output identity (sections 4.2, 4.4, 4.5).
2. Add a prefix cache for dictation cleanup. Cut the cached prefix at a prefill step boundary. Then the output is byte-identical to no cache (324 of 324 dictation outputs, 36 of 36 meeting calls). Dictation p50 drops 22 % to 34 % (section 4.3).
3. Do not use the prefix cache for Enhance and Summarize. The gain is 1 % to 3 % of wall time. An unaligned cache changed the output of 2 to 7 of 10 chunk calls at temperature 0 (section 4.3).
4. Keep `gemma-4-26b-a4b-qat-4bit`. The `qat-6bit` repo needs 6.2 GB more disk and 5.7 GB more RSS, is 13 % to 30 % slower, and lost the blind judge on both gold meetings (section 4.6).
5. Apple Foundation Models is not a dictation fast path with our cleanup prompt. It was 11 times slower than Gemma 4 E2B (p50 3,305 ms against 304 ms) and lost the blind pair judge 6 to 17 (section 4.8).
6. A model pool with one process per model works on this Mac. With ASR, E2B and 26B-A4B loaded at the same time, the total RSS was 21.6 GiB and no swap was used. A dictation during a 26B Summarize took p95 1,286 ms. Today (one worker for all tasks) a dictation that comes during a Summarize waits for it: p95 7,099 ms (section 4.7).
7. The fit label uses measured peaks and the GPU cap that the worker now reports. Section 5 gives the formula and the table for 8 to 128 GiB.

---

## 2. This Mac and the method

| Item | Value | Source |
|---|---|---|
| Mac | Apple M5 Max, 128 GiB (137,438,953,472 B), macOS 27.0.1 | `sysctl hw.memsize` |
| GPU cap | `max_recommended_working_set_size` = 115,448,725,504 B = 107.5 GiB = 84.0 % of RAM | worker ready line (step 1), run R1 |
| Pins | mlx 0.32.3, mlx-lm 0.32.2, llguidance 1.9.1 | `scripts/build_mlx_asr_worker.sh` |
| Worker | frozen build of commit `38c6d2a1` (`dist/mlx_asr_worker`); prototype runs used the same source with the build venv and `OPENSTYLE_PROTO_*` knobs (not committed) | |
| Model cache | `~/Library/Application Support/Openstyle-eval/hf` | |
| Owner app | 13 processes, RSS 1.65 GiB (read with `ps`, read only) | |

Rules for every run:

- Each run held `/tmp/openstyle-gpu.lock`. No two GPU jobs ran at the same time. The lock log lines are in the run logs.
- The worker ran as a child process and got the same HTTP requests as in the app. Meeting calls are the stored first-attempt requests of gold meetings 5578edb0 and ca70f895 (11 + 7 = 18 calls: correctChunk, identifySpeakers, summarize, suggestTags). Dictation calls come from `apps/server/scripts/benchmark-post-process.ts --provider=local-mlx` (27 fictional cases, app prompt builder and app provider), 4 passes = 108 samples.
- Long prompts are the real Summarize request of ca70f895 with more transcript lines from the 4 captured meetings, cut to 8k, 16k and 28k tokens with the model tokenizer.
- Temperature 0. "Byte-equal" means the same sha256 of the answer text.
- `peak_memory` is the MLX peak of one request (step 1 resets it per request). RSS comes from `ps` every 100 ms. RSS is lower than the MLX peak for the big models (27B: RSS 14.95 GiB, MLX peak 18.38 GiB at 28k). So the fit formula uses the MLX peak.
- File cache: the model files were in the OS file cache. A real cold load after a reboot was not measured (it needs `sudo purge`).
- MLflow: no harness here has a tracing path. `meeting:eval` removes the tracing variables on purpose (real meeting text). The dictation bench and the replay scripts call the worker directly. No trace was written, so no experiment exists to read back.

---

## 3. Step 1 (in this PR): stats and GPU cap from the worker

- `usage` of each chat completion now has `ttft_ms`, `total_ms`, `prompt_tps`, `generation_tps` and `peak_memory_bytes` (mlx-lm `GenerationResponse`; the peak counter is reset before each request).
- The ready line has `metal: {max_recommended_working_set_size, memory_size}` from `mx.device_info()`. The server keeps it and shows it as `worker.gpu` on `GET /api/mlx-llm/status`.
- The dictation bench requests the raw response body and prints worker TTFT p50/p95.
- Tests: `scripts/test_mlx_asr_server.py` (usage stats, peak reset, ready line, no Metal) and `apps/server/tests/mlx-llm.test.ts` (status shows `gpu`).
- Real proof: every run below read these fields from the real worker (for example R1 E2B: `ttft_ms` 128, `prompt_tps` 24,375, `generation_tps` 144.5 on a 3,042-token chunk).

---

## 4. Measurements

### 4.1 R1 baseline, all catalog models (frozen worker, default settings)

| Model | Load to ready (s) | Idle RSS (GiB) | MLX peak, gold calls (GiB) | Prefill tok/s (median) | Decode tok/s (median) | Enhance ca70f895 (s) | Summarize ca70f895, 7.6k tok (s / TTFT ms) | Dictation p50 / p95 (ms) | Dictation TTFT p50 / p95 (ms) | Dictation bench pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Gemma 4 E2B | 3.0 | 4.28 | 4.19 | 23,985 | 144.3 | 82 | 5.0 / 342 | 304 / 494 | 180 / 203 | 8/27 |
| Gemma 4 E4B | 3.6 | 6.66 | 6.54 | 6,842 | 85.9 | 156 | 5.6 / 1,158 | 764 / 1,069 | 561 / 628 | 11/27 |
| Nemotron 3.5 Bolt E4B | 3.3 | 5.10 | 5.01 | 8,196 | 118.7 | 102 | 5.4 / 1,021 | 670 / 891 | 524 / 572 | 14/27 |
| Gemma 4 26B-A4B | 4.1 | 14.73 | 15.07 | 4,283 | 114.7 | 106 | 6.2 / 1,846 | 1,090 / 1,360 | 944 / 1,008 | 12/27 |
| Qwen3.8 27B | 3.4 | 14.94 | 17.26 | 736 | 30.8 | 282 | 32.2 / 9,839 | 5,664 / 6,493 | 5,078 / 5,546 | 11/27 |

- All 90 gold calls gave valid JSON with finish `stop`.
- The dictation system prompt is about 4k tokens (15,803 characters). So the TTFT is most of the dictation time. This is why the prefix cache helps dictation (4.3).
- Load time is with the files in the OS file cache. It is short for all models (3.0 to 4.1 s).

### 4.2 R2 long prompt and prefill step size

Prompt 28k tokens, answer budget 32 tokens (prefill only). MLX peak in GiB and prefill tok/s.

| Model | step 512 | step 1024 | step 2048 (default) | step 4096 |
|---|---|---|---|---|
| E2B | 4.10 / 17,191 | 4.73 / 19,088 | 5.03 / 18,074 | 5.45 / 18,204 |
| E4B | 6.85 / 6,472 | 6.91 / 7,264 | 7.39 / 7,114 | 8.17 / 6,498 |
| Nemotron | 5.31 / 6,633 | 5.37 / 7,520 | 5.85 / 6,726 | 6.63 / 7,347 |
| 26B-A4B | 15.24 / 3,112 | 15.75 / 3,581 | 16.20 / 3,674 | 15.98 / 3,429 |
| 27B | 17.54 / 750 | 17.54 / 786 | 18.38 / 775 | 20.40 / 757 |

At 8k tokens, step 2048 was the fastest for E2B (14,248 against 11,689 at 1024), Nemotron and 26B-A4B (4,600 against 4,098).

Real Summarize at 28k tokens (full answer, step 2048):

| Model | Wall (s) | Answer tokens | Decode tok/s | MLX peak (GiB) |
|---|---|---|---|---|
| E2B | 7.5 | 717 | 124.8 | 5.03 |
| E4B | 11.3 | 478 | 65.7 | 7.39 |
| Nemotron | 8.4 | 378 | 83.0 | 5.85 |
| 26B-A4B | 13.4 | 576 | 96.1 | 16.20 |
| 27B | 62.8 | 750 | 27.7 | 18.38 |

MLX cache limit 1 GiB plus `mx.clear_cache()` after each request: idle RSS after the 28k Summarize did not go down on any model (E2B 4.37 GiB both arms, 27B 14.95 against 14.94 GiB). Wall time did not change.

Decision: keep step 2048 and no cache limit. Step 1024 saves 0.3 to 0.8 GiB at 28k, but it is slower at 8k on E2B (-18 %) and 26B (-11 %), and a step change changes the temperature-0 output (the chunk borders move). Step 4096 raises the peak by up to 2.0 GiB (27B) with no speed gain.

### 4.3 R3 prefix cache (prototype in the worker)

Prototype: one cache entry per worker. On a miss, when the prompt shares 32 or more tokens with the last prompt, the worker prefills that common prefix once, keeps it, and gives a deep copy to the request. The prototype code is not in this PR; section 7 step 2 builds it.

Without the cache, the output is deterministic: the frozen worker (R1) and the venv worker (R3 off) gave the same answer on 90 of 90 gold calls.

Meeting calls (18 per model, 10 cache hits of about 1,103 to 1,111 tokens each):

| Model | Byte-equal, unaligned cache | TTFT of the hits, off -> on (ms, sum) | Wall, off -> on (s, 18 calls) | Byte-equal, step-aligned cache |
|---|---|---|---|---|
| E2B | 16/18 | 1,104 -> 883 | 116.0 -> 112.5 | not run |
| E4B | 16/18 | 3,351 -> 2,563 | 226.6 -> 220.9 | 18/18 (0 hits) |
| Nemotron | 12/18 | 3,102 -> 2,430 | 167.6 -> 168.6 | not run |
| 26B-A4B | 11/18 | 5,462 -> 4,382 | 165.2 -> 162.2 | 18/18 (0 hits) |
| 27B | 14/18 | 28,022 -> 21,437 | 489.5 -> 474.5 | not run |

All changed answers were correctChunk calls. All answers stayed valid JSON with finish `stop`. The JSON grammar reads only the last token, so the cache does not break it.

Cause of the changed answers: the cached prefix moves the prefill chunk borders. Different matrix shapes give small float differences, and greedy decoding can then pick another token. A prefix cut at a multiple of the prefill step (2048) keeps the chunk borders of the no-cache path, so the math is the same. The common prefix of the meeting calls is about 1,100 tokens, so the aligned cut is 0 and no hit happens.

Dictation (108 samples per arm, app provider code):

| Model | No cache p50 / p95 (ms) | Unaligned cache p50 / p95 | Aligned cache p50 / p95 | TTFT p50: off / unaligned / aligned (ms) | Outputs that differ from no cache: unaligned / aligned |
|---|---|---|---|---|---|
| E2B | 280 / 449 | 142 / 332 | 219 / 394 | 165 / 22 / 98 | 0 / 0 of 108 |
| E4B | 724 / 1,044 | 234 / 607 | 517 / 841 | 517 / 41 / 290 | 4 / 0 of 108 |
| Nemotron | 650 / 866 | 181 / 452 | 429 / 660 | 495 / 35 / 274 | 12 / 0 of 108 |

The unaligned cache changed one bench verdict on E4B and one on Nemotron (a zh case each went from pass to fail). The aligned cache changed no output.

Quality gate (`meeting-eval/scripts/run.sh gemma-4-e2b-qat-4bit`, both gold meetings): the baseline arm (frozen worker) and the arm with the aligned cache on gave the same Enhance text hashes (5578edb0 `1a785a51fdc499ca`, ca70f895 `604f1505b78ada66`), the same token counts (20,253 / 4,216 and 43,935 / 12,377) and the same hard fails (5578edb0: 1, gold `claim:c1`; ca70f895: 0). The `claim:c1` fail is in both arms, so it is not new. The outputs are identical, so a blind judge has nothing to compare.

Decision: build the aligned prefix cache for dictation cleanup. Do not use it for Enhance and Summarize now.

### 4.4 R5 KV cache quantization

- Gemma (E2B and 26B-A4B), `kv_bits=8`, 8k prompt: the worker returned HTTP 500 with `{"error": {"message": "RotatingKVCache Quantization NYI", "type": "server_error"}}` (mlx-lm 0.32.2, `mlx_lm/models/cache.py` `RotatingKVCache.to_quantized`). So KV quantization cannot run on any Gemma 4 model.
- Qwen3.8 27B, real Summarize prompts:

| Arm | 16k: MLX peak GB / decode tok/s / wall s | 28k: MLX peak GB / decode tok/s / wall s | Answer same as fp16 |
|---|---|---|---|
| no KV quant | 18.93 / 28.6 / 45.7 | 19.74 / 27.7 / 62.6 | - |
| `kv_bits=8` | 19.79 / 26.1 / 48.7 | 21.43 / 23.5 / 73.3 | no (both lengths) |
| `kv_bits=4` | 19.56 / 26.1 / 50.7 | 20.99 / 24.1 / 65.9 | no (both lengths) |

(GB = 1e9 bytes.) KV quantization raised the peak and made decode slower. Reason: only 16 of the 64 layers have a KV cache, and the conversion at `quantized_kv_start` keeps the fp16 copy alive. The answers were not judged for quality, because the setting loses on both memory and speed.

Decision: no KV quantization on any model.

### 4.5 Context cap

`max_kv_size` has no effect: all 5 models build their own cache (`make_cache`). The server already keeps a single Summarize call at or under `contextTokens` (32,768) minus the answer budget and 256 safety tokens (`fitsContext`, `apps/server/src/lib/meetings/workflow/unit.ts`). The worker does not check the length. Section 7 step 4 adds a typed 400 in the worker.

### 4.6 R4 Gemma 4 26B-A4B qat-6bit against qat-4bit

The repo `mlx-community/gemma-4-26B-A4B-it-qat-6bit` exists (HF API, sha `9c780d2f`, 21,813,640,502 bytes in the files that mlx-lm loads). Run: `meeting-eval/scripts/run.sh gemma-4-26b-a4b-qat-4bit,gemma-4-26b-a4b-qat-6bit` with a temporary catalog entry (not committed).

| | qat-4bit | qat-6bit |
|---|---|---|
| Disk (GB) | 15.64 | 21.81 |
| Peak RSS (GB), 5578edb0 / ca70f895 | 14.72 / 14.62 | 20.45 / 20.42 |
| Enhance + Summarize seconds, 5578edb0 / ca70f895 | 52.8 / 110.8 | 68.8 / 124.8 |
| Hard fails, 5578edb0 / ca70f895 | 0 / 1 (names) | 1 (gold `claim:c1`) / 0 |
| Summary matched | 10/11 | 9/11 |
| Speakers correct | 4/6 | 3/6 |
| Enhance WER delta | -0.0027 | -0.0029 |
| Blind judge 5578edb0: fixes / harms / summary faults / rank | 3 / 1 / 0 / 1 | 2 / 1 / 1 / 2 |
| Blind judge ca70f895: fixes / harms / summary faults / rank | 20 / 0 / 1 / 1 | 17 / 0 / 0 / 2 |

The blind judges were Claude subagents that saw only the relabeled files (`blind.py`). Neither model is a floor model (each has 1 hard fail on one meeting).

Decision: keep qat-4bit. Do not add qat-6bit.

### 4.7 R6 concurrency and memory of the whole set

A. Today's shape (one E2B worker for all tasks). A dictation request sent 1 s after a 28k Summarize started waited for it: dictation p50 386 ms, p95 7,099 ms (the remaining Summarize time). Idle dictation: p50 379, p95 510 ms.

B. Pool shape (ASR worker Qwen3-ASR 1.7B 8-bit, an E2B dictation worker and a 26B-A4B Summarize worker, all loaded):

| Item | Value |
|---|---|
| RSS of the 3 workers, idle | 21.62 GiB (ASR about 2.56 GiB, E2B 4.40, 26B-A4B 14.66) |
| Peak RSS of the 3 workers during the run | 21.65 GiB |
| Swap | 0 MB before and after |
| `kern.memorystatus_level` | 77 before, 63 after |
| Dictation (E2B), idle | p50 389, p95 537 ms (n 20) |
| Dictation (E2B) during the 26B 28k Summarize and an ASR loop | p50 760, p95 1,286 ms (n 40) |
| ASR, 20 s fictional clip, idle | 438 ms (after a first call of 1,031 ms) |
| ASR during the same load | p50 959, p95 1,905 ms (n 31) |
| 26B Summarize 28k wall | 35.3 s (13.4 s alone, 4.2) |

The pool removes the wait behind a long call. The GPU is still shared, so a dictation during a big generation takes about 2 times longer. The spec goal "dictation within 10 % of the baseline" (`specs/local-mlx-llm.md` 5 item 4) is not met under this load. Section 6 lists a fix to measure in the build.

### 4.8 Apple Foundation Models for dictation cleanup

Earlier probe: `.scratchpad/probe-afm/results.txt` (2026-10-18; no source in git, `git log -S FoundationModels` finds nothing). It used a short prompt: 0.53 to 0.81 s per cleanup.

This run: an unsigned `swiftc` binary, run from the shell, no privacy dialog. Model `SystemLanguageModel.default`: available, `contextSize` 8192. Same 27 cases and the same app system prompt as the MLX bench, greedy sampling, a new session per case, 4 passes, one warm-up call not counted.

| | Apple FM | Gemma 4 E2B (R1) |
|---|---|---|
| Bench pass | 5/27 each pass (20/108); en 2/9, es 3/9, zh 0/9 | 8/27 |
| Latency p50 / p95 | 3,305 / 3,870 ms | 304 / 494 ms |
| Errors / empty answers | 0 / 0 | 0 / 0 |
| Blind pair judge (pass 1, 27 pairs) | 6 wins | 17 wins (4 ties) |

Apple FM is slow here because it prefills the 4k-token app prompt on each new session. It also answered in English for several es and zh cases. Decision: no Apple FM fast path with the current prompt. A short prompt made for Apple FM is a separate experiment.

---

## 5. Fit label

### 5.1 Formula

```
P(model)   = MLX peak at a 28k-token Summarize (4.2) + KV of 4.8k more tokens, rounded up to 0.1 GiB
others     = app 1.65 GiB + ASR worker 2.56 GiB (when a local ASR model is selected)
reserve    = 3 GiB when RAM <= 16 GiB, else 4 GiB   (UNVERIFIED: not measured)
budget     = RAM - reserve - others
gpu_cap    = max_recommended_working_set_size from the worker ready line (step 1)
Runs well  : P <= 0.80 x budget and P <= 0.90 x gpu_cap
Tight fit  : P <= budget        and P <= gpu_cap
Won't fit  : otherwise
Owner rule : Gemma 4 E2B is never "Won't fit". Its lowest label is "Tight fit".
```

Use `hw.memsize` (total RAM), not free memory, so the label does not change from minute to minute. Before the first worker start the server has no `gpu_cap`; then it uses the budget rule only.

| Model | P (GiB) |
|---|---|
| E2B | 5.1 |
| E4B | 7.5 |
| Nemotron 3.5 Bolt E4B | 6.0 |
| 26B-A4B | 16.3 |
| Qwen3.8 27B | 18.7 |

### 5.2 Table (local ASR loaded)

`gpu_cap` below uses 0.84 x RAM, the share measured on this Mac. Other Macs report their own value: the share for other RAM sizes is UNVERIFIED.

| RAM (GiB) | budget | gpu_cap | E2B | E4B | Nemotron | 26B-A4B | 27B |
|---|---|---|---|---|---|---|---|
| 8 | 0.8 | 6.7 | Tight (owner rule; formula says Won't) | Won't | Won't | Won't | Won't |
| 16 | 8.8 | 13.4 | Well | Tight | Well | Won't | Won't |
| 24 | 15.8 | 20.2 | Well | Well | Well | Won't | Won't |
| 32 | 23.8 | 26.9 | Well | Well | Well | Well | Well |
| 64 | 55.8 | 53.8 | Well | Well | Well | Well | Well |
| 128 | 119.8 | 107.5 (measured) | Well | Well | Well | Well | Well |

Checks: 32 GiB, 27B: 18.7 <= 0.80 x 23.8 = 19.0 and 18.7 <= 0.90 x 26.9 = 24.2, so "Runs well" (small margin). 24 GiB, 26B-A4B: 16.3 > 15.8, so "Won't fit". 8 GiB with a cloud ASR model: budget 3.35, E2B still "Won't fit" by formula, so the owner rule decides.

A model that is downloaded or in use always shows its row, also with "Won't fit", so the person can delete it.

---

## 6. Model pool design

Goal: a dictation never waits behind a meeting call, and the Mac never swaps.

1. One worker process per loaded model (today: one LLM worker, a different model stops it). The lifecycle stays in `http-worker.ts`; the pool is a map of model id to worker.
2. The dictation model (the model of task `cleanup`) is pinned. It is never evicted while dictation uses a local LLM. It keeps its own keep-alive only when dictation uses another provider.
3. Memory budget: `pool_budget = hw.memsize - reserve - app - ASR (when loaded)`. Before a start, the pool adds `P(model)` of every loaded worker plus the new one. If the sum is over `pool_budget`, it evicts the least recently used worker that is not pinned and not busy, and repeats. If the new model still does not fit, the call fails with a typed error (no swap).
4. Per-task "Keep ready" (a setting per task: cleanup, meetingEnhance, meetingSummarize): the model of that task stays loaded after its idle time. Keep-ready workers are evicted for memory last, in LRU order. The cleanup task has "Keep ready" on by default (pinned, item 2).
5. Two tasks with the same model share one worker. The lane rule stays: one request at a time per worker.
6. GPU sharing (measured 4.7 B: dictation p95 1,286 ms during a 26B Summarize): try `SIGSTOP` on the busy meeting worker while a dictation cleanup runs, then `SIGCONT`. Measure dictation p95 and check that the meeting call still ends correctly. This is not measured yet.
7. Each worker reports `gpu_cap` (step 1). The pool uses the smallest reported value.

---

## 7. Build steps (next PRs, after the owner review)

1. **Settings stay.** No code change for prefill step, KV bits, `max_kv_size` or cache limit. Write the reasons in a comment at the `stream_generate` call.
2. **Aligned prefix cache for cleanup.** In the worker: one LRU entry per worker (byte limit, start with 1 entry), prefix cut at a multiple of the prefill step, deep copy per request, `cached_tokens` in `usage`. Turn it on for the cleanup task only (a request field or a header from the server). Tests: a fake-model test for the cut, and a real-model test that compares 27 dictation outputs with and without the cache (must be identical). Re-run the dictation bench (expect E2B p50 about 219 ms).
3. **Fit label.** Server: `P(model)` per catalog entry (new field `peakBytes`, from 5.1), the formula of 5.1, the owner rule for E2B, and `gpu_cap` from `worker.gpu`. Models page: a label per row ("Runs well", "Tight fit", "Won't fit"), i18n in 7 locales, light and dark screenshots.
4. **Context guard.** The worker refuses `len(prompt) + max_tokens > contextTokens` with a typed 400. The server sends `contextTokens` at start (`--context-tokens`).
5. **Model pool.** Section 6 items 1 to 5 and 7. Proof: the R6 run through the app (isolated live-testing setup), with `pnpm meeting:eval` on both gold meetings (no new hard fails) and the dictation bench during a Summarize.
6. **GPU sharing experiment.** Section 6 item 6, as its own small PR with numbers.

Each PR keeps the quality gate: no new hard fails in `pnpm meeting:eval` on 5578edb0 and ca70f895, and a blind judge when an output changes.

---

## 8. Risks

1. **Output drift from cache changes.** An unaligned prefix cache changed temperature-0 output on 2 to 7 of 10 chunk calls. Any cache or chunk change must pass a byte-compare test against the no-cache path.
2. **mlx-lm API churn.** The prototype uses `make_prompt_cache`, a deep copy, and the model call with `cache=`. A pin change can break this. Re-run the byte-compare test on each pin change.
3. **RSS under-reports GPU memory.** For 27B, RSS was 14.95 GiB while the MLX peak was 18.38 GiB. A memory check that reads RSS only will over-fill the pool. Use the MLX peak values (5.1).
4. **8 GiB Macs.** E2B shows "Tight fit" by owner rule, but the formula budget is 0.8 GiB with local ASR. Expect swap and slow dictation there. The label text must say this.
5. **GPU cap on other Macs.** Only the 128 GiB value is measured (84 %). The table for other sizes is an estimate until real Macs report it.
6. **OS reserve.** The 3 and 4 GiB values are not measured.
7. **Cold load.** All loads took 3 to 5 s with files in the OS file cache. After a reboot, the 16 GB models need more time (not measured).
8. **GPU contention.** A pool does not stop GPU sharing. Dictation during a big generation was 2 times slower (4.7 B).
9. **26B and 27B pass the fit at 32 GiB with a small margin** (27B: 18.7 against 19.0). A longer answer or a later model version can move it to "Tight fit".

---

## 9. Owner decisions (2026-10-26)

1. Prefix cache: build the "boundary-consistent" variant (section 4.3). The system prompt is always prefilled as its own chunk, also without a cache. Target: E2B dictation p50 about 142 ms. It changes today's output once, so its PR needs a new dictation bench and a meeting:eval proof (no new hard fails, blind judge).
2. Fit label: approved as in section 5, with the thresholds 0.80 and 0.90 and the 3 or 4 GiB OS reserve. These constants are not measured. Gemma 4 E2B never shows "Won't fit".
3. Model pool: approved as in section 6. "Keep ready" is on by default only for the cleanup task.
4. GPU sharing experiment (`SIGSTOP` / `SIGCONT`): approved, as its own small PR with numbers.
5. Context guard: approved, but a refusal means the app failed. The main work is in the callers: each caller (cleanup, Enhance chunks, Summarize and its reduce step, tags) counts tokens and keeps the prompt inside `contextTokens - max_tokens` before it sends it. The worker guard is a last safety net only: a typed error, a loud log, and a caller that splits the input and tries again. The person never sees this error.
6. Apple FM: try one short cleanup prompt written for Apple Foundation Models, as a separate experiment. Stop the topic if it still loses on speed or quality against E2B.
7. Cleanup: the 26B qat-6bit eval model (21.8 GB) is deleted.

---

## 10. Step 2 result: prefix cache for cleanup (built 2026-10-26)

Build: the "boundary-consistent" variant of 9 item 1.

- The server sends `X-Openstyle-Prefix-Cache: on` for the `cleanup` task only (`apps/server/src/lib/llm/registry.ts`). Enhance and Summarize send no header and keep the mlx-lm path.
- The system prefix ends where the first user text starts. The worker finds it from the request only: it renders the template with the system messages and one empty user message, and takes the common token prefix with the prompt. (Qwen3.8 refuses a template with no user message, so a system-only render does not work.)
- With the header, the worker always prefills the system prefix in its own chunks (2048 tokens each), also on a miss. The rest goes to `stream_generate` with that KV cache. One entry per worker, a deep copy per request, no entry over 1 GiB.
- `usage.cached_tokens` and `usage.prompt_tokens_details.cached_tokens` report the tokens that came from the cache.
- `OPENSTYLE_MLX_LLM_PREFIX_CACHE=off` makes "on" act as "off" (same output, no stored KV). The byte-compare proof uses it.

Proof (frozen workers built from `32b89fb6` ("old") and from this branch ("new"), each run under the GPU lock):

| Check | E2B | E4B |
|---|---|---|
| Dictation, cache on vs off (new worker), byte-equal | 108/108 | 108/108 |
| Dictation, old vs new, byte-equal | 108/108 | 104/108 (1 zh case, all 4 passes) |
| Dictation bench pass, old -> new | 32/108 -> 32/108 | 44/108 -> 40/108 |
| Dictation p50 / p95 (ms), old -> new | 295 / 490 -> 155 / 330 | 874 / 1,230 -> 269 / 617 |
| Dictation TTFT p50 / p95 (ms), old -> new | 168 / 203 -> 30 / 37 | 660 / 725 -> 61 / 65 |
| Cache hits (new) | 107 of 108 | 107 of 108 |
| Gold meeting calls, old vs new without header | 18/18 | 18/18 |
| Gold meeting calls, header on vs off | 18/18 (10 hits) | 18/18 (10 hits) |
| Gold meeting calls, old vs header on (not used by the app) | 9/18 | 13/18 |

- The changed E4B case is `preserve-reminder-zh`: the new output moves one word. A blind pair judge (Claude subagent) picked the old output (the new one rewords; both keep the meaning).
- `meeting:eval` E2B, both gold meetings, old and new worker: same pack files (sha256 of all 6 files equal), same tokens (20,253 / 4,216 and 43,935 / 12,377), same hard fails (5578edb0: 1, gold `claim:c1`, also in the baseline; ca70f895: 0). No new hard fail. The outputs are identical, so no blind judge for meetings.
- Real app (app-check skill, E2B, new worker, fictional data): 3 dictation cleanups 371, 210 and 265 ms; the worker log says `prefix 3959 of 4056 tokens, cached 0`, then `cached 3959` twice. Enhance + Summarize: 9 calls, all `stop`, 0 errors, `cached_tokens` 0 in `llm_calls`.
- MLflow: the app run exported 1 Enhance + Summarize trace to experiment `llm-runtime-tuning` (id 68), read back with status OK. Dictation cleanup has no MLflow path. The bench and the replay call the worker directly, and `meeting:eval` strips tracing on purpose.

---

## 11. Step 4 result: worker context guard (built 2026-10-26)

- The server starts the LLM worker with `--context-tokens <contextTokens>` from the catalog (`apps/server/src/lib/mlx-llm/server.ts`).
- The worker tokenizes the chat-templated prompt. When `prompt_tokens + max_tokens > context_tokens`, it does not generate. It logs one `CONTEXT EXCEEDED` line and returns HTTP 400 with `{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":...,"prompt_tokens":N,"max_tokens":M,"context_tokens":C}}`. The guard counts all prompt tokens, also the tokens from the prefix cache. A refusal makes no prefill.
- Without `--context-tokens` the worker has no guard. The eval tools that start the worker themselves (`stage-replay.mts`) do not send it.
- Version contract (owner decision 2026-10-26): the server never starts a managed worker whose installed version is not the expected version (`isStaleManagedWorker` in `apps/server/src/lib/mlx-asr/runtime.ts`). Before, a failed update download (offline) started the old worker, and the old worker exits on `--context-tokens`. Now the start fails with `MlxRuntimeUpdatePendingError`, the status API shows `runtime.updatePending: true` and the download error, and each next start tries the download again. Real run: an isolated server with the shipped 2.22.0 worker and an offline download URL started no worker; with the download back, it installed the new worker and started it with `--context-tokens 32768`.

Proof (E2B, frozen worker of this branch against the main script in the same pinned venv, each run under the GPU lock):

| Check | Result |
|---|---|
| Dictation bench, 27 cases, 1 pass, main vs new | 27/27 byte-equal, pass 8/27 both |
| 18 stored gold-meeting requests (sweep capture), main vs new | 18/18 byte-equal, 0 refusals |
| Raw request at the limit / 1 token over / 40,832-token prompt | 200 / 400 / 400, also with the prefix cache on |
| Server, worker window 4,900 (test only), dictation cleanup | refusal, split in 3 pieces, cleaned text, HTTP 200 |
| Server, worker window 6,500 (test only), Enhance + Summarize | summarize refused, map and reduce, meeting `summarized`, no error |

---

## 12. Step 5 result: model pool, Keep ready, engine not ready (built 2026-10-27)

Build (owner decisions 9 item 3 and the brief of 2026-10-26):

- `apps/server/src/lib/mlx-llm/server.ts` is a pool: a map of model id to one HTTP worker (`mlx-asr/http-worker.ts`). Two tasks with the same model share one worker. A ready worker answers at once. Starts run one at a time.
- Admission (`mlx-llm/pool.ts`, pure): the sum of `peakBytes` (P, the MLX peak of 5.1, not the RSS) of the loaded workers plus the new model must stay at or under the limit. Limit = RAM - reserve - app - ASR (when the ASR worker is loaded), capped by the smallest GPU cap a worker reported. Over the limit, the pool stops the least recently used worker that is not pinned and not busy, "Keep ready" workers last. If the model still does not fit, the start throws `MlxLlmPoolNoRoomError` (gateway: `model_unavailable`, reason `not_enough_memory`). A model that is the only worker always starts (the one-worker shape of a small Mac).
- Pinned: the model of task `cleanup` while `llm_cleanup` is on and the task uses the built-in LLM.
- "Keep ready" (`mlx_llm_keep_ready`, JSON per task, default cleanup only): the model never unloads when idle. Switch in the task rows of the Models page, one note in the AI model warming dialog, 7 locales.
- Lanes (`llm/lane.ts`): one lane with one slot per built-in model (`lane:local-mlx-llm/<id>`). Before, all built-in models shared one lane, so a dictation still waited behind a meeting call on another model. The 15 s background gate (meeting calls start only after 15 s with no dictation) did not change.
- Engine not ready: `MlxRuntimeUpdatePendingError` maps to the gateway error `engine_not_ready` (run-wide). The run shows a neutral notice and starts again by itself when the engine is ready (`meetings/workflow/engine-retry.ts`: one timer, download try, 30 s doubling to 5 min).
- Start error: a worker that exits before its ready line (for example an old worker: `unrecognized arguments: --context-tokens`) throws `MlxWorkerStartError` with its last stderr line. Gateway: `model_unavailable`, reason `engine_start_failed`, run-wide. Real isolated server with the shipped 2.23.0 worker: the run ends in 1.2 s on main (4 steps `internal`, 4 worker starts) and on this branch (1 step `model_unavailable`).

Worker exit (C). Root cause: `_watch_stdin` and the SIGTERM handler logged with `print(..., file=sys.stderr)` before `os._exit(0)`. When the parent is gone, stderr is a broken pipe: `print` raises `BrokenPipeError` and `os._exit(0)` never runs. The worker stays alive with its model in memory. Fix: `_exit_now()` writes the line with `os.write(2, ...)` and always calls `os._exit(0)`.

| Case (E2B unless noted) | Old worker | New worker |
|---|---|---|
| Node parent dies by SIGKILL (2 runs) | alive after 30 s, 2/2 | exits after ~100 ms, 2/2 |
| Real isolated server killed with `kill -9`, LLM worker loaded | alive after 30 s (RSS 4.3 GiB) | exits after ~100 ms |
| Parent stops the worker (stdin end + SIGTERM), idle | 38, 39, 39 ms (direct); 37 to 143 ms (`POST /api/mlx-llm/server/stop`) | 26, 34 ms; 133 to 160 ms |
| SIGTERM during a 20k-token request (E2B and 26B, 6 cases) | 37 to 124 ms | not changed |
| Python test: stdin EOF with a broken stderr (`ShutdownTests`) | process alive after 10 s (main script) | exit 0 |

The "every unload waits 5 s" report did not reproduce in any of these cases: a normal stop took at most 160 ms. The proven fault is the worker that stays alive after its parent died.

R6 through the real isolated server (dictation = `POST /api/transcribe`, ASR Qwen3-ASR 1.7B 8-bit + E2B cleanup; Summarize on 26B-A4B of a 520-line fictional meeting; 4 Summarize rounds; one dictation every 16 to 19 s, so the next dictation comes while a Summarize call runs):

| | main (`4d7a03fc`, one worker) | pool (this branch) |
|---|---|---|
| Dictation idle, p50 / p95 (n 20) | 274 / 323 ms | 282 / 331 ms |
| Dictation during Summarize, p50 / p95 / max | 6,876 / 7,891 / 7,891 ms (n 8) | 954 / 1,599 / 1,805 ms (n 24) |
| Summarize runs | 4 of 4 failed (the dictation swapped the worker during a call) | 4 of 4 succeeded (94 to 124 s) |
| Peak RSS of the workers | 17.16 GiB (one LLM at a time) | 21.50 GiB (ASR 2.49, E2B 4.35, 26B 14.66) |
| MLX peak per request (trace) | E2B 4.00 GiB | E2B 4.00, 26B 15.35 GiB |
| Pool memory (status) | - | P sum 21.40 GiB, limit 119.8 GiB |

This Mac now reports `max_recommended_working_set_size` 130,566,586,368 B (121.6 GiB, `mx.device_info()`), not the 107.5 GiB of section 2. So the limit here is the budget.

`pnpm meeting:eval` E2B on 5578edb0 and ca70f895, main and branch with the same new worker: the 6 pack files have the same sha256, the same tokens (34,845 / 1,848 and 76,727 / 10,652), and 0 hard fails on both meetings in both arms.

Real app (Test Runner, quiet mode, fictional data, 0 privacy prompts), dictation every 16 to 19 s during 5 Summarize rounds on 26B-A4B: dictation idle p50 / p95 275 / 321 ms (n 10), during Summarize 1,252 / 1,634 ms, max 1,634 ms (n 15, all HTTP 200); 5 of 5 Summarize runs succeeded (50 to 55 s); the status showed E2B pinned with Keep ready for cleanup and 26B-A4B with Keep ready for Summarize, P sum 21.40 GiB. Keep ready toggles persist after a restart (`{"cleanup":false,"meetingSummarize":true}` before and after); the engine-not-ready notice shows (neutral, clock icon) with a stale runtime and a dead download URL, and when the URL serves the archive, Enhance starts again by itself (`started_by: auto`, `succeeded`, 48 s).

## 13. Built-in model profiles (2026-10-30)

A profile that the user links to a task belongs to the model that the task runs on (setting `llm_profile_links`, (model, task) to profile). It does not follow the task to another model. With no link, a task uses the Instruct profile of its model (`BUILTIN_MODEL_PRESETS` in `packages/validations/src/llm-task-profiles.ts`). A user link always wins. Each profile sends `enable_thinking` explicitly, and none sets `max_tokens` (it stays derived from the task). The default built-in profile does not block a bounded reasoning step of the gateway; a linked profile does.

| Family | Mode | temperature | top_p | top_k | min_p | repetition | presence | chat_template_kwargs |
|---|---|---|---|---|---|---|---|---|
| Gemma 4 (E2B, E4B, 26B-A4B) | Instruct / Thinking | 1.0 | 0.95 | 64 | none | 1.0 | none | enable_thinking false / true |
| Nemotron 3.5 Bolt E4B | Instruct / Thinking | 1.0 | 0.95 | 64 | none | none | none | enable_thinking false / true |
| Qwen 3.8 | Instruct | 0.7 | 0.80 | 20 | 0.0 | 1.0 | 1.5 | enable_thinking false |
| Qwen 3.8 | Thinking | 1.0 | 0.95 | 20 | 0.0 | 1.0 | 0.0 | enable_thinking true, reasoning_effort xhigh, preserve_thinking false |
| Qwen 3.6 27B | Instruct / Thinking | 0.7 / 1.0 | 0.80 / 0.95 | 20 | 0.0 | 1.0 | 1.5 / 0.0 | enable_thinking false / true (+ preserve_thinking false) |
| Qwen 3.6 35B-A3B | Instruct / Thinking | 0.7 / 1.0 | 0.80 / 0.95 | 20 | 0.0 | 1.0 | 1.5 / 1.5 | enable_thinking false / true (+ preserve_thinking false) |
| Qwen 3.5 (0.8B to 122B-A10B) | Instruct / Thinking | 0.7 / 1.0 | 0.80 / 0.95 | 20 | 0.0 | 1.0 | 1.5 / 1.5 | enable_thinking false / true |

Qwen 3.8 has three Thinking profiles: xhigh (the default level), medium and low. They differ only in `reasoning_effort`. The chat template of Qwen3.8-27B accepts exactly xhigh (default), medium and low (`raise_exception` for any other value), so Qwen 3.8 Instruct sends no `reasoning_effort`.

Matcher for a model of an own server or a cloud provider (`qwenFamilyKey`): the id (case ignored) must hold `qwen`, then `3.5`, `3.6` or `3.8`, then a covered size right after the version (3.8: 27B, Flash, Flash-Next; 3.6: 27B, 35B-A3B; 3.5: 0.8B, 2B, 4B, 9B, 27B, 35B-A3B, 122B-A10B). A quant or file suffix is fine. An id with coder, embed, rerank, vl, audio, asr, omni, math or base gives no match. An unknown version or size gives no match, and then no automatic profile applies. A built-in MLX model matches by its catalog id (Gemma, Nemotron) or by the same Qwen rule.

Side effect: a meeting run is no longer byte-identical between two runs. The measurements in sections 4.3 and 10 compare outputs at temperature 0. A comparison of two runs on a built-in model now needs a link with `temperature: 0`.
