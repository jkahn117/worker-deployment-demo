import type { CatalogConfig, Product } from "./types.js";

// Reads the product list and catalog config from KV.
// Both keys must be present — missing data is treated as a 500-level error
// to avoid returning a silently empty catalog.
export async function fetchCatalog(
  kv: KVNamespace
): Promise<{ products: Product[]; config: CatalogConfig }> {
  const [productsRaw, configRaw] = await Promise.all([
    kv.get("products"),
    kv.get("config"),
  ]);

  if (productsRaw === null) {
    throw new Error("KV key 'products' not found — did you seed the namespace?");
  }
  if (configRaw === null) {
    throw new Error("KV key 'config' not found — did you seed the namespace?");
  }

  const products = JSON.parse(productsRaw) as Product[];
  const config = JSON.parse(configRaw) as CatalogConfig;

  return { products, config };
}
