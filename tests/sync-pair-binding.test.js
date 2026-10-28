/**
 * PT-2a Task 3: the sync pair-binding core (servers/shared/sync-pair-binding.js).
 * U-P1 MAC known-answer vectors, U-P2 the policy matrix, U-P3 pins (fail
 * closed), U-P4 the production key lookup, U-P5 sync cannot touch a pin
 * (a regression test, expected-green on main), U-P6 the mode, plus the Nest
 * health records. See the private engineering notes for the design.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pairSubkey, tailnetRespMac, tailnetProofMac, hyperswarmMac, macEqual,
  defaultPairKey, pairBindingMode, isPairPinned, markPairPinned,
  decidePairBinding, recordPairBindingState, _resetPairBindingModeLog, decideAndRecordPairBinding,
} from "../servers/shared/sync-pair-binding.js";
import { SYNC_PB_KEY_PREFIX, SYNC_PB_CLEARED_PREFIX } from "../servers/shared/self-dial-address.js";
import { getPeerTrustHealth, _resetPeerTrustHealth } from "../servers/shared/peer-trust-health.js";
import { sign } from "../servers/sharing/identity.js";
import { makeRealDb, makeFleet } from "./fixtures/sync-fleet.mjs";

const dirs = [];
function scratch(label) {
  const d = mkdtempSync(join(tmpdir(), `sync-pb-${label}-`));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const LOCAL = "inst-local-0000-0000-000000000001";
const PEER = "inst-peer-0000-0000-000000000002";

// Vectors computed independently (Python hmac/hashlib), not by this module.
const SK = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const K_HEX = "9e315a6df835c83bac1e5a942f5f770b7d05e48b477f966a07556d12bcc98cd2";
const S = "inst-server-01";
const C = "inst-client-02";
const CN = "a1".repeat(16);
const SN = "b2".repeat(16);
const CH = "c3".repeat(32);
const HH = "d4".repeat(32);

// ── U-P1 ───────────────────────────────────────────────────────────────────
test("U-P1 MAC known-answer vectors", () => {
  const k = pairSubkey(SK);
  assert.ok(Buffer.isBuffer(k));
  assert.equal(k.toString("hex"), K_HEX, "the subkey is keyed by the DECODED 32 bytes (M5)");
  assert.notEqual(k.toString("hex"), "755272fb401d9d8e6e7ea9be6b9ebe3850d47cfd1ef83a439f559264849def3f", "not the utf-8 hex string");

  const resp = tailnetRespMac(k, { server: S, client: C, cN: CN, sN: SN });
  const proof = tailnetProofMac(k, { client: C, server: S, sN: SN, cN: CN });
  const hs = hyperswarmMac(k, { responder: S, challenger: C, challenge: CH, handshakeHash: HH });
  assert.equal(resp, "8a09091609a5480c1755fa2466dd0198985930c3f7cebd25ad871c1d873b4afb");
  assert.equal(proof, "d833a7aff9f8d6a5c1cdf149e974bf33e437682637ca4d3245f5d5b36c1696d5");
  assert.equal(hs, "1e3f4aad085672f6593449a06e243884af1f027c473362f40ef8c13d1374bbd4");

  // Swapping any two fields changes the MAC.
  const swaps = (fn, base) => {
    const keys = Object.keys(base);
    const ref = fn(k, base);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const o = { ...base, [keys[i]]: base[keys[j]], [keys[j]]: base[keys[i]] };
        assert.notEqual(fn(k, o), ref, `${fn.name}: swapping ${keys[i]}/${keys[j]}`);
      }
    }
  };
  swaps(tailnetRespMac, { server: S, client: C, cN: CN, sN: SN });
  swaps(tailnetProofMac, { client: C, server: S, sN: SN, cN: CN });
  swaps(hyperswarmMac, { responder: S, challenger: C, challenge: CH, handshakeHash: HH });
  // The two tailnet directions never stand in for each other.
  assert.notEqual(resp, tailnetProofMac(k, { client: S, server: C, sN: CN, cN: SN }));

  // A subkey MAC never equals signRequest's HMAC (raw decoded signing key) over the same bytes.
  const raw = Buffer.from(SK, "hex");
  for (const [label, mac] of [
    [`pb-resp\n${S}\n${C}\n${CN}\n${SN}`, resp],
    [`pb-proof\n${C}\n${S}\n${SN}\n${CN}`, proof],
    [`hs-pb\n${S}\n${C}\n${CH}\n${HH}`, hs],
  ]) {
    assert.notEqual(createHmac("sha256", raw).update(label).digest("hex"), mac);
  }

  // Newlines and non-strings are rejected; a bad key never yields a subkey.
  assert.throws(() => tailnetRespMac(k, { server: "a\nb", client: C, cN: CN, sN: SN }), /newline/);
  assert.throws(() => hyperswarmMac(k, { responder: S, challenger: C, challenge: 1, handshakeHash: HH }), TypeError);
  for (const bad of ["", "zz", "abc", null, undefined, 7]) assert.throws(() => pairSubkey(bad), TypeError, String(bad));

  // macEqual: constant-time, length checked, strings only.
  assert.equal(macEqual(resp, resp), true);
  assert.equal(macEqual(resp, proof), false);
  assert.equal(macEqual(resp, resp.slice(1)), false);
  assert.equal(macEqual(resp, undefined), false);
  assert.equal(macEqual(null, resp), false);
  assert.equal(macEqual({}, resp), false);
});

// ── U-P2 ───────────────────────────────────────────────────────────────────
test("U-P2 decidePairBinding: every row of the policy table", () => {
  const d = (o) => decidePairBinding({ bound: false, macInvalid: false, pinned: false, mode: "auto", ...o });
  // 1. bound → ok, whatever the pin and mode.
  for (const pinned of [false, true]) for (const mode of ["auto", "require"]) {
    assert.deepEqual(d({ bound: true, pinned, mode }), { ok: true, legacy: false, reason: null });
  }
  // 2. MAC present but invalid → pb_invalid, never legacy.
  for (const pinned of [false, true]) for (const mode of ["auto", "require"]) {
    assert.deepEqual(d({ macInvalid: true, pinned, mode }), { ok: false, legacy: false, reason: "pb_invalid" });
  }
  // 3. unbound + pinned → pb_required_pinned (even in auto).
  for (const mode of ["auto", "require"]) {
    assert.deepEqual(d({ pinned: true, mode }), { ok: false, legacy: false, reason: "pb_required_pinned" });
  }
  // 4. unbound, unpinned, auto → legacy.
  assert.deepEqual(d({ mode: "auto" }), { ok: true, legacy: true, reason: null });
  // 5. unbound, unpinned, require → pb_required.
  assert.deepEqual(d({ mode: "require" }), { ok: false, legacy: false, reason: "pb_required" });
  // Anything that is not exactly "auto" is require.
  for (const mode of [undefined, "", "off", "AUTO"]) assert.equal(d({ mode }).reason, "pb_required", String(mode));
});

// ── U-P3 ───────────────────────────────────────────────────────────────────
test("U-P3 isPairPinned fails closed; markPairPinned writes the LOCAL pin", async () => {
  const boom = { execute: async () => { throw new Error("SQLITE_BUSY: database is locked"); } };
  assert.equal(await isPairPinned(boom, LOCAL, PEER), true, "a DB error counts as pinned");
  assert.equal(await isPairPinned(null, LOCAL, PEER), true, "no db counts as pinned");
  const db = await makeRealDb(scratch("pins"));
  assert.equal(await isPairPinned(db, null, PEER), true, "a missing local id counts as pinned (M2)");
  assert.equal(await isPairPinned(db, "", PEER), true);
  const noTable = { execute: async () => { throw new Error("SQLITE_ERROR: no such table: dashboard_settings_overrides"); } };
  assert.equal(await isPairPinned(noTable, LOCAL, PEER), false, "an old DB (no table) is not pinned");

  assert.equal(await isPairPinned(db, LOCAL, PEER), false);
  assert.equal(await markPairPinned(db, LOCAL, PEER), true, "newly written");
  assert.equal(await markPairPinned(db, LOCAL, PEER), false, "already pinned");
  assert.equal(await isPairPinned(db, LOCAL, PEER), true);
  assert.equal(await markPairPinned(db, null, PEER), false, "no write without a local id");
  assert.equal(await markPairPinned(boom, LOCAL, PEER), false, "a write error is not a new pin");

  const { rows } = await db.execute("SELECT key, instance_id, value FROM dashboard_settings_overrides WHERE key LIKE 'sync_pair_bound:%'");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ key: `${SYNC_PB_KEY_PREFIX}${PEER}`, instance_id: LOCAL, value: "1" }]);
  assert.equal(SYNC_PB_KEY_PREFIX, "sync_pair_bound:");
  // Another instance's pin in the same DB is not ours.
  assert.equal(await isPairPinned(db, "inst-other", PEER), false);
});

test("U-P3b a new pin removes the LOCAL clear-pin marker (and only that one)", async () => {
  assert.equal(SYNC_PB_CLEARED_PREFIX, "sync_pair_cleared:");
  const db = await makeRealDb(scratch("marker"));
  const put = (key, inst) => db.execute({
    sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, ?, ?)",
    args: [key, inst, "2026-10-28T00:00:00.000Z"],
  });
  await put(`${SYNC_PB_CLEARED_PREFIX}${PEER}`, LOCAL);
  await put(`${SYNC_PB_CLEARED_PREFIX}${PEER}`, "inst-other");
  await put(`${SYNC_PB_CLEARED_PREFIX}inst-third`, LOCAL);
  const markers = async () => (await db.execute("SELECT key, instance_id FROM dashboard_settings_overrides WHERE key LIKE 'sync_pair_cleared:%' ORDER BY key, instance_id")).rows.map((r) => `${r.key}@${r.instance_id}`);

  assert.equal(await markPairPinned(db, LOCAL, PEER), true);
  assert.deepEqual(await markers(), [`${SYNC_PB_CLEARED_PREFIX}${PEER}@inst-other`, `${SYNC_PB_CLEARED_PREFIX}inst-third@${LOCAL}`]);

  // An already-present pin leaves a marker alone (it was not newly written).
  await put(`${SYNC_PB_CLEARED_PREFIX}${PEER}`, LOCAL);
  assert.equal(await markPairPinned(db, LOCAL, PEER), false);
  assert.ok((await markers()).includes(`${SYNC_PB_CLEARED_PREFIX}${PEER}@${LOCAL}`));
});

// ── U-P4 ───────────────────────────────────────────────────────────────────
test("U-P4 defaultPairKey: mode 0600 only, own valid ids only; a pinned peer without a key is refused", async () => {
  const dir = scratch("store");
  const path = join(dir, "peer-tokens.json");
  const store = `{
    "${PEER}": { "signing_key": "${SK}" },
    "constructor": { "signing_key": "${"ab".repeat(32)}" },
    "__proto__": { "signing_key": "${"cd".repeat(32)}" },
    "bad id": { "signing_key": "${"ef".repeat(32)}" },
    "no-key": { "auth_token": "x" }
  }`;
  writeFileSync(path, store, { mode: 0o600 });
  chmodSync(path, 0o600);
  const prev = process.env.CROW_PEER_TOKENS_PATH;
  process.env.CROW_PEER_TOKENS_PATH = path;
  const origWarn = console.warn;
  try {
    assert.equal(defaultPairKey(PEER), SK);
    assert.equal(defaultPairKey("constructor"), "ab".repeat(32), "an own entry named constructor is a real id");
    assert.equal(defaultPairKey("__proto__"), null, "fails ENROLL_ID_RE (M6)");
    assert.equal(defaultPairKey("bad id"), null, "fails ENROLL_ID_RE");
    assert.equal(defaultPairKey("no-key"), null);
    assert.equal(defaultPairKey("absent"), null);
    assert.equal(defaultPairKey("toString"), null, "never indexes the prototype");
    for (const bad of [null, undefined, 5, {}]) assert.equal(defaultPairKey(bad), null);

    // Re-read on every call: a constructor-free store makes it null.
    writeFileSync(path, `{ "${PEER}": { "signing_key": "${SK}" } }`);
    assert.equal(defaultPairKey("constructor"), null, "Object.hasOwn: the prototype's constructor is never a key");

    // A loose store mode reads as no keys at all.
    chmodSync(path, 0o644);
    console.warn = () => {};
    assert.equal(defaultPairKey(PEER), null, "mode 0644 → no key");
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.CROW_PEER_TOKENS_PATH; else process.env.CROW_PEER_TOKENS_PATH = prev;
  }

  // No key + a pin → refused loudly, with "re-pair to fix".
  const r = decidePairBinding({ bound: false, macInvalid: false, pinned: true, mode: "auto" });
  assert.deepEqual(r, { ok: false, legacy: false, reason: "pb_required_pinned" });
  _resetPeerTrustHealth();
  recordPairBindingState(PEER, { ...r, bound: false, noKey: true });
  const ref = getPeerTrustHealth().pairBindingRefusals[PEER];
  assert.equal(ref.reason, "pb_required_pinned");
  assert.match(ref.message, /no pair key/);
  assert.match(ref.message, /re-pair to fix/);
  _resetPeerTrustHealth();
});

// ── U-P5 ───────────────────────────────────────────────────────────────────
// REGRESSION TEST, expected-green on main (M3): dashboard_settings_overrides
// is never a synced table, so an inbound entry can never write or delete a
// pin. This pins that property against a future change to the sync tables.
test("U-P5 (regression, expected-green on main) inbound sync never writes or deletes a pin row", async () => {
  const fleet = await makeFleet({ ids: ["inst-pb-a", "inst-pb-b"] });
  try {
    const { a, b, identity } = fleet;
    const pinKey = `${SYNC_PB_KEY_PREFIX}${a.id}`;
    assert.equal(await markPairPinned(b.db, b.id, a.id), true);
    const pinRow = async () => (await b.db.execute({
      sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
      args: [pinKey, b.id],
    })).rows.map((r) => r.value);

    let lamport = 1000;
    const entry = (table, op, row) => {
      const e = { table, op, row, lamport_ts: ++lamport, instance_id: a.id };
      return { ...e, signature: sign(JSON.stringify(e), identity.ed25519Priv) };
    };
    const stream = [
      entry("dashboard_settings_overrides", "delete", { key: pinKey, instance_id: b.id }),
      entry("dashboard_settings_overrides", "insert", { key: pinKey, instance_id: b.id, value: "0" }),
      entry("dashboard_settings_overrides", "update", { key: pinKey, instance_id: b.id, value: "0" }),
      entry("dashboard_settings", "insert", { key: pinKey, value: "0" }),
      entry("dashboard_settings", "delete", { key: pinKey }),
      // Positive control: an allowlisted synced setting from the same stream applies.
      entry("dashboard_settings", "insert", { key: "nav_groups", value: '["pb-control"]' }),
    ];
    for (const e of stream) await b.mgr._applyEntry(a.id, JSON.parse(JSON.stringify(e)));

    assert.deepEqual(await pinRow(), ["1"], "the LOCAL pin row is unchanged");
    assert.equal(await isPairPinned(b.db, b.id, a.id), true);
    const g = await b.db.execute({ sql: "SELECT key, value FROM dashboard_settings WHERE key IN (?, ?)", args: [pinKey, "nav_groups"] });
    assert.deepEqual(g.rows.map((r) => ({ ...r })), [{ key: "nav_groups", value: '["pb-control"]' }], "control applied, no global pin key");
  } finally {
    await fleet.cleanup();
  }
});

// ── U-P6 ───────────────────────────────────────────────────────────────────
test("U-P6 pairBindingMode: auto by default in PT-2a, an unknown value is require (logged once)", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    _resetPairBindingModeLog();
    assert.equal(pairBindingMode({}), "auto");
    assert.equal(pairBindingMode({ CROW_SYNC_PAIR_BINDING: "" }), "auto");
    assert.equal(pairBindingMode({ CROW_SYNC_PAIR_BINDING: "auto" }), "auto");
    assert.equal(pairBindingMode({ CROW_SYNC_PAIR_BINDING: "require" }), "require");
    assert.equal(warns.length, 0);
    assert.equal(pairBindingMode({ CROW_SYNC_PAIR_BINDING: "off" }), "require");
    assert.equal(pairBindingMode({ CROW_SYNC_PAIR_BINDING: "off" }), "require");
    assert.equal(pairBindingMode({ CROW_SYNC_PAIR_BINDING: "Auto" }), "require");
    assert.equal(warns.length, 1, "logged once");
    assert.match(warns[0], /CROW_SYNC_PAIR_BINDING/);
  } finally {
    console.warn = orig;
    _resetPairBindingModeLog();
  }
});

// ── Nest records ───────────────────────────────────────────────────────────
test("recordPairBindingState feeds the Nest: unbound peers (no TTL, R6), refusals (TTL), a bound handshake clears both", () => {
  _resetPeerTrustHealth();
  const t0 = 1_000_000;
  recordPairBindingState("p-legacy", { bound: false, legacy: true, reason: null }, t0);
  recordPairBindingState("p-bad", { bound: false, legacy: false, reason: "pb_invalid" }, t0);
  recordPairBindingState("p-pinned", { bound: false, legacy: false, reason: "pb_required_pinned" }, t0);
  recordPairBindingState("p-req", { bound: false, legacy: false, reason: "pb_required" }, t0);
  let h = getPeerTrustHealth(t0);
  assert.deepEqual(Object.keys(h.unboundPeers), ["p-legacy"]);
  assert.match(h.unboundPeers["p-legacy"].message, /syncs without pair binding \(older Crow or no pair key\)/);
  assert.equal(h.unboundPeers["p-legacy"].at, t0);
  assert.deepEqual(Object.keys(h.pairBindingRefusals).sort(), ["p-bad", "p-pinned", "p-req"]);
  assert.equal(h.pairBindingRefusals["p-bad"].reason, "pb_invalid");
  assert.match(h.pairBindingRefusals["p-bad"].message, /re-pair to fix/);
  for (const id of ["p-pinned", "p-req"]) {
    assert.match(h.pairBindingRefusals[id].message, /sync refused/);
    assert.doesNotMatch(h.pairBindingRefusals[id].message, /re-pair to fix/, `${id}: sent no MAC, a re-pair is not the fix`);
  }
  // Existing sections are still there.
  assert.deepEqual(h.lookupFailures, {});
  assert.deepEqual(h.untrustedWithCreds, []);

  // A bound handshake clears that peer's entries; a legacy one clears its refusal.
  recordPairBindingState("p-legacy", { bound: true, legacy: false, reason: null }, t0 + 1);
  recordPairBindingState("p-bad", { bound: true, legacy: false, reason: null }, t0 + 1);
  recordPairBindingState("p-req", { bound: false, legacy: true, reason: null }, t0 + 1);
  h = getPeerTrustHealth(t0 + 1);
  assert.deepEqual(Object.keys(h.unboundPeers), ["p-req"]);
  assert.deepEqual(Object.keys(h.pairBindingRefusals), ["p-pinned"]);

  // Ruling R6: refusals expire after 10 minutes; an unbound peer never expires.
  const later = t0 + 1 + 10 * 60 * 1000 + 1;
  h = getPeerTrustHealth(later);
  assert.deepEqual(Object.keys(h.pairBindingRefusals), [], "refusals expire by TTL");
  assert.deepEqual(Object.keys(h.unboundPeers), ["p-req"], "an unbound peer outlives the TTL");
  h = getPeerTrustHealth(t0 + 30 * 24 * 3600 * 1000);
  assert.deepEqual(Object.keys(h.unboundPeers), ["p-req"], "still there a month later");
  assert.equal(Object.getPrototypeOf(h.unboundPeers), null, "prototype-free map");
  assert.equal(Object.getPrototypeOf(h.pairBindingRefusals), null, "prototype-free map");
  // A refusal does not drop the unbound record; only a bound handshake does.
  recordPairBindingState("p-req", { bound: false, legacy: false, reason: "pb_required" }, later);
  h = getPeerTrustHealth(later);
  assert.deepEqual(Object.keys(h.unboundPeers), ["p-req"]);
  assert.deepEqual(Object.keys(h.pairBindingRefusals), ["p-req"]);
  recordPairBindingState("p-req", { bound: true, legacy: false, reason: null }, later + 1);
  h = getPeerTrustHealth(later + 1);
  assert.deepEqual(Object.keys(h.unboundPeers), []);
  assert.deepEqual(Object.keys(h.pairBindingRefusals), []);

  recordPairBindingState("p-x", { bound: false, legacy: true, reason: null });
  recordPairBindingState(null, { bound: false, legacy: true, reason: null });
  assert.deepEqual(Object.keys(getPeerTrustHealth().unboundPeers), ["p-x"], "a null id is ignored");
  _resetPeerTrustHealth();
  h = getPeerTrustHealth();
  assert.deepEqual(Object.keys(h.unboundPeers), []);
  assert.deepEqual(Object.keys(h.pairBindingRefusals), []);
});

test("a failing pin write is logged (throttled per peer), not silent", async () => {
  const boom = { execute: async () => { throw new Error("SQLITE_BUSY: database is locked"); } };
  const peer = "inst-pinfail-0000-0000-000000000009";
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    assert.equal(await markPairPinned(boom, LOCAL, peer), false);
    assert.equal(await markPairPinned(boom, LOCAL, peer), false);
  } finally {
    console.warn = realWarn;
  }
  const hits = warns.filter((w) => w.includes(peer) && /could not write the pair-binding pin/.test(w) && /database is locked/.test(w));
  assert.equal(hits.length, 1, warns.join(" | "));
});

test("the once-per-peer legacy log resets after a bound handshake (a later legacy flip logs again)", async () => {
  const db = await makeRealDb(scratch("legacy-log"));
  const peer = "inst-flip-0000-0000-000000000008";
  const lines = [];
  const log = { log: (s) => lines.push(s), warn: (s) => lines.push(s) };
  const legacyRun = () => decideAndRecordPairBinding({ db, localId: LOCAL, peerId: peer, k: null, bound: false, macInvalid: false, mode: "auto", log, prefix: "[t]", where: "test" });
  const legacyLines = () => lines.filter((l) => /syncs without pair binding/.test(l)).length;
  assert.equal((await legacyRun()).legacy, true);
  await legacyRun();
  assert.equal(legacyLines(), 1, "once per peer while it stays legacy");
  const b = await decideAndRecordPairBinding({ db, localId: LOCAL, peerId: peer, k: Buffer.alloc(32), bound: true, macInvalid: false, mode: "auto", log, prefix: "[t]", where: "test" });
  assert.equal(b.ok, true);
  // The owner clears the pin (the rollback hatch), and the peer goes legacy again.
  await db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [`${SYNC_PB_KEY_PREFIX}${peer}`, LOCAL] });
  assert.equal((await legacyRun()).legacy, true);
  assert.equal(legacyLines(), 2, lines.join(" | "));
  _resetPeerTrustHealth();
});
