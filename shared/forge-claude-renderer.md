# Claude renderer

`scripts/forge-claude-renderer.js` is the Claude-only projection of the
versioned `forge-source-manifest.json`. It reads canonical repository sources
and emits deterministic LF text for project instructions, Claude settings,
agents, skills, commands, hooks and MCP documentation.

```text
node scripts/forge-claude-renderer.js --repo . --claude-home "$CLAUDE_HOME" --dry-run --json
```

The renderer never resolves or writes a Codex home. Markdown receives a
deterministic `forge-source` origin marker; JSON/JSONC and CommonJS remain
unchanged apart from newline normalization. A destination that exists without
that marker is user-owned and is preserved. Pass `--backup-dir` when replacing
an already generated destination. `.gsd/` is never a renderer target.
