#!/usr/bin/env bash
# Thin launcher — all logic lives in setup.mjs.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$REPO_ROOT/scripts/setup.mjs"
