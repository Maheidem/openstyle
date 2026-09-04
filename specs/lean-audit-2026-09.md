# Openstyle Lean/Faster Opportunity Report

**Date:** 2026-09-03
**Status:** Report — vetted by software-engineering and user-experience profiles
**Scope:** tree `main` @ `dbc0fc1` (2.6.0); five-stage audit (measured technical → UX → staff-eng adversarial vetting → UX/product vetting → assembly). No source files were modified by the audit.

> **Re-verify before implementing.** Per house convention, every `file:line` citation below was written against the tree at `dbc0fc1` and goes stale as soon as anything lands. Measurements are dated 2026-09-03 (release assets of 2.6.0, local `build:unpack`, asar header walks, Playwright launches). Re-read each cited site before acting on it.

---

## 1. Executive summary

Since 2.1.1, roughly **87 % of every macOS download was dead payload** — SwiftPM build artifacts and node libraries that nothing at runtime ever loads. A ~10-line packaging change makes every future download **~4× smaller** (597.8 MiB → ~145 MiB), and after that the changes users feel most are about **control, not speed**: cancelling a mis-started transcription, surviving an app quit mid-job, and knowing a silent wait is alive. One pain the size fix cannot touch: **3–4 OS permission dialogs after every update**, which need notarization (named, priced, out of lean scope — §3, Tier 2).

| # | Headline number | Detail |
|---|---|---|
| 1 | **597.8 → ~145 MiB** per download (−73–78 %) | After Tier 0; component math below and in the Appendix |
| 2 | **~87 % of the macOS payload is dead** | 665 MiB SwiftPM `.build` (≈72 %) + 247 MiB unused `node_modules` (≈15 %), byte-verified by two independent asar walks |
| 3 | **Installed footprint 1.24 GB → ~325 MiB** (−74 %) | Unpacked app 1243 MiB measured → ~325 MiB after Tier 0 |
| 4 | **3 of 3 long-running jobs cannot be cancelled** | Meeting transcribe, Import, Summarize (UX-03/04/UX-A1) — plus model downloads (UX-A2); the only exits are waiting or destructive delete |
| 5 | **3–4 TCC dialogs after every update** | Persists until Developer ID + notarization ($99/yr + helper-signing program); the un-fixed half of the top recurring UX pain |

Why ~145 MiB is credible (measured components, compressed estimate; derivation and cross-checks in the Appendix — both vetting stages independently reproduced the inputs):

| dmg component (after Tier 0) | Unpacked | Compressed est. |
|---|---|---|
| Electron Frameworks + helpers | 256 MiB | ~100–112 MiB (Mach-O ~2.4:1) |
| `app.asar` (out/ + configs; **928 MiB today**) | ~10 MiB | ~4 MiB |
| extraResources: helpers 20 + diarization model 22 + whisper 7 | 49 MiB | ~30–38 MiB (~1.5:1) |
| asar.unpacked + lproj + icons | ~10 MiB | ~5 MiB |
| **Total** | **~325 MiB** | **≈139–159 → ~145 MiB** (vs 597.8 today) |

The update `.zip` (589.2 MiB today) lands in the same band — same payload — and the self-updater downloads it **whole** every update (`.blockmap` differential filtered out by design, `self-updater-core.ts:110-125`; its comment still says "~160MB zip", `:159`, written before 2.1.1 tripled it).

---

## 2. Methodology

Five stages, each building on the last:

1. **Measured technical audit** — direct measurement: release assets (`gh`), local `build:unpack`, asar header introspection, Playwright `_electron` cold-start timing, timed test runs, CI job durations, `pnpm why`, SQLite `EXPLAIN QUERY PLAN`; findings tagged MEASURED / VERIFIED / INFERRED / MINED.
2. **UX audit** — what the user *feels*: perceived startup, feedback quality, stuck states, install/update weight. Produced vetting criteria **C1–C8** (visible-behavior, wait-shifting, escape-hatch, stuck-state, control-vs-speed, feedback-parity, permission, weight) and a positives list.
3. **Staff-engineering adversarial vetting** — every load-bearing claim re-verified independently: rebuilt the package (asar **byte-identical**, 972,956,155 B), own asar walker, full `require()` surface of the built bundles, re-ran the EXPLAIN. **43 findings: 38 CONFIRMED, 4 PLAUSIBLE, 1 REJECTED** (`card.tsx`, §6), plus one risk upgrade (`packages/sdk` is on an npm-publish workflow) and the A3 preload landmine (§3, Tier 0).
4. **UX/product vetting** — **12 adjudications (U1–U12)**: 8 endorsed as scoped, 2 modified (UX-01 warming state → pill *status slot*; README plugin lines → fix **now**), 2 conditional (on-demand model → policy-only; notarization → named roadmap item). Added UX-A1..A7, ranking-tension resolution, and this report's shape. Where eng and UX verdicts pull apart, the Stage-4 adjudication wins here; no conflict is left standing.
5. **Assembly** — this document.

**Caveats.**
- **Timings are Apple-Silicon-SSD timings.** Cold start ~0.5 s is measured on an M-series machine; the HDD-class benefit of −25 k asar entries is inferred, untested.
- **The ~145 MiB dmg is component math, not a measured build.** Both stages' walks agree on every input; it stays an estimate until a Tier 0 build exists (§8 names the re-check).
- **Stage working artifacts** (`/tmp/openstyle-lean/` measurements, logs, scripts) are working notes, superseded by this report.
- **Isolation seam for any future dynamic pass:** set `OPENSTYLE_USER_DATA` (fresh temp dir) — `OPENSTYLE_DB_PATH` alone is overridden by userData (`main/index.ts:2768-2770`) — **and** verify nothing listens on 4649: the boot probe (`index.ts:2807-2821`) will find and *reuse* an already-running app's server, routing test traffic at the real instance. Stage 3 verified statically (no launches); Stage 1's startup/test/CI timings were accepted, not re-timed.

---

## 3. Findings by tier

Verdict keys: eng = Stage 3 (CONFIRMED/PLAUSIBLE/REJECTED); UX = Stage 4 (ENDORSE / MODIFY / VETO). MEASURED = input bytes/lines measured; EST = output size/time estimated from them.

### Tier 0 — quick wins (<1 day each, high confidence) → the 2.6.1 packaging release

**T0-1 · A2 — SwiftPM `.build` artifacts (~665 MiB) ship inside the macOS app.**
Evidence [MEASURED]: asar walk (×2, independent, byte-identical rebuild): `native/fluidaudio-diarize` = 665.3 MiB of the 928 MiB `app.asar` (source `.build` = 871 MB on disk); `electron-builder.yml` `files:` has no `!native/**`. Regression landed in 2.1.1 (`ba3f4a6f`, Appendix).
Fix: add `!native/**` to `files:` — nothing reads `native/` at runtime (binaries resolve from `resources/bin` via the deliberate candidate lists); the self-updater swaps whole bundles, never asar contents.
**Eng: CONFIRMED · UX: ENDORSE (U9 — UX-positive; caveats are communication, §8).**
Impact [MEASURED→EST]: asar −665 MiB; dmg −~330–380 MiB; same cut on every future update zip; CI macOS artifact −~660 MiB. **Effort S. Risk low** (regression surface = a binary missing from `resources/bin`). **Gate:** rebuild `--dir` → asar < 300 MiB; packaged app boots + diarization runs; e2e (packaged build) green.

**T0-2 · A3 — all 247 MiB of `node_modules` ship in the asar although nothing loads them.**
Evidence [MEASURED + VERIFIED]: the main bundle is self-contained (`externalizeDeps: false`; `out/main/index.js` requires only Node builtins + `electron` + optional ws addons) and the renderer is Vite-bundled via `app://` — yet react-icons 80.7, lucide-react 18.2, tinyld 11.6, @ts-morph 10.5 MiB, … ship as dead files.
**The landmine (found by Stage 3):** `out/preload/index.js` **does** `require("@electron-toolkit/preload")` at runtime — a blanket `!node_modules/**` breaks every preload: no `window.api`, dead app.
**Ordered fix (hard requirement, same commit):** (1) `externalizeDeps: false` on the *preload* build in `electron.vite.config.ts`; confirm no non-`electron` requires in `out/preload/index.js`; (2) then `!node_modules/**` in `files:` (delete the now-dead `!node_modules/@openstyle/*` / `!node_modules/react` lines).
**Eng: CONFIRMED (with the refinement above) · UX: ENDORSE (U9 — the e2e-on-packaged-build gate and same-commit ordering are UX requirements, not just eng hygiene).**
Impact [MEASURED→EST]: asar 928 → ~10 MiB; −25 k asar entries (first-launch extraction); dmg −~30–60 MiB on top of A2; **Windows/Linux −40–70 MiB est. each** (their only big cut — they never had the `.build` problem). **Effort S–M. Risk medium-low** (a future dep escaping bundling). **Gate:** packaged smoke test — boots, dictation round-trip (cloud), local whisper path, meeting record start, Import decode (ffmpeg from `resources/bin`), settings — plus e2e on the packaged build and a CI assertion that built `out/{main,preload}/*.js` contain no `require("` outside an allowlist (`node:`, `electron`, `./`, `bufferutil`, `utf-8-validate`).

**T0-3 · A7 — test/CI noise in the asar.** `tests/`, `test-results/`, `playwright.config.ts`, `vitest.config.ts`, `.turbo`, `components.json`, `scripts/` ride along (<1 MiB; config hygiene). Fixed by the same `files:` edit. **Eng: CONFIRMED · UX: —.** Effort S (free). Gate: asar listing shows none of them.

**T0-4 · A4+A5 — dev-tool deps in production.** `shadcn` (a dev CLI) in `dependencies` drags msw, ts-morph, @babel, graphql ≈ 35+ MiB of tooling into install trees and the asar; `react-icons` (80.7 MiB) is imported by exactly two files (`shell.tsx`, `pages/help.tsx`). Fix: drop `shadcn` (components already vendored under `components/ui`); swap the two glyphs for lucide/inline SVG, drop `react-icons`. Size-subsumed by T0-2 — do it after, as lockfile hygiene. **Eng: CONFIRMED · UX: —.** Effort S. Risk trivial (visual parity of 2 icons). Gate: `pnpm install` + typecheck + visual check.

**T0-5 · C2′ — knip config truthfulness.** Remove the stale `apps/docs/**` ignore (directory doesn't exist — docs-site cut) and fix the `plugins/emoji` `vite-env.d.ts` pattern. **Keep `card.tsx` and its ignore entry** — Stage 1's "0 imports" claim was REJECTED by Stage 3 (§6). **Eng: CONFIRMED (deletion action void) · UX: —.** Effort S (<1 h). Risk none. **Gate:** `pnpm run knip` stays green (it is a CI job).

*Optional same-day rider if verification time allows:* **UX-12 mic-listener removal** (below) — keep the 2.6.1 surface minimal; do not stretch the release for it.

### Tier 1 — solid wins (days) → 2.7.x

**T1-1 · UX-03 — a meeting transcribe job cannot be cancelled, and a quit mid-job bricks the meeting's UI.**
Evidence [VERIFIED]: no cancel route (`routes/meetings.ts`; `/:id/stop` is recordings-only, `:631`); the job runs fire-and-forget (`:698` `void runTranscribeJob`); the boot sweep rescues only `status='recording'` rows (`:579`), so a quit/crash during `transcribing` spins forever; while `transcribing` every action is disabled and the only enabled control is **Delete** (`meetings.tsx:1657`) — the destructive exit.
Fix: (a) boot sweep → `WHERE status IN ('recording','transcribing')`, `transcribing` → `failed`, error `"Interrupted — app quit during transcription"` (do **not** reuse the `interrupted` status — it means something else in the recorder); (b) `POST /:id/cancel-transcribe` with a cancellation flag in `activeJobs` checked between chunk tasks — stop launching new chunks, let in-flight (≤2) finish, set `failed`, **keep written segments**.
**Eng: CONFIRMED, Tier 1 #1 · UX: ENDORSE with placement + copy (U4).** Cancel lives *inside the progress card* (`meetings.tsx:1665-1684`), ghost-style right of the `done/total` counter; post-cancel copy **"Cancelled — partial transcript kept (N of M segments transcribed)"** — it must say the partial transcript *survived*, or users still reach for the ungated Delete; `Retry failed (n)` (`:1630-1641`) + Re-transcribe light up immediately.
Impact: closes the app's only destructive-exit stuck state (C3+C4); acute, data-loss-adjacent. **Effort M (1–2 days). Risk medium** (job lifecycle race-sensitive; documented race at `meetings.tsx:1341-1346`). **Gate:** server tests (cancel mid-job; sweep resets `transcribing`; cancel during retry-failed) — `pnpm --filter @openstyle/server test tests/meetings*`; manual quit-mid-transcribe → relaunch → recoverable.

**T1-2 · UX-04 — Import: one static "Transcribing…" line for the whole pipeline, no cancel, silent orphaning on navigate.**
Evidence [VERIFIED]: the in-flight state is a bare `<p>` (`import.tsx:213-218`) over a 60 %-opacity dropzone; upload (≤1 GiB) + decode + STT + LLM cleanup all inside one IPC call; zero `AbortSignal` on the path; on success only the history list is invalidated — nothing tells the user the transcript landed.
Fix: graduate to the **same Card family as the meeting progress card** (spinner + elapsed + Cancel); plumb `AbortController` renderer → IPC → `main/import-audio.ts`'s fetch; on completion reuse the native-notification pattern ("Transcript ready", click → Today; `main/index.ts:2953-3048`). Rider (UX-A3, no backend): show expected weight *before* upload — "~2.1 h · 780 MB — this can take a while".
**Eng: CONFIRMED · UX: ENDORSE with layout + mechanism (U3).** Error copy needs **no** work — 9 distinct human strings already exist (`locales/en.json` `import.error.*`); the gap is in-flight silence, not vocabulary. Do not bundle a copy rewrite.
Impact: upgrades the app's worst feedback floor (potentially 30–60+ min of silence). **Effort M (1 day). Risk low-med** (IPC/abort plumbing). **Gate:** extend e2e `import-screen.test.ts` with cancel + completion cases.

**T1-3 · UX-01 — cold local model = indeterminate sweep, no explanation.**
Evidence [VERIFIED]: pill notice vocabulary is only `"reconnecting" | "retrying" | "unavailable"` (`app.tsx:172`); whisper spawn waits up to 90 s (`lib/whisper/server.ts:240`), MLX 120 s; pre-warm fires at hotkey-*down* (hides spawn behind speech), but a short utterance on a cold app pays spawn+model-load after release — 5–90 s of silent sweep, "working" indistinguishable from "hung".
**Eng proposal: a `"warming"` notice. UX verdict: MODIFY (U1) — do *not* touch `PillNotice`.** Its doc comment (`app.tsx:172-177`) is a deliberate design bar: notices are things that have *gone wrong* — a cold-but-working session gets no mark, because a spinner that cries wolf on the happy path is noise over the user's work. The correct home is the pill **status slot** — the mechanism that already carries "Retrying" (`specs/voice-pill-motion.md:153`) and the 60 s elapsed readout (`:87`): text-only "Warming up local model…", handover sweep untouched (`voice-pill-motion.md` §4.5). Prefer the richer signal (pre-warm reports `spawned`, latched per recording) over a bare elapsed heuristic — elapsed alone can't distinguish cold-model from slow cloud cleanup, which the comment explicitly protects. Gating: local provider AND spawn in flight AND wait > ~3 s post-handover.
Impact: names the wait for local users' first dictation after boot/keep-alive (10 min) expiry. **Effort S (2–4 h + 7 locales). Risk low** (must not regress the pill motion spec). **Gate:** pill unit/e2e expectations updated; locales complete.

**T1-4 · UX-02 — batch dictation path has no client-side bound (streaming has a 15 s story).**
Evidence [VERIFIED]: streaming commits time out at 15 s client-side and salvage via REST (`app.tsx:1618-1640`); the batch `POST /api/transcribe` is a bare `apiFetch` with no `AbortSignal` (`app.tsx:1705`), and transcription is deliberately outside the server's `TIMEOUT_PREFIXES` (`apps/server/src/index.ts:39-50`) — a wedged local server = infinite sweep.
Fix: `AbortSignal.timeout(…)` on the batch call, **bound ≥ 360 s** (above whisper 90 s + MLX 300 s worst legitimate case), landing in the **existing error card + Retry** with copy that names the cause: "Local model didn't respond — it may still be starting. Try again." — never a generic timeout string, never below 360 s (a false "failed" on a legitimate long local dictation is worse than the rare hang it cures).
**Eng: CONFIRMED, parameters fixed · UX: ENDORSE (U2).** Impact: converts the infinite sweep into a named failure. **Effort S. Risk: the bound value. Gate:** unit test on the timeout path; copy review.

**T1-5 · UX-08 — disk growth is real but invisible.**
Evidence [VERIFIED]: meetings store two PCM16 channels ≈ 230 MB/h recorded (~115 MB/h imported); default retention 30 d bounds a daily-meeting user around ~7 GB — and **no UI anywhere shows aggregate disk usage** (only reveal-in-Finder and per-model "Remove from disk").
Fix: Settings → **Data** (beside the retention select, `settings.tsx:1447`): one lazy, async line "Meetings audio: X GB · Local models: Y GB" + a "Manage…" link to retention + Models page; the size walk must never jank the settings window. **Eng: CONFIRMED · UX: ENDORSE with placement (U7).** Impact: gives "why is my disk full" an in-app answer. **Effort S (half day + 7 locales). Risk low. Gate:** typecheck/tests; verified lazy (no settings jank with a multi-GB meetings dir).

**T1-6 · C3′ — preload channel-drift guard.**
Evidence [VERIFIED]: `preload/index.ts` (595 lines) vs the hand-written `preload/index.d.ts` (297 lines) is a manual sync that has already drifted once — `main/index.ts:2356` still references the removed `beforeOutput` hook / `POST /api/output/deliver`.
Fix: a vitest parsing `ipcRenderer.on("…")` channel names in `preload/index.ts` and asserting each appears in `index.d.ts` (and vice versa); fix the stale comment while there. Generating the `.d.ts` from source is the larger follow-on. **Eng: CONFIRMED · UX: —** (pairs with UX-12's channel removal). **Effort S (half day). Risk none. Gate:** the new test, in `pnpm --filter @openstyle/electron test`.

**T1-7 · G1-dictionary — dictionary hot path on the delivery critical path.**
Evidence [VERIFIED, stability audit]: `applyFinalRewrites` recompiles a RegExp per row per transcript and issues unbatched `usage_count` UPDATEs on the delivery path. Fix: compile once per dictionary version (invalidate on dictionary write); batch the UPDATEs in one transaction post-delivery. C1-safe (no visible change). **Eng: CONFIRMED · UX: agreed placement (C1-invisible).** Effort S. **Gate:** existing unit tests; a manual delivery pass.

**T1-8 · README plugin lines — fix now, independent of every tier.**
Evidence [VERIFIED]: the "Kept from upstream" list claims *"The plugin system and its SDK"* survived (`README.md:35`) — false since v2.0.0 deleted the plugin host end-to-end (`6211514`); Features advertises *"Plugins — extend the dictation pipeline. See `packages/sdk`"* (`README.md:52`) — a promise the shipped app cannot fulfill. Extensibility-seeking users have been misled for two major versions; contributors following the pointer build dead packages.
Fix: one-line docs change. **Eng: Tier-2 comms · UX: MODIFY (U11) — a live false promise is a docs bug *today*; ship now**, with or before any retirement work. **Effort S. Risk none. Gate:** proofread; matches AGENTS.md's "stale" note.

### Tier 2 — strategic (weeks / product decisions), each with the decision owner

**T2-1 · D6 — Import memory: stream to disk.**
Evidence [VERIFIED]: both import routes buffer (`formData()` + `arrayBuffer()` at `transcribe-file.ts:118`, `meetings-import.ts:180`); ffmpeg stdout cap 1 GiB (`decode.ts:56`); `MAX_IMPORT_BYTES` = 1 GiB → worst case ≈ 2–3× upload in RSS, **in the Electron main process** (server is in-process) — an OOM kills the whole app, not just the job. Tracked in AGENTS.md.
Fix: stream multipart to a temp file, ffmpeg-decode **to a file**, read the WAV in bounded chunks; keep `MAX_IMPORT_BYTES` semantics; both routes share `import-limits.ts` — one seam. Spec in `specs/` first (house convention). **Eng: CONFIRMED · UX: ENDORSE Stage-3 ordering, both required (U10)** — UX-04 changes the user's *tolerance* for the wait, D6 changes the *failure*; one shared abort/IPC seam — design once, land UX-04 (smaller) first.
Impact [EST]: worst-case RSS 2–3 GiB → low hundreds of MiB. **Effort L (3–5 days). Risk medium-high** (error taxonomy 413/415/decode_failed must survive byte-identical). **Gate:** server tests for both routes with large fixtures; manual 1 GiB import. Owner: engineering.

**T2-2 · C1 — retire the plugin scaffolding (~3.4 k LOC of inert-but-maintained code).**
Evidence [MEASURED]: `packages/sdk` (2,038 src LOC) is a runtime dependency for exactly two symbol sets — `OutputMode` (`main/index.ts:53`) and `parseAppContext`/`AppContextPayload` (`lib/streaming/transcribe-bias.ts`, `lib/editor/app-context.ts`) — plus `create-openstyle-plugin`, `plugins/*`, `templates/*`, and the change-gated `Build plugins` CI job (24 s). **Risk upgraded by Stage 3:** `packages/sdk` has `publishConfig.access: public` and sits on an npm-publish workflow (`.github/workflows/package-artifacts.yml`) — removal is a public-API decision, not repo hygiene.
Fix: relocate the two symbol sets (`apps/electron/src/shared/`, `apps/server/src/lib/editor/`); delete packages/plugins/templates, the CI job, their knip entries, the README lines (T1-8); **publish a deprecation notice with or before removal**; unwind the workflow paths. **Eng: CONFIRMED, risk upgraded · UX: ENDORSE retirement, sequencing modified (U11).**
Impact: −~3.4 k LOC, −24 s CI job, one fewer forever-"is this dead?" question. **Effort M (1–2 days). Risk: the npm-public surface. Gate:** typecheck both apps, knip green, full test suite. Owner: maintainer (publication decision).

**T2-3 · G1-native — audited native hot paths.**
(a) *macOS keystroke IPC* [VERIFIED by Stage 3]: `macos-key-listener.swift` emits from **both** an NSEvent monitor and a CGEvent tap — 2–3 stdout lines parsed in main per keystroke, system-wide. Fix: filter in Swift against the configured hotkey (push config to the helper) or coalesce; keeps hotkey latency. Effort S–M. (b) *Windows PowerShell per media event* (200 ms–1 s stall on recording start, `windows-media-playback.ts:137,157,227-239`): persistent helper or batched invocation. Effort M. Both C1-safe. **UX note:** the fork publishes macOS-only, so the Windows fix sits below all macOS-visible work — agreed placement, not dropped. **Gate:** existing unit tests + a keystroke-focused manual pass. Owner: engineering backlog.

**T2-4 · A6 — on-demand model/ffmpeg/whisper payloads: VETOED as a lean cut; policy-only.**
Evidence [MEASURED]: diarization model 21 MB, ffmpeg 3.6 MB, whisper 6.5 MB pre-bundled **by deliberate, recently re-affirmed decision** (`specs/meeting-diarization.md` §4, amended 2026-08-25); ffmpeg is a hard Import dependency.
**Eng: deferred as product-gated · UX: VETO as a cut (U5).** The model is small — the harm is *where the wait lands*: the user has just finished recording and wants the transcript, and the first diarize pass blocks on a download (a C2 wait-shift onto a headline flow) for ~15 MiB after Tier 0 already removes ~450. **If ever revisited as policy, the sanctioned shapes already exist:** the MLX worker is on-demand *and* prefetched at update-download time (`prefetchManagedMlxRuntimeForAppRelease`, `main/index.ts:2989+`), and onboarding downloads the recommended model in the background while the user picks language/hotkey (`onboarding.tsx:99-101`) — first use usually isn't blocked. On-demand diarization needs the same shape (prefetch after the first meeting recording; size + reason disclosed before first dependence), never a blocking first-use fetch; same discipline for ffmpeg/whisper. Owner: product. Impact if ever done: −~20–25 MiB compressed per macOS package.

**T2-5 · UX-05 — transcript content invisible until the job completes.**
Evidence [VERIFIED]: the transcript query is `enabled: hasTranscript` (status must be `transcribed|summarized`, `meetings.tsx:1341-1346`); during the job the user gets only `done/total` + bar — yet segments persist incrementally, so a partial view is *possible*. **Eng: Tier 2, needs spec · UX: ENDORSE as Tier-2 additive, spec-gated (U6)** — the strongest reassurance during the product's longest wait is the user's own words appearing; the spec must handle mid-run provisional/`Them-N` labels with a visible "labels still processing" treatment. Not leanness work; follow-on. (Distinct: converting meetings *polling* to WS push is **rejected** — §6.) Owner: UX spec, then engineering.

**T2-6 · Notarization / Developer ID — named roadmap item; the second half of UX-06.**
Evidence [VERIFIED]: builds are ad-hoc signed, so every update re-triggers 3–4 TCC prompts (Accessibility, Microphone, Screen/System Audio) and the next hotkey press yields `showRequiredPermissionDialog` instead of a dictation (`main/index.ts:4190-4197`). **Eng: deferred, must be named · UX: ENDORSE as roadmap item, never traded away (U12).** Honest pricing: Apple Developer Program **$99/yr**; Developer ID Application + Installer certs; **hardened-runtime entitlements audit across ~10 native helper binaries** (key listener, mic listener, system-audio tap, fast-paste, diarize, ffmpeg, …) — each signed, not just the app bundle; notarytool in the Craft release train; one-time expectation setter — the **first** notarized update re-prompts once more as the signing identity changes, before prompts stop forever. A program, not a lean cut; carried here so the 4×-smaller-download win is not silently credited with fixing permissions it doesn't touch (§7, trap 6). Owner: maintainer.

*Also parked with reasons:* **D2 FTS5** for history search (real cost only at ~10 k+ rows; the 2-scan `LIKE` search — `routes/history.ts:68-73`, EXPLAIN `SCAN` — is fine into the low thousands; single-pass COUNT is a 5-line interim when the route is next touched); **D4** meeting cloud STT concurrency > 2 (product tradeoff: rate limits, cost); **E3** hotspot file splits (maintainability backlog, no runtime cost measured).

### Rider · UX-12 — remove the always-on mic-listener (cleanest runtime cut)

Evidence [VERIFIED, twice]: `micListener.start()` runs unconditionally at boot (`index.ts:3231-3239`), spawning a permanent native child (visible in Activity Monitor attached to the app right now) and forwarding `mic:activity-changed` to both windows — and **zero renderer code subscribes** (`onMicActivityChanged` appears only in `preload/index.ts:568-576` and its `index.d.ts:292` twin); zero references in help, settings, specs, README, `.lore.md`; the Settings mic-status row uses a permissions check, not the listener (`settings.tsx:305`).
Fix: delete the boot block, the three stop/cleanup blocks, the preload channel **and its `.d.ts` twin**, plus `mic-listener.ts`; keep compiling the native helpers this release, remove the sources as a follow-on. **Eng: CONFIRMED · UX: ENDORSE (U8)** — no shipped or documented feature relies on mic-in-use awareness; "future indicator" is an argument for git history, not for a permanent process on every user's machine. Impact: one fewer moving part (C7-positive); ~0 CPU. **Effort S (2–4 h). Risk low. Gate:** `pnpm --filter @openstyle/electron typecheck && test`; grep clean; packaged boot. Scheduling: 2.6.1 rider *only if* verification fits the same day; else 2.7.0.

---

## 4. UX additions (UX-A1..A7, from Stage 4)

- **UX-A1 · Summarize has no progress, no cancel, no bound** — beyond a button label swap (`meetings.tsx:1624-1625`; `runAction("summarize")` at `:1428-1431`); map/reduce over a 2 h meeting runs minutes, and `/api/meetings` is outside `TIMEOUT_PREFIXES` (`apps/server/src/index.ts:39-50`). Third member of the long-job family (UX-03/04) — fold into the same progress+cancel pattern, don't solve it three ways.
- **UX-A2 · Model downloads cannot be cancelled** — zero cancel/abort surface in `pages/models/*` + `model-setup-panel.tsx`; a mis-started multi-GB download's only exit is quitting the app. Small fix: abort the stream, mark model `not_downloaded`. Cancellability is a leanness virtue — users tolerate waits they control.
- **UX-A3 · Pre-upload expectation for Import** — the renderer holds the `File`; show "~2.1 h · 780 MB — this may take a while on local models" on selection, before upload begins (rider on UX-04, no backend).
- **UX-A4 · One completion-notification mechanism, three flows** — the update flow already fires native notifications with click-to-window routing (`main/index.ts:2953-3048`); reuse for Import completion and for meetings auto-transcribe finishing while backgrounded.
- **UX-A5 · Error vocabulary in the flagged flows is already good — explicitly out of scope.** Import has 9 distinct human strings (`import.error.*`); meetings failures land as "N of M chunks failed" plus discoverable `Retry failed (n)`. The deficit is in-flight silence, never error copy.
- **UX-A6 · Onboarding weight is healthy — protect it as an exemplar, not a target.** Four steps; the recommended model downloads in the background while the user picks language/hotkey ("first-time users never choose a model", `onboarding.tsx:99-101`). The codebase's best wait-shift.
- **UX-A7 · Settings rationalization: deliberately no addition.** Surface is moderate (6 visible sections, network hidden, advanced gating on Models; `settings.tsx:109-122`); the 1,086-line Tone page is product surface, not waste. Only sanctioned settings change: T1-5's one-line disk surface.

---

## 5. What's already good — don't relitigate

- **Cold start**: ~432 ms firstWindow (median), ~532 ms dashboard DOMContentLoaded, ~535 ms embedded-server `/api/health`; perceived content 503–599 ms on fresh and existing profiles; no flash/spinner chain; hotkey registered synchronously at boot. Measured twice — a non-problem.
- **Renderer weight**: route-level code splitting (`dashboard.tsx:25-35`), lazy per-language locales, 4.2 MiB total, CSS 156 K, scoped framer-motion, paginated history.
- **Data layer**: all hot SQLite queries hit an index (WAL + busy_timeout + synchronous=NORMAL) — sole exception is history search's `LIKE` scan (D2, parked). **Tests**: 763 server tests in **1.58 s**; Electron vitest < 1 s; e2e against a packaged build — not a bottleneck.
- **Core-loop feedback engineering**: pill motion spec'd (`voice-pill-motion.md`), measured, implemented — distinct arrival/handover/delivered/cancelled/silence states, delivered mark on paste dispatch; pre-warm during speech; persistent WS with reconnect + REST salvage; no per-recording settings fetch; 15 s streaming commit bound.
- **Meeting recording UX**: live clock, conditional polling (2 s list / 1 s detail, only while active), import→transcribe handoff, discoverable `Retry failed (n)`.
- **Update feedback** (not weight): download-% banner, autoDownload off, one-shot notifications. **Error copy**: distinct, human, localized (UX-A5). **Retention defaults**: bounded (30 d), indexed daily sweeps — growth bounded, just not surfaced (T1-5).
- **Process story**: whisper/MLX/system-audio/ffmpeg/diarize all on-demand already; UX-12 is the one free subtraction. **Middleware/summarize budgeting**: thin stack; map/reduce overlap waste bounded ≈ 5 %.

---

## 6. Rejects & scope discipline — items *not* pursued, and who that protects

| Rejected item | Why | Who the rejection protects |
|---|---|---|
| **"Delete `components/ui/card.tsx`"** — the audit's one REJECTED claim | Stage 1's "0 imports anywhere" was wrong: `import.tsx:3` and `meetings.tsx:19` both import `Card` (likely grepped without the `@renderer` alias). Stage 3 caught it before any deletion. | Users of the Import and Meetings pages, and the next auditor's trust in this report |
| **On-demand diarization model (and ffmpeg/whisper) as lean cuts** | The wait lands at the worst moment — right after recording, when the user wants the transcript; deliberate pre-bundling re-affirmed 2026-08-25; ~15 MiB vs Tier 0's ~450 | Meeting users' first diarize; the headline flow's offline reliability |
| **Polling → WS push conversion (E2/UX-09)** | No user-visible staleness measured (worst case ≤ 2 s badge); conditional polling correctly tuned, flicker-free | Users from pure churn risk on working flows |
| **Any startup/first-paint optimization** (incl. lazy tinyld chunk) | Measured 0.43–0.6 s to real content, twice; hotkey live in the first second | Everyone — regression risk is all downside on a solved problem |
| **Sub-360 s batch timeout / "warming" alert-ring / copy rewrites / settings redesign** | Traps 5, 4, 7 (§7) | Long-dictation users; the pill's signal contract; scoped releases |
| **D1/D3/D5/E1 "findings"** | Non-problems by measurement/read, kept on record so nobody re-audits them | Reviewer time |
| **E3 file-splitting as lean work** | Real change-friction, no runtime cost measured — maintainability backlog | The lean mission's focus |

Framing: the negative space is value. Every rejection above is scope discipline that protects a user-visible behavior, a measured non-problem, or a deliberate product decision.

---

## 7. Do-not-do trap list

1. **Don't lazy-load a model mid-flow** — no blocking first-use download for diarization/ffmpeg/whisper without prefetch + pre-dependency size disclosure. The MLX-prefetch and onboarding-background patterns (T2-4) are the only sanctioned shapes.
2. **Don't remove progress feedback to save code** — Import's static line is the floor to *fix*, never the bar to meet; every wait > 2 s keeps honest feedback (C6).
3. **Don't touch window/pill creation or boot order for startup "wins"** — measured 0.5 s to real content, hotkey live in the first second; regression risk is all downside.
4. **Don't add a "warming" alert-ring to the pill's happy path** — status slot only; the crying-wolf bar is documented in the code (`app.tsx:172-177`).
5. **Don't set the batch timeout below 360 s** — a false "failed" on a legitimate long local dictation is worse than the rare hang it cures.
6. **Don't let the changelog imply permissions are fixed** — TCC re-prompts persist until notarization; say the download shrank, not the dialogs.
7. **Don't bundle UX copy rewrites or a settings redesign into the lean release** — error vocabulary is already good (UX-A5); settings are already moderate (UX-A7).
8. **Don't move onboarding's background model download to first dictation** — it is the app's best wait-shift (UX-A6).
9. **Don't ship A3's `node_modules` exclusion without the preload bundling in the same commit** — a dead `window.api` is the one packaging failure users would feel everywhere.

---

## 8. Recommended sequencing

**2.6.1 — packaging fast-follow: yes, unambiguously.**
- **Scope:** T0-1 (A2 `!native/**`), T0-2 (A3 preload-bundling-then-`!node_modules/**`, **in that order, same commit**), T0-3 (A7), T0-4 (A4/A5 after A3), T0-5 (C2′ knip), plus the T1-8 README fix. UX-12 only as a same-day rider if its verification fits.
- **Why now:** every macOS user pays a 589 MiB full-zip download per update and ~87 % of it is provably dead; the fix is ~10 lines of config + a one-line vite change; release mechanics are proven (Craft train since 1.1.1); the diff touches no runtime code except the preload bundling, which typecheck + e2e + the packaged smoke test cover.
- **Required gate — packaged smoke test** (not optional): boots (preload failure = no `window.api` = everything dead), dictation round-trip with a cloud provider, local whisper path, meeting record start, Import decode (ffmpeg from `resources/bin`), settings. e2e against the packaged build is the standing CI gate; add one manual whisper pass if e2e lacks it.
- **Asar re-check walker:** after the change, rebuild `--dir` and re-walk the asar header. If the measured dmg lands **above ~180 MiB, something else leaked into `files:`** — find it before shipping. (A header walker is ~20 lines of Python: JSON length u32 @ offset 12, JSON @ offset 16.)
- **Communication (release blockers for the changelog):** users still download one final ~589 MiB zip to *reach* 2.6.1 — every update after is ~4× smaller; and permissions are *not* fixed (§7, trap 6).

**2.7.0 — Tier 1, starting with UX-03.**
- **UX-03 first** (transcribe cancel + `transcribing` boot sweep): the app's only destructive-exit stuck state; acute, data-loss-adjacent. The UX pass accepted deferring it one release *only* on the condition that 2.7.0 follows promptly — not a "whenever" backlog.
- Then UX-04 (+UX-A3 rider, sharing the abort seam D6 will reuse), UX-01 (status-slot form, per U1), UX-02 (≥ 360 s), UX-08, C3′ (pairs with UX-12's channel removal), G1-dictionary. UX-12 rides here if it didn't fit 2.6.1.

**Tier 2 — product decisions, each with its owner (§3).** D6 (engineering; spec first), C1 retirement (maintainer; npm deprecation + workflow surgery), G1-native (engineering backlog; Windows half below macOS-visible work), A6 on-demand payloads (product; only via sanctioned prefetch shapes, if ever), UX-05 (UX spec, then engineering), notarization (maintainer; $99/yr + helper-signing program; the second half of UX-06). D2/D4 stay parked with reasons.

The two headline threads are complementary, not competing: **packaging is *carrying less* (recurring, every update); UX-03 is *trapping less* (acute, when it bites)**. Packaging is 2.6.1; control is 2.7.0.

---

## Appendix — dmg-size history and where the bloat regression landed

Measured per-release asset sizes via `gh api` (Stage 1):

| Release window | macOS dmg | What it contains |
|---|---|---|
| 1.0.x | ≈ 158–164 MiB | pre-diarization baseline |
| 2.0.0 – 2.1.0 | 159.1 – 177.2 MiB | plugin system removed; `node_modules` still shipped; 2.1.0 = 177.2 MiB |
| **2.1.1** | **591.9 MiB** | **← regression lands** (`ba3f4a6f`) |
| 2.1.1 → 2.6.0 | 591.9 → 597.8 MiB | dead payload re-shipped on every release and update since |
| 2.6.0 (current) | **597.8 MiB** | arm64 zip 589.2 · setup.exe 201.9 · AppImage 217.0 · deb 160.6 · MLX worker 112.2 (separate, on-demand) |

**The regression, precisely:** 2.1.1's only change is `ba3f4a6f` ("fix(ci): require fluidaudio-diarize binary and select Swift 6 toolchain"). Once CI actually built the SwiftPM package before electron-builder ran, the build's `.build` directory (~871 MB on disk, 665 MiB in the asar after its own internal packing) landed inside the package — a **+415 MiB dmg jump in one release**, and ~87 % of every macOS download since (≈72 % SwiftPM build garbage + ≈15 % unused node_modules, as compressed share of the dmg). Windows/Linux jobs never build Swift, so their sizes stayed proportionate (201.9 / 217.0 MiB) — which is also why A3 (`node_modules`) is their only big cut, and why the `.build` fix (A2) is macOS-only.

Tier 0 expected landing, restated: dmg ≈ 139–159 MiB (most likely **~145** — a **−73–78 %** cut from 597.8; cross-check: 2.1.0's 177.2 MiB *with* node_modules *without* the 22 MB model ⇒ ~125–140 MiB), update zip in the same band, installed app 1243 MiB (1.24 GB) → ~325 MiB (−74 %), Windows setup.exe → ~125–155 MiB est., AppImage → ~140–170 MiB est. If a measured Tier 0 build lands above ~180 MiB, something else leaked — re-run the walker (§8).

---

## Implementation status (2026-09-04)

Branch `feat/lean-wins` (17 commits, → 2.7.0). Every gate green: server
tests, electron vitest, e2e 70 passed on the packaged build, knip, biome,
both typechecks, `check-bundled-requires`, `verify-native-binaries`
(source + packaged). The estimates above held.

### Landed, with measured outcomes

| Item | Commit | Measured outcome |
|---|---|---|
| T0-1..T0-3 packaging (`!native/**`, preload-bundled `!node_modules/**`, dev-file excludes) | `1f093b9` | **asar 928 → 8.98 MiB**; installed app 1243 → **311 MiB** (predicted ~325) |
| T0-4 dep hygiene (shadcn CLI, react-icons out of prod deps) | `0cdca55` | lockfile-only; size subsumed by T0-2 |
| T0-5 knip truthfulness | `e8db3bb` | knip green as a CI gate |
| CI guard for the lean package | `69d7ea8` | `check-bundled-requires.mjs` fails the build on any non-bundled `require()` |
| T1-8 README plugin claims | `76201ac` | false promise gone two releases after it became false |
| T1-1/UX-03 meeting cancel + quit-mid-job recovery | `1993cef`, `7386804` | `POST /:id/cancel-transcribe` (segments survive, row → `failed`), boot sweep recovers `transcribing` rows (live-job-filtered), ghost Cancel in the progress card; `retry-failed` now claims the slot |
| T1-2/UX-04+A3 import progress, cancel, notification | `b6f3a06` | progress-card family + `job:abort` seam (`main/abortable-jobs.ts`) + completion notification + pre-upload weight expectation |
| T1-3/UX-01 pill warming status | `0c7dcc0` | status-slot "Warming up local model…" (pre-warm `cold` latch, 3 s gate, never a PillNotice) |
| T1-4/UX-02 batch dictation bound | `0c7dcc0` | client-side `AbortSignal.timeout(360_000)` with named failure copy |
| T1-5/UX-08 disk usage line | `c250288` | Settings → Data: lazy async "Meetings audio / Local models" line |
| T1-6 preload channel-drift guard | `3bf18da` | vitest parse of `preload/index.ts` channels vs `index.d.ts` |
| T1-7 dictionary hot path | `ed3a6a4` | rewrites compiled once per dictionary version; usage UPDATEs batched in one transaction |
| UX-12 rider: mic-listener removal | `2b9c048` | boot block, spawner, preload channel and `.d.ts` twin deleted; follow-on below |
| D6/T2-1 streaming imports | `0e01d20` (spec `eddfda1`) | **meetings-import RSS delta 0 MB @ 160 MB upload**; dictation peak ≈ 1× decoded WAV (was 2–3× upload); all error envelopes byte-identical |
| e2e isolation hardening | `bcd7fdd` | `OPENSTYLE_E2E_SERVER_URL` escape hatch + foreign-4649 skip guards (`import-screen`, `app`) |

**Release-asset gate (measured on the packaged build):** dmg 597.8 → **135.8 MiB**
(−77 %), arm64 zip 589.2 → **131.9 MiB** — inside §8's 139–159 estimate band
and well under the 180 MiB "something leaked" ceiling.

**UX-12 follow-on (this bundle):** `resources/bin` mic-listener binaries no
longer ship — `electron-builder.yml` filters them from `extraResources` and
`verify-native-binaries.mjs` no longer expects them. The Swift/C sources and
their `compile-native.js` wiring are deliberately kept one more release
(`2b9c048` commit message); source deletion is the remaining follow-on.

### Deferred, with reasons (unchanged owners)

- **G1-native (T2-3):** unmeasured user benefit vs. core-input-path risk —
  the keystroke IPC is the hotkey path; needs manual QA on hardware.
  Engineering backlog.
- **C1 (T2-2):** retiring the plugin scaffolding is an irreversible
  npm-public-surface decision (`packages/sdk` has `publishConfig.access:
  public` and a publish workflow). Maintainer.
- **A6 (T2-4):** vetoed per §3 — policy-only; only the sanctioned prefetch
  shapes if ever revisited. Product.
- **UX-05 (T2-5):** partial-transcript visibility needs its own UX spec;
  additive feature, not leanness. UX spec, then engineering.
- **Notarization (T2-6):** blocked on an external Apple Developer account
  ($99/yr + helper-signing program). Maintainer; roadmap item.

### Manual QA owed before/after 2.7.0 (verifier's list — not coverable headlessly)

1. **GitHub glyph parity** — the react-icons → lucide swap in help/settings
   (T0-4): identical marks, alignment, stroke weight.
2. **Pill warming mark** — appears only for a genuinely cold local model,
   only after 3 s, never for cloud or a warm server, and never as a
   PillNotice (T1-3).
3. **Settings → Data row** — "Disk usage" line renders, lazy-loads, no
   settings jank with a multi-GB meetings dir (T1-5).
4. **Meeting cancel UI** — ghost Cancel inside the transcribe progress
   card; post-cancel copy names the kept partial transcript (T1-1).
5. **Import progress card + completion notification** — spinner/elapsed/
   Cancel during a real upload; notification fires on completion, click
   routes to the transcript (T1-2).

**Communication gate (§7 trap 6), executed at release time:** the 2.7.0
changelog must say downloads shrank ~4×; it must *not* imply the 3–4 TCC
re-prompts after update are fixed — those persist until notarization.
