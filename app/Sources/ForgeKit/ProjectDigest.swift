// ProjectDigest — what a project card should say about a project.
//
// The card it feeds previously rendered two live counters, `runsHere.count`
// and `openItems`, and both are zero almost all the time: a project with no
// RUNNING run and no OPEN item reads "0 perguntas · 0 runs · 0 sessões · 0
// itens". Measured on the operator's machine, all three registered projects
// read exactly that. The numbers are correct and say nothing — a card whose
// whole area is spent asserting absence.
//
// Everything needed to tell the three projects apart is already on disk and
// none of it reached the screen: `.gsd/PROJECT.md` says what the project IS,
// `.gsd/ledger/` says what it last DELIVERED, git says where it stands, and
// the registry says whether it is a workspace and how many repos it owns.
//
// Two properties are load-bearing here and neither is decoration:
//
//   1. EVERY FIELD IS INDEPENDENTLY OPTIONAL AND EVERY ABSENCE IS NAMED.
//      There is no code path in this file that yields an empty string. A
//      project with no PROJECT.md says "sem PROJECT.md — nenhuma descrição
//      registrada"; it never renders a blank line that the operator has to
//      guess is data or a bug. The milestone this lands in existed because
//      silence was indistinguishable from a broken detector; a digest that
//      renders blanks would reintroduce that in the UI layer.
//
//   2. COST IS BOUNDED BY CONSTRUCTION, NOT BY A CACHE — and the bound was
//      MEASURED against the operator's real 20 registered projects rather
//      than reasoned about. `load` runs per card on a screen that reloads
//      every 15 s and on FSEvents, so the naive implementation (read a whole
//      ledger per project per reload) is not available. Instead:
//
//        - `.gsd/PROJECT.md` is read HEAD-BOUNDED (8 KiB, and the scan stops
//          at the first prose line anyway) — measured 0.29 ms/card.
//        - The ledger fragment is chosen by **stat only**, and exactly ONE
//          file is read, head-bounded — so `lookchina`'s 82-fragment ledger
//          costs the same as this repo's 3. Measured 0.48 ms/card.
//        - Git is ONE process. Measured 102 ms/card.
//
//      Those numbers are why the git call was rewritten mid-task. The first
//      measurement was 256 ms/card, of which 261 was git (three spawns:
//      `rev-parse` + `status` + `rev-list`), and no single command was
//      pathological — 41-83 ms each in the shell. The spawn COUNT was the
//      cost. `git status --porcelain --branch` answers branch, dirtiness and
//      divergence at once, which took the whole digest to 104 ms/card with
//      nothing to invalidate. It also removed a correctness hazard nobody
//      asked about: three calls sample three instants and can disagree.
//
//      A cache was still rejected. The only field expensive enough to want
//      one is git, and the mtimes that would key it (`.git/HEAD`,
//      `.git/index`) do not move when an UNTRACKED file appears — a
//      dirty-state cache keyed on them would print "limpo" for a tree that is
//      not, which is a worse thing to own than the spawn it saves.
//
//      The residual ~102 ms/card is real and is NOT hidden here: it is left
//      to the CALLER to stage, via the `GitProbe` seam. `git: .none` yields a
//      complete, correct digest — every other field intact, git named absent
//      — in 0.77 ms/card, so a view can paint the cheap fields on the reload
//      path and fill git in off it. That decision belongs to the view, which
//      knows about threads and paint order; this file does not.
//
// Pure and injectable throughout: paths, `FileManager`, `now` and the git
// probe all arrive as parameters. Nothing here consults `$HOME`, because
// `swift run ForgeKitTests` sees the REAL home when launched by hand and an
// isolated one under `run-tests.js`, so an ambient read passes in one launch
// path and lies in the other.

import Foundation

// MARK: - Field types

/// A string the card can print, or a NAMED reason it cannot.
///
/// The absence carries its own sentence rather than a flag the view has to
/// translate: keeping the wording here is what makes "never blank" a property
/// the test suite can assert instead of a convention the view is trusted to
/// follow.
public enum DigestText: Equatable {
    case present(String)
    case absent(String)

    /// Always non-empty — this is the invariant the whole type exists for.
    public var display: String {
        switch self {
        case .present(let s), .absent(let s): return s
        }
    }

    public var isPresent: Bool {
        if case .present = self { return true }
        return false
    }
}

/// What the project last delivered, from its ledger fragment store.
public struct DigestActivity: Equatable {
    /// The fragment's `title:`.
    public let title: String
    /// `"hoje"`, `"ontem"`, `"3d"`, `"2sem"`, `"5mes"`, `"2a"`.
    public let age: String
    /// True when `age` was derived from the fragment's file modification time
    /// because its `completed_at:` was empty — the shape every fragment
    /// produced by `forge-ledger-migrate` has. Surfaced rather than hidden so
    /// the view can mark an inferred date if it chooses to; a date read off
    /// the filesystem is a weaker claim than one the ledger stated.
    public let ageInferred: Bool

    public init(title: String, age: String, ageInferred: Bool) {
        self.title = title
        self.age = age
        self.ageInferred = ageInferred
    }
}

public enum DigestActivityField: Equatable {
    case entry(DigestActivity)
    case absent(String)

    public var entryValue: DigestActivity? {
        if case .entry(let e) = self { return e }
        return nil
    }
}

/// Where the working tree stands, as one printable line.
///
/// The state itself is `GitStatusSnapshot` in `GitCore.swift` — the digest
/// adds the pt-BR rendering here rather than declaring a second four-field
/// struct with the same contents, which is how the two would drift.
public extension GitStatusSnapshot {

    /// `"main · limpo · ↑3"` — assembled here so the view cannot assemble it
    /// differently somewhere else.
    ///
    /// With no upstream the divergence segment reads "sem upstream" instead of
    /// being omitted: an omitted segment is indistinguishable from "in sync",
    /// and those are different facts about a branch.
    var line: String {
        var parts = [branch, dirty ? "alterações" : "limpo"]
        if let ahead, let behind {
            var d: [String] = []
            if ahead > 0 { d.append("↑\(ahead)") }
            if behind > 0 { d.append("↓\(behind)") }
            if !d.isEmpty { parts.append(d.joined(separator: " ")) }
        } else {
            parts.append("sem upstream")
        }
        return parts.joined(separator: " · ")
    }
}

public enum DigestGitField: Equatable {
    case state(GitStatusSnapshot)
    case absent(String)

    public var stateValue: GitStatusSnapshot? {
        if case .state(let s) = self { return s }
        return nil
    }
}

/// The pt-BR word for a role on a card. Lives here, not on `ProjectRole` in
/// `ProjectMarker.swift`, because that type is the tree's structural
/// vocabulary and has no other presentation concern — the digest is what puts
/// a role in front of a human.
public extension ProjectRole {
    var label: String {
        switch self {
        case .workspace: return "workspace"
        case .project: return "projeto"
        case .folder: return "pasta"
        }
    }
}

// MARK: - The digest

public struct ProjectDigest: Equatable {
    public let role: ProjectRole
    /// nil = the registry never measured this entry's repos. NOT zero — see
    /// `WorkspaceRegistry.Resolution.repoCounts`.
    public let repos: Int?
    public let identity: DigestText
    public let activity: DigestActivityField
    public let git: DigestGitField

    public init(role: ProjectRole, repos: Int?, identity: DigestText,
                activity: DigestActivityField, git: DigestGitField) {
        self.role = role
        self.repos = repos
        self.identity = identity
        self.activity = activity
        self.git = git
    }

    /// `"workspace · 33 repos"`, or just `"workspace"` when the count was
    /// never measured. Deliberately silent rather than saying "0 repos",
    /// which would be a measured-looking claim about something unmeasured.
    public var roleLine: String {
        guard let repos, repos > 0 else { return role.label }
        return "\(role.label) · \(repos) repo\(repos == 1 ? "" : "s")"
    }
}

// MARK: - Loading

/// The git state the digest needs, behind a seam.
///
/// Injectable so divergence rendering can be exercised without building a repo
/// that has a real upstream (two repos and a push), and — the reason that
/// matters more — so the caller can decide WHEN to pay for git at all. Git is
/// the only expensive field: measured across the 20 projects registered on
/// this machine, the file reads cost 1.5 ms per card and git costs 82 ms even
/// after collapsing three processes into one. A first paint can pass `.none`
/// and fill git in afterwards without this type knowing.
public struct GitProbe {
    public var snapshot: (String) -> GitStatusSnapshot?

    public init(snapshot: @escaping (String) -> GitStatusSnapshot?) {
        self.snapshot = snapshot
    }

    public static let system = GitProbe(snapshot: { Git.statusSnapshot(at: $0) })

    /// Answers nothing — a directory that is not a repo, or a caller that has
    /// chosen not to pay for git yet.
    public static let none = GitProbe(snapshot: { _ in nil })
}

extension ProjectDigest {

    /// Bytes read from `.gsd/PROJECT.md`. The scan stops at the first prose
    /// line, which in every PROJECT.md the generator writes is line 3; the
    /// bound is what keeps a pathological file from being read whole on a
    /// timer.
    public static let projectDocReadLimit = 8 * 1024

    /// Longest identity line put on a card before it is elided.
    public static let identityLimit = 120

    public static func load(path: String,
                            role: ProjectRole,
                            repos: Int?,
                            fileManager fm: FileManager = .default,
                            now: Date = Date(),
                            calendar: Calendar = .current,
                            git probe: GitProbe = .system) -> ProjectDigest {
        ProjectDigest(
            role: role,
            repos: repos,
            identity: loadIdentity(path: path, fileManager: fm),
            activity: loadActivity(path: path, fileManager: fm, now: now, calendar: calendar),
            git: loadGit(path: path, probe: probe)
        )
    }

    // MARK: Identity

    static func loadIdentity(path: String, fileManager fm: FileManager) -> DigestText {
        let doc = "\(path)/.gsd/PROJECT.md"
        guard fm.fileExists(atPath: doc) else {
            return .absent("sem PROJECT.md — nenhuma descrição registrada")
        }
        guard let text = Ledger.readHead(path: doc, limit: projectDocReadLimit) else {
            return .absent("PROJECT.md ilegível")
        }
        return identityLine(fromProjectDoc: text)
    }

    /// First meaningful prose line of a PROJECT.md.
    ///
    /// Skipped: blank lines, ATX headings (`# Project: lookchina` is the file
    /// name restated, not a description), blockquotes, horizontal rules, and
    /// HTML comments. The first line that survives is the description the
    /// generator writes directly under the title.
    ///
    /// Stops at the first `##` section: a PROJECT.md that opens straight into
    /// `## Stack` has no description, and taking the first bullet of the stack
    /// list instead would print "**Workspace:** Diretório raiz…" as though it
    /// were the project's identity.
    public static func identityLine(fromProjectDoc text: String) -> DigestText {
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("##") {
                return .absent("PROJECT.md sem descrição")
            }
            if line.hasPrefix("#") || line.hasPrefix(">") || line.hasPrefix("<!--")
                || line == "---" || line == "***" { continue }
            let cleaned = stripEmphasis(line)
            if cleaned.isEmpty { continue }
            return .present(elide(cleaned, to: identityLimit))
        }
        return .absent("PROJECT.md sem descrição")
    }

    /// Drops markdown emphasis markers so a description written as `**Foo**`
    /// prints as `Foo`. Not a markdown renderer — this is one line of prose.
    static func stripEmphasis(_ s: String) -> String {
        s.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    /// Truncates on a word boundary, never mid-word, and only when the string
    /// is actually over the limit.
    public static func elide(_ s: String, to limit: Int) -> String {
        guard s.count > limit else { return s }
        let head = String(s.prefix(limit))
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > limit / 2 {
            return String(head[head.startIndex..<space]) + "…"
        }
        return head + "…"
    }

    // MARK: Activity

    static func loadActivity(path: String, fileManager fm: FileManager,
                             now: Date, calendar: Calendar) -> DigestActivityField {
        let dir = "\(path)/.gsd/ledger"
        guard let newest = Ledger.newest(dir: dir, fileManager: fm) else {
            return .absent("nenhuma entrega registrada")
        }
        guard let title = newest.fragment.title, !title.isEmpty else {
            return .absent("última entrega sem título")
        }
        // `completed_at` is what the ledger CLAIMS; the file's mtime is what
        // the filesystem OBSERVED. Prefer the claim, fall back to the
        // observation, and say which one was used.
        if let day = newest.fragment.completedDay,
           let date = ProjectDigest.date(fromDay: day, calendar: calendar) {
            return .entry(DigestActivity(title: title,
                                         age: age(from: date, now: now, calendar: calendar),
                                         ageInferred: false))
        }
        return .entry(DigestActivity(title: title,
                                     age: age(from: newest.modified, now: now, calendar: calendar),
                                     ageInferred: true))
    }

    static func date(fromDay day: String, calendar: Calendar) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var c = DateComponents()
        c.year = parts[0]; c.month = parts[1]; c.day = parts[2]
        return calendar.date(from: c)
    }

    /// Compact pt-BR relative age, in whole days.
    ///
    /// Day-resolution on purpose: the ledger's own `completed_at` carries no
    /// time (`Ledger` documents this as DS1), so an hours-precise label would
    /// be precision the source does not have. A future date — a clock skew, or
    /// a fragment dated ahead — reads "hoje" rather than a negative count.
    public static func age(from date: Date, now: Date, calendar: Calendar) -> String {
        let from = calendar.startOfDay(for: date)
        let to = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: from, to: to).day ?? 0
        switch days {
        case ..<1: return "hoje"
        case 1: return "ontem"
        case 2..<7: return "\(days)d"
        case 7..<30: return "\(days / 7)sem"
        case 30..<365: return "\(days / 30)mes"
        default: return "\(days / 365)a"
        }
    }

    // MARK: Git

    /// The git field alone — for a caller that painted the cheap fields with
    /// `git: .none` and is now filling this one in off the reload path. Public
    /// so that caller does not have to re-derive the `"sem git"` wording, which
    /// would be a second place for it to be different.
    public static func loadGit(path: String, probe: GitProbe) -> DigestGitField {
        guard let snapshot = probe.snapshot(path) else { return .absent("sem git") }
        return .state(snapshot)
    }
}
