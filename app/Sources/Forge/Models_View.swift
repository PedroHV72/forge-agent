// Models_View — which model answers for what, and which engines are reachable.
//
// Forge routes by tier (light/standard/heavy/max), optionally overridden per
// domain by `routing`, and can send the review challenge to an external engine
// (codex, gemini). That decision is spread across preferences, a shell binary
// being on PATH, and an account having a token — so it is easy to configure
// something that silently never runs.
//
// This screen answers one question: if a unit dispatched right now, what would
// actually handle it.

import SwiftUI
import ForgeKit

@MainActor
final class ModelsStore: ObservableObject {
    @Published private(set) var tiers: [TierRow] = []
    @Published private(set) var routingRows: [RoutingRow] = []
    @Published private(set) var challenger: String = "claude"
    @Published private(set) var advocate: String = "claude"
    @Published private(set) var engines: [EngineStatus] = []
    @Published private(set) var loading = false
    @Published private(set) var prefsFile: String?
    @Published var saveError: String?

    struct TierRow: Identifiable, Hashable {
        let tier: String
        let chain: [String]
        let isDefault: Bool
        var id: String { tier }

        /// What each tier is for, in the words the dispatch table uses.
        var purpose: String {
            switch tier {
            case "light":    return "memory-extract, complete-slice, tasks tag: docs"
            case "standard": return "execute-task, research, discuss"
            case "heavy":    return "plan-slice, decisões de arquitetura"
            case "max":      return "plan-milestone, slices risk:high, recovery"
            default:         return ""
            }
        }
    }

    struct EngineStatus: Identifiable, Hashable {
        let name: String        // claude | codex | agy
        let binary: String
        let installed: Bool
        let inUse: Bool
        var id: String { name }
    }

    func load() {
        guard !loading else { return }
        loading = true
        defer { loading = false }

        let resolved = ForgeCore.runJSON(ResolvedPrefs.self, "forge-prefs.js", ["--resolved"])
        let prefs = resolved?.prefs
        prefsFile = resolved?.layers?.global?.files?.first
            ?? "\(FileManager.default.homeDirectoryForCurrentUser.path)/.claude/forge-agent-prefs.jsonc"

        // Defaults mirror scripts/forge-tier-chain.js DEFAULT_TIER_MODEL. Shown
        // as defaults rather than silently, so "não configurado" is visible.
        let defaults: [(String, String)] = [
            ("light", "claude-haiku-4-5-20251001"),
            ("standard", "claude-sonnet-5"),
            ("heavy", "claude-opus-5"),
            ("max", "claude-fable-5"),
        ]
        let configured = prefs?["tier_models"]
        tiers = defaults.map { tier, fallback in
            var chain = [fallback]
            var isDefault = true
            if case .object(let obj)? = configured, let v = obj[tier],
               let parsed = ModelChain.from(v) {
                chain = parsed.ids
                isDefault = false
            }
            return TierRow(tier: tier, chain: chain, isDefault: isDefault)
        }

        routingRows = RoutingReader.rows(from: prefs?["routing"])

        if case .object(let review)? = prefs?["review"] {
            challenger = review["challenger"]?.asString ?? "claude"
            advocate = review["advocate"]?.asString ?? "claude"
        } else {
            challenger = "claude"; advocate = "claude"
        }

        engines = [
            engine("claude", binary: "claude", inUse: true),
            engine("codex", binary: "codex", inUse: challenger == "codex"),
            engine("gemini", binary: "agy", inUse: challenger == "gemini"),
        ]
    }

    private func engine(_ name: String, binary: String, inUse: Bool) -> EngineStatus {
        EngineStatus(name: name, binary: binary,
                     installed: Self.onPath(binary), inUse: inUse)
    }

    private static func onPath(_ binary: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        p.arguments = [binary]
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        // A login shell would resolve more PATH entries, but `which` covers the
        // usual install locations and costs nothing.
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 }
        catch { return false }
    }

    struct ResolvedPrefs: Codable {
        let prefs: [String: JSONValue]?
        let layers: Layers?
        struct Layers: Codable {
            let global: Layer?
            struct Layer: Codable { let files: [String]? }
        }
    }

    /// Write a tier through the same line-wise JSONC edit the preferences
    /// screen uses, so comments survive and there is one implementation of the
    /// rule that a one-item chain is written as a scalar.
    func setTier(_ tier: String, chain: ModelChain) {
        guard let file = prefsFile else {
            saveError = "arquivo de preferências desconhecido"
            return
        }
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? "{\n}\n"
        let updated = PrefsEdit.upsert(text, path: ["tier_models", tier], value: chain.toValue())
        do {
            try updated.write(toFile: file, atomically: true, encoding: .utf8)
            saveError = nil
            load()
        } catch {
            saveError = error.localizedDescription
        }
    }

    /// Remove the override so the tier falls back to the engine default.
    func resetTier(_ tier: String) {
        guard let file = prefsFile else { return }
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? "{\n}\n"
        let updated = PrefsEdit.upsert(text, path: ["tier_models", tier], value: .null)
        try? updated.write(toFile: file, atomically: true, encoding: .utf8)
        load()
    }
}

struct ModelsView: View {
    @StateObject private var store = ModelsStore()
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionTitle("Tiers")
                Text("O tier escolhe qual modelo atende cada fase. Uma cadeia com mais de um id usa o seguinte quando o anterior falha. Editar aqui grava no mesmo arquivo de preferências.")
                    .font(.caption).foregroundStyle(.secondary)
                if let e = store.saveError {
                    Label(e, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }

                ForEach(store.tiers) { t in TierCard(row: t, store: store) }

                SectionTitle("Revisão")
                reviewCard

                if !store.routingRows.isEmpty {
                    SectionTitle("Roteamento por domínio")
                    Text("Sobrepõe os tiers para execute-task e plan-slice. Domínio sem regra cai no default.")
                        .font(.caption).foregroundStyle(.secondary)
                    routingCard
                }

                SectionTitle("Engines")
                enginesCard
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Modelos")
        .onAppear { store.load() }
        .toolbar {
            ToolbarItem {
                Button { store.load() } label: {
                    Label("Atualizar", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    private var reviewCard: some View {
        HStack(spacing: 20) {
            roleColumn("Challenger", value: store.challenger,
                       hint: "Procura brechas no diff")
            Divider().frame(height: 30)
            roleColumn("Advocate", value: store.advocate,
                       hint: "Defende o código contra as objeções")
            Spacer()
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func roleColumn(_ title: String, value: String, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.tertiary)
            Text(value).font(.callout).bold()
            Text(hint).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var routingCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(store.routingRows) { r in
                HStack(spacing: 8) {
                    Text(r.domain).font(.system(size: 11, design: .monospaced)).bold()
                        .frame(width: 80, alignment: .leading)
                    Text("\(r.phase) · \(r.tier)").font(.caption)
                        .foregroundStyle(.secondary).frame(width: 120, alignment: .leading)
                    Text(r.chain.map { ModelCatalog.label(for: $0) }.joined(separator: " → "))
                        .font(.caption).lineLimit(1).truncationMode(.middle)
                    Spacer()
                }
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private var enginesCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(store.engines) { e in
                HStack(spacing: 9) {
                    Image(systemName: e.installed ? "checkmark.circle.fill" : "circle.dashed")
                        .font(.caption)
                        .foregroundStyle(e.installed ? AnyShapeStyle(Color.green)
                                                     : AnyShapeStyle(.tertiary))
                    Text(e.name).font(.callout)
                    Text(e.binary).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    if e.inUse {
                        Text("em uso").font(.caption2).foregroundStyle(Color.accentOrange)
                    }
                    // The failure this catches: an engine selected in prefs whose
                    // binary is not installed falls back to Claude at review time,
                    // silently, and the configuration looks fine on paper.
                    if e.inUse && !e.installed {
                        Label("binário ausente — cai no Claude", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption2).foregroundStyle(.orange)
                    }
                }
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct TierCard: View {
    let row: ModelsStore.TierRow
    @ObservedObject var store: ModelsStore
    @State private var editing = false

    private var chain: ModelChain {
        row.chain.count == 1 ? .single(row.chain[0]) : .chain(row.chain)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.tier).font(.callout).bold()
                    Text(row.isDefault ? "padrão do engine" : "definido")
                        .font(.caption2)
                        .foregroundStyle(row.isDefault ? AnyShapeStyle(.tertiary)
                                                       : AnyShapeStyle(Color.accentOrange))
                }
                .frame(width: 96, alignment: .leading)

                VStack(alignment: .leading, spacing: 4) {
                    if editing {
                        chainEditor
                    } else {
                        chainSummary
                    }
                    if !row.purpose.isEmpty {
                        Text(row.purpose).font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { editing.toggle() }
                } label: {
                    Image(systemName: editing ? "checkmark" : "pencil")
                        .font(.caption)
                        .frame(width: 24, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help(editing ? "Concluir" : "Editar os modelos deste tier")
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(editing ? Color.accentOrange.opacity(0.4) : .clear))
    }

    private var chainSummary: some View {
        HStack(spacing: 5) {
            ForEach(Array(row.chain.enumerated()), id: \.offset) { idx, id in
                if idx > 0 {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 8)).foregroundStyle(.tertiary)
                        .help("Usado se o anterior falhar")
                }
                Text(ModelCatalog.label(for: id))
                    .font(.caption)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                    .help(id)
            }
        }
    }

    /// Same rules as the preferences editor: a chain of one collapses back to a
    /// scalar, the last entry cannot be removed, and ids stay free text so a
    /// model released tomorrow is typeable today.
    private var chainEditor: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(row.chain.enumerated()), id: \.offset) { idx, id in
                HStack(spacing: 6) {
                    if row.chain.count > 1 {
                        Text("\(idx + 1)")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary).frame(width: 12)
                    }
                    ModelField(id: id) { newID in
                        store.setTier(row.tier, chain: chain.replacing(at: idx, with: newID))
                    }
                    if row.chain.count > 1 {
                        Button {
                            store.setTier(row.tier, chain: chain.removing(at: idx))
                        } label: { Image(systemName: "minus.circle").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                    }
                }
            }
            HStack(spacing: 12) {
                Button {
                    store.setTier(row.tier, chain: chain.appending(""))
                } label: {
                    Label("Adicionar fallback", systemImage: "plus").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)

                if !row.isDefault {
                    Button {
                        store.resetTier(row.tier)
                    } label: {
                        Label("Voltar ao padrão", systemImage: "arrow.uturn.backward")
                            .font(.caption2)
                    }
                    .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
        }
    }
}
