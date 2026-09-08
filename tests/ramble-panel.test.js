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
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', '02${PK}');
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
  assert.ok(body.includes('className: "rb-here-dot"') && body.includes('className: "rb-here-ring"'));
  assert.ok(body.includes('map.createPane("rb-here")') && body.includes('getPane("rb-here").style.zIndex = 650'));
  assert.ok(body.includes("function startMapWatch(") && body.includes("function paintHere(") && body.includes("function setFollowing("));
  assert.ok(body.includes('map.on("dragstart"'), "a user drag ends follow mode");
  assert.ok(body.includes("getBounds().pad(-0.3)"), "follow pans only when the dot leaves the middle of the view");
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

  const code = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const sinks = code.match(/\.innerHTML\s*=|\bhtml:\s/g) || [];
  assert.equal(sinks.length, 2, `expected exactly two engine-output markup sinks, found ${sinks.length}`);
  assert.ok(code.includes("el.innerHTML = Bird.drawEgg("));
  assert.ok(code.includes("html: nestEggHtml("));
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
  assert.match(body, /\.rb-here-dot/);
  assert.match(body, /\.rb-nest-pin\.rb-nest-collect svg/);
  assert.match(body, /\.rb-ar-egg-art \{[^}]*order: -1/);
  assert.match(body, /prefers-reduced-motion[\s\S]*\.rb-nest-pin\.rb-nest-busy \{ box-shadow/);
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
  const { marks } = await (await req(`/api/ramble/marks?cells=${CELL}`)).json();
  assert.equal(marks.find((m) => m.mark_id === "by-pal").contact_name, "Pal");
  assert.equal(marks.find((m) => m.mark_id === "by-stranger").contact_name, undefined);
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

// ------------------------------------------------------------- docs parity

test("docs: the Spanish Ramble guide mirrors the English heading structure", () => {
  const levels = (p) => readFileSync(join(REPO_ROOT, p), "utf8").split("\n")
    .filter((l) => /^#{2,3} /.test(l)).map((l) => l.split(" ")[0]);
  assert.deepEqual(levels("docs/es/guide/ramble.md"), levels("docs/guide/ramble.md"),
    "en/es Ramble guides must have the same number, order and level of ##/### headings");
});
