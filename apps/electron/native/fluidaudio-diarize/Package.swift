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
