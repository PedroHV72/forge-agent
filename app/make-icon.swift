// make-icon.swift — generates Forge.icns from code.
//
// Committing a binary .icns would mean nobody can tweak the icon without a
// design tool, so the icon is drawn programmatically instead: a graphite
// rounded square with the SF Symbol bolt in Forge orange.
//
// Run via app/build.sh (it regenerates only when missing).
//   swift app/make-icon.swift <output.icns>

import AppKit
import Foundation

let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Forge.icns"

/// macOS icons are supplied at these sizes; iconutil expects this exact naming.
let variants: [(name: String, px: Int)] = [
    ("icon_16x16",      16),  ("icon_16x16@2x",    32),
    ("icon_32x32",      32),  ("icon_32x32@2x",    64),
    ("icon_128x128",   128),  ("icon_128x128@2x", 256),
    ("icon_256x256",   256),  ("icon_256x256@2x", 512),
    ("icon_512x512",   512),  ("icon_512x512@2x",1024),
]

func draw(size px: Int) -> Data? {
    let s = CGFloat(px)

    // Render straight into a bitmap rep. NSImage.lockFocus() + tiffRepresentation
    // fails at small sizes ("CGImageDestinationFinalize failed for public.tiff"),
    // and going through TIFF at all is pointless when the target is PNG.
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }
    rep.size = NSSize(width: s, height: s)

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let gctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.current = gctx
    let ctx = gctx.cgContext

    // Rounded-square plate, following the macOS icon grid (~22% corner radius,
    // inset a little so it does not touch the tile edges).
    let inset  = s * 0.06
    let rect   = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = rect.width * 0.2237
    let plate  = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    let gradient = NSGradient(colors: [
        NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.20, alpha: 1),
        NSColor(calibratedRed: 0.09, green: 0.09, blue: 0.11, alpha: 1),
    ])
    gradient?.draw(in: plate, angle: -90)

    // Hairline rim so the icon keeps definition on a dark Dock.
    NSColor(calibratedWhite: 1, alpha: 0.10).setStroke()
    plate.lineWidth = max(1, s * 0.006)
    plate.stroke()

    // The bolt is drawn as an explicit path rather than tinting the SF Symbol:
    // compositing a colour over a symbol with .sourceAtop also paints every
    // other opaque pixel underneath it (the plate), which floods the icon.
    // A polygon has no such ambiguity and renders identically at every size.
    let orange = NSColor(calibratedRed: 1.0, green: 0.58, blue: 0.13, alpha: 1)

    // Normalised bolt outline, origin bottom-left, traced clockwise from the tip.
    let points: [(CGFloat, CGFloat)] = [
        (0.62, 0.95),   // top tip
        (0.29, 0.45),   // down-left edge
        (0.47, 0.45),   // inner step, right
        (0.38, 0.05),   // bottom tip
        (0.72, 0.55),   // up-right edge
        (0.53, 0.55),   // inner step, left
    ]

    let bolt = NSBezierPath()
    bolt.move(to: NSPoint(x: points[0].0 * s, y: points[0].1 * s))
    for p in points.dropFirst() {
        bolt.line(to: NSPoint(x: p.0 * s, y: p.1 * s))
    }
    bolt.close()

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.015),
                  blur: s * 0.04,
                  color: NSColor.black.withAlphaComponent(0.55).cgColor)
    orange.setFill()
    bolt.fill()
    ctx.restoreGState()

    return rep.representation(using: .png, properties: [:])
}

let fm = FileManager.default
let tmp = NSTemporaryDirectory() + "forge-iconset-\(getpid()).iconset"
try? fm.removeItem(atPath: tmp)
try fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)

for v in variants {
    guard let data = draw(size: v.px) else {
        FileHandle.standardError.write("falhou ao desenhar \(v.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try data.write(to: URL(fileURLWithPath: "\(tmp)/\(v.name).png"))
}

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", tmp, "-o", outPath]
try p.run()
p.waitUntilExit()
try? fm.removeItem(atPath: tmp)

if p.terminationStatus == 0 {
    print("✓ \(outPath)")
} else {
    FileHandle.standardError.write("iconutil falhou\n".data(using: .utf8)!)
    exit(1)
}
