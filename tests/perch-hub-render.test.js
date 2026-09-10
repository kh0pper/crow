// The drawer's defining mobile failure was Send sitting below the viewport at
// every scroll position except the very bottom. Assert reachability with the
// transcript scrolled to the TOP, which is where a reader starts. A screenshot
// did not catch this; getBoundingClientRect did.
//
// This renders through the REAL dashboard shell now (the panel handler +
// renderLayout), not perchHubDocument() in isolation — Perch no longer owns
// its own document, so testing it standalone would miss the exact CSS chain
// (layout.js's "body:has(#perch-chat)" rules -> perch-hub/css.js's
// #perch-hub-root/.hub-split/#perch-chat flex chain) that reachability now
// depends on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// The repo's convention is CROW_BROWSER_CDP_PORT (tests/pibot-crow-server-catalog.test.js:38).
const CDP = process.env.CROW_CDP_URL ||
  ("http://127.0.0.1:" + (process.env.CROW_BROWSER_CDP_PORT || "9223"));
// The CDP browser runs in Docker: it cannot reach 127.0.0.1 on the host, and
// file:// is unreachable entirely. Bind 0.0.0.0 and navigate to the bridge.
const HOST_FROM_CONTAINER = process.env.CROW_CDP_HOST_IP || "172.17.0.1";

let available = false, server = null, port = 0;

// ---------------------------------------------------------------------------
// Task C — a scripted perch-api, so the real client can be driven into the
// exact state Kevin reported: ONE perch-attached bot with several live
// sessions and therefore NO idle row to spawn from. An empty roost would not
// reproduce the bug; it passes against the broken build.
// ---------------------------------------------------------------------------
const SIDS = ["perchlive-11111111", "perchlive-22222222", "perchlive-33333333"];
let liveSids = SIDS.slice();
const stopped = [];
function resetApi() { liveSids = SIDS.slice(); stopped.length = 0; roostFails = false; }

let roostFails = false;
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.endsWith("/roost")) {
    if (roostFails) return send(503, { error: "upstream" });
    return send(200, {
      birds: [{
        id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: liveSids.map((sid) => ({ sessionId: sid, state: "awake",
          cardId: sid === "perchlive-11111111" ? 248 : null, pendingUi: false })),
      }],
      occupiedCardIds: [],
    });
  }
  const stop = url.match(/\/interactive\/([^/]+)\/stop$/);
  if (stop && req.method === "POST") {
    const sid = decodeURIComponent(stop[1]);
    stopped.push(sid);
    liveSids = liveSids.filter((s) => s !== sid);      // the engine parks the row
    return send(200, { ok: true });
  }
  if (url.endsWith("/events")) {
    // A real SSE connection that stays open and sends nothing: without it the
    // EventSource errors immediately and the client's terminal-status probe
    // bounces the operator back to the list on its own, which would fake a
    // pass on "closing the open session returns to the list".
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    return;
  }
  if (url.endsWith("/options")) return send(200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/transcript")) return send(200, { events: [] });
  if (url.endsWith("/interactive") && req.method === "POST") return send(200, { sessionId: "perchlive-99999999" });
  return send(200, {});
}

before(async () => {
  try {
    const r = await fetch(CDP + "/json/version", { signal: AbortSignal.timeout(2000) });
    available = r.ok;
  } catch { available = false; }
  if (!available) return;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  server = http.createServer(async (req, res) => {
    // Task C: the same real client script, in the same real browser, now with
    // a scripted /dashboard/perch-api behind it — otherwise every fetch it
    // makes 404s and the list can never reach the state being tested.
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  port = server.address().port;
});

after(() => { if (server) server.close(); });

/** Open a tab, run one expression, return its value, close the tab. */
async function evaluate(width, height, expression) {
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
  try {
    await send("Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 2, mobile: width < 900 });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://${HOST_FROM_CONTAINER}:${port}/dashboard/perch` });
    await new Promise((r) => setTimeout(r, 1500));
    const out = await send("Runtime.evaluate", { expression, returnByValue: true });
    // Without this, an expression that threw returns undefined and the caller's
    // JSON.parse fails with "undefined is not valid JSON" — a confusing error
    // instead of the real one.
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    if (out.result.value === undefined) throw new Error("expression produced no value");
    return out.result.value;
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

// 60 lines, not 16: enough that the transcript's OWN content height clearly
// exceeds both tested viewports (730px and 900px) on its own, which the
// mutation-driven tests further down need in order to produce real overflow.
//
// ⚠ Length alone does NOT make the #perch-chat flex rules provable through
// the two reachability tests below. Re-measured 2026-09-10: delete
// #perch-chat's flex:1/min-height:0 with all 60 lines seeded and Send is
// still at 668-704 / 854-890 and still reachable — position:sticky picks it
// up and both tests stay green. What changes is .content-body's scroll
// height (0 -> 3001 / 1431), which is why the pair of tests below measure
// that instead. An earlier version of this comment claimed the opposite.
// `mutation` is extra CSS appended to <head> before the measurement, so a
// test can knock out one rule at a time in the live page and observe what
// actually changes. That is the only way to tell which of the two competing
// mechanisms (the #perch-chat flex chain vs #perch-composer's sticky) is
// carrying reachability — mutating only one of them and watching this file
// stay green is exactly how the earlier comment in perch-hub-page.test.js
// reached the inverse conclusion.
const seedAndMeasure = (mutation = "") => `
(function(){
  ${mutation ? `var s=document.createElement('style');s.textContent=${JSON.stringify(mutation)};document.head.appendChild(s);` : ""}
  document.body.setAttribute('data-view','chat');
  var tr=document.getElementById('perch-transcript');
  for(var i=0;i<60;i++){ var d=document.createElement('div');
    d.textContent='bot: a transcript line long enough to take a row or two, number '+i;
    tr.appendChild(d); }
  tr.scrollTop=0;                                  // where a reader starts
  var cb=document.querySelector('.content-body');
  var b=document.getElementById('perch-send').getBoundingClientRect();
  return JSON.stringify({viewport:innerHeight,top:Math.round(b.top),
    bottom:Math.round(b.bottom),reachable:b.bottom<=innerHeight&&b.top>=0,
    contentBodyScroll:cb.scrollHeight-cb.clientHeight,
    composerPosition:getComputedStyle(document.getElementById('perch-composer')).position});
})()`;
const SEED_AND_MEASURE = seedAndMeasure();

// The flex chain, expressed as the browser would have to see it removed.
// Matches deleting `flex:1;min-height:0` from #perch-chat in
// perch-hub/css.js — the rule perch-hub-page.test.js pins statically.
const NO_FLEX_CHAIN = "#perch-chat{flex:none !important;min-height:auto !important}";

test("the crow sidebar is present on /dashboard/perch", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const present = JSON.parse(await evaluate(1280, 900, `
    JSON.stringify({ sidebar: !!document.querySelector('.sidebar'),
      perch: !!document.getElementById('perch-hub-root') })`));
  assert.equal(present.sidebar, true, "the regression this feature fixes: the nav must not vanish on this page");
  assert.equal(present.perch, true);
});

test("Send is reachable at 412x730 with the transcript scrolled to the top", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const measured = JSON.parse(await evaluate(412, 730, SEED_AND_MEASURE));
  assert.equal(measured.reachable, true,
    `Send at ${measured.top}-${measured.bottom} in a ${measured.viewport}px viewport`);
});

test("Send is reachable at 1280x900 with the transcript scrolled to the top", async (t) => {
  // The shell's app-shell height-clamp (layout.js's "body:has(#perch-chat)"
  // rules) is NOT width-scoped — unlike the pre-existing ≤768px-only mobile
  // behaviour it mirrors, it applies at every width, so this must hold on
  // desktop too, not just on a phone.
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const measured = JSON.parse(await evaluate(1280, 900, SEED_AND_MEASURE));
  assert.equal(measured.reachable, true,
    `Send at ${measured.top}-${measured.bottom} in a ${measured.viewport}px viewport`);
});

// ─── which mechanism actually carries Send's reachability ─────────────────
// These two pin the relationship the round-1 review corrected: the flex
// chain is the mechanism, sticky is the backstop. Without them, a maintainer
// can delete either rule and every other test in this file stays green,
// because whichever rule survives masks the loss of the other.

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`the flex chain keeps .content-body from scrolling at all at ${w}x${h}`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    // This — not sticky — is what makes Send reachable in the shipped
    // configuration. #perch-chat resolving against the definite height
    // .content-body hands it means the panel never overflows, so there is
    // no scroll position from which Send could be off-screen. Remove
    // #perch-chat's flex:1/min-height:0 and this goes to 3001 (412x730) /
    // 1431 (1280x900) while the reachability tests above stay green.
    const m = JSON.parse(await evaluate(w, h, SEED_AND_MEASURE));
    assert.equal(m.contentBodyScroll, 0,
      `.content-body must not scroll; it scrolls ${m.contentBodyScroll}px, so the flex chain is broken ` +
      "and only #perch-composer's sticky is still holding Send on screen");
  });

  test(`sticky is the backstop: Send survives a broken flex chain at ${w}x${h}`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    // The other direction. With the flex chain knocked out, .content-body
    // genuinely overflows — and position:sticky;bottom:0 is then the only
    // thing keeping Send on screen (measured: drop sticky too and Send
    // lands at 3685 / 2285, far below the fold). This is the state in which
    // sticky does real work, and the reason it is not dead code.
    const m = JSON.parse(await evaluate(w, h, seedAndMeasure(NO_FLEX_CHAIN)));
    assert.ok(m.contentBodyScroll > 0,
      "the mutation must actually produce overflow, or this proves nothing");
    assert.equal(m.composerPosition, "sticky",
      "#perch-composer must still be sticky — that is the rule under test");
    assert.equal(m.reachable, true,
      `Send at ${m.top}-${m.bottom} in a ${m.viewport}px viewport with ${m.contentBodyScroll}px of overflow`);
  });
}

test("both views are visible side by side at desktop width", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const visible = JSON.parse(await evaluate(1280, 900, `
    (function(){
      document.body.setAttribute('data-view','chat');
      var vis=function(id){ var e=document.getElementById(id);
        return getComputedStyle(e).display !== 'none'; };
      return JSON.stringify({list:vis('perch-list'),chat:vis('perch-chat')});
    })()`));
  assert.equal(visible.list, true, "the min-width:900px split keeps the list up");
  assert.equal(visible.chat, true);
});

// ---------------------------------------------------------------------------
// Task C — live in a real browser, at both viewports. These drive the REAL
// onclick handlers on the REAL rendered page against the scripted perch-api
// above, and read the resulting DOM back. The vm harness in
// perch-hub-client.test.js proves the calls and the bodies; only this proves
// the controls are on screen, hit-testable, and inside the viewport at 412px.
// ---------------------------------------------------------------------------

/** A tab that stays open across several evaluations, unlike evaluate() above
 *  which opens and closes one per call — clicking and then reading the result
 *  has to happen in the same document. */
async function session(width, height) {
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
  await send("Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 2, mobile: width < 900 });
  await send("Page.enable");
  await send("Page.navigate", { url: `http://${HOST_FROM_CONTAINER}:${port}/dashboard/perch` });
  await new Promise((r) => setTimeout(r, 1500));
  const evalIn = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  return {
    evalIn,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + tab.id).catch(() => {}); },
  };
}

/** confirm() blocks a real browser tab, so it is replaced with a recorder.
 *  The gate itself is proved in perch-hub-client.test.js (a cancelled confirm
 *  posts nothing); what these tests need is the path PAST it. */
const STUB_CONFIRM = `(function(){ window.__asked=[];
  window.confirm=function(m){ window.__asked.push(String(m)); return true; }; return 'ok'; })()`;

const ROW_STATE = `JSON.stringify({
  sids: Array.from(document.querySelectorAll('#perch-list-body .roost-row .roost-cwd')).length,
  closes: Array.from(document.querySelectorAll('#perch-list-body .roost-close')).length,
  rows: document.querySelectorAll('#perch-list-body .roost-row').length })`;

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`C1 live @${w}x${h}: the launch control is on screen while EVERY attached bot is busy`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      const seen = await s.json(`(function(){
        var b=document.getElementById('perch-new');
        var r=b.getBoundingClientRect();
        var cs=getComputedStyle(b);
        var doc=document.documentElement;
        return JSON.stringify({
          rows: document.querySelectorAll('#perch-list-body .roost-row').length,
          talk: Array.from(document.querySelectorAll('#perch-list-body button'))
                  .filter(function(x){return x.textContent==='Talk';}).length,
          disabled: b.disabled, display: cs.display, visibility: cs.visibility,
          w: Math.round(r.width), h: Math.round(r.height),
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          inViewport: r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth,
          // hit-testable: the point the thumb lands on resolves to this button
          hit: (function(){ var e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
                            return !!e && (e===b || b.contains(e)); })(),
          hScroll: doc.scrollWidth > doc.clientWidth
        });
      })()`);
      assert.equal(seen.rows, 3, "the roost fixture must actually be in the reported state");
      assert.equal(seen.talk, 0,
        "fixture check: every attached bot is busy, so listRows() emits NO idle row — this is the bug");
      assert.equal(seen.disabled, false, "the launcher must be usable in exactly that state");
      assert.equal(seen.display !== "none" && seen.visibility !== "hidden", true, "and visible");
      assert.equal(seen.inViewport, true,
        `the launcher sits at ${seen.top}-${seen.bottom} in a ${h}px viewport`);
      assert.equal(seen.hit, true, "and nothing overlaps it — a thumb there hits the button");
      // 44, not 40. The commit that introduced this asserted >=40 while its
      // message and its CSS both claimed a 44px floor, so the suite did not pin
      // the floor the code stated.
      assert.ok(seen.w >= 44 && seen.h >= 44, `tap target ${seen.w}x${seen.h} is too small for a thumb`);
      assert.equal(seen.hScroll, false, "no horizontal scroll at " + w + "px");
    } finally { await s.close(); }
  });

  test(`C2 live @${w}x${h}: closing a session removes it from the list`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      await s.evalIn(STUB_CONFIRM);
      const before = await s.json(ROW_STATE);
      assert.equal(before.rows, 3);
      assert.equal(before.closes, 3, "every live row needs its own close control");

      // A real click on the real button, dispatched by the browser.
      await s.evalIn(`document.querySelectorAll('#perch-list-body .roost-close')[0].click(); 'clicked'`);
      await new Promise((r) => setTimeout(r, 800));

      const asked = await s.json(`JSON.stringify(window.__asked)`);
      assert.equal(asked.length, 1, "the operator was asked before anything terminal happened");
      assert.match(asked[0], /cannot be reopened/i);
      assert.deepEqual(stopped, ["perchlive-11111111"], "the server saw exactly one stop, for that row");

      const after = await s.json(ROW_STATE);
      assert.equal(after.rows, 2, "the closed session must be gone from the list, not merely greyed");
    } finally { await s.close(); }
  });

  test(`C2 live @${w}x${h}: closing the OPEN session returns to the list`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      await s.evalIn(STUB_CONFIRM);
      await s.evalIn(`location.hash='perchlive-22222222'; 'go'`);
      await new Promise((r) => setTimeout(r, 800));
      const inChat = await s.json(`JSON.stringify({
        view: document.body.getAttribute('data-view'),
        meta: document.getElementById('perch-session-meta').textContent })`);
      assert.equal(inChat.view, "chat");
      assert.equal(inChat.meta, "perchlive-22222222", "precondition: that session is the one open");

      const btn = await s.json(`(function(){
        var b=document.getElementById('perch-close'), r=b.getBoundingClientRect();
        return JSON.stringify({ inViewport: r.top>=0 && r.bottom<=innerHeight,
          hit: (function(){ var e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                            return !!e && (e===b||b.contains(e)); })(),
          w: Math.round(r.width), h: Math.round(r.height),
          padding: getComputedStyle(b).padding, fontSize: getComputedStyle(b).fontSize });
      })()`);
      assert.equal(btn.inViewport, true, "close must be reachable without scrolling the chat");
      assert.equal(btn.hit, true);
      // The number this test already COLLECTED and never asserted. It measured
      // 36px live: a bare "#perch-close" rule is (1,0,0) and loses to
      // "#perch-hub-root button" at (1,0,1), so neither of its declarations
      // applied — and the one irreversible control in the chat view shipped as
      // the smallest target on a page whose reason for existing is a phone,
      // in the same commit that raised the launch buttons to 44px.
      assert.ok(btn.h >= 44,
        `Close is ${btn.w}x${btn.h}; the irreversible control must clear the 44px thumb target`);
      assert.equal(btn.padding, "8px 12px",
        "the scoped rule must actually win the cascade, not merely be present in the sheet");
      assert.equal(btn.fontSize, "13px");

      // Send must still be reachable — the close control must not have
      // disturbed the sticky composer this page's mobile fix rests on.
      const sendBox = await s.json(`(function(){
        var r=document.getElementById('perch-send').getBoundingClientRect();
        return JSON.stringify({ reachable: r.bottom<=innerHeight && r.top>=0,
                                top: Math.round(r.top), bottom: Math.round(r.bottom), vp: innerHeight });
      })()`);
      assert.equal(sendBox.reachable, true,
        `Send at ${sendBox.top}-${sendBox.bottom} in a ${sendBox.vp}px viewport`);

      await s.evalIn(`document.getElementById('perch-close').click(); 'clicked'`);
      await new Promise((r) => setTimeout(r, 800));

      assert.deepEqual(stopped, ["perchlive-22222222"]);
      const back = await s.json(`JSON.stringify({
        view: document.body.getAttribute('data-view'), hash: location.hash,
        rows: document.querySelectorAll('#perch-list-body .roost-row').length })`);
      assert.equal(back.view, "list", "an operator must not be left in a chat whose stream is dead");
      assert.equal(back.hash, "", "and the hash drives it, so Back still works");
      assert.equal(back.rows, 2, "the list came back refreshed, without the closed session");
    } finally { await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Fix round 1 — findings 1, 3 and 4 were each found live, so each is settled
// live. A static argument about the cascade is what shipped finding 2.
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`F1 live @${w}x${h}: rows on one bot are actually distinguishable`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      const seen = await s.json(`JSON.stringify({
        subtitles: Array.from(document.querySelectorAll('#perch-list-body .roost-when')).map(e=>e.textContent),
        flat: document.getElementById('perch-list-body').innerText.replace(/\\s+/g,''),
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        overflow: Array.from(document.querySelectorAll('#perch-list-body .roost-when'))
          .map(e=>e.scrollWidth > e.clientWidth + 1)
      })`);
      // Before the fix this read, verbatim:
      // "R4AssistantawakeOpenCloseR4AssistantawakeOpenCloseR4AssistantawakeOpenClose"
      assert.equal(seen.subtitles.length, 3);
      assert.equal(new Set(seen.subtitles).size, 3,
        "three sessions on one bot must read as three different things: " + JSON.stringify(seen.subtitles));
      assert.match(seen.subtitles[0], /11111111/, "the short sid is the unambiguous handle");
      assert.match(seen.subtitles[0], /card 248/, "and the card is the human one, when there is one");
      assert.equal(seen.hScroll, false, "identity must not cost a horizontal scrollbar at " + w + "px");
      assert.deepEqual(seen.overflow, [false, false, false],
        "and must not be clipped inside its own row: " + JSON.stringify(seen.subtitles));
    } finally { await s.close(); }
  });

  test(`F1 live @${w}x${h}: the close confirm names the session`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      await s.evalIn(`(function(){ window.__asked=[];
        window.confirm=function(m){ window.__asked.push(String(m)); return false; }; return 'ok'; })()`);
      await s.evalIn(`document.querySelectorAll('#perch-list-body .roost-close')[1].click(); 'x'`);
      await new Promise((r) => setTimeout(r, 400));
      const asked = await s.json(`JSON.stringify(window.__asked)`);
      assert.equal(asked.length, 1);
      assert.match(asked[0], /R4 Assistant 22222222/,
        "an irreversible confirm that names nothing cannot correct a mis-tap: " + asked[0]);
      assert.deepEqual(stopped, [], "and a declined confirm still posts nothing");
    } finally { await s.close(); }
  });

  test(`F3 live @${w}x${h}: a failed /roost says why instead of faking an empty list`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    roostFails = true;
    const s = await session(w, h);
    try {
      const seen = await s.json(`JSON.stringify({
        body: document.getElementById('perch-list-body').innerText.trim(),
        newDisabled: document.getElementById('perch-new').disabled,
        noteHidden: document.getElementById('perch-launch-note').hidden,
        noteText: document.getElementById('perch-launch-note').textContent,
        notePadding: getComputedStyle(document.getElementById('perch-launch-note')).padding })`);
      // Measured before the fix: {newDisabled:true, noteHidden:true, body:"No live sessions."}
      assert.notEqual(seen.body, "No live sessions.",
        "a gateway blip must not report an empty roost — that is the exact symptom this task ends");
      assert.match(seen.body, /Could not reach the session list/);
      assert.equal(seen.noteHidden, false, "and the launcher must say why it cannot help");
      assert.match(seen.noteText, /Could not reach the session list/);
      // Finding 4, in the same read: "#perch-launch .empty" tied with
      // "#perch-hub-root .empty" and lost on source order, so its padding:0
      // never applied and the note box measured 74px tall at 412px.
      assert.equal(seen.notePadding, "0px",
        "the note's own padding rule must win the cascade, not merely exist");
    } finally { roostFails = false; await s.close(); }
  });
}
