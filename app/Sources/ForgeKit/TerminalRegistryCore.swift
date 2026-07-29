// TerminalRegistryCore — who owns a live terminal, and when it may die.
//
// The bug this exists to prevent: a terminal that lived inside the SwiftUI
// view lifecycle. `NSViewRepresentable.makeNSView` runs again every time
// SwiftUI rebuilds the host — which it does on every navigation away and
// back — and `makeCoordinator` hands out a NEW coordinator each time. With
// the "already bootstrapped" flag stored on that coordinator, returning to
// the terminal screen meant: new PTY, fresh shell, and the first message
// typed in again. The model survived; the process did not.
//
// So ownership moves out of the view lifecycle and into a registry keyed by
// session id. The view layer asks the registry for the terminal belonging to
// a session; the registry creates it once and hands back the same instance
// forever after. Teardown of a *view* is not teardown of a *session*.
//
// This file is the pure half — keying, one-shot bootstrap claims, teardown
// policy and focus resolution — so it can be tested without AppKit. The
// AppKit half (creating the emulator, starting the shell, terminating the
// PTY) lives in the app target and is a thin shell over these decisions.

import Foundation

// MARK: - Registry

/// One live terminal per session id, outliving any view that displays it.
///
/// Generic over the hosted object so the pure logic carries no AppKit
/// dependency: the app parameterises it with a box holding the real
/// `LocalProcessTerminalView`, the tests with a stub.
///
/// Not thread-safe by design — every caller is the main actor (SwiftUI view
/// updates and AppState mutations both are). Adding a lock would only hide a
/// call from the wrong thread instead of trapping on it.
public final class TerminalRegistry<Entry: AnyObject> {
    private struct Slot {
        let entry: Entry
        var didBootstrap: Bool
    }

    private var slots: [UUID: Slot] = [:]

    public init() {}

    /// The terminal already registered for `id`, if any.
    public func entry(for id: UUID) -> Entry? { slots[id]?.entry }

    /// Return the existing terminal for `id`, or create and register one.
    ///
    /// `make` is called **only** on first request for a given id. That is the
    /// whole fix: the expensive, side-effecting part (spawning the shell) can
    /// never run twice for one session, no matter how often the view is
    /// rebuilt.
    @discardableResult
    public func adopt(_ id: UUID, make: () -> Entry) -> (entry: Entry, isNew: Bool) {
        if let existing = slots[id] { return (existing.entry, false) }
        let created = make()
        slots[id] = Slot(entry: created, didBootstrap: false)
        return (created, true)
    }

    /// Claim the right to send the bootstrap command for `id`. True at most
    /// once per session, for the lifetime of the session — not of a view.
    ///
    /// Keyed by session id rather than held on a coordinator instance because
    /// coordinators are per-view and get recreated; the id is the only thing
    /// that survives navigation.
    public func claimBootstrap(for id: UUID) -> Bool {
        guard var slot = slots[id] else { return false }
        guard !slot.didBootstrap else { return false }
        slot.didBootstrap = true
        slots[id] = slot
        return true
    }

    public func hasBootstrapped(_ id: UUID) -> Bool { slots[id]?.didBootstrap ?? false }

    /// Unregister the terminal for `id` and hand it back so the caller can
    /// terminate it. Returning it (instead of swallowing it) is what keeps the
    /// registry free of AppKit while still making the leak impossible to
    /// forget: an unregistered PTY nobody terminated is a visible loose end.
    @discardableResult
    public func discard(_ id: UUID) -> Entry? {
        guard let slot = slots.removeValue(forKey: id) else { return nil }
        return slot.entry
    }

    public var count: Int { slots.count }
    public var ids: Set<UUID> { Set(slots.keys) }
}

// MARK: - Teardown policy

/// Why a terminal is being let go of.
public enum TerminalTeardownReason: Equatable {
    /// SwiftUI took the hosting view down: navigation, a tab switch, a window
    /// rebuild. Says nothing about the session.
    case viewDismantled
    /// The operator closed the session (and confirmed, if it was running).
    case sessionClosed
}

public enum TerminalTeardownAction: Equatable {
    /// Keep the process and its scrollback; the session is still open.
    case keepAlive
    /// Terminate the process and drop the registry entry.
    case terminateAndDiscard
}

/// The single decision the whole fix turns on: view teardown is not session
/// teardown. Expressed as data so it is testable and so the rule cannot be
/// quietly re-litigated inside a `dismantleNSView` body.
public enum TerminalLifecycle {
    public static func action(for reason: TerminalTeardownReason) -> TerminalTeardownAction {
        switch reason {
        case .viewDismantled:  return .keepAlive
        case .sessionClosed:   return .terminateAndDiscard
        }
    }
}

// MARK: - Focus

/// Which session the terminal screen should show.
///
/// Selection is held by the app state (so creating a session can point the
/// operator at it) and therefore can name a session that has since been
/// closed — hence the validation against the live list rather than a plain
/// read.
public enum TerminalFocus {
    public static func resolve(selection: UUID?, among live: [UUID]) -> UUID? {
        if let selection, live.contains(selection) { return selection }
        return live.first
    }

    /// Where focus lands after `closed` is removed. Only moves when the closed
    /// session was the one on screen — closing a background tab must not yank
    /// the operator somewhere else.
    public static func afterClosing(_ closed: UUID, selection: UUID?, remaining: [UUID]) -> UUID? {
        guard selection == closed else { return selection }
        return remaining.first
    }
}
