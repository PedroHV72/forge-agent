// TerminalZoom — how big the terminal's type is, and what is allowed to change it.
//
// SwiftTerm ships `zoomIn`/`zoomOut`/`zoomReset` as EMPTY stubs
// (MacTerminalView.swift), so there is no zoom to configure — only one to
// build. The mechanism itself is already there and correct: assigning
// `TerminalView.font` runs `resetFont()`, which recomputes the cell dimension,
// derives new cols/rows and pushes them to the PTY via `setWinSize`. So the
// whole feature reduces to deciding a number, and that decision is what lives
// here — no AppKit, so it can be tested.
//
// Sizes are `Double` rather than `CGFloat` deliberately: this file must not
// import CoreGraphics to state a font size, and the view converts at the edge.

import Foundation

public enum TerminalZoom {
    /// Below this the emulator reports so many columns that Claude Code's TUI
    /// wraps into noise; above it an 80-column line stops fitting a normal
    /// window. Both ends are about legibility, not taste.
    public static let minimum: Double = 9
    public static let maximum: Double = 28

    /// What `applyTheme` hard-coded before zoom existed, kept as the reset
    /// target so ⌘0 lands exactly where every previous build started.
    public static let standard: Double = 12

    public static let defaultsKey = "terminalFontSize"

    public static func clamp(_ size: Double) -> Double {
        min(maximum, max(minimum, size))
    }

    /// One keyboard step (⌘+ / ⌘−).
    ///
    /// Rounds BEFORE stepping so a pinch that left 13.4pt behind still steps to
    /// 14 and 13 rather than to 14.4 and 12.4 — the keyboard is the control
    /// that puts the size back on whole numbers.
    public static func stepped(_ size: Double, by delta: Double) -> Double {
        clamp(size.rounded() + delta)
    }

    /// One trackpad pinch event. `magnification` is `NSEvent.magnification`: a
    /// small signed fraction per event (~±0.02), not an absolute scale — so it
    /// multiplies, and successive events compound the way the fingers expect.
    public static func pinched(_ size: Double, magnification: Double) -> Double {
        clamp(size * (1 + magnification))
    }

    /// The size to start a session at, given whatever `UserDefaults` returned.
    ///
    /// The anti-silence bit: a missing key reads back as `0`, which is
    /// indistinguishable from a genuine stored value and would render a
    /// terminal with no visible type at all. Anything outside the legible range
    /// — 0, a hand-edited plist, a value from a future build with a wider range
    /// — falls back to `standard` instead of being clamped into it, because a
    /// stored 3000 is corruption, not a request for 28pt.
    public static func restored(fromStored stored: Double) -> Double {
        guard stored >= minimum, stored <= maximum else { return standard }
        return stored
    }

    /// Label for the zoom menu. Whole points: the pinch produces fractions, but
    /// showing "13,4 pt" invites precision the cell grid does not have.
    public static func label(_ size: Double) -> String {
        "\(Int(size.rounded())) pt"
    }
}
