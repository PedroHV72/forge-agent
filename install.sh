#!/usr/bin/env bash
# Forge Agent installer wrapper for macOS/Linux and Git Bash. The Node core
# owns all filesystem semantics; this wrapper only forwards argv.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${REPO_DIR}/scripts/forge-installer.js" --repo "${REPO_DIR}" "$@"
