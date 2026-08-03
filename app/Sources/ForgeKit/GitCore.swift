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
    /// Divergence from the project's DEFAULT branch — a different measurement
    /// from `ahead`/`behind`, which are against the UPSTREAM. `nil` means it has
    /// not been measured (see `GitBaseline` for why that is not the same as
    /// "level with the default").
    public let baseline: GitBaseline?

    public init(branch: String, dirty: Bool, ahead: Int?, behind: Int?,
                baseline: GitBaseline? = nil) {
        self.branch = branch
        self.dirty = dirty
        self.ahead = ahead
        self.behind = behind
        self.baseline = baseline
    }

    public func with(baseline: GitBaseline?) -> GitStatusSnapshot {
        GitStatusSnapshot(branch: branch, dirty: dirty, ahead: ahead,
                          behind: behind, baseline: baseline)
    }
}

/// How this branch stands against the project's default branch — `main` on most
/// of the operator's repos, `master` on this one.
///
/// NOT the same fact as `GitStatusSnapshot.ahead`/`behind`. Those come from
/// `git status --porcelain --branch`, whose `[ahead N, behind M]` is measured
/// against the UPSTREAM (`origin/<this-branch>`). Being 3 ahead of
/// `origin/feat/x` says nothing about how far `feat/x` has drifted from `main`,
/// and this repo is the proof: `feat/projects-screen-richer` has no upstream at
/// all and is 5 commits ahead of `master`. Neither number can stand in for the
/// other, so they are two fields.
public struct GitBaselineState: Equatable {
    /// The resolved default branch name — never guessed. See `GitDefaultBranch`.
    public let defaultBranch: String
    /// The checked-out branch IS the default. Distinct from being level with
    /// it: "you are on master" and "your branch has nothing master lacks" are
    /// different sentences about different situations.
    public let onDefault: Bool
    public let ahead: Int
    public let behind: Int

    public init(defaultBranch: String, onDefault: Bool, ahead: Int, behind: Int) {
        self.defaultBranch = defaultBranch
        self.onDefault = onDefault
        self.ahead = ahead
        self.behind = behind
    }
}

/// A measured divergence from the default branch, or a NAMED reason there is
/// none.
///
/// The second case is the same discipline `GitStatus` enforces one level up: a
/// repository with no `origin` and no `main`/`master`, or one whose `rev-list`
/// refused, must render as *not determined* — never as "level with main". That
/// would be a confident false claim of exactly the kind `383412d` removed from
/// this screen.
public enum GitBaseline: Equatable {
    case measured(GitBaselineState)
    case unknown(String)

    public var state: GitBaselineState? {
        if case .measured(let s) = self { return s }
        return nil
    }
}

/// Which branch a project treats as its default — `main` or `master`.
///
/// PRECEDENCE IS SHARED WITH `gitDefaultBranch()` in `scripts/forge-isolation.js`
/// and must stay in step with it (pinned by
/// `scripts/forge-app-workspace-marker.test.js`). That JS function is
/// load-bearing: `setupWorktreeOne` branches from `origin/<def>`, and getting
/// the name wrong once produced a worktree 13 commits behind. The order is:
///
///   1. `origin/HEAD` — what the remote itself says its default is
///   2. the first of `main`, `master` that exists as a local branch
///
/// ONE DELIBERATE DIFFERENCE, and it is not drift: the JS ends with `return
/// 'main'`, a guess, because a script that must check something out needs a
/// name no matter what. A card must not guess — an unresolvable default is
/// reported as `.unknown`, because printing "main" for a repo that has no main
/// is the false-claim failure this whole line of work exists to remove.
///
/// Resolved by READING REFS, not by spawning git. Measured across the
/// operator's 14 registered projects: file reads agreed with
/// `git symbolic-ref` on 14/14 (including both non-repositories, where both say
/// nothing) at 0.9 ms/card against git's ~40 ms. Git is the expensive field on
/// this screen and the card already pays for one spawn; the name is available
/// on disk, so it costs no second one.
public enum GitDefaultBranch {
    /// Fallback names, in order. Same list, same order, as the JS.
    public static let candidates = ["main", "master"]

    public static func resolve(repoPath: String) -> String? {
        guard let dir = commonDir(repoPath: repoPath) else { return nil }
        let packed = (try? String(contentsOfFile: dir + "/packed-refs",
                                  encoding: .utf8)) ?? ""

        if let named = originHead(commonDir: dir, packed: packed) { return named }

        for c in candidates {
            if FileManager.default.fileExists(atPath: dir + "/refs/heads/" + c) { return c }
            if packedHas(packed, ref: "refs/heads/" + c) { return c }
        }
        return nil
    }

    /// `refs/remotes/origin/HEAD` is a symref: `ref: refs/remotes/origin/main`.
    /// Loose first, then `packed-refs`, which is where a repacked repo keeps it.
    static func originHead(commonDir: String, packed: String) -> String? {
        let prefix = "ref: refs/remotes/origin/"
        if let loose = try? String(contentsOfFile: commonDir + "/refs/remotes/origin/HEAD",
                                   encoding: .utf8) {
            let line = loose.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix(prefix) {
                let name = String(line.dropFirst(prefix.count))
                if !name.isEmpty && name != "HEAD" { return name }
            }
        }
        for raw in packed.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix(prefix) else { continue }
            let name = String(line.dropFirst(prefix.count))
            if !name.isEmpty && name != "HEAD" { return name }
        }
        return nil
    }

    /// Exact ref match, so `refs/heads/main` is never satisfied by
    /// `refs/heads/maintenance`.
    static func packedHas(_ packed: String, ref: String) -> Bool {
        for raw in packed.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.hasPrefix("#"), !line.hasPrefix("^") else { continue }
            guard let sp = line.firstIndex(of: " ") else { continue }
            if line[line.index(after: sp)...] == ref[...] { return true }
        }
        return false
    }

    /// The directory refs actually live in.
    ///
    /// A linked worktree — which Forge itself creates in `forge_isolation.mode:
    /// worktree` — has a `.git` FILE pointing at `…/.git/worktrees/<name>`, and
    /// that directory holds a `commondir` pointing back at the shared refs. A
    /// resolver that stopped at the first hop would find no `refs/heads/main` in
    /// any worktree Forge makes and report every one of them as undetermined.
    static func commonDir(repoPath: String) -> String? {
        let fm = FileManager.default
        let dotGit = repoPath + "/.git"
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dotGit, isDirectory: &isDir) else { return nil }
        if isDir.boolValue { return dotGit }

        guard let text = try? String(contentsOfFile: dotGit, encoding: .utf8) else { return nil }
        let marker = "gitdir:"
        guard let line = text.split(separator: "\n")
                .first(where: { $0.hasPrefix(marker) }) else { return nil }
        let raw = String(line.dropFirst(marker.count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let gitDir = raw.hasPrefix("/") ? raw : repoPath + "/" + raw

        if let common = try? String(contentsOfFile: gitDir + "/commondir", encoding: .utf8) {
            let c = common.trimmingCharacters(in: .whitespacesAndNewlines)
            if !c.isEmpty {
                let resolved = c.hasPrefix("/") ? c : gitDir + "/" + c
                return URL(fileURLWithPath: resolved).standardized.path
            }
        }
        return URL(fileURLWithPath: gitDir).standardized.path
    }
}

/// How one git invocation ended. The four cases are not interchangeable: only
/// `.failed` on a directory with no `.git` means "there is no repository here",
/// and that is the only one a card may render as an absence.
public enum GitRun: Equatable {
    case ok(String)
    /// git ran and refused. 128 is its "not a repository" / fatal code.
    case failed(Int32)
    case timedOut
    case launchFailed(String)
}

/// The state of a working tree, the measured absence of one, or a named reason
/// no measurement was obtained.
public enum GitStatus: Equatable {
    case state(GitStatusSnapshot)
    /// Measured: this directory is not a repository.
    case notARepository
    /// NOT measured. Rendering this as "sem git" is the defect this case exists
    /// to make unrepresentable.
    case unavailable(String)

    public var snapshot: GitStatusSnapshot? {
        if case .state(let s) = self { return s }
        return nil
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
        status(at: path).snapshot
    }

    /// Where the tree stands — or a NAMED reason there is no answer.
    ///
    /// The distinction this type exists for is not cosmetic. `statusSnapshot`
    /// collapses "this directory is not a repository" and "git did not answer"
    /// into the same `nil`, and the card downstream rendered that single nil as
    /// **"sem git"** — a measured absence. Two real repositories on the
    /// operator's machine (`feirao-do-lu`, `lookchina/apps/fenrir`) read "sem
    /// git" on screen while `git status` answered them from the shell in
    /// milliseconds. A confident false claim is the one failure this codebase
    /// is least allowed to ship, so the failure now carries its own name and
    /// the caller can retry it.
    public static func status(at path: String) -> GitStatus {
        let s = classifyStatus(invoke(["status", "--porcelain", "--branch"], at: path),
                               hasDotGit: FileManager.default.fileExists(atPath: path + "/.git"))
        guard case .state(let snap) = s else { return s }
        return .state(snap.with(baseline: baseline(at: path, currentBranch: snap.branch)))
    }

    /// How far the checked-out branch has drifted from the default branch.
    ///
    /// COST, measured in-app across the operator's 14 registered projects:
    ///
    ///     git status alone           118.7 ms/card
    ///     + default-branch baseline   34.4 ms/card   (→ 153.1 ms/card total)
    ///
    /// The average hides the shape, and the shape is the point: **5 of the 14**
    /// cards are off their default branch and pay one `rev-list` (~95 ms each);
    /// the other 9 pay 0.0–0.6 ms, because resolving the NAME is file reads and
    /// being on the default makes the count zero by definition. So this is ~29%
    /// on top of a field the caller already stages off the first paint — it
    /// rides that same stage rather than earning one of its own, and the
    /// not-yet-measured state is already drawn distinctly (`padrão…`) rather
    /// than passing for a determined one.
    ///
    /// NO FETCH, ever. This runs per card on a 15 s timer; a fetch here would
    /// put the operator's network on the reload path. The comparison is against
    /// refs already on disk, and the local `<def>` is the right one of those:
    /// the operator's own reading of "5 ahead of master" is against local
    /// `master` (`origin/master` says 7 on this very branch, because the local
    /// ref is where their work diverged from).
    public static func baseline(at path: String, currentBranch: String) -> GitBaseline {
        guard let def = GitDefaultBranch.resolve(repoPath: path) else {
            return .unknown("nenhuma branch padrão encontrada — sem origin/HEAD, sem main, sem master")
        }
        // The default IS checked out: divergence from it is zero by definition,
        // and asking git would be a spawn to learn what we already know.
        if currentBranch == def {
            return .measured(GitBaselineState(defaultBranch: def, onDefault: true,
                                              ahead: 0, behind: 0))
        }
        switch invoke(["rev-list", "--left-right", "--count", "\(def)...HEAD"], at: path) {
        case .ok(let out):
            guard let c = parseLeftRight(out) else {
                return .unknown("git respondeu num formato não reconhecido ao comparar com \(def)")
            }
            return .measured(GitBaselineState(defaultBranch: def, onDefault: false,
                                              ahead: c.ahead, behind: c.behind))
        case .failed(let code):
            return .unknown("git não pôde comparar com \(def) (código \(code))")
        case .timedOut:
            return .unknown("git não respondeu a tempo ao comparar com \(def)")
        case .launchFailed(let why):
            return .unknown("git não pôde ser executado: \(why)")
        }
    }

    /// `git rev-list --left-right --count <def>...HEAD` prints `"<left>\t<right>"`.
    ///
    /// LEFT IS BEHIND, RIGHT IS AHEAD, and the order is the whole reason this is
    /// a named function instead of an inline split: left counts commits reachable
    /// from `<def>` but not from HEAD — i.e. what this branch is MISSING — and
    /// swapping them would draw "5 behind" for a branch that is 5 ahead, a
    /// backwards claim that looks entirely plausible on screen.
    public static func parseLeftRight(_ out: String) -> (behind: Int, ahead: Int)? {
        let parts = out.split(whereSeparator: { $0 == "\t" || $0 == " " || $0 == "\n" })
        guard parts.count >= 2, let l = Int(parts[0]), let r = Int(parts[1]) else { return nil }
        return (behind: l, ahead: r)
    }

    /// Pure half of `status(at:)`, so every branch below is exercisable without
    /// building four repository shapes on disk.
    ///
    /// `.git` presence is what separates the two ways git exits non-zero: a
    /// directory that simply is not a repository (git says so, and there is no
    /// `.git` to contradict it) from a repository git refused to read (a lock,
    /// a corrupt index, dubious ownership). Only the first is an absence that
    /// was measured; the second is a measurement that failed, and saying "sem
    /// git" for it is the bug.
    public static func classifyStatus(_ result: GitRun, hasDotGit: Bool) -> GitStatus {
        switch result {
        case .ok(let out):
            guard let snapshot = parseStatus(out) else {
                return .unavailable("git respondeu num formato não reconhecido")
            }
            return .state(snapshot)
        case .failed(let code):
            // A repository that exists and would not answer is not an absence.
            return hasDotGit ? .unavailable("git falhou (código \(code))") : .notARepository
        case .timedOut:
            return .unavailable("git não respondeu a tempo")
        case .launchFailed(let why):
            return .unavailable("git não pôde ser executado: \(why)")
        }
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

    /// Runs git and gives up after `timeout`, saying WHICH of those happened.
    ///
    /// The timeout exists because these calls run per card on a screen that
    /// reloads on a timer: a git that blocks (a lock held by another process, a
    /// filesystem that stopped answering) must degrade to a named absence
    /// rather than hang the caller forever.
    ///
    /// THE SHAPE HERE IS LOAD-BEARING AND WAS MEASURED. The previous version
    /// read the pipe on `DispatchQueue.global()` and blocked the CALLER on a
    /// semaphore until that read signalled. Every caller is a
    /// `Task.detached(priority:)`, i.e. a thread of the *cooperative* pool,
    /// which has one thread per core and does not grow — so a screenful of
    /// cards parked every one of those threads on `wait()` and the work that
    /// would signal them could not be scheduled. Measured against 40
    /// concurrent probes of a real repository:
    ///
    ///     cooperative pool + semaphore     32/40 returned nil   in 20.10 s
    ///     dispatch queue   + semaphore      0/40                 in  0.50 s
    ///     cooperative pool, read-then-wait  0/40                 in  0.29 s
    ///
    /// Those nils are the whole of the "sem git" bug: git was never broken, it
    /// was never asked. The middle row shows the semaphore is survivable off
    /// the cooperative pool, which is why this went unseen in a test that
    /// called it serially — the defect only exists at the concurrency the
    /// screen actually runs at.
    ///
    /// So: drain the pipe on the calling thread FIRST, then reap. The original
    /// comment feared the opposite order (blocking on `waitUntilExit` while a
    /// full pipe stalls the child), and that fear was right — reading first is
    /// what makes the pipe unable to fill. A child that hangs without writing
    /// is handled by the watchdog instead of by parking the caller.
    static func invoke(_ args: [String], at path: String,
                       timeout: TimeInterval = 5) -> GitRun {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", path] + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()

        do { try p.run() } catch { return .launchFailed(error.localizedDescription) }

        // The watchdog is disarmed BEFORE the child is waited on, so it can
        // never signal a pid that has already been reaped and reused.
        let watchdog = ProcessWatchdog(p)
        let item = DispatchWorkItem { watchdog.killIfStillRunning() }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: item)

        let data = out.fileHandleForReading.readDataToEndOfFile()
        item.cancel()
        let killed = watchdog.disarm()
        p.waitUntilExit()

        // A terminated child exits by signal, so `terminationStatus` alone
        // cannot say "timed out" — the watchdog having fired is what says it.
        if killed { return .timedOut }
        guard p.terminationStatus == 0 else { return .failed(p.terminationStatus) }
        return .ok(String(data: data, encoding: .utf8) ?? "")
    }

    /// Output-only wrapper for callers that have nothing to do with a failure
    /// beyond skipping it. Anything that puts git on a screen wants `invoke`.
    static func run(_ args: [String], at path: String, timeout: TimeInterval = 5) -> String? {
        if case .ok(let out) = invoke(args, at: path, timeout: timeout) { return out }
        return nil
    }
}

/// Kills a child that overran its timeout, and remembers that it did.
///
/// Two threads meet here — the timer that may kill and the caller that is about
/// to reap — so both operations take the same lock. `disarm()` is what makes
/// `waitUntilExit()` safe to call afterwards: once it returns, no `terminate()`
/// can still be issued against a pid the kernel may have handed to someone else.
final class ProcessWatchdog {
    private let lock = NSLock()
    private let process: Process
    private var disarmed = false
    private var killed = false

    init(_ process: Process) { self.process = process }

    func killIfStillRunning() {
        lock.lock(); defer { lock.unlock() }
        guard !disarmed, process.isRunning else { return }
        process.terminate()
        killed = true
    }

    /// Blocks out any future kill and reports whether one already happened.
    func disarm() -> Bool {
        lock.lock(); defer { lock.unlock() }
        disarmed = true
        return killed
    }
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
