// ItemFilter — the one rule that decides whether an item survives a filter by
// label, as a pure function over `Item` (S05/T01).
//
// Exact and case-sensitive on purpose (D-S05-1, LOCKED for this slice):
// `jq '[.[]|select(.labels|index("<label>"))]|length'` is ELEMENT EQUALITY.
// Substring matching would count `ui-bug` for the query `ui`, and the board
// would show one more card than the CLI reports for the same filter — which
// is exactly the divergence criterion #5 forbids. Case-folding was considered
// and rejected for the same reason: the CLI's `index()` is case-sensitive, so
// a folded match here would again disagree with the source of truth.
//
// Accepted cost: typing "Bug" will not find a label written as "bug". The
// mitigation is a suggestions menu drawn from `availableLabels` (T02), not a
// looser match here.
//
// Same rule as the rest of ForgeKit (ROADMAP Note 5): this file only labels
// what the engine already decided. No status validation or transition lives
// here — an item with an unrecognised `status` still matches normally,
// because the filter is about labels, not about status (this is what
// supports D-S05-2: the "Unknown" column also filters).

import Foundation

/// Label-filtering rules for the board, as pure functions over `[Item]`.
public enum ItemLabelFilter {

    /// Normalises a raw filter query: trims whitespace/newlines, and turns an
    /// empty or whitespace-only string into `nil`.
    ///
    /// `nil` is the signal that means "no filter" throughout this file —
    /// `apply` treats it as "return everything unchanged".
    public static func normalise(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// `true` iff some element of `item.labels` (each trimmed, blanks
    /// discarded) is EQUAL (`==`, case-sensitive) to `label`. An item with no
    /// labels — `nil` or `[]` — never matches.
    ///
    /// Deliberately not a substring/contains check: see the file-top comment
    /// for why that would diverge from the CLI's `jq index()`.
    public static func matches(_ item: Item, label: String) -> Bool {
        guard let labels = item.labels else { return false }
        for raw in labels {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if trimmed == label { return true }
        }
        return false
    }

    /// Filters `items` by `query`, preserving input order.
    ///
    /// `normalise(query) == nil` returns `items` unchanged — a `nil` or
    /// whitespace-only query is not a filter, it is the absence of one, and
    /// the caller must never see an empty board for that reason.
    public static func apply(_ items: [Item], query: String?) -> [Item] {
        guard let q = normalise(query) else { return items }
        return items.filter { matches($0, label: q) }
    }

    /// The union of every trimmed, non-empty label across `items`, without
    /// duplicates, sorted.
    ///
    /// Sorted so the suggestions menu (T02) does not reshuffle between board
    /// reloads — a stable list is a precondition for a usable suggestion UI.
    public static func availableLabels(_ items: [Item]) -> [String] {
        var seen = Set<String>()
        for item in items {
            guard let labels = item.labels else { continue }
            for raw in labels {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                seen.insert(trimmed)
            }
        }
        return seen.sorted()
    }
}
