// ForgeKitTests — contract tests for the pure logic in ForgeKit.
//
// Uses the project's own harness rather than XCTest: XCTest ships with full
// Xcode, not with the Command Line Tools this repo builds against, and every
// JS suite here already follows the same exit-0/exit-1 shape.
//
// Run: swift run ForgeKitTests   (from app/), or via scripts/forge-app.test.js

import Foundation
import ForgeKit

var passed = 0
var failed = 0
var failures: [(String, String)] = []
var current = ""

func test(_ name: String, _ body: () throws -> Void) {
    current = name
    do {
        try body()
        passed += 1
        print("  ✓ \(name)")
    } catch let e as Failure {
        failed += 1
        failures.append((name, e.message))
        print("  ✗ \(name)")
        print("      \(e.message)")
    } catch {
        failed += 1
        failures.append((name, "\(error)"))
        print("  ✗ \(name)")
    }
}

struct Failure: Error { let message: String }

func assertTrue(_ c: Bool, _ msg: String = "esperado true") {
    if !c { failures.append((current, msg)); failed += 1; print("  ✗ \(current)\n      \(msg)") }
}
func assertFalse(_ c: Bool, _ msg: String = "esperado false") { assertTrue(!c, msg) }
func assertEqual<T: Equatable>(_ a: T, _ b: T, _ msg: String = "") {
    if a != b {
        let m = "\(msg)\n     esperado: \(b)\n     obtido:   \(a)"
        failures.append((current, m)); failed += 1; print("  ✗ \(current)\n      \(m)")
    }
}
func assertGreater<T: Comparable>(_ a: T, _ b: T, _ msg: String = "") {
    if !(a > b) { failures.append((current, msg)); failed += 1; print("  ✗ \(current)\n      \(msg)") }
}
func assertNoThrow(_ body: () throws -> Void, _ msg: String = "") {
    do { try body() } catch {
        failures.append((current, msg)); failed += 1; print("  ✗ \(current)\n      \(msg)")
    }
}

print("\n=== ForgeKit — contract test suite ===\n")
print("PrefsEdit (escreve na config real do usuário)")

// PrefsEditTests — the code that writes to the user's real preferences file.
//
// This is the only place in the app that mutates a file the user owns and
// cannot regenerate. The scaffolded forge-agent-prefs.jsonc is ~450 lines of
// commented documentation with a handful of live assignments, so the risks are
// specific and worth pinning down:
//   - hitting a COMMENTED example instead of the real assignment
//   - hitting a same-named leaf in the WRONG section
//   - destroying comments while editing
// Each of those has a test below.

import Foundation
import ForgeKit


/// Shaped like the real scaffold: a commented example far above the live value.
let scaffold = """
{
  // ── repo_path ───────────────────────────────────────────
  // Caminho do repositório do Forge (dev/dogfood).
  // "repo_path": "",

  // ── review ──────────────────────────────────────────────
  // "review": { "challenger": "claude" },

  "review": {
    "challenger": "codex"
  },
  "repo_path": "/Users/dev/forge-agent",
  "tier_models": {
    "heavy": "claude-opus-5"
  }
}
"""

// MARK: - The commented-line trap

test("testIgnoresCommentedAssignment") {
    let out = PrefsEdit.upsert(scaffold, path: ["repo_path"], value: .string("/novo"))
    assertTrue(out.contains("\"repo_path\": \"/novo\""), "deve escrever o valor novo")
    assertTrue(out.contains("// \"repo_path\": \"\","),
                  "a linha COMENTADA deve permanecer intacta")
    // Exactly one live assignment — not two.
    let live = out.split(separator: "\n").filter {
        PrefsEdit.isAssignment(String($0), key: "repo_path")
    }
    assertEqual(live.count, 1, "não pode duplicar a chave")
}

test("testIsAssignmentRejectsComments") {
    assertFalse(PrefsEdit.isAssignment("  // \"repo_path\": \"\",", key: "repo_path"))
    assertFalse(PrefsEdit.isAssignment("  # repo_path: x", key: "repo_path"))
    assertFalse(PrefsEdit.isAssignment("  // ── repo_path ──", key: "repo_path"))
    assertTrue(PrefsEdit.isAssignment("  \"repo_path\": \"/x\",", key: "repo_path"))
}

test("testIsAssignmentRejectsPrefixCollision") {
    // "repo_path_extra" must not satisfy a lookup for "repo_path".
    assertFalse(PrefsEdit.isAssignment("  \"repo_path_extra\": 1,", key: "repo_path"))
    // Nor a mere mention inside a string value.
    assertFalse(PrefsEdit.isAssignment("  \"note\": \"veja repo_path\",", key: "repo_path"))
}

// MARK: - Comments must survive

test("testCommentsPreserved") {
    let out = PrefsEdit.upsert(scaffold, path: ["review", "challenger"], value: .string("gemini"))
    for marker in ["// ── repo_path ─", "// ── review ─",
                   "// Caminho do repositório do Forge (dev/dogfood).",
                   "// \"review\": { \"challenger\": \"claude\" },"] {
        assertTrue(out.contains(marker), "comentário perdido: \(marker)")
    }
}

test("testUnrelatedLinesByteIdentical") {
    let out = PrefsEdit.upsert(scaffold, path: ["review", "challenger"], value: .string("gemini"))
    let before = scaffold.components(separatedBy: "\n")
    let after = out.components(separatedBy: "\n")
    assertEqual(before.count, after.count, "não deve inserir nem remover linhas")
    let changed = zip(before, after).filter { $0 != $1 }
    assertEqual(changed.count, 1, "exatamente uma linha muda")
    assertTrue(changed.first?.1.contains("gemini") == true)
}

// MARK: - Nested keys

test("testNestedReplaceStaysInItsSection") {
    // Same leaf name in two sections: the edit must land in the right one.
    let doc = """
    {
      "review": {
        "mode": "enabled"
      },
      "plan_check": {
        "mode": "advisory"
      }
    }
    """
    let out = PrefsEdit.upsert(doc, path: ["plan_check", "mode"], value: .string("blocking"))
    assertTrue(out.contains("\"mode\": \"blocking\""))
    assertTrue(out.contains("\"mode\": \"enabled\""), "a seção review não pode ser tocada")

    // And the blocking value must be inside plan_check, not review.
    let lines = out.components(separatedBy: "\n")
    let planIdx = lines.firstIndex { $0.contains("\"plan_check\"") }!
    let blockingIdx = lines.firstIndex { $0.contains("blocking") }!
    assertGreater(blockingIdx, planIdx, "valor foi para a seção errada")
}

test("testNestedInsertIntoExistingSection") {
    let doc = """
    {
      "review": {
        "mode": "enabled"
      }
    }
    """
    let out = PrefsEdit.upsert(doc, path: ["review", "ask_in_auto"], value: .string("gate"))
    assertTrue(out.contains("\"ask_in_auto\": \"gate\","))
    assertTrue(out.contains("\"mode\": \"enabled\""), "irmão preservado")
}

test("testNestedCreatesMissingSection") {
    let out = PrefsEdit.upsert("{\n}", path: ["review", "ask_in_auto"], value: .string("gate"))
    assertTrue(out.contains("\"review\""))
    assertTrue(out.contains("\"ask_in_auto\": \"gate\""))
}

// MARK: - Removal

test("testNullRemovesKey") {
    let out = PrefsEdit.upsert(scaffold, path: ["repo_path"], value: .null)
    let live = out.split(separator: "\n").filter {
        PrefsEdit.isAssignment(String($0), key: "repo_path")
    }
    assertEqual(live.count, 0, "a atribuição real deve sumir")
    assertTrue(out.contains("// \"repo_path\": \"\","), "o comentário permanece")
}

test("testNullOnMissingSectionIsNoOp") {
    let doc = "{\n  \"a\": 1\n}"
    assertEqual(PrefsEdit.upsert(doc, path: ["nope", "x"], value: .null), doc)
}

// MARK: - Formatting

test("testPreservesTrailingComma") {
    let doc = "{\n  \"a\": 1,\n  \"b\": 2\n}"
    let withComma = PrefsEdit.upsert(doc, path: ["a"], value: .number(9))
    assertTrue(withComma.contains("\"a\": 9,"), "vírgula mantida")
    let withoutComma = PrefsEdit.upsert(doc, path: ["b"], value: .number(9))
    assertTrue(withoutComma.contains("\"b\": 9"))
    assertFalse(withoutComma.contains("\"b\": 9,"), "não pode inventar vírgula")
}

test("testPreservesIndentation") {
    let doc = "{\n      \"deep\": 1\n}"
    let out = PrefsEdit.upsert(doc, path: ["deep"], value: .number(2))
    assertTrue(out.contains("      \"deep\": 2"), "indentação original mantida")
}

test("testDeeperThanTwoLevelsIsNoOp") {
    // Not supported by design — must leave the document untouched rather
    // than write something wrong.
    let doc = "{\n  \"a\": { \"b\": { \"c\": 1 } }\n}"
    assertEqual(PrefsEdit.upsert(doc, path: ["a", "b", "c"], value: .number(2)), doc)
}

// MARK: - Encoding

test("testEncodeTypes") {
    assertEqual(PrefsEdit.encode(.bool(true)), "true")
    assertEqual(PrefsEdit.encode(.number(30)), "30")
    assertEqual(PrefsEdit.encode(.number(1.5)), "1.5")
    assertEqual(PrefsEdit.encode(.null), "null")
    assertEqual(PrefsEdit.encode(.string("x")), "\"x\"")
    assertEqual(PrefsEdit.encode(.array([.string("a"), .number(1)])), "[\"a\", 1]")
}

test("testEncodeEscapesQuotes") {
    assertEqual(PrefsEdit.encode(.string("diz \"oi\"")), "\"diz \\\"oi\\\"\"")
}

/// Whatever comes out must still parse once comments are stripped —
/// otherwise a save silently corrupts the file for every engine that
/// reads it.
test("testResultStillParsesAsJSON") {
    var doc = scaffold
    doc = PrefsEdit.upsert(doc, path: ["review", "ask_in_auto"], value: .string("gate"))
    doc = PrefsEdit.upsert(doc, path: ["repo_path"], value: .string("/outro"))
    doc = PrefsEdit.upsert(doc, path: ["auto_push"], value: .bool(true))

    let stripped = doc.components(separatedBy: "\n")
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        .joined(separator: "\n")
    assertNoThrow({ _ = try JSONSerialization.jsonObject(with: Data(stripped.utf8)) }, "documento resultante não é JSON válido:\n\(stripped)")
}

test("testRepeatedEditsAreIdempotent") {
    let once = PrefsEdit.upsert(scaffold, path: ["review", "challenger"], value: .string("gemini"))
    let twice = PrefsEdit.upsert(once, path: ["review", "challenger"], value: .string("gemini"))
    assertEqual(once, twice, "reescrever o mesmo valor não pode mudar o arquivo")
}

test("chave nova entra junto do próprio comentário") {
    // The scaffold documents every knob; a value dropped at the top of the file
    // sits orphaned while its comment block still shows the default.
    let doc = """
    {
      "$schema": "x",
      // ── main_branch ─────────────────
      // Nome da branch principal.
      // "main_branch": "master",
      // ── auto_push ───────────────────
      // "auto_push": false,
    }
    """
    let out = PrefsEdit.upsert(doc, path: ["main_branch"], value: .string("main"))
    let lines = out.components(separatedBy: "\n")
    let commented = lines.firstIndex { $0.contains("// \"main_branch\"") }!
    let live = lines.firstIndex { PrefsEdit.isAssignment($0, key: "main_branch") }!
    assertEqual(live, commented + 1, "valor deve ficar logo abaixo do comentário que o explica")
    assertTrue(lines.firstIndex { $0.contains("auto_push") }! > live,
               "não pode invadir a seção seguinte")
}

test("sem comentário correspondente, cai no topo") {
    let out = PrefsEdit.upsert("{\n  \"a\": 1\n}", path: ["novo"], value: .bool(true))
    let lines = out.components(separatedBy: "\n")
    assertEqual(lines.firstIndex { $0.contains("novo") }, 1)
}

test("cabeçalho de seção não é confundido com atribuição comentada") {
    assertFalse(PrefsEdit.isCommentedAssignment("  // ── main_branch ───", key: "main_branch"))
    assertTrue(PrefsEdit.isCommentedAssignment("  // \"main_branch\": \"master\",", key: "main_branch"))
}

print("\nPrefsLocator (achou o repo errado uma vez)")

test("parseRepoPath ignora a linha comentada do scaffold") {
    // Shape of the real file: a commented example ~400 lines above the live one.
    let doc = """
    {
      // ── repo_path ─────────────────────
      // "repo_path": "",
      "review": { "challenger": "codex" },
      "repo_path": "/Users/dev/forge-agent"
    }
    """
    assertEqual(PrefsLocator.parseRepoPath(doc), "/Users/dev/forge-agent")
}

test("parseRepoPath retorna nil quando só há comentário") {
    let doc = "{\n  // \"repo_path\": \"/nao/usar\",\n}"
    assertEqual(PrefsLocator.parseRepoPath(doc), nil)
}

test("parseRepoPath tira comentário de fim de linha") {
    let doc = "{\n  \"repo_path\": \"/x\", // dogfood\n}"
    assertEqual(PrefsLocator.parseRepoPath(doc), "/x")
}

test("parseRepoPath aceita a forma sem aspas") {
    // Tolerated by the parser, but only the JSONC/JSON files are ever read —
    // the legacy markdown format is deliberately not consulted.
    assertEqual(PrefsLocator.parseRepoPath("repo_path: /sem/aspas"), "/sem/aspas")
}

test("parseRepoPath usa a ÚLTIMA atribuição viva") {
    let doc = "{\n  \"repo_path\": \"/antigo\",\n  \"repo_path\": \"/novo\"\n}"
    assertEqual(PrefsLocator.parseRepoPath(doc), "/novo")
}

print("\nGit.parseWorktrees (decide se a atividade do projeto é contada)")

test("parseWorktrees lê o formato porcelain") {
    let out = """
    worktree /repo
    HEAD abc123
    branch refs/heads/main

    worktree /repo/.forge-worktrees/M008
    HEAD def456
    branch refs/heads/forge/M008

    """
    let w = Git.parseWorktrees(out)
    assertEqual(w.count, 2)
    assertEqual(w[0].path, "/repo")
    assertEqual(w[0].branch, "main")
    assertEqual(w[0].isPrimary, true)
    assertEqual(w[1].branch, "forge/M008")
    assertEqual(w[1].isPrimary, false)
    assertEqual(w[1].name, "M008")
}

test("parseWorktrees aceita HEAD destacado (sem branch)") {
    let out = "worktree /repo\nHEAD abc\ndetached\n"
    let w = Git.parseWorktrees(out)
    assertEqual(w.count, 1)
    assertEqual(w[0].branch, nil)
}

test("parseWorktrees pula repositório bare") {
    // A bare repo has no working tree — offering to open it would be a dead end.
    let out = "worktree /repo.git\nHEAD abc\nbare\n\nworktree /wt\nHEAD def\nbranch refs/heads/x\n"
    let w = Git.parseWorktrees(out)
    assertEqual(w.count, 1)
    assertEqual(w[0].path, "/wt")
    assertEqual(w[0].isPrimary, true, "o primeiro NÃO-bare vira o primário")
}

test("parseWorktrees devolve vazio para saída vazia") {
    assertEqual(Git.parseWorktrees("").count, 0)
}

print("\nModels")

test("gate pendente vira expirado ao passar do prazo") {
    let opt = GateOption(key: "a", label: "A", description: "")
    let g = Gate(id: "g", run_id: nil, unit_id: nil, origin: nil, cwd: nil,
                 question: "q", context: nil, options: [opt], default: "a",
                 status: "pending", answer: nil,
                 created_at: 0, expires_at: Date.nowMs - 1000)
    assertEqual(g.effectiveStatus, "expired")
    assertFalse(g.isPending)
}

test("gate sem prazo permanece pendente") {
    let opt = GateOption(key: "a", label: "A", description: "")
    let g = Gate(id: "g", run_id: nil, unit_id: nil, origin: nil, cwd: nil,
                 question: "q", context: nil, options: [opt], default: "a",
                 status: "pending", answer: nil, created_at: 0, expires_at: nil)
    assertEqual(g.effectiveStatus, "pending")
}

test("gate respondido nunca regride para expirado") {
    // The real race: the human answers as the clock runs out. A durable answer
    // must win over the deadline.
    let opt = GateOption(key: "a", label: "A", description: "")
    let g = Gate(id: "g", run_id: nil, unit_id: nil, origin: nil, cwd: nil,
                 question: "q", context: nil, options: [opt], default: "a",
                 status: "answered",
                 answer: GateAnswer(key: "a", label: "A", source: "human", notes: nil),
                 created_at: 0, expires_at: Date.nowMs - 1000)
    assertEqual(g.effectiveStatus, "answered")
}

test("Duration formata as faixas") {
    assertEqual(Duration.short(ms: 5000), "5s")
    assertEqual(Duration.short(ms: 120_000), "2min")
    assertEqual(Duration.short(ms: 5_400_000), "1.5h")
    assertEqual(Duration.short(ms: -1), "agora")
}

print("\nProjectDiscovery (a cópia local sombreava esta — código testado ≠ código rodado)")

test("scan acha projeto e continua descendo para aninhados") {
    let tmp = NSTemporaryDirectory() + "forge-disc-\(UUID().uuidString.prefix(6))"
    let fm = FileManager.default
    defer { try? fm.removeItem(atPath: tmp) }

    // ~/Development/repo/.gsd  and  ~/Development/repo/services/.gsd (monorepo)
    for p in ["Development/repo/.gsd", "Development/repo/services/.gsd",
              "Development/plain/src", "Development/repo/node_modules/pkg/.gsd"] {
        try? fm.createDirectory(atPath: "\(tmp)/\(p)", withIntermediateDirectories: true)
    }

    // Compare by suffix: macOS canonicalises /var to /private/var, so the
    // returned paths never string-match the ones built here.
    let found = ProjectDiscovery.scan(home: tmp)
    func has(_ suffix: String) -> Bool { found.contains { $0.hasSuffix(suffix) } }

    assertTrue(has("/Development/repo"), "projeto raiz não encontrado")
    assertTrue(has("/Development/repo/services"),
               "projeto aninhado perdido — parar no primeiro acerto seria errado")
    assertFalse(has("/Development/plain"), "pasta sem .gsd não é projeto")
    assertFalse(found.contains { $0.contains("node_modules") },
                "node_modules deve ser pulado")
}

test("scan ignora raiz inexistente sem falhar") {
    let tmp = NSTemporaryDirectory() + "forge-disc-empty-\(UUID().uuidString.prefix(6))"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectDiscovery.scan(home: tmp).count, 0)
}

print("\nPrefKind (evita reescrever lista como string)")

test("array de strings vira editor de lista") {
    assertEqual(PrefKind.from(types: ["array"], hasEnum: false, itemsAreStrings: true), .stringList)
}

test("união string|array fica opaca") {
    // tier_models.heavy aceita as duas formas; escrever numa delas poderia
    // mudar o significado em silêncio.
    assertEqual(PrefKind.from(types: ["string", "array"], hasEnum: false, itemsAreStrings: true), .opaque)
}

test("object fica opaco") {
    assertEqual(PrefKind.from(types: ["object"], hasEnum: false, itemsAreStrings: false), .opaque)
}

test("enum vence o tipo base") {
    assertEqual(PrefKind.from(types: ["string"], hasEnum: true, itemsAreStrings: false), .choice)
}

test("tipos escalares") {
    assertEqual(PrefKind.from(types: ["boolean"], hasEnum: false, itemsAreStrings: false), .toggle)
    assertEqual(PrefKind.from(types: ["integer"], hasEnum: false, itemsAreStrings: false), .number)
    assertEqual(PrefKind.from(types: ["string"], hasEnum: false, itemsAreStrings: false), .text)
}

test("asStringArray só aceita array homogêneo de strings") {
    assertEqual(JSONValue.array([.string("a"), .string("b")]).asStringArray ?? [], ["a", "b"])
    assertTrue(JSONValue.array([.string("a"), .number(1)]).asStringArray == nil,
               "array misto não pode virar lista de strings")
    assertTrue(JSONValue.string("a").asStringArray == nil)
}

test("lista sobrevive ao round-trip como array, não como string") {
    // The regression this guards: editing a list used to write it back as one
    // comma-joined string.
    let list = JSONValue.array([.string("dist/**"), .string("build/**")])
    let doc = PrefsEdit.upsert("{\n}", path: ["file_audit", "ignore_list"], value: list)
    assertTrue(doc.contains("[\"dist/**\", \"build/**\"]"), "deve gravar como array: \(doc)")
    assertFalse(doc.contains("\"dist/**, build/**\""), "não pode virar string única")
}

print("\nPrefLabels (nome de máquina → texto humano)")

test("humanise converte snake_case") {
    assertEqual(PrefLabels.humanise("ask_in_auto"), "Ask in auto")
    assertEqual(PrefLabels.humanise("adaptive_flags_lines"), "Adaptive flags lines")
    assertEqual(PrefLabels.humanise("mode"), "Mode")
}

test("grupos conhecidos têm rótulo curado") {
    assertEqual(PrefLabels.group("review").title, "Revisão de código")
    assertEqual(PrefLabels.group("tier_models").title, "Modelos por tier")
    assertFalse(PrefLabels.group("review").blurb.isEmpty, "grupo curado deve explicar-se")
}

test("grupo desconhecido cai na humanização, não quebra") {
    // The schema keeps growing; a new group must render sanely with no edit here.
    assertEqual(PrefLabels.group("nova_secao_qualquer").title, "Nova secao qualquer")
}

test("duração vira legível") {
    assertEqual(PrefLabels.duration(ms: 1_800_000), "30 min")
    assertEqual(PrefLabels.duration(ms: 2000), "2s")
    assertEqual(PrefLabels.duration(ms: 3_600_000), "1h")
    assertEqual(PrefLabels.duration(ms: 500), "500 ms")
}

test("humanValue usa o sufixo da chave como unidade") {
    assertEqual(PrefLabels.humanValue(key: "gate_timeout_ms", value: .number(1_800_000)), "30 min")
    assertEqual(PrefLabels.humanValue(key: "adaptive_flags_lines", value: .number(40)), "40 linhas")
    // Thresholds appear both as fraction and percentage in this schema.
    assertEqual(PrefLabels.humanValue(key: "warning_threshold", value: .number(0.35)), "35%")
    assertEqual(PrefLabels.humanValue(key: "handoff_threshold", value: .number(90)), "90%")
}

test("humanValue não inventa unidade onde não há") {
    assertTrue(PrefLabels.humanValue(key: "mode", value: .string("advisory")) == nil)
    assertTrue(PrefLabels.humanValue(key: "rounds", value: .number(1)) == nil)
}

test("união escalar não vira número") {
    // compact_after is integer OR "unlimited"; treating it as a number showed 0
    // on screen and would have destroyed the sentinel on save.
    assertEqual(PrefKind.from(types: ["integer", "string"], hasEnum: false, itemsAreStrings: false),
                .scalarUnion)
}

test("scalar preserva sentinela e número") {
    assertEqual(PrefsEdit.scalar(from: "unlimited", allowsNumber: true), .string("unlimited"))
    assertEqual(PrefsEdit.scalar(from: "12", allowsNumber: true), .number(12))
    assertEqual(PrefsEdit.scalar(from: " 8 ", allowsNumber: true), .number(8))
    // Not a bare number → stays a string rather than becoming a lossy 5.
    assertEqual(PrefsEdit.scalar(from: "5x", allowsNumber: true), .string("5x"))
}

test("humanise não inverte a ordem das palavras") {
    // The Portuguese translation of single words produced "Automático commit".
    assertEqual(PrefLabels.humanise("auto_commit"), "Auto commit")
    assertEqual(PrefLabels.humanise("compact_after"), "Compact after")
}

print("\nModelChain (escalar OU cadeia — as duas formas são válidas no arquivo)")

test("lê as duas formas do disco") {
    assertEqual(ModelChain.from(.string("claude-opus-5")), .single("claude-opus-5"))
    assertEqual(ModelChain.from(.array([.string("a"), .string("b")])), .chain(["a", "b"]))
    assertTrue(ModelChain.from(.number(1)) == nil, "forma desconhecida não vira cadeia")
}

test("um item volta como escalar, vários como lista") {
    // Round-tripping a scalar into a one-item array would rewrite a file the
    // user authored by hand, for no gain.
    assertEqual(ModelChain.single("x").toValue(), .string("x"))
    assertEqual(ModelChain.chain(["x"]).toValue(), .string("x"))
    assertEqual(ModelChain.chain(["x", "y"]).toValue(), .array([.string("x"), .string("y")]))
}

test("entradas vazias são descartadas ao gravar") {
    assertEqual(ModelChain.chain(["x", "  ", "y"]).toValue(),
                .array([.string("x"), .string("y")]))
}

test("editar a cadeia") {
    let c = ModelChain.chain(["a", "b", "c"])
    assertEqual(c.replacing(at: 1, with: "z").ids, ["a", "z", "c"])
    assertEqual(c.removing(at: 0).ids, ["b", "c"])
    assertEqual(c.moved(from: 2, to: 0).ids, ["c", "a", "b"])
    assertEqual(c.appending("d").ids, ["a", "b", "c", "d"])
}

test("nunca remove o último modelo") {
    // An empty tier has no meaning — the engine would have nothing to dispatch.
    assertEqual(ModelChain.single("a").removing(at: 0).ids, ["a"])
}

test("índice inválido não corrompe a cadeia") {
    let c = ModelChain.chain(["a", "b"])
    assertEqual(c.replacing(at: 9, with: "z").ids, ["a", "b"])
    assertEqual(c.moved(from: 0, to: 9).ids, ["a", "b"])
}

print("\nRoutingReader (achata domain → phase → tier → cadeia)")

test("achata a estrutura aninhada") {
    let routing = JSONValue.object([
        "backend": .object([
            "executor": .object([
                "standard": .array([.string("gpt-5"), .string("claude-sonnet-5")]),
            ]),
        ]),
    ])
    let rows = RoutingReader.rows(from: routing)
    assertEqual(rows.count, 1)
    assertEqual(rows[0].domain, "backend")
    assertEqual(rows[0].phase, "executor")
    assertEqual(rows[0].tier, "standard")
    assertEqual(rows[0].chain, ["gpt-5", "claude-sonnet-5"])
}

test("aceita cadeia escalar e ignora o que não entende") {
    let routing = JSONValue.object([
        "default": .object([
            "planner": .object([
                "heavy": .string("claude-opus-5"),
                "vazio": .array([]),
            ]),
        ]),
        "lixo": .string("não é objeto"),
    ])
    let rows = RoutingReader.rows(from: routing)
    assertEqual(rows.count, 1)
    assertEqual(rows[0].chain, ["claude-opus-5"])
}

test("routing ausente devolve vazio") {
    assertEqual(RoutingReader.rows(from: nil).count, 0)
    assertEqual(RoutingReader.rows(from: .object([:])).count, 0)
}

print("\nClosedSets")

test("dashboard_refresh_on tem vocabulário fechado") {
    assertEqual(ClosedSets.options(forLeaf: "dashboard_refresh_on") ?? [],
                ["boot", "exit", "phase_change"])
    assertTrue(ClosedSets.options(forLeaf: "ignore_list") == nil,
               "lista aberta não pode virar checkbox")
}

print("\nProjectOrganiser (21 projetos aninhados não cabem numa lista plana)")

let sample = [
    "/h/Development",
    "/h/Development/message",
    "/h/Development/lookchina",
    "/h/Development/lookchina/services",
    "/h/Development/lookchina/services/asgard",
    "/h/Development/lookchina/services/loki",
    "/h/Development/lookchina/apps/odin",
]

test("agrupa pelo diretório pai") {
    let g = ProjectOrganiser.groups(sample, home: "/h")
    let titles = g.map(\.title)
    assertTrue(titles.contains("~/Development"), "faltou ~/Development: \(titles)")
    assertTrue(titles.contains("~/Development/lookchina/services"), "faltou services")
    let services = g.first { $0.title == "~/Development/lookchina/services" }!
    assertEqual(services.projects.map(ProjectOrganiser.name), ["asgard", "loki"])
}

test("grupos saem em ordem estável de caminho") {
    let a = ProjectOrganiser.groups(sample, home: "/h").map(\.path)
    let b = ProjectOrganiser.groups(sample.reversed(), home: "/h").map(\.path)
    assertEqual(a, b, "ordem não pode depender da ordem de entrada")
    assertEqual(a, a.sorted(), "pais ordenados por caminho")
}

test("detecta projeto que contém outros") {
    // A stray .gsd/ at the top of a code folder swallows everything below it,
    // and from a flat list that is invisible.
    let c = ProjectOrganiser.containment(sample)
    assertEqual(c["/h/Development"], 6, "Development contém todos os outros")
    assertEqual(c["/h/Development/lookchina"], 4)
    assertTrue(c["/h/Development/message"] == nil, "folha não contém nada")
}

test("prefixo parcial não conta como contido") {
    // "/h/Dev" must not swallow "/h/Development".
    let c = ProjectOrganiser.containment(["/h/Dev", "/h/Development"])
    assertTrue(c["/h/Dev"] == nil, "prefixo de string não é contenção de caminho")
}

test("container devolve o pai mais próximo") {
    let owner = ProjectOrganiser.container(of: "/h/Development/lookchina/services/asgard",
                                           in: sample)
    assertEqual(owner, "/h/Development/lookchina/services",
                "o mais próximo, não o mais alto")
    assertTrue(ProjectOrganiser.container(of: "/h/Development", in: sample) == nil)
}

test("abbreviate encurta o home") {
    assertEqual(ProjectOrganiser.abbreviate("/h/Development", home: "/h"), "~/Development")
    assertEqual(ProjectOrganiser.abbreviate("/outro/x", home: "/h"), "/outro/x")
}

print("\nStatusModels (o modelo antigo lia o JSON errado, em silêncio)")

test("decodifica o payload real do forge-status") {
    // Shape taken verbatim from the engine: progress is an OBJECT and the slice
    // key is active_slice — the previous model declared a String and `slice`,
    // so both silently decoded to nil.
    let json = """
    {"cwd":"/p","runs":{"active":[{"id":"M-1","kind":"milestone","phase":"plan-slice",
     "heartbeat_age_ms":441136,"stale":false,"isolation_mode":"worktree"}],"focused":"M-1"},
     "milestone":{"id":"M-1","title":"M-1","phase":"plan-slice","active_slice":"S14",
     "active_task":"—","auto_mode":"on","next_action":"plan-slice S14 — SKU fiscal",
     "progress":{"done":13,"total":28},
     "slices":[{"id":"S01","title":"Link vivo","checked":true,"risk":"high","status":"done",
       "tasks":[{"id":"T01","title":"Baseline** — `depends:[]`","checked":true,"status":"done"}]}]},
     "autonomous_tasks":[],"warnings":[]}
    """
    let p = try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    assertEqual(p.milestone?.progress?.done, 13)
    assertEqual(p.milestone?.progress?.total, 28)
    assertEqual(p.milestone?.progress?.percent, 46)
    assertEqual(p.milestone?.active_slice, "S14")
    assertEqual(p.runs?.active?.first?.phase, "plan-slice")
    assertEqual(p.runs?.active?.first?.isolation_mode, "worktree")
    assertEqual(p.milestone?.slices?.first?.isDone, true)
    assertEqual(p.milestone?.slices?.first?.isHighRisk, true)
}

test("progresso não divide por zero antes do planejamento") {
    let p = MilestoneStatus.Progress(done: 0, total: 0)
    assertEqual(p.fraction, 0)
    assertEqual(p.percent, 0)
}

test("progresso satura em 100%") {
    assertEqual(MilestoneStatus.Progress(done: 30, total: 28).percent, 100)
}

test("título repetido do id não é mostrado") {
    // The engine repeats the id as title when the milestone has no human name;
    // showing it twice is noise.
    let json = "{\"id\":\"M-1\",\"title\":\"M-1\"}"
    let m = try! JSONDecoder().decode(MilestoneStatus.self, from: Data(json.utf8))
    assertTrue(m.displayTitle == nil)
}

test("título de task perde a metadata do plano") {
    let json = "{\"id\":\"T02\",\"title\":\"Backend — mint do token** — `depends:[T01]` `domain:backend`\"}"
    let t = try! JSONDecoder().decode(TaskStatus.self, from: Data(json.utf8))
    assertEqual(t.cleanTitle, "Backend — mint do token")
}

test("contagem de tasks por slice") {
    let json = """
    {"id":"S02","tasks":[{"id":"T01","status":"done"},{"id":"T02","status":"pending"},
                          {"id":"T03","checked":true}]}
    """
    let sl = try! JSONDecoder().decode(SliceStatus.self, from: Data(json.utf8))
    assertEqual(sl.doneTasks, 2)
    assertEqual(sl.totalTasks, 3)
}

print("\nChangelogParser + Version")

test("parseia versões, seções e bullets") {
    let md = """
    ## Unreleased — Cost-aware dispatch

    ### Added

    - Prompts determinísticos com budget.
    - Telemetria por chamada.

    ### Fixed

    - **Perda silenciosa de dados.** `forge-state.js` truncava a seção
      até a primeira linha, apagando o histórico.

    ---

    ## v2.10.0 — Roteamento

    ### Changed

    - Modelo resolvido por tier.
    """
    let r = ChangelogParser.parse(md)
    assertEqual(r.count, 2)
    assertEqual(r[0].version, "Unreleased")
    assertEqual(r[0].headline, "Cost-aware dispatch")
    assertTrue(r[0].isUnreleased)
    assertEqual(r[0].sections.count, 2)
    assertEqual(r[0].sections[0].kind, .added)
    assertEqual(r[0].sections[0].entries.count, 2)
    assertEqual(r[1].version, "v2.10.0")
}

test("bullet quebrado em várias linhas vira uma entrada") {
    let md = """
    ## v1.0.0 — x

    ### Fixed

    - Primeira linha
      continuação da mesma entrada.
    - Outra entrada.
    """
    let sec = ChangelogParser.parse(md)[0].sections[0]
    assertEqual(sec.entries.count, 2)
    assertTrue(sec.entries[0].contains("continuação"), "linhas juntadas: \(sec.entries[0])")
}

test("markdown é preservado para renderização") {
    // The notes lead with a bold sentence carrying the point of the item;
    // stripping it threw away the only hierarchy the entries have.
    let md = """
    ## v1.0.0 — x

    ### Fixed

    - **Perda de dados.** roda `forge-state.js` agora
    """
    let e = ChangelogParser.parse(md)[0].sections[0].entries[0]
    assertTrue(e.contains("**"), "negrito preservado: \(e)")
    assertTrue(e.contains("`"), "code preservado")
}

test("plain remove markdown para onde não dá para renderizar") {
    assertEqual(ChangelogParser.plain("**Bold.** roda `forge-state.js` agora"),
                "Bold. roda forge-state.js agora")
}

test("separa a frase-título do resto") {
    let split = "**Perda de dados.** o parser truncava a seção".changelogLead
    assertEqual(split?.lead, "Perda de dados.")
    assertEqual(split?.rest, "o parser truncava a seção")
    assertTrue("sem negrito no início".changelogLead == nil)
    assertTrue("**".changelogLead == nil, "negrito vazio não conta")
}

test("seção desconhecida cai em Outros") {
    assertEqual(ReleaseSection.Kind.from("Deprecated"), .other)
    assertEqual(ReleaseSection.Kind.from("Fixed"), .fixed)
}

test("changelog vazio não quebra") {
    assertEqual(ChangelogParser.parse("").count, 0)
    assertEqual(ChangelogParser.parse("texto solto sem cabeçalho").count, 0)
}

test("comparação de versão é semântica, não alfabética") {
    // The case that matters as a project ages: a string compare puts v2.9.0
    // above v2.11.0 and would tell you to downgrade.
    assertTrue(Version.isNewer("v2.11.0", than: "v2.9.0"))
    assertFalse(Version.isNewer("v2.9.0", than: "v2.11.0"))
    assertTrue(Version.isNewer("2.11.1", than: "v2.11.0"))
    assertFalse(Version.isNewer("v2.11.0", than: "v2.11.0"))
    assertTrue(Version.isNewer("v3.0.0", than: "v2.99.99"))
}

test("sufixo de pré-release é ignorado na comparação") {
    assertEqual(Version.components("v2.1.0-beta.1"), [2, 1, 0])
    assertFalse(Version.isNewer("v2.1.0-beta.1", than: "v2.1.0"))
}


print("\n" + String(repeating: "─", count: 60))
print("  \(passed) passed, \(failed) failed")
if failed > 0 {
    print("\nFalhas:")
    for f in failures { print("  ✗ \(f.0)\n      \(f.1)") }
}
print("")
exit(failed > 0 ? 1 : 0)
