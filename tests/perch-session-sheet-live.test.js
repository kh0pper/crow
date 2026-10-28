// The new-mode session sheet, LIVE (R1.2 PR 2, Task 1): the real Perch page in
// the real new shell (renderLayout variant "shell", the panel handed a scope
// exactly as panels/perch-hub.js does for req.crowMode "new"), in a private
// headless Chrome (tests/fixtures/headless-chrome.mjs), against a scripted
// perch-api. The static half is in tests/perch-hub-render.test.js.
//
// Every wait is a poll on a page condition, never a fixed sleep before an
// assertion. Set PERCH_SHEET_SHOTS=<dir> to also save screenshots.
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
const SID = "perchlive-11111111";
const SHOTS = process.env.PERCH_SHEET_SHOTS || "";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;

/** Open /events responses, so a test can push frames: a stub turn. */
const streams = new Set();
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
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (url.endsWith("/transcript")) {
    return send(res, 200, { events: Array.from({ length: 6 }, (_, i) => ({
      type: "message", message: { role: i % 2 ? "assistant" : "user", content: [{ text: "line " + i }] } })) });
  }
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
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

/** The sheet's state, in one round trip. */
const SHEET = `(function(){
  var d=document.getElementById('perch-session-sheet');
  function shown(id){ var e=document.getElementById(id); return !!e&&!e.hidden&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0; }
  var sel=Array.prototype.filter.call(document.querySelectorAll('#perch-sheet-tabs [data-tab]'),function(b){ return b.getAttribute('aria-selected')==='true'; })
    .map(function(b){ return b.getAttribute('data-tab'); });
  return JSON.stringify({
    open: !!d.open, modal: d.matches(':modal'),
    session: shown('perch-tab-session'), files: shown('perch-tab-files'), activity: shown('perch-tab-activity'),
    chatHidden: document.getElementById('perch-tab-chat').hidden, chat: shown('perch-tab-chat'),
    selected: sel, active: document.activeElement&&document.activeElement.id,
    tabsBar: !!document.getElementById('perch-tabs'),
    meta: shown('perch-session-meta'), sid: document.getElementById('perch-session-id').textContent,
    sidShown: d.open ? shown('perch-session-id') : null,
    activityRows: Array.prototype.map.call(document.querySelectorAll('#perch-activity-list .activity-row'), function(r){ return r.textContent; })
  });
})()`;
const OPEN = "document.getElementById('perch-session-sheet').open";
const CLOSED = "!document.getElementById('perch-session-sheet').open";

test("sheet opens from the bot name, switches tabs, closes on Escape and returns focus", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    const before = await s.json(SHEET);
    assert.equal(before.tabsBar, false, "no tab bar in new mode");
    assert.equal(before.open, false);
    assert.equal(before.chat, true, "the chat is on screen");
    assert.equal(before.meta, false, "the raw sid is not in the head");
    assert.equal(before.sid, SID, "the Session section carries the sid");

    await s.click("perch-ident-btn");
    await s.waitFor(OPEN, "the sheet to open");
    const open = await s.json(SHEET);
    assert.equal(open.modal, true, "opened with showModal()");
    assert.deepEqual([open.session, open.files, open.activity], [true, false, false], "opens on Session by default");
    assert.deepEqual(open.selected, ["session"]);
    assert.equal(open.sidShown, true, "the session id is shown in the Session section");
    assert.equal(open.chatHidden, false, "the chat is never hidden behind the sheet");
    await s.shot("1280-sheet-session");

    await s.click("perch-tab-btn-files");
    await s.waitFor("!document.getElementById('perch-tab-files').hidden", "Files");
    const files = await s.json(SHEET);
    assert.deepEqual([files.session, files.files, files.activity], [false, true, false]);
    assert.deepEqual(files.selected, ["files"]);
    assert.equal(files.chatHidden, false);

    await s.click("perch-tab-btn-activity");
    await s.waitFor("!document.getElementById('perch-tab-activity').hidden", "Activity");
    assert.deepEqual((await s.json(SHEET)).selected, ["activity"]);

    await s.key("Escape");
    await s.waitFor(CLOSED, "Escape to close the sheet");
    const shut = await s.json(SHEET);
    assert.equal(shut.active, "perch-ident-btn", "focus returns to the bot name");
    assert.equal(shut.chat, true);

    // Reopens on the last-used tab; the close button closes it too.
    await s.click("perch-ident-btn");
    await s.waitFor(OPEN, "the sheet to reopen");
    const again = await s.json(SHEET);
    assert.deepEqual(again.selected, ["activity"], "reopens on its last-used tab");
    assert.equal(again.activity, true);
    await s.click("perch-sheet-close");
    await s.waitFor(CLOSED, "the close button to close it");
    assert.equal((await s.json(SHEET)).active, "perch-ident-btn");

    // A backdrop tap closes it: a point outside the centred sheet.
    await s.click("perch-ident-btn");
    await s.waitFor(OPEN, "the sheet to open a third time");
    await s.clickAt(10, 10);
    await s.waitFor(CLOSED, "a backdrop tap to close it");
    assert.equal((await s.json(SHEET)).active, "perch-ident-btn");

    // Keyboard: Enter on the focused bot name opens it.
    await s.evalIn("document.getElementById('perch-ident-btn').focus(); 'ok'");
    await s.key("Enter");
    await s.waitFor(OPEN, "Enter to open the sheet");
    await s.key("Escape");
    await s.waitFor(CLOSED, "Escape again");
  } finally { await s.close(); }
});

test("sheet shows live activity and returns focus", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 844);
  try {
    // The stream is open before the turn starts.
    for (const end = Date.now() + 5000; !streams.size && Date.now() < end;) await sleep(100);
    assert.ok(streams.size > 0, "the page subscribed to the session's events");
    await s.click("perch-ident-btn");
    await s.waitFor(OPEN, "the sheet");
    await s.click("perch-tab-btn-activity");
    await s.waitFor("!document.getElementById('perch-tab-activity').hidden", "Activity");

    // A stub turn: the tool start and a log line land while the sheet is open.
    emit("state", { state: "working", turnInFlight: true });
    emit("tool", { phase: "start", name: "read_file", id: "t1" });
    emit("log", { text: "reading notes.md" });
    await s.waitFor("document.querySelectorAll('#perch-activity-list .activity-row').length>=2", "live activity rows");
    const live = await s.json(SHEET);
    assert.equal(live.open, true, "the frames did not close the sheet");
    assert.ok(live.activityRows.some((r) => r.includes("[tool: read_file]")), JSON.stringify(live.activityRows));
    assert.ok(live.activityRows.some((r) => r.includes("reading notes.md")), JSON.stringify(live.activityRows));
    const visible = await s.evalIn(`(function(){ var rows=document.querySelectorAll('#perch-activity-list .activity-row');
      var r=rows[rows.length-1].getBoundingClientRect(); return r.height>0&&r.bottom<=innerHeight&&r.top>=0; })()`);
    assert.equal(visible, true, "the newest line is on screen in the sheet");
    emit("tool", { phase: "end", name: "read_file", id: "t1" });
    emit("log", { text: "turn finished" });
    await s.waitFor("Array.prototype.some.call(document.querySelectorAll('#perch-activity-list .activity-row'),function(r){return r.textContent.indexOf('turn finished')>=0;})",
      "the turn's last line");
    await s.shot("390-sheet-activity");

    await s.key("Escape");
    await s.waitFor(CLOSED, "Escape to close");
    const shut = await s.json(SHEET);
    assert.equal(shut.active, "perch-ident-btn", "focus returns to the bot name");
    assert.equal(shut.chat, true, "the chat is still there");
  } finally { await s.close(); }
});

test("390 px: no horizontal scroll, every sheet control ≥44 px", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 844);
  try {
    const ident = await s.json(`(function(){ var b=document.getElementById('perch-ident-btn').getBoundingClientRect();
      return JSON.stringify({h:Math.round(b.height),right:Math.round(b.right)}); })()`);
    assert.ok(ident.h >= 44, "the bot-name button is thumb-sized: " + ident.h);
    assert.ok(ident.right <= 390, "the bot-name button fits: " + ident.right);
    await s.click("perch-ident-btn");
    await s.waitFor(OPEN, "the sheet");
    const MEASURE = `(function(){
      var d=document.getElementById('perch-session-sheet'), out=[];
      d.querySelectorAll('button,select,input,a[href],summary,[role="tab"]').forEach(function(e){
        if(e.type==='hidden') return;
        var r=e.getBoundingClientRect(); if(!r.width||!r.height) return;   /* not on screen in this tab */
        if(Math.round(r.height)<44||Math.round(r.width)<44) out.push((e.id||e.tagName+'.'+e.className)+' '+Math.round(r.width)+'x'+Math.round(r.height));
      });
      var dr=d.getBoundingClientRect();
      return JSON.stringify({small:out, hScroll:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        sheetScroll:d.scrollWidth>d.clientWidth+1, left:Math.round(dr.left), right:Math.round(dr.right)});
    })()`;
    for (const name of ["session", "files", "activity"]) {
      await s.click("perch-tab-btn-" + name);
      await s.waitFor(`!document.getElementById('perch-tab-${name}').hidden`, name);
      // Files loads on activation: measure once its crumbs have landed.
      if (name === "files") await s.waitFor("document.querySelectorAll('#perch-cwd-crumbs button').length>=2", "the cwd crumbs");
      const m = await s.json(MEASURE);
      await s.shot("390-sheet-" + name);
      assert.deepEqual(m.small, [], `${name}: every sheet control is at least 44x44`);
      assert.equal(m.hScroll, false, `${name}: no horizontal page scroll`);
      assert.equal(m.sheetScroll, false, `${name}: the sheet does not scroll sideways`);
      assert.ok(m.left >= 0 && m.right <= 390, `${name}: the sheet fits the width (${m.left}..${m.right})`);
    }
  } finally { await s.close(); }
});
