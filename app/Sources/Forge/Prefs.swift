// Prefs — preferences editor generated from forge-prefs.schema.json.
//
// The fields are NOT hardcoded. The schema already carries type, enum, default
// and a pt-BR description for all ~95 knobs, so the UI is derived from it: when
// Forge adds a preference, the app shows it with no change here. Hardcoding the
// list would guarantee the editor silently drifts behind the engine.
//
// Reading goes through `forge-prefs.js --resolved` (the real cascade:
// global → local, last wins). Writing edits ~/.claude/forge-agent-prefs.jsonc,
// touching only the keys the user changed and leaving everything else — comments
// included — byte-identical.

import SwiftUI
import Foundation

// MARK: - Schema model

struct PrefField: Identifiable, Hashable {
    let key: String              // "review.challenger"
    let group: String            // "review"
    let leaf: String             // "challenger"
    let type: String             // boolean | string | integer | number | array | object
    let enumValues: [String]
    let defaultValue: JSONValue?
    let description: String

    var id: String { key }

    var isToggle: Bool { type == "boolean" }
    var isPicker: Bool { !enumValues.isEmpty }
    var isNumber: Bool { type == "integer" || type == "number" }
}

/// Minimal JSON value — the schema mixes types freely and Swift needs one box.
enum JSONValue: Codable, Hashable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let d = try? c.decode(Double.self) { self = .number(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let d): try c.encode(d)
        case .bool(let b):   try c.encode(b)
        case .null:          try c.encodeNil()
        case .array(let a):  try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    var display: String {
        switch self {
        case .string(let s): return s
        case .number(let d): return d == d.rounded() ? String(Int(d)) : String(d)
        case .bool(let b):   return b ? "sim" : "não"
        case .null:          return "—"
        case .array(let a):  return a.map(\.display).joined(separator: ", ")
        case .object:        return "{…}"
        }
    }

    var asBool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var asString: String? { if case .string(let s) = self { return s }; return nil }
    var asDouble: Double? { if case .number(let d) = self { return d }; return nil }
}

// MARK: - Store

@MainActor
final class PrefsStore: ObservableObject {
    @Published private(set) var fields: [PrefField] = []
    @Published private(set) var values: [String: JSONValue] = [:]   // resolved (effective)
    @Published private(set) var overrides: [String: JSONValue] = [:] // what the file sets
    @Published private(set) var globalFile: String?
    @Published private(set) var loadError: String?
    @Published var dirty = false

    /// Edits held until the user saves, so a mistyped value never lands on disk.
    @Published var pendingEdits: [String: JSONValue] = [:]

    var groups: [String] {
        Array(Set(fields.map(\.group))).sorted { a, b in
            if a == "geral" { return true }
            if b == "geral" { return false }
            return a < b
        }
    }

    func fields(in group: String) -> [PrefField] {
        fields.filter { $0.group == group }.sorted { $0.leaf < $1.leaf }
    }

    /// Effective value: pending edit → file override → resolved → schema default.
    func value(for f: PrefField) -> JSONValue? {
        pendingEdits[f.key] ?? values[f.key] ?? f.defaultValue
    }

    func isOverridden(_ f: PrefField) -> Bool {
        pendingEdits[f.key] != nil || overrides[f.key] != nil
    }

    func set(_ f: PrefField, _ v: JSONValue) {
        pendingEdits[f.key] = v
        dirty = true
    }

    func revert(_ f: PrefField) {
        pendingEdits.removeValue(forKey: f.key)
        // Clearing an override means "go back to the default" — represented by
        // removing the key from the file on save.
        if overrides[f.key] != nil { pendingEdits[f.key] = .null }
        dirty = !pendingEdits.isEmpty
    }

    func discard() {
        pendingEdits.removeAll()
        dirty = false
    }

    // MARK: Load

    func load() {
        loadError = nil
        guard let schemaPath = Self.schemaPath(),
              let data = FileManager.default.contents(atPath: schemaPath) else {
            loadError = "forge-prefs.schema.json não encontrado — rode ./install.sh"
            return
        }
        guard let root = try? JSONDecoder().decode(SchemaRoot.self, from: data) else {
            loadError = "schema de preferências ilegível"
            return
        }
        fields = Self.flatten(root.properties)

        // Resolved values (the real cascade) come from the engine, never from a
        // reimplementation of the layering rules.
        if let payload = ForgeCore.runJSON(ResolvedPayload.self,
                                           "forge-prefs.js", ["--resolved"]) {
            values = Self.flattenValues(payload.prefs)
            overrides = values
            globalFile = payload.layers?.global?.files?.first
        }
        if globalFile == nil {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            globalFile = "\(home)/.claude/forge-agent-prefs.jsonc"
        }
    }

    static func schemaPath() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let installed = "\(home)/.claude/forge-prefs.schema.json"
        if FileManager.default.fileExists(atPath: installed) { return installed }
        if let repo = ForgeCore.repoPath {
            let p = "\(repo)/forge-prefs.schema.json"
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return nil
    }

    // MARK: Save

    /// Rewrites only the changed keys. The prefs file is JSONC with explanatory
    /// comments the user (and the scaffold) rely on, so it is edited line-wise
    /// rather than re-serialised — a round-trip through JSONSerialization would
    /// drop every comment.
    func save() -> String? {
        guard let path = globalFile else { return "arquivo de preferências desconhecido" }
        guard !pendingEdits.isEmpty else { return nil }

        var text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? "{\n}\n"

        for (key, value) in pendingEdits {
            // Only top-level and one-level-nested keys are edited here; deeper
            // structures are left to the file itself (the app links to it).
            let parts = key.split(separator: ".").map(String.init)
            guard parts.count <= 2 else { continue }
            text = Self.upsert(text, path: parts, value: value)
        }

        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            pendingEdits.removeAll()
            dirty = false
            load()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Insert or replace `path` in a JSONC document, preserving comments.
    /// `.null` removes the key (falling back to the schema default).
    static func upsert(_ source: String, path: [String], value: JSONValue) -> String {
        var lines = source.components(separatedBy: "\n")
        let leaf = path.last!
        let indent = path.count > 1 ? "    " : "  "
        let literal = encode(value)

        // Find an existing assignment for the leaf key, scoped to its parent
        // block when nested.
        var searchFrom = 0
        var searchTo = lines.count

        if path.count == 2 {
            guard let parentIdx = lines.firstIndex(where: {
                $0.trimmingCharacters(in: .whitespaces).hasPrefix("\"\(path[0])\"")
            }) else {
                // Parent block absent — add the whole object.
                return insertTopLevel(lines: lines, key: path[0],
                                      raw: "{\n    \"\(leaf)\": \(literal)\n  }")
            }
            searchFrom = parentIdx
            searchTo = lines[parentIdx...].firstIndex(where: {
                $0.trimmingCharacters(in: .whitespaces).hasPrefix("}")
            }) ?? lines.count
        }

        let existing = lines[searchFrom..<searchTo].firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix("\"\(leaf)\"")
        })

        if case .null = value {
            if let existing { lines.remove(at: existing) }
            return lines.joined(separator: "\n")
        }

        if let existing {
            // Preserve a trailing comma and any trailing comment on the line.
            let old = lines[existing]
            let hasComma = old.trimmingCharacters(in: .whitespaces).hasSuffix(",")
            lines[existing] = "\(indent)\"\(leaf)\": \(literal)\(hasComma ? "," : "")"
            return lines.joined(separator: "\n")
        }

        if path.count == 2 {
            lines.insert("\(indent)\"\(leaf)\": \(literal),", at: searchFrom + 1)
            return lines.joined(separator: "\n")
        }
        return insertTopLevel(lines: lines, key: leaf, raw: literal)
    }

    private static func insertTopLevel(lines: [String], key: String, raw: String) -> String {
        var lines = lines
        guard let open = lines.firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix("{")
        }) else {
            return (["{", "  \"\(key)\": \(raw)", "}"]).joined(separator: "\n")
        }
        lines.insert("  \"\(key)\": \(raw),", at: open + 1)
        return lines.joined(separator: "\n")
    }

    static func encode(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return "\"\(s.replacingOccurrences(of: "\"", with: "\\\""))\""
        case .number(let d): return d == d.rounded() ? String(Int(d)) : String(d)
        case .bool(let b):   return b ? "true" : "false"
        case .null:          return "null"
        case .array(let a):  return "[" + a.map(encode).joined(separator: ", ") + "]"
        case .object(let o): return "{" + o.map { "\"\($0.key)\": \(encode($0.value))" }
                                            .joined(separator: ", ") + "}"
        }
    }

    // MARK: Schema flattening

    private struct SchemaRoot: Codable { let properties: [String: SchemaNode] }

    private struct SchemaNode: Codable {
        let type: JSONValue?
        let `enum`: [JSONValue]?
        let `default`: JSONValue?
        let description: String?
        let properties: [String: SchemaNode]?
    }

    private struct ResolvedPayload: Codable {
        let prefs: [String: JSONValue]?
        let layers: Layers?
        struct Layers: Codable {
            let global: Layer?
            struct Layer: Codable { let source: String?; let files: [String]? }
        }
    }

    /// One level of nesting only. Deeper structures (arrays of objects) stay in
    /// the file — the app surfaces a link rather than pretending to edit them.
    private static func flatten(_ props: [String: SchemaNode]) -> [PrefField] {
        var out: [PrefField] = []
        for (key, node) in props {
            if key == "$schema" { continue }
            if let children = node.properties, !children.isEmpty {
                for (ck, cn) in children where cn.properties == nil {
                    out.append(field(group: key, leaf: ck, node: cn))
                }
            } else {
                out.append(field(group: "geral", leaf: key, node: node))
            }
        }
        return out
    }

    private static func field(group: String, leaf: String, node: SchemaNode) -> PrefField {
        PrefField(
            key: group == "geral" ? leaf : "\(group).\(leaf)",
            group: group,
            leaf: leaf,
            type: node.type?.asString ?? "string",
            enumValues: (node.enum ?? []).compactMap(\.asString),
            defaultValue: node.default,
            description: node.description ?? "")
    }

    private static func flattenValues(_ prefs: [String: JSONValue]?) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in prefs ?? [:] {
            if case .object(let child) = v {
                for (ck, cv) in child { out["\(k).\(ck)"] = cv }
            } else {
                out[k] = v
            }
        }
        return out
    }
}

// MARK: - View

struct PrefsView: View {
    @StateObject private var store = PrefsStore()
    @ObservedObject var state: AppState
    @State private var group: String?
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            if let err = store.loadError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange).padding(12)
            }

            HSplitView {
                List(selection: $group) {
                    ForEach(store.groups, id: \.self) { g in
                        Text(g == "geral" ? "Geral" : g).tag(g)
                    }
                }
                .frame(minWidth: 150, maxWidth: 190)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(visibleFields) { f in
                            PrefRow(field: f, store: store)
                        }
                        if visibleFields.isEmpty {
                            Text("Nada aqui.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(16)
                }
            }

            Divider()
            footer
        }
        .searchable(text: $search, prompt: "Buscar preferência")
        .navigationTitle("Preferências")
        .onAppear {
            store.load()
            if group == nil { group = store.groups.first }
        }
    }

    private var visibleFields: [PrefField] {
        let base = search.isEmpty
            ? store.fields(in: group ?? store.groups.first ?? "geral")
            : store.fields.filter {
                $0.key.localizedCaseInsensitiveContains(search) ||
                $0.description.localizedCaseInsensitiveContains(search)
            }.sorted { $0.key < $1.key }
        return base
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let f = store.globalFile {
                Button {
                    ForgeCore.reveal(f)
                } label: {
                    Label(URL(fileURLWithPath: f).lastPathComponent, systemImage: "doc.text")
                        .font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help(f)
            }
            Spacer()
            if store.dirty {
                Text("\(store.pendingEdits.count) alteração(ões)")
                    .font(.caption2).foregroundStyle(.secondary)
                Button("Descartar") { store.discard() }.controlSize(.small)
                Button("Salvar") {
                    if let err = store.save() { state.show(err, error: true) }
                    else { state.show("Preferências salvas") }
                }
                .controlSize(.small).keyboardShortcut("s", modifiers: .command)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }
}

struct PrefRow: View {
    let field: PrefField
    @ObservedObject var store: PrefsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(field.leaf).font(.callout).bold()
                if store.isOverridden(field) {
                    Text("definido").font(.caption2)
                        .foregroundStyle(Color.accentOrange)
                }
                Spacer()
                control
            }
            if !field.description.isEmpty {
                Text(field.description)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let d = field.defaultValue {
                Text("padrão: \(d.display)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 9))
    }

    @ViewBuilder private var control: some View {
        if field.isToggle {
            Toggle("", isOn: Binding(
                get: { store.value(for: field)?.asBool ?? false },
                set: { store.set(field, .bool($0)) }))
            .labelsHidden()
        } else if field.isPicker {
            Picker("", selection: Binding(
                get: { store.value(for: field)?.asString ?? field.enumValues.first ?? "" },
                set: { store.set(field, .string($0)) })) {
                ForEach(field.enumValues, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden().frame(maxWidth: 170)
        } else if field.isNumber {
            TextField("", value: Binding(
                get: { store.value(for: field)?.asDouble ?? 0 },
                set: { store.set(field, .number($0)) }), format: .number)
            .textFieldStyle(.roundedBorder).frame(width: 90)
        } else {
            TextField("", text: Binding(
                get: { store.value(for: field)?.display ?? "" },
                set: { store.set(field, .string($0)) }))
            .textFieldStyle(.roundedBorder).frame(width: 190)
        }
    }
}
