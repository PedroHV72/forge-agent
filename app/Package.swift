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
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "Forge",
            dependencies: ["SwiftTerm"],
            path: "Sources/Forge"
        ),
    ]
)
