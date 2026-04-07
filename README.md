# Workers Deployment Demo

A demonstration of a Cloudflare-native deployment pipeline for Workers.
Shows how to safely ship code 10 times a day using platform primitives —
no third-party tooling required.

## What This Demonstrates

Three progressive stages:

1. **Worker Previews** — isolated preview environments per branch, with
   separate KV *and* D1 instances so preview traffic never touches production
   data. Proven live by writing a product directly to preview KV and showing
   it appears on the preview URL but not on production.
2. **Gradual Deployments** — step a new version from 10% → 50% → 100%
   with instant rollback available at any point
3. **Automated Rollout via Workflows** — a durable pipeline that promotes
   a version through percentage steps, polls error rates via the Analytics
   API, and rolls back automatically if a threshold is exceeded

## Repository Structure

```
worker-deployment-demo/
├── packages/
│   ├── storefront-worker/     # The app being deployed
│   └── rollout-workflow/      # The automation engine
└── _plan_/                    # Planning docs and detailed runbook
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9+
- A Cloudflare account (free tier is sufficient for Stages 1–2; Workflows
  requires a paid plan)
- Wrangler authenticated: `npx wrangler login`

> `jq` is not required — all JSON parsing in the scripts uses Node.

---

## Installation

```bash
git clone <repo-url>
cd worker-deployment-demo
pnpm install
```

### Worker Previews (Stage 1 only)

`wrangler preview` is not yet in the stable Wrangler release. Install the
prerelease **inside `packages/storefront-worker/` only** — your global
Wrangler is unaffected:

```bash
cd packages/storefront-worker
npm i https://pkg.pr.new/wrangler@12983
```

Check [PR #12983](https://github.com/cloudflare/workers-sdk/pull/12983) —
if it has merged, use `npm i wrangler@latest` instead.

---

## Setup

Everything is handled by a single script. It creates all cloud resources,
seeds data, patches `wrangler.jsonc` with real IDs, and deploys both Workers.

```bash
bash scripts/setup.sh
```

The script will:
1. Create KV namespaces (`storefront-prod`, `storefront-preview`)
2. Create D1 databases (`storefront-inventory-prod`, `storefront-inventory-preview`)
3. Apply D1 migrations and seed data to both databases
4. Seed KV catalog data for both environments
5. Pause to prompt you to enable the Worker Previews dashboard gate
6. Deploy `storefront-worker` at v1
7. Prompt for your `CLOUDFLARE_API_TOKEN` secret and deploy `rollout-workflow`

Resource IDs are automatically written back into
`packages/storefront-worker/wrangler.jsonc` and echoed to the terminal.

**Requirements:** `node` (18+) and `wrangler` (authenticated) must be on your `PATH`.

### After setup

```bash
export STOREFRONT_URL=https://storefront-worker.<sub>.workers.dev
export WORKFLOW_URL=https://rollout-workflow.<sub>.workers.dev
export ACCOUNT_ID=<your-cloudflare-account-id>
```

### Teardown

To delete all provisioned resources and reset `wrangler.jsonc` for a fresh run:

```bash
bash scripts/teardown.sh
```

---

## Stage 1 — Worker Previews

*"How do I test a feature branch without touching production data?"*

```bash
cd packages/storefront-worker
git checkout -b feature/v2-pricing

# Create an isolated preview environment from this branch
npx wrangler preview
# → Preview URL: https://feature-v2-pricing.storefront-worker.<sub>.workers.dev
```

Compare the two environments side by side:

```bash
# Production — v1 catalog, production prices
curl -s $STOREFRONT_URL/products | jq '{version, environment, featured_collection}'

# Preview — same code, isolated KV, staging prices
curl -s https://feature-v2-pricing.storefront-worker.<sub>.workers.dev/products \
  | jq '{version, environment, featured_collection}'
```

**What to point out:** `"environment": "preview"` and the lower prices confirm
the preview is bound to its own KV namespace. Any writes to preview KV are
completely isolated from production.

Open the dashboard Previews tab to show the binding configuration:
```
https://dash.cloudflare.com/<ACCOUNT_ID>/workers/services/view/storefront-worker/production/previews
```

---

## Stage 2 — Manual Gradual Deployment

*"How do I roll out to 10%, then 50%, then 100%?"*

```bash
cd packages/storefront-worker
git checkout main

# Upload v2 as a staged version (not deployed yet)
npx wrangler versions upload \
  --tag="v2" \
  --message="End-of-season sale, puffer vest added"

# Capture the version IDs
npx wrangler versions list
export V1_VERSION_ID=<v1-id>
export V2_VERSION_ID=<v2-id>

# Deploy at 10% — production traffic is still 90% v1
npx wrangler versions deploy "$V2_VERSION_ID@10%" "$V1_VERSION_ID@90%"
```

Watch the split in real time:

```bash
for i in {1..20}; do
  curl -s $STOREFRONT_URL/products | jq -r '"\(.version)  \(.featured_collection)"'
done
# Mix of:
#   v1  Summer Basics
#   v2  End-of-Season Sale   ← ~2 in every 20
```

Step through to 100%:

```bash
npx wrangler versions deploy "$V2_VERSION_ID@50%" "$V1_VERSION_ID@50%"
npx wrangler versions deploy "$V2_VERSION_ID@100%"
```

Instant rollback:

```bash
npx wrangler rollback   # interactive — select v1 from the list
curl -s $STOREFRONT_URL/products | jq '.version'  # → "v1"
```

**What to point out:** Rollback is not a redeployment — the platform changes
which version pointer is active. It propagates globally in seconds. Any of
the last 100 versions is available.

---

## Stage 3 — Automated Rollout with Auto-Rollback

*"Can the system detect a regression and roll back without a human?"*

### 3a — Set up a broken version

In `packages/storefront-worker/src/index.ts`, change `shouldInjectFault` to
return `true`, then upload:

```bash
npx wrangler versions upload \
  --tag="v2-broken" \
  --message="v2 with simulated upstream error (~30% error rate)"

export V2_BROKEN_ID=<version-id-from-output>
```

Revert `shouldInjectFault` back to `return false` afterwards — the broken
version is now captured as an immutable upload.

### 3b — Start the load generator

Open a second terminal and keep it running throughout the demo:

```bash
while true; do
  curl -s $STOREFRONT_URL/health > /dev/null
  sleep 1
done
```

### 3c — Trigger the Rollout Workflow

```bash
curl -s -X POST $WORKFLOW_URL/trigger \
  -H "Content-Type: application/json" \
  -d "{
    \"workerName\": \"storefront-worker\",
    \"targetVersionId\": \"$V2_BROKEN_ID\",
    \"accountId\": \"$ACCOUNT_ID\",
    \"errorThresholdPct\": 2.0,
    \"soakDuration\": \"2 minutes\"
  }" | jq .
```

Copy the `dashboardUrl` from the response and open it in a browser.

### 3d — Watch it roll back

The Workflow dashboard shows steps completing in real time:

```
validate-version      ✓ completed
deploy-10-percent     ✓ completed
soak-at-10-percent    ⏳ sleeping (resumes in ~1m 45s)
check-health-at-10    pending
rollback              pending
```

After the soak, `check-health-at-10` detects ~28% error rate (above the 2%
threshold) and the `rollback` step fires automatically.

Confirm production is back on v1:

```bash
curl -s $STOREFRONT_URL/products | jq '.version'  # → "v1"
```

### 3e — Successful rollout

Repeat with the healthy v2:

```bash
curl -s -X POST $WORKFLOW_URL/trigger \
  -H "Content-Type: application/json" \
  -d "{
    \"workerName\": \"storefront-worker\",
    \"targetVersionId\": \"$V2_VERSION_ID\",
    \"accountId\": \"$ACCOUNT_ID\",
    \"errorThresholdPct\": 2.0,
    \"soakDuration\": \"2 minutes\"
  }" | jq .
```

All steps pass. Final state: `storefront-worker` fully deployed at v2@100%.

---

## Useful Commands

```bash
# Check current deployment split
npx wrangler deployments list                    # from packages/storefront-worker

# Poll a Workflow instance from the CLI
curl -s $WORKFLOW_URL/status/<instanceId> | jq .

# Stream live Worker logs
npx wrangler tail                                # from packages/storefront-worker
```

---

## Key Talking Points

- **No external dependencies.** Everything runs on Cloudflare. No GitHub
  Actions, no CI/CD platform, no third-party orchestration.
- **Preview isolation means safe testing.** The preview KV namespace is
  completely separate from production. Developers can write, delete, and
  mutate data freely without any risk to production.
- **Rollback is instant.** Not a redeployment — the platform changes which
  version pointer is active. Any of the last 100 versions is available.
- **The Workflow is durable.** If the machine running the demo loses
  connectivity mid-soak, the Workflow resumes from the last completed step.
- **Backend errors trigger rollback.** The storefront Worker propagates
  upstream errors as 5xx responses. The Workflow polls for those via the
  Analytics API.

---

## Further Reading

- [_plan_/README.md](./_plan_/README.md) — full architecture overview
- [_plan_/storefront-worker.md](./_plan_/storefront-worker.md) — storefront component spec
- [_plan_/rollout-workflow.md](./_plan_/rollout-workflow.md) — workflow engine spec
- [_plan_/demo-runbook.md](./_plan_/demo-runbook.md) — detailed presenter script with fallback procedures
