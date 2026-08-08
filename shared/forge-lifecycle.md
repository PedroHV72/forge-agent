# Forge long-workflow lifecycle

`scripts/forge-loop-controller.js` is the provider-neutral loop boundary for
`auto` and `task`. It delegates selection, leases, durable boundaries and
resume/handoff to `forge-orchestrate`; it does not spawn or choose workers.

States are `idle → dispatch_required | paused | completed | blocked | failed`.
`next` returns a dispatch intent while the S02 lease remains authoritative.
`pause` creates a durable boundary through `forge-orchestrate`. Only `resume`
may explicitly change `host_runtime`, and only with that boundary. A repeated
command with the same snapshot/idempotency key is safe and does not acquire a
second lease or increment the step counter.

The adapter supplies only `host_runtime`, mode, normalized input and
presentation. It must not read provider homes, infer worker/model, spawn a CLI,
or fall back to another host. Dispatch remains the S06 boundary.
