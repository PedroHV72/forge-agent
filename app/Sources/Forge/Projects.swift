// Projects — the workspaces Forge watches, and their live state.
//
// Until now a "project" was just a path in a JSON array with a + button hidden
// in the sidebar footer. This makes it a first-class object: what is running in
// it, what it is waiting on, and where to act.
//
// Per-project state comes from `forge-status.js --json`, which already knows
// how to read runs, the focused milestone and warnings. That call spawns node,
// so it is refreshed on demand and cached — unlike gates and runs, which are
// plain file reads and can be polled.

import SwiftUI
import AppKit

// MARK: - Status payload

struct ProjectStatus: Codable {
    let cwd: String?
    let runs: Runs?
    let milestone: Milestone?
    let warnings: [String]?

    struct Runs: Codable {
        let active: [ActiveRun]?
        let focused: String?
        let note: String?
    }

    struct ActiveRun: Codable {
        let id: String?
        let worker: String?
    }

    struct Milestone: Codable {
        let id: String?
        let title: String?
        let phase: String?
        let slice: String?
        let progress: String?
    }
}

// MARK: - View

struct ProjectsView: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            // Adaptive grid: one column in a narrow window, more as it widens,
            // instead of a single stretched column that wastes the space.
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 320, maximum: 460), spacing: 14)],
                alignment: .leading, spacing: 14
            ) {
                ForEach(state.workspaces, id: \.self) { ws in
                    ProjectCard(path: ws, state: state)
                }
            }
            .padding(18)

            if state.workspaces.isEmpty { empty }
        }
        .navigationTitle("Projetos")
        .toolbar {
            ToolbarItem {
                Button { pickWorkspace(state) } label: {
                    Label("Adicionar", systemImage: "plus")
                }
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 30)).foregroundStyle(.tertiary)
            Text("Nenhum projeto").font(.headline)
            Text("Adicione a pasta de um projeto que use o Forge (com .gsd/).")
                .font(.caption).foregroundStyle(.secondary)
            Button("Adicionar projeto…") { pickWorkspace(state) }
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
    }
}

struct ProjectCard: View {
    let path: String
    @ObservedObject var state: AppState

    @State private var status: ProjectStatus?
    @State private var loading = false
    @State private var showLauncher = false
    @State private var hovering = false

    private var name: String { URL(fileURLWithPath: path).lastPathComponent }
    private var runsHere: [Run] { state.liveRuns.filter { $0.cwd == path } }
    private var gatesHere: [Gate] { state.pending.filter { $0.cwd == path } }
    private var sessionsHere: [TerminalSession] { state.sessions.filter { $0.cwd == path } }

    /// A project without .gsd/ is almost always a wrong folder pick, and saying
    /// so beats rendering an empty card that looks broken.
    private var hasGsd: Bool {
        FileManager.default.fileExists(atPath: "\(path)/.gsd")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if !hasGsd {
                Label("Sem .gsd/ — o Forge ainda não foi iniciado aqui",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(.orange)
            }

            stats

            if let m = status?.milestone, let id = m.id {
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.title ?? id).font(.caption).lineLimit(1)
                    HStack(spacing: 6) {
                        Text(id).font(.caption2).foregroundStyle(.tertiary)
                        if let p = m.phase { Text("· \(p)").font(.caption2).foregroundStyle(.tertiary) }
                        if let s = m.slice { Text("· \(s)").font(.caption2).foregroundStyle(.tertiary) }
                    }
                }
            }

            if let w = status?.warnings, !w.isEmpty {
                ForEach(w.prefix(2), id: \.self) { line in
                    Label(line, systemImage: "exclamationmark.circle")
                        .font(.caption2).foregroundStyle(.orange).lineLimit(2)
                }
            }

            Divider().padding(.vertical, 1)
            actions
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(gatesHere.isEmpty ? Color.clear
                                            : Color.accentOrange.opacity(0.35), lineWidth: 1))
        .onHover { hovering = $0 }
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher, initialWorkspace: path)
        }
        .task(id: path) { await refresh() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder.fill")
                .font(.caption).foregroundStyle(.secondary)
            Text(name).font(.headline).lineLimit(1)
            Spacer()
            if loading { ProgressView().controlSize(.small).scaleEffect(0.7) }
            if hovering {
                Button { Task { await refresh(force: true) } } label: {
                    Image(systemName: "arrow.clockwise").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
                .help("Atualizar estado")
            }
        }
    }

    /// Counts first: they answer "does this project need me?" before any detail.
    private var stats: some View {
        HStack(spacing: 14) {
            Stat(value: gatesHere.count, label: "pergunta", accent: !gatesHere.isEmpty)
            Stat(value: runsHere.count, label: "run", accent: false)
            Stat(value: sessionsHere.count, label: "sessão", accent: false)
        }
    }

    private var actions: some View {
        // ViewThatFits keeps the buttons on one row while there is room and
        // wraps them instead of clipping when the card is narrow.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { buttons }
            VStack(alignment: .leading, spacing: 6) { buttons }
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Abrir sessão") { showLauncher = true }
            .controlSize(.small)
        Button("Ver pasta") { ForgeCore.reveal(path) }
            .controlSize(.small)
        Menu {
            Button("Copiar caminho") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(path, forType: .string)
            }
            Divider()
            Button("Remover da lista", role: .destructive) {
                state.removeWorkspace(path)
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .frame(width: 26)
        .help(path)
    }

    private func refresh(force: Bool = false) async {
        guard hasGsd, !loading else { return }
        loading = true
        defer { loading = false }
        let p = path
        let result: ProjectStatus? = await Task.detached(priority: .utility) {
            ForgeCore.runJSON(ProjectStatus.self, "forge-status.js", ["--json", "--cwd", p])
        }.value
        status = result
    }
}

struct Stat: View {
    let value: Int
    let label: String
    let accent: Bool

    var body: some View {
        HStack(spacing: 4) {
            Text("\(value)")
                .font(.title3).monospacedDigit()
                .foregroundStyle(accent ? Color.accentOrange : .primary)
            Text(value == 1 ? label : label + "s")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .opacity(value == 0 ? 0.45 : 1)
    }
}
