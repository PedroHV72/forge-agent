// TerminalLauncher — the sheet that decides what a new session will run.
//
// Split out of TerminalView.swift. It is the only place that turns a choice
// into a command line, and `LauncherSheet.Mode` is the vocabulary AppState
// speaks (`newSession(cwd:mode:…)`), so the type name is load-bearing.

import SwiftUI
import ForgeKit

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

        /// `/forge-*` commands are meaningless outside a project, while a
        /// shell and a free conversation are not — those two are the only
        /// modes allowed to launch into the session root dir.
        var needsProject: Bool {
            switch self {
            case .auto, .newMilestone, .task: return true
            case .chat, .shell: return false
            }
        }

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
                // A choice, not a default — never preselected — so shell/chat
                // can be launched without a project without hiding the option.
                Text("nenhum (root dir)").tag("")
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

            // Destination is on screen before Abrir is reachable — never an
            // implicit landing spot the operator only discovers after launch.
            if mode.needsProject && resolvedWorkspace.isEmpty {
                Text("escolha um projeto para este modo").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("abre em \(launchDirectory)").font(.caption).foregroundStyle(.secondary)
            }

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
                    .disabled(mode.needsProject && resolvedWorkspace.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
        .onAppear {
            if workspace.isEmpty { workspace = initialWorkspace ?? state.preselection.workspace ?? "" }
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

    /// No implicit fallback here, ever — see `b992edf`. Empty is a legal
    /// value; `mode.needsProject` and the button guard are what keep an
    /// empty workspace from reaching a mode that requires one.
    private var resolvedWorkspace: String {
        workspace
    }

    /// Where `open()` actually launches: the picked project, or the
    /// configured session root dir when none is picked. Only ever read for
    /// `!mode.needsProject || !resolvedWorkspace.isEmpty` — the button guard
    /// enforces that combination before this value can be used.
    private var launchDirectory: String {
        resolvedWorkspace.isEmpty ? state.resolvedSessionRoot : resolvedWorkspace
    }

    private func open() {
        state.newSession(cwd: launchDirectory, mode: mode, text: text,
                         account: account, runId: runId)
        if !resolvedWorkspace.isEmpty { state.rememberWorkspace(resolvedWorkspace) }
        isPresented = false
    }
}
