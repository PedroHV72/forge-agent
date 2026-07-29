// Metrics — what the runs actually cost and where the work went.
//
// Source is `.gsd/forge/events.jsonl`, which the orchestrator already appends
// to on every dispatch: unit, model, engine, domain and token counts. Nothing
// new is instrumented here; the data has been accumulating and nobody was
// reading it.
//
// Cost is an ESTIMATE and labelled as one. Prices are per-model and change; the
// token counts are the engine's own estimates; and the external engines are
// billed elsewhere entirely, so their spend is reported as unknown rather than
// guessed at.

import Foundation

public struct DispatchEvent: Hashable {
    public let ts: Date?
    public let unit: String          // "execute-task/T02"
    public let model: String
    public let engine: String        // claude | codex | agy
    public let domain: String?
    public let slice: String?
    public let milestone: String?
    public let inputTokens: Int
    public let outputTokens: Int

    public var totalTokens: Int { inputTokens + outputTokens }

    /// "execute-task/T02" → "execute-task". The phase is what you compare
    /// across a milestone; the id is noise in an aggregate.
    public var unitType: String {
        unit.split(separator: "/").first.map(String.init) ?? unit
    }
}

// MARK: - Pricing

public struct ModelPrice: Hashable, Sendable {
    public let inputPerMTok: Double
    public let outputPerMTok: Double

    public init(input: Double, output: Double) {
        inputPerMTok = input
        outputPerMTok = output
    }

    public func cost(input: Int, output: Int) -> Double {
        Double(input) / 1_000_000 * inputPerMTok
            + Double(output) / 1_000_000 * outputPerMTok
    }
}

public enum Pricing {
    /// Anthropic list prices per MTok. Deliberately partial: a model with no
    /// entry contributes to token totals but not to cost, which is honest —
    /// inventing a number for an unpriced engine would make the total look
    /// authoritative when it is not.
    public static let table: [ModelFamily: ModelPrice] = [
        .haiku:  ModelPrice(input: 1, output: 5),
        .sonnet: ModelPrice(input: 3, output: 15),
        .opus:   ModelPrice(input: 5, output: 25),
        .fable:  ModelPrice(input: 10, output: 50),
    ]

    public static func price(for model: String) -> ModelPrice? {
        table[ModelCatalog.family(of: model)]
    }

    public static func cost(model: String, input: Int, output: Int) -> Double? {
        price(for: model)?.cost(input: input, output: output)
    }
}

// MARK: - Aggregates

public struct MetricsBucket: Identifiable, Hashable {
    public let key: String
    public var dispatches: Int = 0
    public var inputTokens: Int = 0
    public var outputTokens: Int = 0
    public var cost: Double = 0
    /// True when at least one dispatch in this bucket had no known price.
    public var costIncomplete: Bool = false

    public var id: String { key }
    public var totalTokens: Int { inputTokens + outputTokens }

    public init(key: String) { self.key = key }
}

public struct MetricsSummary: Hashable {
    public init() {}

    public var dispatches: Int = 0
    public var inputTokens: Int = 0
    public var outputTokens: Int = 0
    public var cost: Double = 0
    public var costIncomplete: Bool = false
    public var byModel: [MetricsBucket] = []
    public var byEngine: [MetricsBucket] = []
    public var byUnit: [MetricsBucket] = []
    public var byDomain: [MetricsBucket] = []
    /// Non-dispatch events worth counting: reviews run, retries, repairs.
    public var eventCounts: [String: Int] = [:]

    public var totalTokens: Int { inputTokens + outputTokens }

    /// Output share of all tokens. Output is 5x the price of input across the
    /// table, so this ratio explains a bill better than the raw total.
    public var outputShare: Double {
        totalTokens > 0 ? Double(outputTokens) / Double(totalTokens) : 0
    }
}

public enum MetricsEngine {

    /// Parse an events.jsonl. Malformed lines are skipped rather than fatal:
    /// the file is appended to by a live process and the last line can be torn.
    public static func parse(_ contents: String) -> (dispatches: [DispatchEvent],
                                                     events: [String: Int]) {
        var dispatches: [DispatchEvent] = []
        var counts: [String: Int] = [:]
        let iso = ISO8601DateFormatter()

        for line in contents.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }

            let event = obj["event"] as? String ?? "desconhecido"
            counts[event, default: 0] += 1
            guard event == "dispatch" else { continue }

            dispatches.append(DispatchEvent(
                ts: (obj["ts"] as? String).flatMap { iso.date(from: $0) },
                unit: obj["unit"] as? String ?? "—",
                model: obj["model"] as? String ?? "—",
                engine: obj["engine"] as? String ?? "claude",
                domain: obj["domain"] as? String,
                slice: obj["slice"] as? String,
                milestone: obj["milestone"] as? String,
                inputTokens: obj["input_tokens"] as? Int ?? 0,
                outputTokens: obj["output_tokens"] as? Int ?? 0))
        }
        return (dispatches, counts)
    }

    public static func summarise(_ dispatches: [DispatchEvent],
                                 events: [String: Int] = [:],
                                 since: Date? = nil) -> MetricsSummary {
        var s = MetricsSummary()
        s.eventCounts = events

        var models: [String: MetricsBucket] = [:]
        var engines: [String: MetricsBucket] = [:]
        var units: [String: MetricsBucket] = [:]
        var domains: [String: MetricsBucket] = [:]

        for d in dispatches {
            if let since, let ts = d.ts, ts < since { continue }

            let cost = Pricing.cost(model: d.model, input: d.inputTokens, output: d.outputTokens)
            let unpriced = cost == nil

            s.dispatches += 1
            s.inputTokens += d.inputTokens
            s.outputTokens += d.outputTokens
            s.cost += cost ?? 0
            if unpriced { s.costIncomplete = true }

            func add(_ dict: inout [String: MetricsBucket], _ key: String) {
                var b = dict[key] ?? MetricsBucket(key: key)
                b.dispatches += 1
                b.inputTokens += d.inputTokens
                b.outputTokens += d.outputTokens
                b.cost += cost ?? 0
                if unpriced { b.costIncomplete = true }
                dict[key] = b
            }

            add(&models, d.model)
            add(&engines, d.engine)
            add(&units, d.unitType)
            if let dom = d.domain, !dom.isEmpty { add(&domains, dom) }
        }

        // Sorted by spend, then tokens: the question is always "what is
        // costing me", and an unpriced engine still ranks by volume.
        func sorted(_ dict: [String: MetricsBucket]) -> [MetricsBucket] {
            dict.values.sorted {
                $0.cost != $1.cost ? $0.cost > $1.cost : $0.totalTokens > $1.totalTokens
            }
        }
        s.byModel = sorted(models)
        s.byEngine = sorted(engines)
        s.byUnit = sorted(units)
        s.byDomain = sorted(domains)
        return s
    }

    /// Format a token count the way people say it: 4.9k, 1.2M.
    public static func tokens(_ n: Int) -> String {
        if n < 1_000 { return "\(n)" }
        if n < 1_000_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return String(format: "%.2fM", Double(n) / 1_000_000)
    }

    public static func money(_ v: Double) -> String {
        v < 0.01 && v > 0 ? "<$0,01" : String(format: "$%.2f", v)
    }
}
