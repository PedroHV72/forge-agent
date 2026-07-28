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

test("parseRepoPath aceita o formato .md legado") {
    assertEqual(PrefsLocator.parseRepoPath("repo_path: /legado/forge"), "/legado/forge")
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


print("\n" + String(repeating: "─", count: 60))
print("  \(passed) passed, \(failed) failed")
if failed > 0 {
    print("\nFalhas:")
    for f in failures { print("  ✗ \(f.0)\n      \(f.1)") }
}
print("")
exit(failed > 0 ? 1 : 0)
