#!/usr/bin/env bash
# teardown.sh — delete all resources provisioned by setup.sh.
#
# What this does:
#   1. Deletes the two storefront-worker KV namespaces
#   2. Deletes the two inventory D1 databases
#   3. Deletes the storefront-worker and rollout-workflow Workers
#   4. Resets placeholder IDs in wrangler.jsonc
#
# Use this to reset between demo runs or clean up after a session.
#
# Usage:
#   cd <repo-root>
#   bash scripts/teardown.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[teardown]${RESET} $*"; }
success() { echo -e "${GREEN}[teardown] ✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}[teardown] ⚠${RESET} $*"; }
fatal()   { echo -e "${RED}[teardown] ✗${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──${RESET}"; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOREFRONT_DIR="$REPO_ROOT/packages/storefront-worker"
WORKFLOW_DIR="$REPO_ROOT/packages/rollout-workflow"
WRANGLER_JSONC="$STOREFRONT_DIR/wrangler.jsonc"
LIB="$REPO_ROOT/scripts/lib.mjs"

command -v node    &>/dev/null || fatal "node not found."
command -v wrangler &>/dev/null || fatal "wrangler not found."
[[ -f "$LIB" ]] || fatal "Could not find $LIB"

echo -e "${RED}${BOLD}WARNING:${RESET} This will permanently delete:"
echo -e "  • KV namespaces: storefront-prod, storefront-preview"
echo -e "  • D1 databases:  storefront-inventory-prod, storefront-inventory-preview"
echo -e "  • Workers:       storefront-worker, rollout-workflow"
echo -e ""
read -r -p "Type 'yes' to confirm: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { info "Aborted."; exit 0; }

# ---------------------------------------------------------------------------
# Helper: find KV namespace ID by title
# ---------------------------------------------------------------------------
kv_id_for() {
  local name="$1"
  local list_output
  list_output=$(cd "$STOREFRONT_DIR" && wrangler kv namespace list --json 2>&1 || true)
  node "$LIB" kv-id-from-list "$list_output" "$name" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: find D1 database UUID by name
# ---------------------------------------------------------------------------
d1_id_for() {
  local name="$1"
  local list_output
  list_output=$(cd "$STOREFRONT_DIR" && wrangler d1 list --json 2>&1 || true)
  node "$LIB" d1-id-from-list "$list_output" "$name" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Step 1: KV namespaces
# ---------------------------------------------------------------------------
header "Step 1/4 — Delete KV namespaces"

for NS_NAME in storefront-prod storefront-preview; do
  NS_ID=$(kv_id_for "$NS_NAME")
  if [[ -z "$NS_ID" ]]; then
    warn "KV namespace '$NS_NAME' not found — skipping"
  else
    info "Deleting KV namespace: $NS_NAME ($NS_ID) ..."
    (cd "$STOREFRONT_DIR" && wrangler kv namespace delete --namespace-id="$NS_ID")
    success "Deleted: $NS_NAME"
  fi
done

# ---------------------------------------------------------------------------
# Step 2: D1 databases
# ---------------------------------------------------------------------------
header "Step 2/4 — Delete D1 databases"

for DB_NAME in storefront-inventory-prod storefront-inventory-preview; do
  DB_ID=$(d1_id_for "$DB_NAME")
  if [[ -z "$DB_ID" ]]; then
    warn "D1 database '$DB_NAME' not found — skipping"
  else
    info "Deleting D1 database: $DB_NAME ($DB_ID) ..."
    (cd "$STOREFRONT_DIR" && wrangler d1 delete "$DB_NAME" --skip-confirmation)
    success "Deleted: $DB_NAME"
  fi
done

# ---------------------------------------------------------------------------
# Step 3: Delete Workers
# ---------------------------------------------------------------------------
header "Step 3/4 — Delete Workers"

info "Deleting storefront-worker ..."
(cd "$STOREFRONT_DIR" && wrangler delete --name storefront-worker --skip-confirmation 2>&1) \
  && success "Deleted: storefront-worker" \
  || warn "storefront-worker not found or already deleted"

info "Deleting rollout-workflow ..."
(cd "$WORKFLOW_DIR" && wrangler delete --name rollout-workflow --skip-confirmation 2>&1) \
  && success "Deleted: rollout-workflow" \
  || warn "rollout-workflow not found or already deleted"

# ---------------------------------------------------------------------------
# Step 4: Reset wrangler.jsonc placeholders
# ---------------------------------------------------------------------------
header "Step 4/4 — Reset wrangler.jsonc"

node "$LIB" reset-wrangler "$WRANGLER_JSONC"
success "wrangler.jsonc placeholders restored"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Teardown complete"
echo -e ""
echo -e "  All demo resources deleted. Run ${BOLD}bash scripts/setup.sh${RESET} to reprovision."
echo -e ""
