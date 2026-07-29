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
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(ItemBoard.columns(store.items)) { column in
                    columnView(column)
                }
                let unknown = ItemBoard.unknown(store.items)
                if !unknown.isEmpty {
                    unknownColumn(unknown)
                }
            }
            .padding(18)
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
                    ItemCard(item: item, otherStatuses: ItemStatus.allCases.filter { $0 != column.status }) {
                        store.setStatus(item.id, to: $0, project: project)
                    }
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
                    ItemCard(item: item, otherStatuses: ItemStatus.allCases) {
                        store.setStatus(item.id, to: $0, project: project)
                    }
                }
            }
        }
        .frame(width: 220, alignment: .top)
    }
}

private struct ItemCard: View {
    let item: Item
    let otherStatuses: [ItemStatus]
    let onMove: (ItemStatus) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title ?? "(sem título)").font(.system(size: 12)).lineLimit(3)
            HStack(spacing: 6) {
                Text(item.id).font(.caption2).foregroundStyle(.tertiary)
                if let s = item.source, !s.isEmpty {
                    Text(s).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .contextMenu {
            Menu("Mover para") {
                ForEach(otherStatuses, id: \.self) { s in
                    Button(s.label) { onMove(s) }
                }
            }
        }
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
