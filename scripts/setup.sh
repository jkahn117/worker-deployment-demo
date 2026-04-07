#!/usr/bin/env bash
# setup.sh — one-time provisioning for the Workers Deployment Demo.
#
# What this does:
#   1. Creates two KV namespaces (prod + preview) for product catalog data
#   2. Creates two D1 databases (prod + preview) for inventory data
#   3. Applies D1 migrations to both databases
#   4. Seeds KV namespaces with catalog data
#   5. Patches wrangler.jsonc with the real resource IDs
#   6. Sets the CLOUDFLARE_API_TOKEN secret on the rollout-workflow Worker
#   7. Deploys both Workers (storefront-worker v1, rollout-workflow)
#
# Usage:
#   cd <repo-root>
#   bash scripts/setup.sh
#
# Requirements:
#   - Node.js 18+ on PATH
#   - wrangler authenticated (`wrangler whoami` should show your account)

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

info()    { echo -e "${CYAN}[setup]${RESET} $*"; }
success() { echo -e "${GREEN}[setup] ✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}[setup] ⚠${RESET} $*"; }
fatal()   { echo -e "${RED}[setup] ✗${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──${RESET}"; }

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
header "Preflight checks"

command -v node    &>/dev/null || fatal "node not found. Install from https://nodejs.org/"
command -v wrangler &>/dev/null || fatal "wrangler not found. Run: npm install -g wrangler"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOREFRONT_DIR="$REPO_ROOT/packages/storefront-worker"
WORKFLOW_DIR="$REPO_ROOT/packages/rollout-workflow"
WRANGLER_JSONC="$STOREFRONT_DIR/wrangler.jsonc"
LIB="$REPO_ROOT/scripts/lib.mjs"

[[ -f "$WRANGLER_JSONC" ]] || fatal "Could not find $WRANGLER_JSONC"
[[ -f "$LIB" ]]           || fatal "Could not find $LIB"

info "Repo root:  $REPO_ROOT"
info "Node:       $(node --version)"
info "Wrangler:   $(wrangler --version 2>&1 | head -1)"
info "Account:    $(wrangler whoami 2>&1 | grep -o 'You are logged in.*' || echo '(run wrangler whoami to verify)')"

# ---------------------------------------------------------------------------
# Helper: extract ID from wrangler JSON output
# ---------------------------------------------------------------------------
extract_id() {
  node "$LIB" extract-id "$1" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: patch a placeholder in wrangler.jsonc
# ---------------------------------------------------------------------------
patch_wrangler() {
  node "$LIB" patch-wrangler "$WRANGLER_JSONC" "$1" "$2"
}

# ---------------------------------------------------------------------------
# Step 1: KV namespaces
# ---------------------------------------------------------------------------
header "Step 1/7 — KV namespaces"

info "Creating KV namespace: storefront-prod ..."
KV_PROD_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler kv namespace create storefront-prod --json 2>&1 || true)
KV_PROD_ID=$(extract_id "$KV_PROD_OUTPUT")

if [[ -z "$KV_PROD_ID" ]]; then
  warn "Could not parse ID from create output — checking for existing namespace ..."
  KV_LIST_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler kv namespace list --json 2>&1 || true)
  KV_PROD_ID=$(node "$LIB" kv-id-from-list "$KV_LIST_OUTPUT" "storefront-prod" 2>/dev/null || echo "")
  [[ -n "$KV_PROD_ID" ]] || fatal "Could not create or find KV namespace 'storefront-prod'."
  warn "Using existing namespace: $KV_PROD_ID"
fi
success "KV prod namespace ID: ${BOLD}$KV_PROD_ID${RESET}"
patch_wrangler "<PROD_KV_NAMESPACE_ID>" "$KV_PROD_ID"
info "  → Patched wrangler.jsonc: kv_namespaces[0].id = $KV_PROD_ID"

info "Creating KV namespace: storefront-preview ..."
KV_PREVIEW_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler kv namespace create storefront-preview --json 2>&1 || true)
KV_PREVIEW_ID=$(extract_id "$KV_PREVIEW_OUTPUT")

if [[ -z "$KV_PREVIEW_ID" ]]; then
  warn "Could not parse ID from create output — checking for existing namespace ..."
  KV_LIST_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler kv namespace list --json 2>&1 || true)
  KV_PREVIEW_ID=$(node "$LIB" kv-id-from-list "$KV_LIST_OUTPUT" "storefront-preview" 2>/dev/null || echo "")
  [[ -n "$KV_PREVIEW_ID" ]] || fatal "Could not create or find KV namespace 'storefront-preview'."
  warn "Using existing namespace: $KV_PREVIEW_ID"
fi
success "KV preview namespace ID: ${BOLD}$KV_PREVIEW_ID${RESET}"
patch_wrangler "<PREVIEW_KV_NAMESPACE_ID>" "$KV_PREVIEW_ID"
info "  → Patched wrangler.jsonc: previews.kv_namespaces[0].id = $KV_PREVIEW_ID"

# ---------------------------------------------------------------------------
# Step 2: D1 databases
# ---------------------------------------------------------------------------
header "Step 2/7 — D1 databases"

info "Creating D1 database: storefront-inventory-prod ..."
D1_PROD_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler d1 create storefront-inventory-prod --json 2>&1 || true)
D1_PROD_ID=$(extract_id "$D1_PROD_OUTPUT")

if [[ -z "$D1_PROD_ID" ]]; then
  warn "Could not parse ID from create output — checking for existing database ..."
  D1_LIST_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler d1 list --json 2>&1 || true)
  D1_PROD_ID=$(node "$LIB" d1-id-from-list "$D1_LIST_OUTPUT" "storefront-inventory-prod" 2>/dev/null || echo "")
  [[ -n "$D1_PROD_ID" ]] || fatal "Could not create or find D1 database 'storefront-inventory-prod'."
  warn "Using existing database: $D1_PROD_ID"
fi
success "D1 prod database ID: ${BOLD}$D1_PROD_ID${RESET}"
patch_wrangler "<PROD_D1_DATABASE_ID>" "$D1_PROD_ID"
info "  → Patched wrangler.jsonc: d1_databases[0].database_id = $D1_PROD_ID"

info "Creating D1 database: storefront-inventory-preview ..."
D1_PREVIEW_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler d1 create storefront-inventory-preview --json 2>&1 || true)
D1_PREVIEW_ID=$(extract_id "$D1_PREVIEW_OUTPUT")

if [[ -z "$D1_PREVIEW_ID" ]]; then
  warn "Could not parse ID from create output — checking for existing database ..."
  D1_LIST_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler d1 list --json 2>&1 || true)
  D1_PREVIEW_ID=$(node "$LIB" d1-id-from-list "$D1_LIST_OUTPUT" "storefront-inventory-preview" 2>/dev/null || echo "")
  [[ -n "$D1_PREVIEW_ID" ]] || fatal "Could not create or find D1 database 'storefront-inventory-preview'."
  warn "Using existing database: $D1_PREVIEW_ID"
fi
success "D1 preview database ID: ${BOLD}$D1_PREVIEW_ID${RESET}"
patch_wrangler "<PREVIEW_D1_DATABASE_ID>" "$D1_PREVIEW_ID"
info "  → Patched wrangler.jsonc: previews.d1_databases[0].database_id = $D1_PREVIEW_ID"

# ---------------------------------------------------------------------------
# Step 3: D1 migrations
# ---------------------------------------------------------------------------
header "Step 3/7 — D1 migrations"

info "Applying migrations to production database ..."
(cd "$STOREFRONT_DIR" && wrangler d1 migrations apply storefront-inventory-prod --remote)
success "Production D1 schema + seed applied"

info "Applying migrations to preview database ..."
(cd "$STOREFRONT_DIR" && wrangler d1 migrations apply storefront-inventory-preview --remote)

info "Applying preview-only seed (0002_seed_preview.sql) to preview database ..."
(cd "$STOREFRONT_DIR" && wrangler d1 execute storefront-inventory-preview \
  --remote --file=migrations/0002_seed_preview.sql)
success "Preview D1 schema + seed applied (stock counts: 9999)"

# ---------------------------------------------------------------------------
# Step 4: KV seeding
# ---------------------------------------------------------------------------
header "Step 4/7 — KV seeding"

info "Seeding production KV (v1 catalog, realistic prices) ..."
(cd "$STOREFRONT_DIR" && wrangler kv key put \
  --namespace-id="$KV_PROD_ID" "products" \
  '[{"id":"tshirt-crew","name":"Crew T-Shirt","price":19.99,"badge":null},{"id":"chino-slim","name":"Slim Chinos","price":59.99,"badge":null},{"id":"hoodie-zip","name":"Zip Hoodie","price":79.99,"badge":null}]')

(cd "$STOREFRONT_DIR" && wrangler kv key put \
  --namespace-id="$KV_PROD_ID" "config" \
  '{"featured_collection":"Summer Basics","currency":"USD"}')
success "Production KV seeded"

info "Seeding preview KV (staging prices, preview-sale badges) ..."
(cd "$STOREFRONT_DIR" && wrangler kv key put \
  --namespace-id="$KV_PREVIEW_ID" "products" \
  '[{"id":"tshirt-crew","name":"Crew T-Shirt","price":9.99,"badge":"preview-sale"},{"id":"chino-slim","name":"Slim Chinos","price":29.99,"badge":"preview-sale"},{"id":"hoodie-zip","name":"Zip Hoodie","price":39.99,"badge":"preview-sale"},{"id":"puffer-vest","name":"Puffer Vest","price":59.99,"badge":"new"}]')

(cd "$STOREFRONT_DIR" && wrangler kv key put \
  --namespace-id="$KV_PREVIEW_ID" "config" \
  '{"featured_collection":"End-of-Season Sale","currency":"USD"}')
success "Preview KV seeded"

# ---------------------------------------------------------------------------
# Step 5: Enable Worker Previews gate
# ---------------------------------------------------------------------------
header "Step 5/7 — Worker Previews gate"

warn "Worker Previews requires a manual dashboard action."
echo -e "  Open the following URL to enable the gate on your account:"
echo -e "  ${BOLD}https://dash.cloudflare.com/?devPanel=worker-previews${RESET}"
echo -e "  Confirm the Previews tab appears in a Worker's detail page before continuing.\n"
read -r -p "Press ENTER once the gate is enabled (or CTRL-C to skip and continue) ..."

# ---------------------------------------------------------------------------
# Step 6: Deploy storefront-worker (v1)
# ---------------------------------------------------------------------------
header "Step 6/7 — Deploy storefront-worker (v1)"

info "Deploying storefront-worker ..."
DEPLOY_OUTPUT=$(cd "$STOREFRONT_DIR" && wrangler deploy \
  --tag="v1" \
  --message="Initial release — Summer Basics catalog" 2>&1)
echo "$DEPLOY_OUTPUT"
success "storefront-worker deployed"

STOREFRONT_URL=$(node "$LIB" extract-url "$DEPLOY_OUTPUT" "storefront-worker" 2>/dev/null || echo "")
if [[ -n "$STOREFRONT_URL" ]]; then
  success "Storefront URL: ${BOLD}$STOREFRONT_URL${RESET}"
else
  warn "Could not auto-detect storefront URL — check wrangler deploy output above."
fi

# ---------------------------------------------------------------------------
# Step 7: Deploy rollout-workflow
# ---------------------------------------------------------------------------
header "Step 7/7 — Deploy rollout-workflow"

echo -e "\nThe rollout-workflow Worker needs a ${BOLD}CLOUDFLARE_API_TOKEN${RESET} secret."
echo -e "Required permissions: ${BOLD}Workers Scripts:Edit${RESET} + ${BOLD}Account Analytics:Read${RESET}"
echo -e "Create a token at: https://dash.cloudflare.com/profile/api-tokens\n"
(cd "$WORKFLOW_DIR" && wrangler secret put CLOUDFLARE_API_TOKEN)

info "Deploying rollout-workflow ..."
(cd "$WORKFLOW_DIR" && wrangler deploy)
success "rollout-workflow deployed"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Setup complete"

echo -e ""
echo -e "  ${BOLD}Resource IDs${RESET} (written to wrangler.jsonc):"
echo -e "    KV prod:        $KV_PROD_ID"
echo -e "    KV preview:     $KV_PREVIEW_ID"
echo -e "    D1 prod:        $D1_PROD_ID"
echo -e "    D1 preview:     $D1_PREVIEW_ID"
echo -e ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "    export STOREFRONT_URL=https://storefront-worker.<sub>.workers.dev"
echo -e "    export WORKFLOW_URL=https://rollout-workflow.<sub>.workers.dev"
echo -e "    export ACCOUNT_ID=<your-cloudflare-account-id>"
echo -e ""
echo -e "  Then follow the demo stages in ${BOLD}README.md${RESET}."
echo -e ""
