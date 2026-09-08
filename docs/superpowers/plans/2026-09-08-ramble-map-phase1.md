# Ramble map — fog, frontier, unlocking, bird seed (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Ramble map becomes a fog-of-war map: ground you have physically walked is permanently unlocked and readable, a rolling frontier a few cells ahead shows typed beacons that say something is there without revealing what, everything else is fog — and walking your unlocked ground pays bird seed.

**Architecture:** Two new replicated tables (`ramble_cells`, one row per unlocked cell; `ramble_wallet`, an append-only currency ledger) plus one pure module (`zones.js`) that classifies any cell as unlocked, frontier or fog. The existing public content routes filter through that classification; contact and group content is untouched. Bird seed is never stored as a balance — pickups are ledger rows keyed by cell and window, and the balance is derived, because two instances each writing a total would lose increments to last-writer-wins.

**Tech Stack:** Node 22 ESM, libsql, Leaflet in the panel client, Node test runner via `scripts/run-suite.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md` — §2 (the map) and the bird-seed half of §3, plus §6 (data and sync), §7, §8, and phase 1 of §9. Decisions D4, D5, D6.

## Global Constraints

- **Base:** `main` @5a068941. Work in a worktree; never `git checkout` in `~/crow` — a gateway checkout parked off `main` silently disables fleet auto-update.
- **Node/test harness:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before any node/npm command. Run tests ONLY as `node scripts/run-suite.mjs tests/<file>.test.js` from the worktree, in the FOREGROUND. **NEVER run bare `node --test`** — it writes to the LIVE production database. Never boot a gateway or MCP server.
- **Cell grain (spec §1):** a cell is a geohash-7 square, ~153 m. `CELL7_RE = /^[0-9b-hjkmnp-z]{7}$/`, `CELL7_LAT_STEP = 180 / 2 ** 17`, `CELL7_LON_STEP = 360 / 2 ** 18`, all already exported from `bundles/ramble/server/nests.js`.
- **Unlock radius (spec §2.1):** a cell unlocks only from a real position fix, never from a map pan. The existing rule in `POST /api/ramble/area` already enforces this: no `here`, no credit, ever. Unlocking hangs off the same `here`.
- **Frontier depth (spec §6.4):** setting `frontier.depth`, default **3**, minimum 0. Read live, like `nest.rate` and `shelf.cap`.
- **Seed settings (spec §6.4):** `seed.respawn.hours` default **24** (minimum 1), `seed.per.pickup` default **1** (minimum 0).
- **Public overlay only (D4):** zone gating applies ONLY to public marks and caws and to nests. A contact's or a group's mark must be unaffected in every zone. In `ramble_marks` the discriminator is `origin`: `remote` rows arriving from the public relays are public; `local` and `sync` rows are the user's own; contact/group delivery is a separate path. Gate on the PUBLIC audience, never on all marks.
- **Beacons are typed, never detailed (D5):** a frontier entry carries its kind and a position and nothing else. It must never carry `text`, `author`, `author_name`, `contact_name`, `contact_avatar`, `bird` or `mark_id`.
- **Ledgers, not balances (spec §6.1):** every currency event is a row keyed by a natural idempotent key. Never store or update a running total.
- **Append-only apply:** `ramble_cells` and `ramble_wallet` rows are immutable facts. Their sync apply handlers are insert-if-absent, NOT last-writer-wins, and they never delete. For `ramble_cells.first_unlocked_at` the EARLIEST timestamp wins, because if two instances both recorded a visit the earlier one is the truth.
- **Privacy (spec §2.4):** the unlocked-cell set is a precise permanent record of everywhere the user has been. It replicates to the user's OWN instances and must NEVER reach a contact. Do not add it to any contact-facing payload.
- **Panel client rules, test-enforced:** `bundles/ramble/panel/static/ramble.js` must keep ZERO backticks, EXACTLY TWO engine markup sinks, and no emoji. `setAttribute`/`removeAttribute`/`className`/Leaflet layer calls are not markup sinks.
- **Invisible characters:** write any bidi/control character as a `\u` escape, never a raw byte.
- **Commits:** subject-only message, positional paths, `git add` new files first, NO AI-attribution trailers of any kind.
- **Bundle bump:** `bundles/ramble/manifest.json` AND `bundles/ramble/package.json` `0.8.1` → `0.9.0`; then `npm run build-registry`.
- **Migration:** all additive. Run `scripts/schema-migration-dryrun.sh` from the branch against copies of the three live DBs before the PR; expect only the new tables and `user_version` unchanged.

---

## File structure

**Create**
- `bundles/ramble/server/zones.js` — pure cell-classification. `neighborhood(cell, depth)`, `classifyCell(cell, unlockedSet, depth)`, `classifyBbox(bbox, unlockedSet, depth, max)`. Imports only `nests.js` and `anchors.js`.
- `bundles/ramble/server/wallet.js` — the currency ledger. `SEED_KIND`, `recordSeedPickup`, `seedBalance`, `readWalletSettings`, `harvestWindow`.
- `bundles/ramble/server/cells.js` — `recordUnlock(db, cell, now)`, `unlockedCells(db)`, `unlockedSetForBbox(db, bbox)`.
- Tests: `tests/ramble-zones.test.js`, `tests/ramble-cells.test.js`, `tests/ramble-wallet.test.js`, `tests/ramble-map-gating.test.js`, `tests/ramble-cells-sync.test.js`.

**Modify**
- `bundles/ramble/server/init-tables.js` — the two new tables.
- `servers/sharing/instance-sync.js` — register both tables, both excluded-column lists, an apply handler each, and both dispatch sites.
- `bundles/ramble/panel/routes.js` — record the unlock and harvest seed in `POST /api/ramble/area`; gate `/api/ramble/marks`, `/around` and `/nests`; add `GET /api/ramble/zones`.
- `bundles/ramble/panel/static/ramble.js` — fog and beacon rendering, the unlock animation, the seed counter.
- `bundles/ramble/panel/static/ramble.css` — fog, beacon and unlock-flash rules.
- `bundles/ramble/panel/ramble.js` — the seed counter in the map bar.
- `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`.

---

## Task 1: the two tables, and their replication

**Files:**
- Modify: `bundles/ramble/server/init-tables.js`, `servers/sharing/instance-sync.js`
- Create: `tests/ramble-cells-sync.test.js`

**Interfaces:**
- Produces: tables `ramble_cells (cell TEXT PRIMARY KEY, first_unlocked_at INTEGER NOT NULL, lamport_ts INTEGER DEFAULT 0)` and `ramble_wallet (kind TEXT NOT NULL, key TEXT NOT NULL, delta INTEGER NOT NULL, created_at INTEGER NOT NULL, lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (kind, key))`; exported `applyRambleCell(db, op, row, lamportTs)` and `applyRambleWallet(db, op, row, lamportTs)`.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-cells-sync.test.js`. This is a MULTI-INSTANCE test on purpose: this project treats prose review as insufficient for anything that replicates.

```js
/**
 * Spec 2026-09-08 §6: ramble_cells and ramble_wallet are APPEND-ONLY facts,
 * not last-writer-wins rows. A cell unlock keeps the EARLIEST timestamp; a
 * ledger row is never overwritten and never deleted. Both replicate to the
 * user's own instances (and, per §2.4, must never reach a contact).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleCell, applyRambleWallet } from "../servers/sharing/instance-sync.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
const rowsOf = async (db, sql) => (await db.execute(sql)).rows;

test("initRambleTables creates ramble_cells and ramble_wallet with the right keys", async () => {
  const db = await freshDb();
  const cells = await rowsOf(db, "PRAGMA table_info(ramble_cells)");
  assert.deepEqual(cells.map((r) => r.name), ["cell", "first_unlocked_at", "lamport_ts"]);
  assert.equal(Number(cells.find((r) => r.name === "cell").pk), 1, "cell is the primary key");
  const wallet = await rowsOf(db, "PRAGMA table_info(ramble_wallet)");
  assert.deepEqual(wallet.map((r) => r.name), ["kind", "key", "delta", "created_at", "lamport_ts"]);
  assert.deepEqual(wallet.filter((r) => Number(r.pk) > 0).map((r) => r.name), ["kind", "key"]);
  await initRambleTables(db); // idempotent
  assert.equal((await rowsOf(db, "PRAGMA table_info(ramble_cells)")).length, 3);
});

test("applyRambleCell: inserts once, keeps the EARLIEST first_unlocked_at, ignores deletes", async () => {
  const db = await freshDb();
  await applyRambleCell(db, "insert", { cell: "9vk79ed", first_unlocked_at: 5000 }, 10);
  let rows = await rowsOf(db, "SELECT * FROM ramble_cells");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].first_unlocked_at), 5000);

  // A later-arriving row with an EARLIER timestamp wins on the timestamp.
  await applyRambleCell(db, "insert", { cell: "9vk79ed", first_unlocked_at: 1000 }, 20);
  rows = await rowsOf(db, "SELECT * FROM ramble_cells");
  assert.equal(rows.length, 1, "still one row");
  assert.equal(Number(rows[0].first_unlocked_at), 1000, "earliest wins");

  // A later timestamp never pushes it forward.
  await applyRambleCell(db, "insert", { cell: "9vk79ed", first_unlocked_at: 9000 }, 30);
  assert.equal(Number((await rowsOf(db, "SELECT * FROM ramble_cells"))[0].first_unlocked_at), 1000);

  // Unlocking is permanent: a delete envelope must not remove it.
  await applyRambleCell(db, "delete", { cell: "9vk79ed" }, 40);
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_cells")).length, 1, "unlocks are permanent");

  await applyRambleCell(db, "insert", { first_unlocked_at: 1 }, 50); // no cell
  await applyRambleCell(db, "insert", null, 60);
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_cells")).length, 1, "junk is ignored, never thrown");
});

test("applyRambleWallet: a ledger row is written once and never mutated or deleted", async () => {
  const db = await freshDb();
  await applyRambleWallet(db, "insert", { kind: "seed", key: "9vk79ed:1", delta: 1, created_at: 100 }, 10);
  await applyRambleWallet(db, "insert", { kind: "seed", key: "9vk79ed:1", delta: 99, created_at: 200 }, 20);
  const rows = await rowsOf(db, "SELECT * FROM ramble_wallet");
  assert.equal(rows.length, 1, "the natural key deduplicates");
  assert.equal(Number(rows[0].delta), 1, "a replay never rewrites the fact");
  assert.equal(Number(rows[0].created_at), 100);

  await applyRambleWallet(db, "delete", { kind: "seed", key: "9vk79ed:1" }, 30);
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_wallet")).length, 1, "ledger rows are never deleted");

  await applyRambleWallet(db, "insert", { kind: "seed", delta: 1 }, 40); // no key
  await applyRambleWallet(db, "insert", { key: "x", delta: 1 }, 50);     // no kind
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_wallet")).length, 1);
});

test("two instances converge on the union, in either arrival order", async () => {
  const a = await freshDb();
  const b = await freshDb();
  const events = [
    ["insert", { cell: "9vk79e0", first_unlocked_at: 100 }, 1],
    ["insert", { cell: "9vk79e1", first_unlocked_at: 200 }, 2],
    ["insert", { cell: "9vk79e0", first_unlocked_at: 50 }, 3],
  ];
  for (const [op, row, ts] of events) await applyRambleCell(a, op, row, ts);
  for (const [op, row, ts] of [...events].reverse()) await applyRambleCell(b, op, row, ts);
  const read = async (db) => (await db.execute("SELECT cell, first_unlocked_at FROM ramble_cells ORDER BY cell")).rows
    .map((r) => [r.cell, Number(r.first_unlocked_at)]);
  assert.deepEqual(await read(a), await read(b), "order of arrival does not matter");
  assert.deepEqual(await read(a), [["9vk79e0", 50], ["9vk79e1", 200]]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs tests/ramble-cells-sync.test.js
```
Expected: FAIL — `applyRambleCell` and `applyRambleWallet` are not exported, and the tables do not exist.

- [ ] **Step 3: Add the tables**

In `bundles/ramble/server/init-tables.js`, after the `ramble_credits` block, add:

```js
  // Phase 1 of the reward economy (spec 2026-09-08 §2, §6.2): one row per cell
  // the user has physically stood in. An unlock is an immutable, permanent
  // fact, so this table is append-only — the sync handler keeps the EARLIEST
  // first_unlocked_at and honours no deletes. ⚠ PRIVACY (spec §2.4): this is a
  // precise record of everywhere the user has been. It replicates to their OWN
  // instances and must never appear in any contact-facing payload.
  await initTable(db, "ramble_cells", `
    CREATE TABLE IF NOT EXISTS ramble_cells (
      cell TEXT PRIMARY KEY,
      first_unlocked_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );`);

  // The currency ledger (spec §6.1). Balances are NEVER stored as balances: two
  // instances each writing a running total would lose increments to
  // last-writer-wins, so every earn and spend is a row under a natural
  // idempotent key and the total is derived. Append-only, like ramble_cells.
  await initTable(db, "ramble_wallet", `
    CREATE TABLE IF NOT EXISTS ramble_wallet (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      delta INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (kind, key)
    );`);
```

- [ ] **Step 4: Add the two apply handlers**

In `servers/sharing/instance-sync.js`, after `applyRambleBlock`, add:

```js
/**
 * Apply a `ramble_cells` mutation, keyed on `cell`. NOT last-writer-wins: an
 * unlock is an immutable fact, so this is insert-if-absent and the EARLIEST
 * first_unlocked_at wins — if two instances both recorded the visit, the
 * earlier one is the truth. Deletes are ignored outright: unlocking a cell is
 * permanent (spec 2026-09-08 §2.1), so no envelope may take it away.
 */
export async function applyRambleCell(db, op, row, lamportTs) {
  if (!row || !row.cell) return;
  if (op === "delete") return;
  const at = Number(row.first_unlocked_at);
  if (!Number.isFinite(at)) return;
  await db.execute({
    sql: `INSERT INTO ramble_cells (cell, first_unlocked_at, lamport_ts) VALUES (?, ?, ?)
          ON CONFLICT(cell) DO UPDATE SET
            first_unlocked_at = MIN(ramble_cells.first_unlocked_at, excluded.first_unlocked_at),
            lamport_ts = MAX(ramble_cells.lamport_ts, excluded.lamport_ts)`,
    args: [String(row.cell), at, lamportTs],
  });
}

/**
 * Apply a `ramble_wallet` mutation, keyed on (kind, key). A ledger row is an
 * immutable fact under an idempotent key, so a replay must NOT rewrite it and
 * a delete must not remove it — that is exactly what makes the derived balance
 * converge no matter what order rows arrive in (spec 2026-09-08 §6.1).
 */
export async function applyRambleWallet(db, op, row, lamportTs) {
  if (!row || !row.kind || !row.key) return;
  if (op === "delete") return;
  const delta = Number(row.delta);
  if (!Number.isFinite(delta)) return;
  await db.execute({
    sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at, lamport_ts) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(kind, key) DO NOTHING`,
    args: [String(row.kind), String(row.key), delta, Number(row.created_at) || Date.now(), lamportTs],
  });
}
```

- [ ] **Step 5: Register both tables in the four places**

1. In the replicated-table list (near the `"ramble_trades"` entry), add `"ramble_cells"` and `"ramble_wallet"` with a comment:

```js
  // Phase 1 of the reward economy: the unlocked-cell map and the currency
  // ledger follow the user, so the map built on a phone shows on their other
  // machines. Both are append-only (see applyRambleCell / applyRambleWallet).
  "ramble_cells",
  "ramble_wallet",
```

2. In `EXCLUDED_COLUMNS`, beside `ramble_trades`:

```js
  ramble_cells: ["lamport_ts"],
  ramble_wallet: ["lamport_ts"],
```

3. In the `switch` that dispatches by table name (beside `case "ramble_blocks":`):

```js
    case "ramble_cells":    return applyRambleCell(db, op, row, lamportTs);
    case "ramble_wallet":   return applyRambleWallet(db, op, row, lamportTs);
```

4. In the second dispatch chain (the one that calls `applyRambleBlock(this.db, op, row, lamport_ts)`), add the matching branches in the same shape.

**Grep for `applyRambleBlock` before you finish and confirm you have handled BOTH dispatch sites** — there are two, and missing the second means the table replicates outbound but never applies inbound.

- [ ] **Step 6: Run the test and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-cells-sync.test.js tests/ramble-flock.test.js tests/instance-sync-ramble.test.js
```
Expected: PASS. (If `tests/instance-sync-ramble.test.js` does not exist under that name, run the ramble sync tests you find with `ls tests | grep -i ramble` and say which you ran.)

- [ ] **Step 7: Commit**

```bash
git add tests/ramble-cells-sync.test.js
git commit bundles/ramble/server/init-tables.js servers/sharing/instance-sync.js tests/ramble-cells-sync.test.js -m "ramble: the unlocked-cell map and the currency ledger, append-only and replicated"
```

---

## Task 2: `zones.js`, the pure classifier

**Files:**
- Create: `bundles/ramble/server/zones.js`, `tests/ramble-zones.test.js`

**Interfaces:**
- Consumes: `CELL7_RE`, `CELL7_LAT_STEP`, `CELL7_LON_STEP`, `cellsInBbox`, `MAX_NEST_CELLS` from `./nests.js`; `encodeGeohash`, `decodeGeohash` from `./anchors.js`.
- Produces: `FRONTIER_DEPTH_DEFAULT = 3`; `neighborhood(cell, depth) → string[]`; `classifyCell(cell, unlocked, depth) → "unlocked" | "frontier" | "fog"`; `cellBox(cell) → { cell, south, west, north, east } | null`; `classifyBbox(bbox, unlocked, { depth, max }) → { unlocked: CellBox[], frontier: CellBox[] } | null`. The lists carry FOOTPRINTS, not bare cell names, because the only consumer is the map and shipping bounds means the client never needs a geohash decoder.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-zones.test.js`:

```js
/**
 * Spec 2026-09-08 §2.1-§2.2: three zones. A cell you stood in is UNLOCKED
 * forever; a cell within `frontier.depth` of one is FRONTIER (previewed, not
 * owned); everything else is FOG. Pure — no database, no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { neighborhood, classifyCell, classifyBbox, cellBox, FRONTIER_DEPTH_DEFAULT } from "../bundles/ramble/server/zones.js";
import { CELL7_RE } from "../bundles/ramble/server/nests.js";
import { encodeGeohash, decodeGeohash } from "../bundles/ramble/server/anchors.js";

const HOME = "9vk79ed";

test("neighborhood: a square ring of real geohash-7 cells, excluding the centre", () => {
  assert.equal(FRONTIER_DEPTH_DEFAULT, 3);
  const d1 = neighborhood(HOME, 1);
  assert.equal(d1.length, 8, "depth 1 is the eight surrounding cells");
  assert.ok(!d1.includes(HOME), "the centre is not its own neighbour");
  for (const c of d1) assert.match(c, CELL7_RE, `${c} is a valid cell`);
  assert.equal(new Set(d1).size, d1.length, "no duplicates");

  assert.equal(neighborhood(HOME, 3).length, 48, "depth 3 is 7x7 minus the centre");
  assert.deepEqual(neighborhood(HOME, 0), [], "depth 0 has no frontier");
  assert.deepEqual(neighborhood("nope", 1), [], "a non-cell yields nothing");
  assert.deepEqual(neighborhood(null, 1), []);

  // The immediate neighbours really are adjacent on the ground.
  const here = decodeGeohash(HOME);
  for (const c of d1) {
    const there = decodeGeohash(c);
    assert.ok(Math.abs(there.lat - here.lat) < 0.01 && Math.abs(there.lon - here.lon) < 0.01,
      `${c} is next door, not across the world`);
  }
});

test("classifyCell: unlocked beats frontier beats fog", () => {
  const unlocked = new Set([HOME]);
  assert.equal(classifyCell(HOME, unlocked, 3), "unlocked");
  const near = neighborhood(HOME, 1)[0];
  assert.equal(classifyCell(near, unlocked, 3), "frontier");
  assert.equal(classifyCell(near, unlocked, 0), "fog", "depth 0 makes everything but home fog");
  assert.equal(classifyCell(encodeGeohash(0, 0, 7), unlocked, 3), "fog", "the other side of the planet");
  assert.equal(classifyCell(HOME, new Set(), 3), "fog", "nothing unlocked, nothing previewed");
  assert.equal(classifyCell("nope", unlocked, 3), "fog");
});

test("classifyBbox: returns the unlocked and frontier cells inside a viewport, and nothing else", () => {
  const here = decodeGeohash(HOME);
  const bbox = { south: here.lat - 0.01, west: here.lon - 0.01, north: here.lat + 0.01, east: here.lon + 0.01 };
  const out = classifyBbox(bbox, new Set([HOME]), { depth: 1 });
  assert.ok(out, "a small bbox is answerable");
  assert.deepEqual(out.unlocked.map((c) => c.cell), [HOME]);
  assert.equal(out.frontier.length, 8);
  assert.ok(!out.frontier.some((c) => c.cell === HOME), "a cell is never in both lists");
  for (const c of out.frontier) {
    assert.match(c.cell, CELL7_RE);
    // Every entry carries its footprint, so the client needs no geohash code.
    assert.ok(c.south < c.north && c.west < c.east, `${c.cell} has real bounds`);
  }
  const home = out.unlocked[0];
  assert.ok(home.south <= here.lat && here.lat <= home.north, "home's box contains home");
  assert.ok(home.west <= here.lon && here.lon <= home.east);

  assert.deepEqual(classifyBbox(bbox, new Set(), { depth: 3 }), { unlocked: [], frontier: [] },
    "no unlocked ground means no zones at all");
  assert.equal(cellBox("nope"), null);

  const world = { south: -80, west: -170, north: 80, east: 170 };
  assert.equal(classifyBbox(world, new Set([HOME]), { depth: 1 }), null, "too large to answer");
});

test("classifyBbox only reports cells inside the viewport", () => {
  const here = decodeGeohash(HOME);
  // A viewport shifted well east of home: home is unlocked but off-screen.
  const bbox = { south: here.lat - 0.002, west: here.lon + 0.05, north: here.lat + 0.002, east: here.lon + 0.06 };
  const out = classifyBbox(bbox, new Set([HOME]), { depth: 3 });
  assert.deepEqual(out, { unlocked: [], frontier: [] }, "off-screen unlocked ground is not reported");
});
```

- [ ] **Step 2: Run it and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-zones.test.js
```
Expected: FAIL — `bundles/ramble/server/zones.js` does not exist.

- [ ] **Step 3: Write `zones.js`**

```js
/**
 * Ramble map zones (spec 2026-09-08 §2.1-§2.2).
 *
 *   unlocked — a cell the user physically stood in. Permanent, full detail.
 *   frontier — within `depth` cells of an unlocked one. A rolling PREVIEW that
 *              carries typed beacons only; it is never itself earned, because
 *              a persisting preview would retreat the fog faster than the user
 *              walks.
 *   fog      — everything else.
 *
 * Pure: no database, no clock, no I/O. Classification is always scoped to a
 * viewport, so cost is bounded by the bbox rather than by how much ground the
 * user has covered over the years.
 */
import { CELL7_RE, CELL7_LAT_STEP, CELL7_LON_STEP, cellsInBbox, MAX_NEST_CELLS } from "./nests.js";
import { encodeGeohash, decodeGeohash } from "./anchors.js";

export const FRONTIER_DEPTH_DEFAULT = 3;

/** The square ring of cells within `depth` of `cell`, centre excluded. [] for junk. */
export function neighborhood(cell, depth = FRONTIER_DEPTH_DEFAULT) {
  const d = Number.isInteger(depth) && depth > 0 ? depth : 0;
  if (d === 0 || typeof cell !== "string" || !CELL7_RE.test(cell)) return [];
  let centre;
  try { centre = decodeGeohash(cell); } catch { return []; }
  if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return [];
  const out = new Set();
  for (let dy = -d; dy <= d; dy++) {
    for (let dx = -d; dx <= d; dx++) {
      if (dx === 0 && dy === 0) continue;
      const lat = centre.lat + dy * CELL7_LAT_STEP;
      const lon = centre.lon + dx * CELL7_LON_STEP;
      if (lat > 90 || lat < -90) continue;              // no wrapping over the poles
      const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
      let c;
      try { c = encodeGeohash(lat, wrapped, 7); } catch { continue; }
      if (c !== cell && CELL7_RE.test(c)) out.add(c);
    }
  }
  return [...out];
}

/** "unlocked" | "frontier" | "fog" for one cell against the unlocked set. */
export function classifyCell(cell, unlocked, depth = FRONTIER_DEPTH_DEFAULT) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return "fog";
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  if (set.has(cell)) return "unlocked";
  for (const n of neighborhood(cell, depth)) if (set.has(n)) return "frontier";
  return "fog";
}

/** A cell's footprint, so the client never needs a geohash decoder. null for junk. */
export function cellBox(cell) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return null;
  let c;
  try { c = decodeGeohash(cell); } catch { return null; }
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  const halfLat = CELL7_LAT_STEP / 2, halfLon = CELL7_LON_STEP / 2;
  return { cell, south: c.lat - halfLat, west: c.lon - halfLon, north: c.lat + halfLat, east: c.lon + halfLon };
}

/**
 * Classify every cell in a viewport. Returns null when the bbox covers more
 * cells than we will compute (the same ceiling nests use), so the caller can
 * answer "zoom in" rather than melt. Fog is implicit: a cell in neither list.
 * Entries are footprints (see cellBox), which is what the map draws.
 */
export function classifyBbox(bbox, unlocked, { depth = FRONTIER_DEPTH_DEFAULT, max = MAX_NEST_CELLS } = {}) {
  const cells = cellsInBbox(bbox, { max });
  if (!cells) return null;
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  const out = { unlocked: [], frontier: [] };
  if (set.size === 0) return out;
  for (const cell of cells) {
    const zone = classifyCell(cell, set, depth);
    if (zone === "fog") continue;
    const box = cellBox(cell);
    if (!box) continue;
    if (zone === "unlocked") out.unlocked.push(box);
    else out.frontier.push(box);
  }
  return out;
}
```

- [ ] **Step 4: Run it and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-zones.test.js tests/ramble-nests.test.js
```
Expected: PASS. If `neighborhood` at depth 1 returns fewer than 8, the step constants are being applied to the wrong axis — `CELL7_LAT_STEP` moves north/south, `CELL7_LON_STEP` east/west.

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/zones.js tests/ramble-zones.test.js
git commit bundles/ramble/server/zones.js tests/ramble-zones.test.js -m "ramble: zones — classify a cell as unlocked, frontier or fog"
```

---

## Task 3: recording an unlock, and the zones endpoint

**Files:**
- Create: `bundles/ramble/server/cells.js`, `tests/ramble-cells.test.js`
- Modify: `bundles/ramble/panel/routes.js`

**Interfaces:**
- Consumes: `classifyBbox` (Task 2); the `ramble_cells` table (Task 1).
- Produces: `recordUnlock(db, cell, now) → { unlocked: boolean, cell: string|null }` (`unlocked` true only on the FIRST time); `unlockedCells(db) → Set<string>`; `GET /api/ramble/zones?bbox=s,w,n,e → { unlocked: string[], frontier: string[], depth: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-cells.test.js`:

```js
/**
 * Spec 2026-09-08 §2.1: a cell unlocks from a REAL position fix and stays
 * unlocked forever. recordUnlock reports whether this was the first time, so
 * the route can fire the unlock animation exactly once per cell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { recordUnlock, unlockedCells } from "../bundles/ramble/server/cells.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

test("recordUnlock: first visit unlocks, later visits do not, and the timestamp never moves", async () => {
  const db = await freshDb();
  assert.deepEqual(await recordUnlock(db, "9vk79ed", 1000), { unlocked: true, cell: "9vk79ed" });
  assert.deepEqual(await recordUnlock(db, "9vk79ed", 2000), { unlocked: false, cell: "9vk79ed" });
  const rows = (await db.execute("SELECT * FROM ramble_cells")).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].first_unlocked_at), 1000, "the first arrival is the one recorded");
});

test("recordUnlock: junk is refused without throwing and writes nothing", async () => {
  const db = await freshDb();
  for (const bad of ["nope", "", null, undefined, 7, "9vk79edX", "9vk79e"]) {
    assert.deepEqual(await recordUnlock(db, bad, 1000), { unlocked: false, cell: null }, String(bad));
  }
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows[0].n, 0);
  assert.deepEqual(await recordUnlock(null, "9vk79ed", 1), { unlocked: false, cell: null }, "no db, no throw");
});

test("unlockedCells: the whole set, as a Set, empty on a database with no ramble tables", async () => {
  const db = await freshDb();
  await recordUnlock(db, "9vk79ed", 1);
  await recordUnlock(db, "9vk79ee", 2);
  const set = await unlockedCells(db);
  assert.ok(set instanceof Set);
  assert.deepEqual([...set].sort(), ["9vk79ed", "9vk79ee"]);
  const bare = createClient({ url: "file::memory:" });
  assert.deepEqual([...(await unlockedCells(bare))], [], "no table, no throw, empty set");
});
```

- [ ] **Step 2: Run it and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-cells.test.js
```
Expected: FAIL — `bundles/ramble/server/cells.js` does not exist.

- [ ] **Step 3: Write `cells.js`**

```js
/**
 * The unlocked-cell map (spec 2026-09-08 §2.1, §2.4).
 *
 * A cell unlocks the first time the user is physically inside it and stays
 * unlocked forever. ⚠ PRIVACY: this set is a precise, permanent record of
 * everywhere the user has been. It replicates to their OWN instances only and
 * must never appear in a contact-facing payload.
 */
import { CELL7_RE } from "./nests.js";

/** Record a visit. `unlocked` is true ONLY the first time, so the caller can celebrate once. */
export async function recordUnlock(db, cell, now = Date.now()) {
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return { unlocked: false, cell: null };
  try {
    const res = await db.execute({
      sql: `INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING`,
      args: [cell, Number(now) || Date.now()],
    });
    return { unlocked: Number(res.rowsAffected) > 0, cell };
  } catch (err) {
    try { console.warn("[ramble] recordUnlock failed:", err?.message); } catch {}
    return { unlocked: false, cell: null };
  }
}

/** Every unlocked cell, as a Set. Empty (never throws) when the table is absent. */
export async function unlockedCells(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT cell FROM ramble_cells", args: [] });
    return new Set((rows || []).map((r) => String(r.cell)));
  } catch { return new Set(); }
}
```

- [ ] **Step 4: Wire the unlock into the area route, and add the zones endpoint**

In `bundles/ramble/panel/routes.js`, add `bundleImport("server/zones.js")` and `bundleImport("server/cells.js")` to the module-loading block alongside `bundleImport("server/nests.js")`, add `zonesMod` and `cellsMod` to the destructured list, to the `if (!... )` guard, and to the `mods = { ... }` object. Follow the shape already there exactly.

Then in `POST /api/ramble/area`, replace the `if (here) { ... }` block with:

```js
    let unlockedNow = null;
    if (here) {
      // Geohash-7 (spec §2.1) — the credit key's period is the ISO week, so
      // the same real place only ever counts once a week no matter how many
      // times the panel posts its position.
      const cell = mods.anchorsMod.encodeGeohash(here.lat, here.lon, 7);
      await feedActivity({ type: "visit_place", cell });
      // 2026-09-08 §2.1: standing in a cell unlocks it, permanently. Reported
      // back only on the FIRST unlock so the panel celebrates once, not on
      // every position post.
      const out = await mods.cellsMod.recordUnlock(db, cell, Date.now());
      if (out.unlocked) unlockedNow = out.cell;
    }

    poke("ramble:area");
    res.json({ cells, ...(unlockedNow ? { unlocked: unlockedNow } : {}) });
```

(Delete the old `poke("ramble:area"); res.json({ cells });` lines that followed the block — they are replaced above.)

Then, directly after the `GET /api/ramble/nests` route, add:

```js
  // The map's fog (spec 2026-09-08 §2.1). Same bbox contract as /nests: the
  // server owns all geohash maths so the client needs none. Fog is implicit —
  // a cell in neither list is fogged.
  router.get("/api/ramble/zones", handle(async (req, res) => {
    const raw = req.query?.bbox;
    if (typeof raw !== "string") bad("bbox=south,west,north,east is required");
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || !parts.every(Number.isFinite)) bad("bbox must be four numbers: south,west,north,east");
    const bbox = { south: requireLat(parts[0]), west: requireLon(parts[1]), north: requireLat(parts[2]), east: requireLon(parts[3]) };
    if (bbox.south > bbox.north || bbox.west > bbox.east) bad("bbox must have south <= north and west <= east");
    const depth = await mods.zonesMod.frontierDepth(db);
    const out = mods.zonesMod.classifyBbox(bbox, await mods.cellsMod.unlockedCells(db), { depth });
    if (!out) bad("bbox too large — zoom in");
    res.json({ ...out, depth });
  }));
```

And add `frontierDepth` to `zones.js`, which needs the live setting:

```js
/** The live `frontier.depth` setting (spec §6.4), default 3, floor 0. */
export async function frontierDepth(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = 'frontier.depth'", args: [] });
    const n = parseInt(rows?.[0]?.value, 10);
    return Number.isInteger(n) && n >= 0 ? n : FRONTIER_DEPTH_DEFAULT;
  } catch { return FRONTIER_DEPTH_DEFAULT; }
}
```

- [ ] **Step 5: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-cells.test.js tests/ramble-zones.test.js tests/ramble-panel.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bundles/ramble/server/cells.js tests/ramble-cells.test.js
git commit bundles/ramble/server/cells.js bundles/ramble/server/zones.js bundles/ramble/panel/routes.js tests/ramble-cells.test.js -m "ramble: unlock a cell on a real fix, and serve the map's zones"
```

---

## Task 4: gate public content by zone

**Files:**
- Modify: `bundles/ramble/panel/routes.js` (`annotateMarks` and the nests route)
- Create: `tests/ramble-map-gating.test.js`

**Interfaces:**
- Consumes: `classifyCell`, `frontierDepth` (Task 2), `unlockedCells` (Task 3), `encodeGeohash`.
- Produces: `gateForZones(rows, { unlocked, depth, encode })` in `zones.js` — returns rows with public frontier entries reduced to typed beacons and public fog entries removed; non-public rows pass through untouched.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-map-gating.test.js`:

```js
/**
 * Spec 2026-09-08 §2.1 + D4/D5: fog gates the PUBLIC overlay only. A public
 * mark in fog is absent; in the frontier it is a TYPED BEACON with no content;
 * in unlocked ground it is whole. A contact's or the user's own mark is never
 * gated, in any zone, because contacts are geographically spread and requiring
 * a visit to their area would be impractical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateForZones } from "../bundles/ramble/server/zones.js";
import { encodeGeohash, decodeGeohash } from "../bundles/ramble/server/anchors.js";
import { neighborhood } from "../bundles/ramble/server/zones.js";

const HOME = "9vk79ed";
const at = (cell) => decodeGeohash(cell);
const NEAR = neighborhood(HOME, 1)[0];
const FAR = encodeGeohash(0, 0, 7);

function mark(cell, extra = {}) {
  const p = at(cell);
  return { mark_id: "m-" + cell, kind: "mark", origin: "remote", lat: p.lat, lon: p.lon,
    text: "secret words", author: "f".repeat(64), author_name: "Stranger", ...extra };
}
const gate = (rows) => gateForZones(rows, { unlocked: new Set([HOME]), depth: 1, encode: encodeGeohash });

test("a PUBLIC mark: whole when unlocked, a typed beacon in the frontier, gone in fog", () => {
  const out = gate([mark(HOME), mark(NEAR), mark(FAR)]);
  assert.equal(out.length, 2, "the fogged mark is not sent at all");

  const [home, near] = out;
  assert.equal(home.text, "secret words", "unlocked ground is unchanged");
  assert.equal(home.mark_id, "m-" + HOME);

  assert.equal(near.beacon, true, "the frontier entry is flagged as a beacon");
  assert.equal(near.kind, "mark", "typed — you can tell a mark from a nest");
  assert.ok(Number.isFinite(near.lat) && Number.isFinite(near.lon), "it has somewhere to draw");
  for (const leak of ["text", "author", "author_name", "mark_id", "contact_name", "contact_avatar", "bird"]) {
    assert.ok(!(leak in near), `a beacon must not carry ${leak}`);
  }
});

test("a caw in the frontier is typed as a caw, not flattened into a mark", () => {
  const [beacon] = gate([mark(NEAR, { kind: "caw" })]);
  assert.equal(beacon.kind, "caw");
  assert.equal(beacon.beacon, true);
});

test("the user's own and a contact's marks are NEVER gated, in any zone", () => {
  const mine = gate([mark(FAR, { origin: "local" }), mark(FAR, { origin: "sync" })]);
  assert.equal(mine.length, 2, "own marks survive fog");
  assert.ok(mine.every((m) => m.text === "secret words" && !m.beacon));

  const contact = gate([mark(FAR, { contact_name: "Dayane" })]);
  assert.equal(contact.length, 1, "a contact's mark survives fog");
  assert.equal(contact[0].text, "secret words");
  assert.ok(!contact[0].beacon);
});

test("with nothing unlocked, every public mark is fogged and nothing throws", () => {
  const out = gateForZones([mark(HOME), mark(FAR)], { unlocked: new Set(), depth: 3, encode: encodeGeohash });
  assert.deepEqual(out, []);
  assert.deepEqual(gateForZones(null, { unlocked: new Set([HOME]), depth: 1, encode: encodeGeohash }), []);
});

test("a row without usable coordinates is dropped rather than mis-zoned", () => {
  const out = gate([{ mark_id: "x", kind: "mark", origin: "remote", lat: null, lon: null, text: "hi" }]);
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run it and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-map-gating.test.js
```
Expected: FAIL — `gateForZones` is not exported from `zones.js`.

- [ ] **Step 3: Add `gateForZones` to `zones.js`**

```js
/**
 * Fog the PUBLIC overlay (spec 2026-09-08 §2.1, D4, D5).
 *
 * Only a stranger's public mark is gated. The user's own rows (origin local or
 * sync) and anything a contact sent (contact_name set by the route) pass
 * through whole in every zone: contacts are geographically spread, and making
 * a friend's mark depend on visiting their neighbourhood would be absurd.
 *
 * A frontier row is rebuilt from scratch rather than deleted from, so a field
 * added upstream later cannot silently start leaking through a beacon.
 */
const BEACON_KINDS = new Set(["mark", "caw", "nest"]);

export function gateForZones(rows, { unlocked, depth = FRONTIER_DEPTH_DEFAULT, encode } = {}) {
  if (!Array.isArray(rows) || typeof encode !== "function") return [];
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  const out = [];
  for (const row of rows) {
    const isPublic = row && row.origin === "remote" && !row.contact_name;
    if (!isPublic) { if (row) out.push(row); continue; }

    const lat = Number(row.lat ?? row.approx_lat);
    const lon = Number(row.lon ?? row.approx_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    let cell;
    try { cell = encode(lat, lon, 7); } catch { continue; }
    const zone = classifyCell(cell, set, depth);
    if (zone === "unlocked") { out.push(row); continue; }
    if (zone !== "frontier") continue;

    out.push({
      beacon: true,
      kind: BEACON_KINDS.has(row.kind) ? row.kind : "mark",
      lat,
      lon,
    });
  }
  return out;
}
```

- [ ] **Step 4: Apply the gate in the routes**

In `bundles/ramble/panel/routes.js`, `annotateMarks` becomes:

```js
  async function annotateMarks(marks) {
    const byPubkey = await mods.deliveryMod.contactsByPubkey(db);
    const named = marks.map(withApproxAnchor).map((m) => {
      const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
      // 2026-09-08 §4.5: a contact's pin carries their picture beside their name.
      return c ? { ...m, contact_name: c.name, ...(c.avatar ? { contact_avatar: c.avatar } : {}) } : m;
    });
    // 2026-09-08 §2.1: fog the PUBLIC overlay. Runs AFTER contact naming, so a
    // contact's mark is already marked as theirs and passes through untouched.
    const depth = await mods.zonesMod.frontierDepth(db);
    return mods.zonesMod.gateForZones(named, {
      unlocked: await mods.cellsMod.unlockedCells(db),
      depth,
      encode: mods.anchorsMod.encodeGeohash,
    });
  }
```

And in the `GET /api/ramble/nests` route, gate the nest list the same way, replacing `res.json(out);` with:

```js
    // Nests are public terrain, so they fog like public marks: whole in
    // unlocked ground, a typed beacon in the frontier, absent in fog.
    const depth = await mods.zonesMod.frontierDepth(db);
    const unlocked = await mods.cellsMod.unlockedCells(db);
    const gated = mods.zonesMod.gateForZones(
      (out.nests || []).map((n) => ({ ...n, kind: "nest", origin: "remote" })),
      { unlocked, depth, encode: mods.anchorsMod.encodeGeohash },
    );
    res.json({ ...out, nests: gated });
```

- [ ] **Step 5: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-map-gating.test.js tests/ramble-panel.test.js tests/ramble-flock.test.js tests/ramble-delivery.test.js
```
Expected: PASS. Existing panel tests that assert a public mark's `text` will need a seeded unlocked cell for that mark's position — if one fails, unlock the cell in that test's setup rather than weakening the assertion, and say which you changed.

- [ ] **Step 6: Commit**

```bash
git add tests/ramble-map-gating.test.js
git commit bundles/ramble/server/zones.js bundles/ramble/panel/routes.js tests/ramble-map-gating.test.js -m "ramble: fog the public overlay — beacons in the frontier, nothing in fog"
```

---

## Task 5: bird seed

**Files:**
- Create: `bundles/ramble/server/wallet.js`, `tests/ramble-wallet.test.js`
- Modify: `bundles/ramble/panel/routes.js`

**Interfaces:**
- Consumes: the `ramble_wallet` table (Task 1); `recordUnlock`'s cell (Task 3).
- Produces: `SEED_KIND = "seed"`; `harvestWindow(now, hours) → number`; `readWalletSettings(db) → { respawnHours, perPickup }`; `recordSeedPickup(db, cell, now) → { picked: boolean, amount: number }`; `seedBalance(db) → number`. `POST /api/ramble/area` reports `seed` in its response.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-wallet.test.js`:

```js
/**
 * Spec 2026-09-08 §6.1: bird seed is a LEDGER, never a stored balance. A
 * pickup is keyed by cell and window, so re-posting the same position inside
 * one window is free and a replay from another instance collapses into the
 * same row. The balance is derived by summing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { recordSeedPickup, seedBalance, harvestWindow, readWalletSettings, SEED_KIND } from "../bundles/ramble/server/wallet.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
const HOUR = 3600 * 1000;

test("harvestWindow: the same window inside the period, the next one after it", () => {
  assert.equal(harvestWindow(0, 24), 0);
  assert.equal(harvestWindow(23 * HOUR, 24), 0);
  assert.equal(harvestWindow(24 * HOUR, 24), 1);
  assert.equal(harvestWindow(49 * HOUR, 24), 2);
  assert.equal(harvestWindow(3 * HOUR, 1), 3, "a shorter period makes more windows");
});

test("readWalletSettings: defaults, live overrides, and junk falling back", async () => {
  const db = await freshDb();
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 24, perPickup: 1 });
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.respawn.hours', '6'), ('seed.per.pickup', '3')");
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 6, perPickup: 3 });
  await db.execute("UPDATE ramble_settings SET value = 'banana' WHERE key = 'seed.respawn.hours'");
  await db.execute("UPDATE ramble_settings SET value = '-4' WHERE key = 'seed.per.pickup'");
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 24, perPickup: 1 }, "junk and negatives fall back");
});

test("recordSeedPickup: once per cell per window; the balance is the sum of the ledger", async () => {
  const db = await freshDb();
  assert.equal(await seedBalance(db), 0);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", 0), { picked: true, amount: 1 });
  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", HOUR), { picked: false, amount: 0 }, "same window, already taken");
  assert.equal(await seedBalance(db), 1);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ee", HOUR), { picked: true, amount: 1 }, "a different cell is its own patch");
  assert.equal(await seedBalance(db), 2);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", 25 * HOUR), { picked: true, amount: 1 }, "it regrows next window");
  assert.equal(await seedBalance(db), 3);

  const keys = (await db.execute("SELECT kind, key FROM ramble_wallet ORDER BY key")).rows;
  assert.ok(keys.every((r) => r.kind === SEED_KIND));
  assert.deepEqual(keys.map((r) => r.key), ["9vk79ed:0", "9vk79ed:1", "9vk79ee:0"]);
});

test("recordSeedPickup: junk is refused without throwing, and honours seed.per.pickup", async () => {
  const db = await freshDb();
  for (const bad of ["nope", "", null, 7]) {
    assert.deepEqual(await recordSeedPickup(db, bad, 0), { picked: false, amount: 0 }, String(bad));
  }
  assert.equal(await seedBalance(db), 0);
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.per.pickup', '5')");
  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", 0), { picked: true, amount: 5 });
  assert.equal(await seedBalance(db), 5);
  assert.deepEqual(await recordSeedPickup(null, "9vk79ed", 0), { picked: false, amount: 0 }, "no db, no throw");
});

test("seedBalance nets spends against earns, and never throws on a bare database", async () => {
  const db = await freshDb();
  await recordSeedPickup(db, "9vk79ed", 0);
  await recordSeedPickup(db, "9vk79ee", 0);
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [SEED_KIND, "spend:hat-1", -2, 0],
  });
  assert.equal(await seedBalance(db), 0, "two earned, two spent");
  assert.equal(await seedBalance(createClient({ url: "file::memory:" })), 0, "no table, no throw");
});
```

- [ ] **Step 2: Run it and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-wallet.test.js
```
Expected: FAIL — `bundles/ramble/server/wallet.js` does not exist.

- [ ] **Step 3: Write `wallet.js`**

```js
/**
 * The currency ledger (spec 2026-09-08 §6.1).
 *
 * Balances are NEVER stored as balances. Two instances each writing a running
 * total would lose increments to last-writer-wins, so every earn and spend is
 * an append-only row under a natural idempotent key and the total is derived
 * by summing. This is the same trick ramble_credits already uses for warmth —
 * the difference is that this table replicates, because a wallet has to follow
 * the user across their machines.
 *
 * Bird seed grows in ground the user has already unlocked (spec §2.3): walking
 * a familiar route pays, pacing one cell does not, because the key is the cell
 * AND the window.
 */
import { CELL7_RE } from "./nests.js";

export const SEED_KIND = "seed";
const RESPAWN_HOURS_DEFAULT = 24;
const PER_PICKUP_DEFAULT = 1;

/** Which respawn window `now` falls in. Same cell, same window = already harvested. */
export function harvestWindow(now, hours) {
  const h = Number.isFinite(hours) && hours >= 1 ? hours : RESPAWN_HOURS_DEFAULT;
  return Math.floor(Number(now) / (h * 3600 * 1000));
}

/** Live settings (spec §6.4), each falling back on junk or a negative. */
export async function readWalletSettings(db) {
  const out = { respawnHours: RESPAWN_HOURS_DEFAULT, perPickup: PER_PICKUP_DEFAULT };
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM ramble_settings WHERE key IN ('seed.respawn.hours', 'seed.per.pickup')",
      args: [],
    });
    for (const r of rows || []) {
      const n = parseInt(r.value, 10);
      if (r.key === "seed.respawn.hours" && Number.isInteger(n) && n >= 1) out.respawnHours = n;
      if (r.key === "seed.per.pickup" && Number.isInteger(n) && n >= 0) out.perPickup = n;
    }
  } catch { /* defaults */ }
  return out;
}

/** Harvest this cell's seed if it has regrown. `picked` is false when it has not. */
export async function recordSeedPickup(db, cell, now = Date.now()) {
  const none = { picked: false, amount: 0 };
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return none;
  try {
    const { respawnHours, perPickup } = await readWalletSettings(db);
    const key = `${cell}:${harvestWindow(now, respawnHours)}`;
    const res = await db.execute({
      sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, key) DO NOTHING`,
      args: [SEED_KIND, key, perPickup, Number(now) || Date.now()],
    });
    return Number(res.rowsAffected) > 0 ? { picked: true, amount: perPickup } : none;
  } catch (err) {
    try { console.warn("[ramble] seed pickup failed:", err?.message); } catch {}
    return none;
  }
}

/** The derived balance: every earn minus every spend. */
export async function seedBalance(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COALESCE(SUM(delta), 0) AS total FROM ramble_wallet WHERE kind = ?",
      args: [SEED_KIND],
    });
    return Number(rows?.[0]?.total) || 0;
  } catch { return 0; }
}
```

- [ ] **Step 4: Harvest on arrival**

In `bundles/ramble/panel/routes.js`, add `bundleImport("server/wallet.js")` beside the other bundle imports and `walletMod` to the destructure, the guard and the `mods` object, exactly as in Task 3.

Then extend the `if (here)` block in `POST /api/ramble/area` so it reads:

```js
    let unlockedNow = null;
    let seedPicked = 0;
    if (here) {
      const cell = mods.anchorsMod.encodeGeohash(here.lat, here.lon, 7);
      await feedActivity({ type: "visit_place", cell });
      const out = await mods.cellsMod.recordUnlock(db, cell, Date.now());
      if (out.unlocked) unlockedNow = out.cell;
      // 2026-09-08 §2.3: bird seed grows in ground you have already unlocked,
      // so a first arrival unlocks the cell and the NEXT visit starts paying.
      if (!out.unlocked && out.cell) {
        const got = await mods.walletMod.recordSeedPickup(db, cell, Date.now());
        seedPicked = got.amount;
      }
    }

    poke("ramble:area");
    res.json({
      cells,
      ...(unlockedNow ? { unlocked: unlockedNow } : {}),
      ...(seedPicked ? { seed_picked: seedPicked } : {}),
      seed: await mods.walletMod.seedBalance(db),
    });
```

- [ ] **Step 5: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-wallet.test.js tests/ramble-cells.test.js tests/ramble-panel.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bundles/ramble/server/wallet.js tests/ramble-wallet.test.js
git commit bundles/ramble/server/wallet.js bundles/ramble/panel/routes.js tests/ramble-wallet.test.js -m "ramble: bird seed — a replicated ledger, harvested from ground you already walked"
```

---

## Task 6: the map draws the fog

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`
- Test: `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Consumes: `GET /api/ramble/zones` (Task 3); beacon rows from `/marks` and `/around` (Task 4).
- Produces: client functions `refreshZones()`, `drawZones(out)`, `drawBeacon(mark)`; a Leaflet pane `rb-fog` below the marker pane.

- [ ] **Step 1: Write the failing assertions**

In `tests/ramble-panel.test.js`, inside the existing `GET /ramble/static/ramble.js` test, append:

```js
  // Phase 1 of the reward economy (spec 2026-09-08 §2.1): the map draws its
  // three zones. Unlocked ground is clear, the frontier is dimmed and carries
  // typed beacons, fog is opaque. Leaflet layer calls are not markup sinks.
  assert.ok(body.includes("function refreshZones()"));
  assert.ok(body.includes("function drawZones("));
  assert.ok(body.includes("function drawBeacon("));
  assert.ok(body.includes('"/api/ramble/zones?bbox="'), "zones are fetched by bbox like nests");
  assert.ok(body.includes('map.createPane("rb-fog")'), "fog has its own pane");
  assert.ok(body.includes("if (mark.beacon)"), "a beacon is drawn differently from a full mark");
```

And in the existing stylesheet test:

```js
  assert.ok(body.includes("#ramble .rb-fog-cell {"), "fogged cells have a rule");
  assert.ok(body.includes("#ramble .rb-frontier-cell {"), "the frontier is dimmed, not hidden");
  assert.ok(body.includes("#ramble .rb-beacon {"), "beacons have a rule");
```

- [ ] **Step 2: Run and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Add the fog pane and the zone layer**

In `bundles/ramble/panel/static/ramble.js`, beside the other layer declarations (`var nestLayer = null;`), add `var zoneLayer = null;` and `var lastZones = null;`.

Inside the `if (mapEl && typeof L !== "undefined")` block, after the `rb-here` pane is created, add:

```js
    /* Fog sits BELOW Leaflet's marker pane (600) and above the tiles, so a pin
     * is never buried by it. Unlocked ground draws nothing at all — clear map
     * is the reward for having walked there. */
    map.createPane("rb-fog");
    map.getPane("rb-fog").style.zIndex = 450;
    zoneLayer = L.layerGroup().addTo(map);
```

Then, next to `drawNests`, add:

```js
  /* The map's three zones (spec 2026-09-08 section 2.1). The server owns every
   * geohash sum; the client is handed two cell lists and a depth and paints
   * rectangles. Cells the server did not name are fog. */
  function refreshZones() {
    if (!map || !zoneLayer) return Promise.resolve();
    var b = map.getBounds();
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(",");
    return jsonFetch("/api/ramble/zones?bbox=" + encodeURIComponent(bbox))
      .then(drawZones)
      .catch(function () { /* a failed fetch leaves the last painting up */ });
  }

  function drawZones(out) {
    if (!out || !zoneLayer) return;
    lastZones = out;
    zoneLayer.clearLayers();
    paintCells(out.frontier || [], "rb-frontier-cell");
  }

  /* One rectangle per cell. The cell's footprint comes from the server's own
   * list, so the client never needs a geohash encoder. */
  function paintCells(cells, className) {
    for (var i = 0; i < cells.length; i++) {
      var box = cellBounds(cells[i]);
      if (!box) continue;
      L.rectangle(box, { pane: "rb-fog", className: className, stroke: false, interactive: false }).addTo(zoneLayer);
    }
  }
```

`classifyBbox` already returns footprints (Task 2's `cellBox`), so the client draws rectangles straight from the response and needs no geohash code of its own:

```js
  function cellBounds(c) {
    if (!c || !isFinite(c.south) || !isFinite(c.west) || !isFinite(c.north) || !isFinite(c.east)) return null;
    return [[c.south, c.west], [c.north, c.east]];
  }
```

- [ ] **Step 4: Draw beacons, and hook the refresh**

In `drawMarks`, before the existing full-mark branch, add:

```js
      if (mark.beacon) { drawBeacon(mark); continue; }
```

and add:

```js
  /* A frontier beacon: something is there, but not what. The server already
   * stripped every detail; this only says which kind it is. */
  function drawBeacon(mark) {
    var cls = mark.kind === "nest" ? "rb-beacon rb-beacon-nest" : "rb-beacon";
    L.circleMarker([mark.lat, mark.lon], {
      className: cls, radius: 7, weight: 2, fillOpacity: 0.5, interactive: false,
    }).addTo(markerLayer);
  }
```

Call `refreshZones()` wherever `refreshMarks()` is already called on a map move, and once at boot beside the first `refreshMarks()`.

- [ ] **Step 5: Add the styles**

In `bundles/ramble/panel/static/ramble.css`, after the `#ramble .rb-here-dot` rules:

```css
/* --------------------------------------------------------------- map zones */
/* Unlocked ground draws nothing: a clear map is what walking buys you. */
#ramble .rb-frontier-cell { fill: var(--rb-line); fill-opacity: 0.28; }
#ramble .rb-fog-cell { fill: var(--rb-surface-2); fill-opacity: 0.92; }
#ramble .rb-beacon { stroke: var(--rb-line); fill: var(--rb-accent-2); opacity: 0.7; }
#ramble .rb-beacon-nest { fill: var(--rb-accent); }
```

- [ ] **Step 6: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js tests/ramble-zones.test.js
```
Expected: PASS, and `ramble.js` still has zero backticks and exactly two markup sinks. Verify with:

```
grep -c '`' bundles/ramble/panel/static/ramble.js   # expect 0
grep -c "innerHTML\|insertAdjacentHTML\|outerHTML" bundles/ramble/panel/static/ramble.js   # expect 2
```

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css bundles/ramble/server/zones.js tests/ramble-panel.test.js tests/ramble-zones.test.js -m "ramble: the map draws its zones — dimmed frontier, typed beacons, clear unlocked ground"
```

---

## Task 7: the unlock moment, the seed counter, docs and the bump

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`, `bundles/ramble/panel/ramble.js`, `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`
- Test: `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Consumes: `unlocked` and `seed` from the `POST /api/ramble/area` response (Tasks 3 and 5).
- Produces: client `celebrateUnlock(cell)` and `paintSeed(n)`; the element `rb-seed-count` in the map bar.

- [ ] **Step 1: Write the failing assertions**

Append to the served-script test in `tests/ramble-panel.test.js`:

```js
  assert.ok(body.includes("function celebrateUnlock("), "a first unlock is celebrated once");
  assert.ok(body.includes("function paintSeed("), "the seed counter is painted from the area response");
  assert.ok(body.includes("out.unlocked"), "the celebration is driven by the server saying it was the first time");
```

To the stylesheet test:

```js
  assert.ok(body.includes("@keyframes rb-unlock"), "the unlock has an animation");
  assert.ok(body.includes("#ramble .rb-seed {"), "the seed counter has a rule");
```

And to the shell test (the one asserting `id="rb-world-name"`):

```js
  assert.ok(sent.includes('id="rb-seed-count"'), "the map bar carries the seed counter");
```

- [ ] **Step 2: Run and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Add the counter to the shell**

In `bundles/ramble/panel/ramble.js`, inside the `<div class="rb-mapbar">`, after the "Look around" chip:

```html
              <span class="rb-seed" title="Bird seed"><strong id="rb-seed-count">0</strong><span>seed</span></span>
```

- [ ] **Step 4: Celebrate the unlock and paint the counter**

In `bundles/ramble/panel/static/ramble.js`, in the `.then(function (out) { ... })` of the `/api/ramble/area` post, after `currentCells = ...`:

```js
        paintSeed(out && out.seed);
        if (out && out.unlocked) celebrateUnlock(out.unlocked);
```

And add:

```js
  /* A first unlock is a moment: flash the newly-earned ground, then repaint the
   * zones so the fog has actually retreated. The server tells us this was the
   * first time, so it fires once per cell ever, not on every position post. */
  function celebrateUnlock(cell) {
    var say = $("rb-perch-say");
    if (say) say.textContent = "New ground.";
    var el = mapEl && mapEl.querySelector ? mapEl : null;
    if (el) {
      el.classList.remove("rb-unlocking");
      void el.offsetWidth;            /* restart the animation */
      el.classList.add("rb-unlocking");
      setTimeout(function () { el.classList.remove("rb-unlocking"); }, 900);
    }
    refreshZones();
    refreshMarks();
  }

  function paintSeed(n) {
    var el = $("rb-seed-count");
    if (el) el.textContent = String(typeof n === "number" ? n : 0);
  }
```

- [ ] **Step 5: Style the moment**

In `bundles/ramble/panel/static/ramble.css`, beside the other keyframes:

```css
@keyframes rb-unlock {
  0% { box-shadow: inset 0 0 0 0 var(--rb-accent-2); }
  40% { box-shadow: inset 0 0 0 14px var(--rb-accent-2); }
  100% { box-shadow: inset 0 0 0 0 var(--rb-accent-2); }
}
#ramble .rb-map.rb-unlocking, #ramble #rb-map.rb-unlocking { animation: rb-unlock .9s ease-out; }
#ramble .rb-seed {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 11px; border-radius: 999px;
  border: var(--rb-line-w) solid var(--rb-line);
  background: var(--rb-surface); color: var(--rb-text);
  font: 800 13px var(--rb-font-display);
}
```

Add `#ramble .rb-unlocking` to the existing `@media (prefers-reduced-motion: reduce)` block's `animation: none;` list.

- [ ] **Step 6: Docs, both languages**

In `docs/guide/ramble.md`, after the World name paragraph, add one paragraph (no new heading):

```
**The map unlocks as you walk.** Ground you have actually stood in stays unlocked for good: you can read the marks and caws left there and claim any nest. A few blocks further out is the frontier, where you can see that something is waiting without seeing what it is. Everything beyond that is fog until you go there. Only the public map works this way — a contact's mark always reaches you wherever you are. Walking ground you have already unlocked turns up **bird seed**, which regrows after a day.
```

In `docs/es/guide/ramble.md`, the twin, in the same position:

```
**El mapa se desbloquea al caminar.** El terreno donde realmente has estado queda desbloqueado para siempre: puedes leer las marcas y los graznidos que hay allí y reclamar cualquier nido. Unas manzanas más allá está la frontera, donde ves que algo te espera sin ver qué es. Todo lo demás es niebla hasta que vayas. Solo el mapa público funciona así: la marca de un contacto siempre te llega, estés donde estés. Caminar por terreno que ya desbloqueaste hace aparecer **alpiste**, que vuelve a crecer al cabo de un día.
```

- [ ] **Step 7: Bump and rebuild the registry**

```bash
sed -i 's/"version": "0.8.1"/"version": "0.9.0"/' bundles/ramble/manifest.json bundles/ramble/package.json
npm run build-registry
```

- [ ] **Step 8: Run everything**

```
node scripts/run-suite.mjs 2>&1 | tail -12
node scripts/check-port-allocation.js
npm run build-registry -- --check
```
Expected: the full suite green (report the actual numbers; it stood at 4249 before this plan), no port collisions, registry in sync.

- [ ] **Step 9: Commit**

```bash
git commit bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css bundles/ramble/panel/ramble.js docs/guide/ramble.md docs/es/guide/ramble.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json tests/ramble-panel.test.js -m "ramble 0.9.0: the unlock moment, the seed counter, docs en/es"
```

- [ ] **Step 10 (controller, before the PR): the migration dry-run**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
S=$(mktemp -d)
grackle "sqlite3 ~/.crow/data/crow.db '.backup /tmp/g-dryrun.db'" && scp grackle:/tmp/g-dryrun.db "$S/grackle.db" && grackle "rm -f /tmp/g-dryrun.db"
scripts/schema-migration-dryrun.sh crow ~/.crow/data/crow.db r4 ~/.crow-r4/data/crow.db grackle "$S/grackle.db"
```

Expected per database: `user_version` unchanged, integrity ok, no row-count deltas, and the only schema objects added are `table ramble_cells` and `table ramble_wallet`. Anything else is a STOP. Paste the three blocks into the PR body.

---

## Self-review

**Spec coverage.** §2.1 three zones: Tasks 2, 4, 6. §2.2 the frontier making nests findable: Task 2 (depth) plus Task 4 (nests gated, so a frontier nest shows as a beacon). §2.3 seed respawn per cell on a cooldown: Task 5; heart containers are phase 2 and deliberately absent. §2.4 privacy: Task 1's table comment and the constraint that no contact-facing payload carries cells; the gating in Task 4 is what delivers the "cannot survey a city remotely" property. §6.1 ledgers not balances: Tasks 1 and 5. §6.2 new state: Task 1 (cells, wallet); wardrobe, worn items and prologue flags are later phases. §6.3 migration: Task 7 Step 10. §6.4 settings: `frontier.depth` in Task 3, `seed.respawn.hours` and `seed.per.pickup` in Task 5; the rest belong to later phases. §8 testing, multi-instance for replicated state: Task 1's convergence test. §9 phase 1 scope: everything here is additive and removes nothing.

**Placeholder scan.** None. Every step carries the code or the command. Two places name a judgement rather than a literal, and both are deliberate and bounded: Task 1 Step 6 asks the implementer to name the ramble sync test file they ran if the guessed name is wrong, and Task 4 Step 5 asks them to say which existing test they adjusted if a seeded unlock is needed. Both require reporting, not guessing.

**Type consistency.** `recordUnlock` returns `{ unlocked, cell }` in Task 3 and is consumed with exactly those fields in Tasks 3 and 5. `recordSeedPickup` returns `{ picked, amount }` and only `amount` is consumed. `classifyBbox` returns `{ unlocked, frontier }` as arrays of `cellBox` footprints from Task 2 onward, which is exactly what Task 6 draws — an earlier draft had Task 2 return bare cell names and Task 6 change the shape, and that mid-plan interface change was removed in self-review rather than shipped. `gateForZones` takes `{ unlocked, depth, encode }` in both its definition and both call sites. `frontierDepth(db)` is defined in Task 3 and used in Tasks 3 and 4. `SEED_KIND` is defined once and used in the test and the balance query.
