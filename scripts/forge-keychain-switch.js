#!/usr/bin/env node
'use strict';

/**
 * The single predicate that decides whether a Keychain call may happen.
 *
 * WHY THIS EXISTS
 * ---------------
 * `security` resolves the login keychain through `$HOME`. `scripts/run-tests.js`
 * isolates HOME into a temp dir, so there is no
 * `~/Library/Keychains/login.keychain-db` to write into — and instead of
 * failing, `security add-generic-password` raises a MODAL macOS dialog
 * ("Chaves Não Encontradas") and blocks waiting for a human. The call's timeout
 * then SIGTERMs it and leaves the window orphaned on the operator's screen.
 * Measured on 2026-07-29: 249 dialogs in 3 hours, in bursts of 8–13 per minute,
 * one per assertion that touched the vault.
 *
 * Reproduction:
 *   TMPH=$(mktemp -d)
 *   HOME="$TMPH" security add-generic-password -U -a "$(whoami)" -s repro -w x
 *   # hangs ~5s → status:null signal:SIGTERM code:ETIMEDOUT
 *
 * So the fix is not "make the call resilient" — the call must not be reachable
 * from a test at all. Every Keychain branch in every engine consults this
 * predicate first; when it says no, the branch is skipped and the existing
 * 0600-file fallback path is taken. That path already existed and was already
 * tested: this changes which branch is taken, never what the fallback does.
 *
 * PRODUCTION IS UNCHANGED. With `FORGE_KEYCHAIN_DISABLED` unset — the only
 * state a user's machine is ever in — `keychainEnabled()` is exactly the
 * `process.platform === 'darwin'` test each call site used before. This is a
 * test-only escape hatch, in the established shape of the other env overrides
 * in this codebase (FORGE_KEYCHAIN_DIAGNOSTICS, FORGE_XLLM_CODEX_BIN,
 * FORGE_XLLM_AGY_BIN).
 *
 * WHY A MODULE AND NOT A DUPLICATED TWO-LINE PREDICATE
 * ----------------------------------------------------
 * Both engines (forge-secrets.js, forge-accounts.js) need it and neither
 * requires the other, so a leaf module introduces no cycle — it depends on
 * nothing but `process`. Duplicating it would mean the regression guard has to
 * assert two independent spellings stay in sync, and a future third call site
 * would silently be free to invent a third. One name, greppable, is what makes
 * the guard in forge-keychain-switch.test.js able to state a total claim over
 * the call sites rather than a per-file one.
 *
 * Read at call time, never cached: a test may set the variable after this
 * module is first required (suites require engines at top of file), and a
 * cached snapshot would be read before the test could speak.
 */

const IS_DARWIN = process.platform === 'darwin';

/// True when a `security` invocation is permitted from this process.
function keychainEnabled() {
  return IS_DARWIN && process.env.FORGE_KEYCHAIN_DISABLED !== '1';
}

/// Name of the opt-out variable, so tests and runners spell it once.
const DISABLE_ENV = 'FORGE_KEYCHAIN_DISABLED';

module.exports = { keychainEnabled, DISABLE_ENV };
