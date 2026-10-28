/**
 * The Settings › LLM providers list at phone width, in a real browser.
 *
 * The REAL dashboard router is mounted over a scratch CROW_DATA_DIR holding a
 * handful of provider rows shaped like a real fleet's: long monospace ids,
 * two rows on one service (so each carries the "Same service as …" badge), a
 * cloud row and a long model list. A private headless Chrome
 * (tests/fixtures/headless-chrome.mjs) opens /dashboard/settings?section=llm
 * at 390×844, after the web font is in, and checks:
 *   - neither the page nor the providers list scrolls sideways;
 *   - every badge sits inside the viewport (none cut off at the right edge);
 *   - a row is compact: no cell is much taller than what it holds (the
 *     phone bug was one squeezed column wrapping and every other cell in the
 *     row standing tall and empty beside it), and the monospace ids are not
 *     oversized.
 * A wider desktop still gets the table, head row and all.
 * Set SETTINGS_SHOTS_DIR to also save the phone and desktop screenshots.
 *
 * Network: this process stands in for tailscaled (actAsServe); Chrome sends
 * the headers Serve writes on a loopback socket from the same uid.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "settings-llm-phone-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-settings-llm-phone");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;

let server, base, chrome;

const PROVIDERS = [
  ["crow-chat-qwen3.6-35b-a3b", "http://127.0.0.1:8003/v1", null, "local", null,
    [{ id: "qwen3.6-35b-a3b" }, { id: "qwen3.6-35b-a3b-thinking" }]],
  ["crow-swap-qwen3.6-35b-a3b-long", "http://127.0.0.1:8003/v1", null, "local", null,
    [{ id: "qwen3.6-35b-a3b" }]],
  ["crow-voice-qwen3.5-4b", "http://127.0.0.1:8011/v1", null, "local", null, [{ id: "qwen3.5-4b" }]],
  ["together-cloud-provider", "https://api.example.com/v1", "sk-test-not-a-key", "cloud", "openai-compatible",
    [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, { id: "deepseek-ai/DeepSeek-V3.1" }, { id: "Qwen/Qwen3-235B-A22B-Instruct" }]],
];

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  const add = c.prepare("INSERT INTO providers (id, base_url, api_key, host, provider_type, models) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [id, url, key, host, type, models] of PROVIDERS) add.run(id, url, key, host, type, JSON.stringify(models));
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
  chrome = await startHeadlessChrome();
});

after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = "!!window.Turbo && document.readyState === 'complete' && !!document.querySelector('.llm-providers-table') && !document.documentElement.hasAttribute('aria-busy')";
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";

async function open(path, { width = 390, height = 844 } = {}) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {}); };
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
  });
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
      await sleep(60);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.com") });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  for (const ck of [{ name: "crow_session", value: "new-sess" }, { name: "crow_csrf", value: "tok" }]) {
    await send("Network.setCookie", { ...ck, url: base, path: "/" });
  }
  await send("Page.navigate", { url: base + path });
  await until(READY, "the providers list");
  // Text widths move when the web font arrives: measure after it.
  await ev("document.fonts.ready.then(function(){ return 1; })");
  await ev(TWO_FRAMES);
  const shot = async (name) => {
    if (!process.env.SETTINGS_SHOTS_DIR) return;
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(process.env.SETTINGS_SHOTS_DIR, name + ".png"), Buffer.from(data, "base64"));
  };
  return { ev, errors, shot, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); } };
}

const MEASURE = `(function(){
  var vw = innerWidth, tbl = document.querySelector('.llm-providers-table'), wrap = tbl.closest('.table-scroll');
  var rows = [].map.call(tbl.querySelectorAll('tbody tr'), function(tr){
    var r = tr.getBoundingClientRect();
    var id = tr.querySelector('.llm-cell-id');
    var cells = [].map.call(tr.children, function(td){ var b = td.getBoundingClientRect(); return (td.className || 'td') + ':' + Math.round(b.width) + 'x' + Math.round(b.height); });
    // The emptiest cell: its box less the height of what it holds.
    var slack = 0;
    [].forEach.call(tr.children, function(td){
      var rg = document.createRange(); rg.selectNodeContents(td);
      var inner = rg.getBoundingClientRect().height, cs = getComputedStyle(td);
      var box = td.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      slack = Math.max(slack, Math.round(box - inner));
    });
    return { h: Math.round(r.height), left: r.left, right: r.right, idFont: parseFloat(getComputedStyle(id).fontSize), id: id.textContent.trim().slice(0, 40), cells: cells, slack: slack };
  });
  var badges = [].map.call(tbl.querySelectorAll('tbody span[style*="radius-pill"]'), function(b){
    var r = b.getBoundingClientRect();
    return { text: b.textContent.trim().slice(0, 48), left: Math.round(r.left), right: Math.round(r.right) };
  });
  return { vw: vw, sw: document.scrollingElement.scrollWidth,
    wrapSw: wrap ? wrap.scrollWidth : null, wrapCw: wrap ? wrap.clientWidth : null,
    tableRight: tbl.getBoundingClientRect().right, rows: rows, badges: badges };
})()`;

test("390×844: the LLM providers list fits the phone: no sideways scroll, badges on screen, compact rows", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/settings?section=llm&tab=providers");
  try {
    const m = await p.ev(MEASURE);
    ctx.diagnostic("phone: " + JSON.stringify(m));
    await p.ev("document.querySelector('.llm-providers-table').scrollIntoView(); true");
    await p.shot("settings-llm-phone");
    assert.equal(m.rows.length, PROVIDERS.length, "every provider is listed");
    assert.ok(m.sw <= m.vw, `the page does not scroll sideways (scrollingElement ${m.sw} ≤ innerWidth ${m.vw})`);
    if (m.wrapSw != null) assert.ok(m.wrapSw <= m.wrapCw, `the list does not scroll sideways inside its wrapper (${m.wrapSw} ≤ ${m.wrapCw})`);
    assert.ok(m.tableRight <= m.vw, `the list ends on screen (${m.tableRight} ≤ ${m.vw})`);
    const sameService = m.badges.filter((b) => /crow-/.test(b.text) && b.text !== "");
    assert.ok(m.badges.length >= PROVIDERS.length + 2, `the host and same-service badges are there (${m.badges.length})`);
    assert.ok(sameService.length >= 2, "both rows on one service carry the Same service badge");
    for (const b of m.badges) assert.ok(b.left >= 0 && b.right <= m.vw, `badge "${b.text}" is on screen (${b.left}–${b.right} of ${m.vw})`);
    for (const r of m.rows) {
      assert.ok(r.right <= m.vw, `row ${r.id} ends on screen (${r.right} ≤ ${m.vw})`);
      assert.ok(r.h <= 260, `row ${r.id} is compact (${r.h} px ≤ 260)`);
      assert.ok(r.slack <= 12, `row ${r.id} has no mostly-empty cell: its emptiest cell is ${r.slack} px taller than its content (≤ 12)`);
      assert.ok(r.idFont <= 13, `row ${r.id}'s monospace id is not oversized (${r.idFont} px ≤ 13)`);
    }
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { await p.close(); }
});

test("1280×800: the providers list is still a table with its head row", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/settings?section=llm&tab=providers", { width: 1280, height: 800 });
  try {
    const m = await p.ev(MEASURE);
    ctx.diagnostic("desktop: " + JSON.stringify(m));
    await p.shot("settings-llm-desktop");
    assert.equal(await p.ev("getComputedStyle(document.querySelector('.llm-providers-table thead')).display"), "table-header-group");
    assert.equal(await p.ev("getComputedStyle(document.querySelector('.llm-providers-table tbody tr')).display"), "table-row");
    assert.ok(m.sw <= m.vw, `no sideways page scroll (${m.sw} ≤ ${m.vw})`);
  } finally { await p.close(); }
});
