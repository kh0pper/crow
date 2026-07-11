/**
 * Cluster B D4 — reemitSyncableSettingsOnce keyed on the v2 flag: a fleet
 * instance whose v1 flag is 'done:' re-runs ONCE so pre-existing global rows
 * for the newly-allowlisted profile keys reconcile; empty profile values are
 * never re-emitted (they could win the lamport race and blank a peer's real
 * value — R1 MAJOR-2).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

// Mirrors tests/messages-contacts-backfill.test.js exactly: signedEntry / fakeFeedWith,
// and _processNewEntriesInner's real 2-arg contract (remoteInstanceId, feed). Signature
// verification is against this.identity.ed25519Pubkey (shared-identity model — see
// _applyEntry in instance-sync.js), so signing with TEST_PRIV (== IDENTITY.ed25519Priv)
// is sufficient; no separate peer-trust wiring exists or is needed.
import { sign } from "../servers/sharing/identity.js";
function signedEntry(table, op, row, lamport_ts) {
  const entry = { table, op, row, lamport_ts, instance_id: "peer-1" };
  entry.signature = sign(JSON.stringify(entry), IDENTITY.ed25519Priv);
  return entry;
}
const fakeFeedWith = (entries) => ({ length: entries.length, async get(seq) { return entries[seq]; } });

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-b-reemit-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  m.feedsDisabled = false;
  m.outFeeds.set("peer-1", { append: async () => {} });
  return m;
}

test("v2 flag: re-runs once even when the v1 flag is done:, then no-ops (v1 orphan ignored)", async () => {
  const m = freshMgr("v2", "local-1"); const db = m.db;
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('__sync_reemit_allowlist_v1', 'done:9', datetime('now'))");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Kevin Hopper', datetime('now'))");
  const emitted = [];
  const orig = m.emitChange.bind(m);
  m.emitChange = async (t, o, r) => { emitted.push(r.key); return orig(t, o, r); };

  const n1 = await m.reemitSyncableSettingsOnce();
  assert.ok(n1 >= 1, "re-ran despite done: v1 flag");
  assert.ok(emitted.includes("profile_display_name"), "newly-allowlisted profile row re-emitted");
  const flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__sync_reemit_allowlist_v2'");
  assert.match(String(flag.rows[0]?.value), /^done:/, "v2 flag marked done");

  emitted.length = 0;
  const n2 = await m.reemitSyncableSettingsOnce();
  assert.equal(n2, 0, "second run is a no-op");
  assert.equal(emitted.length, 0);
});

test("apply side: a peer's profile_display_name entry is applied; a non-allowlisted key is dropped (spec test 7)", async () => {
  const m = freshMgr("apply", "local-3"); const db = m.db;
  const entries = [
    signedEntry("dashboard_settings", "update", { key: "profile_display_name", value: "Peer Name", instance_id: null }, 500),
    signedEntry("dashboard_settings", "update", { key: "not_allowlisted_key", value: "evil", instance_id: null }, 501),
  ];
  await m._processNewEntriesInner("peer-1", fakeFeedWith(entries));
  const g = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'profile_display_name'");
  assert.equal(g.rows[0]?.value, "Peer Name", "allowlisted profile row applied from a peer");
  const bad = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings WHERE key = 'not_allowlisted_key'");
  assert.equal(Number(bad.rows[0].c), 0, "non-allowlisted key dropped by the apply-side gate");
});

test("empty-profile guard: empty/whitespace profile values are NOT re-emitted; non-profile empties still are", async () => {
  const m = freshMgr("empty", "local-2"); const db = m.db;
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_bio', '', datetime('now'))");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_avatar_url', '  ', datetime('now'))");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Kevin', datetime('now'))");
  // Pins the DELIBERATE scoping: the guard is profile-only (an empty value for
  // another allowlisted key is meaningful and still reconciles).
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nav_groups', '', datetime('now'))");
  const emitted = [];
  m.emitChange = async (_t, _o, r) => { emitted.push(r.key); };

  await m.reemitSyncableSettingsOnce();
  assert.ok(!emitted.includes("profile_bio"), "empty bio NOT re-emitted (fleet-blanking hazard)");
  assert.ok(!emitted.includes("profile_avatar_url"), "whitespace avatar NOT re-emitted");
  assert.ok(emitted.includes("profile_display_name"), "non-empty profile value re-emitted");
  assert.ok(emitted.includes("nav_groups"), "guard is scoped to profile keys only");
});
