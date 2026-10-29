/**
 * Project services Task 10: a project's Services page, /dashboard/project/<slug>/services.
 *
 * The REAL dashboard router (dashboardAuth, csrfMiddleware, the panel dispatch, the shell) over a
 * scratch CROW_DATA_DIR and a scratch CROW_HOME (keychain key, installed.json): never ~/.crow.
 * Connections are made through the store (createConnection) with a scratch key. Requests carry
 * Serve's headers so isAllowedNetwork admits them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "project-services-page-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_SERVICES_UI;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-services");
writeFileSync(join(HOME, "installed.json"), JSON.stringify(["github", "trello"]));
const REPO = new URL("..", import.meta.url).pathname;

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const TOKEN = "test-token-1";
const P = {};
let server, base, MODE, ghUuid;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, archived_at) VALUES (?,?,?,?,?)");
  P.spring = Number(proj.run("spring", "Spring", "general", "active", null).lastInsertRowid);
  P.kitchen = Number(proj.run("kitchen", "Kitchen", "general", "active", null).lastInsertRowid);
  P.home = Number(proj.run("home", "Home", "general", "active", null).lastInsertRowid);
  P.attic = Number(proj.run("attic", "Attic", "general", "archived", "2026-01-01 00:00:00").lastInsertRowid);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  P.contact = Number(c.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:second-user", "second user", "ed-test", "npub1test").lastInsertRowid);
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
  const S = await import("../servers/shared/service-connections.js");
  const key = createKeychainKey({ crowHome: HOME });
  const db = createDbClient();
  try {
    await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
    const gh = await S.createConnection(db, { projectId: P.spring, serviceId: "github", accountLabel: "work", secrets: { [GH]: TOKEN }, testedAt: new Date() }, { key });
    ghUuid = gh.uuid;
    await S.createConnection(db, { projectId: P.kitchen, serviceId: "trello", accountLabel: "main", secrets: { TRELLO_API_KEY: "test-token-2", TRELLO_TOKEN: "test-token-3" }, testedAt: new Date() }, { key });
  } finally { db.close(); }

  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  delete process.env.CROW_SERVICES_UI;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const NET = serveHeaders("operator@example.com");
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
async function get(path, jar = { crow_session: "new-sess", crow_csrf: "tok", [MODE]: "new" }) {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: cookieHeader(jar) } });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
async function withFlag(fn) {
  process.env.CROW_SERVICES_UI = "1";
  try { return await fn(); } finally { delete process.env.CROW_SERVICES_UI; }
}
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const rowsOf = (html) => [...html.matchAll(/<li class="svc-row"[\s\S]*?<\/li>/g)].map((m) => m[0]);
const OWNER_ONLY = "Bots use these only when you start the conversation. Messages from other people never reach your accounts.";
const MEMBERS = "Each person connects their own accounts, on their own Crow. Their bots never use yours.";

test("flag off: the page is a 404, and so is the panel's own route", async () => {
  assert.equal(process.env.CROW_SERVICES_UI, undefined);
  const r = await get("/dashboard/project/spring/services");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /data-svc/);
  const own = await get("/dashboard/project-services");
  assert.equal(own.status, 404);
  assert.doesNotMatch(own.body, /data-svc/);
});

test("a GitHub connection shows its service, account name, On and when it was tested, with Test again and Disconnect", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/project/spring/services");
    assert.equal(r.status, 200);
    assert.match(r.body, /<body class="shell/);
    assert.equal((r.body.match(/class="shell-scope-name">([^<]*)</) || [])[1], "Spring", "the scope is the path's project");
    assert.match(r.body, /<button type="button" class="svc-add" data-svc-add>\+ Add<\/button>/);
    assert.match(r.body, /<h3 class="svc-label">Connected in this project<\/h3>/);
    const rows = rowsOf(r.body);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.match(row, new RegExp(`data-uuid="${ghUuid}" data-service="github"`));
    assert.match(row, /<span class="svc-name">GitHub<\/span>/);
    assert.match(row, /<span class="svc-sub">work · Tested today<\/span>/);
    assert.match(row, /<span class="svc-pill svc-pill--active">On<\/span>/);
    assert.match(row, /data-svc-retest>Test again</);
    assert.match(row, /data-svc-disconnect data-confirm="Disconnect GitHub \(work\) from Spring\? This project's bots stop using it\. Other projects keep theirs\.">Disconnect</);
    assert.match(row, /<summary aria-label="GitHub \(work\)">/);
    // The drawer marks Spring as the scope, not as this page (that is the project home's link).
    assert.match(r.body, /<a href="\/dashboard\/project\/spring" class="shell-project is-current" aria-current="true">/);
    assert.match(r.body, /data-shell-tab="chat" aria-current="page"/, "Chat's tab is lit, as on the project home");
    // No copy claims bots use a connection yet (botsLive is false).
    assert.doesNotMatch(r.body, /Your bots can use it/);
  });
});

test("the owner-only line always shows; the members line only while the project has a member", async () => {
  await withFlag(async () => {
    const { createDbClient } = await import("../servers/db.js");
    const db = createDbClient();
    try {
      for (const slug of ["spring", "home"]) {
        const r = await get(`/dashboard/project/${slug}/services`);
        assert.ok(textOf(r.body).includes(OWNER_ONLY), `owner-only line on ${slug}`);
        assert.ok(!textOf(r.body).includes(MEMBERS), `no members line on ${slug}`);
      }
      await db.execute({ sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, ?, 'editor')", args: [P.spring, P.contact] });
      const on = textOf((await get("/dashboard/project/spring/services")).body);
      assert.ok(on.includes(MEMBERS) && on.includes(OWNER_ONLY));
      assert.ok(!textOf((await get("/dashboard/project/home/services")).body).includes(MEMBERS), "another project's member doesn't count");
      await db.execute({ sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE project_id = ?", args: [P.spring] });
      assert.ok(!textOf((await get("/dashboard/project/spring/services")).body).includes(MEMBERS), "a revoked member doesn't count");
    } finally {
      await db.execute({ sql: "DELETE FROM project_members", args: [] });
      db.close();
    }
  });
});

test("Also on your Crow lists Trello from another project, with Add one here; the empty state on a bare project", async () => {
  await withFlag(async () => {
    const spring = await get("/dashboard/project/spring/services");
    assert.match(spring.body, /<h3 class="svc-label">Also on your Crow<\/h3>/);
    assert.ok(textOf(spring.body).includes("Trello is connected in another project."));
    assert.match(spring.body, /class="svc-inline" data-svc-add>Add one here</);

    const home = await get("/dashboard/project/home/services");
    assert.equal(home.status, 200);
    assert.equal(rowsOf(home.body).length, 0);
    assert.match(home.body, /<p class="svc-empty">Nothing is connected in this project yet\.<\/p>/);
    assert.ok(textOf(home.body).includes("GitHub and Trello are connected in other projects."), "joined in the page's language");

    const kitchen = await get("/dashboard/project/kitchen/services");
    assert.ok(textOf(kitchen.body).includes("GitHub is connected in another project."));
    assert.ok(!/Trello (is|are) connected/.test(textOf(kitchen.body)), "a service connected here is not 'also'");
  });
});

test("an unknown or archived slug is a 404; classic mode goes to Projects", async () => {
  await withFlag(async () => {
    for (const slug of ["nope", "attic"]) {
      const r = await get(`/dashboard/project/${slug}/services`);
      assert.equal(r.status, 404, slug);
      assert.doesNotMatch(r.body, /data-svc[ >]/);
    }
    const own = await get("/dashboard/project-services");
    assert.equal(own.status, 404, "no slug, no page");
    const classic = await get("/dashboard/project/spring/services", { crow_session: "new-sess", crow_csrf: "tok", [MODE]: "classic" });
    assert.equal(classic.status, 302);
    assert.equal(classic.location, "/dashboard/projects");
  });
});

test("no secret value reaches the page: no stored value, and no value= on any input", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/project/spring/services");
    assert.equal(r.status, 200);
    for (const v of [TOKEN, "test-token-2", "test-token-3"]) assert.ok(!r.body.includes(v), `${v} is not in the page`);
    for (const input of r.body.match(/<input\b[^>]*type="password"[^>]*>/g) || []) assert.doesNotMatch(input, /\svalue=/, input);
    const svc = r.body.slice(r.body.indexOf("<div class=\"svc\""));
    assert.doesNotMatch(svc.slice(0, svc.indexOf("<script")), /<input\b[^>]*\svalue=/, "the Services markup has no input carrying a value");
  });
});

test("Spanish: the page's copy follows the language", async () => {
  await withFlag(async () => {
    const { createDbClient } = await import("../servers/db.js");
    const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
    const db = createDbClient();
    try {
      await writeSetting(db, "language", "es");
      const r = await get("/dashboard/project/home/services");
      const text = textOf(r.body);
      assert.ok(text.includes("Aún no hay nada conectado en este proyecto."));
      assert.ok(text.includes("GitHub y Trello están conectados en otros proyectos."));
      assert.ok(text.includes("Los bots los usan solo cuando tú inicias la conversación."));
      assert.match(r.body, /data-svc-add>\+ Añadir</);
      const s = await get("/dashboard/project/spring/services");
      assert.match(s.body, /<span class="svc-sub">work · Probado hoy<\/span>/);
      assert.match(s.body, /svc-pill--active">Activo</);
    } finally {
      await writeSetting(db, "language", "en");
      db.close();
    }
  });
});

test("phone first: no fixed width above 360 px; every control at least 44 px; the client has no backtick", async () => {
  const { projectServicesCss } = await import("../servers/gateway/dashboard/panels/project-services/css.js");
  const { projectServicesClientJs } = await import("../servers/gateway/dashboard/panels/project-services/client.js");
  const css = projectServicesCss();
  for (const m of css.matchAll(/(?<![-\w])width:\s*([\d.]+)(px|rem|em)/g)) {
    const px = Number(m[1]) * (m[2] === "px" ? 1 : 16);
    assert.ok(px <= 360, `fixed width ${m[0]}`);
  }
  for (const m of css.matchAll(/min-width:\s*([\d.]+)(px|rem|em)/g)) {
    const px = Number(m[1]) * (m[2] === "px" ? 1 : 16);
    assert.ok(px <= 360, `min-width ${m[0]}`);
  }
  for (const sel of [".svc-project", ".svc-add", ".svc-menu > summary", ".svc-menu-item", ".svc-inline"]) {
    const rule = css.slice(css.indexOf(`body.shell ${sel} {`));
    assert.match(rule.slice(0, rule.indexOf("}")), /min-height:\s*44px/, `${sel} is a 44 px target`);
  }
  const pill = css.slice(css.indexOf("body.shell .svc-pill {"));
  assert.doesNotMatch(pill.slice(0, pill.indexOf("}")), /nowrap/, "a long status wraps instead of squeezing the name");
  const js = projectServicesClientJs();
  assert.ok(!js.includes("`"), "no backtick");
  assert.match(js, /'X-Crow-Csrf': csrf\(\)/);
  assert.match(js, /\/dashboard\/services\/api\/connection\//);
  // The panel's own files never carry a hard-coded colour.
  for (const f of ["project-services/css.js", "project-services/html.js"]) {
    const src = readFileSync(join(REPO, "servers/gateway/dashboard/panels", f), "utf8");
    assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, `${f} uses tokens, not hex colours`);
  }
});

test("the confirm text fills its placeholders in one pass: a label holding {project} stays as typed", async () => {
  const { projectServicesHtml } = await import("../servers/gateway/dashboard/panels/project-services/html.js");
  const html = projectServicesHtml({
    project: { slug: "spring", name: "Spring" },
    connections: [{ uuid: "00000000-0000-4000-8000-000000000009", serviceId: "github", name: "GitHub", accountLabel: "{project}", status: "active", lastTestedAt: null }],
    hasMembers: false, alsoOnCrow: [],
  }, "en");
  assert.match(html, /data-confirm="Disconnect GitHub \(\{project\}\) from Spring\?/);
});
