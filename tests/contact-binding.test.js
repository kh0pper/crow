/**
 * PT-3 Task 1: contact-binding core helpers.
 * U-1 crowIdMatchesKey, U-2 contactCbMessage, U-3 decideContactProof,
 * U-4 pins (real DB), U-5 lookupPinnedContactKey, U-6 RefusalLog, wiring.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveInstanceIdentity, generateInviteCode, parseInviteCode, crowIdMatchesKey, sign } from "../servers/sharing/identity.js";
import {
  contactCbMessage, CB_PIN_PREFIX, CB_PIN_ENFORCED, isCbPinned, markCbPinned, clearCbPin,
  lookupPinnedContactKey, decideContactProof, wireContactBinding, RefusalLog,
} from "../servers/sharing/contact-binding.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { makeRealDb } from "./fixtures/sync-fleet.mjs";

const dirs = [];
async function realDb() {
  const dir = mkdtempSync(join(tmpdir(), "contact-binding-"));
  dirs.push(dir);
  return { db: await makeRealDb(dir), dir };
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const LOCAL = "aaaaaaaa-0000-0000-0000-000000000001";

// ── U-1 ────────────────────────────────────────────────────────────────────
test("U-1 crowIdMatchesKey", () => {
  const a = deriveInstanceIdentity(randomBytes(32));
  const b = deriveInstanceIdentity(randomBytes(32));
  assert.equal(crowIdMatchesKey(a.crowId, a.ed25519Pubkey), true);
  assert.equal(crowIdMatchesKey(a.crowId, b.ed25519Pubkey), false);
  assert.equal(crowIdMatchesKey(a.crowId, "d".repeat(64)), false);
  assert.equal(crowIdMatchesKey(a.crowId, a.ed25519Pubkey.slice(1)), false, "63 hex chars");
  assert.equal(crowIdMatchesKey(a.crowId, "zz"), false);
  assert.equal(crowIdMatchesKey(a.crowId, null), false);
  // parseInviteCode still accepts a real invite and rejects a tampered key.
  const id = { ...a, secp256k1Pubkey: "e".repeat(64) };
  const parsed = parseInviteCode(generateInviteCode(id));
  assert.equal(parsed.crowId, a.crowId);
  const [cid, payload, mac] = generateInviteCode(id).split(".");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  data.ed25519Pub = b.ed25519Pubkey;
  const tampered = `${cid}.${Buffer.from(JSON.stringify(data)).toString("base64url")}.${mac}`;
  assert.throws(() => parseInviteCode(tampered), /does not match/);
});

// ── U-2 ────────────────────────────────────────────────────────────────────
test("U-2 contactCbMessage", () => {
  const base = { signerCrowId: "crow:abc", challengeHex: "1".repeat(64), handshakeHashHex: "2".repeat(64) };
  const m = contactCbMessage(base);
  assert.equal(m, `crow/hs-contact-cb/v1\ncrow:abc\n${"1".repeat(64)}\n${"2".repeat(64)}`);
  for (const k of Object.keys(base)) {
    assert.notEqual(contactCbMessage({ ...base, [k]: base[k] + "x" }), m, `${k} changes it`);
  }
  assert.doesNotMatch(m, /^[0-9a-f]{64}$/);
  assert.ok(!/^(cr-resp:|cr-proof:|addr:)/.test(m));
  for (const k of Object.keys(base)) assert.throws(() => contactCbMessage({ ...base, [k]: "a\nb" }), /newline/);
});

// ── U-3 ────────────────────────────────────────────────────────────────────
test("U-3 decideContactProof, every row", () => {
  const d = (o) => decideContactProof({ cbPresent: false, cbValid: false, sigPresent: false, sigValid: false, cbPinned: false, ...o });
  assert.deepEqual(d({ cbPresent: true, cbValid: true }), { ok: true, bound: true, legacy: false, reason: null });
  assert.deepEqual(d({ cbPresent: true, cbValid: true, cbPinned: true }).ok, true);
  assert.deepEqual(d({ cbPresent: true, cbValid: false }), { ok: false, bound: false, legacy: false, reason: "cb_invalid" });
  // a throwing cb verify is passed in as false
  assert.equal(d({ cbPresent: true, cbValid: false, sigPresent: true, sigValid: true }).reason, "cb_invalid", "a bad cb is never rescued by a sig");
  assert.deepEqual(d({ sigPresent: true, sigValid: true }), { ok: true, bound: false, legacy: true, reason: null });
  assert.deepEqual(d({ sigPresent: true, sigValid: true, cbPinned: true }), { ok: false, bound: false, legacy: false, reason: "cb_required_pinned" });
  assert.equal(d({ sigPresent: true, sigValid: false }).reason, "bad_sig");
  assert.equal(d({ sigPresent: true, sigValid: false, cbPinned: true }).reason, "bad_sig");
  assert.deepEqual(d({}), { ok: false, bound: false, legacy: false, reason: "bad_sig" });
});

// ── U-4 ────────────────────────────────────────────────────────────────────
test("U-4 pins: mark / read / clear on a real DB", async () => {
  const { db } = await realDb();
  assert.equal(CB_PIN_ENFORCED, true);
  assert.equal(await isCbPinned(db, LOCAL, "crow:p1"), false);
  assert.equal(await markCbPinned(db, LOCAL, "crow:p1"), true, "newly written");
  assert.equal(await markCbPinned(db, LOCAL, "crow:p1"), false, "already pinned");
  assert.equal(await isCbPinned(db, LOCAL, "crow:p1"), true);
  assert.equal(await isCbPinned(db, LOCAL, "crow:p2"), false, "other contact unaffected");
  const row = (await db.execute({ sql: "SELECT instance_id FROM dashboard_settings_overrides WHERE key = ?", args: [CB_PIN_PREFIX + "crow:p1"] })).rows[0];
  assert.equal(row.instance_id, LOCAL, "LOCAL scope");
  await clearCbPin(db, LOCAL, "crow:p1");
  assert.equal(await isCbPinned(db, LOCAL, "crow:p1"), false);
});

test("U-4 pins: DB error fails closed; no such table fails open", async () => {
  const err = (msg) => ({ execute: async () => { throw new Error(msg); } });
  assert.equal(await isCbPinned(err("database is locked"), LOCAL, "crow:x"), true);
  assert.equal(await isCbPinned(err("no such table: dashboard_settings_overrides"), LOCAL, "crow:x"), false);
});

test("U-4 pins: missing local id fails closed and writes nothing (I2)", async () => {
  const { db } = await realDb();
  for (const bad of [null, "", undefined]) {
    assert.equal(await isCbPinned(db, bad, "crow:i2"), true);
    assert.equal(await markCbPinned(db, bad, "crow:i2"), false);
  }
  const n = (await db.execute({ sql: "SELECT COUNT(*) c FROM dashboard_settings_overrides WHERE key = ?", args: [CB_PIN_PREFIX + "crow:i2"] })).rows[0].c;
  assert.equal(Number(n), 0);
});

test("U-4 pins: enforced:false makes isCbPinned always false", async () => {
  const { db } = await realDb();
  await markCbPinned(db, LOCAL, "crow:off");
  assert.equal(await isCbPinned(db, LOCAL, "crow:off"), true);
  assert.equal(await isCbPinned(db, LOCAL, "crow:off", { enforced: false }), false);
  assert.equal(await isCbPinned(db, null, "crow:off", { enforced: false }), false);
  assert.equal(await markCbPinned(db, LOCAL, "crow:off2", { enforced: false }), false);
  assert.equal(await isCbPinned(db, LOCAL, "crow:off2"), false, "nothing written");
});

test("U-4 pins: an inbound sync entry cannot write a pin; allowlisted control applies", async () => {
  const { db } = await realDb();
  const priv = Buffer.alloc(32, 0xAB);
  const ed = await import("../node_modules/@noble/ed25519/index.js");
  const pub = Buffer.from(await ed.getPublicKey(priv)).toString("hex");
  const mgr = new InstanceSyncManager({ ed25519Priv: priv, ed25519Pubkey: pub }, db, LOCAL);
  const REMOTE = "bbbbbbbb-0000-0000-0000-000000000002";
  const entry = (key, value, ts) => {
    const e = { table: "dashboard_settings", op: "update", row: { key, value }, lamport_ts: ts, instance_id: REMOTE };
    e.signature = sign(JSON.stringify(e), priv);
    return e;
  };
  await mgr._applyEntry(REMOTE, entry(CB_PIN_PREFIX + "x", "1", 5));
  await mgr._applyEntry(REMOTE, entry("nav_groups", "[]", 6)); // positive control
  const got = async (k) => (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [k] })).rows;
  assert.equal((await got(CB_PIN_PREFIX + "x")).length, 0, "pin key not applied");
  assert.equal((await got("nav_groups")).length, 1, "allowlisted key applied (control)");
  assert.equal(await isCbPinned(db, LOCAL, "x"), false);
});

// ── U-5 ────────────────────────────────────────────────────────────────────
test("U-5 lookupPinnedContactKey", async () => {
  const { db } = await realDb();
  const K = "c".repeat(64);
  const ins = (crow, key, blocked, status) => db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked, request_status) VALUES (?, ?, ?, ?, ?)",
    args: [crow, key, randomBytes(32).toString("hex"), blocked, status],
  });
  await ins("crow:full", K, 0, null);
  await ins("crow:blocked", K, 1, null);
  await ins("crow:accepted", K, 0, "accepted");
  await ins("crow:nokey", "", 0, null);
  assert.equal(await lookupPinnedContactKey(db, "crow:full"), K);
  for (const id of ["crow:blocked", "crow:accepted", "crow:nokey", "crow:unknown"]) {
    assert.equal(await lookupPinnedContactKey(db, id), null, id);
  }
  db.close();
  await assert.rejects(() => lookupPinnedContactKey(db, "crow:full"));
});

// ── U-6 ────────────────────────────────────────────────────────────────────
test("U-6 RefusalLog", () => {
  const l = new RefusalLog();
  for (let i = 0; i < 300; i++) l.shouldLog("k" + i, 1000);
  assert.equal(l.size, 256);
  const r = new RefusalLog();
  assert.equal(r.shouldLog("a", 0), true);
  assert.equal(r.shouldLog("a", 59_999), false);
  assert.equal(r.shouldLog("a", 60_000), true);
});

// ── wiring (R5) ────────────────────────────────────────────────────────────
test("wireContactBinding resolves the local id lazily", async () => {
  const { db } = await realDb();
  const pm = { localInstanceId: null };
  wireContactBinding(pm, { db });
  assert.equal(await pm.contactBinding.isCbPinned("crow:w"), true, "no id yet: fail closed");
  assert.equal(await pm.contactBinding.markCbPinned("crow:w"), false);
  pm.localInstanceId = LOCAL; // arrives after wiring
  assert.equal(await pm.contactBinding.isCbPinned("crow:w"), false);
  assert.equal(await pm.contactBinding.markCbPinned("crow:w"), true);
  assert.equal(await pm.contactBinding.isCbPinned("crow:w"), true);

  let cur = null;
  const pm2 = {};
  wireContactBinding(pm2, { db, localInstanceId: () => cur });
  assert.equal(await pm2.contactBinding.isCbPinned("crow:w2"), true);
  cur = "bbbbbbbb-0000-0000-0000-000000000002";
  assert.equal(await pm2.contactBinding.isCbPinned("crow:w2"), false);
  const pm3 = {};
  wireContactBinding(pm3, { db, localInstanceId: LOCAL });
  assert.equal(await pm3.contactBinding.isCbPinned("crow:w"), true, "string form");

  const K = "c".repeat(64);
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:lk', ?, ?)", args: [K, "f".repeat(64)] });
  assert.equal(await pm.contactBinding.lookupKey("crow:lk"), K);
});
