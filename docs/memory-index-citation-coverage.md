# Cobertura de citações do índice de memória — diagnóstico do store de referência

Este documento registra a cobertura produzida por `scripts/forge-memory-index.js`: o
índice associa fatos de memória a arquivos apenas quando uma citação em prosa pode ser
resolvida com segurança. Cobertura importa porque uma associação ausente não deve virar
uma conclusão silenciosa sobre o repositório.

## Medição, procedência e limite de leitura

A medição de **depois** foi refeita em 2026-08-04, após as correções de review da S06
(guarda de sufixo e exigência de ponto na versão em `package-ref`), com o comando exato
abaixo. Os números desta página são a saída dessa execução, não valores editados à mão:

```text
node scripts/forge-memory-index.js --cwd "<REF_STORE_ROOT>" --json
```

Ele usou `--json`, sem `--write` e sem `--out`; portanto leu o store de referência e não
escreveu arquivo nele. Nenhum comando `svn` foi usado. A saída foi consumida em memória
para a análise, e não foi despejada neste documento.

Decisão de divulgação: o caminho de checkout foi substituído pelo placeholder
`<REF_STORE_ROOT>`, tratado como raiz de checkout, não como credencial. Não há caminho
absoluto da máquina autora neste documento.
Os identificadores `mem_id` abaixo foram preservados como evidência verificável, mas não
foram publicados `storage_key`, nomes de cliente, hostname, URL interna, credencial ou
texto integral de fato. Cada amostra foi lida antes da inclusão e não continha esses
dados; por isso não houve elisão de citação nos exemplos.

## Antes e depois

Os campos são os nomes emitidos literalmente pelo envelope `--json`: os cinco do
IN-19 e os três campos aditivos de IN-17 (`facts_no_file_mention`,
`facts_missed_by_extractor` e `facts_unresolved_only`). A coluna **Antes** vem do
baseline no tip `4c92dfe`, registrado em `S06-PLAN.md` e reconfirmado em
`T01-SUMMARY.md`; este último prevalece porque foi medido mais perto da alteração, no
mesmo estado de store. O planejamento tinha 757 fatos/335 citações, enquanto a
reconfirmação tinha 707/311: o store avançou entre as duas medições, portanto os números
do planning não são misturados à tabela.

| campo | Antes (`4c92dfe`, T01) | Depois (comando acima) | delta |
|---|---:|---:|---:|
| `facts_total` | 707 | 707 | 0 |
| `facts_with_resolved` | 117 | 177 | +60 |
| `citations_total` | 311 | 477 | +166 |
| `citations_resolved` | 144 | 227 | +83 |
| `files_indexed` | 72 | 126 | +54 |
| `facts_without_citation` | 502 | 421 | −81 |
| `facts_no_file_mention` | não emitido pelo gerador em `4c92dfe` | 416 | n/a |
| `facts_missed_by_extractor` | não emitido pelo gerador em `4c92dfe` | 5 | n/a |
| `facts_unresolved_only` | 88 | 109 | +21 |

Procedência das linhas `facts_unresolved_only` e `facts_without_citation` na coluna
**Antes**: elas foram medidas nesta task rodando uma cópia do gerador do tip `4c92dfe`
contra o mesmo estado de store, em modo somente leitura (`--json`, sem `--write` e sem
`--out`) — não são valores herdados nem estimados.

Corrigindo o registro: a T02 **não** introduziu os três campos. Ela introduziu dois —
`facts_no_file_mention` e `facts_missed_by_extractor` — que de fato não existiam no
envelope de `4c92dfe`; para esses dois, e apenas para eles, não há coluna **Antes**, e
inventá-la retrospectivamente contrariaria o contrato de procedência. O que a T02 fez com
eles foi **particionar** o balde pré-existente `facts_without_citation` em `(a)` fatos sem
menção a arquivo e `(b)` fatos cuja citação de arquivo não foi capturada **inteiramente**
pelo extrator: no depois, `416 + 5 = 421 = facts_without_citation`, que é a prova de
IN-17 — o balde legado é reconstituído exatamente pelas duas partes.

**Triagem S06 (R3):** `(b)` só é preenchido quando um fato não tem **nenhuma** citação
extraída (`citations.length === 0`). Um fato que cite três arquivos e do qual o extrator
capturou apenas um cai em `facts_with_resolved`, não em `(b)` — captura **parcial** é a
classe de perda dominante e permanece **inteiramente invisível** a este número. O rótulo
do render foi corrigido para dizer "não foi capturada inteiramente" (em vez de "não
capturada"), e o valor `facts_missed_by_extractor: 5` deve ser lido como "5 fatos sem
nenhuma citação capturada", nunca como uma contagem completa de perdas do extrator.
Medir captura parcial é instrumento novo, fora do escopo desta correção.

Já `facts_unresolved_only` **já existia** em
`4c92dfe` (vive em `coverage`, não em `counts`, e por isso parece ausente a quem lê só o
envelope `counts`); a T02 apenas lhe deu rótulo com motivo no render, sem renomear o
campo. Declará-lo "não emitido" seria escrever desconhecimento sobre um número medível —
exatamente o defeito que este documento existe para eliminar.

No depois, a identidade medida pela T02 é `177 + 416 + 5 + 109 = 707`. Os três campos
citados são, respectivamente: fatos sem menção reconhecida pelo vocabulário atual do
extrator, falha enumerada do extrator e fatos com citações extraídas mas sem resolução.

Sobre o primeiro balde, é preciso ser exato quanto ao que a medição sustenta. Ele
**não** pode ser declarado "fora do alcance do eixo, logo não é defeito": o detector de
menção perdida usa o mesmo vocabulário `CODE_EXT` do extrator, então um fato que cite um
arquivo com extensão fora desse vocabulário é invisível para os dois e cai aqui, junto
com os fatos que realmente não citam arquivo nenhum. Como não há medição que separe as
duas populações, o rótulo honesto é **parte desconhecida**. Isso é material neste store,
que é .NET/SVN: `.cs`, `.sql`, `.config`, `.resx` e `.cshtml` não estão em `CODE_EXT`.
Quantificar essa fatia é trabalho de outra task; afirmar que ela é zero seria a própria
sobre-afirmação que este documento existe para remover.

**Triagem S06 (R4):** o render rotulava `(c)` como "a citação existe, porém não foi
localizada" para todo `facts_unresolved_only`. Isso é falso para os fatos cuja única
causa é `package-ref` ou `dynamic` — ambos são citações que, por desenho, **não são
arquivo** (mesma categoria de `(a)`, não uma falha de busca; ver a tabela de reasons
abaixo). O rótulo foi corrigido para "mas nenhuma resolvida **a um arquivo**", com uma
ressalva explícita de que a contagem mistura "apontava para arquivo e não foi
localizado" com "por design não é arquivo" sem separar as duas populações. Dividir
`facts_unresolved_only` (109) por essas duas causas — por exemplo, quanto do delta
`88 → 109` vem de `package-ref`/`dynamic` versus do `CODE_EXT` ampliado — permanece
**não medido**; é instrumento novo, deliberadamente fora do escopo desta correção.

## Causa nomeada das citações irresolúveis

No depois, `citations_total - citations_resolved = 477 - 227 = 250`. A decomposição da
lista `coverage.unresolved` produz a mesma soma, o que torna o diagnóstico auditável:

| `reason` | ocorrências | citações distintas | leitura da causa |
|---|---:|---:|---|
| `ambiguous-basename` | 94 | 51 | basename sem diretório encontra mais de um arquivo |
| `not-found` | 94 | 69 | o caminho/basename citado não existe na varredura atual |
| `package-ref` | 42 | 15 | referência `nome@versão`, deliberadamente não é arquivo |
| `dynamic` | 16 | 15 | template, wildcard ou crase interna; descarte por desenho |
| `outside-root` | 4 | 4 | caminho fora da raiz, rejeitado antes de acesso ao disco |
| **soma** | **250** | **154** | **477 − 227 = 250** |

`package-ref` caiu de 53 para 42 ocorrências (20 → 15 citações distintas) por causa de
duas correções de review, medidas isoladamente uma da outra: **10** das 53 eram apenas o
prefixo de um caminho versionado (`services@1.2.0/src/…`) que o padrão `bare-path` já lia
inteiro — eram contadas duas vezes e a segunda contagem nunca poderia resolver; **1** era
uma alça de prosa com ano (`suporte@2024`), que a exigência de ponto na versão eliminou.
As 42 restantes são referências `nome@versão` genuínas. Nenhuma citação resolvida foi
perdida: `citations_resolved`, `facts_with_resolved` e `files_indexed` não se moveram — a
correção retirou apenas denominador fantasma.

Não há um único reason dominante: `ambiguous-basename` e `not-found` empatam em 94
ocorrências cada. A causa estrutural mais clara é a ambiguidade de basename; ela não é
renomeação, pois a varredura encontra vários arquivos válidos com o mesmo nome e se
recusa corretamente a adivinhar qual deles a memória queria dizer.

### Amostras lidas de `ambiguous-basename`

As cinco amostras a seguir foram verificadas individualmente no store e na varredura de
arquivos de `<REF_STORE_ROOT>`. A citação é apresentada em código, fora de tabela, para que
caracteres de prosa não possam quebrar Markdown. “Procurado” descreve exatamente a busca
por basename que a CLI fez; não expõe a lista de diretórios internos.

- Citação `config.ts`, `mem_id` `MEM180`, 10 ocorrências. Procurado: cada arquivo
  chamado `config.ts`; encontrados 336 candidatos. Não resolve porque o fato não traz
  diretório para selecionar um deles.
- Citação `package-alias.js`, `mem_id` `MEM358`, 6 ocorrências. Procurado: basename
  `package-alias.js`; encontrados 20 candidatos. A repetição por módulos impede uma
  associação única.
- Citação `App.tsx`, `mem_id` `MEM175`, 5 ocorrências. Procurado: basename `App.tsx`;
  encontrados 42 candidatos. O nome solto não identifica a aplicação/componente correto.
- Citação `package.json`, `mem_id` `MEM319`, 5 ocorrências. Procurado: basename
  `package.json`; encontrados 55 candidatos. Manifestos repetidos são ambiguidade
  estrutural, não arquivo faltante.
- Citação `_preview.tsx`, `mem_id` `MEM006`, 4 ocorrências. Procurado: basename
  `_preview.tsx`; encontrados 5 candidatos. Há arquivos existentes, mas nenhum caminho
  na citação para desempatar.

Esses exemplos preservam o `mem_id` por rastreabilidade, de forma consistente, e omitem
as listas de candidatos porque elas carregariam nomenclatura interna sem aumentar a prova:
o número de candidatos e o resultado da busca já demonstram a não-unicidade.

### Leitura dos demais reasons

`not-found` também soma 94, mas não prova por si só a hipótese de renomeação. A amostra
inclui artefatos de planejamento `.gsd/` (por exemplo, contratos S01/S02), nomes de
ferramentas que pertencem a outro repositório e nomes de entrega/histórico ausentes da
árvore atual; há ainda resquícios de extração como `-REVIEW.md` (2 ocorrências). Assim,
renomeação/movimentação é uma explicação possível apenas para parte de `not-found`, não
para o reason empatado de ambiguidade nem para os outros 62 casos. `package-ref` (42) e
`dynamic` (16) são enumerados por desenho e não devem disparar busca de arquivo; os 4
`outside-root` foram rejeitados antes de qualquer probe fora da raiz.

## Veredicto sobre a hipótese herdada

A hipótese D5/ROADMAP — “renomeação de arquivo; a memória é histórica e o repositório
andou” — está **parcialmente confirmada e não é a causa dominante isolada**. Ela é
compatível com uma parte dos 94 `not-found`, mas empata com 94
`ambiguous-basename`, em que os arquivos existem em quantidade maior que um. Além disso,
42 `package-ref`, 16 `dynamic` e 4 `outside-root` têm causas nomeadas distintas. A
conclusão sustentada pela medição é: o problema é uma mistura de ambiguidade estrutural,
referências históricas/não-arquivo e formas deliberadamente não resolvíveis — não uma
única onda de renomeações.

## Backlog nomeado e fora do escopo desta PR

1. **BACKLOG-MEMORY-STORE-SKIP-28.** `fragments_skipped_by_store` informa 28 de 145
   arquivos em `.gsd/memory/` fora do índice, cerca de 19%. Esses fatos estão ausentes
   antes mesmo da resolução de citações; não devem ser confundidos com citação perdida.
   A correção já é reportada pelo código da PR 1 e está explicitamente fora do escopo
   desta PR.
2. **BACKLOG-UNRESOLVED-CITATION-POLICY.** Uma política para caminhos mais específicos,
   qualificação de basename e tratamento de artefatos históricos pode ser barata em
   casos isolados, mas não é barata como correção geral: exigiria uma regra de escolha e
   reabriria as métricas de resolução. Ela **não entra nesta slice** mesmo que algum caso
   pontual pareça simples, pois mudar a resolução depois da T02 alteraria a tabela que
   este mesmo commit mede.

O artefato é somente diagnóstico derivado. A task de diagnóstico que o escreveu não
alterou `scripts/`; a correção de review posterior alterou (guarda de sufixo e exigência
de ponto em `package-ref`, além de rótulos do render), e por isso os números acima foram
**remedidos**, não editados. Em nenhum momento este documento gerou índice sob `.gsd/`
nem escreveu no store de referência: toda leitura do checkout foi feita com `--json`.
