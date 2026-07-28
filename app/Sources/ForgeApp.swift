// ForgeApp — menu bar app for answering Forge gates.
//
// This is the "house" around the gate protocol: a headless run parks on a
// question, this shows it in the menu bar, and one click answers it. It is a
// SECOND front-end over the same files — the terminal stays first-class, and
// nothing here is required for the protocol to work.
//
// LSUIElement is set in Info.plist so there is no Dock icon: the app lives in
// the menu bar only.

import SwiftUI
import AppKit

@main
struct ForgeApp: App {
    @StateObject private var store = GateStore()

    var body: some Scene {
        MenuBarExtra {
            GatePanel(store: store)
                // .window style gives a real SwiftUI surface instead of a plain
                // NSMenu, which is what lets each gate render its question,
                // context and one button per option.
                .frame(width: 420)
        } label: {
            MenuBarLabel(count: store.pending.count)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Bolt plus a count. The count is the whole point — it answers "does Forge
/// need me right now?" without opening anything.
struct MenuBarLabel: View {
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: count > 0 ? "bolt.fill" : "bolt")
            if count > 0 { Text("\(count)") }
        }
    }
}

struct GatePanel: View {
    @ObservedObject var store: GateStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            Divider()

            if store.pending.isEmpty {
                EmptyState(store: store)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(store.pending) { gate in
                            GateCard(gate: gate, store: store)
                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 460)
            }

            if let err = store.lastError, !err.isEmpty {
                Divider()
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(10)
                    .textSelection(.enabled)
            }

            Divider()
            footer
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "bolt.fill").foregroundStyle(.orange)
            Text("Forge").font(.headline)
            Spacer()
            if store.pending.isEmpty {
                Text("tudo em dia").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("^[\(store.pending.count) pergunta](inflect: true)")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Adicionar projeto…") { pickWorkspace() }
                .buttonStyle(.link)
            Spacer()
            Text("\(store.workspaces.count) projeto(s)")
                .font(.caption2).foregroundStyle(.secondary)
            Button("Sair") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.link)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func pickWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Observar"
        panel.message = "Escolha a pasta de um projeto que usa o Forge (.gsd/)"
        // Bring the picker forward — a menu bar app has no window to own it.
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
        VStack(alignment: .leading, spacing: 8) {
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
                    // Surfacing the fallback is the honest thing to do: if the
                    // human ignores this, the run WILL proceed with `default`.
                    Text("⏳ \(left) → \(gate.defaultLabel)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .help("Sem resposta, o Forge segue com \"\(gate.defaultLabel)\"")
                }
            }

            Text(gate.question).font(.callout)

            if let ctx = gate.context, !ctx.isEmpty {
                Text(ctx)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.4),
                                in: RoundedRectangle(cornerRadius: 6))
            }

            VStack(spacing: 4) {
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
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(12)
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
                Text("Quando um run precisar de você, aparece aqui e o Mac notifica.")
                    .font(.caption).foregroundStyle(.secondary)

                if !store.recent.isEmpty {
                    Divider().padding(.vertical, 2)
                    Text("Recentes").font(.caption).bold().foregroundStyle(.secondary)
                    ForEach(store.recent) { g in
                        HStack(spacing: 6) {
                            Image(systemName: icon(for: g.effectiveStatus))
                                .foregroundStyle(color(for: g.effectiveStatus))
                                .font(.caption2)
                            Text(g.answer?.label ?? g.effectiveStatus)
                                .font(.caption2)
                            Text(g.question)
                                .font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
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
