---
description: "Atualiza o Forge Agent para a versão mais recente do repositório. Faz git pull e reinstala agents/commands/skills. Preserva suas preferências. Use: /forge-update | /forge-update /caminho/para/forge-agent"
allowed-tools: Read, Bash
---

## Encontrar o repositório

**Se `$ARGUMENTS` foi passado:** use esse caminho como repositório.

**Se não foi passado:**

Resolve `repo_path` through the canonical prefs engine first:
```bash
FORGE_HOME="${FORGE_HOME:-${HOME}/.forge-agent}"
PREFS_ENGINE="${FORGE_SCRIPTS_DIR:-$FORGE_HOME/scripts}/forge-prefs.js"
[ -f "$PREFS_ENGINE" ] || PREFS_ENGINE="scripts/forge-prefs.js"
REPO_PATH=$(node "$PREFS_ENGINE" --resolved --key repo_path 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d).value;process.stdout.write(v?String(v):'')}catch{process.stdout.write('')}})")
```

If `REPO_PATH` is set and non-empty → use it.

If the engine returned nothing, try a narrowly-scoped legacy fallback (discovery-only — reads
the pre-migration global md prefs directly, does not write anything): on a pre-migration install
`$FORGE_HOME/forge-agent-prefs.md` may still hold `repo_path:` while no JSONC layer exists yet, and
the canonical engine hard-stops with no repo_path in that case. This grep exists specifically so
those pre-migration users can still reach the migrator below instead of being stranded.
```bash
if [ -z "$REPO_PATH" ] && [ -f "$FORGE_HOME/forge-agent-prefs.md" ]; then
  REPO_PATH=$(grep -m1 '^repo_path:' "$FORGE_HOME/forge-agent-prefs.md" | sed 's/^repo_path:[[:space:]]*//' | tr -d '"'"'"'' | xargs)
fi
```

If `REPO_PATH` is set and non-empty this way → use it (the migration step later in this flow will
migrate this layer to JSONC).

If `repo_path` is still NOT set, try to auto-detect by checking if the current working directory is a valid forge-agent repo:

```bash
test -f "$(pwd)/install.sh" && grep -q "Forge Agent\|GSD Agent" "$(pwd)/install.sh" 2>/dev/null && echo "found" || echo "not-found"
```

If "found": use `$(pwd)` as REPO_PATH and persist it through the global JSONC
preferences layer:
```bash
node "{REPO_PATH}/scripts/forge-prefs-migrate.js" --cwd "$(pwd)" --layer global --set "repo_path=$(pwd)"
```
Tell user: `repo_path detectado automaticamente: {REPO_PATH}` and continue.

If "not-found":
```
Não foi possível encontrar o repositório do Forge Agent.

Passe o caminho como argumento:
  /forge-update /caminho/para/forge-agent

Ou rode o instalador novamente para registrar o caminho:
  bash /caminho/para/forge-agent/install.sh --update
```
Stop.

---

## Verificar que é um repositório válido

```bash
test -f "{REPO_PATH}/install.sh" && echo "valid" || echo "invalid"
test -d "{REPO_PATH}/.git" && echo "git" || echo "no-git"
```

If `invalid`: tell user the path doesn't look like a forge-agent repo and stop.

---

## Capturar versão atual (antes do pull)

```bash
cd "{REPO_PATH}" && git describe --tags --always 2>/dev/null || git log --oneline -1 2>/dev/null || echo "(sem git)"
```

Store as `OLD_VERSION`. Also capture hash:
```bash
cd "{REPO_PATH}" && git rev-parse --short HEAD 2>/dev/null
```
Store as `OLD_HASH`.

---

## Git pull (se é um repositório git)

If `.git` exists:

```bash
cd "{REPO_PATH}" && git pull 2>&1
```

- If output contains `error:` or `fatal:` → show the error and stop.
- If output contains `Already up to date.` → set `GIT_UPDATED=false`. Proceed to reinstall.
- Otherwise → set `GIT_UPDATED=true`. Proceed to reinstall.

> **IMPORTANTE**: SEMPRE prosseguir com a reinstalação, mesmo quando "Already up to date."
> O repo pode estar atualizado mas os arquivos em `$FORGE_HOME/` podem estar defasados.
> A reinstalação é idempotente e leva <2s.

If `.git` does NOT exist: skip this step and proceed with reinstall using existing files.

---

## Capturar versão nova (depois do pull)

```bash
cd "{REPO_PATH}" && git describe --tags --always 2>/dev/null || git log --oneline -1 2>/dev/null
```

Store as `NEW_VERSION`.

---

## Reinstalar agents, commands e skills

Detect OS:
```bash
uname -s 2>/dev/null || echo "windows"
```

**On Linux/macOS/Git Bash (uname returns Linux or Darwin):**
```bash
bash "{REPO_PATH}/install.sh" --update 2>&1
```

**On Windows (uname fails or returns something else):**
```bash
powershell -ExecutionPolicy Bypass -File "{REPO_PATH}/install.ps1" -Update 2>&1
```

Capture and display the installer output.

---

## Migrar prefs para JSONC

Run this immediately after reinstalling, **before any re-scaffold step that
touches a catalog**. The installed scripts are consequently current, and
re-scaffold can safely assume a JSONC catalog exists (RISK warning 5).

```bash
PREFS_MIGRATION=$(node "{REPO_PATH}/scripts/forge-prefs-migrate.js" --cwd "$(pwd)" --json 2>&1)
PREFS_MIGRATION_EXIT=$?
printf '%s\n' "$PREFS_MIGRATION"
```

The command emits a JSON result plus human diagnostics. Read the JSON result to
report each layer: `migrated`, `already-migrated`/`skipped`, or `absent`. For a
`migrated` layer, list the created `.bak` files. State that `diff: []` (the
empty old×new resolved diff) proves zero semantic change.

- **Exit 0** — migration succeeded, is already migrated, or no catalog exists.
  Report the per-layer result and continue to re-scaffold below.
- **Exit 3** — the resolved-diff gate stopped with zero writes. Print every
  `{path, old, new}` entry in a readable form, then ask the user in conversation:
  `A migração encontrou diferença semântica. Manter os .md por enquanto (padrão) ou investigar a diferença?`
  Keep the markdown files as they are by default. Do **not** re-run with any
  bypass and do not proceed to re-scaffold until the user directs the next step.
- **Exit 4** — legacy markdown could not be parsed. Show its `arquivo`, `linha`
  and old-read message, and explain that the user must correct that markdown and
  run `/forge-update` again. Leave the `.md` files intact, but note that the
  engine will hard-stop that layer until the markdown is corrected and
  re-migrated. Stop this prefs portion; do not re-scaffold an invalid source.
- **Any other non-zero exit** — surface the diagnostics and stop this prefs
  portion without touching a catalog.

### Re-scaffold dos catálogos existentes

Only after exit 0, re-scaffold **each existing** JSONC catalog. This adds newly
introduced commented sections while preserving active values and comments:

```bash
for PREFS_CATALOG in "$FORGE_HOME/forge-agent-prefs.jsonc" "$(pwd)/.gsd/forge-prefs.jsonc"; do
  if [ -f "$PREFS_CATALOG" ]; then
    node "{REPO_PATH}/scripts/forge-prefs.js" --rescaffold "$PREFS_CATALOG" --write
  else
    echo "• catálogo ausente: $PREFS_CATALOG"
  fi
done
```

For each catalog, compare the command output to its prior contents and report
the names of newly added sections (or `nenhuma seção nova`). Migration is always
first: re-scaffold presupposes JSONC and must never manufacture a catalog from a
markdown source that failed the semantic-diff or parse gate.

---

## Atualizar .claude/settings.json do projeto atual (se for projeto forge)

After reinstalling, check if the current working directory is a forge project and update its project-level settings:

```bash
test -d "$(pwd)/.gsd" && echo "forge-project" || echo "not-forge"
```

If `forge-project`:
1. Read `.claude/settings.json` in cwd if it exists (parse as JSON); otherwise start with `{}`
2. Set `permissions.defaultMode = "bypassPermissions"`
3. Preserve all other existing keys
4. Write back — create `.claude/` directory if needed

This ensures the project gets the bypass setting even without re-running `/forge-init`.

If `not-forge`: skip silently.

---

## Executar migração de fragment stores

After reinstalling, run the consolidated migration to ensure the fragment store schema is current.
The migrator is idempotent — on subsequent runs it reports `written:0` for stores already migrated.

```bash
node "{REPO_PATH}/scripts/forge-migrate.js" --cwd "$(pwd)" 2>&1
```

**Behavior and guarantees:**
- Runs three migrators in order: `LEDGER.md → ledger/`, `DECISIONS.md → decisions/`, `AUTO-MEMORY.md → memory/`.
- On a **legacy (not-yet-migrated)** repo, each monolith is renamed to `<name>.bak` **before** migration begins. If a `.bak` already exists it is preserved (never overwritten).
- On an **already-migrated** repo (`SCHEMA-VERSION` current **and** the fragment store populated), the migrator detects this and **skips** the store — it does **not** rename the monolith to `.bak`. A present monolith there is a regenerated projection cache, not a legacy file; each store reports `skipped_reason: "already-migrated"`.
- After a real migration, renders via `forge-projection` and diffs against the `.bak` — reports `identical` / `differs (numbering only)` / `differs` per store.
- Writes `.gsd/SCHEMA-VERSION` on success.
- **Idempotent:** running again reports `skipped_reason: "already-migrated"` for each store — safe to run on every update.
- **Dry-run preview:** `node scripts/forge-migrate.js --dry-run --cwd <repo>`.

If the migrator exits non-zero, surface the error output to the user:
```
⚠ Migração falhou — verifique a saída acima. Os arquivos .bak foram preservados.
```

---

## Reconciliar caches de projeção (após a migração)

After the migration, regenerate the monolithic projection caches from the fragment
stores so the post-update state has `.gsd/{LEDGER,DECISIONS,AUTO-MEMORY}.md` present
on disk (skills that read them never hit a missing cache):

```bash
node "{REPO_PATH}/scripts/forge-projection.js" --write-all --cwd "$(pwd)" 2>&1
```

**Behavior and guarantees:**
- Renders all three projections from the fragment store and writes them, byte-comparing first (no-op when already identical).
- **Data-loss guard:** refuses to overwrite a *populated* monolith from an *empty* fragment store (an unmigrated working copy). Such targets are reported as `blocked` and left untouched — this is expected and safe, not an error to surface loudly. The migration step above already populated the fragments on a genuine migration; on an already-migrated repo the store is populated, so the caches regenerate cleanly.
- Idempotent — running again writes nothing when the caches are already up to date.

If the output reports `blocked` entries, mention them briefly (the repo is in a
not-yet-migrated state and the caches are the source of truth) but do **not** fail
the update — the monoliths were preserved by design.

---

## Invalidar cache da status line

After reinstalling, bust the version cache so the status line reflects the new
version immediately instead of waiting up to 10 minutes for cache expiry:

```bash
node -e "
const fs = require('fs'), os = require('os');
const f = os.tmpdir() + '/forge-update-check.json';
try { const c = JSON.parse(fs.readFileSync(f,'utf8')); c.ts = 0; fs.writeFileSync(f, JSON.stringify(c), 'utf8'); } catch {}
" 2>/dev/null || true
```

(This sets `ts=0` in the cache, forcing a refresh on the next prompt render.)

---

## Verificar que preferences foram preservadas

```bash
PREFS_ENGINE="{REPO_PATH}/scripts/forge-prefs.js"
SAVED_REPO_PATH=$(node "$PREFS_ENGINE" --resolved --key repo_path 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d).value;process.stdout.write(v?String(v):'')}catch{process.stdout.write('')}})")
printf '%s\n' "$SAVED_REPO_PATH"
```

If repo_path is gone from resolved prefs (shouldn't happen, but just in case),
persist it through the global JSONC layer:
```bash
node "{REPO_PATH}/scripts/forge-prefs-migrate.js" --cwd "$(pwd)" --layer global --set "repo_path={REPO_PATH}"
```

---

## Gerar notas de atualização

Collect full commit messages (title + body) between old and new versions:

```bash
cd "{REPO_PATH}" && git log {OLD_HASH}..HEAD --format="===COMMIT===%n%h %s%n%b" 2>/dev/null
```

Split output by `===COMMIT===` separator. For each commit:

1. **Skip non-user-facing commits** — drop anything that does NOT affect the user's experience with `/forge-*` commands, agents, or installer:
   - `docs:`, `chore:`, `ci:` prefix → skip always
   - Title contains `[skip ci]` → skip
   - **Relevance filter:** If the commit is about CI pipelines, release workflows, changelog generation, internal tooling, GitHub Actions, or any infrastructure that the user never interacts with → skip, even if prefixed with `feat:` or `fix:`. The user doesn't need to know about internal plumbing.

2. **Classify** remaining commits by conventional commit prefix:
   - `feat:` or `feat(...):`  → **Novidades**
   - `fix:` or `fix(...):`    → **Correções**
   - `refactor:` or `refactor(...):` → **Melhorias**
   - `perf:` or `perf(...):`  → **Melhorias**

3. **Synthesize a user-facing description** from the commit body:
   - Read the full body (the paragraph after the title). It explains the WHY and WHAT in detail.
   - Write a 1-2 sentence description in Portuguese (pt-BR) that explains **what changed and why it matters to the user**. Focus on the impact, not implementation details.
   - Do NOT just repeat the commit title translated — use the body to add real context.
   - If the commit has no body (title only), use the title translated to Portuguese as fallback.
   - Strip any `Co-Authored-By` lines from the body before analyzing.

---

## Relatório final

Emit the update report in this exact format:

### If GIT_UPDATED=true (new commits pulled):

```
══════════════════════════════════════
  Forge Agent atualizado
  {OLD_VERSION} → {NEW_VERSION}
══════════════════════════════════════

─── Notas de atualização ───

{If there are entries classified as "Novidades":}
Novidades:
  - {synthesized description}
  - ...

{If there are entries classified as "Correções":}
Correções:
  - {synthesized description}
  - ...

{If there are entries classified as "Melhorias":}
Melhorias:
  - {synthesized description}
  - ...

─────────────────────────────

  ✓ Preferências preservadas
  ✓ Comandos atualizados — já ativos nesta sessão
  ✓ Fragment stores migrados (ou já atualizados)
  ⚠ Se um comando NOVO foi adicionado, reinicie o Claude Code para que apareça no autocomplete
```

### If GIT_UPDATED=false (already up to date, but reinstalled):

```
══════════════════════════════════════
  Forge Agent {NEW_VERSION}
══════════════════════════════════════
  Código já atualizado — arquivos reinstalados.

  ✓ Comandos, agents e skills sincronizados
  ✓ Preferências preservadas
  ✓ Fragment stores migrados (ou já atualizados)
```

**Rules for the report:**
- Each description: 1-2 sentences in Portuguese, max 120 chars per line (break into 2 lines if needed)
- Focus on user impact: "Agora o X faz Y" / "Corrigido problema onde X causava Y"
- If all commits are docs/chore/ci (nothing to show), say: `Atualização interna — sem mudanças visíveis para o usuário.`
- Do NOT add extra commentary, tips, or suggestions after the report
