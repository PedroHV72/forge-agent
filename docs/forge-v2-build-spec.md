---
title: Forge v2 — especificação de construção
audience: agente (planner/executor) construindo o Forge v2
purpose: entrada de milestone — restrições, decisões, constantes e critérios de aceitação
companion: docs/forge-v2.md (mesmo conteúdo, registro humano, com a argumentação)
date: 2026-08-04
status: nada aqui foi construído; ver §9 (graus de evidência) antes de tratar qualquer linha como fato
---

# Forge v2 — especificação de construção

## 0. Como usar este documento

Este documento é **entrada de planejamento**, não plano. Ele fixa o que não pode ser
violado, registra o que está decidido e o que não está, e lista os números medidos
para que nenhuma decisão seja tomada por estimativa quando existe medição.

Regras de leitura para quem for planejar ou executar a partir daqui:

1. **§1 (invariantes) governa.** Um plano que viole um invariante está errado, por
   mais elegante que seja.
2. **§3 separa decidido de aberto.** Não tratar item aberto como decidido; cada um
   traz o que precisa acontecer para fechá-lo.
3. **§4 são as constantes medidas.** Usar estes números; não recalcular de memória.
4. **§8 é a lista de recusa.** Construir qualquer item de §8 é escopo fora, não
   iniciativa.
5. **§9 grada a evidência.** `[código]` foi lido; `[2ª mão]` não foi confirmado e
   **não pode** virar restrição de desenho sem verificação.

---

## 1. Invariantes

Numerados para citação em plano e em review. `MUST` / `MUST NOT` no sentido forte.

### 1.1 Fluxo de controle

| # | Invariante |
|---|---|
| **I-01** | O fluxo de controle **MUST** ser código executável. Nenhuma decisão de loop, retry, avanço de fase ou parada pode depender de instrução em prosa dirigida ao modelo. |
| **I-02** | O resultado de um worker **MUST** ser dado estruturado validado por schema. `---GSD-WORKER-RESULT---` parseado de prosa é o defeito a eliminar, não a interface a preservar. |
| **I-03** | Toda operação não-determinística — chamada de LLM, comando git, spawn de sandbox, leitura de rede, relógio, aleatoriedade — **MUST** viver numa Activity, nunca no corpo do workflow. |
| **I-04** | A política (GSD) **MUST** ser testável sem invocar modelo nenhum. Se não for, a separação motor/política é nominal. |
| **I-05** | O motor **MUST** ser testável sem a política. |

### 1.2 Fronteiras de construção

| # | Invariante |
|---|---|
| **I-06** | O Forge **MUST NOT** escrever motor de execução durável, transporte de provider, PTY, TUI ou protocolo de interop. São commodity — adotar. |
| **I-07** | O Forge **MUST** escrever: a política GSD como programa, a disciplina de cache de §4, e as três coisas que só ele tem (review dialético, rotação multi-conta, camada anti-alucinação). |
| **I-08** | A migração **MUST** ser por estrangulamento. Em nenhum momento pode existir um estado em que o v2 precise estar pronto para o v1 ser desligado. |
| **I-09** | A primeira Activity **MUST** ser o Forge de hoje, sem modificação. |

### 1.3 Granularidade

| # | Invariante |
|---|---|
| **I-10** | A fronteira de Activity **MUST** ser a **unidade**, não o loop. Envolver `/forge-auto` inteiro numa Activity dá durabilidade só na fronteira do milestone — falha na 8ª task recomeça da 1ª (§7, falha nº 10). A Activity envolve `/forge-next`. |
| **I-11** | `continue-as-new` **MUST** acontecer na fronteira de slice, antes que o histórico se aproxime do teto (§4.5). |
| **I-12** | Resultado grande (diff, summary) **MUST** trafegar por *claim check*: a Activity devolve **caminho**, nunca conteúdo. O `.gsd/` já é esse armazenamento. |

### 1.4 Plano de controle

| # | Invariante |
|---|---|
| **I-13** | **Um agente decide o que um programa não consegue calcular.** Roteamento por taxa de acerto medida é aritmética. Nível de paralelismo é divisão. `effort`, política de retry e detecção de drift são regra. Nenhum destes pode virar agente — seria reintroduzir não-determinismo no plano de controle, que é I-01 uma camada acima. |
| **I-14** | Especialistas **MUST** ser dirigidos por evento, nunca por polling. Com saída a 99% do custo (§4.2), agente que roda "de tempos em tempos" é gasto recorrente sem gatilho. |
| **I-15** | Agentes **MUST NOT** ter canal de conversa direto entre si. Comunicação por artefato (quadro-negro), sequenciamento por código. Conversa agente↔agente é não-limitada, composta em custo e sem trilha de quem decidiu o quê. |

### 1.5 Segurança de auto-melhoria

| # | Invariante |
|---|---|
| **I-16** | Catálogo de modelo (fato estruturado, Models API) pode ser atualizado automaticamente — **sob PR de bot com diff**, nunca push direto. |
| **I-17** | Prosa normativa da internet (release notes, guias) **MUST NOT** ser aplicada automaticamente a prompt, roteamento ou configuração. Gera **item de triagem**, nunca patch. Um agente que lê prosa externa e reescreve os próprios prompts é superfície de prompt injection com raio ilimitado, e o efeito é invisível até degradar o resultado. |
| **I-18** | Mudança comportamental (prompt, `effort`, roteamento, padrão de orquestração) **MUST** entrar apenas com ganho medido pela eval. Sem eval, não entra. |

### 1.6 Medição

| # | Invariante |
|---|---|
| **I-19** | A eval **MUST** existir antes de qualquer afirmação de que o v2 é melhor. Sem instrumento de medida, a premissa do projeto é infalsificável. |
| **I-20** | Toda saída que declara ter comparado algo **MUST** reportar censo do que comparou. Zero comparações **é** resultado inconclusivo, nunca resultado limpo. |

> **I-20 não é teoria.** É a regra que a milestone `workspace-root-forge` pagou três
> rodadas para aprender (um `grep` que honrava `.gitignore` e não varria nada; o
> scanner que o substituiu, cego à própria palavra-alvo; o padrão alargado, ainda
> evadível). Um verificador que relata a própria inatividade como boa notícia é
> indistinguível, byte a byte, de um verificador quebrado.

---

## 2. Arquitetura-alvo

### 2.1 Mapeamento GSD → execução durável

A hierarquia do GSD já é uma árvore de workflows; nunca teve motor.

| Conceito GSD | Primitiva | Por quê |
|---|---|---|
| Milestone | **Workflow** | Vive horas ou dias, sobrevive a reinício, tem histórico próprio |
| Slice | **Child workflow** | Isolamento de falha e retomada independentes |
| Task / unidade | **Child workflow** ou passo | Depende de querer histórico por task |
| Despacho de worker (chamada de LLM) | **Activity** | Não-determinístico por definição — journalizado, nunca re-executado no replay |
| Comando git, spawn de sandbox, poll de uso | **Activity** | Efeito colateral externo |
| Gate (`AskUserQuestion`, plan gate, triagem) | **Signal** (ou `interrupt()`) | O workflow dorme sem consumir nada até a resposta |
| Pause | **Signal** | Deixa de ser arquivo-sinal com polling |
| Handoff de conta por esgotamento | **Signal** + retry de Activity | O workflow nem percebe que trocou de conta |
| Statusline / app / dashboard | **Query** | Lê estado sem tocar na execução |
| Orçamento de tokens da milestone | Estado do workflow | Determinístico, versionado no histórico |
| `events.jsonl` | **Event History** | Deixa de ser log paralelo escrito à mão |

### 2.2 As três camadas do plano de controle

| Camada | O que é | Instâncias |
|---|---|---|
| **Sensores** | Determinísticos, baratos, sempre ligados | `must_haves`, verifier (3 níveis), lint, teste, file audit, métricas do Event History |
| **Controlador** | **Código.** Regras e limiares sobre os sensores | *acerto em `haiku` < 60% neste tipo de unidade → sobe tier* · *RAM livre < X → reduz paralelismo* · *objeções abertas > N → escala ao operador* |
| **Especialistas** | **Agentes.** Só onde há julgamento | challenger, advocate, plan-checker, curador de playbook, triador de mudança externa |

### 2.3 Comunicação

Três canais distintos. Confundi-los é o defeito atual.

| Canal | Protocolo-alvo | Estado hoje |
|---|---|---|
| Agente ↔ ferramenta/ambiente | **MCP** | parcial |
| Orquestrador ↔ agente | **contrato tipado** (structured output) | prosa com marcador — viola I-02 |
| Agente ↔ agente | **nenhum, por decisão** (I-15) | inexistente, simulado por prosa do orquestrador |

Padrão: **quadro-negro** (*blackboard*). O quadro é o `.gsd/`; o barramento é o Event
History. O orquestrador deixa de ser gargalo de comunicação e vira sequenciador.

### 2.4 Roster de agentes — alvo

| Agente | Existe | Julgamento que só ele faz | Evidência de que se paga |
|---|---|---|---|
| challenger × advocate | sim | Uma objeção é real? | **68% de concessão** em 59 objeções (§4.3) |
| plan-checker | sim | O plano é estruturalmente executável? | 15 execuções em 73 unidades |
| **curador de playbook** | **não** | Que lição desta execução sobrevive? | Módulo de reflexão/curadoria do ACE (§5.7) |
| **triador de mudança externa** | **não** | Esta release note nos afeta? | Camada 2 de I-17 — detecta, não aplica |
| **árbitro de conflito** | **não** | Duas slices tocam o mesmo arquivo; qual intenção prevalece? | Só passa a existir com paralelismo. Detecção já pronta (`forge-touch`/`forge-overlap`) |

**Não vira agente** (é conta, por I-13): roteamento, nível de paralelismo, `effort`,
política de retry, detecção de drift, e a faxina determinística (worktrees órfãos,
temporários, branches mortos, entradas obsoletas de registro).

> **Sobre o "cleaner".** O papel se divide e só metade é agente. **Faxineiro** apaga
> por regra → é código dirigido por evento. **Curador** reorganiza por utilidade
> medida → é agente. Apagar para manter curto é *brevity bias* (§5.7), que é a falha
> nomeada pelo ACE — e o cap de 50 do `AUTO-MEMORY` é brevity bias implementado de
> propósito.

---

## 3. Decisões

### 3.1 Fechadas

| # | Decisão | Fundamento |
|---|---|---|
| **D-01** | O Forge vira **motor que executa uma política**; GSD é a primeira política | §5.1; os quatro testes de I-04/I-05 |
| **D-02** | Metodologia GSD **preservada** — milestone → slice → task com gates | Decomposição validada por 1M de linhas de upstream (§5.2) |
| **D-03** | Adotar execução durável; **não escrever** motor | §5.5 — o problema tem solução de indústria há anos |
| **D-04** | Migração por estrangulamento, primeira Activity = Forge de hoje | I-08, I-09 |
| **D-05** | Activity envolve a **unidade** (`/forge-next`), não o loop | I-10; falha nº 10 (§7) |
| **D-06** | Cascata de modelo decidida **por tipo de unidade**, com a variável sendo custo de tentativa falha | §4.4 |
| **D-07** | Nada entra sem eval | I-18, I-19 |

### 3.2 Abertas — com o que fecha cada uma

| # | Questão | O que fecha |
|---|---|---|
| **Q-01** | **Qual motor durável** — Temporal × LangGraph × DBOS | O spike da fase 0. A matriz de §6.2 é preliminar (docs + metadado, não uso); nenhuma linha dela vira decisão sem spike |
| **Q-02** | **Assinatura vs API.** O Agent SDK é empurrado para API key — os docs dizem que a Anthropic não permite a terceiros oferecer login/limites claude.ai, *incluindo* agentes sobre o Agent SDK. O caminho CLI-como-subprocesso é sancionado e preserva assinatura | Medir custo de uma milestone real a preço de API contra a assinatura. `--output-format json` devolve `total_cost_usd` por invocação. **Decide toda a máquina multi-conta** |
| **Q-03** | `--permission-prompt-tool` recebe os gates no caminho do CLI? | Verificação direta. Se sim, a rota do subprocesso tem tudo que o SDK tem **e** continua na assinatura |
| **Q-04** | **Onde fica a fronteira de Activity** — o worker inteiro ou o passo dentro do worker | O spike, pergunta 3 de §6.1. Decide granularidade de retomada e tamanho do Event History |
| **Q-05** | Uma Activity que envolve `claude -p` de 40 min sobrevive ao heartbeat? | Spike. Falha conhecida nº 2 (§7): sem heartbeat o motor reescala e **duplica a chamada de LLM** — custo real, não só erro |
| **Q-06** | O `.gsd/` continua arquivo ou vira banco? | Depende de Q-01. Restrição: o `.gsd/` **MUST** continuar existindo como projeção legível e diffável, senão perde-se o fator 5 |
| **Q-07** | Namespace do runtime | Se o Forge vira runtime com política plugável, `.gsd/` deixa de ser "o diretório do Forge" e vira "o storage da política GSD". Custo de migração real; **dói muito mais se descoberto na fase 3** |
| **Q-08** | Formato `.gsd/` do `gsd-pi` é compatível com o nosso? | Leitura direta. Decide se há caminho de migração ou só de reescrita |
| **Q-09** | `handoff` no `gsd-pi` (75 arquivos) é handoff de conta ou o "agent-human maintainability handoff"? | Leitura direta |

---

## 4. Constantes medidas

**Usar estes números.** Todos foram medidos; nenhum é estimativa.

### 4.1 Baseline do Forge **[código]**

De `.gsd/forge/events.jsonl`, 73 dispatches em 5 dias (29/07 → 03/08/2026):

```yaml
baseline:
  dispatches: 73
  dias: 5
  por_modelo:
    - {modelo: sonnet-5,  n: 42, input: 46221, output: 1182959, custo_usd: 17.88, pct: 54}
    - {modelo: opus-5,    n: 15, input: 20732, output:  521778, custo_usd: 13.15, pct: 39}
    - {modelo: haiku-4-5, n: 12, input:  8883, output:  418974, custo_usd:  2.10, pct:  6}
    - {modelo: fable-5,   n:  4, input:  3036, output:    4840, custo_usd:  0.27, pct:  1}
  total: {n: 73, input: 78872, output: 2128551, custo_usd: 33.41}
  projecao_mensal_usd: 200      # ~165 com o promocional do sonnet-5 ($2/$10 até 31/08)
  toques_humanos: 7             # 4 plan-gate + 2 review-triage + 1 uat-finding
  frontmatter_override: 10      # de 73 dispatches
  plan_checker_execucoes: 15    # de 73 unidades
```

### 4.2 A razão que decide a estratégia

| | |
|---|---|
| Razão saída : entrada | **27 : 1** |
| Participação da saída no custo | **99%** |
| Saída por dispatch — haiku | 34.900 |
| Saída por dispatch — opus | 34.800 |
| Saída por dispatch — sonnet | 28.200 |

**Duas consequências de desenho:**

1. **Toda disciplina de cache otimiza a entrada, que são 1%.** Continua tecnicamente
   correta e é **economicamente marginal para este perfil**. Prioridade é saída.
2. **O volume de saída é praticamente independente do modelo.** Quem determina o
   tamanho da saída é a task. Isso torna rotear para modelo mais barato um ganho
   quase puro, quando a qualidade aguenta.

### 4.3 Vazão **[código]**

Sinais por unidade, mesmo log:

```yaml
sinais_por_unidade:
  verify: 1.40
  review: 0.29
  plan_check: 0.21
  review-fix: 0.05
  plan-gate: 0.05
  orchestrator_reverification: 0.04
  review-triage: 0.03

reviews:
  total: 21
  objecoes: 59
  concedidas: 40        # 68%
  refutadas: 10
  abertas: 4
```

**Leitura:** o review dialético paga — 68% de concessão significa defeito real, não
ruído. E **o humano não é o gargalo**: 7 interrupções em 73 unidades, uma a cada dez.
Há folga grande para paralelizar antes de o operador virar a restrição. **O gargalo é
a serialização**, que hoje existe porque serializar é o único controle de recurso que
o Forge tem.

### 4.4 Cascata — ponto de equilíbrio

| tentativa | custo típico |
|---|---:|
| `haiku` (35k out × $5/M) | **$0,175** |
| `sonnet-5` (28k out × $15/M) | $0,42 |
| `opus-5` (35k out × $25/M) | $0,875 |

```yaml
cascata:
  break_even_acerto_modelo_barato: 0.60   # abaixo disso a cascata custa MAIS
  economia_a_70pct: 0.29
  economia_a_80pct: 0.38
  scorer: deterministico                   # must_haves, verifier 3 níveis, lint, teste, file audit
  requer_treino: false
```

O Forge pode fazer cascata **sem treinar nada** — o obstáculo do paper original é o
scorer (eles treinam um DistilBERT para *prever* correção); o Forge **verifica**.

**A tensão registrada:** cascata são duas passadas sequenciais — economiza dólar,
gasta relógio. Regra de reconciliação, por tipo de unidade:

| Se a unidade… | Estratégia |
|---|---|
| é curta, barata de verificar e **não bloqueia nada** | **cascata** — falhar é barato |
| é longa ou **bloqueia outras no DAG** | **modelo forte de primeira** — custo de falhar é o relógio dela mais tudo que ela segura |

### 4.5 Constantes de cache e de motor

```yaml
cache:
  mecanica: prefix-match          # ordem de render: tools → system → messages
  leitura: 0.1x
  escrita_5min: 1.25x
  escrita_1h: 2.0x
  break_even_requisicoes: {ttl_5min: 2, ttl_1h: 3}
  max_breakpoints: 4
  lookback_blocos: 20             # breakpoint anda no máx. 20 content blocks p/ trás
  minimo_cacheavel_tokens:        # NÃO é monotônico
    opus-5: 512
    fable-5: 512
    mythos-5: 512
    opus-4-8: 1024
    sonnet-5: 1024
    sonnet-4-6: 1024
    sonnet-4-5: 1024
    opus-4-1: 1024
    opus-4-7: 2048
    haiku-3-5: 2048
    opus-4-6: 4096
    opus-4-5: 4096
    haiku-4-5: 4096
  invalidado_por: [model_switch]  # troca de modelo invalida tools + system + messages

motor_durable:                    # [2ª mão] — CONFIRMAR antes de virar restrição
  teto_eventos_por_workflow: 51200
  degradacao_iteracoes: [500, 600]
  payload_max_mb: 2
  transacao_max_mb: 4
```

**Armadilhas de cache que valem desenho:**

- **O mínimo se aplica ao prefixo** (`tools → system → messages`), **não** à mensagem
  do usuário. System prompt + definições de tool do Claude Code sozinhos passam de
  4.096 tokens, então o prefixo é cacheável mesmo com prompt de worker curto.
- **O risco real é a não-monotonicidade:** um breakpoint dimensionado para Opus 5
  (512) pode silenciosamente não cachear num worker roteado para Haiku 4.5 (4.096).
  **Medir por tier**, não deduzir. O sintoma é `cache_creation_input_tokens: 0`, sem erro.
- **Lookback de 20 blocos** erra em silêncio num `execute-task` com muitos pares
  `tool_use`/`tool_result`. Mitigação: breakpoint intermediário a cada ~15 blocos.
- **Paralelismo ingênuo paga N×.** A entrada só fica legível depois que a primeira
  resposta **começa a streamar**. Padrão: dispara 1, espera o **primeiro token**, aí
  dispara as N−1. **Pré-requisito do escalonador, não otimização.**

### 4.6 Alavancas por chamada

| Alavanca | + rápido | + barato | Observação |
|---|:--:|:--:|---|
| **`effort` mais baixo** | ✅ | ✅ | Com thinking adaptativo, **pensamento é token de saída**. O guia do Opus 5 manda varrer para baixo: *"low e medium são excepcionalmente fortes neste modelo"* |
| **Programmatic tool calling** | ✅ | ✅ | Resultado da tool volta **para o código, não para o contexto**. *"O custo escala com a saída final, não com os resultados intermediários"* |
| **Roteamento p/ modelo menor** | ✅ | ✅ | Ganho quase puro, dado §4.2 |
| **Instrução de concisão** | ✅ | ✅ | Grátis. O guia do Opus 5 reporta **−20%** de comprimento de resposta |
| **Task budget** | ~ | ✅ | O modelo vê um contador e se ritma em vez de ser cortado |
| **Batch API** | ❌ assíncrono | ✅ **−50%** | Candidatos no log: **102 `verify`, 13 `symbol_check`** |
| **Fast mode** | ✅ **2,5× tok/s** | ❌ **2× o preço** | Alavanca de latência, não de custo |
| `count_tokens` | — | — | Usar em vez de estimar. `tiktoken` é da OpenAI e **subconta Claude em 15–20%**, muito mais em código |
| Mensagens `role: "system"` no meio do array | — | — | Instrução de operador **sem invalidar o prefixo cacheado**. Hoje em Opus 5 / 4.8 / Fable 5, sem beta header. É também o canal não-falsificável |
| Pre-warm com `max_tokens: 0` | — | — | Escreve o cache sem gerar saída |
| Prompt caching | ~ | **marginal aqui** | Otimiza 1% do custo (§4.2) |

### 4.7 Alavancas de vazão, ranqueadas

1. **Paralelismo** — única multiplicativa, e há folga de humano para usá-la (§4.3)
2. **Acertar de primeira** — as 40 concessões são o alvo; efeito **composto**, porque
   cada retrabalho evitado também evita a verificação dele (1,40 por unidade)
3. **Gate que não bloqueia a fila** — com gate durável, pergunta pendente para de
   segurar as outras unidades
4. **Agrupar as interrupções do operador** — 7 já é pouco; juntá-las numa janela vale
   mais que reduzi-las a 5

---

## 5. Levantamento — o que adotar, o que imitar, o que recusar

### 5.1 Diagnóstico de partida: 12-Factor Agents **[docs-1ª]**

**Oito fortes, dois parciais, duas falhas.** As duas falhas são exatamente as que não
têm conserto por prompt melhor.

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
| **4 · Tools são structured output** | **falha** → I-02 |
| **8 · Own your control flow** | **falha** → I-01 |

**Sintomas do fator 8, todos documentados no `CLAUDE.md` atual** — fluxo de controle
expresso como persuasão:

- `AUTONOMY RULE — CRITICAL` existe porque o modelo pausa para pedir confirmação
- `Compaction Resilience Protocol` — reler estado do disco quando a memória do
  programa é uma janela de contexto
- *"proibido executar inline quando `Agent()` falha"* — regra nascida de o modelo ter
  **improvisado** em vez de falhar. Num programa é um `catch`
- `tier_models` documentado como funcionando por uma milestone inteira **sem
  funcionar** — `Agent()` só aceita quatro aliases, nunca um ID
- `thinking_header` injetado como *texto no cabeçalho do prompt*, com guard contra
  HTTP 400

### 5.2 Upstream — `open-gsd/gsd-pi` **[código]**

O `gsd-build/gsd-2` citado no `CLAUDE.md` **está arquivado**. Upstream vivo:
[`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi) — npm `@opengsd/gsd-pi`,
v1.12.0, 1.001★, TypeScript, MIT.

**Escala medida:** 5.423 arquivos, **~1.027.000 linhas de TypeScript**, **14
packages**, **46 ADRs**, série de 26 documentos `docs/dev/building-coding-agents/`.

Packages: `cloud-mcp-gateway`, `contracts`, `daemon`, `db`, `gsd-agent-core`,
`gsd-agent-modes`, `gsd-cloud`, `mcp-server`, `native`, `pi-agent-core`, `pi-ai`,
`pi-coding-agent`, `pi-tui`, `rpc-client`.

Providers: `ollama`, `anthropic`, `openai`, `google`, `groq`, `xai`, `mistral`,
`openrouter`, **`claude-code`**, **`cursor-agent`**.

**ADRs que respondem perguntas que estávamos fazendo [docs-1ª]:**

- **ADR-046 · database-authoritative workflow lifecycle** — estado autoritativo é
  banco; `.gsd/` é projeção
- **ADR-004 · capability-aware model routing** — pontua modelos em **7 dimensões**.
  O `tier` do Forge é unidimensional
- **ADR-005 · multi-model, multi-provider and tool strategy** — três ideias ausentes
  no Forge: *"hard constraints filter; soft scores rank"* (suporte a tool é binário e
  **filtra** antes de pontuar) · o conjunto de tools **se adapta** na troca de modelo
  (`adjustToolSet`) · **`ProviderSwitchReport`** contabiliza a *perda de fidelidade*
  numa troca cross-provider (thinking descartado, IDs remapeados) e emite como evento
  de auditoria em vez de degradar em silêncio
- **ADR-008 · GSD workflow tools sobre MCP para paridade de provider** (implementado,
  6 fases) — os mesmos **11 executores transport-neutral** alcançáveis nativamente
  **e** por MCP, com `packages/mcp-server/src/workflow-tools-parity.test.ts` provando
  **as mesmas escritas no banco, os mesmos artefatos e as mesmas transições de
  estado**. Claude Code entra como provider pelo Agent SDK com `mcpServers` anexado
  (`stream-adapter.ts:1318`). **É a rota CLI-como-subprocesso já construída e com
  teste de paridade** — relevante para Q-02/Q-03
- Outros: ADR-001 (branchless worktree), ADR-002 (external state dir), ADR-009
  (orchestration kernel refactor), ADR-011 (progressive planning escalation),
  ADR-022/023 (post-unit gate + hook outcome artifacts), ADR-026 (per-phase thinking
  level), ADR-030 (two-altitude state machine), ADR-033 (unit-type registry),
  ADR-044 (per-repository git isolation)

**Forge × gsd-pi — o que é de quem** [código, via grep no fonte deles]:

| Conceito | Arquivos no `gsd-pi` | Leitura |
|---|---:|---|
| `challenger` | **0** | **só do Forge** |
| `advocate` | **0** | **só do Forge** |
| `dialectic` | **0** | **só do Forge** |
| `setup-token` | **0** | **só do Forge** |
| `must_have` | 9 | convergente |
| `verifier` | 5 | convergente |
| `cooldown` | 8 | convergente |
| `handoff` | 75 | convergente? — sentido não verificado (Q-09) |
| `evidence` | 404 | eles vão mais longe |
| `worktree` | 521 | eles vão mais longe |
| `slice` | 1.345 | eles vão mais longe |
| `milestone` | 1.385 | eles vão mais longe |

**Review dialético** e **rotação multi-conta de assinatura** são genuinamente do
Forge. A ausência do segundo lá faz sentido: eles resolvem escassez trocando de
**provider**, não de **conta do mesmo provider**.

### 5.3 Candidatos a motor

| Projeto | Escala | O que tem |
|---|---|---|
| [`anomalyco/opencode`](https://github.com/anomalyco/opencode) **[código]** | 192.901★, MIT, TS/bun, 6.358 arquivos, **26 packages** | `server` (com **`pty-environment.ts`**), `protocol`, `client`, `sdk`, `sdk-next`, `plugin` (extensão em `tool.ts`, `tui.ts`, `shell.ts`), `core`, `llm`, `desktop`, `console`, `cli`, `enterprise`, `containers`, `identity`, `codemode`. Providers: anthropic (452), openai (414), deepseek (151), google (94), openrouter (87), gemini (84), xai (59), mistral (57), lmstudio (41), ollama (36), azure (35), groq (26). **Referência mais forte para "servidor + SDK + plugin"** |
| [`aaif-goose/goose`](https://github.com/aaif-goose/goose) **[código]** | 52.178★, Apache-2.0, Rust, 2.309 arquivos, 12 crates | `goose-providers` + `goose-provider-types` (provider isolado, tipos separados), `goose-sdk` + `goose-sdk-types`, **`goose-local-inference`** (inferência local in-process), **`goose-acp-macros`** (ACP). *"desktop app, CLI, and API"*, macOS/Linux/Windows — **descrição literal do requisito local-first + app nativo** |
| [`cline/cline`](https://github.com/cline/cline) **[código]** | 65.571★, Apache-2.0, TS, 3.545 arquivos | `apps/{cli,vscode,cline-hub,examples}` + `sdk/` com `ARCHITECTURE.md` próprio. Cobertura de nuvem mais ampla: anthropic (620), openrouter (292), deepseek (292), openai (271), ollama (152), gemini (118), **bedrock (101)**, **vertex (98)**, mistral (74), together (37). Mais orientado a IDE |
| [`OpenHands`](https://github.com/OpenHands/OpenHands) **[docs-1ª]** | 83.017★ + [`software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk) 956★ | Arquitetura **event stream**: toda interação agente↔ambiente vira evento tipado num hub central, com **`AgentController` que supervisiona e impõe restrições operacionais** enquanto o `CodeActAgent` decide. Sandbox nativo, ciclo de vida, roteamento multi-LLM, análise de segurança |

> **[arXiv 2511.03690](https://arxiv.org/abs/2511.03690)** — o OpenHands reporta que a
> V1 **reduziu substancialmente as falhas atribuíveis ao sistema** frente à V0, com
> overhead de event sourcing desprezível. **É a única migração desse tipo com número
> publicado**, e a única evidência empírica externa de que este desenho compensa.

### 5.4 Peças que resolvem um problema nosso

| Projeto | | Resolve |
|---|---|---|
| [`gsd-build/context-packet`](https://github.com/gsd-build/context-packet) **[docs-1ª]** | 50★ TS | **Recuperação por orçamento.** `resolve(node, {maxTokens})` sobre um DAG, wrapping anti-injection, `input_hash` SHA-256 para skip idempotente. Mata o `last 30 rows de DECISIONS.md`. Zero dependências, três primitivas |
| [`gsd-build/daemon`](https://github.com/gsd-build/daemon) **[docs-1ª]** | 8★ Go | **Local + rede.** Websocket persistente com relay, gerencia sessões locais do Claude Code, streama cross-device, **write-ahead log** em `~/.gsd-cloud/` |
| [`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad) **[meta]** | 8.230★ Go | **Multiplexação de agentes de terminal** — Claude Code, Codex, OpenCode, Amp. É o trabalho da tela de terminal do app do Forge, já feito. **Ler antes de investir mais ali** |
| [`BerriAI/litellm`](https://github.com/BerriAI/litellm) **[meta]** | 55.455★ | **Gateway multi-provider como processo** — 100+ APIs, fallback, budget, rate limit e logging em config, self-hosted |
| [`patoles/agent-flow`](https://github.com/patoles/agent-flow) **[meta]** | 1.440★ TS | **Observabilidade** — visualização ao vivo da orquestração; a árvore slice → task → worker desenhada |
| [`SWE-agent/SWE-agent`](https://github.com/SWE-agent/SWE-agent) **[2ª mão]** | 19.991★ Py | **Agent-Computer Interface** — desenhar as tools *para o modelo*, não para o humano |
| [`redevops-io/sidekick`](https://github.com/redevops-io/sidekick) **[meta]** | 9★ Py | Forma do escalonador: DAG de sub-sessões auto-aprovadas, isoladas por worktree |

### 5.5 Execução durável — o achado que muda a arquitetura **[docs-1ª]**

Nenhum motor acima resolve isto, e é o que o Forge faz à mão sem saber o nome. O
`continue.md`, o arquivo `pause`, o `auto-mode.json` e o **Compaction Resilience
Protocol** inteiro são uma reimplementação em prosa de **execução durável**.

| | | Por que importa |
|---|---|---|
| [`temporalio/temporal`](https://github.com/temporalio/temporal) | **22.074★** Go | Padrão de fato. Workflow determinístico + histórico event-sourced + **replay** |
| [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) | **38.792★** Py | Nativo de LLM: grafo + **checkpointing** + **interrupt/resume** — a mecânica exata dos gates do Forge |
| [`inngest/inngest`](https://github.com/inngest/inngest) | 5.685★ Go | *"stateful step functions"* |
| [`restatedev/restate`](https://github.com/restatedev/restate) | 4.243★ Rust | *"resilient applications that tolerate all failures"* |
| [`dbos-inc/dbos-transact-py`](https://github.com/dbos-inc/dbos-transact-py) | 1.513★ Py | **Workflows duráveis respaldados por banco** — o mais leve; casa com o ADR-046 |
| [`pgflow-dev/pgflow`](https://github.com/pgflow-dev/pgflow) | 301★ TS | Motor centrado em Postgres — pequeno o bastante para ler inteiro |

**O risco de determinismo está resolvido [docs-1ª].** Documentação do Temporal:

> Código de workflow deve ser estritamente determinístico. Operações
> não-determinísticas — **chamadas de API externa, consultas a banco, invocações de
> LLM/IA**, aleatoriedade e tempo — **devem ser delegadas a Activities**. Durante o
> replay, **Activities não são re-executadas**: seus resultados gravados são lidos do
> Event History.

Ou seja: o padrão que o Forge precisa **é o padrão canônico da ferramenta**, e
invocação de LLM está nomeada explicitamente. Consequência de custo que fecha o
argumento: **uma run que morre não re-paga as unidades já concluídas** — hoje um
`/forge-auto` interrompido refaz contexto e reprocessa.

**Os dois modelos não são o mesmo [docs-1ª]:**

| | **Temporal** (replay) | **LangGraph** (checkpoint) |
|---|---|---|
| Retomada | Re-executa o código do workflow comparando Commands contra o Event History; Activities voltam do histórico | Restaura o **snapshot** do `thread_id` e continua |
| Trilha de auditoria | **Histórico completo de toda decisão**, por construção | Snapshot do estado, não o caminho |
| Gate humano | Signal | **`interrupt()`** — pausa no checkpoint, retoma com o mesmo `thread_id`, inclusive **através de reinício de processo** |
| Custo operacional | Serviço (servidor Go + banco) | Biblioteca |
| Linguagem | SDKs em várias | Python-first |

### 5.6 Sandbox, evals, memória, protocolos **[meta — nenhum código lido]**

**Sandbox.** O único isolamento do Forge é worktree do git, que isola **arquivos**,
não **execução**. Um worker pode `rm -rf`, sair para a rede ou esgotar a memória.

| | | |
|---|---|---|
| [`daytonaio/daytona`](https://github.com/daytonaio/daytona) | **72.059★** | *"Secure and Elastic Infrastructure for Running AI-Generated Code"* |
| [`firecracker-microvm/firecracker`](https://github.com/firecracker-microvm/firecracker) | **35.855★** Rust | A primitiva de microVM sobre a qual o AWS Lambda roda |
| [`coder/coder`](https://github.com/coder/coder) | 14.019★ Go | *"Secure environments for developers and their agents"* |
| [`e2b-dev/E2B`](https://github.com/e2b-dev/E2B) | 13.244★ Py | Ambiente seguro com tools reais |
| [`superradcompany/microsandbox`](https://github.com/superradcompany/microsandbox) | 7.122★ Rust | **`local-first microVM runtime and library`** — encaixe exato |

> **Isto reescreve o requisito de consciência de máquina.** "Não cair por memória" tem
> resposta melhor que uma heurística de `cores − 2`: é **limite de sandbox**
> (cgroup / microVM). Não se adivinha a RAM disponível — **capa-se** a de cada worker
> e o kernel impõe.

**Evals** — a lacuna metodológica mais séria; ver I-19.

| | | |
|---|---|---|
| [`harbor-framework/terminal-bench`](https://github.com/harbor-framework/terminal-bench) | 2.518★ Py | *"benchmark for LLMs on complicated tasks in the terminal"* — **o mais próximo do que o Forge faz** |
| [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) | 5.561★ Py | Issues reais de GitHub — a régua da indústria |
| [`langfuse/langfuse`](https://github.com/langfuse/langfuse) | **32.444★** TS | Plataforma aberta de evals e observabilidade |
| [`openai/evals`](https://github.com/openai/evals) | 19.099★ Py | ⚠️ último push abr/2026 — esfriando |

**Memória** — o `AUTO-MEMORY.md` (cap 50, decay, `forge-sweep`) é camada feita à mão.

| | | |
|---|---|---|
| [`mem0ai/mem0`](https://github.com/mem0ai/mem0) | **62.426★** Py | *"Universal memory layer for AI Agents"* |
| [`topoteretes/cognee`](https://github.com/topoteretes/cognee) | 29.737★ Py | Plataforma aberta de memória |
| [`letta-ai/letta`](https://github.com/letta-ai/letta) | 24.072★ Py | Agentes stateful com memória que **se auto-edita** (linhagem MemGPT) |
| [`getzep/zep`](https://github.com/getzep/zep) | 4.806★ Py | |

**Protocolos.**

| | | |
|---|---|---|
| [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) | **89.167★** | Servidores MCP — o Forge já consome |
| [`a2aproject/A2A`](https://github.com/a2aproject/A2A) | **25.170★** | **Agent2Agent** — protocolo de comunicação entre agentes |
| [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol) | 8.847★ | A especificação do MCP |
| [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) | 3.854★ Rust | **ACP** — *"conectar qualquer editor a qualquer agente"*. O `goose` já embarca `goose-acp-macros` |

**Se o Forge falar ACP, qualquer editor compatível o dirige** — e o app deixa de ser a
única superfície possível. **Ressalva sobre A2A:** ele existe para agentes conversarem
entre si; **I-15 recusa isso por decisão**. Fica catalogado, não adotado.

### 5.7 Auto-melhoria — o eixo "ficar mais inteligente"

**Achado central: ACE — Agentic Context Engineering [docs-1ª].**
[arXiv 2510.04618](https://arxiv.org/abs/2510.04618) trata contexto como **playbook
evolutivo** que acumula, refina e organiza estratégias por três módulos — **geração**,
**reflexão** e **curadoria**.

```yaml
ace_reportado:                    # números DO ABSTRACT DOS AUTORES, sem replicação independente
  ganho_tarefas_agente: +0.106
  ganho_dominio_financeiro: +0.086
  reducao_custo_token: -0.836
  reducao_latencia_adaptacao: -0.915
  dados_rotulados_necessarios: 0  # usa feedback natural de execução
  mitigacao: delta-update         # atualização incremental, não reescrita do playbook
```

Duas patologias nomeadas, que valem por si:

- **Brevity bias** — o sistema privilegia concisão e **perde conhecimento específico
  do domínio**
- **Context collapse** — reescrever o contexto repetidamente **erode a informação**

> **Diagnóstico desconfortável:** o `AUTO-MEMORY.md` tem **cap de 50 entradas**,
> confidence decay e `forge-sweep` para **podar**. É **brevity bias implementado de
> propósito**. E o quality gate de três perguntas é curadoria por prosa, não por
> feedback medido.
>
> Pior: **o Forge já tem o feedback natural de execução e joga fora.** Must-haves
> passa/falha, níveis do verifier, objeções do review, lint, teste — nada disso chega
> ao sistema de memória, que lê o *summary*, ou seja, a narração.

| Repositório | | O que resolve |
|---|---|---|
| [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) | **36.600★** Py | *"Programar, não promptar"* — define módulos e **uma métrica**, e o framework **compila** os prompts contra ela |
| [`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) | 6.521★ Py | **Compressão de prompt** (EMNLP'23/ACL'24) |
| [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM) | 5.295★ Py | **Roteador aprendido** — a tabela de tier, porém treinada. ⚠️ push ago/2024 |
| [`MineDojo/Voyager`](https://github.com/MineDojo/Voyager) | 7.109★ | **Biblioteca de skills** — o agente escreve e reutiliza as próprias. ⚠️ push abr/2024 |
| [`noahshinn/reflexion`](https://github.com/noahshinn/reflexion) | 3.221★ Py | **Reflexão verbal** (NeurIPS 2023) |
| [`zou-group/textgrad`](https://github.com/zou-group/textgrad) | 3.684★ Py | Feedback de LLM como gradiente |
| [`zorazrw/agent-workflow-memory`](https://github.com/zorazrw/agent-workflow-memory) | 450★ Py | **AWM** — induz workflows reutilizáveis da experiência passada |

**Como aterrissa:**

| Peça do Forge hoje | O que vira |
|---|---|
| `AUTO-MEMORY.md` com cap 50 + decay + `forge-sweep` | **Playbook com atualização delta** (ACE). Deixa de podar por tamanho; organiza por utilidade medida |
| Quality gate de 3 perguntas em prosa | **Curadoria por feedback de execução** — must-haves, verifier, review, lint, teste |
| `agents/*.md` ajustados à mão | **Módulos compiláveis contra a métrica** da eval (DSPy) |
| Tabela estática `tier_models` | **Roteamento aprendido** do histórico (RouteLLM) |
| `CODING-STANDARDS.md` (Asset Map, Pattern Catalog) | O playbook de domínio — alvo natural do ciclo ACE |
| Contexto injetado por janela | **Compressão** (LLMLingua) + recuperação por orçamento (`context-packet`) |

**A condição de possibilidade é o Event History.** Nada disso funciona sem registro
estruturado e consultável por unidade — modelo, effort, iterações, tokens, se passou
nos must-haves, quantas objeções o review abriu. É o mesmo dado que a eval consome.
**Durabilidade, medição e auto-melhoria são a mesma infraestrutura vista de três
ângulos.**

⚠️ `Voyager`, `RouteLLM` e `Reflexion` são artefatos de pesquisa com push antigo —
valem pela **ideia**, não como dependência.

### 5.8 Manter-se atualizado — a metade externa

O que envelhece e o que quebra quando envelhece:

| O que envelhece | Consequência |
|---|---|
| IDs em `tier_models` | Modelo **aposentado responde 404** — dispatch quebra e ninguém sabe até rodar. **Sonnet 3.7 e Haiku 3.5 foram aposentados em fev/2026** |
| Guards de `thinking`/`effort` por família | Combinação inválida vira **HTTP 400** (`disabled` + `xhigh` no Opus 5; `disabled` explícito no Fable) |
| Mínimos de cache por modelo | **Não são monotônicos** e mudaram entre 4.6 e 5. Um breakpoint dimensionado para um tier deixa de cachear noutro, sem erro |
| Preços por MTok | A medição de custo vira ficção |
| Janela de contexto e teto de saída | Truncamento no meio da resposta |
| Prompts e descrições de tool | *"Prompts são artefatos por modelo; uma linha que sustenta uma geração é entulho na seguinte"* |

**O padrão seguro, validado pelo upstream [código]:** o `gsd-pi` tem
`.github/workflows/update-model-catalog.yml` — refresh **semanal** (terça, 09:17 UTC)
do catálogo gerado — e `gsd update --models` para on-demand. A decisão está no
comentário do arquivo:

> *"Abre um PR de bot com o diff, para que a mudança chegue pelo review + CI normais,
> em vez de um push não-revisado na main."*

**Detectar automaticamente; aplicar sob portão.** É a linha entre auto-aprimoramento e
auto-regressão — formalizada em I-16/I-17/I-18.

### 5.9 Padrões de orquestração **[docs-1ª]**

Publicados pelo time do Claude Code. Dão vocabulário comum ao dispatch **e** validam o
diferencial que §5.2 mediu como só nosso.

**Seis padrões:** *classify-and-act* · *fan-out-and-synthesize* · **adversarial
verification** · *generate-and-filter* · *tournament* · *loop until done*.

> **O review dialético do Forge é o padrão nº 3, nomeado por quem constrói o Claude
> Code.** Aquilo que §5.2 mediu como tendo **zero arquivos** no `gsd-pi` não é
> excentricidade — é padrão de primeira linha que o upstream não implementa.

**Três anti-padrões**, que explicam sintomas já documentados no Forge:

| Anti-padrão | Onde aparece |
|---|---|
| **Agentic laziness** — declarar concluído com progresso parcial | É o que a camada anti-alucinação inteira existe para pegar |
| **Self-preferential bias** — preferir os próprios achados à evidência | É a razão de `challenger: auto` resolver para a família **oposta** à do autor |
| **Goal drift** — perda de fidelidade por sumarização sucessiva | É o que a memória com quality gate tenta conter |

Freio deles, que vale como regra: *"para tarefas de código normais, pergunte-se: isso
precisa mesmo de mais compute?"*

### 5.10 O que compor, de quem

**Adotar como dependência:**

| De | Levar | Fase |
|---|---|---|
| Execução durável (§5.5) | O motor: passos duráveis, replay, Signal/`interrupt`. **Adotar, não escrever** | **0** |
| Evals (§5.6) | `terminal-bench` como régua; `langfuse` para observabilidade | **0** |
| Sandbox (§5.6) | Limite por worker (CPU, RAM, rede) | 4 |
| `context-packet` (§5.4) | `resolve(node, {maxTokens})` — orçamento, anti-injection, `input_hash` | 4 |
| `LiteLLM` | Gateway multi-provider como **processo**, não biblioteca | 3 |
| Memória (§5.6) | Substituir o `AUTO-MEMORY.md` — `letta` pela memória auto-editável | 4+ |
| ACP (§5.6) | Falar protocolo em vez de inventar um | 4+ |

**Imitar como padrão (desenho nosso):**

| De | Padrão |
|---|---|
| **`gsd-pi`** | Banco como autoridade (ADR-046) · roteamento multi-dimensional (ADR-004) · `hard constraints filter, soft scores rank` + `adjustToolSet` + `ProviderSwitchReport` (ADR-005) · paridade nativo×MCP **com teste de paridade** (ADR-008) · o hábito de ADR — 46 decisões versionadas em vez de um `CLAUDE.md` de 15k tokens |
| **`opencode`** | Split **servidor + protocolo tipado + cliente + SDK** · **sistema de plugin** com extensão em `tool` e `tui` (é onde review dialético e multi-conta viram plugin, não fork) · PTY no servidor |
| **`goose`** | **Provider como crate isolada com tipos próprios** · SDK separado dos tipos · **ACP** em vez de protocolo caseiro · três superfícies sobre um núcleo · `local-inference` |
| **`OpenHands SDK`** | **Event stream tipado** + `AgentController` que impõe restrições enquanto o agente decide |
| **`SWE-agent`** | Agent-Computer Interface — tools desenhadas para o modelo |
| **Docs Anthropic** | Tudo de §4 — o único item que nenhum concorrente tem |

**Gateways e cache semântico [meta]:**

| | | |
|---|---|---|
| [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway) | 12.636★ TS | Gateway com guardrails, roteia para 1.600+ LLMs |
| [`Helicone/helicone`](https://github.com/Helicone/helicone) | 6.032★ TS | Observabilidade com uma linha — custo por unidade sem instrumentar à mão |
| [`zilliztech/GPTCache`](https://github.com/zilliztech/GPTCache) | 8.120★ Py | **Cache semântico** — acerta por *significado*. ⚠️ push jul/2025; tasks de código raramente se repetem, valor baixo exceto talvez em `verify`/`symbol_check` |
| [`ruvnet/ruflo`](https://github.com/ruvnet/ruflo) | **66.964★** | Ex-`claude-flow`, *"the original agent meta-harness"* — **maior que o OpenHands** |

**Metodologias alternativas** (competem com o GSD, não com o Forge — úteis para roubar
decomposição, e para testar I-04 rodando outra política no mesmo motor):

| | | |
|---|---|---|
| [`github/spec-kit`](https://github.com/github/spec-kit) | **125.191★** Py | Spec-Driven Development da GitHub, **agnóstico de agente** |
| [`bmad-code-org/BMAD-METHOD`](https://github.com/bmad-code-org/BMAD-METHOD) | 51.442★ | Método ágil com papéis de agente |
| [`eyaltoledano/claude-task-master`](https://github.com/eyaltoledano/claude-task-master) | 27.936★ | Camada de task management agnóstica |

**Categoria errada (agentes de IDE) [meta]:** `Aider` (47.913★, origem do
**repo-map**), `continue` (35.305★), `kilocode` (26.695★), `Roo-Code` (24.360★, push
mai/2026 — esfriando). **Não usar como base:** `winfunc/opcode` — 22.348★ mas **último
push out/2025**.

**Teoria:** [12-Factor Agents](https://github.com/humanlayer/12-factor-agents)
(25.060★, **push set/2025** — princípios duráveis, código não mantido: ler, não
depender) · [Code as Agent Harness](https://arxiv.org/html/2605.18747v1) — código como
substrato porque só código é **executável**, **inspecionável** e **stateful**; o
`.gsd/` já dá o terceiro, faltam os dois primeiros ·
[`awesome-harness-engineering`](https://github.com/ai-boost/awesome-harness-engineering) **[2ª mão]**.

---

## 6. Plano de fases e critérios de aceitação

### 6.1 Fase 0 — o spike falseável

**Entrega:** um workflow durável cuja Activity é o `/forge-next` de hoje, rodando uma
milestone real deste repositório — com pause por Signal, gate por Signal e retomada
após matar o processo. **Sem TUI, sem app, sem executor plugável, sem tocar na lógica
do Forge atual.**

| # | Critério de aceitação | Falseável por |
|---|---|---|
| **A-01** | Matar o processo no meio de uma unidade e retomar devolve o milestone ao passo exato, **sem `continue.md`** | `kill -9` no meio de uma unidade; conferir posição retomada |
| **A-02** | A retomada **não re-paga** as unidades concluídas | Comparar `total_cost_usd` acumulado antes e depois do kill |
| **A-03** | O gate chega e pode ser respondido **fora** da TUI do Claude Code, por Signal | Enviar Signal de processo externo; workflow avança |
| **A-04** | Uma Activity que envolve `claude -p` de 40 min sobrevive ao heartbeat sem duplicar a chamada | Rodar unidade longa; contar invocações de LLM no log |
| **A-05** | **A régua existe** — uma task do `terminal-bench` roda pelo caminho novo *e* pelo Forge atual, mesmo modelo | Se A-05 não for montado primeiro, A-01..A-04 não têm como ser defendidos depois |

**Se A-04 falhar**, o recorte de Activity muda (a unidade vira o *passo* dentro do
worker, não o worker inteiro) — **isso é desenho, não bloqueio**, e responde Q-04.

**Medição obrigatória junto:** custo de uma milestone real a preço de API contra a
assinatura (Q-02). Sem esse número, a escolha entre executor de assinatura e de API é
convicção, não orçamento.

### 6.2 Fases seguintes

| Fase | Entrega | Aceitação | Grandeza |
|---|---|---|---|
| **1 — kernel** | Loop durável para milestone inteiro; `/forge-next` por Activity; `continue-as-new` na fronteira de slice (I-11); *claim check* via `.gsd/` (I-12) | Milestone longo não estoura o histórico; resultado grande não termina o workflow | semanas |
| **2 — plano de controle** | Gates viram Signal (o `defer` no headless deixa de ser necessário); eval montada; registro estruturado por unidade; roteamento medido | Uma decisão de roteamento é rastreável a uma taxa de acerto medida, não a uma tabela escrita à mão | semanas |
| **3 — composição** | Activity de despacho ganha executor plugável; entra provider não-Claude | `ProviderSwitchReport`-equivalente emite perda de fidelidade em vez de degradar em silêncio | semanas |
| **4 — isolamento** | Sandbox por worker; recuperação por orçamento (`context-packet`) | Um worker não consegue esgotar a memória da máquina; contexto entra por orçamento, não por janela | semanas |

**Cada fase é reversível e mensurável isoladamente pela eval.** Em nenhum momento
existe um "Forge v2" que precisa estar pronto para o v1 ser desligado.

### 6.3 Matriz de decisão de motor — **preliminar, não decidir sem spike**

| Eixo | Temporal | LangGraph | DBOS |
|---|---|---|---|
| Trilha de auditoria por construção | **sim** | não (snapshot) | parcial |
| Gate que dorme por dias | sim (Signal) | sim (`interrupt()`) | sim |
| Custo de operação | **alto** (serviço + banco) | baixo (biblioteca) | médio (Postgres) |
| Encaixe com "banco é autoridade" (ADR-046) | indireto | indireto | **direto** |
| Nativo de LLM | não | **sim** | não |
| Maturidade / adoção | **22.074★**, padrão de indústria | 38.792★, LLM-nativo | 1.513★ |
| Amarra a stack | Go + SDK | Python | Python + Postgres |

**São componíveis.** O padrão publicado executa *"uma execução de LangGraph dentro de
uma única Activity longa do Temporal"* — **mas isso colide com I-10**. A composição só
é segura quando o que roda dentro da Activity é **uma unidade curta**, não o loop.

**Leitura preliminar:** o Forge quer a *trilha* do Temporal com o *custo operacional*
do DBOS.

### 6.4 Débito de instrumentação — precede a fase 0

`events.jsonl` **não registra duração por unidade**. Sem carimbo de início/fim, o
ganho de paralelismo da fase 3 é **inafirmável** — não há linha de base. Acrescentar o
carimbo é mudança aditiva de baixo custo e deve vir antes.

---

## 7. Falhas conhecidas a projetar contra **[2ª mão — confirmar]**

Catálogo público de onze falhas de produção de agentes sobre Temporal. **Três delas
mudam o desenho**, e descobri-las depois de construir custaria a milestone.

| # | Falha | Consequência | Mitigação |
|---|---|---|---|
| **10** | **SDK de agente inteiro dentro de uma Activity** — *"falha na iteração 47 recomeça da 1"* | Derruba a fase 0 se a Activity envolver o loop | **I-10** — Activity envolve a unidade |
| **3** | **Loop sem limite de iteração** — degradação em ~500–600 iterações, teto de **51.200 eventos** | Milestone longo estoura | **I-11** — `continue-as-new` na fronteira de slice, que é onde o GSD já corta |
| **9** | **Payload acima do limite** — 2MB por payload, 4MB por transação; saída grande **termina o workflow sem retry** | Resultado com diff + summary pode passar | **I-12** — *claim check*; a Activity devolve caminho |
| **2** | **Activity longa sem heartbeat** — o motor assume worker morto e **reescala**, gerando **chamada de LLM duplicada** | Custo direto: um `execute-task` de 40 min pagando duas vezes | `RecordHeartbeat()` + `HeartbeatTimeout` calibrado. É o A-04 |
| **6** | **Gate humano sem timeout** — espera indefinida se a notificação falha | Triagem de review e plan gate travam para sempre | Timer + escalação + handler idempotente |
| **7** | **Versionamento quebra o replay** | O Forge itera no próprio loop o tempo todo | **Boa notícia: mudança de prompt é segura** (vive na Activity). Mudança de fluxo exige guard de versão |
| **5** | **`ParentClosePolicy` default é ABANDON** | Cancelar um milestone deixaria as slices rodando | Precisa ser explícito |
| **4** | **Retry ingênuo em 429** | Tempestade de retry ou perda de durabilidade | O Forge já tem taxonomia de falha; acrescentar respeito a `Retry-After` |
| **8** | **Observabilidade** — *"Activity X deu timeout"* não diz o que o agente fazia | Debug impossível | Search Attributes com tipo de unidade, iteração, última tool, modelo, tokens — é o que a statusline e o app querem consultar |

**Nenhuma é motivo para não adotar execução durável** — todas têm mitigação conhecida.

---

## 8. O que NÃO construir

Escopo fora. Construir qualquer item aqui é desvio, não iniciativa.

| # | Não construir | Porque |
|---|---|---|
| **N-01** | Motor de execução durável próprio | I-06 — existe solução de indústria há anos |
| **N-02** | Escalonador consciente de máquina por heurística (`cores − 2`) | Virou limite de sandbox (§5.6). Não se adivinha RAM; capa-se |
| **N-03** | Transporte de provider, PTY, TUI, protocolo de interop | Commodity. Reescrever custa tempo sem comprar identidade |
| **N-04** | Canal de conversa agente↔agente | I-15 |
| **N-05** | Agente para roteamento, paralelismo, `effort`, retry, drift | I-13 — é conta |
| **N-06** | Agente "cleaner" que apaga para manter curto | Brevity bias (§5.7). A faxina é código; a curadoria é outro papel |
| **N-07** | Fila de integração, merge groups, ordenação de runs, merge especulativo | Produto inteiro, recusado por decisão na S07. O que existe é o **sinal**, não a fila |
| **N-08** | Aplicação automática de prosa normativa externa a prompts | I-17 — prompt injection com raio ilimitado |
| **N-09** | Copiar arquitetura alheia em bloco | O Forge lidera nos fatores 5 e 10; adotar em bloco jogaria isso fora |
| **N-10** | Herdar roteamento por capacidade sem precificar o cache | §4.5 — troca de modelo invalida tudo. Quanto mais "inteligente" o roteamento, mais cache queimado |

> **Sobre N-09 e a tensão com "banco como autoridade":** §5.10 manda levar o ADR-046,
> o que parece contradizer "proteger o fator 5" — já que hoje o fator 5 do Forge **é**
> o `.gsd/` em arquivos. Não contradiz. O fator 5 pede que estado de execução e de
> negócio sejam **a mesma coisa, auditável**: essa é a **propriedade**; markdown é o
> **meio**. Um banco preserva a propriedade e melhora a auditoria — **desde que o
> `.gsd/` continue existindo como projeção legível e diffável**. Perder isso, sim,
> seria perder o fator 5.

---

## 9. Graus de evidência

| Marca | Significa |
|---|---|
| **[código]** | Código/estrutura do repositório clonado foi lido |
| **[docs-1ª]** | Documentação de primeira mão (docs oficiais, ADRs do próprio projeto) |
| **[meta]** | Metadado verificado via API do GitHub (estrelas, linguagem, push, licença) |
| **[2ª mão]** | Lido em levantamento de terceiro — **não confirmado** |

**Estrelas medem atenção, não qualidade:** o `opcode` tem 22 mil e está morto desde
out/2025. Último push importa mais.

### 9.1 O que esta pesquisa NÃO verificou

- **Paralelismo real, consciência de memória e qualidade de recuperação** em qualquer
  projeto — exige **rodar e medir**, não ler
- Arquitetura em profundidade de `cline` e do `OpenHands SDK` — estrutura e paper,
  não código
- Tudo marcado **[2ª mão]**
- Se as decisões dos ADRs do `gsd-pi` estão **implementadas** como declaram —
  confirmado só o ADR-008, que traz tabela de status por fase e teste de paridade
- **§5.6 inteira segue [meta]** — existência, linguagem, licença, atividade e
  descrição oficial; **nenhum código lido**. Escolher entre `microsandbox` e
  `firecracker`, ou entre `mem0` e `letta`, exige leitura que esta sessão não fez
- **§5.5 é [docs-1ª]** e o risco de determinismo está resolvido — mas contra a
  documentação do Temporal, **não contra código rodando**. O spike é quem confirma
- **Timeout e heartbeat de Activity longa** — nenhum documento lido cobre o caso
  "subprocesso de CLI que streama por 40 minutos"
- **Custo operacional real de rodar um motor** — para um sistema que hoje é `npx` +
  arquivos, isso é mudança de natureza do produto que nenhuma leitura de doc mede
- **A matriz de §6.3 é preliminar** — documentação e metadado, não uso
- **§7 é [2ª mão]** — os números (51.200 eventos, 2MB/4MB, ~500–600 iterações)
  **precisam ser confirmados na documentação oficial** antes de virarem restrição
- **Os números do ACE (§5.7)** são do abstract dos autores, sem replicação independente
- **§5.9 é [docs-1ª]** mas é *guidance*, não garantia: descreve como o time do Claude
  Code orquestra, não um contrato de API

### 9.2 A ressalva que sustenta o documento

**Nada disto foi medido, porque nada foi construído.** É argumento de por que o
desenho é crível, não relato de resultado. A única evidência empírica externa é o
OpenHands (§5.3). A frase honesta é **"o v2 remove causas conhecidas de falha do
v1"**, não "o v2 é melhor".

---

## 10. Índice de referências

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

**Execução durável** (§5.5)
- [`temporalio/temporal`](https://github.com/temporalio/temporal) · [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) · [`inngest/inngest`](https://github.com/inngest/inngest) · [`restatedev/restate`](https://github.com/restatedev/restate) · [`dbos-inc/dbos-transact-py`](https://github.com/dbos-inc/dbos-transact-py) · [`pgflow-dev/pgflow`](https://github.com/pgflow-dev/pgflow)

**Sandbox** (§5.6)
- [`daytonaio/daytona`](https://github.com/daytonaio/daytona) · [`firecracker-microvm/firecracker`](https://github.com/firecracker-microvm/firecracker) · [`coder/coder`](https://github.com/coder/coder) · [`e2b-dev/E2B`](https://github.com/e2b-dev/E2B) · [`superradcompany/microsandbox`](https://github.com/superradcompany/microsandbox)

**Evals e observabilidade** (§5.6)
- [`harbor-framework/terminal-bench`](https://github.com/harbor-framework/terminal-bench) · [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) · [`langfuse/langfuse`](https://github.com/langfuse/langfuse) · [`openai/evals`](https://github.com/openai/evals)

**Memória** (§5.6)
- [`mem0ai/mem0`](https://github.com/mem0ai/mem0) · [`topoteretes/cognee`](https://github.com/topoteretes/cognee) · [`letta-ai/letta`](https://github.com/letta-ai/letta) · [`getzep/zep`](https://github.com/getzep/zep)

**Protocolos** (§5.6)
- [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) · [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol) · [`a2aproject/A2A`](https://github.com/a2aproject/A2A) · [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol)

**Orquestração e falhas de produção** (§5.9, §7)
- [A harness for every task: dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) — os seis padrões e os três anti-padrões, de primeira mão
- [Temporal AI Agent Failures: 11 Production Pitfalls](https://www.xgrid.co/resources/temporal-ai-agent-orchestration-failure-patterns/) — o catálogo de §7
- [AI Applications & Agents With Temporal](https://temporal.io/solutions/ai) · [Durable Execution meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai) · [Of course you can build dynamic AI agents with Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal)

**Auto-melhoria e eficiência de contexto** (§5.7)
- [Agentic Context Engineering — arXiv 2510.04618](https://arxiv.org/abs/2510.04618) — playbook evolutivo, delta updates, −83,6% de token
- [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) · [`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) · [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM) · [`MineDojo/Voyager`](https://github.com/MineDojo/Voyager) · [`noahshinn/reflexion`](https://github.com/noahshinn/reflexion) · [`zou-group/textgrad`](https://github.com/zou-group/textgrad) · [`zorazrw/agent-workflow-memory`](https://github.com/zorazrw/agent-workflow-memory)

**Custo por chamada e cascata** (§4)
- [FrugalGPT — arXiv 2305.05176](https://ar5iv.labs.arxiv.org/html/2305.05176) · [Is Escalation Worth It? — arXiv 2605.06350](https://arxiv.org/pdf/2605.06350)
- [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway) · [`Helicone/helicone`](https://github.com/Helicone/helicone) · [`zilliztech/GPTCache`](https://github.com/zilliztech/GPTCache) · [`ruvnet/ruflo`](https://github.com/ruvnet/ruflo)

**Teoria**
- [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) · [OpenHands Software Agent SDK (arXiv 2511.03690)](https://arxiv.org/abs/2511.03690) · [Code as Agent Harness (arXiv 2605.18747)](https://arxiv.org/html/2605.18747v1) · [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)

**Documentação de primeira mão da Anthropic** (base de §4)
- Prompt caching · token counting · Agent SDK overview · headless / `claude -p`

---

*Clones usados na pesquisa: `/tmp/{gsd-pi,opencode,goose,cline}` — efêmeros, reclone
com `--depth 1` se precisar reabrir.*
