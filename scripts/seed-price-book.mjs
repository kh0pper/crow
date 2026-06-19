#!/usr/bin/env node
/**
 * Seed a STARTER price book into pricing_rules (idempotent — safe to re-run).
 *
 * Prices are operator data, not code: this seeds sensible starting rules so the
 * meter costs traffic out of the box, but you should review/edit them. Run
 * against a specific instance's data dir:
 *
 *   CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/seed-price-book.mjs
 *
 * Existing active rules for the same (provider, model) key are left untouched.
 */

import { createDbClient } from "../servers/db.js";

// $ per 1M tokens. input≈output for these open-weight models.
const STARTER_RULES = [
  // Self-hosted local models: no marginal per-token cost (compute is amortized
  // hardware/electricity, not billed per token). Keeps local traffic priced=$0
  // instead of showing as an unpriced gap.
  { provider_id: "crow-voice", provider_type: null, model_id: "*", input: 0, output: 0 },
  { provider_id: "crow-chat", provider_type: null, model_id: "*", input: 0, output: 0 },

  // Together.ai serverless REFERENCE rates (2026-06, research-sourced — RE-VERIFY
  // at contract time). Keyed by provider_type so they apply once a Together
  // provider row exists.
  { provider_id: null, provider_type: "together", model_id: "meta-llama/Llama-3.1-8B-Instruct", input: 0.18, output: 0.18 },
  { provider_id: null, provider_type: "together", model_id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", input: 1.04, output: 1.04 },
  { provider_id: null, provider_type: "together", model_id: "deepseek-ai/DeepSeek-V3", input: 1.25, output: 1.25 },
];

async function main() {
  const db = createDbClient();
  let inserted = 0;
  let skipped = 0;

  for (const r of STARTER_RULES) {
    const { rows } = await db.execute({
      sql: `SELECT 1 FROM pricing_rules
            WHERE effective_to IS NULL
              AND IFNULL(provider_id,'')   = IFNULL(?,'')
              AND IFNULL(provider_type,'') = IFNULL(?,'')
              AND model_id = ?
            LIMIT 1`,
      args: [r.provider_id, r.provider_type, r.model_id],
    });
    if (rows.length) {
      skipped++;
      continue;
    }
    await db.execute({
      sql: `INSERT INTO pricing_rules
              (provider_id, provider_type, model_id, input_cost_per_1m, output_cost_per_1m)
            VALUES (?, ?, ?, ?, ?)`,
      args: [r.provider_id, r.provider_type, r.model_id, r.input, r.output],
    });
    inserted++;
    console.log(`  + ${r.provider_id || r.provider_type} / ${r.model_id}  $${r.input}/$${r.output} per 1M`);
  }

  console.log(`Price book seed complete: ${inserted} inserted, ${skipped} already present.`);
}

main().catch((err) => {
  console.error("seed-price-book failed:", err.message);
  process.exit(1);
});
