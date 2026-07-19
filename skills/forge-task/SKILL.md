---
name: forge-task
description: "Task autonoma sem milestone — brainstorm, discuss, plan, execute."
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---

## Parse arguments

From `$ARGUMENTS`:
- If contains `--resume <id>` (aceita `T-<ts>-<slug>` ou o legado `TASK-###`) → **RESUME MODE**: set `TASK_ID` to that ID, skip init
- `--skip-brainstorm` or `-skip-brainstorm` → `SKIP_BRAINSTORM = true`
- `--skip-research` or `-skip-research` → `SKIP_RESEARCH = true`
- Remaining text after all flags → `TASK_DESCRIPTION`

If `TASK_DESCRIPTION` is empty AND not resume mode → stop and tell the user:
> Descreva a task: `/forge-task <descrição>`
> Para pular brainstorm: `/forge-task --skip-brainstorm <descrição>`

---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro.

> **Note:** `/forge-task` não requer `.gsd/STATE.md` — tasks são independentes de milestones.

---

## Load context

Read:
1. First 40 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)
2. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

**Resolve PREFS via the canonical engine CLI (ONE call — never a 3-file md merge in-context).** The S01 engine (`scripts/forge-prefs.js`) dual-reads legacy markdown OR new jsonc per layer and applies the exact same user-global → repo-shared → local-personal precedence (last wins) that the old inline prose described. Do NOT read/merge `~/.claude/forge-agent-prefs.md` + `.gsd/claude-agent-prefs.md` + `.gsd/prefs.local.md` by hand — that is exactly what the CLI does. See `shared/forge-dispatch.md § Per-unit prefs resolution` for the canonical helper.

```bash
if [ -f "scripts/forge-prefs.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="$HOME/.claude/scripts"
fi
WORKING_DIR="${WORKING_DIR:-$(pwd)}"
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --explain --cwd "$WORKING_DIR")
PREFS_EXIT=$?
```

**Loud-stop on parse error (M008-CONTEXT decision #2 — ALWAYS stop on a broken config, NEVER degrade to defaults silently):**
```
If PREFS_EXIT != 0:
  - `$PREFS_JSON` carries `errors[]` ({file,line,message}) on stdout; the CLI already printed a
    human message + "corrija o JSONC…" hint on stderr.
  - Stop this task run (`/forge-task` is single-shot — no auto-mode to deactivate).
  - Surface to the operator: arquivo + linha + como-corrigir (from errors[]).
  - Do NOT proceed on EFFORT_OPUS=medium / WORKERS_ENGINE=claude / any fallback value.
```
`warnings[]` (advisory schema validation, `⚠` on stderr) do NOT stop — only exit≠0 halts.

The resolved object is `{ok, prefs, errors[], warnings[], layers}`. Throughout this skill **`PREFS` = `.prefs`** from this one call. Store as: `PREFS`, `TOP_MEMORIES`.

**Deprecation warning (once per session):** Inspect `layers` from the `PREFS_JSON`
already resolved above; do not make another CLI call. If any
`layers.<name>.source == "md-legacy"`, list that layer's `files` and emit exactly:
`⚠ Prefs em markdown legado ainda honradas: <files>. Rode /forge-update para migrar para JSONC (remoção do caminho legado na v2.0).`
Do not emit this warning when every layer is `jsonc` or `absent`. Load context runs
once per session, so this is naturally one warning per session. Re-warning after
compaction is accepted because Compaction Resilience re-reads Load context.

**CODING_STANDARDS section extraction:**
- `CS_LINT` ← `## Lint & Format Commands` section
- `CS_STRUCTURE` ← `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` ← `## Code Rules` section
If missing, all section variables are `"(none)"`.

**Resolve the plan/discuss-phase effort off the resolved `PREFS` object** (default identical to the old inline snippet). The **executor** effort is NO longer static here — it is resolved dynamically (with model-cap clamp) by `forge-dispatch-resolve.js` in Step 5 (`$EFFORT`):
- `EFFORT_OPUS = PREFS.effort.plan or "medium"`

Initialize: `session_units = 0`, `COMPACT_AFTER = PREFS.compact_after || 10`
(0 or "unlimited" in PREFS disables the compact signal entirely)

---

## Multi-run resolution + TASK_ID

**Resolve scripts dir** for forge-runs.js / forge-cli-helpers.js:
```bash
if [ -f "scripts/forge-runs.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="$HOME/.claude/scripts"
fi
```

**Multi-run check** — refuse if too many active and no explicit resume:
```bash
# Migrate legacy STATE.md FIRST (idempotent) — required before any dashboard regen below
node "$FORGE_SCRIPTS_DIR/forge-runs.js" --migrate-legacy --cwd "$(pwd)" > /dev/null 2>&1 || true

if [ -z "$TASK_ID" ]; then
  RESOLVE=$(node "$FORGE_SCRIPTS_DIR/forge-cli-helpers.js" --resolve-args --args "" --command forge-task)
  STATUS=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status)" "$RESOLVE")
  if [ "$STATUS" = "refuse" ]; then
    node -e "process.stdout.write(JSON.parse(process.argv[1]).message)" "$RESOLVE"
    exit 0
  fi
fi
```

**Determine TASK_ID:**
```bash
mkdir -p .gsd/tasks
TASK_ID=$(node "$FORGE_SCRIPTS_DIR/forge-ids.js" --new-task "$TASK_DESCRIPTION")
```

- Resume mode: `TASK_ID` already set — skip to Dispatch loop
- Formato do `TASK_ID` segue a pref `ids.format` (resolvida pelo próprio forge-ids.js): `timestamp` (default) → `T-<YYYYMMDDHHMMSS>-<slug>` (slug omitido se a descrição for vaga); `sequential` → legado `TASK-00N` (max existente + 1 em `.gsd/tasks/`)

**Isolation setup (branch/worktree)** — apply `forge_isolation` from prefs BEFORE registering the run. Idempotent — safe on resume (`already-on-branch` / `already-exists`):
```bash
ISO_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --setup --run "$TASK_ID" --cwd "$(pwd)")
ISOLATION_MODE=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).mode)||'shared')" "$ISO_RESULT")
WORKTREE_DIR=$(node -e "const r=JSON.parse(process.argv[1]);const w=(r.repos||[]).find(x=>x.worktree&&x.status!=='error');process.stdout.write(w?w.worktree:'')" "$ISO_RESULT")
ISO_ERRORS=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write((r.repos||[]).filter(x=>x.status==='error').map(x=>x.path+': '+x.error).join('; '))" "$ISO_RESULT")
echo "ISOLATION_MODE=$ISOLATION_MODE  WORKTREE_DIR=${WORKTREE_DIR:-—}  ISO_ERRORS=${ISO_ERRORS:-none}"
```

Isolation rules (CRITICAL — the operator configured this; honor it):
- `shared` → `CODE_DIR = $(pwd)`. Nothing else to do.
- `branch` → `CODE_DIR = $(pwd)`. The executor commits on the `forge/{TASK_ID}` branch the setup just checked out.
- `worktree` → `CODE_DIR = $WORKTREE_DIR`. ALL code reads/writes/commits happen inside the worktree; `.gsd/**` artifacts ALWAYS stay under the original workspace.
- `ISO_ERRORS` non-empty AND no repo succeeded → STOP and surface the errors. Running un-isolated when the operator configured isolation is NOT an acceptable fallback.
- When mode != shared, emit one line: `⛓ Isolation: {mode} → {branch name or worktree path}`.

**Register in multi-run registry** (M004+) — only when initializing fresh (not on resume):
```bash
if [ -z "$RESUME_MODE" ]; then
  SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")}"
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --add --id "$TASK_ID" --kind task --session "$SESSION_ID" --isolation-mode "$ISOLATION_MODE" --account "${FORGE_ACCOUNT:-}" --cwd "$(pwd)" --task-description "$TASK_DESCRIPTION" > /dev/null
  # Regenerate dashboard
  node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
fi
```

This makes the task visible in `runs/*.json`, statusline, and dashboard. The `.gsd/tasks/{TASK_ID}/` directory continues to hold artifacts (BRIEF, PLAN, SUMMARY) as before — only the run registry is new.

**On task completion** (or any exit path — pause/error): mark inactive:
```bash
node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$TASK_ID" --json '{"active":false}' > /dev/null
node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
```

---

## Initialize task (skip if resume mode)

```bash
mkdir -p .gsd/tasks/{TASK_ID}
```

Write `.gsd/tasks/{TASK_ID}/{TASK_ID}-BRIEF.md`:
```markdown
---
id: {TASK_ID}
description: {TASK_DESCRIPTION}
created: {ISO8601 date}
skip_brainstorm: {true|false}
skip_research: {true|false}
---

# {TASK_DESCRIPTION}
```

Show the user:
```
→ Iniciando {TASK_ID}: {TASK_DESCRIPTION}
   Fluxo: {brainstorm →} discuss → research → plan → execute
```

---

## Cleanup orphaned tasks

Call `TaskList`. Mark any tasks with `status: in_progress` as `completed` before starting.

---

## Dispatch loop

Execute steps in order. Each step checks if its output file already exists — if yes, skip (idempotent resume). After each dispatch, increment `session_units`. If `session_units >= COMPACT_AFTER` and the task is not yet done, emit the compact signal and stop.

---

### Step 1 — Brainstorm

**Skip if:**
- `SKIP_BRAINSTORM = true`, OR
- `.gsd/tasks/{TASK_ID}/{TASK_ID}-BRAINSTORM.md` already exists

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] brainstorm", activeForm: "brainstorm · forge-planner (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-planner` (opus) with this prompt:
```
Brainstorm for forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Prior Decisions
{last 20 rows of .gsd/DECISIONS.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Produce a lightweight brainstorm for this task. Write {TASK_ID}-BRAINSTORM.md to
.gsd/tasks/{TASK_ID}/ with exactly these sections:

# Brainstorm: {TASK_DESCRIPTION}
**Date:** YYYY-MM-DD

## Recommended Approach
[One paragraph — best balance of speed, risk, and value for this specific task]

## Alternatives Considered
| Approach | Trade-off |
|----------|-----------|
| ... | ... |

## Top Risks
1. [Specific risk] — [early signal / mitigation]
2. ...

## Out of Scope
- [What this task should NOT touch — be explicit]

## Open Questions for Discuss
- [Specific questions the user must answer before planning]

Keep it concise — this is a scoping aid, not a plan. Max 1 page.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 2 — Discuss

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-CONTEXT.md` already exists

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] discuss", activeForm: "discuss · forge-discusser (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-discusser` (opus) with this prompt:
```
Discuss forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Brainstorm Output
{content of {TASK_ID}-BRAINSTORM.md if exists, else "(none — brainstorm was skipped)"}

## Prior Decisions (do not re-debate)
{last 20 rows of .gsd/DECISIONS.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Score clarity (scope/acceptance/tech/dependencies/risk). Ask about dimensions below 70.
Write {TASK_ID}-CONTEXT.md to .gsd/tasks/{TASK_ID}/ with sections:
  ## Decisions, ## Agent's Discretion, ## Open Questions, ## Out of Scope
Append significant decisions to the **fragment store** via `forge-decisions.js --write` (stdin JSON) — do NOT write to `.gsd/DECISIONS.md` directly. Use:
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-decisions.js ] && echo scripts || echo "$HOME/.claude/scripts")
printf '%s' "$key_decisions_json" | node "$FORGE_SCRIPTS_DIR/forge-decisions.js" --write --cwd "$WORKING_DIR"
```
Where `key_decisions_json` is `{ "unit_id": "{TASK_ID}", "decisions": [{when, scope, decision, choice, rationale, revisable}, ...] }`. The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-merger).
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 3 — Research

**Skip if:**
- `SKIP_RESEARCH = true`, OR
- `.gsd/tasks/{TASK_ID}/{TASK_ID}-RESEARCH.md` already exists

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] research", activeForm: "research · forge-researcher (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-researcher` (opus) with this prompt:
```
Research codebase for forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Task Decisions
{## Decisions section of {TASK_ID}-CONTEXT.md if exists, else "(none)"}

## Current Coding Standards
{full .gsd/CODING-STANDARDS.md or "(none)"}

## Project Memory (known gotchas)
{TOP_MEMORIES}

## Instructions
Explore the codebase relevant to this task. Write {TASK_ID}-RESEARCH.md to
.gsd/tasks/{TASK_ID}/ with:
- ## Summary: what exists today that's relevant
- ## Don't Hand-Roll: libraries/patterns/components already in the codebase to reuse
- ## Common Pitfalls: found in existing code or well-known for this stack
- ## Relevant Code: file:line references for key sections
- ## Reusable Assets: functions/hooks/services to leverage directly
- ## External Research: (include if web searches were done — source URL + 1-line takeaway)

**Web research:** If the Task Brief references specific URLs — fetch them. Do up to 3 targeted
web searches for pitfalls, breaking changes, or best practices relevant to named libraries/APIs.
After writing RESEARCH.md, update .gsd/CODING-STANDARDS.md with any new findings.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 4 — Plan

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md` already exists

**Security gate:** Scan `{TASK_ID}-BRIEF.md` + `{TASK_ID}-CONTEXT.md` for:
`auth|token|crypto|password|secret|api.?key|jwt|oauth|permission|role|hash|salt|encrypt|decrypt|session|cookie|credential|sanitize|xss|sql|inject`

If any match AND `.gsd/tasks/{TASK_ID}/{TASK_ID}-SECURITY.md` does not exist:
```
Skill({ skill: "forge-security", args: "{TASK_ID}" })
```

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] plan", activeForm: "plan · forge-planner (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-planner` (opus) with this prompt:
```
Plan forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Task Decisions
{## Decisions section of {TASK_ID}-CONTEXT.md if exists, else "(none)"}

## Research Findings
{content of {TASK_ID}-RESEARCH.md if exists, else "(none — research was skipped)"}

## Security Checklist
{content of {TASK_ID}-SECURITY.md if exists, else "(none)"}

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Code Rules
{CS_RULES}

## Project Memory
{TOP_MEMORIES}

## Instructions
Write {TASK_ID}-PLAN.md to .gsd/tasks/{TASK_ID}/ with exactly these sections:

## Steps
[Ordered numbered list of implementation steps. Each step is a single concrete action.]

## Must-Haves
[Verifiable acceptance criteria — each item checkable with a command or observable behavior]

## Standards
[Relevant coding rules from CODING-STANDARDS.md for this task's scope]

## Files to Change
[List of files expected to be modified, with one-line reason for each]

Iron rule: this task MUST fit in ONE context window for the executor.
If scope is too large, plan the most valuable subset and note what was deferred in ## Deferred.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 4.5 — Plan gate (interactive)

Roda o handshake do plan gate (spec autoritativa: `shared/forge-plan-gate.md`) no boundary do `forge-task`: após o `forge-planner` retornar `{TASK_ID}-PLAN.md` (Step 4) e **antes** do `forge-executor` ser despachado (Step 5). `/forge-task` é uma skill (main context) com `AskUserQuestion`, sempre interativo → `MODE = interactive`.

**Binding forge-task (conforme `shared/forge-plan-gate.md` tabela de consumidores):**

| Campo | Valor |
|-------|-------|
| UNIT | `task/{TASK_ID}` |
| PLAN_FILE | `.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md` (arquivo único) |
| MODE | `interactive` (forge-task é sempre interativo) |
| Approval marker | `{TASK_ID}-PLAN-GATE.md` |
| GATE_MARKER path | `{WORKING_DIR}/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md` |

> Nota R4 (resolvida): planos do forge-task são free-text legado e produzem no máximo **1 finding** (`legacy_schema_detect` warn). Não há findings "related" para agrupar. Batching **não é aplicado** — o finding é surfaçado como pergunta direta.

**Skip conditions (topo do Step 4.5 — verificar antes de qualquer bloco bash):**

1. `{TASK_ID}-PLAN-GATE.md` já existe com `status: approved` → pular (resume idempotente pós-compactação, não re-pergunta o operador).
2. `plan_gate.interactive == off` → pular o gate inteiro, ir direto ao outer Step 5 — execute (comportamento batch anterior; sem preview, sem `AskUserQuestion`, sem marker).

---

#### Gate Step 0 — Read `plan_gate` prefs via the canonical prefs CLI

Resolve prefs once through the S01 engine CLI (never a `files=[…forge-agent-prefs.md…]` cascade merge) — see `shared/forge-dispatch.md § Per-unit prefs resolution` and `shared/forge-plan-gate.md § Step 0`.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "$HOME/.claude/scripts")
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # M008-CONTEXT decision #2 — loud stop, never a silent default. errors[] (file+line)
  # on stdout ($PREFS_JSON); human message + fix hint on stderr. Halt the gate.
  echo "✗ prefs parse error — plan gate halted (see stderr for arquivo:linha)" >&2
  exit 1
fi
# CRITICAL loud-stop (M008-CONTEXT #2): a nonzero prefs-CLI exit above HALTS the
# task. The `exit 1` fires when this block runs in a shell. In the orchestrator,
# STOP this task run now: deactivate the run + surface arquivo+linha+como-corrigir
# from `errors[]`. Do NOT proceed on INTERACTIVE=always / any fallback default.

# Extract plan_gate knobs off .prefs, preserving the exact whitelist + defaults.
INTERACTIVE=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=(JSON.parse(d).prefs.plan_gate||{}).interactive;v=(typeof v==='string')?v.toLowerCase():'';process.stdout.write(['always','auto','off'].includes(v)?v:'always')}catch(e){process.stdout.write('always')}})")
ASK_AUTO=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=(JSON.parse(d).prefs.plan_gate||{}).ask_in_auto;v=(typeof v==='string')?v.toLowerCase():'';process.stdout.write(['defer','off'].includes(v)?v:'defer')}catch(e){process.stdout.write('defer')}})")
```

**Loud-stop on the prefs re-resolution above (M008-CONTEXT #2 — NOT a bare comment):** if the `forge-prefs.js --resolved` call at the top of this block exited non-zero, STOP this task run now — do NOT run the plan gate on fallback values. Deactivate the run, surface arquivo + linha + como-corrigir from `errors[]`, and do **NOT** proceed on `INTERACTIVE=always` / `ASK_AUTO=defer` / any fallback default. The `exit 1` in the guard halts a shell-executed path; this prose halts the orchestrator-interpreted path.

Defaults preserved byte-for-byte: absent `.prefs.plan_gate` (or an out-of-whitelist value) → `INTERACTIVE=always`, `ASK_AUTO=defer` — identical to the old inline cascade. `warnings[]` (advisory) do not stop; only exit≠0 halts.

**Semântica da pref `interactive`:**

| Valor | Comportamento |
|-------|---------------|
| `always` (default) | Conduzir o gate em todo plano — preview + aprovação sempre. |
| `auto` | Conduzir só quando `warn > 0` ou `fail > 0`. Auto-aprovar silenciosamente se tudo passar. (**Nota:** para forge-task legado, `plan_check_counts` não está em escopo — tratar como `always`.) |
| `off` | Pular o gate inteiro — comportamento batch atual. Ir direto ao outer Step 5 (execute). |

Se `INTERACTIVE == off` → **pular o gate.** Ir direto ao outer Step 5 (execute).

---

#### Gate Step 0a — Idempotency / GATE_MARKER

```bash
GATE_MARKER="$WORKING_DIR/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md"
```

> **NUNCA** usar `{TASK_ID}-PLAN-CHECK.md` como marker — esse arquivo pertence ao `forge-plan-checker` (agente advisory separado) e não deve ser reutilizado como sinal de aprovação do operador.

```bash
if [ -f "$GATE_MARKER" ] && grep -qF "status: approved" "$GATE_MARKER" 2>/dev/null; then
  echo "Plan gate already approved — skipping (resume after compaction)"
  # Prosseguir diretamente para o outer Step 5 (execute)
fi
```

---

#### Gate Step 1 — Preview do plano

Ler `{TASK_ID}-PLAN.md` do disco — **preview = arquivo em disco, não conteúdo cacheado.** Isso garante que edições em andamento sejam refletidas.

```bash
PLAN_FILE="$WORKING_DIR/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md"
```

Exibir um resumo informacional (sem pergunta ainda):
- Título da task (de `{TASK_ID}-BRIEF.md` ou cabeçalho do plano)
- Número de seções presentes (`## Steps`, `## Must-Haves`, `## Standards`, `## Files to Change`)
- Número de itens em `## Files to Change`

O operador lê o plano e se prepara para a revisão de findings no Gate Step 2.

---

#### Gate Step 2 — Lapidação do finding (R4: sem batching para forge-task)

Planos do `forge-task` são **legacy free-text** (não há `must_haves:` YAML estruturado em coluna 0). O plan-checker, se rodado, sempre retornaria `warn` em `legacy_schema_detect` (nunca `fail`) — **no máximo 1 finding**.

> **Resolução de R4 (era OPEN em S01):** drop batching para o consumidor forge-task. Com ≤ 1 finding, não há findings "related" para agrupar. O único finding é surfaçado como pergunta direta — sem lógica de batching. (O consumidor `forge-next` em S03 reavaliará batching para planos estruturados com múltiplos findings possíveis.)

> **Nota importante:** o `forge-task` não roda o `forge-plan-checker` no fluxo atual (Step 4 só despacha o planner, não o plan-checker). Portanto `plan_check_counts` não está em escopo. O Step 4.5 trata o plano como legado por definição e oferece preview + edição livre como a rede de segurança primária. O gate é essencialmente: **preview → edição livre → aprovação**, com o aviso de formato legado como único "finding".

Invocar `AskUserQuestion`:
```
Header: "Plano {TASK_ID} — formato legado"
Body:   "O plano está no formato free-text legado (## Steps / ## Must-Haves / ## Standards / ## Files to Change, sem YAML estruturado). Revise o texto do plano diretamente antes de aprovar."
Options: ["Manter — plano está bom", "Corrigir no ato — editar o plano", "Deferir — prosseguir assim"]
```

- `Manter` / `Deferir` → ir para Gate Step 3 (edição livre opcional).
- `Corrigir no ato` → ir para Gate Step 3 (edição livre, com intenção de editar).

---

#### Gate Step 3 — Edição livre (escape hatch)

Oferecer ao operador uma janela de edição não-estruturada:

```
AskUserQuestion({
  header: "Edição livre do plano",
  body:   "Edite {TASK_ID}-PLAN.md no seu editor agora. Confirme quando terminar.",
  options: ["Confirmar — relerei o plano", "Pular — plano está bom"]
})
```

- `Confirmar` → reler o arquivo do disco (`PLAN_FILE`) e exibir a versão atualizada ao operador. O orquestrador NÃO usa cache — lê o arquivo atual. As edições humanas passam a ser a versão autoritativa do plano. Ir para Gate Step 4 (re-validação).
- `Pular` → ir direto para Gate Step 5 (aprovação).

---

#### Gate Step 4 — Re-validação pós-edição (NO-OP para forge-task — documentado)

Após edição (caminho `Confirmar` do Step 3), re-validar o schema do plano.

```bash
REVALIDATION_STDERR=$(mktemp)
REVALIDATION=$(node scripts/forge-must-haves.js --check "$PLAN_FILE" 2>"$REVALIDATION_STDERR")
REVALIDATION_EXIT=$?
```

**IO-error guard (aplicar antes do JSON.parse):**

```bash
if [ $REVALIDATION_EXIT -ne 0 ] && [ $REVALIDATION_EXIT -ne 2 ]; then
  IO_ERR=$(cat "$REVALIDATION_STDERR")
  LEGACY=false; VALID=false
  ERRORS="[\"IO error from forge-must-haves.js: $IO_ERR\"]"
else
  if ! node -e "JSON.parse(process.env.R)" R="$REVALIDATION" 2>/dev/null; then
    IO_ERR=$(cat "$REVALIDATION_STDERR")
    LEGACY=false; VALID=false
    ERRORS="[\"Non-JSON stdout from forge-must-haves.js (exit $REVALIDATION_EXIT): $IO_ERR\"]"
  else
    LEGACY=$(node -e "process.stdout.write(String(JSON.parse(process.env.R).legacy))" R="$REVALIDATION")
    VALID=$(node -e  "process.stdout.write(String(JSON.parse(process.env.R).valid))"  R="$REVALIDATION")
    ERRORS=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.env.R).errors))" R="$REVALIDATION")
  fi
fi
rm -f "$REVALIDATION_STDERR"
```

> **⚠ Pitfall 1 — re-validação é NO-OP para planos forge-task legados:** `node scripts/forge-must-haves.js --check` detecta ausência de `^must_haves:` em coluna 0 e retorna `{legacy:true, valid:true, errors:[]}` (exit 0) — **validando nada.** A rede de segurança para planos legados é a edição livre + reload do Step 3, **não** schema enforcement. Re-validação só é significativa para planos estruturados futuros (`forge-next` com `must_haves:` YAML). NÃO prometer enforcement que não dispara em planos legados.

Se `legacy == false && valid == false` (plano estruturado futuro com erro de schema):

```
AskUserQuestion({
  header: "Erro de schema no plano",
  body:   "O plano tem erros de schema que impedem a aprovação:\n{ERRORS}\nCorrigir o plano (edit + releitura) ou abortar.",
  options: ["Corrigir agora", "Abortar — replanejar"]
})
```

- `Corrigir agora` → voltar ao Gate Step 3, depois re-rodar Gate Step 4.
- `Abortar` → não escrever o marker; retornar o usuário à fase de planejamento.

---

#### Gate Step 5 — Approval handshake

Após os findings serem endereçados e a re-validação passar, apresentar o gate de aprovação final. O `ExitPlanMode` pode ser usado aqui (Agent's Discretion, M002-CONTEXT `§ Agent's Discretion`) — é seguro pois o `forge-task` **não** é invocado dentro de uma fase de discuss, portanto não há plan mode herdado aberto neste ponto (ver `shared/forge-plan-gate.md § Plan-mode non-nesting`).

> **Não-aninhamento de plan mode:** o `forge-discusser` (Step 2) é o único dono do `EnterPlanMode`/`ExitPlanMode` e já fechou seu plan mode antes do planejamento começar. **NÃO adicionar `EnterPlanMode`** em nenhum ponto do Step 4.5 — isso aninharia com o discuss e quebraria a invariante.

```
AskUserQuestion({
  header: "Aprovar plano {TASK_ID}",
  body:   "Plano revisado e validado. Aprovar para iniciar a execução?",
  options: ["Aprovar — iniciar execução", "Editar mais", "Abortar — replanejar"]
})
```

- `Aprovar` → escrever o GATE_MARKER:

```bash
mkdir -p "$(dirname "$GATE_MARKER")"
cat > "$GATE_MARKER" << 'EOF'
---
status: approved
approved_at: {ISO8601}
consumer: forge-task
unit: task/{TASK_ID}
---
Plan approved by operator. Execution may proceed.
EOF
```

  Prosseguir para o outer Step 5 (execute).

- `Editar mais` → voltar ao Gate Step 3.
- `Abortar` → não escrever o marker. Re-despachar o `forge-planner` com notas do operador; reiniciar o ciclo de planejamento.

---

#### Event log

Após o gate fechar (aprovado/abortado/pulado), append uma linha em `.gsd/forge/events.jsonl`:

```bash
mkdir -p "$WORKING_DIR/.gsd/forge"
printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan-gate\",\"milestone\":\"\",\"unit\":\"task/{TASK_ID}\",\"mode\":\"interactive\",\"interactive\":\"$INTERACTIVE\",\"outcome\":\"{approved|aborted|skipped}\",\"warn\":0,\"fail\":0,\"edits\":{N}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```

Campos:
- `outcome`: `approved` (operador aprovou), `aborted` (operador escolheu replanejar), `skipped` (idempotência atingida ou `interactive: off`).
- `warn` / `fail`: sempre `0` para planos forge-task legados (plan-checker não rodou).
- `edits`: número de vezes que o Step 3 foi visitado (0 = sem edição livre).
- `milestone`: `""` (forge-task fora de milestone por padrão).

---

**Handoff para outer Step 5:** o outer Step 5 (execute) só roda após o gate aprovar (marker `{TASK_ID}-PLAN-GATE.md` escrito com `status: approved`) ou ser pulado (`interactive: off`). A ausência do marker indica que o gate foi abortado — o executor **não** deve ser despachado.

---

### Step 5 — Execute

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-SUMMARY.md` already exists (task done).

**Record pre-execute HEAD SHA** (persisted to file so Step 5.5 can diff after executor commits). In `worktree` mode the commits land in `CODE_DIR` — read HEAD from there:
```bash
git -C "${CODE_DIR:-.}" rev-parse HEAD 2>/dev/null > .gsd/tasks/{TASK_ID}/.start-sha || echo "" > .gsd/tasks/{TASK_ID}/.start-sha
```

**Dispatch resolution (before dispatch)** — resolve `{engine, model, alias, tier, domain, route_source, chain, chain_len, reason, effort, effort_reason}` for this dispatch via the **single `forge-dispatch-resolve.js --json` call** (S01). As of M012 S02 T02, this ONE call folds the former Engine Resolution + tier/domain routing + dynamic Effort Resolution + alias into a thin caller — `forge-task` is single-task and always interactive, but the engine/fallback mechanics are byte-identical to the `forge-auto`/`forge-next` mirrors, and it now has full domain-first routing parity. `forge-task`'s only `unit_type` is `execute-task` and it is a **loose task** (no roadmap) → no `--roadmap`, so risk-escalation is inert and the routing is always "active".
> Cross-reference: `shared/forge-dispatch.md § Worker Engine Routing` (algorithm, prefs reader, engine-by-route_source table, sidecar state machine, fallback) + `scripts/forge-dispatch-resolve.js` (S01). Any change to the pure resolution lands in the resolver; this block is the executable caller.

```bash
# ── Dispatch resolution (before dispatch; execute-task routes to sidecar) ──────
# The explicit prefs loud-stop gate STAYS even though forge-dispatch-resolve.js also surfaces
# prefs errors — an early, human-actionable halt on a broken config (M008-CONTEXT #2). ONE
# forge-prefs.js --resolved call (dual-reads md OR jsonc; NEVER a 3-file cascade node -e merge,
# MEM001 M005). See shared/forge-dispatch.md § Per-unit prefs resolution.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "$HOME/.claude/scripts")
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # Loud stop (M008-CONTEXT #2): errors[] ({file,line,message}) on stdout, human hint on stderr.
  # Stop this task run. NEVER degrade to a claude/effort-default fallback on a broken config.
  echo "✗ prefs parse error — dispatch halted (see stderr for arquivo:linha)" >&2
  exit 1
fi
# CRITICAL loud-stop (M008-CONTEXT #2): a nonzero prefs-CLI exit above HALTS the
# dispatch. The `exit 1` fires when this block runs in a shell. In the
# orchestrator, STOP this task run now: deactivate the run + surface
# arquivo+linha+como-corrigir from `errors[]`. NEVER degrade on a broken config.

# ONE resolver call — engine/model/alias/tier/domain/route_source/chain/effort all resolved inside
# it (frontmatter worker: > routing: > pref > default precedence owned by the resolver, MEM018 reads
# prefs from $WORKING_DIR). Loose task → NO --roadmap (risk-escalation inert). --cwd "$WORKING_DIR".
PLAN_PATH=".gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md"
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-dispatch-resolve.js ] && echo scripts || echo "$HOME/.claude/scripts")
ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" \
  --unit-type execute-task --plan "$PLAN_PATH" --unit-id "{TASK_ID}" --cwd "$WORKING_DIR" --json)
if [ $? -ne 0 ]; then
  # Non-zero exit == prefs loud-stop (M008-CONTEXT #2) — the resolver only exits 1 on prefs_ok:false.
  echo "✗ dispatch resolver halted (prefs error) — see forge-dispatch-resolve.js prefs_errors" >&2
  exit 1
fi
MODEL_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).model)" "$ROUTE_JSON")
MODEL_ALIAS=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).alias||'')" "$ROUTE_JSON")
TIER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).tier)" "$ROUTE_JSON")
REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).reason)" "$ROUTE_JSON")
DOMAIN_USED=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).domain)" "$ROUTE_JSON")
ROUTE_SOURCE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).route_source)" "$ROUTE_JSON")
CHAIN_LEN=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).chain_len))" "$ROUTE_JSON")
ENGINE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).engine)" "$ROUTE_JSON")
ENGINE_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).engine_reason)" "$ROUTE_JSON")
EFFORT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).effort)" "$ROUTE_JSON")
EFFORT_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).effort_reason)" "$ROUTE_JSON")
WORKERS_TIMEOUT=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).workers_timeout))" "$ROUTE_JSON")
CODEX_MODEL=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).codex_model||'')" "$ROUTE_JSON")
THINKING_HEADER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).thinking_header||'')" "$ROUTE_JSON")
MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && printf '"%s"' "$MODEL_ALIAS" || printf 'null')
# The sidecar codex model is fed from the resolved chain (chain[0].id when that member is a
# gpt-* codex engine), falling back to the workers.codex_model pref for legacy compat.
SIDECAR_MODEL=$(node -e "const r=JSON.parse(process.argv[1]);const c=(r.chain||[])[0];process.stdout.write(c&&c.engine==='codex'&&c.id?c.id:(r.codex_model||''))" "$ROUTE_JSON")
# $ROUTE_JSON.chain carries forward unmodified — consumed by Branch codex (SIDECAR_MODEL) and by
# the Failure Taxonomy via `forge-routing.js ... --next-after "$MODEL_ID"`.
```
**Loud-stop on the resolution above (M008-CONTEXT #2 — NOT a bare comment):** if either the `forge-prefs.js --resolved` gate OR the `forge-dispatch-resolve.js` call exited non-zero, STOP this task run now — deactivate the run, surface arquivo + linha + como-corrigir from `errors[]`/`prefs_errors`, and do **NOT** proceed on any claude/effort-default fallback value. The `exit 1` guards halt a shell-executed path; this prose halts the orchestrator-interpreted path.

`$ENGINE`, `$ENGINE_REASON`, `$MODEL_ID`, `$MODEL_ALIAS`, `$TIER`, `$REASON`, `$DOMAIN_USED`, `$ROUTE_SOURCE`, `$CHAIN_LEN`, `$EFFORT`, `$EFFORT_REASON`, `$WORKERS_TIMEOUT`, `$CODEX_MODEL`, `$SIDECAR_MODEL`, `$THINKING_HEADER`, `$MODEL_APPLIED_JSON`, `$PLAN_PATH`, and `$ROUTE_JSON` (with `.chain`) are now set. The dispatch below branches on `$ENGINE`; the resolved `$EFFORT`/`$TIER`/`$DOMAIN_USED`/`$ROUTE_SOURCE`/`$CHAIN_LEN` are injected into the dispatch event (both paths).

**Branch codex — sidecar (`$ENGINE == codex`)** — executable mirror of `shared/forge-dispatch.md § Worker Engine Routing § Sidecar dispatch state machine`. When this branch fires, the Claude machinery below (timeline task, guarded `Agent()` dispatch) is **replaced** by the detached adapter + polling; on any failure it resets and **falls through to that same Claude machinery** (fallback). When `$ENGINE == claude`, skip this branch entirely and proceed with the Claude dispatch below — byte-identical to the current loop.

1. **Capture `START_SHA` (authoritative for the reset — independent of the adapter's own `start_sha`) and persist the sidecar state to disk.** Branch C spans multiple Bash tool invocations (the poll loop) and may cross an auto-compact, so shell vars do NOT survive — the state file (under `WORKING_DIR/.gsd`, never `CODE_DIR`) is the durable carrier of `{start_sha, reason, result_file, code_dir}`, mirroring `auto-mode-started.txt`. The success AND fallback blocks re-read it from disk:
```bash
START_SHA=$(git -C "${CODE_DIR:-.}" rev-parse HEAD)
XLLM_STATE="$WORKING_DIR/.gsd/forge/xllm-state-{TASK_ID}.json"
mkdir -p "$WORKING_DIR/.gsd/forge/"
printf '{"start_sha":"%s","reason":"","result_file":"","code_dir":"%s"}\n' "$START_SHA" "${CODE_DIR:-.}" > "$XLLM_STATE"
```

2. **Clean-tree guard.** Dirty tree → do NOT dispatch the sidecar (never discard uncommitted work); go to Fallback with `REASON=dirty-tree-guard` and **skip the reset**:
```bash
if [ -n "$(git -C "${CODE_DIR:-.}" status --porcelain)" ]; then
  REASON="dirty-tree-guard"   # → Fallback below WITHOUT reset, then the Claude dispatch
  printf '{"start_sha":"%s","reason":"%s","result_file":"","code_dir":"%s"}\n' "$START_SHA" "$REASON" "${CODE_DIR:-.}" > "$XLLM_STATE"
fi
```

3. **Allocate the result-file OUTSIDE `CODE_DIR`** + dispatch detached via `run_in_background: true`. `--model` appended **only when `$SIDECAR_MODEL` is non-empty** — `$SIDECAR_MODEL` is the resolved chain's codex member (`chain[0].id` when `chain[0].engine == codex`), falling back to the `workers.codex_model` pref (legacy compat), so routing-selected gpt models flow to the sidecar, not only the flat pref:
```bash
RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under CODE_DIR
printf '{"start_sha":"%s","reason":"","result_file":"%s","code_dir":"%s"}\n' "$START_SHA" "$RESULT_FILE" "${CODE_DIR:-.}" > "$XLLM_STATE"
node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode execute \
  --plan "$PLAN_PATH" --result-file "$RESULT_FILE" --cwd "${CODE_DIR:-.}" \
  --timeout "$WORKERS_TIMEOUT" \
  $([ -n "$SIDECAR_MODEL" ] && printf -- '--model %s' "$SIDECAR_MODEL")
# ↑ dispatched with the Bash tool's run_in_background: true
```

4. **Poll `$RESULT_FILE`** (state `polling`) every ~5–10s: `status==running` → keep polling + liveness check; `status==done` → success (step 5); `status==error` / adapter exit `!= 0` / unparseable JSON → failure with the matching `REASON` (`codex-exit-nonzero` / `codex-timeout` / `codex-invalid-json`) → Fallback. **Orphan:** heartbeat `updated_at` stale beyond ~2–3× the 3s cadence (~9s) → `kill "$pid"` (from the heartbeat) + `REASON=codex-orphan` → Fallback.

5. **Success — orchestrator assembles the artifacts (`done` state).** Codex NEVER writes `.gsd/**` and NEVER commits (locked — `git log` unchanged, no `.gsd/**` path in `git -C "${CODE_DIR:-.}" diff --name-status $START_SHA`). Read the JSON and **write `{TASK_ID}-SUMMARY.md`** + **build the `---GSD-WORKER-RESULT---` block** yourself from: `summary` (one-liner + narrative seed), `must_haves_status` (carried into the returned result block), `files_changed_declared` (**primary source of the file-audit** — file-granular self-report). Append synthesized advisory evidence derived read-only from `git -C "${CODE_DIR:-.}" diff --name-status $START_SHA` (tagged `source: codex-sidecar`) to `.gsd/forge/evidence-{TASK_ID}.jsonl` — a documented gap, advisory, never blocks. Emit the `dispatch` event (`engine=codex`) and **rejoin "Process result" below** exactly as if a Claude `forge-executor` returned — downstream verification (must_haves, verifier, file-audit, review dialético in Step 5.5) runs **byte-identical** on codex-authored code. First re-read the durable state (the poll loop crossed multiple Bash invocations — shell vars are gone):
```bash
START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
mkdir -p "$WORKING_DIR/.gsd/forge/"
CODEX_MODEL_LABEL="${SIDECAR_MODEL:-codex-default}"
# Full routing-aware dispatch event (M012 S02 T02 — additive fields: tier/effort/effort_reason/
# domain/route_source/chain_len/model_applied close the observability gap; before this the codex
# event carried only engine/reason/model).
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/{TASK_ID}\",\"model\":\"${CODEX_MODEL_LABEL}\",\"tier\":\"${TIER}\",\"reason\":\"${ENGINE_REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"milestone\":\"\",\"input_tokens\":0,\"output_tokens\":0,\"model_applied\":${MODEL_APPLIED_JSON}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
# → proceed to "Process result" below. Do NOT run the Claude machinery below.
```

**Fallback — `worker-engine-fallback`** (any codex failure trigger — clone of `review-challenger-fallback`, `shared/forge-dispatch.md § Fallback`). One event type, five triggers by `REASON`; no retry of the codex work; **not a 4th recovery layer**:
```bash
# Re-read durable state (this block may be a later Bash invocation — shell vars are gone).
START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
# Reset to START_SHA (scoped to CODE_DIR, excluding .gsd/) — EXCEPT dirty-tree-guard, which skips the reset.
# The .gsd exclusion protects the orchestrator's own .gsd writes (events.jsonl / evidence) made during
# the poll — guarded by the dirty-tree-guard + .gsd exclusion scope, NOT by gitignore (user projects
# may commit .gsd).
if [ "$REASON" != "dirty-tree-guard" ]; then
  git -C "${CODE_DIR:-.}" checkout "$START_SHA" -- . ':(exclude).gsd' && git -C "${CODE_DIR:-.}" clean -fd -e .gsd
fi
echo "⚠ worker: codex indisponível ($REASON) — usando forge-executor"
mkdir -p "$WORKING_DIR/.gsd/forge/"
printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"","slice":"","unit":"execute-task/%s","reason":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{TASK_ID}" "$REASON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```
Then set `ENGINE=claude` and dispatch the single `forge-executor` Claude worker via the machinery below. No re-resolution of engine (fallback is unconditionally Claude); no retry.

**Claude dispatch** (default path, and the fallback target) — the machinery below runs when `$ENGINE == claude`:

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] execute", activeForm: "execute · forge-executor (sonnet)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Antes do dispatch, emita o banner de liveness (ver `shared/forge-dispatch.md § Spawn Liveness Banner`):
`◆ Despachando forge-executor… (roda em subagente — sem output até retornar, ~3–8 min; esperado, não é travamento)`

Dispatch `forge-executor` (sonnet) with this prompt. When `ISOLATION_MODE != shared`, include the isolation header lines (omit them entirely in `shared` mode):
```
Execute forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
ISOLATION: {ISOLATION_MODE}                # only when != shared
BRANCH: {resolved forge/{TASK_ID} branch}  # only when != shared
CODE_DIR: {CODE_DIR}                       # only when != shared
Isolation rule: all source-code reads, writes, builds and git commits happen inside CODE_DIR on branch BRANCH. All .gsd/** artifact paths stay under WORKING_DIR. Never commit from WORKING_DIR when CODE_DIR differs.
auto_commit: {PREFS.auto_commit — true or false}
effort: {EFFORT}
thinking: {THINKING_HEADER == adaptive ? "adaptive" : "disabled"}

## Task Plan
{content of {TASK_ID}-PLAN.md}

## Research Findings
{content of {TASK_ID}-RESEARCH.md if exists, else "(none)"}

## Lint & Format Commands
{CS_LINT}

## Security Checklist
{content of {TASK_ID}-SECURITY.md if exists, else "(none — no security-sensitive scope)"}

## Task Decisions
{## Decisions section of {TASK_ID}-CONTEXT.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Execute all steps in ## Task Plan.
Verify every must-have. Run lint/format if CS_LINT is present.
If ## Security Checklist is present — treat each item as a must-have.
Write {TASK_ID}-SUMMARY.md to .gsd/tasks/{TASK_ID}/ with:
  ---
  id: {TASK_ID}
  description: {TASK_DESCRIPTION}
  status: done
  key_files: [list]
  key_decisions: [list]
  ---
  ## What Was Done
  [Narrative summary of changes made]
  ## Must-Haves Verified
  - [x] item 1
  - [x] item 2
If auto_commit is true: commit with message "feat({TASK_ID}): {one-liner description}".
If auto_commit is false: do NOT run any git commands.
Do NOT modify STATE.md. Return ---GSD-WORKER-RESULT---.
```

**Emit the dispatch event (claude path)** — once the `forge-executor` returns. This is the observability WIN: before M012 S02 T02 the claude path emitted NO dispatch event at all. Mirror the `forge-auto` claude-path event shape (full routing fields; `milestone` empty for a loose task). `$INPUT_TOKENS`/`$OUTPUT_TOKENS` come from the `Agent()` result usage (0 if unavailable):
```bash
mkdir -p "$WORKING_DIR/.gsd/forge/"
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/{TASK_ID}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"engine\":\"claude\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"milestone\":\"\",\"input_tokens\":${INPUT_TOKENS:-0},\"output_tokens\":${OUTPUT_TOKENS:-0},\"model_applied\":${MODEL_APPLIED_JSON}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```

**Process result:**
- `status: done` → `TaskUpdate({ status: "completed" })`, proceed to post-task
- `status: partial` → `TaskUpdate` left in_progress, emit compact signal, deactivate run, stop:
  ```bash
  if [ -n "$RUN_ID" ]; then
    node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
    node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
  else
    echo '{"active":false}' > .gsd/forge/auto-mode.json
  fi
  ```
- `status: blocked` → deactivate run, surface blocker to user, stop:
  ```bash
  if [ -n "$RUN_ID" ]; then
    node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
    node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
  else
    echo '{"active":false}' > .gsd/forge/auto-mode.json
  fi
  ```

`session_units += 1`

---

### Step 5.5 — Dialectic review (advisory)

Runs the **challenger × advocate** confrontation on the task diff — the same per-slice gate from `shared/forge-review.md`, bound to the standalone-task boundary. `/forge-task` is a skill (main context) with `Agent` + `AskUserQuestion`, and it is interactive (it already runs a discuss phase), so OPEN objections are put to the user live (`MODE = interactive`).

**Skip if:**
- `review.mode: disabled` in merged prefs, OR
- `.gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md` already exists (idempotent resume).

**Read review prefs** (`mode`, `style`, `rounds`, `fix_conceded`, `challenger`, `challenger_model`, `advocate`, `advocate_model` — 3-file cascade, exactly as `shared/forge-review.md § Step 0`). If `mode == disabled` → skip Step 5.5 entirely.

Challenger routing (`review.challenger: claude|codex|gemini`) follows `shared/forge-review.md § Step 0` + the adapter branch in Steps 2/4 (`--engine codex|agy`) — single fallback to `forge-reviewer` when the external CLI is unavailable.

**Pairing resolution (`challenger`/`advocate: auto`).** When either axis reads `auto`, run `shared/forge-review.md § "Resolução de pairing (auto)"` unchanged, with the **task-unit scoping** called out there: skip `--slice`/`--milestone` entirely, filter `$WORKING_DIR/.gsd/forge/events.jsonl` by `e.unit === "execute-task/{TASK_ID}"` (usually one dispatch event, but cross-engine resumes of the same loose task can produce more than one), then call `forge-review-pairing.js --events "$SCOPED" --cwd "$WORKING_DIR" --challenger "$CHALLENGER" --advocate "$ADVOCATE" --policy last` (no `--slice`/`--milestone`). The task boundary always passes `--policy last` — **last-dispatch-wins**, not majority: the engine of the most recent matching dispatch is the author, since that is the engine that actually produced the final `START_SHA..HEAD` diff (with 3+ dispatches an older-engine majority could otherwise outvote the latest execution). This yields the same `$RESOLVED_CHALLENGER`/`$RESOLVED_ADVOCATE`/`$AUTHOR_ENGINE`/`$PAIR_MODE`/`$PAIR_POLICY`/`$PAIRING_LINE` used by the per-slice boundary — consumed identically from here on (Steps 2/3/4/6 of the shared spec). `$PAIRING_LINE` reflects `(last-dispatch)` as the applied policy for this boundary.

**Compute DIFF_CMD** (task boundary — START_SHA marker). In `worktree` mode the commits live in `CODE_DIR`, so every git call targets it via `git -C`:
```bash
GIT_DIR_FLAG="-C ${CODE_DIR:-.}"
START_SHA=$(cat .gsd/tasks/{TASK_ID}/.start-sha 2>/dev/null || echo "")
if [ -n "$START_SHA" ] && git $GIT_DIR_FLAG rev-parse "$START_SHA" >/dev/null 2>&1 && [ "$START_SHA" != "$(git $GIT_DIR_FLAG rev-parse HEAD 2>/dev/null)" ]; then
  DIFF_CMD="git $GIT_DIR_FLAG diff ${START_SHA}..HEAD"
else
  DIFF_CMD="git $GIT_DIR_FLAG diff HEAD"
fi
```
`git diff HEAD` is the fallback for `auto_commit: false` (working-tree changes) or when no commit happened. If `$DIFF_CMD` is empty → write a minimal `{TASK_ID}-REVIEW.md` ("no diff to review") and skip the dispatches.

**Pattern scan.** Grep changed files (`$DIFF_CMD --name-only`) for the same risky patterns as forge-completer step 4a → `PATTERN_HITS`.

**Create timeline tasks:**
```
TaskCreate({ subject: "[{TASK_ID}] review", activeForm: "review · forge-reviewer (sonnet)" })
```

**Run the dialectic loop** — follow `shared/forge-review.md` Steps 2–7 with these bindings:
- `UNIT = task/{TASK_ID}`, `DIFF_CMD` as above, `MODE = interactive`, artifact = `.gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md`.
- > Antes de despachar cada agente de review (Challenge e Defense abaixo), exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com duração estimada para `review-challenger` / `review-advocate`.
- **Challenge** → `Agent({ subagent_type: 'forge-reviewer', prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: task/{TASK_ID}\nDIFF_CMD: {DIFF_CMD}" })`. `NO_FLAGS` → clean REVIEW, done.
- **Defense** → `Agent({ subagent_type: 'forge-advocate', prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: task/{TASK_ID}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}" })`.
- **Rebuttal** × `rounds` (default 1) → `forge-reviewer` with `DEFENSE` injected (rebuttal mode).
- **Resolve** via the Step 5 truth table; write the dialogue to `{TASK_ID}-REVIEW.md` (Step 6 template, `## Pattern hits` from `PATTERN_HITS`). The header carries the `**Pairing:**` line (`$PAIRING_LINE`, assembled in Step 0 of the shared spec) exactly as in `S##-REVIEW.md` — boundary-agnostic, no task-specific variant.
- **CONCEDED items → fix now (Step 7a):** dispatch `forge-executor` with `UNIT: review-fix/{TASK_ID}` (isolation header when `ISOLATION_MODE != shared` — fixes land in `CODE_DIR`) to fix ONLY the conceded items, minimal diffs, commit `fix(review): {TASK_ID} conceded items`. Mark each `**Correção:** aplicada — commit {sha}` or `falhou — virou follow-up`. Skip when `review.fix_conceded: false` — then list and ask once (legacy behavior). No re-review of the fix commit.
- **OPEN items (Step 7b):** for each, `AskUserQuestion` live (`Manter` / `Refatorar agora` — dispatches a `review-fix` unit / `Criar follow-up`) and record the decision.
- Any `Agent()` throw is recorded; the review **never aborts the task**.
- `style: flags` → single-pass: run the challenge only, write `## ⚠ Review Flags` (+ pattern hits) into `{TASK_ID}-REVIEW.md`. No defense/rebuttal/Ask.

**Append a pointer** to `{TASK_ID}-SUMMARY.md`:
```markdown
## Review
Dialectic review: {X resolved · Y conceded · Z open} — see [`{TASK_ID}-REVIEW.md`](./{TASK_ID}-REVIEW.md).
```
Skip the pointer if no `{TASK_ID}-REVIEW.md` was written.

**Event log** — append the `review` line to `.gsd/forge/events.jsonl` (`shared/forge-review.md § Step 8`, with `"unit":"task/{TASK_ID}"`).

**Follow-up commit** (only if `auto_commit: true` AND a `{TASK_ID}-REVIEW.md` was written):
```bash
git add .gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md .gsd/tasks/{TASK_ID}/{TASK_ID}-SUMMARY.md
git commit -m "chore({TASK_ID}): dialectic review"
```
Do NOT amend the `feat({TASK_ID})` commit — create a distinct follow-up.

After: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

Clean up `.start-sha` marker:
```bash
rm -f .gsd/tasks/{TASK_ID}/.start-sha
```

---

## Post-task housekeeping

**Append to event log:**
```bash
mkdir -p .gsd/forge
```
```json
{"ts":"{ISO8601}","unit":"task/{TASK_ID}","agent":"forge-executor","status":"done","summary":"{one-liner from SUMMARY.md}"}
```

**Memory extraction:**
> Antes de despachar o agente de extração de memória, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) — duração estimada `memory-extract`: ~1 min.
```
Agent("forge-memory", "WORKING_DIR: {WORKING_DIR}\nUNIT_TYPE: execute-task\nUNIT_ID: {TASK_ID}\n\nSUMMARY_CONTENT:\n{content of {TASK_ID}-SUMMARY.md}\n\nRESULT_BLOCK:\n{full ---GSD-WORKER-RESULT--- block verbatim}\n\nKEY_DECISIONS:\n{key_decisions from SUMMARY.md frontmatter, or '(none)'}")
```

**Write ledger entry to fragment store** — pipe a JSON payload to `forge-ledger.js --write`. The global LEDGER is rebuilt from fragments by the merger; do not append to it directly.
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-ledger.js ] && echo scripts || echo "$HOME/.claude/scripts")
node "$FORGE_SCRIPTS_DIR/forge-ledger.js" --write --cwd . <<'EOF'
{
  "id": "{TASK_ID}",
  "title": "{TASK_DESCRIPTION}",
  "completed_at": "$(date -u +%FT%TZ)",
  "slices": [],
  "key_files": ["path/to/file"],
  "key_decisions": ["one-liner"],
  "body": "{2-sentence description of what was done and why it matters}"
}
EOF
```
Keep each entry under 10 lines. This is the only task artifact that persists regardless of `task_cleanup` setting.

**Cleanup task artifacts** — based on `task_cleanup` from PREFS (default: `keep`):
- `keep`: do nothing — all files remain in `.gsd/tasks/{TASK_ID}/`
- `archive`: move the task directory to archive:
  ```bash
  mkdir -p .gsd/archive/tasks
  mv .gsd/tasks/{TASK_ID} .gsd/archive/tasks/{TASK_ID}
  ```
- `delete`: remove the task directory entirely:
  ```bash
  rm -rf .gsd/tasks/{TASK_ID}
  ```
In all cases the ledger fragment (`.gsd/ledger/{TASK_ID}.md`), `AUTO-MEMORY.md`, `DECISIONS.md`, and `CODING-STANDARDS.md` are never touched.

**Isolation cleanup** — runs ONLY here (task completed), never on pause/blocked/partial exits (the branch/worktree must survive for `--resume`). No-op when `ISOLATION_MODE == shared`; `branch` mode checks the repo back out to the default branch (the `forge/{TASK_ID}` branch is kept for PR/merge by the operator); `worktree` mode removes the worktree only if `worktree_cleanup_on_complete: true` in prefs:
```bash
node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --cleanup --run "$TASK_ID" --cwd "$(pwd)" || true
```

**Final report:**
```
✓ {TASK_ID} concluída: {TASK_DESCRIPTION}

Arquivos modificados:
{key_files from SUMMARY.md, one per line}

Must-haves: todos verificados ✓

→ Nova task: /forge-task <descrição>
→ Ver tasks: /forge-status
```

---

## Compact signal

If `session_units >= COMPACT_AFTER` and `{TASK_ID}-SUMMARY.md` does not yet exist:

```
---GSD-COMPACT---
task: {TASK_ID}
session_units: {N}
resume: /forge-task --resume {TASK_ID}  # e.g. T-20240115103045-fix-login-bug
---

Batch de {N} unidades completo para {TASK_ID}.
Execute /forge-task --resume {TASK_ID} para continuar.
```
