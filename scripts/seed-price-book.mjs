#!/usr/bin/env node
/**
 * Seed a STARTER price book into pricing_rules (idempotent — safe to re-run).
 *
 * Prices are operator data, not code: this seeds sensible starting rules so the
 * meter costs traffic out of the box, but you should review/edit them (now also
 * editable in the dashboard: /dashboard/metering). Run against a specific
 * instance's data dir:
 *
 *   CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/seed-price-book.mjs
 *
 * The seed logic lives in servers/shared/price-book.js (shared with the panel).
 */

import { createDbClient } from "../servers/db.js";
import { seedPriceBook } from "../servers/shared/price-book.js";

async function main() {
  const db = createDbClient();
  const { inserted, skipped } = await seedPriceBook(db);
  console.log(`Price book seed complete: ${inserted} inserted, ${skipped} already present.`);
}

main().catch((err) => {
  console.error("seed-price-book failed:", err.message);
  process.exit(1);
});
