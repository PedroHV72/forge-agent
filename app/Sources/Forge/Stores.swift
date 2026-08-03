// Stores — observable state backing the UI.
//
// Refresh costs differ by an order of magnitude, so the cadences do too:
//   gates/runs → local JSON reads, polled every 2s
//   accounts   → one CLI call, refreshed on demand
//   usage      → a real API request per account (~9 tokens each), so it is
//                manual/cached only. Polling it on a timer would quietly spend
//                the user's quota just to keep a progress bar warm.

import SwiftUI
import Foundation
import ForgeKit

// MARK: - Workspaces

/// Which projects to watch. Editable by hand, in either of two shapes — the
/// legacy flat array of paths, or the versioned object with roots, typed entries
/// and quarantine. All shape knowledge lives in `WorkspaceRegistry` (ForgeKit,
/// hence testable); this enum is the file I/O around it and nothing more.
enum Workspaces {
    static var home: String { FileManager.default.homeDirectoryForCurrentUser.path }

    static var file: String { "\(home)/.claude/\(WorkspaceRegistry.filename)" }

    static func load() -> [String] { loadOutcome().visible }

    /// Same read as `load()`, but keeps "the file could not be parsed" apart
    /// from "the file parsed and declares nothing" — the distinction I-20260802223042
    /// exists to put back on screen. `load()` delegates here so every other
    /// caller keeps seeing a plain `[String]`.
    static func loadOutcome() -> (visible: [String], unreadable: Bool) {
        guard let data = FileManager.default.contents(atPath: file) else {
            // `contents(atPath:)` returns nil both when the file is absent and
            // when it exists but could not be read (EACCES, I/O error). Those
            // are different events — a present-but-unreadable file must fire
            // the same notice as an unparseable one (R2 review fix, S02-REVIEW),
            // not render like a fresh install with nothing registered yet.
            let unreadable = FileManager.default.fileExists(atPath: file)
            if unreadable {
                FileHandle.standardError.write(Data(
                    "Forge: \(file) não pôde ser lido — a lista de projetos NÃO foi alterada. Corrija o arquivo (há backup .bak ao lado após a migração).\n".utf8))
            }
            return ([], unreadable)
        }
        guard let r = WorkspaceRegistry.resolution(from: data, home: home) else {
            // Not `[]`. An unreadable registry is an event: returning an empty
            // list here is what used to make a corrupt file and a fresh install
            // look identical on screen.
            FileHandle.standardError.write(Data(
                "Forge: \(file) não pôde ser lido — a lista de projetos NÃO foi alterada. Corrija o arquivo (há backup .bak ao lado após a migração).\n".utf8))
            return ([], true)
        }
        // "Does not resolve" and "was deleted" both remove a card, so they are
        // reported apart — only the second is the operator's own doing.
        for bad in r.rejected {
            FileHandle.standardError.write(Data(
                "Forge: entrada ignorada em \(WorkspaceRegistry.filename): \"\(bad.stored)\" — \(bad.reason)\n".utf8))
        }
        return (r.paths.filter { FileManager.default.fileExists(atPath: $0) }, false)
    }

    /// Absolute roots the registry declares, resolved against `home` — what
    /// discovery should scan (see `ProjectDiscovery.scan(declaredRoots:)`).
    /// `[]` on an absent file, a legacy shape, or an unreadable file — the
    /// caller falls back to the hardcoded name-list scan in every one of
    /// those cases, so the unreadable/empty distinction is not needed here.
    static func declaredRoots() -> [String] {
        guard let data = FileManager.default.contents(atPath: file) else { return [] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.roots ?? []
    }

    /// Every record the registry resolves, whether or not its directory still
    /// exists on disk — the base `add`/`remove` build `newPaths` from, never
    /// `load()`.
    ///
    /// `load()` is filtered to what is visible on screen (R2 review fix,
    /// S01-REVIEW): a directory that is unmounted or briefly moved still
    /// resolves fine and simply is not offered by the fileExists filter. Any
    /// unrelated `save()` recomputes the file from `newPaths` — so building
    /// `newPaths` from the filtered list would silently delete every record
    /// currently absent from disk, migration `quarantine[]` included, as a
    /// side effect of adding or removing something else entirely. The
    /// `fileExists` check must stay display-only; it must never feed a write.
    ///
    /// I-20260803132250: this used to be a comment alone. `add`/`remove` now
    /// route their mutation through `WorkspaceRegistry.mutatedPaths(allResolved:)`
    /// (ForgeKit, pure, no `visible` parameter to accidentally pass) — that
    /// function, not this one, is what `ForgeKitTests` exercises to assert the
    /// invariant at the call site, since `ForgeKitTests` cannot import this
    /// `Forge` executable target.
    /// Paths the registry declares `kind: workspace` — see
    /// `ProjectOrganiser.containmentHazards`, the only consumer. `[]` on an
    /// absent, legacy or unreadable file, which is the same conservative answer
    /// in all three cases: nothing is declared, so nothing is suppressed.
    static func declaredWorkspaces() -> Set<String> {
        guard let data = FileManager.default.contents(atPath: file) else { return [] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.declaredWorkspaces ?? []
    }

    static func loadAllResolved() -> [String] {
        guard let data = FileManager.default.contents(atPath: file) else { return [] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.paths ?? []
    }

    static func save(_ list: [String]) {
        let original = FileManager.default.contents(atPath: file)
        // A nil here is a refusal, not a failure to encode: the file on disk is
        // in a shape we could not parse, and overwriting it would trade the
        // operator's roots and quarantine for one click.
        guard let data = WorkspaceRegistry.updatedData(
            original: original, newPaths: list, home: home) else {
            FileHandle.standardError.write(Data(
                "Forge: \(file) está ilegível — recusando sobrescrever para não perder roots/quarentena.\n".utf8))
            return
        }
        try? FileManager.default.createDirectory(
            atPath: (file as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: file), options: .atomic)
    }

    static func add(_ p: String)    { save(WorkspaceRegistry.mutatedPaths(allResolved: loadAllResolved(), adding: p)) }
    static func remove(_ p: String) { save(WorkspaceRegistry.mutatedPaths(allResolved: loadAllResolved(), removing: p)) }
}

// MARK: - App state

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    /// Posted after every cheap reload so the Dock badge can follow along
    /// without running a second timer of its own.
    static let didChange = Notification.Name("ForgeAppStateDidChange")

    @Published private(set) var gates: [Gate] = []
    @Published private(set) var runs: [Run] = []
    @Published private(set) var accounts: [Account] = []
    @Published private(set) var activeAccount: String?
    @Published private(set) var usage: [String: AccountUsage] = [:]
    @Published private(set) var workspaces: [String] = []

    /// Registered paths that hold a `.gsd/` but no work — repos a run reached
    /// into, which our tooling enrolled as a side effect. Surfaced rather than
    /// filtered away: a misclassification has to cost a click, never a project.
    @Published private(set) var touchedWorkspaces: [String] = []

    /// Paths the registry declares `kind: workspace`. A workspace containing
    /// its own members is the normal case, so the containment hazard must not
    /// accuse it (I-20260803154521).
    @Published private(set) var declaredWorkspaces: Set<String> = []

    /// True exactly when the registry file exists but could not be parsed —
    /// set by `reloadCheap()` from `Workspaces.loadOutcome()`. The Projects
    /// screen renders a notice while this is true instead of a silently
    /// blank list (closes I-20260802223042).
    @Published private(set) var registryUnreadable = false

    /// Raw values of the two `app.*` prefs, read once at init and on explicit
    /// reload only — see `loadAppDefaults()`.
    @Published private(set) var defaultWorkspacePref = ""
    @Published private(set) var sessionRootDir = ""

    @Published var usageLoading = false
    @Published var usageCheckedAt: Date?
    @Published var toast: Toast?

    /// Live terminal sessions hosted inside the app.
    @Published private(set) var sessions: [TerminalSession] = []

    /// Which sidebar section is showing. Owned here rather than as RootView
    /// `@State` because opening a session has to be able to take the operator
    /// to the terminal — the composer that creates it lives on another screen.
    ///
    /// Persisted on every change, and restored on every launch — not just after
    /// a self-update relaunch. One code path, same storage as `lastWorkspace`.
    /// An unknown raw value (a renamed sidebar label invalidates what was saved)
    /// falls back explicitly; see `SectionRestore`.
    @Published var section: Section? = Section(rawValue: SectionRestore.resolve(
        rawValue: UserDefaults.standard.string(forKey: "lastSection"),
        valid: Section.allCases.map(\.rawValue),
        fallback: Section.now.rawValue)) ?? .now {
        didSet {
            UserDefaults.standard.set(section?.rawValue ?? "", forKey: "lastSection")
        }
    }

    /// Which session the terminal screen shows. Same reason: the creating code
    /// path needs to name it, and the terminal screen may not be on screen yet.
    @Published var focusedSession: UUID?

    /// Show a session: select it and go to the terminal. Every creation path
    /// ends here, so "created but nothing visibly happened" cannot come back.
    func focus(_ s: TerminalSession?) {
        if let s { focusedSession = s.id }
        section = .terminal
    }

    /// Rich per-project status from forge-status.js, keyed by cwd. Spawns node,
    /// so it is refreshed on a slow cadence — unlike the gate/run files, which
    /// are plain reads driven by FSEvents.
    @Published private(set) var status: [String: StatusPayload] = [:]
    private var statusLoading: Set<String> = []

    private var timer: Timer?
    private var watcher: Watcher?

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    var pending: [Gate] { gates.filter(\.isPending).sorted { $0.created_at < $1.created_at } }

    var recent: [Gate] {
        gates.filter { !$0.isPending }
            .sorted { $0.created_at > $1.created_at }
            .prefix(20).map { $0 }
    }

    var liveRuns: [Run] { runs.filter { $0.active }.sorted { $0.started_at > $1.started_at } }

    /// Accounts ordered by real weekly headroom when known, so the one to use
    /// next is simply the one on top. Falls back to name order.
    var accountsByHeadroom: [Account] {
        accounts.sorted { a, b in
            let ua = usage[a.name]?.headroom
            let ub = usage[b.name]?.headroom
            if let ua, let ub, ua != ub { return ua > ub }
            if ua != nil, ub == nil { return true }
            if ua == nil, ub != nil { return false }
            return a.name < b.name
        }
    }

    init() {
        reloadCheap()
        loadAccounts()
        loadAppDefaults()

        // FSEvents drives updates; the timer is only a safety net. It also
        // covers the one change no filesystem can report: a gate reaching its
        // expiry, which is a clock event, not a write.
        watcher = Watcher { [weak self] in
            Task { @MainActor in self?.reloadCheap() }
        }
        watcher?.watch(workspaces)

        timer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.reloadCheap()
                // Progress only changes when a unit finishes, so a slow cadence
                // is plenty — and each call spawns node.
                self?.refreshStatus()
            }
        }
        refreshStatus()
    }

#if DEBUG
    /// An inert state for canvas previews. `init()` reads the operator's real
    /// `.gsd`, spawns node for the per-project status, installs an FSEvents
    /// watcher and starts a 15s timer — in a canvas that runs on every redraw,
    /// which makes the preview slow, machine-dependent and noisy. This does none
    /// of it, so the views render from whatever the preview stages.
    ///
    /// Not a `convenience init` in an extension: that would have to call
    /// `init()`, which is the work being avoided.
    init(preview: Void) {}
#endif

    deinit { timer?.invalidate() }

    // MARK: Cheap reload (files only)

    func reloadCheap() {
        // Registered ≠ project. Our own scripts used to write `.gsd/` into any
        // repo they touched, so the registry accumulated directories that never
        // held work (see `ProjectMarker`). Splitting here rather than in the
        // Projects screen fixes every consumer at once: the composer, the
        // pickers and the metrics screen stop offering a repo nobody planned
        // work in — which is the wrong-repo dispatch hazard `WorkspaceDefaults`
        // exists to prevent.
        let outcome = Workspaces.loadOutcome()
        registryUnreadable = outcome.unreadable
        // The notice (and its doc comment above) promises the list below was
        // NOT changed. `WorkspaceReloadDecision.split` (ForgeKit, hence
        // testable) is what makes that literally true: on `unreadable` it
        // returns the previous split untouched rather than rebuilding from
        // `outcome.visible`, which is always `[]` on that path — R1 review fix,
        // S02-REVIEW.
        let split = WorkspaceReloadDecision.split(
            previous: .init(workspaces: workspaces, touchedWorkspaces: touchedWorkspaces),
            outcome: outcome,
            isProject: { ProjectMarker.classify($0).kind == .project })
        workspaces = split.workspaces
        touchedWorkspaces = split.touchedWorkspaces
        // Held over on `unreadable` for the same reason the split is: the
        // notice promises the list below was not changed, and dropping the
        // declarations would re-accuse a workspace still on screen.
        if !outcome.unreadable { declaredWorkspaces = Workspaces.declaredWorkspaces() }
        if outcome.unreadable {
            watcher?.watch(workspaces)
            NotificationCenter.default.post(name: Self.didChange, object: nil)
            return
        }

        var g: [Gate] = [], r: [Run] = []
        for ws in workspaces {
            g += Self.decodeDir("\(ws)/.gsd/forge/gates", as: Gate.self)
            r += Self.decodeDir("\(ws)/.gsd/forge/runs", as: Run.self)
        }
        gates = g
        runs = r
        // Follow projects being added or removed.
        watcher?.watch(workspaces)
        Notifier.shared.sync(pending: pending)
        NotificationCenter.default.post(name: Self.didChange, object: nil)
    }

    /// Decode every *.json in a directory, skipping anything unreadable —
    /// a half-written or corrupt file must never take the whole list down.
    private static func decodeDir<T: Decodable>(_ dir: String, as: T.Type) -> [T] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir)
        else { return [] }
        let dec = JSONDecoder()
        return names.filter { $0.hasSuffix(".json") }.compactMap { n in
            guard let d = FileManager.default.contents(atPath: "\(dir)/\(n)") else { return nil }
            return try? dec.decode(T.self, from: d)
        }
    }

    /// Open tasks across every registered project, for the sidebar badge.
    ///
    /// Aggregated here rather than in `ItemsView` because the badge has to be
    /// right while the operator is looking at some other section — a count that
    /// only exists while its own screen is open is not a badge, it is a label.
    @Published private(set) var openItemCount = 0

    /// Recount open items across all workspaces. One shell-out per project,
    /// riding the same cadence as `refreshStatus` instead of adding a poll.
    func refreshItemCount() {
        let targets = workspaces
        guard !targets.isEmpty else { openItemCount = 0; return }
        Task.detached(priority: .utility) {
            var total = 0
            for cwd in targets {
                let items = ForgeCore.runJSON([Item].self, "forge-items.js",
                                               ["--list", "--json", "--cwd", cwd]) ?? []
                total += ItemBoard.openCount(items)
            }
            await MainActor.run { self.openItemCount = total }
        }
    }

    /// Fetch status for the projects that have a live run — the only ones whose
    /// progress can change while you watch.
    func refreshStatus(force: Bool = false) {
        refreshItemCount()
        let targets = Set(liveRuns.map(\.cwd)).union(force ? Set(workspaces) : [])
        for cwd in targets where !statusLoading.contains(cwd) {
            statusLoading.insert(cwd)
            Task.detached(priority: .utility) {
                let payload = ForgeCore.runJSON(StatusPayload.self, "forge-status.js",
                                                ["--json", "--cwd", cwd])
                await MainActor.run {
                    self.statusLoading.remove(cwd)
                    if let payload { self.status[cwd] = payload }
                }
            }
        }
    }

    // MARK: Workspace defaults

    /// Reads `app.default_workspace` and `app.session_root_dir` once at init
    /// plus on explicit reload — this must never join `reloadCheap`/the 15s
    /// timer. Those two knobs only change when the operator edits prefs by
    /// hand, so polling them on a timer would spawn node every couple of
    /// seconds for nothing.
    func loadAppDefaults() {
        // `--global-only` (R3 fix, S04 review): `app.*` is a per-operator
        // setting, never per-project. Without this flag, ForgeCore.runJSON
        // inherits the app process's cwd — which can carry a project-local
        // .gsd/forge-prefs.jsonc (e.g. `swift run` inside this very repo) —
        // and that local layer would silently override the operator's
        // global default. This must always resolve the global layer alone.
        let resolved = ForgeCore.runJSON(
            ModelsStore.ResolvedPrefs.self, "forge-prefs.js", ["--resolved", "--global-only"])
        if case .object(let app)? = resolved?.prefs?["app"] {
            defaultWorkspacePref = app["default_workspace"]?.asString ?? ""
            sessionRootDir = app["session_root_dir"]?.asString ?? ""
        } else {
            defaultWorkspacePref = ""
            sessionRootDir = ""
        }
        // A misconfigured default must be visible, not silently dropped.
        if let warning = preselection.warning {
            show(warning, error: true)
        }
        if let warning = sessionRootResolution.warning {
            show(warning, error: true)
        }
    }

    /// The last project a session was opened in, persisted the same way the
    /// rest of the app persists small per-user state (`Updates.swift:29`,
    /// `Projects.swift:86`) — no new file next to `forge-gate-workspaces.json`.
    var lastUsedWorkspace: String {
        UserDefaults.standard.string(forKey: "lastWorkspace") ?? ""
    }

    func rememberWorkspace(_ path: String) {
        guard !path.isEmpty else { return }
        UserDefaults.standard.set(path, forKey: "lastWorkspace")
    }

    /// The single entry point every call site uses to ask "which project
    /// should this start in?" — pref wins, then a still-registered
    /// last-used, then nothing. Never `workspaces.first`; see
    /// `WorkspaceDefaults` for why.
    var preselection: Preselection {
        WorkspaceDefaults.preselect(
            configuredDefault: defaultWorkspacePref,
            lastUsed: lastUsedWorkspace,
            known: workspaces)
    }

    /// Full resolution (path + optional warning) for the session root —
    /// computed once so `resolvedSessionRoot` and the `loadAppDefaults()`
    /// toast agree on the exact same check.
    private var sessionRootResolution: WorkspaceDefaults.SessionRootResolution {
        WorkspaceDefaults.sessionRoot(
            configured: sessionRootDir,
            home: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    /// Where project-less `shell`/`chat` sessions open — the only sanctioned
    /// non-project cwd. Falls back to `$HOME` (with a toast, see
    /// `loadAppDefaults()`) when the configured directory does not exist.
    var resolvedSessionRoot: String { sessionRootResolution.path }

    // MARK: Accounts

    func loadAccounts() {
        guard let payload = ForgeCore.runJSON(
            AccountsPayload.self, "forge-accounts.js", ["--list", "--json"])
        else { return }
        accounts = payload.accounts
        activeAccount = payload.env_active ?? payload.active
    }

    /// Costs a real API call per account — only ever on explicit request.
    func refreshUsage() {
        guard !usageLoading else { return }
        usageLoading = true
        Task.detached(priority: .userInitiated) {
            let rows = ForgeCore.runJSON([AccountUsage].self, "forge-usage.js", ["--json"]) ?? []
            await MainActor.run {
                for row in rows { self.usage[row.name] = row }
                self.usageLoading = false
                self.usageCheckedAt = Date()
                if rows.isEmpty {
                    self.show("Não consegui ler o uso das contas", error: true)
                }
            }
        }
    }

    // MARK: Actions

    func answer(_ gate: Gate, choice: String) {
        guard let cwd = gate.cwd else { return show("gate sem cwd", error: true) }
        answer(gateID: gate.id, cwd: cwd, choice: choice)
    }

    /// Answering by id, so a notification action can resolve a gate without the
    /// decoded object in hand.
    func answer(gateID: String, cwd: String, choice: String) {
        let r = ForgeCore.run("forge-gate.js",
                              ["--answer", gateID, "--choice", choice, "--cwd", cwd])
        // The common failure here is benign: the gate expired or was answered
        // elsewhere between render and click.
        if !r.ok {
            show(r.stderr.isEmpty ? "não foi possível responder" : r.stderr, error: true)
        }
        Notifier.shared.forget(gateID)
        reloadCheap()
    }

    func togglePause(_ run: Run) {
        let paused = ForgeCore.isPaused(cwd: run.cwd, runId: run.id)
        if let err = ForgeCore.setPaused(!paused, cwd: run.cwd, runId: run.id) {
            show(err, error: true)
        } else {
            show(paused ? "Retomado — segue na próxima unidade"
                        : "Pausa pedida — para ao fim da unidade atual")
        }
        reloadCheap()
    }

    func isPaused(_ run: Run) -> Bool {
        ForgeCore.isPaused(cwd: run.cwd, runId: run.id)
    }

    // MARK: Terminal sessions

    /// Open a terminal inside the app. The account is selected with
    /// `claude --account <name>`, the flag the shell-init hook understands —
    /// never by exporting a token, which would leak it into the environment.
    ///
    /// `runId` matters for real: Forge refuses a bare `/forge-auto` once two or
    /// more runs are active in a workspace (multi_run.refused_when_active_count),
    /// which is exactly the case when several milestones share a project.
    func newSession(cwd: String, mode: LauncherSheet.Mode, text: String,
                    account: String, runId: String = "") {
        let desc = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let claudeArgs = account.isEmpty ? "" : " --account \(shq(account))"

        var boot: String?
        var attachedRun: String?

        switch mode {
        case .shell:
            boot = nil
        case .chat:
            boot = "claude\(claudeArgs)"
        case .auto:
            let slash = runId.isEmpty ? "/forge-auto" : "/forge-auto \(runId)"
            attachedRun = runId.isEmpty ? nil : runId
            boot = "claude\(claudeArgs) \(shq(slash))"
        case .newMilestone:
            let slash = desc.isEmpty ? "/forge-new-milestone" : "/forge-new-milestone \(desc)"
            boot = "claude\(claudeArgs) \(shq(slash))"
        case .task:
            guard !desc.isEmpty else { return show("descreva a task", error: true) }
            boot = "claude\(claudeArgs) \(shq("/forge-task \(desc)"))"
        }

        let project = URL(fileURLWithPath: cwd).lastPathComponent
        let title = mode == .shell ? project : "\(project) · \(mode.shortLabel)"
        sessions.append(TerminalSession(
            cwd: cwd, title: title, bootstrap: boot,
            runId: attachedRun, account: account.isEmpty ? nil : account))
        focus(sessions.last)
    }

    /// Open a session from a free-form line. A leading slash command is passed
    /// through verbatim — whatever Forge gains tomorrow works here with no code
    /// change — and plain text becomes a conversation.
    func newSessionRaw(cwd: String, prompt: String, account: String) {
        let claudeArgs = account.isEmpty ? "" : " --account \(shq(account))"
        let boot = "claude\(claudeArgs) \(shq(prompt))"
        let (cmd, _) = ComposerParser.split(prompt)
        let project = URL(fileURLWithPath: cwd).lastPathComponent
        let title = cmd.map { "\(project) · \($0.replacingOccurrences(of: "forge-", with: ""))" }
            ?? "\(project) · chat"
        sessions.append(TerminalSession(
            cwd: cwd, title: title, bootstrap: boot,
            runId: nil, account: account.isEmpty ? nil : account))
        focus(sessions.last)
    }

    @discardableResult
    func closeSession(_ s: TerminalSession, confirm: Bool = false) -> Bool {
        if confirm && s.isRunning {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Encerrar \(s.tabLabel)?"
            alert.informativeText = s.runId != nil
                ? "A run continua salva em disco — você retoma com “Continuar milestone”. A unidade em andamento é interrompida."
                : "A sessão será encerrada."
            alert.addButton(withTitle: "Encerrar")
            alert.addButton(withTitle: "Cancelar")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return false }
        }
        sessions.removeAll { $0.id == s.id }
        // The only place a PTY is allowed to die. The view layer keeps it
        // alive across navigation, so nothing else reclaims it — and skipping
        // this would leak one shell per closed session.
        TerminalViewStore.shared.closeSession(s.id)
        focusedSession = TerminalFocus.afterClosing(
            s.id, selection: focusedSession, remaining: sessions.map(\.id))
        return true
    }

    private func shq(_ s: String) -> String { ForgeCore.shellQuote(s) }

    /// Set the persistent default — what a bare `claude` attaches to. Distinct
    /// from launching: several terminals can run on different accounts without
    /// any of them changing this.
    func setDefaultAccount(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--default", name])
        if r.ok { show("\(name) agora é a conta padrão"); loadAccounts() }
        else { show(r.stderr.isEmpty ? "falha ao definir padrão" : r.stderr, error: true) }
    }

    /// Record which Anthropic identity this account is, so the status line can
    /// name it. Captures the CURRENT session's identity — the engine refuses to
    /// clobber an existing one, and capturing automatically would risk stamping
    /// the wrong account.
    func captureAccountIdentity(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--set-email", name])
        if r.ok { show("Identidade registrada em \(name)"); loadAccounts() }
        else { show(r.stderr.isEmpty ? "não consegui registrar" : r.stderr, error: true) }
    }

    func renameAccount(_ old: String, to new: String) {
        let clean = new.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean != old else { return }
        let r = ForgeCore.run("forge-accounts.js", ["--rename", old, "--to", clean])
        if r.ok {
            show("\(old) → \(clean)")
            loadAccounts()
            // Usage is keyed by name; the old entry would linger as a ghost row.
            if let u = usage.removeValue(forKey: old) { usage[clean] = u }
        } else {
            show(r.stderr.isEmpty ? "falha ao renomear" : r.stderr, error: true)
        }
    }

    /// The relaunch command, for pasting into a terminal the app did not open.
    func copyLaunchCommand(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--launch-cmd", name])
        let cmd = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard r.ok, !cmd.isEmpty else {
            return show(r.stderr.isEmpty ? "não consegui gerar o comando" : r.stderr, error: true)
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
        show("Comando copiado")
    }

    func copyToPasteboard(_ text: String, label: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        show("\(label) copiado")
    }

    func removeAccount(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--remove", name])
        if r.ok { show("\(name) removida"); loadAccounts() }
        else { show(r.stderr.isEmpty ? "falha ao remover" : r.stderr, error: true) }
    }

    /// Open a terminal on another account, in-app. No `workspaces.first`
    /// fallback: it dispatched into the wrong repo indistinguishably from a
    /// correct dispatch (`b992edf`). A `.chat` session carries no project
    /// semantics, so an unresolved preselection lands in the configured
    /// session root dir instead — never a guess among registered projects.
    func launch(account: String) {
        let cwd = preselection.workspace ?? resolvedSessionRoot
        newSession(cwd: cwd, mode: .chat, text: "", account: account)
        sessions.last.map { _ in
            show("Sessão aberta na conta \(account) — \(URL(fileURLWithPath: cwd).lastPathComponent)")
        }
    }

    func openTerminal(at cwd: String, command: String, title: String) {
        let r = ForgeCore.openTerminal(cwd: cwd, command: command, title: title)
        if r.ok { show(title) } else { show(r.stderr, error: true) }
    }

    /// Resume an existing run in an in-app terminal. /forge-auto takes the run
    /// id and picks up from disk state.
    func resume(_ run: Run) {
        sessions.append(TerminalSession(
            cwd: run.cwd, title: "\(run.projectName) · auto",
            bootstrap: "claude \(shq("/forge-auto \(run.id)"))",
            runId: run.id, account: run.account))
        focus(sessions.last)
    }

    /// The sandbox is registered like any other project so examples show up
    /// everywhere real work does — same screens, same code paths.
    func registerSandbox() {
        guard !workspaces.contains(Sandbox.path) else { return }
        Workspaces.add(Sandbox.path)
        reloadCheap()
    }

    func destroySandbox() {
        Workspaces.remove(Sandbox.path)
        // Close any session living in the sandbox first — removing the folder
        // under a running shell leaves it in a directory that no longer exists.
        for s in sessions where s.cwd == Sandbox.path { closeSession(s) }
        do {
            try Sandbox.destroy()
            show("Sandbox removido")
        } catch {
            show("não consegui remover: \(error.localizedDescription)", error: true)
        }
        reloadCheap()
    }

    func addWorkspace(_ p: String)    { Workspaces.add(p); reloadCheap() }

    /// Register a path without surfacing it as a project card — used for
    /// worktrees, which belong to a project already in the list and should not
    /// appear as separate entries.
    func addWorkspaceQuietly(_ p: String) {
        guard !workspaces.contains(p) else { return }
        Workspaces.add(p)
        reloadCheap()
    }
    func removeWorkspace(_ p: String) { Workspaces.remove(p); reloadCheap() }

    func show(_ text: String, error: Bool = false) {
        toast = Toast(text: text, isError: error)
        let shown = toast
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if self.toast == shown { self.toast = nil }
        }
    }
}
