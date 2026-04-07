# Rollout Workflow — Component Spec

## Purpose

A durable, automated deployment pipeline implemented as a Cloudflare Workflow.
It accepts a target version ID, steps through percentage-based traffic splits
with soak periods between each, polls the Analytics API for error rates, and
rolls back automatically if a threshold is exceeded.

This is the headline feature of the demo. It answers the customer question:
*"Can the system detect a bad deploy and roll back without a human involved?"*

---

## Architecture

Two Workers in a single `wrangler.jsonc`:

```
rollout-workflow/
  src/
    index.ts          # Trigger Worker (HTTP interface)
    workflow.ts       # RolloutWorkflow class (durable execution)
  wrangler.jsonc
  package.json
```

### Trigger Worker (`src/index.ts`)

A minimal Hono app with two routes:

- `POST /trigger` — validates input, creates a Workflow instance, returns
  `{ instanceId, statusUrl }`
- `GET /status/:instanceId` — proxies to the Workflow instance status API;
  useful for polling from the terminal during the demo

### Rollout Workflow (`src/workflow.ts`)

Extends `WorkflowEntrypoint`. All meaningful logic lives here.

---

## Workflow Input

```typescript
type RolloutParams = {
  workerName: string;          // e.g. "storefront-worker"
  targetVersionId: string;     // The version ID to roll out
  accountId: string;           // Cloudflare account ID
  errorThresholdPct: number;   // Default: 2.0 (i.e. 2%)
  soakDuration: string;        // Default: "2 minutes" (short for demo; "5 minutes" for real use)
}
```

For the demo, `soakDuration` is set to `"2 minutes"` to keep Stage 3 under 10
minutes total. The value is explicitly configurable so the presenter can narrate
"in production you'd set this to 15-30 minutes."

---

## Step Sequence

```
RolloutWorkflow.run(event, step):

  ┌─ step.do: "validate-version"
  │   Call GET /accounts/{accountId}/workers/scripts/{workerName}/deployments
  │   Capture currentVersionId (the version currently at 100%)
  │   Confirm targetVersionId exists in versions list
  │   Return: { currentVersionId }
  │
  ├─ step.do: "deploy-10-percent"
  │   Call POST /deployments: [targetVersionId@10%, currentVersionId@90%]
  │   Return: { deploymentId, timestamp }
  │
  ├─ step.sleep: "soak-at-10-percent"  (soakDuration)
  │
  ├─ step.do: "check-health-at-10"
  │   Poll GraphQL: workersInvocationsAdaptive for last {soakDuration}
  │   Compute: errorRate = sum.errors / sum.requests
  │   If errorRate > errorThresholdPct → throw (triggers rollback path)
  │   Return: { errorRate, requestCount, healthy: true }
  │
  ├─ step.do: "deploy-50-percent"
  │   Call POST /deployments: [targetVersionId@50%, currentVersionId@50%]
  │
  ├─ step.sleep: "soak-at-50-percent"  (soakDuration)
  │
  ├─ step.do: "check-health-at-50"
  │   Same as check-health-at-10
  │
  ├─ step.do: "deploy-100-percent"
  │   Call POST /deployments: [targetVersionId@100%]
  │   Return: { success: true, finalVersionId: targetVersionId }
  │
  └─ (on any health check throw):
     └─ step.do: "rollback"
         Call POST /deployments: [currentVersionId@100%]
         Return: { rolledBack: true, reason: "error rate N% exceeded threshold M%" }
```

### On error handling

Health check steps throw when the threshold is exceeded. Workflows do not
automatically retry a thrown step — the throw propagates to the top level. The
Workflow catches it at the top level and runs the rollback step before returning.

This means the rollback step is implemented in the `run` method's catch block,
not as a named step in the linear sequence. This keeps the happy path readable
and ensures rollback is always attempted even if an unexpected error occurs
mid-rollout.

```typescript
async run(event: WorkflowEvent<RolloutParams>, step: WorkflowStep) {
  let currentVersionId: string;

  try {
    const validated = await step.do("validate-version", async () => { ... });
    currentVersionId = validated.currentVersionId;

    await step.do("deploy-10-percent", async () => { ... });
    await step.sleep("soak-at-10-percent", params.soakDuration);
    await step.do("check-health-at-10", async () => { ... });

    await step.do("deploy-50-percent", async () => { ... });
    await step.sleep("soak-at-50-percent", params.soakDuration);
    await step.do("check-health-at-50", async () => { ... });

    await step.do("deploy-100-percent", async () => { ... });

    return { success: true };

  } catch (err) {
    await step.do("rollback", async () => {
      // deploy currentVersionId@100%
    });
    return { rolledBack: true, reason: String(err) };
  }
}
```

---

## External API Calls

### 1. Get current deployment

```
GET https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{workerName}/deployments
Authorization: Bearer {CLOUDFLARE_API_TOKEN}
```

Response: extract `result.deployments[0].versions[0].version_id` (current 100%
version). This is captured in "validate-version" and stored as `currentVersionId`
for the rollback step.

### 2. Create a deployment (gradual split)

Uses the new Workers beta REST API (GA Sep 2025):

```
POST https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{workerName}/deployments
Authorization: Bearer {CLOUDFLARE_API_TOKEN}
Content-Type: application/json

{
  "strategy": "percentage",
  "versions": [
    { "version_id": "<targetVersionId>", "percentage": 10 },
    { "version_id": "<currentVersionId>", "percentage": 90 }
  ]
}
```

The same endpoint is used for 10/90, 50/50, and 100/0 splits. For 100%, only
one version object is included in the array.

### 3. Poll error rate (GraphQL Analytics)

```
POST https://api.cloudflare.com/client/v4/graphql
Authorization: Bearer {CLOUDFLARE_API_TOKEN}
Content-Type: application/json

{
  "query": "query WorkerErrors($accountTag: string, $scriptName: string, $from: string, $to: string) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 1000,
          filter: {
            scriptName: $scriptName,
            datetime_geq: $from,
            datetime_leq: $to
          }
        ) {
          sum { requests errors }
        }
      }
    }
  }",
  "variables": {
    "accountTag": "<accountId>",
    "scriptName": "storefront-worker",
    "from": "<soakWindowStart>",
    "to": "<now>"
  }
}
```

The soak window start is `Date.now() - soakDurationMs` passed in as ISO 8601.

Error rate: `totalErrors / totalRequests`. If `totalRequests === 0` (no traffic
during soak), the health check passes — the demo requires traffic during Stage 3,
handled by the load generator script in the runbook.

---

## Configuration

### `wrangler.jsonc`

```jsonc
{
  "name": "rollout-workflow",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],

  "observability": {
    "enabled": true
  },

  "workflows": [
    {
      "name": "rollout-workflow",
      "binding": "ROLLOUT_WORKFLOW",
      "class_name": "RolloutWorkflow",
      "script_name": "rollout-workflow"
    }
  ],

  "secrets": ["CLOUDFLARE_API_TOKEN"]
}
```

The `CLOUDFLARE_API_TOKEN` secret is set via `wrangler secret put` during setup.
It must have:
- `Workers Scripts: Edit` (to create deployments)
- `Account Analytics: Read` (to query GraphQL)

### Environment type definition

```typescript
interface Env {
  ROLLOUT_WORKFLOW: Workflow;
  CLOUDFLARE_API_TOKEN: string;
}
```

---

## Trigger Worker API

### `POST /trigger`

Request body:

```json
{
  "workerName": "storefront-worker",
  "targetVersionId": "abc123...",
  "accountId": "abc...",
  "errorThresholdPct": 2.0,
  "soakDuration": "2 minutes"
}
```

Response:

```json
{
  "instanceId": "wf-abc123",
  "statusUrl": "https://rollout-workflow.<sub>.workers.dev/status/wf-abc123",
  "dashboardUrl": "https://dash.cloudflare.com/<accountId>/workers/services/view/rollout-workflow/production/workflows/rollout-workflow/instances/wf-abc123"
}
```

The `dashboardUrl` is constructed from known URL patterns and opens directly
to the Workflow instance in the dashboard — the presenter copies this from the
terminal output and pastes it into the browser to show real-time step progression.

### `GET /status/:instanceId`

Proxies to the Workflow instance API and returns:

```json
{
  "status": "running",
  "currentStep": "soak-at-10-percent",
  "steps": [
    { "name": "validate-version",   "status": "completed" },
    { "name": "deploy-10-percent",  "status": "completed" },
    { "name": "soak-at-10-percent", "status": "sleeping", "resumesAt": "2026-04-06T12:03:00Z" }
  ]
}
```

---

## Demo-specific Notes

### Soak duration

`"2 minutes"` for the demo, explicitly narrated as configurable. The presenter
says: *"In the demo I'm using a 2-minute soak so we're not sitting here for 30
minutes. In your setup you'd set this to however long makes sense for your traffic
volume — 15 minutes, 30 minutes, whatever your error budget requires."*

### Traffic generation during Stage 3

The Rollout Workflow's health check needs actual request traffic to compute a
meaningful error rate. Before triggering the Workflow, run a background load
generator:

```bash
# Run in a separate terminal before triggering the workflow
while true; do
  curl -s https://storefront-worker.<sub>.workers.dev/health > /dev/null
  sleep 1
done
```

This generates ~60 requests per minute through the soak window, enough for the
GraphQL query to return a non-zero `sum.requests` and a detectable `sum.errors`
from `v2-broken`.

### Analytics lag

The GraphQL `workersInvocationsAdaptive` dataset has approximately 1-2 minutes
of lag. Because the soak duration is 2 minutes and the health check fires at the
end of the soak, the data should be available by the time the query runs.

If it is not (i.e., `sum.requests === 0`), the health check step treats this as
"insufficient data — pass" and continues. This is a deliberate safety default:
never roll back due to lack of data.

---

## What the Presenter Shows

| Moment | What to show | Why it matters |
|---|---|---|
| Trigger POST | `curl -X POST /trigger ...` → returns instanceId + dashboardUrl | Simple trigger — one HTTP call |
| Workflow dashboard | Open dashboardUrl → watch steps tick | The pipeline is visible, not a black box |
| Soak sleeping | Step shows "sleeping, resumes in Xm" | Durable — not a long-running process |
| Health check pass | Step completes, next deploy fires | Automation making the right call |
| Health check fail | Step completes, rollback fires, deployment snaps back | Zero human intervention on a bad deploy |
| Successful run | Final step shows "deploy-100-percent: completed" | Full rollout done, all automated |
