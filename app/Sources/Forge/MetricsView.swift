// MetricsView — what the runs cost and where the work went.
//
// Reads .gsd/forge/events.jsonl, which the orchestrator has been appending to
// on every dispatch since M002. Nothing new is instrumented; the numbers were
// already on disk.

import SwiftUI
import ForgeKit

@MainActor
final class MetricsStore: ObservableObject {
    @Published private(set) var summary = MetricsSummary()
    @Published private(set) var loading = false
    @Published private(set) var scope: String = "todos"
    @Published var window: Window = .week

    enum Window: String, CaseIterable, Identifiable {
        case day = "24h"
        case week = "7 dias"
        case month = "30 dias"
        case all = "tudo"
        var id: String { rawValue }

        var since: Date? {
            switch self {
            case .day:   return Date().addingTimeInterval(-86_400)
            case .week:  return Date().addingTimeInterval(-7 * 86_400)
            case .month: return Date().addingTimeInterval(-30 * 86_400)
            case .all:   return nil
            }
        }
    }

    func load(workspaces: [String], only: String? = nil) {
        guard !loading else { return }
        loading = true
        let targets = only.map { [$0] } ?? workspaces
        scope = only.map { ProjectOrganiser.name($0) } ?? "todos os projetos"
        let since = window.since

        Task.detached(priority: .utility) {
            var all: [DispatchEvent] = []
            var counts: [String: Int] = [:]
            for ws in targets {
                let path = "\(ws)/.gsd/forge/events.jsonl"
                guard let text = try? String(contentsOfFile: path, encoding: .utf8)
                else { continue }
                let (d, e) = MetricsEngine.parse(text)
                all += d
                for (k, v) in e { counts[k, default: 0] += v }
            }
            let s = MetricsEngine.summarise(all, events: counts, since: since)
            await MainActor.run {
                self.summary = s
                self.loading = false
            }
        }
    }
}

struct MetricsView: View {
    @StateObject private var store = MetricsStore()
    @ObservedObject var state: AppState
    @State private var project: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headline
                if store.summary.dispatches == 0 {
                    empty
                } else {
                    breakdown("Por modelo", store.summary.byModel, showFamily: true)
                    breakdown("Por engine", store.summary.byEngine, showFamily: false)
                    breakdown("Por fase", store.summary.byUnit, showFamily: false)
                    if !store.summary.byDomain.isEmpty {
                        breakdown("Por domínio", store.summary.byDomain, showFamily: false)
                    }
                    activityCard
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Métricas")
        .onAppear { reload() }
        .onChange(of: store.window) { _ in reload() }
        .toolbar {
            ToolbarItem {
                Picker("", selection: $project) {
                    Text("Todos os projetos").tag("")
                    ForEach(state.workspaces, id: \.self) { ws in
                        Text(ProjectOrganiser.name(ws)).tag(ws)
                    }
                }
                .labelsHidden().frame(width: 170)
                .onChange(of: project) { _ in reload() }
            }
            ToolbarItem {
                Picker("", selection: $store.window) {
                    ForEach(MetricsStore.Window.allCases) { w in Text(w.rawValue).tag(w) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 230)
            }
        }
    }

    private func reload() {
        store.load(workspaces: state.workspaces, only: project.isEmpty ? nil : project)
    }

    // MARK: Headline

    private var headline: some View {
        let s = store.summary
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 22) {
                stat(MetricsEngine.money(s.cost), "custo estimado",
                     accent: true, caveat: s.costIncomplete)
                Divider().frame(height: 34)
                stat(MetricsEngine.tokens(s.totalTokens), "tokens")
                Divider().frame(height: 34)
                stat("\(s.dispatches)", "dispatches")
                Spacer()
                if store.loading { ProgressView().controlSize(.small) }
            }

            // Output is 5x the price of input across the table, so the split
            // explains a bill that the total alone does not.
            if s.totalTokens > 0 {
                VStack(alignment: .leading, spacing: 3) {
                    GeometryReader { geo in
                        HStack(spacing: 2) {
                            Capsule().fill(Color.secondary.opacity(0.45))
                                .frame(width: geo.size.width * (1 - s.outputShare))
                            Capsule().fill(Color.accentOrange.opacity(0.75))
                        }
                    }
                    .frame(height: 6)
                    HStack(spacing: 12) {
                        legend(Color.secondary.opacity(0.45),
                               "entrada \(MetricsEngine.tokens(s.inputTokens))")
                        legend(Color.accentOrange.opacity(0.75),
                               "saída \(MetricsEngine.tokens(s.outputTokens))")
                        Text("saída custa ~5x mais por token")
                            .font(.caption2).foregroundStyle(.tertiary)
                        Spacer()
                    }
                }
            }

            if s.costIncomplete {
                Label("Engines externos (codex, gemini) são cobrados fora da Anthropic — os tokens contam, o custo não.",
                      systemImage: "info.circle")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
    }

    private func stat(_ value: String, _ label: String,
                      accent: Bool = false, caveat: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                Text(value)
                    .font(.system(size: 22, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(accent ? Color.accentOrange : .primary)
                if caveat {
                    Text("+").font(.caption).foregroundStyle(.tertiary)
                        .help("Parcial — há dispatches sem preço conhecido")
                }
            }
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func legend(_ color: Color, _ text: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption2).foregroundStyle(.secondary)
        }
    }

    // MARK: Breakdown

    private func breakdown(_ title: String, _ buckets: [MetricsBucket],
                           showFamily: Bool) -> some View {
        let max = buckets.first?.totalTokens ?? 1
        return VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title)
            VStack(spacing: 7) {
                ForEach(buckets.prefix(8)) { b in
                    HStack(spacing: 9) {
                        if showFamily {
                            let fam = ModelCatalog.family(of: b.key)
                            Image(systemName: fam.icon)
                                .font(.caption).foregroundStyle(fam.color).frame(width: 16)
                        }
                        Text(showFamily ? ModelCatalog.label(for: b.key) : b.key)
                            .font(.caption).lineLimit(1)
                            .frame(width: 140, alignment: .leading)

                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(.quaternary).frame(height: 5)
                                Capsule().fill(barColor(b, showFamily: showFamily))
                                    .frame(width: geo.size.width
                                           * (max > 0 ? Double(b.totalTokens) / Double(max) : 0),
                                           height: 5)
                            }
                            .frame(maxHeight: .infinity, alignment: .center)
                        }
                        .frame(height: 8)

                        Text(MetricsEngine.tokens(b.totalTokens))
                            .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                            .frame(width: 52, alignment: .trailing)
                        Text(b.costIncomplete && b.cost == 0 ? "—" : MetricsEngine.money(b.cost))
                            .font(.caption2).monospacedDigit()
                            .foregroundStyle(b.cost > 0 ? AnyShapeStyle(.primary)
                                                        : AnyShapeStyle(.tertiary))
                            .frame(width: 56, alignment: .trailing)
                            .help(b.costIncomplete ? "Cobrado fora da Anthropic" : "Custo estimado")
                        Text("\(b.dispatches)×")
                            .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                            .frame(width: 34, alignment: .trailing)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func barColor(_ b: MetricsBucket, showFamily: Bool) -> Color {
        showFamily ? ModelCatalog.family(of: b.key).color : Color.accentOrange.opacity(0.6)
    }

    // MARK: Activity

    /// Non-dispatch events: how much reviewing, retrying and repairing actually
    /// happened. A high retry count is the kind of thing that never surfaces
    /// while you watch a single run.
    private var activityCard: some View {
        let interesting = ["review", "review-fix", "verify", "plan_check",
                           "retry", "repair", "symbol_check", "review-triage"]
        let rows = interesting.compactMap { k -> (String, Int)? in
            guard let v = store.summary.eventCounts[k], v > 0 else { return nil }
            return (k, v)
        }
        return Group {
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle("Atividade")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 10)],
                              alignment: .leading, spacing: 10) {
                        ForEach(rows, id: \.0) { name, count in
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(count)")
                                    .font(.system(size: 16, weight: .medium)).monospacedDigit()
                                    .foregroundStyle(name == "retry" && count > 10
                                                     ? AnyShapeStyle(Color.orange)
                                                     : AnyShapeStyle(.primary))
                                Text(name).font(.caption2).foregroundStyle(.secondary)
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary.opacity(0.25),
                                        in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Sem eventos nesta janela", systemImage: "chart.bar")
                .font(.callout)
            Text("As métricas vêm de .gsd/forge/events.jsonl, escrito a cada dispatch. Amplie o período ou rode um milestone.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
    }
}
