// ForgeApp — desktop app for answering Forge gates.
//
// This is the "house" around the gate protocol: a headless run parks on a
// question, this shows it, and one click answers it. It is a SECOND front-end
// over the same files — the terminal stays first-class, and nothing here is
// required for the protocol to work.
//
// WHY A REGULAR WINDOWED APP AND NOT MENU-BAR-ONLY
// ------------------------------------------------
// The first cut was MenuBarExtra with LSUIElement. It worked — the NSStatusItem
// was created, visible, alpha 1.0 — and was still invisible on the author's
// machine, because macOS stacks status items right-to-left and this one landed
// at x=634 on a 1512pt display whose safeAreaInsets.top is 32: dead behind the
// MacBook Pro notch. No API lets an app choose its slot in the menu bar, so a
// menu-bar-only design is at the mercy of how full the user's bar happens to be.
//
// A Dock icon with a badge cannot be hidden by a notch, and "open the app" is
// what was actually asked for. The status item is still installed as a bonus
// when there is room for it.

import SwiftUI
import AppKit

@main
struct ForgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = GateStore.shared

    var body: some Scene {
        WindowGroup("Forge") {
            ContentView(store: store)
                .frame(minWidth: 420, minHeight: 320)
        }
        .defaultSize(width: 480, height: 600)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Atualizar") { store.reload() }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

// MARK: - Delegate: Dock badge + optional status item

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var observer: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installStatusItem()
        refreshBadge()
        observer = NotificationCenter.default.addObserver(
            forName: GateStore.didChange, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshBadge() }
        }
    }

    /// Reopening from the Dock with no window left (user closed it) should bring
    /// the list back rather than doing nothing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            for w in sender.windows where w.canBecomeMain {
                w.makeKeyAndOrderFront(nil)
                return true
            }
        }
        return true
    }

    /// The badge is the notch-proof signal: a number on the Dock icon that says
    /// "Forge is waiting on you" without needing any menu bar real estate.
    @MainActor
    private func refreshBadge() {
        let n = GateStore.shared.pending.count
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
        statusItem?.button?.title = n > 0 ? " \(n)" : ""
    }

    /// Best-effort. On a crowded menu bar (especially with a notch) this may
    /// never be drawn — which is exactly why it is not the primary surface.
    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(
            systemSymbolName: "bolt.fill", accessibilityDescription: "Forge")
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

// MARK: - Main view

struct ContentView: View {
    @ObservedObject var store: GateStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()

            if store.pending.isEmpty {
                EmptyState(store: store)
                Spacer()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(store.pending) { gate in
                            GateCard(gate: gate, store: store)
                            Divider()
                        }
                    }
                }
            }

            if let err = store.lastError, !err.isEmpty {
                Divider()
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(10).textSelection(.enabled)
            }

            Divider()
            footer
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.fill").foregroundStyle(.orange)
            Text("Forge").font(.headline)
            Spacer()
            if store.pending.isEmpty {
                Label("tudo em dia", systemImage: "checkmark.circle.fill")
                    .font(.caption).foregroundStyle(.green)
            } else {
                Text(store.pending.count == 1 ? "1 pergunta" : "\(store.pending.count) perguntas")
                    .font(.caption).bold().foregroundStyle(.orange)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Adicionar projeto…") { pickWorkspace() }
            Spacer()
            Text("\(store.workspaces.count) projeto(s)")
                .font(.caption2).foregroundStyle(.secondary)
            Button {
                store.reload()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Atualizar (⌘R)")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func pickWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Observar"
        panel.message = "Escolha a pasta de um projeto que usa o Forge (.gsd/)"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let url = panel.url {
            store.addWorkspace(url.path)
        }
    }
}

/// One gate: the question, why it is being asked, and a button per option.
struct GateCard: View {
    let gate: Gate
    @ObservedObject var store: GateStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(gate.projectName)
                    .font(.caption).bold()
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                if !gate.subtitle.isEmpty {
                    Text(gate.subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let left = gate.timeLeft {
                    // Surfacing the fallback is the honest thing to do: ignoring
                    // the gate is a real outcome — the run WILL take `default`.
                    Text("⏳ \(left) → \(gate.defaultLabel)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .help("Sem resposta, o Forge segue com \"\(gate.defaultLabel)\"")
                }
            }

            Text(gate.question).font(.callout)

            if let ctx = gate.context, !ctx.isEmpty {
                Text(ctx)
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.4),
                                in: RoundedRectangle(cornerRadius: 6))
            }

            VStack(spacing: 5) {
                ForEach(gate.options) { opt in
                    Button {
                        store.answer(gate, choice: opt.key)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(opt.label).bold()
                            if !opt.description.isEmpty {
                                Text(opt.description)
                                    .font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            Spacer()
                            if opt.key == gate.default {
                                Text("padrão").font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .contentShape(Rectangle())
                        .padding(.vertical, 2)
                    }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(14)
    }
}

struct EmptyState: View {
    @ObservedObject var store: GateStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if store.workspaces.isEmpty {
                Label("Nenhum projeto observado", systemImage: "folder.badge.questionmark")
                    .font(.callout)
                Text("Adicione a pasta de um projeto que usa o Forge para ver as perguntas aqui.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Label("Nenhuma pergunta pendente", systemImage: "checkmark.circle")
                    .font(.callout).foregroundStyle(.secondary)
                Text("Quando um run precisar de você, aparece aqui, o Dock mostra o número e o Mac notifica.")
                    .font(.caption).foregroundStyle(.secondary)

                if !store.recent.isEmpty {
                    Divider().padding(.vertical, 4)
                    Text("Recentes").font(.caption).bold().foregroundStyle(.secondary)
                    ForEach(store.recent) { g in
                        HStack(spacing: 6) {
                            Image(systemName: icon(for: g.effectiveStatus))
                                .foregroundStyle(color(for: g.effectiveStatus)).font(.caption2)
                            Text(g.answer?.label ?? g.effectiveStatus).font(.caption2)
                            Text(g.question).font(.caption2)
                                .foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func icon(for status: String) -> String {
        switch status {
        case "answered":  return "checkmark.circle.fill"
        case "expired":   return "clock.badge.exclamationmark"
        case "cancelled": return "xmark.circle"
        default:          return "circle"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "answered": return .green
        case "expired":  return .orange
        default:         return .secondary
        }
    }
}
