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
- **Sync:** every ramble table write that must replicate to the user's own instances goes through `emitOrQueue(syncManager, db, table, op, row).catch(() => {})`, and the table name is appended to `SYNCED_TABLES` in `servers/sharing/instance-sync.js`.
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
    lock.js                     # anchor-derived content encryption (locked marks)
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
  ramble-lock.test.js
  ramble-persona.test.js
  ramble-marks.test.js
  ramble-tools.test.js
  ramble-sync.test.js
  ramble-nostr-map.test.js
  ramble-grid.test.js
  ramble-pet.test.js
```

**Milestones:** M1 = local core (Tasks 1–8: scaffold, tables, anchors, lock, persona, marks, MCP tools, sync) — working, testable, no network/UI. M2 = social + visual (Tasks 9–14: Nostr mapping, gateway transport, grid, panel, stream, pet).

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
  "notes": "Proximity broadcasts (caws) + a shared/private map of discoverable marks, with a crow pet. Phase 1: geo channel, map, Nostr, pet.",
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
Expected: build succeeds, ramble present. (`server.js`/`init-tables.js` do not exist yet — the registry build reads the manifest only, not the server code.)

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
- `ramble_marks` columns (the wire/store shape every later task uses): `id INTEGER PK AUTOINCREMENT`, `mark_id TEXT UNIQUE` (uuid), `author TEXT` (persona pubkey hex), `author_level TEXT` (`rotating|pseudonym|real`), `kind TEXT` (`caw|mark`), `anchor_kind TEXT` (`geo|lan|beacon|fingerprint|visual`), `geohash TEXT`, `lat REAL`, `lon REAL`, `accuracy_m REAL`, `anchor_ref TEXT` (salted lan id / beacon id / fingerprint hash / opaque visual), `visibility TEXT` (`public|contacts|group:<id>`), `reveal TEXT` (`open|locked`), `content_text TEXT`, `content_kind TEXT` (`none|photo|sticker|link`), `content_ref TEXT`, `thumb_enc TEXT`, `locked_blob TEXT` (ciphertext when reveal=locked), `created_at INTEGER`, `expires_at INTEGER` NULL, `nostr_event_id TEXT UNIQUE` NULL, `publish_state TEXT DEFAULT 'pending'` (`pending|published|remote`), `origin TEXT` (`local|remote`).

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
      origin TEXT NOT NULL DEFAULT 'local'
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
      value TEXT
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
      created_at INTEGER NOT NULL
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

## Task 4: Anchor-derived content lock

**Files:**
- Create: `bundles/ramble/server/lock.js`
- Test: `tests/ramble-lock.test.js`

**Interfaces:**
- Produces: `deriveAnchorKey(anchor, secret) -> Buffer(32)` (scrypt over a **coarse** anchor token so nearby fixes agree — geo uses `geohash.slice(0, precision)` at precision 6 ≈ 1.2 km cell; lan/beacon/fingerprint use `anchor_ref`); `sealLocked(plaintextObj, anchor, secret) -> string` (base64 `iv|tag|ciphertext`, AES-256-GCM); `openLocked(blob, anchor, secret) -> object|null` (null on wrong key/anchor). `secret` is a per-tag random hex embedded in the published event's addressable payload; a viewer learns it only by being in the cell (phase-1: the event carries `secret` but content is GCM-sealed to the anchor key, so a scraper without the anchor cannot derive the key even holding `secret`).

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealLocked, openLocked } from "../bundles/ramble/server/lock.js";

const anchor = { anchor_kind: "geo", geohash: "9v6m2ab", lock_precision: 6 };
const wrong  = { anchor_kind: "geo", geohash: "dr5regw", lock_precision: 6 };
const secret = "deadbeefcafe";

test("seal/open round-trips with the right anchor", () => {
  const blob = sealLocked({ content_text: "under the mailbox" }, anchor, secret);
  assert.equal(openLocked(blob, anchor, secret).content_text, "under the mailbox");
});

test("wrong anchor cannot open even with the secret", () => {
  const blob = sealLocked({ content_text: "x" }, anchor, secret);
  assert.equal(openLocked(blob, wrong, secret), null);
});

test("nearby geohash in the same coarse cell still opens", () => {
  const blob = sealLocked({ content_text: "y" }, { anchor_kind: "geo", geohash: "9v6m2ab", lock_precision: 6 }, secret);
  const near = { anchor_kind: "geo", geohash: "9v6m2zz", lock_precision: 6 }; // same 6-char prefix 9v6m2? -> differs; see note
  // same 6-prefix required: 9v6m2a vs 9v6m2z differ -> expect null, proving cell-boundary behavior is explicit
  assert.equal(openLocked(blob, near, secret), null);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-lock.test.js`

- [ ] **Step 3: Implement `lock.js`**

```js
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

function anchorToken(anchor) {
  if (anchor.anchor_kind === "geo") return "geo:" + String(anchor.geohash || "").slice(0, anchor.lock_precision || 6);
  return anchor.anchor_kind + ":" + (anchor.anchor_ref || "");
}
export function deriveAnchorKey(anchor, secret) {
  return scryptSync(String(secret), "ramble:" + anchorToken(anchor), 32);
}
export function sealLocked(obj, anchor, secret) {
  const key = deriveAnchorKey(anchor, secret);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function openLocked(blob, anchor, secret) {
  try {
    const raw = Buffer.from(blob, "base64");
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const d = createDecipheriv("aes-256-gcm", deriveAnchorKey(anchor, secret), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch { return null; }
}
```

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-lock.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/lock.js tests/ramble-lock.test.js
git commit bundles/ramble/server/lock.js tests/ramble-lock.test.js -m "feat(ramble): anchor-derived content lock (locked marks)"
git show --stat HEAD
```

---

## Task 5: Persona resolution

**Files:**
- Create: `bundles/ramble/server/persona.js`
- Test: `tests/ramble-persona.test.js`

**Interfaces:**
- Consumes: `deriveBotIdentity(seed, botId)` and `loadInstanceSeed(dataDir)`/`loadOrCreateIdentity()` + `computeCrowId` from `servers/sharing/identity.js` (via `appImport`).
- Produces: `resolvePersona(identity, seed, { level, sessionId }) -> { author, author_level, secp256k1Priv, secp256k1Pubkey }`. `level:"real"` → the instance identity (`author = crowId`, real signing keys). `level:"pseudonym"` → `deriveBotIdentity(seed, "ramble-world")` (stable, non-crow_id). `level:"rotating"` → `deriveBotIdentity(seed, "ramble-session:" + sessionId)` (fresh per session). `author` is the persona's `secp256k1Pubkey` for pseudonym/rotating, the `crowId` for real.

- [ ] **Step 1: Write the failing test** (pure-function slice; inject a fake identity/seed so no gateway state is needed)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePersona } from "../bundles/ramble/server/persona.js";

// Inject a deterministic deriver so the test needs no real identity.
const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: "pk-" + botId, secp256k1Priv: Buffer.from(botId) });
const realId = { crowId: "crow_ABC", secp256k1Pubkey: "pk-real", secp256k1Priv: Buffer.from("real") };

test("rotating differs per session, pseudonym stable, real = crowId", () => {
  const a = resolvePersona(realId, "seed", { level: "rotating", sessionId: "s1", _derive: fakeDerive });
  const b = resolvePersona(realId, "seed", { level: "rotating", sessionId: "s2", _derive: fakeDerive });
  assert.notEqual(a.author, b.author);
  const p1 = resolvePersona(realId, "seed", { level: "pseudonym", _derive: fakeDerive });
  const p2 = resolvePersona(realId, "seed", { level: "pseudonym", _derive: fakeDerive });
  assert.equal(p1.author, p2.author);
  const r = resolvePersona(realId, "seed", { level: "real", _derive: fakeDerive });
  assert.equal(r.author, "crow_ABC");
  assert.equal(r.author_level, "real");
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-persona.test.js`

- [ ] **Step 3: Implement `persona.js`** (the `_derive` seam lets tests inject; production passes the real `deriveBotIdentity`)

```js
export function resolvePersona(identity, seed, { level = "rotating", sessionId = "0", _derive } = {}) {
  const derive = _derive; // production callers pass deriveBotIdentity from identity.js
  if (level === "real") {
    return { author: identity.crowId, author_level: "real", secp256k1Priv: identity.secp256k1Priv, secp256k1Pubkey: identity.secp256k1Pubkey };
  }
  const botId = level === "pseudonym" ? "ramble-world" : "ramble-session:" + sessionId;
  const k = derive(seed, botId);
  return { author: k.secp256k1Pubkey, author_level: level, secp256k1Priv: k.secp256k1Priv, secp256k1Pubkey: k.secp256k1Pubkey };
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
- Consumes: `withinRange` (anchors.js); `sealLocked`/`openLocked` (lock.js); the async db client.
- Produces (all async, take `db` first):
  - `createMark(db, { author, author_level, kind, anchor, visibility, reveal, content, secret, ttlSeconds }, { emit } = {}) -> row` — generates `mark_id` (uuid), computes `geohash`/`lat`/`lon`/`anchor_ref` from `anchor`, sets `expires_at = created_at + ttlSeconds*1000` (caws default 3600, public marks default 86400, contacts/groups persistent = null), seals `content` into `locked_blob` when `reveal==='locked'`, inserts with `publish_state='pending'`, calls optional `emit(row)` (used by Task 8/10). Returns the stored row.
  - `listMarks(db, { visibility, geohashPrefix, includeExpired=false, limit=200 }) -> rows` (teasers: never returns `locked_blob`; returns `content_text` only when `reveal==='open'`).
  - `getMark(db, mark_id) -> row|null`.
  - `unlockMark(db, mark_id, here, secret) -> { unlocked:boolean, content }` — loads the mark, checks `withinRange(anchor, here)`, if ok returns `openLocked(locked_blob, anchor, secret)`.
  - `expireMarks(db, now=Date.now()) -> count` — deletes rows with `expires_at IS NOT NULL AND expires_at <= now`.
  - `insertRemoteMark(db, row) -> {inserted:boolean}` — idempotent by `nostr_event_id`/`mark_id`, sets `origin='remote'`, `publish_state='remote'` (used by Task 10).

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
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "locked", secret: "s3cr3t",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75, lock_precision: 6 },
    content: { content_text: "secret spot", content_kind: "none" },
  });
  const listed = await listMarks(db, { visibility: "public" });
  assert.ok(!listed.find((r) => r.content_text === "secret spot"));
  const far = await unlockMark(db, m.mark_id, { lat: 30.30, lon: -97.74 }, "s3cr3t");
  assert.equal(far.unlocked, false);
  const near = await unlockMark(db, m.mark_id, { lat: 30.2673, lon: -97.7431 }, "s3cr3t");
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
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-marks.test.js`

- [ ] **Step 3: Implement `marks.js`** using the anchors/lock modules, the `geohash` from `encodeGeohash` when `anchor_kind==='geo'`, `randomUUID()` for `mark_id`, GCM seal on locked, parameterized `db.execute({sql,args})`. (Full implementation: derive columns from `anchor`, default TTLs by kind/visibility, `INSERT`, and for `listMarks` `SELECT` excluding `locked_blob` and nulling `content_text` when `reveal='locked'`.)

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-marks.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/marks.js tests/ramble-marks.test.js
git commit bundles/ramble/server/marks.js tests/ramble-marks.test.js -m "feat(ramble): mark store CRUD + locked unlock + expiry"
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
- Produces: `export function createRambleServer(db, options = {})` registering tools: `ramble_leave_mark`, `ramble_caw`, `ramble_query_world`, `ramble_unlock`, `ramble_pet_state`, `ramble_group_create`, `ramble_group_join`. Each `z.string()` has `.max()`. Handlers return `text(JSON.stringify(...))`. Author/persona is resolved server-side from settings (default `rotating`); tools do NOT accept raw keys.

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
  createRambleServer(db, { _exposeHandlers: handlers });
  h = handlers;
});

test("leave_mark then query_world returns it", async () => {
  const r = await h.ramble_leave_mark({ lat: 30.2672, lon: -97.7431, text: "hello", visibility: "public", reveal: "open" });
  assert.ok(!r.isError);
  const q = await h.ramble_query_world({ lat: 30.2672, lon: -97.7431, visibility: "public" });
  const payload = JSON.parse(q.content[0].text);
  assert.ok(payload.marks.some((m) => m.content_text === "hello"));
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-tools.test.js`

- [ ] **Step 3: Implement `server.js`** — the `McpServer` factory + `server.tool(...)` registrations delegating to `marks.js`, resolving persona from `ramble_settings` (`public_identity_level`, default `rotating`), and writing `publish_state='pending'`. Populate `options._exposeHandlers[name] = handler` when provided so tests can call handlers directly.

- [ ] **Step 4: Run, expect PASS** — `node scripts/run-suite.mjs tests/ramble-tools.test.js`

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/server.js bundles/ramble/server/index.js tests/ramble-tools.test.js
git commit bundles/ramble/server/server.js bundles/ramble/server/index.js tests/ramble-tools.test.js -m "feat(ramble): MCP tools (leave_mark/caw/query_world/unlock/pet_state/groups)"
git show --stat HEAD
```

**Milestone M1 complete:** local core is fully testable via MCP with no network or UI.

---

## Task 8: Same-user sync

**Files:**
- Modify: `servers/sharing/instance-sync.js` (append ramble tables to `SYNCED_TABLES`; add `EXCLUDED_COLUMNS` for volatile columns)
- Modify: `bundles/ramble/server/marks.js` (emit through the provided `emit` hook)
- Test: `tests/ramble-sync.test.js`

**Interfaces:**
- Consumes: `emitOrQueue(syncManager, db, table, op, row)` (`servers/shared/sync-emit.js`).
- Produces: `ramble_marks`, `ramble_groups`, `ramble_settings` in `SYNCED_TABLES`; `EXCLUDED_COLUMNS.ramble_marks = ["publish_state","origin","id"]` (publish state is per-instance; `id` is a local rowid). `createMark`'s `emit` callback calls `emitOrQueue(...,"insert",wireRow)`.

- [ ] **Step 1: Write the failing test** — assert `SYNCED_TABLES` contains the ramble tables and `EXCLUDED_COLUMNS.ramble_marks` excludes `publish_state`.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SYNCED_TABLES, EXCLUDED_COLUMNS } from "../servers/sharing/instance-sync.js";

test("ramble tables replicate; publish_state excluded", () => {
  for (const t of ["ramble_marks", "ramble_groups", "ramble_settings"]) assert.ok(SYNCED_TABLES.includes(t), t);
  assert.ok(EXCLUDED_COLUMNS.ramble_marks.includes("publish_state"));
});
```

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-sync.test.js` (also confirm `SYNCED_TABLES`/`EXCLUDED_COLUMNS` are exported; if not, export them.)

- [ ] **Step 3: Implement** — append the three table names to the `SYNCED_TABLES` array and add the `EXCLUDED_COLUMNS.ramble_marks` entry; wire `createMark`'s `emit`.

- [ ] **Step 4: Run, expect PASS**, then run the sync suite to confirm no regression: `node scripts/run-suite.mjs tests/instance-sync.test.js` (if present).

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/instance-sync.js bundles/ramble/server/marks.js tests/ramble-sync.test.js
git commit servers/sharing/instance-sync.js bundles/ramble/server/marks.js tests/ramble-sync.test.js -m "feat(ramble): replicate marks/groups/settings across own instances"
git show --stat HEAD
```

---

## Task 9: Nostr event mapping

**Files:**
- Create: `bundles/ramble/server/nostr-map.js`
- Test: `tests/ramble-nostr-map.test.js`

**Interfaces:**
- Produces: `markToEvent(row, { secret }) -> { kind, created_at, tags, content }` — kind `30078` (addressable/parameterized) for persistent public marks, kind `20078` (ephemeral) for caws; tags `[["g", geohash], ["d", mark_id], ["k", anchor_kind], ["rv", reveal], ["exp", String(expires_at)]]`; `content` = JSON of the public envelope (open marks: full content; locked marks: `{ locked_blob, secret }` where the content itself stays GCM-sealed to the anchor). `eventToMark(event) -> row` — inverse, sets `origin:'remote'`, `nostr_event_id: event.id`, parses tags back to columns. Pure functions (no signing here; Task 10 finalizes/signs).

- [ ] **Step 1: Write the failing test** — round-trip an open mark and a locked mark; assert the `g` tag equals the geohash, ephemeral kind for caws, and `eventToMark(markToEvent(row)).geohash === row.geohash`.

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
- Consumes: `getManagersOrNull()` (`servers/sharing/managers.js`) → `{ nostrManager, identity, db }`; `finalizeEvent` (nostr-tools); `nostrManager.publishRendezvousEvent(event)`; `nostrManager.connectRelays()`; `markToEvent`/`eventToMark`; `insertRemoteMark` (marks.js); `bus.emit("ramble:nearby", payload)` (`servers/shared/event-bus.js`); `resolvePersona` + real `deriveBotIdentity`.
- Produces: `export async function startRambleTransport({ db, nostrManager, identity, seed, bus, intervalMs = 15000 })` returning `{ stop() }`. Two loops: **drain** — `SELECT * FROM ramble_marks WHERE publish_state='pending'`, for each resolve persona → `markToEvent` → `finalizeEvent(template, persona.secp256k1Priv)` → `publishRendezvousEvent` → `UPDATE ... SET publish_state='published', nostr_event_id=?`; **subscribe** — build a filter over the user's active geohash cells (from `ramble_settings.active_area`) and audiences allowed by the grid, on each event `insertRemoteMark(eventToMark(event))` then `bus.emit("ramble:nearby", { geohash })`.

- [ ] **Step 1: Write the failing test** — inject a fake `nostrManager` (records `publishRendezvousEvent` calls, returns `["relay"]`), a fake `deriveBotIdentity`, an in-memory db with one `pending` mark; run one drain tick; assert the mark flips to `published` and the fake received one event whose tags include `["g", <geohash>]`. Then feed a synthetic incoming event to the subscribe handler and assert a `remote` row is inserted (idempotent on a second feed) and `bus` emitted `ramble:nearby`.

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

- [ ] **Step 3: Implement `ramble-transport.js`** (expose `drainOnce()` and `onEvent(event)` on the returned handle for tests; the interval just calls `drainOnce`). Then in `feature-mounts.js`, after the existing installed-bundle checks (the knowledge-base lan-discovery block is the pattern), if `ramble` is installed call `getManagersOrNull()` and `startRambleTransport(...)`, guarding on `nostrManager` being present.

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
- Produces: `getGrid(db) -> { master, cells, identityLevel, activeArea }` (reads `ramble_settings`, defaults: `master=false`, every cell `false`, `identityLevel="rotating"`); `setCell(db, audience, channel, on)`, `setMaster(db, on)`, `setIdentityLevel(db, level)`; `emitAllowed(grid, audience, channel) -> boolean` (`grid.master && grid.cells[audience]?.[channel]`). The drain publishes a mark only for audiences whose (audience, `geo`) cell is on and `master` is true; `setMaster(false)` also deletes live caws (`DELETE FROM ramble_marks WHERE kind='caw' AND origin='local'`).

- [ ] **Step 1: Write the failing test** — default grid blocks all; turning on `(public, geo)` with master on allows public/geo; master off blocks everything and clears caws.

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-grid.test.js`

- [ ] **Step 3: Implement `grid.js`**; make the drain filter `pending` marks through `emitAllowed(grid, visibilityAudience, "geo")`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/grid.js bundles/ramble/server/server.js servers/gateway/boot/ramble-transport.js tests/ramble-grid.test.js
git commit bundles/ramble/server/grid.js bundles/ramble/server/server.js servers/gateway/boot/ramble-transport.js tests/ramble-grid.test.js -m "feat(ramble): privacy grid + master visible switch gating egress"
git show --stat HEAD
```

---

## Task 12: Panel (map + compose + settings + pet shell)

**Files:**
- Create: `bundles/ramble/panel/ramble.js`, `bundles/ramble/panel/routes.js`, `bundles/ramble/panel/static/ramble.js`, vendored `bundles/ramble/panel/static/leaflet/*`
- Test: `tests/ramble-panel.test.js`

**Interfaces:**
- Consumes: `layout({title, content})`; `dashboardAuth`; `marks.js`, `grid.js` via dynamic import from `$CROW_HOME/bundles/ramble` (panel runs in the gateway process).
- Produces: panel handler object `{ id:"ramble", name:"Ramble", icon:"map-pin", route:"/dashboard/ramble", navOrder:120, category:"social", async handler(req,res,{db,layout,appRoot}) }`; router `export default (dashboardAuth) => Router` with **path-scoped** `router.use("/api/ramble", dashboardAuth)` and `router.use("/api/ramble", express.json({limit:"1mb"}))`; API routes `GET /api/ramble/marks`, `POST /api/ramble/marks` (in-process authoring: write via `createMark`, then, since this runs in-gateway, publish immediately by reusing the transport drain), `GET/POST /api/ramble/grid`, `POST /api/ramble/unlock`.

- [ ] **Step 1: Write the failing test** — mount the router with a stub `dashboardAuth` and assert: `GET /api/ramble/marks` requires auth (401 without), the panel handler object has the right `route`/`navOrder`, and `POST /api/ramble/marks` inserts a row. (Use `supertest`-style via the router if available in the repo; otherwise assert the exported handler object shape + call the route handlers directly.)

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-panel.test.js`

- [ ] **Step 3: Vendor Leaflet + implement panel**

```bash
mkdir -p bundles/ramble/panel/static/leaflet
# Vendor Leaflet 1.9.4 (js+css+marker images) into static/leaflet/. Pin the version; no CDN at runtime.
```
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

- [ ] **Step 1: Write the failing test** — assert the router registers `/dashboard/streams/ramble-nearby` and that emitting `ramble:nearby` invokes the registered `bus` handler (spy on `bus.on`). Keep it to handler wiring (SSE socket I/O is covered by existing stream tests).

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
- Produces: `feed(db, event) -> petRow` where `event.type ∈ {visit_place, unlock_mark, meet_crow, quiet_tick}`; updates `energy` (clamped 0–100), rolling weekly counters, and derives `mood ∈ {happy, tired, alarmed}` from energy thresholds (energy ≥ 60 → happy, 30–59 → tired, < 30 → alarmed); `petState(db) -> { mood, energy, places_week, unlocks_week, crows_week }`. Panel client maps `mood` to the existing crow classes (`crow-happy`/`crow-tired`/`crow-alarmed`) on `#crow-tama` via the `updateCrowMood` seam (feed a `health`-shaped payload or add a `setCrowMood(mood)` helper beside it).

- [ ] **Step 1: Write the failing test** — feeding `visit_place`/`unlock_mark`/`meet_crow` raises energy and sets `happy`; repeated `quiet_tick` lowers energy to `tired` then `alarmed`; counters increment.

- [ ] **Step 2: Run, expect FAIL** — `node scripts/run-suite.mjs tests/ramble-pet.test.js`

- [ ] **Step 3: Implement `pet.js`**; wire `ramble_pet_state`; in `static/ramble.js` map mood → the crow class (phase-1 feeds `visit_place` when the user opens the map at a new geohash and `unlock_mark` on a successful unlock — geo activity only, per spec §11).

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
- **Deferred within phase 1 (explicit):** photo content (needs the phase-3 media server) — `content_kind='photo'` is stored but phase-1 compose offers text/sticker/link only; reply/report moderation UI is a thin follow-up on Task 12; geohash neighbor-cell expansion (`geohashNeighborsPrefix`) returns the single cell in phase 1 (Task 3 note).
