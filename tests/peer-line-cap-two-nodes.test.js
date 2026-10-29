/**
 * Crow-to-Crow plan 1, task 1 (lane B ruling): a share too large for the peer
 * line cap is refused by the SENDER before anything is written and marked
 * 'failed', never 'delivered', and the contact link stays up. Before the
 * refusal, the receiver killed the link on the oversize line and the share
 * was lost while the sender showed 'delivered'.
 *
 * Harness: two real Crow sharing nodes (child processes, tests/fixtures/
 * contact-node.mjs) paired through the real invite flow over a LOCAL hyperdht
 * testnet and a LOCAL Nostr relay. Both run with CROW_PEER_LINE_MAX_BYTES at
 * the 1 MiB clamp floor. Two legs: the direct send in crow_share (peer
 * online), and the re-delivery loop (deliverPendingShares) after the peer
 * comes back (an over-cap share queued first is failed and notified; the two
 * normal shares after it still go out in that pass). A second test runs the
 * line_max exchange: a receiver at 1 MiB and a sender at 2 MiB, so the
 * sender keeps under the receiver's lower cap.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startNostrRelay } from "./fixtures/nostr-relay.mjs";
import {
  REPO, startTestnet, startContactNode, stopAllContactNodes,
  inviteAndAccept, waitConnected, shareMemory, hasMemory, shareStatus, until,
} from "./fixtures/contact-node.mjs";

const CAP = 1024 * 1024;
const T = { timeout: 300_000 };
const tag = () => randomBytes(4).toString("hex");

let relay, testnet;
before(async () => { relay = await startNostrRelay(); testnet = await startTestnet(); }, { timeout: 120_000 });
after(async () => {
  await stopAllContactNodes();
  await relay?.close();
  await testnet?.destroy();
}, { timeout: 120_000 });

const node = (name, cap = CAP) => startContactNode({
  name, repo: REPO, bootstrap: testnet.bootstrap, relayUrl: relay.url,
  extraEnv: { CROW_PEER_LINE_MAX_BYTES: String(cap) },
});
const under = (label) => `${label} ${tag()} ` + "u".repeat(CAP - 16_384);
const over = (label) => `${label} ${tag()} ` + "o".repeat(CAP + 1);
/** shareMemory without the throw on isError: the over-cap share is an error result by design. */
async function shareMemoryRaw(from, toCrowId, text) {
  const { lastInsertRowid: itemId } = await from.exec("INSERT INTO memories (content, category) VALUES (?, 'general')", [text]);
  const preview = await from.tool("crow_share", { contact: toCrowId, share_type: "memory", item_id: itemId, confirm_token: "" });
  const token = preview.text.match(/confirm_token: "([^"]+)"/)?.[1];
  assert.ok(token, `${from.name}: no share confirm token in: ${preview.text.slice(0, 200)}`);
  const done = await from.tool("crow_share", { contact: toCrowId, share_type: "memory", item_id: itemId, confirm_token: token });
  return { itemId, text: done.text, isError: done.isError };
}
const OVER_LOG = /\[sharing\] .*failed: too large to send \(\d+ bytes, cap 1048576\)/;

test("a share over the line cap is failed on the sender with the link up; just under the cap is delivered (direct send and re-delivery)", T, async () => {
  const a = await node("a"), b = await node("b");
  await inviteAndAccept(a, b);
  assert.ok(await waitConnected(a, b), "a and b connected");

  // Direct send (crow_share with the peer online).
  const ok = under("direct-under");
  const s1 = await shareMemory(a, b.crowId, ok);
  assert.ok(await until(() => hasMemory(b, ok), 30_000), "control: just under the cap is delivered");
  assert.equal(await shareStatus(a, s1.itemId), "delivered");

  const big = over("direct-over");
  const s2 = await shareMemoryRaw(a, b.crowId, big);
  assert.equal(s2.isError, true, "the over-cap share is an error result");
  assert.match(s2.text, /Status: failed: the item is too large to send \(\d+ bytes, cap 1048576\)/, "the tool says it failed");
  assert.equal(await shareStatus(a, s2.itemId), "failed", "never 'delivered'");
  assert.ok(a.logLines(OVER_LOG).length >= 1, "the sender logs the refusal");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await a.isConnected(b.crowId) && await b.isConnected(a.crowId), true, "the link stays up");
  assert.equal(b.logLines(/\[peer-manager\] contact line over cap /).length, 0, "nothing over the cap reached the receiver");
  assert.equal(await hasMemory(b, big), false);

  // Re-delivery loop: shares queued while b is away go out on reconnect.
  await b.stop({ keepHome: true });
  assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "a sees b gone");
  // The over-cap share is queued FIRST: it is refused before any write, so
  // the two normal shares after it still go out in the same pass.
  const bigQ = over("queued-over");
  const okQ = under("queued-under");
  const okQ2 = under("queued-under-2");
  const q2 = await shareMemory(a, b.crowId, bigQ);
  const q1 = await shareMemory(a, b.crowId, okQ);
  const q3 = await shareMemory(a, b.crowId, okQ2);
  for (const q of [q1, q2, q3]) assert.equal(await shareStatus(a, q.itemId), "pending");
  const b2 = await b.restart(); // a new handle on the same home
  assert.ok(await waitConnected(a, b2), "reconnected");
  assert.ok(await until(async () => (await hasMemory(b2, okQ)) && (await hasMemory(b2, okQ2)), 30_000), "both normal shares after the over-cap one are delivered");
  assert.ok(await until(async () => (await shareStatus(a, q2.itemId)) === "failed", 30_000), "the queued over-cap share is failed");
  assert.equal(await shareStatus(a, q1.itemId), "delivered");
  assert.equal(await shareStatus(a, q3.itemId), "delivered");
  // A notification names the type, contact and sizes; never the content.
  const notes = await a.sql("SELECT title, body FROM notifications WHERE title LIKE 'Share of memory to % failed: too large (%'");
  assert.equal(notes.length, 1, "one notification for the failed queued share");
  assert.match(notes[0].title, /^Share of memory to .+ failed: too large \(\d+ bytes, limit 1048576\)$/);
  assert.equal(`${notes[0].title} ${notes[0].body ?? ""}`.includes("queued-over"), false, "no content in the notification");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await a.isConnected(b2.crowId) && await b2.isConnected(a.crowId), true, "the link stays up after re-delivery");
  assert.equal(b2.logLines(/\[peer-manager\] contact line over cap /).length, 0);
  assert.equal(await hasMemory(b2, bigQ), false);
});

test("line_max exchange: receiver cap 1 MiB, sender cap 2 MiB: a 1.5 MiB share fails on the sender and the link stays up", T, async () => {
  const a = await node("send2m", 2 * CAP), b = await node("recv1m", CAP);
  await inviteAndAccept(a, b);
  assert.ok(await waitConnected(a, b), "connected");
  const mid = `mid ${tag()} ` + "m".repeat(Math.floor(1.5 * CAP));
  const s = await shareMemoryRaw(a, b.crowId, mid);
  assert.equal(s.isError, true);
  assert.match(s.text, /Status: failed: the item is too large to send \(\d+ bytes, cap 1048576\)/, "the receiver's lower cap applies");
  assert.equal(await shareStatus(a, s.itemId), "failed");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await a.isConnected(b.crowId) && await b.isConnected(a.crowId), true, "the link stays up");
  assert.equal(b.logLines(/\[peer-manager\] contact line over cap /).length, 0, "nothing over the cap reached the receiver");
  // Control: under the receiver's cap still goes through.
  const ok = under("lm-under");
  const s2 = await shareMemory(a, b.crowId, ok);
  assert.ok(await until(() => hasMemory(b, ok), 30_000), "under the lower cap: delivered");
  assert.equal(await shareStatus(a, s2.itemId), "delivered");
});
