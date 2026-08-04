# Forge headless and MCP boundary

`scripts/forge-headless.js` is the common process boundary for Claude stream JSON and `codex exec --json`. It resolves one absolute executable, uses argv arrays with `shell:false`, requires an explicit sandbox and approval policy, and authorizes the spawn through `forge-dispatch-policy.js`.

Provider JSONL is untrusted. The bounded incremental parser validates protocol/dispatch identity, ordering, duplicate IDs, a single terminal, usage, resume, malformed/truncated input, timeout and orphan outcomes. Only normalized event type/sequence/usage is telemetry-safe; prompts, transcripts, environment and credentials are excluded. Termination is scoped to the child created by the runner.

`scripts/forge-mcp.js` normalizes stdio and HTTP servers without reading provider homes. Stdio uses an absolute executable plus argv. HTTP permits only HTTP(S), and authorization is described for runtime injection rather than stored. Required auth that is not available yields `auth-conditional-unavailable` and no host projection.
