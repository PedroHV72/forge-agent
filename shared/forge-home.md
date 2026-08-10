# Forge home e fronteira de paths

O Forge Agent possui uma única árvore compartilhada, independente do CLI que
está executando a unidade. `scripts`, `schemas`, `templates`, versão, manifest e
`forge-agent-prefs.jsonc` ficam no Forge home; `~/.claude` e `~/.codex` são
projeções/adapters selecionáveis e nunca são fonte de verdade do core.

## Resolução determinística

`scripts/forge-home.js` é o único resolver de paths. Ele não expande `~`, não
monta comandos de shell e usa `path.resolve`/`path.join`, portanto caminhos com
espaços, acentos e Unicode permanecem íntegros.

Precedência do home compartilhado:

1. `opts.forgeHome` (integrações e testes);
2. `FORGE_HOME` (override explícito, inclusive testes);
3. home do usuário (`USERPROFILE` no Windows; `HOME` no macOS/Linux; o outro
   env é fallback para ambientes híbridos);
4. `os.homedir()` como último recurso, resultando em `.forge-agent`.

Assim, os padrões são:

| Sistema | Forge home | Claude | Codex |
| --- | --- | --- | --- |
| Windows | `%USERPROFILE%\\.forge-agent` | `%USERPROFILE%\\.claude` | `%USERPROFILE%\\.codex` |
| macOS | `$HOME/.forge-agent` | `$HOME/.claude` | `$HOME/.codex` |
| Linux | `$HOME/.forge-agent` | `$HOME/.claude` | `$HOME/.codex` |

Os nomes acima são apenas descritores retornados pelo resolver. A projeção de
um runtime selecionado não copia o core nem as preferências.

## Camadas de preferência

O global canônico é `{forgeHome}/forge-agent-prefs.jsonc`. O local continua
`{cwd}/.gsd/forge-prefs.jsonc`; a troca Claude↔Codex não converte nem copia o
`.gsd`. Markdown local (`claude-agent-prefs.md` e `prefs.local.md`) permanece
legível apenas pelo migrador.

Durante a atualização, um catálogo JSONC legado em `{claudeHome}` é lido como
fallback somente quando o catálogo canônico ainda não existe. Um Markdown
legado é capturado, validado por diff resolvido e schema, e então gravado no
Forge home. Cada origem recebe um backup `.bak` (sem sobrescrever um backup
existente) e a origem Claude permanece intacta: o operador pode comparar ou
fazer rollback removendo o JSONC canônico e restaurando a origem.

Falhas de parse não caem para outra camada. O migrador retorna diagnóstico e
zero writes; `--dry-run` também não cria diretórios. A migração só aposenta um
Markdown já pertencente à árvore canônica; arquivos legados do runtime Claude
continuam no lugar para recuperação não destrutiva.

## API mínima

```js
const { resolveForgeHome, resolveRuntimeHome, resolvePreferencePaths } = require('./scripts/forge-home.js');

const forgeHome = resolveForgeHome({ env: { FORGE_HOME: 'D:/Dados/Meu Forge 🚀' } });
const codexHome = resolveRuntimeHome('codex', { userHome: 'C:/Users/Ana' });
const layers = resolvePreferencePaths(process.cwd(), { forgeHome });
```

Todos os resultados são absolutos. O resolver aceita `platform: 'win32'`,
`'darwin'` ou `'linux'` em testes sem alterar `process.platform`.
