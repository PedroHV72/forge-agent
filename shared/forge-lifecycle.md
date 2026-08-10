# Forge long-workflow lifecycle

`scripts/forge-loop-controller.js` is the provider-neutral loop boundary for
`auto` and `task`. It delegates selection, leases, durable boundaries and
resume/handoff to `forge-orchestrate`; it does not spawn or choose workers.

Both modes are milestone-scoped: `task` is the same controller with a one-unit
budget and a terminal resume, not a second selection domain. Selection lives in
`forge-orchestrate` → `forge-unit-controller.selectNextUnit`, whose every branch
reads a milestone's roadmap/slices, over state that `forge-state` reads only from
`.gsd/milestones/<id>/<id>-STATE.md`. A **standalone task** (`/forge-task`, whose
artifacts live in `.gsd/tasks/<id>/` with no STATE and no roadmap) is therefore
outside this boundary, and `next`/`pause` refuse it by name: `outcome: blocked`,
`reason_code: task-scope-unsupported`, `action: stop`, snapshot unchanged. That
refusal is the defined answer, not a malfunction — the caller proceeds under its
own authority. Supplying an unrelated milestone id to reach a dispatch is never
the workaround: it selects that milestone's next unit and commits a lease and a
transaction against it.

States are `idle → dispatch_required | paused | completed | blocked | failed`.
`next` returns a dispatch intent while the S02 lease remains authoritative.
`pause` creates a durable boundary through `forge-orchestrate`. Only `resume`
may explicitly change `host_runtime`, and only with that boundary. A repeated
command with the same snapshot/idempotency key is safe and does not acquire a
second lease or increment the step counter.

The adapter supplies only `host_runtime`, mode, normalized input and
presentation. It must not read provider homes, infer worker/model, spawn a CLI,
or fall back to another host. Dispatch remains the S06 boundary.
