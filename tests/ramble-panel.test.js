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
import { mkdtempSync, rmSync } from "node:fs";
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

test("panel handler renders the map mount and the client script tag", async () => {
  let sent = null;
  const res = { send: (html) => { sent = html; } };
  await panel.handler({ query: {} }, res, {
    db: null,
    layout: ({ content }) => content,
    appRoot: REPO_ROOT,
  });
  assert.ok(sent, "handler sent nothing");
  assert.match(sent, /id="ramble-map"/);
  assert.match(sent, /\/ramble\/static\/ramble\.js/);
  assert.match(sent, /\/ramble\/static\/leaflet\/leaflet\.css/);
  assert.match(sent, /id="ramble-pet"/);
  assert.match(sent, /id="ramble-marks"/);
  assert.match(sent, /name="grid-public-geo"/);
  // Android WebView pull-to-refresh guard (fix/android-geolocation-map-swipe):
  // the map must opt out of the browser/WebView's own touch gestures so a
  // northward drag pans Leaflet instead of triggering SwipeRefreshLayout.
  assert.match(sent, /touch-action:\s*none/);
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
  const { mark } = await res.json();
  assert.ok(mark?.mark_id, "no mark_id in the response");
  assert.equal(mark.publish_state, "pending");

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

// The tests above leave the egg partway to the default hatch_at of 100, and
// the ones below add more warmth still. Raise the threshold so a mid-test
// hatch (which resets warmth to a fresh egg's zero) can't make the exact
// before/after warmth assertions below non-monotonic. It also proves the
// `warmth.*` settings override actually reaches the route.
test("a warmth.hatch_at settings override reaches the egg route", async () => {
  const db = createDbClient();
  try {
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES ('warmth.hatch_at', '100000')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [],
    });
  } finally {
    db.close();
  }
  const { egg } = await (await req("/api/ramble/egg")).json();
  assert.equal(egg.hatch_at, 100000);
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

  const petAfter = await (await req("/api/ramble/pet")).json();
  assert.equal(petAfter.unlocks_week, petBefore.unlocks_week + 1, "a successful unlock must feed unlock_mark");
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
