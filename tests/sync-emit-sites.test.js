/**
 * stdio-sync-outbox Task 5 — call-site sweep.
 *
 * Every existing sync-emit call site (servers/memory/server.js,
 * servers/gateway/dashboard/settings/registry.js, servers/shared/providers-db.js,
 * servers/gateway/dashboard/panels/skills.js, servers/sharing/message-sync.js,
 * servers/sharing/contact-sync.js, servers/sharing/group-sync.js,
 * servers/sharing/sync-conflict-resolve.js) now routes through emitOrQueue —
 * with syncManager null/absent, the mutation is durably QUEUED instead of
 * silently dropped. Plus the two in-gateway zero-emit writers that joined the
 * sweep: servers/gateway/dashboard/panels/memory.js (delete/edit) and
 * servers/sharing/boot.js (share-import inserts for memories/research_notes).
 *
 * The suite env sets CROW_DISABLE_INSTANCE_SYNC=1 — every test below must
 * override the eligibility gate via _setEligibilityForTest(() => true) or the
 * queue path silently drops and every assertion here goes vacuous.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMemoryServer } from "../servers/memory/server.js";
import { _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import memoryPanel from "../servers/gateway/dashboard/panels/memory.js";
import { initSharingRuntime } from "../servers/sharing/boot.js";
import { writeSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { setProviderSyncManager, upsertProvider, disableProvider } from "../servers/shared/providers-db.js";
import { __setEmitSinkForTest as __setContactSink, emitContactChange, emitContactDelete } from "../servers/sharing/contact-sync.js";
import { __setEmitSinkForTest as __setGroupSink, emitGroupUpsert, emitGroupDelete } from "../servers/sharing/group-sync.js";
import { __setEmitSinkForTest as __setMessageSink, emitMessageInsert } from "../servers/sharing/message-sync.js";
import { restoreConflict } from "../servers/sharing/sync-conflict-resolve.js";

// getOrCreateLocalInstanceId() (called internally by emitOrQueue) reads
// process.env.CROW_DATA_DIR directly — point it at a scratch dir for the
// whole file so it never touches the real ~/.crow instance-id file.
const instanceIdDir = mkdtempSync(join(tmpdir(), "crow-sync-sites-instanceid-"));
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = instanceIdDir;
process.env.CROW_SKIP_CONFIRM_GATES = "1"; // crow_delete_memory's confirm-token gate — irrelevant here

test.after(() => {
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(instanceIdDir, { recursive: true, force: true });
});

/** Build a fresh, fully-migrated scratch crow.db; returns {db, dbPath, dir, cleanup}. */
function freshDb(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-sync-sites-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);
  return { db, dbPath, dir, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function lastOutboxRow(db) {
  const { rows } = await db.execute(
    "SELECT table_name, op, row_json FROM sync_outbox ORDER BY id DESC LIMIT 1",
  );
  return rows[0] || null;
}

// ensureSyncTables (inside emitOrQueue) creates sync_outbox lazily — a site
// that hasn't been converted yet (RED phase) leaves the table entirely
// absent, not just empty. Treat "no such table" as 0 rather than erroring.
async function outboxCount(db) {
  try {
    const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return 0;
    throw err;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function waitForOutbox(db, minCount, tries = 25) {
  for (let i = 0; i < tries; i++) {
    if ((await outboxCount(db)) >= minCount) return;
    await tick();
  }
}

/* ═══════════════════════════════════════ servers/memory/server.js (6 sites) */

async function withMemoryServer(dbPath, fn) {
  const memServer = createMemoryServer(dbPath, {}); // no syncManager — absent
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await memServer.connect(serverTransport);
  const client = new Client({ name: "sync-emit-sites-test", version: "0" });
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("memory/server.js crow_store_memory (insert): syncManager absent → queued", async () => {
  const { db, dbPath, cleanup } = freshDb("mem-store");
  try {
    _setEligibilityForTest(() => true);
    await withMemoryServer(dbPath, async (client) => {
      await client.callTool({
        name: "crow_store_memory",
        arguments: { content: "site-5-store", category: "general", importance: 5 },
      });
    });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "insert");
    assert.equal(JSON.parse(row.row_json).content, "site-5-store");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("memory/server.js crow_update_memory (update): syncManager absent → queued", async () => {
  const { db, dbPath, cleanup } = freshDb("mem-update");
  try {
    _setEligibilityForTest(() => true);
    let id;
    await withMemoryServer(dbPath, async (client) => {
      const res = await client.callTool({
        name: "crow_store_memory",
        arguments: { content: "before-update", category: "general", importance: 5 },
      });
      id = Number(res.content[0].text.match(/id: (\d+)/)[1]);
      await waitForOutbox(db, 1);
      await client.callTool({
        name: "crow_update_memory",
        arguments: { id, content: "after-update" },
      });
    });
    await waitForOutbox(db, 2);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).content, "after-update");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("memory/server.js crow_delete_memory (delete): syncManager absent → queued", async () => {
  const { db, dbPath, cleanup } = freshDb("mem-delete");
  try {
    _setEligibilityForTest(() => true);
    let id;
    await withMemoryServer(dbPath, async (client) => {
      const res = await client.callTool({
        name: "crow_store_memory",
        arguments: { content: "to-delete", category: "general", importance: 5 },
      });
      id = Number(res.content[0].text.match(/id: (\d+)/)[1]);
      await waitForOutbox(db, 1);
      await client.callTool({ name: "crow_delete_memory", arguments: { id, confirm_token: "" } });
    });
    await waitForOutbox(db, 2);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "delete");
    assert.equal(JSON.parse(row.row_json).id, id);
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("memory/server.js crow_add_context_section (crow_context insert): syncManager absent → queued", async () => {
  const { db, dbPath, cleanup } = freshDb("ctx-add");
  try {
    _setEligibilityForTest(() => true);
    await withMemoryServer(dbPath, async (client) => {
      await client.callTool({
        name: "crow_add_context_section",
        arguments: { section_key: "custom_sec_5", section_title: "Custom", content: "hello" },
      });
    });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "crow_context");
    assert.equal(row.op, "insert");
    assert.equal(JSON.parse(row.row_json).section_key, "custom_sec_5");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("memory/server.js crow_update_context_section (crow_context update): syncManager absent → queued", async () => {
  const { db, dbPath, cleanup } = freshDb("ctx-update");
  try {
    _setEligibilityForTest(() => true);
    await withMemoryServer(dbPath, async (client) => {
      await client.callTool({
        name: "crow_add_context_section",
        arguments: { section_key: "custom_sec_6", section_title: "Custom", content: "hello" },
      });
      await waitForOutbox(db, 1);
      await client.callTool({
        name: "crow_update_context_section",
        arguments: { section_key: "custom_sec_6", content: "updated" },
      });
    });
    await waitForOutbox(db, 2);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "crow_context");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).content, "updated");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("memory/server.js crow_delete_context_section (crow_context delete): syncManager absent → queued", async () => {
  const { db, dbPath, cleanup } = freshDb("ctx-delete");
  try {
    _setEligibilityForTest(() => true);
    await withMemoryServer(dbPath, async (client) => {
      await client.callTool({
        name: "crow_add_context_section",
        arguments: { section_key: "custom_sec_7", section_title: "Custom", content: "hello" },
      });
      await waitForOutbox(db, 1);
      await client.callTool({
        name: "crow_delete_context_section",
        arguments: { section_key: "custom_sec_7" },
      });
    });
    await waitForOutbox(db, 2);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "crow_context");
    assert.equal(row.op, "delete");
    assert.equal(JSON.parse(row.row_json).section_key, "custom_sec_7");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

/* ═══════════════ servers/gateway/dashboard/settings/registry.js (1 site) */

test("settings/registry.js writeSetting (dashboard_settings update): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("registry-write");
  try {
    _setEligibilityForTest(() => true);
    await writeSetting(db, "unified_dashboard_enabled", "true");
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "dashboard_settings");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).key, "unified_dashboard_enabled");
    assert.equal(JSON.parse(row.row_json).value, "true");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

/* ═══════════════════════════ servers/shared/providers-db.js (2 sites) */

const SYNCABLE_BASE_URL = "http://10.0.0.99:8080";

test("providers-db.js upsertProvider (insert): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("prov-insert");
  try {
    setProviderSyncManager(null);
    _setEligibilityForTest(() => true);
    await upsertProvider(db, { id: "site5-prov", baseUrl: SYNCABLE_BASE_URL, host: "remote", models: [] });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "providers");
    assert.equal(row.op, "insert");
    assert.equal(JSON.parse(row.row_json).id, "site5-prov");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("providers-db.js disableProvider (update): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("prov-disable");
  try {
    setProviderSyncManager(null);
    _setEligibilityForTest(() => true);
    await upsertProvider(db, { id: "site5-prov-d", baseUrl: SYNCABLE_BASE_URL, host: "remote", models: [] });
    await waitForOutbox(db, 1);
    await disableProvider(db, "site5-prov-d");
    await waitForOutbox(db, 2);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "providers");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).id, "site5-prov-d");
    assert.equal(Number(JSON.parse(row.row_json).disabled), 1);
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

/* ═════════════════════ servers/gateway/dashboard/panels/skills.js (2 sites) */

test("skills.js panel save-writing-rules (crow_context update): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("skills-writing");
  try {
    // init-db.js seeds the default "writing_style" global crow_context row —
    // no manual seed needed (and would UNIQUE-collide with it).
    _setEligibilityForTest(() => true);
    const skillsPanel = (await import("../servers/gateway/dashboard/panels/skills.js")).default;
    const res = { redirectAfterPost: (u) => ({ redirect: u }) };
    await skillsPanel.handler(
      { method: "POST", body: { action: "save-writing-rules", content: "new writing rules" } },
      res,
      { db, lang: "en" },
    );
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "crow_context");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).section_key, "writing_style");
    assert.equal(JSON.parse(row.row_json).content, "new writing rules");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("skills.js panel save-context-section (crow_context update): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("skills-ctx");
  try {
    // init-db.js seeds the default "identity" global crow_context row —
    // no manual seed needed.
    _setEligibilityForTest(() => true);
    const skillsPanel = (await import("../servers/gateway/dashboard/panels/skills.js")).default;
    const res = { redirectAfterPost: (u) => ({ redirect: u }) };
    await skillsPanel.handler(
      { method: "POST", body: { action: "save-context-section", sectionKey: "identity", content: "new identity content" } },
      res,
      { db, lang: "en" },
    );
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "crow_context");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).section_key, "identity");
    assert.equal(JSON.parse(row.row_json).content, "new identity content");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

/* ═══════════════════════════ servers/sharing/message-sync.js (1 site) */

test("message-sync.js emitMessageInsert (insert): sink absent → queued", async () => {
  const { db, cleanup } = freshDb("msg-insert");
  try {
    const SECP = "a".repeat(64);
    await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (1,'crow:site5m','', ?)", args: [SECP] });
    await db.execute({ sql: "INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read) VALUES (1, 1, 'ev-site5', 'hi', 'sent', 1)" });
    __setMessageSink(null);
    _setEligibilityForTest(() => true);
    await emitMessageInsert(db, { contactId: 1, nostrEventId: "ev-site5" });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "messages");
    assert.equal(row.op, "insert");
    assert.equal(JSON.parse(row.row_json).nostr_event_id, "ev-site5");
  } finally {
    _setEligibilityForTest(null);
    __setMessageSink(null);
    cleanup();
  }
});

/* ═══════════════════════════ servers/sharing/contact-sync.js (2 sites) */

test("contact-sync.js emitContactChange (insert): sink absent → queued", async () => {
  // emitContactChange has no db param — it sources one from the shared
  // managers singleton in production (never booted by this test process), so
  // drive the SAME fallback branch deterministically via the test seam's
  // second arg (__setEmitSinkForTest(sink, db)) rather than depending on the
  // real singleton, which is process-global and would leak into other tests.
  const { db, cleanup } = freshDb("contact-change-insert");
  try {
    __setContactSink(null, db);
    _setEligibilityForTest(() => true);
    await emitContactChange("insert", { crow_id: "crow:site5c" });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "contacts");
    assert.equal(row.op, "insert");
    assert.equal(JSON.parse(row.row_json).crow_id, "crow:site5c");
  } finally {
    _setEligibilityForTest(null);
    __setContactSink(null);
    cleanup();
  }
});

test("contact-sync.js emitContactDelete (delete): sink absent → queued", async () => {
  const { db, cleanup } = freshDb("contact-delete");
  try {
    await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (1,'crow:site5d','', ?)", args: ["a".repeat(64)] });
    __setContactSink(null);
    _setEligibilityForTest(() => true);
    await emitContactDelete(db, "crow:site5d", 7);
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "contacts");
    assert.equal(row.op, "delete");
    assert.equal(JSON.parse(row.row_json).crow_id, "crow:site5d");
  } finally {
    _setEligibilityForTest(null);
    __setContactSink(null);
    cleanup();
  }
});

/* ═══════════════════════════ servers/sharing/group-sync.js (2 sites) */

test("group-sync.js emitGroupUpsert (update): sink absent → queued", async () => {
  const { db, cleanup } = freshDb("group-upsert");
  try {
    await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (1,'G','g-site5')" });
    __setGroupSink(null);
    _setEligibilityForTest(() => true);
    await emitGroupUpsert(db, 1);
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "contact_groups");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).group_uid, "g-site5");
  } finally {
    _setEligibilityForTest(null);
    __setGroupSink(null);
    cleanup();
  }
});

test("group-sync.js emitGroupDelete (delete): sink absent → queued", async () => {
  // Same shape as emitContactChange above — emitGroupDelete has no db param;
  // drive the fallback via the test seam's db arg (same reasoning).
  const { db, cleanup } = freshDb("group-delete");
  try {
    __setGroupSink(null, db);
    _setEligibilityForTest(() => true);
    await emitGroupDelete("g-site5-del");
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "contact_groups");
    assert.equal(row.op, "delete");
    assert.equal(JSON.parse(row.row_json).group_uid, "g-site5-del");
  } finally {
    _setEligibilityForTest(null);
    __setGroupSink(null);
    cleanup();
  }
});

/* ═══════════════════════ servers/sharing/sync-conflict-resolve.js (2 sites) */

test("sync-conflict-resolve.js restoreConflict op=update restore (update): instanceSync absent → queued", async () => {
  const { db, cleanup } = freshDb("conflict-update");
  try {
    await db.execute({
      sql: `INSERT INTO memories (id, category, content, lamport_ts) VALUES (900, 'general', 'orig', 50)`,
    });
    await db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
            VALUES ('memories', '900', 'inst-a', 'inst-b', 50, 10, ?, ?, 'update')`,
      args: [
        JSON.stringify({ id: 900, category: "general", content: "orig", lamport_ts: 50 }),
        JSON.stringify({ id: 900, content: "restored" }),
      ],
    });
    const { rows } = await db.execute("SELECT id FROM sync_conflicts WHERE row_id = '900'");
    const conflictId = rows[0].id;
    _setEligibilityForTest(() => true);
    const outcome = await restoreConflict(db, conflictId, { instanceSync: null });
    assert.equal(outcome.status, "applied");
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "update");
    assert.equal(JSON.parse(row.row_json).content, "restored");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("sync-conflict-resolve.js restoreConflict op=delete restore (delete): instanceSync absent → queued", async () => {
  const { db, cleanup } = freshDb("conflict-delete");
  try {
    await db.execute({
      sql: `INSERT INTO memories (id, category, content, lamport_ts) VALUES (901, 'general', 'to-delete', 50)`,
    });
    await db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
            VALUES ('memories', '901', 'inst-a', 'inst-b', 50, 5, ?, ?, 'delete')`,
      args: [
        JSON.stringify({ id: 901, category: "general", content: "to-delete", lamport_ts: 50 }),
        JSON.stringify({ id: 901 }),
      ],
    });
    const { rows } = await db.execute("SELECT id FROM sync_conflicts WHERE row_id = '901'");
    const conflictId = rows[0].id;
    _setEligibilityForTest(() => true);
    const outcome = await restoreConflict(db, conflictId, { instanceSync: null });
    assert.equal(outcome.status, "applied");
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "delete");
    // conflict.row_id is TEXT (sync_conflicts.row_id) — restoreConflict passes
    // it straight through as { id: rowId }, so the wire id is the string '901'.
    assert.equal(JSON.parse(row.row_json).id, "901");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

/* ═══════ NEW zero-emit writers: panels/memory.js delete/edit ═══════ */

test("panels/memory.js delete action (memories delete): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("panel-mem-delete");
  try {
    await db.execute({ sql: "INSERT INTO memories (id, category, content, source) VALUES (1, 'general', 'to-delete', 'testsrc')" });
    _setEligibilityForTest(() => true);
    const res = { redirectAfterPost: (u) => ({ redirect: u }) };
    await memoryPanel.handler({ method: "POST", body: { action: "delete", id: "1" } }, res, { db, lang: "en" });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "delete");
    assert.equal(JSON.parse(row.row_json).id, 1);
    assert.equal(JSON.parse(row.row_json).source, "testsrc");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("panels/memory.js edit action (memories update): syncManager absent → queued", async () => {
  const { db, cleanup } = freshDb("panel-mem-edit");
  try {
    await db.execute({ sql: "INSERT INTO memories (id, category, content, source) VALUES (1, 'general', 'before-edit', 'testsrc')" });
    _setEligibilityForTest(() => true);
    const res = { redirectAfterPost: (u) => ({ redirect: u }) };
    await memoryPanel.handler(
      { method: "POST", body: { action: "edit", id: "1", content: "after-edit", category: "project", importance: "7" } },
      res,
      { db, lang: "en" },
    );
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "update");
    const wire = JSON.parse(row.row_json);
    assert.equal(wire.id, 1);
    assert.equal(wire.content, "after-edit");
    assert.equal(wire.category, "project");
    assert.equal(Number(wire.importance), 7);
    assert.equal(wire.source, "testsrc");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

/* ═══════ NEW zero-emit writers: boot.js share-import inserts ═══════ */

function stubSharingManagers(db) {
  const calls = { subscribeToContact: [], subscribeToIncoming: 0, joinContact: [], initContact: [] };
  return {
    db,
    identity: { crowId: "crow:local-test", secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) },
    peerManager: {
      start: () => Promise.resolve(),
      joinContact: async (a) => { calls.joinContact.push(a); },
      joinInstanceSync: async () => {},
    },
    // This is the OTHER manager (SyncManager, Hyperswarm per-contact) — NOT
    // the InstanceSyncManager emitOrQueue cares about. Distinct namespace,
    // per servers/sharing/managers.js's _sharedManagers shape.
    syncManager: { initContact: async (id) => { calls.initContact.push(id); } },
    // The InstanceSyncManager: feedsDisabled true (not live) rather than a
    // literal null — boot.js's own synchronous init code (peerManager.localInstanceId
    // = instanceSyncManager.localInstanceId) dereferences it unconditionally, so a
    // bare null crashes wiring unrelated to this sweep. feedsDisabled:true is the
    // real-world "no live manager" shape this queues against (the --no-auth /
    // not-yet-paired case) and is what emitOrQueue treats as "not live".
    instanceSyncManager: { localInstanceId: "inst-boot-test", feedsDisabled: true },
    nostrManager: {
      subscribeToContact: async (c) => { calls.subscribeToContact.push(c.crow_id); },
      subscribeToIncoming: async (onInvite, onSocial, onRequest) => { calls.subscribeToIncoming++; },
    },
  };
}

test("boot.js share-import memory insert (memories insert): instanceSyncManager not live → queued", async () => {
  const { db, cleanup } = freshDb("boot-mem-import");
  try {
    await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES (1,'crow:sharer','', ?, 0)", args: ["a".repeat(64)] });
    _setEligibilityForTest(() => true);
    const managers = stubSharingManagers(db);
    await initSharingRuntime(managers, { applyProjectCloneBundle: async () => {}, buildProjectCloneBundle: async () => {} });
    await managers.peerManager.onPeerData("crow:sharer", {
      type: "share",
      share_type: "memory",
      payload: { content: "shared memory content", category: "general", importance: 6, context: "ctx", source: "peer", tags: "t1,t2" },
    });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "memories");
    assert.equal(row.op, "insert");
    const wire = JSON.parse(row.row_json);
    assert.equal(wire.content, "shared memory content");
    assert.equal(wire.source, "peer");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});

test("boot.js share-import research_notes insert (research_notes insert): instanceSyncManager not live → queued", async () => {
  const { db, cleanup } = freshDb("boot-note-import");
  try {
    await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES (1,'crow:sharer2','', ?, 0)", args: ["b".repeat(64)] });
    _setEligibilityForTest(() => true);
    const managers = stubSharingManagers(db);
    await initSharingRuntime(managers, { applyProjectCloneBundle: async () => {}, buildProjectCloneBundle: async () => {} });
    await managers.peerManager.onPeerData("crow:sharer2", {
      type: "share",
      share_type: "note",
      payload: { content: "shared note content" },
    });
    await waitForOutbox(db, 1);
    const row = await lastOutboxRow(db);
    assert.equal(row.table_name, "research_notes");
    assert.equal(row.op, "insert");
    assert.equal(JSON.parse(row.row_json).content, "shared note content");
  } finally {
    _setEligibilityForTest(null);
    cleanup();
  }
});
