/**
 * Grouped notifications (upsertGroupedNotification): one row and ONE push per
 * open group, a count and the item list kept on the row, nothing dropped.
 * A group stays open while its row is unread and undismissed; reading or
 * dismissing it closes the group, and the next item starts a new one.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { upsertGroupedNotification, repushNotificationGroup, closeNotificationGroup, GROUP_ITEMS_MAX } from "../servers/shared/notifications.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
let dir, db;
const pushes = [];
const deliver = async (_db, n) => { pushes.push(n); };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "notif-grouped-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  db = createDbClient(join(dir, "crow.db"));
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const rows = (key) => {
  const c = new Database(join(dir, "crow.db"));
  const r = c.prepare("SELECT * FROM notifications WHERE source=? ORDER BY id").all(key);
  c.close();
  return r;
};
const base = (key, q) => ({
  type: "attention", priority: "high", title: "a bot needs you", body: q,
  action_url: "/dashboard/bot-board#bird=s1", groupKey: key, item: { title: q }, deliver,
});

test("the first item inserts a row and pushes; later items update the SAME row with a count and do not push", async () => {
  pushes.length = 0;
  const r1 = await upsertGroupedNotification(db, base("g:a", "run ls?"));
  assert.equal(r1.created, true);
  assert.equal(r1.count, 1);
  const r2 = await upsertGroupedNotification(db, { ...base("g:a", "run cat?"), title: "a bot needs you (2)" });
  const r3 = await upsertGroupedNotification(db, { ...base("g:a", "run wc?"), title: "a bot needs you (3)" });
  assert.equal(r2.created, false);
  assert.equal(r3.count, 3);
  assert.equal(r3.id, r1.id);
  const rs = rows("g:a");
  assert.equal(rs.length, 1, "one row for the group");
  assert.equal(rs[0].title, "a bot needs you (3)");
  assert.equal(rs[0].body, "run wc?", "the latest question is shown");
  assert.equal(rs[0].priority, "high");
  const meta = JSON.parse(rs[0].metadata);
  assert.equal(meta.group.count, 3);
  assert.deepEqual(meta.group.items.map((i) => i.title), ["run ls?", "run cat?", "run wc?"], "every question is kept");
  assert.equal(pushes.length, 1, "exactly one push for the whole group");
});

test("groups are per key", async () => {
  pushes.length = 0;
  await upsertGroupedNotification(db, base("g:b", "x?"));
  await upsertGroupedNotification(db, base("g:c", "y?"));
  assert.equal(rows("g:b").length, 1);
  assert.equal(rows("g:c").length, 1);
  assert.equal(pushes.length, 2);
});

test("a read or dismissed row closes the group: the next item makes a new row and pushes again", async () => {
  pushes.length = 0;
  const first = await upsertGroupedNotification(db, base("g:d", "one?"));
  const c = new Database(join(dir, "crow.db"));
  c.prepare("UPDATE notifications SET is_read=1 WHERE id=?").run(first.id);
  c.close();
  const second = await upsertGroupedNotification(db, base("g:d", "two?"));
  assert.equal(second.created, true);
  assert.notEqual(second.id, first.id);
  const c2 = new Database(join(dir, "crow.db"));
  c2.prepare("UPDATE notifications SET is_dismissed=1 WHERE id=?").run(second.id);
  c2.close();
  const third = await upsertGroupedNotification(db, base("g:d", "three?"));
  assert.equal(third.created, true);
  assert.equal(rows("g:d").length, 3);
  assert.equal(pushes.length, 3);
});

test("the item list is capped; older items are counted, never silently lost", async () => {
  for (let i = 0; i < GROUP_ITEMS_MAX + 5; i++) await upsertGroupedNotification(db, base("g:e", "q" + i));
  const meta = JSON.parse(rows("g:e")[0].metadata);
  assert.equal(meta.group.count, GROUP_ITEMS_MAX + 5);
  assert.equal(meta.group.items.length, GROUP_ITEMS_MAX);
  assert.equal(meta.group.items_dropped, 5);
  assert.equal(meta.group.items.at(-1).title, "q" + (GROUP_ITEMS_MAX + 4));
});

test("the preferences gate applies: a disabled type writes nothing and pushes nothing", async () => {
  pushes.length = 0;
  await db.execute({
    sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)",
    args: [JSON.stringify({ types_enabled: ["system"] })],
  });
  try {
    const r = await upsertGroupedNotification(db, base("g:f", "hidden?"));
    assert.equal(r, null);
    assert.equal(rows("g:f").length, 0);
    assert.equal(pushes.length, 0);
  } finally {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key='notification_prefs'", args: [] });
  }
});

test("an update does NOT move created_at (the phone polls created_at > since and would alert again)", async () => {
  const r1 = await upsertGroupedNotification(db, base("g:g", "old?"));
  const c = new Database(join(dir, "crow.db"));
  c.prepare("UPDATE notifications SET created_at='2000-01-01 00:00:00' WHERE id=?").run(r1.id);
  c.close();
  await upsertGroupedNotification(db, base("g:g", "new?"));
  assert.equal(rows("g:g")[0].created_at, "2000-01-01 00:00:00");
  assert.equal(rows("g:g")[0].body, "new?");
});

test("a title function gets the count", async () => {
  await upsertGroupedNotification(db, { ...base("g:h", "a?"), title: (n) => "bot needs you" + (n > 1 ? " (" + n + ")" : "") });
  await upsertGroupedNotification(db, { ...base("g:h", "b?"), title: (n) => "bot needs you" + (n > 1 ? " (" + n + ")" : "") });
  assert.equal(rows("g:h")[0].title, "bot needs you (2)");
});

test("re-push: only when the count grew since the last push; recorded on the row; no new row", async () => {
  pushes.length = 0;
  await upsertGroupedNotification(db, { ...base("g:i", "a?"), nowMs: 1000 });
  assert.equal((await repushNotificationGroup(db, { groupKey: "g:i", title: "t", deliver, nowMs: 2000 })).pushed, false, "nothing new");
  const r2 = await upsertGroupedNotification(db, { ...base("g:i", "b?"), nowMs: 3000 });
  assert.equal(r2.lastPushAt, 1000);
  assert.equal(r2.pushedCount, 1);
  const rp = await repushNotificationGroup(db, { groupKey: "g:i", title: (n) => "t" + n, deliver, nowMs: 4000 });
  assert.deepEqual(rp, { pushed: true, count: 2 });
  assert.equal(pushes.at(-1).title, "t2");
  assert.equal(pushes.at(-1).body, "b?");
  const g = JSON.parse(rows("g:i")[0].metadata).group;
  assert.equal(g.last_push_at, 4000);
  assert.equal(g.pushed_count, 2);
  assert.equal((await repushNotificationGroup(db, { groupKey: "g:i", title: "t", deliver, nowMs: 5000 })).pushed, false);
  assert.equal(rows("g:i").length, 1);
  assert.equal(pushes.length, 2);
});

test("re-push skips a snoozed row; the update reports it snoozed", async () => {
  pushes.length = 0;
  const r = await upsertGroupedNotification(db, { ...base("g:j", "a?"), nowMs: Date.now() });
  const c = new Database(join(dir, "crow.db"));
  c.prepare("UPDATE notifications SET snoozed_until=datetime('now','+1 hour') WHERE id=?").run(r.id);
  c.close();
  const r2 = await upsertGroupedNotification(db, { ...base("g:j", "b?"), nowMs: Date.now() });
  assert.equal(r2.snoozed, true);
  assert.equal((await repushNotificationGroup(db, { groupKey: "g:j", title: "t", deliver, nowMs: Date.now() })).pushed, false);
  assert.equal(pushes.length, 1);
});

test("closing a group marks its row read; the next item starts a new group and pushes", async () => {
  pushes.length = 0;
  await upsertGroupedNotification(db, base("g:k", "a?"));
  await closeNotificationGroup(db, "g:k");
  assert.equal(rows("g:k")[0].is_read, 1);
  const r = await upsertGroupedNotification(db, base("g:k", "b?"));
  assert.equal(r.created, true);
  assert.equal(pushes.length, 2);
  await closeNotificationGroup(db, "g:none");                 // no row: a no-op
});
