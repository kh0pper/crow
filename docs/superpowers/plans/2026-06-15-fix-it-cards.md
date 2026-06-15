# Fix-it Cards Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable "Crow noticed something → one-click safe fix" framework (Fix-it Cards) plus exactly one adopter — the remote-sharing / Funkwhale exposure seed — so any silent failure can become a plain-language, one-click-fixable card on the Crow's Nest.

**Architecture:** A pure in-memory **registry** (detectors + remedies + event dispatch, no I/O), a DB-only **store** for the new `fix_it_items` table, and a gateway **wiring module** that binds them together, renders the nest card section, and serves the remedy/dismiss POST route. The single v1 detector hooks the existing peer-exposure deny chokepoint (`enforcePeerExposure`) as a fire-and-forget event emit; the single v1 remedy adds a capability to this instance's local `remote_exposed_tools` allowlist and self-heals (the peer's next retry, ≤60s, succeeds).

**Tech Stack:** Node.js (ESM, `node --test`), libsql (`@libsql/client` via `servers/db.js#createDbClient`), Express dashboard routes, server-rendered HTML (template literals, inline styles — house style).

**Design decisions locked here (deviations from the spec's literal file list, made to honor its stated "narrow interface" principle):**
1. `store.js` is **DB-pure** (no registry/notifications imports). The spec listed `runRemedy` under `store.js`; instead the **orchestration** of a remedy run (load item → look up registered remedy → run → mark resolved) lives in `servers/gateway/fix-it/index.js`, the wiring layer that already knows both the store and the registry. The store stays a focused CRUD unit.
2. **Detectors stay DB-free.** A detector's `onEvent` receives a `store` whose `upsertItem`/`resolveByKey` are already db-bound (the binder lives in `index.js`). Resolving a peer's display name (a DB read) happens at the **dispatch boundary** in `emitFixIt` (generic: any payload carrying `requestingInstance` is enriched with `requestingInstanceName`), so the detector composes its title from plain payload fields + the pure friendly-name map only.
3. **Urgent push is a framework freebie.** The db-bound `upsertItem` wrapper in `index.js` fires `createNotification` when a *newly created or reopened* item has `severity:"urgent"` — the detector author gets push for free, the store never imports notifications. (The funkwhale seed is `warn`, so push is exercised by tests, not the seed.)
4. **CSRF belt-and-braces.** Every remedy/dismiss form embeds `csrfInput(req)` (the `_csrf` hidden field), matching the Wave 1 lesson that auto-submit/classic forms must carry the token explicitly rather than relying on the Turbo header listener.

---

## File Structure

**New files:**
- `servers/shared/fix-it/registry.js` — pure registry: `registerDetector`, `registerRemedy`, `getRemedy`, `emit`, `_clearRegistry`. No I/O.
- `servers/shared/fix-it/store.js` — `fix_it_items` CRUD: `upsertItem`, `resolveByKey`, `listPending`, `getItem`, `markResolved`, `dismiss`. DB only.
- `servers/gateway/fix-it/friendly-names.js` — `resolveFriendlyName(capabilityId, catalogName?)` pure map + fallback.
- `servers/gateway/fix-it/detectors/remote-exposure.js` — the v1 detector (event style).
- `servers/gateway/fix-it/remedies/expose-capability.js` — the v1 remedy (instant).
- `servers/gateway/fix-it/index.js` — wires detectors+remedies; exposes `emitFixIt`, `renderFixItCards`, `handleFixItAction`.
- `tests/fix-it-store.test.js`, `tests/fix-it-registry.test.js`, `tests/fix-it-detector.test.js`, `tests/fix-it-remedy.test.js`, `tests/fix-it-index.test.js`, `tests/fix-it-chokepoint.test.js`, `tests/fix-it-e2e.test.js`.

**Modified files:**
- `scripts/init-db.js` — add the `fix_it_items` table (local-only, standalone block).
- `servers/gateway/peer-exposure.js` — fire-and-forget `emitFixIt` on a resolvable `not_exposed` deny.
- `servers/gateway/dashboard/panels/health.js` — fetch + pass rendered Fix-it cards.
- `servers/gateway/dashboard/panels/nest/html.js` — splice the cards section after the health strip.
- `servers/gateway/dashboard/index.js` — register `POST /dashboard/fix-it/action`.
- `servers/gateway/dashboard/settings/sections/remote-exposure.js` — show friendly labels (raw id behind a `<small>`).

## Test harness invariants (apply to every test file below)

- **`CROW_DB_PATH` must be UNSET.** `createDbClient` checks `process.env.CROW_DB_PATH` *before* `CROW_DATA_DIR` (`servers/db.js:307`). The harness isolates via `CROW_DATA_DIR` → temp dir; if a developer has `CROW_DB_PATH` exported, the tests would run against their real DB. If any test misbehaves, check `echo $CROW_DB_PATH` is empty first.
- **Keep each `fix-it-*.test.js` a SEPARATE file.** `node --test` runs each file in its own process, so the registry's module-level singleton (`detectors`/`remedies` Maps) and `index.js`'s `wired` flag don't leak across suites. The registry suite calls `_clearRegistry()` in `beforeEach`; the index/e2e suites rely on `wireFixIt()` having populated it. Do NOT merge these into a single in-process run — `_clearRegistry()` would wipe state the `wired=true` flag assumes is present.

---

## Task 1: The `fix_it_items` table

**Files:**
- Modify: `scripts/init-db.js` (add a standalone block after the `dashboard_settings_overrides` block, ~line 1625)
- Test: `tests/fix-it-store.test.js` (schema assertion lives here so all store tests share one init-db harness)

- [ ] **Step 1: Write the failing test**

Create `tests/fix-it-store.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";

let dir, db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fixit-store-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("fix_it_items table exists with UNIQUE(source,dedup_key)", async () => {
  const cols = await db.execute("PRAGMA table_info(fix_it_items)");
  const names = cols.rows.map((r) => r.name);
  for (const c of ["id","source","dedup_key","title","why","severity","remedies","context","status","count","suppressed_until","created_at","updated_at"]) {
    assert.ok(names.includes(c), `missing column ${c}`);
  }
  const idx = await db.execute("PRAGMA index_list(fix_it_items)");
  const uniq = idx.rows.some((r) => Number(r.unique) === 1);
  assert.ok(uniq, "expected a UNIQUE index on fix_it_items");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fix-it-store.test.js`
Expected: FAIL — `PRAGMA table_info(fix_it_items)` returns 0 rows, assertion "missing column id" fails.

- [ ] **Step 3: Add the table to `scripts/init-db.js`**

Insert this standalone block immediately AFTER the `await initTable("dashboard_settings_overrides table", ...)` call (after its closing `);`, ~line 1625, before the `// If a previous botched migration...` comment at line 1627). **Use the house `initTable(label, sql)` wrapper** (defined at `scripts/init-db.js:16`) — every sibling table uses it for labeled error logging; do NOT call `db.executeMultiple` directly:

```js
// --- Fix-it Cards (2026-06-15): per-instance operational "noticed → one-click
// fix" items. LOCAL-ONLY, never synced (deliberately absent from
// sync-allowlist). UNIQUE(source,dedup_key) collapses retries into one card. ---
await initTable("fix_it_items table", `
  CREATE TABLE IF NOT EXISTS fix_it_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,
    dedup_key        TEXT NOT NULL,
    title            TEXT NOT NULL,
    why              TEXT,
    severity         TEXT NOT NULL DEFAULT 'warn'
                       CHECK (severity IN ('info','warn','urgent')),
    remedies         TEXT NOT NULL DEFAULT '[]',
    context          TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','dismissed','resolved')),
    count            INTEGER NOT NULL DEFAULT 1,
    suppressed_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_it_items_dedup ON fix_it_items(source, dedup_key);
  CREATE INDEX IF NOT EXISTS idx_fix_it_items_status ON fix_it_items(status);
`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/fix-it-store.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git commit scripts/init-db.js tests/fix-it-store.test.js -m "feat(fix-it): add fix_it_items table (local-only, dedup unique index)"
git show --stat HEAD
```

---

## Task 2: The store (`servers/shared/fix-it/store.js`)

**Files:**
- Create: `servers/shared/fix-it/store.js`
- Test: `tests/fix-it-store.test.js` (extend Task 1's file)

Contract (all functions are `async`, take the libsql `db` first):
- `upsertItem(db, item)` — `item = {source, dedupKey, title, why?, severity?, remedies?, context?}`. Inserts, or on `(source,dedup_key)` conflict bumps `count`, refreshes `updated_at`, and reopens a `resolved` row to `pending` (a `dismissed` row stays dismissed). Returns `{id, notify}` where `notify` is `true` when the row was newly created OR reopened (so callers push exactly once, not on every retry).
- `resolveByKey(db, source, dedupKey)` — marks the matching row `resolved`. No-op if absent.
- `markResolved(db, id)` — marks row `id` `resolved`.
- `dismiss(db, id, suppressDays = 7)` — sets `status='dismissed'`, `suppressed_until = now + suppressDays`.
- `getItem(db, id)` — returns one row with `remedies`/`context` JSON-parsed, or `null`.
- `listPending(db)` — returns `pending` rows whose `suppressed_until` is null or in the past, newest first, with `remedies`/`context` parsed.

- [ ] **Step 1: Write the failing tests** (append to `tests/fix-it-store.test.js`)

```js
import * as store from "../servers/shared/fix-it/store.js";

async function clear() { await db.execute("DELETE FROM fix_it_items"); }

const baseItem = {
  source: "remote-exposure",
  dedupKey: "expose:funkwhale:peer-1",
  title: "Your glasses bot tried to use Music, but it isn't shared yet",
  why: "Share it so your other Crow devices can use it.",
  severity: "warn",
  remedies: [{ label: "Allow", actionId: "expose-capability", args: { capability: "funkwhale" }, kind: "instant" }],
  context: { capability: "funkwhale", requestingInstance: "peer-1", toolName: "fw_play" },
};

test("upsertItem inserts once, dedups on repeat, bumps count", async () => {
  await clear();
  const a = await store.upsertItem(db, baseItem);
  assert.equal(a.notify, true);
  const b = await store.upsertItem(db, baseItem);
  assert.equal(b.notify, false);
  assert.equal(b.id, a.id);
  const rows = (await db.execute("SELECT count FROM fix_it_items")).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].count), 2);
});

test("listPending returns parsed remedies/context, hides suppressed", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  let pending = await store.listPending(db);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].remedies[0].args, { capability: "funkwhale" });
  assert.equal(pending[0].context.requestingInstance, "peer-1");
  await store.dismiss(db, id, 7);
  pending = await store.listPending(db);
  assert.equal(pending.length, 0, "dismissed+suppressed item hidden");
});

test("resolveByKey clears the card; re-detect reopens it (notify true)", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  await store.resolveByKey(db, baseItem.source, baseItem.dedupKey);
  assert.equal((await store.getItem(db, id)).status, "resolved");
  assert.equal((await store.listPending(db)).length, 0);
  const re = await store.upsertItem(db, baseItem);
  assert.equal(re.notify, true, "reopened resolved item notifies again");
  assert.equal((await store.getItem(db, id)).status, "pending");
});

test("dismissed item stays dismissed on re-detect (no reopen)", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  await store.dismiss(db, id, 7);
  const re = await store.upsertItem(db, baseItem);
  assert.equal(re.notify, false);
  assert.equal((await store.getItem(db, id)).status, "dismissed");
});

test("getItem returns null for missing id", async () => {
  await clear();
  assert.equal(await store.getItem(db, 99999), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-store.test.js`
Expected: FAIL — `Cannot find module '../servers/shared/fix-it/store.js'`.

- [ ] **Step 3: Implement `servers/shared/fix-it/store.js`**

```js
/**
 * Fix-it Cards store — CRUD for the local-only `fix_it_items` table.
 *
 * DB-pure: no registry, no notifications, no HTML. One focused unit.
 * `upsertItem` returns {id, notify} so the caller pushes exactly once on a
 * newly-created or reopened item (not on every dedup retry).
 */

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch { return fallback; }
}

function rowToItem(r) {
  return {
    id: Number(r.id),
    source: r.source,
    dedupKey: r.dedup_key,
    title: r.title,
    why: r.why,
    severity: r.severity,
    remedies: parseJson(r.remedies, []),
    context: parseJson(r.context, {}),
    status: r.status,
    count: Number(r.count),
    suppressedUntil: r.suppressed_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Insert or update a Fix-it item keyed by (source, dedup_key).
 * @returns {Promise<{id:number, notify:boolean}>}
 */
export async function upsertItem(db, item) {
  const { source, dedupKey, title, why = null, severity = "warn", remedies = [], context = null } = item;
  // Snapshot prior status to decide notify (new row vs reopened resolved).
  const prior = await db.execute({
    sql: "SELECT id, status FROM fix_it_items WHERE source = ? AND dedup_key = ?",
    args: [source, dedupKey],
  });
  const existed = prior.rows[0];

  await db.execute({
    sql: `INSERT INTO fix_it_items (source, dedup_key, title, why, severity, remedies, context)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, dedup_key) DO UPDATE SET
            count = count + 1,
            title = excluded.title,
            why = excluded.why,
            severity = excluded.severity,
            remedies = excluded.remedies,
            context = excluded.context,
            updated_at = datetime('now'),
            status = CASE WHEN fix_it_items.status = 'resolved' THEN 'pending' ELSE fix_it_items.status END`,
    args: [source, dedupKey, title, why, severity, JSON.stringify(remedies), context == null ? null : JSON.stringify(context)],
  });

  const after = await db.execute({
    sql: "SELECT id FROM fix_it_items WHERE source = ? AND dedup_key = ?",
    args: [source, dedupKey],
  });
  const id = Number(after.rows[0].id);
  const notify = !existed || existed.status === "resolved";
  return { id, notify };
}

export async function resolveByKey(db, source, dedupKey) {
  await db.execute({
    sql: "UPDATE fix_it_items SET status = 'resolved', updated_at = datetime('now') WHERE source = ? AND dedup_key = ?",
    args: [source, dedupKey],
  });
}

export async function markResolved(db, id) {
  await db.execute({
    sql: "UPDATE fix_it_items SET status = 'resolved', updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });
}

export async function dismiss(db, id, suppressDays = 7) {
  await db.execute({
    sql: `UPDATE fix_it_items
          SET status = 'dismissed',
              suppressed_until = datetime('now', '+' || ? || ' days'),
              updated_at = datetime('now')
          WHERE id = ?`,
    args: [suppressDays, id],
  });
}

export async function getItem(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM fix_it_items WHERE id = ?", args: [id] });
  return rows[0] ? rowToItem(rows[0]) : null;
}

export async function listPending(db) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM fix_it_items
          WHERE status = 'pending'
            AND (suppressed_until IS NULL OR suppressed_until <= datetime('now'))
          ORDER BY updated_at DESC, id DESC`,
    args: [],
  });
  return rows.map(rowToItem);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-store.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git commit servers/shared/fix-it/store.js tests/fix-it-store.test.js -m "feat(fix-it): DB-pure store with dedup/reopen/suppress"
git show --stat HEAD
```

---

## Task 3: The registry (`servers/shared/fix-it/registry.js`)

**Files:**
- Create: `servers/shared/fix-it/registry.js`
- Test: `tests/fix-it-registry.test.js`

Contract:
- `registerDetector({source, events, onEvent})` — `events` is `string[]`; `onEvent(eventName, payload, store)` is called for each matching event.
- `registerRemedy(actionId, fn)` — `fn(args, ctx) => {resolved, message?}`.
- `getRemedy(actionId)` — returns the fn or `null`.
- `emit(eventName, payload, store)` — `await`s every registered detector whose `events` includes `eventName`. A throwing detector is swallowed (one bad detector never blocks others or the caller).
- `_clearRegistry()` — test hook.

- [ ] **Step 1: Write the failing test** — create `tests/fix-it-registry.test.js`:

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as registry from "../servers/shared/fix-it/registry.js";

beforeEach(() => registry._clearRegistry());

test("emit dispatches only to detectors handling the event", async () => {
  const seen = [];
  registry.registerDetector({ source: "a", events: ["x"], onEvent: (e, p) => seen.push(["a", e, p.v]) });
  registry.registerDetector({ source: "b", events: ["y"], onEvent: (e, p) => seen.push(["b", e, p.v]) });
  await registry.emit("x", { v: 1 }, {});
  assert.deepEqual(seen, [["a", "x", 1]]);
});

test("a throwing detector does not break emit", async () => {
  let reached = false;
  registry.registerDetector({ source: "bad", events: ["x"], onEvent: () => { throw new Error("boom"); } });
  registry.registerDetector({ source: "good", events: ["x"], onEvent: () => { reached = true; } });
  await assert.doesNotReject(registry.emit("x", {}, {}));
  assert.equal(reached, true);
});

test("registerRemedy / getRemedy round-trip; unknown → null", async () => {
  const fn = async () => ({ resolved: true });
  registry.registerRemedy("do-thing", fn);
  assert.equal(registry.getRemedy("do-thing"), fn);
  assert.equal(registry.getRemedy("nope"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-registry.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `servers/shared/fix-it/registry.js`**

```js
/**
 * Fix-it Cards registry — pure, no I/O.
 *
 * A service registers a detector (turns failures into items) and a remedy
 * (the safe one-click fix). `emit` dispatches an event to the detectors that
 * handle it; a throwing detector is isolated so it can never break the caller
 * (the emit is on a request path) or its sibling detectors.
 */

const detectors = new Map();      // source -> { source, events, onEvent }
const eventIndex = new Map();      // eventName -> Set<source>
const remedies = new Map();        // actionId -> fn

export function registerDetector(d) {
  if (!d || !d.source || typeof d.onEvent !== "function" || !Array.isArray(d.events)) {
    throw new Error("registerDetector requires { source, events:[], onEvent }");
  }
  detectors.set(d.source, d);
  for (const ev of d.events) {
    if (!eventIndex.has(ev)) eventIndex.set(ev, new Set());
    eventIndex.get(ev).add(d.source);
  }
}

export function registerRemedy(actionId, fn) {
  if (!actionId || typeof fn !== "function") throw new Error("registerRemedy requires (actionId, fn)");
  remedies.set(actionId, fn);
}

export function getRemedy(actionId) {
  return remedies.get(actionId) || null;
}

export async function emit(eventName, payload, store) {
  const sources = eventIndex.get(eventName);
  if (!sources) return;
  for (const source of sources) {
    const d = detectors.get(source);
    if (!d) continue;
    try {
      await d.onEvent(eventName, payload, store);
    } catch (err) {
      console.warn(`[fix-it] detector "${source}" failed on "${eventName}":`, err.message);
    }
  }
}

export function _clearRegistry() {
  detectors.clear();
  eventIndex.clear();
  remedies.clear();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/shared/fix-it/registry.js tests/fix-it-registry.test.js -m "feat(fix-it): pure detector/remedy registry with isolated event dispatch"
git show --stat HEAD
```

---

## Task 4: Friendly-name map (`servers/gateway/fix-it/friendly-names.js`)

**Files:**
- Create: `servers/gateway/fix-it/friendly-names.js`
- Test: `tests/fix-it-detector.test.js` (this file also covers the detector in Task 5; create it here with the friendly-name tests first)

Contract: `resolveFriendlyName(capabilityId, catalogName)` → the seed label if known; else the provided `catalogName` (an addon's manifest name) if truthy; else the raw `capabilityId`; else `"this feature"`.

- [ ] **Step 1: Write the failing test** — create `tests/fix-it-detector.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFriendlyName } from "../servers/gateway/fix-it/friendly-names.js";

test("friendly-name map: known id, addon fallback, raw fallback", () => {
  assert.equal(resolveFriendlyName("funkwhale"), "Music");
  assert.equal(resolveFriendlyName("crow-memory"), "Memory");
  assert.equal(resolveFriendlyName("some-addon", "Weather Station"), "Weather Station");
  assert.equal(resolveFriendlyName("some-addon"), "some-addon");
  assert.equal(resolveFriendlyName(null), "this feature");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-detector.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `servers/gateway/fix-it/friendly-names.js`**

```js
/**
 * Capability-id → plain-language label, used by Fix-it cards AND (bonus) the
 * remote-exposure settings panel. Unknown ids fall back to the catalog's human
 * name (an addon's manifest `name`), then the raw id.
 */
const FRIENDLY_NAMES = {
  "funkwhale": "Music",
  "media": "News & Podcasts",
  "crow-memory": "Memory",
  "crow-blog": "Blog",
  "crow-projects": "Projects",
  "crow-sharing": "Sharing & Messages",
  "crow-storage": "Files",
};

export function resolveFriendlyName(capabilityId, catalogName) {
  if (capabilityId && FRIENDLY_NAMES[capabilityId]) return FRIENDLY_NAMES[capabilityId];
  if (catalogName && String(catalogName).trim()) return String(catalogName);
  if (capabilityId) return String(capabilityId);
  return "this feature";
}

export { FRIENDLY_NAMES };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-detector.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/fix-it/friendly-names.js tests/fix-it-detector.test.js -m "feat(fix-it): capability-id → friendly-name map"
git show --stat HEAD
```

---

## Task 5: The remote-exposure detector (`servers/gateway/fix-it/detectors/remote-exposure.js`)

**Files:**
- Create: `servers/gateway/fix-it/detectors/remote-exposure.js`
- Test: `tests/fix-it-detector.test.js` (extend Task 4's file)

Contract: default-exports `{source:"remote-exposure", events:["peer-exposure:denied"], onEvent}`. `onEvent("peer-exposure:denied", {capability, requestingInstance, requestingInstanceName, toolName}, store)`:
- If `capability` is falsy → do nothing (null-canonical denials never surface).
- Else `store.upsertItem({...})` with the spec's title/why/severity/remedy/context, using `resolveFriendlyName(capability)` and `requestingInstanceName || "another device"`.

- [ ] **Step 1: Write the failing tests** (append to `tests/fix-it-detector.test.js`)

```js
import detector from "../servers/gateway/fix-it/detectors/remote-exposure.js";

function fakeStore() {
  const items = [];
  return { items, upsertItem: async (i) => { items.push(i); return { id: items.length, notify: true }; }, resolveByKey: async () => {} };
}

test("detector creates one card with friendly title + Allow remedy", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied",
    { capability: "funkwhale", requestingInstance: "peer-1", requestingInstanceName: "Glasses", toolName: "fw_play" }, s);
  assert.equal(s.items.length, 1);
  const it = s.items[0];
  assert.equal(it.source, "remote-exposure");
  assert.equal(it.dedupKey, "expose:funkwhale:peer-1");
  assert.match(it.title, /Glasses/);
  assert.match(it.title, /Music/);
  assert.equal(it.severity, "warn");
  assert.deepEqual(it.remedies, [{ label: "Allow", actionId: "expose-capability", args: { capability: "funkwhale" }, kind: "instant" }]);
  assert.equal(it.context.toolName, "fw_play");
});

test("detector ignores a null-capability denial", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied", { capability: null, requestingInstance: "peer-1" }, s);
  assert.equal(s.items.length, 0);
});

test("detector falls back to 'another device' when peer name absent", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-1" }, s);
  assert.match(s.items[0].title, /another device/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-detector.test.js`
Expected: FAIL — `Cannot find module '.../detectors/remote-exposure.js'`.

- [ ] **Step 3: Implement `servers/gateway/fix-it/detectors/remote-exposure.js`**

```js
/**
 * v1 Fix-it detector: a peer instance was denied a tool call because the owning
 * capability isn't in this instance's remote-exposure allowlist. Hooks the
 * `peer-exposure:denied` event emitted at the enforcePeerExposure chokepoint.
 *
 * DB-free: it only composes strings from the (already name-enriched) payload
 * and the pure friendly-name map, then calls the db-bound store it's handed.
 */
import { resolveFriendlyName } from "../friendly-names.js";

export default {
  source: "remote-exposure",
  events: ["peer-exposure:denied"],
  async onEvent(_eventName, payload, store) {
    const { capability, requestingInstance, requestingInstanceName, toolName } = payload || {};
    if (!capability) return; // only real, resolvable capabilities become cards
    const friendly = resolveFriendlyName(capability);
    const peer = requestingInstanceName || "another device";
    await store.upsertItem({
      source: "remote-exposure",
      dedupKey: `expose:${capability}:${requestingInstance}`,
      title: `Your ${peer} tried to use ${friendly}, but it isn't shared with this device yet`,
      why: "Share it so your other Crow devices can use it.",
      severity: "warn",
      remedies: [{ label: "Allow", actionId: "expose-capability", args: { capability }, kind: "instant" }],
      context: { capability, requestingInstance, toolName: toolName || null },
    });
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-detector.test.js`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/fix-it/detectors/remote-exposure.js tests/fix-it-detector.test.js -m "feat(fix-it): remote-exposure detector (DB-free)"
git show --stat HEAD
```

---

## Task 6: The expose-capability remedy (`servers/gateway/fix-it/remedies/expose-capability.js`)

**Files:**
- Create: `servers/gateway/fix-it/remedies/expose-capability.js`
- Test: `tests/fix-it-remedy.test.js`

Contract: `expose-capability(args, ctx)` — `args.capability` (string), `ctx.db`. Reads `remote_exposed_tools` via `getExposedCapabilities`, adds the capability (idempotent), `writeSetting(db, "remote_exposed_tools", JSON.stringify(list), {scope:"local"})`. Returns `{resolved:true, message}`. A missing/blank capability → `{resolved:false, message}`.

- [ ] **Step 1: Write the failing test** — create `tests/fix-it-remedy.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { getExposedCapabilities } from "../servers/gateway/peer-exposure.js";

let dir, db, remedy;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-remedy-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  remedy = (await import("../servers/gateway/fix-it/remedies/expose-capability.js")).default;
});

after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("expose-capability adds the capability (idempotent), marks resolved", async () => {
  const r1 = await remedy({ capability: "funkwhale" }, { db });
  assert.equal(r1.resolved, true);
  let exposed = await getExposedCapabilities(db);
  assert.ok(exposed.has("funkwhale"));
  const r2 = await remedy({ capability: "funkwhale" }, { db }); // idempotent
  assert.equal(r2.resolved, true);
  exposed = await getExposedCapabilities(db);
  assert.equal([...exposed].filter((x) => x === "funkwhale").length, 1);
});

test("blank capability → not resolved", async () => {
  const r = await remedy({ capability: "" }, { db });
  assert.equal(r.resolved, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-remedy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `servers/gateway/fix-it/remedies/expose-capability.js`**

```js
/**
 * v1 Fix-it remedy (instant): add a capability to THIS instance's local
 * `remote_exposed_tools` allowlist so trusted peers may invoke it. Only ever
 * ADDS to this instance's own local setting — no cross-instance write, no sync.
 */
import { getExposedCapabilities } from "../../peer-exposure.js";
import { writeSetting } from "../../dashboard/settings/registry.js";

export default async function exposeCapability(args, ctx) {
  const capability = args && typeof args.capability === "string" ? args.capability.trim() : "";
  if (!capability) return { resolved: false, message: "No capability specified." };
  const db = ctx.db;
  const exposed = await getExposedCapabilities(db); // Set<string>, deny-all on error
  exposed.add(capability);
  await writeSetting(db, "remote_exposed_tools", JSON.stringify([...exposed]), { scope: "local" });
  console.log(`[fix-it] exposed capability "${capability}" to trusted peers (local scope)`);
  return { resolved: true, message: `${capability} is now shared with your trusted devices.` };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-remedy.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/fix-it/remedies/expose-capability.js tests/fix-it-remedy.test.js -m "feat(fix-it): expose-capability instant remedy (local-only add)"
git show --stat HEAD
```

---

## Task 7: The gateway wiring (`servers/gateway/fix-it/index.js`)

**Files:**
- Create: `servers/gateway/fix-it/index.js`
- Test: `tests/fix-it-index.test.js`

Contract:
- `wireFixIt()` — idempotently registers the v1 detector + remedy.
- `emitFixIt(db, eventName, payload)` — fire-and-forget. Wires; enriches the payload with `requestingInstanceName` (via `getInstance`) when `requestingInstance` is present and name absent; dispatches through `registry.emit` with a **db-bound store** whose `upsertItem` also fires an urgent push via `createNotification` for newly-created/reopened `urgent` items. Never throws.
  - **Push type = `"system"` (intentional).** `createNotification` (`notifications.js:42-55`) skips the insert if the user's `notification_prefs.types_enabled` excludes the type. `"system"` is the correct bucket for operational alerts (the only types are `reminder`/`media`/`peer`/`system`) and is on by default. The v1 funkwhale seed is `warn` (no push), so this path ships exercised only by Task 7's urgent-push test — if a future urgent detector needs a guaranteed push, revisit whether `system` can be user-disabled.
- `renderFixItCards(db, {lang, req})` — returns the cards-section HTML (or `""` if none). Each card: title, why, one form per remedy (`instant` → submit button; `confirm`/`guided` → button with a `data-fixit-kind` gate attribute, disabled-by-default note for v1), a "Not now" dismiss form, and a `<details>` with the raw capability id + requesting instance. Every form carries `csrfInput(req)`.
- `handleFixItAction(req, res, {db})` — POST handler. `action:"dismiss"` → `store.dismiss`; `action:"remedy"` → load item, find the remedy entry by `action_id`, refuse non-`instant` kinds in v1, look up the registered remedy via `registry.getRemedy`, run it with `{db, item}`, `markResolved` on `{resolved:true}`. Always `res.redirectAfterPost("/dashboard/nest?flash=...")`.

- [ ] **Step 1: Write the failing tests** — create `tests/fix-it-index.test.js`:

```js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import * as store from "../servers/shared/fix-it/store.js";

let dir, db, idx;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-index-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  idx = await import("../servers/gateway/fix-it/index.js");
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });
beforeEach(async () => { await db.execute("DELETE FROM fix_it_items"); });

test("emitFixIt turns a denial into one pending card (never throws)", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x", toolName: "fw_play" });
  const pending = await store.listPending(db);
  assert.equal(pending.length, 1);
  assert.match(pending[0].title, /Music/);
});

test("emitFixIt swallows a bad payload without throwing", async () => {
  await assert.doesNotReject(idx.emitFixIt(db, "peer-exposure:denied", null));
});

test("renderFixItCards renders a card with a CSRF field, or empty when none", async () => {
  const req = { csrfToken: "tok123" };
  assert.equal(await idx.renderFixItCards(db, { lang: "en", req }), "");
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const html = await idx.renderFixItCards(db, { lang: "en", req });
  assert.match(html, /Music/);
  assert.match(html, /name="_csrf" value="tok123"/);
  assert.match(html, /\/dashboard\/fix-it\/action/);
  assert.match(html, /Not now/);
});

test("handleFixItAction runs the remedy and resolves the card", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const item = (await store.listPending(db))[0];
  let redirected = null;
  const req = { body: { action: "remedy", item_id: String(item.id), action_id: "expose-capability" } };
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  await idx.handleFixItAction(req, res, { db });
  assert.match(redirected, /flash=/);
  assert.equal((await store.getItem(db, item.id)).status, "resolved");
  const { getExposedCapabilities } = await import("../servers/gateway/peer-exposure.js");
  assert.ok((await getExposedCapabilities(db)).has("funkwhale"));
});

test("handleFixItAction dismiss suppresses the card", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const item = (await store.listPending(db))[0];
  const res = { redirectAfterPost: () => {} };
  await idx.handleFixItAction({ body: { action: "dismiss", item_id: String(item.id) } }, res, { db });
  assert.equal((await store.listPending(db)).length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-index.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `servers/gateway/fix-it/index.js`**

```js
/**
 * Fix-it Cards — gateway wiring. Binds the pure registry + DB store to this
 * gateway: registers the v1 detector/remedy, exposes the fire-and-forget
 * `emitFixIt` chokepoints call, renders the nest card section, and serves the
 * remedy/dismiss POST action.
 */
import * as registry from "../../shared/fix-it/registry.js";
import * as store from "../../shared/fix-it/store.js";
import remoteExposureDetector from "./detectors/remote-exposure.js";
import exposeCapabilityRemedy from "./remedies/expose-capability.js";
import { createNotification } from "../../shared/notifications.js";
import { getInstance } from "../instance-registry.js";
import { escapeHtml } from "../dashboard/shared/components.js";
import { csrfInput } from "../dashboard/shared/csrf.js";

let wired = false;
export function wireFixIt() {
  if (wired) return;
  registry.registerDetector(remoteExposureDetector);
  registry.registerRemedy("expose-capability", exposeCapabilityRemedy);
  wired = true;
}

/** Build a db-bound store; the bound upsertItem also fires urgent push. */
function boundStore(db) {
  return {
    upsertItem: async (item) => {
      const r = await store.upsertItem(db, item);
      if (item.severity === "urgent" && r.notify) {
        try {
          await createNotification(db, {
            title: item.title, body: item.why || null,
            type: "system", source: "fix-it", priority: "high",
            action_url: "/dashboard/nest",
          });
        } catch (err) { console.warn("[fix-it] push failed:", err.message); }
      }
      return r;
    },
    resolveByKey: (s, k) => store.resolveByKey(db, s, k),
  };
}

/**
 * Fire a Fix-it event. Fire-and-forget — never throws, never blocks the caller
 * (it runs on the peer-exposure request path). Enriches the payload with the
 * requesting peer's display name (generic: any payload with `requestingInstance`).
 */
export async function emitFixIt(db, eventName, payload) {
  try {
    wireFixIt();
    const p = { ...(payload || {}) };
    if (p.requestingInstance && !p.requestingInstanceName) {
      try {
        const inst = await getInstance(db, p.requestingInstance);
        if (inst && inst.name) p.requestingInstanceName = inst.name;
      } catch { /* best-effort name */ }
    }
    await registry.emit(eventName, p, boundStore(db));
  } catch (err) {
    console.warn("[fix-it] emitFixIt failed:", err.message);
  }
}

function remedyButton(item, r, req) {
  const gated = r.kind === "confirm" || r.kind === "guided";
  // v1 ships only `instant`. A gated remedy renders disabled with a note so a
  // destructive action can never be a careless one-tap (framework enforces it
  // here AND in handleFixItAction).
  return `<form method="POST" action="/dashboard/fix-it/action" style="display:inline">
    ${csrfInput(req)}
    <input type="hidden" name="action" value="remedy">
    <input type="hidden" name="item_id" value="${escapeHtml(String(item.id))}">
    <input type="hidden" name="action_id" value="${escapeHtml(r.actionId)}">
    <button type="submit" class="btn btn-secondary" data-fixit-kind="${escapeHtml(r.kind || "instant")}"${gated ? " disabled title=\"Coming soon\"" : ""}>${escapeHtml(r.label || "Fix")}</button>
  </form>`;
}

/** Render the nest Fix-it card section (or "" when nothing pending). */
export async function renderFixItCards(db, { lang, req } = {}) {
  let items = [];
  try { items = await store.listPending(db); } catch { return ""; }
  if (!items.length) return "";

  const cards = items.map((item) => {
    const remedyBtns = (item.remedies || []).map((r) => remedyButton(item, r, req)).join("");
    const ctx = item.context || {};
    const techRows = [];
    if (ctx.capability) techRows.push(`Capability: <code>${escapeHtml(ctx.capability)}</code>`);
    if (ctx.requestingInstance) techRows.push(`Requesting instance: <code>${escapeHtml(ctx.requestingInstance)}</code>`);
    const details = techRows.length
      ? `<details style="margin-top:0.5rem"><summary style="cursor:pointer;color:var(--crow-text-muted);font-size:0.8rem">Technical details</summary>
           <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-top:0.3rem">${techRows.join("<br>")}</div></details>`
      : "";
    const countBadge = item.count > 1
      ? `<span style="font-size:0.7rem;color:var(--crow-text-muted)">×${escapeHtml(String(item.count))}</span>` : "";
    return `<div class="nest-fixit-card" style="border:1px solid var(--crow-border,#2222);border-left:3px solid var(--crow-warning,#e0a000);border-radius:8px;padding:0.8rem 1rem;margin-bottom:0.6rem;background:var(--crow-surface,rgba(255,255,255,0.02))">
      <div style="font-weight:600;margin-bottom:0.2rem">${escapeHtml(item.title)} ${countBadge}</div>
      ${item.why ? `<div style="color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:0.6rem">${escapeHtml(item.why)}</div>` : ""}
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        ${remedyBtns}
        <form method="POST" action="/dashboard/fix-it/action" style="display:inline">
          ${csrfInput(req)}
          <input type="hidden" name="action" value="dismiss">
          <input type="hidden" name="item_id" value="${escapeHtml(String(item.id))}">
          <button type="submit" class="btn btn-text" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer">Not now</button>
        </form>
      </div>
      ${details}
    </div>`;
  }).join("");

  return `<div class="nest-fixits" style="margin:0 1rem 1rem" aria-label="Things Crow noticed">${cards}</div>`;
}

/** POST /dashboard/fix-it/action — remedy or dismiss. */
export async function handleFixItAction(req, res, { db }) {
  wireFixIt();
  const body = req.body || {};
  const action = body.action;
  const itemId = Number(body.item_id);
  try {
    if (!Number.isInteger(itemId)) {
      return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
    }
    if (action === "dismiss") {
      await store.dismiss(db, itemId, 7);
      return res.redirectAfterPost("/dashboard/nest?flash=fixit_dismissed");
    }
    if (action === "remedy") {
      const item = await store.getItem(db, itemId);
      if (!item) return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      const entry = (item.remedies || []).find((r) => r.actionId === body.action_id);
      if (!entry) return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      if (entry.kind && entry.kind !== "instant") {
        // v1 only runs instant remedies; confirm/guided are gated.
        return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      }
      const fn = registry.getRemedy(entry.actionId);
      if (!fn) return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      const result = await fn(entry.args || {}, { db, item });
      if (result && result.resolved) {
        await store.markResolved(db, itemId);
        return res.redirectAfterPost("/dashboard/nest?flash=fixit_fixed");
      }
      return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
    }
    return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
  } catch (err) {
    console.error("[fix-it] action failed:", err.message);
    return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-index.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/fix-it/index.js tests/fix-it-index.test.js -m "feat(fix-it): gateway wiring — emit, render, action handler"
git show --stat HEAD
```

---

## Task 8: Hook the chokepoint (`servers/gateway/peer-exposure.js`)

**Files:**
- Modify: `servers/gateway/peer-exposure.js` (emit after the deny audit, ~line 140)
- Test: `tests/fix-it-chokepoint.test.js`

The emit must be fire-and-forget, fire only on a resolvable `not_exposed` deny, and never alter the gate's behavior (still denies + audits exactly as before, never throws if Fix-it errors).

- [ ] **Step 1: Write the failing test** — create `tests/fix-it-chokepoint.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { enforcePeerExposure } from "../servers/gateway/peer-exposure.js";

function mkRes() {
  return { _status: null, _json: null, headersSent: false,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; this.headersSent = true; return this; } };
}
const fakeDb = {}; // not read when exposedSetOverride is supplied
const connected = new Map([["funkwhale", { tools: [{ name: "fw_play" }] }]]);

test("a not_exposed deny emits peer-exposure:denied once with the canonical capability", async () => {
  const emits = [];
  const req = { instanceAuth: { instance: { id: "peer-1" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 7 } };
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req, res, db: fakeDb, connectedServers: connected,
    exposedSetOverride: new Set(), // deny-all
    auditFn: async () => {},
    emitFn: async (ev, payload) => { emits.push([ev, payload]); },
  });
  assert.equal(ok, false);
  assert.equal(res._status, 403);
  assert.equal(emits.length, 1);
  assert.equal(emits[0][0], "peer-exposure:denied");
  assert.equal(emits[0][1].capability, "funkwhale");
  assert.equal(emits[0][1].requestingInstance, "peer-1");
  assert.equal(emits[0][1].toolName, "fw_play");
});

test("an ALLOWED call does not emit", async () => {
  const emits = [];
  const req = { instanceAuth: { instance: { id: "peer-1" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 1 } };
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req, res, db: fakeDb, connectedServers: connected,
    exposedSetOverride: new Set(["funkwhale"]),
    auditFn: async () => {}, emitFn: async (ev, p) => emits.push([ev, p]),
  });
  assert.equal(ok, true);
  assert.equal(emits.length, 0);
});

test("a throwing emitFn never breaks the gate", async () => {
  const req = { instanceAuth: { instance: { id: "peer-1" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 2 } };
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req, res, db: fakeDb, connectedServers: connected,
    exposedSetOverride: new Set(), auditFn: async () => {},
    emitFn: async () => { throw new Error("boom"); },
  });
  assert.equal(ok, false);
  assert.equal(res._status, 403);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fix-it-chokepoint.test.js`
Expected: FAIL — `emitFn` is ignored, so `emits.length` is 0 in test 1 (expected 1).

- [ ] **Step 3: Modify `servers/gateway/peer-exposure.js`**

Add the import near the top (after the existing imports, ~line 17):

```js
import { emitFixIt } from "./fix-it/index.js";
```

> **Note — this introduces an ESM cycle, and it is eval-safe. Do NOT "fix" it with a dynamic `await import()`.** The cycle is `peer-exposure.js → fix-it/index.js → remedies/expose-capability.js → peer-exposure.js`. No cyclic binding is invoked at module-evaluation time: `emitFn = emitFixIt` is a *default parameter* (evaluated at call time, not import time), `getExposedCapabilities` is referenced only inside the remedy's function body, and `wireFixIt()` registration is lazy (first call). The chokepoint test loads cleanly for the same reason (it supplies its own `emitFn`, and even the default resolves lazily). Leave it as a static import.

Change the `enforcePeerExposure` signature to accept an `emitFn` test hook (default = `emitFixIt`):

```js
export async function enforcePeerExposure({ prefix, req, res, db, connectedServers, exposedSetOverride, auditFn = auditCrossHostCall, emitFn = emitFixIt }) {
```

Then, in the deny branch — AFTER the audit `try/catch` and BEFORE `if (allowed) return true;` — add the fire-and-forget emit (note: `canonicalId` is the resolved capability; it is a non-null string on a real `not_exposed` deny because `__allow__` already returned and `null` means malformed):

```js
  if (allowed) return true;

  // Fix-it: a resolvable capability was denied → surface a one-click "Allow"
  // card. Fire-and-forget; must never block or break the gate. Only real,
  // resolvable capabilities (string canonicalId) become cards — a null-canonical
  // (malformed) deny is skipped.
  if (typeof canonicalId === "string") {
    try {
      Promise.resolve(emitFn(db, "peer-exposure:denied", {
        capability: canonicalId,
        requestingInstance: sourceId,
        toolName,
      })).catch(() => {});
    } catch { /* never breaks the gate */ }
  }

  if (!res.headersSent) {
```

(The existing `res.status(403).json(...)` block stays exactly as is, immediately after.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/fix-it-chokepoint.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the existing exposure tests to confirm no regression**

Run: `node --test tests/exposure-allowlist.test.js tests/bot-management-exposure.test.js`
Expected: PASS — the gate still denies/allows/audits identically (the new `emitFn` param defaults to `emitFixIt` and is purely additive).

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/peer-exposure.js tests/fix-it-chokepoint.test.js -m "feat(fix-it): emit peer-exposure:denied at the deny chokepoint (fire-and-forget)"
git show --stat HEAD
```

---

## Task 9: Render the cards on the nest

**Files:**
- Modify: `servers/gateway/dashboard/panels/health.js` (fetch + pass `fixItHtml`)
- Modify: `servers/gateway/dashboard/panels/nest/html.js` (splice after the health strip; add a flash branch)

No new unit test here (covered by Task 7's `renderFixItCards` test + Task 12 e2e); this is presentational wiring. Verification is a clean server start.

- [ ] **Step 1: Modify `servers/gateway/dashboard/panels/health.js`**

Add the import (after the existing imports, ~line 16):

```js
import { renderFixItCards } from "../../fix-it/index.js";
```

In `handler`, after the `healthSignals` collection block (~line 141, right after the `try { healthSignals = ... } catch {}`), add:

```js
    // Fix-it cards (fails gracefully to "" if anything throws)
    let fixItHtml = "";
    try {
      fixItHtml = await renderFixItCards(db, { lang, req });
    } catch {}
```

Then extend the `flash` allow-list to include the Fix-it flashes (~line 144):

```js
    const flash = (typeof req.query?.flash === "string" &&
      ["backup_ok", "backup_fail", "fixit_fixed", "fixit_dismissed", "fixit_error"].includes(req.query.flash))
      ? req.query.flash
      : null;
```

And pass `fixItHtml` into `buildNestHTML` (~line 150):

```js
    const html = buildNestHTML({ ...data, healthSignals, flash, fixItHtml }, lang);
```

- [ ] **Step 2: Modify `servers/gateway/dashboard/panels/nest/html.js`**

Destructure `fixItHtml` in `buildNestHTML` (line 236):

```js
  const { pinnedItems, bundles, instances, trustedInstances, peerOverviews, ssoEnabled, healthSignals, flash, fixItHtml } = data;
```

Splice it after the health strip in BOTH return statements. Carousel return (line 453):

```js
    return `${welcomeHtml}${healthStripHtml}${fixItHtml || ""}${pinnedHtml}${carousel}`;
```

Non-carousel return (line 456):

```js
  return `${welcomeHtml}${healthStripHtml}${fixItHtml || ""}${pinnedHtml}${instancesHtml}${gridHtml}`;
```

Add the Fix-it flash branches inside `buildHealthStrip`. The existing chain ends at line 174 with a bare closing `}` (the `else if (flash === "backup_fail")` branch), and line 176 is `if (!health) return flashHtml;`. **REPLACE the closing `}` on line 174** with the three new `else if` branches followed by the closing `}` (inserting verbatim after the existing `}` would orphan the `else`):

```js
  } else if (flash === "fixit_fixed") {
    flashHtml = `<div class="nest-flash nest-flash--success">Done — it's shared now.</div>`;
  } else if (flash === "fixit_dismissed") {
    flashHtml = `<div class="nest-flash nest-flash--success">Dismissed for now.</div>`;
  } else if (flash === "fixit_error") {
    flashHtml = `<div class="nest-flash nest-flash--error">Couldn't apply that fix.</div>`;
  }
```

I.e. the resulting chain is `if (flash === "backup_ok") {...} else if (flash === "backup_fail") {...} else if (flash === "fixit_fixed") {...} else if (flash === "fixit_dismissed") {...} else if (flash === "fixit_error") {...}` then `if (!health) return flashHtml;` continues unchanged.

- [ ] **Step 3: Verify the gateway starts cleanly**

Run: `node servers/gateway/index.js --no-auth`
Expected: starts without throwing (watch for import/syntax errors), then Ctrl-C. (The `--no-auth` flag is the documented smoke-start.)

- [ ] **Step 4: Commit**

```bash
git commit servers/gateway/dashboard/panels/health.js servers/gateway/dashboard/panels/nest/html.js -m "feat(fix-it): render Fix-it cards section on the Crow's Nest"
git show --stat HEAD
```

---

## Task 10: The dashboard POST route

**Files:**
- Modify: `servers/gateway/dashboard/index.js` (register `POST /dashboard/fix-it/action`, mirroring the fediverse route)

- [ ] **Step 1: Add the import** near the other panel/route imports at the top of `servers/gateway/dashboard/index.js` (find where `fediversePanel` is imported and add alongside):

```js
import { handleFixItAction } from "../fix-it/index.js";
```

- [ ] **Step 2: Register the route** immediately after the `POST /dashboard/fediverse/action` block (~line 633), copying its db-lifecycle pattern:

```js
  // Fix-it Cards action POST (remedy / dismiss) — dashboard-authed, CSRF-protected.
  router.post("/dashboard/fix-it/action", async (req, res) => {
    const db = createDbClient();
    try {
      await handleFixItAction(req, res, { db });
    } finally {
      try { db.close(); } catch {}
    }
  });
```

- [ ] **Step 3: Verify the gateway starts cleanly**

Run: `node servers/gateway/index.js --no-auth`
Expected: starts without error; Ctrl-C to exit.

- [ ] **Step 4: Commit**

```bash
git commit servers/gateway/dashboard/index.js -m "feat(fix-it): POST /dashboard/fix-it/action route (auth + CSRF)"
git show --stat HEAD
```

---

## Task 11: Friendly labels in the remote-exposure panel (the "simplify what we have" piece)

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/remote-exposure.js` (show the friendly label; raw id behind `<code>`/details)

- [ ] **Step 1: Add the import** (after line 16):

```js
import { resolveFriendlyName } from "../../../fix-it/friendly-names.js";
```

- [ ] **Step 2: Use the friendly label in the row render.** Replace the `rows` map (lines 46-53) so the primary label is the friendly name (falling back to the catalog `name`), with the raw canonical id kept as the muted `<code>` (already there) for disclosure:

```js
    const rows = caps.map((c) => {
      const on = c.exposed === true;
      const friendly = resolveFriendlyName(c.canonicalId, c.name);
      return `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--crow-border,#2222)">
        <input type="checkbox" name="cap" value="${escapeHtml(c.canonicalId)}" ${on ? "checked" : ""}>
        <span style="flex:1">${escapeHtml(friendly)} <span style="color:var(--crow-text-muted);font-size:0.85rem">(${escapeHtml(c.category)}${c.bundleId ? " · addon" : ""})</span></span>
        <code style="color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(c.canonicalId)}</code>
      </label>`;
    }).join("");
```

(`handleAction` is unchanged — it still writes the raw `canonicalId`s from the checkbox `value`s.)

- [ ] **Step 3: Verify the gateway starts cleanly**

Run: `node servers/gateway/index.js --no-auth`
Expected: starts; Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git commit servers/gateway/dashboard/settings/sections/remote-exposure.js -m "feat(fix-it): friendly capability labels in the remote-exposure panel"
git show --stat HEAD
```

---

## Task 12: End-to-end gated test (denied → card → fix → allowed)

**Files:**
- Test: `tests/fix-it-e2e.test.js`

Proves the whole loop at the module level (no HTTP server needed): a denied call produces a card; running its remedy exposes the capability; a subsequent enforcement check for that capability now allows.

- [ ] **Step 1: Write the test** — create `tests/fix-it-e2e.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { enforcePeerExposure, getExposedCapabilities } from "../servers/gateway/peer-exposure.js";
import * as store from "../servers/shared/fix-it/store.js";

let dir, db, idx;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  idx = await import("../servers/gateway/fix-it/index.js");
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function mkRes() {
  return { _status: null, headersSent: false,
    status(c) { this._status = c; return this; },
    json() { this.headersSent = true; return this; } };
}

// Deterministic wait: poll until the card lands or a hard deadline trips.
// The chokepoint emit is fire-and-forget (not awaited), so a fixed sleep is
// racy; poll instead and FAIL LOUDLY at the deadline.
async function waitForPending(predicate, deadlineMs = 2000) {
  const start = Date.now();
  for (;;) {
    const pending = await store.listPending(db);
    if (predicate(pending)) return pending;
    if (Date.now() - start > deadlineMs) {
      assert.fail(`card did not materialize within ${deadlineMs}ms (saw ${pending.length})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("denied call → card appears → remedy → next check allowed", async () => {
  const connected = new Map([["funkwhale", { tools: [{ name: "fw_play" }] }]]);
  const req = { instanceAuth: { instance: { id: "peer-9" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 1 } };

  // 1. Denied (nothing exposed) — uses the real emitFixIt (default emitFn).
  const denied = await enforcePeerExposure({ prefix: "tools", req, res: mkRes(), db, connectedServers: connected, auditFn: async () => {} });
  assert.equal(denied, false);

  // 2. The emit is fire-and-forget; poll deterministically until the card lands.
  const pending = await waitForPending((p) => p.length === 1);
  assert.equal(pending[0].context.capability, "funkwhale");

  // 3. Run the remedy via the action handler.
  const res2 = { redirectAfterPost: () => {} };
  await idx.handleFixItAction({ body: { action: "remedy", item_id: String(pending[0].id), action_id: "expose-capability" } }, res2, { db });
  assert.ok((await getExposedCapabilities(db)).has("funkwhale"));
  assert.equal((await store.listPending(db)).length, 0); // card cleared

  // 4. The next enforcement check for the same capability is now allowed.
  const allowed = await enforcePeerExposure({ prefix: "tools", req, res: mkRes(), db, connectedServers: connected, auditFn: async () => {} });
  assert.equal(allowed, true);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/fix-it-e2e.test.js`
Expected: PASS (1 test). The `waitForPending` poll makes the fire-and-forget emit deterministic (it fails loudly at a 2s deadline rather than racing a fixed sleep).

- [ ] **Step 3: Run the FULL Fix-it suite + the touched neighbors**

Run:
```bash
for f in fix-it-store fix-it-registry fix-it-detector fix-it-remedy fix-it-index fix-it-chokepoint fix-it-e2e; do node --test tests/$f.test.js || break; done
node --test tests/auth-network.test.js   # invariant: nothing changed network exposure
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git commit tests/fix-it-e2e.test.js -m "test(fix-it): end-to-end denied→card→fix→allowed"
git show --stat HEAD
```

---

## Self-Review (run after all tasks)

**Spec coverage check** (each spec section → task):
- Concepts / contract (registry, store, remedy shapes) → Tasks 2, 3.
- Data model (`fix_it_items`, dedup unique, reopen-on-redetect SQL) → Tasks 1, 2.
- Event chokepoint (`peer-exposure:denied`, fire-and-forget, null-canonical skipped, sync gate unchanged) → Task 8.
- Surface (nest cards alongside health strip, layered details, push for urgent) → Tasks 7, 9.
- Remedy safety (`instant` vs `confirm`/`guided` gate in renderer + route; under dashboard auth+CSRF; never funnel-exposed) → Tasks 7, 10.
- Dedup / suppression / auto-resolve / audit (row is the trail) → Tasks 2, 7.
- Funkwhale seed (detector + remedy + peer name) → Tasks 5, 6, plus name enrichment in Task 7.
- Friendly-name map (cards + exposure panel) → Tasks 4, 11.
- Architecture/units (narrow interfaces) → all; deviations documented in the header.
- Security considerations (local-only add, no cross-instance write, fail-closed gate) → Tasks 6, 8, 10.
- Testing (registry, store, detector, remedy, chokepoint, e2e) → Tasks 2,3,5,6,8,12.

**Out-of-scope confirmed NOT built:** poll detectors, any non-funkwhale detector, per-peer exposure, cross-instance card routing, auto-remediation. (Framework is shaped for them; none implemented.)

**Type consistency:** `upsertItem` returns `{id, notify}` everywhere; item shape `{source, dedupKey, title, why, severity, remedies, context}` consistent across store/detector/index; remedy entry `{label, actionId, args, kind}` consistent across detector/renderer/handler; `getRemedy` returns fn-or-null consistently.

---

## Post-implementation (after the plan executes)

1. **Security review:** run `/security-review` on the branch (the spec's chokepoint + new POST route + a config-mutating remedy warrant it — same as the voice work, where a HIGH was caught).
2. **Finish the branch:** superpowers:finishing-a-development-branch (merge to `main` after `git pull --rebase`).
3. **Deploy** per the handoff cheat-sheet: this is gateway-only (no bot restart). On crow: restart `crow-gateway` + `crow-mpa-gateway`; on grackle: restart `crow-gateway`. Run `node scripts/init-db.js` (or rely on gateway startup) on each host so the `fix_it_items` table is created. The card surfaces on the instance that OWNS the denied capability (funkwhale → main crow), so verify there.
4. **Live smoke:** trigger a real denial (a peer/glasses call for an un-exposed capability) and confirm a card appears on that instance's nest, the "Allow" button exposes it, the card clears, and the peer's retry succeeds.

---

## Review

**Reviewer:** Staff-engineer adversarial pass (Plan subagent), verified against live code. **Date:** 2026-06-15. **Verdict:** REVISE → all critical issues resolved below; plan now APPROVED for execution.

Confirmed accurate by the reviewer (no change needed): chokepoint signature + deny-branch scope (`canonicalId`/`sourceId`/`toolName` all in scope at the insert point), CSRF token availability (`csrfMiddleware` at `index.js:611` runs before panel dispatch, so `req.csrfToken` is populated when the nest renders), `createDbClient` reads `CROW_DATA_DIR` at call time (test-safe), `writeSetting scope:"local"` semantics, render-wiring line numbers, `getInstance`/`createNotification` signatures, and the dedup/reopen SQL (`resolved`→`pending`, `dismissed` stays). The ESM cycle was traced and is eval-safe.

Critical issues raised → resolution:
1. **`init-db.js` house pattern** — plan used bare `db.executeMultiple`; the codebase uses the `initTable(label, sql)` wrapper. → Task 1 Step 3 rewritten to `await initTable("fix_it_items table", …)` with the corrected anchor description.
2. **Flaky 50ms `setTimeout` in the e2e test** — the chokepoint emit is fire-and-forget (un-awaited), so a fixed sleep races. → Task 12 now uses a `waitForPending` poll-until-2s-deadline helper that fails loudly; removed the "increase the tick" hand-wave.
3. **Ambiguous `buildHealthStrip` flash edit** — inserting after the closing `}` would orphan the `else`. → Task 9 Step 2 reworded to explicitly REPLACE the line-174 `}` and shows the full resulting chain.

Suggestions/questions incorporated:
4. Added an eval-safe-cycle note to Task 8 (don't refactor to dynamic import).
5. Added "Test harness invariants": `CROW_DB_PATH` must be unset; keep each `fix-it-*.test.js` a separate file (registry singleton + `wired` flag isolation).
6. Task 8 Step 5 now names the real neighbor suites (`exposure-allowlist.test.js`, `bot-management-exposure.test.js`).
7. Documented the `type:"system"` push choice (Q9) and confirmed the empty-`crow_instances` fallback path (Q10, no action). `listPending` second-granularity ordering (Q8) accepted for v1 — `id DESC` is the deterministic tiebreaker.

### Post-implementation code review (independent adversarial pass, 2026-06-15)

A second independent code-reviewer (no Critical issues) verified all 8 security properties: every rendered value is `escapeHtml`-escaped (no XSS, including peer-controlled `toolName`/instance name); CSRF token is populated at nest-render time and the POST route sits behind `dashboardAuth`+`csrfMiddleware`; the `instant`-only gate blocks future confirm/guided remedies; malformed POST bodies redirect to `fixit_error` with no unhandled throw; the fire-and-forget emit swallows both sync throws and async rejections while the 403 always sends; no cross-request shared mutable state; the remedy only ever adds to the local setting; the route closes its db client. Two Important findings:

- **#1 Dismissed cards never resurfaced** (real spec gap) — **FIXED** (`fix(fix-it): reopen dismissed cards after suppression window elapses`). The upsert `CASE` now reopens a `dismissed` row whose `suppressed_until <= now`, and `notify` fires on any transition *into* `pending`. New store test: "dismissed item resurfaces … after the suppression window passes."
- **#2 TOCTOU on the `notify` flag** — a rare concurrent double-insert of the SAME dedup key can double-notify an `urgent` item. **Accepted for v1, documented** (Known limitations below): zero impact on the v1 funkwhale seed (`warn`, no push), and the codebase's own nest pin/unpin handler uses the identical non-transactional SELECT-then-upsert. A future `urgent` detector should make `upsertItem` transactional (single-connection BEGIN/COMMIT or `RETURNING`).

### Known limitations (v1)
- `upsertItem`'s `notify` is computed from a pre-upsert snapshot; concurrent double-inserts of one dedup key can double-fire an `urgent` push. Benign for v1 (warn-only). Make transactional before shipping an `urgent` detector.
- `expose-capability` remedy reads `remote_exposed_tools` then writes — same non-transactional pattern; last-writer-wins across a simultaneous manual edit of the exposure panel. Practically irrelevant (single operator) and the write is idempotent-add.
- If `readSetting` *throws* during a remedy click, `getExposedCapabilities` returns an empty set (its deny-all-on-error contract), so the write would narrow the allowlist to just the clicked capability. Fail-safe direction (never over-exposes), rare (requires a DB read error at click time); not worth weakening the security gate's deny-all-on-error behavior to guard.

### Security review (2026-06-15) — CLEAN
Independent `/security-review` pass: no HIGH/MEDIUM newly-introduced findings. Verified: all `store.js` SQL parameterized (incl. the `datetime('now','+'||?||' days')` dismiss binding); every rendered value `escapeHtml`-escaped and the only peer-free-text value (`toolName`) is stored-not-rendered; POST route behind `dashboardAuth`+`csrfMiddleware`; the deny-path emit is decision-neutral and creates only a pending card (exposure requires an authenticated CSRF-protected operator click); the exposed capability derives from server-stored remedies JSON, not the POST body.
