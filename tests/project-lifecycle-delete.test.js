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
  assert.equal(await n("SELECT COUNT(*) AS n FROM storage_files WHERE project_id = ?", [id]), 1, "row left behind: inert (the id is never reused); a cleanup of leftovers is a queued follow-up");
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

test("a tombstone is never rewritten by updateProjectSpaceMeta: callers see not found", async () => {
  const { updateProjectSpaceMeta } = await import("../servers/shared/project-spaces.js");
  const id = await mk("Meta Gone");
  assert.equal((await del(id, "Meta Gone")).ok, true);
  const before = { ...(await proj(id)) };
  assert.equal(await updateProjectSpaceMeta(db, id, { status: "active", name: "Back", description: "d" }), 0);
  assert.deepEqual({ ...(await proj(id)) }, before);
  const live = await mk("Meta Live");
  assert.equal(await updateProjectSpaceMeta(db, live, { status: "paused" }), 1, "a live row still updates");
});

test("a leftover workspace folder is never adopted by explicit-slug creation or a received clone", async () => {
  // A deleted project's folder whose move failed, at the path the next "-clone-1" would use.
  const left = join(DATA, "projects", "leftover-clone-1", "workspace");
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, "old.txt"), "old project's file");
  const made = await createProjectSpace(db, { name: "Direct", explicitSlug: "leftover-clone-1" });
  assert.equal(made.slug, "leftover-clone-1");
  assert.equal(made.workspaceDir, join(DATA, "projects", "leftover-clone-1-2", "workspace"));
  assert.equal((await proj(made.id)).workspace_dir, made.workspaceDir);

  // The clone receive: slug leftover-clone-1 is now taken, so it goes to -clone-2; plant that folder too.
  const left2 = join(DATA, "projects", "leftover-clone-2", "workspace");
  mkdirSync(left2, { recursive: true });
  writeFileSync(join(left2, "old.txt"), "another leftover");
  const { createCloneBundleHelpers } = await import("../servers/sharing/clone-bundle.js");
  const { applyProjectCloneBundle } = createCloneBundleHelpers({ db });
  await applyProjectCloneBundle({
    bundle_version: 1, project: { name: "Leftover", slug: "leftover", description: null, type: "general", tags: null },
    sources: [], notes: [], audit_log: [], backends: [], file_manifest: [], origin_instance_id: "test-origin", snapshot_at: new Date().toISOString(),
  }, null);
  const clone = await one("SELECT slug, workspace_dir FROM project_spaces WHERE name = 'Leftover (clone)'");
  assert.equal(clone.slug, "leftover-clone-2");
  assert.equal(clone.workspace_dir, join(DATA, "projects", "leftover-clone-2-2", "workspace"));
  assert.ok(existsSync(clone.workspace_dir), "the clone's fresh folder exists");
  assert.deepEqual(readdirSync(clone.workspace_dir), []);
  assert.equal(readFileSync(join(left, "old.txt"), "utf8"), "old project's file");
  assert.equal(readFileSync(join(left2, "old.txt"), "utf8"), "another leftover");
});

test("queued jobs for the deleted cards are cancelled (never deleted); others are left alone", async () => {
  const id = await mk("Jobbed");
  const other = await mk("Jobs Other");
  const [c1, c2] = seedCards(id, 2);
  const [k1] = seedCards(other, 1);
  const job = (jid, card, status) => db.execute({ sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, card_id, source) VALUES (?, 'b', 'g', ?, ?, 'card')", args: [jid, status, card] });
  await job("j-q", c1, "queued");
  await job("j-run", c2, "running");
  await job("j-other", k1, "queued");
  // A per-project store's card ids are another id space: a job naming the same number is not its.
  const own = await mk("Jobs Own");
  const OWN2 = join(DATA, "own-jobs.db");
  const o = new Database(OWN2); o.exec(TASKS_DDL); o.close();
  await db.execute({ sql: "UPDATE project_spaces SET tasks_db_uri = ? WHERE id = ?", args: ["file:" + OWN2, own] });
  const [ownCard] = seedCards(own, 1, OWN2);
  await job("j-collide", ownCard, "queued");

  assert.equal((await del(id, "Jobbed")).ok, true);
  assert.equal((await del(own, "Jobs Own")).ok, true);
  const st = async (jid) => ({ ...(await one("SELECT status, error FROM bot_jobs WHERE job_id = ?", [jid])) });
  assert.deepEqual(await st("j-q"), { status: "failed", error: "cancelled: its project was deleted" });
  assert.equal((await st("j-run")).status, "running", "a running job is not touched");
  assert.equal((await st("j-other")).status, "queued");
  assert.equal((await st("j-collide")).status, "queued", "a per-project card id never cancels a global job");
  assert.equal(await n("SELECT COUNT(*) AS n FROM bot_jobs WHERE job_id IN ('j-q','j-run','j-other','j-collide')"), 4, "nothing deleted");
});

test("the refusals run again right before the disconnects; a late refusal reports the disconnects", async () => {
  // Added after the summary, before the disconnects: refused, the connection still active.
  const id = await mk("Early Late");
  await seed(id);
  const r = await L.deleteProject(db, id, {
    confirmName: "Early Late", storageDelete: recorder().storageDelete, disconnectBackend: () => true,
    _afterSummary: () => db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, project_id) VALUES (?, 'Early', ?)", args: [`early-${id}`, id] }),
  });
  assert.equal(r.code, "bots");
  assert.equal((await one("SELECT status FROM service_connections WHERE project_id = ?", [id])).status, "active", "nothing disconnected");

  // Added after the disconnects: refused inside the transaction, with the count.
  const id2 = await mk("Very Late");
  await seed(id2);
  const r2 = await L.deleteProject(db, id2, {
    confirmName: "Very Late", storageDelete: recorder().storageDelete, disconnectBackend: () => true,
    _beforeTransaction: () => db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, project_id) VALUES (?, 'Late', ?)", args: [`vlate-${id2}`, id2] }),
  });
  assert.equal(r2.code, "bots");
  assert.deepEqual(r2.detail, { bots: ["Late"], disconnected: 1 });
  assert.equal((await proj(id2)).archived_at, null);
});

// ---------------------------------------------------------------------------------------------
// Finishing a delete that stopped partway: the post-commit steps re-run from what the audit says
// is left, against the tombstone (whose slug, uuid and original slug come from that audit).
// ---------------------------------------------------------------------------------------------

/** A storageDelete that throws on its first call only, then behaves. */
const flakyStorage = () => {
  let boom = true;
  return async (row) => {
    if (boom) { boom = false; throw new Error("storage down"); }
    await db.execute({ sql: "DELETE FROM storage_files WHERE id = ?", args: [row.id] });
  };
};

test("a partial delete can be finished", async () => {
  const id = await mk("Finish");
  const p = await seed(id);
  seedCards(id, 1);
  const r = await del(id, "Finish", { storageDelete: flakyStorage() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.partial, ["files"]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM storage_files WHERE project_id = ?", [id]), 1);
  assert.ok((await proj(id)).archived_at, "the tombstone stands");

  const res = await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.partial, [], "nothing left");
  assert.equal(await n("SELECT COUNT(*) AS n FROM storage_files WHERE project_id = ?", [id]), 0);
  assert.equal(existsSync(p.workspace_dir), false, "the workspace was already moved");
  // The tombstone is untouched: same row, same slug, still deleted.
  const tomb = await proj(id);
  assert.ok(tomb.archived_at);
  assert.equal(tomb.slug, `${p.slug}-deleted-${id}`);

  const a = await one("SELECT actor_type, payload FROM project_audit_log WHERE project_id = ? AND action = 'project.delete.resume'", [id]);
  assert.equal(a.actor_type, "local");
  assert.deepEqual(JSON.parse(a.payload), { remaining_partial: [] });
  const g = await one("SELECT details FROM audit_log WHERE event_type = 'project.delete.resume' AND details LIKE ?", [`%"project_id":${id},%`]);
  assert.deepEqual(JSON.parse(g.details).remaining_partial, []);
  assert.equal(JSON.parse(g.details).slug, p.slug, "the original slug, not the tombstone's");
});

test("finishing a partial workspace move moves it under deleted-projects", async () => {
  const id = await mk("Ws Finish");
  const p = await seed(id);
  // A data dir that is not this instance's: the workspace is not <dataDir>/projects/<slug>/workspace,
  // so the delete leaves it in place and says so.
  const r = await del(id, "Ws Finish", { dataDir: join(DATA, "not-this-instance") });
  assert.equal(r.ok, true);
  assert.deepEqual(r.partial, ["workspace"]);
  assert.equal(readFileSync(join(p.workspace_dir, "readme.txt"), "utf8"), "hello", "left in place");

  const res = await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.partial, []);
  assert.equal(existsSync(p.workspace_dir), false);
  const moved = readdirSync(join(DATA, "deleted-projects")).filter((d) => d.startsWith(p.uuid));
  assert.equal(moved.length, 1, "one folder under deleted-projects");
  assert.match(moved[0], new RegExp(`^${p.uuid}-\\d{8}$`));
  assert.equal(readFileSync(join(DATA, "deleted-projects", moved[0], "readme.txt"), "utf8"), "hello");
});

test("finishing a delete that was not partial is refused", async () => {
  const id = await mk("Nothing Owed");
  await seed(id);
  const r = await del(id, "Nothing Owed");
  assert.equal(r.ok, true);
  assert.equal(r.partial, undefined, "every step finished");
  assert.deepEqual(await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete }), { ok: false, code: "not_partial" });
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = ? AND action = 'project.delete.resume'", [id]), 0, "no resume audit for a refusal");

  // A live project is never a candidate either, and neither is one that was never deleted.
  const live = await mk("Still Live");
  assert.deepEqual(await L.resumeProjectDelete(db, live, {}), { ok: false, code: "not_partial" });
  assert.equal((await proj(live)).archived_at, null);
});

/** `db` with its `execute` wrapped (every other method forwarded, bound to the real client). */
const withExecute = (db, wrap) => new Proxy(db, {
  get(target, prop) {
    if (prop === "execute") return (q) => wrap(target, q);
    const v = Reflect.get(target, prop, target);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

/**
 * A project whose delete purged its cards but could not cancel their queued job: the tombstone
 * stands with `jobs` owed, and no card row is left for the job to be tied to.
 */
async function joblessProject(name) {
  const id = await mk(name);
  await seed(id);
  const [card] = seedCards(id, 1);
  await db.execute({ sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, card_id, source) VALUES (?, 'b', 'g', 'queued', ?, 'card')", args: [`j-${id}`, card] });
  // The cancel write fails once; the tombstone is already committed and the cards are gone.
  let boom = true;
  const flakyJobs = withExecute(db, (real, q) => {
    const sql = typeof q === "string" ? q : String(q.sql || "");
    if (boom && /UPDATE bot_jobs SET status = 'failed'/.test(sql)) { boom = false; throw new Error("database is locked"); }
    return real.execute(q);
  });
  const r = await L.deleteProject(flakyJobs, id, { confirmName: name, storageDelete: recorder().storageDelete, disconnectBackend: () => true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.partial, ["jobs"]);
  assert.equal(tn("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", [id]), 0, "the cards are gone");
  return { id, job: `j-${id}` };
}

/** The same db, but the tombstone row it hands back carries no uuid (an older row shape). */
const withoutTombUuid = (inner) => withExecute(inner, (real, q) => {
  const sql = typeof q === "string" ? q : String(q.sql || "");
  const r = real.execute(q);
  if (!/archived_at\s+FROM project_spaces/.test(sql)) return r;
  return r.then((res) => ({ ...res, rows: res.rows.map((row) => ({ ...row, uuid: null })) }));
});

/** Rewrite the uuid the original project.delete audit entry records (it is plain text). */
const forgeAuditUuid = (pid, uuid) => db.execute({
  sql: "UPDATE audit_log SET details = json_set(details, '$.uuid', ?) WHERE event_type = 'project.delete' AND details LIKE ?",
  args: [uuid, `%"project_id":${pid},%`],
});

test("jobs that can no longer be traced are reported, not hidden", async () => {
  const { id } = await joblessProject("Lost Jobs");

  const res = await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.partial, [], "not reported as a step that failed again");
  assert.deepEqual(res.untraceable, ["jobs"], "said out loud, not hidden");
  const a = await one("SELECT payload FROM project_audit_log WHERE project_id = ? AND action = 'project.delete.resume'", [id]);
  assert.deepEqual(JSON.parse(a.payload), { remaining_partial: [], untraceable: ["jobs"] });
  const g = await one("SELECT details FROM audit_log WHERE event_type = 'project.delete.resume' AND details LIKE ?", [`%"project_id":${id},%`]);
  assert.deepEqual(JSON.parse(g.details).untraceable, ["jobs"]);
  assert.equal((await one("SELECT status FROM bot_jobs WHERE job_id = ?", [`j-${id}`])).status, "queued", "a job is never invented");

  // Not owed again: a later finish finds nothing left.
  assert.deepEqual(await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete }), { ok: false, code: "not_partial" });

  // The projects list banner after a real finish says it, in both languages.
  const ui = await import("../servers/gateway/dashboard/shared/project-lifecycle-ui.js");
  const other = await joblessProject("Lost Jobs Two");
  const redirects = [];
  const out = await ui.handleLifecyclePost(
    { body: { action: "resume_project_delete", id: String(other.id) }, method: "POST" },
    { redirectAfterPost: (u) => redirects.push(u) },
    { db, lang: "en", layout: () => "", projectId: other.id, urls: { post: "/dashboard/projects", confirm: (x) => `/dashboard/projects?delete=${other.id}&${x}` }, forbiddenHtml: "" },
  );
  assert.deepEqual(out, {});
  const query = Object.fromEntries(new URL(redirects[0], "http://x").searchParams);
  assert.equal(query.untraceable, "jobs");
  assert.match(ui.resultBannerHtml(query, "en"), /Finished\. Queued bot jobs of this project could no longer be found to cancel; any still queued will stop when they run\./);
  assert.match(ui.resultBannerHtml(query, "es"), /Terminado\. Ya no se pudieron encontrar los trabajos de bot en cola de este proyecto para cancelarlos; los que sigan en cola se detendrán al ejecutarse\./);
  assert.equal((await one("SELECT status FROM bot_jobs WHERE job_id = ?", [other.job])).status, "queued");
});

test("a finish with nothing left says so", async () => {
  const ui = await import("../servers/gateway/dashboard/shared/project-lifecycle-ui.js");
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const id = await mk("Nothing Left");
  await seed(id);
  assert.equal((await del(id, "Nothing Left")).ok, true);

  // A real finish of an already finished delete: refused with not_partial, and the projects
  // list page says why instead of showing nothing.
  const redirects = [];
  const out = await ui.handleLifecyclePost(
    { body: { action: "resume_project_delete", id: String(id) }, method: "POST" },
    { redirectAfterPost: (u) => redirects.push(u) },
    { db, lang: "en", layout: () => "", projectId: id, urls: { post: "/dashboard/projects", confirm: (x) => `/dashboard/projects?delete=${id}&${x}` }, forbiddenHtml: "" },
  );
  assert.deepEqual(out, {});
  const query = Object.fromEntries(new URL(redirects[0], "http://x").searchParams);
  assert.equal(query.error, "not_partial");
  const banner = ui.resultBannerHtml(query, "en");
  assert.match(banner, /There is nothing left to finish for that project\./);
  assert.match(banner, /role="alert"/);
  assert.match(ui.resultBannerHtml(query, "es"), /No queda nada por terminar en ese proyecto\./);

  // The other codes: the owner refusal, and the generic failure text for anything else.
  assert.match(ui.resultBannerHtml({ error: "not_owner", resume: "1" }, "en"), /Only the project's owner can finish deleting it\./);
  assert.match(ui.resultBannerHtml({ error: "not_owner", resume: "1" }, "es"), /Solo el propietario del proyecto puede terminar de eliminarlo\./);
  assert.ok(ui.resultBannerHtml({ error: "bad_actor", resume: "1" }, "en").includes(t("projLife.failed", "en")));
  assert.match(ui.resultBannerHtml({ error: "bad_actor", resume: "1" }, "es"), /Algo salió mal, así que no se eliminó el proyecto\./);
  // The panel's own ?error= codes are untouched: no misleading delete banner.
  assert.equal(ui.resultBannerHtml({ error: "name_required" }, "en"), "");
});

test("a hostile audit uuid cannot move the workspace outside deleted-projects", async () => {
  const id = await mk("Hostile");
  const p = await seed(id);
  // A delete whose workspace step failed: a data dir that is not this instance's leaves it in place.
  const r = await del(id, "Hostile", { dataDir: join(DATA, "not-this-instance") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.partial, ["workspace"]);

  // The audit entry is text a caller could have written: it never names the destination folder.
  await forgeAuditUuid(id, "../../escape");
  const res = await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.partial, []);
  assert.deepEqual(readdirSync(dir).filter((d) => d.startsWith("escape")), [], "nothing was created outside deleted-projects");
  const moved = readdirSync(join(DATA, "deleted-projects")).filter((d) => d.startsWith(p.uuid));
  assert.equal(moved.length, 1, "named from the row's uuid");
  assert.equal(readFileSync(join(DATA, "deleted-projects", moved[0], "readme.txt"), "utf8"), "hello");

  // A row with no uuid of its own falls back to the audit's only when that is uuid-shaped.
  const id2 = await mk("Hostile Two");
  const p2 = await seed(id2);
  assert.deepEqual((await del(id2, "Hostile Two", { dataDir: join(DATA, "not-this-instance") })).partial, ["workspace"]);
  await forgeAuditUuid(id2, "../../escape-two");
  assert.deepEqual(await L.resumeProjectDelete(withoutTombUuid(db), id2, { storageDelete: recorder().storageDelete }), { ok: false, code: "not_partial" });
  assert.deepEqual(readdirSync(dir).filter((d) => d.startsWith("escape")), []);
  assert.equal(readFileSync(join(p2.workspace_dir, "readme.txt"), "utf8"), "hello", "left in place");
  assert.equal(await n("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'project.delete.resume' AND details LIKE ?", [`%"project_id":${id2},%`]), 0, "a refusal writes nothing");

  // A uuid-shaped audit uuid is used when the row has none.
  const good = "01234567-89ab-cdef-0123-456789abcdef";
  await forgeAuditUuid(id2, good);
  const res2 = await L.resumeProjectDelete(withoutTombUuid(db), id2, { storageDelete: recorder().storageDelete });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(readdirSync(join(DATA, "deleted-projects")).filter((d) => d.startsWith(good)).length, 1, "named from the audit uuid it had to fall back to");
  assert.equal(existsSync(p2.workspace_dir), false);
});

test("finishing twice does nothing the second time", async () => {
  const id = await mk("Twice");
  await seed(id);
  const r = await del(id, "Twice", { storageDelete: flakyStorage() });
  assert.deepEqual(r.partial, ["files"]);
  const first = await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.partial, []);

  const snap = async () => ({
    ps: { ...(await proj(id)) },
    files: await n("SELECT COUNT(*) AS n FROM storage_files WHERE project_id = ?", [id]),
    resumésCount: await n("SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = ? AND action = 'project.delete.resume'", [id]),
    auditRows: await n("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'project.delete.resume' AND details LIKE ?", [`%"project_id":${id},%`]),
  });
  const before = await snap();
  assert.equal(before.resumésCount, 1);
  assert.deepEqual(await L.resumeProjectDelete(db, id, { storageDelete: recorder().storageDelete }), { ok: false, code: "not_partial" });
  assert.deepEqual(await snap(), before, "nothing changed");
});
