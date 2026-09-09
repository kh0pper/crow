/**
 * Task 12 — Ramble panel (handler + companion routes + vendored static).
 *
 * The router is mounted on a bare express app with a stub `dashboardAuth`
 * (a request needs `x-test-auth` to get past it), exactly the way the
 * gateway mounts external panel routes, and driven over a real loopback
 * socket so path-scoping, JSON bodies and content types are all exercised
 * for real.
 *
 * Env discipline: `CROW_APP_ROOT` (repo root) + `CROW_DATA_DIR` (a scratch
 * dir) are set BEFORE the router is imported, so the bundle's BUNDLE_DIR
 * resolution lands on the repo tree and every db/identity file the POST
 * persona path creates lands in the scratch dir — never in ~/.crow.
 * `getManagersOrNull()` is null in a test process, so the authoring route
 * degrades to `loadOrCreateIdentity()`; that is the path under test here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "ramble-panel-"));

const savedEnv = {
  CROW_APP_ROOT: process.env.CROW_APP_ROOT,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_DB_PATH: process.env.CROW_DB_PATH,
};
process.env.CROW_APP_ROOT = REPO_ROOT;
process.env.CROW_DATA_DIR = SCRATCH;
delete process.env.CROW_DB_PATH;

// Dynamic imports: static ones are hoisted above the env writes above.
const { default: rambleRouter } = await import("../bundles/ramble/panel/routes.js");
const { default: panel } = await import("../bundles/ramble/panel/ramble.js");
const { createDbClient } = await import("../bundles/ramble/server/db.js");
const { default: bus } = await import("../servers/shared/event-bus.js");
const { isoWeek } = await import("../bundles/ramble/server/eggs.js");
const { nestsInCells, cellsInBbox, NEST_RATE_DEFAULT } = await import("../bundles/ramble/server/nests.js");
const { bboxAround } = await import("../bundles/ramble/server/around.js");

/**
 * Fog gates public terrain (spec 2026-09-08 §2.1), so a test that lists or
 * claims a nest must first walk to ground that actually unlocks it. Each walk
 * posts /api/ramble/area with `here`, which credits +20 visit_place warmth
 * against a hatch_at of 100 — this file already churns hatches and later
 * asserts an incubating egg exists, so the credit is suppressed around the
 * walk rather than left to accumulate.
 *
 * ⚠ An unlock is permanent (spec §2.1): once a test calls this, that cell
 * stays unlocked for every test that runs afterward in this file. A fog
 * assertion added later against this same ground will silently see it as
 * already-walked, not fogged.
 */
async function walkTo(lat, lon) {
  const db = createDbClient();
  try {
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES ('warmth.visit_place', '0')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [],
    });
    await req("/api/ramble/area", { method: "POST", body: { lat, lon, here: { lat, lon, accuracy_m: 5 } } });
  } finally {
    await db.execute({ sql: "DELETE FROM ramble_settings WHERE key = 'warmth.visit_place'", args: [] });
    db.close();
  }
}

/**
 * Unlock EVERY cell inside `radiusM` of (lat, lon) — not just one point. A
 * single walkTo() only unlocks the one cell stood in, so any other nest
 * within the radius but past the depth-3 frontier reach (~460 m) is still
 * only a beacon (no `distance_m`, no `seed`); the /around gating test needs
 * the whole circle to be real ground, exactly like a player who has actually
 * explored the area, so every nest /around returns is unlocked rather than
 * a preview. Same cells `aroundPoint` itself covers, so nothing is missed.
 *
 * ⚠ Same permanence caveat as walkTo: every cell it touches stays unlocked
 * for the rest of the file's tests.
 */
async function unlockRadius(lat, lon, radiusM) {
  const db = createDbClient();
  try {
    const cells = cellsInBbox(bboxAround({ lat, lon }, radiusM));
    const now = Date.now();
    for (const cell of cells) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({
        sql: `INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING`,
        args: [cell, now],
      });
    }
  } finally { db.close(); }
}

// 30.46 / -98.08 -> geohash7 "9v6m21h" -> precision-5 cell "9v6m2".
const LAT = 30.46;
const LON = -98.08;
const CELL = "9v6m2";

/** Every sync emit the router makes, in order: the contract is observable. */
const emitCalls = [];
const routerInstance = rambleRouter(
  (req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()),
  { emit: (table, op, row) => { emitCalls.push({ table, op, row }); } },
);

const app = express();
app.use(routerInstance);
const server = app.listen(0);
await once(server, "listening");
const BASE = `http://127.0.0.1:${server.address().port}`;

// Phase 3: the routes read the CORE contact tables. The scratch db never ran
// init-db.js, so plant the exact columns ramble reads (never in production).
const PK = "ef".repeat(32);        // crow:pal's key (x-only); every seeded contact gets a DISTINCT key
const PK_BUDDY = "ee".repeat(32);
const PK_BLOCKED = "ed".repeat(32);
{
  const db = createDbClient();
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0,
      avatar_url TEXT, peer_display_name TEXT, peer_avatar TEXT);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, peer_avatar) VALUES ('crow:pal', 'Pal', '02${PK}', 'data:image/png;base64,${"A".repeat(32)}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:buddy', 'Buddy', '02${PK_BUDDY}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blocked', 'Blocked', '02${PK_BLOCKED}', 1);
    INSERT INTO contact_groups (name, group_uid) VALUES ('Walkers', 'grp-walk');
    INSERT INTO contact_groups (name, group_uid, room_uid) VALUES ('Room', 'grp-room', 'r1');
    INSERT INTO contact_group_members (group_id, contact_id) VALUES (1, 1);`);
  try { db.close?.(); } catch { /* scratch */ }
}

after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Captured BEFORE any test stubs global.fetch: the tile-proxy tests replace
// globalThis.fetch to keep the suite off the network, and the test client must
// not be replaced along with the code under test.
const realFetch = globalThis.fetch.bind(globalThis);

function req(path, opts = {}) {
  const headers = { "x-test-auth": "1", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return realFetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

// --------------------------------------------------------------- panel shape

test("panel handler object has the registry-required shape", () => {
  assert.equal(panel.id, "ramble");
  assert.equal(panel.route, "/dashboard/ramble");
  assert.equal(panel.navOrder, 120);
  assert.equal(panel.category, "social");
  assert.equal(typeof panel.handler, "function");
});

test("panel handler renders the world-first shell, its three views and every asset", async () => {
  let sent = null;
  const res = { send: (html) => { sent = html; } };
  await panel.handler({ query: {} }, res, {
    db: null,
    layout: ({ content }) => content,
    appRoot: REPO_ROOT,
  });
  assert.ok(sent, "handler sent nothing");

  // The whole panel is one element with a `data-view` state; the world is home.
  assert.match(sent, /id="ramble"/);
  assert.match(sent, /data-view="world"/);

  // Direction-C surfaces: the perch on the map, the compose card, the grid
  // sheet (no longer an always-open card), and both other views.
  assert.match(sent, /rb-perch/);
  assert.match(sent, /rb-compose/);
  assert.match(sent, /rb-grid-sheet/);
  assert.match(sent, /data-for="egg"/);
  assert.match(sent, /data-for="pet"/);

  // The "Just me" segment is a real audience, not a hidden default.
  assert.match(sent, /data-visibility="private"/);

  // Both directions of the egg <-> pet loop. Without them the egg view (and
  // its daily check-in) is unreachable once the perch belongs to a hatched
  // bird, because the successor egg is minted the moment one hatches.
  assert.match(sent, /id="rb-pet-nextegg"/);
  assert.match(sent, /id="rb-my-bird"/);

  // Assets: the stylesheet is now a file (was an inline <style>), and the
  // bird engine is loaded in the browser so pins/perch/pet can draw genomes.
  assert.match(sent, /\/ramble\/static\/ramble\.css/);
  assert.match(sent, /\/ramble\/static\/bird-svg\.js/);
  assert.match(sent, /\/ramble\/static\/ramble\.js/);
  assert.match(sent, /\/ramble\/static\/leaflet\/leaflet\.css/);

  // Grid checkbox names are the wire contract with POST /api/ramble/grid.
  assert.match(sent, /name="grid-public-geo"/);

  // The Visible sheet's World name field: bounded to 24 characters client-side.
  assert.match(sent, /id="rb-world-name"[^>]*maxlength="24"/);
  assert.ok(sent.includes("Contacts see the name they saved for you, or your Crow name."));

  // The pet page must name what actually feeds the bird, not just the three
  // chore buttons: walking is worth more than tapping and the page hid that.
  assert.ok(sent.includes("What your bird runs on"), "the energy-sources card is on the pet page");
  // "A daily chore", not "A chore below": the chores moved ABOVE this panel.
  for (const src of ["Meet another crow", "Somewhere new", "Unlock a mark", "A daily chore", "Check in", "A quiet stretch"]) {
    assert.ok(sent.includes(src), `pet page names the energy source: ${src}`);
  }
  assert.ok(sent.includes("Getting out is worth more than tapping."), "the page says walking beats tapping");

  // The legacy ids are GONE — anything still selecting them is broken.
  assert.doesNotMatch(sent, /id="ramble-map"/);
  assert.doesNotMatch(sent, /id="ramble-pet"/);
  assert.doesNotMatch(sent, /id="ramble-marks"/);

  // Phase 2: the flock view and both doors into it.
  assert.match(sent, /data-for="flock"/);
  assert.match(sent, /id="rb-flock-birds"/);
  assert.match(sent, /id="rb-shelf"/);
  assert.match(sent, /id="rb-my-flock"/);
  assert.match(sent, /id="rb-egg-flock"/);

  // Phase 3 surfaces: the group audience, the swaps card, the picker sheet.
  assert.match(sent, /data-visibility="group"/);
  assert.match(sent, /id="rb-group"/);
  assert.match(sent, /id="rb-trades"/);
  assert.match(sent, /id="rb-pick-sheet"/);
  assert.match(sent, /id="rb-pick-list"/);

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
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(sent), "no emoji in the panel markup — icons are inline SVG");

  // The location marker is the pet now (operator request, 2026-09-08): the
  // corner button was retired, but the world view still needs a door that
  // does not depend on a GPS fix.
  assert.ok(sent.includes('id="rb-perch-open"'), "the world view keeps a door that does not need a GPS fix");

  // The pet page puts the thing you ACT on above the thing you read once.
  // Asserting the ORDER, not just presence: both cards existed before and the
  // complaint was that the reference panel pushed the chores below the fold.
  const chores = sent.indexOf('class="rb-chores"');
  const runsOn = sent.indexOf('id="rb-runs-on"');
  assert.ok(chores > -1 && runsOn > -1, "both the chores and the reference panel are on the pet page");
  assert.ok(chores < runsOn, "the chore buttons come BEFORE what your bird runs on");
  assert.ok(sent.includes('<details class="rb-card rb-fold" id="rb-runs-on" open>'),
    "the reference panel folds, and ships open for a player who has not read it yet");
  assert.ok(sent.includes('<summary class="rb-eyebrow rb-fold-sum">'), "with a real summary, so it toggles without script");
  // The list used to point DOWN at the chores. They are above it now.
  assert.ok(!sent.includes("A chore below"), "the copy must not still point below at chores that moved above it");
  assert.ok(sent.includes("A daily chore"), "it names the chore without a direction");
  assert.ok(sent.includes('id="rb-perch-say"'), "the status strip stays");

  assert.ok(sent.includes('id="rb-seed-count"'), "the map bar carries the seed counter");
  assert.ok(sent.includes('id="rb-heart-count"'), "the map bar carries the heart counter");
  assert.ok(sent.indexOf('id="rb-heart-count"') > sent.indexOf('id="rb-seed-count"'),
    "common currency first, rare currency second");
});

// -------------------------------------------------------------- auth scoping

test("GET /api/ramble/marks is behind dashboardAuth", async () => {
  const res = await fetch(BASE + "/api/ramble/marks");
  assert.equal(res.status, 401);
});

test("GET /api/ramble/marks returns an empty list on a fresh db", async () => {
  const res = await req("/api/ramble/marks?visibility=public");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { marks: [] });
});

// ------------------------------------------------------------------ authoring

test("POST /api/ramble/marks stores a mark that then lists in its cell", async () => {
  const res = await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: LAT, lon: LON, text: "hello from the panel",
            visibility: "public", reveal: "open" },
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const { mark } = body;
  assert.ok(mark?.mark_id, "no mark_id in the response");
  assert.equal(mark.publish_state, "pending");
  // The client branches on `out.hatched` after authoring — the key must always
  // be there (null when this mark did not tip the egg over the threshold).
  assert.ok("hatched" in body, "POST /api/ramble/marks must report `hatched`");
  assert.equal(body.hatched, null);

  const inserted = emitCalls.filter((c) => c.table === "ramble_marks" && c.op === "insert");
  assert.equal(inserted.length, 1, "authoring must emit exactly one ramble_marks insert");
  assert.equal(inserted[0].row.mark_id, mark.mark_id);

  const listed = await req(`/api/ramble/marks?visibility=public&cells=${CELL}`);
  assert.equal(listed.status, 200);
  const { marks } = await listed.json();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].mark_id, mark.mark_id);
});

test("POST /api/ramble/marks with visibility:private stores it, and it lists only under visibility=private", async () => {
  const res = await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: LAT, lon: LON, text: "just me on the panel", visibility: "private" },
  });
  assert.equal(res.status, 201);
  const { mark } = await res.json();
  assert.ok(mark?.mark_id, "no mark_id in the response");

  const privateListed = await req(`/api/ramble/marks?visibility=private&cells=${CELL}`);
  assert.equal(privateListed.status, 200);
  const { marks: privateMarks } = await privateListed.json();
  assert.ok(privateMarks.some((m) => m.mark_id === mark.mark_id));

  const publicListed = await req(`/api/ramble/marks?visibility=public&cells=${CELL}`);
  assert.equal(publicListed.status, 200);
  const { marks: publicMarks } = await publicListed.json();
  assert.ok(!publicMarks.some((m) => m.mark_id === mark.mark_id));
});

test("POST /api/ramble/marks rejects an out-of-range latitude", async () => {
  const res = await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: 200, lon: LON, text: "nope" },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, "no error message");
});

// ---------------------------------------------------------------- active area

test("POST /api/ramble/area writes local.active_area as the precision cell", async () => {
  const res = await req("/api/ramble/area", { method: "POST", body: { lat: LAT, lon: LON } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cells: [CELL] });

  const db = createDbClient();
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = 'local.active_area'",
      args: [],
    });
    assert.equal(rows[0]?.value, JSON.stringify([CELL]));
  } finally {
    db.close();
  }
});

test("POST /api/ramble/area rejects a malformed cell", async () => {
  const res = await req("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2", "not a cell!"] } });
  assert.equal(res.status, 400);
});

// ----------------------------------------------------------------- the grid

test("GET/POST /api/ramble/grid round-trips the master switch and a cell", async () => {
  const before = await (await req("/api/ramble/grid")).json();
  assert.equal(before.master, false);
  assert.equal(before.cells.public.geo, false);

  const res = await req("/api/ramble/grid", {
    method: "POST",
    body: { master: true, cells: { public: { geo: true } } },
  });
  assert.equal(res.status, 200);
  const grid = await res.json();
  assert.equal(grid.master, true);
  assert.equal(grid.cells.public.geo, true);
  assert.equal(grid.cells.public.ble, false);
});

test("POST /api/ramble/grid rejects an unknown audience or channel", async () => {
  const bad = await req("/api/ramble/grid", { method: "POST", body: { cells: { nobody: { geo: true } } } });
  assert.equal(bad.status, 400);
  const badChannel = await req("/api/ramble/grid", { method: "POST", body: { cells: { public: { carrier_pigeon: true } } } });
  assert.equal(badChannel.status, 400);
});

test("POST /api/ramble/grid stores a sanitized worldName, clears a rejected one, and bounds the input", async () => {
  let res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "  Kevin\u202E  " } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).worldName, "Kevin");
  assert.equal((await (await req("/api/ramble/grid")).json()).worldName, "Kevin");
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "f665c26b" } });
  assert.equal((await res.json()).worldName, null, "a key look-alike clears the name");
  await req("/api/ramble/grid", { method: "POST", body: { worldName: "Kevin" } });
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "" } });
  assert.equal((await res.json()).worldName, null, "an empty string clears");
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: null, master: true } });
  assert.equal(res.status, 200, "null means not-sent, not clear");
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "x".repeat(129) } });
  assert.equal(res.status, 400);
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: 7 } });
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------------- the pet

test("GET /api/ramble/pet returns the real pet state shape", async () => {
  const res = await req("/api/ramble/pet");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.mood, "string");
  assert.ok(["happy", "tired", "alarmed"].includes(body.mood));
  assert.equal(typeof body.energy, "number");
  assert.ok(body.energy >= 0 && body.energy <= 100);
  assert.equal(typeof body.places_week, "number");
  assert.equal(typeof body.unlocks_week, "number");
  assert.equal(typeof body.crows_week, "number");
});

// A visit is credited from the user's REAL position (`here`), never from the
// map's active area: the area is whatever the viewport happens to cover, so
// crediting it would let a pan farm warmth and `places_week` from an armchair.
const HERE_LAT = 51.5074, HERE_LON = -0.1278; // a geohash-7 cell no other test touches

test("POST /api/ramble/area credits visit_place from `here` — once per cell per week", async () => {
  const petBefore = await (await req("/api/ramble/pet")).json();
  const eggBefore = await (await req("/api/ramble/egg")).json();

  const first = await req("/api/ramble/area", {
    method: "POST",
    body: { lat: HERE_LAT, lon: HERE_LON, here: { lat: HERE_LAT, lon: HERE_LON } },
  });
  assert.equal(first.status, 200);
  const petAfterFirst = await (await req("/api/ramble/pet")).json();
  const eggAfterFirst = await (await req("/api/ramble/egg")).json();
  assert.equal(petAfterFirst.places_week, petBefore.places_week + 1, "`here` must feed visit_place");
  assert.ok(eggAfterFirst.egg.warmth > eggBefore.egg.warmth, "`here` must credit egg warmth");

  // The same real position again inside the same ISO week: the eggs ledger
  // already holds that (cell, week) key, so neither pet nor egg moves.
  const second = await req("/api/ramble/area", {
    method: "POST",
    body: { lat: HERE_LAT, lon: HERE_LON, here: { lat: HERE_LAT, lon: HERE_LON } },
  });
  assert.equal(second.status, 200);
  const petAfterSecond = await (await req("/api/ramble/pet")).json();
  const eggAfterSecond = await (await req("/api/ramble/egg")).json();
  assert.equal(petAfterSecond.places_week, petAfterFirst.places_week, "a repeat visit must not feed the pet again");
  assert.equal(eggAfterSecond.egg.warmth, eggAfterFirst.egg.warmth, "a repeat visit must not credit warmth again");
});

test("POST /api/ramble/area without `here` credits nothing — panning must not farm warmth", async () => {
  const petBefore = await (await req("/api/ramble/pet")).json();
  const eggBefore = await (await req("/api/ramble/egg")).json();

  // Cells only (the panel's pan path) — two cells nothing else in this file uses.
  const cellsOnly = await req("/api/ramble/area", { method: "POST", body: { cells: ["u10hb", "gcpvj"] } });
  assert.equal(cellsOnly.status, 200);

  // And a lat/lon centre, which is the map CENTRE, not the user's position.
  const centreOnly = await req("/api/ramble/area", { method: "POST", body: { lat: 48.8584, lon: 2.2945 } });
  assert.equal(centreOnly.status, 200);

  const petAfter = await (await req("/api/ramble/pet")).json();
  const eggAfter = await (await req("/api/ramble/egg")).json();
  assert.equal(petAfter.places_week, petBefore.places_week, "no `here` must mean no visit_place");
  assert.equal(eggAfter.egg.warmth, eggBefore.egg.warmth, "no `here` must mean no warmth");
});

test("POST /api/ramble/area rejects a malformed `here`", async () => {
  const outOfRange = await req("/api/ramble/area", {
    method: "POST",
    body: { lat: LAT, lon: LON, here: { lat: 999, lon: 0 } },
  });
  assert.equal(outOfRange.status, 400);
  const notAnObject = await req("/api/ramble/area", { method: "POST", body: { lat: LAT, lon: LON, here: "somewhere" } });
  assert.equal(notAnObject.status, 400);
});

// ------------------------------------------------------ eggs, chores, birds

test("GET /api/ramble/egg returns the egg progress and the checklist", async () => {
  const res = await req("/api/ramble/egg");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.egg.egg_id, "string");
  assert.equal(typeof body.egg.warmth, "number");
  assert.equal(body.egg.hatch_at, 100, "the default hatch threshold");
  assert.ok(body.egg.percent >= 0 && body.egg.percent <= 100, `percent was ${body.egg.percent}`);
  assert.equal(typeof body.checklist.new_places_week, "number");
  assert.equal(typeof body.checklist.first_mark, "boolean");
  assert.equal(typeof body.checklist.checked_in_today, "boolean");
});

// Proves the `warmth.*` settings override actually reaches the route. The
// override is set and read inside this test only, then removed in the
// `finally` before the next test runs: the tests below add more warmth to
// the same egg and assert exact before/after deltas (e.g. "posting a mark
// credits mark_left warmth"), which stay valid only while the default
// hatch_at (100) is in effect — a lingering override would just push the
// hatch further out, not make those deltas wrong, but restoring here keeps
// this test's effect from leaking into ones that don't expect it.
test("a warmth.hatch_at settings override reaches the egg route", async () => {
  const db = createDbClient();
  try {
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES ('warmth.hatch_at', '100000')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [],
    });
    const { egg } = await (await req("/api/ramble/egg")).json();
    assert.equal(egg.hatch_at, 100000);
  } finally {
    await db.execute({ sql: "DELETE FROM ramble_settings WHERE key = 'warmth.hatch_at'", args: [] });
    db.close();
  }
});

test("POST /api/ramble/egg/checkin credits warmth once per local day", async () => {
  const first = await req("/api/ramble/egg/checkin", { method: "POST", body: {} });
  assert.equal(first.status, 200);
  const one = await first.json();
  assert.equal(one.credited, true);
  assert.equal(typeof one.warmth, "number");
  assert.equal(one.hatched, null);

  const second = await req("/api/ramble/egg/checkin", { method: "POST", body: {} });
  assert.equal(second.status, 200);
  const two = await second.json();
  assert.equal(two.credited, false, "a second check-in the same day must not credit");
  assert.equal(two.warmth, one.warmth, "and must not move warmth");

  const { checklist } = await (await req("/api/ramble/egg")).json();
  assert.equal(checklist.checked_in_today, true);
});

test("POST /api/ramble/pet/chore completes each kind once a day and 400s an unknown kind", async () => {
  const first = await req("/api/ramble/pet/chore", { method: "POST", body: { kind: "preen" } });
  assert.equal(first.status, 200);
  const one = await first.json();
  assert.equal(one.done, true);
  assert.equal(one.chores.preen, true);
  assert.equal(typeof one.pet.energy, "number");

  const second = await req("/api/ramble/pet/chore", { method: "POST", body: { kind: "preen" } });
  assert.equal(second.status, 200);
  const two = await second.json();
  assert.equal(two.done, false, "the same chore twice in a day is a no-op");
  assert.equal(two.chores.preen, true);

  const unknown = await req("/api/ramble/pet/chore", { method: "POST", body: { kind: "polish" } });
  assert.equal(unknown.status, 400);
  const missing = await req("/api/ramble/pet/chore", { method: "POST", body: {} });
  assert.equal(missing.status, 400);
});

test("GET /api/ramble/pet carries the daily chores, the active bird slot and the egg percent", async () => {
  const body = await (await req("/api/ramble/pet")).json();
  assert.equal(typeof body.chores, "object");
  assert.equal(typeof body.chores.day, "string");
  assert.equal(body.chores.preen, true, "set by the chore test above");
  assert.equal(body.chores.feed, false);
  assert.ok("bird" in body, "the pet state must carry an active-bird slot (null until the first hatch)");
  assert.ok(body.bird === null || typeof body.bird.species === "string");
  assert.equal(typeof body.egg.percent, "number");
});

test("posting a mark credits mark_left warmth", async () => {
  const before = await (await req("/api/ramble/egg")).json();
  const created = await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: LAT, lon: LON, text: "warm this egg", visibility: "public" },
  });
  assert.equal(created.status, 201);
  const after = await (await req("/api/ramble/egg")).json();
  assert.equal(after.egg.warmth, before.egg.warmth + 15, "a mark must credit the default mark_left weight");
});

test("GET /api/ramble/bird/:species/:seed.svg renders a deterministic SVG document", async () => {
  const res = await req("/api/ramble/bird/crow/12345.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /image\/svg\+xml/);
  const cc = res.headers.get("cache-control") || "";
  assert.match(cc, /private/, "an authed bird must be cached privately");
  assert.ok(!/public/.test(cc), "an authed route must never send a public cache directive");

  const body = await res.text();
  assert.match(body, /<svg[^>]*viewBox="0 0 200 200"/);
  assert.ok(body.includes("<g"), "the drawn bird markup is missing");

  const again = await (await req("/api/ramble/bird/crow/12345.svg")).text();
  assert.equal(again, body, "the same species+seed must render identically");

  // `mood` is plumbed through to drawBird: an alarmed bird is a different drawing.
  const alarmed = await (await req("/api/ramble/bird/crow/12345.svg?mood=alarmed")).text();
  assert.notEqual(alarmed, body);
});

test("GET /api/ramble/bird rejects an unknown species and an out-of-range seed", async () => {
  assert.equal((await req("/api/ramble/bird/dodo/1.svg")).status, 400);
  assert.equal((await req("/api/ramble/bird/crow/-1.svg")).status, 400);
  assert.equal((await req("/api/ramble/bird/crow/4294967296.svg")).status, 400);
  assert.equal((await req("/api/ramble/bird/crow/notanumber.svg")).status, 400);
});

test("GET /ramble/static/bird-svg.js serves the shared engine, not the panel/static catch-all", async () => {
  const res = await req("/ramble/static/bird-svg.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
  assert.match(res.headers.get("cache-control") || "", /private/);
  const body = await res.text();
  // There is no bird-svg.js under panel/static — only server/bird-svg.cjs
  // defines RambleBird, so this token proves the dedicated route won the
  // match against the /ramble/static/:file catch-all registered after it.
  assert.ok(body.includes("RambleBird"), "must be served from server/bird-svg.cjs");
});

// ------------------------------------------------------------------- statics

test("GET /ramble/static/ramble.js serves the client script as JavaScript", async () => {
  const res = await req("/ramble/static/ramble.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
  const body = await res.text();
  assert.ok(body.length > 100, "client script looks empty");
  // Android pull-to-refresh guard: the client must call the native bridge
  // to suspend/restore SwipeRefreshLayout around a touch on the map (this
  // is the client half of the fix/android-geolocation-map-swipe change).
  assert.match(body, /Crow\.setPullToRefresh\(false\)/);
  assert.match(body, /Crow\.setPullToRefresh\(true\)/);
  assert.ok(body.includes('postGrid({ worldName: worldNameEl.value })'));

  // House rule for panel client scripts: NO template literals. The panel
  // tooling treats a backtick as its own delimiter, so one here silently
  // truncates the whole script in the browser.
  assert.equal(body.split("`").length - 1, 0, "the client script must contain zero backticks");

  // Both named SSE frames the gateway sends on the one connection
  // (servers/gateway/routes/streams.js). onmessage never fires for either.
  assert.ok(body.includes('addEventListener("ramble-nearby"'), "client must subscribe to ramble-nearby");
  assert.ok(body.includes('addEventListener("ramble-hatched"'), "client must subscribe to ramble-hatched");

  // The Who segment is markup in ramble.js (panel) and behaviour here: the
  // client reads the chosen audience off the button's data-visibility. Pin the
  // attribute name on BOTH sides so a rename cannot silently split them.
  assert.ok(body.includes('"data-visibility"'), "client must read the data-visibility attribute");

  // World name labels (spec 2026-09-08 §3.1): own marks say so; a named stranger gets a key tail.
  assert.ok(body.includes('return "your " + noun;'), "own marks read your mark / your caw");
  assert.ok(body.includes('" · " + who.slice(0, 4)'), "a named stranger carries a key4 tail");
  assert.ok(body.includes('"Your caw"') && body.includes('"A caw from "'));

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
  // Phase 3 wiring: contacts, gift, swaps, the fourth named SSE frame, the
  // invite hand-off for strangers — and still no emoji, still textContent only.
  assert.ok(body.includes('"/api/ramble/contacts"'), "client must load contacts for the pickers");
  assert.ok(body.includes('"/gift"'));
  assert.ok(body.includes('"/api/ramble/trades"'));
  assert.ok(body.includes('"/accept"'));
  assert.ok(body.includes('"/decline"'));
  assert.ok(body.includes('addEventListener("ramble-trade"'), "client must subscribe to ramble-trade");
  assert.ok(body.includes('"/dashboard/contacts"'), "share-an-invite hands off to the Contacts panel");
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(body), "no emoji in the client script");

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
  assert.ok(body.includes("if (!arOpen || document.hidden)"), "a stream that resolves after the tab hid is stopped, not adopted");
  assert.ok(body.includes("if (arOpen) return;"), "startAr is idempotent");
  assert.ok(body.includes('"visibilitychange"'));
  assert.ok(body.includes("AR_HEADING_STALE_MS"), "a stale compass falls back to the ring");
  assert.ok(body.includes("setInterval(arHeartbeat, 1000)"), "the heartbeat retries a failed around fetch");
  assert.ok(!/toDataURL|toBlob|captureStream|ImageCapture|MediaRecorder|drawImage|getContext\(/.test(body), "camera frames never leave the device");

  // Phase 5: one map-level watch drives the you-are-here dot (own pane) with
  // follow mode; nests carry reach + egg art into AR; the collect effect runs
  // at press, success and clear; the nest layer waits for the pin's pop.
  assert.ok(body.includes('className: "rb-here-ring"'));
  assert.ok(body.includes('map.createPane("rb-here")') && body.includes('getPane("rb-here").style.zIndex = 650'));
  assert.ok(body.includes("function startMapWatch(") && body.includes("function paintHere(") && body.includes("function setFollowing("));
  assert.ok(body.includes('map.on("dragstart"'), "a user drag ends follow mode");
  // CONTRACT CHANGED 2026-09-09: following now keeps you CENTRED. It used to
  // pan only once you had drifted out of the middle 40% of the view, which
  // reads as the map lurching every few hundred metres instead of travelling
  // with you.
  assert.ok(!body.includes("getBounds().pad(-0.3)"), "the leave-the-middle gate is gone");
  assert.ok(body.includes("if (!lastPanAt || haversineMeters(lastPanAt, fix) > 10) {"),
    "follow recentres on any real move, using the same 10 m jitter floor as the waddle");
  assert.ok(body.includes('map.on("dragstart", function () { setFollowing(false); });'),
    "and a manual scroll still releases it, so the user is never fighting the map");

  // The opening frame has to be a walk, not a survey.
  assert.ok(body.includes("var WALK_ZOOM = 16;"), "the default frame is walkable, not a survey of the county");
  assert.ok(body.includes("map.setView([pos.lat, pos.lon], WALK_ZOOM);"), "and the first fix uses it");
  assert.ok(body.includes("Math.max(map.getZoom(), WALK_ZOOM)"),
    "re-centring never zooms you back OUT past walkable, but keeps a tighter zoom you chose");
  assert.ok(!/setView\(\[pos\.lat, pos\.lon\], 15\)/.test(body), "no hard-coded 15 survives");
  assert.ok(body.includes("reach_m: CLAIM_M") && body.includes("UNLOCK_M : null"));
  assert.ok(body.includes("function drawEggSeed(") && body.includes("art: nestArt(nest)"));
  assert.ok(body.includes('collectFx(nest.cell, "start")') && body.includes('collectFx(nest.cell, "done")') && body.includes('collectFx(nest.cell, "clear")'));
  assert.ok(body.includes('arSession.fx("n:" + cell'));
  assert.ok(body.includes("function refreshNestsAfterPop(") && body.includes("nestPopUntil = Date.now() + 900"), "the nest layer is rebuilt only after the pin's pop");
  assert.ok(body.includes('addEventListener("ramble-nest-claimed", function () { refreshNestsAfterPop();'), "the claim's own SSE echo waits for the pop too");
  assert.ok(!body.includes("setTimeout(refreshNests, 900)"));
  assert.ok(body.includes("if (mapWatch != null)"), "the AR view reuses the map watch");
  assert.ok(body.includes('window.addEventListener("pageshow"'), "the watch restarts after a bfcache park");
  assert.ok(body.includes("err.code === 1 && arOpen"), "a revoked permission still resets the AR pose");

  // A contact's profile picture on their pin (spec 2026-09-08 §4.5/§5): an <img>
  // via createElement, accepted only as an inline data: image; the bird stays
  // for strangers. A src assignment is not a markup sink (count unchanged).
  assert.ok(body.includes('function contactPortrait(mark)'));
  assert.ok(body.includes('src.indexOf("data:image/") !== 0'));
  assert.ok(body.includes('img.className = "rb-pop-avatar"'));
  assert.ok(body.includes('var portrait = contactPortrait(mark) || birdFor(mark);'));

  const code = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const sinks = code.match(/\.innerHTML\s*=|\bhtml:\s/g) || [];
  assert.equal(sinks.length, 2, `expected exactly two engine-output markup sinks, found ${sinks.length}`);
  assert.ok(code.includes("el.innerHTML = Bird.drawEgg("));
  assert.ok(code.includes("html: nestEggHtml("));

  // hidden is an HTMLElement property, not an SVGElement one: `el.hidden = x`
  // on an <svg> sets a dead expando while the CSS attribute selector for it
  // keeps matching the content attribute. setHidden toggles the attribute
  // itself everywhere in this file, so no direct assignment survives.
  assert.ok(body.includes("function setHidden(el, on)"), "the attribute-toggling helper is defined");
  assert.deepEqual(body.match(/\.hidden\s*=(?!=)/g) || [], [], "no .hidden = assignment remains anywhere in the file");

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
  assert.ok(body.includes("function drawBeacon(mark, layer)") && body.includes("drawBeacon(nest, nestLayer)"),
    "a nest beacon must live in the layer its own draw pass clears");
  // PIN THE VALUE, not just the name. A floor of 15 is what made fog
  // unreachable in the field — the viewport at 15 is smaller than a player's
  // revealed region, so they stand inside their own cleared ground and never
  // see its edge. Regressing this number silently reinstates that bug, and no
  // other assertion in this file would notice.
  assert.ok(body.includes("var MIN_ZONE_ZOOM = 11;"), "fog must render far enough out to show the edge of your cleared ground");
  assert.ok(body.includes("var MIN_CELL_DETAIL_ZOOM = 15;"), "per-cell detail stays a close-up detail");
  assert.ok(body.includes("map.getZoom() >= MIN_CELL_DETAIL_ZOOM"), "and is actually gated by it, not merely declared");
  assert.ok(body.includes('map.getZoom() >= MIN_CELL_DETAIL_ZOOM ? "&pips=1" : ""'),
    "and the client does not even ASK for pips it will not draw");

  // Seed pips and the pickup moment.
  assert.ok(body.includes("function paintSeedPips("), "the map shows where seed is waiting");
  // A seed, not a dot. The first version used a circleMarker in the UI accent,
  // which read as map chrome rather than as something to walk to.
  assert.ok(body.includes("function seedIcon()"), "pips carry the engine's seed art");
  assert.ok(body.includes("Bird.mountSeed(svg)"), "drawn by the shared engine, like every other creature part");
  assert.ok(body.includes('opts.html = svg;'), "an Element, so Leaflet appends and the sink count holds");
  assert.ok(body.includes("rb-seed-dot"), "and a plain dot survives the engine failing to load");

  // Fog has to look like weather, not like the geohash grid it is.
  assert.ok(body.includes("function ensureFogFilter()"), "the mask gets cloudy edges");
  assert.ok(body.includes('filter.setAttribute("id", "rb-fog-clouds")'), "via a filter the stylesheet can reference");
  assert.ok(body.includes('createElementNS(NS, "feTurbulence")') && body.includes('createElementNS(NS, "feDisplacementMap")'),
    "built with createElementNS — a filter is markup, and this file may not use a sink to make markup");
  assert.ok(body.includes("ensureFogFilter();"), "and is actually installed before the mask draws");

  // The bird's voice: moments only, plus tap/focus to ask.
  assert.ok(body.includes("function statusLine()"), "ambient status still exists");
  assert.ok(body.includes("function sayMoment("), "but only moments open the bubble on their own");
  // ⚠ ONE SENTINEL PER SOURCE. Marks and nests arrive from two independent
  // fetches, and the egg refresh (no geolocation needed) normally beats both.
  // A single shared "first look" flag let whichever ran first consume it while
  // the lists were still empty, so the real data landing afterwards read as an
  // arrival and the bird announced pre-existing marks on every page load.
  assert.ok(body.includes("function noteMarks()") && body.includes("function noteNests()"),
    "marks and nests each judge their own arrivals");
  assert.ok(!body.includes("function notePerch()"), "the shared-flag version must not come back");
  assert.ok(body.includes("var spokeMarks = null;") && body.includes("var spokeNests = null;"),
    "and each starts un-looked-at, so neither source's first draw can speak");
  assert.ok(body.includes("spokeMarks !== null && n > spokeMarks"), "marks speak only on a real increase");
  assert.ok(body.includes("spokeNests !== null && spokeNests === 0 && n > 0"), "nests speak only on the 0 -> something transition");
  // The egg/pet refresh changes the ambient LINE, not the world — it must never
  // be able to trip an arrival.
  assert.ok(!/paintEgg[\s\S]{0,900}note(Marks|Nests)\(\)/.test(body),
    "the egg refresh must not evaluate arrivals");

  // A native title would render the browser's own grey tooltip underneath the
  // bird's speech bubble on the same hover.
  assert.ok(!body.includes('title: "You"'), "the marker carries no competing native title");
  assert.ok(body.includes('sayMoment("New ground.")'), "a first unlock is one");
  assert.ok(body.includes("|| momentTimer) return;"),
    "an ambient refresh must not overwrite a moment that is still on screen");
  assert.ok(body.includes("paintSeedPips(out.seed || [])"), "fed from the server's seed list");
  assert.ok(body.includes("function celebrateSeed("), "a pickup is its own moment, not a silent counter tick");
  assert.ok(body.includes("out.seed_picked"), "and it consumes the field the server was already sending");
  assert.ok(body.includes('pop.textContent = "+" + amount'), "the pop is built with textContent, never a markup sink");

  // Task 8: the unlock moment and the seed counter.
  assert.ok(body.includes("function celebrateUnlock("), "a first unlock is celebrated once");
  assert.ok(body.includes("rb-unlock-flash"), "the flash is a rectangle in the fog pane, not an inset shadow the tiles would hide");
  assert.ok(body.includes("function paintSeed("), "the seed counter is painted from the area response");
  assert.ok(body.includes("out.unlocked"), "the celebration is driven by the server saying it was the first time");

  // Pin the MECHANISM, not the identifier: this is the phase's load-bearing
  // guard, and `includes("lastPostedFix")` would pass on a variable that is
  // declared and never used.
  assert.ok(body.includes("haversineMeters(lastPostedFix, lastFix) > 75"),
    "walking posts the area on distance, so it works with the map not following");
  assert.ok(body.includes("lastPostedFix = {"), "and the anchor advances when it posts");

  // The location marker IS the pet (operator request, 2026-09-08): it walks
  // the map with you and opens the egg or pet view when tapped.
  assert.ok(body.includes("function hereIcon("));
  assert.ok(body.includes("function paintHereArt()"));
  assert.ok(body.includes("function hereArt()"));
  // CONTRACT CHANGED 2026-09-08: tapping the bird now ASKS it what is around
  // rather than navigating. Leaflet opens a non-permanent tooltip on click AND
  // on focus, so tap-to-ask and keyboard-to-ask both come from binding it. The
  // labelled strip button is the door — see the rb-perch-open assertions.
  assert.ok(!body.includes('hereDot.on("click"'), "tapping the bird must not navigate any more");
  assert.ok(body.includes("function bindPerchVoice()"), "the bird has a voice bound to the marker");
  assert.ok(body.includes('hereDot.bindTooltip("", { direction: "top"'), "a real bubble with a tail, tracking the bird");
  assert.ok(body.includes('createElementNS("http://www.w3.org/2000/svg", "svg")'), "the art is built without a markup sink");
  assert.ok(body.includes("showView(perchTarget)"), "tapping the marker still opens egg or pet");
  assert.ok(!body.includes('L.circleMarker(ll, { pane: "rb-here"'), "the plain blue dot is gone");
  assert.ok(body.includes("function markWalking()"));
  assert.ok(
    body.includes("haversineMeters(lastWalkFix, { lat: pos.coords.latitude, lon: pos.coords.longitude })"),
    "the waddle has its OWN anchor — regressing it to lastPostedFix must fail here",
  );
  assert.ok(body.includes("if (moved > 10)"), "and its own 10 m threshold, not the 75 m area-post ratchet");
  assert.ok(body.includes('setAttribute("role", "img")'), "the marker is not a button any more — it does not navigate");
  assert.ok(!body.includes('setAttribute("role", "button")'), "and must not claim to be one");
  assert.ok(body.includes('classList.add("is-walking")'), "the marker waddles while you move");

  // The hand-rolled Enter/Space bridge is gone with the navigation it drove.
  // Keyboard users now get the status from Leaflet's own focus/blur tooltip
  // handlers, and reach the view through the real <button> in the strip.
  assert.ok(body.includes("el.onkeydown = null"), "the old keyboard bridge is explicitly cleared, not left dangling");

  // The world view's GPS-independent door (FIX 1): the map marker is the
  // pretty way in, but it needs a real position fix to exist at all.
  assert.ok(body.includes("function paintPerchGo()"));
  assert.ok(body.includes('window.localStorage.getItem("rb.runsOn")'), "the fold remembers whether you closed it");
  assert.ok(body.includes('runsOn.addEventListener("toggle"'), "and records the change");
  assert.match(body, /getItem\("rb\.runsOn"\)[\s\S]{0,80}catch/,
    "storage can throw outright in private mode — a remembered preference must never break the panel");
  assert.ok(body.includes('perchOpenBtn.addEventListener("click"'), "the door is wired independently of the map marker");

  assert.ok(body.includes("eggPercent = pet.egg.percent"), "the world view's warmth line follows the pet refresh");
  assert.ok(body.includes('opts.className = "rb-here-pet rb-here-plain"'), "a plain dot survives the bird engine failing to load");
});

test("the map draws heart pips, counts them, and says something when one is taken", async () => {
  const body = await (await req("/ramble/static/ramble.js")).text();
  assert.ok(body.includes("function paintHeartPips("), "the map shows where a heart is waiting");
  assert.ok(body.includes("function heartIcon()"), "pips carry the engine's heart art");
  assert.ok(body.includes("Bird.mountHeart(svg)"), "drawn by the shared engine, like every other creature part");
  assert.ok(body.includes("rb-heart-dot"), "and a plain dot survives the engine failing to load");
  assert.ok(body.includes("paintHeartPips(out.hearts || [])"), "fed from the server's own list");
  assert.ok(body.includes("out.heart_picked"), "the pickup is consumed from the area response");
  assert.ok(body.includes("out.heart_source"), "and a regrown heart gets its own line, not the once-ever one's");
  assert.ok(body.includes("grown here since you last came by"), "the wild heart's copy is actually there");
  assert.ok(body.includes("function paintHearts("), "the counter is painted from the area response");
  assert.equal(body.split("`").length - 1, 0, "the panel client must contain ZERO backticks");
});

test("GET /ramble/static/ramble.css serves the panel stylesheet", async () => {
  const res = await req("/ramble/static/ramble.css");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/css/);
  const body = await res.text();
  assert.ok(body.length > 100, "stylesheet looks empty");

  // Android WebView pull-to-refresh guard (fix/android-geolocation-map-swipe):
  // the map must opt out of the browser/WebView's own touch gestures so a
  // northward drag pans Leaflet instead of triggering SwipeRefreshLayout.
  // The declaration moved out of the panel's inline <style> into this file.
  assert.match(body, /touch-action:\s*none/);

  // Direction-C tokens are declared on the panel root, and dark mode is a
  // deliberate second token set rather than an inversion filter.
  assert.match(body, /#ramble\s*\{/);
  assert.match(body, /--rb-accent:/);
  assert.match(body, /prefers-reduced-motion/);

  // Views switch by CSS alone: without this selector showView("flock") sets
  // the attribute and the section stays display:none.
  assert.match(body, /\[data-view="flock"\]\s*\.rb-view\[data-for="flock"\]/);

  // Phase 4: the edge arrow on a parked label and the dashed locked teaser are
  // CSS-only halves of two spec §6 requirements — pin the selectors.
  assert.match(body, /\.rb-ar-label\[data-side\]::before/);
  assert.match(body, /\.rb-ar-label\[data-locked="true"\]/);
  assert.match(body, /\.rb-ar\[data-camera="off"\] \.rb-ar-video/);
  assert.match(body, /\.rb-ar\[data-mode="radar"\] \.rb-ar-radar/);

  // Phase 5: near-nest AR labels, the here dot, the collect fx.
  assert.match(body, /\.rb-ar-label\[data-kind="nest"\]\[data-near="true"\]/);
  assert.match(body, /\.rb-ar-label:not\(\[data-side\]\)\.rb-ar-fx-collect \.rb-ar-egg-art/);
  assert.match(body, /\.rb-nest-pin\.rb-nest-collect svg/);
  assert.match(body, /\.rb-ar-egg-art \{[^}]*order: -1/);
  assert.match(body, /prefers-reduced-motion[\s\S]*\.rb-nest-pin\.rb-nest-busy \{ box-shadow/);
  assert.ok(body.includes("#ramble .rb-pop-avatar {"), "a contact's picture on the pin has its rule");

  assert.ok(body.includes("#ramble .rb-fog {"), "the fog mask has a rule");
  assert.ok(body.includes("#ramble .rb-frontier-cell {"), "the frontier is dimmed, not hidden");
  assert.ok(body.includes("#ramble .rb-beacon {"), "beacons have a rule");

  assert.ok(body.includes("#ramble .rb-here-pet {"), "the pet marker has a rule");
  assert.ok(body.includes("@keyframes rb-waddle"));
  assert.ok(body.includes("#ramble .rb-here-pet.is-walking"));
  assert.ok(body.includes("#ramble .rb-here-pet.rb-here-plain::before {"), "the engine-less fallback dot has a rule");

  assert.ok(body.includes("#ramble .rb-fold > summary {"), "the fold has its own summary rule");
  assert.ok(body.includes("summary::-webkit-details-marker"), "and hides the OS triangle for a marker in the display font");
  assert.ok(body.includes("#ramble .rb-fold > summary:focus-visible"), "and stays keyboard-visible");
  assert.ok(body.includes("#ramble .rb-seed-pip {"), "seed pips have a rule");
  assert.ok(body.includes("#ramble .rb-seed-dot {"), "and the engine-less fallback dot has its own");
  assert.ok(body.includes("filter: url(#rb-fog-clouds)"), "the mask actually references the cloud filter");
  assert.ok(body.includes("#ramble .rb-voice.leaflet-tooltip {"), "the bird's bubble is styled");
  assert.ok(body.includes("#ramble .rb-voice.leaflet-tooltip-top:before"), "including the tail that makes it a speech bubble");
  assert.match(body, /rb-unlock-flash \{[^}]*fill-opacity: 0;/,
    "the unlock square is invisible without its animation, so reduced-motion leaves no fog block behind");
  assert.ok(body.includes("#ramble .rb-seed-pop {"), "the pickup pop has a rule");
  assert.ok(body.includes("@keyframes rb-seed-rise"), "and an animation");
  assert.match(body, /prefers-reduced-motion[\s\S]*\.rb-seed-pop \{ animation: none/,
    "which honours prefers-reduced-motion like every sibling");

  assert.ok(body.includes("@keyframes rb-unlock"), "the unlock has an animation");
  assert.ok(body.includes("#ramble .rb-seed {"), "the seed counter has a rule");
});

test("heart pips, the fallback dot and the pop all have styles", async () => {
  const css = await (await req("/ramble/static/ramble.css")).text();
  assert.ok(css.includes("#ramble .rb-heart-pip {"));
  assert.ok(css.includes("#ramble .rb-heart-dot {"));
  assert.ok(css.includes("#ramble .rb-hearts {"), "the map-bar counter has a rule");
  assert.ok(css.includes("#ramble .rb-heart-pop {"));
  assert.ok(css.includes("@keyframes rb-heart-rise"));
  // The heart pop joins the EXISTING comma-separated reduced-motion list, so
  // match it as a member of that list rather than as its own rule.
  assert.match(css, /prefers-reduced-motion[\s\S]*#ramble \.rb-heart-pop,[\s\S]*animation: none/,
    "the pop respects reduced motion, like the seed pop already does");
  assert.ok(css.includes("#ramble .rb-heart-pip > svg {"),
    "the pip's svg is SIZED — without this it renders at the CSS default 300x150");
});

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

  // hidden is an HTMLElement property, not an SVGElement one: setHidden
  // toggles the attribute directly so the bird/egg <svg> pair can actually
  // show and hide, and paintBird's own react() reads the attribute back
  // instead of the dead expando it used to write.
  assert.ok(body.includes("function setHidden(el, on)"), "the attribute-toggling helper is defined");
  assert.deepEqual(body.match(/\.hidden\s*=(?!=)/g) || [], [], "no .hidden = assignment remains anywhere in the file");
  assert.ok(!body.includes(".bird.hidden") && !body.includes(".egg.hidden"), "no remaining .hidden property read either");
  assert.ok(body.includes('e.bird.hasAttribute("hidden")'), "the read site tests the attribute, not the property");

  assert.equal((await realFetch(BASE + "/ramble/static/ramble-ar.js")).status, 401);
});

test("GET /ramble/static/leaflet/leaflet.js serves the vendored copy", async () => {
  const res = await req("/ramble/static/leaflet/leaflet.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
});

test("static route refuses path traversal", async () => {
  const encoded = await req("/ramble/static/..%2f..%2fmanifest.json");
  assert.ok(encoded.status >= 400 && encoded.status < 500,
    `expected 4xx for the encoded traversal, got ${encoded.status}`);
  const plain = await req("/ramble/static/../../manifest.json");
  assert.ok(plain.status >= 400 && plain.status < 500,
    `expected 4xx for the plain traversal, got ${plain.status}`);
});

// ------------------------------------------------------------- owner delete

test("DELETE /api/ramble/marks/:id removes a local mark and 404s an unknown one", async () => {
  const created = await (await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: LAT, lon: LON, text: "delete me", visibility: "public", reveal: "open" },
  })).json();

  const deletesBefore = emitCalls.filter((c) => c.op === "delete").length;
  const gone = await req(`/api/ramble/marks/${created.mark.mark_id}`, { method: "DELETE" });
  assert.equal(gone.status, 204);

  const deletes = emitCalls.filter((c) => c.table === "ramble_marks" && c.op === "delete");
  assert.equal(deletes.length, deletesBefore + 1, "owner delete must emit a ramble_marks delete");
  assert.equal(deletes[deletes.length - 1].row.mark_id, created.mark.mark_id);

  const again = await req(`/api/ramble/marks/${created.mark.mark_id}`, { method: "DELETE" });
  assert.equal(again.status, 404);
});

test("deleting an already-published public mark leaves a tombstone for the drain (R14)", async () => {
  const created = await (await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: LAT, lon: LON, text: "published then withdrawn",
            visibility: "public", reveal: "open" },
  })).json();
  const markId = created.mark.mark_id;
  const eventId = "e".repeat(64);

  const db = createDbClient();
  try {
    // Stand in for the transport having published it.
    await db.execute({
      sql: "UPDATE ramble_marks SET publish_state='published', nostr_event_id=? WHERE mark_id=?",
      args: [eventId, markId],
    });

    const res = await req(`/api/ramble/marks/${markId}`, { method: "DELETE" });
    assert.equal(res.status, 204);

    const { rows } = await db.execute({
      sql: "SELECT * FROM ramble_tombstones WHERE nostr_event_id = ?",
      args: [eventId],
    });
    assert.equal(rows.length, 1, "no tombstone row was written");
    assert.equal(rows[0].mark_id, markId);
    assert.equal(rows[0].kind, "mark");
  } finally {
    db.close();
  }
});

// ------------------------------------------------------- locked teasers (R18)

test("a locked mark lists as an approximate cell-centre teaser, then unlocks in range", async () => {
  // No `reveal` in the body -> public marks default to `locked`.
  const created = await (await req("/api/ramble/marks", {
    method: "POST",
    body: { kind: "mark", lat: LAT, lon: LON, text: "under the third oak", visibility: "public" },
  })).json();
  assert.equal(created.mark.reveal, "locked");

  const { marks } = await (await req(`/api/ramble/marks?visibility=public&cells=${CELL}`)).json();
  const teaser = marks.find((m) => m.mark_id === created.mark.mark_id);
  assert.ok(teaser, "the locked mark did not list");

  // The teaser must give the map something to pin WITHOUT leaking the anchor.
  assert.equal(teaser.lat, undefined);
  assert.equal(teaser.lon, undefined);
  assert.equal(teaser.content_text, undefined);
  assert.equal(typeof teaser.approx_lat, "number");
  assert.equal(typeof teaser.approx_lon, "number");
  assert.ok(teaser.approx_m > 0, `approx_m was ${teaser.approx_m}`);
  // Cell centre, not the real point: a 7-char cell is a few hundred metres.
  assert.ok(Math.abs(teaser.approx_lat - LAT) < 0.01);
  assert.ok(Math.abs(teaser.approx_lon - LON) < 0.01);

  const petBefore = await (await req("/api/ramble/pet")).json();

  const unlocked = await (await req("/api/ramble/unlock", {
    method: "POST",
    body: { mark_id: created.mark.mark_id, lat: LAT, lon: LON },
  })).json();
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.content.content_text, "under the third oak");
  // Same contract as authoring: the client reads `result.hatched` here.
  assert.ok("hatched" in unlocked, "POST /api/ramble/unlock must report `hatched`");
  assert.equal(unlocked.hatched, null);

  const petAfter = await (await req("/api/ramble/pet")).json();
  assert.equal(petAfter.unlocks_week, petBefore.unlocks_week + 1, "a successful unlock must feed unlock_mark");
});

// ------------------------------------------------------ nests, flock, shelf (phase 2)

let claimedNest = null;   // set by the claim test, read by the flock/incubate tests
let claimedEggId = null;

test("GET /api/ramble/nests lists deterministic nests for a viewport and 400s a bad or too-wide bbox", async () => {
  const bbox = `${LAT - 0.01},${LON - 0.01},${LAT + 0.01},${LON + 0.01}`;
  // Fog gates public terrain (spec 2026-09-08 §2.1), so the viewport must
  // contain ground we have actually stood in before a nest is anything but a
  // beacon. Nests are deterministic, so we can walk straight to one.
  const week = isoWeek(Date.now());
  const target = nestsInCells(
    cellsInBbox({ south: LAT - 0.01, west: LON - 0.01, north: LAT + 0.01, east: LON + 0.01 }),
    week,
    { rate: NEST_RATE_DEFAULT },
  )[0];
  assert.ok(target, "the fixture bbox must hold at least one deterministic nest");
  await walkTo(target.lat, target.lon);

  const res = await req(`/api/ramble/nests?bbox=${bbox}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.week, /^\d{4}-W\d{2}$/);
  assert.ok(body.nests.length > 0, "a ~2 km box at rate 24 must hold nests");
  const whole = body.nests.find((n) => n.cell === target.cell);
  assert.ok(whole, "the nest we walked to is listed in full");
  claimedNest = whole;   // explicit: do not rely on body.nests[0] still being the whole one
  assert.deepEqual(Object.keys(whole).sort(), ["cell", "claimed", "lat", "lon", "seed", "week"]);
  for (const n of body.nests) {
    if (n.cell === target.cell) continue;
    assert.deepEqual(Object.keys(n).sort(), ["beacon", "kind", "lat", "lon"], "the rest are beacons");
  }
  const again = await (await req(`/api/ramble/nests?bbox=${bbox}`)).json();
  assert.deepEqual(again, body);

  assert.equal((await req("/api/ramble/nests?bbox=1,2,3")).status, 400);
  assert.equal((await req("/api/ramble/nests?bbox=a,b,c,d")).status, 400);
  assert.equal((await req("/api/ramble/nests?bbox=91,0,92,1")).status, 400);
  assert.equal((await req("/api/ramble/nests?bbox=30,-99,31,-98")).status, 400, "too wide must be refused, not computed");
  assert.equal((await req("/api/ramble/nests")).status, 400);
});

test("POST /api/ramble/nests/claim: too far is a friendly refusal; in range claims once; the claim emits the egg", async () => {
  assert.ok(claimedNest, "the nests test must run first");
  // Fog gates public terrain: walk to the nest before claiming, exactly as a
  // real player would — the walk unlocks the cell, then the claim follows.
  await walkTo(claimedNest.lat, claimedNest.lon);
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
  const activated = [];
  const onActivated = (p) => activated.push(p);
  bus.on("ramble:bird-activated", onActivated);
  const res = await req("/api/ramble/birds/panel-bird/activate", { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { bird: { egg_id: "panel-bird", species: "magpie", seed: 4242 } });
  bus.off("ramble:bird-activated", onActivated);
  assert.deepEqual(activated, [{ egg_id: "panel-bird" }], "activation pokes the bus so core can repaint a bird avatar (spec §5)");
  assert.equal(emitCalls.filter((c) => c.table === "ramble_pet" && c.op === "update").length, petUpdatesBefore + 1, "activation must emit the pet row");
  const pet = await (await req("/api/ramble/pet")).json();
  assert.deepEqual(pet.bird, { egg_id: "panel-bird", species: "magpie", seed: 4242 });
  const flock = await (await req("/api/ramble/flock")).json();
  assert.equal(flock.birds.find((b) => b.egg_id === "panel-bird")?.active, true);
  assert.equal(flock.birds.filter((b) => b.active).length, 1, "exactly one active bird");
});

// -------------------------------------------------------- phase 3: contacts wire

test("GET /api/ramble/contacts lists full contacts and plain groups only", async () => {
  const out = await (await req("/api/ramble/contacts")).json();
  assert.deepEqual(out.contacts, [{ crow_id: "crow:buddy", display_name: "Buddy" }, { crow_id: "crow:pal", display_name: "Pal" }]);
  assert.deepEqual(out.groups, [{ group_uid: "grp-walk", name: "Walkers", member_count: 1 }]);
});

test("POST /api/ramble/marks: contacts fans out to every contact, group:<uid> to its members, an unknown group is a 400", async () => {
  const body = { kind: "mark", lat: LAT, lon: LON, text: "for you two", visibility: "contacts", reveal: "open" };
  let res = await req("/api/ramble/marks", { method: "POST", body });
  assert.equal(res.status, 201);
  let out = await res.json();
  assert.equal(out.recipients, 2);
  assert.equal(out.mark.publish_state, "pending", "queued, not published — the transport sends");
  const db = createDbClient();
  const { rows } = await db.execute({ sql: "SELECT to_crow_id, kind FROM ramble_outbox WHERE ref_id = ? ORDER BY to_crow_id", args: [out.mark.mark_id] });
  assert.deepEqual(rows.map((r) => [r.to_crow_id, r.kind]), [["crow:buddy", "mark"], ["crow:pal", "mark"]]);
  res = await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "group:grp-walk" } });
  assert.equal(res.status, 201); assert.equal((await res.json()).recipients, 1);
  res = await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "group:grp-room" } });
  assert.equal(res.status, 400, "a room is not a group");
  assert.equal((await res.json()).error, "unknown group");
  assert.equal((await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "group:nope" } })).status, 400);
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_marks WHERE visibility='group:nope'")).rows[0].n, 0, "no row for a refused group");
  res = await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "public" } });
  assert.equal((await res.json()).recipients, 0, "public marks take the relay path, not the outbox");
});

test("GET /api/ramble/marks names a remote mark by a contact; a stranger's stays anonymous", async () => {
  const db = createDbClient();
  await db.execute({
    sql: `INSERT INTO ramble_marks (mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, visibility, reveal, content_text, created_at, origin, publish_state)
          VALUES ('by-pal', ?, 'real', 'mark', 'geo', '9v6m21h', ?, ?, 'contacts', 'open', 'hi', ?, 'remote', 'remote'),
                 ('by-stranger', ?, NULL, 'mark', 'geo', '9v6m21h', ?, ?, 'public', 'open', 'yo', ?, 'remote', 'remote')`,
    args: [PK, LAT, LON, Date.now(), "99".repeat(32), LAT, LON, Date.now()],
  });

  // Regression guard for the gate itself (spec 2026-09-08 §2.1): before any
  // ground here is unlocked, the stranger's PUBLIC mark must be fogged off
  // entirely while the contact's mark survives untouched. If `annotateMarks`
  // ever stopped calling `gateForZones`, this is the assertion that would
  // fail — the four tests below only add unlocked ground, so none of them
  // would notice a removed gate.
  const beforeWalk = (await (await req(`/api/ramble/marks?cells=${CELL}`)).json()).marks;
  assert.ok(!beforeWalk.some((m) => m.mark_id === "by-stranger"), "a stranger's public mark is absent in fog");
  assert.ok(beforeWalk.some((m) => m.mark_id === "by-pal"), "a contact's mark is never gated");

  // Fog gates the public overlay: walking to the nest (a different, distant
  // cell) does not unlock this fixture's own LAT/LON ground, so the stranger's
  // public mark here would otherwise fog off and `.find(...)` would return
  // undefined.
  await walkTo(LAT, LON);
  const { marks } = await (await req(`/api/ramble/marks?cells=${CELL}`)).json();
  assert.equal(marks.find((m) => m.mark_id === "by-pal").contact_name, "Pal");
  assert.equal(marks.find((m) => m.mark_id === "by-stranger").contact_name, undefined);
  assert.equal(marks.find((m) => m.mark_id === "by-pal").contact_avatar, "data:image/png;base64," + "A".repeat(32), "a contact's picture rides beside the name");
  assert.equal(marks.find((m) => m.mark_id === "by-stranger").contact_avatar, undefined);
});

test("POST /api/ramble/eggs/:id/gift: unknown contact 400, unknown egg 404, incubating egg 409, shelf egg goes 'gifted' and queues one DM", async () => {
  const db = createDbClient();
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('gift-me','shelf','user',7,1) ON CONFLICT(egg_id) DO NOTHING", args: [] });
  assert.equal((await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: { crow_id: "crow:nobody" } })).status, 400);
  assert.equal((await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: { crow_id: "crow:blocked" } })).status, 400);
  assert.equal((await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: {} })).status, 400);
  assert.equal((await req("/api/ramble/eggs/nope/gift", { method: "POST", body: { crow_id: "crow:pal" } })).status, 404);
  const inc = (await (await req("/api/ramble/egg")).json()).egg.egg_id;
  const r409 = await req(`/api/ramble/eggs/${inc}/gift`, { method: "POST", body: { crow_id: "crow:pal" } });
  assert.equal(r409.status, 409); assert.equal((await r409.json()).error, "not-an-egg");
  const before = emitCalls.length;
  const res = await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: { crow_id: "crow:pal" } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual([out.egg.egg_id, out.egg.status, out.to], ["gift-me", "gifted", "crow:pal"]);
  assert.ok(emitCalls.slice(before).some((c) => c.table === "ramble_eggs" && c.op === "update" && c.row.egg_id === "gift-me" && c.row.status === "gifted"));
  const { rows } = await db.execute({ sql: "SELECT to_crow_id, kind, payload_json FROM ramble_outbox WHERE ref_id = 'gift-me'", args: [] });
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, "egg");
  const payload = JSON.parse(rows[0].payload_json);
  assert.deepEqual(Object.keys(payload.egg).sort(), ["egg_id", "found_cell", "found_week", "warmth"]);
  const flock = await (await req("/api/ramble/flock")).json();
  assert.ok(!flock.eggs.find((e) => e.egg_id === "gift-me"), "a gifted egg is off the shelf");
});

test("swaps over the routes: propose 201, list, accept refuses on the proposer side, decline 200; a planted incoming offer accepts with a shelf egg", async () => {
  const db = createDbClient();
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('offer-me','shelf','user',9,1), ('answer-with','received','user',4,2) ON CONFLICT(egg_id) DO NOTHING", args: [] });
  assert.equal((await req("/api/ramble/trades", { method: "POST", body: { egg_id: "offer-me", crow_id: "crow:nobody" } })).status, 400);
  assert.equal((await req("/api/ramble/trades", { method: "POST", body: { egg_id: "nope", crow_id: "crow:pal" } })).status, 404);
  let res = await req("/api/ramble/trades", { method: "POST", body: { egg_id: "offer-me", crow_id: "crow:pal" } });
  assert.equal(res.status, 201);
  const { trade } = await res.json();
  assert.deepEqual([trade.role, trade.state, trade.my_egg_id, trade.counterpart], ["proposer", "proposed", "offer-me", "crow:pal"]);
  res = await req("/api/ramble/trades", { method: "POST", body: { egg_id: "offer-me", crow_id: "crow:buddy" } });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, "in-trade");
  assert.equal((await req("/api/ramble/eggs/offer-me/incubate", { method: "POST", body: {} })).status, 409, "a locked egg cannot be incubated");
  assert.equal((await req("/api/ramble/eggs/offer-me/gift", { method: "POST", body: { crow_id: "crow:buddy" } })).status, 409);
  const list = await (await req("/api/ramble/trades")).json();
  const mine = list.trades.find((t) => t.trade_id === trade.trade_id);
  assert.deepEqual([mine.open, mine.counterpart_name, mine.offer], [true, "Pal", null]);
  assert.equal((await (await req("/api/ramble/flock")).json()).eggs.find((e) => e.egg_id === "offer-me").locked, true);
  res = await req(`/api/ramble/trades/${trade.trade_id}/accept`, { method: "POST", body: { egg_id: "answer-with" } });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, "not-open");
  assert.equal((await req("/api/ramble/trades/ghost/decline", { method: "POST", body: {} })).status, 404);
  res = await req(`/api/ramble/trades/${trade.trade_id}/decline`, { method: "POST", body: {} });
  assert.equal(res.status, 200); assert.equal((await res.json()).trade.state, "declined");
  assert.equal((await (await req("/api/ramble/flock")).json()).eggs.find((e) => e.egg_id === "offer-me").locked, false);

  await db.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('in-1','crow:buddy','acceptor',NULL,'their-egg','{\"egg_id\":\"their-egg\",\"warmth\":50,\"found_cell\":null,\"found_week\":null}','proposed',1,1,?)", args: [Date.now() + 1e9] });
  const incoming = (await (await req("/api/ramble/trades")).json()).trades.find((t) => t.trade_id === "in-1");
  assert.deepEqual([incoming.counterpart_name, incoming.offer.warmth, incoming.open], ["Buddy", 50, true]);
  assert.equal((await req("/api/ramble/trades/in-1/accept", { method: "POST", body: { egg_id: "nope" } })).status, 409);
  assert.equal((await req("/api/ramble/trades/in-1/accept", { method: "POST", body: {} })).status, 400);
  res = await req("/api/ramble/trades/in-1/accept", { method: "POST", body: { egg_id: "answer-with" } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).trade.state, "accepted");
  const { rows } = await db.execute({ sql: "SELECT to_crow_id, payload_json FROM ramble_outbox WHERE ref_id = 'in-1'", args: [] });
  assert.equal(rows[0].to_crow_id, "crow:buddy");
  assert.equal(JSON.parse(rows[0].payload_json).trade.state, "accepted");
  assert.equal(JSON.parse(rows[0].payload_json).egg.egg_id, "answer-with");
});

test("contacts, gift and trade routes are behind dashboardAuth", async () => {
  for (const [method, path] of [["GET", "/api/ramble/contacts"], ["GET", "/api/ramble/trades"], ["POST", "/api/ramble/trades"], ["POST", "/api/ramble/eggs/x/gift"], ["POST", "/api/ramble/trades/x/accept"], ["POST", "/api/ramble/trades/x/decline"]]) {
    const res = await realFetch(BASE + path, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("nests, claim, flock, incubate and activate are behind dashboardAuth", async () => {
  assert.equal((await realFetch(BASE + "/api/ramble/nests?bbox=0,0,0.001,0.001")).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/flock")).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/nests/claim", { method: "POST" })).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/eggs/x/incubate", { method: "POST" })).status, 401);
  assert.equal((await realFetch(BASE + "/api/ramble/birds/x/activate", { method: "POST" })).status, 401);
});

// ------------------------------------------------------------- tile proxy
// R17: the dashboard CSP is img-src 'self' data: blob:, so map tiles must be
// same-origin. Upstream is never contacted here -- global.fetch is stubbed.

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return impl(String(url), options);
  };
  return calls;
}

test("tile proxy rejects an out-of-range zoom and an out-of-range x", async () => {
  const calls = stubFetch(async () => { throw new Error("upstream must not be called"); });
  try {
    assert.equal((await req("/ramble/tiles/20/0/0.png")).status, 400);
    assert.equal((await req("/ramble/tiles/1/5/0.png")).status, 400);
    assert.equal(calls.length, 0, "a rejected tile request still hit upstream");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("tile proxy serves upstream bytes same-origin and then from its LRU", async () => {
  const calls = stubFetch(async () => new Response(PNG, {
    status: 200, headers: { "content-type": "image/png" },
  }));
  try {
    const first = await req("/ramble/tiles/1/0/0.png");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/png");
    assert.match(first.headers.get("cache-control") || "", /max-age=86400/);
    assert.equal(Buffer.from(await first.arrayBuffer()).equals(PNG), true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/tile\.openstreetmap\.org\/1\/0\/0\.png$/);

    const second = await req("/ramble/tiles/1/0/0.png");
    assert.equal(second.status, 200);
    assert.equal(Buffer.from(await second.arrayBuffer()).equals(PNG), true);
    assert.equal(calls.length, 1, "the second request should have come from the LRU");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("tile proxy refuses a non-image upstream response", async () => {
  stubFetch(async () => new Response("<html>rate limited</html>", {
    status: 200, headers: { "content-type": "text/html; charset=utf-8" },
  }));
  try {
    const res = await req("/ramble/tiles/3/1/2.png");
    assert.equal(res.status, 502);
    // Never cached: a second request must fail the same way, not serve HTML.
    assert.equal((await req("/ramble/tiles/3/1/2.png")).status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("tiles and static assets are behind dashboardAuth", async () => {
  assert.equal((await realFetch(BASE + "/ramble/tiles/1/0/0.png")).status, 401);
  assert.equal((await realFetch(BASE + "/ramble/static/ramble.js")).status, 401);
});

test("tile proxy answers 502 when upstream fails", async () => {
  stubFetch(async () => new Response("nope", { status: 500 }));
  try {
    const res = await req("/ramble/tiles/2/1/1.png");
    assert.equal(res.status, 502);
    assert.equal((await res.text()).length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------- STRICT_PANEL_MOUNT contract

test("the router registers no unpathed router.use(middleware) layer", () => {
  // Replicates servers/gateway/index.js:648-651 (`slash === true`, Express 5)
  // AND the Express 4 spelling of the same thing (`regexp.fast_slash`), which
  // is what this repo actually runs — a middleware that matched every path
  // would swallow traffic destined for panels mounted after this one.
  const layers = routerInstance?.stack || [];
  const unscoped = layers.filter((l) => !l.route &&
    (l.slash === true || l.regexp?.fast_slash === true));
  assert.deepEqual(unscoped.map((l) => l.name), [],
    "every router.use() in panel/routes.js must carry a path prefix");
});

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
    // Fog gates nests too (spec 2026-09-08 §2.1). With nothing unlocked at
    // LAT/LON every nest here is fog and the array is empty; walking to just
    // the one point (walkTo) is not enough either — a nest elsewhere in the
    // 500 m radius but past the depth-3 frontier reach (~460 m) would still
    // come back as a beacon missing `distance_m`/`seed`, breaking this test's
    // per-nest assertions below. Unlock the whole radius the route reads.
    await unlockRadius(LAT, LON, 500);
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
    // Regression guard for the under-gating half: unlockRadius(LAT, LON, 500)
    // above unlocks only the 500 m disc, so this wider 1000 m call reaches
    // ground past it, where a nest.rate=1 nest still exists but is not
    // unlocked. If gating were ever removed from /around, every nest here
    // would come back whole and this would fail.
    assert.ok(wide.nests.some((n) => n.beacon === true), "ground past the unlocked disc must still produce a beacon");
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
  assert.equal(pal?.contact_avatar, "data:image/png;base64," + "A".repeat(32));
  assert.equal((await realFetch(BASE + `/api/ramble/around?lat=${LAT}&lon=${LON}`)).status, 401);
});

// ------------------------------------------------------------- docs parity

test("docs: the Spanish Ramble guide mirrors the English heading structure", () => {
  const levels = (p) => readFileSync(join(REPO_ROOT, p), "utf8").split("\n")
    .filter((l) => /^#{2,3} /.test(l)).map((l) => l.split(" ")[0]);
  assert.deepEqual(levels("docs/es/guide/ramble.md"), levels("docs/guide/ramble.md"),
    "en/es Ramble guides must have the same number, order and level of ##/### headings");
});

test("GET /api/ramble/zones reports which visible cells still have seed waiting", async () => {
  // Deliberately far from every other coordinate in this file: walkTo unlocks
  // permanently, so a shared point would let an earlier test decide this one.
  const LAT = 10.5, LON = 20.5;
  const pad = 0.004;
  const bbox = [LAT - pad, LON - pad, LAT + pad, LON + pad].join(",");

  // Seed is SPARSE (one cell in seed.rate). This test is about the ROUTE, not
  // the spawn lottery, so pin rate 1 — otherwise it passes or fails on whether
  // this particular cell happened to hash lucky. seedFor's own tests cover the
  // lottery.
  const rateDb = createDbClient();
  try {
    await rateDb.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.rate', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  } finally { rateDb.close(); }

  // First visit UNLOCKS and pays nothing — so the cell is offering seed.
  await walkTo(LAT, LON);
  const url = "/api/ramble/zones?bbox=" + encodeURIComponent(bbox) + "&pips=1";
  const first = await (await req(url)).json();
  assert.ok(Array.isArray(first.seed), "the wire carries a seed list");
  assert.equal(first.seed.length, 1, "the freshly unlocked cell is offering seed");
  const pip = first.seed[0];
  // A POINT, not a footprint: the seed sits somewhere inside its cell.
  assert.ok(Number.isFinite(pip.lat) && Number.isFinite(pip.lon), "a pip carries a real position");
  assert.ok(
    first.unlocked.some((c) => c.south <= pip.lat && c.north >= pip.lat && c.west <= pip.lon && c.east >= pip.lon),
    "and it only ever sits on unlocked ground",
  );

  // Second visit HARVESTS it, so the pip must go.
  await walkTo(LAT, LON);
  const second = await (await req(url)).json();
  assert.equal(second.seed.length, 0, "a harvested cell stops offering until the window turns");
  assert.ok(second.unlocked.length >= 1, "but the ground stays unlocked");

  // Zoomed out, the client does not ask for pips and must not be sent any.
  const noPips = await (await req("/api/ramble/zones?bbox=" + encodeURIComponent(bbox))).json();
  assert.deepEqual(noPips.seed, [], "no pips requested, none built — the ledger query is skipped too");
  assert.ok(noPips.unlocked.length >= 1, "the shape still comes back");
});

test("GET /api/ramble/zones answers a world-sized bbox instead of refusing it", async () => {
  // The ceiling that used to 400 here is what made fog unreachable: a player's
  // revealed region outgrows the viewport at the lowest zoom the ceiling
  // allowed, so they never saw its edge. Bounded by walking now, not by zoom.
  const res = await req("/api/ramble/zones?bbox=" + encodeURIComponent("-80,-170,80,170"));
  assert.equal(res.status, 200, "a world bbox is answerable");
  const out = await res.json();
  assert.ok(Array.isArray(out.unlocked) && Array.isArray(out.frontier));
});


/* --- Phase 2: heart containers (spec §2.3, §3). --- */

/**
 * ⚠ THIS FILE SHARES ONE SCRATCH DATABASE ACROSS EVERY TEST, so heart counts
 * accumulate as tests run and an unlock is permanent for every test after it.
 * Assert DELTAS, never absolute totals — an absolute assertion here passes
 * alone and fails in the suite, which is exactly the flake shape this repo has
 * hunted before.
 *
 * rate 1 so every cell in these tests holds a heart: no test may depend on a
 * cell that happens to hash lucky (the phase 1 lesson).
 */
async function withHeartSettings(pairs, fn) {
  const db = createDbClient();
  try {
    for (const [k, v] of pairs) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({
        sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [k, v],
      });
    }
    return await fn();
  } finally {
    for (const [k] of pairs) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({ sql: "DELETE FROM ramble_settings WHERE key = ?", args: [k] });
    }
    db.close();
  }
}

// `warmth.visit_place` is zeroed for the same reason walkTo() zeroes it: this
// file churns hatches and later asserts an incubating egg exists, and three or
// four +20 credits against a hatch_at of 100 is a hatch these tests did not ask
// for.
const HEARTS_ON = [
  ["heart.rate", "1"], ["heart.wild.rate", "999999"],
  ["unlock.max.accuracy.m", "100"], ["warmth.visit_place", "0"],
];
const jsonOf = async (path, opts) => (await req(path, opts)).json();

test("POST /api/ramble/area grants a heart on a first unlock, and reports the new ceiling", async () => {
  await withHeartSettings(HEARTS_ON, async () => {
    const here = { lat: 30.2672, lon: -97.7431, accuracy_m: 20 };
    const before = await jsonOf("/api/ramble/pet");

    const first = await jsonOf("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2xt"], here } });
    assert.equal(first.heart_picked, 1, "the fogged cell had a heart in it");
    assert.equal(first.hearts, before.hearts + 1);
    assert.equal(first.energy_max, before.energy_max + 10, "the bar grew by energy.max.per.heart");

    const again = await jsonOf("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2xt"], here } });
    // Holds only because HEARTS_ON silences the wild source at rate 999999 —
    // otherwise the same cell could pay a second, regrown heart.
    assert.equal(again.heart_picked, undefined, "a permanent heart is taken once, ever");
    assert.equal(first.heart_source, "first", "and the source rides along, so the panel can say the right line");
    assert.equal(again.hearts, first.hearts, "the count still rides on every fix");
    assert.equal(again.energy_max, first.energy_max);
  });
});

test("a fix too vague to unlock is also too vague to pay a heart", async () => {
  await withHeartSettings(HEARTS_ON, async () => {
    const before = (await jsonOf("/api/ramble/pet")).hearts;
    const res = await jsonOf("/api/ramble/area", {
      method: "POST",
      // `cells` is only the active-area list; the cell that matters is derived
      // from `here` (Chicago -> dp3wjzt), which is fresh ground for this file.
      body: { cells: ["dp3wjzt"], here: { lat: 41.8781, lon: -87.6298, accuracy_m: 2000 } },
    });
    assert.equal(res.unlocked, undefined, "no unlock");
    assert.equal(res.heart_picked, undefined, "and therefore no heart");
    assert.equal((await jsonOf("/api/ramble/pet")).hearts, before, "nothing was granted");
  });
});

test("a vague fix cannot harvest a heart from ground unlocked LONG AGO", async () => {
  // ⚠ The one the plan review caught. The in-ramble_cells check passes for an
  // already-unlocked cell no matter how bad today's fix is, so this is the case
  // the "fail closed" claim actually has to survive. Unlock the cell sharply
  // while it holds no heart, then make it hold one, then arrive vaguely.
  const here = { lat: 35.6762, lon: 139.6503 };   // Tokyo: fresh ground for this file
  await withHeartSettings(
    [["heart.rate", "999999"], ["heart.wild.rate", "999999"], ["unlock.max.accuracy.m", "100"], ["warmth.visit_place", "0"]],
    async () => {
      // ⚠ NO `cells: []` — routes.js rejects an empty array with a 400, and a
      // 400 would make the assertions below pass vacuously against the buggy
      // implementation. Omitting `cells` entirely is the supported form: the
      // route falls back to lat/lon, exactly as walkTo() does.
      const sharp = await jsonOf("/api/ramble/area", {
        method: "POST", body: { ...here, here: { ...here, accuracy_m: 10 } },
      });
      assert.ok(sharp.unlocked, "precondition: the cell is unlocked, and held no heart");
    },
  );
  await withHeartSettings(HEARTS_ON, async () => {
    const before = (await jsonOf("/api/ramble/pet")).hearts;
    const vague = await jsonOf("/api/ramble/area", {
      method: "POST", body: { ...here, here: { ...here, accuracy_m: 2000 } },
    });
    assert.equal(vague.heart_picked, undefined,
      "a 2 km fix must not collect the heart now waiting in already-unlocked ground");
    assert.equal((await jsonOf("/api/ramble/pet")).hearts, before, "nothing was granted");
  });
});

test("POST /api/ramble/area WITHOUT `here` keeps its exact historical shape", async () => {
  const res = await jsonOf("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2xt"] } });
  assert.deepEqual(res, { cells: ["9v6m2xt"] },
    "no fix, no currency: panning the map must not report a wallet");
});

test("GET /api/ramble/zones?pips=1 draws hearts only in unlocked ground", async () => {
  // ⚠ A GENUINELY FRESH cell, and a length assertion BEFORE the loop. Two
  // earlier drafts got this wrong: the first reused Austin, whose heart the
  // previous test had already collected, so `hearts` was always [] and the loop
  // never ran; the second reused London, which is HERE_LAT/HERE_LON's own cell
  // (`gcpvj0d`) and is walked twice by the visit_place test — that draft passed
  // only because heartFor("gcpvj0d", {rate: 3}) happens to miss, which is the
  // lucky-hash dependency this plan bans.
  //
  // wecnrmd = 22.2233/114.2283, Hong Kong. No test in this file uses a latitude
  // anywhere near it (they use 10.5, 30.46, 48.8584 and 51.5074).
  await withHeartSettings(HEARTS_ON, async () => {
    const db = createDbClient();
    try {
      await db.execute({
        sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('wecnrmd', 1) ON CONFLICT(cell) DO NOTHING",
        args: [],
      });
    } finally { db.close(); }

    const bbox = "22.21,114.21,22.24,114.25";
    const withPips = await jsonOf("/api/ramble/zones?bbox=" + bbox + "&pips=1");
    assert.ok(Array.isArray(withPips.hearts), "the field is always an array");
    assert.ok(withPips.hearts.some((h) => h.cell === "wecnrmd"),
      "there IS a heart to draw, or this test proves nothing");
    for (const h of withPips.hearts) {
      assert.ok(withPips.unlocked.some((b) =>
        h.lat >= b.south && h.lat <= b.north && h.lon >= b.west && h.lon <= b.east),
        "a heart pip only ever sits in unlocked ground");
    }

    const noPips = await jsonOf("/api/ramble/zones?bbox=" + bbox);
    assert.deepEqual(noPips.hearts, [], "pips are a close-zoom detail; the client asks for them");
  });
});

test("a heart in ground unlocked before this feature existed waits on the map, and pays when walked to", async () => {
  // The K2 case, end to end: a row put straight into ramble_cells (exactly what
  // phase 1's backfill left behind) still has its heart to walk back to.
  await withHeartSettings(HEARTS_ON, async () => {
    const db = createDbClient();
    try {
      await db.execute({
        sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('u33dc0e', 1) ON CONFLICT(cell) DO NOTHING",
        args: [],
      });
    } finally { db.close(); }
    // u33dc0e decodes to 52.5181, 13.4081 (Berlin); this bbox contains it.
    const zones = await jsonOf("/api/ramble/zones?bbox=52.50,13.35,52.54,13.46&pips=1");
    assert.equal(zones.hearts.filter((h) => h.cell === "u33dc0e").length, 1,
      "a cell unlocked before this feature shipped still has its heart waiting");

    // And walking there really does collect the pip the map just drew.
    const before = (await jsonOf("/api/ramble/pet")).hearts;
    const walked = await jsonOf("/api/ramble/area", {
      method: "POST", body: { lat: 52.5181, lon: 13.4081, here: { lat: 52.5181, lon: 13.4081, accuracy_m: 15 } },
    });
    assert.equal(walked.heart_picked, 1, "the pip the map drew is the heart the walk grants");
    assert.equal(walked.hearts, before + 1);
    const after = await jsonOf("/api/ramble/zones?bbox=52.50,13.35,52.54,13.46&pips=1");
    assert.equal(after.hearts.filter((h) => h.cell === "u33dc0e").length, 0, "and the pip is gone");
  });
});

test("GET /api/ramble/pet carries the heart count and the ceiling", async () => {
  const body = await jsonOf("/api/ramble/pet");
  assert.equal(typeof body.hearts, "number");
  assert.equal(typeof body.energy_max, "number");
  assert.equal(body.energy_max, 100 + body.hearts * 10,
    "the ceiling is derived from the count the same response reports");
});
