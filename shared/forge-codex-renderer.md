# Codex renderer

`scripts/forge-codex-renderer.js` é a projeção nativa Codex do mesmo
`forge-source-manifest.json` usado pelo renderer Claude. Ele gera `AGENTS.md`,
custom agents em `CODEX_HOME/agents`, `config.toml` e um relatório de
capabilities no Forge home, sem ler ou escrever `~/.claude`.

Superfícies sem tradução oficial 1:1 permanecem explicitamente condicionais ou
indisponíveis no relatório; o renderer não usa o CLI Claude como fallback.
