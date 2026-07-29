// NodeLocator — finding a usable `node` for the engines the app shells out to.
//
// Why this exists: the app used to probe three fixed paths
// (/opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node) and otherwise
// hand `/usr/bin/env node` to Process. That fallback is a trap. A GUI app
// launched from Finder/Launchpad inherits launchd's minimal environment
// (PATH=/usr/bin:/bin:/usr/sbin:/sbin), so `env` searches a PATH that cannot
// contain a version-managed node:
//
//     env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/env node --version
//     env: node: No such file or directory
//
// Anyone on nvm/fnm/asdf/mise/volta — i.e. most Node developers — has node
// under $HOME, installed by a shell rc file the GUI never sources. Every engine
// call in ForgeCore goes through this, so the failure was never limited to one
// screen.
//
// Resolution order (first hit wins):
//   1. operator override — FORGE_NODE_PATH, then the `node_path` pref
//   2. the three fixed paths (correct for Homebrew and system installs)
//   3. version managers, by probing directories that exist — never a
//      hardcoded version number
//   4. a scan of $PATH (free, and correct when the app was launched from a
//      terminal that had node on PATH)
//   5. asking the login shell — `$SHELL -lic 'command -v node'` — which is what
//      actually resolves a manager that installs itself via rc file. Bounded by
//      a timeout so a slow rc cannot hang the app.
//
// There is deliberately NO `/usr/bin/env node` fallback: it is precisely the
// silent failure this file replaces. When nothing resolves the caller gets a
// diagnosis naming the override, not `env: node: No such file or directory`.
//
// The resolution logic is pure — every filesystem and subprocess touch is a
// closure on `Probe` — so the tests drive a synthetic nvm tree instead of
// whatever happens to be installed on the machine running them.

import Foundation

public enum NodeLocator {

    /// Where a resolved interpreter came from. Surfaced in diagnostics so an
    /// operator can tell "your override won" from "we guessed".
    public enum Source: String {
        case envOverride        // FORGE_NODE_PATH
        case pref               // node_path in forge-agent-prefs.jsonc
        case fixed              // homebrew / /usr/local / /usr/bin
        case versionManager     // nvm, fnm, asdf, mise, volta
        case pathScan           // an entry of $PATH
        case loginShell         // $SHELL -lic 'command -v node'
    }

    public struct Resolution: Equatable {
        public let path: String
        public let source: Source
        public init(path: String, source: Source) {
            self.path = path
            self.source = source
        }
        public static func == (a: Resolution, b: Resolution) -> Bool {
            a.path == b.path && a.source == b.source
        }
    }

    public enum Outcome: Equatable {
        case found(Resolution)
        /// Human-readable list of the places that were looked at, for the error.
        case notFound(tried: [String])

        public var path: String? {
            if case .found(let r) = self { return r.path }
            return nil
        }
        public var source: Source? {
            if case .found(let r) = self { return r.source }
            return nil
        }
    }

    /// Everything the resolver is allowed to touch. Injected so the whole
    /// search can run against a fixture tree.
    public struct Probe {
        public var home: String
        public var envOverride: String?
        public var prefValue: String?
        /// Raw $PATH (colon-separated), as inherited by the process.
        public var pathVar: String
        public var isExecutable: (String) -> Bool
        public var listDir: (String) -> [String]
        public var readFile: (String) -> String?
        /// Returns an absolute node path, or nil. Expected to be bounded by a
        /// timeout by whoever supplies it.
        public var loginShell: () -> String?

        public init(home: String,
                    envOverride: String? = nil,
                    prefValue: String? = nil,
                    pathVar: String = "",
                    isExecutable: @escaping (String) -> Bool,
                    listDir: @escaping (String) -> [String] = { _ in [] },
                    readFile: @escaping (String) -> String? = { _ in nil },
                    loginShell: @escaping () -> String? = { nil }) {
            self.home = home
            self.envOverride = envOverride
            self.prefValue = prefValue
            self.pathVar = pathVar
            self.isExecutable = isExecutable
            self.listDir = listDir
            self.readFile = readFile
            self.loginShell = loginShell
        }
    }

    public static let fixedPaths = ["/opt/homebrew/bin/node",
                                    "/usr/local/bin/node",
                                    "/usr/bin/node"]

    // MARK: - Resolution

    public static func resolve(_ p: Probe) -> Outcome {
        var tried: [String] = []

        // 1. Operator override. If it is set we never guess past it — a broken
        //    override is reported, not silently routed around, or the operator
        //    would have no way to tell it was ignored.
        for (value, source, label) in [(p.envOverride, Source.envOverride, "FORGE_NODE_PATH"),
                                       (p.prefValue, Source.pref, "node_path (prefs)")] {
            guard let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { continue }
            if p.isExecutable(v) { return .found(Resolution(path: v, source: source)) }
            tried.append("\(label) = \(v) — não é um executável")
            return .notFound(tried: tried)
        }
        tried.append("FORGE_NODE_PATH e node_path (prefs): não definidos")

        // 2. Fixed installs.
        for candidate in fixedPaths where p.isExecutable(candidate) {
            return .found(Resolution(path: candidate, source: .fixed))
        }
        tried.append("caminhos fixos: \(fixedPaths.joined(separator: ", "))")

        // 3. Version managers.
        if let vm = versionManagerNode(p) {
            return .found(Resolution(path: vm, source: .versionManager))
        }
        tried.append("gerenciadores de versão em \(p.home): nvm, fnm, asdf, mise, volta")

        // 4. $PATH scan. Same answer `/usr/bin/env node` would have given, but
        //    resolved to a concrete path here so the failure case is visible
        //    instead of deferred to exec time.
        if let onPath = scanPath(p) {
            return .found(Resolution(path: onPath, source: .pathScan))
        }
        tried.append("$PATH = \(p.pathVar.isEmpty ? "(vazio)" : p.pathVar)")

        // 5. Login shell, last because it costs a subprocess.
        if let shellAnswer = p.loginShell()?.trimmingCharacters(in: .whitespacesAndNewlines),
           !shellAnswer.isEmpty, p.isExecutable(shellAnswer) {
            return .found(Resolution(path: shellAnswer, source: .loginShell))
        }
        tried.append("shell de login (command -v node)")

        return .notFound(tried: tried)
    }

    /// The message an operator sees. Mirrors ForgeCore's "say what was tried"
    /// style: a bare `env: node: No such file or directory` tells them nothing
    /// actionable.
    public static func notFoundMessage(tried: [String]) -> String {
        var s = "node não encontrado — o app precisa dele para rodar os engines do Forge.\n"
        s += "Procurei em:\n"
        for t in tried { s += "  • \(t)\n" }
        s += "Defina o caminho explicitamente: a variável de ambiente FORGE_NODE_PATH "
        s += "ou a chave \"node_path\" em ~/.claude/forge-agent-prefs.jsonc "
        s += "(ex.: \"node_path\": \"/Users/você/.nvm/versions/node/v24.11.1/bin/node\")."
        return s
    }

    // MARK: - Version managers

    /// Probes each manager's on-disk layout. Nothing here hardcodes a version:
    /// directories are listed and the highest version wins, unless the manager
    /// records an explicit default.
    static func versionManagerNode(_ p: Probe) -> String? {
        let home = p.home

        // nvm — honour ~/.nvm/alias/default when it names an installed version.
        let nvmVersions = "\(home)/.nvm/versions/node"
        if let alias = p.readFile("\(home)/.nvm/alias/default")?
            .trimmingCharacters(in: .whitespacesAndNewlines), !alias.isEmpty {
            // The alias may be exact ("v24.11.1"), a partial line ("24"), or
            // symbolic ("lts/*", "node") — only the first two are resolvable
            // from disk without running nvm.
            let dirs = p.listDir(nvmVersions)
            let wanted = alias.hasPrefix("v") ? alias : "v\(alias)"
            if let exact = dirs.first(where: { $0 == wanted }) {
                let c = "\(nvmVersions)/\(exact)/bin/node"
                if p.isExecutable(c) { return c }
            }
            // Partial ("24" → newest v24.x).
            let family = dirs.filter { $0 == wanted || $0.hasPrefix("\(wanted).") }
            if let best = highestVersion(family) {
                let c = "\(nvmVersions)/\(best)/bin/node"
                if p.isExecutable(c) { return c }
            }
        }
        if let best = highestVersion(p.listDir(nvmVersions)) {
            let c = "\(nvmVersions)/\(best)/bin/node"
            if p.isExecutable(c) { return c }
        }

        // fnm — aliased default first, then newest installed.
        for root in ["\(home)/.local/share/fnm", "\(home)/.fnm",
                     "\(home)/Library/Application Support/fnm"] {
            let aliasDefault = "\(root)/aliases/default/bin/node"
            if p.isExecutable(aliasDefault) { return aliasDefault }
            let versions = "\(root)/node-versions"
            if let best = highestVersion(p.listDir(versions)) {
                for c in ["\(versions)/\(best)/installation/bin/node",
                          "\(versions)/\(best)/bin/node"] where p.isExecutable(c) { return c }
            }
        }

        // asdf — shim first (it respects .tool-versions), then installs.
        let asdfShim = "\(home)/.asdf/shims/node"
        if p.isExecutable(asdfShim) { return asdfShim }
        for lang in ["nodejs", "node"] {
            let installs = "\(home)/.asdf/installs/\(lang)"
            if let best = highestVersion(p.listDir(installs)) {
                let c = "\(installs)/\(best)/bin/node"
                if p.isExecutable(c) { return c }
            }
        }

        // mise (and its rtx ancestor).
        for root in ["\(home)/.local/share/mise", "\(home)/.local/share/rtx"] {
            let shim = "\(root)/shims/node"
            if p.isExecutable(shim) { return shim }
            let installs = "\(root)/installs/node"
            if let best = highestVersion(p.listDir(installs)) {
                let c = "\(installs)/\(best)/bin/node"
                if p.isExecutable(c) { return c }
            }
        }

        // volta — a single shim that dispatches to the pinned version.
        let volta = "\(home)/.volta/bin/node"
        if p.isExecutable(volta) { return volta }

        return nil
    }

    /// Highest semver-ish directory name. Names that do not parse (e.g. "lts",
    /// "latest") sort below anything numeric rather than being dropped, so a
    /// tree containing only those still yields a candidate.
    public static func highestVersion(_ names: [String]) -> String? {
        names.filter { !$0.hasPrefix(".") }
            .max { versionKey($0).lexicographicallyPrecedes(versionKey($1)) }
    }

    public static func versionKey(_ name: String) -> [Int] {
        let stripped = name.hasPrefix("v") ? String(name.dropFirst()) : name
        let parts = stripped.split(separator: ".").map { part -> Int in
            Int(part.prefix(while: { $0.isNumber })) ?? -1
        }
        // Pad so 24 > 9.9.9 compares on the major first and short names do not
        // win by being short.
        var key = parts
        while key.count < 3 { key.append(-1) }
        return Array(key.prefix(3))
    }

    // MARK: - $PATH

    static func scanPath(_ p: Probe) -> String? {
        for dir in p.pathVar.split(separator: ":", omittingEmptySubsequences: true) {
            let c = "\(dir)/node"
            if p.isExecutable(c) { return c }
        }
        return nil
    }
}
