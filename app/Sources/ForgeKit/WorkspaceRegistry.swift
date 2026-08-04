// WorkspaceRegistry — reading and rewriting `~/.claude/forge-gate-workspaces.json`
// without ever losing what the operator put there.
//
// The registry is growing a versioned shape
// (`{ version, roots[], entries[], quarantine[] }`, see S01-PLAN § Canonical
// schema) while nineteen flat absolute strings still sit on disk. Both shapes
// are therefore live at once, and this app is the process most likely to meet
// the wrong one: it re-reads the file on a 15s timer and on every FSEvent.
//
// Two failures are designed against here, both previously real:
//
//   1. The blank list. `Stores.swift` decoded `[String]` with `try?` and
//      returned `[]` on any failure, so the first versioned byte written to that
//      file would have emptied the operator's project list with no error, no
//      log, nothing to notice but months of state gone. A registry that cannot
//      be parsed and a registry with no projects are different facts and must
//      produce different outcomes — `activePaths` returns `nil` for the first
//      and `[]` only for the second.
//
//   2. The save clobber. A tolerant reader alone still leaves the app writing
//      `[String]` back, so the first "Remover" click after migration would
//      destroy `roots[]`, `quarantine[]` and every `repos[]`. `updatedData`
//      therefore rewrites the shape it found, and refuses to write at all when
//      it cannot understand what is already on disk — declining to save is
//      recoverable, overwriting is not.
//
// The mirror is `scripts/forge-workspace.js` (same resolution rules, same
// containment guards); the shared literals live here in one place each so S02's
// parity guard has a single anchor per language.
//
// Pure by construction: every function takes `home` explicitly and touches no
// filesystem. That is what makes the synthetic-`$HOME` tests possible — a codec
// that closes over the ambient home cannot be tested against another one.

import Foundation

public enum WorkspaceRegistry {

    // MARK: - Shared literals (S02 parity anchor — one holder each)

    /// Schema version this app writes, and the newest it fully understands.
    public static let version = 1

    /// Registry basename under `~/.claude/`.
    public static let filename = "forge-gate-workspaces.json"

    public static let keyVersion = "version"
    public static let keyRoots = "roots"
    public static let keyEntries = "entries"
    public static let keyQuarantine = "quarantine"
    public static let keyPath = "path"
    public static let keyRoot = "root"
    public static let keyKind = "kind"
    public static let keyRepos = "repos"
    public static let keyReason = "reason"

    public static let kindProject = "project"
    public static let kindWorkspace = "workspace"
    public static let reasonTouched = "touched"
    public static let reasonScratch = "scratch"

    // MARK: - Results

    public enum Shape: Equatable {
        case legacy
        case versioned(Int)
    }

    /// A stored record that could not be turned into a path. Surfaced rather
    /// than dropped in silence: "this entry is unanchored" and "this project was
    /// deleted from disk" both remove a card from the list, and only one of them
    /// is the operator's own doing.
    public struct Rejection: Equatable {
        public let stored: String
        public let reason: String
    }

    public struct Resolution {
        public let paths: [String]
        public let rejected: [Rejection]
        public let shape: Shape

        /// The registry's declared roots, resolved to absolute paths against the
        /// explicit `home`. This is what discovery scans (see
        /// `ProjectDiscovery.scan(declaredRoots:)`); the hardcoded name list is
        /// only a seed for migration and first run.
        ///
        /// Empty — never `nil` — for the legacy `[String]` shape, which has no
        /// place to declare a root. "No roots declared" and "the file could not
        /// be read" stay different facts: the second is still the `nil`
        /// `Resolution` and nothing else.
        public let roots: [String]

        /// Absolute paths whose active record declares `kind: "workspace"` —
        /// the operator's statement that this directory containing the others
        /// is the point, not an accident. Consumed by
        /// `ProjectOrganiser.containmentHazards`.
        ///
        /// Empty for the legacy `[String]` shape, which has no field to declare
        /// a kind in. That is the honest answer rather than a guess, and it
        /// leaves the containment hazard behaving on legacy files exactly as it
        /// did before workspaces existed.
        ///
        /// Read from `entries[]` only. A quarantined row is not active, so it
        /// cannot be the container of anything on screen.
        public let declaredWorkspaces: Set<String>

        /// How many repos each active entry DECLARES it owns, keyed by
        /// absolute path — for `ProjectDigest`'s "workspace · 33 repos" line.
        ///
        /// An entry appears here only when its `repos[]` is non-empty, so a
        /// missing key means "never measured" and not "owns zero repos". That
        /// distinction is the whole value of the field: `repos[]` was created
        /// by the schema and, as `forge-workspace.js` says outright, nothing
        /// has ever populated it — every live entry on disk carries `repos:
        /// []`, `lookchina` included, while holding 33 repos in reality.
        /// Rendering that `[]` as "0 repos" would put a measured-looking zero
        /// on screen for the single most repo-dense project registered.
        public let repoCounts: [String: Int]
    }

    struct ResolveError: Error { let reason: String }

    // MARK: - Path rules (mirror of forge-workspace.js)

    /// `/a/b` contains `/a/b/c`, and pointedly does not contain `/a/bc`.
    /// The separator is the whole point — a bare `hasPrefix` makes siblings look
    /// nested, which is how a path escapes a root while appearing to honour it.
    static func isStrictlyUnder(_ child: String, _ parent: String) -> Bool {
        if child == parent { return false }
        let base = parent.hasSuffix("/") ? parent : parent + "/"
        return child.hasPrefix(base)
    }

    static func normalize(_ p: String) -> String {
        URL(fileURLWithPath: p).standardized.path
    }

    /// Expand a leading `~` against an explicit home. Non-`~` paths pass through.
    static func expandTilde(_ p: String, home: String) -> String {
        let h = normalize(home)
        if p == "~" { return h }
        if p.hasPrefix("~/") { return normalize(h + "/" + String(p.dropFirst(2))) }
        return p
    }

    /// Store a path `~`-relative when it is under home, absolute otherwise.
    static func tildify(_ absPath: String, home: String) -> String {
        let abs = normalize(absPath)
        let h = normalize(home)
        if abs == h { return "~" }
        if isStrictlyUnder(abs, h) { return "~/" + String(abs.dropFirst(h.count + 1)) }
        return abs
    }

    /// Decode one stored record to an absolute path.
    ///
    /// This is where semi-trusted input reaches a path join: the file is
    /// hand-editable, so `path` is not ours. Every branch ends in an explicit
    /// containment check rather than trusting the join — appending `../../etc`
    /// to a root resolves happily outside it and says nothing about it.
    static func resolveStored(path stored: String, root: String?, home: String) throws -> String {
        guard !stored.isEmpty else { throw ResolveError(reason: "empty path") }
        let homeAbs = normalize(home)
        let isHomeRelative = stored == "~" || stored.hasPrefix("~/")

        guard let root, !root.isEmpty else {
            if isHomeRelative {
                let abs = expandTilde(stored, home: homeAbs)
                guard abs == homeAbs || isStrictlyUnder(abs, homeAbs) else {
                    throw ResolveError(reason: "rootless entry escapes home after normalisation")
                }
                return abs
            }
            if stored.hasPrefix("/") { return normalize(stored) }
            throw ResolveError(reason: "relative but declares no root — unanchored, refusing to guess")
        }

        if stored.hasPrefix("/") {
            throw ResolveError(reason: "absolute but declares a root — contradictory")
        }
        if isHomeRelative {
            throw ResolveError(reason: "home-relative but declares a root — contradictory")
        }
        guard root == "~" || root.hasPrefix("~/") || root.hasPrefix("/") else {
            throw ResolveError(reason: "root \"\(root)\" is neither absolute nor ~-anchored — refusing to guess")
        }
        let rootAbs = normalize(expandTilde(root, home: homeAbs))
        let abs = normalize(rootAbs + "/" + stored)
        guard isStrictlyUnder(abs, rootAbs) else {
            throw ResolveError(reason: "escapes its root \"\(root)\" after normalisation")
        }
        return abs
    }

    /// Absolute location of one stored root, against an explicit home.
    ///
    /// Mirror of `resolveRootPath` in `scripts/forge-workspace.js`, and it
    /// refuses for the same reason: a root that is neither absolute nor
    /// `~`-anchored would resolve against the process's launch directory. That
    /// is a worse failure here than in the codec — a misresolved *entry* points
    /// at one wrong folder, a misresolved *root* is an entire wrong subtree of
    /// the operator's disk walked by discovery.
    static func resolveRootStored(_ stored: String, home: String) throws -> String {
        guard !stored.isEmpty else { throw ResolveError(reason: "empty root path") }
        guard stored == "~" || stored.hasPrefix("~/") || stored.hasPrefix("/") else {
            throw ResolveError(
                reason: "root \"\(stored)\" is neither absolute nor ~-anchored — refusing to guess")
        }
        return normalize(expandTilde(stored, home: home))
    }

    /// Roots may be stored as `{path, primary}` objects or as bare strings —
    /// `normalizeRootEntry`'s two accepted forms, kept in sync deliberately.
    ///
    /// `primary` is deliberately *not* read (decision D2): it marks where new
    /// work is offered, which is not a scanning fact. Declaration order is
    /// preserved instead, so the first root stays first for whoever does care —
    /// but every declared root is walked, and none is walked differently.
    ///
    /// Anything unusable becomes a `Rejection` and never a silent drop. A root
    /// that disappears without a word shrinks the scan, and the operator sees
    /// only a project list that quietly got shorter.
    static func parseRoots(_ list: Any?, home: String, into rejected: inout [Rejection]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        for (i, item) in ((list as? [Any]) ?? []).enumerated() {
            var stored: String?
            if let s = item as? String {
                stored = s
            } else if let rec = item as? [String: Any], let s = rec[keyPath] as? String {
                stored = s
            }
            guard let stored else {
                rejected.append(Rejection(
                    stored: "\(item)", reason: "roots[\(i)] is not a path or {path,...}"))
                continue
            }
            do {
                let abs = try resolveRootStored(stored, home: home)
                if seen.insert(abs).inserted { out.append(abs) }
            } catch let e as ResolveError {
                rejected.append(Rejection(stored: stored, reason: e.reason))
            } catch {
                rejected.append(Rejection(stored: stored, reason: "\(error)"))
            }
        }
        return out
    }

    // MARK: - Reading

    /// Every path the app should show, from either shape: legacy `[String]`, or
    /// version-1 active entries ∪ quarantine.
    ///
    /// Quarantine is included on purpose — those directories are already on
    /// screen in the touched strip with a remove action, and dropping them here
    /// would make them vanish between this slice and the quarantine UI.
    ///
    /// Returns `nil` — never `[]` — when the bytes cannot be understood.
    public static func resolution(from data: Data, home: String) -> Resolution? {
        guard let raw = try? JSONSerialization.jsonObject(with: data) else { return nil }

        if let legacy = raw as? [String] {
            var paths: [String] = []
            var rejected: [Rejection] = []
            for s in legacy where !s.isEmpty {
                if s.hasPrefix("/") || s.hasPrefix("~") {
                    paths.append(expandTilde(s, home: home))
                } else {
                    rejected.append(Rejection(stored: s, reason: "legacy entry is not an absolute path"))
                }
            }
            // No roots key exists in the flat shape, so there is nothing to
            // declare: `[]`, and the caller falls back to the seed default.
            return Resolution(paths: paths, rejected: rejected, shape: .legacy,
                              roots: [], declaredWorkspaces: [], repoCounts: [:])
        }

        guard let obj = raw as? [String: Any] else { return nil }
        let declared = obj[keyVersion] as? Int
        // A versioned file we do not fully know is still read: refusing here
        // would blank the list, which is the defect this type exists to remove.
        // Only a shape with none of the schema's arrays is genuinely unreadable.
        let hasShape = obj[keyEntries] != nil || obj[keyQuarantine] != nil || obj[keyRoots] != nil
        guard declared != nil || hasShape else { return nil }

        var paths: [String] = []
        var rejected: [Rejection] = []
        var seen = Set<String>()
        var declaredWorkspaces = Set<String>()
        var repoCounts: [String: Int] = [:]

        func take(_ list: Any?, active: Bool) {
            for case let rec as [String: Any] in (list as? [Any] ?? []) {
                guard let stored = rec[keyPath] as? String else {
                    rejected.append(Rejection(stored: "\(rec)", reason: "record has no path"))
                    continue
                }
                do {
                    let abs = try resolveStored(path: stored, root: rec[keyRoot] as? String, home: home)
                    if seen.insert(abs).inserted { paths.append(abs) }
                    if active, rec[keyKind] as? String == kindWorkspace {
                        declaredWorkspaces.insert(abs)
                    }
                    // Non-empty only: an empty `repos[]` is "never measured"
                    // here, never a measured zero — see `repoCounts`.
                    if active, let repos = rec[keyRepos] as? [Any], !repos.isEmpty {
                        repoCounts[abs] = repos.count
                    }
                } catch let e as ResolveError {
                    rejected.append(Rejection(stored: stored, reason: e.reason))
                } catch {
                    rejected.append(Rejection(stored: stored, reason: "\(error)"))
                }
            }
        }
        take(obj[keyEntries], active: true)
        take(obj[keyQuarantine], active: false)

        let roots = parseRoots(obj[keyRoots], home: home, into: &rejected)

        return Resolution(paths: paths, rejected: rejected,
                          shape: .versioned(declared ?? version), roots: roots,
                          declaredWorkspaces: declaredWorkspaces, repoCounts: repoCounts)
    }

    /// Convenience over `resolution` for the common caller.
    public static func activePaths(from data: Data, home: String) -> [String]? {
        resolution(from: data, home: home)?.paths
    }

    // MARK: - Writing

    /// The `newPaths` a mutation (`add`/`remove`) should pass to `updatedData` —
    /// the call site the I-20260803132250 invariant lives at.
    ///
    /// `allResolved` MUST be every record the registry resolves
    /// (`Workspaces.loadAllResolved()`), never the `fileExists`-filtered list
    /// (`Workspaces.load()`). `updatedData` prunes any record absent from the
    /// `newPaths` it is given (`prune`, above): a record whose directory does
    /// not currently exist still resolves fine (`resolveStored` is pure and
    /// never touches disk) but would not appear in a *filtered* list, and
    /// pruning would delete it — quarantine rows included — as the side effect
    /// of an unrelated add/remove. That mechanism is proven in
    /// `ForgeKitTests` (`WorkspaceRegistry: R2 …` and the T05 call-site
    /// regression) directly against `updatedData`; this function is the one
    /// production call site the invariant depends on, made pure so it can be
    /// exercised the same way `Stores.swift` calls it.
    ///
    /// This function takes only `allResolved` on purpose — there is no
    /// `visible`/filtered parameter to accept, because accepting one would
    /// reopen exactly the mistake this exists to close. The one case where a
    /// caller had reason to consult the filtered list (deciding what to show
    /// on screen) never has reason to reach this function at all.
    public static func mutatedPaths(allResolved: [String], adding: String? = nil, removing: String? = nil) -> [String] {
        var out = allResolved
        if let removing { out = out.filter { $0 != removing } }
        if let adding { out.append(adding) }
        return out
    }

    /// The bytes to write so that the registry holds exactly `newPaths`, in the
    /// shape it already had.
    ///
    /// Returns `nil` when `original` exists but cannot be understood. That is a
    /// refusal to save, and it is deliberate: the alternative is replacing a
    /// file we could not read with one we invented, which loses `roots[]`,
    /// `quarantine[]` and `repos[]` in exchange for a click that appeared to
    /// work. A refused save is visible and recoverable.
    public static func updatedData(original: Data?, newPaths: [String], home: String) -> Data? {
        guard let original, !original.isEmpty else { return legacyData(newPaths) }
        guard let raw = try? JSONSerialization.jsonObject(with: original) else { return nil }
        if raw is [String] { return legacyData(newPaths) }
        guard var obj = raw as? [String: Any] else { return nil }

        // A file declaring a schema version newer than this app understands is
        // read tolerantly (see `resolution`) but must never be rewritten: v1
        // pruning/write rules could misread or drop records from a shape this
        // app has not seen, and writing back would silently downgrade the
        // declared version's guarantees while keeping its number. Refusing to
        // save is the same recoverable-over-destructive posture as the "cannot
        // be understood" case just above.
        if let declared = obj[keyVersion] as? Int, declared > version {
            return nil
        }

        var wanted = Set(newPaths.map { normalize(expandTilde($0, home: home)) })

        // Records whose path no longer resolves are kept verbatim. They are not
        // in `newPaths` because the reader could not offer them, so removing
        // them here would delete, as a side effect of an unrelated click, the
        // rows the operator most needs to see in order to fix them by hand.
        func prune(_ list: Any?) -> [Any] {
            (list as? [Any] ?? []).filter { item in
                guard let rec = item as? [String: Any], let stored = rec[keyPath] as? String
                else { return true }
                guard let abs = try? resolveStored(
                    path: stored, root: rec[keyRoot] as? String, home: home) else { return true }
                if wanted.contains(abs) { wanted.remove(abs); return true }
                return false
            }
        }

        var entries = prune(obj[keyEntries])
        let quarantine = prune(obj[keyQuarantine])

        // Anything left is new to the file. It is stored `root: null` and
        // `kind: project`; both are display caches that the JS loader recomputes
        // on the next load, so guessing a root here would only be a guess that
        // outlives the click that made it.
        for abs in wanted.sorted() {
            entries.append([
                keyRoot: NSNull(),
                keyPath: tildify(abs, home: home),
                keyKind: kindProject,
                keyRepos: [String](),
            ] as [String: Any])
        }

        obj[keyEntries] = entries
        obj[keyQuarantine] = quarantine
        if obj[keyVersion] == nil { obj[keyVersion] = version }

        return try? JSONSerialization.data(
            withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    }

    /// The pre-existing legacy encoding, unchanged: deduped and sorted strings.
    /// Converting a legacy file is the CLI migration's job, not a side effect of
    /// the app happening to add a project.
    static func legacyData(_ paths: [String]) -> Data? {
        try? JSONEncoder().encode(Array(Set(paths)).sorted())
    }
}

/// The decision `AppState.reloadCheap()` (Forge target) makes about whether to
/// rebuild `workspaces`/`touchedWorkspaces` from a fresh `loadOutcome()`, split
/// out as a pure function so it is testable from `ForgeKitTests` without
/// importing the `Forge` executable target.
///
/// When the registry could not be read, the on-screen notice tells the operator
/// "the list below was NOT changed" — this function is what makes that literally
/// true: on `unreadable`, the previous split is returned untouched rather than
/// being rebuilt from `outcome.visible` (which is always `[]` on that path).
public enum WorkspaceReloadDecision {
    public struct Split: Equatable {
        public let workspaces: [String]
        public let touchedWorkspaces: [String]
        public init(workspaces: [String], touchedWorkspaces: [String]) {
            self.workspaces = workspaces
            self.touchedWorkspaces = touchedWorkspaces
        }
    }

    /// - Parameters:
    ///   - previous: the split currently on screen, before this reload.
    ///   - outcome: the result of `Workspaces.loadOutcome()`.
    ///   - isProject: classification for a registered path (true = project,
    ///     false = touched-but-not-project). Mirrors `ProjectMarker.classify`.
    public static func split(
        previous: Split,
        outcome: (visible: [String], unreadable: Bool),
        isProject: (String) -> Bool
    ) -> Split {
        guard !outcome.unreadable else { return previous }
        let marks = outcome.visible.map { ($0, isProject($0)) }
        return Split(
            workspaces: marks.filter { $0.1 }.map(\.0),
            touchedWorkspaces: marks.filter { !$0.1 }.map(\.0))
    }
}
