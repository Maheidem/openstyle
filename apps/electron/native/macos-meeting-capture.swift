/**
 * macOS Meeting Capture (mic + system audio on one clock)
 *
 * Long-running process. It captures the microphone and all system audio
 * (without our own process) with ONE Core Audio aggregate device. The
 * aggregate device holds two inputs: the chosen mic as a sub-device and a
 * process tap. The mic is the main (clock) sub-device. The tap uses drift
 * compensation. One IOProc receives both inputs on the same clock. The
 * helper converts each input to 16 kHz mono signed 16-bit PCM.
 *
 * Arguments:
 *   --mic default           use the macOS default input device
 *   --mic-name "<name>"     use the input device with this name. An exact
 *                           name wins. Else the names must match after the
 *                           helper drops a "Default - " prefix and trailing
 *                           "(...)" tags like "(Built-in)". If no single
 *                           device matches, print ERR_MIC_NOT_FOUND and exit.
 *                           The helper never uses another mic in silence.
 *
 * stdout: binary frames. Each frame is:
 *   1 byte   channel: 'M' = mic, 'S' = system audio
 *   4 bytes  payload length, uint32, little-endian
 *   N bytes  payload: PCM16, little-endian, mono, 16 kHz
 *
 * stderr: text protocol lines:
 *   DEVICE <uid> <name>            - the mic that was opened
 *   READY                          - capturing started
 *   LEVEL <rms>                    - system audio, rms 0..1, every 200 ms
 *   LEVEL_MIC <rms>                - mic, rms 0..1, every 200 ms
 *   SYNC <wallclock_ms> <mic_samples> <system_samples>
 *                                  - at the first IOProc call (samples 0 0),
 *                                    then every 60 s, and after a rebuild.
 *                                    The counts are 16 kHz samples that the
 *                                    helper produced for each channel.
 *   OVERRUN <n>                    - ring buffer dropped n frames
 *   ERR_MIC_LOST                   - the mic went away while running. The
 *                                    helper rebuilds the aggregate device
 *                                    without the mic. The S channel goes on.
 *   ERR_UNSUPPORTED_OS / ERR_ARGS / ERR_MIC_NOT_AVAILABLE /
 *   ERR_MIC_NOT_FOUND <name> / ERR_MIC_FORMAT / ERR_TAP_CREATE <code> /
 *   ERR_AGG_CREATE <code> / ERR_AGG_STREAMS <count> /
 *   ERR_FORMAT_UNSTABLE / ERR_START <code>
 *                                  - fatal errors, then exit non-zero
 *
 * Compile:
 *   swiftc -O macos-meeting-capture.swift -o macos-meeting-capture \
 *     -target arm64-apple-macos14.2 \
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
// About 30 seconds of 16 kHz mono s16 audio for each of the two channels.
let ringCapacity = Int(outputSampleRate) * bytesPerSample * 30 * 2
let micTag: UInt8 = 0x4D  // 'M'
let systemTag: UInt8 = 0x53  // 'S'

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

    /// Writes all bytes or none. Returns false on overrun (data dropped).
    /// A caller writes one whole frame in one call, so frames never split.
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

    /// Drops all queued bytes. Call only when no IO runs and no reader runs.
    func clear() {
        lock.lock()
        defer { lock.unlock() }
        head = 0
        tail = 0
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

// MARK: - Channel Pipe (convert, meter, frame)

// Serial queue for conversion so the realtime IO thread stays light. Both
// channels use this one queue, so frames of the two channels never mix
// inside the ring buffer.
let convertQueue = DispatchQueue(label: "meeting-capture.convert")
var lastReportedOverruns = 0

final class ChannelPipe {
    let tag: UInt8
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var levelSumSquares: Double = 0
    private var levelSampleCount: Int = 0
    private var produced: Int64 = 0

    init(tag: UInt8) {
        self.tag = tag
    }

    /// Call only when no IO runs and the convert queue is empty.
    func configure(inputFormat: AVAudioFormat) -> Bool {
        guard
            let out = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: outputSampleRate,
                channels: 1,
                interleaved: true
            ),
            let conv = AVAudioConverter(from: inputFormat, to: out)
        else { return false }
        if inputFormat.channelCount > 1 {
            conv.downmix = true
        }
        converter = conv
        outputFormat = out
        return true
    }

    /// Forget the counts and the level. Call only when no IO runs.
    func reset() {
        lock.lock()
        defer { lock.unlock() }
        produced = 0
        levelSumSquares = 0
        levelSampleCount = 0
    }

    func sampleCount() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return produced
    }

    /// Returns the rms since the last call, 0..1.
    func takeLevel() -> Double {
        lock.lock()
        defer { lock.unlock() }
        let rms =
            levelSampleCount > 0
            ? (levelSumSquares / Double(levelSampleCount)).squareRoot() : 0
        levelSumSquares = 0
        levelSampleCount = 0
        return rms
    }

    /// Runs on the convert queue.
    func handle(_ inBuffer: AVAudioPCMBuffer) {
        guard let converter = converter, let outputFormat = outputFormat else { return }
        // A buffer from an older aggregate device has another format. Skip it.
        guard inBuffer.format == converter.inputFormat else { return }

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
        lock.lock()
        levelSumSquares += sumSquares
        levelSampleCount += frameCount
        produced += Int64(frameCount)
        lock.unlock()

        // Build one frame: tag, length (uint32 LE), PCM16 payload.
        let byteCount = frameCount * bytesPerSample
        var frame = [UInt8]()
        frame.reserveCapacity(5 + byteCount)
        frame.append(tag)
        var length = UInt32(byteCount).littleEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        channel.withMemoryRebound(to: UInt8.self, capacity: byteCount) { bytePtr in
            frame.append(contentsOf: UnsafeBufferPointer(start: bytePtr, count: byteCount))
        }
        let written = frame.withUnsafeBytes { ring.write($0) }
        if !written {
            let n = ring.overruns
            if n != lastReportedOverruns {
                lastReportedOverruns = n
                emitError("OVERRUN \(n)")
            }
        }
    }
}

let micPipe = ChannelPipe(tag: micTag)
let systemPipe = ChannelPipe(tag: systemTag)

// MARK: - Shared State

var tapID = AudioObjectID(kAudioObjectUnknown)
var aggregateID = AudioObjectID(kAudioObjectUnknown)
var ioProcID: AudioDeviceIOProcID?
var running = true

// Set by startAggregate. The IOProc reads them. They change only while no IO runs.
var micActive = false
var micFormat: AVAudioFormat?
var micBytesPerFrame: UInt32 = 0
var systemFormat: AVAudioFormat?
var systemBytesPerFrame: UInt32 = 0
var needSync = false

// Mic that this run opened.
var micDeviceUID = ""
var micLost = false

// MARK: - Core Audio Property Helpers

func propertyAddress(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
}

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = propertyAddress(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    guard status == noErr, let cfString = value else { return nil }
    return cfString.takeRetainedValue() as String
}

func allDeviceIDs() -> [AudioObjectID] {
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard
        AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size) == noErr,
        size > 0
    else { return [] }
    var ids = [AudioObjectID](
        repeating: AudioObjectID(kAudioObjectUnknown),
        count: Int(size) / MemoryLayout<AudioObjectID>.size
    )
    guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &ids) == noErr
    else { return [] }
    return ids
}

func inputStreamIDs(_ device: AudioObjectID) -> [AudioStreamID] {
    var address = propertyAddress(
        kAudioDevicePropertyStreams,
        scope: kAudioObjectPropertyScopeInput
    )
    var size: UInt32 = 0
    guard
        AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr,
        size > 0
    else { return [] }
    var ids = [AudioStreamID](
        repeating: AudioStreamID(kAudioObjectUnknown),
        count: Int(size) / MemoryLayout<AudioStreamID>.size
    )
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &ids) == noErr
    else { return [] }
    return ids
}

func inputStreamFormats(_ device: AudioObjectID) -> [AudioStreamBasicDescription] {
    var formats: [AudioStreamBasicDescription] = []
    for stream in inputStreamIDs(device) {
        var address = propertyAddress(kAudioStreamPropertyVirtualFormat)
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        // A skipped stream would shift the stream order. Report no formats.
        guard AudioObjectGetPropertyData(stream, &address, 0, nil, &size, &format) == noErr
        else { return [] }
        formats.append(format)
    }
    return formats
}

func defaultInputDevice() -> AudioObjectID {
    var address = propertyAddress(kAudioHardwarePropertyDefaultInputDevice)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &device) == noErr
    else { return AudioObjectID(kAudioObjectUnknown) }
    return device
}

func deviceForUID(_ uid: String) -> AudioObjectID {
    var address = propertyAddress(kAudioHardwarePropertyTranslateUIDToDevice)
    var qualifier = uid as CFString
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = withUnsafePointer(to: &qualifier) { qualifierPtr in
        AudioObjectGetPropertyData(
            systemObject,
            &address,
            UInt32(MemoryLayout<CFString>.size),
            qualifierPtr,
            &size,
            &device
        )
    }
    guard status == noErr else { return AudioObjectID(kAudioObjectUnknown) }
    return device
}

func deviceIsAlive(_ device: AudioObjectID) -> Bool {
    var address = propertyAddress(kAudioDevicePropertyDeviceIsAlive)
    var alive: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &alive) == noErr
    else { return false }
    return alive != 0
}

// MARK: - Mic Choice

struct MicChoice {
    let id: AudioObjectID
    let uid: String
    let name: String
}

func micChoice(for device: AudioObjectID) -> MicChoice? {
    guard device != AudioObjectID(kAudioObjectUnknown),
        !inputStreamIDs(device).isEmpty,
        let uid = stringProperty(device, kAudioDevicePropertyDeviceUID)
    else { return nil }
    let name = stringProperty(device, kAudioObjectPropertyName) ?? uid
    return MicChoice(id: device, uid: uid, name: name)
}

/// Drops a "Default - " prefix and trailing "(...)" tags, like "(Built-in)".
/// Chromium can add them to the Core Audio name.
func normalizedMicName(_ name: String) -> String {
    var text = name.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("Default - ") { text = String(text.dropFirst("Default - ".count)) }
    while text.hasSuffix(")"), let open = text.lastIndex(of: "(") {
        let head = String(text[..<open]).trimmingCharacters(in: .whitespaces)
        if head.isEmpty { break }
        text = head
    }
    return text
}

/// `name == nil` means the macOS default input. A name must match one input
/// device. No match, or more than one match (for example two identical USB
/// mics), prints ERR_MIC_NOT_FOUND and exits. The app then uses its old path
/// with the exact device id.
func chooseMic(name: String?) -> MicChoice? {
    guard let wanted = name else { return micChoice(for: defaultInputDevice()) }
    let choices = allDeviceIDs().compactMap { micChoice(for: $0) }
    var matches = choices.filter { $0.name == wanted }
    if matches.isEmpty {
        let wantedNormalized = normalizedMicName(wanted)
        matches = choices.filter { normalizedMicName($0.name) == wantedNormalized }
    }
    guard matches.count == 1 else {
        emitError("ERR_MIC_NOT_FOUND \(wanted.replacingOccurrences(of: "\n", with: " "))")
        exit(2)
    }
    return matches[0]
}

// MARK: - Arguments

/// Returns the wanted mic name, or nil for the default input.
func parseArguments() -> String? {
    var args = Array(CommandLine.arguments.dropFirst())
    var name: String?
    while !args.isEmpty {
        let arg = args.removeFirst()
        switch arg {
        case "--mic":
            guard !args.isEmpty, args.removeFirst() == "default" else {
                emitError("ERR_ARGS")
                exit(64)
            }
        case "--mic-name":
            guard !args.isEmpty else {
                emitError("ERR_ARGS")
                exit(64)
            }
            let value = args.removeFirst()
            guard !value.isEmpty else {
                emitError("ERR_ARGS")
                exit(64)
            }
            name = value
        default:
            emitError("ERR_ARGS")
            exit(64)
        }
    }
    // No argument at all also means the default input.
    return name
}

// MARK: - Cleanup

/// Stops IO and destroys the aggregate device. The tap stays.
func stopAggregate() {
    if aggregateID != kAudioObjectUnknown {
        if let procID = ioProcID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            ioProcID = nil
        }
        AudioHardwareDestroyAggregateDevice(aggregateID)
        aggregateID = AudioObjectID(kAudioObjectUnknown)
    }
    // Let queued conversions end before a caller changes the formats.
    convertQueue.sync {}
}

func teardown() {
    running = false
    stopAggregate()
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

// MARK: - SYNC

func emitSync(wallclockMs: Int64) {
    emitError("SYNC \(wallclockMs) \(micPipe.sampleCount()) \(systemPipe.sampleCount())")
}

func nowMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
}

// MARK: - Aggregate Device

/// Copies one IOProc input buffer off the realtime thread.
func copyInput(
    _ source: AudioBuffer,
    format: AVAudioFormat,
    bytesPerFrame: UInt32
) -> AVAudioPCMBuffer? {
    guard bytesPerFrame > 0 else { return nil }
    let frames = AVAudioFrameCount(source.mDataByteSize / bytesPerFrame)
    guard frames > 0,
        let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
        let srcData = source.mData
    else { return nil }
    copy.frameLength = frames
    let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    guard dst.count > 0, let dstData = dst[0].mData else { return nil }
    let byteCount = min(source.mDataByteSize, dst[0].mDataByteSize)
    memcpy(dstData, srcData, Int(byteCount))
    dst[0].mDataByteSize = byteCount
    return copy
}

func audioFormat(_ description: AudioStreamBasicDescription) -> AVAudioFormat? {
    var copy = description
    // The IOProc copies one buffer per stream. That needs interleaved data.
    guard copy.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 else { return nil }
    return AVAudioFormat(streamDescription: &copy)
}

/// Creates the aggregate device, sets up the converters, starts the IOProc.
/// `micUID == nil` builds a tap-only aggregate (used after a mic loss).
/// Returns 0 on success, or the exit code for a fatal error.
func startAggregate(micUID: String?) -> Int32 {
    let aggregateUID = UUID().uuidString
    var subDevices: [[String: Any]] = []
    if let uid = micUID {
        subDevices.append([
            kAudioSubDeviceUIDKey: uid,
            // The mic is the clock. It needs no drift compensation.
            kAudioSubDeviceDriftCompensationKey: 0,
        ])
    }
    var description: [String: Any] = [
        kAudioAggregateDeviceNameKey: "OpenstyleMeetingAggregate",
        kAudioAggregateDeviceUIDKey: aggregateUID,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceSubDeviceListKey: subDevices,
        kAudioAggregateDeviceTapListKey: [
            [
                kAudioSubTapUIDKey: tapDescriptionUUID,
                kAudioSubTapDriftCompensationKey: true,
            ]
        ],
    ]
    if let uid = micUID {
        // The mic is the time source of the aggregate device.
        description[kAudioAggregateDeviceMainSubDeviceKey] = uid
    }

    let aggStatus = AudioHardwareCreateAggregateDevice(
        description as CFDictionary,
        &aggregateID
    )
    guard aggStatus == noErr, aggregateID != kAudioObjectUnknown else {
        emitError("ERR_AGG_CREATE \(aggStatus)")
        return 2
    }

    // Order of the input streams: the sub-device streams first, the tap last.
    // The aggregate device needs a short time to show all streams.
    let expectedStreams = micUID == nil ? 1 : 2
    var formats = inputStreamFormats(aggregateID)
    var polls = 0
    while formats.count < expectedStreams && polls < 40 {
        usleep(50_000)  // 50ms, up to 2s in all
        formats = inputStreamFormats(aggregateID)
        polls += 1
    }
    guard formats.count >= expectedStreams, let systemDescription = formats.last else {
        emitError("ERR_AGG_STREAMS \(formats.count)")
        return 2
    }

    guard let systemInput = audioFormat(systemDescription),
        systemDescription.mBytesPerFrame > 0,
        systemPipe.configure(inputFormat: systemInput)
    else {
        emitError("ERR_TAP_CREATE -2")
        return 2
    }
    systemFormat = systemInput
    systemBytesPerFrame = systemDescription.mBytesPerFrame

    if micUID != nil {
        guard let micInput = audioFormat(formats[0]),
            formats[0].mBytesPerFrame > 0,
            micPipe.configure(inputFormat: micInput)
        else {
            emitError("ERR_MIC_FORMAT")
            return 2
        }
        micFormat = micInput
        micBytesPerFrame = formats[0].mBytesPerFrame
        micActive = true
    } else {
        micFormat = nil
        micActive = false
    }

    needSync = true
    let ioStatus = AudioDeviceCreateIOProcIDWithBlock(
        &ioProcID,
        aggregateID,
        nil
    ) { _, inInputData, _, _, _ in
        guard running else { return }
        let list = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inInputData)
        )
        // With a mic, the list holds the mic streams, then the tap. A shorter
        // list would label the mic buffer as the system channel.
        guard list.count >= (micActive ? 2 : 1) else { return }

        // The first call marks T0 for both channels. The SYNC line runs on the
        // convert queue, so its counts cover all earlier buffers.
        if needSync {
            needSync = false
            let firstCallMs = nowMs()
            convertQueue.async { emitSync(wallclockMs: firstCallMs) }
        }

        // Copy the input data off the realtime thread, then convert async.
        if micActive, let format = micFormat,
            let copy = copyInput(list[0], format: format, bytesPerFrame: micBytesPerFrame)
        {
            convertQueue.async { micPipe.handle(copy) }
        }
        if let format = systemFormat,
            let copy = copyInput(
                list[list.count - 1],
                format: format,
                bytesPerFrame: systemBytesPerFrame
            )
        {
            convertQueue.async { systemPipe.handle(copy) }
        }
    }
    guard ioStatus == noErr, ioProcID != nil else {
        emitError("ERR_START \(ioStatus)")
        return 3
    }

    let startStatus = AudioDeviceStart(aggregateID, ioProcID)
    guard startStatus == noErr else {
        emitError("ERR_START \(startStatus)")
        return 3
    }
    return 0
}

// MARK: - Format Check

func sameFormat(_ a: AudioStreamBasicDescription, _ b: AudioStreamBasicDescription) -> Bool {
    a.mSampleRate == b.mSampleRate && a.mChannelsPerFrame == b.mChannelsPerFrame
        && a.mBytesPerFrame == b.mBytesPerFrame
}

/// A Bluetooth headset can change its sample rate when input starts. The
/// IOProc copies bytes with the format that startAggregate read, so a changed
/// format would give audio at the wrong speed. Wait a short time, then read
/// the formats again and compare them.
func formatsAreStable() -> Bool {
    usleep(300_000)
    let now = inputStreamFormats(aggregateID)
    let expectedStreams = micActive ? 2 : 1
    guard now.count >= expectedStreams, let last = now.last,
        let system = systemFormat,
        sameFormat(last, system.streamDescription.pointee)
    else { return false }
    if micActive {
        guard let mic = micFormat, sameFormat(now[0], mic.streamDescription.pointee)
        else { return false }
    }
    return true
}

/// Starts the aggregate device and checks that the formats stay the same.
/// If they change, it builds the device again with the new formats. Frames
/// that were made with the old formats are dropped (no reader runs yet).
func startAggregateStable(micUID: String?) -> Int32 {
    var code = startAggregate(micUID: micUID)
    var attempt = 0
    while code == 0 && !formatsAreStable() {
        attempt += 1
        if attempt > 2 {
            emitError("ERR_FORMAT_UNSTABLE")
            return 2
        }
        stopAggregate()
        ring.clear()
        micPipe.reset()
        systemPipe.reset()
        code = startAggregate(micUID: micUID)
    }
    return code
}

// MARK: - Mic Loss

func handleMicLoss() {
    guard !micLost else { return }
    micLost = true
    emitError("ERR_MIC_LOST")
    // The mic was the clock. Build a new aggregate device with the tap only,
    // so the system channel goes on. The new SYNC line marks the new start.
    stopAggregate()
    let status = startAggregate(micUID: nil)
    if status != 0 {
        teardown()
        exit(status)
    }
}

func checkMicStillPresent() {
    guard micActive, !micLost else { return }
    let device = deviceForUID(micDeviceUID)
    if device == AudioObjectID(kAudioObjectUnknown) || !deviceIsAlive(device) {
        handleMicLoss()
    }
}

func watchMic(_ device: AudioObjectID) {
    var aliveAddress = propertyAddress(kAudioDevicePropertyDeviceIsAlive)
    AudioObjectAddPropertyListenerBlock(device, &aliveAddress, DispatchQueue.main) { _, _ in
        checkMicStillPresent()
    }
    var devicesAddress = propertyAddress(kAudioHardwarePropertyDevices)
    AudioObjectAddPropertyListenerBlock(systemObject, &devicesAddress, DispatchQueue.main) {
        _, _ in
        checkMicStillPresent()
    }
}

// MARK: - Main Capture Setup

setupSignalHandlers()

let wantedMicName = parseArguments()

guard let mic = chooseMic(name: wantedMicName) else {
    emitError("ERR_MIC_NOT_AVAILABLE")
    exit(2)
}
micDeviceUID = mic.uid

// Create a stereo global tap excluding our own process. We downmix to mono
// during the 16 kHz conversion step.
let excluded: [AudioObjectID] = {
    let ownObjectID = translatePIDToProcessObject(getpid())
    guard ownObjectID != kAudioObjectUnknown else { return [] }
    return [ownObjectID]
}()

let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
tapDescription.name = "OpenstyleMeetingTap"
tapDescription.isPrivate = true
let tapDescriptionUUID = tapDescription.uuid.uuidString

let tapStatus = AudioHardwareCreateProcessTap(tapDescription, &tapID)
guard tapStatus == noErr, tapID != kAudioObjectUnknown else {
    emitError("ERR_TAP_CREATE \(tapStatus)")
    exit(2)
}

let startCode = startAggregateStable(micUID: mic.uid)
guard startCode == 0 else {
    teardown()
    exit(startCode)
}

emitError("DEVICE \(mic.uid) \(mic.name.replacingOccurrences(of: "\n", with: " "))")
emitError("READY")
watchMic(mic.id)

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
writerThread.name = "meeting-capture.writer"
writerThread.start()

// MARK: - Periodic Reporting

let levelTimer = DispatchSource.makeTimerSource(queue: .main)
levelTimer.schedule(deadline: .now() + 0.2, repeating: 0.2)
levelTimer.setEventHandler {
    emitError(String(format: "LEVEL %.6f", systemPipe.takeLevel()))
    if micActive {
        emitError(String(format: "LEVEL_MIC %.6f", micPipe.takeLevel()))
    }
}
levelTimer.resume()

let syncTimer = DispatchSource.makeTimerSource(queue: .main)
syncTimer.schedule(deadline: .now() + 60, repeating: 60)
syncTimer.setEventHandler {
    // Run on the convert queue so the counts match the time stamp.
    convertQueue.async { emitSync(wallclockMs: nowMs()) }
}
syncTimer.resume()

CFRunLoopRun()
