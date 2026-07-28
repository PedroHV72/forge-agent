// ForgeCore — locating the Forge engines and running them.
//
// THE GOLDEN RULE: the app never reimplements Forge logic. It reads artefacts
// directly (cheap, stable shapes) and delegates every mutation to the engines
// in scripts/, so validation, locking and atomicity stay in one place.
//
// Launching work is deliberately done by opening a Terminal window rather than
// spawning `claude` as a child process:
//   - interactive claude sessions need a real TTY
//   - a run must survive the app quitting
//   - you can still watch and type into it
// The app is a control surface, not a process supervisor.

import Foundation
import AppKit

enum ForgeCore {

    // MARK: - Engine resolution

    /// Installed copy first, then the dev repo declared in prefs — same order
    /// as bin/forge-gate, so dogfooding works before an install.
    static func engine(_ name: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let installed = "\(home)/.claude/scripts/\(name)"
        if FileManager.default.fileExists(atPath: installed) { return installed }
        if let repo = repoPath {
            let candidate = "\(repo)/scripts/\(name)"
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Where the Forge repo lives, used to resolve engines before an install.
    ///
    /// Prefs moved from `forge-agent-prefs.md` (YAML-ish) to
    /// `forge-agent-prefs.jsonc`, so both are read, newest format first. Two
    /// traps in the JSONC file, both hit in practice:
    ///   - `repo_path` appears twice: once commented out in the scaffold header
    ///     and once for real further down. Commented lines must be skipped.
    ///   - the value is a JSON string, so the quotes have to come off.
    static var repoPath: String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for file in ["\(home)/.claude/forge-agent-prefs.jsonc",
                     "\(home)/.claude/forge-agent-prefs.json",
                     "\(home)/.claude/forge-agent-prefs.md"] {
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            for raw in text.split(separator: "\n") {
                let line = raw.trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("//") || line.hasPrefix("#") { continue }
                guard line.contains("repo_path") else { continue }
                guard let colon = line.firstIndex(of: ":") else { continue }
                var v = String(line[line.index(after: colon)...])
                    .trimmingCharacters(in: .whitespaces)
                if let comment = v.range(of: "//") { v = String(v[..<comment.lowerBound]) }
                v = v.trimmingCharacters(in: CharacterSet(charactersIn: " ,\"'"))
                if !v.isEmpty, FileManager.default.fileExists(atPath: v) { return v }
            }
        }
        return nil
    }

    static var nodePath: String {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where FileManager.default.fileExists(atPath: p) { return p }
        return "/usr/bin/env"
    }

    // MARK: - Running engines

    struct Result {
        let ok: Bool
        let stdout: String
        let stderr: String
    }

    /// Run a Forge engine synchronously and capture its output.
    @discardableResult
    static func run(_ engineName: String, _ args: [String], cwd: String? = nil) -> Result {
        guard let enginePath = engine(engineName) else {
            // Say which paths were tried: "run install.sh" is useless when the
            // real cause is a repo_path that no longer resolves.
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let repoNote = repoPath.map { "repo: \($0)/scripts/" } ?? "repo_path não resolvido nas prefs"
            return Result(ok: false, stdout: "",
                          stderr: "\(engineName) não encontrado — procurei em \(home)/.claude/scripts/ e \(repoNote). Rode ./install.sh no repo do Forge.")
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        var argv: [String] = []
        if nodePath.hasSuffix("/env") { argv.append("node") }
        argv.append(enginePath)
        argv += args
        proc.arguments = argv
        if let cwd { proc.currentDirectoryURL = URL(fileURLWithPath: cwd) }

        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err

        do {
            try proc.run()
            // Drain before waiting: a pipe that fills up deadlocks the child.
            let o = out.fileHandleForReading.readDataToEndOfFile()
            let e = err.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            return Result(
                ok: proc.terminationStatus == 0,
                stdout: String(data: o, encoding: .utf8) ?? "",
                stderr: (String(data: e, encoding: .utf8) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return Result(ok: false, stdout: "", stderr: error.localizedDescription)
        }
    }

    /// Decode an engine's `--json` output.
    static func runJSON<T: Decodable>(_ type: T.Type, _ engineName: String,
                                      _ args: [String], cwd: String? = nil) -> T? {
        let r = run(engineName, args, cwd: cwd)
        guard r.ok, let data = r.stdout.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Launching terminals

    /// Open a Terminal window running `command` in `cwd`.
    ///
    /// Implemented by writing a .command file and `open`-ing it. AppleScript
    /// would need Automation permission — which the user must grant in a modal,
    /// and which silently hangs the caller until they do.
    @discardableResult
    static func openTerminal(cwd: String, command: String, title: String? = nil) -> Result {
        let dir = NSTemporaryDirectory()
        let file = "\(dir)/forge-launch-\(UUID().uuidString.prefix(8)).command"

        var script = "#!/bin/bash\n"
        if let title { script += "echo \(shellQuote("▸ \(title)"))\n" }
        script += "cd \(shellQuote(cwd)) || exit 1\n"
        script += command + "\n"
        // Remove the launcher once it has been read, so /tmp does not collect
        // one file per launch.
        script += "rm -f \(shellQuote(file))\n"

        do {
            try script.write(toFile: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755],
                                                  ofItemAtPath: file)
        } catch {
            return Result(ok: false, stdout: "", stderr: error.localizedDescription)
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = [file]
        do {
            try proc.run()
            proc.waitUntilExit()
            return Result(ok: proc.terminationStatus == 0, stdout: "", stderr: "")
        } catch {
            return Result(ok: false, stdout: "", stderr: error.localizedDescription)
        }
    }

    static func reveal(_ path: String) {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // MARK: - Pause signals

    /// Pause is a signal file the orchestrator polls between units:
    /// `.gsd/forge/pause-{RUN_ID}` (see skills/forge-auto/SKILL.md).
    /// It takes effect at the next unit boundary, never mid-dispatch.
    static func pauseFile(cwd: String, runId: String) -> String {
        "\(cwd)/.gsd/forge/pause-\(runId)"
    }

    static func isPaused(cwd: String, runId: String) -> Bool {
        FileManager.default.fileExists(atPath: pauseFile(cwd: cwd, runId: runId))
    }

    static func setPaused(_ paused: Bool, cwd: String, runId: String) -> String? {
        let f = pauseFile(cwd: cwd, runId: runId)
        do {
            if paused {
                try FileManager.default.createDirectory(
                    atPath: "\(cwd)/.gsd/forge", withIntermediateDirectories: true)
                try "requested by Forge.app\n".write(toFile: f, atomically: true, encoding: .utf8)
            } else if FileManager.default.fileExists(atPath: f) {
                try FileManager.default.removeItem(atPath: f)
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
