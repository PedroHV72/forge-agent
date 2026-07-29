// PrefStructured — knobs whose shape deserves a real editor, not a text box.
//
// Three of the JSON-shaped preferences carry enough structure to be edited
// safely and enough weight to be worth it:
//
//   tier_models.*            a model, or a fallback CHAIN of models
//   multi_run.dashboard_*    a set drawn from a closed list
//   routing                  domain → phase → tier → chain
//
// The rest stay read-only. That is not laziness: routing nests four levels with
// open-ended domain keys, and a half-understood editor that rewrites it is worse
// than no editor at all — the file is authoritative and hand-editable.

import Foundation

// MARK: - Models

/// Canonical ids, mirroring scripts/forge-tier-chain.js DEFAULT_TIER_MODEL and
/// the alias map, plus suggestions for the external engines.
///
/// Picking from a list is the default path because a typo here produces a model
/// id that only fails at dispatch time, deep inside a run. Free text stays
/// reachable behind "Outro…" — a model released tomorrow has to be usable today
/// without waiting for an app release.
public enum ModelCatalog {
    public static let known: [ModelChoice] = [
        ModelChoice(id: "claude-haiku-4-5-20251001", label: "Haiku 4.5",
                    tier: "light", engine: .claude),
        ModelChoice(id: "claude-sonnet-5", label: "Sonnet 5",
                    tier: "standard", engine: .claude),
        ModelChoice(id: "claude-opus-5", label: "Opus 5",
                    tier: "heavy", engine: .claude),
        ModelChoice(id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)",
                    tier: "heavy", engine: .claude),
        ModelChoice(id: "claude-fable-5", label: "Fable 5",
                    tier: "max", engine: .claude),
    ]

    /// Suggestions for the external CLIs. Codex takes ids; agy takes display
    /// LABELS that contain spaces ("Gemini 3.1 Pro (High)"), which is why the
    /// value is passed through quoted and cannot be a bare identifier.
    public static let external: [ModelEngine: [ModelChoice]] = [
        .codex: [
            ModelChoice(id: "gpt-5", label: "GPT-5", tier: "", engine: .codex),
            ModelChoice(id: "gpt-5-codex", label: "GPT-5 Codex", tier: "", engine: .codex),
            ModelChoice(id: "o3", label: "o3", tier: "", engine: .codex),
        ],
        .gemini: [
            ModelChoice(id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)",
                        tier: "", engine: .gemini),
            ModelChoice(id: "Gemini 3.1 Pro", label: "Gemini 3.1 Pro",
                        tier: "", engine: .gemini),
            ModelChoice(id: "Gemini 3.1 Flash", label: "Gemini 3.1 Flash",
                        tier: "", engine: .gemini),
        ],
    ]

    public static func suggestions(for engine: ModelEngine) -> [ModelChoice] {
        engine == .claude ? known : (external[engine] ?? [])
    }

    public static func label(for id: String) -> String {
        known.first { $0.id == id }?.label
            ?? external.values.flatMap { $0 }.first { $0.id == id }?.label
            ?? id
    }

    public static func isKnown(_ id: String) -> Bool {
        known.contains { $0.id == id } || external.values.flatMap { $0 }.contains { $0.id == id }
    }

    /// The default for a tier, so "voltar ao padrão" can be offered inline.
    public static func defaultFor(tier: String) -> String? {
        known.first { $0.tier == tier }?.id
    }

    /// Family of a raw id, for icon and colour. Substring match in the same
    /// order scripts/forge-model-alias.js uses, so the "[1m]" suffix and future
    /// dated ids are handled without special cases.
    public static func family(of id: String) -> ModelFamily {
        let l = id.lowercased()
        if l.contains("fable")  { return .fable }
        if l.contains("haiku")  { return .haiku }
        if l.contains("sonnet") { return .sonnet }
        if l.contains("opus")   { return .opus }
        if l.contains("gpt") || l.contains("o3") || l.contains("codex") { return .gpt }
        if l.contains("gemini") { return .gemini }
        return .unknown
    }
}

public enum ModelEngine: String, CaseIterable, Hashable, Sendable {
    case claude, codex, gemini

    /// The CLI that has to be on PATH for this engine to actually run.
    public var binary: String {
        switch self {
        case .claude: return "claude"
        case .codex:  return "codex"
        case .gemini: return "agy"
        }
    }

    public var label: String {
        switch self {
        case .claude: return "Claude"
        case .codex:  return "Codex (GPT)"
        case .gemini: return "Gemini (Antigravity)"
        }
    }
}

public enum ModelFamily: String, Hashable, Sendable {
    case haiku, sonnet, opus, fable, gpt, gemini, unknown

    public var icon: String {
        switch self {
        case .haiku:   return "hare"
        case .sonnet:  return "gearshape.2"
        case .opus:    return "brain"
        case .fable:   return "sparkles"
        case .gpt:     return "g.circle"
        case .gemini:  return "diamond"
        case .unknown: return "questionmark.circle"
        }
    }

    /// Names only — the view maps these to Color, keeping ForgeKit free of
    /// SwiftUI so it stays testable.
    public var colorName: String {
        switch self {
        case .haiku:   return "green"
        case .sonnet:  return "blue"
        case .opus:    return "purple"
        case .fable:   return "orange"
        case .gpt:     return "teal"
        case .gemini:  return "indigo"
        case .unknown: return "secondary"
        }
    }
}

public struct ModelChoice: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let tier: String
    public let engine: ModelEngine

    public var family: ModelFamily { ModelCatalog.family(of: id) }
}

/// A tier's value: one model, or an ordered fallback chain. Both shapes are
/// valid on disk (`"claude-opus-5"` and `["a","b"]`), and the editor must be
/// able to round-trip whichever one is there without rewriting the other.
public enum ModelChain: Equatable {
    case single(String)
    case chain([String])

    public var ids: [String] {
        switch self {
        case .single(let s): return [s]
        case .chain(let c): return c
        }
    }

    public static func from(_ value: JSONValue?) -> ModelChain? {
        guard let value else { return nil }
        if let s = value.asString { return .single(s) }
        if let arr = value.asStringArray { return .chain(arr) }
        return nil
    }

    /// Collapse back to the simplest shape that holds the data: a one-item chain
    /// is written as a scalar, matching how the file is normally authored.
    public func toValue() -> JSONValue {
        let items = ids.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if items.count == 1 { return .string(items[0]) }
        return .array(items.map { .string($0) })
    }

    public func replacing(at index: Int, with id: String) -> ModelChain {
        var list = ids
        guard index < list.count else { return self }
        list[index] = id
        return list.count == 1 ? .single(list[0]) : .chain(list)
    }

    public func appending(_ id: String) -> ModelChain { .chain(ids + [id]) }

    public func removing(at index: Int) -> ModelChain {
        var list = ids
        guard list.count > 1, index < list.count else { return self }
        list.remove(at: index)
        return list.count == 1 ? .single(list[0]) : .chain(list)
    }

    public func moved(from: Int, to: Int) -> ModelChain {
        var list = ids
        guard from != to, list.indices.contains(from), list.indices.contains(to) else { return self }
        let item = list.remove(at: from)
        list.insert(item, at: to)
        return .chain(list)
    }
}

// MARK: - Closed sets

/// Array knobs whose members come from a fixed vocabulary. A free-text list lets
/// you type a value the engine will silently ignore; a checkbox set cannot.
public enum ClosedSets {
    public static let options: [String: [String]] = [
        "dashboard_refresh_on": ["boot", "exit", "phase_change"],
    ]

    public static func options(forLeaf leaf: String) -> [String]? { options[leaf] }
}

// MARK: - Routing (read-only rendering)

/// routing nests domain → phase → tier → chain, with open domain keys. Rendering
/// it as a readable tree is worth doing; editing it in a generic UI is not —
/// there is no shape to validate against and a wrong write reroutes real work.
public struct RoutingRow: Identifiable, Hashable {
    public let domain: String
    public let phase: String
    public let tier: String
    public let chain: [String]

    public var id: String { "\(domain).\(phase).\(tier)" }

    public init(domain: String, phase: String, tier: String, chain: [String]) {
        self.domain = domain; self.phase = phase; self.tier = tier; self.chain = chain
    }
}

public enum RoutingReader {
    /// Flatten the nested object into rows. `fallback` is a scalar sibling of the
    /// tier keys and is surfaced as its own row so it is not silently dropped.
    public static func rows(from value: JSONValue?) -> [RoutingRow] {
        guard case .object(let domains)? = value else { return [] }
        var out: [RoutingRow] = []
        for (domain, phasesValue) in domains.sorted(by: { $0.key < $1.key }) {
            guard case .object(let phases) = phasesValue else { continue }
            for (phase, tiersValue) in phases.sorted(by: { $0.key < $1.key }) {
                guard case .object(let tiers) = tiersValue else { continue }
                for (tier, chainValue) in tiers.sorted(by: { $0.key < $1.key }) {
                    let chain = chainValue.asStringArray
                        ?? chainValue.asString.map { [$0] }
                        ?? []
                    guard !chain.isEmpty else { continue }
                    out.append(RoutingRow(domain: domain, phase: phase,
                                          tier: tier, chain: chain))
                }
            }
        }
        return out
    }
}
