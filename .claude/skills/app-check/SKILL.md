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
4. Take the shared GPU lock `/tmp/openstyle-gpu.lock` in queue order. The script appends its line to `/tmp/openstyle-gpu.queue`, then takes the lock (`mkdir`) only when the lock is free AND its line is the first live line (same rule as `scripts/meeting-v2/eval/gpu-queue.mts`; a line older than 2 h is skipped). It removes its line when it takes the lock, at exit and on INT/TERM. It releases the lock at exit. Do not kill another session's lock owner. Wait.
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
| Where files land | `<out>` = `~/Library/Application Support/Openstyle-eval/app-check/<model-id>-<timestamp>/` (or `APP_CHECK_OUT`). Not `/tmp`: macOS cleans it (same rule as the HF eval cache). Screenshots `<out>/*.png`, `proof.log`, `results.json`, `rss.csv`, `llm-calls.txt`, `run.log`, `tcc-prompts.txt`, `logs-before.txt`, `logs-after.txt`. The big scratch folder is deleted at exit (`APP_CHECK_KEEP_SCRATCH=1` keeps it). |
| Build | The script builds the server and the app first (about 2 min). `APP_CHECK_SKIP_BUILD=1` skips it. Skip only when the build is from the current commit. |
| Switch-back target | `gemma-4-e2b-qat-4bit`, cloned from the real HF cache (read only) with `cp -Rc` before the app starts |
| Wall time (E4B, 6.8 GB) | about 12.3 min of test time (download 687 s) plus the build (about 2 min) plus any wait for the GPU lock |

## Run

```bash
cd <your worktree>
bash scripts/branch-status.sh                          # fix every !! first
.claude/skills/app-check/scripts/run.sh gemma-4-e4b-qat-4bit
```

For a candidate model, the catalog entry must be in your branch first (`.claude/skills/model-catalog/SKILL.md`). The script looks the id up in `apps/server/src/lib/mlx-llm/constants.ts` and stops with exit 2 when it is missing.

For a long run (a 15 GB model downloads for 10 minutes or more) start it in the background and read `<out>/proof.log`. Keep the stdout file next to the evidence:

```bash
E="$HOME/Library/Application Support/Openstyle-eval/app-check/run1"; mkdir -p "$E"
(nohup env APP_CHECK_OUT="$E" .claude/skills/app-check/scripts/run.sh <id> > "$E.out" 2>&1 &)
tail -f "$E/proof.log"
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

## Known gaps

1. **ASR worker RSS is not measured.** The fixture meeting is already transcribed, so Enhance and Summarize never start the ASR worker. `rss.csv` has `llm` rows only (run 1, 2026-10-25: pid 51509 peak 6.75 GiB, then pid 54090 for the E2B switch-back). The overnight number for the shipped 1.7B ASR worker (2.84 GiB, pid 412) came from the Nemotron app run by another agent and is not reproduced here. To measure ASR, the spec needs a dictation or import step that sends real audio (`say -v Samantha -o file.aiff`, then `afconvert`, then `POST /api/transcribe`), or the check stays out.
2. **Enhance quality is not asserted.** Run 1 summary says "lunch date" (the planted error was not fixed by E4B).
3. **Per-call latency** comes from `llm-calls.txt` (the `llm_calls` table), not from the screenshots.

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

See "Run record" at the end of this file. The summary block starts with `=== run.log tail ===` and ends with `playwright exit code: 0`.

## Cleanup

The script cleans up at exit (trap): it deletes the spec copy, stops the sampler, releases the lock, and deletes `<out>/scratch`. After a run:

```bash
git status --short            # no zz-proof file, no stray files
ls /tmp/openstyle-gpu.lock    # must say: No such file or directory
```

Delete `<out>` when the numbers are in your report. Delete `apps/electron/test-results/` if a failure left it (it holds the error context and trace).

## Traps

1. **Use step failed on 2026-10-25 (26B-A4B run, 06:22Z).** The old throwaway spec cloned E2B with Node `cpSync(src, dst, { recursive: true, mode: 1 })` after the app had started. Error: `expect(locator).toBeVisible() failed ... getByRole('button', { name: 'Use' }) ... Expected: visible ... Timeout: 20000ms ... element(s) not found` at `zz-proof-overnight.test.ts:288`. The error-context page showed the row `Gemma 4 E2B Recommended On-device · 4.4 GB` with a `Download` button. Cause found: `cpSync` writes the snapshot symlinks as ABSOLUTE paths to the source (`/private/tmp/meeting-eval/hf/hub/.../blobs/...`), not as the relative `../../blobs/...` of the HF cache. A link that points into `/tmp` dangles when the source moves or when macOS cleans the blobs (the 00:00 cleanup removed the blobs of 5 models on 2026-10-25). Then `isHfSnapshotPresent` returns false and the row shows Download. Proven: the leftover clone in `/tmp/overnight-app/hf` has absolute links, and `/tmp/meeting-eval/hf/hub` is gone now (dev_b moved the eval cache to `~/Library/Application Support/Openstyle-eval/hf`, per lead). Not proven: whether the source blobs were already missing at 06:22. The failing 06:22 state was not checked. Fix: clone before the app starts with `cp -Rc`, which keeps relative links, and check `find -L <clone> -type l | wc -l` = 0. The script does both. Status: the proof run passed this step (see "Run record").
2. **Claude Code updates break its Privacy grant** (`com.anthropic.claude-code` path changes per version). The Test Runner app avoids it. Never run the app from the agent shell. If a dialog appears, stop and report.
3. **Bluetooth headset mic bug** (`bt-headset-meeting-capture-bug`, issues #169 #170): a transient BT default mic squeezes the system track 3x. This check never records, so it does not hit it. It matters for a real meeting proof only.
4. **`/tmp` is not durable.** Do not point `APP_CHECK_WORKER` or any cache at `/tmp/meeting-eval`. The overnight spec used `/tmp/meeting-eval/worker-2.22.0`; the script now uses the installed runtime.
5. **The scratch `HOME` is on purpose.** The server refreshes the managed worker under `homedir()` before each worker start, even with `OPENSTYLE_MLX_ASR_WORKER` set (`live-testing` skill). With the real `HOME` it could rewrite the installed app's worker folder.
6. **Do not use `pkill`/`killall`.** The guard hook blocks them, and they kill the installed app's worker.
7. **`session_open` in Nexus can answer PERMISSION_DENIED for dev agents.** Claim handoffs without a session. This does not affect the script.
8. **A GPU lock held by another session blocks the run.** The script prints `GPU lock or queue busy: <owner> | queue: <n> line(s)` every 30 s. Wait. Do not remove the lock.
9. **A partial Electron install fails the boot step after the lock wait** (the script now checks this before the build and the lock wait: it exits 2 with a message when `path.txt` or the binary in `dist/` is missing; `APP_CHECK_ELECTRON_PKG` overrides the package folder, for tests) (2026-10-25, dev_senior worktree). Error in `run.log`: `Error: electron.launch: Electron failed to install correctly, please delete node_modules/electron and try installing again` at `helpers/e2e-app.ts:43`, then `1 failed` (boot) and `7 did not run`. Cause: `node_modules/.pnpm/electron@<ver>/node_modules/electron/dist/` held only `LICENSES.chromium.html` and `path.txt` was missing. `node install.js` in that folder exited 0 and installed nothing. Check before a run, in `apps/electron`: `node -e "console.log(require('electron'))"` must print a path to `Electron.app/Contents/MacOS/Electron`. Fix: clone `dist/` and `path.txt` from a checkout with the same Electron version: `cp -Rc <good>/dist <bad>/dist && cp <good>/path.txt <bad>/`.

## Run record

Proof run of the script, 2026-10-25, model `gemma-4-e4b-qat-4bit`, branch `feat/app-check-and-catalog-skills`, Mac with the shipped worker from the installed runtime. Run 2 used the fixed script. Evidence: `~/Library/Application Support/Openstyle-eval/app-check/e4b-run2/` (12 screenshots, `proof.log`, `results.json`, `rss.csv`, `llm-calls.txt`, `stdout.txt`).

| Run | Result | Download | Enhance + Summarize | Peak LLM RSS | TCC prompts |
|---|---|---|---|---|---|
| run 1 | Playwright 8 passed (12.6 min). `run.sh` then stopped at `sqlite3 -readonly` ("unable to open database file"): fixed. | 703.1 s | 15.1 s | 6.75 GiB | 0 |
| run 2 | Playwright 8 passed (12.3 min), exit 0 | 687.1 s | 15.1 s | 6.75 GiB | 0 |

Start of the output (run 2):

```
model=gemma-4-e4b-qat-4bit name="Gemma 4 E4B" hf=mlx-community/gemma-4-E4B-it-qat-4bit out=<out>
E2B clone ok (0 dangling symlinks)
20:23:20 GPU lock busy: meeting-eval gemma-4-e4b-qat-4bit 20:12   (run 2 used the old 60 s message; the script now prints "GPU lock or queue busy" every 30 s)
```

End of the output (run 2, raw, paths shortened):

```
=== results.json ===
{
  "model": "gemma-4-e4b-qat-4bit",
  "downloadSeconds": 687.1,
  "useStep": "PASS",
  "enhanceSummarizeSeconds": 15.1,
  "inspectorHasHfName_light": true,
  "inspectorHasHfName_dark": true,
  "dictationLatenciesMs": [
    1929,
    1874,
    1990
  ],
  "switchBack": "PASS"
}=== peak RSS (GiB) per worker kind ===
llm: 6.75
=== llm_calls ===
step_key|provider|finish_unified|calls|avg_ms|max_ms|errors
candidates|local-mlx-llm|stop|1|2188.0|2188|0
chunk:0|local-mlx-llm|stop|1|1254.0|1254|0
chunk:1|local-mlx-llm|stop|1|1145.0|1145|0
chunk:2|local-mlx-llm|stop|1|1138.0|1138|0
chunk:3|local-mlx-llm|stop|1|1126.0|1126|0
chunk:4|local-mlx-llm|stop|1|1079.0|1079|0
chunk:5|local-mlx-llm|stop|1|1084.0|1084|0
single|local-mlx-llm|stop|1|3189.0|3189|0
tags|local-mlx-llm|stop|1|1745.0|1745|0
=== TCC prompts since start (expect 0) ===
0
=== real log folder: no line in ~/Library/Logs/Openstyle names this run ===
5c5
< ~/Library/Logs/Openstyle/openstyle.log 1809727 Oct 25 20:26:19 2026
---
> ~/Library/Logs/Openstyle/openstyle.log 1810774 Oct 25 20:41:19 2026
=== artifacts in <out> ===
<out>/step2-models-before-dark.png
<out>/step2-models-before-light.png
<out>/step3-model-in-use-dark.png
<out>/step3-model-in-use-light.png
<out>/step4-llm-inspector-dark.png
<out>/step4-llm-inspector-light.png
<out>/step4-meeting-summary-dark.png
<out>/step4-meeting-summary-light.png
<out>/step4-meeting-transcript-dark.png
<out>/step4-meeting-transcript-light.png
<out>/step6-e2b-in-use-dark.png
<out>/step6-e2b-in-use-light.png
playwright exit code: 0
```

What this proves: the Use step passes (so does the switch back to E2B, in light and dark) when the E2B snapshot is a `cp -Rc` clone with relative links. Enhance and Summarize ran 9 calls on `local-mlx-llm`, all finish `stop`, 0 errors. The LLM inspector shows `mlx-community/gemma-4-E4B-it-qat-4bit`.

What this does not prove:
- The default output folder `~/Library/Application Support/Openstyle-eval/app-check/` has a space. Both runs set `APP_CHECK_OUT` to a `/tmp` path. The path code is quoted and the default value was printed by a shell check, but no full run used it (unverified).
- The ASR worker RSS (see Known gaps).
- The Enhance quality: the summary of run 1 still says "lunch date".
- Lock wait: run 2 waited about 6 min for the GPU lock (`lock-wait.log`: first line 20:23:20, lock taken 23:29:21Z = 20:29:21 -03). The run holds the lock from the test start to the end of the Playwright run only.

## Review fixes R1-R3 (PR #328, 2026-10-26)

Tests with raw output are in the PR thread. Test hooks: `APP_CHECK_LOCK` and `APP_CHECK_QUEUE` point the lock and the queue to temp paths, so a test does not touch the shared lock.

- R1 queue: with a fake queue entry first and a free lock, the script printed `GPU lock or queue busy` twice (30 s apart) and took no lock. After the entry was removed it printed `GPU lock taken`, and its own queue line was gone.
- R2 preflight: with `APP_CHECK_ELECTRON_PKG` on a folder with an empty `dist/`, the script printed `Electron binary missing or partial ...` and exited 2 before the build, the lock wait and any output folder.
- R3 summary: with `rss.csv` removed from a copy of `e4b-run2` and `CODE=3`, the summary printed `(rss.csv missing: the sampler did not write it)`, still printed the TCC count `0`, and the script exited 3. The summary runs with `set +e`, so no single failed step hides the Playwright exit code.
