// Previews — the update UI's states, renderable without reaching them.
//
// THE THREE LOOPS, AND WHAT EACH ONE REALLY COSTS
//
//   1. Xcode canvas — sub-second, per keystroke.
//      Open `app/Package.swift` in Xcode (File ▸ Open, pick the Package.swift
//      itself, not the folder), then open this file and press ⌥⌘↩ for the
//      canvas. Every state below renders side by side. This is the loop to use
//      while deciding how something LOOKS.
//
//   2. `cd app && swift run Forge` — ~6s, the whole app, debug.
//      Real navigation, real git, real installer. Note: there is no bundle on
//      this path, so `Bundle.main.infoDictionary` is an EMPTY dictionary and
//      every Info.plist key reads `nil`. Anything that displays a bundle
//      version is legitimately unknown here — that is the build, not a bug.
//
//   3. `./app/build.sh --run` — minutes, release, real .app.
//      `swift build -c release` plus bundle assembly and codesign. The only
//      loop with full fidelity: bundle keys, icon, ad-hoc signature. Use it to
//      confirm, not to iterate.
//
// WHY `PreviewProvider` AND NOT `#Preview`
//   The `#Preview` macro is implemented by a compiler plugin (`PreviewsMacros`)
//   that ships with Xcode, not with the Command Line Tools this repo builds
//   against. Probed: `swift build` fails with "plugin for module
//   'PreviewsMacros' not found". `PreviewProvider` is a plain protocol, works in
//   the canvas just the same, and keeps `swift build` — the only authoritative
//   signal on this machine — green.
//
// Everything here is inside `#if DEBUG`, so the release build compiles none of
// it and nothing shipped depends on it.

#if DEBUG
import SwiftUI
import ForgeKit

// MARK: - Staged data

/// Sample release notes, parsed by the real `ChangelogParser`.
///
/// A fixture fed through the shipping parser rather than hand-built `Release`
/// values: `Release`'s memberwise init is internal to ForgeKit and therefore
/// unreachable from here anyway, and a preview that renders parser output is
/// showing what the app will actually show.
private let previewReleases: [Release] = ChangelogParser.parse("""
## Unreleased

### Added
- **Rodapé com a versão.** a versão em execução fica visível de qualquer tela.

## v3.3.0 — atualização in-app com barra de progresso

### Added
- **Barra de progresso no app.** o instalador roda headless e a saída aparece
  na própria seção Atualizações, sem abrir Terminal.
- **Afordance de reinstalar.** reaplica agentes, skills e scripts sem depender
  de haver release pendente.

### Fixed
- **`needsRelaunch` só depois do exit code.** o botão aparecia enquanto o build
  ainda rodava, e clicar matava o instalador.

## v3.1.4 — persistência de sessões de terminal

### Fixed
- **Sessões sobrevivem à navegação.** e a primeira mensagem não é mais
  reproduzida ao voltar.
""")

/// Plausible installer output, including the two markers `build.sh` and
/// `install.sh` actually emit: `▸` for a step and `✓` for a finished one.
private let previewLog: [String] = [
    "▸ Atualizando o repositório",
    "Already up to date.",
    "▸ Instalando agentes em ~/.claude/agents",
    "✓ 10 agentes",
    "▸ Instalando skills",
    "✓ 9 skills",
    "▸ Compilando (swift build, SwiftTerm)",
    "[42/118] Compiling Forge Views.swift",
]

@MainActor private func previewState() -> AppState { AppState(preview: ()) }

/// The canvas has no window, so the detail column has no size to inherit. 620pt
/// is the app's default window width (`ForgeApp.swift`) minus the sidebar.
private func canvas<V: View>(_ view: V) -> some View {
    NavigationStack { view }
        .frame(width: 620, height: 560)
}

// MARK: - Atualizações

/// The five states of the update screen, side by side.
///
/// These are the states the redesign changes, so this provider is the before/
/// after comparison: judge the current form here, change one thing, judge again
/// without leaving Xcode.
struct AtualizacoesPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            // Nothing to do: a version, a "you are up to date" line, and
            // Reinstalar as the only action.
            canvas(UpdatesView(
                state: previewState(),
                store: .staged(installed: "v3.3.0",
                               latest: "v3.3.0",
                               releases: previewReleases)))
                .previewDisplayName("Atualizações — em dia")

            // Update available. "Atualizar" and "Reinstalar" render TOGETHER
            // here on purpose — that coexistence was bought with a review
            // objection in the sibling task (D15 superseded), so a redesign
            // that drops one of them is a regression, not a simplification.
            canvas(UpdatesView(
                state: previewState(),
                store: .staged(installed: "v3.3.0",
                               latest: "v3.4.0",
                               releases: previewReleases)))
                .previewDisplayName("Atualizações — update disponível")

            // Installer running: spinner, phase label, and the folded log.
            canvas(UpdatesView(
                state: previewState(),
                store: .staged(installed: "v3.3.0",
                               latest: "v3.4.0",
                               releases: previewReleases,
                               updating: true,
                               phase: "compilando o app",
                               log: previewLog)))
                .previewDisplayName("Atualizações — instalação em curso")

            // Installed, but this process is still the old binary. The relaunch
            // affordance takes the whole action slot.
            canvas(UpdatesView(
                state: previewState(),
                store: .staged(installed: "v3.3.0",
                               latest: "v3.4.0",
                               releases: previewReleases,
                               updating: false,
                               phase: "concluído",
                               log: previewLog,
                               needsRelaunch: true)))
                .previewDisplayName("Atualizações — relaunch pendente")

            // Refused to start: a dirty tree or local commits ahead of origin.
            // The card explains it and hands over the command.
            canvas(UpdatesView(
                state: previewState(),
                store: .staged(
                    installed: "v3.3.0",
                    latest: "v3.4.0",
                    releases: previewReleases,
                    blockedMessage: "a árvore de trabalho do repo tem alterações não "
                        + "commitadas — a atualização faria `git pull` sobre elas.",
                    blockedCommand: "cd ~/Development/forge-agent && git status")))
                .previewDisplayName("Atualizações — bloqueado")
        }
    }
}

// MARK: - Sidebar

/// The sidebar footer at the 180pt minimum column width.
///
/// 180pt is `navigationSplitViewColumnWidth(min:)` in `RootView`, and the
/// measured usable width there is 152pt after padding — the "Adicionar projeto"
/// label alone takes ~100pt of it. Anything added to this footer has to fit in
/// what is left, so previewing it at a comfortable width would hide the only
/// interesting question about it.
struct SidebarRodapePreviews: PreviewProvider {
    static var previews: some View {
        RootView(state: previewState())
            .previewSidebarFooter
            .frame(width: 180)
            .padding(.vertical, 20)
            .previewDisplayName("Sidebar — rodapé a 180pt (mínimo)")
    }
}
#endif
