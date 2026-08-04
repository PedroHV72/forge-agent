// Progress — window resolution and the first panel source: closed-item
// counting with declared coverage for items that predate `closed_at` (S01
// backfill, D5/critério #8). Pure logic only: no transition/validation of
// item status lives here (see the file-top comment in `Items.swift`).

import Foundation

/// The window a progress source is counted over.
///
/// Mirrors `MetricsStore.Window` (24h/7 days/30 days/all) 1:1 by doc
/// intent — that type lives in the `Forge` target and cannot be imported
/// here; S03 does the mapping between the two.
public enum ProgressWindow: Hashable {
    case day24h
    case week
    case month
    case all

    /// The instant this window starts at, or `nil` for `.all` (no lower
    /// bound). Mirrors `MetricsStore.Window.since`.
    public func since(now: Date = Date()) -> Date? {
        switch self {
        case .day24h: return now.addingTimeInterval(-86_400)
        case .week: return now.addingTimeInterval(-86_400 * 7)
        case .month: return now.addingTimeInterval(-86_400 * 30)
        case .all: return nil
        }
    }

    /// The earliest `YYYY-MM-DD` day included in this window (inclusive),
    /// or `nil` for `.all`. Used to compare day-only `closed_at` values
    /// (S01 backfill) at day resolution rather than as a UTC midnight
    /// instant — comparing as an instant would misreport the window by
    /// timezone.
    public func dayThreshold(now: Date = Date(), calendar: Calendar = .current) -> String? {
        switch self {
        case .all: return nil
        case .day24h: return ProgressDate.dayString(now, calendar: calendar)
        case .week: return ProgressDate.dayString(offsetDays: -6, from: now, calendar: calendar)
        case .month: return ProgressDate.dayString(offsetDays: -29, from: now, calendar: calendar)
        }
    }

    /// `"hoje"` for `.day24h`, `nil` for the other windows (DS1). Consumed
    /// by T02 to label the ledger panel.
    public var ledgerWindowLabel: String? {
        self == .day24h ? "hoje" : nil
    }
}

/// Parses `closed_at` values written by the engine (`scripts/forge-items.js`).
///
/// Three real shapes exist on disk:
///   - ISO8601 with fractional seconds — exactly what JS's
///     `Date.toISOString()` emits, and therefore exactly what the engine
///     writes on a live status transition. `ISO8601DateFormatter` in its
///     default configuration returns `nil` for this shape; it needs
///     `.withFractionalSeconds` explicitly, or every closed count is 0
///     forever, silently (DS9).
///   - ISO8601 without fractional seconds.
///   - Day-only (`YYYY-MM-DD`) — the S01 backfill shape, at day resolution.
public enum ProgressDate {

    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let whole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let dayOnlyPattern = "^\\d{4}-\\d{2}-\\d{2}$"

    /// `instant` is non-nil for either ISO shape; `day` is always the first
    /// 10 characters when the value is one of the three recognised shapes,
    /// nil otherwise. Both are nil when `raw` matches none of the shapes.
    public static func parse(_ raw: String?) -> (instant: Date?, day: String?) {
        guard let raw, raw.count >= 10 else { return (nil, nil) }
        if let d = fractional.date(from: raw) {
            return (d, String(raw.prefix(10)))
        }
        if let d = whole.date(from: raw) {
            return (d, String(raw.prefix(10)))
        }
        if raw.range(of: dayOnlyPattern, options: .regularExpression) != nil {
            return (nil, raw)
        }
        return (nil, nil)
    }

    /// `YYYY-MM-DD` for `date`, in `calendar`.
    public static func dayString(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// `YYYY-MM-DD` for `from` shifted by `offsetDays` (may be negative).
    static func dayString(offsetDays: Int, from: Date, calendar: Calendar) -> String {
        let shifted = calendar.date(byAdding: .day, value: offsetDays, to: from) ?? from
        return dayString(shifted, calendar: calendar)
    }
}

/// Result of `ClosedItems.count(...)`: how many `done` items closed inside
/// the window, and how many `done` items have no `closed_at` at all
/// (legacy, pre-S01 backfill) — surfaced as a declared coverage gap rather
/// than silently folded into `closed`.
public struct ClosedItemsCount: Hashable {
    public let closed: Int
    public let missingClosedAt: Int

    /// Non-nil exactly when `missingClosedAt > 0` — mirrors
    /// `MetricsSummary.costIncomplete`'s partial-data disclosure pattern
    /// (`Metrics.swift`), but as a ready-to-render label rather than a
    /// bare flag, since the caller here is the panel directly.
    public var coverageLabel: String? {
        missingClosedAt > 0 ? "\(missingClosedAt) sem data de fechamento" : nil
    }

    public init(closed: Int, missingClosedAt: Int) {
        self.closed = closed
        self.missingClosedAt = missingClosedAt
    }
}

/// Counts `done` items closed inside a `ProgressWindow`.
public enum ClosedItems {

    /// Only `status == .done` counts (DS8) — `dropped` also carries
    /// `closed_at` in the engine's model, but it never represents finished
    /// work, so it is excluded even when its `closed_at` falls inside the
    /// window.
    ///
    /// For each `done` item: no `closed_at` → `missingClosedAt` increments,
    /// never counted. An ISO `closed_at` compares its parsed instant
    /// against `window.since(now:)`. A day-only `closed_at` compares its
    /// day string against `window.dayThreshold(now:calendar:)` — day
    /// resolution end to end, never mixed with the instant comparison.
    public static func count(items: [Item], window: ProgressWindow,
                              now: Date = Date(), calendar: Calendar = .current) -> ClosedItemsCount {
        var closed = 0
        var missing = 0
        let since = window.since(now: now)
        let dayThreshold = window.dayThreshold(now: now, calendar: calendar)

        for item in items {
            guard item.parsedStatus == .done else { continue }
            guard let raw = item.closed_at else {
                missing += 1
                continue
            }
            let (instant, day) = ProgressDate.parse(raw)
            if let instant {
                if let since {
                    if instant >= since { closed += 1 }
                } else {
                    closed += 1
                }
            } else if let day {
                if let dayThreshold {
                    if day >= dayThreshold { closed += 1 }
                } else {
                    closed += 1
                }
            } else {
                // Unrecognised closed_at shape: neither an ISO instant nor
                // a day-only value. Treat like a missing date rather than
                // silently dropping it — the coverage label should surface
                // it too.
                missing += 1
            }
        }
        return ClosedItemsCount(closed: closed, missingClosedAt: missing)
    }
}

/// Divergence between the three panel sources — D3/critério #9.
///
/// Every condition below is `> 0` / `== 0` on the raw counts, deliberately
/// without a ratio threshold (R5 of the brainstorm: any threshold picked here
/// would be arbitrary and would train the operator to distrust the sentence
/// instead of the data). `sentence` returns at most ONE string, evaluated in
/// the table's own precedence order (P1 → P4) — the single case where two
/// patterns could both match (deliveries > 0, closed == 0, commits == 0) is
/// P3, never two sentences stacked. When all three counts are zero (an empty
/// window) or all three are proportionally non-zero (all > 0), the function
/// returns `nil` — a sentence on every render is a sentence the operator
/// learns to ignore, so silence in the matching case is the property, not an
/// omission.
public enum Divergence {

    /// `closed`/`deliveries`/`commits` are the three raw counts from
    /// `ClosedItemsCount.closed`, `LedgerCount.count` and the deduplicated
    /// commit count — never a combined/derived number (D2, critério #7).
    public static func sentence(closed: Int, deliveries: Int, commits: Int) -> String? {
        // P1 — commits happened, nothing shows on the board at all.
        if commits > 0, deliveries == 0, closed == 0 {
            return "trabalho fora do fluxo — nada rastreado"
        }
        // P2 — items closed on the board, but no delivery was logged.
        if closed > 0, deliveries == 0 {
            return "o board fecha, o fluxo não conclui"
        }
        // P3 — deliveries logged, but nothing closed on the board.
        if deliveries > 0, closed == 0 {
            return "entrega sem higiene de board"
        }
        // P4 — deliveries logged, but no commit shows in the measured checkouts.
        if deliveries > 0, commits == 0 {
            return "entregas sem código no checkout medido"
        }
        return nil
    }
}

/// The three-source snapshot S03 renders. Assembly only — no field here ever
/// reduces the three sources to one number (D2/critério #7: `closedItems`,
/// `ledger` and the git counts stay separate all the way to the screen; the
/// only cross-source field is `divergence`, and that is a sentence, not an
/// arithmetic combination).
public struct ProgressSummary: Hashable {
    public let window: ProgressWindow
    public let closedItems: ClosedItemsCount
    public let ledger: LedgerCount
    public let gitCommits: Int
    public let gitAdded: Int
    public let gitDeleted: Int
    public let divergence: String?

    public init(window: ProgressWindow, closedItems: ClosedItemsCount, ledger: LedgerCount,
                gitCommits: Int, gitAdded: Int, gitDeleted: Int, divergence: String?) {
        self.window = window
        self.closedItems = closedItems
        self.ledger = ledger
        self.gitCommits = gitCommits
        self.gitAdded = gitAdded
        self.gitDeleted = gitDeleted
        self.divergence = divergence
    }
}

extension ProgressSummary: Equatable {}

/// Assembles the three sources into one `ProgressSummary`.
public enum ProgressEngine {

    /// Pure: takes the three sources already read, counts each independently,
    /// and derives `divergence` from the three resulting counts. No disk, no
    /// process — everything here is fixture-testable.
    public static func summarise(items: [Item], ledgerFragments: [LedgerFragment],
                                  gitLogs: [[Commit]], window: ProgressWindow,
                                  now: Date = Date(), calendar: Calendar = .current,
                                  ignoreGlobs: [String] = GitActivity.defaultIgnoreList) -> ProgressSummary {
        let closedItems = ClosedItems.count(items: items, window: window, now: now, calendar: calendar)
        let ledger = Ledger.deliveries(fragments: ledgerFragments, window: window, now: now, calendar: calendar)

        let union = GitActivity.union(gitLogs)
        let sinceInstant = window.since(now: now)
        let inWindow = GitActivity.inWindow(union, since: sinceInstant)
        let lines = GitActivity.linesTouched(inWindow, ignoring: ignoreGlobs)

        let divergence = Divergence.sentence(closed: closedItems.closed,
                                              deliveries: ledger.count,
                                              commits: inWindow.count)

        return ProgressSummary(window: window, closedItems: closedItems, ledger: ledger,
                                gitCommits: inWindow.count, gitAdded: lines.added,
                                gitDeleted: lines.deleted, divergence: divergence)
    }

    /// Impure: reads the two disk sources named by DS6 and every git checkout,
    /// then delegates to `summarise`.
    ///
    /// - `items` arrive already read by the caller (`forge-items.js --list
    ///   --json`) — ForgeKit never shells out to node itself.
    /// - The ledger reads `<workspace>/.gsd/ledger` — the PRIMARY workspace
    ///   only, never a worktree's `.gsd/` (DS6): a worktree checked out under
    ///   isolation does not carry the ledger.
    /// - Commits are collected from EVERY checkout of `Git.checkouts(at:
    ///   workspace)` (primary plus worktrees) — a milestone isolated in a
    ///   worktree ships commits that the primary checkout alone would miss.
    /// - `ignoreGlobs` is resolved by the CALLER (`forge-prefs.js --resolved
    ///   --key file_audit.ignore_list`, DS5) — this function only takes the
    ///   already-resolved list and falls back to `GitActivity.defaultIgnoreList`
    ///   when the caller passes none.
    public static func load(workspace: String, items: [Item], window: ProgressWindow,
                             now: Date = Date(), calendar: Calendar = .current,
                             ignoreGlobs: [String]? = nil) -> ProgressSummary {
        let ledgerFragments = Ledger.read(dir: "\(workspace)/.gsd/ledger")
        let checkouts = Git.checkouts(at: workspace)
        let since = window.since(now: now)
        let gitLogs = GitActivity.collect(checkouts: checkouts, since: since)
        let resolvedGlobs = GitActivity.resolveIgnoreList(prefValue: ignoreGlobs)

        return summarise(items: items, ledgerFragments: ledgerFragments, gitLogs: gitLogs,
                          window: window, now: now, calendar: calendar, ignoreGlobs: resolvedGlobs)
    }
}
