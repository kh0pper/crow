/**
 * Live browser tile, Task 5: the gateway's read-only CDP watcher, the frames
 * long-poll route and the final-shot hook.
 *
 * Every CDP leg runs against a FAKE browser socket wrapped by the real
 * createCdpClient (so the allowlist gate is on the path of every call), the
 * real shared lease module on scratch CROW_HOMEs, and an injected clock with
 * injected timers. The real headless-Chrome leg is
 * tests/browser-watcher-live.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "browser-watcher-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home-default");
delete process.env.CROW_DB_PATH;

let W;       // servers/gateway/browser-tile/watcher.js
let A;       // servers/gateway/browser-tile/cdp-allowlist.js
let lease;   // servers/shared/browser-lease.js

before(async () => {
  A = await import("../servers/gateway/browser-tile/cdp-allowlist.js");
  W = await import("../servers/gateway/browser-tile/watcher.js");
  lease = await import("../servers/shared/browser-lease.js");
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + Math.max(0, Number(ms) || 0) }); return id; },
    clearTimer(id) { timers.delete(id); },
    /** Run every timer due by now+ms, in order, flushing async work between them. */
    async advance(ms, step = 50) {
      const target = t + ms;
      while (t < target) {
        const next = Math.min(target, t + step);
        for (;;) {
          let pick = null;
          for (const [id, e] of timers) if (e.at <= next && (pick === null || e.at < pick.entry.at)) pick = { id, entry: e };
          if (!pick) break;
          timers.delete(pick.id);
          t = Math.max(t, pick.entry.at);
          pick.entry.fn();
          await flush();
        }
        t = next;
        await flush();
      }
    },
  };
}

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A minimal JPEG header the size parser understands (SOI, APP0, SOF0 w×h, EOI). */
function fakeJpeg(w, h) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

class FakeSocket extends EventEmitter {
  constructor(browser) { super(); this.browser = browser; this.closed = false; }
  send(str) {
    const m = JSON.parse(str);
    this.browser.sent.push(m);
    queueMicrotask(() => this.browser.handle(this, m));
  }
  close() { if (this.closed) return; this.closed = true; this.emit("close"); }
}

function makeFakeBrowser({ targets = [{ targetId: "T1", type: "page", url: "https://shop.example.test/cart?item=42" }] } = {}) {
  let ack = 0;
  const b = {
    targets, sent: [], sockets: [], connects: [],
    shot: { w: 800, h: 600 }, dpr: 1, autoFrames: false, captureDelayMs: 0,
    methods: () => b.sent.map((m) => m.method),
    calls: (method) => b.sent.filter((m) => m.method === method),
    frame(sock, sessionId, w = 640, h = 400) {
      sock.emit("message", JSON.stringify({ method: "Page.screencastFrame", sessionId,
        params: { data: fakeJpeg(w, h).toString("base64"), metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: ++ack } }));
    },
    handle(sock, m) {
      if (sock.closed) return;
      const reply = (result) => sock.emit("message", JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
      switch (m.method) {
        case "Target.getTargets":
          return reply({ targetInfos: b.targets.map((t) => ({ attached: false, title: "", ...t })) });
        case "Target.attachToTarget":
          return reply({ sessionId: "sess-" + m.params.targetId });
        case "Page.captureScreenshot": {
          let w = b.shot.w, h = b.shot.h;
          if (m.params.clip) {
            w = Math.round(m.params.clip.width * m.params.clip.scale * b.dpr);
            h = Math.round(m.params.clip.height * m.params.clip.scale * b.dpr);
          } else { w = Math.round(w * b.dpr); h = Math.round(h * b.dpr); }
          const data = fakeJpeg(w, h).toString("base64");
          if (b.captureDelayMs) return setTimeout(() => reply({ data }), b.captureDelayMs);
          return reply({ data });
        }
        case "Page.startScreencast":
          reply({});
          if (b.autoFrames) b.frame(sock, m.sessionId);
          return;
        case "Page.screencastFrameAck":
          reply({});
          if (b.autoFrames) b.frame(sock, m.sessionId);
          return;
        default:
          return reply({});
      }
    },
    connect: async (base) => {
      b.connects.push(base);
      const s = new FakeSocket(b);
      b.sockets.push(s);
      return A.createCdpClient(s);
    },
  };
  return b;
}

let homeSeq = 0;
/** A scratch CROW_HOME; `browser` lists the bundle in installed.json, `env` is its bundle .env. */
function makeHome({ browser = true, env = null } = {}) {
  const home = join(dir, "home-" + (++homeSeq));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "installed.json"), JSON.stringify(browser ? [{ id: "browser" }, { id: "other" }] : [{ id: "other" }]));
  if (env != null) {
    mkdirSync(join(home, "bundles", "browser"), { recursive: true });
    writeFileSync(join(home, "bundles", "browser", ".env"), env);
  }
  return home;
}

const SID = "perchlive-aaaa1111";
const OTHER = "perchlive-bbbb2222";
const holder = (sid = SID) => ({ kind: "bot", sessionId: sid, botId: "botty" });

/** The browser MCP server's part: hold the lease for `sid` with `targetId`. */
async function hold(home, clock, { sid = SID, targetId = "T1", callId = "c1" } = {}) {
  const d = join(home, "browser-lease");
  const r = await lease.acquire(d, holder(sid), { now: clock.now() });
  assert.equal(r.ok, true);
  return lease.beginCall(d, holder(sid), { callId, pid: process.pid, targetId, now: clock.now() });
}

function makeWatcher(o = {}) {
  const clock = o.clock || makeClock();
  const browser = o.browser || makeFakeBrowser();
  const home = o.home || makeHome({ env: "CROW_BROWSER_CDP_PORT=9333\n" });
  const leases = [];
  const lines = [];
  const w = W.createWatcher({
    crowHome: home,
    resolveCdpUrl: o.resolveCdpUrl || (async () => "http://127.0.0.1:9333"),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    connect: browser.connect,
    containerized: () => false,
    watchFs: o.watchFs || (() => null),
    onLease: (l, extra) => leases.push({ l, extra }),
    log: (m) => lines.push(m),
  });
  return { w, clock, browser, home, leases, lines };
}

/** One long poll that times out on the fake clock (100 ms). */
async function pollOnce(h, sid, seq, opts = {}) {
  const p = h.w.frameAfter(sid, seq, { timeoutMs: 100, ...opts });
  await h.clock.advance(150, 50);
  return p;
}

// ---------------------------------------------------------------------------
// the allowlist
// ---------------------------------------------------------------------------

test("ALLOWED_CDP is exactly the read-only set", () => {
  assert.deepEqual([...A.ALLOWED_CDP].sort(), [
    "Page.captureScreenshot", "Page.enable", "Page.screencastFrameAck", "Page.startScreencast", "Page.stopScreencast",
    "Target.attachToTarget", "Target.detachFromTarget", "Target.getTargets",
  ]);
  // mutating the exported set does not widen the gate
  const sock = new FakeSocket(makeFakeBrowser());
  const c = A.createCdpClient(sock);
  try { A.ALLOWED_CDP.add("Runtime.evaluate"); } catch { /* frozen is fine too */ }
  assert.throws(() => c.cdpSend("Runtime.evaluate", { expression: "1" }), (e) => e.code === "ECDPREFUSED");
  try { A.ALLOWED_CDP.delete("Runtime.evaluate"); } catch { /* frozen */ }
});

test("the allowlist refuses Input.dispatchMouseEvent, Runtime.evaluate, Page.navigate, Target.createTarget, Target.setAutoAttach", () => {
  const b = makeFakeBrowser();
  const c = A.createCdpClient(new FakeSocket(b));
  for (const m of ["Input.dispatchMouseEvent", "Runtime.evaluate", "Page.navigate", "Target.createTarget", "Target.setAutoAttach",
    "Target.attachToBrowserTarget", "Target.exposeDevToolsProtocol", "Page.reload", "Emulation.setDeviceMetricsOverride",
    "Input.insertText", "Target.getTargetInfo", "Browser.close", "", "page.enable", null, 42]) {
    assert.throws(() => c.cdpSend(m, {}), (e) => e.code === "ECDPREFUSED", "refused: " + m);
  }
  assert.equal(b.sent.length, 0, "nothing reached the socket");
  // an allowed method goes through
  c.cdpSend("Target.getTargets", {});
  assert.deepEqual(b.methods(), ["Target.getTargets"]);
});

test("a CDP error reply rejects with a code, never the browser's message text", async () => {
  const sock = new EventEmitter();
  sock.send = (str) => {
    const m = JSON.parse(str);
    queueMicrotask(() => sock.emit("message", JSON.stringify({ id: m.id, error: { code: -32000, message: "No target with url https://secret.example.test/x" } })));
  };
  sock.close = () => {};
  const c = A.createCdpClient(sock);
  await assert.rejects(c.cdpSend("Target.attachToTarget", { targetId: "X", flatten: true }), (e) => e.code === "ECDPERROR" && !/secret/.test(e.message));
});

// ---------------------------------------------------------------------------
// which browser (enablement / port rule)
// ---------------------------------------------------------------------------

test("no browser bundle on this instance → no watcher", async () => {
  const home = makeHome({ browser: false, env: "CROW_BROWSER_CDP_PORT=9333\n" });
  let inspected = 0;
  assert.equal(await W.resolveCdpUrl({ crowHome: home, inspect: async () => { inspected++; return null; }, containerized: () => false }), null);
  assert.equal(inspected, 0);
  const b = makeFakeBrowser();
  const clock = makeClock();
  const w = W.createWatcher({ crowHome: home, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    connect: b.connect, containerized: () => false, watchFs: () => null, inspect: async () => ({ running: true, downloads: null }) });
  try {
    assert.equal(w.enabled(), false);
    await hold(home, clock);
    await clock.advance(3000);
    assert.equal(await w.frameAfter(SID, 0, { timeoutMs: 10 }), null);
    assert.equal(await w.captureFinal(SID, { gen: 1 }), null);
    assert.equal(b.connects.length, 0, "never connected to any browser");
  } finally { w.close(); }
});

test("a co-hosted instance never falls back to another instance's 9222", async () => {
  const primary = makeHome({ env: "" });                        // primary: no CDP_PORT, default container name
  const second = makeHome({ env: "CROW_BROWSER_CONTAINER_NAME=crow-browser-two\n" });   // second: own container, no CDP_PORT
  const downloadsOf = (h) => join(h, "browser-downloads");
  mkdirSync(downloadsOf(primary), { recursive: true });
  mkdirSync(downloadsOf(second), { recursive: true });
  // Only the primary's container runs (its /downloads is the primary's dir).
  const containers = { "crow-browser": { running: true, downloads: downloadsOf(primary) } };
  const asked = [];
  const inspect = async (name) => { asked.push(name); return containers[name] || null; };
  const opts = { inspect, containerized: () => false };
  assert.equal(await W.resolveCdpUrl({ crowHome: primary, ...opts }), "http://127.0.0.1:9222", "the primary's own running container");
  assert.equal(await W.resolveCdpUrl({ crowHome: second, ...opts }), null, "the second's container is not running");
  assert.deepEqual(asked, ["crow-browser", "crow-browser-two"], "each instance asks only for its own container name");
  // A second instance on the DEFAULT name: the running crow-browser is the primary's (its mount says so).
  const third = makeHome({ env: "" });
  assert.equal(await W.resolveCdpUrl({ crowHome: third, ...opts }), null, "someone else's crow-browser is not ours");
  // the second's own container starts → its 9222 fallback is allowed
  containers["crow-browser-two"] = { running: true, downloads: downloadsOf(second) };
  assert.equal(await W.resolveCdpUrl({ crowHome: second, ...opts }), "http://127.0.0.1:9222");
  // an explicit port always wins, loopback only
  const fourth = makeHome({ env: "CROW_BROWSER_CDP_PORT=9444\n" });
  assert.equal(await W.resolveCdpUrl({ crowHome: fourth, inspect: async () => { throw new Error("not asked"); }, containerized: () => false }), "http://127.0.0.1:9444");
  for (const bad of ["CROW_BROWSER_CDP_PORT=0\n", "CROW_BROWSER_CDP_PORT=70000\n", "CROW_BROWSER_CDP_PORT=92a2\n", "CROW_BROWSER_CDP_PORT=10.0.0.5:9222\n"]) {
    assert.equal(await W.resolveCdpUrl({ crowHome: makeHome({ env: bad }), inspect: async () => containers["crow-browser"], containerized: () => false }), null, bad.trim());
  }
  // a containerized gateway: no watcher at all
  assert.equal(await W.resolveCdpUrl({ crowHome: fourth, inspect, containerized: () => true }), null);
  const clock = makeClock();
  const w = W.createWatcher({ crowHome: fourth, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    containerized: () => true, watchFs: () => null, connect: async () => { throw new Error("never"); } });
  assert.equal(w.enabled(), false);
  w.close();
});

test("the container check is cached and bounded", async () => {
  const home = makeHome({ env: "" });
  mkdirSync(join(home, "browser-downloads"), { recursive: true });
  let calls = 0;
  const cache = W.createInspectCache({ inspect: async () => { calls++; return { running: true, downloads: join(home, "browser-downloads") }; }, now: () => 1000 });
  assert.equal(await W.resolveCdpUrl({ crowHome: home, inspect: cache, containerized: () => false }), "http://127.0.0.1:9222");
  assert.equal(await W.resolveCdpUrl({ crowHome: home, inspect: cache, containerized: () => false }), "http://127.0.0.1:9222");
  assert.equal(calls, 1, "one docker inspect inside the cache window");
  // the default inspect gives up quickly on a missing docker binary
  const t0 = Date.now();
  assert.equal(await W.dockerInspect("crow-browser-none", { bin: "/nonexistent/docker", timeoutMs: 500 }), null);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await W.dockerInspect("bad name;rm", { bin: "/bin/true" }), null, "a bad container name is never passed to docker");
});

test("connectCdp refuses non-loopback endpoints", async () => {
  await assert.rejects(W.connectCdp("http://10.1.2.3:9222"), (e) => e.code === "ECDPHOST");
  await assert.rejects(W.connectCdp("http://example.test:9222"), (e) => e.code === "ECDPHOST");
  // a loopback /json/version that names a non-loopback (or other-port) socket is refused too
  for (const wsUrl of ["ws://10.1.2.3:9222/devtools/browser/x", "ws://127.0.0.1:1/devtools/browser/x", "http://127.0.0.1/devtools/browser/x"]) {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: wsUrl.replace("PORT", String(srv.address().port)) }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      await assert.rejects(W.connectCdp("http://127.0.0.1:" + srv.address().port), (e) => e.code === "ECDPHOST", wsUrl);
    } finally { await new Promise((r) => srv.close(r)); }
  }
  assert.equal(W.isLoopbackHost("127.0.0.1"), true);
  assert.equal(W.isLoopbackHost("[::1]"), true);
  assert.equal(W.isLoopbackHost("localhost"), true);
  assert.equal(W.isLoopbackHost("127.0.0.1.example.test"), false);
  assert.equal(W.isLoopbackHost("0.0.0.0"), false);
});

// ---------------------------------------------------------------------------
// which page, frames and pacing
// ---------------------------------------------------------------------------

test("attaches to the lease's targetId, re-attaches when it changes", async () => {
  const h = makeWatcher();
  h.browser.targets.push({ targetId: "T2", type: "page", url: "about:blank" }, { targetId: "T9", type: "page", url: "https://other.example.test/" });
  try {
    await hold(h.home, h.clock, { targetId: "T1" });
    const p = h.w.frameAfter(SID, 0, { timeoutMs: 2000 });
    await flush();
    const att = h.browser.calls("Target.attachToTarget");
    assert.equal(att.length, 1);
    assert.deepEqual(att[0].params, { targetId: "T1", flatten: true }, "exactly the leased target, flattened");
    assert.equal(h.browser.calls("Page.enable")[0].sessionId, "sess-T1");
    const cast = h.browser.calls("Page.startScreencast")[0];
    assert.equal(cast.sessionId, "sess-T1");
    assert.deepEqual(cast.params, { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 400, everyNthFrame: 1 });
    h.browser.frame(h.browser.sockets[0], "sess-T1", 640, 400);
    const f = await p;
    assert.equal(f.seq, 1);
    assert.equal(f.w, 640);
    assert.equal(f.h, 400);
    assert.equal(Buffer.from(f.jpegB64, "base64").subarray(0, 2).toString("hex"), "ffd8");
    // a frame from a session we are not attached to is ignored
    h.browser.frame(h.browser.sockets[0], "sess-T9");
    assert.equal(await pollOnce(h, SID, 1), null);

    // the bot's MCP process now drives T2: detach T1, attach T2
    await lease.beginCall(join(h.home, "browser-lease"), holder(), { callId: "c2", pid: process.pid, targetId: "T2", now: h.clock.now() });
    const p2 = h.w.frameAfter(SID, 1, { timeoutMs: 2000 });
    await h.clock.advance(1100);
    assert.deepEqual(h.browser.calls("Target.detachFromTarget").map((m) => m.params), [{ sessionId: "sess-T1" }]);
    assert.deepEqual(h.browser.calls("Target.attachToTarget").map((m) => m.params.targetId), ["T1", "T2"]);
    h.browser.frame(h.browser.sockets[0], "sess-T1");   // a straggler from the old page: never delivered
    h.browser.frame(h.browser.sockets[0], "sess-T2", 320, 200);
    const f2 = await p2;
    assert.equal(f2.w, 320);
    assert.ok(!h.browser.calls("Target.attachToTarget").some((m) => m.params.targetId === "T9"), "never any other page");
  } finally { h.w.close(); }
});

test("frames go only to the holding session, and only from its own holding", async () => {
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    assert.equal(await h.w.isHolder(SID), true);
    assert.equal(await h.w.isHolder(OTHER), false);
    assert.equal(await h.w.frameAfter(OTHER, 0, { timeoutMs: 50 }), null, "another session gets nothing");
    const p = h.w.frameAfter(SID, 0, { timeoutMs: 2000 });
    await flush();
    h.browser.frame(h.browser.sockets[0], "sess-T1");
    assert.equal((await p).seq, 1);
    // the lease moves to another bot (expiry + take): its frames never reach SID
    await h.clock.advance(121_000, 1000);
    await hold(h.home, h.clock, { sid: OTHER, targetId: "T1" });
    assert.equal(await h.w.isHolder(SID), false);
    assert.equal(await h.w.frameAfter(SID, 0, { timeoutMs: 50 }), null, "the old frame is not served under a new holding");
  } finally { h.w.close(); }
});

test("acks are delayed so frames are ≤ 2/s (≤ 1/s for a phone viewer)", async () => {
  for (const phone of [false, true]) {
    const h = makeWatcher();
    h.browser.autoFrames = true;     // Chromium sends the next frame as soon as the last is acked
    try {
      await hold(h.home, h.clock);
      let last = 0;
      const poll = () => h.w.frameAfter(SID, last, { timeoutMs: 2000, phone }).then((f) => { if (f) last = f.seq; });
      poll();
      await flush();
      const start = h.clock.now();
      for (let i = 0; i < 10; i++) { poll(); await h.clock.advance(1000, 25); }
      const secs = (h.clock.now() - start) / 1000;
      const frames = h.browser.calls("Page.screencastFrameAck").length;
      const cap = phone ? 1 : 2;
      assert.ok(frames <= cap * secs + 1, `${frames} acks in ${secs}s (phone=${phone})`);
      assert.ok(frames >= cap * secs - 2, `pacing still delivers (${frames})`);
      const cast = h.browser.calls("Page.startScreencast").at(-1);
      assert.equal(cast.params.maxWidth, phone ? 480 : 640);
    } finally { h.w.close(); }
  }
});

test("a desktop viewer joining a phone-only tile restarts the screencast at desktop size", async () => {
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    h.w.frameAfter(SID, 0, { timeoutMs: 100, phone: true });
    await flush();
    assert.equal(h.browser.calls("Page.startScreencast").at(-1).params.maxWidth, 480);
    h.w.frameAfter(SID, 0, { timeoutMs: 100, phone: false });
    await flush();
    assert.equal(h.browser.calls("Page.stopScreencast").length, 1);
    assert.equal(h.browser.calls("Page.startScreencast").at(-1).params.maxWidth, 640);
  } finally { h.w.close(); }
});

test("no poll for 10 s stops the screencast; detach after 30 s idle", async () => {
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    // keep the bot's holding alive (the gateway renews it during a turn)
    const renew = async () => lease.renewIfHeld(join(h.home, "browser-lease"), holder(), { now: h.clock.now() });
    await pollOnce(h, SID, 0);
    assert.equal(h.browser.calls("Page.startScreencast").length, 1);
    await h.clock.advance(9000, 500);
    assert.equal(h.browser.calls("Page.stopScreencast").length, 0, "still polled recently");
    await h.clock.advance(1600, 500);
    assert.equal(h.browser.calls("Page.stopScreencast").length, 1, "10 s without a poll stops it");
    assert.equal(h.browser.calls("Target.detachFromTarget").length, 0);
    await renew();
    await h.clock.advance(20_000, 1000);
    assert.equal(h.browser.calls("Target.detachFromTarget").length, 1, "30 s without a viewer detaches");
    assert.deepEqual(h.browser.calls("Target.detachFromTarget")[0].params, { sessionId: "sess-T1" });
    // a new poll attaches and casts again
    await renew();
    await pollOnce(h, SID, 0);
    assert.equal(h.browser.calls("Target.attachToTarget").length, 2);
    assert.equal(h.browser.calls("Page.startScreencast").length, 2);
  } finally { h.w.close(); }
});

test("a released lease stops the screencast at once", async () => {
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    await pollOnce(h, SID, 0);
    await lease.endCall(join(h.home, "browser-lease"), holder(), { callId: "c1", now: h.clock.now() });
    await lease.release(join(h.home, "browser-lease"), SID, { now: h.clock.now() });
    await h.clock.advance(1100);
    assert.equal(h.browser.calls("Page.stopScreencast").length, 1);
    assert.equal(h.browser.calls("Target.detachFromTarget").length, 1);
  } finally { h.w.close(); }
});

test("a closed request clears the wait (the watcher side)", async () => {
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    const ac = new AbortController();
    const p = h.w.frameAfter(SID, 0, { timeoutMs: 2000, signal: ac.signal });
    await flush();
    assert.equal(h.w._waitersForTest(), 1);
    ac.abort();
    assert.equal(await p, null);
    assert.equal(h.w._waitersForTest(), 0);
    // an already-aborted signal never registers a waiter
    const ac2 = new AbortController(); ac2.abort();
    assert.equal(await h.w.frameAfter(SID, 0, { timeoutMs: 2000, signal: ac2.signal }), null);
    assert.equal(h.w._waitersForTest(), 0);
    // a timeout clears it too
    const p3 = h.w.frameAfter(SID, 0, { timeoutMs: 2000 });
    await h.clock.advance(2100);
    assert.equal(await p3, null);
    assert.equal(h.w._waitersForTest(), 0);
  } finally { h.w.close(); }
});

// ---------------------------------------------------------------------------
// the domain and the lease watch
// ---------------------------------------------------------------------------

test("the domain comes from CDP (main-frame URL hostname; neutral null for about:/chrome:/file:/data:)", async () => {
  assert.equal(W.hostnameOf("https://Shop.Example.test:8443/cart?item=1#x"), "shop.example.test");
  assert.equal(W.hostnameOf("http://127.0.0.1:3000/"), "127.0.0.1");
  for (const u of ["about:blank", "chrome://settings", "file:///etc/passwd", "data:text/html,hi", "blob:https://x.test/1", "javascript:1", "", null, "not a url"]) {
    assert.equal(W.hostnameOf(u), null, String(u));
  }
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    await h.clock.advance(1100);
    const last = h.leases.at(-1);
    assert.equal(last.l.holder.sessionId, SID);
    assert.equal(last.extra.domain, "shop.example.test");
    assert.equal(h.w.hostname(), "shop.example.test");
    h.browser.targets[0].url = "about:blank";
    await h.clock.advance(1100);
    assert.equal(h.leases.at(-1).extra.domain, null);
    assert.equal(h.w.hostname(), null);
    assert.equal(h.lines.join("\n").includes("example.test"), false, "no hostname in the log");
  } finally { h.w.close(); }
});

test("the lease watch: fs.watch is debounced 250 ms, the 1 s poll is the truth", async () => {
  let fire = null;
  const h = makeWatcher({ watchFs: (_d, cb) => { fire = cb; return { close() {} }; } });
  try {
    await h.clock.advance(1100);
    const before = h.leases.length;
    assert.equal(before, 0, "a free lease reports nothing");
    await hold(h.home, h.clock, { targetId: null });
    assert.ok(fire, "the watcher watches the lease dir");
    for (let i = 0; i < 5; i++) fire("rename", "browser-lease.json");
    await h.clock.advance(200, 10);
    assert.equal(h.leases.length, 0, "debounced");
    await h.clock.advance(100, 10);
    assert.equal(h.leases.length, 1, "one report for a burst of events");
    assert.equal(h.leases[0].extra.domain, undefined, "no targetId yet → no domain claim");
    // with no fs events the poll still reports once a second while a bot holds it
    await h.clock.advance(3000, 100);
    assert.ok(h.leases.length >= 3);
  } finally { h.w.close(); }
});

test("reconnects with backoff after the browser goes away", async () => {
  const h = makeWatcher();
  try {
    await hold(h.home, h.clock);
    await h.clock.advance(1100);
    assert.equal(h.browser.connects.length, 1);
    h.browser.sockets[0].close();          // container restart
    await h.clock.advance(500, 100);
    assert.equal(h.browser.connects.length, 1, "not hammering");
    await h.clock.advance(3000, 100);
    assert.equal(h.browser.connects.length, 2, "reconnected");
    // a refused connect backs off further
    let fails = 0;
    const real = h.browser.connect;
    h.browser.sockets[1].close();
    h.w._setConnectForTest(async () => { fails++; throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); });
    await h.clock.advance(10_000, 200);
    assert.ok(fails >= 2 && fails <= 4, "backoff (" + fails + " tries in 10 s)");
    h.w._setConnectForTest(real);
    await h.clock.advance(40_000, 500);
    assert.ok(h.browser.connects.length >= 3, "back after the browser returns");
    assert.ok(!h.lines.some((l) => /127\.0\.0\.1|ws:\/\//.test(l)), "no endpoint in the log");
  } finally { h.w.close(); }
});

// ---------------------------------------------------------------------------
// the final capture
// ---------------------------------------------------------------------------

test("captureFinal: only for this session's holding at the turn's gen; ≤ 1280 px wide", async () => {
  const h = makeWatcher();
  try {
    const l = await hold(h.home, h.clock);
    const buf = await h.w.captureFinal(SID, { gen: l.gen });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(W.jpegSize(buf), { w: 800, h: 600 });
    assert.deepEqual(h.browser.calls("Page.captureScreenshot")[0].params, { format: "jpeg", quality: 70 });
    assert.equal(h.browser.calls("Page.captureScreenshot")[0].sessionId, "sess-T1");
    // wide page: scaled down to 1280
    h.browser.shot = { w: 1920, h: 1080 };
    let b2 = await h.w.captureFinal(SID, { gen: l.gen });
    assert.equal(W.jpegSize(b2).w, 1280);
    const clip = h.browser.calls("Page.captureScreenshot").at(-1).params.clip;
    assert.deepEqual({ x: clip.x, y: clip.y, width: clip.width, height: clip.height }, { x: 0, y: 0, width: 1920, height: 1080 });
    // a HiDPI page: still ≤ 1280
    h.browser.shot = { w: 1000, h: 700 }; h.browser.dpr = 2;
    b2 = await h.w.captureFinal(SID, { gen: l.gen });
    assert.ok(W.jpegSize(b2).w <= 1280, "hidpi " + W.jpegSize(b2).w);
    h.browser.dpr = 1; h.browser.shot = { w: 800, h: 600 };
    // refusals
    assert.equal(await h.w.captureFinal(OTHER, { gen: l.gen }), null, "not the holder");
    assert.equal(await h.w.captureFinal(SID, { gen: l.gen + 1 }), null, "gen moved");
    const ac = new AbortController(); ac.abort();
    assert.equal(await h.w.captureFinal(SID, { gen: l.gen, signal: ac.signal }), null, "aborted");
    // holder changes while the capture runs → nothing returned
    h.browser.captureDelayMs = 30;
    const p = h.w.captureFinal(SID, { gen: l.gen });
    await lease.takeOperator(join(h.home, "browser-lease"), { now: h.clock.now() });
    assert.equal(await p, null, "the operator took it mid-capture");
  } finally { h.w.close(); }
});

// ---------------------------------------------------------------------------
// the final-shot hook (B4 + Task 3 carries)
// ---------------------------------------------------------------------------

function hookHarness(o = {}) {
  const home = makeHome({ env: "CROW_BROWSER_CDP_PORT=9333\n" });
  const clock = makeClock();
  const stored = [];
  const captures = [];
  const watcher = {
    hostname: () => "shop.example.test",
    captureFinal: async (sid, opts) => {
      captures.push({ sid, opts });
      if (o.capture) return o.capture(sid, opts);
      return fakeJpeg(800, 600);
    },
  };
  let operatorHeld = false;
  const hook = W.createFinalShotHook({
    watcher,
    leaseDir: join(home, "browser-lease"),
    now: clock.now,
    operatorHeld: () => operatorHeld,
    storeShot: async (db, s, args) => { stored.push({ s, args }); return { id: 41, name: "browser-shop.example.test-20261028-120000.jpg" }; },
    createDb: () => ({ close() {} }),
  });
  return { home, clock, hook, stored, captures, setOperator: (v) => { operatorHeld = v; } };
}

const ctxFor = (l, over = {}) => ({
  sessionId: SID, botId: "botty", threadId: SID, outputsDir: null, anchor: "c1",
  gen: l.gen, genAtEnd: l.gen, heldAtEnd: true, operatorTook: false, signal: new AbortController().signal, ...over,
});

test("final shot only when the holder is still this session at turn end (gen unchanged)", async () => {
  const h = hookHarness();
  const l = await hold(h.home, h.clock);
  const shot = await h.hook(ctxFor(l));
  assert.deepEqual(shot, { id: 41, url: "/dashboard/perch-api/interactive/" + SID + "/workspace/browser-shop.example.test-20261028-120000.jpg" });
  assert.equal(h.stored.length, 1);
  assert.equal(h.stored[0].s.sessionId, SID);
  assert.equal(h.stored[0].s.botId, "botty");
  assert.equal(h.stored[0].args.hostname, "shop.example.test");
  assert.equal(h.stored[0].args.anchor, "c1");
  assert.equal(h.captures[0].opts.gen, l.gen);

  // refusals, each before any capture
  const n = h.captures.length;
  assert.equal(await h.hook(ctxFor(l, { heldAtEnd: false })), null, "not held at turn end");
  assert.equal(await h.hook(ctxFor(l, { gen: l.gen - 1 })), null, "someone held it between the session's own step and the end");
  assert.equal(await h.hook(ctxFor(l, { genAtEnd: null })), null);
  assert.equal(h.captures.length, n, "no capture for a refused shot");

  // the file says gen moved under the lock
  await h.clock.advance(121_000, 5000);
  const l2 = await hold(h.home, h.clock, { sid: OTHER });
  assert.equal(await h.hook(ctxFor(l)), null, "another bot holds it now");
  assert.equal(await h.hook(ctxFor(l2)), null, "a forged ctx gen cannot borrow another session's holding");
  assert.equal(h.stored.length, 1);
});

test("operator held → no shot", async () => {
  const h = hookHarness();
  const l = await hold(h.home, h.clock);
  assert.equal(await h.hook(ctxFor(l, { operatorTook: true })), null, "a take-over during the turn");
  h.setOperator(true);
  assert.equal(await h.hook(ctxFor(l)), null, "the operator holds it in the gateway's memory");
  h.setOperator(false);
  // the operator takes it while the capture runs
  const h2 = hookHarness({ capture: async () => { h2.setOperator(true); return fakeJpeg(800, 600); } });
  const l3 = await hold(h2.home, h2.clock);
  assert.equal(await h2.hook(ctxFor(l3)), null);
  assert.equal(h.captures.length, 0);
  assert.equal(h.stored.length + h2.stored.length, 0);
});

test("a late-resolving capture stores nothing", async () => {
  let release;
  const h = hookHarness({ capture: () => new Promise((r) => { release = r; }) });
  const l = await hold(h.home, h.clock);
  const ac = new AbortController();
  const p = h.hook(ctxFor(l, { signal: ac.signal }));
  await flush();
  ac.abort();                       // the engine's 5 s deadline
  release(fakeJpeg(800, 600));      // the capture resolves afterwards
  assert.equal(await p, null);
  assert.equal(h.stored.length, 0, "nothing stored after the deadline");
  // an already-aborted signal: no capture at all
  const ac2 = new AbortController(); ac2.abort();
  const n = h.captures.length;
  assert.equal(await h.hook(ctxFor(l, { signal: ac2.signal })), null);
  assert.equal(h.captures.length, n);
});

test("a failed store or capture is no shot, never a throw", async () => {
  const h = hookHarness({ capture: async () => null });
  const l = await hold(h.home, h.clock);
  assert.equal(await h.hook(ctxFor(l)), null);
  const h2 = hookHarness({ capture: async () => { throw new Error("cdp gone https://x.example.test"); } });
  const l2 = await hold(h2.home, h2.clock);
  assert.equal(await h2.hook(ctxFor(l2)), null);
  const h3 = hookHarness();
  const l3 = await hold(h3.home, h3.clock);
  const hook3 = W.createFinalShotHook({
    watcher: { hostname: () => null, captureFinal: async () => fakeJpeg(800, 600) },
    leaseDir: join(h3.home, "browser-lease"), now: h3.clock.now, operatorHeld: () => false,
    storeShot: async () => { throw new Error("disk full"); }, createDb: () => ({ close() {} }),
  });
  assert.equal(await hook3(ctxFor(l3)), null);
});

// ---------------------------------------------------------------------------
// the frames route
// ---------------------------------------------------------------------------

async function routeHarness() {
  const { default: express } = await import("express");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const state = { holder: SID, frame: null, signals: [], calls: [], enabled: true };
  const watcher = {
    enabled: () => state.enabled,
    isHolder: async (sid) => sid === state.holder,
    frameAfter: (sid, seq, opts) => {
      state.calls.push({ sid, seq, opts });
      state.signals.push(opts.signal);
      if (state.frame) return Promise.resolve(state.frame);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), opts.timeoutMs);
        opts.signal.addEventListener("abort", () => { clearTimeout(t); resolve(null); }, { once: true });
      });
    },
  };
  const engine = {
    get: async (sid) => (sid === SID || sid === OTHER ? { sessionId: sid, botId: "botty" } : null),
    browserWatcher: watcher,
  };
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.status(401).json({ error: "unauthorized" }));
  const app = express();
  app.use(perchInteractiveApiRouter(auth, { engine }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api";
  const get = (path, { cookie = "crow_session=good", signal } = {}) => fetch(base + path, { headers: { cookie }, signal });
  return { state, get, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test("frame route: owner gate via dashboardAuth; only the holding session gets frames; another session → 409 not_holder", async () => {
  const r = await routeHarness();
  try {
    const noAuth = await r.get("/interactive/" + SID + "/browser/frame?after=0", { cookie: "" });
    assert.equal(noAuth.status, 401);
    assert.equal(r.state.calls.length, 0);
    const other = await r.get("/interactive/" + OTHER + "/browser/frame?after=0");
    assert.equal(other.status, 409);
    assert.deepEqual(await other.json(), { error: "not_holder" });
    assert.equal(r.state.calls.length, 0, "a non-holder never reaches the watcher");
    const none = await r.get("/interactive/nosuch/browser/frame?after=0");
    assert.equal(none.status, 404);
    r.state.frame = { seq: 7, jpegB64: fakeJpeg(640, 400).toString("base64"), w: 640, h: 400 };
    const ok = await r.get("/interactive/" + SID + "/browser/frame?after=3&vw=390");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.deepEqual(Object.keys(body).sort(), ["h", "jpeg", "seq", "w"]);
    assert.equal(body.seq, 7);
    assert.equal(body.jpeg, r.state.frame.jpegB64);
    const call = r.state.calls.at(-1);
    assert.equal(call.seq, 3);
    assert.equal(call.opts.timeoutMs, 2000);
    assert.equal(call.opts.phone, true, "vw=390 marks a phone viewer");
    await r.get("/interactive/" + SID + "/browser/frame?after=bogus&vw=1440");
    assert.equal(r.state.calls.at(-1).seq, 0);
    assert.equal(r.state.calls.at(-1).opts.phone, false);
    r.state.enabled = false;
    assert.equal((await r.get("/interactive/" + SID + "/browser/frame?after=0")).status, 404);
  } finally { await r.close(); }
});

test("frame route: a long poll with no new frame answers 204 after 2 s", async () => {
  const r = await routeHarness();
  try {
    const t0 = Date.now();
    const res = await r.get("/interactive/" + SID + "/browser/frame?after=0");
    assert.equal(res.status, 204);
    assert.ok(Date.now() - t0 >= 1900, "waited the long poll");
  } finally { await r.close(); }
});

test("frame route: a closed request clears the wait", async () => {
  const r = await routeHarness();
  try {
    const ac = new AbortController();
    const p = r.get("/interactive/" + SID + "/browser/frame?after=0", { signal: ac.signal }).catch(() => "aborted");
    for (let i = 0; i < 50 && r.state.signals.length === 0; i++) await new Promise((x) => setTimeout(x, 10));
    assert.equal(r.state.signals.length, 1);
    assert.equal(r.state.signals[0].aborted, false);
    ac.abort();
    assert.equal(await p, "aborted");
    for (let i = 0; i < 50 && !r.state.signals[0].aborted; i++) await new Promise((x) => setTimeout(x, 10));
    assert.equal(r.state.signals[0].aborted, true, "the server-side wait was aborted with the request");
  } finally { await r.close(); }
});
