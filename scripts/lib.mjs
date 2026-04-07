#!/usr/bin/env node
// lib.mjs — Node helpers called by setup.sh and teardown.sh.
//
// Usage (all commands print their result to stdout):
//   node scripts/lib.mjs extract-id    <wrangler-output>
//   node scripts/lib.mjs kv-id-from-list <wrangler-json-output> <name>
//   node scripts/lib.mjs d1-id-from-list <wrangler-json-output> <name>
//   node scripts/lib.mjs patch-wrangler <file> <placeholder> <value>
//   node scripts/lib.mjs reset-wrangler <file>
//   node scripts/lib.mjs extract-url   <wrangler-output> <worker-name>

import { readFileSync, writeFileSync } from "fs";

const [, , command, ...args] = process.argv;

// ---------------------------------------------------------------------------
// extract-id
// Parses wrangler JSON output to find a resource ID.
// Handles both KV (returns { id }) and D1 (returns { uuid } or { result: { uuid } }).
// ---------------------------------------------------------------------------
if (command === "extract-id") {
  const output = args[0] ?? "";
  // Strip wrangler log-prefix lines (emoji-prefixed or dashed separators)
  const cleaned = output
    .split("\n")
    .filter((l) => !/^\s*[⛅▲✘─]/.test(l))
    .join("\n");

  // Find the first {...} block
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.id) { process.stdout.write(parsed.id); process.exit(0); }
      if (parsed.result?.uuid) { process.stdout.write(parsed.result.uuid); process.exit(0); }
      if (parsed.uuid) { process.stdout.write(parsed.uuid); process.exit(0); }
    } catch { /* fall through */ }
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// kv-id-from-list
// Finds a KV namespace ID from `wrangler kv namespace list --json` output.
// ---------------------------------------------------------------------------
if (command === "kv-id-from-list") {
  const output = args[0] ?? "";
  const name = args[1] ?? "";
  const match = output.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const list = JSON.parse(match[0]);
      const found = list.find((n) => n.title === name);
      if (found?.id) { process.stdout.write(found.id); process.exit(0); }
    } catch { /* fall through */ }
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// d1-id-from-list
// Finds a D1 database UUID from `wrangler d1 list --json` output.
// ---------------------------------------------------------------------------
if (command === "d1-id-from-list") {
  const output = args[0] ?? "";
  const name = args[1] ?? "";
  const match = output.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const list = JSON.parse(match[0]);
      const found = list.find((d) => d.name === name);
      if (found?.uuid) { process.stdout.write(found.uuid); process.exit(0); }
    } catch { /* fall through */ }
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// patch-wrangler
// Replaces the first occurrence of <placeholder> with <value> in <file>.
// ---------------------------------------------------------------------------
if (command === "patch-wrangler") {
  const [file, placeholder, value] = args;
  if (!file || !placeholder || !value) {
    console.error("Usage: patch-wrangler <file> <placeholder> <value>");
    process.exit(1);
  }
  let content = readFileSync(file, "utf8");
  if (!content.includes(placeholder)) {
    console.error(`WARNING: placeholder "${placeholder}" not found in ${file}`);
    process.exit(1);
  }
  writeFileSync(file, content.replace(placeholder, value));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// reset-wrangler
// Replaces real resource IDs in wrangler.jsonc back to placeholder tokens.
// Matches 32-char hex KV IDs and 36-char UUID D1 IDs.
// Uses two sequential passes so each placeholder appears exactly twice
// (once for prod, once for the previews block).
// ---------------------------------------------------------------------------
if (command === "reset-wrangler") {
  const [file] = args;
  if (!file) { console.error("Usage: reset-wrangler <file>"); process.exit(1); }

  let content = readFileSync(file, "utf8");

  // KV namespace IDs: 32-char lowercase hex
  content = content.replace(/"id":\s*"([0-9a-f]{32})"/g, (_, _id, offset) => {
    // First occurrence → prod placeholder, second → preview placeholder
    return content.slice(0, offset).match(/"id":\s*"[0-9a-f]{32}"/g)?.length
      ? `"id": "<PREVIEW_KV_NAMESPACE_ID>"`
      : `"id": "<PROD_KV_NAMESPACE_ID>"`;
  });

  // D1 database IDs: standard UUID format (8-4-4-4-12)
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  let d1Count = 0;
  content = content.replace(/"database_id":\s*"[^"]+"/g, () => {
    const placeholder = d1Count === 0
      ? `"database_id": "<PROD_D1_DATABASE_ID>"`
      : `"database_id": "<PREVIEW_D1_DATABASE_ID>"`;
    d1Count++;
    return placeholder;
  });

  writeFileSync(file, content);
  console.log("wrangler.jsonc reset to placeholder IDs");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// extract-url
// Finds a workers.dev URL for a given worker name in wrangler output.
// ---------------------------------------------------------------------------
if (command === "extract-url") {
  const output = args[0] ?? "";
  const workerName = args[1] ?? "";
  const pattern = new RegExp(`https://${workerName}\\.[^\\s"'<>]+`, "i");
  const match = output.match(pattern);
  if (match) { process.stdout.write(match[0]); process.exit(0); }
  process.exit(1);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
