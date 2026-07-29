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
/// the alias map. Kept as a list of suggestions rather than a closed enum: a new
/// model must be typeable the day it ships, without waiting for an app release.
public enum ModelCatalog {
    public static let known: [ModelChoice] = [
        ModelChoice(id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "light"),
        ModelChoice(id: "claude-sonnet-5", label: "Sonnet 5", tier: "standard"),
        ModelChoice(id: "claude-opus-5", label: "Opus 5", tier: "heavy"),
        ModelChoice(id: "claude-fable-5", label: "Fable 5", tier: "max"),
        ModelChoice(id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", tier: "heavy"),
    ]

    public static func label(for id: String) -> String {
        known.first { $0.id == id }?.label ?? id
    }

    public static func isKnown(_ id: String) -> Bool {
        known.contains { $0.id == id }
    }

    /// The default for a tier, so "voltar ao padrão" can be offered inline.
    public static func defaultFor(tier: String) -> String? {
        known.first { $0.tier == tier }?.id
    }
}

public struct ModelChoice: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let tier: String
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
