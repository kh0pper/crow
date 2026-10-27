/**
 * One preview render (P0′ Task 0′.3), against a fake CDP and a fake fetcher: the steps
 * in order, the allowlist (only this token's path), the fulfill (the origin's status and
 * headers minus hop-by-hop), the main-document rules, the navigation record (R4-C1), the
 * timeout, the cleanup, and isNearBlank.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { renderInContext, isAllowed, fulfillHeaders, isNearBlank, MAIN_DOCUMENT_TYPES, HOP_BY_HOP, _pendingSetUpsForTest } from "../servers/gateway/preview/render.js";

const BASE = "http://artifacts.example.test:3060";
const T = "A".repeat(43);
const T2 = "B".repeat(43);
const URL0 = `${BASE}/v/${T}/`;
const PNG = Buffer.from("fake-png");
const tick = () => new Promise((r) => setImmediate(r));
const HTML = [["content-type", "text/html; charset=utf-8"], ["content-security-policy", "default-src 'none'; sandbox"]];

/**
 * A fake browser. `onNavigate(b)` drives what the page does after Page.navigate; the
 * default pauses the main document, and on a fulfill commits it and fires the load.
 */
function fakeCdp({ onNavigate } = {}) {
  const calls = [];
  const listeners = new Map();
  const replies = new Map();   // requestId -> resolve
  let rid = 0;
  const b = {
    calls,
    emit(event, params, sessionId) {
      for (const fn of [...(listeners.get(event) || [])]) fn(params, { method: event, params, sessionId });
    },
    /** Pause a request; resolves with the render's reply { method, params }. */
    pause(url, { resourceType = "Document", frameId = "PAGE", sid = "S-PAGE", browser = false, method = "GET" } = {}) {
      const requestId = `r${++rid}`;
      const p = new Promise((r) => replies.set(requestId, r));
      b.emit("Fetch.requestPaused", { requestId, request: { url, method }, resourceType, frameId }, browser ? undefined : sid);
      return p;
    },
    commit(url, { parentId, sid = "S-PAGE" } = {}) { b.emit("Page.frameNavigated", { frame: { id: parentId ? "SUB" : "PAGE", parentId, url } }, sid); },
    load(sid = "S-PAGE") { b.emit("Page.loadEventFired", { timestamp: 1 }, sid); },
    async mainDoc(url = URL0) {
      const r = await b.pause(url);
      if (r.method === "Fetch.fulfillRequest") return true;
      return false;
    },
    idx(method, sid) { return calls.findIndex((c) => c.method === method && (sid === undefined || c.sid === sid)); },
    has(method) { return calls.some((c) => c.method === method); },
  };
  b.cdp = {
    async send(method, params = {}, sid) {
      calls.push({ method, params, sid });
      await tick();
      if (method === "Fetch.fulfillRequest" || method === "Fetch.failRequest") { replies.get(params.requestId)?.({ method, params }); return {}; }
      if (method === "Target.createBrowserContext") return { browserContextId: "CTX" };
      if (method === "Target.createTarget") {
        setImmediate(() => b.emit("Target.attachedToTarget", { sessionId: "S-PAGE", targetInfo: { targetId: "PAGE", type: "page", browserContextId: params.browserContextId }, waitingForDebugger: true }));
        return { targetId: "PAGE" };
      }
      if (method === "Page.navigate") {
        const nav = onNavigate || (async (x) => { if (await x.mainDoc(params.url)) { x.commit(params.url); x.load(); return {}; } return { errorText: "net::ERR_BLOCKED_BY_CLIENT" }; });
        return (await nav(b, params)) || {};
      }
      if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
      return {};
    },
    on(e, fn) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e).add(fn); },
    off(e, fn) { listeners.get(e)?.delete(fn); },
  };
  return b;
}

/** A fake fetcher: `answer(path)` gives the get result; records paths and the signal. */
function fakeFetcher(answer) {
  const f = { paths: [], signal: null };
  f.session = ({ signal }) => {
    f.signal = signal;
    return { get: async (p) => { f.paths.push(p); return answer(p); }, stats: () => ({}) };
  };
  return f;
}
const okDoc = (body = "<p>x</p>", headers = HTML, status = 200) => ({ ok: true, status, headers, body: Buffer.from(body) });
const serve = (map) => fakeFetcher((p) => (map[p] ? map[p]() : okDoc("nf", HTML, 404)));
const render = (b, fetcher, extra = {}) => renderInContext(b.cdp, { url: URL0, allowPrefix: URL0, mainType: "text/html", fetcher, timeoutMs: 2000, ...extra });
const MAIN = `/v/${T}/`;

test("the reviewed tables", () => {
  assert.deepEqual({ ...MAIN_DOCUMENT_TYPES }, { page: "text/html", document: "text/html", diagram: "application/xhtml+xml" });
  assert.ok(Object.isFrozen(MAIN_DOCUMENT_TYPES));
  assert.deepEqual(HOP_BY_HOP, ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding"]);
});

test("every target is in the new context", async () => {
  const b = fakeCdp();
  const png = await render(b, serve({ [MAIN]: () => okDoc() }));
  assert.deepEqual(png, PNG);
  const ctx = b.calls.find((c) => c.method === "Target.createBrowserContext");
  assert.deepEqual(ctx.params, { disposeOnDetach: true, proxyServer: "direct://" });
  const targets = b.calls.filter((c) => c.method === "Target.createTarget");
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].params, { url: "about:blank", browserContextId: "CTX" });
});

test("downloads are denied before navigation", async () => {
  const b = fakeCdp();
  await render(b, serve({ [MAIN]: () => okDoc() }));
  const d = b.calls.find((c) => c.method === "Browser.setDownloadBehavior");
  assert.deepEqual(d.params, { behavior: "deny", browserContextId: "CTX", eventsEnabled: true });
  assert.ok(b.idx("Browser.setDownloadBehavior") < b.idx("Page.navigate"));
});

test("the browser-level session also intercepts", async () => {
  let reply;
  const b = fakeCdp({
    async onNavigate(x, params) {
      reply = await x.pause("https://outside.example/x.png", { resourceType: "Image", frameId: "OTHER", browser: true });
      await x.mainDoc(params.url); x.commit(params.url); x.load();
    },
  });
  await render(b, serve({ [MAIN]: () => okDoc() }));
  const browserFetch = b.calls.find((c) => c.method === "Fetch.enable" && c.sid === undefined);
  assert.deepEqual(browserFetch.params, { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  assert.ok(b.idx("Fetch.enable", undefined) < b.idx("Target.createTarget"));
  assert.equal(reply.method, "Fetch.failRequest");
  assert.equal(reply.params.errorReason, "BlockedByClient");
  assert.equal(b.calls.find((c) => c.method === "Fetch.failRequest").sid, undefined, "answered on the browser session");
});

test("auto-attach is recursive", async () => {
  const b = fakeCdp({
    async onNavigate(x, params) {
      x.emit("Target.attachedToTarget", { sessionId: "S-CHILD", targetInfo: { targetId: "CHILD", type: "iframe", browserContextId: "CTX" }, waitingForDebugger: true }, "S-PAGE");
      await x.mainDoc(params.url);
      await tick(); await tick(); await tick(); await tick();
      x.commit(params.url); x.load();
    },
  });
  await render(b, serve({ [MAIN]: () => okDoc() }));
  const browserAuto = b.calls.find((c) => c.method === "Target.setAutoAttach" && c.sid === undefined);
  assert.deepEqual(browserAuto.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  for (const sid of ["S-PAGE", "S-CHILD"]) {
    const order = ["Target.setAutoAttach", "Emulation.setScriptExecutionDisabled", "Fetch.enable", "Runtime.runIfWaitingForDebugger"].map((m) => b.idx(m, sid));
    assert.ok(order.every((i) => i >= 0), `${sid}: ${order}`);
    assert.deepEqual([...order].sort((p, q) => p - q), order, `${sid} in order: ${order}`);
    assert.deepEqual(b.calls[order[0]].params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    assert.deepEqual(b.calls[order[1]].params, { value: true });
  }
  assert.ok(b.idx("Page.enable", "S-PAGE") >= 0 && b.idx("Page.enable", "S-PAGE") < b.idx("Runtime.runIfWaitingForDebugger", "S-PAGE"));
  assert.equal(b.idx("Page.enable", "S-CHILD"), -1);
});

test("only this token's path is allowed", () => {
  const { host, protocol } = new URL(BASE);
  assert.equal(isAllowed(`${BASE}/v/${T}/a.css`, URL0), true);
  assert.equal(isAllowed(URL0, URL0), true);
  assert.equal(isAllowed(`${BASE}/v/${T2}/a.css`, URL0), false);
  assert.equal(isAllowed(`${BASE}/`, URL0), false);
  assert.equal(isAllowed(`${BASE}/v/${T}`, URL0), false);
  assert.equal(isAllowed(`https://other.example/v/${T}/a.css`, URL0), false);
  assert.equal(isAllowed(`${protocol}//u:p@${host}/v/${T}/a.css`, URL0), false);
  assert.equal(isAllowed(`${BASE}/v/${T}/../${T2}/a.css`, URL0), false, "dot segments are resolved first");
  assert.equal(isAllowed("not a url", URL0), false);
  assert.equal(isAllowed(`${BASE}/v/${T}/a.css`, `${BASE}/v/${T}`), false, "a prefix without its slash allows nothing");
});

test("only the path and query reach the fetcher", async () => {
  let reply;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      reply = await x.pause(`${BASE}/v/${T}/a.css?x=1`, { resourceType: "Stylesheet" });
      x.load();
    },
  });
  const f = serve({ [MAIN]: () => okDoc(), [`/v/${T}/a.css?x=1`]: () => okDoc("body{}", [["content-type", "text/css"]]) });
  await render(b, f);
  assert.deepEqual(f.paths, [MAIN, `/v/${T}/a.css?x=1`]);
  assert.equal(reply.method, "Fetch.fulfillRequest");
  assert.equal(Buffer.from(reply.params.body, "base64").toString(), "body{}");
});

test("fulfilled headers are the origin's, minus hop-by-hop", async () => {
  const csp = "default-src 'none'; img-src http://artifacts.example.test:3060/v/AAA/; sandbox";
  const origin = [["content-type", "image/png"], ["content-security-policy", csp], ["access-control-allow-origin", "*"], ["connection", "close"], ["transfer-encoding", "chunked"], ["content-length", "9"]];
  let reply;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      reply = await x.pause(`${BASE}/v/${T}/i.png`, { resourceType: "Image" });
      x.load();
    },
  });
  await render(b, serve({ [MAIN]: () => okDoc(), [`/v/${T}/i.png`]: () => okDoc("123456789", origin, 203) }));
  assert.equal(reply.method, "Fetch.fulfillRequest");
  assert.equal(reply.params.responseCode, 203);
  const hs = reply.params.responseHeaders;
  assert.deepEqual(hs.find((h) => h.name === "content-security-policy"), { name: "content-security-policy", value: csp });
  assert.deepEqual(hs.find((h) => h.name === "access-control-allow-origin"), { name: "access-control-allow-origin", value: "*" });
  for (const n of ["connection", "transfer-encoding", "content-length"]) assert.equal(hs.some((h) => h.name === n), false, n);
  // The helper: object form too, with repeated values kept as separate headers.
  assert.deepEqual(fulfillHeaders({ "x-a": ["1", "2"], "Content-Encoding": "gzip", "x-b": "3" }), [{ name: "x-a", value: "1" }, { name: "x-a", value: "2" }, { name: "x-b", value: "3" }]);
});

test("a 3xx sub-resource is failed; a 3xx main document is preview_bad_status", async () => {
  let reply;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      reply = await x.pause(`${BASE}/v/${T}/r.png`, { resourceType: "Image" });
      x.load();
    },
  });
  const png = await render(b, serve({ [MAIN]: () => okDoc(), [`/v/${T}/r.png`]: () => ({ ok: false, reason: "redirect" }) }));
  assert.deepEqual(png, PNG);
  assert.equal(reply.method, "Fetch.failRequest");

  const b2 = fakeCdp();
  await assert.rejects(render(b2, serve({ [MAIN]: () => ({ ok: false, reason: "redirect" }) })), { code: "preview_bad_status" });
  assert.equal(b2.has("Page.captureScreenshot"), false);
});

test("a 404 main document throws preview_bad_status", async () => {
  const b = fakeCdp();
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc("nf", HTML, 404) })), { code: "preview_bad_status" });
  assert.equal(b.has("Page.captureScreenshot"), false);
});

test("a 500 or an HTML error page for the main document saves nothing", async () => {
  for (const status of [500, 502]) {
    const b = fakeCdp();
    await assert.rejects(render(b, serve({ [MAIN]: () => okDoc("<h1>error</h1>", HTML, status) })), { code: "preview_bad_status" });
    assert.equal(b.has("Page.captureScreenshot"), false);
    assert.equal(b.has("Fetch.fulfillRequest"), false, "the error page is never shown to the browser");
  }
});

test("the main document's type must match", async () => {
  const xhtml = [["content-type", "application/xhtml+xml"]];
  await assert.rejects(render(fakeCdp(), serve({ [MAIN]: () => okDoc("<x/>", xhtml) })), { code: "preview_bad_status" }, "a page served as XHTML");
  await assert.rejects(render(fakeCdp(), serve({ [MAIN]: () => okDoc() }), { mainType: MAIN_DOCUMENT_TYPES.diagram }), { code: "preview_bad_status" }, "a diagram served as HTML");
  await assert.rejects(render(fakeCdp(), serve({ [MAIN]: () => okDoc("x", []) })), { code: "preview_bad_status" }, "untyped");
  const png = await render(fakeCdp(), serve({ [MAIN]: () => okDoc("<svg/>", [["content-type", "application/xhtml+xml; charset=utf-8"]]) }), { mainType: MAIN_DOCUMENT_TYPES.diagram });
  assert.deepEqual(png, PNG);
  const upper = await render(fakeCdp(), serve({ [MAIN]: () => okDoc("x", [["Content-Type", "TEXT/HTML;charset=utf-8"]]) }));
  assert.deepEqual(upper, PNG, "the media type compares lowercased, before the ;");
});

test("an oversize main document is preview_too_large", async () => {
  for (const reason of ["cap_response", "cap_render"]) {
    const b = fakeCdp();
    await assert.rejects(render(b, serve({ [MAIN]: () => ({ ok: false, reason }) })), { code: "preview_too_large" });
    assert.equal(b.has("Page.captureScreenshot"), false);
  }
});

test("an oversize image is failed and the render finishes", async () => {
  let reply;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      reply = await x.pause(`${BASE}/v/${T}/big.png`, { resourceType: "Image" });
      x.load();
    },
  });
  const png = await render(b, serve({ [MAIN]: () => okDoc(), [`/v/${T}/big.png`]: () => ({ ok: false, reason: "cap_response" }) }));
  assert.deepEqual(png, PNG);
  assert.equal(reply.method, "Fetch.failRequest");
});

test("a second main-frame document is preview_navigated", async () => {
  let second;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      second = await x.pause(`${URL0}again.html`);
      x.load();
    },
  });
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc(), [`/v/${T}/again.html`]: () => okDoc() })), { code: "preview_navigated" });
  assert.equal(second.method, "Fetch.failRequest");
  assert.equal(b.has("Page.captureScreenshot"), false);
});

test("a commit to another URL is preview_navigated", async () => {
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url);
      x.commit("chrome-error://chromewebdata/");
      x.load();
    },
  });
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc() })), { code: "preview_navigated" });
  assert.equal(b.has("Page.captureScreenshot"), false);
});

test("a sub-frame document outside the token path is preview_navigated", async () => {
  let reply;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      reply = await x.pause("http://127.0.0.1:9/frame", { frameId: "SUB" });
      x.load();
    },
  });
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc() })), { code: "preview_navigated" });
  assert.equal(reply.method, "Fetch.failRequest");
  assert.equal(b.has("Page.captureScreenshot"), false);
});

test("a sub-frame that commits Chrome's error page is preview_navigated", async () => {
  // frame-src 'none' stops the frame before any request: no document is paused, and
  // the frame commits chrome-error://chromewebdata/ inside the page.
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      x.commit("chrome-error://chromewebdata/", { parentId: "PAGE" });
      x.load();
    },
  });
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc() })), { code: "preview_navigated" });
  assert.equal(b.has("Page.captureScreenshot"), false);
});

test("a scheduled navigation (a meta refresh) is preview_navigated, whenever it lands", async () => {
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url); x.load();
      x.emit("Page.frameScheduledNavigation", { frameId: "PAGE", delay: 0, reason: "metaTagRefresh", url: "http://127.0.0.1:9222/json/version" }, "S-PAGE");
    },
  });
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc() })), { code: "preview_navigated" });
  const b2 = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url); x.load();
      x.emit("Page.frameRequestedNavigation", { frameId: "PAGE", reason: "metaTagRefresh", url: "file:///etc/hostname" }, "S-PAGE");
    },
  });
  await assert.rejects(render(b2, serve({ [MAIN]: () => okDoc() })), { code: "preview_navigated" });
});

test("the capture waits for loadEventFired", async () => {
  let loadAt = -1;
  const b = fakeCdp({
    async onNavigate(x, params) {
      await x.mainDoc(params.url); x.commit(params.url);
      setTimeout(() => { loadAt = x.calls.length; x.load(); }, 100);
    },
  });
  await render(b, serve({ [MAIN]: () => okDoc() }));
  assert.ok(loadAt >= 0 && b.idx("Page.captureScreenshot") >= loadAt, "no capture before the event");

  const never = fakeCdp({ async onNavigate(x, params) { await x.mainDoc(params.url); x.commit(params.url); } });
  const t0 = Date.now();
  await assert.rejects(render(never, serve({ [MAIN]: () => okDoc() }), { timeoutMs: 300 }), { code: "preview_timeout" });
  const ms = Date.now() - t0;
  assert.ok(ms >= 290 && ms < 1000, `timed out after ${ms} ms`);
  assert.equal(never.has("Page.captureScreenshot"), false);
});

test("the context is disposed after success and after a timeout, and the fetch session is aborted first", async () => {
  for (const kind of ["success", "timeout"]) {
    const b = fakeCdp(kind === "timeout" ? { async onNavigate(x, params) { await x.mainDoc(params.url); x.commit(params.url); } } : {});
    const f = serve({ [MAIN]: () => okDoc() });
    let abortedAtDispose = null;
    const send = b.cdp.send;
    b.cdp.send = (m, p, s) => { if (m === "Target.disposeBrowserContext") abortedAtDispose = f.signal.aborted; return send(m, p, s); };
    const out = render(b, f, { timeoutMs: 300 });
    if (kind === "timeout") await assert.rejects(out, { code: "preview_timeout" }); else await out;
    const d = b.calls.filter((c) => c.method === "Target.disposeBrowserContext");
    assert.equal(d.length, 1, kind);
    assert.deepEqual(d[0].params, { browserContextId: "CTX" });
    assert.equal(abortedAtDispose, true, `${kind}: the fetch session was aborted before the dispose`);
  }
});

test("a timeout while the fetcher hangs still rejects at timeoutMs", async () => {
  const b = fakeCdp();
  const f = fakeFetcher(() => new Promise(() => {}));
  const t0 = Date.now();
  await assert.rejects(render(b, f, { timeoutMs: 300 }), { code: "preview_timeout" });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(b.calls.filter((c) => c.method === "Target.disposeBrowserContext").length, 1);
});

test("a failed createTarget leaves no session set-up waiting", async () => {
  const before = _pendingSetUpsForTest();
  const b = fakeCdp();
  const send = b.cdp.send;
  b.cdp.send = async (method, params = {}, sid) => {
    if (method === "Target.createTarget") {
      b.calls.push({ method, params, sid });
      // The page attaches (paused), then the call fails: its targetId never arrives.
      b.emit("Target.attachedToTarget", { sessionId: "S-PAGE", targetInfo: { targetId: "PAGE", type: "page", browserContextId: params.browserContextId }, waitingForDebugger: true });
      await tick();
      throw new Error("Target.createTarget failed");
    }
    return send(method, params, sid);
  };
  await assert.rejects(render(b, serve({ [MAIN]: () => okDoc() })), /createTarget failed/);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(_pendingSetUpsForTest(), before, "the attached session's set-up settled");
  assert.ok(!b.calls.some((c) => c.method === "Runtime.runIfWaitingForDebugger" && c.sid === "S-PAGE"), "and a page this render never knew is never resumed");
  assert.equal(b.calls.filter((c) => c.method === "Target.disposeBrowserContext").length, 1);
});

function png(draw) {
  const c = createCanvas(640, 400);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 640, 400);
  draw?.(ctx);
  return c.encodeSync("png");
}

test("isNearBlank: uniform white is blank", async () => {
  assert.equal(await isNearBlank(png()), true);
});

test("isNearBlank: white with a 1-pixel border is blank", async () => {
  assert.equal(await isNearBlank(png((ctx) => { ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, 639, 399); })), true);
});

test("isNearBlank: a two-block document capture is not", async () => {
  assert.equal(await isNearBlank(png((ctx) => {
    ctx.fillStyle = "#cc3333"; ctx.fillRect(16, 16, 300, 200);
    ctx.fillStyle = "#3366cc"; ctx.fillRect(330, 220, 280, 150);
  })), false);
});

test("isNearBlank: two lines of 14 px dark text are not blank", async () => {
  // A short page: thin strokes that a sampling downscale can miss. Two full-width lines
  // put the inked cells well past the 2% threshold whatever sans-serif the runner has
  // (one short line sits near it, and its width depends on the installed fonts).
  assert.equal(await isNearBlank(png((ctx) => {
    ctx.fillStyle = "#222"; ctx.font = "14px sans-serif";
    ctx.fillText("Quarterly notes: revenue up four percent, costs flat, two new hires in May", 16, 24);
    ctx.fillText("Next quarter: ship the preview browser, then the board cards and the Make tab", 16, 48);
  })), false);
});

test("isNearBlank: a 1-pixel vertical rule a sampler would skip still counts", async () => {
  // 1-px lines every 10 px, on the columns a 10:1 bilinear sample never reads.
  assert.equal(await isNearBlank(png((ctx) => { ctx.fillStyle = "#000"; for (let x = 11; x < 630; x += 10) ctx.fillRect(x, 8, 1, 384); })), false);
});
