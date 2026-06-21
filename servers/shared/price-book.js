/**
 * Price-book write surface — the single home for pricing_rules mutations + the
 * starter-book seed. Used by BOTH the dashboard metering panel (add/edit/delete/
 * seed) and scripts/seed-price-book.mjs (CLI seed), so the seed logic lives in
 * one place. All mutators take a libsql-style db (`.execute({sql,args})`).
 *
 * Edit is IN-PLACE (overwrites rate columns); the effective_from/to columns are
 * untouched. Safe because each usage_event froze its cost at record time, so a
 * rule edit never changes an existing bill.
 */

function strOrNull(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
}

function parseRate(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Validate + normalize a price-rule form. Pure.
 * @returns {{ok:boolean, errors:string[], normalized:object|null}}
 */
export function validateRule(fields) {
  const errors = [];
  const provider_id = strOrNull(fields.provider_id);
  const provider_type = strOrNull(fields.provider_type);
  let model_id = fields.model_id == null ? "" : String(fields.model_id).trim();
  if (!model_id) model_id = "*";
  if (!provider_id && !provider_type) {
    errors.push("Provide a provider_id or a provider_type (a rule matching neither can never be selected).");
  }
  const input = parseRate(fields.input);
  const output = parseRate(fields.output);
  if (input == null) errors.push("Input rate must be a number >= 0.");
  if (output == null) errors.push("Output rate must be a number >= 0.");
  return {
    ok: errors.length === 0,
    errors,
    normalized: errors.length === 0 ? { provider_id, provider_type, model_id, input, output } : null,
  };
}

export { strOrNull, parseRate };

/** INSERT a validated rule. Throws Error(joined errors) on invalid input. */
export async function addPriceRule(db, fields) {
  const v = validateRule(fields);
  if (!v.ok) throw new Error("Invalid price rule: " + v.errors.join(" "));
  const { provider_id, provider_type, model_id, input, output } = v.normalized;
  const res = await db.execute({
    sql: `INSERT INTO pricing_rules
            (provider_id, provider_type, model_id, input_cost_per_1m, output_cost_per_1m)
          VALUES (?, ?, ?, ?, ?)`,
    args: [provider_id, provider_type, model_id, input, output],
  });
  return { id: Number(res.lastInsertRowid) };
}

/** UPDATE the two rate columns in place. Throws on an invalid rate. */
export async function updatePriceRule(db, id, { input, output }) {
  const i = parseRate(input);
  const o = parseRate(output);
  const errors = [];
  if (i == null) errors.push("Input rate must be a number >= 0.");
  if (o == null) errors.push("Output rate must be a number >= 0.");
  if (errors.length) throw new Error("Invalid price rule: " + errors.join(" "));
  const res = await db.execute({
    sql: `UPDATE pricing_rules
            SET input_cost_per_1m = ?, output_cost_per_1m = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [i, o, id],
  });
  return { changed: Number(res.rowsAffected || 0) };
}

/** DELETE a rule by id. */
export async function deletePriceRule(db, id) {
  const res = await db.execute({ sql: `DELETE FROM pricing_rules WHERE id = ?`, args: [id] });
  return { deleted: Number(res.rowsAffected || 0) };
}

// $ per 1M tokens. input≈output for these open-weight models.
export const STARTER_RULES = [
  // Self-hosted local models: no marginal per-token cost (amortized hardware/
  // electricity). Keeps local traffic priced=$0 instead of an unpriced gap.
  { provider_id: "crow-voice", provider_type: null, model_id: "*", input: 0, output: 0 },
  { provider_id: "crow-chat", provider_type: null, model_id: "*", input: 0, output: 0 },
  // Together.ai serverless REFERENCE rates (2026-06, research-sourced — RE-VERIFY
  // at contract time). Keyed by provider_type so they apply once a Together row exists.
  { provider_id: null, provider_type: "together", model_id: "meta-llama/Llama-3.1-8B-Instruct", input: 0.18, output: 0.18 },
  { provider_id: null, provider_type: "together", model_id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", input: 1.04, output: 1.04 },
  { provider_id: null, provider_type: "together", model_id: "deepseek-ai/DeepSeek-V3", input: 1.25, output: 1.25 },
];

/** Idempotently insert STARTER_RULES; skip an existing active rule for the same key. */
export async function seedPriceBook(db) {
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
    if (rows.length) { skipped++; continue; }
    await db.execute({
      sql: `INSERT INTO pricing_rules
              (provider_id, provider_type, model_id, input_cost_per_1m, output_cost_per_1m)
            VALUES (?, ?, ?, ?, ?)`,
      args: [r.provider_id, r.provider_type, r.model_id, r.input, r.output],
    });
    inserted++;
  }
  return { inserted, skipped };
}
