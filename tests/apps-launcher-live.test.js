// The apps launcher, LIVE (R1.2 PR 5, Task 2): the real new shell (renderLayout
// variant "shell") with the drawer's Apps section, and the real Perch page with
// a session filed to a project, in a private headless Chrome
// (tests/fixtures/headless-chrome.mjs), against a scripted apps API. The static
// half is tests/shell-apps-launcher.test.js. Skips cleanly without Chrome.
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
const SID = "perchlive-22222222";
const PROJECT = { id: 1, slug: "garden", name: "Garden" };

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
let filed = true;
const apiCalls = [];
const streams = new Set();
function emit(type, data) {
  for (const res of streams) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  return streams.size;
}

let clientApp, clientTile;
// Raw catalog-shaped apps; launcher.js clientApp turns them into what the API sends.
const RAW = {
  browser: { id: "browser", label: "Browser", icon: "monitor", kind: "desktop", href: "/proxy/browser/vnc.html" },
  wiki: { id: "wiki", label: "Wiki", icon: "book", kind: "page", href: "/proxy/wiki/" },
  ntfy: { id: "ntfy", label: "Notifications", icon: null, kind: "page", href: null, directPort: 2586, path: "/", fallbackHref: "/dashboard/extensions" },
};
const projectApps = () => [clientApp(RAW.browser), clientApp(RAW.wiki)];
const allApps = () => [clientApp(RAW.browser), clientApp(RAW.wiki), clientApp(RAW.ntfy)];
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
const HOME_READY = "!!document.querySelector('#shell-drawer .shell-apps')";
const ids = (scope) => `JSON.stringify(Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(scope)}),function(a){return a.getAttribute('data-app-id')||a.getAttribute('data-launcher-tile');}))`;

/** Every tile and control in `root`: its box, plus the page's sideways overflow. */
const SIZES = (root) => `(function(){
  var r=document.querySelector(${JSON.stringify(root)});
  var els=r.querySelectorAll('.shell-app,.shell-apps-chip,.shell-apps-goto,.perch-sheet-close,.shell-sheet-close');
  var out=[];
  for(var i=0;i<els.length;i++){ var b=els[i].getBoundingClientRect(); if(!b.width) continue;
    out.push({t:(els[i].getAttribute('data-app-id')||els[i].getAttribute('data-launcher-tile')||els[i].className),w:b.width,h:b.height,l:b.left,r:b.right}); }
  var gb=r.querySelector('.shell-apps-grid:not([hidden])').getBoundingClientRect();
  var cols=getComputedStyle(r.querySelector('.shell-apps-grid:not([hidden])')).gridTemplateColumns.split(' ').length;
  return JSON.stringify({els:out,grid:{l:gb.left,r:gb.right},cols:cols,sw:document.documentElement.scrollWidth,vw:innerWidth,
    bodySw:document.body.scrollWidth});
})()`;

test("the session apps button opens the sheet", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  filed = true;
  apiCalls.length = 0;
  const s = await tab(390, 844, `/dashboard/perch#${SID}`, PERCH_READY);
  try {
    const btn = await s.json(`(function(){ var b=document.getElementById('perch-apps-btn'); var r=b.getBoundingClientRect();
      return JSON.stringify({hidden:b.hidden,w:r.width,h:r.height,name:b.getAttribute('aria-label')}); })()`);
    assert.equal(btn.hidden, false, "a filed session shows the apps button");
    assert.equal(btn.name, "Apps for this project");
    assert.ok(btn.w >= 44 && btn.h >= 44, `44 px (${btn.w}x${btn.h})`);

    await s.click("#perch-apps-btn");
    await s.waitFor("document.getElementById('perch-apps-sheet').open&&document.querySelectorAll('#perch-apps-grid .shell-app').length===3", "the sheet and its tiles");
    assert.deepEqual(apiCalls, [PROJECT.slug], "the session's project's apps, through the apps API");
    assert.equal(await s.evalIn("document.getElementById('perch-apps-sheet').matches(':modal')"), true);
    assert.deepEqual(JSON.parse(await s.evalIn(ids("#perch-apps-grid .shell-app"))), ["browser", "wiki", "stub-add"], "apps, then the extra tiles");

    await s.key();
    await s.waitFor("!document.getElementById('perch-apps-sheet').open", "Escape to close the sheet");
    await s.waitFor("document.activeElement&&document.activeElement.id==='perch-apps-btn'", "focus back on the apps button");

    // A session that takes the desktop app (Task 3's handler) keeps the page and closes the sheet.
    await s.evalIn(`window.__appEvents=[]; document.addEventListener('crow:open-app-tile',function(e){ window.__appEvents.push(e.detail.appId); e.preventDefault(); }); 1`);
    await s.click("#perch-apps-btn");
    await s.waitFor("document.querySelectorAll('#perch-apps-grid .shell-app').length===3", "the tiles again");
    await s.click('#perch-apps-grid a[data-app-id="browser"]');
    await s.waitFor("!document.getElementById('perch-apps-sheet').open", "the sheet to close on a handled open");
    assert.deepEqual(JSON.parse(await s.evalIn("JSON.stringify(window.__appEvents)")), ["browser"]);
    assert.equal(await s.evalIn("location.pathname"), "/dashboard/perch", "no navigation");
  } finally { await s.close(); }

  // An unfiled session has no project: no apps button.
  filed = false;
  const u = await tab(390, 844, `/dashboard/perch#${SID}`, "document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent");
  try {
    await sleep(300);
    assert.equal(await u.evalIn("document.getElementById('perch-apps-btn').hidden"), true);
  } finally { await u.close(); filed = true; }
});

test("an ask arriving while the apps sheet is open closes it", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  filed = true;
  const s = await tab(390, 844, `/dashboard/perch#${SID}`, PERCH_READY);
  try {
    for (const end = Date.now() + 5000; !streams.size && Date.now() < end;) await sleep(100);
    assert.ok(streams.size > 0, "the session's event stream is open");
    await s.click("#perch-apps-btn");
    await s.waitFor("document.getElementById('perch-apps-sheet').open", "the apps sheet");
    emit("ask_user", { requestId: "q-apps", method: "confirm", title: "Delete the draft?" });
    await s.waitFor("!document.getElementById('perch-apps-sheet').open", "the ask to close the apps sheet");
    await s.waitFor("!!document.querySelector('#perch-ask .ask-card')", "the ask card");
    await sleep(200); // let the dialog's queued close event run before reading focus
    const m = await s.json(`(function(){
      var card=document.querySelector('#perch-ask .ask-card'), btn=card.querySelector('button');
      var b=btn.getBoundingClientRect(), hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
      return JSON.stringify({hit:!!hit&&(hit===btn||btn.contains(hit)), active:document.activeElement&&document.activeElement.id});
    })()`);
    assert.equal(m.hit, true, "the ask card's button is hit-testable, not under a modal");
    assert.notEqual(m.active, "perch-apps-btn", "the closing sheet does not pull focus back to the apps button");
    assert.equal(await s.evalIn("document.querySelector('#perch-ask .ask-card').contains(document.activeElement)"), true, "the ask has focus");
  } finally { await s.close(); }
});

test("no session opens the page", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  apiCalls.length = 0;
  const s = await tab(390, 844, "/dashboard/home", HOME_READY);
  try {
    await s.click(".shell-scope");
    await s.waitFor("document.getElementById('shell-drawer').open", "the drawer");
    assert.deepEqual(JSON.parse(await s.evalIn(ids('#shell-drawer [data-apps-grid="project"] .shell-app'))), ["browser", "wiki", "stub-add"]);
    // All apps: fetched on the switch, a direct app pointed at this host's port.
    await s.click('#shell-drawer [data-apps-view="all"]');
    await s.waitFor(`document.querySelectorAll('#shell-drawer [data-apps-grid="all"] .shell-app').length===3`, "All to load");
    assert.deepEqual(apiCalls, ["all"]);
    const all = await s.json(`(function(){ var g=document.querySelector('#shell-drawer [data-apps-grid="all"]');
      var p=document.querySelector('#shell-drawer [data-apps-grid="project"]');
      return JSON.stringify({pHidden:p.hidden,aHidden:g.hidden,
        pressed:Array.prototype.map.call(document.querySelectorAll('#shell-drawer [data-apps-view]'),function(b){return b.getAttribute('aria-pressed');}),
        ntfy:g.querySelector('[data-app-id="ntfy"]').getAttribute('href')}); })()`);
    assert.deepEqual([all.pHidden, all.aHidden, all.pressed], [true, false, ["false", "true"]]);
    assert.equal(all.ntfy, `https://${HOST}:2586/`);
    await s.click('#shell-drawer [data-apps-view="project"]');
    await s.waitFor(`!document.querySelector('#shell-drawer [data-apps-grid="project"]').hidden`, "back to This project");
    assert.deepEqual(apiCalls, ["all"], "switching back costs no request");

    // Nothing handles crow:open-app-tile here: the desktop app's link navigates.
    await s.click('#shell-drawer [data-apps-grid="project"] a[data-app-id="browser"]');
    await s.waitFor("location.pathname==='/proxy/browser/vnc.html'", "the app's page");
  } finally { await s.close(); }

  // The empty This project offers All apps, and it switches.
  const e = await tab(390, 844, "/dashboard/home?empty=1", HOME_READY);
  try {
    await e.click(".shell-scope");
    await e.waitFor("document.getElementById('shell-drawer').open", "the drawer");
    const text = await e.evalIn(`document.querySelector('#shell-drawer .shell-apps-empty').textContent`);
    assert.equal(text, "No apps for this project's bots yet · All apps");
    await e.click("#shell-drawer [data-apps-goto]");
    await e.waitFor(`document.querySelectorAll('#shell-drawer [data-apps-grid="all"] .shell-app').length===3`, "All to load");
    assert.equal(await e.evalIn("document.activeElement.getAttribute('data-apps-view')"), "all", "focus moves to the All chip");
  } finally { await e.close(); }
});

test("390 px: grid fits, targets ≥44 px, no sideways scroll", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const check = (m, where) => {
    assert.equal(m.cols, 4, `${where}: a 4-column grid`);
    assert.ok(m.els.length >= 3, `${where}: measured something`);
    for (const x of m.els) {
      assert.ok(x.w >= 44 && x.h >= 44, `${where}: ${x.t} is ${x.w}x${x.h}`);
      assert.ok(x.l >= 0 && x.r <= m.vw + 0.5, `${where}: ${x.t} on screen (${x.l}..${x.r})`);
    }
    assert.ok(m.grid.r <= m.vw + 0.5, `${where}: the grid fits`);
    assert.ok(m.sw <= m.vw && m.bodySw <= m.vw, `${where}: no sideways scroll (${m.sw}/${m.bodySw} > ${m.vw})`);
  };
  const s = await tab(390, 844, "/dashboard/home", HOME_READY);
  try {
    await s.click(".shell-scope");
    await s.waitFor("document.getElementById('shell-drawer').open", "the drawer");
    check(await s.json(SIZES("#shell-drawer")), "drawer, This project");
    await s.click('#shell-drawer [data-apps-view="all"]');
    await s.waitFor(`document.querySelectorAll('#shell-drawer [data-apps-grid="all"] .shell-app').length===3`, "All");
    check(await s.json(SIZES("#shell-drawer")), "drawer, All apps");
  } finally { await s.close(); }
  const p = await tab(390, 844, `/dashboard/perch#${SID}`, PERCH_READY);
  try {
    await p.click("#perch-apps-btn");
    await p.waitFor("document.querySelectorAll('#perch-apps-grid .shell-app').length===3", "the apps sheet");
    check(await p.json(SIZES("#perch-apps-sheet")), "session apps sheet");
    // The head keeps the bot name on screen beside the new button.
    const head = await p.json(`(function(){ var h=document.querySelector('.perch-head').getBoundingClientRect(), b=document.getElementById('perch-apps-btn').getBoundingClientRect();
      return JSON.stringify({in:b.right<=h.right+0.5&&b.left>=h.left-0.5, top:Math.abs(b.top-document.getElementById('perch-ident-btn').getBoundingClientRect().top)<40}); })()`);
    assert.deepEqual(head, { in: true, top: true }, "the apps button sits in the head row");
  } finally { await p.close(); }
});
