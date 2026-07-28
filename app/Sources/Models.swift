// Models — the Forge artefacts the app reads.
//
// Every shape here mirrors a file or CLI contract that already exists:
//   Gate    → .gsd/forge/gates/{id}.json          (scripts/forge-gate.js)
//   Run     → .gsd/forge/runs/{id}.json           (shared/forge-state.md §2)
//   Account → forge-accounts.js --list --json
//   Usage   → forge-usage.js --json
//
// Decoding is deliberately lenient: fields the app does not know about are
// ignored, and anything optional stays optional. The engines evolve additively,
// so a stricter decoder would break the app on the next Forge release.

import Foundation

// MARK: - Gate

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
        return Date.nowMs >= exp ? "expired" : "pending"
    }

    var isPending: Bool { effectiveStatus == "pending" }

    var subtitle: String {
        [run_id, unit_id, origin].compactMap { $0 }.joined(separator: " · ")
    }

    var projectName: String {
        guard let cwd else { return "—" }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }

    /// Time left before the run gives up and takes `default`.
    var timeLeft: String? {
        guard isPending, let exp = expires_at else { return nil }
        return Duration.short(ms: exp - Date.nowMs)
    }

    var defaultLabel: String {
        options.first { $0.key == self.default }?.label ?? self.default
    }
}

// MARK: - Run

struct Run: Codable, Identifiable, Hashable {
    let kind: String            // "milestone" | "task"
    let id: String
    let session_id: String?
    let active: Bool
    let started_at: Double
    let last_heartbeat: Double?
    let worker: String?         // "execute-task/T03"
    let worker_started: Double?
    let isolation_mode: String?
    let milestone_dir: String?
    let cwd: String
    let account: String?
    let task_description: String?

    var projectName: String { URL(fileURLWithPath: cwd).lastPathComponent }

    /// A run whose heartbeat stopped is almost certainly a dead terminal, not
    /// work in progress. 15min matches ACTIVE_THRESHOLD_MS in forge-runs.js.
    var isStale: Bool {
        guard let hb = last_heartbeat else { return false }
        return Date.nowMs - hb > 15 * 60 * 1000
    }

    var statusLabel: String {
        if !active { return "encerrado" }
        return isStale ? "sem sinal" : "ativo"
    }

    /// "execute-task/T03" → ("execute-task", "T03")
    var workerParts: (unit: String, id: String)? {
        guard let worker, worker.contains("/") else { return nil }
        let p = worker.split(separator: "/", maxSplits: 1)
        return (String(p[0]), p.count > 1 ? String(p[1]) : "")
    }

    var elapsed: String { Duration.short(ms: Date.nowMs - started_at) ?? "—" }

    var workerElapsed: String? {
        guard let ws = worker_started else { return nil }
        return Duration.short(ms: Date.nowMs - ws)
    }
}

// MARK: - Account

struct Account: Codable, Identifiable, Hashable {
    let name: String
    let note: String?
    let store: String?
    let last_used: String?
    let days_left: Int?
    let has_token: Bool
    let is_active: Bool

    var id: String { name }
}

struct AccountsPayload: Codable {
    let active: String?
    let env_active: String?
    let accounts: [Account]
}

// MARK: - Usage

struct UsageWindow: Codable, Hashable {
    let used_percentage: Double?
    let resets_at: Double?

    var pct: Double { used_percentage ?? 0 }

    var resetsIn: String? {
        guard let r = resets_at else { return nil }
        // resets_at is epoch SECONDS from the API headers, unlike the ms
        // timestamps Forge writes into its own files.
        return Duration.short(ms: r * 1000 - Date.nowMs)
    }
}

struct AccountUsage: Codable, Identifiable, Hashable {
    let name: String
    let five_hour: UsageWindow?
    let seven_day: UsageWindow?

    var id: String { name }

    /// Headroom on the weekly window — the number that decides which account to
    /// pick next, so it is what the list sorts by.
    var headroom: Double { 100 - (seven_day?.pct ?? 0) }
}

// MARK: - Helpers

extension Date {
    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }
}

enum Duration {
    /// Compact human duration from milliseconds. Returns nil for non-positive
    /// input so callers can distinguish "no deadline" from "0s".
    static func short(ms: Double) -> String? {
        guard ms.isFinite else { return nil }
        let s = Int(ms / 1000)
        if s <= 0 { return "agora" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)min" }
        let h = Double(m) / 60
        if h < 24 { return String(format: "%.1fh", h) }
        return "\(Int(h / 24))d"
    }
}
