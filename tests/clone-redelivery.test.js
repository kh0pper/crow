/**
 * Tests for deliverPendingShares (W4-2 B).
 *
 * Uses a REAL scripts/init-db.js DB (better-sqlite3 wrapped in the execute()-shape
 * from tests/project-clone-apply.test.js) — the db is never faked.  Only
 * peerManager is faked so we can observe sends and inject failures.
 *
 * Six cases per spec B.5:
 *   (a) queued clone row + member row → send called with mode:"clone" + bundle + role/caps
 *   (b) member row revoked_at set → no send, row 'failed'
 *   (c) member row ABSENT → send with role 'viewer' / null caps
 *   (d) archived project → row 'failed', loop continues to next row
 *   (e) plain share row (mode NULL) → legacy tableMap path, send called
 *   (f) live-send-throws on clone → row stays 'pending'
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";
import { deliverPendingShares } from "../servers/sharing/boot.js";

// ---- temp DB setup ----
const dir = mkdtempSync(join(tmpdir(), "clone-redeliver-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const rawDb = new Database(join(dir, "crow.db"));
after(() => {
  rawDb.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- db wrapper (execute()-shape, mirrors project-clone-apply.test.js) ----
function wrapDb(bsDb) {
  function executeOne(sql, args = []) {
    const stmt = bsDb.prepare(sql);
    const a = Array.isArray(args) ? args : [args];
    if (stmt.reader) {
      const rows = stmt.all(...a);
      return { rows, columns: rows.length > 0 ? Object.keys(rows[0]) : [], rowsAffected: 0, lastInsertRowid: 0 };
    }
    const info = stmt.run(...a);
    return { rows: [], columns: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
  return {
    async execute(arg) {
      if (typeof arg === "string") return executeOne(arg, []);
      return executeOne(arg.sql, arg.args);
    },
    async batch(stmts) {
      const txn = bsDb.transaction((ss) => ss.map((s) => {
        if (typeof s === "string") return executeOne(s, []);
        return executeOne(s.sql, s.args);
      }));
      return txn(stmts);
    },
  };
}

const db = wrapDb(rawDb);

// ---- seed helpers ----

/** Insert a contact and return its id. */
async function seedContact(crowId = "test-crow-id") {
  const r = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey)
          VALUES (?, 'Test User', 'ed-pub-1', 'secp-pub-1')`,
    args: [crowId],
  });
  return Number(r.lastInsertRowid);
}

let _projectSeq = 0;
/** Insert a project_spaces row and return its id. */
async function seedProject(opts = {}) {
  const slug = opts.slug ?? `proj-${++_projectSeq}-${Date.now()}`;
  const r = await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, description, type, status, workspace_dir, storage_prefix)
          VALUES (?, ?, '', 'research', 'active', '/tmp/test-ws', 'test/')`,
    args: [slug, opts.name ?? "Test Project"],
  });
  const projectId = Number(r.lastInsertRowid);
  if (opts.archived) {
    await db.execute({
      sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?",
      args: [projectId],
    });
  }
  return projectId;
}

/** Insert a shared_items row and return its id. */
async function seedSharedItem(contactId, projectId, opts = {}) {
  const r = await db.execute({
    sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status, mode)
          VALUES (?, 'project', ?, 'read', 'sent', 'pending', ?)`,
    args: [contactId, projectId, opts.mode ?? null],
  });
  return Number(r.lastInsertRowid);
}

/** Insert a project_members row and return its id. */
async function seedMember(projectId, contactId, opts = {}) {
  const r = await db.execute({
    sql: `INSERT INTO project_members (project_id, contact_id, role, capabilities, mode, revoked_at)
          VALUES (?, ?, ?, ?, 'clone', ?)`,
    args: [projectId, contactId, opts.role ?? "editor", opts.capabilities ?? null, opts.revokedAt ?? null],
  });
  return Number(r.lastInsertRowid);
}

/** Insert a memories row and return its id (for plain-share test). */
async function seedMemory() {
  const r = await db.execute({
    sql: `INSERT INTO memories (category, content, importance) VALUES ('general', 'test memory', 5)`,
    args: [],
  });
  return Number(r.lastInsertRowid);
}

/** Read a shared_items row by id. */
async function getSharedItem(id) {
  return (await db.execute({ sql: "SELECT * FROM shared_items WHERE id = ?", args: [id] })).rows[0];
}

/** Fake peerManager — records sends and optionally throws. */
function makePeerManager({ shouldThrow = false } = {}) {
  const sends = [];
  return {
    sends,
    send(crowId, msg) {
      if (shouldThrow) throw new Error("send failed (test-injected)");
      sends.push({ crowId, msg });
    },
    isConnected() { return false; },
  };
}

// ---- (a) queued clone row + member row → send called with correct shape ----
test("(a) clone row with member row → send called with mode:clone + role + caps", async () => {
  const contactId = await seedContact("crow-a");
  const projectId = await seedProject({ name: "Project A" });
  const sharedItemId = await seedSharedItem(contactId, projectId, { mode: "clone" });
  await seedMember(projectId, contactId, { role: "editor", capabilities: '{"can_edit":true}' });

  const pm = makePeerManager();
  const bundleSentinel = { project: { id: projectId, name: "Project A" }, sources: [], notes: [], backends: [], file_manifest: [], audit_log: [] };
  const buildProjectCloneBundle = async () => bundleSentinel;

  await deliverPendingShares({
    db, peerManager: pm,
    contact: { id: contactId, crow_id: "crow-a" },
    identityCrowId: "self-crow",
    buildProjectCloneBundle,
  });

  assert.equal(pm.sends.length, 1, "one send expected");
  const msg = pm.sends[0].msg;
  assert.equal(msg.type, "share");
  assert.equal(msg.share_type, "project");
  assert.equal(msg.mode, "clone");
  assert.strictEqual(msg.payload, bundleSentinel);
  assert.equal(msg.role, "editor");
  assert.equal(msg.capabilities, '{"can_edit":true}');
  assert.equal(msg.sender, "self-crow");

  const row = await getSharedItem(sharedItemId);
  assert.equal(row.delivery_status, "delivered", "row should be delivered");
});

// ---- (b) member row with revoked_at set → no send, row 'failed' ----
test("(b) revoked member row → no send, row marked failed", async () => {
  const contactId = await seedContact("crow-b");
  const projectId = await seedProject({ name: "Project B" });
  const sharedItemId = await seedSharedItem(contactId, projectId, { mode: "clone" });
  await seedMember(projectId, contactId, { role: "editor", revokedAt: "2025-01-01T00:00:00Z" });

  const pm = makePeerManager();
  const buildProjectCloneBundle = async () => { throw new Error("should not be called"); };

  await deliverPendingShares({
    db, peerManager: pm,
    contact: { id: contactId, crow_id: "crow-b" },
    identityCrowId: "self-crow",
    buildProjectCloneBundle,
  });

  assert.equal(pm.sends.length, 0, "no send expected for revoked member");
  const row = await getSharedItem(sharedItemId);
  assert.equal(row.delivery_status, "failed", "row should be failed");
});

// ---- (c) member row ABSENT → send with role 'viewer' / null caps ----
test("(c) absent member row → send with viewer/null", async () => {
  const contactId = await seedContact("crow-c");
  const projectId = await seedProject({ name: "Project C" });
  const sharedItemId = await seedSharedItem(contactId, projectId, { mode: "clone" });
  // No project_members row inserted

  const pm = makePeerManager();
  const bundleSentinel = { project: { id: projectId }, sources: [], notes: [], backends: [], file_manifest: [], audit_log: [] };
  const buildProjectCloneBundle = async () => bundleSentinel;

  await deliverPendingShares({
    db, peerManager: pm,
    contact: { id: contactId, crow_id: "crow-c" },
    identityCrowId: "self-crow",
    buildProjectCloneBundle,
  });

  assert.equal(pm.sends.length, 1, "one send expected");
  const msg = pm.sends[0].msg;
  assert.equal(msg.role, "viewer");
  assert.equal(msg.capabilities, null);

  const row = await getSharedItem(sharedItemId);
  assert.equal(row.delivery_status, "delivered");
});

// ---- (d) archived project → row 'failed', loop continues to next row ----
test("(d) archived project → row failed, loop continues", async () => {
  const contactId = await seedContact("crow-d");
  const archivedProjectId = await seedProject({ name: "Archived D", archived: true });
  const liveProjectId = await seedProject({ name: "Live D" });

  const archivedItemId = await seedSharedItem(contactId, archivedProjectId, { mode: "clone" });
  const liveItemId = await seedSharedItem(contactId, liveProjectId, { mode: "clone" });
  await seedMember(liveProjectId, contactId, { role: "viewer" });

  const pm = makePeerManager();
  let buildCalls = 0;
  const buildProjectCloneBundle = async () => {
    buildCalls++;
    return { project: {}, sources: [], notes: [], backends: [], file_manifest: [], audit_log: [] };
  };

  await deliverPendingShares({
    db, peerManager: pm,
    contact: { id: contactId, crow_id: "crow-d" },
    identityCrowId: "self-crow",
    buildProjectCloneBundle,
  });

  const archivedRow = await getSharedItem(archivedItemId);
  assert.equal(archivedRow.delivery_status, "failed", "archived project row should be failed");

  const liveRow = await getSharedItem(liveItemId);
  assert.equal(liveRow.delivery_status, "delivered", "live project row should be delivered");

  assert.equal(pm.sends.length, 1, "only the live project gets sent");
  assert.equal(buildCalls, 1, "bundle built only for live project");
});

// ---- (e) plain share row (mode NULL) → legacy tableMap path, send called ----
test("(e) plain memory row → legacy tableMap path, send called", async () => {
  const contactId = await seedContact("crow-e");
  const memId = await seedMemory();

  // Insert a plain shared_items row (mode NULL, share_type='memory')
  const r = await db.execute({
    sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status, mode)
          VALUES (?, 'memory', ?, 'read', 'sent', 'pending', NULL)`,
    args: [contactId, memId],
  });
  const sharedItemId = Number(r.lastInsertRowid);

  const pm = makePeerManager();
  const buildProjectCloneBundle = async () => { throw new Error("should not be called"); };

  await deliverPendingShares({
    db, peerManager: pm,
    contact: { id: contactId, crow_id: "crow-e" },
    identityCrowId: "self-crow",
    buildProjectCloneBundle,
  });

  assert.equal(pm.sends.length, 1, "one send for the memory row");
  const msg = pm.sends[0].msg;
  assert.equal(msg.type, "share");
  assert.equal(msg.share_type, "memory");
  assert.ok(!("mode" in msg) || msg.mode === undefined, "plain rows don't carry mode");
  assert.equal(msg.payload.id, memId);

  const row = await getSharedItem(sharedItemId);
  assert.equal(row.delivery_status, "delivered");
});

// ---- (f) live-send-throws on clone → row stays 'pending' (S3 fix) ----
test("(f) send throws on clone → row stays pending", async () => {
  const contactId = await seedContact("crow-f");
  const projectId = await seedProject({ name: "Project F" });
  const sharedItemId = await seedSharedItem(contactId, projectId, { mode: "clone" });
  await seedMember(projectId, contactId, { role: "editor" });

  const pm = makePeerManager({ shouldThrow: true });
  const buildProjectCloneBundle = async () => ({
    project: { id: projectId }, sources: [], notes: [], backends: [], file_manifest: [], audit_log: [],
  });

  await deliverPendingShares({
    db, peerManager: pm,
    contact: { id: contactId, crow_id: "crow-f" },
    identityCrowId: "self-crow",
    buildProjectCloneBundle,
  });

  const row = await getSharedItem(sharedItemId);
  assert.equal(row.delivery_status, "pending", "throwing send must leave row pending");
});
