// lib.mjs — shared utilities for setup.mjs and teardown.mjs.
// No side effects on import.

import { readFileSync, writeFileSync } from "fs";

// Resets all real resource IDs in wrangler.jsonc back to placeholder tokens.
// Called by teardown.mjs after deleting cloud resources.
export function resetWrangler(wranglerJsoncPath) {
  let content = readFileSync(wranglerJsoncPath, "utf8");
  let kvCount = 0;
  let d1Count = 0;

  content = content.replace(/"id":\s*"([0-9a-f]{32})"/g, () =>
    kvCount++ === 0
      ? `"id": "<PROD_KV_NAMESPACE_ID>"`
      : `"id": "<PREVIEW_KV_NAMESPACE_ID>"`
  );

  content = content.replace(
    /"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi,
    () =>
      d1Count++ === 0
        ? `"database_id": "<PROD_D1_DATABASE_ID>"`
        : `"database_id": "<PREVIEW_D1_DATABASE_ID>"`
  );

  writeFileSync(wranglerJsoncPath, content);
}
