#!/usr/bin/env node
// forge-optional-require — classify a failed `require()` of an OPTIONAL module.
//
// Why this exists: `try { require(x) } catch (_) { return null }` cannot tell
// "x is not colocated in this install layout" (a legitimate fail-open) from
// "x exists but blew up while initializing" (a real fault that would silently
// disable whatever x provides). The second case must propagate.
//
// A MODULE_NOT_FOUND naming some OTHER module is also a real fault: it means a
// transitive dependency of x is broken, not that x is absent. Concrete case:
// forge-schema-guard requires forge-migrate, which eagerly pulls projection,
// migrators, store-state and doctor.
//
// Library exports:
//   missingModuleId(err)             → string | null  // the id Node could not find
//   isAbsentModuleError(err, id)     → boolean        // true only for "id itself is absent"

'use strict';

// './forge-schema-guard', 'forge-schema-guard' and './forge-schema-guard.js'
// all denote the same optional module for classification purposes.
function normalizeId(id) {
  return String(id == null ? '' : id)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.js$/, '');
}

/**
 * The module id Node reported as unfindable, or null when the error is not a
 * module-resolution failure at all.
 *
 * @param {*} err
 * @returns {string|null}
 */
function missingModuleId(err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return null;
  const m = /Cannot find module '([^']+)'/.exec(String(err.message || ''));
  return m ? m[1] : null;
}

/**
 * True only when `err` says that `moduleId` ITSELF is absent. Any other error —
 * a SyntaxError, a TypeError thrown at module init, or a MODULE_NOT_FOUND
 * naming a different (transitive) module — returns false, and the caller is
 * expected to rethrow it.
 *
 * @param {*} err
 * @param {string} moduleId
 * @returns {boolean}
 */
function isAbsentModuleError(err, moduleId) {
  const missing = missingModuleId(err);
  if (missing === null) return false;
  return normalizeId(missing) === normalizeId(moduleId);
}

module.exports = { missingModuleId, isAbsentModuleError };
