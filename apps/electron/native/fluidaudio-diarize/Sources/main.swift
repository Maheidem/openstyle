/**
 * fluidaudio-diarize
 *
 * CLI helper wrapping FluidAudio's offline speaker-diarization pipeline for
 * Meeting Mode's opt-in system-channel diarization pass
 * (specs/meeting-diarization.md §3-4). Spawned as a bounded run-to-completion
 * process from Node (apps/server/src/lib/meetings/diarize.ts) via
 * child_process.execFile — never long-lived like macos-system-audio.swift.
 *
 * Model bundling (spec §4, amended 2026-08-25): the ~22MB offline model set
 * (four .mlmodelc bundles + plda-parameters.json) ships pre-bundled inside
 * the app (`resources/models/speaker-diarization/`) instead of being
 * downloaded on first opt-in. `--models-dir <path>` points every mode at
 * that bundle directly via `OfflineDiarizerModels.load(from:)` — no
 * FluidAudio cache dir, no network, ever. The old cache-based path (no
 * `--models-dir`) is kept as a fallback for local/dev runs against a
 * developer's `~/Library/Application Support/FluidAudio` cache.
 *
 * Usage:
 *   fluidaudio-diarize --prepare-models [--models-dir <dir>]
 *                                          No-op success when --models-dir
 *                                          is given and populated (models
 *                                          are already bundled — nothing to
 *                                          prepare). Without --models-dir,
 *                                          falls back to downloading the
 *                                          offline model set into
 *                                          FluidAudio's cache dir
 *                                          (network-allowed, idempotent,
 *                                          PROGRESS lines on stderr) — kept
 *                                          for dev/compat, not used by the
 *                                          packaged app.
 *   fluidaudio-diarize --probe [--models-dir <dir>]
 *                                          Reports whether the models are
 *                                          ready to load — from --models-dir
 *                                          when given, else the FluidAudio
 *                                          cache dir. No network either way.
 *                                          Prints READY or NOT_READY to
 *                                          stdout, exits 0 either way.
 *   fluidaudio-diarize <system.wav> [--models-dir <dir>]
 *                                          Runs diarization against the
 *                                          given WAV file. No network
 *                                          (ModelHub.offlineMode = true).
 *                                          Compact JSON segment list on
 *                                          stdout on success.
 *   fluidaudio-diarize --vad <file.wav> --models-dir <dir>
 *                                          Runs the Silero VAD on the WAV
 *                                          file. Loads the model from
 *                                          <dir>/silero-vad/. No network.
 *                                          Prints the speech spans as a
 *                                          compact JSON array
 *                                          [{"startMs":int,"endMs":int}].
 *
 * stderr protocol: `PROGRESS <done> <total>` out-of-band status lines, plus
 * `ERR_MODELS_MISSING` / `ERR_DIARIZE_FAILED <message>` / `ERR_DOWNLOAD
 * <message>` / `ERR_VAD_FAILED <message>` on failure — matching the ERR_* convention used by
 * macos-system-audio.swift / system-audio-capture.ts's line parser.
 *
 * Compile via SwiftPM, not swiftc directly — FluidAudio is a package
 * dependency, not a single-file compile:
 *   swift build -c release --package-path apps/electron/native/fluidaudio-diarize
 */

import CoreML
import FluidAudio
import Foundation

// MARK: - Output helpers

func emitError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func emitStderr(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

/**
 * Local wire type for the diarizer's stdout JSON contract (spec §4).
 *
 * FluidAudio's `TimedSpeakerSegment` carries a raw 256-dim speaker embedding
 * (`embedding: [Float]`) and does not conform to `Codable` — encoding it
 * directly isn't possible, and we wouldn't want the embedding vector in the
 * CLI's JSON payload even if it did (Phase 1 uses no embedding persistence,
 * spec §1 non-goals). This DTO projects onto exactly the four fields the
 * spec's contract promises the Node caller.
 */
struct DiarSegmentOut: Codable {
    let speakerId: String
    let startTimeSeconds: Double
    let endTimeSeconds: Double
    let qualityScore: Double
}

// MARK: - Modes

/// `--models-dir <path>` when present, else nil (falls back to the
/// FluidAudio cache dir). Not a positional argument — parsed out of the full
/// argument list by the entry point below before mode dispatch.
func runPrepareModels(modelsDir: String?) async {
    if let modelsDir {
        // Fully-offline bundle path (spec §4, amended 2026-08-25): the
        // models ship inside the app, nothing to download. Success is a
        // pure existence/loadability check so a corrupted or partial bundle
        // still surfaces as a build/packaging problem instead of silently
        // reporting ready.
        ModelHub.offlineMode = true
        do {
            _ = try await OfflineDiarizerModels.load(from: URL(fileURLWithPath: modelsDir))
            exit(0)
        } catch {
            emitError("ERR_MODELS_MISSING")
            exit(1)
        }
    }

    // Dev/compat fallback: no bundle directory given, download into the
    // FluidAudio cache dir like Phase 1 originally did. Not used by the
    // packaged app (spec §4).
    ModelHub.offlineMode = false
    let progress: ProgressHandler = { snapshot in
        let done = Int((snapshot.fractionCompleted * 100).rounded())
        emitStderr("PROGRESS \(done) 100")
    }
    do {
        // `OfflineDiarizerManager.prepareModels()` doesn't expose a progress
        // callback (deviation, see specs/meeting-diarization.md) — call the
        // lower-level static loader it wraps directly instead, which does.
        _ = try await OfflineDiarizerModels.load(progressHandler: progress)
        exit(0)
    } catch {
        emitError("ERR_DOWNLOAD \(error)")
        exit(1)
    }
}

func runProbe(modelsDir: String?) async {
    // FluidAudio exposes no public, allocation-free cache-completeness check
    // (`ModelCache` is internal to the package) — the only readiness signal
    // available from outside the module that can never drift out of sync
    // with FluidAudio's actual on-disk layout is attempting the real model
    // load with the network disabled. Heavier than a stat() of the expected
    // .mlmodelc bundles (spec §4's original intent), but correct by
    // construction. See specs/meeting-diarization.md deviations.
    ModelHub.offlineMode = true
    do {
        if let modelsDir {
            _ = try await OfflineDiarizerModels.load(from: URL(fileURLWithPath: modelsDir))
        } else {
            _ = try await OfflineDiarizerModels.load()
        }
        print("READY")
        exit(0)
    } catch {
        print("NOT_READY")
        exit(0)
    }
}

func runDiarize(_ path: String, modelsDir: String?) async {
    // No network for the real pass (spec §4, dossier §3.3 Option B): any
    // cache/bundle gap fails fast via ERR_MODELS_MISSING instead of
    // silently blocking on a download mid-transcription-job.
    ModelHub.offlineMode = true
    let url = URL(fileURLWithPath: path)
    // Keep the turns under 1 s (issue #259). The default config drops every
    // output turn shorter than `minSegmentDuration` (1.0 s), so a short reply
    // gets no turn and its row stays unlabeled. In the offline pipeline this
    // value has one more use: the embedding uses the overlap-free mask when
    // that mask has at least this many frames. Every embedding window already
    // needs 20 % active frames (about 2 s of a 10 s window), so the mask
    // choice and the clustering do not change. Measured on 5 meetings: 642 of
    // the 643 turns of 1 s or more are the same; one start moved 85 ms. The
    // server uses the short turns only for labels.
    var config = OfflineDiarizerConfig.default
    config.minSegmentDuration = 0
    let manager = OfflineDiarizerManager(config: config)
    do {
        if let modelsDir {
            // Fully-offline bundle path (spec §4, "Option C"): load the four
            // MLModels + plda-parameters.json directly out of the app's
            // bundled resources dir, no FluidAudio cache dir involved.
            let models = try await OfflineDiarizerModels.load(from: URL(fileURLWithPath: modelsDir))
            manager.initialize(models: models)
        }
        let result = try await manager.process(url) { done, total in
            emitStderr("PROGRESS \(done) \(total)")
        }
        let out = result.segments.map { seg in
            DiarSegmentOut(
                speakerId: seg.speakerId,
                startTimeSeconds: Double(seg.startTimeSeconds),
                endTimeSeconds: Double(seg.endTimeSeconds),
                qualityScore: Double(seg.qualityScore)
            )
        }
        // Compact, not pretty-printed (JSONEncoder default formatting) — the
        // caller parses and discards immediately, spec §4.
        let data = try JSONEncoder().encode(out)
        FileHandle.standardOutput.write(data)
        exit(0)
    } catch let error as DownloadError {
        switch error {
        case .networkDisabled, .modelMissing:
            emitError("ERR_MODELS_MISSING")
        default:
            emitError("ERR_DIARIZE_FAILED \(error)")
        }
        exit(1)
    } catch {
        emitError("ERR_DIARIZE_FAILED \(error)")
        exit(1)
    }
}

// MARK: - VAD mode

/// One speech span of the `--vad` stdout JSON, in ms from the file start.
struct SpeechSpanOut: Codable {
    let startMs: Int
    let endMs: Int
}

/// Silero VAD settings for the meeting ASR gate. The values must satisfy
/// the preconditions of `VadSegmentationConfig.init`. A failed
/// precondition crashes the process, so the values are checked here first.
/// 0.25, not Silero's usual 0.5: the gate only skips chunks with no span,
/// so a low threshold keeps weak speech. The 5578edb0 loop window has no
/// span at any threshold from 0.5 to 0.15 (measured 2026-10-19).
nonisolated(unsafe) var vadThreshold: Float = 0.25
let vadMinSpeechDuration: TimeInterval = 0.15
let vadMinSilenceDuration: TimeInterval = 0.75
let vadMaxSpeechDuration: TimeInterval = 30.0
nonisolated(unsafe) var vadSpeechPadding: TimeInterval = 0.1

func runVad(_ path: String, modelsDir: String?) async {
    // No network. The model must come from the bundled models dir.
    ModelHub.offlineMode = true
    guard let modelsDir else {
        emitError("ERR_VAD_FAILED --vad requires --models-dir <dir>")
        exit(1)
    }
    guard
        vadThreshold >= 0, vadThreshold <= 1,
        vadMinSpeechDuration >= 0, vadMinSilenceDuration >= 0,
        vadMaxSpeechDuration > 0, vadSpeechPadding >= 0,
        vadMinSpeechDuration <= vadMaxSpeechDuration,
        vadMinSilenceDuration <= vadMaxSpeechDuration,
        vadSpeechPadding <= vadMinSpeechDuration
    else {
        emitError("ERR_VAD_FAILED invalid VAD settings")
        exit(1)
    }

    // Load the compiled model directly. VadManager(modelDirectory:) is not
    // used: it appends "Models/" and creates folders, and the app bundle
    // is read-only.
    let modelURL = URL(fileURLWithPath: modelsDir)
        .appendingPathComponent("silero-vad")
        .appendingPathComponent(ModelNames.VAD.sileroVadFile)
    guard FileManager.default.fileExists(atPath: modelURL.path) else {
        emitError("ERR_MODELS_MISSING")
        exit(1)
    }

    do {
        let vadConfig = VadConfig(defaultThreshold: vadThreshold)
        let mlConfig = MLModelConfiguration()
        mlConfig.computeUnits = vadConfig.computeUnits
        let model = try MLModel(contentsOf: modelURL, configuration: mlConfig)
        let manager = VadManager(config: vadConfig, vadModel: model)

        // 16 kHz mono Float32, the format the VAD model expects.
        let samples = try AudioConverter().resampleAudioFile(URL(fileURLWithPath: path))
        let segConfig = VadSegmentationConfig(
            minSpeechDuration: vadMinSpeechDuration,
            minSilenceDuration: vadMinSilenceDuration,
            maxSpeechDuration: vadMaxSpeechDuration,
            speechPadding: vadSpeechPadding
        )
        let segments = try await manager.segmentSpeech(samples, config: segConfig)
        let out = segments.map { seg in
            SpeechSpanOut(
                startMs: Int((seg.startTime * 1000).rounded()),
                endMs: Int((seg.endTime * 1000).rounded())
            )
        }
        let data = try JSONEncoder().encode(out)
        FileHandle.standardOutput.write(data)
        exit(0)
    } catch {
        emitError("ERR_VAD_FAILED \(error)")
        exit(1)
    }
}

// MARK: - Entry point

// `--models-dir <path>` (spec §4) is a flag, not a positional argument —
// pull it out of the full argument list first so it can appear alongside
// any of the three modes below, then dispatch on whatever's left.
var positional: [String] = []
var modelsDir: String?
do {
    // --threshold <0..1> and --padding <seconds> override the VAD defaults
    // (for tuning; the server does not pass them).
    var rest = ArraySlice(CommandLine.arguments.dropFirst())
    while let arg = rest.first {
        rest = rest.dropFirst()
        if arg == "--models-dir" {
            guard let value = rest.first else {
                emitError("ERR_DIARIZE_FAILED --models-dir requires a path argument")
                exit(1)
            }
            rest = rest.dropFirst()
            modelsDir = value
        } else if arg == "--threshold" || arg == "--padding" {
            guard let raw = rest.first, let value = Double(raw) else {
                emitError("ERR_VAD_FAILED \(arg) requires a number")
                exit(1)
            }
            rest = rest.dropFirst()
            if arg == "--threshold" { vadThreshold = Float(value) } else { vadSpeechPadding = value }
        } else {
            positional.append(arg)
        }
    }
}

guard let mode = positional.first else {
    emitError(
        "ERR_DIARIZE_FAILED missing argument: expected --prepare-models, --probe, --vad <wav>, or a path to system.wav"
    )
    exit(1)
}

// A file literally named `main.swift` in an executable target gets an
// implicit top-level async context (SE-0343) — `await` directly, no
// `Task { } + DispatchSemaphore` wrapper needed. That wrapper was tried
// first and deadlocks: blocking the main thread in a raw
// `semaphore_wait_trap` starves Swift Concurrency's cooperative thread pool
// before the enclosing `Task` ever gets a worker thread to run on (verified
// empirically — the process sits at 1 thread forever). Every branch below
// calls `exit()` directly; nothing here needs to return normally.
switch mode {
case "--prepare-models":
    await runPrepareModels(modelsDir: modelsDir)
case "--probe":
    await runProbe(modelsDir: modelsDir)
case "--vad":
    guard positional.count >= 2 else {
        emitError("ERR_VAD_FAILED --vad requires a path to a WAV file")
        exit(1)
    }
    await runVad(positional[1], modelsDir: modelsDir)
default:
    await runDiarize(mode, modelsDir: modelsDir)
}
