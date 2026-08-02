// Ledger — a minimal reader for `.gsd/ledger/*.md` fragments, and delivery
// counting in day resolution (S02 blockers 1 and 3, DS1/DS2 in
// `S02-PLAN.md`).
//
// `forge-ledger.js` fragments are real YAML: `key_decisions:` is a list
// (`- ` items, some as `|` block scalars with indented continuation lines).
// Only that JS file's own serializer round-trips lists correctly — the
// engine's `parseItem` mould (ported nowhere near here) silently drops list
// lines into an empty string on read, then loses them on the next write
// with no error, no exit code (proven in S01). A ledger reader written in
// that mould would read `key_decisions` as empty and say nothing about it.
//
// The mitigation: this reader extracts exactly `id` and `completed_at` —
// the two fields S02 needs — and nothing else. It is not a YAML parser. It
// does not attempt to read `key_decisions`, `key_files`, `slices`, `title`,
// or fragment bodies. Unifying the two frontmatter readers/writers into one
// general YAML-aware serializer is explicitly out of scope for this slice
// (deferred to an engine-unification milestone) — see `S02-PLAN.md`
// "Out of Scope".
import Foundation

/// The two fields this reader extracts from a ledger fragment's frontmatter.
/// Everything else in the fragment (lists, block scalars, other keys, body)
/// is deliberately unread — see the file-top comment.
public struct LedgerFragment: Hashable {
    public let id: String?
    /// `YYYY-MM-DD`, or nil when `completed_at` is missing or not in a
    /// recognised day shape. Day resolution only (DS1) — the ledger never
    /// carries a time component in the shapes seen on disk.
    public let completedDay: String?

    public init(id: String?, completedDay: String?) {
        self.id = id
        self.completedDay = completedDay
    }
}

/// Delivery count for one `ProgressWindow`, from the ledger source.
public struct LedgerCount: Hashable {
    /// Fragments with a `completedDay` inside the window. Undated fragments
    /// are never included — this is a count of *dated* deliveries, so the
    /// number on screen never silently mixes "delivered" with "unknown
    /// date" (mirrors the coverage-declaration pattern of
    /// `ClosedItemsCount.missingClosedAt`, D5).
    public let count: Int
    /// Fragments with no recognised `completedDay` at all, reported
    /// separately rather than folded into `count` or silently dropped.
    public let undated: Int
    /// `ProgressWindow.ledgerWindowLabel` for the window this count was
    /// produced for — `"hoje"` for `.day24h`, nil otherwise (DS1).
    public let windowLabel: String?

    public init(count: Int, undated: Int, windowLabel: String?) {
        self.count = count
        self.undated = undated
        self.windowLabel = windowLabel
    }
}

public enum Ledger {

    /// Parses `id` and `completed_at` out of a ledger fragment's
    /// frontmatter. Scanner is fence-and-root-only:
    ///
    ///   - The first line must be exactly `---`; the scanner then walks
    ///     forward and **stops** at the next line that is exactly `---`.
    ///     Nothing past the closing fence is ever read.
    ///   - Within the fence, only unindented lines matching `^id:` or
    ///     `^completed_at:` (column 0) are matched. An indented line is a
    ///     block-scalar continuation and is skipped; a `- ` line is a list
    ///     item and is skipped. Any other root key is ignored.
    ///   - Well-formed fragments carry each key at most once at the root,
    ///     so occurrence order does not matter in practice; a root-level
    ///     match is only ever accepted while scanning is still inside the
    ///     fence, so a `completed_at` that reappears after the closing
    ///     fence (a hostile/corrupt fragment, or a value merely quoted in
    ///     the body) can never reach this code — the fence-stop is what
    ///     protects it, not first-wins.
    ///
    /// `completedDay` takes the first 10 characters when they match
    /// `YYYY-MM-DD` — accepts a `completed_at` that arrives with a time
    /// component from some other shape (day resolution is a declared
    /// choice, DS1, not an artifact of the fixtures seen so far). A value
    /// that doesn't start with that shape yields nil.
    public static func parseFragment(_ text: String) -> LedgerFragment {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false)[...]
        guard let first = lines.first, first == "---" else {
            return LedgerFragment(id: nil, completedDay: nil)
        }
        lines = lines.dropFirst()

        var id: String?
        var completedDay: String?

        for line in lines {
            if line == "---" { break }
            if line.hasPrefix(" ") || line.hasPrefix("\t") || line.hasPrefix("-") {
                // Block-scalar continuation or list item — not a root key.
                continue
            }
            if let v = rootValue(line, key: "id") {
                id = v
            }
            if let v = rootValue(line, key: "completed_at") {
                completedDay = dayShape(v)
            }
        }
        return LedgerFragment(id: id, completedDay: completedDay)
    }

    /// `key: value` at column 0 only — `line` must already be confirmed
    /// unindented by the caller. Returns the trimmed value when `line`
    /// starts with `"\(key):"`, nil otherwise.
    private static func rootValue(_ line: Substring, key: String) -> String? {
        let prefix = key + ":"
        guard line.hasPrefix(prefix) else { return nil }
        let value = line.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    private static let dayPattern = "^\\d{4}-\\d{2}-\\d{2}"

    /// First 10 characters of `raw` when they match `YYYY-MM-DD`, nil
    /// otherwise.
    private static func dayShape(_ raw: String) -> String? {
        guard raw.count >= 10 else { return nil }
        let prefix = String(raw.prefix(10))
        guard prefix.range(of: dayPattern, options: .regularExpression) != nil else { return nil }
        return prefix
    }

    /// Reads every `*.md` fragment in `dir`, ordered by filename for
    /// deterministic results. A missing directory is not an error — a
    /// project with no ledger yet returns `[]`.
    ///
    /// `dir` must be the ledger under the **primary** workspace
    /// (`<workspace>/.gsd/ledger`), never a worktree's `.gsd/` (DS6) — a
    /// worktree checked out under isolation does not carry the ledger, and
    /// reading the wrong place silently reports zero deliveries for a
    /// project that is in fact shipping (F8).
    public static func read(dir: String) -> [LedgerFragment] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        let mdNames = names.filter { $0.hasSuffix(".md") }.sorted()
        var result: [LedgerFragment] = []
        for name in mdNames {
            let path = (dir as NSString).appendingPathComponent(name)
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            result.append(parseFragment(text))
        }
        return result
    }

    /// Counts `fragments` delivered inside `window`, in day resolution
    /// (DS1) — never mixed with the instant-based comparison the git/items
    /// sources use.
    ///
    /// Undated fragments (`completedDay == nil`) are never included in
    /// `count`, in any window including `.all` — reported only via
    /// `undated`, so the number on screen is always "dated deliveries",
    /// never a mix of known and unknown.
    public static func deliveries(fragments: [LedgerFragment], window: ProgressWindow,
                                   now: Date = Date(), calendar: Calendar = .current) -> LedgerCount {
        let threshold = window.dayThreshold(now: now, calendar: calendar)
        var count = 0
        var undated = 0
        for fragment in fragments {
            guard let day = fragment.completedDay else {
                undated += 1
                continue
            }
            if let threshold {
                if day >= threshold { count += 1 }
            } else {
                count += 1
            }
        }
        return LedgerCount(count: count, undated: undated, windowLabel: window.ledgerWindowLabel)
    }
}
