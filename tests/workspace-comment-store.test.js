/** Comment loop Phase 1, Task 1: the bundle tables and the comments store. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initWorkspaceTables } from "../bundles/workspace/server/init-tables.js";

let dir, db, S;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "wcs-"));
  db = createDbClient(join(dir, "crow.db"));
  await initWorkspaceTables(db);
  S = await import("../bundles/workspace/server/comments/store.js");
});
after(() => { try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("init twice is idempotent; no rounds table", async () => {
  await initWorkspaceTables(db);
  const names = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => r.name);
  for (const n of ["workspace_comment_watch", "workspace_editor_sessions", "workspace_comment_state", "workspace_comment_events"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("workspace_comment_rounds"));
});

test("mode leaves off -> watch_since=now; shadow->on keeps it; off->shadow again resets it", async () => {
  assert.equal((await S.setMode(db, "shadow", 1000)).watch_since, 1000);
  assert.equal((await S.setMode(db, "on", 2000)).watch_since, 1000);
  await S.setMode(db, "off", 3000);
  assert.equal((await S.setMode(db, "shadow", 4000)).watch_since, 4000);
});

test("setMode refuses an unknown mode", async () => {
  await assert.rejects(S.setMode(db, "yes", 1));
});

test("lease: one owner at a time; expired lease is taken", async () => {
  assert.equal(await S.takeLease(db, "a", 0), true);
  assert.equal(await S.takeLease(db, "b", 1), false);
  assert.equal(await S.takeLease(db, "b", 60001), true);
});

test("setBlocked and state rows round-trip", async () => {
  await S.setBlocked(db, "provider down");
  assert.equal((await S.getWatch(db)).blocked_reason, "provider down");
  await S.setBlocked(db, null);
  assert.equal((await S.getWatch(db)).blocked_reason, null);
  assert.equal(await S.getState(db, 7), null);
  await S.putState(db, { file_id: 7, etag: "e1", mtime: 5, threads_json: "[1]", first_seen_at: 10 });
  await S.putState(db, { file_id: 7, etag: "e2", mtime: 6, threads_json: "[2]", first_seen_at: 99, scanned_at: 11 });
  const s = await S.getState(db, 7);
  assert.equal(s.etag, "e2"); assert.equal(s.first_seen_at, 10); assert.equal(s.scanned_at, 11);
});

test("logEvent rejects unknown kinds and never stores full text", async () => {
  await assert.rejects(S.logEvent(db, { at: 1, fileId: 1, kind: "bogus", detail: {} }));
  await assert.rejects(S.logEvent(db, { at: 1, fileId: 1, kind: "scan_new", detail: { text: "full" } }));
  await assert.rejects(S.logEvent(db, { at: 1, fileId: 1, kind: "scan_new", detail: { content: "full" } }));
  await S.logEvent(db, { at: 1, fileId: 1, kind: "scan_new", detail: { hash: S.textHash("hi"), snippet: S.snippetOf("hi") } });
  assert.equal(S.textHash("hi").length, 16);
  assert.match(S.textHash("hi"), /^[0-9a-f]{16}$/);
});

test("snippet keeps whole code points", () => {
  // Odd prefix: a UTF-16 cut at 40 units would split a surrogate pair.
  const s = S.snippetOf("a" + "😀".repeat(50));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s), false);
  assert.equal([...s].length, 40);
});

test("prune: events > 30 d and sessions > 7 d go", async () => {
  const D = 86400000, now = 100 * D;
  await db.execute("DELETE FROM workspace_comment_events");
  await S.logEvent(db, { at: now - 31 * D, fileId: 1, kind: "history", detail: {} });
  await S.logEvent(db, { at: now - 29 * D, fileId: 1, kind: "history", detail: {} });
  await db.execute({ sql: "INSERT INTO workspace_editor_sessions(doc_key,file_id,uids_json,first_seen,last_seen) VALUES (?,?,?,?,?),(?,?,?,?,?)", args: ["old", 1, "[]", 0, now - 8 * D, "new", 2, "[]", 0, now - 6 * D] });
  await S.prune(db, now);
  assert.equal((await db.execute("SELECT COUNT(*) c FROM workspace_comment_events")).rows[0].c, 1);
  assert.deepEqual((await db.execute("SELECT doc_key FROM workspace_editor_sessions")).rows.map((r) => r.doc_key), ["new"]);
});

test("logEvent refuses full text at any depth and long strings under any key", async () => {
  await assert.rejects(S.logEvent(db, { at: 1, kind: "would_fire", detail: { nested: { Content: "x" } } }));
  await assert.rejects(S.logEvent(db, { at: 1, kind: "would_fire", detail: { note: "y".repeat(201) } }));
  await S.logEvent(db, { at: 1, kind: "would_fire", detail: { hash: "abc", snippet: "short" } });
});

test("clearBlocked: mode not off → watch_since = now (comments made while blocked never count); mode off keeps it", async () => {
  await S.setMode(db, "off", 0);
  await S.setMode(db, "shadow", 1000);
  await S.setBlocked(db, "duplicate_display_name");
  assert.equal(await S.clearBlocked(db, "duplicate_display_name", 9000), true);
  let w = await S.getWatch(db);
  assert.equal(w.blocked_reason, null); assert.equal(Number(w.watch_since), 9000);
  assert.equal(await S.clearBlocked(db, "duplicate_display_name", 12000), false, "nothing to clear");
  assert.equal(Number((await S.getWatch(db)).watch_since), 9000, "no block cleared → watch_since untouched");
  await S.setMode(db, "off", 13000);
  await S.setBlocked(db, "duplicate_display_name");
  assert.equal(await S.clearBlocked(db, "duplicate_display_name", 15000), true);
  w = await S.getWatch(db);
  assert.equal(w.mode, "off"); assert.equal(Number(w.watch_since), 9000, "off keeps it");
});

test("renewLease: only the holder extends its lease", async () => {
  await db.execute("UPDATE workspace_comment_watch SET lease_owner=NULL, lease_until=NULL WHERE id=1");
  assert.equal(await S.takeLease(db, "a", 0), true);
  assert.equal(await S.renewLease(db, "a", 50_000), true);
  assert.equal(Number((await S.getWatch(db)).lease_until), 110_000);
  assert.equal(await S.takeLease(db, "b", 70_000), false, "renewed: not expired");
  assert.equal(await S.renewLease(db, "b", 70_000), false, "not the holder");
});
