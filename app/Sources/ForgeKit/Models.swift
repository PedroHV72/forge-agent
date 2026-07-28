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

public struct GateOption: Codable, Identifiable, Hashable {
    public let key: String
    public let label: String
    public let description: String
    public var id: String { key }

    public init(key: String, label: String, description: String) {
        self.key = key; self.label = label; self.description = description
    }
}

public struct GateAnswer: Codable, Hashable {
    public let key: String?
    public let label: String?
    public let source: String?
    public let notes: String?

    public init(key: String?, label: String?, source: String?, notes: String?) {
        self.key = key; self.label = label; self.source = source; self.notes = notes
    }
}

public struct Gate: Codable, Identifiable, Hashable {
    public let id: String
    public let run_id: String?
    public let unit_id: String?
    public let origin: String?
    public let cwd: String?
    public let question: String
    public let context: String?
    public let options: [GateOption]
    public let `default`: String
    public let status: String
    public let answer: GateAnswer?
    public let created_at: Double
    public let expires_at: Double?

    public init(id: String, run_id: String?, unit_id: String?, origin: String?,
                cwd: String?, question: String, context: String?,
                options: [GateOption], default: String, status: String,
                answer: GateAnswer?, created_at: Double, expires_at: Double?) {
        self.id = id; self.run_id = run_id; self.unit_id = unit_id
        self.origin = origin; self.cwd = cwd; self.question = question
        self.context = context; self.options = options; self.default = `default`
        self.status = status; self.answer = answer
        self.created_at = created_at; self.expires_at = expires_at
    }

    /// Mirrors effectiveStatus() in forge-gate.js: expiry is computed on read,
    /// never eagerly persisted, so a lapsed gate must not still read "pending".
    public var effectiveStatus: String {
        guard status == "pending" else { return status }
        guard let exp = expires_at else { return "pending" }
        return Date.nowMs >= exp ? "expired" : "pending"
    }

    public var isPending: Bool { effectiveStatus == "pending" }

    public var subtitle: String {
        [run_id, unit_id, origin].compactMap { $0 }.joined(separator: " · ")
    }

    public var projectName: String {
        guard let cwd else { return "—" }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }

    /// Time left before the run gives up and takes `default`.
    public var timeLeft: String? {
        guard isPending, let exp = expires_at else { return nil }
        return Duration.short(ms: exp - Date.nowMs)
    }

    public var defaultLabel: String {
        options.first { $0.key == self.default }?.label ?? self.default
    }
}

// MARK: - Run

public struct Run: Codable, Identifiable, Hashable {
    public let kind: String            // "milestone" | "task"
    public let id: String
    public let session_id: String?
    public let active: Bool
    public let started_at: Double
    public let last_heartbeat: Double?
    public let worker: String?         // "execute-task/T03"
    public let worker_started: Double?
    public let isolation_mode: String?
    public let milestone_dir: String?
    public let cwd: String
    public let account: String?
    public let task_description: String?

    public var projectName: String { URL(fileURLWithPath: cwd).lastPathComponent }

    /// A run whose heartbeat stopped is almost certainly a dead terminal, not
    /// work in progress. 15min matches ACTIVE_THRESHOLD_MS in forge-runs.js.
    public var isStale: Bool {
        guard let hb = last_heartbeat else { return false }
        return Date.nowMs - hb > 15 * 60 * 1000
    }

    public var statusLabel: String {
        if !active { return "encerrado" }
        return isStale ? "sem sinal" : "ativo"
    }

    /// "execute-task/T03" → ("execute-task", "T03")
    public var workerParts: (unit: String, id: String)? {
        guard let worker, worker.contains("/") else { return nil }
        let p = worker.split(separator: "/", maxSplits: 1)
        return (String(p[0]), p.count > 1 ? String(p[1]) : "")
    }

    public var elapsed: String { Duration.short(ms: Date.nowMs - started_at) ?? "—" }

    public var workerElapsed: String? {
        guard let ws = worker_started else { return nil }
        return Duration.short(ms: Date.nowMs - ws)
    }
}

// MARK: - Account

public struct Account: Codable, Identifiable, Hashable {
    public let name: String
    public let note: String?
    public let store: String?
    public let last_used: String?
    public let days_left: Int?
    public let has_token: Bool
    public let is_active: Bool

    public var id: String { name }
}

public struct AccountsPayload: Codable {
    public let active: String?
    public let env_active: String?
    public let accounts: [Account]
}

// MARK: - Usage

public struct UsageWindow: Codable, Hashable {
    public let used_percentage: Double?
    public let resets_at: Double?

    public var pct: Double { used_percentage ?? 0 }

    public var resetsIn: String? {
        guard let r = resets_at else { return nil }
        // resets_at is epoch SECONDS from the API headers, unlike the ms
        // timestamps Forge writes into its own files.
        return Duration.short(ms: r * 1000 - Date.nowMs)
    }
}

public struct AccountUsage: Codable, Identifiable, Hashable {
    public let name: String
    public let five_hour: UsageWindow?
    public let seven_day: UsageWindow?

    public var id: String { name }

    /// Headroom on the weekly window — the number that decides which account to
    /// pick next, so it is what the list sorts by.
    public var headroom: Double { 100 - (seven_day?.pct ?? 0) }
}

// MARK: - Helpers

public extension Date {
    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }
}

public enum Duration {
    /// Compact human duration from milliseconds. Returns nil for non-positive
    /// input so callers can distinguish "no deadline" from "0s".
    public static func short(ms: Double) -> String? {
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
