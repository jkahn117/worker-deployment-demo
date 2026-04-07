// Fetches stock counts from D1 for one or more product IDs.
// Returns a map of product_id → stock count.
// Products with no row in D1 are absent from the map (caller treats as null).
export async function fetchInventory(
  db: D1Database,
  productIds: string[]
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();

  // Bind each ID as a positional parameter to prevent injection.
  const placeholders = productIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT product_id, stock FROM inventory WHERE product_id IN (${placeholders})`)
    .bind(...productIds)
    .all<{ product_id: string; stock: number }>();

  const map = new Map<string, number>();
  for (const row of result.results) {
    map.set(row.product_id, row.stock);
  }
  return map;
}

// Fetches stock for a single product. Returns null if not found.
export async function fetchStockForProduct(
  db: D1Database,
  productId: string
): Promise<number | null> {
  const row = await db
    .prepare("SELECT stock FROM inventory WHERE product_id = ?")
    .bind(productId)
    .first<{ stock: number }>();

  return row?.stock ?? null;
}
