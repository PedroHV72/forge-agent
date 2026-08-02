// ItemsView — the backlog board, in the app.
//
// Same rule as everywhere else in Forge.app: the store never reimplements
// status semantics. Every read and every mutation shells out to
// scripts/forge-items.js; Swift only labels (ItemStatus.label) and groups
// (ItemBoard.columns) what the engine already decided (ROADMAP Note 5).

import SwiftUI
import ForgeKit

// MARK: - Store

@MainActor
final class ItemsStore: ObservableObject {
    @Published private(set) var items: [Item] = []
    @Published private(set) var loading = false
    @Published var error: String?

    /// Guards against out-of-order loads (R1 of the S05 dialectic review):
    /// each call to `forge-items.js` shells out and has no ordering
    /// guarantee, so a slow load for a project the user has since switched
    /// away from must not be allowed to overwrite a later, faster one.
    private var generation = LoadGeneration()

    /// Missing `.gsd/items/` is not an error — the engine already returns an
    /// empty array for a project that has never created an item, so the
    /// board shows an empty state rather than a failure banner.
    func load(project: String) {
        guard !project.isEmpty else { return }
        loading = true
        error = nil
        let gen = generation.start()
        Task.detached(priority: .utility) {
            let list = ForgeCore.runJSON([Item].self, "forge-items.js",
                                          ["--list", "--json", "--cwd", project]) ?? []
            await MainActor.run {
                guard self.generation.isCurrent(gen) else { return }
                self.items = list
                self.loading = false
            }
        }
    }

    /// `origin: human` because this item was typed by a person in the UI —
    /// `auto` origin (with its provenance requirements) is for items the
    /// engine itself creates, and the engine is who validates that split.
    func create(title: String, body: String, project: String) async -> Bool {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !project.isEmpty else { return false }

        var payload: [String: String] = ["title": t, "origin": "human"]
        let b = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if !b.isEmpty { payload["body"] = b }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return false }

        return await Task.detached(priority: .utility) { [weak self] () -> Bool in
            let r = ForgeCore.runWithInput("forge-items.js", ["--add", "--cwd", project],
                                           input: json)
            await MainActor.run {
                if !r.ok { self?.error = r.stderr.isEmpty ? "falha ao criar item" : r.stderr }
            }
            return r.ok
        }.value.also { ok in
            if ok { self.load(project: project) }
        }
    }

    /// `status` is a closed set the engine owns (`inbox → triaged → doing →
    /// done|dropped`); a rejection here is the engine's validation speaking,
    /// so it is surfaced verbatim rather than re-derived in Swift.
    func setStatus(_ id: String, to status: ItemStatus, project: String) {
        Task.detached(priority: .utility) { [weak self] in
            let r = ForgeCore.run("forge-items.js",
                                  ["--set-status", id, status.rawValue, "--cwd", project])
            await MainActor.run {
                if !r.ok { self?.error = r.stderr.isEmpty ? "falha ao mudar status" : r.stderr }
            }
            if r.ok {
                await MainActor.run { self?.load(project: project) }
            }
        }
    }
}

/// Swift has no built-in "do something with a value and return it" combinator
/// for a plain (non-Optional) type; this keeps `create(...)` a single
/// expression instead of a mutable local.
private extension Bool {
    func also(_ body: (Bool) -> Void) -> Bool { body(self); return self }
}

// MARK: - View

struct ItemsView: View {
    @ObservedObject var state: AppState
    @StateObject private var store = ItemsStore()
    @State private var project: String = ""
    @State private var adding = false
    /// The item whose detail sheet is open. `Item` is already `Identifiable`,
    /// so `.sheet(item:)` handles presentation and dismissal from this one
    /// value — no parallel `isPresented` flag to keep in sync.
    @State private var detail: Item?

    /// The label filter query (S05/T02). The rule itself lives in
    /// `ItemLabelFilter` (S05/T01) — this view only holds the text the
    /// operator typed.
    @State private var labelQuery: String = ""

    /// The single list every part of the board reads from (D-S05-2, LOCKED):
    /// both `ItemBoard.columns` and `ItemBoard.unknown` derive from this, not
    /// from `store.items` directly. Filtering after the split would let the
    /// "Desconhecido" column disagree with the CLI count — the exact
    /// divergence criterion #5 forbids.
    private var visibleItems: [Item] { ItemLabelFilter.apply(store.items, query: labelQuery) }

    var body: some View {
        Group {
            if project.isEmpty {
                noProjectSelected
            } else {
                board
            }
        }
        .navigationTitle("Itens")
        .onAppear {
            project = state.preselection.workspace ?? ""
            reload()
        }
        .toolbar {
            ToolbarItem {
                Picker("", selection: $project) {
                    Text("Selecione um projeto").tag("")
                    ForEach(state.workspaces, id: \.self) { ws in
                        Text(ProjectOrganiser.name(ws)).tag(ws)
                    }
                }
                .labelsHidden().frame(width: 190)
                .onChange(of: project) { _ in reload() }
            }
            ToolbarItem {
                Button { adding = true } label: {
                    Label("Novo item", systemImage: "plus")
                }
                .disabled(project.isEmpty)
            }
        }
        .sheet(isPresented: $adding) {
            NewItemSheet(store: store, project: project, isPresented: $adding)
        }
        .sheet(item: $detail) { item in
            ItemDetailSheet(item: item, detail: $detail)
        }
    }

    private func reload() {
        guard !project.isEmpty else { return }
        store.load(project: project)
    }

    // MARK: Empty (no project)

    /// S04 made `AppState.preselection` the single owner of "which project" —
    /// a second, silent fallback here (e.g. `workspaces.first`) would just
    /// reintroduce the ambiguity that removal fixed. Nothing chosen means
    /// nothing shown, with an explanation instead of a guess.
    private var noProjectSelected: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum projeto selecionado", systemImage: "tray.full")
                .font(.callout)
            Text("Escolha um projeto no seletor acima para ver o board de itens.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    // MARK: Board

    private var board: some View {
        VStack(alignment: .leading, spacing: 0) {
            LabelFilterField(query: $labelQuery,
                              labels: ItemLabelFilter.availableLabels(store.items),
                              visibleCount: visibleItems.count)
                .padding(.horizontal, 18)
                .padding(.top, 14)

            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(ItemBoard.columns(visibleItems)) { column in
                        columnView(column)
                    }
                    let unknown = ItemBoard.unknown(visibleItems)
                    if !unknown.isEmpty {
                        unknownColumn(unknown)
                    }
                }
                .padding(18)
            }
        }
        .overlay(alignment: .top) {
            if let e = store.error {
                Label(e, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(10).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 8)
            }
        }
    }

    private func columnView(_ column: ItemBoard.Column) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(column.status.label).font(.callout).bold()
                Text("\(column.items.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
            }
            VStack(spacing: 8) {
                ForEach(column.items) { item in
                    ItemCard(item: item,
                             otherStatuses: ItemStatus.allCases.filter { $0 != column.status },
                             onMove: { store.setStatus(item.id, to: $0, project: project) },
                             onOpenDetail: { detail = item },
                             onStart: { startWork(item) })
                }
            }
        }
        .frame(width: 220, alignment: .top)
    }

    private func unknownColumn(_ items: [Item]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Desconhecido").font(.callout).bold().foregroundStyle(.orange)
                Text("\(items.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
            }
            VStack(spacing: 8) {
                ForEach(items) { item in
                    ItemCard(item: item,
                             otherStatuses: ItemStatus.allCases,
                             onMove: { store.setStatus(item.id, to: $0, project: project) },
                             onOpenDetail: { detail = item },
                             onStart: { startWork(item) })
                }
            }
        }
        .frame(width: 220, alignment: .top)
    }

    /// The ONE place on the board that opens a tab (D9/F7, LOCKED). Moving a
    /// card never reaches here — `onMove:` goes straight to `store.setStatus`.
    /// The decision of WHETHER to launch is entirely `ItemLaunch`'s (D-S06-1):
    /// this function only executes a non-nil result, never inspects `item`
    /// itself.
    private func startWork(_ item: Item) {
        guard let req = ItemLaunch.decide(.start(item)) else { return }
        state.newSession(cwd: project, mode: .task, text: req.taskArgument, account: "")
        state.rememberWorkspace(project)
    }
}

/// The filter field above the board (S05/T02): a text query, a menu of
/// existing labels, a clear button, and the visible-card count.
///
/// `internal`, not `private` — `Previews.swift` needs to instantiate it
/// directly, the same move S04 made for `ItemCard`/`LabelChip`. It draws no
/// rule of its own: the match is `ItemLabelFilter.apply` (S05/T01), and
/// `visibleCount` is handed in already computed rather than recomputed here,
/// so there is exactly one place that counts.
struct LabelFilterField: View {
    @Binding var query: String
    /// Every label seen across the whole board (unfiltered), so the menu
    /// keeps offering the labels that would remove the current filter —
    /// deriving these from `visibleItems` instead would make them vanish the
    /// moment the operator filters.
    let labels: [String]
    let visibleCount: Int

    var body: some View {
        HStack(spacing: 8) {
            TextField("filtrar por label", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(width: 180)

            Menu("labels") {
                ForEach(labels, id: \.self) { label in
                    Button(label) { query = label }
                }
            }
            .disabled(labels.isEmpty)

            Button("limpar") { query = "" }
                .disabled(query.isEmpty)

            // The number the UAT compares against `jq` (D-S05-3, LOCKED): a
            // stable, unabbreviated string is what lets the S05/T03 guard
            // find it in the rendered tree.
            Text("\(visibleCount) cards")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)

            Spacer()
        }
    }
}

/// A card that reads like an issue: seven elements where there used to be
/// three.
///
/// Not one of those seven is decided here — including the title. What counts
/// as "no title" (missing, or whitespace-only) is decided once by
/// `ItemCardPresentation.displayTitle` in ForgeKit (S04/T01, hardened in the
/// S04 review) — this view only draws whatever that function returns. How
/// many body lines survive, how many chips are drawn, and whether a closing
/// date exists at all are answered the same way. That split is not stylistic:
/// `Forge` is not importable from a test target on this machine, so a rule
/// written here would be verifiable only by looking at a screen, and "show
/// the date when it is done" written here would also mean a raw status
/// literal in this file, which `scripts/forge-app-items.test.js` forbids
/// outright.
struct ItemCard: View {
    let item: Item
    let otherStatuses: [ItemStatus]
    let onMove: (ItemStatus) -> Void
    let onOpenDetail: () -> Void
    /// Executes what `ItemLaunch.decide(.start(item))` already decided
    /// (D-S06-1) — this view draws the affordance and forwards the tap, it
    /// never asks "should this item start?" itself.
    let onStart: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ItemCardPresentation.displayTitle(item)).font(.system(size: 12)).lineLimit(3)

            // The `lineLimit` here is defensive redundancy, not the rule: the
            // pure layer already cut the text. If the view were the only guard
            // of the number, "three lines" would silently become "whatever
            // fits".
            if let preview = ItemCardPresentation.bodyPreview(item.body) {
                Text(preview.truncated ? preview.text + "…" : preview.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(ItemCardPresentation.bodyLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Labels, priority and closing date share one row: they are all
            // short metadata. Each stays its own view — concatenating them
            // into a single string would collapse three elements into one.
            let chips = ItemCardPresentation.labelChips(item.labels)
            let priority = ItemPriority.parse(item.priority)
            let closed = ItemCardPresentation.closedDay(item)
            if chips != nil || priority != nil || closed != nil {
                HStack(spacing: 4) {
                    if let chips {
                        ForEach(chips.shown, id: \.self) { chip in
                            LabelChip(text: chip)
                        }
                        if chips.overflow > 0 {
                            LabelChip(text: "+\(chips.overflow)")
                        }
                    }
                    if let priority {
                        Text(priority.mark)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .help(priority.label)
                    }
                    if let closed {
                        Text("fechado em \(closed)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }

            HStack(spacing: 6) {
                Text(item.id).font(.caption2).foregroundStyle(.tertiary)
                if let s = item.source, !s.isEmpty {
                    Text(s).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                // `.buttonStyle(.borderless)` is NOT cosmetic (D-S06-5): the
                // card's whole surface has `.onTapGesture(perform: onOpenDetail)`
                // below, and a plain `Button` inside a container carrying its
                // own tap gesture fires BOTH handlers — clicking "Começar"
                // would also pop the detail sheet. `.disabled`/`.help` come
                // straight from the pure layer (`ItemLaunch`), never from a
                // status check written here.
                Button("Começar") { onStart() }
                    .buttonStyle(.borderless)
                    .font(.caption2)
                    .disabled(!ItemLaunch.canStart(item))
                    .help(ItemLaunch.refusal(for: item) ?? "Abre uma sessão /forge-task para este item")
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpenDetail)
        .contextMenu {
            Button("Começar") { onStart() }
                .disabled(!ItemLaunch.canStart(item))
            Button("Ver detalhe") { onOpenDetail() }
            Menu("Mover para") {
                ForEach(otherStatuses, id: \.self) { s in
                    Button(s.label) { onMove(s) }
                }
            }
        }
    }
}

/// One label pill. Also used for the `+N` overflow chip, which is why it takes
/// a plain string rather than a label.
struct LabelChip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(.quaternary, in: Capsule())
    }
}

/// The whole item, read-only.
///
/// The card truncates on purpose (D8, LOCKED: truncated card plus a detail
/// panel — in-place expansion was refused); this is where the operator gets
/// the rest. Every field is shown in full here: the entire body, every label,
/// the pt-BR words behind the status and priority marks.
///
/// Read-only by design. Every write still goes through `forge-items.js`
/// (ROADMAP Note 5), and this sheet adds no write path.
struct ItemDetailSheet: View {
    let item: Item
    @Binding var detail: Item?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(ItemCardPresentation.displayTitle(item)).font(.headline)

            HStack(spacing: 8) {
                Text(item.id).font(.caption2).foregroundStyle(.tertiary)
                if let s = item.source, !s.isEmpty {
                    Text(s).font(.caption2).foregroundStyle(.secondary)
                }
                if let status = item.parsedStatus {
                    Text(status.label).font(.caption2).foregroundStyle(.secondary)
                }
                if let p = ItemPriority.parse(item.priority) {
                    Text(p.label).font(.caption2).foregroundStyle(.secondary)
                }
                if let closed = ItemCardPresentation.closedDay(item) {
                    Text("fechado em \(closed)").font(.caption2).foregroundStyle(.tertiary)
                }
            }

            if let labels = item.labels, !labels.isEmpty {
                // All of them, not the first three: the cut belongs to the
                // card, which has 220pt; this panel does not. An unbounded
                // `HStack` inside the sheet's fixed 420pt width would just
                // squeeze every chip down to an unreadable sliver once the
                // operator piles on enough labels (S04 review R1) — a
                // horizontal scroll keeps every chip at full, legible size
                // instead of shrinking them to fit. `Layout`/`FlowLayout`
                // wrapping would read better but needs an API level above
                // this package's `.macOS(.v13)` floor; this is the option
                // that is actually available on the baseline.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(labels, id: \.self) { LabelChip(text: $0) }
                    }
                }
            }

            ScrollView {
                Text(item.body ?? "(sem corpo)")
                    .font(.system(size: 12))
                    .foregroundStyle(item.body == nil ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 220)

            HStack {
                Spacer()
                Button("Fechar") { detail = nil }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(20).frame(width: 420)
    }
}

private struct NewItemSheet: View {
    @ObservedObject var store: ItemsStore
    let project: String
    @Binding var isPresented: Bool

    @State private var title = ""
    @State private var body_ = ""
    @State private var creating = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Novo item").font(.headline)

            TextField("título", text: $title).textFieldStyle(.roundedBorder)

            TextEditor(text: $body_)
                .font(.system(size: 12))
                .frame(height: 90)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))

            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                if creating { ProgressView().controlSize(.small) }
                Button("Criar") {
                    creating = true
                    Task {
                        let ok = await store.create(title: title, body: body_, project: project)
                        creating = false
                        if ok { isPresented = false }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || creating)
            }
        }
        .padding(20).frame(width: 420)
    }
}
