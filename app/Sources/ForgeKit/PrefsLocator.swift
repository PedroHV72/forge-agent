// PrefsLocator — finding the Forge repo from the preferences file.
//
// Extracted because this shipped broken once: it read the legacy markdown prefs
// after the format had migrated to JSONC, and the scaffold carries a COMMENTED
// repo_path four hundred lines above the real one, so a naive scan picks the
// wrong line. Both traps are pinned by tests.
//
// Only the current format is read. The repo treats the old one as dead — a
// smoke guard fails any file that reaches for it outside a sanctioned
// allowlist — and a silent fallback would keep a stale file authoritative long
// after the migration.

import Foundation

public enum PrefsLocator {

    public static func repoPath(home: String? = nil) -> String? {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser.path
        for file in ["\(base)/.claude/forge-agent-prefs.jsonc",
                     "\(base)/.claude/forge-agent-prefs.json"] {
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            if let v = parseRepoPath(text), FileManager.default.fileExists(atPath: v) { return v }
        }
        return nil
    }

    /// Value of a top-level string pref, from the same files as `repoPath()`.
    /// Existence is NOT checked here — callers decide what a value means
    /// (`node_path` pointing at something missing must be reported, not
    /// silently skipped).
    public static func stringPref(_ key: String, home: String? = nil) -> String? {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser.path
        for file in ["\(base)/.claude/forge-agent-prefs.jsonc",
                     "\(base)/.claude/forge-agent-prefs.json"] {
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            if let v = parseString(text, key: key) { return v }
        }
        return nil
    }

    /// Returns the LAST live assignment, ignoring comments. Testable without
    /// touching the filesystem.
    public static func parseRepoPath(_ text: String) -> String? {
        parseString(text, key: "repo_path")
    }

    public static func parseString(_ text: String, key: String) -> String? {
        var found: String?
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("//") || line.hasPrefix("#") || line.hasPrefix("*") { continue }
            guard PrefsEdit.isAssignment(line, key: key) else { continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            var v = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if let comment = v.range(of: "//") { v = String(v[..<comment.lowerBound]) }
            v = v.trimmingCharacters(in: CharacterSet(charactersIn: " ,\"'"))
            if !v.isEmpty { found = v }
        }
        return found
    }
}
