// ForgeApp — desktop app for watching and steering Forge runs.
//
// A second front-end over the same files: the terminal stays first-class and
// nothing here is required for Forge to work. The app reads .gsd/ artefacts and
// delegates every mutation to the engines in scripts/ (see ForgeCore).
//
// WHY A WINDOWED APP AND NOT MENU-BAR-ONLY
// ----------------------------------------
// The first cut was MenuBarExtra + LSUIElement. It was invisible on a notched
// Mac: the NSStatusItem was created correctly — non-nil, isVisible, alpha 1.0 —
// and landed at x=634 on a 1512pt display with safeAreaInsets.top=32, i.e. dead
// behind the notch. macOS stacks status items right-to-left and exposes no API
// to choose a slot, so a menu-bar-only design silently disappears whenever the
// user's bar is full. The Dock icon and its badge cannot be hidden that way.

import SwiftUI
import AppKit

@main
struct ForgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState.shared

    var body: some Scene {
        WindowGroup("Forge") {
            RootView(state: state)
        }
        .defaultSize(width: 820, height: 620)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Atualizar") { state.reloadCheap(); state.loadAccounts() }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Adicionar projeto…") { pickWorkspace(state) }
                    .keyboardShortcut("o", modifiers: .command)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var observer: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installStatusItem()
        refreshBadge()
        Notifier.shared.start()
        // One network check per launch — a release does not land twice in an
        // afternoon, and a timer here would be pure noise.
        UpdateStore.shared.checkOnLaunch()
        observer = NotificationCenter.default.addObserver(
            forName: AppState.didChange, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshBadge() }
        }
    }

    /// Embedded terminals are CHILD PROCESSES: quitting the app kills every
    /// session with it, unlike an external Terminal window. Forge itself is
    /// resumable from disk, so no work is lost — but a unit can be cut off
    /// mid-dispatch, so this must never happen silently.
    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let live = AppState.shared.sessions.filter(\.isRunning)
        guard !live.isEmpty else { return .terminateNow }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = live.count == 1
            ? "1 sessão ainda está rodando"
            : "\(live.count) sessões ainda estão rodando"
        alert.informativeText = """
        Sair encerra \(live.count == 1 ? "essa sessão" : "essas sessões") — \
        \(live.map(\.tabLabel).joined(separator: ", ")).

        O trabalho não se perde: o Forge guarda o estado em disco e você retoma \
        com "Continuar milestone". Mas a unidade em andamento é interrompida.
        """
        alert.addButton(withTitle: "Sair mesmo assim")
        alert.addButton(withTitle: "Cancelar")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    /// Clicking the Dock icon after closing the window should bring it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            for w in sender.windows where w.canBecomeMain {
                w.makeKeyAndOrderFront(nil)
                return true
            }
        }
        return true
    }

    /// The notch-proof signal: a count on the Dock icon that says "Forge is
    /// waiting on you" without needing any menu bar real estate.
    @MainActor
    private func refreshBadge() {
        let n = AppState.shared.pending.count
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
        statusItem?.button?.title = n > 0 ? " \(n)" : ""
    }

    /// Best-effort. On a crowded menu bar this may never be drawn — which is
    /// exactly why it is not the primary surface.
    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "bolt.fill",
                                     accessibilityDescription: "Forge")
        item.button?.imagePosition = .imageLeading
        item.button?.target = self
        item.button?.action = #selector(openWindow)
        statusItem = item
    }

    @objc private func openWindow() {
        NSApp.activate(ignoringOtherApps: true)
        for w in NSApp.windows where w.canBecomeMain {
            w.makeKeyAndOrderFront(nil)
            return
        }
    }
}
