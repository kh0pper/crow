/**
 * The project home's Bots section (R1.2 §14): Edit links, Add a bot, Move a bot
 * here with a confirm, and the move POST. The REAL dashboard router over a
 * scratch CROW_DATA_DIR/CROW_HOME; the move itself is covered by move-bot.test.js,
 * so here we check what the page shows, who sees it and what the POST does.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "project-home-bots-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-home-bots");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;

const P = {};
let server, base, MODE, i18n, data;
const perch = JSON.stringify({ models: { default: "p/m" }, gateways: [{ type: "perch" }], system_prompt: "Be brief." });

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, archived_at, workspace_dir) VALUES (?,?,?,?,?,?)");
  const mem = c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')");
  for (const [slug, name, status, arch, owner] of [
    ["garden", "Garden <b>", "active", null, true], ["kitchen", "Kitchen", "active", null, true],
    ["empty", "Empty", "active", null, true], ["visited", "Visited", "active", null, false],
    ["attic", "Attic", "archived", "2026-01-01 00:00:00", true],
  ]) {
    P[slug] = Number(proj.run(slug, name, "general", status, arch, join(dir, "projects", slug)).lastInsertRowid);
    if (owner) mem.run(P[slug]);
  }
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  const bot = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  bot.run("hank", "Hank <i>x</i>", perch, P.garden);
  bot.run("ivy", "Ivy", perch, P.garden);
  bot.run("crow.voice", "Crow", perch, P.garden);
  bot.run("cook", "Cook", perch, P.kitchen);
  bot.run("loose", "Loose", perch, null);
  bot.run("quiet", "Quiet", JSON.stringify({ models: { default: "p/m" }, gateways: [] }), P.garden); // not Perch-attachable
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  await (await import("../servers/gateway/dashboard/settings/registry.js")).writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  i18n = await import("../servers/gateway/dashboard/shared/i18n.js");
  data = await import("../servers/gateway/dashboard/panels/project-home/data.js");
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
const bots = (html) => (html.match(/<section class="ph-section ph-bots"[\s\S]*?<\/section>/) || [""])[0];
async function dbRow(id) {
  const c = new Database(DB_FILE, { readonly: true });
  try { return c.prepare("SELECT project_id FROM pi_bot_defs WHERE bot_id=?").get(id); } finally { c.close(); }
}

test("bots listed with Edit links, voice bot absent, names escaped", async () => {
  const r = await get("/dashboard/project/garden");
  assert.equal(r.status, 200);
  const s = bots(r.body);
  assert.match(s, />Bots<\/h3>/);
  const edits = [...s.matchAll(/href="(\/dashboard\/bot-builder\?bot=[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(edits, ["/dashboard/bot-builder?bot=hank", "/dashboard/bot-builder?bot=ivy", "/dashboard/bot-builder?bot=quiet"],
    "every non-voice bot on the project, Perch or not");
  assert.doesNotMatch(s, /crow\.voice|>Crow</);
  assert.match(s, /Hank &lt;i&gt;x&lt;\/i&gt;/);
  assert.doesNotMatch(r.body, /<i>x<\/i>/);
  assert.match(s, /class="ph-link ph-new-bot" href="\/dashboard\/bot-builder\?new=1&amp;project=\d+">New bot</);
  assert.match(s, /<summary[^>]*>Add a bot</);
});

test("an empty project says so, above the add controls", async () => {
  const s = bots((await get("/dashboard/project/empty")).body);
  assert.match(s, /No bots here yet\./);
  assert.ok(s.indexOf("No bots here yet.") < s.indexOf("Add a bot"));
});

test("visitor and archived: no add or move controls (visitor sees the list)", async () => {
  const v = await get("/dashboard/project/visited");
  assert.equal(v.status, 200);
  assert.match(bots(v.body), /No bots here yet\./);
  assert.doesNotMatch(bots(v.body), /Add a bot|Move a bot here|<form/);
  assert.equal((await get("/dashboard/project/attic")).status, 404);
  const vm = await get("/dashboard/project/visited?move=cook");
  assert.doesNotMatch(vm.body, /data-ph-confirm/, "?move is ignored for a viewer who may not change the project");
});

test("movable excludes voice and this project's bots, names where each is", async () => {
  const r = await get("/dashboard/project/garden");
  const s = bots(r.body);
  const opts = [...s.matchAll(/<option value="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(opts, [["cook", "Cook (from Kitchen)"], ["loose", "Loose (from No project)"]]);
  assert.match(s, /<form method="GET" action="\/dashboard\/project\/garden"[^>]*>[\s\S]*<select name="move"/);
  assert.match(s, /Move a bot here/);
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try {
    assert.deepEqual((await data.movableBots(db, P.garden, "es")).map((b) => b.fromName), ["Kitchen", "Sin proyecto"]);
    assert.deepEqual(await data.movableBots(db, P.empty, "en").then((m) => m.map((b) => b.id)), ["cook", "hank", "ivy", "loose", "quiet"]);
  } finally { db.close(); }
});

test("confirm names the bot, where it is, and the project; Cancel goes back", async () => {
  const r = await get("/dashboard/project/garden?move=cook");
  const s = bots(r.body);
  assert.match(s, /Move Cook from Kitchen to Garden &lt;b&gt;\?/);
  assert.match(s, /It will work from this project's board, and its working folder \(sessions, outputs, settings\) moves here\. Its past sessions and cards stay where they are\./);
  assert.match(s, /<form method="POST" action="\/dashboard\/project\/garden"/);
  assert.match(s, /name="_csrf" value="tok"/);
  assert.match(s, /name="action" value="move_bot"/);
  assert.match(s, /name="bot_id" value="cook"/);
  assert.match(s, /<button type="submit"[^>]*>Move</);
  assert.match(s, /<a class="ph-link" href="\/dashboard\/project\/garden">Cancel</);
  assert.doesNotMatch(s, /<select|Add a bot/, "the confirm replaces the add controls");
  const loose = bots((await get("/dashboard/project/garden?move=loose")).body);
  assert.match(loose, /Move Loose from No project to/);
  for (const bad of ["crow.voice", "ivy", "nobody", ""]) {
    const x = await get("/dashboard/project/garden?move=" + encodeURIComponent(bad));
    assert.equal(x.status, 200);
    assert.doesNotMatch(x.body, /data-ph-confirm/, `move=${bad} ignored`);
    assert.match(bots(x.body), /<select/);
  }
});

test("move POST re-checks canManage, CSRF, refuses voice and unknown bots; success moves", async () => {
  // A viewer who may not change the project: 403, nothing changes.
  const denied = await post("/dashboard/project/visited", { action: "move_bot", bot_id: "cook" });
  assert.equal(denied.status, 403);
  assert.equal((await dbRow("cook")).project_id, P.kitchen);
  // No CSRF: refused before the panel.
  const noCsrf = await post("/dashboard/project/garden", { action: "move_bot", bot_id: "cook" }, { csrf: "" });
  assert.equal(noCsrf.status, 403);
  assert.equal((await dbRow("cook")).project_id, P.kitchen);
  // Voice and unknown.
  const voice = await post("/dashboard/project/garden", { action: "move_bot", bot_id: "crow.voice" });
  assert.equal(voice.location, "/dashboard/project/garden?error=voice_bot");
  const unknown = await post("/dashboard/project/garden", { action: "move_bot", bot_id: "nobody" });
  assert.equal(unknown.location, "/dashboard/project/garden?error=unknown_bot");
  const same = await post("/dashboard/project/garden", { action: "move_bot", bot_id: "ivy" });
  assert.equal(same.location, "/dashboard/project/garden?error=same_project");
  // Success.
  const ok = await post("/dashboard/project/garden", { action: "move_bot", bot_id: "cook" });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, "/dashboard/project/garden?moved=cook");
  assert.equal((await dbRow("cook")).project_id, P.garden);
  const page = await get(ok.location);
  assert.match(page.body, /role="status" data-ph-moved>Cook is now in this project\./);
  assert.match(bots(page.body), /bot=cook/);
});

test("error banners: mapped messages, the conflict names its path, unknown codes are generic", async () => {
  const { escapeHtml } = await import("../servers/gateway/dashboard/shared/components.js");
  const en = (k) => escapeHtml(i18n.t(k, "en"));
  const cases = [
    ["voice_bot", en("projectHome.errVoice")], ["unknown_bot", en("projectHome.errUnknown")], ["same_project", en("projectHome.errSame")],
    ["no_project", en("projectHome.errNoProject")], ["stale", en("projectHome.errStale")],
    ["custom_tracker", en("botbuilder.boardOnCustom")], ["weird", en("projectHome.errOther")],
  ];
  for (const [code, text] of cases) {
    const r = await get("/dashboard/project/garden?error=" + code);
    assert.match(r.body, new RegExp(`role="alert" data-ph-error="${code}">`), code);
    assert.ok(r.body.includes(text), `${code}: ${text}`);
  }
  // The conflict path is rebuilt from this project's workspace for a bot that exists; a ?path is never shown.
  const c = await get("/dashboard/project/garden?error=conflict&bot=cook&path=" + encodeURIComponent("/x/<b>/bots/cook"));
  assert.ok(c.body.includes(`a folder for this bot already exists here (${join(dir, "projects", "garden", "bots", "cook")}). Nothing was changed. Ask for help before moving that folder, since it may hold older chats.`));
  assert.doesNotMatch(c.body, /move the folder out of the way/);
  assert.doesNotMatch(c.body, /\/x\/(<b>|&lt;b&gt;)/);
  for (const q of ["?error=conflict&bot=nobody", "?error=conflict&path=%2Fetc%2Fpasswd", "?error=conflict"]) {
    const x = await get("/dashboard/project/garden" + q);
    assert.ok(x.body.includes(en("projectHome.errOther")), `${q}: generic`);
    assert.doesNotMatch(x.body, /\/etc\/passwd|bots\/nobody/);
  }
});

test("en and es strings", () => {
  const T = (k, l) => i18n.t(k, l);
  assert.equal(T("projectHome.noBots", "es"), "Todavía no hay bots aquí.");
  assert.equal(T("projectHome.moveWhat", "en"), "It will work from this project's board, and its working folder (sessions, outputs, settings) moves here. Its past sessions and cards stay where they are.");
  assert.equal(T("projectHome.moveWhat", "es"), "Trabajará desde el tablero de este proyecto, y su carpeta de trabajo (sesiones, resultados, ajustes) se muda aquí. Sus sesiones y tarjetas anteriores siguen donde están.");
  assert.equal(T("projectHome.errConflict", "es"), "No se pudo mover: ya existe aquí una carpeta para este bot ({path}). No se cambió nada. Pide ayuda antes de mover esa carpeta, porque puede tener chats anteriores.");
  assert.equal(T("projectHome.noProject", "es"), "Sin proyecto");
  for (const k of ["bots", "edit", "editBot", "noBots", "addBot", "newBot", "moveHere", "moveOption", "moveContinue", "moveNone", "noProject", "moveConfirm", "moveWhat", "moveGo", "moved", "errConflict", "errVoice", "errUnknown", "errSame", "errNoProject", "errStale", "errOther", "forbidden"]) {
    assert.notEqual(T("projectHome." + k, "en"), "projectHome." + k, k);
    assert.ok(T("projectHome." + k, "es").length > 0, k);
  }
});

// ---- fix wave (final review) ----

function exec(sql, ...args) {
  const c = new Database(DB_FILE);
  try { return c.prepare(sql).run(...args); } finally { c.close(); }
}
const editIds = (html) => [...bots(html).matchAll(/href="\/dashboard\/bot-builder\?bot=([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
const optionIds = (html) => [...bots(html).matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);

test("a non-Perch bot is listed after the wizard create and after a move", async () => {
  exec("INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)", "fwprov", "http://127.0.0.1:9/v1", JSON.stringify([{ id: "m1" }]));
  const made = await post("/dashboard/bot-builder", {
    action: "wizard_create", nav: "create", tpl: "blank", display_name: "Plain Made", bot_id: "plain-made",
    model: "fwprov/m1", gw_type: "none", project: String(P.empty),
  });
  assert.equal(made.status, 303);
  assert.equal(made.location, "/dashboard/bot-builder?bot=plain-made&tab=review&created=plain-made");
  assert.equal((await dbRow("plain-made")).project_id, P.empty);
  assert.deepEqual(editIds((await get("/dashboard/project/empty")).body), ["plain-made"], "the wizard's no-channel bot is listed");

  exec("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,NULL)",
    "plain-moved", "Plain Moved", JSON.stringify({ models: { default: "p/m" }, gateways: [] }));
  const moved = await post("/dashboard/project/empty", { action: "move_bot", bot_id: "plain-moved" });
  assert.equal(moved.location, "/dashboard/project/empty?moved=plain-moved");
  const page = await get(moved.location);
  assert.deepEqual(editIds(page.body), ["plain-made", "plain-moved"], "the moved no-channel bot is listed");
  assert.match(page.body, /data-ph-moved>Plain Moved is now in this project\./);
  assert.ok(!optionIds(page.body).includes("plain-moved"), "and no longer offered by the picker");
});

test("the picker leaves out custom-tracker bots", async () => {
  exec("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,NULL)",
    "leads", "Leads", JSON.stringify({ models: { default: "p/m" }, gateways: [], tracker_config: { type: "custom", tracker_slug: "leads" } }));
  exec("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,NULL)",
    "leads-unset", "Leads unset", JSON.stringify({ models: { default: "p/m" }, gateways: [], tracker_config: { type: "custom" } }));
  const ids = optionIds((await get("/dashboard/project/garden")).body);
  assert.ok(ids.includes("loose"));
  assert.ok(!ids.includes("leads") && !ids.includes("leads-unset"), "custom trackers are not offered: " + ids);
  assert.doesNotMatch((await get("/dashboard/project/garden?move=leads")).body, /data-ph-confirm/);
});

test("the moved banner shows only for a bot on this project, and only when the viewer may change it", async () => {
  assert.match((await get("/dashboard/project/garden?moved=hank")).body, /data-ph-moved>/);
  assert.doesNotMatch((await get("/dashboard/project/garden?moved=loose")).body, /data-ph-moved/, "not on this project");
  assert.doesNotMatch((await get("/dashboard/project/garden?moved=nobody")).body, /data-ph-moved/);
  exec("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)", "guest-bot", "Guest", perch, P.visited);
  assert.doesNotMatch((await get("/dashboard/project/visited?moved=guest-bot")).body, /data-ph-moved/, "a visitor never sees it");
});

test("a real conflict from the helper: the POST names the bot and the page shows the folder in the way", async () => {
  // A legacy world with chats, and an unrelated bots/<id>/sessions already at the target.
  mkdirSync(join(HOME, "pi-bots", "boxed", "sessions"), { recursive: true });
  writeFileSync(join(HOME, "pi-bots", "boxed", "sessions", "w.jsonl"), "{}\n");
  mkdirSync(join(dir, "projects", "kitchen", "bots", "boxed", "sessions"), { recursive: true });
  exec("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,NULL)", "boxed", "Boxed", perch);
  const r = await post("/dashboard/project/kitchen", { action: "move_bot", bot_id: "boxed" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard/project/kitchen?error=conflict&bot=boxed", "no path in the URL");
  assert.equal((await dbRow("boxed")).project_id, null, "nothing changed");
  const page = await get(r.location);
  assert.match(page.body, /role="alert" data-ph-error="conflict">/);
  assert.ok(page.body.includes(`already exists here (${join(dir, "projects", "kitchen", "bots", "boxed")})`));
});

test("a move POST to an archived project's slug is a 404 and changes nothing", async () => {
  const r = await post("/dashboard/project/attic", { action: "move_bot", bot_id: "loose" });
  assert.equal(r.status, 404);
  assert.equal((await dbRow("loose")).project_id, null);
});
