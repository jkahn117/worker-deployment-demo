#!/usr/bin/env node
// teardown.mjs — delete all resources provisioned by setup.mjs.

import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as p from "@clack/prompts";
import { resetWrangler } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STOREFRONT_DIR = resolve(REPO_ROOT, "packages/storefront-worker");
const WORKFLOW_DIR = resolve(REPO_ROOT, "packages/rollout-workflow");

// Passes accountId via CLOUDFLARE_ACCOUNT_ID — same pattern as setup.mjs.
function wrangler(args, { cwd = STOREFRONT_DIR, accountId } = {}) {
  try {
    return execFileSync("wrangler", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) },
      stdio: ["inherit", "pipe", "pipe"],
    });
  } catch (err) {
    // Swallow errors during teardown — resource may not exist
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}

function wranglerLive(args, { cwd = STOREFRONT_DIR, accountId } = {}) {
  try {
    execFileSync("wrangler", args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) },
    });
  } catch { /* ignore — resource may already be deleted */ }
}

function extractJsonArray(output) {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function kvIdByName(name, accountId) {
  // kv namespace list emits a clean JSON array with no flags needed
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

async function main() {
  p.intro("Workers Deployment Demo — Teardown");

  // ── Auth check ─────────────────────────────────────────────────────────
  let whoami;
  try {
    whoami = JSON.parse(execFileSync("wrangler", ["whoami", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    }));
  } catch {
    p.cancel("wrangler whoami failed. Run `wrangler login` and try again.");
    process.exit(1);
  }

  // ── Account selection ──────────────────────────────────────────────────
  const accounts = whoami.accounts ?? [];
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
    if (p.isCancel(selected)) { p.cancel("Aborted."); process.exit(0); }
    accountId = selected;
    accountName = accounts.find((a) => a.id === selected)?.name ?? selected;
  }

  // ── Confirmation ───────────────────────────────────────────────────────
  p.log.warn(
    "This will permanently delete:\n" +
    "  • KV namespaces: storefront-prod, storefront-preview\n" +
    "  • D1 databases:  storefront-inventory-prod, storefront-inventory-preview\n" +
    "  • Workers:       storefront-worker, rollout-workflow"
  );

  const confirmed = await p.confirm({
    message: `Delete all demo resources from account "${accountName}"?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  // ── KV namespaces ──────────────────────────────────────────────────────
  const kvSpin = p.spinner();
  kvSpin.start("Deleting KV namespaces");

  for (const name of ["storefront-prod", "storefront-preview"]) {
    const id = kvIdByName(name, accountId);
    if (id) {
      kvSpin.message(`Deleting KV namespace: ${name}`);
      wranglerLive(["kv", "namespace", "delete", `--namespace-id=${id}`], { accountId });
    }
  }
  kvSpin.stop("KV namespaces deleted");

  // ── D1 databases ───────────────────────────────────────────────────────
  const d1Spin = p.spinner();
  d1Spin.start("Deleting D1 databases");

  for (const name of ["storefront-inventory-prod", "storefront-inventory-preview"]) {
    const id = d1IdByName(name, accountId);
    if (id) {
      d1Spin.message(`Deleting D1 database: ${name}`);
      wranglerLive(["d1", "delete", name, "-y"], { accountId });
    }
  }
  d1Spin.stop("D1 databases deleted");

  // ── Workers ────────────────────────────────────────────────────────────
  const workerSpin = p.spinner();
  workerSpin.start("Deleting Workers");

  workerSpin.message("Deleting storefront-worker");
  wranglerLive(
    ["delete", "--name", "storefront-worker", "--force"],
    { cwd: STOREFRONT_DIR, accountId }
  );

  workerSpin.message("Deleting rollout-workflow");
  wranglerLive(
    ["delete", "--name", "rollout-workflow", "--force"],
    { cwd: WORKFLOW_DIR, accountId }
  );

  workerSpin.stop("Workers deleted");

  // ── Reset wrangler.jsonc ───────────────────────────────────────────────
  const resetSpin = p.spinner();
  resetSpin.start("Resetting wrangler.jsonc placeholders");
  resetWrangler(resolve(REPO_ROOT, "packages/storefront-worker/wrangler.jsonc"));
  resetSpin.stop("wrangler.jsonc reset");

  p.outro("Teardown complete. Run `bash scripts/setup.sh` to reprovision.");
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
