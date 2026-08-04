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
