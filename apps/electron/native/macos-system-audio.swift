/**
 * macOS System Audio Tap
 *
 * Long-running process that captures ALL system audio output (excluding our
 * own process) via Core Audio process taps (macOS 14.2+ API), converts it to
 * 16 kHz mono signed 16-bit PCM, and streams raw frames to stdout.
 *
 * stdout: raw PCM16 binary frames (16 kHz, mono, little-endian s16)
 * stderr: text protocol lines:
 *   READY                          - capturing started
 *   LEVEL <rms>                    - rms 0..1, roughly every 200ms
 *   SYNC <wallclock_ms> <samples>  - every 60s
 *   OVERRUN <n>                    - ring buffer overrun count
 *   ERR_UNSUPPORTED_OS / ERR_TAP_CREATE <code> / ERR_AGG_CREATE <code> /
 *   ERR_START <code>               - fatal errors, then exit non-zero
 *
 * Compile:
 *   swiftc -O macos-system-audio.swift -o macos-system-audio \
 *     -framework CoreAudio -framework AudioToolbox -framework AVFAudio \
 *     -framework Foundation
 */

@preconcurrency import AVFAudio
import AudioToolbox
import CoreAudio
import Foundation

// MARK: - Output

func emitError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

// MARK: - OS Version Gate

let osVersion = ProcessInfo.processInfo.operatingSystemVersion
guard osVersion.majorVersion > 14
    || (osVersion.majorVersion == 14 && osVersion.minorVersion >= 4)
else {
    emitError("ERR_UNSUPPORTED_OS")
    exit(1)
}

guard #available(macOS 14.2, *) else {
    emitError("ERR_UNSUPPORTED_OS")
    exit(1)
}

// MARK: - Constants

let outputSampleRate: Double = 16000
let bytesPerSample = 2
// ~30 seconds of 16kHz mono s16 audio
let ringCapacity = Int(outputSampleRate) * bytesPerSample * 30  // 960 KB

// MARK: - Ring Buffer (single producer / single consumer)

final class RingBuffer {
    private var buffer: [UInt8]
    private let capacity: Int
    private var head = 0  // write index
    private var tail = 0  // read index
    private let lock = NSLock()
    private(set) var overruns = 0

    init(capacity: Int) {
        self.capacity = capacity
        self.buffer = [UInt8](repeating: 0, count: capacity)
    }

    /// Returns false on overrun (data dropped).
    func write(_ data: UnsafeRawBufferPointer) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let available = capacity - usedLocked()
        guard data.count < available else {
            overruns += 1
            return false
        }
        for byte in data {
            buffer[head] = byte
            head = (head + 1) % capacity
        }
        return true
    }

    func read(maxBytes: Int) -> Data {
        lock.lock()
        defer { lock.unlock() }
        let count = min(maxBytes, usedLocked())
        guard count > 0 else { return Data() }
        var out = Data(capacity: count)
        for _ in 0..<count {
            out.append(buffer[tail])
            tail = (tail + 1) % capacity
        }
        return out
    }

    private func usedLocked() -> Int {
        (head - tail + capacity) % capacity
    }
}

let ring = RingBuffer(capacity: ringCapacity)

// MARK: - Shared State

var tapID = AudioObjectID(kAudioObjectUnknown)
var aggregateID = AudioObjectID(kAudioObjectUnknown)
var ioProcID: AudioDeviceIOProcID?
var running = true
var totalSamplesWritten: Int64 = 0
var lastReportedOverruns = 0

// Level metering (updated from the converter path)
let levelLock = NSLock()
var levelSumSquares: Double = 0
var levelSampleCount: Int = 0

// MARK: - Cleanup

func teardown() {
    running = false
    if aggregateID != kAudioObjectUnknown {
        if let procID = ioProcID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            ioProcID = nil
        }
        AudioHardwareDestroyAggregateDevice(aggregateID)
        aggregateID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
        AudioHardwareDestroyProcessTap(tapID)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }
}

// MARK: - Signal Handling

var signalSources: [DispatchSourceSignal] = []

func setupSignalHandlers() {
    let signals: [Int32] = [SIGTERM, SIGINT]

    for sig in signals {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            teardown()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
}

// MARK: - Own Process Object ID

func translatePIDToProcessObject(_ pid: pid_t) -> AudioObjectID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var inputPID = pid
    var objectID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = withUnsafePointer(to: &inputPID) { pidPtr in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            UInt32(MemoryLayout<pid_t>.size),
            pidPtr,
            &size,
            &objectID
        )
    }
    guard status == noErr else { return AudioObjectID(kAudioObjectUnknown) }
    return objectID
}

// MARK: - Main Capture Setup

setupSignalHandlers()

// Create a stereo global tap excluding our own process. We downmix to mono
// during the 16kHz conversion step.
let excluded: [AudioObjectID] = {
    let ownObjectID = translatePIDToProcessObject(getpid())
    guard ownObjectID != kAudioObjectUnknown else { return [] }
    return [ownObjectID]
}()

let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
tapDescription.name = "OpenstyleSystemAudioTap"
tapDescription.isPrivate = true

var tapStatus = AudioHardwareCreateProcessTap(tapDescription, &tapID)
guard tapStatus == noErr, tapID != kAudioObjectUnknown else {
    emitError("ERR_TAP_CREATE \(tapStatus)")
    exit(2)
}

// Aggregate device containing ONLY the tap (no physical output sub-device;
// including one causes echo).
let aggregateUID = UUID().uuidString
let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "OpenstyleSystemAudioAggregate",
    kAudioAggregateDeviceUIDKey: aggregateUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceSubDeviceListKey: [] as [[String: Any]],
    kAudioAggregateDeviceTapListKey: [
        [
            kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
            kAudioSubTapDriftCompensationKey: true,
        ]
    ],
]

let aggStatus = AudioHardwareCreateAggregateDevice(
    aggregateDescription as CFDictionary,
    &aggregateID
)
guard aggStatus == noErr, aggregateID != kAudioObjectUnknown else {
    emitError("ERR_AGG_CREATE \(aggStatus)")
    teardown()
    exit(2)
}

// Read the tap's stream format so we can build an AVAudioConverter.
var tapFormat = AudioStreamBasicDescription()
var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var formatAddress = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
let formatStatus = AudioObjectGetPropertyData(
    tapID,
    &formatAddress,
    0,
    nil,
    &formatSize,
    &tapFormat
)
guard formatStatus == noErr else {
    emitError("ERR_TAP_CREATE \(formatStatus)")
    teardown()
    exit(2)
}

guard let inputFormat = AVAudioFormat(streamDescription: &tapFormat) else {
    emitError("ERR_TAP_CREATE -1")
    teardown()
    exit(2)
}

guard
    let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: outputSampleRate,
        channels: 1,
        interleaved: true
    ),
    let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
else {
    emitError("ERR_TAP_CREATE -2")
    teardown()
    exit(2)
}
converter.downmix = true

// Serial queue for conversion so the realtime IO thread stays light.
let convertQueue = DispatchQueue(label: "system-audio.convert")

func handleCapturedBuffer(_ inBuffer: AVAudioPCMBuffer) {
    let ratio = outputSampleRate / inBuffer.format.sampleRate
    let outCapacity = AVAudioFrameCount(Double(inBuffer.frameLength) * ratio) + 64
    guard
        let outBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: outCapacity
        )
    else { return }

    var consumed = false
    var convError: NSError?
    let status = converter.convert(to: outBuffer, error: &convError) { _, outStatus in
        if consumed {
            outStatus.pointee = .noDataNow
            return nil
        }
        consumed = true
        outStatus.pointee = .haveData
        return inBuffer
    }
    guard status != .error, convError == nil else { return }
    guard outBuffer.frameLength > 0, let samples = outBuffer.int16ChannelData else {
        return
    }

    let frameCount = Int(outBuffer.frameLength)
    let channel = samples[0]

    // Level metering
    var sumSquares: Double = 0
    for i in 0..<frameCount {
        let normalized = Double(channel[i]) / 32768.0
        sumSquares += normalized * normalized
    }
    levelLock.lock()
    levelSumSquares += sumSquares
    levelSampleCount += frameCount
    levelLock.unlock()

    // Push into the ring buffer for the writer thread
    let byteCount = frameCount * bytesPerSample
    channel.withMemoryRebound(to: UInt8.self, capacity: byteCount) { bytePtr in
        let raw = UnsafeRawBufferPointer(start: bytePtr, count: byteCount)
        if !ring.write(raw) {
            let n = ring.overruns
            if n != lastReportedOverruns {
                lastReportedOverruns = n
                emitError("OVERRUN \(n)")
            }
        }
    }
    OSAtomicAdd64(Int64(frameCount), &totalSamplesWritten)
}

// MARK: - IO Proc

let ioStatus = AudioDeviceCreateIOProcIDWithBlock(
    &ioProcID,
    aggregateID,
    nil
) { _, inInputData, _, _, _ in
    guard running else { return }
    let bufferList = inInputData.pointee
    guard bufferList.mNumberBuffers > 0 else { return }

    // Copy the input data off the realtime thread, then convert async.
    let frames = AVAudioFrameCount(
        bufferList.mBuffers.mDataByteSize
            / max(1, tapFormat.mBytesPerFrame)
    )
    guard frames > 0,
        let copy = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames)
    else { return }
    copy.frameLength = frames

    let src = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: inInputData)
    )
    let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for i in 0..<min(src.count, dst.count) {
        let byteCount = min(src[i].mDataByteSize, dst[i].mDataByteSize)
        if let srcData = src[i].mData, let dstData = dst[i].mData {
            memcpy(dstData, srcData, Int(byteCount))
            dst[i].mDataByteSize = byteCount
        }
    }

    convertQueue.async {
        handleCapturedBuffer(copy)
    }
}
guard ioStatus == noErr, ioProcID != nil else {
    emitError("ERR_START \(ioStatus)")
    teardown()
    exit(3)
}

let startStatus = AudioDeviceStart(aggregateID, ioProcID)
guard startStatus == noErr else {
    emitError("ERR_START \(startStatus)")
    teardown()
    exit(3)
}

emitError("READY")

// MARK: - Writer Thread (ring buffer -> stdout)

let writerThread = Thread {
    let stdoutHandle = FileHandle.standardOutput
    while running {
        let chunk = ring.read(maxBytes: 32768)
        if chunk.isEmpty {
            usleep(20_000)  // 20ms
            continue
        }
        stdoutHandle.write(chunk)
    }
}
writerThread.name = "system-audio.writer"
writerThread.start()

// MARK: - Periodic Reporting

let levelTimer = DispatchSource.makeTimerSource(queue: .main)
levelTimer.schedule(deadline: .now() + 0.2, repeating: 0.2)
levelTimer.setEventHandler {
    levelLock.lock()
    let sumSquares = levelSumSquares
    let count = levelSampleCount
    levelSumSquares = 0
    levelSampleCount = 0
    levelLock.unlock()

    let rms = count > 0 ? (sumSquares / Double(count)).squareRoot() : 0
    emitError(String(format: "LEVEL %.6f", rms))
}
levelTimer.resume()

let syncTimer = DispatchSource.makeTimerSource(queue: .main)
syncTimer.schedule(deadline: .now() + 60, repeating: 60)
syncTimer.setEventHandler {
    let wallclockMs = Int64(Date().timeIntervalSince1970 * 1000)
    emitError("SYNC \(wallclockMs) \(totalSamplesWritten)")
}
syncTimer.resume()

CFRunLoopRun()
