/**
 * tailnet-sync handshake→replication handoff race.
 *
 * Regression net for the second L3 defect (2026-07-06): attachFrameReader's
 * message handler silently DROPPED binary frames (`if (isBinary) return`).
 * After the JSON handshake the dialing side wraps the WS in
 * NoiseSecretStream(true) and immediately sends the Noise initiator hello
 * (binary) — while the accepting side is still persisting feed keys /
 * last_seen (1-3 DB writes) before calling frameReader.detach(). If the
 * hello lands in that window it was eaten, the Noise responder waited
 * forever, and replication was silently dead on an otherwise-healthy
 * connection. Whether you lost the race was a function of the accepting
 * side's DB latency — which is why crow→MPA (quiet DB) replicated fine
 * while crow→grackle (busy DB) never moved a block.
 *
 * The fix: buffer binary frames during the handshake and hand them off —
 * ws paused across the consumer swap, buffered frames replayed in order —
 * via handoffToStream().
 */

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { attachFrameReader, handoffToStream } from "../servers/sharing/tailnet-sync.js";

function wsPair(t) {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());
  return new Promise((resolve) => {
    wss.on("listening", () => {
      const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
      wss.on("connection", (serverWs) => {
        client.on("open", () => resolve({ serverWs, client }));
      });
    });
  });
}

test("binary frames arriving during the JSON handshake are buffered, not dropped", async (t) => {
  const { serverWs, client } = await wsPair(t);
  t.after(() => client.terminate());

  const frameReader = attachFrameReader(client);

  // Server sends a JSON handshake frame, then IMMEDIATELY a binary frame
  // (the Noise-initiator-hello shape of the production race).
  serverWs.send(JSON.stringify({ hello: "handshake" }));
  serverWs.send(Buffer.from("noise-init-hello"));

  const hs = await frameReader.readJsonFrame(2000);
  assert.equal(hs.hello, "handshake");

  // Give the binary frame time to arrive while the frame reader is attached.
  await new Promise((r) => setTimeout(r, 150));

  const wsStream = handoffToStream(client, frameReader);
  const chunks = [];
  wsStream.on("data", (d) => chunks.push(d));
  await new Promise((r) => setTimeout(r, 150));

  const received = Buffer.concat(chunks).toString();
  assert.ok(
    received.includes("noise-init-hello"),
    `binary frame must survive the handoff (got: ${JSON.stringify(received)})`
  );
});

test("buffered binary frames replay IN ORDER before later live frames", async (t) => {
  const { serverWs, client } = await wsPair(t);
  t.after(() => client.terminate());

  const frameReader = attachFrameReader(client);
  serverWs.send(JSON.stringify({ ok: 1 }));
  serverWs.send(Buffer.from("first|"));
  serverWs.send(Buffer.from("second|"));

  await frameReader.readJsonFrame(2000);
  await new Promise((r) => setTimeout(r, 150));

  const wsStream = handoffToStream(client, frameReader);
  serverWs.send(Buffer.from("third|"));

  const chunks = [];
  wsStream.on("data", (d) => chunks.push(d));
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(Buffer.concat(chunks).toString(), "first|second|third|");
});

test("JSON frames still consumed by readJsonFrame; binary-free handoff works", async (t) => {
  const { serverWs, client } = await wsPair(t);
  t.after(() => client.terminate());

  const frameReader = attachFrameReader(client);
  serverWs.send(JSON.stringify({ a: 1 }));
  serverWs.send(JSON.stringify({ b: 2 }));
  assert.equal((await frameReader.readJsonFrame(2000)).a, 1);
  assert.equal((await frameReader.readJsonFrame(2000)).b, 2);

  const wsStream = handoffToStream(client, frameReader);
  serverWs.send(Buffer.from("post-handoff"));
  const chunks = [];
  wsStream.on("data", (d) => chunks.push(d));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(Buffer.concat(chunks).toString(), "post-handoff");
});

test("full duplex after a raced handoff: bytes flow BOTH directions", async (t) => {
  const { serverWs, client } = await wsPair(t);
  t.after(() => client.terminate());

  // Both ends run the production shape: frame reader → JSON → handoff.
  const clientReader = attachFrameReader(client);
  const serverReader = attachFrameReader(serverWs);

  client.send(JSON.stringify({ side: "client" }));
  serverWs.send(JSON.stringify({ side: "server" }));
  assert.equal((await clientReader.readJsonFrame(2000)).side, "server");
  assert.equal((await serverReader.readJsonFrame(2000)).side, "client");

  // Client hands off first and immediately writes binary (initiator hello),
  // racing the server's delayed handoff (simulated DB latency).
  const clientStream = handoffToStream(client, clientReader);
  clientStream.write(Buffer.from("initiator-hello"));

  await new Promise((r) => setTimeout(r, 120)); // server "does DB work"
  const serverStream = handoffToStream(serverWs, serverReader);

  const serverGot = [];
  serverStream.on("data", (d) => serverGot.push(d));
  serverStream.write(Buffer.from("responder-reply"));

  const clientGot = [];
  clientStream.on("data", (d) => clientGot.push(d));

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(Buffer.concat(serverGot).toString(), "initiator-hello");
  assert.equal(Buffer.concat(clientGot).toString(), "responder-reply");
});
