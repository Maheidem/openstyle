---
name: app-check
description: Prove one built-in MLX LLM in the real Openstyle app, isolated, with fictional data - download through the Models page button, Use, Enhance + Summarize, LLM inspector, dictation smoke, switch back to Gemma 4 E2B, light and dark screenshots, worker RSS. Use for a new catalog model, a worker change, or before a claim that a model "works in the app".
---

# App check of a built-in LLM

One command runs the whole proof:

```bash
.claude/skills/app-check/scripts/run.sh <catalog-model-id>      # for example gemma-4-e4b-qat-4bit
```

It is the distilled form of the overnight proofs of 2026-10-25 (Nemotron Bolt E4B by dev_b, Gemma 4 26B-A4B by dev_a). Do not rebuild the steps by hand. Read `.claude/skills/live-testing/SKILL.md` first for the isolation rules.

## Hard rules

1. Run only through `scripts/test-runner/run.sh` (the script does it). Never launch the app another way. The Test Runner keeps the Privacy grant.
2. Quiet mode only (`OPENSTYLE_E2E=1`, set by `launchOpenstyle`). Never record, never use the mic or system audio.
3. Fictional data only. The fixture is `defaultSegments(6)` from `apps/electron/tests/helpers/enhance-fixture.ts`.
4. Take the shared GPU lock `/tmp/openstyle-gpu.lock` (`mkdir`). The script waits and takes it. It releases it at exit. Do not kill another session's lock owner. Wait.
5. Never write to `~/.cache/huggingface`, the real profile, or `/Applications/Openstyle.app`. The script uses a scratch `HOME`, a scratch HF cache and a scratch profile.
6. Stop at the first Privacy dialog. Report the service name. `tcc-prompts.txt` must be `0`.
7. Look at every screenshot yourself before you report it (empty states, spinners, cut-off UI).
8. The spec copy `apps/electron/tests/zz-proof-appcheck.test.ts` is throwaway. The script deletes it. Never commit it.

## Known facts

| Item | Value |
|---|---|
| Spec source | `.claude/skills/app-check/scripts/app-check.spec.ts.txt` (a `.txt`, so lint and tsc skip it) |
| RSS sampler | `.claude/skills/app-check/scripts/sample-rss.py`. It reads `ps` every 5 s. It sorts workers by args: `--llm` = llm, `--embed` = embed, else asr. |
| Isolated profile | `<out>/scratch/ud-*/` (`settings.json` has `onboardingComplete`, `config.freestyle.json` turns on `meetings`). The path is in `<out>/userdata.path`. |
| Scratch HOME / HF cache / model cache | `<out>/scratch/home`, `<out>/scratch/hf/hub`, `<out>/scratch/cache` |
| Worker | The shipped worker from the installed runtime: `~/.cache/freestyle/mlx-asr/runtime/darwin-arm64/mlx_asr_worker/mlx_asr_worker` (executed, not written). Override: `APP_CHECK_WORKER`. The same binary serves ASR and LLM (`--llm` mode, a second process). |
| Worker process names | `mlx_asr_worker` for ASR, `mlx_asr_worker ... --llm` for the LLM, `--embed` for embeddings |
| Fixture meeting | id `app-check`, title `Launch planning sync`, 6 chunks, one planted wrong word ("lunch" for "launch", `WRONG_WORD` in `enhance-fixture.ts:213`) |
| Where files land | `<out>` = `/tmp/app-check/<model-id>-<timestamp>/` (or `APP_CHECK_OUT`). Screenshots `<out>/*.png`, `proof.log`, `results.json`, `rss.csv`, `llm-calls.txt`, `run.log`, `tcc-prompts.txt`, `logs-before.txt`, `logs-after.txt`. The big scratch folder is deleted at exit (`APP_CHECK_KEEP_SCRATCH=1` keeps it). |
| Build | The script builds the server and the app first (about 2 min). `APP_CHECK_SKIP_BUILD=1` skips it. Skip only when the build is from the current commit. |
| Switch-back target | `gemma-4-e2b-qat-4bit`, cloned from the real HF cache (read only) with `cp -Rc` before the app starts |
| Wall time (E4B, 6.8 GB) | see "Expected output" |

## Run

```bash
cd <your worktree>
bash scripts/branch-status.sh                          # fix every !! first
.claude/skills/app-check/scripts/run.sh gemma-4-e4b-qat-4bit
```

For a candidate model, the catalog entry must be in your branch first (`.claude/skills/model-catalog/SKILL.md`). The script looks the id up in `apps/server/src/lib/mlx-llm/constants.ts` and stops with exit 2 when it is missing.

For a long run (a 15 GB model downloads for 10 minutes or more) start it in the background and read `<out>/proof.log`:

```bash
(nohup env APP_CHECK_OUT=/tmp/app-check/run1 .claude/skills/app-check/scripts/run.sh <id> > /tmp/app-check/run1.out 2>&1 &)
tail -f /tmp/app-check/run1/proof.log
```

## Steps that the spec runs

1. Boot the app with the isolated profile. Set `advanced_mode` and `meeting_enhance_prompt_seen`.
2. Models page, AI cleanup, Change, Browse: screenshot of the list before the download (light, dark).
3. Click Download on the row. Poll until the Use button shows. Click Use. Check that the row says "Selected" (light, dark).
4. Seed the fixture meeting, click Enhance, poll `GET /api/meetings/app-check` until status `summarized`. Screenshots of transcript and Summary (light, dark).
5. Open the LLM inspector. Check that it shows the HF repo name (the inspector shows the hf name, not the catalog id).
6. Dictation smoke: 3 texts through `POST /api/post-process`. Log latency and a "think tag" check.
7. Switch back to Gemma 4 E2B: Use button, "Selected" check (light, dark). Skipped when the checked model is E2B.
8. Close the app.

## Checks (what PASS looks like)

| Step | PASS |
|---|---|
| Build | `build done` in the output |
| E2B clone | `E2B clone ok (0 dangling symlinks)` |
| Download | `DOWNLOAD DONE wall=<s>s` in `proof.log`; `results.json` has `downloadSeconds` |
| Use | `results.json` has `"useStep": "PASS"` |
| Enhance + Summarize | `ENHANCE+SUMMARIZE DONE wall=<s>s`; `llm-calls.txt` shows provider `local-mlx-llm`, finish `stop`, no `error` rows |
| Inspector | `inspectorHasHfName_light` and `_dark` are `true` |
| Dictation | 3 lines `status=200`, `think=false` |
| Switch back | `"switchBack": "PASS"` |
| RSS | the script prints peak GiB for `llm` and `asr`. Compare with the catalog size and the free memory of the Mac. |
| Privacy | `=== TCC prompts since start (expect 0) ===` prints `0` |
| Logs | `=== logs unchanged ===` |
| Exit | `playwright exit code: 0` |

A planted-error note: Nemotron Bolt E4B and Gemma 4 26B-A4B both made 0 edits on the planted "lunch" error (6 of 6 chunks returned `{"corrections":[]}`, overnight 2026-10-25). The spec does not assert on the fix. Judge Enhance quality with `pnpm meeting:eval` on real meetings, not with this check.

## Expected output

See the section "Run record" at the end of this file.

## Cleanup

The script cleans up at exit (trap): it deletes the spec copy, stops the sampler, releases the lock, and deletes `<out>/scratch`. After a run:

```bash
git status --short            # no zz-proof file, no stray files
ls /tmp/openstyle-gpu.lock    # must say: No such file or directory
```

Delete `<out>` when the numbers are in your report. Delete `apps/electron/test-results/` if a failure left it (it holds the error context and trace).

## Traps

1. **Use step failed on 2026-10-25 (26B-A4B run, 06:22Z).** The old throwaway spec cloned E2B with Node `cpSync(src, dst, { recursive: true, mode: 1 })` after the app had started. Error: `expect(locator).toBeVisible() failed ... getByRole('button', { name: 'Use' }) ... Expected: visible ... Timeout: 20000ms ... element(s) not found` at `zz-proof-overnight.test.ts:288`. The error-context page showed the row `Gemma 4 E2B Recommended On-device · 4.4 GB` with a `Download` button. Cause found: `cpSync` writes the snapshot symlinks as ABSOLUTE paths to the source (`/private/tmp/meeting-eval/hf/hub/.../blobs/...`), not as the relative `../../blobs/...` of the HF cache. A link that points into `/tmp` dangles when the source moves or when macOS cleans the blobs (the 00:00 cleanup removed the blobs of 5 models on 2026-10-25). Then `isHfSnapshotPresent` returns false and the row shows Download. Proven: the leftover clone in `/tmp/overnight-app/hf` has absolute links, and `/tmp/meeting-eval/hf/hub` is gone now (dev_b moved the eval cache to `~/Library/Application Support/Openstyle-eval/hf`, per lead). Not proven: whether the source blobs were already missing at 06:22. The failing 06:22 state was not checked. Fix: clone before the app starts with `cp -Rc`, which keeps relative links, and check `find -L <clone> -type l | wc -l` = 0. The script does both. Status: see "Run record" for the proof run.
2. **Claude Code updates break its Privacy grant** (`com.anthropic.claude-code` path changes per version). The Test Runner app avoids it. Never run the app from the agent shell. If a dialog appears, stop and report.
3. **Bluetooth headset mic bug** (`bt-headset-meeting-capture-bug`, issues #169 #170): a transient BT default mic squeezes the system track 3x. This check never records, so it does not hit it. It matters for a real meeting proof only.
4. **`/tmp` is not durable.** Do not point `APP_CHECK_WORKER` or any cache at `/tmp/meeting-eval`. The overnight spec used `/tmp/meeting-eval/worker-2.22.0`; the script now uses the installed runtime.
5. **The scratch `HOME` is on purpose.** The server refreshes the managed worker under `homedir()` before each worker start, even with `OPENSTYLE_MLX_ASR_WORKER` set (`live-testing` skill). With the real `HOME` it could rewrite the installed app's worker folder.
6. **Do not use `pkill`/`killall`.** The guard hook blocks them, and they kill the installed app's worker.
7. **`session_open` in Nexus can answer PERMISSION_DENIED for dev agents.** Claim handoffs without a session. This does not affect the script.
8. **A GPU lock held by another session blocks the run.** The script prints `GPU lock busy: <owner>` every 60 s. Wait. Do not remove the lock.
