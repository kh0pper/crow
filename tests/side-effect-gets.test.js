/**
 * Review F5: the two side-effecting GETs must be a PAGE of this origin.
 *
 * `/dashboard/make/open/...` marks a tile seen and `/dashboard/sso/launch` mints
 * a signed SSO ticket. Both were already refused from another site
 * (isSameOriginRequest: Sec-Fetch-Site + Origin). That is not enough on its own:
 * untrusted markdown rendered IN the dashboard (a bot's reply, a shared page) can
 * embed either URL as `![x](/dashboard/make/open/…)` or a `<link>`, and the
 * browser then reports a same-origin, same-site request — so the server must also
 * require a top-level document navigation (Sec-Fetch-Mode: navigate,
 * Sec-Fetch-Dest: document), which an image/link/fetch load never claims.
 *
 * The real dashboard router is mounted over a scratch CROW_DATA_DIR, with the
 * network gate satisfied by the Serve peer fixture (as in make-panel.test.js).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "side-effect-gets-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-side-effect-gets");

const REPO = new URL("..", import.meta.url).pathname;
const NET = serveHeaders("operator@example.com");
const SESSION = "side-effect-get-sess";

/** What a top-level document navigation sends (a link click / typed URL). */
const NAVIGATE = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
/** What an <img src> embed of the same URL sends. */
const IMAGE = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };

let server, base, port;

/**
 * A raw request, deliberately NOT fetch(): Node's fetch writes Sec-Fetch-Mode
 * itself (`cors`), so it cannot stand in for an `<img>` load or a navigation.
 * node:http sends exactly the headers given.
 */
function get(path, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { ...NET, cookie: `crow_session=${SESSION}`, ...extra } },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare(
    "INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) " +
    "VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')",
  ).run(hashToken(SESSION));
  c.close();

  // /dashboard/make/open looks the ref up in `artifacts` (bundles/artifacts owns the
  // table), so the scratch DB needs it: an unknown ref is then the route's own 404.
  const { createDbClient } = await import("../servers/db.js");
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  const artDb = createDbClient();
  try { await initArtifactsTables(artDb); } finally { artDb.close(); }

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    next();
  });
  app.use(dashboardRouter((req, res, next) => next(), { renderLayout }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  port = server.address().port;
  base = "http://127.0.0.1:" + port;
});
after(() => { if (server) server.close(); rmSync(dir, { recursive: true, force: true }); });

// ---- /dashboard/make/open -------------------------------------------------

test("make/open: an <img> embed of the URL is refused (same-origin is not enough)", async () => {
  // The route answers 403 BEFORE it looks anything up, so nothing is marked seen.
  const r = await get("/dashboard/make/open/artifact/art_f5f5f5f", IMAGE);
  assert.equal(r.status, 403, r.body.slice(0, 200));
  assert.ok(!r.location, "an image load is never redirected to a viewer");
});

test("make/open: a link/script/iframe load is refused too", async () => {
  for (const dest of ["style", "script", "iframe", "empty"]) {
    const r = await get("/dashboard/make/open/artifact/art_f5f5f5f", { ...IMAGE, "sec-fetch-dest": dest, "sec-fetch-mode": "navigate" });
    assert.equal(r.status, 403, `${dest} must not fire the route`);
  }
});

test("make/open: a real navigation still works (403 is the only refusal)", async () => {
  // An unknown ref proves the guard let the request through: the route's own
  // 404 is what answers, not the guard's 403.
  const nav = await get("/dashboard/make/open/artifact/art_nope1234", NAVIGATE);
  assert.notEqual(nav.status, 403, nav.body.slice(0, 200));
  assert.equal(nav.status, 404);
  // A client that sends no Sec-Fetch headers at all (curl, a bookmark from an
  // older browser, a CLI) keeps working: absence is not a refusal.
  assert.equal((await get("/dashboard/make/open/artifact/art_nope1234")).status, 404);
});

test("make/open: another site's page is still refused (the origin rule stays)", async () => {
  const r = await get("/dashboard/make/open/artifact/art_nope1234", {
    ...NAVIGATE, "sec-fetch-site": "cross-site", origin: "https://evil.example",
  });
  assert.equal(r.status, 403);
});

// ---- /dashboard/sso/launch ------------------------------------------------

test("sso/launch: an <img> embed mints nothing", async () => {
  const r = await get("/dashboard/sso/launch?target=peer1", IMAGE);
  assert.equal(r.status, 403, r.body.slice(0, 200));
  assert.ok(!r.location, "no redirect: no ticket was minted");
});

test("sso/launch: a real navigation reaches the route", async () => {
  // No target: the route's own 400 proves the guard let the page through (with a
  // target and no SSO-eligible peer it would 302, never 403).
  const nav = await get("/dashboard/sso/launch", NAVIGATE);
  assert.equal(nav.status, 400);
  assert.match(nav.body, /Missing target/);
  assert.notEqual((await get("/dashboard/sso/launch?target=peer1", NAVIGATE)).status, 403);
});

test("sso/launch: another site's page is still refused", async () => {
  const r = await get("/dashboard/sso/launch?target=peer1", {
    ...NAVIGATE, "sec-fetch-site": "cross-site", origin: "https://evil.example",
  });
  assert.equal(r.status, 403);
});