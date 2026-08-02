import Foundation

/// Visual tokens for the items board.
///
/// These are **data, not SwiftUI**. ForgeKit carries no `import SwiftUI` (the
/// `Forge` target is not importable from a test target on this machine, so
/// anything expressed as a `Color` would be verifiable only by looking at a
/// screen). The rule "which tone does `done` get" is therefore decided and
/// asserted here; `ItemsView` does nothing but map the token to a concrete
/// `Color`. Same split that already governs truncation, chip cutting and the
/// closing date — see `ItemCardPresentation`.
public enum ItemTint: String, CaseIterable, Hashable {
    case neutral
    case blue
    case purple
    case orange
    case green
    case red
    case teal
    case pink
    case indigo
    case yellow
}

public extension ItemStatus {
    /// SF Symbol for the column header. Chosen so the shape alone separates the
    /// five statuses for someone who cannot rely on colour.
    var symbolName: String {
        switch self {
        case .inbox: return "tray"
        case .triaged: return "checklist"
        case .doing: return "bolt"
        case .done: return "checkmark.circle"
        case .dropped: return "xmark.bin"
        }
    }

    /// Column tone. Every status gets a real hue — `inbox` and `dropped` were
    /// `.neutral`, which made the card's accent bar and its status glyph
    /// invisible against the panel for exactly the two columns a backlog is
    /// fullest of.
    ///
    /// "Not competing for attention" is still honoured, just not by greying
    /// out: `doing` stays the only WARM tone among the STATUSES (it is the
    /// column that means someone is spending time right now), and the badge
    /// treatment renders every tone at 18% fill, so a calm colour reads as calm
    /// rather than as missing.
    ///
    /// `inbox` is `.neutral` by the operator's call, after seeing teal and then
    /// indigo on a real board and rejecting both. The declared cost: the accent
    /// bar and the status glyph are quiet for the inbox column — which is the
    /// behaviour a full inbox arguably wants, and it is a one-line change if
    /// the quietness ever reads as a bug instead of as calm.
    var tint: ItemTint {
        switch self {
        case .inbox: return .neutral
        case .triaged: return .blue
        case .doing: return .orange
        case .done: return .green
        case .dropped: return .red
        }
    }
}

public extension ItemPriority {
    /// Priority tone, monotonic with urgency: p0 red → p3 neutral. A card can
    /// therefore be triaged by colour without reading the `P0..P3` mark.
    var tint: ItemTint {
        switch self {
        case .p0: return .red
        case .p1: return .orange
        case .p2: return .blue
        case .p3: return .neutral
        }
    }

    /// SF Symbol for urgency. One family (chevrons around a baseline) so the
    /// four read as a scale rather than as four unrelated glyphs, and so the
    /// direction alone carries the meaning for someone who cannot rely on the
    /// tone — the same reason `ItemStatus.symbolName` exists.
    var symbolName: String {
        switch self {
        case .p0: return "exclamationmark.2"
        case .p1: return "chevron.up"
        case .p2: return "equal"
        case .p3: return "chevron.down"
        }
    }
}

public extension ItemCardPresentation {
    /// Palette used for label chips. Excludes `.neutral` (a chip that reads as
    /// "no colour" is indistinguishable from an unstyled one) and `.red`
    /// (reserved for p0 — a label must never impersonate urgency).
    static let labelPalette: [ItemTint] = [.blue, .purple, .orange, .green, .teal, .pink]

    /// Deterministic colour for a label: the same text always lands on the same
    /// tone, in this run and the next, on any machine.
    ///
    /// Deliberately NOT `String.hashValue` — Swift seeds that per process, so
    /// `bug` would change colour every launch and the operator could never learn
    /// "teal means ui".
    ///
    /// FNV-1a rather than a sum of scalars. The sum was tried first and measured
    /// on this repo's real labels: `bug`, `ui`, `progresso` and `d8` all landed
    /// on the same slot — four of five identical, which defeats the whole point
    /// of colouring them. Summing throws away position, so short lowercase words
    /// cluster hard once taken mod 6. FNV-1a's avalanche spreads them.
    static func labelTint(_ label: String) -> ItemTint {
        var hash: UInt32 = 2_166_136_261
        for byte in Array(label.utf8) {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return labelPalette[Int(hash % UInt32(labelPalette.count))]
    }

    /// The short form of an id, for the card's footer.
    ///
    /// Full ids look like `I-20260730202553-card-item-7-elementos` — 40+
    /// characters that eat an entire row of a 268pt card and tell the operator
    /// nothing they can act on. The slug is the readable half, so that is what
    /// the card shows; the full id stays available as the element's tooltip and
    /// is what every CLI command still takes.
    ///
    /// Falls back to the last six digits of the timestamp when an id carries no
    /// slug, and returns the input unchanged when it does not match the
    /// `I-<digits>-<slug>` shape at all — an id this function does not
    /// recognise is shown whole rather than mangled.
    static func shortID(_ id: String) -> String {
        guard id.hasPrefix("I-") else { return id }
        let rest = id.dropFirst(2)
        guard let dash = rest.firstIndex(of: "-") else {
            let digits = String(rest)
            guard digits.allSatisfy(\.isNumber), digits.count > 6 else { return id }
            return String(digits.suffix(6))
        }
        let stamp = rest[rest.startIndex..<dash]
        guard stamp.allSatisfy(\.isNumber) else { return id }
        let slug = String(rest[rest.index(after: dash)...])
        return slug.isEmpty ? String(stamp.suffix(6)) : slug
    }
}

public extension MarkdownDoc {
    /// `(done, total)` of GitHub-style task boxes in a body, or `nil` when the
    /// body has none.
    ///
    /// Reuses the block parser rather than grepping the raw source: a `- [ ]`
    /// **inside a fenced code block** is a literal, not a checkbox, and grepping
    /// would count it. `blocks(_:)` already keeps fences verbatim, so filtering
    /// to `.bullets` gets that property for free.
    static func checklist(_ source: String?) -> (done: Int, total: Int)? {
        guard let source, !source.isEmpty else { return nil }
        var done = 0, total = 0
        for case .bullets(let items) in blocks(source) {
            for item in items {
                let l = item.lowercased()
                if l.hasPrefix("[ ]") { total += 1 }
                else if l.hasPrefix("[x]") { total += 1; done += 1 }
            }
        }
        return total == 0 ? nil : (done, total)
    }
}

public extension ItemCardPresentation {
    /// Compact age of an item, from `created`, as `agora` / `3h` / `5d` / `2sem`.
    ///
    /// Exists because the board had **no** signal for "this has been sitting
    /// here": the only date on a card was the closing one, which by definition
    /// only appears once the work is over. What an operator scanning a backlog
    /// needs is the opposite.
    ///
    /// `now` is injected so the rule is testable without a clock. Returns `nil`
    /// for a missing or unparseable `created`, and for a future timestamp —
    /// showing "há -2d" would be worse than showing nothing.
    static func age(for item: Item, now: Date = Date()) -> String? {
        guard let created = item.created,
              let then = ProgressDate.parse(created).instant else { return nil }
        let seconds = now.timeIntervalSince(then)
        guard seconds >= 0 else { return nil }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return minutes < 1 ? "agora" : "\(minutes)min" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days < 14 { return "\(days)d" }
        let weeks = days / 7
        return weeks < 9 ? "\(weeks)sem" : "\(days / 30)m"
    }
}

public extension ItemCardPresentation {
    /// Tone for the age badge: the colour means **staleness**, not decoration.
    ///
    /// Grey said "this is metadata, ignore me" — which is the opposite of what
    /// an age is for on a backlog. Now the older an open item gets, the louder
    /// it reads: under a day is quiet, then blue, then orange, then red past two
    /// weeks.
    ///
    /// Closed items (`done`/`dropped`) always come back `.neutral`: their age is
    /// history, and shouting about a card that already shipped would train the
    /// operator to ignore the colour everywhere.
    static func ageTint(for item: Item, now: Date = Date()) -> ItemTint {
        guard let created = item.created,
              let then = ProgressDate.parse(created).instant else { return .neutral }
        if let s = item.parsedStatus, !s.isOpen { return .neutral }
        let days = now.timeIntervalSince(then) / 86_400
        // A thermal ramp, calm to urgent, with no cool tone above a warm one:
        // grey → blue → yellow → orange → red. Four steps were too coarse to
        // read as a ramp at all — everything under a week looked identical, so
        // the colour only ever said "old" or "not old".
        if days < 1 { return .neutral }
        if days < 3 { return .blue }
        if days < 7 { return .yellow }
        if days < 14 { return .orange }
        return .red
    }
}

public extension ItemCardPresentation {
    /// Whether this item is waiting on something else, and on how many.
    ///
    /// Returns `nil` — not `(0)` — when nothing blocks it, so the card can skip
    /// the badge entirely rather than draw a zero. A **closed** item is never
    /// reported as blocked: it already shipped, so whatever it was waiting for
    /// stopped mattering, and a red "bloqueada" on a done card is noise that
    /// teaches the operator to ignore the badge.
    static func blockedCount(_ item: Item) -> Int? {
        guard let ids = item.blocked_by else { return nil }
        let real = ids.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !real.isEmpty else { return nil }
        if let s = item.parsedStatus, !s.isOpen { return nil }
        return real.count
    }
}

public extension ItemCardPresentation {
    /// How long the pointer must rest on a card before its summary expands.
    ///
    /// Not zero, and the difference matters: with instant expansion, dragging
    /// the pointer across a column reflows every card it crosses, so the board
    /// ripples while the operator is just moving toward something else. A dwell
    /// makes expansion an intent rather than a side effect of travel.
    ///
    /// Lives here, named, instead of as a literal inside the view: it is a
    /// behaviour worth finding and worth changing in one place.
    ///
    /// `TimeInterval`, not the stdlib `Duration`: ForgeKit already declares its
    /// own `Duration` enum (`Models.swift:206`), which shadows the stdlib type
    /// inside this module. Naming the seconds plainly beats renaming a type
    /// three other files depend on.
    static let hoverExpandDelaySeconds: TimeInterval = 1.0
}

public extension ItemCardPresentation {
    /// A title cut down to fit a one-line receipt.
    ///
    /// Toasts name the card they acted on — "moved" without saying *what* is
    /// only marginally better than no toast at all when a column holds twenty
    /// cards. But a 60-character title turns a capsule into a paragraph, so the
    /// cut is a rule rather than a hope.
    ///
    /// Breaks on a word boundary when there is one in the last third, so the
    /// result reads as a phrase instead of stopping mid-word.
    static func shortTitle(_ item: Item, max: Int = 28) -> String {
        let full = displayTitle(item)
        guard full.count > max else { return full }
        let cut = String(full.prefix(max))
        if let space = cut.lastIndex(of: " "),
           cut.distance(from: cut.startIndex, to: space) > (max * 2) / 3 {
            return String(cut[cut.startIndex..<space]) + "…"
        }
        return cut + "…"
    }
}
