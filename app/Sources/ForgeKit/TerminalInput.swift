// TerminalInput — what gets typed when a file or an image arrives from outside.
//
// THE GAP THIS CLOSES
// -------------------
// Claude Code accepts an image three ways: drag & drop, Ctrl+V, or a plain
// path in the prompt ("Analyze this image: /path/to/x.png"). Inside the
// embedded terminal the first two did nothing, and not for any deep reason:
// SwiftTerm never calls `registerForDraggedTypes`, so a dropped file is
// ignored by the view entirely, and its `paste(_:)` reads only
// `NSPasteboard.string(forType: .string)`, so image data on the clipboard is
// dropped on the floor in silence.
//
// The fix does not touch Claude Code at all. Both gestures are resolved to the
// third method — a path — and typed at the prompt. That is why this file is
// pure text: the AppKit half only has to decide what is on the pasteboard and
// write bytes for the image case.
//
// WHY BACKSLASH ESCAPING AND NOT QUOTES
// -------------------------------------
// The drop target is not always a shell. It may be a shell prompt (where a raw
// space splits an argument) or Claude Code's own input box (where wrapping
// quotes are just characters the model has to see past). Backslash escaping is
// the one form both read the same way, it is what Terminal.app inserts on
// drop, and — the deciding property — a path with nothing special in it stays
// bare, which is exactly the form the Claude Code docs show.

import Foundation

public enum TerminalInput {
    /// Characters that change meaning, or vanish, when typed raw at a shell
    /// prompt. The backslash is first because escaping must escape itself
    /// before it escapes anything else.
    private static let needsEscape: Set<Character> = [
        "\\", " ", "\t", "\"", "'", "`", "$", "&", ";", "<", ">", "|",
        "(", ")", "[", "]", "{", "}", "*", "?", "!", "#", "~", "^",
    ]

    /// A path as it should be typed. Unremarkable paths come back untouched.
    public static func escapedPath(_ path: String) -> String {
        var out = ""
        out.reserveCapacity(path.count)
        for c in path {
            if needsEscape.contains(c) { out.append("\\") }
            out.append(c)
        }
        return out
    }

    /// The text to send for a drop or a paste of files, or nil when there is
    /// nothing to type.
    ///
    /// Trailing space so several files can be dropped in a row, and so the next
    /// thing the operator types does not fuse onto the path — the same reason
    /// Terminal.app leaves one.
    public static func insertion(forPaths paths: [String]) -> String? {
        let usable = paths.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !usable.isEmpty else { return nil }
        return usable.map(escapedPath).joined(separator: " ") + " "
    }

    /// Extensions the app is willing to show a thumbnail for.
    ///
    /// Deliberately the formats Claude Code itself accepts as image input, and
    /// no more: a preview for a file the model will refuse would be a promise
    /// the app cannot keep.
    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

    /// Whether a dropped or pasted path is something to preview.
    public static func isImage(path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return imageExtensions.contains(ext)
    }

    // MARK: - Images written out of the pasteboard

    /// Folder (under Caches) that holds images pasted or dropped as raw data.
    ///
    /// Not the temp dir: the path is handed to Claude Code as text, and the
    /// model may read it minutes later, in a later turn of the same
    /// conversation. `/tmp` is swept on a schedule nobody here controls.
    public static let imageFolderName = "pasted-images"

    /// Name for an image that arrived as bytes rather than as a file.
    ///
    /// Millisecond precision is not decoration: two ⌘V in the same second are
    /// an ordinary thing to do, and a collision would silently overwrite the
    /// first image with the second while the first path stayed on screen,
    /// pointing at the wrong picture.
    public static func pastedImageName(at date: Date, ext: String = "png") -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return "colado-\(f.string(from: date)).\(ext)"
    }

    /// Which cached images are old enough to delete.
    ///
    /// Advisory housekeeping, so it is deliberately conservative: the caller
    /// prunes on write, and anything it cannot date is left alone rather than
    /// guessed at — a wrongly deleted image breaks a live conversation, while a
    /// wrongly kept one costs a few kilobytes.
    public static func staleImages(_ files: [(name: String, modified: Date)],
                                   now: Date,
                                   ttl: TimeInterval) -> [String] {
        files.filter { now.timeIntervalSince($0.modified) > ttl }.map(\.name)
    }

    /// A week. Long enough that resuming yesterday's conversation still finds
    /// its screenshots, short enough that the folder does not grow forever.
    public static let imageTTL: TimeInterval = 7 * 24 * 60 * 60
}
