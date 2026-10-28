/**
 * PT-3 multi-instance gate: separate Crow IDs, each node its own process with
 * a scratch home, paired through the real invite flow, over a local hyperdht
 * testnet and a local Nostr relay (both 127.0.0.1). Old nodes run from a
 * detached worktree of the pre-PT-3 main (tests/fixtures/old-tree.mjs).
 *
 * This file holds the positive interoperability legs. The impostor and
 * negative legs (T2, the T3/T4 negatives, T7) are placeholders below and are
 * filled by a later part (the private engineering notes, Task 4).
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

const T = { timeout: 180_000 };
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

test("relay fixture: NIP-01 EVENT / OK, REQ filters then EOSE then live, CLOSE", T, async () => {
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

test("T1 new↔new: shares both ways, both sides pin, nothing refused", T, async () => {
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

test("T3 new A ↔ old B (positive legs): pairing both ways, shares both ways, no pin, one older-Crow line", T, async () => {
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

test.todo("T2 impostors (own-key, pinned-pubkey-own-sig, replay, oracle) after an honest same-link positive control");
test.todo("T3 negative legs: own-key impostor vs new A refused; oracle via old B admitted (§3.2 residual); own-key vs old B admitted");

test("T4 old A ↔ new B (positive legs): shares both ways", T, async () => {
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

test.todo("T4 negative legs: new B refuses own-key; oracle via old A admitted (§3.2 residual from B's side)");

test("T5 pinned downgrade: old B's share waits as pending, its DM still arrives, new code delivers", T, async () => {
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

test.todo("T7 one person, two machines (I1): new B1 + old B2 on one seed; before/after A pins; advert-only pin; oracle via B2 refused");
