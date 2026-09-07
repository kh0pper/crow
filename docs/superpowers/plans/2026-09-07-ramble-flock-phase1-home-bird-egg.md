# Ramble Flock — Phase 1 (home, bird, egg, hatch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shipped Ramble core into the game's first phase: a procedural bird genome engine, an incubating egg that hatches from world activity, daily chores, the bird riding on public caws/marks, the Nest header crow becoming your bird, a "Just me" audience, and the panel rewritten around the world-first home in visual direction C.

**Architecture:** Same `bundles/ramble` bundle. Three new server modules (`bird-svg.js` dependency-free dual Node/browser script, `eggs.js` warmth/hatch with an idempotency ledger, `feed.js` the single fan-out every hook calls) plus extensions to `pet.js` (chores), `marks.js`/`nostr-map.js` (bird on the wire, `private` visibility), the MCP server and panel routes, sync handlers for `ramble_eggs`/`ramble_pet`, one named SSE event, one small change to the shared header script, and a rewritten panel client/HTML. No new host port, no `SCHEMA_GENERATION` bump, no transport redesign.

**Tech Stack:** Node ESM (bundle + core), libsql-shaped async DB client via `app-root.js`, `zod`, `nostr-tools` (unchanged), plain-script client with Leaflet 1.9.4 (vendored, unchanged), Google Fonts (CSP already allows), SSE via `servers/shared/event-bus.js`.

**Spec:** `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` (§2.1–2.3, §3 world/egg/pet, §4 `bird` on public wire, §5 eggs/pet/credits, §7 routes/tools/events, §8 tokens, §10 tests, §11 phase 1). Phase-1 core spec: `docs/superpowers/specs/2026-09-06-ramble-proximity-ar-design.md`.

## Global Constraints

- **DB access:** bundle server code reaches the DB only through `server/app-root.js` → `appImport("servers/db.js")` / the bundle's `createDbClient()` (never a second SQLite driver in the gateway process). Client is async libsql-shaped: `await db.execute({ sql, args })`, `await db.executeMultiple(sql)`, `await db.batch([...])`.
- **No `SCHEMA_GENERATION` bump:** new columns via `PRAGMA table_info` + guarded `ALTER TABLE` in `bundles/ramble/server/init-tables.js` (existing pattern for `ramble_pet.week_start`); new tables via `CREATE TABLE IF NOT EXISTS`. Never edit `scripts/init-db.js`.
- **Every replicated table carries `lamport_ts INTEGER DEFAULT 0`** (the stdio outbox row-stamp batch throws without it) and needs: an entry in `SYNCED_TABLES`, `EXCLUDED_COLUMNS` (at least `["lamport_ts"]`), a natural-key apply handler (LWW on the envelope lamport, like `applyRambleSetting` at `servers/sharing/instance-sync.js:~447`), a `shouldSyncRow` gate, a `stampSql` by-key branch (`servers/shared/sync-stamp.js:~182`), and both outbox-door and apply-door tests. The emit hook shape everywhere is `emit(table, op, row)`; in the stdio process it is `emitOrQueue(null, db, …)`, in the gateway `emitOrQueue(getInstanceSyncManager(), db, …)`.
- **Seeds are server-minted, immutable, never accepted from a client.** `bird = { species ∈ ROSTER, seed ∈ uint32 }`; anything else off the wire is dropped to no bird.
- **Credits are idempotent server-side** via `ramble_credits(kind, key)`: `visit_place` keyed `cell7:isoWeek`, `checkin` keyed `YYYY-MM-DD` (local day), `meet_crow` keyed `persona:isoWeek`, chores keyed `kind:YYYY-MM-DD`. A repeated credit returns `{ credited: false }` and changes nothing.
- **Warmth weights and thresholds are settings** (`ramble_settings` keys `warmth.visit_place`=20, `warmth.mark_left`=15, `warmth.unlock_mark`=10, `warmth.meet_crow`=20, `warmth.checkin`=8, `warmth.hatch_at`=100), read with defaults; never hard-coded in handlers.
- **Wire:** public marks/caws carry `bird: { species, seed }` in the JSON content when an active bird exists; kinds 30397/20397, every-prefix `g` tags, NIP-40 `expiration`, x-only authors — all unchanged. Phase-1 wire stays public-only; `private` marks never leave the instance (the drain already selects `visibility='public'`).
- **Panel rules:** `router.use("/api/ramble", dashboardAuth)` path-scoped (never unpathed); client script `static/ramble.js` contains ZERO backticks; never `express.static`; nothing under `PUBLIC_FUNNEL_PREFIXES`; every input bounded (zod `.max`, enums).
- **Visual direction C tokens** (spec §8) are the only palette: light bg `#f7f5ef` / surface `#fffdf8` / surface-2 `#efeae0` / text `#24273a` / muted `#6a6e85` / line `#2a2d3e` / accent `#f7c948` / accent-2 `#5b7cff` / accent-3 `#ff7a9c`; dark bg `#151827` / surface `#1e2236` / surface-2 `#272c45` / text `#f1f0f8` / muted `#aeb2cc` / line `#c9cbe0` / accent `#ffd166` / accent-2 `#8c9bff`; radius 20/13; shadow `4px 4px 0 line`; borders `2.5px solid line`; fonts "Baloo 2" (display) + "Nunito" (body) with system fallbacks; icons inline SVG, never emoji. Dark mode keys off the Nest's `data-theme="dark"` on `<html>`.
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` then `node scripts/run-suite.mjs tests/<file>.test.js` (never bare `node --test`). In-memory `createClient({ url: "file::memory:" })` from `@libsql/client` in TEST files only; bundle server files never import it.
- **Commits:** subject-only, positional paths (`git commit <paths> -m …`), verify `git show --stat HEAD`, **no AI attribution trailers**. Work in the worktree, never `git checkout` a branch in `~/crow`. `main` is protected: PR + green `suite`/`static-checks`/`audit` on the head sha.
- **Registry is generated:** `npm run build-registry` after any manifest change (none expected in this phase).
- **Base:** branch from `main` at or after `ee35c08e` (PR #309): the Android bridge `Crow.setPullToRefresh(boolean)` and the client's map touch hooks already exist there and are kept.
- **Zero-backtick rule also binds Task 12:** `tamagotchiJs()` in `notifications.js` returns ONE template literal, so any backtick or `${` inside the code you add breaks the module at load time.
- **Replication policy for `ramble_pet`:** the row replicates (spec §5) but ONLY `feed`, `doChore` and the hatch path emit; the decay-on-read write inside `petState` never emits (a `GET` must never queue sync ops). Energy may drift between instances; last-writer-wins settles it. `private` marks DO replicate to the user's own instances (deliberate — `shouldSyncRow('ramble_marks')` is unchanged).
- **Deliberate deviations from spec wording:** seeds/species use `crypto.randomInt` (spec says "randomUUID-derived"); the engine's signature is `drawBird(genome, mood) -> string` + `mountBird(el, genome, mood)` (spec writes `drawBird(svg, genome, mood)`). Both are improvements; no spec change needed.
- **Known phase-1 limit:** a hatch triggered from the stdio MCP process (`ramble_checkin`, `ramble_leave_mark`) cannot reach the gateway's in-process event bus, so it emits no `ramble-hatched` SSE frame; the panel learns of it on its next `GET /api/ramble/pet` or `/egg` poll (Task 11 polls after every action).

---

## File structure

```
bundles/ramble/server/
  init-tables.js        MODIFY: ramble_eggs, ramble_credits; ALTERs on ramble_pet (active_egg_id, chores_json, lamport_ts) and ramble_marks (bird_species, bird_seed)
  bird-svg.js           NEW: ROSTER, rollGenome(seed, species), drawBird(target, genome, mood) -> svg string; dual Node/browser
  eggs.js               NEW: ensureIncubatingEgg, creditWarmth, checkin, hatchIfReady, eggState, activeBird
  feed.js               NEW: feedAll(db, event, opts) -> { egg, pet, hatched }  (the one fan-out)
  pet.js                MODIFY: doChore (once/day), FEED_DELTAS gains checkin/chore/mark_left, petState returns chores + bird
  marks.js              MODIFY: 'private' visibility; listMarks owner-only rule for private; insertRemoteMark stores bird_*; createMark accepts bird
  nostr-map.js          MODIFY: markToEvent(row, { bird }) content.bird; eventToMark validates bird -> bird_species/bird_seed
  server.js             MODIFY: tools ramble_egg_state / ramble_checkin / ramble_chore; leave_mark feeds mark_left; 'private'
bundles/ramble/panel/
  routes.js             MODIFY: /api/ramble/egg, /egg/checkin, /pet/chore, /pet (bird), /bird/:species/:seed.svg, 'private'; feedAll at hooks
  ramble.js             REWRITE: direction-C panel HTML (world / egg / pet views), tokens CSS
  static/ramble.css     NEW: direction-C stylesheet (tokens + components)
  static/ramble.js      REWRITE: world-first client: map + perch (bird/egg), visibility chip -> grid sheet, compose (Just me), nearby list, egg view, pet view + chores, hatch moment, SSE named events
  (bird-svg.js is served to the browser from server/bird-svg.js by a route added in Task 10; the file is not duplicated)
servers/sharing/instance-sync.js     MODIFY: ramble_eggs + ramble_pet in SYNCED_TABLES/EXCLUDED_COLUMNS; applyRambleEgg, applyRamblePet; applyRemoteOp switch; shouldSyncRow
servers/shared/sync-stamp.js         MODIFY: stampSql branches for ramble_eggs (egg_id) and ramble_pet (owner)
servers/gateway/boot/ramble-transport.js   MODIFY: pass the active bird into markToEvent; feed meet_crow through feedAll on receipt
servers/gateway/routes/streams.js    MODIFY: ramble-nearby channel also relays `ramble:hatched` as a named event
servers/gateway/dashboard/shared/notifications.js   MODIFY: header crow draws the active bird when /api/ramble/pet reports one
docs/guide/ramble.md, docs/es/guide/ramble.md      MODIFY: eggs, hatch, chores, Just me

tests/
  ramble-bird-svg.test.js   NEW
  ramble-eggs.test.js       NEW
  ramble-feed.test.js       NEW
  ramble-pet.test.js        MODIFY (chores)
  ramble-tables.test.js     MODIFY (new tables/columns)
  ramble-sync.test.js       MODIFY (eggs + pet round-trips)
  ramble-nostr-map.test.js  MODIFY (bird)
  ramble-marks.test.js      MODIFY (private, bird columns)
  ramble-tools.test.js      MODIFY (new tools)
  ramble-panel.test.js      MODIFY (new routes, panel markers, zero backticks, CSS served)
  ramble-stream.test.js     MODIFY (hatched event)
  ramble-header-bird.test.js NEW (notifications script parses + contains the bird hook)
```

**Milestones:** M1 = engine + model (Tasks 1–6: tables, bird-svg, eggs, feed, pet chores, sync). M2 = wire + doors (Tasks 7–10: nostr bird, private audience, MCP tools, routes + stream). M3 = surface (Tasks 11–13: panel rewrite, header crow, docs + integration).

---

## Task 1: Tables and columns

**Files:**
- Modify: `bundles/ramble/server/init-tables.js`
- Test: `tests/ramble-tables.test.js`

**Interfaces:**
- Produces: tables `ramble_eggs (egg_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'shelf', warmth INTEGER NOT NULL DEFAULT 0, species TEXT, seed INTEGER, found_cell TEXT, found_week TEXT, from_crow_id TEXT, created_at INTEGER NOT NULL, hatched_at INTEGER, lamport_ts INTEGER DEFAULT 0)`; `ramble_credits (kind TEXT NOT NULL, key TEXT NOT NULL, credited_at INTEGER NOT NULL, PRIMARY KEY (kind, key))`; columns added by guarded ALTER: `ramble_pet.active_egg_id TEXT`, `ramble_pet.chores_json TEXT`, `ramble_pet.lamport_ts INTEGER DEFAULT 0`, `ramble_marks.bird_species TEXT`, `ramble_marks.bird_seed INTEGER`. Index `ramble_eggs_status ON ramble_eggs(status)`. **No unique index on `status`:** eggs are minted per instance (`randomUUID`), so two of the user's instances legitimately hold different `incubating` rows until sync converges them (Task 6's convergence rule); a DB-level uniqueness constraint would make the peer's row throw inside `applyRambleEgg` and be silently dropped. "Exactly one incubating egg" is enforced in code (`ensureIncubatingEgg`) and by the apply handler.

- [ ] **Step 1: Extend the tables test**

Add to `tests/ramble-tables.test.js` (keep the existing tests):

```js
test("flock tables + columns exist (phase 1)", async () => {
  const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const names = rows.map((r) => r.name);
  for (const t of ["ramble_eggs", "ramble_credits"]) assert.ok(names.includes(t), `missing ${t}`);
  const cols = async (t) => (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name);
  const pet = await cols("ramble_pet");
  for (const c of ["active_egg_id", "chores_json", "lamport_ts", "week_start"]) assert.ok(pet.includes(c), `ramble_pet.${c}`);
  const marks = await cols("ramble_marks");
  for (const c of ["bird_species", "bird_seed"]) assert.ok(marks.includes(c), `ramble_marks.${c}`);
  const eggs = await cols("ramble_eggs");
  for (const c of ["egg_id", "status", "warmth", "species", "seed", "found_cell", "found_week", "from_crow_id", "created_at", "hatched_at", "lamport_ts"]) assert.ok(eggs.includes(c), `ramble_eggs.${c}`);
});

test("credits primary key rejects a duplicate (kind,key)", async () => {
  await db.execute({ sql: "INSERT INTO ramble_credits (kind, key, credited_at) VALUES (?,?,?)", args: ["checkin", "2026-09-07", 1] });
  await assert.rejects(db.execute({ sql: "INSERT INTO ramble_credits (kind, key, credited_at) VALUES (?,?,?)", args: ["checkin", "2026-09-07", 2] }));
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-tables.test.js` (missing tables/columns).

- [ ] **Step 3: Implement** in `init-tables.js`: add the two `CREATE TABLE IF NOT EXISTS` blocks + the index, and generalize the existing `week_start` guard into a small helper used for all five columns:

```js
async function ensureColumn(db, table, column, ddl) {
  const info = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  if (!info.rows.some((r) => r.name === column)) {
    await initTable(db, `${table}.${column}`, `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}
// …after the ramble_pet CREATE:
await ensureColumn(db, "ramble_pet", "week_start", "INTEGER");
await ensureColumn(db, "ramble_pet", "active_egg_id", "TEXT");
await ensureColumn(db, "ramble_pet", "chores_json", "TEXT");
await ensureColumn(db, "ramble_pet", "lamport_ts", "INTEGER DEFAULT 0");
// …after the ramble_marks CREATE:
await ensureColumn(db, "ramble_marks", "bird_species", "TEXT");
await ensureColumn(db, "ramble_marks", "bird_seed", "INTEGER");
```

`table`/`column`/`ddl` are module constants only (never user input). `initRambleTables` must stay idempotent (the test calls it twice).

- [ ] **Step 4: Run, expect PASS**; also `node scripts/run-suite.mjs tests/ramble-marks.test.js` and `tests/ramble-pet.test.js` (unchanged, sanity).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/init-tables.js tests/ramble-tables.test.js -m "feat(ramble): eggs + credits tables, pet/marks flock columns"
git show --stat HEAD
```

---

## Task 2: Bird genome engine (`bird-svg.js`)

**Files:**
- Create: `bundles/ramble/server/bird-svg.js`
- Test: `tests/ramble-bird-svg.test.js`

**Interfaces:**
- Produces (dual shim: `window.RambleBird = api` in browsers, `module.exports = api` when `module` exists; the file has NO `import`/`export` statements so the gateway can serve it verbatim as a classic script and Node tests can `createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.js")`):
  - `ROSTER: string[]` = `["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"]`; `SPECIES[id]` = `{ name, base: [hex…], belly?, crest, tail, beak, size, sheen?, longbeak?, longneck?, feet? }`.
  - `rollGenome(seed: number, species: string) -> genome` — deterministic from `(seed, species)`: `{ species, seed, body, belly, accent, eye, mark, hat, size, plump, tilt }`. Throws on an unknown species or a non-uint32 seed.
  - `drawBird(genome, mood = "happy") -> string` — the inner SVG markup (a `<g>` for a `viewBox="0 0 200 200"`), byte-identical for identical inputs; `mood ∈ happy|tired|alarmed`.
  - `mountBird(svgEl, genome, mood)` (browser helper) — sets `viewBox` and `innerHTML = drawBird(...)`.
  - `drawEgg(seed) -> string` — inner SVG for a `viewBox="0 0 120 150"` egg, deterministic per seed (used for the perch and the egg screen).
  - `isValidBird(x) -> boolean` — `x && ROSTER.includes(x.species) && Number.isInteger(x.seed) && x.seed >= 0 && x.seed <= 0xffffffff`.
  - `PARTS` — a name→path-data map for the primitives that vary by species (body, head, wing, tail, beak, crest, feet, extras) so an asset pack can override entries (spec D6); `drawBird` composes from `PARTS`, never inlines those paths.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Bird = require("../bundles/ramble/server/bird-svg.js");

test("roster is the lab flock and species table is complete", () => {
  assert.deepEqual(Bird.ROSTER, ["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"]);
  for (const id of Bird.ROSTER) assert.ok(Bird.SPECIES[id] && Bird.SPECIES[id].name, id);
});

test("genome + drawing are deterministic and species/seed-sensitive", () => {
  const a = Bird.rollGenome(123456, "crow"), b = Bird.rollGenome(123456, "crow");
  assert.deepEqual(a, b);
  assert.equal(Bird.drawBird(a), Bird.drawBird(b));
  assert.notEqual(Bird.drawBird(Bird.rollGenome(123457, "crow")), Bird.drawBird(a));
  assert.notEqual(Bird.drawBird(Bird.rollGenome(123456, "raven")), Bird.drawBird(a));
  assert.ok(Bird.drawBird(a).startsWith("<g"));
});

test("moods change the drawing; invalid inputs throw", () => {
  const g = Bird.rollGenome(7, "magpie");
  assert.notEqual(Bird.drawBird(g, "tired"), Bird.drawBird(g, "happy"));
  assert.notEqual(Bird.drawBird(g, "alarmed"), Bird.drawBird(g, "happy"));
  assert.throws(() => Bird.rollGenome(7, "dodo"));
  assert.throws(() => Bird.rollGenome(-1, "crow"));
  assert.throws(() => Bird.rollGenome(2 ** 32, "crow"));
});

test("isValidBird gates the wire shape", () => {
  assert.equal(Bird.isValidBird({ species: "crow", seed: 1 }), true);
  assert.equal(Bird.isValidBird({ species: "dodo", seed: 1 }), false);
  assert.equal(Bird.isValidBird({ species: "crow", seed: 1.5 }), false);
  assert.equal(Bird.isValidBird({ species: "crow", seed: 2 ** 32 }), false);
  assert.equal(Bird.isValidBird(null), false);
});

test("drawEgg is deterministic per seed", () => {
  assert.equal(Bird.drawEgg(5), Bird.drawEgg(5));
  assert.notEqual(Bird.drawEgg(5), Bird.drawEgg(6));
  assert.throws(() => Bird.drawEgg(-1));
});

test("parts are overridable by name (asset-pack seam)", () => {
  const g = Bird.rollGenome(42, "penguin");
  const before = Bird.drawBird(g);
  const saved = Bird.PARTS.beak;
  Bird.PARTS.beak = "M0 0 h1"; // an override
  try { assert.notEqual(Bird.drawBird(g), before); } finally { Bird.PARTS.beak = saved; }
});

test("no ESM syntax (must load as a classic browser script)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/ramble/server/bird-svg.js", import.meta.url), "utf8");
  assert.ok(!/^\s*(import|export)\s/m.test(src));
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-bird-svg.test.js`.

- [ ] **Step 3: Implement `bird-svg.js`.** Shape (fill in the drawing with the same anatomy the design mockups used — body ellipse, belly, wing, head circle, eye + highlight, beak, feet, tail, species crest/neck/sheen, mood tweaks; keep every species-varying path in `PARTS`):

```js
/* Ramble bird genome engine — dependency-free, dual Node/browser. No ESM syntax. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleBird = api;
})(this, function () {
  var ROSTER = ["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"];
  var SPECIES = {
    crow:        { name: "Crow",        base: ["#2b2f3a","#1f2230","#343a4a"], crest: 0.15, tail: 1.0,  beak: "#d9a521", size: 1.0 },
    raven:       { name: "Raven",       base: ["#1c1f2b","#262a3a","#2d3347"], crest: 0.35, tail: 1.15, beak: "#3b3b3b", size: 1.1 },
    grackle:     { name: "Grackle",     base: ["#1b3a4b","#2a4f6e","#173d3a"], crest: 0.1,  tail: 1.3,  beak: "#2d2d2d", size: 0.95, sheen: true },
    magpie:      { name: "Magpie",      base: ["#1e2230","#232a3e"], belly: "#f5f1ea", crest: 0.05, tail: 1.4, beak: "#2d2d2d", size: 1.0 },
    mockingbird: { name: "Mockingbird", base: ["#9a9ea8","#8b93a3","#a8adb5"], belly: "#f2efe9", crest: 0.2, tail: 1.2, beak: "#4a4a4a", size: 0.9 },
    hummingbird: { name: "Hummingbird", base: ["#1f9e7a","#2bb38a","#1a7f8f"], belly: "#dff5ea", crest: 0.0, tail: 0.6, beak: "#333333", size: 0.7, longbeak: true },
    penguin:     { name: "Penguin",     base: ["#1f2430","#2a3040"], belly: "#fbfbfb", crest: 0.0, tail: 0.4, beak: "#f2a33a", size: 1.05, feet: "#f2a33a" },
    blackswan:   { name: "Black swan",  base: ["#20222c","#2b2d3a"], crest: 0.0, tail: 0.8, beak: "#d94a4a", size: 1.1, longneck: true }
  };
  var EYES = ["round","sparkle","sleepy","wink"], MARKS = ["none","cheeks","starburst","collar","freckles"], HATS = ["none","none","none","bow","leaf","beanie"];
  var ACCENTS = ["#f7c948","#5b7cff","#ff7a9c","#7bd389","#c77dff","#ff8a5b"];
  var PARTS = { /* name -> path data; body/head are ellipses computed from genome, the rest are here */
    beak: "M0 0 l20 5 l-20 6 z", longbeak: "M0 0 l34 -3 l-33 9 z", foot: "M0 0 v16 m-8 0 h16",
    tail: "M0 0 l-26 -14 l4 22 z", crest: "M0 0 q6 -18 14 -6 q-6 4 -8 10 z",
    bow: "M0 0 l-12 -7 v14 z M0 0 l12 -7 v14 z", leaf: "M0 0 q14 -16 26 -8 q-12 4 -20 14 z", beanie: "M-26 0 q26 -34 52 0 z"
  };
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function hueShift(hex, deg, sat) {
    var c = parseInt(hex.slice(1), 16), R = c >> 16 & 255, G = c >> 8 & 255, B = c & 255;
    var r = R / 255, g = G / 255, b = B / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, sl = 0, l = (mx + mn) / 2;
    if (mx !== mn) { var d = mx - mn; sl = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4); h /= 6; }
    h = (h + deg / 360 + 1) % 1; sl = Math.max(0, Math.min(1, sl + sat));
    function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var q = l < .5 ? l * (1 + sl) : l + sl - l * sl, pp = 2 * l - q;
    var rr = Math.round(f(pp, q, h + 1 / 3) * 255), gg = Math.round(f(pp, q, h) * 255), bb = Math.round(f(pp, q, h - 1 / 3) * 255);
    return "#" + ((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1);
  }
  function isUint32(n) { return Number.isInteger(n) && n >= 0 && n <= 0xffffffff; }
  function rollGenome(seed, species) {
    if (!isUint32(seed)) throw new Error("seed must be a uint32");
    var sp = SPECIES[species]; if (!sp) throw new Error("unknown species: " + species);
    var r = mulberry32(seed ^ (ROSTER.indexOf(species) * 0x9E3779B1));
    var body = pick(r, sp.base);
    return { species: species, seed: seed, body: hueShift(body, Math.round((r() - .5) * 24), (r() - .5) * .1),
      belly: sp.belly || hueShift(body, 0, -.05), accent: pick(r, ACCENTS), eye: pick(r, EYES), mark: pick(r, MARKS), hat: pick(r, HATS),
      size: +(sp.size * (0.9 + r() * 0.2)).toFixed(3), plump: +(0.85 + r() * 0.3).toFixed(3), tilt: +((r() - .5) * 10).toFixed(2) };
  }
  function n(v) { return (+v).toFixed(2); }
  function at(x, y) { return "translate(" + n(x) + " " + n(y) + ")"; }
  function drawBird(g, mood) {
    mood = mood === "tired" || mood === "alarmed" ? mood : "happy";
    var sp = SPECIES[g.species]; if (!sp) throw new Error("unknown species: " + g.species);
    var cx = 100, cy = 118, bw = 46 * g.plump, bh = 42, hr = 30, ex = cx + 10, ey = cy - 50, feet = sp.feet || "#c98a3a";
    var eye;
    if (mood === "tired" || g.eye === "sleepy") eye = '<path d="M' + n(ex - 7) + ' ' + n(ey) + ' q 7 5 14 0" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/>';
    else if (g.eye === "wink") eye = '<circle cx="' + n(ex) + '" cy="' + n(ey) + '" r="6" fill="#1a1a1a"/><circle cx="' + n(ex + 2) + '" cy="' + n(ey - 2) + '" r="2" fill="#fff"/>';
    else eye = '<circle cx="' + n(ex) + '" cy="' + n(ey) + '" r="7" fill="#1a1a1a"/><circle cx="' + n(ex + 2.5) + '" cy="' + n(ey - 2.5) + '" r="2.6" fill="#fff"/>' + (g.eye === "sparkle" ? '<circle cx="' + n(ex - 3) + '" cy="' + n(ey + 3) + '" r="1.3" fill="#fff"/>' : "");
    var cheeks = (g.mark === "cheeks" || mood === "happy") ? '<ellipse cx="' + n(cx - 6) + '" cy="' + n(cy - 40) + '" rx="7" ry="4" fill="#ff8fa3" opacity=".55"/>' : "";
    var marks = "";
    if (g.mark === "starburst") marks = '<path transform="' + at(cx - 30, cy - 60) + '" d="M0 0 l3 6 6 1 -4 4 1 6 -6 -3 -6 3 1 -6 -4 -4 6 -1z" fill="' + g.accent + '"/>';
    if (g.mark === "collar") marks = '<path d="M' + n(cx - 26) + ' ' + n(cy - 22) + ' q 26 14 52 0" stroke="' + g.accent + '" stroke-width="6" fill="none" stroke-linecap="round"/>';
    if (g.mark === "freckles") marks = '<g fill="' + g.accent + '" opacity=".8"><circle cx="' + n(cx - 4) + '" cy="' + n(cy - 36) + '" r="1.8"/><circle cx="' + n(cx + 2) + '" cy="' + n(cy - 33) + '" r="1.8"/><circle cx="' + n(cx - 9) + '" cy="' + n(cy - 31) + '" r="1.8"/></g>';
    var hat = "";
    if (g.hat === "bow") hat = '<g transform="' + at(cx - 18, cy - 78) + '"><path d="' + PARTS.bow + '" fill="' + g.accent + '"/><circle r="3.5" fill="#fff"/></g>';
    if (g.hat === "leaf") hat = '<path transform="' + at(cx, cy - 78) + '" d="' + PARTS.leaf + '" fill="#7bd389"/>';
    if (g.hat === "beanie") hat = '<path transform="' + at(cx, cy - 66) + '" d="' + PARTS.beanie + '" fill="' + g.accent + '"/><circle cx="' + n(cx) + '" cy="' + n(cy - 84) + '" r="5" fill="#fff"/>';
    var crest = sp.crest > 0 ? '<path transform="' + at(cx - 4, cy - 76) + ' scale(1 ' + n(sp.crest * 4) + ')" d="' + PARTS.crest + '" fill="' + g.body + '"/>' : "";
    var neck = sp.longneck ? '<rect x="' + n(cx - 8) + '" y="' + n(cy - 60) + '" width="16" height="30" rx="8" fill="' + g.body + '"/>' : "";
    var tail = '<path transform="' + at(cx - bw + 6, cy - 6) + ' scale(' + n(sp.tail) + ' 1)" d="' + PARTS.tail + '" fill="' + g.body + '"/>';
    var beakD = sp.longbeak ? PARTS.longbeak : PARTS.beak;
    var beak = '<path transform="' + at(cx + 22, cy - 46) + '" d="' + beakD + '" fill="' + sp.beak + '"/>';
    var wingDrop = mood === "alarmed" ? -6 : 0;
    var feetSvg = '<g stroke="' + feet + '" stroke-width="4" stroke-linecap="round" fill="none"><path transform="' + at(cx - 12, cy + 34) + '" d="' + PARTS.foot + '"/><path transform="' + at(cx + 12, cy + 34) + '" d="' + PARTS.foot + '"/></g>';
    var alarm = mood === "alarmed" ? '<text x="' + n(cx + 34) + '" y="' + n(cy - 70) + '" font-size="26" font-weight="800" fill="#ef4444" font-family="Baloo 2, sans-serif">!</text>' : "";
    return '<g transform="' + at(cx, cy) + ' rotate(' + n(g.tilt) + ') scale(' + n(g.size) + ') ' + at(-cx, -cy) + '">' +
      feetSvg + tail +
      '<ellipse cx="' + n(cx) + '" cy="' + n(cy) + '" rx="' + n(bw) + '" ry="' + n(bh) + '" fill="' + g.body + '"/>' +
      '<ellipse cx="' + n(cx + 4) + '" cy="' + n(cy + 8) + '" rx="' + n(bw * .62) + '" ry="' + n(bh * .62) + '" fill="' + g.belly + '" opacity=".95"/>' +
      '<ellipse cx="' + n(cx - 22) + '" cy="' + n(cy + 2 + wingDrop) + '" rx="18" ry="24" fill="' + hueShift(g.body, 0, .08) + '" opacity=".9" transform="rotate(-12 ' + n(cx - 22) + ' ' + n(cy + 2) + ')"/>' +
      (sp.sheen ? '<ellipse cx="' + n(cx - 10) + '" cy="' + n(cy - 18) + '" rx="16" ry="8" fill="#7ad3ff" opacity=".25"/>' : "") +
      neck + '<circle cx="' + n(cx) + '" cy="' + n(cy - 50) + '" r="' + n(hr) + '" fill="' + g.body + '"/>' +
      crest + hat + marks + cheeks + eye + beak + alarm + '</g>';
  }
  function drawEgg(seed) {
    if (!isUint32(seed)) throw new Error("seed must be a uint32");
    var r = mulberry32(seed), shell = pick(r, ["#fff4d6","#e8f6f2","#f7e6ff","#ffe9e0","#eef3ff"]), spots = pick(r, ACCENTS), dots = "";
    for (var i = 0; i < 7; i++) dots += '<circle cx="' + n(30 + r() * 60) + '" cy="' + n(40 + r() * 90) + '" r="' + n(3 + r() * 5) + '" fill="' + spots + '" opacity=".7"/>';
    return '<path d="M60 8 C 92 8 108 60 108 92 C 108 126 86 144 60 144 C 34 144 12 126 12 92 C 12 60 28 8 60 8 z" fill="' + shell + '" stroke="#e6d9c8" stroke-width="3"/>' + dots + '<ellipse cx="44" cy="40" rx="10" ry="16" fill="#fff" opacity=".55"/>';
  }
  function mountBird(el, g, mood) { el.setAttribute("viewBox", "0 0 200 200"); el.innerHTML = drawBird(g, mood); }
  function isValidBird(x) { return !!x && typeof x === "object" && ROSTER.indexOf(x.species) >= 0 && isUint32(x.seed); }
  return { ROSTER: ROSTER, SPECIES: SPECIES, PARTS: PARTS, rollGenome: rollGenome, drawBird: drawBird, drawEgg: drawEgg, mountBird: mountBird, isValidBird: isValidBird };
});
```

All numbers inside `drawBird` must be produced with fixed formatting (`toFixed`) so output is byte-stable across platforms. No `Math.random()` anywhere in the file.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/bird-svg.js tests/ramble-bird-svg.test.js -m "feat(ramble): procedural bird genome engine (dual node/browser)"
git show --stat HEAD
```

---

## Task 3: Eggs — warmth, credits ledger, hatch

**Files:**
- Create: `bundles/ramble/server/eggs.js`
- Test: `tests/ramble-eggs.test.js`

**Interfaces:**
- Consumes: `bird-svg.js` (`ROSTER`, `rollGenome` via `createRequire`), `crypto.randomUUID`, settings reads.
- Produces (all async, `db` first; every write that changes `ramble_eggs`/`ramble_pet` calls the optional `emit(table, op, row)`):
  - `WARMTH_DEFAULTS = { visit_place: 20, mark_left: 15, unlock_mark: 10, meet_crow: 20, checkin: 8, hatch_at: 100 }`; `readWarmthWeights(db) -> {...}` (settings `warmth.<k>` override, ints only).
  - `ensureIncubatingEgg(db, { now, emit }) -> egg` — returns the `status='incubating'` egg, creating one **with `status='incubating'` set explicitly** (`egg_id = randomUUID()`, warmth 0, `created_at = now`) if none exists, via `INSERT INTO ramble_eggs (…) SELECT … WHERE NOT EXISTS (SELECT 1 FROM ramble_eggs WHERE status='incubating')` then a re-select (single-connection SQLite makes this race-free within one process).
  - `creditKey(event, { now }) -> { kind, key } | null` — `visit_place` → `{ "visit_place", cell7 + ":" + isoWeek(now) }` (requires `event.cell`); `checkin` → `{ "checkin", localDay(now) }`; `meet_crow` → `{ "meet_crow", event.persona + ":" + isoWeek(now) }` (requires `event.persona`); `mark_left`/`unlock_mark` → `null` (always credited); **`chore` and `quiet_tick` → `{ skip: true }`** (warmth 0 by spec §2.1 — `creditWarmth` returns `{ credited:false, warmth: <current>, hatched:null }` without touching the ledger or the egg; they are pet-only events). `isoWeek(ms) -> "2026-W37"`, `localDay(ms) -> "2026-09-07"` exported (local time of the process).
  - `creditWarmth(db, event, { now, emit }) -> { credited: boolean, warmth: number, hatched: egg|null }` — inserts the credit row first (`INSERT OR IGNORE`; `rowsAffected === 0` → `{ credited:false, warmth: <the incubating egg's current warmth>, hatched:null }`), otherwise adds the weight to the incubating egg (clamped at `hatch_at`), emits `("ramble_eggs","update",eggRow)`, then `hatchIfReady`. Unknown `event.type` → same not-credited shape (no throw).
  - `hatchIfReady(db, { now, emit }) -> egg|null` — when the incubating egg's warmth ≥ `hatch_at`: `species = ROSTER[crypto.randomInt(ROSTER.length)]`, `seed = crypto.randomInt(0, 2**32)`, `status='hatched'`, `hatched_at=now`; if `ramble_pet.active_egg_id` is null set it to this egg **and emit the WHOLE re-selected pet row** (`("ramble_pet","update",petRow)` — never a partial `{owner, active_egg_id}`); create the NEXT incubating egg (so the loop continues; emit its insert) — **the UPDATE to `hatched` MUST run before the successor INSERT** (the code-level "one incubating" guard reads the table between them); return the hatched egg.
  - `checkin(db, { now, emit })` = `creditWarmth(db, { type:"checkin" }, …)`.
  - `eggState(db, { now }) -> { egg: { egg_id, warmth, hatch_at, percent }, checklist: { new_places_week: n, first_mark: bool, checked_in_today: bool } }` (checklist from `ramble_credits` + `ramble_marks` count of local rows).
  - `activeBird(db) -> { egg_id, species, seed } | null` — from `ramble_pet.active_egg_id` → `ramble_eggs`.

- [ ] **Step 1: Write the failing test**

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { ensureIncubatingEgg, creditWarmth, hatchIfReady, checkin, eggState, activeBird, isoWeek, localDay, WARMTH_DEFAULTS } from "../bundles/ramble/server/eggs.js";

let db; const T0 = Date.UTC(2026, 8, 7, 12); // 2026-09-07 12:00Z
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

test("a fresh instance gets exactly one incubating egg", async () => {
  const a = await ensureIncubatingEgg(db, { now: T0 });
  const b = await ensureIncubatingEgg(db, { now: T0 });
  assert.equal(a.egg_id, b.egg_id);
  const { rows } = await db.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'");
  assert.equal(rows[0].n, 1);
});

test("credits are idempotent per key and use the weights", async () => {
  const first = await creditWarmth(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 });
  assert.equal(first.credited, true); assert.equal(first.warmth, WARMTH_DEFAULTS.visit_place);
  const again = await creditWarmth(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 3600e3 });
  assert.equal(again.credited, false); assert.equal(again.warmth, WARMTH_DEFAULTS.visit_place);
  const nextWeek = await creditWarmth(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 8 * 86400e3 });
  assert.equal(nextWeek.credited, true);
  const c1 = await checkin(db, { now: T0 }); const c2 = await checkin(db, { now: T0 + 60e3 });
  assert.equal(c1.credited, true); assert.equal(c2.credited, false);
  assert.equal((await creditWarmth(db, { type: "mark_left" }, { now: T0 })).credited, true);
  assert.equal((await creditWarmth(db, { type: "mark_left" }, { now: T0 })).credited, true); // never keyed
});

test("weights come from settings when set", async () => {
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('warmth.unlock_mark', '3')", args: [] });
  const r = await creditWarmth(db, { type: "unlock_mark" }, { now: T0 });
  assert.equal(r.credited, true);
  const { rows } = await db.execute("SELECT warmth FROM ramble_eggs WHERE status='incubating'");
  assert.ok(rows[0].warmth >= 3);
});

test("hatch at the threshold: rolls a roster species + uint32 seed, activates, and starts the next egg", async () => {
  const emitted = [];
  const emit = async (t, op, row) => emitted.push([t, op, row.egg_id || row.owner]);
  let r;
  for (let i = 0; i < 10 && !(r && r.hatched); i++) r = await creditWarmth(db, { type: "meet_crow", persona: "p" + i }, { now: T0, emit });
  assert.ok(r.hatched, "should have hatched");
  assert.ok(["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"].includes(r.hatched.species));
  assert.ok(Number.isInteger(r.hatched.seed) && r.hatched.seed >= 0 && r.hatched.seed < 2 ** 32);
  const bird = await activeBird(db);
  assert.equal(bird.egg_id, r.hatched.egg_id);
  const { rows } = await db.execute("SELECT status, count(*) AS n FROM ramble_eggs GROUP BY status ORDER BY status");
  assert.deepEqual(rows.map((x) => [x.status, x.n]), [["hatched", 1], ["incubating", 1]]);
  assert.ok(emitted.some(([t, op]) => t === "ramble_eggs" && op === "update"));
  assert.ok(emitted.some(([t]) => t === "ramble_pet"));
  assert.equal(await hatchIfReady(db, { now: T0 }), null); // nothing else ready
});

test("eggState reports percent + checklist", async () => {
  const s = await eggState(db, { now: T0 });
  assert.ok(s.egg.egg_id); assert.equal(typeof s.egg.percent, "number");
  assert.equal(typeof s.checklist.new_places_week, "number");
  assert.equal(s.checklist.checked_in_today, true);
});

test("week and day keys", () => {
  assert.match(isoWeek(T0), /^\d{4}-W\d{2}$/);
  assert.match(localDay(T0), /^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `eggs.js`.** Rules: the credit `INSERT OR IGNORE` and the warmth `UPDATE` are two statements — run the insert first and stop on `rowsAffected === 0`; use `crypto.randomInt` for species/seed (never `Math.random`); `ensureIncubatingEgg` must be safe to call concurrently (an `INSERT … WHERE NOT EXISTS (SELECT 1 FROM ramble_eggs WHERE status='incubating')` pattern, then re-select); load `bird-svg.js` via `createRequire(import.meta.url)("./bird-svg.js")`; `isoWeek` per ISO-8601 (Thursday rule); `localDay` via `new Date(now)` local getters. `emit` calls are awaited inside try/catch (never break a write).

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/eggs.js tests/ramble-eggs.test.js -m "feat(ramble): eggs — warmth credits ledger + hatch"
git show --stat HEAD
```

---

## Task 4: Chores in `pet.js`

**Files:**
- Modify: `bundles/ramble/server/pet.js`
- Test: `tests/ramble-pet.test.js`

**Interfaces:**
- Produces: `FEED_DELTAS` gains `checkin: +5`, `chore: +8`, `mark_left: 0` (existing `visit_place +15`, `unlock_mark +10`, `meet_crow +20`, `quiet_tick −10` unchanged); `CHORES = ["feed","preen","play"]`; `doChore(db, kind, { now, emit }) -> { done: boolean, chores: { day, feed, preen, play }, pet }` — first completion per local day writes `ramble_pet.chores_json` and calls THIS module's `feed(db, { type: "chore" }, …)` directly (never `feed.js` — that would be a circular import); a repeat returns `done:false` with no change; a new day resets the three flags; `petState` gains `chores` (today's flags, day-rolled) and `active_egg_id`. `feed` and `doChore` call `emit("ramble_pet", "update", row)` (the full row) when an `emit` is passed; **`petState`'s decay-on-read write does NOT emit** (Global Constraints). Update the exact-equality assertion `assert.deepEqual(FEED_DELTAS, {...})` at `tests/ramble-pet.test.js:181` to the new key set, and update the header comment in `pet.js:10-12` that still says `ramble_pet` is not synced.

- [ ] **Step 1: Add tests** to `tests/ramble-pet.test.js`:

```js
test("chores: once per day each, +8 energy, day rollover resets", async () => {
  const db = await freshDb(); // ADD this helper at the top of the file: async function freshDb() { const d = createClient({ url: "file::memory:" }); await initRambleTables(d); return d; }
  const T0 = Date.UTC(2026, 8, 7, 12);
  const a = await doChore(db, "feed", { now: T0 });
  assert.equal(a.done, true); assert.equal(a.chores.feed, true); assert.equal(a.chores.preen, false);
  const before = a.pet.energy;
  const b = await doChore(db, "feed", { now: T0 + 60e3 });
  assert.equal(b.done, false); assert.equal(b.pet.energy, before);
  const c = await doChore(db, "preen", { now: T0 });
  assert.equal(c.pet.energy, Math.min(100, before + 8));
  const d = await doChore(db, "feed", { now: T0 + 86400e3 });
  assert.equal(d.done, true); assert.equal(d.chores.preen, false); // new day
  await assert.rejects(doChore(db, "nap", { now: T0 }));
  const s = await petState(db, { now: T0 + 86400e3 });
  assert.deepEqual(Object.keys(s.chores).sort(), ["day","feed","play","preen"]);
});

test("pet writes emit when a hook is given", async () => {
  const db = await freshDb(); const seen = []; // same helper
  await feed(db, { type: "visit_place" }, { emit: async (t, op, row) => seen.push([t, op, row.owner]) });
  assert.deepEqual(seen[0], ["ramble_pet", "update", "self"]);
});
```

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, expect PASS** (whole file).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/pet.js tests/ramble-pet.test.js -m "feat(ramble): daily chores + pet sync emit hook"
git show --stat HEAD
```

---

## Task 5: `feed.js` — the one fan-out

**Files:**
- Create: `bundles/ramble/server/feed.js`
- Test: `tests/ramble-feed.test.js`

**Interfaces:**
- Consumes: `eggs.js` (`creditWarmth`, `ensureIncubatingEgg`), `pet.js` (`feed`).
- Produces: `feedAll(db, event, { now = Date.now(), emit, onHatch } = {}) -> { credited: boolean, warmth: number, hatched: egg|null, pet: petRow }` — `event.type ∈ visit_place|mark_left|unlock_mark|meet_crow|checkin|quiet_tick` (`chore` is NOT accepted here — chores go through `pet.doChore`); `quiet_tick` skips the ledger and ALWAYS runs the pet feed (it is unkeyed); order: `creditWarmth` (which may hatch) then `pet.feed` with the same type (pet ignores `mark_left` energy = 0). A `visit_place`/`meet_crow` that was NOT credited (already this week) still feeds the pet ONLY the first time — i.e. the pet feed is skipped when `credited === false` for keyed types (no double energy), and always runs for unkeyed types. `onHatch(egg)` is awaited when a hatch happened (the gateway passes `bus.emit`). Never throws for an unknown type: returns `{ credited:false, warmth, hatched:null, pet }` after logging a warn.

- [ ] **Step 1: Write the failing test**

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { feedAll } from "../bundles/ramble/server/feed.js";
import { petState } from "../bundles/ramble/server/pet.js";

let db; const T0 = Date.UTC(2026, 8, 7, 12);
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

test("one call credits warmth AND energy; a repeat keyed event credits neither", async () => {
  const e0 = (await petState(db, { now: T0 })).energy;
  const a = await feedAll(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 });
  assert.equal(a.credited, true); assert.equal(a.warmth, 20);
  assert.equal(a.pet.energy, Math.min(100, e0 + 15));
  const b = await feedAll(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 1000 });
  assert.equal(b.credited, false); assert.equal(b.pet.energy, a.pet.energy);
});

test("hatch fires onHatch once with the egg", async () => {
  let hatched = null;
  for (let i = 0; i < 10 && !hatched; i++) {
    await feedAll(db, { type: "meet_crow", persona: "q" + i }, { now: T0, onHatch: (egg) => { hatched = egg; } });
  }
  assert.ok(hatched && hatched.species && Number.isInteger(hatched.seed));
});

test("unknown type is a no-op that does not throw", async () => {
  const r = await feedAll(db, { type: "bogus" }, { now: T0 });
  assert.equal(r.credited, false); assert.equal(r.hatched, null);
});
```

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement `feed.js`** (≈40 lines). — [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/feed.js tests/ramble-feed.test.js -m "feat(ramble): feedAll fan-out (egg warmth + pet energy)"
git show --stat HEAD
```

**Milestone M1 (engine + model) complete after Task 6.**

---

## Task 6: Sync for `ramble_eggs` and `ramble_pet`

**Files:**
- Modify: `servers/sharing/instance-sync.js` (`SYNCED_TABLES`, `EXCLUDED_COLUMNS`, `shouldSyncRow`, new module-level `applyRambleEgg`/`applyRamblePet`, the `_applyEntry` dispatch blocks beside the existing three ramble blocks, `applyRemoteOp` switch)
- Modify: `servers/shared/sync-stamp.js` (`stampSql` branches for `ramble_eggs` by `egg_id` and `ramble_pet` by `owner`, placed BEFORE the generic `row.id` branch; lamport stays `args[0]`)
- Test: `tests/ramble-sync.test.js`

**Interfaces:**
- `SYNCED_TABLES` gains `"ramble_eggs"`, `"ramble_pet"`. `EXCLUDED_COLUMNS.ramble_eggs = ["lamport_ts"]`, `EXCLUDED_COLUMNS.ramble_pet = ["lamport_ts"]`.
- `applyRambleEgg(db, op, row, lamportTs)`: key `egg_id`; LWW skip when `lamportTs < localTs`; delete by key; upsert `INSERT … ON CONFLICT(egg_id) DO UPDATE SET status, warmth, species, seed, found_cell, found_week, from_crow_id, hatched_at, lamport_ts` (columns from the wire row ∩ schema, never binding undefined). **Invariant (hatch is one-way):** `status = CASE WHEN ramble_eggs.status = 'hatched' THEN 'hatched' ELSE excluded.status END`, `species = COALESCE(ramble_eggs.species, excluded.species)`, `seed = COALESCE(ramble_eggs.seed, excluded.seed)`, `hatched_at = COALESCE(ramble_eggs.hatched_at, excluded.hatched_at)` — a peer update can never un-hatch, re-roll, or demote a hatched egg. **Convergence rule (two instances each minted their own incubating egg):** before upserting an incoming row with `status='incubating'`, select the local incubating row; if it exists with a different `egg_id`, exactly one survives as incubating by a deterministic tiebreak — the older `created_at` wins, ties broken by the lexically lower `egg_id` — and the loser is set to `status='shelf'` (warmth kept) in the same `db.batch` as the upsert. Because both instances apply the same rule to the same two rows, they converge without a further round trip. Emit nothing from inside the apply handler (applies never re-emit).
- `applyRamblePet(db, op, row, lamportTs)`: key `owner` (always `'self'`); LWW; upsert only the columns present in the wire row ∩ `[mood, energy, last_fed_at, places_week, unlocks_week, crows_week, week_start, active_egg_id, chores_json]` (never bind undefined) plus `lamport_ts`; deletes are ignored (the pet row is never deleted). Edit the comment at `servers/sharing/instance-sync.js:87-88` that says `ramble_pet` is deliberately not synced.
- **`RAMBLE_MARK_WIRE_COLUMNS` (`instance-sync.js:371-377`) gains `"bird_species", "bird_seed"`** so a replicated mark keeps its bird on the user's other instances (D5); `RAMBLE_MARK_UPDATE_COLUMNS` inherits them.
- `shouldSyncRow`: `ramble_eggs` requires `row.egg_id`; `ramble_pet` requires `row.owner === "self"`.
- `applyRemoteOp(db, table, op, row, lamportTs)` routes the two new tables.

- [ ] **Step 1: Add tests** to `tests/ramble-sync.test.js` (the file already has instances `a` (author) and `b` (peer), the scratch `CROW_DATA_DIR`, `_setEligibilityForTest`):

```js
test("allowlist + exclusions for eggs/pet", () => {
  for (const t of ["ramble_eggs", "ramble_pet"]) assert.ok(SYNCED_TABLES.includes(t), t);
  assert.ok(EXCLUDED_COLUMNS.ramble_eggs.includes("lamport_ts"));
  assert.ok(EXCLUDED_COLUMNS.ramble_pet.includes("lamport_ts"));
  assert.equal(shouldSyncRow("ramble_eggs", { warmth: 1 }), false);
  assert.equal(shouldSyncRow("ramble_pet", { owner: "other" }), false);
  assert.equal(shouldSyncRow("ramble_pet", { owner: "self" }), true);
});

test("outbox door: an egg write with no manager queues and is stamped", async () => {
  const egg = await ensureIncubatingEgg(a, { now: 1000 });
  const res = await emitOrQueue(null, a, "ramble_eggs", "insert", egg);
  assert.ok(res && res.queued, "emitOrQueue returned null — missing stampSql branch or lamport_ts?");
  const { rows } = await a.execute({ sql: "SELECT lamport_ts FROM ramble_eggs WHERE egg_id=?", args: [egg.egg_id] });
  assert.ok(rows[0].lamport_ts > 0);
  await feed(a, { type: "unlock_mark" }, { now: 1000 }); // creates the pet row
  const pet = await a.execute("SELECT * FROM ramble_pet WHERE owner='self'");
  const res2 = await emitOrQueue(null, a, "ramble_pet", "update", pet.rows[0]);
  assert.ok(res2 && res2.queued);
  const stamped = await a.execute("SELECT lamport_ts FROM ramble_pet WHERE owner='self'");
  assert.ok(stamped.rows[0].lamport_ts > 0, "ramble_pet row was never stamped — missing stampSql branch?");
});

test("apply door: egg insert, LWW, hatch survives a stale update, delete", async () => {
  const row = { egg_id: "e1", status: "incubating", warmth: 40, created_at: 1 };
  await applyRemoteOp(b, "ramble_eggs", "insert", row, 5);
  await applyRemoteOp(b, "ramble_eggs", "update", { ...row, warmth: 10 }, 3); // stale
  let got = await b.execute({ sql: "SELECT warmth FROM ramble_eggs WHERE egg_id='e1'", args: [] });
  assert.equal(got.rows[0].warmth, 40);
  await applyRemoteOp(b, "ramble_eggs", "update", { ...row, status: "hatched", species: "crow", seed: 77, hatched_at: 9 }, 7);
  await applyRemoteOp(b, "ramble_eggs", "update", { ...row, species: null, seed: null }, 8); // never un-hatch
  got = await b.execute({ sql: "SELECT status, species, seed, hatched_at FROM ramble_eggs WHERE egg_id='e1'", args: [] });
  assert.equal(got.rows[0].status, "hatched"); // the stale row said 'incubating' — hatch is one-way
  assert.equal(got.rows[0].species, "crow"); assert.equal(got.rows[0].seed, 77); assert.equal(got.rows[0].hatched_at, 9);
  await applyRemoteOp(b, "ramble_eggs", "delete", { egg_id: "e1" }, 9);
  assert.equal((await b.execute("SELECT 1 FROM ramble_eggs WHERE egg_id='e1'")).rows.length, 0);
});

test("two instances' incubating eggs converge deterministically (older wins, loser shelved)", async () => {
  await b.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('local-z','incubating',30,2000)", args: [] });
  await applyRemoteOp(b, "ramble_eggs", "insert", { egg_id: "peer-a", status: "incubating", warmth: 10, created_at: 1000 }, 4); // older peer egg wins
  let got = await b.execute("SELECT egg_id, status, warmth FROM ramble_eggs WHERE egg_id IN ('local-z','peer-a') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.warmth]), [["local-z", "shelf", 30], ["peer-a", "incubating", 10]]);
  await applyRemoteOp(b, "ramble_eggs", "insert", { egg_id: "peer-b", status: "incubating", warmth: 5, created_at: 5000 }, 5); // newer peer egg loses
  got = await b.execute("SELECT egg_id, status FROM ramble_eggs WHERE egg_id IN ('peer-a','peer-b') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["peer-a", "incubating"], ["peer-b", "shelf"]]);
  assert.equal((await b.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
});

test("a synced mark keeps its bird", async () => {
  await applyRemoteOp(b, "ramble_marks", "insert", { mark_id: "mb", author: "pk", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "x", created_at: 1, bird_species: "raven", bird_seed: 9 }, 1);
  const got = await b.execute({ sql: "SELECT bird_species, bird_seed FROM ramble_marks WHERE mark_id='mb'", args: [] });
  assert.equal(got.rows[0].bird_species, "raven"); assert.equal(got.rows[0].bird_seed, 9);
});

test("apply door: pet upserts by owner and ignores deletes", async () => {
  await applyRemoteOp(b, "ramble_pet", "update", { owner: "self", mood: "tired", energy: 31, active_egg_id: "e1", chores_json: "{}" }, 2);
  let got = await b.execute("SELECT energy, active_egg_id FROM ramble_pet WHERE owner='self'");
  assert.equal(got.rows[0].energy, 31); assert.equal(got.rows[0].active_egg_id, "e1");
  await applyRemoteOp(b, "ramble_pet", "delete", { owner: "self" }, 3);
  assert.equal((await b.execute("SELECT 1 FROM ramble_pet WHERE owner='self'")).rows.length, 1);
});
```

(add `ensureIncubatingEgg` from `eggs.js` and `feed` from `pet.js` to the imports.)

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement** (copy the shape of `applyRambleMark`/`applyRambleSetting`; keep the three `if (table === …)` blocks in `_applyEntry` adjacent to the existing ramble ones). — [ ] **Step 4: Run, expect PASS**, plus the regression gate: `tests/instance-sync.test.js`, `tests/sync-emit.test.js`, `tests/sync-stamp.test.js`, `tests/sync-outbox-e2e.test.js`, `tests/auth-network.test.js`.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js servers/shared/sync-stamp.js tests/ramble-sync.test.js -m "feat(ramble): replicate eggs + pet with natural-key apply handlers"
git show --stat HEAD
```

---

## Task 7: Bird on the public wire

**Files:**
- Modify: `bundles/ramble/server/nostr-map.js`, `bundles/ramble/server/marks.js`, `servers/gateway/boot/ramble-transport.js`
- Test: `tests/ramble-nostr-map.test.js`, `tests/ramble-marks.test.js`, `tests/ramble-transport.test.js`

**Interfaces:**
- `markToEvent(row, { precision, crowId, bird = null })`: when `bird` passes `isValidBird`, content gains `bird: { species, seed }` (marks AND caws); otherwise no `bird` key.
- `eventToMark(event)`: if `content.bird` is valid → `bird_species`, `bird_seed`; else both null (never rejects the event for a bad bird).
- `insertRemoteMark(db, row)` stores `bird_species`/`bird_seed`; `createMark(db, { …, bird })` stores the author's active bird on local rows too (so your own pins show your bird).
- `reveal.js` teaser allowlist (`bundles/ramble/server/reveal.js:9`) gains `bird_species`, `bird_seed` (a locked teaser still shows whose bird left it — D5).
- Transport: add `eggs.js` and `feed.js` to the `Promise.all` import list at `servers/gateway/boot/ramble-transport.js:~83-89`; `drainMarks` resolves `activeBird(db)` ONCE per drain and pass it as `bird` to every `markToEvent`. On `onEvent` insert success, additionally `feedAll(db, { type: "meet_crow", persona: event.pubkey }, { emit, onHatch: (egg) => bus.emit("ramble:hatched", { egg_id: egg.egg_id, species: egg.species, seed: egg.seed }) })` (best-effort, try/catch).

- [ ] **Step 1: Add tests**

`tests/ramble-nostr-map.test.js`:
```js
test("bird rides on public content when valid, is dropped when not", () => {
  const row = { mark_id: "m", kind: "mark", visibility: "public", geohash: "9v6m21h", lat: 30.46, lon: -98.08, reveal: "open", content_text: "hi", created_at: 1e12 };
  const ev = markToEvent(row, { bird: { species: "magpie", seed: 12 } });
  assert.deepEqual(JSON.parse(ev.content).bird, { species: "magpie", seed: 12 });
  assert.equal(JSON.parse(markToEvent(row, { bird: { species: "dodo", seed: 12 } }).content).bird, undefined);
  const back = eventToMark({ ...ev, id: "x".repeat(64), pubkey: "a".repeat(64), created_at: 1e9 });
  assert.equal(back.bird_species, "magpie"); assert.equal(back.bird_seed, 12);
  const bad = eventToMark({ ...ev, id: "y".repeat(64), pubkey: "a".repeat(64), created_at: 1e9, content: JSON.stringify({ v: 1, text: "t", bird: { species: "crow", seed: -5 } }) });
  assert.equal(bad.bird_species, null); assert.equal(bad.bird_seed, null);
});
```
`tests/ramble-marks.test.js`: `insertRemoteMark` with `bird_species:"crow", bird_seed: 5` → stored; `createMark(..., { bird: { species:"raven", seed: 9 } })` → stored row has `bird_species === "raven"`.
`tests/ramble-transport.test.js`: seed a hatched active bird (insert into `ramble_eggs` + set `ramble_pet.active_egg_id`), drain, assert the published event's content has `bird`; feed a remote event and assert `ramble_credits` gained one `meet_crow` row keyed `<pubkey>:<isoWeek>`; then feed a **different** event (new `id`, new `d`/mark_id, same `pubkey`, same week) and assert the ledger still has exactly one `meet_crow` row for that pubkey (a byte-identical second event is deduped before `feedAll` and proves nothing). `tests/ramble-reveal.test.js`: a locked teaser keeps `bird_species`/`bird_seed`.

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, expect PASS** (the three files).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/nostr-map.js bundles/ramble/server/marks.js bundles/ramble/server/reveal.js servers/gateway/boot/ramble-transport.js tests/ramble-nostr-map.test.js tests/ramble-marks.test.js tests/ramble-reveal.test.js tests/ramble-transport.test.js -m "feat(ramble): active bird rides on public caws/marks; meet_crow credits on receipt"
git show --stat HEAD
```

---

## Task 8: "Just me" audience (`visibility='private'`)

**Files:**
- Modify: `bundles/ramble/server/marks.js`, `bundles/ramble/server/server.js`, `bundles/ramble/panel/routes.js`
- Test: `tests/ramble-marks.test.js`, `tests/ramble-tools.test.js`, `tests/ramble-panel.test.js`

**Interfaces:**
- `visibility` regexes (server.js `VISIBILITY_RE`, routes.js `VISIBILITY_RE`) accept `private`. `defaultTtlSeconds(kind, "private")` → `null` (persistent); `defaultReveal("private")` → `open`.
- `listMarks(db, { visibility: "private" })` returns only `origin='local'` rows (a remote row can never be private); `listMarks` with no visibility filter (owner's overview) includes private rows only when `origin='local'`.
- The transport drain is untouched (selects `visibility='public'`); `markToEvent` already throws `RambleNotPublic` for it. `shouldSyncRow('ramble_marks')` unchanged (private marks DO replicate to the user's own instances — that's the point).

- [ ] **Step 1: Add tests** — marks: a private mark lists under `visibility:"private"` and never under `"public"`; `insertRemoteMark` with `visibility:"private"` is **rejected** (`{ inserted:false, invalid:true }`) — a remote row can never be private. tools: `ramble_leave_mark` with `visibility:"private"` succeeds and `ramble_query_world` with `visibility:"private"` returns it. panel: `POST /api/ramble/marks {visibility:"private"}` → 201; `GET /api/ramble/marks?visibility=private` lists it.

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, expect PASS** (three files). — [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/marks.js bundles/ramble/server/server.js bundles/ramble/panel/routes.js tests/ramble-marks.test.js tests/ramble-tools.test.js tests/ramble-panel.test.js -m "feat(ramble): 'Just me' private audience"
git show --stat HEAD
```

---

## Task 9: MCP tools for egg, check-in, chores

**Files:**
- Modify: `bundles/ramble/server/server.js`
- Test: `tests/ramble-tools.test.js`

**Interfaces:**
- New tools: `ramble_egg_state` (no args → `eggState`), `ramble_checkin` (no args → `feedAll({type:"checkin"})`), `ramble_chore` (`{ kind: z.enum(["feed","preen","play"]) }` → `doChore`). `ramble_pet_state` returns `petState` + `bird` (`activeBird`) + `egg` percent. `ramble_leave_mark` feeds `{ type: "mark_left" }` after a successful create and passes `bird: await activeBird(db)` into `createMark`. `ramble_unlock` keeps feeding `unlock_mark` (now via `feedAll`). All feeds best-effort (try/catch) with the stdio `emit`.

- [ ] **Step 1: Add tests** — `ramble_egg_state` returns `egg.percent`; `ramble_checkin` twice → second `credited:false`; `ramble_chore {kind:"feed"}` twice → second `done:false`; `ramble_chore {kind:"nap"}` → `isError`; after `ramble_leave_mark` the egg's warmth increased by the `mark_left` weight.

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, expect PASS.** — [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/server.js tests/ramble-tools.test.js -m "feat(ramble): MCP tools for egg state, check-in, chores"
git show --stat HEAD
```

---

## Task 10: Panel routes + hatched stream event

**Files:**
- Modify: `bundles/ramble/panel/routes.js`, `servers/gateway/routes/streams.js`
- Test: `tests/ramble-panel.test.js`, `tests/ramble-stream.test.js`

**Interfaces:**
- Routes (all under the existing `/api/ramble` auth scope): `GET /api/ramble/egg` → `eggState`; `POST /api/ramble/egg/checkin` → `feedAll({type:"checkin"})` → `{ credited, warmth, hatched }`; `POST /api/ramble/pet/chore { kind }` → `doChore` (400 on bad kind); `GET /api/ramble/pet` → `petState` + `bird` + `egg: { percent }`; `GET /api/ramble/bird/:species/:seed.svg` (auth-scoped under `/api/ramble`) → `image/svg+xml` of `<svg viewBox="0 0 200 200">` + `drawBird(rollGenome(seed, species), req.query.mood)` with `Cache-Control: private, max-age=86400` (authed route — never `public`) and 400 for an invalid pair; `GET /ramble/static/bird-svg.js` → serves `BUNDLE_DIR/server/bird-svg.js` — **register this route BEFORE the `/ramble/static/:file` catch-all at `routes.js:~351`** (Express 4 matches in registration order; the catch-all only looks under `panel/static` and would 404), with its own `resolve()` + prefix check against `resolve(join(BUNDLE_DIR, "server"))`, `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: private, max-age=3600`. Load the engine server-side with `createRequire(import.meta.url)(join(BUNDLE_DIR, "server", "bird-svg.js"))` (it is a classic script, not ESM). `ensureLoaded()`'s `Promise.all` (`routes.js:~171-188`) gains `eggs.js` and `feed.js`.
- Existing routes: `POST /api/ramble/marks` passes `bird: activeBird` into `createMark` and feeds `mark_left`; `POST /api/ramble/unlock` switches to `feedAll({type:"unlock_mark"})`; **`POST /api/ramble/area` gains an optional `here: { lat, lon }` (the user's real position from the browser; validated like `lat`/`lon`) and credits `visit_place` ONLY from it, with `cell = encodeGeohash(here.lat, here.lon, 7)` (spec §2.1 geohash-7)** — never from the map centre or the `cells[]` array (panning the map must not farm warmth); with no `here`, no visit credit; **this REPLACES the existing `isNewArea` → `petMod.feed({ type: "visit_place" })` block at `routes.js:~520-523`** (delete it — otherwise panning still farms pet energy and `places_week`); every `feedAll` in routes gets `onHatch: (egg) => bus.emit("ramble:hatched", { egg_id, species, seed })`.
- `streams.js` `ramble-nearby` channel: also `bus.on("ramble:hatched", …)` → frame `event: ramble-hatched` with `data` = `{ egg_id, species, seed }` (whitelisted), same unsubscribe discipline.

- [ ] **Step 1: Add tests** — panel: egg route shape; check-in twice (second `credited:false`); chore twice + bad kind 400; pet route carries `chores`; `bird.svg` 200 `image/svg+xml` containing `<g`, and 400 for `dodo`; `bird-svg.js` served 200 with `text/javascript` and a body containing `RambleBird` (proves the right file, not the catch-all); area with `here` credits `visit_place` once and a second post of the same `here` does not; area with only `cells[]` credits nothing; posting a mark increases warmth (compare `GET /api/ramble/egg` before/after). stream: emitting `ramble:hatched` writes one `event: ramble-hatched` frame with exactly `egg_id, species, seed`; `fireClose()` removes both listeners.

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, expect PASS** + `tests/auth-network.test.js`. — [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel/routes.js servers/gateway/routes/streams.js tests/ramble-panel.test.js tests/ramble-stream.test.js -m "feat(ramble): egg/chore/bird routes + hatched stream event"
git show --stat HEAD
```

**Milestone M2 (wire + doors) complete.**

---

## Task 11: Panel rewrite — world-first home in direction C

**Files:**
- Rewrite: `bundles/ramble/panel/ramble.js` (panel HTML), `bundles/ramble/panel/static/ramble.js` (client)
- Create: `bundles/ramble/panel/static/ramble.css`
- Modify: `bundles/ramble/panel/routes.js` (serve `ramble.css` through the existing static route allowlist)
- Test: `tests/ramble-panel.test.js`

**Interfaces / structure:**
- Panel HTML (`layout({ title: "Ramble", content })`): `<link rel="stylesheet" href="/ramble/static/leaflet/leaflet.css">`, `<link rel="stylesheet" href="/ramble/static/ramble.css">`, Google Fonts link (`Baloo 2` 700/800 + `Nunito` 600–800), then three views toggled by a `data-view` attribute on `#ramble` (`world` default, `egg`, `pet`); `<script src="/ramble/static/leaflet/leaflet.js">`, `<script src="/ramble/static/bird-svg.js">`, `<script src="/ramble/static/ramble.js">`.
  - **world**: `.rb-map` (Leaflet, tiles via the proxy) with `.rb-mapbar` chips (`#rb-chip-around` "Around you", `#rb-chip-visible` "Visible: off|on" → opens `#rb-grid-sheet`), `.rb-perch` bottom-right (`<svg id="rb-perch-bird">` when a bird exists, else `<svg id="rb-perch-egg">` + ring), `#rb-perch-say` context line; `.rb-compose` card (title "Leave something for whoever comes next", explainer line, `<textarea id="rb-text" maxlength="2000">`, `.rb-seg` Who = Everyone/Contacts/Just me (`data-visibility="public|contacts|private"`), `.rb-seg` Reveal = Open/Locked, buttons `#rb-leave` "Leave a mark" and `#rb-caw` "Caw", `#rb-compose-status` line incl. "You're invisible until you flip Visible on"); `#rb-nearby` list (≤ 8 items).
  - **egg**: ring (`#rb-egg-ring` stroke-dashoffset from percent), `#rb-egg-art` (`RambleBird.drawEgg(seed)` from Task 2, seeded from the egg id's first 8 hex chars), percent, checklist (`new places this week n/3`, `first mark`, `check in today`), buttons "Go outside" (→ world) and "Check in" (`POST /api/ramble/egg/checkin`).
  - **pet**: `.rb-stage` with `<svg id="rb-pet-bird">`, name (`SPECIES[species].name`) + trait line (`eye · mark · hat`), energy meter + mood sentence, chores grid (`button.rb-chore[data-kind]`, `.done` from `pet.chores`), this-week counters, back-to-world.
  - **grid sheet** (`#rb-grid-sheet`, hidden by default): the 3×3 checkboxes + master + identity level (same API as today).
  - **hatch moment**: on `ramble-hatched` (SSE) or a `hatched` in a check-in/mark response: switch to the egg view, play `.rb-hatch` (CSS keyframes: wobble ×3, crack, reveal), then draw the bird and show "It's a <name>!", then offer "Meet your bird" (→ pet).
- Client rules: plain script, zero backticks, all dynamic text via `textContent`, `fetch` with JSON (the layout attaches CSRF), `EventSource` with named listeners `ramble-nearby` and `ramble-hatched`, map `touchstart/touchend/touchcancel` → `Crow.setPullToRefresh(false/true)` (already in the client since PR #309 — carry it over verbatim), `moveend` debounced → `POST /api/ramble/area` with the map centre **plus `here` from the last `navigator.geolocation` fix when available** + marks refresh; every action response is followed by `refreshPet()` so a hatch that happened elsewhere is picked up; pins: open marks = `L.marker` with bubble popup; locked = dashed `L.circleMarker` at `approx_*` with "walk N m to read" + Unlock button; caws = bubble + a 40 px bird drawn from `bird_species/bird_seed` via `RambleBird.mountBird`; nearby list mirrors the pins. Perch bird is `mountBird(#rb-perch-bird, rollGenome(seed, species), mood)`. Reduced-motion respected.
- CSS: the direction-C tokens from Global Constraints as CSS variables on `#ramble` (light) and `[data-theme="dark"] #ramble` (dark); components: `.rb-card`, `.rb-btn`, `.rb-chip`, `.rb-seg`, `.rb-map`, `.rb-perch`, `.rb-stage`, `.rb-chore`, `.rb-meter`, `.rb-ring`, `.rb-sheet`; hit targets ≥ 44 px; `.rb-map { touch-action: none; overscroll-behavior: contain; }`.

- [ ] **Step 1: Add/replace panel tests** — the handler renders HTML containing `id="ramble"`, `data-view="world"`, `rb-perch`, `rb-compose`, `rb-grid-sheet`, `/ramble/static/ramble.css`, `/ramble/static/bird-svg.js`, and NOT the old ids `ramble-map`, `ramble-pet`, `ramble-marks` (replace the four legacy assertions at `tests/ramble-panel.test.js:106-111`; the grid checkboxes KEEP their `name="grid-<audience>-<channel>"` attributes, so that assertion stays; the `touch-action:\s*none` assertion at `:118` moves to the `GET /ramble/static/ramble.css` response body, since the declaration now lives in the stylesheet); `GET /ramble/static/ramble.css` → 200 `text/css`; the client source has zero backticks, contains `addEventListener("ramble-nearby"`, `addEventListener("ramble-hatched"`, `Crow.setPullToRefresh(false)`, `data-visibility="private"`.

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement** (write `ramble.css` first, then the HTML, then the client; keep the client under ~450 lines by grouping: `net`, `views`, `map`, `perch`, `compose`, `grid`, `egg`, `pet`, `stream`). — [ ] **Step 4: Run, expect PASS**; `grep -c '\`' bundles/ramble/panel/static/ramble.js` = 0; smoke-boot a scratch-home gateway with the panel copied alone under `$CROW_HOME/panels` + `STRICT_PANEL_MOUNT=1` → `[panel] ramble routes mounted`.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel tests/ramble-panel.test.js -m "feat(ramble): world-first panel in direction C (perch, egg, pet, grid sheet, hatch)"
git show --stat HEAD
```

---

## Task 12: Header crow becomes your bird

**Files:**
- Modify: `servers/gateway/dashboard/shared/notifications.js` (inside `tamagotchiJs(lang)`, ~:951–1120)
- Test: `tests/ramble-header-bird.test.js`

**Interfaces:**
- In `tamagotchiJs` (which returns ONE template literal — no backticks, no `${` in what you add): after the existing boot, `fetch('/api/ramble/pet', { credentials: 'same-origin' })`; any non-200 or error → do nothing (login page, ramble not installed, static route 401 — all silent). If the JSON has `bird: { species, seed }`: inject `<script src="/ramble/static/bird-svg.js">` once (guard on `window.RambleBird`, `onerror` → give up silently); then **keep the SVG's `viewBox="0 0 48 56"`**, hide the original `.crow-body-group` (`style.display='none'`), and insert ONE child `<g id="crow-tama-bird" transform="translate(0 4) scale(0.24)">` whose `innerHTML = RambleBird.drawBird(RambleBird.rollGenome(seed, species), mood)`. `#crow-bubble`, `#crow-exclaim`, the dropdown `onclick`, and `updateCrowBubble` keep working because nothing else in the SVG is touched. Never use `mountBird` here (it replaces the whole SVG's innerHTML).
- **Mood source (ruling):** the bird's mood is the PET's energy — `energy >= 60 → "happy"`, `30–59 → "tired"`, else `"alarmed"` — read from the same `/api/ramble/pet` response and refreshed on the notifications poll cadence (re-fetch `/api/ramble/pet` inside the existing periodic poll; re-render only when species/seed/mood changed). The existing host-health logic in `updateCrowMood(health)` (`worst >= 90/70` from RAM/CPU/disk) keeps driving ONLY `#crow-exclaim` (the "!") and the `crow-*` class on the outer SVG; it no longer decides the drawn bird's face once a bird is mounted.
- CSS: add `#crow-tama-bird` rules mirroring the three mood animations so the bird bounces/droops like the original body group (`.crow-happy #crow-tama-bird { animation: crow-bounce-happy … }` etc.).

- [ ] **Step 1: Write the failing test** — `tests/ramble-header-bird.test.js`: import `tamagotchiJs` from the notifications module, get the script string for `"en"`, `new Function(src)` must NOT throw at parse time (wrap: `assert.doesNotThrow(() => new Function(src))`), and the source contains `/api/ramble/pet`, `/ramble/static/bird-svg.js`, `RambleBird.drawBird`, `crow-tama-bird`, and `display='none'`; the added code region contains no backtick and no `${` (assert on the module source between the `tamagotchiJs` function start and its closing). Also assert the existing `tests/nest-xss.test.js` and any notifications tests still pass (run them).

- [ ] **Step 2: Run, expect FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, expect PASS** + `tests/nest-xss.test.js` + `grep -l "notifications" tests/*.test.js | xargs -n1 node scripts/run-suite.mjs`.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/shared/notifications.js tests/ramble-header-bird.test.js -m "feat(ramble): Nest header crow draws your hatched bird"
git show --stat HEAD
```

---

## Task 13: Docs + integration gate

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`

- [ ] **Step 1:** Add sections (both languages): "Your egg and your bird" (how warmth works with the table of weights, check-in, the hatch, that the look is rolled at hatch and rides on your public caws), "Chores", "Just me marks", the settings keys `warmth.*`, and the `GET /api/ramble/bird/:species/:seed.svg` render route.
- [ ] **Step 2:** `export PATH=…; npm test` → 0 failures; `node scripts/build-registry.mjs --check`; `node scripts/check-port-allocation.js`.
- [ ] **Step 3:** Commit docs: `git commit docs/guide/ramble.md docs/es/guide/ramble.md -m "docs(ramble): eggs, hatch, chores, Just me"`.
- [ ] **Step 4:** PR from the feature branch; check-runs green on the head sha; box schedule + reservation check before merge; merging auto-deploys via the (now on-main) checkouts — restart deliberately.

---

## Self-review notes (coverage against the spec, phase 1 scope)

- §2.1 → Tasks 1, 3, 5 (weights as settings, credits ledger, hatch, next egg, `ramble:hatched`). §2.2 → Task 2 (+ `drawEgg` in Task 11). §2.3 → Task 4. §3 world/egg/pet + grid sheet + hatch moment → Task 11; header crow → Task 12. §4 `bird` on public wire + validation → Task 7. §5 tables/columns/sync → Tasks 1, 6. §7 routes/tools/events → Tasks 9, 10. §8 tokens → Task 11. §10 tests → each task; integration → Task 13. D13 "Just me" → Task 8.
- Deliberately NOT here (later phases): nests/claims/flock screen (§2.4–2.5, phase 2), contacts delivery/gifts/swaps (phase 3), AR (phase 4). `ramble_credits` already carries `meet_crow` keyed by persona so phase 2's "crows met" needs no new ledger.
- Type consistency checked: `emit(table, op, row)` everywhere; `feedAll` return shape used identically by routes and tools; `activeBird` → `{ egg_id, species, seed }`; `isValidBird` is the single validator used by `nostr-map.js` and routes.

## Review

### Round 1 (2026-09-07, adversarial staff-engineer subagent, code-verified) — REVISE → fixed inline
Eleven criticals, all folded in above: **C1** `bird-svg.js` route was unreachable behind the `/ramble/static/:file` catch-all (Task 10 now registers it first with its own guard + body test); **C2** the un-hatch invariant ignored `status` and its test was vacuous (CASE/COALESCE on status/species/seed/hatched_at + status assertion); **C3** `chore` in `feedAll` produced NaN warmth and a circular import (chores go through `pet.feed` directly; `quiet_tick`/`chore` skip the ledger); **C4** header mood mapping applied the pet scale to a host-health object (ruling: header bird shows PET energy; host health keeps the "!" badge); **C5** Task 12 mixed two incompatible render approaches (one approach: child `#crow-tama-bird` at scale .24, viewBox kept, siblings untouched); **C6** `Crow.setPullToRefresh` "did not exist" — stale base; branch rebased onto main ≥ `ee35c08e` where PR #309 added it; **C7** `RAMBLE_MARK_WIRE_COLUMNS` never gained the bird columns (Task 6 + test); **C8** the meet_crow idempotency test was deduped before reaching the ledger (test now uses a different event from the same pubkey); **C9** visit credits had no defined cell and could be farmed by panning (ruling: credit only from the user's real `here`, geohash-7); **C10** `ensureIncubatingEgg` would have created `shelf` eggs (explicit status + partial unique index); **C11** `freshDb` did not exist (helper spelled out).
Suggestions applied: pet emits only from feed/chore/hatch (never the decay-on-read path); teaser keeps the bird; module import lists named for routes and transport; `Cache-Control: private` on authed SVG; not-credited return shape fixed; hatch emits the whole pet row; `FEED_DELTAS` assertion + legacy panel assertions named; stdio-hatch SSE limit documented; zero-backtick rule extended to Task 12; deviations from spec wording recorded.
Rulings (Q1–Q4): header bird mood = pet energy (host alarms stay on the "!"); visit cell = geohash-7 of the browser position, never the map centre; `ramble_pet` replicates with emit only on feed/chore/hatch; `private` marks replicate to own instances (deliberate).

### Round 2 (2026-09-07, scoped re-review of the fixes) — all 11 addressed; 5 new items → fixed inline
**N1 (new, caused by the C10 fix):** the partial unique index made a peer's incubating egg throw in `applyRambleEgg` and be silently dropped → index REMOVED; "one incubating" enforced in code; Task 6 gains a deterministic convergence rule (older `created_at` wins, ties by lower `egg_id`, loser shelved in the same batch) with a two-way test. **N2** pet outbox test now creates the row and asserts `lamport_ts > 0`. **N3** the `touch-action` assertion moves to the CSS route. **N4** the `here`-gated `feedAll` explicitly replaces the map-centre `petMod.feed` block. **N5** UPDATE-before-INSERT in `hatchIfReady` stated. Noted for docs: the header bird's face is pet-driven while its bounce animation stays host-driven (class on the outer SVG); a tall hat may sit under the notification bubble (cosmetic).
