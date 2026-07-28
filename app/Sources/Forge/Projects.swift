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

// MARK: - Discovery

/// Finds Forge projects on disk instead of making the user navigate to each one.
/// A project is any directory containing .gsd/ — the same marker every engine uses.
enum ProjectDiscovery {
    /// Where people actually keep code. Scanned shallowly on purpose: a deep
    /// walk of $HOME would take seconds and wander into node_modules.
    static let roots = ["Development", "Documents", "Projects", "Code", "src", "repos", "Desktop"]
    static let maxDepth = 3

    static func scan() -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var found: Set<String> = []
        for root in roots {
            let base = home.appendingPathComponent(root)
            guard FileManager.default.fileExists(atPath: base.path) else { continue }
            walk(base, depth: 0, into: &found)
        }
        return found.sorted()
    }

    private static func walk(_ dir: URL, depth: Int, into found: inout Set<String>) {
        guard depth <= maxDepth else { return }
        let fm = FileManager.default

        if fm.fileExists(atPath: dir.appendingPathComponent(".gsd").path) {
            found.insert(dir.path)
            // Keep descending: a monorepo can hold nested Forge projects
            // (lookchina/services is one), so stopping here would miss them.
        }

        guard let entries = try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return }

        for e in entries {
            guard (try? e.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            else { continue }
            let name = e.lastPathComponent
            // Directories that never contain a project but are huge to traverse.
            if ["node_modules", "vendor", "Library", ".git", "dist", "build",
                ".build", "target", "Pods"].contains(name) { continue }
            walk(e, depth: depth + 1, into: &found)
        }
    }
}

// MARK: - View

struct ProjectsView: View {
    @ObservedObject var state: AppState
    @State private var discovered: [String] = []
    @State private var scanning = false
    @State private var showDiscovery = false
    @State private var dropTargeted = false

    /// Projects that need attention float to the top: questions first, then
    /// active runs, then name. The list answers "where do I go now?" by order.
    private var ordered: [String] {
        state.workspaces.sorted { a, b in
            let ga = state.pending.filter { $0.cwd == a }.count
            let gb = state.pending.filter { $0.cwd == b }.count
            if ga != gb { return ga > gb }
            let ra = state.liveRuns.filter { $0.cwd == a }.count
            let rb = state.liveRuns.filter { $0.cwd == b }.count
            if ra != rb { return ra > rb }
            return URL(fileURLWithPath: a).lastPathComponent
                .localizedCaseInsensitiveCompare(URL(fileURLWithPath: b).lastPathComponent) == .orderedAscending
        }
    }

    var body: some View {
        ScrollView {
            // Adaptive grid: one column in a narrow window, more as it widens,
            // instead of a single stretched column that wastes the space.
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 320, maximum: 460), spacing: 14)],
                alignment: .leading, spacing: 14
            ) {
                ForEach(ordered, id: \.self) { ws in
                    ProjectCard(path: ws, state: state)
                }
            }
            .padding(18)

            if state.workspaces.isEmpty { empty }
        }
        .navigationTitle("Projetos")
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.accentOrange, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .padding(8)
                    .overlay(Text("Solte para adicionar").font(.callout).bold())
            }
        }
        // Dropping a folder is the fastest way in when you already have it open
        // in Finder.
        .onDrop(of: ["public.file-url"], isTargeted: $dropTargeted) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    var isDir: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
                          isDir.boolValue else { return }
                    Task { @MainActor in state.addWorkspace(url.path) }
                }
            }
            return true
        }
        .sheet(isPresented: $showDiscovery) {
            DiscoverySheet(state: state, found: discovered, isPresented: $showDiscovery)
        }
        .toolbar {
            ToolbarItem {
                Button { scan() } label: {
                    if scanning { ProgressView().controlSize(.small) }
                    else { Label("Procurar", systemImage: "sparkle.magnifyingglass") }
                }
                .disabled(scanning)
                .help("Procurar projetos com .gsd/ no seu Mac")
            }
            ToolbarItem {
                Button { pickWorkspace(state) } label: {
                    Label("Adicionar", systemImage: "plus")
                }
            }
        }
    }

    private func scan() {
        scanning = true
        Task.detached(priority: .userInitiated) {
            let hits = ProjectDiscovery.scan()
            await MainActor.run {
                let known = Set(state.workspaces)
                discovered = hits.filter { !known.contains($0) }
                scanning = false
                if discovered.isEmpty {
                    state.show("Nenhum projeto novo encontrado")
                } else {
                    showDiscovery = true
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
            HStack {
                Button("Procurar no Mac") { scan() }
                Button("Escolher pasta…") { pickWorkspace(state) }
            }
            Text("Ou arraste uma pasta para cá.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
    }
}

/// Results of a scan, with everything pre-selected — the common case is
/// "add them all".
struct DiscoverySheet: View {
    @ObservedObject var state: AppState
    let found: [String]
    @Binding var isPresented: Bool
    @State private var selected: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Projetos encontrados").font(.headline)
            Text("\(found.count) pasta(s) com .gsd/ que ainda não estão na lista.")
                .font(.caption).foregroundStyle(.secondary)

            List(found, id: \.self) { p in
                Toggle(isOn: Binding(
                    get: { selected.contains(p) },
                    set: { on in if on { selected.insert(p) } else { selected.remove(p) } }
                )) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(URL(fileURLWithPath: p).lastPathComponent).font(.callout)
                        Text(abbreviate(p)).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            .frame(height: 240)

            HStack {
                Button(selected.count == found.count ? "Desmarcar todos" : "Marcar todos") {
                    selected = selected.count == found.count ? [] : Set(found)
                }
                .controlSize(.small)
                Spacer()
                Button("Cancelar") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button("Adicionar \(selected.count)") {
                    for p in selected { state.addWorkspace(p) }
                    isPresented = false
                }
                .keyboardShortcut(.defaultAction)
                .disabled(selected.isEmpty)
            }
        }
        .padding(20).frame(width: 520)
        .onAppear { selected = Set(found) }
    }

    private func abbreviate(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
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

    private var abbreviatedPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }
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
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(.headline).lineLimit(1)
                Text(abbreviatedPath).font(.system(size: 9))
                    .foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
            }
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
