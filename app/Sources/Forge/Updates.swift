// Updates — installed version, what is available, and the release notes.
//
// Everything comes from the repo the app already resolves for its engines: the
// git tag for the version, `git ls-remote` for what upstream has, CHANGELOG.md
// for the notes. No server, no embedded copy that could drift.
//
// Updating shells out to install.sh rather than reimplementing it. That script
// backs up, re-merges hooks, probes models and re-runs shell-init; a second
// implementation here would be wrong within a release.

import SwiftUI
import ForgeKit

@MainActor
final class UpdateStore: ObservableObject {
    static let shared = UpdateStore()

    @Published private(set) var installed: String?
    @Published private(set) var latest: String?
    @Published private(set) var releases: [Release] = []
    @Published private(set) var checking = false
    @Published private(set) var checkedAt: Date?
    @Published private(set) var lastError: String?
    @Published var updating = false

    /// Versions already announced, so a check that runs again does not
    /// re-notify the same release. Persisted: an update stays available for
    /// days, and being told once a launch is nagging.
    @AppStorage("announcedUpdate") private var announced = ""

    /// True only when upstream is strictly ahead. Comparison is semantic, so
    /// v2.11.0 is correctly newer than v2.9.0.
    var updateAvailable: Bool {
        guard let latest, let installed else { return false }
        return Version.isNewer(latest, than: installed)
    }

    /// The release the user does not have yet, for the "what's new" callout.
    var pendingRelease: Release? {
        guard let installed else { return nil }
        return releases.first { !$0.isUnreleased && Version.isNewer($0.version, than: installed) }
    }

    private var repo: String? { ForgeCore.repoPath }

    func load() {
        guard let repo else {
            lastError = "repo do Forge não encontrado nas preferências"
            return
        }
        installed = git(["describe", "--tags", "--abbrev=0"], at: repo)
        if let text = try? String(contentsOfFile: "\(repo)/CHANGELOG.md", encoding: .utf8) {
            releases = ChangelogParser.parse(text)
        }
    }

    /// Ask the remote what the newest tag is. Network-bound, so never automatic
    /// on a timer — the statusline already does its own throttled check.
    func check() {
        guard let repo, !checking else { return }
        checking = true
        lastError = nil
        Task.detached(priority: .utility) {
            // Fetch tags without touching the working tree.
            _ = Self.git(["fetch", "--tags", "--quiet", "origin"], at: repo)
            let tag = Self.git(["describe", "--tags", "--abbrev=0", "origin/HEAD"], at: repo)
                ?? Self.git(["tag", "--sort=-v:refname"], at: repo)?
                    .components(separatedBy: "\n").first
            await MainActor.run {
                self.latest = tag?.trimmingCharacters(in: .whitespacesAndNewlines)
                self.checking = false
                self.checkedAt = Date()
                self.load()
                if self.latest == nil { self.lastError = "não consegui ler as tags do remoto" }
                self.announceIfNew()
            }
        }
    }

    /// Run install.sh --update. Opens a terminal rather than running headless:
    /// the installer prints what it backs up and can ask, and a silent upgrade
    /// of the tool you are standing on is not something to hide.
    func runUpdate() {
        guard let repo else { return }
        updating = true
        let cmd = "git -C \(ForgeCore.shellQuote(repo)) pull --ff-only && "
            + "bash \(ForgeCore.shellQuote("\(repo)/install.sh")) --update"
        let r = ForgeCore.openTerminal(cwd: repo, command: cmd, title: "Atualizando o Forge")
        updating = false
        if !r.ok { lastError = r.stderr }
    }

    /// Announce a newly available version once. Uses the same notifier as
    /// gates, so it follows whatever path actually works on this machine.
    private func announceIfNew() {
        guard updateAvailable, let latest, latest != announced else { return }
        announced = latest
        let headline = pendingRelease?.headline
        Notifier.shared.announceUpdate(version: latest, headline: headline)
    }

    /// Check once per launch, in the background. Never on a timer: it hits the
    /// network, and a release does not appear twice in an afternoon.
    func checkOnLaunch() {
        guard checkedAt == nil else { return }
        load()
        check()
    }

    private func git(_ args: [String], at path: String) -> String? { Self.git(args, at: path) }

    nonisolated private static func git(_ args: [String], at path: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", path] + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
            let d = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            let s = String(data: d, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (s?.isEmpty ?? true) ? nil : s
        } catch { return nil }
    }
}

// MARK: - View

struct UpdatesView: View {
    @StateObject private var store = UpdateStore.shared
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                versionCard
                if let err = store.lastError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                ForEach(store.releases.prefix(12)) { r in
                    ReleaseCard(release: r, installed: store.installed)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Atualizações")
        .onAppear { store.load() }
        .toolbar {
            ToolbarItem {
                Button { store.check() } label: {
                    if store.checking { ProgressView().controlSize(.small) }
                    else { Label("Verificar", systemImage: "arrow.clockwise") }
                }
                .disabled(store.checking)
                .help("Consulta as tags do repositório remoto")
            }
        }
    }

    private var versionCard: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(store.updateAvailable ? Color.accentOrange.opacity(0.15)
                                                : Color.secondary.opacity(0.12))
                    .frame(width: 54, height: 54)
                Image(systemName: store.updateAvailable ? "arrow.down.circle.fill" : "checkmark.circle")
                    .font(.system(size: 24))
                    .foregroundStyle(store.updateAvailable ? Color.accentOrange : .secondary)
            }

            VStack(alignment: .leading, spacing: 3) {
                if store.updateAvailable, let latest = store.latest {
                    Text("Atualização disponível: \(latest)").font(.headline)
                    Text("Instalada: \(store.installed ?? "—")")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(store.installed ?? "versão desconhecida").font(.headline)
                    Text(store.checkedAt == nil
                         ? "Verifique para saber se há algo novo."
                         : "Você está na versão mais recente.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if store.updateAvailable {
                Button("Atualizar") { store.runUpdate() }
                    .controlSize(.large)
                    .help("Abre um terminal rodando install.sh --update")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(store.updateAvailable ? Color.accentOrange.opacity(0.4) : .clear))
    }
}

struct ReleaseCard: View {
    let release: Release
    let installed: String?
    @State private var expanded: Bool

    init(release: Release, installed: String?) {
        self.release = release
        self.installed = installed
        // Open the newest entry and anything the user does not have yet; older
        // releases start folded so the page is scannable.
        let isNew = installed.map { Version.isNewer(release.version, than: $0) } ?? false
        _expanded = State(initialValue: release.isUnreleased || isNew)
    }

    private var isInstalled: Bool { release.version == installed }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                    Text(release.version).font(.headline)
                    if isInstalled {
                        Text("instalada").font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                    if release.isUnreleased {
                        Text("não lançada").font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.accentOrange.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                    }
                    Spacer()
                    Text("\(release.entryCount)")
                        .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let h = release.headline, !h.isEmpty {
                Text(h).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if expanded {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(release.sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                Image(systemName: section.kind.icon)
                                    .font(.caption2)
                                    .foregroundStyle(section.kind.tint)
                                Text(section.kind.label.uppercased())
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(section.kind.tint)
                                Text("\(section.entries.count)")
                                    .font(.system(size: 9)).monospacedDigit()
                                    .foregroundStyle(.tertiary)
                                Spacer()
                            }
                            ForEach(Array(section.entries.enumerated()), id: \.offset) { _, entry in
                                ChangelogEntryView(entry: entry, tint: section.kind.tint)
                            }
                        }
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

extension ReleaseSection.Kind {
    /// Only corrections and security get colour. A changelog where every
    /// section is tinted is a changelog where nothing stands out — and a fix is
    /// the entry most likely to explain something you already hit.
    var tint: Color {
        switch self {
        case .fixed:    return .orange
        case .security: return .red
        default:        return .secondary
        }
    }
}

/// One bullet, rendered as markdown.
///
/// These notes are written as "**Lead sentence.** the detail", so the lead is
/// pulled out and given weight — in a list of thirty entries that is the
/// difference between scanning and reading everything.
struct ChangelogEntryView: View {
    let entry: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(tint.opacity(0.5))
                .frame(width: 4, height: 4).padding(.top, 6)

            VStack(alignment: .leading, spacing: 2) {
                if let split = entry.changelogLead {
                    Text(split.lead)
                        .font(.caption).bold()
                        .fixedSize(horizontal: false, vertical: true)
                    if !split.rest.isEmpty {
                        Text(markdown(split.rest))
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text(markdown(entry))
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
    }

    /// Inline markdown only — `code` and **bold**. Failing over to the raw
    /// string keeps a malformed entry readable instead of blank.
    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
