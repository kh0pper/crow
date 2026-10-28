/**
 * PT-3 multi-instance gate: separate Crow IDs, each node its own process with
 * a scratch home, paired through the real invite flow, over a local hyperdht
 * testnet and a local Nostr relay (both 127.0.0.1). Old nodes run from a
 * detached worktree of the pre-PT-3 main (tests/fixtures/old-tree.mjs).
 *
 * Positive interoperability legs (T1, T3, T4, T5) and the negative legs (T2,
 * the T3/T4 negatives, T7). Negative legs use a scripted non-conforming peer
 * (tests/fixtures/hs-impostor.mjs) on the same local testnet; every negative
 * follows a positive control on the same link (the same topic and node).
 *
 * The node's refusal log line is rate-limited (once a minute per Crow ID), so
 * every negative asserts outcomes (not admitted, the queued share stays
 * pending, nothing lands). Reason strings are asserted only where one node
 * process sees exactly one refusal for that Crow ID (a fresh or restarted node).
 *
 * PT3_GATE_A_TREE=old (default "new") runs T2 and the T3 negative legs with A
 * from the pre-PT-3 tree and skips every other test. In that mode the
 * expected-refusal asserts are replaced by a record of each negative's outcome
 * (printed as test diagnostics and one `[pt3-gate-record]` line), plus one
 * assert per test that the own-key impostor IS admitted by the old A: the
 * regression evidence that these legs are red on the base commit.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startNostrRelay } from "./fixtures/nostr-relay.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";
import {
  REPO, PT3_BASE_SHA, startTestnet, startContactNode, stopAllContactNodes,
  inviteAndAccept, waitConnected, shareMemory, hasMemory, shareStatus, isPinned, until,
} from "./fixtures/contact-node.mjs";
import { startImpostor, stopAllImpostors } from "./fixtures/hs-impostor.mjs";

const GATE_OLD = process.env.PT3_GATE_A_TREE === "old";
const T = { timeout: 180_000 };
/** Tests that do not take part in the PT3_GATE_A_TREE=old run. */
const TN = { ...T, skip: GATE_OLD ? "PT3_GATE_A_TREE=old runs only T2 and the T3 negative legs" : false };
const gateRecord = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[:.]/g, "\\$&");
const refusalReasons = (n, crowId) => n.logLines(new RegExp(`\\[peer-manager\\] contact refused ${esc(crowId)}: `))
  .map((l) => l.slice(l.indexOf(`contact refused ${crowId}: `) + `contact refused ${crowId}: `.length).trim());
const tag = () => randomBytes(4).toString("hex");
const OLDER = (crowId) => new RegExp(`contact ${crowId.replace(/[:.]/g, "\\$&")} is on older Crow: no channel binding`);
const REFUSED = /\[peer-manager\] contact refused /;

let relay, testnet, old;

before(async () => {
  relay = await startNostrRelay();
  testnet = await startTestnet();
  old = await oldTree(PT3_BASE_SHA);
}, { timeout: 600_000 });

after(async () => {
  if (GATE_OLD) console.log(`[pt3-gate-record] ${JSON.stringify(gateRecord)}`);
  await stopAllImpostors();
  await stopAllContactNodes();
  await relay?.close();
  await testnet?.destroy();
  old?.cleanup();
}, { timeout: 120_000 });

async function node(name, repo = REPO, opts = {}) {
  return startContactNode({ name, repo, bootstrap: testnet.bootstrap, relayUrl: relay.url, ...opts });
}

function assertGuardsQuiet(...nodes) {
  for (const n of nodes) assert.deepEqual(n.guardViolations(), [], `${n.name} hit a network guard`);
}

/** Shares both ways over the admitted link; returns the two texts. */
async function sharesBothWays(a, b, label) {
  const ta = `${label} from ${a.name} ${tag()}`;
  const tb = `${label} from ${b.name} ${tag()}`;
  const sa = await shareMemory(a, b.crowId, ta);
  const sb = await shareMemory(b, a.crowId, tb);
  assert.ok(await until(() => hasMemory(b, ta), 30_000), `${b.name} did not receive ${a.name}'s share`);
  assert.ok(await until(() => hasMemory(a, tb), 30_000), `${a.name} did not receive ${b.name}'s share`);
  assert.equal(await shareStatus(a, sa.itemId), "delivered");
  assert.equal(await shareStatus(b, sb.itemId), "delivered");
  return { ta, tb };
}

test("relay fixture: NIP-01 EVENT / OK, REQ filters then EOSE then live, CLOSE", TN, async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ws = new WebSocket(relay.url);
  const inbox = [];
  ws.onmessage = (m) => inbox.push(JSON.parse(m.data));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const ev = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [["p", "ab".repeat(32)]], content: "x" }, sk);
  ws.send(JSON.stringify(["EVENT", ev]));
  ws.send(JSON.stringify(["EVENT", { ...ev, content: "tampered" }]));
  assert.ok(await until(() => inbox.filter((m) => m[0] === "OK").length === 2, 5_000));
  const oks = inbox.filter((m) => m[0] === "OK");
  assert.deepEqual(oks[0].slice(0, 3), ["OK", ev.id, true]);
  assert.equal(oks[1][2], false, "a tampered event is refused");
  ws.send(JSON.stringify(["REQ", "s1", { kinds: [4], authors: [pk], "#p": ["ab".repeat(32)] }]));
  ws.send(JSON.stringify(["REQ", "s2", { kinds: [1] }]));
  assert.ok(await until(() => inbox.some((m) => m[0] === "EOSE" && m[1] === "s2"), 5_000));
  assert.ok(inbox.some((m) => m[0] === "EVENT" && m[1] === "s1" && m[2].id === ev.id));
  assert.ok(!inbox.some((m) => m[0] === "EVENT" && m[1] === "s2"));
  const ev2 = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [["p", "ab".repeat(32)]], content: "y" }, sk);
  ws.send(JSON.stringify(["EVENT", ev2]));
  assert.ok(await until(() => inbox.some((m) => m[0] === "EVENT" && m[1] === "s1" && m[2].id === ev2.id), 5_000), "live event after EOSE");
  ws.send(JSON.stringify(["CLOSE", "s1"]));
  await new Promise((r) => setTimeout(r, 100));
  const ev3 = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [["p", "ab".repeat(32)]], content: "z" }, sk);
  ws.send(JSON.stringify(["EVENT", ev3]));
  await until(() => inbox.filter((m) => m[0] === "OK").length === 4, 5_000);
  assert.ok(!inbox.some((m) => m[0] === "EVENT" && m[2]?.id === ev3.id), "no event after CLOSE");
  ws.close();
});

test("T1 new↔new: shares both ways, both sides pin, nothing refused", TN, async () => {
  const a = await node("t1-a");
  const b = await node("t1-b");
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b), "the two nodes never admitted each other");
    await sharesBothWays(a, b, "t1");
    assert.ok(await until(async () => (await isPinned(a, b.crowId)) && (await isPinned(b, a.crowId)), 15_000), "pins on both sides");
    assert.deepEqual(a.logLines(REFUSED), []);
    assert.deepEqual(b.logLines(REFUSED), []);
    assert.deepEqual(a.logLines(OLDER(b.crowId)), []);
    assertGuardsQuiet(a, b);
  } finally {
    await a.stop(); await b.stop();
  }
});

test("T3 new A ↔ old B (positive legs): pairing both ways, shares both ways, no pin, one older-Crow line", TN, async () => {
  // Leg 1: new invites old.
  const a = await node("t3-a");
  const b = await node("t3-b-old", old.dir);
  // Leg 2: old invites new.
  const c = await node("t3-c-old", old.dir);
  const d = await node("t3-d");
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b), "new A and old B never admitted each other");
    await sharesBothWays(a, b, "t3 leg 1");
    assert.equal(await isPinned(a, b.crowId), false, "no pin for an old contact");
    assert.equal(a.logLines(OLDER(b.crowId)).length, 1, "one older-Crow line at A");
    assert.deepEqual(a.logLines(REFUSED), []);

    await inviteAndAccept(c, d);
    assert.ok(await waitConnected(c, d), "old C and new D never admitted each other");
    await sharesBothWays(c, d, "t3 leg 2");
    assert.equal(await isPinned(d, c.crowId), false, "no pin for an old inviter");
    assert.equal(d.logLines(OLDER(c.crowId)).length, 1, "one older-Crow line at D");
    assert.deepEqual(d.logLines(REFUSED), []);
    assertGuardsQuiet(a, b, c, d);
  } finally {
    await Promise.all([a.stop(), b.stop(), c.stop(), d.stop()]);
  }
});


test("T4 old A ↔ new B (positive legs): shares both ways", TN, async () => {
  const a = await node("t4-a-old", old.dir);
  const b = await node("t4-b");
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b), "old A and new B never admitted each other");
    await sharesBothWays(a, b, "t4");
    assert.equal(await isPinned(b, a.crowId), false, "no pin for an old contact");
    assert.equal(b.logLines(OLDER(a.crowId)).length, 1, "one older-Crow line at B");
    assert.deepEqual(b.logLines(REFUSED), []);
    assertGuardsQuiet(a, b);
  } finally {
    await a.stop(); await b.stop();
  }
});


test("T5 pinned downgrade: old B's share waits as pending, its DM still arrives, new code delivers", TN, async () => {
  const a = await node("t5-a");
  let b = await node("t5-b");
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b));
    await sharesBothWays(a, b, "t5 before");
    assert.ok(await until(() => isPinned(a, b.crowId), 15_000), "A pins B after a bound handshake");
    assert.deepEqual(a.logLines(REFUSED), []);

    // B rolls back to the old tree: same seed, same DB.
    b = await b.restart({ repo: old.dir });
    const text = `t5 from old b ${tag()}`;
    const { itemId } = await shareMemory(b, a.crowId, text);
    const refusedLine = new RegExp(`\\[peer-manager\\] contact refused ${b.crowId.replace(/[:.]/g, "\\$&")}: cb_required_pinned`);
    assert.ok(await until(() => a.logLines(refusedLine).length > 0, 60_000), "A refuses the pinned contact's legacy proof");
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(await shareStatus(b, itemId), "pending", "old B's share stays pending");
    assert.equal(await hasMemory(a, text), false, "nothing lands at A");
    assert.equal(await a.isConnected(b.crowId), false);

    // Messaging is never cut: a Nostr DM from old B still arrives at A.
    const dm = `t5 dm from old b ${tag()}`;
    const sent = await b.tool("crow_send_message", { contact: a.crowId, message: dm });
    assert.equal(sent.isError, false, sent.text);
    assert.ok(await until(async () =>
      (await a.sql("SELECT id FROM messages WHERE content = ? AND direction = 'received'", [dm])).length === 1, 30_000),
    "old B's DM arrives at A");

    // Back on new code, the queued share delivers.
    b = await b.restart({ repo: REPO });
    assert.ok(await until(() => hasMemory(a, text), 60_000), "the pending share delivers once B is new again");
    assert.ok(await until(async () => (await shareStatus(b, itemId)) === "delivered", 15_000));
    assertGuardsQuiet(a, b);
  } finally {
    await a.stop(); await b.stop();
  }
});

// ---------------------------------------------------------------- impostor legs

function imp(opts) {
  return startImpostor({ bootstrap: testnet.bootstrap, ...opts });
}

/** Positive control on the impostor link: admitted, and its share lands at `n`. */
async function admittedLeg(i, n, label) {
  assert.ok(await i.waitAdmitted(30_000), `${label}: admitted`);
  const text = `${label} ${tag()}`;
  assert.ok(await until(() => i.sendShare(text) > 0, 5_000), `${label}: share written on the admitted link`);
  assert.ok(await until(() => hasMemory(n, text), 15_000), `${label}: its share lands at ${n.name}`);
  return text;
}

/**
 * Outcome of a negative leg against `n`: whether the node sent `authenticated`
 * on any target link, and whether the impostor's planted share landed.
 */
async function negativeOutcome(i, n, plantText, windowMs = 8_000) {
  assert.ok(await i.waitTarget(30_000), "the impostor reached the node under test and saw its challenge");
  await i.waitOutcome(windowMs);
  await sleep(1_500); // a later reconnect would have been admitted by now
  return { admitted: i.admitted(), landed: await hasMemory(n, plantText), received: i.receivedTexts() };
}

/**
 * New tree: assert the negative is refused. PT3_GATE_A_TREE=old with `gated`
 * (the leg's verifier is the old A): record the outcome instead.
 */
function expectRefused(t, testName, leg, o, { gated = true } = {}) {
  if (gated && GATE_OLD) {
    const rec = { test: testName, leg, admitted_by_old_A: o.admitted, planted_share_landed: o.landed, received_shares: o.received.length };
    gateRecord.push(rec);
    t.diagnostic(`pt3-gate ${JSON.stringify(rec)}`);
    return;
  }
  assert.equal(o.admitted, false, `${leg}: not admitted`);
  assert.equal(o.landed, false, `${leg}: its planted share does not land`);
}

const RESIDUAL = "documented residual (§3.2): someone can pose as a contact only while that contact still runs Crow older than PT-3 on a machine that is online, and only until this node has once seen it bind";

test("T2 impostors (A and B new, B stopped): honest control, then own-key, pinned-pubkey-own-sig, replay refused; oracle through the restarted B refused", T, async (t) => {
  const NAME = "T2";
  let a = await node("t2-a", GATE_OLD ? old.dir : REPO);
  let b = await node("t2-b");
  const imps = [];
  const start = async (o) => { const i = await imp(o); imps.push(i); return i; };
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b), "A and B admitted each other");
    if (!GATE_OLD) assert.ok(await until(() => isPinned(a, b.crowId), 15_000), "A pins B after the bound handshake");
    const seedHex = await b.seedHex();
    await b.stop({ keepHome: true });
    assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "A sees B go offline");

    const base = { topicKeys: [a.ed25519Pubkey, b.ed25519Pubkey], claimCrowId: b.crowId, claimPubkey: b.ed25519Pubkey };
    const queue = async (content) => ({ ...(await shareMemory(a, b.crowId, content)), content });
    let pending = await queue(`t2 pending 0 ${tag()}`);
    assert.equal(await shareStatus(a, pending.itemId), "pending", "with B offline the share waits");
    let recorded = null;
    const results = {};

    // One round per non-conforming answer, each on a freshly restarted A (one
    // refusal per Crow ID per process is logged), each after an honest control.
    const rounds = [
      ["own-key", () => ({ mode: "own-key" }), "key_mismatch"],
      ["pinned-pubkey-own-sig", () => ({ mode: "pinned-pubkey-own-sig" }), "bad_sig"],
      ["replay (bare signature from an earlier connection)", () => ({ mode: "replay", replay: { signature: recorded.signature } }), "bad_sig"],
      ["replay (cb_sig from an earlier connection)", () => ({ mode: "replay", replay: { cb_sig: recorded.cb_sig } }), "cb_invalid"],
    ];
    for (const [k, [leg, opts, reason]] of rounds.entries()) {
      if (k > 0) a = await a.restart();
      const ctrl = await start({ ...base, mode: "honest", identity: { seedHex } });
      await admittedLeg(ctrl, a, `t2 control before ${leg}`);
      if ((await shareStatus(a, pending.itemId)) !== "delivered") {
        assert.ok(await until(() => ctrl.receivedTexts().includes(pending.content), 15_000), `control before ${leg}: receives A's pending share`);
        assert.ok(await until(async () => (await shareStatus(a, pending.itemId)) === "delivered", 10_000));
      }
      recorded ??= ctrl.proofs[0];
      assert.ok(recorded?.signature && recorded?.cb_sig, "the control recorded its proofs");
      await ctrl.stop();
      assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000));

      pending = await queue(`t2 pending before ${leg} ${tag()}`);
      const plantText = `t2 planted by ${leg} ${tag()}`;
      const i = await start({ ...base, ...opts(), plant: [plantText] });
      const o = await negativeOutcome(i, a, plantText);
      o.pendingStayed = (await shareStatus(a, pending.itemId)) === "pending";
      results[leg] = o;
      expectRefused(t, NAME, leg, o);
      if (!GATE_OLD) {
        assert.equal(o.pendingStayed, true, `${leg}: the queued share stays pending`);
        assert.equal(o.received.length, 0, `${leg}: the impostor received nothing`);
        assert.equal(await a.isConnected(b.crowId), false);
        assert.deepEqual(refusalReasons(a, b.crowId), [reason], `${leg}: refused ${reason}`);
      }
      await i.stop();
    }
    if (GATE_OLD) {
      assert.equal(results["own-key"].admitted, true, "red on the base commit: the old A admits an own-key impostor for B");
    }

    // The real B comes back (new); the oracle relays A's challenge through it.
    b = await b.restart();
    assert.ok(await waitConnected(a, b), "control: the real B reconnects on the same topic");
    for (const cb of [true, false]) {
      const leg = `oracle through new B (${cb ? "cb:1" : "no cb"})`;
      const plantText = `t2 planted by ${leg} ${tag()}`;
      const i = await start({ ...base, mode: "oracle", oracleTarget: b, oracleCb: cb, plant: [plantText] });
      const o = await negativeOutcome(i, a, plantText, cb ? 10_000 : 25_000);
      expectRefused(t, NAME, leg, o);
      const ans = i.oracleAnswers.map((x) => x.answer);
      if (cb) {
        assert.ok(ans.some((x) => typeof x?.cb_sig === "string"), "new B answered the cb:1 relay with a cb_sig");
        assert.equal(ans.some((x) => x && "signature" in x), false, "new B signed no bare nonce");
      } else {
        assert.ok(i.oracleAnswers.length > 0 && ans.every((x) => x === null), "new B never answered a relay without cb (deferred)");
      }
      if (!GATE_OLD) assert.equal(await a.isConnected(b.crowId), true, "the real B's link stays");
      await i.stop();
    }
    assertGuardsQuiet(a, b);
  } finally {
    await Promise.all(imps.map((i) => i.stop()));
    await a.stop(); await b.stop();
  }
});

test("T3 new A ↔ old B (negative legs): own-key vs A refused; oracle through old B admitted (§3.2 residual); own-key vs old B admitted", T, async (t) => {
  const NAME = "T3";
  const a = await node("t3n-a", GATE_OLD ? old.dir : REPO);
  const b = await node("t3n-b-old", old.dir);
  const imps = [];
  const start = async (o) => { const i = await imp(o); imps.push(i); return i; };
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b), "control: A and old B admitted each other");
    await sharesBothWays(a, b, "t3n");
    const topicKeys = [a.ed25519Pubkey, b.ed25519Pubkey];
    const claimB = { topicKeys, claimCrowId: b.crowId, claimPubkey: b.ed25519Pubkey };

    // Control on the impostor link to A: B's real key, answering as old code does.
    const ctrl = await start({ ...claimB, mode: "honest", identity: { seedHex: await b.seedHex() }, asOld: true });
    await admittedLeg(ctrl, a, "t3n control (B's key, bare signature) vs A");
    await ctrl.stop();

    {
      const leg = "own-key claiming B vs A";
      const plantText = `t3n planted by ${leg} ${tag()}`;
      const i = await start({ ...claimB, mode: "own-key", plant: [plantText] });
      const o = await negativeOutcome(i, a, plantText);
      expectRefused(t, NAME, leg, o);
      if (GATE_OLD) assert.equal(o.admitted, true, "red on the base commit: the old A admits an own-key impostor for B");
      else assert.deepEqual(refusalReasons(a, b.crowId), ["key_mismatch"]);
      await i.stop();
    }

    // §3.2 residual, asserted: old B signs any nonce it is sent, and A has
    // never seen B bind, so A accepts B's relayed bare signature.
    for (const cb of [true, false]) {
      const plantText = `t3n planted by oracle (${cb ? "cb:1" : "no cb"}) ${tag()}`;
      const i = await start({ ...claimB, mode: "oracle", oracleTarget: b, oracleCb: cb, plant: [plantText] });
      assert.ok(await i.waitAdmitted(30_000), `oracle through old B (${cb ? "cb:1" : "no cb"}) is admitted by A: ${RESIDUAL}`);
      assert.ok(i.oracleAnswers.some((x) => typeof x.answer?.signature === "string"), "old B signed the relayed nonce");
      assert.ok(await until(() => hasMemory(a, plantText), 15_000), "the relayed impostor's share lands at A (the residual's effect)");
      if (GATE_OLD) gateRecord.push({ test: NAME, leg: `oracle through old B (${cb ? "cb:1" : "no cb"})`, admitted_by_old_A: true, planted_share_landed: true });
      await i.stop();
    }
    if (!GATE_OLD) assert.equal(await isPinned(a, b.crowId), false, "A never pinned old B");

    // The harness is real: the same own-key impostor, claiming A, is admitted by the old B.
    const claimA = { topicKeys, claimCrowId: a.crowId, claimPubkey: a.ed25519Pubkey };
    const ctrlB = await start({ ...claimA, mode: "honest", identity: { seedHex: await a.seedHex() }, asOld: true });
    await admittedLeg(ctrlB, b, "t3n control (A's key) vs old B");
    await ctrlB.stop();
    const plantText = `t3n planted by own-key claiming A vs old B ${tag()}`;
    const i = await start({ ...claimA, mode: "own-key", plant: [plantText] });
    assert.ok(await i.waitAdmitted(30_000), "old B admits an own-key impostor for A (pre-PT-3 behaviour)");
    assert.ok(await until(() => hasMemory(b, plantText), 15_000), "its share lands at old B");
    assertGuardsQuiet(a, b);
  } finally {
    await Promise.all(imps.map((i) => i.stop()));
    await a.stop(); await b.stop();
  }
});

test("T4 old A ↔ new B (negative legs): new B refuses own-key; new B is no oracle against old A; old A as the oracle against new B is admitted (§3.2 residual, B never pinned A)", TN, async (t) => {
  const a = await node("t4n-a-old", old.dir);
  const b = await node("t4n-b");
  const imps = [];
  const start = async (o) => { const i = await imp(o); imps.push(i); return i; };
  try {
    await inviteAndAccept(a, b);
    assert.ok(await waitConnected(a, b), "control: old A and new B admitted each other");
    await sharesBothWays(a, b, "t4n");
    const topicKeys = [a.ed25519Pubkey, b.ed25519Pubkey];
    const claimA = { topicKeys, claimCrowId: a.crowId, claimPubkey: a.ed25519Pubkey };
    const claimB = { topicKeys, claimCrowId: b.crowId, claimPubkey: b.ed25519Pubkey };

    // Against new B, claiming A: control (A's key, bare signature as old A answers), then own-key.
    const ctrl = await start({ ...claimA, mode: "honest", identity: { seedHex: await a.seedHex() }, asOld: true });
    await admittedLeg(ctrl, b, "t4n control (A's key) vs new B");
    await ctrl.stop();
    {
      const leg = "own-key claiming A vs new B";
      const plantText = `t4n planted by ${leg} ${tag()}`;
      const i = await start({ ...claimA, mode: "own-key", plant: [plantText] });
      expectRefused(t, "T4", leg, await negativeOutcome(i, b, plantText), { gated: false });
      assert.deepEqual(refusalReasons(b, a.crowId), ["key_mismatch"]);
      await i.stop();
    }

    // Against old A, claiming B: control (B's key), then the relay through new B.
    const ctrlA = await start({ ...claimB, mode: "honest", identity: { seedHex: await b.seedHex() } });
    await admittedLeg(ctrlA, a, "t4n control (B's key) vs old A");
    await ctrlA.stop();
    for (const cb of [true, false]) {
      const leg = `oracle through new B (${cb ? "cb:1" : "no cb"}) vs old A`;
      const plantText = `t4n planted by ${leg} ${tag()}`;
      const i = await start({ ...claimB, mode: "oracle", oracleTarget: b, oracleCb: cb, plant: [plantText] });
      expectRefused(t, "T4", leg, await negativeOutcome(i, a, plantText, 10_000), { gated: false });
      const ans = i.oracleAnswers.map((x) => x.answer);
      assert.ok(i.oracleAnswers.length > 0, "the relay was attempted");
      assert.equal(ans.some((x) => x && "signature" in x), false, "new B signed no bare nonce for the relay");
      if (cb) assert.ok(ans.some((x) => typeof x?.cb_sig === "string"), "new B answered cb:1 with a cb_sig only");
      else assert.ok(ans.every((x) => x === null), "new B deferred its reply to a no-cb asker that never proved itself");
      await i.stop();
    }

    // §3.2 residual from B's side: old A signs any nonce, and B has never seen A bind.
    assert.equal(await isPinned(b, a.crowId), false, "precondition: B has not pinned old A");
    const plantText = `t4n planted by oracle through old A vs new B ${tag()}`;
    const i = await start({ ...claimA, mode: "oracle", oracleTarget: a, plant: [plantText] });
    assert.ok(await i.waitAdmitted(30_000), `oracle through old A is admitted by new B: ${RESIDUAL}`);
    assert.ok(i.oracleAnswers.some((x) => typeof x.answer?.signature === "string"), "old A signed the relayed nonce");
    assert.ok(await until(() => hasMemory(b, plantText), 15_000), "the relayed impostor's share lands at B (the residual's effect)");
    assertGuardsQuiet(a, b);
  } finally {
    await Promise.all(imps.map((i) => i.stop()));
    await a.stop(); await b.stop();
  }
});

/**
 * T7 setup shared by both pin routes: A (new), B1 (new) and B2 (old, B1's
 * seed), each with its own scratch DB. A invites B2 first: an old acceptor
 * sends no `hs_cb` advert, and B1 has no contact row for A yet, so it cannot
 * reach A at all. That is the genuine "before A pins" state, in which B2's
 * share lands. A then invites B1 (the acceptor's invite_accepted carries no
 * advert either; the inviter's handshake_complete goes to B, not to A).
 */
async function twoMachines(prefix, { b1Bootstrap = null } = {}) {
  const a = await node(`${prefix}-a`);
  const b1 = await startContactNode({
    name: `${prefix}-b1`, bootstrap: b1Bootstrap ?? testnet.bootstrap, relayUrl: relay.url, bindingAdvertDelayMs: 600_000,
  });
  const b2 = await node(`${prefix}-b2-old`, old.dir, { seedFrom: b1 });
  assert.equal(b2.crowId, b1.crowId, "B1 and B2 are one person (one seed)");
  await inviteAndAccept(a, b2);
  assert.ok(await waitConnected(a, b2), "A and old B2 admitted each other");
  const before = `${prefix} from b2 before the pin ${tag()}`;
  const s = await shareMemory(b2, a.crowId, before);
  assert.ok(await until(() => hasMemory(a, before), 30_000), "before A pins: B2's share lands at A");
  assert.equal(await shareStatus(b2, s.itemId), "delivered");
  assert.equal(await isPinned(a, b1.crowId), false, "no pin yet: B2 is old");
  await inviteAndAccept(a, b1);
  return { a, b1, b2 };
}

/** After A pinned B: old B2, freshly reconnecting, has its share held as pending, A refuses it, and its DM still arrives. */
async function assertPinnedAgainstOldMachine(a, b2, prefix) {
  const text = `${prefix} from b2 after the pin ${tag()}`;
  const { itemId } = await shareMemory(b2, a.crowId, text);
  assert.ok(await until(() => refusalReasons(a, b2.crowId).includes("cb_required_pinned"), 60_000), "A logs cb_required_pinned for B2's legacy proof");
  await sleep(3_000);
  assert.equal(await shareStatus(b2, itemId), "pending", "B2's share stays pending");
  assert.equal(await hasMemory(a, text), false, "nothing lands at A");
  const dm = `${prefix} dm from b2 ${tag()}`;
  const sent = await b2.tool("crow_send_message", { contact: a.crowId, message: dm });
  assert.equal(sent.isError, false, sent.text);
  assert.ok(await until(async () =>
    (await a.sql("SELECT id FROM messages WHERE content = ? AND direction = 'received'", [dm])).length === 1, 30_000),
  "messaging is never cut: B2's DM arrives at A");
}

const advertMarker = async (n, crowId) => (await n.sql("SELECT 1 FROM dashboard_settings_overrides WHERE key = ?", [`contact_hs_cb_adv:${crowId}`])).length > 0;

test("T7 one person, two machines (I1), pinned by B1's bound handshake: B2 delivers before the pin, then waits as pending; its DM arrives; the oracle through B2 is refused", TN, async (t) => {
  let { a, b1, b2 } = await twoMachines("t7h");
  const imps = [];
  try {
    const t1 = `t7h from b1 ${tag()}`;
    await shareMemory(b1, a.crowId, t1);
    assert.ok(await until(() => hasMemory(a, t1), 60_000), "B1's share lands at A over its first (bound) handshake");
    assert.ok(await until(() => isPinned(a, b1.crowId), 15_000), "A pins B");
    assert.equal(await advertMarker(b1, a.crowId), false, "B1 sent no hs_cb advert: the pin came from the handshake");
    assert.deepEqual(refusalReasons(a, b1.crowId), []);

    // B1 goes offline (so the only other holder of B's key on the topic is
    // old B2), and B2 reconnects: its legacy proof now meets the pin.
    await b1.stop();
    b2 = await b2.restart();
    await assertPinnedAgainstOldMachine(a, b2, "t7h");

    // Oracle through B2: control first (B's key, bound), then the relay.
    const base = { topicKeys: [a.ed25519Pubkey, b2.ed25519Pubkey], claimCrowId: b2.crowId, claimPubkey: b2.ed25519Pubkey };
    const ctrl = await imp({ ...base, mode: "honest", identity: { seedHex: await b2.seedHex() } });
    imps.push(ctrl);
    await admittedLeg(ctrl, a, "t7h control (B's key) vs A");
    await ctrl.stop();
    for (const cb of [true, false]) {
      const leg = `oracle through old B2 (${cb ? "cb:1" : "no cb"}) vs pinned A`;
      const plantText = `t7h planted by ${leg} ${tag()}`;
      const i = await imp({ ...base, mode: "oracle", oracleTarget: b2, oracleCb: cb, plant: [plantText] });
      imps.push(i);
      expectRefused(t, "T7", leg, await negativeOutcome(i, a, plantText, 10_000), { gated: false });
      assert.ok(i.oracleAnswers.some((x) => typeof x.answer?.signature === "string"), "old B2 did sign the relayed nonce: the pin is what refuses it");
      await i.stop();
    }
    assertGuardsQuiet(a, b2);
  } finally {
    await Promise.all(imps.map((i) => i.stop()));
    await a.stop(); await b1.stop(); await b2.stop();
  }
});

test("T7 one person, two machines (I1), pinned only by B1's Nostr advert (no handshake): B2's share waits as pending, its DM arrives", TN, async () => {
  // B1 runs on a second local testnet: it shares the relay with A but can
  // never reach A over Hyperswarm, so the advert is the only route to a pin.
  const testnet2 = await startTestnet();
  let a, b1, b2;
  try {
    ({ a, b1, b2 } = await twoMachines("t7n", { b1Bootstrap: testnet2.bootstrap }));
    await sleep(2_000);
    assert.equal(await isPinned(a, b1.crowId), false, "pairing with B1 (as acceptor) did not pin A");
    b1 = await b1.restart({ bindingAdvertDelayMs: 200 }); // the boot-time advert to existing contacts
    assert.ok(await until(() => isPinned(a, b1.crowId), 30_000), "A pins B from B1's hs_cb advert");
    assert.equal(await advertMarker(b1, a.crowId), true, "B1 recorded the advert as sent");
    assert.equal(await b1.isConnected(a.crowId), false);
    assert.deepEqual(b1.logLines(/\[sharing\] Peer connected/), [], "B1 never had a Hyperswarm link to A");

    b2 = await b2.restart();
    await assertPinnedAgainstOldMachine(a, b2, "t7n");
    assertGuardsQuiet(a, b1, b2);
  } finally {
    await a?.stop(); await b1?.stop(); await b2?.stop();
    await testnet2.destroy();
  }
});
