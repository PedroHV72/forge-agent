// PrefsCore — the pure half of the preferences editor.
//
// Split out of the view layer so it can be tested: `upsert` is the only code in
// this app that WRITES to a file the user owns and cannot regenerate
// (~/.claude/forge-agent-prefs.jsonc). It edits JSONC line-wise instead of
// re-serialising, because that file's comments are its documentation and a
// round-trip through JSONSerialization would delete every one of them.

import Foundation

/// Minimal JSON value — the schema mixes types freely and Swift needs one box.
public enum JSONValue: Codable, Hashable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let d = try? c.decode(Double.self) { self = .number(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    public func encode(to encoder: Encoder) throws {
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

    public var display: String {
        switch self {
        case .string(let s): return s
        case .number(let d): return d == d.rounded() ? String(Int(d)) : String(d)
        case .bool(let b):   return b ? "sim" : "não"
        case .null:          return "—"
        case .array(let a):  return a.map(\.display).joined(separator: ", ")
        case .object:        return "{…}"
        }
    }

    public var asBool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var asString: String? { if case .string(let s) = self { return s }; return nil }
    public var asDouble: Double? { if case .number(let d) = self { return d }; return nil }

    /// A list of strings, when that is what this value is. Used by the list
    /// editor so array preferences are never round-tripped through a text
    /// field — doing that rewrites `["dist/**"]` as the STRING "dist/**",
    /// which every engine then misreads.
    public var asStringArray: [String]? {
        guard case .array(let items) = self else { return nil }
        let strings = items.compactMap(\.asString)
        return strings.count == items.count ? strings : nil
    }

    public var isContainer: Bool {
        switch self {
        case .array, .object: return true
        default: return false
        }
    }
}

/// How a preference should be edited. Derived from the schema rather than
/// guessed from the current value, because a list that happens to be empty is
/// still a list.
public enum PrefKind: String, Sendable {
    case toggle      // boolean
    case choice      // enum
    case number      // integer | number
    case text        // string
    case stringList  // array of strings
    case opaque      // object, or a shape the app must not rewrite

    /// `types` is the schema's `type` (possibly a union), `hasEnum` whether it
    /// constrains values, `itemsAreStrings` whether an array holds strings.
    public static func from(types: [String], hasEnum: Bool, itemsAreStrings: Bool) -> PrefKind {
        if hasEnum { return .choice }
        if types.contains("object") { return .opaque }
        if types.contains("array") {
            // A union like string|array (tier_models) stays opaque: writing it
            // as either shape could silently change meaning.
            if types.count > 1 { return .opaque }
            return itemsAreStrings ? .stringList : .opaque
        }
        if types.contains("boolean") { return .toggle }
        if types.contains("integer") || types.contains("number") { return .number }
        if types.contains("string") { return .text }
        return .opaque
    }
}

public enum PrefsEdit {

    /// Insert or replace `path` in a JSONC document, preserving comments.
    /// `.null` removes the key, falling back to the schema default.
    ///
    /// Only top-level and one-level-nested keys are handled; deeper structures
    /// are left to the file itself (the UI links to it rather than pretending).
    public static func upsert(_ source: String, path: [String], value: JSONValue) -> String {
        guard let leaf = path.last, !path.isEmpty, path.count <= 2 else { return source }
        var lines = source.components(separatedBy: "\n")
        let indent = path.count > 1 ? "    " : "  "
        let literal = encode(value)

        var searchFrom = 0
        var searchTo = lines.count

        if path.count == 2 {
            guard let parentIdx = lines.firstIndex(where: { isAssignment($0, key: path[0]) }) else {
                if case .null = value { return source }   // nothing to remove
                return insertTopLevel(lines: lines, key: path[0],
                                      raw: "{\n    \"\(leaf)\": \(literal)\n  }")
            }
            searchFrom = parentIdx
            // Scope the search to the parent block so a leaf name that also
            // exists in another section cannot be hit by mistake.
            let after = lines[(parentIdx + 1)...]
            if let closeOffset = after.firstIndex(where: {
                $0.trimmingCharacters(in: .whitespaces).hasPrefix("}")
            }) {
                searchTo = closeOffset
            }
        }

        let existing = lines[searchFrom..<searchTo].firstIndex(where: { isAssignment($0, key: leaf) })

        if case .null = value {
            if let existing { lines.remove(at: existing) }
            return lines.joined(separator: "\n")
        }

        if let existing {
            // Preserve a trailing comma and any trailing comment on the line.
            let old = lines[existing]
            let hasComma = old.trimmingCharacters(in: .whitespaces).hasSuffix(",")
            let keptIndent = old.prefix(while: { $0 == " " || $0 == "\t" })
            lines[existing] = "\(keptIndent)\"\(leaf)\": \(literal)\(hasComma ? "," : "")"
            return lines.joined(separator: "\n")
        }

        if path.count == 2 {
            lines.insert("\(indent)\"\(leaf)\": \(literal),", at: searchFrom + 1)
            return lines.joined(separator: "\n")
        }
        return insertTopLevel(lines: lines, key: leaf, raw: literal)
    }

    /// True when the line assigns `key` — and NOT when it merely mentions it.
    /// The shipped scaffold documents every knob in comments, so a naive
    /// `contains` matches the commented example hundreds of lines above the
    /// real assignment.
    public static func isAssignment(_ line: String, key: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard !t.hasPrefix("//"), !t.hasPrefix("#"), !t.hasPrefix("*") else { return false }
        guard t.hasPrefix("\"\(key)\"") || t.hasPrefix("\(key):") else { return false }
        let afterKey = t.hasPrefix("\"") ? t.dropFirst(key.count + 2) : t.dropFirst(key.count)
        return afterKey.trimmingCharacters(in: .whitespaces).hasPrefix(":")
    }

    private static func insertTopLevel(lines: [String], key: String, raw: String) -> String {
        var lines = lines
        guard let open = lines.firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix("{")
        }) else {
            return ["{", "  \"\(key)\": \(raw)", "}"].joined(separator: "\n")
        }
        lines.insert("  \"\(key)\": \(raw),", at: open + 1)
        return lines.joined(separator: "\n")
    }

    public static func encode(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return "\"\(s.replacingOccurrences(of: "\"", with: "\\\""))\""
        case .number(let d): return d == d.rounded() ? String(Int(d)) : String(d)
        case .bool(let b):   return b ? "true" : "false"
        case .null:          return "null"
        case .array(let a):  return "[" + a.map(encode).joined(separator: ", ") + "]"
        case .object(let o): return "{" + o.sorted { $0.key < $1.key }
                                            .map { "\"\($0.key)\": \(encode($0.value))" }
                                            .joined(separator: ", ") + "}"
        }
    }
}
