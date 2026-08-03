#!/usr/bin/env node
'use strict';

// forge-ownership.test.js — reads shared/forge-ownership.md at run time and
// derives its test cases from the table, instead of duplicating it in code.
// Editing a row of the table changes what this suite requires, without ever
// touching this file.
//
// Order matters here (SCOPE #8 / CONTEXT D1): T01 introduces no hierarchy
// code. This suite only pins the pre-existing `resolveOwner()` behaviour in
// `scripts/forge-workspace.js` against a written contract.
//
// Zero deps. Standalone runner, repo convention: `process.exit(failed ? 1 : 0)`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { WORK_ENTRIES, resolveOwner } = require('./forge-workspace.js');

const repoRoot = path.resolve(__dirname, '..');
const tablePath = path.join(repoRoot, 'shared', 'forge-ownership.md');

/** Below this many data rows, the table cannot cover the cases the plan pins. */
const MIN_ROWS = 8;

const START_DELIM = '<!-- ownership-table:start -->';
const END_DELIM = '<!-- ownership-table:end -->';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── Parser ───────────────────────────────────────────────────────────────

/**
 * Extract `{ query, stopAt, shape, owner, why }` rows from the markdown table
 * between the stable delimiters. Throws — never returns an empty array — when
 * the block is missing, so a broken parser cannot silently pass.
 */
function parseOwnershipTable(markdown) {
  const startIdx = markdown.indexOf(START_DELIM);
  const endIdx = markdown.indexOf(END_DELIM);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(
      `forge-ownership.test: delimitadores ${START_DELIM} / ${END_DELIM} não encontrados em ${tablePath}`);
  }

  const block = markdown.slice(startIdx + START_DELIM.length, endIdx);
  const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Drop the header row and the `|---|---|---|---|` separator row.
  const dataLines = lines.filter((l, i) => {
    if (i === 0) return false; // header
    if (/^\|[\s:|-]+\|$/.test(l)) return false; // separator
    return l.startsWith('|');
  });

  const rows = dataLines.map((line, i) => {
    // `| a | b | c | d |` → ['a', 'b', 'c', 'd'] (drop the empty edges from split)
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 4) {
      throw new Error(`forge-ownership.test: linha de tabela malformada (${cells.length} colunas): "${line}"`);
    }
    const [queryRaw, shapeRaw, ownerRaw, whyRaw] = cells;

    // `WS/foo :: stopAt=WS/bar` → query `WS/foo`, stopAt `WS/bar`.
    let query = queryRaw;
    let stopAt = null;
    const stopMatch = queryRaw.match(/^(.*?)\s*::\s*stopAt=(.+)$/);
    if (stopMatch) {
      query = stopMatch[1].trim();
      stopAt = unwrapCode(stopMatch[2].trim());
    }
    query = unwrapCode(query);

    const owner = unwrapCode(ownerRaw);

    return {
      index: i,
      query,
      stopAt,
      shape: shapeRaw,
      owner: owner === '—' ? null : normalizeWsPath(owner), // "—" means no owner
      why: whyRaw,
    };
  });

  if (rows.length < MIN_ROWS) {
    throw new Error(
      `forge-ownership.test: tabela tem ${rows.length} linhas de dados, mínimo exigido é ${MIN_ROWS}`);
  }

  return rows;
}

/** Strip a single layer of `` `code` `` markup, if present. */
function unwrapCode(s) {
  const m = s.match(/^`([^`]*)`$/);
  return m ? m[1] : s;
}

/** `WS/` and `WS` denote the same node — normalize the trailing slash away. */
function normalizeWsPath(p) {
  if (p === 'WS/' ) return 'WS';
  if (p.endsWith('/')) return p.slice(0, -1);
  return p;
}

// ── Fixture ──────────────────────────────────────────────────────────────

/**
 * Builds the tree the table's "Forma no disco" column describes, reproducing
 * the measured shape of `lookchina`: `.gsd/` with a work artifact at the
 * workspace root, `.gsd/` EMPTY at the intermediate `services/` node, `.gsd/`
 * with a work artifact at member repos, and sibling directories
 * (`scripts/`, `libs/`, `infra/`) with no `.gsd/` at all.
 *
 * Substance is materialized with a real `WORK_ENTRIES` element (imported, not
 * reinvented) so the fixture cannot drift from what the detector actually
 * checks for.
 */
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ownership-'));
  const ws = path.join(root, 'WS');
  const outsideRoot = path.join(root, 'outside-tree');

  const substanceEntry = WORK_ENTRIES[0]; // 'milestones' — a real work artifact
  assert(typeof substanceEntry === 'string' && substanceEntry.length > 0,
    'WORK_ENTRIES[0] deve ser uma string não vazia — fixture depende dela para provar substância');

  function makeProject(dir) {
    fs.mkdirSync(path.join(dir, '.gsd', substanceEntry), { recursive: true });
  }

  function makeTouched(dir) {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true }); // empty .gsd/
  }

  function makePlain(dir) {
    fs.mkdirSync(dir, { recursive: true }); // no .gsd/ at all
  }

  // WS/ — workspace root, project (has substance).
  makeProject(ws);

  // WS/services/freyr — registered member, project (has substance).
  const freyr = path.join(ws, 'services', 'freyr');
  makeProject(freyr);

  // WS/services/freyr/src/deep — deep subdirectory inside the member, no .gsd/.
  makePlain(path.join(freyr, 'src', 'deep'));

  // WS/scripts, WS/libs, WS/infra — siblings with no .gsd/ at all.
  makePlain(path.join(ws, 'scripts'));
  makePlain(path.join(ws, 'libs'));
  makePlain(path.join(ws, 'infra'));

  // WS/services — has .gsd/, but EMPTY (touched, not project).
  makeTouched(path.join(ws, 'services'));

  // outside-tree/outside/somewhere — entirely outside WS/, no .gsd/ anywhere
  // up to root.
  makePlain(path.join(outsideRoot, 'outside', 'somewhere'));

  return { root, ws, outsideRoot };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

/** Resolve a table's `WS/`-relative (or arbitrary outside) query to a real path. */
function resolveQueryPath(query, fixture) {
  if (query === 'WS' || query === 'WS/') return fixture.ws;
  if (query.startsWith('WS/')) return path.join(fixture.ws, query.slice('WS/'.length));
  // Anything not rooted at WS/ (e.g. "/outside/somewhere") is materialized
  // under a sibling tree that never touches WS/, so it truly has no project
  // ancestor.
  const rel = query.replace(/^\//, '');
  return path.join(fixture.outsideRoot, rel);
}

// ── Comparator (pure, reused for the mutation self-check) ────────────────

/**
 * `(rows, resolveFn) -> { ok, failures }`. Pure: takes the table rows and a
 * function that maps a resolved row to its actual owner, and reports every
 * row whose actual owner disagrees with the row's declared owner. Structured
 * this way so it can be pointed at both the real table and a mutated in-memory
 * copy — the mutation self-check below reuses this exact function.
 */
function compareRows(rows, resolveFn) {
  const rowFailures = [];
  for (const row of rows) {
    const actual = resolveFn(row);
    if (actual !== row.owner) {
      rowFailures.push({
        index: row.index,
        query: row.query,
        expected: row.owner,
        actual,
      });
    }
  }
  return { ok: rowFailures.length === 0, failures: rowFailures };
}

// ── Suite ──────────────────────────────────────────────────────────────

console.log('\nTabela de posse nearest-project-wins (forge-ownership.md ⇄ resolveOwner)');

const markdown = fs.readFileSync(tablePath, 'utf8');
const rows = parseOwnershipTable(markdown);

test(`a tabela produz pelo menos ${MIN_ROWS} linhas de dados`, () => {
  assert(rows.length >= MIN_ROWS, `esperado >= ${MIN_ROWS}, obtido ${rows.length}`);
});

test('cada linha tem query, dono (ou null) e explicação', () => {
  for (const row of rows) {
    assert(row.query.length > 0, `linha ${row.index}: query vazia`);
    assert(row.why.length > 0, `linha ${row.index}: explicação vazia`);
    assert(row.owner === null || row.owner.length > 0, `linha ${row.index}: dono malformado`);
  }
});

test('a tabela cobre os casos ambíguos nomeados pelo CONTEXT D1', () => {
  const queries = rows.map(r => r.query);
  for (const required of ['WS/scripts', 'WS/libs', 'WS/infra', 'WS/services']) {
    assert(queries.includes(required), `linha para "${required}" ausente da tabela`);
  }
  const freyrDeep = queries.find(q => q.startsWith('WS/services/freyr'));
  assert(freyrDeep, 'nenhuma linha exercita um membro (freyr) ou um subdiretório dele');
  const stopAtRow = rows.find(r => r.stopAt !== null);
  assert(stopAtRow, 'nenhuma linha exercita a opção stopAt de resolveOwner()');
});

let fixture;
try {
  fixture = buildFixture();

  const resolveFn = row => {
    const abs = resolveQueryPath(row.query, fixture);
    const opts = row.stopAt ? { stopAt: resolveQueryPath(row.stopAt, fixture) } : undefined;
    const owner = resolveOwner(abs, opts);
    if (owner === null) return null;
    // Compare relative to WS/ so the assertion messages stay readable and the
    // tmpdir's random suffix never leaks into a failure diff.
    if (owner === fixture.ws) return 'WS';
    if (owner.startsWith(fixture.ws + path.sep)) {
      return 'WS/' + path.relative(fixture.ws, owner).split(path.sep).join('/');
    }
    return owner; // outside WS/ entirely — should not happen for a non-null case here
  };

  test('resolveOwner() concorda com o dono declarado em toda linha da tabela', () => {
    const { ok, failures: rowFailures } = compareRows(rows, resolveFn);
    assert(ok, 'divergências:\n' + rowFailures.map(f =>
      `    linha ${f.index} "${f.query}": esperado ${JSON.stringify(f.expected)}, obtido ${JSON.stringify(f.actual)}`
    ).join('\n'));
  });

  test('nenhum caminho sob o HOME real do operador aparece nas asserções', () => {
    const home = os.homedir();
    for (const row of rows) {
      assert(!row.query.includes(home), `linha ${row.index} referencia o HOME real: "${row.query}"`);
    }
    assert(!fixture.root.startsWith(path.join(home, 'Development')),
      'a fixture não deve viver sob ~/Development do operador');
  });

  // ── Mutation self-check (mandatory) ─────────────────────────────────────
  //
  // Prove the comparator is not vacuously green by mutating ONE row's declared
  // owner to a different, real, but WRONG path — additive/substitutive, never
  // subtractive (removing a row can no-op and pass for the wrong reason, the
  // lesson carried over from S02). Then assert the comparator reports it.
  test('mutar o dono de UMA linha reprova o comparador (self-check de mutação)', () => {
    const mutIndex = rows.findIndex(r => r.owner === 'WS'); // a row with a real, resolvable owner
    assert(mutIndex !== -1, 'nenhuma linha com dono "WS" para mutar');

    const mutatedRows = rows.map((r, i) => {
      if (i !== mutIndex) return r;
      // Replace the correct owner with a DIFFERENT existing directory that is
      // provably the wrong answer for this query — freyr is never the owner
      // of a row whose real owner is WS.
      return Object.assign({}, r, { owner: 'WS/services/freyr' });
    });

    const { ok, failures: rowFailures } = compareRows(mutatedRows, resolveFn);
    assert(!ok, 'o comparador deveria reprovar com uma linha mutada, mas passou (guarda inerte)');
    assert(rowFailures.some(f => f.index === mutIndex),
      'a linha mutada não apareceu entre as falhas reportadas');
  });

  test('quebrar o parser (zero linhas) não pode passar — bloco ausente lança', () => {
    let threw = false;
    try {
      parseOwnershipTable('# markdown sem os delimitadores\n\nnada aqui.\n');
    } catch (e) {
      threw = true;
      assert(/delimitadores/.test(e.message), `mensagem inesperada: ${e.message}`);
    }
    assert(threw, 'parseOwnershipTable deveria lançar quando os delimitadores estão ausentes');
  });

  test('tabela com menos linhas que MIN_ROWS lança', () => {
    const shortBlock = START_DELIM + '\n' +
      '| Caminho consultado | Forma no disco | Dono | Por quê |\n' +
      '|---|---|---|---|\n' +
      '| `WS/` | tem substância | `WS/` | raiz é dona de si |\n' +
      END_DELIM + '\n';
    let threw = false;
    try {
      parseOwnershipTable(shortBlock);
    } catch (e) {
      threw = true;
      assert(/mínimo exigido/.test(e.message), `mensagem inesperada: ${e.message}`);
    }
    assert(threw, 'parseOwnershipTable deveria lançar quando há menos linhas que MIN_ROWS');
  });
} finally {
  if (fixture) cleanupFixture(fixture);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
