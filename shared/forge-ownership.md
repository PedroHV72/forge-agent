# Forge Ownership — `nearest-project-wins`

Which directory owns the state recorded about another directory. `resolveOwner()`
in `scripts/forge-workspace.js` already implements this rule; this document pins
its behaviour as a contract, so the table and the code cannot drift in silence.

## Why `nearest-project-wins`, not "the highest `.gsd/`"

A monorepo like `lookchina` can have work artifacts (milestones, decisions,
memory) both at its root **and** inside a member repo — `lookchina` itself has
milestones on disk, and so does `lookchina/services/freyr`. A rule that always
walks to the topmost `.gsd/` would steal ownership from `freyr` and hand every
run inside it to the workspace root. A rule that always stops at the first
`.gsd/` it meets, ignoring substance, would let an incidental empty `.gsd/`
(created by a tool that merely touched the directory) falsely claim ownership
of everything beneath it.

`nearest-project-wins` resolves this: walking upward from the queried
directory, the first ancestor (including itself) whose `.gsd/` holds real work
artifacts is the owner. A directory with its own `project`-classified `.gsd/`
owns itself and everything under it that has no closer project of its own. A
directory with no `.gsd/` at all, or with a `.gsd/` that is merely `touched`,
defers to whatever project is nearest above it.

## The deciding axis: substance, not presence

`classify()` (in `scripts/forge-workspace.js`) never treats the mere existence
of `.gsd/` as evidence of ownership. A `.gsd/` directory only counts as a
`project` when it contains at least one entry from `WORK_ENTRIES` — milestones,
decisions, a hand-written `STATE.md`, and so on. A `.gsd/` that exists but holds
only runtime scratch (or nothing at all) classifies as `touched`, and
`resolveOwner()` keeps walking past it exactly as if it were absent.

This is the reason `lookchina/services` does not capture `freyr`:
`lookchina/services/.gsd/` exists (some earlier run reached into it) but is
empty of work artifacts, so it is `touched`, not `project`. Ownership of
anything under `services/` that is not itself a nearer project falls through to
the workspace root, `lookchina`, not to `services/`.

## The table

Columns:

- **Caminho consultado** — the directory `resolveOwner()` is asked about,
  relative to a symbolic root `WS/` (the fixture builds a real directory tree
  rooted at some tmpdir and materializes `WS/` as that root). A row that must
  exercise the `stopAt` option appends `` :: stopAt=<path> `` after the query
  path, using the same `WS/`-relative notation for the bound.
- **Forma no disco** — what exists at that path and its ancestors: whether it
  has a `.gsd/` at all, and whether that `.gsd/` is `project` (has a work
  artifact) or `touched` (empty or scratch-only).
- **Dono** — the path `resolveOwner()` must return, again relative to `WS/`.
  `—` means `resolveOwner()` must return `null`.
- **Por quê** — one line explaining which rule produced that answer.

<!-- ownership-table:start -->
| Caminho consultado | Forma no disco | Dono | Por quê |
|---|---|---|---|
| `WS/` | `.gsd/` com artefato de trabalho (`milestones/`) | `WS/` | a raiz do workspace é dona de si mesma quando tem substância |
| `WS/services/freyr` | `.gsd/` com artefato de trabalho, membro registrado | `WS/services/freyr` | um membro com `.gsd/` de projeto é dono de si mesmo, mesmo dentro de um workspace dono |
| `WS/services/freyr/src/deep` | sem `.gsd/`, dentro do membro `freyr` | `WS/services/freyr` | nenhum `.gsd/` próprio; o ancestral mais próximo com substância é `freyr`, não `WS/` |
| `WS/scripts` | sem `.gsd/` nenhum | `WS/` | nenhum `.gsd/` na cadeia até a raiz do workspace; a raiz é a mais próxima com substância |
| `WS/libs` | sem `.gsd/` nenhum | `WS/` | mesmo raciocínio de `WS/scripts` — nenhum `.gsd/` intermediário |
| `WS/infra` | sem `.gsd/` nenhum | `WS/` | mesmo raciocínio de `WS/scripts` — nenhum `.gsd/` intermediário |
| `WS/services` | tem `.gsd/`, **vazio** (`touched`, não `project`) | `WS/` | presença sem substância não é posse; a caminhada sobe até a raiz do workspace |
| `/outside/somewhere` | fora de qualquer árvore com `.gsd/` | `—` | nenhum ancestral classifica como `project`; `resolveOwner()` retorna `null` |
| `WS/services/freyr/src :: stopAt=WS/services` | `freyr` tem `.gsd/` de projeto, mas o `stopAt` corta a caminhada antes de alcançá-lo | `—` | `stopAt` interrompe a busca no limite declarado antes de encontrar um dono, forçando `null` |
<!-- ownership-table:end -->

## O que esta tabela não decide

Esta tabela responde apenas "quem é o dono deste diretório" segundo
`resolveOwner()`. Ela não decide:

- **Onde uma run grava artefatos.** Isso é decidido pelo isolamento
  (`ISOLATION`/`CODE_DIR`/`BRANCH`) de cada dispatch, não pela posse de
  diretório.
- **Qual repo o sidecar multi-LLM usa** para uma task declarada. Isso é o campo
  `repo:` de uma entrada registrada, resolvido separadamente — a posse aqui é
  sobre onde o `.gsd/` de trabalho vive, não sobre roteamento de execução.
