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
import ForgeKit

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

// MARK: - Folder appearance

/// Uses the folder's real Finder icon and colour tags, so a project looks in
/// the app exactly as it does in Finder — including custom icons and tags the
/// user set themselves.
enum FolderLook {
    static func icon(for path: String) -> NSImage {
        let img = NSWorkspace.shared.icon(forFile: path)
        img.size = NSSize(width: 32, height: 32)
        return img
    }

    /// Finder tag names, mapped to their standard colours.
    static func tagColors(for path: String) -> [Color] {
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resourceValues(forKeys: [.tagNamesKey]),
              let names = values.tagNames else { return [] }
        return names.compactMap { color(named: $0) }
    }

    private static func color(named raw: String) -> Color? {
        switch raw.lowercased() {
        case "red", "vermelho":       return .red
        case "orange", "laranja":     return .orange
        case "yellow", "amarelo":     return .yellow
        case "green", "verde":        return .green
        case "blue", "azul":          return .blue
        case "purple", "roxo":        return .purple
        case "gray", "grey", "cinza": return .gray
        default:                      return nil
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
                columns: [GridItem(.adaptive(minimum: 300), spacing: 14)],
                alignment: .leading, spacing: 14
            ) {
                ForEach(ordered, id: \.self) { ws in
                    ProjectCard(path: ws, state: state)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
    @State private var checkouts: [Checkout] = []
    @State private var loading = false
    @State private var showLauncher = false
    @State private var launchTarget: String?
    @State private var hovering = false
    @State private var expanded = false

    private var name: String { URL(fileURLWithPath: path).lastPathComponent }

    private var abbreviatedPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    /// Runs and gates are attributed by cwd, and with worktree isolation that
    /// cwd is the WORKTREE, not the folder in the list. Matching only the
    /// project path would show zero activity while a milestone is running.
    private var ownedPaths: Set<String> {
        Set([path] + checkouts.map(\.path))
    }

    private var runsHere: [Run] { state.liveRuns.filter { ownedPaths.contains($0.cwd) } }
    private var gatesHere: [Gate] { state.pending.filter { $0.cwd.map(ownedPaths.contains) ?? false } }
    private var sessionsHere: [TerminalSession] { state.sessions.filter { ownedPaths.contains($0.cwd) } }

    private var extraCheckouts: [Checkout] { checkouts.filter { !$0.isPrimary } }

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
                        if let sl = m.slice { Text("· \(sl)").font(.caption2).foregroundStyle(.tertiary) }
                    }
                }
            }

            if let w = status?.warnings, !w.isEmpty {
                ForEach(w.prefix(2), id: \.self) { line in
                    Label(line, systemImage: "exclamationmark.circle")
                        .font(.caption2).foregroundStyle(.orange).lineLimit(2)
                }
            }

            if !extraCheckouts.isEmpty { worktreeSection }

            Divider().padding(.vertical, 1)
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(gatesHere.isEmpty ? Color.clear
                                            : Color.accentOrange.opacity(0.35), lineWidth: 1))
        .onHover { hovering = $0 }
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher,
                          initialWorkspace: launchTarget ?? path)
        }
        .task(id: path) { await refresh() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            // The real Finder icon, so a folder with a custom icon looks the
            // same here as it does in Finder.
            Image(nsImage: FolderLook.icon(for: path))
                .resizable().frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(name).font(.headline).lineLimit(1)
                    ForEach(Array(FolderLook.tagColors(for: path).enumerated()), id: \.offset) { _, c in
                        Circle().fill(c).frame(width: 7, height: 7)
                    }
                }
                Text(abbreviatedPath).font(.system(size: 9))
                    .foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
            }
            Spacer()
            if loading { ProgressView().controlSize(.small).scaleEffect(0.7) }
            if hovering && !loading {
                Button { Task { await refresh() } } label: {
                    Image(systemName: "arrow.clockwise").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
                .help("Atualizar estado")
            }
        }
    }

    private var stats: some View {
        HStack(spacing: 14) {
            Stat(value: gatesHere.count, label: "pergunta", accent: !gatesHere.isEmpty)
            Stat(value: runsHere.count, label: "run", accent: false)
            Stat(value: sessionsHere.count, label: "sessão", accent: false)
        }
    }

    /// Worktrees are where isolated milestones actually run, so they are
    /// navigable: open a session directly in one, or reveal it.
    private var worktreeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8))
                    Image(systemName: "arrow.triangle.branch").font(.caption2)
                    Text(extraCheckouts.count == 1 ? "1 worktree"
                                                   : "\(extraCheckouts.count) worktrees")
                        .font(.caption)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)

            if expanded {
                ForEach(extraCheckouts) { c in
                    HStack(spacing: 7) {
                        Image(nsImage: FolderLook.icon(for: c.path))
                            .resizable().frame(width: 15, height: 15)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(c.name).font(.caption2).lineLimit(1)
                            if let b = c.branch {
                                Text(b).font(.system(size: 9))
                                    .foregroundStyle(.tertiary).lineLimit(1)
                            }
                        }
                        Spacer()
                        if state.liveRuns.contains(where: { $0.cwd == c.path }) {
                            Circle().fill(Color.green).frame(width: 5, height: 5)
                        }
                        Button {
                            launchTarget = c.path
                            state.addWorkspaceQuietly(c.path)
                            showLauncher = true
                        } label: {
                            Image(systemName: "terminal").font(.system(size: 9))
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Abrir sessão nesta worktree")
                        Button { ForgeCore.reveal(c.path) } label: {
                            Image(systemName: "folder").font(.system(size: 9))
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Ver no Finder")
                    }
                    .padding(.leading, 12)
                }
            }
        }
    }

    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { buttons }
            VStack(alignment: .leading, spacing: 6) { buttons }
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Abrir sessão") { launchTarget = path; showLauncher = true }
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

    private func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let p = path

        // git is cheap; forge-status spawns node, so both go off the main actor.
        let trees = await Task.detached(priority: .utility) { Git.checkouts(at: p) }.value
        checkouts = trees

        guard hasGsd else { return }
        status = await Task.detached(priority: .utility) {
            ForgeCore.runJSON(ProjectStatus.self, "forge-status.js", ["--json", "--cwd", p])
        }.value
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
