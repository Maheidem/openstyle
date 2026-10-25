---
name: model-catalog
description: Add, change or check an entry of the built-in MLX LLM catalog (apps/server/src/lib/mlx-llm/constants.ts). Covers the entry fields, the size and license lookup script, the download paths, the exact tests, and the Models page check. Use before any edit of MLX_LLM_MODELS, and when a model is tried for the eval harness or the app.
---

# Model catalog (built-in MLX LLMs)

Checked against `origin/main` dc6b5080 (2026-10-25). Spec: `specs/local-mlx-llm.md` section 1 decision 4 and section 3.1.

## Hard rules

1. The owner picks which models ship. An agent adds a model for an eval or a trial in a branch and marks it. Do not merge a candidate entry to main without the owner.
2. Mark every candidate entry with the comment `// overnight sweep candidate <date>, not for release`.
3. `sizeBytes` comes from the script below. Do not type it by hand.
4. Exactly one entry has `recommended: true` (`gemma-4-e2b-qat-4bit`). A test enforces it.
5. Never write to `~/.cache/huggingface`. Downloads for a check go to a scratch cache (`HUGGINGFACE_HUB_CACHE`, `--hf-cache`).
6. Take the shared GPU lock (`mkdir /tmp/openstyle-gpu.lock`) before any model load. Release it after.

## Where the catalog lives

`apps/server/src/lib/mlx-llm/constants.ts` (lines checked on dc6b5080):

| Lines | What |
|---|---|
| 14 | `MlxLlmFamily` union. Main has only `"gemma4"`. |
| 16-28 | `MlxLlmModelDef` interface |
| 33-43 | `MLX_LLM_ALLOW_PATTERNS`: the files that the download fetches |
| 45-66 | `MLX_LLM_MODELS`: the entries |
| 67-69 | `getMlxLlmModel(id)` |

## Fields of an entry

| Field | Meaning | Where the value comes from |
|---|---|---|
| `id` | Catalog id. The app stores it as `local-mlx-llm/<id>`. Pattern: `<name>-<size>-<quant>`, for example `gemma-4-e2b-qat-4bit`. | You choose it. Keep it stable: a saved default or a task override uses it. |
| `hfId` | Hugging Face repo. The worker gets it as `--model <hfId>`. Keep the exact case of the repo. | The HF page of the repo. |
| `displayName` | The row name on the Models page. The app-check spec finds the row by this text. | You choose it. Keep it unique. |
| `family` | The model family string. The status route returns it. Nothing else reads it (grep `family` in `apps/server/src`: only `mlx-llm/models.ts` and the status type). | `config.model_type` in the HF API answer. The script prints it as `modelType`. |
| `sizeBytes` | Sum of the repo files that match `MLX_LLM_ALLOW_PATTERNS`. The Models page shows it as GB. The disk check uses it. | `scripts/catalog-size.mjs`. |
| `contextTokens` | Context window that the app plans with. A test requires 32 768 for all entries. | Keep 32 768. |
| `maxOutputTokens` | Output limit that the app plans with. A test requires 8 192 for all entries. | Keep 8 192. |
| `recommended` | Shows the "Recommended" badge. One entry only. | E2B only. |

## License

Known fact (lead, 2026-10-25): the catalog has no license field. The PR body records the license with HF API data. Lead takes the question of a real license field to Marcos.

The catalog has no license field. Checked in `constants.ts` and in `apps/electron/src/renderer` on dc6b5080: `grep -rni licen` finds only the diarization note in the Settings acknowledgments text (`locales/en.json:162`). So the license is a decision record, not code. Record it in the PR body and in the spec table:

1. Run the size script. It prints `license`, `licenseLink`, `baseModel` and `gated` from the HF API (`cardData`).
2. Many `mlx-community` quant repos have `license: null`. Then read the card of the `baseModel` repo and write that license.
3. Write both values in the PR body. If they differ, or a link points to a terms page (Gemma 4 31B has `licenseLink` = `https://ai.google.dev/gemma/docs/gemma_4_license` while `license` says `apache-2.0`), write "needs a legal read" and tell the owner. This is an open question in the overnight report (Gemma 4 and Nemotron Bolt).
4. Spec section 1 decision 4 rejected the Jundot oQ4e repos because the repo has no license. A repo with no license on both the quant and the base is not a candidate.

## Pick the MLX repo and the quant

1. Prefer `mlx-community` or `lmstudio-community` repos with `model_type` that mlx-lm 0.32.2 supports (spec section 1 decision 5, pins).
2. Prefer QAT 4-bit for Gemma 4 (Google states "similar quality to bf16"). Gemma `qat-mobile` repos do not load (`quant_method: gemma` is not supported in mlx-lm 0.32.2).
3. A repo with an extra weight file that mlx-lm cannot load breaks the strict load (Jundot oQ4e `optiq/mtp.safetensors`). The allow patterns skip some of these files. Test the load before you trust the repo.
4. A new `family` needs the worker to support the architecture. Run the app check (below) before you claim it works.

## Get size and license

```bash
node .claude/skills/model-catalog/scripts/catalog-size.mjs mlx-community/gemma-4-E2B-it-qat-4bit
```

Proof that the script matches the catalog (run 2026-10-25, raw `sizeBytesUnderscored` lines):

| Repo | Script | Catalog |
|---|---|---|
| `mlx-community/gemma-4-E2B-it-qat-4bit` | `4_361_680_121` | `4_361_680_121` |
| `mlx-community/gemma-4-E4B-it-qat-4bit` | `6_830_817_013` | `6_830_817_013` |
| `mlx-community/Qwen3.8-27B-4bit` | `16_081_488_731` | `16_081_488_731` (commit 6aaf9b2a) |
| `mlx-community/gemma-4-31b-it-4bit` | `18_444_419_448` | `18_444_419_448` (commit 6aaf9b2a) |

## Worked example: commit 6aaf9b2a (two eval-only entries)

`git show 6aaf9b2a` changed two files: `constants.ts` (+20) and `tests/mlx-llm.test.ts` (+12). The commit is on a local branch only, not on main.

```diff
@@ -148,6 +148,26 @@ export const MLX_LLM_MODELS: readonly MlxLlmModelDef[] = [
     contextTokens: 32_768,
     maxOutputTokens: 8_192,
   },
+  // overnight sweep candidate 2026-10-25, not for release
+  {
+    id: "qwen3.8-27b-4bit",
+    hfId: "mlx-community/Qwen3.8-27B-4bit",
+    displayName: "Qwen3.8 27B",
+    family: "qwen3_5",
+    sizeBytes: 16_081_488_731,
+    contextTokens: 32_768,
+    maxOutputTokens: 8_192,
+  },
+  // overnight sweep candidate 2026-10-25, not for release
+  {
+    id: "gemma-4-31b-4bit",
+    hfId: "mlx-community/gemma-4-31b-it-4bit",
+    displayName: "Gemma 4 31B",
+    family: "gemma4",
+    sizeBytes: 18_444_419_448,
+    contextTokens: 32_768,
+    maxOutputTokens: 8_192,
+  },
```

```diff
@@ -187,6 +187,18 @@ describe("catalog (spec 1 decision 4, 3.1)", () => {
       ["qwen3-8b-4bit", "mlx-community/Qwen3-8B-4bit", "qwen3", 4_623_782_544],
+      [
+        "qwen3.8-27b-4bit",
+        "mlx-community/Qwen3.8-27B-4bit",
+        "qwen3_5",
+        16_081_488_731,
+      ],
+      [
+        "gemma-4-31b-4bit",
+        "mlx-community/gemma-4-31b-it-4bit",
+        "gemma4",
+        18_444_419_448,
+      ],
     ]);
```

Two traps in this example:

- The test `has only the 2 Gemma 4 models ...` (`apps/server/tests/mlx-llm.test.ts:130`) lists every entry in order. Each new entry needs a row there, in the same order as `constants.ts`.
- `family: "qwen3_5"` compiles only when `MlxLlmFamily` has that member. On main it is `"gemma4"` only. The sweep branch `feat/dictation-bench-local-provider` widens the union to `"qwen3_5" | "qwen3_5_moe" | "mistral3" | "qwen3"`. On main, a new family needs the same union edit, or `tsc` fails.

The Nemotron entry (commit b9d50396, branch `feat/dictation-bench-local-provider`) uses `family: "gemma4"` and the HF repo `lmstudio-community/NVIDIA-Nemotron-3.5-Bolt-E4B-MLX-4bit`, size `4_231_265_397`. It also changes the header comment: an owner decision with a date goes into the comment.

## Download

Through the app (the user path): Models page, AI cleanup, Change, Browse, row, Download button. The app-check skill does this for you.

Through the eval harness (cache outside the app profile):

```bash
pnpm meeting:eval --models <catalog-id> --hf-cache /tmp/meeting-eval/hf   # downloads when the model is missing
pnpm meeting:eval --models <catalog-id> --no-download                     # fails when the model is missing
```

`eval.mts` reads the catalog (`eval.mts:68`, `:166`) and downloads through `POST /api/mlx-llm/models/<id>/download`. It rejects an id that is not in the catalog. So an eval of a candidate needs the candidate entry in the branch.

Trap: `/tmp` is not durable. The macOS cleanup removed the blobs of 5 models from `/tmp/meeting-eval/hf` at 00:00 on 2026-10-25, and on 2026-10-25 evening the whole `/tmp/meeting-eval/hf/hub` folder was gone. Check the blobs before a run: `find -L <cache>/hub/models--*/snapshots -type l | wc -l` must print 0 (a broken link shows as type `l` under `-L`).

## Tests (run from the repo root)

```bash
cd apps/server && pnpm exec vitest run tests/mlx-llm.test.ts tests/mlx-models.test.ts
pnpm --filter @openstyle/server typecheck:tests
cd apps/server && pnpm exec tsc --noEmit -p tsconfig.json
cd apps/electron && pnpm exec vitest run src/renderer/src/lib/models.test.ts
```

Raw output on `origin/main` dc6b5080, 2026-10-25 (no catalog change):

```
 Test Files  2 passed (2)
      Tests  64 passed (64)
   Start at  20:00:38
   Duration  9.90s (transform 4.70s, setup 277ms, import 7.31s, tests 6.62s, environment 0ms)
```

`typecheck:tests` printed no error (exit 0, 1:45 min). `tsc --noEmit -p tsconfig.json` in `apps/server` printed no error (exit 0). The renderer test: `Tests  3 passed (3)`.

Other files that name catalog ids (a change to an existing id breaks them): `apps/server/tests/workflow-identify.test.ts`, `jobs-route.test.ts`, `apps/server/src/lib/jobs.ts:110` (demo job uses `gemma-4-e2b-qat-4bit`), `apps/electron/tests/tray-popover.test.ts`, `meeting-folder-memory.test.ts`, `scripts/site-captures/seed-data.mjs`, `scripts/meeting-v2/seed-scratch-db.mjs`.

## Check the entry in the app

Run the app-check skill with the new id: `.claude/skills/app-check/SKILL.md`. PASS means: the row shows the name and size, Download works, Use marks the row "Selected", Enhance + Summarize finishes with status `summarized`, and the LLM inspector shows the HF repo name (the inspector shows the hf name, not the catalog id).

## Cleanup

- Remove the scratch HF cache you used (`rm -rf <scratch>`). Never delete from `~/.cache/huggingface`.
- Release the GPU lock.
- Do not leave a candidate entry on a branch that goes to main. Name the commit `chore(bench): ... (eval-only)`.
