// StatusModels — the payload of `forge-status.js --json`.
//
// Written against the real output rather than a guess. The previous shape had
// `progress` as a String and the slice under `slice`; the engine emits
// `progress: {done,total}` and `active_slice`. Lenient decoding meant both came
// back nil forever and the UI simply showed less, with nothing to indicate it
// was misreading.

import Foundation

public struct StatusPayload: Codable {
    public let cwd: String?
    public let generated_at: String?
    public let runs: Runs?
    public let milestone: MilestoneStatus?
    public let autonomous_tasks: [AutonomousTask]?
    public let warnings: [String]?

    public struct Runs: Codable {
        public let active: [ActiveRun]?
        public let focused: String?
        public let note: String?
    }

    public struct ActiveRun: Codable, Identifiable, Hashable {
        public let id: String
        public let kind: String?
        public let phase: String?
        public let heartbeat_age_ms: Double?
        public let stale: Bool?
        public let isolation_mode: String?
        public let session_id: String?
        public let task_description: String?
    }
}

public struct AutonomousTask: Codable, Identifiable, Hashable {
    public let id: String
    public let format: String?
    public let description: String?
    public let status: String?
}

public struct MilestoneStatus: Codable, Hashable {
    public let id: String?
    public let title: String?
    public let phase: String?
    public let active_slice: String?
    public let active_task: String?
    public let auto_mode: String?
    public let next_action: String?
    public let progress: Progress?
    public let slices: [SliceStatus]?

    public struct Progress: Codable, Hashable {
        public let done: Int
        public let total: Int

        public init(done: Int, total: Int) {
            self.done = done
            self.total = total
        }

        /// 0...1. Guarded because a milestone can legitimately report 0 total
        /// before planning has produced any slices.
        public var fraction: Double {
            total > 0 ? min(1, Double(done) / Double(total)) : 0
        }

        public var percent: Int { Int((fraction * 100).rounded()) }
    }

    /// Title without the id prefix the engine repeats when a milestone has no
    /// human title of its own.
    public var displayTitle: String? {
        guard let title, title != id else { return nil }
        return title
    }
}

public struct SliceStatus: Codable, Identifiable, Hashable {
    public let id: String
    public let title: String?
    public let risk: String?
    public let status: String?
    public let checked: Bool?
    public let tasks: [TaskStatus]?

    public var isDone: Bool { status == "done" || checked == true }
    public var isHighRisk: Bool { risk == "high" }

    public var doneTasks: Int { (tasks ?? []).filter(\.isDone).count }
    public var totalTasks: Int { (tasks ?? []).count }
}

public struct TaskStatus: Codable, Identifiable, Hashable {
    public let id: String
    public let title: String?
    public let status: String?
    public let checked: Bool?

    public var isDone: Bool { status == "done" || checked == true }

    /// Plan titles carry trailing metadata (`— depends:[...] domain:backend`)
    /// that is useful to the planner and noise in a list.
    public var cleanTitle: String {
        guard let t = title else { return id }
        var s = t
        for marker in ["** —", " — `depends", " `depends"] {
            if let r = s.range(of: marker) { s = String(s[..<r.lowerBound]) }
        }
        return s.replacingOccurrences(of: "**", with: "")
            .trimmingCharacters(in: .whitespaces)
    }
}
