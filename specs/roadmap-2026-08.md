<!-- Produced 2026-08-26 by multi-agent research: repo signals + competitor + tech-frontier + user-demand sweeps -->

# Openstyle Product Roadmap Recommendation — Post-2.3.0

## Methodology note

The COMPETITORS input describes Openstyle's current baseline from `README.md`/`AGENTS.md`, and both are confirmed stale by the REPO SIGNALS sweep: the plugin SDK it lists as live was removed end-to-end in commit `6211514`, and its claim that "Openstyle has zero meeting-capture/notes functionality" predates the v2.3.0 diarization ship (Meeting Mode, `system-audio-capture.ts:29`, `apps/server/src/routes/meetings.ts`, `specs/meeting-diarization.md` Phase 1 all confirmed live). Where the two inputs disagree on what Openstyle itself already has, this report defers to the repo sweep. Where they describe rivals, the competitor doc is the source of record. This matters for prioritization: with meeting capture and Phase-1 diarization already shipped, the highest-leverage moves extend that surface (cross-meeting identity, RAG over meetings, MCP exposure) rather than build the category from scratch.

---

## 1. TL;DR — top 5 next moves

1. **Ship local RAG + local MCP exposure of dictation/meeting history.** Granola gates this behind $14/user/mo (granola.ai/pricing); Openstyle can offer it free and on-device using sqlite-vec against the existing `freestyle.db`, and it lines up with 2026's dictation-as-agent-input trend (VoiceInk #704/#801, superwhisper's Claude Code launch).
2. **Build cross-meeting speaker identity (voiceprint enrollment).** It's schema-ready but not built (`specs/meeting-diarization.md:31-34`), it's the most-requested feature across four unrelated open-source repos (Meetily #226/#230, Vibe, Buzz #1429), and on-device-only enrollment is the specific mitigation the 2026 BIPA lawsuit wave against cloud meeting bots has made a real differentiator, not just a checkbox.
3. **Render the live transcript view.** The streaming transport already exists (`streamer.ts`); this is a UI gap, not an architecture gap, it's the second-most-cited unprompted user complaint (two independent Reddit threads, the FreeFlow HN debate), and Parakeet-TDT's 220ms p50 latency makes it credible to ship well.
4. **Wire domain vocabulary into Whisper's `initial_prompt`.** Openstyle already has a dictionary/vocabulary system; USER DEMAND's most emphatic single complaint pattern ("Hetzner" → "head sner," Meetily #474) is a biasing problem the app is already positioned to solve, likely without new infrastructure.
5. **Fix the flagship before adding to it.** Test the `activeJobs` 409-guard (`meetings.ts:474,497,578`, zero test coverage today), resolve the retry-failed `speaker_label = NULL` gap (`specs/meeting-diarization.md:1088-1092`), and de-duplicate the 43MB electron-builder packaging bug (`electron-builder.yml:23-36,51-64,78-82`) — all on the feature that just shipped and that every future release now depends on.

---

## 2. Ranked feature candidates

### 1. Local RAG over dictation/meeting history
**What it is:** on-device semantic search over transcripts, answering "what did we decide about X" style queries.
**Demand evidence:** competitors doc names this the sharpest available differentiator since Granola charges $14/user/mo for the equivalent; TECH FRONTIER §4 calls sqlite-vec "the easiest capability to add."
**Local-first feasibility:** sqlite-vec (dependency-free SQLite extension, native vector type + KNN), BAAI/bge-small-en-v1.5 for local embedding, compatible with Openstyle's existing `node:sqlite`/`freestyle.db` single-file architecture.
**Effort:** M. No new toolchain, but real product surface (chunking, retrieval UI, prompt assembly).
**Impact:** High — directly undercuts Granola's paid tier with a free, local equivalent.

### 2. Local MCP exposure of history
**What it is:** expose dictation/meeting history to Claude/ChatGPT/Cursor over local MCP, the same shape as Granola's paid feature.
**Demand evidence:** Wispr Flow ships this free at the top of its pricing page; Granola gates it at $14/user/mo; USER DEMAND §11 shows the same appetite from the dictation-as-agent-input angle (VoiceInk #704).
**Local-first feasibility:** builds directly on #1's local store, no server Openstyle operates.
**Effort:** S once RAG exists, otherwise M bundled with it.
**Impact:** High, and it's the one line item competitors explicitly says Openstyle can offer "free by construction."

### 3. Cross-meeting speaker identity / voiceprint enrollment
**What it is:** recognize the same speaker across separate meetings, via an enrolled voiceprint.
**Demand evidence:** Meetily #226 (14 reactions), #230 (7 reactions, 12 comments), Vibe #1030/#1014, Buzz #1429 — four unrelated repos, same ask.
**Local-first feasibility:** pyannoteAI's enroll-from-30s-clean-audio flow, or sherpa-onnx's identification stack (pure ONNX, cross-platform, ~35MB models). Store voiceprints local-only (SQLite, ideally encrypted-at-rest) with explicit consent UI — the documented mitigation against the 2026 BIPA class-action wave against cloud meeting bots.
**Effort:** M. Schema is already ready per `specs/meeting-diarization.md:31-34`; the work is enrollment UX, matching, and the consent flow.
**Impact:** High, and it converts a legal risk rivals carry into a positioning asset ("your voiceprint never leaves your machine").

### 4. Rename-speaker UI
**What it is:** let users assign real names to diarized "Speaker 1/2" labels.
**Demand evidence:** explicit named non-goal in `specs/meeting-diarization.md:35-37`, adjacent to the #3 demand cluster.
**Local-first feasibility:** trivial, UI-only against the existing diarization output.
**Effort:** S.
**Impact:** Medium, but it's a near-prerequisite for #3 to feel finished.

### 5. Live transcript view
**What it is:** render partial ASR results as speech happens, instead of pasting a block after the fact.
**Demand evidence:** two independent unprompted Reddit posts, the entire design argument of the FreeFlow Show HN thread, and USER DEMAND §4's latency-as-switching-axis data (VoiceInk #572 documents dropped first-second audio from delay, not just perceived slowness).
**Local-first feasibility:** `streamer.ts` already pushes PCM over WS for streaming-capable providers; Parakeet-TDT on MLX streams tokens on 640ms chunks with 220ms p50 latency and better crosstalk WER (7.6% vs Whisper L3-Turbo's 8.4%) per the Contra Collective M5 Max benchmark.
**Effort:** M. Transport exists; work is the streaming HTTP/WS extension to the transcribe endpoint plus pill-UI rendering.
**Impact:** High — this is the feature two different users asked for by name without prompting.

### 6. Domain vocabulary → `initial_prompt` biasing
**What it is:** feed Openstyle's existing dictionary into Whisper's `initial_prompt` so proper nouns and jargon transcribe correctly.
**Demand evidence:** the single most emphatic complaint pattern in the dataset — "Hetzner"/"Pydantic" garbling, Buzz's documented medical-transcription failures, Meetily #474 (6 reactions) asking for exactly this mechanism.
**Local-first feasibility:** whisper.cpp already supports initial-prompt biasing; Openstyle already has a dictionary system. Whether it's currently wired into the prompt path is unverified in these inputs — first task is confirming that, then extending it.
**Effort:** S–M depending on what's already wired.
**Impact:** High relative to cost — this is accuracy, not a new feature.

### 7. Screen-context-aware per-app formatting (opt-in, gated)
**What it is:** read active app / selected text / clipboard via Accessibility APIs to auto-adjust tone and formatting, matching superwhisper's Super Mode and VoiceInk's Power Mode.
**Demand evidence:** competitors' own "cheapest wins" ranks this #1, noting Openstyle already holds the Accessibility permission and Remix's client tools already read selected text over IPC.
**Local-first feasibility:** fully on-device, processed with the existing local/BYOK LLM path.
**Effort:** M.
**Impact:** High, but ship it only per-app opt-in, nothing persisted, nothing logged — this is exactly the mechanism the independently verified Wispr Flow accessibility-tree investigation (1,688 logged events in 30 hours, full accessibility-tree walks) turned into a trust crisis. Recommending this without the privacy gate would hand a rival the same story.

### 8. Per-app model + prompt profiles (Power Mode)
**What it is:** extend the existing per-app tone setting into full per-app model + enhancement prompt + hotkey, VoiceInk's sharpest differentiator against Openstyle today.
**Demand evidence:** direct feature parity gap named in competitors' VoiceInk section; VoiceInk is Openstyle's closest open-source analog.
**Local-first feasibility:** fully on-device, builds on existing per-app tone infrastructure.
**Effort:** M.
**Impact:** Medium-high — closes the sharpest apples-to-apples open-source gap.

### 9. Action-item extraction from meetings
**What it is:** a local-LLM summarization pass over completed meeting transcripts to pull out action items, same shape as Granola's core notepad function.
**Demand evidence:** table-stakes in the meeting-notes category (Granola, MacWhisper, Meetily, anarlog all do this); Openstyle already has meeting transcripts and a local-LLM cleanup pipeline to extend.
**Local-first feasibility:** direct extension of `createChatModel()`, the same code path already used for dictation cleanup.
**Effort:** S–M.
**Impact:** Medium-high — closes a visible gap in the just-shipped meeting feature with low new surface.

### 10. Hallucination / repeat-loop flagging
**What it is:** detect and flag likely-hallucinated or stuck-repeating transcript segments rather than silently shipping them.
**Demand evidence:** Vibe #1023 (model gets stuck repeating a sentence), Buzz #1570 (explicit ask for automatic flagging).
**Local-first feasibility:** heuristic pass on transcript output (n-gram repeat detection), no new model needed.
**Effort:** S–M.
**Impact:** Medium — a trust/quality fix, not a headline feature, but cheap relative to the complaint frequency.

### 11. CLI for agent-callable dictation
**What it is:** a scriptable command-line interface so coding agents can pipe voice input the way MacWhisper's CLI does.
**Demand evidence:** VoiceInk #801 (7 reactions), #704 (MCP for AI coding agents), and the broader 2026 shift of dictation into agent workflows (USER DEMAND §11).
**Local-first feasibility:** wraps existing dictation pipeline, no new architecture.
**Effort:** S–M.
**Impact:** Medium — a modern answer to the same extensibility appetite the removed plugin system used to serve, without reviving it.

### 12. Parakeet-MLX / Qwen3-ASR as the MLX ASR engine
**What it is:** move the Apple Silicon MLX worker from Whisper to Parakeet-TDT (better crosstalk WER, lower latency), with Qwen3-ASR as an option for non-English/noisy audio.
**Demand evidence:** Contra Collective benchmark table (7.6% crosstalk WER, 220ms p50 vs Whisper's 8.4%/380ms); relevant to a meeting product specifically since crosstalk matters more than clean-speech WER.
**Local-first feasibility:** slots into the existing PyInstaller/HTTP-child-process MLX-worker pattern (`apps/server/src/lib/mlx-asr/`), no new build tooling — both are plain Python packages.
**Effort:** M.
**Impact:** Medium-high, but only as a **replacement** for the current MLX default, not an additional engine choice — MacWhisper's own App Store reviews show engine proliferation actively hurts UX ("only one that works somewhat reliably is Parakeet v3").

### 13. KDE/KWin frontmost-app provider
**What it is:** the one confirmed-still-open piece of the Wayland platform-parity work (`app-stability-roadmap.md` PR10) — Sway and GNOME are done, KDE is not (zero "KWin"/"kde" matches in `index.ts`).
**Demand evidence:** Linux is the single loudest issue in the entire dataset (Meetily #32, 46 reactions, 3x the next-highest item); this is the one remaining gap inside the platforms Openstyle already claims to support (`README.md:55-59`).
**Local-first feasibility:** N/A, platform integration only.
**Effort:** S.
**Impact:** Medium — small fix, closes a real named gap, does not require reopening the "should we chase Linux parity" question.

### 14. Overlapping-speech attribution
**What it is:** correctly attribute segments where two speakers talk simultaneously.
**Demand evidence:** explicit named Phase 2 non-goal in `specs/meeting-diarization.md:38-41`.
**Local-first feasibility:** TECH FRONTIER §2 flags this as "mostly research-stage, not yet in a packaged local library" (spectral clustering refinement papers, no shipped tool).
**Effort:** L, and possibly premature — no production-ready local library exists yet.
**Impact:** Low near-term relative to cost.

### 15. Meeting templates
**What it is:** prompt presets for note structure by meeting type, Granola's 29+ templates.
**Demand evidence:** category table-stakes per competitors' Granola section, not independently demanded in the USER DEMAND set.
**Local-first feasibility:** trivial — these are just prompt presets over the existing local-LLM pipeline.
**Effort:** S.
**Impact:** Low-medium — nice-to-have, not a differentiator, cheap enough to bundle into a meetings-polish pass rather than plan around.

---

## 3. Tech-debt & polish shortlist

Ordered by ratio of fix cost to compounding benefit:

1. **Doc/lore truth pass — README, AGENTS.md, .lore.md.** `AGENTS.md:2-4` tells every future agent (and this project runs on heavy AI-agent leverage) to treat these files as authoritative. Today they actively mislead: `README.md:37,52` advertises a removed plugin system, `AGENTS.md:19,30,32,38` documents dead plugin architecture, `.lore.md` has entries pointing at files deleted in `6211514` (`plugins/view-manager.ts`, `plugins/ui-assets.ts`). This is a velocity fix for the solo maintainer's own tooling, not cosmetics — highest priority in this section.
2. **electron-builder 43MB double-package.** `electron-builder.yml:23-24` (`asarUnpack: resources/**`) plus `extraResources` (`:26-29,32-36,51-64,78-82`) ship `resources/bin` (16M), `models` (21M), `whisper` (6.5M) twice. Every download and every self-update pays this. Biggest single user-visible win in this list.
3. **`activeJobs` 409-guard has zero test coverage.** `apps/server/src/routes/meetings.ts:474,497,578` — the concurrent-job-guard path on the just-shipped flagship feature is untested. This is a correctness risk, not a nice-to-have.
4. **Retry-failed leaves `speaker_label = NULL`.** Named, accepted Phase-1 gap (`specs/meeting-diarization.md:1088-1092`) — worth closing alongside #4 above (rename-speaker UI) since both touch the same speaker-label surface.
5. **Orphaned workspace packages from the plugin removal.** `pnpm-workspace.yaml:1-3`, `knip.jsonc:98` still reference `plugins/*`; the three plugin packages and `packages/sdk` sit on disk unused. Delete alongside the doc pass.
6. **history.tsx i18n gaps.** 5 un-i18n'd strings (`history.tsx:707,719,1465-1466,1475-1476`) in an app that ships 8 locales elsewhere — a one-sitting fix.
7. **Dark-mode `--muted-soft` sign-off.** `globals.css:148-152` — one consumer (`.eyebrow` rule), a one-screenshot design check, not a redesign.
8. **Design-system foundation-pass leftovers.** Dead `--chart-1..5` tokens (zero consumers post-reskin), unregistered `--live`/`--accent-passive-*` tokens forcing 9 call sites into arbitrary-value Tailwind instead of real utility classes (`globals.css:96-100,124-128,160-164,185-188`; consumers at `shell.tsx`, `progress.tsx`, `history.tsx`, `meetings.tsx`, `remix.tsx`, `model-list.tsx`). Bundle with #4 (rename-speaker UI) since both touch `history.tsx`/`meetings.tsx` speaker-chip styling.
9. **Cosmetic "Freestyle" identifier residue.** `remix-prompts.ts:6,72,123,231` and `download-whisper-cpp.mjs:39`'s `~/.cache/freestyle/whisper-bin` path — the one functional path not on the separation audit's exception list.
10. **Superseded specs need a status pass**, not new work: `app-stability-roadmap.md` (6 of 7 PRs already shipped), `remix.md` (pre-fork cloud-era header, superseded architecture), `design-system.md:254-278` (mixed done/open list). Mark these current-vs-stale so they stop reading as a live backlog.

---

## 4. Explicit non-recommendations

- **Chasing full Linux/Windows parity for meetings, diarization, or MLX ASR.** These are permanent Mac exclusives by architecture, not a closable gap: FluidAudio is Swift/CoreML/ANE-only, Meeting Mode depends on Core Audio process tap, MLX is Apple Silicon-only. `README.md:55-59` already states this positioning. Do the one confirmed in-scope fix (KDE/KWin, item #13 above) and stop there — Linux demand is real (Meetily #32's 46 reactions is the loudest signal in the whole dataset) but satisfying it would mean rebuilding the diarization stack on sherpa-onnx as a second, cross-platform code path, a multi-month commitment misaligned with solo-maintainer capacity for a fork whose own README already scopes itself to macOS.
- **Reviving the plugin system.** It was deliberately removed end-to-end (`6211514`). The extensibility demand it used to serve (USER DEMAND §11, VoiceInk #704/#801) is better answered by local MCP exposure (#2) and a CLI (#11) — both lower-maintenance, both align with where the ecosystem is actually moving in 2026.
- **Adding ASR engines as user-facing toggles rather than swapping the default.** MacWhisper's own reviews show engine proliferation is a complaint, not a feature ("only one that works somewhat reliably is Parakeet v3" after too many engines were added). If Parakeet-MLX or Qwen3-ASR land, they replace the current MLX default; they don't become option #5 in a picker.
- **Chasing SOC 2/HIPAA/ISO compliance positioning.** These are organizational certifications for a project with no server Openstyle operates — not a code path, and irrelevant to Openstyle's actual local-first architecture. Competing on "we don't collect what needs to be certified" is a stronger and cheaper claim than pursuing certification.
- **Team/shared dictionary sync, cross-device sync, calendar auto-join with a hosted bot.** All explicitly require a server or account Openstyle would operate, breaking local-first by architecture, not by policy. If demand for these grows, that's a fork-identity decision for the maintainer, not a roadmap item to slot in quietly.
- **The native Swift-bridge path for SpeechAnalyzer/Foundation Models/Translation (macOS 26).** Genuinely high long-term value (zero-download system models, ANE acceleration, privacy-clean) but requires a new toolchain surface, not just another Python sidecar. TECH FRONTIER §5 itself frames this as "worth a scoped spike rather than a default choice." Don't fold it into the current roadmap; revisit as its own decision once the MCP/RAG and speaker-identity work lands.
- **Overlapping-speech attribution before a local library exists.** Named Phase-2 non-goal, and the underlying research (spectral clustering refinement) isn't packaged yet. Revisit when sherpa-onnx or pyannote ships a production path, not before.

---

## 5. Suggested next-3-releases arc

**2.4 — "Finish what shipped."**
Ship the speaker-identity completion set (rename-speaker UI, retry-failed `speaker_label` fix, cross-meeting voiceprint enrollment with explicit consent UI), close the `activeJobs` test gap, fix the electron-builder 43MB duplication, and run the doc/lore truth pass. One user-facing headline: **live transcript view**, since the transport already exists and it's the single most-cited unprompted complaint in the dataset. Bundle in the i18n and dark-mode quick wins — they're cheap enough not to need their own cycle.

**2.5 — "Ask your history."**
Local RAG over dictation/meeting history (sqlite-vec) plus local MCP exposure, positioned explicitly against Granola's $14/user/mo gate. Pair with domain-vocabulary → `initial_prompt` wiring and action-item extraction, both direct extensions of infrastructure that already exists. This release is where "local-first" stops being an architecture note and becomes the headline pitch — free RAG/MCP that a $14/mo competitor doesn't offer.

**3.0 — "Context-aware dictation."**
Per-app model+prompt profiles (Power Mode parity with VoiceInk) and opt-in, nothing-persisted screen-context formatting (superwhisper Super Mode parity), shipped together with an explicit privacy design and public write-up — turning the feature that could otherwise repeat the Wispr Flow accessibility-tree story into the opposite: proof that reading screen context doesn't require logging it. Gate this release on the privacy design being done, not on the calendar.