# Workers Deployment Demo — Planning Overview

## Goal

A reusable, polished demo showing a complete Cloudflare-native deployment pipeline
for Workers. Intended to be in every SA's back pocket for any conversation about
safe deployment workflows, ephemeral environments, and progressive delivery.

The demo answers the question: *"How do I deploy 10 times a day without breaking
production?"*

---

## The Story

A team maintains a **storefront API Worker** — a routing and data layer sitting in
front of their origin. They want to:

1. Test a new feature branch in isolation before it touches production
2. Roll out a new version gradually, not all-at-once
3. Have the system automatically catch regressions and roll back, without a human
   waking up at 2am

The demo walks through each of these in order, using only Cloudflare-native
primitives.

---

## Demo Stages

### Stage 1 — Worker Previews (~3 min)

*"How do I test a feature branch without touching production data?"*

- Developer pushes `feature/v2-pricing` branch
- `wrangler preview` provisions an isolated preview environment
- Preview URL has its own KV namespace (staging data, not production)
- Show dashboard Previews tab: isolated bindings, separate observability
- Call both URLs side by side — same code, visibly different data

**Cloudflare features used:** Worker Previews (prototype, `worker-previews` gate),
`wrangler preview` command, KV namespace isolation via `previews` block in
`wrangler.jsonc`

**Key point:** The preview runs against staging price data. Even if the developer
mutates or deletes data through the preview URL, production is untouched.

---

### Stage 2 — Manual Gradual Deployment (~5 min)

*"How do I roll out a new version to 10%, then 50%, then 100%?"*

- Merge feature branch → `wrangler versions upload` (version staged, not deployed)
- `wrangler versions deploy v2@10% v1@90%`
- Loop `curl` calls to show the traffic split via `X-Worker-Version` response header
- Show Deployments tab in dashboard — live split visualization
- Step through to 50%, then 100%
- Show instant rollback: `wrangler rollback`

**Cloudflare features used:** Versions & Deployments, `wrangler versions upload`,
`wrangler versions deploy`, `VERSION_METADATA` binding, `wrangler rollback`

**Key point:** Versions are immutable. Rollback is instantaneous. No redeployment
required.

---

### Stage 3 — Automated Rollout via Workflows (~8 min)

*"Can the system detect a bad deploy and roll back automatically?"*

- Upload `v2-broken` — a version that returns errors on ~30% of requests
- Trigger the Rollout Workflow via HTTP POST
- Watch the Workflow step progression in the dashboard (real-time)
- Workflow: deploy 10% → soak 2 min → poll GraphQL for error rate → detect
  threshold exceeded → execute rollback → deployment snaps back to v1@100%
- Repeat with healthy v2 to show a successful full rollout

**Cloudflare features used:** Cloudflare Workflows (durable steps, `step.sleep`,
`step.do`), Workers REST API (deployments endpoint, beta), GraphQL Analytics API
(`workersInvocationsAdaptive`)

**Key point:** This is fully Cloudflare-native automation. No GitHub Actions, no
external orchestration. The Workflow is durable — if it's interrupted mid-soak,
it resumes from where it was.

---

## Repository Structure

```
worker-deployment-demo/
├── _plan_/                     # Planning documents (this folder)
│   ├── README.md               # This file
│   ├── storefront-worker.md    # Storefront Worker spec
│   ├── rollout-workflow.md     # Rollout Workflow spec
│   └── demo-runbook.md         # Presenter script
│
├── storefront-worker/          # The "application" being deployed
│   ├── src/index.ts
│   ├── wrangler.jsonc
│   └── package.json
│
└── rollout-workflow/           # The automation engine
    ├── src/index.ts
    ├── wrangler.jsonc
    └── package.json
```

---

## Cloudflare Account Setup Required

Before the demo can be run, the following must be provisioned on the target account:

| Resource | Purpose | Notes |
|---|---|---|
| `worker-previews` gate enabled | Stage 1: Worker Previews UI | Internal prototype gate |
| KV namespace: `storefront-prod` | Production product data | Seeded before demo |
| KV namespace: `storefront-preview` | Preview (staging) product data | Seeded with different values |
| KV namespace: `rollout-config` | Rollout Workflow state/config | Created by Workflow setup |
| Workers API token | Workflow makes API calls | Needs `Workers Scripts: Edit` + `Account Analytics: Read` |
| Stable Wrangler installed | `wrangler preview` command | `pnpm install` |

---

## Feature Status Reference

| Feature | Status | Notes |
|---|---|---|
| Worker Previews | Internal prototype | `worker-previews` gate; no GitHub auto-integration yet |
| `wrangler preview` command | Stable Wrangler | Installed via `pnpm install` |
| Branch preview URLs (GA) | GA (Jul 2025) | Fallback if prototype is unstable |
| Gradual Deployments | GA | `wrangler versions deploy` |
| `VERSION_METADATA` binding | GA | Available in all Workers |
| Workers Deployments REST API | Beta (Sep 2025) | Used by Workflow for programmatic deploys |
| Cloudflare Workflows | GA | Used for automated rollout |
| GraphQL Analytics (`workersInvocationsAdaptive`) | GA | Used for health polling |
| Instant rollback (100 versions) | GA (Sep 2025) | `wrangler rollback` |

---

## Fallback Plan

If the Worker Previews prototype is unstable on demo day:

- Skip the isolated-bindings story
- Use GA branch preview URLs instead: connect the Worker to a GitHub repo via
  Workers Builds, push a branch, show the PR comment with branch preview URL
- Narrate: "This is what's available today. The version with isolated bindings —
  separate KV, separate secrets — is what's shipping next."

Stages 2 and 3 have no dependency on Worker Previews and are unaffected.

---

## Key Talking Points (cross-cutting)

- **No external dependencies.** Everything shown runs on Cloudflare. No GitHub
  Actions, no CircleCI, no Spinnaker.
- **Rollback is instant.** Not a redeploy — the platform just changes which
  version pointer is active.
- **Backend errors can trigger rollback.** The storefront Worker checks origin
  response codes. If the upstream is returning 500s, the Worker returns 500s.
  The Workflow polls for those.
- **The Workflow is durable.** If the machine running the demo loses connectivity
  mid-soak, the Workflow resumes from the last completed step.
- **Preview isolation means safe testing.** Developers can test against realistic
  data without any risk of mutating production state.
