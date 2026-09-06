# Ramble Phase 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Ramble core: a bundle that stores geo-anchored **marks** and self-anchored **caws** in `crow.db`, authors/queries them via MCP tools and a map+compose panel, publishes/receives them over Nostr with a privacy grid, and feeds the existing Tamagotchi crow pet — all with **zero Android work**.

**Architecture:** A hybrid bundle (`bundles/ramble`). A **stdio MCP server** (own process) owns tag CRUD against the shared `crow.db` via the DB-corruption-safe `app-root.js` client. A **gateway-side transport module** (started from `boot/feature-mounts.js`, in the same process as the one `NostrManager`) drains locally-authored marks to Nostr and subscribes to the user's area, so both web and MCP authoring share one publish path. A **panel** renders the map (vendored Leaflet), compose, the privacy grid, and the pet. Writes carry a `publish_state` so the gateway drain is the single Nostr egress.

**Tech Stack:** Node (ESM), `@modelcontextprotocol/sdk`, `zod`, libsql-shaped async DB client (`execute`/`executeMultiple`/`batch`), `nostr-tools` (via the existing `NostrManager`), FTS5, Leaflet 1.9.4 (vendored), SSE/Turbo Streams via the shared `event-bus`.

**Spec:** `docs/superpowers/specs/2026-09-06-ramble-proximity-ar-design.md` (read it alongside this plan).

## Global Constraints

- **DB access:** bundle server code MUST get its client through `server/app-root.js` → `appImport("servers/db.js")` (never load a second SQLite driver into the gateway process — the 2026-08-04 `@libsql` corruption). The client is **async and libsql-shaped**: `await db.execute({ sql, args })`, `await db.executeMultiple(sql)`, `await db.batch([...])`.
- **No `SCHEMA_GENERATION` bump:** all tables are bundle-owned, created with `CREATE TABLE IF NOT EXISTS` in `server/init-tables.js`, idempotent, re-run on every start. Never edit `scripts/init-db.js` or `servers/shared/schema-version.js`.
- **Panel middleware is path-scoped:** `router.use("/api/ramble", dashboardAuth)` — never an unpathed `router.use(mw)` (starves later panels; refused under `STRICT_PANEL_MOUNT=1`).
- **Network-exposure invariant:** ramble routes, panel, MCP, and streams are private. NEVER add any ramble path to `PUBLIC_FUNNEL_PREFIXES`. If any gateway auth/network layer is touched, run `tests/auth-network.test.js`.
- **Nostr transport is gateway-side only:** reuse the singleton `getManagersOrNull()` / `getSharedManagers()` from `servers/sharing/managers.js`. Do NOT construct a second `NostrManager` (duplicate relay connections under one identity). MCP-process code never touches Nostr; it only writes DB rows with `publish_state='pending'`.
- **Sync:** every ramble table write that must replicate to the user's own instances goes through `emitOrQueue(syncManager, db, table, op, row).catch(() => {})`, and the table name is appended to `SYNCED_TABLES` in `servers/sharing/instance-sync.js`. **Appending to `SYNCED_TABLES` is NOT sufficient by itself:** any table whose wire row lacks an `id` needs a natural-key apply handler in the apply dispatch (`instance-sync.js` ~lines 1761–1834), exactly like `_applyDashboardSetting` (keyed on `key`) or `_applyMessage` (keyed on `nostr_event_id`). Without it, updates fail their `WHERE id=?` and deletes no-op. Ramble tables use natural keys (`ramble_marks.mark_id`, `ramble_settings.key`, `ramble_blocks.persona`) and MUST add handlers + a `shouldSyncRow` gate — see Task 8.
- **Every synced ramble table MUST carry `lamport_ts INTEGER DEFAULT 0` (review round 3, C1).** The stdio outbox path (`servers/shared/sync-emit.js` ~:230, the path every MCP-authored write takes) row-stamps via `stampSql`, which for any row carrying `id` runs `UPDATE <table> SET lamport_ts=? WHERE id=?` inside ONE atomic batch. A table without that column throws, the batch is rolled back, `emitOrQueue` returns `null` with a warn, and the write never replicates — silently. The in-gateway `emitChange` path tolerates the missing column (non-fatal stamp), so panel-authored rows would sync while MCP-authored rows would not. Precedent: `glasses_note_sessions` (`scripts/init-db.js:710`). The column is `EXCLUDED_COLUMNS`-stripped on the wire (lamport rides in the envelope) and the apply handlers use the envelope lamport for real last-writer-wins.
- **Replicated rows must not be re-published (review round 3, C2).** `EXCLUDED_COLUMNS` strips `publish_state`/`origin`, so a mark applied on a peer instance would otherwise land with the defaults `pending`/`local` and that peer's drain would publish it to Nostr a second time under the same seed-derived key. `applyRambleMark` MUST write `origin='sync'` and `publish_state='synced'` explicitly; the drain selects only `origin='local'`.
- **Phase-1 wire is PUBLIC-ONLY (review round 3, D1).** Only `visibility='public'` marks/caws leave the instance over Nostr. Contacts/group marks are stored locally, replicate to the user's own instances via the Lamport outbox, and are shown on the map — but they are NOT delivered to contacts or group members in phase 1 (the drain skips them; `markToEvent` refuses non-public rows). Contacts/group Nostr delivery (gift-wrap fan-out per contact, a group-key primitive that is not pairwise NIP-44, the inbound `#p` subscription + decrypt path) is **phase 1b**, its own plan. Never encrypt-and-send half of that path.
- **Nostr wire conventions (review round 3, C3/C4/D2/D3/D4):**
  - **Kinds:** public marks = kind `30397` (addressable; `d` = `mark_id`), caws = kind `20397` (ephemeral). Both chosen as unregistered in the NIP kind registry at the time of writing; `30078` was rejected because it is NIP-78 application data.
  - **Geohash tags at every prefix:** Nostr tag filters are exact-match, so an event carries `["g", geohash.slice(0, n)]` for every `n` from 1 to the full length (NIP-52 convention). The subscriber filters `#g` at the user's configured cell precision.
  - **Expiry:** use the NIP-40 tag `["expiration", String(unixSeconds)]` (relays honor it), not a custom tag. Owner deletes of a still-live public mark publish a NIP-09 kind-5 deletion (Task 10).
  - **Caws are coarse:** a caw event carries ONLY the geohash truncated to the configured precision (`RAMBLE_DEFAULT_GEOHASH_PRECISION`, default 5) — never `lat`/`lon`/`accuracy_m`. Marks (places, not people) carry full coords so the client can range-gate.
  - **Pubkeys are x-only:** `deriveBotIdentity().secp256k1Pubkey` is 66-hex *compressed*; `event.pubkey` is 64-hex *x-only*. `resolvePersona` normalizes `author` to x-only (strip the 2-char prefix; `NostrManager` does the same at `nostr.js:503`). `ramble_marks.author`, `ramble_blocks.persona`, and the own-echo comparison all use the x-only form. Under `level:"real"` the event additionally carries `["crow", crowId]`.
- **Locked-reveal is NOT cryptographic against a relay scraper in phase 1 (design fact, see Task 4):** confidentiality against relays comes only from the audience layer — public marks travel in the clear in the relay event, contacts/group marks are encrypted to recipients. `reveal:"locked"` is an in-range **teaser gate** enforced by our client/gateway (list/query withhold content until an in-range unlock). Real cryptographic public-geo locking needs the world server and is deferred to a later phase. Do not claim a public locked mark resists a scraper.
- **zod strings:** every `z.string()` in a tool schema carries a `.max(...)` bound.
- **Tests:** run a single file with `node scripts/run-suite.mjs tests/<file>.test.js` (bare `node --test` can write the live crow.db). Bundle table/unit tests open their **own** in-memory client: `createClient({ url: "file::memory:" })` from `@libsql/client`. Node 22 rail on PATH: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before running.
- **Commits:** subject-only messages, positional path args (`git commit <path> -m ...`), verify with `git show --stat HEAD`. **No AI attribution trailers** (operator rule). `main` is branch-protected; land via PR with green CI (`suite`/`static-checks`/`audit` on the head sha).
- **Registry is generated:** after manifest changes run `npm run build-registry` (CI drift-checks it).

---

## File structure

```
bundles/ramble/
  manifest.json                 # bundle manifest (server + panel + panelRoutes + requires + env_vars)
  server/
    app-root.js                 # copied verbatim from bundles/reader/server/app-root.js
    db.js                       # copied from bundles/reader/server/db.js (core client + cross-proc fallback)
    init-tables.js              # ramble_marks/_pet/_settings/_groups/_blocks + FTS
    anchors.js                  # geohash encode/decode, haversine, within-range, salted lan id
    reveal.js                   # audience content protection + reveal (teaser) semantics
    persona.js                  # rotating/pseudonym/real persona keypair resolution
    marks.js                    # tag store CRUD (create/list/get/expire/unlock) + sync emit
    pet.js                      # pet state feed(event) → mood/energy
    nostr-map.js                # mark <-> Nostr event mapping (kinds + geohash "g" tag)
    grid.js                     # privacy-grid + master-switch + identity-level settings helpers
    server.js                   # MCP factory: ramble_* tools
    index.js                    # stdio entrypoint
  panel/
    ramble.js                   # dashboard panel handler (map + compose + settings + pet shell)
    routes.js                   # Express router: /api/ramble (path-scoped), in-process authoring
    static/leaflet/             # vendored Leaflet 1.9.4 (js+css+images)
    static/ramble.js            # panel client JS (map, compose, grid, pet)
  skills/ramble.md              # optional user skill doc

servers/gateway/boot/ramble-transport.js   # gateway-side publisher drain + subscriber (NEW)
servers/gateway/boot/feature-mounts.js     # MODIFY: start ramble-transport if installed
servers/gateway/routes/streams.js          # MODIFY: add /dashboard/streams/ramble-nearby
servers/sharing/instance-sync.js           # MODIFY: append ramble tables to SYNCED_TABLES

tests/
  ramble-tables.test.js
  ramble-anchors.test.js
  ramble-reveal.test.js
  ramble-persona.test.js
  ramble-marks.test.js
  ramble-tools.test.js
  ramble-sync.test.js
  ramble-nostr-map.test.js
  ramble-grid.test.js
  ramble-pet.test.js
```

**Milestones:** M1 = local core (Tasks 1–7: scaffold, tables, anchors, reveal, persona, marks, MCP tools) — working, testable, no network/UI. M2 = replication + social + visual (Tasks 8–14: same-user sync, Nostr mapping, gateway transport, grid, panel, stream, pet).

---

## Task 1: Bundle scaffold + DB client

**Files:**
- Create: `bundles/ramble/manifest.json`, `bundles/ramble/server/app-root.js`, `bundles/ramble/server/db.js`, `bundles/ramble/server/index.js`
- Test: `tests/ramble-tables.test.js` (asserted fully in Task 2; here only the manifest check)

**Interfaces:**
- Produces: `manifest.json` with `id:"ramble"`; `app-root.js` exports `APP_ROOT`, `appImport(rel)`; `db.js` exports `createDbClient(dbPath?)` returning the async libsql-shaped client.

- [ ] **Step 1: Copy the DB-safe helpers verbatim**

```bash
mkdir -p bundles/ramble/server bundles/ramble/panel/static
cp bundles/reader/server/app-root.js bundles/ramble/server/app-root.js
cp bundles/reader/server/db.js bundles/ramble/server/db.js
```

- [ ] **Step 2: Write the manifest**

`bundles/ramble/manifest.json` (mirror reader's shape — `type:"mcp-server"`, `server.envKeys`, `panel`, `panelRoutes`, `requires`, `env_vars`):

```json
{
  "id": "ramble",
  "name": "Ramble",
  "version": "0.1.0",
  "type": "mcp-server",
  "author": "Crow",
  "category": "social",
  "tags": ["proximity", "map", "ar", "social", "geo"],
  "icon": "🐦",
  "description": "Proximity broadcasts (caws) + a shared/private map of discoverable marks, with a crow pet. Phase 1: geo channel, map, Nostr, pet.",
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["CROW_APP_ROOT", "CROW_DATA_DIR", "CROW_HOME"] },
  "panel": "panel/ramble.js",
  "panelRoutes": "panel/routes.js",
  "requires": { "min_ram_mb": 128, "min_disk_mb": 100 },
  "env_vars": [
    { "name": "RAMBLE_DEFAULT_GEOHASH_PRECISION", "description": "Geohash precision for public marks (5 ≈ 4.9km cell)", "required": false }
  ]
}
```

- [ ] **Step 3: Write a minimal stdio entrypoint** (expanded in Task 7)

`bundles/ramble/server/index.js`:

```js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRambleServer } from "./server.js";
import { initRambleTables } from "./init-tables.js";
import { createDbClient } from "./db.js";

const db = createDbClient();
await initRambleTables(db);
const server = createRambleServer(db, { instructions: "Ramble: proximity marks + caws." });
await server.connect(new StdioServerTransport());
```

- [ ] **Step 4: Rebuild + verify the registry accepts the manifest**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm run build-registry
node -e "const r=require('./registry/add-ons.json'); if(!r.find?.(x=>x.id==='ramble') && !JSON.stringify(r).includes('\"ramble\"')) throw new Error('ramble missing from registry'); console.log('ramble in registry OK')"
```
Expected: build succeeds, ramble present. (`server.js`/`init-tables.js` do not exist yet — the registry build reads the manifest only, not the server code.) The build runs `validateManifest` (`scripts/lib/bundle-contract.mjs`): the five universal-required fields are `id`, `name`, `description`, `type`, `category` — `description` (not `notes`) is mandatory (review round 3, C5). `server.args[0]` must exist on disk, which is why the minimal `server/index.js` lands in this task.

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/manifest.json bundles/ramble/server/app-root.js bundles/ramble/server/db.js bundles/ramble/server/index.js registry/add-ons.json
git commit bundles/ramble/manifest.json bundles/ramble/server/app-root.js bundles/ramble/server/db.js bundles/ramble/server/index.js registry/add-ons.json -m "feat(ramble): bundle scaffold + DB-safe client"
git show --stat HEAD
```

---

## Task 2: Tables + FTS

**Files:**
- Create: `bundles/ramble/server/init-tables.js`
- Test: `tests/ramble-tables.test.js`

**Interfaces:**
- Produces: `export async function initRambleTables(db)`. Tables: `ramble_marks`, `ramble_pet`, `ramble_settings`, `ramble_groups`, `ramble_blocks`, FTS `ramble_marks_fts`.
- `ramble_marks` columns (the wire/store shape every later task uses): `id INTEGER PK AUTOINCREMENT`, `mark_id TEXT UNIQUE` (uuid), `author TEXT` (persona pubkey hex), `author_level TEXT` (`rotating|pseudonym|real`), `kind TEXT` (`caw|mark`), `anchor_kind TEXT` (`geo|lan|beacon|fingerprint|visual`), `geohash TEXT`, `lat REAL`, `lon REAL`, `accuracy_m REAL`, `anchor_ref TEXT` (salted lan id / beacon id / fingerprint hash / opaque visual), `visibility TEXT` (`public|contacts|group:<id>`), `reveal TEXT` (`open|locked`), `content_text TEXT`, `content_kind TEXT` (`none|photo|sticker|link`), `content_ref TEXT`, `thumb_enc TEXT`, `locked_blob TEXT` (reserved for a future crypto phase — unused in phase 1; see Task 4), `created_at INTEGER`, `expires_at INTEGER` NULL, `nostr_event_id TEXT UNIQUE` NULL, `publish_state TEXT DEFAULT 'pending'` (`pending|published|remote|synced`), `origin TEXT` (`local|remote|sync`), `lamport_ts INTEGER DEFAULT 0` (sync stamp — REQUIRED, Global Constraints C1).
- `ramble_settings`, `ramble_blocks` also carry `lamport_ts INTEGER DEFAULT 0` (they replicate). `ramble_groups` is created (schema reserved for phase 1b) but has no phase-1 writer and is not synced. `ramble_pet` is per-instance, not synced.

- [ ] **Step 1: Write the failing test**

`tests/ramble-tables.test.js`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await initRambleTables(db); // idempotent
});

test("all ramble tables + fts exist", async () => {
  const { rows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
  );
  const names = rows.map((r) => r.name);
  for (const t of ["ramble_marks", "ramble_pet", "ramble_settings", "ramble_groups", "ramble_blocks", "ramble_marks_fts"]) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
});

test("synced tables carry lamport_ts (outbox stamp requirement)", async () => {
  for (const t of ["ramble_marks", "ramble_settings", "ramble_blocks"]) {
    const { rows } = await db.execute(`PRAGMA table_info(${t})`);
    assert.ok(rows.some((r) => r.name === "lamport_ts"), `${t} missing lamport_ts`);
  }
});

test("fts indexes mark text on insert", async () => {
  await db.execute({
    sql: "INSERT INTO ramble_marks (mark_id, author, kind, anchor_kind, geohash, visibility, reveal, content_text, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    args: ["m1", "abc", "mark", "geo", "9v6", "public", "open", "coffee here", 1000],
  });
  const { rows } = await db.execute({ sql: "SELECT mark_id FROM ramble_marks_fts WHERE ramble_marks_fts MATCH ?", args: ["coffee"] });
  assert.equal(rows.length, 1);
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs tests/ramble-tables.test.js
```
Expected: FAIL (cannot import `initRambleTables`).

- [ ] **Step 3: Implement `init-tables.js`** (reader idiom)

```js
async function initTable(db, label, sql) {
  try { await db.executeMultiple(sql); }
  catch (err) { console.error(`[ramble init] ${label}:`, err.message); throw err; }
}

export async function initRambleTables(db) {
  await initTable(db, "ramble_marks", `
    CREATE TABLE IF NOT EXISTS ramble_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mark_id TEXT UNIQUE NOT NULL,
      author TEXT NOT NULL,
      author_level TEXT,
      kind TEXT NOT NULL,
      anchor_kind TEXT NOT NULL,
      geohash TEXT, lat REAL, lon REAL, accuracy_m REAL, anchor_ref TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      reveal TEXT NOT NULL DEFAULT 'open',
      content_text TEXT, content_kind TEXT DEFAULT 'none', content_ref TEXT,
      thumb_enc TEXT, locked_blob TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      nostr_event_id TEXT UNIQUE,
      publish_state TEXT NOT NULL DEFAULT 'pending',
      origin TEXT NOT NULL DEFAULT 'local',
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_marks_geohash ON ramble_marks(geohash);
    CREATE INDEX IF NOT EXISTS ramble_marks_pubstate ON ramble_marks(publish_state);`);

  await initTable(db, "ramble_marks_fts", `
    CREATE VIRTUAL TABLE IF NOT EXISTS ramble_marks_fts USING fts5(
      content_text, mark_id UNINDEXED, content=ramble_marks, content_rowid=id
    );
    CREATE TRIGGER IF NOT EXISTS ramble_marks_ai AFTER INSERT ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(rowid, content_text, mark_id) VALUES (new.id, new.content_text, new.mark_id);
    END;
    CREATE TRIGGER IF NOT EXISTS ramble_marks_ad AFTER DELETE ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(ramble_marks_fts, rowid, content_text, mark_id) VALUES ('delete', old.id, old.content_text, old.mark_id);
    END;
    CREATE TRIGGER IF NOT EXISTS ramble_marks_au AFTER UPDATE ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(ramble_marks_fts, rowid, content_text, mark_id) VALUES ('delete', old.id, old.content_text, old.mark_id);
      INSERT INTO ramble_marks_fts(rowid, content_text, mark_id) VALUES (new.id, new.content_text, new.mark_id);
    END;`);

  await initTable(db, "ramble_pet", `
    CREATE TABLE IF NOT EXISTS ramble_pet (
      owner TEXT PRIMARY KEY DEFAULT 'self',
      mood TEXT NOT NULL DEFAULT 'happy',
      energy INTEGER NOT NULL DEFAULT 60,
      last_fed_at INTEGER,
      places_week INTEGER NOT NULL DEFAULT 0,
      unlocks_week INTEGER NOT NULL DEFAULT 0,
      crows_week INTEGER NOT NULL DEFAULT 0
    );`);

  await initTable(db, "ramble_settings", `
    CREATE TABLE IF NOT EXISTS ramble_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      lamport_ts INTEGER DEFAULT 0
    );`);

  await initTable(db, "ramble_groups", `
    CREATE TABLE IF NOT EXISTS ramble_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT,
      shared_key TEXT NOT NULL,
      members TEXT,
      created_at INTEGER NOT NULL
    );`);

  await initTable(db, "ramble_blocks", `
    CREATE TABLE IF NOT EXISTS ramble_blocks (
      persona TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );`);
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
node scripts/run-suite.mjs tests/ramble-tables.test.js
```

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/init-tables.js tests/ramble-tables.test.js
git commit bundles/ramble/server/init-tables.js tests/ramble-tables.test.js -m "feat(ramble): bundle tables + marks FTS"
git show --stat HEAD
```

---

## Task 3: Anchor + geohash utilities

**Files:**
- Create: `bundles/ramble/server/anchors.js`
- Test: `tests/ramble-anchors.test.js`

**Interfaces:**
- Produces: `encodeGeohash(lat, lon, precision=7) -> string`; `geohashNeighborsPrefix(geohash, precision) -> string[]` (self + 8 neighbors at the given prefix length, for area queries); `haversineMeters(a, b) -> number` where `a/b = {lat, lon}`; `withinRange(anchor, here) -> boolean` (geo: distance ≤ `anchor.accuracy_m || 75`; lan/beacon/fingerprint: exact `anchor_ref` match on `here.ref`); `saltedLanId(bssid, salt) -> string` (`sha256(bssid+salt)` hex, so a raw BSSID never persists).

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGeohash, haversineMeters, withinRange, saltedLanId } from "../bundles/ramble/server/anchors.js";

test("geohash is stable + prefix-consistent", () => {
  const g = encodeGeohash(30.2672, -97.7431, 7); // Austin
  assert.equal(typeof g, "string");
  assert.equal(g.length, 7);
  assert.equal(encodeGeohash(30.2672, -97.7431, 5), g.slice(0, 5));
});

test("haversine ~ known distance", () => {
  const d = haversineMeters({ lat: 30.2672, lon: -97.7431 }, { lat: 30.2700, lon: -97.7431 });
  assert.ok(d > 280 && d < 340, `got ${d}`); // ~311 m
});

test("withinRange respects accuracy for geo, exact for lan", () => {
  const anchor = { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 };
  assert.equal(withinRange(anchor, { lat: 30.2673, lon: -97.7431 }), true);
  assert.equal(withinRange(anchor, { lat: 30.2700, lon: -97.7431 }), false);
  const lan = { anchor_kind: "lan", anchor_ref: "abc" };
  assert.equal(withinRange(lan, { ref: "abc" }), true);
  assert.equal(withinRange(lan, { ref: "xyz" }), false);
});

test("saltedLanId is deterministic and hides the bssid", () => {
  const id = saltedLanId("aa:bb:cc:dd:ee:ff", "s1");
  assert.equal(id, saltedLanId("aa:bb:cc:dd:ee:ff", "s1"));
  assert.notEqual(id, "aa:bb:cc:dd:ee:ff");
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-anchors.test.js`

- [ ] **Step 3: Implement `anchors.js`**

```js
import { createHash } from "node:crypto";
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(lat, lon, precision = 7) {
  let idx = 0, bit = 0, evenBit = true, geohash = "";
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = (idx << 1) + 1; lonMin = mid; } else { idx = idx << 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = (idx << 1) + 1; latMin = mid; } else { idx = idx << 1; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { geohash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return geohash;
}

export function haversineMeters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function withinRange(anchor, here) {
  if (anchor.anchor_kind === "geo") {
    if (here == null || here.lat == null) return false;
    return haversineMeters({ lat: anchor.lat, lon: anchor.lon }, here) <= (anchor.accuracy_m || 75);
  }
  return !!here && here.ref === anchor.anchor_ref;
}

export function geohashNeighborsPrefix(geohash, precision) {
  // Phase 1: query the mark's own prefix cell. Neighbor expansion is added in phase 2.
  return [geohash.slice(0, precision)];
}

export function saltedLanId(bssid, salt) {
  return createHash("sha256").update(`${bssid}::${salt}`).digest("hex").slice(0, 32);
}
```

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-anchors.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/anchors.js tests/ramble-anchors.test.js
git commit bundles/ramble/server/anchors.js tests/ramble-anchors.test.js -m "feat(ramble): geohash + range anchor utilities"
git show --stat HEAD
```

---

## Task 4: Reveal semantics + audience content protection

> **Design correction (plan review 2026-09-06, critical #2).** The earlier "anchor-derived content lock" is REMOVED: it published a per-tag `secret` in the event while the geohash (the KDF's other input) is the discovery tag, so a relay scraper held both inputs and could decrypt. Cryptographic scraper-resistance for *public geo* marks is impossible in a pure-relay model (the cell must be coarse enough for a legit nearby user to match, which is coarse enough to brute-force). Phase 1 is honest about this: **`reveal:"locked"` is an in-range teaser gate enforced by our client/gateway, not crypto.** Confidentiality against relays is provided ONLY by the **audience** layer (public = clear; contacts/group = encrypted to recipients, Task 9).

**Files:**
- Create: `bundles/ramble/server/reveal.js`
- Test: `tests/ramble-reveal.test.js`

**Interfaces:**
- Produces:
  - `teaser(row) -> row` — returns a copy safe to hand a not-yet-in-range viewer: for `reveal==='locked'` it strips `content_text`/`content_ref`/`thumb_enc` (keeps `author`, `anchor_kind`, coarse `geohash`, `kind`, `created_at`, `expires_at`); for `reveal==='open'` returns content intact.
  - `revealContent(row, here) -> { unlocked: boolean, content: {content_text, content_kind, content_ref} | null }` — for `open` always `{unlocked:true, content:{...}}`; for `locked` returns content only when `withinRange(anchorOf(row), here)` (import `withinRange` from `anchors.js`), else `{unlocked:false, content:null}`.
  - `anchorOf(row) -> anchor` — builds the anchor object `{ anchor_kind, lat, lon, accuracy_m, anchor_ref, geohash }` from a stored row (shared helper used by marks.js/tests).
- No cryptography here. There is no `locked_blob`/`secret`; drop those columns' use in Task 6 (the columns may remain nullable for a future crypto phase but are unused).

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { teaser, revealContent } from "../bundles/ramble/server/reveal.js";

const locked = { mark_id: "m1", reveal: "locked", anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75, geohash: "9v6m2a", content_text: "secret spot", content_kind: "none" };
const open   = { ...locked, mark_id: "m2", reveal: "open" };

test("teaser strips content for locked, keeps it for open", () => {
  assert.equal(teaser(locked).content_text, undefined);
  assert.equal(teaser(locked).geohash, "9v6m2a"); // existence + coarse location survive
  assert.equal(teaser(open).content_text, "secret spot");
});

test("revealContent gates locked content on range, open is always revealed", () => {
  assert.equal(revealContent(locked, { lat: 30.30, lon: -97.74 }).unlocked, false);
  assert.equal(revealContent(locked, { lat: 30.2673, lon: -97.7431 }).content.content_text, "secret spot");
  assert.equal(revealContent(open, null).unlocked, true);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-reveal.test.js`

- [ ] **Step 3: Implement `reveal.js`**

```js
import { withinRange } from "./anchors.js";

export function anchorOf(row) {
  return { anchor_kind: row.anchor_kind, lat: row.lat, lon: row.lon, accuracy_m: row.accuracy_m, anchor_ref: row.anchor_ref, geohash: row.geohash };
}
export function teaser(row) {
  if (row.reveal !== "locked") return { ...row };
  const { content_text, content_ref, thumb_enc, locked_blob, ...safe } = row;
  return safe;
}
export function revealContent(row, here) {
  const content = { content_text: row.content_text, content_kind: row.content_kind, content_ref: row.content_ref };
  if (row.reveal !== "locked") return { unlocked: true, content };
  if (withinRange(anchorOf(row), here)) return { unlocked: true, content };
  return { unlocked: false, content: null };
}
```

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-reveal.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/reveal.js tests/ramble-reveal.test.js
git commit bundles/ramble/server/reveal.js tests/ramble-reveal.test.js -m "feat(ramble): reveal teaser gate (in-range, client-enforced)"
git show --stat HEAD
```

---

## Task 5: Persona resolution

**Files:**
- Create: `bundles/ramble/server/persona.js`
- Test: `tests/ramble-persona.test.js`

**Interfaces:**
- Consumes: `deriveBotIdentity(seed, botId)` and `loadInstanceSeed(dataDir)`/`loadOrCreateIdentity()` + `computeCrowId` from `servers/sharing/identity.js` (via `appImport`).
- Produces: `resolvePersona(identity, seed, { level, kind, sessionId, _derive }) -> { author, author_level, crowId, secp256k1Priv }`. **Split by `kind` under rotating (plan review critical #3, spec §2):** placed marks must be attributable so reports/blocks survive a session, only presence rotates.
  - `level:"real"` → the instance identity's signing key for any kind; `crowId` is populated (the wire adds a `["crow", crowId]` tag, Task 9).
  - `level:"pseudonym"` → `deriveBotIdentity(seed, "ramble-world")` (stable, non-crow_id) for any kind; `crowId` null.
  - `level:"rotating"` → `kind:"mark"` uses the stable `deriveBotIdentity(seed, "ramble-world")` pseudonym (so `ramble_blocks` keyed on `persona` works next session); `kind:"caw"` uses `deriveBotIdentity(seed, "ramble-session:" + sessionId)` (fresh per session, presence only); `crowId` null.
  - **`author` is ALWAYS the x-only 64-hex Nostr pubkey** of whichever key signs (review round 3, C4): `secp256k1Pubkey` from `identity.js` is 66-hex compressed, so strip the leading 2 chars (exactly what `NostrManager` does at `nostr.js:503`). This is the value `event.pubkey` will carry, so own-echo skips and `ramble_blocks.persona` compare equal. `author_level` records the level (`rotating`/`pseudonym`/`real`).

- [ ] **Step 1: Write the failing test** (pure-function slice; inject a fake identity/seed so no gateway state is needed)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePersona } from "../bundles/ramble/server/persona.js";

import { createHash } from "node:crypto";

// Inject a deterministic deriver so the test needs no real identity. Keys are
// shaped like identity.js output: 66-hex COMPRESSED secp256k1 pubkeys.
const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
const realId = { crowId: "crow_ABC", secp256k1Pubkey: compressed("real"), secp256k1Priv: Buffer.from("real") };

test("rotating caw rotates per session; rotating mark is the stable pseudonym; real carries crowId", () => {
  const cawA = resolvePersona(realId, "seed", { level: "rotating", kind: "caw", sessionId: "s1", _derive: fakeDerive });
  const cawB = resolvePersona(realId, "seed", { level: "rotating", kind: "caw", sessionId: "s2", _derive: fakeDerive });
  assert.notEqual(cawA.author, cawB.author); // presence rotates
  const markA = resolvePersona(realId, "seed", { level: "rotating", kind: "mark", sessionId: "s1", _derive: fakeDerive });
  const markB = resolvePersona(realId, "seed", { level: "rotating", kind: "mark", sessionId: "s2", _derive: fakeDerive });
  assert.equal(markA.author, markB.author); // placed marks stay attributable across sessions
  assert.equal(markA.author, compressed("seed" + "ramble-world").slice(2));
  assert.equal(markA.crowId, null);
  const p1 = resolvePersona(realId, "seed", { level: "pseudonym", kind: "caw", _derive: fakeDerive });
  const p2 = resolvePersona(realId, "seed", { level: "pseudonym", kind: "mark", _derive: fakeDerive });
  assert.equal(p1.author, p2.author);
  const r = resolvePersona(realId, "seed", { level: "real", kind: "mark", _derive: fakeDerive });
  assert.equal(r.author, compressed("real").slice(2)); // x-only, NOT the crow_id
  assert.equal(r.crowId, "crow_ABC");
  assert.equal(r.author_level, "real");
});

test("author is always x-only 64-hex (matches event.pubkey)", () => {
  for (const level of ["rotating", "pseudonym", "real"]) {
    const p = resolvePersona(realId, "seed", { level, kind: "mark", sessionId: "s", _derive: fakeDerive });
    assert.match(p.author, /^[0-9a-f]{64}$/, level);
  }
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-persona.test.js`

- [ ] **Step 3: Implement `persona.js`** (the `_derive` seam lets tests inject; production passes the real `deriveBotIdentity`)

```js
/** 66-hex compressed secp256k1 pubkey -> 64-hex x-only (what Nostr `event.pubkey` carries). */
export function xOnly(pubkeyHex) {
  return pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
}

export function resolvePersona(identity, seed, { level = "rotating", kind = "mark", sessionId = "0", _derive } = {}) {
  const derive = _derive; // production callers pass deriveBotIdentity from identity.js
  if (level === "real") {
    return { author: xOnly(identity.secp256k1Pubkey), author_level: "real", crowId: identity.crowId, secp256k1Priv: identity.secp256k1Priv };
  }
  // pseudonym: always the stable world pseudonym. rotating: marks use the stable pseudonym (attributable),
  // only caws (presence) use a fresh per-session key.
  const rotatesThisKind = level === "rotating" && kind === "caw";
  const botId = rotatesThisKind ? "ramble-session:" + sessionId : "ramble-world";
  const k = derive(seed, botId);
  return { author: xOnly(k.secp256k1Pubkey), author_level: level, crowId: null, secp256k1Priv: k.secp256k1Priv };
}
```

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-persona.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/persona.js tests/ramble-persona.test.js
git commit bundles/ramble/server/persona.js tests/ramble-persona.test.js -m "feat(ramble): persona resolution (rotating/pseudonym/real)"
git show --stat HEAD
```

---

## Task 6: Mark store CRUD + sync emit

**Files:**
- Create: `bundles/ramble/server/marks.js`
- Test: `tests/ramble-marks.test.js`

**Interfaces:**
- Consumes: `encodeGeohash` (anchors.js); `teaser`, `revealContent` (reveal.js); the async db client.
- Produces (all async, take `db` first):
  - `createMark(db, { author, author_level, kind, anchor, visibility, reveal, content, ttlSeconds }, { emit } = {}) -> row` — generates `mark_id` (`randomUUID()`), computes `geohash`/`lat`/`lon`/`anchor_ref` from `anchor` (geohash via `encodeGeohash` for geo), sets `expires_at` (caws default 3600s; public marks default 86400s; contacts/group marks persistent = `null`), stores `content` **in the clear locally** (no seal — confidentiality against relays is the audience layer, Task 9), inserts with `publish_state='pending'`, `origin='local'`, calls optional `emit(row)` (used by Task 8/10). Returns the stored row.
  - `listMarks(db, { visibility, geohashPrefix, includeExpired=false, limit=200 }) -> rows` — returns `teaser(row)` for each (locked marks come back content-stripped; open marks intact).
  - `getMark(db, mark_id) -> row|null` (full row, for internal/owner use).
  - `unlockMark(db, mark_id, here) -> { unlocked:boolean, content }` — loads the mark and returns `revealContent(row, here)` (in-range gate; no crypto/secret).
  - `expireMarks(db, now=Date.now()) -> count` — deletes rows with `expires_at IS NOT NULL AND expires_at <= now`. **Emits a delete through `emit` for each swept LOCAL row** (so expiry propagates via Task 8).
  - `insertRemoteMark(db, row) -> {inserted:boolean, blocked?:true}` — idempotent by `nostr_event_id` OR `mark_id` (dedup both, per plan review), sets `origin='remote'`, `publish_state='remote'`. **Drops the row without inserting when `row.author` is in `ramble_blocks`** (review round 3, D5). **Relative-TTL on receipt (plan review):** if the incoming `expires_at` is present, store `expires_at = Date.now() + max(0, author_expires_at - author_created_at)` to tolerate cross-instance clock skew.
  - **Blocks (review round 3, D5 — spec §4 lists report/hide as a v1 action):** `blockPersona(db, persona, reason, { emit } = {}) -> row` (upsert into `ramble_blocks`, emits `insert` for sync), `unblockPersona(db, persona, { emit } = {})` (emits `delete`), `isBlocked(db, persona) -> boolean`. `listMarks` excludes rows whose `author` is blocked (`author NOT IN (SELECT persona FROM ramble_blocks)`). Blocking also deletes already-stored remote marks by that persona.

- [ ] **Step 1: Write the failing test**

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, listMarks, unlockMark, expireMarks } from "../bundles/ramble/server/marks.js";

let db;
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

test("open geo mark is listable and returns its text", async () => {
  await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "open coffee", content_kind: "none" },
  });
  const rows = await listMarks(db, { visibility: "public" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_text, "open coffee");
});

test("locked mark hides text in list, unlocks only in range", async () => {
  const m = await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "locked",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "secret spot", content_kind: "none" },
  });
  const listed = await listMarks(db, { visibility: "public" });
  assert.ok(!listed.find((r) => r.content_text === "secret spot")); // teaser strips content
  const far = await unlockMark(db, m.mark_id, { lat: 30.30, lon: -97.74 });
  assert.equal(far.unlocked, false);
  const near = await unlockMark(db, m.mark_id, { lat: 30.2673, lon: -97.7431 });
  assert.equal(near.unlocked, true);
  assert.equal(near.content.content_text, "secret spot");
});

test("expired marks are swept", async () => {
  await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "caw", visibility: "public", reveal: "open", ttlSeconds: -1,
    anchor: { anchor_kind: "geo", lat: 1, lon: 1 }, content: { content_text: "old" },
  });
  const swept = await expireMarks(db, Date.now());
  assert.ok(swept >= 1);
});

test("blocked personas are dropped on receipt and hidden in lists", async () => {
  const remote = { mark_id: "r1", author: "badpk", kind: "mark", anchor_kind: "geo", geohash: "9v6m2a", lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "open", content_text: "spam", created_at: Date.now(), nostr_event_id: "ev1" };
  assert.equal((await insertRemoteMark(db, remote)).inserted, true);
  await blockPersona(db, "badpk", "spam");
  assert.ok(!(await listMarks(db, { visibility: "public" })).some((r) => r.author === "badpk")); // existing rows purged/hidden
  const again = await insertRemoteMark(db, { ...remote, mark_id: "r2", nostr_event_id: "ev2" });
  assert.equal(again.inserted, false);
  assert.equal(again.blocked, true);
});
```
(add `insertRemoteMark`, `blockPersona` to the import line.)

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-marks.test.js`

- [ ] **Step 3: Implement `marks.js`** using `anchors.js` (`encodeGeohash` for geo rows) and `reveal.js` (`teaser` in `listMarks`, `revealContent` in `unlockMark`), `randomUUID()` for `mark_id`, parameterized `await db.execute({ sql, args })`. Derive columns from `anchor`, default TTLs by kind/visibility, `INSERT` with `publish_state='pending'`; `listMarks` selects the full row (minus blocked authors) then maps through `teaser`; `expireMarks` selects the local rows it will delete, deletes them, and calls `emit(row, "delete")` for each so Task 8 replicates the deletion. `insertRemoteMark` checks `isBlocked` first. Blocks helpers live in this module (small; no separate file). No `locked_blob`/`secret` handling (removed in Task 4). The `emit(row, op)` hook signature is `emit(row, op = "insert")`; the row passed to `emit` is the stored row (it includes `id` and `lamport_ts` — both fine: the stamp path needs `id`, and `EXCLUDED_COLUMNS` strips both on the wire).

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-marks.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/marks.js tests/ramble-marks.test.js
git commit bundles/ramble/server/marks.js tests/ramble-marks.test.js -m "feat(ramble): mark store CRUD + in-range reveal + expiry"
git show --stat HEAD
```

---

## Task 7: MCP tools

**Files:**
- Modify: `bundles/ramble/server/index.js` (already calls `createRambleServer`)
- Create: `bundles/ramble/server/server.js`
- Test: `tests/ramble-tools.test.js`

**Interfaces:**
- Consumes: `marks.js` functions; `createDbClient` (db.js).
- Produces: `export function createRambleServer(db, options = {})` registering tools: `ramble_leave_mark`, `ramble_caw`, `ramble_query_world`, `ramble_unlock`, `ramble_pet_state`, `ramble_block` (`{ persona, reason? }` → `blockPersona`), `ramble_unblock`. Each `z.string()` has `.max()`. Handlers return `text(JSON.stringify(...))`. Author/persona is resolved server-side from settings (default `rotating`); tools do NOT accept raw keys.
- **Groups are NOT in phase 1** (review round 3, D8): `ramble_group_create`/`ramble_group_join` had no key-generation or invite specification and, with the phase-1 wire being public-only, a local-only group has no purpose. They move to phase 1b with the contacts/group delivery path. The `ramble_groups` table stays (schema reserved).
- **Identity seam (review round 3, D8):** `options.identity`, `options.seed`, `options._derive` are injectable; when absent the server resolves them once at startup from `appImport("servers/sharing/identity.js")` → `loadOrCreateIdentity()` + `loadInstanceSeed(dataDir)` + `deriveBotIdentity`. The test injects all three so no identity files are generated. `sessionId` for rotating caws = a `randomUUID()` minted once per server process.
- **Sync emit from the stdio process:** `createMark`/`blockPersona` are called with `emit: (row, op) => emitOrQueue(null, db, table, op, row).catch(() => {})` where `emitOrQueue` comes from `appImport("servers/shared/sync-emit.js")` — the stdio process has no manager, so this queues to `sync_outbox` for the gateway drain (the C1 lamport column makes this batch succeed). In tests, `options.emit` may be a no-op spy.

- [ ] **Step 1: Write the failing test** (drive tools through the registered handlers against an in-memory db; use `server.tool` registration introspection or call the exported handler map — implement `createRambleServer` to also return handlers for testability via `options._exposeHandlers`)

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createRambleServer } from "../bundles/ramble/server/server.js";

let db, h;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const handlers = {};
  const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
  const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
  const identity = { crowId: "crow_T", secp256k1Pubkey: compressed("real"), secp256k1Priv: Buffer.from("real") };
  createRambleServer(db, { _exposeHandlers: handlers, identity, seed: "seed", _derive: fakeDerive, emit: async () => {} });
  h = handlers;
});

test("leave_mark then query_world returns it, attributed to the x-only world pseudonym", async () => {
  const r = await h.ramble_leave_mark({ lat: 30.2672, lon: -97.7431, text: "hello", visibility: "public", reveal: "open" });
  assert.ok(!r.isError);
  const q = await h.ramble_query_world({ lat: 30.2672, lon: -97.7431, visibility: "public" });
  const payload = JSON.parse(q.content[0].text);
  const m = payload.marks.find((m) => m.content_text === "hello");
  assert.ok(m);
  assert.match(m.author, /^[0-9a-f]{64}$/);
});

test("ramble_block hides that persona's marks", async () => {
  const r = await h.ramble_block({ persona: "a".repeat(64), reason: "test" });
  assert.ok(!r.isError);
});
```
(import `createHash` from `node:crypto`.)

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-tools.test.js`

- [ ] **Step 3: Implement `server.js`** — the `McpServer` factory + `server.tool(...)` registrations delegating to `marks.js`, resolving persona from `ramble_settings` (`public_identity_level`, default `rotating`) **passing the tool's `kind`** (`ramble_leave_mark` → `kind:"mark"`, `ramble_caw` → `kind:"caw"`) so rotating attributes marks to the stable pseudonym (Task 5), and writing `publish_state='pending'`. Populate `options._exposeHandlers[name] = handler` when provided so tests can call handlers directly.

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-tools.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/server.js bundles/ramble/server/index.js tests/ramble-tools.test.js
git commit bundles/ramble/server/server.js bundles/ramble/server/index.js tests/ramble-tools.test.js -m "feat(ramble): MCP tools (leave_mark/caw/query_world/unlock/pet_state/block)"
git show --stat HEAD
```

**Milestone M1 complete:** local core is fully testable via MCP with no network or UI.

---

## Task 8: Same-user sync (allowlist + natural-key apply handlers)

> **Design correction (plan review critical #1).** Appending to `SYNCED_TABLES` is necessary but NOT sufficient. `ramble_marks` excludes `id` and `ramble_settings`/`ramble_blocks` have no `id` at all, so the generic apply path (`instance-sync.js` ~line 1834, `WHERE id=?`) can never match an update and never no-op-safely delete. Each needs a natural-key apply handler in the apply dispatch (the pattern of `_applyDashboardSetting` keyed on `key`, `_applyMessage` keyed on `nostr_event_id`). **The test MUST be a real two-instance insert+delete round-trip, not allowlist membership.**

**Files:**
- Modify: `servers/sharing/instance-sync.js` (append tables to `SYNCED_TABLES`; add `EXCLUDED_COLUMNS`; add module-level `applyRambleMark`/`applyRambleSetting`/`applyRambleBlock` + dispatch; extend `shouldSyncRow`)
- Modify: `bundles/ramble/server/marks.js` (emit insert on create/block, delete on expire/purge/unblock)
- Test: `tests/ramble-sync.test.js`

**Interfaces:**
- Consumes: `emitOrQueue(syncManager, db, table, op, row)` (`servers/shared/sync-emit.js`); the existing apply dispatch + `shouldSyncRow(table, row)` in `instance-sync.js`.
- Produces:
  - `SYNCED_TABLES` gains `"ramble_marks"`, `"ramble_settings"`, `"ramble_blocks"` (NOT `ramble_groups` — no phase-1 writer; NOT `ramble_pet` — per-instance).
  - `EXCLUDED_COLUMNS`: `ramble_marks: ["id","publish_state","origin","lamport_ts"]` (rowid + per-instance state; lamport rides in the envelope, precedent `providers`), `ramble_settings: ["lamport_ts"]`, `ramble_blocks: ["lamport_ts"]`.
  - Module-level handlers `applyRambleMark(db, op, row, lamportTs)` (upsert on `mark_id`: `INSERT … ON CONFLICT(mark_id) DO UPDATE`; delete by `mark_id`), `applyRambleSetting(db, op, row, lamportTs)` (on `key`), `applyRambleBlock(db, op, row, lamportTs)` (on `persona`). **Last-writer-wins on the envelope lamport, exactly like `_applyDashboardSetting` (`instance-sync.js:1861`)**: read the local row's `lamport_ts`; if `lamportTs < localTs` skip; write `lamport_ts = lamportTs`. **`applyRambleMark` MUST set `origin='sync'`, `publish_state='synced'`** (Global Constraints C2) so the receiving instance's drain never re-publishes; on conflict-update it must NOT overwrite a local row's `origin`/`publish_state`/`nostr_event_id` if that row is `origin='local'` (the authoring instance keeps its own publish bookkeeping — only content/anchor/expiry columns update).
  - The instance-method dispatch in `_applyEntry` routes the three tables to these functions with `this.db`; an exported `applyRemoteOp(db, table, op, row, lamportTs = 0)` delegates to the same functions (the test seam — do NOT fork the logic).
  - `shouldSyncRow('ramble_marks', row)` returns `false` unless `row.mark_id` is present; `ramble_settings` requires `row.key`; `ramble_blocks` requires `row.persona`.

- [ ] **Step 1: Write the failing test — a real round-trip through BOTH doors.** (a) The **outbox door**: `emitOrQueue(null, db, "ramble_marks", "insert", storedRow)` with no manager must produce a `sync_outbox` row (this is the path every MCP-authored write takes; it fails silently without the `lamport_ts` column — C1). (b) The **apply door**: apply captured wire ops to a second in-memory db through `applyRemoteOp` and assert insert / LWW / delete semantics and the `origin='sync'` stamp.

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { SYNCED_TABLES, EXCLUDED_COLUMNS, applyRemoteOp } from "../servers/sharing/instance-sync.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark } from "../bundles/ramble/server/marks.js";

let a, b; // instance A (author) and B (peer)
before(async () => {
  a = createClient({ url: "file::memory:" }); await initRambleTables(a);
  b = createClient({ url: "file::memory:" }); await initRambleTables(b);
  _setEligibilityForTest(() => true);
});

test("allowlist + exclusions", () => {
  for (const t of ["ramble_marks", "ramble_settings", "ramble_blocks"]) assert.ok(SYNCED_TABLES.includes(t), t);
  assert.ok(!SYNCED_TABLES.includes("ramble_groups"));
  for (const c of ["id", "publish_state", "origin", "lamport_ts"]) assert.ok(EXCLUDED_COLUMNS.ramble_marks.includes(c), c);
});

test("outbox door: an MCP-process write (no manager) lands in sync_outbox", async () => {
  const row = await createMark(a, {
    author: "a".repeat(64), author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 }, content: { content_text: "queued" },
  });
  const res = await emitOrQueue(null, a, "ramble_marks", "insert", row);
  assert.ok(res && res.queued, "emitOrQueue returned null — the stamp batch failed (missing lamport_ts?)");
  const { rows } = await a.execute("SELECT table_name, op FROM sync_outbox");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table_name, "ramble_marks");
});

test("apply door: insert lands on B as origin=sync, LWW by lamport, delete by mark_id", async () => {
  const row = { mark_id: "m9", author: "pk1", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "hi", created_at: 1000 };
  await applyRemoteOp(b, "ramble_marks", "insert", row, 5);
  let got = await b.execute({ sql: "SELECT content_text, origin, publish_state, lamport_ts FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "hi");
  assert.equal(got.rows[0].origin, "sync");       // C2: the peer's drain must never publish this
  assert.equal(got.rows[0].publish_state, "synced");
  assert.equal(got.rows[0].lamport_ts, 5);
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, content_text: "stale" }, 3); // older → ignored
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, content_text: "newer" }, 7);
  got = await b.execute({ sql: "SELECT content_text FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "newer");
  await applyRemoteOp(b, "ramble_marks", "delete", { mark_id: "m9" }, 8);
  got = await b.execute({ sql: "SELECT 1 FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows.length, 0);
});

test("settings + blocks apply by natural key (idempotent, no UNIQUE throw)", async () => {
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "pseudonym" }, 1);
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "real" }, 2);
  const got = await b.execute({ sql: "SELECT value FROM ramble_settings WHERE key=?", args: ["public_identity_level"] });
  assert.equal(got.rows[0].value, "real");
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: "b".repeat(64), reason: "x", created_at: 1 }, 1);
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: "b".repeat(64), reason: "x", created_at: 1 }, 1);
  await applyRemoteOp(b, "ramble_blocks", "delete", { persona: "b".repeat(64) }, 2);
  assert.equal((await b.execute("SELECT 1 FROM ramble_blocks")).rows.length, 0);
});
```

> **Implementation shape:** the live handlers are **instance methods** on `InstanceSyncManager` (class at `instance-sync.js:319`) using `this.db`; `_applyDashboardSetting` (`:1861`) is the shape to copy — read it first. Write **module-level** `applyRambleMark(db, op, row, lamportTs)` / `applyRambleSetting(...)` / `applyRambleBlock(...)`; have BOTH the `_applyEntry` dispatch (add three `if (table === "ramble_…")` blocks beside the `contact_groups` one, passing `this.db` and the envelope `lamport_ts`) and the exported `applyRemoteOp` delegate to them. `emitOrQueue` in the outbox test needs `getOrCreateLocalInstanceId()` (`servers/gateway/instance-registry.js`) to work under the scratch env — it does in `tests/sync-emit.test.js` / `tests/sync-outbox-e2e.test.js`; model on those (they show the `_setEligibilityForTest` + null-manager queue path; `emitOrQueue` calls `ensureSyncTables` itself).

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-sync.test.js`

- [ ] **Step 3: Implement** — append the table names; add the `EXCLUDED_COLUMNS` entries; add the three module-level natural-key handlers + dispatch; extend `shouldSyncRow`; export `applyRemoteOp`; wire `createMark`/`blockPersona` (emit `insert`) and `expireMarks`/master-purge/`unblockPersona` (emit `delete`) through the `emit` hook.

- [ ] **Step 4: Run, expect PASS**, then run the existing sync suite to confirm no regression: `node scripts/run-suite.mjs tests/instance-sync.test.js` (if present) and `node scripts/run-suite.mjs tests/auth-network.test.js`.

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/instance-sync.js bundles/ramble/server/marks.js tests/ramble-sync.test.js
git commit servers/sharing/instance-sync.js bundles/ramble/server/marks.js tests/ramble-sync.test.js -m "feat(ramble): replicate marks/groups/settings with natural-key apply handlers"
git show --stat HEAD
```

---

## Task 9: Nostr event mapping

**Files:**
- Create: `bundles/ramble/server/nostr-map.js`
- Test: `tests/ramble-nostr-map.test.js`

**Interfaces:**
- Produces: `markToEvent(row, { precision = 5, crowId = null } = {}) -> { kind, created_at, tags, content }` for **`visibility==='public'` rows ONLY** (throws `RambleNotPublic` for anything else — phase-1 wire is public-only, Global Constraints D1):
  - **Kinds:** `MARK_KIND = 30397` (addressable; tag `["d", mark_id]`) for marks, `CAW_KIND = 20397` (ephemeral) for caws. Export both constants.
  - **Tags:** `["g", geohash.slice(0, n)]` for every `n` in `1..geohash.length` (exact-match filters, C3); `["d", mark_id]` (marks only); `["k", anchor_kind]`; `["rv", reveal]`; `["expiration", String(Math.floor(expires_at/1000))]` when `expires_at` is set (NIP-40 — relays drop it, D2); `["crow", crowId]` when `crowId` is given (level `real`).
  - **Content (JSON, in the clear):** marks → `{ v:1, text, content_kind, content_ref, lat, lon, accuracy_m, locked: reveal==='locked' }` (`reveal:'locked'` still ships the text — phase-1 limitation, Task 4 — with `locked:true` so honest clients gate display). **Caws → `{ v:1, text, locked:false }` with NO coordinates**, and the caw's `g` tags are truncated to `precision` (D3: presence is coarse; a caw is the user's own position).
  - `eventToMark(event) -> row` — inverse: `author = event.pubkey` (already x-only), `nostr_event_id = event.id`, `origin:'remote'`, `publish_state:'remote'`, `geohash` = the LONGEST `g` tag, `mark_id` = the `d` tag or (for caws) `event.id`, `created_at = event.created_at*1000`, `expires_at` from `expiration`, `kind` from the event kind, lat/lon from content when present. Rejects (returns `null`) events with neither `g` tag nor parseable JSON content.
  - Pure functions (no signing here; Task 10 finalizes/signs).

- [ ] **Step 1: Write the failing test** — round-trip a public open mark, a public locked mark, and a caw. Assert: every prefix of the geohash appears as a `g` tag (and no other); marks are `MARK_KIND` with a `d` tag, caws are `CAW_KIND` with no `d` tag; the locked event's content carries `"locked":true`; a caw's content has no `lat`/`lon` and its longest `g` tag is `precision` chars; an `expiration` tag (seconds) is present when `expires_at` is set; a `crow` tag appears only when `crowId` is passed; `eventToMark(markToEvent(row)).geohash === row.geohash` for marks; `markToEvent` throws for `visibility:'contacts'`.

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-nostr-map.test.js`

- [ ] **Step 3: Implement `nostr-map.js`** (pure tag/JSON mapping).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/nostr-map.js tests/ramble-nostr-map.test.js
git commit bundles/ramble/server/nostr-map.js tests/ramble-nostr-map.test.js -m "feat(ramble): mark <-> Nostr event mapping (geohash g-tag)"
git show --stat HEAD
```

---

## Task 10: Gateway-side transport (publisher drain + subscriber)

**Files:**
- Create: `servers/gateway/boot/ramble-transport.js`
- Modify: `servers/gateway/boot/feature-mounts.js` (start it when ramble is installed)
- Test: `tests/ramble-transport.test.js`

**Interfaces:**
- Consumes: `getManagersOrNull()` (`servers/sharing/managers.js`) → `{ nostrManager, identity, db }`; `finalizeEvent` (nostr-tools); `nostrManager.publishRendezvousEvent(event)` (returns the array of relay urls that accepted); `nostrManager.connectRelays()`; **`nostrManager.relays` (a `Map<url, Relay>`) + `makeResilientSub(relay, filter, onevent, opts)` from `servers/sharing/resilient-subscribe.js`** — `NostrManager` has NO generic subscribe API (review round 3, D6), so the subscriber owns its own sub handles and runs its own `ensureHealthy()` loop (the manager's health loop only knows contact subs); `markToEvent`/`eventToMark`; `insertRemoteMark` (marks.js); `bus.emit("ramble:nearby", payload)` (`servers/shared/event-bus.js`); `resolvePersona` + real `deriveBotIdentity`; `getGrid`/`emitAllowed` (Task 11).
- Produces: `export async function startRambleTransport({ db, nostrManager, identity, seed, bus, intervalMs = 15000, _derive })` returning `{ stop(), drainOnce(), onEvent(event), currentFilter(), resubscribe() }` (exposed for tests; the interval just calls `drainOnce`). Also listens for `bus.on("ramble:drain", () => drainOnce())` so in-process authoring (Task 12) publishes without waiting for the interval, and `bus.on("ramble:area", () => resubscribe())` when the active area changes.
  - **Startup:** init-if-missing the ramble tables (the knowledge-base precedent at `feature-mounts.js:148–176`: probe `sqlite_master` for `ramble_marks`, call `initRambleTables` only when absent — review round 3, D7; the gateway must not depend on the stdio child having started first).
  - **drain** — `SELECT * FROM ramble_marks WHERE publish_state='pending' AND origin='local'`; for each: **skip unless `visibility='public'`** (phase-1 wire is public-only; leave the row `pending` — it is still a valid local/synced mark); check the privacy grid allows `(public, geo)` with master on (Task 11) — skip if not; resolve persona **passing `kind`** → `markToEvent(row, { precision, crowId: persona.crowId })` → `finalizeEvent(template, persona.secp256k1Priv)` → `const published = await publishRendezvousEvent(event)`. **Guard (plan review):** only `UPDATE ... SET publish_state='published', nostr_event_id=?` when `published.length > 0`; otherwise leave `pending` (and bump an in-memory retry counter) so an all-relays-down moment does not silently drop the mark. **Deletes:** `marks.js` records owner-deletes of a `published` public mark in an in-memory/`ramble_settings`-backed tombstone list the drain reads to publish a NIP-09 kind-5 event `["e", nostr_event_id]` signed by the same persona (D2); expiry needs no deletion event (relays honor `expiration`).
  - **subscribe** — filter `{ kinds: [MARK_KIND, CAW_KIND], "#g": cells }` where `cells` = the user's active cells at the configured precision (`ramble_settings.active_area`, a JSON array of geohash prefixes written by `POST /api/ramble/area`, Task 12; empty → no subscription). One `makeResilientSub` per relay in `nostrManager.relays`; a `setInterval` calls `ensureHealthy()` on each handle every 30 s; `stop()` closes them. `onEvent(event)`: **skip events whose `event.pubkey` equals any of our own personas' `author`** (own-echo — x-only compare, C4; keep a Set of personas resolved this process), else `insertRemoteMark(eventToMark(event))` (idempotent on `nostr_event_id` OR `mark_id`; drops blocked personas) then, if newly inserted, `bus.emit("ramble:nearby", { geohash })`.

- [ ] **Step 1: Write the failing test** — inject a fake `nostrManager` (`relays: new Map([["wss://fake", fakeRelay]])`, records `publishRendezvousEvent` calls, returns `["wss://fake"]`), a fake `_derive`, an in-memory db (tables NOT pre-initialized — assert the transport initializes them, D7) with one `pending` public mark and one `pending` `contacts` mark; seed `active_area` = `["9v6m2"]`; run one drain tick; assert the public mark flips to `published` with a `nostr_event_id`, the contacts mark stays `pending` and nothing was published for it, and the published event's tags include `["g", "9v6m2"]` (the precision-5 prefix) as well as the full geohash. Assert `currentFilter()["#g"]` contains `"9v6m2"` and `kinds` contains both kinds. Then feed a synthetic incoming event (author ≠ ours) to `onEvent` and assert a `remote` row is inserted (idempotent on a second feed) and `bus` emitted `ramble:nearby`; feed an event whose `pubkey` equals our world persona's `author` and assert it is NOT inserted.

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark } from "../bundles/ramble/server/marks.js";
import { startRambleTransport } from "../servers/gateway/boot/ramble-transport.js";
// ...construct fakes, run one tick via the returned handle's internal drainOnce (expose drainOnce/onEvent on the handle for tests)
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-transport.test.js`

- [ ] **Step 3: Implement `ramble-transport.js`** (expose `drainOnce()`, `onEvent(event)`, `currentFilter()`, `resubscribe()` on the returned handle for tests; the interval just calls `drainOnce`). Import the bundle modules by **path** the same way feature-mounts imports knowledge-base (`$CROW_HOME/bundles/ramble/server/*.js` if installed there, else the repo's `bundles/ramble/server/*.js`, via `pathToFileURL(...).href`) — the transport lives in core and must not hard-import a bundle path that may not exist. Then in `feature-mounts.js`, after the existing installed-bundle checks (the knowledge-base lan-discovery block is the pattern), if the ramble bundle dir exists call `getManagersOrNull()` and `startRambleTransport(...)`, guarding on `nostrManager` being present, and `loadInstanceSeed(dataDir)` for the seed.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/boot/ramble-transport.js servers/gateway/boot/feature-mounts.js tests/ramble-transport.test.js
git commit servers/gateway/boot/ramble-transport.js servers/gateway/boot/feature-mounts.js tests/ramble-transport.test.js -m "feat(ramble): gateway-side Nostr drain + area subscriber"
git show --stat HEAD
```

---

## Task 11: Privacy grid + master switch + identity level

**Files:**
- Create: `bundles/ramble/server/grid.js`
- Modify: `bundles/ramble/server/server.js` and `servers/gateway/boot/ramble-transport.js` to consult the grid
- Test: `tests/ramble-grid.test.js`

**Interfaces:**
- Produces: `getGrid(db) -> { master, cells, identityLevel, activeArea }` (reads `ramble_settings`, defaults: `master=false`, every cell `false`, `identityLevel="rotating"`); `setCell(db, audience, channel, on)`, `setMaster(db, on)`, `setIdentityLevel(db, level)`; `emitAllowed(grid, audience, channel) -> boolean` (`grid.master && grid.cells[audience]?.[channel]`). The drain publishes a mark only for audiences whose (audience, `geo`) cell is on and `master` is true; `setMaster(db, false, { emit })` also deletes live caws (`DELETE FROM ramble_marks WHERE kind='caw' AND origin='local'`, emitting a sync `delete` per row through the same `emit` hook as `expireMarks`). Grid/identity writes go through `emit` too (`ramble_settings` replicates, Task 8).

- [ ] **Step 1: Write the failing test** — default grid blocks all; turning on `(public, geo)` with master on allows public/geo; master off blocks everything and clears caws.

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-grid.test.js`

- [ ] **Step 3: Implement `grid.js`**; make the drain filter `pending` marks through `emitAllowed(grid, visibilityAudience, "geo")`. **Update `tests/ramble-transport.test.js` (plan re-review):** gating the drain here will make Task 10's transport test fail (it published with no grid, and the default is `master=false`/all-off). Seed an enabling grid in that test — `setMaster(db, true)` + `setCell(db, "public", "geo", true)` before the drain — and include `tests/ramble-transport.test.js` in this task's commit.

- [ ] **Step 4: Run, expect PASS** — run both `node scripts/run-suite.mjs tests/ramble-grid.test.js` and `node scripts/run-suite.mjs tests/ramble-transport.test.js`.

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/grid.js bundles/ramble/server/server.js servers/gateway/boot/ramble-transport.js tests/ramble-grid.test.js tests/ramble-transport.test.js
git commit bundles/ramble/server/grid.js bundles/ramble/server/server.js servers/gateway/boot/ramble-transport.js tests/ramble-grid.test.js tests/ramble-transport.test.js -m "feat(ramble): privacy grid + master visible switch gating egress"
git show --stat HEAD
```

---

## Task 12: Panel (map + compose + settings + pet shell)

**Files:**
- Create: `bundles/ramble/panel/ramble.js`, `bundles/ramble/panel/routes.js`, `bundles/ramble/panel/static/ramble.js`, vendored `bundles/ramble/panel/static/leaflet/*`
- Test: `tests/ramble-panel.test.js`

**Interfaces:**
- Consumes: `layout({title, content})`; `dashboardAuth`; `marks.js`, `grid.js` via dynamic import from `$CROW_HOME/bundles/ramble` (panel runs in the gateway process).
- Produces: panel handler object `{ id:"ramble", name:"Ramble", icon:"map-pin", route:"/dashboard/ramble", navOrder:120, category:"social", async handler(req,res,{db,layout,appRoot}) }`; router `export default (dashboardAuth) => Router` with **path-scoped** `router.use("/api/ramble", dashboardAuth)` and `router.use("/api/ramble", express.json({limit:"1mb"}))`; API routes `GET /api/ramble/marks`, `POST /api/ramble/marks` (in-process authoring: write via `createMark` with `emit` = `emitOrQueue(getInstanceSyncManager(), db, …)`, then `bus.emit("ramble:drain")` so the transport publishes on the next tick — the drain is the single egress, Task 10; do NOT re-implement publishing here, and do not claim synchronous publish), `DELETE /api/ramble/marks/:mark_id` (owner delete: local delete + sync delete emit + tombstone for the NIP-09 drain, Task 10), `GET/POST /api/ramble/grid`, `POST /api/ramble/unlock` (calls `unlockMark(db, mark_id, here)`), **`POST /api/ramble/area`** (body `{ lat, lon }` or `{ cells:[…] }` → writes `ramble_settings.active_area` as the precision-N cell(s) and `bus.emit("ramble:area")` — the subscriber's only input, D6; the client posts it when the map view settles), `POST /api/ramble/block` (`blockPersona`), `GET /api/ramble/pet` (Task 14 fills it; stub `{mood:"happy"}` here).
- Persona in the gateway process: `identity` from `getManagersOrNull().identity`, seed via `loadInstanceSeed`, `deriveBotIdentity` real — same `resolvePersona` call as the MCP server (Task 7 seam), `kind` passed.

- [ ] **Step 1: Write the failing test** — mount the router with a stub `dashboardAuth` and assert: `GET /api/ramble/marks` requires auth (401 without), the panel handler object has the right `route`/`navOrder`, and `POST /api/ramble/marks` inserts a row. (Use `supertest`-style via the router if available in the repo; otherwise assert the exported handler object shape + call the route handlers directly.)

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-panel.test.js`

- [ ] **Step 3: Vendor Leaflet + implement panel**

```bash
mkdir -p bundles/ramble/panel/static/leaflet
# Vendor Leaflet 1.9.4 (leaflet.js + leaflet.css + images/marker-*.png, layers*.png) into static/leaflet/.
# Include Leaflet's LICENSE (BSD-2) and a VERSION file ("1.9.4 — https://unpkg.com/leaflet@1.9.4/dist/") beside them.
# Pin the version; no CDN at runtime. (CI's check-vendored-payloads only guards bundles/<id>/payload/ — static/ is unguarded, hence the VERSION note.)
```
The client posts `POST /api/ramble/area` on Leaflet `moveend` (debounced) and re-fetches `/api/ramble/marks?cells=…`; the map draws locked marks as teasers (no popup text) and calls `POST /api/ramble/unlock` with the browser's geolocation when the user taps one.
Implement `routes.js` (path-scoped auth, JSON body, the four API routes) and `ramble.js` (panel handler rendering a `<div id="ramble-map">`, a compose form, the settings grid, and the pet mount; `static/ramble.js` initializes Leaflet from the vendored files, loads `/api/ramble/marks`, drops markers, and opens the `/dashboard/streams/ramble-nearby` EventSource).

- [ ] **Step 4: Run, expect PASS**; then smoke-boot the gateway: `node servers/gateway/index.js --no-auth` and confirm no mount error, ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/panel tests/ramble-panel.test.js
git commit bundles/ramble/panel tests/ramble-panel.test.js -m "feat(ramble): map + compose + privacy-grid panel (vendored Leaflet)"
git show --stat HEAD
```

---

## Task 13: Live nearby stream

**Files:**
- Modify: `servers/gateway/routes/streams.js` (add `/dashboard/streams/ramble-nearby`)
- Test: `tests/ramble-stream.test.js`

**Interfaces:**
- Consumes: `bus` (`event-bus.js`); the existing `openAuthedStream`/`sseTurbo` helpers in `streams.js`.
- Produces: a channel that, on `bus.emit("ramble:nearby", payload)`, pushes an SSE frame to authed clients; unsubscribes on `res` close/error (the notifications-channel pattern).

- [ ] **Step 1: Write the failing test** — the bus handler is registered **per request inside the route** (not at module load — review round 3, D9), so a bare spy on `bus.on` sees nothing. Model the existing stream tests: find a route test that drives a streams route with a fake authed `req`/`res` (grep `tests/*stream*.test.js` for `openAuthedStream`), invoke the `ramble-nearby` handler that way, then `bus.emit("ramble:nearby", { geohash: "9v6" })` and assert the fake `res` received a frame containing `9v6`, and that `res.emit("close")` removes the listener (`bus.listenerCount("ramble:nearby")` back to its prior value). Keep it to handler wiring (SSE socket I/O is covered by existing stream tests).

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-stream.test.js`

- [ ] **Step 3: Implement** the channel following the `notifications` block in `streams.js`.

- [ ] **Step 4: Run, expect PASS**; run `node scripts/run-suite.mjs tests/auth-network.test.js` (streams.js is a gateway route surface) and confirm green.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/routes/streams.js tests/ramble-stream.test.js
git commit servers/gateway/routes/streams.js tests/ramble-stream.test.js -m "feat(ramble): live nearby SSE stream channel"
git show --stat HEAD
```

---

## Task 14: Pet feed

**Files:**
- Create: `bundles/ramble/server/pet.js`
- Modify: `bundles/ramble/server/server.js` (`ramble_pet_state` reads pet), `bundles/ramble/panel/static/ramble.js` (drive the crow mood class)
- Test: `tests/ramble-pet.test.js`

**Interfaces:**
- Produces: `feed(db, event) -> petRow` where `event.type ∈ {visit_place, unlock_mark, meet_crow, quiet_tick}`; updates `energy` (clamped 0–100), rolling weekly counters, and derives `mood ∈ {happy, tired, alarmed}` from energy thresholds (energy ≥ 60 → happy, 30–59 → tired, < 30 → alarmed); `petState(db) -> { mood, energy, places_week, unlocks_week, crows_week }`.

> **Pet render seam (plan review question).** `updateCrowMood` (`servers/gateway/dashboard/shared/notifications.js:1050`) is a **closure inside `tamagotchiJs(lang)`**, not a global, and `#crow-tama` is the **Nest-header** widget — not reliably present or reachable from the panel page. Phase 1 does NOT drive the header crow. Instead the ramble panel renders **its own** crow in the panel DOM: copy the crow SVG markup + the `.crow-happy`/`.crow-tired`/`.crow-alarmed` CSS (from `notifications.js`) into `panel/ramble.js`/`static/ramble.js` under a panel-scoped id (e.g. `#ramble-pet`), and `static/ramble.js` sets the mood class from `GET /api/ramble/pet`. Wiring the shared header crow (exposing a `window.setCrowMood`) is a phase-2 nicety, noted here so it isn't lost.

- [ ] **Step 1: Write the failing test** — feeding `visit_place`/`unlock_mark`/`meet_crow` raises energy and sets `happy`; repeated `quiet_tick` lowers energy to `tired` then `alarmed`; counters increment.

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-pet.test.js`

- [ ] **Step 3: Implement `pet.js`**; wire `ramble_pet_state` + a `GET /api/ramble/pet` route; render `#ramble-pet` in the panel and map `mood` → the panel-scoped crow class in `static/ramble.js` (phase-1 feeds `visit_place` when the user opens the map at a new geohash and `unlock_mark` on a successful unlock — geo activity only, per spec §11).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/pet.js bundles/ramble/server/server.js bundles/ramble/panel/static/ramble.js tests/ramble-pet.test.js
git commit bundles/ramble/server/pet.js bundles/ramble/server/server.js bundles/ramble/panel/static/ramble.js tests/ramble-pet.test.js -m "feat(ramble): pet feed (geo activity -> crow mood)"
git show --stat HEAD
```

**Milestone M2 complete:** Ramble core is social (Nostr), visual (map+compose+grid), and alive (pet), fed by geo activity only. Proximity channels (BLE/LAN/sensing), AR, and companion-lite are phases 2–4.

---

## Integration + landing

- [ ] Run the full suite: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && npm test` — confirm the pre-existing floor + the new ramble tests, 0 failures.
- [ ] `npm run build-registry` clean; `node scripts/check-port-allocation.js` clean (phase 1 adds no host port; the phase-3 media server will).
- [ ] Open a PR from a feature branch; confirm CI `suite`/`static-checks`/`audit` green on the head sha (check-runs API) before merge. `main` is branch-protected.
- [ ] Before merging: check `/home/kh0pp/CROW-SCHEDULE.md` + `node scripts/ops/box-reserve.mjs status`; prefer merging while the box is free (the primary gateway auto-updates on origin/main movement and does not consult the reservation). r4 runs from `~/crow` too (`sudo systemctl restart crow-r4-gateway`).

---

## Self-review notes (coverage against the spec)

- Spec §2 privacy grid + identity levels → Tasks 5, 11. Spec §3 geo channel → Tasks 3, 6, 10 (BLE/LAN/sensing are phase 2). Spec §4 data model + lifetimes + locked reveal + actions → Tasks 2, 4, 6 (react/reply/report UI lands with the panel in Task 12/phase 2 hardening). Spec §5 Nostr transport + sync + media → Tasks 8, 9, 10 (media server is phase 3; photo marks degrade to text/link in phase 1). Spec §6 pet + character module → Task 14 (the `feed(event)` interface is the character-module seam; AI-voice/peer layers are phase 4). Spec §8 bundle architecture, app-root, path-scoped mounts, no-Funnel, ports → Tasks 1, 12, 13 + Global Constraints. Spec §10 testing → every task's TDD cycle + the integration gate.
- **Deferred within phase 1 (explicit):** photo content (needs the phase-3 media server) — `content_kind='photo'` is stored but phase-1 compose offers text/sticker/link only; reply/react UI is a thin follow-up on Task 12 (block/hide IS in phase 1 — Tasks 6/7/12); geohash neighbor-cell expansion (`geohashNeighborsPrefix`) returns the single cell in phase 1 (Task 3 note).
- **Phase 1b (its own plan, after this ships):** contacts/group Nostr delivery — per-contact gift-wrap fan-out, a group-key primitive (not pairwise NIP-44), the inbound `#p` subscription + decrypt path, `ramble_group_create/join` + invite flow, `ramble_groups` sync handler. In phase 1 contacts/group marks exist locally and on the user's own instances only.

---

## Review

**Reviewer:** adversarial staff-engineer subagent (plan-reviewer skill), verifying every claim against the live codebase.
**Date:** 2026-09-06.
**Verdict:** REVISE → issues addressed inline (below), pending a re-review.

**Confirmed sound (no change):** the two-process pending-drain model holds — bundle MCP servers do run as stdio children in prod (`servers/gateway/proxy.js` `loadAddonServers`), so MCP-authored marks land as `pending` rows and the gateway drain publishes; boot order makes `getManagersOrNull()` return a live `nostrManager` inside feature-mounts; `SYNCED_TABLES`/`EXCLUDED_COLUMNS`/`emitOrQueue`/streams helpers/run-suite single-file all verified; M1 (Tasks 1–7) sequencing is good.

**Critical issues resolved:**
1. **Sync would not replicate (Task 8).** Appending to `SYNCED_TABLES` is insufficient for natural-key tables. Task 8 rewritten to add `_applyRambleMark` (mark_id) / `_applyRambleSetting` (key) / `_applyRambleGroup` (group_id) apply handlers, a `shouldSyncRow` gate, and a **real two-instance insert+delete round-trip test** (was membership-only). `expireMarks`/master-purge now emit deletes so expiry propagates.
2. **Locked-mark crypto self-defeating for public geo (Tasks 4/9).** The per-tag secret rode in the event alongside the geohash KDF input. Removed entirely: `lock.js` replaced by `reveal.js` (in-range teaser gate, no crypto); Task 9 content is audience-scoped (public in the clear with a `locked:true` display flag; contacts/group encrypted to recipients). Global Constraints + spec §4/§5 now state plainly that public locked marks are not scraper-proof in phase 1; real crypto locking is deferred to the world-server phase.
3. **Persona rotation broke moderation (Task 5).** `resolvePersona` now splits by `kind`: under `rotating`, placed marks use the stable `ramble-world` pseudonym (so `ramble_blocks` survive a session); only caws (presence) rotate per session. Task 7 passes `kind`.

**Suggestions applied:** drain guards the `published` UPDATE on a non-empty relay result (no silent drop when relays are down); subscriber dedups on `nostr_event_id` OR `mark_id` and skips own-persona echoes; Task 12 in-process authoring emits `bus.emit("ramble:drain")` instead of claiming synchronous publish; `insertRemoteMark` uses relative-TTL on receipt to tolerate cross-instance clock skew.

**Question resolved:** the pet render seam — the header `updateCrowMood` is a closure, not reachable from the panel; Task 14 now renders a panel-scoped `#ramble-pet` crow, with header integration deferred to phase 2.

### Review round 2 (2026-09-06) — APPROVE

Follow-up adversarial review confirmed all three criticals resolved with no invented APIs and no regressions (`_applyDashboardSetting`/`_applyMessage` verified real at `instance-sync.js:1861`/dispatch `1761–1835`; `applyRemoteOp` correctly framed as a to-be-added wrapper; no dangling `lock.js`/`sealLocked`/`ramble-lock` refs; `unlockMark` signature consistent at every call site; milestones consistent). **Verdict: execution-ready.** Two minor notes folded in inline:
- **Task 11 breaks Task 10's transport test** (the grid gate blocks the ungated test's publish) — Task 11 now seeds an enabling grid and includes `tests/ramble-transport.test.js` in its commit.
- **`applyRemoteOp` cannot call the instance methods** (they write `lamport_ts`/`updated_at`, absent from ramble tables) — Task 8 now specifies module-level `applyRamble*` functions both paths delegate to, and documents last-delivered-wins as the phase-1 conflict model. *(Superseded by round 3: the tables now carry `lamport_ts`, so the handlers do real LWW.)*

### Review round 3 (2026-09-06, Fable, direct code-verified review) — REVISE → fixed inline

Rounds 1–2 verified the line numbers they were pointed at but never traced the path an MCP-authored mark actually takes through the stdio outbox, nor the Nostr filter semantics. Five confirmed defects and nine specification holes, all folded in above:

**Critical (code-verified):**
1. **C1 — MCP-authored marks never replicated.** `sync-emit.js` ~:230 row-stamps `UPDATE <table> SET lamport_ts=? WHERE id=?` inside one atomic batch; ramble tables had no `lamport_ts`, so the batch threw and `emitOrQueue` returned `null` (warn only). The gateway path tolerates the missing column, so panel writes would sync and MCP writes would not — silently; Task 8's apply-only test could never see it. Fix: `lamport_ts INTEGER DEFAULT 0` on the three synced tables (Task 2), an outbox-door test (Task 8), real LWW in the handlers.
2. **C2 — double publish across the user's own instances.** `EXCLUDED_COLUMNS` strips `publish_state`/`origin`, so a replicated row landed as `pending`/`local` and the peer's drain re-published it. Fix: `applyRambleMark` stamps `origin='sync'`/`publish_state='synced'` (Task 8, tested).
3. **C3 — the nearby subscription matched nothing.** Nostr tag filters are exact-match; one `g` tag at precision 7 vs a subscription at precision 5 never intersects. Fix: `g` tags at every prefix length (NIP-52), filter at the configured precision (Task 9/10, tested).
4. **C4 — pubkey format mismatch.** `deriveBotIdentity().secp256k1Pubkey` is 66-hex compressed; `event.pubkey` is 64-hex x-only (`nostr.js:503` strips it). Own-echo skip and `ramble_blocks` would never match. Fix: `author` is always x-only; `real` carries `crowId` separately + a `crow` tag (Task 5/9, tested).
5. **C5 — Task 1 failed `validateManifest`** (`description` is universal-required; the manifest used `notes`). Fixed.

**Specification holes resolved:** D1 contacts/group delivery had no receive path and an unusable group-key primitive → phase-1 wire is **public-only**, phase 1b named; D2 custom `exp` tag → NIP-40 `expiration` + NIP-09 deletes; D3 caws leaked exact position → caws carry only the coarse geohash; D4 kind 30078 is NIP-78 → 30397/20397; D5 blocks were never consulted → `blockPersona`/`isBlocked`, `ramble_block` tool, filtered on receipt and in lists, `ramble_blocks` synced; D6 `NostrManager` has no generic subscribe → `relays` map + `makeResilientSub` + own health loop, and `active_area` now has a writer (`POST /api/ramble/area`); D7 gateway queried tables only the stdio child created → init-if-missing at transport start; D8 Task 7 had no identity seam and groups had no spec → injectable identity/seed/_derive, groups moved to phase 1b; D9 Task 13's `bus.on` spy could not observe a per-request registration → fake req/res pattern.

**Spec updated in the same commit:** §4 sync list, §5 wire conventions + public-only phase 1, §7 phase 1b, §11 open questions answered.
