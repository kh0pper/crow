/**
 * A project's `status` changes only for its owner, on all three paths.
 *
 * `status='archived'` hides a project, so a status change is a soft delete and takes delete's
 * owner rule (`canOwnProject`). Three writers used to call updateProjectSpaceMeta directly with
 * no ACL: the MCP tool crow_update_project, the projects panel's update_status action, and
 * POST /dashboard/bot-board-api/project/:id. Each must refuse a project this instance does not
 * own (visited, clone-shared, tombstoned, missing) with `not_owner` and write nothing.
 *
 * Fixtures are a REAL scripts/init-db.js database (the real role CHECK and partial unique
 * indexes) — the same idiom as tests/c2c-live-member-guard.test.js; the panel is driven through
 * its own handler and the card API through an ephemeral express server, like
 * tests/board-archive.test.js. A field other than status (a name) keeps today's behaviour:
 * those tests pin what happens NOW, they do not endorse it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";

const REPO = join(import.meta.dirname, "..");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// bot-board-api reads TASKS_DB once at import time; the env must point somewhere scratchy first.
const bootDir = mkdtempSync(join(tmpdir(), "project-status-acl-env-"));
dirs.push(bootDir);
process.env.CROW_DB_PATH = join(bootDir, "crow.db");
process.env.CROW_TASKS_DB_PATH = join(bootDir, "tasks.db");

/** A fresh init-db'd crow.db. `createDbClient()` (used by the API route) reads the env per call. */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "project-status-acl-"));
  dirs.push(dir);
  const dbPath = join(dir, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_HOME: join(dir, ".crow") },
    stdio: "pipe",
    cwd: REPO,
  });
  // The express routes open their own client: keep the env pointed at THIS test's database.
  process.env.CROW_DB_PATH = dbPath;
  const db = createDbClient(dbPath);
  return { dir, dbPath, db, close() { try { db.close(); } catch { /* already closed */ } } };
}

let seq = 0;

/** A project plus the local user's membership row in `role` ('owner' = its owner). */
async function newProject(s, { role = "owner", status = "active" } = {}) {
  const r = await s.db.execute({
    sql: "INSERT INTO project_spaces (slug, name, type, status) VALUES (?, ?, 'general', ?)",
    args: [`status-acl-${++seq}`, `Status ACL ${seq}`, status],
  });
  const id = Number(r.lastInsertRowid);
  await s.db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, ?)",
    args: [id, role],
  });
  return id;
}

async function rowOf(s, id) {
  const { rows } = await s.db.execute({
    sql: "SELECT name, status, archived_at FROM project_spaces WHERE id = ?", args: [id],
  });
  return rows[0] ?? null;
}

async function auditsOf(s, id) {
  const { rows } = await s.db.execute({
    sql: "SELECT actor_type, actor_id, action, payload FROM project_audit_log WHERE project_id = ? ORDER BY id",
    args: [id],
  });
  return rows;
}

const REFUSAL = /Only the owner can change/;

/* --------------------------------------------------------------------- the helper */

test("assertCanChangeStatus: owner passes; a visited, missing or tombstoned project is not_owner", async () => {
  const s = fresh();
  try {
    const { assertCanChangeStatus } = await import("../servers/shared/project-lifecycle.js");
    const { AclError } = await import("../servers/shared/project-acl.js");

    const owned = await newProject(s, { role: "owner" });
    await assert.doesNotReject(assertCanChangeStatus(s.db, owned), "the owner may change the status");

    const visited = await newProject(s, { role: "editor" });
    await assert.rejects(assertCanChangeStatus(s.db, visited), (err) => {
      assert.ok(err instanceof AclError, "an AclError, so callers answer it like a refused delete");
      assert.equal(err.code, "not_owner");
      return true;
    });

    await assert.rejects(assertCanChangeStatus(s.db, 999999), (err) => err.code === "not_owner",
      "a missing project is refused, never read as allowed");

    const tomb = await newProject(s, { role: "owner" });
    await s.db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [tomb] });
    await assert.rejects(assertCanChangeStatus(s.db, tomb), (err) => err.code === "not_owner",
      "a tombstone is deleted, not merely archived");
  } finally { s.close(); }
});

/* ------------------------------------------------------- crow_update_project (MCP) */

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { createProjectServer } = await import("../servers/research/server.js");
const { OWNER } = await import("../servers/research/actor.js");

async function researchClient(dbPath, base = OWNER) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createProjectServer(dbPath, { actor: base });
  await server.connect(st);
  const client = new Client({ name: "status-acl", version: "0" });
  await client.connect(ct);
  return client;
}

const textOf = (r) => (r.content || []).map((c) => c.text).join("\n");
const updateProject = (client, args) => client.callTool({ name: "crow_update_project", arguments: args });

test("crow_update_project: the owner's status change is written, with a status_changed audit row", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const id = await newProject(s, { status: "active" });
    const r = await updateProject(client, { id, status: "paused" });
    assert.ok(!r.isError, textOf(r));
    assert.equal((await rowOf(s, id)).status, "paused");

    const audits = await auditsOf(s, id);
    assert.equal(audits.length, 1, "exactly one audit row");
    assert.equal(audits[0].action, "status_changed");
    assert.equal(audits[0].actor_type, "local", "the owner is recorded as the local user");
    assert.deepEqual(JSON.parse(audits[0].payload), { from: "active", to: "paused" });
  } finally { await client.close(); s.close(); }
});

test("crow_update_project: a visited project's status is refused and nothing is written", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const id = await newProject(s, { role: "editor", status: "active" });
    const r = await updateProject(client, { id, status: "archived" });
    assert.equal(r.isError, true, "the tool refuses");
    assert.match(textOf(r), REFUSAL);
    assert.equal((await rowOf(s, id)).status, "active", "the status is unchanged");
    assert.deepEqual(await auditsOf(s, id), [], "a refusal writes no audit row");
  } finally { await client.close(); s.close(); }
});

test("crow_update_project: a missing project's status change is refused", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const r = await updateProject(client, { id: 999999, status: "archived" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), REFUSAL);
    assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM project_spaces")).rows[0].n, 0);
  } finally { await client.close(); s.close(); }
});

test("crow_update_project: a name-only patch on a visited project behaves as before", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const id = await newProject(s, { role: "editor" });
    const r = await updateProject(client, { id, name: "Renamed by a peer" });
    assert.ok(!r.isError, textOf(r));
    assert.equal((await rowOf(s, id)).name, "Renamed by a peer", "pinned: a name still writes (the gap this PR does not widen)");
    assert.equal((await rowOf(s, id)).status, "active");
    assert.deepEqual(await auditsOf(s, id), [], "no status audit for a name change");
  } finally { await client.close(); s.close(); }
});

/* ---------------------------------------------------------- the projects panel */

const panel = (await import("../servers/gateway/dashboard/panels/projects.js")).default;

/** Drive the panel's POST branch exactly as the dashboard dispatcher does. */
async function postPanel(db, body) {
  const out = { redirect: null };
  const res = { redirectAfterPost(url) { out.redirect = url; } };
  await panel.handler({ method: "POST", body, query: {}, headers: {} }, res, {
    db, layout: ({ content }) => content, lang: "en",
  });
  return out;
}

/** Render the page a redirect lands on. */
async function renderPanel(db, query, lang = "en") {
  const res = { redirectAfterPost(url) { throw new Error(`GET must not redirect (${url})`); } };
  return panel.handler({ method: "GET", body: {}, query, headers: {} }, res, {
    db, layout: ({ content }) => content, lang,
  });
}

test("panel update_status: the owner's change is written, with a status_changed audit row", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { status: "active" });
    const out = await postPanel(s.db, { action: "update_status", id: String(id), status: "completed" });
    assert.equal(out.redirect, `/dashboard/projects?view=${id}`);
    assert.equal((await rowOf(s, id)).status, "completed");

    const audits = await auditsOf(s, id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "status_changed");
    assert.equal(audits[0].actor_type, "local", "the panel's operator is the local user");
    assert.deepEqual(JSON.parse(audits[0].payload), { from: "active", to: "completed" });
  } finally { s.close(); }
});

test("panel update_status: a visited project is refused with error=not_owner and nothing is written", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { role: "editor", status: "active" });
    const out = await postPanel(s.db, { action: "update_status", id: String(id), status: "archived" });
    assert.equal(out.redirect, `/dashboard/projects?view=${id}&error=not_owner`);
    assert.equal((await rowOf(s, id)).status, "active");
    assert.deepEqual(await auditsOf(s, id), []);
  } finally { s.close(); }
});

test("panel update_status: a missing project is refused with not_owner", async () => {
  const s = fresh();
  try {
    const out = await postPanel(s.db, { action: "update_status", id: "999999", status: "archived" });
    assert.equal(out.redirect, "/dashboard/projects?view=999999&error=not_owner");
    assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM project_spaces")).rows[0].n, 0);
  } finally { s.close(); }
});

test("panel: the refusal reaches the page in both languages", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { role: "editor" });
    const en = await renderPanel(s.db, { view: String(id), error: "not_owner" }, "en");
    assert.match(en, /Only this project's owner can change its status\./);
    const es = await renderPanel(s.db, { view: String(id), error: "not_owner" }, "es");
    assert.match(es, /Solo el propietario de este proyecto puede cambiar su estado\./);
    // Without the code the page says nothing about it.
    assert.doesNotMatch(await renderPanel(s.db, { view: String(id) }, "en"), /change its status\./);
  } finally { s.close(); }
});

test("panel update: a name-only edit on a visited project behaves as before", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { role: "editor" });
    const out = await postPanel(s.db, { action: "update", id: String(id), name: "Peer renamed", description: "", tags: "" });
    assert.equal(out.redirect, `/dashboard/projects?view=${id}`);
    assert.equal((await rowOf(s, id)).name, "Peer renamed", "pinned: a name still writes (the gap this PR does not widen)");
    assert.equal((await rowOf(s, id)).status, "active");
    assert.deepEqual(await auditsOf(s, id), []);
  } finally { s.close(); }
});

/* ------------------------------------------- POST /dashboard/bot-board-api/project/:id */

let server, apiBase;
before(async () => {
  const { default: express } = await import("express");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, r); });
  apiBase = `http://127.0.0.1:${server.address().port}/dashboard/bot-board-api`;
});
after(() => { if (server) server.close(); });

function postApi(path, body) {
  return fetch(apiBase + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /project/:id: the owner's status change is written, with a status_changed audit row", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { status: "active" });
    const r = await postApi(`/project/${id}`, { status: "paused" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await rowOf(s, id)).status, "paused");

    const audits = await auditsOf(s, id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "status_changed");
    assert.deepEqual(JSON.parse(audits[0].payload), { from: "active", to: "paused" });
  } finally { s.close(); }
});

test("POST /project/:id: a visited project's status is 403 not_owner and nothing is written", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { role: "editor", status: "active" });
    const r = await postApi(`/project/${id}`, { status: "archived" });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "not_owner" });
    assert.equal((await rowOf(s, id)).status, "active");
    assert.deepEqual(await auditsOf(s, id), []);
  } finally { s.close(); }
});

test("POST /project/:id: a tombstoned project's status is 403 not_owner", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { status: "archived" });
    await s.db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [id] });
    const r = await postApi(`/project/${id}`, { status: "active" });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "not_owner" });
    assert.equal((await rowOf(s, id)).status, "archived", "the tombstone is untouched");
  } finally { s.close(); }
});

test("POST /project/:id: a missing project keeps its existing 404 and nothing is written", async () => {
  const s = fresh();
  try {
    const r = await postApi("/project/999999", { status: "archived" });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "project not found" });
    assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM project_spaces")).rows[0].n, 0);
  } finally { s.close(); }
});

test("POST /project/:id: a name-only patch on a visited project behaves as before", async () => {
  const s = fresh();
  try {
    const id = await newProject(s, { role: "editor" });
    const r = await postApi(`/project/${id}`, { name: "Renamed by the board" });
    assert.equal(r.status, 200);
    assert.equal((await rowOf(s, id)).name, "Renamed by the board", "pinned: a name still writes (the gap this PR does not widen)");
    assert.equal((await rowOf(s, id)).status, "active");
    assert.deepEqual(await auditsOf(s, id), []);
  } finally { s.close(); }
});

/* ------------------------------------------------------------------ the static guard */

// A handler starts at one of the three writer shapes. Everything after it, up to the next start,
// is that handler's text — enough for a textual guard, and honest about being one.
const HANDLER_START = /^[ \t]*(?:server\.tool\(|router\.(?:post|put|patch)\(|if \(action === )/;

function handlers(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (HANDLER_START.test(line)) {
      if (cur) out.push(cur);
      cur = { label: "", text: `${line}\n` };
    } else if (cur) cur.text += `${line}\n`;
  }
  if (cur) out.push(cur);
  // The label names the handler well enough to find it: the start line and the two after it (a
  // server.tool's name is on the second line).
  return out.map((h) => ({ ...h, label: h.text.split("\n").slice(0, 3).join(" ").trim().slice(0, 160) }));
}

/**
 * Every handler whose updateProjectSpaceMeta patch can carry `status` must call
 * assertCanChangeStatus first. A patch that cannot carry a status (a name-only edit) needs no
 * guard, so the check keys on `status` appearing BEFORE the call. Returns the violations and the
 * guarded handler labels, so a test can prove the scan is not vacuous. A written guard, not a
 * substitute for the per-path tests above: a status set through a helper the block does not show
 * would slip past it.
 */
function scanSource(text, name = "source") {
  const violations = [];
  const guarded = [];
  for (const h of handlers(text)) {
    const call = h.text.indexOf("updateProjectSpaceMeta(");
    if (call === -1) continue;
    const before = h.text.slice(0, call);
    if (!/\bstatus\b/.test(before)) continue;
    if (before.includes("assertCanChangeStatus(")) guarded.push(`${name}: ${h.label}`);
    else violations.push(`${name}: ${h.label} can write a status with no assertCanChangeStatus before it`);
  }
  return { violations, guarded };
}

const GUARDED = [
  ["servers/research/server.js", '"crow_update_project"'],
  ["servers/gateway/dashboard/panels/projects.js", '"update_status"'],
  ["servers/gateway/routes/bot-board-api.js", '"/project/:id"'],
];

test("the static guard: every status-writing handler checks the owner rule first", () => {
  for (const [path, expected] of GUARDED) {
    const { violations, guarded } = scanSource(readFileSync(join(REPO, path), "utf8"), path);
    assert.deepEqual(violations, [], `${path} must guard every status write`);
    assert.ok(guarded.some((g) => g.includes(expected)), `${path}: the scan must see the ${expected} handler (otherwise it proves nothing)`);
  }
});

test("the static guard's positive control: a plant that writes a status unguarded is flagged", () => {
  const PLANT = `
router.post("/plant/:id", async (req, res) => {
  const patch = {};
  if (req.body.status) patch.status = String(req.body.status);
  await updateProjectSpaceMeta(db, Number(req.params.id), patch);
  return res.json({ ok: true });
});
`;
  const { violations, guarded } = scanSource(PLANT, "plant.js");
  assert.equal(violations.length, 1, "the plant must be flagged exactly once");
  assert.match(violations[0], /plant\.js/);
  assert.match(violations[0], /no assertCanChangeStatus/);
  assert.deepEqual(guarded, [], "an unguarded handler is never counted as guarded");

  // The same plant with the guard in place is accepted — so the scan keys on the guard, not the path.
  const fixed = PLANT.replace("await updateProjectSpaceMeta(", "await assertCanChangeStatus(db, Number(req.params.id));\n  await updateProjectSpaceMeta(");
  assert.deepEqual(scanSource(fixed, "plant.js").violations, []);
});