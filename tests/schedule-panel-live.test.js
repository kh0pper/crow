// Schedule panel PR 2: the page in a real browser, on the production layout (Turbo 8 + CSRF + the
// gateway's body parser), at phone 412×915 (also at the largest text size) and wide 1280×900, en
// and es, light and dark. Set SCHEDULE_SHOTS_DIR to also save phone, phone-detail and wide
// screenshots in light + dark, en + es.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const scratch = mkdtempSync(join(tmpdir(), "schedule-live-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe" });

const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
const { playerBarHtml } = await import("../servers/gateway/dashboard/shared/player.js");
const { default: panel, schedulePreview, _setBotGateForTest } = await import("../servers/gateway/dashboard/panels/schedule.js");
const { cronNext, cronPrev, hostZone } = await import("../servers/shared/schedule-core.js");
const { createHash } = await import("node:crypto");
// Bots run here (the strip shows the runner problem, not "engine missing" on a box without pi).
_setBotGateForTest({ engine: () => "ready", runtimeOn: async () => true });
const db = createDbClient(join(process.env.CROW_DATA_DIR, "crow.db"));

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const ids = {};

async function fixture() {
  await db.batch([
    "DELETE FROM schedules", "DELETE FROM schedule_runs", "DELETE FROM bot_jobs", "DELETE FROM pi_bot_defs",
    "DELETE FROM dashboard_settings WHERE key IN ('instance_timezone','feature_flags','notification_prefs')",
  ]);
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC'), ('feature_flags', ?)", args: [JSON.stringify({ bot_runtime: true })] });
  // The test login is a local password session, as dashboard/auth.js stores one.
  await db.execute({ sql: "INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)", args: [createHash("sha256").update("good").digest("hex"), new Date(Date.now() + 86_400_000).toISOString()] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('lab-triage', 'Lab triage', '{}', 1), ('inbox-helper', 'Inbox helper', '{}', 1)", args: [] });
  const now = Date.now();
  const seed = async (key, task, cron, next, extra = {}) => {
    const r = await db.execute({
      sql: "INSERT INTO schedules (task, cron_expression, next_run, tz, enabled, description, last_run) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [task, cron, next, extra.tz ?? null, extra.enabled ?? 1, extra.description ?? null, extra.lastRun ?? null],
    });
    ids[key] = Number(r.lastInsertRowid);
  };
  const next = (cron, zone = "UTC") => iso(cronNext(cron, zone, now));
  await seed("stretch", "reminder:Stretch and refill the water bottle", "0 9 * * *", next("0 9 * * *"));
  await seed("bins", "reminder:Take the bins out", "0 19 * * 2", next("0 19 * * 2"));
  await seed("standup", "reminder:Stand-up call with the design group", "30 8 * * 1-5", next("30 8 * * 1-5", "America/Chicago"), { tz: "America/Chicago" });
  await seed("call", "reminder:Call the dentist back about Thursday", "@once", iso(now + 2 * DAY + 3 * HOUR));
  await seed("rent", "reminder:Pay the rent", "0 9 1 * *", next("0 9 1 * *"));
  await seed("briefing", "media:briefing", "0 7 * * *", next("0 7 * * *"));
  // Bot routines run in the host zone (the bot ticker has no zone yet), so they are seeded in it.
  await seed("triage", "pipeline:botcron:lab-triage", "0 8 * * *", iso(cronPrev("0 8 * * *", hostZone(), now - 10 * MIN)), { description: JSON.stringify({ goal: "Sort the overnight alerts and post a summary", label: "Morning lab triage" }) });
  await seed("inbox", "pipeline:botcron:inbox-helper", "*/30 * * * *", next("*/30 * * * *", hostZone()), { description: JSON.stringify({ goal: "File new mail" }) });
  await seed("noisy", "check the logs", "*/5 * * * *", null, { enabled: 0 });
  await seed("old", "reminder:Water the balcony plants", "0 18 * * *", next("0 18 * * *"), { enabled: 0 });
  await seed("done", "reminder:Pick up the parcel", "@once", iso(now - DAY), { enabled: 0, lastRun: iso(now - DAY + 10_000) });
  const lastNine = cronPrev("0 9 * * *", "UTC", now - DAY);
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, missed_count, detail) VALUES (?, ?, 'missed', 3, ?)", args: [ids.stretch, iso(lastNine - 2 * DAY), JSON.stringify({ last_missed: iso(lastNine) })] });
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, ran_at, status) VALUES (?, ?, ?, 'ok')", args: [ids.stretch, iso(lastNine - 3 * DAY), iso(lastNine - 3 * DAY + 20_000)] });
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, source, detail) VALUES (?, 'upgrade:0009', 'paused', 'upgrade', ?)", args: [ids.noisy, JSON.stringify({ reason: "frequent", every_min: 5 })] });
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
  app.get("/dashboard/schedule/preview", (req, res, next) => schedulePreview(req, res, db).catch(next));
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
  for (const el of document.querySelectorAll('.sc-page button, .sc-page a, .sc-page summary, .sc-page input, .sc-page [role=switch], dialog[open] button, dialog[open] a, dialog[open] input, dialog[open] summary')) {
    if (el.closest('.sc-vh') || el.closest('[hidden]') || (el.closest('dialog') && !el.closest('dialog').open)) continue;
    if (el.type === 'hidden') continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.type === 'radio') continue; // the radio sits inside its 44px label
    if (r.height < 43.5) out.push((el.className || el.tagName) + ':' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) + ':' + Math.round(r.height));
  } return out; })()`;

for (const lang of ["en", "es"]) {
  test(`phone 412 (${lang}): no overflow and 44px targets, at the default and the largest text size; strip first`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    for (const textSize of [null, "xlarge"]) {
      const p = await open("/dashboard/schedule", { lang, textSize });
      try {
        await p.ev(openAllFolds); await sleep(50);
        assert.equal(await p.ev(noOverflow), true, `no horizontal overflow (${textSize || "default"})`);
        assert.deepEqual(await p.ev(smallTargets), [], `every target ≥ 44px (${textSize || "default"})`);
        const order = await p.ev("(() => { const a = document.querySelector('.sc-attn').getBoundingClientRect().top, b = document.querySelector('.sc-agenda').getBoundingClientRect().top; return a < b; })()");
        assert.equal(order, true, "the problems strip is above the agenda");
        assert.ok(await p.ev("document.querySelectorAll('.sc-attn-item').length") >= 3, "the fixture's problems show");
        // Strip fix buttons go full width under their text on a phone.
        const full = await p.ev("(() => { const b = document.querySelector('.sc-attn-acts .btn'); const item = b.closest('.sc-attn-item'); return b.getBoundingClientRect().width >= item.getBoundingClientRect().width - 40; })()");
        assert.equal(full, true, "strip buttons are full width below 480px");
      } finally { await p.close(); }
    }
  });
}

test("?id=: exactly one detail, under its row on a phone (focus on its heading) and to the right on wide", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const id = ids.stretch;
  const geo = `(() => { const d = document.querySelectorAll('.sc-detail'); const row = document.querySelector('#sc-${id} .sc-hit').getBoundingClientRect(); const r = d[0] ? d[0].getBoundingClientRect() : null; return { n: d.length, rowBottom: row.bottom, rowRight: row.right, rowLeft: row.left, top: r && r.top, left: r && r.left, focused: document.activeElement && document.activeElement.id }; })()`;
  const phone = await open(`/dashboard/schedule?id=crow:${id}#sc-${id}`);
  try {
    const g = await phone.ev(geo);
    assert.equal(g.n, 1);
    assert.ok(g.top >= g.rowBottom - 1, `under its row (${g.top} vs ${g.rowBottom})`);
    assert.equal(g.focused, "sc-detail-h", "focus lands on the opened detail");
    assert.equal(await phone.ev(noOverflow), true);
    assert.deepEqual(await phone.ev(smallTargets), []);
    assert.match(await phone.ev("document.querySelector('.sc-runs').textContent"), /Missed 3 runs/);
    assert.equal(await phone.ev("document.querySelectorAll('.sc-detail .sc-next li').length"), 3);
  } finally { await phone.close(); }
  const wide = await open(`/dashboard/schedule?id=crow:${id}`, { width: 1280, height: 900 });
  try {
    const g = await wide.ev(geo);
    assert.equal(g.n, 1);
    assert.ok(g.left >= g.rowRight - 1, `right of the agenda (${g.left} vs ${g.rowRight})`);
    assert.equal(await wide.ev(noOverflow), true);
    assert.deepEqual(await wide.ev(smallTargets), []);
  } finally { await wide.close(); }
});

test("with the player bar shown, the toast and the wide pane stay above it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const bar = 72;
  const p = await open("/dashboard/schedule?done=deleted");
  try {
    await p.ev(`document.documentElement.style.setProperty('--crow-player-h', '${bar}px'); true`);
    assert.ok(await waitFor(() => p.ev("(document.getElementById('sc-toast') || {}).textContent")), "toast text inserted after load");
    const b = await p.ev("document.getElementById('sc-toast').getBoundingClientRect().bottom");
    assert.ok(b <= 915 - bar, `toast bottom ${b} ≤ bar top ${915 - bar}`);
  } finally { await p.close(); }
  const w = await open(`/dashboard/schedule?id=crow:${ids.stretch}`, { width: 1280, height: 700 });
  try {
    await w.ev(`document.documentElement.style.setProperty('--crow-player-h', '${bar}px'); true`);
    await sleep(100);
    const b = await w.ev("document.querySelector('.sc-detail').getBoundingClientRect().bottom");
    assert.ok(b <= 700 - bar, `pane bottom ${b} ≤ bar top ${700 - bar}`);
  } finally { await w.close(); }
});

test("keyboard: the strip's fixes come first; a row opens its detail; Escape closes it and focus returns to the row", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/schedule", { width: 1280, height: 900 });
  try {
    await p.ev("document.querySelector('.sc-attn h2').setAttribute('tabindex','-1'); document.querySelector('.sc-attn h2').focus(); true");
    const seen = [];
    for (let i = 0; i < 6; i++) { await p.key("Tab", "Tab", 9); seen.push(await p.ev("(document.activeElement.className || document.activeElement.tagName) + '|' + (document.activeElement.textContent || '').trim().slice(0, 40)")); }
    assert.match(seen[0], /sc-attn-name/, seen.join(" / "));
    assert.match(seen[1], /sc-act/, "then its first fix");
    // Open a row by keyboard.
    await p.ev(`document.querySelector('#sc-${ids.bins} .sc-hit').focus(); true`);
    await p.key("Enter", "Enter", 13, "\r");
    assert.ok(await waitFor(async () => (await p.ev("document.activeElement && document.activeElement.id")) === "sc-detail-h"), "the detail heading has focus");
    await p.key("Escape", "Escape", 27);
    assert.ok(await waitFor(async () => (await p.ev(`!document.getElementById('sc-detail') && document.activeElement === document.querySelector('#sc-${ids.bins} .sc-hit')`)) === true), "closed, and focus is back on the row");
  } finally { await p.close(); }
});

test("the switch: Space pauses a reminder, the page comes back with it paused and a status", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open(`/dashboard/schedule?id=crow:${ids.bins}`);
  try {
    await p.ev("document.querySelector('.sc-detail [role=switch]').focus(); true");
    assert.equal(await p.ev("document.querySelector('.sc-detail [role=switch]').getAttribute('aria-checked')"), "true");
    await p.key(" ", "Space", 32, " ");
    const st = await waitFor(async () => p.ev("(() => { const b = document.querySelector('.sc-detail [role=switch]'); const n = document.getElementById('sc-done'); return b && b.getAttribute('aria-checked') === 'false' && n ? n.textContent : null; })()"));
    assert.equal(st, "Paused.");
  } finally { await p.close(); await fixture(); }
});

test("create sheet: a modal; typing words shows the read-back and 3 runs live; a refused create re-opens it filled in", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/schedule");
  try {
    await p.ev("document.querySelector('.sc-new').click(); true");
    assert.equal(await p.ev("document.getElementById('sc-create').matches(':modal')"), true);
    assert.equal(await p.ev("document.activeElement.name"), "text");
    assert.ok(await p.ev("document.querySelector('[data-sc-tz]').value.length > 0"), "the browser's zone is filled in");
    await p.ev("const w = document.querySelector('#sc-create [name=when]'); w.value = 'every weekday at 8'; w.dispatchEvent(new Event('input')); true");
    const live = await waitFor(async () => p.ev("(() => { const b = document.getElementById('sc-preview'); return b.querySelectorAll('.sc-next li').length === 3 ? b.textContent : null; })()"));
    assert.match(live, /Every weekday at 8:00 AM/);
    assert.equal(await p.ev("document.getElementById('sc-preview').getAttribute('aria-live')"), "polite");
    assert.deepEqual(await p.ev(smallTargets), [], "the sheet's targets are 44px too");
    const c = await p.ev("(() => { const r = document.getElementById('sc-create').getBoundingClientRect(); return { left: r.left, right: window.innerWidth - r.right }; })()");
    assert.ok(Math.abs(c.left - c.right) < 2 && c.left >= 8, `the sheet is centred with a gutter (${c.left} / ${c.right})`);
    await p.key("Escape", "Escape", 27);
    assert.ok(await waitFor(async () => (await p.ev("document.getElementById('sc-create').open")) === false));
    // Refused: more often than hourly.
    await p.ev("document.querySelector('.sc-new').click(); const f = document.getElementById('sc-create-form'); f.querySelector('[name=text]').value = 'Drink water'; f.querySelector('[name=when]').value = 'every 10 minutes'; f.querySelector('button[value=create]').click(); true");
    const st = await waitFor(async () => p.ev("(() => { const d = document.getElementById('sc-create'); const e = document.getElementById('sc-create-err'); return d && d.open && e ? { modal: d.matches(':modal'), text: d.querySelector('[name=text]').value, when: d.querySelector('[name=when]').value, err: e.textContent, focused: document.activeElement.name } : null; })()"));
    assert.ok(st, "re-opened after the 422");
    assert.equal(st.modal, true);
    assert.deepEqual([st.text, st.when], ["Drink water", "every 10 minutes"]);
    assert.match(st.err, /at most once an hour/);
    assert.equal(st.focused, "when");
  } finally { await p.close(); }
  const es = await open("/dashboard/schedule?new=1", { lang: "es" });
  try {
    await es.ev("const w = document.querySelector('#sc-create [name=when]'); w.value = 'mañana a las 9'; w.dispatchEvent(new Event('input')); true");
    assert.match(await waitFor(async () => es.ev("(() => { const t = document.getElementById('sc-preview').textContent; return /Una vez/.test(t) ? t : null; })()")) || "", /Una vez/);
  } finally { await es.close(); }
});

test("create through the browser: saved, and the new row's detail opens", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/schedule");
  try {
    await p.ev("document.querySelector('.sc-new').click(); const f = document.getElementById('sc-create-form'); f.querySelector('[name=text]').value = 'Book the car service'; f.querySelector('[name=when]').value = 'tomorrow at 10'; f.querySelector('button[value=create]').click(); true");
    const h = await waitFor(async () => p.ev("(document.getElementById('sc-detail-h') || {}).textContent || null"));
    assert.equal(h, "Book the car service");
  } finally { await p.close(); await fixture(); }
});

test("delete through the browser: the first click asks in the pane (no window.confirm); Delete removes it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open(`/dashboard/schedule?id=crow:${ids.rent}`);
  try {
    await p.ev("window.confirm = function () { throw new Error('window.confirm used'); }; [...document.querySelectorAll('.sc-detail button')].find((b) => /Delete/.test(b.textContent)).click(); true");
    const q = await waitFor(async () => p.ev("(document.getElementById('sc-confirm-text') || {}).textContent || null"));
    assert.match(q, /Delete “Pay the rent”\? Its run history goes too\./);
    assert.equal(await p.ev("document.activeElement.id"), "sc-confirm-text", "the confirm text has focus, so it is read");
    await p.ev("document.querySelector('.sc-confirm button').click(); true");
    assert.ok(await waitFor(async () => (await p.ev(`!document.getElementById('sc-${ids.rent}') && !!document.getElementById('sc-toast')`)) === true));
  } finally { await p.close(); await fixture(); }
});

test("dark mode: the page's surfaces follow the theme", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const bg = "getComputedStyle(document.querySelector('.sc-day')).backgroundColor";
  const l = await open("/dashboard/schedule"); const light = await l.ev(bg); await l.close();
  const d = await open("/dashboard/schedule", { dark: true }); const dark = await d.ev(bg); await d.close();
  assert.notEqual(light, dark);
});

test("screenshots for review (only with SCHEDULE_SHOTS_DIR)", async (ctx) => {
  const dir = process.env.SCHEDULE_SHOTS_DIR;
  if (!chrome || !dir) return ctx.skip("set SCHEDULE_SHOTS_DIR to save screenshots");
  mkdirSync(dir, { recursive: true });
  for (const [name, path, width, height] of [["phone", "/dashboard/schedule", 412, 915], ["phone-detail", `/dashboard/schedule?id=crow:${ids.stretch}#sc-${ids.stretch}`, 412, 915], ["wide", `/dashboard/schedule?id=crow:${ids.stretch}`, 1280, 900], ["phone-create", "/dashboard/schedule?new=1", 412, 915]]) {
    for (const dark of [false, true]) for (const lang of ["en", "es"]) {
      const p = await open(path, { width, height, dark, lang });
      try {
        if (name === "phone-create") {
          await p.ev(`const w = document.querySelector('#sc-create [name=when]'); document.querySelector('#sc-create [name=text]').value = ${JSON.stringify(lang === "es" ? "Sacar la basura" : "Take the bins out")}; w.value = ${JSON.stringify(lang === "es" ? "cada martes a las 7 de la tarde" : "every tuesday at 7pm")}; w.dispatchEvent(new Event('input')); true`);
          await waitFor(async () => p.ev("document.querySelectorAll('#sc-preview .sc-next li').length === 3"));
        }
        await sleep(300);
        const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(dir, `schedule-${name}-${dark ? "dark" : "light"}-${lang}.png`), Buffer.from(data, "base64"));
      } finally { await p.close(); }
    }
  }
  assert.ok(existsSync(join(dir, "schedule-wide-dark-en.png")));
});
