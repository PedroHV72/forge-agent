// TouchedProject — what the "tocados por outro projeto" section should say
// about one of those directories, and what its button actually does.
//
// `ProjectMarker` decides that a directory is `touched` (a `.gsd/` holding no
// work) and that file argues at length for why those must be LISTED rather
// than hidden. Listing them was only half the promise: the row printed one
// abbreviated path and nothing else, so the operator was asked "remover?"
// with no evidence attached to the question — not what is inside the folder,
// not whether it is even a repository, not whether it was touched this morning
// or two years ago. A row that asks for a decision and supplies none of its
// grounds is the same silence one level up.
//
// Everything this type prints was already on disk and free at the point
// `ProjectMarker.classify` ran: the `.gsd/` entry names, its modification
// time, and whether `.git` sits beside it. No process is spawned — the git
// fact here is a `stat` on `.git`, NOT `Git.status` (~102 ms), which is why it
// can say "is a repository" and deliberately never says a branch.
//
// TWO PROPERTIES, both inherited from `ProjectDigest` rather than invented:
//
//   1. EVERY FACT IS EITHER MEASURED OR NAMED ABSENT. There is no path here
//      that yields an empty string, and `measured: false` is carried on the
//      fact itself so the view can grey it without re-deriving which case it
//      got. A blank slot in this section would be indistinguishable from the
//      broken detector the whole `touched` concept exists to rule out.
//
//   2. THE WORDS LIVE HERE, NOT IN THE VIEW. `ForgeKitTests` cannot import the
//      `Forge` executable, so a sentence composed in `Projects.swift` is
//      verifiable only by looking at a screen — and the sentence that matters
//      most in this section is the one below about what removal does.
//
// THE CLAIM THIS FILE IS MOST CAREFUL ABOUT: `removeLabel` is "Remover da
// lista" and not "Excluir", and `removeHelp` says the disk is untouched. The
// operator asked for the delete icon and the delete colour, and gets both —
// but `state.removeWorkspace` drops a path from the registry and does not
// delete one byte. A red trash can labelled "Excluir" would be a confident
// false claim about the operator's own files, which is the exact class of
// defect the surrounding commits have been removing from this screen. The
// wording is `ProjectCard`'s already (`Projects.swift`, the card menu) rather
// than a second vocabulary for one action.
//
// NO CONFIRMATION DIALOG, and that is a decision, not an omission: removal
// here is cheap to undo — "Procurar" re-finds the directory and re-registers
// it, since a `.gsd/` on disk is what put it in this list — so a modal would
// charge every correct click for the rare wrong one. What a misfire is
// protected by instead is legibility: the button carries both a trash glyph
// and the word "lista", and its tooltip states the disk is untouched.

import Foundation

/// One measured (or named-absent) fact about a touched directory.
///
/// `symbol` is an SF Symbol name — data, not a view, for the same reason
/// `GitGlyph.symbol` is. Every name emitted here is asserted to resolve
/// against the real symbol set by `ForgeKitTests`; an invalid one renders as a
/// blank square, which is the empty slot this file exists to remove.
public struct TouchedFact: Equatable {
    /// What the fact is about — the stable handle tests and the view match on,
    /// instead of the pt-BR wording, which will change.
    public enum Kind: String, Equatable, CaseIterable {
        /// What sits inside the `.gsd/`.
        case contents
        /// When the `.gsd/` was last modified.
        case age
        /// Whether a `.git` sits beside it.
        case repo
    }

    public let kind: Kind
    public let symbol: String
    /// Never empty — the invariant the whole type exists for.
    public let text: String
    /// True when the fact was READ. False when it is a named absence, so the
    /// view can grey it without inspecting the wording.
    public let measured: Bool

    public init(kind: Kind, symbol: String, text: String, measured: Bool) {
        self.kind = kind
        self.symbol = symbol
        self.text = text
        self.measured = measured
    }
}

/// Everything the section needs to draw one touched directory.
public struct TouchedRow: Equatable, Identifiable {
    public let path: String
    /// The folder's own name — the part that identifies it, and the part the
    /// old row lost: it printed only the path, middle-truncated, so what
    /// survived on screen was a fragment of an ancestor.
    public let name: String
    /// Where it lives: the abbreviated PARENT, `~`-relative. Secondary to the
    /// name and truncated from the HEAD when it must be, because the tail is
    /// the informative end of a path.
    public let location: String
    /// The evidence, in fixed order: what is inside, how old, is it a repo.
    public let facts: [TouchedFact]

    public var id: String { path }

    public init(path: String, name: String, location: String, facts: [TouchedFact]) {
        self.path = path
        self.name = name
        self.location = location
        self.facts = facts
    }

    // MARK: Section wording

    /// Glyph for the section — the same dashed circle `ProjectCard` uses for a
    /// directory with nothing measured in it.
    public static let sectionSymbol = "circle.dashed"
    public static let sectionTitle = "Tocados por outro projeto"
    /// What these directories ARE. One idea per sentence: the old copy carried
    /// this and the paragraph below in a single dense line.
    public static let sectionSummary =
        "Pastas registradas que têm um .gsd/ dentro, mas nenhum trabalho do Forge nele — nem milestone, nem item, nem histórico."
    /// WHY they exist. Says the cause is over, so the list reads as cleanup and
    /// not as something that will keep growing.
    public static let sectionWhy =
        "O Forge criava esse .gsd/ em todo repositório que uma run encostava. Não cria mais — o que sobrou está aqui para você decidir."

    // MARK: Removal wording

    public static let removeLabel = "Remover da lista"
    public static let removeSymbol = "trash"
    /// Spelled out on hover, because the icon says "delete" louder than the
    /// label says "list".
    public static func removeHelp(_ name: String) -> String {
        "Tira \(name) desta lista do Forge. Nada é apagado do disco — a pasta e o .gsd/ continuam onde estão, e o botão Procurar acha a pasta de novo."
    }
    /// The same promise once, under the list, for the operator who never
    /// hovers. A destructive-looking control needs its object stated in the
    /// open, not only in a tooltip.
    public static let removeFootnote =
        "Remover tira a pasta desta lista. Nada é apagado do disco."

    // MARK: Fact glyphs

    /// Named constants for the same reason `GitGlyph.branchSymbol` is: a name
    /// spelled twice can drift into a blank square in one of them.
    public static let contentsSymbol = "tray"
    public static let ageSymbol = "clock"
    /// Reused, not respelled: `GitRowSegment.repoSymbol` already means "this is
    /// the repository" and is already asserted to resolve. The BRANCH mark is
    /// deliberately not used — `GitGlyph` reserves it for a measured `git
    /// status`, and this row only stat'd a `.git` directory.
    public static let repoSymbol = GitRowSegment.repoSymbol

    /// Entry names inside `.gsd/` listed before the rest, so the summary opens
    /// with what actually explains the folder. Everything else follows
    /// alphabetically; nothing is dropped silently — the count is stated.
    static let contentsShown = 3

    // MARK: Loading

    /// Composes one row. Pure apart from the injected `FileManager`/`now`:
    /// nothing here consults `$HOME`, for the reason `ProjectDigest` documents
    /// — `swift run ForgeKitTests` sees a different home in each launch path.
    ///
    /// Cost is three cheap syscalls (one `contentsOfDirectory`, two `stat`) and
    /// no process. Still not free enough for a `body` that re-evaluates on
    /// every reload, so the CALLER stages it — see `Projects.swift`.
    public static func load(path: String,
                            home: String,
                            fileManager fm: FileManager = .default,
                            now: Date = Date(),
                            calendar: Calendar = .current) -> TouchedRow {
        let gsd = (path as NSString).appendingPathComponent(".gsd")
        return TouchedRow(
            path: path,
            name: displayName(path),
            location: location(of: path, home: home),
            facts: [contentsFact(gsd: gsd, fileManager: fm),
                    ageFact(gsd: gsd, fileManager: fm, now: now, calendar: calendar),
                    repoFact(path: path, fileManager: fm)])
    }

    public static func load(paths: [String],
                            home: String,
                            fileManager fm: FileManager = .default,
                            now: Date = Date(),
                            calendar: Calendar = .current) -> [TouchedRow] {
        paths.map { load(path: $0, home: home, fileManager: fm, now: now, calendar: calendar) }
    }

    /// Never empty: a path ending in `/` (or `/` itself) has no last component
    /// to show, and an empty headline would be the blank slot again.
    static func displayName(_ path: String) -> String {
        let n = ProjectOrganiser.name(path)
        return n.isEmpty ? path : n
    }

    /// The parent, `~`-abbreviated. Falls back to the path itself when there is
    /// no parent worth printing, rather than to an empty line.
    static func location(of path: String, home: String) -> String {
        let parent = (path as NSString).deletingLastPathComponent
        guard !parent.isEmpty, parent != "/" else {
            return ProjectOrganiser.abbreviate(path, home: home)
        }
        return ProjectOrganiser.abbreviate(parent, home: home)
    }

    // MARK: Facts

    /// What is inside the `.gsd/`.
    ///
    /// An UNREADABLE directory and an EMPTY one are different facts and get
    /// different sentences: the first is a failure to measure, the second is a
    /// measurement. Collapsing them would let a permissions problem read as
    /// "there is nothing here", which is the shape of claim this section is
    /// supposed to be trustworthy about.
    static func contentsFact(gsd: String, fileManager fm: FileManager) -> TouchedFact {
        guard let entries = try? fm.contentsOfDirectory(atPath: gsd) else {
            return TouchedFact(kind: .contents, symbol: contentsSymbol,
                               text: ".gsd/ não pôde ser lido", measured: false)
        }
        let visible = entries.filter { $0 != ".DS_Store" }.sorted()
        guard !visible.isEmpty else {
            return TouchedFact(kind: .contents, symbol: contentsSymbol,
                               text: ".gsd/ vazio", measured: true)
        }
        let shown = visible.prefix(contentsShown).joined(separator: ", ")
        let rest = visible.count - min(visible.count, contentsShown)
        // "só" is the load-bearing word: these entries are what `ProjectMarker`
        // judged to be runtime scratch, and naming them is what lets the
        // operator argue with the classification instead of obeying it.
        let text = rest > 0 ? "só \(shown) +\(rest)" : "só \(shown)"
        return TouchedFact(kind: .contents, symbol: contentsSymbol,
                           text: text, measured: true)
    }

    /// When the `.gsd/` was last written — the one fact that separates live
    /// scratch from archaeology.
    static func ageFact(gsd: String, fileManager fm: FileManager,
                        now: Date, calendar: Calendar) -> TouchedFact {
        guard let attrs = try? fm.attributesOfItem(atPath: gsd),
              let modified = attrs[.modificationDate] as? Date else {
            return TouchedFact(kind: .age, symbol: ageSymbol,
                               text: "data não medida", measured: false)
        }
        // Same vocabulary as the cards' last-delivery age — "hoje", "3d",
        // "2mes" — so the two ages on this screen are read the same way.
        return TouchedFact(kind: .age, symbol: ageSymbol,
                           text: "tocado \(ProjectDigest.age(from: modified, now: now, calendar: calendar))",
                           measured: true)
    }

    /// Whether a `.git` sits beside the `.gsd/`.
    ///
    /// A `stat`, not `git status`: this row needs to know whether the folder is
    /// somebody's repository (worth a second look before removing) or a bare
    /// directory a run scratched in. It therefore never claims a branch, a
    /// remote or a clean tree — those need the ~102 ms probe `ProjectDigest`
    /// stages off the reload path, and none of them change this decision.
    ///
    /// Both outcomes are MEASURED — "sem repositório git" is a fact, and greying
    /// it would file it under "could not tell", which is not what happened.
    static func repoFact(path: String, fileManager fm: FileManager) -> TouchedFact {
        let git = (path as NSString).appendingPathComponent(".git")
        let present = fm.fileExists(atPath: git)
        return TouchedFact(kind: .repo, symbol: repoSymbol,
                           text: present ? "repositório git" : "sem repositório git",
                           measured: true)
    }
}
