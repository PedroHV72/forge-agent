// Examples — a guided sandbox for seeing what the app actually does.
//
// Deliberately NOT mock data. Each example creates a REAL artefact through the
// real engine (forge-gate.js) inside a throwaway workspace, so what you see is
// what production does — the same files, the same expiry semantics, the same
// answer path. Fake data would demo the UI while proving nothing about the
// machinery underneath.
//
// Everything lands in ~/Library/Application Support/Forge/Sandbox, which is
// registered as a normal project so it appears everywhere real projects do,
// and can be removed in one click.

import SwiftUI
import AppKit

// MARK: - Sandbox

enum Sandbox {
    static var path: String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
        return base.appendingPathComponent("Forge/Sandbox").path
    }

    static var exists: Bool { FileManager.default.fileExists(atPath: "\(path)/.gsd") }

    @discardableResult
    static func ensure() -> Bool {
        do {
            try FileManager.default.createDirectory(
                atPath: "\(path)/.gsd/forge/gates", withIntermediateDirectories: true)
            // A marker so nobody mistakes this for a real project later.
            let readme = "\(path)/LEIA-ME.txt"
            if !FileManager.default.fileExists(atPath: readme) {
                try """
                Sandbox de demonstração do Forge.app

                Criado pela aba "Exemplos". Não é um projeto real — serve para
                ver as funcionalidades usando os mesmos mecanismos de produção.
                Pode apagar esta pasta a qualquer momento.
                """.write(toFile: readme, atomically: true, encoding: .utf8)
            }
            return true
        } catch {
            return false
        }
    }

    static func destroy() throws {
        try FileManager.default.removeItem(atPath: path)
    }
}

// MARK: - Example catalogue

struct Example: Identifiable {
    let id: String
    let title: String
    let what: String        // what it demonstrates
    let why: String         // why it works this way
    let action: String
    let run: @MainActor (AppState) -> Void
}

enum Examples {
    @MainActor
    static func all() -> [Example] {
        [
            Example(
                id: "gate",
                title: "Uma pergunta com duas saídas",
                what: "Cria uma pergunta real na aba Agora. Responder aqui é o que destrava um run parado.",
                why: "O Claude headless não tem AskUserQuestion — a pergunta viaja por arquivo, e é isso que o app lê.",
                action: "Criar pergunta",
                run: { s in
                    open(s, args: [
                        "--run", "DEMO", "--unit", "S02", "--origin", "security-gate",
                        "--question", "A slice 2 mexe em autenticação e o plano não trata expiração de token. Como seguir?",
                        "--context", "Detectado pelo security gate. Nenhuma task cobre refresh/expiry.",
                        "--option", "treat:Tratar agora:Adiciona uma task de expiração antes de executar",
                        "--option", "skip:Seguir assim:Mantém o plano como está",
                        "--default", "skip", "--timeout", "3600000",
                    ], toast: "Pergunta criada — veja em Agora")
                }),

            Example(
                id: "options",
                title: "Três opções e um padrão",
                what: "Uma pergunta de arbitragem, como a triagem do review dialético.",
                why: "Os botões se reorganizam conforme a largura da janela — lado a lado quando cabe, empilhados quando não.",
                action: "Criar pergunta",
                run: { s in
                    open(s, args: [
                        "--run", "DEMO", "--unit", "S03", "--origin", "review-triage",
                        "--question", "O reviewer e o advocate discordaram sobre o retry do handoff. Quem vence?",
                        "--option", "refactor:Refatorar agora:Aplica a objeção do reviewer neste slice",
                        "--option", "followup:Virar follow-up:Registra em KNOWLEDGE.md e segue",
                        "--option", "keep:Manter como está:A defesa do autor convence",
                        "--default", "followup", "--timeout", "3600000",
                    ], toast: "Pergunta criada — veja em Agora")
                }),

            Example(
                id: "timeout",
                title: "O que acontece se você não responder",
                what: "Cria uma pergunta que expira em 45 segundos. Deixe passar e veja em Histórico.",
                why: "Ignorar é um resultado real: o run segue com o padrão declarado, marcado como “por tempo”. Nada trava para sempre — nem espera por você indefinidamente.",
                action: "Criar pergunta de 45s",
                run: { s in
                    open(s, args: [
                        "--run", "DEMO", "--unit", "T07", "--origin", "demo-timeout",
                        "--question", "Esta pergunta expira em 45 segundos. Deixe passar para ver o padrão assumir.",
                        "--context", "Ao expirar, ela sai de Agora e aparece em Histórico marcada como (por tempo).",
                        "--option", "act:Eu respondi:Registra escolha humana",
                        "--option", "auto:Deixar expirar:Este é o padrão que o run assumiria",
                        "--default", "auto", "--timeout", "45000",
                    ], toast: "Criada — não responda e veja o Histórico em 45s")
                }),

            Example(
                id: "many",
                title: "Várias perguntas ao mesmo tempo",
                what: "Cria três de uma vez, para ver a fila, o contador do Dock e a ordenação por chegada.",
                why: "Com vários projetos rodando, a fila é o normal — não a exceção.",
                action: "Criar três",
                run: { s in
                    for (i, unit) in ["S01", "S04", "T12"].enumerated() {
                        open(s, args: [
                            "--run", "DEMO", "--unit", unit, "--origin", "demo-fila",
                            "--question", "Pergunta de exemplo #\(i + 1) — responda em qualquer ordem.",
                            "--option", "a:Opção A:primeira alternativa",
                            "--option", "b:Opção B:segunda alternativa",
                            "--default", "b", "--timeout", "3600000",
                        ], toast: nil)
                    }
                    s.show("3 perguntas criadas")
                }),

            Example(
                id: "notify",
                title: "Responder sem abrir o app",
                what: "Cria a pergunta depois de 6 segundos — tempo de você trocar de janela. A notificação traz as opções como botões: clique num e o run é respondido.",
                why: "É por isso que o app existe: um run autônomo pode perguntar e continuar sem você largar o que está fazendo.",
                action: "Notificar em 6s",
                run: { s in
                    guard Sandbox.ensure() else { return s.show("não consegui criar o sandbox", error: true) }
                    s.registerSandbox()
                    s.show("Troque de janela — a notificação chega em 6s")
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 6_000_000_000)
                        open(s, args: [
                            "--run", "DEMO", "--unit", "S05", "--origin", "demo-notificacao",
                            "--question", "Clique num botão desta notificação — a resposta chega no run.",
                            "--option", "sim:Pode seguir:Escolha registrada como humana",
                            "--option", "nao:Prefiro revisar:Também é escolha humana",
                            "--default", "nao", "--timeout", "600000",
                        ], toast: nil)
                    }
                }),

            Example(
                id: "terminal",
                title: "Um terminal de verdade",
                what: "Abre uma sessão no sandbox. É um shell completo, com sua conta e suas skills.",
                why: "Emulador VT real (não um visualizador de texto), então o Claude Code desenha exatamente como no Terminal.",
                action: "Abrir sessão",
                run: { s in
                    guard Sandbox.ensure() else { return s.show("não consegui criar o sandbox", error: true) }
                    s.newSession(cwd: Sandbox.path, mode: .shell, text: "", account: "")
                    s.show("Sessão aberta — veja em Terminal")
                }),
        ]
    }

    @MainActor
    private static func open(_ state: AppState, args: [String], toast: String?) {
        guard Sandbox.ensure() else {
            return state.show("não consegui criar o sandbox", error: true)
        }
        state.registerSandbox()
        // Notifications are NOT suppressed here: seeing the banner is half the
        // point of the examples. The engine's own osascript banner is skipped
        // (--no-notify) because the app posts a richer one, with the gate's
        // options as buttons, from Notifier.
        let r = ForgeCore.run("forge-gate.js",
                              ["--open", "--cwd", Sandbox.path, "--no-notify"] + args)
        if !r.ok {
            state.show(r.stderr.isEmpty ? "falha ao criar exemplo" : r.stderr, error: true)
        } else if let toast {
            state.show(toast)
        }
        state.reloadCheap()
    }
}

// MARK: - View

struct ExamplesView: View {
    @ObservedObject var state: AppState
    @State private var confirmingReset = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                intro
                NotificationStatusBar()

                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 300), spacing: 14)],
                    alignment: .leading, spacing: 14
                ) {
                    ForEach(Examples.all()) { ex in
                        ExampleCard(example: ex, state: state)
                    }
                }

                if Sandbox.exists { footer }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Exemplos")
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tudo aqui é real").font(.headline)
            Text("""
                 Cada exemplo cria um artefato de verdade pelo mesmo motor que o \
                 Forge usa em produção — não é simulação. A diferença é o lugar: \
                 tudo vai para um sandbox descartável, que você apaga num clique.
                 """)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    }

    private var footer: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Sandbox criado").font(.caption).bold()
                Text(Sandbox.path).font(.system(size: 9))
                    .foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
            }
            Spacer()
            Button("Ver pasta") { ForgeCore.reveal(Sandbox.path) }
                .controlSize(.small)
            Button("Limpar tudo", role: .destructive) { confirmingReset = true }
                .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
        .confirmationDialog("Apagar o sandbox de exemplos?",
                            isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Apagar", role: .destructive) { state.destroySandbox() }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Remove a pasta de demonstração e todas as perguntas de exemplo. Seus projetos reais não são tocados.")
        }
    }
}

struct ExampleCard: View {
    let example: Example
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(example.title).font(.callout).bold()

            Text(example.what)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 5) {
                Image(systemName: "info.circle")
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                    .padding(.top, 2)
                Text(example.why)
                    .font(.caption2).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 2)

            Button(example.action) { example.run(state) }
                .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Says out loud whether notifications will actually be delivered, and offers
/// the only fix when they will not. Without this the failure is invisible: you
/// click an example, nothing happens, and there is nothing to look at.
struct NotificationStatusBar: View {
    @ObservedObject private var notifier = Notifier.shared

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: notifier.canAlert ? "bell.badge" : "bell.slash")
                .foregroundStyle(notifier.canAlert ? Color.accentOrange : .secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("Notificações: \(notifier.statusText)").font(.caption)
                if let e = notifier.lastError {
                    Text(e).font(.caption2).foregroundStyle(.orange).lineLimit(2)
                } else if notifier.canAlert {
                    Text("As perguntas chegam com as opções como botões.")
                        .font(.caption2).foregroundStyle(.tertiary)
                } else {
                    Text("O aviso chega, mas sem botões — abra o app para responder. Botões exigem assinar o app com um Developer ID.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button("Testar agora") { notifier.testNow() }
                .controlSize(.small)
            if notifier.needsSystemSettings {
                Button("Abrir Ajustes") { notifier.openSystemSettings() }
                    .controlSize(.small)
            }
            Button {
                notifier.refreshSettings()
            } label: {
                Image(systemName: "arrow.clockwise").font(.caption2)
            }
            .buttonStyle(.plain).foregroundStyle(.tertiary)
            .help("Reverificar")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
}
