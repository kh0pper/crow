/**
 * Glasses notes replicate (stdio sync-outbox follow-up, audit A7).
 *
 * research_notes + glasses_note_sessions have been in SYNCED_TABLES since
 * Phase 6, but the meta-glasses bundle wrote them raw, so nothing reached a
 * peer. bundles/meta-glasses/server/note-sync.js now routes the writes
 * through emitOrQueue. Two doors are exercised here:
 *   - the emit seam (which rows, which op, when), via an injected spy;
 *   - the real stdio OUTBOX door: no manager → a sync_outbox row (this is
 *     the path every MCP-authored glasses write takes, and it fails silently
 *     if a table lacks lamport_ts).
 * Plus the maker-lab gate: learner memories never sync (DATA-HANDLING.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { shouldSyncRowForTest } from "../servers/sharing/instance-sync.js";
import {
  syncRows,
  syncSessionAndNote,
  syncNoteUnlessLive,
  syncNoteIfIdle,
  _setSyncModsForTest,
} from "../bundles/meta-glasses/server/note-sync.js";

const instanceIdDir = mkdtempSync(join(tmpdir(), "crow-glasses-sync-iid-"));
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = instanceIdDir;

function freshDb(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-glasses-sync-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });
  return { db: createDbClient(join(dir, "crow.db")), dir };
}

async function seedSession(db, { status = "active" } = {}) {
  const n = await db.execute({ sql: "INSERT INTO research_notes (content, updated_at) VALUES ('# t\n', datetime('now'))", args: [] });
  const noteId = Number(n.lastInsertRowid);
  const s = await db.execute({
    sql: "INSERT INTO glasses_note_sessions (device_id, topic, mode, note_id, status) VALUES ('dev1', 't', 'dictation', ?, ?)",
    args: [noteId, status],
  });
  return { noteId, sessionId: Number(s.lastInsertRowid) };
}

function spy() {
  const calls = [];
  _setSyncModsForTest({
    getInstanceSyncManager: () => null,
    emitOrQueue: async (mgr, db, table, op, row) => { calls.push({ table, op, id: Number(row.id), row }); return { queued: true }; },
  });
  return calls;
}

test("syncSessionAndNote emits the note (full row) then the session", async () => {
  const { db, dir } = freshDb("pair");
  const calls = spy();
  try {
    const { noteId, sessionId } = await seedSession(db, { status: "ended" });
    await syncSessionAndNote(db, sessionId);
    assert.deepEqual(calls.map((c) => [c.table, c.op, c.id]), [
      ["research_notes", "update", noteId],
      ["glasses_note_sessions", "update", sessionId],
    ]);
    assert.equal(calls[0].row.content, "# t\n", "the emitted row is the stored row, not a partial");
  } finally {
    _setSyncModsForTest(null);
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mid-session edits ride the session-end emit; closed-session edits emit now", async () => {
  const { db, dir } = freshDb("live");
  const calls = spy();
  try {
    const live = await seedSession(db, { status: "active" });
    await syncNoteUnlessLive(db, live.sessionId);
    await syncNoteIfIdle(db, live.noteId);
    assert.equal(calls.length, 0, "active session: no per-line emit");

    const done = await seedSession(db, { status: "ended" });
    await syncNoteUnlessLive(db, done.sessionId);
    await syncNoteIfIdle(db, done.noteId);
    assert.deepEqual(calls.map((c) => [c.table, c.id]), [
      ["research_notes", done.noteId],
      ["research_notes", done.noteId],
    ]);
  } finally {
    _setSyncModsForTest(null);
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletes emit {id} only; unknown tables and missing ids are ignored", async () => {
  const { db, dir } = freshDb("del");
  const calls = spy();
  try {
    await syncRows(db, "glasses_note_sessions", 42, "delete");
    await syncRows(db, "memories", 1);
    await syncRows(db, "research_notes", [null, undefined]);
    await syncRows(db, "research_notes", 999); // row does not exist → nothing
    assert.deepEqual(calls.map((c) => [c.table, c.op, c.id]), [["glasses_note_sessions", "delete", 42]]);
    assert.deepEqual(Object.keys(calls[0].row), ["id"]);
  } finally {
    _setSyncModsForTest(null);
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync failure never throws into the glasses turn", async () => {
  const { db, dir } = freshDb("fail");
  _setSyncModsForTest({ getInstanceSyncManager: () => null, emitOrQueue: async () => { throw new Error("boom"); } });
  const orig = console.warn;
  console.warn = () => {};
  try {
    const { sessionId } = await seedSession(db, { status: "ended" });
    await syncSessionAndNote(db, sessionId); // must resolve
  } finally {
    console.warn = orig;
    _setSyncModsForTest(null);
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio outbox door: both glasses tables queue into sync_outbox with no manager", async () => {
  const { db, dir } = freshDb("outbox");
  _setEligibilityForTest(() => true);
  try {
    const { noteId, sessionId } = await seedSession(db, { status: "ended" });
    const note = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = ?", args: [noteId] })).rows[0];
    const sess = (await db.execute({ sql: "SELECT * FROM glasses_note_sessions WHERE id = ?", args: [sessionId] })).rows[0];
    const r1 = await emitOrQueue(null, db, "research_notes", "insert", { ...note });
    const r2 = await emitOrQueue(null, db, "glasses_note_sessions", "insert", { ...sess });
    assert.ok(r1?.queued, "research_notes did not queue (missing lamport_ts?)");
    assert.ok(r2?.queued, "glasses_note_sessions did not queue (missing lamport_ts?)");
    const { rows } = await db.execute("SELECT table_name FROM sync_outbox ORDER BY id");
    assert.deepEqual(rows.map((r) => r.table_name), ["research_notes", "glasses_note_sessions"]);
  } finally {
    _setEligibilityForTest(null);
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maker-lab learner memories never sync (emit or apply), other memories still do", () => {
  assert.equal(shouldSyncRowForTest("memories", { id: 1, content: "x", source: "maker-lab" }), false);
  assert.equal(shouldSyncRowForTest("memories", { id: 2, content: "x", source: "chat" }), true);
});

test.after(() => {
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(instanceIdDir, { recursive: true, force: true });
});
