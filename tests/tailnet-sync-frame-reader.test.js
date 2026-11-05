/**
 * PT-2b Task 2: the handshake frame reader keeps the peer's EXACT bytes (the
 * session transcript's salt is made of them) and bounds the unauthenticated
 * handshake phase.
 *
 * R-1 readJsonFrameWithRaw returns exactly what the peer passed to ws.send,
 *     including non-ASCII bytes.
 * R-2 a text frame over 64 KiB closes 1009; a 4 KiB hello is accepted.
 * R-3 more than 8 unread text frames closes 1008.
 * R-4 regression: a binary frame that races the handshake is still replayed at
 *     handoff (the 2026-07-06 silent stall).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { attachFrameReader, handoffToStream, HANDSHAKE_TEXT_FRAME_MAX, HANDSHAKE_QUEUE_MAX } from "../servers/sharing/tailnet-sync.js";

function wsPair(t) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => wss.close());
  return new Promise((resolve) => {
    wss.on("listening", () => {
      const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
      t.after(() => client.terminate());
      wss.on("connection", (serverWs) => client.on("open", () => resolve({ serverWs, client })));
    });
  });
}

const closeInfo = (ws) => new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: String(reason || "") })));

test("R-1 readJsonFrameWithRaw returns the exact bytes the peer sent", async (t) => {
  const { serverWs, client } = await wsPair(t);
  const reader = attachFrameReader(client);
  const text = JSON.stringify({ instance_id: "inst-a", addr: { gateway_url: "http://host.example:3002/ünïcode" }, cr: 1, pb: 1, sm: 1 });
  serverWs.send(text);
  const { msg, raw } = await reader.readJsonFrameWithRaw(2000);
  assert.equal(raw.toString("utf8"), text, "byte-identical to what was sent");
  assert.equal(Buffer.compare(raw, Buffer.from(text, "utf8")), 0);
  assert.equal(msg.addr.gateway_url, "http://host.example:3002/ünïcode");
  // readJsonFrame still hands back just the message.
  serverWs.send(JSON.stringify({ second: true }));
  assert.deepEqual(await reader.readJsonFrame(2000), { second: true });
});

test("R-2 a handshake text frame over the cap closes 1009; a 4 KiB hello is accepted", async (t) => {
  assert.equal(HANDSHAKE_TEXT_FRAME_MAX, 64 * 1024);
  {
    const { serverWs, client } = await wsPair(t);
    const closed = closeInfo(client);
    const reader = attachFrameReader(client);
    serverWs.send("x".repeat(HANDSHAKE_TEXT_FRAME_MAX + 1));
    assert.deepEqual(await closed, { code: 1009, reason: "handshake frame too big" });
    await assert.rejects(reader.readJsonFrame(1000), /closed/);
  }
  {
    const { serverWs, client } = await wsPair(t);
    const reader = attachFrameReader(client);
    const big = JSON.stringify({ hello: "y".repeat(4000) });
    serverWs.send(big);
    const { msg, raw } = await reader.readJsonFrameWithRaw(2000);
    assert.equal(msg.hello.length, 4000);
    assert.equal(raw.length, Buffer.byteLength(big));
    assert.equal(client.readyState, WebSocket.OPEN, "the link is untouched");
  }
});

test("R-3 more than 8 unread text frames closes 1008 (a flood, not a handshake)", async (t) => {
  assert.equal(HANDSHAKE_QUEUE_MAX, 8);
  const { serverWs, client } = await wsPair(t);
  const closed = closeInfo(client);
  attachFrameReader(client); // never read: every frame stays queued
  for (let i = 0; i < HANDSHAKE_QUEUE_MAX + 1; i++) serverWs.send(JSON.stringify({ i }));
  assert.deepEqual(await closed, { code: 1008, reason: "handshake flood" });
});

test("R-4 regression: a binary frame that arrives during the handshake is replayed at handoff, in order", async (t) => {
  const { serverWs, client } = await wsPair(t);
  const reader = attachFrameReader(client);
  serverWs.send(JSON.stringify({ hello: 1 }));
  serverWs.send(Buffer.from("noise-init-hello|"));
  serverWs.send(Buffer.from("more|"));
  const { msg } = await reader.readJsonFrameWithRaw(2000);
  assert.equal(msg.hello, 1);
  await new Promise((r) => setTimeout(r, 150)); // let the binary frames land while attached
  const stream = handoffToStream(client, reader);
  const chunks = [];
  stream.on("data", (d) => chunks.push(d));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(Buffer.concat(chunks).toString(), "noise-init-hello|more|");
});