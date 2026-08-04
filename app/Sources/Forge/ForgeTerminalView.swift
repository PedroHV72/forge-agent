// ForgeTerminalView — the emulator with the two things SwiftTerm leaves out.
//
// SwiftTerm's `LocalProcessTerminalView` is a complete VT emulator and a
// deliberately bare NSView: `zoomIn`/`zoomOut`/`zoomReset` are empty stubs, it
// never calls `registerForDraggedTypes`, and `paste(_:)` reads only
// `.string`. So a file dropped on the terminal did nothing at all, ⌘V of a
// screenshot did nothing at all, and there was no zoom to configure. All three
// are additions, not fixes — this subclass is where they live so the vendored
// dependency stays untouched and upgradable.
//
// The decisions (what size, what text) are in ForgeKit and tested there. What
// is left here is the part that genuinely needs AppKit: reading a pasteboard
// and writing bytes.

import AppKit
import SwiftTerm
import ForgeKit

final class ForgeTerminalView: LocalProcessTerminalView {

    /// Reports a pinch upward so the app-wide zoom stays the single source of
    /// the size. The view never stores the setting: it would then drift from
    /// what the menu, the other tabs and the next launch believe.
    var onPinchZoom: ((Double) -> Void)?

    /// Reports an image that just entered the session, so the screen can show
    /// it. A path typed at a prompt is not something the operator can SEE —
    /// that was the whole complaint — and the terminal buffer cannot show it
    /// either: Claude Code runs on the alternate screen and repaints
    /// continuously, so anything drawn into the grid is erased within a frame.
    /// The preview therefore lives above the terminal, in SwiftUI.
    var onImageAttached: ((URL) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        registerDrops()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerDrops()
    }

    private func registerDrops() {
        // `.fileURL` covers Finder and most editors; the raw image types cover
        // a picture dragged straight out of a browser or a preview, which
        // arrives as bytes with no file behind it.
        registerForDraggedTypes([.fileURL, .png, .tiff, .string])
    }

    // MARK: - Zoom

    /// Idempotent by contract, and that matters more than it looks.
    ///
    /// `updateNSView` runs on every SwiftUI rebuild, and SwiftTerm's `font`
    /// setter calls `resetFont()` AND `selectNone()`. Assigning the same font
    /// unconditionally — which is what the old `applyTheme` did — therefore
    /// wiped the operator's text selection on any unrelated state change, and
    /// re-derived the whole cell grid for nothing. The guard is the fix.
    func applyFontSize(_ size: Double) {
        let target = TerminalZoom.clamp(size)
        guard abs(Double(font.pointSize) - target) > 0.01 else { return }
        font = NSFont.monospacedSystemFont(ofSize: CGFloat(target), weight: .regular)
    }

    override func magnify(with event: NSEvent) {
        let next = TerminalZoom.pinched(Double(font.pointSize),
                                        magnification: Double(event.magnification))
        onPinchZoom?(next)
    }

    // MARK: - Drop

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        // Only inspects the pasteboard — never writes the image out. Hovering
        // over the terminal must not leave files on disk.
        PasteboardReader.canInsert(sender.draggingPasteboard) ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let result = PasteboardReader.read(sender.draggingPasteboard) else {
            return false
        }
        insert(result)
        window?.makeFirstResponder(self)
        return true
    }

    // MARK: - Paste

    /// ⌘V, extended to files and images.
    ///
    /// Order is chosen to keep the common case boring: a plain text copy still
    /// pastes as text. Files win over their string representation because a
    /// file copied in Finder is a path everywhere else too (Terminal.app does
    /// the same), and image bytes are considered only when nothing textual is
    /// on the clipboard at all — which is exactly the shape of a screenshot.
    override func paste(_ sender: Any) {
        if let result = PasteboardReader.read(NSPasteboard.general) {
            insert(result)
            return
        }
        super.paste(sender)
    }

    private func insert(_ result: PasteboardReader.Insertion) {
        send(txt: result.text)
        for url in result.images { onImageAttached?(url) }
    }
}

// MARK: - Pasteboard → text

/// Turns whatever is on a pasteboard into the text to type, or into nothing.
///
/// Split from the view so both entry points (drop and ⌘V) resolve identically:
/// two readers would be two behaviours, and the one nobody tested would be the
/// one that surprises.
enum PasteboardReader {

    /// What to type, plus the images worth previewing. The two travel together
    /// because they are derived from the same read: resolving them separately
    /// would mean reading the pasteboard twice and, for the screenshot case,
    /// writing the file twice.
    struct Insertion {
        let text: String
        let images: [URL]
    }

    /// Cheap predicate for drag feedback. Must not touch the disk.
    static func canInsert(_ pb: NSPasteboard) -> Bool {
        !fileURLs(pb).isEmpty || (plainText(pb) == nil && imageData(pb) != nil)
    }

    /// The insertion for this pasteboard, or nil to fall through to the normal
    /// text paste.
    static func read(_ pb: NSPasteboard) -> Insertion? {
        let urls = fileURLs(pb)
        if !urls.isEmpty {
            guard let text = TerminalInput.insertion(forPaths: urls.map(\.path)) else { return nil }
            return Insertion(text: text,
                             images: urls.filter { TerminalInput.isImage(path: $0.path) })
        }
        // A string on the clipboard means the operator copied text. Only when
        // there is none is a picture the unambiguous intent.
        guard plainText(pb) == nil, let data = imageData(pb) else { return nil }
        guard let path = PastedImages.write(png: data) else { return nil }
        guard let text = TerminalInput.insertion(forPaths: [path]) else { return nil }
        return Insertion(text: text, images: [URL(fileURLWithPath: path)])
    }

    private static func fileURLs(_ pb: NSPasteboard) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        let read = pb.readObjects(forClasses: [NSURL.self], options: options) as? [URL]
        return read ?? []
    }

    private static func plainText(_ pb: NSPasteboard) -> String? {
        guard let s = pb.string(forType: .string), !s.isEmpty else { return nil }
        return s
    }

    /// PNG bytes for whatever picture is on the pasteboard.
    ///
    /// TIFF is re-encoded rather than written as-is: macOS puts TIFF on the
    /// clipboard for most copies, and a `.tiff` path is a file Claude Code has
    /// no reason to accept as an image. Converting here is what makes the
    /// ordinary ⌘⇧⌃4 screenshot work.
    private static func imageData(_ pb: NSPasteboard) -> Data? {
        if let png = pb.data(forType: .png) { return png }
        guard let tiff = pb.data(forType: .tiff),
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

// MARK: - Where pasted images live

enum PastedImages {

    /// Under Caches rather than in the temp dir. The path is handed to Claude
    /// Code as text and may be read several turns later; `/tmp` is swept on a
    /// schedule this app does not control, and the failure would be a model
    /// reporting a missing file for an image the operator can still see in the
    /// scrollback.
    static var directory: URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory,
                                                    in: .userDomainMask).first else { return nil }
        let dir = caches
            .appendingPathComponent("dev.forge.menubar", isDirectory: true)
            .appendingPathComponent(TerminalInput.imageFolderName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        return dir
    }

    /// Writes the image and returns its path, or nil if it could not be
    /// written — in which case the caller falls back to the normal paste
    /// rather than typing a path to a file that does not exist.
    static func write(png data: Data, now: Date = Date()) -> String? {
        guard let dir = directory else { return nil }
        let url = dir.appendingPathComponent(TerminalInput.pastedImageName(at: now))
        do {
            try data.write(to: url)
        } catch {
            return nil
        }
        prune(in: dir, now: now)
        return url.path
    }

    /// Best-effort housekeeping, on write, so no timer is needed. Every failure
    /// here is ignored on purpose: losing the ability to delete an old cached
    /// image must never cost the operator the paste they just made.
    private static func prune(in dir: URL, now: Date) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        let dated: [(name: String, modified: Date)] = names.compactMap { name in
            let attrs = try? fm.attributesOfItem(atPath: dir.appendingPathComponent(name).path)
            guard let date = attrs?[.modificationDate] as? Date else { return nil }
            return (name, date)
        }
        for stale in TerminalInput.staleImages(dated, now: now, ttl: TerminalInput.imageTTL) {
            try? fm.removeItem(at: dir.appendingPathComponent(stale))
        }
    }
}
