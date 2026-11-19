/**
 * An upgrade nobody claimed must read as REFUSED — and a socket a handler already
 * ANSWERED must be left completely alone.
 *
 * The AI Companion retirement puts a fallback on the gateway's http server: an upgrade
 * request that no handler claims is answered `404 Not Found` and the socket closes, so a
 * retired surface reads as refused instead of stalling. The fallback looks one turn of
 * the event loop later, by which time every handler has run.
 *
 * F1 (round 2): "no handler claimed it" is NOT the same as "nobody answered it". A handler
 * that completes a handshake synchronously without claiming — an installed bundle copy
 * from before the claim existed (the kiosk's paired-display path accepts synchronously),
 * or a third-party panel's `setupWebSocket(server)` hook — leaves the socket WRITABLE
 * after its `HTTP/1.1 101`. The fallback then wrote a second status block INTO the
 * WebSocket byte stream: the client reports "Invalid WebSocket frame: RSV1 must be clear"
 * and closes 1006, so a working display or panel was killed by a refusal it never needed.
 * The fallback now answers only a socket no one has written to.
 *
 * This file pins the guard and the mechanism on plain http servers (a failing `ws`
 * handshake is the only evidence F1 leaves, so the round trip is the assertion).
 * tests/ws-upgrade-claim-live.test.js pins the same three outcomes on a real gateway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import {
  claimUpgrade,
  refuseUnclaimedUpgrade,
  upgradeSocketUntouched,
  installUnclaimedUpgradeFallback,
} from "../servers/shared/ws-upgrade-claim.js";
import { echoRoundTrip, listening, rawUpgrade, statusLineOf } from "./helpers/ws-upgrade-raw.js";

/** A stand-in socket that carries only what the guard reads. */
function fakeSocket(over = {}) {
  return {
    destroyed: false,
    readable: true,
    writable: true,
    bytesWritten: 0,
    writableLength: 0,
    written: [],
    gone: false,
    write(chunk) { this.written.push(String(chunk)); return true; },
    destroy() { this.gone = true; },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. the guard itself
// ---------------------------------------------------------------------------

test("only a socket nobody has written to is answerable — an answer already out is left alone", () => {
  assert.equal(upgradeSocketUntouched(fakeSocket()), true, "an untouched socket is answerable");
  assert.equal(upgradeSocketUntouched(fakeSocket({ bytesWritten: 120 })), false, "a 101 or a refusal already written");
  assert.equal(upgradeSocketUntouched(fakeSocket({ writableLength: 8 })), false, "a write still queued for this turn");
  assert.equal(upgradeSocketUntouched(fakeSocket({ destroyed: true })), false, "a closed socket");
  assert.equal(upgradeSocketUntouched(fakeSocket({ writable: false })), false, "nothing left to answer");
  assert.equal(upgradeSocketUntouched(fakeSocket({ readable: false })), false, "nothing left to answer");
  assert.equal(upgradeSocketUntouched(fakeSocket({ _httpMessage: {} })), false, "an http response owns it");
  assert.equal(upgradeSocketUntouched(null), false);

  const answered = fakeSocket({ bytesWritten: 120 });
  assert.equal(refuseUnclaimedUpgrade(answered), false, "the refusal writes nothing into an answered socket");
  assert.deepEqual(answered.written, [], "no 404 was appended to a handshake");
  assert.equal(answered.gone, false, "and the socket is not torn down");

  const untouched = fakeSocket();
  assert.equal(refuseUnclaimedUpgrade(untouched), true);
  assert.match(untouched.written[0], /^HTTP\/1\.1 404 Not Found\r\n/, "an untouched socket still gets the definite 404");
  assert.equal(untouched.gone, true, "and the socket is closed, never left half-open");
});

test("claimUpgrade sets the one documented property, so a copy outside the app tree can claim without importing it", () => {
  // A bundle copied into ~/.crow/bundles/<id>/ cannot import this module: the property
  // IS the contract, so it must stay the exact string every bundle's own copy sets.
  const req = {};
  claimUpgrade(req);
  assert.equal(req.crowWsClaimed, true);
});

// ---------------------------------------------------------------------------
// 2. the mechanism, on a plain http server (real sockets)
// ---------------------------------------------------------------------------

/**
 * An http server with the gateway's fallback plus ONE upgrade handler shaped by `mode`:
 *  - "unclaimed-accept": claims nothing and completes the 101 synchronously (the F1 shape:
 *    an installed bundle copy from before the claim, or a third-party panel hook);
 *  - "claimed-accept": claims first, then the same handshake;
 *  - "claimed-silent": claims and answers nothing at all;
 *  - "unclaimed-refuse": claims nothing and writes its own 403, then closes.
 */
async function withServer(mode, fn, { fallbackFirst = true } = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  // Every accepted socket, so teardown can end them: an upgraded socket still open would
  // keep `server.close()` waiting for a connection no test owns any more.
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  const handler = (req, socket, head) => {
    if (String(req.url || "").split("?")[0] !== "/echo") return;
    if (mode === "claimed-accept" || mode === "claimed-silent") claimUpgrade(req);
    if (mode === "claimed-silent") return;
    if (mode === "unclaimed-refuse") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (m) => ws.send(String(m)));
    });
  };
  if (fallbackFirst) installUnclaimedUpgradeFallback(server);
  server.on("upgrade", handler);
  if (!fallbackFirst) installUnclaimedUpgradeFallback(server);
  const port = await listening(server);
  try {
    return await fn(port);
  } finally {
    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* best effort */ } }
    try { wss.close(); } catch { /* best effort */ }
    for (const s of sockets) { try { s.destroy(); } catch { /* best effort */ } }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      try { server.closeAllConnections(); } catch { /* best effort */ }
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  }
}

test("a NON-claiming handler that completes the 101 synchronously keeps its connection (F1)", async () => {
  await withServer("unclaimed-accept", (port) => echoRoundTrip(port, "/echo"));
});

test("listener order does not decide it: the same connection survives with the fallback installed last", async () => {
  // installUnclaimedUpgradeFallback's contract is "order does not matter" — the answer is
  // decided by the claim and by what the socket already carries.
  await withServer("unclaimed-accept", (port) => echoRoundTrip(port, "/echo"), { fallbackFirst: false });
});

test("a CLAIMED path is never answered by the fallback, handshake or not", async () => {
  await withServer("claimed-accept", (port) => echoRoundTrip(port, "/echo"));
  await withServer("claimed-silent", async (port) => {
    const answer = await rawUpgrade(port, "/echo", { timeout: 600 });
    assert.equal(answer.buf, "", `a claimed socket gets nothing from the fallback (got ${JSON.stringify(answer.buf)})`);
    assert.equal(answer.closed, false, "and is left open for the handler that owns it");
  });
});

test("a path NOBODY touches still gets the definite 404, then a closed socket", async () => {
  await withServer("unclaimed-accept", async (port) => {
    const answer = await rawUpgrade(port, "/nobody-owns-this");
    assert.equal(answer.why, "closed", "the refused socket is closed, not left hanging");
    assert.match(statusLineOf(answer.buf), /\s404\b/, `an unowned upgrade is answered 404 (got ${statusLineOf(answer.buf) || "(no answer)"})`);
    assert.equal(statusLineOf(answer.buf).match(/HTTP\/1\.1/g)?.length, 1, "exactly one status block");
  });
});

test("a non-claiming handler's own refusal stands: its 403 is never followed by a 404", async () => {
  await withServer("unclaimed-refuse", async (port) => {
    const answer = await rawUpgrade(port, "/echo");
    assert.match(statusLineOf(answer.buf), /\s403\b/);
    assert.doesNotMatch(answer.buf, /\s404\b/, "a handler that answered for itself is not answered twice");
    assert.equal(answer.why, "closed");
  });
});