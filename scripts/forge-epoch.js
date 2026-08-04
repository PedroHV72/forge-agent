'use strict';

const fs = require('fs');
const path = require('path');

const { timestampOf } = require('./forge-ids.js');

// LEGACY, READ-ONLY: recognizes YYYY-QN quarter containers written by PR 1.
// No code in this file generates this label anymore — the calendar axis is
// gone. The sole consumer is forge-grouped-file.js, which composes this RE
// with its own scan RE to keep recognizing pre-existing legacy containers.
const EPOCH_LABEL_RE = /^\d{4}-Q[1-4]$/;

function dateFrom14(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return date;
}

function asDate(dateish) {
  if (dateish instanceof Date) {
    return Number.isNaN(dateish.getTime()) ? null : dateish;
  }
  if (typeof dateish === 'string') {
    const compact = dateFrom14(dateish);
    if (compact) return compact;
    const parsed = new Date(dateish);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function dateOfUnit(unit) {
  const value = unit || {};
  const fromId = asDate(timestampOf(value.id));
  if (fromId) return { date: fromId, source: 'id' };
  const fromHint = asDate(value.dateHint);
  if (fromHint) return { date: fromHint, source: 'hint' };
  if (value.path) {
    try {
      const fromMtime = asDate(fs.statSync(value.path).mtime);
      if (fromMtime) return { date: fromMtime, source: 'mtime' };
    } catch { /* unavailable path is an unresolved link in the chain */ }
  }
  return { date: null, source: null };
}

function readEntries(dirPath) {
  try { return fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return []; }
}

function isWrapperDir(dirPath) {
  const entries = readEntries(dirPath);
  const files = entries.filter(entry => entry.isFile());
  const dirs = entries.filter(entry => entry.isDirectory());
  return files.length === 1 && dirs.length === 0 && entries.length === 1;
}

function listWrapperDirs(parentDir) {
  const entries = readEntries(parentDir);
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: path.join(parentDir, entry.name) }))
    .filter(wrapper => isWrapperDir(wrapper.path))
    .map(wrapper => {
      const file = readEntries(wrapper.path).find(entry => entry.isFile());
      return { ...wrapper, file: file ? path.join(wrapper.path, file.name) : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

module.exports = {
  EPOCH_LABEL_RE,
  dateOfUnit,
  isWrapperDir,
  listWrapperDirs,
};
