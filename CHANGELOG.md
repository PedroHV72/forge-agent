## v3.4.0 — The version you are running

The app announced a version number that was the repository's tag rather than the binary
you had open — so on a machine where you pull without rebuilding, which is every machine
this is developed on, the number was confidently wrong. The sidebar now reports what is
actually running, says so from every screen, and shows both numbers when they disagree.

### Added

- **The installed version is readable from every screen** (`T-20260730020639-sidebar-secao`). The sidebar footer carries it, and it is the version of the **running binary**, not the repository's tag: `app/build.sh` stamps the `git describe` into the bundle's `Info.plist` (`ForgeGitDescribe`, plus `CFBundleShortVersionString` and `CFBundleVersion` for the Finder) between the plist copy and `codesign` — before it, and every build would dirty the versioned file; after it, and the signature would be invalid. When the repository has moved on since that build, the footer shows both numbers with the second one labelled `repo`, which is the "I committed and forgot to rebuild" case the old display could not represent at all. The number is clickable and lands on Atualizações from anywhere in one click. A build that was never stamped says so — the sentinel is the **absence** of the custom key, never a comparison against the `0.1.0` placeholder, which is also a perfectly legitimate version to ship.
- **One update signal instead of two, and a rule where the list changes register.** The numeral beside "Atualizações" in the sidebar is gone: it was always `1`, so it counted nothing — a dot wearing a number. The signal now lives in one place, on the footer where the version already is, orange with a dot. A single `Divider()` after "Runs" separates the sections where work happens from the ones that hold configuration; the release list keeps five entries at rest, with the rest one click away and the cut taken strictly off the historical tail — the entry for the version you are running, the one you could move to, and anything unreleased are pinned into the visible window whenever they exist at all; and the update card lost the decorative disc that repeated what its own headline and orange border already said.

### Fixed

- **Two `## Unreleased` headings in this file, both of them stale.** `Release.id` is the version string, so the app was handing `ForEach` two rows with the same id — undefined behaviour in SwiftUI, and about to become visible now that the list is short enough for both to fall inside it. Each has been renamed to the version it actually shipped in, determined by ancestry rather than by guess (`git describe --contains` on the commit that introduced the block): the top one is **v3.2.0**, the one below `v3.0.0-beta` is **v2.5.0**. The rename alone would let this come back, so a test now fails if any two releases parsed from `CHANGELOG.md` share an id, or if `## Unreleased` appears more than once.
- **The sidebar never re-rendered when the update check finished.** `RootView` read `UpdateStore.shared` but did not observe it, so anything in that column that depended on an update being found was born empty and stayed empty until something else forced a redraw. Pre-existing, and load-bearing for everything above: it is why the footer populates on its own when the launch check returns.

---

## v3.3.0 — An installer you can watch

Two tasks about the same complaint: the app would not tell you where it stood while it
updated itself. It ran behind a spinner with nothing beside it, and it could only be made
to run the installer when a release happened to be pending.

### Added

- **The in-app installer shows what it is doing while it does it** (`T-20260729191241-atualizacao-barra`). "Atualizar" used to hand off to `install.sh` and then say nothing for minutes, so a slow update and a hung one looked identical and the only way to tell them apart was to give up. The installer now runs headless with its output streamed into the card: a phase label that is the answer on its own, a spinner that stops when the run does, and a log folded away because it is the appeal, not the answer — it is where a failed step explains itself. There is deliberately **no percentage**: the `swift build` alone dominates the wall clock, so any number would be invented, and a bar that stops moving is the complaint rather than the fix. The precheck that refuses to update a dirty or diverged checkout now says that the refusal is **protection** and names the command that clears it, instead of reporting a failure the operator has to interpret. Relaunch is offered only on exit 0, and the relaunch sequence was reordered so that cancelling the live-session alert no longer leaves two copies of the app running.
- **"Reinstalar"** (`T-20260730004115-afordance-reinstalar`) — reapplies agents, skills, scripts and the app from the checkout you already have, with **no git at all**: no fetch, no pull, no tag comparison. Two things follow. The progress UI above becomes reachable on demand rather than only in the minutes after a release appears; and the one state the precheck refuses — local commits, or a dirty tree — gains an action that works anyway. It renders next to "Atualizar" rather than instead of it, because an available-but-blocked update is exactly the state it exists to unblock.

---

## v3.2.0 — SVN in the sidecar, and the end of `environment` as a free pass

### Added

- **The multi-LLM sidecar runs against a Subversion working copy** (M017, phase 1). `scripts/forge-vcs.js` is the single owner of every VCS primitive the sidecar needs — detection, baseline id, post-run change set — with a closed sentinel per primitive so an unsupported VCS refuses by name instead of silently returning something plausible. `--mode execute` and `--mode plan` go end to end on an SVN checkout **without issuing a single git command**, and the surgical reset keeps its central safety property there: an operator's pre-existing dirty file survives a sidecar failure **byte-identical**, proven against a real `svn` fixture rather than a mock. `require_worktree` no longer strands an SVN checkout — activation resolves to `shared` with a reason that names SVN, instead of failing every repo and stopping the run. Isolation and worktree equivalence for SVN are explicitly **not** in this phase.

### Fixed

- **`scope: environment` stopped being a free pass** (TASK-020). The sidecar could mark a must-have `status: unknown, scope: environment` with an allowlist `reason`, and the pipeline accepted the work with the verification never having run. Measured **13 times across three sessions** — every one false; in one case 6 of 9 must-haves, the entire behavioural proof of a task, went unverified. Three holes that compounded:
  - The `git-commit-required` corroborator was tautological: `/\bgit\b|commit|push/i` over `item + note` meant any note that *mentioned* git corroborated itself — including one whose text was *"the task prohibits running any git command"*. It now reads `entry.note` only (never `item`, which is plan boilerplate echoed back) and requires a git **write** operation. This is the rigour `sandbox-exec-blocked` already had ten lines below, and which was never carried across to its neighbour.
  - The re-verification net was hung off a single reason. `needsReverification` and `affectedEntries` both filtered on `sandbox-exec-blocked`, so four of the five reasons never reached it. Both now share one predicate covering the four *execution-blocked* reasons. `gsd-write-refused` is deliberately excluded: a green test suite never touches `.gsd/**`, so its exit code cannot be evidence for a write-refusal claim — promoting it would have replaced silent acceptance with an attestation backed by irrelevant evidence, which the review caught and reproduced. **The trigger and the entry selector always move together**; narrowing one alone yields a gate that fires, spends a full suite run, and selects nothing.
  - Even when it fired, it had nothing to run here. Stack detection covered `package.json`/`go.mod`/`Cargo.toml`/pytest/`Makefile` and returned `null` in a zero-dep repo — so the net was blind to the very project that ships it. It now falls back to `CODING-STANDARDS.md § Lint & Format Commands → **Test:**`, discarding any candidate that needs shell parsing (globs, metacharacters, quotes, backslashes) because the spawn is `shell:false`. `--gsd-dir` is threaded to the CLI and the four mirrors, since `.gsd/` is not under `CODE_DIR` in worktree mode and walk-up would fail exactly where this runs.

  Proven on live data rather than a fixture: the sidecar produced a 13th false `git-commit-required` claim *during this very task*. The old code promoted it; the new code rejects it.

- **A smoke label that promised more than it measured.** Section 80 asserted "execute on SVN never invokes the PATH git shim" and passed — but a dogfood run against a real `svn` working copy with the real codex CLI showed the CLI probing `git … remote -v` on its own, a pattern absent from the forge codebase and non-fatal. The assertion is unchanged (the git log must still be empty); the label now says what it proves: forge's own code issues no git command. The mocked codex doesn't sniff for git, which is why it passed.

- **A guard that fired on prose, not on behaviour.** `forge-auto/SKILL.md exit '## Deactivate auto-mode indicator'` had been red on `master` since v3.1.0 — including at the v3.1.1 release. The assert anchors on the first match of the section title, but that title also appears earlier as an inline cross-reference inside the `status: partial` bullet; the 1000-char window from there covers the `status: blocked` bullet, and v3.1.0's item-capture block pushed the deactivation command out of it. Nothing had regressed — someone wrote prose nearby. It now anchors on the newline-delimited header, so it reads the section it claims to check. Verified by counterfactual: deleting the deactivation command from that section turns it red again.

### Known, not fixed

- The ambiguity gate (`hasDivergentCommandNotes`) only refuses when entries' notes name *different* runner tokens; a note naming none passes ungated. Tracked as an item.
- `/forge-init` writes `- **Lint:**`, `- **Format:**` and `- **Type check:**` but never `- **Test:**`, so the fallback above finds nothing in a freshly initialised project — the zero-dep projects that need it most. Tracked as an item.

---

## v3.1.1 — The vault stops crying wolf, and starts keeping receipts

### Fixed

- **The app was the reason the Keychain kept asking.** `SecretsView.add()` wrote the secret itself with `SecItemAdd` before calling the engine, on the theory that this kept the value out of argv. It did not: the engine's `security add-generic-password` needs the value in `-w` and ran immediately afterwards regardless. So the framework write avoided *zero* exposure while creating an item whose ACL trusts the ad-hoc bundle's cdhash — which changes on every rebuild, so every later read by `security(1)` came from an "unknown" binary and prompted. `VaultKeychain`, the call, the guard and `import Security` are gone; the engine is the only writer. **Existing secrets keep the old ACL** — purging it needs `forge-secrets remove <svc> <name>` *then* `add`, because `--add` alone uses `-U`, which updates the item and preserves the ACL.
- **"Registrado sem valor no cofre — readicione", for a secret that was fine.** `list()` computed `has_secret` as `!!get(...)`, and `get()` returned `null` for *every* failure — a denied prompt, a locked keychain, the 5-second timeout. A healthy credential listed as missing and the UI told the operator to redo work. `get()` now sits on a three-state probe (`present|absent|unknown`) with an **allowlist**: only exit 44 (Keychain) and `ENOENT`/missing key (file) mean absent; everything else is unknown. A blocklist would have re-introduced the same defect through any error nobody thought to enumerate. `get()` keeps its `string|null` signature, so the seven existing assertions were untouched.
- Two texts that were also false: the claim that a secret added in the app "não passa por linha de comando", and the `·` footnote telling an operator who had just run `--verify` to run `--verify`.

### Added

- **Keychain write-failure diagnostics** (`scripts/forge-keychain-diagnostics.js`). `storeSecret` used to swallow a `security` failure and fall back to the 0600 file silently, so a failed write left no trace beyond a `store` field. Both write paths now record the exit code, signal, trimmed stderr, whether the fallback was used, and enough process context to settle whether a sandbox is involved — to `~/.claude/forge-keychain-diagnostics.jsonl`, capped at 256 KB, readable via `forge-secrets --diagnostics`. The secret value is never recorded, and a test asserts a sentinel value never reaches the file.

### Known, not fixed

- A separate macOS dialog — **"Chaves Não Encontradas: não foi possível encontrar as chaves para armazenar «\<user\>»"** — is a *store* failure, not the authorization prompt above, and its cause is still open. Two hypotheses were investigated and both failed verification, so nothing was changed on a guess. The diagnostics added in this release exist precisely so the next occurrence produces evidence.

---

## v3.1.0 — A backlog for the work Forge already defers

Forge has always produced work items it then had nowhere to put. A conceded review
objection became a line of prose in `KNOWLEDGE.md`; a deferred plan-gate finding became a
note in a marker the milestone cleanup later deleted; a blocked unit became an event nobody
read. This release gives those deferrals a destination, and gives the app a default project
so it stops asking where you are before every line.

### Added

- **Item store** (`scripts/forge-items.js`, `.gsd/items/`). One markdown fragment per item, per project, in the same merge-safe shape as `.gsd/decisions/` and `.gsd/ledger/` — two branches can each create items and merge without conflict. Closed status set (`inbox → triaged → doing → done|dropped`); anything else is an error, not a warning. IDs are `I-<timestamp>-<slug>` and resolve by any unique prefix, git short-sha style — an ambiguous prefix names its candidates instead of guessing. Durable across `milestone_cleanup`, like the ledger.
- **Auto-capture at the junctions that already existed** — a review follow-up, a plan-gate `Deferir`, a blocked unit, and the standalone-task review boundary all now create an item carrying its own provenance (`source`, `file:line`, sha, milestone). No new decision points were invented. Cutover, not dual-write: the item is the single destination and the old file keeps a one-line pointer, so `KNOWLEDGE.md` still shows the trail without holding a second copy of the truth.
- **Read-back into the loop** (`shared/forge-items-readback.md`). `/forge-task <item-id>` resolves an item, carries its provenance into the brief, marks it `doing` and records `promoted_to`; `/forge-new-milestone` lists open items as input before the brainstorm. Without this the store would be the write-only graveyard it was built to replace.
- **Items board in the macOS app** — a sidebar screen with columns by status and an open-item count on each project card. Every read and write shells out to `forge-items.js`; Swift never reimplements store semantics, so a status transition means the same thing in both front-ends.
- **`app.default_workspace` and `app.session_root_dir`** — the composer preselects a configured project (falling back to last-used) and always renders the destination before send. `shell` and `chat`, which need no project, open in the configured root directory.

### Fixed

- **The app no longer has any implicit workspace fallback.** `b992edf` removed `workspaces.first` from the composer because it dispatched into whichever repo sorted first — a wrong-repo `/forge-auto` that looks exactly like a correct one. Two more copies survived in `LauncherSheet` and one in `launch(account:)`. All three are gone, and `scripts/forge-app-workspace.test.js` is a standing, platform-independent guard that fails if any of them returns.
- **The app could not update itself.** `UpdateStore.runUpdate()` shelled out to `install.sh --update`, but the Swift build is gated behind `--with-app` — so the button refreshed every agent, skill, script and hook, reported success, and left the one binary the operator was looking at on the old version. It now passes `--with-app`, and because replacing a bundle does not replace the running process, the card offers "Reabrir na nova versão" instead of letting a stale window look current. `scripts/forge-app-update.test.js` guards both, and asserts the `--with-app` gate in `install.sh` still exists so the first assertion cannot quietly become vacuous.
- **`install.sh` was not executable in the repository** (mode `100644`), so `./install.sh` — the command the README gives — failed on a fresh clone.

### Notes

Every slice went through the dialectic review with an external challenger (Codex, deliberately the opposite model family from the author). Thirteen objections: ten conceded and fixed, three withdrawn after the author's defense, none left open. The ones worth knowing about were an undefined `$PICKED_IDS` that would have made item absorption silently inert, `app.*` preferences resolving from the project layer despite the schema promising global-only, and an unguarded async load that could show one project's items under another's name.

---

## v3.0.0-beta — Gate protocol and the macOS app

Two things that only make sense together: a way for an autonomous run to ask a
question, and somewhere to answer it.

### Added

- **Gate protocol** (`scripts/forge-gate.js`). `AskUserQuestion` is not served to headless sessions — verified: the tool is absent from the `system/init` list — so `/forge-auto` could have autonomy or interactive gates, never both. Gates travel as files under `.gsd/forge/gates/`, the same shape Forge already uses for `pause` and `handoff-request`. Every gate carries a timeout and a declared default, so nobody answering resolves to the safe option instead of blocking forever.
- **`review.ask_in_auto: gate`** — a third posture beside `defer` and `pause`. Asks without pausing: a timeout resolves as deferred so the milestone-final triage still surfaces it, and the artefact records whether a human or the clock decided. Opt-in; `defer` remains the default.
- **macOS app** (`app/`, built by `./install.sh --with-app`). A second front-end over the same `.gsd/` files — the terminal stays first-class. Answer gates, watch runs with progress and next action, manage accounts by real headroom, edit preferences generated from the schema, read release notes, and see what the runs cost. Includes a real embedded terminal (SwiftTerm), so work starts in the app rather than being delegated to Terminal.app.
- **Secrets vault** (`scripts/forge-secrets.js`). Tokens for external CLIs in the Keychain, injected into the child process by `forge-secrets exec` and nowhere else. Several entries per service (`railway/producao`, `railway/staging`), with ambiguity treated as an error rather than a guess. There is deliberately no command that prints a secret.
- **Metrics** from `.gsd/forge/events.jsonl`, which the orchestrator has been writing since M002 and nothing was reading: spend and tokens by model, engine, phase and domain.
- **Swift test suite** (`swift run ForgeKitTests`, wired into `node scripts/run-tests.js`).

### Changed

- MCP credentials move to the vault. The Figma key was plaintext in `~/.claude.json` and passed as a command-line flag; it is now in the Keychain and injected at launch. `shared/forge-mcps.md` documents the pattern and the checks that decide whether a server can be converted at all.
- `forge-accounts --list --json` also emits `email`, `account_uuid` and `email_source` (additive; the token is still only available via `--token`).

### Fixed

- **Every `bin/` wrapper read the retired markdown preferences file.** After the move to JSONC, `forge-run`, `forge-accounts` and `forge-status` could no longer resolve `repo_path`, so the repo fallback was dead in all of them.
- Preference editing could corrupt list-shaped values: nine knobs are arrays or objects and fell through to a text field that wrote them back as a single string.

### Beta caveats

- The app is ad-hoc signed. macOS therefore refuses it as a notification source — gate alerts fall back to a plain banner without action buttons — and re-asks for Keychain authorisation on every add or verify. A Developer ID resolves both; nothing else in the app depends on it.
- Windows and Linux are unaffected: the app is macOS-only and `install.sh` builds it only with `--with-app`.

---

## v2.5.0 — Cost-aware dispatch and native Claude Code runtime controls

### Added

- Deterministic, bounded Claude prompts materialized from versioned dispatch templates, with selective memory and coding-standard budgets.
- Adaptive policy for durable-memory extraction and review depth (`skip`, `flags`, `dialectic`), with conservative high-risk defaults.
- Per-call telemetry (`dispatch_id`, `prompt_id`, attempt, status and token estimates) and a cross-platform standalone test runner.
- Bounded Claude subagents, `SubagentStop` result-contract enforcement and optional experimental agent-team resumption.

### Changed

- Sidecar file changes are Git-derived and authoritative; model-declared paths are advisory only.
- Installers deploy and back up dispatch templates. The preference schema adds cost-policy controls.

### Fixed

- **The smoke suite spent real money on Windows.** The mock `codex` was a `#!/bin/sh`
  file, which `CreateProcess` cannot execute, so `resolveCodexCommand()` fell through
  to whatever `codex` was on `PATH` — a real, billable one. `forge-xllm.js` now honors
  `FORGE_XLLM_CODEX_BIN` (mirroring `FORGE_XLLM_AGY_BIN`), and the suite injects a Node
  shim that runs the same POSIX fixture through Git's own `sh.exe`, resolved from
  `git --exec-path` with its `usr/bin` prepended to the child's `PATH` so `cat`,
  `printf` and `sleep` resolve outside Git Bash. Bare `sh` was not enough: PowerShell
  has none on `PATH`, and bare `bash` there is WSL's — a different filesystem view.
- **Phantom drift reported against correct documents.** Repo docs are matched with
  LF-anchored regexes and `indexOf` anchors, but `core.autocrlf=true` with no
  `.gitattributes` delivers CRLF on a Windows checkout, so every anchor missed and the
  assert blamed the document. Repo text is now normalized on read.
- **Silent data loss in per-milestone STATE files.** `forge-state.js` parsed a `##` section
  down to its first line only, so every write path (`--update`, `--push-recent`) reserialized
  the file with the rest of `## Recent units (last 10)` and `## Notes` erased — exit 0, no
  warning. Installed copies have been dropping unit history since the per-milestone STATE
  format shipped; the loss is only visible by re-reading the `.md`. The truncated history
  cannot be recovered, but no further lines are lost after this fix.

### Documentation

- Added `docs/cost-optimization.md`, including Claude Code commands that complement the Forge workflow.

---

## v2.0.0 (2026-07-20) — Corte do md-legacy de prefs: JSONC-only

### BREAKING

Preferências em Markdown não são mais lidas. O engine (`forge-prefs.js`) dá
hard-stop estruturado `legacy-md-without-jsonc` quando uma camada contém
Markdown sem o catálogo JSONC correspondente; o template
`forge-agent-prefs.md` também foi removido do repositório.

O comando de migração é o da mensagem canônica em
`shared/forge-prefs-cutover.md § Canonical message` — use exatamente a
fórmula `node "{command}" --cwd "{cwd}"` (com `{command}` substituído pelo
caminho de `forge-prefs-migrate.js` e `{cwd}` pelo workspace). O migrator
converte as camadas global e local e sempre preserva o original em `.bak`.

O caminho de upgrade comum, sem susto, é rodar `install.sh --update` ou
`/forge-update`, que auto-migra a camada global, e `forge-doctor --fix`, que
migra a camada local. O hard-stop é um backstop e o usuário típico não o vê.
Em workspace já-jsonc não há mudança observável: os bytes permanecem
idênticos.

### Changed

- Chokepoints de instalação e `/forge-update` agora auto-migram antes de
  entregar o controle aos consumidores.
- `forge-doctor --fix` migra a camada local e reporta a mesma mensagem
  canônica quando a correção não pode ser aplicada.
- O reader legado real foi realocado para o migrator; engine e skills não
  emitem mais warnings de depreciação mortos.
- A documentação foi varrida para manter grep-zero de fontes Markdown
  legadas e para remover descrições de dual-read.

### Removed

- Template `forge-agent-prefs.md` do repositório.
- Warnings de depreciação sem efeito no engine e nas skills.
- Leitura Markdown no engine; a compatibilidade fica restrita à migração.

### Notes

- A entrada canônica e o contrato de erro permanecem em
  `shared/forge-prefs-cutover.md`; consumidores não devem improvisar outra
  mensagem ou outro código.
- A migração é segura para reexecução: o JSONC validado fica ativo e o
  backup `.bak` conserva o Markdown de origem.

## v1.35.0 (2026-06-15) — Multi-conta redesenhado: default vs launch, display por identidade, resume run-aware, cross-platform

Revisão estrutural do multi-conta. Tudo backward-compatible (single-account e fluxos `use`/`forge-run` existentes seguem iguais).

### Added

- **`claude` puro entra na conta default automaticamente** via `forge-accounts shell-init` (zsh/bash) e `--shell-init-pwsh` (PowerShell `$PROFILE`). Instaladores adicionam o hook ao rc/`$PROFILE` de forma idempotente (`install.sh` já; `install.ps1` agora).
- **Modelo default vs launch:** `forge-accounts default <nome>` (seta default sem lançar), `launch <nome>` (lança sem mudar o default) e **`claude --account <nome>`** (fixa um terminal) — habilita **N terminais em N contas ao mesmo tempo**.
- **Display por identidade real:** sem `FORGE_ACCOUNT`, a statusline lê `~/.claude.json` e casa uuid/email contra o registro → `👤 <nome>` mesmo em login manual do Keychain (cache por mtime; render normal = 2 `stat()`). Identidade gravada via `forge-accounts set-email <nome>` (sem `--email` captura a sessão atual).
- **`forge-accounts launch-prep`** (resolve conta+token numa chamada) e **normalizador de subcomando** no engine (permite `forge-accounts <sub>` sem tradução em batch — base do wrapper Windows `bin/forge-accounts.cmd`).
- **New-window cross-platform:** macOS (osascript), Linux (gnome-terminal/x-terminal-emulator/konsole/xterm), Windows (`.cmd` + `wt.exe`).

### Changed

- **Resume run-aware:** trocar de conta / abrir nova janela só retoma `/forge-auto <RUN_ID>` quando existe **exatamente um** run ativo no projeto (0 ou 2+ → sessão `claude` normal). Antes forçava `/forge-auto` sempre que havia `.gsd/`.
- **Run record** ganha campo `account` (additivo), gravado pelo orquestrador (`--account "${FORGE_ACCOUNT:-}"`).

### Notes

- Captura automática de identidade por-render foi deliberadamente **removida** (uma sessão lançada por token nem sempre reescreve `~/.claude.json` → risco de gravar a conta errada). Captura é sempre explícita via `set-email`.
- Regression guards na Section 16 do `forge-smoke.js` (164/164). Windows é best-effort (validado por revisão; sem `pwsh` no ambiente de dev).

---

## v1.36.0 (2026-06-15) — forge-sweep model-invocable at end of cycle

### Changed

- **`forge-sweep` is now model-invocable (`skills/forge-sweep/SKILL.md`):** removed `disable-model-invocation: true`. The orchestrator can now run the sweep directly via the `Skill` tool at the **end of a milestone/task, once the human has validated the delivered work** — no need for the user to type `/forge-sweep` and no magic confirmation phrase (the positive validation feedback in the conversation is the go-ahead). A new **`## Invocation policy`** section codifies exactly when auto-invocation is allowed and forbidden.
- **Single confirmation gate — the "re-type with `--apply`" step is eliminated for the end-of-cycle flow:** the recommended path invokes the skill with `--apply` from the start. Step 3 still prints the full preview before any write, and the Step 5 `AskUserQuestion` popup fires as the single final reminder (one yes/no, so a distracted dev isn't surprised). Bare `/forge-sweep` (no args) remains a safe preview-on-demand for anyone.
- **Risk-aware fallback:** the orchestrator must NOT auto-apply — it falls back to a dry-run + explicit user authorization — when the preview surfaces a specific risk: an AUTO-MEMORY entry flagged `review`, a milestone/task dir skipped for a missing `LEDGER.md` entry, an active milestone phase in `STATE.md`, or a dirty working tree that makes the trim hard to review.

### Why

The previous `disable-model-invocation: true` flag (added in v1.16.0 because the sweep is destructive) forced the user to type `/forge-sweep --apply` explicitly even after work was already validated and the orchestrator had announced the sweep as the next step. The destructiveness is now guarded by the conversational human-validation gate + the in-skill confirmation popup + risk-aware fallback, rather than by blocking model invocation entirely.

---

## v1.16.0 (2026-05-22) — forge-sweep skill

New maintenance skill, promoted from a project-local draft used in production (WDMA / custody-transfer).

### Added

- **`forge-sweep` skill (`skills/forge-sweep/SKILL.md`):** prunes ephemeral GSD know-how files per a single-source-of-truth team policy — drops low-value `AUTO-MEMORY` entries (keeps `confidence >= 0.90 AND hits >= 2 AND` cross-cutting), drops `DECISIONS` rows that aren't architectural invariants, trims completed milestone/task directories **in place** (keeps only `*-SUMMARY.md`, requires a matching `LEDGER.md` entry as a safety gate), and removes closed `ask-*` sessions. Default run is a **dry-run preview**; `--apply` executes after an `AskUserQuestion` confirmation (`--force` skips it). `--scope task|milestone` narrows the sweep. `disable-model-invocation: true` — destructive, so never auto-invoked. Picked up automatically by both installers (skill-directory auto-discovery — no `install.sh`/`install.ps1` change needed). Goal: keep shared `.gsd/` files lean and merge-conflict-free for teams on SVN/Git.

### Docs

- `forge-help` and `README.md` skill tables now list `forge-sweep` under maintenance skills.

---

## v1.14.0 (2026-05-21) — M005 Multi-Run Cleanup

Polish + correctness fixes for issues discovered during the first real multi-run in production (M067 + M068 simultaneous in WHATSAPP OMNICHANNEL WORKSPACE). All changes are 100% additive — no breaking changes for single-run workspaces.

### Fixes

- **Heartbeat decoupling (S01):** orchestrator no longer writes `.gsd/forge/auto-mode.json` directly. All 9 heartbeat/deactivate sites in `skills/forge-auto/SKILL.md` now branch on `$RUN_ID`: multi-run uses `forge-runs.js --update` (which auto-refreshes the legacy alias via `refreshLegacyAlias`), legacy preserves direct `auto-mode.json` write. Eliminates race condition between concurrent tabs that caused worker/started_at fields to flip-flop.
- **`auto-mode-started.txt` per-run (S01):** removed shared `.gsd/forge/auto-mode-started.txt` write from the multi-run path. Each run's `started_at` lives in `runs/{id}.json` (set by `forge-runs.add` at activation). Legacy single-run still writes the shared file for backward compat. Fixes "AUTO 9m51s" showing M068's age when tab A was running M067 for 5h.
- **Stale auto-resume cleanup (S01):** `stale` branch of activation now loops `runs/*.json` and marks each `active:false` before fallback `auto-mode.json` cleanup. Prevents orphan runs in registry after Ctrl+C / OOM.
- **`{M###}` → `${RUN_ID:-{M###}}` sweep (S02):** 7 event-write sites in plan-check / checkpoint / housekeeping bash blocks now use `${RUN_ID:-{M###}}` for the milestone field. Resolves to `$RUN_ID` in multi-run, falls through to Claude's template substitution in legacy. Eliminates milestone field drift in `events.jsonl`.
- **Dashboard phase cross-reference (S03):** `scripts/forge-dashboard.js` reads `M###-STATE.md` via `forge-state.read` to show real phase + active_slice + active_task. Before always rendered `phase: —` (runs/{id}.json schema has no phase field). New output: `phase: execute-task · slice: S07 · task: T01 · worker: T01`.
- **Smart stale heuristic (S03):** `scripts/forge-statusline.js` and dashboard now compute effective heartbeat as `min(runs.last_heartbeat, mtime(M###-events.jsonl), mtime(M###-STATE.md))`. Runs with stale `runs/{id}.json` but fresh per-milestone artifacts (e.g. session_id mismatch pre-v1.13.3) are NOT filtered out of `isMultiRunMode`. Cobre cosmetic falla onde 2 runs ativas mas só uma aparecia na statusline.
- **complete-milestone deactivates run (S04):** `agents/forge-completer.md` step 7 (new) calls `forge-runs.js --update --json '{"active":false,"deactivated_reason":"complete-milestone"}'` after cleanup, then regenerates dashboard. Without this, completed milestones stayed `active:true` in registry indefinitely — dashboard kept listing them, counting toward `multi_run.refused_when_active_count` threshold.

### Added

- **`scripts/forge-smoke.js`:** end-to-end smoke test suite covering 8 sections (runs CRUD, lock, state migration, dashboard cross-ref, merger, file-lock cross-run, repos auto-detect, cli-helpers refuse). 47 assertions, runs in ~3.5s. `node scripts/forge-smoke.js` exits 0/1 — use as pre-release sanity check.

### Architecture (M005 decisions D-M005-1..12 — see .gsd/milestones/M005/M005-CONTEXT.md)

- D-M005-1 — Heartbeat orchestrator writes runs/{id}.json via forge-runs.bumpHeartbeat
- D-M005-2 — auto-mode-started.txt removed from multi-run path; runs/{id}.json.started_at is truth
- D-M005-3 — Dashboard cross-references M###-STATE.md for phase + slice + task
- D-M005-4 — Statusline stale threshold considers multiple heartbeat sources
- D-M005-5 — `{M###}` → `${RUN_ID:-{M###}}` sweep in remaining bash blocks
- D-M005-6 — complete-milestone deactivates runs/{id}.json + regens dashboard
- D-M005-7 — Smoke test automated in scripts/forge-smoke.js
- D-M005-8 — Soft pre-claim cross-run [DEFERRED to M006]
- D-M005-9 — auto-mode.json mantido como alias-only (no direct writes)
- D-M005-10 — compact-signal cleanup [DEFERRED — low priority]
- D-M005-11 — Smart stale heuristic in statusline (combinado com D-M005-4)
- D-M005-12 — No M005-SHADOW-STATE; standard worktree workflow

## v1.13.3 (2026-05-20) — M004 hotfix bootstrap M###-STATE.md

- fix: bootstrap M###-STATE.md on activate-new + re-load STATE post-activation (a04ed8a)

## v1.13.2 (2026-05-20) — M004 hotfix resume + statusline

- fix: resume updates session_id + statusline parses dashboard format (69f7d47)

## v1.13.1 (2026-05-20) — M004 hotfix migrate-legacy

- fix: migrate legacy STATE.md BEFORE dashboard regen in activation (caf94f2)

## v1.1.0 (2026-05-20) — M004 Multi-Run Workspace

### Breaking Changes

- `.gsd/STATE.md` raiz vira **dashboard read-only auto-gerado** (Multi-run mode). Single-run workspaces continuam funcionando via migração lazy ao primeiro boot multi-run — sem ação manual necessária.
- Workers (forge-executor, forge-discusser, forge-completer, forge-memory) escrevem decisões/memórias/eventos em arquivos **per-milestone** (`M###-DECISIONS.md`, `M###-AUTO-MEMORY.md`, `M###-events.jsonl`, `M###-CHECKER-MEMORY.md`) durante a run. Globais são merged em `complete-milestone` via `forge-merger.js` sob lockfile.

### Features

- feat: **Per-milestone state + runs registry** (S01) — `M###-STATE.md` substitui STATE.md raiz como source-of-truth de cada run. `.gsd/forge/runs/{id}.json` registra todas as runs ativas (kind: milestone | task).
- feat: **Hooks session-aware** (S02) — `forge-hook.js` resolve a run dona via `data.session_id` em todos os 6 phases. Evidence path scoped por run_id.
- feat: **Pause + compact-signal per-run** (S03) — `.gsd/forge/pause-{run_id}` e `compact-signal-{sessionId}.json` substituem globais. `/forge-pause M065` toggla scoped.
- feat: **Global merge sob lockfile** (S05) — `scripts/forge-merger.js` promove per-milestone files pros globais (DECISIONS, AUTO-MEMORY com cap-50 decay, LEDGER, CHECKER-MEMORY, events.jsonl) sob `mkdir`-mutex via `scripts/forge-lock.js`. Validado com 2 mergers concorrentes em NTFS sem corruption.
- feat: **CLI multi-run** (S06) — `/forge-auto <ID>`, `/forge-next <ID>`, `/forge-task <descrição>` aceitam ID args. Sem arg + 0 ativas = legacy fallback; 1 ativa = assume retomar; 2+ ativas = refuse + lista IDs.
- feat: **File-locks modo shared** (S07) — `scripts/forge-filelock.js` + `forge-hook.js` PreToolUse bloqueia Write/Edit cross-run quando outra run ativa segura o arquivo. Steal-on-inactive + steal-on-expired (TTL 60s). Orquestrador retenta 3× com backoff 5-30s jitter via `forge-classify-error.js` novo class `cross_run_file_lock`.
- feat: **Isolation modes** (S08) — `forge_isolation.mode: shared | branch | worktree` configurável em prefs. `scripts/forge-repos.js` auto-detect multi-repo via walk de subdirs `.git/`. `scripts/forge-isolation.js` setup/cleanup pra branch (`forge/{M###}`) e worktree (`.forge-worktrees/{M###}/{repo}/`).
- feat: **Statusline multi-run** (S09) — `forge-statusline.js` scaneia `runs/*.json`. 1 run = visual rico legado. 2-3 runs = compacto `● AUTO ×2 │ M065 ⚡T03 +12s │ M066 🔥S04 +1m`. 4+ trunca com `+N mais`.
- feat: **Docs** (S10) — `docs/multi-run.md` cobre 3 modes, locks, registry, CLI, troubleshooting. `forge-agent-prefs.md` ganha bloco `forge_isolation:` + `multi_run:` + `parallelism.cross_run_overlap:` scaffolded.

### Architecture (M004 decisions D-M004-1..12 — see .gsd/milestones/M004/M004-CONTEXT.md)

- STATE.md raiz dashboard regenerável; per-milestone state em M###-STATE.md
- Runs registry indexado por ID, kind=milestone | task
- Per-milestone artifacts → globals via merger sob lockfile no complete-milestone
- File-locks only em shared mode; defesa-em-profundidade em branch; auto-disabled em worktree
- Conflict de lock → retry 3× com jitter 5-30s
- forge_isolation.mode default = shared (zero quebra retroativa)
- Multi-repo auto-detect via walk de .git
- CLI exige ID quando 2+ ativas
- Hooks resolvem run via session_id
- Statusline linha compacta multi-run; trunca em 4+
- forge-memory promove per-milestone → global no merger
- auto-mode.json mantido como alias do oldest active (compat)

### Scripts added

- `scripts/forge-runs.js` — registry CRUD
- `scripts/forge-state.js` — per-milestone STATE read/write + legacy compat
- `scripts/forge-lock.js` — mkdir-mutex helper
- `scripts/forge-dashboard.js` — regen STATE.md raiz
- `scripts/forge-merger.js` — per-milestone → global promotion
- `scripts/forge-cli-helpers.js` — resolveRunFromArgs, refuse logic, newTaskId
- `scripts/forge-filelock.js` — cross-run file ownership tracking
- `scripts/forge-repos.js` — auto-detect git repos via walk
- `scripts/forge-isolation.js` — setup/cleanup branch + worktree modes

All 9 scripts auto-installed via existing `install.sh` / `install.ps1` globs — no installer changes needed.

## v1.0.0 (2026-04-15)

### Breaking Changes

- `/forge` replaces `/forge-auto` as the primary entry point; existing `/forge-auto` invocations continue to work via a thin shim
- `forge-auto`, `forge-task`, and `forge-new-milestone` commands migrated to skills (`skills/forge-auto/`, `skills/forge-task/`, `skills/forge-new-milestone/`); the original command files are now 6–7-line shims that delegate to `Skill()`

### Features

- feat: PostCompact hook recovery — `forge-hook.js` writes `.gsd/forge/compact-signal.json` when Claude Code fires the PostCompact lifecycle event while forge-auto is active; orchestrator detects the signal on the next loop iteration, re-initializes all in-memory state from disk, deletes the signal, and continues transparently
- feat: lean orchestrator — all 24 `{content of …}` artifact-inlining placeholders in `shared/forge-dispatch.md` replaced with `Read:` / `Read if exists:` path directives; workers resolve their own context in their isolated context window, cutting per-unit token growth from ~10–50K down to ~500 tokens
- feat: `/forge` REPL shell — new `commands/forge.md` (126 lines, < 5K tokens) is a compact-safe router with bootstrap guard, auto-resume detection, and an `AskUserQuestion` dispatch loop covering forge-auto, forge-task, forge-new-milestone, forge-status, and forge-help
- feat: skill migration with `disable-model-invocation: true` — three heavyweight commands converted to skills, shrinking command footprint from ~950 lines to ~20 lines of shims while preserving all logic in isolated skill contexts

### Architecture

- compact-signal.json recovery flow: PostCompact hook (forge-hook.js) → disk signal (`.gsd/forge/compact-signal.json`) → orchestrator reads/deletes on next iteration → transparent resume; existing COMPACTION RESILIENCE behavioral rule kept as fallback for Claude Code versions without PostCompact support
- workers read own artifacts: orchestrator passes paths, not content; workers call `Read` tool inside their isolated context — eliminates token accumulation across dispatch loop iterations
- `/forge` compact-safe token budget: REPL shell stays well within < 5K token re-attachment budget; compact recovery check runs at the top of every loop iteration

## v0.7.3 (2026-04-10)

### Features

- feat: add /forge-task command — autonomous task without milestone/slice hierarchy. Flow: brainstorm → discuss → research → plan → execute. Supports --skip-brainstorm, --skip-research, --resume TASK-###. Tasks live in .gsd/tasks/TASK-###/. forge-status and forge-explain updated.

## v0.7.2 (2026-04-10)

### Features

- feat: distribute decisions by phase — workers inject CONTEXT.md decisions instead of global DECISIONS.md; DECISIONS.md becomes audit overview for /forge-explain decisions

## v0.7.1 (2026-04-10)

### Performance

- perf: reduce context injection in worker prompts — DECISIONS.md capped at last 20 rows in plan-slice/plan-milestone/discuss (was full file), AUTO-MEMORY capped at 40 lines (was 80), T##/S##-SUMMARY injection capped at 35 lines each

## v0.7.0 (2026-04-09)

### Features

- feat: integrate skills via Skill tool — brainstorm/scope/risk-radar composable in workflow (837d746)
- feat: effort/thinking per phase, WebSearch in researcher, SubagentStart/Stop + PreCompact hooks (2b9d3b0)
- feat: AskUserQuestion + PlanMode in discusser, TaskList/TaskStop in orchestrators (9d0a79f)

### Other Changes

- Merge branch 'master' of https://github.com/vh2224/forge-agent (9c1fb90)


## v0.6.1 (2026-04-09)

### Bug Fixes

- fix: add UTF-8 BOM to install.ps1 to fix PowerShell 5.x parse errors (9402028)


## v0.6.0 (2026-04-09)

### Features

- feat: auto-mode indicator with blink, timer and stale detection (3c584e9)
- feat: show auto-mode indicator with elapsed time in status line (c28ce56)


## v0.5.0 (2026-04-09)

### Features

- feat: add auto_commit preference — let users opt out of git management (c773c4c)
- feat: add visual timeline to forge-auto and forge-next via TaskCreate (0b907c2)


## v0.4.0 (2026-04-09)

### Features

- feat: filter internal commits from /forge-update release notes (4920422)
- feat: show release notes on /forge-update and rename GSD Agent → Forge Agent (38746a1)

### Bug Fixes

- fix: emit next action hint after forge-next completes a unit (ba43da0)
- fix: add explicit autonomy rule to forge-auto to prevent pausing between units (18f1a5e)
- fix: repair install.ps1 form feed chars and clean up legacy gsd-* agents (da6453d)

### Other Changes

- refactor: unify forge-doctor + forge-fix into single command with --fix flag (5fe50d3)


## v0.3.0 (2026-04-09)

### Features

- feat: add /forge-fix — auto-correction for GSD project structure (90c6600)


# Changelog

## v0.2.0 (2026-04-09)

### Features

- feat: add CHANGELOG.md generation to release workflow (bfbba43)

