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

/// Branch, dirtiness and divergence as of ONE `git status` — see
/// `Git.statusSnapshot`. `ahead`/`behind` are jointly nil when there is no
/// upstream to compare against, and jointly zero when there is one and the
/// branch is level with it: "no remote configured" and "in sync with the
/// remote" are different facts and this type keeps them apart.
public struct GitStatusSnapshot: Equatable {
    public let branch: String
    public let dirty: Bool
    public let ahead: Int?
    public let behind: Int?

    public init(branch: String, dirty: Bool, ahead: Int?, behind: Int?) {
        self.branch = branch
        self.dirty = dirty
        self.ahead = ahead
        self.behind = behind
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

    /// Branch, dirtiness and divergence in ONE process.
    ///
    /// Measured, and the reason this exists: `currentBranch` + `isDirty` +
    /// `aheadBehind` is three spawns, and across the 20 projects registered on
    /// this machine that came to **261 ms per card** — on a screen that
    /// reloads every 15 s. No single one of the three is pathological (41–83 ms
    /// each in the shell); the cost IS the spawn count. `git status
    /// --porcelain --branch` answers all three at once, which is 3× less work
    /// with no cache to invalidate and nothing that can go stale.
    ///
    /// Consistency comes free with it: three separate calls sample three
    /// different instants and can disagree (a branch switched between call one
    /// and call three renders a branch name beside another branch's
    /// divergence). One call cannot.
    public static func statusSnapshot(at path: String) -> GitStatusSnapshot? {
        guard let out = run(["status", "--porcelain", "--branch"], at: path) else { return nil }
        return parseStatus(out)
    }

    /// Parses `git status --porcelain --branch`. Split from the process call
    /// because every shape below is a real repo state that is awkward to build
    /// on demand but trivial to write down.
    ///
    ///     ## main...origin/main [ahead 2, behind 1]   ← divergindo
    ///     ## main...origin/main                       ← em dia
    ///     ## main                                     ← sem upstream
    ///     ## No commits yet on main                   ← repo recém-criado
    ///     ## HEAD (no branch)                         ← destacado
    ///      M file.txt                                 ← qualquer linha = sujo
    public static func parseStatus(_ out: String) -> GitStatusSnapshot? {
        var branch: String?
        var ahead: Int?
        var behind: Int?
        var dirty = false

        for raw in out.split(separator: "\n", omittingEmptySubsequences: false) {
            if raw.hasPrefix("## ") {
                var head = String(raw.dropFirst(3))
                if head == "HEAD (no branch)" { branch = "destacado"; continue }
                if head.hasPrefix("No commits yet on ") {
                    branch = String(head.dropFirst("No commits yet on ".count))
                    continue
                }
                // Divergence bracket, when present, is the tail.
                var upstreamGone = false
                if let open = head.range(of: " [", options: .backwards),
                   head.hasSuffix("]") {
                    let inside = head[open.upperBound..<head.index(before: head.endIndex)]
                    if inside == "gone" { upstreamGone = true }
                    for piece in inside.components(separatedBy: ", ") {
                        let parts = piece.split(separator: " ")
                        guard parts.count == 2, let n = Int(parts[1]) else { continue }
                        if parts[0] == "ahead" { ahead = n }
                        if parts[0] == "behind" { behind = n }
                    }
                    head = String(head[head.startIndex..<open.lowerBound])
                }
                if let sep = head.range(of: "...") {
                    branch = String(head[head.startIndex..<sep.lowerBound])
                    // An upstream exists, so silence about a direction means
                    // ZERO in that direction — git omits the side that is
                    // zero, and `[ahead 3]` means behind is 0, not unknown.
                    //
                    // `[gone]` is the exception and must not fall into that
                    // rule: the upstream is configured but no longer on the
                    // remote, so there is genuinely nothing to compare
                    // against. Defaulting it to 0/0 would render "em dia com o
                    // remoto" for a branch whose remote has been deleted.
                    if !upstreamGone {
                        if ahead == nil { ahead = 0 }
                        if behind == nil { behind = 0 }
                    }
                } else {
                    branch = head
                }
                continue
            }
            if !raw.trimmingCharacters(in: .whitespaces).isEmpty { dirty = true }
        }

        guard let branch, !branch.isEmpty else { return nil }
        return GitStatusSnapshot(branch: branch, dirty: dirty, ahead: ahead, behind: behind)
    }

    /// Runs git and gives up after `timeout`.
    ///
    /// The timeout exists because these calls now run per card on a screen
    /// that reloads on a timer: a git that blocks (a lock held by another
    /// process, a filesystem that stopped answering) would otherwise hang the
    /// caller forever rather than degrade to a named absence. Terminating and
    /// returning nil makes a stuck repo indistinguishable from an unreadable
    /// one, which is the correct outcome — both are "no git state to show".
    static func run(_ args: [String], at path: String, timeout: TimeInterval = 5) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", path] + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        // Read on another thread: a pipe that fills while we block on
        // waitUntilExit deadlocks, and a deadlock is exactly what the timeout
        // is meant to survive.
        let box = DataBox()
        let done = DispatchSemaphore(value: 0)
        do {
            try p.run()
            DispatchQueue.global().async {
                box.data = out.fileHandleForReading.readDataToEndOfFile()
                done.signal()
            }
            if done.wait(timeout: .now() + timeout) == .timedOut {
                p.terminate()
                return nil
            }
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            return String(data: box.data, encoding: .utf8)
        } catch { return nil }
    }
}

/// Carries the child's stdout across the reader thread. The semaphore orders
/// the write before the read, so no further synchronisation is needed.
final class DataBox {
    var data = Data()
}

/// Finds Forge projects on disk instead of making the user navigate to each one.
///
/// "Any directory containing .gsd/" was the rule until it turned out our own
/// scripts wrote that directory into every repo they touched — see
/// `ProjectMarker`, which owns the predicate now. Discovery offers only real
/// projects; directories merely touched by a run are surfaced from the
/// registered list instead, where the operator can act on them.
public enum ProjectDiscovery {
    /// Seeding default — **not** the scan source.
    ///
    /// These names exist to propose roots the first time a registry is created
    /// (and during migration of a legacy one), when there is nothing declared
    /// to walk yet. Once the registry declares `roots[]`, discovery walks those
    /// and only those: see `scan(declaredRoots:)`. Guessing at names is what
    /// made a project outside `~/Development` invisible with nothing on screen
    /// to explain it.
    ///
    /// Scanned shallowly on purpose: a deep walk of $HOME would take seconds
    /// and wander into node_modules.
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

    /// Every Forge project under the given absolute roots — and nowhere else.
    ///
    /// The roots come from the registry (`WorkspaceRegistry.Resolution.roots`),
    /// already resolved against an explicit home, so this function never
    /// consults `roots` above and never expands `~`: a root that arrives
    /// unresolved is the codec's refusal to make, not a guess to make here.
    ///
    /// `maxDepth` counts from each declared root, so declaring a deeper root
    /// reaches deeper — the same three levels, measured from where the operator
    /// pointed rather than from a name we picked.
    ///
    /// A root that does not exist is skipped in silence: roots outlive the
    /// directories they name (external volume, other machine), and one stale
    /// entry must not cost the operator the rest of the scan.
    public static func scan(declaredRoots: [String]) -> [String] {
        var found: Set<String> = []
        for root in declaredRoots where !root.isEmpty {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: root, isDirectory: &isDir),
                  isDir.boolValue else { continue }
            walk(URL(fileURLWithPath: root), depth: 0, into: &found)
        }
        return found.sorted()
    }

    static func walk(_ dir: URL, depth: Int, into found: inout Set<String>) {
        guard depth <= maxDepth else { return }
        let fm = FileManager.default

        if ProjectMarker.isProject(dir.path) {
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
