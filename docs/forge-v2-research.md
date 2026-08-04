---
title: Forge v2 — levantamento, comparação e decisões de partida
status: levantamento + caminho de migração proposto (§6.7) e primeira slice (§7) — alimenta o CONTEXT de um milestone; as escolhas de §6.6 seguem sem decisão
date: 2026-08-03
revisao: 2026-08-04 — §3.7 elevada a [docs-1ª]; §6.4–6.7 acrescentadas; 1ª revisão adversarial: contagem em §2, afirmação errada em §4.2, identidade obsoleta em §5, requisito 3 órfão. 2ª revisão: §6.2 separada em dependência × padrão, tensão fator-5 em §6.3, §6.5 corrigida. Rodada de melhorias: §6.8 (padrões de primeira mão) e §6.9 (11 falhas de produção) acrescentadas; Fase 0 de §6.7 corrigida pela falha nº 10; §3.12 (auto-melhoria) e §3.13 (manter-se atualizado) acrescentadas; requisito 11 criado em §1; §4.6–4.11 (baseline medido, alavancas por chamada, cascata, gateways, vazão, plano de controle) acrescentadas
autor: sessão de pesquisa Claude Opus 5 + Matheus
escopo: o que existe lá fora, o que o Forge já tem, e o que sobra para construir
---

# Forge v2 — levantamento

Este documento existe para que a milestone do Forge v2 nasça de **evidência**, não
de convicção. Tudo aqui foi levantado numa sessão de pesquisa; o valor está tanto
nas conclusões quanto na marcação do que foi **verificado** contra o que foi
**lido de segunda mão** — porque a segunda categoria é onde uma decisão de
arquitetura erra sem avisar.

## Como ler as marcações

| Marca | Significa |
|---|---|
| **[código]** | Li o código/estrutura do repositório clonado |
| **[docs-1ª]** | Documentação de primeira mão (docs oficiais, ADRs do próprio projeto) |
| **[meta]** | Metadado verificado via API do GitHub (estrelas, linguagem, push, licença) |
| **[2ª mão]** | Li em levantamento de terceiro — **não confirmado** |

Estrelas medem atenção, não qualidade: o `opcode` tem 22 mil e está morto desde
out/2025. Último push importa mais.

---

## 0. O que o Forge v2 é — leia antes do levantamento

### 0.1 A frase

> **O v1 pede ao modelo que se comporte como um programa. O v2 é um programa que
> chama o modelo.**

Tudo neste documento é consequência dessa troca.

### 0.2 Ainda é GSD?

Três coisas estavam coladas e precisam ser separadas:

1. **GSD como metodologia** — milestone → slice → task, discuss/plan/execute/complete,
   gates. É uma **especificação**.
2. **GSD como implementação** — o `gsd-pi`, 1M de linhas. É um **produto**.
3. **Forge** — hoje, uma terceira implementação da (1) em markdown sobre o Claude
   Code, mais três coisas que ninguém tem.

**A metodologia continua sendo GSD, e isso é força.** Ela é decomposição validada
(§3.1). Reinventá-la seria o desperdício.

**O que muda é o que o Forge é:** deixa de ser *uma implementação do GSD* e passa a
ser **um motor que executa uma política — sendo GSD a primeira política**. Como o
Temporal é runtime e o seu workflow é a política; como o Kubernetes é runtime e o
seu Deployment é a política.

**Os quatro testes que provam que a separação é real** (se algum falhar, foi só
renomear):

- a política é versionável separadamente do motor
- dá para rodar **outra** política no mesmo motor (o `spec-kit`, por exemplo)
- dá para testar o motor **sem** a política
- dá para testar a política **sem modelo nenhum** ← hoje impossível; é o fator 8

> ⚠️ **Consequência de produto ainda não decidida:** se o Forge vira runtime com
> política plugável, `.gsd/` deixa de ser *"o diretório do Forge"* e passa a ser
> *"o storage da política GSD"*. O runtime precisa de namespace próprio. Custo de
> migração real, e dói muito mais se descoberto na fase 3.

### 0.3 Não é reconstruir do zero

O preço de tabela do "zero" está medido: **1M de linhas** no `gsd-pi`,
**26 packages** no `opencode`. A §6.1 registra que **duas das três coisas** que
pareciam "o Forge escreve" encolheram para infraestrutura adotável quando a
pesquisa avançou.

> **A roda não é refeita. O que é novo é o eixo** — o loop que segura tudo, e que
> hoje não existe como código em lugar nenhum do Forge. Roda, pneu, freio e câmbio
> são comprados.

"Novo" segue verdadeiro no que importa: **autoria das decisões e da composição.**
Nenhum dos quatro projetos junta política GSD + disciplina de custo + revisão
adversarial + multi-conta + portão medido.

### 0.4 Os quatro mecanismos, em "hoje / no v2 / custa"

**Consumo de máquina.** *Hoje:* não existe limite nenhum — o `forge-isolation`
isola **arquivos**, não recursos. Por isso tudo roda em série: **serializar é o
único controle de recurso que o Forge tem**. *No v2:* cada worker num sandbox com
limite declarado, imposto pelo kernel — o teto vira aritmética (*cada worker custa
≤2 GB, a máquina tem 16, cabem 6*) em vez de adivinhação, e estourar vira falha
normal de Activity com retry. *Custa:* integrar sandbox (§3.8).

**Versão online.** *Hoje:* fecha o notebook, tudo morre. *No v2:* o loop é programa
com estado durável — roda num daemon, local ou servidor, sem humano acoplado; gate
é Signal e estado é Query, então qualquer cliente autenticado pergunta *"onde
está?"* e responde *"pode seguir"*. *Custa:* operar um motor. **"Online" não é
feature nova — é o que sobra quando o loop deixa de precisar de um terminal aberto.**

**Ficar mais inteligente.** *Hoje:* **não fica, porque não mede nada** — a memória
extrai lições em prosa e não há sinal quantitativo. *No v2:* cada unidade vira
registro estruturado (modelo, effort, iterações, tokens, must-haves, objeções), e aí
roteamento, effort e contexto passam a ser **medidos** (§3.12). *Custa:* montar a
eval, que é o setpoint (§4.11).

**Múltiplos LLMs.** *Hoje:* não é multi-LLM, é **multi-CLI** — shell-out para
`codex`/`agy`, só no challenger do review, sem modelo de capacidade. *No v2:*
interface de executor com implementações independentes (§6.2.a). *Custa:* **cache é
model-scoped** — cada troca invalida o prefixo (§4.1). O v2 não elimina esse custo;
torna-o visível e decidível.

### 0.5 O que **não** melhora

O modelo é o mesmo. Uma unidade que gasta 29 mil tokens de saída continua gastando.
O v2 não deixa o Claude melhor por chamada — **as alavancas por chamada são de v1**
(§4.7) e podem ser aplicadas esta semana. O que o v2 acrescenta é **saber qual delas
funcionou**.

### 0.6 A ressalva que sustenta o documento

**Nada disto foi medido, porque nada foi construído.** É argumento de por que o
desenho é crível, não relato de resultado. A única evidência empírica de que essa
migração compensa é de terceiro: o OpenHands publicou redução substancial de falhas
atribuíveis ao sistema entre V0 e V1 fazendo exatamente essa mudança (§3.2). A frase
honesta é ***"o v2 remove causas conhecidas de falha do v1"***, não *"o v2 é melhor"*.

---

## 1. O critério — o que "melhor" quer dizer aqui

Sem isto a comparação vira gosto. Onze requisitos, extraídos das decisões tomadas
na discussão que originou este documento:

1. **Fluxo de controle em código**, com saída estruturada (12-factor, fatores 8 e 4)
2. **Executor plugável** multi-LLM, **preservando a assinatura Claude**
3. **Paralelismo real** com escalonador determinístico
4. **Consciência de máquina** (RAM/cores) — não cair por memória
5. **Local-first com superfície de rede** (servidor, aprovação remota)
6. **Recuperação por orçamento de token**, não injeção por janela
7. **Eficiência de token** — cache-aware
8. **Metodologia GSD preservada** (milestone → slice → task, com gates)
9. Espaço para o que é **só do Forge** (review dialético, multi-conta, anti-alucinação)
10. **App nativo**
11. **Absorver mudança** — do próprio uso (§3.12) e do que muda por fora (§3.13),
    sempre sob portão medido

> O requisito 11 foi acrescentado em 2026-08-04. Os dez primeiros descrevem o que o
> Forge **faz**; este descreve como ele **deixa de envelhecer** — e nenhum dos
> quatro motores levantados o trata como requisito de primeira classe.

---

## 2. Diagnóstico do Forge atual

O Forge foi pontuado contra os [12-Factor Agents](https://github.com/humanlayer/12-factor-agents)
**[docs-1ª]**. Resultado: **oito fortes, dois parciais, duas falhas** — e as duas
falhas são exatamente as que não têm conserto por prompt melhor.

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
| 1 · Natural language → tool calls | parcial — o dispatch é `Agent()`, mas o **retorno** volta como prosa (ver fator 4) |
| 11 · Trigger from anywhere | parcial — CLI, app e cron via `forge-run`, mas tudo desemboca numa sessão `claude` |
| **4 · Tools são structured output** | **falha** |
| **8 · Own your control flow** | **falha** |

**Fator 4** é o `---GSD-WORKER-RESULT---`: dado estruturado contrabandeado dentro
de prosa, porque prosa era o único canal.

**Fator 8** é o loop em markdown. Todas as cicatrizes documentadas no `CLAUDE.md`
são sintomas de um único defeito — **fluxo de controle expresso como persuasão**:

- `AUTONOMY RULE — CRITICAL` existe porque o modelo pausa para pedir confirmação
- `Compaction Resilience Protocol` — reler estado do disco quando a memória do
  programa é uma janela de contexto
- `"proibido executar inline quando Agent() falha"` — regra nascida de o modelo
  ter **improvisado** em vez de falhar. Num programa é um `catch`
- `tier_models` documentado como funcionando por uma milestone inteira **sem
  funcionar** — `Agent()` só aceita quatro aliases, nunca um ID
- `thinking_header` injetado como *texto no cabeçalho do prompt*, com guard
  contra HTTP 400

---

## 3. O levantamento

### 3.1 O upstream — `open-gsd/gsd-pi` **[código]**

O `gsd-build/gsd-2` que o `CLAUDE.md` cita **está arquivado**. O upstream vivo é
[`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi) — npm `@opengsd/gsd-pi`,
v1.12.0, 1.001★, TypeScript, MIT.

**Escala medida:** 5.423 arquivos, **~1.027.000 linhas de TypeScript**,
**14 packages**, **46 ADRs**, e uma série de 26 documentos
`docs/dev/building-coding-agents/`.

Packages: `cloud-mcp-gateway`, `contracts`, `daemon`, `db`, `gsd-agent-core`,
`gsd-agent-modes`, `gsd-cloud`, `mcp-server`, `native`, `pi-agent-core`, `pi-ai`,
`pi-coding-agent`, `pi-tui`, `rpc-client`.

**Providers:** `ollama` (local), `anthropic`, `openai`, `google`, `groq`, `xai`,
`mistral`, `openrouter`, **`claude-code`**, **`cursor-agent`**.

#### ADRs que respondem perguntas que estávamos fazendo **[docs-1ª]**

- **ADR-046 · database-authoritative workflow lifecycle** — o estado autoritativo
  é banco; `.gsd/` é projeção. O Forge ainda tem markdown como fonte.
- **ADR-004 · capability-aware model routing** — pontua modelos em **7 dimensões
  de capacidade**. O `tier` do Forge é unidimensional.
- **ADR-005 · multi-model, multi-provider and tool strategy** — três ideias que o
  Forge não tem:
  - *"hard constraints filter; soft scores rank"* — suporte a tool é binário e
    **filtra** o conjunto elegível antes de qualquer pontuação
  - o **conjunto de tools se adapta** quando o roteador troca de modelo
    (`adjustToolSet`)
  - **`ProviderSwitchReport`** — contabiliza a *perda de fidelidade* numa troca
    cross-provider (blocos de thinking descartados, IDs de tool remapeados) e a
    emite como evento de auditoria, em vez de degradar em silêncio
- **ADR-008 · GSD workflow tools sobre MCP para paridade de provider**
  (implementado, 6 fases) — os mesmos **11 executores transport-neutral**
  alcançáveis nativamente **e** por MCP, com
  `packages/mcp-server/src/workflow-tools-parity.test.ts` provando que a chamada
  via MCP produz **as mesmas escritas no banco, os mesmos artefatos e as mesmas
  transições de estado**. E o Claude Code entra como provider pelo Agent SDK da
  Anthropic com `mcpServers` anexado (`stream-adapter.ts:1318`).
  **Isto é a "rota 3" (CLI como subprocesso preservando assinatura) já construída
  e com teste de paridade.**
- Outros relevantes: ADR-001 (branchless worktree), ADR-002 (external state dir),
  ADR-009 (orchestration kernel refactor), ADR-011 (progressive planning
  escalation), ADR-022/023 (post-unit gate + hook outcome artifacts),
  ADR-026 (per-phase thinking level), ADR-030 (two-altitude state machine),
  ADR-033 (unit-type registry), ADR-044 (per-repository git isolation).

#### Forge × gsd-pi — o que é de quem **[código, via grep no fonte deles]**

| Conceito | Arquivos no `gsd-pi` | Leitura |
|---|---:|---|
| `challenger` | **0** | **só do Forge** |
| `advocate` | **0** | **só do Forge** |
| `dialectic` | **0** | **só do Forge** |
| `setup-token` | **0** | **só do Forge** |
| `must_have` | 9 | convergente |
| `verifier` | 5 | convergente |
| `cooldown` | 8 | convergente |
| `handoff` | 75 | convergente? — sentido não verificado, ver §8.5 |
| `evidence` | 404 | eles vão mais longe |
| `worktree` | 521 | eles vão mais longe |
| `slice` | 1.345 | eles vão mais longe |
| `milestone` | 1.385 | eles vão mais longe |

**Conclusão:** o **review dialético** e a **rotação multi-conta de assinatura** são
genuinamente do Forge. A ausência do segundo lá faz sentido: eles resolvem escassez
trocando de **provider**, não de **conta do mesmo provider**.

### 3.2 Candidatos a motor

#### `anomalyco/opencode` — 192.901★, MIT, TypeScript/bun **[código]**

6.358 arquivos, **26 packages**. Os que importam:

- **`server`** — `api.ts`, `auth.ts`, `routes.ts`, `handlers/`, `middleware/`, e
  **`pty-environment.ts`** (PTY gerido no servidor)
- **`protocol`**, **`client`**, **`sdk`**, **`sdk-next`** — cliente/servidor com
  contrato tipado
- **`plugin`** — pontos de extensão em `tool.ts`, `tui.ts`, `shell.ts`, mais `v2/`
- `core`, `llm`, `desktop`, `console`, `cli`, `enterprise`, `containers`,
  `identity`, `codemode`

Providers **[código]**: anthropic (452 ocorrências), openai (414), deepseek (151),
google (94), openrouter (87), gemini (84), xai (59), mistral (57), lmstudio (41),
ollama (36), azure (35), groq (26).

**É a referência mais forte para "servidor + SDK + plugin".** Local e servidor
viram a mesma coisa com endereços diferentes, e extensão não exige fork.

#### `aaif-goose/goose` — 52.178★, Apache-2.0, Rust **[código]**

2.309 arquivos, 12 crates com fronteiras limpas:

- **`goose-providers` + `goose-provider-types`** — abstração de provider isolada
  em crate própria, com tipos separados
- **`goose-sdk` + `goose-sdk-types`** — núcleo embutível, tipos separados
- **`goose-local-inference`** — inferência local *in-process* (além de ollama)
- **`goose-acp-macros`** — Agent Client Protocol, interop padronizada
- `goose`, `goose-cli`, `goose-mcp`, `goose-download-manager`, `goose-test`

*"native open source AI agent — **desktop app, CLI, and API**"*, macOS/Linux/Windows,
com badge de saúde da Linux Foundation. **É a descrição literal do requisito 5+10.**

#### `cline/cline` — 65.571★, Apache-2.0, TypeScript **[código]**

3.545 arquivos. `apps/{cli,vscode,cline-hub,examples}` + **`sdk/` com
`ARCHITECTURE.md` próprio**. Providers com a cobertura mais ampla de nuvem:
anthropic (620), openrouter (292), deepseek (292), openai (271), ollama (152),
gemini (118), **bedrock (101)**, **vertex (98)**, mistral (74), together (37).

Mais orientado a IDE que os dois acima, mas o SDK é real.

#### `OpenHands` — 83.017★ + `software-agent-sdk` 956★ (Python) **[docs-1ª]**

Arquitetura **event stream**: toda interação agente↔ambiente vira evento tipado num
hub central, com um **`AgentController` que supervisiona e impõe restrições
operacionais** enquanto o `CodeActAgent` decide. Integra execução sandboxed nativa,
controle de ciclo de vida, roteamento multi-LLM e análise de segurança.

Paper: [arXiv 2511.03690](https://arxiv.org/abs/2511.03690) — reporta que a V1
**reduziu substancialmente as falhas atribuíveis ao sistema** frente à V0, com
overhead de event sourcing desprezível. É a única migração desse tipo com número
publicado.

### 3.3 Peças isoladas que resolvem um problema nosso

| Projeto | | Resolve |
|---|---|---|
| [`gsd-build/context-packet`](https://github.com/gsd-build/context-packet) **[docs-1ª]** | 50★ TS | **Recuperação por orçamento.** `resolve(node, {maxTokens})` sobre um DAG, com wrapping anti-injection e `input_hash` SHA-256 para skip idempotente. Mata o `last 30 rows de DECISIONS.md`. Zero dependências, três primitivas. |
| [`gsd-build/daemon`](https://github.com/gsd-build/daemon) **[docs-1ª]** | 8★ Go | **Local + rede.** Websocket persistente com relay, gerencia sessões locais do Claude Code, streama saída cross-device, **write-ahead log** em `~/.gsd-cloud/`. Documenta explicitamente a fronteira de diagnóstico remoto. |
| [`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad) **[meta]** | 8.230★ Go | **Multiplexação de agentes de terminal** — Claude Code, Codex, OpenCode e Amp. É o trabalho da tela de terminal do app do Forge, já feito. **Ler antes de investir mais ali.** |
| [`BerriAI/litellm`](https://github.com/BerriAI/litellm) **[meta]** | 55.455★ | **Gateway multi-provider como processo** — 100+ APIs, fallback, budget, rate limit e logging em config, self-hosted. Núcleo Rust com SDK Python. |
| [`patoles/agent-flow`](https://github.com/patoles/agent-flow) **[meta]** | 1.440★ TS | **Observabilidade** — visualização em tempo real da orquestração do Claude Code. A árvore slice → task → worker desenhada ao vivo. |
| [`SWE-agent/SWE-agent`](https://github.com/SWE-agent/SWE-agent) **[2ª mão]** | 19.991★ Py | **Agent-Computer Interface** — desenhar as tools *para o modelo*, não para o humano. |
| [`redevops-io/sidekick`](https://github.com/redevops-io/sidekick) **[meta]** | 9★ Py | Forma do escalonador: *DAG de sub-sessões auto-aprovadas, isoladas por git worktree*. |

### 3.4 Alternativas ao GSD (metodologia, não motor) **[meta]**

Competem com o **GSD**, não com o Forge. Úteis para roubar decomposição.

| | | |
|---|---|---|
| [`github/spec-kit`](https://github.com/github/spec-kit) | **125.191★** Py | Spec-Driven Development da GitHub, **agnóstico de agente** — rodaria sobre qualquer motor |
| [`bmad-code-org/BMAD-METHOD`](https://github.com/bmad-code-org/BMAD-METHOD) | 51.442★ | Método ágil com papéis de agente |
| [`eyaltoledano/claude-task-master`](https://github.com/eyaltoledano/claude-task-master) | 27.936★ | Camada de task management agnóstica |

### 3.5 Agentes de IDE — categoria errada para o Forge **[meta]**

`Aider` (47.913★, e a origem do **repo-map**), `continue` (35.305★),
`kilocode` (26.695★), `Roo-Code` (24.360★, último push mai/2026 — esfriando).

**Não usar como base:** `winfunc/opcode` — 22.348★ mas **último push out/2025**.

### 3.6 Princípios e teoria

- [`humanlayer/12-factor-agents`](https://github.com/humanlayer/12-factor-agents)
  **[docs-1ª]** — 25.060★, mas **último push set/2025**. Princípios duráveis,
  código não mantido. Ler, não depender.
- [Code as Agent Harness](https://arxiv.org/html/2605.18747v1) **[docs-1ª]** —
  código como substrato operacional do agente porque só código é **executável**
  (resultado verificável), **inspecionável** (traço estruturado) e **stateful**
  (o programa evoluindo *é* o progresso). O `.gsd/` já dá o terceiro; faltam os dois primeiros.
- [`ai-boost/awesome-harness-engineering`](https://github.com/ai-boost/awesome-harness-engineering)
  **[2ª mão]** — lista curada para minerar.

### 3.7 Execução durável — o achado que muda a §6 **[docs-1ª]**

Nenhum dos motores acima resolve isto, e é o que o Forge está fazendo à mão sem
saber o nome. O `continue.md`, o arquivo `pause`, o `auto-mode.json` e o
**Compaction Resilience Protocol** inteiro são uma reimplementação em prosa de
**execução durável**: um fluxo que sobrevive à morte do processo e retoma no passo
exato. Esse problema tem solução de indústria, rigorosa, há anos.

| | | Por que importa aqui |
|---|---|---|
| [`temporalio/temporal`](https://github.com/temporalio/temporal) | **22.074★** Go | O padrão de fato. Código de workflow determinístico + histórico event-sourced + **replay**. Workers morrem; o workflow não. |
| [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) | **38.792★** Py | O nativo de LLM: fluxo como grafo + **checkpointing** + **interrupt/resume** — que é exatamente a mecânica dos gates do Forge. |
| [`inngest/inngest`](https://github.com/inngest/inngest) | 5.685★ Go | *"stateful step functions"* — orquestração com passos duráveis. |
| [`restatedev/restate`](https://github.com/restatedev/restate) | 4.243★ Rust | *"resilient applications that tolerate all failures"*. |
| [`dbos-inc/dbos-transact-py`](https://github.com/dbos-inc/dbos-transact-py) | 1.513★ Py | **Workflows duráveis respaldados por banco** — o mais leve, e casa com o ADR-046 do gsd-pi. |
| [`pgflow-dev/pgflow`](https://github.com/pgflow-dev/pgflow) | 301★ TS | Motor de workflow centrado em Postgres — pequeno o bastante para ler inteiro. |

**A consequência é grande:** com estado de workflow event-sourced, *"o contexto foi
compactado"* deixa de ser um perigo — porque o estado do loop **nunca esteve no
contexto**. O Compaction Resilience Protocol não precisa ser melhorado; precisa
deixar de ser necessário. O mesmo vale para retomada por conta, pause e handoff.

#### O risco de determinismo — **resolvido** **[docs-1ª]**

A versão anterior deste documento listava como incógnita capaz de derrubar toda a
§6: *"determinismo de replay com efeito colateral de LLM é exatamente onde essas
ferramentas exigem desenho cuidadoso."* Fui à documentação do Temporal. A resposta
é limpa e favorável:

> Código de workflow deve ser estritamente determinístico. Operações
> não-determinísticas — **chamadas de API externa, consultas a banco, invocações de
> LLM/IA**, aleatoriedade e tempo — **devem ser delegadas a Activities**. Durante o
> replay, **Activities não são re-executadas**: seus resultados gravados são lidos
> do Event History.

Ou seja: **o padrão que o Forge precisa é o padrão canônico da ferramenta**, e
invocação de LLM está nomeada explicitamente na lista. O loop de dispatch é
workflow determinístico; cada despacho de worker é uma Activity cujo *resultado* é
journalizado. Replay lê o diário — **nunca re-chama o modelo**.

Isso tem uma consequência de custo que ninguém tinha notado: **uma run que morre
não re-paga as unidades já concluídas.** Hoje, um `/forge-auto` interrompido no
meio de uma milestone refaz contexto e reprocessa; com history, as unidades
concluídas voltam do diário a custo zero de token.

#### Os dois modelos não são o mesmo **[docs-1ª]**

| | **Temporal** (replay) | **LangGraph** (checkpoint) |
|---|---|---|
| Retomada | Re-executa o código do workflow, comparando Commands contra o Event History; Activities voltam do histórico | Restaura o **snapshot** de estado do `thread_id` e continua dali |
| Trilha de auditoria | **Histórico completo de toda decisão**, por construção | Snapshot do estado, não o caminho até ele |
| Gate humano | Signal | **`interrupt()`** — pausa no checkpoint e retoma reinvocando com o mesmo `thread_id`, inclusive **através de reinício de processo** |
| Custo operacional | Serviço (servidor Go + banco) | Biblioteca |
| Linguagem | SDKs em várias | Python-first |

Para o Forge a distinção pesa: o `events.jsonl`, o evidence log e o route audit
**já querem ser um Event History**. O modelo de replay é um superconjunto estrito
do que eles tentam fazer à mão.

### 3.8 Sandbox e isolamento de execução — categoria ausente **[meta]**

O Forge roda agentes que escrevem e **executam** código, e seu único isolamento é
worktree do git — que isola **arquivos**, não **execução**. Um worker pode `rm -rf`,
sair para a rede ou esgotar a memória da máquina.

| | | |
|---|---|---|
| [`daytonaio/daytona`](https://github.com/daytonaio/daytona) | **72.059★** | *"Secure and Elastic Infrastructure for Running AI-Generated Code"* |
| [`firecracker-microvm/firecracker`](https://github.com/firecracker-microvm/firecracker) | **35.855★** Rust | A primitiva de microVM sobre a qual o AWS Lambda roda |
| [`coder/coder`](https://github.com/coder/coder) | 14.019★ Go | *"Secure environments for developers and their agents"* |
| [`e2b-dev/E2B`](https://github.com/e2b-dev/E2B) | 13.244★ Py | Ambiente seguro com tools reais para agentes |
| [`superradcompany/microsandbox`](https://github.com/superradcompany/microsandbox) | 7.122★ Rust | **`local-first microVM runtime and library`** — o encaixe exato do requisito 5 |

**Isto reescreve o requisito 4.** "Não cair por memória" tem resposta melhor do que
uma heurística de `cores − 2`: é **limite de sandbox** (cgroup / microVM). Você não
adivinha a RAM disponível — você **capa** a de cada worker e deixa o kernel impor.
O `microsandbox`, sendo local-first *e* biblioteca, é o candidato natural.

### 3.9 Evals — sem isto, "o v2 é melhor" é infalsificável **[meta]**

É a lacuna metodológica mais séria deste levantamento. Todo o plano assume que o
v2 supera o v1 e **não há como saber**. Um documento cuja premissa é
falsificabilidade não pode omitir o instrumento de medida.

| | | |
|---|---|---|
| [`harbor-framework/terminal-bench`](https://github.com/harbor-framework/terminal-bench) | 2.518★ Py | *"benchmark for LLMs on complicated tasks in the terminal"* — **o mais próximo do que o Forge faz** |
| [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) | 5.561★ Py | Resolver issues reais de GitHub — a régua da indústria |
| [`langfuse/langfuse`](https://github.com/langfuse/langfuse) | **32.444★** TS | Plataforma aberta de evals, observabilidade e métricas de LLM |
| [`openai/evals`](https://github.com/openai/evals) | 19.099★ Py | Framework de avaliação (último push abr/2026 — esfriando) |

O paper do OpenHands SDK é o precedente: eles **mediram** a redução de falhas
atribuíveis ao sistema entre V0 e V1. Sem um número equivalente, o Forge v2 é
convicção.

### 3.10 Memória de longo prazo **[meta]**

O `AUTO-MEMORY.md` do Forge — cap de 50, confidence com decay, `forge-sweep` para
podar — é uma camada de memória feita à mão. Estas são as de verdade:

| | | |
|---|---|---|
| [`mem0ai/mem0`](https://github.com/mem0ai/mem0) | **62.426★** Py | *"Universal memory layer for AI Agents"* |
| [`topoteretes/cognee`](https://github.com/topoteretes/cognee) | 29.737★ Py | Plataforma aberta de memória para agentes |
| [`letta-ai/letta`](https://github.com/letta-ai/letta) | 24.072★ Py | Agentes *stateful* com memória que **se auto-edita** (linhagem MemGPT) |
| [`getzep/zep`](https://github.com/getzep/zep) | 4.806★ Py | |

### 3.11 Protocolos de interop **[meta]**

| | | |
|---|---|---|
| [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) | **89.167★** | Servidores MCP — o Forge já consome |
| [`a2aproject/A2A`](https://github.com/a2aproject/A2A) | **25.170★** | **Agent2Agent** — protocolo aberto de comunicação *entre agentes* |
| [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol) | 8.847★ | A especificação do MCP |
| [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) | 3.854★ Rust | **ACP** — *"conectar qualquer editor a qualquer agente"*. O `goose` já embarca `goose-acp-macros` |

**Se o Forge falar ACP, qualquer editor compatível o dirige** — e o app deixa de
ser a única superfície possível. A2A é a peça para os agentes conversarem entre si
em vez de tudo passar pelo orquestrador.

### 3.12 Auto-melhoria e eficiência de contexto — como o agente fica melhor com o uso

Este é o eixo do requisito *"ficar mais inteligente"*, e é o único onde o Forge já
tem a **forma** certa e o **método** errado.

#### O achado central: ACE — Agentic Context Engineering **[docs-1ª]**

[arXiv 2510.04618](https://arxiv.org/abs/2510.04618) trata contexto como **playbook
evolutivo** que acumula, refina e organiza estratégias por três módulos —
**geração**, **reflexão** e **curadoria**. Os números que os autores reportam:

| | |
|---|---|
| Ganho em tarefas de agente | **+10,6%** |
| Ganho em domínio financeiro | +8,6% |
| **Redução de custo de token** | **−83,6%** |
| Redução de latência de adaptação | −91,5% |
| Dados rotulados necessários | **nenhum** — usa *feedback natural de execução* |

E nomeia duas patologias que valem por si:

- **Brevity bias** — o sistema privilegia concisão e **perde conhecimento
  específico do domínio**.
- **Context collapse** — reescrever o contexto repetidamente **erode a informação**
  ao longo do tempo.

A mitigação é **atualização incremental estruturada** (*delta*), em vez de reescrever
o playbook inteiro a cada rodada.

> **O diagnóstico desconfortável:** o `AUTO-MEMORY.md` do Forge tem **cap de 50
> entradas**, *confidence decay* e o `forge-sweep` para **podar**. Isso é
> literalmente **brevity bias implementado de propósito** — o Forge poda o próprio
> playbook para mantê-lo curto, que é exatamente a falha que o paper identifica. E
> o quality gate de três perguntas é curadoria feita por prosa, não por feedback
> medido.
>
> Pior: **o Forge já tem o feedback natural de execução e joga fora.** Must-haves
> passa/falha, níveis do verifier, objeções do review, resultado de lint e de teste
> — nada disso chega ao sistema de memória. A memória emergente lê o *summary*, que
> é a narração, não o resultado.

#### Repositórios do eixo **[meta]**

| | | O que resolve |
|---|---|---|
| [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) | **36.600★** Py | *"Programar, não promptar"* — você define módulos e **uma métrica**, e o framework **compila** os prompts contra ela. É a resposta direta a *"melhorar a lógica"*: prompt deixa de ser escrito à mão e passa a ser **otimizado por medição** |
| [`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) | 6.521★ Py | **Compressão de prompt** (EMNLP'23/ACL'24) — acelera inferência e melhora a percepção da informação-chave. Alavanca direta de token |
| [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM) | 5.295★ Py | **Roteador de modelo aprendido** — *"economizar custo sem comprometer qualidade"*. É a tabela de tier do Forge, porém treinada. ⚠️ último push ago/2024 |
| [`MineDojo/Voyager`](https://github.com/MineDojo/Voyager) | 7.109★ | **Biblioteca de skills**: o agente escreve e **reutiliza** as próprias habilidades. ⚠️ artefato de pesquisa, último push abr/2024 — ler pela ideia |
| [`noahshinn/reflexion`](https://github.com/noahshinn/reflexion) | 3.221★ Py | **Reflexão verbal** (NeurIPS 2023): o agente reflete sobre a falha e guarda a reflexão para a próxima tentativa |
| [`zou-group/textgrad`](https://github.com/zou-group/textgrad) | 3.684★ Py | "Diferenciação" textual — feedback de LLM como gradiente para otimizar sistemas |
| [`zorazrw/agent-workflow-memory`](https://github.com/zorazrw/agent-workflow-memory) | 450★ Py | **AWM** — induz *workflows reutilizáveis* a partir da experiência passada |

#### Como isso aterrissa no Forge v2

O encaixe é direto porque as peças já existem — falta o circuito fechado:

| Peça do Forge hoje | O que muda |
|---|---|
| `AUTO-MEMORY.md` com cap 50 + decay + `forge-sweep` | Vira **playbook com atualização delta** (ACE). Deixa de podar por tamanho e passa a organizar por utilidade medida |
| Quality gate de 3 perguntas em prosa | Vira **curadoria por feedback de execução** — must-haves, verifier, review, lint, teste |
| `agents/*.md` escritos e ajustados à mão | Viram **módulos compiláveis contra a métrica** da eval de §3.9 (DSPy) |
| Tabela estática de tier (`tier_models`) | Vira **roteamento aprendido** do histórico (RouteLLM) |
| `CODING-STANDARDS.md` com Asset Map e Pattern Catalog | É o playbook de domínio — o alvo natural do ciclo ACE |
| Contexto injetado por janela | **Compressão** (LLMLingua) + recuperação por orçamento (`context-packet`) |

**A condição de possibilidade é o Event History de §3.7.** Nada disso funciona sem
registro estruturado e consultável de cada unidade — modelo, effort, iterações,
tokens, se passou nos must-haves, quantas objeções o review abriu. É o mesmo dado
que a eval de §3.9 consome. **Durabilidade, medição e auto-melhoria são a mesma
infraestrutura vista de três ângulos.**

> ⚠️ **Ressalva.** Os números do ACE são **do abstract dos autores**, sem replicação
> independente nesta pesquisa. E `Voyager`, `RouteLLM` e `Reflexion` são artefatos
> de pesquisa com push antigo — valem pela **ideia**, não como dependência.

---

### 3.13 Manter-se atualizado — a metade externa do mesmo ciclo

A §3.12 trata de aprender com a **própria experiência**. Esta trata de aprender com
o que **muda por fora**: modelos novos, modelos aposentados, parâmetros removidos,
comportamento re-calibrado. É o mesmo circuito — sinal → delta proposto → portão
medido — apontado para fora.

#### Por que isso não é opcional

O modelo por baixo muda de forma que **quebra silenciosamente**. Exemplos reais, não
hipotéticos, do que o Forge carrega hoje hardcoded:

| O que envelhece | Consequência quando envelhece |
|---|---|
| IDs em `tier_models` | Modelo **aposentado responde 404** — o dispatch quebra e ninguém sabe até rodar. Sonnet 3.7 e Haiku 3.5 foram aposentados em fev/2026 |
| Guards de `thinking`/`effort` por família | Combinação inválida vira **HTTP 400** (`disabled` + `xhigh` no Opus 5; `disabled` explícito no Fable) |
| Mínimos de cache por modelo | **Não são monotônicos** e mudaram entre 4.6 e 5 (§4.2). Um breakpoint dimensionado para um tier deixa de cachear noutro, sem erro |
| Preços por MTok | A medição de custo da §7 vira ficção |
| Janela de contexto e teto de saída | Truncamento no meio da resposta |
| Prompts e descrições de tool | *"Prompts são artefatos por modelo; uma linha que sustenta uma geração é entulho na seguinte"* — orientação de primeira mão |

#### O padrão seguro, já validado pelo upstream **[código]**

O `gsd-pi` tem `.github/workflows/update-model-catalog.yml` — refresh **semanal**
(terça, 09:17 UTC) do catálogo gerado — e expõe `gsd update --models` para o
on-demand. A decisão de desenho está escrita no comentário do arquivo, e é a parte
que importa:

> *"Abre um PR de bot com o diff, para que a mudança chegue pelo review + CI
> normais, em vez de um push não-revisado na main."*

**Detectar automaticamente; aplicar sob portão.** Essa é a linha que separa
auto-aprimoramento de auto-regressão.

#### Três camadas, por nível de risco

| Camada | O que é | Como entra |
|---|---|---|
| **1 · Fato estruturado** | Catálogo de modelos via **Models API** (`/v1/models`): `id`, `display_name`, `max_input_tokens`, `max_tokens`, `capabilities` — legível por máquina e autoritativo | **Automático.** Cron semanal → PR de bot com o diff |
| **2 · Prosa normativa** | Release notes, guia de migração, changelog | **Detecta, não aplica.** Gera um **item de triagem** com o trecho e o que ele afeta. Nunca um patch |
| **3 · Mudança comportamental** | Prompt, `effort`, roteamento, padrões de orquestração | **Só entra com prova.** Adotado apenas se a eval de §3.9 mostrar ganho |

> ⚠️ **Por que a camada 2 nunca é automática.** Um agente que lê prosa da internet
> e reescreve os próprios prompts é superfície de **prompt injection com raio de
> explosão ilimitado** — e o efeito é invisível até degradar o resultado. A leitura
> pode ser automática; a escrita, não.

#### O que isso destrava

A eval de §3.9 deixa de ser só régua de regressão e vira **portão de adoção**: uma
troca de modelo, de prompt ou de roteamento entra porque foi **medida melhor**, não
porque saiu release note. É o mesmo portão que o ACE e o DSPy usam, apontado para
uma fonte externa.

E fecha o argumento da §3.12: **experiência interna e mudança externa são o mesmo
maquinário.** Um Forge que mede consegue absorver as duas; um que não mede não pode
absorver nenhuma com segurança.

---

---

## 4. Achados de custo — o que **ninguém** dos quatro resolve

Levantado da documentação de primeira mão da Anthropic **[docs-1ª]**. Nenhum ADR
do `gsd-pi` nem nada em `opencode`/`goose`/`cline` precifica isto. **É o espaço
livre mais claro que a pesquisa encontrou.**

**Mecânica base.** Cache é *prefix match*: qualquer byte alterado invalida tudo
depois dele, na ordem de render `tools → system → messages`. Leitura ~**0,1×**,
escrita **1,25×** (TTL 5min) ou **2×** (1h). Break-even: 2 requisições no TTL de
5min, 3 no de 1h. Máximo **4 breakpoints** por requisição.

### 4.1 Trocar de modelo destrói o cache

Caches são **model-scoped**. A tabela de invalidação lista *model switch* como
invalidando tools, system **e** messages. Consequência direta e não precificada:
o `tier_models` do Forge **e** o roteamento por capacidade do ADR-004 do gsd-pi
pagam prefixo frio a cada troca. **Quanto mais "inteligente" o roteamento, mais
cache queimado.** A recomendação de primeira mão é o oposto: manter o loop
principal num modelo e usar subagente para a parte barata.

### 4.2 O mínimo cacheável não é monotônico

| Modelo | Mínimo |
|---|---:|
| Opus 5, Fable 5, Mythos 5 | 512 tokens |
| Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1 | 1.024 |
| Opus 4.7, Haiku 3.5 | 2.048 |
| **Opus 4.6, Opus 4.5, Haiku 4.5** | **4.096** |

> ⚠️ **Correção da revisão de 2026-08-04.** A versão anterior desta seção afirmava
> que *"o prompt de worker do Forge, sendo ~500 tokens, fica abaixo do mínimo e não
> cacheia"*. **Isso estava errado** e é instrutivo: o mínimo se aplica ao **prefixo**
> (`tools → system → messages`), não à mensagem do usuário. O system prompt e as
> definições de tool do Claude Code sozinhos passam folgadamente de 4.096 tokens,
> então o prefixo é cacheável independentemente de quão curto seja o prompt do
> worker.

O risco real é mais sutil: **o mínimo varia por modelo e não é monotônico**, então
um breakpoint dimensionado para Opus 5 (512) pode silenciosamente **não cachear**
num worker roteado para Haiku 4.5 (4.096) se o prefixo naquele ponto cair entre os
dois valores. Como o Forge roteia por tier, **o mesmo desenho de prompt cacheia num
tier e não cacheia noutro** — sem erro, apenas `cache_creation_input_tokens: 0`.
Isto precisa ser **medido por tier**, não deduzido.

### 4.3 A janela de lookback de 20 blocos

Cada breakpoint anda **no máximo 20 content blocks** para trás procurando entrada
anterior. Um turno que acrescenta mais que isso — trivial num `execute-task` com
muitos pares `tool_use`/`tool_result` — faz o próximo breakpoint não achar nada e
errar **em silêncio**. Mitigação: breakpoint intermediário a cada ~15 blocos.

### 4.4 Paralelismo ingênuo paga N× o preço

A entrada só fica legível depois que a **primeira resposta começa a streamar**.
N requisições paralelas com prefixo idêntico pagam **todas** preço cheio.
Padrão correto: dispara 1, espera o **primeiro token** (não a resposta inteira),
aí dispara as N−1. **Isto é pré-requisito do escalonador, não otimização.**

### 4.5 Alavancas não usadas

- **Batch API a 50%** do preço — até 100k requisições, maioria conclui em <1h,
  teto 24h. Encaixe óbvio: extração de memória e outras unidades não-interativas.
- **`count_tokens`** em vez de estimativa. `tiktoken` é da OpenAI e **subconta
  Claude em 15–20%**, muito mais em código.
- **Mensagens `role: "system"` no meio do array** — instrução de operador sem
  invalidar o prefixo cacheado. Disponível hoje em Opus 5 / 4.8 / Fable 5,
  **sem beta header**. É também o canal não-falsificável (texto dentro de turno
  de usuário pode ser forjado).
- **Pre-warm com `max_tokens: 0`** — escreve o cache sem gerar saída.

### 4.6 Baseline medido do Forge — e por que §4.1–4.5 é marginal para ele **[código]**

Medido de `.gsd/forge/events.jsonl`, 73 dispatches em 5 dias (29/07 → 03/08):

| modelo | n | input | output | custo | % |
|---|---:|---:|---:|---:|---:|
| `sonnet-5` | 42 | 46.221 | 1.182.959 | $17,88 | **54%** |
| `opus-5` | 15 | 20.732 | 521.778 | $13,15 | **39%** |
| `haiku-4-5` | 12 | 8.883 | 418.974 | $2,10 | 6% |
| `fable-5` | 4 | 3.036 | 4.840 | $0,27 | 1% |
| **total** | **73** | **78.872** | **2.128.551** | **$33,41** | |

Projeção: **~$200/mês** nesse ritmo. (Com o preço promocional do `sonnet-5`,
$2/$10 até 31/08, a conta real é ~$27 / ~$165.)

> ⚠️ **Correção à ênfase de §4.1–4.5.** **A saída responde por 99% do custo** —
> a razão é **27:1**. Toda a disciplina de cache das seções anteriores otimiza a
> **entrada**, que são **1%**. Continua tecnicamente correta e passa a ser
> **economicamente marginal para este perfil de uso**. A prioridade real é saída.

**E o dado que decide a estratégia:** o volume de saída é **praticamente
independente do modelo** — haiku 34,9k por dispatch, opus 34,8k, sonnet 28,2k.
**Quem determina o tamanho da saída é a task, não o modelo.** Isso torna rotear
para modelo mais barato um ganho quase puro, quando a qualidade aguenta.

### 4.7 Alavancas por chamada — o que é rápido, o que é barato, o que é os dois

| Alavanca | + rápido | + barato | Observação |
|---|:--:|:--:|---|
| **`effort` mais baixo** | ✅ | ✅ | Com thinking adaptativo, **pensamento é token de saída**. O guia de migração do Opus 5 manda **varrer para baixo**: *"low e medium são excepcionalmente fortes neste modelo"* |
| **Programmatic tool calling** | ✅ | ✅ | O resultado da tool volta **para o código, não para o contexto**; só a saída final chega ao modelo. *"O custo escala com a saída final, não com os resultados intermediários"* |
| **Roteamento p/ modelo menor** | ✅ | ✅ | Ganho quase puro, dado §4.6 |
| **Instrução de concisão** | ✅ | ✅ | Grátis. O guia do Opus 5 reporta **−20%** de comprimento de resposta com uma instrução curta |
| **Task budget** | ~ | ✅ | O modelo **vê um contador** e se ritma em vez de ser cortado |
| **Batch API** | ❌ assíncrono | ✅ **−50%** | Candidatos no log: 102 `verify`, 13 `symbol_check` |
| **Fast mode** | ✅ **2,5× tok/s** | ❌ **2× o preço** | Alavanca de latência, não de custo |
| Prompt caching | ~ | **marginal aqui** | Otimiza 1% do custo (§4.6) |
| Context editing / compaction | ~ | marginal aqui | Também entrada |

### 4.8 Cascata de modelos — a ideia que inverte o sistema de tiers **[docs-1ª]**

[FrugalGPT](https://ar5iv.labs.arxiv.org/html/2305.05176) (Stanford — Chen, Zaharia,
Zou) propõe **cascata**: manda a query para o modelo **mais barato primeiro**,
pontua a resposta e **escala para o caro só quando não passa**. Reporta até **98%**
de redução de custo mantendo a qualidade do melhor modelo isolado.

O obstáculo do paper é o **scorer** — eles treinam um DistilBERT para prever se a
resposta está correta.

> **O Forge já tem o scorer, e ele é melhor: é determinístico.**
> `must_haves` passa/falha, o verifier de 3 níveis, lint, teste, o file audit. Não
> é predição de correção — é **verificação**. O Forge pode fazer cascata **sem
> treinar nada**.

**A inversão:** hoje o tier é escolhido **antes**, pelo planner, no frontmatter
(`frontmatter-override` responde por 10 dos 73 dispatches). Com cascata, o tier é
decidido **pelo resultado**: roda em `haiku`, roda o verifier; se os must-haves
falham, re-despacha em `sonnet`.

**Quando compensa, com os números de §4.6:**

| tentativa | custo típico |
|---|---:|
| `haiku` (35k out × $5/M) | **$0,175** |
| `sonnet-5` (28k out × $15/M) | $0,42 |
| `opus-5` (35k out × $25/M) | $0,875 |

Uma falha em haiku custa $0,175. Contra o sempre-sonnet de $0,42, a cascata paga a
partir de **~60% de acerto do modelo barato**: a 70% economiza ~29%, a 80% ~38%.
**Abaixo de ~60% ela custa mais** — por isso a taxa de acerto por tipo de unidade
precisa ser **medida**, não suposta. É exatamente o dado que o Event History de
§3.7 produz. Formalização da decisão: [arXiv 2605.06350](https://arxiv.org/pdf/2605.06350).

### 4.9 Comprar em vez de construir: gateways e cache semântico **[meta]**

| | | |
|---|---|---|
| [`BerriAI/litellm`](https://github.com/BerriAI/litellm) | **55.467★** | Gateway: roteamento, fallback, budget, rate limit em config |
| [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway) | 12.636★ TS | Gateway com guardrails integrados, roteia para 1.600+ LLMs |
| [`Helicone/helicone`](https://github.com/Helicone/helicone) | 6.032★ TS | Observabilidade de LLM com uma linha — o dado de custo por unidade sem instrumentar à mão |
| [`zilliztech/GPTCache`](https://github.com/zilliztech/GPTCache) | 8.120★ Py | **Cache semântico** — acerta por *significado*, não por prefixo. ⚠️ push jul/2025; e tasks de código raramente se repetem, então o valor aqui é baixo — exceto talvez em `verify`/`symbol_check` |

E uma omissão do levantamento original que merece registro: **[`ruvnet/ruflo`](https://github.com/ruvnet/ruflo) — 66.964★** (ex-`claude-flow`), descrito como
*"the original agent meta-harness — enxames multi-player"*. **É maior que o
OpenHands** e não estava no documento.

---

### 4.10 Vazão — a outra função-objetivo, e onde ela contradiz o custo **[código]**

Tudo em §4 até aqui otimiza **fatura**. Mas o objetivo declarado da operação é
outro: *"concluo rápido algo que não vou precisar revisitar e passo para o
próximo"*. Isso é **vazão**, e as duas divergem em pelo menos três decisões.

**Medido no mesmo log (73 unidades, 5 dias):**

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

**Duas descobertas:**

1. **O review dialético paga.** 68% de concessão significa que o challenger acha
   defeito real, não ruído — 40 correções que não viraram problema do operador.
2. **O humano não é o gargalo.** Somando tudo que exige decisão humana —
   4 `plan-gate` + 2 `review-triage` + 1 `uat-finding` — são **7 interrupções em
   73 unidades**, uma a cada dez. **Há folga enorme para paralelizar antes de o
   operador virar a restrição.**

**O gargalo é a serialização.** As 73 unidades correram em fila não por dependência
— o ROADMAP já declara quais dependem — mas porque **serializar é o único controle
de recurso que o Forge tem**. É a única alavanca **multiplicativa** do sistema.

#### A tensão: cascata (§4.8) trabalha contra vazão

Cascata são **duas passadas sequenciais** — economiza dólar, gasta relógio. Para
vazão você quer **acertar de primeira**, o que argumenta por `effort` **mais alto**
e modelo **melhor** — o oposto do que §4.7 recomenda quando o critério é custo.

A regra que reconcilia, decidida **por tipo de unidade**, com a variável certa
sendo o **custo de uma tentativa falha**:

| Se a unidade… | Estratégia |
|---|---|
| é curta, barata de verificar, e **não bloqueia nada** | **cascata** — falhar é barato |
| é longa, ou **bloqueia outras unidades no DAG** | **modelo forte de primeira** — o custo de falhar é o relógio dela **mais tudo que ela segura** |

Para uma unidade no caminho crítico, economizar $0,25 trocando sonnet por haiku é
péssimo negócio.

#### Alavancas de vazão, ranqueadas pelo dado

1. **Paralelismo** — única multiplicativa, e há folga de humano para usá-la
2. **Acertar de primeira** — as 40 concessões são o alvo; o efeito é **composto**,
   porque cada retrabalho evitado também evita a verificação dele (1,40 por unidade)
3. **Gate que não bloqueia a fila** — com gate durável, uma pergunta pendente para
   de segurar as outras unidades
4. **Agrupar as interrupções do operador** — 7 já é pouco; juntá-las numa janela
   vale mais do que reduzi-las a 5

### 4.11 Especialistas como plano de controle — e a regra que impede o desastre

A proposta: além dos agentes que **fazem o trabalho**, ter especialistas que mantêm
o sistema **no ponto ideal de operação** e, quando ele sai, **recalculam**. O Forge
já tem a semente — `forge-reviewer`, `forge-advocate` e `forge-plan-checker` não
produzem entrega, melhoram a entrega alheia — e §4.10 mostra que ela paga.

Em teoria de controle isso é **malha fechada**, e uma malha fechada precisa de
**setpoint**. O setpoint aqui é a eval de §3.9: sem ela, "não está no cenário ideal"
é opinião.

#### As três camadas — e só a terceira é agente

| Camada | O que é | Exemplos no Forge |
|---|---|---|
| **Sensores** | Determinísticos, baratos, sempre ligados | `must_haves`, verifier (3 níveis), lint, teste, file audit, métricas do Event History |
| **Controlador** | **Código.** Regras e limiares sobre os sensores | *taxa de acerto em `haiku` < 60% neste tipo de unidade → sobe o tier* · *RAM livre < X → reduz paralelismo* · *objeções abertas > N → escala para o operador* |
| **Especialistas** | **Agentes.** Só onde há julgamento | challenger, advocate, plan-checker, curador de playbook (ACE), triador de mudança externa (§3.13) |

> ⚠️ **A regra que impede o desastre: um agente decide o que um programa não
> consegue calcular.**
>
> Roteamento por taxa de acerto medida é **aritmética**, não julgamento. Nível de
> paralelismo é **divisão**. Se o "recalcular" virar agente, você reintroduz
> não-determinismo **no plano de controle** — e aí não dá para distinguir se o
> comportamento mudou por causa do trabalho ou do controlador. É exatamente o
> fator 8 de volta, uma camada acima.

#### Quais especialistas se pagam

| Especialista | Julgamento que só ele faz | Evidência |
|---|---|---|
| **Challenger × advocate** | Uma objeção é real? | **68% de concessão** em 59 objeções (§4.10) |
| **Plan-checker** | O plano é estruturalmente executável? | 15 execuções em 73 unidades |
| **Curador de playbook** (novo, §3.12) | Que lição desta execução vale guardar? | Módulo de *reflexão/curadoria* do ACE |
| **Triador de mudança externa** (novo, §3.13) | Esta release note afeta a gente? | Camada 2 — detecta, não aplica |

E o que **não** deve virar especialista, porque é conta: roteamento, nível de
paralelismo, `effort`, política de retry, detecção de drift.

#### O custo, com os números reais

Com saída a 99% do custo (§4.6), **cada especialista é gasto recorrente**. A
orientação de primeira mão do time do Claude Code é o freio: *"para tarefas de
código normais, pergunte-se: isso precisa mesmo de mais compute?"*

Por isso especialistas devem ser **dirigidos por evento**, nunca por polling — o
challenger roda quando há diff de slice, não a cada minuto. Um sistema com doze
agentes se vigiando é teatro caro. **Quatro que se pagam, com número, valem mais.**

---

---

### 4.12 Como os agentes se comunicam — e qual falta

**Hoje eles não se comunicam.** A topologia é estrela e o barramento é o contexto do
orquestrador: ele despacha, o worker devolve `---GSD-WORKER-RESULT---`, ele **parseia
prosa**. Challenger e advocate nunca se falam — as objeções do primeiro viram texto
no prompt do segundo, montado pelo orquestrador (`shared/forge-review.md`).

Três problemas compostos: o resultado é prosa (fator 4, §2); **o contexto do
orquestrador é o barramento** e é finito — daí o Compaction Resilience Protocol
existir; e nenhum agente reage ao achado de outro sem ida e volta pelo centro.

**Três canais que estão confundidos:**

| Canal | Protocolo | No Forge hoje |
|---|---|---|
| Agente ↔ ferramenta/ambiente | **MCP** (§3.11) | parcial |
| Orquestrador ↔ agente | **contrato tipado** (structured output) | prosa com marcador |
| Agente ↔ agente | — | inexistente, simulado por prosa do orquestrador |

**A correção contra-intuitiva: agentes não devem conversar entre si.** O instinto é
abrir canal direto. É onde sistemas multi-agente falham — conversa não-limitada,
custo composto, sem trilha de auditoria de quem decidiu o quê. O padrão que funciona
tem nome antigo: **quadro-negro** (*blackboard*) — os agentes **não se falam,
escrevem no mesmo quadro**, e um controlador decide quem roda em seguida.
Comunicação **por artefato**, sequenciamento **por código**. É a mesma disciplina que
a §4.11 impõe ao roteamento.

O Forge já tem o quadro: `.gsd/`. Falta o **barramento de eventos tipados** no lugar
do contexto do orquestrador — que é o Event History da §3.7. Com isso o orquestrador
deixa de ser gargalo de comunicação e vira só sequenciador.

#### O "cleaner": a intuição certa com a ação errada

Algo precisa cuidar do que acumula. Mas **apagar é a falha, não a solução** — o ACE
nomeia **brevity bias** (privilegiar concisão e perder conhecimento de domínio) como
uma das duas patologias centrais (§3.12), e o cap de 50 do `AUTO-MEMORY` **é** brevity
bias implementado de propósito. O papel se divide, e só metade é agente:

| | O que faz | É agente? |
|---|---|---|
| **Faxineiro** | worktrees órfãos, temporários, branches mortos, entradas obsoletas no registro | **Não** — é computável, logo é código dirigido por evento |
| **Curador** | que lição desta execução sobrevive, o que está contradito, o que envelheceu | **Sim** — é julgamento; é o curador do ACE já proposto na §4.11 |

Diferença prática: o faxineiro **apaga por regra**; o curador **reorganiza por
utilidade medida**, com atualização incremental em vez de reescrita.

#### A lacuna real do roster

Aplicando a regra da §4.11 ao roster atual (`discusser`, `researcher`, `planner`,
`executor`, `completer`, `memory`, `reviewer`, `advocate`, `plan-checker`), falta
**um árbitro de conflito** — e ele só passa a existir quando o paralelismo chegar.
A **detecção** já está pronta e é determinística (`forge-touch` / `forge-overlap`, que
deliberadamente recusaram construir a fila). **Reconciliar intenção divergente** entre
duas slices que tocam o mesmo arquivo é julgamento, não aritmética.

#### O que torna isto rápido

1. **Contrato tipado no lugar de prosa** — o resultado deixa de ser parseado e passa a
   ser lido.
2. **Histórico como barramento** — o contexto do orquestrador para de crescer, e a
   pressão de compactação some junto.
3. **Referência, não valor** — o lean orchestrator já faz; o context-packet (§3.12)
   faz melhor, por orçamento.
4. **Dirigido por evento, nunca por polling** — com saída a 99% do custo (§4.6),
   especialista que roda "de tempos em tempos" é dinheiro queimado.
5. **Paralelo onde é independente** — e o quadro-negro é o que torna isso seguro:
   agentes que não conversam não precisam de sincronização entre si.

---

## 5. As identidades possíveis

Nenhum projeto entrega os 11 requisitos. A divisão é limpa: **`gsd-pi` tem a
metodologia**, **`opencode`/`goose` têm a arquitetura de plataforma**, e **ninguém
é cache-aware**.

| | Custo | O Forge vira |
|---|---|---|
| **A · Distribuição do `gsd-pi`** | mínimo | plugin de outro projeto |
| **B · Motor próprio sobre `opencode`/`goose`** | médio | concorrente do gsd-pi em metodologia |
| **C · Camada de operação sobre qualquer motor** | pequeno | o único que faz multi-conta + revisão adversarial + anti-alucinação |

**Decisão tomada em 2026-08-03:** construir algo novo, compondo o melhor de todos
(uma variante de B, com C como identidade). O registro honesto da ressalva: a parte
estrutural que isso reescreve custa **1M de linhas / 46 ADRs** no gsd-pi e
**26 packages** no opencode.

> ⚠️ **Superada pela revisão de 2026-08-04.** Esta tabela foi escrita antes de
> §3.7 existir, e as três opções não cobrem mais o que §6 descreve. A opção B era
> *"motor próprio sobre `opencode`/`goose`"* — mas §6.1 passou a dizer que o Forge
> **não escreve o motor**, e §6.7 propõe um caminho em que nem `opencode` nem
> `goose` aparecem. Existe uma quarta opção, que é a que o documento hoje defende:
>
> **D · Política GSD como programa sobre um motor de execução durável**, com o
> Forge de hoje entrando como a primeira Activity (§6.7).
> **Custo:** baixo na fase 0, incremental depois. **O Forge vira:** a camada de
> operação de C, mas com fluxo de controle próprio de verdade — sem reescrever
> transporte, PTY, TUI nem protocolo.
>
> D é o que §6 e §7 assumem. A tabela acima fica como registro de como se chegou
> aqui, não como o conjunto de opções vivas.

**A releitura que reconcilia:** *novo e nosso* é sobre **autoria das decisões**,
não autoria de cada linha. O loop, a política e o que ninguém tem — o Forge
escreve. Transporte de provider, PTY, TUI e protocolo viraram commodity;
reescrevê-los custa tempo sem comprar identidade.

---

## 6. Arquitetura de partida

### 6.1 O que o Forge escreve (é o que o torna nosso)

> **Revisado após §3.7–3.11.** A primeira versão desta seção dizia que o Forge
> escreveria o kernel e um escalonador consciente de máquina. Duas das três coisas
> encolheram: são infraestrutura adotável, não código nosso. O que sobra é menor —
> e mais nitidamente nosso.

- **A política GSD como programa** — o dispatch, as fases, os gates e o orçamento
  expressos em código, com os fatores 8 e 4 como **invariante testável**. Hoje não
  há função para testar, só markdown para grepar. Isto **roda sobre** um motor de
  execução durável (§3.7); o Forge não escreve o motor.
- **O stagger cache-aware no fan-out** (§4.4) e a disciplina de cache de §4 —
  não trocar de modelo sem motivo, breakpoint a cada ~15 blocos, Batch API nas
  unidades não-interativas. **Nenhum projeto levantado faz isso**, e é diferencial
  real, não cópia.
- **As três coisas que só o Forge tem** — review dialético (challenger × advocate),
  rotação multi-conta de assinatura, camada anti-alucinação (`must_haves` +
  verifier + evidence + route audit).

**O que saiu desta lista, e para onde foi:**

| Era "o Forge escreve" | Virou |
|---|---|
| Motor de loop com pause/resume/retomada | **Execução durável** (§3.7) — Temporal / LangGraph / DBOS. O Compaction Resilience Protocol deixa de existir em vez de melhorar |
| Consciência de máquina por heurística (`cores − 2`) | **Limite de sandbox** (§3.8) — cgroup/microVM. Não se adivinha RAM; capa-se e o kernel impõe |
| Recuperação de conhecimento | **`context-packet`** (§3.3) + mem0/letta (§3.10) |

**Onde ficou o requisito 3 (paralelismo).** A revisão de 2026-08-04 notou que ele
tinha ficado órfão: aparece no critério (§1) e na lista de não-verificados (§9),
mas nenhuma seção dizia quem o resolve. Ele é composto por três peças que já estão
distribuídas acima, e vale dizer isso explicitamente:

| Parte do requisito 3 | Quem resolve |
|---|---|
| Executar unidades independentes em paralelo | **Child workflows** do motor durável (§6.4) |
| Não derrubar a máquina ao fazê-lo | **Limite de sandbox** por worker (§3.8) |
| Não pagar N× o prefixo ao disparar N | **Stagger no fan-out** (§4.4) — do Forge |

Nenhuma das três é escalonador escrito à mão. A parte que sobra como decisão nossa
é a **política**: quais unidades podem correr juntas, dado o grafo de dependências
do ROADMAP — e isso é leitura de DAG, não infraestrutura.

### 6.2 O que compor, de quem, e exatamente o quê

> **Revisão de 2026-08-04.** A versão anterior desta seção era uma tabela única, e
> isso a tornava inutilizável como lista de construção: ela misturava **coisas para
> adotar como dependência** com **padrões para imitar em código nosso**. "Levar o
> sistema de plugin do `opencode`" só faz sentido se você construir *sobre* o
> `opencode` — que é o caminho B, abandonado pela opção D. Separadas abaixo.

#### 6.2.a Adotar como dependência (código de terceiro rodando no Forge)

| De | Levar | Fase de §6.7 |
|---|---|---|
| **Execução durável** (§3.7) | O motor de workflow: passos duráveis, replay, Signal/`interrupt`. **Adotar, não escrever** | **0** |
| **Evals** (§3.9) | `terminal-bench` como régua do harness; `langfuse` para observabilidade | **0** |
| **Sandbox** (§3.8) | Limite de execução por worker (CPU, RAM, rede) — a resposta ao requisito 4 | 4 |
| **`context-packet`** (§3.3) | `resolve(node, {maxTokens})` — recuperação por orçamento, anti-injection, `input_hash` | 4 |
| **`LiteLLM`** | Gateway multi-provider como **processo**, não biblioteca | 3 |
| **Memória** (§3.10) | Substituir o `AUTO-MEMORY.md` feito à mão — `letta` pela memória auto-editável | 4+ |
| **ACP / A2A** (§3.11) | Falar protocolo em vez de inventar um | 4+ |

#### 6.2.b Imitar como padrão (desenho nosso, aprendido de fora)

| De | Padrão |
|---|---|
| **`gsd-pi`** | Banco como autoridade (ADR-046) · roteamento multi-dimensional (ADR-004) · `hard constraints filter, soft scores rank` + `adjustToolSet` + `ProviderSwitchReport` (ADR-005) · paridade nativo×MCP **com teste de paridade** (ADR-008) · o hábito de ADR (46 decisões versionadas em vez de um `CLAUDE.md` de 15k tokens) |
| **`opencode`** | Split **servidor + protocolo tipado + cliente + SDK** · **sistema de plugin** com extensão em `tool` e `tui` (é onde review dialético e multi-conta viram plugin, não fork) · PTY no servidor |
| **`goose`** | **Provider como crate isolada com tipos próprios** · SDK separado dos tipos · **ACP** para interop em vez de protocolo caseiro · três superfícies (app, CLI, API) sobre um núcleo · `local-inference` se um dia quiser modelo local |
| **`OpenHands SDK`** | **Event stream tipado** + `AgentController` que impõe restrições enquanto o agente decide. O `events.jsonl` do Forge já quer ser isso |
| **`SWE-agent`** | Agent-Computer Interface — tools desenhadas para o modelo |
| **Docs Anthropic** | Tudo de §4 — o único item que nenhum concorrente tem |

### 6.3 O que **não** copiar

- **Não copiar arquitetura alheia inteira.** O Forge lidera nos fatores 5 e 10 do
  12-factor; adotar em bloco jogaria isso fora.
  > **Tensão resolvida nesta revisão.** §6.2 manda levar *"banco como autoridade"*
  > (ADR-046) — o que parece contradizer "proteger o fator 5", já que hoje o fator 5
  > do Forge **é** o `.gsd/` em arquivos. Não contradiz: o que o fator 5 pede é que
  > estado de execução e estado de negócio sejam **a mesma coisa, auditável**. Essa
  > é a **propriedade**; markdown é só o **meio**. Um banco preserva a propriedade e
  > melhora a auditoria — desde que o `.gsd/` continue existindo como **projeção
  > legível e diffável**, que é o que o gsd-pi faz. Perder isso, sim, seria perder
  > o fator 5.
- **Não reescrever PTY, TUI e transporte de provider.** Commodity.
- **Não herdar o roteamento por capacidade sem o custo de cache de §4.1.**

---

### 6.4 Mapeamento GSD → execução durável

O encaixe é quase suspeito de tão direto. A hierarquia do GSD **já é** uma árvore
de workflows; ela só nunca teve um motor.

| Conceito GSD | Primitiva | Por quê |
|---|---|---|
| Milestone | **Workflow** | Vive horas ou dias, sobrevive a reinício, tem histórico próprio |
| Slice | **Child workflow** | Isolamento de falha e retomada independentes |
| Task / unidade | **Child workflow** ou passo | Depende de querer histórico por task |
| **Despacho de worker (chamada de LLM)** | **Activity** | Não-determinístico por definição — journalizado, nunca re-executado no replay |
| Comando git, spawn de sandbox, poll de uso | **Activity** | Efeito colateral externo |
| Gate (`AskUserQuestion`, plan gate, triagem de review) | **Signal** (ou `interrupt()`) | O workflow dorme sem consumir nada até a resposta chegar |
| Pause | **Signal** | Deixa de ser arquivo-sinal com polling |
| Handoff de conta por esgotamento | **Signal** + retry de Activity | O workflow nem percebe que trocou de conta |
| Statusline / app / dashboard | **Query** | Lê estado sem tocar na execução |
| Orçamento de tokens da milestone | Estado do workflow | Determinístico, versionado no histórico |
| `events.jsonl` | **Event History** | Deixa de ser log paralelo escrito à mão |

O ponto que fecha o desenho: **os gates param de ser o problema difícil.** Hoje um
gate no headless degrada para `defer` porque não há canal. Num workflow durável, o
gate é um Signal — o milestone simplesmente **espera**, por horas ou dias, sem
processo vivo, sem token queimado, sem `continue.md`.

### 6.5 O que isso apaga do Forge atual

Vale listar, porque o ganho não é "fica mais bonito" — é **código que deixa de
existir**:

| Some | Porque |
|---|---|
| Compaction Resilience Protocol | O estado do loop nunca esteve no contexto |
| `continue.md` (Continue-Here Protocol) | Retomada é propriedade do motor |
| `auto-mode.json`, heartbeat, stale check de 15min | O motor sabe se o workflow vive |
| Arquivo `pause` + polling na fronteira de unidade | Signal |
| `AUTONOMY RULE — CRITICAL` | Um `while` não precisa ser convencido a não parar |
| *"proibido executar inline quando `Agent()` falha"* | Vira política de retry da Activity |
| Metade do `CLAUDE.md` | Regra de comportamento vira invariante de código |

E o ganho de custo de §3.7: **run interrompida não re-paga unidade concluída**.

**Duas linhas que a revisão de 2026-08-04 tirou desta lista, por sobrestimarem:**

| Não some | Por quê |
|---|---|
| Registro de runs (`forge-runs.js`) | Só a metade de **liveness** some. O registro também carrega `branch`, `root`, `project`, `account`, `isolation_mode` e `touched` (o sinal de sobreposição da S07) — **endereço de run e arquivos tocados não são metadado de workflow**. O que resta é um registro mais magro, não a ausência dele. |
| Route audit | *Pode* virar consulta ao Event History, mas **só se a Activity gravar o metadado de engine** (`engine_attempted`, `engine_final`). Isso é desenho a fazer, não propriedade herdada. |

O padrão vale registrar: **execução durável apaga o que é sobre *quando* e *se* algo
rodou; não apaga o que é sobre *onde* e *com o quê*.**

### 6.6 Matriz de decisão — Temporal × LangGraph × DBOS

Nenhuma leitura de código ainda; decidir exige um spike. Os eixos que importam
para o Forge:

| Eixo | Temporal | LangGraph | DBOS |
|---|---|---|---|
| Trilha de auditoria por construção | **sim** | não (snapshot) | parcial |
| Gate que dorme por dias | sim (Signal) | sim (`interrupt()`) | sim |
| Custo de operação | **alto** (serviço + banco) | baixo (biblioteca) | médio (Postgres) |
| Encaixe com "banco é autoridade" (ADR-046 do gsd-pi) | indireto | indireto | **direto** |
| Nativo de LLM | não | **sim** | não |
| Maturidade / adoção | **22.074★**, padrão de indústria | 38.792★, LLM-nativo | 1.513★ |
| Amarra a stack | Go + SDK | Python | Python + Postgres |

**Não são só alternativas — são componíveis.** O padrão publicado de produção
executa *"uma execução de LangGraph dentro de uma única Activity longa do
Temporal"*: o Temporal dá durabilidade e retomada, o LangGraph dá o grafo do agente.
**Mas isso colide com a falha nº 10 de §6.9** — loop inteiro numa Activity perde
durabilidade granular. A composição só é segura quando o que roda dentro da
Activity é **uma unidade curta**, não o loop.

**Leitura preliminar** (a confirmar no spike): o Forge quer a *trilha* do Temporal
com o *custo operacional* do DBOS. Se o spike mostrar que o gate e o histórico
fecham em DBOS, ele é o encaixe mais econômico — e conversa com a decisão do
upstream de tornar o banco autoritativo.

### 6.7 Caminho de migração — estrangulamento, não big bang

Esta era a lacuna mais séria do documento: ele decidia *construir novo* sem dizer
como sair de um sistema que funciona e está em uso. A resposta é o padrão
**strangler**, e ele tem uma propriedade que muda o risco inteiro:

> **A primeira Activity que o workflow chama é o Forge de hoje.**

Ou seja: o workflow novo nasce despachando `claude -p "/forge-auto ..."` — a skill
atual, sem modificação — como uma Activity. No dia um você já tem histórico,
retomada, gate por Signal e pause por Signal, **rodando o Forge existente por
baixo**. Depois cada Activity é substituída, uma por vez, por código próprio:

1. **Fase 0** — workflow com **uma Activity por unidade**, e a Activity é um
   `/forge-next` de hoje (não `/forge-auto`). O loop de slices e o avanço de fase
   ficam no workflow; a lógica de cada unidade segue sendo o Forge atual, intocada.
   > ⚠️ **Corrigido em 2026-08-04 pela falha nº 10 de §6.9.** A primeira versão
   > envolvia o `/forge-auto` **inteiro** numa Activity. Isso dá durabilidade só na
   > fronteira do milestone: uma queda na 8ª task recomeçaria da 1ª, e o
   > não-re-pagamento prometido em §7 **não aconteceria**. Envolver a *unidade* em
   > vez do *loop* preserva a propriedade de estrangulamento e entrega durabilidade
   > granular desde o dia um — ao custo de o workflow precisar saber derivar a
   > próxima unidade, que é justamente a política de §6.1.
2. **Fase 1** — `continue-as-new` na fronteira de slice (falha nº 3) e *claim check*
   via `.gsd/` para resultados grandes (falha nº 9). Sem isto, milestones longos
   estouram o histórico.
3. **Fase 2** — os gates saem do markdown e viram Signals. O `defer` no headless
   deixa de ser necessário.
4. **Fase 3** — a Activity de despacho ganha executor plugável (§6.2), e aí sim
   entra provider que não é Claude.
5. **Fase 4** — sandbox por worker (§3.8), recuperação por orçamento (§3.3).

Cada fase é reversível e mensurável isoladamente pela eval de §3.9. Em nenhum
momento existe um "Forge v2" que precisa estar pronto para o Forge v1 ser
desligado.

### 6.8 Padrões de orquestração — vocabulário de primeira mão **[docs-1ª]**

O time do Claude Code publicou os padrões que usa para orquestrar subagentes em
escala. Vale por duas razões: dá **vocabulário comum** para o dispatch do Forge, e
**valida o diferencial** que §3.1 mostrou ser só nosso.

**Os seis padrões:** *classify-and-act* (rotear por tipo de tarefa) ·
*fan-out-and-synthesize* (paralelizar e fundir) · **adversarial verification**
(agentes independentes verificam contra rubrica) · *generate-and-filter* ·
*tournament* (agentes competem, juízes escolhem) · *loop until done*.

> **O review dialético do Forge é o padrão nº 3, nomeado por quem constrói o
> Claude Code.** Aquilo que §3.1 mediu como tendo **zero arquivos** no `gsd-pi` não
> é excentricidade nossa — é um padrão de primeira linha que o upstream não
> implementa.

E os três anti-padrões que eles nomeiam explicam, com precisão desconfortável,
sintomas que o Forge já documentou:

| Anti-padrão | Onde aparece no Forge |
|---|---|
| **Agentic laziness** — declarar concluído com progresso parcial | É o que a camada anti-alucinação inteira (`must_haves`, verifier, evidence) existe para pegar |
| **Self-preferential bias** — preferir os próprios achados à evidência | É a razão citada no `CLAUDE.md` para `challenger: auto` resolver para a família **oposta** à do autor |
| **Goal drift** — perda de fidelidade por sumarização sucessiva | É o que a memória emergente com quality gate tenta conter |

A conclusão deles vale como freio: *"para tarefas de código normais, pergunte-se:
isso precisa mesmo de mais compute?"* — orquestração dinâmica é para trabalho
complexo e de alto valor, não para tudo.

### 6.9 Riscos conhecidos de execução durável **[2ª mão]**

Existe um catálogo público de **onze falhas de produção** de agentes sobre Temporal.
Vale mais que qualquer página de marketing, porque descreve o que quebra depois que
funciona. Mapeado ao Forge, e **um deles derruba a Fase 0 como eu a escrevi**:

| # | Falha | Consequência para o Forge |
|---|---|---|
| **10** | **SDK de agente inteiro dentro de uma Activity** — o loop todo numa Activity só perde durabilidade granular: *"falha na iteração 47 recomeça da 1"* | **Derruba a Fase 0 original.** Ver correção em §6.7 |
| **3** | **Loop sem limite de iteração** — histórico acumula; degradação em ~500–600 iterações, teto de **51.200 eventos** por workflow | Um milestone longo estoura. Mitigação: **`continue-as-new` na fronteira de slice** — que é exatamente onde o GSD já corta |
| **9** | **Payload acima do limite** — 2MB por payload, 4MB por transação; saída grande de LLM **termina o workflow sem retry** | Resultado de worker com diff e summary pode passar. Mitigação: *claim check* — e **o `.gsd/` já é esse armazenamento**: a Activity devolve o caminho, não o conteúdo |
| **2** | **Activity longa sem heartbeat** — o motor assume worker morto e **reescala**, gerando **chamada de LLM duplicada** | Risco de custo direto: um `execute-task` de 40min pagando duas vezes. Exige `RecordHeartbeat()` e `HeartbeatTimeout` calibrado |
| **6** | **Gate humano sem timeout** — espera indefinida se a notificação falha | A triagem de review e o plan gate travam para sempre. Exige timer + escalação + handler idempotente |
| **7** | **Versionamento quebra o replay** — mudar a lógica do workflow quebra workflows em voo | O Forge itera no próprio loop o tempo todo. Mitigação, e é uma boa notícia: **mudança de prompt é segura** (vive na Activity); mudança de fluxo exige guard de versão |
| **5** | **`ParentClosePolicy` default é ABANDON** | Cancelar um milestone deixaria as slices rodando. Precisa ser explícito |
| **4** | **Retry ingênuo em 429** — tempestade de retry ou perda de durabilidade | O Forge já tem taxonomia de falha; acrescenta respeitar `Retry-After` |
| **8** | **Observabilidade** — *"Activity X deu timeout"* não diz o que o agente fazia | Search Attributes com tipo de unidade, iteração, última tool, modelo e tokens — é o que a statusline e o app querem consultar |

**A leitura que importa:** nenhuma dessas falhas é motivo para não adotar execução
durável — todas têm mitigação conhecida. Mas **três delas (10, 3 e 9) mudam o
desenho**, e descobri-las depois de construir custaria a milestone.

---

## 7. Primeira slice sugerida — o kernel falseável

Não começar pelo scaffold. Começar pelo **mínimo que prova ou mata o plano**:

> **Fase 0 de §6.7**: um workflow durável cuja única Activity é o
> `/forge-auto` de hoje, rodando **uma milestone real deste repositório** —
> com **pause por Signal**, **gate por Signal** e **retomada após matar o processo**.
>
> Sem TUI, sem app, sem executor plugável, sem tocar na lógica do Forge atual.

Isto é menor e mais decisivo do que a versão anterior desta seção, que pedia o
kernel completo com dois executores. O estrangulamento inverte a aposta: em vez de
provar que um motor novo funciona, prova-se que o motor **envolve o que já
funciona**.

Três perguntas falseáveis:

1. **Matar o processo no meio de uma unidade e retomar** devolve o milestone ao
   passo exato, sem `continue.md` e **sem re-pagar** as unidades concluídas?
2. O gate (`AskUserQuestion` / `canUseTool` / `--permission-prompt-tool`) chega e
   pode ser respondido **fora** da TUI do Claude Code — por Signal?
3. Uma Activity que envolve um `claude -p` de 40 minutos sobrevive ao *heartbeat*?
   **Parcialmente respondido por §6.9 nº 2**: exige `RecordHeartbeat()` e
   `HeartbeatTimeout` calibrado, e a falha é **chamada de LLM duplicada** — custo
   real, não só erro. O spike mede se dá para heartbeatar um subprocesso de CLI que
   streama, ou se a Activity precisa ser o *passo* em vez do worker.

4. **Existe uma medida?** Uma task do `terminal-bench` (§3.9) rodando pelo
   caminho novo *e* pelo Forge atual, com o mesmo modelo — não para ganhar, mas
   para provar que a régua existe antes de haver o que medir.

Se as quatro passarem, as fases 1 a 4 de §6.7 são preenchimento incremental, cada
uma reversível. Se a (3) falhar, o recorte de Activity muda (a unidade vira o
*passo* dentro do worker, não o worker inteiro) — e isso é desenho, não bloqueio.
Se a (4) não for montada primeiro, nenhuma das outras três tem como ser defendida
depois.

**Medição que deve acompanhar:** custo de uma milestone real a preço de API contra
a assinatura. `--output-format json` já devolve `total_cost_usd` por invocação.
Sem esse número, a escolha entre executor de assinatura e executor de API é
convicção, não orçamento.

---

## 8. Questões em aberto

1. **Assinatura vs API.** O Agent SDK é empurrado para API key — os docs dizem que
   a Anthropic não permite que produtos de terceiros ofereçam login/limites
   claude.ai, *incluindo* agentes construídos sobre o Agent SDK. O caminho do CLI
   como subprocesso é explicitamente sancionado e preserva a assinatura. **Decide
   toda a máquina multi-conta.**
2. **`--permission-prompt-tool` recebe os gates no caminho do CLI?** Se sim, a rota
   do subprocesso tem tudo que o SDK tem e continua na assinatura. Não verificado.
3. **Fork, contribuição ou camada** — a decisão de §5 foi tomada, mas as duas
   features que o `gsd-pi` não tem continuam sendo contribuição de baixo custo e
   alta alavancagem, independentemente.
4. **O formato do `.gsd/`** do `gsd-pi` é compatível com o do Forge? Não verificado
   — decide se há caminho de migração ou só de reescrita.
5. **`handoff` no `gsd-pi` (75 arquivos)** — é handoff de conta ou o
   "agent-human maintainability handoff" do doc 18 da série deles? Não verificado.
6. **Qual motor de execução durável** (§6.6) — decide custo operacional, linguagem
   e se o `.gsd/` continua sendo arquivo ou vira banco.
7. **Onde fica a fronteira de Activity** — o worker inteiro, ou o passo dentro do
   worker? Decide granularidade da retomada e o tamanho do Event History.

---

## 9. O que esta pesquisa **não** verificou

Registrado para que ninguém trate leitura de README como leitura de código:

- **Paralelismo real, consciência de memória e qualidade de recuperação**
  (requisitos 3, 4 e 6) em qualquer um dos projetos — exige **rodar e medir**,
  não ler.
- Arquitetura em profundidade de `cline` e do `OpenHands SDK` — li estrutura e
  paper, não o código como no `gsd-pi`.
- Tudo marcado **[2ª mão]**: `SWE-agent`, `awesome-harness-engineering`, e os
  orquestradores de cauda longa (Bernstein, Helmor, repomon).
- Se as decisões dos ADRs do `gsd-pi` estão **implementadas** como declaram —
  confirmei só o ADR-008, que traz tabela de status por fase e teste de paridade.
- **§3.8 a §3.11 seguem [meta]** — verifiquei existência, linguagem, licença,
  atividade e descrição oficial; **não li o código de nenhum deles**. A escolha
  entre `microsandbox` e `firecracker`, ou entre `mem0` e `letta`, exige leitura
  que esta sessão não fez.
- **§3.7 subiu para [docs-1ª]** e o risco de determinismo foi **resolvido** — mas
  contra a documentação do Temporal, **não contra código rodando**. O spike de §7
  é quem confirma.
- **Timeout e heartbeat de Activity longa.** Um `execute-task` pode levar 40
  minutos. Motores de execução durável tratam isso (long-running activity,
  heartbeat), mas é desenho que precisa ser feito, e nenhum documento lido cobre
  o caso "subprocesso de CLI que streama por 40 minutos".
- **Custo operacional real de rodar um motor.** Temporal pede servidor e banco;
  para um sistema que hoje é `npx` + arquivos, isso é uma mudança de natureza do
  produto que nenhuma leitura de doc mede.
- **A matriz de §6.6 é preliminar** — construída de documentação e metadado, não
  de uso. Nenhuma linha dela deve virar decisão sem o spike.
- **§6.9 é [2ª mão]** — o catálogo de onze falhas vem de um levantamento de
  terceiro, não da documentação do Temporal nem de uso próprio. Os números citados
  (51.200 eventos, 2MB/4MB de payload, ~500–600 iterações) **precisam ser
  confirmados na documentação oficial** antes de virarem restrição de desenho.
- **§6.8 é [docs-1ª]** e não precisa de spike — mas é *guidance*, não garantia:
  os seis padrões descrevem como o time do Claude Code orquestra, não um contrato
  de API.

---

## 11. Esforço estimado — e por que a estimativa é fraca

**Velocidade medida deste repositório** (de `events.jsonl` + git, não estimada):
73 unidades executadas, **7 toques humanos**. Essa é a base de comparação; qualquer
número abaixo é derivado dela.

| Fase | Entrega | Ordem de grandeza |
|---|---|---|
| **0 — spike** | §7: uma unidade GSD rodando dentro de uma Activity, sobrevivendo a kill −9 | dias |
| **1 — kernel** | loop durável para milestone inteiro, `/forge-next` por Activity, gates como Signal | semanas |
| **2 — plano de controle** | eval (§3.9), registro estruturado por unidade, roteamento medido | semanas |
| **3 — composição** | sandbox (§3.8), executor multi-LLM (§6.2.a), paralelismo real | semanas |

**Por que a estimativa é fraca, e a ressalva importa mais que os números:** a §0.6
vale aqui integralmente — nada foi construído, então isto é planejamento de trabalho
desconhecido. As duas incertezas dominantes são **operar um motor durável** (custo
recorrente, não pontual — §6.6) e o **atrito de migração por estrangulamento**
(§6.7), que é onde projetos deste tipo estouram.

**A fase 0 é a única com estimativa defensável**, porque é falseável: ou a unidade
sobrevive ao kill, ou não. Ela existe justamente para **converter as fases 1–3 de
estimativa em medição** — rodar a fase 0 antes de comprometer prazo com o resto é a
recomendação, não um detalhe de sequenciamento.

**Débito de instrumentação bloqueando a medição:** `events.jsonl` **não registra
duração por unidade**. Sem carimbo de início/fim, o ganho de paralelismo da fase 3
é inafirmável — não há linha de base contra a qual comparar. Acrescentar o carimbo é
mudança aditiva de baixo custo e deveria preceder a fase 0.

---

## 10. Índice de referências

**Upstream e ecossistema GSD**
- [`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi) — upstream vivo · 46 ADRs · série `building-coding-agents`
- [`gsd-build/get-shit-done`](https://github.com/gsd-build/get-shit-done) — 64.772★, o original
- [`gsd-build/context-packet`](https://github.com/gsd-build/context-packet) — recuperação por orçamento
- [`gsd-build/daemon`](https://github.com/gsd-build/daemon) — local ↔ relay com WAL
- [`open-gsd/gsd-browser`](https://github.com/open-gsd/gsd-browser) — automação de browser em Rust para agentes

**Motores**
- [`anomalyco/opencode`](https://github.com/anomalyco/opencode) · [`aaif-goose/goose`](https://github.com/aaif-goose/goose) · [`cline/cline`](https://github.com/cline/cline) · [`OpenHands/OpenHands`](https://github.com/OpenHands/OpenHands) · [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk)

**Infra e peças**
- [`BerriAI/litellm`](https://github.com/BerriAI/litellm) · [`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad) · [`patoles/agent-flow`](https://github.com/patoles/agent-flow) · [`SWE-agent/SWE-agent`](https://github.com/SWE-agent/SWE-agent) · [`redevops-io/sidekick`](https://github.com/redevops-io/sidekick)

**Metodologia**
- [`github/spec-kit`](https://github.com/github/spec-kit) · [`bmad-code-org/BMAD-METHOD`](https://github.com/bmad-code-org/BMAD-METHOD) · [`eyaltoledano/claude-task-master`](https://github.com/eyaltoledano/claude-task-master)

**Execução durável** (§3.7)
- [`temporalio/temporal`](https://github.com/temporalio/temporal) · [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) · [`inngest/inngest`](https://github.com/inngest/inngest) · [`restatedev/restate`](https://github.com/restatedev/restate) · [`dbos-inc/dbos-transact-py`](https://github.com/dbos-inc/dbos-transact-py) · [`pgflow-dev/pgflow`](https://github.com/pgflow-dev/pgflow)

**Sandbox** (§3.8)
- [`daytonaio/daytona`](https://github.com/daytonaio/daytona) · [`firecracker-microvm/firecracker`](https://github.com/firecracker-microvm/firecracker) · [`coder/coder`](https://github.com/coder/coder) · [`e2b-dev/E2B`](https://github.com/e2b-dev/E2B) · [`superradcompany/microsandbox`](https://github.com/superradcompany/microsandbox)

**Evals e observabilidade** (§3.9)
- [`harbor-framework/terminal-bench`](https://github.com/harbor-framework/terminal-bench) · [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) · [`langfuse/langfuse`](https://github.com/langfuse/langfuse) · [`openai/evals`](https://github.com/openai/evals)

**Memória** (§3.10)
- [`mem0ai/mem0`](https://github.com/mem0ai/mem0) · [`topoteretes/cognee`](https://github.com/topoteretes/cognee) · [`letta-ai/letta`](https://github.com/letta-ai/letta) · [`getzep/zep`](https://github.com/getzep/zep)

**Protocolos** (§3.11)
- [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) · [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol) · [`a2aproject/A2A`](https://github.com/a2aproject/A2A) · [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol)

**Execução durável aplicada a agentes** (§6.8–6.9)
- [A harness for every task: dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) — os seis padrões e os três anti-padrões, de primeira mão
- [Temporal AI Agent Failures: 11 Production Pitfalls](https://www.xgrid.co/resources/temporal-ai-agent-orchestration-failure-patterns/) — o catálogo de §6.9
- [AI Applications & Agents With Temporal](https://temporal.io/solutions/ai) · [Durable Execution meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai) · [Of course you can build dynamic AI agents with Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal)

**Auto-melhoria e eficiência de contexto** (§3.12)
- [Agentic Context Engineering — arXiv 2510.04618](https://arxiv.org/abs/2510.04618) — playbook evolutivo, delta updates, −83,6% de token
- [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) · [`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) · [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM) · [`MineDojo/Voyager`](https://github.com/MineDojo/Voyager) · [`noahshinn/reflexion`](https://github.com/noahshinn/reflexion) · [`zou-group/textgrad`](https://github.com/zou-group/textgrad) · [`zorazrw/agent-workflow-memory`](https://github.com/zorazrw/agent-workflow-memory)

**Custo por chamada e cascata** (§4.6–4.9)
- [FrugalGPT — arXiv 2305.05176](https://ar5iv.labs.arxiv.org/html/2305.05176) · [Is Escalation Worth It? — arXiv 2605.06350](https://arxiv.org/pdf/2605.06350)
- [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway) · [`Helicone/helicone`](https://github.com/Helicone/helicone) · [`zilliztech/GPTCache`](https://github.com/zilliztech/GPTCache) · [`ruvnet/ruflo`](https://github.com/ruvnet/ruflo)

**Teoria**
- [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) · [OpenHands Software Agent SDK (arXiv 2511.03690)](https://arxiv.org/abs/2511.03690) · [Code as Agent Harness (arXiv 2605.18747)](https://arxiv.org/html/2605.18747v1) · [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)

**Documentação de primeira mão da Anthropic** (base de §4)
- Prompt caching · token counting · Agent SDK overview · headless / `claude -p`

---

*Clones usados nesta pesquisa: `/tmp/{gsd-pi,opencode,goose,cline}` — efêmeros,
reclone com `--depth 1` se precisar reabrir.*
