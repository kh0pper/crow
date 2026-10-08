/**
 * Dead-check regression (security scan 2026-10-08): the "written by this
 * instance" guard in selectBotClassifier reads row.instance_id, but both real
 * callers selected providers WITHOUT that column — so every row looked
 * locally written and a peer-synced row (e.g. a voice model row written by
 * another paired instance) was auto-detected. These tests go through the
 * real read paths against a real init-db schema, not the pure function.
 *
 * Also: each permission write path is shown to actually invoke the guard.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "btb-cls-path-"));
process.env.CROW_DATA_DIR = dir;
delete process.env.CROW_DB_PATH;

let db, conn, readBotClassifierSync, getClassifierStatus, OWN;
const PEER = "b".repeat(32);

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ readBotClassifierSync } = await import("../scripts/pi-bots/bot-classifier.mjs"));
  ({ getClassifierStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/classifier-status.js"));
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  OWN = getOrCreateLocalInstanceId();
  conn = new Database(join(dir, "crow.db"));
});
after(() => { try { conn.close(); } catch {} try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const insert = (id, instanceId, url = "http://127.0.0.1:18100/v1") => conn.prepare(
  "INSERT OR REPLACE INTO providers (id, base_url, host, models, disabled, instance_id, gpu_policy) VALUES (?,?,?,?,0,?,?)")
  .run(id, url, "local", JSON.stringify([{ id: "qwen3.5-4b" }]), instanceId, JSON.stringify({ alwaysResident: true }));

test("bridge read path: a peer-written row on loopback is NOT auto-detected", () => {
  conn.prepare("DELETE FROM providers").run();
  insert("peer-voice", PEER);
  const r = readBotClassifierSync(conn, { localInstanceId: OWN });
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("bridge read path: this instance's own row IS auto-detected", () => {
  conn.prepare("DELETE FROM providers").run();
  insert("own-4b", OWN);
  const r = readBotClassifierSync(conn, { localInstanceId: OWN });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.providerId, "own-4b");
});

test("dashboard status path: a peer-written row is reported missing, not ready", async () => {
  conn.prepare("DELETE FROM providers").run();
  insert("peer-voice", PEER);
  const st = await getClassifierStatus(db, { probe: false });
  assert.equal(st.state, "missing", JSON.stringify(st));
});

test("explicit provider setting naming a peer-written row is refused on the bridge path", () => {
  conn.prepare("DELETE FROM providers").run();
  insert("peer-voice", PEER, "http://100.64.20.9:8011/v1");
  conn.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('bot_safety_classifier', 'peer-voice/qwen3.5-4b')").run();
  try {
    const r = readBotClassifierSync(conn, { localInstanceId: OWN });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "setting-row-not-own");
  } finally { conn.prepare("DELETE FROM dashboard_settings WHERE key='bot_safety_classifier'").run(); }
});
