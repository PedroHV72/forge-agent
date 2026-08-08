#!/usr/bin/env node
'use strict';

// One product release line is shared by the installer and both host adapters.
// LEGACY_VERSION is deliberately retained for non-destructive Claude upgrades.
//
// 4.8.0, not the 4.6.0 this integration was originally cut as: v4.6.0 through v4.6.3 and
// v4.7.0 were all tagged on master while this work was in flight — and v4.6.0 is in fact
// the `codex app-server` transport this branch had to be re-authored onto.
const VERSION = '4.8.0';
const LEGACY_VERSION = '3.1.4';

module.exports = { VERSION, LEGACY_VERSION };
