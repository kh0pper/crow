// Crow Mail's one-account-one-instance claims (plan 1, Task 17). Synced dashboard settings are
// last-writer-wins per key, so one shared key per address cannot hold two claims; each instance
// writes only its OWN key and the winner is a pure function of the whole set (RF6). The claim value
// carries an instance id, a display name and a time — never the address, a host or a username.
//
// Unit tests build the mail tables from MAIL_DDL plus the two settings tables and crow_instances in a
// scratch DB; the fleet tests drive the real replication path through tests/fixtures/sync-fleet.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import { SYNC_ALLOWLIST, isSyncable } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { setSettingsSyncManager, writeSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { createAccount } from "../servers/gateway/mail/store/accounts.js";
import {
  addressHash, claimKey, writeClaim, releaseClaim, listClaims, pickClaimWinner, checkClaim,
  makeIsClaimedElsewhere, listForeignClaims, claimedElsewhereSentence, refreshClaim,
} from "../servers/gateway/mail/claims.js";
import { makeFleet, linkPeers, until, sleep } from "./fixtures/sync-fleet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAIMS_SRC = readFileSync(join(HERE, "..", "servers", "gateway", "mail", "claims.js"), "utf8");

// The real shapes, trimmed to what claims.js reads: dashboard_settings keeps its lamport_ts column
// (the sync apply path writes it) and crow_instances keeps the statuses the liveness query filters.
const SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS dashboard_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    lamport_ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dashboard_settings_overrides (
    key TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    lamport_ts INTEGER DEFAULT 0,
    PRIMARY KEY (key, instance_id)
  );
  CREATE TABLE IF NOT EXISTS crow_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    crow_id TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    trusted INTEGER DEFAULT 1,
    last_seen_at TEXT
  );
`;

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-claims-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL + SETTINGS_DDL);
  return db;
}

const ADDRESS = "alex@example.com";
const LOCAL = "instA";
const PEER = "instB";

async function addInstance(db, id, { name = id, status = "active" } = {}) {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, 'crow:claims', ?)",
    args: [id, name, status],
  });
}

async function settingRows(db, like = "mail_claim%") {
  const { rows } = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE ?",
    args: [like],
  });
  return rows;
}

/** A recording manager: writeSetting's emit door needs feedsDisabled === false to pass through. */
function recorder() {
  const emits = [];
  return {
    emits,
    mgr: { feedsDisabled: false, emitChange: async (table, op, row) => { emits.push({ table, op, row }); return 1; } },
  };
}

/* ------------------------------------------------------------------ keys */

test("addressHash is 32 hex, stable across case and whitespace, and never the address", () => {
  const hash = addressHash(ADDRESS);
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(addressHash("  Alex@Example.COM  "), hash);
  assert.notEqual(addressHash("sam@example.com"), hash);
  assert.equal(hash.includes("alex"), false);
  assert.equal(hash.includes("example"), false);

  const key = claimKey(ADDRESS, LOCAL);
  assert.equal(key, `mail_claim_${hash}_${LOCAL}`);
  assert.equal(key.includes("@"), false);
  assert.equal(key.toLowerCase().includes("alex"), false);
  assert.equal(key.includes("example"), false);
  assert.equal(key, claimKey("ALEX@example.com ", LOCAL), "the same key for the same address");
  assert.notEqual(claimKey(ADDRESS, PEER), key, "one key per instance");
  assert.equal(isSyncable(key), true);
});

/* ------------------------------------------------------------------ claims */

test("no claim is ok, our own claim is ok, another instance's earlier claim is refused by name", async () => {
  const db = await freshDb();
  await addInstance(db, PEER, { name: "Studio" });

  assert.deepEqual(await checkClaim(db, ADDRESS, { localInstanceId: LOCAL }), { ok: true });
  assert.deepEqual(await listClaims(db, ADDRESS), []);

  await writeClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home", now: 2_000 });
  assert.deepEqual(await checkClaim(db, ADDRESS, { localInstanceId: LOCAL }), { ok: true });

  await writeClaim(db, ADDRESS, { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });
  const verdict = await checkClaim(db, ADDRESS, { localInstanceId: LOCAL });
  assert.deepEqual(verdict, { ok: false, instanceName: "Studio" });
  assert.equal(claimedElsewhereSentence(verdict.instanceName), "This account is already connected on Studio");
  assert.deepEqual(await checkClaim(db, ADDRESS, { localInstanceId: PEER }), { ok: true });

  await releaseClaim(db, ADDRESS, { localInstanceId: PEER });
  assert.deepEqual(await checkClaim(db, ADDRESS, { localInstanceId: LOCAL }), { ok: true });
});

test("RF5: a case- or whitespace-different spelling is the same address", async () => {
  const db = await freshDb();
  await addInstance(db, PEER, { name: "Studio" });
  await writeClaim(db, ADDRESS, { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });

  assert.equal((await listClaims(db, " ALEX@Example.com ")).length, 1);
  assert.deepEqual(
    await checkClaim(db, "Alex@Example.com", { localInstanceId: LOCAL }),
    { ok: false, instanceName: "Studio" },
  );
  assert.deepEqual(await checkClaim(db, "alex@example.com", { localInstanceId: PEER }), { ok: true });
});

test("the claim is a global syncable settings row holding no address, host or username", async () => {
  const db = await freshDb();
  await writeClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home", now: 1_000 });

  const rows = await settingRows(db);
  assert.equal(rows.length, 1);
  const [{ key, value }] = rows;
  assert.equal(key, claimKey(ADDRESS, LOCAL));
  assert.equal(isSyncable(key), true);
  const overrides = await db.execute("SELECT 1 FROM dashboard_settings_overrides");
  assert.equal(overrides.rows.length, 0, "the claim never lands in a per-instance override");

  assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ["claimedAt", "instanceId", "instanceName"]);
  for (const needle of ["@", "alex", "example", addressHash(ADDRESS), "127.0.0.1"]) {
    assert.equal(value.toLowerCase().includes(needle.toLowerCase()), false, `the value holds ${needle}`);
  }
  assert.deepEqual(JSON.parse(value), { instanceId: LOCAL, instanceName: "Home", claimedAt: 1_000 });
});

test("writeClaim fails closed and mail_claim_* is the only mail pattern in the allowlist", async () => {
  assert.equal(CLAIMS_SRC.includes("allowLocalFallback: false"), true);

  const db = await freshDb();
  await assert.rejects(
    () => writeSetting(db, "mail_not_a_claim_key", "x", { scope: "global", allowLocalFallback: false }),
    (err) => { assert.equal(err.code, "NotSyncable"); return true; },
  );
  assert.equal((await settingRows(db)).length, 0, "a refused key stores nothing");

  const mailPatterns = Object.keys(SYNC_ALLOWLIST).filter((p) => /mail/i.test(p));
  assert.deepEqual(mailPatterns, ["mail_claim_*"]);
  const description = SYNC_ALLOWLIST["mail_claim_*"];
  assert.match(description, /hash/i);
  assert.match(description, /address/i);
});

test("pickClaimWinner is a pure function of the set: earlier claimedAt, then lower instanceId", () => {
  const claim = (instanceId, claimedAt, over = {}) => ({ instanceId, claimedAt, released: false, ...over });
  const live = new Set([LOCAL, PEER, "instC"]);

  assert.equal(pickClaimWinner([], { liveInstanceIds: live }), null);
  assert.equal(pickClaimWinner([
    claim(PEER, 2_000, { released: true }),
    claim("instC", 3_000, { released: true }),
  ], { liveInstanceIds: live }), null);

  const earlier = pickClaimWinner([claim(PEER, 1_000), claim(LOCAL, 2_000)], { liveInstanceIds: live });
  assert.equal(earlier.instanceId, PEER);

  const tie = pickClaimWinner([claim(PEER, 1_000), claim(LOCAL, 1_000)], { liveInstanceIds: live });
  assert.equal(tie.instanceId, LOCAL, "the lower instance id wins a tie");

  const tombstoned = pickClaimWinner([
    claim(PEER, 1_000, { released: true }),
    claim(LOCAL, 2_000),
  ], { liveInstanceIds: live });
  assert.equal(tombstoned.instanceId, LOCAL);

  const dead = pickClaimWinner([
    claim("instC", 500),
    claim(LOCAL, 2_000),
  ], { liveInstanceIds: new Set([LOCAL, PEER]) });
  assert.equal(dead.instanceId, LOCAL, "a claim from an instance that is not live never wins");

  // Same order in, same winner out, whatever the array order is.
  const setA = [claim(PEER, 1_000), claim(LOCAL, 1_000), claim("instC", 900)];
  const setB = [setA[2], setA[0], setA[1]];
  assert.equal(pickClaimWinner(setA, { liveInstanceIds: live }).instanceId, "instC");
  assert.equal(pickClaimWinner(setB, { liveInstanceIds: live }).instanceId, "instC");
});

test("makeIsClaimedElsewhere: false for the winner, true with a name for the loser", async () => {
  const db = await freshDb();
  await addInstance(db, PEER, { name: "Studio" });
  await writeClaim(db, ADDRESS, { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });

  const onLoser = makeIsClaimedElsewhere(db, { localInstanceId: LOCAL });
  assert.deepEqual(await onLoser({ id: "ma-1", address: ADDRESS }), { claimed: true, instanceName: "Studio" });
  assert.deepEqual(await onLoser("Alex@Example.com"), { claimed: true, instanceName: "Studio" });
  assert.deepEqual(await onLoser({ id: "ma-2", address: "sam@example.com" }), { claimed: false, instanceName: null });

  const onWinner = makeIsClaimedElsewhere(db, { localInstanceId: PEER });
  assert.deepEqual(await onWinner({ id: "ma-1", address: ADDRESS }), { claimed: false, instanceName: null });

  await releaseClaim(db, ADDRESS, { localInstanceId: PEER });
  assert.deepEqual(await onLoser({ id: "ma-1", address: ADDRESS }), { claimed: false, instanceName: null });
});

test("listForeignClaims names the other instance without a hash", async () => {
  const db = await freshDb();
  await addInstance(db, PEER, { name: "Studio" });
  await writeClaim(db, ADDRESS, { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });
  await writeClaim(db, "sam@example.com", { localInstanceId: LOCAL, instanceName: "Home", now: 1_000 });

  const foreign = await listForeignClaims(db, { localInstanceId: LOCAL });
  assert.deepEqual(foreign, [{ instanceName: "Studio", claimedAt: 1_000 }]);
  const shape = JSON.stringify(foreign);
  assert.equal(shape.includes(addressHash(ADDRESS)), false);
  assert.equal(shape.includes("mail_claim"), false);
  assert.equal(shape.includes("@"), false);

  await releaseClaim(db, ADDRESS, { localInstanceId: PEER });
  assert.deepEqual(await listForeignClaims(db, { localInstanceId: LOCAL }), []);
});

test("listClaims does not return a key whose hash only matched the LIKE wildcards", async () => {
  const db = await freshDb();
  const hash = addressHash(ADDRESS);
  // `_` is a LIKE wildcard, so this key matches `mail_claim_<hash>_%` without carrying the prefix.
  const lookalike = `mailXclaimY${hash}Zpeer`;
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [lookalike, JSON.stringify({ instanceId: PEER, instanceName: "Studio", claimedAt: 1_000 })],
  });
  const matched = await db.execute({
    sql: "SELECT 1 FROM dashboard_settings WHERE key LIKE ?",
    args: [`mail_claim_${hash}_%`],
  });
  assert.equal(matched.rows.length, 1, "the row does match the LIKE pattern");

  assert.deepEqual(await listClaims(db, ADDRESS), []);
  assert.deepEqual(await checkClaim(db, ADDRESS, { localInstanceId: LOCAL }), { ok: true });
});

test("a claim from a revoked or absent instance is ignored and the next claim wins", async () => {
  const db = await freshDb();
  await addInstance(db, PEER, { name: "Studio", status: "revoked" });
  await writeClaim(db, ADDRESS, { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });
  await writeClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home", now: 2_000 });
  assert.deepEqual(await checkClaim(db, ADDRESS, { localInstanceId: LOCAL }), { ok: true });

  const empty = await freshDb();
  await writeClaim(empty, ADDRESS, { localInstanceId: "instZ", instanceName: "Ghost", now: 1_000 });
  await writeClaim(empty, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home", now: 2_000 });
  assert.deepEqual(await checkClaim(empty, ADDRESS, { localInstanceId: LOCAL }), { ok: true });
});

/* ------------------------------------------------------------------ refreshClaim */

test("refreshClaim re-writes only this instance's own live claim, with claimedAt stable", async () => {
  const db = await freshDb();
  const { emits, mgr } = recorder();
  setSettingsSyncManager(mgr);
  try {
    assert.equal(await refreshClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home" }), false);
    assert.deepEqual(await listClaims(db, ADDRESS), [], "a refresh never invents a claim");

    await writeClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home", now: 1_000 });
    emits.length = 0;
    assert.equal(await refreshClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home by the sea" }), true);
    const [claim] = await listClaims(db, ADDRESS);
    assert.equal(claim.claimedAt, 1_000);
    assert.equal(claim.instanceName, "Home by the sea");
    assert.equal(emits.length, 1, "the re-write reaches the settings emit door");
    assert.equal(emits[0].row.key, claimKey(ADDRESS, LOCAL));

    await releaseClaim(db, ADDRESS, { localInstanceId: LOCAL });
    emits.length = 0;
    assert.equal(await refreshClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home" }), false);
    const [tombstone] = await listClaims(db, ADDRESS);
    assert.equal(tombstone.released, true);
    assert.equal(emits.length, 0, "a tombstone is never re-written");
  } finally {
    setSettingsSyncManager(null);
  }
});

test("refreshClaim refuses a row under its own key that another instance wrote", async () => {
  const db = await freshDb();
  const value = JSON.stringify({ instanceId: PEER, instanceName: "Studio", claimedAt: 1_000 });
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [claimKey(ADDRESS, LOCAL), value],
  });
  setSettingsSyncManager(null);
  assert.equal(await refreshClaim(db, ADDRESS, { localInstanceId: LOCAL, instanceName: "Home" }), false);
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [claimKey(ADDRESS, LOCAL)],
  });
  assert.equal(rows[0].value, value);
});

/* ------------------------------------------------------------------ fleet */

const inputs = (label, address) => ({
  label,
  address,
  imap: { host: "mail.example.test", port: 993, security: "ssl" },
  smtp: { host: "mail.example.test", port: 465, security: "ssl" },
});

test("fleet: a claim on A reaches B, and B refuses the address", async () => {
  const fleet = await makeFleet({ ids: [LOCAL, PEER] });
  let link;
  try {
    const { a, b } = fleet;
    setSettingsSyncManager(a.mgr);
    await writeClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home", now: 1_000 });

    link = await linkPeers(a, b);
    assert.ok(await until(async () => (await listClaims(b.db, ADDRESS)).length === 1), "B receives A's claim");

    assert.deepEqual(
      await checkClaim(b.db, ADDRESS, { localInstanceId: b.id }),
      { ok: false, instanceName: "Home" },
    );
    const isClaimedElsewhere = makeIsClaimedElsewhere(b.db, { localInstanceId: b.id });
    assert.equal((await isClaimedElsewhere({ address: ADDRESS })).claimed, true);
    assert.deepEqual(await checkClaim(a.db, ADDRESS, { localInstanceId: a.id }), { ok: true });
    assert.deepEqual(await listForeignClaims(b.db, { localInstanceId: b.id }), [{ instanceName: "Home", claimedAt: 1_000 }]);
  } finally {
    setSettingsSyncManager(null);
    link?.close();
    await fleet.cleanup();
  }
});

test("fleet: a peer paired after the claim receives it once the claim is refreshed", async () => {
  const fleet = await makeFleet({ ids: [LOCAL, PEER] });
  let link;
  try {
    const { a, b } = fleet;
    setSettingsSyncManager(a.mgr);
    await writeClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home", now: 1_000 });

    link = await linkPeers(a, b);
    await sleep(300);
    assert.ok((await listClaims(b.db, ADDRESS)).length <= 1, "nothing more than the one claim can arrive");

    setSettingsSyncManager(a.mgr);
    assert.equal(await refreshClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home" }), true);
    assert.ok(await until(async () => (await listClaims(b.db, ADDRESS)).length === 1), "the refresh delivers it");
    const [claim] = await listClaims(b.db, ADDRESS);
    assert.equal(claim.instanceId, a.id);
    assert.equal(claim.claimedAt, 1_000, "claimedAt is stable across the refresh");
  } finally {
    setSettingsSyncManager(null);
    link?.close();
    await fleet.cleanup();
  }
});

test("fleet: a mail_accounts row never reaches B", async () => {
  const fleet = await makeFleet({ ids: [LOCAL, PEER] });
  let link;
  try {
    const { a, b } = fleet;
    const account = await createAccount(a.db, inputs("Home mail", ADDRESS));
    link = await linkPeers(a, b);
    setSettingsSyncManager(a.mgr);
    const emitted = await a.mgr.emitChange("mail_accounts", "insert", { ...account });
    assert.equal(emitted, null, "the mail tables are local-only on the emit path");
    await sleep(300);
    const { rows } = await b.db.execute("SELECT id FROM mail_accounts");
    assert.deepEqual(rows, []);
  } finally {
    setSettingsSyncManager(null);
    link?.close();
    await fleet.cleanup();
  }
});

test("fleet RF6: an equal-claimedAt partition converges on one winner on both sides", async () => {
  const fleet = await makeFleet({ ids: [LOCAL, PEER] });
  let link;
  try {
    const { a, b } = fleet;
    const T = 1_700_000_000_000;
    setSettingsSyncManager(a.mgr);
    await writeClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home", now: T });
    setSettingsSyncManager(b.mgr);
    await writeClaim(b.db, ADDRESS, { localInstanceId: b.id, instanceName: "Studio", now: T });
    assert.equal((await listClaims(a.db, ADDRESS)).length, 1, "partitioned: each side sees only its own claim");
    assert.equal((await listClaims(b.db, ADDRESS)).length, 1);

    link = await linkPeers(a, b);
    setSettingsSyncManager(a.mgr);
    await refreshClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home" });
    setSettingsSyncManager(b.mgr);
    await refreshClaim(b.db, ADDRESS, { localInstanceId: b.id, instanceName: "Studio" });
    assert.ok(await until(async () =>
      (await listClaims(a.db, ADDRESS)).length === 2 && (await listClaims(b.db, ADDRESS)).length === 2,
    ), "both sides hold both claims");

    const onA = await makeIsClaimedElsewhere(a.db, { localInstanceId: a.id })({ address: ADDRESS });
    const onB = await makeIsClaimedElsewhere(b.db, { localInstanceId: b.id })({ address: ADDRESS });
    assert.deepEqual(onA, { claimed: false, instanceName: null }, "the lower instance id wins the tie");
    assert.deepEqual(onB, { claimed: true, instanceName: "Home" });
    assert.equal([onA, onB].filter((v) => v.claimed).length, 1, "exactly one side loses");

    // Re-syncing the same values changes nothing.
    setSettingsSyncManager(a.mgr);
    await refreshClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home" });
    setSettingsSyncManager(b.mgr);
    await refreshClaim(b.db, ADDRESS, { localInstanceId: b.id, instanceName: "Studio" });
    await sleep(400);
    for (const side of [a, b]) {
      const claims = await listClaims(side.db, ADDRESS);
      assert.equal(claims.length, 2);
      assert.deepEqual(claims.map((c) => [c.instanceId, c.claimedAt]).sort(), [[LOCAL, T], [PEER, T]]);
    }
    assert.equal(
      (await makeIsClaimedElsewhere(a.db, { localInstanceId: a.id })({ address: ADDRESS })).claimed,
      false,
    );
    assert.equal(
      (await makeIsClaimedElsewhere(b.db, { localInstanceId: b.id })({ address: ADDRESS })).claimed,
      true,
    );
  } finally {
    setSettingsSyncManager(null);
    link?.close();
    await fleet.cleanup();
  }
});

test("fleet: after the winner's tombstone syncs, the loser wins on both sides", async () => {
  const fleet = await makeFleet({ ids: [LOCAL, PEER] });
  let link;
  try {
    const { a, b } = fleet;
    const T = 1_700_000_000_000;
    setSettingsSyncManager(a.mgr);
    await writeClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home", now: T });
    setSettingsSyncManager(b.mgr);
    await writeClaim(b.db, ADDRESS, { localInstanceId: b.id, instanceName: "Studio", now: T + 1_000 });

    link = await linkPeers(a, b);
    setSettingsSyncManager(a.mgr);
    await refreshClaim(a.db, ADDRESS, { localInstanceId: a.id, instanceName: "Home" });
    setSettingsSyncManager(b.mgr);
    await refreshClaim(b.db, ADDRESS, { localInstanceId: b.id, instanceName: "Studio" });
    assert.ok(await until(async () =>
      (await listClaims(b.db, ADDRESS)).length === 2 && (await listClaims(a.db, ADDRESS)).length === 2,
    ));
    assert.deepEqual(await checkClaim(a.db, ADDRESS, { localInstanceId: a.id }), { ok: true });

    setSettingsSyncManager(a.mgr);
    await releaseClaim(a.db, ADDRESS, { localInstanceId: a.id });
    assert.ok(await until(async () =>
      (await listClaims(b.db, ADDRESS)).some((c) => c.instanceId === a.id && c.released === true),
    ), "the tombstone reaches B");

    assert.deepEqual(await checkClaim(b.db, ADDRESS, { localInstanceId: b.id }), { ok: true });
    assert.deepEqual(
      await checkClaim(a.db, ADDRESS, { localInstanceId: a.id }),
      { ok: false, instanceName: "Studio" },
      "A now sees B as the holder",
    );
    assert.deepEqual(await listForeignClaims(a.db, { localInstanceId: a.id }), [{ instanceName: "Studio", claimedAt: T + 1_000 }]);
  } finally {
    setSettingsSyncManager(null);
    link?.close();
    await fleet.cleanup();
  }
});