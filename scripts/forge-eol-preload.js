'use strict';

/**
 * In-memory EOL experiment for source-reading test suites.
 *
 * Buffer passes through untouched is a recorded decision (B2), not an
 * implementation detail: only explicit UTF-8 reads may be transformed.
 * Set FORGE_EOL_MODE to `lf` or `crlf`; any other value leaves this preload
 * inert so an accidentally inherited NODE_OPTIONS cannot affect a host suite.
 */

const fs = require('fs');

const INTERCEPTED_APIS = Object.freeze(['fs.readFileSync']);
const OBSERVED_APIS = Object.freeze(['fs.readFile', 'fs.promises.readFile']);

function eolMode(value) {
  return value === 'lf' || value === 'crlf' ? value : null;
}

function textEncoding(options) {
  const encoding = typeof options === 'string'
    ? options
    : options && typeof options === 'object'
      ? options.encoding
      : null;
  if (typeof encoding !== 'string') return false;
  const normalized = encoding.toLowerCase();
  return normalized === 'utf8' || normalized === 'utf-8';
}

// Rule implemented: only the CRLF pair is a line terminator here.  A lone \r is
// left untouched in BOTH arms, because rewriting it would mutate the file
// differently between arms (CRLF mode would re-expand it to \r\n) and could
// flip an assert for a reason that has nothing to do with line endings — a
// false `confirmed`.  Consequence, stated honestly: a file that genuinely uses
// bare-CR line endings is out of this instrument's scope.  That is the right
// trade for this repository, where bare-CR line endings do not occur while a
// semantic \r inside a string (progress lines, control sequences) does.
function transformedText(content, mode) {
  const lf = content.replace(/\r\n/g, '\n');
  // After the pass above no \n is preceded by \r, so this cannot double-expand.
  return mode === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

function traceObserved(api) {
  const traceFile = process.env.FORGE_EOL_TRACE_FILE;
  if (!traceFile) return;
  try {
    fs.appendFileSync(traceFile, `${JSON.stringify({ api })}\n`, 'utf8');
  } catch (_) {
    // The observation channel must never break the suite it observes.
  }
}

function callbackOptions(args) {
  return args.length > 2 ? args[1] : null;
}

function install(mode) {
  const originalReadFileSync = fs.readFileSync;
  const originalReadFile = fs.readFile;
  const originalPromisesReadFile = fs.promises.readFile;

  fs.readFileSync = function readFileSyncWithEol(path, options) {
    const content = originalReadFileSync.apply(this, arguments);
    return textEncoding(options) && typeof content === 'string'
      ? transformedText(content, mode)
      : content;
  };

  fs.readFile = function readFileObserved() {
    if (textEncoding(callbackOptions(arguments))) traceObserved('fs.readFile');
    return originalReadFile.apply(this, arguments);
  };

  fs.promises.readFile = function promisesReadFileObserved(path, options) {
    if (textEncoding(options)) traceObserved('fs.promises.readFile');
    return originalPromisesReadFile.apply(this, arguments);
  };
}

const mode = eolMode(process.env.FORGE_EOL_MODE);
if (mode) install(mode);

module.exports = {
  INTERCEPTED_APIS,
  OBSERVED_APIS,
  _private: {
    eolMode,
    install,
    textEncoding,
    traceObserved,
    transformedText,
  },
};
