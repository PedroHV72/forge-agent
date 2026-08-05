---
description: "Diagnóstico Forge versionado por runtime e capability. --fix limita-se a reparos reversíveis declarados."
allowed-tools: Read, Bash
---

# Forge Doctor

Este comando é um adaptador fino para o diagnóstico neutro em `scripts/forge-doctor.js`.

1. Determine o runtime do host que invocou o comando (`claude` ou `codex`). Só use `both` quando o operador o pedir explicitamente.
2. Execute, sem login, keychain, rede ou fallback para o outro host:

```bash
node scripts/forge-doctor.js --check all --runtime "{runtime}" --json
```

3. Exiba `reason_code`, `runtime`, `status` e `severity` de cada diagnóstico. Somente `severity: fatal` falha o comando. `conditional-capability-unavailable` é aviso.
4. Não leia nem crie o home do runtime não selecionado. Nunca tente reparar confiança de hooks, login, credenciais, keychain ou capabilities condicionais.

Com `--fix`, execute `node scripts/forge-doctor.js --fix --runtime "{runtime}"` apenas para os reparos reversíveis que o script declara. `--dry-run` não escreve.

Com `--regen-projection`, encaminhe a flag diretamente ao script e encerre sem executar o diagnóstico normal:

```bash
node scripts/forge-doctor.js --regen-projection
```

Se a regeneração for recusada porque o fragment store está vazio e o monolito ainda contém dados, recomende primeiro `node scripts/forge-migrate.js`. Só mencione `--force` com um aviso explícito de possível perda de dados.
