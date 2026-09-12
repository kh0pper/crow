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
/** The bot's configured default, as GET /bots/:id/models reports it. null is
 *  the common case on the reporting instance (3 of 5 R4 bot defs). */
let modelsDefault = "crow-local/qwen3.6-35b-a3b";
/** Transcript history, so a test can seed rendered markdown into the real DOM. */
let transcriptEvents = [];
/** The /options answer. Defaults to the awake shape; a test flips it to the
 *  HIBERNATING one (thinkingLevels null, source "providers") to stand in the
 *  state an operator is in after a gateway restart. */
let optionsHibernating = false;
function resetApi() {
  liveSids = SIDS.slice(); stopped.length = 0; roostFails = false;
  modelsDefault = "crow-local/qwen3.6-35b-a3b";
  transcriptEvents = [];
  optionsHibernating = false;
  lastSpawnBody = null;
}

let roostFails = false;
/** Open-anywhere C2: the body of the last POST /bots/:id/interactive, so a
 *  test can prove the launcher sent (or never sent) the cwd key. */
let lastSpawnBody = null;
/** The picker's scripted directory tree — names and paths only, exactly the
 *  shape GET /browse answers with (routes/perch-interactive-api.js). */
const BROWSE_TREE = {
  "/home/tester": { parent: "/home", dirs: ["projects", "docs", "zz-long-name", ".config"] },
  "/home/tester/projects": { parent: "/home/tester", dirs: ["crow", "r4"] },
  "/home/tester/projects/crow": { parent: "/home/tester/projects", dirs: [] },
};
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
          cardId: sid === "perchlive-11111111" ? 248 : null, pendingUi: false,
          // One named session, with a name long enough to test the clipping:
          // free operator text must never give the 320px list column a
          // horizontal scrollbar.
          label: sid === "perchlive-22222222"
            ? "November package copy pass, English and Spanish together" : null })),
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
  // A real drawer list whose CURRENT entry is deliberately not the first one:
  // the picker asserting option 0 is exactly the fix-round-1 Q1 defect.
  if (url.endsWith("/options")) return send(200, {
    models: [
      { provider: "crow-local", id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B", availability: "up" },
      { provider: "raven-flash-next", id: "qwen3.8-flash-next", name: "Flash Next", availability: "on_demand" },
    ],
    thinkingLevels: optionsHibernating ? null : ["off", "high"],
    current: "raven-flash-next/qwen3.8-flash-next",
    source: optionsHibernating ? "providers" : "child",
  });
  // The launcher's session-free list, with a long name on purpose: the thing
  // that must never happen at 412px is a model name pushing New session off
  // the screen.
  if (url.endsWith("/models")) return send(200, {
    models: [
      { provider: "crow-local", id: "qwen3.6-35b-a3b",
        name: "Qwen3.6 35B A3B (Crow, Q5_K_XL MTP+vision, 256K)", availability: "up" },
      { provider: "crow-dsv4", id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", availability: "unavailable" },
    ],
    default: modelsDefault,
  });
  if (url.endsWith("/transcript")) return send(200, { events: transcriptEvents });
  if (url.endsWith("/rename")) return send(200, { label: "renamed" });
  // Open-anywhere C2: the picker's server-backed listing. An unknown path is
  // the real endpoint's 404 shape; no path means "start at home".
  if (url.endsWith("/browse")) {
    const u = new URL(req.url, "http://local");
    const p = u.searchParams.get("path") || "/home/tester";
    const hit = BROWSE_TREE[p];
    if (!hit) return send(404, { error: "unreadable" });
    return send(200, { path: p, parent: hit.parent,
      dirs: hit.dirs.map((n) => ({ name: n, path: p + "/" + n })) });
  }
  if (url.endsWith("/interactive") && req.method === "POST") {
    // Capture the spawn body: the C2 assertion is about WHICH KEYS the client
    // sent, and an absent cwd must stay absent (never an empty string).
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { lastSpawnBody = raw ? JSON.parse(raw) : null; } catch { lastSpawnBody = null; }
      send(200, { sessionId: "perchlive-99999999" });
    });
    return;
  }
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
    /** Resize the emulated viewport mid-session, so a test can cross the
     *  split breakpoint the way an operator dragging a window does. */
    metrics: async (w, h) => send("Emulation.setDeviceMetricsOverride",
      { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 }),
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
        document.getElementById('perch-tab-btn-session').click();   /* Phase D: Close lives in the Session tab */
        var b=document.getElementById('perch-close'), r=b.getBoundingClientRect();
        return JSON.stringify({ inViewport: r.top>=0 && r.bottom<=innerHeight,
          hit: (function(){ var e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                            return !!e && (e===b||b.contains(e)); })(),
          w: Math.round(r.width), h: Math.round(r.height),
          padding: getComputedStyle(b).padding, fontSize: getComputedStyle(b).fontSize });
      })()`);
      assert.equal(btn.inViewport, true, "close must be reachable without scrolling the Session tab");
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

      // Send must still be reachable — on the CHAT tab, where the composer
      // lives; a Session-tab control must not have disturbed the sticky box.
      const sendBox = await s.json(`(function(){
        document.getElementById('perch-tab-btn-chat').click();
        var r=document.getElementById('perch-send').getBoundingClientRect();
        return JSON.stringify({ reachable: r.bottom<=innerHeight && r.top>=0,
                                top: Math.round(r.top), bottom: Math.round(r.bottom), vp: innerHeight });
      })()`);
      assert.equal(sendBox.reachable, true,
        `Send at ${sendBox.top}-${sendBox.bottom} in a ${sendBox.vp}px viewport`);

      await s.evalIn(`document.getElementById('perch-tab-btn-session').click(); document.getElementById('perch-close').click(); 'clicked'`);
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

// ---------------------------------------------------------------------------
// The launcher's model picker, live at both viewports. A 44px floor argued
// from the cascade is how #perch-close shipped at 36px; these measure it.
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`M1 live @${w}x${h}: the model picker is on screen, thumb-sized, and does not push New session off`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      const seen = await s.json(`(function(){
        var box=function(id){ var e=document.getElementById(id), r=e.getBoundingClientRect();
          return { hidden:e.hidden, w:Math.round(r.width), h:Math.round(r.height),
                   top:Math.round(r.top), bottom:Math.round(r.bottom),
                   inViewport: r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth,
                   hit:(function(){ var el=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                                    return !!el && (el===e || e.contains(el)); })() }; };
        var sel=document.getElementById('perch-new-model');
        var doc=document.documentElement;
        return JSON.stringify({ model:box('perch-new-model'), newBtn:box('perch-new'),
          value: sel.value, options: Array.prototype.map.call(sel.options,function(o){return o.textContent;}),
          selectedText: sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].textContent:null,
          hScroll: doc.scrollWidth > doc.clientWidth });
      })()`);
      assert.equal(seen.model.hidden, false, "the picker must be there once the list arrives");
      assert.equal(seen.model.inViewport, true,
        `the picker sits at ${seen.model.top}-${seen.model.bottom} in a ${h}px viewport`);
      assert.equal(seen.model.hit, true, "and nothing overlaps it");
      assert.ok(seen.model.h >= 44, `tap target ${seen.model.w}x${seen.model.h} is too small for a thumb`);
      assert.equal(seen.value, "crow-local/qwen3.6-35b-a3b", "opened on the bot's configured model");
      assert.equal(seen.selectedText, seen.options[0],
        "and the browser really shows that entry, not merely stores the value");
      assert.match(seen.options[1], /not running/, "an unavailable model must read as unavailable");
      // The regression a long model name would cause.
      assert.equal(seen.newBtn.inViewport, true,
        `New session at ${seen.newBtn.top}-${seen.newBtn.bottom} in a ${h}px viewport`);
      assert.equal(seen.newBtn.hit, true);
      assert.ok(seen.newBtn.h >= 44, `New session is ${seen.newBtn.w}x${seen.newBtn.h}`);
      assert.equal(seen.hScroll, false, "no horizontal scroll at " + w + "px");
    } finally { await s.close(); }
  });

  test(`M1 live @${w}x${h}: the picker does not disturb Send reachability`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      const m = await s.json(`(function(){
        document.body.setAttribute('data-view','chat');
        var tr=document.getElementById('perch-transcript');
        for(var i=0;i<60;i++){ var d=document.createElement('div');
          d.textContent='bot: a transcript line long enough to take a row or two, number '+i;
          tr.appendChild(d); }
        tr.scrollTop=0;
        var cb=document.querySelector('.content-body');
        var b=document.getElementById('perch-send').getBoundingClientRect();
        return JSON.stringify({ viewport:innerHeight, top:Math.round(b.top), bottom:Math.round(b.bottom),
          reachable: b.bottom<=innerHeight && b.top>=0,
          contentBodyScroll: cb.scrollHeight-cb.clientHeight });
      })()`);
      assert.equal(m.reachable, true, `Send at ${m.top}-${m.bottom} in a ${m.viewport}px viewport`);
      assert.equal(m.contentBodyScroll, 0,
        "the flex chain must still be the mechanism — a taller launcher must not make .content-body scroll");
    } finally { await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Finding 1 — the list column in split view. Measured at the width where the
// defect exists; a unit test cannot see it, because what makes the list
// visible with a chat open is a CSS media query.
// ---------------------------------------------------------------------------

const ROW_COUNT = `JSON.stringify({
  rows: document.querySelectorAll('#perch-list-body .roost-row').length,
  listVisible: getComputedStyle(document.getElementById('perch-list')).display !== 'none',
  view: document.body.getAttribute('data-view') })`;

test("F1b live @1280x900: with a chat open the VISIBLE list keeps polling", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  resetApi();
  const s = await session(1280, 900);
  try {
    await s.evalIn(`location.hash='perchlive-11111111'; 'go'`);
    await new Promise((r) => setTimeout(r, 900));
    const before = await s.json(ROW_COUNT);
    assert.equal(before.view, "chat");
    assert.equal(before.listVisible, true, "precondition: this is the split view, the list is on screen");
    assert.equal(before.rows, 3);

    // The world moves on: one session ends elsewhere.
    liveSids = liveSids.slice(0, 2);
    await new Promise((r) => setTimeout(r, 11000));   // one 10s poll interval

    const after = await s.json(ROW_COUNT);
    assert.equal(after.rows, 2,
      "a visible list that stopped polling is what showed an idle row beside an awake session");
  } finally { await s.close(); }
});

test("F1b live @412x730: with a chat open the HIDDEN list stops polling", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  resetApi();
  const s = await session(412, 730);
  try {
    await s.evalIn(`location.hash='perchlive-11111111'; 'go'`);
    await new Promise((r) => setTimeout(r, 900));
    const before = await s.json(ROW_COUNT);
    assert.equal(before.listVisible, false, "precondition: below the breakpoint the list really is hidden");
    assert.equal(before.rows, 3);

    liveSids = liveSids.slice(0, 2);
    await new Promise((r) => setTimeout(r, 11000));

    const after = await s.json(ROW_COUNT);
    assert.equal(after.rows, 3,
      "the other direction: nothing may keep polling behind a hidden list — SSE is the live signal there");
  } finally { await s.close(); }
});

test("F1b live: crossing the breakpoint with a chat open refreshes the list that just appeared", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  resetApi();
  const s = await session(412, 730);
  try {
    await s.evalIn(`location.hash='perchlive-11111111'; 'go'`);
    await new Promise((r) => setTimeout(r, 900));
    liveSids = liveSids.slice(0, 2);       // changed while the list was hidden and frozen
    assert.equal((await s.json(ROW_COUNT)).rows, 3, "still stale, as it should be at this width");

    await s.metrics(1280, 900);            // the operator widens the window
    await new Promise((r) => setTimeout(r, 1200));

    const after = await s.json(ROW_COUNT);
    assert.equal(after.listVisible, true);
    assert.equal(after.rows, 2,
      "a breakpoint crossing is not a navigation, so nothing else would have refreshed it");
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Finding 3 — the rename controls, measured. A third button on a row and a
// second one in the chat header are exactly where a 412px layout breaks.
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`F3 live @${w}x${h}: a named row shows the name, clips it, and keeps three thumb-sized controls`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      const seen = await s.json(`(function(){
        var rows=document.querySelectorAll('#perch-list-body .roost-row');
        var named=null;
        for(var i=0;i<rows.length;i++){ if(rows[i].querySelector('.roost-name')) named=rows[i]; }
        var nameEl=named&&named.querySelector('.roost-name');
        var btns=named?Array.prototype.map.call(named.querySelectorAll('button'),function(b){
          var r=b.getBoundingClientRect();
          return { text:b.textContent, w:Math.round(r.width), h:Math.round(r.height),
                   inViewport: r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth,
                   hit:(function(){ var e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                                    return !!e && (e===b||b.contains(e)); })() };
        }):[];
        var doc=document.documentElement;
        return JSON.stringify({
          rows: rows.length,
          name: nameEl?nameEl.textContent:null,
          nameClipped: nameEl? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
          nameOverflowsRow: nameEl? nameEl.getBoundingClientRect().right > named.getBoundingClientRect().right + 1 : null,
          btns: btns,
          hScroll: doc.scrollWidth > doc.clientWidth });
      })()`);
      assert.equal(seen.rows, 3, "fixture check");
      assert.equal(seen.name, "November package copy pass, English and Spanish together");
      assert.equal(seen.nameOverflowsRow, false,
        "an 80-char operator name must be clipped inside its row, not spill out of it");
      assert.deepEqual(seen.btns.map((b) => b.text), ["Open", "Rename", "Close"],
        "the row grew a third control: " + JSON.stringify(seen.btns.map((b) => b.text)));
      for (const b of seen.btns) {
        assert.ok(b.h >= 44, `${b.text} is ${b.w}x${b.h}; every row control clears the 44px thumb target`);
        assert.equal(b.inViewport, true, `${b.text} must be on screen`);
        assert.equal(b.hit, true, `${b.text} must be hit-testable`);
      }
      assert.equal(seen.hScroll, false, "no horizontal scroll at " + w + "px");
    } finally { await s.close(); }
  });

  test(`F3 live @${w}x${h}: the Session tab's Rename is reachable and Send still is`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      await s.evalIn(`location.hash='perchlive-22222222'; 'go'`);
      await new Promise((r) => setTimeout(r, 900));
      const seen = await s.json(`(function(){
        document.getElementById('perch-tab-btn-session').click();   /* Phase D: Rename lives in the Session tab */
        var b=document.getElementById('perch-rename'), r=b.getBoundingClientRect();
        var nm=document.getElementById('perch-session-name');
        return JSON.stringify({
          name: nm.hidden?null:nm.textContent,
          meta: document.getElementById('perch-session-meta').textContent,
          w:Math.round(r.width), h:Math.round(r.height),
          inViewport: r.top>=0 && r.bottom<=innerHeight,
          hit:(function(){ var e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                           return !!e && (e===b||b.contains(e)); })(),
          hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth });
      })()`);
      assert.equal(seen.name, "November package copy pass, English and Spanish together",
        "the open session's name stays in the head — identity never moved to a tab");
      assert.equal(seen.meta, "perchlive-22222222", "and the id line is untouched — it is the identity");
      assert.ok(seen.h >= 44, `Rename is ${seen.w}x${seen.h}`);
      assert.equal(seen.inViewport, true);
      assert.equal(seen.hit, true);
      assert.equal(seen.hScroll, false);
      const send = await s.json(`(function(){
        document.getElementById('perch-tab-btn-chat').click();
        var r=document.getElementById('perch-send').getBoundingClientRect();
        return JSON.stringify({ reachable: r.bottom<=innerHeight && r.top>=0 });
      })()`);
      assert.equal(send.reachable, true, "a Session-tab control must not disturb the composer");
    } finally { await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Fix round 1 Q1, live — the drawer picker must report the session's model.
// A jsdom-free browser check, because `selectedIndex` is the browser's own
// answer to "what does the operator see selected".
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`Q1 live @${w}x${h}: the model select shows the model the session is on`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      await s.evalIn(`location.hash='perchlive-22222222'; 'go'`);
      await new Promise((r) => setTimeout(r, 900));
      const seen = await s.json(`(function(){
        var sel=document.getElementById('perch-model');
        return JSON.stringify({
          disabled: sel.disabled,
          value: sel.value,
          index: sel.selectedIndex,
          shown: sel.selectedIndex>=0?sel.options[sel.selectedIndex].textContent:null,
          first: sel.options.length?sel.options[0].value:null,
          count: sel.options.length });
      })()`);
      assert.equal(seen.disabled, false);
      // Round 3 R1: the drawer picker leads with the revocation sentinel
      // (value '') — the recovery path for a session pinned by a pre-A1
      // auto-stamped row. The live model must still be selected over it.
      assert.equal(seen.count, 3, "fixture check: the sentinel plus the two catalogue entries");
      assert.equal(seen.first, "", "option 0 is the revocation sentinel");
      assert.equal(seen.value, "raven-flash-next/qwen3.8-flash-next");
      assert.equal(seen.index, 2, "the browser's own selection, not just an attribute we set");
      assert.match(seen.shown, /Flash Next/,
        "what the operator actually reads off the control this feature exists for");
    } finally { await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Fix round 1 Q2, live — a bot with no configured default. The unit assertion
// for this is weak on its own (a fake select's .value starts ""), so the
// browser's own selectedIndex is what settles it.
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`Q2 live @${w}x${h}: with no configured default the launcher preselects "the bot's own model"`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    modelsDefault = null;
    const s = await session(w, h);
    try {
      const seen = await s.json(`(function(){
        var sel=document.getElementById('perch-new-model');
        return JSON.stringify({
          index: sel.selectedIndex,
          value: sel.value,
          shown: sel.selectedIndex>=0?sel.options[sel.selectedIndex].textContent:null,
          count: sel.options.length });
      })()`);
      assert.equal(seen.count, 3, "the sentinel plus the two catalogue entries");
      assert.equal(seen.index, 0);
      assert.equal(seen.value, "", "an empty value is what makes startSession send no control()");
      assert.equal(seen.shown, "The bot's own model");
    } finally { resetApi(); await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// TASK-3 item 2, live — rendered markdown in a real browser. A wide table is
// the one thing in a bot answer that cannot be wrapped, and 412px is where an
// unscoped one gives the whole page a horizontal scrollbar.
// ---------------------------------------------------------------------------

/** What the server sends: rendered by servers/blog/renderer.js, sanitized. */
async function renderedTranscript() {
  const { renderMarkdown } = await import("../servers/blog/renderer.js");
  const wide = "## Boards\n\n" +
    "| id | board | cards | owner | updated | status | notes |\n" +
    "|---|---|---|---|---|---|---|\n" +
    "| 1 | TEHCY resource grant | 12 | Kevin Hopper | 2026-09-10 | in review | " +
    // An unbreakable token, deliberately: a table of ordinary prose wraps and
    // never overflows, so it would prove nothing about the scroll container.
    "outputs/2026-09-10T14-22-05Z_november-package-copy-pass_en-es_final.tar.gz |\n" +
    "| 2 | Comms | 3 | Edrice Bell | 2026-09-08 | approved | waiting on the translation answer |\n\n" +
    "```js\nconst aVeryLongLineOfCodeThatCannotWrapAnywhereAtAllBecauseItIsOneToken = 1;\n```\n";
  const hostile = "<img src=x onerror=\"window.__pwned=1\">\n\n" +
    "<script>window.__pwned=1</script>\n\n[click me](javascript:window.__pwned=1)";
  return [
    { type: "message", message: { role: "user", content: "how many boards?" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: wide }] },
      html: renderMarkdown(wide) },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: hostile }] },
      html: renderMarkdown(hostile) },
  ];
}

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`MD live @${w}x${h}: markdown renders as elements, wide content scrolls itself, page does not`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    transcriptEvents = await renderedTranscript();
    const s = await session(w, h);
    try {
      await s.evalIn(`location.hash='perchlive-22222222'; 'go'`);
      await new Promise((r) => setTimeout(r, 1200));
      const seen = await s.json(`(function(){
        var tr=document.getElementById('perch-transcript');
        var md=tr.querySelectorAll('.what.md');
        var table=tr.querySelector('.what.md table');
        var pre=tr.querySelector('.what.md pre');
        var doc=document.documentElement;
        var box=function(e){ var r=e.getBoundingClientRect(); return {right:Math.round(r.right),width:Math.round(r.width)}; };
        var send=document.getElementById('perch-send').getBoundingClientRect();
        return JSON.stringify({
          whiteSpace: md.length ? getComputedStyle(md[0]).whiteSpace : null,
          mdHeight: md.length ? Math.round(md[0].getBoundingClientRect().height) : null,
          mdBlocks: md.length,
          headings: tr.querySelectorAll('.what.md h2').length,
          tables: tr.querySelectorAll('.what.md table').length,
          tableScrolls: table ? table.scrollWidth > table.clientWidth : null,
          tableWithin: table ? box(table).right <= box(tr).right + 1 : null,
          preScrolls: pre ? pre.scrollWidth > pre.clientWidth : null,
          preWithin: pre ? box(pre).right <= box(tr).right + 1 : null,
          pageHScroll: doc.scrollWidth > doc.clientWidth,
          transcriptHScroll: tr.scrollWidth > tr.clientWidth,
          sendReachable: send.bottom<=innerHeight && send.top>=0,
          sendTop: Math.round(send.top), sendBottom: Math.round(send.bottom), vp: innerHeight,
          scripts: tr.querySelectorAll('script').length,
          iframes: tr.querySelectorAll('iframe').length,
          jsHrefs: Array.prototype.filter.call(tr.querySelectorAll('a'),
            function(a){ return /^javascript:/i.test(a.getAttribute('href')||''); }).length,
          pwned: !!window.__pwned
        });
      })()`);
      assert.equal(seen.mdBlocks, 2, "both assistant messages rendered as markdown");
      assert.equal(seen.headings, 1, "a heading is a real <h2>, not literal '## Boards'");
      // .what carries white-space:pre-wrap for plain text; rendered markdown is
      // real block elements, so inheriting it honours the SOURCE newlines and
      // pads every gap between blocks. Measured at 412x730: 287px with the
      // override, 410px without — 123px of blank space in one answer.
      assert.equal(seen.whiteSpace, "normal",
        "rendered markdown must not inherit .what's pre-wrap");
      if (w < 900) {
        assert.ok(seen.mdHeight < 350,
          `the rendered block is ${seen.mdHeight}px; pre-wrap measured 410px for the same content`);
      }
      assert.equal(seen.tables, 1);

      // The wide-content rule. The code fence is the guaranteed-overflow
      // element at BOTH widths (an unbreakable 74-char line against a 304px
      // and a 560px column); the table overflows at 412 and happens to fit at
      // 1280, so its scroll is asserted only where it is real.
      assert.equal(seen.preScrolls, true,
        "the code fence must genuinely exceed its box, or the scroll container proves nothing");
      assert.equal(seen.preWithin, true, "and it is contained by the transcript rather than spilling out");
      assert.equal(seen.tableWithin, true);
      if (w < 900) {
        assert.equal(seen.tableScrolls, true, "at 412px the table exceeds the column and must scroll itself");
      }
      assert.equal(seen.pageHScroll, false, "no horizontal PAGE scroll at " + w + "px");
      // THE invariant this needed a CSS fix for: the transcript is a grid, and
      // a grid item's automatic minimum size is its min-content, so one
      // unbreakable cell used to widen the whole row (measured 666px in a
      // 380px column) and the transcript scrolled sideways.
      assert.equal(seen.transcriptHScroll, false, "the transcript column must not scroll sideways either");

      // Send reachability, re-measured: the flex chain is the mechanism.
      assert.equal(seen.sendReachable, true,
        `Send at ${seen.sendTop}-${seen.sendBottom} in a ${seen.vp}px viewport`);

      // Sanitization, in a real browser: not "the string looks safe" but
      // "nothing executed and no such element exists".
      assert.equal(seen.pwned, false, "the hostile payload must not have fired");
      assert.equal(seen.scripts, 0);
      assert.equal(seen.iframes, 0);
      assert.equal(seen.jsHrefs, 0);
    } finally { resetApi(); await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Fix round 2 N2, live — the state the operator is actually in.
//
// A session hibernating after a gateway restart: options() answers from the
// provider catalogue, and `current` is the model adoptRow restored from the
// row. Measured null before the fix, which is what made the picker show
// whichever model sorted first while the session was on another one.
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`N2 live @${w}x${h}: a hibernating session's picker names the model it is on`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    optionsHibernating = true;
    const s = await session(w, h);
    try {
      await s.evalIn(`location.hash='perchlive-22222222'; 'go'`);
      await new Promise((r) => setTimeout(r, 900));
      const seen = await s.json(`(function(){
        var sel=document.getElementById('perch-model'), th=document.getElementById('perch-thinking');
        return JSON.stringify({
          disabled: sel.disabled, thinkingDisabled: th.disabled,
          value: sel.value, index: sel.selectedIndex,
          shown: sel.selectedIndex>=0?sel.options[sel.selectedIndex].textContent:null,
          first: sel.options.length?sel.options[0].value:null });
      })()`);
      assert.equal(seen.disabled, false, "the fallback list is a real list");
      assert.equal(seen.thinkingDisabled, true, "thinking still has no list, and still says so");
      // Round 3 R1: sentinel first, the live model selected over it — the
      // defect this guards ("measured as the FIRST option before the fix")
      // still cannot pass: option 0 now reads "the bot's own model", which
      // is exactly what a wrong selection WOULD look like, and the
      // assertion below still demands the real model instead.
      assert.equal(seen.first, "", "option 0 is the revocation sentinel");
      assert.equal(seen.value, "raven-flash-next/qwen3.8-flash-next");
      assert.equal(seen.index, 2, "the browser's own selection");
      assert.match(seen.shown, /Flash Next/,
        "what the operator reads after a restart — measured as the FIRST option before the fix");
    } finally { resetApi(); await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Open-anywhere C2, live — the directory picker in a real browser: browse
// from the scripted home two levels down, Choose writes the field, the spawn
// carries the cwd key, an EMPTY field never sends it, and BOTH dismiss paths
// (Escape and the visible Cancel) close the modal — review S5's pair.
// ---------------------------------------------------------------------------

const sleepJs = (ms) => `await new Promise(function(r){setTimeout(r,${ms});})`;

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`C2 live @${w}x${h}: the picker browses, Choose fills the field, and the spawn carries cwd`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      // 1. Open the picker from the launcher's Browse button.
      const opened = await s.json(`(async function(){
        document.getElementById('perch-browse-btn').click();
        ${sleepJs(400)}
        var m=document.getElementById('perch-browse-modal');
        var box=m.querySelector('.browse-box').getBoundingClientRect();
        var names=[].slice.call(document.querySelectorAll('#perch-browse-list button'))
          .map(function(b){return b.textContent;});
        return JSON.stringify({visible:!m.hidden,
          path:document.getElementById('perch-browse-path').textContent,
          names:names, boxWidth:Math.round(box.width),
          innerWidth:innerWidth,
          hScroll:document.documentElement.scrollWidth>innerWidth});
      })()`);
      assert.equal(opened.visible, true, "the modal is on screen");
      assert.equal(opened.path, "/home/tester", "an empty field starts the picker at home");
      assert.deepEqual(opened.names, ["..", "projects", "docs", "zz-long-name", ".config"],
        "directories only, dot-dirs last, '..' first");
      assert.equal(opened.hScroll, false, "the modal must not give the page a horizontal scrollbar");
      if (w < 900) {
        assert.equal(opened.boxWidth, opened.innerWidth, "full-bleed at phone width");
      } else {
        assert.ok(opened.boxWidth <= 560, `desktop caps the box at 560px, measured ${opened.boxWidth}`);
      }

      // 2. Navigate two levels down and Choose.
      const chosen = await s.json(`(async function(){
        function tap(name){
          var b=[].slice.call(document.querySelectorAll('#perch-browse-list button'))
            .filter(function(x){return x.textContent===name;})[0];
          if(!b) throw new Error('no row: '+name);
          b.click();
        }
        tap('projects');
        ${sleepJs(350)}
        tap('crow');
        ${sleepJs(350)}
        var atPath=document.getElementById('perch-browse-path').textContent;
        document.getElementById('perch-browse-choose').click();
        ${sleepJs(80)}
        return JSON.stringify({atPath:atPath,
          field:document.getElementById('perch-new-cwd').value,
          hidden:document.getElementById('perch-browse-modal').hidden});
      })()`);
      assert.equal(chosen.atPath, "/home/tester/projects/crow");
      assert.equal(chosen.field, "/home/tester/projects/crow", "Choose writes the field");
      assert.equal(chosen.hidden, true, "Choose closes the modal");

      // 3. Escape dismisses (the S5 pair: never dependent on one path).
      const escaped = await s.json(`(async function(){
        document.getElementById('perch-browse-btn').click();
        ${sleepJs(350)}
        var reopened=!document.getElementById('perch-browse-modal').hidden;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
        ${sleepJs(80)}
        var afterEscape=document.getElementById('perch-browse-modal').hidden;
        document.getElementById('perch-browse-btn').click();
        ${sleepJs(350)}
        document.getElementById('perch-browse-cancel').click();
        ${sleepJs(80)}
        var afterCancel=document.getElementById('perch-browse-modal').hidden;
        var fieldUntouched=document.getElementById('perch-new-cwd').value;
        return JSON.stringify({reopened:reopened,afterEscape:afterEscape,
          afterCancel:afterCancel,fieldUntouched:fieldUntouched});
      })()`);
      assert.equal(escaped.reopened, true);
      assert.equal(escaped.afterEscape, true, "Escape closes the picker");
      assert.equal(escaped.afterCancel, true, "the visible Cancel closes it too");
      assert.equal(escaped.fieldUntouched, "/home/tester/projects/crow",
        "a dismissed picker never touches the field");

      // 4. New session carries the chosen cwd.
      await s.evalIn(`(async function(){
        document.getElementById('perch-new').click();
        ${sleepJs(400)}
        return 'spawned';
      })()`);
      assert.deepEqual(lastSpawnBody, { cwd: "/home/tester/projects/crow" },
        "the spawn body carries exactly the chosen directory");

      // 5. An EMPTY field means "the bot's default" — the key is never sent.
      await s.evalIn(`(async function(){
        document.getElementById('perch-new-cwd').value='';
        document.getElementById('perch-new').click();
        ${sleepJs(400)}
        return 'spawned';
      })()`);
      assert.equal(lastSpawnBody, null, "no cwd, no body at all — an empty string must never ride");
    } finally { resetApi(); await s.close(); }
  });
}

// ---------------------------------------------------------------------------
// Phase D1, live — the flex chain has killed a Send button before, so the
// tab bar's arrival is measured, not argued: Send reachable with the
// transcript scrolled to the TOP, the bar on screen in EVERY tab, the bar
// never overlapping Send, and no horizontal scroll at either breakpoint.
// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`D1 live @${w}x${h}: Send is reachable on chat and the tab bar never covers it`, async (t) => {
    if (!available) return t.skip("no CDP endpoint at " + CDP);
    resetApi();
    const s = await session(w, h);
    try {
      await s.evalIn(`location.hash='perchlive-22222222'; 'go'`);
      await new Promise((r) => setTimeout(r, 900));
      const seen = await s.json(`(async function(){
        var tr=document.getElementById('perch-transcript');
        for(var i=0;i<60;i++){ var d=document.createElement('div');
          d.textContent='bot: a transcript line long enough to take a row or two, number '+i;
          tr.appendChild(d); }
        tr.scrollTop=0;                                   /* where a reader starts */
        function rect(id){ var r=document.getElementById(id).getBoundingClientRect();
          return {top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height)}; }
        var out={tabs:{}};
        var names=['chat','session','files','activity'];
        for(var i=0;i<names.length;i++){
          var n=names[i];
          document.getElementById('perch-tab-btn-'+n).click();
          await new Promise(function(r){setTimeout(r,60);});
          var bar=rect('perch-tabs');
          out.tabs[n]={bar:bar,
            barInViewport:bar.top>=0&&bar.bottom<=innerHeight,
            hScroll:document.documentElement.scrollWidth>document.documentElement.clientWidth};
          if(n==='chat'){
            var snd=rect('perch-send');
            out.send=snd;
            out.sendReachable=snd.bottom<=innerHeight&&snd.top>=0;
            out.barOverlapsSend=!(bar.top>=snd.bottom||snd.top>=bar.bottom);
          }
        }
        return JSON.stringify(out);
      })()`);
      assert.equal(seen.sendReachable, true,
        `Send at ${seen.send.top}-${seen.send.bottom} in a ${h}px viewport`);
      assert.equal(seen.barOverlapsSend, false,
        `the bar (${seen.tabs.chat.bar.top}-${seen.tabs.chat.bar.bottom}) must not cover Send`);
      for (const [n, m] of Object.entries(seen.tabs)) {
        assert.equal(m.barInViewport, true, `the bar is on screen on the ${n} tab`);
        assert.ok(m.bar.h >= 44, `the bar is thumb-sized on ${n}: ${m.bar.h}px`);
        assert.equal(m.hScroll, false, `no horizontal scroll on the ${n} tab`);
      }
    } finally { resetApi(); await s.close(); }
  });
}
