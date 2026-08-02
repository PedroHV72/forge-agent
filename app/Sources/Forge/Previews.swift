// Previews — the update UI's states, renderable without reaching them.
//
// THE LOOPS, AND WHICH ONES ACTUALLY EXIST HERE
//
// Corrected in chunk 3: this header used to promise three loops. On the machine
// this app is developed on, TWO OF THEM DO NOT EXIST — measured, not assumed.
//
//   1. Xcode canvas — sub-second, per keystroke. REQUIRES XCODE.
//      Open `app/Package.swift` in Xcode (File ▸ Open, pick the Package.swift
//      itself, not the folder), then open this file and press ⌥⌘↩ for the
//      canvas. Every state below renders side by side.
//      Unavailable when `xcode-select -p` points at
//      `/Library/Developer/CommandLineTools` — which is this machine.
//
//   2. `cd app && swift run Forge` — DOES NOT RUN.
//      It dies in `Notifier.shared`:
//      `UNUserNotificationCenter.currentNotificationCenter()` throws
//      `bundleProxyForCurrentProcess is nil`, because UserNotifications requires
//      a real bundle. The app is not wrong; running a bundleless binary is.
//
//   3. `./app/build.sh --debug --run` — ~2s warm, ~12s cold. THE REAL LOOP HERE.
//      Debug binary in a real bundle, so notifications, Info.plist keys and
//      navigation all work. Touches nothing in /Applications without
//      `--install`. Judge FORM here.
//
//   4. `./app/build.sh --run` — minutes, release, real .app.
//      `swift build -c release` plus bundle assembly and codesign. Full
//      fidelity: this is what proves the stamped version and the final form.
//      Confirm here, do not iterate here.
//
// A note that is worth what it cost to learn: a bundle that was never STAMPED
// (`ForgeGitDescribe` absent) is a legitimate state, not a bug — see
// `VersionFooter`. Loops 1 and 2 have no bundle at all, and loop 3 has one whose
// keys are the placeholders from the versioned `Info.plist`. Anything that
// displays a running version reads "unknown" or "repo only" in all three.
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

            // The long list (D30): five cards at rest, "Mostrar mais N versões"
            // below them, and the tail one click away. `installed` is deliberately
            // a version deep in the tail (`v1.30.0`), so this preview also shows
            // the pin: the card for what you are RUNNING is in the resting window
            // even though its position in the file is past the cut. Expanding it
            // must reveal no duplicate — the two `## Unreleased` headings in the
            // fixture are one card here.
            canvas(UpdatesView(
                state: previewState(),
                store: .staged(installed: "v1.30.0",
                               latest: "v3.3.0",
                               releases: previewLongReleases)))
                .previewDisplayName("Atualizações — lista longa (5 + mostrar mais)")
        }
    }
}

/// A long list, with the two things that only show up in a long list.
///
/// Nine headings, and two of them are `## Unreleased` — the collision that was
/// real in this repo's own file (line 1 and line 104). `Release.id` is the
/// version string, so those two are the same id in a `ForEach`, which SwiftUI
/// leaves undefined. `ReleaseWindow` dedupes, and this fixture is how that is
/// visible in a render rather than only in a unit test.
///
/// The order is deliberately NOT sorted (`v1.35.0` before `v1.36.0`, exactly as
/// the real file has it): the window promises file order plus the pins, never
/// "the 5 most recent", and a fixture in descending order could not tell the two
/// apart.
private let previewLongReleases: [Release] = ChangelogParser.parse("""
## Unreleased

### Added
- **Trabalho em curso.** ainda não saiu em tag nenhuma.

## v3.3.0 — atualização in-app com barra de progresso

### Added
- **Barra de progresso no app.** a saída do instalador aparece na própria seção.

## Unreleased

### Fixed
- **A segunda entrada esquecida.** mesmo id da primeira — o caso que o dedupe pega.

## v3.2.0 — SVN no sidecar

### Added
- **Sidecar em working copy SVN.** de ponta a ponta, sem tocar git.

## v3.1.1 — correções de terminal

### Fixed
- **Sessões sobrevivem à navegação.**

## v1.35.0 — antes da 1.36 no arquivo, de propósito

### Added
- **A ordem do arquivo não é a ordem das versões.**

## v1.36.0 — depois da 1.35 no arquivo

### Added
- **É por isso que a janela não promete "as mais recentes".**

## v1.30.0 — cauda histórica

### Fixed
- **Coisa antiga.**

## v1.20.0 — cauda mais antiga ainda

### Fixed
- **Coisa mais antiga.**
""")

// MARK: - Sidebar

/// The sidebar footer at the 180pt minimum column width.
///
/// 180pt is `navigationSplitViewColumnWidth(min:)` in `RootView`, and the
/// measured usable width there is 152pt after padding — the "Adicionar projeto"
/// label alone takes ~100pt of it. Anything added to this footer has to fit in
/// what is left, so previewing it at a comfortable width would hide the only
/// interesting question about it.
///
/// Since chunk 3 the footer has two rows: the button, and the version on a line
/// of its own (D26). This preview renders the REAL `RootView` footer, so it reads
/// the real `UpdateStore` — meaning the version here shows whatever this build
/// actually knows, which under an unstamped bundle is honestly "unknown". The
/// four states of the label itself are staged by parameter in
/// `SidebarVersionLabelPreviews` below.
struct SidebarRodapePreviews: PreviewProvider {
    static var previews: some View {
        RootView(state: previewState())
            .previewSidebarFooter
            .frame(width: 180)
            .padding(.vertical, 20)
            .previewDisplayName("Sidebar — rodapé a 180pt (mínimo)")
    }
}

/// The version label in the footer, in every state it has (D25/D26/R9).
///
/// All five are locked to 180pt — the `min:` of the column — because the only
/// open question about this view is whether the text fits there, and a
/// comfortable width answers a question nobody asked. The last entry is the
/// pathological case: two long describes, which is where the promise "wrap,
/// never truncate" either holds or is exposed.
///
/// Note what the second state really is: `running` = `nil` is not a contrived
/// input. It is the state of every build made before the stamping exists, and of
/// `swift run Forge` forever — no bundle, empty `infoDictionary`, every key nil.
struct SidebarVersionLabelPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            SidebarVersionLabel(running: "v3.3.0", repo: "v3.3.0",
                                updateAvailable: false, onTap: {})
                .frame(width: 180)
                .padding(.vertical, 12)
                .previewDisplayName("Rodapé — versão em dia")

            SidebarVersionLabel(running: "v3.1.4-6-g63af17e", repo: "v3.1.4-7-gabc1234",
                                updateAvailable: false, onTap: {})
                .frame(width: 180)
                .padding(.vertical, 12)
                .previewDisplayName("Rodapé — repo andou (divergente)")

            SidebarVersionLabel(running: nil, repo: "v3.1.4-7-gabc1234",
                                updateAvailable: false, onTap: {})
                .frame(width: 180)
                .padding(.vertical, 12)
                .previewDisplayName("Rodapé — build não estampado")

            SidebarVersionLabel(running: nil, repo: nil,
                                updateAvailable: false, onTap: {})
                .frame(width: 180)
                .padding(.vertical, 12)
                .previewDisplayName("Rodapé — versão desconhecida")

            SidebarVersionLabel(running: "v3.3.0", repo: "v3.3.0",
                                updateAvailable: true, onTap: {})
                .frame(width: 180)
                .padding(.vertical, 12)
                .previewDisplayName("Rodapé — update disponível (laranja com ponto)")

            // Worst case on record: a long pre-release tag on both sides, with
            // the update dot also competing for the row.
            SidebarVersionLabel(running: "v3.10.0-beta.2-128-g63af17e",
                                repo: "v3.10.0-beta.2-131-gabc1234",
                                updateAvailable: true, onTap: {})
                .frame(width: 180)
                .padding(.vertical, 12)
                .previewDisplayName("Rodapé — patológico (tem de quebrar, não truncar)")
        }
    }
}

/// The whole sidebar column, at both ends of its width range.
///
/// Two widths rather than one because the open question about the `Divider`
/// (D29) is not "is it there" — a guard proves that — but "does 1pt read as
/// hierarchy at all". That answer changes with the column width, and 180pt
/// (`min:`) and 240pt (`max:`) are the two the operator can actually get by
/// dragging. 420pt of height fits all thirteen rows plus the footer, so the
/// question is never confused with a scrolling artefact.
// MARK: - Item card

/// A fully populated item — every field the card knows how to draw.
///
/// Five paragraphs and five labels are not padding: they are the two cuts the
/// card makes (three body lines, three chips plus `+2`), and a fixture that
/// fits would hide both.
private let previewFullItem = Item(
    id: "I-20260730120000-completo",
    title: "Corrigir o parser de datas do progresso",
    status: "done",
    source: "roadmap",
    body: """
    O contador de fechados zerava em silêncio.
    A causa é `.withFractionalSeconds` ausente no formatter.
    Sem ele, `ISO8601DateFormatter` devolve nil para o que o engine escreve.
    Corrigido em ProgressDate.parse, com as três formas cobertas.
    Falta decidir se o backfill de S01 vira migração explícita.
    """,
    closed_at: "2026-07-30T12:00:00.000Z",
    labels: ["bug", "ui", "progresso", "parser", "d8"],
    priority: "p1"
)

/// The exact shape of the three items this repo actually holds today: title,
/// id, source, and nothing else.
private let previewLegacyItem = Item(
    id: "I-20260729145851-test-title",
    title: "Test title",
    status: "inbox",
    source: "manual"
)

/// The card, at the width it really gets.
///
/// 220pt is `ItemsView.columnView`'s `.frame(width:)` — the only width this
/// card is ever drawn at. Previewing it comfortably would answer a question
/// nobody has: the open one is whether seven elements fit in a backlog column
/// without turning into noise.
///
/// The third state is the one worth staring at: an item that was DROPPED with
/// a `closed_at` on disk. No closing date may appear on it (S04-b). If one
/// does, the rule leaked out of `ItemCardPresentation` and back into the view.
struct ItemCardPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            ItemCard(item: previewFullItem,
                     otherStatuses: ItemStatus.allCases,
                     onMove: { _ in }, onOpenDetail: {}, onStart: {})
                .frame(width: 220)
                .padding(16)
                .previewDisplayName("Card — completo (7 elementos, a 220pt)")

            ItemCard(item: previewLegacyItem,
                     otherStatuses: ItemStatus.allCases,
                     onMove: { _ in }, onOpenDetail: {}, onStart: {})
                .frame(width: 220)
                .padding(16)
                .previewDisplayName("Card — legado (3 elementos, o 'antes')")

            ItemCard(item: Item(id: previewFullItem.id,
                                title: previewFullItem.title,
                                status: "dropped",
                                source: previewFullItem.source,
                                body: previewFullItem.body,
                                closed_at: previewFullItem.closed_at,
                                labels: previewFullItem.labels,
                                priority: previewFullItem.priority),
                     otherStatuses: ItemStatus.allCases,
                     onMove: { _ in }, onOpenDetail: {}, onStart: {})
                .frame(width: 220)
                .padding(16)
                .previewDisplayName("Card — dropped com closed_at (data NÃO aparece)")

            // The new state for T02: `status: "done"` makes `ItemLaunch.canStart`
            // return false, so "Começar" renders disabled with the readback
            // refusal sentence in its tooltip — no separate rule staged here,
            // the card just reflects what `ItemLaunch` decided.
            ItemCard(item: Item(id: previewFullItem.id,
                                title: previewFullItem.title,
                                status: "done",
                                source: previewFullItem.source,
                                body: previewFullItem.body,
                                closed_at: previewFullItem.closed_at,
                                labels: previewFullItem.labels,
                                priority: previewFullItem.priority),
                     otherStatuses: ItemStatus.allCases,
                     onMove: { _ in }, onOpenDetail: {}, onStart: {})
                .frame(width: 220)
                .padding(16)
                .previewDisplayName("Card — done (botão Começar desabilitado)")

            ItemDetailSheet(item: previewFullItem, detail: .constant(previewFullItem))
                .previewDisplayName("Detalhe — o corpo inteiro, não o truncado")
        }
    }
}

/// The three states of `LabelFilterField` (S05/T02): empty (full board),
/// a query that matches, and a query that matches nothing (`0 cards`) —
/// `.constant(...)` for the binding since these are read-only stagings, no
/// interaction is exercised.
///
/// The counts here are staged fixtures, not derived from `ItemLabelFilter` —
/// the rule itself is proven headless in `ItemFilterTests` (S05/T01); this
/// preview only stages what the field looks like once a count arrives.
struct LabelFilterPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            LabelFilterField(query: .constant(""),
                              labels: ["bug", "ui", "progresso", "parser", "d8"],
                              visibleCount: 12)
                .padding(16)
                .previewDisplayName("Filtro — vazio (board inteiro)")

            LabelFilterField(query: .constant("bug"),
                              labels: ["bug", "ui", "progresso", "parser", "d8"],
                              visibleCount: 3)
                .padding(16)
                .previewDisplayName("Filtro — consulta que acha (contagem reduzida)")

            LabelFilterField(query: .constant("nao-existe"),
                              labels: ["bug", "ui", "progresso", "parser", "d8"],
                              visibleCount: 0)
                .padding(16)
                .previewDisplayName("Filtro — consulta que nao acha nada (0 cards)")
        }
    }
}

struct SidebarPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            RootView(state: previewState())
                .previewSidebarList
                .frame(width: 180, height: 420)
                .previewDisplayName("Sidebar — completa a 180pt")

            RootView(state: previewState())
                .previewSidebarList
                .frame(width: 240, height: 420)
                .previewDisplayName("Sidebar — completa a 240pt")
        }
    }
}

// MARK: - Progress panel (T04)

/// Fixtures for `ProgressPanel` (T02) — four states built as `ProgressSummary`
/// values in memory. No disk, no git, no shell: `ProgressWindow`,
/// `ClosedItemsCount`, `LedgerCount` and `ProgressSummary` are plain value
/// types with public memberwise-shaped inits, so a panel state is just a
/// literal here, exactly like `previewFullItem`/`previewLegacyItem` above are
/// for `ItemCard`.
///
/// The `divergence` strings below are never invented: each one is a literal
/// return value of `Divergence.sentence(closed:deliveries:commits:)`
/// (`Progress.swift:199-217`) for the counts the fixture claims, copied by
/// hand from that switch. A preview whose sentence the engine could not
/// actually produce would be showing a state the product cannot reach.

/// State 1 — the sources disagree. `closed == 0`, `deliveries > 0`,
/// `commits > 0`: matches P3 (`deliveries > 0, closed == 0`), so
/// `Divergence.sentence` returns `"entrega sem higiene de board"`. The
/// sentence is visible in this state (D3): the panel must render the
/// `Label` under the three stats.
private let previewProgressDivergent = ProgressSummary(
    window: .week,
    closedItems: ClosedItemsCount(closed: 0, missingClosedAt: 0),
    ledger: LedgerCount(count: 4, undated: 0, windowLabel: nil),
    gitCommits: 6,
    gitAdded: 214,
    gitDeleted: 38,
    divergence: "entrega sem higiene de board")

/// State 2 — proportional: all three counts are `> 0`, which is the "all
/// non-zero" branch `Divergence.sentence` falls through with `nil` (no `if`
/// in P1–P4 matches when `closed > 0 && deliveries > 0 && commits > 0`).
/// **No sentence on screen is the property being staged here** (D9/critério
/// #9) — the panel must show three stats and nothing under them, not a
/// "tudo em ordem" fallback that doesn't exist in the model.
private let previewProgressAligned = ProgressSummary(
    window: .day24h,
    closedItems: ClosedItemsCount(closed: 5, missingClosedAt: 0),
    ledger: LedgerCount(count: 5, undated: 0, windowLabel: "hoje"),
    gitCommits: 5,
    gitAdded: 180,
    gitDeleted: 42,
    divergence: nil)

/// State 3 — a coverage gap: three `done` items with no `closed_at` at all
/// (pre-S01 legacy, per `ClosedItemsCount.coverageLabel`), surfaced as
/// `"3 sem data de fechamento"` under the "itens fechados" stat rather than
/// folded silently into `closed` (D5/critério #8 — the gap the operator
/// almost never sees by accident). Counts are proportional on purpose here
/// (`closed`/`deliveries`/`commits` all `> 0`), so `divergence` is `nil` and
/// the coverage label is the only secondary text in this state — nothing
/// competes with it for attention.
private let previewProgressCoverageGap = ProgressSummary(
    window: .week,
    closedItems: ClosedItemsCount(closed: 7, missingClosedAt: 3),
    ledger: LedgerCount(count: 6, undated: 1, windowLabel: nil),
    gitCommits: 9,
    gitAdded: 340,
    gitDeleted: 95,
    divergence: nil)

/// The four `ProgressPanel` states, side by side.
///
/// The fourth — "sem projeto" — needs no `ProgressSummary` fixture at all:
/// `hasProject: false` is the state where `summary` is never even read by
/// the view (`MetricsView.swift:137-139`), so the panel renders only the
/// instruction line and zero numbers, no matter what `summary` is set to.
/// It is passed `nil` here to make that independence visible in the fixture
/// itself, not just asserted in prose.
struct ProgressPanelPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            ProgressPanel(summary: previewProgressDivergent, hasProject: true)
                .frame(width: 520)
                .padding(16)
                .previewDisplayName("Progresso — as fontes discordam (frase visível)")

            ProgressPanel(summary: previewProgressAligned, hasProject: true)
                .frame(width: 520)
                .padding(16)
                .previewDisplayName("Progresso — proporcional (SEM frase, silêncio é a propriedade)")

            ProgressPanel(summary: previewProgressCoverageGap, hasProject: true)
                .frame(width: 520)
                .padding(16)
                .previewDisplayName("Progresso — 3 itens sem data de fechamento (cobertura declarada)")

            ProgressPanel(summary: nil, hasProject: false)
                .frame(width: 520)
                .padding(16)
                .previewDisplayName("Progresso — nenhum projeto escolhido")
        }
    }
}
#endif
