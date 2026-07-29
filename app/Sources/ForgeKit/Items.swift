// Items — the pure model for the work-item store (`scripts/forge-items.js`,
// `.gsd/items/`), and the grouping that turns a flat list into board columns.
//
// No transition or validation logic lives here on purpose (ROADMAP Note 5 /
// milestone CONTEXT): this file only labels and groups what the engine
// already decided. Anything that would look like a state machine belongs in
// the engine, not in Swift.

import Foundation

/// One work item, decoded straight from `forge-items.js --list --json`.
///
/// Every field besides `id` is optional: the engine omits empty keys rather
/// than emitting `null`, so a strict decode would fail on real output.
public struct Item: Codable, Identifiable, Hashable {
    public let id: String
    public let title: String?
    public let status: String?
    public let origin: String?
    public let created: String?
    public let updated: String?
    public let source: String?
    public let file: String?
    public let sha: String?
    public let milestone: String?
    public let promoted_to: String?
    public let body: String?

    public init(id: String, title: String? = nil, status: String? = nil,
                origin: String? = nil, created: String? = nil, updated: String? = nil,
                source: String? = nil, file: String? = nil, sha: String? = nil,
                milestone: String? = nil, promoted_to: String? = nil, body: String? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.origin = origin
        self.created = created
        self.updated = updated
        self.source = source
        self.file = file
        self.sha = sha
        self.milestone = milestone
        self.promoted_to = promoted_to
        self.body = body
    }

    /// The typed status, or `nil` when the engine's `status` string does not
    /// match a known case (unknown value, not a decode failure — see
    /// `ItemStatus.parse`).
    public var parsedStatus: ItemStatus? { ItemStatus.parse(status) }
}

/// The five item statuses, in the canonical column order.
///
/// This list mirrors the engine, it does not replace it — the source of
/// truth is `STATUSES` in `scripts/forge-items.js`; any change there is what
/// wins. Widening this set without a matching engine change would just make
/// Swift silently disagree with the store.
public enum ItemStatus: String, CaseIterable, Hashable {
    case inbox
    case triaged
    case doing
    case done
    case dropped

    /// Portuguese label for the UI.
    public var label: String {
        switch self {
        case .inbox: return "Entrada"
        case .triaged: return "Triado"
        case .doing: return "Fazendo"
        case .done: return "Feito"
        case .dropped: return "Descartado"
        }
    }

    /// True for the three statuses that still represent open work.
    public var isOpen: Bool {
        switch self {
        case .inbox, .triaged, .doing: return true
        case .done, .dropped: return false
        }
    }

    /// Parses a raw status string from the engine. An unknown or missing
    /// value returns `nil` rather than crashing — the caller decides where
    /// an unrecognised item goes (see `ItemBoard.unknown(_:)`).
    public static func parse(_ raw: String?) -> ItemStatus? {
        guard let raw else { return nil }
        return ItemStatus(rawValue: raw)
    }
}

/// Groups a flat list of items into board columns, one per `ItemStatus`.
public enum ItemBoard {

    public struct Column: Identifiable, Hashable {
        public let status: ItemStatus
        public let items: [Item]

        public var id: String { status.rawValue }

        public init(status: ItemStatus, items: [Item]) {
            self.status = status
            self.items = items
        }
    }

    /// One column per `ItemStatus.allCases`, in canonical order. Empty
    /// columns are included so the board does not reshuffle as items move —
    /// a status with zero items still gets a slot.
    public static func columns(_ items: [Item]) -> [Column] {
        ItemStatus.allCases.map { status in
            Column(status: status, items: items.filter { $0.parsedStatus == status })
        }
    }

    /// Items whose status is missing or does not match any known
    /// `ItemStatus`. Never silently swallowed by `columns(_:)` — surfaced
    /// here so a caller can render them explicitly.
    public static func unknown(_ items: [Item]) -> [Item] {
        items.filter { $0.parsedStatus == nil }
    }

    /// Count of items still open: `inbox + triaged + doing`. `done` and
    /// `dropped` never count, regardless of how many items exist there.
    public static func openCount(_ items: [Item]) -> Int {
        items.filter { $0.parsedStatus?.isOpen == true }.count
    }
}
