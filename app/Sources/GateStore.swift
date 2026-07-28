// GateStore — reads gate files and answers them through the forge-gate engine.
//
// Division of labour, deliberately: the app READS the JSON directly (cheap, and
// the shape is stable) but WRITES nothing itself — answering shells out to
// scripts/forge-gate.js. All the logic worth preserving lives there: choice
// validation, first-writer-wins, atomic rename, expiry semantics. Duplicating
// any of it in Swift would be a second source of truth.

import Foundation

// MARK: - Model

struct GateOption: Codable, Identifiable, Hashable {
    let key: String
    let label: String
    let description: String
    var id: String { key }
}

struct GateAnswer: Codable, Hashable {
    let key: String?
    let label: String?
    let source: String?
    let notes: String?
}

struct Gate: Codable, Identifiable, Hashable {
    let id: String
    let run_id: String?
    let unit_id: String?
    let origin: String?
    let cwd: String?
    let question: String
    let context: String?
    let options: [GateOption]
    let `default`: String
    let status: String
    let answer: GateAnswer?
    let created_at: Double
    let expires_at: Double?

    /// Mirrors effectiveStatus() in forge-gate.js: expiry is computed on read,
    /// never eagerly persisted, so a lapsed gate must not still read "pending".
    var effectiveStatus: String {
        guard status == "pending" else { return status }
        guard let exp = expires_at else { return "pending" }
        return Date().timeIntervalSince1970 * 1000 >= exp ? "expired" : "pending"
    }

    var isPending: Bool { effectiveStatus == "pending" }

    var subtitle: String {
        [run_id, unit_id, origin].compactMap { $0 }.joined(separator: " · ")
    }

    var projectName: String {
        guard let cwd else { return "—" }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }

    /// Human-readable time left before the run gives up and takes `default`.
    var timeLeft: String? {
        guard isPending, let exp = expires_at else { return nil }
        let secs = Int((exp - Date().timeIntervalSince1970 * 1000) / 1000)
        if secs <= 0 { return "expirando" }
        if secs < 60 { return "\(secs)s" }
        let mins = secs / 60
        if mins < 60 { return "\(mins)min" }
        return String(format: "%.1fh", Double(mins) / 60.0)
    }

    var defaultLabel: String {
        options.first { $0.key == self.default }?.label ?? self.default
    }
}

// MARK: - Engine resolution

enum Engine {
    /// Same resolution order as bin/forge-gate: installed copy first, then the
    /// dev repo declared in prefs, so dogfooding works before an install.
    static func path() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let installed = "\(home)/.claude/scripts/forge-gate.js"
        if FileManager.default.fileExists(atPath: installed) { return installed }

        let prefs = "\(home)/.claude/forge-agent-prefs.md"
        if let text = try? String(contentsOfFile: prefs, encoding: .utf8) {
            for line in text.split(separator: "\n") where line.contains("repo_path:") {
                let repo = line.split(separator: ":", maxSplits: 1)[1]
                    .trimmingCharacters(in: .whitespaces)
                let candidate = "\(repo)/scripts/forge-gate.js"
                if FileManager.default.fileExists(atPath: candidate) { return candidate }
            }
        }
        return nil
    }

    static func nodePath() -> String {
        for p in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]
        where FileManager.default.fileExists(atPath: p) { return p }
        return "/usr/bin/env"   // last resort: resolve node via PATH
    }
}

// MARK: - Workspaces

/// Which projects to watch. Persisted as a plain JSON array of paths so it can
/// be edited by hand as easily as through the UI.
enum Workspaces {
    static var file: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.claude/forge-gate-workspaces.json"
    }

    static func load() -> [String] {
        guard let data = FileManager.default.contents(atPath: file),
              let list = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return list.filter { FileManager.default.fileExists(atPath: $0) }
    }

    static func save(_ list: [String]) {
        let unique = Array(Set(list)).sorted()
        guard let data = try? JSONEncoder().encode(unique) else { return }
        try? FileManager.default.createDirectory(
            atPath: (file as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: file), options: .atomic)
    }

    static func add(_ path: String) {
        var list = load()
        list.append(path)
        save(list)
    }

    static func remove(_ path: String) {
        save(load().filter { $0 != path })
    }
}

// MARK: - Store

@MainActor
final class GateStore: ObservableObject {
    /// Shared because two surfaces read it: the SwiftUI window and the
    /// AppDelegate that keeps the Dock badge in sync.
    static let shared = GateStore()

    /// Posted after every reload so the Dock badge can follow without the
    /// delegate having to poll on its own timer.
    static let didChange = Notification.Name("GateStoreDidChange")

    @Published private(set) var pending: [Gate] = []
    @Published private(set) var recent: [Gate] = []
    @Published private(set) var workspaces: [String] = []
    @Published private(set) var lastError: String?

    private var timer: Timer?

    init() {
        reload()
        // 2s is well under any human reaction time and costs only a few stats
        // per tick — gate files are tiny and there are rarely more than a couple.
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    deinit { timer?.invalidate() }

    func reload() {
        workspaces = Workspaces.load()
        var all: [Gate] = []
        for ws in workspaces {
            all.append(contentsOf: Self.readGates(in: ws))
        }
        pending = all.filter(\.isPending).sorted { $0.created_at < $1.created_at }
        recent = all.filter { !$0.isPending }
            .sorted { $0.created_at > $1.created_at }
            .prefix(5).map { $0 }
        NotificationCenter.default.post(name: Self.didChange, object: nil)
    }

    private static func readGates(in workspace: String) -> [Gate] {
        let dir = "\(workspace)/.gsd/forge/gates"
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir)
        else { return [] }
        let decoder = JSONDecoder()
        return names.filter { $0.hasSuffix(".json") }.compactMap { name in
            guard let data = FileManager.default.contents(atPath: "\(dir)/\(name)")
            else { return nil }
            // A half-written or corrupt gate is skipped, never fatal — same
            // posture as listGates() in the engine.
            return try? decoder.decode(Gate.self, from: data)
        }
    }

    /// Answer through the engine so validation and first-writer-wins still apply.
    func answer(_ gate: Gate, choice: String) {
        guard let engine = Engine.path() else {
            lastError = "engine forge-gate.js não encontrado — rode ./install.sh"
            return
        }
        guard let cwd = gate.cwd else {
            lastError = "gate sem cwd"
            return
        }

        let node = Engine.nodePath()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        var args: [String] = []
        if node.hasSuffix("/env") { args.append("node") }
        args += [engine, "--answer", gate.id, "--choice", choice, "--cwd", cwd]
        proc.arguments = args

        let errPipe = Pipe()
        proc.standardError = errPipe
        proc.standardOutput = Pipe()

        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus != 0 {
                let msg = String(
                    data: errPipe.fileHandleForReading.readDataToEndOfFile(),
                    encoding: .utf8) ?? ""
                // The common case here is a benign race: the gate expired or was
                // answered elsewhere between render and click.
                lastError = msg.trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
        reload()
    }

    func addWorkspace(_ path: String) {
        Workspaces.add(path)
        reload()
    }

    func removeWorkspace(_ path: String) {
        Workspaces.remove(path)
        reload()
    }
}
