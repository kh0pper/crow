/**
 * "Move a bot here" (R1.2 §14): moveBotToProject, the board_on path
 * generalised from no project to any project. The carry-over source is the
 * bot's REAL world (lane C's ruling): A -> B -> C never chains links, and
 * moving back to where the world really lives carries nothing. Real symlinks
 * in a scratch CROW_HOME; the proof a move keeps old chats is
 * realpath(<new root>/sessions) landing on the real sessions dir.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, lstatSync, existsSync, readlinkSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic for buildBotWorld (as tests/bot-world.test.js): no ambient PI_*
// vars, and a scratch HOME carrying a minimal canonical mcp.json.
for (const k of Object.keys(process.env)) {
  if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "move-bot-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
const crowHome = process.env.CROW_HOME;

let db = null, moveBotToProject = null, WR = null, bus = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ moveBotToProject } = await import("../servers/gateway/dashboard/panels/bot-builder/move-bot.js"));
  WR = await import("../scripts/pi-bots/world-root.mjs");
  bus = (await import("../servers/shared/event-bus.js")).default;
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const BASE_DEF = () => ({ models: { default: "p/m" }, gateways: [{ type: "perch" }], system_prompt: "Be brief." });
let seq = 0;
async function addProject(slug, { archived = false } = {}) {
  const ws = join(dir, "projects", slug);
  const r = await db.execute({
    sql: "INSERT INTO project_spaces (slug, name, workspace_dir, archived_at) VALUES (?,?,?,?)",
    args: [slug, slug, ws, archived ? new Date().toISOString() : null],
  });
  const id = Number(r.lastInsertRowid);
  await db.execute({ sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')", args: [id] });
  return { id, ws };
}
async function addBot(id, def = BASE_DEF(), projectId = null) {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [id, id, JSON.stringify(def), projectId] });
}
async function bot(id) {
  return (await db.execute({ sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0];
}
const legacyRoot = (id) => join(crowHome, "pi-bots", id);
const rootIn = (ws, id) => join(ws, "bots", id);
/** A world with a waiting transcript, at `root`. */
function seedWorld(root) {
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "sessions", "waiting.jsonl"), "{}\n");
  mkdirSync(join(root, "outputs"), { recursive: true });
}
const fresh = async (n = 3) => {
  seq++;
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(await addProject(`p${seq}-${i}`));
  return ps;
};
async function auditRows(pid, botId) {
  return (await db.execute({ sql: "SELECT * FROM project_audit_log WHERE project_id=? AND action='bot.move' AND target=?", args: [pid, `bot:${botId}`] })).rows;
}

test("move: null → project carries the legacy world as one root link", async () => {
  const [A] = await fresh(1);
  await addBot("mv-null");
  seedWorld(legacyRoot("mv-null"));
  let emitted = null;
  const on = (e) => { emitted = e; };
  bus.on("pibots:defs-changed", on);
  const r = await moveBotToProject(db, "mv-null", A.id, { crowHome });
  bus.off("pibots:defs-changed", on);
  assert.deepEqual(r, { ok: true, carry: { mode: "root", reason: null, carried: ["sessions", "outputs"] } });
  const nr = rootIn(A.ws, "mv-null");
  assert.ok(lstatSync(nr).isSymbolicLink(), "the whole new root is one link");
  assert.equal(readlinkSync(nr), legacyRoot("mv-null"));
  assert.equal(realpathSync(join(nr, "sessions")), realpathSync(join(legacyRoot("mv-null"), "sessions")));
  assert.deepEqual(readdirSync(join(nr, "sessions")), ["waiting.jsonl"], "the waiting transcript is on the resume path");
  const row = await bot("mv-null");
  assert.equal(Number(row.project_id), A.id);
  const def = JSON.parse(row.definition);
  assert.equal(def.tracker_config.type, "kanban");
  assert.ok(!Object.prototype.hasOwnProperty.call(def, "project_id"), "no JSON copy added (the column is authoritative)");
  assert.deepEqual(emitted, { bot_id: "mv-null" });
  // carriedReadRoots sees nothing extra in root mode (the root itself resolves to the world).
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: nr, legacyRoot: legacyRoot("mv-null") }), []);
});

test("move: A → B links B's root to A's real world", async () => {
  const [A, B] = await fresh(2);
  // A bot born in A (the wizard's case): its world really lives at A/bots/<id>.
  await addBot("mv-ab", BASE_DEF(), A.id);
  seedWorld(rootIn(A.ws, "mv-ab"));
  const r = await moveBotToProject(db, "mv-ab", B.id, { crowHome });
  assert.equal(r.ok, true);
  assert.equal(r.carry.mode, "root");
  const nr = rootIn(B.ws, "mv-ab");
  assert.equal(readlinkSync(nr), realpathSync(rootIn(A.ws, "mv-ab")));
  assert.equal(realpathSync(join(nr, "sessions")), realpathSync(join(rootIn(A.ws, "mv-ab"), "sessions")));
  assert.equal(Number((await bot("mv-ab")).project_id), B.id);
  // A JSON project_id copy that already existed is kept in step with the column.
  const [, , C] = await fresh(3);
  await addBot("mv-ab-json", { ...BASE_DEF(), project_id: A.id }, A.id);
  seedWorld(rootIn(A.ws, "mv-ab-json"));
  assert.equal((await moveBotToProject(db, "mv-ab-json", C.id, { crowHome })).ok, true);
  assert.equal(JSON.parse((await bot("mv-ab-json")).definition).project_id, C.id);
});

test("move: A → B → C links C to A's real world, no chain", async () => {
  // Legacy-born: null → A → B → C. Every root links straight to the legacy world.
  const [A, B, C] = await fresh(3);
  await addBot("mv-chain");
  seedWorld(legacyRoot("mv-chain"));
  for (const p of [A, B, C]) assert.equal((await moveBotToProject(db, "mv-chain", p.id, { crowHome })).ok, true);
  for (const p of [B, C]) {
    const nr = rootIn(p.ws, "mv-chain");
    assert.equal(readlinkSync(nr), legacyRoot("mv-chain"), "linked to the real world, not to the previous project's link");
    assert.equal(realpathSync(join(nr, "sessions")), realpathSync(join(legacyRoot("mv-chain"), "sessions")));
  }
  // Project-born: A → B → C, C links to A's real dir, never to B's link.
  const [A2, B2, C2] = await fresh(3);
  await addBot("mv-chain2", BASE_DEF(), A2.id);
  seedWorld(rootIn(A2.ws, "mv-chain2"));
  for (const p of [B2, C2]) assert.equal((await moveBotToProject(db, "mv-chain2", p.id, { crowHome })).ok, true);
  assert.equal(readlinkSync(rootIn(C2.ws, "mv-chain2")), realpathSync(rootIn(A2.ws, "mv-chain2")));
  assert.equal(Number((await bot("mv-chain2")).project_id), C2.id);
});

test("move back to the real world carries nothing", async () => {
  const [A, B] = await fresh(2);
  await addBot("mv-back", BASE_DEF(), A.id);
  seedWorld(rootIn(A.ws, "mv-back"));
  assert.equal((await moveBotToProject(db, "mv-back", B.id, { crowHome })).ok, true);
  const r = await moveBotToProject(db, "mv-back", A.id, { crowHome });
  assert.deepEqual(r, { ok: true, carry: { mode: "none", reason: "same_world", carried: [] } });
  const ar = rootIn(A.ws, "mv-back");
  assert.ok(lstatSync(ar).isDirectory() && !lstatSync(ar).isSymbolicLink(), "A's root is still the real world");
  assert.deepEqual(readdirSync(join(ar, "sessions")), ["waiting.jsonl"]);
  assert.equal(Number((await bot("mv-back")).project_id), A.id);
  // The plain planner would have called every entry a conflict here.
  assert.equal(WR.planCarryOver(rootIn(B.ws, "mv-back"), ar).conflicts.length, 2);
});

test("conflict refuses with the path and changes nothing", async () => {
  // A legacy-born bot whose target already holds an unrelated sessions dir.
  const [A, B] = await fresh(2);
  await addBot("mv-conf");
  seedWorld(legacyRoot("mv-conf"));
  const nr = rootIn(A.ws, "mv-conf");
  mkdirSync(join(nr, "sessions"), { recursive: true });
  const before = await bot("mv-conf");
  const r = await moveBotToProject(db, "mv-conf", A.id, { crowHome });
  assert.deepEqual(r, { ok: false, code: "conflict", path: join(nr, "sessions") });
  assert.deepEqual(await bot("mv-conf"), before, "the row is unchanged");
  assert.ok(!existsSync(join(nr, "outputs")), "no entry was linked");
  assert.equal((await auditRows(A.id, "mv-conf")).length, 0);

  // A project-born bot: any existing target root is in the way (the legacy
  // root is the only extra read root a spawn can get, so per-entry links into
  // a project world would be denied by the read gate).
  await addBot("mv-conf2", BASE_DEF(), A.id);
  seedWorld(rootIn(A.ws, "mv-conf2"));
  mkdirSync(rootIn(B.ws, "mv-conf2"), { recursive: true });
  const r2 = await moveBotToProject(db, "mv-conf2", B.id, { crowHome });
  assert.deepEqual(r2, { ok: false, code: "conflict", path: rootIn(B.ws, "mv-conf2") });
  assert.deepEqual(readdirSync(rootIn(B.ws, "mv-conf2")), [], "nothing was linked");
  assert.equal(Number((await bot("mv-conf2")).project_id), A.id);
});

test("stale definition undoes the carry", async () => {
  const [A] = await fresh(1);
  await addBot("mv-stale");
  seedWorld(legacyRoot("mv-stale"));
  // A racing write lands between the read and the compare-and-swap.
  const racing = {
    execute: async (q) => {
      if (/^UPDATE pi_bot_defs/.test(q.sql)) {
        await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='mv-stale'", args: [JSON.stringify({ ...BASE_DEF(), system_prompt: "raced" })] });
      }
      return db.execute(q);
    },
  };
  const r = await moveBotToProject(racing, "mv-stale", A.id, { crowHome });
  assert.deepEqual(r, { ok: false, code: "stale" });
  assert.ok(!existsSync(join(A.ws, "bots")), "the link and the dirs this move made are gone");
  assert.ok(existsSync(A.ws) === false || readdirSync(A.ws).length === 0);
  const row = await bot("mv-stale");
  assert.equal(row.project_id, null);
  assert.equal(JSON.parse(row.definition).system_prompt, "raced", "the racing write stands");
  assert.deepEqual(readdirSync(join(legacyRoot("mv-stale"), "sessions")), ["waiting.jsonl"], "the world is untouched");
  // A DB error on the UPDATE is undone the same way.
  const broken = { execute: async (q) => { if (/^UPDATE pi_bot_defs/.test(q.sql)) throw new Error("disk I/O"); return db.execute(q); } };
  assert.deepEqual(await moveBotToProject(broken, "mv-stale", A.id, { crowHome }), { ok: false, code: "stale" });
  assert.ok(!existsSync(join(A.ws, "bots")));
});

test("voice, unknown, same project, custom tracker, archived target refuse", async () => {
  const [A] = await fresh(1);
  const Z = await addProject(`zarch-${seq}`, { archived: true });
  assert.deepEqual(await moveBotToProject(db, "crow.voice", A.id, { crowHome }), { ok: false, code: "voice_bot" });
  assert.deepEqual(await moveBotToProject(db, "no-such-bot", A.id, { crowHome }), { ok: false, code: "unknown_bot" });
  await addBot("mv-same", BASE_DEF(), A.id);
  assert.deepEqual(await moveBotToProject(db, "mv-same", A.id, { crowHome }), { ok: false, code: "same_project" });
  await addBot("mv-custom", { ...BASE_DEF(), tracker_config: { type: "custom", tracker_slug: "leads" } });
  assert.deepEqual(await moveBotToProject(db, "mv-custom", A.id, { crowHome }), { ok: false, code: "custom_tracker" });
  await addBot("mv-custom-noslug", { ...BASE_DEF(), tracker_config: { type: "custom" } });
  assert.deepEqual(await moveBotToProject(db, "mv-custom-noslug", A.id, { crowHome }), { ok: false, code: "custom_tracker" });
  await addBot("mv-arch");
  assert.deepEqual(await moveBotToProject(db, "mv-arch", Z.id, { crowHome }), { ok: false, code: "no_project" });
  assert.deepEqual(await moveBotToProject(db, "mv-arch", 987654, { crowHome }), { ok: false, code: "no_project" });
  assert.deepEqual(await moveBotToProject(db, "mv-arch", "abc", { crowHome }), { ok: false, code: "no_project" });
  for (const id of ["mv-same", "mv-custom", "mv-arch"]) {
    const row = await bot(id);
    assert.equal(row.project_id == null ? null : Number(row.project_id), id === "mv-same" ? A.id : null, `${id} unchanged`);
  }
  // A task-list bot keeps task-list (as board_on does).
  await addBot("mv-tl", { ...BASE_DEF(), tracker_config: { type: "task-list" } });
  assert.equal((await moveBotToProject(db, "mv-tl", A.id, { crowHome })).ok, true);
  assert.equal(JSON.parse((await bot("mv-tl")).definition).tracker_config.type, "task-list");
});

test("audit on both projects", async () => {
  const [A, B] = await fresh(2);
  await addBot("mv-audit");
  seedWorld(legacyRoot("mv-audit"));
  assert.equal((await moveBotToProject(db, "mv-audit", A.id, { crowHome })).ok, true);
  const first = await auditRows(A.id, "mv-audit");
  assert.equal(first.length, 1, "null → A: one entry, on A");
  assert.equal(first[0].actor_type, "local");
  assert.deepEqual(JSON.parse(first[0].payload), { from: null, to: A.id, carry: { mode: "root", reason: null, carried: ["sessions", "outputs"] } });
  assert.equal((await moveBotToProject(db, "mv-audit", B.id, { crowHome, actor: "local" })).ok, true);
  const onA = await auditRows(A.id, "mv-audit"), onB = await auditRows(B.id, "mv-audit");
  assert.equal(onA.length, 2, "A → B: the old project logs it");
  assert.equal(onB.length, 1, "and the new one");
  const p = JSON.parse(onB[0].payload);
  assert.equal(p.from, A.id);
  assert.equal(p.to, B.id);
  assert.equal(p.carry.mode, "root");
  assert.deepEqual(JSON.parse(onA[1].payload), p);
});

// ---- fix wave (final review) ----

test("moving out of an archived project carries the world under its workspace", async () => {
  const [A, B] = await fresh(2);
  await addBot("mv-arch-out", BASE_DEF(), A.id);
  seedWorld(rootIn(A.ws, "mv-arch-out"));
  await db.execute({ sql: "UPDATE project_spaces SET archived_at=datetime('now') WHERE id=?", args: [A.id] });
  const r = await moveBotToProject(db, "mv-arch-out", B.id, { crowHome });
  assert.equal(r.ok, true);
  assert.equal(r.carry.mode, "root");
  assert.equal(readlinkSync(rootIn(B.ws, "mv-arch-out")), realpathSync(rootIn(A.ws, "mv-arch-out")), "A's world, not the empty legacy root");
  assert.deepEqual(readdirSync(join(rootIn(B.ws, "mv-arch-out"), "sessions")), ["waiting.jsonl"]);
  assert.equal((await auditRows(A.id, "mv-arch-out")).length, 1, "the archived project still logs it");

  // The project's folder is gone: the legacy world is what is carried.
  const [C, D] = await fresh(2);
  await addBot("mv-gone", BASE_DEF(), C.id);
  seedWorld(legacyRoot("mv-gone"));
  const g = await moveBotToProject(db, "mv-gone", D.id, { crowHome });
  assert.equal(g.ok, true);
  assert.equal(readlinkSync(rootIn(D.ws, "mv-gone")), legacyRoot("mv-gone"));
});

test("entries-mode carry: a legacy world into a project whose bots/<id> already exists with free paths", async () => {
  const [A] = await fresh(1);
  await addBot("mv-entries");
  seedWorld(legacyRoot("mv-entries"));
  const nr = rootIn(A.ws, "mv-entries");
  mkdirSync(nr, { recursive: true });
  writeFileSync(join(nr, "notes.txt"), "mine\n");
  const r = await moveBotToProject(db, "mv-entries", A.id, { crowHome });
  assert.deepEqual(r, { ok: true, carry: { mode: "entries", reason: null, carried: ["sessions", "outputs"] } });
  assert.ok(lstatSync(nr).isDirectory() && !lstatSync(nr).isSymbolicLink(), "the existing root is kept");
  assert.equal(readlinkSync(join(nr, "sessions")), join(legacyRoot("mv-entries"), "sessions"));
  assert.deepEqual(WR.carriedReadRoots({ worldRoot: nr, legacyRoot: legacyRoot("mv-entries") }), [realpathSync(legacyRoot("mv-entries"))]);
});

test("buildBotWorld after A -> B, where A's world is entries-mode, resolves to the real old world", async () => {
  const [A, B] = await fresh(2);
  const id = "mv-world";
  const L = legacyRoot(id);
  await addBot(id, { ...BASE_DEF(), models: { default: "stub/m1" }, tools: { pi_builtin: ["read"] } });
  seedWorld(L);
  // "Turn on a board" into an existing root: A/bots/<id> is a real dir and its
  // entries link into the legacy world (the same planner board_on runs).
  const aRoot = rootIn(A.ws, id);
  mkdirSync(aRoot, { recursive: true });
  const plan = WR.planCarryOver(L, aRoot);
  assert.equal(plan.mode, "entries");
  WR.applyCarryOver(plan, aRoot);
  await db.execute({ sql: "UPDATE pi_bot_defs SET project_id=? WHERE bot_id=?", args: [A.id, id] });

  const r = await moveBotToProject(db, id, B.id, { crowHome });
  assert.equal(r.ok, true);
  assert.equal(readlinkSync(rootIn(B.ws, id)), aRoot, "B links to A's real root (a real dir), no chain");

  const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
  const world = await buildBotWorld({ botId: id, threadId: "mv-world-t", gatewayType: "perch" });
  assert.equal(world.sessionDir, rootIn(B.ws, id), "the world root is B's");
  assert.equal(realpathSync(world.sessionDir), realpathSync(aRoot));
  assert.equal(realpathSync(join(world.sessionDir, "sessions")), realpathSync(join(L, "sessions")), "resume finds the real old sessions");
  assert.deepEqual(readdirSync(join(world.sessionDir, "sessions")), ["waiting.jsonl"]);
  assert.deepEqual(world.extraReadPaths, [realpathSync(L)], "the spawn may read the carried entries");
});
