---
description: "Atualiza a instalação Forge preservando prefs e configurações do runtime selecionado."
allowed-tools: Read, Bash
---

# Forge Update

Este comando é um adaptador fino para `scripts/forge-update.js`.

Execute:

```bash
node scripts/forge-update.js --apply --json
```

O runtime é obtido do manifest neutro em `FORGE_HOME/manifest.json`. Encaminhe `--runtime claude|codex|both` somente quando o operador o informou explicitamente (incluindo migração de Claude 3.1.4). Também encaminhe `--repo`, quando fornecido.

Antes de qualquer escrita, confirme no JSON:

- `backup_required: true`;
- `runtime` igual à instalação detectada;
- `installer_args` contendo esse mesmo runtime.

Nunca transforme uma instalação `codex` em `both`, crie o home Claude, leia o home não selecionado ou tente login/keychain. Preferências no Forge home, configurações do usuário e `.gsd` são preservadas; o instalador faz backup dos arquivos gerenciados antes da troca.

## O clone não é atualizado por este comando

Este comando reinstala **o que estiver no clone do forge-agent** e nunca faz `git fetch`. Um clone desatualizado "atualiza" com sucesso para a mesma versão. Atualizar o clone é passo separado:

```bash
git -C <repo-fonte> fetch && git -C <repo-fonte> pull --ff-only
```

O JSON traz `source_repo` com o caminho lido e como ele foi resolvido (`flag` quando veio de `--repo`, `entry` quando é o diretório do próprio script, `manifest` quando veio da proveniência gravada na instalação), mais `version` declarada pelo clone, `sha`, `branch`, `dirty` e `behind_tracking`. Reporte esses campos ao operador antes de aplicar.

`behind_tracking` é medido no ref remoto **local** — ele é tão fresco quanto o último `git fetch` e não fala pelo servidor. `null` significa "não há como saber daqui" (sem git, ou sem upstream configurado), nunca "está em dia".
