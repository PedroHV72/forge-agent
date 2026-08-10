# Geração multi-runtime

`scripts/forge-generate.js` orquestra os dois renderers canônicos com o mesmo
contrato `claude|codex|both`, `--dry-run` e `--update`. O Forge home permanece
único; os homes Claude/Codex são apenas projeções selecionadas. A geração é
offline, determinística e idempotente em Windows nativo, macOS e Linux.

```text
node scripts/forge-generate.js --runtime both --dry-run --json
```
