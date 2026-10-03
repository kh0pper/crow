// Perch on a phone: the pending ask_user card must fit between the banner and
// the composer (Kevin's Pixel 9a report, 2026-10-02 — the bottom tab bar and the
// composer were painted over Send answer / Cancel, and the transcript was
// squeezed to a 24px sliver under the banner).
//
// Two layers:
//   • static assertions on the emitted CSS / client script (always run);
//   • a live layout check in the shared CDP Chrome (skips without one).
//
// The live part is hermetic on purpose (see the F1b note in
// tests/perch-hub-render.test.js): its own http server on an ephemeral port,
// its own tab, its own scripted perch-api whose SSE stream pushes the card,
// and it POLLS for the rendered card instead of sleeping a fixed budget — the
// suite's CDP tests share one Chrome, and fixed sleeps are what flake there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const CDP = process.env.CROW_CDP_URL ||
  ("http://127.0.0.1:" + (process.env.CROW_BROWSER_CDP_PORT || "9223"));
const HOST_FROM_CONTAINER = process.env.CROW_CDP_HOST_IP || "172.17.0.1";
const SID = "perchlive-9e2b9bf3";

// The exact card in Kevin's screenshot: one question, four options + Other.
const CARD = {
  requestId: "req-1", method: "questions",
  questions: [{
    header: "Onboarding", question: "What kind of onboarding do you need?",
    options: [
      { label: "Walk me through features", description: "A guided tour of how Crow works — memory, sharing, messaging, research" },
      { label: "Connect a new contact", description: "Generate an invite or pairing code for someone new" },
      { label: "Set up a new device", description: "Point another Crow installation at your existing network" },
      { label: "Onboard someone else", description: "Help a friend/colleague get started with their own Crow" },
    ],
  }],
};

// ─── static ────────────────────────────────────────────────────────────────

test("css: the ask pane can shrink, its questions scroll, its foot stays", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /#perch-ask\{[^}]*flex:0 1 auto[^}]*min-height:0/,
    "#perch-ask must be shrinkable (min-height:0) — without it the flex default min-height:auto keeps the whole card and overflows the column");
  assert.match(css, /#perch-ask:not\(:empty\)\{min-height:/,
    "a floor keeps Send answer in the pane on a landscape phone");
  assert.match(css, /\.ask-body\{[^}]*min-height:0[^}]*overflow-y:auto/, "the questions scroll inside the card");
  assert.match(css, /\.ask-combined \.ask-foot\{flex-shrink:0\}/, "Send answer / Cancel never shrink away");
  assert.match(css, /#perch-tab-chat > #perch-transcript\{min-height:min\(/, "the transcript keeps a readable floor");
  assert.match(css, /#perch-ask:not\(:empty\) ~ #perch-working\{display:none\}/, "no Working… strip while the bot waits on you");
  assert.match(css, /#perch-transcript\{-webkit-mask-image:linear-gradient\(to bottom,transparent 0,#000 12px\)/,
    "the scrolled-away sliver under the banner is faded, not drawn flush against it");
});

test("client: the combined card wraps its questions in .ask-body and the foot is outside it", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  assert.match(js, /qbody\.className='ask-body'/);
  assert.match(js, /qbody\.appendChild\(qd\)/);
  assert.match(js, /frame\.appendChild\(qbody\)/);
  assert.match(js, /frame\.appendChild\(foot\)/);
});

// ─── live ──────────────────────────────────────────────────────────────────

let available = false, server = null, port = 0;
let TRANSCRIPT = [];
const MD = "Here is the plan:\n\n- **Backups**: nightly DB dumps to local/S3/git\n- Second point with `inline code`\n\n" +
  "```js\nconst x = await fetch('/dashboard/perch-api/interactive/perchlive-9e2b9bf3/events');\n```\n\n" +
  "| Model | Context | Notes |\n|---|---|---|\n| crow-local/qwen3.6-35b-a3b | 256K | the default chat model |\n\nWant a demo?";

function serveApi(req, res) {
  const url = req.url.split("?")[0];
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.endsWith("/roost")) return send(200, { birds: [{ id: "hank", name: "Hank", perch_attached: true, state: "working",
    sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: true, label: null }] }], occupiedCardIds: [] });
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    res.write("event: tool\ndata: " + JSON.stringify({ phase: "start", name: "ask_user", id: "t1", toolCallId: "t1" }) + "\n\n");
    res.write("event: ask_user\ndata: " + JSON.stringify(CARD) + "\n\n");
    return;                                    // stays open, like the real stream
  }
  if (url.endsWith("/transcript")) return send(200, { events: TRANSCRIPT });
  return send(200, {});
}

before(async () => {
  try {
    const r = await fetch(CDP + "/json/version", { signal: AbortSignal.timeout(2000) });
    available = r.ok;
  } catch { available = false; }
  if (!available) return;
  const { renderMarkdown } = await import("../servers/blog/renderer.js");
  TRANSCRIPT = [
    { type: "message", message: { role: "user", content: "What can Crow do? Give me the overview, with a table." } },
    { type: "message", message: { role: "assistant", content: MD }, html: renderMarkdown(MD) },
  ];
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  port = server.address().port;
});

after(() => { if (server) server.close(); });

/** Open a tab at w x h on the session deep link, wait (by polling) until
 *  `ready` is true in the page, run `expression`, close the tab. `css` is
 *  appended to <head> first, so a test can knock a rule out. */
async function measure(w, h, expression, { css = "", ready = "!!document.querySelector('#perch-ask .ask-send')" } = {}) {
  const tab = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
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
  const evalIn = async (expr) => {
    const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://${HOST_FROM_CONTAINER}:${port}/dashboard/perch#${SID}` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) {          // up to 15s, typically < 1s
      await new Promise((r) => setTimeout(r, 200));
      try { ok = await evalIn(ready); } catch { ok = false; }
    }
    assert.ok(ok, "the page never reached its ready state: " + ready);
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    // Two frames so a class toggle or the appended style has been laid out.
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    const value = JSON.parse(await evalIn(expression));
    // Hermetic: the text-size step persists in this origin's localStorage, and
    // every test here shares one origin. Leave nothing behind for the next.
    await evalIn("(function(){try{localStorage.removeItem('crow-text-size');localStorage.removeItem('crow.perch.textSize');document.documentElement.removeAttribute('data-text-size');}catch(e){}return 1;})()");
    return value;
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

const ASK_GEOMETRY = `(function(){
  function box(e){ var b=e.getBoundingClientRect(); return {top:b.top,bottom:b.bottom,h:b.height}; }
  function hit(e){ var b=e.getBoundingClientRect(); var x=b.left+b.width/2, y=b.top+b.height/2;
    var t=document.elementFromPoint(x,y); return !!t&&(t===e||e.contains(t)); }
  var send=document.querySelector('#perch-ask .ask-send');
  var cancel=document.querySelector('#perch-ask .ask-foot .quiet');
  var tc=document.getElementById('perch-tab-chat');
  var tr=document.getElementById('perch-transcript');
  var body=document.querySelector('#perch-ask .ask-body');
  var cb=document.querySelector('.content-body');
  return JSON.stringify({ vh:innerHeight,
    send:box(send), sendHit:hit(send), cancelHit:hit(cancel),
    ask:box(document.getElementById('perch-ask')), composer:box(document.getElementById('perch-composer')),
    tabs:box(document.getElementById('perch-tabs')), transcriptH:tr.getBoundingClientRect().height,
    tabChatOverflow:tc.scrollHeight-tc.clientHeight, contentBodyScroll:cb.scrollHeight-cb.clientHeight,
    bodyScrolls:body.scrollHeight>body.clientHeight+1 });
})()`;

// 412x760 is the Pixel 9a's portrait viewport with the browser's own bars
// showing — the size that reproduced the report on both 6445b583 and #404.
for (const [w, h] of [[412, 760], [412, 915]]) {
  test(`live @${w}x${h}: Send answer and Cancel sit above the composer and the tab bar, and are tappable`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    const m = await measure(w, h, ASK_GEOMETRY);
    assert.equal(m.sendHit, true, "Send answer is covered: " + JSON.stringify(m));
    assert.equal(m.cancelHit, true, "Cancel is covered: " + JSON.stringify(m));
    assert.ok(m.ask.bottom <= m.composer.top + 0.5, "the card runs under the composer: " + JSON.stringify(m));
    assert.ok(m.composer.bottom <= m.tabs.top + 0.5, "the composer runs under the tab bar: " + JSON.stringify(m));
    assert.equal(m.tabChatOverflow, 0, "the chat column overflows");
    assert.equal(m.contentBodyScroll, 0, "the page itself scrolls");
    assert.ok(m.transcriptH >= 40, "the transcript was squeezed to " + m.transcriptH + "px");
  });
}

test("live @412x760: the test reaches the mechanism — without the pane's min-height:0 Send answer is covered again", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const m = await measure(412, 760, ASK_GEOMETRY, { css: "#perch-ask{min-height:auto !important}" });
  assert.equal(m.sendHit && m.cancelHit, false,
    "with the fix knocked out the bug must come back, or the tests above prove nothing: " + JSON.stringify(m));
});

test("live @1280x900: the desktop card is untouched — full height, nothing scrolls inside it", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const m = await measure(1280, 900, ASK_GEOMETRY);
  assert.equal(m.sendHit, true);
  assert.equal(m.bodyScrolls, false, "the desktop card must show every option without an inner scroll");
  assert.equal(m.contentBodyScroll, 0);
});

// ─── phone transcript: full-width messages under 600px ────────────────────

test("css: under .perch-narrow the message row wraps and the body takes the full width", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /#perch-hub-root\.perch-narrow \.entry\{flex-wrap:wrap/);
  assert.match(css, /#perch-hub-root\.perch-narrow \.what\{flex:1 1 100%;order:2\}/);
  // The desktop rule is untouched: the 64px gutter is still the default.
  assert.match(css, /#perch-hub-root \.who\{flex:0 0 64px/);
});

const MSG_GEOMETRY = `(function(){
  var tr=document.getElementById('perch-transcript').getBoundingClientRect();
  var bot=document.querySelector('#perch-transcript .entry.bot');
  var who=bot.querySelector('.who').getBoundingClientRect(), what=bot.querySelector('.what').getBoundingClientRect();
  var table=bot.querySelector('table'), pre=bot.querySelector('pre');
  return JSON.stringify({ narrow:/(^|\\s)perch-narrow(\\s|$)/.test(document.getElementById('perch-hub-root').className),
    trLeft:tr.left, trWidth:tr.width, whoBottom:who.bottom, whatTop:what.top, whatLeft:what.left, whatWidth:what.width,
    tableRight:table.getBoundingClientRect().right, preRight:pre.getBoundingClientRect().right, trRight:tr.right,
    docScrollX:document.documentElement.scrollWidth-innerWidth });
})()`;
const MSG_READY = "!!document.querySelector('#perch-transcript .entry.bot table')";

test("live @412x915: messages use the full width, the role label sits above them", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const m = await measure(412, 915, MSG_GEOMETRY, { ready: MSG_READY });
  assert.equal(m.narrow, true);
  assert.ok(Math.abs(m.whatLeft - m.trLeft) <= 1, "no gutter: " + JSON.stringify(m));
  assert.ok(m.whatWidth >= m.trWidth - 30, "the message spans the column: " + JSON.stringify(m));
  assert.ok(m.whatTop >= m.whoBottom - 1, "the label is on its own line above: " + JSON.stringify(m));
  assert.ok(m.tableRight <= m.trRight + 1 && m.preRight <= m.trRight + 1, "wide content stays inside: " + JSON.stringify(m));
  assert.equal(m.docScrollX, 0, "no horizontal page scroll");
});

test("live @1280x900: the desktop keeps the role gutter", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const m = await measure(1280, 900, MSG_GEOMETRY, { ready: MSG_READY });
  assert.equal(m.narrow, false);
  assert.ok(m.whatLeft - m.trLeft >= 64, "the body sits beside the 64px label column: " + JSON.stringify(m));
});

// ─── text size ─────────────────────────────────────────────────────────────

test("css: every font size is scaled by --pts, which only the chat tab changes", async () => {
  const { perchHubCss, scaleFontSizes } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  assert.equal(scaleFontSizes("a{font-size:13px}b{font:500 14px/1 Inter}c{font:11px/1.6 mono}d{font:inherit}"),
    "a{font-size:calc(13px * var(--pts,1))}b{font:500 calc(14px * var(--pts,1))/1 Inter}c{font:calc(11px * var(--pts,1))/1.6 mono}d{font:inherit}");
  const css = perchHubCss().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /font-size:\s*\d+(\.\d+)?px/, "an unscaled font-size would ignore the text-size control");
  assert.doesNotMatch(css, /font:(\s*\d{3})?\s*\d+(\.\d+)?px/, "an unscaled font shorthand would ignore it too");
  assert.match(css, /#perch-hub-root\{--pts:1\}/);
  assert.match(css, /#perch-tab-chat\{--pts:var\(--crow-text-scale,1\)/, "the chat tab reads the DASHBOARD-WIDE scale");
  assert.doesNotMatch(css, /--perch-text-scale/, "no Perch-only scale left to diverge");
});

test("html: the Session tab carries A− / A / A+ with translated aria-labels (en + es)", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const key of ["perch.textSize", "perch.textSmaller", "perch.textDefault", "perch.textLarger"]) {
    for (const lang of ["en", "es"]) {
      const v = t(key, lang);
      assert.ok(v && v !== key, key + " has a " + lang + " string");
    }
    assert.notEqual(t(key, "es"), t(key, "en"), key + " is actually translated");
  }
  const src = (await import("node:fs")).readFileSync(new URL("../servers/gateway/dashboard/perch-hub/html.js", import.meta.url), "utf8");
  const session = src.slice(src.indexOf('id="perch-tab-session"'), src.indexOf('id="perch-tab-files"'));
  for (const id of ["perch-text-smaller", "perch-text-reset", "perch-text-larger", "perch-text-size-value"]) {
    assert.ok(session.includes('id="' + id + '"'), id + " lives in the Session tab");
  }
  assert.match(session, /id="perch-text-smaller" aria-label="\$\{escapeHtml\(t\("perch\.textSmaller", lang\)\)\}"/);
  assert.match(session, /id="perch-text-larger" aria-label="\$\{escapeHtml\(t\("perch\.textLarger", lang\)\)\}"/);
});

const BIGGEST = `(function(){ var b=document.getElementById('perch-text-larger'); for(var i=0;i<6;i++) b.click(); return 1; })()`;
const TEXT_GEOMETRY = `(function(){
  function fs(sel){ var e=document.querySelector(sel); return e?parseFloat(getComputedStyle(e).fontSize):null; }
  function hit(e){ var b=e.getBoundingClientRect(); var x=b.left+b.width/2, y=b.top+b.height/2;
    var t=document.elementFromPoint(x,y); return !!t&&(t===e||e.contains(t)); }
  var send=document.getElementById('perch-send');
  return JSON.stringify({ step:document.documentElement.getAttribute('data-text-size'),
    entry:fs('#perch-transcript .entry.bot'), input:fs('#perch-input'), sendFs:fs('#perch-send'),
    tabs:fs('#perch-tabs button'), close:fs('#perch-close'),
    sendHit:hit(send), docScrollX:document.documentElement.scrollWidth-innerWidth,
    trScrollX:(function(){var t=document.getElementById('perch-transcript'); return t.scrollWidth-t.clientWidth;})(),
    contentBodyScroll:(function(){var c=document.querySelector('.content-body'); return c.scrollHeight-c.clientHeight;})() });
})()`;

test("live @412x915: the largest text step scales the chat tab only, and nothing breaks", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const base = await measure(412, 915, TEXT_GEOMETRY, { ready: MSG_READY });
  const m = await measure(412, 915, "(function(){" + "var x=" + BIGGEST + ";return " + TEXT_GEOMETRY + "})()", { ready: MSG_READY });
  assert.equal(m.step, "xlarge");
  assert.ok(Math.abs(m.entry - base.entry * 1.4) < 0.2, "message text x1.4: " + base.entry + " -> " + m.entry);
  assert.ok(Math.abs(m.input - base.input * 1.4) < 0.2, "composer x1.4: " + base.input + " -> " + m.input);
  assert.equal(m.tabs, base.tabs, "the tab bar keeps its size");
  assert.equal(m.close, base.close, "the Session tab keeps its size");
  assert.equal(m.sendHit, true, "Send stays reachable");
  assert.equal(m.docScrollX, 0, "no horizontal page scroll");
  assert.equal(m.trScrollX, 0, "the transcript does not scroll sideways");
  assert.equal(m.contentBodyScroll, 0, "the page does not scroll");
});

test("live @412x760: at the largest text step the ask card's Send answer / Cancel are still tappable", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const m = await measure(412, 760, "(function(){var x=" + BIGGEST + ";return " + ASK_GEOMETRY + "})()");
  assert.equal(m.sendHit, true, JSON.stringify(m));
  assert.equal(m.cancelHit, true, JSON.stringify(m));
  assert.equal(m.tabChatOverflow, 0);
});
