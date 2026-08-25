# Meeting Diarization Phase 1 — Implementation Spec

Implementation spec for opt-in speaker diarization of the **system** channel
in Meeting Mode, grounded in the codebase as of `main` @ 2026-08-25 (Meeting
Mode v1 landed, `SCHEMA_VERSION = 29`). Companion to
[`meeting-mode.md`](meeting-mode.md); read that first — this spec assumes its
architecture (mic/system channel split, `meeting_segments`, `merge.ts`) as
given and only describes the delta.

---

## 1. Goal

Meeting Mode today labels every system-channel line "Them" — correct when one
other person is talking, wrong the moment a meeting has three or five. Phase
1 adds per-speaker labels (`Them 1`, `Them 2`, ...) to the system channel only,
computed by a local, on-device diarization pass after transcription
completes. Mic audio stays "Me": the user is never diarized against
themself.

The feature is **opt-in** (a settings flag, default off) and **fails closed**:
any error anywhere in the pipeline — missing binary, missing models, spawn
failure, timeout, malformed output — degrades silently to exactly today's
behavior. A user who never enables the flag sees zero difference: same code
path, same "Them" label, same everything.

### Non-goals (Phase 1)

- **Mic diarization.** The mic channel is one person by construction; running
  a speaker model on it would only manufacture false splits.
- **Cross-meeting speaker identity.** "Them 2" in today's standup and "Them 2"
  in tomorrow's are unrelated labels. No embedding persistence, no voice
  enrollment, no `ChunkEmbedding`/`extractSpeakerEmbedding` usage (dossier
  §5) — FluidAudio exposes both; Phase 1 uses neither.
- **Renaming speakers.** No UI to relabel "Them 2" to a real name. The open
  speaker set (§5) is deliberately schema-ready for this later, but Phase 1
  ships no rename affordance.
- **Overlapping-speech attribution.** When two system-channel speakers talk
  over each other, the diarizer emits overlapping segments; Phase 1's
  timestamp-overlap assignment (§7) picks one winner per whisper segment, it
  doesn't represent overlap in the transcript.
- **Live/streaming diarization.** The pass runs once, after transcription, over
  the complete `system.wav`. No incremental labeling during recording.
- **Non-macOS.** FluidAudio is Swift/CoreML/ANE-only. Meeting Mode is already
  macOS-only (Core Audio process tap), so this adds no new platform gap.

---

## 2. Architecture

```
                         (existing, unchanged)
mic.wav ──────────────────────────────────────────────────▶ "Me" segments
system.wav ──▶ MeetingTranscriber.run() ──▶ meeting_segments (source='system')
                                                     │
                                                     │ diarization flag ON
                                                     ▼
                                    runTranscribeJob() — new step, after
                                    run() resolves, before status flips
                                    'transcribed' and before writeTranscriptMarkdown
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                              │ spawn fluidaudio-diarize <system.wav path>   │
                              │ (native helper, ANE, offline)                │
                              └──────────────────────┬──────────────────────┘
                                                     │ JSON on stdout:
                                                     │ [{speakerId, startS, endS, quality}]
                                                     ▼
                              assignSpeakerLabels(diarSegments, systemRows)
                              — overlap match against RAW system.wav timeline,
                                first-appearance → "Them 1".."Them N"
                                (see §7)
                                                     │
                                                     ▼
                              UPDATE meeting_segments SET speaker_label = ?
                              WHERE id = ? (per system-channel row)
                                                     │
                                                     ▼
                              loadMergedTranscript() → mergeTranscript()
                              → MergedSegment.speakerLabel carried through
                              → renderer: "Them" ?? speakerLabel fallback
```

Key design choice, stated explicitly: **labels are assigned against the raw,
undrifted `system.wav` timeline**, not the post-`applyDrift` merged timeline.
`mergeTranscript()` (`apps/server/src/lib/meetings/merge.ts`) runs
`applyDrift(mic, system, syncData)` before interleaving — by the time a
segment reaches the merge step its timestamps have already been shifted to
align with `mic.wav`'s clock. The diarizer, in contrast, ran directly against
`system.wav` and reports `system.wav`-relative seconds. Matching diarizer
output to *drifted* segment timestamps would systematically mis-assign labels
by the drift amount, growing over the length of the meeting. So the
assignment pass runs once, right after diarization, directly against the
`meeting_segments` rows' original `start_ms`/`end_ms` (source of truth, never
mutated by drift — drift is applied only in `merge.ts` at read time), and
persists the result as a column on those rows. `merge.ts` never sees
diarizer output at all; it only reads a label that's already been decided.

---

## 3. FluidAudio helper — package, not single-file compile

`compile-native.js`'s `compileMacOS()` compiles every existing native binary
the same way: a single `.swift` file, no dependencies, `swiftc -O <src> -o
<out> -framework X -framework Y`. That pattern **does not extend** to
FluidAudio — it's a SwiftPM library dependency (`Package.swift`, `swift-tools-
version: 6.0`, macOS 14+), and `swiftc` invoked directly on one file has no
way to resolve or link it. This needs a genuinely new build path, not a new
entry in the existing `binaries` array.

**New source layout:**

```
apps/electron/native/fluidaudio-diarize/
├── Package.swift          # depends on FluidAudio 0.15.6+, defines
│                           # executable target "fluidaudio-diarize"
└── Sources/
    └── main.swift          # CLI entry (§4)
```

```swift
// apps/electron/native/fluidaudio-diarize/Package.swift
// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "fluidaudio-diarize",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.6")
    ],
    targets: [
        .executableTarget(name: "fluidaudio-diarize", dependencies: ["FluidAudio"])
    ]
)
```

**New build branch in `compile-native.js`**, alongside (not inside)
`compileMacOS()`'s `binaries` loop:

```js
function compileFluidAudioDiarizer() {
  console.log("\n[compile:native] Building fluidaudio-diarize (SwiftPM)...\n");
  const pkgDir = join(NATIVE_DIR, "fluidaudio-diarize");
  const swiftArch = arch === "arm64" ? "arm64" : "x86_64";
  const ok = runShell(
    `swift build -c release --arch ${swiftArch} --package-path "${pkgDir}"`,
  );
  if (!ok) {
    failures.push("fluidaudio-diarize");
    console.warn("  WARNING: diarization helper failed to build. " +
      "Diarization will be unavailable; existing Meeting Mode is unaffected.");
    return;
  }
  const builtBin = join(pkgDir, ".build", "release", "fluidaudio-diarize");
  const out = join(outputDir, "fluidaudio-diarize");
  ensureDir(outputDir);
  copyFileSync(builtBin, out);
  chmodSync(out, 0o755);
  console.log(`  -> ${out}`);
}
```

Called from `compileMacOS()` after the existing loop, guarded so a failure
here never fails the whole `compile:native` run (matches the existing
per-binary `failures.push` pattern — one bad binary warns, doesn't abort).

**Cost this adds to `build:mac`:** `npm run compile:native` is a listed
prerequisite of `build:mac` (`package.json:23`). A SwiftPM `swift build -c
release` of FluidAudio (resolving + compiling the dependency graph) is
materially slower than the existing `swiftc` one-liners — expect it to
dominate `compile:native`'s wall time on a clean checkout. **Decision: accept
this cost, do not cache/vendor the built binary.** Rationale: `compile:native`
already runs on every `build:mac` for the other seven binaries, CI/dev
machines have Xcode 16+ installed (required anyway for other binaries'
targets), and SwiftPM caches dependency checkouts + build artifacts under
`.build/` between runs — a warm cache (unchanged `Package.swift`) rebuilds
fast. If this proves too slow in practice, the fallback is committing the
compiled binary to `resources/bin/darwin-arm64/` and skipping the build step
when it's already present — not spec'd further here; revisit only if
measured.

**Toolchain requirement to document in the repo's setup notes:** `swift-
tools-version: 6.0` requires Xcode 16+ / Swift 6 toolchain. If CI's Xcode is
older than that, this is a hard blocker, not a warning — check before
merging.

---

## 4. Model bundling and helper CLI contract

**Amended 2026-08-25.** This section originally spec'd download-on-first-
enable, budgeted at ~100-150MB on the theory that the full VBx model set
was that large — the rest of this paragraph is what changed and why, the
rest of the section is the resulting (current) design. Measuring the actual
offline model set (`FluidInference/speaker-diarization-coreml`, the four
`.mlmodelc` bundles `OfflineDiarizerManager` uses + `plda-parameters.json`)
put it at **~22MB** — small enough that the original tradeoff ("don't ship
150MB to users who never enable this") no longer holds. User decision: ship
the models **pre-bundled inside the app** instead of downloading them at
first opt-in. §8 (settings) and §9 (pipeline integration) below reflect the
same change — there is no download orchestration, progress UI, or
first-enable side effect left anywhere in this feature.

### Bundling: fetched at build time, shipped in the app

Five artifacts, from HuggingFace repo `FluidInference/speaker-diarization-
coreml`: `Segmentation.mlmodelc`, `FBank.mlmodelc`, `Embedding.mlmodelc`,
`PldaRho.mlmodelc` (compiled CoreML model directories — already `.mlmodelc`,
not `.mlmodel`; `MLModel(contentsOf:)` loads them directly, no
`MLModel.compileModel(at:)` step, verified by running the real offline
pipeline end-to-end against a copy of a local FluidAudio cache) and
`plda-parameters.json`.

Not committed to git — `apps/electron/resources/models/` is gitignored, the
same treatment as `resources/bin/`. Instead, `compile-native.js`'s
`compileMacOS()` calls a new `fetchDiarizationModels()` step (alongside the
existing `compileFluidAudioDiarizer()`) that populates
`apps/electron/resources/models/speaker-diarization/` idempotently:

1. Skip if every artifact is already present (checked via `coremldata.bin`
   under each `.mlmodelc` bundle + `plda-parameters.json`).
2. Else, copy from a local FluidAudio cache
   (`~/Library/Application Support/FluidAudio/Models/speaker-diarization/`)
   when one exists — the common case on a dev machine that's already run
   the offline diarizer once — trimming out `config.json` and
   `xvector-transform.json`, which the cache also holds but which belong to
   the *streaming* `DiarizerManager`, not `OfflineDiarizerManager` (this CLI
   helper uses only the latter).
3. Else, download each file directly via `curl` from
   `huggingface.co/FluidInference/speaker-diarization-coreml/resolve/main/...`.

Like `compileFluidAudioDiarizer()` (§3), failure here is warn-only, never a
CI build blocker — same rationale: diarization is opt-in, and `build:mac`
shouldn't fail over a still-optional feature on a runner without network
access to HuggingFace.

**Packaging**: `electron-builder.yml`'s `mac:` block gets a new
`extraResources` entry, `resources/models` → `models` (alongside the
existing `resources/whisper/darwin-${arch}` entry) — macOS-only, matching
the feature's platform scope (§1 non-goals) and `fluidaudio-diarize`'s own
resource entry.

### Directory layout the helper expects

FluidAudio's public `OfflineDiarizerModels.load(from: directory)` resolves
`<directory>/speaker-diarization/<Model>.mlmodelc` internally (confirmed by
reading `OfflineDiarizerModels.swift` and `ModelHub.swift`'s `repoPath =
directory.appendingPathComponent(repo.folderName)`) — so the value passed
as `--models-dir` is the **parent** of `speaker-diarization/`, not that
folder itself. Concretely: packaged app → `<resourcesPath>/models`
(electron-builder maps `resources/models/*` → `<resourcesPath>/models/*`
per the entry above); dev → `<cwd>/resources/models`.
`getFluidAudioModelsDirPath()` in `diarize.ts` mirrors
`getFluidAudioDiarizeBinaryPath()`'s exact resolution precedent (below) and
returns `null` when `<dir>/speaker-diarization` doesn't exist — a
build/packaging gap, not a user-triggerable state.

### Helper CLI contract

Three invocations, mirroring `system-audio-probe.ts`'s pattern of a cheap
probe mode separate from the real work — plus one flag, `--models-dir
<dir>`, that every mode now accepts:

**`--models-dir <dir>`.** When given, every mode loads models directly from
`<dir>/speaker-diarization/` via `OfflineDiarizerModels.load(from:)` — no
FluidAudio cache dir, no network, ever (the offline-load path, loading
already-compiled `.mlmodelc` bundles straight off disk). Absent
`--models-dir`, the helper falls back to the original cache-dir behavior —
kept for local/dev runs against a developer's own FluidAudio cache, not
used by the packaged app, which always passes `--models-dir` (§9).

### `fluidaudio-diarize --prepare-models [--models-dir <dir>]`

With `--models-dir`: a no-op success — the models are already bundled,
nothing to prepare — except it still calls `OfflineDiarizerModels.load(from:
)` to validate they actually load, so a corrupted or partial bundle
surfaces as `ERR_MODELS_MISSING` instead of silently reporting success.
Without `--models-dir`: unchanged from the original design — network-
allowed, downloads the offline model set into FluidAudio's default cache
dir (`~/Library/Application Support/FluidAudio/Models/speaker-diarization/`),
progress lines on stderr (`PROGRESS <done> <total>`), exits 0 on success,
nonzero + `ERR_DOWNLOAD <message>` on failure. Kept for dev/compat only —
the packaged app never calls this mode at all any more (§9).

### `fluidaudio-diarize --probe [--models-dir <dir>]`

No network, no diarization, either way. Reports whether the models are
ready to load — from `--models-dir` when given, else the FluidAudio cache
dir. Prints `READY` or `NOT_READY` to stdout, exits 0 either way. Used by
the settings UI (§8) and by `runDiarizationPass` (§9) as a defensive check
before the real run — a corrupted/partial bundle surfaces as `NOT_READY`
("models missing from bundle", §10) instead of an opaque diarize failure.

### `fluidaudio-diarize <path-to-system.wav> [--models-dir <dir>]`

The real pass. **No network either way** — sets `ModelHub.offlineMode =
true` before loading models, so any cache/bundle gap fails fast and loud
instead of silently blocking on a download mid-transcription-job. With
`--models-dir`: loads models from the bundle and calls
`OfflineDiarizerManager.initialize(models:)` before `process(url:)`, instead
of letting `process` lazily call the manager's own `prepareModels()` against
the cache dir. Reads the WAV (already 16kHz mono — `AudioConverter`/
`process(url:)` is a cheap pass-through per dossier §4), runs
`OfflineDiarizerManager.process(url:)` with `OfflineDiarizerConfig.default`
(no manual clustering-threshold tuning in Phase 1 — ship defaults, revisit
only if real meetings show over/under-splitting), and emits JSON to stdout:

```json
[
  { "speakerId": "S1", "startTimeSeconds": 0.0,  "endTimeSeconds": 4.2, "qualityScore": 0.91 },
  { "speakerId": "S2", "startTimeSeconds": 4.5,  "endTimeSeconds": 9.8, "qualityScore": 0.87 }
]
```

Progress lines (`PROGRESS <chunk> <total>`) on stderr, matching the existing
`macos-system-audio` convention of using stderr for out-of-band status and
stdout for payload data. JSON on stdout is emitted **compact, not
pretty-printed** (`JSONEncoder.outputFormatting` left at its default) — the
caller reads it via `child_process.execFile` with an explicit `maxBuffer`
(see §9) sized for a long meeting's full segment list, and there's no reason
to spend bytes on indentation the caller immediately parses and discards.
Exit codes / stderr error lines, matching the `ERR_*` naming convention from
`system-audio-capture.ts`'s `handleLine` parser (dossier §1):

| Condition | stderr | exit |
|---|---|---|
| Models missing/incomplete while offline | `ERR_MODELS_MISSING` | 1 |
| Diarization threw (bad audio, internal error) | `ERR_DIARIZE_FAILED <message>` | 1 |
| Success | (progress lines only) | 0 |

No new spawn/supervise class is needed — this is a single bounded run-to-
completion invocation (spawn, collect stdout, wait for exit), not a
long-lived streaming process like `SystemAudioCapture`. It's called from
server-side Node (`runTranscribeJob`, not Electron main), via `child_process
.execFile`.

**Binary path resolution — not `getNativeBinaryPath`.** That resolver
(`apps/electron/src/main/native-binary.ts`, dossier §1) does `import { app }
from "electron"` and reads `app.isPackaged` — it's Electron-main-only code,
and `apps/server` cannot import it (architecturally, `@openstyle/server`
doesn't depend on the `electron` package; practically, `app` wouldn't
resolve outside Electron's main-process runtime). This exact problem is
already solved once in this codebase for the same reason: whisper-local's
binary is also resolved from `apps/server`, not `apps/electron`, via
`getResourcesDir()` in `apps/server/src/lib/whisper/constants.ts:176-193` —
it checks `process.resourcesPath` directly (present because `apps/server`
runs embedded, in-process, inside Electron main — `startOpenstyleServer` is
imported and called directly from `apps/electron/src/main/index.ts:2795`,
not spawned as a separate process — so `process.resourcesPath` is simply
set on the one shared process) and falls back to a `process.cwd()`-relative
dev path when it isn't. `diarize.ts` follows that exact precedent for
**both** the binary and the models dir:

```ts
export function getFluidAudioDiarizeBinaryPath(): string | null {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const dir = proc.resourcesPath
    ? join(proc.resourcesPath, "bin") // matches electron-builder.yml's
                                        // extraResources `to: "bin"` (dossier §1)
    : join(process.cwd(), "resources", "bin", `${process.platform}-${process.arch}`);
  const p = join(dir, "fluidaudio-diarize");
  return existsSync(p) ? p : null;
}

export function getFluidAudioModelsDirPath(): string | null {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const dir = proc.resourcesPath
    ? join(proc.resourcesPath, "models") // matches the mac extraResources
                                          // entry `to: "models"` above
    : join(process.cwd(), "resources", "models");
  return existsSync(join(dir, "speaker-diarization")) ? dir : null;
}
```

---

## 5. Schema migration

Bump `SCHEMA_VERSION` from 29 to 30 in `apps/server/src/lib/schema.ts`, add a
guard block following the exact style of migration 29 (dossier §4):

```ts
if (currentVersion < 30) {
  // Meeting diarization Phase 1: nullable per-segment speaker label for the
  // system channel only. NULL means "not diarized" — renders as "Them",
  // identical to pre-migration behavior. Never populated for source='mic'.
  db.exec(`ALTER TABLE meeting_segments ADD COLUMN speaker_label TEXT`);
}
```

No `meeting_speakers` table in Phase 1 — the column value *is* the identity
(a small per-meeting index, `"1"`, `"2"`, ...; §6 covers why it's stored as
a locale-neutral index rather than the formatted "Them N" string), no
separate row to reference, no rename target to hang off a foreign key. The
column is nullable and untouched for every existing row and every
mic-channel row going forward; this is additive-only, no backfill, no data
migration risk.

The UI renders **an open speaker set**: whatever distinct non-null
`speaker_label` indices exist in a meeting's system segments, in the order
they first appear, with no hardcoded cap. A meeting with one other speaker
renders only "Them 1" if it renders any label at all — see the "collapse to
today's behavior" rule in §7.

---

## 6. Types — extend, don't widen

`merge.ts:12` (`export type Speaker = "Me" | "Them"`) stays exactly as is.
`Speaker` is the **channel**, not the person — widening it to `string` would
break the echo-dedup step (`mergeTranscript`'s Them-wins-over-Me comparison,
dossier §3) and the existing `meeting-merge.test.ts:15-29` assertions
(`m.speaker` equality checks against literal `"Me"`/`"Them"`) for no reason:
diarization is an orthogonal axis, not a replacement for the mic/system
split.

Add an optional field instead:

```ts
// merge.ts
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;   // NEW — system channel only; locale-neutral index as text, e.g. "2" (§6); undefined = undiarized
}

export interface MergedSegment {
  speaker: Speaker;         // unchanged: "Me" | "Them"
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;    // NEW — carried through from the matching TranscriptSegment
}
```

`mergeTranscript` passes `speakerLabel` through unchanged when concatenating
mic/system segments (lines 260-263 in the current source) — no new logic
there, it's a field copy. `loadMergedTranscript`
(`apps/server/src/routes/meetings.ts:176-197`) selects `speaker_label` from
`meeting_segments` alongside the existing columns and includes it on the
`TranscriptSegment` it builds before calling `mergeTranscript`.

**Storage/i18n decision.** `speaker_label` (§5) stores a **locale-neutral
numeral as text** (`"1"`, `"2"`, ...) — the diarizer-assigned index from §7's
numbering rule — not the pre-formatted English string `"Them 1"`. Storing
the formatted string would ship English-only labels sitting next to an
already-localized `meetings.them` fallback in the same transcript for the
app's 7 other locales (dossier §6: `meetings.me`/`meetings.them` exist per-
locale already) — a mixed-language view for every non-English user who
enables the flag. The fix is one new i18n key instead: add
`meetings.themNumbered` (e.g. en: `"Them {{n}}"`) to `locales/en.json` and
the other 6 locale files + template, matching the existing per-locale
`me`/`them` keys' location (dossier §6, lines 797-798).

Renderer (`apps/electron/src/renderer/src/pages/meetings.tsx`): extend the
local `TranscriptSegment` interface (lines 84-88) with the same optional
`speakerLabel?: string` (still the raw numeral string, e.g. `"2"`), and
change the hardcoded ternary (lines 855-863) to:

```tsx
{seg.speaker === "Me"
  ? t("meetings.me")
  : seg.speakerLabel
    ? t("meetings.themNumbered", { n: seg.speakerLabel })
    : t("meetings.them")}
```

An undiarized system segment (`speakerLabel` undefined — flag off, or on but
this particular segment fell through to NULL, §7) renders exactly the
string it renders today, in whatever locale the user has selected.

---

## 7. Label assignment algorithm

Runs once per meeting, after the diarizer helper returns its JSON segment
list, against the system-channel rows already persisted in `meeting_segments`
for that meeting (`source = 'system'`, ordered by `idx`).

**Inputs:**
- `whisperSegments: { id, startMs, endMs }[]` — from `meeting_segments`,
  raw (undrifted) timestamps, `source = 'system'` only.
- `diarSegments: { speakerId, startTimeSeconds, endTimeSeconds }[]` — from
  the helper, converted to `startMs`/`endMs` (× 1000) for consistent units.

**Per whisper segment, in order:**

1. Compute overlap-ms against every diarizer segment:
   `overlap = max(0, min(w.endMs, d.endMs) - max(w.startMs, d.startMs))`.
2. **Winner = the diarizer segment with the largest overlap.**
3. **Tie-break** (equal overlap, e.g. a whisper segment split exactly between
   two diarizer segments): prefer the diarizer segment whose **midpoint** is
   closer to the whisper segment's midpoint. If still tied (symmetric split),
   prefer the earlier diarizer segment (stable, deterministic, no
   randomness).
4. **Zero-overlap fallback.** A whisper segment can legitimately land with
   zero overlap against every diarizer segment when it falls entirely inside
   a diarizer-side gap (the two pipelines trim silence differently — this is
   the actual trigger, not segment length; a short whisper segment sitting
   *inside* a diarizer segment already has nonzero overlap and is handled by
   step 2). In that case, fall back to **nearest-neighbor within a bounded
   look-around window**: find the diarizer segment physically nearest by
   timestamp (`min(|w.startMs - d.startMs|, |w.startMs - d.endMs|, ...)`)
   within a **2000ms window** either side of the whisper segment. If one is
   found, assign it. If nothing is found within the window (diarizer
   produced no output near this segment at all — e.g. it silently dropped a
   very short blip), leave `speaker_label = NULL`. NULL renders as plain
   "Them" (§6) — this is the designed degrade path, not an error state.
5. **Label numbering:** collect the distinct diarizer `speakerId`s that won
   at least one whisper segment, in **order of first appearance by
   startMs** (not raw `S1`/`S2` index — FluidAudio's numbering is clustering-
   order, not speaking-order, and "Them 1" should be whoever talks first).
   Map first-seen → index `1`, second-seen → index `2`, etc. `speaker_label`
   stores this index as text (`"1"`, `"2"`); the renderer formats it into
   "Them N" via the `meetings.themNumbered` i18n key (§6) — the assignment
   step itself is locale-agnostic.
6. **Collapse rule:** if the mapping produces exactly one distinct index
   across the whole meeting (single other speaker, or diarizer legitimately
   found only one voice), still assign index `1` — do not special-case it
   back to NULL/bare "Them". A single-other-speaker meeting rendering "Them
   1" is correct and consistent with the open-speaker-set design (§5);
   collapsing it would make the label a meeting-length-dependent surprise.
7. Persist: one `UPDATE meeting_segments SET speaker_label = ? WHERE id = ?`
   per system-channel row (batched in a transaction), covering every row
   including the NULL ones (explicit NULL write, not "leave whatever was
   there" — keeps behavior correct on a re-run of the diarization pass,
   e.g. after a future retry mechanism).

This entire step operates on **raw, undrifted timestamps** — see §2's
explicit callout on why drift must not be applied before this point.

---

## 8. Settings plumbing

Follows the existing flat settings pattern exactly (dossier §5) — no new
validation route logic needed, same as `remix_bar_enabled`.

- **Key**: `apps/electron/src/shared/settings-keys.ts` — add
  `meetingDiarizationEnabled: "meeting_diarization_enabled"` alphabetically
  among the other `meeting*` keys (near lines 24-27).
- **Server read helper**: new `getMeetingDiarizationEnabledSetting()` in the
  meetings lib, mirroring `getTranslateModeSetting()`
  (`apps/server/src/lib/language.ts:64-70`) exactly:
  ```ts
  export function getMeetingDiarizationEnabledSetting(): boolean {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'meeting_diarization_enabled'")
      .get() as { value: string } | undefined;
    return row?.value === "true";
  }
  ```
  Queried once at the top of the new diarization step in `runTranscribeJob`
  (§9) — flag off means the step is skipped entirely, not run-and-discarded.
- **Renderer toggle**: settings page (`DiarizationSettingsPopover` in
  `meetings.tsx`), same call shape as `handleRemixBarToggle`
  (`settings.tsx:344-353`) — `getClient().api.settings[":key"].$put({ param:
  { key: SETTINGS_KEYS.meetingDiarizationEnabled }, json: { value:
  String(enabled) } })`. Placed in the meetings settings section, not the
  general toggle list, since it's meeting-scoped. **Amended 2026-08-25**:
  the toggle just persists the flag — models are pre-bundled (§4), so there
  is no first-enable download step, no progress UI, and no case where the
  toggle needs to revert itself. `GET /diarization/status` (§9) still runs
  on popover open so a build/packaging gap (bundle missing, or a corrupted
  bundle) can surface as `meetings.diarizationUnavailable` /
  `meetings.diarizationNotReady` instead of the toggle silently doing
  nothing — informational only, it doesn't gate the toggle.
- **Acknowledgments / licensing**: the diarization model
  (`FluidInference/speaker-diarization-coreml`, finetuned from
  `pyannote/speaker-diarization-community-1`) is CC-BY-4.0 and requires
  attribution on distribution (dossier §7). Add a credit line + links to both
  HuggingFace model cards in the app's existing licenses/acknowledgments
  screen. This is a ship requirement, not a nice-to-have — file it alongside
  this feature's PR, don't defer it.

  **Satisfied 2026-08-25**: shipped as a new "Acknowledgments" row at the
  bottom of Settings → Application (`apps/electron/src/renderer/src/pages/
  settings.tsx`), crediting the speaker diarization models as derived from
  `pyannote/speaker-diarization-community-1` (CC-BY-4.0) via
  `FluidInference/FluidAudio` (Apache-2.0), with links to both project
  pages. i18n keys `settings.application.acknowledgments{,Desc,Text}` added
  to all 8 locale files.

---

## 9. Pipeline integration point

`apps/server/src/routes/meetings.ts`, `runTranscribeJob()` (dossier §2,
lines 274-285): insert the diarization step between `results = await new
MeetingTranscriber(deps).run(...)` and the `UPDATE meetings SET status =
'transcribed'`, so the meeting's status stays `'transcribing'` for the
duration of the diarization pass (visible to the UI as still-in-progress,
not a new status value) and `writeTranscriptMarkdown` — called last, after
status flips — always renders final labels, never an intermediate
undiarized state. This ordering claim requires one more change beyond the
call-site move: `formatTranscriptMarkdown` (`merge.ts:297-302`) currently
renders the bare `s.speaker` field ("Me"/"Them") and has no `speakerLabel`
awareness at all — update it to `s.speaker === "Them" && s.speakerLabel ?
\`Them ${s.speakerLabel}\` : s.speaker`, so `transcript.md` picks up numbered
labels too. This is English-only text in the markdown export regardless of
app locale — consistent with, not a new gap versus, today's behavior: `s
.speaker` itself is already the unlocalized literal `"Me"`/`"Them"` (`merge
.ts:12`), never run through `t()`, because the export is a plain-text
artifact independent of the UI's locale.

```ts
const results = await new MeetingTranscriber(deps).run({
  meetingDir: audioDir,
  micSegments,
  systemSegments,
});

if (getMeetingDiarizationEnabledSetting()) {
  await runDiarizationPass(id, audioDir).catch((err) => {
    log.warn(`Diarization failed for meeting ${id}, falling back to "Them": ${String(err)}`);
    // no rethrow — every failure here degrades to today's behavior, never
    // fails the transcribe job itself.
  });
}

const failed = results.filter((r) => r.status === "failed").length;
db.prepare("UPDATE meetings SET status = ?, error = ? WHERE id = ?").run(
  "transcribed",
  failed > 0 ? `${failed} of ${results.length} chunks failed` : null,
  id,
);
writeTranscriptMarkdown(id, audioDir);
```

`runDiarizationPass(meetingId, audioDir, deps?)`, new function (new file,
`apps/server/src/lib/meetings/diarize.ts`, alongside `merge.ts`/
`transcriber.ts`). Takes an optional deps object (`{ resolveBinaryPath,
resolveModelsDirPath, execFile, ... }`, defaulting to the real
resolvers/`execFile` in production) mirroring the injected-`TranscriberDeps`
pattern `MeetingTranscriber` already uses — §12's pipeline tests need a fake
binary path, a fake models dir, and a fake spawn result, which a hardcoded
function calling `execFile` internally couldn't support; this is the same
reason `MeetingTranscriber` itself takes deps.

1. Resolve `system.wav` path under `audioDir` (dossier §7 — the file is
   still on disk post-transcription, retention only sweeps on explicit
   delete or the separate `meeting_retention_days` sweep, neither of which
   races a same-job diarization pass).
2. Resolve the binary via `getFluidAudioDiarizeBinaryPath()` (§4 — the
   server-side resolver, not Electron's `getNativeBinaryPath`). Not found →
   warn, return (flag was on but build/packaging didn't ship the helper —
   treat identically to "unsupported").
3. Resolve the bundled models dir via `getFluidAudioModelsDirPath()` (§4).
   Not found → warn ("models missing from bundle"), return — a
   build/packaging gap (`fetchDiarizationModels()` failed at build time, or
   the electron-builder `extraResources` entry didn't ship it), not a
   user-triggerable state (amended 2026-08-25 — this replaces the earlier
   "model cache not ready" case entirely; there is no cache to be not-ready,
   only a bundle to be present or missing).
4. `--probe --models-dir <dir>` first; `NOT_READY` → warn ("models missing
   from bundle"), return. Defensive: the bundle is expected to always be
   present and loadable once step 3 passes, but a corrupted/partial install
   (e.g. an interrupted copy during packaging) shouldn't surface as an
   opaque diarize failure when a cheap probe can call it out specifically.
5. Spawn `fluidaudio-diarize <system.wav> --models-dir <dir>` via
   `execFile`, with a **timeout** (§11 — SIGTERM on expiry) and an explicit
   `maxBuffer` (e.g. 8MB — the default 1MB is sized for typical CLI output,
   not a long meeting's full segment-list JSON, which is the one output
   here that can plausibly approach it; the helper emits compact JSON, §4,
   to keep this comfortably bounded).
6. Parse stdout as JSON. Malformed JSON, empty output, or a nonzero exit →
   warn, return.
7. Load `meeting_segments` rows for this meeting where `source = 'system'`.
8. Run the assignment algorithm (§7), write `speaker_label` per row.

Every one of steps 2-6's failure branches is a `return`, not a `throw` — the
one `.catch` at the call site in `runTranscribeJob` is a second, redundant
safety net (defense in depth for anything unanticipated), not the primary
error-handling path. The primary path is: every expected failure mode
degrades in-function, silently, to "no labels written, meeting renders as
before."

**`GET /diarization/status`** (`apps/server/src/routes/meetings.ts`,
registered before `/:id` for the same routing reason as `/orphans`):
`{ enabled, status, error? }`, where `status` comes straight from
`probeDiarizationModels()` — `"ready" | "not-ready" | "unavailable" |
"error"`, no persisted module state, re-probed fresh on every call (the
probe is cheap — a local model load, no network). **Amended 2026-08-25**:
`POST /diarization/prepare-models` and the download-orchestration machinery
behind it (`startDiarizationModelDownload`, `getDiarizationModelState`,
`DiarizationModelState`) are removed entirely — pre-bundled models (§4)
leave nothing to trigger a download for.

`POST /:id/retry-failed`: segments re-transcribed through this route are
inserted fresh with `speaker_label = NULL` (the column's default) and are
**not** re-diarized in Phase 1 — the diarization pass runs once, at the end
of the original `runTranscribeJob`, and retry-failed doesn't re-invoke it.
A retried segment renders as plain "Them" alongside its now-labeled
neighbors. This is a known, accepted Phase 1 gap (retries are expected to be
rare — only chunks that hard-failed transcription), not silently broken
behavior; call it out in the PR description.

---

## 10. Failure / degradation matrix

| Failure point | Behavior |
|---|---|
| Settings flag off | Diarization step skipped entirely; zero behavior change from today. |
| Binary missing (build/packaging gap) | Warn logged, step returns, meeting transcribes and renders normally. |
| Models missing from bundle (`getFluidAudioModelsDirPath()` → `null`, or `--probe --models-dir` → `NOT_READY`) | Warn logged, step returns; user sees the settings popover reflect this (§8 — `diarizationUnavailable`/`diarizationNotReady`) so it's not a silent surprise at the settings layer, but a transcribe job that races this state still degrades cleanly. Amended 2026-08-25: this replaces the earlier "model cache not ready (never downloaded)" row — models are pre-bundled (§4), so this can only mean a build/packaging gap, never "the user hasn't downloaded them yet." |
| Helper spawn error (`ENOENT`, permissions) | Caught by `execFile`'s error event, same as `.catch` at the call site; degrades. |
| Helper exits nonzero / `ERR_MODELS_MISSING` / `ERR_DIARIZE_FAILED` | Warn logged with the stderr message, degrades. |
| Helper hangs past timeout | SIGTERM sent, treated as failure, degrades (§11). |
| Malformed/empty JSON on stdout | Warn logged, degrades. |
| Individual whisper segment has no overlapping/nearby diarizer segment | That segment's `speaker_label` stays NULL; renders "Them"; every *other* segment in the same meeting can still be correctly labeled. |
| `POST /:id/retry-failed` produces new segments | Those rows keep `speaker_label = NULL` (not re-diarized in Phase 1); render "Them". |

No failure path in this table ever fails the transcribe job, ever throws
past `runTranscribeJob`, or ever produces a meeting stuck in a non-terminal
status because of diarization specifically.

---

## 11. Performance budget & interaction with whisper-local

**Timeout, not a throughput target.** The enforceable contract for Phase 1 is
a wall-clock timeout on the helper invocation, not a promised
realtime-factor — this spec can state a target but can't verify FluidAudio's
actual throughput on real hardware without running it. Set the timeout at
**meeting duration × 1.0, minimum 120s, no fixed ceiling** — deliberately
generous, biased toward "the pass eventually finishes" over "the pass times
out and the meeting's long-form value (attributing 5 people across 90
minutes) is exactly what gets lost." A too-generous timeout costs one slow
job; a too-tight one silently disables the feature for the meetings it
exists for. **After §12's manual acceptance run produces a real observed
realtime-factor, tighten this formula in a follow-up edit to this spec** —
the ceiling removal above is the safe default until that measurement exists,
not the permanent shape. Exceeding the timeout: SIGTERM, treated as failure
(§10), degrade.

**Interaction with whisper-local's yield policy.** `MeetingTranscriber`'s
`waitForDictationIdle()` (`apps/server/src/lib/meetings/transcriber.ts:418-
436`) exists because whisper-local and live dictation both want the same
constrained resource and can't run well concurrently — but as it stands
today it's a **private method** on `MeetingTranscriber`, not an exported
function `diarize.ts` can import; it closes over instance state
(`this.lastDictationActiveAt`, `this.now()`, `this.sleep()`) and injected
deps (`this.deps.isDictationActive`, sourced from `apps/server/src/lib/
dictation-activity.ts`'s `isDictationActive()`, per `meeting-mode.md`'s file
inventory). The diarization pass, running on ANE via CoreML, wants the same
physical resource (Apple Neural Engine) that whisper-local's Whisper models
also target — so it needs the identical yield behavior, which means an
**extraction, not a reuse-as-is**: lift the idle-wait loop out of
`transcriber.ts` into a standalone exported `waitForDictationIdle(opts:
{ idleMs?: number; pollMs?: number })` in `dictation-activity.ts` (same
module `isDictationActive()` already lives in — it's the natural home for
this cross-cutting "yield to live dictation" primitive), keep its own
closure over last-active-at timing, and have both `MeetingTranscriber`
(unconditionally when `config.providerId === WHISPER_PROVIDER_ID`, as
today) and `runDiarizationPass` (unconditionally, since the diarizer always
runs on-device regardless of which STT provider transcribed the meeting)
call the shared function. Same `dictationIdleResumeMs` default (15s) applies
to both call sites. This is a small, mechanical extraction — behavior-
identical for `transcriber.ts`'s existing call site — not new
yield-detection logic, but it is real code movement and belongs in this
feature's PR, not assumed away.

**Concurrency**: the diarization pass runs strictly after `MeetingTranscriber
.run()` resolves (§9) — it never overlaps with the chunk-transcription worker
pool for the *same* meeting, so there's no new intra-meeting contention to
reason about, only the existing inter-process (dictation vs. meeting-mode)
contention `waitForDictationIdle()` already handles.

---

## 12. Test plan

**Unit — label assignment (`apps/server/tests/meeting-diarize.test.ts`, new
file, pure-function style matching `meeting-merge.test.ts`):**

- Perfect 1:1 overlap → correct label per segment.
- Two diarizer speakers, whisper segment straddling both unevenly → majority-
  overlap winner.
- Exact-tie overlap → midpoint tie-break; symmetric tie → earlier-segment
  tie-break (deterministic, assert exact output, not "either is fine").
- Whisper segment entirely inside a diarizer gap, diarizer segment present
  within the 2000ms window → nearest-neighbor fallback wins.
- Whisper segment with nothing within the window at all → `speaker_label`
  stays `null`, not an arbitrary nearest match outside the window.
- Label numbering follows first-appearance-by-time, not raw `S1`/`S2` order
  — construct a fixture where speaker `S2` speaks first and assert it gets
  `"Them 1"`.
- Single-speaker meeting (diarizer only ever emits one `speakerId`) still
  produces `"Them 1"`, not bare `"Them"` (§7 collapse rule).
- Empty diarizer output (zero segments) → every system row stays `null`.

**Unit — merge/render passthrough (extend `meeting-merge.test.ts`):**

- `TranscriptSegment` with `speakerLabel` set flows through `mergeTranscript`
  into the matching `MergedSegment` unchanged.
- `TranscriptSegment` without `speakerLabel` (undiarized / mic channel)
  produces a `MergedSegment` with `speakerLabel: undefined`, and existing
  assertions on bare `"Me"`/`"Them"` output (lines 15-29) still pass
  unmodified — this is the regression check that proves the type extension
  in §6 didn't touch existing behavior.
- `formatTranscriptMarkdown` renders `"Them 2"` for a segment with
  `speakerLabel: "2"`, and unmodified `"Them"`/`"Me"` for segments without
  one (regression check for §9's markdown-formatter change).

**Integration — schema migration (extend `schema-meetings.test.ts` pattern
from migration 29's own test, applied to migration 30):**

- Fresh DB at version 30 has `meeting_segments.speaker_label` (nullable
  TEXT).
- DB pre-seeded at version 29 with existing rows, migrated to 30 → all
  existing rows have `speaker_label = NULL`, no data loss, no error.

**Integration — pipeline wiring (`apps/server/tests/meeting-diarize-
pipeline.test.ts`, new, injected-deps style matching `meeting-transcriber
.test.ts`):**

- Flag off → `runDiarizationPass` never invoked (spy assertion), all rows
  stay NULL.
- Flag on, binary missing → job completes with status `'transcribed'`,
  no thrown error, all rows stay NULL.
- Flag on, models dir missing from bundle → same degrade, all rows stay
  NULL (amended 2026-08-25 — replaces the earlier "models not downloaded"
  case; pre-bundled models mean this is the only "not ready" case left).
- Flag on, fake binary returns malformed JSON → same degrade, warn logged.
- Flag on, fake binary returns valid JSON → rows get labels, status still
  reaches `'transcribed'`, `writeTranscriptMarkdown` runs after.
- `--models-dir <dir>` is passed on both the `--probe` and the real-run
  invocation (assert the exact `execFile` args).

**Real end-to-end (manual, macOS, matching `meeting-mode.md`'s acceptance-
checklist pattern — add to that checklist, don't duplicate it):**

- [ ] Confirm `npm run compile:native` (or `build:mac`) fetches the models
      into `resources/models/speaker-diarization/` and the packaged app
      ships `<resourcesPath>/models/speaker-diarization/`.
- [ ] Enable `meeting_diarization_enabled`; confirm the toggle flips on
      immediately, no download step, and the setting persists as on.
- [ ] Record a real meeting on speakers with 2-3 distinct system-channel
      voices (e.g. a call with two other participants). Confirm the
      rendered transcript shows "Them 1"/"Them 2" consistently per speaker,
      not flickering between labels for the same person.
- [ ] Record a meeting with exactly one other voice on the system channel.
      Confirm it renders "Them 1", not bare "Them" (§7 collapse rule).
- [ ] Disable the flag, record another meeting, confirm it renders exactly
      the pre-Phase-1 "Them" behavior with no `speaker_label` column
      involvement visible anywhere.
- [ ] Kill the diarization binary path (rename it) with the flag on, record
      a meeting, confirm the meeting still reaches `'transcribed'` and
      renders "Them" with a warning in the server log, not a stuck job.
- [ ] Rename `resources/models/speaker-diarization` (binary present, bundle
      missing) with the flag on, record a meeting, confirm the same clean
      degrade and a "models missing from bundle" warning in the server log.
- [ ] `POST /:id/retry-failed` on a diarized meeting with a genuinely failed
      chunk; confirm the retried segment renders "Them" (not re-diarized)
      while its already-labeled neighbors keep their labels.
- [ ] Record the actual observed diarization wall-clock time vs. meeting
      duration in this file (§11) once measured on real hardware.
- [ ] Confirm the CC-BY-4.0 attribution line + both HuggingFace links render
      correctly in the acknowledgments screen.

---

## 13. File inventory (planned)

New files:
- `apps/electron/native/fluidaudio-diarize/Package.swift`
- `apps/electron/native/fluidaudio-diarize/Sources/main.swift`
- `apps/server/src/lib/meetings/diarize.ts`
- `apps/server/tests/meeting-diarize.test.ts`
- `apps/server/tests/meeting-diarize-pipeline.test.ts`

Modified files:
- `apps/electron/scripts/compile-native.js` — new `compileFluidAudioDiarizer()`
  branch, called from `compileMacOS()`; amended 2026-08-25 with a second new
  `fetchDiarizationModels()` step, also called from `compileMacOS()` (§4).
- `apps/electron/electron-builder.yml` — amended 2026-08-25: new `mac:`
  `extraResources` entry, `resources/models` → `models` (§4).
- `.gitignore` — amended 2026-08-25: `apps/electron/resources/models/`
  (build-time-fetched, same treatment as `resources/bin/`).
- `apps/server/src/lib/schema.ts` — `SCHEMA_VERSION = 30`, migration block.
- `apps/server/src/lib/meetings/merge.ts` — `speakerLabel?: string` on
  `TranscriptSegment` and `MergedSegment`; `formatTranscriptMarkdown` (§9)
  renders `"Them N"` when `speakerLabel` is set.
- `apps/server/src/routes/meetings.ts` — `runDiarizationPass` call site in
  `runTranscribeJob`; `speaker_label` selected in `loadMergedTranscript`.
  `getMeetingDiarizationEnabledSetting()` lives directly in the new
  `diarize.ts`, not bolted onto `language.ts`. Amended 2026-08-25: `GET
  /diarization/status` simplified to a plain probe; `POST
  /diarization/prepare-models` removed (§4/§9).
- `apps/server/src/lib/dictation-activity.ts` — extract `waitForDictationIdle`
  out of `MeetingTranscriber` (§11) into a standalone exported function; both
  `transcriber.ts` and the new `diarize.ts` call it.
- `apps/electron/src/shared/settings-keys.ts` — `meetingDiarizationEnabled`.
- `apps/electron/src/renderer/src/pages/meetings.tsx` — `TranscriptSegment`
  type, renderer ternary fallback (§6), `DiarizationSettingsPopover`
  (settings toggle UI, meeting-scoped rather than the general settings
  page). Amended 2026-08-25: popover simplified to a plain toggle + status
  probe, download-progress UI removed (§8).
- `apps/electron/src/renderer/src/locales/*.json` (7 locales + template) —
  new `meetings.themNumbered` key (§6); `meetings.diarization*` keys for
  the settings popover (§8), amended 2026-08-25 to drop
  `diarizationDownloading`/`diarizationError` and add `diarizationNotReady`.
- App acknowledgments/licenses screen — CC-BY-4.0 credit line.
- `apps/server/tests/meeting-merge.test.ts` — passthrough regression cases.
- `apps/server/tests/schema-meetings.test.ts` — migration 30 coverage.
- `apps/server/tests/meeting-diarize-pipeline.test.ts` — amended 2026-08-25:
  `DiarizeDeps` fixtures include `resolveModelsDirPath`; the "model cache
  not ready" case is now "models missing from bundle"; new case asserting
  `--models-dir` is passed on both invocations (§12).
