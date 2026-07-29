// NodeLocatorSystem — the real-world Probe for NodeLocator.
//
// Kept apart from the resolver so the search order stays pure and testable:
// everything that touches the filesystem or spawns a process is here.

import Foundation

extension NodeLocator {

    /// Probe wired to the real machine. `prefValue` is read from the prefs file
    /// unless the caller supplies one (tests, callers with prefs already loaded).
    public static func systemProbe(environment: [String: String] = ProcessInfo.processInfo.environment,
                                   home: String? = nil,
                                   prefValue: String? = nil,
                                   shellTimeout: TimeInterval = 3.0) -> Probe {
        let fm = FileManager.default
        let base = home ?? fm.homeDirectoryForCurrentUser.path
        let pref = prefValue ?? PrefsLocator.stringPref("node_path", home: base)
        return Probe(
            home: base,
            envOverride: environment["FORGE_NODE_PATH"],
            prefValue: pref,
            pathVar: environment["PATH"] ?? "",
            isExecutable: { fm.isExecutableFile(atPath: $0) },
            listDir: { (try? fm.contentsOfDirectory(atPath: $0)) ?? [] },
            readFile: { try? String(contentsOfFile: $0, encoding: .utf8) },
            loginShell: { loginShellNode(environment: environment, timeout: shellTimeout) }
        )
    }

    /// `$SHELL -lic 'command -v node'` — the only thing that reliably resolves a
    /// version manager installed purely through an rc file.
    ///
    /// Interactive (`-i`) as well as login (`-l`): nvm's snippet lives in
    /// ~/.zshrc on a lot of machines, which a login-only zsh does not read.
    /// Bounded by `timeout` because an rc file can be arbitrarily slow (or
    /// block on a prompt) and this may run on the main thread.
    static func loginShellNode(environment: [String: String], timeout: TimeInterval) -> String? {
        let shell = environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/sh"
        guard FileManager.default.isExecutableFile(atPath: shell) else { return nil }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: shell)
        proc.arguments = ["-lic", "command -v node"]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = Pipe()
        proc.standardInput = FileHandle.nullDevice

        do { try proc.run() } catch { return nil }

        // Read on a background queue: waiting on the process while its stdout
        // pipe fills would deadlock, and we still need the timeout to fire.
        let done = DispatchSemaphore(value: 0)
        var data = Data()
        DispatchQueue.global().async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()
            return nil
        }
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }

        // An interactive shell may print rc noise; the answer is the last
        // absolute path it emitted.
        let lines = String(data: data, encoding: .utf8)?
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("/") } ?? []
        return lines.last
    }
}
