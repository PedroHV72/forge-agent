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

/// Git on a card: a state, a MEASURED absence, or a named failure to measure.
///
/// The third case is not tidiness. With only the first two, everything that is
/// not a state collapses into `.absent("sem git")` — and "sem git" is the
/// named-absence wording, the phrase that means *measured, and there is none*.
/// Two real repositories rendered it because git had been asked and had not
/// answered (see `Git.invoke`), which is a confident false claim about the
/// operator's own disk. `.unavailable` is also what tells the caller the value
/// is worth asking for again; an absence never is.
public enum DigestGitField: Equatable {
    case state(GitStatusSnapshot)
    case absent(String)
    case unavailable(String)

    public var stateValue: GitStatusSnapshot? {
        if case .state(let s) = self { return s }
        return nil
    }

    /// True when the field carries no measurement — the caller may retry.
    public var isUnavailable: Bool {
        if case .unavailable = self { return true }
        return false
    }
}

// MARK: - Git glyph

/// How confident the git line is, as a token the view turns into a colour.
///
/// Five tones for four states plus dirtiness, and the split matters: `absent`,
/// `failed` and `pending` are three DIFFERENT things the card can be saying,
/// and the whole reason `DigestGitField` has three cases is that two of them
/// once rendered identically and put a false claim on the operator's screen.
/// The tone is emitted here rather than re-derived in the view, so there is one
/// place where "measured, and there is none" can be told from "not measured".
public enum GitTone: String, Equatable, CaseIterable {
    /// Repository, tree clean.
    case clean
    /// Repository, uncommitted changes.
    case dirty
    /// MEASURED: this directory is not a repository.
    case absent
    /// Git was asked and did not answer. Not an absence.
    case failed
    /// Not asked yet — git is ~102 ms/card and is off the reload path.
    case pending

    // ── Divergence from the DEFAULT branch (`GitBaseline`) ─────────────────
    //
    // A separate tone family because it answers a separate question. The four
    // above say whether git was measured at all; these say where the branch
    // stands against `main`/`master`, which is measurable only once it was.

    /// On the default branch, or level with it. Nothing to act on.
    case level
    /// Has commits the default lacks. Normal work in progress.
    case ahead
    /// MISSING commits the default has. The actionable one — a branch that
    /// silently fell behind is what produced a worktree 13 commits stale.
    case behind
    /// Both directions. Neither side is a fast-forward of the other.
    case diverged
    /// The default branch could not be resolved. NOT "level with main".
    case undetermined
}

/// The default-branch divergence as a second, trailing mark on the git row.
///
/// Separate from `GitGlyph` rather than folded into its `text` for one reason:
/// it needs its OWN tone. The operator asked for colour on ahead/behind, and a
/// single `foregroundStyle` over one concatenated string cannot colour a tail
/// segment differently from the branch name in front of it.
public struct GitBaselineMark: Equatable {
    public let symbol: String?
    public let text: String
    public let help: String
    public let tone: GitTone

    public init(symbol: String?, text: String, help: String, tone: GitTone) {
        self.symbol = symbol
        self.text = text
        self.help = help
        self.tone = tone
    }

    /// Divergence arrows. Named constants for the same reason `branchSymbol`
    /// is: a name spelled twice can drift into a blank square in one of them.
    public static let aheadSymbol = "arrow.up"
    public static let behindSymbol = "arrow.down"
    public static let divergedSymbol = "arrow.up.arrow.down"
    public static let levelSymbol = "equal"
    public static let undeterminedSymbol = "questionmark"

    /// THE COMPOSITION RULE for the trailing mark, in one place.
    ///
    /// `nil` means the caller has a repository but has not measured divergence
    /// yet — a fifth fact that can be unknown INDEPENDENTLY of the other four,
    /// and one that must never draw as "level with main". So it gets its own
    /// wording (`"padrão…"`, the pending ellipsis this screen already uses for
    /// git itself) distinct from `.unknown`'s (`"padrão?"`, measured and
    /// unresolvable). Silence is not available to either: an omitted segment is
    /// indistinguishable from "in sync", which is the fact it is NOT.
    public static func of(_ baseline: GitBaseline?) -> GitBaselineMark {
        switch baseline {
        case .measured(let s) where s.onDefault:
            // The branch name in front of this mark already IS the default, so
            // repeating it would print the same word twice on one row. The word
            // that adds something is what that name MEANS.
            return GitBaselineMark(symbol: nil, text: "padrão",
                                   help: "\(s.defaultBranch) é a branch padrão deste projeto",
                                   tone: .level)
        case .measured(let s) where s.ahead == 0 && s.behind == 0:
            return GitBaselineMark(symbol: levelSymbol, text: s.defaultBranch,
                                   help: "nada a mais nem a menos que \(s.defaultBranch)",
                                   tone: .level)
        case .measured(let s) where s.behind == 0:
            return GitBaselineMark(symbol: aheadSymbol, text: "\(s.ahead) de \(s.defaultBranch)",
                                   help: "\(s.ahead) commit(s) à frente de \(s.defaultBranch)",
                                   tone: .ahead)
        case .measured(let s) where s.ahead == 0:
            return GitBaselineMark(symbol: behindSymbol, text: "\(s.behind) de \(s.defaultBranch)",
                                   help: "\(s.behind) commit(s) atrás de \(s.defaultBranch)",
                                   tone: .behind)
        case .measured(let s):
            // Both numbers are shown even though the symbol says "both ways":
            // this is the state worth acting on, and "diverged" without the
            // sizes does not tell the operator how much work that is.
            return GitBaselineMark(symbol: divergedSymbol,
                                   text: "\(s.ahead)↑ \(s.behind)↓ de \(s.defaultBranch)",
                                   help: "\(s.ahead) à frente e \(s.behind) atrás de \(s.defaultBranch) — divergiram",
                                   tone: .diverged)
        case .unknown(let why):
            return GitBaselineMark(symbol: undeterminedSymbol, text: "padrão?",
                                   help: why, tone: .undetermined)
        case .none:
            return GitBaselineMark(symbol: nil, text: "padrão…",
                                   help: "divergência da branch padrão ainda não medida",
                                   tone: .pending)
        }
    }
}

/// The git line a card should draw: an optional glyph, the text, the tone, and
/// the sentence explaining all three.
///
/// Data, not SwiftUI, for the same reason `StackGlyph` is: the `Forge` target
/// is not importable from a test target on this machine, so anything expressed
/// as a `View` would be verifiable only by looking at a screen — and this line
/// is exactly the one that shipped a confident false claim once already.
///
/// ONE GLYPH, NOT TWO. The ask was an icon for "has git" and an icon for the
/// branch. Those are the same fact: a branch exists if and only if a repository
/// does, so drawing both would put two glyphs in front of one claim on a line
/// that already sits under a stack glyph, a role line, an identity line and a
/// last-delivery line. `arrow.triangle.branch` sits immediately before the
/// branch NAME, which is `line`'s first segment — so it labels the name it
/// precedes and simultaneously marks the row as git.
///
/// AND ONLY THERE. `absent` and `pending` deliberately return no symbol. A
/// glyph next to "sem git" or "git…" would decorate a word rather than replace
/// one, and — the load-bearing half — a glyph on every state would make the
/// four states differ only by which glyph, when what must never happen is a
/// non-repository or an unmeasured card reading like a repository on `main`.
/// With this rule the glyph is itself evidence: a branch mark appears on a card
/// if and only if git was measured and found a repository. `failed` keeps its
/// warning triangle, which cannot be mistaken for a branch at any size.
public struct GitGlyph: Equatable {
    /// SF Symbol name, or `nil` for the states that deliberately draw none.
    /// Every non-nil value is asserted to resolve against the real symbol set
    /// by the harness — an invalid name renders as a blank square, which is the
    /// empty slot this work exists to remove.
    public let symbol: String?
    /// What the row prints. Never empty.
    public let text: String
    /// What the row is claiming, in pt-BR, for `.help()`. Never empty.
    public let help: String
    public let tone: GitTone
    /// The trailing default-branch mark, or `nil` for the states where there is
    /// no repository to compare — `absent`, `failed` and `pending` cannot have
    /// drifted from a default branch, because nothing established they have one.
    public let baseline: GitBaselineMark?

    public init(symbol: String?, text: String, help: String, tone: GitTone,
                baseline: GitBaselineMark? = nil) {
        self.symbol = symbol
        self.text = text
        self.help = help
        self.tone = tone
        self.baseline = baseline
    }

    /// SF Symbol for a branch. One constant, so the mark cannot be spelled
    /// differently in a second place and drift into a blank square.
    ///
    /// `arrow.trianglehead.branch` and not `arrow.triangle.branch`: same shape,
    /// drawn in the current SF Symbols weight family, so it sits at the same
    /// optical weight as the row's text instead of a hair heavier. Safe at this
    /// deployment target — the package declares macOS 26 — and asserted to
    /// resolve by the harness, which is what stops a rename from becoming the
    /// blank square this line of work removes.
    public static let branchSymbol = "arrow.trianglehead.branch"

    /// THE COMPOSITION RULE, in one place.
    ///
    /// `nil` means the caller has not measured git yet — which the digest
    /// cannot know, because deferring the probe is the CALLER's decision.
    public static func of(_ field: DigestGitField?) -> GitGlyph {
        switch field {
        case .state(let s):
            return GitGlyph(symbol: branchSymbol,
                            text: s.line,
                            help: s.help,
                            tone: s.dirty ? .dirty : .clean,
                            baseline: GitBaselineMark.of(s.baseline))
        case .absent(let why):
            // No glyph: the sentence IS the whole row, and a mark here would
            // be one more shape competing with the branch mark above it.
            return GitGlyph(symbol: nil, text: why,
                            help: "git respondeu: não há repositório aqui",
                            tone: .absent)
        case .unavailable(let why):
            // Never "sem git". Git was asked and did not answer, which is a
            // different fact from there being no repository, and the reason it
            // arrived with is kept on hover.
            return GitGlyph(symbol: "exclamationmark.triangle",
                            text: "git não respondeu", help: why, tone: .failed)
        case .none:
            return GitGlyph(symbol: nil, text: "git…",
                            help: "git ainda não consultado — a sonda roda fora do ciclo de recarga",
                            tone: .pending)
        }
    }
}

public extension GitStatusSnapshot {
    /// The line spelled out as a sentence, for the tooltip.
    ///
    /// Says the upstream case in words rather than by the ABSENCE of a
    /// segment, for the same reason `line` does: an omitted segment is
    /// indistinguishable from "in sync", and those are different facts.
    var help: String {
        var s = "branch \(branch) — \(dirty ? "com alterações não commitadas" : "árvore limpa")"
        if let ahead, let behind {
            if ahead == 0 && behind == 0 {
                s += " — em dia com o upstream"
            } else {
                s += " — \(ahead) à frente, \(behind) atrás do upstream"
            }
        } else {
            s += " — sem upstream configurado"
        }
        // Says "upstream" out loud above, and names the default branch below,
        // because the tooltip is the one place both numbers appear together and
        // a reader must not take one for the other.
        s += " — \(GitBaselineMark.of(baseline).help)"
        return s
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
    public var status: (String) -> GitStatus

    public init(status: @escaping (String) -> GitStatus) {
        self.status = status
    }

    public static let system = GitProbe(status: { Git.status(at: $0) })

    /// A caller that has chosen not to pay for git yet. Deliberately
    /// `.unavailable` and not `.notARepository`: not asking is not an answer,
    /// and a probe that says "no repo" for every directory it never looked at
    /// would put that lie straight on a card.
    public static let none = GitProbe(status: { _ in .unavailable("git ainda não consultado") })
}

extension ProjectDigest {

    /// Bytes read from `.gsd/PROJECT.md`. The scan stops at the first prose
    /// line, which in every PROJECT.md the generator writes is line 3; the
    /// bound is what keeps a pathological file from being read whole on a
    /// timer.
    public static let projectDocReadLimit = 8 * 1024

    /// Longest identity text handed to a card — a guard against a pathological
    /// source line, NOT a layout decision.
    ///
    /// It was 120, which is a round number and was wrong at every width the
    /// card actually has. Measured with the real font (`.caption`, 11 pt) and
    /// the real strings, two lines hold:
    ///
    ///     text column   272 pt (narrowest card)      ~93 chars
    ///                   340 pt                      ~117
    ///                   586 pt (widest grid column) ~213
    ///                   1000 pt (tree mode is full width, not in the grid) ~365
    ///
    /// So 120 elided `feirao-do-lu`'s 364-char description down to a third of a
    /// sentence, and on the operator's wide window those 120 chars were ONE
    /// line — the second line the design had allocated rendered empty. The card
    /// exists to say what the project is and was cutting the sentence to fit a
    /// box it was not in.
    ///
    /// The card is adaptive (272 pt to the full window), so no single character
    /// count can be the right elision for it — `.lineLimit(2)` is, and SwiftUI
    /// places the ellipsis at the real width. This constant only keeps a
    /// runaway PROJECT.md from being handed to the view whole: 400 is just past
    /// what two lines hold at a 1000 pt card, so it never bites before the
    /// layout does at any width a window can have.
    public static let identityLimit = 400

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
    ///
    /// `"sem git"` is emitted for exactly one outcome — git ran, refused, and
    /// there is no `.git` to contradict it. Everything else keeps the reason it
    /// arrived with.
    public static func loadGit(path: String, probe: GitProbe) -> DigestGitField {
        switch probe.status(path) {
        case .state(let s): return .state(s)
        case .notARepository: return .absent("sem git")
        case .unavailable(let why): return .unavailable(why)
        }
    }
}
