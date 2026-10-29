// The Chat tab's session list in new mode, LIVE: the real Perch page in the
// real new shell, in a private headless Chrome, against a scripted perch-api.
// At 390x844, en and es, in the Everything scope:
//   - "Start a session" with the lead in plain words; no bot select, no
//     model, no "More options", no directory field;
//   - the sessions are the project home's cards (shared/session-cards.js):
//     a title, the bot, the project, a day; a live dot for a running session
//     and "Waiting" for one waiting on you; never a session id or a state word
//     anywhere on the page;
//   - a card opens its session (in place, or through its project's scope);
//   - the "…" menu opens, moves and closes by keyboard, and Rename and
//     Archive reach their endpoints;
//   - nothing scrolls sideways and every target is at least 44 px.
// Set CHAT_CARDS_SHOTS_DIR (+ CHAT_CARDS_SHOTS_TAG) to save screenshots.
// Skips cleanly without Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PROJECTS = [
  { id: 1, slug: "backyard-garden", name: "Backyard garden" },
  { id: 2, slug: "sunvox", name: "Sunvox" },
];
const PERCH = JSON.stringify({ gateways: [{ type: "perch" }] });
const BOT_DEFS = [
  { bot_id: "grackle-assistant", display_name: "Grackle assistant", definition: PERCH, project_id: null },
  { bot_id: "hank", display_name: "Hank", definition: PERCH, project_id: 2 },
  { bot_id: "watcher", display_name: "Watcher", definition: "{}", project_id: null },
];
const SIDS = { planned: "perchlive-4281879e", untitled: "perchlive-31504cd9", waiting: "perchlive-38b29251", synth: "perchlive-06fe5318" };
const STATE_WORDS = /\b(hibernating|stopped|running|awake|waking|idle|working)\b/i;
const SHOTS = process.env.CHAT_CARDS_SHOTS_DIR || "";
const SHOT_TAG = process.env.CHAT_CARDS_SHOTS_TAG || "after";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
const posts = [];
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace("T", " ");
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      posts.push({ url, body });
      if (url.endsWith("/rename")) return send(res, 200, { label: JSON.parse(body || "{}").label || null });
      return send(res, 200, {});
    });
    return;
  }
  if (url.endsWith("/roost")) {
    return send(res, 200, {
      birds: [
        { id: "grackle-assistant", name: "Grackle assistant", perch_attached: true, state: "hibernating", sessions: [
          { sessionId: SIDS.planned, state: "awake", cardId: 12, pendingUi: false, control: "run", label: "Plan the garden beds", projectId: 1, lastActivityAt: stamp(0) },
          { sessionId: SIDS.untitled, state: "hibernating", cardId: null, pendingUi: false, control: "run", label: null, projectId: null, lastActivityAt: stamp(1) },
        ] },
        { id: "hank", name: "Hank", perch_attached: true, state: "waiting", sessions: [
          { sessionId: SIDS.waiting, state: "awake", cardId: null, pendingUi: true, control: "run", label: "Pick a tempo", projectId: 2, lastActivityAt: stamp(3) },
          { sessionId: SIDS.synth, state: "hibernating", cardId: null, pendingUi: false, control: "run", label: "Synth patch notes", projectId: 2, lastActivityAt: stamp(20) },
        ] },
        { id: "watcher", name: "Watcher", perch_attached: false, state: "observing", sessions: [] },
      ],
      occupiedCardIds: [12],
      archived: [{ sessionId: "perchlive-0a0a0a0a", botId: "hank", botName: "Hank", label: null, state: "hibernating", archivedAt: stamp(2) }],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    req.on("close", () => res.end());
    return;
  }
  if (url.endsWith("/transcript")) return send(res, 200, { events: [] });
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/commands")) return send(res, 200, { commands: [] });
  if (url.endsWith("/models")) return send(res, 200, { models: [{ provider: "zai", id: "glm-5.1", label: "Z.AI GLM-5.1" }], default: "zai/glm-5.1" });
  return send(res, 200, {});
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { tamagotchiHtml, tamagotchiTrayHtml } = await import("../servers/gateway/dashboard/shared/notifications.js");
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
    const lang = /[?&]lang=es\b/.test(req.url) ? "es" : "en";
    req.crowMode = { mode: "new" };
    const hit = PROJECTS.find((p) => new RegExp("[?&]project=" + p.slug + "\\b").test(req.url));
    const scope = hit ? { projectId: hit.id, slug: hit.slug } : { all: true };
    req.crowScope = scope;
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang,
      headerIcons: tamagotchiHtml(lang, { sheet: true }),
      variant: "shell", shell: { scope, projects: PROJECTS, tab: "chat", getPanel: () => null, tray: tamagotchiTrayHtml(lang) } });
    const db = { execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (/pi_bot_defs/.test(sql)) {
        const args = (q && q.args) || [];
        const byProject = /project_id = \?/.test(sql) ? Number(args[0]) : null;
        return { rows: BOT_DEFS.filter((d) => byProject === null || d.project_id === byProject) };
      }
      return { rows: PROJECTS };
    } };
    const html = await perchHubPanel.handler(req, res, { lang, layout, db });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections?.(); server.close(); }
  if (chrome) await chrome.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab({ lang = "en", dark = true, path = "/dashboard/perch", minRows = 4, width = 390, height = 844 } = {}) {
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
  const key = async (k, code) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: code || k, windowsVirtualKeyCode: { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[k] || 0, text: k === "Enter" ? "\r" : undefined });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: code || k });
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await cdp("Page.enable");
  const q = lang === "es" ? (path.includes("?") ? "&" : "?") + "lang=es" : "";
  await cdp("Page.navigate", { url: `http://${HOST}:${port}${path}${q}` });
  await waitFor("document.querySelectorAll('#perch-list-body li, #perch-list-body .roost-row').length>=" + minRows, "the session list");
  await evalIn("new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); })");
  return {
    evalIn, waitFor, key,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    shot: async (file) => {
      const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const READ = `(function(){
  function box(e){ var b=e.getBoundingClientRect(); return {w:b.width,h:b.height,l:b.left,r:b.right}; }
  function shown(e){ return !!e&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0; }
  var list=document.getElementById('perch-list');
  var cards=[].slice.call(document.querySelectorAll('#perch-list-body > ul.ph-list:not(.archived-list) > li.ph-card')).map(function(li){
    var a=li.querySelector('a.ph-row');
    return { href:a.getAttribute('href'), title:a.querySelector('.ph-row-title').textContent,
      meta:(a.querySelector('.ph-meta')||{}).textContent||'', live:!!a.querySelector('.ph-live'),
      liveLabel:(a.querySelector('.ph-live .ph-vh')||{}).textContent||'',
      waiting:(a.querySelector('.ph-kind--waiting')||{}).textContent||'',
      link:box(a), more:box(li.querySelector('.ph-card-more')), moreLabel:li.querySelector('.ph-card-more').getAttribute('aria-label') };
  });
  var targets=[].slice.call(list.querySelectorAll('a,button,select')).filter(shown).map(function(e){
    var b=e.getBoundingClientRect(); return {t:(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,30),w:b.width,h:b.height}; });
  var labels=[].slice.call(list.querySelectorAll('[aria-label]')).map(function(e){ return e.getAttribute('aria-label'); });
  return JSON.stringify({ vw:innerWidth, sw:document.documentElement.scrollWidth, text:document.body.innerText,
    listHtml:list.innerText, labels:labels, cards:cards, targets:targets,
    start:(document.querySelector('[data-ph-start]')||{}).textContent||null,
    lead:(document.querySelector('[data-ph-lead-name]')||{}).textContent||null,
    pick:[].slice.call(document.querySelectorAll('[data-ph-bot] option')).map(function(o){ return o.textContent; }),
    oldLauncher:shown(document.getElementById('perch-new'))||shown(document.getElementById('perch-launch-more'))||shown(document.getElementById('perch-new-bot')),
    heading:(document.querySelector('.perch-list-head h2')||{}).textContent||'' });
})()`;

for (const lang of ["en", "es"]) {
  test(`390x844 ${lang}: Start a session, then plain session cards; no ids or state words`, async (t) => {
    if (!available) return t.skip("no headless Chrome");
    const { t: tr } = await import("../servers/gateway/dashboard/shared/i18n.js");
    const s = await tab({ lang });
    try {
      if (SHOTS && lang === "en") {
        mkdirSync(SHOTS, { recursive: true });
        await s.shot(join(SHOTS, `chat-tab-${SHOT_TAG}.png`));
      }
      const m = await s.json(READ);
      const at = (what) => `${what} (${lang}) ${JSON.stringify({ cards: m.cards, targets: m.targets })}`;
      // Start a session, in plain words; the classic launcher is gone.
      assert.equal(m.start, tr("shell.startSession", lang));
      assert.equal(m.lead, "Grackle assistant", "the lead by name (the first attachable bot)");
      assert.deepEqual(m.pick, ["Grackle assistant", "Hank"], "the attachable bots, the lead first; never the observing bot");
      assert.equal(m.oldLauncher, false, "no bot select, model picker or More options");
      assert.ok(!/More options|Más opciones|GLM/.test(m.text), "no model or options on the page");
      assert.equal(m.heading, tr("shell.earlierSessions", lang));
      // No session id and no state word anywhere, visible or named.
      for (const sid of Object.values(SIDS).concat(["perchlive-0a0a0a0a"])) {
        const hex = sid.replace("perchlive-", "");
        assert.ok(!m.text.includes(hex), at("no session id on the page: " + hex));
        assert.ok(!m.labels.some((l) => l.includes(hex)), at("no session id in a label: " + hex));
      }
      assert.doesNotMatch(m.text, STATE_WORDS, at("no state words on the page"));
      assert.ok(!m.labels.some((l) => STATE_WORDS.test(l)), at("no state words in a label"));
      // The cards: waiting first, then the newest; title, bot · project · day.
      assert.deepEqual(m.cards.map((c) => c.title),
        ["Pick a tempo", "Plan the garden beds", tr("shell.untitledSession", lang), "Synth patch notes"]);
      assert.equal(m.cards[0].waiting, tr("shell.waitingChip", lang), "waiting on you: the Waiting chip");
      assert.equal(m.cards[0].live, false, "a waiting session shows its chip, not the dot");
      assert.equal(m.cards[1].live, true, "a running session shows the live dot");
      assert.equal(m.cards[1].liveLabel, tr("shell.liveSession", lang), "with a visually hidden Live");
      assert.equal(m.cards[2].live, false);
      assert.equal(m.cards[1].meta.split(" · ").slice(0, 2).join(" · "), "Grackle assistant · Backyard garden", "bot · project");
      assert.equal(m.cards[1].meta.split(" · ")[2], tr("shell.today", lang), "a relative day");
      assert.equal(m.cards[2].meta.split(" · ")[1], tr("shell.yesterday", lang), "an unfiled session: bot · day");
      assert.equal(m.cards[0].meta.split(" · ")[1], "Sunvox");
      // Links: a filed session opens through its project; an unfiled one in place.
      assert.equal(m.cards[1].href, "/dashboard/perch?project=backyard-garden#" + SIDS.planned);
      assert.equal(m.cards[2].href, "#" + SIDS.untitled);
      // 44 px targets, nothing sideways.
      for (const x of m.targets) assert.ok(x.w >= 44 && x.h >= 44, at("44 px target: " + x.t));
      for (const c of m.cards) assert.ok(c.link.r <= c.more.l, at("the menu button sits beside the card"));
      assert.ok(m.sw <= m.vw, at("no horizontal scroll"));
    } finally { await s.close(); }
  });
}

test("390x844: a card opens its session in place; a filed one through its project", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab();
  try {
    await s.evalIn(`document.querySelector('a.ph-row[href="#${SIDS.untitled}"]').click(), 1`);
    await s.waitFor(`location.hash==='#${SIDS.untitled}'&&document.body.getAttribute('data-view')==='chat'`, "the untitled session open in place");
    assert.equal(await s.evalIn("location.pathname+location.search"), "/dashboard/perch");
  } finally { await s.close(); }
  const f = await tab();
  try {
    await f.evalIn(`document.querySelector('a.ph-row[href*="${SIDS.planned}"]').click(), 1`);
    await f.waitFor(`location.search==='?project=backyard-garden'&&location.hash==='#${SIDS.planned}'`, "the filed session through its project");
    await f.waitFor("document.body.getAttribute('data-view')==='chat'", "the chat view");
  } finally { await f.close(); }
});

test("390x844: the card menu works by keyboard; Rename and Archive reach their endpoints", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab();
  try {
    posts.length = 0;
    const ACTIVE = "(function(){ var a=document.activeElement; return a?(a.className+'|'+a.textContent):''; })()";
    await s.evalIn("document.querySelectorAll('.ph-card-more')[1].focus(), 1");
    await s.key("Enter");
    await s.waitFor("!!document.querySelector('.ph-card .roost-menu:not([hidden])')", "the menu open");
    assert.equal(await s.evalIn("document.querySelectorAll('.ph-card-more')[1].getAttribute('aria-expanded')"), "true");
    assert.match(await s.evalIn(ACTIVE), /roost-rename\|Rename/, "focus on the first item");
    // The menu's items are 44 px targets.
    const items = await s.json("JSON.stringify([].slice.call(document.querySelectorAll('.ph-card .roost-menu:not([hidden]) button')).map(function(b){ var r=b.getBoundingClientRect(); return [b.textContent,r.width,r.height]; }))");
    assert.deepEqual(items.map((i) => i[0]), ["Rename", "Archive"], "Rename and Archive only");
    for (const [, w, h] of items) assert.ok(w >= 44 && h >= 44, "44 px menu items " + JSON.stringify(items));
    await s.key("ArrowDown");
    assert.match(await s.evalIn(ACTIVE), /roost-archive\|Archive/, "ArrowDown moves to Archive");
    await s.key("Escape");
    await s.waitFor("!document.querySelector('.ph-card .roost-menu:not([hidden])')", "the menu closed");
    assert.match(await s.evalIn(ACTIVE), /ph-card-more/, "Escape returns focus to the menu button");
    // Rename: the prompt answers, the endpoint is called.
    await s.evalIn("window.prompt=function(){ return 'Garden beds, v2'; }, 1");
    await s.key("Enter");
    await s.waitFor("!!document.querySelector('.ph-card .roost-menu:not([hidden])')", "the menu open again");
    await s.key("Enter");
    const until = Date.now() + 4000;
    while (!posts.some((p) => p.url.endsWith("/rename")) && Date.now() < until) await sleep(50);
    const rename = posts.find((p) => p.url.endsWith("/rename"));
    assert.ok(rename, "rename posted");
    assert.equal(rename.url, `/dashboard/perch-api/interactive/${SIDS.planned}/rename`);
    assert.deepEqual(JSON.parse(rename.body), { label: "Garden beds, v2" });
    // Archive, by keyboard.
    await s.waitFor("document.activeElement&&/ph-card-more/.test(document.activeElement.className)", "focus back on a menu button");
    await s.evalIn("document.querySelectorAll('.ph-card-more')[1].focus(), 1");
    await s.key("ArrowDown");
    await s.waitFor("!!document.querySelector('.ph-card .roost-menu:not([hidden])')", "the menu open by ArrowDown");
    await s.key("ArrowDown");
    await s.key("Enter");
    const until2 = Date.now() + 4000;
    while (!posts.some((p) => p.url.endsWith("/archive")) && Date.now() < until2) await sleep(50);
    assert.equal(posts.find((p) => p.url.endsWith("/archive"))?.url, `/dashboard/perch-api/interactive/${SIDS.planned}/archive`);
  } finally { await s.close(); }
});

test("390x844: a project's Chat offers that project's bots; the card names no project", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab({ path: "/dashboard/perch?project=sunvox", minRows: 2 });
  try {
    const m = await s.json(READ);
    assert.equal(m.lead, "Hank");
    assert.deepEqual(m.pick, [], "one bot: nothing to pick");
    assert.equal(await s.evalIn("document.querySelector('[data-ph-start-root]').getAttribute('data-project-id')"), "2");
    const sunvox = m.cards.filter((c) => c.title === "Pick a tempo")[0];
    assert.ok(sunvox, "the project's session is listed");
    assert.ok(!sunvox.meta.includes("Sunvox"), "the page is the project's: its name is not repeated on the card");
    assert.equal(sunvox.href, "#" + SIDS.waiting, "in scope: opens in place");
  } finally { await s.close(); }
});

test("1280x800: the same cards in the left column, beside an open session", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab({ width: 1280, height: 800 });
  try {
    if (SHOTS) await s.shot(join(SHOTS, `chat-tab-${SHOT_TAG}-1280.png`));
    await s.evalIn(`document.querySelector('a.ph-row[href="#${SIDS.untitled}"]').click(), 1`);
    await s.waitFor("document.body.getAttribute('data-view')==='chat'", "the chat view");
    const m = await s.json(`(function(){ function b(id){ var r=document.getElementById(id).getBoundingClientRect(); return {l:r.left,r:r.right,w:r.width}; }
      return JSON.stringify({ list:b('perch-list'), chat:b('perch-chat'), cards:document.querySelectorAll('#perch-list-body li.ph-card').length,
        start:!!document.querySelector('#perch-list [data-ph-start]'), sw:document.documentElement.scrollWidth, vw:innerWidth }); })()`);
    assert.ok(m.cards >= 4 && m.start, JSON.stringify(m));
    assert.ok(m.list.w > 0 && m.list.r <= m.chat.l + 1, "the list is the left column: " + JSON.stringify(m));
    assert.ok(m.sw <= m.vw, "no horizontal scroll");
  } finally { await s.close(); }
});
