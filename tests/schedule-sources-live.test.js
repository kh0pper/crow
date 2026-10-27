// Schedule panel PR 3: the read-only sources in a real browser, on the production layout, at
// phone 412×915 (also at the largest text size) and wide 1280×900, en and es, light and dark.
// Set SCHEDULE_SHOTS_DIR to also save screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const scratch = mkdtempSync(join(tmpdir(), "schedule-src-live-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
process.env.CROW_BOX_LEDGER_PATH = join(scratch, "ledger.md");
process.env.CROW_HOST_TIMERS_DIR = join(scratch, "timers");
process.env.CROW_BOX_RESERVATION_PATH = join(scratch, "hold.json");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
mkdirSync(process.env.CROW_HOST_TIMERS_DIR, { recursive: true });
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe" });

const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
const { playerBarHtml } = await import("../servers/gateway/dashboard/shared/player.js");
const { default: panel, _setBotGateForTest } = await import("../servers/gateway/dashboard/panels/schedule.js");
const { SCHEMA } = await import("../servers/gateway/schedule-sources/host-timers.js");
const { createHash } = await import("node:crypto");
_setBotGateForTest({ engine: () => "ready", runtimeOn: async () => true });
const db = createDbClient(join(process.env.CROW_DATA_DIR, "crow.db"));

const MIN = 60_000, HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
const hm = (ms) => iso(ms).slice(11, 16);

async function fixture() {
  const now = Date.now();
  await db.batch(["DELETE FROM schedules", "DELETE FROM schedule_runs", "DELETE FROM dashboard_settings WHERE key IN ('instance_timezone','feature_flags')"]);
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC')", args: [] });
  await db.execute({ sql: "INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)", args: [createHash("sha256").update("good").digest("hex"), iso(now + 86_400_000)] });
  await db.execute({ sql: "INSERT INTO schedules (task, cron_expression, next_run, enabled) VALUES ('reminder:Stretch and refill the water bottle', '0 9 * * *', ?, 1)", args: [iso(now + 5 * HOUR)] });
  const soon = now + 3 * HOUR, tomorrow = now + 26 * HOUR, past = now - 30 * HOUR, running = now - 20 * MIN;
  writeFileSync(process.env.CROW_BOX_LEDGER_PATH, [
    "## Reservations", "", "| when | what | owner | how | clear |", "|---|---|---|---|---|",
    `| **${ymd(running)} ${hm(running)} → cap 2 h (CPU only)** | **Render the turntable stills for the review board** | alex (render lane) | a capped unit | when done |`,
    `| **${ymd(soon)} ${hm(soon)} → cap 45 min** | **Full test suite on the shared box** | alex | a unit | when done |`,
    `| **${ymd(tomorrow)} ${hm(tomorrow)} → 04:00** | **Overnight benchmark sweep with a very long description that has to wrap on a phone** | second user | a deadman | at 04:00 |`,
    `| **${ymd(past)} ${hm(past)} → cap 30 min** | **Forgotten window** | alex | a unit | done |`,
    "| 2026-09-10 10:15 → ONGOING (standing service) | Speech service on the second box | alex | a service | never |",
  ].join("\n"));
  writeFileSync(process.env.CROW_BOX_RESERVATION_PATH, JSON.stringify({ owner: "benchmark-window", reason: "nightly long-context benchmark", started_at: iso(now - HOUR), expires_at: iso(now + HOUR) }));
  writeFileSync(join(process.env.CROW_HOST_TIMERS_DIR, "box-1.json"), JSON.stringify({
    schema: SCHEMA, host: "box-1", tz: "UTC", collected_at: iso(now - 5 * MIN),
    timers: [
      { id: "user:model-watch-hot.timer", kind: "systemd-user", name: "model-watch-hot", schedule: "every 2 h", next: iso(now + 2 * HOUR), last: iso(now), last_result: "success" },
      { id: "user:upstream-staleness.timer", kind: "systemd-user", name: "upstream-staleness", schedule: "daily", next: iso(now + 20 * HOUR), last: iso(now - 4 * HOUR), last_result: "exit-code" },
      { id: "cron:2", kind: "cron", name: "/opt/lab/collect-health.sh --all", schedule: "*/15 * * * *" },
    ],
  }));
  writeFileSync(join(process.env.CROW_HOST_TIMERS_DIR, "box-2.json"), JSON.stringify({
    schema: SCHEMA, host: "box-2", tz: "UTC", collected_at: iso(now - 3 * HOUR),
    timers: [{ id: "system:backup.timer", kind: "systemd-system", name: "backup", schedule: "daily", next: iso(now + 9 * HOUR), last: iso(now - 15 * HOUR), last_result: "success" }],
  }));
}

const s = {};
let chrome;
before(async () => {
  await fixture();
  const app = express();
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use("/dashboard", express.urlencoded({ extended: false }));
  app.use("/dashboard", (req, res, next) => { if (/crow_session=good/.test(req.headers.cookie || "")) req.dashboardSession = "good"; next(); });
  app.use("/dashboard", csrfMiddleware);
  app.get("/login", (req, res) => { res.setHeader("set-cookie", ["crow_session=good; Path=/", "crow_csrf=tok123; Path=/"]); res.end("ok"); });
  app.all("/dashboard/schedule", async (req, res, next) => {
    const lang = /lang=es/.test(req.headers.cookie || "") ? "es" : "en";
    const layout = (opts) => renderLayout({ ...opts, activePanel: "schedule", panels: [], lang, afterContent: playerBarHtml(lang) });
    try {
      const html = await panel.handler(req, res, { db, layout, lang });
      if (html !== undefined && !res.headersSent) res.type("html").send(html);
    } catch (e) { next(e); }
  });
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.base = `http://127.0.0.1:${s.http.address().port}`;
  chrome = await startHeadlessChrome();
});
after(async () => { _setBotGateForTest(null); s.http?.closeAllConnections?.(); s.http?.close(); if (chrome) await chrome.close(); try { db.close(); } catch {} rmSync(scratch, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(100); } return null; }

async function open(path, { width = 412, height = 915, lang = "en", dark = false, textSize = null } = {}) {
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
  const ev = async (expression) => { const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (o.exceptionDetails) throw new Error(JSON.stringify(o.exceptionDetails)); return o.result.value; };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await send("Page.navigate", { url: s.base + "/login" }); await sleep(150);
  await ev(`document.cookie = "lang=${lang}; path=/"; true`);
  await send("Page.navigate", { url: s.base + path });
  assert.ok(await waitFor(async () => (await ev("!!document.querySelector('.sc-page') && !!window.Turbo && document.readyState === 'complete'")) === true), "page + Turbo loaded");
  if (textSize) await ev(`document.documentElement.setAttribute('data-text-size', ${JSON.stringify(textSize)}); true`);
  await sleep(150);
  const key = async (k, code, keyCode, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode });
  };
  return { send, ev, key, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const noOverflow = "document.documentElement.scrollWidth <= window.innerWidth + 1";
const openAllFolds = "document.querySelectorAll('.sc-fold').forEach(function (d) { d.open = true; }); true";
const smallTargets = `(() => { const out = [];
  for (const el of document.querySelectorAll('.sc-page button, .sc-page a, .sc-page summary, .sc-page input, .sc-page [role=switch]')) {
    if (el.closest('.sc-vh') || el.closest('[hidden]') || el.closest('dialog')) continue;
    if (el.type === 'hidden') continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.height < 43.5) out.push((el.className || el.tagName) + ':' + (el.textContent || '').trim().slice(0, 30) + ':' + Math.round(r.height));
  } return out; })()`;
// Nothing may stick out of its card (long ledger text, long commands) at any width.
const overflowing = `(() => { const out = []; for (const el of document.querySelectorAll('.sc-page *')) { const r = el.getBoundingClientRect(); if (r.width && r.right > window.innerWidth + 1) out.push(el.className || el.tagName); } return out.slice(0, 5); })()`;

for (const lang of ["en", "es"]) {
  test(`phone 412 (${lang}): read-only sources show, no overflow, 44px targets, at the default and the largest text size`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    for (const textSize of [null, "xlarge"]) {
      const p = await open("/dashboard/schedule", { lang, textSize });
      try {
        await p.ev(openAllFolds); await sleep(50);
        assert.equal(await p.ev(noOverflow), true, `no horizontal overflow (${textSize || "default"})`);
        assert.deepEqual(await p.ev(overflowing), [], `nothing sticks out (${textSize || "default"})`);
        assert.deepEqual(await p.ev(smallTargets), [], `every target ≥ 44px (${textSize || "default"})`);
        const chips = await p.ev("[...document.querySelectorAll('.sc-filter')].map((a) => a.textContent)");
        assert.deepEqual(chips, lang === "es" ? ["Todo", "De Crow", "Equipo", "Máquinas"] : ["All", "Crow", "Box", "Machines"]);
        assert.ok(await p.ev("document.querySelectorAll('.sc-row-ro').length") >= 6, "read-only rows");
        assert.equal(await p.ev("document.querySelectorAll('.sc-row-ro a, .sc-row-ro form, .sc-row-ro button').length"), 0, "no controls on read-only rows");
        assert.match(await p.ev("document.querySelector('.sc-attn').textContent"), lang === "es" ? /Datos de máquina antiguos: box-2/ : /Machine data is old: box-2/);
        assert.match(await p.ev("document.querySelector('.sc-agenda').textContent"), lang === "es" ? /solo lectura/ : /read-only/);
      } finally { await p.close(); }
    }
  });
}

test("copy button: hidden without the script, shown with it; it copies and says so; its name carries the problem", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/schedule");
  try {
    await p.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: s.base }).catch(() => {});
    const b = "document.querySelector('[data-sc-copy]')";
    assert.equal(await p.ev(`${b}.hidden`), false, "the script shows it");
    assert.equal(await p.ev(`${b}.getAttribute('data-sc-copy')`), "systemctl --user status upstream-staleness.timer");
    assert.match(await p.ev(`${b}.textContent`), /Copy the check command.*upstream-staleness on box-1/);
    assert.equal(await p.ev("[...document.querySelectorAll('.sc-copy-text')].map((c) => c.textContent).includes('systemctl --user status upstream-staleness.timer')"), true, "the command is on the page as text too");
    await p.ev(`${b}.focus(); true`);
    await p.key("Enter", "Enter", 13, "\r");
    const msg = await waitFor(() => p.ev("document.getElementById('sc-toast').textContent || null"));
    assert.ok(msg === "Copied." || /Couldn.t copy/.test(msg), msg);
  } finally { await p.close(); }
});

test("wide 1280: the filter chips narrow the agenda, the strip stays whole", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/schedule", { width: 1280, height: 900 });
  try {
    await p.ev("[...document.querySelectorAll('.sc-filter')].find((a) => a.textContent === 'Box').click(); true");
    assert.ok(await waitFor(async () => (await p.ev("location.search")) === "?show=box"));
    await waitFor(async () => (await p.ev("document.querySelector('.sc-filter[aria-current=true]').textContent")) === "Box");
    const agenda = await p.ev("document.querySelector('.sc-agenda').textContent");
    assert.match(agenda, /Full test suite/);
    assert.doesNotMatch(agenda, /Stretch and refill|model-watch-hot/);
    assert.match(await p.ev("document.querySelector('.sc-attn').textContent"), /upstream-staleness/);
    assert.equal(await p.ev(noOverflow), true);
    assert.deepEqual(await p.ev(smallTargets), []);
  } finally { await p.close(); }
});

test("dark mode: read-only rows and the copy text follow the theme", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const css = "(() => [getComputedStyle(document.querySelector('.sc-day')).backgroundColor, getComputedStyle(document.querySelector('.sc-copy-text')).backgroundColor])()";
  const l = await open("/dashboard/schedule"); const light = await l.ev(css); await l.close();
  const d = await open("/dashboard/schedule", { dark: true }); const dark = await d.ev(css); await d.close();
  assert.notEqual(light[0], dark[0]);
  assert.notEqual(light[1], dark[1]);
});

test("screenshots for review (only with SCHEDULE_SHOTS_DIR)", async (ctx) => {
  const dir = process.env.SCHEDULE_SHOTS_DIR;
  if (!chrome || !dir) return ctx.skip("set SCHEDULE_SHOTS_DIR to save screenshots");
  mkdirSync(dir, { recursive: true });
  for (const [name, path, width, height, folds, textSize] of [
    ["phone", "/dashboard/schedule", 412, 915, false, null],
    ["phone-agenda", "/dashboard/schedule", 412, 915, false, null],
    ["phone-machines", "/dashboard/schedule?show=machines", 412, 915, true, null],
    ["phone-xlarge", "/dashboard/schedule", 412, 915, false, "xlarge"],
    ["wide", "/dashboard/schedule", 1280, 900, true, null],
  ]) {
    for (const dark of [false, true]) for (const lang of ["en", "es"]) {
      const p = await open(path, { width, height, dark, lang, textSize });
      try {
        if (folds) await p.ev(openAllFolds);
        // Past the strip: the agenda (and, for the machines view, its open folds).
        if (name === "phone-agenda" || name === "phone-machines") await p.ev("document.querySelector('.sc-toolbar').scrollIntoView(); true");
        await sleep(300);
        const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(dir, `schedule3-${name}-${dark ? "dark" : "light"}-${lang}.png`), Buffer.from(data, "base64"));
      } finally { await p.close(); }
    }
  }
  assert.ok(existsSync(join(dir, "schedule3-phone-dark-en.png")));
});
