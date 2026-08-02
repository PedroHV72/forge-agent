// ItemPresentation — what a card shows, decided without SwiftUI.
//
// The card has to read like an issue: title, id, source, a truncated body,
// label chips, a priority mark and the closing date. Every one of those is a
// DECISION (how many body lines, how many chips, whether the date shows at
// all), and a decision that lives inside a `View` is a decision this machine
// cannot test — the `Forge` target is not importable from a test target here,
// so anything written into `ItemCard` is verifiable only by looking at a
// screen. Moved here, the same rules run under `swift run ForgeKitTests`.
//
// The count is the point: `elements(for:)` returns SEVEN entries for a fully
// populated item and THREE for the legacy shape the repo actually holds
// today. That pair is the milestone's "3 → 7" criterion as an assertion
// rather than an inspection.
//
// Same rule as the rest of ForgeKit (ROADMAP Note 5): Swift only labels what
// the engine already decided. Nothing here validates, transitions or rejects.

import Foundation

/// The four priorities the engine accepts, in descending urgency.
///
/// Mirrors `ItemStatus`: `rawValue` is the engine's own value, `label` is the
/// pt-BR word for humans, `parse` is tolerant. It does not replace the engine's
/// closed set — `scripts/forge-items.js` owns it.
public enum ItemPriority: String, CaseIterable, Hashable {
    case p0, p1, p2, p3

    /// The short mark drawn on the card — `P0`…`P3`. Uppercased rather than
    /// spelled out because the card has 220pt of width and the word is
    /// already one `.help()` away.
    public var mark: String { rawValue.uppercased() }

    /// Portuguese label for the UI (S04-d) — the tooltip behind `mark`.
    public var label: String {
        switch self {
        case .p0: return "crítica"
        case .p1: return "alta"
        case .p2: return "média"
        case .p3: return "baixa"
        }
    }

    /// Parses a raw priority string from the engine. An unknown or missing
    /// value returns `nil` — same contract as `ItemStatus.parse`. No
    /// `fatalError`, no silent default: the engine rejects invalid values
    /// before they reach disk (S01/D7), so an unrecognised value here means
    /// an engine newer than the app, and the card resolves that by simply
    /// not drawing the mark.
    public static func parse(_ raw: String?) -> ItemPriority? {
        guard let raw else { return nil }
        return ItemPriority(rawValue: raw)
    }
}

/// The card's content rules, as pure functions over an `Item`.
public enum ItemCardPresentation {

    /// Body lines kept on the card (D8/S04-a). The full body is one tap away
    /// in the detail sheet, so the card stays scannable.
    public static let bodyLineLimit = 3

    /// Label chips drawn before collapsing the rest into `+N` (S04-c).
    public static let chipLimit = 3

    /// Fallback title, matching what the board already draws for an untitled
    /// item.
    public static let missingTitle = "(sem título)"

    /// One drawable element of a card, in canonical order. `elements(for:)`
    /// emits these in the order the cases are declared; a case is emitted
    /// only when it has content.
    public enum Element: Hashable {
        case title(String)
        case id(String)
        case source(String)
        case body(text: String, truncated: Bool)
        case labels(shown: [String], overflow: Int)
        case priority(ItemPriority)
        case closedDay(String)
    }

    /// The first `bodyLineLimit` non-blank lines of `body`, and whether
    /// anything was left out.
    ///
    /// `nil` when there is no usable body (missing, empty, or whitespace
    /// only) — the card then draws no body block at all rather than an empty
    /// gap.
    public static func bodyPreview(_ body: String?) -> (text: String, truncated: Bool)? {
        guard let body else { return nil }
        let lines = body
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        let kept = Array(lines.prefix(bodyLineLimit))
        return (text: kept.joined(separator: "\n"), truncated: lines.count > kept.count)
    }

    /// Up to `chipLimit` labels plus how many were left out.
    ///
    /// Order is the engine's — the order on disk is the order the operator
    /// wrote, and sorting here would quietly reorder the operator's own
    /// emphasis. `nil` when there is nothing to draw.
    public static func labelChips(_ labels: [String]?) -> (shown: [String], overflow: Int)? {
        guard let labels else { return nil }
        let usable = labels
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !usable.isEmpty else { return nil }
        let shown = Array(usable.prefix(chipLimit))
        return (shown: shown, overflow: usable.count - shown.count)
    }

    /// The day (`YYYY-MM-DD`) an item was closed, or `nil`.
    ///
    /// `done` only (S04-b): a `dropped` item carries a `closed_at` too, and
    /// showing "fechado em" on work that was abandoned would read as a
    /// completion it never was. `dropped` is excluded ON PURPOSE, not by
    /// omission. Date shapes are `ProgressDate.parse`'s problem, not this
    /// file's.
    public static func closedDay(_ item: Item) -> String? {
        guard item.parsedStatus == .done else { return nil }
        return ProgressDate.parse(item.closed_at).day
    }

    /// The title the UI shows for `item` — never blank, never whitespace-only.
    ///
    /// A title that is present but only spaces (`"   "`) is, for display
    /// purposes, no title at all: `elements(for:)` already treated it that
    /// way, but the raw `item.title ?? missingTitle` the view used to write
    /// let a whitespace-only title through unfiltered. Every caller that
    /// draws a title (card, detail sheet) goes through this one function so
    /// the rule lives — and is tested — in exactly one place (S04 review R2).
    public static func displayTitle(_ item: Item) -> String {
        let t = item.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? missingTitle : t
    }

    /// Every element the card should draw for `item`, in canonical order.
    ///
    /// Seven for a fully populated item, three for the legacy shape. Callers
    /// (the view) ask what came back; they never re-derive the conditions.
    public static func elements(for item: Item) -> [Element] {
        var out: [Element] = []

        // Always present: an untitled item still needs a handle, and the id
        // is how the operator talks to the engine about this card.
        out.append(.title(displayTitle(item)))
        out.append(.id(item.id))

        // Matches what the board draws today: source only when non-empty.
        if let s = item.source?.trimmingCharacters(in: .whitespaces), !s.isEmpty {
            out.append(.source(s))
        }
        if let preview = bodyPreview(item.body) {
            out.append(.body(text: preview.text, truncated: preview.truncated))
        }
        if let chips = labelChips(item.labels) {
            out.append(.labels(shown: chips.shown, overflow: chips.overflow))
        }
        if let priority = ItemPriority.parse(item.priority) {
            out.append(.priority(priority))
        }
        if let day = closedDay(item) {
            out.append(.closedDay(day))
        }
        return out
    }
}
