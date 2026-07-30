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
func assertLessOrEqual<T: Comparable>(_ a: T, _ b: T, _ msg: String = "") {
    if !(a <= b) {
        let m = "\(msg)\n     esperado <= \(b)\n     obtido:    \(a)"
        failures.append((current, m)); failed += 1; print("  ✗ \(current)\n      \(m)")
    }
}
func assertNil<T>(_ v: T?, _ msg: String = "esperado nil") {
    if v != nil {
        let m = "\(msg)\n     obtido: \(String(describing: v))"
        failures.append((current, m)); failed += 1; print("  ✗ \(current)\n      \(m)")
    }
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

print("\nModelCatalog (o input livre virou picker — typo só falhava em runtime)")

test("família reconhecida pelo id, incluindo sufixo [1m]") {
    assertEqual(ModelCatalog.family(of: "claude-opus-4-8[1m]"), .opus)
    assertEqual(ModelCatalog.family(of: "claude-haiku-4-5-20251001"), .haiku)
    assertEqual(ModelCatalog.family(of: "claude-fable-5"), .fable)
    assertEqual(ModelCatalog.family(of: "gpt-5-codex"), .gpt)
    assertEqual(ModelCatalog.family(of: "Gemini 3.1 Pro (High)"), .gemini)
    assertEqual(ModelCatalog.family(of: "modelo-desconhecido"), .unknown)
}

test("fable vem antes de opus na detecção") {
    // Substring order matters: both ids contain "claude-", and a fable id must
    // not be classified by a later opus check.
    assertEqual(ModelCatalog.family(of: "claude-fable-5"), .fable)
}

test("sugestões por engine") {
    assertEqual(ModelCatalog.suggestions(for: .claude).count, ModelCatalog.known.count)
    assertTrue(ModelCatalog.suggestions(for: .gemini).contains { $0.id.contains("Gemini") })
    assertTrue(ModelCatalog.suggestions(for: .codex).contains { $0.id == "gpt-5" })
}

test("engine sabe qual binário precisa estar no PATH") {
    assertEqual(ModelEngine.gemini.binary, "agy")
    assertEqual(ModelEngine.codex.binary, "codex")
    assertEqual(ModelEngine.claude.binary, "claude")
}

test("isKnown cobre os catálogos externos") {
    assertTrue(ModelCatalog.isKnown("claude-opus-5"))
    assertTrue(ModelCatalog.isKnown("Gemini 3.1 Pro (High)"))
    assertFalse(ModelCatalog.isKnown("claude-opus-6"), "id inexistente deve ser sinalizado")
}

test("label cai no id quando não catalogado") {
    assertEqual(ModelCatalog.label(for: "claude-opus-5"), "Opus 5")
    assertEqual(ModelCatalog.label(for: "modelo-novo"), "modelo-novo")
}

print("\nMetricsEngine (events.jsonl já acumulava isso — ninguém lia)")

let sampleEvents = """
{"ts":"2026-07-29T02:16:45Z","event":"dispatch","unit":"execute-task/T02","model":"gpt-5.6-luna","engine":"codex","domain":"backend","slice":"S14","input_tokens":4988,"output_tokens":1869}
{"ts":"2026-07-29T02:20:00Z","event":"dispatch","unit":"execute-task/T03","model":"claude-opus-5","engine":"claude","domain":"frontend","slice":"S14","input_tokens":1000000,"output_tokens":100000}
{"ts":"2026-07-29T02:22:00Z","event":"review","slice":"S14"}
{"ts":"2026-07-29T02:23:00Z","event":"retry","attempts":2}
linha quebrada sem json
{"ts":"2026-07-29T02:24:00Z","event":"dispatch","unit":"plan-slice/S15","model":"claude-opus-5","engine":"claude","input_tokens":2000,"output_tokens":500}
"""

test("parseia dispatches e ignora linha corrompida") {
    // The file is appended to by a live process, so the last line can be torn.
    let (d, e) = MetricsEngine.parse(sampleEvents)
    assertEqual(d.count, 3)
    assertEqual(e["review"], 1)
    assertEqual(e["retry"], 1)
    assertEqual(d[0].engine, "codex")
    assertEqual(d[0].totalTokens, 6857)
}

test("unitType descarta o id da unidade") {
    let (d, _) = MetricsEngine.parse(sampleEvents)
    assertEqual(d[0].unitType, "execute-task")
    assertEqual(d[2].unitType, "plan-slice")
}

test("custo usa a tabela por família") {
    // Opus 5: $5/MTok in, $25/MTok out → 1M in + 100k out = 5 + 2.5
    let c = Pricing.cost(model: "claude-opus-5", input: 1_000_000, output: 100_000)
    assertEqual(c ?? 0, 7.5)
}

test("modelo sem preço não inventa custo") {
    // Inventing a number for an externally-billed engine would make the total
    // look authoritative when it is not.
    assertTrue(Pricing.cost(model: "gpt-5.6-luna", input: 1000, output: 1000) == nil)
}

test("resumo marca custo incompleto quando há modelo sem preço") {
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let s = MetricsEngine.summarise(d, events: e)
    assertEqual(s.dispatches, 3)
    assertTrue(s.costIncomplete, "codex não tem preço na tabela")
    // Only the two Claude dispatches contribute to cost.
    assertTrue(s.cost > 7.5 && s.cost < 7.6, "custo: \(s.cost)")
}

test("agrupa por modelo, engine, unidade e domínio") {
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let s = MetricsEngine.summarise(d, events: e)
    assertEqual(s.byEngine.count, 2)
    assertEqual(s.byUnit.count, 2)
    assertEqual(s.byDomain.count, 2)
    // Sorted by spend: the Claude bucket outranks the unpriced codex one.
    assertEqual(s.byEngine[0].key, "claude")
}

test("filtro por data corta o histórico") {
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let iso = ISO8601DateFormatter()
    let cut = iso.date(from: "2026-07-29T02:21:00Z")!
    let s = MetricsEngine.summarise(d, events: e, since: cut)
    assertEqual(s.dispatches, 1, "só o dispatch das 02:24")
}

test("share de output explica a conta melhor que o total") {
    // Output costs 5x input across the table.
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let s = MetricsEngine.summarise(d, events: e)
    assertTrue(s.outputShare > 0 && s.outputShare < 1)
}

test("formatação de tokens e dinheiro") {
    assertEqual(MetricsEngine.tokens(999), "999")
    assertEqual(MetricsEngine.tokens(4988), "5.0k")
    assertEqual(MetricsEngine.tokens(1_250_000), "1.25M")
    assertEqual(MetricsEngine.money(0.004), "<$0,01")
    assertEqual(MetricsEngine.money(7.5), "$7.50")
}

test("arquivo vazio não quebra") {
    let (d, e) = MetricsEngine.parse("")
    assertEqual(d.count, 0)
    assertEqual(e.count, 0)
    assertEqual(MetricsEngine.summarise(d).dispatches, 0)
}

print("\nComposerParser (autocomplete estilo Claude Code)")

func ctx(_ text: String, caretAtEnd: Bool = true) -> CompletionContext {
    ComposerParser.context(in: text, caret: text.endIndex)
}

test("/ no início abre comandos") {
    let c = ctx("/forge-au")
    assertEqual(c, .command(query: "forge-au",
                            range: "/forge-au".startIndex..<"/forge-au".endIndex))
}

test("@ abre projetos") {
    if case .project(let q, _) = ctx("@mess") { assertEqual(q, "mess") }
    else { assertTrue(false, "esperava contexto de projeto") }
}

test("gatilho depois de espaço também vale") {
    if case .command(let q, _) = ctx("olha /forge-st") { assertEqual(q, "forge-st") }
    else { assertTrue(false, "esperava comando após espaço") }
}

test("barra no meio de uma palavra NÃO abre menu") {
    // Otherwise every path and URL would pop a menu mid-sentence.
    assertEqual(ctx("veja src/main"), .none)
    assertEqual(ctx("email a@b"), .none)
}

test("espaço encerra o token") {
    assertEqual(ctx("/forge-task corrigir"), .none)
}

test("filtro põe prefixo antes de substring") {
    let cmds = [
        SlashCommand(name: "forge-accounts", description: "", source: .skill),
        SlashCommand(name: "forge-auto", description: "", source: .skill),
        SlashCommand(name: "auto-outro", description: "", source: .skill),
    ]
    let r = ComposerParser.filter(cmds, query: "forge-au")
    assertEqual(r.first?.name, "forge-auto")
}

test("completar substitui o token e devolve o caret") {
    let text = "/forge-au"
    guard case .command(_, let range) = ctx(text) else {
        assertTrue(false, "sem contexto"); return
    }
    let (out, caret) = ComposerParser.complete(text, range: range, with: "/forge-auto")
    assertEqual(out, "/forge-auto ")
    assertEqual(caret, 12)
}

test("split separa comando do resto") {
    let a = ComposerParser.split("/forge-task corrigir o retry")
    assertEqual(a.command, "forge-task")
    assertEqual(a.rest, "corrigir o retry")

    let b = ComposerParser.split("apenas uma conversa")
    assertTrue(b.command == nil)
    assertEqual(b.rest, "apenas uma conversa")

    let c = ComposerParser.split("/forge-status")
    assertEqual(c.command, "forge-status")
    assertEqual(c.rest, "")
}

print("\nCommandCatalog")

test("lê name e description do frontmatter") {
    let md = """
    ---
    name: forge-auto
    description: "Executa o milestone inteiro."
    allowed-tools: Read, Write
    ---

    # corpo
    description: isto não deve ser lido
    """
    assertEqual(CommandCatalog.frontmatter(md, key: "name"), "forge-auto")
    assertEqual(CommandCatalog.frontmatter(md, key: "description"),
                "Executa o milestone inteiro.")
}

test("sem frontmatter devolve nil em vez de ler o corpo") {
    assertTrue(CommandCatalog.frontmatter("# só markdown\nname: x", key: "name") == nil)
}

test("catálogo real da máquina tem comandos do forge") {
    // Reads what is installed, not a list baked into the app.
    let all = CommandCatalog.load()
    assertTrue(all.contains { $0.name.hasPrefix("forge") },
               "esperava comandos forge instalados; achei \(all.count)")
}

test("maxTokens usa o maior, não o primeiro") {
    // Buckets are ordered by spend, so a cheap high-volume model sits below a
    // pricey low-volume one — scaling against first() rendered a bar at 297%.
    var fable = MetricsBucket(key: "claude-fable-5")
    fable.cost = 70.51; fable.inputTokens = 1_420_000
    var sonnet = MetricsBucket(key: "claude-sonnet-5")
    sonnet.cost = 62.64; sonnet.inputTokens = 4_220_000

    let ordered = [fable, sonnet]   // sorted by cost, not tokens
    assertEqual(MetricsEngine.maxTokens(ordered), 4_220_000)
    assertEqual(MetricsEngine.fraction(sonnet.totalTokens,
                                       of: MetricsEngine.maxTokens(ordered)), 1.0)
}

test("fração nunca passa de 1 nem fica negativa") {
    assertEqual(MetricsEngine.fraction(500, of: 100), 1.0)
    assertEqual(MetricsEngine.fraction(-5, of: 100), 0.0)
    assertEqual(MetricsEngine.fraction(10, of: 0), 0.0, "sem denominador não desenha")
}


print("\nWorkspaceDefaults")

test("pref explícito vence o último usado") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: "/repo/a", lastUsed: "/repo/b", known: ["/repo/a", "/repo/b"])
    assertEqual(p.workspace, "/repo/a")
    assertEqual(p.reason, .pref)
    assertTrue(p.warning == nil, "pref registrado não deve gerar aviso")
}

test("último usado é o segundo default") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: nil, lastUsed: "/repo/b", known: ["/repo/a", "/repo/b"])
    assertEqual(p.workspace, "/repo/b")
    assertEqual(p.reason, .lastUsed)
    assertTrue(p.warning == nil)
}

test("sem pref e sem último usado não resolve nada") {
    // The b992edf regression test: `known` has two projects, but with no
    // pref and no last-used, nothing must be preselected — `known.first`
    // is never consulted.
    let p = WorkspaceDefaults.preselect(
        configuredDefault: nil, lastUsed: nil, known: ["/repo/a", "/repo/b"])
    assertTrue(p.workspace == nil, "sem configuração nenhuma, workspace deve ser nil")
    assertEqual(p.reason, .none)
}

test("último usado que saiu da lista não vira outro projeto") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: nil, lastUsed: "/repo/removido", known: ["/repo/a", "/repo/b"])
    assertTrue(p.workspace == nil, "last-used stale não deve substituir por outro projeto")
    assertEqual(p.reason, .none)
}

test("pref fora da lista de projetos resolve com aviso") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: "/repo/fora", lastUsed: "/repo/a", known: ["/repo/a"])
    assertEqual(p.workspace, "/repo/fora")
    assertEqual(p.reason, .pref)
    assertTrue(p.warning != nil, "pref fora de known deve carregar aviso")
}

test("root dir expande ~ e cai no home quando vazio") {
    let alwaysExists: (String) -> Bool = { _ in true }
    assertEqual(WorkspaceDefaults.sessionRoot(configured: nil, home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "  ", home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "~", home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "~/code", home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x/code")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "/abs/path", home: "/Users/x", isDirectory: alwaysExists).path, "/abs/path")

    let nilCase = WorkspaceDefaults.sessionRoot(configured: nil, home: "/Users/x", isDirectory: alwaysExists)
    assertTrue(nilCase.warning == nil, "sem valor configurado não deve haver aviso")
}

// R1 fix (S04 review): a configured session root that does not resolve to an
// existing directory must fall back to $HOME with a visible warning, never
// silently open somewhere the "abre em …" caption does not describe.
test("root dir inexistente cai no home com aviso") {
    let neverExists: (String) -> Bool = { _ in false }
    let r = WorkspaceDefaults.sessionRoot(configured: "/repo/removido", home: "/Users/x", isDirectory: neverExists)
    assertEqual(r.path, "/Users/x")
    assertTrue(r.warning != nil, "diretório inexistente deve carregar aviso")
}

test("root dir existente é honrado sem aviso") {
    let alwaysExists: (String) -> Bool = { _ in true }
    let r = WorkspaceDefaults.sessionRoot(configured: "/repo/valido", home: "/Users/x", isDirectory: alwaysExists)
    assertEqual(r.path, "/repo/valido")
    assertTrue(r.warning == nil, "diretório existente não deve carregar aviso")
}

// Both preselect() and sessionRoot() are pure and Foundation-free at the
// call boundary above; the tests here are what pins the b992edf invariant
// down mechanically, so a future edit that reintroduces `known.first`
// breaks the build, not just the behaviour.

print("\nItems (board)")

test("colunas saem na ordem canônica") {
    let cols = ItemBoard.columns([])
    assertEqual(cols.map(\.status), [.inbox, .triaged, .doing, .done, .dropped])
    assertTrue(cols.allSatisfy { $0.items.isEmpty }, "colunas vazias devem existir mesmo sem itens")
}

test("rótulos pt-BR de cada status") {
    assertEqual(ItemStatus.inbox.label, "Entrada")
    assertEqual(ItemStatus.triaged.label, "Triado")
    assertEqual(ItemStatus.doing.label, "Fazendo")
    assertEqual(ItemStatus.done.label, "Feito")
    assertEqual(ItemStatus.dropped.label, "Descartado")
}

test("openCount ignora done e dropped") {
    let items = [
        Item(id: "I-1", status: "inbox"),
        Item(id: "I-2", status: "triaged"),
        Item(id: "I-3", status: "doing"),
        Item(id: "I-4", status: "done"),
        Item(id: "I-5", status: "dropped"),
    ]
    assertEqual(ItemBoard.openCount(items), 3)
}

test("status desconhecido não entra em coluna nenhuma e aparece em unknown") {
    let items = [
        Item(id: "I-1", status: "inbox"),
        Item(id: "I-2", status: "arquivado"),
        Item(id: "I-3", status: nil),
    ]
    let cols = ItemBoard.columns(items)
    assertEqual(cols.flatMap(\.items).count, 1, "só o item conhecido entra em alguma coluna")
    let unk = ItemBoard.unknown(items)
    assertEqual(unk.count, 2)
    assertTrue(unk.contains { $0.id == "I-2" })
    assertTrue(unk.contains { $0.id == "I-3" })
}

test("LoadGeneration descarta resultado de uma geração anterior") {
    var gen = LoadGeneration()
    let genA = gen.start()   // load A começa
    let genB = gen.start()   // usuário troca de projeto antes de A terminar
    assertTrue(!gen.isCurrent(genA), "A não é mais a geração atual — resultado de A deve ser descartado")
    assertTrue(gen.isCurrent(genB), "B é a geração atual — resultado de B deve ser aplicado")
}

test("LoadGeneration aceita a geração mais recente mesmo sem concorrência") {
    var gen = LoadGeneration()
    let only = gen.start()
    assertTrue(gen.isCurrent(only), "única geração iniciada deve ser sempre a atual")
}

test("decodifica um item real da saída do engine") {
    // Copiado verbatim de `node scripts/forge-items.js --list --json`.
    let json = """
    {"id":"I-20260729145851-test-title","title":"Test title","status":"inbox",
     "origin":"human","created":"2026-07-29T14:58:51.237Z",
     "updated":"2026-07-29T14:58:51.237Z","body":"Some body text"}
    """
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertEqual(item.id, "I-20260729145851-test-title")
    assertEqual(item.title, "Test title")
    assertEqual(item.status, "inbox")
    assertEqual(item.parsedStatus, .inbox)
    assertEqual(item.origin, "human")
    assertEqual(item.body, "Some body text")
}

test("item sem campos opcionais decodifica") {
    let json = "{\"id\":\"I-20260729000000-bare\"}"
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertEqual(item.id, "I-20260729000000-bare")
    assertTrue(item.title == nil)
    assertTrue(item.parsedStatus == nil)
}

print("\nNodeLocator (descoberta de node fora dos três caminhos fixos)")

// Fake probe: the filesystem is a set of executable paths and a directory map,
// so the search order is exercised without depending on what this machine has
// installed. `pathVar` defaults to launchd's minimal PATH — the exact
// environment a GUI app inherits from Finder, where the old `/usr/bin/env node`
// fallback died with "env: node: No such file or directory".
let launchdPath = "/usr/bin:/bin:/usr/sbin:/sbin"

func fakeProbe(home: String = "/Users/tester",
               executables: Set<String> = [],
               dirs: [String: [String]] = [:],
               files: [String: String] = [:],
               envOverride: String? = nil,
               prefValue: String? = nil,
               pathVar: String = launchdPath,
               shell: @escaping () -> String? = { nil }) -> NodeLocator.Probe {
    NodeLocator.Probe(
        home: home,
        envOverride: envOverride,
        prefValue: prefValue,
        pathVar: pathVar,
        isExecutable: { executables.contains($0) },
        listDir: { dirs[$0] ?? [] },
        readFile: { files[$0] },
        loginShell: shell)
}

test("encontra node do nvm sem versão hardcoded (árvore sintética)") {
    let home = "/Users/tester"
    let root = "\(home)/.nvm/versions/node"
    let probe = fakeProbe(
        home: home,
        executables: ["\(root)/v20.9.0/bin/node", "\(root)/v24.11.1/bin/node"],
        dirs: [root: ["v20.9.0", "v24.11.1"]])
    assertEqual(NodeLocator.resolve(probe).path, "\(root)/v24.11.1/bin/node",
                "deve escolher a maior versão instalada")
    assertEqual(NodeLocator.resolve(probe).source, NodeLocator.Source.versionManager)
}

test("nvm: alias/default vence a maior versão") {
    let home = "/Users/tester"
    let root = "\(home)/.nvm/versions/node"
    let probe = fakeProbe(
        home: home,
        executables: ["\(root)/v20.9.0/bin/node", "\(root)/v24.11.1/bin/node"],
        dirs: [root: ["v20.9.0", "v24.11.1"]],
        files: ["\(home)/.nvm/alias/default": "v20.9.0\n"])
    assertEqual(NodeLocator.resolve(probe).path, "\(root)/v20.9.0/bin/node")
}

test("nvm: alias parcial (\"20\") resolve para a maior v20.x") {
    let home = "/Users/tester"
    let root = "\(home)/.nvm/versions/node"
    let probe = fakeProbe(
        home: home,
        executables: ["\(root)/v20.9.0/bin/node", "\(root)/v20.11.0/bin/node",
                      "\(root)/v24.11.1/bin/node"],
        dirs: [root: ["v20.9.0", "v20.11.0", "v24.11.1"]],
        files: ["\(home)/.nvm/alias/default": "20"])
    assertEqual(NodeLocator.resolve(probe).path, "\(root)/v20.11.0/bin/node")
}

test("ordenação de versões é numérica, não lexicográfica") {
    assertEqual(NodeLocator.highestVersion(["v9.11.2", "v10.0.0"]), "v10.0.0")
}

test("fnm, asdf, mise e volta também são encontrados") {
    let home = "/Users/tester"
    let cases: [(String, [String: [String]])] = [
        ("\(home)/.local/share/fnm/aliases/default/bin/node", [:]),
        ("\(home)/.asdf/shims/node", [:]),
        ("\(home)/.local/share/mise/shims/node", [:]),
        ("\(home)/.volta/bin/node", [:]),
        ("\(home)/.asdf/installs/nodejs/24.11.1/bin/node",
         ["\(home)/.asdf/installs/nodejs": ["24.11.1"]]),
    ]
    for (path, dirs) in cases {
        let r = NodeLocator.resolve(fakeProbe(home: home, executables: [path], dirs: dirs))
        assertEqual(r.path, path, "não encontrou \(path)")
    }
}

test("PATH mínimo do launchd NÃO produz /usr/bin/env silenciosamente") {
    // O bug original: sem nenhum node instalado nos caminhos fixos, o app
    // devolvia "/usr/bin/env" e a falha só aparecia no exec, como
    // `env: node: No such file or directory`.
    let outcome = NodeLocator.resolve(fakeProbe())
    switch outcome {
    case .found(let r):
        assertTrue(false, "não deveria resolver nada, obteve \(r.path)")
    case .notFound(let tried):
        assertFalse(tried.isEmpty, "o diagnóstico deve listar onde procurou")
        let msg = NodeLocator.notFoundMessage(tried: tried)
        assertTrue(msg.contains("FORGE_NODE_PATH"), "a mensagem deve nomear o override")
        assertTrue(msg.contains("node_path"), "a mensagem deve nomear a pref")
        assertFalse(msg.contains("No such file or directory"), "não é a mensagem do env")
    }
    assertTrue(outcome.path == nil, "nenhum caminho deve ser reportado")
    assertFalse("\(outcome)".contains("/usr/bin/env"), "/usr/bin/env nunca é resposta")
}

test("override do operador vence tudo") {
    let home = "/Users/tester"
    let probe = fakeProbe(home: home,
                          executables: ["/opt/homebrew/bin/node", "/custom/node"],
                          envOverride: "/custom/node")
    assertEqual(NodeLocator.resolve(probe).path, "/custom/node")
    assertEqual(NodeLocator.resolve(probe).source, NodeLocator.Source.envOverride)

    let prefProbe = fakeProbe(home: home,
                              executables: ["/opt/homebrew/bin/node", "/pref/node"],
                              prefValue: "/pref/node")
    assertEqual(NodeLocator.resolve(prefProbe).source, NodeLocator.Source.pref)
}

test("override quebrado é reportado, não contornado em silêncio") {
    // Contornar deixaria o operador sem sinal de que a config dele foi ignorada.
    let probe = fakeProbe(executables: ["/opt/homebrew/bin/node"], envOverride: "/nao/existe/node")
    let outcome = NodeLocator.resolve(probe)
    assertTrue(outcome.path == nil, "override inválido não deve cair no caminho fixo")
    if case .notFound(let tried) = outcome {
        assertTrue(tried.contains(where: { $0.contains("/nao/existe/node") }),
                   "o diagnóstico deve citar o valor inválido")
    }
}

test("caminhos fixos continuam valendo e vêm antes de gerenciadores") {
    let home = "/Users/tester"
    let nvm = "\(home)/.nvm/versions/node/v24.11.1/bin/node"
    let probe = fakeProbe(home: home,
                          executables: ["/opt/homebrew/bin/node", nvm],
                          dirs: ["\(home)/.nvm/versions/node": ["v24.11.1"]])
    assertEqual(NodeLocator.resolve(probe).path, "/opt/homebrew/bin/node")
    assertEqual(NodeLocator.resolve(probe).source, NodeLocator.Source.fixed)
}

test("$PATH e shell de login servem de rede de segurança") {
    let onPath = NodeLocator.resolve(fakeProbe(executables: ["/opt/tools/bin/node"],
                                               pathVar: "/opt/tools/bin:/usr/bin"))
    assertEqual(onPath.path, "/opt/tools/bin/node")
    assertEqual(onPath.source, NodeLocator.Source.pathScan)

    let viaShell = NodeLocator.resolve(fakeProbe(executables: ["/from/shell/node"],
                                                 shell: { "/from/shell/node\n" }))
    assertEqual(viaShell.path, "/from/shell/node")
    assertEqual(viaShell.source, NodeLocator.Source.loginShell)

    // Resposta do shell apontando para nada não é aceita.
    let bogus = NodeLocator.resolve(fakeProbe(shell: { "/nao/existe/node" }))
    assertTrue(bogus.path == nil)
}

test("systemProbe encontra nvm numa árvore real em disco (não a desta máquina)") {
    // O teste acima usa um filesystem falso; este exercita os closures reais
    // (contentsOfDirectory / isExecutableFile) contra um $HOME sintético, que é
    // onde um erro de layout apareceria.
    let fm = FileManager.default
    let home = NSTemporaryDirectory() + "forge-node-\(UUID().uuidString.prefix(8))"
    defer { try? fm.removeItem(atPath: home) }
    for v in ["v18.20.4", "v24.11.1"] {
        let bin = "\(home)/.nvm/versions/node/\(v)/bin"
        try fm.createDirectory(atPath: bin, withIntermediateDirectories: true)
        try "#!/bin/sh\necho \(v)\n".write(toFile: "\(bin)/node", atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: "\(bin)/node")
    }
    // PATH mínimo do launchd + $SHELL ausente: só o nvm pode responder.
    let probe = NodeLocator.systemProbe(environment: ["PATH": launchdPath],
                                        home: home, prefValue: nil, shellTimeout: 1)
    let outcome = NodeLocator.resolve(probe)
    assertEqual(outcome.path, "\(home)/.nvm/versions/node/v24.11.1/bin/node")
    assertEqual(outcome.source, NodeLocator.Source.versionManager)
}

test("systemProbe lê node_path das prefs e FORGE_NODE_PATH do ambiente") {
    let probe = NodeLocator.systemProbe(
        environment: ["FORGE_NODE_PATH": "/env/node", "PATH": launchdPath],
        home: "/Users/tester", prefValue: "/pref/node")
    assertEqual(probe.envOverride, "/env/node")
    assertEqual(probe.prefValue, "/pref/node")
    assertEqual(probe.pathVar, launchdPath)
}

test("node_path é lido do JSONC ignorando a linha comentada") {
    let jsonc = """
    {
      // "node_path": "/comentado/node",
      "node_path": "/real/node"
    }
    """
    assertEqual(PrefsLocator.parseString(jsonc, key: "node_path"), "/real/node")
}

// TerminalRegistry / TerminalLifecycle / TerminalFocus —
// terminals survive navigation and never replay the bootstrap.

print("\nTerminalRegistry (uma sessão, um terminal vivo)")

/// Stand-in for the AppKit terminal: counts how often it would have been
/// spawned, which is the whole thing under test.
final class FakeTerminal {
    let tag: String
    static var made = 0
    init(tag: String) { self.tag = tag; FakeTerminal.made += 1 }
}

test("adopt cria uma vez e devolve a mesma instância nas rebuilds seguintes") {
    FakeTerminal.made = 0
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()

    let first = registry.adopt(id) { FakeTerminal(tag: "a") }
    // Three more rebuilds: navegar pra fora e voltar, duas vezes.
    let second = registry.adopt(id) { FakeTerminal(tag: "b") }
    let third = registry.adopt(id) { FakeTerminal(tag: "c") }

    assertEqual(FakeTerminal.made, 1, "o processo foi criado mais de uma vez")
    assertTrue(first.isNew, "a primeira adoção deveria ser nova")
    assertFalse(second.isNew, "a segunda adoção não é nova")
    assertTrue(second.entry === first.entry, "devolveu outro terminal na volta")
    assertTrue(third.entry === first.entry, "devolveu outro terminal na volta")
    assertEqual(registry.count, 1)
}

test("sessões diferentes têm terminais diferentes, chaveados pelo id") {
    FakeTerminal.made = 0
    let registry = TerminalRegistry<FakeTerminal>()
    let a = UUID(), b = UUID()
    let ta = registry.adopt(a) { FakeTerminal(tag: "a") }.entry
    let tb = registry.adopt(b) { FakeTerminal(tag: "b") }.entry
    assertFalse(ta === tb, "duas sessões compartilharam um terminal")
    assertEqual(registry.count, 2)
    assertEqual(registry.entry(for: a)?.tag, "a")
    assertEqual(registry.entry(for: b)?.tag, "b")
}

test("claimBootstrap só concede uma vez — a primeira mensagem não é reenviada") {
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()
    registry.adopt(id) { FakeTerminal(tag: "a") }

    assertTrue(registry.claimBootstrap(for: id), "o primeiro envio deveria ser permitido")
    assertFalse(registry.claimBootstrap(for: id), "a volta reenviaria a primeira mensagem")
    assertFalse(registry.claimBootstrap(for: id))
    assertTrue(registry.hasBootstrapped(id))
}

test("claimBootstrap sobre id desconhecido é negado, não cria slot") {
    let registry = TerminalRegistry<FakeTerminal>()
    assertFalse(registry.claimBootstrap(for: UUID()))
    assertEqual(registry.count, 0)
}

test("discard devolve o terminal para o chamador encerrar e libera a chave") {
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()
    let made = registry.adopt(id) { FakeTerminal(tag: "a") }.entry
    let dropped = registry.discard(id)
    assertTrue(dropped === made, "discard devolveu outro objeto")
    assertEqual(registry.count, 0)
    assertTrue(registry.discard(id) == nil, "discard duplo deveria ser nil")
}

test("uma sessão reaberta depois do discard bootstrapa de novo") {
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()
    registry.adopt(id) { FakeTerminal(tag: "a") }
    assertTrue(registry.claimBootstrap(for: id))
    registry.discard(id)
    registry.adopt(id) { FakeTerminal(tag: "a2") }
    assertTrue(registry.claimBootstrap(for: id), "sessão nova não conseguiu bootstrapar")
}

print("\nTerminalLifecycle (sair da tela não é fechar a sessão)")

test("view desmontada mantém o processo vivo") {
    assertEqual(TerminalLifecycle.action(for: .viewDismantled), .keepAlive)
}

test("fechar a sessão encerra e descarta") {
    assertEqual(TerminalLifecycle.action(for: .sessionClosed), .terminateAndDiscard)
}

print("\nTerminalFocus (qual sessão a tela mostra)")

test("a seleção vale enquanto a sessão existir") {
    let a = UUID(), b = UUID()
    assertEqual(TerminalFocus.resolve(selection: b, among: [a, b]), b)
    assertEqual(TerminalFocus.resolve(selection: nil, among: [a, b]), a)
    assertEqual(TerminalFocus.resolve(selection: UUID(), among: [a, b]), a)
    assertTrue(TerminalFocus.resolve(selection: a, among: []) == nil)
}

test("fechar uma aba em segundo plano não move o foco") {
    let a = UUID(), b = UUID()
    assertEqual(TerminalFocus.afterClosing(b, selection: a, remaining: [a]), a)
}

test("fechar a aba visível cai na primeira restante") {
    let a = UUID(), b = UUID()
    assertEqual(TerminalFocus.afterClosing(a, selection: a, remaining: [b]), b)
    assertTrue(TerminalFocus.afterClosing(a, selection: a, remaining: []) == nil)
}

// UpdateCore — the installer's output, and when a relaunch is allowed.

print("\nAtualização — saída do instalador")

/// Classify one line with a fresh tracker.
func classify(_ line: String) -> InstallerLine {
    var t = InstallerPhaseTracker()
    return t.consume(line)
}

test("linha com marcador ▸ do build.sh é fase (a fase mais longa da atualização)") {
    assertEqual(classify("▸ Compilando (swift build, SwiftTerm)"),
                .phase("Compilando (swift build, SwiftTerm)"),
                "sem isso a barra fica travada durante minutos de swift build")
    assertEqual(InstallerLabels.label(for: "Compilando (swift build, SwiftTerm)"),
                "compilando o app")
}

test("linha com 2 espaços é fase; com 4 é detalhe") {
    assertEqual(classify("  Installing skills..."), .phase("Installing skills..."))
    assertEqual(classify("    forge-auto"), .detail("    forge-auto"))
}

test("saída crua do SwiftPM (sem indentação) é detalhe") {
    assertEqual(classify("[14/16] Compiling Forge Stores.swift"),
                .detail("[14/16] Compiling Forge Stores.swift"))
    assertEqual(classify("Build complete! (6.06s)"), .detail("Build complete! (6.06s)"))
}

test("o marcador vence a indentação — ✓ com sub-item ainda é fase") {
    assertEqual(classify("✓   hooks sincronizados em settings.json"),
                .phase("hooks sincronizados em settings.json"))
}

test("⚠ é fase, não detalhe") {
    assertEqual(classify("⚠ swift não encontrado"), .phase("swift não encontrado"))
}

test("linha vazia é detalhe vazio") {
    assertEqual(classify(""), .detail(""))
    assertEqual(classify("\n"), .detail(""))
}

test("\\r é removido antes de classificar") {
    assertEqual(classify("  Installing scripts...\r\n"), .phase("Installing scripts..."))
}

test("a linha de sucesso encerra e vira 'concluído'") {
    var t = InstallerPhaseTracker()
    assertEqual(t.consume("✓ Forge Agent instalado com sucesso!"), .finished("concluído"))
}

test("Próximos passos DEPOIS do sucesso é detalhe, não a última fase") {
    var t = InstallerPhaseTracker()
    _ = t.consume("✓ Forge Agent instalado com sucesso!")
    assertEqual(t.consume("  Próximos passos:"), .detail("  Próximos passos:"))
    assertEqual(t.consume("  Ajuda a qualquer momento:   /forge-help"),
                .detail("  Ajuda a qualquer momento:   /forge-help"),
                "o último rótulo não pode ser uma instrução de onboarding")
}

test("✓ Forge.app instalado em /Applications é fase legítima, antes do marco final") {
    var t = InstallerPhaseTracker()
    assertEqual(t.consume("✓ Forge.app instalado em /Applications"),
                .phase("Forge.app instalado em /Applications"))
    assertEqual(InstallerLabels.label(for: "Forge.app instalado em /Applications"),
                "app instalado")
}

print("\nAtualização — rótulos em PT")

test("as fases conhecidas ganham rótulo em português") {
    assertEqual(InstallerLabels.label(for: "Backup saved to ~/.claude.bak"), "fazendo backup")
    assertEqual(InstallerLabels.label(for: "Installing agents..."), "copiando agentes")
    assertEqual(InstallerLabels.label(for: "Installing dispatch templates..."),
                "copiando templates de dispatch")
    assertEqual(InstallerLabels.label(for: "Verificando disponibilidade de claude-opus-5..."),
                "verificando modelos")
    assertEqual(InstallerLabels.label(for: "Installing preferences..."), "instalando preferências")
    assertEqual(InstallerLabels.label(for: "MCPs globais (Tier 1 — zero-config)"),
                "configurando MCPs")
    assertEqual(InstallerLabels.label(for: "Building the macOS app..."), "compilando o app")
    assertEqual(InstallerLabels.label(for: "Instalando em /Applications"),
                "instalando em /Applications")
}

test("rótulo desconhecido degrada para a frase crua, sem parar a barra") {
    assertEqual(InstallerLabels.label(for: "Doing something brand new..."),
                "Doing something brand new...")
}

print("\nAtualização — relaunch e bundle")

test("só o exit 0 autoriza o relaunch") {
    assertTrue(UpdateOutcome.canRelaunch(exitCode: 0))
    assertFalse(UpdateOutcome.canRelaunch(exitCode: 1))
    assertFalse(UpdateOutcome.canRelaunch(exitCode: 128))
}

test("a mensagem de falha carrega o código e a cauda do log") {
    let msg = UpdateOutcome.failureMessage(
        exitCode: 1, lastLines: ["a", "", "b", "c", "d"])
    assertTrue(msg.contains("código 1"), "sem o código: \(msg)")
    assertTrue(msg.contains("d"), "sem a última linha: \(msg)")
    assertFalse(msg.contains("\na\n"), "levou mais de três linhas: \(msg)")
}

test("bundle canônico não gera aviso; um build de dev gera") {
    assertTrue(RelaunchTarget.divergenceNote(for: "/Applications/Forge.app") == nil)
    assertTrue(RelaunchTarget.divergenceNote(for: "/Applications/Forge.app/") == nil,
               "barra final não deveria contar como divergência")
    let note = RelaunchTarget.divergenceNote(for: "/Users/dev/forge-agent/app/build/Forge.app")
    assertTrue(note != nil, "um bundle fora de /Applications tem que avisar")
    assertTrue(note?.contains("/Users/dev/forge-agent/app/build/Forge.app") ?? false,
               "o aviso tem que dizer QUAL bundle vai reabrir")
}

print("\nAtualização — restauração de seção e pré-checagem do git")

test("SectionRestore devolve o raw válido e cai no fallback no resto") {
    let valid = ["Início", "Atualizações", "Terminal"]
    assertEqual(SectionRestore.resolve(rawValue: "Atualizações", valid: valid, fallback: "Início"),
                "Atualizações")
    assertEqual(SectionRestore.resolve(rawValue: nil, valid: valid, fallback: "Início"), "Início")
    assertEqual(SectionRestore.resolve(rawValue: "", valid: valid, fallback: "Início"), "Início")
    assertEqual(SectionRestore.resolve(rawValue: "Seção Renomeada", valid: valid, fallback: "Início"),
                "Início",
                "um label renomeado invalida a preferência gravada")
}

test("a pré-checagem distingue árvore suja de branch divergente") {
    assertTrue(UpdatePrecheck.evaluate(dirty: false, ahead: 0, pulls: true) == nil)
    assertEqual(UpdatePrecheck.evaluate(dirty: true, ahead: 0, pulls: true), .dirtyTree)
    assertEqual(UpdatePrecheck.evaluate(dirty: false, ahead: 2, pulls: true), .diverged)
    assertEqual(UpdatePrecheck.evaluate(dirty: true, ahead: 2, pulls: true), .dirtyTree,
                "sujo vence: é o caso mais perigoso de 'resolver' sozinho")
}

test("reinstalar nunca é bloqueado por estado de git") {
    assertTrue(UpdatePrecheck.evaluate(dirty: true, ahead: 3, pulls: false) == nil,
               "sem pull não existe o dano que a checagem previne — bloquear aqui "
               + "impediria a afordance exatamente na máquina que ela desbloqueia")
    assertEqual(UpdatePrecheck.evaluate(dirty: true, ahead: 0, pulls: true), .dirtyTree,
                "o caminho que puxa não mudou")
}

test("o comando de atualizar puxa antes de instalar, com --update e --with-app") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .update)
    assertTrue(cmd.contains("pull --ff-only"), "sem o pull: \(cmd)")
    assertTrue(cmd.contains("--update"), "sem --update: \(cmd)")
    assertTrue(cmd.contains("--with-app"),
               "sem --with-app o app atualizaria tudo menos ele mesmo: \(cmd)")
}

test("o comando de reinstalar não executa git nenhum") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .reinstall)
    assertTrue(cmd.contains("--update"), "sem --update: \(cmd)")
    assertTrue(cmd.contains("--with-app"),
               "sem --with-app o app reinstalaria tudo menos ele mesmo: \(cmd)")
    assertFalse(cmd.contains("git"), "a reinstalação executa git: \(cmd)")
    assertFalse(cmd.contains("pull"), "a reinstalação puxa: \(cmd)")
}

test("os dois modos diferem só pelo prefixo do pull") {
    let repo = "/Users/dev/forge-agent"
    let update = InstallerCommand.build(repo: repo, mode: .update)
    let reinstall = InstallerCommand.build(repo: repo, mode: .reinstall)
    assertTrue(update.hasSuffix(reinstall),
               "reinstalar tem que ser exatamente o rabo de atualizar — se divergir, "
               + "um dos dois botões instala algo diferente do outro:\n\(update)\n\(reinstall)")
    assertEqual(update, "git -C '\(repo)' pull --ff-only && " + reinstall,
                "o modo update deixou de produzir a string que a v3.1.4 executava")
}

test("o comando de atualizar quota um repo com espaço nas duas posições") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/My Projects/forge-agent", mode: .update)
    assertTrue(cmd.contains("git -C '/Users/dev/My Projects/forge-agent'"),
               "o repo do git -C não foi quotado: \(cmd)")
    assertTrue(cmd.contains("'/Users/dev/My Projects/forge-agent/install.sh'"),
               "o caminho do install.sh não foi quotado: \(cmd)")
}

test("o comando manual só inspeciona — nunca stash, reset ou rebase") {
    let cmd = UpdatePrecheck.manualCommand(repo: "/Users/dev/forge-agent")
    assertTrue(cmd.contains("/Users/dev/forge-agent"), "sem o repo: \(cmd)")
    assertTrue(cmd.contains("git status"), "sem git status: \(cmd)")
    for forbidden in ["stash", "reset", "rebase", "checkout"] {
        assertFalse(cmd.contains(forbidden), "o comando sugere \(forbidden): \(cmd)")
    }
}

test("o comando manual escapa um repo com espaço no caminho") {
    let cmd = UpdatePrecheck.manualCommand(repo: "/Users/dev/My Projects/forge-agent")
    assertTrue(cmd.contains("'/Users/dev/My Projects/forge-agent'"),
               "o caminho com espaço não foi quotado: \(cmd)")
}

test("ShellQuote.posix escapa aspas simples embutidas") {
    assertEqual(ShellQuote.posix("simple"), "'simple'")
    assertEqual(ShellQuote.posix("has space"), "'has space'")
    assertEqual(ShellQuote.posix("it's"), "'it'\\''s'")
}

test("a mensagem de bloqueio explica que a recusa é proteção") {
    for blocker in [UpdatePrecheck.Blocker.dirtyTree, .diverged] {
        let m = UpdatePrecheck.message(for: blocker)
        assertGreater(m.count, 40, "mensagem curta demais para explicar: \(m)")
        assertFalse(m.contains("stash"), "a mensagem sugere stash: \(m)")
    }
}

// MARK: - VersionFooter (D25 UI side, R9)

// The property under test is "the footer does not lie". Three states are real
// and reachable TODAY, before any stamping exists: unstamped (no bundle key at
// all), stamped-and-in-sync, and stamped-but-the-repo-moved.

test("short encurta um describe com sufixo de commits") {
    assertEqual(VersionFooter.short("v3.1.4-6-g63af17e"), "v3.1.4+6")
    assertEqual(VersionFooter.short("v3.1.4-7-gabc1234"), "v3.1.4+7")
    assertEqual(VersionFooter.short("v1.36.0-142-gdeadbee"), "v1.36.0+142")
}

test("short devolve uma tag sem sufixo inalterada") {
    assertEqual(VersionFooter.short("v3.1.4"), "v3.1.4")
    assertEqual(VersionFooter.short("3.1.4"), "3.1.4")
}

test("short não estraga uma tag pré-release") {
    // Duas componentes, nenhuma contagem: nada a encurtar.
    assertEqual(VersionFooter.short("v3.0.0-beta"), "v3.0.0-beta")
    assertEqual(VersionFooter.short("v3.0.0-rc.1"), "v3.0.0-rc.1")
    // Com sufixo de verdade, o hífen do pré-release fica no lugar.
    assertEqual(VersionFooter.short("v3.0.0-beta-6-gabc1234"), "v3.0.0-beta+6")
}

test("short devolve verbatim qualquer coisa que não seja forma de git describe") {
    // Sem `g` no sha, sem contagem numérica, sem tag: nada é adivinhado.
    assertEqual(VersionFooter.short("v3.1.4-6-63af17e"), "v3.1.4-6-63af17e")
    assertEqual(VersionFooter.short("v3.1.4-seis-g63af17e"), "v3.1.4-seis-g63af17e")
    assertEqual(VersionFooter.short("-6-g63af17e"), "-6-g63af17e")
    assertEqual(VersionFooter.short(""), "")
}

test("stamped: a sentinela é a AUSÊNCIA da chave, nunca o literal 0.1.0") {
    assertNil(VersionFooter.stamped(nil), "chave ausente tem de virar nil")
    assertNil(VersionFooter.stamped(""), "chave vazia é informação ausente")
    assertNil(VersionFooter.stamped("   \n"), "chave só com espaço é informação ausente")
    // `0.1.0` é o placeholder do Info.plist versionado — e também uma versão
    // perfeitamente legítima. Filtrá-la aqui apagaria o rodapé de quem a
    // publicasse de verdade, e ninguém acharia a causa.
    assertEqual(VersionFooter.stamped("0.1.0"), "0.1.0")
    assertEqual(VersionFooter.stamped(" v3.1.4-6-g63af17e \n"), "v3.1.4-6-g63af17e")
}

test("rodapé em dia: um número só, sem detalhe, sem divergência") {
    let d = VersionFooter.display(running: "v3.3.0", repo: "v3.3.0")
    assertEqual(d.text, "v3.3.0")
    assertNil(d.detail, "não há nada a explicar quando há um número só")
    assertFalse(d.diverged, "running == repo não é divergência")
    assertTrue(d.known, "um describe estampado é versão conhecida")
}

test("rodapé divergente: dois números, o segundo rotulado repo (R9)") {
    let d = VersionFooter.display(running: "v3.1.4-6-g63af17e", repo: "v3.1.4-7-gabc1234")
    assertEqual(d.text, "v3.1.4+6 · repo v3.1.4+7")
    assertTrue(d.diverged, "describes diferentes são divergência")
    assertTrue(d.known, "o binário em execução é conhecido")
    // R9: o texto curto rotula o segundo, e o detalhe diz a frase inteira.
    assertTrue(d.text.contains("repo "), "o segundo número não está rotulado: \(d.text)")
    let detail = d.detail ?? ""
    assertTrue(detail.contains("rodando v3.1.4+6"), "o detalhe não diz o que roda: \(detail)")
    assertTrue(detail.contains("repositório está em v3.1.4+7"),
               "o detalhe não diz onde o repo está: \(detail)")
}

test("rodapé não estampado: diz o repo e admite não saber o que roda") {
    let d = VersionFooter.display(running: nil, repo: "v3.1.4-7-gabc1234")
    assertEqual(d.text, "repo v3.1.4+7")
    assertFalse(d.known, "sem a chave do bundle a versão em execução é desconhecida")
    assertFalse(d.diverged, "não se pode divergir do que não se conhece")
    assertTrue((d.detail ?? "").contains("não sei qual versão está em execução"),
               "o detalhe não admite o desconhecido: \(d.detail ?? "nil")")
}

test("rodapé sem nada: texto explícito, nunca vazio") {
    let d = VersionFooter.display(running: nil, repo: nil)
    assertEqual(d.text, "versão desconhecida")
    assertFalse(d.known)
    assertFalse(d.diverged)
    assertTrue((d.detail ?? "").contains("ForgeGitDescribe"),
               "o detalhe não nomeia a chave que falta: \(d.detail ?? "nil")")
}

test("rodapé estampado com repo ilegível: mostra o que roda, sem inventar repo") {
    let d = VersionFooter.display(running: "v3.1.4-6-g63af17e", repo: nil)
    assertEqual(d.text, "v3.1.4+6")
    assertTrue(d.known, "o bundle foi estampado; isso é sabido")
    assertFalse(d.diverged, "sem describe do repo não há com o que divergir")
    assertFalse(d.text.contains("repo"),
                "rotulou um repo que não foi lido: \(d.text)")
}

test("divergência é decidida no describe COMPLETO, não na forma curta") {
    // O caso que morde: mesma tag, mesma contagem, commits diferentes. Comparar
    // a forma curta (`v3.1.4+6` == `v3.1.4+6`) diria "em dia" e esconderia
    // exatamente o "commitei e não recompilei" que o rodapé existe para mostrar.
    let d = VersionFooter.display(running: "v3.1.4-6-gaaaaaaa", repo: "v3.1.4-6-gbbbbbbb")
    assertTrue(d.diverged, "shas diferentes com a mesma contagem não foram detectados")
    assertEqual(d.text, "v3.1.4+6 · repo v3.1.4+6")

    // E o inverso: describe idêntico com sufixo não é divergência.
    let same = VersionFooter.display(running: "v3.1.4-6-gaaaaaaa", repo: "v3.1.4-6-gaaaaaaa")
    assertFalse(same.diverged, "o mesmo describe foi lido como divergente")
    assertEqual(same.text, "v3.1.4+6")
}

test("o texto do rodapé cabe no orçamento de largura de 152pt") {
    // A medição do research: 152pt úteis a 180pt de coluna. `.caption` no macOS
    // é 10pt, ~4,6pt por caractere em média — o pior caso realista tem de ficar
    // na casa dos 30 caracteres, não dos 40 (dois describes inteiros dariam 44).
    let worst = VersionFooter.display(running: "v3.1.4-6-g63af17e",
                                      repo: "v3.1.4-7-gabc1234")
    assertLessOrEqual(worst.text.count, 30,
                      "o texto do pior caso ficou longo demais para 152pt: "
                      + "\(worst.text.count) caracteres — \(worst.text)")
    // E o detalhe, que vive num tooltip, pode e deve ser prolixo.
    assertGreater((worst.detail ?? "").count, worst.text.count,
                  "o detalhe não é mais informativo que o texto curto")
}

print("\n" + String(repeating: "─", count: 60))
print("  \(passed) passed, \(failed) failed")
if failed > 0 {
    print("\nFalhas:")
    for f in failures { print("  ✗ \(f.0)\n      \(f.1)") }
}
print("")
exit(failed > 0 ? 1 : 0)
