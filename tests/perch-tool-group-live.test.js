// "See what happened", LIVE (R1.2 PR 2, Task 3): a turn's tool chips fold into
// one line in new mode. The real Perch page in the real new shell (renderLayout
// variant "shell", the panel handed a scope exactly as panels/perch-hub.js does
// for req.crowMode "new"), in a private headless Chrome
// (tests/fixtures/headless-chrome.mjs), against a scripted perch-api with a
// stub SSE turn. The fake-DOM half is in tests/perch-hub-client.test.js.
//
// Every wait is a poll on a page condition, never a fixed sleep before an
// assertion. Set PERCH_TOOLGROUP_SHOTS=<dir> to also save screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

// The engine is "ready" (no banner), as in perch-hub-render.test.js.
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-33333333";
const SHOTS = process.env.PERCH_TOOLGROUP_SHOTS || "";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;

/** Open /events responses, so a test can push frames: a stub turn. */
const streams = new Set();
let subs = 0;   /* every /events subscribe, so a test waits for ITS page's stream */
function emit(type, data) {
  for (const res of streams) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  return streams.size;
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    return send(res, 200, {
      birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run" }] }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    streams.add(res); subs++;
    req.on("close", () => streams.delete(res));
    return;
  }
  if (url.endsWith("/transcript")) return send(res, 200, { events: [] });
  // The live tile's frame poll: nothing new yet.
  if (url.includes("/browser/frame")) { res.writeHead(204); return res.end(); }
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/envelope")) {
    return send(res, 200, { model: "crow-local/test", skills: [], savedNarrowing: [],
      tools: [{ id: "read_file", label: "Read files" }, { id: "web_search", label: "Search the web" }], denied: [] });
  }
  if (url.endsWith("/stop")) return send(res, 200, { ok: true });
  if (url.endsWith("/models")) return send(res, 200, { models: [], default: null });
  // The Files section's cwd browser: a root crumb, one subfolder crumb and a
  // row of each kind, so the 44px sweep measures real crumbs, not an empty pane.
  if (url.endsWith("/cwd/list")) {
    return send(res, 200, { root: "/work/notes", rel: "a", dirs: [{ name: "drafts", rel: "a/drafts" }],
      files: [{ name: "plan.md", rel: "a/plan.md", size: 120 }] });
  }
  if (url.includes("/files") || url.includes("/browse")) {
    return send(res, 200, { files: [], dirs: [], path: "/work", parent: null });
  }
  return send(res, 200, {});
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    if (req.url.startsWith("/api/")) return send(res, 200, { items: [] });
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    if (!req.url.startsWith("/dashboard/perch")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title><p>blank</p>");
    }
    // New mode, exactly as the gateway marks it for the panel.
    req.crowMode = { mode: "new" };
    req.crowScope = { all: true };
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en",
      variant: "shell", shell: { scope: { all: true }, projects: [], tab: "chat", getPanel: () => null } });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

after(async () => {
  for (const res of streams) res.end();
  if (server) server.close();
  if (chrome) await chrome.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tab with SID open in the chat view. */
async function tab(width, height) {
  const t = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expression) => {
    const out = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const waitFor = async (expression, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await evalIn(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(100);
    }
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch#${SID}` });
  await waitFor("document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent",
    "the chat to open");
  return {
    cdp, evalIn, waitFor,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    /** A real mouse click at the element's centre (or at x,y), dispatched by the browser. */
    click: async (elId) => {
      const { x, y } = JSON.parse(await evalIn(`(function(){ var b=document.getElementById(${JSON.stringify(elId)}).getBoundingClientRect();
        return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2}); })()`));
      await s_click(cdp, x, y);
    },
    clickAt: (x, y) => s_click(cdp, x, y),
    key: async (key) => {
      const k = key === "Escape" ? { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }
        : { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
    },
    shot: async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      const { data } = await cdp("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, name + ".png"), Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}
async function s_click(cdp, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

/** The page's own stream is open (the stub turn needs its listener), and the
 *  previous test's closed tab has let go of its stream. */
async function subscribed(before) {
  const end = Date.now() + 8000;
  while (subs <= before || streams.size !== 1) {
    if (Date.now() > end) throw new Error("timed out waiting for the page to subscribe");
    await sleep(50);
  }
}

/** Every group's state, in one round trip. */
const GROUPS = `(function(){
  var tr=document.getElementById('perch-transcript');
  return JSON.stringify(Array.prototype.filter.call(tr.children,function(c){ return c.classList.contains('tool-group'); }).map(function(g){
    var ln=g.querySelector('.tool-group-line'), body=g.querySelector('.tool-group-body'), r=ln.getBoundingClientRect();
    var next=g.nextElementSibling;
    return { label: ln.textContent, expanded: ln.getAttribute('aria-expanded'), err: ln.classList.contains('err'),
      color: getComputedStyle(ln).color, lineH: r.height, lineW: r.width,
      bodyShown: getComputedStyle(body).display!=='none'&&body.getClientRects().length>0,
      chips: body.querySelectorAll('.toolwrap').length, turn: g.getAttribute('data-turn'),
      nextIsTile: !!next&&next.classList.contains('ph-btile') };
  }));
})()`;
const ERR = "getComputedStyle(document.getElementById('perch-hub-root')).getPropertyValue('--err').trim()";

test("live: a running group is expanded; it collapses at turn end; a failed group shows its count", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const subs0 = subs;
  const s = await tab(390, 844);
  try {
    await subscribed(subs0);
    emit("state", { state: "working", turnInFlight: true });
    emit("tool", { phase: "start", name: "bash", toolCallId: "g1", argsText: '{"command":"ls"}' });
    await s.waitFor("document.querySelector('#perch-transcript .tool-group')", "a group");
    let g = await s.json(GROUPS);
    assert.equal(g.length, 1);
    assert.equal(g[0].label, "See what happened · running");
    assert.equal(g[0].expanded, "true");
    assert.equal(g[0].bodyShown, true, "a running group is never folded");
    assert.ok(g[0].lineH >= 44, "the line is a 44 px target (" + g[0].lineH + ")");
    await s.shot("390-running");

    emit("tool", { phase: "end", name: "bash", toolCallId: "g1", resultText: "a b", isError: false });
    emit("text", { text: "One more thing", turnId: "tg1" });
    emit("tool", { phase: "start", name: "edit", toolCallId: "g2" });
    emit("tool", { phase: "end", name: "edit", toolCallId: "g2", resultText: "no such file", isError: true });
    await s.waitFor(`JSON.parse(${GROUPS}).length===2&&JSON.parse(${GROUPS})[1].err`, "the second group");
    g = await s.json(GROUPS);
    assert.equal(g[0].expanded, "true", "finished but the turn is still going: still open");
    assert.equal(g[0].label, "See what happened · running", "every chip done, the model still working: running");
    assert.equal(g[1].label, "See what happened · running", "its failure is counted once the turn ends");

    emit("text", { text: "Done", turnId: "tg1" });
    emit("reply", { text: "One more thingDone", turnId: "tg1" });
    emit("state", { state: "awake", turnInFlight: false });
    await s.waitFor(`JSON.parse(${GROUPS}).every(function(x){ return x.expanded==='false'; })`, "the turn end to fold both");
    g = await s.json(GROUPS);
    assert.equal(g[0].label, "See what happened · 1 step");
    assert.equal(g[0].bodyShown, false);
    assert.equal(g[1].label, "See what happened · 1 step, 1 failed");
    assert.equal(g[1].bodyShown, false, "a failed group stays folded");
    assert.equal(g[1].err, true);
    assert.notEqual(g[1].color, g[0].color, "the failure count reads in the error colour");
    const errColor = await s.evalIn(`(function(){ var d=document.createElement('span'); d.style.color=${ERR};
      document.getElementById('perch-hub-root').appendChild(d); var c=getComputedStyle(d).color; d.remove(); return c; })()`);
    assert.equal(g[1].color, errColor);
    assert.equal(g[0].turn, g[1].turn, "both groups belong to the same turn");
    await s.shot("390-folded");

    // A tap opens a folded group.
    await s.evalIn("document.querySelectorAll('#perch-transcript .tool-group-line')[1].id='tg-line-2'");
    await s.click("tg-line-2");
    await s.waitFor(`JSON.parse(${GROUPS})[1].bodyShown`, "a tap to open the failed group");
    const noSideScroll = await s.evalIn("document.documentElement.scrollWidth<=window.innerWidth");
    assert.equal(noSideScroll, true, "no sideways scroll at 390 px");
  } finally { await s.close(); }
});

test("live: browser tile stays visible beside a folded group", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const subs0 = subs;
  const s = await tab(390, 844);
  try {
    await subscribed(subs0);
    emit("state", { state: "working", turnInFlight: true });
    emit("tool", { phase: "start", name: "mcp__browser__crow_browser_navigate", toolCallId: "b1", argsText: "{}" });
    emit("browser", { phase: "live", anchor: "b1", domain: "example.com", gen: 1 });
    await s.waitFor("document.querySelector('#perch-transcript .ph-btile')", "the live tile");
    let g = await s.json(GROUPS);
    assert.equal(g[0].nextIsTile, true, "the tile sits right after the group, not inside it");
    emit("tool", { phase: "end", name: "mcp__browser__crow_browser_navigate", toolCallId: "b1", resultText: "ok", isError: false });
    emit("tool", { phase: "start", name: "mcp__browser__crow_browser_click", toolCallId: "b2", argsText: "{}" });
    emit("tool", { phase: "end", name: "mcp__browser__crow_browser_click", toolCallId: "b2", resultText: "ok", isError: false });
    emit("browser", { phase: "done", anchor: "b1", domain: "example.com", shot: null, note: null });
    emit("reply", { text: "Looked", turnId: "tb1" });
    emit("state", { state: "awake", turnInFlight: false });
    await s.waitFor(`(function(){ var g=JSON.parse(${GROUPS}); return g.length===1&&g[0].expanded==='false'; })()`, "the group to fold");
    g = await s.json(GROUPS);
    assert.equal(g[0].chips, 2, "the second browser chip joined the same group");
    assert.equal(g[0].label, "See what happened · 2 steps");
    assert.equal(g[0].nextIsTile, true);
    const tile = await s.json(`(function(){ var t=document.querySelector('#perch-transcript .ph-btile'), r=t.getBoundingClientRect();
      return JSON.stringify({ shown: getComputedStyle(t).display!=='none'&&r.height>0, inGroup: !!t.closest('.tool-group'),
        phase: t.getAttribute('data-phase') }); })()`);
    assert.deepEqual(tile, { shown: true, inGroup: false, phase: "done" }, "the tile stays visible beside the folded group");
    await s.shot("390-tile-folded");
  } finally { await s.close(); }
});
