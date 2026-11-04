#!/usr/bin/env node
/**
 * A fake Chromium for tests/browser-cdp-relay.test.js: it speaks the real
 * `--remote-debugging-pipe` framing (fds 3 and 4, JSON + NUL) and implements just
 * enough of the Target/Browser domain — plus a few `Test.*` methods — for the relay's
 * multiplexing rules to be observable.
 *
 * Every message it receives, its own argv and its env are appended to
 * $FAKE_CHROME_LOG as JSON lines, so a test can assert what the relay forwarded
 * (ids, sessionId stamps) and that the CDP token never reached Chromium.
 *
 * Sessions it hands out are distinguishable by their prefix: `S…` for a browser
 * target session, `T…` for Target.attachToTarget, `A…` for an auto-attached child.
 * A session-addressed response echoes `sessionId`, exactly as Chromium does.
 */
import { appendFileSync, createReadStream, createWriteStream } from "node:fs";

const LOG = process.env.FAKE_CHROME_LOG || "";
const trace = (obj) => { if (LOG) { try { appendFileSync(LOG, JSON.stringify(obj) + "\n"); } catch { /* gone */ } } };

const VERSION = {
  protocolVersion: "1.3",
  product: "FakeChrome/1.0.0",
  revision: "fake-rev-1",
  userAgent: "FakeChrome/1.0.0 (pipe)",
  jsVersion: "11.1.0",
};

trace({ t: "argv", argv: process.argv.slice(1) });
trace({ t: "env", env: { ...process.env } });
trace({ t: "pid", pid: process.pid });

const out = createWriteStream(null, { fd: 4 });
out.on("error", () => process.exit(0));
function send(msg) {
  try { out.write(JSON.stringify(msg) + "\0"); } catch { process.exit(0); }
}

let browserSessions = 0;
let attached = 0;
let autoAttached = 0;

function handle(msg) {
  trace({ t: "recv", id: msg.id === undefined ? null : msg.id, method: msg.method || null, sessionId: msg.sessionId ?? null, params: msg.params ?? null });
  if (msg.id === undefined) return; // a notification: nothing to answer
  const sid = typeof msg.sessionId === "string" ? msg.sessionId : null;
  const reply = (result) => send({ id: msg.id, ...(sid ? { sessionId: sid } : {}), result });
  switch (msg.method) {
    case "Browser.getVersion":
      reply(VERSION);
      return;
    case "Browser.close":
      trace({ t: "browser-close" });
      setTimeout(() => process.exit(0), 20);
      reply({});
      return;
    case "Target.attachToBrowserTarget":
      reply({ sessionId: `S${++browserSessions}` });
      return;
    case "Target.attachToTarget":
      reply({ sessionId: `T${++attached}` });
      return;
    case "Target.setAutoAttach": {
      const child = `A${++autoAttached}`;
      reply({});
      setImmediate(() => send({ method: "Target.attachedToTarget", ...(sid ? { sessionId: sid } : {}), params: { sessionId: child, targetInfo: { targetId: child, type: "page" }, waitingForDebugger: false } }));
      return;
    }
    case "Target.detachFromTarget":
      trace({ t: "detached", sessionId: msg.params?.sessionId ?? null, from: sid });
      reply({});
      return;
    case "Test.echo":
      reply({ value: msg.params?.value ?? null, got: sid });
      return;
    case "Test.event":
      // Emit an event addressed to a session the TEST chooses (or to none at all).
      send({ method: "Test.event", ...(msg.params?.to ? { sessionId: msg.params.to } : {}), params: { payload: msg.params?.payload ?? null } });
      reply({ sent: true });
      return;
    case "Test.stream": {
      const count = Number(msg.params?.count ?? 1);
      const body = "x".repeat(Number(msg.params?.size ?? 1024));
      for (let i = 0; i < count; i++) send({ method: "Test.chunk", ...(sid ? { sessionId: sid } : {}), params: { i, body } });
      reply({ chunks: count });
      return;
    }
    case "Test.detachChild":
      send({ method: "Target.detachedFromTarget", ...(sid ? { sessionId: sid } : {}), params: { sessionId: msg.params?.child, targetId: msg.params?.child } });
      reply({});
      return;
    case "Test.exit":
      trace({ t: "exiting", code: Number(msg.params?.code ?? 0) });
      process.exit(Number(msg.params?.code ?? 0));
      return;
    default:
      reply({});
  }
}

let parts = [];
const input = createReadStream(null, { fd: 3 });
input.on("error", () => process.exit(0));
input.on("data", (chunk) => {
  let start = 0;
  for (;;) {
    const nul = chunk.indexOf(0, start);
    if (nul === -1) { parts.push(chunk.subarray(start)); return; }
    parts.push(chunk.subarray(start, nul));
    const frame = Buffer.concat(parts).toString("utf8");
    parts = [];
    start = nul + 1;
    let msg;
    try { msg = JSON.parse(frame); } catch { trace({ t: "unparsable", frame: frame.slice(0, 200) }); continue; }
    handle(msg);
  }
});
input.on("end", () => process.exit(0));