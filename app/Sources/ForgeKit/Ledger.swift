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

/// The three fields this reader extracts from a ledger fragment's frontmatter.
/// Everything else in the fragment (lists, block scalars, other keys, body)
/// is deliberately unread — see the file-top comment.
public struct LedgerFragment: Hashable {
    public let id: String?
    /// `YYYY-MM-DD`, or nil when `completed_at` is missing or not in a
    /// recognised day shape. Day resolution only (DS1) — the ledger never
    /// carries a time component in the shapes seen on disk.
    public let completedDay: String?
    /// The fragment's `title:` — a plain root scalar, read by the SAME
    /// fence-and-root-only scanner as `id`, never by a second parser.
    ///
    /// The file-top comment's refusal is about *lists* and *block scalars*
    /// (`key_decisions`, `key_files`), which this scanner still does not
    /// attempt. `title` is the same shape as `id`, so extracting it costs
    /// nothing and needs no new machinery. `ProjectDigest` needs it to say
    /// WHAT was last delivered instead of only when.
    public let title: String?

    public init(id: String?, completedDay: String?, title: String? = nil) {
        self.id = id
        self.completedDay = completedDay
        self.title = title
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
        var title: String?

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
            if let v = rootValue(line, key: "title") {
                title = v
            }
        }
        return LedgerFragment(id: id, completedDay: completedDay, title: title)
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

    /// Bytes read from a fragment when only its frontmatter is wanted.
    ///
    /// Measured, not guessed: the largest fragment on this machine's two real
    /// ledgers is 2 655 bytes whole, and the deepest frontmatter closes on
    /// line 54. 32 KiB is two orders of magnitude of headroom while still
    /// bounding the read of a file that some future tool decides to make
    /// enormous. `parseFragment` stops at the closing fence anyway, so
    /// anything past it was never going to be read.
    public static let frontmatterReadLimit = 32 * 1024

    /// The most recently written fragment in `dir`, and when it was written.
    ///
    /// Cost is the point (see `ProjectDigest`): this stats every entry and
    /// **reads exactly one file**, so a ledger of 82 fragments costs the same
    /// one read as a ledger of 3.
    ///
    /// Recency is file modification time, not filename order and not
    /// `completed_at`, because on real disks neither of those is recency:
    ///
    ///   - Filenames mix ID schemes. `M-<ts>-<slug>` and legacy `M001` sort
    ///     against each other by ASCII (`-` < `0`), so every legacy name sorts
    ///     AFTER every timestamped one — a tail-by-name would return a 2026-04
    ///     milestone as "last activity" on a project that shipped last week.
    ///   - `completed_at` is empty in every fragment produced by
    ///     `forge-ledger-migrate` (48 of 82 in the ledger measured here), so
    ///     ranking by it would ignore half the store.
    ///
    /// Migrated fragments all share one mtime — the migration instant — which
    /// is old, so they never win against a fragment written by a real
    /// completion. That is the property this relies on.
    public static func newest(dir: String,
                              fileManager fm: FileManager = .default)
        -> (fragment: LedgerFragment, modified: Date, name: String)? {
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return nil }
        var best: (name: String, date: Date)?
        for name in names where name.hasSuffix(".md") {
            let path = (dir as NSString).appendingPathComponent(name)
            guard let attrs = try? fm.attributesOfItem(atPath: path),
                  let date = attrs[.modificationDate] as? Date else { continue }
            // `>` and not `>=`, plus the name tiebreak, so a directory whose
            // fragments share one mtime (a fresh migration) still returns a
            // deterministic answer rather than whatever the FS enumerated first.
            if best == nil || date > best!.date || (date == best!.date && name > best!.name) {
                best = (name, date)
            }
        }
        guard let best else { return nil }
        let path = (dir as NSString).appendingPathComponent(best.name)
        guard let text = readHead(path: path, limit: frontmatterReadLimit) else { return nil }
        return (parseFragment(text), best.date, best.name)
    }

    /// First `limit` bytes of `path` as UTF-8, nil when unreadable.
    ///
    /// Truncating UTF-8 mid-codepoint yields nil from the strict initialiser,
    /// so the lossy conversion is used — a mangled final character in a
    /// discarded tail is not worth losing the whole frontmatter over.
    ///
    /// Public because the bound is the point: "this read is bounded" is not
    /// observable from `newest`'s or `ProjectDigest`'s return value (a
    /// bounded and an unbounded read agree on every well-formed fragment), so
    /// the only way to test it is to call it against a file larger than the
    /// limit and check that the excess did not arrive.
    public static func readHead(path: String, limit: Int) -> String? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: limit) else { return nil }
        return String(decoding: data, as: UTF8.self)
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
