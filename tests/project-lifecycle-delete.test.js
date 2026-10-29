// Permanent project delete (spec §15.2): the read-only summary, the refusals, and the purge that
// leaves a hidden tombstone row. Scratch CROW_HOME + data dir, a real crow.db from init-db, a real
// tasks.db file, a real per-project store file, and real symlinks in the workspace.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "crow-pld-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
const TASKS = join(DATA, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const REPO = join(import.meta.dirname, "..");
let db, createProjectSpace, L, ensureItem;
const P = await import("../scripts/migrations/0004-track1-card-model.mjs");

const TASKS_DDL = `CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', project_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}', archived_at TEXT);`;
const DEFS_DDL = `CREATE TABLE IF NOT EXISTS board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, project_id INTEGER UNIQUE,
  display_name TEXT NOT NULL, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]');`;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const t = new Database(TASKS);
  t.exec(TASKS_DDL + DEFS_DDL);
  for (const d of [P.BOARD_PLANS_DDL, P.BOARD_RESULTS_DDL, P.BOARD_MUTATIONS_DDL, P.TASKS_BRIEFINGS_DDL]) t.exec(d);
  t.close();
  ({ createDbClient: globalThis.__c } = await import("../servers/db.js"));
  db = globalThis.__c(join(DATA, "crow.db"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  ({ ensureItem } = await import("../servers/shared/shell-items.js"));
  L = await import("../servers/shared/project-lifecycle.js");
});
after(() => { try { db && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
const tasks = (path = TASKS) => new Database(path);
const tn = (sql, args = [], path = TASKS) => { const t = tasks(path); try { return Number(t.prepare(sql).get(...args).n); } finally { t.close(); } };

async function mk(name, opts) {
  const r = await createProjectSpace(db, { name, ...opts });
  return Number(r.id);
}
const proj = (id) => one("SELECT * FROM project_spaces WHERE id = ?", [id]);

/** Global-store cards (+ plan, result, mutation per card) and a board def for `pid`. */
function seedCards(pid, count = 2, path = TASKS, { defs = path === TASKS } = {}) {
  const t = tasks(path);
  try {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = Number(t.prepare("INSERT INTO tasks_items (title, project_id) VALUES (?, ?)").run(`c${pid}-${i}`, pid).lastInsertRowid);
      ids.push(id);
      if (path === TASKS) {
        t.prepare("INSERT INTO board_plans (item_id, version, body_md, created_actor_kind) VALUES (?, 1, 'p', 'human')").run(id);
        t.prepare("INSERT INTO board_results (item_id, actor_kind, outcome) VALUES (?, 'bot', 'success')").run(id);
        t.prepare("INSERT INTO board_mutations (item_id, verb, actor_kind) VALUES (?, 'create', 'human')").run(id);
      }
    }
    if (defs) t.prepare("INSERT INTO board_defs (slug, project_id, display_name, status_values, terminal_values) VALUES (?, ?, 'B', '[]', '[]')").run(`def-${pid}`, pid);
    return ids;
  } finally { t.close(); }
}

/** Every crow.db thing the delete touches, plus a workspace with a file. */
async function seed(pid) {
  const p = await proj(pid);
  const ins = (sql, args) => db.execute({ sql, args }).catch((e) => { throw new Error(`${e.message}: ${sql}`); });
  await ins("INSERT INTO research_sources (project_id, title, source_type, citation_apa) VALUES (?, 'S', 'other', 'S.')", [pid]);
  await ins("INSERT INTO research_notes (project_id, content) VALUES (?, 'note a')", [pid]);
  await ins("INSERT INTO research_notes (project_id, content) VALUES (?, 'note b')", [pid]);
  await ins("INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES (?, 'T', 'c', ?)", [`ctx-${pid}`, pid]);
  await ins("INSERT INTO memories (content, project_id, project_uuid, source) VALUES ('m', ?, ?, 'test')", [pid, p.uuid]);
  await ensureItem(db, "perch_thread", `thr-${pid}`, { projectId: pid, setBy: "operator" });
  await ins("INSERT INTO card_offers (bot_id, thread_id, title, project_id) VALUES ('b', ?, 'offer', ?)", [`thr-${pid}`, pid]);
  await ins("INSERT INTO bot_sessions (bot_id, project_id) VALUES (?, ?)", [`b-${pid}`, pid]);
  await ins("INSERT INTO storage_files (s3_key, original_name, project_id) VALUES (?, 'f.txt', ?)", [`projects/${p.slug}/f.txt`, pid]);
  await ins(`INSERT INTO service_connections (uuid, project_id, service_id, method, account_label, label_slug, status)
             VALUES (?, ?, 'github', 'token', 'Main', 'main', 'active')`, [`conn-${pid}`, pid]);
  await ins("INSERT INTO data_backends (project_id, name, connection_ref) VALUES (?, 'db', 'ref')", [pid]);
  mkdirSync(p.workspace_dir, { recursive: true });
  writeFileSync(join(p.workspace_dir, "readme.txt"), "hello");
  return p;
}

const recorder = () => {
  const calls = [];
  return { calls, storageDelete: async (row) => { calls.push(row.s3_key); await db.execute({ sql: "DELETE FROM storage_files WHERE id = ?", args: [row.id] }); } };
};
const del = (id, name, extra = {}) => L.deleteProject(db, id, {
  confirmName: name, storageDelete: recorder().storageDelete, disconnectBackend: () => true, ...extra,
});

test("summary counts", async () => {
  const id = await mk("Sum A");
  await seed(id);
  seedCards(id, 3);
  const before = await n("SELECT COUNT(*) AS n FROM research_notes");
  const s = await L.deleteSummary(db, id, {});
  assert.equal(s.blocked, null);
  assert.deepEqual(s.counts, {
    cards: 3, files: 1, notes: 2, sources: 1, sessions: 2, connections: 1, backends: 1, workspace: true, everCloneShared: false,
  });
  assert.equal(await n("SELECT COUNT(*) AS n FROM research_notes"), before, "read-only");

  // A per-project store that does not exist is counted as 0 and is never created.
  const own = await mk("Sum own");
  const ghost = join(DATA, "ghost.db");
  await db.execute({ sql: "UPDATE project_spaces SET tasks_db_uri = ? WHERE id = ?", args: ["file:" + ghost, own] });
  assert.equal((await L.deleteSummary(db, own)).counts.cards, 0);
  assert.equal(existsSync(ghost), false);
});

test("blocked when shared", async () => {
  const id = await mk("Shared");
  const c = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:alex', 'Alex', 'e', 's') RETURNING id" });
  const cid = Number(c.rows[0].id);
  await db.execute({ sql: "INSERT INTO project_members (project_id, contact_id, role, mode) VALUES (?, ?, 'editor', 'clone')", args: [id, cid] });
  await db.execute({ sql: "INSERT INTO shared_items (contact_id, share_type, item_id, direction) VALUES (?, 'project', ?, 'sent')", args: [cid, id] });
  const s = await L.deleteSummary(db, id);
  assert.equal(s.blocked.code, "shared");
  assert.deepEqual(s.blocked.detail, { members: ["Alex"], shares: 1 });
  assert.equal(s.counts.everCloneShared, true);
  const r = await del(id, "Shared");
  assert.equal(r.ok, false);
  assert.equal(r.code, "shared");
  assert.equal((await proj(id)).archived_at, null);

  // Revoked and unshared: no longer blocked, but it was clone-shared once.
  await db.execute({ sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE project_id = ? AND contact_id = ?", args: [id, cid] });
  await db.execute({ sql: "DELETE FROM shared_items WHERE item_id = ?", args: [id] });
  const s2 = await L.deleteSummary(db, id);
  assert.equal(s2.blocked, null);
  assert.equal(s2.counts.everCloneShared, true);
});

test("blocked when bots", async () => {
  const id = await mk("Botted");
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, project_id) VALUES ('b-del', 'Robin', ?)", args: [id] });
  const s = await L.deleteSummary(db, id);
  assert.deepEqual(s.blocked, { code: "bots", detail: { bots: ["Robin"] } });
  assert.equal((await del(id, "Botted")).code, "bots");
  assert.equal((await proj(id)).archived_at, null);
  await db.execute("DELETE FROM pi_bot_defs WHERE bot_id = 'b-del'");
});

test("blocked when not owner", async () => {
  const visited = await mk("Visited", { ownerMember: false });
  assert.deepEqual(await L.deleteSummary(db, visited), { blocked: { code: "not_owner", detail: null }, counts: null });
  assert.equal((await del(visited, "Visited")).code, "not_owner");
  assert.equal((await del(987654, "x")).code, "not_owner");
  assert.equal((await proj(visited)).archived_at, null);
  const id = await mk("Actor");
  assert.equal((await del(id, "Actor", { actor: "root" })).code, "bad_actor");
});

test("name mismatch refuses", async () => {
  const id = await mk("Exact Name");
  await seed(id);
  for (const bad of ["exact name", "Exact", "", undefined]) {
    assert.equal((await del(id, bad)).code, "name_mismatch", String(bad));
  }
  assert.equal((await proj(id)).archived_at, null);
  assert.equal(await n("SELECT COUNT(*) AS n FROM research_notes WHERE project_id = ?", [id]), 2);
  assert.equal((await one("SELECT status FROM service_connections WHERE project_id = ?", [id])).status, "active", "nothing disconnected");
  const ok = await del(id, "  Exact Name  ");
  assert.equal(ok.ok, true, "trimmed");
});

test("delete purges every table listed", async () => {
  const id = await mk("Purge");
  const p = await seed(id);
  seedCards(id, 2);
  const rec = recorder();
  const backends = [];
  const r = await L.deleteProject(db, id, {
    confirmName: "Purge", storageDelete: rec.storageDelete, disconnectBackend: (b) => backends.push(b),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.partial, undefined);
  assert.equal(r.counts.workspaceMoved, true);
  assert.equal(r.counts.cards, 2);
  for (const t of ["service_connections", "data_backends", "research_notes", "research_sources", "crow_context", "storage_files"]) {
    assert.equal(await n(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, [id]), 0, t);
  }
  assert.equal(backends.length, 1);
  assert.deepEqual(rec.calls, [`projects/${p.slug}/f.txt`]);
  assert.equal((await one("SELECT status FROM card_offers WHERE project_id = ?", [id])).status, "declined");
  assert.equal(await n("SELECT COUNT(*) AS n FROM bot_sessions WHERE project_id = ?", [id]), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM bot_sessions WHERE bot_id = ? AND project_id IS NULL", [`b-${id}`]), 1, "session kept, unfiled");
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [id]), 0);
  assert.equal(tn("SELECT COUNT(*) AS n FROM board_defs WHERE project_id = ?", [id]), 0);
  const t = tasks();
  const orphans = ["board_plans", "board_results", "board_mutations"].map((x) =>
    t.prepare(`SELECT COUNT(*) AS n FROM ${x} WHERE item_id NOT IN (SELECT id FROM tasks_items)`).get().n);
  t.close();
  assert.deepEqual(orphans, [0, 0, 0]);

  const tomb = await proj(id);
  assert.ok(tomb.archived_at);
  assert.equal(tomb.status, "archived");
  assert.equal(tomb.slug, `${p.slug}-deleted-${id}`);
  assert.equal(tomb.name, "Purge");
  assert.equal(tomb.description, null);
  assert.equal(existsSync(p.workspace_dir), false);
  const moved = join(DATA, "deleted-projects", readdirSync(join(DATA, "deleted-projects")).find((d) => d.startsWith(p.uuid)));
  assert.match(moved, new RegExp(`${p.uuid}-\\d{8}$`));
  assert.equal(readFileSync(join(moved, "readme.txt"), "utf8"), "hello");

  // A second delete of the tombstone is refused and changes nothing.
  assert.equal((await del(id, "Purge")).code, "not_owner");
});

test("memories kept, unfiled", async () => {
  const id = await mk("Mem");
  await seed(id);
  const m = await one("SELECT id FROM memories WHERE project_id = ?", [id]);
  assert.equal((await del(id, "Mem")).ok, true);
  const row = await one("SELECT content, project_id, project_uuid FROM memories WHERE id = ?", [m.id]);
  assert.deepEqual({ ...row }, { content: "m", project_id: null, project_uuid: null });
});

test("shell items unassigned", async () => {
  const id = await mk("Shell");
  await seed(id);
  assert.equal((await del(id, "Shell")).ok, true);
  const row = await one("SELECT project_id FROM shell_items WHERE item_kind = 'perch_thread' AND item_ref = ?", [`thr-${id}`]);
  assert.equal(row.project_id, null);
});

test("shared global store keeps other cards", async () => {
  const gone = await mk("Gone");
  const keep = await mk("Keep");
  seedCards(gone, 2);
  const keepIds = seedCards(keep, 3);
  // A tasks_db_uri that IS the global file is the global store, filtered by project_id.
  await db.execute({ sql: "UPDATE project_spaces SET tasks_db_uri = ? WHERE id = ?", args: ["file:" + TASKS, gone] });
  assert.equal(L.resolveCardsStore({ tasks_db_uri: "file:" + TASKS }).global, true);
  assert.equal((await L.deleteSummary(db, gone)).counts.cards, 2);
  assert.equal((await del(gone, "Gone")).ok, true);
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [keep]), 3);
  const t = tasks();
  for (const x of ["board_plans", "board_results", "board_mutations"]) {
    const k = t.prepare(`SELECT COUNT(*) AS n FROM ${x} WHERE item_id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(keepIds)).n;
    assert.equal(k, 3, x);
  }
  assert.equal(t.prepare("SELECT COUNT(*) AS n FROM board_defs WHERE project_id = ?").get(keep).n, 1);
  t.close();
});

test("per-project store: only rows deleted, file kept", async () => {
  const id = await mk("Own Store");
  const OWN = join(DATA, "own.db");
  const o = new Database(OWN);
  o.exec(TASKS_DDL);
  o.close();
  await db.execute({ sql: "UPDATE project_spaces SET tasks_db_uri = ? WHERE id = ?", args: ["file:" + OWN, id] });
  const mine = seedCards(id, 2, OWN);
  seedCards(id + 1000, 1, OWN); // another project's card in the same file
  // The global store holds this project's board def, and global records whose item ids collide
  // with the per-project card ids (a separate id space): those must survive.
  const other = await mk("Collide");
  seedCards(other, 2);
  const g = tasks();
  g.prepare("INSERT INTO board_defs (slug, project_id, display_name, status_values, terminal_values) VALUES ('own', ?, 'O', '[]', '[]')").run(id);
  const plansBefore = g.prepare("SELECT COUNT(*) AS n FROM board_plans WHERE item_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(mine)).n;
  g.close();
  assert.ok(plansBefore > 0, "the collision is real");

  assert.equal((await L.deleteSummary(db, id)).counts.cards, 2);
  assert.equal((await del(id, "Own Store")).ok, true);
  assert.ok(existsSync(OWN), "store file kept");
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [id], OWN), 0);
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [id + 1000], OWN), 1);
  assert.equal(tn("SELECT COUNT(*) AS n FROM board_plans WHERE item_id IN (SELECT value FROM json_each(?))", [JSON.stringify(mine)]), plansBefore);
  assert.equal(tn("SELECT COUNT(*) AS n FROM board_defs WHERE project_id = ?", [id]), 0, "board def removed from the global store");
});

test("workspace rename never follows links", async () => {
  const id = await mk("Linked");
  const p = await seed(id);
  // A bot's world root lives outside the workspace; the workspace holds a dir link and a file link to it.
  const world = join(HOME, "pi-bots", "b-linked");
  mkdirSync(join(world, "sessions"), { recursive: true });
  writeFileSync(join(world, "sessions", "s1.jsonl"), "history");
  mkdirSync(join(p.workspace_dir, "bots"), { recursive: true });
  symlinkSync(world, join(p.workspace_dir, "bots", "b-linked"));
  symlinkSync(join(world, "sessions", "s1.jsonl"), join(p.workspace_dir, "s1-link.jsonl"));
  const worldReal = realpathSync(world);

  const r = await del(id, "Linked");
  assert.equal(r.ok, true);
  assert.equal(r.counts.workspaceMoved, true);
  const moved = join(DATA, "deleted-projects", readdirSync(join(DATA, "deleted-projects")).find((d) => d.startsWith(p.uuid)));
  assert.ok(lstatSync(join(moved, "bots", "b-linked")).isSymbolicLink(), "moved as a link");
  assert.equal(realpathSync(join(moved, "bots", "b-linked")), worldReal);
  assert.ok(lstatSync(join(moved, "s1-link.jsonl")).isSymbolicLink());
  assert.equal(readFileSync(join(world, "sessions", "s1.jsonl"), "utf8"), "history", "the bot's history is untouched");
  assert.equal(realpathSync(world), worldReal);

  // No workspace: skipped, still ok.
  const bare = await mk("Bare");
  const r2 = await del(bare, "Bare");
  assert.equal(r2.ok, true);
  assert.equal(r2.counts.workspace, false);
  assert.equal(r2.counts.workspaceMoved, false);
  assert.equal(r2.partial, undefined);
});

test("failure rolls back everything", async () => {
  const id = await mk("Rollback");
  const p = await seed(id);
  seedCards(id, 2);
  const rec = recorder();
  const r = await L.deleteProject(db, id, {
    confirmName: "Rollback", storageDelete: rec.storageDelete, disconnectBackend: () => true,
    _beforeTombstone: () => { throw new Error("injected"); },
  });
  assert.deepEqual(r, { ok: false, code: "failed" });
  const row = await proj(id);
  assert.equal(row.archived_at, null);
  assert.equal(row.slug, p.slug);
  for (const t of ["data_backends", "research_sources", "crow_context", "storage_files", "bot_sessions", "service_connections"]) {
    assert.equal(await n(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, [id]), 1, t);
  }
  assert.equal(await n("SELECT COUNT(*) AS n FROM research_notes WHERE project_id = ?", [id]), 2);
  assert.equal(await n("SELECT COUNT(*) AS n FROM memories WHERE project_id = ?", [id]), 1);
  assert.equal(await n("SELECT COUNT(*) AS n FROM shell_items WHERE project_id = ?", [id]), 1);
  assert.equal((await one("SELECT status FROM card_offers WHERE project_id = ?", [id])).status, "pending");
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = ? AND action = 'project.delete'", [id]), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'project.delete' AND details LIKE ?", [`%"project_id":${id},%`]), 0);
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [id]), 2);
  assert.ok(existsSync(join(p.workspace_dir, "readme.txt")));
  assert.deepEqual(rec.calls, []);
  // The pre-transaction disconnect stands (secrets masked); the project is otherwise whole and deletable.
  assert.equal((await one("SELECT status FROM service_connections WHERE project_id = ?", [id])).status, "disconnected");
  assert.equal((await del(id, "Rollback")).ok, true);
});

test("name and slug are free, id not reused", async () => {
  const id = await mk("Reuse Me");
  const p = await seed(id);
  seedCards(id, 1);
  assert.equal((await del(id, "Reuse Me")).ok, true);
  const again = await mk("Reuse Me");
  assert.ok(again > id, `new id ${again} after ${id}`);
  const fresh = await proj(again);
  assert.equal(fresh.name, "Reuse Me");
  assert.notEqual(fresh.slug, (await proj(id)).slug);
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_spaces WHERE slug = ?", [p.slug]), 0, "old slug free");
  assert.equal(await n("SELECT COUNT(*) AS n FROM crow_context WHERE project_id = ?", [again]), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM pi_bot_defs WHERE project_id = ?", [again]), 0);
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [again]), 0);
  assert.equal(tn("SELECT COUNT(*) AS n FROM board_defs WHERE project_id = ?", [again]), 0);
  const { activeProjectWhere } = await import("../servers/shared/shell-items.js");
  assert.equal(await n(`SELECT COUNT(*) AS n FROM project_spaces ps WHERE ps.id = ? AND ${activeProjectWhere("ps")}`, [id]), 0, "tombstone hidden");
});

test("audit survives in project_audit_log and audit_log", async () => {
  const id = await mk("Audited");
  await seed(id);
  const r = await del(id, "Audited", { actor: "system" });
  assert.equal(r.ok, true);
  const a = await one("SELECT actor_type, payload FROM project_audit_log WHERE project_id = ? AND action = 'project.delete'", [id]);
  assert.equal(a.actor_type, "system");
  assert.equal(JSON.parse(a.payload).notes, 2);
  assert.ok(await n("SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = ? AND action = 'service.disconnect'", [id]) >= 1);
  const g = await one("SELECT actor, details FROM audit_log WHERE event_type = 'project.delete' AND details LIKE ?", [`%"project_id":${id},%`]);
  assert.equal(g.actor, "system");
  const d = JSON.parse(g.details);
  assert.equal(d.name, "Audited");
  assert.equal(d.counts.workspaceMoved, true);
});

test("a step after the commit that fails is partial, never undone", async () => {
  const id = await mk("Partial");
  const p = await seed(id);
  const r = await del(id, "Partial", { storageDelete: async () => { throw new Error("storage down"); } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.partial, ["files"]);
  assert.ok((await proj(id)).archived_at, "tombstone stands");
  assert.equal(await n("SELECT COUNT(*) AS n FROM storage_files WHERE project_id = ?", [id]), 1, "row kept for a later retry");
  assert.equal(existsSync(p.workspace_dir), false, "later steps still ran");
  const g = await one("SELECT details FROM audit_log WHERE event_type = 'project.delete' AND details LIKE ?", [`%"project_id":${id},%`]);
  assert.deepEqual(JSON.parse(g.details).partial, ["files"]);
});

test("a member or bot added after the summary is refused inside the transaction, nothing changed", async () => {
  for (const kind of ["member", "bot"]) {
    const id = await mk(`Race ${kind}`);
    const p = await seed(id);
    await db.execute({ sql: "DELETE FROM service_connections WHERE project_id = ?", args: [id] }); // the pre-step would mask it
    seedCards(id, 1);
    const snap = async () => ({
      ps: { ...(await proj(id)) },
      notes: await n("SELECT COUNT(*) AS n FROM research_notes WHERE project_id = ?", [id]),
      ctx: await n("SELECT COUNT(*) AS n FROM crow_context WHERE project_id = ?", [id]),
      mem: await n("SELECT COUNT(*) AS n FROM memories WHERE project_id = ?", [id]),
      shell: await n("SELECT COUNT(*) AS n FROM shell_items WHERE project_id = ?", [id]),
      offers: await n("SELECT COUNT(*) AS n FROM card_offers WHERE project_id = ? AND status = 'pending'", [id]),
      sessions: await n("SELECT COUNT(*) AS n FROM bot_sessions WHERE project_id = ?", [id]),
      backends: await n("SELECT COUNT(*) AS n FROM data_backends WHERE project_id = ?", [id]),
      audit: await n("SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = ? AND action = 'project.delete'", [id]),
      cards: tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [id]),
    });
    const before = await snap();
    const rec = recorder();
    const r = await L.deleteProject(db, id, {
      confirmName: `Race ${kind}`, storageDelete: rec.storageDelete, disconnectBackend: () => true,
      _beforeTransaction: async () => {
        if (kind === "member") {
          const c = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?, 'Late', 'e', 's') RETURNING id", args: [`crow:late-${id}`] });
          await db.execute({ sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, ?, 'viewer')", args: [id, Number(c.rows[0].id)] });
        } else {
          await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, project_id) VALUES (?, 'Late bot', ?)", args: [`late-${id}`, id] });
        }
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, kind === "member" ? "shared" : "bots");
    assert.deepEqual(await snap(), before, `${kind}: nothing changed`);
    assert.deepEqual(rec.calls, []);
    assert.ok(existsSync(join(p.workspace_dir, "readme.txt")));
  }
});

test("tombstone slug skips one already taken", async () => {
  const id = await mk("Slug Clash");
  const p = await proj(id);
  await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, 'squatter')", args: [`${p.slug}-deleted-${id}`] });
  await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, 'squatter 2')", args: [`${p.slug}-deleted-${id}-2`] });
  assert.equal((await del(id, "Slug Clash")).ok, true);
  assert.equal((await proj(id)).slug, `${p.slug}-deleted-${id}-3`);
});

test("a workspace that is not <dataDir>/projects/<slug>/workspace is left in place", async () => {
  const id = await mk("Elsewhere");
  const p = await proj(id);
  // Inside the projects root but not this project's own folder (another project's workspace path).
  const other = join(DATA, "projects", "someone-else", "workspace");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "keep.txt"), "mine");
  await db.execute({ sql: "UPDATE project_spaces SET workspace_dir = ? WHERE id = ?", args: [other, id] });
  const r = await del(id, "Elsewhere");
  assert.equal(r.ok, true);
  assert.equal(r.counts.workspaceMoved, false);
  assert.deepEqual(r.partial, ["workspace"]);
  assert.equal(readFileSync(join(other, "keep.txt"), "utf8"), "mine");
  assert.ok(p.slug);
});
