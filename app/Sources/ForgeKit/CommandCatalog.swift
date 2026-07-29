// CommandCatalog — the slash commands the composer completes.
//
// Read from what is actually installed (~/.claude/skills/*/SKILL.md and
// ~/.claude/commands/*.md), not from a list baked into the app. A skill added
// tomorrow completes tomorrow, and one that was removed stops being offered —
// suggesting a command that no longer exists would be worse than suggesting
// nothing.

import Foundation

public struct SlashCommand: Identifiable, Hashable, Sendable {
    public let name: String          // "forge-auto"
    public let description: String
    public let source: Source

    public var id: String { name }
    public var slash: String { "/" + name }

    public enum Source: String, Sendable { case skill, command }

    public init(name: String, description: String, source: Source) {
        self.name = name
        self.description = description
        self.source = source
    }
}

public enum CommandCatalog {

    public static func load(home: String? = nil) -> [SlashCommand] {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser.path
        var byName: [String: SlashCommand] = [:]

        // Commands first, skills second: a skill shadows a same-named command
        // shim, which is the direction the migration went (commands/forge-auto
        // became a one-line forwarder to the skill).
        for c in commands(at: "\(base)/.claude/commands") { byName[c.name] = c }
        for s in skills(at: "\(base)/.claude/skills") { byName[s.name] = s }

        return byName.values.sorted { $0.name < $1.name }
    }

    static func commands(at dir: String) -> [SlashCommand] {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir)
        else { return [] }
        return files.filter { $0.hasSuffix(".md") }.compactMap { file in
            let name = String(file.dropLast(3))
            let text = (try? String(contentsOfFile: "\(dir)/\(file)", encoding: .utf8)) ?? ""
            return SlashCommand(name: name,
                                description: frontmatter(text, key: "description") ?? "",
                                source: .command)
        }
    }

    static func skills(at dir: String) -> [SlashCommand] {
        guard let dirs = try? FileManager.default.contentsOfDirectory(atPath: dir)
        else { return [] }
        return dirs.compactMap { sub in
            let path = "\(dir)/\(sub)/SKILL.md"
            guard let text = try? String(contentsOfFile: path, encoding: .utf8)
            else { return nil }
            return SlashCommand(name: frontmatter(text, key: "name") ?? sub,
                                description: frontmatter(text, key: "description") ?? "",
                                source: .skill)
        }
    }

    /// Minimal YAML frontmatter reader: only top-level `key: value` between the
    /// opening and closing `---`. Enough for name and description, and it never
    /// pulls a value out of the body by accident.
    public static func frontmatter(_ text: String, key: String) -> String? {
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return nil }
        for raw in lines.dropFirst() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line == "---" { break }
            guard line.hasPrefix("\(key):") else { continue }
            var v = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
            if v.hasPrefix("\"") && v.hasSuffix("\"") && v.count > 1 {
                v = String(v.dropFirst().dropLast())
            }
            return v.isEmpty ? nil : v
        }
        return nil
    }
}

// MARK: - Composer parsing

/// What the composer should be completing right now, based on the caret.
public enum CompletionContext: Equatable {
    case none
    case command(query: String, range: Range<String.Index>)
    case project(query: String, range: Range<String.Index>)

    public var query: String {
        switch self {
        case .command(let q, _), .project(let q, _): return q
        case .none: return ""
        }
    }
}

public enum ComposerParser {

    /// Find the token being typed at `caret`.
    ///
    /// A trigger only counts at the start of the text or after whitespace, so a
    /// path like `src/main` or an address does not open a menu mid-sentence.
    public static func context(in text: String, caret: String.Index) -> CompletionContext {
        var i = caret
        while i > text.startIndex {
            let prev = text.index(before: i)
            let ch = text[prev]
            if ch == " " || ch == "\n" || ch == "\t" { break }
            i = prev
            if ch == "/" || ch == "@" {
                // Trigger must open the token: start of text or preceded by space.
                let atStart = i == text.startIndex
                let afterSpace = i > text.startIndex
                    && " \n\t".contains(text[text.index(before: i)])
                guard atStart || afterSpace else { return .none }

                let queryStart = text.index(after: i)
                guard queryStart <= caret else { return .none }
                let query = String(text[queryStart..<caret])
                // A space inside the query means the token already ended.
                guard !query.contains(" ") else { return .none }
                return ch == "/" ? .command(query: query, range: i..<caret)
                                 : .project(query: query, range: i..<caret)
            }
        }
        return .none
    }

    /// Rank matches: prefix hits first, then substring, alphabetical within
    /// each. Typing "au" should put forge-auto above forge-accounts.
    public static func filter(_ commands: [SlashCommand], query: String) -> [SlashCommand] {
        guard !query.isEmpty else { return commands }
        let q = query.lowercased()
        let prefix = commands.filter { $0.name.lowercased().hasPrefix(q) }
        let contains = commands.filter {
            !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q)
        }
        return prefix + contains
    }

    public static func filterProjects(_ paths: [String], query: String) -> [String] {
        guard !query.isEmpty else { return paths }
        let q = query.lowercased()
        let name = { (p: String) in (p as NSString).lastPathComponent.lowercased() }
        return paths.filter { name($0).hasPrefix(q) } + paths.filter {
            !name($0).hasPrefix(q) && name($0).contains(q)
        }
    }

    /// Replace the token under the caret with `replacement`, returning the new
    /// text and where the caret should land (after a trailing space).
    public static func complete(_ text: String, range: Range<String.Index>,
                                with replacement: String) -> (text: String, caret: Int) {
        var out = text
        out.replaceSubrange(range, with: replacement + " ")
        let caret = text.distance(from: text.startIndex, to: range.lowerBound)
            + replacement.count + 1
        return (out, caret)
    }

    /// Pull the leading slash command out of a composed line, if any.
    /// "/forge-task corrigir X" → ("forge-task", "corrigir X")
    public static func split(_ text: String) -> (command: String?, rest: String) {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("/") else { return (nil, t) }
        let body = String(t.dropFirst())
        guard let space = body.firstIndex(of: " ") else { return (body, "") }
        return (String(body[..<space]),
                String(body[body.index(after: space)...]).trimmingCharacters(in: .whitespaces))
    }
}
