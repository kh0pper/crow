import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { __setEmitSinkForTest } from "../servers/sharing/group-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-p3g-backfill-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe" });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  m.feedsDisabled = false;
  m.outFeeds.set("peer-1", { append: async () => {} });
  // Route group-sync's lazy sink at THIS manager: in a unit test
  // managers.getInstanceSyncManager() is null (ensureSharedManagers never ran),
  // so without this the backfill's emitGroupUpsert calls would silently no-op
  // and the patched m.emitChange would never observe them. Tests run serially
  // (node:test per-file default), so re-pointing the module-global sink per
  // freshMgr is safe.
  __setEmitSinkForTest(m);
  return m;
}
after(() => __setEmitSinkForTest(null));

test("backfillGroupsOnce: re-emits plain groups once, no-ops on re-run (idempotent)", async () => {
  const m = freshMgr("idem", "local-1"); const db = m.db;
  const emitted = [];
  const orig = m.emitChange.bind(m);
  m.emitChange = async (t, o, r) => { if (t === "contact_groups") emitted.push(r.group_uid); return orig(t, o, r); };
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Family','gb1')" });
  const n1 = await m.backfillGroupsOnce();
  assert.equal(n1, 1);
  assert.deepEqual(emitted, ["gb1"]);
  emitted.length = 0;
  assert.equal(await m.backfillGroupsOnce(), 0, "flag-guarded second run is a no-op");
  assert.equal(emitted.length, 0);
});

test("backfillGroupsOnce: excludes ROOM groups (room_uid NOT NULL)", async () => {
  const m = freshMgr("rooms", "local-2"); const db = m.db;
  const emitted = [];
  m.emitChange = async (t, _o, r) => { if (t === "contact_groups") emitted.push(r.group_uid); };
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Plain','gb2')" });
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid, room_uid) VALUES ('Room','gb3','ruid')" });
  const n = await m.backfillGroupsOnce();
  assert.equal(n, 1);
  assert.deepEqual(emitted, ["gb2"], "only the plain group re-emitted");
});

test("backfillGroupsOnce: no peers → returns 0 and does NOT mark the flag (retryable)", async () => {
  const m = freshMgr("nopeers", "local-3");
  m.outFeeds.clear();
  await m.db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Solo','gb4')" });
  assert.equal(await m.backfillGroupsOnce(), 0);
  const { rows } = await m.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key='__groups_backfill_v1'" });
  assert.equal(rows.length, 0, "flag NOT written when peerless — retry next boot");
});

test("C1: a pre-existing NULL-uid plain group is assigned the DETERMINISTIC uid (frozen)", async () => {
  const m = freshMgr("det", "local-4"); const db = m.db;
  // Legacy row: insert then force NULL past the trigger (mirrors a pre-feature group).
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('  Family  ', 'seed')" });
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='  Family  '");
  await m._assignDeterministicGroupUids();
  const expect = createHash("sha256").update(`${TEST_PUB_HEX}:family`).digest("hex").slice(0, 32);
  const { rows } = await db.execute({ sql: "SELECT group_uid FROM contact_groups WHERE name='  Family  '" });
  assert.equal(rows[0].group_uid, expect, "uid = sha256(pubkey:lower(trim(name)))[:32]");
  // Idempotent + frozen: a rename does NOT change the assigned uid; a re-run is a no-op.
  await db.execute("UPDATE contact_groups SET name='Renamed' WHERE name='  Family  '");
  assert.equal(await m._assignDeterministicGroupUids(), 0, "no NULL-uid rows left → no-op");
  const { rows: r2 } = await db.execute({ sql: "SELECT group_uid FROM contact_groups WHERE name='Renamed'" });
  assert.equal(r2[0].group_uid, expect, "uid frozen across rename");
});

test("C1 convergence: two instances (same shared identity) derive the SAME uid for the same-named group", async () => {
  const a = freshMgr("convA", "inst-A"); const b = freshMgr("convB", "inst-B");
  for (const m of [a, b]) {
    await m.db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Family','seed')" });
    await m.db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='Family'");
    await m._assignDeterministicGroupUids();
  }
  const ua = (await a.db.execute("SELECT group_uid FROM contact_groups WHERE name='Family'")).rows[0].group_uid;
  const ub = (await b.db.execute("SELECT group_uid FROM contact_groups WHERE name='Family'")).rows[0].group_uid;
  assert.equal(ua, ub, "same shared identity + same name → identical deterministic uid → converges, not duplicates");
});

test("C1 tie-break (R2 F1): two same-name plain groups on ONE instance get DISTINCT collision-driven uids (no UNIQUE crash) + a partial run self-heals", async () => {
  const m = freshMgr("tie", "local-5"); const db = m.db;
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (1,'Family','s1'),(2,'Family','s2')" });
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='Family'");
  const n = await m._assignDeterministicGroupUids();
  assert.equal(n, 2, "both rows assigned, no UNIQUE-index crash");
  const first = createHash("sha256").update(`${TEST_PUB_HEX}:family`).digest("hex").slice(0, 32);
  const second = createHash("sha256").update(`${TEST_PUB_HEX}:family\x1f1`).digest("hex").slice(0, 32);
  const u1 = (await db.execute("SELECT group_uid FROM contact_groups WHERE id=1")).rows[0].group_uid;
  const u2 = (await db.execute("SELECT group_uid FROM contact_groups WHERE id=2")).rows[0].group_uid;
  assert.equal(u1, first, "lowest id lands the base hash");
  assert.equal(u2, second, "second (by id ASC) collides on base, retries → \\x1f1 slot hash");
  assert.notEqual(u1, u2);
  // Crash-idempotency (R2 F1b): simulate a partial run — strand row 2 back to NULL.
  // The retry loop re-probes from the base hash, walks past the already-taken slot,
  // and re-lands \x1f1 — no permanent UNIQUE-stranding (the R1 counter design's bug).
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE id = 2");
  assert.equal(await m._assignDeterministicGroupUids(), 1, "stranded row re-assigned on the next run");
  const u2b = (await db.execute("SELECT group_uid FROM contact_groups WHERE id=2")).rows[0].group_uid;
  assert.equal(u2b, second, "partial-run retry converges on the same \\x1f1 slot, no crash");
});

test("C1 no literal-name mismerge (R2 F1a): a group literally named 'Family#2' coexists with two 'Family' groups — three DISTINCT uids, idempotent re-run", async () => {
  const m = freshMgr("lit", "local-6"); const db = m.db;
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (1,'Family','s1'),(2,'Family','s2'),(3,'Family#2','s3')" });
  await db.execute("UPDATE contact_groups SET group_uid = NULL");
  assert.equal(await m._assignDeterministicGroupUids(), 3, "all three assigned");
  const uids = (await db.execute("SELECT group_uid FROM contact_groups ORDER BY id ASC")).rows.map((r) => r.group_uid);
  assert.equal(new Set(uids).size, 3, "three DISTINCT uids — no cross-group mismerge");
  const literal = createHash("sha256").update(`${TEST_PUB_HEX}:family#2`).digest("hex").slice(0, 32);
  assert.equal(uids[2], literal, "'Family#2' keeps ITS OWN base hash — never confused with dup-slot-2 of 'Family' (which is \\x1f-keyed)");
  assert.equal(uids[1], createHash("sha256").update(`${TEST_PUB_HEX}:family\x1f1`).digest("hex").slice(0, 32), "dup-slot-2 of 'Family' is \\x1f1, disjoint from the literal name's hash");
  // Idempotent re-run: nothing left NULL, nothing re-derived.
  assert.equal(await m._assignDeterministicGroupUids(), 0, "re-run is a no-op");
  const again = (await db.execute("SELECT group_uid FROM contact_groups ORDER BY id ASC")).rows.map((r) => r.group_uid);
  assert.deepEqual(again, uids, "uids stable across re-runs");
});
