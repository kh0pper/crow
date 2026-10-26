/**
 * Approval-card secret masking (2026-10-26) in the notification pipeline: a
 * row's title, body and metadata are masked at the write, whoever the caller
 * (a bot can call crow_create_notification), and the push payload is masked at
 * delivery. The ntfy check posts to a local HTTP listener standing in for the
 * ntfy server and reads what actually went over the wire. Fakes only.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { createNotification, upsertGroupedNotification, deliverNotification } from "../servers/shared/notifications.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAKE = "fake-" + "notif-pw-" + "0000";
const S = "-" + "S";
const CMD = ["echo", '"' + FAKE + '"', "|", "sudo", S, "reboot"].join(" ");
let dir, db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "notif-secret-mask-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  db = createDbClient(join(dir, "crow.db"));
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const allRows = () => {
  const c = new Database(join(dir, "crow.db"));
  const r = c.prepare("SELECT title, body, metadata FROM notifications").all();
  c.close();
  return r;
};

test("createNotification: title, body and metadata are stored masked (any caller, e.g. a bot's own notification)", async () => {
  const r = await createNotification(db, {
    title: "hank: " + CMD, body: "ran GH_TOKEN=" + FAKE + " git push", type: "system",
    metadata: { command: CMD, nested: { list: ["PGPASSWORD=" + FAKE] } },
  });
  assert.ok(r && r.id);
  const rows = allRows();
  assert.equal(JSON.stringify(rows).includes(FAKE), false);
  const meta = JSON.parse(rows[rows.length - 1].metadata);
  assert.equal(meta.nested.list[0], "PGPASSWORD=[REDACTED]");
});

test("upsertGroupedNotification: the row, its group items and the pushed payload are masked", async () => {
  const pushes = [];
  const opts = { type: "attention", priority: "high", title: (n) => "bot needs you (" + n + ")", body: CMD,
    action_url: "/x", groupKey: "g:secret", item: { title: CMD }, deliver: async (_d, n) => { pushes.push(n); } };
  await upsertGroupedNotification(db, opts);
  await upsertGroupedNotification(db, { ...opts, body: "again " + CMD, item: { title: "again " + CMD } });
  assert.equal(JSON.stringify(allRows()).includes(FAKE), false);
  assert.equal(JSON.stringify(pushes).includes(FAKE), false);
  assert.equal(pushes.length, 1);
});

test("deliverNotification: what reaches the ntfy server carries no secret", async () => {
  const got = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ headers: req.headers, body: b }); res.end("{}"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const saved = { NTFY_TOPIC: process.env.NTFY_TOPIC, NTFY_HOST: process.env.NTFY_HOST, NTFY_PORT: process.env.NTFY_PORT };
  Object.assign(process.env, { NTFY_TOPIC: "crow-test-topic", NTFY_HOST: "127.0.0.1", NTFY_PORT: String(srv.address().port) });
  try {
    await deliverNotification({ execute: async () => ({ rows: [] }) }, { title: "needs you: " + CMD, body: CMD, priority: "high", type: "attention" });
    assert.equal(got.length, 1, "ntfy was called");
    assert.equal(JSON.stringify(got).includes(FAKE), false, JSON.stringify(got).slice(0, 300));
    assert.match(got[0].body, /\[REDACTED\]/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    srv.close();
  }
});
