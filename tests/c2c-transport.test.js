/**
 * Task 3 of the per-instance plan: the Crow-to-Crow TRANSPORT.
 *
 * Every c2c send site (boot.js's flush-on-connect, its receive `ctx.send` and its
 * 60 s tick, the dashboard routes and the two-node fixture) goes through
 * `servers/sharing/c2c/transport.js`. It is the one place that decides:
 *   - a TARGETED frame (`to_instance_id` set) rides `sendTo`, so it reaches the
 *     instance it names instead of whichever connection of that Crow id is newest;
 *   - a `'*'` frame (`to_instance_id` null: an invite before the visitor exists, an
 *     unshare of a member that never accepted) rides `send`, whose "whoever is
 *     there" semantics are exactly right;
 *   - a manager without `sendTo` (an older PeerManager) falls back to `send`;
 *   - a frame addressed to OUR OWN Crow id is refused: every instance of a Crow
 *     shares one identity, so that bucket holds SIBLINGS, and a project frame must
 *     never be handed to another instance of ourselves.
 *
 * `sendTo`'s `false` ("no live connection for that instance") is the outbox's S11
 * hold signal, so it is passed through untouched.
 *
 * The ack case runs on real PeerManagers over loopback NoiseSecretStream pairs (the
 * harness of tests/c2c-reply-connection.test.js): a reply names its asker's
 * instance, and the asker is the sibling that is NOT the newest connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity } from "../servers/sharing/identity.js";
import { buildFrame, parseFrame } from "../servers/sharing/c2c/frames.js";
import { c2cSend, c2cSendFor, c2cSendForContact } from "../servers/sharing/c2c/transport.js";

const T = { timeout: 30_000 };
const REPO = new URL("..", import.meta.url).pathname;
const P1 = "1".repeat(32);
const EPOCH = "a".repeat(32);

const newIdentity = () => deriveInstanceIdentity(randomBytes(32));

/** A recording stub peer manager: `send` and (optionally) `sendTo`, plus an identity. */
function stub({ crowId = "crow:local", sendTo = true } = {}) {
  const calls = [];
  const pm = {
    identity: { crowId },
    send: (id, frame) => { calls.push({ via: "send", id, frame }); },
  };
  if (sendTo) {
    pm.sendTo = (id, instanceId, frame) => {
      calls.push({ via: "sendTo", id, instanceId, frame });
      return instanceId === "inst-away" ? false : true;
    };
  }
  return { pm, calls };
}

const frameTo = (to) => ({ type: "c2c", kind: "project.role", to_instance_id: to, body: { role: "viewer" } });

/* ------------------------------------------------------------ the routing */

test("T3: a targeted frame goes through sendTo, a '*' frame through send", T, () => {
  const { pm, calls } = stub();
  assert.equal(c2cSend(pm, "crow:peer", frameTo("inst-visitor-1")), true);
  assert.deepEqual(calls.map((c) => [c.via, c.instanceId]), [["sendTo", "inst-visitor-1"]],
    "a frame that names its instance never uses send()");

  calls.length = 0;
  assert.equal(c2cSend(pm, "crow:peer", frameTo(null)), true);
  assert.deepEqual(calls.map((c) => [c.via, c.id]), [["send", "crow:peer"]],
    "a '*' frame goes to the contact (send)");
  assert.equal(calls[0].frame.to_instance_id, null);

  // sendTo's false is S11's hold signal: passed through, never swallowed.
  calls.length = 0;
  assert.equal(c2cSend(pm, "crow:peer", frameTo("inst-away")), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].via, "sendTo");
});

test("T3: a manager without sendTo falls back to send (an older PeerManager)", T, () => {
  const { pm, calls } = stub({ sendTo: false });
  assert.equal(c2cSend(pm, "crow:peer", frameTo("inst-visitor-1")), true);
  assert.deepEqual(calls.map((c) => c.via), ["send"], "no sendTo: the targeted frame uses send");
  assert.equal(calls[0].frame.to_instance_id, "inst-visitor-1");
});

test("T3: c2cSendFor binds the contact one frame at a time", T, () => {
  const { pm, calls } = stub();
  const send = c2cSendFor(pm, "crow:peer");
  assert.equal(send(frameTo("inst-visitor-1")), true);
  assert.equal(send(frameTo(null)), true);
  assert.deepEqual(calls.map((c) => c.via), ["sendTo", "send"]);
  assert.ok(calls.every((c) => c.id === "crow:peer"), "the crow id comes from the binding, not the frame");
});

test("T3: a frame addressed to our OWN crow id is refused, and says so once", T, () => {
  const { pm, calls } = stub({ crowId: "crow:me" });
  const warnings = [];
  const real = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
  try {
    // A sibling link sits in OUR OWN crowId's bucket: a c2c frame must never use it.
    assert.equal(c2cSend(pm, "crow:me", frameTo("inst-sibling-1")), false);
    assert.equal(c2cSend(pm, "crow:me", frameTo(null)), false);
  } finally {
    console.warn = real;
  }
  assert.equal(calls.length, 0, "nothing was written on a sibling link");
  const lines = warnings.filter((w) => w.includes("our own Crow id"));
  assert.equal(lines.length, 1, JSON.stringify(warnings));
  // Never the crow id itself, and never a frame body.
  assert.equal(lines[0].includes("crow:me"), false);
});

test("T3: c2cSendForContact resolves the contact's crow id, or null when it cannot", T, async () => {
  const { pm, calls } = stub();
  const db = {
    async execute({ args }) {
      const id = args[0];
      return { rows: id === 7 ? [{ crow_id: "crow:peer" }] : [] };
    },
  };
  const send = await c2cSendForContact(db, pm, 7);
  assert.equal(typeof send, "function");
  send(frameTo("inst-visitor-1"));
  assert.deepEqual(calls.map((c) => [c.via, c.id]), [["sendTo", "crow:peer"]]);

  assert.equal(await c2cSendForContact(db, pm, 8), null, "an unknown contact: no send, the frame stays queued");
  assert.equal(await c2cSendForContact(db, pm, 0), null, "a bad id: no query at all");
  assert.equal(await c2cSendForContact(db, null, 7), null, "no sharing runtime: no send");
  const broken = { async execute() { throw new Error("no such table"); } };
  assert.equal(await c2cSendForContact(broken, pm, 7), null, "a read error is a null send, never a throw");
});

/* ------------------------------------------- the ack, on real connections */

function makePeer(identity, pins, localInstanceId) {
  const pm = new PeerManager(identity, { env: {} });
  pm.p2pDisabled = true; // every link here is a loopback socket pair, never the DHT
  pm.localInstanceId = localInstanceId;
  pm.contactBinding = {
    lookupKey: async (crowId) => pins[crowId] ?? null,
    isCbPinned: async () => true,
    markCbPinned: async () => {},
  };
  const received = [];
  pm.onPeerData = (crowId, payload, meta) => { received.push({ crowId, payload, meta }); };
  return { pm, identity, received };
}

async function link(t, a, b) {
  const [s1, s2] = await socketPair();
  const connA = new NoiseSecretStream(true, s1);
  const connB = new NoiseSecretStream(false, s2);
  connA.on("error", () => {});
  connB.on("error", () => {});
  t.after(() => {
    try { connA.destroy(); } catch { /* already gone */ }
    try { connB.destroy(); } catch { /* already gone */ }
  });
  a.pm._handleConnection(connA, {});
  b.pm._handleConnection(connB, {});
  const ok = await until(() => a.pm.isConnected(b.identity.crowId) && b.pm.isConnected(a.identity.crowId));
  assert.ok(ok, "both sides admitted each other");
  return { connA, connB };
}

test("T3: a fallback ack reaches the ASKER's instance, never the newest connection", T, async (t) => {
  // B is a contact; A is one Crow with TWO instances (a1 asked, a2 is newest). The ack
  // is addressed to A's crow id with the asker's instance id, which is the only thing
  // that tells the two apart.
  const aIdentity = newIdentity();
  const bIdentity = newIdentity();
  const a1 = makePeer(aIdentity, { [bIdentity.crowId]: bIdentity.ed25519Pubkey }, "inst-a1");
  const a2 = makePeer(aIdentity, { [bIdentity.crowId]: bIdentity.ed25519Pubkey }, "inst-a2");
  const b = makePeer(bIdentity, { [aIdentity.crowId]: aIdentity.ed25519Pubkey }, "inst-b1");

  const asker = await link(t, b, a1); // the older connection
  await link(t, b, a2); // the newest: what plain send() would reach
  assert.equal(b.pm.connections.get(aIdentity.crowId).instanceId, "inst-a2", "a2 owns the contact entry");

  const ack = parseFrame(buildFrame({
    kind: "project.ack", projectUuid: P1,
    fromInstanceId: "inst-b1", toInstanceId: "inst-a1",
    body: { epoch: EPOCH, stream: "*", seqs: [1] },
  }));
  assert.equal(ack.ok, true, "the ack frame is well formed");

  assert.equal(c2cSend(b.pm, aIdentity.crowId, ack.frame), true, "the ack was written");
  assert.ok(await until(() => a1.received.length === 1), "the ASKER got the answer");
  assert.equal(a1.received[0].payload.kind, "project.ack");
  await sleep(100);
  assert.equal(a2.received.length, 0, "the newest sibling got nothing");
  assert.equal(asker.connA.destroyed, false, "the asker's connection is still up");

  // Control: a '*' frame of the same size DOES go to the newest connection (send),
  // so the assertion above is about the routing, not about a dead second link.
  const role = parseFrame(buildFrame({
    kind: "project.role", projectUuid: P1, epoch: EPOCH, seq: 1,
    fromInstanceId: "inst-b1", toInstanceId: null, body: { role: "viewer" },
  }));
  assert.equal(role.ok, true);
  assert.equal(c2cSend(b.pm, aIdentity.crowId, role.frame), true);
  assert.ok(await until(() => a2.received.length === 1), "a '*' frame reaches the newest connection");
  assert.equal(a1.received.length, 1, "…and only that one");

  // A targeted frame for an instance that is not connected: false, nothing written.
  assert.equal(c2cSend(b.pm, aIdentity.crowId, frameTo("inst-a9")), false);
  await sleep(100);
  assert.equal(a1.received.length, 1);
  assert.equal(a2.received.length, 1);
});

/* -------------------------------------------------------- the static scan */

/**
 * Every c2c flush or send site must go through the transport, so the ONE
 * exception is a SHARES path, named here: `deliverPendingShares` in boot.js is
 * "the contact" (shares keep today's semantics; the plan's ruling 5). Everything
 * else in these files that binds `peerManager.send` directly is a bug.
 */
const SEND_SITES = [
  { file: join(REPO, "servers/sharing/boot.js"), allowed: ["deliverPendingShares"] },
  { file: join(REPO, "servers/gateway/routes/c2c-api.js"), allowed: [] },
  { file: join(REPO, "tests/fixtures/contact-node-child.mjs"), allowed: [] },
];

const DIRECT_SEND = /\bpeerManager\s*\??\.\s*send\s*\(/g;

function spanOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `no function ${name} in the scanned file`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `no closing brace for ${name}`);
  return { start, end };
}

function scanSendSites(file, { allowed = [] } = {}) {
  const src = readFileSync(file, "utf8");
  const spans = allowed.map((name) => ({ name, ...spanOf(src, name) }));
  const violations = [];
  const hits = [...src.matchAll(DIRECT_SEND)];
  for (const m of hits) {
    if (!spans.some((s) => m.index >= s.start && m.index < s.end)) {
      violations.push(`peerManager.send( outside ${allowed.join(", ") || "any allowed function"}`);
    }
  }
  // The allowance must be live, not a leftover: the shares path really does use it.
  if (allowed.length && !hits.some((m) => spans.some((s) => m.index >= s.start && m.index < s.end))) {
    violations.push(`no peerManager.send( inside ${allowed.join(", ")} (a dead allowance)`);
  }
  return violations;
}

test("T3: no c2c flush or send site binds peerManager.send directly", T, () => {
  for (const site of SEND_SITES) assert.deepEqual(scanSendSites(site.file, site), [], site.file);
});

test("T3 positive control: a direct send() at a boot send site fails the scan", T, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "c2c-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boot = SEND_SITES[0];
  const src = readFileSync(boot.file, "utf8");
  const anchor = "  // Wire peer connections — update last_seen and deliver pending shares\n";
  assert.ok(src.includes(anchor), "the boot anchoring comment moved");
  const f = join(dir, "boot.js");
  writeFileSync(f, src.replace(anchor, anchor + "  const bad = () => peerManager.send(\"crow:x\", {});\n"));
  const v = scanSendSites(f, boot);
  assert.ok(v.length > 0, "a direct peerManager.send at a c2c site is caught");
  // A plant inside the ALLOWED shares path is not a violation.
  const anchor2 = "  const sendShare = (frame) => {\n";
  assert.ok(src.includes(anchor2));
  writeFileSync(f, src.replace(anchor2, anchor2 + "    peerManager.send(\"crow:x\", {});\n"));
  assert.deepEqual(scanSendSites(f, boot), []);
  // And a file whose shares path stopped using send() trips the dead-allowance check.
  writeFileSync(f, src.replace("      peerManager.send(crowId, frame);\n", "      void frame;\n"));
  assert.ok(scanSendSites(f, boot).some((x) => x.includes("dead allowance")));
});