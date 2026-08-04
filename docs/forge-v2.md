---
title: Forge v2 — o argumento
audience: humano (operador, decisor)
purpose: entender o que muda, por que muda, quanto custa e o que ainda não sabemos
companion: docs/forge-v2-build-spec.md (mesmo conteúdo, formato de construção, com invariantes e critérios de aceitação)
date: 2026-08-04
---

# Forge v2 — o argumento

> **O v1 pede ao modelo que se comporte como um programa. O v2 é um programa que
> chama o modelo.**

Tudo o que vem abaixo é consequência dessa troca. Este documento é o **porquê**; o
companheiro `forge-v2-build-spec.md` é o **como**, com os invariantes e os critérios
de aceitação em formato de construção. Os dois carregam as mesmas referências e os
mesmos números.

## Como ler as marcações

Ao longo do texto, cada afirmação sobre um projeto externo carrega o grau de
evidência. A distinção importa porque é exatamente onde uma decisão de arquitetura
erra sem avisar.

| Marca | Significa |
|---|---|
| **[código]** | Li o código/estrutura do repositório clonado |
| **[docs-1ª]** | Documentação de primeira mão (docs oficiais, ADRs do próprio projeto) |
| **[meta]** | Metadado verificado via API do GitHub (estrelas, linguagem, push, licença) |
| **[2ª mão]** | Li em levantamento de terceiro — **não confirmado** |

Estrelas medem atenção, não qualidade: o `opcode` tem 22 mil e está morto desde
out/2025. Último push importa mais.

---

## 1. O que a coisa é

### Ainda é GSD?

Três coisas estavam coladas e precisam ser separadas:

1. **GSD como metodologia** — milestone → slice → task, discuss/plan/execute/complete,
   gates. É uma **especificação**.
2. **GSD como implementação** — o `gsd-pi`, 1 milhão de linhas. É um **produto**.
3. **Forge** — hoje, uma terceira implementação da (1) em markdown sobre o Claude
   Code, mais três coisas que ninguém tem.

**A metodologia continua sendo GSD, e isso é força.** Ela é decomposição validada por
um upstream inteiro. Reinventá-la seria o desperdício.

**O que muda é o que o Forge é:** deixa de ser *uma implementação do GSD* e passa a
ser **um motor que executa uma política — sendo GSD a primeira política**. Como o
Temporal é runtime e o seu workflow é a política; como o Kubernetes é runtime e o seu
Deployment é a política.

Quatro testes provam que a separação é real. Se algum falhar, foi só renomear:

- a política é versionável separadamente do motor
- dá para rodar **outra** política no mesmo motor (o `spec-kit`, por exemplo)
- dá para testar o motor **sem** a política
- dá para testar a política **sem modelo nenhum** ← hoje impossível

Esse último é o coração de tudo. Hoje não existe função para testar, só markdown para
grepar.

> ⚠️ **Uma consequência de produto que ainda não está decidida.** Se o Forge vira
> runtime com política plugável, `.gsd/` deixa de ser *"o diretório do Forge"* e passa
> a ser *"o storage da política GSD"*. O runtime precisa de namespace próprio. É custo
> de migração real, e dói muito mais se for descoberto na fase 3 do que agora.

### Não é reconstruir do zero

O preço de tabela do "zero" está medido: **1 milhão de linhas** no `gsd-pi`,
**26 packages** no `opencode`. E duas das três coisas que pareciam "o Forge escreve"
encolheram para infraestrutura adotável quando a pesquisa avançou.

> **A roda não é refeita. O que é novo é o eixo** — o loop que segura tudo, e que hoje
> não existe como código em lugar nenhum do Forge. Roda, pneu, freio e câmbio são
> comprados.

"Novo" segue verdadeiro no que importa: **autoria das decisões e da composição**.
Nenhum dos quatro projetos levantados junta política GSD + disciplina de custo +
revisão adversarial + multi-conta + portão medido.

---

## 2. Por que agora — o diagnóstico

O Forge foi pontuado contra os
[12-Factor Agents](https://github.com/humanlayer/12-factor-agents) **[docs-1ª]**.
Resultado: **oito fortes, dois parciais, duas falhas**. E as duas falhas são
exatamente as que não têm conserto por prompt melhor.

| Fator | Forge |
|---|---|
| 2 · Own your prompts | forte — é literalmente o que o Forge é |
| 3 · Own your context window | forte — context isolation por unidade |
| 5 · Unify execution + business state | **muito forte** — `.gsd/` é os dois, em disco, auditável |
| 6 · Launch/Pause/Resume | forte no desenho — pause file, `continue.md`, run registry |
| 7 · Contact humans with tool calls | parcial — degrada para `defer` no headless |
| 9 · Compact errors into context | forte — taxonomia de falha com retry por classe |
| 10 · Small focused agents | **exemplar** — 7 agentes, contexto isolado |
| 12 · Stateless reducer | conceitualmente sim — `(estado .gsd) → (resultado + novo estado)` |
| 1 · Natural language → tool calls | parcial — o dispatch é `Agent()`, mas o **retorno** volta como prosa |
| 11 · Trigger from anywhere | parcial — CLI, app e cron, mas tudo desemboca numa sessão `claude` |
| **4 · Tools são structured output** | **falha** |
| **8 · Own your control flow** | **falha** |

**Fator 4** é o `---GSD-WORKER-RESULT---`: dado estruturado contrabandeado dentro de
prosa, porque prosa era o único canal disponível.

**Fator 8** é o loop em markdown. E aqui está a parte desconfortável: **todas as
cicatrizes documentadas no `CLAUDE.md` são sintomas de um único defeito** — fluxo de
controle expresso como persuasão.

- `AUTONOMY RULE — CRITICAL` existe porque o modelo pausa para pedir confirmação
- `Compaction Resilience Protocol` — reler estado do disco porque a memória do
  programa é uma janela de contexto
- *"proibido executar inline quando `Agent()` falha"* — regra nascida de o modelo ter
  **improvisado** em vez de falhar. Num programa isso é um `catch`
- `tier_models` documentado como funcionando por uma milestone inteira **sem
  funcionar** — `Agent()` só aceita quatro aliases, nunca um ID
- `thinking_header` injetado como *texto no cabeçalho do prompt*, com guard contra
  HTTP 400

Nenhuma dessas linhas some com um prompt melhor. Todas somem com um `while`.

---

## 3. Os quatro mecanismos, em "hoje / no v2 / custa"

### Consumo de máquina

**Hoje:** não existe limite nenhum. O `forge-isolation` isola **arquivos**, não
recursos. E é por isso que tudo roda em série: **serializar é o único controle de
recurso que o Forge tem**.

**No v2:** cada worker num sandbox com limite declarado, imposto pelo kernel. O teto
vira aritmética — *cada worker custa ≤2 GB, a máquina tem 16, cabem 6* — em vez de
adivinhação, e estourar vira falha normal de Activity com retry.

**Custa:** integrar sandbox.

### Versão online

**Hoje:** fecha o notebook, tudo morre.

**No v2:** o loop é programa com estado durável — roda num daemon, local ou servidor,
sem humano acoplado. Gate é Signal e estado é Query, então qualquer cliente
autenticado pergunta *"onde está?"* e responde *"pode seguir"*.

**Custa:** operar um motor. E vale dizer com clareza: **"online" não é feature nova —
é o que sobra quando o loop deixa de precisar de um terminal aberto.**

### Ficar mais inteligente

**Hoje:** **não fica, porque não mede nada.** A memória extrai lições em prosa e não
há sinal quantitativo nenhum.

**No v2:** cada unidade vira registro estruturado — modelo, effort, iterações, tokens,
must-haves, objeções — e aí roteamento, effort e contexto passam a ser **medidos**.

**Custa:** montar a eval, que é o setpoint de tudo.

### Múltiplos LLMs

**Hoje:** não é multi-LLM, é **multi-CLI** — shell-out para `codex`/`agy`, só no
challenger do review, sem modelo de capacidade.

**No v2:** interface de executor com implementações independentes.

**Custa:** **cache é model-scoped** — cada troca invalida o prefixo. O v2 não elimina
esse custo; torna-o visível e decidível.

### O que **não** melhora

O modelo é o mesmo. Uma unidade que gasta 29 mil tokens de saída continua gastando. O
v2 não deixa o Claude melhor por chamada — **as alavancas por chamada são de v1** (§5)
e podem ser aplicadas esta semana. O que o v2 acrescenta é **saber qual delas
funcionou**.

---

## 4. Quanto custa hoje — o baseline medido **[código]**

De `.gsd/forge/events.jsonl`, 73 dispatches em 5 dias (29/07 → 03/08/2026):

| modelo | n | input | output | custo | % |
|---|---:|---:|---:|---:|---:|
| `sonnet-5` | 42 | 46.221 | 1.182.959 | $17,88 | **54%** |
| `opus-5` | 15 | 20.732 | 521.778 | $13,15 | **39%** |
| `haiku-4-5` | 12 | 8.883 | 418.974 | $2,10 | 6% |
| `fable-5` | 4 | 3.036 | 4.840 | $0,27 | 1% |
| **total** | **73** | **78.872** | **2.128.551** | **$33,41** | |

Projeção: **~$200/mês** nesse ritmo. Com o preço promocional do `sonnet-5` ($2/$10 até
31/08), a conta real é ~$27 / ~$165.

**A razão que decide a estratégia inteira: 27 para 1.** A saída responde por **99% do
custo**.

Isso tem uma consequência que corrige boa parte do que a intuição diria: **toda
disciplina de prompt caching otimiza a entrada, que são 1%**. Ela continua tecnicamente
correta — e passa a ser **economicamente marginal para este perfil de uso**. A
prioridade real é saída.

**E o dado que decide a tática:** o volume de saída é praticamente **independente do
modelo** — haiku 34,9k por dispatch, opus 34,8k, sonnet 28,2k. **Quem determina o
tamanho da saída é a task, não o modelo.** Isso torna rotear para modelo mais barato um
ganho quase puro, sempre que a qualidade aguentar.

---

## 5. O que fica mais rápido, o que fica mais barato

Nem toda alavanca faz as duas coisas, e algumas fazem o oposto.

| Alavanca | + rápido | + barato | Observação |
|---|:--:|:--:|---|
| **`effort` mais baixo** | ✅ | ✅ | Com thinking adaptativo, **pensamento é token de saída**. O guia de migração do Opus 5 manda varrer para baixo: *"low e medium são excepcionalmente fortes neste modelo"* |
| **Programmatic tool calling** | ✅ | ✅ | O resultado da tool volta **para o código, não para o contexto**. *"O custo escala com a saída final, não com os resultados intermediários"* |
| **Roteamento p/ modelo menor** | ✅ | ✅ | Ganho quase puro, dado §4 |
| **Instrução de concisão** | ✅ | ✅ | Grátis. O guia do Opus 5 reporta **−20%** de comprimento de resposta com uma instrução curta |
| **Task budget** | ~ | ✅ | O modelo **vê um contador** e se ritma, em vez de ser cortado |
| **Batch API** | ❌ assíncrono | ✅ **−50%** | Candidatos no log: **102 `verify`, 13 `symbol_check`** |
| **Fast mode** | ✅ **2,5× tok/s** | ❌ **2× o preço** | Alavanca de latência, não de custo |
| Prompt caching | ~ | **marginal aqui** | Otimiza 1% do custo |

Três detalhes de higiene que valem registro: usar `count_tokens` em vez de estimar
(`tiktoken` é da OpenAI e **subconta Claude em 15–20%**, muito mais em código);
mensagens `role: "system"` no meio do array dão instrução de operador **sem invalidar o
prefixo cacheado** (e são o canal não-falsificável — texto dentro de turno de usuário
pode ser forjado); e `max_tokens: 0` faz pre-warm de cache sem gerar saída.

### A cascata — a ideia que inverte o sistema de tiers **[docs-1ª]**

[FrugalGPT](https://ar5iv.labs.arxiv.org/html/2305.05176) (Stanford — Chen, Zaharia,
Zou) propõe **cascata**: manda a query para o modelo **mais barato primeiro**, pontua a
resposta e **escala para o caro só quando não passa**. Reporta até **98%** de redução
de custo mantendo a qualidade do melhor modelo isolado.

O obstáculo do paper é o **scorer** — eles treinam um DistilBERT para *prever* se a
resposta está correta.

> **O Forge já tem o scorer, e ele é melhor: é determinístico.** `must_haves`
> passa/falha, o verifier de 3 níveis, lint, teste, file audit. Não é predição de
> correção — é **verificação**. O Forge pode fazer cascata **sem treinar nada**.

**A inversão:** hoje o tier é escolhido **antes**, pelo planner, no frontmatter
(`frontmatter-override` responde por 10 dos 73 dispatches). Com cascata, o tier é
decidido **pelo resultado**.

| tentativa | custo típico |
|---|---:|
| `haiku` (35k out × $5/M) | **$0,175** |
| `sonnet-5` (28k out × $15/M) | $0,42 |
| `opus-5` (35k out × $25/M) | $0,875 |

Uma falha em haiku custa $0,175. Contra o sempre-sonnet de $0,42, a cascata paga a
partir de **~60% de acerto do modelo barato**: a 70% economiza ~29%, a 80% ~38%.
**Abaixo de ~60% ela custa mais** — por isso a taxa de acerto por tipo de unidade
precisa ser **medida**, não suposta. Formalização da decisão:
[arXiv 2605.06350](https://arxiv.org/pdf/2605.06350).

### As armadilhas de cache que ainda importam

Mesmo sendo 1% do custo, três delas erram **em silêncio** e vale conhecê-las:

- **O mínimo cacheável não é monotônico.** Opus 5 / Fable 5 / Mythos 5: 512 tokens.
  Opus 4.8 / Sonnet 5 / 4.6 / 4.5 / Opus 4.1: 1.024. Opus 4.7 / Haiku 3.5: 2.048.
  Opus 4.6 / 4.5 / **Haiku 4.5: 4.096**. Como o Forge roteia por tier, **o mesmo
  desenho de prompt cacheia num tier e não cacheia noutro** — sem erro, apenas
  `cache_creation_input_tokens: 0`. Precisa ser medido por tier.
  *(O mínimo se aplica ao **prefixo** — `tools → system → messages` — não à mensagem
  do usuário; o system prompt e as tools do Claude Code sozinhos já passam de 4.096.)*
- **A janela de lookback é de 20 blocos.** Um turno que acrescenta mais que isso —
  trivial num `execute-task` com muitos pares `tool_use`/`tool_result` — faz o próximo
  breakpoint não achar nada. Mitigação: breakpoint intermediário a cada ~15 blocos.
- **Paralelismo ingênuo paga N× o preço.** A entrada só fica legível depois que a
  **primeira resposta começa a streamar**. Padrão correto: dispara 1, espera o
  **primeiro token**, aí dispara as N−1. **Isto é pré-requisito do escalonador, não
  otimização.**

Mecânica base, para referência: cache é *prefix match*, leitura ~**0,1×**, escrita
**1,25×** (TTL 5min) ou **2×** (1h), break-even em 2 requisições no TTL de 5min e 3 no
de 1h, máximo **4 breakpoints** por requisição, e **troca de modelo invalida tools,
system e messages**.

---

## 6. Vazão — a outra função-objetivo **[código]**

Tudo acima otimiza **fatura**. Mas o objetivo declarado da operação é outro: *concluir
rápido algo que não precise ser revisitado e passar para o próximo*. Isso é **vazão**,
e as duas divergem.

Medido no mesmo log — sinais por unidade:

| sinal | por unidade |
|---|---:|
| `verify` | 1,40 |
| `review` | 0,29 |
| `plan_check` | 0,21 |
| `review-fix` | 0,05 |
| `plan-gate` | 0,05 |
| `orchestrator_reverification` | 0,04 |
| `review-triage` | 0,03 |

Dentro dos 21 reviews: **59 objeções, 40 concedidas (68%), 10 refutadas, 4 abertas.**

**Duas descobertas que mudam a prioridade:**

1. **O review dialético paga.** 68% de concessão significa que o challenger acha
   defeito real, não ruído — 40 correções que não viraram problema do operador.
2. **O humano não é o gargalo.** Somando tudo que exige decisão humana — 4 `plan-gate`
   + 2 `review-triage` + 1 `uat-finding` — são **7 interrupções em 73 unidades**, uma a
   cada dez. **Há folga enorme para paralelizar antes de o operador virar a restrição.**

**O gargalo é a serialização.** As 73 unidades correram em fila não por dependência —
o ROADMAP já declara quais dependem — mas porque serializar é o único controle de
recurso que existe. É a única alavanca **multiplicativa** do sistema.

### A tensão: cascata trabalha contra vazão

Cascata são **duas passadas sequenciais** — economiza dólar, gasta relógio. Para vazão
você quer **acertar de primeira**, o que argumenta por `effort` **mais alto** e modelo
**melhor** — o oposto do que a seção de custo recomenda.

A regra que reconcilia é decidir **por tipo de unidade**, com a variável certa sendo o
**custo de uma tentativa falha**:

| Se a unidade… | Estratégia |
|---|---|
| é curta, barata de verificar, e **não bloqueia nada** | **cascata** — falhar é barato |
| é longa, ou **bloqueia outras no DAG** | **modelo forte de primeira** — o custo de falhar é o relógio dela **mais tudo que ela segura** |

Para uma unidade no caminho crítico, economizar $0,25 trocando sonnet por haiku é
péssimo negócio.

**Alavancas de vazão, ranqueadas pelo dado:** (1) paralelismo, única multiplicativa e
com folga de humano para usá-la; (2) acertar de primeira — as 40 concessões são o
alvo, e o efeito é **composto**, porque cada retrabalho evitado também evita a
verificação dele, que custa 1,40 por unidade; (3) gate que não bloqueia a fila; (4)
agrupar as interrupções do operador — 7 já é pouco, juntá-las numa janela vale mais do
que reduzi-las a 5.

---

## 7. Como os agentes se comunicam — e qual falta

### Hoje eles não se comunicam

A topologia é estrela e o barramento é o contexto do orquestrador: ele despacha, o
worker devolve `---GSD-WORKER-RESULT---`, ele **parseia prosa**. Challenger e advocate
nunca se falam — as objeções do primeiro viram texto no prompt do segundo, montado pelo
orquestrador.

Três problemas compostos: o resultado é prosa; **o contexto do orquestrador é o
barramento** e é finito — daí o Compaction Resilience Protocol existir; e nenhum agente
reage ao achado de outro sem ida e volta pelo centro.

**Três canais estão confundidos:**

| Canal | Protocolo certo | No Forge hoje |
|---|---|---|
| Agente ↔ ferramenta/ambiente | **MCP** | parcial |
| Orquestrador ↔ agente | **contrato tipado** | prosa com marcador |
| Agente ↔ agente | — | inexistente, simulado por prosa |

### A correção contra-intuitiva: agentes não devem conversar

O instinto é abrir um canal direto entre eles. **É onde sistemas multi-agente falham**
— conversa não-limitada, custo composto, sem trilha de auditoria de quem decidiu o quê.

O padrão que funciona tem nome antigo: **quadro-negro** (*blackboard*). Os agentes
**não se falam, escrevem no mesmo quadro**, e um controlador decide quem roda em
seguida. Comunicação **por artefato**, sequenciamento **por código**.

O Forge já tem o quadro: é o `.gsd/`. Falta o **barramento de eventos tipados** no
lugar do contexto do orquestrador. Com isso ele deixa de ser gargalo de comunicação e
vira só sequenciador.

*(Existe protocolo para agentes conversarem —
[A2A](https://github.com/a2aproject/A2A), 25.170★. Fica catalogado e **não adotado**,
por essa decisão.)*

### O "cleaner": a intuição certa com a ação errada

Algo precisa cuidar do que acumula. Mas **apagar é a falha, não a solução** — e isso
vem do achado central da próxima seção. O papel se divide, e só metade é agente:

| | O que faz | É agente? |
|---|---|---|
| **Faxineiro** | worktrees órfãos, temporários, branches mortos, entradas obsoletas no registro | **Não** — é computável, logo é código dirigido por evento |
| **Curador** | que lição desta execução sobrevive, o que está contradito, o que envelheceu | **Sim** — é julgamento |

Diferença prática: o faxineiro **apaga por regra**; o curador **reorganiza por
utilidade medida**, com atualização incremental em vez de reescrita.

### A lacuna real do roster

O roster atual é `discusser`, `researcher`, `planner`, `executor`, `completer`,
`memory`, `reviewer`, `advocate`, `plan-checker`. Falta **um árbitro de conflito** — e
ele só passa a existir quando o paralelismo chegar. A **detecção** já está pronta e é
determinística (`forge-touch` / `forge-overlap`, que deliberadamente recusaram
construir a fila). **Reconciliar intenção divergente** entre duas slices que tocam o
mesmo arquivo é julgamento, não aritmética.

### E a regra que impede o desastre

Em teoria de controle, o que se está propondo é uma **malha fechada** — e malha fechada
precisa de **setpoint**. O setpoint aqui é a eval: sem ela, "não está no cenário ideal"
é opinião.

| Camada | O que é | Exemplos |
|---|---|---|
| **Sensores** | Determinísticos, baratos, sempre ligados | `must_haves`, verifier, lint, teste, file audit, métricas do histórico |
| **Controlador** | **Código.** Regras e limiares | *acerto em `haiku` < 60% → sobe o tier* · *RAM livre < X → reduz paralelismo* · *objeções abertas > N → escala ao operador* |
| **Especialistas** | **Agentes.** Só onde há julgamento | challenger, advocate, plan-checker, curador, triador externo |

> ⚠️ **Um agente decide o que um programa não consegue calcular.**
>
> Roteamento por taxa de acerto medida é **aritmética**. Nível de paralelismo é
> **divisão**. Se o "recalcular" virar agente, você reintroduz não-determinismo **no
> plano de controle** — e aí não dá para distinguir se o comportamento mudou por causa
> do trabalho ou do controlador. É o fator 8 de volta, uma camada acima.

**O custo, com os números reais:** com saída a 99% do custo, **cada especialista é
gasto recorrente**. Por isso devem ser **dirigidos por evento, nunca por polling** — o
challenger roda quando há diff de slice, não a cada minuto. Um sistema com doze agentes
se vigiando é teatro caro. **Quatro que se pagam, com número, valem mais.**

O freio vem de primeira mão, do time do Claude Code: *"para tarefas de código normais,
pergunte-se: isso precisa mesmo de mais compute?"*

---

## 8. O que existe lá fora

### O upstream — `open-gsd/gsd-pi` **[código]**

O `gsd-build/gsd-2` que o `CLAUDE.md` cita **está arquivado**. O upstream vivo é
[`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi) — npm `@opengsd/gsd-pi`,
v1.12.0, 1.001★, TypeScript, MIT.

**Escala medida:** 5.423 arquivos, **~1.027.000 linhas de TypeScript**, **14
packages**, **46 ADRs**, e uma série de 26 documentos
`docs/dev/building-coding-agents/`.

Providers: `ollama` (local), `anthropic`, `openai`, `google`, `groq`, `xai`, `mistral`,
`openrouter`, **`claude-code`**, **`cursor-agent`**.

Quatro ADRs respondem perguntas que estávamos fazendo **[docs-1ª]**:

- **ADR-046 · database-authoritative workflow lifecycle** — o estado autoritativo é
  banco; `.gsd/` é projeção. O Forge ainda tem markdown como fonte.
- **ADR-004 · capability-aware model routing** — pontua modelos em **7 dimensões de
  capacidade**. O `tier` do Forge é unidimensional.
- **ADR-005 · multi-model, multi-provider and tool strategy** — três ideias que o Forge
  não tem: *"hard constraints filter; soft scores rank"* (suporte a tool é binário e
  **filtra** o conjunto elegível antes de qualquer pontuação); o **conjunto de tools se
  adapta** quando o roteador troca de modelo (`adjustToolSet`); e o
  **`ProviderSwitchReport`**, que contabiliza a *perda de fidelidade* numa troca
  cross-provider — blocos de thinking descartados, IDs de tool remapeados — e a emite
  como evento de auditoria, em vez de degradar em silêncio.
- **ADR-008 · GSD workflow tools sobre MCP para paridade de provider** (implementado, 6
  fases) — os mesmos **11 executores transport-neutral** alcançáveis nativamente **e**
  por MCP, com um teste provando que a chamada via MCP produz **as mesmas escritas no
  banco, os mesmos artefatos e as mesmas transições de estado**. E o Claude Code entra
  como provider pelo Agent SDK com `mcpServers` anexado.
  **Isto é a rota "CLI como subprocesso preservando assinatura" já construída, e com
  teste de paridade.**

**O que é de quem** [código, via grep no fonte deles]:

| Conceito | Arquivos no `gsd-pi` | Leitura |
|---|---:|---|
| `challenger` | **0** | **só do Forge** |
| `advocate` | **0** | **só do Forge** |
| `dialectic` | **0** | **só do Forge** |
| `setup-token` | **0** | **só do Forge** |
| `must_have` | 9 | convergente |
| `verifier` | 5 | convergente |
| `cooldown` | 8 | convergente |
| `handoff` | 75 | convergente? — sentido não verificado |
| `evidence` | 404 | eles vão mais longe |
| `worktree` | 521 | eles vão mais longe |
| `slice` | 1.345 | eles vão mais longe |
| `milestone` | 1.385 | eles vão mais longe |

**Conclusão:** o **review dialético** e a **rotação multi-conta de assinatura** são
genuinamente do Forge. A ausência do segundo lá faz sentido: eles resolvem escassez
trocando de **provider**, não de **conta do mesmo provider**.

### Os candidatos a motor

**[`anomalyco/opencode`](https://github.com/anomalyco/opencode)** — 192.901★, MIT,
TypeScript/bun **[código]**. 6.358 arquivos, **26 packages**. Os que importam: `server`
(com **`pty-environment.ts`**, PTY gerido no servidor), `protocol`/`client`/`sdk`
(cliente-servidor com contrato tipado) e `plugin` (extensão em `tool.ts`, `tui.ts`,
`shell.ts`). Providers: anthropic (452 ocorrências), openai (414), deepseek (151),
google (94), openrouter (87), gemini (84), xai (59), mistral (57), lmstudio (41),
ollama (36), azure (35), groq (26). **É a referência mais forte para "servidor + SDK +
plugin"**: local e servidor viram a mesma coisa com endereços diferentes, e extensão
não exige fork.

**[`aaif-goose/goose`](https://github.com/aaif-goose/goose)** — 52.178★, Apache-2.0,
Rust **[código]**. 2.309 arquivos, 12 crates com fronteiras limpas: `goose-providers` +
`goose-provider-types` (abstração de provider isolada em crate própria, com tipos
separados), `goose-sdk` + `goose-sdk-types`, `goose-local-inference` (inferência local
*in-process*) e `goose-acp-macros` (Agent Client Protocol). *"native open source AI
agent — **desktop app, CLI, and API**"*, macOS/Linux/Windows, com badge de saúde da
Linux Foundation. **É a descrição literal do que se quer de local-first + app nativo.**

**[`cline/cline`](https://github.com/cline/cline)** — 65.571★, Apache-2.0, TypeScript
**[código]**. 3.545 arquivos, `apps/{cli,vscode,cline-hub,examples}` + `sdk/` com
`ARCHITECTURE.md` próprio. Cobertura de nuvem mais ampla: anthropic (620), openrouter
(292), deepseek (292), openai (271), ollama (152), gemini (118), **bedrock (101)**,
**vertex (98)**. Mais orientado a IDE que os dois acima, mas o SDK é real.

**[`OpenHands`](https://github.com/OpenHands/OpenHands)** — 83.017★ +
[`software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk) 956★
**[docs-1ª]**. Arquitetura **event stream**: toda interação agente↔ambiente vira evento
tipado num hub central, com um **`AgentController` que supervisiona e impõe restrições
operacionais** enquanto o `CodeActAgent` decide.

> O paper [arXiv 2511.03690](https://arxiv.org/abs/2511.03690) reporta que a V1
> **reduziu substancialmente as falhas atribuíveis ao sistema** frente à V0, com
> overhead de event sourcing desprezível. **É a única migração desse tipo com número
> publicado** — e a única evidência externa de que este desenho compensa.

### O achado que muda a arquitetura: execução durável **[docs-1ª]**

Nenhum dos motores acima resolve isto, e é o que o Forge está fazendo à mão sem saber o
nome. O `continue.md`, o arquivo `pause`, o `auto-mode.json` e o **Compaction
Resilience Protocol** inteiro são uma reimplementação em prosa de **execução durável**:
um fluxo que sobrevive à morte do processo e retoma no passo exato. Esse problema tem
solução de indústria, rigorosa, há anos.

| | | Por que importa aqui |
|---|---|---|
| [`temporalio/temporal`](https://github.com/temporalio/temporal) | **22.074★** Go | O padrão de fato. Workflow determinístico + histórico event-sourced + **replay**. Workers morrem; o workflow não |
| [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) | **38.792★** Py | O nativo de LLM: grafo + **checkpointing** + **interrupt/resume** — exatamente a mecânica dos gates do Forge |
| [`inngest/inngest`](https://github.com/inngest/inngest) | 5.685★ Go | *"stateful step functions"* |
| [`restatedev/restate`](https://github.com/restatedev/restate) | 4.243★ Rust | *"resilient applications that tolerate all failures"* |
| [`dbos-inc/dbos-transact-py`](https://github.com/dbos-inc/dbos-transact-py) | 1.513★ Py | **Workflows duráveis respaldados por banco** — o mais leve, e casa com o ADR-046 |
| [`pgflow-dev/pgflow`](https://github.com/pgflow-dev/pgflow) | 301★ TS | Motor centrado em Postgres — pequeno o bastante para ler inteiro |

**O risco que parecia derrubar tudo está resolvido.** A versão anterior desta pesquisa
listava como incógnita: *"determinismo de replay com efeito colateral de LLM é
exatamente onde essas ferramentas exigem desenho cuidadoso."* A documentação do
Temporal responde de forma limpa e favorável:

> Código de workflow deve ser estritamente determinístico. Operações
> não-determinísticas — **chamadas de API externa, consultas a banco, invocações de
> LLM/IA**, aleatoriedade e tempo — **devem ser delegadas a Activities**. Durante o
> replay, **Activities não são re-executadas**: seus resultados gravados são lidos do
> Event History.

Ou seja: **o padrão que o Forge precisa é o padrão canônico da ferramenta**, e
invocação de LLM está nomeada explicitamente na lista.

E isso tem uma consequência de custo que ninguém tinha notado: **uma run que morre não
re-paga as unidades já concluídas.** Hoje, um `/forge-auto` interrompido no meio de uma
milestone refaz contexto e reprocessa.

**Os dois modelos não são o mesmo [docs-1ª]:**

| | **Temporal** (replay) | **LangGraph** (checkpoint) |
|---|---|---|
| Retomada | Re-executa o código do workflow comparando Commands contra o Event History; Activities voltam do histórico | Restaura o **snapshot** do `thread_id` e continua dali |
| Trilha de auditoria | **Histórico completo de toda decisão**, por construção | Snapshot do estado, não o caminho até ele |
| Gate humano | Signal | **`interrupt()`** — pausa no checkpoint e retoma com o mesmo `thread_id`, inclusive **através de reinício de processo** |
| Custo operacional | Serviço (servidor Go + banco) | Biblioteca |
| Linguagem | SDKs em várias | Python-first |

Para o Forge a distinção pesa: o `events.jsonl`, o evidence log e o route audit **já
querem ser um Event History**. O modelo de replay é um superconjunto estrito do que
eles tentam fazer à mão.

### As categorias que faltavam

**Sandbox [meta].** O Forge roda agentes que escrevem e **executam** código, e seu
único isolamento é worktree do git — que isola **arquivos**, não **execução**. Um
worker pode `rm -rf`, sair para a rede ou esgotar a memória da máquina.
[`daytona`](https://github.com/daytonaio/daytona) (72.059★),
[`firecracker`](https://github.com/firecracker-microvm/firecracker) (35.855★, a
primitiva sobre a qual o AWS Lambda roda),
[`coder`](https://github.com/coder/coder) (14.019★),
[`E2B`](https://github.com/e2b-dev/E2B) (13.244★) e
[`microsandbox`](https://github.com/superradcompany/microsandbox) (7.122★, Rust,
*local-first microVM runtime and library* — o encaixe exato).

> **Isto reescreve o requisito de "não cair por memória".** A resposta é melhor do que
> uma heurística de `cores − 2`: é **limite de sandbox** (cgroup / microVM). Você não
> adivinha a RAM disponível — você **capa** a de cada worker e deixa o kernel impor.

**Evals [meta].** É a lacuna metodológica mais séria de todo o levantamento: todo o
plano assume que o v2 supera o v1 e **não há como saber**. Um projeto cuja premissa é
falsificabilidade não pode omitir o instrumento de medida.
[`terminal-bench`](https://github.com/harbor-framework/terminal-bench) (2.518★,
*benchmark for LLMs on complicated tasks in the terminal* — **o mais próximo do que o
Forge faz**), [`SWE-bench`](https://github.com/SWE-bench/SWE-bench) (5.561★),
[`langfuse`](https://github.com/langfuse/langfuse) (32.444★),
[`openai/evals`](https://github.com/openai/evals) (19.099★, esfriando).

**Memória [meta].** O `AUTO-MEMORY.md` — cap de 50, confidence com decay,
`forge-sweep` para podar — é uma camada de memória feita à mão. As de verdade:
[`mem0`](https://github.com/mem0ai/mem0) (62.426★),
[`cognee`](https://github.com/topoteretes/cognee) (29.737★),
[`letta`](https://github.com/letta-ai/letta) (24.072★, agentes *stateful* com memória
que **se auto-edita**, linhagem MemGPT), [`zep`](https://github.com/getzep/zep) (4.806★).

**Protocolos [meta].** [`MCP servers`](https://github.com/modelcontextprotocol/servers)
(89.167★, o Forge já consome), [`A2A`](https://github.com/a2aproject/A2A) (25.170★),
[a spec do MCP](https://github.com/modelcontextprotocol/modelcontextprotocol) (8.847★)
e [`ACP`](https://github.com/agentclientprotocol/agent-client-protocol) (3.854★,
*"conectar qualquer editor a qualquer agente"* — o `goose` já embarca
`goose-acp-macros`). **Se o Forge falar ACP, qualquer editor compatível o dirige** — e
o app deixa de ser a única superfície possível.

### Peças isoladas que resolvem um problema nosso

| Projeto | | Resolve |
|---|---|---|
| [`context-packet`](https://github.com/gsd-build/context-packet) **[docs-1ª]** | 50★ TS | **Recuperação por orçamento.** `resolve(node, {maxTokens})` sobre um DAG, com wrapping anti-injection e `input_hash` SHA-256 para skip idempotente. Mata o `last 30 rows de DECISIONS.md`. Zero dependências, três primitivas |
| [`daemon`](https://github.com/gsd-build/daemon) **[docs-1ª]** | 8★ Go | **Local + rede.** Websocket persistente com relay, streama saída cross-device, **write-ahead log** |
| [`claude-squad`](https://github.com/smtg-ai/claude-squad) **[meta]** | 8.230★ Go | **Multiplexação de agentes de terminal** — Claude Code, Codex, OpenCode e Amp. É o trabalho da tela de terminal do app do Forge, já feito. **Ler antes de investir mais ali** |
| [`litellm`](https://github.com/BerriAI/litellm) **[meta]** | 55.455★ | **Gateway multi-provider como processo** — 100+ APIs, fallback, budget, rate limit e logging em config |
| [`agent-flow`](https://github.com/patoles/agent-flow) **[meta]** | 1.440★ TS | **Observabilidade** — a árvore slice → task → worker desenhada ao vivo |
| [`SWE-agent`](https://github.com/SWE-agent/SWE-agent) **[2ª mão]** | 19.991★ Py | **Agent-Computer Interface** — desenhar as tools *para o modelo*, não para o humano |
| [`sidekick`](https://github.com/redevops-io/sidekick) **[meta]** | 9★ Py | Forma do escalonador: DAG de sub-sessões auto-aprovadas, isoladas por worktree |

### Metodologias alternativas **[meta]**

Competem com o **GSD**, não com o Forge — e são úteis por dois motivos: roubar
decomposição, e servir de prova de que a separação motor/política é real (rodar outra
política no mesmo motor). [`github/spec-kit`](https://github.com/github/spec-kit)
(**125.191★**, Spec-Driven Development da GitHub, **agnóstico de agente**),
[`BMAD-METHOD`](https://github.com/bmad-code-org/BMAD-METHOD) (51.442★),
[`claude-task-master`](https://github.com/eyaltoledano/claude-task-master) (27.936★).

**Categoria errada:** agentes de IDE — `Aider` (47.913★, e a origem do **repo-map**),
`continue` (35.305★), `kilocode` (26.695★), `Roo-Code` (24.360★, esfriando). E **não
usar como base** o `winfunc/opcode`: 22.348★, mas **último push out/2025**.

---

## 9. Ficar mais inteligente — o eixo que hoje não existe

Este é o único eixo onde o Forge já tem a **forma** certa e o **método** errado.

### O achado central: ACE **[docs-1ª]**

[arXiv 2510.04618](https://arxiv.org/abs/2510.04618) trata contexto como **playbook
evolutivo** que acumula, refina e organiza estratégias por três módulos — **geração**,
**reflexão** e **curadoria**. Os números que os autores reportam:

| | |
|---|---|
| Ganho em tarefas de agente | **+10,6%** |
| Ganho em domínio financeiro | +8,6% |
| **Redução de custo de token** | **−83,6%** |
| Redução de latência de adaptação | −91,5% |
| Dados rotulados necessários | **nenhum** — usa *feedback natural de execução* |

E nomeia duas patologias que valem por si:

- **Brevity bias** — o sistema privilegia concisão e **perde conhecimento específico do
  domínio**.
- **Context collapse** — reescrever o contexto repetidamente **erode a informação** ao
  longo do tempo.

A mitigação é **atualização incremental estruturada** (*delta*), em vez de reescrever o
playbook inteiro a cada rodada.

> **O diagnóstico desconfortável:** o `AUTO-MEMORY.md` tem **cap de 50 entradas**,
> *confidence decay* e o `forge-sweep` para **podar**. Isso é literalmente **brevity
> bias implementado de propósito** — o Forge poda o próprio playbook para mantê-lo
> curto, que é exatamente a falha que o paper identifica. E o quality gate de três
> perguntas é curadoria feita por prosa, não por feedback medido.
>
> Pior: **o Forge já tem o feedback natural de execução e joga fora.** Must-haves
> passa/falha, níveis do verifier, objeções do review, resultado de lint e de teste —
> nada disso chega ao sistema de memória, que lê o *summary*, ou seja, a narração.

### O ecossistema do eixo **[meta]**

| | | O que resolve |
|---|---|---|
| [`dspy`](https://github.com/stanfordnlp/dspy) | **36.600★** Py | *"Programar, não promptar"* — você define módulos e **uma métrica**, e o framework **compila** os prompts contra ela. É a resposta direta a "melhorar a lógica": prompt deixa de ser escrito à mão e passa a ser **otimizado por medição** |
| [`LLMLingua`](https://github.com/microsoft/LLMLingua) | 6.521★ Py | **Compressão de prompt** (EMNLP'23/ACL'24) |
| [`RouteLLM`](https://github.com/lm-sys/RouteLLM) | 5.295★ Py | **Roteador de modelo aprendido** — é a tabela de tier do Forge, porém treinada. ⚠️ push ago/2024 |
| [`Voyager`](https://github.com/MineDojo/Voyager) | 7.109★ | **Biblioteca de skills**: o agente escreve e **reutiliza** as próprias habilidades. ⚠️ push abr/2024 |
| [`reflexion`](https://github.com/noahshinn/reflexion) | 3.221★ Py | **Reflexão verbal** (NeurIPS 2023) |
| [`textgrad`](https://github.com/zou-group/textgrad) | 3.684★ Py | Feedback de LLM como gradiente |
| [`agent-workflow-memory`](https://github.com/zorazrw/agent-workflow-memory) | 450★ Py | **AWM** — induz *workflows reutilizáveis* da experiência passada |

### Como aterrissa

| Peça do Forge hoje | O que muda |
|---|---|
| `AUTO-MEMORY.md` com cap 50 + decay + `forge-sweep` | Vira **playbook com atualização delta**. Deixa de podar por tamanho e passa a organizar por utilidade medida |
| Quality gate de 3 perguntas em prosa | Vira **curadoria por feedback de execução** |
| `agents/*.md` ajustados à mão | Viram **módulos compiláveis contra a métrica** da eval |
| Tabela estática de tier | Vira **roteamento aprendido** do histórico |
| `CODING-STANDARDS.md` | É o playbook de domínio — alvo natural do ciclo |
| Contexto injetado por janela | **Compressão** + recuperação por orçamento |

**A condição de possibilidade é o Event History.** Nada disso funciona sem registro
estruturado e consultável de cada unidade. É o mesmo dado que a eval consome.
**Durabilidade, medição e auto-melhoria são a mesma infraestrutura vista de três
ângulos.**

⚠️ Os números do ACE são **do abstract dos autores**, sem replicação independente nesta
pesquisa. E `Voyager`, `RouteLLM` e `Reflexion` são artefatos de pesquisa com push
antigo — valem pela **ideia**, não como dependência.

### A metade externa: não envelhecer

A seção acima trata de aprender com a **própria experiência**. Esta, com o que **muda
por fora**. É o mesmo circuito — sinal → delta proposto → portão medido — apontado para
outra direção. E não é opcional, porque o modelo por baixo muda de forma que **quebra
silenciosamente**:

| O que envelhece | Consequência |
|---|---|
| IDs em `tier_models` | Modelo **aposentado responde 404** — o dispatch quebra e ninguém sabe até rodar. **Sonnet 3.7 e Haiku 3.5 foram aposentados em fev/2026** |
| Guards de `thinking`/`effort` por família | Combinação inválida vira **HTTP 400** |
| Mínimos de cache por modelo | **Não são monotônicos** e mudaram entre 4.6 e 5. Um breakpoint dimensionado para um tier deixa de cachear noutro, sem erro |
| Preços por MTok | A medição de custo vira ficção |
| Janela de contexto e teto de saída | Truncamento no meio da resposta |
| Prompts e descrições de tool | *"Prompts são artefatos por modelo; uma linha que sustenta uma geração é entulho na seguinte"* |

**O padrão seguro já foi validado pelo upstream [código]:** o `gsd-pi` tem
`.github/workflows/update-model-catalog.yml`, com refresh **semanal** (terça, 09:17
UTC), e a decisão de desenho está escrita no comentário do arquivo:

> *"Abre um PR de bot com o diff, para que a mudança chegue pelo review + CI normais,
> em vez de um push não-revisado na main."*

**Detectar automaticamente; aplicar sob portão.** Essa é a linha que separa
auto-aprimoramento de auto-regressão. Em três camadas, por risco:

| Camada | O que é | Como entra |
|---|---|---|
| **1 · Fato estruturado** | Catálogo de modelos via Models API — legível por máquina e autoritativo | **Automático.** Cron semanal → PR de bot com o diff |
| **2 · Prosa normativa** | Release notes, guia de migração, changelog | **Detecta, não aplica.** Gera um **item de triagem**. Nunca um patch |
| **3 · Mudança comportamental** | Prompt, `effort`, roteamento, orquestração | **Só entra com prova** da eval |

> ⚠️ **Por que a camada 2 nunca é automática.** Um agente que lê prosa da internet e
> reescreve os próprios prompts é superfície de **prompt injection com raio de explosão
> ilimitado** — e o efeito é invisível até degradar o resultado. A leitura pode ser
> automática; a escrita, não.

---

## 10. A arquitetura de partida

### O que o Forge escreve

- **A política GSD como programa** — o dispatch, as fases, os gates e o orçamento
  expressos em código, com os fatores 8 e 4 como **invariante testável**. Isto **roda
  sobre** um motor de execução durável; o Forge não escreve o motor.
- **A disciplina de cache e a stagger no fan-out** — não trocar de modelo sem motivo,
  breakpoint a cada ~15 blocos, Batch API nas unidades não-interativas. **Nenhum
  projeto levantado faz isso**, e é diferencial real, não cópia.
- **As três coisas que só o Forge tem** — review dialético, rotação multi-conta de
  assinatura, camada anti-alucinação (`must_haves` + verifier + evidence + route audit).

**O que saiu dessa lista, e para onde foi:**

| Era "o Forge escreve" | Virou |
|---|---|
| Motor de loop com pause/resume/retomada | **Execução durável**. O Compaction Resilience Protocol deixa de existir em vez de melhorar |
| Consciência de máquina por heurística (`cores − 2`) | **Limite de sandbox**. Não se adivinha RAM; capa-se e o kernel impõe |
| Recuperação de conhecimento | **`context-packet`** + mem0/letta |

E o paralelismo, que parecia órfão, se decompõe em três peças já distribuídas:
**child workflows** do motor durável (executar em paralelo), **limite de sandbox**
(não derrubar a máquina) e **stagger no fan-out** (não pagar N× o prefixo). Nenhuma é
escalonador escrito à mão. O que sobra como decisão nossa é a **política**: quais
unidades podem correr juntas dado o DAG do ROADMAP — e isso é leitura de grafo.

### O mapeamento GSD → execução durável

O encaixe é quase suspeito de tão direto. A hierarquia do GSD **já é** uma árvore de
workflows; ela só nunca teve um motor.

| Conceito GSD | Primitiva | Por quê |
|---|---|---|
| Milestone | **Workflow** | Vive horas ou dias, sobrevive a reinício, tem histórico próprio |
| Slice | **Child workflow** | Isolamento de falha e retomada independentes |
| Task / unidade | **Child workflow** ou passo | Depende de querer histórico por task |
| **Despacho de worker (chamada de LLM)** | **Activity** | Não-determinístico por definição — journalizado, nunca re-executado no replay |
| Comando git, spawn de sandbox, poll de uso | **Activity** | Efeito colateral externo |
| Gate (`AskUserQuestion`, plan gate, triagem) | **Signal** | O workflow dorme sem consumir nada até a resposta chegar |
| Pause | **Signal** | Deixa de ser arquivo-sinal com polling |
| Handoff de conta por esgotamento | **Signal** + retry de Activity | O workflow nem percebe que trocou de conta |
| Statusline / app / dashboard | **Query** | Lê estado sem tocar na execução |
| Orçamento de tokens da milestone | Estado do workflow | Determinístico, versionado no histórico |
| `events.jsonl` | **Event History** | Deixa de ser log paralelo escrito à mão |

O ponto que fecha o desenho: **os gates param de ser o problema difícil.** Hoje um gate
no headless degrada para `defer` porque não há canal. Num workflow durável, o gate é um
Signal — o milestone simplesmente **espera**, por horas ou dias, sem processo vivo, sem
token queimado, sem `continue.md`.

### O que isso apaga

O ganho não é "fica mais bonito" — é **código que deixa de existir**:

| Some | Porque |
|---|---|
| Compaction Resilience Protocol | O estado do loop nunca esteve no contexto |
| `continue.md` (Continue-Here Protocol) | Retomada é propriedade do motor |
| `auto-mode.json`, heartbeat, stale check de 15min | O motor sabe se o workflow vive |
| Arquivo `pause` + polling na fronteira de unidade | Signal |
| `AUTONOMY RULE — CRITICAL` | Um `while` não precisa ser convencido a não parar |
| *"proibido executar inline quando `Agent()` falha"* | Vira política de retry da Activity |
| Metade do `CLAUDE.md` | Regra de comportamento vira invariante de código |

**Duas linhas que uma revisão tirou desta lista, por sobrestimarem:** o registro de
runs **não** some — só a metade de *liveness*; ele também carrega `branch`, `root`,
`project`, `account`, `isolation_mode` e `touched`, e **endereço de run e arquivos
tocados não são metadado de workflow**. E o route audit *pode* virar consulta ao Event
History, **mas só se a Activity gravar o metadado de engine** — isso é desenho a fazer,
não propriedade herdada.

> O padrão vale registrar: **execução durável apaga o que é sobre *quando* e *se* algo
> rodou; não apaga o que é sobre *onde* e *com o quê*.**

### O que não copiar

- **Não copiar arquitetura alheia inteira.** O Forge lidera nos fatores 5 e 10 do
  12-factor; adotar em bloco jogaria isso fora.
- **Não reescrever PTY, TUI e transporte de provider.** Commodity.
- **Não herdar o roteamento por capacidade sem precificar o cache** — quanto mais
  "inteligente" o roteamento, mais cache queimado.

> **Uma tensão que precisou ser resolvida.** Levar *"banco como autoridade"* (ADR-046)
> parece contradizer "proteger o fator 5", já que hoje o fator 5 do Forge **é** o
> `.gsd/` em arquivos. Não contradiz: o que o fator 5 pede é que estado de execução e
> de negócio sejam **a mesma coisa, auditável**. Essa é a **propriedade**; markdown é
> só o **meio**. Um banco preserva a propriedade e melhora a auditoria — desde que o
> `.gsd/` continue existindo como **projeção legível e diffável**. Perder isso, sim,
> seria perder o fator 5.

### Os padrões de orquestração, de primeira mão **[docs-1ª]**

O time do Claude Code publicou os padrões que usa para orquestrar subagentes em escala:
*classify-and-act* · *fan-out-and-synthesize* · **adversarial verification** ·
*generate-and-filter* · *tournament* · *loop until done*.

> **O review dialético do Forge é o terceiro, nomeado por quem constrói o Claude
> Code.** Aquilo que a comparação com o `gsd-pi` mediu como tendo **zero arquivos** lá
> não é excentricidade nossa — é um padrão de primeira linha que o upstream não
> implementa.

E os três anti-padrões que eles nomeiam explicam, com precisão desconfortável, sintomas
que o Forge já documentou:

| Anti-padrão | Onde aparece no Forge |
|---|---|
| **Agentic laziness** — declarar concluído com progresso parcial | É o que a camada anti-alucinação inteira existe para pegar |
| **Self-preferential bias** — preferir os próprios achados à evidência | É a razão de `challenger: auto` resolver para a família **oposta** à do autor |
| **Goal drift** — perda de fidelidade por sumarização sucessiva | É o que a memória emergente com quality gate tenta conter |

---

## 11. O caminho — estrangulamento, não big bang

Esta era a lacuna mais séria da pesquisa: ela decidia *construir novo* sem dizer como
sair de um sistema que funciona e está em uso. A resposta é o padrão **strangler**, e
ele tem uma propriedade que muda o risco inteiro:

> **A primeira Activity que o workflow chama é o Forge de hoje.**

O workflow novo nasce despachando a skill atual, sem modificação, como uma Activity. No
dia um você já tem histórico, retomada, gate por Signal e pause por Signal, **rodando o
Forge existente por baixo**. Depois cada Activity é substituída, uma por vez.

| Fase | O que entrega |
|---|---|
| **0 — spike** | Workflow com **uma Activity por unidade**, e a Activity é um `/forge-next` de hoje. O loop de slices e o avanço de fase ficam no workflow; a lógica de cada unidade segue intocada |
| **1 — kernel** | `continue-as-new` na fronteira de slice e *claim check* via `.gsd/` para resultados grandes. Sem isto, milestones longos estouram o histórico |
| **2 — plano de controle** | Os gates saem do markdown e viram Signals. O `defer` no headless deixa de ser necessário. Eval montada, registro estruturado, roteamento medido |
| **3 — composição** | A Activity de despacho ganha executor plugável, e aí sim entra provider que não é Claude |
| **4 — isolamento** | Sandbox por worker, recuperação por orçamento |

> ⚠️ **Uma correção que a pesquisa fez em si mesma.** A primeira versão da fase 0
> envolvia o `/forge-auto` **inteiro** numa Activity. O catálogo de falhas de produção
> (§12) mostra que isso dá durabilidade só na fronteira do milestone: uma queda na 8ª
> task recomeçaria da 1ª, e **o não-re-pagamento prometido não aconteceria**. Envolver
> a *unidade* em vez do *loop* preserva o estrangulamento e entrega durabilidade
> granular desde o dia um.

Cada fase é reversível e mensurável isoladamente. Em nenhum momento existe um "Forge
v2" que precisa estar pronto para o Forge v1 ser desligado.

### A primeira slice — o kernel falseável

Não começar pelo scaffold. Começar pelo **mínimo que prova ou mata o plano**: um
workflow durável rodando **uma milestone real deste repositório**, com pause por
Signal, gate por Signal e retomada após matar o processo. Sem TUI, sem app, sem
executor plugável.

Quatro perguntas falseáveis:

1. **Matar o processo no meio de uma unidade e retomar** devolve o milestone ao passo
   exato, sem `continue.md` e **sem re-pagar** as unidades concluídas?
2. O gate chega e pode ser respondido **fora** da TUI do Claude Code, por Signal?
3. Uma Activity que envolve um `claude -p` de 40 minutos sobrevive ao *heartbeat*? Isto
   está **parcialmente respondido**: exige heartbeat calibrado, e a falha é **chamada
   de LLM duplicada** — custo real, não só erro.
4. **Existe uma medida?** Uma task do `terminal-bench` rodando pelo caminho novo *e*
   pelo Forge atual, com o mesmo modelo — não para ganhar, mas para provar que a régua
   existe antes de haver o que medir.

Se as quatro passarem, as fases 1 a 4 são preenchimento incremental. Se a (3) falhar, o
recorte de Activity muda — e isso é desenho, não bloqueio. **Se a (4) não for montada
primeiro, nenhuma das outras três tem como ser defendida depois.**

**Medição que deve acompanhar:** custo de uma milestone real a preço de API contra a
assinatura. `--output-format json` já devolve `total_cost_usd` por invocação. Sem esse
número, a escolha entre executor de assinatura e executor de API é convicção, não
orçamento.

### Qual motor? Ainda não decidido

| Eixo | Temporal | LangGraph | DBOS |
|---|---|---|---|
| Trilha de auditoria por construção | **sim** | não (snapshot) | parcial |
| Gate que dorme por dias | sim (Signal) | sim (`interrupt()`) | sim |
| Custo de operação | **alto** (serviço + banco) | baixo (biblioteca) | médio (Postgres) |
| Encaixe com "banco é autoridade" | indireto | indireto | **direto** |
| Nativo de LLM | não | **sim** | não |
| Maturidade / adoção | **22.074★**, padrão de indústria | 38.792★, LLM-nativo | 1.513★ |
| Amarra a stack | Go + SDK | Python | Python + Postgres |

**Não são só alternativas — são componíveis.** O padrão publicado de produção executa
*"uma execução de LangGraph dentro de uma única Activity longa do Temporal"*. **Mas
isso colide com a falha nº 10**: loop inteiro numa Activity perde durabilidade
granular. A composição só é segura quando o que roda dentro da Activity é **uma unidade
curta**, não o loop.

**Leitura preliminar**, a confirmar no spike: o Forge quer a *trilha* do Temporal com o
*custo operacional* do DBOS. Nenhuma linha desta tabela deve virar decisão sem o spike
— ela foi construída de documentação e metadado, não de uso.

---

## 12. O que pode dar errado **[2ª mão]**

Existe um catálogo público de **onze falhas de produção** de agentes sobre Temporal.
Vale mais que qualquer página de marketing, porque descreve o que quebra **depois** que
funciona. E **uma delas derrubou a versão original da fase 0**.

| # | Falha | Consequência para o Forge |
|---|---|---|
| **10** | **SDK de agente inteiro dentro de uma Activity** — *"falha na iteração 47 recomeça da 1"* | **Derrubou a fase 0 original.** Corrigido: a Activity envolve a unidade |
| **3** | **Loop sem limite de iteração** — degradação em ~500–600 iterações, teto de **51.200 eventos** | Um milestone longo estoura. Mitigação: `continue-as-new` na fronteira de slice — que é exatamente onde o GSD já corta |
| **9** | **Payload acima do limite** — 2MB por payload, 4MB por transação; saída grande **termina o workflow sem retry** | Resultado com diff e summary pode passar. Mitigação: *claim check* — e **o `.gsd/` já é esse armazenamento** |
| **2** | **Activity longa sem heartbeat** — o motor assume worker morto e **reescala**, gerando **chamada de LLM duplicada** | Custo direto: um `execute-task` de 40min pagando duas vezes |
| **6** | **Gate humano sem timeout** | A triagem de review e o plan gate travam para sempre |
| **7** | **Versionamento quebra o replay** | O Forge itera no próprio loop o tempo todo. **Boa notícia: mudança de prompt é segura** (vive na Activity); mudança de fluxo exige guard de versão |
| **5** | **`ParentClosePolicy` default é ABANDON** | Cancelar um milestone deixaria as slices rodando |
| **4** | **Retry ingênuo em 429** | O Forge já tem taxonomia de falha; acrescenta respeitar `Retry-After` |
| **8** | **Observabilidade** — *"Activity X deu timeout"* não diz o que o agente fazia | Exige atributos de busca com tipo de unidade, iteração, última tool, modelo e tokens |

**A leitura que importa:** nenhuma dessas falhas é motivo para não adotar execução
durável — todas têm mitigação conhecida. Mas **três delas mudam o desenho**, e
descobri-las depois de construir custaria a milestone.

---

## 13. Quanto tempo — e por que a estimativa é fraca

**Velocidade medida deste repositório**, não estimada: 73 unidades executadas, **7
toques humanos**. É a base de comparação; qualquer número abaixo é derivado dela.

| Fase | Ordem de grandeza |
|---|---|
| **0 — spike** | dias |
| **1 — kernel** | semanas |
| **2 — plano de controle** | semanas |
| **3 — composição** | semanas |

A ressalva importa mais que os números: **nada foi construído**, então isto é
planejamento de trabalho desconhecido. As duas incertezas dominantes são **operar um
motor durável** (custo recorrente, não pontual) e o **atrito da migração por
estrangulamento**, que é onde projetos deste tipo estouram.

**A fase 0 é a única com estimativa defensável**, porque é falseável: ou a unidade
sobrevive ao kill, ou não. Ela existe justamente para **converter as fases 1–3 de
estimativa em medição**. Rodar a fase 0 antes de comprometer prazo com o resto é a
recomendação, não um detalhe de sequenciamento.

> **Um débito de instrumentação bloqueia a medição.** O `events.jsonl` **não registra
> duração por unidade**. Sem carimbo de início/fim, o ganho de paralelismo da fase 3 é
> inafirmável — não há linha de base contra a qual comparar. Acrescentar o carimbo é
> mudança aditiva de baixo custo e deveria preceder a fase 0.

---

## 14. O que ainda está em aberto

1. **Qual motor de execução durável** — decide custo operacional, linguagem e se o
   `.gsd/` continua sendo arquivo ou vira banco.
2. **Assinatura vs API.** O Agent SDK é empurrado para API key — os docs dizem que a
   Anthropic não permite que produtos de terceiros ofereçam login/limites claude.ai,
   *incluindo* agentes construídos sobre o Agent SDK. O caminho do CLI como subprocesso
   é explicitamente sancionado e preserva a assinatura. **Decide toda a máquina
   multi-conta.**
3. **`--permission-prompt-tool` recebe os gates no caminho do CLI?** Se sim, a rota do
   subprocesso tem tudo que o SDK tem e continua na assinatura. Não verificado.
4. **Onde fica a fronteira de Activity** — o worker inteiro, ou o passo dentro do
   worker? Decide granularidade da retomada e tamanho do Event History.
5. **Namespace do runtime** — se `.gsd/` vira "o storage da política GSD", o runtime
   precisa do seu. Custo de migração real.
6. **O formato do `.gsd/` do `gsd-pi` é compatível com o nosso?** Decide se há caminho
   de migração ou só de reescrita.
7. **`handoff` no `gsd-pi` (75 arquivos)** — é handoff de conta ou o "agent-human
   maintainability handoff" da série de docs deles?
8. **Fork, contribuição ou camada** — as duas features que o `gsd-pi` não tem continuam
   sendo contribuição de baixo custo e alta alavancagem, independentemente do caminho.

---

## 15. O que esta pesquisa **não** verificou

Registrado para que ninguém trate leitura de README como leitura de código.

- **Paralelismo real, consciência de memória e qualidade de recuperação** em qualquer
  um dos projetos — exige **rodar e medir**, não ler.
- Arquitetura em profundidade de `cline` e do `OpenHands SDK` — li estrutura e paper,
  não o código como no `gsd-pi`.
- Tudo marcado **[2ª mão]**: `SWE-agent`, `awesome-harness-engineering`, e os
  orquestradores de cauda longa.
- Se as decisões dos ADRs do `gsd-pi` estão **implementadas** como declaram — confirmei
  só o ADR-008, que traz tabela de status por fase e teste de paridade.
- **Sandbox, evals, memória e protocolos seguem [meta]** — verifiquei existência,
  linguagem, licença, atividade e descrição oficial; **não li o código de nenhum
  deles**. A escolha entre `microsandbox` e `firecracker`, ou entre `mem0` e `letta`,
  exige leitura que esta sessão não fez.
- **Execução durável subiu para [docs-1ª]** e o risco de determinismo foi resolvido —
  mas contra a documentação do Temporal, **não contra código rodando**.
- **Timeout e heartbeat de Activity longa.** Um `execute-task` pode levar 40 minutos.
  Nenhum documento lido cobre o caso "subprocesso de CLI que streama por 40 minutos".
- **Custo operacional real de rodar um motor.** Para um sistema que hoje é `npx` +
  arquivos, isso é uma mudança de natureza do produto que nenhuma leitura de doc mede.
- **A matriz de motores é preliminar** — documentação e metadado, não uso.
- **O catálogo de onze falhas é [2ª mão]** — os números (51.200 eventos, 2MB/4MB,
  ~500–600 iterações) **precisam ser confirmados na documentação oficial** antes de
  virarem restrição de desenho.
- **Os números do ACE** são do abstract dos autores, sem replicação independente.
- **Os padrões de orquestração são [docs-1ª]** e não precisam de spike — mas são
  *guidance*, não garantia: descrevem como o time do Claude Code orquestra, não um
  contrato de API.

### A ressalva que sustenta tudo

**Nada disto foi medido, porque nada foi construído.** Este documento é argumento de
por que o desenho é crível, não relato de resultado. A única evidência empírica de que
essa migração compensa é de terceiro: o OpenHands publicou redução substancial de
falhas atribuíveis ao sistema entre V0 e V1 fazendo exatamente essa mudança.

**A frase honesta é *"o v2 remove causas conhecidas de falha do v1"*, não *"o v2 é
melhor"*.**

---

## 16. Índice de referências

**Upstream e ecossistema GSD**
- [`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi) — upstream vivo · 46 ADRs · série `building-coding-agents`
- [`gsd-build/get-shit-done`](https://github.com/gsd-build/get-shit-done) — 64.772★, o original
- [`gsd-build/context-packet`](https://github.com/gsd-build/context-packet) — recuperação por orçamento
- [`gsd-build/daemon`](https://github.com/gsd-build/daemon) — local ↔ relay com WAL
- [`open-gsd/gsd-browser`](https://github.com/open-gsd/gsd-browser) — automação de browser em Rust

**Motores**
- [`anomalyco/opencode`](https://github.com/anomalyco/opencode) · [`aaif-goose/goose`](https://github.com/aaif-goose/goose) · [`cline/cline`](https://github.com/cline/cline) · [`OpenHands/OpenHands`](https://github.com/OpenHands/OpenHands) · [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk)

**Infra e peças**
- [`BerriAI/litellm`](https://github.com/BerriAI/litellm) · [`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad) · [`patoles/agent-flow`](https://github.com/patoles/agent-flow) · [`SWE-agent/SWE-agent`](https://github.com/SWE-agent/SWE-agent) · [`redevops-io/sidekick`](https://github.com/redevops-io/sidekick)

**Metodologia**
- [`github/spec-kit`](https://github.com/github/spec-kit) · [`bmad-code-org/BMAD-METHOD`](https://github.com/bmad-code-org/BMAD-METHOD) · [`eyaltoledano/claude-task-master`](https://github.com/eyaltoledano/claude-task-master)

**Execução durável**
- [`temporalio/temporal`](https://github.com/temporalio/temporal) · [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) · [`inngest/inngest`](https://github.com/inngest/inngest) · [`restatedev/restate`](https://github.com/restatedev/restate) · [`dbos-inc/dbos-transact-py`](https://github.com/dbos-inc/dbos-transact-py) · [`pgflow-dev/pgflow`](https://github.com/pgflow-dev/pgflow)

**Sandbox**
- [`daytonaio/daytona`](https://github.com/daytonaio/daytona) · [`firecracker-microvm/firecracker`](https://github.com/firecracker-microvm/firecracker) · [`coder/coder`](https://github.com/coder/coder) · [`e2b-dev/E2B`](https://github.com/e2b-dev/E2B) · [`superradcompany/microsandbox`](https://github.com/superradcompany/microsandbox)

**Evals e observabilidade**
- [`harbor-framework/terminal-bench`](https://github.com/harbor-framework/terminal-bench) · [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) · [`langfuse/langfuse`](https://github.com/langfuse/langfuse) · [`openai/evals`](https://github.com/openai/evals)

**Memória**
- [`mem0ai/mem0`](https://github.com/mem0ai/mem0) · [`topoteretes/cognee`](https://github.com/topoteretes/cognee) · [`letta-ai/letta`](https://github.com/letta-ai/letta) · [`getzep/zep`](https://github.com/getzep/zep)

**Protocolos**
- [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) · [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol) · [`a2aproject/A2A`](https://github.com/a2aproject/A2A) · [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol)

**Orquestração e falhas de produção**
- [A harness for every task: dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) — os seis padrões e os três anti-padrões, de primeira mão
- [Temporal AI Agent Failures: 11 Production Pitfalls](https://www.xgrid.co/resources/temporal-ai-agent-orchestration-failure-patterns/) — o catálogo de §12
- [AI Applications & Agents With Temporal](https://temporal.io/solutions/ai) · [Durable Execution meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai) · [Of course you can build dynamic AI agents with Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal)

**Auto-melhoria e eficiência de contexto**
- [Agentic Context Engineering — arXiv 2510.04618](https://arxiv.org/abs/2510.04618) — playbook evolutivo, delta updates, −83,6% de token
- [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) · [`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) · [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM) · [`MineDojo/Voyager`](https://github.com/MineDojo/Voyager) · [`noahshinn/reflexion`](https://github.com/noahshinn/reflexion) · [`zou-group/textgrad`](https://github.com/zou-group/textgrad) · [`zorazrw/agent-workflow-memory`](https://github.com/zorazrw/agent-workflow-memory)

**Custo por chamada e cascata**
- [FrugalGPT — arXiv 2305.05176](https://ar5iv.labs.arxiv.org/html/2305.05176) · [Is Escalation Worth It? — arXiv 2605.06350](https://arxiv.org/pdf/2605.06350)
- [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway) · [`Helicone/helicone`](https://github.com/Helicone/helicone) · [`zilliztech/GPTCache`](https://github.com/zilliztech/GPTCache) · [`ruvnet/ruflo`](https://github.com/ruvnet/ruflo)

**Teoria**
- [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) · [OpenHands Software Agent SDK (arXiv 2511.03690)](https://arxiv.org/abs/2511.03690) · [Code as Agent Harness (arXiv 2605.18747)](https://arxiv.org/html/2605.18747v1) · [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)

**Documentação de primeira mão da Anthropic**
- Prompt caching · token counting · Agent SDK overview · headless / `claude -p`

---

*Clones usados nesta pesquisa: `/tmp/{gsd-pi,opencode,goose,cline}` — efêmeros, reclone
com `--depth 1` se precisar reabrir.*
