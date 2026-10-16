/**
 * Bot Builder rows (queue item 20, option A; T4) — "Turn on a board".
 *
 * board_on gives a bot a kanban board: a bot with no project gets a new
 * "<Name>'s board" project linked (through the same tracker write the Edit
 * tab makes); a bot that already has one keeps it. Custom trackers are
 * refused. Linking a project MOVES the bot's world root (bot-world.mjs:
 * <workspace>/bots/<id>), so the old root's sessions/, outputs/, .pi/ and
 * .mcp.json are symlinked into the new root — only where the new path is
 * free; anything in the way refuses the whole action, and nothing is ever
 * overwritten or deleted. The proof that old chats survive is the resume
 * path itself: <new root>/sessions must list the waiting transcript.
 *
 * Also: the POST goes through the real CSRF rail (403 without the token).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, lstatSync, existsSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-board-on-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;

let db = null, handleBotBuilderPost = null, applyTrackerChoice = null, worldRootFor = null, translations = null, slugify = null;
let WR = null; // the whole world-root module

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost, applyTrackerChoice } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  WR = await import("../scripts/pi-bots/world-root.mjs");
  ({ worldRootFor } = WR);
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ slugify } = await import("../servers/shared/slugify.js"));
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function mkRes() {
  const res = { redirected: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
}
async function post(body, useDb = db) {
  const res = mkRes();
  await handleBotBuilderPost({ body: { action: "board_on", ...body }, headers: {} }, res, { db: useDb });
  return res.redirected;
}

// ---- pi-lab's read gate, ported (extensions/shared/bot-paths.ts realish +
// underRealRoots). Not imported: this pins the contract the carry-over must
// satisfy — the REALPATH of a target must sit under the realpath of a root.
function realish(p) {
  let head = resolve(p);
  const rest = [];
  for (;;) {
    try { return rest.length ? join(realpathSync(head), ...rest.reverse()) : realpathSync(head); }
    catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      rest.push(basename(head));
      head = parent;
    }
  }
}
function underRealRoots(target, roots) {
  const rt = realish(target);
  for (const r of roots) {
    if (typeof r !== "string" || !r) continue;
    const rr = realish(r);
    if (rt === rr || rt.startsWith(rr.endsWith("/") ? rr : rr + "/")) return true;
  }
  return false;
}
/** What the bridge hands pi for a no-cwd turn: cwd = world root, dirname(.mcp.json) = world root, the project workspace (+ engine extras). */
function botReadRoots(worldRoot, workspaceDir, extra = []) {
  return [worldRoot, worldRoot, workspaceDir, ...extra];
}
/** Every symlink under a tree (never following one). */
function linksUnder(root) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out.push(p);
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}
const projectsDir = () => join(dir, "projects");
async function addBot(id, name, def, projectId = null) {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [id, name, JSON.stringify(def), projectId] });
}
async function bot(id) {
  return (await db.execute({ sql: "SELECT bot_id, display_name, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0];
}
async function project(id) {
  return (await db.execute({ sql: "SELECT * FROM project_spaces WHERE id=?", args: [id] })).rows[0];
}
async function projectCount() {
  return Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM project_spaces", args: [] })).rows[0].n);
}
const BASE_DEF = () => ({ models: { default: "p/m" }, gateways: [{ type: "perch" }], system_prompt: "Be brief.", skills: ["a"] });

test("a bot with no project gets a new '<Name>'s board' project, linked, as a kanban board", async () => {
  await addBot("plain-bot", "Plain Bot", BASE_DEF());
  const to = await post({ bot_id: "plain-bot", return: "list" });
  assert.equal(to, "/dashboard/bot-builder?saved=1");
  const row = await bot("plain-bot");
  assert.notEqual(row.project_id, null, "the project_id column is set");
  const ps = await project(row.project_id);
  assert.equal(ps.name, "Plain Bot's board");
  assert.equal(ps.tasks_db_uri, null, "the instance-global tasks.db");
  const def = JSON.parse(row.definition);
  assert.equal(def.tracker_config.type, "kanban");
  assert.equal(def.tracker_config.project_id, undefined);
  // Nothing else in the definition changes. Like the Edit tab's board save
  // (save-handlers.js, section "board"), the project lives in the column only:
  // no JSON project_id key is added.
  assert.ok(!Object.prototype.hasOwnProperty.call(def, "project_id"), "no JSON project_id copy added");
  const { tracker_config, ...rest } = def;
  assert.deepEqual(rest, BASE_DEF());
  const audit = (await db.execute({ sql: "SELECT * FROM project_audit_log WHERE project_id=?", args: [row.project_id] })).rows;
  assert.ok(audit.some((a) => a.action === "project.create" && a.actor_type === "local" && String(a.target) === "bot:plain-bot"),
    "the project creation is in the project's audit log");
});

test("old chats are carried over: the resume path at the new root finds the waiting transcript", async () => {
  const def = BASE_DEF();
  await addBot("carry-bot", "Carry Bot", def);
  // The world root BEFORE a project: <CROW_HOME>/pi-bots/<id> (bot-world.mjs).
  const oldRoot = worldRootFor({ workspaceDir: null, def, crowHome: process.env.CROW_HOME, botId: "carry-bot" });
  assert.equal(oldRoot, join(process.env.CROW_HOME, "pi-bots", "carry-bot"));
  mkdirSync(join(oldRoot, "sessions"), { recursive: true });
  writeFileSync(join(oldRoot, "sessions", "2026-10-01T10-00-00-000Z_sess-abc123.jsonl"), '{"type":"session"}\n');
  writeFileSync(join(oldRoot, ".mcp.json"), '{"mcpServers":{}}');
  mkdirSync(join(oldRoot, "outputs", "s1"), { recursive: true });
  writeFileSync(join(oldRoot, "outputs", "s1", "report.md"), "done");
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, pi_session_id, pi_session_dir, gateway_type, gateway_thread_id, status) VALUES (?,?,?,?,?,?)",
    args: ["carry-bot", "sess-abc123", oldRoot + "/sessions", "perch", "t-1", "waiting-user"] });

  assert.equal(await post({ bot_id: "carry-bot" }), "/dashboard/bot-builder?saved=1");
  const row = await bot("carry-bot");
  const ps = await project(row.project_id);
  // The same resolution buildBotWorld runs for the next turn.
  const newRoot = worldRootFor({ workspaceDir: ps.workspace_dir, def: JSON.parse(row.definition), crowHome: process.env.CROW_HOME, botId: "carry-bot" });
  assert.equal(newRoot, ps.workspace_dir + "/bots/carry-bot");
  assert.notEqual(newRoot, oldRoot, "the root really moved");
  // Resume: bridge passes --session-dir <root>/sessions + --session <id>;
  // perch-interactive's preflight lists <root>/sessions for "*<id>*.jsonl".
  const session = (await db.execute({ sql: "SELECT pi_session_id FROM bot_sessions WHERE bot_id='carry-bot'", args: [] })).rows[0];
  const found = readdirSync(join(newRoot, "sessions")).filter((f) => f.endsWith(".jsonl") && f.includes(session.pi_session_id));
  assert.equal(found.length, 1, "the waiting chat's transcript is reachable from the new root");
  // A fresh project has no <workspace>/bots/<id> yet: the WHOLE root is one
  // link to the old root, so every path the bot uses realpaths to one place.
  assert.ok(lstatSync(newRoot).isSymbolicLink(), "the new root is linked, not copied or moved");
  assert.equal(readlinkSync(newRoot), oldRoot);
  assert.equal(readFileSync(join(newRoot, ".mcp.json"), "utf8"), '{"mcpServers":{}}');
  assert.equal(readFileSync(join(newRoot, "outputs", "s1", "report.md"), "utf8"), "done");
  assert.ok(existsSync(join(oldRoot, "sessions", "2026-10-01T10-00-00-000Z_sess-abc123.jsonl")), "the old files stay where they were");
  // pi-lab's read gate: a carried upload is readable through the bot's roots.
  assert.ok(underRealRoots(join(newRoot, "outputs", "s1", "report.md"), botReadRoots(newRoot, ps.workspace_dir)),
    "a carried upload passes the realpath read gate");
  const audit = (await db.execute({ sql: "SELECT payload FROM project_audit_log WHERE project_id=? AND action='project.create'", args: [row.project_id] })).rows[0];
  const payload = JSON.parse(audit.payload);
  assert.deepEqual(payload.carried.sort(), [".mcp.json", "outputs", "sessions"]);
  assert.equal(payload.carry, "root");
});

test("fallback: the new root already exists, so entries are linked one by one and the old root becomes a read root at spawn", async () => {
  const def = BASE_DEF();
  await addBot("fb-bot", "Fallback Bot", def);
  const oldRoot = join(process.env.CROW_HOME, "pi-bots", "fb-bot");
  mkdirSync(join(oldRoot, "outputs", "s2"), { recursive: true });
  writeFileSync(join(oldRoot, "outputs", "s2", "upload.pdf"), "pdf");
  mkdirSync(join(oldRoot, "sessions"), { recursive: true });
  const nextId = Number((await db.execute({ sql: "SELECT COALESCE(MAX(id),0) AS m FROM project_spaces", args: [] })).rows[0].m) + 1;
  const ws = `${dir}/projects/${slugify("Fallback Bot's board")}-${nextId}/workspace`;
  const pre = join(ws, "bots", "fb-bot");
  mkdirSync(pre, { recursive: true });
  writeFileSync(join(pre, "notes.txt"), "already here");

  assert.equal(await post({ bot_id: "fb-bot" }), "/dashboard/bot-builder?saved=1");
  const row = await bot("fb-bot");
  const ps = await project(row.project_id);
  const newRoot = worldRootFor({ workspaceDir: ps.workspace_dir, def: JSON.parse(row.definition), crowHome: process.env.CROW_HOME, botId: "fb-bot" });
  assert.equal(newRoot, pre);
  assert.ok(!lstatSync(newRoot).isSymbolicLink(), "an existing root is never replaced");
  assert.ok(lstatSync(join(newRoot, "outputs")).isSymbolicLink());
  const upload = join(newRoot, "outputs", "s2", "upload.pdf");
  assert.ok(!underRealRoots(upload, botReadRoots(newRoot, ps.workspace_dir)),
    "without the extra root the gate refuses it (the bug this pins)");
  const legacyRoot = worldRootFor({ workspaceDir: null, def: JSON.parse(row.definition), crowHome: process.env.CROW_HOME, botId: "fb-bot" });
  const extra = WR.carriedReadRoots({ worldRoot: newRoot, legacyRoot });
  assert.deepEqual(extra, [realpathSync(oldRoot)]);
  assert.ok(underRealRoots(upload, botReadRoots(newRoot, ps.workspace_dir, extra)), "the carried upload passes with the added read root");
  const payload = JSON.parse((await db.execute({ sql: "SELECT payload FROM project_audit_log WHERE project_id=? AND action='project.create'", args: [row.project_id] })).rows[0].payload);
  assert.equal(payload.carry, "entries");
  assert.deepEqual(payload.carried.sort(), ["outputs", "sessions"]);
});

test("carriedReadRoots trusts only the bot's own old root: a link the bot planted elsewhere adds nothing", () => {
  const root = mkdtempSync(join(dir, "wr-"));
  const legacy = mkdtempSync(join(dir, "legacy-"));
  const elsewhere = mkdtempSync(join(dir, "elsewhere-"));
  symlinkSync(elsewhere, join(root, ".pi"));
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: root, legacyRoot: legacy }), []);
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: root, legacyRoot: root }), [], "no move, no extra root");
  mkdirSync(join(legacy, "sessions"));
  symlinkSync(join(legacy, "sessions"), join(root, "sessions"));
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: root, legacyRoot: legacy }), [realpathSync(legacy)]);
});

test("carriedReadRoots: a planted link to the old root itself (or a subpath under another name) adds nothing", () => {
  const root = mkdtempSync(join(dir, "wr-"));
  const legacy = mkdtempSync(join(dir, "legacy-"));
  mkdirSync(join(legacy, "sessions"));
  symlinkSync(legacy, join(root, "outputs"));
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: root, legacyRoot: legacy }), [], "ln -s <old root> outputs is not a carried entry");
  symlinkSync(join(legacy, "sessions"), join(root, ".pi"));
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: root, legacyRoot: legacy }), [], "a link under the wrong name is not a carried entry");
});

test("no old world: nothing is carried, the audit says so, and the board still turns on", async () => {
  await addBot("fresh-bot", "Fresh Bot", BASE_DEF());
  assert.ok(!existsSync(join(process.env.CROW_HOME, "pi-bots", "fresh-bot")));
  assert.equal(await post({ bot_id: "fresh-bot" }), "/dashboard/bot-builder?saved=1");
  const row = await bot("fresh-bot");
  assert.notEqual(row.project_id, null);
  const payload = JSON.parse((await db.execute({ sql: "SELECT payload FROM project_audit_log WHERE project_id=? AND action='project.create'", args: [row.project_id] })).rows[0].payload);
  assert.deepEqual(payload.carried, []);
  assert.equal(payload.carry, "none");
  assert.equal(payload.carry_reason, "no_old_root");
});

// ---- rollback leaves nothing behind (I2) ------------------------------------
function seedOldWorld(botId) {
  const oldRoot = join(process.env.CROW_HOME, "pi-bots", botId);
  mkdirSync(join(oldRoot, "sessions"), { recursive: true });
  writeFileSync(join(oldRoot, "sessions", "a_sess-1.jsonl"), "{}\n");
  mkdirSync(join(oldRoot, "outputs"), { recursive: true });
  return oldRoot;
}
/** A db whose UPDATE of pi_bot_defs runs `onUpdate` first (a racing writer, or a throw). */
function dbWith(onUpdate) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return async (q) => {
          if (q && /^UPDATE pi_bot_defs/.test(q.sql)) await onUpdate(q);
          return target.execute(q);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

test("rollback on a lost compare-and-swap removes every link and the empty bots dirs it made", async () => {
  const def = BASE_DEF();
  await addBot("cas-bot", "Cas Bot", def);
  const oldRoot = seedOldWorld("cas-bot");
  const before = await projectCount();
  const racing = dbWith(async () => {
    await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='cas-bot'", args: [JSON.stringify({ ...def, system_prompt: "edited elsewhere" })] });
  });
  const to = await post({ bot_id: "cas-bot" }, racing);
  assert.match(to, /error=/);
  assert.ok(decodeURIComponent(to).includes(translations["botbuilder.staleForm"].en), "it got as far as the swap: " + to);
  assert.equal(await projectCount(), before, "the project row is gone");
  assert.equal((await bot("cas-bot")).project_id, null);
  assert.deepEqual(linksUnder(projectsDir()).filter((l) => l.includes("cas-bot")), [], "no link left behind");
  const ws = readdirSync(projectsDir()).filter((d) => d.startsWith(slugify("Cas Bot's board")));
  for (const d of ws) assert.ok(!existsSync(join(projectsDir(), d, "workspace", "bots")), "the bots dir it made is removed");
  assert.ok(existsSync(join(oldRoot, "sessions", "a_sess-1.jsonl")), "the old world is untouched");
});

test("rollback when the write throws midway: no links remain", async () => {
  await addBot("throw-bot", "Throw Bot", BASE_DEF());
  const oldRoot = seedOldWorld("throw-bot");
  const before = await projectCount();
  const broken = dbWith(async () => { throw new Error("disk full"); });
  const to = await post({ bot_id: "throw-bot" }, broken);
  assert.match(to, /error=/);
  assert.equal(await projectCount(), before);
  assert.deepEqual(linksUnder(projectsDir()).filter((l) => l.includes("throw-bot")), []);
  assert.ok(existsSync(join(oldRoot, "sessions", "a_sess-1.jsonl")));
});

test("applyCarryOver failing midway undoes the links it already made, then throws", () => {
  const oldRoot = mkdtempSync(join(dir, "mid-old-"));
  const newRoot = mkdtempSync(join(dir, "mid-new-"));
  for (const n of ["sessions", "outputs", ".pi"]) mkdirSync(join(oldRoot, n));
  const plan = WR.planCarryOver(oldRoot, newRoot);
  assert.equal(plan.mode, "entries");
  // Something lands in the way between plan and apply.
  mkdirSync(join(newRoot, plan.links[1].name));
  assert.throws(() => WR.applyCarryOver(plan, newRoot));
  assert.deepEqual(linksUnder(newRoot), [], "the first link was removed again");
  assert.ok(existsSync(join(newRoot, plan.links[1].name)), "the thing in the way is not touched");
});

test("undoCarryOver never follows a link or deletes a non-empty dir", () => {
  const oldRoot = mkdtempSync(join(dir, "undo-old-"));
  writeFileSync(join(oldRoot, "keep.txt"), "x");
  const parent = join(mkdtempSync(join(dir, "undo-ws-")), "bots");
  const newRoot = join(parent, "b");
  const plan = WR.planCarryOver(oldRoot, newRoot);
  assert.equal(plan.mode, "root");
  const { created } = WR.applyCarryOver(plan, newRoot);
  assert.ok(created.includes(newRoot) && created.includes(parent));
  WR.undoCarryOver(created);
  assert.ok(!existsSync(parent), "the bots dir it made is removed");
  assert.equal(readFileSync(join(oldRoot, "keep.txt"), "utf8"), "x", "the link target is untouched");
});

test("two concurrent Turn on a board clicks: exactly one wins, no stray links or projects", async () => {
  await addBot("twin-bot", "Twin Bot", BASE_DEF());
  seedOldWorld("twin-bot");
  const before = await projectCount();
  const results = await Promise.all([post({ bot_id: "twin-bot" }), post({ bot_id: "twin-bot" })]);
  const row = await bot("twin-bot");
  assert.notEqual(row.project_id, null);
  assert.equal(await projectCount(), before + 1, "exactly one project survives: " + JSON.stringify(results));
  const ps = await project(row.project_id);
  const links = linksUnder(projectsDir()).filter((l) => l.includes("twin-bot"));
  assert.deepEqual(links, [ps.workspace_dir + "/bots/twin-bot"], "only the winner's root link");
});

test("something already at the new path: refused with a clear message, nothing linked, nothing changed", async () => {
  const def = BASE_DEF();
  await addBot("busy-bot", "Busy Bot", def);
  const oldRoot = join(process.env.CROW_HOME, "pi-bots", "busy-bot");
  mkdirSync(join(oldRoot, "sessions"), { recursive: true });
  writeFileSync(join(oldRoot, "sessions", "x_sess-9.jsonl"), "{}\n");
  // Predict the new project's workspace and put a real folder where the link would go.
  // project_spaces.id is a plain INTEGER PRIMARY KEY: the next id is MAX+1.
  const nextId = Number((await db.execute({ sql: "SELECT COALESCE(MAX(id),0) AS m FROM project_spaces", args: [] })).rows[0].m) + 1;
  const ws = `${dir}/projects/${slugify("Busy Bot's board")}-${nextId}/workspace`;
  const blocker = join(ws, "bots", "busy-bot", "sessions");
  mkdirSync(blocker, { recursive: true });
  writeFileSync(join(blocker, "keep.txt"), "mine");
  const before = await projectCount();

  const to = await post({ bot_id: "busy-bot" });
  assert.match(to, /^\/dashboard\/bot-builder\?error=/);
  const msg = decodeURIComponent(to.split("error=")[1]);
  assert.ok(msg.includes(blocker), "the message names the path in the way: " + msg);
  const row = await bot("busy-bot");
  assert.equal(row.project_id, null, "the bot is not linked");
  assert.deepEqual(JSON.parse(row.definition), def, "the definition is unchanged");
  assert.equal(await projectCount(), before, "the half-made project is not left behind");
  assert.ok(!lstatSync(blocker).isSymbolicLink(), "the folder in the way is not replaced");
  assert.equal(readFileSync(join(blocker, "keep.txt"), "utf8"), "mine");
  assert.ok(existsSync(join(oldRoot, "sessions", "x_sess-9.jsonl")));
});

test("type none with a project already linked: switched to kanban, the same project kept, no new one", async () => {
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Existing" })).id;
  await addBot("none-bot", "None Bot", { ...BASE_DEF(), tracker_config: { type: "none" } }, pid);
  const before = await projectCount();
  assert.equal(await post({ bot_id: "none-bot", return: "board" }), "/dashboard/bot-board?bot=none-bot");
  const row = await bot("none-bot");
  assert.equal(Number(row.project_id), pid);
  assert.equal(JSON.parse(row.definition).tracker_config.type, "kanban");
  assert.equal(await projectCount(), before);
});

test("type none with no project: a new project, kanban", async () => {
  await addBot("none-noproj", "Quiet", { ...BASE_DEF(), tracker_config: { type: "none", project_id: 99 } });
  await post({ bot_id: "none-noproj" });
  const row = await bot("none-noproj");
  assert.notEqual(row.project_id, null);
  const tc = JSON.parse(row.definition).tracker_config;
  assert.equal(tc.type, "kanban");
  assert.equal(tc.project_id, undefined, "a stale tracker_config.project_id (it overrides the column) is dropped");
});

test("a half-set-up custom tracker (no slug) is refused too — the list sends it to Edit", async () => {
  const def = { ...BASE_DEF(), tracker_config: { type: "custom", context_fields: ["a"] } };
  await addBot("custom-noslug", "Half Custom", def);
  const to = await post({ bot_id: "custom-noslug" });
  assert.match(to, /tab=tracker&error=/);
  assert.deepEqual(JSON.parse((await bot("custom-noslug")).definition), def);
});

test("a custom tracker is refused and left as it is", async () => {
  const def = { ...BASE_DEF(), tracker_config: { type: "custom", tracker_slug: "leads" } };
  await addBot("custom-bot", "Custom Bot", def);
  const before = await projectCount();
  const to = await post({ bot_id: "custom-bot" });
  assert.match(to, /^\/dashboard\/bot-builder\?bot=custom-bot&tab=tracker&error=/);
  assert.ok(decodeURIComponent(to).includes(translations["botbuilder.boardOnCustom"].en));
  assert.deepEqual(JSON.parse((await bot("custom-bot")).definition), def);
  assert.equal(await projectCount(), before);
});

test("an already-on bot: nothing written, no new project", async () => {
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "On" })).id;
  await addBot("on-bot", "On Bot", { ...BASE_DEF(), tracker_config: { type: "task-list" } }, pid);
  const stored = (await bot("on-bot")).definition;
  const before = await projectCount();
  assert.equal(await post({ bot_id: "on-bot" }), "/dashboard/bot-builder?saved=1");
  assert.equal((await bot("on-bot")).definition, stored, "byte-identical");
  assert.equal(await projectCount(), before);
});

test("return is an enum, never a URL", async () => {
  await addBot("ret-bot", "Ret Bot", BASE_DEF());
  assert.equal(await post({ bot_id: "ret-bot", return: "https://x.example/" }), "/dashboard/bot-builder?saved=1");
});

test("an unknown bot redirects with error=unknown_bot", async () => {
  assert.equal(await post({ bot_id: "never-was" }), "/dashboard/bot-builder?error=unknown_bot");
});

test("applyTrackerChoice is what the Edit tab's tracker save writes", async () => {
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Tracker" })).id;
  const def = { ...BASE_DEF(), tracker_config: { type: "custom", tracker_slug: "old", context_fields: ["a"] } };
  await addBot("tab-bot", "Tab Bot", def);
  const res = mkRes();
  await handleBotBuilderPost({ body: { action: "save_tracker", bot_id: "tab-bot", tracker_type: "kanban", project_id: String(pid) }, headers: {} }, res, { db });
  assert.match(res.redirected, /saved=1/);
  const viaTab = JSON.parse((await bot("tab-bot")).definition);
  // The legacy tab save also normalises these containers (unchanged behaviour).
  const expected = applyTrackerChoice({ ...structuredClone(def), tools: {}, permission_policy: {}, triggers: {} }, { projectId: pid, type: "kanban" });
  assert.deepEqual(viaTab, expected);
  assert.equal(Number((await bot("tab-bot")).project_id), pid);
});

test("applyTrackerChoice: custom keeps its slug fields; kanban drops them; tracker_config.project_id never survives", () => {
  const c = applyTrackerChoice({ tracker_config: { project_id: 4 } }, { projectId: 2, type: "custom", slug: " leads ", contextFields: "a, b", queueFilterKey: "k", queueFilterValue: "v" });
  assert.deepEqual(c.tracker_config, { type: "custom", tracker_slug: "leads", context_fields: ["a", "b"], queue_filter: { k: "v" } });
  assert.equal(c.project_id, 2);
  const k = applyTrackerChoice({ tracker_config: { type: "custom", tracker_slug: "x", context_fields: ["a"], queue_filter: { k: "v" } } }, { projectId: null, type: "kanban" });
  assert.deepEqual(k.tracker_config, { type: "kanban" });
  assert.equal(k.project_id, null);
});

test("bot-world.mjs resolves its world root through worldRootFor (one resolution, two callers)", () => {
  const src = readFileSync(new URL("../scripts/pi-bots/bot-world.mjs", import.meta.url), "utf8");
  assert.match(src, /const sessionDir = worldRootFor\(/);
});

// ---- the CSRF rail --------------------------------------------------------
test("board_on through the dashboard's CSRF rail: 403 without the token, a redirect with it", async () => {
  const express = (await import("express")).default;
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { default: panel } = await import("../servers/gateway/dashboard/panels/bot-builder.js");
  await addBot("rail-bot", "Rail Bot", BASE_DEF());
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { res.redirectAfterPost = (u) => res.redirect(303, u); next(); });
  // The mount order dashboard/index.js uses: csrfMiddleware on /dashboard,
  // then the generic /dashboard/:panelId route.
  app.use("/dashboard", csrfMiddleware);
  app.all("/dashboard/bot-builder", async (req, res) => {
    const out = await panel.handler(req, res, { db, layout: (o) => o.content, lang: "en" });
    if (!res.headersSent) res.send(out);
  });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}/dashboard/bot-builder`;
  try {
    const cookie = "crow_session=s1; crow_csrf=tok-abc";
    const form = (extra) => new URLSearchParams({ action: "board_on", bot_id: "rail-bot", return: "list", ...extra }).toString();
    const denied = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({}) });
    assert.equal(denied.status, 403);
    assert.equal((await bot("rail-bot")).project_id, null, "nothing happened");
    const wrong = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({ _csrf: "nope" }) });
    assert.equal(wrong.status, 403);
    const ok = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({ _csrf: "tok-abc" }) });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/dashboard/bot-builder?saved=1");
    assert.notEqual((await bot("rail-bot")).project_id, null);
  } finally { srv.close(); }
  // And the real router keeps that order.
  const idx = readFileSync(new URL("../servers/gateway/dashboard/index.js", import.meta.url), "utf8");
  const csrfAt = idx.indexOf('router.use("/dashboard", csrfMiddleware)');
  const panelAt = idx.indexOf('router.all("/dashboard/:panelId"');
  assert.ok(csrfAt > 0 && panelAt > csrfAt, "csrfMiddleware is mounted before the panel route");
});
