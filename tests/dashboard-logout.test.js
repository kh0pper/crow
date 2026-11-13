/**
 * Logout is a POST with a CSRF token; a GET only confirms.
 *
 * It used to be `router.get("/dashboard/logout")` in the public section that
 * destroyed the session and redirected. The dashboard renders untrusted HTML in
 * the owner's browser, so that GET was a same-origin, cookie-carrying URL
 * anything could fire: a bot's markdown reply containing
 * `![x](/dashboard/logout)` signed the owner out just by being read.
 *
 * This file mounts the REAL dashboard router over a scratch CROW_DATA_DIR with
 * a real session row (same harness as make-previews.test.js / project-home.test.js)
 * and checks both halves: the routes, and the sidebar markup that carries the
 * form.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "dashboard-logout-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-dashboard-logout");

const REPO = new URL("..", import.meta.url).pathname;
const NET = serveHeaders("operator@example.com");

// One session per test: the POST tests spend their own, the others must survive.
const SESS = {
  confirm: "logout-confirm-sess",
  missing: "logout-csrf-missing",
  wrong: "logout-csrf-wrong",
  post: "logout-post-sess",
  header: "logout-header-sess",
  sidebar: "logout-sidebar-sess",
};
const CSRF = "logout-csrf-token";

let server, base, verifySession, hashToken, MODE, renderLayout, layoutModule;

/** The per-instance cookie name ("crow_mode_<instance id hash>"). */
async function modeCookieName() {
  const { MODE_COOKIE, cookieName } = await import("../servers/gateway/dashboard/shell/mode.js");
  return cookieName(MODE_COOKIE);
}

function seedSession(token) {
  const c = new Database(join(dir, "crow.db"));
  try {
    c.prepare(
      "INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) " +
      "VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')"
    ).run(hashToken(token));
  } finally {
    c.close();
  }
}

async function req(method, path, { session = SESS.confirm, csrf = CSRF, mode = null, body = null } = {}) {
  const jar = [];
  if (session) jar.push(`crow_session=${session}`);
  if (csrf) jar.push(`crow_csrf=${csrf}`);
  if (mode) jar.push(`${MODE}=${mode}`);
  const headers = { ...NET };
  if (jar.length) headers.cookie = jar.join("; ");
  if (body !== null) headers["content-type"] = "application/x-www-form-urlencoded";
  const r = await fetch(base + path, { method, redirect: "manual", headers, body });
  const text = await r.text();
  const setCookie = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
  return { status: r.status, location: r.headers.get("location"), setCookie, text };
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  ({ hashToken, verifySession } = await import("../servers/gateway/dashboard/auth.js"));
  for (const token of Object.values(SESS)) seedSession(token);

  MODE = await modeCookieName();
  layoutModule = await import("../servers/gateway/dashboard/shared/layout.js");
  ({ renderLayout } = layoutModule);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  // The gateway adds this in servers/gateway/index.js; dashboardAuth answers a
  // request with no valid session through it.
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    next();
  });
  app.use(dashboardRouter((req, res, next) => next(), { renderLayout }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  if (server) server.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- the GET only confirms -------------------------------------------------

test("GET /dashboard/logout shows a confirm page and changes NOTHING", async () => {
  assert.equal(await verifySession(SESS.confirm), true, "session valid before");
  const r = await req("GET", "/dashboard/logout", { session: SESS.confirm });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.text, /<form method="POST" action="\/dashboard\/logout"/, "the confirm page carries the POST form");
  assert.match(r.text, /<input type="hidden" name="_csrf" value="logout-csrf-token">/, "with the viewer's CSRF token");
  assert.match(r.text, /<button type="submit">/, "and a submit button");
  assert.ok(!r.setCookie.some((c) => /crow_session=;/.test(c)), "the GET does not clear the session cookie");
  assert.equal(await verifySession(SESS.confirm), true, "the session is STILL valid after the GET");
  assert.equal(r.location, null, "no redirect: this is the page itself");
});

test("the confirm page's Cancel link goes home and does not log out", async () => {
  const r = await req("GET", "/dashboard/logout", { session: SESS.confirm });
  assert.match(r.text, /<a href="\/dashboard">/, r.text.slice(0, 400));
  assert.equal(await verifySession(SESS.confirm), true);
});

// ---- the POST --------------------------------------------------------------

test("POST without a CSRF token is refused, and the session survives", async () => {
  const r = await req("POST", "/dashboard/logout", { session: SESS.missing });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.location, null);
  assert.equal(await verifySession(SESS.missing), true, "a refused logout changes nothing");
});

test("POST with the WRONG CSRF token is refused, and the session survives", async () => {
  const r = await req("POST", "/dashboard/logout", { session: SESS.wrong, body: "_csrf=not-the-token" });
  assert.equal(r.status, 403, r.text);
  assert.equal(await verifySession(SESS.wrong), true);
});

test("POST with the right CSRF token destroys the session and redirects to the login page", async () => {
  assert.equal(await verifySession(SESS.post), true, "session valid before");
  const r = await req("POST", "/dashboard/logout", { session: SESS.post, body: `_csrf=${CSRF}` });
  assert.equal(r.status, 302, r.text);
  assert.equal(r.location, "/dashboard/login");
  assert.ok(r.setCookie.some((c) => /^crow_session=;/.test(c)), "the session cookie is cleared: " + r.setCookie.join(" | "));
  assert.ok(r.setCookie.some((c) => /^crow_csrf=;/.test(c)), "and so is the CSRF cookie");
  assert.equal(await verifySession(SESS.post), false, "the session row is gone");
});

test("the Turbo header form of the same token works too", async () => {
  const token = SESS.header;
  assert.equal(await verifySession(token), true);
  const headers = { ...NET, cookie: `crow_session=${token}; crow_csrf=${CSRF}`, "x-crow-csrf": CSRF };
  const r = await fetch(base + "/dashboard/logout", { method: "POST", redirect: "manual", headers });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/dashboard/login");
  assert.equal(await verifySession(token), false);
});

// ---- no session: dashboardAuth decides -------------------------------------

test("without a valid session both methods go to the login page", async () => {
  const get = await req("GET", "/dashboard/logout", { session: null, csrf: null });
  assert.equal(get.status, 303, "dashboardAuth redirects");
  assert.equal(get.location, "/dashboard/login");

  const post = await req("POST", "/dashboard/logout", { session: null, csrf: null, body: `_csrf=${CSRF}` });
  assert.equal(post.status, 303, "auth answers before CSRF is ever consulted");
  assert.equal(post.location, "/dashboard/login");

  const stale = await req("GET", "/dashboard/logout", { session: SESS.post }); // destroyed above
  assert.equal(stale.status, 303);
  assert.equal(stale.location, "/dashboard/login");
});

// ---- the sidebar -----------------------------------------------------------

test("the sidebar's logout is a POST form carrying the viewer's token, never a state-changing link", async () => {
  const r = await req("GET", "/dashboard/memory", { session: SESS.sidebar, mode: "classic" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /<div class="sidebar-footer">/, "the classic sidebar rendered");
  assert.match(
    r.text,
    /<form method="post" action="\/dashboard\/logout" data-turbo="false"[^>]*><input type="hidden" name="_csrf" value="logout-csrf-token"><button type="submit" class="nav-item logout"/,
    "the nav item posts to /dashboard/logout with the CSRF field"
  );
  assert.doesNotMatch(r.text, /<a href="\/dashboard\/logout"/, "no link that logs out on a GET");
});

test("a page rendered without a token falls back to the GET confirm link (which changes nothing)", async () => {
  const page = renderLayout({
    title: "T",
    content: "<p>x</p>",
    activePanel: "memory",
    panels: [],
    lang: "en",
  });
  assert.match(page, /<a href="\/dashboard\/logout" class="nav-item logout" data-turbo="false">Logout<\/a>/);
  assert.doesNotMatch(page, /<form method="post" action="\/dashboard\/logout"/);

  // …and the URL that link points at is the confirm page checked above: a GET
  // renders it and the session is still valid afterwards.
  assert.equal(await verifySession(SESS.confirm), true);
});

test("renderLayout passes the token through when it is given one", () => {
  const page = renderLayout({
    title: "T",
    content: "<p>x</p>",
    activePanel: "memory",
    panels: [],
    lang: "en",
    csrf: "tok-123",
  });
  assert.match(page, /name="_csrf" value="tok-123"/);
  assert.doesNotMatch(page, /<a href="\/dashboard\/logout"/);
  // Escaped, so a token can never break out of the attribute.
  const odd = renderLayout({ title: "T", content: "", activePanel: "x", panels: [], lang: "en", csrf: '"><script>x</script>' });
  assert.doesNotMatch(odd, /<script>x<\/script>/);
});

// ---- the confirm page's own markup ----------------------------------------

test("the confirm page is the login page's shell: title, CSRF field, one button, a Cancel link", () => {
  // Rendered through renderLayout's sibling (same file, same dashboardCss).
  const { renderLogoutConfirm } = layoutModule;
  const en = renderLogoutConfirm({ lang: "en", csrfToken: "tok-123" });
  assert.match(en, /<form method="POST" action="\/dashboard\/logout">/);
  assert.match(en, /<input type="hidden" name="_csrf" value="tok-123">/);
  assert.match(en, /<button type="submit">Log out<\/button>/);
  assert.match(en, /<a href="\/dashboard">Cancel<\/a>/);
  assert.match(en, /Log out of the Crow's Nest on this device\?/);
  const es = renderLogoutConfirm({ lang: "es", csrfToken: "t" });
  assert.match(es, /¿Cerrar la sesión del Crow's Nest en este dispositivo\?/, "i18n, not a hardcoded English string");
  assert.match(es, /<a href="\/dashboard">Cancelar<\/a>/);
  assert.doesNotMatch(renderLogoutConfirm({}), /value="undefined"/, "no token renders an empty field, not something odd");
});