# Ramble Flock — Phase 2 (nests, flock roster, egg shelf) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put nests in the world (deterministic per geohash-7 cell and ISO week, claimable within 75 m for an egg on the shelf), give the panel a flock screen (hatched birds, the egg shelf, "8 kinds, N found"), let the user choose which egg incubates and which bird is active, and make it all safe for sync by marking WHY an egg sits on the shelf before any user-shelved egg can exist.

**Architecture:** Same `bundles/ramble` bundle. One pure geometry module (`nests.js`: salt-hashed nest roll, viewport-to-cells cover), one db-facing module (`flock.js`: nest listing with claimed marks, claims, incubate swap, activate, flock state, `nest.rate`/`shelf.cap` settings), a `shelf_origin` column on `ramble_eggs` that instance sync writes on convergence and reads before re-promoting, a local `ramble_nest_claims` table, five panel routes + three MCP tools, one new named SSE event, and a fourth panel view (`flock`) plus egg pins on the map. No new replicated table (`ramble_trades` is phase 3), no new host port, no `SCHEMA_GENERATION` bump, no transport change.

**Tech Stack:** Node ESM (bundle + core), libsql-shaped async DB client via `app-root.js`, `zod`, `node:crypto` sha256, plain-script client with Leaflet 1.9.4 (vendored, unchanged), SSE via `servers/shared/event-bus.js`.

**Spec:** `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` — §2.4 (nests + claiming), §2.5 (incubation + flock), §3 flock screen + nest pins, §5 `ramble_nest_claims` / `ramble_eggs.status` values / settings, §7 routes + tools + `ramble:nest-claimed`, §9 limits, §10 tests, §11 item 2. Phase-1 plan (constraints carried verbatim below): `docs/superpowers/plans/2026-09-07-ramble-flock-phase1-home-bird-egg.md`. Handoff with the rulings to carry: `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase1-shipped-pr311.md`.

## Global Constraints

Phase-1 constraints still bind (copied, with the phase-2 deltas marked **[P2]**):

- **DB access:** bundle server code reaches the DB only through `server/app-root.js` → `appImport("servers/db.js")` / the bundle's `createDbClient()` (never a second SQLite driver in the gateway process). Client is async libsql-shaped: `await db.execute({ sql, args })`, `await db.executeMultiple(sql)`, `await db.batch([...])`.
- **No `SCHEMA_GENERATION` bump:** new columns via `PRAGMA table_info` + guarded `ALTER TABLE` in `bundles/ramble/server/init-tables.js` (`ensureColumn`); new tables via `CREATE TABLE IF NOT EXISTS`. Never edit `scripts/init-db.js`.
- **Every replicated table carries `lamport_ts INTEGER DEFAULT 0`** and needs: an entry in `SYNCED_TABLES`, `EXCLUDED_COLUMNS` (at least `["lamport_ts"]`), a natural-key apply handler (LWW on the envelope lamport), a `shouldSyncRow` gate, a `stampSql` by-key branch (`servers/shared/sync-stamp.js`), and both outbox-door and apply-door tests. **[P2]** Phase 2 adds NO new replicated table: `ramble_nest_claims` is local (spec §5) and MUST NOT be added to `SYNCED_TABLES` (a test asserts it). The one replicated change is the new `ramble_eggs.shelf_origin` column, which joins `RAMBLE_EGG_WIRE_COLUMNS` (Task 1). The emit hook shape everywhere is `emit(table, op, row)`; in the stdio process it is `emitOrQueue(null, db, …)`, in the gateway `emitOrQueue(getInstanceSyncManager(), db, …)`.
- **Seeds are server-minted, immutable, never accepted from a client.** `bird = { species ∈ ROSTER, seed ∈ uint32 }`. **[P2]** A nest's `seed` (for its egg art) is derived from the nest hash server-side; the client only ever echoes `cell` + `week` back.
- **Credits are idempotent server-side** via `ramble_credits(kind, key)`. **[P2]** Claiming a nest credits NO warmth and feeds NO pet energy (spec §2.1's weight table has no claim row; the egg is the reward). Deliberate deviation from §7's "the new ones (…, claim) call the one function" — recorded here so nobody adds a `feedAll` call to the claim path.
- **Warmth weights and thresholds are settings** (`warmth.*`), read with defaults. **[P2]** So are `nest.rate` (default **24**, integer ≥ 1) and `shelf.cap` (default **5**, integer ≥ 0; 0 means claiming is off), read live on every call via `readFlockSettings(db)`; never hard-coded in handlers.
- **Nest determinism (spec §2.4, exact):** `h = sha256("ramble-nest-v1:" + cell7 + ":" + isoWeek)` as raw bytes; a nest exists iff `h.readUInt32BE(0) % rate === 0`; its point is the cell's south-west corner plus `(h.readUInt32BE(4) / 2^32) × cell height` north and `(h.readUInt32BE(8) / 2^32) × cell width` east (always inside the cell); its art seed is `h.readUInt32BE(12)`. Same answer on every device, no server state. Claim radius is `withinRange`'s **75 m**. Limits: **1 claim per local day** per instance, **shelf cap 5** (counting `status='shelf' AND shelf_origin='user'` rows — see the next bullet). Claims are idempotent per `(cell, week)`.
- **Shelf origin (the ruling this phase exists to honour):** `ramble_eggs.shelf_origin TEXT` ∈ `NULL | 'sync' | 'user'`. `'sync'` = the sync layer put the egg where it is (shelved as a convergence loser, OR re-promoted into the incubating slot by `RAMBLE_EGG_REPROMOTE_SQL`); `'user'` = placed on the shelf by the user (claimed from a nest, or swapped out by incubate); NULL = a plain egg (minted by `ensureIncubatingEgg`, or chosen by the user through incubate). Instance sync re-promotes ONLY `shelf_origin = 'sync'` shelf eggs, never `'user'`, skips re-promotion entirely when the op being applied is itself a user shelve, and a promotion KEEPS the `'sync'` mark. **Convergence class rule:** when two incubating eggs meet, a NULL-origin egg beats a `'sync'`-origin egg regardless of age; only between equals does the phase-1 tiebreak (older `created_at`, then lower `egg_id`) apply. This is what keeps a sync-promoted old loser from overriding the user's explicit incubate choice (review round 1, C1). A one-line idempotent backfill in `initRambleTables` turns legacy NULL shelf rows into `'sync'`.
- **Shelf cap counts `'user'` shelf eggs only** (`status='shelf' AND shelf_origin='user'`): sync losers that land on the shelf from instance races must never eat the user's five spots (review round 1, S5).
- **Wire:** unchanged from phase 1 (kinds 30397/20397, `bird` on public marks). Nests and claims never touch Nostr.
- **Panel rules:** `router.use("/api/ramble", dashboardAuth)` path-scoped (never unpathed); client script `static/ramble.js` contains ZERO backticks; remote/user text is written with `textContent` only — the only `innerHTML`/`html:` sinks are engine output from a numeric seed (`RambleBird.mountBird`, `drawEgg`); never `express.static`; nothing under `PUBLIC_FUNNEL_PREFIXES`; every input bounded (regex/`.max`, enums); icons are inline SVG, never emoji.
- **Visual direction C tokens** (spec §8) are the only palette; reuse the `--rb-*` tokens and the existing component classes (`rb-card`, `rb-step`, `rb-chore`, `rb-btn`, `rb-eyebrow`, `rb-tag` new) — no new colours.
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` then `node scripts/run-suite.mjs tests/<file>.test.js` (never bare `node --test`). In-memory `createClient({ url: "file::memory:" })` from `@libsql/client` in TEST files only; bundle server files never import it.
- **Commits:** subject-only, positional paths (`git commit <paths> -m …`), verify `git show --stat HEAD`, **no AI attribution trailers of any kind**. Work in `/home/kh0pp/crow-wt-flock2` (branch `feat/ramble-flock-phase2`), never `git checkout` a branch in `~/crow`. `main` is protected: PR + green `suite`/`static-checks`/`audit` check-runs on the head sha.
- **Bundle version bump is mandatory:** installed copies (`~/.crow/bundles/ramble/`) refresh only on a manifest version delta. `bundles/ramble/manifest.json` and `bundles/ramble/package.json` go `0.2.0` → `0.3.0` and `npm run build-registry` regenerates `registry/add-ons.json` (CI runs `build-registry --check`). Done in Task 8, before the PR.
- **Base:** branch from `main` at `15a67f25` (PR #313 merge) or later.
- **Models:** nothing in this phase starts a model; `CROW-SCHEDULE.md` need not be touched.

---

## File structure

```
bundles/ramble/server/
  init-tables.js     MODIFY: ramble_eggs.shelf_origin (ALTER + backfill); ramble_nest_claims table
  nests.js           NEW (pure, no db): NEST_SALT, NEST_RATE_DEFAULT, CELL7_RE, MAX_NEST_CELLS,
                     nestFor(cell, week, {rate}), cellsInBbox(bbox, {max}), nestsInCells(cells, week, {rate})
  flock.js           NEW (db): readFlockSettings, listNests, claimNest, incubateEgg, activateBird, flockState,
                     SHELF_CAP_DEFAULT, CLAIM_RANGE_M, CLAIMS_PER_DAY
  eggs.js            MODIFY: export startOfLocalDay (one word)
  server.js          MODIFY: tools ramble_flock, ramble_nests, ramble_claim_nest
bundles/ramble/panel/
  routes.js          MODIFY: GET nests, POST nests/claim, GET flock, POST eggs/:id/incubate, POST birds/:id/activate
  ramble.js          MODIFY: flock view markup; "My flock"/"Flock" buttons on pet + egg views
  static/ramble.css  MODIFY: nest pin, flock grid, shelf rows, tag
  static/ramble.js   MODIFY: nests layer + claim popup, flock view, incubate/activate, nest-claimed SSE
bundles/ramble/manifest.json, package.json   MODIFY: 0.3.0
registry/add-ons.json                        REGENERATED
servers/sharing/instance-sync.js   MODIFY: shelf_origin on the wire; convergence writes 'sync'; re-promote filter + gate
servers/gateway/routes/streams.js  MODIFY: ramble:nest-claimed -> event: ramble-nest-claimed
docs/guide/ramble.md, docs/es/guide/ramble.md   MODIFY: nests, flock, shelf, settings, tools

tests/
  ramble-sync.test.js    MODIFY (Task 1 + Task 3 outbox door)
  ramble-tables.test.js  MODIFY (column, backfill, claims table, not synced)
  ramble-nests.test.js   NEW
  ramble-flock.test.js   NEW
  ramble-tools.test.js   MODIFY
  ramble-panel.test.js   MODIFY
  ramble-stream.test.js  MODIFY
```

**Milestones:** M1 = the marker + model (Tasks 1–4). M2 = doors (Tasks 5–6). M3 = surface + ship (Tasks 7–8).

---

## Task 1: Shelf-origin marker on `ramble_eggs` (sync-safe shelf)

**Files:**
- Modify: `bundles/ramble/server/init-tables.js` (after the `ramble_eggs` CREATE, before `ramble_credits`)
- Modify: `servers/sharing/instance-sync.js:536-750` (`RAMBLE_EGG_WIRE_COLUMNS`, `RAMBLE_EGG_REPROMOTE_SQL`, `applyRambleEgg`)
- Test: `tests/ramble-tables.test.js`, `tests/ramble-sync.test.js`

**Interfaces:**
- Consumes: phase-1 `applyRambleEgg` convergence rule (older `created_at` wins, ties by lower `egg_id`, loser shelved in the same batch) and `RAMBLE_EGG_REPROMOTE_SQL`.
- Produces: column `ramble_eggs.shelf_origin TEXT` (NULL | `'sync'` | `'user'`) on every instance, on the wire, honoured by re-promotion (only `'sync'`, mark kept) and by the convergence class rule (NULL beats `'sync'`). Later tasks write `'user'` from `claimNest` / `incubateEgg` (and NULL for the egg incubate chooses) and rely on this task so those eggs are never auto-promoted or out-ranked by a promoted loser.

- [ ] **Step 1: Add the failing table tests** to `tests/ramble-tables.test.js` (append):

```js
test("phase 2: ramble_eggs.shelf_origin exists and legacy NULL shelf rows backfill to 'sync'", async () => {
  const cols = (await db.execute("PRAGMA table_info(ramble_eggs)")).rows.map((r) => r.name);
  assert.ok(cols.includes("shelf_origin"), "ramble_eggs.shelf_origin");
  // A phase-1 convergence loser on disk has no origin. Re-running init (every
  // boot does) must mark it 'sync' so re-promotion can still pick it up, and
  // must leave a user-shelved egg alone.
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('legacy','shelf',5,1)", args: [] });
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('mine','shelf',5,2,'user')", args: [] });
  await initRambleTables(db);
  const got = await db.execute("SELECT egg_id, shelf_origin FROM ramble_eggs WHERE egg_id IN ('legacy','mine') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.shelf_origin]), [["legacy", "sync"], ["mine", "user"]]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/run-suite.mjs tests/ramble-tables.test.js`
Expected: FAIL — `ramble_eggs.shelf_origin` missing.

- [ ] **Step 3: Add the column + backfill** in `bundles/ramble/server/init-tables.js`, directly after the `ramble_eggs` `initTable(...)` call:

```js
  // Phase 2: WHY an egg is on the shelf. 'sync' = a convergence loser (the
  // sync layer may re-promote it when the incubating slot empties); 'user' =
  // the user put it there (claimed from a nest, or swapped out by incubate)
  // and it must NEVER be auto-promoted. Phase 1 only ever shelved convergence
  // losers, so a NULL shelf row on disk is one of those: backfill it to 'sync'
  // (idempotent, and a 'user' row is never NULL so it is never touched).
  await ensureColumn(db, "ramble_eggs", "shelf_origin", "TEXT");
  await db.execute({
    sql: "UPDATE ramble_eggs SET shelf_origin = 'sync' WHERE status = 'shelf' AND shelf_origin IS NULL",
    args: [],
  });
```

- [ ] **Step 4: Run the table test**

Run: `node scripts/run-suite.mjs tests/ramble-tables.test.js`
Expected: PASS.

- [ ] **Step 5: Add the failing sync tests** to `tests/ramble-sync.test.js` (append at the end; `freshDb` already exists in the file):

```js
// ------------------------------------------ Phase 2 Task 1: shelf origin marker

test("shelf_origin rides the wire and a convergence loser is marked 'sync' on both sides", async () => {
  const d = await freshDb();
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "u1", status: "shelf", shelf_origin: "user", warmth: 0, created_at: 100 }, 1);
  assert.equal((await d.execute("SELECT shelf_origin FROM ramble_eggs WHERE egg_id='u1'")).rows[0].shelf_origin, "user");

  // Local incubating egg loses to an older peer egg -> it is shelved AND marked 'sync'.
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('local-z','incubating',30,2000)");
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "peer-a", status: "incubating", warmth: 10, created_at: 1000 }, 4);
  let got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs WHERE egg_id IN ('local-z','peer-a') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["local-z", "shelf", "sync"], ["peer-a", "incubating", null]]);

  // An incoming newer egg loses -> stored as shelf + 'sync' even though the wire row said incubating.
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "peer-b", status: "incubating", warmth: 5, created_at: 5000 }, 5);
  got = await d.execute("SELECT status, shelf_origin FROM ramble_eggs WHERE egg_id='peer-b'");
  assert.deepEqual([got.rows[0].status, got.rows[0].shelf_origin], ["shelf", "sync"]);
});

test("re-promotion picks only a 'sync' egg and clears its origin; a user-shelved egg never moves", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('user-old','shelf',9,500,'user')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('loser','shelf',3,700,'sync')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('x','incubating',60,1000)");
  // x hatches on a peer: the slot empties. The OLDEST shelf egg is the user's
  // (500) — it must be skipped; the convergence loser (700) is promoted.
  await applyRemoteOp(d, "ramble_eggs", "update",
    { egg_id: "x", status: "hatched", warmth: 100, species: "crow", seed: 7, created_at: 1000, hatched_at: 1500 }, 6);
  const got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  // The promoted egg KEEPS its 'sync' mark: the sync layer put it in the slot,
  // and that class ranks below any NULL-origin egg in the convergence rule.
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]),
    [["loser", "incubating", "sync"], ["user-old", "shelf", "user"], ["x", "hatched", null]]);
});

test("class rule: a NULL-origin incubating egg beats a sync-promoted one regardless of age, on both sides", async () => {
  // Round-1 C1 scenario. A and B share X (incubating) and an ancient loser L.
  // X hatches on A; A mints successor N. B applies X-hatched -> promotes L.
  // N then arrives at B: without the class rule L (older) would win and the
  // fleet would diverge; with it N wins on B. Symmetrically, when B's
  // promoted L reaches A, A keeps N. Same for a user's later incubate choice Y.
  const A = await freshDb(); const B = await freshDb();
  for (const d of [A, B]) {
    await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('L','shelf',3,100,'sync')");
    await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('X','incubating',90,1000)");
  }
  const xHatched = { egg_id: "X", status: "hatched", warmth: 100, species: "crow", seed: 7, created_at: 1000, hatched_at: 1500 };
  const nRow = { egg_id: "N", status: "incubating", warmth: 0, created_at: 1500, shelf_origin: null };
  // A hatched locally (stand-in) and minted N.
  await A.execute("UPDATE ramble_eggs SET status='hatched', species='crow', seed=7, hatched_at=1500 WHERE egg_id='X'");
  await A.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('N','incubating',0,1500)");
  // B applies the hatch: L is promoted and marked 'sync'.
  await applyRemoteOp(B, "ramble_eggs", "update", xHatched, 5);
  let b = await B.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs WHERE status='incubating'");
  assert.deepEqual(b.rows.map((r) => [r.egg_id, r.shelf_origin]), [["L", "sync"]]);
  // N arrives at B: NULL beats 'sync' even though L is older.
  await applyRemoteOp(B, "ramble_eggs", "insert", nRow, 6);
  b = await B.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(b.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["L", "shelf", "sync"], ["N", "incubating", null], ["X", "hatched", null]]);
  // B's promoted L (from before N arrived) reaches A: A keeps N.
  await applyRemoteOp(A, "ramble_eggs", "update", { egg_id: "L", status: "incubating", warmth: 3, created_at: 100, shelf_origin: "sync" }, 6);
  const a = await A.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(a.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["L", "shelf", "sync"], ["N", "incubating", null], ["X", "hatched", null]]);
  // A PHASE-1 peer (rolling restart) emits L incubating with NO shelf_origin
  // key at all: the class rule must fall back to the 'sync' this instance
  // already holds for L, so N still wins (round 2, N1).
  await applyRemoteOp(A, "ramble_eggs", "update", { egg_id: "L", status: "incubating", warmth: 4, created_at: 100 }, 7);
  assert.deepEqual((await A.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows.map((r) => r.egg_id), ["N"]);
  // ...and a phase-1 peer's shelf row with no key lands as 'sync' (re-promotable), never NULL.
  await applyRemoteOp(A, "ramble_eggs", "insert", { egg_id: "P1", status: "shelf", warmth: 1, created_at: 50 }, 8);
  assert.equal((await A.execute("SELECT shelf_origin FROM ramble_eggs WHERE egg_id='P1'")).rows[0].shelf_origin, "sync");
  // Two NULL-origin eggs still settle by the phase-1 order (older wins).
  await applyRemoteOp(A, "ramble_eggs", "insert", { egg_id: "Z", status: "incubating", warmth: 0, created_at: 3000, shelf_origin: null }, 7);
  assert.deepEqual((await A.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows.map((r) => r.egg_id), ["N"]);
  // ...and two 'sync' eggs too.
  const C = await freshDb();
  await C.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('s-new','incubating',0,2000,'sync')");
  await applyRemoteOp(C, "ramble_eggs", "insert", { egg_id: "s-old", status: "incubating", warmth: 0, created_at: 1000, shelf_origin: "sync" }, 1);
  assert.deepEqual((await C.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows.map((r) => r.egg_id), ["s-old"]);
});

test("with no 'sync' egg on the shelf the slot simply stays empty (a user egg is not drafted)", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('mine','shelf',9,500,'user')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('x','incubating',60,1000)");
  await applyRemoteOp(d, "ramble_eggs", "delete", { egg_id: "x" }, 6);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 0);
  assert.equal((await d.execute("SELECT status FROM ramble_eggs WHERE egg_id='mine'")).rows[0].status, "shelf");
});

test("a peer's user-shelve does not trigger re-promotion (the user's replacement egg is on its way)", async () => {
  // A's user incubates X and thereby shelves Y ('user'). B still has Y
  // incubating and an ancient convergence loser L on its shelf. If Y's shelve
  // re-promoted L, L (older than X) would then beat X on B AND, once L's next
  // warmth emit reached A, on A too — overriding the user's explicit choice.
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('L','shelf',3,100,'sync')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('Y','incubating',40,1000)");
  await applyRemoteOp(d, "ramble_eggs", "update", { egg_id: "Y", status: "shelf", shelf_origin: "user", warmth: 40, created_at: 1000 }, 7);
  let got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["L", "shelf", "sync"], ["Y", "shelf", "user"]]);
  // Then X arrives with no rival and takes the slot.
  await applyRemoteOp(d, "ramble_eggs", "update", { egg_id: "X", status: "incubating", shelf_origin: null, warmth: 0, created_at: 3000, found_cell: "9v6m21h" }, 8);
  got = await d.execute("SELECT egg_id, status FROM ramble_eggs WHERE status='incubating'");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["X", "incubating"]]);
});
```

- [ ] **Step 6: Run to see them fail**

Run: `node scripts/run-suite.mjs tests/ramble-sync.test.js`
Expected: the five new tests FAIL (unknown column on the wire / loser without origin / user egg promoted / class rule absent).

- [ ] **Step 7: Implement in `servers/sharing/instance-sync.js`.**

(a) `RAMBLE_EGG_WIRE_COLUMNS` gains `"shelf_origin"` at the end:

```js
const RAMBLE_EGG_WIRE_COLUMNS = [
  "egg_id", "status", "warmth", "species", "seed",
  "found_cell", "found_week", "from_crow_id", "created_at", "hatched_at",
  "shelf_origin",
];
```

(b) Replace `RAMBLE_EGG_REPROMOTE_SQL` and its comment:

```js
/**
 * Refill the incubating slot when an apply emptied it — but ONLY with an egg
 * the sync layer itself shelved. `shelf_origin = 'sync'` marks a convergence
 * loser; `'user'` marks an egg the user parked deliberately (claimed from a
 * nest, or swapped out by "incubate"), which must never be drafted back in.
 * The promoted egg KEEPS its 'sync' mark ("the sync layer put this in the
 * slot"): in `applyRambleEgg`'s convergence rule a 'sync' incubating egg ranks
 * below any NULL-origin one (a fresh successor, or the user's own choice), so
 * a promotion can never out-rank the egg that is really meant to be there once
 * it arrives. Oldest `created_at` first, ties by lowest `egg_id`.
 */
const RAMBLE_EGG_REPROMOTE_SQL = `
  UPDATE ramble_eggs SET status = 'incubating'
   WHERE egg_id = (
           SELECT egg_id FROM ramble_eggs WHERE status = 'shelf' AND shelf_origin = 'sync'
            ORDER BY created_at ASC, egg_id ASC LIMIT 1
         )
     AND NOT EXISTS (SELECT 1 FROM ramble_eggs WHERE status = 'incubating')`;
```

(c) In `applyRambleEgg`, FIRST widen the existing-row SELECT at the top of the function (`instance-sync.js:678-681`) so the class rule can see the local origin — without this the fallback below is dead code (round 2, N1):

```js
  const { rows: existing } = await db.execute({
    sql: `SELECT lamport_ts, created_at, status, shelf_origin FROM ramble_eggs WHERE egg_id = ?`,
    args: [row.egg_id],
  });
```

Then work on a copy of the wire row so a demotion can set BOTH columns, mark the rival `'sync'`, and gate the re-promotion. Replace the body from `let status = row.status;` through the final `await db.batch(statements);` with:

```js
  // Effective wire row: a copy, so a convergence demotion can rewrite status
  // AND shelf_origin without mutating the caller's object.
  const wire = { ...row };
  // A phase-1 peer's shelf row carries no shelf_origin at all. Phase 1 only
  // ever shelved convergence losers, so it means 'sync' (same reasoning as the
  // init-tables backfill) — otherwise it would sit as NULL, never re-promotable,
  // until this instance's next boot.
  if (wire.status === "shelf" && wire.shelf_origin === undefined) wire.shelf_origin = "sync";
  const statements = [];

  if (wire.status === "incubating" && existing[0]?.status !== "hatched") {
    const { rows: incubating } = await db.execute({
      sql: `SELECT egg_id, created_at, shelf_origin FROM ramble_eggs WHERE status = 'incubating' AND egg_id <> ? LIMIT 1`,
      args: [wire.egg_id],
    });
    const rival = incubating[0];
    if (rival) {
      // Class first: an egg the sync layer promoted ('sync') loses to any
      // plain egg (NULL: a fresh successor, or the user's incubate choice),
      // whatever their ages. Only between equals does age decide. Both sides
      // evaluate the same two rows (shelf_origin rides the wire), so this is
      // still a pure function of the pair. A wire row that omits shelf_origin
      // (a phase-1 peer during a rolling restart) falls back to what THIS
      // instance already knows about the egg — a loser it shelved as 'sync'
      // must not come back as a plain egg and out-rank the real one by age.
      const mineSync = (wire.shelf_origin ?? existing[0]?.shelf_origin ?? null) === "sync";
      const theirsSync = rival.shelf_origin === "sync";
      const mine = Number(wire.created_at ?? existing[0]?.created_at ?? Number.MAX_SAFE_INTEGER);
      const theirs = Number(rival.created_at);
      const incomingWins = mineSync !== theirsSync
        ? theirsSync
        : (mine < theirs || (mine === theirs && String(wire.egg_id) < String(rival.egg_id)));
      if (incomingWins) {
        statements.push({
          sql: `UPDATE ramble_eggs SET status = 'shelf', shelf_origin = 'sync' WHERE egg_id = ?`,
          args: [rival.egg_id],
        });
      } else {
        wire.status = "shelf";
        wire.shelf_origin = "sync";
      }
    }
  }

  const cols = RAMBLE_EGG_WIRE_COLUMNS.filter((c) => wire[c] !== undefined);
  const values = cols.map((c) => wire[c] ?? null);
  const setClauses = [
    ...cols.filter((c) => RAMBLE_EGG_UPDATE_COLUMNS.includes(c)).map(rambleEggSetClause),
    "lamport_ts = excluded.lamport_ts",
  ];

  statements.push({
    sql: `INSERT INTO ramble_eggs (${cols.join(", ")}, lamport_ts)
          VALUES (${cols.map(() => "?").join(", ")}, ?)
          ON CONFLICT(egg_id) DO UPDATE SET ${setClauses.join(", ")}`,
    args: [...values, lamportTs],
  });

  // A peer's USER shelve is half of an "incubate" swap: the replacement egg's
  // own row follows in the same drain. Re-promoting here would draft an old
  // convergence loser into the slot, which then out-ranks the user's real
  // choice by created_at on both sides. Every other apply may refill the slot.
  const isUserShelve = wire.status === "shelf" && wire.shelf_origin === "user";
  if (!isUserShelve) statements.push({ sql: RAMBLE_EGG_REPROMOTE_SQL, args: [] });

  await db.batch(statements);
```

(c2) In `rambleEggSetClause` add a branch so a peer's later user-shelve can never stamp an origin onto a row this instance already hatched (birds never read it, but a hatched row saying `'user'` is incoherent):

```js
    case "shelf_origin":
      return `shelf_origin = CASE WHEN ramble_eggs.status = 'hatched' THEN ramble_eggs.shelf_origin ELSE excluded.shelf_origin END`;
```

(d) Update the `applyRambleEgg` doc comment: item 2 gains "class first — a `'sync'`-origin incubating egg loses to a NULL-origin one; age decides only between equals"; item 3 becomes "re-promotes the oldest `shelf_origin = 'sync'` shelf egg (never a `'user'` one), keeping its mark, and not at all when the op applied is a user shelve". `rambleEggSetClause` changes only by the (c2) `shelf_origin` branch; every other column keeps its phase-1 clause.

(e) Mixed-version note for the deploy (Task 8 Step 7): `applyRambleEgg` lives in core, so a gateway still on phase-1 core drops `shelf_origin` from an incoming row and could re-promote a `'user'` egg locally. Every gateway in the fleet must be restarted onto this commit before anyone claims a nest.

- [ ] **Step 8: Run the sync + tables + eggs tests**

Run: `node scripts/run-suite.mjs tests/ramble-sync.test.js tests/ramble-tables.test.js tests/ramble-eggs.test.js`
Expected: all PASS, including the phase-1 "shelved convergence loser is re-promoted" test (its loser is now marked `'sync'` by the rule).

- [ ] **Step 9: Commit**

```bash
git commit bundles/ramble/server/init-tables.js servers/sharing/instance-sync.js tests/ramble-tables.test.js tests/ramble-sync.test.js -m "ramble: shelf_origin marker on ramble_eggs; sync re-promotes only convergence losers"
git show --stat HEAD
```

---

## Task 2: `nests.js` — deterministic nests (pure)

**Files:**
- Create: `bundles/ramble/server/nests.js`
- Test: `tests/ramble-nests.test.js`

**Interfaces:**
- Consumes: `encodeGeohash`, `decodeGeohash` from `./anchors.js`.
- Produces:
  - `NEST_SALT = "ramble-nest-v1:"`, `NEST_RATE_DEFAULT = 24`, `CELL7_RE = /^[0-9b-hjkmnp-z]{7}$/`, `WEEK_RE = /^\d{4}-W\d{2}$/`, `MAX_NEST_CELLS = 8192`, `CELL7_LAT_STEP = 180 / 2 ** 17`, `CELL7_LON_STEP = 360 / 2 ** 18`.
  - `nestFor(cell, week, { rate } = {}) -> { cell, week, lat, lon, seed } | null` (throws on a malformed cell/week).
  - `cellsInBbox({ south, west, north, east }, { max } = {}) -> string[] | null` (null when the cover would exceed `max` cells).
  - `nestsInCells(cells, week, { rate } = {}) -> nest[]` (order of `cells`, nulls dropped).

- [ ] **Step 1: Write the failing tests** — `tests/ramble-nests.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeGeohash, decodeGeohash } from "../bundles/ramble/server/anchors.js";
import {
  nestFor, cellsInBbox, nestsInCells,
  NEST_SALT, NEST_RATE_DEFAULT, MAX_NEST_CELLS, CELL7_LAT_STEP, CELL7_LON_STEP,
} from "../bundles/ramble/server/nests.js";

const WEEK = "2026-W37";

/** Walk north from a start point until nestFor says there is a nest. */
function findNestCell(week, rate = NEST_RATE_DEFAULT) {
  for (let i = 0; i < 2000; i++) {
    const cell = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(cell, week, { rate })) return cell;
  }
  throw new Error("no nest found in 2000 cells — the hash or the rate is broken");
}

test("nestFor is the spec's exact formula: salt, sha256, uint32 mod rate, offsets inside the cell", () => {
  const cell = findNestCell(WEEK);
  const nest = nestFor(cell, WEEK);
  const h = createHash("sha256").update(NEST_SALT + cell + ":" + WEEK).digest();
  assert.equal(h.readUInt32BE(0) % NEST_RATE_DEFAULT, 0);
  const { lat, lon, latErr, lonErr } = decodeGeohash(cell);
  assert.ok(Math.abs(nest.lat - (lat - latErr + (h.readUInt32BE(4) / 2 ** 32) * 2 * latErr)) < 1e-12);
  assert.ok(Math.abs(nest.lon - (lon - lonErr + (h.readUInt32BE(8) / 2 ** 32) * 2 * lonErr)) < 1e-12);
  assert.equal(nest.seed, h.readUInt32BE(12));
  assert.equal(nest.cell, cell); assert.equal(nest.week, WEEK);
  // The point never leaves its own cell (the claim path re-derives the cell from it).
  assert.equal(encodeGeohash(nest.lat, nest.lon, 7), cell);
});

test("same inputs -> same nest on two 'devices'; a different week re-rolls", () => {
  const cell = findNestCell(WEEK);
  assert.deepEqual(nestFor(cell, WEEK), nestFor(cell, WEEK));
  let differs = false;
  for (let w = 1; w <= 52 && !differs; w++) {
    const other = nestFor(cell, "2026-W" + String(w).padStart(2, "0"));
    if (!other || other.seed !== nestFor(cell, WEEK).seed) differs = true;
  }
  assert.ok(differs, "every week rolled the identical nest");
});

test("rate is honoured: about 1 nest per `rate` cells, and rate 1 means every cell", () => {
  const cells = [];
  for (let i = 0; i < 2400; i++) cells.push(encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7));
  const n24 = nestsInCells(cells, WEEK).length;
  assert.ok(n24 > 50 && n24 < 150, `expected ~100 nests in 2400 cells at rate 24, got ${n24}`);
  assert.equal(nestsInCells(cells, WEEK, { rate: 1 }).length, cells.length);
  assert.equal(nestFor(cells[0], WEEK, { rate: 0 }), nestFor(cells[0], WEEK), "a bad rate falls back to the default");
});

test("nestFor rejects a non-7 cell and a malformed week", () => {
  assert.throws(() => nestFor("9v6m2", WEEK));
  assert.throws(() => nestFor("9v6m21h", "week 37"));
  assert.throws(() => nestFor("9v6m21H", WEEK));
});

test("cellsInBbox covers exactly the intersecting cells and refuses a cover wider than max", () => {
  const c = decodeGeohash("9v6m21h");
  const tiny = { south: c.lat - c.latErr / 2, west: c.lon - c.lonErr / 2, north: c.lat + c.latErr / 2, east: c.lon + c.lonErr / 2 };
  assert.deepEqual(cellsInBbox(tiny), ["9v6m21h"]);

  // ~3 x 3 cells around the centre: every cell touching the box, no duplicates.
  const box = { south: c.lat - 1.2 * 2 * c.latErr, west: c.lon - 1.2 * 2 * c.lonErr, north: c.lat + 1.2 * 2 * c.latErr, east: c.lon + 1.2 * 2 * c.lonErr };
  const cells = cellsInBbox(box);
  assert.equal(new Set(cells).size, cells.length);
  assert.ok(cells.includes("9v6m21h"));
  assert.ok(cells.length >= 9 && cells.length <= 16, `got ${cells.length}`);
  for (const cell of cells) {
    const d = decodeGeohash(cell);
    assert.ok(d.lat + d.latErr >= box.south && d.lat - d.latErr <= box.north, cell + " outside (lat)");
    assert.ok(d.lon + d.lonErr >= box.west && d.lon - d.lonErr <= box.east, cell + " outside (lon)");
  }

  const wide = { south: 30, west: -99, north: 30.2, east: -98.8 }; // ~146 x 146 cells
  assert.equal(cellsInBbox(wide), null, "the max check must run before any hashing");
  assert.ok(cellsInBbox(wide, { max: 10 ** 6 }).length > MAX_NEST_CELLS);
  assert.throws(() => cellsInBbox({ south: 1, west: 0, north: 0, east: 1 }));
  assert.throws(() => cellsInBbox({ south: "a", west: 0, north: 1, east: 1 }));
});

test("cellsInBbox clamps at the poles and the antimeridian instead of throwing", () => {
  assert.ok(Array.isArray(cellsInBbox({ south: 89.999, west: 179.999, north: 90, east: 180 })));
  assert.ok(Array.isArray(cellsInBbox({ south: -90, west: -180, north: -89.999, east: -179.999 })));
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node scripts/run-suite.mjs tests/ramble-nests.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `bundles/ramble/server/nests.js`**

```js
/**
 * Ramble nests — deterministic spawn points in the world (spec §2.4).
 *
 * Pure: no db, no clock. A nest is a function of (geohash-7 cell, ISO week)
 * under a PUBLIC salt, so every device computes the same nests with no
 * server round trip and nothing to replicate. flock.js layers claims,
 * settings and the db on top; this file must stay importable in the browser
 * someday (phase 4 AR) and in tests without a db.
 */
import { createHash } from "node:crypto";
import { encodeGeohash, decodeGeohash } from "./anchors.js";

export const NEST_SALT = "ramble-nest-v1:";
export const NEST_RATE_DEFAULT = 24;
export const CELL7_RE = /^[0-9b-hjkmnp-z]{7}$/;
export const WEEK_RE = /^\d{4}-W\d{2}$/;
/** A geohash-7 cell is 17 lat bits by 18 lon bits (~153 m square). */
export const CELL7_LAT_STEP = 180 / 2 ** 17;
export const CELL7_LON_STEP = 360 / 2 ** 18;
/** Hard ceiling on cells one nests query may cover (8192 sha256 ~ 10 ms). */
export const MAX_NEST_CELLS = 8192;

function effectiveRate(rate) {
  return Number.isInteger(rate) && rate >= 1 ? rate : NEST_RATE_DEFAULT;
}

/**
 * The nest in `cell` during `week`, or null. h = sha256(salt + cell + ":" +
 * week); a nest exists iff the first uint32 mod rate is 0; its point is the
 * cell's SW corner plus hash-derived fractions of the cell's height/width,
 * so it is always strictly inside the cell; its art seed is the fourth uint32.
 */
export function nestFor(cell, week, { rate } = {}) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) throw new Error("cell must be a 7-character geohash");
  if (typeof week !== "string" || !WEEK_RE.test(week)) throw new Error("week must look like 2026-W37");
  const h = createHash("sha256").update(NEST_SALT + cell + ":" + week).digest();
  if (h.readUInt32BE(0) % effectiveRate(rate) !== 0) return null;
  const { lat, lon, latErr, lonErr } = decodeGeohash(cell);
  const fy = h.readUInt32BE(4) / 0x100000000; // [0, 1)
  const fx = h.readUInt32BE(8) / 0x100000000;
  return {
    cell,
    week,
    lat: lat - latErr + fy * 2 * latErr,
    lon: lon - lonErr + fx * 2 * lonErr,
    seed: h.readUInt32BE(12),
  };
}

/**
 * Every geohash-7 cell that intersects the bbox, or null when the cover would
 * exceed `max` cells (the caller decides what "zoom in" looks like). Samples a
 * lattice one cell apart — that hits every cell at least once — then keeps a
 * cell only if its own bounds actually touch the box, so a box strictly inside
 * one cell yields exactly that cell.
 */
export function cellsInBbox(bbox, { max = MAX_NEST_CELLS } = {}) {
  const { south, west, north, east } = bbox || {};
  if (![south, west, north, east].every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("bbox must be four finite numbers");
  }
  if (south > north || west > east) throw new Error("bbox must have south <= north and west <= east");
  const rows = Math.floor((north - south) / CELL7_LAT_STEP) + 2;
  const cols = Math.floor((east - west) / CELL7_LON_STEP) + 2;
  if (rows * cols > max) return null;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < rows; i++) {
    const lat = Math.min(90, Math.max(-90, south + i * CELL7_LAT_STEP));
    for (let j = 0; j < cols; j++) {
      const lon = Math.min(180, Math.max(-180, west + j * CELL7_LON_STEP));
      const cell = encodeGeohash(lat, lon, 7);
      if (seen.has(cell)) continue;
      seen.add(cell);
      const d = decodeGeohash(cell);
      if (d.lat + d.latErr < south || d.lat - d.latErr > north) continue;
      if (d.lon + d.lonErr < west || d.lon - d.lonErr > east) continue;
      out.push(cell);
    }
  }
  return out;
}

/** The nests among `cells` for `week`, in input order. */
export function nestsInCells(cells, week, { rate } = {}) {
  const out = [];
  for (const cell of cells) {
    const nest = nestFor(cell, week, { rate });
    if (nest) out.push(nest);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-nests.test.js`
Expected: PASS. (If "rate is honoured" lands outside 50–150 the hash formula is wrong — do NOT widen the band.)

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/nests.js tests/ramble-nests.test.js -m "ramble: deterministic nests (nests.js)"
git show --stat HEAD
```

---

## Task 3: Claims — `ramble_nest_claims` + `claimNest` + `listNests`

**Files:**
- Modify: `bundles/ramble/server/init-tables.js` (new table, after `ramble_credits`)
- Modify: `bundles/ramble/server/eggs.js:93` (export `startOfLocalDay`)
- Create: `bundles/ramble/server/flock.js` (first half; Task 4 adds the rest)
- Test: `tests/ramble-flock.test.js` (new), `tests/ramble-tables.test.js`, `tests/ramble-sync.test.js`

**Interfaces:**
- Consumes: `nestFor`, `cellsInBbox`, `nestsInCells`, `CELL7_RE`, `WEEK_RE`, `NEST_RATE_DEFAULT` (Task 2); `isoWeek`, `localDay`, `startOfLocalDay` from `eggs.js`; `withinRange`, `haversineMeters` from `anchors.js`.
- Produces (`flock.js`):
  - `SHELF_CAP_DEFAULT = 5`, `CLAIM_RANGE_M = 75`, `CLAIMS_PER_DAY = 1`.
  - `readFlockSettings(db) -> { rate, shelfCap }` (`nest.rate` int ≥ 1 else 24; `shelf.cap` int ≥ 0 else 5).
  - `listNests(db, bbox, { now, from } = {}) -> { week, nests } | null` — nests carry `{ cell, week, lat, lon, seed, claimed }`; with `from: { lat, lon }` each also carries `distance_m` and the list is sorted nearest first; `null` = bbox too wide.
  - `claimNest(db, { cell, week, here, now, emit }) -> { claimed: true, already, egg } | { claimed: false, reason }` with `reason ∈ "stale-week" | "no-nest" | "too-far" | "daily-limit" | "shelf-full"`.
  - Table `ramble_nest_claims (cell TEXT NOT NULL, week TEXT NOT NULL, egg_id TEXT NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY (cell, week))` — local, never synced.

- [ ] **Step 1: Table tests** — append to `tests/ramble-tables.test.js`:

```js
test("phase 2: ramble_nest_claims exists, is keyed on (cell, week) and is NOT a synced table", async () => {
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(!SYNCED_TABLES.includes("ramble_nest_claims"), "claims are per instance (spec §5)");
  const cols = (await db.execute("PRAGMA table_info(ramble_nest_claims)")).rows.map((r) => r.name);
  for (const c of ["cell", "week", "egg_id", "claimed_at"]) assert.ok(cols.includes(c), `ramble_nest_claims.${c}`);
  await db.execute({ sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES ('9v6m21h','2026-W37','e1',1)", args: [] });
  await assert.rejects(db.execute({ sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES ('9v6m21h','2026-W37','e2',2)", args: [] }));
});
```

- [ ] **Step 2: Flock tests (claims half)** — create `tests/ramble-flock.test.js`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";
import { isoWeek, ensureIncubatingEgg } from "../bundles/ramble/server/eggs.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";
import {
  readFlockSettings, listNests, claimNest,
  SHELF_CAP_DEFAULT, CLAIM_RANGE_M, CLAIMS_PER_DAY,
} from "../bundles/ramble/server/flock.js";

const T0 = Date.UTC(2026, 8, 7, 12); // 2026-09-07 12:00Z
const WEEK = isoWeek(T0);
const DAY = 86400e3;

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }

/** The first N nest cells walking north from (30.46, -98.08) for `week`. */
function nestCells(week, n) {
  const out = [];
  for (let i = 0; i < 5000 && out.length < n; i++) {
    const cell = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(cell, week)) out.push(cell);
  }
  if (out.length < n) throw new Error("not enough nests found");
  return out;
}

let db;
before(async () => { db = await freshDb(); });

test("settings: nest.rate and shelf.cap read with defaults and floors", async () => {
  assert.deepEqual(await readFlockSettings(db), { rate: 24, shelfCap: SHELF_CAP_DEFAULT });
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('nest.rate','3'), ('shelf.cap','0')");
  assert.deepEqual(await readFlockSettings(db), { rate: 3, shelfCap: 0 });
  await db.execute("UPDATE ramble_settings SET value='-2' WHERE key='nest.rate'");
  await db.execute("UPDATE ramble_settings SET value='lots' WHERE key='shelf.cap'");
  assert.deepEqual(await readFlockSettings(db), { rate: 24, shelfCap: SHELF_CAP_DEFAULT });
  await db.execute("DELETE FROM ramble_settings WHERE key IN ('nest.rate','shelf.cap')");
});

test("listNests: current week, claimed marks, distance sort, and null when too wide", async () => {
  const d = await freshDb();
  const [cell] = nestCells(WEEK, 1);
  const nest = nestFor(cell, WEEK);
  const box = { south: nest.lat - 0.01, west: nest.lon - 0.01, north: nest.lat + 0.01, east: nest.lon + 0.01 };
  const out = await listNests(d, box, { now: T0 });
  assert.equal(out.week, WEEK);
  const mine = out.nests.find((n) => n.cell === cell);
  assert.ok(mine, "the known nest must be listed");
  assert.deepEqual(Object.keys(mine).sort(), ["cell", "claimed", "lat", "lon", "seed", "week"]);
  assert.equal(mine.claimed, false);

  await d.execute({ sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES (?,?,?,?)", args: [cell, WEEK, "e-x", T0] });
  const after = await listNests(d, box, { now: T0, from: { lat: nest.lat, lon: nest.lon } });
  assert.equal(after.nests[0].cell, cell, "nearest first");
  assert.equal(after.nests[0].claimed, true);
  assert.equal(after.nests[0].distance_m, 0);
  for (let i = 1; i < after.nests.length; i++) assert.ok(after.nests[i].distance_m >= after.nests[i - 1].distance_m);

  assert.equal(await listNests(d, { south: 30, west: -99, north: 31, east: -98 }, { now: T0 }), null);
});

test("claimNest: in range -> one 'user' shelf egg; idempotent; stale week / no nest / too far refused", async () => {
  const d = await freshDb();
  const [cell] = nestCells(WEEK, 1);
  const nest = nestFor(cell, WEEK);
  const emitted = [];
  const emit = async (t, op, row) => emitted.push([t, op, row]);

  const r = await claimNest(d, { cell, week: WEEK, here: { lat: nest.lat, lon: nest.lon }, now: T0, emit });
  assert.equal(r.claimed, true); assert.equal(r.already, false);
  assert.equal(r.egg.status, "shelf"); assert.equal(r.egg.shelf_origin, "user");
  assert.equal(r.egg.found_cell, cell); assert.equal(r.egg.found_week, WEEK); assert.equal(r.egg.warmth, 0);
  assert.deepEqual(emitted.map(([t, op]) => [t, op]), [["ramble_eggs", "insert"]]);
  assert.equal(emitted[0][2].egg_id, r.egg.egg_id);

  // Same nest again, even from far away: the same egg, nothing new written.
  const again = await claimNest(d, { cell, week: WEEK, here: { lat: 0, lon: 0 }, now: T0 + 3600e3, emit });
  assert.equal(again.claimed, true); assert.equal(again.already, true); assert.equal(again.egg.egg_id, r.egg.egg_id);
  assert.equal(emitted.length, 1);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs")).rows[0].n, 1);

  const [, other] = nestCells(WEEK, 2);
  const o = nestFor(other, WEEK);
  assert.deepEqual(await claimNest(d, { cell: other, week: "2020-W01", here: o, now: T0 + DAY }), { claimed: false, reason: "stale-week" });
  const empty = encodeGeohash(30.46, -98.08, 7); // walk until a NON-nest cell
  let noNest = empty; for (let i = 0; nestFor(noNest, WEEK); i++) noNest = encodeGeohash(30.46 - i * CELL7_LAT_STEP, -98.08, 7);
  assert.deepEqual(await claimNest(d, { cell: noNest, week: WEEK, here: { lat: 30.46, lon: -98.08 }, now: T0 + DAY }), { claimed: false, reason: "no-nest" });
  assert.deepEqual(await claimNest(d, { cell: other, week: WEEK, here: { lat: o.lat + 0.01, lon: o.lon }, now: T0 + DAY }), { claimed: false, reason: "too-far" });
  assert.ok(CLAIM_RANGE_M === 75);
});

test("claimNest: one claim per local day, and the shelf cap refuses the sixth", async () => {
  const d = await freshDb();
  const cells = nestCells(WEEK, 8);
  const at = (c) => { const n = nestFor(c, WEEK); return { lat: n.lat, lon: n.lon }; };
  assert.equal((await claimNest(d, { cell: cells[0], week: WEEK, here: at(cells[0]), now: T0 })).claimed, true);
  assert.deepEqual(await claimNest(d, { cell: cells[1], week: WEEK, here: at(cells[1]), now: T0 + 3600e3 }), { claimed: false, reason: "daily-limit" });
  assert.equal(CLAIMS_PER_DAY, 1);
  // Days 1-4 fill the shelf to the cap. T0 is Monday 12:00Z, and T0 + 5 days
  // (Saturday 12:00Z) is still ISO week 37 in EVERY timezone (UTC+14 makes it
  // Sunday 02:00, same ISO week), so nothing below can go stale. Never use
  // T0 + 6 days here: at UTC+12 that is Monday of W38.
  for (let i = 1; i < SHELF_CAP_DEFAULT; i++) {
    assert.equal((await claimNest(d, { cell: cells[i], week: WEEK, here: at(cells[i]), now: T0 + i * DAY })).claimed, true, `claim ${i}`);
  }
  const day5 = T0 + 5 * DAY;
  assert.deepEqual(await claimNest(d, { cell: cells[5], week: WEEK, here: at(cells[5]), now: day5 }), { claimed: false, reason: "shelf-full" });
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='shelf' AND shelf_origin='user'")).rows[0].n, SHELF_CAP_DEFAULT);
  // The cap counts USER shelf eggs only: neither the incubating egg nor a
  // convergence loser that landed on the shelf is one of the user's spots.
  await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('loser','shelf','sync',0,1)");
  assert.deepEqual(await claimNest(d, { cell: cells[5], week: WEEK, here: at(cells[5]), now: day5 }), { claimed: false, reason: "shelf-full" });
  // A raised cap admits it (5 user eggs < 6) — and the refused attempts above
  // left no claim row, so day 5's one claim is still available.
  await d.execute("INSERT INTO ramble_settings (key, value) VALUES ('shelf.cap','6')");
  assert.equal((await claimNest(d, { cell: cells[5], week: WEEK, here: at(cells[5]), now: day5 })).claimed, true);
});
```

Also append the **outbox door** to `tests/ramble-sync.test.js` (imports: add `import { claimNest } from "../bundles/ramble/server/flock.js";` and `import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";` and `import { encodeGeohash } from "../bundles/ramble/server/anchors.js";` and `isoWeek` to the eggs import):

```js
test("outbox door: a claimed egg (no manager) is queued and stamped with its 'user' origin on the wire", async () => {
  const week = isoWeek(1_800_000_000_000);
  let cell = null;
  for (let i = 0; i < 5000 && !cell; i++) {
    const c = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(c, week)) cell = c;
  }
  const nest = nestFor(cell, week);
  const r = await claimNest(a, { cell, week, here: { lat: nest.lat, lon: nest.lon }, now: 1_800_000_000_000,
    emit: (t, op, row) => emitOrQueue(null, a, t, op, row) });
  assert.equal(r.claimed, true);
  const local = await a.execute({ sql: "SELECT lamport_ts FROM ramble_eggs WHERE egg_id=?", args: [r.egg.egg_id] });
  assert.ok(Number(local.rows[0].lamport_ts) > 0, "claimed egg row was never stamped");
  const queued = await a.execute({ sql: "SELECT row_json, lamport_ts FROM sync_outbox WHERE table_name='ramble_eggs' ORDER BY id DESC LIMIT 1", args: [] });
  const wire = JSON.parse(queued.rows[0].row_json);
  assert.equal(wire.egg_id, r.egg.egg_id);
  assert.equal(wire.shelf_origin, "user", "the origin must travel so a peer never auto-promotes it");
  assert.equal(Number(queued.rows[0].lamport_ts), Number(local.rows[0].lamport_ts));
});
```

(Check `sync_outbox`'s column names in `servers/shared/sync-emit.js` `outboxInsertSql` before running: the plan assumes `row_json`, `lamport_ts`, `id`; if the id column is named differently, order by that.)

- [ ] **Step 3: Run to see them fail**

Run: `node scripts/run-suite.mjs tests/ramble-tables.test.js tests/ramble-flock.test.js tests/ramble-sync.test.js`
Expected: FAIL — no `ramble_nest_claims`, no `flock.js`.

- [ ] **Step 4: Table** — in `init-tables.js` after `ramble_credits`:

```js
  // Phase 2: which nests THIS instance's user has already claimed. Local by
  // design (spec §5): a claim is not shared state, the egg it produced is
  // (ramble_eggs replicates). PK (cell, week) makes a double-tap idempotent;
  // claimed_at drives the one-claim-per-local-day limit.
  await initTable(db, "ramble_nest_claims", `
    CREATE TABLE IF NOT EXISTS ramble_nest_claims (
      cell TEXT NOT NULL,
      week TEXT NOT NULL,
      egg_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY (cell, week)
    );`);
```

- [ ] **Step 5: `eggs.js`** — change `function startOfLocalDay(ms)` to `export function startOfLocalDay(ms)` (nothing else).

- [ ] **Step 6: Write `bundles/ramble/server/flock.js`** (claims half; Task 4 appends `incubateEgg`, `activateBird`, `flockState`):

```js
/**
 * Ramble flock — the db-facing half of nests + the shelf (spec §2.4–2.5).
 *
 * nests.js decides WHERE nests are (pure); this module decides what the user
 * has done about them: claims (one per local day, shelf cap, idempotent per
 * nest), the shelf itself, which egg incubates, which bird is active, and the
 * flock roster. Every egg it creates or moves is written with an explicit
 * `shelf_origin = 'user'` so instance sync never auto-promotes it (Task 1).
 *
 * Claiming credits NO warmth and NO pet energy (deliberate: the egg is the
 * reward; spec §2.1's weight table has no claim row). Do not add feedAll here.
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { withinRange, haversineMeters } from "./anchors.js";
import { isoWeek, startOfLocalDay, hatchIfReady, ensureIncubatingEgg, readWarmthWeights } from "./eggs.js";
import { nestFor, cellsInBbox, nestsInCells, NEST_RATE_DEFAULT, CELL7_RE, WEEK_RE } from "./nests.js";

const require = createRequire(import.meta.url);
const { ROSTER } = require("./bird-svg.cjs");

export const SHELF_CAP_DEFAULT = 5;
export const CLAIM_RANGE_M = 75;
export const CLAIMS_PER_DAY = 1;

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble flock] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

async function readSetting(db, key) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  } catch { return null; }
}

function intSetting(raw, fallback, min) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** `nest.rate` (>= 1, default 24) and `shelf.cap` (>= 0, default 5), read live. */
export async function readFlockSettings(db) {
  return {
    rate: intSetting(await readSetting(db, "nest.rate"), NEST_RATE_DEFAULT, 1),
    shelfCap: intSetting(await readSetting(db, "shelf.cap"), SHELF_CAP_DEFAULT, 0),
  };
}

async function getEgg(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}

async function claimedCells(db, week) {
  const { rows } = await db.execute({ sql: "SELECT cell FROM ramble_nest_claims WHERE week = ?", args: [week] });
  return new Set(rows.map((r) => r.cell));
}

/**
 * Nests inside `bbox` for the CURRENT week, each flagged `claimed` for this
 * instance. With `from`, nearest first with `distance_m`. Null = too wide.
 */
export async function listNests(db, bbox, { now = Date.now(), from = null } = {}) {
  const cells = cellsInBbox(bbox);
  if (!cells) return null;
  const week = isoWeek(now);
  const { rate } = await readFlockSettings(db);
  const claimed = await claimedCells(db, week);
  let nests = nestsInCells(cells, week, { rate }).map((n) => ({ ...n, claimed: claimed.has(n.cell) }));
  if (from && typeof from.lat === "number" && typeof from.lon === "number") {
    nests = nests
      .map((n) => ({ ...n, distance_m: Math.round(haversineMeters(from, { lat: n.lat, lon: n.lon })) }))
      .sort((x, y) => x.distance_m - y.distance_m);
  }
  return { week, nests };
}

/**
 * Claim the nest at (cell, week) from `here`. Checks, in order: the week is
 * the current one; a nest exists there; already claimed -> the same egg back
 * (idempotent, distance not re-checked); within 75 m; one claim per local
 * day; shelf cap (counting the user's OWN shelf eggs, shelf_origin='user' —
 * a convergence loser parked by sync is not one of their five spots). The
 * claim row is inserted BEFORE the egg and its PK is the double-tap guard for
 * the SAME nest (like the credits ledger); the daily limit and the cap are
 * read-then-insert, so two concurrent claims of DIFFERENT nests can both
 * pass — accepted, it needs two devices tapping in the same instant. A claim
 * whose egg is missing (crash between the two writes) is healed by writing
 * the egg it names.
 */
export async function claimNest(db, { cell, week, here, now = Date.now(), emit } = {}) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) throw new Error("cell must be a 7-character geohash");
  if (typeof week !== "string" || !WEEK_RE.test(week)) throw new Error("week must look like 2026-W37");
  if (week !== isoWeek(now)) return { claimed: false, reason: "stale-week" };

  const { rate, shelfCap } = await readFlockSettings(db);
  const nest = nestFor(cell, week, { rate });
  if (!nest) return { claimed: false, reason: "no-nest" };

  const { rows: prior } = await db.execute({
    sql: "SELECT egg_id FROM ramble_nest_claims WHERE cell = ? AND week = ?", args: [cell, week],
  });
  if (prior[0]) {
    const egg = (await getEgg(db, prior[0].egg_id)) ?? await insertClaimedEgg(db, prior[0].egg_id, cell, week, now, emit);
    return { claimed: true, already: true, egg };
  }

  const anchor = { anchor_kind: "geo", lat: nest.lat, lon: nest.lon, accuracy_m: CLAIM_RANGE_M };
  if (!withinRange(anchor, here)) return { claimed: false, reason: "too-far" };

  const { rows: today } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_nest_claims WHERE claimed_at >= ?", args: [startOfLocalDay(now)],
  });
  if (Number(today[0]?.n ?? 0) >= CLAIMS_PER_DAY) return { claimed: false, reason: "daily-limit" };

  const { rows: shelf } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_eggs WHERE status = 'shelf' AND shelf_origin = 'user'", args: [],
  });
  if (Number(shelf[0]?.n ?? 0) >= shelfCap) return { claimed: false, reason: "shelf-full" };

  const eggId = crypto.randomUUID();
  const { rowsAffected } = await db.execute({
    sql: "INSERT OR IGNORE INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES (?, ?, ?, ?)",
    args: [cell, week, eggId, now],
  });
  if (rowsAffected === 0) {
    // Lost a same-instance race to another claim of this nest: return theirs.
    const { rows } = await db.execute({ sql: "SELECT egg_id FROM ramble_nest_claims WHERE cell = ? AND week = ?", args: [cell, week] });
    const egg = (await getEgg(db, rows[0].egg_id)) ?? await insertClaimedEgg(db, rows[0].egg_id, cell, week, now, emit);
    return { claimed: true, already: true, egg };
  }
  const egg = await insertClaimedEgg(db, eggId, cell, week, now, emit);
  return { claimed: true, already: false, egg };
}

async function insertClaimedEgg(db, eggId, cell, week, now, emit) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at)
          VALUES (?, 'shelf', 'user', 0, ?, ?, ?) ON CONFLICT(egg_id) DO NOTHING`,
    args: [eggId, cell, week, now],
  });
  const egg = await getEgg(db, eggId);
  await safeEmit(emit, "ramble_eggs", "insert", egg);
  return egg;
}
```

(`hatchIfReady`, `ensureIncubatingEgg`, `readWarmthWeights`, `ROSTER` are imported now and used by Task 4's functions.)

- [ ] **Step 7: Run the three test files**

Run: `node scripts/run-suite.mjs tests/ramble-tables.test.js tests/ramble-flock.test.js tests/ramble-sync.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/server/init-tables.js bundles/ramble/server/eggs.js bundles/ramble/server/flock.js tests/ramble-tables.test.js tests/ramble-flock.test.js tests/ramble-sync.test.js -m "ramble: nest claims (ramble_nest_claims, claimNest, listNests)"
git show --stat HEAD
```

---

## Task 4: Incubate swap, activate bird, flock state

**Files:**
- Modify: `bundles/ramble/server/flock.js` (append)
- Test: `tests/ramble-flock.test.js` (append)

**Interfaces:**
- Produces:
  - `incubateEgg(db, eggId, { now, emit }) -> { ok: true, already: boolean, egg, shelved: row|null, hatched: row|null } | { ok: false, reason: "not-found" | "not-an-egg" }`. Only a `status='shelf'` egg can be incubated (phase 3 adds `'received'`). Batch: current incubating → `status='shelf', shelf_origin='user'`; target → `status='incubating', shelf_origin=NULL`. Emits the shelved row's update FIRST, then the incubating row's update. Then `hatchIfReady` (a swapped-in egg may already be past `hatch_at` if the threshold was lowered).
  - `activateBird(db, eggId, { emit }) -> { ok: true, bird: { egg_id, species, seed } } | { ok: false, reason: "not-found" | "not-a-bird" }`. Sets `ramble_pet.active_egg_id`, emits the full pet row.
  - `flockState(db, { now }) -> { birds: [{ egg_id, species, seed, hatched_at, active }], eggs: [{ egg_id, status, warmth, percent, found_cell, found_week, created_at, shelf_origin }], shelf_count, shelf_cap, species_found, species_total, species }` — `eggs` holds incubating + shelf rows, incubating first then `created_at ASC, egg_id ASC`; `birds` by `hatched_at ASC`; `shelf_count` = shelf rows with `shelf_origin='user'` (the same count the cap uses); `species_found` = distinct species among birds; `species_total = ROSTER.length` (8); `species = ROSTER`. Ensures the incubating egg exists first.
  - Incubating a `shelf_origin='sync'` shelf egg is allowed (the user reclaiming a loser is a choice); the swap always writes NULL on the chosen egg so it ranks as the user's plain choice from then on.

- [ ] **Step 1: Append tests** to `tests/ramble-flock.test.js` (extend the import line with `incubateEgg, activateBird, flockState`):

```js
test("incubateEgg swaps the slot: old egg shelved as 'user', target incubating, emits shelved then incubating", async () => {
  const d = await freshDb();
  const first = await ensureIncubatingEgg(d, { now: T0 });
  await d.execute({ sql: "UPDATE ramble_eggs SET warmth = 40 WHERE egg_id = ?", args: [first.egg_id] });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, created_at) VALUES ('s1','shelf','user',10,'9v6m21h',5)");
  const emitted = [];
  const r = await incubateEgg(d, "s1", { now: T0, emit: async (t, op, row) => emitted.push([t, op, row.egg_id, row.status, row.shelf_origin]) });
  assert.equal(r.ok, true); assert.equal(r.already, false); assert.equal(r.hatched, null);
  assert.equal(r.egg.egg_id, "s1"); assert.equal(r.egg.status, "incubating"); assert.equal(r.egg.shelf_origin, null); assert.equal(r.egg.warmth, 10);
  assert.equal(r.shelved.egg_id, first.egg_id); assert.equal(r.shelved.status, "shelf"); assert.equal(r.shelved.shelf_origin, "user"); assert.equal(r.shelved.warmth, 40);
  assert.deepEqual(emitted, [["ramble_eggs", "update", first.egg_id, "shelf", "user"], ["ramble_eggs", "update", "s1", "incubating", null]]);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);

  assert.deepEqual(await incubateEgg(d, "s1", { now: T0 }).then((x) => [x.ok, x.already]), [true, true]);
  assert.deepEqual(await incubateEgg(d, "nope", { now: T0 }), { ok: false, reason: "not-found" });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('h1','hatched',100,'crow',1,1,2)");
  assert.deepEqual(await incubateEgg(d, "h1", { now: T0 }), { ok: false, reason: "not-an-egg" });
});

test("incubateEgg hatches a swapped-in egg that is already past the threshold", async () => {
  const d = await freshDb();
  await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('hot','shelf','user',100,5)");
  const r = await incubateEgg(d, "hot", { now: T0 });
  assert.ok(r.hatched && r.hatched.egg_id === "hot" && typeof r.hatched.species === "string");
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1, "a successor egg was minted");
});

test("activateBird points the pet at a hatched egg and refuses anything else", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1','hatched',100,'raven',9,1,2)");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1','incubating',0,3)");
  const emitted = [];
  const r = await activateBird(d, "b1", { emit: async (t, op, row) => emitted.push([t, op, row.owner, row.active_egg_id]) });
  assert.deepEqual(r, { ok: true, bird: { egg_id: "b1", species: "raven", seed: 9 } });
  assert.deepEqual(emitted, [["ramble_pet", "update", "self", "b1"]]);
  assert.deepEqual(await activateBird(d, "e1"), { ok: false, reason: "not-a-bird" });
  assert.deepEqual(await activateBird(d, "zz"), { ok: false, reason: "not-found" });
});

test("flockState: birds with the active one marked, eggs incubating-first, species count, shelf cap", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1','hatched',100,'raven',9,1,20), ('b2','hatched',100,'crow',3,2,10), ('b3','hatched',100,'raven',4,3,30)");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at) VALUES ('s1','shelf','user',50,'9v6m21h','2026-W37',100), ('s0','shelf','sync',5,NULL,NULL,50)");
  await activateBird(d, "b2");
  const s = await flockState(d, { now: T0 });
  assert.deepEqual(s.birds.map((b) => [b.egg_id, b.species, b.active]), [["b2", "crow", true], ["b1", "raven", false], ["b3", "raven", false]]);
  assert.equal(s.eggs[0].status, "incubating", "the incubating egg is ensured and listed first");
  assert.deepEqual(s.eggs.slice(1).map((e) => [e.egg_id, e.status, e.percent, e.shelf_origin]), [["s0", "shelf", 5, "sync"], ["s1", "shelf", 50, "user"]]);
  // shelf_count is the user's own eggs (s1); the sync loser s0 is listed but does not use a spot.
  assert.deepEqual([s.shelf_count, s.shelf_cap, s.species_found, s.species_total, s.species.length], [1, SHELF_CAP_DEFAULT, 2, 8, 8]);
  for (const e of s.eggs) assert.ok(!("lamport_ts" in e) && !("species" in e), "eggs never expose seed/species or sync metadata");
});
```

- [ ] **Step 2: Run to see them fail** — `node scripts/run-suite.mjs tests/ramble-flock.test.js` → FAIL (not exported).

- [ ] **Step 3: Append to `flock.js`**

```js
async function getPetRow(db) {
  await db.execute({ sql: "INSERT INTO ramble_pet (owner) VALUES ('self') ON CONFLICT(owner) DO NOTHING", args: [] });
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return rows[0];
}

/**
 * Make `eggId` the incubating egg. The previous incubating egg goes to the
 * shelf marked 'user' (the user chose to park it; sync must not draft it
 * back). One batch, so no reader ever sees two or zero incubating eggs.
 * Emits the shelved row first, then the new incubating row — the peer's
 * apply of a user shelve skips re-promotion precisely because the successor
 * is the next op in the drain (Task 1).
 */
export async function incubateEgg(db, eggId, { now = Date.now(), emit } = {}) {
  const target = await getEgg(db, eggId);
  if (!target) return { ok: false, reason: "not-found" };
  if (target.status === "incubating") return { ok: true, already: true, egg: target, shelved: null, hatched: null };
  if (target.status !== "shelf") return { ok: false, reason: "not-an-egg" };

  const { rows: current } = await db.execute({ sql: "SELECT egg_id FROM ramble_eggs WHERE status = 'incubating'", args: [] });
  await db.batch([
    { sql: "UPDATE ramble_eggs SET status = 'shelf', shelf_origin = 'user' WHERE status = 'incubating'", args: [] },
    { sql: "UPDATE ramble_eggs SET status = 'incubating', shelf_origin = NULL WHERE egg_id = ? AND status = 'shelf'", args: [eggId] },
  ]);

  let shelved = null;
  for (const row of current) {
    // eslint-disable-next-line no-await-in-loop
    const s = await getEgg(db, row.egg_id);
    if (s && s.egg_id !== eggId) { shelved = shelved ?? s; await safeEmit(emit, "ramble_eggs", "update", s); }
  }
  const egg = await getEgg(db, eggId);
  await safeEmit(emit, "ramble_eggs", "update", egg);

  const hatched = await hatchIfReady(db, { now, emit });
  return { ok: true, already: false, egg: hatched ? hatched : egg, shelved, hatched };
}

/** Make a hatched egg the active bird (map, header, wire). */
export async function activateBird(db, eggId, { emit } = {}) {
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (egg.status !== "hatched" || egg.species == null || egg.seed == null) return { ok: false, reason: "not-a-bird" };
  await getPetRow(db);
  await db.execute({ sql: "UPDATE ramble_pet SET active_egg_id = ? WHERE owner = 'self'", args: [eggId] });
  await safeEmit(emit, "ramble_pet", "update", await getPetRow(db));
  return { ok: true, bird: { egg_id: egg.egg_id, species: egg.species, seed: egg.seed } };
}

/** The flock screen's data: hatched birds, unhatched eggs, and the species score. */
export async function flockState(db, { now = Date.now() } = {}) {
  await ensureIncubatingEgg(db, { now });
  const weights = await readWarmthWeights(db);
  const { shelfCap } = await readFlockSettings(db);
  const pet = await getPetRow(db);
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs ORDER BY created_at ASC, egg_id ASC", args: [] });

  const birds = rows
    .filter((r) => r.status === "hatched" && r.species != null && r.seed != null)
    .sort((x, y) => Number(x.hatched_at) - Number(y.hatched_at))
    .map((r) => ({ egg_id: r.egg_id, species: r.species, seed: r.seed, hatched_at: r.hatched_at, active: r.egg_id === pet.active_egg_id }));

  const pct = (w) => Math.max(0, Math.min(100, Math.round((Number(w) / weights.hatch_at) * 100)));
  const eggs = rows
    .filter((r) => r.status === "incubating" || r.status === "shelf")
    .sort((x, y) => (x.status === y.status ? 0 : x.status === "incubating" ? -1 : 1))
    .map((r) => ({
      egg_id: r.egg_id, status: r.status, warmth: r.warmth, percent: pct(r.warmth),
      found_cell: r.found_cell ?? null, found_week: r.found_week ?? null, created_at: r.created_at,
      shelf_origin: r.shelf_origin ?? null,
    }));

  return {
    birds,
    eggs,
    shelf_count: eggs.filter((e) => e.status === "shelf" && e.shelf_origin === "user").length,
    shelf_cap: shelfCap,
    species_found: new Set(birds.map((b) => b.species)).size,
    species_total: ROSTER.length,
    species: ROSTER,
  };
}
```

(`Array.prototype.sort` is stable in Node ≥ 12, so the incubating-first sort keeps `created_at` order within each group.)

- [ ] **Step 4: Run** — `node scripts/run-suite.mjs tests/ramble-flock.test.js tests/ramble-eggs.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/flock.js tests/ramble-flock.test.js -m "ramble: incubate swap, activate bird, flock state"
git show --stat HEAD
```

---

## Task 5: MCP tools — `ramble_flock`, `ramble_nests`, `ramble_claim_nest`

**Files:**
- Modify: `bundles/ramble/server/server.js` (imports; three `register(...)` blocks after `ramble_chore`; header comment tool list)
- Test: `tests/ramble-tools.test.js`

**Interfaces:**
- Consumes: `flockState`, `listNests`, `claimNest` (Tasks 3–4); `encodeGeohash`, `isoWeek`.
- Produces tools:
  - `ramble_flock {}` → JSON of `flockState`.
  - `ramble_nests { lat, lon }` → `{ week, nests }` for a ±0.01° box around the point, nearest first with `distance_m` (an addition to §7's list — `ramble_claim_nest` is unusable without a way to see nests; recorded as a deviation).
  - `ramble_claim_nest { lat, lon, cell? }` → `claimNest` for `cell ?? encodeGeohash(lat, lon, 7)` and the current week, `here = { lat, lon }`. Never feeds warmth.

- [ ] **Step 1: Tests** — append to `tests/ramble-tools.test.js`:

```js
test("ramble_flock returns the roster shape", async () => {
  const r = await h.ramble_flock({});
  assert.ok(!r.isError);
  const s = JSON.parse(r.content[0].text);
  assert.ok(Array.isArray(s.birds) && Array.isArray(s.eggs));
  assert.equal(s.species_total, 8);
  assert.equal(s.eggs[0].status, "incubating");
});

test("ramble_nests lists deterministic nests nearest-first; ramble_claim_nest claims one, idempotently, then hits the daily limit", async () => {
  // The tools use the real clock, so nests depend on THIS week. A fixed box
  // is not a deterministic guarantee (2026-W06 has a single nest in a ±0.01°
  // box at 30.46/-98.08): derive two nest points from the formula instead.
  const week = isoWeek(Date.now());
  const found = [];
  for (let i = 0; i < 5000 && found.length < 2; i++) {
    const n = nestFor(encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7), week);
    if (n) found.push(n);
  }
  assert.equal(found.length, 2, "two nests within 5000 cells north of the start point");
  const [nest, other] = found;

  const one = JSON.parse((await h.ramble_nests({ lat: nest.lat, lon: nest.lon })).content[0].text);
  const two = JSON.parse((await h.ramble_nests({ lat: nest.lat, lon: nest.lon })).content[0].text);
  assert.deepEqual(one, two, "nests must be a pure function of place and week");
  assert.equal(one.week, week);
  assert.equal(one.nests[0].cell, nest.cell, "the nest we stand on is nearest");
  assert.equal(one.nests[0].distance_m, 0);
  assert.equal(one.nests[0].claimed, false);
  for (let i = 1; i < one.nests.length; i++) assert.ok(one.nests[i].distance_m >= one.nests[i - 1].distance_m);

  const eggBefore = JSON.parse((await h.ramble_egg_state({})).content[0].text);
  const petBefore = JSON.parse((await h.ramble_pet_state({})).content[0].text);

  const far = JSON.parse((await h.ramble_claim_nest({ lat: nest.lat + 0.01, lon: nest.lon, cell: nest.cell })).content[0].text);
  assert.deepEqual(far, { claimed: false, reason: "too-far" });

  const got = JSON.parse((await h.ramble_claim_nest({ lat: nest.lat, lon: nest.lon })).content[0].text);
  assert.equal(got.claimed, true); assert.equal(got.already, false);
  assert.equal(got.egg.status, "shelf"); assert.equal(got.egg.shelf_origin, "user"); assert.equal(got.egg.found_cell, nest.cell);
  const again = JSON.parse((await h.ramble_claim_nest({ lat: nest.lat, lon: nest.lon, cell: nest.cell })).content[0].text);
  assert.equal(again.already, true); assert.equal(again.egg.egg_id, got.egg.egg_id);

  const listed = JSON.parse((await h.ramble_nests({ lat: nest.lat, lon: nest.lon })).content[0].text);
  assert.equal(listed.nests[0].claimed, true);

  const limit = JSON.parse((await h.ramble_claim_nest({ lat: other.lat, lon: other.lon })).content[0].text);
  assert.deepEqual(limit, { claimed: false, reason: "daily-limit" });

  const flock = JSON.parse((await h.ramble_flock({})).content[0].text);
  assert.ok(flock.eggs.some((e) => e.egg_id === got.egg.egg_id && e.status === "shelf"));
  // A claim is not activity: neither the incubating egg's warmth nor the pet moved.
  const eggAfter = JSON.parse((await h.ramble_egg_state({})).content[0].text);
  const petAfter = JSON.parse((await h.ramble_pet_state({})).content[0].text);
  assert.equal(eggAfter.egg.warmth, eggBefore.egg.warmth);
  assert.equal(petAfter.energy, petBefore.energy);
});
```

Add to the file's imports: `import { encodeGeohash } from "../bundles/ramble/server/anchors.js";`, `import { isoWeek } from "../bundles/ramble/server/eggs.js";` (extend the existing eggs import), `import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";`.

(The claimed egg lands on the shared test db's shelf; later tests in the file only read marks/pet, so nothing else changes.)

- [ ] **Step 2: Run** — `node scripts/run-suite.mjs tests/ramble-tools.test.js` → the two new tests FAIL (`h.ramble_flock is not a function`).

- [ ] **Step 3: Implement in `server.js`.** Imports — extend the existing line 25 (`encodeGeohash` is already imported at line 22):

```js
import { eggState, activeBird, isoWeek } from "./eggs.js";
import { flockState, listNests, claimNest } from "./flock.js";
```

After the `ramble_chore` register block:

```js
  register(
    "ramble_flock",
    "Your flock: hatched birds (the active one marked), the egg shelf and the incubating egg, and how many of the 8 species you have found.",
    {},
    async () => {
      try { return text(JSON.stringify(await flockState(db, { now: Date.now() }))); }
      catch (err) { return errorText(err.message); }
    },
  );

  register(
    "ramble_nests",
    "Nests near a location this week (about a 4 km box), nearest first, with whether you already claimed each. Nests are deterministic: everyone sees the same ones.",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    },
    async ({ lat, lon }) => {
      try {
        // ±0.02° (~900 cells, ~37 nests expected; no week through 2040 has
        // fewer than 3 at the test point) — a ±0.01° box can be nearly empty.
        const bbox = { south: Math.max(-90, lat - 0.02), west: Math.max(-180, lon - 0.02), north: Math.min(90, lat + 0.02), east: Math.min(180, lon + 0.02) };
        const out = await listNests(db, bbox, { now: Date.now(), from: { lat, lon } });
        return text(JSON.stringify(out ?? { week: isoWeek(Date.now()), nests: [] }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_claim_nest",
    "Claim the nest at your location (or at an explicit 7-character geohash cell you are within 75 m of) for an egg on your shelf. One claim per day; shelf holds 5. Claiming credits no warmth.",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      cell: z.string().regex(/^[0-9b-hjkmnp-z]{7}$/).optional(),
    },
    async ({ lat, lon, cell }) => {
      try {
        const emit = await getEmit();
        const now = Date.now();
        const result = await claimNest(db, {
          cell: cell ?? encodeGeohash(lat, lon, 7), week: isoWeek(now), here: { lat, lon }, now, emit,
        });
        return text(JSON.stringify(result));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );
```

Add the three names to the header comment's tool list.

- [ ] **Step 4: Run** — `node scripts/run-suite.mjs tests/ramble-tools.test.js` → PASS. Then smoke against a SCRATCH data dir only (the entry point runs `initRambleTables` on whatever db it resolves, and without `CROW_DATA_DIR` that is the LIVE `~/.crow/data/crow.db`): `D=$(mktemp -d); CROW_DATA_DIR=$D timeout 3 node bundles/ramble/server/index.js; echo $?; rm -rf $D` — 124 or 0 with no module-resolution error is a pass.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/server.js tests/ramble-tools.test.js -m "ramble: MCP tools ramble_flock, ramble_nests, ramble_claim_nest"
git show --stat HEAD
```

---

## Task 6: Panel routes + `ramble-nest-claimed` stream event

**Files:**
- Modify: `bundles/ramble/panel/routes.js` (`ensureLoaded` module list; new routes after the bird portrait route, before the error handler)
- Modify: `servers/gateway/routes/streams.js:180-230` (third handler on the same connection)
- Test: `tests/ramble-panel.test.js`, `tests/ramble-stream.test.js`

**Interfaces:**
- Consumes: `flock.js` (`listNests`, `claimNest`, `incubateEgg`, `activateBird`, `flockState`), `nests.js` (`CELL7_RE`, `WEEK_RE`), the existing `handle`, `bad`, `requireLat/Lon`, `poke`, `hatchedPayload`, `emit`.
- Produces (all behind the existing `router.use("/api/ramble", dashboardAuth)`):
  - `GET /api/ramble/nests?bbox=south,west,north,east` → `200 { week, nests: [{ cell, week, lat, lon, seed, claimed }] }`; `400 { error }` on a malformed bbox or one too wide (`"bbox too large — zoom in"`).
  - `POST /api/ramble/nests/claim { cell, week, lat, lon }` → `200` with `claimNest`'s result (`claimed:false` is not an HTTP error); on a NEW claim pokes `bus.emit("ramble:nest-claimed", { egg_id, cell })`.
  - `GET /api/ramble/flock` → `200` `flockState`.
  - `POST /api/ramble/eggs/:id/incubate` → `200 { egg, shelved, already, hatched }` (`hatched` = allow-listed trio or null; pokes `ramble:hatched` when set); `404 { error }` not-found; `409 { error }` not-an-egg.
  - `POST /api/ramble/birds/:id/activate` → `200 { bird }`; `404`; `409`.
  - SSE: `bus.emit("ramble:nest-claimed", …)` → `event: ramble-nest-claimed\ndata: {"egg_id":…, "cell":…}` on `/dashboard/streams/ramble-nearby`, allow-listed to exactly `{ egg_id, cell }` (string-or-null), unsubscribed on close/error.

- [ ] **Step 1: Panel tests** — insert into `tests/ramble-panel.test.js` immediately BEFORE the `// ------------------------------------------------------------- tile proxy` section (after the bird-portrait/static tests, so the earlier warmth-delta tests still see the original incubating egg):

```js
// ------------------------------------------------------ nests, flock, shelf (phase 2)

let claimedNest = null;   // set by the claim test, read by the flock/incubate tests
let claimedEggId = null;

test("GET /api/ramble/nests lists deterministic nests for a viewport and 400s a bad or too-wide bbox", async () => {
  const bbox = `${LAT - 0.01},${LON - 0.01},${LAT + 0.01},${LON + 0.01}`;
  const res = await req(`/api/ramble/nests?bbox=${bbox}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.week, /^\d{4}-W\d{2}$/);
  assert.ok(body.nests.length > 0, "a ~2 km box at rate 24 must hold nests");
  assert.deepEqual(Object.keys(body.nests[0]).sort(), ["cell", "claimed", "lat", "lon", "seed", "week"]);
  const again = await (await req(`/api/ramble/nests?bbox=${bbox}`)).json();
  assert.deepEqual(again, body);
  claimedNest = body.nests[0];

  assert.equal((await req("/api/ramble/nests?bbox=1,2,3")).status, 400);
  assert.equal((await req("/api/ramble/nests?bbox=a,b,c,d")).status, 400);
  assert.equal((await req("/api/ramble/nests?bbox=91,0,92,1")).status, 400);
  assert.equal((await req("/api/ramble/nests?bbox=30,-99,31,-98")).status, 400, "too wide must be refused, not computed");
  assert.equal((await req("/api/ramble/nests")).status, 400);
});

test("POST /api/ramble/nests/claim: too far is a friendly refusal; in range claims once; the claim emits the egg", async () => {
  assert.ok(claimedNest, "the nests test must run first");
  const far = await req("/api/ramble/nests/claim", { method: "POST",
    body: { cell: claimedNest.cell, week: claimedNest.week, lat: claimedNest.lat + 0.01, lon: claimedNest.lon } });
  assert.equal(far.status, 200);
  assert.deepEqual(await far.json(), { claimed: false, reason: "too-far" });

  const insertsBefore = emitCalls.filter((c) => c.table === "ramble_eggs" && c.op === "insert").length;
  const ok = await req("/api/ramble/nests/claim", { method: "POST",
    body: { cell: claimedNest.cell, week: claimedNest.week, lat: claimedNest.lat, lon: claimedNest.lon } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.claimed, true); assert.equal(body.already, false);
  assert.equal(body.egg.status, "shelf"); assert.equal(body.egg.shelf_origin, "user"); assert.equal(body.egg.found_cell, claimedNest.cell);
  claimedEggId = body.egg.egg_id;
  const inserts = emitCalls.filter((c) => c.table === "ramble_eggs" && c.op === "insert");
  assert.equal(inserts.length, insertsBefore + 1, "a claim must emit exactly one ramble_eggs insert");
  assert.equal(inserts[inserts.length - 1].row.shelf_origin, "user");

  const twice = await (await req("/api/ramble/nests/claim", { method: "POST",
    body: { cell: claimedNest.cell, week: claimedNest.week, lat: claimedNest.lat, lon: claimedNest.lon } })).json();
  assert.equal(twice.already, true); assert.equal(twice.egg.egg_id, claimedEggId);

  // Validation: a non-7 cell, a malformed week, a bad lat.
  assert.equal((await req("/api/ramble/nests/claim", { method: "POST", body: { cell: "9v6m2", week: claimedNest.week, lat: LAT, lon: LON } })).status, 400);
  assert.equal((await req("/api/ramble/nests/claim", { method: "POST", body: { cell: claimedNest.cell, week: "w37", lat: LAT, lon: LON } })).status, 400);
  assert.equal((await req("/api/ramble/nests/claim", { method: "POST", body: { cell: claimedNest.cell, week: claimedNest.week, lat: 200, lon: LON } })).status, 400);

  const listed = await (await req(`/api/ramble/nests?bbox=${claimedNest.lat - 0.001},${claimedNest.lon - 0.001},${claimedNest.lat + 0.001},${claimedNest.lon + 0.001}`)).json();
  assert.equal(listed.nests.find((n) => n.cell === claimedNest.cell)?.claimed, true);
});

test("GET /api/ramble/flock shows the shelf egg; incubate swaps it in and shelves the old egg as 'user'", async () => {
  const flock = await (await req("/api/ramble/flock")).json();
  assert.equal(flock.species_total, 8);
  assert.equal(flock.shelf_cap, 5);
  const shelfEgg = flock.eggs.find((e) => e.egg_id === claimedEggId);
  assert.ok(shelfEgg && shelfEgg.status === "shelf" && shelfEgg.shelf_origin === "user");
  const oldIncubating = flock.eggs.find((e) => e.status === "incubating");
  assert.ok(oldIncubating);

  const res = await req(`/api/ramble/eggs/${claimedEggId}/incubate`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.egg.egg_id, claimedEggId); assert.equal(body.egg.status, "incubating");
  assert.equal(body.shelved.egg_id, oldIncubating.egg_id); assert.equal(body.shelved.shelf_origin, "user");
  assert.ok("hatched" in body); assert.equal(body.hatched, null);

  const after = await (await req("/api/ramble/flock")).json();
  assert.equal(after.eggs[0].egg_id, claimedEggId);
  assert.equal(after.eggs.find((e) => e.egg_id === oldIncubating.egg_id).status, "shelf");
  assert.equal((await (await req("/api/ramble/egg")).json()).egg.egg_id, claimedEggId, "the egg view follows the swap");

  assert.equal((await req("/api/ramble/eggs/does-not-exist/incubate", { method: "POST", body: {} })).status, 404);
  assert.equal((await req("/api/ramble/eggs/%2e%2e%2fx/incubate", { method: "POST", body: {} })).status, 400);
});

test("POST /api/ramble/birds/:id/activate 409s an unhatched egg and 404s an unknown id", async () => {
  assert.equal((await req(`/api/ramble/birds/${claimedEggId}/activate`, { method: "POST", body: {} })).status, 409);
  assert.equal((await req("/api/ramble/birds/nope/activate", { method: "POST", body: {} })).status, 404);
  assert.equal((await req(`/api/ramble/eggs/${claimedEggId}/incubate`, { method: "POST", body: {} })).status, 200, "incubating the incubating egg is a no-op 200");
});

test("POST /api/ramble/birds/:id/activate 200s a hatched bird, emits the pet, and the pet/flock follow", async () => {
  // A bird planted directly (deterministic, whatever the cumulative warmth in
  // this file has or has not hatched by now).
  const db = createDbClient();
  try {
    await db.execute({
      sql: `INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at)
            VALUES ('panel-bird','hatched',100,'magpie',4242,1,2) ON CONFLICT(egg_id) DO NOTHING`,
      args: [],
    });
  } finally { db.close(); }
  const petUpdatesBefore = emitCalls.filter((c) => c.table === "ramble_pet" && c.op === "update").length;
  const res = await req("/api/ramble/birds/panel-bird/activate", { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { bird: { egg_id: "panel-bird", species: "magpie", seed: 4242 } });
  assert.equal(emitCalls.filter((c) => c.table === "ramble_pet" && c.op === "update").length, petUpdatesBefore + 1, "activation must emit the pet row");
  const pet = await (await req("/api/ramble/pet")).json();
  assert.deepEqual(pet.bird, { egg_id: "panel-bird", species: "magpie", seed: 4242 });
  const flock = await (await req("/api/ramble/flock")).json();
  assert.equal(flock.birds.find((b) => b.egg_id === "panel-bird")?.active, true);
  assert.equal(flock.birds.filter((b) => b.active).length, 1, "exactly one active bird");
});

test("nests, claim, flock, incubate and activate are behind dashboardAuth", async () => {
  assert.equal((await realFetch(BASE + "/api/ramble/nests?bbox=0,0,0.001,0.001")).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/flock")).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/nests/claim", { method: "POST" })).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/eggs/x/incubate", { method: "POST" })).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/birds/x/activate", { method: "POST" })).status, 401);
});
```

- [ ] **Step 2: Stream tests** — append to `tests/ramble-stream.test.js`, and in the existing test "closing the stream unsubscribes BOTH the nearby and the hatched listener" add `const priorClaimed = bus.listenerCount("ramble:nest-claimed");` before the handler call, `assert.equal(bus.listenerCount("ramble:nest-claimed"), priorClaimed + 1);` after it, and `assert.equal(bus.listenerCount("ramble:nest-claimed"), priorClaimed);` after `fireClose()`:

```js
// --------------------------------------------------- nest claimed (phase 2)

test("ramble-nest-claimed frame carries exactly egg_id and cell", () => {
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  handler({ dashboardSession: "tok-n1" }, res);
  try {
    const before = chunks.length;
    bus.emit("ramble:nest-claimed", { egg_id: "e9", cell: "9v6m21h", warmth: 0, found_week: "2026-W37" });
    const emitted = chunks.slice(before).join("");
    const match = emitted.match(/event: ramble-nest-claimed\ndata: (.+)\n\n/);
    assert.ok(match, "frame must carry a data: JSON payload");
    assert.deepEqual(JSON.parse(match[1]), { egg_id: "e9", cell: "9v6m21h" });
    assert.doesNotThrow(() => bus.emit("ramble:nest-claimed", {}));
    const sparse = chunks.slice(before).join("").match(/event: ramble-nest-claimed\ndata: (.+)\n\n/g);
    assert.equal(sparse.length, 2);
  } finally {
    fireClose();
  }
});
```

(The client-side half — "the panel client subscribes to the ramble-nest-claimed frame by name" — is added in Task 7 Step 1, so every commit on the branch stays green.)

- [ ] **Step 3: Run** — `node scripts/run-suite.mjs tests/ramble-panel.test.js tests/ramble-stream.test.js` → the new tests FAIL (404s / no frame).

- [ ] **Step 4: Routes.** In `ensureLoaded`, add `bundleImport("server/flock.js")` and `bundleImport("server/nests.js")` to the `Promise.all` (destructure as `flockMod, nestsMod`), include both in the null check and in `mods`. Add `const EGG_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;` beside `MARK_ID_RE`. After the bird-portrait route:

```js
  // --- nests --------------------------------------------------------------
  //
  // Nests are a pure function of (cell, week) under a public salt; the server
  // computes them for the viewport so the client needs no geohash code. The
  // viewport is a bbox, not a cell list (spec §2.4 says "for the visible
  // cells" — this is the same intent without a client-side geohash encoder).
  router.get("/api/ramble/nests", handle(async (req, res) => {
    const raw = req.query?.bbox;
    if (typeof raw !== "string") bad("bbox=south,west,north,east is required");
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || !parts.every(Number.isFinite)) bad("bbox must be four numbers: south,west,north,east");
    const bbox = { south: requireLat(parts[0]), west: requireLon(parts[1]), north: requireLat(parts[2]), east: requireLon(parts[3]) };
    if (bbox.south > bbox.north || bbox.west > bbox.east) bad("bbox must have south <= north and west <= east");
    const out = await mods.flockMod.listNests(db, bbox, { now: Date.now() });
    if (!out) bad("bbox too large — zoom in");
    res.json(out);
  }));

  router.post("/api/ramble/nests/claim", handle(async (req, res) => {
    const b = req.body || {};
    if (typeof b.cell !== "string" || !mods.nestsMod.CELL7_RE.test(b.cell)) bad("cell must be a 7-character geohash");
    if (typeof b.week !== "string" || !mods.nestsMod.WEEK_RE.test(b.week)) bad("week must look like 2026-W37");
    const here = { lat: requireLat(b.lat), lon: requireLon(b.lon) };
    const result = await mods.flockMod.claimNest(db, { cell: b.cell, week: b.week, here, now: Date.now(), emit });
    if (result.claimed && !result.already) {
      poke("ramble:nest-claimed", { egg_id: result.egg?.egg_id ?? null, cell: b.cell });
    }
    res.json(result);
  }));

  // --- flock ----------------------------------------------------------------
  router.get("/api/ramble/flock", handle(async (req, res) => {
    res.json(await mods.flockMod.flockState(db, { now: Date.now() }));
  }));

  router.post("/api/ramble/eggs/:id/incubate", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const out = await mods.flockMod.incubateEgg(db, req.params.id, { now: Date.now(), emit });
    if (!out.ok) return res.status(out.reason === "not-found" ? 404 : 409).json({ error: out.reason });
    if (out.hatched) onHatch(out.hatched);
    res.json({ egg: out.egg, shelved: out.shelved, already: out.already, hatched: hatchedPayload(out) });
  }));

  router.post("/api/ramble/birds/:id/activate", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const out = await mods.flockMod.activateBird(db, req.params.id, { emit });
    if (!out.ok) return res.status(out.reason === "not-found" ? 404 : 409).json({ error: out.reason });
    res.json({ bird: out.bird });
  }));
```

(`hatchedPayload(out)` works because it reads `.hatched` off whatever it is given.) Note `req.params.id` for `%2e%2e%2fx` arrives URL-decoded as `../x` and fails `EGG_ID_RE` → 400, which is what the test asserts.

- [ ] **Step 5: Stream.** In `streams.js`, beside `hatchedHandler`:

```js
    // A nest claim is the third live event on this connection (phase 2).
    // bundles/ramble/panel/routes.js pokes `ramble:nest-claimed` with
    // { egg_id, cell } on a NEW claim only; the panel refreshes its shelf and
    // its nest pins. Allow-listed to exactly those two strings.
    const claimedHandler = (payload) => {
      try {
        const out = {
          egg_id: payload?.egg_id != null ? String(payload.egg_id) : null,
          cell: payload?.cell != null ? String(payload.cell) : null,
        };
        sendRaw(`event: ramble-nest-claimed\ndata: ${JSON.stringify(out)}\n\n`);
      } catch {
        // Subscriber isolation.
      }
    };
```

Register `bus.on("ramble:nest-claimed", claimedHandler);` with the other two and add `bus.off("ramble:nest-claimed", claimedHandler);` inside `unsubscribe`.

- [ ] **Step 6: Run** — `node scripts/run-suite.mjs tests/ramble-panel.test.js tests/ramble-stream.test.js` → all PASS. Also `node servers/gateway/index.js --no-auth` boots and prints `[panel] ramble routes mounted` (ctrl-C).

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/routes.js servers/gateway/routes/streams.js tests/ramble-panel.test.js tests/ramble-stream.test.js -m "ramble: nests, claim, flock, incubate and activate routes; nest-claimed stream event"
git show --stat HEAD
```

---

## Task 7: Panel — flock view, nest pins, claim, incubate, activate

**Files:**
- Modify: `bundles/ramble/panel/ramble.js` (flock view section; two buttons)
- Modify: `bundles/ramble/panel/static/ramble.css` (append)
- Modify: `bundles/ramble/panel/static/ramble.js` (new `nests` and `flock` sections; SSE; view switch)
- Test: `tests/ramble-panel.test.js` (panel-shape + client-script assertions), `tests/ramble-stream.test.js` (client-string assertion for the nest-claimed frame)

**Interfaces:**
- Consumes: the five routes and the SSE frame from Task 6; `RambleBird.drawEgg(seed)`, `mountBird`, `rollGenome`, `isValidBird`, `SPECIES`.
- Produces: view `flock` (`data-for="flock"`), ids `rb-flock-kinds`, `rb-flock-birds`, `rb-flock-empty`, `rb-shelf`, `rb-shelf-count`, `rb-flock-status`, `rb-flock-bird-btn`, `rb-flock-back`, `rb-my-flock` (pet view), `rb-egg-flock` (egg view); map nest pins with class `rb-nest-pin` (+ `is-claimed`); client constants `MIN_NEST_ZOOM = 14`, `CLAIM_M = 75`.

- [ ] **Step 1: Test assertions.** Append to `tests/ramble-stream.test.js` (the client half of the Task 6 frame test):

```js
test("the panel client subscribes to the ramble-nest-claimed frame by name", () => {
  const client = readFileSync(join(__repo, "bundles/ramble/panel/static/ramble.js"), "utf8");
  assert.ok(client.includes('addEventListener("ramble-nest-claimed"'));
});
```

In `tests/ramble-panel.test.js` add to the "panel handler renders …" test:

```js
  // Phase 2: the flock view and both doors into it.
  assert.match(sent, /data-for="flock"/);
  assert.match(sent, /id="rb-flock-birds"/);
  assert.match(sent, /id="rb-shelf"/);
  assert.match(sent, /id="rb-my-flock"/);
  assert.match(sent, /id="rb-egg-flock"/);
```

and to the "GET /ramble/static/ramble.js serves the client script" test:

```js
  // Phase 2 wiring: nests for the viewport, the claim, the flock, the swap,
  // the activation, and the third named SSE frame.
  assert.ok(body.includes('"/api/ramble/nests?bbox="'), "client must fetch nests by bbox");
  assert.ok(body.includes('"/api/ramble/nests/claim"'));
  assert.ok(body.includes('"/api/ramble/flock"'));
  assert.ok(body.includes('"/incubate"'));
  assert.ok(body.includes('"/activate"'));
  assert.ok(body.includes('addEventListener("ramble-nest-claimed"'), "client must subscribe to ramble-nest-claimed");
  // The only markup sinks are engine output from a NUMBER (drawEgg via
  // drawEggArt, and the nest pin's divIcon html); every user- or peer-supplied
  // string goes through textContent. Comments are stripped first so prose
  // (the file header mentions innerHTML) never trips the count.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const sinks = code.match(/\.innerHTML\s*=|\bhtml:\s/g) || [];
  assert.equal(sinks.length, 2, `expected exactly two engine-output markup sinks, found ${sinks.length}`);
  assert.ok(code.includes("el.innerHTML = Bird.drawEgg("));
  assert.ok(code.includes("html: nestEggHtml("));
```

and to the "GET /ramble/static/ramble.css serves the panel stylesheet" test:

```js
  // Views switch by CSS alone: without this selector showView("flock") sets
  // the attribute and the section stays display:none.
  assert.match(body, /\[data-view="flock"\]\s*\.rb-view\[data-for="flock"\]/);
```

- [ ] **Step 2: Run** — `node scripts/run-suite.mjs tests/ramble-panel.test.js` → the two edited tests FAIL.

- [ ] **Step 3: Markup** (`panel/ramble.js`). Add to `ICONS`: `nest: '<path d="M4 14c0 3 4 6 8 6s8-3 8-6"/><path d="M3 14h18"/><path d="M8 14c0-4 2-7 4-8 2 1 4 4 4 8"/>'` and `flock: '<circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M4 19c1-3 3-4 3-4s2 1 3 4M14 19c1-3 3-4 3-4s2 1 3 4"/>'`. In the **egg view** actions row add, after `rb-checkin`: `<button class="rb-btn rb-btn-ghost" id="rb-egg-flock" type="button">${icon("flock")}Flock</button>`. In the **pet view**, before `rb-back-world`: `<button class="rb-btn" id="rb-my-flock" type="button">${icon("flock")}My flock</button>`. Add the view, before the grid sheet:

```html
        <!-- ─────────────────────────────────────────────────────── the flock -->
        <section class="rb-view" data-for="flock">
          <section class="rb-card">
            <p class="rb-eyebrow">Your flock</p>
            <h3 class="rb-h" id="rb-flock-kinds">8 kinds, 0 found</h3>
            <p class="rb-muted rb-fine">Tap a bird to take it out with you. The one with the tag is on your map, your header and your caws.</p>
            <div class="rb-flock-grid" id="rb-flock-birds"></div>
            <p class="rb-muted rb-fine" id="rb-flock-empty">Nothing has hatched yet. Your first bird is warming up on the egg screen.</p>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow">Egg shelf</p>
            <p class="rb-muted rb-fine" id="rb-shelf-count">Nests appear on the map as eggs. Walk up to one to take it.</p>
            <div class="rb-steps" id="rb-shelf"></div>
            <p class="rb-muted rb-fine" id="rb-flock-status"></p>
          </section>

          <div class="rb-row rb-actions">
            <button class="rb-btn rb-btn-ghost rb-grow" id="rb-flock-bird-btn" type="button">My bird</button>
            <button class="rb-btn rb-btn-ghost" id="rb-flock-back" type="button">${icon("back")}Back to the world</button>
          </div>
        </section>
```

- [ ] **Step 4: CSS.** FIRST edit the view-switch rule at `static/ramble.css:119-121` (views are shown by CSS alone; the section is `display:none` until its selector exists; also change the comment above it from "Three views" to "Four views") so it reads:

```css
#ramble[data-view="world"] .rb-view[data-for="world"],
#ramble[data-view="egg"] .rb-view[data-for="egg"],
#ramble[data-view="pet"] .rb-view[data-for="pet"],
#ramble[data-view="flock"] .rb-view[data-for="flock"] { display: flex; }
```

(keep whatever declarations that rule already carries besides `display`). THEN append to `static/ramble.css`:

```css
/* ------------------------------------------------------------ nests (phase 2) */

/* Leaflet divIcon wrapper: no box of its own, the egg art is the whole pin. */
#ramble .rb-nest-pin { background: none; border: 0; }
#ramble .rb-nest-pin svg { width: 30px; height: 38px; filter: drop-shadow(2px 2px 0 var(--rb-shadow-col)); }
#ramble .rb-nest-pin.is-claimed svg { opacity: .45; filter: grayscale(1); }

/* ------------------------------------------------------------ flock (phase 2) */

#ramble .rb-flock-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
#ramble .rb-flock-bird {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-height: 110px; padding: 10px 6px;
  border: var(--rb-line-w) solid var(--rb-line); border-radius: var(--rb-radius-sm);
  background: var(--rb-surface-2); box-shadow: var(--rb-pop-sm); color: var(--rb-text);
  font: 800 13px var(--rb-font-display); cursor: pointer;
}
#ramble .rb-flock-bird svg { width: 64px; height: 64px; }
#ramble .rb-flock-bird.is-active { background: color-mix(in oklab, var(--rb-accent) 45%, var(--rb-surface-2)); }
#ramble .rb-flock-bird:active { transform: translate(2px, 2px); box-shadow: 0 0 0 var(--rb-shadow-col); }
#ramble .rb-flock-bird:focus-visible { outline: 3px solid var(--rb-accent-2); outline-offset: 3px; }
#ramble .rb-tag {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  border: 2px solid var(--rb-line); background: var(--rb-accent); color: var(--rb-accent-ink);
  font: 800 11px var(--rb-font-display); line-height: 18px;
}
#ramble .rb-shelf-egg { width: 34px; height: 43px; flex: 0 0 auto; }
#ramble .rb-step .rb-btn { margin-left: auto; }
#ramble .rb-step.is-incubating { border-color: var(--rb-accent-2); }
```

- [ ] **Step 5: Client** (`static/ramble.js`; string concatenation only, no backticks, no emoji). Update the header comment's section list to `… egg, pet, flock, nests, hatch, stream, startup`. Changes:

(a) In `showView`: add `if (name === "flock") refreshFlock();`.

(b) Constants near `MAX_NEARBY`: `var MIN_NEST_ZOOM = 14; var CLAIM_M = 75;`.

(c) In the map block, after `markerLayer = …`: `nestLayer = L.layerGroup().addTo(map);` (declare `var nestLayer = null;` beside `markerLayer`). In the `moveend` handler, alongside `publishArea`: `areaTimer = setTimeout(function () { publishArea(); refreshNests(); }, 500);`.

(d) New **nests** section (after the pet section):

```js
  /* ---------------------------------------------------------------- nests */

  var lastNests = [];
  var nestWeek = null;

  /* Engine output from a numeric seed: the only markup sink besides drawEggArt. */
  function nestEggHtml(seed) {
    if (!Bird) return "<span></span>";
    try { return '<svg viewBox="0 0 120 152" aria-hidden="true">' + Bird.drawEgg(seed >>> 0) + "</svg>"; }
    catch (e) { return "<span></span>"; }
  }

  function nestWalkHint(nest) {
    if (!lastFix) return "get closer to take it";
    var m = haversineMeters({ lat: lastFix.lat, lon: lastFix.lon }, { lat: nest.lat, lon: nest.lon });
    if (m <= CLAIM_M) return "you're close enough — take it";
    return "walk ~" + (Math.round(m / 5) * 5) + " m to take it";
  }

  var CLAIM_REASON = {
    "too-far": "Get closer first.",
    "daily-limit": "One nest a day. Come back tomorrow.",
    "shelf-full": "Your shelf is full. Hatch something first.",
    "stale-week": "That nest is gone. The world re-rolls every week.",
    "no-nest": "Nothing here."
  };

  function claimNest(nest, lineEl, btn) {
    btn.disabled = true;
    lineEl.textContent = "checking where you are…";
    here().then(function (pos) {
      return jsonFetch("/api/ramble/nests/claim", {
        method: "POST",
        body: { cell: nest.cell, week: nest.week, lat: pos.lat, lon: pos.lon }
      });
    }).then(function (out) {
      if (out && out.claimed) {
        lineEl.textContent = out.already ? "Already yours." : "You found an egg. It's on your shelf.";
        btn.remove();
        refreshNests();
        return refreshFlock();
      }
      lineEl.textContent = CLAIM_REASON[out && out.reason] || "Couldn't take it.";
      btn.disabled = false;
    }).catch(function (err) {
      lineEl.textContent = err.message;
      btn.disabled = false;
    });
  }

  function nestPopup(nest) {
    var box = document.createElement("div");
    var head = document.createElement("div");
    head.className = "rb-pop-head";
    var who = document.createElement("span");
    who.textContent = "A nest";
    head.appendChild(who);
    box.appendChild(head);
    var line = document.createElement("p");
    line.className = "rb-pop-body";
    box.appendChild(line);
    if (nest.claimed) { line.textContent = "You already took this one."; return box; }
    line.textContent = nestWalkHint(nest);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-pop-btn";
    btn.textContent = "Take the egg";
    btn.addEventListener("click", function () { claimNest(nest, line, btn); });
    box.appendChild(btn);
    return box;
  }

  function drawNests(list) {
    lastNests = list;
    if (!nestLayer) return;
    nestLayer.clearLayers();
    list.forEach(function (nest) {
      var icon = L.divIcon({
        className: "rb-nest-pin" + (nest.claimed ? " is-claimed" : ""),
        html: nestEggHtml(nest.seed),
        iconSize: [30, 38],
        iconAnchor: [15, 36],
        popupAnchor: [0, -30]
      });
      var marker = L.marker([nest.lat, nest.lon], { icon: icon, title: "A nest" });
      /* Built on open, not at draw time, so the walk hint uses the CURRENT fix
       * rather than the one we had when the pins were drawn. */
      marker.bindPopup(function () { return nestPopup(nest); });
      marker.addTo(nestLayer);
    });
    paintPerchSay();
  }

  /* Nests are computed server-side for the viewport; below MIN_NEST_ZOOM the
   * cover is too wide (the route 400s it) and pins would be noise anyway.
   * A hidden map (another view is showing) has no size and getBounds() is
   * meaningless, so skip until the world view is back and moveend fires. */
  function refreshNests() {
    if (!map || !nestLayer) return Promise.resolve();
    if (root.getAttribute("data-view") !== "world") return Promise.resolve();
    if (map.getZoom() < MIN_NEST_ZOOM) { drawNests([]); return Promise.resolve(); }
    var b = map.getBounds();
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(",");
    return jsonFetch("/api/ramble/nests?bbox=" + encodeURIComponent(bbox))
      .then(function (out) { nestWeek = out && out.week; drawNests((out && out.nests) || []); })
      .catch(function () { drawNests([]); });
  }
```

Then REPLACE the whole `paintPerchSay` function (currently `static/ramble.js:448-459`) with:

```js
  function paintPerchSay() {
    var say = $("rb-perch-say");
    if (!say) return;
    var line;
    if (perchTarget === "egg") {
      line = "Your egg is " + Math.round(eggPercent) + "% warm.";
    } else if (lastMarks.length === 0) {
      line = "Quiet around here right now.";
    } else {
      line = lastMarks.length === 1 ? "One thing waiting nearby." : (lastMarks.length + " things waiting nearby.");
    }
    /* lastNests is declared in the nests section further down; this function
     * only ever runs from fetch/stream callbacks, after the whole script has
     * been evaluated, so the var is initialised by then. The guard is belt. */
    if ((lastNests || []).length > 0) line += " There's a nest nearby.";
    say.textContent = line;
  }
```

(e) New **flock** section:

```js
  /* ---------------------------------------------------------------- flock */

  function birdTile(bird) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-flock-bird" + (bird.active ? " is-active" : "");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    if (Bird && Bird.isValidBird({ species: bird.species, seed: bird.seed })) {
      try { Bird.mountBird(svg, Bird.rollGenome(bird.seed, bird.species), "happy"); } catch (e) { /* cosmetic */ }
    }
    btn.appendChild(svg);
    var name = document.createElement("span");
    var sp = Bird && Bird.SPECIES ? Bird.SPECIES[bird.species] : null;
    name.textContent = (sp && sp.name) || bird.species;
    btn.appendChild(name);
    if (bird.active) {
      var tag = document.createElement("span");
      tag.className = "rb-tag";
      tag.textContent = "With you";
      btn.appendChild(tag);
    }
    btn.setAttribute("aria-pressed", bird.active ? "true" : "false");
    btn.addEventListener("click", function () {
      if (bird.active) { showView("pet"); return; }
      btn.disabled = true;
      jsonFetch("/api/ramble/birds/" + encodeURIComponent(bird.egg_id) + "/activate", { method: "POST", body: {} })
        .then(function () { setText($("rb-flock-status"), "It's with you now."); refreshPet(); return refreshFlock(); })
        .catch(function (err) { setText($("rb-flock-status"), err.message); btn.disabled = false; });
    });
    return btn;
  }

  function eggRow(egg) {
    var row = document.createElement("div");
    row.className = "rb-step" + (egg.status === "incubating" ? " is-incubating" : "");
    var art = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    art.setAttribute("class", "rb-shelf-egg");
    art.setAttribute("viewBox", "0 0 120 152");
    drawEggArt(art, egg.egg_id);
    row.appendChild(art);
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var title = document.createElement("strong");
    title.textContent = (egg.status === "incubating" ? "Incubating" : "On the shelf") + " · " + Math.round(egg.percent || 0) + "%";
    var sub = document.createElement("span");
    sub.className = "rb-muted rb-fine";
    sub.textContent = egg.found_cell
      ? "found in a nest, " + egg.found_week
      : (egg.shelf_origin === "sync" ? "came back from another of your Crows" : "your own egg");
    txt.appendChild(title);
    txt.appendChild(sub);
    row.appendChild(txt);
    if (egg.status === "shelf") {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-btn rb-btn-ghost";
      btn.textContent = "Incubate";
      btn.addEventListener("click", function () {
        btn.disabled = true;
        jsonFetch("/api/ramble/eggs/" + encodeURIComponent(egg.egg_id) + "/incubate", { method: "POST", body: {} })
          .then(function (out) {
            setText($("rb-flock-status"), "Swapped. The other one keeps its warmth on the shelf.");
            handleHatched(out && out.hatched);
            refreshEgg();
            refreshPet();
            return refreshFlock();
          })
          .catch(function (err) { setText($("rb-flock-status"), err.message); btn.disabled = false; });
      });
      row.appendChild(btn);
    }
    return row;
  }

  function paintFlock(state) {
    if (!state) return;
    setText($("rb-flock-kinds"), state.species_total + " kinds, " + state.species_found + " found");
    var grid = $("rb-flock-birds");
    if (grid) {
      grid.textContent = "";
      (state.birds || []).forEach(function (b) { grid.appendChild(birdTile(b)); });
    }
    var empty = $("rb-flock-empty");
    if (empty) empty.hidden = (state.birds || []).length > 0;
    var shelf = $("rb-shelf");
    if (shelf) {
      shelf.textContent = "";
      (state.eggs || []).forEach(function (e) { shelf.appendChild(eggRow(e)); });
    }
    setText($("rb-shelf-count"), state.shelf_count + " of " + state.shelf_cap + " shelf spots used. Nests appear on the map as eggs; walk up to one to take it.");
  }

  function refreshFlock() {
    return jsonFetch("/api/ramble/flock").then(paintFlock).catch(function () { /* the flock is cosmetic */ });
  }

  var myFlockBtn = $("rb-my-flock");
  if (myFlockBtn) myFlockBtn.addEventListener("click", function () { showView("flock"); });
  var eggFlockBtn = $("rb-egg-flock");
  if (eggFlockBtn) eggFlockBtn.addEventListener("click", function () { showView("flock"); });
  var flockBirdBtn = $("rb-flock-bird-btn");
  if (flockBirdBtn) flockBirdBtn.addEventListener("click", function () { showView("pet"); });
  var flockBackBtn = $("rb-flock-back");
  if (flockBackBtn) flockBackBtn.addEventListener("click", function () { showView("world"); });
```

(f) SSE: add `stream.addEventListener("ramble-nest-claimed", function () { refreshNests(); refreshFlock(); });` beside the other two.

(g) Startup: after `publishArea` in the `here().then(...)` chain, call `refreshNests()` (`.then(function () { publishArea(); refreshNests(); })`), and add `setInterval(refreshNests, 10 * 60e3);` right after it so a week rollover mid-session re-rolls the pins within ten minutes (a stale pin only ever earns the friendly "That nest is gone" line, so this is cosmetic).

Note `drawEggArt(el, eggId)` and `handleHatched` already exist above; the flock section must be placed AFTER the egg/pet sections so both are defined (function declarations hoist, but keep the order readable).

- [ ] **Step 6: innerHTML audit + zero-backtick check.** Run:

```bash
grep -n 'innerHTML\|html:' bundles/ramble/panel/static/ramble.js
grep -c '`' bundles/ramble/panel/static/ramble.js
```

Expected: the only `innerHTML` is the existing `el.innerHTML = Bird.drawEgg(...)` in `drawEggArt`, and the only `html:` is `html: nestEggHtml(nest.seed)` (engine output from a number). Backtick count `0`. Every other write is `textContent`. No emoji anywhere (`grep -P '[\x{1F300}-\x{1FAFF}]' …` prints nothing).

- [ ] **Step 7: Run** — `node scripts/run-suite.mjs tests/ramble-panel.test.js tests/ramble-stream.test.js` → PASS (including the client-string stream test added in Step 1). Then parse-check the client script without a browser: `node -e "new Function(require('fs').readFileSync('bundles/ramble/panel/static/ramble.js','utf8'))"` must print nothing (a plain-script parse error kills the whole panel). The visual check (egg pins at zoom 15, the popup text, the flock view from the pet screen) happens on grackle after deploy (Task 8 Step 7) — never boot a gateway from the worktree against the live db.

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.css bundles/ramble/panel/static/ramble.js tests/ramble-panel.test.js tests/ramble-stream.test.js -m "ramble panel: flock view, egg shelf, nest pins and claiming"
git show --stat HEAD
```

---

## Task 8: Docs, version bump, registry, integration gate

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`
- Modify: `bundles/ramble/manifest.json`, `bundles/ramble/package.json` (`0.2.0` → `0.3.0`; manifest description gains "nests, flock, egg shelf")
- Regenerate: `registry/add-ons.json` via `npm run build-registry`

- [ ] **Step 1: English docs.** In `docs/guide/ramble.md` insert after "## Chores":

```markdown
## Nests and the egg shelf

Nests are spawn points in the world. Each ISO week, every geohash-7 cell (about 150 m square) either has a nest or not, decided by a public formula — `sha256("ramble-nest-v1:" + cell + ":" + week)`, a nest when the first 32 bits mod `nest.rate` (default 24) is 0 — so everyone sees the same nests with no server involved and nothing about people is revealed. The map shows them as egg pins once you zoom in (zoom 14 or closer).

Walk within **75 m** of a nest and tap **Take the egg**: a new egg lands on your **shelf** (unhatched, warmth 0, marked with the cell and week it was found in). Limits: **one claim per local day** and a **shelf cap of 5** (`shelf.cap`); both refusals come back as a friendly reason, not an error. Claiming the same nest twice returns the same egg. A claim credits **no** warmth and feeds **no** energy — the egg is the reward. Claims are recorded per instance (`ramble_nest_claims`) and never replicate; the egg itself does.

Exactly one egg incubates at a time. From the **Flock** screen you can **incubate** any shelf egg; the one it replaces goes to the shelf keeping its warmth. Instance sync distinguishes an egg *you* parked (`shelf_origin = 'user'`) from one the sync layer shelved while reconciling two instances (`'sync'`): only the latter is ever pulled back into the incubating slot automatically.

## Your flock

Every hatched bird stays in your flock. The Flock screen lists them with the **active** one tagged — that is the bird on your map, in the Nest header and on your public caws — and tapping another bird activates it (`POST /api/ramble/birds/:id/activate`). The score is species found out of the 8 kinds; a second bird of a kind you already have is still a bird, just not a new kind.
```

Add to the **Configuration → settings** area (new subsection after "Warmth weights"):

```markdown
### Nests and shelf

| Key | Default | Effect |
|---|---|---|
| `nest.rate` | 24 | About one nest per this many geohash-7 cells per week (integer ≥ 1). Replicates with your settings, so your own instances agree; it is an operator knob, and a changed rate no longer matches other people's nests. |
| `shelf.cap` | 5 | How many unhatched eggs the shelf holds (integer ≥ 0; 0 turns claiming off). |
```

Add three rows to the **MCP tools** table: `ramble_flock` — "Your flock: birds, the shelf, the incubating egg, species found."; `ramble_nests` — "Nests near a location this week, nearest first, with your claims marked."; `ramble_claim_nest` — "Claim the nest you are standing at (or a named cell within 75 m) for a shelf egg." Add to the routes prose: `GET /api/ramble/nests?bbox=south,west,north,east`, `POST /api/ramble/nests/claim`, `GET /api/ramble/flock`, `POST /api/ramble/eggs/:id/incubate`. Under **Operating notes** add three items: "The one-claim-per-day limit and the shelf cap are checked per instance (claims do not replicate), so a user with two Crows can claim once per day on each." — "The cap only gates claims. Incubating an egg the sync layer had parked (`shelf_origin='sync'`) moves the egg it replaces to your own shelf without anything leaving, so the shelf can briefly read `6 of 5`; it settles as you hatch." — "Two instances can disagree for one sync cycle about which egg incubates: if you swap eggs on one Crow while the other is still crediting warmth to the old egg, the older egg wins on both sides and your swap is undone (consistently). Swap again once both are in sync."

- [ ] **Step 2: Spanish docs + a parity guard.** Mirror the same sections in `docs/es/guide/ramble.md` ("## Nidos y el estante de huevos", "## Tu bandada", "### Nidos y estante", the three tool rows, the operating note), translated in full — no English left in the Spanish page. No existing test compares `docs/` pages (`tests/i18n-global-parity.test.js` only checks the dashboard key table), so add one to `tests/ramble-panel.test.js` (add `readFileSync` to its `node:fs` import):

```js
test("docs: the Spanish Ramble guide mirrors the English heading structure", () => {
  const levels = (p) => readFileSync(join(REPO_ROOT, p), "utf8").split("\n")
    .filter((l) => /^#{2,3} /.test(l)).map((l) => l.split(" ")[0]);
  assert.deepEqual(levels("docs/es/guide/ramble.md"), levels("docs/guide/ramble.md"),
    "en/es Ramble guides must have the same number, order and level of ##/### headings");
});
```

- [ ] **Step 2b: Spec wording.** In `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` §2.4 replace "its point is the cell centre offset by `(h[4..8], h[8..12]) mod cell extent`" with "its point is the cell's south-west corner plus `h[4..8] / 2^32` of the cell height north and `h[8..12] / 2^32` of the cell width east (always inside the cell); its egg-art seed is `h[12..16]`" — the same point set, spelled so phase 4's client-side AR cannot re-derive it differently.

- [ ] **Step 3: Version bump + registry.** Set `"version": "0.3.0"` in `bundles/ramble/manifest.json` and `bundles/ramble/package.json`; update the manifest `description` to "Proximity broadcasts (caws) + a shared/private map of discoverable marks, with a bird companion: eggs, nests, an egg shelf and a flock." Then:

```bash
npm run build-registry
git diff --stat registry/add-ons.json
node scripts/build-registry.mjs --check && echo REGISTRY-OK
```

- [ ] **Step 4: Run the whole ramble set + the bundle guards**

```bash
node scripts/run-suite.mjs tests/ramble-tables.test.js tests/ramble-sync.test.js tests/ramble-nests.test.js tests/ramble-flock.test.js tests/ramble-eggs.test.js tests/ramble-feed.test.js tests/ramble-tools.test.js tests/ramble-panel.test.js tests/ramble-stream.test.js tests/ramble-header-bird.test.js tests/bundle-server-deps.test.js
```

Expected: all PASS.

- [ ] **Step 5: Full suite**

```bash
npm test 2>&1 | tail -20
```

Expected: pass count ≥ phase-1 floor (4025) + the new tests, 0 fail. Also `node scripts/check-port-allocation.js` (no new port; must still pass).

- [ ] **Step 6: Commit**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md docs/superpowers/specs/2026-09-07-ramble-flock-design.md tests/ramble-panel.test.js bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json -m "ramble 0.3.0: nests, flock and egg shelf docs; registry"
git show --stat HEAD
```

- [ ] **Step 7: PR + deploy (operator rail, from the handoff rules).** `git pull --rebase origin main`, push `feat/ramble-flock-phase2`, open the PR against `main` (no AI attribution), wait for check-runs on the head sha (`https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` — every run `completed`/`success`), merge. Then restart the crow primary + r4 gateways and grackle deliberately — **every gateway in the fleet, before anyone claims a nest**: `applyRambleEgg` is core code, and a gateway still on phase-1 core drops `shelf_origin` from incoming rows and can re-promote a user's egg — and confirm grackle's journal shows the bundle refresh to 0.3.0, `[ramble] transport started`, `[panel] ramble routes mounted` and `addon ramble: connected`. Write the handoff `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase2-shipped.md` (state, rulings, next = phase 3 contacts delivery → gifts → swaps).

---

## Self-review notes (coverage against the spec, phase 2 scope)

- §2.4 nest formula, rate 24, point inside the cell, public salt → Task 2 (exact-formula test). Claim within 75 m, one per local day, shelf cap 5 with friendly reasons, per-user claims → Task 3. Nests on the map (egg pins) + `GET /api/ramble/nests` → Tasks 6–7 (bbox instead of `cells=`, recorded).
- §2.5 exactly one incubating egg + `POST /eggs/:id/incubate` → Task 4/6; `active_egg_id` + `POST /birds/:id/activate` → Task 4/6; flock screen with birds, shelf (incubating marked), "8 kinds, N found" → Task 7. Gift/swap actions are phase 3 and are NOT rendered as dead buttons.
- §5 `ramble_nest_claims (cell, week, egg_id, PK(cell, week))` + `claimed_at` (addition for the daily limit) → Task 3, local, asserted not synced. `shelf_origin` (the handoff's required marker) → Task 1, on the wire. Settings `nest.rate`, `shelf.cap` → Task 3.
- §7 routes: nests, claim, flock, incubate, activate → Task 6. Tools `ramble_flock`, `ramble_claim_nest` (+ `ramble_nests`, recorded addition) → Task 5. `ramble:nest-claimed` named SSE event → Task 6.
- §9: all inputs bounded (cell regex, week regex, lat/lon, egg-id regex, zod), seeds server-derived, claims local → Tasks 3/5/6.
- §10: nest determinism on two "devices", rate honoured, claim limits, sync round-trips (outbox door for a claimed egg; apply door for `shelf_origin`, convergence marks, re-promotion filter and the user-shelve gate), panel routes over loopback, stream frame allow-list → Tasks 1–7.
- Type consistency checked: `nestFor/cellsInBbox/nestsInCells`, `readFlockSettings/listNests/claimNest/incubateEgg/activateBird/flockState`, `startOfLocalDay` (exported in Task 3), `CELL7_RE/WEEK_RE` used by routes via `mods.nestsMod`, reasons `stale-week|no-nest|too-far|daily-limit|shelf-full` and `not-found|not-an-egg|not-a-bird` spelled identically in modules, routes, tools, tests and the client's `CLAIM_REASON` map.

## Review

### Round 1 (2026-09-07, adversarial staff-engineer subagent, code-traced) — REVISE → fixed inline
Four criticals, all folded in above: **C1** a sync-promoted old loser (origin cleared to NULL on promotion) still out-ranked the user's later incubate choice by `created_at` after any hatch, reverting the choice on both sides within one sync cycle → ruling: a promotion KEEPS `shelf_origin='sync'`, and the convergence rule ranks class first (NULL beats `'sync'`; age only between equals), both for the wire row and the local rival; new two-instance test replays hatch → promote → successor and both arrival directions. **C2** the flock view could never display (views switch by CSS; no `[data-view="flock"]` selector) → Task 7 edits the view rule + a CSS assertion. **C3** the plan's own comment ("the only html: sink") tripped the plan's own sink-count assertion → comment reworded, assertion strips comments and matches `.innerHTML =` / `html: ` literally. **C4** the tools test's fixed ±0.01° box holds ONE nest in 2026-W06 (computed through 2040) and dereferenced `nests[1]` → the test derives two nest points from the formula for the current week; the tool's box widened to ±0.02°.
Suggestions applied: **S1** flock claim test never crosses into W38 in any timezone (days 0–5 only); **S2** "a claim is not activity" asserts warmth AND energy before/after; **S3** no docs parity test existed → one added to `ramble-panel.test.js`; **S4** exact `paintPerchSay` replacement given; **S5** shelf cap and `shelf_count` count `'user'` shelf eggs only (sync losers never eat the five spots); **S6** claim docstring states the read-then-insert limits honestly; **S7** wide-bbox assertion uses a 0.2° square; **S8** spec §2.4 wording amended to the SW-corner + fraction formula (Task 8 Step 2b); **S9** ten-minute nest refresh; **S10** deploy step: restart every gateway before anyone claims.
Rulings (Q1–Q3): class-ranked tiebreak adopted (not an "accepted limitation"); incubating a `'sync'` shelf egg is allowed and the swap writes NULL; an activate happy-path test with a planted hatched bird added to Task 6.

### Round 2 (2026-09-07, fresh adversarial subagent, code-traced; all 14 round-1 fixes re-verified as holding) — REVISE → fixed inline
**N1** the class rule's fallback to the local row's `shelf_origin` was dead code (the existing-row SELECT never fetched the column), re-opening the C1 regression for sparse rows from a phase-1 peer during a rolling restart → the SELECT now fetches `shelf_origin`; test 5 gains a no-key `L incubating` op that N must still beat, and a no-key shelf row that must land as `'sync'`.
Suggestions applied: a phase-1 peer's key-less shelf row defaults to `'sync'` in the apply (not only at next boot); line cites corrected (`startOfLocalDay` at `eggs.js:93`, view rule at `ramble.css:119-121`, "five new tests"); `server.js` extends its existing `./eggs.js` import instead of duplicating it; the client-side stream assertion moved from Task 6 to Task 7 so every commit is green; the shelf-overshoot case ("6 of 5" after incubating a `'sync'` egg) is documented, incubate stays un-gated (gating would strand a warm `'sync'` egg); nest popups are built on open so the walk hint uses the current fix; `rambleEggSetClause` keeps a hatched row's origin; the round-2 Q1 limitation (a concurrent warmth tick on the other device can consistently undo a swap) is documented in Operating notes.
Rulings (Q1–Q3): convergence over choice-preservation when the shelve op loses LWW (documented, not fixed — the alternative diverges); the millisecond stray-mint window between the two applies is accepted (it yields one `'sync'` shelf row that costs no shelf spot); deploy stays "restart every gateway back-to-back before anyone claims" — the fleet is three gateways and N1's fix makes the mixed window safe anyway.

### Scoped check (2026-09-07, narrow re-review of the round-2 edits; the N1 fix and the test-5 additions were re-simulated against a rebuilt `applyRambleEgg` in memory and shown non-vacuous) — REVISE → fixed inline
All round-2 fixes hold technically. Three textual regressions from the round-2 edits fixed: Task 7's commit line and Files block now include `tests/ramble-stream.test.js` (the moved client assertion would otherwise never reach the PR); Task 7 Step 7 no longer refers to a test "left red in Task 6"; Task 1 Step 7(d) no longer says `rambleEggSetClause` is untouched (it gains the (c2) branch). Name sweep (19 exports), reason strings, and all eight commit lines verified consistent. Behaviour note recorded for executors: returning to the world view does not fire `moveend` in Leaflet 1.9.4 unless the size changed, so nest pins stay as last drawn until a pan, the SSE frame, or the ten-minute refresh — accepted.

**Status: plan complete, three review gates passed. Awaiting Kevin's approval before execution (superpowers:subagent-driven-development in `/home/kh0pp/crow-wt-flock2`).**
