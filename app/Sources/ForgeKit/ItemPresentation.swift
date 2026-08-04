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
// The count is the point: `elements(for:)` returns THREE entries for a fully
// populated item and ONE for the legacy shape the repo actually holds today.
//
// It was SEVEN — criterion #4's "3 → 7". The operator reversed that after
// seeing the card on a real board: at 268pt, seven elements is a paragraph and
// about three cards fit on screen. Body, id, source and closing date moved to
// the detail sheet, to the hover expansion, and (for the id) to a copy button;
// `scripts/forge-app-items.test.js` asserts those destinations rather than
// merely asserting their absence here.
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
    /// What the **card** draws — not everything the item has.
    ///
    /// Was seven cases (title, id, source, body, labels, priority, closedDay),
    /// the shape criterion #4 specified when the card went from 3 to 7. The
    /// operator reversed that after seeing it on a real board: at 268pt a card
    /// carrying a three-line body plus a 40-character id plus a source plus a
    /// date is a paragraph, not a card, and roughly three fit on screen.
    ///
    /// The four that left were **moved, not dropped** — body, id, source and
    /// closing date all live in `ItemDetailSheet` (one click away) and in the
    /// detail sheet and hover expansion. `scripts/forge-app-items.test.js` asserts that
    /// destination rather than merely asserting their absence here: an element
    /// that vanished from both places would be a regression, and a guard that
    /// only checked the card would call it a success.
    public enum Element: Hashable {
        case title(String)
        case labels(shown: [String], overflow: Int)
        case priority(ItemPriority)
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
    /// Three for a fully populated item, one for the legacy shape. Callers
    /// (the view) ask what came back; they never re-derive the conditions.
    public static func elements(for item: Item) -> [Element] {
        var out: [Element] = []

        // Always present: an untitled item still needs a handle.
        out.append(.title(displayTitle(item)))

        if let chips = labelChips(item.labels) {
            out.append(.labels(shown: chips.shown, overflow: chips.overflow))
        }
        if let priority = ItemPriority.parse(item.priority) {
            out.append(.priority(priority))
        }
        return out
    }

}
