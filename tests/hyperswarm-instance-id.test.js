/**
 * PT-2a Task 0 (private engineering notes, §3.5 "One id"): on the Hyperswarm
 * instance-sync path a sibling is admitted under exactly ONE instance id,
 * resolved before the admit guard runs.
 *
 *   c = the id in the peer's challenge, r = the id in its challenge-response.
 *   Both present and different  -> refused instance_id_mismatch.
 *   Otherwise id = c ?? r ?? null; a non-null id failing ENROLL_ID_RE -> bad_instance_id.
 *   Our own id -> killed (self-loopback) before the guard.
 *   The guard gets it as `remoteInstanceId`; every later use (pin,
 *   instance-key, onInstanceConnected, a sig sibling's piggybacked key) uses it.
 *
 * Harness: a real PeerManager with PT-3 wiring (wireContactBinding over a real
 * init-db scratch DB), facing a raw scripted sibling that holds the shared
 * seed, over a loopback NoiseSecretStream socket pair (never the public DHT).
 * The admit guard is a spy: Task 0 only fixes what reaches it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NoiseSecretStream from "@hyperswarm/secret-stream";

import { makeRealDb, socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, sign } from "../servers/sharing/identity.js";
import { contactCbMessage, wireContactBinding, INSTANCE_CB_PIN_PREFIX } from "../servers/sharing/contact-binding.js";

const T = { timeout: 30_000 };

const logs = [];
const realConsole = { log: console.log, warn: console.warn };
before(() => {
  const capture = (...a) => { logs.push(a.map(String).join(" ")); };
  console.log = capture; console.warn = capture;
});
after(() => { Object.assign(console, realConsole); });
const refusedFor = (reason) => logs.some((l) => l === `[peer-manager] instance-sync connection refused: ${reason}`);

/** A real PeerManager (sibling `localId` of `me`), PT-3 wired, with a spy instance guard. */
async function makeNode(t, me, localId, { verdict = { ok: true } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pt2a-t0-"));
  const db = await makeRealDb(dir);
  t.after(() => { try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const pm = new PeerManager(me, { env: {} });
  pm.p2pDisabled = true; // links are loopback socket pairs
  pm.localInstanceId = localId;
  wireContactBinding(pm, { db, localInstanceId: localId });
  const feed = randomBytes(32).toString("hex");
  const calls = { guard: [], keyReceived: [], instanceConnected: [], feedKeyAsked: [] };
  pm.admitGuards.instance = async (ctx) => { calls.guard.push(ctx); return verdict; };
  pm.getFeedKeyForInstance = async (id) => { calls.feedKeyAsked.push(id); return feed; };
  pm.onInstanceKeyReceived = (id, k) => { calls.keyReceived.push([id, k]); };
  pm.onInstanceConnected = (crowId, _c, id) => { calls.instanceConnected.push([crowId, id]); };
  const pinned = async () => (await db.execute({
    sql: "SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE key = ?",
    args: [INSTANCE_CB_PIN_PREFIX + me.crowId],
  })).rows[0].n > 0;
  return { pm, calls, feed, db, pinned };
}

/**
 * A raw sibling holding `me`'s seed. It sends its challenge (with
 * `challengeId` as instance_id, cb:1 unless `cb: false`), waits for pm's,
 * then answers it as a cb_sig (cb) or a bare signature (sig), adding
 * `responseExtra` (e.g. instance_id, feed_key_hex), then `authenticated`.
 */
async function rawSibling(t, pm, me, { challengeId, cb = true, mode = "cb", responseExtra = {} }) {
  const [s1, s2] = await socketPair();
  const p = new NoiseSecretStream(true, s1);
  const r = new NoiseSecretStream(false, s2);
  p.on("error", () => {}); r.on("error", () => {});
  t.after(() => { p.destroy(); r.destroy(); });
  const pmFrames = [];
  const origWrite = p.write.bind(p);
  p.write = (data, ...rest) => {
    for (const l of String(data).split("\n")) if (l.trim()) { try { pmFrames.push(JSON.parse(l)); } catch {} }
    return origWrite(data, ...rest);
  };
  let closed = false;
  r.once("close", () => { closed = true; });
  const got = [];
  let buf = "";
  r.on("data", (d) => {
    buf += d.toString();
    const ls = buf.split("\n");
    buf = ls.pop();
    for (const l of ls) if (l.trim()) { try { got.push(JSON.parse(l)); } catch {} }
  });
  pm._handleConnection(p, {});

  const ask = { type: "challenge", challenge: randomBytes(32).toString("hex"), pubkey: me.ed25519Pubkey, crowId: me.crowId };
  if (cb) ask.cb = 1;
  if (challengeId !== undefined) ask.instance_id = challengeId;
  r.write(JSON.stringify(ask) + "\n");

  assert.ok(await until(() => got.some((f) => f.type === "challenge"), 3000, 5), "pm sent its challenge");
  const theirs = got.find((f) => f.type === "challenge");
  const resp = { type: "challenge-response", crowId: me.crowId, pubkey: me.ed25519Pubkey, ...responseExtra };
  if (mode === "cb") {
    await r.opened;
    const hh = Buffer.from(r.handshakeHash).toString("hex");
    resp.cb_sig = sign(contactCbMessage({ role: r.isInitiator ? "init" : "resp", signerCrowId: me.crowId, challengeHex: theirs.challenge, handshakeHashHex: hh }), me.ed25519Priv);
  } else {
    resp.signature = sign(theirs.challenge, me.ed25519Priv);
  }
  r.write(JSON.stringify(resp) + "\n" + JSON.stringify({ type: "authenticated" }) + "\n");
  return { pmFrames, get closed() { return closed; } };
}

const sent = (R, type) => R.pmFrames.filter((f) => f.type === type);

test("U-H7a positive control: a sibling that challenged as X is admitted as X (response id X, or none)", T, async (t) => {
  const me = deriveInstanceIdentity(randomBytes(32));
  for (const responseExtra of [{ instance_id: "inst-x" }, {}]) {
    const n = await makeNode(t, me, "inst-a");
    const R = await rawSibling(t, n.pm, me, { challengeId: "inst-x", responseExtra });
    assert.ok(await until(() => n.calls.instanceConnected.length === 1, 3000), "admitted");
    assert.equal(n.calls.guard.length, 1);
    assert.equal(n.calls.guard[0].remoteInstanceId, "inst-x", "the guard saw the one id");
    assert.deepEqual(n.calls.instanceConnected, [[me.crowId, "inst-x"]]);
    assert.deepEqual(n.calls.feedKeyAsked, ["inst-x"]);
    const ik = sent(R, "instance-key");
    assert.equal(ik.length, 1);
    assert.equal(ik[0].instance_id, "inst-a");
    assert.equal(await n.pinned(), true, "a cb sibling pins");
    assert.equal(R.closed, false);
  }
});

test("U-H7b a sibling that challenged as X and responds as Y is refused instance_id_mismatch: no instance-key, no callback, no pin", T, async (t) => {
  const me = deriveInstanceIdentity(randomBytes(32));
  const n = await makeNode(t, me, "inst-a");
  const R = await rawSibling(t, n.pm, me, { challengeId: "inst-x", responseExtra: { instance_id: "inst-y" } });
  assert.ok(await until(() => R.closed, 3000), "destroyed");
  await sleep(100);
  assert.ok(refusedFor("instance_id_mismatch"), "logged instance_id_mismatch");
  assert.deepEqual(n.calls.guard, [], "refused before the guard");
  assert.deepEqual(n.calls.instanceConnected, []);
  assert.deepEqual(n.calls.keyReceived, []);
  assert.deepEqual(n.calls.feedKeyAsked, []);
  assert.deepEqual(sent(R, "instance-key"), []);
  assert.deepEqual(sent(R, "authenticated"), []);
  assert.equal(await n.pinned(), false, "no pin");
});

test("U-H7c an id failing ENROLL_ID_RE (__proto__) is refused bad_instance_id; \"constructor\" passes the shape check and reaches the guard", T, async (t) => {
  const me = deriveInstanceIdentity(randomBytes(32));
  {
    const n = await makeNode(t, me, "inst-a");
    const R = await rawSibling(t, n.pm, me, { challengeId: "__proto__" });
    assert.ok(await until(() => R.closed, 3000), "destroyed");
    await sleep(100);
    assert.ok(refusedFor("bad_instance_id"), "logged bad_instance_id");
    assert.deepEqual(n.calls.guard, []);
    assert.deepEqual(n.calls.instanceConnected, []);
    assert.deepEqual(sent(R, "instance-key"), []);
    assert.equal(await n.pinned(), false);
  }
  {
    // Only the response carries the bad id: the same rule applies.
    logs.length = 0;
    const n = await makeNode(t, me, "inst-a");
    const R = await rawSibling(t, n.pm, me, { challengeId: undefined, responseExtra: { instance_id: "__proto__" } });
    assert.ok(await until(() => R.closed, 3000), "destroyed");
    await sleep(100);
    assert.ok(refusedFor("bad_instance_id"));
    assert.deepEqual(n.calls.guard, []);
  }
  {
    // "constructor" is a valid shape. Whether it is bound is the real guard's
    // call (defaultPairKey's Object.hasOwn, a later task); here it must reach
    // the guard under that id and not be refused as a bad id.
    logs.length = 0;
    const n = await makeNode(t, me, "inst-a");
    await rawSibling(t, n.pm, me, { challengeId: "constructor" });
    assert.ok(await until(() => n.calls.instanceConnected.length === 1, 3000), "admitted by the spy guard");
    assert.equal(n.calls.guard.length, 1);
    assert.equal(n.calls.guard[0].remoteInstanceId, "constructor");
    assert.deepEqual(n.calls.instanceConnected, [[me.crowId, "constructor"]]);
    assert.equal(refusedFor("bad_instance_id"), false);
  }
});

test("U-H7d self-loopback: a sibling challenging with our own id is killed before the guard", T, async (t) => {
  const me = deriveInstanceIdentity(randomBytes(32));
  {
    // Positive control: a refusing guard is reached for a foreign id.
    const n = await makeNode(t, me, "inst-a", { verdict: { ok: false, reason: "spy" } });
    const R = await rawSibling(t, n.pm, me, { challengeId: "inst-x" });
    assert.ok(await until(() => R.closed, 3000));
    assert.equal(n.calls.guard.length, 1, "control: the guard is reached");
  }
  for (const where of ["challenge", "response"]) {
    const n = await makeNode(t, me, "inst-a");
    const R = await rawSibling(t, n.pm, me, where === "challenge"
      ? { challengeId: "inst-a" }
      : { challengeId: undefined, responseExtra: { instance_id: "inst-a" } });
    assert.ok(await until(() => R.closed, 3000), `${where}: destroyed`);
    await sleep(100);
    assert.deepEqual(n.calls.guard, [], `${where}: the guard is never called`);
    assert.deepEqual(n.calls.instanceConnected, []);
    assert.deepEqual(sent(R, "instance-key"), []);
    assert.deepEqual(sent(R, "authenticated"), []);
    assert.equal(await n.pinned(), false);
  }
});

test("U-H7e a sig sibling's piggybacked feed key is received under the one id (the challenge's, when the response carries none)", T, async (t) => {
  const me = deriveInstanceIdentity(randomBytes(32));
  const FEED = "cd".repeat(32);
  for (const responseExtra of [{ instance_id: "inst-old", feed_key_hex: FEED }, { feed_key_hex: FEED }]) {
    const n = await makeNode(t, me, "inst-a");
    const R = await rawSibling(t, n.pm, me, { challengeId: "inst-old", cb: false, mode: "sig", responseExtra });
    assert.ok(await until(() => n.calls.instanceConnected.length === 1, 3000), "admitted");
    assert.equal(n.calls.guard[0].remoteInstanceId, "inst-old");
    assert.ok(await until(() => n.calls.keyReceived.length === 1, 3000), `key received (${JSON.stringify(Object.keys(responseExtra))})`);
    assert.deepEqual(n.calls.keyReceived, [["inst-old", FEED]]);
    assert.deepEqual(n.calls.instanceConnected, [[me.crowId, "inst-old"]]);
    // The deferred bare reply looked our feed key up for the same id.
    assert.deepEqual(n.calls.feedKeyAsked, ["inst-old"]);
    assert.equal(sent(R, "challenge-response")[0]?.feed_key_hex, n.feed);
  }
});
