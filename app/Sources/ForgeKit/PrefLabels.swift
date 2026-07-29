// PrefLabels — turning machine names into something a human reads.
//
// The schema is written for the engines: `ask_in_auto`, `adaptive_flags_lines`,
// `gate_timeout_ms: 1800000`. Those are the right names on disk and in the docs,
// so they are never replaced — they are shown as a secondary line under a
// readable title. Hiding them would make the UI and the file two vocabularies
// for the same thing, and you edit that file by hand too.
//
// Groups are curated because there are only 25 and the payoff is high. Leaf
// names fall back to mechanical humanisation, which is good enough for a
// subtitle and never goes stale when the schema grows.

import Foundation

public struct GroupLabel: Sendable {
    public let title: String
    public let icon: String
    public let blurb: String

    public init(_ title: String, _ icon: String, _ blurb: String) {
        self.title = title
        self.icon = icon
        self.blurb = blurb
    }
}

public enum PrefLabels {

    public static let groups: [String: GroupLabel] = [
        "geral": GroupLabel("Geral", "gearshape",
            "Fluxo básico: o que pular, como commitar, o que limpar ao fechar."),
        "effort": GroupLabel("Esforço", "dial.medium",
            "Quanto o modelo pensa em cada fase. Sobe a qualidade e o custo junto."),
        "thinking": GroupLabel("Raciocínio", "brain",
            "Extended thinking por fase. Alguns modelos recusam desligar em esforço alto."),
        "ids": GroupLabel("Identificadores", "number",
            "Formato dos IDs de milestone e task: timestamp (sem colisão) ou sequencial."),
        "forge_isolation": GroupLabel("Isolamento", "arrow.triangle.branch",
            "Onde o código roda: no repo, num branch ou numa worktree separada."),
        "multi_run": GroupLabel("Runs simultâneos", "square.stack.3d.up",
            "Vários orquestradores no mesmo projeto, e quando um run é dado como parado."),
        "parallelism": GroupLabel("Paralelismo", "arrow.triangle.pull",
            "Quantas unidades podem correr ao mesmo tempo."),
        "retry": GroupLabel("Retentativas", "arrow.clockwise",
            "O que fazer quando um agente falha: quantas vezes e com que espera."),
        "tier_models": GroupLabel("Modelos por tier", "cpu",
            "Qual modelo atende cada tier. Mudar aqui reroteia tudo, sem tocar em código."),
        "workers": GroupLabel("Agentes", "person.3",
            "Quais agentes existem e como são despachados."),
        "sidecars": GroupLabel("Sidecars", "shippingbox",
            "Processos auxiliares que acompanham a execução."),
        "verification": GroupLabel("Verificação", "checkmark.seal",
            "Comandos que provam que o trabalho funciona, e quanto podem demorar."),
        "evidence": GroupLabel("Evidências", "doc.text.magnifyingglass",
            "Registro do que cada ferramenta fez durante a unidade."),
        "file_audit": GroupLabel("Auditoria de arquivos", "folder.badge.questionmark",
            "Compara o que foi alterado com o que o plano previa."),
        "memory": GroupLabel("Memória", "brain.head.profile",
            "Conhecimento extraído do trabalho concluído."),
        "checker_memory": GroupLabel("Memória do checker", "checkmark.rectangle.stack",
            "O que o plan-checker aprendeu com planos anteriores."),
        "plan_check": GroupLabel("Checagem de plano", "list.bullet.clipboard",
            "Pontua o plano em 10 dimensões antes de executar."),
        "review": GroupLabel("Revisão de código", "person.2.badge.gearshape",
            "O confronto entre challenger e advocate, e o que sobe para você decidir."),
        "plan_gate": GroupLabel("Aprovação do plano", "hand.raised",
            "Conduz a lapidação do plano com você antes da primeira task."),
        "token_budget": GroupLabel("Orçamento de tokens", "gauge.medium",
            "Tetos de consumo por unidade e por milestone."),
        "verifier": GroupLabel("Verificador", "magnifyingglass",
            "Audita se os artefatos declarados existem, têm conteúdo e estão ligados."),
        "symbol_check": GroupLabel("Checagem de símbolos", "curlybraces",
            "Confere se o que o plano cita realmente existe no código."),
        "context_monitor": GroupLabel("Monitor de contexto", "chart.bar",
            "Avisa quando a janela de contexto está apertando."),
        "repair": GroupLabel("Reparo", "wrench.and.screwdriver",
            "Correção automática quando algo sai inconsistente."),
        "scope_reduction": GroupLabel("Redução de escopo", "scissors",
            "Corta escopo automaticamente quando a unidade não cabe."),
        "accounts": GroupLabel("Contas", "person.crop.circle",
            "Troca de conta quando a janela de uso esgota."),
    ]

    public static func group(_ key: String) -> GroupLabel {
        groups[key] ?? GroupLabel(humanise(key), "slider.horizontal.3", "")
    }

    /// snake_case → "Snake case". Deliberately mechanical: it can never drift
    /// from a schema that keeps growing, and it only has to be good enough for
    /// a title sitting directly above the exact machine name.
    public static func humanise(_ key: String) -> String {
        let words = key.split(whereSeparator: { $0 == "_" || $0 == "-" }).map(String.init)
        guard let first = words.first else { return key }
        let rest = words.dropFirst().map { abbreviations[$0] ?? $0 }
        let head = abbreviations[first] ?? first
        return ([head.prefix(1).uppercased() + head.dropFirst()] + rest).joined(separator: " ")
    }

    /// Fragments whose expansion is not obvious from the word itself.
    private static let abbreviations: [String: String] = [
        "ms": "(ms)", "pct": "(%)", "auto": "automático", "max": "máximo",
        "min": "mínimo", "dir": "diretório", "cmd": "comando",
    ]

    // MARK: - Values

    /// Render a raw value the way a person would say it. A timeout stored as
    /// 1800000 is correct on disk and unreadable on screen.
    public static func humanValue(key: String, value: JSONValue) -> String? {
        guard let n = value.asDouble else { return nil }

        if key.hasSuffix("_ms") { return duration(ms: n) }
        if key.hasSuffix("_seconds") { return duration(ms: n * 1000) }
        if key.hasSuffix("_lines") { return "\(Int(n)) linhas" }
        if key.hasSuffix("_count") { return "\(Int(n))" }
        // Thresholds are stored either as a fraction (0.35) or a percentage (90).
        if key.hasSuffix("_threshold") {
            return n <= 1 ? "\(Int(n * 100))%" : "\(Int(n))%"
        }
        return nil
    }

    public static func duration(ms: Double) -> String {
        let s = ms / 1000
        if s < 1 { return "\(Int(ms)) ms" }
        if s < 60 { return "\(Int(s))s" }
        let m = s / 60
        if m < 60 { return m == m.rounded() ? "\(Int(m)) min" : String(format: "%.1f min", m) }
        let h = m / 60
        return h == h.rounded() ? "\(Int(h))h" : String(format: "%.1fh", h)
    }
}
