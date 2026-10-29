/**
 * Archive, Restore and Delete controls (R1.2 §15, Task 3): the Manage project block on the
 * project home, the delete confirm, the Projects panel's archived rows and detail view, and the
 * POSTs. The REAL dashboard router over a scratch CROW_DATA_DIR/CROW_HOME. The lifecycle
 * functions themselves are covered by project-lifecycle*.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "project-lifecycle-ui-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-lifecycle-ui");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;

const P = {};
let server, base, MODE, i18n;
const perch = JSON.stringify({ models: { default: "p/m" }, gateways: [{ type: "perch" }], system_prompt: "Be brief." });

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, workspace_dir) VALUES (?,?,?,?,?)");
  const mem = c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')");
  for (const [slug, name, status, owner] of [
    ["alpha", "Alpha <b>", "active", true], ["beta", "Beta", "active", true], ["gamma", "Gamma", "archived", true],
    ["delta", "Delta", "active", true], ["sharey", "Sharey", "active", true], ["botty", "Botty", "active", true],
    ["hooky", "Hooky", "active", true], ["visited", "Visited", "active", false], ["vlost", "Vlost", "archived", false],
    ["epsilon", "Epsilon", "archived", true], ["zeta", "Zeta", "active", true],
  ]) {
    const ws = join(dir, "projects", slug, "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "readme.txt"), "hello");
    P[slug] = Number(proj.run(slug, name, "general", status, ws).lastInsertRowid);
    if (owner) mem.run(P[slug]);
  }
  const ct = c.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:alex', 'Alex', 'e', 's')").run();
  c.prepare("INSERT INTO project_members (project_id, contact_id, role, mode) VALUES (?, ?, 'editor', 'clone')").run(P.sharey, Number(ct.lastInsertRowid));
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('hank', 'Hank', ?, 1, ?)").run(perch, P.botty);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  await (await import("../servers/gateway/dashboard/settings/registry.js")).writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  MODE = (await import("../servers/gateway/dashboard/shell/mode.js")).cookieName((await import("../servers/gateway/dashboard/shell/mode.js")).MODE_COOKIE);
  i18n = await import("../servers/gateway/dashboard/shared/i18n.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => { server?.closeAllConnections?.(); server?.close(); rmSync(dir, { recursive: true, force: true }); });

const NET = serveHeaders("operator@example.com");
const jar = (extra = {}) => Object.entries({ crow_session: "new-sess", crow_csrf: "tok", [MODE]: "new", ...extra }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
async function get(path, extra) {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: jar(extra) } });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
async function post(path, fields, { csrf = "tok", cookie = jar() } = {}) {
  const body = new URLSearchParams({ ...fields, ...(csrf ? { _csrf: csrf } : {}) });
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { ...NET, cookie, "content-type": "application/x-www-form-urlencoded" }, body });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
function row(id) {
  const c = new Database(DB_FILE, { readonly: true });
  try { return c.prepare("SELECT status, archived_at, slug FROM project_spaces WHERE id=?").get(id); } finally { c.close(); }
}

test("owner sees Manage project, visitor does not", async () => {
  const o = await get("/dashboard/project/alpha");
  assert.equal(o.status, 200);
  assert.match(o.body, /<details class="pl-manage"[^>]*><summary>Manage project<\/summary>/);
  assert.match(o.body, /value="archive_project"/);
  assert.match(o.body, /href="\/dashboard\/project\/alpha\?delete=1"[^>]*>Delete project…</);
  const v = await get("/dashboard/project/visited");
  assert.equal(v.status, 200);
  assert.doesNotMatch(v.body, /Manage project|archive_project|delete=1/);
  assert.equal((await get("/dashboard/project/visited?delete=1")).status, 403);
});

test("archive POST hides it and lands on Archived", async () => {
  const r = await post("/dashboard/project/beta", { action: "archive_project" });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/dashboard/projects?status=archived&archived=${P.beta}`);
  assert.equal(row(P.beta).status, "archived");
  assert.equal(row(P.beta).archived_at, null, "archive never sets archived_at");
  assert.equal((await get("/dashboard/project/beta")).status, 404);
  const list = await get(r.location);
  assert.match(list.body, /data-pl-archived/);
  assert.match(list.body, /Project archived\./);
  assert.match(list.body, /Beta/);
});

test("restore POST, from the archived row, returns to the project home", async () => {
  const list = await get("/dashboard/projects?status=archived");
  assert.match(list.body, new RegExp(`data-pl-row="${P.gamma}"[\\s\\S]*?value="restore_project"[\\s\\S]*?>Restore<`));
  assert.match(list.body, new RegExp(`href="/dashboard/projects\\?delete=${P.gamma}"[^>]*>Delete<`));
  assert.doesNotMatch(list.body, new RegExp(`data-pl-row="${P.vlost}"`), "a visited archived project gets no actions");
  const r = await post("/dashboard/projects", { action: "restore_project", id: String(P.gamma) });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard/project/gamma");
  assert.equal(row(P.gamma).status, "active");
  assert.equal((await get("/dashboard/project/gamma")).status, 200);
});

test("the detail view has Archive or Restore and Delete for an owner", async () => {
  const a = await get(`/dashboard/projects?view=${P.alpha}`);
  assert.match(a.body, /data-pl-detail[\s\S]*value="archive_project"/);
  assert.match(a.body, new RegExp(`\\?delete=${P.alpha}`));
  const e = await get(`/dashboard/projects?view=${P.epsilon}`);
  assert.match(e.body, /value="restore_project"/);
  const v = await get(`/dashboard/projects?view=${P.visited}`);
  assert.doesNotMatch(v.body, /data-pl-detail/);
});

test("delete confirm shows counts, the warning and the notes", async () => {
  const r = await get("/dashboard/project/alpha?delete=1");
  assert.equal(r.status, 200);
  assert.match(r.body, /Delete “Alpha &lt;b&gt;” permanently\?/);
  assert.doesNotMatch(r.body, /Alpha <b>/);
  for (const k of ["cards", "files", "notes", "sources", "sessions", "connections", "backends"]) assert.match(r.body, new RegExp(`data-pl-count="${k}"`));
  assert.match(r.body, /This can't be undone\./);
  assert.match(r.body, new RegExp(`Its working folder moves to ${join(dir, "deleted-projects").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; you can remove it by hand\\.`));
  assert.doesNotMatch(r.body, /Copies you shared with others/, "never clone-shared");
  assert.match(r.body, /<label for="pl-confirm-name">Type the project's name to confirm<\/label>/);
  assert.match(r.body, />Delete permanently</);
  assert.match(r.body, />Cancel</);
  // On a phone the actions stack in source order: Cancel comes first, never the red button right under the field.
  assert.match(r.body, /data-pl-name>[\s\S]*?<div class="pl-actions pl-actions--confirm"><a class="pl-link pl-link--quiet"[^>]*>Cancel<\/a><button type="submit" class="pl-btn pl-btn--danger"/);
  assert.match(r.body, /name="_csrf" value="tok"/);
  const panel = await get(`/dashboard/projects?delete=${P.alpha}`);
  assert.match(panel.body, /data-pl-confirm/);
  assert.match(panel.body, /action="\/dashboard\/projects"/);
});

test("blocked confirm shows the reason and the way to fix it", async () => {
  const s = await get("/dashboard/project/sharey?delete=1");
  assert.match(s.body, /Stop sharing it first: Alex\./);
  assert.match(s.body, new RegExp(`href="/dashboard/projects\\?view=${P.sharey}&amp;tab=members"[^>]*data-pl-fix="sharing"`));
  assert.doesNotMatch(s.body, /data-pl-delete-go|confirm_name/);
  const b = await get("/dashboard/project/botty?delete=1");
  assert.match(b.body, /Move its bots to another project first: Hank\./);
  assert.match(b.body, /href="\/dashboard\/project\/botty#ph-bots-h"[^>]*data-pl-fix="bots"/);
  const r = await post("/dashboard/project/botty", { action: "delete_project", confirm_name: "Botty" });
  assert.match(r.location, /\?delete=1&error=bots$/);
  assert.ok(row(P.botty), "nothing was deleted");
  assert.equal(row(P.botty).slug, "botty");
});

test("confirm name must match", async () => {
  const r = await post("/dashboard/project/zeta", { action: "delete_project", confirm_name: "zeta" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard/project/zeta?delete=1&error=name_mismatch");
  assert.equal(row(P.zeta).slug, "zeta");
  const page = await get(r.location);
  assert.match(page.body, /The name didn't match, so nothing was deleted\./);
  const panel = await post("/dashboard/projects", { action: "delete_project", id: String(P.zeta), confirm_name: "" });
  assert.equal(panel.location, `/dashboard/projects?delete=${P.zeta}&error=name_mismatch`);
  assert.equal(row(P.zeta).slug, "zeta");
});

test("delete POST: tombstones, shows where the workspace went and the remove-later line", async () => {
  const r = await post("/dashboard/project/alpha", { action: "delete_project", confirm_name: "Alpha <b>" });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/dashboard\/projects\?deleted=1&ws=[A-Za-z0-9-]+$/);
  assert.match(row(P.alpha).slug, /^alpha-deleted-/);
  assert.ok(row(P.alpha).archived_at);
  assert.equal(existsSync(join(dir, "projects", "alpha", "workspace")), false);
  const moved = readdirSync(join(dir, "deleted-projects"));
  assert.equal(moved.length, 1);
  const page = await get(r.location);
  assert.match(page.body, /Project deleted\./);
  assert.ok(page.body.includes(`Its working folder is now at ${join(dir, "deleted-projects", moved[0])}.`));
  assert.match(page.body, /You can remove that folder later\./);
  // The deleted project's home is gone, under its old slug and its tombstone slug alike.
  assert.equal((await get("/dashboard/project/alpha")).status, 404);
  assert.equal((await get(`/dashboard/project/${encodeURIComponent(row(P.alpha).slug)}`)).status, 404);
  // es
  const es = i18n.t("projLife.removeLater", "es");
  assert.equal(es, "Puedes borrar esa carpeta más adelante.");
});

test("a forged ws or partial in the URL cannot show an arbitrary path or raw codes", async () => {
  const f = await get("/dashboard/projects?deleted=1&ws=" + encodeURIComponent("../../etc") + "&partial=cards,board_defs,bogus");
  const banner = (f.body.match(/<p class="pl-banner"[\s\S]*?<\/p>/) || [""])[0];
  assert.match(banner, /Project deleted\./);
  assert.doesNotMatch(banner, /etc|\.\./, "no path from a forged ws");
  assert.match(f.body, /These steps didn't finish: its cards, its board\./);
  assert.doesNotMatch(f.body, /board_defs|bogus/);
  const bare = await get("/dashboard/projects?deleted=1");
  assert.doesNotMatch(bare.body, /data-pl-deleted|Project deleted\./, "a bare ?deleted=1 shows nothing");
  const junk = await get("/dashboard/projects?deleted=1&ws=" + encodeURIComponent("../x") + "&partial=bogus");
  assert.doesNotMatch(junk.body, /data-pl-deleted/);
  const left = await get("/dashboard/projects?deleted=1&ws=left&partial=workspace,files");
  assert.match(left.body, /Its working folder was not moved\./);
  assert.match(left.body, /These steps didn't finish: its files\./);
});

test("delete POST re-checks owner", async () => {
  const v = await post("/dashboard/project/visited", { action: "delete_project", confirm_name: "Visited" });
  assert.equal(v.status, 403);
  assert.equal(row(P.visited).slug, "visited");
  const p = await post("/dashboard/projects", { action: "delete_project", id: String(P.vlost), confirm_name: "Vlost" });
  assert.equal(p.status, 403);
  assert.equal(row(P.vlost).slug, "vlost");
  const a = await post("/dashboard/projects", { action: "archive_project", id: String(P.visited) });
  assert.equal(a.status, 403);
  assert.equal(row(P.visited).status, "active");
  const rs = await post("/dashboard/projects", { action: "restore_project", id: String(P.vlost) });
  assert.equal(rs.status, 403);
  assert.equal(row(P.vlost).status, "archived");
  assert.equal((await post("/dashboard/projects", { action: "delete_project", id: "9999", confirm_name: "x" })).status, 403);
});

test("CSRF required", async () => {
  for (const path of ["/dashboard/project/hooky", "/dashboard/projects"]) {
    for (const action of ["archive_project", "delete_project"]) {
      const none = await post(path, { action, id: String(P.hooky), confirm_name: "Hooky" }, { csrf: "" });
      assert.equal(none.status, 403);
      const bad = await post(path, { action, id: String(P.hooky), confirm_name: "Hooky" }, { csrf: "wrong" });
      assert.equal(bad.status, 403);
    }
  }
  assert.equal(row(P.hooky).status, "active");
  assert.equal(row(P.hooky).slug, "hooky");
});

test("a POST body carrying the lifecycle's test hooks has no effect", async () => {
  const r = await post("/dashboard/project/hooky", {
    action: "delete_project", confirm_name: "Hooky", id: String(P.hooky),
    _beforeTransaction: "boom", _beforeTombstone: "boom", actor: "contact", dataDir: "/tmp/elsewhere", storageDelete: "x",
  });
  assert.equal(r.status, 303, "no TypeError from a string hook");
  assert.match(r.location, /^\/dashboard\/projects\?deleted=1&ws=/);
  assert.match(row(P.hooky).slug, /^hooky-deleted-/);
  assert.equal(existsSync("/tmp/elsewhere/deleted-projects"), false, "a body dataDir is ignored");
});

test("en and es strings exist for every projLife key", () => {
  const keys = Object.keys(i18n.translations || {}).filter((k) => k.startsWith("projLife."));
  if (!keys.length) {
    for (const k of ["manage", "archive", "restore", "deleteLink", "warn", "blockedShared", "blockedBots", "nameMismatch", "cloneNote", "workspaceNote", "removeLater"]) {
      assert.notEqual(i18n.t("projLife." + k, "en"), "projLife." + k);
      assert.notEqual(i18n.t("projLife." + k, "es"), i18n.t("projLife." + k, "en"));
    }
    return;
  }
  for (const k of keys) { assert.ok(i18n.translations[k].en && i18n.translations[k].es, k); }
});

test("the Spanish page renders the controls in Spanish", async () => {
  const sp = await get("/dashboard/project/delta", { crow_lang: "es" });
  assert.match(sp.body, /Gestionar proyecto|Manage project/);
  const ui = await import("../servers/gateway/dashboard/shared/project-lifecycle-ui.js");
  const es = ui.resultBannerHtml({ deleted: "1", ws: "abc123-20261029", partial: "files" }, "es");
  assert.match(es, /Proyecto eliminado\. Su carpeta de trabajo ahora está en .*deleted-projects.abc123-20261029\. Puedes borrar esa carpeta más adelante\. Estos pasos no terminaron: sus archivos\./);
  assert.equal(i18n.t("projLife.manage", "es"), "Gestionar proyecto");
  assert.equal(i18n.t("projLife.blockedShared", "es"), "Primero deja de compartirlo: {who}.");
  assert.equal(i18n.t("projLife.blockedBots", "es"), "Primero mueve sus bots a otro proyecto: {bots}.");
});

test("a refusal after the disconnects says so on the confirm page", async () => {
  const r = await get("/dashboard/project/sharey?delete=1&error=shared&disconnected=2");
  assert.match(r.body, /data-pl-disconnected[^>]*>Its service connections were disconnected; reconnect them on the Services page\.</);
  assert.doesNotMatch((await get("/dashboard/project/sharey?delete=1&error=shared&disconnected=x")).body, /data-pl-disconnected/);
  assert.equal(i18n.t("projLife.disconnected", "es"), "Sus conexiones de servicios se desconectaron; vuelve a conectarlas en la página de Servicios.");
});

test("an archived project is deleted from /dashboard/projects?delete=", async () => {
  assert.equal(row(P.epsilon).status, "archived");
  const c = await get(`/dashboard/projects?delete=${P.epsilon}`);
  assert.equal(c.status, 200);
  assert.match(c.body, /data-pl-confirm/);
  assert.match(c.body, /data-pl-delete-go/);
  const r = await post("/dashboard/projects", { action: "delete_project", id: String(P.epsilon), confirm_name: "Epsilon" });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/dashboard\/projects\?deleted=1&ws=[A-Za-z0-9-]+$/);
  assert.ok(row(P.epsilon).archived_at);
  assert.match(row(P.epsilon).slug, /^epsilon-deleted-/);
  assert.equal(existsSync(join(dir, "projects", "epsilon", "workspace")), false);
  // The tombstone is gone from the archived list and its confirm.
  assert.doesNotMatch((await get("/dashboard/projects?status=archived")).body, new RegExp(`data-pl-row="${P.epsilon}"`));
  assert.match((await get(`/dashboard/projects?delete=${P.epsilon}`)).body, /not found/);
});
