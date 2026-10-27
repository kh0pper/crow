/**
 * Task 2.3: every dashboard page renders in the new shell or the classic one,
 * per device, and the shell's scope (the project chip) follows one rule.
 *
 * The REAL dashboard/index.js router is mounted (dashboardAuth, csrfMiddleware,
 * the panel dispatch) over a scratch CROW_DATA_DIR with seeded dashboard
 * session rows, so these are end-to-end through the same middleware order
 * production uses. Requests carry a Tailscale identity header so
 * isAllowedNetwork admits them from loopback.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "shell-routes-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-shell-routes-a");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, mode, MODE, SCOPE, OTHER_SCOPE;
const calls = [];

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, archived_at) VALUES (?,?,?,?,?)");
  proj.run("garden", "Garden", "general", "active", null);
  proj.run("kitchen", "Kitchen", "general", "active", null);
  proj.run("attic", "Attic", "general", "archived", "2026-01-01 00:00:00");
  proj.run("learner", "Learner", "learner_profile", "active", null);
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)");
  tok.run(hashToken("old-sess"), "2025-06-01 00:00:00");
  tok.run(hashToken("new-sess"), "2026-06-01 00:00:00");
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();

  mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  SCOPE = mode.cookieName(mode.SCOPE_COOKIE);
  const other = mkdtempSync(join(tmpdir(), "shell-routes-other-"));
  writeFileSync(join(other, "instance-id"), "instance-shell-routes-b");
  OTHER_SCOPE = mode.cookieName(mode.SCOPE_COOKIE, { CROW_DATA_DIR: other });
  rmSync(other, { recursive: true, force: true });

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const spy = (opts) => { calls.push(opts); return renderLayout(opts); };
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(dashboardRouter((req, res, next) => next(), { renderLayout: spy }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => { if (server) server.close(); rmSync(dir, { recursive: true, force: true }); });

const NET = { "tailscale-user-login": "operator@example.com" };
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function get(path, jar = {}) {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: cookieHeader(jar) } });
  return { status: r.status, location: r.headers.get("location"), cookies: r.headers.getSetCookie(), body: await r.text() };
}

async function post(path, form, { jar = {}, csrfHeader = true } = {}) {
  const headers = { ...NET, "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) };
  if (csrfHeader) headers["x-crow-csrf"] = jar.crow_csrf;
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers, body: new URLSearchParams(form).toString() });
  return { status: r.status, location: r.headers.get("location"), cookies: r.headers.getSetCookie() };
}

const cookieValue = (cookies, name) => {
  const c = cookies.find((s) => s.startsWith(name + "="));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(";")[0]) : undefined;
};
const chip = (html) => (html.match(/class="shell-scope-name">([^<]*)</) || [])[1];
const OLD = { crow_session: "old-sess", crow_csrf: "tok" };
const NEW = { crow_session: "new-sess", crow_csrf: "tok" };

test("a device with no cookie whose session predates shell_since gets classic and a cookie", async () => {
  const r = await get("/dashboard/memory", OLD);
  assert.equal(r.status, 200);
  assert.match(r.body, /class="sidebar/);
  assert.match(r.body, /name="crow-mode" content="classic"/);
  assert.equal(cookieValue(r.cookies, MODE), "classic");
  assert.match(MODE, /^crow_mode_[0-9a-f]{8}$/);
});

test("a new session gets the shell", async () => {
  const r = await get("/dashboard/memory", NEW);
  assert.equal(r.status, 200);
  assert.match(r.body, /class="shell-tabs"/);
  assert.match(r.body, /<body class="shell/);
  assert.doesNotMatch(r.body, /class="sidebar/);
  assert.equal(cookieValue(r.cookies, MODE), "new");
});

test("a device that already has a mode cookie gets no new one", async () => {
  const r = await get("/dashboard/memory", { ...OLD, [MODE]: "new" });
  assert.match(r.body, /<body class="shell/);
  assert.equal(cookieValue(r.cookies, MODE), undefined);
});

test("the mode route flips the device", async () => {
  const toNew = await post("/dashboard/mode", { mode: "new" }, { jar: OLD });
  assert.equal(toNew.status, 303);
  assert.equal(toNew.location, "/dashboard/perch");
  assert.equal(cookieValue(toNew.cookies, MODE), "new");

  const toClassic = await post("/dashboard/mode", { mode: "classic", _csrf: "tok" }, { jar: NEW, csrfHeader: false });
  assert.equal(toClassic.status, 303, "the client's _csrf body field is accepted too");
  assert.equal(toClassic.location, "/dashboard");
  assert.equal(cookieValue(toClassic.cookies, MODE), "classic");

  const bogus = await post("/dashboard/mode", { mode: "bogus" }, { jar: OLD });
  assert.equal(bogus.status, 400);
  assert.equal(cookieValue(bogus.cookies, MODE), undefined);

  const noCsrf = await post("/dashboard/mode", { mode: "new" }, { jar: OLD, csrfHeader: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(cookieValue(noCsrf.cookies, MODE), undefined);
});

test("the mode and scope routes sit behind dashboardAuth", async () => {
  for (const [path, form] of [["/dashboard/mode", { mode: "new" }], ["/dashboard/scope", { scope: "garden" }]]) {
    const anon = await post(path, form, { jar: {}, csrfHeader: false });
    assert.equal(anon.status, 303);
    assert.equal(anon.location, "/dashboard/login");
    assert.equal(anon.cookies.length, 0);
    const funnel = await fetch(base + path, {
      method: "POST", redirect: "manual",
      headers: { ...NET, "tailscale-funnel-request": "?1", "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(OLD), "x-crow-csrf": "tok" },
      body: new URLSearchParams(form).toString(),
    });
    assert.equal(funnel.status, 403, `${path} refuses Funnel traffic`);
    assert.equal(funnel.headers.getSetCookie().length, 0);
  }
});

test("the scope route sets the cookie and refuses an open redirect", async () => {
  const ok = await post("/dashboard/scope", { scope: "garden", return: "/dashboard/memory?x=1" }, { jar: NEW });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, "/dashboard/memory?x=1");
  assert.equal(cookieValue(ok.cookies, SCOPE), "garden");
  const raw = ok.cookies.find((s) => s.startsWith(SCOPE + "="));
  assert.match(raw, /; Path=\/; Max-Age=34560000; SameSite=Lax/);

  for (const ret of ["https://evil.example/", "//evil.example/dashboard/", "/\\evil.example", "/dashboardx", "/blog", "", "javascript:alert(1)"]) {
    const r = await post("/dashboard/scope", { scope: "all", return: ret }, { jar: NEW });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/dashboard/perch", `return=${JSON.stringify(ret)}`);
  }
  const noReturn = await post("/dashboard/scope", { scope: "unassigned" }, { jar: NEW });
  assert.equal(noReturn.location, "/dashboard/perch");
  assert.equal(cookieValue(noReturn.cookies, SCOPE), "unassigned");
});

test("the scope route drops a stale ?project= from the return path, so the new scope sticks", async () => {
  const r = await post("/dashboard/scope", { scope: "kitchen", return: "/dashboard/bot-board?project=garden&view=all" }, { jar: NEW });
  assert.equal(r.location, "/dashboard/bot-board?view=all");
  assert.equal(cookieValue(r.cookies, SCOPE), "kitchen");
});

test("an archived project or a learner profile scope falls back to Everything", async () => {
  for (const slug of ["attic", "learner", "no-such-project"]) {
    const set = await post("/dashboard/scope", { scope: slug, return: "/dashboard/perch" }, { jar: NEW });
    assert.equal(cookieValue(set.cookies, SCOPE), "all", `POST scope=${slug}`);
    const viaCookie = await get("/dashboard/memory", { ...NEW, [MODE]: "new", [SCOPE]: slug });
    assert.equal(chip(viaCookie.body), "Everything", `cookie ${slug}`);
    const viaQuery = await get(`/dashboard/memory?project=${slug}`, { ...NEW, [MODE]: "new" });
    assert.equal(chip(viaQuery.body), "Everything", `?project=${slug}`);
  }
  const page = await get("/dashboard/memory", { ...NEW, [MODE]: "new" });
  assert.match(page.body, /value="garden"/);
  assert.doesNotMatch(page.body, /value="attic"|value="learner"/, "the drawer lists only live projects");
});

test("a query param wins and updates the cookie", async () => {
  const jar = { ...NEW, [MODE]: "new", [SCOPE]: "garden" };
  const before = await get("/dashboard/memory", jar);
  assert.equal(chip(before.body), "Garden");
  assert.equal(cookieValue(before.cookies, SCOPE), undefined, "reading the cookie does not rewrite it");

  const r = await get("/dashboard/bot-board?project=kitchen", jar);
  assert.equal(r.status, 200);
  assert.equal(chip(r.body), "Kitchen");
  assert.equal(cookieValue(r.cookies, SCOPE), "kitchen");

  const next = await get("/dashboard/perch", { ...jar, [SCOPE]: cookieValue(r.cookies, SCOPE) });
  assert.equal(chip(next.body), "Kitchen");

  // A legacy numeric link (the bot board's old ?project=<id>) names the same live project.
  const kitchenId = new Database(join(dir, "crow.db")).prepare("SELECT id FROM project_spaces WHERE slug='kitchen'").get().id;
  const byId = await get(`/dashboard/memory?project=${kitchenId}`, jar);
  assert.equal(chip(byId.body), "Kitchen");
  assert.equal(cookieValue(byId.cookies, SCOPE), "kitchen", "the cookie still stores the slug");

  const un = await get("/dashboard/memory?project=unassigned", jar);
  assert.equal(chip(un.body), "Unassigned");
  assert.equal(cookieValue(un.cookies, SCOPE), "unassigned");
});

test("another instance's cookie is ignored", async () => {
  assert.notEqual(OTHER_SCOPE, SCOPE);
  const r = await get("/dashboard/memory", { ...NEW, [MODE]: "new", [OTHER_SCOPE]: "garden" });
  assert.equal(chip(r.body), "Everything");
  const onlyThere = await get("/dashboard/memory", { ...NEW, [MODE]: "new", [SCOPE]: "orchard" });
  assert.equal(chip(onlyThere.body), "Everything", "a slug that exists only on another instance");
});

test("the shell marks the tab, and hands the layout projects with slugs", async () => {
  calls.length = 0;
  await get("/dashboard/bot-board", { ...NEW, [MODE]: "new", [SCOPE]: "garden" });
  const opts = calls.at(-1);
  assert.equal(opts.variant, "shell");
  assert.equal(opts.shell.tab, "board");
  assert.deepEqual(opts.shell.projects.map((p) => p.slug), ["garden", "kitchen"]);
  assert.equal(opts.shell.scope.slug, "garden");

  calls.length = 0;
  const perch = await get("/dashboard/perch", { ...NEW, [MODE]: "new" });
  assert.equal(calls.at(-1).shell.tab, "chat");
  assert.match(perch.body, /href="\/dashboard\/perch" class="shell-tab" aria-current="page"/);

  calls.length = 0;
  await get("/dashboard/memory", { ...NEW, [MODE]: "new" });
  assert.equal(calls.at(-1).shell.tab, null);
});

test("classic mode calls renderLayout as before", async () => {
  calls.length = 0;
  const r = await get("/dashboard/memory?project=kitchen", { ...NEW, [MODE]: "classic" });
  assert.equal(r.status, 200);
  const opts = calls.at(-1);
  assert.equal(opts.variant, "classic");
  assert.equal("shell" in opts, false);
  assert.equal(cookieValue(r.cookies, SCOPE), undefined, "classic pages do not touch the scope cookie");
  assert.equal(cookieValue(r.cookies, MODE), undefined);
});

test("GET /dashboard in new mode opens Chat", async () => {
  const r = await get("/dashboard", { ...NEW, [MODE]: "new" });
  assert.equal(r.location, "/dashboard/perch");
  const fresh = await get("/dashboard", NEW);
  assert.equal(fresh.location, "/dashboard/perch");
  assert.equal(cookieValue(fresh.cookies, MODE), "new");
  const classic = await get("/dashboard", { ...OLD });
  assert.equal(cookieValue(classic.cookies, MODE), "classic");
});

test("a broken DB falls back to classic and writes no mode cookie", async () => {
  const { resolveRequestMode, resolveShellPage } = await import("../servers/gateway/dashboard/shell/request.js");
  const broken = { async execute() { throw new Error("database disk image is malformed"); } };
  const fakeRes = () => { const set = []; return { set, headersSent: false, append(k, v) { set.push([k, v]); } }; };

  const res1 = fakeRes();
  const d = await resolveRequestMode({ headers: {}, dashboardSession: "new-sess" }, res1, broken);
  assert.deepEqual(d, { mode: "classic", offerTry: false, persist: false });
  assert.equal(res1.set.length, 0);

  const req2 = { headers: {}, query: { project: "garden" }, dashboardSession: "new-sess" };
  const res2 = fakeRes();
  const page = await resolveShellPage(req2, res2, broken, "memory");
  assert.deepEqual(page, { variant: "classic" });
  assert.deepEqual(req2.crowScope, { all: true });
  assert.equal(res2.set.length, 0, "no mode or scope cookie");
});

test("saving the language keeps the mode cookie beside crow_lang", async () => {
  const r = await post("/dashboard/settings?section=language", { action: "set_language", language: "es" }, { jar: NEW });
  assert.equal(r.status, 303);
  assert.ok(r.cookies.some((c) => c.startsWith("crow_lang=es;")), "crow_lang is set");
  assert.equal(cookieValue(r.cookies, MODE), "new", "the first-visit mode cookie is not overwritten");
  await post("/dashboard/settings?section=language", { action: "set_language", language: "en" }, { jar: NEW });
});

// ─── Task 2.4: the one-time "Try the new Crow" card ───

test("an upgraded device sees the card once", async () => {
  const TRY = mode.cookieName(mode.TRY_COOKIE);
  const first = await get("/dashboard/memory", OLD);
  assert.match(first.body, /Try the new Crow/);
  assert.match(first.body, /action="\/dashboard\/mode"[^>]*>[\s\S]*?name="mode" value="new"/);
  assert.match(first.body, /action="\/dashboard\/mode\/try-dismiss"/);
  assert.equal(cookieValue(first.cookies, TRY), "pending");

  const again = await get("/dashboard/memory", { ...OLD, [MODE]: "classic", [TRY]: "pending" });
  assert.match(again.body, /Try the new Crow/, "stays until it is answered");

  const dismiss = await post("/dashboard/mode/try-dismiss", { return: "/dashboard/memory" }, { jar: { ...OLD, [MODE]: "classic", [TRY]: "pending" } });
  assert.equal(dismiss.status, 303);
  assert.equal(dismiss.location, "/dashboard/memory");
  assert.equal(cookieValue(dismiss.cookies, TRY), "dismissed");
  const raw = dismiss.cookies.find((s) => s.startsWith(TRY + "="));
  assert.match(raw, /Max-Age=34560000/);
  assert.match(raw, /SameSite=Lax/);
  const open = await post("/dashboard/mode/try-dismiss", { return: "https://evil.example/x" }, { jar: OLD });
  assert.equal(open.location, "/dashboard");

  const next = await get("/dashboard/memory", { ...OLD, [MODE]: "classic", [TRY]: "dismissed" });
  assert.doesNotMatch(next.body, /Try the new Crow/);
});

test("a device that tried new mode and went back sees no card", async () => {
  const TRY = mode.cookieName(mode.TRY_COOKIE);
  const r = await get("/dashboard/memory", { ...OLD, [MODE]: "classic", [TRY]: "used" });
  assert.doesNotMatch(r.body, /Try the new Crow/);
  const sw = await post("/dashboard/mode", { mode: "new" }, { jar: { ...OLD, [MODE]: "classic", [TRY]: "pending" } });
  assert.equal(cookieValue(sw.cookies, MODE), "new");
  assert.equal(cookieValue(sw.cookies, TRY), "used");
  const back = await post("/dashboard/mode", { mode: "classic" }, { jar: OLD });
  assert.equal(cookieValue(back.cookies, TRY), undefined);
});

test("a new device never sees the card in classic", async () => {
  const r = await get("/dashboard/memory", { ...NEW, [MODE]: "classic" });
  assert.doesNotMatch(r.body, /Try the new Crow/);
});

test("the dismiss route sits behind csrf", async () => {
  const r = await post("/dashboard/mode/try-dismiss", {}, { jar: OLD, csrfHeader: false });
  assert.equal(r.status, 403);
});

test("Settings offers the switch in classic", async () => {
  const r = await get("/dashboard/settings?section=crow-mode", { ...OLD, [MODE]: "classic" });
  assert.equal(r.status, 200);
  assert.match(r.body, /action="\/dashboard\/mode"[^>]*>[\s\S]*?name="mode" value="new"[\s\S]*?Use the new Crow/);
});

test("the CSRF fill script finds crow_csrf when it is not the first cookie", async () => {
  const pages = [
    (await get("/dashboard/settings?section=crow-mode", { ...OLD, [MODE]: "classic" })).body,
    (await get("/dashboard/memory", OLD)).body,
  ];
  for (const body of pages) {
    const raw = body.match(/onsubmit="([^"]*)"/)[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const re = raw.match(/document\.cookie\.match\(\/(.*?)\/\)/)[1];
    assert.ok(!re.includes("\\\\"), "no doubled backslash in the emitted regex");
    const m = "theme=dark; crow_csrf=abc123; other=1".match(new RegExp(re));
    assert.equal(m && m[1], "abc123");
  }
});
