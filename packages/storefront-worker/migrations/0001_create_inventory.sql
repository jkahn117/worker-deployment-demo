-- Inventory table: one row per product, tracking available stock.
-- Kept intentionally simple — the point is isolation, not schema richness.
CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT PRIMARY KEY,
  stock      INTEGER NOT NULL DEFAULT 0
);

-- Seed production-like stock counts for the v1 catalog.
-- These are realistic numbers a customer would see in a real storefront.
INSERT OR IGNORE INTO inventory (product_id, stock) VALUES
  ('tshirt-crew',  142),
  ('chino-slim',    57),
  ('hoodie-zip',    23);
