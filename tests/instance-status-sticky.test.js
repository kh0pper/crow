/**
 * Peer revoke must stick (MPA retirement defect 4, audit A8 2026-10-02).
 *
 * The connection loops (gateway proxy probe, Hyperswarm onInstanceConnected,
 * tailnet-sync both directions) used to write status='active'/'offline'
 * unconditionally, so a revoke lasted until the next probe — and the
 * Hyperswarm handler marked EVERY row sharing the crow_id active, which kept
 * the retired MPA row 'active' with a fresh last_seen_at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  livenessStatusSql,
  markInstanceConnectionSeen,
} from "../servers/shared/instance-status.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "inst-sticky-"));
  const db = createDbClient(join(dir, "crow.db"));
  return { db, dir };
}

async function seed(db) {
  await db.execute(`CREATE TABLE crow_instances (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, crow_id TEXT NOT NULL,
    gateway_url TEXT, is_home INTEGER DEFAULT 0, auth_token_hash TEXT,
    last_seen_at TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','offline','paused','revoked')),
    updated_at TEXT DEFAULT (datetime('now')))`);
  const rows = [
    ["live", "active"],
    ["down", "offline"],
    ["gone", "revoked"],
    ["held", "paused"],
  ];
  for (const [id, status] of rows) {
    await db.execute({
      sql: "INSERT INTO crow_instances (id, name, crow_id, status, last_seen_at) VALUES (?, ?, 'crow:same', ?, '2000-01-01 00:00:00')",
      args: [id, id, status],
    });
  }
}

async function statusOf(db, id) {
  const { rows } = await db.execute({ sql: "SELECT status, last_seen_at FROM crow_instances WHERE id = ?", args: [id] });
  return rows[0];
}

test("livenessStatusSql never overwrites revoked or paused", async () => {
  const { db, dir } = freshDb();
  try {
    await seed(db);
    await db.execute(`UPDATE crow_instances SET status = ${livenessStatusSql("offline")}`);
    assert.equal((await statusOf(db, "live")).status, "offline");
    assert.equal((await statusOf(db, "gone")).status, "revoked");
    assert.equal((await statusOf(db, "held")).status, "paused");
    await db.execute(`UPDATE crow_instances SET status = ${livenessStatusSql("active")}`);
    assert.equal((await statusOf(db, "down")).status, "active");
    assert.equal((await statusOf(db, "gone")).status, "revoked");
    assert.equal((await statusOf(db, "held")).status, "paused");
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("livenessStatusSql rejects non-liveness statuses", () => {
  assert.throws(() => livenessStatusSql("revoked"));
  assert.throws(() => livenessStatusSql("x'; DROP TABLE t; --"));
});

test("Hyperswarm connection marks only the advertised instance, not every same-crow_id row", async () => {
  const { db, dir } = freshDb();
  try {
    await seed(db);
    const touched = await markInstanceConnectionSeen(db, { matchedIds: ["live", "down"], remoteInstanceId: "down" });
    assert.deepEqual(touched, ["down"]);
    assert.equal((await statusOf(db, "down")).status, "active");
    // the sibling sharing the crow_id is not refreshed
    assert.equal((await statusOf(db, "live")).last_seen_at, "2000-01-01 00:00:00");
    // the revoked row is untouched entirely
    assert.deepEqual(await statusOf(db, "gone"), { status: "revoked", last_seen_at: "2000-01-01 00:00:00" });
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advertised id that is not a live matched row touches nothing", async () => {
  const { db, dir } = freshDb();
  try {
    await seed(db);
    const touched = await markInstanceConnectionSeen(db, { matchedIds: ["live", "down"], remoteInstanceId: "gone" });
    assert.deepEqual(touched, []);
    assert.equal((await statusOf(db, "gone")).status, "revoked");
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("older peer without instance_id falls back to the matched (live) rows only", async () => {
  const { db, dir } = freshDb();
  try {
    await seed(db);
    const touched = await markInstanceConnectionSeen(db, { matchedIds: ["live", "down"] });
    assert.deepEqual(touched.sort(), ["down", "live"]);
    assert.equal((await statusOf(db, "down")).status, "active");
    assert.equal((await statusOf(db, "gone")).status, "revoked");
    assert.equal((await statusOf(db, "held")).status, "paused");
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression guard: no liveness loop may write a literal 'active'/'offline'
// into crow_instances.status again. registerInstance's INSERT ... ON CONFLICT
// (an explicit re-pair) is deliberately allowed to reactivate.
test("no unconditional liveness UPDATE of crow_instances.status remains in servers/", () => {
  const offenders = [];
  const re = /UPDATE\s+crow_instances\s+SET[^"`;]*status\s*=\s*'(active|offline)'/i;
  function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(name) && re.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  }
  walk(join(import.meta.dirname, "..", "servers"));
  assert.deepEqual(offenders, []);
});

// Defect 5: the Paired Instances page promised a revoke action that did not
// exist. It now renders one per revocable row and runs revokeInstance().
test("Paired Instances: Revoke renders for peers only, refuses self with a flash, and revokes through revokePeer()", async () => {
  const { db, dir } = freshDb();
  const prevData = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "instance-id"), "self\n");
    await db.execute(`CREATE TABLE crow_instances (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, crow_id TEXT NOT NULL, hostname TEXT, tailscale_ip TEXT,
      gateway_url TEXT, is_home INTEGER DEFAULT 0, auth_token_hash TEXT, trusted INTEGER DEFAULT 0,
      last_seen_at TEXT, created_at TEXT, status TEXT DEFAULT 'active', updated_at TEXT)`);
    await db.execute(`CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
    await db.execute(`CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id))`);
    for (const [id, name, home, status] of [["self", "Me", 0, "active"], ["homey", "Home", 1, "active"], ["peer1", "MPA", 0, "active"], ["old", "Old", 0, "revoked"]]) {
      await db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, is_home, status, auth_token_hash) VALUES (?,?,'c',?,?,'h')", args: [id, name, home, status] });
    }
    const { default: section, canRevokeRow } = await import("../servers/gateway/dashboard/settings/sections/paired-instances.js");
    const { _setSyncManagerResolverForTest } = await import("../servers/sharing/revoke-peer.js");
    _setSyncManagerResolverForTest(() => null); // render/row behaviour only; teardown is covered in peer-revoke-teardown.test.js
    assert.equal(canRevokeRow({ id: "peer1", status: "active", is_home: 0 }, "self"), true);
    assert.equal(canRevokeRow({ id: "self", status: "active", is_home: 0 }, "self"), false);
    assert.equal(canRevokeRow({ id: "homey", status: "active", is_home: 1 }, "self"), false);
    assert.equal(canRevokeRow({ id: "old", status: "revoked", is_home: 0 }, "self"), false);

    const html = await section.render({ req: { csrfToken: "tok" }, db, lang: "en" });
    const revokeForms = html.match(/name="instance_id" value="([^"]+)"/g) || [];
    assert.deepEqual(revokeForms, ['name="instance_id" value="peer1"']);

    let redirected = null;
    const res = { redirectAfterPost: (u) => { redirected = u; } };
    // a forged revoke of the local row is refused, with an error flash
    await section.handleAction({ req: { body: { instance_id: "self" } }, res, db, action: "revoke_instance" });
    assert.equal((await statusOf(db, "self")).status, "active");
    assert.equal(redirected, "/dashboard/settings?section=paired-instances&revoke_error=self");
    const flashHtml = await section.render({ req: { csrfToken: "tok", query: { revoke_error: "self" } }, db, lang: "en" });
    assert.match(flashHtml, /can't be revoked from here/);
    const handled = await section.handleAction({ req: { body: { instance_id: "peer1" } }, res, db, action: "revoke_instance" });
    assert.equal(handled, true);
    assert.equal(redirected, "/dashboard/settings?section=paired-instances&revoked=1");
    const { rows } = await db.execute("SELECT status, auth_token_hash FROM crow_instances WHERE id = 'peer1'");
    assert.equal(rows[0].status, "revoked");
    assert.equal(rows[0].auth_token_hash, null);
  } finally {
    if (prevData === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevData;
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeatInstance with a status is liveness-only: never un-revokes, rejects non-liveness values", async () => {
  const { db, dir } = freshDb();
  try {
    await seed(db);
    const { heartbeatInstance } = await import("../servers/gateway/instance-registry.js");
    await heartbeatInstance(db, "gone", { status: "active" });
    assert.equal((await statusOf(db, "gone")).status, "revoked");
    await heartbeatInstance(db, "down", { status: "active" });
    assert.equal((await statusOf(db, "down")).status, "active");
    await assert.rejects(() => heartbeatInstance(db, "live", { status: "revoked" }));
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
