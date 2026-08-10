# Forge runtime compatibility

Forge is one package with one release line.

The product version comes from the Git tag and release workflow.

`forge-capabilities.json` versions its schema only.

It never declares an independent Claude or Codex product version.

Claude Code and Codex CLI are optional adapters of that same release.

This document describes the catalog contract, not an installer promise.

## Canonical matrix

Generate the current matrix from the repository:

```text
node scripts/forge-capabilities.js --matrix --cwd .
```

For automation, request stable JSON:

```text
node scripts/forge-capabilities.js --matrix --json --cwd .
```

The JSON payload is deterministic.

Rows are ordered by `capability_id`.

Catalog paths always use `/`, including when the command runs on Windows.

The human table and the JSON payload come from the same catalog.

Do not copy either output into a separate compatibility spreadsheet.

## Availability vocabulary

`implemented` means the adapter currently ships and the cataloged probe exists.

`planned` means it is required or intentionally tracked, but not implemented for that host.

`conditional` means it is available only when its local host integration is configured.

`unavailable` means the release intentionally does not expose that capability on that host.

These are host-specific classifications.

They do not create separate Forge products.

Every row includes both `claude` and `codex` statuses.

Every row also has an owner and a stable `capability_id`.

Some rows include an explicit `platforms` map when the surface is restricted
to an operating system. An omitted map means the catalog has no
platform-specific restriction for that surface.

An ID is kebab-case and must not be reused for another surface.

## Current release posture

The checked-in skills, agents, and slash commands are Claude implementations.

They are cataloged as `implemented` for Claude Code.

Their Codex CLI counterparts are `planned` until a future adapter ships.

The statusline is conditional because it depends on local configuration.

Accounts are conditional for the same reason.

Forge.app is conditional for Claude on macOS only. Its platform matrix marks
Windows and Linux unavailable; it is unavailable for Codex on every platform.

Hooks are implemented for Claude and planned for Codex.

Headless dispatch is implemented for Claude and planned for Codex.

MCP management is implemented for Claude and planned for Codex.

Planned is deliberately not rendered as green.

This preserves a truthful path toward parity.

## Capability probes and floors

Forge detects capabilities; it does not pin an exact CLI version in this catalog.

A probe is the observable prerequisite a capability needs.

The current catalog uses filesystem probes for repository-owned surfaces.

Future adapters can add host commands or feature probes without changing the release rule.

An installer should detect Node by executing the selected Node binary.

An adapter should detect Claude Code by asking the installed CLI for its supported feature.

An adapter should detect Codex CLI in the same capability-oriented way.

The detected feature is the floor.

An exact version is only useful as an operator diagnostic.

It is not the compatibility contract.

This avoids false failures on patched or vendor-packaged builds.

It also allows an adapter to support a newer CLI without a catalog rewrite.

## Audit gate

Run the mechanical coverage audit before releasing changes to published surfaces:

```text
node scripts/forge-capabilities.js --check --cwd .
```

The audit loads both the catalog and its schema.

It compares the schema host enum with `scripts/forge-runtime.js`.

It discovers Forge skills from `skills/*/SKILL.md`.

It discovers Forge agents from `agents/forge-*.md`.

It discovers Forge commands from `commands/forge*.md`.

Every discovered surface must have exactly one catalog probe.

The kind in the catalog must match the discovered kind.

The audit rejects duplicate IDs.

The audit rejects duplicate probe paths.

The audit rejects invalid hosts, platform keys, and availability values.

The audit rejects a missing owner.

The audit rejects a required capability without a probe.

The audit rejects a required probe whose path is missing.

The audit rejects product versions declared outside the Git release workflow.

The audit rejects adapters that are not optional.

## Operating-system behavior

The loader is plain Node.js and has no package dependency.

It is intended to run on Windows, macOS, and Linux.

Filesystem access uses Node `fs` and `path` rather than shell globbing.

Rendered paths use `/` on every operating system.

Sorting is performed on stable capability IDs.

The test suite compares repeated JSON output to protect determinism.

Use `--cwd` to audit another checkout.

The working directory may be absolute or relative.

The catalog itself remains rooted at that checkout.

## Adding a surface

Add the real published surface first.

Add exactly one capability entry to `forge-capabilities.json`.

Choose a stable ID based on the surface, not an implementation detail.

Set the accountable owner.

Classify Claude and Codex separately.

Declare whether the capability is required.

Add a normalized probe path.

Run the audit.

Add a negative fixture when the new validation rule needs coverage.

Update this document if the release posture changes.

Do not use the catalog as an installation manifest.

Do not add a runtime-specific product version.

Do not call a planned Codex capability implemented before its adapter ships.

## Verification

Run the standalone suite:

```text
node scripts/forge-capabilities.test.js
node scripts/forge-native-runtime.test.js
```

Then run the release-oriented commands:

```text
node scripts/forge-capabilities.js --check --cwd .
node scripts/forge-capabilities.js --matrix --json --cwd .
```

The native runtime regression confirms existing Claude contracts stay cataloged.

It also prevents hooks, headless execution, and MCP from being mislabeled as Codex implementations.

Future slices may generate or install adapters.

They must update the host status and probe evidence in this one matrix.

They must not fork Forge into a Claude release and a Codex release.
