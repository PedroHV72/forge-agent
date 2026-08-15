# Forge Claim Gate — Cross-run write lease at the dispatch boundary

Authoritative spec for the **cross-run claim gate**: before an orchestrator dispatches a unit that
will write code, it records what that unit claims to write into its own `RunRecord` and confronts
that claim against the claims of every other active run sharing the same `CODE_DIR`. A measured
collision **stops the dispatch** — it never becomes a merge conflict discovered hours later.

This file is boundary-agnostic and has **three consumers**, exactly like `shared/forge-review.md`:

| Consumer | Boundary | MODE | Unit types gated |
|----------|----------|------|------------------|
| `skills/forge-auto/SKILL.md` | before each `Agent()` dispatch of a task in the ready batch | `auto` | `execute-task`, `review-fix` |
| `skills/forge-next/SKILL.md` | before the single `execute-task` dispatch of the derived unit | `interactive` | `execute-task`, `review-fix` |
| `shared/forge-review.md` (Steps 7a and 9) | before each `review-fix` dispatch | inherits the caller's MODE | `review-fix` |

**Formula-once is the point of this file, not a style preference.** The decision table (§ Step 3),
the canonical invocation (§ Step 2) and the escalation procedure (§ Step 4) live here **once**. A
consumer that restates any of them creates a second source that will drift, and the drift between
two orchestrators is exactly the failure this decomposition exists to prevent (S04-PLAN contract #1,
W5 of the risk radar). Consumers **reference**; they never re-derive, re-tabulate or re-implement.

## Posture: ENFORCING (this gate is not advisory)

Nearly every other mechanism in this repo is advisory — it writes a flag into a summary and lets the
loop continue. **This one is not.** Its whole purpose is to refuse a dispatch, so:

- A decision of `block` or `refuse` **stops the unit**. There is no "proceed anyway" branch.
- A `defer` with nowhere to defer to becomes `block` (the D3 floor, applied inside the module).
- Tooling failure is treated as `block`, loud — see **§ Fail-closed**.

The justification is the origin defect of this milestone: a gate that goes mute is byte-for-byte
indistinguishable from a gate that approved. Silence must never be readable as consent.

## Inputs

- `WORKING_DIR` — absolute workspace root. The run registry (`.gsd/forge/runs/`) and the event log
  (`.gsd/forge/events.jsonl`) live **here**, never in the worktree, so every `--cwd` of the gate
  points at `WORKING_DIR` even when the code lives elsewhere.
- `RUN_ID` — this orchestrator's run id (the own side; excluded from the counterpart universe).
- `UNIT` — the unit string, **verbatim**, in whichever of the three grammatical forms the dispatch
  already uses (`execute-task/T03`, `review-fix/{S##}`, `review-fix/{M###}-triage`). The gate keys
  its defer ledger on this string and never parses it; do not normalise, shorten or invent a form.
- `CODE_DIR` — only when the dispatch **already resolved** it (see **§ B2**).
- `MODE` — `auto` (forge-auto) or `interactive` (forge-next / forge-task-style boundaries).
- The claim source — one of `--plan`, `--conceded`, `--paths` (see **§ Step 1**).

## Step 0 — Prefs are read BY THE MODULE, not by the consumer

`parallelism.cross_run_overlap` (the posture) and the three anti-livelock timings
(`parallelism.block_wait_ms`, `parallelism.block_poll_ms`, `parallelism.defer_cap`) are resolved
**inside `scripts/forge-claim-gate.js`** through the canonical prefs engine.

The consumer therefore does **not** read them, does not extract them with a `node -e` one-liner, and
does not pass them in. A second reader of the same knob is a second default, and a default that
drifts from the schema turns the documented value into a lie for anyone who never wrote a prefs
file. `--posture` exists only as a deliberate **operator override** and is not used by the two
orchestrators in their normal flow.

Consequence for the consumer: a posture of `defer` versus `block` produces different decisions from
an identical collision, and the consumer must handle both — it cannot assume one of them.

## Step 1 — Deriving the claim, per unit type

The claim is the set of **files the unit will write**. How it is derived depends on the unit:

**`execute-task`, single unit (forge-next, and each member of a forge-auto batch).**
Pass `--plan <path to T##-PLAN.md>`. The module derives `writes:` ∪ `expected_output:` through the
shared coverage helper — the consumer never re-computes that union, and never hand-builds a path
list from a plan it read itself.

**A batch of ready tasks (forge-auto parallel dispatch).** The order is fixed and is not an
implementation detail:

1. Record the **union** of the whole ready batch first, as one claim, before evaluating anything
   (`--claim-and-check --paths <union csv> --unit "BATCH:<ids csv>"`). The union itself is derived
   with one `--evaluate --plan <path>` per member, reading `.claim.paths` from each result — a
   derivation that fails is **fail-closed** (`gate-unavailable`), never an empty union.
2. Evaluate **per task** with **`--check-only`**, each against the counterpart universe.
3. Drop every task whose decision is not `proceed` from the batch.
4. Re-record the union of the **survivors**, so the persisted claim describes what will actually
   run. **Zero survivors is a named case:** nothing is dispatched, so the run must hold no fence —
   clear the claim (`forge-write-claim.js --clear`) instead of leaving the original union standing.

**Why `--check-only` and not `--claim-and-check` in the loop.** `recordClaim` is a **single slot**
(`forge-write-claim.js` — `runs.update({ write_claim })` replaces wholesale). A per-task
`--claim-and-check` would therefore destroy the union recorded in item 1 two lines after writing it,
and each task would be confronted while the RunRecord described only that task. `--check-only`
evaluates the derived claim and **emits the event** (so item 1's visibility rule and § Step 5's
"the event is written by code" both hold) while **preserving** the persisted claim.

Why: recording the union first makes the fence visible to a symmetric run during the window in which
this run is still deciding (contract #6 — an invisible fence does not fence). Re-recording after the
drops keeps the claim honest: leaving the original union in place would block counterparts on files
this run has already decided not to touch.

**`review-fix` (both call sites).** Pass `--conceded` with the conceded items as a JSON array of
`{r, path, line}` — the `path:line` of each item, taken from the review artifact. The module strips
the `:line` suffix (a claim is about files) and de-duplicates.

An item that arrives **with no path** is a named branch, never a quiet degradation: the module
returns `refuse` with cause `pathless-conceded-item` and names the offending `R#`s. See D7 handling
in **§ Step 3** and in `shared/forge-review.md § Step 7a`.

**Explicit paths (`--paths a,b,c`).** For operator/manual use and for boundaries that already know
their file list. Not used by the two orchestrators.

## Step 2 — The canonical invocation

One block. Consumers copy this shape; they do not invent flag combinations around it.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-claim-gate.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")

GATE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-claim-gate.js" --claim-and-check \
  --run "$RUN_ID" \
  --unit "$UNIT" \
  --source plan-writes \
  --plan "$PLAN_PATH" \
  ${CODE_DIR:+--code-dir "$CODE_DIR"} \
  --ready-alternatives "$READY_ALTERNATIVES" \
  --cwd "$WORKING_DIR" \
  --json)
GATE_EXIT=$?
```

- `--claim-and-check` is the operational entry point for a **single** unit: it **records the claim
  before evaluating** and emits the `claim-gate` event. Its batch sibling is `--check-only`, which
  evaluates and emits the event but **preserves** the persisted claim (see § Step 1). `--evaluate`
  neither records nor logs; it is for inspection, tests, and for deriving a claim's paths
  (`.claim`, present on all three modes) when computing a batch union. A decision that gates a
  dispatch is never taken on `--evaluate`.
- `--source` is `plan-writes` for `execute-task` and `review-fix-paths` for `review-fix`; substitute
  `--plan "$PLAN_PATH"` with `--conceded "@$ITEMS_JSON_FILE"` at the review-fix call sites.
- `--cwd "$WORKING_DIR"` — always the workspace, never `CODE_DIR`.
- `--ready-alternatives` is computed **by the consumer** (how many other units it could dispatch
  right now instead). It is what makes the D3 floor meaningful; when the consumer does not know, the
  honest value is `0`, which fails closed.
- `--wait` is added by any consumer willing to spend the wait inside its own tool call (see
  **§ Step 3**, `block` row). `MODE == auto` passes it **unconditionally**: the module polls only
  when the decision is `block`, which is behaviourally identical to "when the effective posture is
  `block`" — and § Step 0 forbids the consumer from pre-reading the posture pref, so a conditional
  flag would be unactionable. The module polls up to
  `parallelism.block_wait_ms`; expiry becomes the `wait-ceiling` escalation and **never** becomes
  `proceed`.
- `--json` always: the consumer parses `.decision`, `.cause`, `.escalation`, `.census`,
  `.not_covered`, `.counterparts`. The human-readable form is for the operator, not for parsing.

### B2 — `--code-dir` is a given fact, and its absence is also a fact

`--code-dir` is passed **only** with the value the dispatch already resolved. When
`scripts/forge-code-dir.js` refused (cross-repo, undeclared) or no `CODE_DIR` exists for this
dispatch, the flag is **omitted**. The recorded claim then carries `code_dir: null`, its scope
against every counterpart is `unknown`, and `unknown` **stays in scope** — the gate fails closed.

**Explicitly prohibited:** passing `$WORKTREE_DIR`, the workspace root, or any value derived from
`root` + `branch` + `isolation_mode` as a fallback. A guessed `CODE_DIR` that happens to differ from
a counterpart's real one takes the pair *out* of scope and silently disarms the fence — the failure
mode is invisible and looks exactly like a clean run. An honest `null` over-blocks; a guess
under-blocks. This gate prefers the former, by decision (contract #7).

## Step 3 — Decision × mode

The module returns exactly one of four decisions. **This table is the single source; consumers act
on it by reference.**

| decision | `MODE == auto` (forge-auto) | `MODE == interactive` (forge-next) |
|---|---|---|
| `proceed` | Dispatch normally. | Dispatch normally. |
| `defer` | Drop this task from the ready batch, echo one line naming the counterpart and the colliding paths, and continue with the rest of the batch. Never dispatch it this pass. | Try another ready unit if one exists; otherwise surface the collision to the operator with the instruction to re-run once the counterpart commits. |
| `block` | `--wait` is always passed, so the module already polled to the ceiling before returning. Stop this unit. If `escalation` is set → **§ Step 4**. | Surface immediately (no wait — a human is present and waiting silently is worse than telling them): name the counterpart run, the paths, and the legitimate exits from **§ Step 4**. |
| `refuse` | Stop this unit, surface the cause, do not retry — waiting cannot fix it. | Same, plus the concrete repair. |

`escalation` is a **field**, never a fifth decision: the decision stays `block`/`defer` and the
consumer acts on `wait-ceiling` / `defer-cap` per **§ Step 4**.

**The three causes carry different messages, and substituting one for another is a defect.**

- `overlap` — both sides declared and the declared paths intersect. A **measured** collision. Name
  the intersecting paths (`.counterparts[].paths`) and the counterpart run id.
- `undeclared-writes` — a side carries no claim or an empty one. Check `.undeclared_side`:
  `own`/`both` arrives as `refuse` (the plan must declare `writes:`; that is the repair to state),
  while `counterpart` arrives as `defer`/`block` (the other run's plan is at fault — this run is not
  asked to fix it, only to wait or step aside).
- `pathless-conceded-item` — D7. A conceded review item had no path, so the claim could not be
  derived. This is `refuse`, and the repair is stated against the review item, not against a plan.

**`proceed` has two reasons and they are not interchangeable.** `no-conflict` means counterparts
were confronted and none collided; `no-active-counterpart` means **nothing was confronted at all**.
When echoing a proceed, echo the reason — a proceed that compared nothing must never be reported in
the language of a clean comparison.

## Step 4 — Escalation (the Account Handoff Procedure form)

Triggered when `.escalation` is `wait-ceiling` or `defer-cap`, and used as the surfacing shape for
any `block`/`refuse` that stops a run. Two symmetric runs that record before evaluating see each
other and **both** stop; that livelock is resolved by escalating to the operator, never by a
tie-break, ordering or priority — those are an integration queue, the locked frontier of S07.

**1. Checkpoint.** When inside a slice, write `continue.md` per the Continue-Here Protocol so the
next session resumes exactly here.

**2. The event is already written.** `--claim-and-check` emitted the `claim-gate` line itself, in
code (see **§ Step 5**). Do not hand-write a second line narrating it.

**3. Stop.** `MODE == auto` → deactivate this run (the same deactivation the pause path uses), which
stops the loop while leaving the state recoverable. `MODE == interactive` → surface directly; there
is no run to deactivate.

**4. Emit an actionable message.** It must name the **counterpart run**, the **cause**, the
**paths**, and the legitimate exits:

```
⛔ Claim gate — {decision}/{cause}{escalation ? " (escalação: " + escalation + ")" : ""}
   Unidade: {UNIT}   Run: {RUN_ID}
   Counterpart: {counterpart run id}   Caminhos em disputa: {paths}

   Saídas legítimas:
   1. Aguardar o commit da run counterpart e re-rodar esta unidade.
      (Atenção: em S04 o claim NÃO é liberado pelo commit — ver § Over-block abaixo.)
   2. Liberar o claim manualmente, com consciência do risco:
        node scripts/forge-write-claim.js --clear {counterpart run id} --cwd "{WORKING_DIR}"
   3. Ajustar as prefs: parallelism.cross_run_overlap (defer|block),
      parallelism.block_wait_ms, parallelism.block_poll_ms, parallelism.defer_cap.
```

**The gate never proceeds on escalation.** Escalation is the anti-livelock valve, not a timeout that
degrades into approval. If the operator wants the dispatch to happen anyway, they take exit 2 or 3
above — an explicit, recorded human act.

### Over-block between S04 and S05 is design, not a bug

Between this gate going live (S04) and release-on-commit (S05), **claims are not released**. A
counterpart that already committed and finished still holds its claim, so this gate will keep
blocking against it. This is disclosed, not accidental: erring toward blocking is accepted, erring
toward the incident is not.

The only release that exists in S04 is natural overwrite — when the **same** run records the claim
of its next unit, the previous one is replaced (the claim carries the current unit, by S03's
design). An operator facing a persistent block after the counterpart has committed should either
wait for S05 or clear the claim manually with `forge-write-claim.js --clear`, exit 2 above.

## Step 5 — The event, and the mandatory enumeration

**The event is written by code**, inside the module, on every `--claim-and-check`. The consumer does
not narrate it. This repo has measured what happens when the only record of a routing decision is a
line the model was asked to write (TASK-021: an entire slice fell through to a different engine and
the session narrated it as a tooling bug).

Shape appended to `.gsd/forge/events.jsonl` of `WORKING_DIR` — documented for **readers**, never for
retyping:

```json
{"event":"claim-gate","ts":"<ISO-8601>","run":"<run id>","unit":"<unit verbatim>","decision":"proceed|defer|block|refuse","cause":"overlap|undeclared-writes|pathless-conceded-item|null","undeclared_side":"own|counterpart|both|null","posture":"defer|block","posture_source":"prefs|fallback|invalid-pref|explicit","escalation":"wait-ceiling|defer-cap|null","floor":"defer-floor|null","counterparts":[{"id":"<run>","cause":"...","paths":["..."],"scope":"same|unknown","note":"<S03 note|null>"}],"census":{"runs_examined":N,"counterparts_considered":N,"counterparts_in_scope":N,"skipped":[{"id":"<run>","reason":"different-code-dir"}],"notes":[{"id":"...","reason":"..."}]},"not_covered":[{"boundary":"...","reason":"..."}]}
```

Additive-field convention, same as `tier`/`reason` from M002: readers that do not recognise a field
ignore it. `scope: unknown` with an S03 `note` is what lets an operator tell a block backed by
**measured** identity from a block backed by unknown identity.

**Mandatory enumeration.** Every gate execution — including `proceed` — carries `not_covered` with
three boundaries, and the consumer **prints it** every time:

| boundary | why it is not covered |
|---|---|
| `complete-slice` | releasing the claim at the completer collides with the IN-6 release (S05) |
| `orchestrator-writes` | the orchestrator's own `.gsd/**` writes do not pass through a claim |
| `forge-task` | this milestone's Boundary Map limits the wiring to `forge-auto`/`forge-next`; `/forge-task` does not invoke the gate |

A gap the operator can read is a decision; a gap nobody prints is an omission wearing the clothes of
coverage. If a consumer finds this list noisy, the fix is to close a boundary — not to stop printing
it.

## Fail-closed — tooling failure is a block, and it is loud

```bash
if [ "$GATE_EXIT" -ne 0 ] || ! printf '%s' "$GATE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})"; then
  echo "⛔ Claim gate indisponível (exit $GATE_EXIT) — tratando como block/gate-unavailable. Nenhum dispatch." >&2
  # Stop this unit. MODE == auto: deactivate the run per § Step 4 step 3.
fi
```

Exit `0` means **evaluated** — the decision travels in the payload, so a `refuse` is a successful
run of the tool. Exit `1` is an internal error and exit `2` is a malformed invocation; both mean
*no decision was produced*.

**Why this breaks the house convention.** Advisory mechanisms in this repo fail silently on purpose:
a broken advisory check that stops the loop costs more than the signal it provides. That trade
inverts here. This gate exists to refuse dispatches, so a mute gate is not a lost signal — it is an
approval nobody authorised, and it is indistinguishable from a clean `proceed` at every downstream
reader. `gate-unavailable` is therefore surfaced loudly and treated as `block`, never swallowed and
never defaulted to proceed.

## What this gate deliberately does not do

- **No ordering, no tie-break, no priority between runs.** Symmetric collision escalates to the
  operator. Choosing a winner is an integration queue — an entire product, and the locked frontier
  of S07.
- **No granularity heuristics.** A wide glob in a plan produces a wide claim and may over-block. The
  milestone's posture is to *measure first*: the gate counts and names its refusals in the event; no
  heuristic softening enters S04.
- **No worker prompt changes.** The dispatch templates in `shared/templates/dispatch/` are **not**
  touched by this gate. The claim is recorded and evaluated by the orchestrator before the worker
  exists; nothing about the worker's prompt changes (MEM002 — assertions about prompt structure aim
  at the templates, never at prose).
- **No re-implementation of the confrontation algebra.** Path intersection, `code_dir` scope and
  claim collection come from `scripts/forge-claim-overlap.js` (S03). The intra-slice conflict
  predicate of `scripts/forge-parallelism.js` has the **opposite polarity** (an empty list means no
  conflict there) and is correct in its own boundary; it is neither imported nor consulted here, and
  suites guard that absence in both modules.

## Cross-references

- `scripts/forge-claim-gate.js` — the decision core and the CLI invoked in **§ Step 2**
- `scripts/forge-claim-overlap.js` — S03 confrontation algebra (`claimsConflict`, `codeDirScope`,
  `collectRunClaims`, `CONFLICT_CAUSES`, `CLAIM_NOTE_REASONS`)
- `scripts/forge-write-claim.js` — claim record/read primitives and `--clear` (manual release,
  **§ Step 4** exit 2)
- `shared/forge-dispatch.md § Cross-run claim gate` — pointer plus the `claim-gate` event fields
- `shared/forge-review.md § Step 7a`, `§ Step 9` — the two `review-fix` call sites
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — the two orchestrator consumers
- `forge-agent-prefs.jsonc § Parallelism Settings` — `parallelism.{cross_run_overlap, block_wait_ms,
  block_poll_ms, defer_cap}`
