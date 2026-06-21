# Price-rule editor + fleet seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the metering panel's price book editable from the dashboard (add / edit-in-place / delete / one-click seed), backed by a shared `price-book.js` module that the CLI seed also uses, and seed the starter book on the other three instances.

**Architecture:** A new `servers/shared/price-book.js` owns all `pricing_rules` writes (`validateRule`, `addPriceRule`, `updatePriceRule`, `deletePriceRule`, `seedPriceBook` + `STARTER_RULES`). `scripts/seed-price-book.mjs` becomes a thin CLI wrapper over it. The metering panel gains a `POST` branch (Post-Redirect-Get on success, inline error callout on validation failure) and an editable price-book render. No new route, no schema change.

**Tech Stack:** Node.js ESM, libsql client (`db.execute({sql,args})`), node built-in test runner, `@libsql/client` (`:memory:`) for tests.

**Spec:** `docs/superpowers/specs/2026-06-21-price-rule-editor-design.md`

## Global Constraints

- **TDD, red first** — write the failing test, watch it fail, then implement.
- **DRY** — the panel seed button and the CLI script share `seedPriceBook`/`STARTER_RULES` from `servers/shared/price-book.js`; do not duplicate the seed loop.
- **In-place edit** — `updatePriceRule` overwrites the two rate columns only; `deletePriceRule` removes the row. No versioning (the `effective_*` columns are untouched on edit). Safe because each `usage_event` froze its cost at record time.
- **Validation is the single guard** — `validateRule` (rates required & finite & ≥0; at least one of `provider_id`/`provider_type`; `model_id` defaults to `*`). Mutators throw on invalid input; the panel surfaces the message inline. No malformed rule reaches the DB.
- **No new exposure surface** — reuse the existing `/dashboard/metering` route (GET+POST through the same handler), dashboard auth, CSRF (`csrfInput(req)` → hidden `_csrf` field), and the Funnel invariant. CSRF field MUST be present in every POST form.
- **English-only**, **rates-only** (cache-rate columns stay NULL), consistent with the current panel.
- **Commits:** explicit path args (`git commit <paths> -m`), never bare `git add`+`git commit`. `git pull --rebase` before pushing. No Claude co-author attribution.
- **libsql result shape:** `db.execute(...)` returns `{rows, rowsAffected, lastInsertRowid}` (lastInsertRowid may be a BigInt → `Number()`-cast).

---

### Task 1: `price-book.js` — `validateRule` (pure)

**Files:**
- Create: `servers/shared/price-book.js`
- Test: `tests/price-book.test.js`

**Interfaces:**
- Produces: `validateRule(fields) -> { ok: boolean, errors: string[], normalized: {provider_id:string|null, provider_type:string|null, model_id:string, input:number, output:number} | null }`. `fields` has loose `provider_id, provider_type, model_id, input, output` (strings from a form or values). Also exports internal helpers `strOrNull`, `parseRate` for reuse by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `tests/price-book.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRule } from "../servers/shared/price-book.js";

test("validateRule accepts a well-formed rule and normalizes it", () => {
  const v = validateRule({ provider_id: "crow-chat", provider_type: "", model_id: "", input: "0", output: "0" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.normalized, { provider_id: "crow-chat", provider_type: null, model_id: "*", input: 0, output: 0 });
});

test("validateRule rejects a negative rate", () => {
  const v = validateRule({ provider_type: "together", model_id: "x", input: "-1", output: "1" });
  assert.equal(v.ok, false);
  assert.equal(v.normalized, null);
  assert.ok(v.errors.some((e) => /input rate/i.test(e)));
});

test("validateRule rejects a non-numeric rate", () => {
  const v = validateRule({ provider_type: "together", model_id: "x", input: "abc", output: "1" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /input rate/i.test(e)));
});

test("validateRule requires at least one of provider_id / provider_type", () => {
  const v = validateRule({ provider_id: "", provider_type: "", model_id: "x", input: "1", output: "1" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /provider/i.test(e)));
});

test("validateRule defaults an empty model_id to '*'", () => {
  const v = validateRule({ provider_type: "together", model_id: "  ", input: "0.18", output: "0.18" });
  assert.equal(v.ok, true);
  assert.equal(v.normalized.model_id, "*");
  assert.equal(v.normalized.provider_id, null);
  assert.equal(v.normalized.input, 0.18);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/price-book.test.js`
Expected: FAIL — `Cannot find module '.../servers/shared/price-book.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `servers/shared/price-book.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/price-book.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/shared/price-book.js tests/price-book.test.js -m "feat(metering): price-book validateRule (pure form validation/normalization)"
git show --stat HEAD | head -5
```

---

### Task 2: `price-book.js` — CRUD (`addPriceRule` / `updatePriceRule` / `deletePriceRule`)

**Files:**
- Modify: `servers/shared/price-book.js`
- Test: `tests/price-book.test.js`

**Interfaces:**
- Consumes: `validateRule`, `parseRate` (Task 1); a libsql db.
- Produces:
  - `addPriceRule(db, fields) -> Promise<{id:number}>` — validates; throws `Error` (message = joined errors) on invalid; else INSERTs and returns the new id.
  - `updatePriceRule(db, id, {input, output}) -> Promise<{changed:number}>` — validates the two rates (≥0, numeric); throws on invalid; UPDATEs the two rate columns + `updated_at` in place.
  - `deletePriceRule(db, id) -> Promise<{deleted:number}>` — DELETEs by id.

- [ ] **Step 1: Write the failing tests**

Append to `tests/price-book.test.js`:

```js
import { createClient } from "@libsql/client";
import { addPriceRule, updatePriceRule, deletePriceRule } from "../servers/shared/price-book.js";

async function db0() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT, provider_type TEXT, model_id TEXT NOT NULL DEFAULT '*',
    input_cost_per_1m REAL NOT NULL, output_cost_per_1m REAL NOT NULL,
    cache_read_cost_per_1m REAL, cache_write_cost_per_1m REAL,
    effective_from TEXT DEFAULT (datetime('now')), effective_to TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test("addPriceRule inserts a normalized rule and returns its id", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_type: "together", model_id: "llama-8b", input: "0.18", output: "0.2" });
  assert.ok(id > 0);
  const { rows } = await db.execute("SELECT * FROM pricing_rules");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_type, "together");
  assert.equal(rows[0].provider_id, null);
  assert.equal(rows[0].model_id, "llama-8b");
  assert.equal(Number(rows[0].input_cost_per_1m), 0.18);
  assert.equal(Number(rows[0].output_cost_per_1m), 0.2);
});

test("addPriceRule throws on an invalid rule (and writes nothing)", async () => {
  const db = await db0();
  await assert.rejects(() => addPriceRule(db, { model_id: "x", input: "-1", output: "1" }), /input rate|provider/i);
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM pricing_rules");
  assert.equal(Number(rows[0].n), 0);
});

test("updatePriceRule changes only the rate columns in place", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_id: "crow-chat", model_id: "*", input: "0", output: "0" });
  const r = await updatePriceRule(db, id, { input: "1.5", output: "2.5" });
  assert.equal(r.changed, 1);
  const { rows } = await db.execute("SELECT * FROM pricing_rules WHERE id=" + id);
  assert.equal(Number(rows[0].input_cost_per_1m), 1.5);
  assert.equal(Number(rows[0].output_cost_per_1m), 2.5);
  assert.equal(rows[0].provider_id, "crow-chat"); // untouched
  assert.equal(rows[0].model_id, "*");            // untouched
});

test("updatePriceRule throws on a negative rate", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_id: "crow-chat", model_id: "*", input: "0", output: "0" });
  await assert.rejects(() => updatePriceRule(db, id, { input: "-2", output: "1" }), /input rate/i);
});

test("deletePriceRule removes the row", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_type: "together", model_id: "x", input: "1", output: "1" });
  const r = await deletePriceRule(db, id);
  assert.equal(r.deleted, 1);
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM pricing_rules");
  assert.equal(Number(rows[0].n), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/price-book.test.js`
Expected: FAIL — `addPriceRule`/`updatePriceRule`/`deletePriceRule` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `servers/shared/price-book.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/price-book.test.js`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git commit servers/shared/price-book.js tests/price-book.test.js -m "feat(metering): price-book add/update/delete (in-place, validation-guarded)"
git show --stat HEAD | head -5
```

---

### Task 3: `price-book.js` — `seedPriceBook` + `STARTER_RULES`, and refactor the CLI

**Files:**
- Modify: `servers/shared/price-book.js`
- Modify: `scripts/seed-price-book.mjs`
- Test: `tests/price-book.test.js`

**Interfaces:**
- Consumes: a libsql db.
- Produces: `STARTER_RULES` (array of `{provider_id, provider_type, model_id, input, output}`) and `seedPriceBook(db) -> Promise<{inserted:number, skipped:number}>` (idempotent; skips an existing active rule for the same provider/model key).

- [ ] **Step 1: Write the failing tests**

Append to `tests/price-book.test.js`:

```js
import { seedPriceBook, STARTER_RULES } from "../servers/shared/price-book.js";

test("seedPriceBook inserts the starter rules once, then is idempotent", async () => {
  const db = await db0();
  const first = await seedPriceBook(db);
  assert.equal(first.inserted, STARTER_RULES.length);
  assert.equal(first.skipped, 0);
  const second = await seedPriceBook(db);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, STARTER_RULES.length);
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM pricing_rules");
  assert.equal(Number(rows[0].n), STARTER_RULES.length);
});

test("seedPriceBook seeds the self-hosted $0 rules", async () => {
  const db = await db0();
  await seedPriceBook(db);
  const { rows } = await db.execute("SELECT input_cost_per_1m FROM pricing_rules WHERE provider_id='crow-chat'");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].input_cost_per_1m), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/price-book.test.js`
Expected: FAIL — `seedPriceBook`/`STARTER_RULES` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `servers/shared/price-book.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/price-book.test.js`
Expected: PASS (12 tests total).

- [ ] **Step 5: Refactor the CLI script to import from the module**

Replace the entire contents of `scripts/seed-price-book.mjs` with:

```js
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
```

- [ ] **Step 6: Verify the CLI still runs (against a throwaway temp data dir)**

```bash
TMPD=$(mktemp -d)
CROW_DATA_DIR="$TMPD" node scripts/init-db.js >/dev/null 2>&1 || true
CROW_DATA_DIR="$TMPD" node scripts/seed-price-book.mjs
CROW_DATA_DIR="$TMPD" node scripts/seed-price-book.mjs
rm -rf "$TMPD"
```
Expected: first run `5 inserted, 0 already present.`; second run `0 inserted, 5 already present.` (idempotent).

- [ ] **Step 7: Commit**

```bash
git commit servers/shared/price-book.js scripts/seed-price-book.mjs tests/price-book.test.js -m "feat(metering): seedPriceBook + STARTER_RULES in price-book.js; CLI seed imports it"
git show --stat HEAD | head -6
```

---

### Task 4: Editable metering panel (POST branch + render forms + CSRF)

**Files:**
- Modify: `servers/gateway/dashboard/panels/metering.js`
- Test: `tests/metering-panel.test.js`

**Interfaces:**
- Consumes: `addPriceRule`, `updatePriceRule`, `deletePriceRule`, `seedPriceBook` (Tasks 2–3); `csrfInput(req)` from `../shared/csrf.js`; `res.redirectAfterPost(path)`.
- Produces: `renderUsageBody(summary, priceRules, csrf = "", lang = "en", error = null)` — new `csrf` (the `csrfInput(req)` HTML string) and `error` params; renders the editable price book.

> **Note:** the panel handler spawns no process and the render is pure — the render forms are unit-tested here; the POST round-trip is exercised by the live smoke in Task 5.

- [ ] **Step 1: Update the existing render-test call sites + add editor tests (red)**

In `tests/metering-panel.test.js`, the existing tests call `renderUsageBody(...)` with 3 args where the 3rd is `lang`. The new signature inserts `csrf` as the 3rd param, so update **all four** call sites to pass `""` as the 3rd (csrf) arg and `"en"` as the 4th. Update each one explicitly — note the second one's first arg is `withGap`, NOT `summary`, so a blind `renderUsageBody(summary, ...)` replace would miss it:
- `renderUsageBody(summary, [], "en")` → `renderUsageBody(summary, [], "", "en")` (the "shows spend total" test)
- `renderUsageBody(withGap, [], "en")` → `renderUsageBody(withGap, [], "", "en")` (the "warns when unpriced" test)
- `renderUsageBody(summary, [], "en")` → `renderUsageBody(summary, [], "", "en")` (the "does NOT show warning" test)
- `renderUsageBody(summary, rules, "en")` → `renderUsageBody(summary, rules, "", "en")` (the "lists configured price rules" test)

Then append:

```js
test("renderUsageBody renders the price-rule editor (update/delete/add/seed + csrf)", () => {
  const rules = [
    { id: 7, provider_id: "crow-chat", provider_type: null, model_id: "*", input_cost_per_1m: 0, output_cost_per_1m: 0 },
  ];
  const csrf = '<input type="hidden" name="_csrf" value="tok123">';
  const html = renderUsageBody(summary, rules, csrf, "en");
  assert.match(html, /name="action" value="update"/);
  assert.match(html, /name="id" value="7"/);
  assert.match(html, /name="action" value="delete"/);
  assert.match(html, /name="action" value="add"/);
  assert.match(html, /name="action" value="seed"/);
  assert.match(html, /name="_csrf" value="tok123"/);
});

test("renderUsageBody surfaces an error callout when one is passed", () => {
  const html = renderUsageBody(summary, [], "", "en", "Input rate must be a number >= 0.");
  assert.match(html, /Input rate must be a number/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/metering-panel.test.js`
Expected: FAIL — the editor forms / error callout are not rendered (no `action="update"`, etc.).

- [ ] **Step 3: Implement the editable render + POST handler**

In `servers/gateway/dashboard/panels/metering.js`:

(a) Add imports near the top (after the existing `import { summarizeUsage, loadPricingRules } ...`):

```js
import { csrfInput } from "../shared/csrf.js";
import { addPriceRule, updatePriceRule, deletePriceRule, seedPriceBook } from "../../../shared/price-book.js";
```

(b) Add this helper above `renderUsageBody`:

```js
function priceBookEditor(priceRules, csrf) {
  const ruleHtml = (priceRules || []).map((r) => {
    const who = escapeHtml(r.provider_id || r.provider_type || "—");
    const model = escapeHtml(r.model_id || "*");
    const inv = escapeHtml(String(r.input_cost_per_1m));
    const outv = escapeHtml(String(r.output_cost_per_1m));
    return `<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem">
      <span style="min-width:220px"><strong>${who}</strong> / <code>${model}</code></span>
      <form method="POST" style="display:flex;gap:0.4rem;align-items:center">${csrf}
        <input type="hidden" name="action" value="update"><input type="hidden" name="id" value="${escapeHtml(String(r.id))}">
        <label>in $<input type="number" name="input" value="${inv}" step="0.0001" min="0" style="width:90px"></label>
        <label>out $<input type="number" name="output" value="${outv}" step="0.0001" min="0" style="width:90px"></label>
        <button class="btn btn-sm" type="submit">Save</button>
      </form>
      <form method="POST" style="display:inline" onsubmit="return confirm('Delete this price rule?')">${csrf}
        <input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${escapeHtml(String(r.id))}">
        <button class="btn btn-sm btn-danger" type="submit">Delete</button>
      </form>
    </div>`;
  }).join("\n");

  const list = ruleHtml ||
    `<div class="empty-state"><h3>No price rules yet</h3><p>Add one below, or seed the starter book.</p></div>`;

  const addForm = `<form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap;margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border,#333)">${csrf}
    <input type="hidden" name="action" value="add">
    <label>provider_id<br><input type="text" name="provider_id" placeholder="(or type)" style="width:140px"></label>
    <label>provider_type<br><input type="text" name="provider_type" placeholder="e.g. together" style="width:140px"></label>
    <label>model_id<br><input type="text" name="model_id" placeholder="*" style="width:170px"></label>
    <label>in $/1M<br><input type="number" name="input" step="0.0001" min="0" style="width:90px"></label>
    <label>out $/1M<br><input type="number" name="output" step="0.0001" min="0" style="width:90px"></label>
    <button class="btn btn-sm btn-primary" type="submit">Add rule</button>
  </form>`;

  const seedForm = `<form method="POST" style="margin-top:1rem">${csrf}
    <input type="hidden" name="action" value="seed">
    <button class="btn btn-sm" type="submit">Seed starter price book</button>
    <span class="muted" style="margin-left:0.5rem;font-size:0.85em">Adds the default crow-voice/crow-chat $0 rules + Together reference rates; skips rules that already exist.</span>
  </form>`;

  return list + addForm + seedForm;
}
```

(c) Change the `renderUsageBody` signature and the final `return` + add the error box. Replace `export function renderUsageBody(summary, priceRules, lang = "en") {` with:

```js
export function renderUsageBody(summary, priceRules, csrf = "", lang = "en", error = null) {
```

and replace the final `return [ ... ].join("\n");` block with:

```js
  const errorBox = error ? callout(escapeHtml(error), "warning") : "";

  return [
    errorBox,
    cards,
    gapWarning,
    section("By provider &amp; model", byProviderTable),
    section("Price book", priceBookEditor(priceRules, csrf)),
  ].join("\n");
```

(Delete the old `ruleRows` / `priceBook` `const`s that built the read-only price table — `priceBookEditor` replaces them.)

(d) Replace the handler with a POST-aware version:

```js
  async handler(req, res, { db, layout, lang }) {
    let error = null;
    if (req.method === "POST") {
      const action = req.body && req.body.action;
      try {
        if (action === "add") await addPriceRule(db, req.body);
        else if (action === "update") await updatePriceRule(db, req.body.id, { input: req.body.input, output: req.body.output });
        else if (action === "delete") await deletePriceRule(db, req.body.id);
        else if (action === "seed") await seedPriceBook(db);
        res.redirectAfterPost("/dashboard/metering");
        return;
      } catch (e) {
        error = e && e.message ? e.message : String(e);
        // fall through and re-render with the error callout
      }
    }
    const summary = await summarizeUsage(db);
    let rules = [];
    try {
      rules = await loadPricingRules(db);
    } catch {
      rules = [];
    }
    return layout({
      title: "Usage & Metering",
      content: renderUsageBody(summary, rules, csrfInput(req), lang, error),
    });
  },
```

- [ ] **Step 4: Run tests to verify they pass + the gateway loads**

```bash
node --test tests/metering-panel.test.js
node -e "import('./servers/gateway/dashboard/panels/metering.js').then(()=>console.log('panel loads OK')).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: all panel tests PASS (the 4 existing updated + 2 new); `panel loads OK`.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/panels/metering.js tests/metering-panel.test.js -m "feat(metering): editable price book in the dashboard panel (add/edit/delete/seed)"
git show --stat HEAD | head -5
```

---

### Task 5: Deploy + fleet seed

**Files:** none (deploy + ops only).

> **Context:** PROD. The metering panel is gateway code. Deploy = restart the crow gateway onto current main. The CLI seed touches each instance's `pricing_rules` (idempotent + additive). Sudo pw in private notes. The crow-mpa seed is the high-value one (pi-bots run there → bot events become priced).

- [ ] **Step 1: Pre-flight — rebase, full price-book + panel tests, push**

```bash
cd /home/kh0pp/crow
git pull --rebase
node --test tests/price-book.test.js tests/metering-panel.test.js tests/metering.test.js tests/metering-record.test.js
git push
```
Expected: rebase clean, all PASS, push succeeds.

- [ ] **Step 2: Seed the local crow-mpa price book (highest value — bots run here)**

```bash
CROW_DATA_DIR=/home/kh0pp/.crow-mpa/data node scripts/seed-price-book.mjs
sqlite3 /home/kh0pp/.crow-mpa/data/crow.db "SELECT provider_id, provider_type, model_id, input_cost_per_1m FROM pricing_rules;"
```
Expected: `5 inserted, 0 already present.` and 5 rows. (After this, new bot `usage_events` on crow-mpa price against these rules instead of `priced=0`.)

> **Seed-vs-churn safety (re the earlier price-book wipe):** the seed dedups on `effective_to IS NULL` (active) rows, so it is safe regardless of how a prior churn removed rules — a hard `DELETE` is simply restored, and a soft-expire (`effective_to` set) leaves the row inactive and the seed inserts one fresh active rule (correct; `loadPricingRules` only returns active). It never produces two active rules for the same key. If you ever see a duplicate active row, that predates this seed.

- [ ] **Step 3: Seed grackle + black-swan (remote — operator-gated)**

For each remote host, run the seed in its `~/crow` against its data dir. Confirm the data dir first (`echo $CROW_DATA_DIR` in the gateway service env, or default `~/.crow/data`).

```bash
# grackle
grackle "cd ~/crow && git pull --rebase && CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/seed-price-book.mjs"
# black-swan
ssh black-swan "cd ~/crow && git pull --rebase && CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/seed-price-book.mjs"
```
Expected: `5 inserted, 0 already present.` on each (or skips if already seeded). NOTE: confirm each host's actual gateway data dir before running; adjust `CROW_DATA_DIR` if it differs.

- [ ] **Step 4: Deploy the editor UI to the crow gateway + live smoke**

Restart the crow gateway onto current main, then drive the editor through one round-trip:

```bash
# restart the crow main gateway (the dashboard that serves /dashboard/metering)
echo '<pw>' | sudo -S systemctl restart crow-gateway   # confirm the exact unit name first: systemctl list-units 'crow*gateway*'
```
Then in the browser at `/dashboard/metering`: confirm the price book renders with edit/delete forms, the Add form, and the Seed button; add a throwaway rule, edit its rate, delete it; click Seed and confirm the inserted/skipped result. (The crow gateway's own price book was already seeded earlier this project.)

- [ ] **Step 5: Update the project memory**

Update `~/.claude/projects/-home-kh0pp-crow/memory/ferpa-metered-inference-project.md`: price-rule editor SHIPPED + which instances are now seeded; note the editor is only deployed where the gateway was restarted (crow first; grackle/black-swan need a gateway deploy for the UI, though their price books are seeded via CLI).

---

## Self-Review

**Spec coverage:**
- `price-book.js` module (validateRule, CRUD, seed, STARTER_RULES) → Tasks 1–3 ✓
- CLI refactor to import the shared seed → Task 3 ✓
- Panel POST branch (add/update/delete/seed) + PRG + inline error → Task 4 ✓
- `renderUsageBody(.. csrf .. error)` + editor forms + seed button → Task 4 ✓
- In-place edit (rates only) → Task 2 `updatePriceRule` ✓
- Validation single-guard → Task 1 + used in Tasks 2/4 ✓
- CSRF in every POST form → Task 4 `priceBookEditor` (every form embeds `${csrf}`) ✓
- No new route/exposure → Task 4 reuses the handler ✓
- English-only, rates-only, cache columns NULL → Tasks 2/4 (only input/output written) ✓
- Fleet CLI seed (crow-mpa local + grackle/black-swan ssh) → Task 5 ✓
- Out-of-scope (versioning, i18n, cache-rate fields, key-editing) → not built ✓

**Placeholder scan:** none — every code step has complete code; every run step has a command + expected output. (The `<pw>` and unit-name in Task 5 Step 4 are operator-environment values intentionally not hardcoded.)

**Type consistency:** `validateRule(fields)→{ok,errors,normalized}`, `addPriceRule(db,fields)→{id}`, `updatePriceRule(db,id,{input,output})→{changed}`, `deletePriceRule(db,id)→{deleted}`, `seedPriceBook(db)→{inserted,skipped}`, `renderUsageBody(summary,priceRules,csrf,lang,error)`, `priceBookEditor(priceRules,csrf)` — used consistently across tasks. `parseRate`/`strOrNull` defined in Task 1, reused in Task 2.

---

## Review

**Reviewer:** staff-engineer plan review (Plan subagent), adversarial, verified against actual code.
**Date:** 2026-06-21
**Verdict:** APPROVE (with minor fixes) → fixes applied.

The reviewer empirically verified the load-bearing claims: `db.execute` returns `{rows, rowsAffected, lastInsertRowid}` for BOTH `createDbClient` (better-sqlite3, plain Number) and `@libsql/client` (BigInt `lastInsertRowid`), and `Number(...)` casts both; `_csrf` is exactly the field `csrfMiddleware` validates, mounted (index.js:615) before the panel dispatch (`router.all` at :769) with auth (:610) and `express.urlencoded` body parsing (:92) all ahead of it — so the metering POST route is auto-protected and `req.body` is populated, no wiring needed; the `db0()` test schema byte-matches `init-db.js` pricing_rules; `parseRate("0")===0` (not null); all form interpolations are `escapeHtml(String(...))`-wrapped (no injection gap); in-place edit is coherent because `recordUsageEvent` freezes `computed_cost_usd` on each event and `summarizeUsage` reads the stored column (a rule edit never changes a recorded bill); `renderUsageBody` has exactly one production caller to update.

Resolutions:
- **CRITICAL #1 — Task 4 Step 1 mis-described the test call sites:** a blind `renderUsageBody(summary, X, "en")` replace would skip line 24's `renderUsageBody(withGap, [], "en")` (first arg `withGap`), silently leaving a 3-arg call with `csrf="en"`. Fixed: Step 1 now enumerates all four call sites explicitly, flagging the `withGap` one.
- **CRITICAL #2 (control flow after catch fall-through):** reviewer confirmed it is already correct (PRG path sets headers + returns; error path falls to the final `return layout(...)` which the dispatcher renders). No change.
- **Q1 (seed vs the earlier price-book wipe):** documented in Task 5 — the seed dedups on active rows, so it is safe under any churn (hard-delete → restore; soft-expire → one fresh active insert), never double-active-inserts.
- **Suggestions (no-op feedback on `changed/deleted===0`; raw bind error on a hand-crafted POST with no `id`):** both reachable only via hand-crafted POST (the UI always operates on real rows behind a confirm), and the error is caught + surfaced as a callout. Left as documented v1 follow-ups, not built (reviewer: "not required for v1").
