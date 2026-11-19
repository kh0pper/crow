/**
 * Shared raw-socket helpers for the WebSocket upgrade-claim tests
 * (tests/ws-upgrade-claim.test.js and tests/ws-upgrade-claim-live.test.js).
 *
 * The evidence F1 leaves is a corrupted byte stream after a `101`, so these drive REAL
 * sockets: a `ws` client that round-trips a message, and a hand-written upgrade request
 * that reads the status block the gateway writes back.
 */
import { connect } from "node:net";
import { WebSocket } from "ws";

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Listen on an ephemeral loopback port; rejects if the bind fails (never a silent hang). */
export function listening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

/** One WebSocket round trip; fails loudly when the stream is corrupted after a 101. */
export async function echoRoundTrip(port, path) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const errors = [];
  ws.on("error", (err) => errors.push(String(err?.message || err)));
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no handshake for ${path}`)), 4000);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("close", (code) => { clearTimeout(timer); reject(new Error(`closed ${code} before opening (${errors.join("; ")})`)); });
  });

  // The fallback decides one turn of the event loop after the handlers ran: give it that
  // turn, then check that the connection a synchronous handshake left behind still works.
  await tick(80);
  assertOpen(ws, path);

  ws.send("hello-from-the-test");
  const answer = await Promise.race([
    new Promise((resolve) => ws.once("message", (d) => resolve({ message: String(d) }))),
    closed.then((c) => ({ closed: c })),
    tick(4000).then(() => ({ timedOut: true })),
  ]);
  if (!answer.message) {
    throw new Error(`no echo back through the accepted socket (got ${JSON.stringify(answer)}, errors: ${errors.join("; ") || "none"})`);
  }
  if (answer.message !== "hello-from-the-test") {
    throw new Error(`the echo came back wrong: ${JSON.stringify(answer.message)}`);
  }

  ws.close();
  const end = await Promise.race([closed, tick(4000).then(() => ({ code: "timeout" }))]);
  if (end.code === 1006) throw new Error("the close was abnormal (1006): a stray status block landed inside the WebSocket stream");
  if (errors.length) throw new Error(`the client saw protocol errors: ${errors.join("; ")}`);
  return end;
}

function assertOpen(ws, path) {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error(`${path}: the accepted socket is not open after the fallback's turn (readyState ${ws.readyState})`);
  }
}

/**
 * One raw upgrade request to `path`; resolves with the status line, everything read, and
 * whether the socket closed. The fallback destroys the socket after its status block, so
 * "answered 404" and "closed" are both observed rather than assumed.
 */
export function rawUpgrade(port, path, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buf = "";
    let closed = false;
    let settled = false;
    let timer = null;
    const done = (why) => {
      if (settled) return;
      settled = true;
      if (timer && why !== "timeout") clearTimeout(timer);
      try { socket.destroy(); } catch { /* best effort */ }
      resolve({ buf, closed, why });
    };
    socket.on("data", (d) => { buf += d.toString("latin1"); });
    socket.on("close", () => { closed = true; done("closed"); });
    socket.on("error", () => done("error"));
    timer = setTimeout(() => done("timeout"), timeout);
  });
}

export const statusLineOf = (buf) => String(buf).split("\r\n")[0] || "";