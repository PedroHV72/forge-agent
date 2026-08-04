// swift-tools-version:5.9
//
// SwiftTerm provides the VT emulator. Writing one is not a shortcut worth
// taking: Claude Code repaints continuously (alternate screen, cursor
// addressing, colour), so a partial parser produces a garbled screen rather
// than a degraded one.
//
// Build via ./build.sh, which wraps `swift build` and assembles the .app.

import PackageDescription

let package = Package(
    name: "Forge",
    platforms: [.macOS("26.0")],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.15.0"),
    ],
    targets: [
        // Pure logic lives here so it can be tested: an executable target cannot
        // be imported by a test target, and the parts most worth pinning down
        // (JSONC editing, git parsing, engine resolution) carry no UI anyway.
        // `resources:` carries the vendored brand marks (Simple Icons CC0,
        // Octicons MIT — see Sources/ForgeKit/Resources/icons/PROVENANCE.md).
        // They live in ForgeKit rather than in Forge for one reason that
        // decides it: ForgeKitTests can import ForgeKit and cannot import the
        // executable, so this is the only placement where "every mark actually
        // resolves" is a test instead of a hope. `.copy` and not `.process`:
        // processing an SVG on a machine without Xcode has no tool to run, and
        // the folder structure is what `BrandArt.directory` looks under.
        .target(name: "ForgeKit", path: "Sources/ForgeKit",
                resources: [.copy("Resources/icons")]),
        .executableTarget(
            name: "Forge",
            dependencies: ["SwiftTerm", "ForgeKit"],
            path: "Sources/Forge"
        ),
        // Executable, not a testTarget: XCTest requires full Xcode and this
        // repo builds against the Command Line Tools.
        .executableTarget(name: "ForgeKitTests", dependencies: ["ForgeKit"], path: "Sources/ForgeKitTests"),
    ]
)
