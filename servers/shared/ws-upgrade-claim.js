/**
 * An upgrade no handler owns gets an ANSWER: `404 Not Found`, then the socket closes.
 *
 * node's http server closes a socket for an unhandled upgrade only when it has NO
 * "upgrade" listener at all. The gateway has several (/calls/ws, instance sync, the
 * Kiosk display, Meta Glasses, Studio, /proxy/<id>), and each one ignores the paths it
 * does not own and returns — so a path NO handler owns used to leak a socket forever:
 * the client waited for a handshake that never came and no status ever arrived. The AI
 * Companion's surface is gone from every install, and "gone" has to read as REFUSED, not
 * as a stall (a scanner or a stale page is told no, and the socket does not linger).
 *
 * The contract: every upgrade handler CLAIMS its own path SYNCHRONOUSLY, before its first
 * `await`, with `claimUpgrade(req)` — or, from an installed bundle's own copy (which
 * cannot import this file: it lives outside the bundle after install), by setting the
 * same documented property, `req.crowWsClaimed = true`. This fallback is registered on
 * the same server and looks one turn of the event loop later, by which time every
 * listener for that event has run: if nobody claimed the path, nobody ever will, so the
 * request is answered like any other unknown path — a 404.
 *
 * A handler that claims AFTER awaiting would be refused here; that is why the claim is
 * the first statement of every handler (each one matches its path synchronously, then
 * does its auth). The Bundle-version rule (a code change ships with a manifest bump) is
 * what puts a claiming handler into an installed bundle's own copy at boot.
 *
 * A handshake nobody claimed is NOT the same thing as a socket nobody answered, and this
 * fallback only answers the second: see `upgradeSocketUntouched` below.
 */
const CLAIMED = "crowWsClaimed";

/** This upgrade request's path is owned by the handler calling this. */
export function claimUpgrade(req) {
  try { req[CLAIMED] = true; } catch { /* a frozen request: the fallback answers it */ }
}

/** Has any handler claimed this upgrade request? */
export function upgradeClaimed(req) {
  return Boolean(req && req[CLAIMED]);
}

/**
 * Has nobody answered this upgrade socket yet?
 *
 * The claim is what a handler SHOULD do, but a handshake can be completed without one:
 * an installed copy of a bundle shipped before the claim existed (the kiosk's
 * paired-display path accepts synchronously), or a third-party panel's
 * `setupWebSocket(server)` hook. `ws`'s `handleUpgrade` writes `HTTP/1.1 101` in the same
 * turn, and a socket stays WRITABLE after a 101 — so a 404 written into it lands inside
 * the WebSocket byte stream: the browser reports "Invalid WebSocket frame: RSV1 must be
 * clear" and closes with 1006. A 403/400 refusal written by a non-claiming handler has
 * the same problem, one status block later.
 *
 * So the fallback answers only a socket that carries no answer already:
 *  - `bytesWritten > 0` — a handshake or a refusal is already out (a write reports its
 *    bytes as soon as the bytes are accepted);
 *  - `writableLength > 0` — that write is still queued for this turn, not yet accepted;
 *  - `socket._httpMessage` — an http response object owns the socket;
 *  - it is destroyed, or no longer readable/writable (there is nothing left to answer).
 *
 * `readable`/`writable` are compared to `false` so a stand-in socket in a test (which
 * carries only what it needs) is answered rather than skipped.
 */
export function upgradeSocketUntouched(socket) {
  if (!socket) return false;
  if (socket.destroyed) return false;
  if (socket.readable === false || socket.writable === false) return false;
  if ((socket.bytesWritten || 0) > 0) return false;
  if ((socket.writableLength || 0) > 0) return false;
  if (socket._httpMessage) return false;
  return true;
}

/**
 * The refusal: one status block, then the socket is gone (no half-open connection).
 * Leaves a socket some handler already wrote to completely alone — see
 * `upgradeSocketUntouched`; returns whether anything was written.
 */
export function refuseUnclaimedUpgrade(socket) {
  if (!upgradeSocketUntouched(socket)) return false;
  try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch { /* the client is gone */ }
  try { socket.destroy(); } catch { /* already closed */ }
  return true;
}

/**
 * Install the fallback on a gateway http server. Order does not matter (the answer is
 * decided by the claim and by what the socket already carries — never by listener order),
 * and the same handler is replayed onto the systemd-activated proxy socket by
 * proxy-socket.js's mirrorUpgradeHandlers.
 */
export function installUnclaimedUpgradeFallback(server) {
  if (!server || typeof server.on !== "function") return;
  server.on("upgrade", (req, socket) => {
    if (upgradeClaimed(req)) return;
    setImmediate(() => {
      if (upgradeClaimed(req)) return;
      refuseUnclaimedUpgrade(socket);
    });
  });
}