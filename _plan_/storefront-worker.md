# Storefront Worker — Component Spec

## Purpose

A simple, believable API Worker that returns product catalog data from KV. It
exists solely to be deployed, previewed, and rolled back. Its responses must make
the deployment story legible — a viewer should immediately see "that's a different
version" from the output alone.

The domain is a generic clothing store. Products, prices, and featured collections
change between versions. The geography field changes based on the request origin.
Both axes — version and location — are visible in every response, so any change
in either is immediately obvious.

The Worker is deliberately shallow in business logic. The interesting parts are
its configuration and how it behaves across versions.

---

## Endpoints

### `GET /products`

Returns a JSON catalog response. This is the primary demo endpoint.

```json
{
  "version": "v1",
  "environment": "production",
  "region": "ENAM",
  "currency": "USD",
  "featured_collection": "Summer Basics",
  "products": [
    { "id": "tshirt-crew",   "name": "Crew T-Shirt",      "price": 19.99, "badge": null },
    { "id": "chino-slim",    "name": "Slim Chinos",        "price": 59.99, "badge": null },
    { "id": "hoodie-zip",    "name": "Zip Hoodie",         "price": 79.99, "badge": null }
  ]
}
```

Key fields:

- `version` — from `VERSION_METADATA.tag`. Changes between v1/v2 and is visible
  in every response without needing to compare prices.
- `environment` — from `ENVIRONMENT` var. `"production"` in prod, `"preview"` in
  previews. Proves KV isolation at a glance (Stage 1).
- `region` — from `request.cf.region` (Cloudflare geo metadata). Shows the
  request's geographic origin. Relevant if geo routing is discussed.
- `featured_collection` — changes between v1 and v2. A simple string that makes
  the version difference immediately obvious without scrutinising price deltas.
- `badge` — `null` in v1, `"new"` on newly added products in v2. Another
  unambiguous version signal.

Products are read from KV (`PRODUCTS_KV`). Because production and preview use
different KV namespaces, the catalog returned differs visibly between environments.

### `GET /health`

Used by the Rollout Workflow during health polling.

```json
{
  "ok": true,
  "version": "v1",
  "region": "ENAM",
  "timestamp": "2026-04-06T12:00:00.000Z"
}
```

Returns `200` in all healthy versions. In `v2-broken`, returns `500` on ~30%
of requests — see below.

### `GET /`

Plain-text summary. Quick sanity check without `jq`.

```
Storefront Worker
Version:     v2
Environment: production
Region:      ENAM
Collection:  End-of-Season Sale
```

---

## Versions

### v1 — Baseline

The initial production state. Establishes the baseline the audience sees
before any change is introduced.

- `featured_collection`: `"Summer Basics"`
- Products: 3 items, standard prices, `badge: null` on all
- `version` tag: `"v1"`
- All endpoints healthy

**KV catalog (production namespace):**

```json
[
  { "id": "tshirt-crew",  "name": "Crew T-Shirt",  "price": 19.99, "badge": null },
  { "id": "chino-slim",   "name": "Slim Chinos",    "price": 59.99, "badge": null },
  { "id": "hoodie-zip",   "name": "Zip Hoodie",     "price": 79.99, "badge": null }
]
```

### v2 — New Feature Branch

The change the developer is rolling out. Multiple visible differences from v1
so no one has to squint to notice a change:

- `featured_collection`: `"End-of-Season Sale"` (different string, immediately obvious)
- Adds a 4th product (`"Puffer Vest"`) with `"badge": "new"`
- Prices on existing items reduced (sale pricing)
- `version` tag: `"v2"`
- All endpoints healthy

**KV catalog (production namespace — updated for v2):**

```json
[
  { "id": "tshirt-crew",  "name": "Crew T-Shirt",  "price": 14.99, "badge": "sale" },
  { "id": "chino-slim",   "name": "Slim Chinos",    "price": 44.99, "badge": "sale" },
  { "id": "hoodie-zip",   "name": "Zip Hoodie",     "price": 59.99, "badge": "sale" },
  { "id": "puffer-vest",  "name": "Puffer Vest",    "price": 89.99, "badge": "new"  }
]
```

**Preview namespace catalog** (used in Stage 1 — same v2 code, different KV):

```json
[
  { "id": "tshirt-crew",  "name": "Crew T-Shirt",  "price": 9.99,  "badge": "preview-sale" },
  { "id": "chino-slim",   "name": "Slim Chinos",    "price": 29.99, "badge": "preview-sale" },
  { "id": "hoodie-zip",   "name": "Zip Hoodie",     "price": 39.99, "badge": "preview-sale" },
  { "id": "puffer-vest",  "name": "Puffer Vest",    "price": 59.99, "badge": "new"  }
]
```

The `"preview-sale"` badge and dramatically lower prices make it immediately
clear this is test data, not production. The presenter says: *"These are staging
prices. If someone accidentally hits this endpoint in prod, they won't see
$9 t-shirts — that data only exists in the preview KV namespace."*

### v2-broken — Simulated Regression

Same code as v2 but injects errors on ~30% of requests. Used to trigger
auto-rollback in Stage 3.

- `version` tag: `"v2-broken"`
- `/products` and `/health` return `500` on ~30% of calls
- The error response body is explicit so `curl` output makes it obvious:

```json
{ "error": "upstream_timeout", "version": "v2-broken", "region": "ENAM" }
```

Fault injection code:

```typescript
if (Math.random() < 0.3) {
  return new Response(
    JSON.stringify({
      error: "upstream_timeout",
      version: versionTag,
      region: request.cf?.region ?? "unknown",
    }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}
```

The `"upstream_timeout"` message frames this as a realistic failure mode
(a flaky upstream, not a code bug), which resonates with real-world scenarios.

---

## Response Headers

Every response includes:

```
X-Worker-Version:     v2
X-Worker-Environment: production
X-Worker-Region:      ENAM
```

These make the traffic split visible during the `curl` loop in Stage 2 without
parsing the full JSON body:

```bash
for i in {1..20}; do
  curl -s $STOREFRONT_URL/products | jq -r '"\(.version)  \(.region)  \(.featured_collection)"'
done
```

Sample output during a 10/90 split:

```
v1  ENAM  Summer Basics
v1  ENAM  Summer Basics
v2  ENAM  End-of-Season Sale   ← new version
v1  ENAM  Summer Basics
v1  ENAM  Summer Basics
...
```

The version and collection name change together, making the split unambiguous.

---

## Configuration

### `wrangler.jsonc`

```jsonc
{
  "name": "storefront-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-01",

  "observability": {
    "enabled": true
  },

  "version_metadata": {
    "binding": "VERSION_METADATA"
  },

  "vars": {
    "ENVIRONMENT": "production"
  },

  "kv_namespaces": [
    {
      "binding": "PRODUCTS_KV",
      "id": "<prod-kv-namespace-id>"
    }
  ],

  "previews": {
    "vars": {
      "ENVIRONMENT": "preview"
    },
    "kv_namespaces": [
      {
        "binding": "PRODUCTS_KV",
        "id": "<preview-kv-namespace-id>"
      }
    ],
    "observability": {
      "enabled": true
    }
  }
}
```

### Environment type definition

```typescript
interface Env {
  PRODUCTS_KV: KVNamespace;
  ENVIRONMENT: string;
  VERSION_METADATA: {
    id: string;
    tag: string;
    message: string;
    timestamp: string;
  };
}
```

---

## KV Seeding Commands

Run once during setup. Replace namespace IDs from `wrangler kv namespace create` output.

```bash
# Production namespace — v1 catalog
wrangler kv key put --namespace-id=<prod-kv-id> "products" \
  '[{"id":"tshirt-crew","name":"Crew T-Shirt","price":19.99,"badge":null},{"id":"chino-slim","name":"Slim Chinos","price":59.99,"badge":null},{"id":"hoodie-zip","name":"Zip Hoodie","price":79.99,"badge":null}]'

wrangler kv key put --namespace-id=<prod-kv-id> "config" \
  '{"featured_collection":"Summer Basics","currency":"USD"}'

# Preview namespace — same products, clearly-test prices and badges
wrangler kv key put --namespace-id=<preview-kv-id> "products" \
  '[{"id":"tshirt-crew","name":"Crew T-Shirt","price":9.99,"badge":"preview-sale"},{"id":"chino-slim","name":"Slim Chinos","price":29.99,"badge":"preview-sale"},{"id":"hoodie-zip","name":"Zip Hoodie","price":39.99,"badge":"preview-sale"},{"id":"puffer-vest","name":"Puffer Vest","price":59.99,"badge":"new"}]'

wrangler kv key put --namespace-id=<preview-kv-id> "config" \
  '{"featured_collection":"End-of-Season Sale","currency":"USD"}'
```

Before Stage 2, update the production KV to the v2 catalog:

```bash
wrangler kv key put --namespace-id=<prod-kv-id> "products" \
  '[{"id":"tshirt-crew","name":"Crew T-Shirt","price":14.99,"badge":"sale"},{"id":"chino-slim","name":"Slim Chinos","price":44.99,"badge":"sale"},{"id":"hoodie-zip","name":"Zip Hoodie","price":59.99,"badge":"sale"},{"id":"puffer-vest","name":"Puffer Vest","price":89.99,"badge":"new"}]'

wrangler kv key put --namespace-id=<prod-kv-id> "config" \
  '{"featured_collection":"End-of-Season Sale","currency":"USD"}'
```

Note: KV updates take effect immediately and independently of Worker versions.
Update the KV after uploading v2 but before deploying it, so both the code
change and the data change land together in production.

---

## Deployment Sequence

```
1. wrangler deploy                               # Deploy v1 at 100% (initial state)

2. # (feature branch work)
   wrangler preview                              # Stage 1: isolated preview with preview KV

3. wrangler versions upload \
     --tag="v2" \
     --message="End-of-season sale, puffer vest" # Stage 2: upload without deploying

4. wrangler versions deploy v2@10% v1@90%        # Stage 2: begin gradual rollout

5. wrangler versions upload \
     --tag="v2-broken" \
     --message="v2 with simulated upstream error" # Stage 3 setup

6. # Rollout Workflow handles step 6 onward
```

---

## Wrangler Preview Note

`wrangler preview` requires the prerelease build from PR #12983 (not yet merged
to `cloudflare:main` as of 2026-04-06). Install it locally inside this package
only — no global wrangler is affected:

```bash
# Inside storefront-worker/ only
npm i https://pkg.pr.new/wrangler@12983
```

`npx wrangler` resolves `node_modules/.bin/wrangler` before any global install,
so the prerelease is used automatically within this directory. The
`rollout-workflow/` package uses standard wrangler and is unaffected.

Check https://github.com/cloudflare/workers-sdk/pull/12983 before the demo —
if the PR has merged, replace with `npm i wrangler@latest` and the local
override is no longer needed.

---

## Observability

With `observability: { enabled: true }` in both production and preview configs:

- All requests are traced automatically
- The Worker dashboard shows request counts, error rates, p50/p99 CPU time
- Response headers make it easy to split metrics by version

The Rollout Workflow uses `workersInvocationsAdaptive` GraphQL to query error
rates during soak periods. The `scriptName` filter isolates this Worker's metrics.
Error rate is computed as `sum.errors / sum.requests` over the soak window.

---

## What the Presenter Shows

| Moment | What to show | Why it matters |
|---|---|---|
| Stage 1: preview vs prod | `curl` both URLs — different `environment`, prices, badges | Same code, isolated data — preview is safe |
| Stage 1: dashboard | Previews tab, separate KV binding listed | Visual proof of isolation |
| Stage 2: split deploy | `curl` loop — `version` and `featured_collection` flip between v1/v2 | Split is obvious without reading numbers |
| Stage 2: dashboard | Deployments tab with percentage bars | Platform tracks this natively |
| Stage 3: broken deploy | Mixed `200` and `500` responses with `"upstream_timeout"` | Regression is realistic and visible |
| Stage 3: auto-rollback | Workflow dashboard steps complete, deployment snaps to v1@100% | Zero human intervention |
