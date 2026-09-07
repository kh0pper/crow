# Ramble Flock Phase 4 — AR Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen camera view on the Ramble map that labels every mark, caw and nest within ~500 m by bearing and distance, with the active bird composited at the bottom, a radar-strip fallback whenever the camera or the compass is missing, and two phase-3 carry items closed (a per-contact retention cap on inbound contacts marks; a two-transport multi-instance idempotency test).

**Architecture:** One new server module `around.js` answers "what is near this point" by reusing `listMarks` (rows as stored, teasers included) and `listNests`, adding only `distance_m`; one new route `GET /api/ramble/around` exposes it under the existing path-scoped `dashboardAuth`. One new plain script `panel/static/ramble-ar.js` is the renderer: `renderAr({ anchors, pose, bird, camera })` is a pure function from state to a frame (label positions as viewport fractions, radar dots, the bird's line) and `mountAr(els, opts)` paints a frame into the DOM with `textContent` only; it knows nothing about the map. The existing client `static/ramble.js` owns the devices (getUserMedia, watchPosition, deviceorientation), adapts server rows into anchors, and routes label taps into the SAME popup builders the map pins use. No new table, no schema bump, no new tool.

**Tech Stack:** Node 22 ESM, libsql client, Express router, plain-script panel client (classic scripts, no modules, no backticks), browser MediaDevices / Geolocation / DeviceOrientation APIs, Node built-in test runner via `scripts/run-suite.mjs`, `node:vm` to run the classic AR script in tests.

**Spec:** `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` — §3 (AR screen + header crow), §6 (AR mode, whole section), §7 (routes/tools/events), §8 (direction C tokens), §9 (camera frames never leave the device), §10 (AR component with a synthetic pose), §11 item 4. Phase-3 rulings that still bind: `docs/superpowers/plans/2026-09-07-ramble-flock-phase3-contacts-gifts-swaps.md` "## Global Constraints" + "## Review"; handoff `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase3-shipped-pr316.md`.

## Global Constraints

Phase-1/2/3 constraints still bind (copied, with the phase-4 deltas marked **[P4]**):

- **DB access:** bundle server code reaches the DB only through `server/app-root.js` → `appImport("servers/db.js")` / the bundle's `createDbClient()` (never a second SQLite driver in the gateway process). Client is async libsql-shaped: `await db.execute({ sql, args })`, `await db.executeMultiple(sql)`, `await db.batch([...])`.
- **No `SCHEMA_GENERATION` bump; no new table.** **[P4]** Phase 4 adds NO table and NO column. `init-tables.js` is not touched. If a replicated table ever appears in this phase it needs the full six sync touch points (`SYNCED_TABLES`, `EXCLUDED_COLUMNS`, `shouldSyncRow`, a natural-key apply handler, the `applyRemoteOp` seam + live dispatch, a `stampSql` branch) and both outbox-door and apply-door tests — none is expected. The core tables `contacts` / `contact_groups` / `contact_group_members` stay READ only.
- **Seeds are server-minted, immutable, never accepted from a client.** **[P4]** The AR view never sends a bird or a seed anywhere; it only draws the active bird it already has from `GET /api/ramble/pet`.
- **Credits are idempotent server-side** via `ramble_credits(kind, key)`. **[P4]** Nothing in the AR view credits anything directly: unlocks and claims go through the existing routes (`POST /api/ramble/unlock`, `POST /api/ramble/nests/claim`) which credit as before. Reading `/api/ramble/around` credits nothing (it is a read; `visit_place` stays on `POST /api/ramble/area` with `here`).
- **Warmth weights, `nest.rate`, `shelf.cap` are settings** read live. **[P4]** No new setting. `AROUND_RADIUS_DEFAULT = 500`, `AROUND_RADIUS_MIN = 50`, `AROUND_RADIUS_MAX = 1000` (metres) and `MAX_CONTACT_MARKS_PER_CONTACT = 50` are exported constants.
- **Shelf origin rulings (phase 2, unchanged):** only `shelf_origin = 'sync'` shelf eggs re-promote; NULL-origin beats `'sync'` in convergence; an explicit `null` on the wire means plain; a peer's user-shelve never triggers re-promotion; a hatched row never takes an origin. Received eggs are `status='received', shelf_origin='user'`, their own shelf class, off the claim cap. Gifts and trades are never grid-gated. All of a user's instances share one Nostr identity (`servers/sharing/nostr.js:155`), so every instance receives and applies every contact envelope and swap replies are duplicated-but-idempotent. **[P4]** Task 3 is the executable proof of that last ruling (two `startRambleTransport` instances over one injected bus + one manager stub).
- **Inbound ceilings:** `MAX_OPEN_PROPOSALS_PER_CONTACT = 20`, `MAX_GIFTS_PER_CONTACT_PER_DAY = 20` (phase 3). **[P4]** Contacts marks gain a RETENTION cap, not a per-day cap: `pruneContactMarks(db, author)` keeps the newest `MAX_CONTACT_MARKS_PER_CONTACT = 50` rows per contact (`author` = the contact's x-only pubkey, `origin='remote' AND visibility='contacts'`, newest by `created_at DESC, id DESC`). Ruling: `payloadToMark` takes `created_at` from the payload, so any per-local-day count keyed on it is the sender's clock to game; a retention count needs no clock. Remote rows never emit, so the prune is a plain DELETE. The block list stays the hard stop.
- **Anchors keep lat/lon/accuracy exactly as stored today.** **[P4]** `aroundPoint` returns `listMarks` rows unchanged (teasers via `reveal.js` strip lat/lon from locked marks; the route decodes the cell centre into `approx_lat/approx_lon/approx_m` exactly as `GET /api/ramble/marks` does, through the SAME `withApproxAnchor`) plus a `distance_m` per row. Nests come from `listNests(db, bbox, { from })` unchanged. A row with no exact anchor is located at its geohash cell centre and kept when the cell could hold a point inside the radius (distance to centre ≤ radius + the cell's half-diagonal); the client shows a 7-char teaser as a dashed directional label (`approx_m ≈ 101 m ≤ COARSE_M = 150`) and anything coarser (a 5-char wire caw, `approx_m ≈ 3.2 km`) as "somewhere in this area" with NO direction — never an invented position.
- **AR contract (spec §6, exact):** `renderAr({ anchors, pose, bird, camera })` → frame. `anchors[i] = { id, kind: "mark"|"caw"|"nest", lat, lon, accuracy_m, approx_m, locked, title }`; `pose = { lat, lon, accuracy_m, heading }` (`heading` in degrees clockwise from true north, or `null`); `bird = { species, seed, mood } | null`; `camera` optional boolean (default `true`; `false` after `getUserMedia` failed). `mode = "ar"` only when there is a fix AND a camera AND a heading; otherwise `"radar"` with `reason ∈ "no-fix" | "no-camera" | "no-heading"` — never a blank screen. Visible = `|bearing − heading| ≤ FOV_DEG/2 = 35°`; horizontal position `x = 0.5 + rel/FOV_DEG` (viewport fraction); others parked at `x = 0.06` (left) / `0.94` (right) stacked by distance rank, `PARK_MAX = 6` per side; vertical `y = 0.70 − 0.36·t` and `scale = 1 − 0.5·t` with `t = min(1, distance/RANGE_M)`, `RANGE_M = 500`. The frame is viewport-independent so Node tests need no DOM. The DOM painter `mountAr(els, { engine, onTap })` builds labels with `createElement` + `textContent`, draws the bird ONLY through `engine.mountBird` (the existing `RambleBird.mountBird` on an `<svg>`), and reacts (`rb-ar-react` class for 900 ms) when a label enters the visible set. A future WebXR renderer consumes the same state object.
- **Camera frames never leave the device (spec §9):** the `<video>` is a background and nothing else. Neither `static/ramble.js` nor `static/ramble-ar.js` may contain `toDataURL`, `toBlob`, `captureStream`, `ImageCapture`, `MediaRecorder`, `drawImage` or `getContext(` — `tests/ramble-panel.test.js` and `tests/ramble-ar.test.js` grep for all seven. The stream's tracks are stopped on close and while the tab is hidden (the view stays open and the camera restarts when the tab returns — ruling Q3).
- **Pose sources (spec §6, exact):** GPS via `navigator.geolocation.watchPosition` (high accuracy); heading via the `deviceorientationabsolute` event where the window has `ondeviceorientationabsolute`, else `deviceorientation` (iOS reports `webkitCompassHeading` there); `headingFromEvent(ev, screenAngle)` = `webkitCompassHeading` when present, else `360 − alpha + screenAngle` ONLY for an absolute event (`ev.absolute === true` or `ev.type === "deviceorientationabsolute"`), else `null`; smoothed with `smoothHeading(prev, next, 0.3)` across the 359→1 wrap. `getUserMedia` and iOS 13+ `DeviceOrientationEvent.requestPermission()` are BOTH called synchronously inside the user gesture that opens the view (the AR chip, or "Got it" on the notice), camera first, never after an awaited promise (ruling Q2); a refusal of either is the radar strip. A heading older than 5 s is dropped (`AR_HEADING_STALE_MS`) so a silent compass falls back to the ring; a `watchPosition` permission error clears the fix.
- **Limits stated in-UI on first open:** a notice card (`#rb-ar-notice`) gates the first open — nothing starts (no camera, no motion prompt) until "Got it" — and is remembered per browser under localStorage key `ramble.ar.limits` (`"1"`), read and written inside `try/catch`; storage failure means the notice shows every time, never a crash. Copy (exact, Task 6): direction and distance only, nothing sticks to surfaces; compass may be off by tens of degrees, hold the phone upright; iPhone asks once for motion access, a refusal means the radar strip; no camera or no compass means the radar strip; the camera picture stays on the phone.
- **Panel rules:** `router.use("/api/ramble", dashboardAuth)` path-scoped (never unpathed); client scripts `static/ramble.js` AND `static/ramble-ar.js` contain ZERO backticks; remote/user text is written with `textContent` only; the only `innerHTML`/`html:` sinks in `static/ramble.js` stay EXACTLY the two engine sinks (`el.innerHTML = Bird.drawEgg(` and `html: nestEggHtml(`) — the AR egg is drawn by the existing `drawEggArt` (the same sink, no new one) and the AR bird by `RambleBird.mountBird`; `static/ramble-ar.js` has ZERO sinks; never `express.static`; nothing under `PUBLIC_FUNNEL_PREFIXES`; every input bounded (regex/`.max`, enums); icons are inline SVG, never emoji; the AR script is a classic script (no `import`/`export`) so it runs under `vm.runInNewContext` in tests and as a plain `<script>` in the browser. **[P4]** No dead buttons: the map's AR chip opens the view; every AR label tap opens the SAME popup builder as its pin (`popupFor(mark)` → Unlock here / read text / share an invite; `nestPopup(nest)` → Take the egg), each of which posts to a real route.
- **Visual direction C tokens** only; reuse `rb-card`, `rb-step`, `rb-btn`, `rb-btn-ghost`, `rb-chip`, `rb-icon-btn`, `rb-sheet`, `rb-say`, `rb-eyebrow`, `rb-tag` — no new colours; the AR surfaces take the same tokens (`--rb-surface`, `--rb-line`, `--rb-accent-2`, `--rb-pop-sm`). Reduced motion disables the bird's reaction hop.
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` then `node scripts/run-suite.mjs tests/<file>.test.js` in the FOREGROUND (never bare `node --test`, never a backgrounded suite run). In-memory `createClient({ url: "file::memory:" })` from `@libsql/client` in TEST files only; bundle server files never import it. **NEVER boot a gateway or the MCP server from this worktree without a scratch `CROW_DATA_DIR`.** The docs en/es heading-parity test (`tests/ramble-panel.test.js`, last test) must stay green: every `##`/`###` added to `docs/guide/ramble.md` is mirrored in `docs/es/guide/ramble.md` in the same order and level.
- **Commits:** subject-only, positional paths (`git commit <paths> -m …`), `git add <new files>` FIRST for untracked files (positional commit refuses untracked paths), verify `git show --stat HEAD`, **no AI attribution trailers of any kind**. Work in `/home/kh0pp/crow-wt-flock4` (branch `feat/ramble-flock-phase4`, `node_modules` symlinked from `~/crow`), never `git checkout` a branch in `~/crow`. `main` is protected: PR + green `suite`/`static-checks`/`audit` check-runs on the head sha (public check-runs API via a small python script; no `gh` on crow — use the GitHub MCP tools for PR creation/merge).
- **Bundle version bump is mandatory:** `bundles/ramble/manifest.json` AND `bundles/ramble/package.json` go `0.4.0` → `0.5.0`; `npm run build-registry` regenerates `registry/add-ons.json`. Done in Task 8, before the PR. The installed copy refreshes `panel/` (including `panel/static/ramble-ar.js`) only on that bump (`refreshVersionedBundle`).
- **Deploy:** read `/home/kh0pp/CROW-SCHEDULE.md` first (house rule; the R24 chain may run through 2026-09-08 — gateway restarts start no model and are safe). Restart ALL THREE gateways back-to-back after merge (crow primary `crow-gateway.service`, `crow-r4-gateway.service`, grackle's `crow-gateway` after `git pull --ff-only origin main` in `~/crow` there; sudo needs the password). Verify grackle's journal shows `[bundles] refreshed ramble 0.4.0 -> 0.5.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered` (no new tool). Crow primary logs to `/var/log/crow-inference/gateway.log`, not the journal; the live db is `~/.crow/data/crow.db`.
- **Base:** branch from `main` at `a35fefd1` (PR #317 merge).

---

## File structure

**Create**
- `bundles/ramble/server/around.js` — `bboxAround`, `locate`, `aroundPoint(db, { lat, lon, radiusM, now })`, the radius constants.
- `bundles/ramble/panel/static/ramble-ar.js` — the AR renderer (pure `renderAr` + DOM `mountAr` + the pose helpers `bearingDeg`, `distanceM`, `relativeBearing`, `compassPoint`, `headingFromEvent`, `smoothHeading`, `layoutAnchor`).
- `tests/ramble-around.test.js`, `tests/ramble-ar.test.js`.

**Modify**
- `bundles/ramble/server/anchors.js` — `cellStepDegrees(precision)`, `cellsCoveringBbox(bbox, precision, { max })` (the precision-general form of `nests.js`'s `cellsInBbox`; nests.js is left as is).
- `bundles/ramble/server/trades.js` — `MAX_CONTACT_MARKS_PER_CONTACT`, `pruneContactMarks`, wired into `receiveEnvelope`'s mark branch (result gains `pruned`).
- `bundles/ramble/panel/routes.js` — `aroundMod` in `ensureLoaded`, `annotateMarks()` factored out of `GET /api/ramble/marks`, new `GET /api/ramble/around`.
- `bundles/ramble/panel/ramble.js` — the `ar` icon, the "Look around" chip in the map bar, the `#rb-ar` full-screen view (video, labels, radar strip, perch, notice), the `#rb-ar-sheet`, the `ramble-ar.js` script tag.
- `bundles/ramble/panel/static/ramble.js` — the `ar` section (devices, anchors adapter, taps → the pin popups, SSE hooks, close/teardown), `lastPet`.
- `bundles/ramble/panel/static/ramble.css` — the AR view rules.
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` (§6/§7/§9 amendments), `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- Tests: `ramble-anchors`, `ramble-trades`, `ramble-transport`, `ramble-panel`.

**Fixture geometry** (used by every test below; from `30.46, −98.08`, geohash-7 `9v6m21h`, geohash-5 `9v6m2`):
- 100 m north = `(30.460898, −98.08)`; 100 m east = `(30.46, −98.078958)`; 100 m south = `(30.459102, −98.08)`; 900 m north = `(30.4681, −98.08)`.
- One degree of latitude ≈ 111 320 m; one degree of longitude at this latitude ≈ 95 960 m.

---

## Task 1: `around.js` — everything near a point (marks as stored + nests), and the general cell cover

**Files:**
- Modify: `bundles/ramble/server/anchors.js` (append after `geohashNeighborsPrefix`)
- Create: `bundles/ramble/server/around.js`
- Test: `tests/ramble-anchors.test.js` (append), `tests/ramble-around.test.js` (new)

**Interfaces:**
- Consumes: `encodeGeohash`, `decodeGeohash`, `haversineMeters` (anchors.js); `listMarks(db, { cells, limit })` (marks.js, returns teasers for locked rows: no `lat`/`lon`, a `geohash`); `listNests(db, bbox, { now, from })` (flock.js, returns `{ week, nests: [{ cell, week, lat, lon, seed, claimed, distance_m }] }` nearest first, or `null` for a too-wide bbox).
- Produces: `cellStepDegrees(precision) → { latStep, lonStep }`; `cellsCoveringBbox(bbox, precision, { max = 64 }) → string[] | null`; `bboxAround({ lat, lon }, radiusM) → { south, west, north, east }`; `locate(row) → { lat, lon, err_m } | null`; `aroundPoint(db, { lat, lon, radiusM = 500, now }) → { here: { lat, lon }, radius_m, week, marks: [row + distance_m] (nearest first), nests: [nest] (nearest first, ≤ radius) }`; constants `AROUND_RADIUS_DEFAULT = 500`, `AROUND_RADIUS_MIN = 50`, `AROUND_RADIUS_MAX = 1000`.

- [ ] **Step 1: Write the failing anchors test (cell cover)**

Append to `tests/ramble-anchors.test.js` (its import is `{ encodeGeohash, decodeGeohash, haversineMeters, withinRange, saltedLanId }` from `../bundles/ramble/server/anchors.js` — extend that import with `cellStepDegrees, cellsCoveringBbox`, and add `import { cellsInBbox, CELL7_LAT_STEP, CELL7_LON_STEP } from "../bundles/ramble/server/nests.js";`):

```js
test("cellStepDegrees: 5 bits per char, longitude takes the odd bit (precision 7 matches nests.js)", () => {
  assert.deepEqual(cellStepDegrees(7), { latStep: CELL7_LAT_STEP, lonStep: CELL7_LON_STEP });
  const p6 = cellStepDegrees(6);
  assert.ok(Math.abs(p6.latStep - 180 / 2 ** 15) < 1e-12);
  assert.ok(Math.abs(p6.lonStep - 360 / 2 ** 15) < 1e-12);
  const p5 = cellStepDegrees(5);
  assert.ok(Math.abs(p5.latStep - 180 / 2 ** 12) < 1e-12);
  assert.ok(Math.abs(p5.lonStep - 360 / 2 ** 13) < 1e-12);
  assert.throws(() => cellStepDegrees(0));
  assert.throws(() => cellStepDegrees(13));
});

test("cellsCoveringBbox: precision 7 agrees with nests.js cellsInBbox; a ~1 km box is a handful of 5-char cells; too wide is null", () => {
  const bbox = { south: 30.4555, west: -98.0852, north: 30.4645, east: -98.0748 }; // ~1 km around 30.46/-98.08
  assert.deepEqual(cellsCoveringBbox(bbox, 7, { max: 8192 }), cellsInBbox(bbox));
  const five = cellsCoveringBbox(bbox, 5);
  assert.ok(five.includes("9v6m2"), "the point's own 5-char cell is in the cover");
  assert.ok(five.length >= 1 && five.length <= 4, `a 1 km box spans at most 2x2 5-char cells, got ${five.length}`);
  for (const c of five) assert.equal(c.length, 5);
  assert.equal(cellsCoveringBbox({ south: 0, west: 0, north: 10, east: 10 }, 7, { max: 64 }), null);
  assert.throws(() => cellsCoveringBbox({ south: 1, west: 0, north: 0, east: 1 }, 5));
  assert.throws(() => cellsCoveringBbox({ south: "a" }, 5));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/kh0pp/crow-wt-flock4 && export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && node scripts/run-suite.mjs tests/ramble-anchors.test.js`
Expected: FAIL — `cellStepDegrees` / `cellsCoveringBbox` are not exported.

- [ ] **Step 3: Implement the cover in anchors.js**

Append to `bundles/ramble/server/anchors.js`:

```js
/** Cell height/width in degrees at `precision`: 5 bits per character, longitude takes the odd bit. */
export function cellStepDegrees(precision) {
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) throw new Error("precision must be an integer 1..12");
  const bits = precision * 5;
  const lonBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { latStep: 180 / 2 ** latBits, lonStep: 360 / 2 ** lonBits };
}

/**
 * Every geohash cell at `precision` that intersects `bbox`, or null when the
 * cover would exceed `max` cells. The precision-general form of nests.js's
 * `cellsInBbox` (which is this at precision 7): sample a lattice one cell
 * apart — that hits every cell at least once — then keep a cell only if its
 * own bounds actually touch the box. Clamps at the poles/antimeridian; it
 * does not wrap across ±180.
 */
export function cellsCoveringBbox(bbox, precision, { max = 64 } = {}) {
  const { south, west, north, east } = bbox || {};
  if (![south, west, north, east].every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("bbox must be four finite numbers");
  }
  if (south > north || west > east) throw new Error("bbox must have south <= north and west <= east");
  const { latStep, lonStep } = cellStepDegrees(precision);
  const rows = Math.floor((north - south) / latStep) + 2;
  const cols = Math.floor((east - west) / lonStep) + 2;
  if (rows * cols > max) return null;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < rows; i++) {
    const lat = Math.min(90, Math.max(-90, south + i * latStep));
    for (let j = 0; j < cols; j++) {
      const lon = Math.min(180, Math.max(-180, west + j * lonStep));
      const cell = encodeGeohash(lat, lon, precision);
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
```

- [ ] **Step 4: Run the anchors test to verify it passes**

Run: `node scripts/run-suite.mjs tests/ramble-anchors.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Write the failing around test**

Create `tests/ramble-around.test.js`:

```js
/**
 * Phase 4 — around.js: everything the AR view can point at, around a point.
 * Rows come back AS STORED (teasers included) plus distance_m; a coarse row
 * is located at its cell centre and kept when the cell could hold a point in
 * range. No HTTP; the route's annotation (approx_lat, contact_name) is the
 * panel test's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, insertRemoteMark } from "../bundles/ramble/server/marks.js";
import { haversineMeters } from "../bundles/ramble/server/anchors.js";
import { isoWeek } from "../bundles/ramble/server/eggs.js";
import {
  AROUND_RADIUS_DEFAULT, AROUND_RADIUS_MIN, AROUND_RADIUS_MAX, bboxAround, locate, aroundPoint,
} from "../bundles/ramble/server/around.js";

const T0 = Date.UTC(2026, 8, 7, 12);
const HERE = { lat: 30.46, lon: -98.08 };
const NORTH_100 = { lat: 30.460898, lon: -98.08 };
const EAST_100 = { lat: 30.46, lon: -98.078958 };
const NORTH_900 = { lat: 30.4681, lon: -98.08 };
const PK = "ab".repeat(32);

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }
function mark(db, at, text, extra = {}) {
  return createMark(db, {
    author: PK, author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: at.lat, lon: at.lon, accuracy_m: 12 },
    content: { content_text: text, content_kind: "none" }, ...extra,
  });
}

test("bboxAround: a box that holds the circle, symmetric in metres", () => {
  const b = bboxAround(HERE, 500);
  assert.ok(Math.abs(haversineMeters(HERE, { lat: b.north, lon: HERE.lon }) - 500) < 2);
  assert.ok(Math.abs(haversineMeters(HERE, { lat: HERE.lat, lon: b.east }) - 500) < 2);
  assert.ok(b.south < HERE.lat && b.west < HERE.lon);
  const pole = bboxAround({ lat: 89.999, lon: 0 }, 1000);
  assert.equal(pole.north, 90, "clamped at the pole");
});

test("locate: an exact anchor has no error; a teaser sits at its cell centre with the half-diagonal as err_m; junk is null", () => {
  assert.deepEqual(locate({ lat: 1, lon: 2 }), { lat: 1, lon: 2, err_m: 0 });
  const t = locate({ geohash: "9v6m21h" });
  assert.ok(Math.abs(t.lat - 30.46) < 0.001 && Math.abs(t.lon + 98.08) < 0.001);
  assert.ok(t.err_m > 90 && t.err_m < 115, `7-char half-diagonal ~101 m, got ${t.err_m}`);
  const c = locate({ geohash: "9v6m2" });
  assert.ok(c.err_m > 3000 && c.err_m < 3600, `5-char half-diagonal ~3.4 km, got ${c.err_m}`);
  assert.equal(locate({}), null);
  assert.equal(locate({ geohash: "" }), null);
  assert.equal(locate({ geohash: "a!" }), null);
});

test("aroundPoint: marks within the radius nearest first with distance_m, rows as stored; a locked teaser rides its cell; out of range is dropped", async () => {
  const db = await freshDb();
  const near = await mark(db, NORTH_100, "near north");
  const east = await mark(db, EAST_100, "locked east", { reveal: "locked" });
  await mark(db, NORTH_900, "far north");
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  assert.deepEqual(out.here, HERE);
  assert.equal(out.radius_m, AROUND_RADIUS_DEFAULT);
  assert.deepEqual(out.marks.map((m) => m.mark_id), [near.mark_id, east.mark_id], "nearest first, the 900 m mark gone");
  const n = out.marks[0];
  assert.ok(Math.abs(n.distance_m - 100) <= 2, `distance ${n.distance_m}`);
  assert.deepEqual([n.lat, n.lon, n.accuracy_m, n.content_text], [NORTH_100.lat, NORTH_100.lon, 12, "near north"], "exactly as stored");
  const t = out.marks[1];
  assert.equal(t.content_text, undefined, "a locked row is still the teaser");
  assert.equal(t.lat, undefined);
  assert.equal(t.geohash, east.geohash);
  assert.ok(t.distance_m <= 250, `a teaser is measured to its cell centre (${t.distance_m} m)`);
  for (let i = 1; i < out.marks.length; i++) assert.ok(out.marks[i].distance_m >= out.marks[i - 1].distance_m);
});

test("aroundPoint: a coarse wire caw (5-char cell) is kept because its cell could hold a point in range; a coarse cell elsewhere is not", async () => {
  const db = await freshDb();
  await insertRemoteMark(db, { mark_id: "caw-here", author: "cd".repeat(32), kind: "caw", anchor_kind: "geo", geohash: "9v6m2", visibility: "public", reveal: "open", content_text: "hello", created_at: T0, nostr_event_id: "e1" });
  await insertRemoteMark(db, { mark_id: "caw-far", author: "cd".repeat(32), kind: "caw", anchor_kind: "geo", geohash: "9v6m8", visibility: "public", reveal: "open", content_text: "far", created_at: T0, nostr_event_id: "e2" });
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  const ids = out.marks.map((m) => m.mark_id);
  assert.ok(ids.includes("caw-here"));
  assert.ok(!ids.includes("caw-far"));
  const c = out.marks.find((m) => m.mark_id === "caw-here");
  assert.equal(c.lat, null, "no position was invented for it");
  assert.equal(typeof c.distance_m, "number");
});

test("aroundPoint: this week's nests within the radius, nearest first; the radius clamps to 50..1000", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('nest.rate', '1')", args: [] });
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  assert.equal(out.week, isoWeek(T0));
  assert.ok(out.nests.length >= 1, "rate 1 puts a nest in every cell, so the user's own cell has one within ~110 m");
  for (const n of out.nests) {
    assert.ok(n.distance_m <= 500);
    assert.ok(typeof n.cell === "string" && n.cell.length === 7 && typeof n.seed === "number" && n.claimed === false);
  }
  for (let i = 1; i < out.nests.length; i++) assert.ok(out.nests[i].distance_m >= out.nests[i - 1].distance_m);
  const wide = await aroundPoint(db, { ...HERE, radiusM: 5000, now: T0 });
  assert.equal(wide.radius_m, AROUND_RADIUS_MAX);
  assert.ok(wide.nests.length >= out.nests.length);
  const tight = await aroundPoint(db, { ...HERE, radiusM: 1, now: T0 });
  assert.equal(tight.radius_m, AROUND_RADIUS_MIN);
});

test("aroundPoint: works at high latitude (the cover grows with 1/cos) and refuses the pole rather than scanning the table", async () => {
  const db = await freshDb();
  await mark(db, { lat: 85.0009, lon: 10 }, "arctic north");
  const far = await aroundPoint(db, { lat: 85, lon: 10, now: T0 });
  assert.deepEqual(far.marks.map((m) => m.content_text), ["arctic north"], "the fine cover overflowed; the coarse pass still answers");
  assert.equal(far.radius_m, AROUND_RADIUS_DEFAULT);
  await assert.rejects(aroundPoint(db, { lat: 89.9, lon: 10, now: T0 }), (err) => err.code === "too-wide");
  await assert.rejects(aroundPoint(db, { lat: 90, lon: 0, now: T0 }), (err) => err.code === "too-wide");
});

test("aroundPoint: a nearby mark is never starved by newer marks elsewhere in the same coarse cell (the fine cover answers first)", async () => {
  const db = await freshDb();
  const near = await mark(db, NORTH_100, "near north");
  // 600 newer marks 3 km north: same 5-char cell (9v6m2 spans 30.454..30.498), out of range.
  const stmts = [];
  for (let i = 0; i < 600; i++) {
    stmts.push({
      sql: `INSERT INTO ramble_marks (mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, accuracy_m, visibility, reveal, content_text, content_kind, created_at, publish_state, origin)
            VALUES (?, ?, 'rotating', 'mark', 'geo', ?, ?, ?, 5, 'public', 'open', ?, 'none', ?, 'published', 'remote')`,
      args: ["crowd-" + i, PK, "9v6m3", 30.487, -98.08, "crowd " + i, T0 + 1000 + i],
    });
  }
  await db.batch(stmts);
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  assert.deepEqual(out.marks.map((m) => m.mark_id), [near.mark_id]);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node scripts/run-suite.mjs tests/ramble-around.test.js`
Expected: FAIL — `Cannot find module '.../server/around.js'`.

- [ ] **Step 7: Create around.js**

Create `bundles/ramble/server/around.js`:

```js
/**
 * Ramble around — everything the AR view can point at, around a point
 * (spec §6): marks and caws from `ramble_marks` and this week's nests,
 * within `radiusM` of `here`.
 *
 * Rows are returned AS STORED — `listMarks` teasers included, so a locked
 * mark still carries no lat/lon here (the route decodes the cell centre into
 * approx_lat/approx_lon exactly as the map does). This module only adds
 * `distance_m` and drops what is out of range.
 *
 * A row with no exact anchor is located at its geohash cell centre and kept
 * when the CELL could hold a point inside the radius (distance to the centre
 * <= radius + the cell's half-diagonal). A 7-char teaser therefore measures
 * ~100 m at worst; a 5-char wire caw whose cell covers the user is listed
 * rather than given an invented position — the client shows those without a
 * direction.
 */
import { decodeGeohash, haversineMeters, cellsCoveringBbox } from "./anchors.js";
import { listMarks } from "./marks.js";
import { listNests } from "./flock.js";

export const AROUND_RADIUS_DEFAULT = 500;
export const AROUND_RADIUS_MIN = 50;
export const AROUND_RADIUS_MAX = 1000;
/**
 * Two covers, because `listMarks` matches by geohash PREFIX and the rows come
 * in two grains: marks with an exact anchor are stored at geohash-7, wire
 * caws only at their 5-char publish cell.
 *   fine   — the precision-7 cells the circle touches (~72 for 500 m): every
 *            exact-anchor row in range, and nothing outside the box, so the
 *            query's LIMIT can never starve a nearby mark;
 *   coarse — the precision-5 cells (1–4): only rows whose OWN geohash is that
 *            coarse are taken from this pass (the caws); everything finer was
 *            already answered by the fine pass.
 * Past ~84° latitude the fine cover overflows MAX_FINE_CELLS and the coarse
 * pass alone answers (bounded by LIST_LIMIT — accepted, nobody rambles there);
 * when even the coarse cover overflows the call is refused (`too-wide`).
 */
const FINE_PRECISION = 7;
const MAX_FINE_CELLS = 512;
const COVER_PRECISION = 5;
const MAX_COVER_CELLS = 64;
const LIST_LIMIT = 500;
const M_PER_DEG_LAT = 111320;

/** A bbox that contains the circle of `radiusM` around `here` (clamped, never wrapped). */
export function bboxAround(here, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT;
  // The floor only stops a division by zero AT the pole; a larger floor would
  // make the box too NARROW near it and silently miss marks east/west.
  const cosLat = Math.max(1e-6, Math.cos((here.lat * Math.PI) / 180));
  const dLon = radiusM / (M_PER_DEG_LAT * cosLat);
  return {
    south: Math.max(-90, here.lat - dLat),
    north: Math.min(90, here.lat + dLat),
    west: Math.max(-180, here.lon - dLon),
    east: Math.min(180, here.lon + dLon),
  };
}

/** Where a stored row is, for distance: the exact anchor, else the cell centre plus its half-diagonal as `err_m`. */
export function locate(row) {
  if (typeof row.lat === "number" && typeof row.lon === "number") return { lat: row.lat, lon: row.lon, err_m: 0 };
  if (typeof row.geohash !== "string" || row.geohash.length === 0) return null;
  try {
    const { lat, lon, latErr, lonErr } = decodeGeohash(row.geohash);
    return { lat, lon, err_m: haversineMeters({ lat, lon }, { lat: lat + latErr, lon: lon + lonErr }) };
  } catch {
    return null;
  }
}

export async function aroundPoint(db, { lat, lon, radiusM = AROUND_RADIUS_DEFAULT, now = Date.now() } = {}) {
  const here = { lat, lon };
  const radius = Math.min(AROUND_RADIUS_MAX, Math.max(AROUND_RADIUS_MIN, Number(radiusM) || AROUND_RADIUS_DEFAULT));
  const bbox = bboxAround(here, radius);
  const coarseCells = cellsCoveringBbox(bbox, COVER_PRECISION, { max: MAX_COVER_CELLS });
  if (!coarseCells) {
    // An empty `cells` would make listMarks drop the cell filter and scan the
    // newest 500 rows of the whole table — a wrong answer, not a slow one.
    const err = new Error("too far north or south for the AR view");
    err.code = "too-wide";
    throw err;
  }
  const fineCells = cellsCoveringBbox(bbox, FINE_PRECISION, { max: MAX_FINE_CELLS });
  const seen = new Set();
  const marks = [];
  const consider = (row) => {
    if (seen.has(row.mark_id)) return;
    const at = locate(row);
    if (!at) return;
    const d = haversineMeters(here, at);
    if (d > radius + at.err_m) return;
    seen.add(row.mark_id);
    marks.push({ ...row, distance_m: Math.round(d) });
  };
  if (fineCells) {
    for (const row of await listMarks(db, { cells: fineCells, limit: LIST_LIMIT })) consider(row);
  }
  for (const row of await listMarks(db, { cells: coarseCells, limit: LIST_LIMIT })) {
    // With a fine pass, only the coarse rows are new here; without one (high
    // latitude) everything is.
    if (fineCells && (typeof row.geohash !== "string" || row.geohash.length > COVER_PRECISION)) continue;
    consider(row);
  }
  marks.sort((a, b) => a.distance_m - b.distance_m);
  const nestsOut = await listNests(db, bbox, { now, from: here });
  const nests = (nestsOut?.nests ?? []).filter((n) => n.distance_m <= radius);
  return { here, radius_m: radius, week: nestsOut?.week ?? null, marks, nests };
}
```

- [ ] **Step 8: Run the around test to verify it passes**

Run: `node scripts/run-suite.mjs tests/ramble-around.test.js`
Expected: PASS (7 tests). If "caw-far" leaks in: `9v6m8` is the cell two rows north of `9v6m2` (centre ~30.52, 6.8 km away) and must fail `d > radius + err_m` (500 + ~3400 < 6600).

- [ ] **Step 9: Commit**

```bash
cd /home/kh0pp/crow-wt-flock4
git add bundles/ramble/server/around.js tests/ramble-around.test.js
git commit bundles/ramble/server/anchors.js bundles/ramble/server/around.js tests/ramble-anchors.test.js tests/ramble-around.test.js -m "ramble around: marks and nests near a point, rows as stored; general geohash cell cover"
git show --stat HEAD
```

---

## Task 2: Retention cap on inbound contacts marks per contact (phase-3 carry item a)

**Files:**
- Modify: `bundles/ramble/server/trades.js` (constants block after `MAX_GIFTS_PER_CONTACT_PER_DAY`; a new `pruneContactMarks` before `/* ---- inbound router */`; `receiveEnvelope`'s `ramble.mark` branch; the marks.js import gains `getMark`)
- Modify: `servers/gateway/boot/ramble-transport.js` (`onEnvelope`: no `ramble:nearby` for a `gone` mark)
- Test: `tests/ramble-trades.test.js` (append), `tests/ramble-transport.test.js` (append)

**Interfaces:**
- Consumes: `insertRemoteMark(db, row) → { inserted, row }`, `getMark(db, mark_id)` (marks.js); `xOnly(pubkey)` (persona.js).
- Produces: `MAX_CONTACT_MARKS_PER_CONTACT = 50`; `pruneContactMarks(db, author, max = MAX_CONTACT_MARKS_PER_CONTACT) → number` (rows deleted); `receiveEnvelope` mark result gains `pruned: number` and `gone: boolean` (the row it just inserted was itself pruned — an old re-delivered mark); the transport skips the `ramble:nearby` poke when `gone` (the meet_crow credit still happens: they did meet).

- [ ] **Step 1: Write the failing test**

Append to `tests/ramble-trades.test.js` (extend its import from `../bundles/ramble/server/trades.js` with `MAX_CONTACT_MARKS_PER_CONTACT, pruneContactMarks`, and add `import { insertRemoteMark } from "../bundles/ramble/server/marks.js";`):

```js
test("phase 4: a contact's marks are bounded by retention — the newest 50 stay, older ones go; other authors and public rows untouched", async () => {
  const db = await freshDb();
  const PK2 = "ac".repeat(32);
  const envelope = (i, pk, tag) => ({
    crowId: "crow:" + tag, pubkey: pk, eventId: tag + "-" + i,
    payload: { type: "ramble.mark", v: 1, mark: { mark_id: tag + "-" + i, kind: i % 2 ? "caw" : "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, reveal: "open", content_text: "n" + i, content_kind: "none", created_at: T0 + i * 1000 } },
  });
  const count = async (pk) => Number((await db.execute({ sql: "SELECT count(*) AS n FROM ramble_marks WHERE author = ?", args: [pk] })).rows[0].n);
  let last = null;
  for (let i = 0; i < 55; i++) { last = await receiveEnvelope(db, envelope(i, PK, "F"), { now: T0 }); assert.equal(last.inserted, true); }
  assert.equal(await count(PK), MAX_CONTACT_MARKS_PER_CONTACT);
  assert.equal(last.pruned, 1, "the 51st and later deliveries each prune one");
  const oldest = (await db.execute({ sql: "SELECT min(created_at) AS t FROM ramble_marks WHERE author = ?", args: [PK] })).rows[0].t;
  assert.equal(Number(oldest), T0 + 5 * 1000, "the five oldest by created_at went");
  // Another contact and a public row by the same key are not part of the count.
  await receiveEnvelope(db, envelope(0, PK2, "G"), { now: T0 });
  assert.equal(await count(PK2), 1);
  await insertRemoteMark(db, { mark_id: "pub-F", author: PK, kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, visibility: "public", reveal: "open", content_text: "public", created_at: T0, nostr_event_id: "pub-ev" });
  const again = await receiveEnvelope(db, envelope(55, PK, "F"), { now: T0 });
  assert.equal(again.pruned, 1);
  assert.equal(await count(PK), MAX_CONTACT_MARKS_PER_CONTACT + 1, "50 contacts marks + the public one");
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_marks WHERE mark_id = 'pub-F'")).rows[0].n, 1);
  // A re-delivery inserts nothing and prunes nothing.
  const dup = await receiveEnvelope(db, envelope(55, PK, "F"), { now: T0 });
  assert.deepEqual([dup.inserted, dup.pruned, dup.gone], [false, 0, false]);
  // An OLD mark re-sent under a new event id (its row was pruned earlier) is
  // inserted and immediately pruned again: it reports `gone` so the caller
  // does not announce a mark that no longer exists.
  const stale = await receiveEnvelope(db, envelope(-100, PK, "F"), { now: T0 });
  assert.deepEqual([stale.inserted, stale.pruned, stale.gone], [true, 1, true]);
  assert.equal(await count(PK), MAX_CONTACT_MARKS_PER_CONTACT + 1, "still 50 contacts marks + the public one");
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_marks WHERE mark_id = 'F--100'")).rows[0].n, 0);
  // Direct call with a bad author is a no-op.
  assert.equal(await pruneContactMarks(db, ""), 0);
  assert.equal(await pruneContactMarks(db, PK2, 0), 1, "max 0 empties that contact");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/run-suite.mjs tests/ramble-trades.test.js`
Expected: FAIL — `MAX_CONTACT_MARKS_PER_CONTACT` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement the prune**

In `bundles/ramble/server/trades.js`, after `export const MAX_GIFTS_PER_CONTACT_PER_DAY = 20;` add:

```js
/**
 * Retention ceiling for contacts marks per contact (phase 4, carried from
 * phase 3): past it the OLDEST rows go. A per-day cap keyed on `created_at`
 * would be the sender's clock to game (payloadToMark takes it from the
 * payload); a retention count needs no clock. The block list stays the
 * hard stop.
 */
export const MAX_CONTACT_MARKS_PER_CONTACT = 50;
```

Before the `/* --------------------------------------------------------- inbound router */` banner add:

```js
/* ----------------------------------------------------------- retention */

/**
 * Keep only the newest `max` contacts-delivered marks by `author` (their
 * x-only pubkey). Remote rows never emit (they were never ours to sync), so
 * this is a plain delete. Returns how many rows went.
 */
export async function pruneContactMarks(db, author, max = MAX_CONTACT_MARKS_PER_CONTACT) {
  if (typeof author !== "string" || author.length === 0) return 0;
  const keep = Number.isInteger(max) && max >= 0 ? max : MAX_CONTACT_MARKS_PER_CONTACT;
  const { rowsAffected } = await db.execute({
    sql: `DELETE FROM ramble_marks
           WHERE author = ? AND origin = 'remote' AND visibility = 'contacts'
             AND id NOT IN (SELECT id FROM ramble_marks
                             WHERE author = ? AND origin = 'remote' AND visibility = 'contacts'
                             ORDER BY created_at DESC, id DESC LIMIT ?)`,
    args: [author, author, keep],
  });
  return Number(rowsAffected) || 0;
}
```

Change the marks.js import at the top of trades.js to `import { insertRemoteMark, getMark } from "./marks.js";`.

In `receiveEnvelope`, replace the `ramble.mark` branch's last two lines:

```js
    const r = await insertRemoteMark(db, row);
    return { kind: "mark", inserted: !!r.inserted, row: r.row ?? null, geohash: row.geohash, mark_id: row.mark_id, markKind: row.kind };
```

with:

```js
    const r = await insertRemoteMark(db, row);
    // Phase 4: a contact who floods marks is bounded by retention, not by
    // their own created_at. Only an actual insert can push the count over.
    // insertRemoteMark dedups on (nostr_event_id OR mark_id), so an old mark
    // re-sent under a NEW event id after its row was pruned is inserted and
    // pruned again in the same call — `gone` says so, so the transport does
    // not announce a mark that is not there.
    const pruned = r.inserted ? await pruneContactMarks(db, author) : 0;
    const gone = pruned > 0 && !(await getMark(db, row.mark_id));
    return { kind: "mark", inserted: !!r.inserted, row: r.row ?? null, geohash: row.geohash, mark_id: row.mark_id, markKind: row.kind, pruned, gone };
```

In `servers/gateway/boot/ramble-transport.js`, `onEnvelope`, change the mark branch's first inner `try` so the nearby poke is skipped for a gone row (the credit block below it is unchanged — meeting the contact still counts):

```js
      if (result.kind === "mark" && result.inserted) {
        if (!result.gone) {
          try {
            bus.emit("ramble:nearby", { geohash: result.geohash, mark_id: result.mark_id, kind: result.markKind });
          } catch (emitErr) {
            console.warn("[ramble] ramble:nearby subscriber threw:", emitErr?.message ?? emitErr);
          }
        }
```

(the block above already carries the one extra `}` that closes `if (!result.gone)`; the `try { await feedAll(… meet_crow …) }` block that follows is unchanged). Append to `tests/ramble-transport.test.js`, after the phase-3 inbound-mark test:

```js
test("phase 4: a re-sent mark that is pruned on arrival credits meet_crow but pokes no ramble:nearby", async () => {
  const h = await makeHarness();
  const nearby = [];
  h.bus.on("ramble:nearby", (p) => nearby.push(p));
  const mk = (i) => ({ mark_id: "flood-" + i, kind: "mark", anchor_kind: "geo", geohash: FULL_GEOHASH, lat: LAT, lon: LON, reveal: "open", content_text: "n" + i, content_kind: "none", created_at: 1700000000000 + i * 1000 });
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    await h.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark: mk(i) }, eventId: "fl-" + i });
  }
  assert.equal(nearby.length, 50);
  await h.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark: mk(-5) }, eventId: "fl-old" });
  assert.equal(nearby.length, 50, "an old mark pruned on arrival is not announced");
  assert.equal(await getMark(h.db, "flood--5"), null);
  const { rows } = await h.db.execute({ sql: "SELECT count(*) AS n FROM ramble_marks WHERE author = ?", args: [PK] });
  assert.equal(Number(rows[0].n), 50);
});
```

Update the module header's list of caps (the sentence "Inbound ceilings per contact (review round 1, S2)") is a comment on the constants — leave it; the new constant carries its own comment.

- [ ] **Step 4: Run the trades and transport tests to verify they pass**

Run: `node scripts/run-suite.mjs tests/ramble-trades.test.js tests/ramble-transport.test.js`
Expected: PASS (the existing `receiveEnvelope` routing test asserts specific fields, not the whole object, so the extra `pruned`/`gone` keys are fine; the `payloadToMark → null` early return `{ kind: "mark", inserted: false }` is untouched and its whole-object `deepEqual` still holds).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/trades.js servers/gateway/boot/ramble-transport.js tests/ramble-trades.test.js tests/ramble-transport.test.js -m "ramble trades: keep the newest 50 contacts marks per contact; no nearby poke for a mark pruned on arrival"
git show --stat HEAD
```

---

## Task 3: Two-transport multi-instance idempotency test (phase-3 carry item b)

**Files:**
- Test: `tests/ramble-transport.test.js` (refactor `makeHarness` to accept a shared bus and manager; one new test at the end)

**Interfaces:**
- Consumes: `startRambleTransport` (core), `proposeSwap`, `acceptSwap` (trades.js — add `acceptSwap` to the existing import line), `seedContacts`, `PK` (already in the file).
- Produces: `makeManager() → { nostrManager, published, sent, closedSubs, state, relay }`; `makeHarness({ shouldPublish, autoStart, emit, bus, manager })` — every existing field of the returned harness (`db, bus, published, sent, closedSubs, state, transport, relay`) is unchanged.

- [ ] **Step 1: Refactor the harness (no behaviour change)**

In `tests/ramble-transport.test.js`, replace the WHOLE `makeHarness` (its JSDoc through its closing `}`) with the two functions below, so the relay/manager stub lives in its own factory. The `relay`, `nostrManager` and `state` objects are the current ones, moved verbatim; the `db.executeMultiple` core-table DDL and the returned fields are unchanged:

```js
/** The scriptable relay/publisher stub, on its own so two transports can share one (Task 3, phase 4). */
function makeManager() {
  const published = [];
  const sent = [];
  const closedSubs = [];
  const state = { accept: true, throwErr: null, delayMs: 0 };
  const relay = {
    connected: true,
    connect: async () => {},
    // Minimal nostr-tools Relay surface makeResilientSub touches.
    subscribe: () => {
      const handle = { close: () => closedSubs.push(handle) };
      return handle;
    },
  };
  const nostrManager = {
    relays: new Map([["wss://fake", relay]]),
    connectRelays: async () => [],
    publishRendezvousEvent: async (event) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.throwErr) throw new Error(state.throwErr);
      published.push(event);
      return state.accept ? ["wss://fake"] : [];
    },
    sendControl: async (contact, content) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.throwErr) throw new Error(state.throwErr);
      sent.push({ contact, content: JSON.parse(content) });
      return { eventId: "ctl-" + sent.length, relays: state.accept ? ["wss://fake"] : [] };
    },
  };
  return { nostrManager, published, sent, closedSubs, state, relay };
}

/**
 * A fresh db + bus + transport with a scriptable relay/publisher.
 * `state` is mutable mid-test: `accept` (does a relay take the event),
 * `throwErr` (publish rejects), `delayMs` (publish is slow — for re-entrancy).
 * `bus` / `manager` may be injected so two "instances" share one identity's
 * inbound door and one outbound sink (phase 4, Task 3).
 */
async function makeHarness({ shouldPublish, autoStart = false, emit, bus: sharedBus, manager } = {}) {
  const db = createClient({ url: "file::memory:" });
  const bus = sharedBus ?? new EventEmitter();
  const m = manager ?? makeManager();
  const transport = await startRambleTransport({
    db, nostrManager: m.nostrManager, identity, seed: SEED, bus,
    bundleDir: BUNDLE_DIR,
    _derive: fakeDerive,
    shouldPublish,
    autoStart,
    ...(emit ? { emit } : {}),
  });
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);`);
  return { db, bus, published: m.published, sent: m.sent, closedSubs: m.closedSubs, state: m.state, transport, relay: m.relay };
}
```

Run: `node scripts/run-suite.mjs tests/ramble-transport.test.js` — Expected: PASS, same count as before (pure refactor).

- [ ] **Step 2: Write the failing two-transport test**

Append to `tests/ramble-transport.test.js` (add `acceptSwap` to the trades.js import):

```js
/** Copy whole rows between two in-memory dbs — the test's stand-in for instance sync. */
async function copyRows(from, to, table, cols) {
  const { rows } = await from.execute({ sql: `SELECT ${cols.join(", ")} FROM ${table}`, args: [] });
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await to.execute({ sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => r[c] ?? null) });
  }
}

test("phase 4: two of a user's instances over one bus and identity both apply one 'accepted'; the counterpart applies the duplicate replies once", async () => {
  // Round-2 Q1 (phase 3): all of a user's instances share one Nostr identity
  // (servers/sharing/nostr.js:155), so ONE DM from a contact is decrypted by
  // every instance's contact subscription. Modelled here as one bus emit two
  // transports hear, and one sendControl sink both reply through.
  const shared = makeManager();
  const bus = new EventEmitter();
  const A1 = await makeHarness({ bus, manager: shared });
  const A2 = await makeHarness({ bus, manager: shared });
  const B = await makeHarness();
  for (const h of [A1, A2, B]) await seedContacts(h.db);
  const now = Date.now();

  await A1.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('mine','shelf','user',3,?)", args: [now] });
  const p = await proposeSwap(A1.db, { eggId: "mine", toCrowId: "crow:one", now });
  assert.equal(p.ok, true);
  // "Instance sync": A2 holds the same egg and trade rows; only the authoring instance holds outbox rows.
  await copyRows(A1.db, A2.db, "ramble_eggs", ["egg_id", "status", "shelf_origin", "warmth", "found_cell", "found_week", "from_crow_id", "created_at"]);
  await copyRows(A1.db, A2.db, "ramble_trades", ["trade_id", "counterpart", "role", "my_egg_id", "their_egg_id", "offer_json", "state", "created_at", "updated_at", "expires_at"]);

  await A1.transport.drainOnce();
  await A2.transport.drainOnce();
  assert.equal(shared.sent.length, 1, "only the authoring instance sends the proposal");
  assert.equal(shared.sent[0].content.trade.state, "proposed");

  // B receives the proposal, answers with its own egg; its 'accepted' goes out once.
  await B.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, eventId: "prop-1", payload: shared.sent[0].content });
  await B.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('theirs','shelf','user',8,?)", args: [now] });
  assert.equal((await acceptSwap(B.db, { tradeId: p.trade.trade_id, eggId: "theirs", now })).ok, true);
  await B.transport.drainOnce();
  assert.equal(B.sent.length, 1);
  const accepted = B.sent[0].content;
  assert.equal(accepted.trade.state, "accepted");

  // ONE DM reaches the user; both instances hear it, each completes and each replies.
  const tradeEvents = [];
  bus.on("ramble:trade", (e) => tradeEvents.push(e));
  bus.emit("ramble:envelope", { crowId: "crow:one", contactId: 1, pubkey: PK, payload: accepted, eventId: "acc-1" });
  for (let i = 0; i < 300 && shared.sent.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(shared.sent.length, 3, "the proposal plus one 'completed' from EACH instance");
  for (const h of [A1, A2]) {
    const t = (await h.db.execute({ sql: "SELECT state, their_egg_id FROM ramble_trades WHERE trade_id = ?", args: [p.trade.trade_id] })).rows[0];
    assert.deepEqual([t.state, t.their_egg_id], ["completed", "theirs"]);
    const eggs = (await h.db.execute("SELECT egg_id, status FROM ramble_eggs ORDER BY egg_id")).rows.map((r) => [r.egg_id, r.status]);
    assert.deepEqual(eggs, [["mine", "gifted"], ["theirs", "received"]], "one completed trade and one egg per instance");
    assert.equal((await pendingDeliveries(h.db, 50)).length, 0, "each instance's reply drained");
  }
  assert.equal(tradeEvents.filter((e) => e.state === "completed").length, 2, "one ramble:trade per instance");

  // B receives BOTH copies (two real DMs, two event ids); the second changes nothing.
  const bEvents = [];
  B.bus.on("ramble:trade", (e) => bEvents.push(e));
  const replies = shared.sent.slice(1).map((s) => s.content);
  assert.deepEqual(replies.map((r) => r.trade.state), ["completed", "completed"]);
  await B.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, eventId: "done-1", payload: replies[0] });
  await B.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, eventId: "done-2", payload: replies[1] });
  assert.equal(bEvents.length, 1, "the duplicate completion is a no-op");
  assert.equal((await B.db.execute({ sql: "SELECT state FROM ramble_trades WHERE trade_id = ?", args: [p.trade.trade_id] })).rows[0].state, "completed");
  const bEggs = (await B.db.execute("SELECT egg_id, status FROM ramble_eggs ORDER BY egg_id")).rows.map((r) => [r.egg_id, r.status]);
  assert.deepEqual(bEggs, [["mine", "received"], ["theirs", "gifted"]], "one egg per side on the counterpart, no duplicate rows");
  assert.equal(B.sent.length, 1, "B never replies to a completion");

  A1.transport.stop(); A2.transport.stop(); B.transport.stop();
});
```

- [ ] **Step 3: Run it**

Run: `node scripts/run-suite.mjs tests/ramble-transport.test.js`
Expected: PASS on the first run — this test PROVES existing behaviour (the phase-3 ruling); if it fails, the failure is a real finding about the transport, to be reported, not papered over. In particular `shared.sent.length === 3` depends on each transport's `onEnvelope` calling `drainOnce()` after `deliveries > 0` (both have their own `draining` flag), and `bEvents.length === 1` on `receiveTrade`'s `existing.state === "completed"` early return.

- [ ] **Step 4: Commit**

```bash
git commit tests/ramble-transport.test.js -m "ramble transport test: two instances over one identity apply one accepted; duplicate replies are idempotent"
git show --stat HEAD
```

---

## Task 4: `GET /api/ramble/around` — the AR view's one server call

**Files:**
- Modify: `bundles/ramble/panel/routes.js` (`ensureLoaded` module list; a new `annotateMarks` helper next to `withApproxAnchor`; `GET /api/ramble/marks` uses it; new route after `/api/ramble/nests/claim`)
- Test: `tests/ramble-panel.test.js` (append two tests; extend the auth test)

**Interfaces:**
- Consumes: `aroundPoint`, `AROUND_RADIUS_DEFAULT/MIN/MAX` (around.js); `withApproxAnchor`, `contactsByPubkey` (routes.js).
- Produces: `GET /api/ramble/around?lat=<num>&lon=<num>[&radius_m=<int 50..1000>]` → `200 { here: { lat, lon }, radius_m, week, marks: [row + distance_m + (approx_lat, approx_lon, approx_m for teasers) + (contact_name for a contact's remote row)], nests: [{ cell, week, lat, lon, seed, claimed, distance_m }] }`; `400 { error }` on a bad or missing lat/lon/radius; `401` without a session.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-panel.test.js` BEFORE the `// ---- docs parity` section (the file's `req` helper adds the auth header; `realFetch` is the bare client):

```js
// ----------------------------------------------------------------- phase 4

test("GET /api/ramble/around: marks and nests within the radius with distance_m; teasers at the cell centre; inputs bounded", async () => {
  // 100 m north (open, just me), 100 m east (public, locked -> a teaser), 900 m north (out of range).
  const near = await req("/api/ramble/marks", { method: "POST", body: { kind: "mark", lat: 30.460898, lon: LON, text: "near north", visibility: "private" } });
  assert.equal(near.status, 201);
  const locked = await req("/api/ramble/marks", { method: "POST", body: { kind: "mark", lat: LAT, lon: -98.078958, text: "locked east", visibility: "public", reveal: "locked" } });
  assert.equal(locked.status, 201);
  const lockedId = (await locked.json()).mark.mark_id;
  const far = await req("/api/ramble/marks", { method: "POST", body: { kind: "mark", lat: 30.4681, lon: LON, text: "far north", visibility: "private" } });
  assert.equal(far.status, 201);
  // Every cell has a nest at rate 1, so one is within ~110 m; restored below.
  const db = createDbClient();
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('nest.rate', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] });
  try {
    const res = await req(`/api/ramble/around?lat=${LAT}&lon=${LON}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.here, { lat: LAT, lon: LON });
    assert.equal(body.radius_m, 500);
    assert.equal(typeof body.week, "string");
    const texts = body.marks.map((m) => m.content_text);
    assert.ok(texts.includes("near north"));
    assert.ok(!texts.includes("far north"), "900 m is out of the default radius");
    const n = body.marks.find((m) => m.content_text === "near north");
    assert.ok(Math.abs(n.distance_m - 100) <= 3, `distance ${n.distance_m}`);
    assert.deepEqual([n.lat, n.lon], [30.460898, LON], "lat/lon exactly as stored");
    const t = body.marks.find((m) => m.mark_id === lockedId);
    assert.ok(t, "the locked mark is listed");
    assert.equal(t.content_text, undefined, "still a teaser");
    assert.equal(t.lat, undefined);
    assert.equal(typeof t.approx_lat, "number");
    assert.equal(typeof t.approx_lon, "number");
    assert.ok(t.approx_m > 90 && t.approx_m < 115, "the 7-char cell's half-diagonal");
    assert.ok(t.distance_m <= 250);
    for (let i = 1; i < body.marks.length; i++) assert.ok(body.marks[i].distance_m >= body.marks[i - 1].distance_m, "nearest first");
    assert.ok(body.nests.length >= 1);
    for (const nest of body.nests) { assert.ok(nest.distance_m <= 500); assert.equal(typeof nest.seed, "number"); }
    const wide = await (await req(`/api/ramble/around?lat=${LAT}&lon=${LON}&radius_m=1000`)).json();
    assert.equal(wide.radius_m, 1000);
    assert.ok(wide.marks.map((m) => m.content_text).includes("far north"));
    // A full-precision double as String() prints it (up to 17 decimals) is a fine query.
    assert.equal((await req("/api/ramble/around?lat=30.460000000000000853&lon=-98.08")).status, 400, "18 decimals is too many");
    assert.equal((await req("/api/ramble/around?lat=30.46000000000000085&lon=-98.079999999999998")).status, 200);
  } finally {
    await db.execute({ sql: "DELETE FROM ramble_settings WHERE key = 'nest.rate'", args: [] });
    try { db.close?.(); } catch { /* scratch */ }
  }
  for (const q of ["lat=91&lon=0", "lat=0&lon=181", "lon=0", "lat=0", "lat=abc&lon=0", `lat=${LAT}&lon=${LON}&radius_m=5000`, `lat=${LAT}&lon=${LON}&radius_m=10`, `lat=${LAT}&lon=${LON}&radius_m=abc`, `lat=${LAT}&lon=${LON}&radius_m=1.5`]) {
    const r = await req("/api/ramble/around?" + q);
    assert.equal(r.status, 400, q);
    assert.equal(typeof (await r.json()).error, "string");
  }
});

test("GET /api/ramble/around names a contact's remote mark like the marks list does, and is behind dashboardAuth", async () => {
  const db = createDbClient();
  await db.execute({
    sql: `INSERT INTO ramble_marks (mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, visibility, reveal, content_text, content_kind, created_at, publish_state, origin)
          VALUES ('around-pal', ?, 'real', 'mark', 'geo', '9v6m21h', ?, ?, 'contacts', 'open', 'from pal', 'none', ?, 'remote', 'remote')`,
    args: [PK, LAT, LON, Date.now()],
  });
  try { db.close?.(); } catch { /* scratch */ }
  const body = await (await req(`/api/ramble/around?lat=${LAT}&lon=${LON}`)).json();
  const pal = body.marks.find((m) => m.mark_id === "around-pal");
  assert.equal(pal?.contact_name, "Pal");
  assert.equal((await realFetch(BASE + `/api/ramble/around?lat=${LAT}&lon=${LON}`)).status, 401);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js`
Expected: the two new tests FAIL with status 404 (no such route); every other test still passes.

- [ ] **Step 3: Implement the route**

In `bundles/ramble/panel/routes.js`:

(a) In `ensureLoaded`, extend the destructuring and the `Promise.all` with the around module — the array is positional, so append at the END of both:

```js
      const [dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, appRootMod, petMod, eggsMod, feedMod, flockMod, nestsMod, deliveryMod, tradesMod, aroundMod] = await Promise.all([
        bundleImport("server/db.js"),
        bundleImport("server/init-tables.js"),
        bundleImport("server/marks.js"),
        bundleImport("server/grid.js"),
        bundleImport("server/persona.js"),
        bundleImport("server/anchors.js"),
        bundleImport("server/app-root.js"),
        bundleImport("server/pet.js"),
        bundleImport("server/eggs.js"),
        bundleImport("server/feed.js"),
        bundleImport("server/flock.js"),
        bundleImport("server/nests.js"),
        bundleImport("server/delivery.js"),
        bundleImport("server/trades.js"),
        bundleImport("server/around.js"),
      ]).catch((err) => {
```

and the guard + `mods` object:

```js
      if (!dbMod || !initMod || !marksMod || !gridMod || !personaMod || !anchorsMod || !appRootMod || !petMod ||
          !eggsMod || !feedMod || !flockMod || !nestsMod || !deliveryMod || !tradesMod || !aroundMod) {
        res.status(500).json({ error: "ramble bundle modules not available" });
        return false;
      }
      mods = { dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, petMod, eggsMod, feedMod, flockMod, nestsMod, deliveryMod, tradesMod, aroundMod, appImport: appRootMod.appImport };
```

(b) After `withApproxAnchor` add the shared annotation (the marks list and the around route must agree on what a listed row looks like):

```js
  /**
   * What a listed row looks like to the panel, for BOTH /marks and /around:
   * a locked teaser gains its cell centre (withApproxAnchor) and a remote
   * mark by a contact is named (phase 3); a stranger's stays anonymous.
   */
  async function annotateMarks(marks) {
    const byPubkey = await contactsByPubkey();
    return marks.map(withApproxAnchor).map((m) => {
      const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
      return c ? { ...m, contact_name: c.name } : m;
    });
  }
```

(c) In `GET /api/ramble/marks` the line `const marks = await mods.marksMod.listMarks(db, { visibility, cells });` STAYS. Delete everything after it up to and including the `});` that closes `res.json(` — i.e. the comment `// Phase 3: a remote mark by a contact is named…`, the `const byPubkey = await contactsByPubkey();` line and the whole `res.json({ marks: marks.map(withApproxAnchor).map((m) => { … }) });` statement — and put this single line in their place (a second `const marks` would be a SyntaxError):

```js
    res.json({ marks: await annotateMarks(marks) });
```

(d) After the `POST /api/ramble/nests/claim` route add:

```js
  // --- phase 4: everything around a point, for the AR view --------------------
  //
  // Rows as stored (teasers at their cell centre, exactly like /marks) plus a
  // distance each, and this week's nests. A read: it credits nothing —
  // visit_place stays on POST /api/ramble/area with `here`.
  router.get("/api/ramble/around", handle(async (req, res) => {
    const q = req.query || {};
    // Up to 17 decimals: String(double) can print that many, and the client
    // sends toFixed(6) anyway — a full-precision fix must never be a 400.
    if (typeof q.lat !== "string" || !/^-?\d{1,3}(\.\d{1,17})?$/.test(q.lat)) bad("lat must be a decimal number");
    if (typeof q.lon !== "string" || !/^-?\d{1,3}(\.\d{1,17})?$/.test(q.lon)) bad("lon must be a decimal number");
    const lat = requireLat(Number(q.lat));
    const lon = requireLon(Number(q.lon));
    const { AROUND_RADIUS_DEFAULT, AROUND_RADIUS_MIN, AROUND_RADIUS_MAX } = mods.aroundMod;
    let radiusM = AROUND_RADIUS_DEFAULT;
    if (q.radius_m != null) {
      if (typeof q.radius_m !== "string" || !/^\d{1,4}$/.test(q.radius_m)) bad("radius_m must be an integer number of metres");
      radiusM = Number(q.radius_m);
      if (radiusM < AROUND_RADIUS_MIN || radiusM > AROUND_RADIUS_MAX) bad(`radius_m must be between ${AROUND_RADIUS_MIN} and ${AROUND_RADIUS_MAX}`);
    }
    let out;
    try {
      out = await mods.aroundMod.aroundPoint(db, { lat, lon, radiusM, now: Date.now() });
    } catch (err) {
      if (err?.code === "too-wide") bad(err.message);
      throw err;
    }
    res.json({ ...out, marks: await annotateMarks(out.marks) });
  }));
```

- [ ] **Step 4: Run the panel tests to verify they pass**

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js`
Expected: PASS. (The `/marks` tests that check `contact_name` and `approx_lat` still pass through `annotateMarks`.)

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel/routes.js tests/ramble-panel.test.js -m "ramble routes: GET /api/ramble/around for the AR view"
git show --stat HEAD
```

---

## Task 5: `panel/static/ramble-ar.js` — the renderer (pure frame + DOM painter), tested in Node with a synthetic pose

**Files:**
- Create: `bundles/ramble/panel/static/ramble-ar.js`
- Test: `tests/ramble-ar.test.js` (new)

**Interfaces:**
- Consumes: nothing from the bundle. Optional `engine` (the `RambleBird` API: `isValidBird`, `rollGenome`, `mountBird`) for the bird.
- Produces (`window.RambleAr` / `module.exports`): `FOV_DEG = 70`, `RANGE_M = 500`, `COARSE_M = 150`, `PARK_MAX = 6`; `distanceM(a, b)`, `bearingDeg(a, b)`, `relativeBearing(bearing, heading)` → `[-180, 180)`, `compassPoint(bearing)` → one of `N NE E SE S SW W NW`, `headingFromEvent(ev, screenAngle)` → `number | null`, `smoothHeading(prev, next, k = 0.25)`, `layoutAnchor(anchor, pose)`, `renderAr({ anchors, pose, bird, camera })` → frame, `mountAr(els, { engine, onTap })` → `{ render(state) → frame, destroy(), anchor(id) }`.
- Frame: `{ mode: "ar"|"radar", reason: null|"no-fix"|"no-camera"|"no-heading", labels: [{ id, kind, title, sub, locked, x, y, scale, side, distance_m, bearing, rel, visible }] (far first), parked: { left, right } (overflow past PARK_MAX), coarse: [{ id, kind, title, sub }], radar: { dots: [{ id, kind, locked, x, y }], list: [{ id, kind, title, sub, distance_m }] }, visible: [id], say: string, bird }`.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-ar.test.js`:

```js
/**
 * Phase 4 — the AR renderer, run exactly as the browser runs it: the file is
 * a classic script evaluated in a vm sandbox with a `window`, so the test
 * proves the dual shim AND the maths. A synthetic pose drives it: label
 * positions for known bearings, edge parking, scale by distance, the radar
 * fallback when the heading is null or the camera failed. A tiny fake
 * document smoke-tests the DOM painter (labels, taps, the bird reaction).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "../bundles/ramble/panel/static/ramble-ar.js"), "utf8");

function load(extra = {}) {
  const sandbox = { window: {}, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(SRC, sandbox);
  return { Ar: sandbox.window.RambleAr, sandbox };
}
const { Ar } = load();
/**
 * Objects and arrays built INSIDE the vm carry that realm's prototypes, and
 * assert/strict's deepEqual is deepStrictEqual (it compares prototypes), so a
 * vm-built value on the LEFT of deepEqual fails with "same structure but not
 * reference-equal". Round-trip through JSON before comparing structure.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

const HERE = { lat: 30.46, lon: -98.08 };
const NORTH_100 = { lat: 30.460898, lon: -98.08 };
const EAST_100 = { lat: 30.46, lon: -98.078958 };
const SOUTH_100 = { lat: 30.459102, lon: -98.08 };
const NORTH_500 = { lat: 30.46449, lon: -98.08 };
const anchor = (id, at, extra = {}) => ({ id, kind: "mark", lat: at.lat, lon: at.lon, accuracy_m: 10, approx_m: 0, locked: false, title: id, ...extra });
const pose = (heading) => ({ lat: HERE.lat, lon: HERE.lon, accuracy_m: 8, heading });

test("classic script: no ESM syntax, zero backticks, zero markup sinks, no emoji, no capture APIs; exports the contract", () => {
  assert.ok(!/^\s*(import|export)\s/m.test(SRC));
  assert.equal(SRC.split("`").length - 1, 0, "zero backticks");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(code.match(/\.innerHTML\s*=|\bhtml:\s|insertAdjacentHTML|outerHTML/g) || [], [], "zero markup sinks");
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(SRC), "no emoji");
  assert.ok(!/toDataURL|toBlob|captureStream|ImageCapture|MediaRecorder|drawImage|getContext\(/.test(SRC), "camera frames never leave the device");
  for (const k of ["renderAr", "mountAr", "layoutAnchor", "bearingDeg", "distanceM", "relativeBearing", "compassPoint", "headingFromEvent", "smoothHeading", "noticeSeen", "markNoticeSeen"]) assert.equal(typeof Ar[k], "function", k);
  assert.deepEqual([Ar.FOV_DEG, Ar.RANGE_M, Ar.COARSE_M, Ar.PARK_MAX], [70, 500, 150, 6]);
});

test("bearing and distance for known points; relative bearing folds into [-180, 180); compass points", () => {
  assert.ok(Math.abs(Ar.distanceM(HERE, NORTH_100) - 100) < 1.5);
  assert.ok(Math.abs(Ar.distanceM(HERE, EAST_100) - 100) < 1.5);
  assert.ok(Ar.bearingDeg(HERE, NORTH_100) < 0.5 || Ar.bearingDeg(HERE, NORTH_100) > 359.5);
  assert.ok(Math.abs(Ar.bearingDeg(HERE, EAST_100) - 90) < 0.5);
  assert.ok(Math.abs(Ar.bearingDeg(HERE, SOUTH_100) - 180) < 0.5);
  assert.equal(Ar.relativeBearing(10, 350), 20);
  assert.equal(Ar.relativeBearing(350, 10), -20);
  assert.equal(Ar.relativeBearing(180, 0), -180);
  assert.equal(Ar.relativeBearing(90, 0), 90);
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315, 359].map(Ar.compassPoint), ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N"]);
});

test("headingFromEvent: webkitCompassHeading wins; alpha only from an absolute event, 360 - alpha + screen angle; smoothing crosses the wrap", () => {
  assert.equal(Ar.headingFromEvent({ webkitCompassHeading: 45, alpha: 200 }, 0), 45);
  assert.equal(Ar.headingFromEvent({ alpha: 90, absolute: true }, 0), 270);
  assert.equal(Ar.headingFromEvent({ alpha: 90, type: "deviceorientationabsolute" }, 90), 0);
  assert.equal(Ar.headingFromEvent({ alpha: 90, absolute: false, type: "deviceorientation" }, 0), null, "a relative alpha is not a heading");
  assert.equal(Ar.headingFromEvent({ alpha: null, absolute: true }, 0), null);
  assert.equal(Ar.headingFromEvent(null, 0), null);
  assert.equal(Ar.smoothHeading(null, 30), 30);
  assert.equal(Ar.smoothHeading(30, null), 30);
  const s = Ar.smoothHeading(359, 1, 0.5);
  assert.ok(s === 0 || s > 359.9, `359 -> 1 halfway is 0, got ${s}`);
  assert.equal(Ar.smoothHeading(0, 40, 0.25), 10);
});

test("the first-open notice gate: unseen until marked; a missing or throwing storage means the notice shows, never a crash", () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(Ar.noticeSeen(() => storage, "ramble.ar.limits"), false);
  assert.equal(Ar.markNoticeSeen(() => storage, "ramble.ar.limits"), true);
  assert.equal(Ar.noticeSeen(() => storage, "ramble.ar.limits"), true);
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(Ar.noticeSeen(boom, "ramble.ar.limits"), false);
  assert.equal(Ar.markNoticeSeen(boom, "ramble.ar.limits"), false);
  assert.equal(Ar.noticeSeen(() => null, "ramble.ar.limits"), false);
});

test("layout: heading 0 puts north centre-screen, east parked right, south parked left; heading 350 shifts north right of centre", () => {
  const n = Ar.layoutAnchor(anchor("n", NORTH_100), pose(0));
  assert.equal(n.visible, true); assert.equal(n.side, null);
  assert.ok(Math.abs(n.x - 0.5) < 0.01);
  const e = Ar.layoutAnchor(anchor("e", EAST_100), pose(0));
  assert.deepEqual([e.visible, e.side, e.x], [false, "right", 0.94]);
  const s = Ar.layoutAnchor(anchor("s", SOUTH_100), pose(0));
  assert.deepEqual([s.visible, s.side, s.x], [false, "left", 0.06]);
  const n2 = Ar.layoutAnchor(anchor("n", NORTH_100), pose(350));
  assert.equal(n2.visible, true);
  assert.ok(Math.abs(n2.x - (0.5 + 10 / 70)) < 0.01, `x ${n2.x}`);
  const e2 = Ar.layoutAnchor(anchor("e", EAST_100), pose(90));
  assert.equal(e2.visible, true); assert.ok(Math.abs(e2.x - 0.5) < 0.01);
});

test("layout: vertical position and scale by distance (near low and big, far high and small); sub line; locked teaser", () => {
  const near = Ar.layoutAnchor(anchor("n", NORTH_100), pose(0));
  const far = Ar.layoutAnchor(anchor("f", NORTH_500), pose(0));
  assert.ok(near.y > far.y, "nearer is lower on screen");
  assert.ok(near.scale > far.scale);
  assert.ok(Math.abs(near.y - (0.70 - 0.36 * 0.2)) < 0.01);
  assert.ok(Math.abs(near.scale - (1 - 0.5 * 0.2)) < 0.01);
  assert.ok(Math.abs(far.y - 0.34) < 0.01 && Math.abs(far.scale - 0.5) < 0.01);
  assert.equal(near.sub, "100 m");
  const locked = Ar.layoutAnchor(anchor("l", NORTH_100, { locked: true }), pose(0));
  assert.equal(locked.locked, true);
  assert.equal(locked.sub, "~100 m · locked");
  const at0 = Ar.layoutAnchor(anchor("z", HERE), pose(0));
  assert.deepEqual([at0.distance_m, at0.sub, at0.y, at0.scale], [0, "5 m", 0.70, 1]);
});

test("renderAr in ar mode: labels for in-range anchors, far first; parked overflow counted; coarse anchors get no direction; out of range dropped", () => {
  const anchors = [anchor("n", NORTH_100), anchor("e", EAST_100), anchor("s", SOUTH_100), anchor("far", { lat: 30.4681, lon: -98.08 }), anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })];
  const f = Ar.renderAr({ anchors, pose: pose(0), bird: null });
  assert.equal(f.mode, "ar"); assert.equal(f.reason, null);
  assert.deepEqual(plain(f.visible), ["n"]);
  assert.deepEqual(plain(f.labels.map((l) => l.id).sort()), ["e", "n", "s"], "in range and not coarse");
  assert.deepEqual(plain(f.coarse), [{ id: "caw", kind: "caw", title: "A caw", sub: "somewhere in this area" }]);
  assert.deepEqual(plain(f.parked), { left: 0, right: 0 });
  assert.equal(f.radar.dots.length, 3);
  assert.equal(f.radar.list.length, 3);
  assert.equal(f.say, "n, 100 m ahead.");
  // Nine anchors to the right: six parked labels stacked by distance, three counted as overflow.
  const many = [];
  for (let i = 1; i <= 9; i++) many.push(anchor("r" + i, { lat: HERE.lat, lon: HERE.lon + 0.00025 * i }));
  const g = Ar.renderAr({ anchors: many, pose: pose(0), bird: null });
  const parked = g.labels.filter((l) => l.side === "right");
  assert.equal(parked.length, 6);
  assert.deepEqual(plain(g.parked), { left: 0, right: 3 });
  const ys = parked.slice().sort((a, b) => a.distance_m - b.distance_m).map((l) => l.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], "parked labels stack down the edge by distance");
  assert.deepEqual(plain(g.labels.map((l) => l.distance_m)), plain(g.labels.map((l) => l.distance_m).slice().sort((a, b) => b - a)), "far first so near paints on top");
  assert.equal(g.say, "r1, 25 m to your right.");
});

test("renderAr radar fallback: no heading, no camera, no fix — never blank; north-up dots; the list carries distance and compass point", () => {
  const anchors = [anchor("n", NORTH_100), anchor("e", EAST_100, { locked: true })];
  const noHeading = Ar.renderAr({ anchors, pose: pose(null), bird: null });
  assert.deepEqual([noHeading.mode, noHeading.reason, noHeading.labels.length, noHeading.visible.length], ["radar", "no-heading", 0, 0]); // host-built array on the left: fine
  const dn = noHeading.radar.dots.find((d) => d.id === "n");
  assert.ok(Math.abs(dn.x - 0.5) < 0.01 && dn.y < 0.5, "north-up: the north anchor sits above centre");
  const de = noHeading.radar.dots.find((d) => d.id === "e");
  assert.ok(de.x > 0.5 && Math.abs(de.y - 0.5) < 0.01 && de.locked === true);
  assert.deepEqual(plain(noHeading.radar.list.map((r) => r.sub)), ["100 m · N", "~100 m · E · locked"]);
  assert.equal(noHeading.say, "n, 100 m N. Follow the ring.");
  const noCamera = Ar.renderAr({ anchors, pose: pose(0), bird: null, camera: false });
  assert.deepEqual([noCamera.mode, noCamera.reason, noCamera.labels.length], ["radar", "no-camera", 0]);
  const dh = noCamera.radar.dots.find((d) => d.id === "e");
  assert.ok(dh.x > 0.5, "with a heading the ring turns heading-up");
  const noFix = Ar.renderAr({ anchors, pose: { lat: null, lon: null, heading: 0 }, bird: null });
  assert.deepEqual([noFix.mode, noFix.reason, noFix.radar.dots.length, noFix.say], ["radar", "no-fix", 0, "Waiting for a fix…"]);
  const empty = Ar.renderAr({ anchors: [], pose: pose(0), bird: null });
  assert.equal(empty.say, "Nothing within 500 m. Walk a bit.");
  const onlyCoarse = Ar.renderAr({ anchors: [anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })], pose: pose(0), bird: null });
  assert.equal(onlyCoarse.say, "Something is around here, but I can't tell which way.");
  assert.equal(onlyCoarse.coarse.length, 1);
  assert.equal(Ar.renderAr(null).mode, "radar");
});

/** The least DOM that mountAr touches: createElement/NS, textContent, attributes, style, listeners, classList, hidden, parentNode/removeChild. */
function fakeDocument() {
  const make = (tag) => {
    const el = { tag, children: [], attrs: {}, style: {}, hidden: false, listeners: {}, classes: new Set(), _text: "" };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.removeAttribute = (k) => { delete el.attrs[k]; };
    el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
    el.removeChild = (c) => { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; };
    el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
    el.click = () => { for (const fn of el.listeners.click || []) fn(); };
    el.classList = { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c), contains: (c) => el.classes.has(c) };
    Object.defineProperty(el, "textContent", { get: () => el._text, set: (v) => { el._text = String(v); if (v === "") { el.children.forEach((c) => { c.parentNode = null; }); el.children = []; } } });
    return el;
  };
  return { createElement: make, createElementNS: (_ns, tag) => make(tag) };
}

test("mountAr paints labels with textContent, routes taps by id, mounts the bird through the engine once, and reacts when a label enters view", () => {
  const document = fakeDocument();
  const { Ar: A } = load({ document });
  const els = { root: document.createElement("div"), labels: document.createElement("div"), radar: document.createElementNS("svg", "g"), list: document.createElement("div"), coarse: document.createElement("div"), bird: document.createElementNS("svg", "svg"), egg: document.createElementNS("svg", "svg"), say: document.createElement("div"), more: document.createElement("p"), mode: document.createElement("span") };
  const mounted = [];
  const engine = { isValidBird: (b) => !!b && b.species === "crow", rollGenome: (seed, species) => ({ seed, species }), mountBird: (el, g, mood) => mounted.push([el.tag, g, mood]) };
  const taps = [];
  const session = A.mountAr(els, { engine, onTap: (id) => taps.push(id) });
  const anchors = [anchor("n", NORTH_100, { title: "near north" }), anchor("e", EAST_100, { locked: true, title: "A locked mark" })];
  const f1 = session.render({ anchors, pose: pose(90), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.equal(f1.mode, "ar");
  assert.equal(els.root.getAttribute("data-mode"), "ar");
  assert.equal(els.root.getAttribute("data-camera"), "on");
  assert.equal(els.mode.textContent, "AR");
  assert.equal(els.labels.children.length, 2);
  const east = els.labels.children.find((c) => c.getAttribute("data-id") === "e");
  assert.equal(east.getAttribute("data-locked"), "true");
  assert.equal(east.getAttribute("data-side"), null, "in view: no edge arrow");
  assert.equal(east.children[0].textContent, "A locked mark");
  assert.equal(east.children[1].textContent, "~100 m · locked");
  assert.match(east.style.left, /%$/);
  const north = els.labels.children.find((c) => c.getAttribute("data-id") === "n");
  assert.equal(north.getAttribute("data-side"), "left", "facing east, north is parked on the left edge with its arrow");
  assert.ok(Number(east.style.zIndex) > Number(north.style.zIndex), "the nearer label paints on top");
  east.click();
  assert.deepEqual(taps, ["e"]);
  assert.equal(session.anchor("e").title, "A locked mark");
  assert.equal(session.anchor("nope"), null);
  assert.deepEqual(plain(mounted), [["svg", { seed: 7, species: "crow" }, "happy"]]);
  assert.equal(els.bird.hidden, false); assert.equal(els.egg.hidden, true);
  assert.ok(els.bird.classes.has("rb-ar-react"), "east entered view on the first frame");
  assert.equal(els.radar.children.length, 2);
  assert.equal(els.say.textContent, "A locked mark, 100 m ahead.");
  // Same bird, same pose: no re-mount, no new reaction, and the SAME button
  // objects (a label rebuilt under the finger never gets its click — C3).
  els.bird.classes.delete("rb-ar-react");
  session.render({ anchors, pose: pose(90), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.equal(mounted.length, 1);
  assert.ok(!els.bird.classes.has("rb-ar-react"));
  assert.equal(els.labels.children.find((c) => c.getAttribute("data-id") === "e"), east, "the label element persists across frames");
  assert.equal(els.labels.children.length, 2);
  const rowsBefore = els.list.children;
  session.render({ anchors, pose: pose(0), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.ok(els.bird.classes.has("rb-ar-react"));
  assert.equal(els.labels.children.find((c) => c.getAttribute("data-id") === "n"), north, "still the same element after turning");
  assert.equal(north.getAttribute("data-side"), null, "now in view: the arrow is gone");
  assert.equal(east.getAttribute("data-side"), "right");
  assert.equal(els.list.children, rowsBefore, "the radar list is not rebuilt while its text is unchanged");
  // An anchor that leaves the set takes its button with it.
  session.render({ anchors: [anchors[0]], pose: pose(0), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.equal(els.labels.children.length, 1);
  assert.equal(east.parentNode, null);
  // No bird: the egg shows; no heading: radar mode label and rows.
  const f2 = session.render({ anchors, pose: pose(null), bird: null });
  assert.equal(f2.mode, "radar");
  assert.equal(els.mode.textContent, "Radar · no compass");
  assert.equal(els.bird.hidden, true); assert.equal(els.egg.hidden, false);
  assert.equal(els.labels.children.length, 0);
  assert.equal(els.list.children.length, 2);
  assert.notEqual(els.list.children, rowsBefore, "the mode flip repaints the list (its key includes the mode)");
  els.list.children[0].click();
  assert.deepEqual(taps, ["e", "n"]);
  // A coarse anchor in radar mode joins the list as a row; in AR mode it only sits in the coarse strip.
  session.render({ anchors: anchors.concat([anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })]), pose: pose(null), bird: null });
  assert.equal(els.list.children.length, 3);
  assert.equal(els.coarse.children.length, 1);
  session.render({ anchors: anchors.concat([anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })]), pose: pose(0), bird: null });
  assert.equal(els.list.children.length, 2);
  assert.equal(els.coarse.children.length, 1);
  session.destroy();
  assert.equal(els.labels.children.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/run-suite.mjs tests/ramble-ar.test.js`
Expected: FAIL — `ENOENT ... ramble-ar.js`.

- [ ] **Step 3: Create the renderer**

Create `bundles/ramble/panel/static/ramble-ar.js` (ONE classic script; no backticks anywhere; no `import`/`export`):

```js
/* Ramble AR — the overlay renderer (spec §6). Plain classic script, dual
 * Node/browser: window.RambleAr in a browser, module.exports under a
 * CommonJS loader, and it runs unchanged inside vm.runInNewContext (the
 * tests). NO ESM syntax, NO template literals (backticks), NO innerHTML:
 * every label is built with createElement + textContent, and the only markup
 * this file ever mounts is the bird, through the engine's own mountBird.
 *
 * Contract: renderAr({ anchors, pose, bird, camera }) -> frame. It knows
 * nothing about maps, marks or nests. An anchor is
 *   { id, kind: "mark"|"caw"|"nest", lat, lon, accuracy_m, approx_m, locked, title }
 * and the frame says where each label goes as FRACTIONS of the viewport, so
 * one frame paints any screen and the tests need no DOM. mountAr(els, opts)
 * is the DOM painter for that frame; a future WebXR painter consumes the
 * same state and adds surface placement.
 *
 * Camera frames never leave the device: this file never touches a canvas,
 * never captures, never uploads. The <video> is a background and nothing
 * more (the tests grep for the APIs that could change that).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleAr = api;
})(this, function () {
  "use strict";

  var FOV_DEG = 70;            /* +-35 degrees is "in front of you" */
  var RANGE_M = 500;
  var COARSE_M = 150;          /* wider error radius than this: no direction is honest */
  var PARK_MAX = 6;            /* parked labels stacked per edge */
  var NEAR_Y = 0.70, FAR_Y = 0.34;
  var NEAR_SCALE = 1, FAR_SCALE = 0.5;
  var PARK_Y0 = 0.28, PARK_STEP = 0.07, PARK_SCALE = 0.7;
  var REACT_MS = 900;
  var POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  var SVG_NS = "http://www.w3.org/2000/svg";

  function norm(deg) { var d = deg % 360; return d < 0 ? d + 360 : d; }
  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180) / Math.PI; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function hasFix(pose) { return !!pose && isNum(pose.lat) && isNum(pose.lon); }
  function roundM(m) { return Math.max(5, Math.round(m / 5) * 5); }

  /* ------------------------------------------------------------- geometry */

  function distanceM(a, b) {
    var R = 6371000;
    var dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    var s = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /* Initial bearing from a to b, degrees clockwise from true north. */
  function bearingDeg(a, b) {
    var p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return norm(toDeg(Math.atan2(y, x)));
  }

  /* bearing - heading folded into [-180, 180): negative = to your left. */
  function relativeBearing(bearing, heading) {
    return ((bearing - heading + 540) % 360) - 180;
  }

  function compassPoint(bearing) {
    return POINTS[Math.round(norm(bearing) / 45) % 8];
  }

  /* --------------------------------------------------------------- heading */

  /* A compass heading from a DeviceOrientation event, or null when the
   * event cannot give an absolute one. iOS: webkitCompassHeading already IS
   * the heading. Elsewhere alpha runs counter-clockwise from north, so the
   * heading is 360 - alpha, plus the screen's own rotation. */
  function headingFromEvent(ev, screenAngle) {
    if (!ev) return null;
    if (isNum(ev.webkitCompassHeading)) return norm(ev.webkitCompassHeading);
    if (!isNum(ev.alpha)) return null;
    if (ev.absolute !== true && ev.type !== "deviceorientationabsolute") return null;
    return norm(360 - ev.alpha + (isNum(screenAngle) ? screenAngle : 0));
  }

  /* Low-pass filter that crosses the 359 -> 1 wrap. */
  function smoothHeading(prev, next, k) {
    if (!isNum(next)) return isNum(prev) ? prev : null;
    if (!isNum(prev)) return norm(next);
    var gain = isNum(k) ? k : 0.25;
    return norm(prev + gain * relativeBearing(next, prev));
  }

  /* ---------------------------------------------------------------- layout */

  function subFor(d, locked) {
    return (locked ? "~" : "") + roundM(d) + " m" + (locked ? " · locked" : "");
  }

  function directionWord(rel) {
    if (Math.abs(rel) <= FOV_DEG / 2) return "ahead";
    if (rel <= -135 || rel >= 135) return "behind you";
    return rel < 0 ? "to your left" : "to your right";
  }

  /* One anchor against one pose: distance, bearing, and (with a heading) its
   * place on the screen, all as fractions 0..1 of the viewport. */
  function layoutAnchor(anchor, pose) {
    var d = distanceM(pose, anchor);
    var b = bearingDeg(pose, anchor);
    var t = clamp01(d / RANGE_M);
    var out = {
      id: anchor.id, kind: anchor.kind, title: anchor.title, locked: !!anchor.locked,
      distance_m: Math.round(d), bearing: Math.round(b), rel: null, visible: false, side: null,
      x: 0.5, y: NEAR_Y - (NEAR_Y - FAR_Y) * t, scale: NEAR_SCALE - (NEAR_SCALE - FAR_SCALE) * t,
      sub: subFor(d, anchor.locked),
    };
    if (isNum(pose.heading)) {
      var rel = relativeBearing(b, pose.heading);
      out.rel = Math.round(rel * 10) / 10;
      out.visible = Math.abs(rel) <= FOV_DEG / 2;
      if (out.visible) {
        out.x = 0.5 + rel / FOV_DEG;
      } else {
        out.side = rel < 0 ? "left" : "right";
        out.x = rel < 0 ? 0.06 : 0.94;
      }
    }
    return out;
  }

  function radarDot(item, headingUp) {
    var a = toRad(headingUp && isNum(item.rel) ? item.rel : item.bearing);
    var r = 0.25 + 0.75 * clamp01(item.distance_m / RANGE_M);
    return { id: item.id, kind: item.kind, locked: item.locked, x: 0.5 + 0.42 * r * Math.sin(a), y: 0.5 - 0.42 * r * Math.cos(a) };
  }

  function sayFor(mode, reason, items, visibleItems, coarseCount) {
    if (reason === "no-fix") return "Waiting for a fix…";
    if (items.length === 0 && coarseCount > 0) return "Something is around here, but I can't tell which way.";
    if (items.length === 0) return "Nothing within " + RANGE_M + " m. Walk a bit.";
    if (visibleItems.length > 0) return visibleItems[0].title + ", " + roundM(visibleItems[0].distance_m) + " m ahead.";
    var n = items[0];
    if (mode === "radar" || !isNum(n.rel)) return n.title + ", " + roundM(n.distance_m) + " m " + compassPoint(n.bearing) + ". Follow the ring.";
    return n.title + ", " + roundM(n.distance_m) + " m " + directionWord(n.rel) + ".";
  }

  /* The contract. camera defaults to true; pass false once getUserMedia failed. */
  function renderAr(state) {
    var s = state || {};
    var anchors = Array.isArray(s.anchors) ? s.anchors : [];
    var pose = s.pose || {};
    var camera = s.camera !== false;
    var fix = hasFix(pose);
    var heading = isNum(pose.heading);
    var mode = fix && camera && heading ? "ar" : "radar";
    var reason = !fix ? "no-fix" : (!camera ? "no-camera" : (!heading ? "no-heading" : null));

    var items = [], coarse = [];
    if (fix) {
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        if (!a || !isNum(a.lat) || !isNum(a.lon)) continue;
        if (isNum(a.approx_m) && a.approx_m > COARSE_M) {
          coarse.push({ id: a.id, kind: a.kind, title: a.title, sub: "somewhere in this area" });
          continue;
        }
        var item = layoutAnchor(a, pose);
        if (item.distance_m > RANGE_M) continue;
        items.push(item);
      }
    }
    items.sort(function (p, q) { return p.distance_m - q.distance_m; });

    var visible = [], labels = [], parkedLeft = 0, parkedRight = 0;
    if (mode === "ar") {
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it.visible) { visible.push(it); labels.push(it); continue; }
        var rank = it.side === "left" ? parkedLeft++ : parkedRight++;
        if (rank < PARK_MAX) {
          it.y = PARK_Y0 + PARK_STEP * rank;
          it.scale = PARK_SCALE;
          labels.push(it);
        }
      }
      /* Far first, so the nearest label paints last and on top. */
      labels.sort(function (p, q) { return q.distance_m - p.distance_m; });
    }

    return {
      mode: mode,
      reason: reason,
      labels: labels,
      parked: { left: Math.max(0, parkedLeft - PARK_MAX), right: Math.max(0, parkedRight - PARK_MAX) },
      coarse: coarse,
      radar: {
        dots: items.map(function (it) { return radarDot(it, mode === "ar" || isNum(pose.heading)); }),
        list: items.map(function (it) {
          return { id: it.id, kind: it.kind, title: it.title, distance_m: it.distance_m,
            sub: (it.locked ? "~" : "") + roundM(it.distance_m) + " m · " + compassPoint(it.bearing) + (it.locked ? " · locked" : "") };
        }),
      },
      visible: visible.map(function (it) { return it.id; }),
      say: sayFor(mode, reason, items, visible, coarse.length),
      bird: s.bird || null,
    };
  }

  /* --------------------------------------------------------------- painter */

  /* els: { root, labels, radar (an <svg> group), list, coarse, bird (<svg>),
   * egg (<svg>), say, more, mode }. Any of them may be missing. opts:
   * { engine: the RambleBird API, onTap(id) }. */
  function mountAr(els, opts) {
    var e = els || {};
    var o = opts || {};
    var engine = o.engine || (typeof window !== "undefined" ? window.RambleBird : null);
    var byId = {};
    var prevVisible = {};
    var birdKey = null;
    var reactTimer = null;
    /* Label <button>s persist across frames, keyed by anchor id (C3): a frame
     * arrives on every orientation event, and a button rebuilt under the
     * finger never receives its click. Positions are UPDATED in place. */
    var nodes = {};
    /* The radar list and the coarse rows repaint only when their text changes. */
    var listKey = null;

    function clear(el) { if (el) el.textContent = ""; }
    function pct(v) { return (v * 100).toFixed(2) + "%"; }
    function remove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
    function badgeFor(item) {
      if (item.kind === "nest") return "N";
      if (item.kind === "caw") return "C";
      return item.locked ? "?" : "M";
    }

    /* Built once per anchor id; the click closes over the id, which never changes. */
    function labelEl(id) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-ar-label";
      btn.setAttribute("data-id", id);
      var strong = document.createElement("strong");
      var sub = document.createElement("span");
      btn.appendChild(strong);
      btn.appendChild(sub);
      btn.addEventListener("click", function () { if (typeof o.onTap === "function") o.onTap(id); });
      return btn;
    }

    /* Everything about a label that can change between frames. order is the
     * paint order (far first), applied as z-index since DOM order now persists. */
    function placeLabel(btn, item, order) {
      btn.setAttribute("data-kind", item.kind);
      if (item.locked) btn.setAttribute("data-locked", "true"); else btn.removeAttribute("data-locked");
      if (item.side) btn.setAttribute("data-side", item.side); else btn.removeAttribute("data-side");
      btn.style.left = pct(item.x);
      btn.style.top = pct(item.y);
      btn.style.transform = "translate(-50%, -50%) scale(" + item.scale.toFixed(3) + ")";
      btn.style.zIndex = String(10 + order);
      if (btn.children[0].textContent !== item.title) btn.children[0].textContent = item.title;
      if (btn.children[1].textContent !== item.sub) btn.children[1].textContent = item.sub;
    }

    function rowEl(item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-step rb-ar-row";
      btn.setAttribute("data-id", item.id);
      var badge = document.createElement("span");
      badge.className = "rb-step-n";
      badge.textContent = badgeFor(item);
      var txt = document.createElement("div");
      txt.className = "rb-step-txt";
      var strong = document.createElement("strong");
      strong.textContent = item.title;
      var sub = document.createElement("span");
      sub.className = "rb-muted rb-fine";
      sub.textContent = item.sub;
      txt.appendChild(strong);
      txt.appendChild(sub);
      btn.appendChild(badge);
      btn.appendChild(txt);
      btn.addEventListener("click", function () { if (typeof o.onTap === "function") o.onTap(item.id); });
      return btn;
    }

    function paintRadar(frame) {
      if (e.radar) {
        /* Dots are not tappable, so rebuilding them each frame is fine. */
        clear(e.radar);
        frame.radar.dots.forEach(function (dot) {
          var c = document.createElementNS(SVG_NS, "circle");
          c.setAttribute("cx", (dot.x * 100).toFixed(2));
          c.setAttribute("cy", (dot.y * 100).toFixed(2));
          c.setAttribute("r", dot.kind === "nest" ? "3.2" : "2.6");
          c.setAttribute("class", "rb-ar-dot rb-ar-dot-" + dot.kind + (dot.locked ? " is-locked" : ""));
          e.radar.appendChild(c);
        });
      }
      /* Rows ARE tappable: repaint only when what they say changes (distances
       * move in 5 m steps, so this is a few times a minute on foot, not 60 Hz). */
      var coarseRows = frame.coarse.map(function (item) { return { id: item.id, kind: item.kind, title: item.title, sub: item.sub, locked: false }; });
      var key = frame.mode + "#" + frame.radar.list.map(function (i) { return i.id + "|" + i.title + "|" + i.sub; }).join(";") + "#" +
        coarseRows.map(function (i) { return i.id + "|" + i.title + "|" + i.sub; }).join(";");
      if (key === listKey) return;
      listKey = key;
      if (e.list) {
        clear(e.list);
        frame.radar.list.forEach(function (item) { e.list.appendChild(rowEl(item)); });
        /* In radar mode the list is the whole inventory, coarse rows included
         * (the separate coarse strip is hidden there — it would collide). */
        if (frame.mode === "radar") coarseRows.forEach(function (item) { e.list.appendChild(rowEl(item)); });
      }
      if (e.coarse) {
        clear(e.coarse);
        coarseRows.forEach(function (item) { e.coarse.appendChild(rowEl(item)); });
      }
    }

    function paintBird(bird) {
      var valid = !!(engine && bird && typeof engine.isValidBird === "function" && engine.isValidBird({ species: bird.species, seed: bird.seed }));
      if (e.bird) e.bird.hidden = !valid;
      if (e.egg) e.egg.hidden = valid;
      if (!valid) { birdKey = null; return; }
      var key = bird.species + ":" + bird.seed + ":" + (bird.mood || "happy");
      if (key === birdKey) return;
      birdKey = key;
      try { engine.mountBird(e.bird, engine.rollGenome(bird.seed, bird.species), bird.mood || "happy"); } catch (err) { /* cosmetic */ }
    }

    function react() {
      if (!e.bird || e.bird.hidden) return;
      e.bird.classList.add("rb-ar-react");
      if (reactTimer) clearTimeout(reactTimer);
      reactTimer = setTimeout(function () { e.bird.classList.remove("rb-ar-react"); reactTimer = null; }, REACT_MS);
    }

    function modeLabel(frame) {
      if (frame.mode === "ar") return "AR";
      if (frame.reason === "no-camera") return "Radar · no camera";
      if (frame.reason === "no-heading") return "Radar · no compass";
      return "Radar";
    }

    function render(state) {
      var frame = renderAr(state);
      byId = {};
      ((state && state.anchors) || []).forEach(function (a) { if (a && a.id != null) byId[a.id] = a; });
      if (e.root) {
        e.root.setAttribute("data-mode", frame.mode);
        e.root.setAttribute("data-reason", frame.reason || "");
        /* The video's visibility is the camera's state, not the mode's reason:
         * no fix + no camera reports "no-fix" and must still hide the black video. */
        e.root.setAttribute("data-camera", state && state.camera === false ? "off" : "on");
      }
      if (e.mode) e.mode.textContent = modeLabel(frame);
      if (e.labels) {
        var keep = {};
        frame.labels.forEach(function (item, order) {
          var btn = nodes[item.id];
          if (!btn) { btn = labelEl(item.id); nodes[item.id] = btn; e.labels.appendChild(btn); }
          placeLabel(btn, item, order);
          keep[item.id] = true;
        });
        Object.keys(nodes).forEach(function (id) {
          if (keep[id]) return;
          remove(nodes[id]);
          delete nodes[id];
        });
      }
      if (e.more) {
        var more = [];
        if (frame.parked.left > 0) more.push("+" + frame.parked.left + " more to your left");
        if (frame.parked.right > 0) more.push("+" + frame.parked.right + " more to your right");
        e.more.textContent = more.join(" · ");
      }
      paintRadar(frame);
      paintBird(frame.bird);
      if (e.say) e.say.textContent = frame.say;
      var entered = false;
      var nowVisible = {};
      frame.visible.forEach(function (id) { nowVisible[id] = true; if (!prevVisible[id]) entered = true; });
      prevVisible = nowVisible;
      if (entered) react();
      return frame;
    }

    function destroy() {
      if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
      prevVisible = {};
      birdKey = null;
      byId = {};
      nodes = {};
      listKey = null;
      [e.labels, e.radar, e.list, e.coarse].forEach(clear);
    }

    return { render: render, destroy: destroy, anchor: function (id) { return byId[id] || null; } };
  }

  /* ------------------------------------------------------------ first open */

  /* The limits notice gates the first open; the memory of it lives in web
   * storage, which can be absent or throwing (private mode, a blocked site).
   * getStorage is a function so even touching localStorage is inside the try. */
  function noticeSeen(getStorage, key) {
    try { return getStorage().getItem(key) === "1"; } catch (e) { return false; }
  }
  function markNoticeSeen(getStorage, key) {
    try { getStorage().setItem(key, "1"); return true; } catch (e) { return false; }
  }

  return {
    FOV_DEG: FOV_DEG, RANGE_M: RANGE_M, COARSE_M: COARSE_M, PARK_MAX: PARK_MAX,
    distanceM: distanceM, bearingDeg: bearingDeg, relativeBearing: relativeBearing, compassPoint: compassPoint,
    headingFromEvent: headingFromEvent, smoothHeading: smoothHeading,
    layoutAnchor: layoutAnchor, renderAr: renderAr, mountAr: mountAr,
    noticeSeen: noticeSeen, markNoticeSeen: markNoticeSeen,
  };
});
```

- [ ] **Step 4: Run the AR test to verify it passes**

Run: `node scripts/run-suite.mjs tests/ramble-ar.test.js`
Expected: PASS (9 tests). Numeric expectations worth re-deriving if one fails: `NORTH_500` is 0.00449° north (t = 1.0 within rounding: `distance_m` 499–500 → `y` 0.34, `scale` 0.5 within 0.01); the nine right-side anchors are 0.00025° east apart (~24 m each, so `r1` is 25 m after rounding to 5); in the no-heading radar test the "e" dot uses `bearing` 90 → `x = 0.5 + 0.42·r`, `y = 0.5`.

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/panel/static/ramble-ar.js tests/ramble-ar.test.js
git commit bundles/ramble/panel/static/ramble-ar.js tests/ramble-ar.test.js -m "ramble ar: renderAr/mountAr — label layout by bearing and distance, radar fallback, bird reaction"
git show --stat HEAD
```

---

## Task 6: Panel markup + CSS — the "Look around" chip, the full-screen AR view, the notice, the AR sheet

**Files:**
- Modify: `bundles/ramble/panel/ramble.js` (ICONS; the map bar; a new AR block + sheet after `#rb-pick-sheet`; the script tags)
- Modify: `bundles/ramble/panel/static/ramble.css` (append an AR section)
- Test: `tests/ramble-panel.test.js` (the "panel handler renders …" test gains phase-4 assertions)

**Interfaces:**
- Produces element ids the client (Task 7) and the painter (Task 5) use: `rb-chip-ar`, `rb-ar` (root, `data-mode`/`data-reason` set by the painter), `rb-ar-video`, `rb-ar-mode-label`, `rb-ar-close`, `rb-ar-labels`, `rb-ar-more`, `rb-ar-coarse`, `rb-ar-radar`, `rb-ar-ring` (an SVG `<g>`), `rb-ar-list`, `rb-ar-say`, `rb-ar-bird`, `rb-ar-egg`, `rb-ar-notice`, `rb-ar-gotit`, `rb-ar-sheet`, `rb-ar-sheet-close`, `rb-ar-sheet-body`.

- [ ] **Step 1: Extend the panel shell test**

In `tests/ramble-panel.test.js`, inside the test `"panel handler renders the world-first shell, its three views and every asset"`, before the final emoji assertion add:

```js
  // Phase 4: the AR chip on the map, the full-screen view with its video,
  // labels layer, radar strip, perch, first-open notice and tap sheet, and
  // the renderer script loaded BEFORE the client that mounts it.
  assert.match(sent, /id="rb-chip-ar"/);
  assert.match(sent, /id="rb-ar"[^>]*hidden/);
  assert.match(sent, /<video id="rb-ar-video"[^>]*playsinline/);
  assert.match(sent, /<video id="rb-ar-video"[^>]*muted/);
  for (const id of ["rb-ar-close", "rb-ar-labels", "rb-ar-more", "rb-ar-coarse", "rb-ar-radar", "rb-ar-ring", "rb-ar-list", "rb-ar-say", "rb-ar-bird", "rb-ar-egg", "rb-ar-notice", "rb-ar-gotit", "rb-ar-sheet", "rb-ar-sheet-close", "rb-ar-sheet-body", "rb-ar-mode-label"]) {
    assert.match(sent, new RegExp(`id="${id}"`), id);
  }
  assert.match(sent, /\/ramble\/static\/ramble-ar\.js/);
  assert.ok(sent.indexOf("/ramble/static/ramble-ar.js") < sent.indexOf('/ramble/static/ramble.js"'), "the renderer loads before the client");
  assert.ok(sent.indexOf("/ramble/static/bird-svg.js") < sent.indexOf("/ramble/static/ramble-ar.js"), "the engine loads before the renderer");
  assert.match(sent, /motion access/, "the notice states the iOS prompt");
  assert.match(sent, /stays on this phone/, "the notice states the camera never leaves the device");
```

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js` — Expected: that test FAILS on `rb-chip-ar`.

- [ ] **Step 2: Add the markup**

In `bundles/ramble/panel/ramble.js`:

(a) Add to `ICONS` (after `flock`):

```js
  ar: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="3"/>',
```

(b) In the map bar, after the Visible chip:

```html
              <button class="rb-chip" id="rb-chip-ar" type="button" aria-haspopup="dialog">${icon("ar")}<span>Look around</span></button>
```

(c) After the closing `</div>` of `#rb-pick-sheet` (still inside `#ramble`), add:

```html
        <!-- ───────────────────────────────────────── the AR view (phase 4, spec §6) -->
        <!-- Full-screen over the rear camera. The renderer (ramble-ar.js) paints
             labels into #rb-ar-labels and dots into #rb-ar-ring; data-mode flips
             between "ar" and "radar" (never blank: no camera or no compass shows
             the ring + list). The camera picture is a background only. -->
        <div class="rb-ar" id="rb-ar" data-mode="radar" data-reason="no-fix" data-camera="on" hidden>
          <video id="rb-ar-video" class="rb-ar-video" autoplay muted playsinline aria-hidden="true"></video>

          <div class="rb-ar-top">
            <span class="rb-chip is-on rb-ar-modechip"><span id="rb-ar-mode-label">Radar</span></span>
            <button class="rb-icon-btn" id="rb-ar-close" type="button" aria-label="Close the AR view">${icon("close")}</button>
          </div>

          <div class="rb-ar-labels" id="rb-ar-labels" aria-live="polite"></div>
          <p class="rb-ar-more rb-fine" id="rb-ar-more"></p>
          <div class="rb-steps rb-ar-coarse" id="rb-ar-coarse"></div>

          <section class="rb-ar-radar" id="rb-ar-radar" aria-label="Radar strip">
            <svg class="rb-ar-ringsvg" viewBox="0 0 100 100" role="img" aria-label="Bearing ring">
              <circle class="rb-ar-ring-track" cx="50" cy="50" r="42"/>
              <circle class="rb-ar-ring-track" cx="50" cy="50" r="21"/>
              <path class="rb-ar-ring-north" d="M50 3l3.5 7h-7z"/>
              <circle class="rb-ar-ring-me" cx="50" cy="50" r="2.4"/>
              <g id="rb-ar-ring"></g>
            </svg>
            <div class="rb-steps rb-ar-list" id="rb-ar-list"></div>
          </section>

          <div class="rb-ar-perch">
            <div class="rb-say" id="rb-ar-say">Getting your bearings&hellip;</div>
            <svg id="rb-ar-bird" class="rb-bird rb-ar-bird" viewBox="0 0 200 200" role="img" aria-label="Your bird" hidden></svg>
            <svg id="rb-ar-egg" class="rb-eggart rb-ar-egg" viewBox="0 0 120 152" role="img" aria-label="Your egg"></svg>
          </div>

          <section class="rb-card rb-ar-notice" id="rb-ar-notice" hidden>
            <p class="rb-eyebrow">Before you look around</p>
            <h3 class="rb-h">What this can and can&rsquo;t do</h3>
            <ul class="rb-fine rb-ar-limits">
              <li>Labels float by <strong>direction and distance</strong> only. Nothing sticks to walls or the ground.</li>
              <li>Direction comes from the phone&rsquo;s compass, which can be off by tens of degrees. Hold the phone upright; if labels drift, wave it in a figure eight.</li>
              <li>On an iPhone, Safari asks once for <strong>motion access</strong>. Say no and you get the radar strip instead.</li>
              <li>No camera or no compass means the <strong>radar strip</strong>: a bearing ring and a distance list. Never a blank screen.</li>
              <li>The camera picture <strong>stays on this phone</strong>. Nothing from it is sent anywhere.</li>
            </ul>
            <button class="rb-btn" id="rb-ar-gotit" type="button">Got it</button>
          </section>
        </div>

        <!-- A tapped AR label opens the SAME popup its map pin would, in a sheet. -->
        <div class="rb-sheet rb-ar-sheet" id="rb-ar-sheet" hidden>
          <div class="rb-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rb-ar-sheet-title">
            <div class="rb-sheet-head">
              <h3 class="rb-h" id="rb-ar-sheet-title">Right there</h3>
              <button class="rb-icon-btn" id="rb-ar-sheet-close" type="button" aria-label="Close">${icon("close")}</button>
            </div>
            <div id="rb-ar-sheet-body"></div>
          </div>
        </div>
```

(d) Script tags — the renderer between the engine and the client:

```html
      <script src="/ramble/static/leaflet/leaflet.js"></script>
      <script src="/ramble/static/bird-svg.js"></script>
      <script src="/ramble/static/ramble-ar.js"></script>
      <script src="/ramble/static/ramble.js"></script>
```

(e) Update the file header comment's "Phase 3" paragraph with one more: `Phase 4: the map bar gains "Look around", which opens #rb-ar — a full-screen camera view painted by static/ramble-ar.js (labels by bearing and distance, a radar strip when the camera or compass is missing).`

- [ ] **Step 3: Add the CSS**

Append to `bundles/ramble/panel/static/ramble.css`:

```css
/* ------------------------------------------------------------ AR (phase 4) */

/* Full screen, above the page, below the sheets (1200) so a tapped label's
   sheet lands on top of the view. The ground is the video; when there is no
   camera the surface-2 paper shows through and the radar strip fills it. */
#ramble .rb-ar {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: var(--rb-surface-2);
  color: var(--rb-text);
  overflow: hidden;
  font-family: var(--rb-font-body);
}
#ramble .rb-ar-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
}
#ramble .rb-ar[data-camera="off"] .rb-ar-video { display: none; }

#ramble .rb-ar-top {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 10px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
#ramble .rb-ar-modechip { pointer-events: none; }

#ramble .rb-ar-labels { position: absolute; inset: 0; z-index: 2; }
#ramble .rb-ar-label {
  position: absolute;
  transform-origin: 50% 50%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  max-width: 46vw;
  padding: 8px 12px;
  border: var(--rb-line-w) solid var(--rb-line);
  border-radius: 14px;
  background: var(--rb-surface);
  color: var(--rb-text);
  box-shadow: var(--rb-pop-sm);
  font: 700 13px/1.25 var(--rb-font-body);
  text-align: left;
  cursor: pointer;
  min-height: var(--rb-tap);
}
#ramble .rb-ar-label strong {
  font: 800 14px/1.2 var(--rb-font-display);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
#ramble .rb-ar-label span { color: var(--rb-muted); font-size: 12px; }
#ramble .rb-ar-label[data-locked="true"] { border-style: dashed; background: color-mix(in oklab, var(--rb-surface) 80%, var(--rb-accent-2)); }
#ramble .rb-ar-label[data-kind="nest"] { border-color: var(--rb-accent); }
#ramble .rb-ar-label[data-kind="caw"] { border-radius: 18px 18px 4px 18px; }
#ramble .rb-ar-label:focus-visible { outline: 3px solid var(--rb-accent-2); outline-offset: 3px; }
/* Parked at an edge: an arrow points off-screen towards the anchor. */
#ramble .rb-ar-label[data-side]::before {
  content: "";
  position: absolute;
  top: 50%;
  width: 0;
  height: 0;
  border: 7px solid transparent;
  transform: translateY(-50%);
}
#ramble .rb-ar-label[data-side="left"] { align-items: flex-start; }
#ramble .rb-ar-label[data-side="left"]::before { right: 100%; border-right-color: var(--rb-line); }
#ramble .rb-ar-label[data-side="right"]::before { left: 100%; border-left-color: var(--rb-line); }

#ramble .rb-ar-more {
  position: absolute;
  left: 12px;
  right: 12px;
  top: 64px;
  z-index: 2;
  margin: 0;
  text-align: center;
  color: var(--rb-text);
  text-shadow: 0 0 6px var(--rb-surface);
}
#ramble .rb-ar-more:empty { display: none; }

/* Coarse anchors ("somewhere in this area") sit under the top bar. */
#ramble .rb-ar-coarse {
  position: absolute;
  left: 12px;
  right: 12px;
  top: 92px;
  z-index: 2;
  gap: 6px;
}
#ramble .rb-ar-coarse:empty { display: none; }
#ramble .rb-ar-row { text-align: left; cursor: pointer; width: 100%; }
#ramble .rb-ar-row:focus-visible { outline: 3px solid var(--rb-accent-2); outline-offset: 3px; }

/* The radar strip. In AR mode it shrinks to the ring alone, bottom-left;
   in radar mode it owns the lower half: ring + distance list. */
#ramble .rb-ar-radar {
  position: absolute;
  z-index: 2;
  display: flex;
  gap: 12px;
}
#ramble .rb-ar-ringsvg {
  width: 112px;
  height: 112px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: color-mix(in oklab, var(--rb-surface) 85%, transparent);
  border: var(--rb-line-w) solid var(--rb-line);
  box-shadow: var(--rb-pop-sm);
}
#ramble .rb-ar-ring-track { fill: none; stroke: var(--rb-muted); stroke-width: 1; stroke-dasharray: 2 2; }
#ramble .rb-ar-ring-north { fill: var(--rb-accent-3); }
#ramble .rb-ar-ring-me { fill: var(--rb-text); }
#ramble .rb-ar-dot { fill: var(--rb-accent-2); stroke: var(--rb-line); stroke-width: .8; }
#ramble .rb-ar-dot-nest { fill: var(--rb-accent); }
#ramble .rb-ar-dot-caw { fill: var(--rb-accent-3); }
#ramble .rb-ar-dot.is-locked { fill: var(--rb-surface); stroke-dasharray: 1.5 1; }
#ramble .rb-ar[data-mode="ar"] .rb-ar-radar { left: 12px; bottom: 20px; }
#ramble .rb-ar[data-mode="ar"] .rb-ar-list { display: none; }
#ramble .rb-ar[data-mode="radar"] .rb-ar-labels,
#ramble .rb-ar[data-mode="radar"] .rb-ar-coarse,
#ramble .rb-ar[data-mode="radar"] .rb-ar-more { display: none; }
#ramble .rb-ar[data-mode="radar"] .rb-ar-radar {
  left: 0;
  right: 0;
  bottom: 0;
  top: 44%;
  flex-direction: column;
  align-items: center;
  padding: 14px 14px 150px;
  background: var(--rb-surface);
  border-top: var(--rb-line-w) solid var(--rb-line);
  border-radius: var(--rb-radius) var(--rb-radius) 0 0;
  overflow-y: auto;
}
#ramble .rb-ar[data-mode="radar"] .rb-ar-ringsvg { width: 168px; height: 168px; }
#ramble .rb-ar-list { width: 100%; }

/* The perch: your bird (or egg) bottom centre, its line beside it. */
#ramble .rb-ar-perch {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 16px;
  z-index: 4;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
}
#ramble .rb-ar-perch > * { pointer-events: auto; }
#ramble .rb-ar-perch .rb-say { max-width: 200px; transform: rotate(-2deg); }
#ramble .rb-ar-bird { width: 132px; height: 132px; display: block; filter: drop-shadow(3px 4px 0 var(--rb-shadow-col)); transform-origin: 50% 100%; }
#ramble .rb-ar-egg { width: 52px; height: 66px; margin: 0 10px 6px; }
@keyframes rb-ar-hop {
  0% { transform: translateY(0) rotate(0); }
  30% { transform: translateY(-16px) rotate(-6deg); }
  60% { transform: translateY(0) rotate(3deg); }
  100% { transform: translateY(0) rotate(0); }
}
#ramble .rb-ar-bird.rb-ar-react { animation: rb-ar-hop .9s cubic-bezier(.2, 1.2, .4, 1); }

/* The first-open notice gates everything; it is the only thing on screen until "Got it". */
#ramble .rb-ar-notice {
  position: absolute;
  left: 14px;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  max-height: 86vh;
  overflow-y: auto;
}
#ramble .rb-ar-limits { margin: 0 0 12px; padding-left: 20px; display: grid; gap: 8px; }

#ramble .rb-ar-sheet .rb-pop-head { font: 800 15px var(--rb-font-display); display: flex; align-items: center; gap: 8px; }
#ramble .rb-ar-sheet .rb-pop-bird { width: 40px; height: 40px; }
#ramble .rb-ar-sheet .rb-pop-body { margin: 6px 0 0; }
#ramble .rb-ar-sheet .rb-pop-btn { margin-top: 10px; }

@media (prefers-reduced-motion: reduce) {
  #ramble .rb-ar-bird.rb-ar-react { animation: none; }
}
```

- [ ] **Step 4: Pin the two CSS-only §6 behaviours, then run the panel tests**

In `tests/ramble-panel.test.js`, inside `"GET /ramble/static/ramble.css serves the panel stylesheet"`, after the existing assertions add:

```js
  // Phase 4: the edge arrow on a parked label and the dashed locked teaser are
  // CSS-only halves of two spec §6 requirements — pin the selectors.
  assert.match(body, /\.rb-ar-label\[data-side\]::before/);
  assert.match(body, /\.rb-ar-label\[data-locked="true"\]/);
  assert.match(body, /\.rb-ar\[data-camera="off"\] \.rb-ar-video/);
  assert.match(body, /\.rb-ar\[data-mode="radar"\] \.rb-ar-radar/);
```

(If that test reads the body into a differently named variable, use that name.)

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js`
Expected: PASS (the shell test with its phase-4 lines; the CSS test with the four selector pins).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js -m "ramble panel: Look around chip, the AR view, its notice and tap sheet"
git show --stat HEAD
```

---

## Task 7: Client wiring — devices, anchors, taps, live refresh, teardown

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js` (header comment; `paintPet` stores `lastPet` and nudges the AR render; a new `ar` section AFTER the hatch section — between `if (meetBtn) …` and `/* ---- nearby live updates */`; two SSE listeners; nothing else moves)
- Test: `tests/ramble-panel.test.js` (the `GET /ramble/static/ramble.js` test gains phase-4 assertions; a new test serves `ramble-ar.js`)

**Interfaces:**
- Consumes: `window.RambleAr` (Task 5: `mountAr`, `headingFromEvent`, `smoothHeading`), `GET /api/ramble/around` (Task 4), the ids from Task 6, and the existing `popupFor(mark)`, `nestPopup(nest)`, `isLocked`, `drawEggArt`, `haversineMeters`, `jsonFetch`, `here`/`lastFix`, `Bird`, `eggSeedId`.
- Produces: `lastPet` (set by `paintPet`); the section's functions are internal.

- [ ] **Step 1: Extend the client-script tests**

In `tests/ramble-panel.test.js`, inside `"GET /ramble/static/ramble.js serves the client script as JavaScript"`, before `const code = body.replace(...)` add:

```js
  // Phase 4 wiring: the around fetch, the three device doors (camera,
  // watchPosition, absolute orientation with the iOS fallback and prompt),
  // the renderer mount, the SAME popup builders behind a tapped label, the
  // live-event refreshes, teardown on close and on a hidden tab — and no
  // capture API anywhere (camera frames never leave the device).
  assert.ok(body.includes('"/api/ramble/around?lat=" + encodeURIComponent(arPose.lat.toFixed(6))'), "client must fetch anchors around the fix, at a bounded precision");
  assert.ok(body.includes('facingMode: "environment"'));
  assert.ok(body.includes("navigator.mediaDevices.getUserMedia("));
  assert.ok(body.includes("navigator.geolocation.watchPosition("));
  assert.ok(body.includes("navigator.geolocation.clearWatch("));
  assert.ok(body.includes('"deviceorientationabsolute"'));
  assert.ok(body.includes("DeviceOrientationEvent.requestPermission"));
  assert.ok(body.includes("Ar.headingFromEvent(") && body.includes("Ar.smoothHeading("));
  assert.ok(body.includes("Ar.mountAr("));
  assert.ok(body.includes("nestPopup(anchor.source)") && body.includes("popupFor(anchor.source)"), "a label tap opens the pin's own popup");
  assert.ok(body.includes('"ramble.ar.limits"'));
  assert.ok(body.includes("getTracks().forEach"), "the camera stream is stopped on close");
  assert.ok(body.includes('"visibilitychange"'));
  assert.ok(body.includes("AR_HEADING_STALE_MS"), "a stale compass falls back to the ring");
  assert.ok(!/toDataURL|toBlob|captureStream|ImageCapture|MediaRecorder|drawImage|getContext\(/.test(body), "camera frames never leave the device");
```

Append a new test after the `ramble.css` test:

```js
test("GET /ramble/static/ramble-ar.js serves the renderer as JavaScript: zero backticks, zero markup sinks, no emoji, no capture APIs, classic script", async () => {
  const res = await req("/ramble/static/ramble-ar.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
  const body = await res.text();
  assert.ok(body.length > 100);
  assert.equal(body.split("`").length - 1, 0, "zero backticks");
  assert.ok(!/^\s*(import|export)\s/m.test(body), "a classic script");
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(code.match(/\.innerHTML\s*=|\bhtml:\s|insertAdjacentHTML|outerHTML/g) || [], [], "zero markup sinks");
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(body), "no emoji");
  assert.ok(!/toDataURL|toBlob|captureStream|ImageCapture|MediaRecorder|drawImage|getContext\(/.test(body));
  assert.ok(body.includes("window.RambleAr = api"));
  assert.equal((await realFetch(BASE + "/ramble/static/ramble-ar.js")).status, 401);
});
```

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js` — Expected: the `ramble.js` test FAILS on the around fetch; the new `ramble-ar.js` test PASSES already (Task 5 created the file).

- [ ] **Step 2: Wire the client**

In `bundles/ramble/panel/static/ramble.js`:

(a) Header comment — extend the "Sections, in order" line to `… nests, hatch, ar, stream, startup.` and add a paragraph:

```
 * Phase 4: the AR view. This file owns the DEVICES (camera, GPS watch,
 * orientation) and the adapter from server rows to the renderer's anchors;
 * static/ramble-ar.js owns the maths and the painting. A tapped label opens
 * the same popup its map pin would (popupFor / nestPopup) inside #rb-ar-sheet,
 * so every AR action is a pin action. The camera stream is a background:
 * nothing reads its frames, nothing uploads.
```

(b) In `paintPet`, right after `if (!pet) return;` add `lastPet = pet;`, and at the END of `paintPet` add `if (arOpen) scheduleArRender();` (both are hoisted: `arOpen` is a `var` in the AR section below, `scheduleArRender` a function declaration — so the bird appears in AR the moment the pet loads, not a heartbeat later). Declare `var lastPet = null;` at the top of the pet section (next to `MOOD_LINE`).

(c) Insert the AR section between the hatch section (after `if (meetBtn) …`) and `/* ---- nearby live updates */`:

```js
  /* ------------------------------------------------------------------- ar */

  var Ar = window.RambleAr || null;
  var arRoot = $("rb-ar");
  var arSheet = $("rb-ar-sheet");
  var arSession = null;        /* the painter, mounted once */
  var arOpen = false;          /* devices are live */
  var arPose = { lat: null, lon: null, accuracy_m: null, heading: null };
  var arCamera = true;
  var arAnchors = [];
  var arStream = null;
  var arWatch = null;
  var arHeadingEvent = null;   /* which orientation event we listen to */
  var arFetchAt = null;        /* { lat, lon, t } of the last around fetch */
  var arRaf = null;
  var arTick = null;           /* 1 s heartbeat while open: staleness shows even with no events */
  var arHeadingAt = 0;         /* when the last usable heading arrived */
  var AR_REFETCH_M = 50;
  var AR_REFETCH_MS = 60000;
  var AR_HEADING_STALE_MS = 5000;
  var AR_MIN_TURN_DEG = 0.5;   /* orientation events below this do not repaint */
  var AR_NOTICE_KEY = "ramble.ar.limits";

  function arTitle(mark) {
    if (isLocked(mark)) return "A locked mark";
    if (mark.kind === "caw") return "A caw" + (mark.contact_name ? " from " + mark.contact_name : "");
    var t = String(mark.content_text || "(no text)").trim();
    return t.length > 40 ? t.slice(0, 39) + "…" : t;
  }

  /** Server rows -> the renderer's anchors. lat/lon/accuracy exactly as stored; a locked teaser rides its cell centre with the cell's error radius. */
  function toArAnchors(out) {
    var list = [];
    ((out && out.marks) || []).forEach(function (mark) {
      var exact = typeof mark.lat === "number" && typeof mark.lon === "number";
      var lat = exact ? mark.lat : mark.approx_lat;
      var lon = exact ? mark.lon : mark.approx_lon;
      if (typeof lat !== "number" || typeof lon !== "number") return;
      list.push({
        id: "m:" + mark.mark_id,
        kind: mark.kind === "caw" ? "caw" : "mark",
        lat: lat,
        lon: lon,
        accuracy_m: typeof mark.accuracy_m === "number" ? mark.accuracy_m : null,
        approx_m: exact ? 0 : (typeof mark.approx_m === "number" ? mark.approx_m : 0),
        locked: isLocked(mark),
        title: arTitle(mark),
        source: mark,
      });
    });
    ((out && out.nests) || []).forEach(function (nest) {
      list.push({
        id: "n:" + nest.cell, kind: "nest", lat: nest.lat, lon: nest.lon, accuracy_m: null, approx_m: 0, locked: false,
        title: nest.claimed ? "A nest (yours)" : "A nest", source: nest,
      });
    });
    return list;
  }

  function arBirdState() {
    var bird = lastPet && lastPet.bird;
    if (!bird) return null;
    return { species: bird.species, seed: bird.seed, mood: lastPet.mood || "happy" };
  }

  function scheduleArRender() {
    if (!arOpen || !arSession || arRaf) return;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    arRaf = raf(function () {
      arRaf = null;
      if (!arOpen || !arSession) return;
      /* A compass that stopped reporting (screen lock, sensor hiccup) must not
       * keep placing labels with confidence: a stale heading falls back to the ring. */
      if (arPose.heading != null && Date.now() - arHeadingAt > AR_HEADING_STALE_MS) arPose.heading = null;
      arSession.render({ anchors: arAnchors, pose: arPose, bird: arBirdState(), camera: arCamera });
    });
  }

  function refreshAround() {
    if (!arOpen || typeof arPose.lat !== "number" || typeof arPose.lon !== "number") return Promise.resolve();
    arFetchAt = { lat: arPose.lat, lon: arPose.lon, t: Date.now() };
    /* toFixed(6) is ~0.1 m: enough for a label, and never a 400 from a long double. */
    return jsonFetch("/api/ramble/around?lat=" + encodeURIComponent(arPose.lat.toFixed(6)) + "&lon=" + encodeURIComponent(arPose.lon.toFixed(6)))
      .then(function (out) { arAnchors = toArAnchors(out); scheduleArRender(); })
      .catch(function () { /* keep the last anchors; the pose still moves them */ });
  }

  function maybeRefreshAround() {
    if (!arFetchAt) { refreshAround(); return; }
    var moved = haversineMeters({ lat: arFetchAt.lat, lon: arFetchAt.lon }, { lat: arPose.lat, lon: arPose.lon });
    if (moved >= AR_REFETCH_M || Date.now() - arFetchAt.t >= AR_REFETCH_MS) refreshAround();
  }

  function screenAngle() {
    try {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === "number") return window.screen.orientation.angle;
      if (typeof window.orientation === "number") return window.orientation;
    } catch (e) { /* not fatal */ }
    return 0;
  }

  function onArOrientation(ev) {
    var h = Ar.headingFromEvent(ev, screenAngle());
    if (h == null) return;
    arHeadingAt = Date.now();
    var next = Ar.smoothHeading(arPose.heading, h, 0.3);
    /* Orientation fires at up to 60 Hz; a sub-degree wobble is not a repaint. */
    if (arPose.heading != null && Math.abs(Ar.relativeBearing(next, arPose.heading)) < AR_MIN_TURN_DEG) return;
    arPose.heading = next;
    scheduleArRender();
  }

  function startArHeading() {
    /* Absolute orientation where the platform has it; iOS reports webkitCompassHeading on the plain event. */
    arHeadingEvent = ("ondeviceorientationabsolute" in window) ? "deviceorientationabsolute" : "deviceorientation";
    window.addEventListener(arHeadingEvent, onArOrientation);
  }

  function stopArHeading() {
    if (!arHeadingEvent) return;
    window.removeEventListener(arHeadingEvent, onArOrientation);
    arHeadingEvent = null;
  }

  /** iOS 13+: orientation events need a permission granted from a user gesture. Resolves either way — a refusal is the radar strip. */
  function requestArMotion() {
    try {
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
        return DeviceOrientationEvent.requestPermission().catch(function () { return "denied"; });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve("granted");
  }

  /** restart = a return from a hidden tab: a camera that worked a second ago gets one retry before the view gives up on it. */
  function startArCamera(restart) {
    var video = $("rb-ar-video");
    if (!video || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      arCamera = false;
      scheduleArRender();
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (stream) {
        if (!arOpen) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        arStream = stream;
        video.srcObject = stream;
        var p = video.play();
        if (p && typeof p.catch === "function") p.catch(function () { /* autoplay policy: the frame still paints */ });
        arCamera = true;
        scheduleArRender();
      })
      .catch(function () {
        if (restart === true && arOpen) { setTimeout(function () { if (arOpen && !arStream) startArCamera(false); }, 1500); return; }
        arCamera = false;
        scheduleArRender();
      });
  }

  function stopArCamera() {
    var video = $("rb-ar-video");
    if (arStream) { arStream.getTracks().forEach(function (t) { t.stop(); }); arStream = null; }
    if (video) { try { video.srcObject = null; } catch (e) { /* not fatal */ } }
  }

  function startArGps() {
    if (lastFix) {
      arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
      refreshAround();
      scheduleArRender();
    }
    if (!navigator.geolocation) return;
    arWatch = navigator.geolocation.watchPosition(function (pos) {
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy_m: pos.coords.accuracy };
      arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
      maybeRefreshAround();
      scheduleArRender();
    }, function (err) {
      /* Permission pulled mid-session (code 1): the old fix is a lie now — back to "Waiting for a fix…". A timeout keeps the last fix. */
      if (err && err.code === 1) { arPose.lat = null; arPose.lon = null; arAnchors = []; }
      scheduleArRender();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function stopArGps() {
    if (arWatch == null || !navigator.geolocation) { arWatch = null; return; }
    try { navigator.geolocation.clearWatch(arWatch); } catch (e) { /* gone */ }
    arWatch = null;
  }

  function arElements() {
    return {
      root: arRoot, labels: $("rb-ar-labels"), radar: $("rb-ar-ring"), list: $("rb-ar-list"), coarse: $("rb-ar-coarse"),
      bird: $("rb-ar-bird"), egg: $("rb-ar-egg"), say: $("rb-ar-say"), more: $("rb-ar-more"), mode: $("rb-ar-mode-label"),
    };
  }

  /** A label tap = the pin's own popup, in a sheet. */
  function onArTap(id) {
    var anchor = arSession && arSession.anchor(id);
    if (!anchor || !anchor.source) return;
    openArSheet(anchor.kind === "nest" ? nestPopup(anchor.source) : popupFor(anchor.source));
  }

  function openArSheet(node) {
    var body = $("rb-ar-sheet-body");
    if (!arSheet || !body) return;
    body.textContent = "";
    body.appendChild(node);
    arSheet.hidden = false;
  }

  function closeArSheet() {
    if (!arSheet || arSheet.hidden) return;
    arSheet.hidden = true;
    var body = $("rb-ar-sheet-body");
    if (body) body.textContent = "";
    /* An unlock or a claim may have changed what is around. */
    refreshAround();
  }

  /**
   * Devices start HERE, synchronously inside the user's click: getUserMedia and
   * DeviceOrientationEvent.requestPermission both want transient activation, so
   * the camera prompt is issued first and the motion prompt right after it in
   * the same handler (Q2) — never after an awaited promise.
   */
  function startAr() {
    if (!Ar || !arRoot) return;
    arOpen = true;
    arRoot.hidden = false;
    if (!arSession) arSession = Ar.mountAr(arElements(), { engine: Bird, onTap: onArTap });
    drawEggArt($("rb-ar-egg"), eggSeedId);
    arPose = { lat: null, lon: null, accuracy_m: null, heading: null };
    arHeadingAt = 0;
    arCamera = true;
    arAnchors = [];
    arFetchAt = null;
    scheduleArRender();
    startArCamera();
    requestArMotion().then(function () { if (arOpen) startArHeading(); });
    startArGps();
    if (!arTick) arTick = setInterval(scheduleArRender, 1000);
    refreshPet();
  }

  function closeAr() {
    arOpen = false;
    closeArSheet();
    stopArCamera();
    stopArGps();
    stopArHeading();
    if (arTick) { clearInterval(arTick); arTick = null; }
    if (arRaf) { try { (window.cancelAnimationFrame || clearTimeout)(arRaf); } catch (e) { /* not fatal */ } arRaf = null; }
    if (arSession) arSession.destroy();
    var notice = $("rb-ar-notice");
    if (notice) notice.hidden = true;
    if (arRoot) arRoot.hidden = true;
  }

  function arStorage() { return window.localStorage; }
  function arNoticeSeen() { return Ar.noticeSeen(arStorage, AR_NOTICE_KEY); }
  function markArNoticeSeen() { Ar.markNoticeSeen(arStorage, AR_NOTICE_KEY); }

  /** The chip. First time: the notice, and NOTHING starts until "Got it". After that: the devices, from the click itself. */
  function openAr() {
    if (!Ar || !arRoot) return;
    var notice = $("rb-ar-notice");
    if (!arNoticeSeen() && notice) {
      notice.hidden = false;
      arRoot.hidden = false;
      return;
    }
    startAr();
  }

  var arChip = $("rb-chip-ar");
  if (arChip) {
    if (!Ar) arChip.hidden = true;
    /* openAr runs synchronously in the click so the device prompts keep the gesture. */
    arChip.addEventListener("click", function () { if (!arOpen) openAr(); });
  }
  var arClose = $("rb-ar-close");
  if (arClose) arClose.addEventListener("click", closeAr);
  var arGotIt = $("rb-ar-gotit");
  if (arGotIt) {
    arGotIt.addEventListener("click", function () {
      markArNoticeSeen();
      var notice = $("rb-ar-notice");
      if (notice) notice.hidden = true;
      startAr();
    });
  }
  var arSheetClose = $("rb-ar-sheet-close");
  if (arSheetClose) arSheetClose.addEventListener("click", closeArSheet);
  if (arSheet) arSheet.addEventListener("click", function (ev) { if (ev.target === arSheet) closeArSheet(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (arSheet && !arSheet.hidden) { closeArSheet(); return; }
    if (arRoot && !arRoot.hidden) closeAr();
  });
  /* A backgrounded tab must not keep the camera; coming back restarts it in place (Q3 — the view stays open). */
  document.addEventListener("visibilitychange", function () {
    if (!arOpen) return;
    if (document.hidden) { stopArCamera(); return; }
    startArCamera(true);
  });
```

(d) In the SSE block, extend two listeners:

```js
    stream.addEventListener("ramble-nearby", function () { refreshMarks(); refreshPet(); if (arOpen) refreshAround(); });
    …
    stream.addEventListener("ramble-nest-claimed", function () { refreshNests(); refreshFlock(); if (arOpen) refreshAround(); });
```

- [ ] **Step 3: Run the panel tests**

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js`
Expected: PASS. In particular the `ramble.js` test's sink count is still EXACTLY 2 — the AR section adds none (`textContent` and `appendChild` only; the egg goes through `drawEggArt`).

Also run: `node scripts/run-suite.mjs tests/ramble-ar.test.js tests/ramble-around.test.js` — Expected: PASS (unchanged).

- [ ] **Step 4: Browser smoke — what the suite cannot exercise**

The suite proves the maths, the painter and the wiring strings; it cannot open a camera or a compass. Two smokes, each with a clear scope:

(a) **Desktop, radar path only, before the PR.** A scratch gateway (never the live data dir), reachable as `http://localhost` — a secure context for `localhost` only, so the camera prompt appears on desktop Chrome but there is no compass: the view must land in "Radar · no compass" with the ring and the list, and a label/row tap must open the sheet.

```bash
cd /home/kh0pp/crow-wt-flock4
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
export CROW_DATA_DIR=/tmp/claude-1000/-home-kh0pp-crow/a4059502-d556-46f5-b8b0-182af2b95e0d/scratchpad/ar-smoke
mkdir -p "$CROW_DATA_DIR" && node scripts/init-db.js
CROW_GATEWAY_PORT=3097 timeout 900 node servers/gateway/index.js --no-auth
```

(`timeout 900` caps it; run it in the background with `run_in_background` and stop it when done.) If `/dashboard/ramble` is 404 on the scratch instance because the bundle is not installed there, skip (a) and say so in the PR body — do NOT point a scratch gateway at `~/.crow`.

(b) **Phone, full checklist, on the DEPLOYED instance over HTTPS after merge** (Task 8, Step 8; a raw-IP `http://` URL is not a secure context and can only ever show the radar strip): (1) chip → notice → Got it → camera prompt then (iPhone) motion prompt → labels move with the phone; (2) turn 180° → labels park with arrows; (3) deny the camera → "Radar · no camera", ring + list, never blank; (4) tap a locked label → sheet with "Unlock here"; tap a nest label → "Take the egg"; (5) switch apps and back → the camera restarts, the view is still open; (6) close → the camera indicator goes off. Record both outcomes in the PR body (and the handoff).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel/static/ramble.js tests/ramble-panel.test.js -m "ramble panel client: the AR view — camera, GPS watch, compass, anchors, label taps open the pin popups"
git show --stat HEAD
```

---

## Task 8: Docs en/es, spec amendments, version bump, registry, integration gate, PR, deploy, handoff

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json` (generated), this plan (its `## Review` log is already in it).

- [ ] **Step 1: English guide**

In `docs/guide/ramble.md`:

(a) In `## Contacts and groups`, after the sentence ending "…and it counts as meeting their bird for warmth." add:

```
A contact's marks are bounded by retention: you keep the newest 50 from each contact and older ones are pruned as new ones arrive (their `created_at` comes from the sender, so a per-day cap would be their clock to game). Blocking stays the hard stop.
```

(b) After the `## Gifts and swaps` section and before `## Just me marks`, insert:

```
## The AR view

Tap **Look around** on the map to open the AR view: the rear camera fills the screen and every mark, caw and nest within about 500 m gets a label placed by direction and distance. Labels within 35° of where you face sit on the picture, nearer ones lower and larger; the rest park at the left or right edge with an arrow, stacked by distance. Locked marks are dashed labels with a walking distance measured to their cell centre (they carry no exact position, same as on the map). Tapping any label opens the same actions as its map pin — unlock, take the egg, read the text, share an invite. Your active bird sits at the bottom, hops when a label comes into view, and says what is nearest. A caw that only carries its coarse publish cell is listed as "somewhere in this area" and never given a direction.

Position comes from `watchPosition`; heading from `deviceorientationabsolute` (Safari reports `webkitCompassHeading` on the plain event, and iOS asks once for motion access from the button tap). No fix, no camera or no compass falls back to the **radar strip** — a bearing ring (north up, or heading up when there is a compass) and a distance list — so the screen is never blank; the first open explains the limits (compass accuracy, the iOS prompt, no surface placement, the camera stays on the phone). The camera picture never leaves the device: the view is client-side rendering with no capture, canvas or upload, and the stream stops when you close the view or switch away from the tab (it restarts when you come back).

The panel fetches `GET /api/ramble/around?lat=&lon=&radius_m=` (radius 50–1000 m, default 500): marks as stored (a locked mark as its cell-centre teaser, a contact's mark named), each with `distance_m`, plus this week's nests, nearest first. The panel lists what the map lists (public, contacts and your own "Just me" marks). It refreshes after you move 50 m, once a minute, when you close a tapped label, and on every live event. It is a read and credits nothing. The view needs a secure context: open the Nest over its HTTPS Tailscale Serve address, not a raw-IP `http://` URL, or the browser refuses the camera and the compass and you get the radar strip.
```

(c) In `## Operating notes` append a paragraph:

```
The AR view is client-only: the gateway sees `GET /api/ramble/around` and nothing else new. A phone that shows "Radar · no compass" on Android usually has no `deviceorientationabsolute` support in that browser; "Radar · no camera" on any device means the permission was refused or the page is not a secure context.
```

- [ ] **Step 2: Spanish guide (same headings, same order)**

In `docs/es/guide/ramble.md`:

(a) In `## Contactos y grupos`, after the sentence ending "…y cuenta como haber conocido a su pájaro para el calor." add:

```
Las marcas de un contacto están acotadas por retención: conservas las 50 más recientes de cada contacto y las más antiguas se eliminan cuando llegan nuevas (su `created_at` lo pone quien envía, así que un tope diario sería su reloj para hacer trampa). Bloquear sigue siendo el freno definitivo.
```

(b) After `## Regalos e intercambios` and before `## Marcas solo para mí`, insert:

```
## La vista AR

Toca **Mirar alrededor** en el mapa para abrir la vista AR: la cámara trasera llena la pantalla y cada marca, caw y nido a menos de unos 500 m recibe una etiqueta colocada por dirección y distancia. Las etiquetas a menos de 35° de hacia donde miras se posan sobre la imagen, las más cercanas más abajo y más grandes; el resto se aparca en el borde izquierdo o derecho con una flecha, apiladas por distancia. Las marcas bloqueadas son etiquetas discontinuas con una distancia a pie medida hasta el centro de su celda (no llevan posición exacta, igual que en el mapa). Tocar cualquier etiqueta abre las mismas acciones que su pin del mapa — desbloquear, tomar el huevo, leer el texto, compartir una invitación. Tu pájaro activo se posa abajo, salta cuando una etiqueta entra en vista y dice qué es lo más cercano. Un caw que solo lleva su celda de publicación gruesa se lista como "en algún lugar por aquí" y nunca recibe una dirección.

La posición viene de `watchPosition`; el rumbo de `deviceorientationabsolute` (Safari informa `webkitCompassHeading` en el evento normal, y iOS pide una vez acceso al movimiento desde el toque del botón). Sin posición, sin cámara o sin brújula se recurre a la **franja de radar** — un anillo de rumbos (norte arriba, o rumbo arriba cuando hay brújula) y una lista de distancias — así que la pantalla nunca queda en blanco; la primera apertura explica los límites (precisión de la brújula, el aviso de iOS, sin anclaje a superficies, la cámara se queda en el teléfono). La imagen de la cámara nunca sale del dispositivo: la vista se dibuja en el cliente sin captura, canvas ni subida, y el flujo se detiene al cerrar la vista o cambiar de pestaña (se reanuda al volver).

El panel consulta `GET /api/ramble/around?lat=&lon=&radius_m=` (radio 50–1000 m, 500 por defecto): marcas tal como están guardadas (una marca bloqueada como su adelanto en el centro de la celda, la marca de un contacto con su nombre), cada una con `distance_m`, más los nidos de esta semana, los más cercanos primero. El panel lista lo mismo que el mapa (marcas públicas, de contactos y tus propias marcas "solo para mí"). Se actualiza tras moverte 50 m, una vez por minuto, al cerrar una etiqueta tocada y con cada evento en vivo. Es una lectura y no acredita nada. La vista necesita un contexto seguro: abre el Nest por su dirección HTTPS de Tailscale Serve, no por una URL `http://` con IP, o el navegador rechaza la cámara y la brújula y obtienes la franja de radar.
```

(c) In `## Notas de operación` append:

```
La vista AR es solo del cliente: el gateway ve `GET /api/ramble/around` y nada más nuevo. Un teléfono que muestra "Radar · no compass" en Android normalmente no tiene soporte de `deviceorientationabsolute` en ese navegador; "Radar · no camera" en cualquier dispositivo significa que se rechazó el permiso o que la página no es un contexto seguro.
```

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js` — Expected: PASS (the parity test sees one new `##` at the same position in both files).

- [ ] **Step 3: Spec amendments (record what phase 4 decided)**

In `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`:

(a) At the end of §6 add:

```
- **Amendments (phase 4, as built).** `renderAr({ anchors, pose, bird, camera })`: `camera` is an
  optional fourth field (default true) so the renderer, not the device code, decides the mode —
  `"ar"` only with a fix AND a camera AND a heading, else `"radar"` with a reason. Positions are
  viewport fractions (`y = 0.70 − 0.36·t`, `scale = 1 − 0.5·t`, `t = min(1, d/500)`), parked labels
  stack at `x = 0.06/0.94` by distance rank, six per edge. An anchor whose error radius exceeds
  150 m (a 5-char wire caw) gets no direction ("somewhere in this area"); a 7-char locked teaser
  (~101 m) is a dashed directional label. Heading: `webkitCompassHeading`, else `360 − alpha +
  screen angle` from an absolute event only, low-passed at 0.3, dropped after 5 s of silence. The
  bird "speaks its context line" as a NAVIGATION line ("<title>, <n> m ahead."), not the perch's
  mood line — in AR the useful thing to say is what is nearest. The camera stream is stopped while
  the tab is hidden and restarted on return; the view stays open. Inbound `/around` lists what the
  map lists (public, contacts, own private). The renderer is a classic script (`window.RambleAr`)
  tested in Node under `vm` with a synthetic pose; label buttons persist across frames (a button
  rebuilt under a finger never gets its tap); the client owns the devices and routes label taps to
  the map pins' own popup builders.
```

(b) In §7's route list add after the nests routes: `` phase 4: `GET /api/ramble/around?lat=&lon=&radius_m=` (marks as stored + `distance_m`, nests, nearest first; radius 50–1000, default 500; a read, credits nothing). ``

(c) In §9 add a bullet: `- Inbound contacts marks are bounded per contact by retention (newest 50; phase 4) — `created_at` is the sender's, so no per-day count.`

- [ ] **Step 4: Version bump + registry**

```bash
cd /home/kh0pp/crow-wt-flock4
sed -i 's/"version": "0.4.0"/"version": "0.5.0"/' bundles/ramble/manifest.json bundles/ramble/package.json
sed -i 's/with a bird companion: eggs, nests, an egg shelf, a flock, and gifts and swaps with contacts\./with a bird companion: eggs, nests, an egg shelf, a flock, gifts and swaps with contacts, and an AR view that labels what is around you./' bundles/ramble/manifest.json
grep -n '"version"\|"description"' bundles/ramble/manifest.json bundles/ramble/package.json
npm run build-registry
git diff --stat registry/add-ons.json
```

Expected: both files at `0.5.0`; the registry diff touches only the ramble entry (version + description).

- [ ] **Step 5: Integration gate — the full suite, in the foreground**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs 2>&1 | tail -20
node scripts/check-port-allocation.js
npm run build-registry -- --check
```

Expected: `pass` = total, `fail 0` (baseline on main is 4159; phase 4 adds 24 tests — ramble-anchors 2, ramble-around 7, ramble-trades 1, ramble-transport 2, ramble-ar 9, ramble-panel 3 — so expect 4183); ports and registry checks clean. Record the exact pass/fail count in the PR body.

- [ ] **Step 6: Commit docs + spec + bump + registry + plan**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md docs/superpowers/specs/2026-09-07-ramble-flock-design.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json docs/superpowers/plans/2026-09-07-ramble-flock-phase4-ar.md -m "ramble 0.5.0: the AR view docs en/es; spec amendments; registry"
git show --stat HEAD
```

(The plan file was `git add`ed and committed at the start of execution — see "Execution handoff" below; if it was not, `git add` it here.)

- [ ] **Step 7: Push, PR, check-runs, merge**

```bash
git -C /home/kh0pp/crow-wt-flock4 pull --rebase origin main
git -C /home/kh0pp/crow-wt-flock4 push -u origin feat/ramble-flock-phase4
```

Open the PR with the GitHub MCP tool (`mcp__github__create_pull_request`, owner `kh0pper`, repo `crow`, head `feat/ramble-flock-phase4`, base `main`, title `ramble 0.5.0: Flock phase 4 — the AR view`). Body: what shipped per task, the rulings (retention not per-day; `camera` field; coarse-anchor rule; radar mode rule; secure-context note), the suite count, the phone smoke result (or "smoke deferred to the deployed instance"), carry-overs, and the trailer `🤖 Generated with [Claude Code](https://claude.com/claude-code)` + the session URL. No co-author lines anywhere.

Poll the check-runs on the head sha with a small python script (no inline shell quoting):

```bash
cat > /tmp/claude-1000/-home-kh0pp-crow/a4059502-d556-46f5-b8b0-182af2b95e0d/scratchpad/checks.py <<'EOF'
import json, sys, urllib.request
sha = sys.argv[1]
url = f"https://api.github.com/repos/kh0pper/crow/commits/{sha}/check-runs"
req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "crow-checks"})
data = json.load(urllib.request.urlopen(req))
for r in data.get("check_runs", []):
    print(r["name"], r["status"], r["conclusion"])
print("total", data.get("total_count"))
EOF
python3 /tmp/claude-1000/-home-kh0pp-crow/a4059502-d556-46f5-b8b0-182af2b95e0d/scratchpad/checks.py "$(git -C /home/kh0pp/crow-wt-flock4 rev-parse HEAD)"
```

Merge (`mcp__github__merge_pull_request`, merge method `merge`) ONLY when `suite`, `static-checks` and `audit` all read `completed success`. An empty list on a current sha is WRONG — wait and re-poll (the poll is unauthenticated: 60 requests per hour per IP, so poll every couple of minutes, never in a tight loop; a 403 means the budget is spent).

- [ ] **Step 8: Deploy all three gateways back-to-back, verify**

Read `/home/kh0pp/CROW-SCHEDULE.md` first. Then:

```bash
git pull --ff-only origin main && git log --oneline -1
echo '8r00kly^' | sudo -S systemctl restart crow-gateway.service crow-r4-gateway.service
grackle "cd ~/crow && git pull --ff-only origin main && echo '8r00kly^' | sudo -S systemctl restart crow-gateway && sleep 25 && journalctl -u crow-gateway --since '2 min ago' --no-pager | grep -E 'refreshed ramble|\[ramble\]|ramble routes mounted|addon ramble'"
sleep 20; grep -E 'refreshed ramble|\[ramble\]|ramble routes mounted|addon ramble' /var/log/crow-inference/gateway.log | tail -6
journalctl -u crow-r4-gateway --since '3 min ago' --no-pager | grep -E 'refreshed ramble|\[ramble\]|ramble routes mounted|addon ramble'
```

Expected on grackle: `[bundles] refreshed ramble 0.4.0 -> 0.5.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered`. Crow primary + r4: `[ramble] transport started` (and the refresh line on any instance that had 0.4.0 installed). Then confirm `auto_update_last_result` reads "Up to date" (`sqlite3 ~/.crow/data/crow.db "select value from dashboard_settings where key='auto_update_last_result'"` — read-only) and `~/crow` is on `main`. Then the phone smoke from Task 7 Step 4 against `https://crow.dachshund-chromatic.ts.net:8444/dashboard/ramble` if it was deferred. Note: the panel HTML and static files are read from the installed copy; a stale panel means the refresh line did not print — check the manifest version under `~/.crow/bundles/ramble/`.

- [ ] **Step 9: Handoff on a docs branch + memory**

Create `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase4-shipped-pr<N>.md` on a fresh worktree branch `docs/ramble-flock-phase4-handoff` from `main` (same shape as the phase-3 handoff: state, what shipped, rulings, deferred minors, where things are, next = models arc plan 2 — the Ramble Flock arc is COMPLETE), push, PR, merge when green. Update `/home/kh0pp/.claude/projects/-home-kh0pp-crow/memory/` (a phase-4 memory file + `MEMORY.md` line), and remove the `crow-wt-flock4` worktree once the handoff is merged.

---

## Self-review notes (coverage against the spec, phase 4 scope)

- §6 full-screen camera over `getUserMedia({ video: { facingMode: "environment" } })`: Task 7 `startArCamera`; pose = `watchPosition` + `deviceorientationabsolute`/`webkitCompassHeading`: Task 7 `startArGps`/`startArHeading` + Task 5 `headingFromEvent`. Anchors = marks, caws, nests within ~500 m: Task 1 `aroundPoint` (`RANGE_M`/`AROUND_RADIUS_DEFAULT` = 500) + Task 4 route + Task 7 `toArAnchors`; lat/lon/accuracy as stored: Task 1 (rows unchanged, tested), Task 4 (`annotateMarks` shared with `/marks`), Task 7 (`lat/lon` copied, teasers via `approx_*`). Bearing/distance → horizontal by bearing offset (±35°), edge parking with an arrow (Task 5 `layoutAnchor`, CSS `[data-side]::before`), vertical + scale by distance (Task 5, tested). Locked = dashed teaser + walk distance (Task 5 `sub`, CSS `[data-locked]`); tap = the pin's actions (Task 7 `onArTap` → `popupFor`/`nestPopup`, asserted by the panel test). Bird bottom centre, reacts on enter, speaks (Task 5 `paintBird`/`react`/`say`; Task 6 perch markup; Task 7 `arBirdState`).
- §6 fallback: radar strip on no camera / no compass / no fix (Task 5 `mode`/`reason`, tested for all three; Task 6 ring + list markup and radar-mode CSS). Limits in-UI on first open (Task 6 notice; Task 7 gate + `ramble.ar.limits`).
- §6 contract: `renderAr({ anchors, pose, bird })` with no map knowledge in its own plain script file, Node-testable with a synthetic pose (Task 5; `tests/ramble-ar.test.js` covers label positions for known bearings, edge parking, scale by distance, radar fallback when heading is null).
- Server side under path-scoped `dashboardAuth`, inputs bounded (Task 4: regexes + `requireLat/Lon` + radius range; the router's existing `router.use("/api/ramble", dashboardAuth)` covers the new path; the unpathed-layer test still passes). No new table (Global Constraints).
- Carry (a): Task 2 retention prune + test. Carry (b): Task 3 two-transport test.
- §9 camera frames never leave the device: Task 5/7 code + grep assertions in both test files.
- §3 "AR button on the map": Task 6 chip; §8 tokens only: Task 6 CSS uses `--rb-*` only.
- §11 item 4 / docs: Task 8 en/es sections in the same position; spec amendments; 0.5.0 bump; registry.
- Placeholder scan: no TBD/TODO; every step carries code or an exact command. Type consistency: the frame fields used by `mountAr` (`labels[].x/y/scale/side/locked/title/sub/id/kind`, `parked.left/right`, `coarse[]`, `radar.dots[]/list[]`, `visible[]`, `say`, `bird`) match `renderAr`'s return; `els` keys used by `mountAr` (`root, labels, radar, list, coarse, bird, egg, say, more, mode`) match `arElements()` in Task 7 and the ids in Task 6; `session.anchor(id)` returns the original anchor object (with `source`) so `onArTap` can hand `anchor.source` to the popup builders; `aroundPoint`'s `{ here, radius_m, week, marks, nests }` matches the route's spread and the tests; `receiveEnvelope`'s mark result gains `pruned` and the transport ignores it.

## Review

### Round 1 (2026-09-07, adversarial staff-engineer subagent, code-traced; the plan's own tests were executed against the plan's own code) — REVISE → fixed inline
Five criticals, all folded in above: **C1** the renderer's header comments carried six backticks, failing its own zero-backtick assertions → plain words. **C2** `assert/strict`'s `deepEqual` compares prototypes, and values built inside `vm.runInNewContext` carry the sandbox realm's — six assertions with a vm-built left operand failed on structure-equal values → a `plain()` JSON round-trip on every such operand, with the reason recorded in the test header. **C3** `mountAr.render` rebuilt every label `<button>` on every orientation event (~60 Hz), so a button pressed was gone by `touchend` and the tap never fired ("dead buttons") → label nodes persist by anchor id and are re-placed in place (z-index carries the far-first paint order), the tappable radar/coarse rows repaint only when their text changes, and the client ignores sub-0.5° wobbles; the mountAr test now asserts the same element object across frames and its removal when the anchor leaves. **C4** the client sent `String(double)` for lat/lon and the route capped decimals at 12, so a normal Android fix could 400 silently → client sends `toFixed(6)`, route accepts up to 17 decimals, both pinned by tests. **C5** Task 4's `/marks` edit re-declared `const marks` (a SyntaxError that would have taken the whole panel test file down) → the replacement is now stated line-precisely.
Suggestions applied: **S1** the anchors test's real import line; **S2** `MAX_COVER_CELLS` 64 and a `too-wide` error (→ 400) instead of a silent full-table scan when the cover overflows, with a high-latitude test; **S4** a heading older than 5 s is dropped (1 s heartbeat while open) and a `PERMISSION_DENIED` from `watchPosition` clears the fix; **S5** the video's visibility keys on a `data-camera` attribute, not on the reason; **S6** the dead `data-ar` attribute removed; **S7** the smoke split into a desktop radar-path smoke (scratch gateway, `timeout`-capped) and the phone checklist on the deployed HTTPS instance; **S8** `receiveEnvelope` reports `gone` when the row it inserted was pruned in the same call (a re-sent old mark under a new event id) and the transport skips the `ramble:nearby` poke for it (credit unchanged), with trades + transport tests; **S9** a coarse-only frame says "Something is around here, but I can't tell which way." rather than "Nothing within 500 m"; **S10** docs say "when you close a tapped label"; **S11** the §6 amendment records the navigation-line deviation, the hidden-tab behaviour and the audience; **S12** CSS selector pins for the edge arrow, the dashed teaser, the camera-off video and the radar layout, plus `data-side` assertions in the mountAr test. **S3** (the notice gate has only string-level coverage) is accepted as smoke-only: the gate is three lines of `openAr` and the phone checklist's first item; no pure helper was extracted.
Rulings: **Q1** `camera` stays an optional fourth field of `renderAr` (a 3-field call behaves exactly as spec §6 says; the mode/reason decision lives in one place); recorded in the §6 amendment. **Q2** the camera prompt is issued synchronously in the click, then the motion prompt, never after an awaited promise. **Q3** a hidden tab stops the camera only; the view stays open and the camera restarts on return. **Q4** `/around` lists what the map lists (public, contacts, the user's own private) — intentional, behind `dashboardAuth`, pinned by the route test's private "near north" mark and stated in the guides.

### Round 2 (2026-09-07, fresh adversarial subagent; the plan's new files and tests were EXECUTED in a scratch mirror — ar 8/8 after N1, around 5/6, anchors 11/11, trades 11/11, transport 32/32 incl. the two-transport test on its first run) — REVISE → fixed inline
Round-1 fixes re-verified HOLDING: C2, C3 (same element across frames, `data-side` flips, removal, list not rebuilt, z-index), C4, C5, S4, S5, S6, S8 (both halves executed; the transport edit compiles), S9, S12. Two did not hold and one new defect: **N1** (C1 reopened) the round-1 painter edit's own comment carried two backticks → plain words. **N2** `bboxAround`'s `cosLat` floor of 0.01 capped the box's east–west half-width at ~0.45°, so the `too-wide` refusal was unreachable at radius 500 AND the box was too narrow near the pole (silently missing marks) → floor `1e-6`; lat 85 answers, 89.9 and 90 refuse. **N3** a precision-5 cover (~10 km × 8 km) with `LIMIT 500` applied before the distance filter meant an instance holding >500 marks in its home cell could get an empty AR view while the map still showed pins → two covers: a precision-7 fine cover (≤ 512 cells, ~72 for 500 m) answers exact-anchor rows and can never be starved, the precision-5 cover contributes only rows whose own geohash is coarse (wire caws); above ~84° the fine cover overflows and the coarse pass alone answers (accepted, bounded); a 600-far-marks starvation test pins it.
Suggestions applied: **S1** Task 7's Files bullet now says AFTER hatch; **S2** the transport-edit parenthetical says what the shown block already contains; **S3** "replace the whole `makeHarness`"; **S4** the suite delta is 24 tests → 4183; **S5** `listKey` includes the title (and the mode); **S6** the redundant sheet z-index dropped; **S7** in radar mode coarse rows join the list and the coarse strip is hidden (no collision on short viewports), tested; **S8** `paintPet` nudges the AR render so the bird is not a heartbeat late; **S9** a camera restart after a hidden tab retries once before the view gives up on it; **S10** the check-runs poll's rate limit noted; **S11** (rAF detachment) recorded as a non-issue.
Rulings: **Q1** `radius_m` stays as API surface (validated, documented, tested; the client sends none today). **Q2** answered by N3. **Q3** `listNests` at high latitude stays under its own `MAX_NEST_CELLS = 8192` cap — no extra cap; it computes hashes, it does not query. **Q4** the notice gate's storage half moved into the renderer as `noticeSeen`/`markNoticeSeen(getStorage, key)` with a unit test (missing/throwing storage → the notice shows); the three-line `openAr` branch stays smoke-only.
