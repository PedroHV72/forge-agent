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

// MARK: - Shell

enum Section: String, CaseIterable, Identifiable {
    case now = "Agora"
    case terminal = "Terminal"
    case projects = "Projetos"
    case runs = "Runs"
    case accounts = "Contas"
    case prefs = "Preferências"
    case history = "Histórico"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .now:      return "bolt.fill"
        case .terminal: return "terminal"
        case .projects: return "folder"
        case .runs:     return "play.circle"
        case .accounts: return "person.2"
        case .prefs:    return "slider.horizontal.3"
        case .history:  return "clock.arrow.circlepath"
        }
    }
}

struct RootView: View {
    @ObservedObject var state: AppState
    @State private var section: Section? = .now

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
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
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
            .safeAreaInset(edge: .bottom) { sidebarFooter }
        } detail: {
            Group {
                switch section ?? .now {
                case .now:      NowView(state: state)
                case .terminal: TerminalsView(state: state)
                case .projects: ProjectsView(state: state)
                case .runs:     RunsView(state: state)
                case .accounts: AccountsView(state: state)
                case .prefs:    PrefsView(state: state)
                case .history:  HistoryView(state: state)
                }
            }
            .frame(minWidth: 460, minHeight: 380)
        }
        .overlay(alignment: .bottom) { toast }
        .animation(.easeInOut(duration: 0.18), value: state.pending.count)
    }

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

struct NowView: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if state.pending.isEmpty {
                    calmHeader
                } else {
                    ForEach(state.pending) { g in GateCard(gate: g, state: state) }
                }

                if !state.liveRuns.isEmpty {
                    SectionTitle("Rodando")
                    ForEach(state.liveRuns) { r in RunStrip(run: r, state: state) }
                }

                if state.workspaces.isEmpty { emptyWorkspaces }
            }
            .padding(18)
        }
        .navigationTitle("Agora")
    }

    private var calmHeader: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title2).foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("Tudo em dia").font(.headline)
                Text("Nenhuma pergunta pendente.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(16)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    }

    private var emptyWorkspaces: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum projeto observado", systemImage: "folder.badge.questionmark")
                .font(.callout)
            Text("Adicione a pasta de um projeto que usa o Forge para acompanhar aqui.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Adicionar projeto…") { pickWorkspace(state) }
                .controlSize(.small)
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if state.liveRuns.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Nenhum run ativo.")
                            .font(.callout).foregroundStyle(.secondary)
                        Text("Um run aparece aqui assim que o /forge-auto começa — no terminal do app ou fora dele.")
                            .font(.caption).foregroundStyle(.tertiary)
                        Button("Abrir sessão…") { showLauncher = true }
                            .controlSize(.small)
                    }
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.3),
                                in: RoundedRectangle(cornerRadius: 12))
                } else {
                    ForEach(state.liveRuns) { r in RunCard(run: r, state: state) }
                }
            }
            .padding(18)
        }
        .navigationTitle("Runs")
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher)
        }
        .toolbar {
            ToolbarItem {
                Button { showLauncher = true } label: {
                    Label("Nova sessão", systemImage: "plus")
                }
            }
        }
    }
}

struct RunCard: View {
    let run: Run
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Circle()
                    .fill(run.isStale ? Color.orange : Color.green)
                    .frame(width: 7, height: 7)
                Text(run.projectName).font(.headline)
                Text(run.id).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(run.statusLabel).font(.caption2).foregroundStyle(.secondary)
            }

            if let d = run.task_description, !d.isEmpty {
                Text(d).font(.callout).lineLimit(2)
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 5) {
                if let w = run.workerParts {
                    GridRow {
                        Text("agora").font(.caption).foregroundStyle(.tertiary)
                        HStack(spacing: 6) {
                            Text(w.unit).font(.caption).bold()
                            if !w.id.isEmpty {
                                Text(w.id).font(.caption).foregroundStyle(.secondary)
                            }
                            if let e = run.workerElapsed {
                                Text("· \(e)").font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                GridRow {
                    Text("rodando há").font(.caption).foregroundStyle(.tertiary)
                    Text(run.elapsed).font(.caption)
                }
                if let acct = run.account, !acct.isEmpty {
                    GridRow {
                        Text("conta").font(.caption).foregroundStyle(.tertiary)
                        Text(acct).font(.caption)
                    }
                }
                if let iso = run.isolation_mode {
                    GridRow {
                        Text("isolamento").font(.caption).foregroundStyle(.tertiary)
                        Text(iso).font(.caption)
                    }
                }
            }

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
                if state.isPaused(run) {
                    Label("pausa pedida", systemImage: "pause.circle")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
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
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Contas

struct AccountsView: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 14)],
                    alignment: .leading, spacing: 14
                ) {
                    ForEach(state.accountsByHeadroom) { a in
                        AccountCard(account: a, usage: state.usage[a.name], state: state)
                    }
                }
            }
            .padding(18)
        }
        .navigationTitle("Contas")
        .onAppear { state.loadAccounts() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                if let at = state.usageCheckedAt {
                    Text("Uso verificado \(at.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Uso não verificado")
                        .font(.caption).foregroundStyle(.secondary)
                }
                // Honesty about cost: this button spends quota, so say so.
                Text("Consultar gasta ~9 tokens por conta.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Button {
                state.refreshUsage()
            } label: {
                if state.usageLoading {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Consultar uso", systemImage: "arrow.clockwise")
                }
            }
            .disabled(state.usageLoading)
            .controlSize(.small)
        }
    }
}

struct AccountCard: View {
    let account: Account
    let usage: AccountUsage?
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: isActive ? "largecircle.fill.circle" : "circle")
                    .font(.caption)
                    .foregroundStyle(isActive ? Color.accentOrange : Color.secondary)
                Text(account.name).font(.headline)
                if !account.has_token {
                    Text("sem token").font(.caption2).foregroundStyle(.orange)
                }
                Spacer()
                if isActive {
                    Text("ativa").font(.caption2).foregroundStyle(Color.accentOrange)
                } else if account.has_token {
                    Button("Usar") { state.launch(account: account.name) }
                        .controlSize(.small)
                        .help("Abre um terminal novo nesta conta (não muda o padrão)")
                }
            }

            if let u = usage {
                UsageBar(label: "5h", window: u.five_hour)
                UsageBar(label: "7d", window: u.seven_day)
            } else {
                Text("uso desconhecido — use “Consultar uso”")
                    .font(.caption2).foregroundStyle(.tertiary)
            }

            if let d = account.days_left {
                Text("token expira em \(d) dias")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private var isActive: Bool { state.activeAccount == account.name }
}

struct UsageBar: View {
    let label: String
    let window: UsageWindow?

    var body: some View {
        HStack(spacing: 10) {
            Text(label).font(.caption2).monospaced()
                .foregroundStyle(.tertiary).frame(width: 20, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(height: 6)
                    Capsule().fill(color)
                        .frame(width: max(2, geo.size.width * pct / 100), height: 6)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 10)

            Text("\(Int(pct))%").font(.caption2).monospacedDigit()
                .frame(width: 34, alignment: .trailing)

            if let r = window?.resetsIn {
                Text(r).font(.caption2).foregroundStyle(.tertiary)
                    .frame(width: 46, alignment: .trailing)
            }
        }
    }

    private var pct: Double { window?.pct ?? 0 }

    /// Grey until it actually matters; orange only near the handoff threshold,
    /// so the one colour in the app keeps meaning "act".
    private var color: Color {
        pct >= 90 ? .red : (pct >= 70 ? Color.accentOrange : Color.secondary.opacity(0.7))
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
