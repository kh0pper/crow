// Crow Artifacts — the step-3 loop end to end in a headless browser: the real
// viewer page (plan PR-2), panel routes (session + CSRF), the artifact origin listener on a
// distinct fake hostname, the trusted viewer and the panel client. A document
// gets a section comment, a page gets an in-frame comment, Send feedback
// delivers a round to a (stub) Perch engine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import * as runtime from "../servers/gateway/artifact-origin/runtime.js";
import * as policy from "../servers/gateway/artifact-origin/policy.js";
import { startArtifactOrigin } from "../servers/gateway/artifact-origin/server.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import * as store from "../bundles/artifacts/server/store.js";
import artifactsRouter from "../bundles/artifacts/panel/routes.js";
import panel from "../bundles/artifacts/panel/artifacts.js";

const s = { spawns: [], messages: [] };
let chrome;
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-live-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
  runtime._resetForTest();
  // PR A review L3: the CSP base is never derived from Host — the test names
  // the fake origin explicitly, exactly like the isolation-live matrix does.
  const probe = express();
  const probeSrv = await import("node:http").then((m) => m.createServer(probe));
  await new Promise((r) => probeSrv.listen(0, "127.0.0.1", r));
  s.oport = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(r));
  // D24 seam: an artifact id in s.fail answers 500 (the document is never served).
  s.fail = new Set();
  const resolve = store.contentResolver(s.db, s.blobs);
  s.origin = await startArtifactOrigin({ port: s.oport, tokens: runtime.viewTokens(), resolveContent: async (q) => { if (s.fail.has(q.artifactId)) throw new Error("down"); return resolve(q); }, publicBase: `http://art.test:${s.oport}` });
  runtime._setInfoForTest({ baseUrl: `http://art.test:${s.oport}`, port: s.oport, configured: true });
  const engine = {
    async list() { return []; },
    async spawn(o) { s.spawns.push(o); return { sessionId: "s1", threadId: "perchlive-live" }; },
    async message(id, text) { s.messages.push(text); },
  };
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).end());
  const app = express();
  app.get("/login", (req, res) => { res.setHeader("set-cookie", ["crow_session=good; HttpOnly; Path=/", "crow_csrf=tok; Path=/"]); res.end("ok"); });
  app.use(artifactsRouter(dashboardAuth, { db: s.db, blobs: s.blobs, runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks }, engine, loadBotDef: async (botId) => (botId === "notools" ? { tools: { crow_mcp: ["gmail/send"] } } : { tools: { crow_mcp: ["artifacts/artifact_update"] } }) }));
  app.get("/dashboard/artifacts", dashboardAuth, (req, res) => panel.handler(req, res, { lang: "en", layout: ({ content }) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${content}</body></html>` }));
  // (the viewer page itself is served by artifactsRouter)
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
  s.doc = await store.createArtifact(s.db, s.blobs, { title: "Plan", type: "document", source: { markdown: "# Plan\n\nThe first step.\n\nThe second step." }, actor: { kind: "bot", id: "bobby" } }, { markdownBlocks });
  s.page = await store.createArtifact(s.db, s.blobs, { title: "Mockup", type: "page", source: { html: "<!doctype html><html><head><style>body{margin:0}button{position:absolute;left:10px;top:10px;width:220px;height:60px}</style></head><body><button id=buy>Buy now</button></body></html>" }, actor: { kind: "bot", id: "bobby" } }, {});
  chrome = await startHeadlessChrome({ extraArgs: ["--host-resolver-rules=MAP dash.test 127.0.0.1, MAP art.test 127.0.0.1"] });
});
after(async () => { s.http?.closeAllConnections?.(); s.http?.close(); s.origin?.close(); if (chrome) await chrome.close(); runtime._resetForTest(); try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

async function tab() {
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
  const evalIn = async (expression) => { const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return o.exceptionDetails ? { threw: o.exceptionDetails.text } : o.result.value; };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  return { send, evalIn, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(100); } return null; }
// Strict: evalIn returns {threw} (truthy) while a navigation is still in
// flight, so every wait here requires a literal true.
const yes = (t, expr, ms) => waitFor(async () => (await t.evalIn(expr)) === true, ms);
const click = async (t, x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };

test("document: the frame loads from the artifact host, a section comment is added from the rail, Send feedback delivers a round", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300);
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/dashboard/artifacts/view/${s.doc.id}` });
    const src = await waitFor(() => t.evalIn("(document.querySelector('iframe.crow-artifact-frame')||{}).src"));
    assert.match(src, new RegExp(`^http://art\\.test:${s.oport}/v/[A-Za-z0-9_-]{43}/$`));
    assert.equal(await t.evalIn("document.querySelector('iframe.crow-artifact-frame').getAttribute('sandbox')"), "", "document is script-free");
    assert.ok(await yes(t, "!!document.querySelector('.cv-sections button')"));
    await t.evalIn("document.querySelectorAll('.cv-sections button')[1].click()");
    assert.ok(await yes(t, "!!document.querySelector('.cv-compose textarea')"));
    await t.evalIn("document.querySelector('.cv-compose textarea').value = 'Say which step first'; document.querySelector('.cv-compose button').click()");
    assert.ok(await yes(t, "[...document.querySelectorAll('.cv-thread')].some(x => x.textContent.includes('Say which step first'))"));
    const th = (await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE artifact_id=?", args: [s.doc.id] })).rows;
    assert.deepEqual(JSON.parse(th[0].anchor_json), { kind: "block", id: "b2", text: "The first step.", quote: "" });
    await t.evalIn("document.querySelector('.cv-send').click()");
    assert.ok(await yes(t, "!!document.querySelector('dialog.cv-preview[open]')"));
    await t.evalIn("document.querySelector('dialog.cv-preview button').click()");
    assert.ok(await yes(t, "document.body.textContent.includes(\"The bot isn't running\")"), "no live session: D4 choice shown");
    assert.deepEqual(s.spawns, [], "nothing spawned before the owner chooses");
    await t.evalIn("[...document.querySelectorAll('.cv-banner button')].find(b => b.textContent.includes('Perch')).click()");
    assert.ok(await waitFor(() => s.messages.length === 1), "the round reached the engine");
    assert.deepEqual(s.spawns, [{ botId: "bobby" }], "a trusted round: an ordinary new session");
    assert.match(s.messages[0], /Say which step first/);
  } finally { await t.close(); }
});

test("page: comment mode turns a click inside the sandboxed frame into a proposal; the comment is added only on the rail's button", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300);
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/dashboard/artifacts/view/${s.page.id}` });
    assert.ok(await yes(t, "!!document.querySelector('iframe.crow-artifact-frame')"));
    assert.equal(await t.evalIn("document.querySelector('iframe.crow-artifact-frame').getAttribute('sandbox')"), "allow-scripts");
    await sleep(800);
    await t.evalIn("document.querySelector('.cv-comment').click()");
    await sleep(300);
    const r = await t.evalIn("JSON.stringify(document.querySelector('iframe.crow-artifact-frame').getBoundingClientRect())");
    const box = JSON.parse(r);
    await click(t, box.x + 60, box.y + 30);
    assert.ok(await yes(t, "!!document.querySelector('.cv-compose textarea')"), "a proposal opened the compose box");
    assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_threads WHERE artifact_id=?", args: [s.page.id] })).rows[0].c, 0, "nothing stored before the owner clicks");
    await t.evalIn("document.querySelector('.cv-compose textarea').value = 'Make it green'; document.querySelector('.cv-compose button').click()");
    assert.ok(await waitFor(async () => Number((await s.db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_threads WHERE artifact_id=?", args: [s.page.id] })).rows[0].c) === 1));
    const a = JSON.parse((await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE artifact_id=?", args: [s.page.id] })).rows[0].anchor_json);
    assert.deepEqual(a, { kind: "element", selector: "#buy", text: "Buy now" });
  } finally { await t.close(); }
});

test("diagram: comment mode shows the region overlay and a click composes a region anchor", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const diagram = await store.createArtifact(s.db, s.blobs, {
    title: "Flow", type: "diagram",
    source: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect id="r1" x="10" y="10" width="80" height="40" fill="#e2a03f"><title>Box</title></rect></svg>' },
    actor: { kind: "bot", id: "bobby" },
  }, {});
  const t = await tab();
  try {
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300);
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/dashboard/artifacts/view/${diagram.id}` });
    assert.ok(await yes(t, "!!document.querySelector('iframe.crow-artifact-frame')"));
    await t.evalIn("document.querySelector('.cv-comment').click()");
    await sleep(200);
    assert.equal(await t.evalIn("!document.querySelector('.cv-region').hasAttribute('hidden')"), true, "the transparent overlay is up");
    const box = JSON.parse(await t.evalIn("JSON.stringify(document.querySelector('.cv-frame').getBoundingClientRect())"));
    await click(t, box.x + box.width / 2, box.y + box.height / 2);
    assert.ok(await yes(t, "!!document.querySelector('.cv-compose textarea')"), "a region proposal opened the compose box");
    await t.evalIn("document.querySelector('.cv-compose textarea').value = 'Move this box'; document.querySelector('.cv-compose button').click()");
    assert.ok(await waitFor(async () => Number((await s.db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_threads WHERE artifact_id=?", args: [diagram.id] })).rows[0].c) === 1));
    const a = JSON.parse((await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE artifact_id=?", args: [diagram.id] })).rows[0].anchor_json);
    assert.equal(a.kind, "region");
    assert.ok(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1, `region coordinates are normalised: ${JSON.stringify(a)}`);
  } finally { await t.close(); }
});

test("a flagged version is not re-framed: the reload shows the tripwire banner and no frame", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Escaper", type: "page", source: { html: "<!doctype html><p>x</p>" }, actor: { kind: "bot", id: "bobby" } }, {});
  const t = await tab();
  try {
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300);
    // The tripwire fired (as the viewer would report it): flag + revoke.
    const rep = await t.evalIn(`(async () => {
      const csrf = decodeURIComponent(/crow_csrf=([^;]+)/.exec(document.cookie)[1]);
      const r = await fetch("/api/artifacts/${art.id}/versions/1/tripwire", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-crow-csrf": csrf }, body: JSON.stringify({ reason: "second-load" }) });
      return r.status;
    })()`);
    assert.equal(rep, 200);
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/dashboard/artifacts/view/${art.id}` });
    assert.ok(await yes(t, "document.body.textContent.includes('tried to leave its frame')"), "the flagged banner is shown");
    assert.equal(await t.evalIn("!!document.querySelector('iframe.crow-artifact-frame')"), false, "the flagged version is never framed");
  } finally { await t.close(); }
});

test("a contact thread included in the round makes a LOCKED new session; its words ride the snapshot", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const comments = await import("../bundles/artifacts/server/comments.js");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Shared draft", type: "document", source: { markdown: "# Draft\n\nwords" }, actor: { kind: "bot", id: "bobby" } }, { markdownBlocks });
  const owner = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "tighten the intro", author: { kind: "owner" } });
  const contact = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "CONTACT-WORDS-4477 and a demand", author: { kind: "contact", id: "c-live" } });
  const spawnsBefore = s.spawns.length, messagesBefore = s.messages.length;
  const t = await tab();
  try {
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300);
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/dashboard/artifacts/view/${art.id}` });
    assert.ok(await yes(t, "!!document.querySelector('.cv-send')"));
    await t.evalIn("document.querySelector('.cv-send').click()");
    assert.ok(await yes(t, "!!document.querySelector('dialog.cv-preview[open]')"));
    // The preview: the owner's thread is ticked, the contact's is UNTICKED,
    // shown in full and labelled.
    const state = await t.evalIn(`JSON.stringify([...document.querySelectorAll('dialog.cv-preview .cv-pv')].map(d => ({ ticked: d.querySelector('input').checked, untrusted: d.classList.contains('cv-untrusted'), text: d.textContent.slice(0, 120) })))`);
    const rows = JSON.parse(state);
    assert.equal(rows.length, 2);
    const cRow = rows.find((r) => r.text.includes("CONTACT-WORDS-4477"));
    const oRow = rows.find((r) => r.text.includes("tighten the intro"));
    assert.equal(oRow.ticked, true, "the owner's thread goes by default");
    assert.equal(cRow.ticked, false, "the contact's thread does NOT");
    assert.equal(cRow.untrusted, true, "and is labelled as a contact's");
    // The owner includes it explicitly.
    await t.evalIn(`(() => { const d = [...document.querySelectorAll('dialog.cv-preview .cv-pv')].find(x => x.textContent.includes('CONTACT-WORDS-4477')); d.querySelector('input').checked = true; })()`);
    await t.evalIn("document.querySelector('dialog.cv-preview button').click()");
    assert.ok(await waitFor(() => s.messages.length > messagesBefore), "the round reached the engine");
    assert.deepEqual(s.spawns.at(-1), { botId: "bobby", narrowedTools: ["crow:only:mcp__artifacts__"] }, "a contact thread ⇒ a NEW session LOCKED to Artifacts");
    assert.match(s.messages.at(-1), /CONTACT-WORDS-4477/, "the included contact words ride the snapshot");
    assert.match(s.messages.at(-1), /tighten the intro/);
    const round = (await s.db.execute({ sql: "SELECT untrusted_input, session_id FROM artifact_rounds WHERE artifact_id=? ORDER BY id DESC LIMIT 1", args: [art.id] })).rows[0];
    assert.equal(Number(round.untrusted_input), 1, "the round row is untrusted");
    assert.equal(round.session_id, "perchlive-live");
    // The locked session's taint record exists (the BEFORE-send ordering itself is pinned in the model suite, review C2-R2).
    const taint = (await s.db.execute({ sql: "SELECT reason FROM artifact_session_taint WHERE thread_id='perchlive-live'" })).rows;
    assert.ok(taint.length >= 1 && taint[0].reason === "untrusted-round");
  } finally { await t.close(); }
});

test("a bot without the Artifacts tools: the owner sees the delivery failure, never a false 'revising' (review C3-L1)", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const comments = await import("../bundles/artifacts/server/comments.js");
  const art = await store.createArtifact(s.db, s.blobs, { title: "No tools bot", type: "document", source: { markdown: "draft" }, actor: { kind: "bot", id: "notools" } }, { markdownBlocks });
  await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "owner note", author: { kind: "owner" } });
  const spawnsBefore = s.spawns.length, messagesBefore = s.messages.length;
  const t = await tab();
  try {
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300);
    await t.send("Page.navigate", { url: `http://dash.test:${s.port}/dashboard/artifacts/view/${art.id}` });
    assert.ok(await yes(t, "!!document.querySelector('.cv-send')"));
    await t.evalIn("document.querySelector('.cv-send').click()");
    assert.ok(await yes(t, "!!document.querySelector('dialog.cv-preview[open]')"));
    await t.evalIn("document.querySelector('dialog.cv-preview button').click()");
    assert.ok(await yes(t, "document.body.textContent.includes('bot_lacks_artifacts')"), "the failure reason is shown");
    assert.equal(await t.evalIn("document.body.textContent.includes('working on your comments')"), false, "never a false 'revising' banner");
    assert.equal(s.spawns.length, spawnsBefore, "nothing spawned");
    assert.equal(s.messages.length, messagesBefore, "nothing sent");
  } finally { await t.close(); }
});

// ── the viewer page (plan PR-2 Tasks 2.2/2.3) ───────────────────────────────
const nav = async (t, path) => { await t.send("Page.navigate", { url: `http://dash.test:${s.port}/login` }); await sleep(300); await t.send("Page.navigate", { url: `http://dash.test:${s.port}${path}` }); };
const BUY = "<!doctype html><html><head><style>body{margin:0}button{position:absolute;left:10px;top:10px;width:220px;height:60px}</style></head><body><button id=buy>Buy now</button></body></html>";

test("viewer D24: a document the origin never served → 'couldn't load — retry', no flag; Retry loads it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Flaky", type: "page", source: { html: BUY }, actor: { kind: "bot", id: "bobby" } }, {});
  s.fail.add(art.id);
  const t = await tab();
  try {
    await nav(t, `/dashboard/artifacts/view/${art.id}`);
    assert.ok(await yes(t, "!!document.querySelector('.cv-retry button')", 15000), "the retry panel is shown");
    assert.equal(await t.evalIn("!!document.querySelector('iframe.crow-artifact-frame')"), false, "the frame was torn down");
    const v = (await s.db.execute({ sql: "SELECT flagged_reason FROM artifact_versions WHERE artifact_id=?", args: [art.id] })).rows[0];
    assert.equal(v.flagged_reason, null, "never flagged");
    assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_audit WHERE artifact_id=? AND action LIKE '%flag%'", args: [art.id] })).rows[0].c, 0, "no audit row");
    s.fail.delete(art.id);
    await t.evalIn("document.querySelector('.cv-retry button').click()");
    assert.ok(await yes(t, "!!document.querySelector('iframe.crow-artifact-frame') && !document.querySelector('.cv-retry')"), "Retry mounted a fresh frame");
    await sleep(7000);   // past the hello window: the fresh load said hello, nothing trips
    assert.equal(await t.evalIn("!!document.querySelector('.cv-flagged, .cv-retry')"), false);
  } finally { s.fail.delete(art.id); await t.close(); }
});

test("viewer pins: numbered pins only for the owner's anchors, placed on the element, and a pin focuses its thread", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const comments = await import("../bundles/artifacts/server/comments.js");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Pinned", type: "page", source: { html: BUY }, actor: { kind: "bot", id: "bobby" } }, {});
  await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "element", selector: "#buy", text: "Buy now" }, text: "make it green", author: { kind: "owner" } });
  await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "element", selector: "#buy", text: "Buy now" }, text: "contact words", author: { kind: "contact", id: "c-pin" } });
  const t = await tab();
  try {
    await nav(t, `/dashboard/artifacts/view/${art.id}`);
    assert.ok(await yes(t, "document.querySelectorAll('.cv-pin').length === 1", 15000), "one pin (the owner's)");
    const g = JSON.parse(await t.evalIn(`JSON.stringify({ pin: document.querySelector('.cv-pin').getBoundingClientRect(), frame: document.querySelector('iframe.crow-artifact-frame').getBoundingClientRect(), label: document.querySelector('.cv-pin').textContent })`));
    assert.equal(g.label, "1");
    const cx = g.pin.x + g.pin.width / 2 - g.frame.x, cy = g.pin.y + g.pin.height / 2 - g.frame.y;
    assert.ok(cx >= 8 && cx <= 12 && cy >= 8 && cy <= 12, `the pin sits on the element's corner (${cx},${cy})`);
    await t.evalIn("document.querySelector('.cv-pin').click()");
    assert.ok(await yes(t, "document.getElementById('cv-t1').classList.contains('cv-focus')"), "the pin focused thread 1");
    assert.equal(await t.evalIn("document.querySelectorAll('.cv-thread').length"), 2, "both threads are listed in the trusted column");
    assert.equal(await t.evalIn("document.querySelector('.cv-send').textContent"), "Send 1 comment to chat", "the owner's open thread is what goes by default");
  } finally { await t.close(); }
});

test("viewer: D20 Run scripts in the header; the version switcher shows a flagged version as flagged, never framed", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Tainted", type: "page", source: { html: BUY }, actor: { kind: "bot", id: "bobby" }, untrusted: true }, {});
  await store.addVersion(s.db, s.blobs, { artifactId: art.id, source: { html: BUY.replace("Buy now", "Buy later") }, actor: { kind: "bot", id: "bobby" } }, {});
  await store.flagVersion(s.db, { artifactId: art.id, n: 2, reason: "second-load", actor: { kind: "session" } });
  const t = await tab();
  try {
    await nav(t, `/dashboard/artifacts/view/${art.id}?v=1`);
    assert.ok(await yes(t, "!!document.querySelector('iframe.crow-artifact-frame')", 15000));
    assert.equal(await t.evalIn("document.querySelector('iframe.crow-artifact-frame').getAttribute('sandbox')"), "", "tainted: scripts off");
    assert.ok(await yes(t, "!document.querySelector('.cv-run').hidden"), "Run scripts is offered in the header");
    await t.evalIn("document.querySelector('.cv-run').click()");
    assert.ok(await yes(t, "(document.querySelector('iframe.crow-artifact-frame')||{getAttribute(){}}).getAttribute('sandbox') === 'allow-scripts'", 15000), "approved: remounted with scripts");
    assert.equal(await t.evalIn("document.querySelector('.cv-run').hidden"), true);
    assert.equal(await t.evalIn("[...document.querySelectorAll('.cv-version option')].map(o => o.textContent).join('|')"), "v2 · flagged|v1");
    await t.evalIn("(() => { const s = document.querySelector('.cv-version'); s.value = '2'; s.dispatchEvent(new Event('change')); })()");
    assert.ok(await yes(t, "!!document.querySelector('.cv-flagged')"), "the flagged panel replaces the frame");
    assert.equal(await t.evalIn("!!document.querySelector('iframe.crow-artifact-frame')"), false, "a flagged version is never framed");
  } finally { await t.close(); }
});

test("viewer: while a round is active the page polls; when it ends with a new version it says so and offers it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const comments = await import("../bundles/artifacts/server/comments.js");
  const rounds = await import("../bundles/artifacts/server/rounds.js");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Polled", type: "page", source: { html: BUY }, actor: { kind: "bot", id: "bobby" } }, {});
  const th = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "go", author: { kind: "owner" } });
  const round = await rounds.startRound(s.db, { artifactId: art.id, actor: { kind: "session" }, include: [th.threadId], kind: "round" });
  await s.db.execute({ sql: "UPDATE artifact_rounds SET status='working' WHERE id=?", args: [round.id] });
  const t = await tab();
  try {
    await nav(t, `/dashboard/artifacts/view/${art.id}`);
    assert.ok(await yes(t, "document.querySelector('.cv-status').textContent.includes('working on your comments')", 15000), "the status says the bot is working");
    assert.equal(await t.evalIn("document.querySelector('.cv-send').disabled"), true, "no second round while one runs");
    await store.addVersion(s.db, s.blobs, { artifactId: art.id, source: { html: BUY.replace("Buy now", "Buy v2") }, actor: { kind: "bot", id: "bobby" }, roundId: round.id }, {});
    await s.db.execute({ sql: "UPDATE artifact_rounds SET status='done' WHERE id=?", args: [round.id] });
    assert.ok(await yes(t, "!!document.querySelector('.cv-ready button')", 12000), "the next poll announced the new version");
    assert.match(await t.evalIn("document.querySelector('.cv-ready').textContent"), /Version 2 is ready/);
    await t.evalIn("document.querySelector('.cv-ready button').click()");
    assert.ok(await yes(t, "document.querySelector('.cv-version').value === '2' && !!document.querySelector('iframe.crow-artifact-frame')"), "switched to v2");
  } finally { await t.close(); }
});

test("viewer pins + numbering are scoped to the mounted version; a resolved thread gets no pin (review M1)", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const comments = await import("../bundles/artifacts/server/comments.js");
  const art = await store.createArtifact(s.db, s.blobs, { title: "Versioned", type: "page", source: { html: BUY }, actor: { kind: "bot", id: "bobby" } }, {});
  await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "element", selector: "#buy", text: "Buy now" }, text: "v1 note", author: { kind: "owner" } });
  const done = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "element", selector: "#buy", text: "Buy now" }, text: "already fixed", author: { kind: "owner" } });
  await comments.setThreadStatus(s.db, { threadId: done.threadId, status: "resolved", artifactId: art.id });
  await store.addVersion(s.db, s.blobs, { artifactId: art.id, source: { html: BUY.replace("Buy now", "Buy v2") }, actor: { kind: "bot", id: "bobby" } }, {});
  const t = await tab();
  try {
    await nav(t, `/dashboard/artifacts/view/${art.id}`);
    assert.ok(await yes(t, "!!document.querySelector('iframe.crow-artifact-frame') && document.querySelector('.cv-version').value === '2'", 15000));
    await sleep(1500);
    assert.equal(await t.evalIn("document.querySelectorAll('.cv-pin').length"), 0, "v1's anchors are never pinned on v2");
    assert.equal(await t.evalIn("document.querySelectorAll('.cv-thread').length"), 0, "v2 lists only v2's threads");
    await t.evalIn("(() => { const s = document.querySelector('.cv-version'); s.value = '1'; s.dispatchEvent(new Event('change')); })()");
    assert.ok(await yes(t, "document.querySelectorAll('.cv-thread').length === 2", 15000), "v1 lists its two threads");
    assert.ok(await yes(t, "document.querySelectorAll('.cv-pin').length === 1", 15000), "one pin: the resolved thread has none");
    assert.equal(await t.evalIn("document.querySelector('.cv-pin').textContent"), "1");
  } finally { await t.close(); }
});
