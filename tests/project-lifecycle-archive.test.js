import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { createProjectSpace } from "../servers/shared/project-spaces.js";
import { activeProjectWhere } from "../servers/shared/shell-items.js";
import { canOwnProject, archiveProject, restoreProject } from "../servers/shared/project-lifecycle.js";

const dir = mkdtempSync(join(tmpdir(), "crow-plc-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.CROW_DB_PATH = join(dir, "crow.db");
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
});
const db = createDbClient(join(dir, "crow.db"));

async function mk(name, opts = {}) {
  const r = await createProjectSpace(db, { name, ...opts });
  return Number(r.id ?? r.project?.id ?? r.projectId);
}
const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const live = async (id) => !!(await one(`SELECT 1 AS x FROM project_spaces ps WHERE ps.id = ? AND ${activeProjectWhere("ps")}`, [id]));

test("archive hides from activeProjectWhere and keeps bots' project_id", async () => {
  const id = await mk("Arch A");
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, project_id) VALUES ('b-arch', 'B', ?)", args: [id] });
  assert.ok(await live(id));
  assert.deepEqual(await archiveProject(db, id), { ok: true });
  assert.equal(await live(id), false);
  assert.equal(Number((await one("SELECT project_id FROM pi_bot_defs WHERE bot_id='b-arch'")).project_id), id);
  assert.equal((await archiveProject(db, id)).code, "already_archived");
});

test("restore brings it back", async () => {
  const id = await mk("Arch B");
  assert.equal((await restoreProject(db, id)).code, "not_archived");
  await archiveProject(db, id);
  assert.deepEqual(await restoreProject(db, id), { ok: true });
  assert.ok(await live(id));
});

test("archived_at never set by archive", async () => {
  const id = await mk("Arch C");
  await archiveProject(db, id);
  assert.equal((await one("SELECT archived_at FROM project_spaces WHERE id=?", [id])).archived_at, null);
  await restoreProject(db, id);
  assert.equal((await one("SELECT archived_at FROM project_spaces WHERE id=?", [id])).archived_at, null);
});

test("canOwnProject: owner yes, archived yes, deleted no, visited no, learner no, revoked no", async () => {
  const id = await mk("Own A");
  assert.equal(await canOwnProject(db, id), true);
  await archiveProject(db, id);
  assert.equal(await canOwnProject(db, id), true);
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id=?", args: [id] });
  assert.equal(await canOwnProject(db, id), false, "deleted");

  const visited = await mk("Visited", { ownerMember: false });
  assert.equal(await canOwnProject(db, visited), false, "no local owner row");

  const learner = await mk("Learner", { type: "learner_profile" });
  await db.execute({ sql: "INSERT OR IGNORE INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')", args: [learner] });
  assert.equal(await canOwnProject(db, learner), false, "learner");

  const rev = await mk("Revoked");
  await db.execute({ sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE project_id=? AND contact_id IS NULL", args: [rev] });
  assert.equal(await canOwnProject(db, rev), false, "revoked");
  assert.equal(await canOwnProject(db, 999999), false);
  assert.equal((await archiveProject(db, rev)).code, "not_owner");
  assert.equal((await restoreProject(db, rev)).code, "not_owner");
});

test("audit rows", async () => {
  const id = await mk("Audit");
  await archiveProject(db, id, { actor: "system" });
  await restoreProject(db, id);
  const { rows } = await db.execute({ sql: "SELECT action, actor_type FROM project_audit_log WHERE project_id=? AND action LIKE 'project.%' ORDER BY id", args: [id] });
  assert.deepEqual(rows.map((r) => [r.action, r.actor_type]), [["project.archive", "system"], ["project.restore", "local"]]);
});
