/**
 * PT-2a Task 5b, B-R7 (private engineering notes): two sibling instances
 * (one shared seed, so one Nostr key; separate homes and DBs), each a real
 * child process with the real receive wiring, on the local relay fixture
 * (127.0.0.1). No AI provider is configured in a scratch home, so B's run is
 * the production "no provider" path: a `sharing:bot_relay_manual`
 * notification on B and an error result sent back to A.
 *
 * - A sends, B runs once, A gets exactly one result notification (A's own
 *   echo of its request, which reaches every sibling, did not consume it).
 *   Both restart and the relay re-delivers since now-24h: nothing runs or
 *   notifies again.
 * - Two processes on A's DB (N2): process 2 is subscribed and claims B's
 *   result first; process 1 (the sender, holding the pending timer) gets the
 *   result afterwards. Exactly one result notification, and no "No response"
 *   timeout after a shortened relay timeout. A positive control shows the
 *   shortened timeout does fire when no result comes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startNostrRelay } from "./fixtures/nostr-relay.mjs";
import { makeBotRelayHome, startBotRelayNode, stopAllBotRelayNodes, until } from "./fixtures/bot-relay-node.mjs";

let relay;
after(async () => {
  await stopAllBotRelayNodes();
  if (relay) await relay.close();
});

async function pair() {
  if (!relay) relay = await startNostrRelay();
  const seedHex = randomBytes(32).toString("hex");
  const tag = randomBytes(3).toString("hex");
  const a = await makeBotRelayHome({ name: `a-${tag}`, instanceName: "alpha", instanceId: `inst-alpha-${tag}`, seedHex,
    peers: [{ id: `inst-beta-${tag}`, name: "beta" }] });
  const b = await makeBotRelayHome({ name: `b-${tag}`, instanceName: "beta", instanceId: `inst-beta-${tag}`, seedHex,
    peers: [{ id: `inst-alpha-${tag}`, name: "alpha" }] });
  return { a, b };
}

const count = async (node, source) =>
  Number((await node.sql("SELECT COUNT(*) AS n FROM notifications WHERE source = ?", [source]))[0].n);
const hasRow = async (node, key) =>
  (await node.sql("SELECT 1 AS x FROM processed_control_events WHERE event_id = ?", [key])).length === 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("B-R7 A sends, B runs once, A gets one result; after both restart and the relay re-delivers, nothing runs again", { timeout: 180_000 }, async () => {
  const { a, b } = await pair();
  let A = await startBotRelayNode({ label: "A", home: a.home, relayUrl: relay.url, wire: true });
  let B = await startBotRelayNode({ label: "B", home: b.home, relayUrl: relay.url, wire: true });

  const sent = await A.send("beta", "summarise my week", 120_000);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const id = sent.relayId;

  assert.ok(await until(async () => (await count(B, "sharing:bot_relay_manual")) === 1, 20_000), `B ran the task\n${B.log.slice(-2000)}`);
  assert.ok(await until(async () => (await count(A, "sharing:bot_relay_result")) === 1, 20_000), `A got the result\n${A.log.slice(-2000)}`);
  await sleep(1_000);
  assert.equal(await count(B, "sharing:bot_relay_manual"), 1, "B ran once");
  assert.equal(await count(A, "sharing:bot_relay_result"), 1, "A got exactly one result");
  assert.equal(await hasRow(B, `bot_relay:${id}`), true, "B claimed the task");
  assert.equal(await hasRow(A, `bot_relay_result:${id}`), true, "A claimed the result");
  assert.equal(await hasRow(A, `bot_relay:${id}`), false, "A's own echo of its request claimed nothing");
  assert.equal(await hasRow(B, `bot_relay_result:${id}`), false, "B's own echo of its result claimed nothing");

  // Restart both; the relay re-delivers both events (since now-24h).
  await A.stop();
  await B.stop();
  A = await startBotRelayNode({ label: "A2", home: a.home, relayUrl: relay.url, wire: true });
  B = await startBotRelayNode({ label: "B2", home: b.home, relayUrl: relay.url, wire: true });
  const got = (node, sub) => node.logLines(new RegExp(`Received crow_social message: ${sub}$`)).length > 0;
  assert.ok(await until(() => got(A, "bot_relay") && got(A, "bot_relay_result") && got(B, "bot_relay") && got(B, "bot_relay_result"), 20_000),
    `both restarted processes got both re-delivered events\nA:${A.log.slice(-1500)}\nB:${B.log.slice(-1500)}`);
  await sleep(1_500);
  assert.equal(await count(B, "sharing:bot_relay_manual"), 1, "no second run on B");
  assert.equal(await count(A, "sharing:bot_relay_result"), 1, "no second result notification on A");
  await A.stop();
  await B.stop();
});

test("B-R7 two processes on A's DB: the non-sender claims the result first, the sender still resolves (no false timeout)", { timeout: 180_000 }, async () => {
  const { a, b } = await pair();
  const B = await startBotRelayNode({ label: "B", home: b.home, relayUrl: relay.url, wire: true });
  const A2 = await startBotRelayNode({ label: "A-p2", home: a.home, relayUrl: relay.url, wire: true });
  // Process 1 sends but is not subscribed yet: process 2 gets the head start on B's result.
  const A1 = await startBotRelayNode({ label: "A-p1", home: a.home, relayUrl: relay.url, wire: false });
  assert.equal(await A1.connect(), 1, "process 1 is on the local relay");

  const TIMEOUT_MS = 8_000;
  const t0 = Date.now();
  const sent = await A1.send("beta", "tidy my inbox", TIMEOUT_MS);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const id = sent.relayId;

  assert.ok(await until(async () => await hasRow(A2, `bot_relay_result:${id}`), 20_000), `process 2 claimed the result\n${A2.log.slice(-2000)}`);
  assert.ok(await until(async () => (await count(A2, "sharing:bot_relay_result")) === 1, 5_000), "process 2 raised the one result notification");
  assert.equal(A1.logLines(/Received crow_social message: bot_relay_result/).length, 0, "process 1 had not seen the result yet");

  // Now process 1 subscribes; the relay re-delivers B's result to it.
  await A1.wire();
  assert.ok(await until(() => A1.logLines(/Received crow_social message: bot_relay_result$/).length > 0, 20_000), `process 1 got the result\n${A1.log.slice(-2000)}`);
  const wait = TIMEOUT_MS + 2_000 - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  assert.equal(await count(A2, "sharing:bot_relay_timeout"), 0, "no false 'No response' timeout");
  assert.equal(await count(A2, "sharing:bot_relay_result"), 1, "exactly one result notification on A");
  assert.equal(await count(B, "sharing:bot_relay_manual"), 1, "B ran once");

  // Positive control: with no responder, the shortened timeout does fire (once, on the sender).
  await B.stop();
  const lonely = await A1.send("beta", "anyone there", 1_500);
  assert.equal(lonely.ok, true);
  assert.ok(await until(async () => (await count(A2, "sharing:bot_relay_timeout")) === 1, 10_000), "the timeout fires without a result");
  await A1.stop();
  await A2.stop();
});
