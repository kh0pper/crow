/**
 * Redesign P2, Task 2.6: the new shell in a real browser.
 *
 * The REAL dashboard router (dashboardAuth, csrfMiddleware, the body parser,
 * the panel dispatch and the shell's /dashboard/mode route) is mounted over a
 * scratch CROW_DATA_DIR, with the vendored Turbo 8 served from public/, and a
 * private headless Chrome drives it at phone 390×844 and desktop 1280×800,
 * en and es, light and dark, and at the largest text size.
 *
 * Stubs, all inside this file's scratch home:
 *   - a Kiosk panel that declares the session display (+ its routes entry), so
 *     the header bird is armed for the Talk to Crow long-press;
 *   - an Artifacts panel standing in for the bundle, so the Make tab has its
 *     real P2 target (/dashboard/artifacts);
 *   - a third-party panel (~/.crow/panels) that ignores the layout it is
 *     handed and renders the classic one itself. No shipped bundle panel does
 *     that today; this one proves such a page never mixes with the shell;
 *   - Perch's /dashboard/perch-api (one bot, one live session) and a short
 *     WAV for the player bar;
 *   - Ramble's /api/ramble/pet (a hatched grackle) and its bird engine, so
 *     the header mascot is the user's Ramble bird.
 *
 * Set SHELL_SHOTS_DIR to also save phone + desktop, light + dark screenshots.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "shell-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-shell-live");
// The engine is "ready": no install banner above the chat (see perch-phone-layout.test.js).
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;
const SID = "perchlive-5a1d0c3e";

// A third-party panel that renders its own (classic) layout.
mkdirSync(join(HOME, "panels"), { recursive: true });
writeFileSync(join(HOME, "panels.json"), JSON.stringify(["selfrender"]));
writeFileSync(join(HOME, "panels", "selfrender.js"), `
import { renderLayout } from ${JSON.stringify(pathToFileURL(join(REPO, "servers/gateway/dashboard/shared/layout.js")).href)};
export default {
  id: "selfrender", name: "Self-rendered", icon: "default", route: "/dashboard/selfrender", navOrder: 999,
  async handler(req, res, { lang }) {
    return renderLayout({ title: "Self-rendered", content: '<p id="selfrender-body">own layout</p>', activePanel: "selfrender", panels: [], lang });
  },
};
`);

let server, base, chrome, MODE, setLang;

/** A 0.2 s silent 8 kHz mono WAV, for the player bar. */
function wav() {
  const n = 1600, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, archived_at) VALUES (?,?,?,?,?)");
  proj.run("garden", "Garden", "general", "active", null);
  proj.run("kitchen", "Kitchen", "general", "active", null);
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)");
  tok.run(hashToken("old-sess"), "2025-06-01 00:00:00");
  tok.run(hashToken("new-sess"), "2026-06-01 00:00:00");
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  setLang = async (lang) => { const d = createDbClient(); try { await writeSetting(d, "language", lang); } finally { d.close(); } };

  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { registerPanel, getPanel, getPanelRoutes } = await import("../servers/gateway/dashboard/panel-registry.js");
  registerPanel({ id: "kiosk", name: "Kiosk", icon: "default", route: "/dashboard/kiosk", navOrder: 998, hidden: true, sessionDisplay: true,
    handler: async (req, res, { layout }) => layout({ title: "Kiosk", content: "<p>kiosk</p>" }) });
  getPanelRoutes().set("kiosk", () => (req, res, next) => next());
  registerPanel({ id: "artifacts", name: "Artifacts", icon: "default", route: "/dashboard/artifacts", navOrder: 997,
    handler: async (req, res, { layout }) => layout({ title: "Artifacts", content: '<p id="artifacts-body">artifacts</p>' }) });

  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { Object.assign(req.headers, serveHeaders("operator@example.com")); /* Serve stand-in: the headers Serve really sends */ res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.get("/a.wav", (req, res) => res.type("audio/wav").send(wav()));
  app.get("/display/session", (req, res) => res.type("html").send("<!doctype html><title>session</title><p>talk</p>"));
  // A hatched Ramble bird (the bundle's pet route and its real draw engine), for the header mascot.
  app.get("/api/ramble/pet", (req, res) => res.json({ bird: { species: "grackle", seed: 4242, outfit: null }, energy: 80 }));
  app.get("/ramble/static/bird-svg.js", (req, res) => res.type("text/javascript").sendFile(join(REPO, "bundles/ramble/server/bird-svg.cjs")));
  app.use("/dashboard/perch-api", (req, res) => {
    const url = req.path;
    if (url === "/roost") return res.json({ birds: [{ id: "helper", name: "Helper", perch_attached: true, state: "working",
      sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run", projectId: null }] }], occupiedCardIds: [] });
    if (url.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      return;
    }
    if (url.endsWith("/transcript")) return res.json({ events: [] });
    if (url.endsWith("/options")) return res.json({ models: [], thinkingLevels: [] });
    if (url.endsWith("/models")) return res.json({ models: [], default: null });
    return res.json({});
  });
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
  // loadExternalPanels runs un-awaited inside dashboardRouter().
  for (let i = 0; i < 50 && !getPanel("selfrender"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(getPanel("selfrender"), "the third-party panel loaded");
  chrome = await startHeadlessChrome();
});

after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = "!!window.Turbo && document.readyState === 'complete' && !!document.querySelector('.content-header') && !document.documentElement.hasAttribute('aria-busy')";
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";

/** A tab at a viewport, logged in as `session` ("new" opens the shell, "old" classic). */
async function open(path, { width = 390, height = 844, dark = false, textSize = null, session = "new", mode = null } = {}) {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) {
        let where = "";
        try { where = await ev("location.href + ' view=' + document.body.getAttribute('data-view') + ' shell=' + document.body.classList.contains('shell')"); } catch {}
        throw new Error("timed out waiting for " + what + " (" + expression + ") at " + where + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
      }
      await sleep(80);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  // Cookies are shared by every tab of this browser: start each tab from a clean jar.
  await send("Network.clearBrowserCookies");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  const cookies = [{ name: "crow_session", value: session + "-sess" }, { name: "crow_csrf", value: "tok" }];
  if (mode) cookies.push({ name: MODE, value: mode });
  for (const ck of cookies) await send("Network.setCookie", { ...ck, url: base, path: "/" });
  // The text size is a per-device localStorage value read by the head script.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem('crow-text-size', ${JSON.stringify(textSize || "default")}); } catch (e) {}` });
  await send("Page.navigate", { url: base + path });
  await until(READY, "the page");
  await ev(TWO_FRAMES);
  const key = async (k, code, keyCode, mods = 0) => {
    const text = k === "Enter" ? "\r" : undefined;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers: mods, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers: mods });
  };
  const center = async (sel) => ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; var b=e.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`);
  const click = async (sel) => {
    const p = await center(sel);
    assert.ok(p, "no element " + sel);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  };
  const hold = async (sel, ms) => {
    const p = await center(sel);
    assert.ok(p, "no element " + sel);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(ms);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  };
  const settled = async () => { await until(READY, "the page to settle"); await ev(TWO_FRAMES); };
  return { send, ev, until, key, click, hold, settled, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}

const NO_H_SCROLL = "document.documentElement.scrollWidth <= window.innerWidth";
/** {count, bad}: the visible elements matching `sel`, and those smaller than 44×44 as "class:text:w×h". */
const small = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;
/** Every matched group must really be on the page (a selector matching nothing proves nothing) and be ≥ 44. */
async function assertTargets(p, groups, tag) {
  for (const [sel, min, what] of groups) {
    const r = await p.ev(small(sel));
    assert.ok(r.count >= min, `${what}: found ${r.count} visible, expected at least ${min} (${tag})`);
    assert.deepEqual(r.bad, [], `${what} ≥ 44 (${tag})`);
  }
}
const OPEN_SHEET = (id) => `(function(){ return !!document.getElementById(${JSON.stringify(id)}).open; })()`;

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const lang of ["en", "es"]) {
    test(`${width}×${height} ${lang}: no horizontal scroll, 44 px targets, the gutter, the bar or the rail (light, dark, xlarge)`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      await setLang(lang);
      try {
        for (const dark of [false, true]) {
          for (const textSize of [null, "xlarge"]) {
            const tag = `${lang} ${dark ? "dark" : "light"} ${textSize || "default"}`;
            const p = await open("/dashboard/memory", { width, height, dark, textSize });
            try {
              assert.equal(await p.ev("document.documentElement.lang"), lang);
              assert.equal(await p.ev("document.documentElement.getAttribute('data-text-size')"), textSize || "default");
              assert.equal(await p.ev(NO_H_SCROLL), true, `no horizontal page scroll (${tag})`);
              await assertTargets(p, [
                [".shell-tab", 3, "tabs"],
                [".shell-scope", 1, "scope chip"],
                [".shell-avatar", 1, "avatar"],
                ["#crow-bird-btn", 1, "bird"],
                // The rail (Garden, Kitchen) only exists on the desktop layout.
                ...(width >= 900 ? [[".shell-rail-projects .shell-project", 2, "rail projects"]] : []),
              ], tag);
              const g = await p.ev(`(function(){
                var body=document.querySelector('.content-body'), cs=getComputedStyle(body), b=body.getBoundingClientRect();
                var h2=document.querySelector('.content-header h2').getBoundingClientRect();
                var bar=document.querySelector('.shell-tabs').getBoundingClientRect();
                var main=document.querySelector('.main-content').getBoundingClientRect();
                return { inset: b.left + parseFloat(cs.paddingLeft), right: innerWidth - (b.right - parseFloat(cs.paddingRight)), h2: h2.left,
                  bar: { top: bar.top, bottom: bar.bottom, left: bar.left, width: bar.width, height: bar.height }, main: main.left, vw: innerWidth, vh: innerHeight }; })()`);
              if (width === 390) {
                assert.ok(g.inset >= 16, `content left inset ${g.inset} ≥ 16 (${tag})`);
                assert.ok(g.right >= 16, `content right inset ${g.right} ≥ 16 (${tag})`);
                assert.ok(g.h2 >= 16, `header title inset ${g.h2} ≥ 16 (${tag})`);
                assert.equal(g.bar.bottom, g.vh, `the bar sits on the bottom edge (${tag})`);
                assert.equal(g.bar.left, 0); assert.equal(g.bar.width, g.vw, "the bar spans the width");
                assert.ok(g.bar.height >= 44 && g.bar.height <= 80, `bar height ${g.bar.height}`);
                assert.equal(g.main, 0, "no rail on a phone");
              } else {
                assert.equal(g.bar.left, 0, `the rail is on the left (${tag})`);
                assert.equal(g.bar.top, 0); assert.equal(g.bar.bottom, g.vh, "the rail is full height");
                assert.equal(g.bar.width, 232);
                assert.ok(g.main >= 232, `content starts right of the rail (${g.main})`);
                assert.ok(g.inset >= 232 + 16, `content inset ${g.inset}`);
              }
              // The drawer: every item ≥ 44, inside the viewport, no horizontal scroll.
              await p.click(".shell-scope");
              await p.until(OPEN_SHEET("shell-drawer"), "the drawer");
              await p.ev(TWO_FRAMES);
              await assertTargets(p, [
                ["#shell-drawer .shell-project", 2, "drawer projects"],
                ["#shell-drawer .shell-more-item", 3, "drawer More items"],
                ["#shell-drawer .shell-sheet-close", 1, "drawer close"],
              ], tag);
              assert.ok(await p.ev("document.querySelectorAll('#shell-drawer .shell-more-item').length") >= 3, "More of Crow lists panels");
              const d = await p.ev("(function(){ var r=document.getElementById('shell-drawer').getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom}; })()");
              assert.ok(d.l >= 0 && d.r <= width && d.t >= 0 && d.b <= height + 0.5, `drawer on screen ${JSON.stringify(d)} (${tag})`);
              assert.equal(await p.ev(NO_H_SCROLL), true);
              await p.key("Escape", "Escape", 27);
              await p.until("!document.getElementById('shell-drawer').open", "the drawer to close");
              await p.click(".shell-avatar");
              await p.until(OPEN_SHEET("shell-avatar"), "the avatar sheet");
              await p.ev(TWO_FRAMES);
              await assertTargets(p, [
                ["#shell-avatar .shell-sheet-link", 1, "avatar sheet links"],
                ["#shell-avatar .shell-sheet-close", 1, "avatar sheet close"],
              ], tag);
              await p.key("Escape", "Escape", 27);
              await p.until("!document.getElementById('shell-avatar').open", "the avatar sheet to close");
            } finally { await p.close(); }
          }
        }
      } finally { await setLang("en"); }
    });
  }
}

test("a Turbo visit between tabs keeps one shell, and aria-current moves (phone and desktop)", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const p = await open("/dashboard/perch", { width, height });
    const current = "(function(){ var a=document.querySelectorAll('.shell-tab[aria-current=\"page\"]'); return a.length===1 ? a[0].getAttribute('href') : a.length; })()";
    try {
      assert.equal(await p.ev(current), "/dashboard/perch");
      await p.ev("window.__shellMark = 1; true");
      // The Board tab is the board panel (P3) once it is registered.
      await p.click(".shell-tab[href='/dashboard/board']");
      await p.until("location.pathname === '/dashboard/board'", "Board");
      await p.settled();
      assert.equal(await p.ev("document.querySelectorAll('.shell-tabs').length"), 1);
      assert.equal(await p.ev(current), "/dashboard/board");
      await p.click(".shell-tab[href='/dashboard/make']");
      await p.until("location.pathname === '/dashboard/make' && !!document.querySelector('.mk-page')", "Make");
      await p.settled();
      assert.equal(await p.ev("document.querySelectorAll('.shell-tabs').length"), 1);
      assert.equal(await p.ev(current), "/dashboard/make");
      assert.equal(await p.ev("window.__shellMark"), 1, "both were Turbo visits, not full loads");
      assert.equal(await p.ev("document.querySelectorAll('meta[name=\"crow-mode\"]').length"), 1);
      assert.equal(await p.ev("document.querySelectorAll('dialog#shell-drawer').length + document.querySelectorAll('dialog#shell-avatar').length"), 2, "one drawer and one avatar sheet");
    } finally { await p.close(); }
  }
});

test("an open chat's Send is on screen at 390 px, the tab bar is hidden, and the player bar does not cover it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  for (const textSize of [null, "xlarge"]) {
    const p = await open("/dashboard/perch#" + SID, { textSize });
    try {
      await p.until("document.body.getAttribute('data-view') === 'chat' && !!document.getElementById('perch-bot-name').textContent", "the chat");
      assert.equal(await p.ev("document.documentElement.getAttribute('data-text-size')"), textSize || "default");
      await p.ev(TWO_FRAMES);
      const m = await p.ev("(function(){ var s=document.getElementById('perch-send').getBoundingClientRect(); return { bottom: s.bottom, top: s.top, h: s.height, tabs: getComputedStyle(document.querySelector('.shell-tabs')).display, vh: innerHeight, sw: document.documentElement.scrollWidth, vw: innerWidth }; })()");
      assert.equal(m.tabs, "none", "the tab bar is hidden in an open chat");
      const gut = await p.ev("(function(){ var h=document.querySelector('.content-header'), cs=getComputedStyle(h); return { title: document.querySelector('.content-header h2').getBoundingClientRect().left, back: document.getElementById('perch-back').getBoundingClientRect().left, avatarRight: innerWidth - document.querySelector('.shell-avatar').getBoundingClientRect().right, input: document.getElementById('perch-input').getBoundingClientRect().left }; })()");
      for (const [k, v] of Object.entries(gut)) assert.ok(v >= 16, `open chat: ${k} inset ${v} ≥ 16 (${textSize || "default"})`);
      assert.ok(m.h > 0 && m.top >= 0 && m.bottom <= m.vh, `Send ${m.top}→${m.bottom} within ${m.vh} (${textSize || "default"})`);
      assert.ok(m.sw <= m.vw, "no horizontal scroll");
      await p.ev("window.crowPlayer.load('/a.wav', 'Radio'); 1");
      await p.until("document.getElementById('crow-player-bar').offsetHeight > 0 && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--crow-player-h')) > 0", "the player bar");
      await p.ev(TWO_FRAMES);
      const b = await p.ev("(function(){ var s=document.getElementById('perch-send').getBoundingClientRect(), bar=document.getElementById('crow-player-bar').getBoundingClientRect(); return { bottom: s.bottom, barTop: bar.top, vh: innerHeight }; })()");
      assert.ok(b.bottom <= b.barTop + 0.5 && b.bottom <= b.vh, `with the bar, Send bottom ${b.bottom} ≤ bar top ${b.barTop} (${textSize || "default"})`);
      // Back to the list: the tab bar is back.
      await p.ev("document.getElementById('perch-back').click(); 1");
      await p.until("document.body.getAttribute('data-view') !== 'chat'", "the list");
      assert.notEqual(await p.ev("getComputedStyle(document.querySelector('.shell-tabs')).display"), "none");
      await p.ev("window.crowPlayer.close(); 1");
    } finally { await p.close(); }
  }
});

test("a real reload restores a Perch draft in new mode", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/perch#" + SID);
  try {
    await p.until("document.body.getAttribute('data-view') === 'chat'", "the chat");
    assert.equal(await p.ev("document.body.classList.contains('shell')"), true);
    await p.ev("(function(){ var i=document.getElementById('perch-input'); i.focus(); i.value='half a thought'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
    await p.until("sessionStorage.getItem('perch-draft:' + " + JSON.stringify(SID) + ") === 'half a thought'", "the debounced draft to be stored");
    await p.ev("window.__beforeReload = 1; true");
    await p.send("Page.reload", { ignoreCache: false });
    await p.until("window.__beforeReload === undefined && document.readyState === 'complete'", "the reload");
    await p.until("document.body.getAttribute('data-view') === 'chat'", "the chat after reload");
    assert.equal(await p.until("document.getElementById('perch-input').value", "the restored draft"), "half a thought");
    assert.equal(await p.ev("performance.getEntriesByType('navigation')[0].type"), "reload");
  } finally { await p.close(); }
});

test("classic and new styling never stack: the Try card's switch, the avatar's switch back, and a classic→shell Turbo visit", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const SHELL_STYLES = "[...document.querySelectorAll('style')].filter(function(s){ return s.textContent.indexOf('body.shell .shell-tabs') !== -1; }).length";
  const p = await open("/dashboard/memory", { width: 1280, height: 800, session: "old" });
  try {
    assert.equal(await p.ev("document.querySelector('meta[name=\"crow-mode\"]').content"), "classic");
    assert.equal(await p.ev("!!document.querySelector('.sidebar') && !document.body.classList.contains('shell')"), true);
    assert.equal(await p.ev(SHELL_STYLES), 0);
    // "Try it" POSTs /dashboard/mode (Turbo, CSRF) and follows the 303.
    await p.ev("window.__classicMark = 1; true");
    await p.click(".try-new-card form[action='/dashboard/mode'] button");
    await p.until("document.body.classList.contains('shell') && location.pathname === '/dashboard/perch'", "the shell");
    await p.settled();
    const n = await p.ev(`(function(){ return {
      metas: [...document.querySelectorAll('meta[name="crow-mode"]')].map(function(m){ return m.content; }),
      sidebar: !!document.querySelector('.sidebar'), styles: ${SHELL_STYLES},
      ml: getComputedStyle(document.querySelector('.content-body')).marginLeft,
      main: document.querySelector('.main-content').getBoundingClientRect().left,
      mark: window.__classicMark === undefined,
      nav: performance.getEntriesByType('navigation')[0].name }; })()`);
    assert.deepEqual(n.metas, ["shell"]);
    assert.equal(n.sidebar, false);
    assert.equal(n.styles, 1);
    assert.equal(n.ml, "0px");
    assert.equal(n.main, 232, "the column starts at the rail, not at a classic sidebar's margin");
    assert.equal(n.mark, true, "the mode change was a full load");
    assert.match(n.nav, /\/dashboard\/perch$/, "a fresh navigation entry for the shell page");
    // Back to classic from the avatar sheet.
    await p.ev("window.__shellMark = 1; true");
    await p.click(".shell-avatar");
    await p.until(OPEN_SHEET("shell-avatar"), "the avatar sheet");
    await p.click("#shell-avatar .shell-mode-btn");
    await p.until("!document.body.classList.contains('shell') && !!document.querySelector('.sidebar') && window.__shellMark === undefined", "classic");
    await p.settled();
    const c = await p.ev(`(function(){ return { metas: [...document.querySelectorAll('meta[name="crow-mode"]')].map(function(m){ return m.content; }),
      tabs: document.querySelectorAll('.shell-tabs, #shell-drawer, #shell-avatar').length, styles: ${SHELL_STYLES} }; })()`);
    assert.deepEqual(c.metas, ["classic"]);
    assert.equal(c.tabs, 0);
    assert.equal(c.styles, 0);
  } finally { await p.close(); }

  // A Turbo visit from a classic page to a page the server renders in the shell is a full load.
  const q = await open("/dashboard/memory", { session: "old", mode: "classic" });
  try {
    assert.equal(await q.ev("document.body.classList.contains('shell')"), false);
    await q.ev(`window.__classicMark = 1; document.cookie = ${JSON.stringify(MODE + "=new; path=/")}; Turbo.visit('/dashboard/bot-board'); true`);
    await q.until("location.pathname === '/dashboard/bot-board' && document.body.classList.contains('shell') && document.readyState === 'complete'", "the shell page");
    await q.settled();
    const r = await q.ev(`(function(){ return { mark: window.__classicMark === undefined ? null : window.__classicMark, nav: performance.getEntriesByType('navigation')[0].name,
      metas: document.querySelectorAll('meta[name="crow-mode"]').length, sidebar: !!document.querySelector('.sidebar'), styles: ${SHELL_STYLES} }; })()`);
    assert.equal(r.mark, null, "turbo:load did not render the shell into the classic document");
    assert.match(r.nav, /\/dashboard\/bot-board$/);
    assert.equal(r.metas, 1);
    assert.equal(r.sidebar, false);
    assert.equal(r.styles, 1);
  } finally { await q.close(); }
});

test("a panel that renders its own layout shows classic chrome in new mode, and moving to and from it never stacks styles", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const SHELL_STYLES = "[...document.querySelectorAll('style')].filter(function(s){ return s.textContent.indexOf('body.shell .shell-tabs') !== -1; }).length";
  const p = await open("/dashboard/memory", { width: 1280, height: 800 });
  try {
    assert.equal(await p.ev("document.body.classList.contains('shell')"), true);
    await p.ev("window.__mark = 1; Turbo.visit('/dashboard/selfrender'); true");
    await p.until("!!document.getElementById('selfrender-body') && document.readyState === 'complete'", "the self-rendered panel");
    await p.settled();
    const a = await p.ev(`(function(){ return { shell: document.body.classList.contains('shell'), sidebar: !!document.querySelector('.sidebar'),
      metas: [...document.querySelectorAll('meta[name="crow-mode"]')].map(function(m){ return m.content; }), styles: ${SHELL_STYLES},
      tabs: document.querySelectorAll('.shell-tabs').length, fullLoad: window.__mark === undefined }; })()`);
    assert.deepEqual(a, { shell: false, sidebar: true, metas: ["classic"], styles: 0, tabs: 0, fullLoad: true });
    await p.ev("window.__mark = 2; Turbo.visit('/dashboard/memory'); true");
    await p.until("location.pathname === '/dashboard/memory' && document.body.classList.contains('shell') && document.readyState === 'complete'", "back to the shell");
    await p.settled();
    const b = await p.ev(`(function(){ return { sidebar: !!document.querySelector('.sidebar'), metas: [...document.querySelectorAll('meta[name="crow-mode"]')].map(function(m){ return m.content; }),
      styles: ${SHELL_STYLES}, tabs: document.querySelectorAll('.shell-tabs').length, ml: getComputedStyle(document.querySelector('.main-content')).marginLeft, fullLoad: window.__mark === undefined }; })()`);
    assert.deepEqual(b, { sidebar: false, metas: ["shell"], styles: 1, tabs: 1, ml: "232px", fullLoad: true });
  } finally { await p.close(); }
});

test("the drawer and the avatar sheet open, trap focus, close on Escape and on their close buttons, and focus returns", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/memory");
  try {
    for (const [opener, id] of [[".shell-scope", "shell-drawer"], [".shell-avatar", "shell-avatar"]]) {
      await p.ev(`document.querySelector(${JSON.stringify(opener)}).focus(); true`);
      await p.key("Enter", "Enter", 13);
      await p.until(OPEN_SHEET(id), id);
      assert.equal(await p.ev(`document.getElementById(${JSON.stringify(id)}).matches(':modal')`), true, `${id} is modal`);
      const outside = [], inside = new Set();
      for (let i = 0; i < 16; i++) {
        await p.key("Tab", "Tab", 9);
        const w = await p.ev(`(function(){ var a=document.activeElement; if(!a||a===document.body) return 'body'; return document.getElementById(${JSON.stringify(id)}).contains(a) ? 'in:' + (a.className||a.tagName) + ':' + (a.value||a.getAttribute('href')||'') : (a.className||a.tagName); })()`);
        if (w.startsWith("in:")) inside.add(w); else if (w !== "body") outside.push(w);
      }
      assert.deepEqual(outside, [], `Tab never leaves ${id}`);
      assert.ok(inside.size >= 3, `Tab moves through ${id}'s own controls (${[...inside].join(", ")})`);
      await p.key("Escape", "Escape", 27);
      await p.until(`!document.getElementById(${JSON.stringify(id)}).open`, id + " closed by Escape");
      assert.equal(await p.ev(`document.activeElement === document.querySelector(${JSON.stringify(opener)})`), true, "focus returns to the opener");
      // The close button.
      await p.click(opener);
      await p.until(OPEN_SHEET(id), id + " again");
      await p.click(`#${id} .shell-sheet-close`);
      await p.until(`!document.getElementById(${JSON.stringify(id)}).open`, id + " closed by its close button");
      // Shift+Tab also stays inside.
      await p.click(opener);
      await p.until(OPEN_SHEET(id), id + " a third time");
      for (let i = 0; i < 6; i++) {
        await p.key("Tab", "Tab", 9, 8);
        const w = await p.ev(`(function(){ var a=document.activeElement; if(!a||a===document.body) return 'body'; return document.getElementById(${JSON.stringify(id)}).contains(a) ? 'in' : (a.className||a.tagName); })()`);
        assert.ok(w === "in" || w === "body", `Shift+Tab left ${id} for ${w}`);
      }
      await p.key("Escape", "Escape", 27);
      await p.until(`!document.getElementById(${JSON.stringify(id)}).open`, id + " closed");
      // The close event (and its focus return) lands a task after close(): wait for it.
      await p.until(`document.activeElement === document.querySelector(${JSON.stringify(opener)})`, "focus back on the opener after " + id + " closed");
    }
  } finally { await p.close(); }
});

test("Back after following a drawer link shows no open sheet", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/perch");
  try {
    await p.ev("window.__mark = 1; true");
    await p.click(".shell-scope");
    await p.until(OPEN_SHEET("shell-drawer"), "the drawer");
    await p.click("#shell-drawer .shell-more-row summary");
    await p.click("#shell-drawer .shell-more-item[href='/dashboard/memory']");
    await p.until("location.pathname === '/dashboard/memory'", "Memory");
    await p.settled();
    assert.equal(await p.ev("document.querySelectorAll('dialog[open]').length"), 0);
    await p.ev("history.back(); true");
    await p.until("location.pathname === '/dashboard/perch' && !!document.getElementById('perch-hub-root')", "Back to Chat");
    await p.settled();
    await p.until("document.documentElement.scrollWidth <= innerWidth && document.querySelectorAll('dialog[open]').length === 0", "the restored page to settle");
    assert.equal(await p.ev("window.__mark"), 1, "Turbo visits throughout");
    assert.equal(await p.ev("document.querySelectorAll('dialog[open]').length"), 0, "no sheet is open after Back");
    assert.equal(await p.ev("document.documentElement.scrollWidth <= innerWidth"), true);
    // And the restored page's opener still works.
    await p.click(".shell-scope");
    await p.until(OPEN_SHEET("shell-drawer"), "the drawer from the restored page");
    await p.key("Escape", "Escape", 27);
    await p.until("!document.getElementById('shell-drawer').open", "closed");
  } finally { await p.close(); }
});

test("the header mascot is the user's Ramble bird on Chat, Board and Make, after full loads and Turbo visits alike", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  // The Ramble bird drawn in the header, and the default crow's body hidden.
  const RAMBLE = "(function(){ var b=document.querySelector('#crow-tama #crow-tama-bird'), g=document.querySelector('#crow-tama .crow-body-group'); return !!(b && b.querySelector('*')) && !!g && getComputedStyle(g).display === 'none'; })()";
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    // A full load of each tab.
    for (const path of ["/dashboard/perch", "/dashboard/board", "/dashboard/make"]) {
      const p = await open(path, { width, height });
      try {
        await p.until(RAMBLE, `the Ramble bird in the header on a full load of ${path} (${width})`);
      } finally { await p.close(); }
    }
    // Turbo visits Chat -> Board -> Make -> Chat: the new header is the user's bird every time.
    const p = await open("/dashboard/perch", { width, height });
    try {
      await p.until(RAMBLE, "the Ramble bird on Chat");
      await p.ev("window.__mascotMark = 1; true");
      for (const path of ["/dashboard/board", "/dashboard/make", "/dashboard/perch"]) {
        await p.click(`.shell-tab[href='${path}']`);
        await p.until(`location.pathname === ${JSON.stringify(path)}`, path);
        await p.settled();
        await p.until(RAMBLE, `the Ramble bird after a Turbo visit to ${path} (${width})`, 3000);
      }
      assert.equal(await p.ev("window.__mascotMark"), 1, "those were Turbo visits, not full loads");
    } finally { await p.close(); }
  }
});

test("the header bird's long-press still opens Talk to Crow in the shell; a tap opens the tray", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const p = await open("/dashboard/memory", { width, height });
    try {
      assert.equal(await p.ev("document.body.classList.contains('shell')"), true);
      assert.equal(await p.ev("!!document.querySelector('#crow-bird-btn[data-crow-talk]') && !!document.getElementById('crow-talk-row')"), true, "the bird is armed");
      await assertTargets(p, [["#crow-bird-btn", 1, "the bird"]], "talk");
      await p.hold("#crow-bird-btn", 800);
      await p.until("document.getElementById('crow-talk-overlay').classList.contains('active') && !!document.querySelector('#crow-talk-overlay iframe')", "the Talk overlay");
      assert.match(await p.ev("document.querySelector('#crow-talk-overlay iframe').getAttribute('src')"), /\/display\/session/);
      assert.equal(await p.ev("getComputedStyle(document.getElementById('crow-dropdown')).display === 'none' || !document.getElementById('crow-dropdown').classList.contains('open')"), true, "the long-press did not also open the tray");
      await p.key("Escape", "Escape", 27);
      await p.until("!document.getElementById('crow-talk-overlay').classList.contains('active')", "the overlay to close");
      await p.click("#crow-bird-btn");
      await p.until("document.getElementById('crow-bird-btn').getAttribute('aria-expanded') === 'true'", "the tray");
    } finally { await p.close(); }
  }
});

test("screenshots for review (only with SHELL_SHOTS_DIR)", async (ctx) => {
  const out = process.env.SHELL_SHOTS_DIR;
  if (!chrome || !out) return ctx.skip("set SHELL_SHOTS_DIR to save screenshots");
  mkdirSync(out, { recursive: true });
  const shot = async (p, name) => {
    const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(out, name), Buffer.from(data, "base64"));
  };
  for (const [name, width, height] of [["phone", 390, 844], ["desktop", 1280, 800]]) {
    for (const dark of [false, true]) {
      const theme = dark ? "dark" : "light";
      const p = await open("/dashboard/perch", { width, height, dark });
      try {
        await p.until("!!document.querySelector('#perch-list-body .perch-row, #perch-list-body [data-sid], #perch-list-body li')", "the session list", 5000).catch(() => {});
        await p.settled();
        await shot(p, `shell-${name}-chat-${theme}-en.png`);
        await p.click(".shell-scope");
        await p.until(OPEN_SHEET("shell-drawer"), "the drawer");
        await p.ev(TWO_FRAMES);
        await shot(p, `shell-${name}-drawer-${theme}-en.png`);
        await p.key("Escape", "Escape", 27);
        await p.click(".shell-avatar");
        await p.until(OPEN_SHEET("shell-avatar"), "the avatar sheet");
        await p.ev(TWO_FRAMES);
        await shot(p, `shell-${name}-avatar-${theme}-en.png`);
      } finally { await p.close(); }
      if (width === 390) {
        const c = await open("/dashboard/perch#" + SID, { width, height, dark });
        try {
          await c.until("document.body.getAttribute('data-view') === 'chat'", "the chat");
          await c.settled();
          await shot(c, `shell-${name}-open-chat-${theme}-en.png`);
        } finally { await c.close(); }
      }
      const b = await open("/dashboard/bot-board", { width, height, dark });
      try { await b.settled(); await shot(b, `shell-${name}-board-${theme}-en.png`); } finally { await b.close(); }
    }
  }
  assert.ok(existsSync(join(out, "shell-desktop-chat-dark-en.png")));
});
