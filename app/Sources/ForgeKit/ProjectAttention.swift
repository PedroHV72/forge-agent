// ProjectAttention — what a folder must say about what it hides, and the one
// order both the flat list and the tree are drawn in.
//
// Two failures this file exists to close, and they are the same failure:
//
//   1. A COLLAPSED FOLDER THAT HIDES AN ACTIVE RUN IS SILENT. The tree drew a
//      folder header with a project count and, transitively, pending gates —
//      and nothing else. Collapse it and a run executing underneath, a tree
//      with uncommitted work, vanished from the screen entirely. That is the
//      exact shape this codebase has paid for repeatedly: an absence of signal
//      that is indistinguishable from an absence of activity.
//
//   2. THE TREE WAS SORTED BY PATH WHILE THE FLAT LIST WAS SORTED BY
//      ATTENTION. Two orders for one question ("where do I go now?"), so the
//      answer changed when the operator flipped a segmented control. There is
//      one comparator here and both views call it.
//
// The rollup is transitive by construction (`rollup` recurses through folders
// and sums registrable descendants at any depth) because the count it replaces
// already was: a grandparent that stopped at its direct children would restate
// the immediate-parent bug `ProjectTree` was built to remove.
//
// Pure and injectable, like `ProjectTree` and for the same reason: `attention`
// arrives as a closure, so the view supplies live state and the tests supply a
// dictionary. Nothing here reads the filesystem, the registry or `$HOME`.
//
// ONE ASYMMETRY IS DELIBERATE. `questions` and `runs` are always known — they
// come from files the reload already read for every project. `dirty` is git,
// which costs ~102 ms per project (see `ProjectDigest`), so a collapsed folder
// generally has NOT measured its children. `ProjectAttention.dirty` is
// therefore `Bool?` and the rollup carries `dirtyUnmeasured` beside `dirty`:
// "1 com alterações" is a claim about measured trees, and a folder whose
// children were never probed says nothing about dirtiness rather than
// reporting a zero it did not earn. Same rule as
// `WorkspaceRegistry.repoCounts` — a missing measurement is not a measured
// zero.

import Foundation

/// Live signals for ONE project. `dirty == nil` means git was not measured.
public struct ProjectAttention: Equatable, Sendable {
    public let questions: Int
    public let runs: Int
    public let dirty: Bool?

    public init(questions: Int = 0, runs: Int = 0, dirty: Bool? = nil) {
        self.questions = questions
        self.runs = runs
        self.dirty = dirty
    }

    /// A project nothing is known about — what the provider returns for a path
    /// it has no state for. Distinct from "measured and quiet" only in `dirty`.
    public static let none = ProjectAttention()
}

/// The same signals summed over a subtree, plus how many projects are in it.
public struct ProjectRollup: Equatable, Sendable {
    /// Registrable descendants at any depth. A folder does not count itself.
    public let projects: Int
    public let questions: Int
    public let runs: Int
    /// Projects measured dirty. Read together with `dirtyUnmeasured`.
    public let dirty: Int
    /// Projects whose git was never probed. `dirty == 0` while this is > 0 does
    /// NOT mean every tree is clean.
    public let dirtyUnmeasured: Int

    public init(projects: Int, questions: Int, runs: Int, dirty: Int, dirtyUnmeasured: Int) {
        self.projects = projects
        self.questions = questions
        self.runs = runs
        self.dirty = dirty
        self.dirtyUnmeasured = dirtyUnmeasured
    }

    public static let empty = ProjectRollup(projects: 0, questions: 0, runs: 0,
                                            dirty: 0, dirtyUnmeasured: 0)

    /// Something in here wants the operator. Dirtiness deliberately does not
    /// qualify: an uncommitted file is a fact, not a summons.
    public var needsAttention: Bool { questions > 0 || runs > 0 }

    public func adding(_ other: ProjectRollup) -> ProjectRollup {
        ProjectRollup(projects: projects + other.projects,
                      questions: questions + other.questions,
                      runs: runs + other.runs,
                      dirty: dirty + other.dirty,
                      dirtyUnmeasured: dirtyUnmeasured + other.dirtyUnmeasured)
    }

    /// What a COLLAPSED folder prints, e.g.
    /// `"5 projetos · 2 perguntas · 1 run · 1 com alterações"`.
    ///
    /// Zero segments are omitted rather than printed: "0 perguntas" is the
    /// counter row this whole change removed from the card. The project count
    /// is always present, so the line is never empty — a folder that says
    /// nothing at all reads like a rendering bug.
    public var summary: String {
        var parts = ["\(projects) \(projects == 1 ? "projeto" : "projetos")"]
        if questions > 0 { parts.append("\(questions) \(questions == 1 ? "pergunta" : "perguntas")") }
        if runs > 0 { parts.append("\(runs) \(runs == 1 ? "run" : "runs")") }
        if dirty > 0 { parts.append("\(dirty) com alterações") }
        return parts.joined(separator: " · ")
    }
}

public enum ProjectTreeAttention {

    // MARK: - Rollup

    /// Signals for everything under `node`, plus `node` itself when it is a
    /// registrable project. A workspace containing projects therefore reports
    /// its own run AND its members'.
    public static func rollup(_ node: ProjectTreeNode,
                              attention: (String) -> ProjectAttention) -> ProjectRollup {
        var out = node.role.isRegistrable
            ? single(attention(node.path))
            : .empty
        for child in node.children {
            out = out.adding(rollup(child, attention: attention))
        }
        return out
    }

    /// One project's signals as a rollup of one.
    public static func single(_ a: ProjectAttention) -> ProjectRollup {
        ProjectRollup(projects: 1,
                      questions: a.questions,
                      runs: a.runs,
                      dirty: a.dirty == true ? 1 : 0,
                      dirtyUnmeasured: a.dirty == nil ? 1 : 0)
    }

    // MARK: - Order

    /// Attention first, then name. THE comparator — `ordered(nodes:)` and
    /// `ordered(paths:)` are both this function, so the flat list and the tree
    /// cannot disagree about which project comes first.
    ///
    /// Path is the final tiebreak so the order is a function of the set and
    /// never of arrival order (same rule as `ProjectTree.sorted`).
    public static func precedes(_ a: (rollup: ProjectRollup, path: String),
                                _ b: (rollup: ProjectRollup, path: String)) -> Bool {
        if a.rollup.questions != b.rollup.questions { return a.rollup.questions > b.rollup.questions }
        if a.rollup.runs != b.rollup.runs { return a.rollup.runs > b.rollup.runs }
        let na = ProjectOrganiser.name(a.path), nb = ProjectOrganiser.name(b.path)
        let cmp = na.localizedCaseInsensitiveCompare(nb)
        if cmp != .orderedSame { return cmp == .orderedAscending }
        return a.path < b.path
    }

    /// Siblings ordered by what they are hiding: a quiet folder sinks below a
    /// folder with a question inside it, however the names sort.
    public static func ordered(_ nodes: [ProjectTreeNode],
                               attention: (String) -> ProjectAttention) -> [ProjectTreeNode] {
        nodes
            .map { (rollup: rollup($0, attention: attention), node: $0) }
            .sorted { precedes(($0.rollup, $0.node.path), ($1.rollup, $1.node.path)) }
            .map(\.node)
    }

    /// The flat list, through the same comparator.
    public static func ordered(paths: [String],
                               attention: (String) -> ProjectAttention) -> [String] {
        paths
            .map { (rollup: single(attention($0)), path: $0) }
            .sorted { precedes(($0.rollup, $0.path), ($1.rollup, $1.path)) }
            .map(\.path)
    }
}

// MARK: - Visual weight

/// How heavy a row is drawn, by what it IS rather than how deep it sits.
///
/// The screen this replaces gave a synthesised folder header and a real project
/// card almost the same weight, so the hierarchy was present in the indentation
/// and absent from the eye. The four levels are ranked deliberately:
///
///   - `.root`      a declared scan root — context, not a destination.
///   - `.workspace` the thing that owns repos. Loudest.
///   - `.project`   the normal case. Neutral, and the baseline the others are
///                  read against.
///   - `.folder`    a path component that exists only because a project is
///                  below it. Nearly invisible.
///
/// Derived from `ProjectRole` (which the tree already carries) plus depth,
/// never from depth alone — a workspace nested three levels down is still a
/// workspace.
public enum ProjectWeight: String, Sendable, Equatable, CaseIterable {
    case root, workspace, project, folder

    /// Point size for the row's title.
    public var titleSize: Double {
        switch self {
        case .root: return 11
        case .workspace: return 15
        case .project: return 13
        case .folder: return 11
        }
    }

    /// Opacity of the row's chrome. Monotone with prominence, which is the
    /// property the test asserts rather than the four literals.
    public var opacity: Double {
        switch self {
        case .root: return 0.55
        case .workspace: return 1.0
        case .project: return 0.9
        case .folder: return 0.5
        }
    }

    public var isBold: Bool { self == .workspace }

    public static func of(role: ProjectRole, depth: Int) -> ProjectWeight {
        switch role {
        case .workspace: return .workspace
        case .project: return .project
        case .folder: return depth == 0 ? .root : .folder
        }
    }
}

// MARK: - Collapse persistence

/// Which folders the operator left closed, as one defaults string.
///
/// Newline-joined absolute paths rather than JSON: the value is a set of
/// strings that cannot contain a newline (they are paths), so encoding it as a
/// document would buy nothing and add a decode failure mode. A path that no
/// longer exists is kept, not pruned — a folder briefly unmounted must come
/// back closed, the way the operator left it.
public enum CollapseStore {

    public static func decode(_ raw: String) -> Set<String> {
        Set(raw.split(separator: "\n").map(String.init).filter { !$0.isEmpty })
    }

    /// Sorted so an unchanged set never rewrites defaults with a reshuffled
    /// string.
    public static func encode(_ paths: Set<String>) -> String {
        paths.filter { !$0.isEmpty }.sorted().joined(separator: "\n")
    }
}
