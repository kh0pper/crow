/**
 * The WebSocket upgrade claim contract, on a REAL gateway in a scratch home.
 *
 * Channel 3 of the AI Companion retirement puts a fallback on the gateway's http server:
 * an upgrade no handler claims is answered `404 Not Found` and the socket closes. That
 * must not cost a working connection, which is what F1 (round 2) was about: a handler
 * that completes a `101` synchronously without claiming (an installed bundle copy from
 * before the claim, or a third-party panel's `setupWebSocket` hook) leaves the socket
 * writable, and the fallback used to write its 404 INTO the WebSocket stream — the client
 * reports "Invalid WebSocket frame: RSV1 must be clear" and closes 1006.
 *
 * So this file drives the real gateway and asserts all three outcomes:
 *   1. a CLAIMED path (`/calls/ws`) is answered by its own handler, never by the fallback;
 *   2. a panel hook that never claims keeps its socket and exchanges a message;
 *   3. a path nobody touches still gets the definite 404 and a closed socket.
 *
 * The panel is loaded the way a real panel is (`<CROW_HOME>/panels/<id>-routes.js` +
 * `panels.json`, wired by panel-registry.js → boot/post-listen.js), and it speaks the
 * handshake by hand so nothing has to be installed in the scratch home. The gateway runs
 * under a scratch `CROW_HOME`/`CROW_DATA_DIR`, so it can never touch the operator's
 * install. The mechanism itself is pinned in tests/ws-upgrade-claim.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { echoRoundTrip, rawUpgrade, statusLineOf, tick } from "./helpers/ws-upgrade-raw.js";

const ROOT = join(import.meta.dirname, "..");

/**
 * The panel's `setupWebSocket(server)` hook. It deliberately never claims (no
 * `claimUpgrade`, no `req.crowWsClaimed`): that is the shape of a hook — or an installed
 * bundle copy — written before the claim contract, and its 101 leaves the socket writable.
 */
const PANEL_ROUTES_SOURCE = `
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Echo text frames back, unmasked, to the client that sends them. */
export function setupWebSocket(server) {
  server.on("upgrade", (req, socket) => {
    if (String(req.url || "").split("?")[0] !== "/nocomp-ws/echo") return;
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
    let buf = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
        if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= buf[off + (i % 4)];
        buf = buf.subarray(off + maskLen + len);
        if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); return; }
        if (payload.length < 126) socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      }
    });
  });
}
`;

const PANEL_SOURCE = `
export default {
  id: "nocomp-ws",
  name: "WS Claim Test",
  icon: "cloud",
  route: "/dashboard/nocomp-ws",
  navOrder: 500,
  handler: async (req, res) => res.type("html").send("<h1>ws claim</h1>"),
};
`;

let child = null;
let port = 0;
let scratch = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function healthOnce(p) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${p}/health`, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(0));
    req.setTimeout(1500, () => { req.destroy(); resolve(0); });
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "crow-ws-claim-"));
  const home = join(scratch, "home");
  const dataDir = join(scratch, "data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(home, "panels"), { recursive: true });
  writeFileSync(join(home, "panels", "nocomp-ws.js"), PANEL_SOURCE);
  writeFileSync(join(home, "panels", "nocomp-ws-routes.js"), PANEL_ROUTES_SOURCE);
  writeFileSync(join(home, "panels.json"), JSON.stringify(["nocomp-ws"]));
  const env = {
    ...process.env,
    HOME: scratch,
    CROW_HOME: home,
    CROW_DATA_DIR: dataDir,
    CROW_DB_PATH: join(dataDir, "crow.db"),
    CROW_AUTO_UPDATE: "0",
    CROW_DISABLE_HEALTH_MONITOR: "1",
    CROW_DISABLE_INSTANCE_SYNC: "1",
    CROW_DISABLE_NOSTR: "1",
    CROW_DISABLE_NTFY_AUTOWIRE: "1",
    // The claimed path this file checks is /calls/ws, and the signaling relay only mounts
    // behind this gate (boot/late-mounts.js); without it the path really is unowned.
    CROW_CALLS_ENABLED: "1",
  };
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, cwd: ROOT, stdio: "pipe" });
  port = await freePort();
  child = spawn(process.execPath, ["servers/gateway/index.js", "--no-auth"], {
    env: { ...env, PORT: String(port), CROW_GATEWAY_URL: `http://127.0.0.1:${port}` },
    cwd: ROOT,
    stdio: "pipe",
  });
  // The panel's upgrade handler is wired in the post-listen setup, after the server is up:
  // wait for its own log line, so the assertions below never race the wiring.
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.resume();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the gateway exited (${child.exitCode}) before the panel hook was wired:\n${out.slice(-2000)}`);
    if (out.includes("[panel] nocomp-ws WebSocket handler mounted") && (await healthOnce(port)) === 200) return;
    await tick(200);
  }
  throw new Error(`the gateway never wired the panel WebSocket hook:\n${out.slice(-2000)}`);
});

after(() => {
  if (child && child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* best effort */ } }
  // A killed gateway's pipe can stay open if something it spawned inherited it; the test
  // process must never be held open by it.
  try { child?.stdout?.destroy(); } catch { /* best effort */ }
  try { child?.stderr?.destroy(); } catch { /* best effort */ }
  if (scratch) rmScratch(scratch);
});

test("live gateway: a panel hook that never claims keeps its socket and exchanges a message", async () => {
  await echoRoundTrip(port, "/nocomp-ws/echo");
});

test("live gateway: a CLAIMED path (/calls/ws) is answered by its own handler, never by the fallback", async () => {
  const answer = await rawUpgrade(port, "/calls/ws");
  assert.equal(answer.why, "closed", "the calls handler answers and closes");
  assert.match(statusLineOf(answer.buf), /\s400\b/, `the signaling handler's own refusal (got ${statusLineOf(answer.buf) || "(no answer)"})`);
  assert.doesNotMatch(answer.buf, /\s404\b/, "the fallback did not answer a claimed path");
  assert.equal(statusLineOf(answer.buf).match(/HTTP\/1\.1/g)?.length, 1, "exactly one status block");
});

test("live gateway: a path nobody owns still gets the 404 and a closed socket", async () => {
  const answer = await rawUpgrade(port, "/no-such-upgrade-path");
  assert.equal(answer.why, "closed", `the refused socket is closed (got ${answer.why})`);
  assert.match(statusLineOf(answer.buf), /\s404\b/, `an unowned upgrade is answered 404 (got ${statusLineOf(answer.buf) || "(no answer)"})`);
});