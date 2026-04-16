# Demo Runbook

Step-by-step CLI commands and presenter notes for running the demo live.
All commands assume a working directory of the repo root unless noted.

---

## Pre-Demo Setup (do once, before the call)

### 1. Enable the Worker Previews gate

Navigate to:
```
https://dash.cloudflare.com/?devPanel=worker-previews
```
Confirm the Previews tab appears in the storefront Worker's dashboard page.

### 2. Install dependencies

Use the repo-local Wrangler installed by `pnpm`.

```bash
pnpm install
```

`npx wrangler` inside `storefront-worker/` will resolve the local workspace
install from `node_modules/.bin/wrangler` ahead of any global install.

Verify Wrangler is active within this directory:
```bash
cd storefront-worker
npx wrangler --version

# Confirm wrangler preview command is available
npx wrangler preview --help
```

### 3. Create KV namespaces

```bash
# Production namespace
npx wrangler kv namespace create storefront-prod
# Note the ID output, update storefront-worker/wrangler.jsonc kv_namespaces[0].id

# Preview namespace
npx wrangler kv namespace create storefront-preview
# Note the ID output, update storefront-worker/wrangler.jsonc previews.kv_namespaces[0].id
```

### 4. Seed KV data

```bash
# Production prices
npx wrangler kv key put --namespace-id=<prod-kv-id> "products" \
  '[{"id":"cgm-sensor","name":"CGM Sensor","price":49.99},{"id":"receiver","name":"Receiver","price":299.00},{"id":"transmitter","name":"Transmitter","price":99.00}]'

# Preview prices (different values — this is the whole point)
npx wrangler kv key put --namespace-id=<preview-kv-id> "products" \
  '[{"id":"cgm-sensor","name":"CGM Sensor","price":39.99},{"id":"receiver","name":"Receiver","price":249.00},{"id":"transmitter","name":"Transmitter","price":79.00}]'
```

### 5. Deploy the Storefront Worker (v1)

```bash
cd storefront-worker
npx wrangler deploy --tag="v1" --message="Initial production release"
```

Note the workers.dev URL output. Save as `STOREFRONT_URL` for use below.

### 6. Deploy the Rollout Workflow

```bash
cd rollout-workflow
npx wrangler secret put CLOUDFLARE_API_TOKEN
# Paste API token (Workers Scripts: Edit + Account Analytics: Read)

npx wrangler deploy
```

Note the workers.dev URL output. Save as `WORKFLOW_URL`.

### 7. Verify everything is working

```bash
# Storefront returns v1 data
curl -s $STOREFRONT_URL/products | jq .

# Workflow trigger is reachable
curl -s $WORKFLOW_URL/trigger
# Expected: 405 Method Not Allowed (GET on a POST route) — confirms it's live
```

### 8. Create the feature branch

```bash
cd storefront-worker
git checkout -b feature/v2-pricing
# The branch should already contain the v2 code changes
# (different prices in the response, "new_feature": true field)
```

---

## Stage 1 — Worker Previews (~3 min)

**Opening line:** *"Let's start where a developer starts — a feature branch."*

### Step 1.1 — Show the current production response

```bash
curl -s $STOREFRONT_URL/products | jq .
```

**Say:** *"This is production. Version 1, production prices. This is what users see."*

### Step 1.2 — Create a preview from the feature branch

```bash
cd storefront-worker
# (confirm you are on feature/v2-pricing branch)
git branch --show-current

npx wrangler preview
```

Expected output:
```
Preview created: feature-v2-pricing
Preview URL: https://feature-v2-pricing.storefront-worker.<sub>.workers.dev
```

**Say:** *"That's the preview URL. It's live on Cloudflare's network right now.
Same code, same infrastructure — but isolated from production."*

### Step 1.3 — Show the preview response

```bash
PREVIEW_URL=https://feature-v2-pricing.storefront-worker.<sub>.workers.dev
curl -s $PREVIEW_URL/products | jq .
```

**Point out:** `"environment": "preview"`, and the different prices.

**Say:** *"Same code. Different data — because the preview is bound to a separate
KV namespace. I can read, write, delete anything in there. Production is
completely untouched."*

### Step 1.4 — Show the dashboard

Open:
```
https://dash.cloudflare.com/<accountId>/workers/services/view/storefront-worker/production/previews
```

**Point out:**
- The Previews tab listing `feature-v2-pricing`
- The bindings section showing the preview KV namespace ID (different from prod)
- The separate observability section

**Say:** *"This is what the Worker Previews feature looks like. Each branch gets
its own isolated environment. The developer shares this URL with QA, gets
approval, and then merges."*

---

## Stage 2 — Manual Gradual Deployment (~5 min)

**Transition:** *"The PR is approved. Let's merge and roll out — but not all at
once."*

### Step 2.1 — Upload v2 as a staged version

```bash
cd storefront-worker
# Switch to main (or simulate a merge)
git checkout main

npx wrangler versions upload \
  --tag="v2" \
  --message="Updated pricing, new_feature field"
```

Expected output includes a Version ID. Save it:
```bash
V2_VERSION_ID=<version-id-from-output>
```

**Say:** *"That uploaded the new version to the platform, but nothing changed in
production yet. Users are still 100% on v1. This is the separation between
'version' and 'deployment' — you can stage code without exposing it."*

### Step 2.2 — Deploy at 10%

```bash
# First, get the current (v1) version ID
npx wrangler versions list
V1_VERSION_ID=<v1-version-id>

npx wrangler versions deploy \
  "$V2_VERSION_ID@10%" "$V1_VERSION_ID@90%" \
  --message="Gradual rollout: v2 at 10%"
```

### Step 2.3 — Show the traffic split

```bash
for i in {1..20}; do
  curl -s -o /dev/null -w "%{http_code} $(curl -s -H 'Accept: application/json' $STOREFRONT_URL/products | jq -r '.version')\n" $STOREFRONT_URL/products
done
```

Or simpler — just the version header:
```bash
for i in {1..20}; do
  curl -s $STOREFRONT_URL/products | jq -r '.version'
done
```

**Say:** *"About 2 out of every 20 requests go to v2. The rest stay on v1. Each
request is independently assigned — this isn't sticky routing."*

### Step 2.4 — Show the dashboard

Open:
```
https://dash.cloudflare.com/<accountId>/workers/services/view/storefront-worker/production/deployments
```

**Point out:** The deployment card showing two versions with percentage bars.

### Step 2.5 — Step to 50%, then 100%

```bash
npx wrangler versions deploy \
  "$V2_VERSION_ID@50%" "$V1_VERSION_ID@50%" \
  --message="Gradual rollout: v2 at 50%"

# Run curl loop again to show 50/50 mix

npx wrangler versions deploy \
  "$V2_VERSION_ID@100%" \
  --message="Gradual rollout: v2 at 100%"
```

### Step 2.6 — Show instant rollback

**Say:** *"Let's say something looks wrong. One command."*

```bash
npx wrangler rollback
# Interactive prompt: select v1 from the list
```

```bash
# Confirm it worked
curl -s $STOREFRONT_URL/products | jq '.version'
# → "v1"
```

**Say:** *"That's not a redeployment. The platform just changed which version
pointer is active. It propagates globally in seconds. You can roll back to any
of the last 100 versions."*

---

## Stage 3 — Automated Rollout with Auto-Rollback (~8 min)

**Transition:** *"Manual steps are fine for a rehearsed rollout. But what about
catching a regression automatically, without a human in the loop?"*

### Step 3.1 — Upload v2-broken

```bash
cd storefront-worker
npx wrangler versions upload \
  --tag="v2-broken" \
  --message="v2 with simulated regression (30% error rate)"
```

Save the version ID:
```bash
V2_BROKEN_ID=<version-id-from-output>
```

**Say:** *"I've uploaded a version that simulates a regression — it returns 500
errors on about 30% of requests. This is meant to represent a real scenario:
maybe a pricing API is flaky, maybe there's a logic error that only shows up
under certain conditions."*

### Step 3.2 — Start the load generator (separate terminal)

```bash
# Open a second terminal and run this before triggering the workflow
while true; do
  curl -s $STOREFRONT_URL/health > /dev/null
  sleep 1
done
```

**Say:** *"I need some traffic flowing through the Worker for the health checks
to have data to work with."*

### Step 3.3 — Trigger the Rollout Workflow

```bash
curl -s -X POST $WORKFLOW_URL/trigger \
  -H "Content-Type: application/json" \
  -d "{
    \"workerName\": \"storefront-worker\",
    \"targetVersionId\": \"$V2_BROKEN_ID\",
    \"accountId\": \"<accountId>\",
    \"errorThresholdPct\": 2.0,
    \"soakDuration\": \"2 minutes\"
  }" | jq .
```

Expected output:
```json
{
  "instanceId": "wf-abc123",
  "statusUrl": "https://rollout-workflow.<sub>.workers.dev/status/wf-abc123",
  "dashboardUrl": "https://dash.cloudflare.com/..."
}
```

**Copy the `dashboardUrl` and open it in the browser.**

### Step 3.4 — Watch the Workflow progress

In the browser, the Workflow instance dashboard shows steps completing in
real time:

```
validate-version      ✓ completed
deploy-10-percent     ✓ completed
soak-at-10-percent    ⏳ sleeping (resumes in ~1m 45s)
check-health-at-10    pending
...
```

**Say:** *"The Workflow deployed 10% of traffic to v2-broken, and it's now
soaking — waiting 2 minutes before checking error rates. During this time, the
load generator is hitting the Worker and some of those requests are returning
500s. The platform is recording all of that."*

**While waiting (~2 min), show the error traffic in the storefront Worker metrics:**

Open:
```
https://dash.cloudflare.com/<accountId>/workers/services/view/storefront-worker/production
```

**Point out:** Error rate chart starting to show non-zero values.

### Step 3.5 — Health check fires and triggers rollback

When `check-health-at-10` completes and the error rate exceeds 2%, the Workflow:

1. Marks the health check step as failed
2. Runs the rollback step
3. Posts a deployment restoring v1@100%

The Workflow dashboard shows:

```
validate-version      ✓ completed
deploy-10-percent     ✓ completed
soak-at-10-percent    ✓ completed
check-health-at-10    ✗ failed (error rate 28.4% > threshold 2.0%)
rollback              ✓ completed
```

**Say:** *"The health check detected that 28% of requests were failing — well
above the 2% threshold. The Workflow automatically rolled back. No alert, no
on-call page, no human decision required."*

### Step 3.6 — Confirm rollback in production

```bash
# In the terminal
curl -s $STOREFRONT_URL/products | jq '.version'
# → "v1"

# Check the deployment
npx wrangler deployments list
# Shows v1 at 100%
```

### Step 3.7 — Run again with healthy v2

```bash
curl -s -X POST $WORKFLOW_URL/trigger \
  -H "Content-Type: application/json" \
  -d "{
    \"workerName\": \"storefront-worker\",
    \"targetVersionId\": \"$V2_VERSION_ID\",
    \"accountId\": \"<accountId>\",
    \"errorThresholdPct\": 2.0,
    \"soakDuration\": \"2 minutes\"
  }" | jq .
```

**Say:** *"Now let's run it again with the healthy v2. Same process. This time
the health checks will pass and it'll promote all the way to 100%."*

Watch the Workflow steps complete successfully through to `deploy-100-percent`.

```bash
# Confirm after completion
curl -s $STOREFRONT_URL/products | jq .
# → version: "v2", new_feature: true, production prices
```

**Closing line:** *"That's the complete pipeline — from a feature branch with
isolated preview, through a gradual rollout, to automated health checking and
rollback. All Cloudflare-native. No GitHub Actions, no external orchestration,
no third-party tooling."*

---

## Fallback Procedures

### If Worker Previews gate is not working

Skip Stage 1's isolated-bindings story. Instead:

```bash
# Show the branch preview URL that Workers Builds generated on the PR
# (requires the Worker to be connected to a GitHub repo with Builds enabled)
# Open the PR on GitHub and show the preview URL comment
```

Narrate: *"Today, branch preview URLs are already available and posted to your
PRs automatically. The version with fully isolated bindings — separate databases,
separate secrets — is what's shipping as the next iteration of this feature."*

### If GraphQL analytics have no data (soak window too short)

The health check treats zero requests as "pass." Either:
- Increase traffic generation frequency: `sleep 0.5` instead of `sleep 1`
- Wait an extra minute before triggering the Workflow so there's pre-existing
  error data in the analytics window

### If the Workflow fails unexpectedly

```bash
# Check instance status
curl -s $WORKFLOW_URL/status/<instanceId> | jq .

# Manually roll back if needed
npx wrangler rollback
```

### If the deployment API call fails inside the Workflow

The step will retry up to 3 times with exponential backoff (Workflow default
retry config). If it continues to fail, the Workflow will error and the current
deployment is unchanged — no partial state.

---

## Variables Reference

Set these in your shell before running the demo:

```bash
export STOREFRONT_URL=https://storefront-worker.<sub>.workers.dev
export WORKFLOW_URL=https://rollout-workflow.<sub>.workers.dev
export ACCOUNT_ID=<your-cloudflare-account-id>
export V1_VERSION_ID=<captured-from-wrangler-versions-list>
export V2_VERSION_ID=<captured-from-wrangler-versions-upload>
export V2_BROKEN_ID=<captured-from-wrangler-versions-upload>
```
