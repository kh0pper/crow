// Skills panel option C, PR 3: the redesigned page in a real browser, on the
// production layout (Turbo 8 + CSRF + the gateway's body parser), at phone
// 412×915 (also at the largest text size) and wide 1280×900, en and es.
// Set SKILLS_SHOTS_DIR to also save phone + wide, light + dark screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";

const scratch = mkdtempSync(join(tmpdir(), "skills-c-live-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
delete process.env.CROW_SKILL_SYNC;
const HOME = process.env.CROW_HOME, SKILLS = join(HOME, "skills");
mkdirSync(SKILLS, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");
const { skillHash } = await import("../servers/gateway/bundle-skill-sync.js");
const REPO = new URL("../", import.meta.url).pathname;

function fixture() {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "kiosk" }, { id: "media" }]));
  writeFileSync(join(SKILLS, "kiosk.md"), "---\ndescription: Put a message or a note on the household kiosk display.\n---\n# Kiosk display\n\nAn older version.\n");
  writeFileSync(join(SKILLS, "media.md"), "# Media notes, my way\n\nShort briefings only.\n");
  writeFileSync(join(SKILLS, "cafe-notes.md"), "---\ndescription: How I like my pour-over, and the cafés to try.\n---\n# Café notes\n\nKeep tasting notes short.\n");
  writeFileSync(join(SKILLS, "household-plan.md"), "---\ndescription: Weekly meals and the shopping list.\n---\n# Household plan\n\nPlan Sunday.\n");
  writeFileSync(join(HOME, "skill-installs.json"), JSON.stringify({
    "kiosk.md": { bundle: "kiosk", sha256: skillHash(readFileSync(join(SKILLS, "kiosk.md"), "utf8")), installedAt: "t" },
    "media.md": { bundle: "media", sha256: skillHash("# An older shipped media\n"), installedAt: "t" },
  }));
  rmSync(join(HOME, "skill-state.json"), { force: true });
}
fixture();

const BOTS = [
  { bot_id: "home-helper", display_name: "Home helper", enabled: 1, definition: JSON.stringify({ skills: ["household-plan", "media"] }) },
  { bot_id: "research-desk", display_name: "Research desk", enabled: 1, definition: JSON.stringify({ skills: ["cafe-notes"] }) },
];
const s = {};
let chrome;
before(async () => {
  const app = express();
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use("/dashboard", express.urlencoded({ extended: false }));
  app.use("/dashboard", csrfMiddleware);
  app.get("/login", (req, res) => { res.setHeader("set-cookie", ["crow_session=good; Path=/", "crow_csrf=tok123; Path=/"]); res.end("ok"); });
  const db = { execute: async (q) => ({ rows: /pi_bot_defs/.test(typeof q === "string" ? q : q.sql) ? BOTS : [] }) };
  app.all("/dashboard/skills", async (req, res, next) => {
    const lang = /lang=es/.test(req.headers.cookie || "") ? "es" : "en";
    const layout = (opts) => renderLayout({ ...opts, activePanel: "skills", panels: [], lang });
    try {
      const html = await panel.handler(req, res, { db, layout, lang });
      if (html !== undefined && !res.headersSent) res.type("html").send(html);
    } catch (e) { next(e); }
  });
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.base = `http://127.0.0.1:${s.http.address().port}`;
  chrome = await startHeadlessChrome();
});
after(async () => { s.http?.closeAllConnections?.(); s.http?.close(); if (chrome) await chrome.close(); rmSync(scratch, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(100); } return null; }

/** A tab at a viewport, logged in (CSRF cookie), in a language, optionally dark and at a text size. */
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
  await send("Network.enable").catch(() => {});
  await send("Network.setCookie", { name: "lang", value: lang, url: s.base }).catch(() => {});
  await ev(`document.cookie = "lang=${lang}; path=/"; true`);
  await send("Page.navigate", { url: s.base + path });
  assert.ok(await waitFor(async () => (await ev("!!document.querySelector('.sk-page') && !!window.Turbo && document.readyState === 'complete'")) === true), "page + Turbo loaded");
  if (textSize) await ev(`document.documentElement.setAttribute('data-text-size', ${JSON.stringify(textSize)}); true`);
  await sleep(150);
  const key = async (k, code, keyCode, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode });
  };
  return { send, ev, key, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const noOverflow = "document.documentElement.scrollWidth <= window.innerWidth + 1";
const smallTargets = `(() => { const out = [];
  for (const el of document.querySelectorAll('.sk-page button, .sk-page a, .sk-page summary, .sk-page input, .sk-page [role=switch], dialog[open] button, dialog[open] input')) {
    if (el.closest('.sk-vh') || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.closest('.skills-notice') && el.tagName === 'A') continue; // an inline link inside an error sentence
    if (r.height < 43.5) out.push((el.className || el.tagName) + ':' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) + ':' + Math.round(r.height));
  } return out; })()`;

for (const lang of ["en", "es"]) {
  test(`phone 412 (${lang}): no overflow, 44px targets (also at the largest text size), first row above the fold`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    for (const textSize of [null, "xlarge"]) {
      const p = await open("/dashboard/skills", { lang, textSize });
      try {
        assert.equal(await p.ev(noOverflow), true, `no horizontal overflow (${textSize || "default"})`);
        assert.deepEqual(await p.ev(smallTargets), [], `every target ≥ 44px (${textSize || "default"})`);
        if (!textSize) {
          const items = await p.ev("document.querySelectorAll('.sk-attn-item').length");
          assert.ok(items <= 4, `strip items ${items}`);
          const top = await p.ev("document.querySelector('.sk-row').getBoundingClientRect().top");
          assert.ok(top < 915, `first row top ${top} is above the fold`);
        }
      } finally { await p.close(); }
    }
  });
}

test("?skill=kiosk: exactly one detail, under its row on a phone and to the right of the list on wide", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const geo = "(() => { const d = document.querySelectorAll('.sk-detail'); const row = document.querySelector('#skill-kiosk').getBoundingClientRect(); const r = d[0] ? d[0].getBoundingClientRect() : null; return { n: d.length, rowBottom: row.bottom, rowRight: row.right, rowLeft: row.left, top: r && r.top, left: r && r.left, focused: document.activeElement && document.activeElement.id }; })()";
  const phone = await open("/dashboard/skills?skill=kiosk#skill-kiosk");
  try {
    const g = await phone.ev(geo);
    assert.equal(g.n, 1);
    assert.ok(g.top >= g.rowBottom - 1, `under its row (${g.top} vs ${g.rowBottom})`);
    assert.ok(Math.abs(g.left - g.rowLeft) < 2, "same column as the row");
    assert.equal(g.focused, "sk-detail-h", "focus lands on the opened detail");
    assert.equal(await phone.ev(noOverflow), true);
    assert.deepEqual(await phone.ev(smallTargets), []);
  } finally { await phone.close(); }
  const wide = await open("/dashboard/skills?skill=kiosk", { width: 1280, height: 900 });
  try {
    const g = await wide.ev(geo);
    assert.equal(g.n, 1);
    assert.ok(g.left >= g.rowRight - 1, `right of the list (${g.left} vs ${g.rowRight})`);
    assert.equal(await wide.ev(noOverflow), true);
  } finally { await wide.close(); }
});

test("with the player bar shown, the toast and the wide pane stay above it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const bar = 72;
  const p = await open("/dashboard/skills?toggled=cafe-notes&to=on");
  try {
    await p.ev(`document.documentElement.style.setProperty('--crow-player-h', '${bar}px'); true`);
    assert.ok(await waitFor(() => p.ev("(document.getElementById('skills-toast') || {}).textContent")), "toast text inserted after load");
    const b = await p.ev("document.getElementById('skills-toast').getBoundingClientRect().bottom");
    assert.ok(b <= 915 - bar, `toast bottom ${b} ≤ bar top ${915 - bar}`);
  } finally { await p.close(); }
  const w = await open("/dashboard/skills?skill=media&compare=1", { width: 1280, height: 900 });
  try {
    await w.ev(`document.documentElement.style.setProperty('--crow-player-h', '${bar}px'); true`);
    await sleep(100);
    const b = await w.ev("document.querySelector('.sk-detail').getBoundingClientRect().bottom");
    assert.ok(b <= 900 - bar, `pane bottom ${b} ≤ bar top ${900 - bar}`);
  } finally { await w.close(); }
});

test("keyboard: search → + New → strip → a row link → its switch; Space toggles it and focus comes back to it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  fixture();
  const p = await open("/dashboard/skills", { width: 1280, height: 900 });
  const where = "(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) + '|' + ((a.closest('.sk-row') || {}).id || '') : ''; })()";
  try {
    await p.ev("document.getElementById('sk-q').focus(); true");
    const seen = [];
    for (let i = 0; i < 12; i++) { await p.key("Tab", "Tab", 9); seen.push(await p.ev(where)); }
    assert.match(seen[0], /sk-new/);
    assert.match(seen[1], /sk-act/, "then the first strip button");
    const hit = seen.findIndex((x) => /^sk-hit\|skill-/.test(x));
    assert.ok(hit > 1, seen.join(" / "));
    const rowId = seen[hit].split("|")[1];
    assert.match(seen[hit + 1], new RegExp(`sk-switch\\|${rowId}$`), "the row's own switch comes next");
    assert.ok(seen.slice(2, hit).every((x) => /sk-act|sk-sec-h|SUMMARY|btn/.test(x)), seen.slice(2, hit).join(" / "));
    // Space on the switch submits it; after the redirect focus is on the same switch.
    for (let i = hit + 1; i < seen.length - 0; i++) if (seen[i] === seen[hit + 1]) break;
    await p.ev(`document.querySelector('#${rowId} [role=switch]').focus(); true`);
    const before = await p.ev(`document.querySelector('#${rowId} [role=switch]').getAttribute('aria-checked')`);
    await p.key(" ", "Space", 32, " ");
    const after = await waitFor(async () => {
      const v = await p.ev(`(() => { const b = document.querySelector('#${rowId} [role=switch]'); return b && b.getAttribute('aria-checked') !== ${JSON.stringify(before)} ? { focused: document.activeElement === b, toast: (document.getElementById('skills-toast') || {}).textContent } : null; })()`);
      return v && v.toast ? v : null;
    });
    assert.ok(after, "toggled, with a toast");
    assert.equal(after.focused, true);
  } finally { await p.close(); fixture(); }
});

test("create dialog: opens as a modal, Esc closes it and focus returns; a taken name re-opens it with everything typed", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/skills");
  try {
    await p.ev("document.querySelector('.sk-new').focus(); document.querySelector('.sk-new').click(); true");
    assert.equal(await p.ev("document.getElementById('sk-create').matches(':modal')"), true);
    assert.equal(await p.ev("document.activeElement.name"), "filename");
    await p.ev("const i = document.querySelector('#sk-create [name=filename]'); i.value = 'Café Notes 2'; i.dispatchEvent(new Event('input')); true");
    assert.match(await p.ev("document.getElementById('sk-file-hint').textContent"), /cafe-notes-2\.md/);
    await p.key("Escape", "Escape", 27);
    assert.ok(await waitFor(async () => (await p.ev("document.getElementById('sk-create').open")) === false));
    assert.equal(await p.ev("document.activeElement.classList.contains('sk-new')"), true, "focus is back on + New skill");
    // The conflict path.
    await p.ev("document.querySelector('.sk-new').click(); const f = document.querySelector('#skill-create'); f.querySelector('[name=filename]').value = 'Café notes'; f.querySelector('[name=purpose]').value = 'Pour-over'; f.querySelector('[name=content]').value = 'Line one.'; f.querySelector('button[type=submit]').click(); true");
    const st = await waitFor(async () => p.ev("(() => { const d = document.getElementById('sk-create'); const f = document.querySelector('#skill-create'); const e = f && f.querySelector('.skills-notice'); return d && d.open && e ? { modal: d.matches(':modal'), name: f.querySelector('[name=filename]').value, purpose: f.querySelector('[name=purpose]').value, content: f.querySelector('[name=content]').value, focused: document.activeElement.name, err: e.textContent } : null; })()"));
    assert.ok(st, "re-opened after the 422");
    assert.equal(st.modal, true);
    assert.deepEqual([st.name, st.purpose, st.content.replace(/\r\n/g, "\n")], ["Café notes", "Pour-over", "Line one."]);
    assert.equal(st.focused, "filename");
    assert.match(st.err, /You already have a skill called “Café notes”/);
  } finally { await p.close(); }
});

test("search: ?q=cafe finds Café notes; typing a name nothing matches offers to create it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await open("/dashboard/skills?q=cafe");
  try {
    assert.deepEqual(await p.ev("[...document.querySelectorAll('.sk-row')].filter((r) => !r.hidden).map((r) => r.dataset.skill)"), ["cafe-notes"]);
    await p.ev("const q = document.getElementById('sk-q'); q.value = 'zzz'; q.dispatchEvent(new Event('input')); true");
    const live = await p.ev("(() => { const n = document.getElementById('sk-nomatch-live'); return { hidden: n.hidden, text: n.textContent.replace(/\\s+/g, ' ').trim() }; })()");
    assert.equal(live.hidden, false);
    assert.match(live.text, /No skill matches “zzz”\s*Create “zzz”/);
    await p.ev("document.querySelector('#sk-nomatch-live a[data-sk-new]').click(); true");
    assert.equal(await p.ev("document.querySelector('#sk-create [name=filename]').value"), "zzz", "the name is prefilled");
    assert.match(await p.ev("location.search"), /q=zzz/, "the URL keeps the search");
  } finally { await p.close(); }
  const es = await open("/dashboard/skills?q=zzz", { lang: "es" });
  try {
    assert.match(await es.ev("document.querySelector('.sk-nomatch').textContent"), /Ninguna habilidad coincide con “zzz”/);
  } finally { await es.close(); }
});

test("screenshots for review (only with SKILLS_SHOTS_DIR)", async (ctx) => {
  const dir = process.env.SKILLS_SHOTS_DIR;
  if (!chrome || !dir) return ctx.skip("set SKILLS_SHOTS_DIR to save screenshots");
  mkdirSync(dir, { recursive: true });
  for (const [name, path, width, height] of [["phone", "/dashboard/skills", 412, 915], ["phone-detail", "/dashboard/skills?skill=media&compare=1#skill-media", 412, 915], ["wide", "/dashboard/skills?skill=kiosk&compare=1", 1280, 900]]) {
    for (const dark of [false, true]) for (const lang of ["en", "es"]) {
      const p = await open(path, { width, height, dark, lang });
      try {
        await sleep(300);
        const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(dir, `skills-${name}-${dark ? "dark" : "light"}-${lang}.png`), Buffer.from(data, "base64"));
      } finally { await p.close(); }
    }
  }
  assert.ok(existsSync(join(dir, "skills-wide-dark-en.png")));
});
