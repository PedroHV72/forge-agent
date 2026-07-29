// GitCore — reading git state, and finding Forge projects on disk.
//
// Pure enough to test: the worktree parser is string processing over a format
// that decides whether a project's activity is counted at all (runs and gates
// are attributed by cwd, which is the WORKTREE under isolation).

import Foundation

/// A checkout belonging to a project. Forge can isolate a milestone in its own
/// worktree (forge_isolation.mode = worktree), so one "project" on disk is
/// often several working trees — and the runs, gates and branches live in the
/// worktree, not the folder you added.
public struct Checkout: Identifiable, Hashable {
    public let path: String
    public let branch: String?
    public let isPrimary: Bool

    public var id: String { path }
    public var name: String { URL(fileURLWithPath: path).lastPathComponent }

    public init(path: String, branch: String?, isPrimary: Bool) {
        self.path = path
        self.branch = branch
        self.isPrimary = isPrimary
    }
}

public enum Git {

    public static func checkouts(at path: String) -> [Checkout] {
        guard let out = run(["worktree", "list", "--porcelain"], at: path) else { return [] }
        return parseWorktrees(out)
    }

    /// `git worktree list --porcelain` emits stanzas separated by blank lines:
    ///
    ///     worktree <path>
    ///     HEAD <sha>
    ///     branch refs/heads/<name>     (absent when detached)
    ///     bare                          (a bare repo has no working tree)
    ///
    /// Split from the process call so the format can be tested without a repo.
    public static func parseWorktrees(_ out: String) -> [Checkout] {
        var result: [Checkout] = []
        var current: String?
        var branch: String?
        var bare = false

        func flush() {
            defer { current = nil; branch = nil; bare = false }
            guard let c = current else { return }
            // A bare repo has no working tree — listing it would offer a folder
            // there is nothing to open in.
            guard !bare else { return }
            result.append(Checkout(path: c, branch: branch, isPrimary: result.isEmpty))
        }

        for raw in out.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("worktree ") {
                flush()
                current = String(line.dropFirst("worktree ".count))
            } else if line.hasPrefix("branch ") {
                branch = String(line.dropFirst("branch ".count))
                    .replacingOccurrences(of: "refs/heads/", with: "")
            } else if line == "bare" {
                bare = true
            }
        }
        flush()
        return result
    }

    public static func currentBranch(at path: String) -> String? {
        run(["rev-parse", "--abbrev-ref", "HEAD"], at: path)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isDirty(at path: String) -> Bool {
        guard let out = run(["status", "--porcelain"], at: path) else { return false }
        return !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func run(_ args: [String], at path: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", path] + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
            let d = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            return String(data: d, encoding: .utf8)
        } catch { return nil }
    }
}

/// Finds Forge projects on disk instead of making the user navigate to each one.
/// A project is any directory containing .gsd/ — the same marker every engine uses.
public enum ProjectDiscovery {
    /// Where people actually keep code. Scanned shallowly on purpose: a deep
    /// walk of $HOME would take seconds and wander into node_modules.
    public static let roots = ["Development", "Documents", "Projects",
                               "Code", "src", "repos", "Desktop"]
    public static let maxDepth = 3

    /// Directories that never hold a project but are expensive to traverse.
    public static let skip: Set<String> = [
        "node_modules", "vendor", "Library", ".git", "dist", "build",
        ".build", "target", "Pods", ".next", "venv", ".venv",
    ]

    public static func scan(home: String? = nil) -> [String] {
        let base = URL(fileURLWithPath:
            home ?? FileManager.default.homeDirectoryForCurrentUser.path)
        var found: Set<String> = []
        for root in roots {
            let dir = base.appendingPathComponent(root)
            guard FileManager.default.fileExists(atPath: dir.path) else { continue }
            walk(dir, depth: 0, into: &found)
        }
        return found.sorted()
    }

    static func walk(_ dir: URL, depth: Int, into found: inout Set<String>) {
        guard depth <= maxDepth else { return }
        let fm = FileManager.default

        if fm.fileExists(atPath: dir.appendingPathComponent(".gsd").path) {
            found.insert(dir.path)
            // Keep descending: a monorepo can hold nested Forge projects, so
            // stopping at the first hit would miss them.
        }

        guard let entries = try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return }

        for e in entries {
            guard (try? e.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            else { continue }
            if skip.contains(e.lastPathComponent) { continue }
            walk(e, depth: depth + 1, into: &found)
        }
    }
}
