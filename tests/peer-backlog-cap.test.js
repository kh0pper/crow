/**
 * PT-2b Task 6: the frame-chain backlog caps, and the sibling control phase.
 *
 * The frame chain in `_handleConnection` is a promise chain, so a peer that
 * writes faster than a handler makes it grow. Two independent limits, both
 * counted per QUEUED line (`state.chainFrames` / `state.chainBytes`):
 *
 *  - CONTACTS get backpressure first: pause at 256 frames / 16 MiB, resume at
 *    64 frames / 4 MiB. A legitimate burst (a c2c outbox flush, the pending-share
 *    pass) can be bigger than any fixed kill cap, and a kill there only
 *    livelocks reconnects. C-1 is the guard, and it asserts the PEAK stays
 *    bounded — a pause spy alone would pass even if pause did nothing.
 *  - EVERY admitted kind is killed over 4096 frames, or over 2 x the line cap
 *    + 1 MiB. Pausing cannot save a chunk that arrived already packed with
 *    lines: it was split and queued before any pause took effect.
 *
 * A sibling also has a control phase: from admission until its first Protomux
 * frame (a message not starting with "{", the rule instance-connect.js's
 * firstMuxFrame uses) every line is JSON. There each line is capped at 64 KiB
 * and the whole phase at 16 lines; a breach kills, with a size-only log. When
 * the phase ends the `data` handler returns at once, so replication bytes are
 * never split, parsed or buffered here.
 *
 * Harness: real PeerManagers and real key material over loopback
 * NoiseSecretStream pairs (tests/fixtures/sync-fleet.mjs's socketPair, never
 * the DHT). Contacts use the seam boot.js wires (`contactBinding`) with stub
 * pins; the sibling legs use a raw scripted peer, so a test can write exact
 * bytes (a binary chunk, a 64 KiB JSON line) that a real peer would never send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import {
  PeerManager,
  CHAIN_SOFT_FRAMES, CHAIN_SOFT_BYTES, CHAIN_RESUME_FRAMES, CHAIN_RESUME_BYTES,
  CHAIN_MAX_FRAMES, chainMaxBytesFor, SIBLING_CONTROL_LINE_MAX, SIBLING_CONTROL_MAX_LINES,
  PEER_LINE_MAX_DEFAULT,
} from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, sign } from "../servers/sharing/identity.js";
import { contactCbMessage } from "../servers/sharing/contact-binding.js";

const T = { timeout: 30_000 };
const CAP = 1024 * 1024; // the post-admission line cap these tests lower it to
const CLAIMED = "inst-claimed-by-peer";

const realWarn = console.warn, realLog = console.log;
const warnings = [];
console.warn = (...a) => { warnings.push(a.map(String).join(" ")); }; console.log = () => {};
process.on("exit", () => { console.warn = realWarn; console.log = realLog; });

const newIdentity = () => deriveInstanceIdentity(randomBytes(32));

// ---------------------------------------------------------------- harness

/** A PeerManager with the contact binding boot.js installs, no swarm, a recording `onPeerData`. */
function makePeer(identity, pins, localInstanceId, opts = {}) {
  const pm = new PeerManager(identity, { env: {}, ...opts });
  pm.p2pDisabled = true; // every link below is a loopback socket pair, never the DHT
  pm.localInstanceId = localInstanceId;
  pm.contactBinding = {
    lookupKey: async (crowId) => pins[crowId] ?? null,
    isCbPinned: async () => true,
    markCbPinned: async () => {},
  };
  const received = [];
  pm.onPeerData = (crowId, payload) => { received.push({ crowId, payload }); };
  return { pm, identity, received };
}

/** One Noise stream pair over a loopback socket pair. */
async function streams(t) {
  const [s1, s2] = await socketPair();
  const a = new NoiseSecretStream(true, s1);
  const b = new NoiseSecretStream(false, s2);
  a.on("error", () => {});
  b.on("error", () => {});
  t.after(() => {
    try { a.destroy(); } catch { /* already gone */ }
    try { b.destroy(); } catch { /* already gone */ }
  });
  return [a, b];
}

/** Two real PeerManagers, a contact pair, mutually admitted. */
async function contactPair(t, { aOpts = {}, bOpts = {} } = {}) {
  const idA = newIdentity(), idB = newIdentity();
  const pa = makePeer(idA, { [idB.crowId]: idB.ed25519Pubkey }, "inst-a", aOpts);
  const pb = makePeer(idB, { [idA.crowId]: idA.ed25519Pubkey }, "inst-b", bOpts);
  const [connA, connB] = await streams(t);
  pa.pm._handleConnection(connA, {});
  pb.pm._handleConnection(connB, {});
  assert.ok(await until(() => pa.pm.isConnected(idB.crowId) && pb.pm.isConnected(idA.crowId), 5000),
    "both sides admitted each other");
  const stateOf = () => pa.pm.connections.get(idB.crowId)?.state;
  let closed = false;
  connB.once("close", () => { closed = true; });
  return { idA, idB, pa, pb, connA, connB, stateOf, isClosed: () => closed };
}

/** A PeerManager that admits any sibling: the raw scripted sibling below is the peer. */
function makeSiblingPeer(opts = {}) {
  const identity = newIdentity();
  const pm = new PeerManager(identity, { env: {}, ...opts });
  pm.p2pDisabled = true;
  pm.localInstanceId = "inst-ours-1";
  // The pair-binding guard is not what this file tests: accept the sibling.
  pm.admitGuards.instance = async () => ({ ok: true });
  const keys = [];
  pm.onInstanceKeyReceived = (id, hex) => { keys.push([id, hex]); };
  return { pm, identity, keys };
}

/** A raw scripted SIBLING (it shares our identity, as a paired instance does), admitted both ways. */
async function rawSibling(t, { pm, identity }) {
  const [s1, s2] = await socketPair();
  const p = new NoiseSecretStream(true, s1);
  const r = new NoiseSecretStream(false, s2);
  p.on("error", () => {}); r.on("error", () => {});
  let closed = false;
  r.once("close", () => { closed = true; });
  t.after(() => { try { p.destroy(); } catch {} try { r.destroy(); } catch {} });
  pm._handleConnection(p, {});

  const frames = [];
  let buf = "";
  r.on("data", (d) => {
    buf += d.toString();
    const ls = buf.split("\n");
    buf = ls.pop();
    for (const l of ls) if (l.trim()) { try { frames.push(JSON.parse(l)); } catch {} }
  });
  const next = async (type, ms = 3000) => {
    await until(() => frames.some((f) => f.type === type), ms, 5);
    return frames.find((f) => f.type === type) ?? null;
  };

  const ch = await next("challenge");
  assert.ok(ch, "the manager sent its challenge");
  await r.opened;
  // The sibling role here is the Noise RESPONDER (the manager is the initiator).
  const hh = Buffer.from(r.handshakeHash).toString("hex");
  const cbSig = sign(contactCbMessage({
    role: "resp", signerCrowId: identity.crowId, challengeHex: ch.challenge, handshakeHashHex: hh,
  }), identity.ed25519Priv);
  r.write([
    JSON.stringify({
      type: "challenge", challenge: randomBytes(32).toString("hex"), cb: 1,
      crowId: identity.crowId, pubkey: identity.ed25519Pubkey, instance_id: CLAIMED,
    }),
    JSON.stringify({
      type: "challenge-response", crowId: identity.crowId, pubkey: identity.ed25519Pubkey, cb_sig: cbSig,
    }),
    JSON.stringify({ type: "authenticated" }),
  ].join("\n") + "\n");

  assert.ok(await until(() => pm.isConnected(identity.crowId), 5000), "the raw sibling is admitted");
  const state = () => pm.connections.get(identity.crowId)?.state;
  return { conn: r, frames, send: (...objs) => r.write(objs.map((o) => JSON.stringify(o) + "\n").join("")), write: (x) => r.write(x), state, isClosed: () => closed };
}

/** A JSON line whose UTF-8 length is exactly `bytes` (no newline). */
function jsonLineOf(bytes) {
  const base = JSON.stringify({ type: "noop", pad: "" });
  const line = JSON.stringify({ type: "noop", pad: "x".repeat(bytes - base.length) });
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}

/** A `data` frame line whose JSON bytes are exactly `bytes` long (no newline). */
function dataLineOf(bytes) {
  const base = JSON.stringify({ type: "data", payload: { type: "noop", pad: "" } });
  const line = JSON.stringify({ type: "data", payload: { type: "noop", pad: "x".repeat(bytes - base.length) } });
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}

const backlogLogs = (from = 0) => warnings.slice(from).filter((l) => l.startsWith("[peer-manager] frame backlog over cap "));
const controlLogs = (from = 0) => warnings.slice(from).filter((l) => l.startsWith("[peer-manager] sibling control over cap "));

// ---------------------------------------------------------------- the caps themselves

test("the four caps default to the plan's values; a constructor option lowers any of them; junk is never \"no cap\"", () => {
  const id = newIdentity();
  const pm = new PeerManager(id, { env: {} });
  assert.equal(pm.chainSoftFrames, 256);
  assert.equal(pm.chainSoftBytes, 16 * 1024 * 1024);
  assert.equal(pm.chainMaxFrames, 4096);
  assert.equal(pm.chainMaxBytes, 2 * pm.postAdmitLineMax + 1024 * 1024);
  assert.equal(pm.chainMaxBytes, chainMaxBytesFor(PEER_LINE_MAX_DEFAULT));
  assert.equal(CHAIN_SOFT_FRAMES, 256);
  assert.equal(CHAIN_SOFT_BYTES, 16 * 1024 * 1024);
  assert.equal(CHAIN_RESUME_FRAMES, 64);
  assert.equal(CHAIN_RESUME_BYTES, 4 * 1024 * 1024);
  assert.equal(CHAIN_MAX_FRAMES, 4096);
  // A lower line cap lowers the byte cap with it: two maximal lines must fit.
  assert.equal(new PeerManager(id, { env: {}, postAdmitLineMax: CAP }).chainMaxBytes, chainMaxBytesFor(CAP));
  // The seams.
  const low = new PeerManager(id, { env: {}, chainSoftFrames: 4, chainSoftBytes: 8, chainMaxFrames: 6, chainMaxBytes: 10 });
  assert.deepEqual(
    [low.chainSoftFrames, low.chainSoftBytes, low.chainMaxFrames, low.chainMaxBytes],
    [4, 8, 6, 10],
  );
  // Not a positive finite number: the default, never "disabled".
  const junk = new PeerManager(id, {
    env: {}, chainSoftFrames: 0, chainSoftBytes: -1, chainMaxFrames: NaN, chainMaxBytes: Infinity,
  });
  assert.deepEqual([junk.chainSoftFrames, junk.chainSoftBytes, junk.chainMaxFrames], [256, 16 * 1024 * 1024, 4096]);
  assert.equal(junk.chainMaxBytes, chainMaxBytesFor(PEER_LINE_MAX_DEFAULT));
  assert.equal(SIBLING_CONTROL_LINE_MAX, 64 * 1024);
  assert.equal(SIBLING_CONTROL_MAX_LINES, 16);
});

// ---------------------------------------------------------------- C-1 backpressure

test("C-1: a contact's 2,000-frame burst against a 5 ms handler is paused, resumed, never killed, and every frame lands in order", { timeout: 120_000 }, async (t) => {
  const before = warnings.length;
  const { idA, pa, pb, connA, stateOf } = await contactPair(t);

  const seen = [];
  pa.pm.onPeerData = async (_crowId, payload) => {
    seen.push(payload.i);
    await sleep(5); // slower than the sender: the chain must back up
  };

  // The pause/resume spy, and — what a spy alone cannot show — the PEAK.
  const pauses = [], resumes = [];
  let peak = 0;
  let chunkFrames = 0; // the most frames one data chunk carried (the soft cap's slack)
  const origPause = connA.pause.bind(connA);
  const origResume = connA.resume.bind(connA);
  connA.pause = () => { pauses.push(stateOf()?.chainFrames ?? -1); return origPause(); };
  connA.resume = () => { resumes.push(stateOf()?.chainFrames ?? -1); return origResume(); };
  connA.on("data", (d) => {
    const n = d.length ? d.toString("latin1").split("\n").length - 1 : 0;
    if (n > chunkFrames) chunkFrames = n;
  });
  const poller = setInterval(() => {
    const f = stateOf()?.chainFrames ?? 0;
    if (f > peak) peak = f;
  }, 1);
  t.after(() => clearInterval(poller));

  for (let i = 0; i < 2000; i++) pb.pm.send(idA.crowId, { type: "noop", i });
  assert.ok(await until(() => seen.length === 2000, 90_000), `all 2,000 frames delivered (got ${seen.length})`);
  clearInterval(poller);

  assert.deepEqual(seen, Array.from({ length: 2000 }, (_, i) => i), "every frame, in its original order");
  assert.equal(connA.destroyed, false, "the connection was never killed");
  assert.equal(pb.pm.isConnected(idA.crowId), true, "the contact is still up");
  assert.equal(backlogLogs(before).length, 0, "no backlog kill");

  // streamx pause() really stops `data` and resume() restarts it (plan risk 3).
  assert.ok(pauses.length >= 1, `the stream was paused (${pauses.length})`);
  assert.ok(resumes.length >= 1, `...and resumed (${resumes.length})`);
  assert.ok(chunkFrames >= 1, "the burst arrived in at least one chunk");
  // The soft cap was exercised (otherwise the bound below proves nothing)...
  assert.ok(peak >= CHAIN_SOFT_FRAMES, `the soft cap was reached (peak ${peak})`);
  // ...and the backlog never grew past it by more than the chunk that crossed
  // it. Without backpressure every one of the 2,000 frames would queue.
  assert.ok(peak < 2000, `the whole burst never queued (peak ${peak})`);
  assert.ok(peak <= CHAIN_SOFT_FRAMES + chunkFrames,
    `peak backlog ${peak} <= ${CHAIN_SOFT_FRAMES} + ${chunkFrames} (one chunk's frames); pauses ${JSON.stringify(pauses)}, resumes ${JSON.stringify(resumes)}`);
});

// ---------------------------------------------------------------- C-2 hard frame cap

test("C-2: one write packing 5,000 tiny data lines is killed at the hard frame cap; at most 4,096 are dispatched; one size/count log line", { timeout: 60_000 }, async (t) => {
  const before = warnings.length;
  const { pa, connB, stateOf, isClosed } = await contactPair(t);
  const connState = stateOf(); // the entry is dropped on close; keep the state object
  // A stalled handler: nothing is consumed while the burst is split, so the
  // whole burst queues — exactly the case pause cannot help with.
  let release;
  const stalled = new Promise((r) => { release = r; });
  let dispatched = 0;
  pa.pm.onPeerData = async () => { dispatched += 1; await stalled; };

  const lines = [];
  for (let i = 0; i < 5000; i++) {
    lines.push(JSON.stringify({ type: "data", payload: { type: "noop", m: `SECRETMARKER${String(i).padStart(4, "0")}` } }));
  }
  connB.write(lines.join("\n") + "\n");

  assert.ok(await until(() => isClosed(), 10_000), "the connection was killed");
  release();

  assert.ok(dispatched <= CHAIN_MAX_FRAMES, `at most ${CHAIN_MAX_FRAMES} lines dispatched (got ${dispatched})`);
  assert.ok(dispatched < 5000, "the burst did not go through");
  const logged = backlogLogs(before);
  assert.equal(logged.length, 1, "one size/count log line (once per peer per minute)");
  const m = logged[0].match(/ frames=(\d+) bytes=(\d+)$/);
  assert.ok(m, logged[0]);
  assert.ok(Number(m[1]) > CHAIN_MAX_FRAMES, `frames=${m[1]} is over the hard frame cap`);
  assert.ok(Number(m[1]) <= 5000);
  assert.ok(Number(m[2]) > 0, `bytes=${m[2]}`);
  assert.equal(warnings.some((l) => l.includes("SECRETMARKER")), false, "never the content");
  // The kill, not a pause: the connection is gone, the state refused.
  assert.equal(connState?.refused, true);
});

test("C-2 control: 100 packed lines are all dispatched, in order, with no pause and no kill", T, async (t) => {
  const before = warnings.length;
  const { pa, connB, isClosed, stateOf } = await contactPair(t);
  const seen = [];
  let release;
  const stalled = new Promise((r) => { release = r; });
  pa.pm.onPeerData = async (_crowId, payload) => { seen.push(payload.i); await stalled; };

  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ type: "data", payload: { type: "noop", i } }));
  connB.write(lines.join("\n") + "\n");
  assert.ok(await until(() => (stateOf()?.chainFrames ?? 0) === 100, 5000), "all 100 lines are queued");
  assert.equal(stateOf()?.paused, false, "under the soft caps: no backpressure");
  release();
  assert.ok(await until(() => seen.length === 100, 5000), "all 100 dispatched");
  assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => i), "in order");
  assert.equal(isClosed(), false, "still open");
  assert.equal(backlogLogs(before).length, 0, "no kill");
});

// ---------------------------------------------------------------- C-3 hard byte cap

test("C-3: a backlog of bytes over the hard cap (large legal lines against a stalled handler) is killed", T, async (t) => {
  const before = warnings.length;
  const { pa, connB, isClosed } = await contactPair(t, { aOpts: { postAdmitLineMax: CAP } });
  assert.equal(pa.pm.postAdmitLineMax, CAP);
  assert.equal(pa.pm.chainMaxBytes, chainMaxBytesFor(CAP), "2 x the line cap + 1 MiB");
  let release;
  const stalled = new Promise((r) => { release = r; });
  let dispatched = 0;
  pa.pm.onPeerData = async () => { dispatched += 1; await stalled; };

  // Four 1 MiB lines: each is AT the line cap (so the line cap cannot fire) and
  // each is queued behind the stalled handler. With the newline counted, the
  // backlog passes 2 x the line cap + 1 MiB on the third, so the fourth is
  // never read at all.
  const line = dataLineOf(CAP);
  connB.write([line, line, line, line].join("\n") + "\n");

  assert.ok(await until(() => isClosed(), 10_000), "the connection was killed");
  release();
  assert.ok(dispatched < 4, `the flood was cut (dispatched ${dispatched})`);
  const logged = backlogLogs(before);
  assert.equal(logged.length, 1, "one size/count log line");
  const m = logged[0].match(/ frames=(\d+) bytes=(\d+)$/);
  assert.ok(m, logged[0]);
  const bytes = Number(m[2]);
  assert.ok(bytes > pa.pm.chainMaxBytes, `${bytes} > the ${pa.pm.chainMaxBytes} byte cap`);
  assert.ok(bytes <= 4 * (CAP + 1), `the queued bytes are what was counted (${bytes})`);
  assert.equal(warnings.some((l) => l.includes("xxxx")), false, "never the content");
});

// ---------------------------------------------------------------- C-4 sibling control phase

test("C-4a: a sibling's post-admission control line over 64 KiB is killed, logged by size only", T, async (t) => {
  const before = warnings.length;
  const peer = makeSiblingPeer();
  const R = await rawSibling(t, peer);
  assert.equal(R.state()?.controlDone, false, "control: still in the control phase");

  const line = jsonLineOf(SIBLING_CONTROL_LINE_MAX + 1);
  R.write(line + "\n");
  assert.ok(await until(() => R.isClosed(), 5000), "killed");
  const logged = controlLogs(before);
  assert.equal(logged.length, 1, "one log line");
  assert.match(logged[0], / why=bytes /);
  assert.match(logged[0], new RegExp(` bytes=${SIBLING_CONTROL_LINE_MAX + 1} `));
  const sizeOnly = /^\[peer-manager\] sibling control over cap \S+ why=bytes bytes=\d+ lines=\d+$/;
  assert.match(logged[0], sizeOnly, "size and count only, never the content");
  assert.equal(warnings.some((l) => l.includes("xxxxxxxx")), false, "never the content");
});

test("C-4b: 16 post-admission sibling control lines are allowed; the 17th kills", T, async (t) => {
  const before = warnings.length;
  const peer = makeSiblingPeer();
  const R = await rawSibling(t, peer);

  R.write(Array.from({ length: SIBLING_CONTROL_MAX_LINES }, () => JSON.stringify({ type: "noop" })).join("\n") + "\n");
  assert.ok(await until(() => R.state()?.controlLines === SIBLING_CONTROL_MAX_LINES, 5000), "all 16 lines counted");
  await sleep(150);
  assert.equal(R.isClosed(), false, "control: 16 lines do not kill");
  assert.equal(controlLogs(before).length, 0);

  R.send({ type: "noop" }); // the 17th
  assert.ok(await until(() => R.isClosed(), 5000), "killed on the 17th");
  const logged = controlLogs(before);
  assert.equal(logged.length, 1);
  assert.match(logged[0], / why=lines /);
  assert.match(logged[0], new RegExp(` lines=${SIBLING_CONTROL_MAX_LINES + 1}$`));
});

test("C-4c: an instance-key sent after the first Protomux chunk is ignored (the control phase is over)", T, async (t) => {
  // Positive control first: in the control phase the very same frame IS taken.
  {
    const peer = makeSiblingPeer();
    const R = await rawSibling(t, peer);
    R.send({ type: "instance-key", instance_id: CLAIMED, feed_key_hex: "ab".repeat(32) });
    assert.ok(await until(() => peer.keys.length === 1, 5000), "control: a control-phase instance-key is applied");
    assert.deepEqual(peer.keys[0], [CLAIMED, "ab".repeat(32)]);
    assert.equal(R.state()?.controlDone, false);
  }
  // Now the same frame after a binary (Protomux-shaped) chunk: ignored.
  {
    const peer = makeSiblingPeer();
    const R = await rawSibling(t, peer);
    R.write(Buffer.from([0x00, 0x01, 0x02]));
    assert.ok(await until(() => R.state()?.controlDone === true, 5000), "the control phase ended on the first non-`{` chunk");
    R.send({ type: "instance-key", instance_id: CLAIMED, feed_key_hex: "cd".repeat(32) });
    await sleep(300);
    assert.deepEqual(peer.keys, [], "the spy stays empty: replication bytes and what follows are not parsed");
    assert.equal(R.isClosed(), false, "still open");
  }
});