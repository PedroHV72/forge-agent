// ProjectStack — what a project is built with, derived from files on disk.
//
// This exists because the icon slot on a project card was carrying ZERO
// information. `FolderLook.icon(for:)` asks `NSWorkspace` for the folder's
// Finder icon, which is the right call when a folder HAS a custom icon —
// measured on the operator's machine, none of the 14 registered projects does.
// So fourteen cards drew the identical generic blue folder, in a 30 pt slot at
// the top-left corner of every card, which is the most valuable real estate on
// the screen.
//
// Stack, unlike a custom icon, is actually derivable. Measured across those
// same 14 projects before any of this was written:
//
//     feirao-do-lu   package.json, next.config.ts, docker-compose.yml
//     fenrir         package.json, next.config.ts, Dockerfile
//     freyr          package.json, Dockerfile, docker-compose.yml
//     message        docker-compose.yml            (root)
//                    platform-backend/package.json,
//                    platform-frontend/next.config.ts        (one level down)
//     forge-agent    nothing at root
//                    app/Package.swift                       (one level down)
//     lookchina      nothing at root, nothing one level down
//
// DEPTH IS NOT A REFINEMENT HERE, IT IS THE CORRECTNESS REQUIREMENT. The last
// two rows are why. A root-only detector reports "no stack" for `forge-agent`
// — a Swift app whose `Package.swift` sits in `app/` — which is the repository
// this code ships from, and for `message`, whose whole stack lives in
// `platform-backend/` and `platform-frontend/`. Being confidently wrong about
// the operator's most visible project is the exact failure the preceding
// milestone was spent eliminating, so the scan walks one level down.
//
// It walks ONE level and no further, and that bound is a decision rather than
// an omission: `lookchina` is a workspace whose repos live at `apps/*` and
// `services/*`, two levels down. Reaching them would mean recursing into a
// directory holding ~300 entries on the operator's disk to answer a question
// whose honest answer is already available — `lookchina` is a CONTAINER, its
// stack is its children's stacks, and claiming one of them for it would be a
// composition error, not a discovery. It renders its role instead (see
// `StackGlyph`), which is the true thing to say about it.
//
// COST, measured rather than assumed. The screen reloads every 15 s and on
// FSEvents across 14+ cards, and the previous change to this screen shipped a
// ~102 ms git probe that had to be moved off the reload path afterwards. So
// this was measured against the operator's real registry BEFORE being wired to
// a view, best-of-20 per project with a warm cache, including `lookchina`'s
// ~300-entry root. Reported as the ENVELOPE over six runs rather than as one
// pretty number, because the spread between runs turned out to be wider than
// the number itself and quoting a single figure would be quoting the luckiest
// run:
//
//     mean ................ 0.27 – 0.46 ms/card
//     worst (lookchina) ... 0.91 – 2.32 ms
//     whole screen (14) ... 3.7 – 6.5 ms
//
// So the entire screen's stack detection, at its WORST observed, costs ~6 % of
// ONE git probe. It stays on the reload path, and no staging seam is needed —
// which is why this file has no equivalent of `GitProbe` and the view has no
// "stack…" state. The decision survives comfortably at either end of that
// spread, which is the only reason a range is good enough here.
//
// It is bounded BY CONSTRUCTION rather than by a cache: exactly one `readdir` per
// project (the root's, needed to enumerate subdirectories at all), plus a
// fixed `stat` per signature name per directory examined, with the number of
// directories capped by `subdirectoryLimit`. There is no pathological input —
// a root with 10 000 subdirectories costs the same as one with 12.
//
// NO CACHE, deliberately, and for a reason specific to this detector: the
// mtime that would key one does NOT move when the fact changes. Creating
// `app/Package.swift` updates `app/`'s mtime, not the project root's, so a
// cache keyed on the root would keep serving "no stack" for a project that
// just acquired one — and `forge-agent`, whose only signature is exactly such
// a file, is the project that would be wrong. At well under a millisecond the
// cache would be buying nothing and owning a staleness bug.

import Foundation

// MARK: - Vocabulary

/// A stack a project can be built with.
///
/// Deliberately short. Every case here is either present on the operator's
/// real disk (`node`, `next`, `swift`, `docker`) or costs exactly one row in
/// `signatures` and has an unambiguous marker file. Cases were NOT added
/// speculatively for languages with no evidence and no honest glyph — a
/// `.java` case whose icon is a coffee cup is a cute guess, and this file's
/// whole purpose is to stop the icon slot from guessing.
public enum StackKind: String, Sendable, Equatable, CaseIterable {
    case next
    case swift
    case go
    case rust
    case python
    case node
    case docker

    /// How specific this fact is, lowest number wins when a project shows
    /// several. This is an ORDER, not a ranking of importance.
    ///
    /// The rule: a framework beats the runtime it runs on, and both beat the
    /// way the thing is shipped. `next` implies `node`, so a project showing
    /// both is a Next project and not two projects. `docker` is last because
    /// it describes PACKAGING — `freyr` shows `package.json` and a
    /// `Dockerfile`, and it is a Node service that happens to ship in a
    /// container, not a "Docker project".
    public var specificity: Int {
        switch self {
        case .next: return 0
        case .swift: return 1
        case .go: return 2
        case .rust: return 3
        case .python: return 4
        case .node: return 5
        case .docker: return 6
        }
    }

    /// Short pt-BR name, for the tooltip that lists everything found.
    public var label: String {
        switch self {
        case .next: return "Next.js"
        case .swift: return "Swift"
        case .go: return "Go"
        case .rust: return "Rust"
        case .python: return "Python"
        case .node: return "Node"
        case .docker: return "Docker"
        }
    }
}

/// Marker file → stack. The whole detection rule, as data.
///
/// `tsconfig.json` is deliberately absent. It is present in 11 of the
/// operator's 14 projects, which makes it excellent evidence of TypeScript and
/// useless as a DISTINCTION — a signal every card shows is the generic blue
/// folder again, in a different colour.
public let stackSignatures: [String: StackKind] = [
    "next.config.js": .next,
    "next.config.ts": .next,
    "next.config.mjs": .next,
    "next.config.cjs": .next,
    "Package.swift": .swift,
    "go.mod": .go,
    "Cargo.toml": .rust,
    "pyproject.toml": .python,
    "requirements.txt": .python,
    "setup.py": .python,
    "package.json": .node,
    "Dockerfile": .docker,
    "docker-compose.yml": .docker,
    "docker-compose.yaml": .docker,
    "compose.yaml": .docker,
]

// MARK: - Result

/// What the detector found, or a NAMED reason it found nothing.
///
/// Three cases, mirroring `DigestGitField`, and for the same reason it needed
/// three: with only "found" and "nothing", a directory that could not be READ
/// collapses into the same value as a directory that was read and genuinely
/// has no stack. Those are different facts — one is about the project, the
/// other is about the detector — and the milestone this lands in existed
/// because silence was indistinguishable from a broken detector.
public enum StackDetection: Equatable {
    /// At least one signature matched. `kinds` is ordered by `specificity`,
    /// so `kinds[0]` is the primary and the array is never empty.
    case detected([StackKind])
    /// The directories were read and no signature matched.
    case none(String)
    /// The directories could NOT be read. Not an answer about the project.
    case unmeasured(String)

    /// The one stack that represents this project, when there is one.
    public var primary: StackKind? {
        if case .detected(let k) = self { return k.first }
        return nil
    }

    public var kinds: [StackKind] {
        if case .detected(let k) = self { return k }
        return []
    }

    /// True when no measurement was taken — the caller may retry.
    public var isUnmeasured: Bool {
        if case .unmeasured = self { return true }
        return false
    }
}

// MARK: - Detection

public enum ProjectStack {

    /// Subdirectories examined at depth 1, most recently modified first.
    ///
    /// A bound, not a guess about project shape: it exists so that cost cannot
    /// depend on how many directories someone happens to keep at their root.
    /// 24 clears every project on the operator's disk with room to spare
    /// (`lookchina`, the widest, has 11 after `skippedDirectories`), so the cap
    /// does not bite in practice — it only removes the pathological tail.
    public static let subdirectoryLimit = 24

    /// Never descended into. Two different reasons, both measured:
    ///
    /// - `node_modules` holds thousands of `package.json` files and would make
    ///   every Node project's scan the most expensive thing on the screen. It
    ///   is also not evidence: a dependency's manifest says nothing about what
    ///   THIS project is built with.
    /// - `build` / `dist` / `.build` / `target` / `vendor` / `Pods` are
    ///   OUTPUTS. `app/.build` in this very repository contains checked-out
    ///   `Package.swift` files from SwiftPM dependencies, so descending would
    ///   report other people's stacks as this project's.
    public static let skippedDirectories: Set<String> = [
        "node_modules", "build", "dist", ".build", "target", "vendor", "Pods",
        ".next", ".git", "DerivedData",
    ]

    /// The stack of the project rooted at `path`.
    ///
    /// Pure and injectable: the path and the `FileManager` are the only inputs
    /// and nothing here consults `$HOME` — `swift run ForgeKitTests` sees the
    /// real home when launched by hand and an isolated one under
    /// `run-tests.js`, so an ambient read passes in one launch path and lies in
    /// the other.
    public static func detect(path: String,
                              fileManager fm: FileManager = .default) -> StackDetection {
        var found = Set<StackKind>()
        found.formUnion(signatures(in: path, fileManager: fm))

        // One `readdir`, and the only one. It serves double duty: enumerating
        // the depth-1 candidates IS the reason it happens, and there is no
        // second listing anywhere in this file.
        guard let entries = try? fm.contentsOfDirectory(atPath: path) else {
            // Unreadable root. If the signature stats above already matched
            // something, that is still a real measurement and is kept; only a
            // total absence of evidence becomes `.unmeasured`, because a
            // permissions error is a fact about the detector, not the project.
            if found.isEmpty {
                return .unmeasured("diretório ilegível — stack não verificada")
            }
            return .detected(ordered(found))
        }

        var isDir: ObjCBool = false
        let candidates = entries
            .filter { !$0.hasPrefix(".") && !skippedDirectories.contains($0) }
            .filter {
                fm.fileExists(atPath: "\(path)/\($0)", isDirectory: &isDir) && isDir.boolValue
            }
            .sorted()
            .prefix(subdirectoryLimit)

        for sub in candidates {
            found.formUnion(signatures(in: "\(path)/\(sub)", fileManager: fm))
        }

        if found.isEmpty {
            return .none("stack não detectada")
        }
        return .detected(ordered(found))
    }

    /// Signature files present directly in one directory.
    ///
    /// `stat` per name rather than a `readdir` + intersection, so the cost of
    /// examining a directory is fixed at `stackSignatures.count` regardless of
    /// how many files it holds. The alternative reads `lookchina`'s ~300
    /// entries to look for 15 names.
    ///
    /// `public` for one reason worth the exposure: this IS the root-only
    /// answer, so a test can call it on the `forge-agent` fixture and show it
    /// coming back EMPTY. That is what makes the depth requirement a proven
    /// bite rather than a claim in a comment.
    public static func signatures(in dir: String, fileManager fm: FileManager) -> Set<StackKind> {
        var out = Set<StackKind>()
        for (name, kind) in stackSignatures where fm.fileExists(atPath: "\(dir)/\(name)") {
            out.insert(kind)
        }
        return out
    }

    /// Most specific first, with a stable tiebreak so the primary of a given
    /// set never depends on `Set` iteration order.
    static func ordered(_ kinds: Set<StackKind>) -> [StackKind] {
        kinds.sorted { ($0.specificity, $0.rawValue) < ($1.specificity, $1.rawValue) }
    }
}

// MARK: - Glyph

/// The icon a card should draw, as a name plus the sentence explaining it.
///
/// Data, not SwiftUI: ForgeKit carries no `import SwiftUI`, because the `Forge`
/// target is not importable from a test target on this machine and anything
/// expressed as a `View` would be verifiable only by looking at a screen. Same
/// split that already governs `ItemVisual`.
public struct StackGlyph: Equatable {
    /// SF Symbol name. Every value this type can produce is asserted to
    /// resolve against the real symbol set by the test harness — a symbol name
    /// that does not exist renders as a blank square, which is precisely the
    /// empty slot this whole file replaces.
    public let symbol: String
    /// The vendored brand mark to draw INSTEAD of `symbol`, or `nil` when the
    /// glyph stands for something no brand mark exists for (a role, a measured
    /// absence, a failure to measure).
    ///
    /// Both are carried, never one or the other, and that is the degradation
    /// rule: the view draws `mark` when it resolves and `symbol` when it does
    /// not, so a resource bundle that failed to ship costs last week's icon
    /// rather than an empty slot. A card is never blank because of this field.
    public let mark: BrandMark?
    /// What the icon is claiming, in pt-BR. Never empty — the card hangs this
    /// on `.help()`, so the glyph can always be interrogated rather than
    /// merely obeyed.
    public let help: String
    /// True when the symbol stands for a MEASURED stack. False when it stands
    /// for a role, a measured absence, or a failure to measure — the view
    /// renders those quieter, and this is the flag that lets it, without
    /// re-deriving the distinction from the symbol name.
    public let isStack: Bool

    /// `mark` defaults to `nil` so a caller that has no brand mark to offer
    /// says so by saying nothing, rather than by passing a placeholder.
    public init(symbol: String, help: String, isStack: Bool, mark: BrandMark? = nil) {
        self.symbol = symbol
        self.help = help
        self.isStack = isStack
        self.mark = mark
    }
}

public extension StackKind {
    /// The stack's REAL mark, vendored from Simple Icons.
    ///
    /// This is what the card draws; `symbolName` below is the fallback for a
    /// build whose resource bundle did not make it (see `BrandArt`). Every
    /// stack has one, which is why this is non-optional — the SF Symbols were
    /// an approximation of these marks, and where a real mark exists there is
    /// no reason to draw the approximation.
    var mark: BrandMark {
        switch self {
        case .next: return .next
        case .swift: return .swift
        case .go: return .go
        case .rust: return .rust
        case .python: return .python
        case .node: return .node
        case .docker: return .docker
        }
    }

    /// SF Symbol for the stack — now the FALLBACK, drawn only when the vendored
    /// mark above does not resolve.
    ///
    /// Kept rather than deleted, and the reason is the measurement that
    /// motivated `BrandMark`: twelve of the operator's fourteen cards landed on
    /// two of these shapes, so as an identity system this was weak — but as the
    /// thing that draws when a resource is missing it is exactly right, because
    /// the alternative is the blank square. It is still asserted to resolve.
    ///
    /// Chosen so SHAPE alone separates them, for the same reason
    /// `ItemStatus.symbolName` is: the icons sit at 30 pt in a corner and will
    /// be scanned, not read. Where a stack's real mark is already a shape, that
    /// shape is used — Node's hexagon, Next's triangle, Rust's gear — so the
    /// glyph is recognition rather than an arbitrary assignment.
    ///
    /// `go` is the honest exception. Its mark is a gopher, SF Symbols has no
    /// gopher, and every animal in the set would be a worse lie than a letter;
    /// `g.circle` at least cannot be mistaken for a claim about shape.
    var symbolName: String {
        switch self {
        case .next: return "triangle"
        case .swift: return "swift"
        case .go: return "g.circle"
        case .rust: return "gearshape"
        case .python: return "lizard"
        case .node: return "hexagon"
        case .docker: return "shippingbox"
        }
    }
}

public extension ProjectRole {
    /// SF Symbol for the role, used when there is no stack to show.
    var symbolName: String {
        switch self {
        case .workspace: return "square.stack.3d.up"
        case .project: return "curlybraces"
        case .folder: return "folder"
        }
    }
}

public extension StackGlyph {

    /// THE COMPOSITION RULE, in one place.
    ///
    /// Stack and role are two different questions — "what is it built with"
    /// and "what kind of node is this in my tree" — and the tempting answer is
    /// to draw both, which in a 30 pt slot means two 15 pt glyphs that read as
    /// neither. So: ONE glyph, and stack wins whenever there is one.
    ///
    /// That precedence is not a preference, it is what the rest of the card
    /// already says. Role is ALREADY on screen in text, immediately under the
    /// project name — `ProjectDigest.roleLine` prints "workspace · 33 repos" —
    /// so a role icon is a second copy of a fact the operator can already read.
    /// Stack is printed NOWHERE on the card. Showing stack therefore adds a
    /// fact; showing role duplicates one. When the stack is unknown the slot
    /// falls back to role, which is the only thing left that is certainly
    /// true, and it is never blank.
    ///
    /// The consequence, stated rather than hidden: `lookchina` — a workspace
    /// with no root signatures — draws the workspace glyph, and a hypothetical
    /// monorepo workspace with a root `package.json` would draw the Node
    /// hexagon instead. That is intended. The second one has a real stack and
    /// still says "workspace · 33 repos" in the line below.
    static func of(_ detection: StackDetection, role: ProjectRole) -> StackGlyph {
        switch detection {
        case .detected(let kinds):
            let primary = kinds[0]
            // The tooltip lists EVERYTHING found, so collapsing three
            // signatures to one glyph never destroys the information — it
            // moves it somewhere that costs no pixels until asked for.
            let all = kinds.map(\.label).joined(separator: " · ")
            let help = kinds.count > 1 ? "\(primary.label) — detectado: \(all)"
                                       : primary.label
            // A mark rides along here and ONLY here. `.none` and `.unmeasured`
            // stay markless on purpose: the brand marks say "built with X", and
            // there is no X in either of those cases — a role fallback wearing
            // a logo would be the confident false claim this screen spent four
            // commits removing, just prettier.
            return StackGlyph(symbol: primary.symbolName, help: help, isStack: true,
                              mark: primary.mark)

        case .none(let why):
            // A NAMED neutral. The role glyph is a real statement about the
            // project ("this is a workspace") rather than a blank slot, and
            // the help says plainly that the stack question was asked and
            // answered with nothing.
            return StackGlyph(symbol: role.symbolName,
                              help: "\(role.label) — \(why)",
                              isStack: false)

        case .unmeasured(let why):
            // Visibly DIFFERENT from `.none`, which is the entire point of the
            // third case: dashed and questioning, never the confident role
            // glyph. "Not measured" must not be able to pass for "measured,
            // and there is none".
            return StackGlyph(symbol: "questionmark.square.dashed",
                              help: why,
                              isStack: false)
        }
    }
}
