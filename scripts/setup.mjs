#!/usr/bin/env node
// setup.mjs — one-time provisioning for the Workers Deployment Demo.
//
// Usage:
//   node scripts/setup.mjs
//   (or via the wrapper: bash scripts/setup.sh)

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import * as p from "@clack/prompts";
import { getWranglerInvocation, resetWrangler } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STOREFRONT_DIR = resolve(REPO_ROOT, "packages/storefront-worker");
const WORKFLOW_DIR = resolve(REPO_ROOT, "packages/rollout-workflow");
const WRANGLER_JSONC = resolve(STOREFRONT_DIR, "wrangler.jsonc");
const WRANGLER = getWranglerInvocation();

// ---------------------------------------------------------------------------
// Wrangler runner
// Passes accountId via CLOUDFLARE_ACCOUNT_ID env var — this is the correct
// mechanism; there is no --account-id CLI flag on most wrangler subcommands.
// ---------------------------------------------------------------------------
function wrangler(args, { cwd = STOREFRONT_DIR, accountId } = {}) {
  try {
    return execFileSync(WRANGLER.command, [...WRANGLER.args, ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
      },
      // Capture both stdout and stderr so we can parse wrangler output
      stdio: ["inherit", "pipe", "pipe"],
    });
  } catch (err) {
    const output = (err.stdout ?? "") + (err.stderr ?? "");
    throw new Error(`wrangler ${args.join(" ")} failed:\n${output}`);
  }
}

// Same as wrangler() but streams output directly to the terminal (for
// commands where live output matters: deploy, migrations, secret put).
function wranglerLive(args, { cwd = STOREFRONT_DIR, accountId } = {}) {
  execFileSync(WRANGLER.command, [...WRANGLER.args, ...args], {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Output parsing helpers
// ---------------------------------------------------------------------------

// Extracts the first JSON array from wrangler output.
// kv namespace list and d1 list --json both emit a bare JSON array.
function extractJsonArray(output) {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Extracts a KV namespace ID from `wrangler kv namespace create` output.
// wrangler prints a JSON config snippet containing the id, e.g.:
//   { "binding": "my_ns", "id": "abc123..." }
function extractKvId(output) {
  const match = output.match(/"id":\s*"([0-9a-f]{32})"/);
  return match?.[1] ?? null;
}

// Extracts a D1 database UUID from `wrangler d1 create` output.
// wrangler prints a table row or JSON containing the uuid.
function extractD1Id(output) {
  // Try JSON first (some versions emit it)
  const jsonMatch =
    output.match(/"database_id":\s*"([0-9a-f-]{36})"/i) ??
    output.match(/"uuid":\s*"([0-9a-f-]{36})"/i) ??
    output.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
  return jsonMatch?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Temp wrangler config writer
// d1 migrations apply and d1 execute resolve the DB by name from the config
// file. The preview DB lives in the unsupported `previews` block, so we write
// a minimal temp config pointing directly at the target database_id.
// migrations_dir must be absolute since the config is in a temp directory.
// ---------------------------------------------------------------------------
function writeTempD1Config(dbName, dbId) {
  const configPath = resolve(tmpdir(), `wrangler-${dbName}.jsonc`);
  const migrationsDir = resolve(STOREFRONT_DIR, "migrations");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "temp",
      main: "src/index.ts",
      compatibility_date: "2026-04-01",
      d1_databases: [
        {
          binding: "INVENTORY_DB",
          database_name: dbName,
          database_id: dbId,
          migrations_dir: migrationsDir,
        },
      ],
    }),
  );
  return configPath;
}

// ---------------------------------------------------------------------------
// wrangler.jsonc patcher
// ---------------------------------------------------------------------------
function patchWrangler(placeholder, value) {
  let content = readFileSync(WRANGLER_JSONC, "utf8");
  if (!content.includes(placeholder)) {
    throw new Error(`Placeholder "${placeholder}" not found in wrangler.jsonc`);
  }
  writeFileSync(WRANGLER_JSONC, content.replace(placeholder, value));
}

// ---------------------------------------------------------------------------
// KV / D1 resource helpers
// ---------------------------------------------------------------------------

function kvIdByName(name, accountId) {
  // kv namespace list emits a clean JSON array — no --json flag needed
  const out = wrangler(["kv", "namespace", "list"], { accountId });
  const list = extractJsonArray(out);
  return Array.isArray(list)
    ? (list.find((n) => n.title === name)?.id ?? null)
    : null;
}

function d1IdByName(name, accountId) {
  const out = wrangler(["d1", "list", "--json"], { accountId });
  const list = extractJsonArray(out);
  return Array.isArray(list)
    ? (list.find((d) => d.name === name)?.uuid ?? null)
    : null;
}

async function createKvNamespace(name, accountId, spin) {
  spin.message(`Creating KV namespace: ${name}`);
  try {
    const out = wrangler(["kv", "namespace", "create", name], { accountId });
    const id = extractKvId(out);
    if (id) return id;
  } catch {
    /* namespace may already exist */
  }

  spin.message(`Looking up existing KV namespace: ${name}`);
  const id = kvIdByName(name, accountId);
  if (!id) throw new Error(`Could not create or find KV namespace: ${name}`);
  return id;
}

async function createD1Database(name, accountId, spin) {
  spin.message(`Creating D1 database: ${name}`);
  try {
    const out = wrangler(["d1", "create", name], { accountId });
    const id = extractD1Id(out);
    if (id) return id;
  } catch {
    /* database may already exist */
  }

  spin.message(`Looking up existing D1 database: ${name}`);
  const id = d1IdByName(name, accountId);
  if (!id) throw new Error(`Could not create or find D1 database: ${name}`);
  return id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  p.intro("Workers Deployment Demo — Setup");

  // Always reset to placeholders first so setup can be rerun safely.
  resetWrangler(WRANGLER_JSONC);

  // ── Preflight ──────────────────────────────────────────────────────────
  const preflight = p.spinner();
  preflight.start("Checking prerequisites");

  let whoami;
  try {
    whoami = JSON.parse(
      execFileSync(WRANGLER.command, [...WRANGLER.args, "whoami", "--json"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: process.env,
        stdio: ["inherit", "pipe", "pipe"],
      }),
    );
  } catch (err) {
    preflight.stop("wrangler whoami failed", 1);
    p.cancel("Run `wrangler login` and try again.");
    process.exit(1);
  }

  preflight.stop(
    `Node ${process.version}  •  wrangler authenticated as ${whoami.email}`,
  );

  // ── Account selection ──────────────────────────────────────────────────
  const accounts = whoami.accounts ?? [];
  if (accounts.length === 0) {
    p.cancel("No accounts found. Run `wrangler login`.");
    process.exit(1);
  }

  let accountId;
  let accountName;

  if (accounts.length === 1) {
    accountId = accounts[0].id;
    accountName = accounts[0].name;
    p.log.info(`Using account: ${accountName} (${accountId})`);
  } else {
    const selected = await p.select({
      message: "Select Cloudflare account",
      options: accounts.map((a) => ({
        value: a.id,
        label: a.name,
        hint: a.id,
      })),
    });
    if (p.isCancel(selected)) {
      p.cancel("Aborted.");
      process.exit(0);
    }
    accountId = selected;
    accountName = accounts.find((a) => a.id === selected)?.name ?? selected;
  }

  // ── KV namespaces ──────────────────────────────────────────────────────
  const kvSpin = p.spinner();
  kvSpin.start("Provisioning KV namespaces");

  const kvProdId = await createKvNamespace(
    "storefront-prod",
    accountId,
    kvSpin,
  );
  patchWrangler("<PROD_KV_NAMESPACE_ID>", kvProdId);

  const kvPreviewId = await createKvNamespace(
    "storefront-preview",
    accountId,
    kvSpin,
  );
  patchWrangler("<PREVIEW_KV_NAMESPACE_ID>", kvPreviewId);

  kvSpin.stop("KV namespaces ready");
  p.log.info(`  storefront-prod:    ${kvProdId}`);
  p.log.info(`  storefront-preview: ${kvPreviewId}`);

  // ── D1 databases ───────────────────────────────────────────────────────
  const d1Spin = p.spinner();
  d1Spin.start("Provisioning D1 databases");

  const d1ProdId = await createD1Database(
    "storefront-inventory-prod",
    accountId,
    d1Spin,
  );
  patchWrangler("<PROD_D1_DATABASE_ID>", d1ProdId);

  const d1PreviewId = await createD1Database(
    "storefront-inventory-preview",
    accountId,
    d1Spin,
  );
  patchWrangler("<PREVIEW_D1_DATABASE_ID>", d1PreviewId);

  d1Spin.stop("D1 databases ready");
  p.log.info(`  storefront-inventory-prod:    ${d1ProdId}`);
  p.log.info(`  storefront-inventory-preview: ${d1PreviewId}`);

  // ── D1 migrations ──────────────────────────────────────────────────────
  // Use temp configs with explicit database_id values so wrangler can
  // resolve both DBs regardless of the `previews` block in wrangler.jsonc.
  p.log.step("Applying D1 migrations");

  const d1ProdConfigPath = writeTempD1Config(
    "storefront-inventory-prod",
    d1ProdId,
  );
  const d1PreviewConfigPath = writeTempD1Config(
    "storefront-inventory-preview",
    d1PreviewId,
  );

  try {
    p.log.info("  Production database (schema + seed)...");
    wranglerLive(
      [
        "d1",
        "migrations",
        "apply",
        "storefront-inventory-prod",
        `--config=${d1ProdConfigPath}`,
        "--remote",
      ],
      { accountId },
    );

    p.log.info("  Preview database (schema only — 0001)...");
    wranglerLive(
      [
        "d1",
        "migrations",
        "apply",
        "storefront-inventory-preview",
        `--config=${d1PreviewConfigPath}`,
        "--remote",
      ],
      { accountId },
    );

    p.log.info("  Preview database (preview seed)...");
    wranglerLive(
      [
        "d1",
        "execute",
        "storefront-inventory-preview",
        `--config=${d1PreviewConfigPath}`,
        "--remote",
        `--file=${resolve(__dirname, "seed-preview.sql")}`,
      ],
      { accountId },
    );
  } finally {
    // Clean up temp config files regardless of success or failure
    try {
      unlinkSync(d1ProdConfigPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(d1PreviewConfigPath);
    } catch {
      /* ignore */
    }
  }

  p.log.success("D1 migrations applied");

  // ── KV seeding ─────────────────────────────────────────────────────────
  const kvSeedSpin = p.spinner();
  kvSeedSpin.start("Seeding KV namespaces");

  const prodProducts = JSON.stringify([
    { id: "tshirt-crew", name: "Crew T-Shirt", price: 19.99, badge: null },
    { id: "chino-slim", name: "Slim Chinos", price: 59.99, badge: null },
    { id: "hoodie-zip", name: "Zip Hoodie", price: 79.99, badge: null },
  ]);
  const prodConfig = JSON.stringify({
    featured_collection: "Summer Basics",
    currency: "USD",
  });
  const previewProducts = JSON.stringify([
    {
      id: "tshirt-crew",
      name: "Crew T-Shirt",
      price: 9.99,
      badge: "preview-sale",
    },
    {
      id: "chino-slim",
      name: "Slim Chinos",
      price: 29.99,
      badge: "preview-sale",
    },
    {
      id: "hoodie-zip",
      name: "Zip Hoodie",
      price: 39.99,
      badge: "preview-sale",
    },
    { id: "puffer-vest", name: "Puffer Vest", price: 59.99, badge: "new" },
  ]);
  const previewConfig = JSON.stringify({
    featured_collection: "End-of-Season Sale",
    currency: "USD",
  });

  wrangler(
    ["kv", "key", "put", "--namespace-id", kvProdId, "products", prodProducts],
    { accountId },
  );
  wrangler(
    ["kv", "key", "put", "--namespace-id", kvProdId, "config", prodConfig],
    { accountId },
  );
  wrangler(
    [
      "kv",
      "key",
      "put",
      "--namespace-id",
      kvPreviewId,
      "products",
      previewProducts,
    ],
    { accountId },
  );
  wrangler(
    [
      "kv",
      "key",
      "put",
      "--namespace-id",
      kvPreviewId,
      "config",
      previewConfig,
    ],
    { accountId },
  );

  kvSeedSpin.stop("KV namespaces seeded");

  // ── Worker Previews gate ───────────────────────────────────────────────
  p.log.warn(
    "Worker Previews requires a manual step to enable the dashboard gate.\n" +
      "  Option A — open this URL (may be blocked on some accounts):\n" +
      "    https://dash.cloudflare.com/?devPanel=worker-previews%3Atrue\n\n" +
      "  Option B — open dash.cloudflare.com, then run in the browser console:\n" +
      '    localStorage.setItem("devPanel", "true");\n' +
      "  Reload the page, click the ⚙️ icon bottom-left, search 'worker-previews', set to true.\n\n" +
      "  Confirm the Previews tab appears on any Worker's detail page before continuing.",
  );
  const gateConfirm = await p.confirm({
    message: "Worker Previews gate enabled?",
    initialValue: true,
  });
  if (p.isCancel(gateConfirm)) {
    p.cancel("Aborted.");
    process.exit(0);
  }
  if (!gateConfirm) {
    p.log.warn("Continuing without Worker Previews — Stage 1 will be limited.");
  }

  // ── Deploy storefront-worker ───────────────────────────────────────────
  p.log.step("Deploying storefront-worker (v1)");
  wranglerLive(
    ["deploy", "--tag=v1", "--message=Initial release — Summer Basics catalog"],
    { cwd: STOREFRONT_DIR, accountId },
  );
  p.log.success("storefront-worker deployed");

  // ── Deploy rollout-workflow ────────────────────────────────────────────
  p.log.step("Deploying rollout-workflow");
  wranglerLive(["deploy"], { cwd: WORKFLOW_DIR, accountId });
  p.log.success("rollout-workflow deployed");

  // ── Set API token secret ───────────────────────────────────────────────
  // Secret is set after deploy so the Worker script already exists on the
  // platform when the secret is bound to it.
  p.log.step("Setting CLOUDFLARE_API_TOKEN secret");
  p.log.info(
    "Required permissions: Workers Scripts:Edit + Account Analytics:Read\n" +
      "  Create one at: https://dash.cloudflare.com/profile/api-tokens",
  );
  wranglerLive(["secret", "put", "CLOUDFLARE_API_TOKEN"], {
    cwd: WORKFLOW_DIR,
    accountId,
  });
  p.log.success("Secret set");

  const workersSubdomain = await p.text({
    message:
      "workers.dev subdomain for export commands (the <sub> in https://storefront-worker.<sub>.workers.dev)",
    placeholder: "jkahn-demo-2",
    initialValue: accountName,
    validate(value) {
      if (!value || typeof value !== "string") {
        return "Subdomain is required.";
      }

      if (!/^[a-z0-9-]+$/.test(value)) {
        return "Use only lowercase letters, numbers, and hyphens.";
      }

      return undefined;
    },
  });
  if (p.isCancel(workersSubdomain)) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  p.outro(
    "Setup complete!\n\n" +
      `  Account:        ${accountName} (${accountId})\n` +
      `  KV prod:        ${kvProdId}\n` +
      `  KV preview:     ${kvPreviewId}\n` +
      `  D1 prod:        ${d1ProdId}\n` +
      `  D1 preview:     ${d1PreviewId}\n\n` +
      "  Next steps:\n" +
      `    export STOREFRONT_URL=https://storefront-worker.${workersSubdomain}.workers.dev\n` +
      `    export WORKFLOW_URL=https://rollout-workflow.${workersSubdomain}.workers.dev\n` +
      `    export ACCOUNT_ID=${accountId}`,
  );
}

// Only run when invoked directly — not when imported by teardown.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
