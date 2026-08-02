// ItemLaunch — the ONE thing that decides whether a board gesture originates
// work, as a pure function over `BoardGesture` (S06/T01).
//
// This decision cannot live in `ItemsView` (D-S06-1): the `Forge` app target
// is not importable by a test target on this machine, so a rule written
// there would only be verifiable by looking at the screen. That would be
// tolerable for an ordinary feature, but the rule this file enforces is a
// COUNTER-CRITERION (D9/F7, LOCKED: "five drag-move gestures in a row must
// produce zero `/forge-task` launches") — exactly the kind of thing that
// fails SILENTLY. A screen inspection that nobody on this machine can run is
// not a test for a counter-criterion; a headless assert over this file is.
//
// Same rule as the rest of ForgeKit (ROADMAP Note 5): this file only decides
// what the engine already made possible (open vs. closed status, a
// well-formed item ID). No transition or write logic lives here — actually
// starting the task session is the view's job; deciding IF it should happen
// is the only thing this file does.

import Foundation

/// The three gestures a board card can produce. `.move` and `.openDetail`
/// never originate work (D9/F7, LOCKED) — only `.start` (the explicit
/// button) can.
public enum BoardGesture {
    case start(Item)
    case move(Item, to: ItemStatus)
    case openDetail(Item)
}

/// A request to launch `/forge-task <id>` for one item.
public struct LaunchRequest: Equatable {
    public let itemID: String

    public init(itemID: String) {
        self.itemID = itemID
    }

    /// The argument passed to `newSession(text:)` — the PURE id (D-S06-4).
    /// Not stored independently of `itemID`: two independent fields could
    /// diverge, and divergence here is exactly the class of bug the
    /// whole-string shape guard exists to prevent.
    public var taskArgument: String { itemID }

    /// What the bootstrap text will contain, for a direct assert.
    public var slashCommand: String { "/forge-task \(itemID)" }
}

/// The single decision point for whether a board gesture originates work, as
/// pure functions over `Item`/`BoardGesture`. No case here as a namespace,
/// same shape as `ItemLabelFilter` (S05).
public enum ItemLaunch {

    /// `true` iff the WHOLE string matches `^I-\d{1,14}(-[a-z0-9-]*)?$` — the
    /// exact shape the readback spec (`shared/forge-items-readback.md`)
    /// requires for reference detection. A whole-string match is load-bearing
    /// (D-S06-4): one stray extra word would silently degrade `/forge-task`
    /// into a free-text task instead of a reference — a mistake that leaves
    /// no error, just the wrong (or no) item touched. Regex, not a hand
    /// parser: this is the same tool the rest of ForgeKit would reach for.
    public static func isWellFormedItemID(_ id: String) -> Bool {
        let pattern = "^I-\\d{1,14}(-[a-z0-9-]*)?$"
        return id.range(of: pattern, options: .regularExpression) != nil
    }

    /// `true` iff `item` can be started: its status is open (D-S06-2: an
    /// unrecognised status refuses — there is nothing to decide about a
    /// status the app does not know) AND its id has the well-formed shape.
    public static func canStart(_ item: Item) -> Bool {
        guard let status = item.parsedStatus, status.isOpen else { return false }
        return isWellFormedItemID(item.id)
    }

    /// The exact refusal sentence for an item that cannot be started, or
    /// `nil` when it can. Status wins when both reasons apply (it is the
    /// common case): the sentence is the readback spec's own wording,
    /// verbatim, so the operator sees the same instruction the CLI would
    /// give them.
    public static func refusal(for item: Item) -> String? {
        guard !canStart(item) else { return nil }
        if item.parsedStatus == nil || item.parsedStatus?.isOpen == false {
            let statusText = item.status ?? "com status desconhecido"
            return "Item \(item.id) está \(statusText) — reabra com: node scripts/forge-items.js --set-status \(item.id) triaged"
        }
        return "Item \(item.id) não tem o formato I-<timestamp>[-slug] — o /forge-task o trataria como texto livre"
    }

    /// The one decision point. `.move` and `.openDetail` return `nil`
    /// WITHOUT EVEN LOOKING at the item (D9/F7, LOCKED) — this is
    /// intentional and load-bearing: it makes it impossible for a future
    /// "but this status is fine to auto-launch" exception to sneak in by
    /// accident, because there is no branch here that inspects the item for
    /// those two gestures at all.
    public static func decide(_ gesture: BoardGesture) -> LaunchRequest? {
        switch gesture {
        case .move, .openDetail:
            return nil
        case .start(let item):
            guard canStart(item) else { return nil }
            return LaunchRequest(itemID: item.id)
        }
    }
}
