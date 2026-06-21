# Price-rule editor + fleet seeding (design)

**Date:** 2026-06-21
**Project:** FERPA metered-inference (`ferpa-metered-inference-project`)
**Roadmap:** `~/.claude/plans/i-have-ambitions-to-polished-bee.md` — Phase 1 (price book operability)
**Status:** approved design → writing-plans

## Goal

Make the metering panel's price book editable from the dashboard — add, edit
(in-place), delete rules, and a one-click "seed starter book" — and seed the
starter price book on the other three instances now. This removes the
CLI-only dependency for managing prices and makes the price book resilient to
the concurrent-session DB churn that wiped the seeded rules once.

This is operator-facing tooling. It does NOT change how cost is computed or
recorded (each `usage_event` already freezes `computed_cost_usd` at record
time); it only makes the `pricing_rules` table editable through the UI.

## Decisions (made during brainstorm)

- **Edit semantics: in-place.** Editing a rule overwrites its rates; delete
  removes the row. No versioning. Safe because each `usage_event` stores its
  cost at record time, so editing a rule never changes an existing bill. (The
  schema's `effective_from`/`effective_to` columns remain; versioned editing is
  a possible future follow-up, not v1.)
- **Seeding: CLI now + a seed button.** Run the idempotent CLI seed on all
  three other instances now, AND add a "Seed starter price book" button to the
  editor for future re-seeding / DB-churn recovery.

## Background (verified against the code)

- The metering panel (`servers/gateway/dashboard/panels/metering.js`, 100 lines)
  is a GET-only `handler(req, res, { db, layout, lang })` with a pure
  `renderUsageBody(summary, priceRules, lang)`. `db` is the gateway's libsql
  client (`.execute({sql,args})`).
- Editable panels (`memory.js`, `contacts.js`) branch on `req.method === "POST"`
  in the same handler, read `req.body.action`, mutate via `db.execute(...)`, then
  `res.redirectAfterPost(route)` (Post-Redirect-Get). The route is already
  registered for both GET and POST.
- CSRF: `csrfMiddleware` populates `req.csrfToken`; `csrfInput(req)`
  (`servers/gateway/dashboard/shared/csrf.js`) returns the hidden
  `<input name="_csrf">` field. Panels pass `csrfInput(req)` into their render
  (see `contacts.js:71`). Body field name is `_csrf`.
- `pricing_rules` columns: `id, provider_id, provider_type, model_id (default
  '*'), input_cost_per_1m, output_cost_per_1m, cache_read_cost_per_1m,
  cache_write_cost_per_1m, effective_from, effective_to, created_at, updated_at`.
  Active rules = `effective_to IS NULL` (what `loadPricingRules` returns).
- The seed lives in `scripts/seed-price-book.mjs` (`STARTER_RULES` +
  idempotent insert keyed on provider_id/provider_type/model_id of active rules).
- Network-exposure invariant: `/dashboard/*` is already unreachable via Funnel
  and behind dashboard auth + CSRF. The editor adds no new route and no new
  exposure surface.

## Components

### 1. `servers/shared/price-book.js` (new) — pricing_rules write surface

The single home for price-book mutations + seed, used by BOTH the CLI script and
the panel (DRY). All mutators take a libsql-style `db` (`.execute({sql,args})`).

- `STARTER_RULES` — the array moved verbatim from `scripts/seed-price-book.mjs`.
- `seedPriceBook(db) -> {inserted, skipped}` — the idempotent insert loop moved
  from the CLI `main()`. Existing active rule for the same
  (provider_id, provider_type, model_id) key ⇒ skip.
- `validateRule(fields) -> {ok, errors, normalized}` — PURE. Rules:
  - `input_cost_per_1m`, `output_cost_per_1m`: required; parse to a finite
    number; must be `>= 0`. Non-numeric or negative ⇒ error.
  - At least one of `provider_id` / `provider_type` must be a non-empty string
    (a rule matching neither can never be selected). Both-empty ⇒ error.
  - `model_id`: trimmed; empty ⇒ defaults to `"*"`.
  - `normalized` carries the cleaned `{provider_id|null, provider_type|null,
    model_id, input, output}` (empty strings → null for the provider fields).
- `addPriceRule(db, fields) -> {id}` — `validateRule`; throw an Error whose
  message joins `errors` on failure; else INSERT
  `(provider_id, provider_type, model_id, input_cost_per_1m, output_cost_per_1m)`
  and return the new id.
- `updatePriceRule(db, id, {input, output}) -> {changed}` — validate the two
  rates (≥0, numeric); `UPDATE pricing_rules SET input_cost_per_1m=?,
  output_cost_per_1m=?, updated_at=datetime('now') WHERE id=?`. (In-place — does
  not touch provider/model/effective columns.)
- `deletePriceRule(db, id) -> {deleted}` — `DELETE FROM pricing_rules WHERE id=?`.

`scripts/seed-price-book.mjs` is refactored to import `STARTER_RULES` +
`seedPriceBook` from this module; its CLI `main()` becomes a thin wrapper
(open `createDbClient()`, call `seedPriceBook`, log the counts). Behavior and
the run command are unchanged.

### 2. `servers/gateway/dashboard/panels/metering.js` — editable panel

- **Handler POST branch** (before the GET render). Read `req.body.action`:
  - `add` → `addPriceRule(db, req.body)`
  - `update` → `updatePriceRule(db, req.body.id, {input: req.body.input, output: req.body.output})`
  - `delete` → `deletePriceRule(db, req.body.id)`
  - `seed` → `seedPriceBook(db)`
  On success: `res.redirectAfterPost("/dashboard/metering")`.
  On a thrown validation error: re-render the panel body with an error
  `callout` at the top (no redirect) so the operator sees the message.
- **`renderUsageBody(summary, priceRules, csrf, lang = "en", error = null)`** —
  new `csrf` (the `csrfInput(req)` HTML string) and optional `error` params. The
  read-only stats / by-provider / unpriced-warning are unchanged. The Price book
  section becomes editable:
  - Each rule row renders its provider/model + an inline edit `<form method="POST">`
    with prefilled `number` inputs for the two rates (`step` allows fractional
    $/1M), a hidden `action=update` + `id` + the `csrf` field, and a Save button;
    plus a Delete `<form method="POST">` (hidden `action=delete` + `id` + csrf,
    `onsubmit` confirm).
  - An "Add a price rule" `<form method="POST">`: text inputs for `provider_id`,
    `provider_type`, `model_id` (placeholder `*`), number inputs for the rates,
    hidden `action=add` + csrf, Add button.
  - A "Seed starter price book" `<form method="POST">`: hidden `action=seed` +
    csrf, a button, and a one-line note ("adds the default crow-voice/crow-chat
    $0 rules + Together reference rates; skips rules that already exist").
- The handler passes `csrfInput(req)` into `renderUsageBody` (import
  `csrfInput` like `contacts.js` does).

## Data flow

```
GET  /dashboard/metering → summarizeUsage + loadPricingRules → renderUsageBody(.. csrf ..)
POST /dashboard/metering (action=add|update|delete|seed)
   → price-book.js mutator (validateRule guards add/update)
   → success: res.redirectAfterPost("/dashboard/metering")  (PRG)
   → validation error: re-render body with an error callout (no redirect)
```

## Error handling

- `validateRule` is the single guard for add/update; mutators throw on invalid
  input, the handler catches and surfaces the message inline. No malformed rule
  reaches the DB.
- `delete`/`seed` cannot produce a validation error; any DB error is caught and
  surfaced as the error callout rather than a 500.
- A failed mutation never corrupts the read view — on error the panel still
  renders the current price book.

## Testing (TDD)

- `tests/price-book.test.js` (in-memory `@libsql/client`, mirrors
  `tests/metering-record.test.js`):
  - `validateRule`: valid input; negative rate → error; non-numeric rate →
    error; neither provider_id nor provider_type → error; empty model_id →
    normalized to `*`.
  - `addPriceRule` inserts and returns an id; the row has the normalized values.
  - `updatePriceRule` changes only the two rates in place (provider/model
    untouched).
  - `deletePriceRule` removes the row.
  - `seedPriceBook` inserts STARTER_RULES once; a second call skips all (idempotent).
- Extend the metering panel render test (`tests/metering-panel.test.js`): with a
  rule present and a csrf string, `renderUsageBody` includes an update form
  (action=update + the rule id), a delete control, the add form (action=add), the
  seed button (action=seed), and the csrf field; assert the read-only stats still
  render.

## Fleet seeding (ops — done alongside, not a code task)

Run the idempotent CLI seed against each data dir and record inserted/skipped:
- crow-mpa (local): `CROW_DATA_DIR=/home/kh0pp/.crow-mpa/data node scripts/seed-price-book.mjs` — highest value (pi-bots run here; bot events become priced).
- grackle (ssh): run in its `~/crow` against its data dir.
- black-swan (ssh): run in its `~/crow` against its data dir.
Idempotent + additive (skips existing active rules), so re-running is safe.

## Deploy

- Panel + module are gateway code → restart the gateway where the editor is
  wanted. crow gateway first. (grackle/black-swan need a deploy there for the
  editor UI; the CLI seed does not.) No schema change, no init-db.

## Out of scope (documented follow-ups)

- Cache-rate (`cache_read_cost_per_1m` / `cache_write_cost_per_1m`) fields in the
  editor — stay NULL in v1 (the seed already omits them).
- Versioned editing (expire-and-insert using `effective_from/to`).
- i18n of the panel (English-only, consistent with the current panel).
- Per-rule `provider_type`/`provider_id`/`model_id` editing (v1 edits rates only;
  to change the key, delete + add).
