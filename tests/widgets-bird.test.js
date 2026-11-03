/**
 * "Your bird" (widgets phase 3, PR 1): GET /dashboard/widgets-api/bird — the owner's own bird, drawn.
 *
 * The phone has no SVG decoder, so the gateway answers with the drawing itself: the SAME SVG string
 * the profile picture is made of (servers/sharing/profile-avatar.js renderBirdSvg over readPortrait —
 * the active bird, its current decayed mood, its outfit and the walked-today badge) plus the mood and
 * today's steps read server-side (for-you/today.js rambleState, the installed bundle's petState /
 * stepsState, no HTTP self-call).
 *
 *   - the owner's own local password session gets it; an SSO session, one minted by a login from this
 *     machine itself, a plain-scope session, a peer-signed call and a request from this machine get 404;
 *   - the JSON is { mood, steps, steps_goal, walked, svg }, no-store and never framed;
 *   - a dressed bird's SVG carries the outfit (the beanie the plain bird never draws);
 *   - Ramble not installed is 404 { code: "no_ramble" }, an installed Ramble with no bird is
 *     404 { code: "no_bird" }.
 *
 * Built on a scratch crow.db (init-db) with Ramble's own tables planted through the bundle's
 * init-tables.js, and the ways tests/widgets-routes.test.js builds its app (stub auth + the real
 * csrfMiddleware + the router's own owner check). The bundle read is a seam (today.js
 * _setTodaySeamsForTest) rather than a real bundle: it stands in for the whole read, install check
 * included.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const dir = mkdtempSync(join(tmpdir(), "widgets-bird-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-widgets-bird");
// Nothing installed: Ramble's presence is the seam's to claim, and the no_ramble case needs it absent.
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const NOW = Date.parse("2026-11-03T12:00:00Z");
const CLOCK = { t: NOW };

const OWN = "owner-sess";
const CSRF = "csrf-token-1";

let server, base, express;
let T, A, P; // today.js, profile-avatar.js, init-tables.js
let createDbClient;

/** The session stub widgets-routes.test.js uses: the cookie names the session, the peer-class memo
 *  makes the request the owner's laptop's (a loopback test request is otherwise "this machine"). */
function stubAuth(req, res, next) {
  const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
  if (m) { req.dashboardSession = m[1]; if (!req.headers["x-test-on-box"]) markFromLaptop(req); }
  if (req.headers["x-test-crosshost"]) req.crossHostAuth = true;
  return next();
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });

  ({ createDbClient } = await import("../servers/db.js"));
  T = await import("../servers/gateway/for-you/today.js");
  A = await import("../servers/sharing/profile-avatar.js");
  P = await import("../bundles/ramble/server/init-tables.js");

  // Ramble's tables, then the sessions: the owner's own password login, plus the three that are
  // never the owner's.
  const db = createDbClient();
  try {
    await P.initRambleTables(db);
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
    const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
    const tok = "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')";
    const when = { sql: tok, args: [hashToken(OWN), "dashboard"] };
    await db.execute(when);
    await db.execute({ sql: tok, args: [hashToken("plain-sess"), ""] });
    await db.execute({ sql: tok, args: [hashToken("sso-sess"), "dashboard sso src:instance-peer"] });
    await db.execute({ sql: tok, args: [hashToken("onhost-sess"), "dashboard onhost"] });
  } finally { try { db.close(); } catch { /* closed */ } }

  express = (await import("express")).default;
  const { widgetsRouter } = await import("../servers/gateway/routes/widgets.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use("/dashboard", stubAuth);
  app.use("/dashboard", csrfMiddleware);
  // The hand-off core is never reached by this API's bird route; an empty store keeps the router's
  // construction away from the real core.
  app.use(widgetsRouter(stubAuth, { core: { store: {} }, now: () => CLOCK.t }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  CLOCK.t = NOW;
  T._setTodaySeamsForTest({});
  clearBird();
});

// ---- scratch-store helpers ---------------------------------------------------

function clearBird() {
  const c = new Database(DB_FILE);
  try {
    c.exec("DELETE FROM ramble_eggs; DELETE FROM ramble_pet; DELETE FROM ramble_wallet;");
  } finally { c.close(); }
}

/** Plant the active hatched bird, optionally dressed, optionally walked today. */
function plantBird({ eggId = "b1", species = "crow", seed = 123456, outfit = null, walked = false, energy = 90 } = {}) {
  const c = new Database(DB_FILE);
  try {
    c.prepare("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, outfit_json, created_at, hatched_at) VALUES (?, 'hatched', 100, ?, ?, ?, 1, 2)")
      .run(eggId, species, seed, outfit ? JSON.stringify(outfit) : null);
    c.prepare("INSERT INTO ramble_pet (owner, active_egg_id, energy, last_fed_at) VALUES ('self', ?, ?, NULL) ON CONFLICT(owner) DO UPDATE SET active_egg_id = excluded.active_egg_id, energy = excluded.energy")
      .run(eggId, energy);
    if (walked) {
      c.prepare("INSERT OR IGNORE INTO ramble_wallet (kind, key, delta, created_at) VALUES ('walked', ?, 1, ?)")
        .run(A.portraitDay(NOW), NOW);
    }
  } finally { c.close(); }
}

/** The seam the bird's mood and steps come from (it stands in for the whole bundle read). */
function seamState(state) {
  T._setTodaySeamsForTest({ ramble: async () => state });
}

// ---- the API -----------------------------------------------------------------

const jar = (session) => `crow_session=${session}; crow_csrf=${CSRF}`;

async function getBird({ session = OWN, extra = {} } = {}) {
  const r = await fetch(base + "/dashboard/widgets-api/bird", {
    headers: { cookie: jar(session), ...extra },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {
    status: r.status,
    type: r.headers.get("content-type"),
    cache: r.headers.get("cache-control"),
    frame: r.headers.get("x-frame-options"),
    text,
    json,
  };
}

// ---- tests -------------------------------------------------------------------

test("bird: the owner's own session gets the drawing; every other session gets 404", async () => {
  plantBird();
  seamState({ mood: "happy", energy: 90, max: 100, steps: { today: 1234, goal: 5000 } });

  const own = await getBird();
  assert.equal(own.status, 200);
  assert.match(String(own.type), /application\/json/);
  assert.equal(own.cache, "no-store");
  assert.equal(own.frame, "DENY");

  // An SSO session, a session a login from this machine minted, a plain-scope session, a peer-signed
  // call, and this machine itself: none of them is the owner's turn.
  for (const session of ["sso-sess", "onhost-sess", "plain-sess"]) {
    const r = await getBird({ session });
    assert.equal(r.status, 404, session);
    assert.equal(r.json?.svg, undefined, `${session} is handed no drawing`);
  }
  for (const extra of [{ "x-test-on-box": "1" }, { "x-test-crosshost": "1" }]) {
    const r = await getBird({ extra });
    assert.equal(r.status, 404, JSON.stringify(extra));
    assert.equal(r.json?.svg, undefined);
  }

  // No session at all is refused before anything is read.
  const r = await fetch(base + "/dashboard/widgets-api/bird");
  assert.equal(r.status, 404);
});

test("bird: the JSON is { mood, steps, steps_goal, walked, svg } and the svg is the full drawing", async () => {
  plantBird({ walked: true });
  seamState({ mood: "tired", energy: 40, max: 100, steps: { today: 4321, goal: 8000 } });

  const r = await getBird();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["mood", "steps", "steps_goal", "svg", "walked"]);
  assert.equal(r.json.mood, "tired");
  assert.equal(r.json.steps, 4321);
  assert.equal(r.json.steps_goal, 8000);
  assert.equal(r.json.walked, true);

  assert.equal(typeof r.json.svg, "string");
  assert.ok(r.json.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'));
  assert.ok(r.json.svg.endsWith("</svg>"));
  assert.ok(r.json.svg.includes("<ellipse"), "the engine's body");
  assert.ok(r.json.svg.includes('class="rb-walk-badge"'), "today's walk badge");
  assert.ok(!r.json.svg.includes("data:image/"), "the raw drawing, never the profile picture's data URI");
  // The same string the profile avatar is made of — one drawing, two consumers.
  assert.equal(r.json.svg, A.renderBirdSvg({ species: "crow", seed: 123456, mood: "tired", walked: true }));
});

test("bird: a dressed bird's SVG carries the outfit; the same bird undressed does not", async () => {
  plantBird(); // no outfit
  seamState({ mood: "happy", energy: 90, max: 100, steps: { today: 10, goal: 5000 } });
  const plain = await getBird();
  assert.equal(plain.status, 200);
  // The beanie is an outfit-only part: a rolled genome can never draw this path on its own.
  assert.equal(plain.json.svg.includes("q26 -34 52 0 z"), false, "no beanie on an undressed bird");

  // The same bird, dressed: the outfit is applied by the engine's applyOutfit.
  clearBird();
  plantBird({ outfit: { hat: "beanie" } });
  const dressed = await getBird();
  assert.equal(dressed.status, 200);
  assert.ok(dressed.json.svg.includes("q26 -34 52 0 z"), "the beanie is drawn");
  assert.notEqual(dressed.json.svg, plain.json.svg);
});

test("bird: with no Ramble state the mood is the portrait's and the steps are 0, never missing", async () => {
  plantBird({ energy: 90 });
  T._setTodaySeamsForTest({ ramble: async () => null });

  const r = await getBird();
  assert.equal(r.status, 200);
  assert.equal(r.json.mood, "happy", "the portrait's own decayed mood");
  assert.equal(r.json.steps, 0);
  assert.equal(r.json.steps_goal, 0);
  assert.equal(r.json.walked, false);
  assert.ok(r.json.svg.length > 0);
});

test("bird: Ramble not installed is 404 { code: no_ramble }, and nothing is drawn", async () => {
  plantBird(); // a bird in the tables, but no Ramble install (installed.json is empty, no seam)
  const r = await getBird();
  assert.equal(r.status, 404);
  assert.equal(r.json?.code, "no_ramble");
  assert.equal(r.json?.svg, undefined);
});

test("bird: an installed Ramble with no bird is 404 { code: no_bird }", async () => {
  seamState({ mood: "happy", energy: 90, max: 100, steps: { today: 5, goal: 5000 } });
  const r = await getBird();
  assert.equal(r.status, 404);
  assert.equal(r.json?.code, "no_bird");
  assert.equal(r.json?.svg, undefined);
});