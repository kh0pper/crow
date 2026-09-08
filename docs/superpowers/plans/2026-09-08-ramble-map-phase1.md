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
- **Public overlay only (D4):** zone gating applies ONLY to marks and caws published publicly, and to nests. See the `visibility` rule below for what "public" means here — it is not `origin`.
- **Ruling, narrowing D4:** a mark the user or a contact published with `visibility: "public"` IS gated like any other public mark, even though a contact sent it. D4 says "contact and group marks are unaffected"; that means marks delivered on the contacts channel (`visibility: "contacts"`, which is also what a group mark carries). Something published to the whole world is public terrain regardless of who published it, and treating it otherwise would mean the fog leaks a stranger's mark whenever they happen to be in your contact list.
- **Beacons are typed, never detailed (D5):** a frontier entry carries its kind and a position and nothing else. **Ruling:** that position is the mark's exact coordinates, not a blurred one. D5 withholds content, not location, and the whole point of a beacon is to be somewhere you can walk to. An open public mark's position is already public on the relays. It must never carry `text`, `author`, `author_name`, `contact_name`, `contact_avatar`, `bird` or `mark_id`.
- **Ledgers, not balances (spec §6.1):** every currency event is a row keyed by a natural idempotent key. Never store or update a running total.
- **Replication is EXPLICIT and outbound is not free.** Adding a table to the synced list enables the INBOUND apply only. Nothing replicates outward unless a writer calls `safeEmit(emit, table, op, row)` — that is how every existing Ramble writer works (`eggs.js:35` defines the helper; `marks.js`, `flock.js` and `trades.js` all thread `{ now, emit }`). A plan that registers a table and forgets the emit ships a table that syncs one way and a test that passes green while the feature is broken. Both new writers take `{ now, emit }` and emit after a successful insert.
- **A natural-key table needs FIVE registrations, not four:** the synced-table list, `EXCLUDED_COLUMNS`, `shouldSyncRow`, the two apply dispatch sites in `servers/sharing/instance-sync.js`, AND a branch in `stampSql()` in `servers/shared/sync-stamp.js`. Every id-less Ramble table already has one there (`ramble_settings`, `ramble_blocks`, `ramble_eggs`, `ramble_pet`, `ramble_trades`); without it the local row is never stamped while remote rows are, and nothing catches it.
- **The public/contact discriminator is `visibility`, NOT `origin`.** A contact-delivered mark also lands `origin: "remote"` (`delivery.js:136,144`); only `visibility` separates `'public'` from `'contacts'`, and a group mark is `'contacts'` too. Gating on `origin` alone would fog a friend's mark, contradicting D4. `contact_name` is NOT a safe fallback either: it comes from `contactsByPubkey`, which filters to unblocked full contacts, so a pending, blocked or deleted contact's mark would be misclassified as public.
- **Ruling on the unlock radius.** Spec §1 defines unlocked as a cell entered "within `CLAIM_RANGE_M`, 75 m". This plan unlocks exactly the ONE cell containing the fix, not every cell within 75 m of it. A cell is ~153 m across, so the fix is always inside the cell it unlocks; unlocking neighbours because the user stood near an edge would hand out ground they never crossed.
- **Deviation from spec §6.2, recorded.** The spec puts "seed harvest state" on the unlocked-cell row. This plan keeps it in `ramble_wallet` keyed `cell:window` instead, because §6.1's ledger rule governs: a per-cell harvest column would be a mutable balance-like field and would not replicate correctly. `ramble_cells` therefore holds only the cell and its first-unlocked time.
- **An unlock is permanent and undeletable, so it must be earned by a real fix.** Refuse to unlock when the position fix's accuracy is worse than `unlock.max.accuracy.m` (default 100). Without this a single 2 km wifi fix permanently unlocks a cell the user never entered, and nothing can take it back.
- **Fog really obscures (spec §2.1, D4).** Fogged ground is not merely content-free, it is visually masked. A dim band around walked ground is not fog of war and is not what the spec describes.
- **Phase 1 is PANEL-ONLY, deliberately.** The MCP tool surface (`bundles/ramble/server/server.js` `listMarks`/`listNests`) is NOT gated in this phase. State it in the PR so a reviewer does not read it as an oversight.
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
- `bundles/ramble/server/zones.js` — cell classification. `neighborhood(cell, depth)`, `classifyCell(cell, unlockedSet, depth)`, `cellBox(cell)`, `classifyBbox(bbox, unlockedSet, { depth, max })`, plus `frontierDepth(db)` (reads a setting) and `gateForZones(rows, { unlocked, depth, encode })`. Imports only `nests.js` and `anchors.js`.
- `bundles/ramble/server/wallet.js` — the currency ledger. `SEED_KIND`, `recordSeedPickup`, `seedBalance`, `readWalletSettings`, `harvestWindow`.
- `bundles/ramble/server/cells.js` — `recordUnlock(db, cell, { now, emit, accuracyM })`, `unlockedCells(db)`, `unlockedCellsNear(db, bbox, depth)`, `UNLOCK_MAX_ACCURACY_M_DEFAULT`.
- Tests: `tests/ramble-zones.test.js`, `tests/ramble-cells.test.js`, `tests/ramble-wallet.test.js`, `tests/ramble-map-gating.test.js`, `tests/ramble-cells-sync.test.js`.

**Modify**
- `bundles/ramble/server/init-tables.js` — the two new tables.
- `servers/sharing/instance-sync.js` — register both tables, `EXCLUDED_COLUMNS`, `shouldSyncRow`, an apply handler each, and BOTH dispatch sites.
- `servers/shared/sync-stamp.js` — a `stampSql()` branch per new table (the fifth registration site).
- `bundles/ramble/panel/routes.js` — record the unlock and harvest seed in `POST /api/ramble/area`; gate `/api/ramble/marks`, `/around` and `/nests`; add `GET /api/ramble/zones`.
- `bundles/ramble/panel/static/ramble.js` — the fog mask, beacons, the pet-as-location-marker, the unlock flash, the seed counter.
- `bundles/ramble/panel/static/ramble.css` — fog mask, frontier, beacon, pet-marker and unlock-flash rules; the retired perch rules deleted.
- `bundles/ramble/panel/ramble.js` — the seed counter in the map bar; the corner perch button retired (the status strip stays).
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

- [ ] **Step 5: Register both tables in ALL FIVE places**

⚠ The review of this plan found a **fifth** site that an earlier draft missed. Every id-less Ramble table already has a `stampSql` branch; without one the local row is never stamped while remote rows are, and no test catches it.

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

4. In the second dispatch chain (an `if`-chain, not a switch — the one that calls `applyRambleBlock(this.db, op, row, lamport_ts)` around `_applyEntry`), add the matching branches in the same shape.

5. In `shouldSyncRow`, which has an entry per Ramble table naming its natural key, add the two new tables so they are gated on their keys rather than falling through to a bare `return true`:

```js
  if (table === "ramble_cells") return typeof row?.cell === "string" && row.cell.length > 0;
  if (table === "ramble_wallet") return typeof row?.kind === "string" && typeof row?.key === "string";
```

6. **The fifth site.** In `servers/shared/sync-stamp.js`, `stampSql()` returns the UPDATE that stamps a local row's `lamport_ts`. It keys off `row.id` unless a table has its own branch, and both new tables are id-less. Beside the existing `ramble_pet` branch add:

```js
  // Phase 1 of the reward economy: both new tables are id-less natural-key
  // tables (`cell`, and the pair `kind`+`key`), so without these branches the
  // local row would never be stamped while applyRambleCell/applyRambleWallet
  // write a real lamport to remote ones.
  if (table === "ramble_cells" && row.cell !== undefined) {
    return { sql: `UPDATE ramble_cells SET lamport_ts = ? WHERE cell = ?`, args: [lamportTs, row.cell] };
  }
  if (table === "ramble_wallet" && row.kind !== undefined && row.key !== undefined) {
    return { sql: `UPDATE ramble_wallet SET lamport_ts = ? WHERE kind = ? AND key = ?`, args: [lamportTs, row.kind, row.key] };
  }
```

Match the exact parameter names and return shape of the branches already in that function — read one before writing these. The lamport must be the FIRST placeholder: `subselectStampSql` in `sync-emit.js` rewrites `stampSql`'s first `?` and would bind the wrong column otherwise.

**Before you finish, grep for `applyRambleBlock`, `shouldSyncRow` and `stampSql` and confirm you have touched all five sites.** Missing the second dispatch chain means the table emits outbound but never applies inbound; missing `stampSql` means local rows stay at lamport 0 forever.

- [ ] **Step 6: Run the test and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-cells-sync.test.js tests/ramble-flock.test.js tests/ramble-sync.test.js
```
Expected: PASS. (`tests/ramble-sync.test.js` is the real name — an earlier draft of this plan guessed `instance-sync-ramble.test.js`, which does not exist.)

- [ ] **Step 7: Commit**

```bash
git add tests/ramble-cells-sync.test.js
git commit bundles/ramble/server/init-tables.js servers/sharing/instance-sync.js servers/shared/sync-stamp.js tests/ramble-cells-sync.test.js -m "ramble: the unlocked-cell map and the currency ledger, append-only and replicated"
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

test("classifyBbox expands from the unlocked cells, so a wide viewport stays cheap", () => {
  // The naive direction (ask every viewport cell for its neighbours) measured
  // 61 ms of blocking work here; this asserts the shape that avoids it.
  const here = decodeGeohash(HOME);
  const wide = { south: here.lat - 0.05, west: here.lon - 0.05, north: here.lat + 0.05, east: here.lon + 0.05 };
  const started = Date.now();
  const out = classifyBbox(wide, new Set([HOME]), { depth: 3 });
  assert.ok(out, "a wide-but-legal viewport is answerable");
  assert.equal(out.unlocked.length, 1);
  assert.equal(out.frontier.length, 48, "one unlocked cell yields exactly its 48-cell ring, whatever the viewport");
  assert.ok(Date.now() - started < 250, "classification is bounded by unlocked ground, not viewport size");
});

test("classifyBbox returns null rather than throwing on a malformed bbox", () => {
  assert.equal(classifyBbox({ south: "x", west: 0, north: 1, east: 1 }, new Set([HOME]), { depth: 1 }), null);
  assert.equal(classifyBbox(null, new Set([HOME]), { depth: 1 }), null);
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
 * The classification functions are pure — no database, no clock, no I/O — and
 * always scoped to a viewport, so cost is bounded by the bbox rather than by
 * how much ground the user has covered over the years. Two exports are not
 * pure and say so on the tin: `frontierDepth(db)` reads a setting, and
 * `gateForZones` takes an encoder.
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
  let cells;
  try { cells = cellsInBbox(bbox, { max }); } catch { return null; }   // cellsInBbox THROWS on a malformed bbox
  if (!cells) return null;
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  const out = { unlocked: [], frontier: [] };
  if (set.size === 0) return out;

  // Expand OUTWARD from the unlocked cells once, rather than asking every cell
  // in the viewport who its neighbours are. The naive direction costs
  // |viewport| x (2d+1)^2 — measured at 61 ms of synchronous, event-loop-
  // blocking work for a 7921-cell viewport at depth 3, on every map settle.
  // This direction costs |unlocked near the viewport| x (2d+1)^2, which for a
  // handful of nearby cells is a few hundred operations.
  const frontier = new Set();
  for (const u of set) {
    for (const n of neighborhood(u, depth)) if (!set.has(n)) frontier.add(n);
  }

  for (const cell of cells) {
    const box = set.has(cell) ? cellBox(cell) : (frontier.has(cell) ? cellBox(cell) : null);
    if (!box) continue;
    if (set.has(cell)) out.unlocked.push(box); else out.frontier.push(box);
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
- Produces: `UNLOCK_MAX_ACCURACY_M_DEFAULT = 100`; `recordUnlock(db, cell, { now, emit, accuracyM }) → { unlocked: boolean, cell: string|null, reason?: string }` (`unlocked` true only on the FIRST time); `unlockedCells(db) → Set<string>`; `unlockedCellsNear(db, bbox, depth) → Set<string>`; `GET /api/ramble/zones?bbox=s,w,n,e → { unlocked: CellBox[], frontier: CellBox[], depth: number }`.

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
import { recordUnlock, unlockedCells, unlockedCellsNear } from "../bundles/ramble/server/cells.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

test("recordUnlock: first visit unlocks and EMITS, later visits do neither, and the timestamp never moves", async () => {
  const db = await freshDb();
  const emitted = [];
  const emit = async (table, op, row) => { emitted.push({ table, op, cell: row.cell }); };

  assert.deepEqual(await recordUnlock(db, "9vk79ed", { now: 1000, emit }), { unlocked: true, cell: "9vk79ed" });
  assert.deepEqual(emitted, [{ table: "ramble_cells", op: "insert", cell: "9vk79ed" }],
    "the outbound half exists — registering the table alone replicates NOTHING");

  assert.deepEqual(await recordUnlock(db, "9vk79ed", { now: 2000, emit }), { unlocked: false, cell: "9vk79ed" });
  assert.equal(emitted.length, 1, "a repeat visit emits nothing");

  const rows = (await db.execute("SELECT * FROM ramble_cells")).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].first_unlocked_at), 1000, "the first arrival is the one recorded");
});

test("recordUnlock: a vague fix does NOT unlock, because an unlock can never be undone", async () => {
  const db = await freshDb();
  const r = await recordUnlock(db, "9vk79ed", { now: 1, accuracyM: 2000 });
  assert.deepEqual(r, { unlocked: false, cell: null, reason: "inaccurate" });
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows[0].n, 0, "nothing written");

  assert.equal((await recordUnlock(db, "9vk79ed", { now: 1, accuracyM: 100 })).unlocked, true, "at the limit is fine");
  const db2 = await freshDb();
  assert.equal((await recordUnlock(db2, "9vk79ed", { now: 1 })).unlocked, true, "no accuracy reported: trusted, as today");
  const db3 = await freshDb();
  await db3.execute("INSERT INTO ramble_settings (key, value) VALUES ('unlock.max.accuracy.m', '20')");
  assert.equal((await recordUnlock(db3, "9vk79ed", { now: 1, accuracyM: 50 })).unlocked, false, "the bound is a live setting");
});

test("unlockedCellsNear: only cells that could matter for this viewport", async () => {
  const db = await freshDb();
  await recordUnlock(db, "9vk79ed", { now: 1 });
  const here = (await import("../bundles/ramble/server/anchors.js")).decodeGeohash("9vk79ed");
  const near = { south: here.lat - 0.002, west: here.lon - 0.002, north: here.lat + 0.002, east: here.lon + 0.002 };
  assert.deepEqual([...(await unlockedCellsNear(db, near, 3))], ["9vk79ed"]);
  const far = { south: 0, west: 0, north: 0.002, east: 0.002 };
  assert.deepEqual([...(await unlockedCellsNear(db, far, 3))], [], "a viewport on the other side of the world reads nothing");
});

test("recordUnlock: junk is refused without throwing and writes nothing", async () => {
  const db = await freshDb();
  for (const bad of ["nope", "", null, undefined, 7, "9vk79edX", "9vk79e"]) {
    assert.deepEqual(await recordUnlock(db, bad, { now: 1000 }), { unlocked: false, cell: null }, String(bad));
  }
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows[0].n, 0);
  assert.deepEqual(await recordUnlock(null, "9vk79ed", { now: 1 }), { unlocked: false, cell: null }, "no db, no throw");
  // A throwing emit must not lose the write: the row is local truth already.
  const boom = async () => { throw new Error("relay down"); };
  assert.equal((await recordUnlock(db, "9vk79ed", { now: 1, emit: boom })).unlocked, true, "a failed emit never fails the unlock");
});

test("unlockedCells: the whole set, as a Set, empty on a database with no ramble tables", async () => {
  const db = await freshDb();
  await recordUnlock(db, "9vk79ed", { now: 1 });
  await recordUnlock(db, "9vk79ee", { now: 2 });
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
 * unlocked forever. Because the record is permanent and honours no deletes, a
 * VAGUE fix must not earn one: a 2 km wifi fix would otherwise unlock ground
 * the user never entered, irreversibly.
 *
 * ⚠ PRIVACY: this set is a precise, permanent record of everywhere the user
 * has been. It replicates to their OWN instances only and must never appear in
 * a contact-facing payload.
 *
 * ⚠ REPLICATION IS EXPLICIT. Registering the table for sync enables the
 * INBOUND apply only; nothing goes outward unless we emit. Every Ramble writer
 * threads `{ now, emit }` and emits after a successful write — see eggs.js.
 */
import { CELL7_RE, CELL7_LAT_STEP, CELL7_LON_STEP } from "./nests.js";

export const UNLOCK_MAX_ACCURACY_M_DEFAULT = 100;

/** The live `unlock.max.accuracy.m` bound (spec §6.4). Junk falls back. */
async function maxAccuracy(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = 'unlock.max.accuracy.m'", args: [],
    });
    const n = parseInt(rows?.[0]?.value, 10);
    return Number.isInteger(n) && n > 0 ? n : UNLOCK_MAX_ACCURACY_M_DEFAULT;
  } catch { return UNLOCK_MAX_ACCURACY_M_DEFAULT; }
}

/** Mirrors eggs.js's helper: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/**
 * Record a visit. `unlocked` is true ONLY the first time, so the caller can
 * celebrate once. A fix vaguer than the bound is refused outright.
 */
export async function recordUnlock(db, cell, { now = Date.now(), emit, accuracyM } = {}) {
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return { unlocked: false, cell: null };
  try {
    if (Number.isFinite(accuracyM) && accuracyM > (await maxAccuracy(db))) {
      return { unlocked: false, cell: null, reason: "inaccurate" };
    }
    const at = Number(now) || Date.now();
    const res = await db.execute({
      sql: `INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING`,
      args: [cell, at],
    });
    if (Number(res.rowsAffected) > 0) {
      // The outbound half. Without this the table syncs one way only.
      await safeEmit(emit, "ramble_cells", "insert", { cell, first_unlocked_at: at });
      return { unlocked: true, cell };
    }
    return { unlocked: false, cell };
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

/**
 * Only the unlocked cells that could affect this viewport: inside the bbox, or
 * within `depth` cells of it. A user with years of walking behind them has
 * thousands of cells, and every /marks, /around, /nests and /zones request
 * would otherwise read all of them. Bounded by geography, not by history.
 */
export async function unlockedCellsNear(db, bbox, depth = 0) {
  try {
    if (!bbox) return new Set();
    const padLat = (Number(depth) || 0) * CELL7_LAT_STEP + CELL7_LAT_STEP;
    const padLon = (Number(depth) || 0) * CELL7_LON_STEP + CELL7_LON_STEP;
    // A geohash prefix is not a range, so filter on the decoded centre instead:
    // cheap because the row count is the user's own walked ground, and the
    // comparison is done in SQL only when the table carries the columns. Here
    // we read the cells and filter in JS, which keeps the schema minimal.
    const { rows } = await db.execute({ sql: "SELECT cell FROM ramble_cells", args: [] });
    const { decodeGeohash } = await import("./anchors.js");
    const out = new Set();
    for (const r of rows || []) {
      let c;
      try { c = decodeGeohash(String(r.cell)); } catch { continue; }
      if (c.lat >= bbox.south - padLat && c.lat <= bbox.north + padLat &&
          c.lon >= bbox.west - padLon && c.lon <= bbox.east + padLon) out.add(String(r.cell));
    }
    return out;
  } catch { return new Set(); }
}
```

**A note on `unlockedCellsNear`'s cost.** It still reads every row, then filters in JS. That is deliberate for phase 1: the row count is the user's own walked ground (tens to low thousands), and the alternative — storing the decoded centre as columns so SQL can range-filter — is schema the phase does not otherwise need. What it buys is that the expensive part, the frontier expansion in `zones.js`, only ever sees cells that could matter. If profiling later shows the read itself hurting, add `lat`/`lon` columns and a bbox `WHERE`; the function's signature does not change.

- [ ] **Step 4: Wire the unlock into the area route, and add the zones endpoint**

In `bundles/ramble/panel/routes.js`, add `bundleImport("server/zones.js")` and `bundleImport("server/cells.js")` to the module-loading block alongside `bundleImport("server/nests.js")`, add `zonesMod` and `cellsMod` to the destructured list, to the `if (!... )` guard, and to the `mods = { ... }` object. Follow the shape already there exactly.

The route already builds an `emit` hook (it is the same one `feedActivity` uses). Pass it through.

Then in `POST /api/ramble/area`, accept an optional accuracy on `here` and replace the `if (here) { ... }` block:

```js
    let here = null;
    if (b.here != null) {
      if (typeof b.here !== "object" || Array.isArray(b.here)) bad("here must be an object with lat and lon");
      here = { lat: requireLat(b.here.lat), lon: requireLon(b.here.lon) };
      // 2026-09-08 §2.1: an unlock is permanent and undeletable, so a vague fix
      // must not earn one. Optional — an older panel that omits it is trusted,
      // exactly as today.
      if (b.here.accuracy_m != null) {
        if (typeof b.here.accuracy_m !== "number" || !Number.isFinite(b.here.accuracy_m) || b.here.accuracy_m < 0) {
          bad("here.accuracy_m must be a non-negative number");
        }
        here.accuracy_m = b.here.accuracy_m;
      }
    }
```

and further down:

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
      // every position post. `emit` is what makes the row replicate.
      const out = await mods.cellsMod.recordUnlock(db, cell, { now: Date.now(), emit, accuracyM: here.accuracy_m });
      // The FOOTPRINT, not just the name: the panel flashes the exact square
      // the user just walked into, which is the whole point of the moment.
      if (out.unlocked) unlockedNow = mods.zonesMod.cellBox(out.cell);
    }

    poke("ramble:area");
    res.json({ cells, ...(unlockedNow ? { unlocked: unlockedNow } : {}) });
```

(Delete the old `poke("ramble:area"); res.json({ cells });` lines that followed the block — they are replaced above.)

And the client must start sending the accuracy it already has. In `bundles/ramble/panel/static/ramble.js`, `publishArea` builds `body.here` from `lastFix`, which already carries `accuracy_m`:

```js
    if (lastFix) body.here = { lat: lastFix.lat, lon: lastFix.lon, accuracy_m: lastFix.accuracy_m };
```

Then, directly after the `GET /api/ramble/nests` route, add:

```js
  // The map's fog (spec 2026-09-08 §2.1). Same bbox contract as /nests: the
  // server owns all geohash maths so the client needs none. Fog is implicit —
  // a cell in neither list is fogged. The unlocked set is read BBOX-SCOPED, so
  // a user with years of walked ground pays for geography, not for history.
  router.get("/api/ramble/zones", handle(async (req, res) => {
    const raw = req.query?.bbox;
    if (typeof raw !== "string") bad("bbox=south,west,north,east is required");
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || !parts.every(Number.isFinite)) bad("bbox must be four numbers: south,west,north,east");
    const bbox = { south: requireLat(parts[0]), west: requireLon(parts[1]), north: requireLat(parts[2]), east: requireLon(parts[3]) };
    if (bbox.south > bbox.north || bbox.west > bbox.east) bad("bbox must have south <= north and west <= east");
    const depth = await mods.zonesMod.frontierDepth(db);
    const unlocked = await mods.cellsMod.unlockedCellsNear(db, bbox, depth);
    const out = mods.zonesMod.classifyBbox(bbox, unlocked, { depth });
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

/* Built from the REAL ramble_marks columns, not invented ones: asserting that
 * a beacon lacks a field the product never sets would prove nothing. */
function mark(cell, extra = {}) {
  const p = at(cell);
  return {
    mark_id: "m-" + cell, kind: "mark", origin: "remote", visibility: "public",
    lat: p.lat, lon: p.lon, geohash: cell,
    content_text: "secret words", content_ref: "ref-1", thumb_enc: "enc", locked_blob: "blob",
    author: "f".repeat(64), author_name: "Stranger", author_level: "pseudonym",
    nostr_event_id: "e".repeat(64), bird_species: "crow", bird_seed: 7, created_at: 1,
    ...extra,
  };
}
const gate = (rows) => gateForZones(rows, { unlocked: new Set([HOME]), depth: 1, encode: encodeGeohash });

test("a PUBLIC mark: whole when unlocked, a typed beacon in the frontier, gone in fog", () => {
  const out = gate([mark(HOME), mark(NEAR), mark(FAR)]);
  assert.equal(out.length, 2, "the fogged mark is not sent at all");

  const [home, near] = out;
  assert.equal(home.content_text, "secret words", "unlocked ground is unchanged");
  assert.equal(home.mark_id, "m-" + HOME);

  assert.equal(near.beacon, true, "the frontier entry is flagged as a beacon");
  assert.equal(near.kind, "mark", "typed — you can tell a mark from a nest");
  assert.ok(Number.isFinite(near.lat) && Number.isFinite(near.lon), "it has somewhere to draw");
  for (const leak of ["content_text", "content_ref", "thumb_enc", "locked_blob", "geohash",
                      "author", "author_name", "author_level", "nostr_event_id",
                      "bird_species", "bird_seed", "mark_id", "created_at",
                      "contact_name", "contact_avatar", "visibility"]) {
    assert.ok(!(leak in near), `a beacon must not carry ${leak}`);
  }
  assert.deepEqual(Object.keys(near).sort(), ["beacon", "kind", "lat", "lon"],
    "a beacon is built from scratch, so a field added upstream can never start leaking");
});

test("a caw in the frontier is typed as a caw, not flattened into a mark", () => {
  const [beacon] = gate([mark(NEAR, { kind: "caw" })]);
  assert.equal(beacon.kind, "caw");
  assert.equal(beacon.beacon, true);
});

test("a contacts-visibility mark survives fog even when no contact row matches it", () => {
  // The regression this pins: gating on `origin` alone, or leaning on
  // contact_name, fogs a mark from a pending, blocked or deleted contact.
  const orphan = gate([mark(FAR, { visibility: "contacts" })]);
  assert.equal(orphan.length, 1, "a contacts mark is never fogged, contact row or not");
  assert.equal(orphan[0].content_text, "secret words");
  assert.ok(!orphan[0].beacon);
});

test("the user's own and a contact's marks are NEVER gated, in any zone", () => {
  const mine = gate([mark(FAR, { origin: "local" }), mark(FAR, { origin: "sync" })]);
  assert.equal(mine.length, 2, "own marks survive fog");
  assert.ok(mine.every((m) => m.content_text === "secret words" && !m.beacon));

  // "A contact's mark" means one delivered on the contacts channel, i.e.
  // visibility "contacts" — NOT merely a public mark that happens to come
  // from someone in your contact list. See the D4 ruling in Global
  // Constraints: a publicly published mark is public terrain whoever sent it,
  // and `contact_name` cannot be the test because it excludes pending,
  // blocked and deleted contacts.
  const contact = gate([mark(FAR, { visibility: "contacts", contact_name: "Dayane" })]);
  assert.equal(contact.length, 1, "a contacts-channel mark survives fog");
  assert.equal(contact[0].content_text, "secret words");
  assert.ok(!contact[0].beacon);

  const publicFromAContact = gate([mark(FAR, { contact_name: "Dayane" })]);   // visibility stays "public"
  assert.deepEqual(publicFromAContact, [], "a contact's PUBLIC mark is public terrain and fogs like any other");
});

test("with nothing unlocked, every public mark is fogged and nothing throws", () => {
  const out = gateForZones([mark(HOME), mark(FAR)], { unlocked: new Set(), depth: 3, encode: encodeGeohash });
  assert.deepEqual(out, []);
  assert.deepEqual(gateForZones(null, { unlocked: new Set([HOME]), depth: 1, encode: encodeGeohash }), []);
});

test("a row without usable coordinates is dropped rather than mis-zoned", () => {
  const out = gate([{ mark_id: "x", kind: "mark", origin: "remote", visibility: "public", lat: null, lon: null, content_text: "hi" }]);
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
 * Only a stranger's PUBLIC mark is gated, and public means `visibility ===
 * "public"` — not `origin`, which is "remote" for a contact's mark too. The
 * user's own rows (origin local or sync) and anything delivered by a contact
 * or a group (visibility "contacts") pass through whole in every zone:
 * contacts are geographically spread, and making a friend's mark depend on
 * visiting their neighbourhood would be absurd.
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
    // ⚠ `origin` does NOT separate public from contact content: a
    // contact-delivered mark is also origin "remote" (delivery.js:136,144).
    // Only `visibility` does. `contact_name` is not a safe fallback either —
    // it comes from contactsByPubkey, which filters to unblocked FULL
    // contacts, so a pending, blocked or deleted contact's mark would be
    // misread as public and fogged off the user's own map (against D4).
    const isPublic = row && row.origin === "remote" && row.visibility === "public";
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
    // Bounded like the other two gates. annotateMarks has no bbox, but the
    // marks themselves give one: their own coordinates. An unbounded read here
    // would undo the point of unlockedCellsNear on every /marks and /around.
    const lats = named.map((m) => Number(m.lat ?? m.approx_lat)).filter(Number.isFinite);
    const lons = named.map((m) => Number(m.lon ?? m.approx_lon)).filter(Number.isFinite);
    const unlocked = lats.length
      ? await mods.cellsMod.unlockedCellsNear(db, {
          south: Math.min(...lats), north: Math.max(...lats),
          west: Math.min(...lons), east: Math.max(...lons),
        }, depth)
      : new Set();
    return mods.zonesMod.gateForZones(named, { unlocked, depth, encode: mods.anchorsMod.encodeGeohash });
  }
```

**`/around` returns nests too, and they are a separate array.** `aroundPoint` (`around.js:123`) returns its own `nests`, which the route passes through raw — so without this the AR view would show every public nest in fog while the map fogged them.

⚠ `/around` has **no bbox in scope**: its inputs are `lat`, `lon` and `radiusM`, and the bbox is computed inside `aroundPoint`. So derive one in the route from the same three values before gating — a square around the point is sufficient, since `unlockedCellsNear` only needs a bound, not an exact match:

```js
    // aroundPoint owns the real bbox; this is just a bound for the unlocked
    // read, padded by the frontier depth inside unlockedCellsNear.
    const degLat = radiusM / 111320;
    const degLon = radiusM / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    const bbox = { south: lat - degLat, west: lon - degLon, north: lat + degLat, east: lon + degLon };
```

Then gate both arrays — the marks through `annotateMarks` as usual, and the nests with the same shape as the `/nests` route below, including the synthetic-key strip.

And in the `GET /api/ramble/nests` route, gate the nest list the same way, replacing `res.json(out);` with:

```js
    // Nests are public terrain, so they fog like public marks: whole in
    // unlocked ground, a typed beacon in the frontier, absent in fog. The
    // synthetic `visibility: "public"` is what marks them as gateable — nests
    // have no visibility column of their own.
    const depth = await mods.zonesMod.frontierDepth(db);
    const unlocked = await mods.cellsMod.unlockedCellsNear(db, bbox, depth);
    const gated = mods.zonesMod.gateForZones(
      (out.nests || []).map((n) => ({ ...n, kind: "nest", origin: "remote", visibility: "public" })),
      { unlocked, depth, encode: mods.anchorsMod.encodeGeohash },
    ).map((n) => {
      // gateForZones passes an UNLOCKED row through untouched, so the three
      // synthetic keys we added to make it gateable would ride out to the
      // client and break the route's documented shape. A beacon is rebuilt
      // from scratch and never carries them.
      if (n.beacon) return n;
      const { kind, origin, visibility, ...nest } = n;
      return nest;
    });
    res.json({ ...out, nests: gated });
```

- [ ] **Step 5: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-map-gating.test.js tests/ramble-panel.test.js tests/ramble-flock.test.js tests/ramble-delivery.test.js
```
**Two existing tests break here, and both need a real fix rather than a weakened assertion.** An earlier draft of this plan predicted breakage in the mark tests; that was wrong — marks created through `POST /api/ramble/marks` land `origin: "local"` and are never gated. What actually breaks is the two nest tests, because a fresh test database has no unlocked cells, so every nest fogs away:

1. **`tests/ramble-panel.test.js`, "GET /api/ramble/nests lists deterministic nests for a viewport…"** — `assert.ok(body.nests.length > 0)` and the `Object.keys(body.nests[0])` shape assertion both fail. Fix it by unlocking the cell that actually holds a nest, which the test can compute because nests are a pure function. Before the request, import `nestsInCells` and `cellsInBbox` from `../bundles/ramble/server/nests.js`, find the first nest in the bbox, then walk there:

```js
  // Fog gates public terrain (spec 2026-09-08 §2.1), so the viewport must
  // contain ground we have actually stood in before a nest is anything but a
  // beacon. Nests are deterministic, so we can walk straight to one.
  // `isoWeek` is exported from bundles/ramble/server/eggs.js; this test file
  // does not import it yet, so add it to the imports at the top. (An earlier
  // draft of this plan called it `isoWeekOf`, which does not exist anywhere.)
  const week = isoWeek(Date.now());
  const target = nestsInCells(cellsInBbox({ south: LAT - 0.01, west: LON - 0.01, north: LAT + 0.01, east: LON + 0.01 }), week)[0];
  assert.ok(target, "the fixture bbox must hold at least one deterministic nest");
  await req("/api/ramble/area", { method: "POST", body: { lat: target.lat, lon: target.lon, here: { lat: target.lat, lon: target.lon, accuracy_m: 5 } } });
```

   ⚠ Two things about that added `/area` post. It credits `visit_place`, worth **+20 warmth** against a `hatch_at` of 100, and this test file already accumulates warmth before the nests tests while later tests assert an incubating egg still exists. Use the file's own trick — it temporarily raises `warmth.hatch_at` elsewhere for exactly this reason — or set `warmth.visit_place = 0` around the added posts. And pass the rate through: `nestsInCells(cells, week, { rate })` where the fixture's rate matches what `listNests` reads from settings, or the computed nest may not be the one the route returns.

   Then assert the nest at that cell is whole, and that a nest elsewhere in the bbox is a beacon:

```js
  const whole = body.nests.find((n) => n.cell === target.cell);
  assert.ok(whole, "the nest we walked to is listed in full");
  claimedNest = whole;   // explicit: do not rely on body.nests[0] still being the whole one
  assert.deepEqual(Object.keys(whole).sort(), ["cell", "claimed", "lat", "lon", "seed", "week"]);
  for (const n of body.nests) {
    if (n.cell === target.cell) continue;
    assert.deepEqual(Object.keys(n).sort(), ["beacon", "kind", "lat", "lon"], "the rest are beacons");
  }
```

2. **`tests/ramble-panel.test.js`, the claim test's trailing `listed.nests.find(...)?.claimed === true`** — same cause. Fix it the same way and more faithfully: before claiming, post `/api/ramble/area` with `here` at the nest's position. That is what a real player does — you walk to the nest, which unlocks the cell, and then you claim it. One added line, and the test becomes closer to the product.

**Two MORE existing tests break, and walking to the nest does not save them.** The geometry was measured during review: the first deterministic nest in the fixture bbox is `9v6jpzr`, **1251 m** from the fixture's `LAT/LON` — far outside a depth-3 frontier of roughly 460 m — and `LAT/LON`'s own cell `9v6m21h` holds no nest at the default rate. So Step 5's walk unlocks the nest's ground and leaves the marks fixture's ground in fog.

3. **"GET /api/ramble/marks names a remote mark by a contact; a stranger's stays anonymous."** It inserts `by-stranger` with `visibility: 'public'`, `origin: 'remote'` at `LAT/LON`, then reads `marks.find((m) => m.mark_id === "by-stranger").contact_name`. That mark is now fogged, so `find` returns undefined and the test dies with a bare **TypeError** rather than a readable failure. Fix: post `/area` with `here: { lat: LAT, lon: LON, accuracy_m: 5 }` in that test's setup.
4. **"GET /api/ramble/around: marks and nests within the radius with distance_m…"** sets `nest.rate = 1` and asserts `body.nests.length >= 1` plus a numeric `seed` per nest. With `/around`'s nests gated and nothing unlocked at `LAT/LON`, every nest is fog and the array is empty. Same fix: unlock `LAT/LON` first.

⚠ That makes **four** added `visit_place` credits across this task, each worth +20 warmth against a `hatch_at` of 100, in a file that already churns hatches and later asserts an incubating egg exists. Extend the warmth remedy to cover all four, not just the two in Step 5 — the file's own trick is to raise `warmth.hatch_at` temporarily, or set `warmth.visit_place = 0` around the added posts.

If a fifth test fails that this plan did not predict, fix it by unlocking the relevant ground rather than by relaxing the assertion, and say in your report which test and why.

Expected after those four fixes: PASS.

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
- Produces: `SEED_KIND = "seed"`; `harvestWindow(now, hours) → number`; `readWalletSettings(db) → { respawnHours, perPickup }`; `recordSeedPickup(db, cell, { now, emit }) → { picked: boolean, amount: number }`; `seedBalance(db) → number`. `POST /api/ramble/area` reports `seed` in its response **only when `here` was supplied** — an area post without a fix keeps its current response shape exactly.

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

  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: 0 }), { picked: true, amount: 1 });
  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: HOUR }), { picked: false, amount: 0 }, "same window, already taken");
  assert.equal(await seedBalance(db), 1);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ee", { now: HOUR }), { picked: true, amount: 1 }, "a different cell is its own patch");
  assert.equal(await seedBalance(db), 2);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: 25 * HOUR }), { picked: true, amount: 1 }, "it regrows next window");
  assert.equal(await seedBalance(db), 3);

  const keys = (await db.execute("SELECT kind, key FROM ramble_wallet ORDER BY key")).rows;
  assert.ok(keys.every((r) => r.kind === SEED_KIND));
  assert.deepEqual(keys.map((r) => r.key), ["9vk79ed:0", "9vk79ed:1", "9vk79ee:0"]);
});

test("recordSeedPickup EMITS on a real pickup, and never on a no-op", async () => {
  const db = await freshDb();
  const emitted = [];
  const emit = async (table, op, row) => { emitted.push({ table, op, key: row.key, delta: row.delta }); };
  await recordSeedPickup(db, "9vk79ed", { now: 0, emit });
  assert.deepEqual(emitted, [{ table: "ramble_wallet", op: "insert", key: "9vk79ed:0", delta: 1 }],
    "the outbound half exists — a registered table with no emit replicates NOTHING");
  await recordSeedPickup(db, "9vk79ed", { now: HOUR, emit });
  assert.equal(emitted.length, 1, "an already-harvested cell emits nothing");
  const boom = async () => { throw new Error("relay down"); };
  assert.equal((await recordSeedPickup(db, "9vk79ee", { now: 0, emit: boom })).picked, true,
    "a failed emit never fails the pickup");
});

test("recordSeedPickup: junk is refused without throwing, and honours seed.per.pickup", async () => {
  const db = await freshDb();
  for (const bad of ["nope", "", null, 7]) {
    assert.deepEqual(await recordSeedPickup(db, bad, { now: 0 }), { picked: false, amount: 0 }, String(bad));
  }
  assert.equal(await seedBalance(db), 0);
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.per.pickup', '5')");
  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: 0 }), { picked: true, amount: 5 });
  assert.equal(await seedBalance(db), 5);
  assert.deepEqual(await recordSeedPickup(null, "9vk79ed", { now: 0 }), { picked: false, amount: 0 }, "no db, no throw");
});

test("seedBalance nets spends against earns, and never throws on a bare database", async () => {
  const db = await freshDb();
  await recordSeedPickup(db, "9vk79ed", { now: 0 });
  await recordSeedPickup(db, "9vk79ee", { now: 0 });
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

/** Mirrors eggs.js's helper: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/**
 * Harvest this cell's seed if it has regrown. `picked` is false when it has
 * not. Emits on a real pickup — without that the ledger would sync inbound
 * only and a balance earned on the phone would never reach the desktop.
 */
export async function recordSeedPickup(db, cell, { now = Date.now(), emit } = {}) {
  const none = { picked: false, amount: 0 };
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return none;
  try {
    const { respawnHours, perPickup } = await readWalletSettings(db);
    const at = Number(now) || Date.now();
    const key = `${cell}:${harvestWindow(at, respawnHours)}`;
    const res = await db.execute({
      sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, key) DO NOTHING`,
      args: [SEED_KIND, key, perPickup, at],
    });
    if (Number(res.rowsAffected) === 0) return none;
    await safeEmit(emit, "ramble_wallet", "insert", { kind: SEED_KIND, key, delta: perPickup, created_at: at });
    return { picked: true, amount: perPickup };
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
      const out = await mods.cellsMod.recordUnlock(db, cell, { now: Date.now(), emit, accuracyM: here.accuracy_m });
      // The FOOTPRINT, not just the name: the panel flashes the exact square
      // the user just walked into, which is the whole point of the moment.
      if (out.unlocked) unlockedNow = mods.zonesMod.cellBox(out.cell);
      // 2026-09-08 §2.3: bird seed grows in ground you have ALREADY unlocked,
      // so a first arrival unlocks the cell and the next visit starts paying.
      // Deliberate: standing still after an unlock earns nothing until you
      // move and come back, which is what "routine sustains you" means.
      if (!out.unlocked && out.cell) {
        seedPicked = (await mods.walletMod.recordSeedPickup(db, cell, { now: Date.now(), emit })).amount;
      }
    }

    poke("ramble:area");
    // `seed` rides ONLY on a post that carried a fix. An area post without
    // `here` keeps its historical response shape byte for byte, which is what
    // the existing "writes local.active_area" test asserts with a deepEqual.
    res.json({
      cells,
      ...(unlockedNow ? { unlocked: unlockedNow } : {}),
      ...(seedPicked ? { seed_picked: seedPicked } : {}),
      ...(here ? { seed: await mods.walletMod.seedBalance(db) } : {}),
    });
```

- [ ] **Step 5: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-wallet.test.js tests/ramble-cells.test.js tests/ramble-panel.test.js
```
Expected: PASS, including the existing "POST /api/ramble/area writes local.active_area as the precision cell" test, whose `assert.deepEqual(await res.json(), { cells: [CELL] })` still holds because that request sends no `here` and therefore gets no `seed` key. An earlier draft of this plan added `seed` unconditionally and would have broken it here while claiming PASS.

- [ ] **Step 6: Commit**

```bash
git add bundles/ramble/server/wallet.js tests/ramble-wallet.test.js
git commit bundles/ramble/server/wallet.js bundles/ramble/panel/routes.js tests/ramble-wallet.test.js -m "ramble: bird seed — a replicated ledger, harvested from ground you already walked"
```

---

## Task 6: the map draws real fog

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`
- Test: `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Consumes: `GET /api/ramble/zones` (Task 3); beacon rows from `/marks`, `/around` and `/nests` (Task 4).
- Produces: client `refreshZones()`, `drawZones(out)`, `drawBeacon(mark)`; a Leaflet pane `rb-fog`.

**Fog obscures.** An earlier draft painted a dim band on the frontier and left the rest of the world an ordinary map, with a `.rb-fog-cell` rule that nothing used — a CSS rule asserted by a test and referenced by no code. That is not fog of war and not what spec §2.1 describes. Fog here is a real mask: one polygon covering the viewport with the unlocked and frontier cells punched out of it, which is Leaflet's standard even-odd hole technique.

- [ ] **Step 1: Write the failing assertions**

In `tests/ramble-panel.test.js`, inside the existing `GET /ramble/static/ramble.js` test, append:

```js
  // Phase 1 of the reward economy (spec 2026-09-08 §2.1): the map masks
  // everywhere the user has not been. Leaflet layer calls are not markup sinks.
  assert.ok(body.includes("function refreshZones()"));
  assert.ok(body.includes("function drawZones("));
  assert.ok(body.includes("function drawBeacon("));
  assert.ok(body.includes('"/api/ramble/zones?bbox="'), "zones are fetched by bbox like nests");
  assert.ok(body.includes('map.createPane("rb-fog")'), "fog has its own pane");
  assert.ok(body.includes("rb-fog\").style.zIndex = 350"), "the mask sits under the overlay pane so it cannot bury marks");
  assert.ok(body.includes("L.polygon("), "fog is a real mask, not a dim band");
  assert.ok(body.includes("fogHoles"), "the unlocked and frontier cells are punched out of it");
  assert.ok(body.includes("if (mark.beacon)"), "a beacon is drawn differently from a full mark");
  // The guards refreshNests already has: a zones fetch at world zoom-out would
  // 400 on every settle and leave stale rectangles pinned to ground you left.
  assert.ok(body.includes("MIN_ZONE_ZOOM"), "zones are not fetched below a zoom floor");
```

And in the existing stylesheet test:

```js
  assert.ok(body.includes("#ramble .rb-fog {"), "the fog mask has a rule");
  assert.ok(body.includes("#ramble .rb-frontier-cell {"), "the frontier is dimmed, not hidden");
  assert.ok(body.includes("#ramble .rb-beacon {"), "beacons have a rule");
```

- [ ] **Step 2: Run and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Add the fog pane and the mask**

Beside the other layer declarations (`var nestLayer = null;`), add `var zoneLayer = null;` and `var MIN_ZONE_ZOOM = 15;`.

Inside the `if (mapEl && typeof L !== "undefined")` block, after the `rb-here` pane is created:

```js
    /* 350: between Leaflet's tile pane (200) and its overlay pane (400).
     * NOT 450 — markerLayer's locked-mark teasers are plain circleMarkers with
     * no pane, so they render in the overlay pane at 400 and a 450 mask would
     * bury them. Those include the user's OWN and their contacts' locked marks
     * in fogged ground, which D4 says must be unaffected in every zone. */
    map.createPane("rb-fog");
    map.getPane("rb-fog").style.zIndex = 350;
    zoneLayer = L.layerGroup().addTo(map);
```

Then, next to `drawNests`:

```js
  /* The map's three zones (spec 2026-09-08 section 2.1). The server owns every
   * geohash sum and sends footprints; the client punches them out of a mask. */
  function refreshZones() {
    if (!map || !zoneLayer) return Promise.resolve();
    /* The same two guards refreshNests carries. Without the zoom floor the
     * route 400s ("bbox too large") on every settle at low zoom, and the
     * .catch below would leave the last mask pinned over ground the user has
     * panned away from. */
    var root = $("ramble");
    if (root && root.getAttribute("data-view") !== "world") return Promise.resolve();
    /* 15, matching refreshNests, NOT 13: /zones inherits MAX_NEST_CELLS via
     * cellsInBbox, and a 1100x700 map at zoom 13 covers ~10,700 cells, so the
     * route would 400 on every settle — the very failure this guard exists to
     * prevent. Measured during review. */
    if (map.getZoom() < MIN_ZONE_ZOOM) { zoneLayer.clearLayers(); return Promise.resolve(); }
    var b = map.getBounds();
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(",");
    return jsonFetch("/api/ramble/zones?bbox=" + encodeURIComponent(bbox))
      .then(drawZones)
      .catch(function () { /* a failed fetch leaves the last mask up */ });
  }

  /* One polygon: the padded viewport as the outer ring, every unlocked and
   * frontier cell as a hole. Leaflet fills even-odd, so the holes are clear
   * and everything else is fogged. Frontier cells get a dim square on top so
   * they read as previewed rather than owned. */
  function drawZones(out) {
    if (!out || !zoneLayer || !map) return;
    zoneLayer.clearLayers();
    var b = map.getBounds().pad(0.5);
    var outer = [
      [b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()],
      [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()]
    ];
    var fogHoles = [];
    addHoles(fogHoles, out.unlocked);
    addHoles(fogHoles, out.frontier);
    L.polygon([outer].concat(fogHoles), {
      pane: "rb-fog", className: "rb-fog", stroke: false, interactive: false
    }).addTo(zoneLayer);
    paintCells(out.frontier || [], "rb-frontier-cell");
  }

  function addHoles(holes, cells) {
    for (var i = 0; i < (cells || []).length; i++) {
      var c = cells[i];
      if (!cellUsable(c)) continue;
      holes.push([[c.south, c.west], [c.south, c.east], [c.north, c.east], [c.north, c.west]]);
    }
  }

  /* One rectangle per cell. The footprint comes from the server's own list, so
   * the client never needs a geohash encoder. */
  function paintCells(cells, className) {
    for (var i = 0; i < cells.length; i++) {
      var box = cellBounds(cells[i]);
      if (!box) continue;
      L.rectangle(box, { pane: "rb-fog", className: className, stroke: false, interactive: false }).addTo(zoneLayer);
    }
  }

  function cellUsable(c) {
    return !!c && isFinite(c.south) && isFinite(c.west) && isFinite(c.north) && isFinite(c.east);
  }
  function cellBounds(c) {
    return cellUsable(c) ? [[c.south, c.west], [c.north, c.east]] : null;
  }
```

`classifyBbox` already returns footprints (Task 2's `cellBox`), so the client draws straight from the response.

- [ ] **Step 4: Draw beacons, and keep them out of everything that cannot handle them**

In `drawMarks`, as the first thing inside the `forEach` callback after the existing `if (!markerLayer) return;`:

```js
      if (mark.beacon) { drawBeacon(mark); return; }   /* forEach callback: return, never continue */
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

**Three existing consumers cannot handle a beacon and must be taught to skip one.** A beacon has no `mark_id`, `cell`, `seed`, `content_text`, `origin` or `created_at`, so each of these would otherwise build something from `undefined`:

1. **`drawNests`** does `html: nestEggHtml(nest.seed)` and keys `nestMarkers[nest.cell]`. Every nest beacon would collide on the single key `undefined` and its pin art would be built from `undefined`. Add `if (nest.beacon) { drawBeacon(nest); return; }` as the first line of its `forEach` callback.
2. **`toArAnchors` has TWO loops and both need it.** Its mark loop builds `id: "m:" + mark.mark_id`, giving every mark beacon the id `"m:undefined"`. Its **nest** loop builds `id: "n:" + nest.cell` and `art: nestArt(nest)`, which reaches `nestArtCache[undefined]` and `drawEggSeed(svg, undefined)` — and Task 4 gating `/around`'s nests is precisely what creates those nest beacons. Filter beacons out of BOTH arrays it receives.
3. **`drawNearby`** renders a list row per mark; a beacon would show as an empty entry and inflate the "Nearby" count. Filter beacons out before the call.

**These need TWO separate filters, not one.** `drawNearby` is fed from `drawMarks`'s array; `toArAnchors` is fed by `refreshAround()` from the `/around` response and never sees `drawMarks`'s list. So:

- In `drawMarks`, build `var full = marks.filter(function (m) { return !m.beacon; });` and pass that to `drawNearby(full)`. Also set `lastMarks = full` rather than the raw array — otherwise `paintPerchSay`'s "N things waiting nearby" keeps counting beacons.
- In `refreshAround`, filter both the marks and the nests before they reach `toArAnchors`.

- [ ] **Step 5: Hook the refresh**

**⚠ First, a defect this phase would otherwise ship broken.** Unlocking hangs off `POST /api/ramble/area`, and that route is called from exactly two places: the debounced `moveend` handler and the boot chain. But `map.on("dragstart", …)` sets `following = false`, so after a single manual pan the map stops moving on its own, `moveend` never fires again, and **no cell unlocks and no seed is harvested for the rest of the session however far the user walks.** `watchPosition` updates `lastFix` and repaints the dot on every fix but never posts. Even with follow left on, the map only pans when the dot leaves a padded viewport — roughly 300 m at the boot zoom — so a walked route would unlock a sparse sample rather than a trail, against spec §2.1. No test in this plan would catch it, because every test posts `/area` explicitly.

Add a fix-driven trigger inside the `watchPosition` callback, independent of both `following` and `moveend`. The client has no geohash encoder, so make it distance-based using `haversineMeters`, which the file already uses:

```js
      /* The map only posts on moveend, and one manual pan turns following off
       * forever, so without this a walk unlocks nothing. Distance-driven and
       * independent of the map: 75 m is the unlock radius, so this cannot skip
       * a cell the user actually crossed. */
      if (!lastPostedFix || haversineMeters(lastPostedFix, lastFix) > 75) {
        lastPostedFix = { lat: lastFix.lat, lon: lastFix.lon };
        publishArea();
      }
```

with `var lastPostedFix = null;` beside the other fix state. Assert it in the served-script test:

```js
  assert.ok(body.includes("lastPostedFix"), "walking posts the area even when the map is not following");
```

`refreshMarks` is **not** called on a map move. The `moveend` handler calls `publishArea(); refreshNests();`, and `publishArea` then chains `refreshMarks`. Add `refreshZones();` to that same `moveend` handler beside `refreshNests();`.

At boot there is likewise no bare `refreshMarks()` — the chain ends `.then(function () { publishArea(); refreshNests(); })`. Add `refreshZones();` there too. And the file has a `setInterval(refreshNests, 10 * 60e3)`; give zones the same companion, since another instance's walking can unlock ground under you.

- [ ] **Step 6: Add the styles**

In `bundles/ramble/panel/static/ramble.css`, after the `#ramble .rb-here-dot` rules:

```css
/* --------------------------------------------------------------- map zones */
/* Unlocked ground is punched out of the mask: a clear map is what walking
   buys you. The frontier is a hole too, then dimmed on top, so it reads as
   previewed rather than owned. */
#ramble .rb-fog { fill: var(--rb-surface-2); fill-opacity: 0.93; }
#ramble .rb-frontier-cell { fill: var(--rb-line); fill-opacity: 0.3; }
#ramble .rb-beacon { stroke: var(--rb-line); fill: var(--rb-accent-2); opacity: 0.7; }
#ramble .rb-beacon-nest { fill: var(--rb-accent); }
```

- [ ] **Step 7: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js tests/ramble-zones.test.js tests/ramble-ar.test.js
```
Expected: PASS. Then confirm the client-script invariants are intact — the enforced regex is `/\.innerHTML\s*=|\bhtml:\s/g`, so check with exactly that:

```
grep -c '`' bundles/ramble/panel/static/ramble.js                      # expect 0
grep -cE '\.innerHTML\s*=|\bhtml:\s' bundles/ramble/panel/static/ramble.js   # expect 2
```

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js -m "ramble: the map masks unwalked ground, dims the frontier and draws typed beacons"
```

---

## Task 7: your pet IS the location marker

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`, `bundles/ramble/panel/ramble.js`, `bundles/ramble/server/bird-svg.cjs`
- Test: `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Consumes: `paintHere(fix)` and `paintPerch(pet)`, both existing; `Bird.mountBird` / `Bird.drawEgg` from the shared engine.
- Produces: client `hereIcon(art)`, `hereArt()`, `paintHereArt()`, `markWalking()`, `drawWalkingEggSeed(el, seed)`; the engine export `drawWalkingEgg(seed)`; the corner perch button is retired and `perchTarget`'s click moves onto the map marker.

⚠ `drawWalkingEggSeed` is the third and final use of the engine's markup, so it must go through the SAME existing sink as `drawEggSeed` rather than adding one. Extend `drawEggSeed` with a flag, or have `drawWalkingEggSeed` delegate to it — do not write a second `el.innerHTML =`. Verify the count is still 2 in Step 6.

**Why.** Operator request: the dot showing your position should BE your egg or bird, so it walks the map with you. It makes seed pickup legible — the thing collecting the seed is visibly the thing standing there — and it replaces a corner button with a presence. Tapping it opens the egg or pet view exactly as the corner perch does now, so the state machine already exists (`perchTarget`, set by `paintPerch`).

**Two constraints shape the implementation.**

`static/ramble.js` is held to exactly two markup sinks, and passing a STRING to `L.divIcon({ html })` would add a third — the enforcing test's regex is `/\.innerHTML\s*=|\bhtml:\s/g`. But Leaflet's `DivIcon` also accepts an **Element**, which it appends rather than assigning (confirmed in the vendored build: `options.html instanceof Element` takes a different branch). So build the `<svg>` with `document.createElementNS`, hand it to `Bird.mountBird` — which lives in the drawing engine, not this file — and pass the element. Exactly the pattern `birdFor` already uses at `static/ramble.js:362`.

⚠ The same file allows **zero backticks**, in comments included, and that rule **is** test-enforced — `tests/ramble-panel.test.js` asserts the served script splits on a backtick into exactly one piece. Earlier drafts of this plan slipped backticks into comments twice, in this task and in Task 8. Write the comments with plain words.

- [ ] **Step 1: Write the failing assertions**

Append to the served-script test:

```js
  // The location marker IS the pet (operator request, 2026-09-08): it walks
  // the map with you and opens the egg or pet view when tapped.
  assert.ok(body.includes("function hereIcon()"));
  assert.ok(body.includes("function paintHereArt()"));
  assert.ok(body.includes("function hereArt()"));
  assert.ok(body.includes('hereDot.on("click"'), "the marker itself opens the view — the retired button also matched showView(perchTarget)");
  assert.ok(body.includes('createElementNS("http://www.w3.org/2000/svg", "svg")'), "the art is built without a markup sink");
  assert.ok(body.includes("showView(perchTarget)"), "tapping the marker still opens egg or pet");
  assert.ok(!body.includes('L.circleMarker(ll, { pane: "rb-here"'), "the plain blue dot is gone");
```

To the stylesheet test:

```js
  assert.ok(body.includes("#ramble .rb-here-pet {"), "the pet marker has a rule");
```

And to the shell test:

```js
  assert.ok(!sent.includes('id="rb-perch-open"'), "the corner perch button is retired");
  assert.ok(sent.includes('id="rb-perch-say"'), "the status strip stays");
```

- [ ] **Step 2: Run and watch it fail**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Retire the corner button, keep the strip**

In `bundles/ramble/panel/ramble.js`, inside `<div class="rb-perch">`, delete the whole `<button class="rb-perch-btn" id="rb-perch-open" …>` element and everything inside it (the bird svg, the ring wrapper, the ring track, the egg svg). Keep `<div class="rb-say" id="rb-perch-say">` exactly as it is — it is the status strip and it stays in the corner.

In `bundles/ramble/panel/static/ramble.css`, the `.rb-say` bubble has a squared-off bottom-right corner that used to point at the bird beside it. With the bird gone from the corner, round it:

```css
/* Scoped to the map corner: the AR sheet's own .rb-ar-perch .rb-say still sits
   beside a bird and keeps its tail. */
#ramble .rb-perch .rb-say { border-radius: 16px; }   /* was 16px 16px 4px 16px — no bird to point at */
```

Delete the now-dead `.rb-perch-btn`, `.rb-perch .rb-bird`, `.rb-perch .rb-ring` and `.rb-perch .rb-eggart` rules.

- [ ] **Step 4: Make the location marker the pet**

`paintHere` currently builds `hereRing` (an accuracy circle) and `hereDot` (a plain blue `circleMarker`). Keep the ring — it still communicates accuracy — and replace the dot with a marker carrying the pet's art:

```js
  /* Leaflet's divIcon html option is a markup sink and this file is held to
   * exactly two, so we never pass a string. It also accepts an ELEMENT, which
   * Leaflet appends rather than assigning — no sink, and no getElement()
   * timing to worry about. Note: no backticks anywhere in this file. */
  function hereIcon(art) {
    var opts = { className: "rb-here-pet", iconSize: [46, 46], iconAnchor: [23, 23] };
    if (art) opts.html = art;   /* an Element, never a string */
    return L.divIcon(opts);
  }

  /* Fill the marker with whatever the perch would have shown: the bird once
   * one has hatched, otherwise the egg. Built with createElementNS and handed
   * to the shared engine, which is where the markup actually happens. */
  function hereArt() {
    if (!Bird) return null;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    try {
      if (perchTarget === "pet" && lastPet && lastPet.bird) {
        svg.setAttribute("class", "rb-here-bird");
        Bird.mountBird(svg, Bird.rollGenome(lastPet.bird.seed, lastPet.bird.species), (lastPet && lastPet.mood) || "happy");
      } else {
        /* The WALKING egg — legs and all. You are not carrying it, you are it. */
        svg.setAttribute("class", "rb-here-egg");
        svg.setAttribute("viewBox", "0 0 120 168");
        drawWalkingEggSeed(svg, seedFromEggId(eggSeedId));
      }
    } catch (e) { return null; }
    return svg;
  }

  /* Re-skin the marker in place when the egg hatches or the mood changes. */
  function paintHereArt() {
    if (!hereDot) return;
    var art = hereArt();
    if (art) hereDot.setIcon(hereIcon(art));
  }
```

In `paintHere`, swap the dot's construction and add the tap:

```js
    if (!hereDot) {
      hereRing = L.circle(ll, { pane: "rb-here", radius: r, className: "rb-here-ring", stroke: false, fillOpacity: 0.12, interactive: false }).addTo(hereLayer);
      hereDot = L.marker(ll, {
        pane: "rb-here", icon: hereIcon(hereArt()), keyboard: true,
        /* The retired button carried an accessible name; a divIcon has none,
         * and the marker shows an egg as often as a bird. */
        /* title carries the accessible name; divIcon ignores alt, which
         * Leaflet only applies when it builds an img icon. */
        title: "You",
      }).addTo(hereLayer);
      hereDot.on("click", function () { showView(perchTarget); });
    } else {
      hereRing.setLatLng(ll);
      hereRing.setRadius(r);
      hereDot.setLatLng(ll);
    }
```

Then call `paintHereArt()` at the end of `paintPerch`, so the marker follows the same egg-or-bird decision the corner button used to make. `paintPerch` keeps setting `perchTarget` and `paintPerchSay`; only its DOM writes to the retired elements are removed — guard or delete them, since `perchBird` and `perchEggWrap` no longer exist.

- [ ] **Step 4b: Legs on the egg, and a waddle when you move**

Operator request, and it follows from the premise: you are not carrying an egg, you ARE one — an egg that wandered off from its nest — so the marker's egg needs legs, and both the egg and the bird should walk when you do.

**The legs.** `Bird.drawEgg(seed)` draws a bare egg. The engine already has the leg shape the bird uses (`PARTS.foot`, a stroke path), so this is reusing an existing part rather than inventing art. In `bundles/ramble/server/bird-svg.cjs`, add a `drawWalkingEgg(seed)` beside `drawEgg` that returns the same egg with two `foot` paths beneath it, and export it alongside the others. Use it only for the location marker; the egg screen and the nest pins keep the plain `drawEgg`, because those are eggs you are looking at rather than eggs that are you.

⚠ This is a NEW export on the bundle's engine. That is fine — the no-new-export rule from the profile-avatar work constrains what CORE may rely on, and core only ever loads `rollGenome` and `drawBird`. Nothing outside the bundle touches this.

**The waddle.** The movement detector you just added in Step 5 of Task 6 already knows when the user is walking, so reuse it rather than adding a second one. When a fix arrives more than a few metres from the last, add a class to the marker and set a timer to remove it after a couple of seconds of stillness:

```js
  /* Shared with the area-post trigger: one notion of "moving" for both. */
  function markWalking() {
    if (!hereDot) return;
    var el = hereDot.getElement();
    if (!el) return;
    el.classList.add("is-walking");
    if (walkStopTimer) clearTimeout(walkStopTimer);
    walkStopTimer = setTimeout(function () {
      var e = hereDot && hereDot.getElement();
      if (e) e.classList.remove("is-walking");
    }, 2200);
  }
```

with `var walkStopTimer = null;` beside the other marker state, and a call to `markWalking()` in the `watchPosition` callback whenever the fix moved at all — a lower threshold than the 75 m post, since a waddle should start as soon as you set off.

Assertions for the served script:

```js
  assert.ok(body.includes("function markWalking()"));
  assert.ok(body.includes('classList.add("is-walking")'), "the marker waddles while you move");
```

and for the stylesheet:

```js
  assert.ok(body.includes("@keyframes rb-waddle"));
  assert.ok(body.includes("#ramble .rb-here-pet.is-walking"));
```

- [ ] **Step 5: Style it**

```css
#ramble .rb-here-pet { display: grid; place-items: center; cursor: pointer; }
/* A waddle, not a bob: a small rock about the feet, so an egg on legs and a
   bird read the same way when they walk. Matches the panel's existing motion
   vocabulary (see rb-bob). */
@keyframes rb-waddle {
  0%, 100% { transform: rotate(-4deg) translateY(0); }
  25% { transform: rotate(0deg) translateY(-2px); }
  50% { transform: rotate(4deg) translateY(0); }
  75% { transform: rotate(0deg) translateY(-2px); }
}
#ramble .rb-here-pet.is-walking > * { animation: rb-waddle .7s ease-in-out infinite; transform-origin: 50% 90%; }
#ramble .rb-here-pet .rb-here-bird { width: 46px; height: 46px; filter: drop-shadow(2px 3px 0 var(--rb-shadow-col)); }
#ramble .rb-here-pet .rb-here-egg { width: 30px; height: 38px; filter: drop-shadow(2px 3px 0 var(--rb-shadow-col)); }
```

- [ ] **Step 6: Run and watch it pass**

```
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

**Two existing assertions break here and must be updated, not worked around.** Task 4 set the standard of naming these; this task must meet it:

1. In the served-script test: `assert.ok(body.includes('className: "rb-here-dot"') && body.includes('className: "rb-here-ring"'))`. The dot is retired, so the first half is now false. Change it to assert the ring only, and add the pet-marker assertions from Step 1.
2. In the stylesheet test: `assert.match(body, /\.rb-here-dot/)`. That rule is now dead CSS. Delete the rule from `ramble.css` and the assertion with it — leaving a rule nothing uses is exactly what round 1 condemned.

Also delete these, now dead: `#ramble .rb-here-dot`, `#ramble .rb-perch-btn:focus-visible`, and the `.rb-perch` bird/ring/eggart rules. And **scope the `.rb-say` radius change to `.rb-perch .rb-say`** — the AR sheet has its own `.rb-ar-perch .rb-say` which still sits beside a bird and should keep its tail.

Expected after those: PASS. Re-check the invariants, since this task touches the client script most:

```
grep -c '`' bundles/ramble/panel/static/ramble.js                      # expect 0
grep -cE '\.innerHTML\s*=|\bhtml:\s' bundles/ramble/panel/static/ramble.js   # expect 2
```

If the sink count reads 3, the divIcon was given an `html` option — remove it and append the art instead.

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/server/bird-svg.cjs bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css bundles/ramble/panel/ramble.js tests/ramble-panel.test.js -m "ramble: you are the marker — a walking egg, then a bird, waddling as you move"
```

---

## Task 8: the unlock moment, the seed counter, docs and the bump

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`, `bundles/ramble/panel/ramble.js`, `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`
- Test: `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Consumes: `unlocked` and `seed` from the `POST /api/ramble/area` response (Tasks 3 and 5).
- Produces: client `celebrateUnlock(box)` (a cell FOOTPRINT, not a name) and `paintSeed(n)`; the element `rb-seed-count` in the map bar; `seed` on the `GET /api/ramble/pet` response.

- [ ] **Step 1: Write the failing assertions**

Append to the served-script test in `tests/ramble-panel.test.js`:

```js
  assert.ok(body.includes("function celebrateUnlock("), "a first unlock is celebrated once");
  assert.ok(body.includes("rb-unlock-flash"), "the flash is a rectangle in the fog pane, not an inset shadow the tiles would hide");
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

- [ ] **Step 3b: Give the balance a read path**

Without one the counter can never initialise — it only ever learns a number from an area post that carried a fix, so a user who opens the panel indoors sees a stale or blank count forever. `GET /api/ramble/pet` is already fetched at boot and after every chore, so add the balance to it. In `bundles/ramble/panel/routes.js`, that route's response becomes:

```js
    res.json({ ...pet, bird, egg: { percent: egg.egg.percent }, seed: await mods.walletMod.seedBalance(db) });
```

and in the client's `paintPet`, alongside the other painting:

```js
    paintSeed(pet.seed);
```

- [ ] **Step 4: Celebrate the unlock and paint the counter**

In `bundles/ramble/panel/static/ramble.js`, in the `.then(function (out) { ... })` of the `/api/ramble/area` post, after `currentCells = ...`:

```js
        /* Only when the server actually reported it: the seed key rides ONLY
         * on a post that carried a fix, so treating its absence as zero would
         * blank a real balance on every fix-less post and at boot without geo. */
        if (out && typeof out.seed === "number") paintSeed(out.seed);
        if (out && out.unlocked) celebrateUnlock(out.unlocked);
```

And add:

```js
  /* A first unlock is a moment: flash the exact square just earned, then
   * repaint so the fog has actually retreated from it. The server tells us
   * this was the first time, so it fires once per cell ever, not on every
   * position post.
   *
   * NOT a box-shadow on the map container: an inset shadow paints beneath the
   * container's children, and Leaflet's tile pane is opaque and covers it, so
   * the flash would be invisible. A rectangle in the fog pane is on top of the
   * tiles and is the thing the user actually wants to see light up. */
  function celebrateUnlock(box) {
    var say = $("rb-perch-say");
    if (say) say.textContent = "New ground.";
    /* Its OWN layer, not zoneLayer: drawZones opens with clearLayers(), and
     * the refreshZones below resolves in tens of milliseconds, so a flash
     * parked in zoneLayer would be wiped long before its 900 ms animation
     * finished. */
    var bounds = cellBounds(box);
    if (bounds && hereLayer) {
      /* Pane and layer are independent: the rb-fog PANE (350) keeps the flash
       * under the pet marker instead of painting over it, while hereLayer is
       * the group drawZones never clears. */
      var flash = L.rectangle(bounds, {
        pane: "rb-fog", className: "rb-unlock-flash", stroke: false, interactive: false,
      }).addTo(hereLayer);
      setTimeout(function () { if (hereLayer) hereLayer.removeLayer(flash); }, 900);
    }
    refreshZones();
    refreshMarks();
  }

  function paintSeed(n) {
    if (typeof n !== "number") return;
    var el = $("rb-seed-count");
    if (el) el.textContent = String(n);
  }
```

- [ ] **Step 5: Style the moment**

In `bundles/ramble/panel/static/ramble.css`, beside the other keyframes:

```css
@keyframes rb-unlock {
  0% { fill-opacity: 0; }
  35% { fill-opacity: 0.75; }
  100% { fill-opacity: 0; }
}
#ramble .rb-unlock-flash { fill: var(--rb-accent-2); animation: rb-unlock .9s ease-out; }
#ramble .rb-seed {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 11px; border-radius: 999px;
  border: var(--rb-line-w) solid var(--rb-line);
  background: var(--rb-surface); color: var(--rb-text);
  font: 800 13px var(--rb-font-display);
}
```

Add `#ramble .rb-unlock-flash` and `#ramble .rb-here-pet.is-walking > *` to the FIRST `@media (prefers-reduced-motion: reduce)` block — the one listing `.rb-eggart`, `.rb-bob` and the hatch animations; the file has three such blocks — with the animation off it simply does not appear, which is the right reduced-motion behaviour.

- [ ] **Step 6: Docs, both languages**

In `docs/guide/ramble.md`, after the World name paragraph, add one paragraph (no new heading):

```
**The map unlocks as you walk.** Ground you have actually stood in stays unlocked for good: you can read the marks and caws left there and claim any nest. A few blocks further out is the frontier, where you can see that something is waiting without seeing what it is. Everything beyond that is fog until you go there. Only the public map works this way — a contact's mark always reaches you wherever you are. Walking ground you have already unlocked turns up **bird seed**, which regrows after a day.
```

The guide also carries a **settings table** (`nest.rate`, `shelf.cap`) and a **"what replicates / what stays local"** section. Both need the new entries, or this phase ships undocumented in the two places a user would actually look:

- Settings table, four new rows: `frontier.depth` (3) "how many blocks ahead of your unlocked ground you can see"; `seed.respawn.hours` (24) "how long before bird seed regrows in a place"; `seed.per.pickup` (1) "how much seed a place gives"; `unlock.max.accuracy.m` (100) "how sharp your location has to be before a place counts as visited".
- Replication section: **the map of places you have unlocked, and your seed, follow you between your own Crows — and never go to a contact.** Say the second half explicitly; it is the most sensitive thing this phase creates.

In `docs/es/guide/ramble.md`, the twin, in the same position, plus the same two additions to its settings table and replication section:

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
Expected: the full suite green, no port collisions, registry in sync. Report the ACTUAL numbers. The 4249 figure comes from before this plan was written; re-establish the baseline on a clean checkout before Task 1 so the deltas mean something rather than trusting a number from another day.

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

Expected per database: **no schema delta at all** — `user_version` unchanged, integrity ok, no row-count deltas, schema objects `(none)`, columns `(none)`.

⚠ Do NOT expect to see `ramble_cells` or `ramble_wallet` here. `scripts/init-db.js` contains zero references to any `ramble_` table (verified: `grep -c "ramble_" scripts/init-db.js` returns 0) — Ramble's tables are created at runtime by `initRambleTables`, not by init-db. The dry-run runs init-db against a copy, so a clean run showing nothing is the PASS. Seeing the new tables here would mean somebody wrongly added them to `init-db.js`. Paste the three blocks into the PR body.

---

## Self-review

**Spec coverage.** §2.1 three zones: Tasks 2, 4, 6. §2.2 the frontier making nests findable: Task 2 (depth) plus Task 4 (a frontier nest shows as a beacon). §2.3 seed respawn per cell on a cooldown: Task 5; heart containers are phase 2 and deliberately absent. §2.4 privacy: the table comment in Task 1, the bbox-scoped read in Task 3, the gate in Task 4, and the explicit "never to a contact" line in the guide in Task 8. §6.1 ledgers not balances: Tasks 1 and 5. §6.2 new state: Task 1; wardrobe, worn items and prologue flags are later phases. §6.3 migration: Task 8 Step 10. §6.4 settings: `frontier.depth` (Task 3), `seed.respawn.hours` and `seed.per.pickup` (Task 5), `unlock.max.accuracy.m` (Task 3), all four documented in Task 8. §8 testing, multi-instance for replicated state: Task 1's convergence test plus the emit assertions in Tasks 3 and 5. §9 phase 1 scope: everything is additive; the only removal is the corner perch button, which Task 7 replaces with the map marker at the operator's request.

**Placeholder scan.** None. Every step carries the code or the command. Three places name a judgement rather than a literal, each bounded and each requiring a report rather than a guess: Task 4 Step 5 on an unpredicted third failing test, Task 6 Step 4 on where exactly to build the filtered array, and Task 7 Step 4 on guarding or deleting `paintPerch`'s writes to the retired elements.

**Type consistency.** `recordUnlock(db, cell, { now, emit, accuracyM })` returns `{ unlocked, cell, reason? }` and is called with that shape in Tasks 3 and 5. `recordSeedPickup(db, cell, { now, emit })` returns `{ picked, amount }`. `classifyBbox` returns `{ unlocked, frontier }` as `cellBox` footprints from Task 2 onward, which is what Tasks 6 and 8 draw. `gateForZones({ unlocked, depth, encode })` is identical at its definition and all three call sites (`annotateMarks`, `/nests`, `/around`). `frontierDepth(db)` is defined in Task 3 and used in Tasks 3 and 4. `unlockedCellsNear(db, bbox, depth)` is defined in Task 3 and used in Tasks 3 and 4. `/area`'s `unlocked` field is a footprint object, not a cell name, and Task 8's `celebrateUnlock(box)` consumes it as one. `SEED_KIND` is defined once.

---

## Review

### Round 1 — 2026-09-08, opus, adversarial, source-verified

**Verdict: REVISE.** Ten critical issues, all real, all verified against the source rather than asserted. Every one is folded in above.

- **C1 — nothing emitted, so neither table would have replicated.** Registering a table enables the inbound apply only; outbound requires an explicit `safeEmit`, which every existing Ramble writer does and this plan's writers did not. Worse, the multi-instance test exercised only the apply half, so it would have passed green while the feature was broken — the vacuous-gate failure this project has already paid for. Fixed: both writers take `{ now, emit }` and emit after a successful insert, with emit assertions in Tasks 3 and 5 and an explicit Global Constraint.
- **C2 — a fifth registration site.** `stampSql()` in `servers/shared/sync-stamp.js` has a branch for every id-less Ramble table; without one the local row is never stamped while remote rows are, and no test catches it. Fixed: Task 1 Step 5 now enumerates five sites, including `shouldSyncRow`.
- **C3 — the privacy gate keyed on the wrong column.** `origin` is `"remote"` for a contact's mark too; only `visibility` separates public from contacts, and `contact_name` is not a safe fallback because it excludes pending, blocked and deleted contacts. As written a friend's mark would have been fogged off the user's own map, against D4. Fixed, with a test for a contacts mark that has no matching contact row.
- **C4 — the wrong existing tests were named.** The mark tests do not break (marks created through the API are `origin: "local"`); two nest tests do, and "seed an unlocked cell" was not actionable for them. Fixed: both named, with concrete fixes that compute the deterministic nest and walk to it.
- **C5 — beacons reached code that cannot handle them, and `/around`'s nests were never gated.** Fixed: `/around` gated, and `drawNests`, `toArAnchors` and `drawNearby` all taught to skip beacons.
- **C6 — `continue` inside a `forEach` callback.** Syntax error. Fixed to `return`.
- **C7 — there was no fog.** A `.rb-fog-cell` rule asserted by a test and used by nothing; the shipped result would have been a dim band, not fog of war. Fixed: a real mask, one polygon with the unlocked and frontier cells punched out.
- **C8 — no zoom or view guards on the zones fetch**, so low zoom meant a 400 on every settle with stale rectangles left pinned. Fixed: both guards `refreshNests` already carries, plus clearing the layer when skipping.
- **C9 — the migration dry-run expectation was wrong.** `scripts/init-db.js` has zero `ramble_` references; Ramble's tables are runtime-created, so a clean run showing nothing is the PASS. As written the controller would have stopped on a false alarm or "fixed" it by adding the tables to init-db. Fixed.
- **C10 — `unlockedSetForBbox` was declared and never delivered**, leaving an unbounded read on every map request. Fixed as `unlockedCellsNear`, used by `/zones` and `/nests`.

Also folded from the suggestions: the classifier was computed backwards, costing a measured 61 ms of event-loop-blocking work per map settle, now inverted to expand from the unlocked cells; an accuracy gate on unlocking, because the record is permanent and undeletable and a 2 km wifi fix would otherwise earn one; the leak assertion rebuilt from the real `ramble_marks` columns rather than an invented `text` field; the unlock flash moved off an inset shadow the tile pane would have hidden; `cellsInBbox` throwing on a malformed bbox now caught; the guide's settings table and replication section updated rather than a prose paragraph alone; and an explicit ruling that the MCP tool surface is deliberately not gated in phase 1.

**Added by the operator during the revision:** Task 7, making the location marker the pet itself so it walks the map with you and opens the egg or pet view when tapped, with the corner perch button retired and its status strip kept.

### Round 2 — 2026-09-08, opus, adversarial, source-verified

**Verdict: REVISE.** Twelve critical issues. Round 2's job was to check whether round 1's fixes were real or merely described, and four of them were not fully real. All twelve are folded in above.

- **C1** Task 4's own test contradicted Task 4's own implementation and would have failed: a `contact_name`-only mark is still `visibility: "public"`, so the gate drops it. Fixed, and the underlying question is now an explicit **ruling**: a mark published publicly is public terrain whoever sent it; D4 protects the contacts *channel*, not everyone in your contact list.
- **C2** the `/nests` gate leaked the three synthetic keys it adds to make a nest gateable, breaking the route's shape and the plan's own new assertion. Fixed by stripping them on the way out.
- **C3** Task 7 broke two existing assertions it did not name, after Task 4 had set the standard of naming them. Both now named with their fixes, along with the dead CSS to delete.
- **C4** the new Task 7 put two backticks into a file that forbids them — in a comment, in the very block explaining the sink rule. Fixed, and the constraint now records that the backtick rule is NOT test-enforced, so nothing would have caught it.
- **C5** `isoWeekOf` does not exist anywhere in the repo; the real export is `isoWeek`. Fixed, with the import named.
- **C6** `/around` has no bbox in scope, so "use the identical shape" was not executable; and `toArAnchors` has two loops, only one of which was addressed, while Task 4 creates beacons for both. Both fixed.
- **C7** `MIN_ZONE_ZOOM = 13` did not clear the route's own ceiling — measured at roughly 10,700 cells for a typical map at that zoom, so the 400 the guard existed to prevent would still fire on every settle. Raised to 15, matching `refreshNests`.
- **C8** the fog pane at 450 would have buried the overlay pane at 400, where locked-mark teasers render — including the user's own and their contacts' marks in fogged ground, which D4 protects. Moved to 350, between the tile and overlay panes.
- **C9** the unlock flash was parked in the layer that `drawZones` clears, and `celebrateUnlock` itself fires the refresh, so the 900 ms animation would have been wiped in tens of milliseconds. Moved to its own layer.
- **C10** `paintSeed` treated a missing `seed` key as zero, and round 1 had deliberately made that key conditional — so every fix-less area post would have blanked a real balance. Guarded, and the balance gained a read path on `GET /api/ramble/pet`, without which the counter could never initialise.
- **C11** the Global Constraints still carried the `origin` rule that C3 of round 1 replaced, so an implementer reading top-down met the wrong rule first. Deleted.
- **C12** the `stampSql` snippet bound `lamport` where the parameter is `lamportTs` — two lines that would have thrown. Fixed, with a note that the lamport must be the first placeholder because `subselectStampSql` rewrites it.

Also folded from round 2's suggestions: `annotateMarks` was still doing the unbounded read that round 1's C10 was supposed to have removed, and now derives a bound from the marks' own coordinates; `lastMarks` kept counting beacons in the status strip; the two beacon filters are genuinely separate code paths and the plan said one; the added `/area` post in the nests test perturbs the warmth budget and needs the file's own hatch-threshold trick; `nestsInCells` needs the rate passed or it may compute a different nest than the route returns; `claimedNest` is now assigned explicitly rather than relying on list order; `zones.js`'s "pure" header corrected now that two exports take a database or an encoder; the boot and interval hooks named precisely; the divIcon now takes an Element, which is simpler and still sink-free; the marker gained an accessible name the retired button had; and the beacon's exact position is now a stated ruling rather than an inference.

### Round 3 — 2026-09-08, opus, adversarial, source-verified

**Verdict: REVISE**, three defects, one of them the most consequential of all three rounds. Round 3 confirmed eleven of round 2's twelve fixes as genuinely implemented rather than merely described. All three are folded in.

- **C1 — walking would have unlocked nothing.** Unlocking hangs off `POST /api/ramble/area`, which is called from exactly two places: a debounced `moveend` handler and the boot chain. But a single manual pan sets `following = false`, after which the map never moves itself, `moveend` never fires, and the position watch — which updates the dot on every fix — never posts. So after one pan, no cell unlocks and no seed is harvested for the rest of the session however far the user walks. Even with follow left on, the map only pans when the dot leaves a padded viewport, so a walked route would unlock a sparse sample rather than a trail. **No test in the plan would have caught it, because every test posts `/area` explicitly.** This would have shipped a phase whose entire premise silently did not work. Fixed with a distance-driven post inside the position watch, independent of the map. Verified against source before folding.
- **C2 — two further existing tests break, and Step 5's walk does not save them.** The reviewer measured the geometry: the nest the plan tells the implementer to walk to is 1251 m from the marks fixture's coordinates, far outside a depth-3 frontier, so unlocking it leaves that fixture in fog. One of the two dies with a bare TypeError rather than a readable assertion. Both now named with their fixes, and the warmth-budget remedy extended to cover all four added position posts.
- **C3 — a backtick in Task 8's snippet**, introduced by round 2's own fix, in a file that forbids them — and Task 7's claim that the rule is not test-enforced was false: it is. Both corrected.

Also folded: the File structure's signatures were still pre-round-1; the unlock flash used the `rb-here` pane and would have painted over the pet marker, now the `rb-fog` pane inside the non-clearing layer; the `.rb-say` radius change is scoped at the point it is first written rather than corrected two steps later; `alt` is inert on a divIcon; the reduced-motion block is named rather than left ambiguous; and two rulings are now explicit — that a fix unlocks only the one cell containing it, and that keeping seed-harvest state in the ledger rather than on the cell row is a deliberate deviation from spec §6.2 in favour of §6.1.

**Added by the operator during this revision:** the marker's egg gets legs and both egg and bird waddle while you walk, following from the reframing that you ARE the egg rather than its keeper. It reuses the engine's existing foot shape and the movement detector C1 introduced, so one hook serves both the unlock trigger and the animation.
