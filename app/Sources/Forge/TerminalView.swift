// TerminalView — a real terminal inside the app.
//
// Backed by SwiftTerm's LocalProcessTerminalView, which owns the PTY and the
// VT emulation. Claude Code repaints continuously (alternate screen, cursor
// addressing, 256 colours), so nothing less than a real emulator renders it
// correctly — a partial ANSI parser yields a garbled screen, not a plain one.
//
// The shell is started as a LOGIN shell so the user's rc runs. That matters
// here specifically: install.sh wires `eval "$(forge-accounts shell-init)"`
// into the rc, and that hook is what attaches the right Claude account to a
// bare `claude`. Skipping the login shell would silently run every session on
// the wrong account.

import SwiftUI
import AppKit
import SwiftTerm
import ForgeKit

// MARK: - Session model

@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id = UUID()
    let cwd: String
    let title: String

    /// Command queued to run once the shell is ready. Sent as keystrokes rather
    /// than as argv so it lands in shell history and stays visible/editable.
    let bootstrap: String?

    /// Which run this session drives, when it drives one. With several
    /// milestones in the same project the project name alone cannot tell two
    /// tabs apart — the run id is the only thing that can.
    let runId: String?
    let account: String?

    @Published var isRunning = true
    @Published var exitLabel: String?

    var projectName: String { URL(fileURLWithPath: cwd).lastPathComponent }

    /// Short, unambiguous tab label.
    var tabLabel: String {
        if let runId { return runId }
        return title
    }

    init(cwd: String, title: String, bootstrap: String? = nil,
         runId: String? = nil, account: String? = nil) {
        self.cwd = cwd
        self.title = title
        self.bootstrap = bootstrap
        self.runId = runId
        self.account = account
    }
}

// MARK: - NSViewRepresentable bridge

struct TerminalHost: NSViewRepresentable {
    @ObservedObject var session: TerminalSession

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let view = LocalProcessTerminalView(frame: .zero)
        view.processDelegate = context.coordinator

        let term = view.getTerminal()
        term.setCursorStyle(.blinkBlock)
        applyTheme(view)

        // A login shell so ~/.zshrc runs — see the note at the top of the file.
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        var env = Terminal.getEnvironmentVariables(termName: "xterm-256color")
        env.append("LANG=en_US.UTF-8")
        // Marks the session so Forge tooling (and the user) can tell where it runs.
        env.append("FORGE_APP=1")

        // SwiftTerm inherits the parent's cwd, so it has to be set around the
        // spawn — and restored immediately. Leaving it changed would silently
        // reroute every relative path in the app, and each new session would
        // inherit the previous one's directory.
        let previousCwd = FileManager.default.currentDirectoryPath
        FileManager.default.changeCurrentDirectoryPath(session.cwd)
        view.startProcess(
            executable: shell,
            args: ["-l"],
            environment: env,
            execName: "-\(URL(fileURLWithPath: shell).lastPathComponent)")
        FileManager.default.changeCurrentDirectoryPath(previousCwd)

        if let boot = session.bootstrap {
            context.coordinator.scheduleBootstrap(boot, on: view)
        }
        return view
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {
        applyTheme(nsView)
    }

    /// Colours tuned to sit next to the app's own surfaces rather than to
    /// imitate Terminal.app.
    private func applyTheme(_ view: LocalProcessTerminalView) {
        view.nativeBackgroundColor = NSColor(calibratedRed: 0.07, green: 0.07,
                                             blue: 0.085, alpha: 1)
        view.nativeForegroundColor = NSColor(calibratedWhite: 0.88, alpha: 1)
        view.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    }

    @MainActor
    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        let session: TerminalSession
        private var didBootstrap = false

        init(session: TerminalSession) { self.session = session }

        /// Give the login shell a beat to finish sourcing rc files before typing
        /// into it, otherwise the keystrokes race the prompt and get eaten.
        func scheduleBootstrap(_ command: String, on view: LocalProcessTerminalView) {
            guard !didBootstrap else { return }
            didBootstrap = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak view] in
                guard let view else { return }
                view.send(txt: command + "\n")
            }
        }

        func processTerminated(source: TerminalView, exitCode: Int32?) {
            session.isRunning = false
            session.exitLabel = exitCode.map { $0 == 0 ? "encerrado" : "saiu com código \($0)" }
                ?? "encerrado"
        }

        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    }
}

// MARK: - Terminal screen

struct TerminalsView: View {
    @ObservedObject var state: AppState
    @State private var selection: UUID?
    @State private var showLauncher = false

    var body: some View {
        Group {
            if state.sessions.isEmpty {
                launcherPane
            } else {
                VStack(spacing: 0) {
                    // One session needs no tab strip — a slim header with a
                    // real "Encerrar" button reads better than a lone tab with
                    // a tiny x. Several sessions need to be comparable at a
                    // glance, so they become tabs.
                    if state.sessions.count == 1, let only = state.sessions.first {
                        SingleSessionHeader(session: only, state: state)
                    } else {
                        tabStrip
                    }
                    Divider()
                    ZStack {
                        // Every session stays mounted; hiding rather than
                        // unmounting keeps the PTY and scrollback alive when
                        // you switch tabs.
                        ForEach(state.sessions) { s in
                            TerminalHost(session: s)
                                .opacity(s.id == currentID ? 1 : 0)
                                .allowsHitTesting(s.id == currentID)
                        }
                    }
                }
            }
        }
        .navigationTitle("Terminal")
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher)
        }
        .toolbar {
            ToolbarItem {
                Button { showLauncher = true } label: {
                    Label("Nova sessão", systemImage: "plus")
                }
                .help("Nova sessão (⌘T)")
            }
        }
        .onAppear { if selection == nil { selection = state.sessions.first?.id } }
    }

    private var currentID: UUID? {
        if let selection, state.sessions.contains(where: { $0.id == selection }) {
            return selection
        }
        return state.sessions.first?.id
    }

    /// Up to four tabs share the width evenly; beyond that they keep a readable
    /// minimum and the strip scrolls, so tabs never shrink into unreadable slivers.
    private var tabStrip: some View {
        let evenly = state.sessions.count <= 4
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(state.sessions) { s in
                    TerminalTab(
                        session: s,
                        isActive: s.id == currentID,
                        onSelect: { selection = s.id },
                        onClose: { close(s) })
                    .frame(minWidth: 150, maxWidth: evenly ? .infinity : 230)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: evenly ? .infinity : nil, alignment: .leading)
        }
        .scrollDisabled(evenly)
    }

    private func close(_ s: TerminalSession) {
        if state.closeSession(s, confirm: true), selection == s.id {
            selection = state.sessions.first?.id
        }
    }

    private var launcherPane: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 14) {
                Image(systemName: "terminal")
                    .font(.system(size: 34)).foregroundStyle(.tertiary)
                Text("Nenhuma sessão aberta").font(.headline)
                Text("Rode o Forge aqui dentro — o terminal é real, com sua conta e suas skills.")
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 320)
                Button("Nova sessão…") { showLauncher = true }
                    .controlSize(.large)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

/// Header shown when exactly one session is open.
struct SingleSessionHeader: View {
    @ObservedObject var session: TerminalSession
    @ObservedObject var state: AppState

    var body: some View {
        HStack(spacing: 9) {
            Circle().fill(session.isRunning ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            Text(session.tabLabel).font(.callout).bold()
            Text(session.projectName).font(.caption).foregroundStyle(.secondary)
            if let a = session.account, !a.isEmpty {
                Text("· \(a)").font(.caption).foregroundStyle(.tertiary)
            }
            if let e = session.exitLabel {
                Text(e).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Button(session.isRunning ? "Encerrar" : "Fechar") {
                _ = state.closeSession(session, confirm: true)
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }
}

/// One tab. The close control is a real 18pt hit target that appears on hover
/// (or whenever the tab is active), instead of a permanent 8pt glyph that is
/// both hard to hit and visually noisy across many tabs.
struct TerminalTab: View {
    @ObservedObject var session: TerminalSession
    let isActive: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(session.isRunning ? Color.green : Color.secondary)
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 1) {
                Text(session.tabLabel)
                    .font(.caption).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 4) {
                    Text(session.projectName)
                    if let a = session.account, !a.isEmpty { Text("· \(a)") }
                }
                .font(.system(size: 9)).foregroundStyle(.tertiary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if hovering || isActive {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(hovering ? .primary : .tertiary)
                .help("Fechar sessão")
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(isActive ? AnyShapeStyle(.quaternary)
                             : AnyShapeStyle(hovering ? AnyShapeStyle(.quaternary.opacity(0.5))
                                                      : AnyShapeStyle(.clear)),
                    in: RoundedRectangle(cornerRadius: 7))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { hovering = $0 }
    }
}

// MARK: - Launcher

struct LauncherSheet: View {
    @ObservedObject var state: AppState
    @Binding var isPresented: Bool
    /// Pre-selected project when opened from a project card.
    var initialWorkspace: String? = nil

    @State private var workspace = ""
    @State private var mode: Mode = .auto
    @State private var text = ""
    @State private var account = ""
    @State private var runId = ""

    enum Mode: String, CaseIterable, Identifiable {
        case auto = "Continuar milestone"
        case newMilestone = "Novo milestone"
        case task = "Task avulsa"
        case chat = "Conversar"
        case shell = "Só o shell"
        var id: String { rawValue }

        var hint: String {
            switch self {
            case .auto:         return "/forge-auto — retoma de onde parou"
            case .newMilestone: return "/forge-new-milestone — brainstorm, discuss e plano"
            case .task:         return "/forge-task — trabalho pontual, sem milestone"
            case .chat:         return "abre o claude sem comando — conversa livre"
            case .shell:        return "abre o shell sem rodar nada"
            }
        }

        var needsText: Bool { self == .newMilestone || self == .task }

        var shortLabel: String {
            switch self {
            case .auto:         return "auto"
            case .newMilestone: return "milestone"
            case .task:         return "task"
            case .chat:         return "chat"
            case .shell:        return "shell"
            }
        }
    }

    /// Runs already alive in the selected project. Forge refuses a bare
    /// /forge-auto once two or more are active (multi_run.refused_when_active_count),
    /// so the id is not a nicety here — without it the command is rejected.
    private var runsHere: [Run] {
        state.liveRuns.filter { $0.cwd == resolvedWorkspace }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nova sessão").font(.headline)

            Picker("Projeto", selection: $workspace) {
                ForEach(state.workspaces, id: \.self) { ws in
                    Text(URL(fileURLWithPath: ws).lastPathComponent).tag(ws)
                }
            }

            Picker("Conta", selection: $account) {
                Text("padrão").tag("")
                ForEach(state.accounts.filter(\.has_token)) { a in
                    Text(a.name).tag(a.name)
                }
            }

            Picker("O que fazer", selection: $mode) {
                ForEach(Mode.allCases) { m in Text(m.rawValue).tag(m) }
            }
            .pickerStyle(.radioGroup)

            Text(mode.hint).font(.caption).foregroundStyle(.secondary)

            if mode == .auto { autoSection }

            if mode.needsText {
                TextField(mode == .task ? "O que precisa ser feito?"
                                        : "Descreva o milestone (opcional)",
                          text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(2...5)
            }

            HStack {
                Button("Cancelar") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Abrir") { open() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(resolvedWorkspace.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
        .onAppear {
            if workspace.isEmpty { workspace = initialWorkspace ?? state.workspaces.first ?? "" }
            state.loadAccounts()
            state.reloadCheap()
            if runId.isEmpty { runId = runsHere.first?.id ?? "" }
        }
        // Single-argument form: the two-argument onChange is macOS 14+, and the
        // deployment target is 13.
        .onChange(of: workspace) { _ in runId = runsHere.first?.id ?? "" }
    }

    @ViewBuilder private var autoSection: some View {
        if runsHere.isEmpty {
            Text("Nenhuma run ativa neste projeto — /forge-auto vai pegar a milestone atual do STATE.")
                .font(.caption2).foregroundStyle(.tertiary)
        } else {
            Picker("Run", selection: $runId) {
                ForEach(runsHere) { r in
                    Text("\(r.id)\(r.worker.map { " · \($0)" } ?? "")").tag(r.id)
                }
            }
            if runsHere.count >= 2 {
                // Explains why the picker is not optional, rather than silently
                // producing a command the orchestrator will reject.
                Label("Com 2+ runs ativas o Forge exige o ID — por isso ele vai junto.",
                      systemImage: "info.circle")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var resolvedWorkspace: String {
        workspace.isEmpty ? (state.workspaces.first ?? "") : workspace
    }

    private func open() {
        state.newSession(cwd: resolvedWorkspace, mode: mode, text: text,
                         account: account, runId: runId)
        isPresented = false
    }
}
