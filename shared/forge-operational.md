# Forge operational parity contract

The mandatory offline gate is:

```text
node scripts/forge-operational-parity.test.js
```

It runs the common auto/task loop, doctor diagnostics, update planning, hook trust diagnostics, Claude/Codex headless JSONL adapters, and stdio/HTTP MCP projection over a `2 hosts × 3 OS` matrix. Every subprocess is the current Node executable with an argv array and `shell:false`; fixtures use isolated homes and workspaces with spaces, Unicode, and CRLF. The gate performs no network call, paid-model smoke, Bash/GNU/WSL command, login, keychain access, or provider-home fallback.

## Semantic comparison

Parity requires the same:

- workflow lifecycle, state, selected unit, boundary, retry idempotency, and durable handoff outcome;
- doctor/hook severity and reason codes, including required failures versus conditional warnings;
- update backup/preservation contract and explicit runtime argv shape;
- headless event order, terminal status/reason, usage schema, output presence, sandbox, policy decision, and effective security permissions;
- normalized MCP stdio executable/argv, HTTP URL/headers, and conditional-auth outcome.

Provider UI wording, host labels, session/resume identifiers, and provider-specific token totals are not equality criteria. Their safe shape is still validated. Prompts, transcripts, environment values, credentials, and untrusted control metadata are never included in the semantic snapshot.

Missing required capabilities fail by host with `required-capability-missing`. Missing auth or untrusted hooks remain explicit conditional-unavailable results. Statusline, accounts, and app remain `required:false` conditional capabilities and do not block the gate.
