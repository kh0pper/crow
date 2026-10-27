// The shell-items service: filing a Perch thread, artifact or Workspace file under a project,
// linking documents to cards, and listing refs by scope.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../servers/db.js";
import { createProjectSpace } from "../servers/shared/project-spaces.js";
import {
  ITEM_KINDS, getItem, threadCard, setItemProject, ensureItem, setItemCard, markSeen,
  listItemRefs, itemsForCard, activeProjects, parseScope, activeProjectWhere, ACTIVE_PROJECT_WHERE,
} from "../servers/shared/shell-items.js";

const dirs = [];
const clients = [];
const savedEnv = { CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const c of clients) { try { c.close(); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fresh({ initDb = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shell-svc-"));
  dirs.push(dir);
  const env = { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") };
  if (initDb) execFileSync(process.execPath, ["scripts/init-db.js"], { env, stdio: "pipe" });
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_DB_PATH = env.CROW_DB_PATH;
  const db = createDbClient(env.CROW_DB_PATH);
  clients.push(db);
  return db;
}

const auditRows = async (db, action) =>
  (await db.execute({ sql: "SELECT * FROM project_audit_log WHERE action = ?", args: [action] })).rows;

test("ITEM_KINDS lists the three kinds", () => {
  assert.deepEqual(ITEM_KINDS, ["perch_thread", "artifact", "workspace_file"]);
});

test("activeProjectWhere prefixes each column with an alias, and the bare form is the constant", () => {
  assert.equal(activeProjectWhere(), ACTIVE_PROJECT_WHERE);
  const q = activeProjectWhere("p");
  assert.match(q, /p\.archived_at IS NULL AND p\.status != 'archived' AND \(p\.type IS NULL OR p\.type != 'learner_profile'\)/);
});

test("activeProjectWhere rejects an alias that is not a plain identifier", () => {
  for (const bad of ["p; DROP TABLE x", "a.b", "1p", "p q", "p'"]) assert.throws(() => activeProjectWhere(bad), /bad SQL alias/);
  assert.doesNotThrow(() => activeProjectWhere("_ps2"));
});

test("activeProjects is empty when project_spaces does not exist", async () => {
  const db = fresh({ initDb: false });
  assert.deepEqual(await activeProjects(db), []);
});

test("setItemProject files an item and audits it", async () => {
  const db = fresh();
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  const r = await setItemProject(db, "artifact", "art_x", p1.id);
  assert.deepEqual(r, { projectId: p1.id });
  const it = await getItem(db, "artifact", "art_x");
  assert.equal(it.projectId, p1.id);
  assert.equal(it.setBy, "operator");
  assert.equal(it.kind, "artifact");
  assert.equal(it.ref, "art_x");
  assert.equal(it.cardId, null);
  const rows = await auditRows(db, "item_filed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "artifact:art_x");
  assert.equal(rows[0].actor_type, "local");
});

test("setItemProject to null unfiles without an audit row", async () => {
  const db = fresh();
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  await setItemProject(db, "artifact", "art_x", p1.id);
  await setItemProject(db, "artifact", "art_x", null);
  assert.equal((await getItem(db, "artifact", "art_x")).projectId, null);
  assert.equal((await auditRows(db, "item_filed")).length, 1);
});

test("setItemProject refuses an unknown or archived project", async () => {
  const db = fresh();
  await assert.rejects(setItemProject(db, "artifact", "art_x", 9999), { code: "not_found" });
  const p = await createProjectSpace(db, { name: "Old" });
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [p.id] });
  await assert.rejects(setItemProject(db, "artifact", "art_x", p.id), { code: "archived" });
});

test("setItemProject refuses a bad kind", async () => {
  const db = fresh();
  await assert.rejects(setItemProject(db, "nope", "x", null), { code: "bad_kind" });
});

test("ensureItem never changes an existing row", async () => {
  const db = fresh();
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  const p2 = await createProjectSpace(db, { name: "Beta" });
  await setItemProject(db, "artifact", "art_x", p1.id);
  await ensureItem(db, "artifact", "art_x", { projectId: p2.id, cardId: 5 });
  const it = await getItem(db, "artifact", "art_x");
  assert.equal(it.projectId, p1.id);
  assert.equal(it.setBy, "operator");
  assert.equal(it.cardId, null);
  await ensureItem(db, "artifact", "art_new", { projectId: p2.id });
  const n = await getItem(db, "artifact", "art_new");
  assert.equal(n.projectId, p2.id);
  assert.equal(n.setBy, "origin");
});

test("listItemRefs treats a missing project as unassigned", async () => {
  const db = fresh();
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  await setItemProject(db, "artifact", "art_a", p1.id);
  await ensureItem(db, "artifact", "art_b", { projectId: null });
  await db.execute({ sql: "DELETE FROM project_spaces WHERE id = ?", args: [p1.id] });
  const un = await listItemRefs(db, "artifact", { unassigned: true });
  assert.ok(un.includes("art_a") && un.includes("art_b"));
  assert.ok(!(await listItemRefs(db, "artifact", { projectId: p1.id })).includes("art_a"));
  assert.ok((await listItemRefs(db, "artifact", { all: true })).includes("art_a"));
});

test("listItemRefs treats an archived or learner project as unassigned", async () => {
  const db = fresh();
  const live = await createProjectSpace(db, { name: "Live" });
  const old = await createProjectSpace(db, { name: "Old" });
  const kid = await createProjectSpace(db, { name: "Kid", type: "learner_profile", ownerMember: false });
  await ensureItem(db, "workspace_file", "a.md", { projectId: live.id });
  await ensureItem(db, "workspace_file", "b.md", { projectId: old.id });
  await ensureItem(db, "workspace_file", "c.md", { projectId: kid.id });
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [old.id] });
  assert.deepEqual(await listItemRefs(db, "workspace_file", { projectId: live.id }), ["a.md"]);
  assert.deepEqual((await listItemRefs(db, "workspace_file", { unassigned: true })).sort(), ["b.md", "c.md"]);
  assert.equal((await listItemRefs(db, "workspace_file", { all: true })).length, 3);
});

test("listItemRefs works inside a join", async () => {
  const db = fresh();
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  await setItemProject(db, "artifact", "art_a", p1.id);
  // The caller's own query joins project_spaces too; the aliased predicate must stay unambiguous.
  const { rows } = await db.execute({
    sql: `SELECT s.item_ref FROM shell_items s JOIN project_spaces ps ON ps.id = s.project_id
          WHERE ${activeProjectWhere("ps")}`,
    args: [],
  });
  assert.deepEqual(rows.map((r) => r.item_ref), ["art_a"]);
  assert.deepEqual(await listItemRefs(db, "artifact", { projectId: p1.id }), ["art_a"]);
});

test("activeProjects lists live projects by name", async () => {
  const db = fresh();
  await createProjectSpace(db, { name: "Zed" });
  const b = await createProjectSpace(db, { name: "Bee" });
  const gone = await createProjectSpace(db, { name: "Gone" });
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [gone.id] });
  const list = await activeProjects(db);
  assert.deepEqual(list.map((p) => p.name), ["Bee", "Zed"]);
  assert.equal(list[0].id, b.id);
  assert.deepEqual(Object.keys(list[0]).sort(), ["id", "name", "slug"]);
});

test("parseScope", () => {
  assert.deepEqual(parseScope("7"), { projectId: 7 });
  assert.deepEqual(parseScope("unassigned"), { unassigned: true });
  assert.deepEqual(parseScope("all"), { all: true });
  for (const v of ["-1", "0", "x", "1.5", "", undefined]) assert.deepEqual(parseScope(v), { all: true });
});

test("itemsForCard lists the documents linked to a card", async () => {
  const db = fresh();
  await setItemCard(db, "artifact", "art_a", 3);
  await setItemCard(db, "workspace_file", "f.md", 3);
  await setItemCard(db, "artifact", "art_other", 4);
  const items = await itemsForCard(db, 3);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.ref}`).sort(), ["artifact:art_a", "workspace_file:f.md"]);
});

test("setItemCard keeps the project and can clear the card", async () => {
  const db = fresh();
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  await setItemProject(db, "artifact", "art_a", p1.id);
  await setItemCard(db, "artifact", "art_a", 8);
  let it = await getItem(db, "artifact", "art_a");
  assert.equal(it.cardId, 8);
  assert.equal(it.projectId, p1.id);
  await setItemCard(db, "artifact", "art_a", null);
  it = await getItem(db, "artifact", "art_a");
  assert.equal(it.cardId, null);
});

test("a thread's card comes from bot_sessions", async () => {
  const db = fresh();
  assert.equal(await threadCard(db, "perchlive-a"), null);
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, card_id, kind) VALUES ('b','perchlive-a',4,'perch-live')", args: [] });
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, card_id, kind) VALUES ('b','perchlive-a',9,'perch-live')", args: [] });
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, card_id, kind) VALUES ('b','perchlive-a',77,'chat')", args: [] });
  assert.equal(await threadCard(db, "perchlive-a"), 9);
  await assert.rejects(setItemCard(db, "perch_thread", "perchlive-a", 9), { code: "bad_kind" });
});

test("markSeen records the version, creating a row if needed", async () => {
  const db = fresh();
  await markSeen(db, "artifact", "art_a", 3);
  let it = await getItem(db, "artifact", "art_a");
  assert.equal(it.seenVersion, 3);
  assert.ok(it.seenAt);
  assert.equal(it.projectId, null);
  assert.equal(it.setBy, "origin");
  const p1 = await createProjectSpace(db, { name: "Alpha" });
  await setItemProject(db, "artifact", "art_a", p1.id);
  await markSeen(db, "artifact", "art_a", 4);
  it = await getItem(db, "artifact", "art_a");
  assert.equal(it.seenVersion, 4);
  assert.equal(it.projectId, p1.id);
});

test("no table yet: readers are empty, writers say not_migrated", async () => {
  const db = fresh();
  await db.execute({ sql: "DROP TABLE shell_items", args: [] });
  assert.equal(await getItem(db, "artifact", "a"), null);
  assert.deepEqual(await listItemRefs(db, "artifact", { all: true }), []);
  assert.deepEqual(await itemsForCard(db, 1), []);
  await assert.rejects(setItemProject(db, "artifact", "a", null), { code: "not_migrated", http: 503 });
  await assert.rejects(ensureItem(db, "artifact", "a", { projectId: null }), { code: "not_migrated" });
  await assert.rejects(setItemCard(db, "artifact", "a", 1), { code: "not_migrated" });
  await assert.rejects(markSeen(db, "artifact", "a", 1), { code: "not_migrated" });
});
