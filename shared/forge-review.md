# Forge Review — Dialectic Confrontation (per-slice)

Authoritative spec for the **review gate** that runs in the orchestrator context (skills `forge-auto` / `forge-next`) right before `complete-slice` is dispatched — while the slice branch `gsd/{M###}/{S##}` is still **unmerged**, so the diff is intact.

The gate stages two independent agents against the slice diff:

- **Challenger** — `forge-reviewer` (adversarial): finds bugs/brechas, frames each as an objection + a question.
- **Defender** — `forge-advocate` (author): refutes, concedes, or marks each objection `open`.
- One bounded **rebuttal** round (`review.rounds`, default 1): the reviewer sees the defense and either maintains or withdraws each objection.

The human only adjudicates what the two AIs genuinely disagree on. Everything else resolves between them. Advisory by design — the gate **never blocks** `complete-slice` and never returns a blocker.

> Why the orchestrator and not `forge-completer`: agents cannot call `Agent` or `AskUserQuestion`. The completer (`tools: Read, Write, Edit, Bash`) physically cannot dispatch the reviewer or ask the user. The skills run in the main context and own both tools.

## Inputs
- `WORKING_DIR` — absolute project root (bash-captured `pwd`, Windows-safe)
- `{M###}` — active milestone id
- `{S##}` — slice being completed
- `MODE` — `interactive` (forge-next) or `auto` (forge-auto)

## Step 0 — Read review prefs (3-file cascade)

```bash
REVIEW_CFG=$(node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let mode='enabled',style='dialectic',rounds=1,askAuto='defer';
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^review:[ \t]*\n((?:[ \t]+.*\n?)*)/m)||[])[1]||'';
  let m;
  if(m=blk.match(/^[ \t]+mode:[ \t]*(\w+)/m))mode=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+style:[ \t]*(\w+)/m))style=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+rounds:[ \t]*(\d+)/m))rounds=parseInt(m[1],10);
  if(m=blk.match(/^[ \t]+ask_in_auto:[ \t]*(\w+)/m))askAuto=m[1].toLowerCase();
}catch(e){}}
if(!['enabled','disabled'].includes(mode))mode='enabled';
if(!['dialectic','flags'].includes(style))style='dialectic';
if(!Number.isInteger(rounds)||rounds<0||rounds>3)rounds=1;
if(!['defer','pause'].includes(askAuto))askAuto='defer';
process.stdout.write(JSON.stringify({mode,style,rounds,askAuto}));
" WORKING_DIR=\"$WORKING_DIR\")
```

- `mode == disabled` → **skip the entire gate.** Proceed straight to `complete-slice`.
- `style == flags` → run the **legacy single-pass** (challenge only; write a `## ⚠ Review Flags`-style section into `{S##}-REVIEW.md`; no defense, no rebuttal, no Ask). Back-compat for users who don't want the debate.
- `style == dialectic` (default) → run Steps 1–7 below.

## Step 0a — Idempotency

If `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` already exists → **skip the gate** (a prior run, or a resume after compaction, already produced it). Proceed to `complete-slice`.

## Step 1 — Compute the slice diff

Default to the slice-branch range (`auto_commit: true` — the common case, branch still unmerged):

```bash
BASE=$(git merge-base HEAD master 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo HEAD~10)
DIFF_CMD="git diff ${BASE}...HEAD"
# Fallback for auto_commit: false (work uncommitted in the worktree) or an empty branch range:
if [ -z "$(eval "$DIFF_CMD" --name-only 2>/dev/null)" ]; then
  DIFF_CMD="git diff HEAD"
fi
```

If `$DIFF_CMD` still produces no changes → write a minimal `{S##}-REVIEW.md` stating "no diff to review" and proceed. Do not dispatch agents.

## Step 2 — Challenge (forge-reviewer)

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}" })
```

Parse the result:
- `NO_FLAGS` → no objections. Write a clean `{S##}-REVIEW.md` ("Reviewer found nothing to challenge."), proceed. Done.
- otherwise → capture the severity buckets as `OBJECTIONS` (each line carries a stable id `R#`, a `path:line`, the claim, and a `challenge:` question — see `agents/forge-reviewer.md § Output format`).

If the `Agent()` call **throws** → record a one-line note, write a `{S##}-REVIEW.md` stub noting the review could not run, and proceed. **Review failures never abort `complete-slice`.**

## Step 3 — Defense (forge-advocate)

```
Agent({ subagent_type: 'forge-advocate',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}" })
```

Capture per-objection verdicts: `R# → {refuted | conceded | open} + rationale`. A throw here → treat every objection as `open` (the defense couldn't be heard) and continue.

## Step 4 — Rebuttal (forge-reviewer, rebuttal mode) × `rounds`

Skip if `rounds == 0`. Otherwise, for `i` in `1..rounds` (default 1), feed the defense back to the reviewer:

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}\nDEFENSE:\n{DEFENSE}" })
```

When `DEFENSE` is present the reviewer runs in **rebuttal mode** (`agents/forge-reviewer.md § Rebuttal mode`): it only re-litigates objections the advocate `refuted` or marked `open`, returning `maintained` or `withdrawn` + a reason. Objections the advocate `conceded` are carried through as `conceded` (settled — nothing to rebut). A throw → treat all non-conceded objections as `maintained` (conservative). Only the last round's verdicts count.

## Step 5 — Resolve each objection

Truth table (advocate verdict × reviewer rebuttal):

| advocate | reviewer rebuttal | resolution |
|----------|-------------------|------------|
| conceded | (any) | **CONCEDED** — both see a real problem → action item |
| refuted | withdrawn | **RESOLVED** — advocate convinced the reviewer → no action |
| refuted | maintained | **OPEN** — genuine disagreement → human decides |
| open | withdrawn | **RESOLVED** — reviewer dropped it → no action |
| open | maintained | **OPEN** — true tradeoff → human decides |

With `rounds == 0` (no rebuttal), treat every objection's rebuttal as `maintained`.

## Step 6 — Write `{S##}-REVIEW.md`

The artifact is the **dialogue**, not a flag dump. Auditable, durable with the milestone.

```markdown
# S##: <slice title> — Review (Dialectic)
**Slice:** S##  **Milestone:** M###  **Reviewed:** YYYY-MM-DD  **Rounds:** {rounds}
**Outcome:** {X resolved · Y conceded · Z open}

## Abertas — requerem decisão humana
> O reviewer e o autor não chegaram a acordo. Você decide.
### R{n} — `path:line`
- **Objeção:** <claim> — _<challenge question>_
- **Defesa:** <advocate rationale>
- **Réplica:** <reviewer maintained reason>
- **Decisão:** _pendente_   ← preenchido no Step 7 (interactive) ou deferido (auto)

## Concedidas — problema real, ação recomendada
### R{n} — `path:line`
- **Objeção:** <claim>
- **Defesa:** conceded — <what should happen>

## Resolvidas no debate — sem ação
- R{n} `path:line` — <one-liner: por que caiu>

## Pattern hits (scan determinístico)
- `path:line` — pattern `{p}` — <context>   ← optional; deterministic grep, same patterns as forge-completer step 4a
```

Omit any section with zero items.

## Step 7 — Posture (handle OPEN + CONCEDED items)

**`MODE == interactive` (forge-next):**
- For each **OPEN** item, ask the human via `AskUserQuestion` — one question per item (or batched up to 4), header `Review`, options:
  - `Manter abordagem atual` — accept as-is (reviewer's concern noted, not acted on)
  - `Refatorar agora` — record intent to fix; the user can run a follow-up task
  - `Criar follow-up` — log it as a known issue to address later
  Write the chosen decision into the `**Decisão:**` line of that R# in `{S##}-REVIEW.md`.
- **CONCEDED** items: list them and ask once whether to address now (follow-up task) or record-and-continue. Default record-and-continue.

**`MODE == auto` (forge-auto):**
- `askAuto == defer` (default) — **do NOT pause.** Leave OPEN/CONCEDED items in `{S##}-REVIEW.md` with `**Decisão:** deferido (auto-mode)`. Echo one line to the user: `⚖ Review S##: {Z} aberta(s), {Y} concedida(s) — registradas em S##-REVIEW.md`. Continue the loop. This honors the AUTONOMY RULE — forge-auto never blocks for confirmation.
- `askAuto == pause` (opt-in) — run the same `AskUserQuestion` flow as interactive mode, accepting the pause.

The gate **never** returns a blocker regardless of posture. CONCEDED/OPEN items become follow-up work, surfaced — not enforced.

## Step 8 — Event log

Append one line per agent dispatch to `{WORKING_DIR}/.gsd/forge/events.jsonl` (I/O errors propagate — no silent-fail):

```json
{"ts":"<ISO-8601>","event":"review","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","style":"dialectic","rounds":N,"counts":{"resolved":N,"conceded":N,"open":N}}
```

## Legacy `style: flags` single-pass

When `style == flags`: run Step 2 only. Write the reviewer's findings (+ optional pattern hits) into `{S##}-REVIEW.md` under a single `## ⚠ Review Flags` heading. No advocate, no rebuttal, no Ask. This reproduces the pre-dialectic advisory behavior for users who opt out of the debate.

## Cross-references
- `agents/forge-reviewer.md` — challenger + rebuttal mode
- `agents/forge-advocate.md` — defender
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — gate invocation (before `complete-slice`)
- `forge-agent-prefs.md § Review Settings` — `review.{mode,style,rounds,ask_in_auto}`
- Artifact: `.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` (durable with the milestone; cleaned by `milestone_cleanup`)
