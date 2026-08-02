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

    // ~/Development/repo/.gsd  and  ~/Development/repo/services/.gsd (monorepo).
    // `milestones/` is what makes each a project now — a bare `.gsd/` is only
    // evidence that a tool ran there (see ProjectMarker).
    for p in ["Development/repo/.gsd/milestones",
              "Development/repo/services/.gsd/milestones",
              "Development/plain/src",
              "Development/repo/node_modules/pkg/.gsd/milestones"] {
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

test("scan não oferece diretório que só foi tocado por uma run") {
    // The measured defect: forge-verify.js wrote .gsd/forge/events.jsonl into
    // every repo it verified, and discovery read that as a project. Five of
    // eighteen registered projects were enrolled this way.
    let tmp = NSTemporaryDirectory() + "forge-disc-touch-\(UUID().uuidString.prefix(6))"
    let fm = FileManager.default
    defer { try? fm.removeItem(atPath: tmp) }
    try? fm.createDirectory(atPath: "\(tmp)/Development/repo/.gsd/forge",
                            withIntermediateDirectories: true)
    fm.createFile(atPath: "\(tmp)/Development/repo/.gsd/forge/events.jsonl",
                  contents: Data("{\"event\":\"verify\"}\n".utf8))

    assertEqual(ProjectDiscovery.scan(home: tmp).count, 0,
                "repo com só events.jsonl não é projeto")
}

print("\nProjectMarker (.gsd/ prova que uma ferramenta rodou, não que há trabalho)")

/// Builds `<tmp>/.gsd/` with the given entries; directories end in `/`.
func markerFixture(_ entries: [String: String?], line: Int = #line) -> String {
    let tmp = NSTemporaryDirectory() + "forge-mark-\(UUID().uuidString.prefix(8))"
    let fm = FileManager.default
    try? fm.createDirectory(atPath: "\(tmp)/.gsd", withIntermediateDirectories: true)
    for (name, body) in entries {
        let p = "\(tmp)/.gsd/\(name)"
        if let body {
            fm.createFile(atPath: p, contents: Data(body.utf8))
        } else {
            try? fm.createDirectory(atPath: p, withIntermediateDirectories: true)
        }
    }
    return tmp
}

test("sem .gsd/ é none") {
    let tmp = NSTemporaryDirectory() + "forge-mark-none-\(UUID().uuidString.prefix(6))"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectMarker.classify(tmp).kind, .none)
}

test(".gsd/ só com runtime é touched, não projeto") {
    let tmp = markerFixture(["forge": nil, ".locks": nil])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let r = ProjectMarker.classify(tmp)
    assertEqual(r.kind, .touched)
    assertTrue(r.signals.isEmpty, "runtime não é sinal de trabalho")
}

test(".gsd/ vazio é touched — visível, não descartado") {
    let tmp = markerFixture([:])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectMarker.classify(tmp).kind, .touched)
}

test("qualquer artefato de trabalho promove a projeto") {
    for artifact in ["milestones", "tasks", "items", "ledger", "memory", "decisions"] {
        let tmp = markerFixture(["forge": nil, artifact: nil])
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let r = ProjectMarker.classify(tmp)
        assertEqual(r.kind, .project, "\(artifact) deveria promover")
        assertTrue(r.signals.contains(artifact), "\(artifact) deveria aparecer nos sinais")
    }
}

test("STATE.md do dashboard não conta como trabalho") {
    // This is the whole `~/Development/.gsd` case: .locks/ plus a STATE.md the
    // dashboard rendered. Counting it would have kept the phantom alive.
    let tmp = markerFixture([
        ".locks": nil,
        "STATE.md": "<!-- AUTO-GENERATED by scripts/forge-dashboard.js — do not edit by hand -->\n\n# GSD Dashboard\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectMarker.classify(tmp).kind, .touched)
}

test("STATE.md escrito à mão conta") {
    let tmp = markerFixture(["STATE.md": "# Estado\n\n**Active Milestone:** M001\n"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let r = ProjectMarker.classify(tmp)
    assertEqual(r.kind, .project)
    assertTrue(r.signals.contains("STATE.md"))
}

test("projeto que contém outro projeto é workspace") {
    // lookchina: own milestones and tasks, and thirteen repos below it.
    let roles = ProjectMarker.roles([
        "/h/Development/lookchina",
        "/h/Development/lookchina/apps/odin",
        "/h/Development/lookchina/services/freyr",
        "/h/Development/message",
    ])
    assertEqual(roles["/h/Development/lookchina"], .workspace)
    assertEqual(roles["/h/Development/lookchina/apps/odin"], .project)
    assertEqual(roles["/h/Development/message"], .project,
                "projeto sozinho não vira workspace")
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

// MARK: - Id duplicado no CHANGELOG real (D36)
//
// `Release.id` é a própria `version`, e a tela de Atualizações passa a lista para
// um `ForEach`. Dois headings com a mesma versão — foi o caso real: `## Unreleased`
// na linha 1 E na 104 — produzem dois ids iguais, que em SwiftUI é comportamento
// INDEFINIDO, não erro: nada avisa, nada quebra visivelmente, e a lista renderiza
// uma das duas entradas ou as duas no lugar errado. O conserto do arquivo não se
// protege sozinho (basta o próximo release abrir um `## Unreleased` novo e esquecer
// de fechá-lo), então o invariante é asserido contra o arquivo de verdade, aqui.

/// O CHANGELOG.md do repositório, localizado a partir do `#filePath` deste arquivo
/// e não do diretório de trabalho: `swift run ForgeKitTests` roda de `app/`, mas
/// `scripts/run-tests.js` invoca de outro lugar, e um teste que só encontra o
/// arquivo sob um cwd específico é um teste que passa por não achar nada.
let repoChangelogPath: String = {
    var url = URL(fileURLWithPath: #filePath)   // …/app/Sources/ForgeKitTests/main.swift
    for _ in 0..<4 { url = url.deletingLastPathComponent() }
    return url.appendingPathComponent("CHANGELOG.md").path
}()

test("o CHANGELOG.md do repositório existe e é parseável") {
    assertTrue(FileManager.default.fileExists(atPath: repoChangelogPath),
               "CHANGELOG.md não encontrado em \(repoChangelogPath) — os dois testes "
               + "seguintes passariam por vacuidade")
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    assertGreater(ChangelogParser.parse(text).count, 10,
                  "o CHANGELOG real parseou em quase nada — o formato mudou e os "
                  + "invariantes abaixo deixaram de medir o arquivo")
}

test("nenhuma release do CHANGELOG.md real tem id duplicado (D36)") {
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    var seen: [String: Int] = [:]
    for r in ChangelogParser.parse(text) { seen[r.id, default: 0] += 1 }
    let dupes = seen.filter { $0.value > 1 }.keys.sorted()
    assertTrue(dupes.isEmpty,
               "headings `## <version>` repetidos em CHANGELOG.md: \(dupes.joined(separator: ", ")) "
               + "— `Release.id` é a version, então isso dá ids iguais num ForEach "
               + "(comportamento indefinido). Renomeie o heading para a versão que a "
               + "entrada efetivamente é (`git describe --contains <commit>` responde qual)")
}

test("o CHANGELOG.md real tem no máximo um `## Unreleased` (D36)") {
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    let unreleased = ChangelogParser.parse(text).filter(\.isUnreleased)
    assertLessOrEqual(unreleased.count, 1,
                      "\(unreleased.count) entradas `Unreleased` em CHANGELOG.md — todas "
                      + "colidem no mesmo id. Feche a antiga com a versão em que ela saiu")
}

test("o detector morde: duas entradas Unreleased dão dois ids iguais") {
    // Sem este caso os dois testes acima seriam indistinguíveis de asserções
    // vazias: eles provam que o arquivo está limpo, não que a sujeira seria vista.
    let md = """
    ## Unreleased — primeiro bloco

    ### Added

    - a

    ---

    ## v1.0.0 — meio

    ### Fixed

    - b

    ---

    ## Unreleased — segundo bloco, esquecido de fechar

    ### Added

    - c
    """
    let rs = ChangelogParser.parse(md)
    assertEqual(rs.count, 3)
    assertEqual(rs.filter(\.isUnreleased).count, 2)
    // O ponto: os ids são IGUAIS, e é isso que o ForEach recebe.
    assertEqual(rs[0].id, rs[2].id)
    var seen: [String: Int] = [:]
    for r in rs { seen[r.id, default: 0] += 1 }
    assertEqual(seen.filter { $0.value > 1 }.count, 1,
                "o mesmo cálculo que roda contra o arquivo real não acusou a duplicata "
                + "deste fixture — então ele não acusaria a do arquivo tampouco")
}

// MARK: - ReleaseWindow — 5 cards em repouso, o resto a um clique (D30, R10)

print("\nReleaseWindow (o corte é a cauda histórica, nunca o topo — D30)")

/// Um CHANGELOG sintético a partir de uma lista de versões, na ORDEM DADA.
///
/// A ordem é o ponto: a ordem do arquivo não é a ordem das versões neste repo
/// (`v1.35.0` precede `v1.36.0`), e um fixture que só usa listas decrescentes não
/// consegue distinguir "janela em ordem de arquivo" de "janela ordenada".
func windowFixture(_ versions: [String]) -> [Release] {
    let md = versions
        .map { "## \($0) — cabeçalho de \($0)\n\n### Added\n\n- entrada de \($0)\n" }
        .joined(separator: "\n")
    let rs = ChangelogParser.parse(md)
    assertEqual(rs.count, versions.count, "o fixture não parseou no número de entradas pedido")
    return rs
}

test("dedupe por version: duas entradas Unreleased dão UM card") {
    // O chunk irmão consertou o arquivo deste repo; isto conserta o PROGRAMA,
    // que também tem de sobreviver a um fork, a um merge e a uma edição à mão.
    let rs = windowFixture(["Unreleased", "v3.3.0", "Unreleased", "v3.1.4"])
    assertEqual(rs.count, 4, "o fixture precisa entrar com a duplicata para o teste valer")
    let w = ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: 5)
    assertEqual(w.visible.filter(\.isUnreleased).count, 1,
                "duas entradas Unreleased chegaram ao ForEach — dois ids iguais")
    assertEqual(w.visible.map(\.id), ["Unreleased", "v3.3.0", "v3.1.4"])
    assertEqual(w.hiddenCount, 0, "o deduplicado tem 3 entradas e o limite é 5")
}

test("limite respeitado quando nenhum pino está fora da janela") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "v3.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v9.0.0", latest: "v9.0.0", limit: 5)
    assertEqual(w.visible.count, 5)
    assertEqual(w.visible.map(\.id), ["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0"])
    assertEqual(w.hiddenCount, 3, "8 entradas menos as 5 visíveis")
}

test("R10: SE existe entrada para installed, ela está na janela — mesmo na cauda") {
    // O invariante da D30, na única forma em que ele é satisfazível (ver o teste
    // seguinte): condicionado à existência da entrada.
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "v3.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v2.0.0", latest: "v9.0.0", limit: 5)
    assertTrue(w.visible.contains { $0.id == "v2.0.0" },
               "a entrada da versão INSTALADA caiu atrás do mostrar mais — é justo o que a "
               + "D30 proíbe: o corte é a cauda histórica, nunca o que o operador está rodando")
    assertEqual(w.visible.count, 6, "os 5 do topo mais o pino que estava fora")
    assertEqual(w.hiddenCount, 2)
    // E a ordem do arquivo é preservada: o pino não é promovido para o topo.
    assertEqual(w.visible.map(\.id),
                ["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0", "v2.0.0"])
}

test("R10 é VACUAMENTE verdadeiro quando installed não tem entrada nenhuma") {
    // O caso real, não hipotético: `v3.1.4` é a tag instalada hoje e o
    // CHANGELOG deste repo não tem entrada para ela. Escrito como "o card da
    // versão instalada está sempre visível", o invariante seria insatisfazível e
    // este teste falharia contra o próprio arquivo do repo.
    let rs = windowFixture(["v3.3.0", "v3.2.0", "v3.1.1", "v3.1.0", "v3.0.0", "v2.9.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v3.1.4", latest: nil, limit: 5)
    assertEqual(w.visible.count, 5, "um installed inexistente não pode pinar nada")
    assertEqual(w.hiddenCount, 1)
    assertFalse(w.visible.contains { $0.id == "v3.1.4" }, "inventou uma entrada que não existe")
}

test("R10: latest pina do mesmo jeito, e as duas condições compõem") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "v3.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v3.0.0", latest: "v2.0.0", limit: 5)
    assertTrue(w.visible.contains { $0.id == "v3.0.0" }, "o pino de installed não entrou")
    assertTrue(w.visible.contains { $0.id == "v2.0.0" }, "o pino de latest não entrou")
    assertEqual(w.visible.count, 7)
    assertEqual(w.hiddenCount, 1, "só v4.0.0 sobra escondida")
}

test("isUnreleased é pino, esteja onde estiver na cauda") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "Unreleased"])
    let w = ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: 5)
    assertTrue(w.visible.contains(where: \.isUnreleased),
               "trabalho ainda não lançado ficou escondido")
    assertEqual(w.hiddenCount, 1)
}

test("a ordem do arquivo NÃO é a ordem das versões, e a janela não ordena") {
    // Pitfall real deste repo: `v1.35.0` aparece ANTES de `v1.36.0`. A janela
    // promete "as 5 primeiras do arquivo mais os pinos", nunca "as 5 mais
    // recentes" — e uma lógica que assumisse arquivo ordenado pinaria o card
    // errado sem nada avisar.
    let rs = windowFixture(["v1.35.0", "v1.36.0", "v1.34.0", "v1.33.0", "v1.32.0", "v1.31.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: 5)
    assertEqual(w.visible.map(\.id),
                ["v1.35.0", "v1.36.0", "v1.34.0", "v1.33.0", "v1.32.0"],
                "a janela reordenou o arquivo — a promessa é ordem de arquivo")
    assertEqual(w.hiddenCount, 1)
}

test("hiddenCount é 0 quando a lista é menor que o limite") {
    let w = ReleaseWindow.visible(releases: windowFixture(["v3.0.0", "v2.0.0"]),
                                  installed: "v3.0.0", latest: "v3.0.0", limit: 5)
    assertEqual(w.visible.count, 2)
    assertEqual(w.hiddenCount, 0, "com hiddenCount > 0 a view desenharia um controle inútil")
}

test("expandido (.max) mostra tudo, sem duplicar e sem esconder nada") {
    let rs = windowFixture(["Unreleased", "v9.0.0", "Unreleased", "v8.0.0", "v7.0.0",
                            "v6.0.0", "v5.0.0", "v4.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v5.0.0", latest: "v9.0.0",
                                  limit: Int.max)
    assertEqual(w.visible.count, 7, "o deduplicado tem 7 entradas")
    assertEqual(w.hiddenCount, 0)
    assertEqual(Set(w.visible.map(\.id)).count, w.visible.count, "id duplicado no estado expandido")
}

test("limite 0 ou negativo ainda devolve os pinos") {
    // Esconder a versão em execução é o único resultado que a D30 proíbe, então
    // nem um limite degenerado pode produzi-lo.
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v8.0.0", latest: nil, limit: 0)
    assertEqual(w.visible.map(\.id), ["v8.0.0"])
    assertEqual(w.hiddenCount, 2)
    assertEqual(ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: -3)
                    .visible.count, 0)
}

test("o dedupe acontece ANTES do pino: uma versão repetida pina uma vez") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v2.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v2.0.0", latest: nil, limit: 5)
    assertEqual(w.visible.filter { $0.id == "v2.0.0" }.count, 1,
                "o pino entrou duas vezes — dois ids iguais no ForEach")
    assertEqual(w.visible.count, 6)
    assertEqual(w.hiddenCount, 0, "o deduplicado tem 6 entradas, todas visíveis")
}

test("installed com e sem o `v` nomeiam a mesma release") {
    // `installed` é uma tag git; as entradas são headings escritos à mão. Um `v`
    // a mais não pode decidir se o card pode ser escondido.
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0", "v4.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "4.0.0", latest: nil, limit: 5)
    assertTrue(w.visible.contains { $0.id == "v4.0.0" }, "`4.0.0` não casou com `## v4.0.0`")
    assertEqual(w.hiddenCount, 0)
}

test("o limite em repouso é uma constante nomeada, e vale 5") {
    // O número nunca foi validado contra uma lista ao vivo (ninguém respondeu
    // "olhando, 5 é pouco ou muito?"), então trocá-lo tem de ser uma linha.
    assertEqual(ReleaseWindow.restingLimit, 5)
}

test("o rótulo do mostrar-mais concorda em número") {
    assertEqual(ReleaseWindow.moreLabel(hiddenCount: 1), "Mostrar mais 1 versão")
    assertEqual(ReleaseWindow.moreLabel(hiddenCount: 7), "Mostrar mais 7 versões")
    assertEqual(ReleaseWindow.lessLabel, "Mostrar menos")
}

test("o CHANGELOG real, na janela de repouso, mantém tudo o que a D30 pina") {
    // Contra o arquivo de verdade, não contra fixture: é o único lugar onde o
    // Pitfall 8 (installed sem entrada) aparece sozinho.
    guard let text = try? String(contentsOfFile: repoChangelogPath, encoding: .utf8) else {
        assertTrue(false, "CHANGELOG.md não encontrado em \(repoChangelogPath)")
        return
    }
    let rs = ChangelogParser.parse(text)
    let w = ReleaseWindow.visible(releases: rs, installed: "v3.1.4", latest: "v3.3.0",
                                  limit: ReleaseWindow.restingLimit)
    assertEqual(Set(w.visible.map(\.id)).count, w.visible.count, "id duplicado na janela real")
    assertTrue(w.visible.contains { $0.id == "v3.3.0" },
               "a entrada da versão disponível não está na janela de repouso")
    assertGreater(w.hiddenCount, 0, "o arquivo real tem mais de 5 entradas — nada a esconder?")
    assertEqual(w.visible.count + w.hiddenCount, rs.count,
                "visible + hidden tem de fechar com o total deduplicado")
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

test("decodifica closed_at, labels e priority da saída real pós-T03") {
    // Copiado verbatim de `node scripts/forge-items.js --list --json`
    // (item criado, --set-priority p1, --update labels, --set-status done).
    let json = """
    [{"id":"I-20260730180758-test-title","title":"Test title","status":"done",
      "priority":"p1","labels":["bug","ui"],"origin":"human",
      "created":"2026-07-30T18:07:58.670Z","updated":"2026-07-30T18:07:59.007Z",
      "closed_at":"2026-07-30T18:07:59.009Z","body":""}]
    """
    let items = try! JSONDecoder().decode([Item].self, from: Data(json.utf8))
    let item = items[0]
    assertEqual(item.closed_at, "2026-07-30T18:07:59.009Z")
    assertEqual(item.priority, "p1")
    assertEqual(item.labels ?? [], ["bug", "ui"])
}

test("item legado sem closed_at/labels/priority decodifica com os três nil") {
    let json = """
    {"id":"I-20260729145851-test-title","title":"Test title","status":"inbox",
     "origin":"human","created":"2026-07-29T14:58:51.237Z",
     "updated":"2026-07-29T14:58:51.237Z","body":"Some body text"}
    """
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertTrue(item.closed_at == nil, "item legado não tem closed_at")
    assertTrue(item.labels == nil, "item legado não tem labels — nil, não []")
    assertTrue(item.priority == nil, "item legado não tem priority")
}

test("labels vazio no JSON decodifica como array vazio, não nil") {
    let json = """
    {"id":"I-20260730000000-sem-labels","title":"Sem labels","status":"inbox",
     "labels":[]}
    """
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertTrue(item.labels != nil, "labels: [] deve decodificar como array vazio, não nil")
    assertEqual(item.labels ?? ["sentinel"], [])
}

print("\nItems (card)")

// O critério #4 da milestone é uma CONTAGEM: onde o card mostra 3 coisas hoje,
// tem de mostrar 7. Estes testes são o que torna esse critério verificável sem
// olhar para uma tela — o target `Forge` não é importável daqui, então tudo o
// que decidisse conteúdo dentro de `ItemCard` ficaria fora de qualquer suíte.
//
// A ordem é asserida junto com a contagem de propósito: contar 7 não detecta
// uma troca de ordem, e a ordem é o que faz o card ler como issue.

/// Item com todos os campos que o card sabe desenhar — o "depois".
private func fullItem(status: String = "done") -> Item {
    Item(
        id: "I-20260730120000-completo",
        title: "Corrigir o parser de datas do progresso",
        status: status,
        source: "roadmap",
        body: "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n\nQuarto parágrafo.\n\nQuinto parágrafo.",
        closed_at: "2026-07-30T12:00:00.000Z",
        labels: ["bug", "ui"],
        priority: "p1"
    )
}

test("card denso: item completo desenha 3 elementos, na ordem canônica") {
    // Era 7 (critério #4, S04). O operador reverteu depois de ver num board
    // real: a 268pt, corpo de 3 linhas + id de 40 caracteres + origem + data
    // viram parágrafo, e cabiam ~3 cards na tela. Corpo/id/origem/data NÃO
    // sumiram — ver os dois testes de `cardTooltip` abaixo e o guard do sheet
    // em scripts/forge-app-items.test.js.
    let els = ItemCardPresentation.elements(for: fullItem())
    assertEqual(els.count, 3, "o card denso tem 3 elementos: título, labels, prioridade")

    guard els.count == 3 else { return }
    if case .title(let t) = els[0] { assertEqual(t, "Corrigir o parser de datas do progresso") }
    else { assertTrue(false, "elemento 0 deveria ser .title, veio \(els[0])") }
    if case .labels(let shown, let overflow) = els[1] {
        assertEqual(shown, ["bug", "ui"])
        assertEqual(overflow, 0)
    } else { assertTrue(false, "elemento 1 deveria ser .labels, veio \(els[1])") }
    if case .priority(let p) = els[2] { assertEqual(p, .p1) }
    else { assertTrue(false, "elemento 2 deveria ser .priority, veio \(els[2])") }
}

test("card denso: item legado desenha 1 elemento — só o título") {
    // O shape exato dos itens reais que o repo tem hoje: sem corpo, sem label,
    // sem prioridade, sem closed_at.
    let legacy = Item(id: "I-20260729145851-test-title", title: "Test title",
                      status: "inbox", source: "manual")
    let els = ItemCardPresentation.elements(for: legacy)
    assertEqual(els.count, 1, "sem label e sem prioridade, sobra só o título")
    if case .title = els[0] {} else { assertTrue(false, "0 deveria ser .title") }
}

test("dropped NÃO mostra data de fechamento, mesmo com closed_at gravado") {
    let dropped = fullItem(status: "dropped")
    assertNil(ItemCardPresentation.closedDay(dropped), "dropped nunca mostra 'fechado em' (S04-b)")
}

test("done sem closed_at (os itens legados do repo) não mostra data e não crasha") {
    let done = Item(id: "I-2", title: "Feito antigo", status: "done", source: "manual")
    assertNil(ItemCardPresentation.closedDay(done))
    assertEqual(ItemCardPresentation.elements(for: done).count, 1)
}

test("closedDay só aceita done — os outros três status também ficam de fora") {
    for s in ["inbox", "triaged", "doing"] {
        assertNil(ItemCardPresentation.closedDay(fullItem(status: s)),
                  "status \(s) não deve ter data de fechamento")
    }
    assertEqual(ItemCardPresentation.closedDay(fullItem(status: "done")), "2026-07-30")
}

test("closedDay aceita as três formas de data que o engine escreve") {
    func at(_ raw: String) -> Item { Item(id: "I-3", status: "done", closed_at: raw) }
    assertEqual(ItemCardPresentation.closedDay(at("2026-07-30T12:00:00.000Z")), "2026-07-30")
    assertEqual(ItemCardPresentation.closedDay(at("2026-07-30T12:00:00Z")), "2026-07-30")
    assertEqual(ItemCardPresentation.closedDay(at("2026-07-30")), "2026-07-30")
    assertNil(ItemCardPresentation.closedDay(at("ontem")), "forma não reconhecida vira nil, não crash")
}

test("bodyPreview corta em 3 linhas e sinaliza o corte") {
    let five = "um\ndois\ntrês\nquatro\ncinco"
    let p = ItemCardPresentation.bodyPreview(five)
    assertEqual(p?.text, "um\ndois\ntrês")
    assertEqual(p?.truncated, true)
}

test("bodyPreview de 2 linhas não sinaliza corte") {
    let p = ItemCardPresentation.bodyPreview("um\ndois")
    assertEqual(p?.text, "um\ndois")
    assertEqual(p?.truncated, false)
}

test("bodyPreview descarta linhas em branco antes de contar as 3") {
    let p = ItemCardPresentation.bodyPreview("um\n\n\ndois\n\ntrês")
    assertEqual(p?.text, "um\ndois\ntrês")
    assertEqual(p?.truncated, false, "linha em branco não conta como conteúdo cortado")
}

test("bodyPreview devolve nil para corpo ausente, vazio ou só espaço") {
    assertNil(ItemCardPresentation.bodyPreview(nil))
    assertNil(ItemCardPresentation.bodyPreview(""))
    assertNil(ItemCardPresentation.bodyPreview("   \n\n  \n"))
}

test("labelChips corta em 3 e reporta o overflow, preservando a ordem do engine") {
    let c = ItemCardPresentation.labelChips(["zeta", "alpha", "meio", "quarto", "quinto"])
    assertEqual(c?.shown ?? [], ["zeta", "alpha", "meio"], "ordem é a do disco, não alfabética")
    assertEqual(c?.overflow, 2)
}

test("labelChips com 1 label não tem overflow; vazio e nil somem") {
    assertEqual(ItemCardPresentation.labelChips(["bug"])?.overflow, 0)
    assertEqual(ItemCardPresentation.labelChips(["bug"])?.shown ?? [], ["bug"])
    assertNil(ItemCardPresentation.labelChips([]))
    assertNil(ItemCardPresentation.labelChips(nil))
    assertNil(ItemCardPresentation.labelChips(["", "   "]), "só espaço não é label")
}

test("prioridade: parse dos quatro valores, marca e rótulo pt-BR") {
    assertEqual(ItemPriority.parse("p0"), .p0)
    assertEqual(ItemPriority.parse("p1"), .p1)
    assertEqual(ItemPriority.parse("p2"), .p2)
    assertEqual(ItemPriority.parse("p3"), .p3)
    assertEqual(ItemPriority.p0.mark, "P0")
    assertEqual(ItemPriority.p3.mark, "P3")
    assertEqual(ItemPriority.p0.label, "crítica")
    assertEqual(ItemPriority.p1.label, "alta")
    assertEqual(ItemPriority.p2.label, "média")
    assertEqual(ItemPriority.p3.label, "baixa")
}

test("prioridade desconhecida vira nil e some do card — nada é inventado") {
    assertNil(ItemPriority.parse("lixo"))
    assertNil(ItemPriority.parse(nil))
    assertNil(ItemPriority.parse("P0"), "o valor do engine é minúsculo; não normalizamos aqui")
    let item = Item(id: "I-4", title: "t", status: "inbox", priority: "lixo")
    let els = ItemCardPresentation.elements(for: item)
    assertFalse(els.contains { if case .priority = $0 { return true } else { return false } },
                "prioridade desconhecida não desenha marca nenhuma")
}

test("título vazio cai no fallback e continua sempre presente") {
    let els = ItemCardPresentation.elements(for: Item(id: "I-5", title: "   ", status: "inbox"))
    if case .title(let t) = els[0] { assertEqual(t, "(sem título)") }
    else { assertTrue(false, "título sempre presente, mesmo em branco") }
}

// S04 review (R2): the card view and the detail sheet used to each write
// their own `item.title ?? "(sem título)"`, which let a whitespace-only
// title (present, but only spaces) through unfiltered — `elements(for:)`
// already normalised that case, but the raw views did not. `displayTitle`
// is the single function both views now call; these tests pin its contract
// directly, independent of `elements(for:)`.
test("displayTitle: título normal passa direto") {
    let item = Item(id: "I-6", title: "Corrigir bug", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "Corrigir bug")
}

test("displayTitle: título ausente cai no fallback") {
    let item = Item(id: "I-7", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "(sem título)")
}

test("displayTitle: título só de espaços cai no fallback — não é 'presente'") {
    let item = Item(id: "I-8", title: "   ", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "(sem título)")
}

test("displayTitle: espaços nas bordas de um título real são aparados") {
    let item = Item(id: "I-9", title: "  com espaços  ", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "com espaços")
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

print("Progress — itens fechados e janela")

// ProgressTests — window resolution (instant + day, DS1) and the "closed
// items" panel source (DS8 done-only, DS9 parse trap, D5 declared coverage).

func progressItem(status: String, closedAt: String?) -> Item {
    Item(id: "x", status: status, closed_at: closedAt)
}

test("cobertura declarada: 3 done sem closed_at → closed 0 e rótulo, não só o número") {
    let items = [
        progressItem(status: "done", closedAt: nil),
        progressItem(status: "done", closedAt: nil),
        progressItem(status: "done", closedAt: nil),
    ]
    let r = ClosedItems.count(items: items, window: .all)
    assertEqual(r.closed, 0, "closed deveria ser 0")
    assertEqual(r.missingClosedAt, 3, "missingClosedAt deveria contar os 3")
    assertTrue(r.coverageLabel != nil, "coverageLabel não pode ser nil quando há itens sem data")
}

test("dropped com closed_at na janela não conta (DS8) — done conta") {
    let now = Date()
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let raw = iso.string(from: now)
    let items = [
        progressItem(status: "dropped", closedAt: raw),
        progressItem(status: "done", closedAt: raw),
    ]
    let r = ClosedItems.count(items: items, window: .all, now: now)
    assertEqual(r.closed, 1, "só o done deveria contar")
}

test("closed_at fracionado (toISOString real) parseia e conta em .all e numa janela que o contém") {
    // Sample literal exatamente no formato que Date.toISOString() emite —
    // ISO8601DateFormatter sem .withFractionalSeconds devolve nil para isso
    // (DS9): esse teste existe para tornar esse nil impossível de passar
    // despercebido.
    let raw = "2026-07-30T18:20:00.123Z"
    let (instant, day) = ProgressDate.parse(raw)
    assertTrue(instant != nil, "parse fracionado não pode devolver nil (DS9)")
    assertEqual(day, "2026-07-30", "day deveria ser os 10 primeiros chars")

    let now = ISO8601DateFormatter().date(from: "2026-07-30T18:25:00Z")!
    let items = [progressItem(status: "done", closedAt: raw)]
    assertEqual(ClosedItems.count(items: items, window: .all, now: now).closed, 1,
                "deveria contar em .all")
    assertEqual(ClosedItems.count(items: items, window: .day24h, now: now).closed, 1,
                "deveria contar numa janela que contém o instante")
}

test("closed_at data-só conta por resolução de dia, não como meia-noite UTC") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Sao_Paulo")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 12))!
    let items = [progressItem(status: "done", closedAt: "2026-07-30")]
    let r = ClosedItems.count(items: items, window: .day24h, now: now, calendar: calendar)
    assertEqual(r.closed, 1, "data-só de hoje deveria contar em .day24h por resolução de dia")
}

test("borda de janela: closed_at 8 dias atrás fica fora de .week, dentro de .month") {
    let now = Date()
    let eightDaysAgo = now.addingTimeInterval(-86_400 * 8)
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let raw = iso.string(from: eightDaysAgo)
    let items = [progressItem(status: "done", closedAt: raw)]
    assertEqual(ClosedItems.count(items: items, window: .week, now: now).closed, 0,
                "8 dias atrás deveria ficar fora de .week")
    assertEqual(ClosedItems.count(items: items, window: .month, now: now).closed, 1,
                "8 dias atrás deveria ficar dentro de .month")
}

test("ProgressWindow.dayThreshold para .week com now fixo é exatamente hoje-6d") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))!
    let expected = calendar.date(from: DateComponents(year: 2026, month: 7, day: 24))!
    let expectedStr = ProgressDate.dayString(expected, calendar: calendar)
    assertEqual(ProgressWindow.week.dayThreshold(now: now, calendar: calendar), expectedStr,
                "threshold de .week deveria ser hoje-6d")
}

test("ProgressWindow.ledgerWindowLabel: 'hoje' só para .day24h (DS1)") {
    assertEqual(ProgressWindow.day24h.ledgerWindowLabel, "hoje")
    assertNil(ProgressWindow.week.ledgerWindowLabel)
    assertNil(ProgressWindow.month.ledgerWindowLabel)
    assertNil(ProgressWindow.all.ledgerWindowLabel)
}

print("Ledger — leitor mínimo e janela por dia")

// LedgerTests — fence-and-root-only scanner (DS2/blocker 3) and day-window
// resolution (DS1/blocker 1).

// Literal copy of the real fragment shape at
// `.gsd/ledger/T-20260730020639-sidebar-secao.md` (list `key_decisions:`
// with `- ` items AND `|` block scalars with indented continuation lines) —
// embedded because `.gsd/` is gitignored (S02-PLAN Note 2), so the suite
// runs identically in any clone.
let ledgerFixtureReal = """
---
completed_at: 2026-07-30
id: T-20260730020639-sidebar-secao
key_decisions:
  - A versão exibida era a tag do repo, não a do binário rodando (Info.plist com 0.1.0 fixo, build.sh nunca reescrevia) — corrigido estampando 3 chaves no bundle entre a cópia do plist e o codesign, com plutil -replace
  - |
    Não agrupar as 13 seções: List sections adicionariam ~60pt de header e subiriam a contagem em repouso de 13 para 16, piorando a única métrica contável de minimalismo
  - Nenhuma renomeação de seção — Section.rawValue é rótulo E chave do @AppStorage via SectionRestore
  - |
    D15 da task irmã preservada: o slot de ação Atualizar+Reinstalar é intocado
  - |
    R6 do review: repoDescribe ficava stale após update, então o rodapé lia 'em dia' no instante em que a divergência passava a existir
  - O repo se auto-tagueia no merge via .github/workflows/release.yml — a discussão D35/D37 sobre quem taggeia era desnecessária
key_files:
  - app/build.sh
  - app/Sources/ForgeKit/UpdateCore.swift
  - app/Sources/Forge/Views.swift
  - app/Sources/Forge/Updates.swift
  - app/Sources/Forge/Previews.swift
  - scripts/forge-app-sidebar.test.js
  - CHANGELOG.md
slices: []
title: Sidebar e seção de atualizações mais minimalistas, com versão sempre visível
---

A UI de progresso entregue nas duas tasks irmãs era inalcançável e a versão exibida era do repo, não do binário.
"""

test("fixture real (lista + bloco) parseia id e completedDay corretos") {
    let f = Ledger.parseFragment(ledgerFixtureReal)
    assertEqual(f.id, "T-20260730020639-sidebar-secao", "id deveria vir da raiz")
    assertEqual(f.completedDay, "2026-07-30", "completedDay deveria vir da raiz")
}

test("armadilha: completed_at indentado num bloco | e outro após a cerca não sobrescrevem a raiz") {
    let trap = """
    ---
    completed_at: 2026-07-30
    id: T-trap
    key_decisions:
      - |
        Nota falsa que tenta confundir o scanner:
        completed_at: 1999-01-01
      - Outra linha normal
    ---
    Corpo com outra menção fora da cerca:
    completed_at: 1999-01-01
    """
    let f = Ledger.parseFragment(trap)
    assertEqual(f.completedDay, "2026-07-30",
                "o scanner não pode ler o valor de dentro do bloco nem o de depois da cerca")
    assertEqual(f.id, "T-trap", "id deveria continuar vindo da raiz")
}

test("deliveries: fragmento de hoje conta em .day24h com windowLabel 'hoje'; ontem não") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 12))!
    let today = LedgerFragment(id: "a", completedDay: "2026-07-30")
    let yesterday = LedgerFragment(id: "b", completedDay: "2026-07-29")

    let day = Ledger.deliveries(fragments: [today, yesterday], window: .day24h, now: now, calendar: calendar)
    assertEqual(day.count, 1, "só o fragmento de hoje deveria contar em .day24h")
    assertEqual(day.windowLabel, "hoje", "windowLabel deveria ser 'hoje' para .day24h (DS1)")

    let week = Ledger.deliveries(fragments: [today, yesterday], window: .week, now: now, calendar: calendar)
    assertEqual(week.count, 2, "ambos deveriam contar em .week")
    assertNil(week.windowLabel, "windowLabel deveria ser nil fora de .day24h")
}

test("borda de 7 dias: hoje-6d dentro de .week, hoje-7d fora") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))!
    let sixDaysAgoDate = calendar.date(byAdding: .day, value: -6, to: now)!
    let sevenDaysAgoDate = calendar.date(byAdding: .day, value: -7, to: now)!
    let sixDaysAgo = ProgressDate.dayString(sixDaysAgoDate, calendar: calendar)
    let sevenDaysAgo = ProgressDate.dayString(sevenDaysAgoDate, calendar: calendar)
    let fragments = [
        LedgerFragment(id: "in", completedDay: sixDaysAgo),
        LedgerFragment(id: "out", completedDay: sevenDaysAgo),
    ]
    let r = Ledger.deliveries(fragments: fragments, window: .week, now: now, calendar: calendar)
    assertEqual(r.count, 1, "só hoje-6d deveria estar dentro de .week (threshold inclusivo)")

    let month = Ledger.deliveries(fragments: fragments, window: .month, now: now, calendar: calendar)
    assertEqual(month.count, 2, "ambos deveriam estar dentro de .month")
}

test("fragmento sem completed_at válido nunca entra em janela; conta em undated") {
    let noDate = LedgerFragment(id: "x", completedDay: nil)
    let dated = LedgerFragment(id: "y", completedDay: "2026-07-30")
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))!

    let all = Ledger.deliveries(fragments: [noDate, dated], window: .all, now: now, calendar: calendar)
    assertEqual(all.count, 1, "undated não deveria entrar no count mesmo em .all")
    assertEqual(all.undated, 1, "undated deveria reportar o fragmento sem data")

    let day = Ledger.deliveries(fragments: [noDate, dated], window: .day24h, now: now, calendar: calendar)
    assertEqual(day.undated, 1, "undated deveria ser reportado em qualquer janela")
}

test("Ledger.read(dir:) ordena por nome e devolve [] para diretório ausente") {
    assertEqual(Ledger.read(dir: "/tmp/forge-ledger-test-nonexistent-\(UUID().uuidString)"), [],
                "diretório ausente não é erro")

    let tmp = NSTemporaryDirectory() + "forge-ledger-read-\(UUID().uuidString)"
    try! FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let bFrag = """
    ---
    completed_at: 2026-07-29
    id: b-frag
    ---
    """
    let aFrag = """
    ---
    completed_at: 2026-07-30
    id: a-frag
    ---
    """
    try! bFrag.write(toFile: tmp + "/b-frag.md", atomically: true, encoding: .utf8)
    try! aFrag.write(toFile: tmp + "/a-frag.md", atomically: true, encoding: .utf8)
    try! "not a fragment, ignored by extension".write(toFile: tmp + "/notes.txt", atomically: true, encoding: .utf8)

    let read = Ledger.read(dir: tmp)
    assertEqual(read.count, 2, "só os .md deveriam ser lidos")
    assertEqual(read.map { $0.id }, ["a-frag", "b-frag"], "ordem deveria ser por nome de arquivo")
}

// ═══════════════════════════════════════════════════════════════════════════
print("GitActivity — dedupe, globs e janela")

/// Run git with a HERMETIC environment. The point is that this fixture builds
/// the same repo on any machine: `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at
/// /dev/null so no `~/.gitconfig` leaks in (a global `commit.gpgsign = true` or
/// a `init.defaultBranch` would otherwise decide whether the test passes), and
/// identity plus dates passed explicitly so commits are reproducible.
@discardableResult
func fixtureGit(_ args: [String], at path: String, date: String = "2026-07-30T12:00:00Z") -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = ["-C", path,
                   "-c", "user.name=Forge Fixture",
                   "-c", "user.email=fixture@forge.test",
                   "-c", "commit.gpgsign=false"] + args
    var env = ProcessInfo.processInfo.environment
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_SYSTEM"] = "/dev/null"
    env["GIT_AUTHOR_DATE"] = date
    env["GIT_COMMITTER_DATE"] = date
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    try! p.run()
    let d = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: d, encoding: .utf8) ?? ""
}

func fixtureWrite(_ text: String, to path: String) {
    try! FileManager.default.createDirectory(
        atPath: (path as NSString).deletingLastPathComponent,
        withIntermediateDirectories: true)
    try! text.write(toFile: path, atomically: true, encoding: .utf8)
}

test("parseLog lê header + numstat, com binário e rename, na forma exata") {
    // O `-` de binário NÃO é falha de parse: um arquivo cujas linhas não se
    // contam continua pertencendo ao commit, e recusar a linha derrubaria o
    // resto dele. O rename é normalizado para o lado NOVO antes de qualquer
    // glob — senão mover um arquivo para dentro de dist/ continua contando.
    let log = """
    a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 1753900000

    12\t3\tsrc/a.swift
    -\t-\tassets/logo.png
    4\t0\ta/{b => c}/d.js

    00112233445566778899aabbccddeeff00112233 1753800000

    1\t1\tREADME.md
    """
    let commits = GitActivity.parseLog(log)
    assertEqual(commits.count, 2, "dois headers deveriam virar dois commits")

    assertEqual(commits[0].sha, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
    assertEqual(commits[0].epoch, 1753900000, "epoch vem do %ct")
    assertEqual(commits[0].files.count, 3, "as três linhas numstat deveriam sobreviver")
    assertEqual(commits[0].files[0], FileStat(added: 12, deleted: 3, path: "src/a.swift"))
    assertEqual(commits[0].files[1], FileStat(added: 0, deleted: 0, path: "assets/logo.png"),
                "binário conta 0 linhas em vez de quebrar o commit")
    assertEqual(commits[0].files[2], FileStat(added: 4, deleted: 0, path: "a/c/d.js"),
                "rename com chaves deveria normalizar para o caminho NOVO")

    assertEqual(commits[1].sha, "00112233445566778899aabbccddeeff00112233")
    assertEqual(commits[1].files.count, 1)
}

test("parseLog normaliza as três formas de rename e pula linha torta") {
    // Molde do MetricsEngine.parse: a saída vem de subprocesso e a última linha
    // pode vir truncada — uma linha ilegível não pode custar a janela inteira.
    let log = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1753900000

    1\t0\tvelho.js => novo.js
    2\t0\t{old => new}.js
    3\t0\tsrc/{ => nested}/x.js
    isto não é numstat nem header
    \t\t
    4\t0\tsem/rename.js
    """
    let commits = GitActivity.parseLog(log)
    assertEqual(commits.count, 1)
    assertEqual(commits[0].files.map { $0.path },
                ["novo.js", "new.js", "src/nested/x.js", "sem/rename.js"],
                "as três formas de rename normalizam para o lado novo; linha torta é pulada")
}

test("parseLog tolera commit de merge (header sem numstat)") {
    let log = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1753900000

    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1753800000

    5\t5\tx.swift
    """
    let commits = GitActivity.parseLog(log)
    assertEqual(commits.count, 2, "merge sem numstat continua sendo um commit")
    assertEqual(commits[0].files.count, 0)
    assertEqual(commits[1].files.count, 1)
}

test("union deduplica por SHA mantendo a primeira aparição e a ordem") {
    let a = Commit(sha: "aaa1111", epoch: 3, files: [FileStat(added: 1, deleted: 0, path: "a")])
    let b = Commit(sha: "bbb2222", epoch: 2, files: [])
    let c = Commit(sha: "ccc3333", epoch: 1, files: [])
    let merged = GitActivity.union([[a, b], [b, c]])
    assertEqual(merged.map { $0.sha }, ["aaa1111", "bbb2222", "ccc3333"],
                "SHA repetido entre checkouts deveria entrar uma vez só")
}

test("critério #10: união entre 2 checkouts reais é 3, e a soma ingênua é 5") {
    // Blocker 2 do RISK, e a razão de este teste existir: `git worktree list`
    // NESTE repo devolve UM checkout, então um `union` que só concatena passaria
    // em qualquer teste escrito contra o repo real — a inflação seria de 1x e
    // portanto invisível. O fixture constrói dois checkouts que compartilham
    // história de verdade, e o teste afirma DUAS coisas: que a união bate com o
    // `sort -u` dos SHAs, e que a concatenação é ESTRITAMENTE MAIOR. Sem a
    // segunda afirmação o teste não distingue um dedupe funcionando de um no-op.
    let tmp = NSTemporaryDirectory() + "forge-gitactivity-\(UUID().uuidString)"
    let main = tmp + "/main"
    let side = tmp + "/side"
    try! FileManager.default.createDirectory(atPath: main, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    fixtureGit(["init", "-b", "main"], at: main)
    fixtureWrite("um\n", to: main + "/src/a.swift")
    fixtureGit(["add", "src/a.swift"], at: main)
    fixtureGit(["commit", "-m", "c1"], at: main, date: "2026-07-28T10:00:00Z")
    fixtureWrite("dois\n", to: main + "/src/b.swift")
    fixtureGit(["add", "src/b.swift"], at: main)
    fixtureGit(["commit", "-m", "c2"], at: main, date: "2026-07-29T10:00:00Z")

    // O segundo checkout parte da MESMA história: é o cenário real do
    // forge_isolation.mode = worktree, onde os commits da milestone vivem fora
    // da pasta que o operador adicionou (DS6).
    fixtureGit(["worktree", "add", side, "-b", "side"], at: main)
    fixtureWrite("três\n", to: side + "/src/c.swift")
    fixtureGit(["add", "src/c.swift"], at: side)
    fixtureGit(["commit", "-m", "c3"], at: side, date: "2026-07-30T10:00:00Z")

    let checkouts = [Checkout(path: main, branch: "main", isPrimary: true),
                     Checkout(path: side, branch: "side", isPrimary: false)]
    let perCheckout = GitActivity.collect(checkouts: checkouts)
    assertEqual(perCheckout.count, 2, "deveria haver um log por checkout")

    let concatenated = perCheckout.flatMap { $0 }
    let united = GitActivity.union(perCheckout)

    // `sort -u` calculado in-test: a verdade independente contra a qual a
    // implementação é conferida.
    let uniqueShas = Set(concatenated.map { $0.sha })
    assertEqual(uniqueShas.count, 3, "os dois checkouts deveriam somar 3 commits distintos")
    assertEqual(united.count, uniqueShas.count, "a união deveria bater com o sort -u dos SHAs")
    assertEqual(Set(united.map { $0.sha }), uniqueShas, "a união deveria ter exatamente esses SHAs")

    assertEqual(concatenated.count, 5,
                "main tem 2 commits e side tem 3 (2 compartilhados + 1) — a concatenação é 5")
    assertGreater(concatenated.count, united.count,
                  "a concatenação TEM de ser maior que a união: se fossem iguais, este teste "
                  + "não distinguiria um dedupe de um no-op")
}

test("linhas contam sobre a UNIÃO, não por checkout (o dobro seria silencioso)") {
    // O mesmo commit alcançável por dois checkouts contaria duas vezes se as
    // linhas fossem somadas por checkout e depois agregadas.
    let shared = Commit(sha: "aaa1111", epoch: 1,
                        files: [FileStat(added: 10, deleted: 4, path: "src/a.swift")])
    let perCheckout = [[shared], [shared]]
    let naive = perCheckout.map { GitActivity.linesTouched($0, ignoring: []) }
        .reduce(into: (added: 0, deleted: 0)) { $0.added += $1.added; $0.deleted += $1.deleted }
    let correct = GitActivity.linesTouched(GitActivity.union(perCheckout), ignoring: [])
    assertEqual(correct.added, 10, "a união conta o commit compartilhado uma vez")
    assertEqual(correct.deleted, 4)
    assertEqual(naive.added, 20, "somar por checkout dobraria — é a armadilha que a união evita")
}

test("linesTouched soma só o que está fora dos ignore-globs") {
    let c = Commit(sha: "aaa1111", epoch: 1, files: [
        FileStat(added: 10, deleted: 2, path: "dist/x.js"),
        FileStat(added: 3, deleted: 1, path: "src/a.js"),
    ])
    let r = GitActivity.linesTouched([c], ignoring: GitActivity.defaultIgnoreList)
    assertEqual(r.added, 3, "dist/x.js está sob dist/** e não deveria contar")
    assertEqual(r.deleted, 1)

    let unfiltered = GitActivity.linesTouched([c], ignoring: [])
    assertEqual(unfiltered.added, 13, "sem globs, tudo conta — o filtro é a diferença")
}

test("Glob fala exatamente o vocabulário da lista default") {
    assertTrue(GitActivity.Glob.matches(".gsd/**", ".gsd/forge/events.jsonl"),
               "sufixo /** casa o prefixo de diretório em qualquer profundidade")
    assertFalse(GitActivity.Glob.matches("dist/**", "mydist/a.js"),
                "dist/** é um diretório, não um prefixo de nome — mydist/ não é dist/")
    assertTrue(GitActivity.Glob.matches("dist/**", "dist/a/b.js"))
    assertTrue(GitActivity.Glob.matches("package-lock.json", "app/nested/package-lock.json"),
               "padrão sem / casa o basename em qualquer diretório")
    assertTrue(GitActivity.Glob.matches("package-lock.json", "package-lock.json"))
    assertFalse(GitActivity.Glob.matches("package-lock.json", "package-lock.json.bak"))
    assertTrue(GitActivity.Glob.matches("*.lock", "a/b/Cargo.lock"), "* casa dentro do segmento")
    assertFalse(GitActivity.Glob.matches("src/*.js", "src/deep/a.js"),
                "* nunca atravessa a barra")
    assertTrue(GitActivity.Glob.matches("src/*.js", "src/a.js"))
}

test("resolveIgnoreList: caller manda; ausente ou vazio cai no default do engine") {
    assertEqual(GitActivity.resolveIgnoreList(prefValue: nil), GitActivity.defaultIgnoreList,
                "sem prefs resolvidas, vale o default do engine (DS5)")
    assertEqual(GitActivity.resolveIgnoreList(prefValue: []), GitActivity.defaultIgnoreList,
                "lista vazia da cascata significa 'chave não definida', como no completer")
    assertEqual(GitActivity.resolveIgnoreList(prefValue: ["só-isto"]), ["só-isto"],
                "valor resolvido pelo caller ganha")
    assertEqual(GitActivity.defaultIgnoreList.count, 7,
                "os 7 defaults do engine — divergir de agents/forge-completer.md é o que "
                + "scripts/forge-app-progress.test.js existe para pegar")
}

test("a janela filtra pelo epoch parseado, não pelo comando") {
    // DS7: o comando é constante e o `--since` não existe, para que parse e
    // janela sejam puros — e para que 24h aqui signifique o mesmo que nas
    // outras duas fontes.
    let old = Commit(sha: "old1111", epoch: 1_700_000_000, files: [])
    let recent = Commit(sha: "new2222", epoch: 1_753_900_000, files: [])
    let since = Date(timeIntervalSince1970: 1_750_000_000)
    let kept = GitActivity.inWindow([old, recent], since: since)
    assertEqual(kept.map { $0.sha }, ["new2222"], "só o commit dentro da janela sobrevive")
    assertEqual(GitActivity.inWindow([old, recent], since: nil).count, 2,
                "sem janela, nada é filtrado")
}

print("Divergence + ProgressSummary")

test("Divergence: os 4 padrões canônicos produzem exatamente 1 frase cada, todas distintas") {
    let p1 = Divergence.sentence(closed: 0, deliveries: 0, commits: 5)
    let p2 = Divergence.sentence(closed: 3, deliveries: 0, commits: 4)
    let p3 = Divergence.sentence(closed: 0, deliveries: 2, commits: 6)
    let p4 = Divergence.sentence(closed: 1, deliveries: 2, commits: 0)
    assertTrue(p1 != nil, "P1 (commits>0, entregas==0, fechados==0) tem de emitir")
    assertTrue(p2 != nil, "P2 (fechados>0, entregas==0) tem de emitir")
    assertTrue(p3 != nil, "P3 (entregas>0, fechados==0) tem de emitir")
    assertTrue(p4 != nil, "P4 (entregas>0, commits==0) tem de emitir")
    let sentences = Set([p1, p2, p3, p4].compactMap { $0 })
    assertEqual(sentences.count, 4, "as 4 frases têm de ser distintas entre si")
}

test("Divergence: os três > 0 (proporcional) — SILÊNCIO, o caso que uma implementação sempre-emite falha") {
    let sentence = Divergence.sentence(closed: 7, deliveries: 3, commits: 22)
    assertTrue(sentence == nil,
               "todos > 0 é o caso proporcional — uma frase aqui é o bug que o critério #9 existe para pegar")
}

test("Divergence: janela vazia (0,0,0) não é divergência — silêncio também") {
    assertTrue(Divergence.sentence(closed: 0, deliveries: 0, commits: 0) == nil,
               "nada aconteceu, nada para relatar")
}

test("Divergence: overlap entre P3 e P4 resolve por precedência — exatamente 1 frase, nunca 2") {
    // fechados=0, entregas=2, commits=0: casa tanto P3 (entregas>0 ∧ fechados==0)
    // quanto P4 (entregas>0 ∧ commits==0). A tabela manda P3 vencer.
    let sentence = Divergence.sentence(closed: 0, deliveries: 2, commits: 0)
    assertEqual(sentence, "entrega sem higiene de board", "P3 vence por precedência sobre P4")
}

test("ProgressSummary não expõe nenhum campo composto — só os 3 contadores + divergence") {
    let summary = ProgressSummary(window: .day24h,
                                   closedItems: ClosedItemsCount(closed: 1, missingClosedAt: 0),
                                   ledger: LedgerCount(count: 1, undated: 0, windowLabel: "hoje"),
                                   gitCommits: 1, gitAdded: 1, gitDeleted: 1, divergence: nil)
    // Regressão do critério #7 em texto: nenhuma destas palavras aparece no
    // arquivo fonte (checado via shell no T04-SUMMARY / lint command), este
    // assert cobre só que os campos individuais continuam acessíveis
    // separadamente (não hipoteticamente combinados aqui).
    assertEqual(summary.closedItems.closed, 1)
    assertEqual(summary.ledger.count, 1)
    assertEqual(summary.gitCommits, 1)
}

test("ProgressEngine.summarise: fixture end-to-end — cobertura declarada, rótulo 'hoje', dedupe de commits") {
    let calendar = Calendar(identifier: .gregorian)
    let now = ISO8601DateFormatter().date(from: "2026-07-30T12:00:00Z")!

    // 3 `done` legados sem closed_at (S01 backfill ainda não rodou neles) — a
    // contagem de fechados tem de ser 0, COM rótulo de cobertura, nunca um 0
    // silencioso.
    let items = (1...3).map { Item(id: "T\($0)", status: "done") }

    // 1 fragmento de hoje.
    let ledgerFragments = [
        LedgerFragment(id: "M001", completedDay: ProgressDate.dayString(now, calendar: calendar)),
    ]

    // Logs de 2 checkouts com um SHA compartilhado — o dedupe tem de contar 1.
    let shared = Commit(sha: "abc1234", epoch: Int(now.timeIntervalSince1970) - 60,
                        files: [FileStat(added: 5, deleted: 2, path: "src/a.swift")])
    let gitLogs = [[shared], [shared]]

    let summary = ProgressEngine.summarise(items: items, ledgerFragments: ledgerFragments,
                                            gitLogs: gitLogs, window: .day24h, now: now,
                                            calendar: calendar)

    assertEqual(summary.closedItems.closed, 0, "nenhum dos 3 tem closed_at — 0 é o número honesto")
    assertTrue(summary.closedItems.coverageLabel != nil,
               "critério #8: o rótulo tem de existir — o teste é sobre o RÓTULO, não o número bruto")
    assertEqual(summary.ledger.count, 1, "1 entrega hoje")
    assertEqual(summary.ledger.windowLabel, "hoje", "janela 24h rotula 'hoje' na fonte ledger (DS1)")
    assertEqual(summary.gitCommits, 1, "commit compartilhado entre 2 checkouts conta 1 vez (dedupe)")
    assertEqual(summary.gitAdded, 5)
    assertEqual(summary.gitDeleted, 2)
    // fechados==0, entregas==1>0 → P3 é o padrão coerente com este fixture.
    assertEqual(summary.divergence, "entrega sem higiene de board",
                "divergence tem de refletir as contagens reais do summary, não um valor solto")
}

// MARK: - ItemLabelFilter (S05)

test("ItemLabelFilter.apply: query nil devolve a lista inteira, nunca vazia") {
    let items = [Item(id: "1", labels: ["a"]), Item(id: "2", labels: nil)]
    let result = ItemLabelFilter.apply(items, query: nil)
    assertEqual(result.count, 2, "query nil não é filtro — devolve tudo")
    assertEqual(result.map { $0.id }, ["1", "2"], "ordem de entrada preservada")
}

test("ItemLabelFilter.apply: query vazia (\"\") devolve a lista inteira") {
    let items = [Item(id: "1", labels: ["a"]), Item(id: "2", labels: [])]
    let result = ItemLabelFilter.apply(items, query: "")
    assertEqual(result.count, 2)
}

test("ItemLabelFilter.apply: query só-espaço (\"   \") devolve a lista inteira") {
    let items = [Item(id: "1", labels: ["a"]), Item(id: "2", labels: nil)]
    let result = ItemLabelFilter.apply(items, query: "   ")
    assertEqual(result.count, 2, "espaço puro é ausência de filtro, não uma consulta vazia")
}

test("ItemLabelFilter.apply: prefixo — \"ui\" não casa item cujo único label é \"ui-bug\"") {
    let itemUI = Item(id: "1", labels: ["ui"])
    let itemUIBug = Item(id: "2", labels: ["ui-bug"])
    let result = ItemLabelFilter.apply([itemUI, itemUIBug], query: "ui")
    assertEqual(result.count, 1, "casamento exato de elemento — nunca substring")
    assertEqual(result.first?.id, "1", "só o item com o label exato \"ui\" sobrevive")
}

test("ItemLabelFilter.apply: case — \"Bug\" devolve 0 itens quando o único label é \"bug\"") {
    let items = [Item(id: "1", labels: ["bug"])]
    let result = ItemLabelFilter.apply(items, query: "Bug")
    assertEqual(result.count, 0, "sensível a maiúsculas, igual ao jq index()")
}

test("ItemLabelFilter.apply: item sem labels (nil) nunca casa") {
    let items = [Item(id: "1", labels: nil)]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 0)
}

test("ItemLabelFilter.apply: item com labels: [] nunca casa") {
    let items = [Item(id: "1", labels: [])]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 0)
}

test("ItemLabelFilter.apply: labels com espaço no disco casam trimados, vazio descartado") {
    let items = [Item(id: "1", labels: [" bug ", ""])]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 1, "\" bug \" trimado casa \"bug\"; \"\" nunca conta como label")
}

test("ItemLabelFilter.apply: item com status desconhecido casa normalmente (D-S05-2)") {
    let items = [Item(id: "1", status: "zzz", labels: ["bug"])]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 1, "o filtro é sobre label, não sobre status — a coluna Desconhecido também filtra")
}

test("ItemLabelFilter.matches: item sem labels retorna false") {
    assertFalse(ItemLabelFilter.matches(Item(id: "1", labels: nil), label: "bug"))
}

test("ItemLabelFilter.matches: casamento exato sensível a maiúsculas") {
    assertTrue(ItemLabelFilter.matches(Item(id: "1", labels: ["bug"]), label: "bug"))
    assertFalse(ItemLabelFilter.matches(Item(id: "1", labels: ["bug"]), label: "Bug"))
    assertFalse(ItemLabelFilter.matches(Item(id: "1", labels: ["ui-bug"]), label: "ui"))
}

test("ItemLabelFilter.normalise: nil, vazio e só-espaço devolvem nil") {
    assertNil(ItemLabelFilter.normalise(nil))
    assertNil(ItemLabelFilter.normalise(""))
    assertNil(ItemLabelFilter.normalise("   "))
    assertNil(ItemLabelFilter.normalise("\n\t "))
}

test("ItemLabelFilter.normalise: trima whitespace/newlines em torno de uma consulta real") {
    assertEqual(ItemLabelFilter.normalise("  bug\n"), "bug")
}

test("ItemLabelFilter.availableLabels: únicos, ordenados, sem vazios, sobre lista com repetição") {
    let items = [
        Item(id: "1", labels: ["bug", "ui"]),
        Item(id: "2", labels: ["ui", ""]),
        Item(id: "3", labels: nil),
        Item(id: "4", labels: [" bug "]),
    ]
    let result = ItemLabelFilter.availableLabels(items)
    assertEqual(result, ["bug", "ui"], "únicos, trimados, ordenados — sem duplicata entre \"bug\" e \" bug \"")
}

test("ItemLabelFilter.availableLabels: lista vazia de itens devolve lista vazia") {
    assertEqual(ItemLabelFilter.availableLabels([]), [])
}

// MARK: - Paridade do filtro por label (S05/T04)
//
// O criterio #5 exige que a contagem na tela seja IGUAL a contagem da CLI —
// divergencia de 1 card e falha. Provar isso comparando o filtro Swift contra
// uma reimplementacao em Swift seria tautologia (D-S05-6). Entao a prova mora
// num fixture unico, `app/fixtures/label-filter-parity.json`, lido por DOIS
// lados independentes:
//
//   - este arquivo assere ItemLabelFilter.apply(items, query: L).count ==
//     expected[L] para TODA chave de expected;
//   - scripts/forge-app-label-filter.test.js RECALCULA expected a partir dos
//     mesmos items com a expressao equivalente ao `jq index()` e ainda ancora
//     a forma de `labels` rodando o engine de verdade sobre um store temporario.
//
// Consequencia deliberada: afrouxar um valor de `expected` para fazer o lado
// Swift passar quebra o lado JS. Nao existe atalho verde aqui.
//
// O fixture vive em app/fixtures/, FORA de qualquer `path:` de target no
// Package.swift — um .json dentro de Sources/ForgeKitTests/ viraria recurso
// nao declarado.

struct LabelParityFixture: Decodable {
    let items: [Item]
    let expected: [String: Int]
}

/// Resolve o fixture por `#filePath` (main.swift -> ForgeKitTests -> Sources ->
/// app), com fallback para o cwd. Devolve `nil` se nenhum dos dois existir — e
/// o chamador FALHA nesse caso: um fixture nao encontrado nunca pode virar
/// teste que passa silenciosamente.
func labelParityFixtureURL() -> URL? {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .appendingPathComponent("fixtures/label-filter-parity.json")
    if FileManager.default.fileExists(atPath: fromSource.path) { return fromSource }

    let fromCwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("fixtures/label-filter-parity.json")
    if FileManager.default.fileExists(atPath: fromCwd.path) { return fromCwd }

    return nil
}

test("Paridade: o fixture de paridade existe e decodifica em [Item] + expected") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado nem por #filePath nem pelo cwd — " +
                          "um fixture ausente NAO pode virar teste verde")
        return
    }
    let data = try Data(contentsOf: url)
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: data)
    assertGreater(fixture.items.count, 0, "fixture.items nao pode ser vazio")
    assertGreater(fixture.expected.count, 0, "fixture.expected nao pode ser vazio")
}

test("Paridade: ItemLabelFilter.apply reproduz expected para TODO label do fixture") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — nao ha o que verificar, isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    for (label, count) in fixture.expected.sorted(by: { $0.key < $1.key }) {
        assertEqual(ItemLabelFilter.apply(fixture.items, query: label).count, count,
                    "paridade quebrada para o label \"\(label)\" — a contagem do filtro diverge do expected do fixture")
    }
}

test("Paridade: consulta vazia e nil devolvem a lista inteira do fixture (D-S05-4)") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    assertEqual(ItemLabelFilter.apply(fixture.items, query: "").count, fixture.items.count,
                "consulta vazia nao e filtro — tem de devolver tudo")
    assertEqual(ItemLabelFilter.apply(fixture.items, query: nil).count, fixture.items.count,
                "consulta nil nao e filtro — tem de devolver tudo")
    assertEqual(ItemLabelFilter.apply(fixture.items, query: "   ").count, fixture.items.count,
                "consulta so-espaco nao e filtro — tem de devolver tudo")
}

test("Paridade: o item de status desconhecido do fixture tambem e filtrado (D-S05-2)") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    let unknown = fixture.items.filter { $0.parsedStatus == nil }
    assertGreater(unknown.count, 0, "o fixture precisa de ao menos um item com status que o Swift nao reconhece")
    // Esse item carrega label; filtrar por ela tem de alcanca-lo — se o filtro
    // fosse aplicado por coluna, o item da coluna "Desconhecido" escaparia.
    for item in unknown {
        guard let label = item.labels?.first else {
            assertTrue(false, "o item de status desconhecido precisa carregar label, senao nao prova nada")
            continue
        }
        assertTrue(ItemLabelFilter.apply(fixture.items, query: label).contains(item),
                   "o item de status desconhecido \"\(item.id)\" sumiu ao filtrar por \"\(label)\"")
    }
}

test("Paridade: o par prefixo do fixture discrimina exato de substring (D-S05-1)") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    let all = ItemLabelFilter.availableLabels(fixture.items)

    // Achar o par (curto, longo) em que o curto e prefixo estrito do longo —
    // e ele que mata casamento por substring. Sem esse par, o fixture nao
    // detecta a regressao que existe para detectar.
    var pair: (String, String)? = nil
    for short in all {
        for long in all where long != short && long.hasPrefix(short) { pair = (short, long) }
    }
    guard let (short, long) = pair else {
        assertTrue(false, "o fixture nao tem par prefixo (ex.: \"ui\" / \"ui-bug\") — substring passaria despercebido")
        return
    }

    // Um casamento por substring devolveria os itens de AMBOS os labels para a
    // consulta curta; o casamento exato devolve so os do curto.
    let exact = ItemLabelFilter.apply(fixture.items, query: short)
    let substringLike = fixture.items.filter { ($0.labels ?? []).contains { $0.contains(short) } }
    assertGreater(substringLike.count, exact.count,
                  "o par \"\(short)\"/\"\(long)\" nao distingue exato de substring neste fixture")
    assertTrue(exact.allSatisfy { ($0.labels ?? []).contains(short) },
               "apply(query: \"\(short)\") trouxe item que nao tem exatamente esse label")
    assertFalse(exact.contains { ($0.labels ?? []).contains(long) && !($0.labels ?? []).contains(short) },
                "apply(query: \"\(short)\") vazou um item que so tem \"\(long)\" — isso e 1 card a mais que o jq")
}

// MARK: - ItemLaunch (S06)

print("\nItemLaunch (o board origina trabalho — e só pelo botão)")

test("ItemLaunch.decide: os 5 movimentos consecutivos produzem ZERO LaunchRequest (D9/F7)") {
    let a = Item(id: "I-20260801120001", status: "inbox")
    let b = Item(id: "I-20260801120002", status: "triaged")
    let c = Item(id: "I-20260801120003", status: "doing")
    let d = Item(id: "I-20260801120004", status: "done")
    let e = Item(id: "I-20260801120005", status: "dropped")
    let gestures: [BoardGesture] = [
        .move(a, to: .doing),
        .move(b, to: .triaged),
        .move(c, to: .done),
        .move(d, to: .dropped),
        .move(e, to: .inbox),
    ]
    let requests = gestures.compactMap(ItemLaunch.decide)
    assertEqual(requests.count, 0, "contra-critério D9/F7: 5 movimentos → 0 abas — este teste é a prova headless dele")
}

test("ItemLaunch.decide: .move de item com status desconhecido devolve nil") {
    let item = Item(id: "I-20260801120006", status: "zzz")
    assertNil(ItemLaunch.decide(.move(item, to: .doing)))
}

test("ItemLaunch.decide: .openDetail devolve nil para qualquer item") {
    let open = Item(id: "I-20260801120007", status: "inbox")
    let done = Item(id: "I-20260801120008", status: "done")
    let unknown = Item(id: "I-20260801120009", status: "zzz")
    assertNil(ItemLaunch.decide(.openDetail(open)))
    assertNil(ItemLaunch.decide(.openDetail(done)))
    assertNil(ItemLaunch.decide(.openDetail(unknown)))
}

test("ItemLaunch.decide: .start de item triaged bem-formado devolve request com taskArgument e slashCommand corretos") {
    let item = Item(id: "I-20260801120010", status: "triaged")
    guard let request = ItemLaunch.decide(.start(item)) else {
        assertTrue(false, "item aberto e bem-formado deveria produzir um LaunchRequest")
        return
    }
    assertEqual(request.taskArgument, item.id, "taskArgument tem de ser exatamente o id puro (D-S06-4)")
    assertEqual(request.slashCommand, "/forge-task \(item.id)")
}

test("ItemLaunch.decide: .start de item inbox e de item doing também devolvem request (os três abertos)") {
    let inboxItem = Item(id: "I-20260801120011", status: "inbox")
    let doingItem = Item(id: "I-20260801120012", status: "doing")
    assertTrue(ItemLaunch.decide(.start(inboxItem)) != nil, "inbox é status aberto — deve poder começar")
    assertTrue(ItemLaunch.decide(.start(doingItem)) != nil, "doing é status aberto — deve poder começar")
}

test("ItemLaunch.decide: .start de item done devolve nil e refusal cita --set-status e o id") {
    let item = Item(id: "I-20260801120013", status: "done")
    assertNil(ItemLaunch.decide(.start(item)))
    guard let msg = ItemLaunch.refusal(for: item) else {
        assertTrue(false, "item done precisa de uma frase de recusa")
        return
    }
    assertTrue(msg.contains("--set-status"), "a frase de recusa tem de citar --set-status")
    assertTrue(msg.contains(item.id), "a frase de recusa tem de citar o id do item")
}

test("ItemLaunch.decide: .start de item dropped devolve nil") {
    let item = Item(id: "I-20260801120014", status: "dropped")
    assertNil(ItemLaunch.decide(.start(item)))
}

test("ItemLaunch.decide: .start de item de status desconhecido devolve nil") {
    let item = Item(id: "I-20260801120015", status: "zzz")
    assertNil(ItemLaunch.decide(.start(item)))
}

test("ItemLaunch.decide: .start de id fora da shape devolve nil em todos os casos") {
    let malformed = [
        "itm-20260801120000-x",
        "I-",
        "I-2026 08",
        "I-20260801120000-x extra",
    ]
    for id in malformed {
        let item = Item(id: id, status: "inbox")
        assertNil(ItemLaunch.decide(.start(item)), "id malformado \"\(id)\" não pode originar trabalho")
    }
}

test("ItemLaunch.isWellFormedItemID: aceita prefixo curto e timestamp completo com slug") {
    assertTrue(ItemLaunch.isWellFormedItemID("I-20260729235447-aceitacao-gui"))
    assertTrue(ItemLaunch.isWellFormedItemID("I-2026072912"))
}

test("ItemLaunch.isWellFormedItemID: recusa os quatro exemplos malformados") {
    assertFalse(ItemLaunch.isWellFormedItemID("itm-20260801120000-x"))
    assertFalse(ItemLaunch.isWellFormedItemID("I-"))
    assertFalse(ItemLaunch.isWellFormedItemID("I-2026 08"))
    assertFalse(ItemLaunch.isWellFormedItemID("I-20260801120000-x extra"))
}

test("ItemLaunch.refusal: nil para item que pode começar") {
    let item = Item(id: "I-20260801120016", status: "triaged")
    assertNil(ItemLaunch.refusal(for: item))
}

// MARK: - Paridade de gestos do board (S06/T04)
//
// O contra-criterio D9/F7 (LOCKED) exige que 5 movimentos consecutivos pelo
// menu "Mover para" produzam ZERO abas. Provar isso comparando ItemLaunch
// contra uma reimplementacao em Swift seria tautologia (mesmo raciocinio de
// D-S05-6). A prova mora num fixture unico,
// `app/fixtures/board-gesture-launches.json`, lido por DOIS lados
// independentes:
//
//   - este arquivo aplica ItemLaunch.decide a cada gesto NA ORDEM e assere
//     que a lista resultante de slashCommand bate com expected_launches,
//     item a item;
//   - scripts/forge-app-launch-parity.test.js RECALCULA expected_launches a
//     partir de items+gestures com uma regra propria (sem ler este arquivo)
//     e ainda ancora a forma do id no engine real (`forge-items.js --add`
//     sobre um store temporario).
//
// Consequencia deliberada: afrouxar um valor de expected_launches para
// fazer este lado passar quebra o lado JS. Nao existe atalho verde aqui.
//
// O fixture vive em app/fixtures/, FORA de qualquer `path:` de target no
// Package.swift — um .json dentro de Sources/ForgeKitTests/ viraria recurso
// nao declarado.

struct GestureFixtureItem: Decodable {
    let id: String
    let title: String?
    let status: String?
    let origin: String?
    let created: String?
    let updated: String?
    let closed_at: String?
}

struct Gesture: Decodable {
    let kind: String
    let item: String
    let to: String?
}

struct GestureFixture: Decodable {
    let items: [GestureFixtureItem]
    let gestures: [Gesture]
    let expected_launches: [String]
}

/// Resolve o fixture por `#filePath` (main.swift -> ForgeKitTests -> Sources ->
/// app), com fallback para o cwd. Devolve `nil` se nenhum dos dois existir — e
/// o chamador FALHA nesse caso: um fixture nao encontrado nunca pode virar
/// teste que passa silenciosamente. Nome novo (nao reusa
/// `labelParityFixtureURL`, S05/T04) mesmo compartilhando a forma.
func gestureLaunchFixtureURL() -> URL? {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .appendingPathComponent("fixtures/board-gesture-launches.json")
    if FileManager.default.fileExists(atPath: fromSource.path) { return fromSource }

    let fromCwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("fixtures/board-gesture-launches.json")
    if FileManager.default.fileExists(atPath: fromCwd.path) { return fromCwd }

    return nil
}

/// Decodifica o fixture e devolve um `[String: Item]` (por id) + a lista de
/// `Gesture` + `expected_launches`. Falha (via `fatalError`) se o fixture nao
/// existir — chamado apenas dentro de `test(...)`, cujo harness ja escreve a
/// mensagem de falha antes de qualquer chamada aqui; um `fatalError` neste
/// ponto so aconteceria se o teste que verifica a existencia do fixture ja
/// tivesse sido pulado, o que este arquivo nunca faz.
func loadGestureFixture() throws -> (items: [String: Item], gestures: [Gesture], expectedLaunches: [String]) {
    guard let url = gestureLaunchFixtureURL() else {
        throw NSError(domain: "GestureFixture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "fixture board-gesture-launches.json nao encontrado nem por #filePath nem pelo cwd"
        ])
    }
    let data = try Data(contentsOf: url)
    let fixture = try JSONDecoder().decode(GestureFixture.self, from: data)
    var byId: [String: Item] = [:]
    for raw in fixture.items {
        byId[raw.id] = Item(
            id: raw.id, title: raw.title, status: raw.status, origin: raw.origin,
            created: raw.created, updated: raw.updated, closed_at: raw.closed_at
        )
    }
    return (byId, fixture.gestures, fixture.expected_launches)
}

/// Constroi o `BoardGesture` correspondente a uma entrada do fixture. Falha
/// (via `fatalError`) se `kind` for desconhecido ou se `item` nao existir em
/// `items` — um gesto que silenciosamente vira no-op mataria a prova.
func boardGesture(for g: Gesture, items: [String: Item]) -> BoardGesture {
    guard let item = items[g.item] else {
        fatalError("gesto referencia item \"\(g.item)\" que nao existe no fixture")
    }
    switch g.kind {
    case "move":
        guard let toRaw = g.to, let to = ItemStatus(rawValue: toRaw) else {
            fatalError("gesto move para \"\(g.to ?? "nil")\" nao e um ItemStatus valido")
        }
        return .move(item, to: to)
    case "drag":
        guard let toRaw = g.to, let to = ItemStatus(rawValue: toRaw) else {
            fatalError("gesto drag para \"\(g.to ?? "nil")\" nao e um ItemStatus valido")
        }
        return .drag(item, to: to)
    case "start":
        return .start(item)
    case "openDetail":
        return .openDetail(item)
    default:
        fatalError("gesto de kind desconhecido: \"\(g.kind)\"")
    }
}

test("Paridade de gestos: o fixture existe e decodifica em items + gestures + expected_launches") {
    guard gestureLaunchFixtureURL() != nil else {
        assertTrue(false, "fixture board-gesture-launches.json nao encontrado nem por #filePath nem pelo cwd — " +
                          "um fixture ausente NAO pode virar teste verde")
        return
    }
    let (items, gestures, expectedLaunches) = try loadGestureFixture()
    assertGreater(items.count, 0, "fixture.items nao pode ser vazio")
    assertGreater(gestures.count, 0, "fixture.gestures nao pode ser vazio")
    assertEqual(expectedLaunches.count, 1, "expected_launches do fixture tem de ter exatamente 1 entrada")
}

test("Paridade de gestos: ItemLaunch.decide aplicado NA ORDEM reproduz expected_launches item a item (D9/F7)") {
    guard gestureLaunchFixtureURL() != nil else {
        assertTrue(false, "fixture board-gesture-launches.json nao encontrado — isto e falha")
        return
    }
    let (items, gestures, expectedLaunches) = try loadGestureFixture()
    let boardGestures = gestures.map { boardGesture(for: $0, items: items) }
    let launches = boardGestures.compactMap(ItemLaunch.decide).map(\.slashCommand)
    assertEqual(launches, expectedLaunches,
                "paridade quebrada: a lista de launches produzida por ItemLaunch.decide diverge de expected_launches do fixture")
}

test("Paridade de gestos: o contra-criterio D9/F7 em voz alta — o prefixo dos 5 primeiros gestos produz ZERO launches") {
    guard gestureLaunchFixtureURL() != nil else {
        assertTrue(false, "fixture board-gesture-launches.json nao encontrado — isto e falha")
        return
    }
    let (items, gestures, _) = try loadGestureFixture()
    assertGreater(gestures.count, 4, "fixture precisa de pelo menos 5 gestos para exercitar o contra-criterio")
    let firstFive = Array(gestures.prefix(5))
    assertTrue(firstFive.allSatisfy { $0.kind == "move" },
               "os 5 primeiros gestos do fixture precisam ser todos \"move\" — o contra-criterio literal")
    let boardGestures = firstFive.map { boardGesture(for: $0, items: items) }
    let launches = boardGestures.compactMap(ItemLaunch.decide)
    assertEqual(launches.count, 0,
                "contra-criterio D9/F7: 5 movimentos consecutivos pelo menu \"Mover para\" tem de produzir ZERO LaunchRequest, produziu \(launches.count)")
}

// MARK: - Items (tokens visuais)

test("ItemStatus: os cinco status tem simbolo e tom, e nenhum simbolo se repete") {
    let symbols = ItemStatus.allCases.map(\.symbolName)
    assertEqual(symbols.count, 5, "esperados 5 status, vieram \(symbols.count)")
    assertEqual(Set(symbols).count, 5,
                "dois status compartilham o mesmo SF Symbol — a forma sozinha deixa de separar as colunas: \(symbols)")
    for s in ItemStatus.allCases {
        assert(!s.symbolName.isEmpty, "status \(s.rawValue) sem simbolo")
    }
}

test("ItemStatus: cada status tem tom proprio — nenhum par colide") {
    // `inbox` voltou a .neutral por decisao do operador (viu teal e indigo, e
    // recusou os dois). O que continua sendo propriedade: nenhum par de status
    // compartilha tom, senao a leitura por cor deixa de distinguir colunas.
    let tints = ItemStatus.allCases.map(\.tint)
    assertEqual(Set(tints).count, 5,
                "dois status compartilham tom: \(tints)")
    assertEqual(ItemStatus.doing.tint, ItemTint.orange, "doing continua sendo o unico tom quente")
    assertEqual(ItemStatus.done.tint, ItemTint.green, "done deveria ser verde")
}

test("ItemPriority: as quatro urgencias tem simbolo proprio e distinto") {
    let symbols = ItemPriority.allCases.map(\.symbolName)
    assertEqual(Set(symbols).count, 4,
                "duas prioridades compartilham simbolo — a leitura por forma deixa de funcionar: \(symbols)")
    for p in ItemPriority.allCases { assert(!p.symbolName.isEmpty, "\(p.rawValue) sem simbolo") }
}

test("ItemPriority: o tom e monotonico com a urgencia — p0 vermelho, p3 neutro") {
    assertEqual(ItemPriority.p0.tint, ItemTint.red, "p0 deveria ser vermelho")
    assertEqual(ItemPriority.p3.tint, ItemTint.neutral, "p3 nao deveria competir por atencao")
    assertEqual(Set(ItemPriority.allCases.map(\.tint)).count, 4,
                "duas prioridades compartilham tom — a triagem por cor deixa de funcionar")
}

test("labelTint: a paleta exclui neutral e red") {
    assert(!ItemCardPresentation.labelPalette.contains(.neutral),
           "um chip neutral e indistinguivel de um chip sem estilo")
    assert(!ItemCardPresentation.labelPalette.contains(.red),
           "vermelho e reservado a p0 — um label nao pode se passar por urgencia")
}

test("labelTint: determinismo — o mesmo texto sempre cai no mesmo tom") {
    for label in ["bug", "ui", "progresso", "parser", "d8", ""] {
        assertEqual(ItemCardPresentation.labelTint(label), ItemCardPresentation.labelTint(label),
                    "labelTint(\(label)) nao e deterministico")
    }
    // Regressao contra String.hashValue, que o Swift semeia por processo: se
    // alguem trocar FNV-1a por hashValue, estes valores fixos passam a variar
    // entre execucoes e o operador nunca aprende a cor.
    func fnv(_ s: String) -> ItemTint {
        var h: UInt32 = 2_166_136_261
        for b in Array(s.utf8) { h ^= UInt32(b); h = h &* 16_777_619 }
        return ItemCardPresentation.labelPalette[Int(h % UInt32(ItemCardPresentation.labelPalette.count))]
    }
    for label in ["bug", "ui", "progresso", "parser", "d8"] {
        assertEqual(ItemCardPresentation.labelTint(label), fnv(label),
                    "labelTint deixou de derivar de FNV-1a sobre os bytes utf8")
    }
}

test("labelTint: os labels reais do repo nao colapsam num tom so") {
    // A soma de escalares (primeira tentativa) jogava bug/ui/progresso/d8 todos
    // no mesmo slot — 4 de 5 iguais, o que anula a leitura por cor. Este teste
    // e a medida que reprovou aquela implementacao, nao uma formalidade.
    let labels = ["bug", "ui", "progresso", "parser", "d8"]
    let tints = Set(labels.map(ItemCardPresentation.labelTint))
    assert(tints.count >= 4,
           "\(labels.count) labels reais colapsaram em \(tints.count) tom(ns) — a cor deixa de distinguir: \(labels.map { "\($0)=\(ItemCardPresentation.labelTint($0).rawValue)" })")
}

test("shortID: devolve o slug de um id completo") {
    assertEqual(ItemCardPresentation.shortID("I-20260730202553-card-item-7-elementos"),
                "card-item-7-elementos",
                "o slug e a metade legivel do id")
}

test("shortID: sem slug cai nos ultimos 6 digitos do timestamp") {
    assertEqual(ItemCardPresentation.shortID("I-20260730202553"), "202553",
                "id sem slug deveria virar os ultimos 6 digitos")
}

test("shortID: id fora da forma I-<digitos>-<slug> volta inteiro, nunca mutilado") {
    assertEqual(ItemCardPresentation.shortID("TASK-017"), "TASK-017", "prefixo desconhecido deveria voltar inteiro")
    assertEqual(ItemCardPresentation.shortID("I-naodigito-slug"), "I-naodigito-slug",
                "timestamp nao numerico deveria voltar inteiro")
    assertEqual(ItemCardPresentation.shortID(""), "", "string vazia deveria voltar inteira")
}

// MARK: - Markdown (blocos)

test("markdown: paragrafos separados por linha em branco viram blocos distintos") {
    let b = MarkdownDoc.blocks("Primeiro.\n\nSegundo.")
    assertEqual(b.count, 2, "esperados 2 paragrafos, vieram \(b.count): \(b)")
    assertEqual(b, [.paragraph("Primeiro."), .paragraph("Segundo.")])
}

test("markdown: linhas consecutivas se juntam num paragrafo so") {
    assertEqual(MarkdownDoc.blocks("uma linha\noutra linha"), [.paragraph("uma linha outra linha")])
}

test("markdown: heading exige espaco depois dos hashes — #hashtag nao e heading") {
    assertEqual(MarkdownDoc.blocks("## Titulo"), [.heading(level: 2, text: "Titulo")])
    assertEqual(MarkdownDoc.blocks("#hashtag"), [.paragraph("#hashtag")],
                "#hashtag sem espaco tem de continuar paragrafo")
}

test("markdown: bullets viram UM bloco com os itens") {
    assertEqual(MarkdownDoc.blocks("- um\n- dois\n- tres"),
                [.bullets(["um", "dois", "tres"])])
}

test("markdown: *enfase* no inicio da linha NAO vira bullet") {
    assertEqual(MarkdownDoc.blocks("*enfase* no comeco"), [.paragraph("*enfase* no comeco")],
                "o marcador de bullet exige espaco — senao toda enfase inicial vira lista")
}

test("markdown: lista numerada") {
    assertEqual(MarkdownDoc.blocks("1. um\n2. dois"), [.numbered(["um", "dois"])])
}

test("markdown: fence preserva o conteudo VERBATIM — # e - la dentro sao codigo") {
    let src = "```swift\n# nao e heading\n- nao e bullet\n```"
    assertEqual(MarkdownDoc.blocks(src),
                [.code(language: "swift", text: "# nao e heading\n- nao e bullet")],
                "um diff colado no corpo nao pode ser mastigado como heading/bullet")
}

test("markdown: fence sem linguagem e fence nao fechado nao crasham") {
    assertEqual(MarkdownDoc.blocks("```\nx\n```"), [.code(language: nil, text: "x")])
    assertEqual(MarkdownDoc.blocks("```\nsem fim"), [.code(language: nil, text: "sem fim")],
                "fence nao fechado deveria consumir ate o fim, nao perder o conteudo")
}

test("markdown: regra horizontal e citacao") {
    assertEqual(MarkdownDoc.blocks("---"), [.rule])
    assertEqual(MarkdownDoc.blocks("> citado\n> em duas"), [.quote("citado em duas")])
}

test("markdown: --- e reconhecido como regra, nao como bullet") {
    let b = MarkdownDoc.blocks("antes\n\n---\n\ndepois")
    assertEqual(b, [.paragraph("antes"), .rule, .paragraph("depois")])
}

test("markdown: corpo vazio produz zero blocos") {
    assertEqual(MarkdownDoc.blocks(""), [])
    assertEqual(MarkdownDoc.blocks("\n\n   \n"), [])
}

test("markdown: documento misto na ordem do documento") {
    let src = "# Titulo\n\nUm paragrafo.\n\n- a\n- b\n\n```\ncodigo\n```\n\nFim."
    assertEqual(MarkdownDoc.blocks(src),
                [.heading(level: 1, text: "Titulo"),
                 .paragraph("Um paragrafo."),
                 .bullets(["a", "b"]),
                 .code(language: nil, text: "codigo"),
                 .paragraph("Fim.")])
}

// MARK: - Idade e checklist do card

test("checklist: conta [ ] e [x] do corpo") {
    let r = MarkdownDoc.checklist("- [x] feito\n- [ ] pendente\n- [ ] outro")
    assertEqual(r?.done, 1)
    assertEqual(r?.total, 3)
}

test("checklist: bullets normais nao contam") {
    assertNil(MarkdownDoc.checklist("- so um bullet\n- outro"))
}

test("checklist: um [ ] DENTRO de fence e literal, nao checkbox") {
    // Grepar a fonte crua contaria; blocks() preserva fence verbatim, entao o
    // filtro por .bullets ganha essa propriedade de graca.
    assertNil(MarkdownDoc.checklist("```\n- [ ] isso e exemplo de codigo\n```"),
              "checkbox dentro de fence nao pode ser contado")
}

test("checklist: corpo vazio ou nil devolve nil") {
    assertNil(MarkdownDoc.checklist(nil))
    assertNil(MarkdownDoc.checklist(""))
}

test("age: escala de agora ate meses, com now injetado") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    func item(_ iso: String) -> Item { Item(id: "I-1", title: "t", status: "inbox", created: iso) }
    assertEqual(ItemCardPresentation.age(for: item("2026-08-02T11:59:30.000Z"), now: base), "agora")
    assertEqual(ItemCardPresentation.age(for: item("2026-08-02T11:30:00.000Z"), now: base), "30min")
    assertEqual(ItemCardPresentation.age(for: item("2026-08-02T09:00:00.000Z"), now: base), "3h")
    assertEqual(ItemCardPresentation.age(for: item("2026-07-28T12:00:00.000Z"), now: base), "5d")
    assertEqual(ItemCardPresentation.age(for: item("2026-07-05T12:00:00.000Z"), now: base), "4sem")
}

test("age: created ausente, ilegivel ou no futuro devolve nil") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    assertNil(ItemCardPresentation.age(for: Item(id: "I-1", title: "t", status: "inbox"), now: base))
    assertNil(ItemCardPresentation.age(for: Item(id: "I-1", title: "t", status: "inbox", created: "lixo"), now: base))
    assertNil(ItemCardPresentation.age(for: Item(id: "I-1", title: "t", status: "inbox",
                                                 created: "2026-09-01T12:00:00.000Z"), now: base),
              "timestamp no futuro deveria devolver nil — 'ha -2d' e pior que nada")
}

// MARK: - Arrastar card e tom da idade

test("contra-criterio D9/F7 vale para o ARRASTAR igual ao menu — 5 drags, 0 launches") {
    let item = Item(id: "I-20260801120000-aberto", title: "Aberto", status: "doing")
    var launches: [LaunchRequest] = []
    for _ in 0..<5 {
        if let r = ItemLaunch.decide(.drag(item, to: .done)) { launches.append(r) }
    }
    assertEqual(launches.count, 0,
                "arrastar e organizar: 5 drags consecutivos tem de produzir ZERO LaunchRequest, produziu \(launches.count)")
}

test("drag nao olha o item — nem um item perfeitamente elegivel dispara") {
    // Mesma propriedade que .move: a recusa e estrutural, nao condicional.
    let elegivel = Item(id: "I-20260801120000-ok", title: "Ok", status: "doing",
                        body: "corpo", labels: ["bug"], priority: "p0")
    assertNil(ItemLaunch.decide(.drag(elegivel, to: .done)),
              "drag de item elegivel ainda assim nao pode disparar trabalho")
}

test("ageTint: fica mais alto conforme a tarefa envelhece") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    func item(_ iso: String, _ status: String = "inbox") -> Item {
        Item(id: "I-1", title: "t", status: status, created: iso)
    }
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-08-02T06:00:00.000Z"), now: base), ItemTint.neutral)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-08-01T00:00:00.000Z"), now: base), ItemTint.blue)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-07-30T12:00:00.000Z"), now: base), ItemTint.yellow)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-07-24T12:00:00.000Z"), now: base), ItemTint.orange)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-07-01T12:00:00.000Z"), now: base), ItemTint.red)

    // A rampa tem de ser MONOTONICA: mais velho nunca pode ficar mais calmo.
    let ordem: [ItemTint] = [.neutral, .blue, .yellow, .orange, .red]
    let amostras = ["2026-08-02T06:00:00.000Z", "2026-08-01T00:00:00.000Z",
                    "2026-07-30T12:00:00.000Z", "2026-07-24T12:00:00.000Z",
                    "2026-07-01T12:00:00.000Z"]
    let obtidos = amostras.map { ItemCardPresentation.ageTint(for: item($0), now: base) }
    assertEqual(obtidos, ordem, "a rampa de idade deixou de ser calma -> urgente sem inversao")
}

test("ageTint: tarefa fechada nunca grita, por mais velha que seja") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    for st in ["done", "dropped"] {
        let velha = Item(id: "I-1", title: "t", status: st, created: "2025-01-01T12:00:00.000Z")
        assertEqual(ItemCardPresentation.ageTint(for: velha, now: base), ItemTint.neutral,
                    "status \(st): idade de item fechado e historia — gritar treina o operador a ignorar a cor")
    }
}

test("ageTint: created ausente devolve neutral, nunca crasha") {
    assertEqual(ItemCardPresentation.ageTint(for: Item(id: "I-1", title: "t", status: "inbox")), ItemTint.neutral)
}

// MARK: - Bloqueio

test("blockedCount: conta os ids e ignora vazios") {
    let it = Item(id: "I-1", title: "t", status: "doing", blocked_by: ["I-a", " ", "I-b", ""])
    assertEqual(ItemCardPresentation.blockedCount(it), 2, "ids em branco nao contam")
}

test("blockedCount: sem blocked_by, ou lista vazia, devolve nil e nao zero") {
    assertNil(ItemCardPresentation.blockedCount(Item(id: "I-1", title: "t", status: "doing")))
    assertNil(ItemCardPresentation.blockedCount(Item(id: "I-1", title: "t", status: "doing", blocked_by: [])))
    assertNil(ItemCardPresentation.blockedCount(Item(id: "I-1", title: "t", status: "doing", blocked_by: ["  "])),
              "so espaco em branco nao e bloqueio")
}

test("blockedCount: item fechado nunca aparece bloqueado") {
    for st in ["done", "dropped"] {
        let it = Item(id: "I-1", title: "t", status: st, blocked_by: ["I-a", "I-b"])
        assertNil(ItemCardPresentation.blockedCount(it),
                  "status \(st): ja entregou — bloqueio virou historia, e badge vermelho em card fechado e ruido")
    }
}

// MARK: - Texto dos recibos

test("shortTitle: titulo curto passa inteiro") {
    let it = Item(id: "I-1", title: "Corrigir o parser", status: "inbox")
    assertEqual(ItemCardPresentation.shortTitle(it), "Corrigir o parser")
}

test("shortTitle: corta em fronteira de palavra quando ha uma no ultimo terco") {
    let it = Item(id: "I-1", title: "Criacao anonima de pedido sem rate limit", status: "inbox")
    let out = ItemCardPresentation.shortTitle(it, max: 28)
    assertTrue(out.hasSuffix("…"), "deveria sinalizar corte")
    assertFalse(out.contains("  "), "nao deveria sobrar espaco duplo antes das reticencias")
    assertTrue(out.count <= 29, "passou do teto: \(out.count) — \(out)")
    assertFalse(out.dropLast().hasSuffix(" "), "nao deveria terminar em espaco antes das reticencias")
}

test("shortTitle: sem espaco no ultimo terco corta seco, sem perder o teto") {
    let it = Item(id: "I-1", title: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "inbox")
    let out = ItemCardPresentation.shortTitle(it, max: 10)
    assertEqual(out, "AAAAAAAAAA…")
}

test("shortTitle: item sem titulo cai no fallback, nao em string vazia") {
    assertEqual(ItemCardPresentation.shortTitle(Item(id: "I-1", title: "   ", status: "inbox")),
                ItemCardPresentation.missingTitle)
}

// MARK: - Busca de projeto

test("ProjectFilter: busca vazia devolve tudo, nunca nada") {
    let ps = ["/a/forge-agent", "/b/lookchina"]
    assertEqual(ProjectFilter.matches(ps, query: ""), ps)
    assertEqual(ProjectFilter.matches(ps, query: "   "), ps,
                "caixa de busca em branco significa SEM filtro, nao SEM resultado")
}

test("ProjectFilter: casa pelo nome exibido e tambem pelo caminho") {
    let ps = ["/Users/x/work/forge-agent", "/Users/x/side/lookchina"]
    assertEqual(ProjectFilter.matches(ps, query: "forge"), ["/Users/x/work/forge-agent"])
    assertEqual(ProjectFilter.matches(ps, query: "side"), ["/Users/x/side/lookchina"],
                "quem lembra onde o projeto mora tem de conseguir achar pelo caminho")
}

test("ProjectFilter: ignora caixa e acento") {
    let ps = ["/a/Metricas-Painel", "/b/outro"]
    assertEqual(ProjectFilter.matches(ps, query: "MÉTRICAS"), ["/a/Metricas-Painel"],
                "ninguem digita acento numa caixa de busca")
}

test("ProjectFilter: preserva a ordem de entrada") {
    let ps = ["/z/alfa-x", "/a/alfa-y"]
    assertEqual(ProjectFilter.matches(ps, query: "alfa"), ps,
                "a ordem e a que o operador registrou; reordenar aqui seria decisao escondida")
}

test("ProjectFilter: sem casamento devolve lista vazia") {
    assertEqual(ProjectFilter.matches(["/a/forge-agent"], query: "zzz"), [])
}

// MARK: - Busca livre no board

private func searchFixture() -> [Item] {
    [Item(id: "I-20260801120001-parser", title: "Corrigir o parser de datas", status: "inbox",
          labels: ["bug"]),
     Item(id: "I-20260801120002-sem-label", title: "Tarefa sem label nenhum", status: "doing"),
     Item(id: "I-20260801120003-outro", title: "Métricas do painel", status: "inbox")]
}

test("ItemSearch: acha por titulo, que e o caso que o filtro de label nao cobre") {
    let r = ItemSearch.apply(searchFixture(), query: "parser")
    assertEqual(r.count, 1)
    assertEqual(r.first?.id, "I-20260801120001-parser")
}

test("ItemSearch: acha item SEM label — o cenario que tornava o campo inutil") {
    let r = ItemSearch.apply(searchFixture(), query: "sem label")
    assertEqual(r.count, 1, "um item sem labels tem de continuar alcancavel pela busca")
}

test("ItemSearch: acha por id e por label") {
    assertEqual(ItemSearch.apply(searchFixture(), query: "120003").count, 1)
    assertEqual(ItemSearch.apply(searchFixture(), query: "bug").count, 1)
}

test("ItemSearch: ignora caixa e acento") {
    assertEqual(ItemSearch.apply(searchFixture(), query: "METRICAS").count, 1,
                "ninguem digita acento numa caixa de busca")
}

test("ItemSearch: busca vazia devolve tudo") {
    assertEqual(ItemSearch.apply(searchFixture(), query: "").count, 3)
    assertEqual(ItemSearch.apply(searchFixture(), query: nil).count, 3)
    assertEqual(ItemSearch.apply(searchFixture(), query: "   ").count, 3)
}

test("ItemSearch NAO substitui ItemLabelFilter — a regra exata do criterio #5 segue intacta") {
    // ItemSearch e substring; ItemLabelFilter e igualdade de elemento. Confundir
    // os dois faria "ui" casar "ui-bug", que e a divergencia de 1 card que o
    // criterio #5 chama de falha.
    let its = [Item(id: "I-1", title: "t", status: "inbox", labels: ["ui-bug"])]
    assertEqual(ItemLabelFilter.apply(its, query: "ui").count, 0,
                "ItemLabelFilter continua exato")
    assertEqual(ItemSearch.apply(its, query: "ui").count, 1,
                "ItemSearch e substring de proposito — sao regras diferentes, e as duas existem")
}

print("\n" + String(repeating: "─", count: 60))
print("  \(passed) passed, \(failed) failed")
if failed > 0 {
    print("\nFalhas:")
    for f in failures { print("  ✗ \(f.0)\n      \(f.1)") }
}
print("")
exit(failed > 0 ? 1 : 0)
