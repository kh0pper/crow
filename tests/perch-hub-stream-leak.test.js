// Perch's transcript duplicated EVERY streamed element ~6x for one operator,
// while his own typed message appeared exactly once. This file reproduces that
// asymmetry and pins the fix.
//
// WHY IT NEEDS A REAL BROWSER *AND* A REAL TURBO. The cause is not inside the
// hub script's own logic, which is why every existing unit test stayed green
// through it: the dashboard shell ships Turbo Drive (shared/layout.js's
// turboHead()), a Turbo visit REPLACES <body> without reloading the JS realm,
// and the previous run of the inline hub script keeps its closure, its
// EventSource, its poll interval and its `window` listeners. `el()` resolves
// by id at call time, so those survivors write into the NEW document. Four
// visits, one tap on a session: four openSession()s, four EventSources, four
// server-side /events connections, four "No transcript yet." notes — and the
// operator's own message only once, because `el('perch-send').onclick=` is a
// single slot the newest instance owns outright.
//
// tests/perch-hub-render.test.js renders through the same real shell but never
// serves /vendor/turbo-8.0.5.umd.js, so Turbo never loads there and the whole
// mechanism is invisible to it. This file serves it deliberately.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

const CDP = process.env.CROW_CDP_URL ||
  ("http://127.0.0.1:" + (process.env.CROW_BROWSER_CDP_PORT || "9223"));
const HOST_FROM_CONTAINER = process.env.CROW_CDP_HOST_IP || "172.17.0.1";
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const SID = "perchlive-aaaaaaaa";

let available = false, server = null, port = 0;
/** Every open SSE response, so a test can count concurrency and broadcast. */
let openStreams = [];

function serveApi(req, res) {
  const url = req.url.split("?")[0];
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.endsWith("/roost")) {
    return send(200, {
      birds: [{
        id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false }],
      }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    openStreams.push(res);
    req.on("close", () => { openStreams = openStreams.filter((r) => r !== res); });
    return;
  }
  // An EMPTY transcript, which is what a freshly spawned session has and what
  // made "No transcript yet." the correct line to print — once.
  if (url.endsWith("/transcript")) return send(200, { events: [] });
  if (url.endsWith("/options")) return send(200, { models: [], thinkingLevels: [] });
  return send(200, {});
}

/** Push one named SSE frame to every connection the page currently holds. */
function broadcast(type, data) {
  for (const res of openStreams) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

before(async () => {
  try {
    const r = await fetch(CDP + "/json/version", { signal: AbortSignal.timeout(2000) });
    available = r.ok;
  } catch { available = false; }
  if (!available) return;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(REPO + "/servers/gateway/public/vendor/turbo-8.0.5.umd.js");
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    // The bit tests/perch-hub-render.test.js does not serve, and the reason
    // the leak never showed up there.
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    // A second shell page, so a test can Turbo-navigate AWAY from Perch.
    if (req.url.startsWith("/dashboard/elsewhere")) {
      // text/html, explicitly: Turbo only takes over a navigation whose
      // response it recognises as a document. Without the header it falls back
      // to a full page load, which would tear the stream down for the wrong
      // reason and fake a pass on the test below.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(renderLayout({ title: "Elsewhere", content: "<div id='elsewhere'>elsewhere</div>",
        activePanel: "perch", panels: [perchHubPanel], lang: "en" }));
    }
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  port = server.address().port;
});

beforeEach(() => { openStreams = []; });
after(() => { if (server) server.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tab held open across several evaluations (perch-hub-render.test.js's
 *  session() helper, plus the EventSource instrumentation these tests need). */
async function session(width = 1900, height = 900) {
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
    { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await send("Page.enable");
  await send("Page.navigate", { url: `http://${HOST_FROM_CONTAINER}:${port}/dashboard/perch` });
  await sleep(1800);
  const evalIn = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  await send("DOM.enable");
  await send("Runtime.enable");
  /** Real registered listeners on window/document, counted by type. Not a
   *  page-side proxy: DOMDebugger reads the browser's own listener table, so a
   *  handler that is inert but still ATTACHED is still counted. */
  const listenerCounts = async () => {
    const out = {};
    for (const [label, expr] of [["window", "window"], ["document", "document"]]) {
      const handle = await send("Runtime.evaluate", { expression: expr, returnByValue: false });
      const { listeners } = await send("DOMDebugger.getEventListeners", { objectId: handle.result.objectId, depth: 0 });
      for (const l of listeners) { const k = label + "." + l.type; out[k] = (out[k] || 0) + 1; }
    }
    return out;
  };
  // Count the EventSource objects the page constructs. The wrapper survives
  // Turbo visits (window does), which is exactly why it can see the leak.
  await evalIn(`(function(){
    if(window.__es) return 'already';
    window.__es=[];
    var E=window.EventSource;
    window.EventSource=function(u,o){ var e=new E(u,o); window.__es.push(e); return e; };
    window.EventSource.prototype=E.prototype;
    return 'patched';
  })()`);
  return {
    evalIn,
    json: async (expr) => JSON.parse(await evalIn(expr)),
    turboLoaded: async () => (await evalIn(`typeof window.Turbo`)) === "object",
    listenerCounts,
    visit: async (url) => { await evalIn(`Turbo.visit(${JSON.stringify(url)},{action:'replace'}); 'go'`); await sleep(1200); },
    open: async () => { await evalIn(`location.hash='${SID}'; 'go'`); await sleep(2200); },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + tab.id).catch(() => {}); },
  };
}

const PAGE_STATE = `JSON.stringify({
  notes: Array.from(document.querySelectorAll('#perch-transcript .note')).map(function(n){return n.textContent;}),
  botLines: Array.from(document.querySelectorAll('#perch-transcript .entry.bot .what')).map(function(n){return n.textContent;}),
  esLive: window.__es.filter(function(e){ return e.readyState!==2; }).length,
  esBuilt: window.__es.length,
  view: document.body.getAttribute('data-view')
})`;

// ---------------------------------------------------------------------------

test("Turbo really is loaded on this page — without it these tests prove nothing", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    assert.equal(await s.turboLoaded(), true,
      "the shell ships Turbo Drive; a fixture that does not serve it cannot see this class of defect");
  } finally { await s.close(); }
});

test("four Turbo visits, one session: ONE stream, ONE subscriber, ONE empty-state note", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    // The operator path: land on Perch, then reach it again a few times (nav
    // tap, back, a link). Each visit re-runs the inline script.
    for (let i = 0; i < 3; i++) await s.visit("/dashboard/perch");
    await s.open();
    const seen = await s.json(PAGE_STATE);
    assert.equal(seen.view, "chat", "precondition: the session is actually open");
    // Measured before the fix, same fixture: 4 / 4 / 4.
    assert.equal(seen.esBuilt, 1,
      `each surviving script instance builds its own EventSource; ${seen.esBuilt} were built`);
    assert.equal(seen.esLive, 1, "and only one may still be open");
    assert.equal(openStreams.length, 1,
      `the GATEWAY's own count is the one that matters: ${openStreams.length} concurrent /events connections`);
    assert.deepEqual(seen.notes, ["No transcript yet."],
      "one openSession, so one history load, so one note: " + JSON.stringify(seen.notes));
  } finally { await s.close(); }
});

test("a two-message turn renders two entries, not two plus the concatenation", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    // The real shape of a turn: a state frame opening it, one `text` per
    // completed assistant message (message-level streaming), then `reply`
    // carrying replyTextOf(end) — both messages CONCATENATED. Appending that
    // rendered every turn twice, on this branch and on deployed main.
    broadcast("state", { state: "awake", turnInFlight: true });
    broadcast("text", { text: "Let me check." });
    broadcast("text", { text: "There are four boards." });
    broadcast("reply", { text: "Let me check.There are four boards." });
    await sleep(500);
    const seen = await s.json(`JSON.stringify(
      Array.from(document.querySelectorAll('#perch-transcript .entry.bot .what')).map(function(n){return n.textContent;}))`);
    // A COUNT assertion: a contains-assertion passes through a duplicate.
    assert.equal(seen.length, 2, "rendered entries: " + JSON.stringify(seen));
    assert.deepEqual(seen, ["Let me check.", "There are four boards."]);
  } finally { await s.close(); }
});

test("a streamed reply is appended once, not once per surviving instance", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    for (let i = 0; i < 3; i++) await s.visit("/dashboard/perch");
    await s.open();
    // This is the operator's actual symptom: the bot answered ONCE and the
    // transcript showed the answer six times.
    // No `text` frames: the zero-message path, where `reply` IS the only copy
    // of the answer — which is what an operator who opened the drawer mid-turn
    // sees, since the stream carries no backlog.
    broadcast("reply", { text: "the one and only answer" });
    await sleep(500);
    const seen = await s.json(PAGE_STATE);
    assert.deepEqual(seen.botLines, ["the one and only answer"],
      "one reply frame must produce one transcript line: " + JSON.stringify(seen.botLines));
  } finally { await s.close(); }
});

test("navigating away from Perch closes the stream instead of leaving a subscriber behind", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    assert.equal(openStreams.length, 1, "precondition: the session is streaming");
    await s.visit("/dashboard/elsewhere");
    await sleep(400);
    assert.equal(openStreams.length, 0,
      "a Turbo visit off Perch must not leave a live SSE connection (and a gateway subscriber) behind");
  } finally { await s.close(); }
});

test("a Turbo visit BACK to Perch while a session is open leaves one stream, not two", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    assert.equal(openStreams.length, 1, "precondition: the session is streaming");
    await s.visit("/dashboard/perch");
    await sleep(400);
    // The visit drops the hash, so the fresh instance lands on the list and
    // opens nothing. What must NOT survive is the retired instance's stream.
    assert.equal(openStreams.length, 0,
      `the retired instance's connection must be gone; ${openStreams.length} still open`);
  } finally { await s.close(); }
});

test("a stream this instance never opened is still closable — by identity, from the registry", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    // Stand in for the connection a previous script instance left behind: the
    // running instance has no variable naming it, and only the shared registry
    // can. This is the case `closeStream()` alone can never reach.
    await s.evalIn(`(function(){
      var hub=window.__crowPerchHub;
      window.__orphan=new window.EventSource('/dashboard/perch-api/interactive/${SID}/events');
      hub.streams['${SID}']=window.__orphan;
      return 'planted';
    })()`);
    await sleep(400);
    assert.equal(openStreams.length, 1, "precondition: the orphan is connected");
    await s.open();
    const seen = await s.json(`JSON.stringify({ orphanState: window.__orphan.readyState,
      esLive: window.__es.filter(function(e){ return e.readyState!==2; }).length })`);
    assert.equal(seen.orphanState, 2, "the orphan must have been closed, not merely replaced in the map");
    assert.equal(openStreams.length, 1,
      `exactly one connection may remain; ${openStreams.length} are open`);
    assert.equal(seen.esLive, 1);
  } finally { await s.close(); }
});

test("five Turbo visits retain five instances but not five listeners", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    const before = await s.listenerCounts();
    assert.equal(await s.evalIn("window.__crowPerchHub.gen"), 1, "one instance so far");
    for (let i = 0; i < 4; i++) await s.visit("/dashboard/perch");
    const gen = await s.evalIn("window.__crowPerchHub.gen");
    assert.equal(gen, 5, "fixture check: five script instances really did run, or this proves nothing");

    const after = await s.listenerCounts();
    // Fix round 1 Q3. live() made a retired instance's listeners inert but
    // left them ATTACHED, and each retained closure holds rowIndex,
    // launchBots, launchModels and pendingImages — the last carrying base64
    // image data from any attach. Measured before the fix: 1 -> 5 on each of
    // these, while the shell's own listeners stayed flat because it guards
    // its bindings (layout.js:390 / :610).
    for (const key of ["window.focus", "window.hashchange", "document.turbo:before-render"]) {
      assert.equal(after[key], 1, `${key} grew to ${after[key]} across ${gen} instances`);
      assert.equal(before[key], 1, `${key} must start at 1`);
    }
    // The shell's own, as the control: if THESE grew, the page is stacking
    // listeners for a reason that has nothing to do with this script.
    assert.equal(after["document.keydown"], before["document.keydown"],
      "control: the shell's listeners must be flat too, or the measurement is about something else");
  } finally { await s.close(); }
});
