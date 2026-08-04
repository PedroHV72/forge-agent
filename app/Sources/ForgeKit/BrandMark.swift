// BrandMark — the vendored marks a card may draw, and the one place a mark
// name becomes a drawable image.
//
// WHY THIS EXISTS. The icon slot on a project card was made to say what a
// project is built with (`ProjectStack`), but it said it in SF Symbols, and SF
// Symbols has no marks for these things — it has SHAPES that resemble them.
// Measured on the operator's 14 registered projects, that produced the
// following distribution over the seven stack glyphs:
//
//     triangle  (next)   ......  9 cards
//     hexagon   (node)   ......  3 cards
//     swift              ......  1 card
//     square.stack.3d.up ......  1 card   (role fallback, no stack)
//
// Twelve of fourteen cards on TWO shapes, a triangle and a hexagon, at 30 pt.
// The slot went from carrying zero information to carrying about one bit, which
// is the complaint that started this. A real Next.js mark and a real Node mark
// are not a triangle and a hexagon — they are marks the operator already
// recognises without decoding, which is the entire job of an icon at that size.
//
// NO NEW DEPENDENCY. The app has exactly one (SwiftTerm) and that discipline
// holds: these are ten SVG files and a licence, checked in, loaded by AppKit.
// macOS parses SVG natively (`_NSSVGImageRep` — probed on this machine before
// this file was written, including a forced rasterisation, because "NSImage
// probably reads SVG" is exactly the kind of assumption that ships a blank
// square). No asset catalog, no `actool`, no Xcode: this repo builds against the
// Command Line Tools and `build.sh` hand-assembles the bundle.
//
// TEMPLATE IMAGES, ALWAYS. `isTemplate = true` makes AppKit use the alpha
// channel only, so the mark takes the tone the card already assigns — accent,
// secondary, tertiary — and follows dark mode. A brand mark that ignored the
// theme would be worse than the SF Symbol it replaces, which is why the loader
// sets the flag rather than trusting each call site to.
//
// THE FALLBACK IS THE POINT. Every glyph that carries a `BrandMark` ALSO
// carries its SF Symbol name, and the view draws the symbol whenever the asset
// does not resolve. A missing resource therefore degrades to the icon that
// shipped last week, never to the blank square. That is the failure this whole
// line of work exists to remove, and it is not enough to test for it — the
// resource bundle is assembled by `build.sh`, which for a long time copied only
// the binary, so a resource that resolves under `swift run` could still be
// absent from the real `.app`. `build.sh` now copies the bundle and a JS guard
// pins that, because the gap is invisible at runtime: the app still launches.

import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// A mark vendored from Simple Icons (CC0) or Octicons (MIT).
///
/// One case per file in `Resources/icons`, and no case without a file — the
/// harness asserts that correspondence in both directions, so this enum cannot
/// grow a case whose asset was never fetched (the blank square) and the
/// directory cannot grow a file nothing draws.
public enum BrandMark: String, CaseIterable, Sendable, Equatable {
    // Stacks — Simple Icons. Slugs are recorded in `Resources/icons/PROVENANCE.md`.
    case next = "stack-next"
    case node = "stack-node"
    case swift = "stack-swift"
    case go = "stack-go"
    case rust = "stack-rust"
    case python = "stack-python"
    case docker = "stack-docker"

    // Git hosts — Simple Icons. Drawn only for a remote MEASURED to be that
    // host; see `GitRemote`.
    case github = "host-github"
    case gitlab = "host-gitlab"
    case bitbucket = "host-bitbucket"

    // Git itself — Octicons, GitHub's own set, MIT.
    case gitBranch = "git-branch"

    /// The file base name in `Resources/icons`. Same as the raw value: the enum
    /// case IS the asset name, so a mark cannot be spelled one way in the
    /// vocabulary and another way at the point of loading.
    public var assetName: String { rawValue }
}

/// Loads vendored marks. The only place a `BrandMark` becomes an image.
public enum BrandArt {

    /// Subdirectory inside the resource bundle. `.copy` preserves the folder,
    /// so the files keep this prefix rather than landing at the bundle root.
    public static let directory = "icons"
    public static let fileExtension = "svg"

    #if SWIFT_PACKAGE
    /// The ForgeKit resource bundle.
    ///
    /// `Bundle.module` and not `Bundle.main`: `swift run ForgeKitTests` and the
    /// assembled `.app` are different `main` bundles, and a test that resolved
    /// through `main` would be proving something about the test runner rather
    /// than about the app. SwiftPM's accessor searches next to the executable
    /// AND inside `Bundle.main.resourceURL`, which is why copying the bundle
    /// into `Contents/Resources` (see `build.sh`) is sufficient for the app.
    public static var bundle: Bundle { Bundle.module }
    #else
    public static var bundle: Bundle { Bundle(for: BundleToken.self) }
    private final class BundleToken {}
    #endif

    /// Where a mark's file is, or `nil` when the resource is missing.
    ///
    /// Public because it is the cheapest honest way to ask "does this resolve?"
    /// without an AppKit round trip — which is what lets the harness assert
    /// every case of `BrandMark` against the real bundle.
    public static func url(_ mark: BrandMark) -> URL? {
        bundle.url(forResource: mark.assetName,
                   withExtension: fileExtension,
                   subdirectory: directory)
            // A bundle assembled by hand could flatten the subdirectory; asking
            // again without it costs one failed lookup and removes a whole
            // class of "works in tests, blank in the app".
            ?? bundle.url(forResource: mark.assetName, withExtension: fileExtension)
    }

    #if canImport(AppKit)
    /// The mark as a template image, or `nil` if it does not resolve.
    ///
    /// CACHED, and this one is not premature: the projects screen reloads every
    /// 15 s and on FSEvents across 14+ cards, each of which draws a stack mark
    /// and possibly two git marks. Re-parsing SVG on every render would put an
    /// XML parse on the reload path that `ProjectStack` was careful to keep
    /// under a millisecond. The cache is keyed on a name that comes from a
    /// compile-time enum and the files are inside the bundle, so there is no
    /// staleness question of the kind that made `ProjectDigest` refuse one.
    public static func image(_ mark: BrandMark) -> NSImage? {
        if let hit = cache.object(forKey: mark.assetName as NSString) { return hit }
        guard let url = url(mark), let img = NSImage(contentsOf: url) else { return nil }
        img.isTemplate = true
        cache.setObject(img, forKey: mark.assetName as NSString)
        return img
    }

    private static let cache = NSCache<NSString, NSImage>()
    #endif
}
