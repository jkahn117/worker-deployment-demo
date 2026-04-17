import { Hono } from "hono";
import { fetchCatalog } from "./catalog.js";
import { fetchInventory, fetchStockForProduct } from "./inventory.js";
import type {
  HealthResponse,
  ProductDetailResponse,
  ProductsResponse,
} from "./types.js";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// All responses include version, environment, and region so that the traffic
// split is visible in curl output without needing to parse the JSON body.
function versionHeaders(env: Env, region: string): Record<string, string> {
  return {
    "X-Worker-Version": env.VERSION_METADATA.tag,
    "X-Worker-Environment": env.ENVIRONMENT,
    "X-Worker-Region": region,
  };
}

// request.cf is typed as IncomingRequestCfProperties | {} so we must cast
// before accessing named properties.
function getRegion(request: Request): string {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return cf?.region ?? "unknown";
}

function getFeaturedCollection(versionTag: string, fallback: string): string {
  if (versionTag.startsWith("v2")) {
    return "End-of-Season Sale";
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Fault injection
// Used by the v2-broken version to simulate upstream errors on ~30% of
// requests, triggering the Rollout Workflow's health-check threshold.
// In v1 and v2 this always returns false — the diff is a single-line change.
// ---------------------------------------------------------------------------

function shouldInjectFault(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET / — plain-text summary, useful as a quick sanity check without jq
app.get("/", (c) => {
  const env = c.env;
  const region = getRegion(c.req.raw);

  return c.text(
    [
      "Storefront Worker",
      `Version:     ${env.VERSION_METADATA.tag}`,
      `Environment: ${env.ENVIRONMENT}`,
      `Region:      ${region}`,
    ].join("\n"),
    200,
    versionHeaders(env, region)
  );
});

// GET /products — catalog with per-product inventory from D1
app.get("/products", async (c) => {
  const env = c.env;
  const region = getRegion(c.req.raw);
  const versionTag = env.VERSION_METADATA.tag;

  if (shouldInjectFault()) {
    return c.json(
      { error: "upstream_timeout", version: versionTag, region },
      500,
      versionHeaders(env, region)
    );
  }

  try {
    const { products, config } = await fetchCatalog(env.PRODUCTS_KV);

    // Fetch stock for all products in a single D1 query.
    const stockMap = await fetchInventory(
      env.INVENTORY_DB,
      products.map((p) => p.id)
    );

    const body: ProductsResponse = {
      version: versionTag,
      environment: env.ENVIRONMENT,
      region,
      currency: config.currency,
      featured_collection: getFeaturedCollection(
        versionTag,
        config.featured_collection,
      ),
      products: products.map((p) => ({
        ...p,
        // null when the product exists in KV but has no D1 inventory row yet —
        // e.g. a product added live to preview KV during the isolation demo.
        stock: stockMap.get(p.id) ?? null,
      })),
    };

    return c.json(body, 200, versionHeaders(env, region));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: "catalog_unavailable", detail: message, version: versionTag },
      500,
      versionHeaders(env, region)
    );
  }
});

// GET /products/:id — single product with inventory
// Useful during the isolation demo to spotlight one product by ID.
app.get("/products/:id", async (c) => {
  const env = c.env;
  const region = getRegion(c.req.raw);
  const versionTag = env.VERSION_METADATA.tag;
  const productId = c.req.param("id");

  if (shouldInjectFault()) {
    return c.json(
      { error: "upstream_timeout", version: versionTag, region },
      500,
      versionHeaders(env, region)
    );
  }

  try {
    const { products } = await fetchCatalog(env.PRODUCTS_KV);
    const product = products.find((p) => p.id === productId);

    if (!product) {
      return c.json(
        { error: "not_found", productId, version: versionTag },
        404,
        versionHeaders(env, region)
      );
    }

    const stock = await fetchStockForProduct(env.INVENTORY_DB, productId);

    const body: ProductDetailResponse = {
      ...product,
      stock,
      version: versionTag,
      environment: env.ENVIRONMENT,
      region,
    };

    return c.json(body, 200, versionHeaders(env, region));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: "catalog_unavailable", detail: message, version: versionTag },
      500,
      versionHeaders(env, region)
    );
  }
});

// GET /health — polled by the Rollout Workflow during soak periods
app.get("/health", (c) => {
  const env = c.env;
  const region = getRegion(c.req.raw);
  const versionTag = env.VERSION_METADATA.tag;

  if (shouldInjectFault()) {
    return c.json(
      { error: "upstream_timeout", version: versionTag, region },
      500,
      versionHeaders(env, region)
    );
  }

  const body: HealthResponse = {
    ok: true,
    version: versionTag,
    region,
    timestamp: new Date().toISOString(),
  };

  return c.json(body, 200, versionHeaders(env, region));
});

export default app;
