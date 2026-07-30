// Views — the app's surfaces.
//
// VISUAL RULES (deliberate, and worth keeping):
//   1. One accent colour. Orange means "needs you". If nothing is orange,
//      nothing is waiting. Cost, progress and tokens stay grey — colouring
//      everything is the same as colouring nothing.
//   2. Hierarchy comes from type size and whitespace, not borders. Cards use a
//      material fill and no stroke.
//   3. Native materials so it reads as a Mac app rather than a web page.
//   4. Big numbers only where a decision hangs on them.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Shell

enum Section: String, CaseIterable, Identifiable {
    case now = "Início"
    case terminal = "Terminal"
    case projects = "Projetos"
    case items = "Itens"
    case runs = "Runs"
    case accounts = "Contas"
    case metrics = "Métricas"
    case models = "Modelos"
    case secrets = "Segredos"
    case prefs = "Preferências"
    case history = "Histórico"
    case updates = "Atualizações"
    case examples = "Exemplos"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .now:      return "bolt.fill"
        case .terminal: return "terminal"
        case .projects: return "folder"
        case .items:    return "tray.full"
        case .runs:     return "play.circle"
        case .accounts: return "person.2"
        case .metrics:  return "chart.bar.xaxis"
        case .models:   return "cpu"
        case .secrets:  return "lock.shield"
        case .prefs:    return "slider.horizontal.3"
        case .history:  return "clock.arrow.circlepath"
        case .updates:  return "arrow.down.circle"
        case .examples: return "sparkles"
        }
    }
}

struct RootView: View {
    @ObservedObject var state: AppState

    /// The sidebar observes the update store (D32).
    ///
    /// Not polish: `UpdateStore` is a singleton that publishes asynchronously
    /// (`checkOnLaunch` finishes seconds after the window opens), and without an
    /// observation here SwiftUI never re-renders the sidebar when it does. Any
    /// update signal placed in this column — the footer version, next chunk —
    /// would be born empty and stay empty, which is worse than absent.
    ///
    /// The reference sits in a property initializer on purpose. `StateObject`'s
    /// `init(wrappedValue:)` is `@MainActor` and takes an autoclosure, so
    /// `shared` is touched on the main actor. Writing it as a default argument of
    /// an explicit `init` instead is what costs a concurrency warning — that
    /// expression is evaluated in a nonisolated context (learned in chunk 1).
    @StateObject private var updates = UpdateStore.shared

    // Section selection lives in AppState, not in `@State`: opening a session
    // from the composer has to move the operator to the terminal, and only
    // shared state can be driven from there.
    var body: some View {
        NavigationSplitView {
            sidebarList
        } detail: {
            Group {
                switch state.section ?? .now {
                case .now:      NowView(state: state)
                case .terminal: TerminalsView(state: state)
                case .projects: ProjectsView(state: state)
                case .items:    ItemsView(state: state)
                case .runs:     RunsView(state: state)
                case .accounts: AccountsView(state: state)
                case .metrics:  MetricsView(state: state)
                case .models:   ModelsView(state: state)
                case .secrets:  SecretsView(state: state)
                case .prefs:    PrefsView(state: state)
                case .history:  HistoryView(state: state)
                case .updates:  UpdatesView(state: state)
                case .examples: ExamplesView(state: state)
                }
            }
            .frame(minWidth: 460, minHeight: 380)
        }
        .overlay(alignment: .bottom) { toast }
        .animation(.easeInOut(duration: 0.18), value: state.pending.count)
    }

    /// The sidebar list, extracted from `body` so a canvas can render the whole
    /// column at the 180pt minimum width without a window around it — the width
    /// where a `Divider`, or anything added to the footer, has to earn its place.
    private var sidebarList: some View {
        List(selection: $state.section) {
            ForEach(Section.allCases) { s in
                Label {
                    HStack {
                        Text(s.rawValue)
                        Spacer()
                        if let n = badge(for: s) {
                            Text("\(n)")
                                .font(.caption2).monospacedDigit()
                                .foregroundStyle(s == .now ? .white : .secondary)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(s == .now ? AnyShapeStyle(Color.accentOrange)
                                                      : AnyShapeStyle(.quaternary),
                                            in: Capsule())
                        }
                    }
                } icon: {
                    Image(systemName: s.icon)
                        .foregroundStyle(s == .now && !state.pending.isEmpty
                                         ? Color.accentOrange : Color.secondary)
                }
                .tag(s)

                // D29 — one rule between the sections you work in and the ones
                // you configure. 1pt of hierarchy instead of the ~60pt of chrome
                // that real `List` sections would cost (D33).
                //
                // Emitted inside the same `ForEach` deliberately: splitting
                // `Section.allCases` into two arrays would put a second source of
                // truth next to `Stores.swift`, which feeds `SectionRestore`'s
                // validator from `allCases` (D31).
                if s == .runs { Divider() }
            }
        }
        .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
        .safeAreaInset(edge: .bottom) { sidebarFooter }
    }

    /// Counts only, and only where a count means something.
    ///
    /// Updates has no case here (D27): the numeral it used to show was always
    /// `1`, so it counted nothing — it was a dot wearing a number. One signal
    /// belongs in one place, and that place is the footer, next to the version.
    private func badge(for s: Section) -> Int? {
        switch s {
        case .now:      return state.pending.isEmpty ? nil : state.pending.count
        case .runs:     return state.liveRuns.isEmpty ? nil : state.liveRuns.count
        case .terminal: return state.sessions.isEmpty ? nil : state.sessions.count
        case .projects: return state.workspaces.isEmpty ? nil : state.workspaces.count
        default:        return nil
        }
    }

    private var sidebarFooter: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 6) {
                Button {
                    pickWorkspace(state)
                } label: {
                    Label("Adicionar projeto", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
        }
    }

    @ViewBuilder private var toast: some View {
        if let t = state.toast {
            Label(t.text, systemImage: t.isError
                  ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(t.isError ? .orange : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.quaternary))
                .padding(.bottom, 14)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

#if DEBUG
extension RootView {
    /// The sidebar footer on its own, so a canvas can render it at the 180pt
    /// minimum column width — the tight case, where a second line or an extra
    /// glyph truncates. A preview of the whole `RootView` would show the footer
    /// at whatever width the canvas happens to be, which is exactly the width
    /// that hides the problem.
    ///
    /// Same file because `sidebarFooter` is `private`, and a preview is not a
    /// reason to open it to the rest of the module.
    var previewSidebarFooter: some View { sidebarFooter }

    /// The whole sidebar column, for the same reason and by the same means: a
    /// preview of `RootView` would render a full split view at whatever width
    /// the canvas has, and the `Divider` (D29) is judged against the column, not
    /// against a window.
    var previewSidebarList: some View { sidebarList }
}
#endif

@MainActor
func pickWorkspace(_ state: AppState) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.prompt = "Observar"
    panel.message = "Escolha a pasta de um projeto que usa o Forge (.gsd/)"
    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url { state.addWorkspace(url.path) }
}

// MARK: - Agora

/// The home screen. A place to START work, not an inbox.
///
/// It used to lead with the pending-question queue, which framed the app as
/// somewhere you go to answer things — but questions are the exception and
/// starting work is the rule. Pending gates are still surfaced, as a banner
/// that cannot be missed, above the thing you actually came to do.
///
/// The composer works like the Claude Code prompt rather than a form: one line,
/// `/` completes Forge commands, `@` completes projects. Dropdowns for mode and
/// project were a translation of the terminal into a form; this is the terminal.
struct NowView: View {
    @ObservedObject var state: AppState
    @State private var text = ""
    @State private var commands: [SlashCommand] = []
    @State private var project = ""
    @State private var account = ""
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    /// Rows currently offered, as a flat list — the menu shows either commands
    /// or projects, never both, so one index addresses whichever is up.
    private var menuCount: Int { max(matchingCommands.count, matchingProjects.count) }


    private var completion: CompletionContext {
        ComposerParser.context(in: text, caret: text.endIndex)
    }

    private var matchingCommands: [SlashCommand] {
        guard case .command(let q, _) = completion else { return [] }
        return Array(ComposerParser.filter(commands, query: q).prefix(8))
    }

    private var matchingProjects: [String] {
        guard case .project(let q, _) = completion else { return [] }
        return Array(ComposerParser.filterProjects(state.workspaces, query: q).prefix(8))
    }

    private var showingMenu: Bool { !matchingCommands.isEmpty || !matchingProjects.isEmpty }

    /// No implicit fallback. Defaulting to the first workspace meant a line
    /// typed without a project silently ran in whichever one sorted first —
    /// a wrong-repo dispatch that looks exactly like a right one.
    ///
    /// `project` itself may start out preselected via `state.preselection`
    /// (a configured default, or the last-used project) on `.onAppear` — that
    /// is a choice the operator made or a place they already were, never a
    /// guess. `state.workspaces.first` is still never consulted here.
    private var resolvedProject: String { project }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !state.pending.isEmpty { gateBanner }
                composer
                if !state.liveRuns.isEmpty {
                    SectionTitle("Rodando")
                    ForEach(state.liveRuns) { r in RunStrip(run: r, state: state) }
                }
                if state.workspaces.isEmpty { emptyWorkspaces }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Início")
        .onAppear {
            if commands.isEmpty { commands = CommandCatalog.load() }
            // Guarded on `project.isEmpty` so a re-appear (e.g. returning from
            // another tab) never overwrites a project the user already chose.
            if project.isEmpty, let w = state.preselection.workspace { project = w }
            focused = true
        }
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            // PromptEditor zeroes the text container insets, so the first
            // glyph sits at the view origin and a plain Text beside it lands on
            // the same line — no baseline guessing, and it holds at any font
            // size. See PromptEditor.swift for why TextEditor could not.
            HStack(alignment: .top, spacing: 9) {
                Text(">")
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.accentOrange)

                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Pergunte algo, ou digite / para um comando e @ para um projeto")
                            .font(.system(size: 15))
                            .foregroundStyle(.tertiary)
                            .allowsHitTesting(false)
                    }
                    PromptEditor(
                        text: $text,
                        onKey: { handleKey($0) },
                        onSubmit: { submit() })
                    .frame(minHeight: 20, maxHeight: 150)
                    .onChange(of: text) { _ in highlighted = 0 }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)

                Button { submit() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 22))
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSubmit ? Color.accentOrange : Color.secondary.opacity(0.35))
                .disabled(!canSubmit)
                .keyboardShortcut(.return, modifiers: .command)
                .help(canSubmit ? "↩ para enviar · ⇧↩ para nova linha"
                                : "Escolha um projeto com @ antes de enviar")
                // Nudge the icon onto the text line: a symbol is taller than
                // the glyphs it sits beside.
                .offset(y: -3)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)

            if showingMenu {
                Divider()
                completionMenu
            }

            Divider()
            footerBar
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(focused ? Color.accentOrange.opacity(0.35) : .clear))
    }

    private var canSubmit: Bool {
        !resolvedProject.isEmpty && !text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Suggestions, styled like the Claude Code menu: name, then what it does.
    private var completionMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(matchingCommands.enumerated()), id: \.element.id) { idx, cmd in
                completionRow(icon: cmd.source == .skill ? "sparkle" : "terminal",
                              title: cmd.slash,
                              subtitle: cmd.description,
                              selected: idx == highlighted) {
                    accept(cmd.slash)
                }
            }
            ForEach(Array(matchingProjects.enumerated()), id: \.element) { idx, path in
                completionRow(icon: "folder",
                              title: "@" + ProjectOrganiser.name(path),
                              subtitle: ProjectOrganiser.abbreviate(
                                path, home: FileManager.default.homeDirectoryForCurrentUser.path),
                              selected: idx == highlighted) {
                    project = path
                    acceptProject(path)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func completionRow(icon: String, title: String, subtitle: String,
                               selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                    .foregroundStyle(selected ? Color.accentOrange : .secondary)
                    .frame(width: 18, alignment: .center)
                    // An SF Symbol has no text baseline of its own; nudge it
                    // onto the one the labels share.
                    .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
                Text(title)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                if selected {
                    Text("⇥").font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 9)
            .background(selected ? AnyShapeStyle(Color.accentOrange.opacity(0.13))
                                 : AnyShapeStyle(.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Context bar: where this will run, and on which account. Shown as text
    /// rather than dropdowns — @ sets the project, and the account is a rare
    /// override that does not deserve a permanent control.
    private var footerBar: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: resolvedProject.isEmpty ? "folder.badge.questionmark" : "folder")
                .font(.system(size: 11))
                .foregroundStyle(resolvedProject.isEmpty ? AnyShapeStyle(Color.accentOrange)
                                                         : AnyShapeStyle(.tertiary))
            if resolvedProject.isEmpty {
                Text("escolha um projeto com @")
                    .font(.caption).foregroundStyle(Color.accentOrange)
            } else {
                Text(ProjectOrganiser.name(resolvedProject))
                    .font(.caption).foregroundStyle(.secondary)
                    .help(resolvedProject)
                Button {
                    project = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 9))
                }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
                .help("Limpar o projeto")
            }

            if let c = ComposerParser.split(text).command {
                Text("· /\(c)").font(.caption).foregroundStyle(Color.accentOrange)
            }

            Spacer()

            Menu {
                Button("conta padrão") { account = "" }
                ForEach(state.accounts.filter(\.has_token)) { a in
                    Button(a.name) { account = a.name }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "person.crop.circle").font(.system(size: 11))
                    Text(account.isEmpty ? "conta padrão" : account).font(.caption)
                }
                .foregroundStyle(.secondary)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()

            HStack(spacing: 3) {
                Text("↩").font(.system(size: 11, design: .monospaced))
                Text("enviar").font(.system(size: 10))
                Text("·").foregroundStyle(.quaternary)
                Text("⇧↩").font(.system(size: 11, design: .monospaced))
                Text("nova linha").font(.system(size: 10))
            }
            .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    // MARK: Keyboard

    /// Called by the editor before it treats a key as editing. Returning true
    /// consumes it. Scoped to the menu being open, so ordinary typing, caret
    /// movement and newlines behave normally the rest of the time — which a
    /// global event monitor could not promise.
    private func handleKey(_ action: PromptEditor.KeyAction) -> Bool {
        // With the menu open, the keys drive the menu.
        if showingMenu {
            switch action {
            case .up:
                highlighted = max(0, highlighted - 1)
            case .down:
                highlighted = min(menuCount - 1, highlighted + 1)
            case .tab, .enter:
                acceptHighlighted()
            case .shiftEnter:
                return false        // still a newline
            case .escape:
                // End the token rather than clearing the line: what was typed
                // so far is still what the user meant.
                text += " "
            }
            return true
        }

        // Menu closed: Enter sends, Shift+Enter breaks the line. That is the
        // convention in Claude Code and every chat input, and it is why ⌘↩ read
        // as an odd requirement rather than a shortcut.
        if action == .enter {
            submit()
            return true
        }
        return false
    }

    private func acceptHighlighted() {
        if !matchingCommands.isEmpty, highlighted < matchingCommands.count {
            accept(matchingCommands[highlighted].slash)
        } else if !matchingProjects.isEmpty, highlighted < matchingProjects.count {
            let path = matchingProjects[highlighted]
            project = path
            acceptProject(path)
        }
    }

    // MARK: Actions

    private func accept(_ replacement: String) {
        guard case .command(_, let range) = completion else { return }
        let (newText, _) = ComposerParser.complete(text, range: range, with: replacement)
        text = newText
    }

    /// A project mention selects the target and leaves the text clean — it is
    /// context for the session, not part of the prompt.
    private func acceptProject(_ path: String) {
        guard case .project(_, let range) = completion else { return }
        var out = text
        out.replaceSubrange(range, with: "")
        text = out.trimmingCharacters(in: .whitespaces)
    }

    /// Turn the line into a session. A leading slash command is passed through
    /// as-is, so anything Forge gains tomorrow works here without a code change;
    /// plain text opens a conversation.
    private func submit() {
        guard canSubmit else { return }
        let line = text.trimmingCharacters(in: .whitespaces)
        state.newSessionRaw(cwd: resolvedProject, prompt: line, account: account)
        // Record where work actually happened, so the next launch preselects
        // it as the last-used default — the second-choice tier in `preselection`.
        state.rememberWorkspace(resolvedProject)
        text = ""
        // newSessionRaw already focused the new session; nothing further to do
        // here. Creating a terminal and leaving the operator on this screen —
        // with only a toast to explain it — was the original complaint.
    }

    // MARK: Gate banner

    /// Questions are the exception, so they get a banner rather than the page.
    private var gateBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill").foregroundStyle(Color.accentOrange)
                Text(state.pending.count == 1
                     ? "1 run está esperando você"
                     : "\(state.pending.count) runs estão esperando você")
                    .font(.callout).bold()
                Spacer()
            }
            ForEach(state.pending) { gate in GateCard(gate: gate, state: state) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentOrange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(Color.accentOrange.opacity(0.3)))
    }

    private var emptyWorkspaces: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum projeto observado", systemImage: "folder.badge.questionmark")
                .font(.callout)
            Text("Adicione a pasta de um projeto que usa o Forge para começar.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Adicionar projeto…") { pickWorkspace(state) }.controlSize(.small)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct GateCard: View {
    let gate: Gate
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill")
                    .font(.caption).foregroundStyle(Color.accentOrange)
                Text(gate.projectName).font(.caption).bold()
                if !gate.subtitle.isEmpty {
                    Text(gate.subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let left = gate.timeLeft {
                    // Ignoring a gate is a real outcome, not the absence of one:
                    // the run WILL proceed with `default`. Hiding that would
                    // make the app lie by omission.
                    Text("⏳ \(left) → \(gate.defaultLabel)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .help("Sem resposta, o Forge segue com \"\(gate.defaultLabel)\"")
                }
            }

            Text(gate.question).font(.body)

            if let ctx = gate.context, !ctx.isEmpty {
                Text(ctx)
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.35),
                                in: RoundedRectangle(cornerRadius: 8))
            }

            // Options sit side by side while there is room and stack when the
            // window narrows, instead of squeezing labels into ellipses.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { optionButtons }
                VStack(spacing: 6) { optionButtons }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(Color.accentOrange.opacity(0.35), lineWidth: 1))
    }

    @ViewBuilder private var optionButtons: some View {
        Group {
                ForEach(gate.options) { opt in
                    Button { state.answer(gate, choice: opt.key) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(opt.label).bold()
                            if !opt.description.isEmpty {
                                Text(opt.description)
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            Spacer()
                            if opt.key == gate.default {
                                Text("padrão").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        .contentShape(Rectangle()).padding(.vertical, 3)
                    }
                    .buttonStyle(.bordered).frame(maxWidth: .infinity)
                }
        }
    }
}

// MARK: - Runs

struct RunsView: View {
    @ObservedObject var state: AppState
    @State private var showLauncher = false

    /// Runs that stopped recently. A finished milestone is not noise — it is
    /// the answer to "did that thing I started overnight actually land?".
    private var recent: [Run] {
        state.runs.filter { !$0.active }
            .sorted { ($0.last_heartbeat ?? 0) > ($1.last_heartbeat ?? 0) }
            .prefix(4).map { $0 }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if state.liveRuns.isEmpty {
                    emptyState
                } else {
                    ForEach(state.liveRuns) { r in
                        RunCard(run: r, status: state.status[r.cwd], state: state)
                    }
                }

                if !recent.isEmpty {
                    SectionTitle("Encerrados recentemente")
                    ForEach(recent) { r in FinishedRunRow(run: r) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Runs")
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher)
        }
        .toolbar {
            ToolbarItem {
                Button { state.refreshStatus(force: true) } label: {
                    Label("Atualizar", systemImage: "arrow.clockwise")
                }
                .help("Recarrega o progresso de cada projeto")
            }
            ToolbarItem {
                Button { showLauncher = true } label: {
                    Label("Nova sessão", systemImage: "plus")
                }
            }
        }
        .onAppear { state.refreshStatus(force: true) }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nenhum run ativo.").font(.callout).foregroundStyle(.secondary)
            Text("Um run aparece aqui assim que o /forge-auto começa — no terminal do app ou fora dele.")
                .font(.caption).foregroundStyle(.tertiary)
            Button("Abrir sessão…") { showLauncher = true }.controlSize(.small)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct RunCard: View {
    let run: Run
    let status: StatusPayload?
    @ObservedObject var state: AppState
    @State private var showSlices = false

    private var milestone: MilestoneStatus? {
        // Only trust the milestone block when it belongs to THIS run: a project
        // with several runs reports one focused milestone, and attributing it to
        // the wrong card would show someone else's progress.
        guard let m = status?.milestone, m.id == run.id else { return nil }
        return m
    }

    private var gatesHere: [Gate] {
        state.pending.filter { $0.cwd == run.cwd && ($0.run_id == run.id || $0.run_id == nil) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            header
            if let m = milestone { progressBlock(m) } else { noStatusYet }
            liveRow
            if !gatesHere.isEmpty { gateRow }
            if let m = milestone, let slices = m.slices, !slices.isEmpty {
                sliceDisclosure(m, slices)
            }
            Divider().padding(.vertical, 1)
            actions
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(gatesHere.isEmpty ? .clear : Color.accentOrange.opacity(0.4), lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(run.isStale ? Color.orange : Color.green)
                .frame(width: 7, height: 7)
                .help(run.isStale ? "Sem heartbeat há mais de 15min" : "Ativo")
            Text(run.projectName).font(.headline)
            if let title = milestone?.displayTitle {
                Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if milestone?.auto_mode == "on" {
                Label("auto", systemImage: "play.circle.fill")
                    .font(.caption2).foregroundStyle(.secondary)
                    .help("forge-auto está conduzindo este run")
            }
            if state.isPaused(run) {
                Label("pausa pedida", systemImage: "pause.circle.fill")
                    .font(.caption2).foregroundStyle(Color.accentOrange)
            }
        }
    }

    @ViewBuilder private func progressBlock(_ m: MilestoneStatus) -> some View {
        if let p = m.progress, p.total > 0 {
            VStack(alignment: .leading, spacing: 4) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.quaternary).frame(height: 6)
                        Capsule().fill(Color.accentOrange.opacity(0.75))
                            .frame(width: max(3, geo.size.width * p.fraction), height: 6)
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                .frame(height: 8)
                HStack(spacing: 6) {
                    Text("\(p.done) de \(p.total) slices")
                        .font(.caption).monospacedDigit()
                    Text("· \(p.percent)%").font(.caption).foregroundStyle(.tertiary)
                    Spacer()
                    Text(run.id).font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary).textSelection(.enabled)
                }
            }
        }
    }

    private var noStatusYet: some View {
        HStack(spacing: 6) {
            Text(run.id).font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary).textSelection(.enabled)
            Spacer()
        }
    }

    /// What is happening right now, and what comes next — the two questions a
    /// running milestone actually raises.
    private var liveRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 8) {
                Text("agora").font(.caption2).foregroundStyle(.tertiary)
                    .frame(width: 48, alignment: .leading)
                if let w = run.workerParts {
                    HStack(spacing: 5) {
                        Text(w.unit).font(.caption).bold()
                        if !w.id.isEmpty {
                            Text(w.id).font(.caption).foregroundStyle(.secondary)
                        }
                        if let e = run.workerElapsed {
                            Text("· \(e)").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                } else if let phase = milestone?.phase {
                    Text(phase).font(.caption).bold()
                } else {
                    Text("entre unidades").font(.caption).foregroundStyle(.tertiary)
                }
                Spacer()
            }
            if let next = milestone?.next_action, !next.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Text("próximo").font(.caption2).foregroundStyle(.tertiary)
                        .frame(width: 48, alignment: .leading)
                    Text(next).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// A run blocked on a question is the one thing here that needs acting on.
    private var gateRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.fill").font(.caption2).foregroundStyle(Color.accentOrange)
            Text(gatesHere.count == 1 ? "1 pergunta esperando" : "\(gatesHere.count) perguntas esperando")
                .font(.caption).foregroundStyle(Color.accentOrange)
            Spacer()
        }
    }

    @ViewBuilder private func sliceDisclosure(_ m: MilestoneStatus, _ slices: [SliceStatus]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { showSlices.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: showSlices ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8))
                    Text("Slices").font(.caption)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)

            if showSlices {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(slices) { sl in
                        HStack(spacing: 6) {
                            Image(systemName: sl.isDone ? "checkmark.circle.fill"
                                  : (sl.id == m.active_slice ? "play.circle.fill" : "circle"))
                                .font(.system(size: 10))
                                .foregroundStyle(sl.isDone ? AnyShapeStyle(Color.green)
                                                 : (sl.id == m.active_slice
                                                    ? AnyShapeStyle(Color.accentOrange)
                                                    : AnyShapeStyle(.tertiary)))
                            Text(sl.id).font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.secondary).frame(width: 26, alignment: .leading)
                            Text(sl.title ?? "").font(.caption2).lineLimit(1)
                            if sl.isHighRisk && !sl.isDone {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.system(size: 8)).foregroundStyle(.orange)
                                    .help("Slice de risco alto")
                            }
                            Spacer()
                            if sl.totalTasks > 0 {
                                Text("\(sl.doneTasks)/\(sl.totalTasks)")
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .padding(8)
                .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            let paused = state.isPaused(run)
            Button(paused ? "Retomar" : "Pausar") { state.togglePause(run) }
                .controlSize(.small)
                .help(paused ? "Remove o pedido de pausa"
                             : "Para ao fim da unidade atual, não no meio")
            Button("Abrir terminal") { state.resume(run) }
                .controlSize(.small)
            Button("Ver pasta") { ForgeCore.reveal(run.cwd) }
                .controlSize(.small)
            Spacer()
            if let iso = run.isolation_mode {
                Text(iso).font(.caption2).foregroundStyle(.tertiary)
                    .help("Modo de isolamento deste run")
            }
            if let acct = run.account, !acct.isEmpty {
                Text(acct).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

/// A run that has stopped. Shows why, because "encerrado" alone does not say
/// whether it finished or died.
struct FinishedRunRow: View {
    let run: Run

    private var reason: String {
        switch run.deactivated_reason {
        case "complete-milestone": return "milestone concluída"
        case "complete-task":      return "task concluída"
        case "handoff":            return "troca de conta"
        case "pause":              return "pausado"
        case .some(let r):         return r
        case .none:                return "encerrado"
        }
    }

    private var isClean: Bool {
        (run.deactivated_reason ?? "").hasPrefix("complete")
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: isClean ? "checkmark.circle" : "stop.circle")
                .font(.caption).foregroundStyle(isClean ? AnyShapeStyle(Color.green)
                                                        : AnyShapeStyle(.tertiary))
            Text(run.projectName).font(.callout)
            Text(run.id).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                .lineLimit(1).truncationMode(.middle)
            Spacer()
            Text(reason).font(.caption2).foregroundStyle(.secondary)
            if let hb = run.last_heartbeat, let ago = Duration.short(ms: Date.nowMs - hb) {
                Text(ago).font(.caption2).foregroundStyle(.tertiary)
                    .frame(width: 44, alignment: .trailing)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.2), in: RoundedRectangle(cornerRadius: 9))
    }
}

/// Condensed run row for the "Agora" screen.
struct RunStrip: View {
    let run: Run
    @ObservedObject var state: AppState

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(run.isStale ? Color.orange : Color.green)
                .frame(width: 6, height: 6)
            Text(run.projectName).font(.callout)
            Text(run.id).font(.caption).foregroundStyle(.secondary)
            if let w = run.workerParts {
                Text("· \(w.unit) \(w.id)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(run.elapsed).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Contas

struct AccountsView: View {
    @ObservedObject var state: AppState

    /// Only meaningful once usage has actually been polled — ordering by
    /// last_used would look confident while knowing nothing about capacity.
    private var recommended: String? {
        guard state.usage.count > 1 else { return nil }
        return state.accountsByHeadroom.first { $0.has_token && state.usage[$0.name] != nil }?.name
    }

    /// Capacity across every polled account: the answer to "do I have fuel?"
    /// before the answer to "which account".
    private var totalHeadroom: Double? {
        let known = state.accounts.compactMap { state.usage[$0.name]?.headroom }
        guard !known.isEmpty else { return nil }
        return known.reduce(0, +) / Double(known.count)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                summary
                if state.accounts.isEmpty { empty }
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 330), spacing: 14)],
                    alignment: .leading, spacing: 14
                ) {
                    ForEach(state.accountsByHeadroom) { a in
                        AccountCard(account: a, usage: state.usage[a.name],
                                    isRecommended: a.name == recommended, state: state)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Contas")
        .onAppear { state.loadAccounts() }
        .toolbar {
            ToolbarItem {
                Button {
                    state.refreshUsage()
                } label: {
                    if state.usageLoading { ProgressView().controlSize(.small) }
                    else { Label("Consultar uso", systemImage: "arrow.clockwise") }
                }
                .disabled(state.usageLoading)
                .help("Consulta a API de cada conta — gasta ~9 tokens por conta")
            }
        }
    }

    private var summary: some View {
        HStack(spacing: 16) {
            if let total = totalHeadroom {
                Gauge(value: total, tint: Meter.tint(headroom: total), size: 54, lineWidth: 6) {
                    VStack(spacing: -1) {
                        Text("\(Int(total))%").font(.system(size: 15, weight: .semibold))
                            .monospacedDigit()
                        Text("livre").font(.system(size: 8)).foregroundStyle(.secondary)
                    }
                }
            } else {
                Image(systemName: "chart.pie")
                    .font(.system(size: 26)).foregroundStyle(.tertiary)
                    .frame(width: 54, height: 54)
            }

            VStack(alignment: .leading, spacing: 3) {
                if let r = recommended {
                    HStack(spacing: 5) {
                        Image(systemName: "sparkles").foregroundStyle(Color.accentOrange)
                        Text("Use \(r)").font(.headline)
                    }
                    Text("Maior folga semanal entre as contas consultadas.")
                        .font(.caption).foregroundStyle(.secondary)
                } else if state.usageCheckedAt == nil {
                    Text("Capacidade desconhecida").font(.headline)
                    Text("Consulte o uso para saber qual conta tem folga.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("\(state.accounts.count) conta(s)").font(.headline)
                }
            }
            Spacer()
            if let at = state.usageCheckedAt {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(at.formatted(date: .omitted, time: .shortened))
                        .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    Text("consultado").font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("Nenhuma conta registrada", systemImage: "person.crop.circle.badge.questionmark")
                .font(.callout)
            // Registration needs a real TTY: `claude setup-token` opens a browser
            // login, which the app cannot host.
            Text("Registrar exige um terminal de verdade — o login abre o navegador.")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text("forge-accounts add <nome>")
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Button {
                    state.copyToPasteboard("forge-accounts add ", label: "Comando")
                } label: { Image(systemName: "doc.on.doc").font(.caption2) }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
            }
            .padding(8)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
    }
}


/// An icon-only menu button.
///
/// SwiftUI's Menu draws a disclosure chevron beside its label by default, which
/// on an icon label reads as a glyph with something stuck to it. Hiding the
/// indicator and giving the button a real hit area (rather than the width of
/// the glyph) is what makes it look intentional.
struct IconMenu<Content: View>: View {
    var icon: String = "ellipsis"
    var help: String = "Mais opções"
    @ViewBuilder var content: () -> Content

    @State private var hovering = false

    var body: some View {
        Menu {
            content()
        } label: {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 26, height: 22)
                .background(hovering ? AnyShapeStyle(.quaternary)
                                     : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(hovering ? .primary : .secondary)
        .onHover { hovering = $0 }
        .help(help)
    }
}

// MARK: - Meter primitives

enum Meter {
    /// Neutral while healthy; colour only once it demands a decision — the same
    /// discipline as the rest of the app, so a coloured ring always means
    /// something. 70% used is the handoff threshold, 90% is nearly spent.
    static func tint(headroom: Double) -> Color {
        if headroom <= 10 { return .red }
        if headroom <= 30 { return Color.accentOrange }
        return Color.secondary.opacity(0.75)
    }
}

/// A ring gauge. Reads capacity faster than a bar and costs far less width,
/// which is what makes room for the identity line beside it.
struct Gauge<Label: View>: View {
    let value: Double          // 0...100, the portion that is FREE
    let tint: Color
    var size: CGFloat = 46
    var lineWidth: CGFloat = 5
    @ViewBuilder var label: () -> Label

    var body: some View {
        ZStack {
            Circle()
                .stroke(.quaternary, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.01, min(1, value / 100)))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            label()
        }
        .frame(width: size, height: size)
        .animation(.easeOut(duration: 0.35), value: value)
    }
}

// MARK: - Account card

struct AccountCard: View {
    let account: Account
    let usage: AccountUsage?
    let isRecommended: Bool
    @ObservedObject var state: AppState

    @State private var confirmingRemove = false
    @State private var renaming = false
    @State private var draftName = ""

    /// Two different notions of "current". Conflating them is how you end up
    /// believing a terminal runs on an account it does not:
    ///   padrão — what a bare `claude` attaches to
    ///   em uso — what this app's sessions were launched with
    private var isDefault: Bool { state.activeAccount == account.name }
    private var sessionCount: Int { state.sessions.filter { $0.account == account.name }.count }
    private var weeklyFree: Double? { usage?.seven_day.map { 100 - $0.pct } }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ring
            VStack(alignment: .leading, spacing: 7) {
                titleRow
                identityRow
                if usage != nil { windows } else { unknownUsage }
                footer
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(isRecommended ? Color.accentOrange.opacity(0.45) : .clear, lineWidth: 1.5))
        .confirmationDialog("Remover \(account.name)?",
                            isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remover", role: .destructive) { state.removeAccount(account.name) }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Apaga a conta do registro e o token do Keychain. A conta na Anthropic não é afetada.")
        }
        .sheet(isPresented: $renaming) {
            RenameSheet(current: account.name, draft: $draftName, isPresented: $renaming) { new in
                state.renameAccount(account.name, to: new)
            }
        }
    }

    @ViewBuilder private var ring: some View {
        if let free = weeklyFree {
            Gauge(value: free, tint: Meter.tint(headroom: free), size: 62, lineWidth: 7) {
                VStack(spacing: -2) {
                    Text("\(Int(free))").font(.system(size: 19, weight: .semibold)).monospacedDigit()
                    Text("% livre").font(.system(size: 8)).foregroundStyle(.secondary)
                }
            }
        } else {
            ZStack {
                Circle().stroke(.quaternary, lineWidth: 7)
                Image(systemName: "questionmark")
                    .font(.system(size: 16)).foregroundStyle(.tertiary)
            }
            .frame(width: 62, height: 62)
        }
    }

    private var titleRow: some View {
        HStack(spacing: 6) {
            Text(account.name).font(.headline).lineLimit(1)
            if isRecommended {
                Image(systemName: "sparkles").font(.caption2)
                    .foregroundStyle(Color.accentOrange)
                    .help("Maior folga semanal")
            }
            if isDefault {
                Image(systemName: "checkmark.circle.fill").font(.caption2)
                    .foregroundStyle(.secondary)
                    .help("Conta padrão — um `claude` sem argumentos entra nela")
            }
            if sessionCount > 0 {
                Image(systemName: "terminal.fill").font(.caption2)
                    .foregroundStyle(.secondary)
                    .help("\(sessionCount) sessão(ões) do app nesta conta")
            }
            Spacer()
            IconMenu(help: "Opções da conta") {
                if !isDefault && account.has_token {
                    Button("Tornar padrão") { state.setDefaultAccount(account.name) }
                }
                Button("Renomear…") { draftName = account.name; renaming = true }
                Button("Registrar identidade desta sessão") {
                    state.captureAccountIdentity(account.name)
                }
                Divider()
                Button("Copiar comando de launch") { state.copyLaunchCommand(account.name) }
                if let email = account.email, !email.isEmpty {
                    Button("Copiar e-mail") { state.copyToPasteboard(email, label: "E-mail") }
                }
                if let uuid = account.account_uuid, !uuid.isEmpty {
                    Button("Copiar UUID") { state.copyToPasteboard(uuid, label: "UUID") }
                }
                Divider()
                Button("Remover…", role: .destructive) { confirmingRemove = true }
            }
        }
    }

    @ViewBuilder private var identityRow: some View {
        if let email = account.email, !email.isEmpty {
            Text(email)
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
        } else {
            Text("identidade não registrada")
                .font(.caption).foregroundStyle(.tertiary)
                .help("Sem isso a statusline não nomeia um login direto do Keychain")
        }
    }

    private var windows: some View {
        VStack(spacing: 4) {
            MiniWindow(label: "5h", window: usage?.five_hour)
            MiniWindow(label: "7d", window: usage?.seven_day)
        }
    }

    private var unknownUsage: some View {
        Text("uso não consultado")
            .font(.caption2).foregroundStyle(.tertiary)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let d = account.days_left {
                Label("\(d)d", systemImage: account.tokenExpiringSoon ? "key.slash" : "key")
                    .font(.caption2)
                    .foregroundStyle(account.tokenExpiringSoon
                                     ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tertiary))
                    .help(account.tokenExpiringSoon
                          ? "Token expira em \(d) dias — renove com forge-accounts add \(account.name)"
                          : "Token válido por \(d) dias")
            }
            if !account.has_token {
                Label("sem token", systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(.orange)
            }
            if let used = account.last_used, let when = Self.relative(used) {
                Label(when, systemImage: "clock")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .help("Último uso registrado")
            }
            Spacer()
        }
    }

    private static func relative(_ iso: String) -> String? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return nil }
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }
}

/// Compact window row. Thin, because the ring already carries the headline
/// number — this is the detail you read second.
struct MiniWindow: View {
    let label: String
    let window: UsageWindow?

    private var free: Double { 100 - min(100, max(0, window?.pct ?? 0)) }

    var body: some View {
        HStack(spacing: 7) {
            Text(label)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.tertiary).frame(width: 15, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(height: 4)
                    Capsule().fill(Meter.tint(headroom: free))
                        .frame(width: max(2, geo.size.width * free / 100), height: 4)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 8)

            Text("\(Int(free))%")
                .font(.system(size: 10)).monospacedDigit()
                .foregroundStyle(.secondary).frame(width: 30, alignment: .trailing)

            Text(window?.resetsIn ?? "—")
                .font(.system(size: 9)).foregroundStyle(.tertiary)
                .frame(width: 38, alignment: .trailing)
                .help("Tempo até esta janela zerar")
        }
    }
}

struct RenameSheet: View {
    let current: String
    @Binding var draft: String
    @Binding var isPresented: Bool
    let onRename: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Renomear conta").font(.headline)
            Text("O token continua o mesmo — só muda o nome no registro.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("nome", text: $draft)
                .textFieldStyle(.roundedBorder).onSubmit { commit() }
            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Renomear") { commit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || draft == current)
            }
        }
        .padding(20).frame(width: 360)
    }

    private func commit() {
        let clean = draft.trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty, clean != current else { return }
        onRename(clean)
        isPresented = false
    }
}

// MARK: - Histórico

struct HistoryView: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if state.recent.isEmpty {
                    Text("Nada respondido ainda.")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(state.recent) { g in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: icon(g.effectiveStatus))
                                .font(.caption).foregroundStyle(color(g.effectiveStatus))
                                .frame(width: 16)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(g.question).font(.callout).lineLimit(2)
                                HStack(spacing: 6) {
                                    Text(g.projectName).font(.caption2).foregroundStyle(.tertiary)
                                    if !g.subtitle.isEmpty {
                                        Text(g.subtitle).font(.caption2).foregroundStyle(.tertiary)
                                    }
                                    if let a = g.answer {
                                        Text("→ \(a.label ?? "—")").font(.caption2)
                                            .foregroundStyle(.secondary)
                                        if a.source == "timeout-default" {
                                            Text("(por tempo)").font(.caption2)
                                                .foregroundStyle(.orange)
                                        }
                                    }
                                }
                            }
                            Spacer()
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.25),
                                    in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            .padding(18)
        }
        .navigationTitle("Histórico")
    }

    private func icon(_ s: String) -> String {
        switch s {
        case "answered":  return "checkmark.circle.fill"
        case "expired":   return "clock.badge.exclamationmark"
        case "cancelled": return "xmark.circle"
        default:          return "circle"
        }
    }

    private func color(_ s: String) -> Color {
        switch s {
        case "answered": return .green
        case "expired":  return .orange
        default:         return .secondary
        }
    }
}

// MARK: - Shared bits

struct SectionTitle: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text.uppercased())
            .font(.caption2).bold().foregroundStyle(.tertiary)
            .padding(.top, 4)
    }
}

extension Color {
    /// The single accent. Everything else stays neutral on purpose.
    static let accentOrange = Color(red: 1.0, green: 0.58, blue: 0.13)
}
