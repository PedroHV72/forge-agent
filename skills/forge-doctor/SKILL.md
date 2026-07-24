---
name: forge-doctor
description: "Diagnostico e correcao do projeto GSD. Flags: --fix, --dry-run."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob
---

## Modes
- (no flags) → diagnose only, no writes
- `--fix` → diagnose + fix
- `--fix --dry-run` → show what --fix would do, no writes

FIX_MODE = `--fix` in $ARGUMENTS. DRY_RUN = `--dry-run` in $ARGUMENTS.

## Convention
Each check produces findings. In fix mode, apply the fix. In diagnose/dry-run, only report.
Emit one line per finding: `✓/⚠/✗/🔧/👁/⏭  <message>`.

---

## Pre-flight

Run in parallel:
```bash
ls CLAUDE.md .gsd/STATE.md .gsd/PROJECT.md .gsd/DECISIONS.md .gsd/AUTO-MEMORY.md .gsd/CODING-STANDARDS.md 2>/dev/null
```
Read in parallel: `.gsd/STATE.md`, `.gsd/PROJECT.md`, `~/.claude/forge-agent-prefs.md`, `.gsd/claude-agent-prefs.md`.

STATE missing → `Projeto não inicializado. Execute /forge-init.` and stop.

Extract from STATE: M=ActiveMilestone, S=ActiveSlice, T=ActiveTask, P=Phase.

---

## C1: STATE coherence

**C1a** — If M≠none and `.gsd/milestones/M/` missing:
```bash
# M* matches both M### (legacy) and M-<ts>-<slug> (timestamp); sort -V orders timestamp IDs — format-agnostic
ls -d .gsd/milestones/M*/ 2>/dev/null | sort -V | tail -1
```
Fix: set M to last existing (or `none`), S/T=none, P=idle. Edit STATE.

**C1b** — If S≠none and `.gsd/milestones/M/slices/S/` missing:
Fix: read ROADMAP → first `[ ]` slice → set S to it, T=none. If no ROADMAP or no unstarted slice → S=none, P=plan-milestone. Edit STATE.

**C1c** — If T≠none and `tasks/T-PLAN.md` missing in active slice:
Fix: read S-PLAN.md → first task without `status: DONE` in frontmatter → set T to it, P=execute. If none → T=none, P=complete-slice. Edit STATE.

**C1d** — Phase inconsistency (apply first match only):

| Condition | Fix |
|-----------|-----|
| P=resume, no continue.md in active slice | P=execute |
| P=execute, T=none | P=plan-slice (idle if M=none) |
| P=plan-slice, S-PLAN.md exists | P=execute |
| P=complete-slice, slice has pending tasks | P=execute |
| P=plan-milestone, ROADMAP exists | P=plan-slice |
| P≠idle, M=none | P=idle |

---

## C2: Checkbox sync

Scope: ALL slices under active milestone.
```bash
ls -d .gsd/milestones/M/slices/S*/ 2>/dev/null
```

**C2a — Task checkboxes** (per slice, read S-PLAN.md + each T-PLAN.md frontmatter):

| S-PLAN `[ ]`/`[x]` | T-PLAN status | SUMMARY | Action |
|---|---|---|---|
| `[ ]` | DONE | yes | mark `[x]` |
| `[ ]` | DONE | no | mark `[x]` + create SUMMARY stub |
| `[x]` | ≠DONE or missing | — | unmark to `[ ]` |
| `[x]` | DONE | no | create SUMMARY stub |
| `[x]` | DONE | yes | OK |
| `[ ]` | ≠DONE | — | OK |

**C2b — Slice checkboxes** (read ROADMAP, skip if missing):
A slice is done when all its tasks are `[x]` after C2a.

| ROADMAP `[ ]`/`[x]` | All tasks done | SUMMARY | Action |
|---|---|---|---|
| `[ ]` | yes | yes | mark `[x]` |
| `[ ]` | yes | no | mark `[x]` + create SUMMARY stub |
| `[x]` | no | — | unmark to `[ ]` |
| `[x]` | yes | no | create SUMMARY stub |
| `[x]` | yes | yes | OK |
| `[ ]` | no | — | OK |

**Stub formats** (fill M/S/T from context, ISO8601 timestamp for completed_at):

T-SUMMARY stub:
```
---
id: T  parent: S  milestone: M
verification_result: unknown  recovered_by: forge-doctor  completed_at: NOW
---
(verificar via git log)
```

S-SUMMARY stub:
```
---
id: S  milestone: M  status: done  recovered_by: forge-doctor
---
Detalhes nos T-SUMMARY individuais.
```

---

## C3: Stuck tasks (active slice only)

**C3a** — Files with `status: RUNNING`:
```bash
grep -l "status: RUNNING" .gsd/milestones/M/slices/S/tasks/T*-PLAN.md 2>/dev/null
```
Fix: remove `status: RUNNING` line from each.

**C3b** — T-PLAN.md missing required sections (`## Goal`, `## Must-Haves`, `## Steps`, `## Standards`):
Fix: append each missing section as `## Name\n(pendente)`.

---

## C4: Orphan continue.md

```bash
find .gsd/milestones -name "continue.md" 2>/dev/null
```

For each, extract its slice from the path. `active` = belongs to current S.

| P=resume | active | has `## Remaining Work` | Action |
|---|---|---|---|
| yes | yes | yes | OK |
| yes | no | — | delete |
| no | yes | yes | set P=resume in STATE |
| no | yes | no | delete |
| no | no | — | delete |

Also: if active task has `status: DONE` and continue.md exists in that slice → delete.

---

## C5: Prefs

Valid IDs: `claude-opus-5`, `claude-opus-4-8[1m]` (fallback), `claude-sonnet-5`, `claude-haiku-4-5-20251001`
Aliases: opus→opus-5 (fallback opus-4-8[1m]), sonnet→sonnet-5, haiku→haiku-4-5-20251001 (expand to full ID on fix)

Defaults: discuss/research/plan phases → opus-5 (fallback opus-4-8[1m]) | execute/complete → sonnet-5 | memory → haiku-4-5-20251001

Check both prefs files (already loaded). For each routing table row: alias → expand; invalid ID → replace with default.

---

## C5a: Prefs legadas remanescentes

Resolve the same source-of-truth view with provenance before reporting legacy
files. The full prefs check (C5a legacy listing, C5b parse-error flag, C5c
invalid values, C5d stale catalog) is complete as of S06.

```bash
PREFS_ENGINE="$([ -f scripts/forge-prefs.js ] && echo scripts/forge-prefs.js || echo "$HOME/.claude/scripts/forge-prefs.js")"
SCAFFOLD_ENGINE="$([ -f scripts/forge-prefs-scaffold.js ] && echo scripts/forge-prefs-scaffold.js || echo "$HOME/.claude/scripts/forge-prefs-scaffold.js")"
MIGRATE_ENGINE="$([ -f scripts/forge-prefs-migrate.js ] && echo scripts/forge-prefs-migrate.js || echo "$HOME/.claude/scripts/forge-prefs-migrate.js")"
PREFS_EXPLAIN=$(node "$PREFS_ENGINE" --resolved --explain --cwd . 2>/dev/null)
printf '%s' "$PREFS_EXPLAIN"
```

Inspect `layers.global` and `layers.local` in that existing resolved result:

- If `source: "md-blocked"`, list each `files[]` entry as
  `⚠ Prefs markdown legada bloqueia a camada <global|local>: <arquivo>` and
  show the migration command:
  `Migração: node <scripts>/forge-prefs-migrate.js --cwd .`.
  The blocked markdown layer is not used as a source of preferences. For a
  global layer, report the block and instruct the user to run the migration
  chokepoint (`/forge-update`); the doctor never migrates the global layer.
- In `--fix`, when `layers.local.source` is `md-blocked`, run
  `node "$MIGRATE_ENGINE" --local-only --cwd .`. The migrator always preserves
  the source markdown as `.bak`. On success, report:
  `🔧 Camada local migrada para JSONC (.bak preservado).`
  If the migrator refuses the migration or exits non-zero (including a custom
  key refusal), do not abort the doctor. Report:
  `⏭ Migração local recusada — rode manualmente: node <scripts>/forge-prefs-migrate.js --local-only --cwd .`.
- In diagnose mode (without `--fix`), do not invoke the migrator or write any
  file: only report each blocked layer and its migration command. The same
  no-write behavior applies to `--fix --dry-run`.
- If `source: "jsonc"` and the layer's legacy markdown file is present, list it
  as `⏭ Prefs legada shadowed (inerte, seguro deletar): <arquivo>`. JSONC wins;
  the markdown file is not read and is safe to remove after review.
- If both layers are `jsonc` or `absent` and no shadowed markdown is present,
  report `✓ Nenhuma prefs markdown legada remanescente.`

Do not alter the global catalog as part of this check, even in `--fix` mode.
The local catalog may be migrated only through the `--local-only` command above;
all other catalog writes and semantic changes remain owned by the migration
gate.

---

## C5b: Flag de erro de parse pendente

```bash
test -f .gsd/forge/prefs-error.json && cat .gsd/forge/prefs-error.json
```

If `.gsd/forge/prefs-error.json` exists, parse it (`{file, line, message}`)
and report:
`✗ Prefs com erro de parse: <file>:<line> — <message>` +
`Corrija e rode /forge-doctor de novo.`

If it does not exist: `✓ Nenhuma flag de erro de parse pendente.`

**--fix:** only delete the flag when the config now parses clean — run
```bash
PREFS_ENGINE="$([ -f scripts/forge-prefs.js ] && echo scripts/forge-prefs.js || echo "$HOME/.claude/scripts/forge-prefs.js")"
node "$PREFS_ENGINE" --resolved --cwd . >/dev/null 2>&1
```
and check exit
code 0. If it exits 0, delete the flag file and report
`🔧 Flag de erro de parse removida (config já corrigida).` If it still exits
non-zero, leave the flag untouched and report
`⏭ Flag de erro de parse mantida (config ainda inválida).`

---

## C5c: Valores inválidos

Reuse the same `$PREFS_EXPLAIN` resolved output from C5a (already ran
`--resolved --explain`). Read its top-level `warnings[]` array (from
`validatePrefs` — type/enum/unknown-key issues).

For each entry: `⚠ Valor inválido: <key> — <message>`.

If `warnings` is empty: `✓ Nenhum valor de prefs inválido.`

Never auto-fix — invalid values are semantic decisions the migration gate does
not own resolving on the user's behalf.

---

## C5d: Catálogo desatualizado

For each of `layers.global` / `layers.local` in `$PREFS_EXPLAIN` whose
`source == "jsonc"`, take `files[0]` (the catalog path) and run:

```bash
SCAFFOLD_ENGINE="$([ -f scripts/forge-prefs-scaffold.js ] && echo scripts/forge-prefs-scaffold.js || echo "$HOME/.claude/scripts/forge-prefs-scaffold.js")"
node "$SCAFFOLD_ENGINE" --diff "<catalog file>"
```

Parse the printed `{"missingSections":[...]}`. If `missingSections` is
non-empty:
`⚠ Catálogo desatualizado (<n> seções novas): <sections joined by ", ">` +
`Rode /forge-update para re-scaffold (preserva blocos ativos).`

If empty (or the layer's source is not `jsonc`, e.g. `md-blocked`/`absent`):
`✓ Catálogo <global|local> atualizado.` (skip entirely for `absent`).

Never auto-run the re-scaffold from this check — the migration gate owns
writes, even in `--fix` mode.

---

## C6: Agent files

```bash
ls ~/.claude/agents/forge-{executor,planner,researcher,discusser,completer,memory}.md 2>&1
```
Missing → Fix: `bash "$(node "$([ -f scripts/forge-prefs.js ] && echo scripts/forge-prefs.js || echo "$HOME/.claude/scripts/forge-prefs.js")" --resolved --key repo_path 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d).value;process.stdout.write(v?String(v):'')}catch{process.stdout.write('')}})")/install.sh" --update`
If repo_path unknown → `[SKIP] execute bash install.sh`.

---

## C7: Structural files

| File | Check | Fix |
|------|-------|-----|
| `.gsd/DECISIONS.md` | exists + has `\| # \| When \| Scope...` header | create or fix header (preserve data rows) |
| `.gsd/AUTO-MEMORY.md` | first line starts with `<!-- gsd-auto-memory \|` | create or prepend header |
| `.gsd/CODING-STANDARDS.md` | exists | create via forge-init auto-detection (never overwrite) |
| `<milestone-id>-ROADMAP.md` | contains `## Boundary Map` | append stub `## Boundary Map\n<!-- forge-planner preencherá -->` |
| `.gsd/forge/events.jsonl` | each non-empty line starts with `{` and ends with `}` | rewrite keeping only valid lines |

AUTO-MEMORY header:
```
<!-- gsd-auto-memory | project: NAME | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

CODING-STANDARDS detection (if creating):
```bash
ls package.json pyproject.toml Cargo.toml go.mod pom.xml .eslintrc* tsconfig.json .prettierrc* .editorconfig 2>/dev/null
ls -d src/ lib/ app/ components/ utils/ services/ tests/ __tests__/ 2>/dev/null
```
Use forge-init template to generate the file.

---

## C8: gitignore

```bash
grep -q "prefs.local.md" .gitignore 2>/dev/null || echo missing
```
Missing → append `.gsd/prefs.local.md` to `.gitignore`.

---

## Report

Header line:
- diagnose: `forge-doctor — diagnóstico`
- fix: `forge-doctor --fix — correção`
- dry-run: `forge-doctor --fix --dry-run — preview`

Icons: `✓` OK · `⚠` warn · `✗` fail · `🔧` fixed · `👁` would fix · `⏭` skipped

Footer:
- diagnose: `FAILs: N  WARNs: N  OK: N` + if any issues: `Para corrigir: /forge-doctor --fix`
- fix: `Corrigidos: N  OK: N  Skipped: N` + if all clear: `Projeto pronto para /forge-auto`
- dry-run: same as fix counts + `Nenhum arquivo alterado. Execute /forge-doctor --fix para aplicar.`

Skipped items → list with suggested command.
