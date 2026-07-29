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
    @Published private(set) var challengerModel: String = ""
    @Published private(set) var advocate: String = "claude"
    @Published private(set) var advocateModel: String = "claude-fable-5"
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
            challengerModel = review["challenger_model"]?.asString ?? ""
            advocate = review["advocate"]?.asString ?? "claude"
            advocateModel = review["advocate_model"]?.asString ?? "claude-fable-5"
        } else {
            challenger = "claude"; advocate = "claude"
            challengerModel = ""; advocateModel = "claude-fable-5"
        }

        engines = ModelEngine.allCases.map {
            EngineStatus(name: $0.rawValue, binary: $0.binary,
                         installed: Self.onPath($0.binary),
                         inUse: $0 == .claude || challenger == $0.rawValue)
        }
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

    /// Review settings live under the same `review` block; writing them through
    /// PrefsEdit keeps one implementation of the JSONC edit.
    func setReview(_ leaf: String, _ value: JSONValue) {
        guard let file = prefsFile else {
            saveError = "arquivo de preferências desconhecido"
            return
        }
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? "{\n}\n"
        let updated = PrefsEdit.upsert(text, path: ["review", leaf], value: value)
        do {
            try updated.write(toFile: file, atomically: true, encoding: .utf8)
            saveError = nil
            load()
        } catch { saveError = error.localizedDescription }
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

    /// The challenger engine and its model, editable here. `challenger_model`
    /// is inert when the challenger is Claude — the engine says so explicitly
    /// (review-config-inert), so the field is hidden rather than shown dead.
    private var reviewCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            roleRow(
                title: "Challenger",
                hint: "Procura brechas no diff",
                icon: "magnifyingglass.circle.fill",
                selection: store.challenger,
                options: ["claude", "codex", "gemini", "auto"],
                onSelect: { store.setReview("challenger", .string($0)) })

            if store.challenger != "claude" && store.challenger != "auto" {
                HStack(spacing: 8) {
                    Text("modelo").font(.caption2).foregroundStyle(.tertiary)
                        .frame(width: 82, alignment: .leading)
                    ModelField(id: store.challengerModel,
                               engine: engineFor(store.challenger)) { newID in
                        store.setReview("challenger_model", .string(newID))
                    }
                    if store.challengerModel.isEmpty {
                        Text("default do CLI").font(.caption2).foregroundStyle(.tertiary)
                    }
                    Spacer()
                }
                if let missing = missingBinary(for: store.challenger) {
                    Label("\(missing) não está no PATH — a review cai no Claude",
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }

            Divider()

            roleRow(
                title: "Advocate",
                hint: "Defende o código contra as objeções",
                icon: "shield.lefthalf.filled",
                selection: store.advocate,
                options: ["claude", "auto"],
                onSelect: { store.setReview("advocate", .string($0)) })

            HStack(spacing: 8) {
                Text("modelo").font(.caption2).foregroundStyle(.tertiary)
                    .frame(width: 82, alignment: .leading)
                ModelField(id: store.advocateModel, engine: .claude) { newID in
                    store.setReview("advocate_model", .string(newID))
                }
                Spacer()
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func roleRow(title: String, hint: String, icon: String,
                         selection: String, options: [String],
                         onSelect: @escaping (String) -> Void) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 16)).foregroundStyle(Color.accentOrange.opacity(0.85))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout).bold()
                Text(hint).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Picker("", selection: Binding(
                get: { selection },
                set: { onSelect($0) })) {
                ForEach(options, id: \.self) { opt in
                    Text(engineLabel(opt)).tag(opt)
                }
            }
            .labelsHidden().frame(width: 150)
        }
    }

    private func engineLabel(_ raw: String) -> String {
        switch raw {
        case "auto":   return "auto (por autoria)"
        case "claude": return "Claude"
        case "codex":  return "Codex (GPT)"
        case "gemini": return "Gemini"
        default:       return raw
        }
    }

    private func engineFor(_ raw: String) -> ModelEngine {
        ModelEngine(rawValue: raw) ?? .claude
    }

    /// The binary a selected engine needs, when it is not installed. This is the
    /// failure that looks fine in the prefs file while every review silently
    /// falls back to Claude.
    private func missingBinary(for raw: String) -> String? {
        guard let e = ModelEngine(rawValue: raw) else { return nil }
        let status = store.engines.first { $0.name == e.rawValue }
        return (status?.installed ?? true) ? nil : e.binary
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
        VStack(spacing: 9) {
            ForEach(store.engines) { e in
                let engine = ModelEngine(rawValue: e.name) ?? .claude
                let fam: ModelFamily = engine == .codex ? .gpt
                    : (engine == .gemini ? .gemini : .opus)
                HStack(spacing: 11) {
                    ZStack {
                        Circle().fill(fam.color.opacity(e.installed ? 0.16 : 0.06))
                            .frame(width: 30, height: 30)
                        Image(systemName: fam.icon)
                            .font(.system(size: 13))
                            .foregroundStyle(e.installed ? AnyShapeStyle(fam.color)
                                                         : AnyShapeStyle(.tertiary))
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(engine.label).font(.callout)
                        Text(e.binary).font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    if e.inUse {
                        Text("em uso").font(.caption2)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Color.accentOrange.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                    }
                    Image(systemName: e.installed ? "checkmark.circle.fill" : "circle.dashed")
                        .font(.caption)
                        .foregroundStyle(e.installed ? AnyShapeStyle(Color.green)
                                                     : AnyShapeStyle(.tertiary))
                        .help(e.installed ? "Instalado" : "Binário não encontrado no PATH")
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
