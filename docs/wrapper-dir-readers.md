# Wrapper-directory readers

This document records the measured D11 inventory for the two wrapper roots:
`.gsd/milestones` and `.gsd/tasks`. It is deliberately paired with
`scripts/forge-wrapper-readers.test.js`; prose does not certify coverage.

## Method

The standalone test lists real `scripts/*.js` files, explicitly excludes
`*.test.js`, and reads every remaining source file. It discovers a direct
candidate when source both anchors a `.gsd/milestones` or `.gsd/tasks` path and
uses `readdirSync`. It also retains D11's named reader set while its concrete
path evidence remains in source: those scripts select one unit or enumerate a
delegated directory, and were the original research starting point. The test
compares that discovered set with the registry in both directions.

The second direction matters: a deleted script, a renamed script, or a script
that no longer has reader-shaped source is an obsolete inventory entry. Error
messages list every filename rather than reporting a count.

`forge-verifier` and `forge-parallelism` style scans of a selected
`.gsd/milestones/<id>/slices/.../tasks` directory are not root-wrapper
enumerators. They are documented here only when D11 named them, so the registry
can say why their constrained path is safe.

## Verdicts

| File | Dirs | Evidence | Verdict | Reason |
| --- | --- | --- | --- | --- |
| forge-dashboard.js | milestones | L54 enumerates `forgeDir` | safe-by-construction | `forgeDir` confines the scan to `.gsd/forge`. |
| forge-decisions-migrate.js | milestones | L247-261 reads `milestonesDir` | breaks | It expects a loose milestone directory. |
| forge-doctor.js | milestones, tasks | L172; L208-213 recursive roots | breaks | It does not parse grouped files. |
| forge-epoch-group.js | milestones, tasks | L202-205 wrapper parent scan | safe-by-construction | `entry.isDirectory()` skips existing epoch files. |
| forge-ids.js | milestones, tasks | L249-280 `listExistingIds` | learned | It reads grouped members with `forge-grouped-file`. |
| forge-smoke.js | milestones | L278/L306/L323/L356/L364/L370 fixtures; L5043 | safe-by-construction | Milestone paths are deterministic fixture construction; `snapshotForge` walks only `.gsd/forge`. |
| forge-memory-migrate.js | milestones | L184-204 milestone directory scan | breaks | It only follows loose directories and slices. |
| forge-runs.js | milestones | L49 lists `runsDir` | safe-by-construction | `.json` filter is scoped to `.gsd/forge/runs`. |
| forge-route-audit.js | milestones | L20/L31 identity prose | safe-by-construction | It has no `readdirSync` enumeration. |
| forge-state.js | milestones | L33 constructs one state path | safe-by-construction | Caller-supplied ID prevents root enumeration. |
| forge-status.js | milestones, tasks | L127/L268 root scans | breaks | `isDirectory()` hides epoch containers. |
| forge-statusline.js | milestones | L182, L209/L213/L580 | safe-by-construction | `.json`, evidence, and pause filters operate below `.gsd/forge`. |
| forge-surgical-reset.js | milestones | L9 illustrative path | safe-by-construction | It has no directory enumeration. |
| forge-verifier.js | milestones | L922-935 selected `sliceDir/tasks` | safe-by-construction | `/^T\\d{2}$/` runs below a selected slice. |

## Operational consequence

While `unlearnedReaders()` is non-empty, no caller may be trusted with the
`includeWrapperDirs` opt-in introduced by T01, and the T05 CLI must not expose
it. The registry currently makes that unresolved work visible as the exact
`breaks` list instead of hiding it behind an assertion that the wrappers are
safe.

## Deliberately deferred work

This task does not repair any `breaks` reader, change grouping behavior, or
enable a wrapper opt-in. Those are later slice work under the explicit deferred
section of `S05-PLAN.md`. The purpose here is narrower: keep the research
measured as scripts evolve, then give the future repair work an evidence-backed
queue.

The inventory module itself performs no I/O and has no child-process behavior.
Only the test walks `scripts/`; this keeps the production registry stable data
that callers and reviewers can inspect without coupling it to a repository
scan.
