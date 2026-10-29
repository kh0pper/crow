// The embedded app tile, LIVE (R1.2 PR 5, Task 3): the real Perch page in new
// mode with a session filed to a project, in a private headless Chrome
// (tests/fixtures/headless-chrome.mjs). Opening a desktop app from the launcher
// (the session's apps sheet, or the drawer) shows a watch-only tile in the
// session instead of navigating. The app tile API and the app's noVNC page are
// scripted. The static half is tests/app-tile.test.js. Skips cleanly without Chrome.
//
// Every wait is a poll on a page condition, never a fixed sleep before an assertion.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-33333333";
const PROJECT = { id: 1, slug: "garden", name: "Garden" };

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
let filed = true;
const apiCalls = [];
const streams = new Set();

let clientApp, clientTile;
// Raw catalog-shaped apps; launcher.js clientApp turns them into what the API sends.
const RAW = {
  browser: { id: "browser", label: "Browser", icon: "monitor", kind: "desktop", href: "/proxy/browser/vnc.html" },
  studio: { id: "studio", label: "Studio", icon: "monitor", kind: "desktop", href: "/proxy/studio/" },
  wiki: { id: "wiki", label: "Wiki", icon: "book", kind: "page", href: "/proxy/wiki/" },
  ntfy: { id: "ntfy", label: "Notifications", icon: null, kind: "page", href: null, directPort: 2586, path: "/", fallbackHref: "/dashboard/extensions" },
};
const projectApps = () => [clientApp(RAW.studio), clientApp(RAW.wiki)];
const allApps = () => [clientApp(RAW.studio), clientApp(RAW.wiki), clientApp(RAW.ntfy)];
let offered = true;
const tileCalls = [];
const extra = () => [clientTile({ id: "stub-add", label: "Add something", icon: "plus", href: "/dashboard/project/garden/add" })];

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function servePerchApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return send(res, 200, {
      birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run",
          projectId: filed ? PROJECT.id : null, lastActivityAt: now }] }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (url.endsWith("/transcript")) return send(res, 200, { events: [] });
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/commands")) return send(res, 200, { commands: [] });
  if (url.endsWith("/models")) return send(res, 200, { models: [], default: null });
  const m = /\/apps\/([a-z0-9-]+)\/tile$/.exec(url);
  if (m) {
    tileCalls.push(m[1]);
    if (m[1] !== "studio") return send(res, 404, { error: "not_desktop" });
    return send(res, 200, { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale", takeOver: offered });
  }
  return send(res, 200, {});
}
function serveAppsApi(req, res) {
  const project = new URL(req.url, "http://x").searchParams.get("project");
  apiCalls.push(project);
  if (project === "all") return send(res, 200, { scope: "all", projectSlug: null, apps: allApps(), tiles: [] });
  if (project === PROJECT.slug) return send(res, 200, { scope: "project", projectSlug: PROJECT.slug, apps: projectApps(), tiles: extra() });
  return send(res, 404, { error: "not_found" });
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  ({ clientApp, clientTile } = await import("../servers/gateway/apps/launcher.js"));
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  const projectScope = { projectId: PROJECT.id, slug: PROJECT.slug };
  const shellFor = (empty) => ({
    scope: projectScope, projects: [PROJECT], tab: "chat", getPanel: () => null,
    apps: { scope: "project", projectSlug: PROJECT.slug, apps: empty ? [] : projectApps(), tiles: extra() },
  });
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return servePerchApi(req, res);
    if (req.url.startsWith("/dashboard/shell-api/apps")) return serveAppsApi(req, res);
    if (req.url.startsWith("/api/")) return send(res, 200, { items: [] });
    if (req.url.startsWith("/proxy/studio/vnc.html")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>studio vnc</title><p>vnc</p>");
    }
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    // A shell page with no Perch session on it.
    if (req.url.startsWith("/dashboard/home")) {
      const html = renderLayout({ title: "Home", content: "<p>home</p>", activePanel: "board", panels: [], lang: "en",
        variant: "shell", shell: shellFor(/[?&]empty=1\b/.test(req.url)) });
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html);
    }
    if (!req.url.startsWith("/dashboard/perch")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title><p>blank</p>");
    }
    req.crowMode = { mode: "new" };
    req.crowScope = projectScope;
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en",
      variant: "shell", shell: shellFor(false) });
    const db = { execute: async () => ({ rows: [PROJECT] }) };
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout, db });
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

async function tab(width, height, path, ready) {
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
  await cdp("Page.navigate", { url: `http://${HOST}:${port}${path}` });
  await waitFor(ready, "the page to be ready");
  const mouse = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  return {
    evalIn, waitFor,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    /** A real mouse click at the centre of the first element matching `sel`. */
    click: async (sel) => {
      const { x, y } = JSON.parse(await evalIn(`(function(){ var b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
        return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2}); })()`));
      await mouse(x, y);
    },
    key: async () => {
      const k = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const PERCH_READY = "document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-ident-sub').textContent";

/** The tile as the page shows it. */
const TILE = `(function(){
  var t=document.querySelector('#perch-transcript .ph-atile');
  if(!t) return JSON.stringify(null);
  var f=t.querySelector('iframe.at-vnc'), take=t.querySelector('.at-take'), b=t.getBoundingClientRect();
  return JSON.stringify({ app:t.getAttribute('data-app'), name:t.querySelector('.at-name').textContent,
    src:f?f.getAttribute('src'):null, takeHidden:take.hidden, takeVisible:!!take.offsetParent,
    focusIn:t===document.activeElement||t.contains(document.activeElement),
    active:document.activeElement&&(document.activeElement.id||document.activeElement.className),
    w:b.width, l:b.left, r:b.right, vw:innerWidth, sw:document.documentElement.scrollWidth });
})()`;

test("opening a desktop app from the launcher shows a watch-only tile", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  filed = true; offered = true; tileCalls.length = 0;
  const s = await tab(390, 844, `/dashboard/perch#${SID}`, PERCH_READY);
  try {
    // From the session's apps sheet.
    await s.click("#perch-apps-btn");
    await s.waitFor("document.getElementById('perch-apps-sheet').open&&!!document.querySelector('#perch-apps-grid a[data-app-id=\"studio\"]')", "the apps sheet");
    await s.click('#perch-apps-grid a[data-app-id="studio"]');
    await s.waitFor("!document.getElementById('perch-apps-sheet').open", "the sheet to close");
    await s.waitFor("!!document.querySelector('#perch-transcript .ph-atile iframe.at-vnc')", "the tile's viewer");
    await sleep(200); // the dialog's queued close event runs before focus is read
    const m = await s.json(TILE);
    assert.equal(await s.evalIn("location.pathname"), "/dashboard/perch", "no navigation");
    assert.equal(m.app, "studio");
    assert.equal(m.name, "Studio");
    assert.equal(m.src, "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale", "watch-only noVNC");
    assert.equal(m.takeHidden, false); assert.equal(m.takeVisible, true, "Take over is offered");
    assert.equal(m.focusIn, true, `focus is in the new tile, not on the apps button (${m.active})`);
    assert.ok(m.l >= 0 && m.r <= m.vw + 0.5 && m.sw <= m.vw, "the tile fits 390 px, no sideways scroll");
    await s.waitFor("(function(){ var f=document.querySelector('#perch-transcript .ph-atile iframe'); try{ return f.contentWindow.location.search; }catch(e){ return ''; } })()==='?view_only=true&autoconnect=true&resize=scale'", "the viewer page to load watch-only");
    assert.deepEqual(tileCalls, ["studio"], "the server confirmed the app");

    // Opening the same app again keeps one tile.
    await s.click("#perch-apps-btn");
    await s.waitFor("document.getElementById('perch-apps-sheet').open&&!!document.querySelector('#perch-apps-grid a[data-app-id=\"studio\"]')", "the apps sheet again");
    await s.click('#perch-apps-grid a[data-app-id="studio"]');
    await s.waitFor("!document.getElementById('perch-apps-sheet').open", "the sheet to close again");
    assert.equal(await s.evalIn("document.querySelectorAll('#perch-transcript .ph-atile').length"), 1, "one tile per app");

    // Close drops it.
    await s.click("#perch-transcript .ph-atile .at-close");
    await s.waitFor("!document.querySelector('#perch-transcript .ph-atile')", "the tile to close");
  } finally { await s.close(); }

  // Unconfirmed lease: watch-only with no Take over; from the drawer this time.
  offered = false;
  const d = await tab(390, 844, `/dashboard/perch#${SID}`, PERCH_READY);
  try {
    await d.click(".shell-scope");
    await d.waitFor("document.getElementById('shell-drawer').open&&!!document.querySelector('#shell-drawer a[data-app-id=\"studio\"]')", "the drawer");
    await d.click('#shell-drawer a[data-app-id="studio"]');
    await d.waitFor("!document.getElementById('shell-drawer').open", "the drawer to close");
    await d.waitFor("!!document.querySelector('#perch-transcript .ph-atile iframe.at-vnc')", "the tile's viewer");
    await sleep(200);
    const m = await d.json(TILE);
    assert.equal(m.takeHidden, true, "no Take over without a confirmed lease");
    assert.equal(m.focusIn, true, `focus is in the tile (${m.active})`);
    assert.equal(await d.evalIn("location.pathname"), "/dashboard/perch");
  } finally { await d.close(); }

  // A page app is not a tile: the link navigates.
  const p = await tab(390, 844, `/dashboard/perch#${SID}`, PERCH_READY);
  try {
    await p.click("#perch-apps-btn");
    await p.waitFor("!!document.querySelector('#perch-apps-grid a[data-app-id=\"wiki\"]')", "the apps sheet");
    await p.click('#perch-apps-grid a[data-app-id="wiki"]');
    await p.waitFor("location.pathname==='/proxy/wiki/'", "the page app's page");
  } finally { await p.close(); offered = true; }
});
