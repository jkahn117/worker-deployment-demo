-- Preview-only seed: unrealistically high stock counts make it immediately
-- obvious this is test data, not production. Also seeds the v2 product and
-- the flash-sale product used in the Stage 1 isolation demo.
--
-- Applied to the PREVIEW database only by scripts/setup.mjs.
-- Do NOT apply to production.
INSERT OR REPLACE INTO inventory (product_id, stock) VALUES
  ('tshirt-crew',  9999),
  ('chino-slim',   9999),
  ('hoodie-zip',   9999),
  ('puffer-vest',  9999),
  ('raincoat',     9999);
