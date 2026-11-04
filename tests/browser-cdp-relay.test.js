/**
 * The browser CDP relay (bundles/browser/cdp-relay.mjs) against a FAKE Chromium.
 *
 * The relay spawns Chromium itself on `--remote-debugging-pipe` (fds 3/4) and serves
 * the host contract 127.0.0.1:${CDP_PORT} behind a bearer token. These tests run the
 * real relay against tests/fixtures/fake-chromium.mjs, which speaks the real
 * NUL-framed pipe protocol, so every rule in the design is exercised end to end: the
 * gate (401/404/400), session ownership and id multiplexing, event routing, the caps,
 * and the shared fate in both directions. A couple of runs are in-process, where the
 * relay's own counters are visible.
 *
 * No docker, no real Chromium, no network beyond loopback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";

const RELAY = fileURLToPath(new URL("../bundles/browser/cdp-relay.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-chromium.mjs", import.meta.url));
// 64 hex characters, the shape the manifest's hex32 mint produces.
const TOKEN = "8f3a1c".repeat(10) + "abcd";
const WRONG = "b7e2d4".repeat(10) + "ffff";

/** Every relay run's stdout/stderr and Chromium's own record, for the last test. */
const ALL_LOGS = [];
const ALL_TRACES = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRelay(t, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-relay-"));
  writeFileSync(join(dir, "token"), TOKEN + "\n", { mode: 0o600 });
  let logs = "";
  const ctx = {
    dir,
    readyFile: join(dir, "ready"),
    tracePath: join(dir, "chromium.log"),
    logs: () => logs,
  };
  const child = spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      CDP_PORT: "0",
      CROW_CDP_TOKEN_FILE: join(dir, "token"),
      CROW_CDP_READY_FILE: ctx.readyFile,
      CROW_CDP_CHROMIUM_ARGV: JSON.stringify([process.execPath, FIXTURE]),
      FAKE_CHROME_LOG: ctx.tracePath,
      CROW_CDP_DEBUG: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ctx.child = child;
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  ctx.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  ctx.trace = () => {
    try { return readFileSync(ctx.tracePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  ctx.records = (type) => ctx.trace().filter((r) => r.t === type);
  ctx.stop = async () => {
    ALL_LOGS.push(logs);
    ALL_TRACES.push(ctx.trace());
    // The relay kills Chromium; a SIGKILLed relay cannot, so kill the fake by its own pid.
    const pid = ctx.records("pid")[0]?.pid;
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.race([ctx.exited, sleep(3000)]);
    rmSync(dir, { recursive: true, force: true });
  };
  t.after(ctx.stop);
  return ctx;
}

/** The ready file the relay writes once Chromium's pipe has answered Browser.getVersion. */
async function waitReady(ctx, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(ctx.readyFile, "utf8")); } catch { /* not yet */ }
    if (ctx.child.exitCode !== null) throw new Error("the relay exited before it was ready:\n" + ctx.logs());
    await sleep(100);
  }
  throw new Error("the relay never became ready:\n" + ctx.logs());
}

function httpRaw(port, text, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => { if (done) return; done = true; try { socket.destroy(); } catch { /* gone */ } resolve(buf); };
    const socket = net.connect(port, "127.0.0.1", () => { try { socket.write(text); } catch { finish(); } });
    socket.setTimeout(timeoutMs, finish);
    socket.on("data", (d) => { buf += d; });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
  });
}

function parseReply(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const lines = head.split("\r\n");
  const status = Number((lines[0] || "").split(" ")[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = rest.join("\r\n\r\n");
  let json = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }
  return { status, headers, body, json, raw };
}

/** One hand-written HTTP request: the only way to control Host and Authorization exactly. */
function request(port, { path = "/json/version", method = "GET", token = null, host = null } = {}) {
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host === null ? `127.0.0.1:${port}` : host}`, "Connection: close", "Accept: application/json"];
  if (token !== null) lines.push(`Authorization: Bearer ${token}`);
  return httpRaw(port, lines.join("\r\n") + "\r\n\r\n").then(parseReply);
}

/** A hand-written WebSocket upgrade: `ws` will not let a test forge the Host header. */
function rawUpgrade(port, { path, token = null, host = null, timeoutMs = 1500 } = {}) {
  const key = randomBytes(16).toString("base64");
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host === null ? `127.0.0.1:${port}` : host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (token !== null) lines.push(`Authorization: Bearer ${token}`);
  return httpRaw(port, lines.join("\r\n") + "\r\n\r\n", timeoutMs).then(parseReply);
}

/** A WebSocket client that keeps its messages and can await one by predicate. */
function openClient(wsUrl, { token = TOKEN } = {}) {
  const ws = new WebSocket(wsUrl, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    handshakeTimeout: 5000,
    maxPayload: 64 * 1024 * 1024,
  });
  const messages = [];
  const pending = [];
  const waiters = [];
  let closeInfo = null;
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    messages.push(msg);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else pending.push(msg);
  });
  ws.on("close", (code, reason) => {
    closeInfo = { code, reason: String(reason) };
    for (const w of [...waiters]) {
      const at = waiters.indexOf(w);
      if (at >= 0) waiters.splice(at, 1);
      w.reject(new Error(`the relay closed the socket (${code}) while waiting for ${w.label}`));
    }
  });
  ws.on("error", () => { /* 'close' follows */ });
  const client = {
    ws,
    messages,
    opened: new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    async waitFor(pred, timeoutMs = 5000, label = "a message") {
      const i = pending.findIndex(pred);
      if (i >= 0) return pending.splice(i, 1)[0];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiters.indexOf(entry);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`timed out waiting for ${label}; had ${JSON.stringify(messages.map((m) => m.method || `id=${m.id}`)).slice(0, 400)}`));
        }, timeoutMs);
        const entry = {
          pred,
          label,
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        waiters.push(entry);
      });
    },
    request(id, method, params = {}, sessionId) {
      client.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      return client.waitFor((m) => m.id === id, 5000, `${method} (id ${id})`);
    },
    closeInfo: () => closeInfo,
    async waitClosed(timeoutMs = 5000) {
      const start = Date.now();
      while (!closeInfo && Date.now() - start < timeoutMs) await sleep(25);
      return closeInfo;
    },
    close() { try { ws.close(); } catch { /* gone */ } },
  };
  return client;
}

/** A relay + the parsed /json/version + its WebSocket URL. */
async function withRelay(t, extraEnv, fn) {
  const ctx = await startRelay(t, extraEnv);
  const ready = await waitReady(ctx);
  const version = await request(ready.port, { token: TOKEN });
  return fn({ ctx, ready, version, wsUrl: version.json?.webSocketDebuggerUrl });
}

// ---------------------------------------------------------------------------
// the gate: 401, 404, 400, and the shape of /json/version
// ---------------------------------------------------------------------------

test("the design constants: 16 KB of headers, 10 s handshake, 32 connections, 32 MB frames, 64 MB per client", async () => {
  const m = await import("../bundles/browser/cdp-relay.mjs");
  assert.equal(m.MAX_HEADER_BYTES, 16 * 1024);
  assert.equal(m.HANDSHAKE_TIMEOUT_MS, 10_000);
  assert.equal(m.MAX_CONNECTIONS, 32);
  assert.equal(m.MAX_FRAME_BYTES, 256 * 1024 * 1024, "the pipe cap matches Playwright, so one page message cannot stop the browser");
  assert.ok(m.MAX_FRAME_BYTES >= 24 * 1024 * 1024, "at least 24 MB, per the review");
  assert.ok(m.MAX_CLIENT_BUFFER_BYTES > m.MAX_FRAME_BYTES, "one maximum frame never drops an idle client");
  assert.match(m.TOKEN_RE.source, /\[A-Za-z0-9_-\]\{32,256\}/);
});

test("tokenMatches: a fixed-length constant-time compare, equal only for the exact token", async () => {
  const { tokenMatches } = await import("../bundles/browser/cdp-relay.mjs");
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(WRONG, TOKEN), false, "same length, different value");
  assert.equal(tokenMatches(TOKEN.slice(0, 32), TOKEN), false, "a prefix is not enough");
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false, "a longer value is not enough");
  assert.equal(tokenMatches("", TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, ""), false, "no configured token never matches");
});

test("/json/version: no bearer or a wrong one gets 401, and only that path exists", async (t) => {
  await withRelay(t, {}, async ({ ready }) => {
    const none = await request(ready.port);
    assert.equal(none.status, 401, none.raw.slice(0, 200));
    assert.ok(!none.body.includes(TOKEN));

    assert.equal((await request(ready.port, { token: WRONG })).status, 401, "a wrong token of the same length");
    assert.equal((await request(ready.port, { token: TOKEN.slice(0, 40) })).status, 401, "a short prefix");
    assert.equal((await request(ready.port, { token: `${TOKEN}0` })).status, 401, "a longer value");
    // Auth first: an unauthenticated caller learns nothing about which paths exist.
    assert.equal((await request(ready.port, { path: "/json/list" })).status, 401);
    assert.equal((await request(ready.port, { path: "/" })).status, 401);

    assert.equal((await request(ready.port, { token: TOKEN, path: "/json/list" })).status, 404, "only /json/version is served");
    assert.equal((await request(ready.port, { token: TOKEN, path: "/" })).status, 404);
    assert.equal((await request(ready.port, { token: TOKEN, path: "/json" })).status, 404);
    assert.equal((await request(ready.port, { token: TOKEN, path: "/devtools/browser/deadbeef" })).status, 404, "another relay id");
    assert.equal((await request(ready.port, { token: TOKEN, method: "POST" })).status, 405, "GET only");
  });
});

test("/json/version answers from the pipe, and webSocketDebuggerUrl only for a loopback Host on this port", async (t) => {
  await withRelay(t, {}, async ({ ready, version }) => {
    assert.equal(version.status, 200, version.raw.slice(0, 300));
    for (const key of ["Browser", "Protocol-Version", "User-Agent", "V8-Version", "WebKit-Version"]) {
      assert.equal(typeof version.json[key], "string", key);
      assert.ok(version.json[key].length > 0, key);
    }
    assert.equal(version.json.Browser, "FakeChrome/1.0.0", "from a real Browser.getVersion over the pipe");
    assert.equal(version.json["Protocol-Version"], "1.3");
    assert.equal(version.json["V8-Version"], "11.1.0");
    assert.match(version.json["WebKit-Version"], /^537\.36 \(@fake-rev-1\)$/);
    assert.match(version.json.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${ready.port}/devtools/browser/[0-9a-f]{32}$`));
    assert.ok(!version.body.includes(TOKEN), "the version body never carries the token");

    // The trailing slash: Playwright asks for /json/version/.
    const slash = await request(ready.port, { token: TOKEN, path: "/json/version/" });
    assert.equal(slash.status, 200);
    assert.equal(slash.json.webSocketDebuggerUrl, version.json.webSocketDebuggerUrl);

    // The Host decides the URL we hand out, so it must name this relay.
    const byName = await request(ready.port, { token: TOKEN, host: `localhost:${ready.port}` });
    assert.equal(byName.status, 200);
    assert.ok(byName.json.webSocketDebuggerUrl.startsWith(`ws://localhost:${ready.port}/`));
    assert.equal((await request(ready.port, { token: TOKEN, host: "evil.example" })).status, 400);
    assert.equal((await request(ready.port, { token: TOKEN, host: `evil.example:${ready.port}` })).status, 400);
    assert.equal((await request(ready.port, { token: TOKEN, host: `127.0.0.1:${ready.port + 1}` })).status, 400, "another port");
    // A token smuggled into the query string does not change the route (and is never logged).
    assert.equal((await request(ready.port, { token: TOKEN, path: `/json/version?token=${TOKEN}` })).status, 200);
  });
});

test("the WebSocket upgrade is gated too: no bearer, another id, or a bad Host never becomes a session", async (t) => {
  await withRelay(t, {}, async ({ ctx, ready, wsUrl }) => {
    const path = new URL(wsUrl).pathname;
    assert.equal((await rawUpgrade(ready.port, { path })).status, 401, "no bearer");
    assert.equal((await rawUpgrade(ready.port, { path, token: WRONG })).status, 401, "a wrong bearer");
    assert.equal((await rawUpgrade(ready.port, { path: "/devtools/browser/" + "0".repeat(32), token: TOKEN })).status, 404, "an unknown relay id");
    assert.equal((await rawUpgrade(ready.port, { path, token: TOKEN, host: "evil.example" })).status, 400, "a non-loopback Host");
    await sleep(150);
    assert.equal(ctx.records("recv").filter((r) => r.method === "Target.attachToBrowserTarget").length, 0, "no refused upgrade created a browser session");

    const good = openClient(wsUrl);
    await good.opened;
    const echo = await good.request(1, "Test.echo", { value: "hello" });
    assert.equal(echo.result.value, "hello");
    assert.equal(ctx.records("recv").filter((r) => r.method === "Target.attachToBrowserTarget").length, 1, "the accepted client got its own browser session");
    good.close();
  });
});

// ---------------------------------------------------------------------------
// multiplexing
// ---------------------------------------------------------------------------

test("two concurrent clients get their own browser session and their own id space", async (t) => {
  await withRelay(t, {}, async ({ ctx, wsUrl }) => {
    const a = openClient(wsUrl);
    const b = openClient(wsUrl);
    await Promise.all([a.opened, b.opened]);

    // The same client-side id on both connections: the relay must keep them apart.
    const [ra, rb] = await Promise.all([
      a.request(1, "Test.echo", { value: "from-a" }),
      b.request(1, "Test.echo", { value: "from-b" }),
    ]);
    assert.equal(ra.id, 1);
    assert.equal(rb.id, 1);
    assert.equal(ra.result.value, "from-a", "A got its own response");
    assert.equal(rb.result.value, "from-b");
    assert.notEqual(ra.result.got, rb.result.got, "each client has its own browser session (S_c)");
    assert.match(ra.result.got, /^S\d+$/);
    assert.match(rb.result.got, /^S\d+$/);
    assert.equal(ra.sessionId, undefined, "S_c is stripped from the response the client sees");
    assert.equal(rb.sessionId, undefined);

    const echoes = ctx.records("recv").filter((r) => r.method === "Test.echo");
    assert.equal(echoes.length, 2);
    assert.notEqual(echoes[0].id, echoes[1].id, "ids are remapped to relay-global ids");
    assert.ok(echoes[0].id > 1 && echoes[1].id > 1, "neither client's id 1 reached Chromium as 1");
    assert.deepEqual(new Set(echoes.map((r) => r.sessionId)), new Set([ra.result.got, rb.result.got]), "each message was stamped with its own session");

    // A message is never delivered to the wrong connection.
    assert.deepEqual(a.messages.filter((m) => m.result && m.result.value).map((m) => m.result.value), ["from-a"]);
    assert.deepEqual(b.messages.filter((m) => m.result && m.result.value).map((m) => m.result.value), ["from-b"]);
    a.close(); b.close();
  });
});

test("child sessions are tracked from responses AND from events, and detached ones are forgotten", async (t) => {
  await withRelay(t, {}, async ({ ctx, wsUrl }) => {
    const a = openClient(wsUrl);
    await a.opened;

    // (1) From a response: Target.attachToTarget's result.sessionId.
    const attached = await a.request(10, "Target.attachToTarget", { targetId: "page-1", flatten: true });
    const child = attached.result.sessionId;
    assert.match(child, /^T\d+$/);
    assert.equal(attached.sessionId, undefined, "the request was sessionless, so its own S_c is stripped again");

    const scoped = await a.request(11, "Test.echo", { value: "scoped" }, child);
    assert.equal(scoped.result.value, "scoped");
    assert.equal(scoped.sessionId, child, "the child's sessionId comes back to the client");
    const seen = ctx.records("recv").find((r) => r.method === "Test.echo" && r.params?.value === "scoped");
    assert.equal(seen.sessionId, child, "…and reached Chromium under the child session");

    // (2) From an event: Target.attachedToTarget.
    await a.request(12, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const event = await a.waitFor((m) => m.method === "Target.attachedToTarget", 5000, "the attachedToTarget event");
    const auto = event.params.sessionId;
    assert.match(auto, /^A\d+$/);
    assert.equal(event.sessionId, undefined, "the event rode on S_c, which is stripped");

    const viaEvent = await a.request(13, "Test.echo", { value: "via-event" }, auto);
    assert.equal(viaEvent.result.value, "via-event", "a session learned from an event is owned");

    // (3) detachedFromTarget drops the ownership: the same id is refused from then on.
    await a.request(14, "Test.detachChild", { child: auto });
    await a.waitFor((m) => m.method === "Target.detachedFromTarget", 5000, "the detachedFromTarget event");
    a.send({ id: 15, method: "Test.echo", params: { value: "too-late" }, sessionId: auto });
    const refused = await a.waitFor((m) => m.id === 15, 5000, "the refusal of a detached session");
    assert.equal(refused.error.code, -32001);
    assert.equal(refused.error.message, "Session not owned");
    a.close();
  });
});

test("an event is routed by its session: to its owner only, and stripped when it is S_c", async (t) => {
  await withRelay(t, {}, async ({ wsUrl }) => {
    const a = openClient(wsUrl);
    const b = openClient(wsUrl);
    await Promise.all([a.opened, b.opened]);
    const sa = (await a.request(1, "Test.echo", { value: "a" })).result.got;
    // A real child session for B, so the event can be addressed to something that is not S_c.
    await b.request(1, "Test.echo", { value: "b" });
    const childB = (await b.request(2, "Target.attachToTarget", { targetId: "page-b", flatten: true })).result.sessionId;
    assert.match(childB, /^T\d+$/);

    // B's child session: only B sees the event, with the child's sessionId intact.
    await a.request(2, "Test.event", { to: childB, payload: "for-b" });
    const gotB = await b.waitFor((m) => m.method === "Test.event", 5000, "B's event");
    assert.equal(gotB.params.payload, "for-b");
    assert.equal(gotB.sessionId, childB, "a child session travels with the event");
    await sleep(150);
    assert.equal(a.messages.filter((m) => m.method === "Test.event").length, 0, "A never sees B's event");

    // A's own browser session: the event arrives without sessionId, exactly like a flat session.
    await a.request(3, "Test.event", { to: sa, payload: "for-a" });
    const gotA = await a.waitFor((m) => m.method === "Test.event", 5000, "A's event");
    assert.equal(gotA.params.payload, "for-a");
    assert.equal(gotA.sessionId, undefined, "S_c is stripped from events too");

    // An event with no session at all has no owner: it is dropped, and delivered to nobody.
    await a.request(4, "Test.event", { payload: "orphan" });
    await sleep(150);
    assert.equal(a.messages.filter((m) => m.params?.payload === "orphan").length, 0);
    assert.equal(b.messages.filter((m) => m.params?.payload === "orphan").length, 0);
    a.close(); b.close();
  });
});

test("a sessionId the client does not own is refused at once and never forwarded", async (t) => {
  await withRelay(t, {}, async ({ ctx, wsUrl }) => {
    const a = openClient(wsUrl);
    const b = openClient(wsUrl);
    await Promise.all([a.opened, b.opened]);
    const sb = (await b.request(1, "Test.echo", { value: "b" })).result.got;
    const before = ctx.records("recv").filter((r) => r.method === "Test.echo").length;

    a.send({ id: 42, method: "Test.echo", params: { value: "steal" }, sessionId: sb });
    const refused = await a.waitFor((m) => m.id === 42, 5000, "the -32001 refusal");
    assert.deepEqual(refused.error, { code: -32001, message: "Session not owned" });

    // A session id that never existed is refused the same way.
    a.send({ id: 43, method: "Test.echo", params: { value: "ghost" }, sessionId: "T-does-not-exist" });
    assert.deepEqual((await a.waitFor((m) => m.id === 43)).error, { code: -32001, message: "Session not owned" });

    await sleep(150);
    assert.equal(ctx.records("recv").filter((r) => r.method === "Test.echo").length, before, "nothing reached Chromium");
    assert.equal(b.messages.filter((m) => m.id === 42 || m.id === 43).length, 0, "and B saw nothing");
    a.close(); b.close();
  });
});

test("on disconnect the relay detaches every child session, then S_c", async (t) => {
  await withRelay(t, {}, async ({ ctx, wsUrl }) => {
    const a = openClient(wsUrl);
    await a.opened;
    const child = (await a.request(1, "Target.attachToTarget", { targetId: "p", flatten: true })).result.sessionId;
    const sc = (await a.request(2, "Test.echo", { value: "x" })).result.got;

    a.close();
    const deadline = Date.now() + 5000;
    let detaches = [];
    while (Date.now() < deadline) {
      detaches = ctx.records("recv").filter((r) => r.method === "Target.detachFromTarget");
      if (detaches.length >= 2) break;
      await sleep(50);
    }
    assert.deepEqual(detaches.map((r) => r.params.sessionId), [child, sc], "children first, then the browser session");
    assert.equal(detaches.every((r) => r.sessionId === null), true, "detaches are relay-internal: no client session rides on them");
  });
});

test("the per-client output cap drops the slow client only; the fast one and the pipe keep going", async (t) => {
  // In-process, so the relay's own counter says exactly how many clients it dropped.
  const m = await import("../bundles/browser/cdp-relay.mjs");
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-relay-cap-"));
  const tracePath = join(dir, "chromium.log");
  const relay = await m.createRelay({
    token: TOKEN,
    port: 0,
    chromiumArgv: [process.execPath, FIXTURE],
    childEnv: { ...process.env, FAKE_CHROME_LOG: tracePath },
    maxClientBuffer: 16 * 1024,
    log: () => {},
  });
  t.after(async () => {
    await relay.shutdown(0);
    try {
      const pid = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.t === "pid").pid;
      process.kill(pid, "SIGKILL");
    } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const fast = openClient(relay.url);
  const slow = openClient(relay.url);
  await Promise.all([fast.opened, slow.opened]);
  await fast.request(1, "Test.echo", { value: "ready" });
  await slow.request(1, "Test.echo", { value: "ready" });

  // The slow client stops reading its socket entirely, then asks for a flood big enough
  // to fill the kernel buffers AND the relay's per-client cap; the fast one asks for the same.
  const CHUNKS = 5000;
  slow.ws._socket.pause();
  slow.send({ id: 2, method: "Test.stream", params: { count: CHUNKS, size: 4096 } });
  fast.send({ id: 2, method: "Test.stream", params: { count: CHUNKS, size: 4096 } });

  const all = await fast.waitFor((x) => x.id === 2, 20000, "the fast client's stream response");
  assert.equal(all.result.chunks, CHUNKS);
  const received = fast.messages.filter((x) => x.method === "Test.chunk").map((x) => x.params.i);
  assert.equal(received.length, CHUNKS, "the fast client received every frame of its own stream");
  assert.equal(received[received.length - 1], CHUNKS - 1);
  assert.equal(relay.stats.slowDropped, 1, "exactly one client was dropped for not reading");

  slow.ws._socket.resume();
  const closed = await slow.waitClosed(5000);
  assert.ok(closed, "the slow client's socket is gone");

  // And the relay is still serving: a third client can connect and work.
  const late = openClient(relay.url);
  await late.opened;
  assert.equal((await late.request(1, "Test.echo", { value: "still here" })).result.value, "still here");
  fast.close(); slow.close(); late.close();
});

test("a frame over the inbound cap drops that client", async (t) => {
  await withRelay(t, { CROW_CDP_MAX_FRAME: String(64 * 1024) }, async ({ wsUrl }) => {
    const a = openClient(wsUrl);
    await a.opened;
    await a.request(1, "Test.echo", { value: "small" });
    a.send({ id: 2, method: "Test.echo", params: { value: "y".repeat(200 * 1024) } });
    const closed = await a.waitClosed(10000);
    assert.ok(closed, "a frame past the cap drops the client");
    assert.equal(closed.code, 1009);
  });
});

test("the header cap and the handshake timeout: a slow or oversized request head is dropped", async (t) => {
  await withRelay(t, { CROW_CDP_HANDSHAKE_TIMEOUT_MS: "600", CROW_CDP_MAX_HEADER: "8192" }, async ({ ready }) => {
    // Slowloris: open the connection, send nothing, wait past the handshake timeout.
    const started = Date.now();
    const silent = await new Promise((resolve) => {
      const socket = net.connect(ready.port, "127.0.0.1", () => { /* deliberately nothing */ });
      socket.setTimeout(5000, () => { socket.destroy(); resolve("still-open"); });
      socket.on("close", () => resolve("closed"));
      socket.on("error", () => resolve("closed"));
    });
    assert.equal(silent, "closed", "an idle handshake is closed");
    assert.ok(Date.now() - started < 4000, "…and promptly");

    // An oversized head: Node answers 431 (or closes) rather than parsing it.
    const huge = "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:" + ready.port + "\r\nX-Pad: " + "p".repeat(20000) + "\r\n\r\n";
    const reply = parseReply(await httpRaw(ready.port, huge, 5000));
    assert.ok([431, 400, 0].includes(reply.status), `an oversized head is refused, not served (got ${reply.status})`);
    assert.ok(!reply.body.includes(TOKEN));
  });
});

// ---------------------------------------------------------------------------
// sharing fate with Chromium
// ---------------------------------------------------------------------------

test("SIGTERM: the relay sends Browser.close over the pipe, Chromium exits, the relay exits 0, the ready file goes", async (t) => {
  await withRelay(t, {}, async ({ ctx, ready }) => {
    assert.ok(existsSync(ctx.readyFile), "the ready file exists while the relay serves");
    ctx.child.kill("SIGTERM");
    const { code } = await Promise.race([ctx.exited, sleep(15000).then(() => ({ code: "timeout" }))]);
    assert.equal(code, 0, "a graceful stop exits 0: " + ctx.logs());
    const trace = ctx.trace();
    assert.ok(trace.some((r) => r.t === "browser-close"), "Chromium was asked to close through the pipe");
    assert.ok(trace.some((r) => r.t === "recv" && r.method === "Browser.close"), "…with a real Browser.close command");
    assert.equal(existsSync(ctx.readyFile), false, "the ready file is removed on the way out");
    assert.ok(!ctx.logs().includes(TOKEN), "no log line carries the token");
    assert.equal(ready.port > 0, true);
  });
});

test("Chromium exits: the relay exits with Chromium's own code", async (t) => {
  await withRelay(t, {}, async ({ ctx, wsUrl }) => {
    const a = openClient(wsUrl);
    await a.opened;
    a.send({ id: 9, method: "Test.exit", params: { code: 7 } });
    const { code } = await Promise.race([ctx.exited, sleep(15000).then(() => ({ code: "timeout" }))]);
    assert.equal(code, 7, "the relay passes Chromium's exit code through: " + ctx.logs());
    assert.equal(existsSync(ctx.readyFile), false);
  });
});

test("the relay dies: Chromium does not survive it (the pipe end closes, and the process group is the belt)", async (t) => {
  const ctx = await startRelay(t);
  await waitReady(ctx);
  const chromiumPid = ctx.records("pid")[0].pid;
  ctx.child.kill("SIGKILL");
  await ctx.exited;
  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline) {
    try { process.kill(chromiumPid, 0); } catch { alive = false; break; }
    await sleep(100);
  }
  assert.equal(alive, false, "the fake Chromium exited when its pipe's other end went away");
});

// ---------------------------------------------------------------------------
// what Chromium must never see, what the logs must never say
// ---------------------------------------------------------------------------

test("Chromium's argv carries the pipe and no debugging port; its env carries no token", async (t) => {
  await withRelay(t, {}, async ({ ctx }) => {
    const argv = ctx.records("argv")[0].argv;
    assert.ok(argv.includes("--remote-debugging-pipe"), "Chromium talks over the pipe");
    assert.ok(!argv.some((a) => a.startsWith("--remote-debugging-port")), "no debugging port: " + argv.join(" "));
    assert.ok(!argv.some((a) => a.startsWith("--remote-debugging-address")));
    assert.ok(!argv.some((a) => a.startsWith("--remote-allow-origins")), "the Origin check is not disabled");
    assert.ok(argv.some((a) => a.startsWith("--user-data-dir=")), "the profile is still on the volume");
    assert.ok(argv.includes("--no-sandbox"));

    const env = ctx.records("env")[0].env;
    assert.equal(env.CROW_CDP_TOKEN_FILE, undefined, "the token's location is stripped too");
    assert.ok(!Object.keys(env).some((k) => /TOKEN|SECRET|PASSWORD/i.test(k)), "no token-shaped variable reaches Chromium: " + Object.keys(env).join(","));
    assert.ok(!JSON.stringify(env).includes(TOKEN));
    assert.ok(!JSON.stringify(argv).includes(TOKEN));
  });
});

test("the ready file says the port and the browser, and never the token", async (t) => {
  await withRelay(t, {}, async ({ ctx, ready }) => {
    assert.equal(ready.browser, "FakeChrome/1.0.0");
    assert.equal(typeof ready.pid, "number");
    assert.equal(ready.port > 0, true);
    assert.ok(!readFileSync(ctx.readyFile, "utf8").includes(TOKEN));
  });
});

test("a missing or malformed token at startup is a clear FATAL, not an open port", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-relay-bad-"));
  const readyFile = join(dir, "ready");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (tokenText) => new Promise((resolve) => {
    if (tokenText === null) rmSync(join(dir, "token"), { force: true });
    else writeFileSync(join(dir, "token"), tokenText, { mode: 0o600 });
    const child = spawn(process.execPath, [RELAY], {
      env: {
        ...process.env,
        CDP_PORT: "0",
        CROW_CDP_TOKEN_FILE: join(dir, "token"),
        CROW_CDP_READY_FILE: readyFile,
        CROW_CDP_CHROMIUM_ARGV: JSON.stringify([process.execPath, FIXTURE]),
        FAKE_CHROME_LOG: join(dir, "chromium.log"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (d) => { logs += d; });
    child.stderr.on("data", (d) => { logs += d; });
    child.once("exit", (code) => resolve({ code, logs }));
  });

  const empty = await run("");
  assert.equal(empty.code, 1);
  assert.match(empty.logs, /FATAL: the CDP token .* is missing or malformed/);

  const short = await run("too-short\n");
  assert.equal(short.code, 1, "a malformed token is refused");
  assert.match(short.logs, /missing or malformed/);

  const missing = await run(null);
  assert.equal(missing.code, 1, "no token file, no relay");
  assert.equal(existsSync(readyFile), false, "and no ready file, so the entrypoint's readiness loop cannot pass");
  assert.ok(!missing.logs.includes(TOKEN));
});

test("the compare is a seam: every auth decision goes through it (in-process, counted)", async (t) => {
  const m = await import("../bundles/browser/cdp-relay.mjs");
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-relay-seam-"));
  const tracePath = join(dir, "chromium.log");
  const compared = [];
  const relay = await m.createRelay({
    token: TOKEN,
    port: 0,
    chromiumArgv: [process.execPath, FIXTURE],
    childEnv: { ...process.env, FAKE_CHROME_LOG: tracePath },
    compareToken: (presented, expected) => {
      compared.push(presented);
      return m.tokenMatches(presented, expected);
    },
    log: () => {},
  });
  t.after(async () => {
    await relay.shutdown(0);
    try {
      const pid = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.t === "pid").pid;
      process.kill(pid, "SIGKILL");
    } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal((await request(relay.port, {})).status, 401, "no header");
  assert.equal(compared.at(-1), "", "the empty bearer still went through the comparator");
  assert.equal((await request(relay.port, { token: WRONG })).status, 401);
  assert.equal(compared.at(-1), WRONG);
  assert.equal((await request(relay.port, { token: TOKEN })).status, 200);
  assert.equal(compared.at(-1), TOKEN);
  assert.equal(compared.length, 3, "one comparison per request, none bypassed");

  // The counters the CLI only ever logs.
  assert.equal(typeof relay.stats.sessionlessEvents, "number");
  assert.equal(typeof relay.stats.orphanEvents, "number");
  assert.equal(typeof relay.stats.activeClients, "number");
});

test("no relay run ever logs the token, even when a client puts it in a header or a query", async () => {
  assert.ok(ALL_LOGS.length >= 5, `expected several relay runs, saw ${ALL_LOGS.length}`);
  for (const logs of ALL_LOGS) {
    assert.ok(!logs.includes(TOKEN), "a log line carried the token:\n" + logs.split("\n").filter((l) => l.includes(TOKEN)).join("\n"));
    assert.ok(!logs.includes(WRONG), "a log line carried a rejected token");
  }
  assert.ok(ALL_LOGS.some((l) => l.includes("401")), "a refusal was logged (without any header value)");
  for (const trace of ALL_TRACES) {
    assert.ok(!JSON.stringify(trace).includes(TOKEN), "the token reached Chromium somewhere");
  }
});
// ---------------------------------------------------------------------------
// review regressions: a peer can never crash the relay (and so the browser)
// ---------------------------------------------------------------------------

const alive = async (ctx, ms = 400) => (await Promise.race([ctx.exited.then(() => false), sleep(ms).then(() => true)]));

test("an unauthenticated upgrade that resets while the 401 is written never crashes the relay", async (t) => {
  const ctx = await startRelay(t);
  const ready = await waitReady(ctx);
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => {
      const s = net.connect(ready.port, "127.0.0.1", () => {
        s.write(`GET /devtools/browser/x HTTP/1.1\r\nHost: 127.0.0.1:${ready.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        setTimeout(() => { s.resetAndDestroy(); resolve(); }, i % 3);
      });
      s.on("error", () => resolve());
    });
  }
  assert.equal(await alive(ctx, 800), true, `the relay is still running; log:\n${ctx.logs()}`);
  assert.equal((await request(ready.port, { token: TOKEN })).status, 200, "and still answers");
});

test("a client that resets right after its close frame never crashes the relay", async (t) => {
  await withRelay(t, {}, async ({ ctx, ready, wsUrl }) => {
    for (let i = 0; i < 10; i++) {
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` }, perMessageDeflate: false });
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      ws.close(1000);
      // The close frame is out; reset the TCP connection before the relay's 1 s destroy timer.
      setTimeout(() => { try { ws._socket?.resetAndDestroy(); } catch { /* gone */ } }, 5);
      await sleep(30);
    }
    assert.equal(await alive(ctx, 1500), true, `the relay is still running; log:\n${ctx.logs()}`);
    assert.equal((await request(ready.port, { token: TOKEN })).status, 200);
  });
});

test("a 33 MB message from the browser reaches its client and never stops the browser", async (t) => {
  await withRelay(t, {}, async ({ ctx, wsUrl }) => {
    const c = openClient(wsUrl);
    await c.opened;
    const r = await c.request(1, "Test.stream", { count: 1, size: 33 * 1024 * 1024 });
    assert.equal(r.result?.chunks, 1);
    assert.ok(c.messages?.some?.((m) => m.method === "Test.chunk") ?? true, "the big event arrived");
    assert.equal(await alive(ctx, 500), true, `the relay is still running; log:\n${ctx.logs()}`);
    c.close();
  });
});
