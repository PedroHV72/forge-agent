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
    @AppStorage("projectsGrouping") private var groupingRaw = ProjectGrouping.byFolder.rawValue
    @State private var collapsed: Set<String> = []

    private var grouping: ProjectGrouping {
        ProjectGrouping(rawValue: groupingRaw) ?? .byFolder
    }

    /// Projects needing attention first: questions, then active runs, then name.
    /// The order answers "where do I go now?" without reading every card.
    private func ordered(_ list: [String]) -> [String] {
        list.sorted { a, b in
            let ga = state.pending.filter { $0.cwd == a }.count
            let gb = state.pending.filter { $0.cwd == b }.count
            if ga != gb { return ga > gb }
            let ra = state.liveRuns.filter { $0.cwd == a }.count
            let rb = state.liveRuns.filter { $0.cwd == b }.count
            if ra != rb { return ra > rb }
            return ProjectOrganiser.name(a)
                .localizedCaseInsensitiveCompare(ProjectOrganiser.name(b)) == .orderedAscending
        }
    }

    private var containment: [String: Int] {
        ProjectOrganiser.containment(state.workspaces)
    }

    private let columns = [GridItem(.adaptive(minimum: 300), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !state.workspaces.isEmpty { hazardNotice }

                switch grouping {
                case .flat:
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                        ForEach(ordered(state.workspaces), id: \.self) { ws in
                            ProjectCard(path: ws, state: state,
                                        contains: containment[ws] ?? 0)
                        }
                    }
                case .byFolder:
                    ForEach(ProjectOrganiser.groups(state.workspaces)) { group in
                        folderSection(group)
                    }
                }

                if state.workspaces.isEmpty && state.touchedWorkspaces.isEmpty { empty }

                if !state.touchedWorkspaces.isEmpty { touchedNotice }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
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
                Picker("", selection: $groupingRaw) {
                    ForEach(ProjectGrouping.allCases, id: \.rawValue) { g in
                        Text(g.rawValue).tag(g.rawValue)
                    }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 160)
            }
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

    // MARK: Folder section

    @ViewBuilder private func folderSection(_ group: ProjectGroup) -> some View {
        let isCollapsed = collapsed.contains(group.path)
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    if isCollapsed { collapsed.remove(group.path) }
                    else { collapsed.insert(group.path) }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9))
                    Image(systemName: "folder").font(.caption)
                    Text(group.title).font(.callout).bold()
                    Text("\(group.projects.count)")
                        .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                    // Attention rolls up: a collapsed folder still says whether
                    // something inside needs you.
                    let pending = group.projects
                        .flatMap { ws in state.pending.filter { $0.cwd == ws } }.count
                    if pending > 0 {
                        Text("\(pending)")
                            .font(.caption2).monospacedDigit()
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentOrange.opacity(0.22), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)

            if !isCollapsed {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                    ForEach(ordered(group.projects), id: \.self) { ws in
                        ProjectCard(path: ws, state: state, contains: containment[ws] ?? 0)
                    }
                }
            }
        }
        .padding(.bottom, 4)
    }

    // MARK: Hazard

    /// A project containing most of the others is nearly always a stray .gsd/ at
    /// the top of a code folder. Never removed automatically — a monorepo does
    /// legitimately contain its own services — but it should not stay invisible.
    @ViewBuilder private var hazardNotice: some View {
        let suspects = containment
            .filter { $0.value >= max(3, state.workspaces.count / 2) }
            .sorted { $0.value > $1.value }
        if let worst = suspects.first {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.accentOrange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(ProjectOrganiser.name(worst.key)) contém \(worst.value) dos outros projetos")
                        .font(.callout)
                    Text("Um .gsd/ na raiz de uma pasta de código engole tudo abaixo dela. Se não for proposital, remova-o da lista.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Remover da lista") { state.removeWorkspace(worst.key) }
                    .controlSize(.small)
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentOrange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.accentOrange.opacity(0.3)))
        }
    }

    // MARK: Touched

    /// Registered directories holding a `.gsd/` with no work inside.
    ///
    /// Listed rather than quietly dropped. The predicate is a heuristic, and
    /// the operator is the one who knows whether a repo is a project that lost
    /// its artifacts or a repo a run merely walked through — hiding these would
    /// look exactly like a detector that had broken.
    @ViewBuilder private var touchedNotice: some View {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "circle.dashed").font(.caption)
                Text("Tocados por outro projeto").font(.callout).bold()
                Text("\(state.touchedWorkspaces.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
            }
            Text("Têm .gsd/ mas nada de trabalho dentro. O Forge criava essa pasta em todo repositório que uma run encostava; não cria mais.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(state.touchedWorkspaces, id: \.self) { p in
                HStack(spacing: 8) {
                    Text(ProjectOrganiser.abbreviate(p, home: home))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Button("Remover") { state.removeWorkspace(p) }
                        .controlSize(.small).buttonStyle(.borderless)
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    }

    private func scan() {
        scanning = true
        Task.detached(priority: .userInitiated) {
            let hits = ProjectDiscovery.scan()
            await MainActor.run {
                // Touched paths count as known: they are registered, so
                // re-offering one that gained a milestone would duplicate it.
                let known = Set(state.workspaces).union(state.touchedWorkspaces)
                discovered = hits.filter { !known.contains($0) }
                scanning = false
                if discovered.isEmpty { state.show("Nenhum projeto novo encontrado") }
                else { showDiscovery = true }
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

/// Results of a scan, pre-selected — the common case is "add them all".
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
                        Text(ProjectOrganiser.name(p)).font(.callout)
                        Text(ProjectOrganiser.abbreviate(
                            p, home: FileManager.default.homeDirectoryForCurrentUser.path))
                            .font(.caption2).foregroundStyle(.tertiary)
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
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Button("Adicionar \(selected.count)") {
                    for p in selected { state.addWorkspace(p) }
                    isPresented = false
                }
                .keyboardShortcut(.defaultAction).disabled(selected.isEmpty)
            }
        }
        .padding(20).frame(width: 520)
        .onAppear { selected = Set(found) }
    }
}

struct ProjectCard: View {
    let path: String
    @ObservedObject var state: AppState
    /// How many other registered projects live inside this one.
    var contains: Int = 0

    @State private var status: ProjectStatus?
    @State private var checkouts: [Checkout] = []
    @State private var openItems = 0
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
                    if contains > 0 {
                        Text("⊃ \(contains)")
                            .font(.system(size: 9)).foregroundStyle(Color.accentOrange)
                            .help("Contém \(contains) outro(s) projeto(s) registrado(s)")
                    }
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
            Stat(value: openItems, label: "item", pluralLabel: "itens", accent: false)
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
        IconMenu(help: path) {
            Button("Copiar caminho") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(path, forType: .string)
            }
            Button("Abrir no Finder") { ForgeCore.reveal(path) }
            Divider()
            Button("Remover da lista", role: .destructive) {
                state.removeWorkspace(path)
            }
        }
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
        let items = await Task.detached(priority: .utility) {
            ForgeCore.runJSON([Item].self, "forge-items.js", ["--list", "--json", "--cwd", p])
        }.value
        openItems = ItemBoard.openCount(items ?? [])
    }
}

struct Stat: View {
    let value: Int
    let label: String
    /// Explicit plural label for cases where mechanical "+s" pluralization
    /// would be wrong (e.g. pt-BR "item" -> "itens", not "items").
    var pluralLabel: String?
    let accent: Bool

    init(value: Int, label: String, pluralLabel: String? = nil, accent: Bool) {
        self.value = value
        self.label = label
        self.pluralLabel = pluralLabel
        self.accent = accent
    }

    var body: some View {
        HStack(spacing: 4) {
            Text("\(value)")
                .font(.title3).monospacedDigit()
                .foregroundStyle(accent ? Color.accentOrange : .primary)
            Text(value == 1 ? label : (pluralLabel ?? label + "s"))
                .font(.caption2).foregroundStyle(.secondary)
        }
        .opacity(value == 0 ? 0.45 : 1)
    }
}
