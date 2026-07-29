// WorkspaceDefaults — the entire workspace-preselection rule, in one pure,
// tested place.
//
// Commit b992edf deliberately removed the implicit `workspaces.first`
// fallback from the composer, because a wrong-repo dispatch looked exactly
// like a right one — there was no way to tell "the operator chose this" from
// "nothing was chosen and we guessed". This type makes that removal
// permanent and legible: when neither a configured default nor a valid
// last-used project resolves, `preselect` returns nil, even when `known` is
// non-empty. `known.first` is never consulted, anywhere in this file. A
// future reader must not "fix" that — the absence of a fallback is the
// feature.

import Foundation

public struct Preselection: Equatable {
    public enum Reason: String, Equatable {
        case pref
        case lastUsed
        case none
    }

    /// nil means nothing resolved: send must stay disabled, never guess.
    public let workspace: String?
    public let reason: Reason
    /// Set only when a configured default is honoured despite not being a
    /// registered project — config is never silently ignored, and never
    /// silently replaced with something the operator did not choose.
    public let warning: String?

    public init(workspace: String?, reason: Reason, warning: String?) {
        self.workspace = workspace
        self.reason = reason
        self.warning = warning
    }
}

public enum WorkspaceDefaults {

    /// Resolves which project (if any) should be preselected, in strict
    /// priority order: configured default, then a still-registered
    /// last-used project, then nothing.
    ///
    /// A configured default always wins, even if it fell out of `known` —
    /// the operator explicitly set it, so it is honoured with a warning
    /// rather than dropped. A last-used project, by contrast, was never an
    /// explicit choice for *this* resolution — if it is no longer in
    /// `known` it resolves to nil, never to a different, unrelated project
    /// (that is exactly the wrong-repo hazard b992edf removed).
    public static func preselect(
        configuredDefault: String?,
        lastUsed: String?,
        known: [String]
    ) -> Preselection {
        let configured = trimmed(configuredDefault)
        if let configured {
            let warning: String? = known.contains(configured)
                ? nil
                : "O projeto padrão configurado (\(configured)) não está entre os projetos registrados."
            return Preselection(workspace: configured, reason: .pref, warning: warning)
        }

        let last = trimmed(lastUsed)
        if let last, known.contains(last) {
            return Preselection(workspace: last, reason: .lastUsed, warning: nil)
        }

        // Neither a configured default nor a valid last-used exists.
        // `known.first` is intentionally never consulted here.
        return Preselection(workspace: nil, reason: .none, warning: nil)
    }

    /// Result of resolving the session root: the directory to actually use,
    /// plus an operator-facing warning when the configured value had to be
    /// overridden. Mirrors `Preselection`'s warning field — a misconfigured
    /// default must be visible, not silently dropped.
    public struct SessionRootResolution: Equatable {
        public let path: String
        public let warning: String?

        public init(path: String, warning: String?) {
            self.path = path
            self.warning = warning
        }
    }

    /// The directory to use for project-less sessions (`shell`/`chat`),
    /// which carry no project semantics and so are the only sanctioned
    /// non-project cwd.
    ///
    /// A configured value that expands to a path which is not an existing
    /// directory (mistyped, deleted, moved) is never handed to the terminal
    /// host silently: `TerminalHost`'s chdir failure is ignored, so the
    /// session would open somewhere the "abre em …" caption does not
    /// describe. Falling back to `home` here, with a warning the caller can
    /// surface, keeps that caption honest.
    ///
    /// `isDirectory` is injected (defaulting to a real filesystem check) so
    /// this stays testable without touching disk.
    public static func sessionRoot(
        configured: String?,
        home: String,
        isDirectory: (String) -> Bool = defaultIsDirectory
    ) -> SessionRootResolution {
        guard let configured = trimmed(configured) else {
            return SessionRootResolution(path: home, warning: nil)
        }
        let expanded: String
        if configured == "~" {
            expanded = home
        } else if configured.hasPrefix("~/") {
            expanded = home + "/" + configured.dropFirst(2)
        } else {
            expanded = configured
        }

        if isDirectory(expanded) {
            return SessionRootResolution(path: expanded, warning: nil)
        }
        return SessionRootResolution(
            path: home,
            warning: "O diretório configurado para sessões (\(expanded)) não existe — usando \(home).")
    }

    public static func defaultIsDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
        return exists && isDir.boolValue
    }

    private static func trimmed(_ s: String?) -> String? {
        guard let s else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
