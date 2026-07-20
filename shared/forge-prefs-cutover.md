# Forge preferences cutover — M015 / S01

This is the canonical contract for the transition from Markdown preference
catalogs to JSONC. Consumers bind the contract at their own boundary, but the
engine, the error shape, and the user-facing repair message are defined here.
The implementation source is `scripts/forge-prefs.js` § `resolveLayer`.

## § Error contract

When a layer has one or more legacy Markdown files and does not have its JSONC
catalog, resolution emits the following error entry. This is the sole error
code in the cutover contract:

```text
code: legacy-md-without-jsonc
entry: {file, line: null, code, message}
source: md-blocked
```

There is one entry per offending layer, not one entry per file. `file` is the
first existing filename in that layer's descriptor list; `line` is always
`null` because the engine does not parse Markdown. The layer contributes no
preferences while blocked. The resolver still returns both layer states so
consumers can present the diagnosis.

Detection is by exact filenames from
`preferenceLayerDescriptors(cwd, opts)` in `scripts/forge-prefs.js`, never by a
glob or directory scan. This matters because a glob would treat recovery files
such as `*.md.bak`, unrelated Markdown, or future documentation as preference
sources. The descriptor lists are the only production declaration of the
legacy filenames.

The `message` field is the canonical message below. The engine formats the
absolute paths it found and the migration script path for the active install;
consumers must preserve that text rather than paraphrasing it.

## § Canonical message

The fenced line below mirrors the emitter in `forge-prefs.js` § `resolveLayer`.
It is intentionally extractable for parity tests. `{files}` is the
comma-space-joined list of offending absolute paths, `{command}` is the
complete executable command prefix (`node /path/to/forge-prefs-migrate.js`),
and `{cwd}` is the resolved working directory.

```text
Preferências Markdown legadas encontradas: {files}. Rode: {command} --cwd {cwd}
```

Concrete rendering:

```text
Preferências Markdown legadas encontradas: /Users/alice/.claude/forge-agent-prefs.md. Rode: node /opt/forge/scripts/forge-prefs-migrate.js --cwd /work/project
```

The fix command migrates the default scope (both global and local layers);
`--cwd` selects the project whose local layer is to be migrated. S03
re-emits this message verbatim at its consumer boundaries, and S04 cites this
canonical message in `CHANGELOG.md`.

## § Layer-state matrix

| JSONC catalog | Legacy Markdown | Resolution | Error |
|---|---|---|---|
| present | absent | JSONC values, `source: jsonc` | zero |
| absent | present | hard stop; empty contribution, `source: md-blocked` | one per offending layer |
| present | present | JSONC silently shadows Markdown, `source: jsonc` | zero |
| absent | absent | defaults: empty layer, `source: absent` | zero |

“Silent” in the third row means silent legacy shadowing only: a valid JSONC
catalog is authoritative and the old file is not read or reported. The fourth
row lets the caller apply its normal defaults; the engine itself does not
invent preference values.

## § Per-consumer posture table

| Consumer | Behavior on legacy Markdown without JSONC | Implemented in slice |
|---|---|---|
| skills: `forge-auto`, `forge-next`, `forge-task` | Stop at the preference chokepoint and re-emit the canonical message verbatim; output is headless-safe. | implements in S03 |
| `forge-doctor` | Detect the blocked layer and, with `--fix`, migrate that local layer. | implements in S03 |
| statusline | Never stop rendering; show the `⚠ prefs` badge. This already emerges from the generic prefs-error path (`prefs-error.json`). | generic path already; event in S03 |
| hooks | Use the inert fallback and append one diagnostic line to `events.jsonl`. The fallback already emerges from the generic prefs-error path; the event is added in S03. | generic path already; event in S03 |
| `forge-prefs-view` | Receive the engine error and render `✗`; it must never source Markdown again. | implements in S03 |
| `forge-run` | Stop with a readable error and do not retry in a loop. | implements in S03 |

The stop is a backstop, rarely seen in normal operation because the relevant
chokepoints auto-migrate before consumers reach it (S02). It remains explicit
so a failed or unavailable migration cannot become an accidental default.

## § Consumers must not improvise

DECISION 57 constrains this boundary: “mechanics per consumer allowed, silent
default forbidden.” Consumers may choose their transport, rendering, or
fallback mechanics, but may not change the error code, entry semantics,
canonical message, or layer-state meaning. S02 owns the migration/chokepoint
boundary; S03 owns the consumer rows above; S04 cites this contract in release
documentation. Those boundaries are the reference points for implementation.

