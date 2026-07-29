# Forge runtime-neutral protocol

`scripts/forge-runtime.js` is the executable, canonical source for this
protocol. This document explains the stable meaning of its fields; it does not
duplicate the module's executable tables.

Protocol version: `1.0.0`.

## Purpose

Forge has two independent concerns that older configuration often called
“engine”:

- the CLI process hosting Forge;
- the engine that will execute a particular worker.

The protocol keeps those concerns apart. It also gives units, results,
lifecycle records and security metadata a provider-neutral shape. A consumer
may retain its legacy routing and model choices while gradually adding these
fields.

The contract is semantic only. It starts no process, chooses no model, grants
no filesystem access and does not implement a sandbox.

## Versioning

Every normalized object includes `protocol_version`. Version `1.0.0` is
accepted by the schema and emitted by the module. An incompatible field or
meaning change requires a protocol-version change.

The JSON schema at `schemas/forge-runtime.schema.json` is a machine-readable
projection of this protocol. The standalone test checks the version and closed
enums for drift against the executable source.

## Host runtime

`host_runtime` names the CLI that is currently hosting Forge:

- `claude`
- `codex`

It is not a model family, a routed model ID, a sidecar trigger, or a user
preference. In particular, `gpt-*` belongs to a model-family adapter concern;
it does not make `host_runtime` equal to `gpt`.

When `host_runtime` is omitted, it defaults to `claude`. This preserves the
Claude-first compatibility behavior of Forge 3.1.4. A supplied unknown value
fails with `invalid-host-runtime`; it never degrades to another provider.

## Worker engine and mode

`worker_engine` identifies the execution target independently of the host. Its
closed values are `native`, `claude`, `codex`, and `agy`.

`worker_mode` declares how that target is reached:

- `native` executes inside the current host runtime;
- `sidecar` denotes an explicitly requested separate worker combination.

Omitted worker fields normalize to `worker_engine: native` and
`worker_mode: native`. With the legacy host default this resolves to Claude.

`native` is resolved only from `host_runtime`. It never reads a model ID,
`engine`, `dispatch_engine`, `workers.*`, or a model-family fallback. Therefore
`{ host_runtime: "codex", worker_engine: "native" }` resolves to Codex even
when a current route happens to contain a Claude model.

## Valid worker examples

Native execution on the Claude host:

```json
{ "host_runtime": "claude", "worker_engine": "native", "worker_mode": "native" }
```

Native execution on the Codex host:

```json
{ "host_runtime": "codex", "worker_engine": "native", "worker_mode": "native" }
```

An explicitly declared Codex sidecar from a Claude host:

```json
{
  "host_runtime": "claude",
  "worker_engine": "codex",
  "worker_mode": "sidecar",
  "sidecar_declared": true
}
```

The declaration is a protocol assertion by the caller. It is not permission to
launch a process. An adapter or later security layer can still refuse it.

## Invalid worker examples

This tries to select Codex while claiming native execution on Claude:

```json
{ "host_runtime": "claude", "worker_engine": "codex", "worker_mode": "native" }
```

It is rejected with `native-engine-host-mismatch` instead of silently becoming
a sidecar.

This makes a sidecar request without declaring it:

```json
{ "host_runtime": "claude", "worker_engine": "codex", "worker_mode": "sidecar" }
```

It is rejected with `sidecar-declaration-required`.

This is implicit recursion on the Codex host:

```json
{ "host_runtime": "codex", "worker_engine": "codex", "worker_mode": "sidecar" }
```

It is rejected with `implicit-recursion-refused`. The same combination is
representable only when the caller explicitly sets `sidecar` or
`sidecar_declared` to `true`.

`worker_engine: native` with `worker_mode: sidecar` is always rejected as
`native-sidecar-conflict`.

## Unit contract

A unit has `id`, `type`, and a provider-neutral state. The permitted states
cover scheduling and terminal outcomes without referring to a host:

`queued` → `leased` → `running` → `completed | failed | cancelled`.

The module does not persist this sequence and does not acquire a lease. Those
operations belong to lifecycle/stateful layers. Its job is to normalize the
record and reject an unknown state with `invalid-unit-state`.

## Result contract

A result has a `status`, stable `reason_code`, and `output`. Status is one of
`succeeded`, `failed`, or `cancelled`.

For example:

```json
{
  "status": "failed",
  "reason_code": "verification-failed",
  "output": { "exit_code": 1 }
}
```

Reason codes are plain, provider-neutral identifiers. A host adapter can add
diagnostic text outside this core contract without changing the outcome.

## Lifecycle contract

Lifecycle records describe handoff progression, not a particular CLI's event
names. The allowed lifecycle states are:

`created` → `dispatched` → `accepted` → `running` → `terminal`.

`reason_code` is available for transitions such as `lease-acquired`,
`dispatch-refused`, or `verification-failed`. This module validates the closed
state vocabulary but does not enforce a persisted transition graph.

## Security metadata

Security metadata is intentionally declarative:

```json
{
  "role": "reviewer",
  "required_capabilities": ["repo.read", "artifact.comment"]
}
```

Roles are `orchestrator`, `worker`, `reviewer`, and `observer`. The capability
array says what a unit requires. It does not mean those capabilities are
granted, available, checked, or enforced. There is no grant field in the
schema; sandboxing and permission enforcement are owned by the security layer.

## Compatibility boundaries

This protocol does not change existing `engine`, `dispatch_engine`,
`workers.*`, routing, or preference consumers. Existing dispatch code can keep
using its model-family semantics. Adapters may map legacy data into this
contract at a boundary, but must not reinterpret a model family as a host.

Unknown input is rejected deterministically. Missing host/worker input is the
only compatibility default and stays Claude-first.

## CLI and library use

The module is CommonJS and zero-dependency:

```js
const { validateRuntimeContract } = require('./scripts/forge-runtime.js');
const normalized = validateRuntimeContract({ host_runtime: 'codex' });
```

For simple inspection, pass one JSON object as the CLI argument:

```text
node scripts/forge-runtime.js '{"host_runtime":"codex","worker_engine":"native"}'
```

On invalid input the CLI writes the stable reason code to stderr and exits
nonzero. Callers that need richer policy should use the exported pure
normalizers and make enforcement decisions outside this module.
