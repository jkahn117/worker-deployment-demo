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

`wrangler preview` is available in the stable Wrangler release already
installed by this repo.

```bash
pnpm install
```

---

## Setup

Everything is handled by a single script. It creates all cloud resources,
seeds data, resets `wrangler.jsonc` back to placeholders, fills in the real
IDs, and deploys both Workers.

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

Resource IDs are automatically written into
`packages/storefront-worker/wrangler.jsonc` and echoed to the terminal.
That file is committed with placeholders in git; setup fills it in locally and
teardown restores the placeholders.

**Requirements:** `node` (18+) must be installed and Wrangler must already be
authenticated. Verify with `pnpm exec wrangler whoami`.

### After setup

Use the exact URLs printed by the setup script:

```bash
export STOREFRONT_URL=https://storefront-worker.<sub>.workers.dev
export WORKFLOW_URL=https://rollout-workflow.<sub>.workers.dev
export ACCOUNT_ID=<your-cloudflare-account-id>
```

`STOREFRONT_URL` is the production service URL. The preview URLs created later
in Stage 1 are separate URLs and should not replace this variable.

### Teardown

To delete all provisioned resources and restore `wrangler.jsonc` placeholders
for a fresh run:

```bash
bash scripts/teardown.sh
```

---

## Stage 1 — Worker Previews

*"How do I test a feature branch without touching production data?"*

### Prerequisites for Stage 1

**Worker Previews gate:** Open the dashboard and enable via browser console:
```javascript
localStorage.setItem("devPanel", "true");
```
Reload, click the ⚙️ gear icon bottom-left, search `worker-previews`, set to `true`.

**Wrangler with `preview` command:** `wrangler preview` is available in the
stable Wrangler release installed by `pnpm install`.

### Running the demo

#### Step 1.1 — Confirm production first

Action:

```bash
curl -s $STOREFRONT_URL/products | jq '{version, environment, featured_collection}'
```

Talking point:

`$STOREFRONT_URL` is the production service URL created by `scripts/setup.sh`.
This is the baseline users are currently hitting.

#### Step 1.2 — Create a preview from the feature branch

Action:

```bash
cd packages/storefront-worker
git checkout -b feature/v2-pricing

# Create an isolated preview environment from this branch
npx wrangler preview
```

Wrangler prints two URLs:

- `Preview:` stable preview alias for the branch or preview name
- `Deployment:` immutable URL for that specific preview deployment

Example:

- Preview URL: `https://feature-v2-pricing-storefront-worker.<sub>.workers.dev`
- Deployment URL: `https://<deployment-id>-storefront-worker.<sub>.workers.dev`

Talking point:

These are not two different environments. They point at the same preview
deployment right now. The difference is identity:

- The preview URL is the stable URL you share with QA.
- The deployment URL is the exact deployed revision.

If you rerun `wrangler preview`, the preview URL should remain stable while the
deployment URL changes.

#### Step 1.3 — Compare production vs preview

Action:

```bash
export PREVIEW_URL=https://feature-v2-pricing-storefront-worker.<sub>.workers.dev

curl -s $STOREFRONT_URL/products | jq '{version, environment, featured_collection}'

curl -s $PREVIEW_URL/products \
  | jq '{version, environment, featured_collection}'
```

Talking points:

- Production should show `"environment": "production"`.
- Preview should show `"environment": "preview"`.
- Preview data should have the lower prices and different stock values.
- This proves the preview is using the `previews` bindings, not the production
  ones.

Important: the preview is a separate environment. It is not a staged
production version.

#### Step 1.4 — Show the dashboard

Action:

Open the dashboard Previews tab to show the binding configuration:
```
https://dash.cloudflare.com/<ACCOUNT_ID>/workers/services/view/storefront-worker/production/previews
```

Talking points:

- Show the preview name in the Previews tab.
- Show the preview KV and D1 IDs are different from production.
- Call out that observability is separate as well.
- This is the safe branch-testing story: same Worker code path, isolated data.

---

## Stage 2 — Manual Gradual Deployment

*"How do I roll out to 10%, then 50%, then 100%?"*

Important: this stage is different from Stage 1.

- Stage 1 creates a preview environment with `ENVIRONMENT=preview`.
- Stage 2 shifts traffic between production versions, so both versions still
  run with `ENVIRONMENT=production`.

#### Step 2.1 — Upload v2 without deploying it

Action:

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
```

Talking point:

`versions upload` creates an immutable production version, but no traffic has
shifted yet.

#### Step 2.2 — Shift 10% of production traffic

Action:

```bash

# Deploy at 10% — production traffic is still 90% v1
npx wrangler versions deploy "$V2_VERSION_ID@10%" "$V1_VERSION_ID@90%"
```

#### Step 2.3 — Watch the split in real time

Action:

```bash
for i in {1..20}; do
  curl -s $STOREFRONT_URL/products | jq -r '"\(.version)  \(.featured_collection)"'
done
# Mix of:
#   v1  Summer Basics
#   v2  End-of-Season Sale   ← ~2 in every 20
```

Talking points:

- Both responses are still production traffic.
- `version` changes between `v1` and `v2`.
- `environment` should stay `production` for both.

#### Step 2.4 — Step through to 100%

Action:

```bash
npx wrangler versions deploy "$V2_VERSION_ID@50%" "$V1_VERSION_ID@50%"
npx wrangler versions deploy "$V2_VERSION_ID@100%"
```

#### Step 2.5 — Roll back instantly

Action:

```bash
npx wrangler rollback   # interactive — select v1 from the list
curl -s $STOREFRONT_URL/products | jq '.version'  # → "v1"
```

Talking points:

- Rollback is not a redeploy.
- Cloudflare flips the active version pointer.
- It propagates globally in seconds.
- Any of the last 100 versions is available.

---

## Stage 3 — Automated Rollout with Auto-Rollback

*"Can the system detect a regression and roll back without a human?"*

### 3a — Set up a broken version

Action:

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

Talking point:

The broken version exists as a real uploaded Worker version even after the code
is reverted locally.

### 3b — Start the load generator

Open a second terminal and keep it running throughout the demo:

```bash
while true; do
  curl -s $STOREFRONT_URL/health > /dev/null
  sleep 1
done
```

Talking point:

This generates steady traffic so the health-check step has real responses to
measure.

### 3c — Trigger the Rollout Workflow

Action:

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

Talking point:

The Workflow now owns the rollout. Your terminal can disappear and the rollout
continues from Cloudflare's side.

### 3d — Watch it roll back

Talking points:

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

Talking point:

This is the full closed loop: deploy, observe, detect regression, and roll back
without a human pushing a button.

### 3e — Successful rollout

Action:

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

Talking point:

The same durable control plane handles both the failed rollout and the healthy
rollout.

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
