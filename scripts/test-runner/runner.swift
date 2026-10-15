import Foundation

struct Job: Decodable {
    let cwd: String
    let argv: [String]
    let env: [String: String]
}

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write(Data("Usage: openstyle-test-runner <jobDir>\n".utf8))
    exit(127)
}
let jobDir = URL(fileURLWithPath: args[1], isDirectory: true)
let stderrURL = jobDir.appendingPathComponent("stderr.log")
let exitURL = jobDir.appendingPathComponent("exit-code")

do {
    let data = try Data(contentsOf: jobDir.appendingPathComponent("job.json"))
    let job = try JSONDecoder().decode(Job.self, from: data)
    var isDirectory: ObjCBool = false
    guard !job.cwd.isEmpty,
          FileManager.default.fileExists(atPath: job.cwd, isDirectory: &isDirectory),
          isDirectory.boolValue else {
        throw NSError(domain: "TestRunner", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Missing cwd: \(job.cwd)"])
    }
    guard let command = job.argv.first, !command.isEmpty else {
        throw NSError(domain: "TestRunner", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "argv must contain a command"])
    }
    let stdoutURL = jobDir.appendingPathComponent("stdout.log")
    try Data().write(to: stdoutURL)
    try Data().write(to: stderrURL)
    let stdout = try FileHandle(forWritingTo: stdoutURL)
    let stderr = try FileHandle(forWritingTo: stderrURL)
    defer {
        try? stdout.close()
        try? stderr.close()
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["--"] + job.argv
    process.currentDirectoryURL = URL(fileURLWithPath: job.cwd, isDirectory: true)
    process.environment = job.env
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()
    let code = process.terminationStatus
    try Data("\(code)\n".utf8).write(to: exitURL)
    exit(code)
} catch {
    let message = Data("\(error.localizedDescription)\n".utf8)
    try? message.write(to: stderrURL)
    try? Data("127\n".utf8).write(to: exitURL)
    exit(127)
}
