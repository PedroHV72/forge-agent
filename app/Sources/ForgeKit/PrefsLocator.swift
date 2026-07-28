// PrefsLocator — finding the Forge repo from the preferences file.
//
// Extracted because this shipped broken once: it read forge-agent-prefs.md
// after prefs had migrated to .jsonc, and the scaffold carries a COMMENTED
// repo_path four hundred lines above the real one, so a naive scan picks the
// wrong line. Both traps are pinned by tests.

import Foundation

public enum PrefsLocator {

    public static func repoPath(home: String? = nil) -> String? {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser.path
        for file in ["\(base)/.claude/forge-agent-prefs.jsonc",
                     "\(base)/.claude/forge-agent-prefs.json",
                     "\(base)/.claude/forge-agent-prefs.md"] {
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            if let v = parseRepoPath(text), FileManager.default.fileExists(atPath: v) { return v }
        }
        return nil
    }

    /// Returns the LAST live assignment, ignoring comments. Testable without
    /// touching the filesystem.
    public static func parseRepoPath(_ text: String) -> String? {
        var found: String?
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("//") || line.hasPrefix("#") || line.hasPrefix("*") { continue }
            guard PrefsEdit.isAssignment(line, key: "repo_path") else { continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            var v = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if let comment = v.range(of: "//") { v = String(v[..<comment.lowerBound]) }
            v = v.trimmingCharacters(in: CharacterSet(charactersIn: " ,\"'"))
            if !v.isEmpty { found = v }
        }
        return found
    }
}
