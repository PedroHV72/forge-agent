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

    struct ResolvedPrefs: Codable { let prefs: [String: JSONValue]? }
}

struct ModelsView: View {
    @StateObject private var store = ModelsStore()
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionTitle("Tiers")
                Text("O tier escolhe qual modelo atende cada fase. Uma cadeia com mais de um id usa o seguinte quando o anterior falha.")
                    .font(.caption).foregroundStyle(.secondary)

                ForEach(store.tiers) { t in TierCard(row: t) }

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

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 1) {
                Text(row.tier).font(.callout).bold()
                if row.isDefault {
                    Text("padrão").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .frame(width: 78, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    ForEach(Array(row.chain.enumerated()), id: \.offset) { idx, id in
                        if idx > 0 {
                            Image(systemName: "arrow.right")
                                .font(.system(size: 8)).foregroundStyle(.tertiary)
                        }
                        Text(ModelCatalog.label(for: id))
                            .font(.caption)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                            .help(id)
                    }
                }
                if !row.purpose.isEmpty {
                    Text(row.purpose).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 11))
    }
}
