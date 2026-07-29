// UpdateCore — reading the installer's output, and when it is safe to relaunch.
//
// The bugs this file exists to prevent, both of which were invisible:
//
//   1. A progress bar that stops moving. The update runs `install.sh --update
//      --with-app`, and the longest single step by wall clock is `swift build`
//      inside app/build.sh — minutes of raw SwiftPM output that follows none of
//      the installer's formatting conventions. Classify that output as "no
//      phase" and the label freezes on whatever came before it, which looks
//      exactly like a hung process. Worse, build.sh marks its own steps with
//      `▸ ` and NO indentation, so the rule derived from install.sh alone
//      (`info() { echo "  $1"; }`) misses precisely the step that matters most.
//      And after the final `✓ … instalado com sucesso!` the installer prints six
//      "Próximos passos" lines indented with two spaces — each of which would
//      otherwise become a phase, leaving the last label the operator sees as
//      "Ajuda a qualquer momento: /forge-help".
//
//   2. A relaunch button that appears while the installer is still running.
//      The old `runUpdate()` set `needsRelaunch = true` as soon as a Terminal
//      window had been opened, so clicking it killed the installer mid-build.
//      The decision belongs to the process exit code and nowhere else.
//
// Everything here is pure so ForgeKitTests can cover it: the app target owns
// `Process`, SwiftUI and NSApplication, and cannot be imported by a test target.

import Foundation

// MARK: - Classifying a line of installer output

/// What one line of installer output means to the progress UI.
public enum InstallerLine: Equatable {
    /// A step worth showing as the current label.
    case phase(String)
    /// Everything else: raw compiler output, sub-items, onboarding text.
    case detail(String)
    /// The installer announced success; no later line may claim the label.
    case finished(String)
}

/// Turns the installer's stdout into phase transitions.
///
/// Stateful for one reason only: `finished` is terminal. Once the success line
/// has been seen, every following line is a detail — that is what keeps the six
/// onboarding lines out of the label.
public struct InstallerPhaseTracker {
    /// The three markers actually emitted. `✓`/`⚠` come from install.sh:35-36,
    /// `▸` from app/build.sh — a different script with a different convention,
    /// invoked by the first one.
    private static let markers = ["✓ ", "⚠ ", "▸ "]

    private var finished = false

    public init() {}

    public mutating func consume(_ raw: String) -> InstallerLine {
        let line = Self.normalize(raw)
        if line.trimmingCharacters(in: .whitespaces).isEmpty { return .detail("") }
        if finished { return .detail(line) }

        // A marker beats indentation: `success "  hooks sincronizados"` prints
        // `✓   hooks…` — marker at column 0, detail-level indentation after it.
        let leading = String(line.drop(while: { $0 == " " || $0 == "\t" }))
        if let marker = Self.markers.first(where: { leading.hasPrefix($0) }) {
            let phrase = String(leading.dropFirst(marker.count))
                .trimmingCharacters(in: .whitespaces)
            if marker == "✓ ", phrase.lowercased().contains("instalado com sucesso") {
                finished = true
                return .finished("concluído")
            }
            return .phase(phrase)
        }

        // `info()` indents by exactly two; a sub-item (`info "  text"`) lands on
        // four, and raw tool output on zero. Only the first is a phase.
        if Self.isTwoSpaceIndented(line) {
            return .phase(line.trimmingCharacters(in: .whitespaces))
        }
        return .detail(line)
    }

    /// Strip carriage returns and one trailing newline. Progress-style output
    /// uses `\r` freely and it would otherwise end up inside the label.
    static func normalize(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: "\r", with: "")
        if s.hasSuffix("\n") { s.removeLast() }
        return s
    }

    /// `^ {2}\S` — exactly two spaces of indentation, then content.
    static func isTwoSpaceIndented(_ line: String) -> Bool {
        let chars = Array(line)
        guard chars.count > 2 else { return false }
        return chars[0] == " " && chars[1] == " " && chars[2] != " " && chars[2] != "\t"
    }
}

// MARK: - Labelling a phase in Portuguese

/// Known installer phrases get a short Portuguese label; unknown ones are shown
/// verbatim.
///
/// Degrading to the raw phrase is deliberate. The alternative — mapping only
/// recognised phrases and dropping the rest — means a renamed string in
/// install.sh silently stops advancing the bar, and nobody finds out until an
/// update looks hung. Showing English is a smaller failure than showing nothing.
public enum InstallerLabels {
    /// Matched case-insensitively, by `contains`, in order: the first entry that
    /// matches wins, so more specific needles come first.
    private static let table: [(needle: String, label: String)] = [
        ("Backup saved", "fazendo backup"),
        ("Cleaning up legacy", "limpando arquivos legados"),
        ("Installing agents", "copiando agentes"),
        ("Installing dispatch", "copiando templates de dispatch"),
        ("Verificando disponibilidade", "verificando modelos"),
        ("Installing commands", "copiando comandos"),
        ("Installing scripts", "copiando scripts"),
        ("Installing skills", "copiando skills"),
        ("Installing preferences", "instalando preferências"),
        ("Installing shared", "copiando referências compartilhadas"),
        ("Statusline", "instalando statusline e hooks"),
        ("hooks", "instalando statusline e hooks"),
        ("MCP", "configurando MCPs"),
        ("Limpando build", "limpando build anterior"),
        ("Building the macOS app", "compilando o app"),
        ("Compilando", "compilando o app"),
        ("Gerando ícone", "gerando ícone"),
        ("Assinando", "assinando"),
        ("Forge.app instalado", "app instalado"),
        ("Instalando em /Applications", "instalando em /Applications"),
    ]

    public static func label(for phrase: String) -> String {
        let hay = phrase.lowercased()
        for entry in table where hay.contains(entry.needle.lowercased()) {
            return entry.label
        }
        return phrase
    }
}

// MARK: - Deciding whether the update succeeded

/// Exit code in, decision out. The only source of truth for "may relaunch".
public enum UpdateOutcome {
    public static func canRelaunch(exitCode: Int32) -> Bool { exitCode == 0 }

    /// A failure the operator can act on: the code, plus the tail of the output
    /// where the real reason lives (`set -euo pipefail` means the last lines are
    /// usually the error).
    public static func failureMessage(exitCode: Int32, lastLines: [String]) -> String {
        let head = "a atualização falhou (código \(exitCode))"
        let tail = lastLines
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .suffix(3)
        return tail.isEmpty ? head : head + "\n" + tail.joined(separator: "\n")
    }
}

// MARK: - Which bundle a relaunch would reopen

/// The relaunch reopens the RUNNING bundle, not necessarily the one the
/// installer just wrote to /Applications. Someone running a dev build outside
/// /Applications did that on purpose, so the target is not redirected — the
/// divergence is stated instead.
public enum RelaunchTarget {
    public static let canonical = "/Applications/Forge.app"

    public static func isCanonical(_ path: String) -> Bool {
        normalized(path) == normalized(canonical)
    }

    public static func divergenceNote(for path: String) -> String? {
        guard !isCanonical(path) else { return nil }
        return "vai reabrir este bundle em \(normalized(path)), "
            + "não o que o instalador acabou de instalar em \(canonical)"
    }

    private static func normalized(_ path: String) -> String {
        var s = path
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

// MARK: - Restoring the last selected section

/// Which sidebar section to show at launch.
///
/// The stored value is a section's `rawValue`, which is also its visible label —
/// so renaming a sidebar item invalidates whatever was persisted. That has to
/// fall back explicitly instead of resolving to nothing.
public enum SectionRestore {
    public static func resolve(rawValue: String?, valid: [String], fallback: String) -> String {
        guard let rawValue, !rawValue.isEmpty, valid.contains(rawValue) else { return fallback }
        return rawValue
    }
}

// MARK: - Refusing to start when git cannot fast-forward

/// The update begins with `git pull --ff-only`. When that cannot succeed, the
/// refusal is the feature: the operator develops Forge in this very repo, and
/// moving their work aside to install an update is damage, not convenience. So
/// nothing here ever rewrites the working tree or the history, and the state is
/// checked BEFORE
/// the installer starts, rather than after a bar has been on screen for seconds.
public enum UpdatePrecheck {
    public enum Blocker: String {
        case dirtyTree
        case diverged
    }

    public static func evaluate(dirty: Bool, ahead: Int) -> Blocker? {
        if dirty { return .dirtyTree }
        if ahead > 0 { return .diverged }
        return nil
    }

    public static func message(for blocker: Blocker) -> String {
        switch blocker {
        case .dirtyTree:
            return "não vou atualizar com mudanças não commitadas no repo do Forge. "
                + "O update roda `git pull --ff-only`, e mexer na sua árvore de trabalho "
                + "para abrir caminho seria perder trabalho seu. Resolva você e tente de novo."
        case .diverged:
            return "o seu branch tem commits que o remoto não tem, então o `--ff-only` "
                + "não passa. Não toco no seu histórico: publique ou mova esses commits "
                + "como preferir e tente de novo."
        }
    }

    /// A command that only INSPECTS — deliberately nothing that rewrites state.
    public static func manualCommand(repo: String) -> String {
        "cd \(ShellQuote.posix(repo)) && git status && git log --oneline origin/HEAD..HEAD"
    }
}

// MARK: - Quoting a path for a shell command

/// A single-quote shell-escaping helper local to ForgeKit. ForgeKit cannot
/// import ForgeCore (the app target), so this cannot reuse `ForgeCore.shellQuote`
/// even though the two must behave identically — the same repo path is quoted
/// by both the command this file only DISPLAYS and the command `runUpdate()`
/// actually executes.
public enum ShellQuote {
    /// Wraps `s` in single quotes, escaping any embedded single quote as
    /// `'\''` — the standard POSIX-shell technique.
    public static func posix(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
