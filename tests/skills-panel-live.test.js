// Skills panel audit A6/A7, end to end in a real browser on the PRODUCTION
// submit path: the real dashboard layout (Turbo Drive 8.0.5 + its CSRF header
// hook), the real CSRF middleware and the gateway's own body parser
// (urlencoded, extended:false) in front of the panel handler. The user-skill
// edit page's Save and Delete buttons are clicked in headless Chrome. Before
// the fix the Delete form was nested inside the Save form, the browser dropped
// the inner <form> tag, and both buttons posted action=save&action=delete:
// a 200 render, Turbo's "Form responses must redirect", nothing saved.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";

const scratch = mkdtempSync(join(tmpdir(), "skills-live-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const SKILLS = join(process.env.CROW_HOME, "skills");
mkdirSync(SKILLS, { recursive: true });
const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");

const s = { posts: [] };
let chrome;
before(async () => {
  const app = express();
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use("/dashboard", express.urlencoded({ extended: false }));
  app.use("/dashboard", csrfMiddleware);
  app.get("/login", (req, res) => { res.setHeader("set-cookie", ["crow_session=good; Path=/", "crow_csrf=tok123; Path=/"]); res.end("ok"); });
  const db = { execute: async () => ({ rows: [] }) };
  const layout = (opts) => renderLayout({ ...opts, activePanel: "skills", panels: [], lang: "en" });
  app.all("/dashboard/skills", async (req, res, next) => {
    if (req.method === "POST") s.posts.push(req.body);
    try {
      const html = await panel.handler(req, res, { db, layout, lang: "en" });
      if (html !== undefined && !res.headersSent) res.type("html").send(html);
    } catch (e) { next(e); }
  });
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
  chrome = await startHeadlessChrome();
});
after(async () => { s.http?.closeAllConnections?.(); s.http?.close(); if (chrome) await chrome.close(); rmSync(scratch, { recursive: true, force: true }); });

async function tab() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const dialogs = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  // Accept every confirm() the page raises (the Delete button's), and count them.
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); }
  });
  const evalIn = async (expression) => { const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return o.exceptionDetails ? { threw: o.exceptionDetails.text } : o.result.value; };
  await send("Page.enable");
  return { send, evalIn, dialogs, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(100); } return null; }
const editUrl = (name) => `http://127.0.0.1:${s.port}/dashboard/skills?edit=${name}&source=user`;
const onList = (t) => waitFor(async () => (await t.evalIn("location.search === '' && !!document.querySelector('input[name=action][value=create]')")) === true);
async function open(t, name, ready) {
  await t.send("Page.navigate", { url: `http://127.0.0.1:${s.port}/login` }); await sleep(200);
  await t.send("Page.navigate", { url: editUrl(name) });
  assert.ok(await waitFor(async () => (await t.evalIn(ready + " && !!window.Turbo")) === true), "page + Turbo loaded");
  // Record every Turbo form submission outcome (the window survives Turbo visits).
  await t.evalIn("window.__subs = []; document.addEventListener('turbo:submit-end', (e) => window.__subs.push({ success: e.detail.success, status: e.detail.fetchResponse && e.detail.fetchResponse.statusCode })); true");
}

test("edit page: Save in a real browser writes the edited text", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  writeFileSync(join(SKILLS, "live-save.md"), "# Before\n");
  const t = await tab();
  try {
    await open(t, "live-save.md", "!!document.querySelector('textarea[name=content]')");
    assert.equal(await t.evalIn("document.querySelectorAll('form form').length"), 0, "the browser sees no nested form");
    await t.evalIn("document.querySelector('textarea[name=content]').value = '# After\\n'");
    await t.evalIn("[...document.querySelectorAll('button[type=submit]')].find(b => b.closest('form').querySelector('input[name=action][value=save]')).click()");
    assert.ok(await onList(t), "redirected to the list after Save");
    assert.equal(readFileSync(join(SKILLS, "live-save.md"), "utf8").replace(/\r\n/g, "\n"), "# After\n");
    assert.deepEqual(s.posts.at(-1).action, "save", "one action, not save+delete");
    assert.equal(t.dialogs.length, 0, "Save asks nothing");
    assert.deepEqual(await t.evalIn("JSON.stringify(window.__subs)"), JSON.stringify([{ success: true, status: 200 }]), "Turbo followed the 303 (CSRF header accepted)");
  } finally { await t.close(); }
});

test("edit page: Delete in a real browser asks, then removes the file", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  writeFileSync(join(SKILLS, "live-del.md"), "# Delete me\n");
  const t = await tab();
  try {
    await open(t, "live-del.md", "!!document.querySelector('input[name=action][value=delete]')");
    await t.evalIn("document.querySelector('input[name=action][value=delete]').closest('form').querySelector('button').click()");
    assert.ok(await onList(t), "redirected to the list after Delete");
    assert.equal(t.dialogs.length, 1, "the confirm was shown");
    assert.equal(existsSync(join(SKILLS, "live-del.md")), false);
    assert.equal(s.posts.at(-1).action, "delete");
    assert.deepEqual(await t.evalIn("JSON.stringify(window.__subs)"), JSON.stringify([{ success: true, status: 200 }]));
  } finally { await t.close(); }
});

// Skills panel option C, PR 1 (audit A18): a refused create used to redirect
// and throw away everything typed. Now it answers 422 with the page
// re-rendered: the form keeps all three values, the error sits in the form,
// and the field to fix has focus and is on screen — on a phone, where the
// form is far down the page.
async function openList(t) {
  await t.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await t.send("Page.navigate", { url: `http://127.0.0.1:${s.port}/login` }); await sleep(200);
  await t.send("Page.navigate", { url: `http://127.0.0.1:${s.port}/dashboard/skills` });
  assert.ok(await waitFor(async () => (await t.evalIn("!!document.querySelector('#skill-create') && !!window.Turbo")) === true), "list + Turbo loaded");
  await t.evalIn("window.__subs = []; document.addEventListener('turbo:submit-end', (e) => window.__subs.push({ success: e.detail.success, status: e.detail.fetchResponse && e.detail.fetchResponse.statusCode })); true");
}
const fillCreate = (t, v) => t.evalIn(`(() => { const f = document.querySelector('#skill-create');
  f.querySelector('[name=filename]').value = ${JSON.stringify(v.filename)};
  f.querySelector('[name=purpose]').value = ${JSON.stringify(v.purpose)};
  f.querySelector('[name=content]').value = ${JSON.stringify(v.content)};
  f.querySelector('button[type=submit]').click(); return true; })()`);
const formState = (t) => t.evalIn(`(() => { const f = document.querySelector('#skill-create'); if (!f) return null;
  const a = document.activeElement; const r = a ? a.getBoundingClientRect() : null;
  return { filename: f.querySelector('[name=filename]').value, purpose: f.querySelector('[name=purpose]').value, content: f.querySelector('[name=content]').value,
    error: (f.querySelector('.skills-notice') || {}).textContent || "", focused: a && a.name, inView: !!r && r.top >= 0 && r.bottom <= innerHeight && r.height > 0 }; })()`);

test("create conflict in a real browser (phone width): 422, everything typed kept, the name field focused and on screen", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  writeFileSync(join(SKILLS, "existing-notes.md"), "# Existing notes\n");
  const t = await tab();
  try {
    await openList(t);
    await fillCreate(t, { filename: "Existing notes", purpose: "Notes for the week", content: "Line one.\nLine two." });
    const st = await waitFor(async () => { const v = await formState(t); return v && v.error ? v : null; });
    assert.ok(st, "the refused form re-rendered");
    assert.deepEqual(await t.evalIn("JSON.stringify(window.__subs)"), JSON.stringify([{ success: false, status: 422 }]));
    assert.equal(st.filename, "Existing notes");
    assert.equal(st.purpose, "Notes for the week");
    assert.equal(st.content.replace(/\r\n/g, "\n"), "Line one.\nLine two.");
    assert.match(st.error, /You already have a skill called “Existing notes”\. Pick another name: everything you typed is still here\./);
    assert.equal(st.focused, "filename");
    assert.equal(st.inView, true, "the focused field is inside the phone viewport");
    assert.equal(readFileSync(join(SKILLS, "existing-notes.md"), "utf8"), "# Existing notes\n", "nothing written");
    assert.deepEqual(readdirSync(SKILLS).filter((f) => f.startsWith("existing")), ["existing-notes.md"]);
  } finally { await t.close(); }
});

test("create with empty instructions in a real browser: 422, values kept, the instructions field focused and on screen", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    await openList(t);
    await fillCreate(t, { filename: "Blank one", purpose: "Nothing yet", content: "   " });
    const st = await waitFor(async () => { const v = await formState(t); return v && v.error ? v : null; });
    assert.ok(st);
    assert.deepEqual(await t.evalIn("JSON.stringify(window.__subs)"), JSON.stringify([{ success: false, status: 422 }]));
    assert.equal(st.filename, "Blank one");
    assert.equal(st.purpose, "Nothing yet");
    assert.match(st.error, /The skill has no content/);
    assert.equal(st.focused, "content");
    assert.equal(st.inView, true);
    assert.equal(existsSync(join(SKILLS, "blank-one.md")), false);
  } finally { await t.close(); }
});
