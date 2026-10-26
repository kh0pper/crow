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
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

// A PRIVATE headless Chrome per file (tests/fixtures/headless-chrome.mjs) —
// never the live crow-browser on :9223. Set in before().
let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", chrome = null;
let HOST_FROM_CONTAINER = "127.0.0.1";
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const SID = "perchlive-aaaaaaaa";

let available = false, server = null, port = 0;
/** Every open SSE response, so a test can count concurrency and broadcast. */
let openStreams = [];
/** Wave 1: the server-side history the transcript endpoint reads. A `text`
 *  frame IS a completed assistant message (message-level streaming), and in
 *  the real engine every one of them lands in the session file — so the
 *  fixture accumulates them. A transcript stuck at [] would test the new
 *  resync-on-reconnect against a server that forgets, which no engine does. */
let historyEvents = [];
/** Holds the transcript response back, so a test can push frames into the
 *  subscribe/fetch seam (frames arriving before the history batch lands). */
let transcriptDelayMs = 0;
/** Queue item 23a: per-request answers for the transcript endpoint, consumed
 *  one per request. An entry is a status code, "drop" (the socket is destroyed,
 *  so the browser's fetch rejects), or `{status, delayMs}` to hold THAT answer
 *  back — the global transcriptDelayMs cannot say "the first slow, the second
 *  fast", which is what puts two loads for one session in flight together.
 *  An empty plan answers 200 with historyEvents. */
let transcriptPlan = [];
/** Requests the transcript endpoint has seen. */
let transcriptHits = 0;
/** A "drop" keeps dropping for a short window: Chrome transparently re-sends
 *  a GET whose reused keep-alive socket was reset, and that silent re-send
 *  (measured under full-suite load: answered in ~0 ms, no rail line) must
 *  not count as the page's own retry. */
let dropUntil = 0;
/** False models a send pi has not written yet when the history is read. */
let persistSends = true;

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
  // The transcript the resync refetches: whatever this fixture has broadcast
  // as completed messages (see historyEvents).
  if (url.endsWith("/transcript")) {
    transcriptHits++;
    if (Date.now() < dropUntil) return req.socket.destroy();
    const step = transcriptPlan.length ? transcriptPlan.shift() : 200;
    const spec = typeof step === "object" ? step : { status: step };
    const answer = () => {
      if (spec.status === "drop") { dropUntil = Date.now() + 500; return req.socket.destroy(); }
      // Read at ANSWER time: a message sent while this answer was held back
      // is in it, as it is in pi's session file.
      if (spec.status === 200) return send(200, { events: historyEvents });
      return send(spec.status, {});
    };
    const delay = spec.delayMs != null ? spec.delayMs : transcriptDelayMs;
    return delay ? setTimeout(answer, delay) : answer();
  }
  // pi appends the operator's message to the session file when the turn
  // starts, so the next history load includes it.
  if (url.endsWith("/message") && req.method === "POST" && !persistSends) { req.resume(); return send(200, { ok: true }); }
  if (url.endsWith("/message") && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        const b = JSON.parse(raw || "{}");
        if (typeof b.message === "string") historyEvents.push(userMsg(b.message, Date.now()));
      } catch { /* not JSON: nothing persisted */ }
      send(200, { ok: true });
    });
    return;
  }
  if (url.endsWith("/options")) return send(200, { models: [], thinkingLevels: [] });
  // Composer dictation (perch-hub/dictation.js): a usable profile, so the mic
  // shows and the leak test below can record and cancel.
  if (url.endsWith("/dictation")) {
    if (req.method === "GET") return send(200, { available: true, maxSeconds: 60, cloud: false, profileTag: "leak-tag" });
    return send(200, { text: "words", language: "en", duration: 1 });
  }
  return send(200, {});
}

/** Push one named SSE frame to every connection the page currently holds. */
function broadcast(type, data) {
  // Model the server-side truth: every completed assistant message lands in
  // the history the transcript endpoint serves (see historyEvents).
  if (type === "text" && data && typeof data.text === "string") {
    historyEvents.push({ type: "message", message: { role: "assistant", content: [{ text: data.text }] } });
  }
  for (const res of openStreams) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

before(async () => {
  // Chrome's fake microphone, auto-accepted: the dictation leak test records.
  chrome = await startHeadlessChrome({ extraArgs: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST_FROM_CONTAINER = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(REPO + "/servers/gateway/public/vendor/turbo-8.0.5.umd.js");
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    // The phone bundle, as a non-local viewer sees it: no history, and a
    // frame's refetch is refused, so the card is the frame's own pointer.
    if (req.url.startsWith("/api/phone/")) {
      const u = req.url.split("?")[0];
      res.writeHead(u.startsWith("/api/phone/calls/") ? 403 : 200, { "content-type": "application/json" });
      if (u === "/api/phone/whoami") return res.end(JSON.stringify({ local: false }));
      if (u.endsWith("/calls")) return res.end(JSON.stringify({ calls: [] }));
      return res.end(JSON.stringify({ error: "not_local" }));
    }
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
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

beforeEach(() => { openStreams = []; historyEvents = []; transcriptDelayMs = 0; transcriptPlan = []; transcriptHits = 0; dropUntil = 0; persistSends = true; });
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

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
  userLines: Array.from(document.querySelectorAll('#perch-transcript .entry.user .what')).map(function(n){return n.textContent;}),
  activity: Array.from(document.querySelectorAll('#perch-activity-list .activity-row')).map(function(n){return n.textContent;}),
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

// ---------------------------------------------------------------------------
// Fix round 2 N1, live — a real EventSource, really dropped, really reconnected.
// The unit harness fires the backoff timer by hand; this one lets the browser
// do it, over a connection the server actually closes.
// ---------------------------------------------------------------------------

/** Close every open SSE response, the way a blip or a gateway restart does. */
function dropStreams() {
  for (const res of openStreams) { try { res.end(); } catch { /* already gone */ } }
  openStreams = [];
}

const BOT_TEXTS = `JSON.stringify(
  Array.from(document.querySelectorAll('#perch-transcript .entry.bot .what')).map(function(n){return n.textContent;}))`;

test("N1 live: a reconnect ACROSS a turn boundary still renders the next turn's reply", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    broadcast("state", { state: "awake", turnInFlight: true });
    broadcast("text", { text: "turn 1 streamed half", turnId: "turn-1" });
    await sleep(300);
    assert.deepEqual(await s.json(BOT_TEXTS), ["turn 1 streamed half"], "precondition");

    // The blip. Turn 1 ends and turn 2 runs inside it, so the client never sees
    // the turnInFlight:false that separates them.
    dropStreams();
    await sleep(3500);                       // the client's own 2s backoff, plus slack
    assert.equal(openStreams.length, 1, "the client must have reconnected on its own");

    broadcast("state", { state: "awake", turnInFlight: true });   // the engine's replay
    broadcast("reply", { text: "turn 2's whole answer", turnId: "turn-2" });
    await sleep(500);

    const seen = await s.json(BOT_TEXTS);
    assert.equal(seen.length, 2, "entries: " + JSON.stringify(seen));
    assert.deepEqual(seen, ["turn 1 streamed half", "turn 2's whole answer"],
      "measured before the fix: turn 2 never rendered at all");
  } finally { await s.close(); }
});

test("N1 live: a reconnect WITHIN a turn does not duplicate that turn's answer", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    broadcast("state", { state: "awake", turnInFlight: true });
    broadcast("text", { text: "the answer", turnId: "turn-1" });
    await sleep(300);

    dropStreams();
    await sleep(3500);
    assert.equal(openStreams.length, 1, "reconnected");

    broadcast("state", { state: "awake", turnInFlight: true });
    broadcast("reply", { text: "the answer", turnId: "turn-1" });   // the SAME turn ends
    await sleep(500);

    const seen = await s.json(BOT_TEXTS);
    assert.equal(seen.length, 1, "entries: " + JSON.stringify(seen));
    assert.deepEqual(seen, ["the answer"],
      "the case a bare reset in openStream() would have broken — which is why this is a turn id");
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Phase D2 — the Activity rail under the same Turbo regime. A surviving
// instance used to write every frame once per instance; the rail is a new
// writer, so it gets the same treatment the transcript has: N visits, ONE
// frame, ONE row.
// ---------------------------------------------------------------------------

test("a log/tool frame lands in the Activity rail ONCE, not once per surviving instance", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    for (let i = 0; i < 3; i++) await s.visit("/dashboard/perch");
    await s.open();
    broadcast("log", { text: "one line of gateway chatter" });
    broadcast("tool", { phase: "start", name: "crow_search_memories" });
    await sleep(500);
    const rows = await s.json(`JSON.stringify(
      Array.from(document.querySelectorAll('#perch-activity-list .activity-row'))
        .map(function(n){return n.textContent;}))`);
    assert.equal(rows.length, 2, "one row per frame, whatever the visit count: " + JSON.stringify(rows));
    assert.ok(rows[0].includes("one line of gateway chatter"));
    assert.ok(rows[1].includes("[tool: crow_search_memories]"));
    // And the conversation stayed a conversation — the frames must not ALSO
    // have landed in the transcript through a surviving pre-D2 instance.
    const notes = await s.json(`JSON.stringify(
      Array.from(document.querySelectorAll('#perch-transcript .note'))
        .map(function(n){return n.textContent;}))`);
    assert.ok(!notes.some((x) => x.includes("gateway chatter") || x.includes("[tool:")),
      "no frame chatter in the transcript: " + JSON.stringify(notes));
  } finally { await s.close(); }
});

test("the working strip is live in the real DOM: shown by a turn-start frame, hidden by the reply", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    broadcast("state", { state: "awake", turnInFlight: true });
    await sleep(300);
    assert.equal(await s.evalIn(`document.getElementById('perch-working').hidden`), false,
      "the gear shows while the turn runs");
    assert.equal(await s.evalIn(`getComputedStyle(document.getElementById('perch-working').querySelector('svg')).animationName`),
      "perch-spin", "and it is actually spinning");
    broadcast("state", { state: "awake", turnInFlight: true });
    broadcast("text", { text: "answer", turnId: "t-1" });
    broadcast("reply", { text: "answer", turnId: "t-1" });
    await sleep(300);
    assert.equal(await s.evalIn(`document.getElementById('perch-working').hidden`), true,
      "the turn ending hides it");
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Wave 2/3 in the real browser: the frames the engine emits drive the facts
// card, the plan surfaces, and an inline tool chip that settles to done —
// against the real DOM, not the vm's flat map.
// ---------------------------------------------------------------------------

test("W2/W3 live: facts, plan bar, and a tool chip that spins then settles", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    await s.open();
    broadcast("state", { state: "awake", turnInFlight: false,
      contextUsage: { tokens: 131072, contextWindow: 262144, percent: 50 },
      uptimeSeconds: 90, memoryMB: 512, toolCount: 14, cwd: "/tmp/x" });
    broadcast("plan_state", { state: { enabled: true, executing: true, todosDone: 1, todosTotal: 2,
      todos: [ { step: 1, text: "one", completed: true }, { step: 2, text: "two", completed: false } ] } });
    broadcast("tool", { phase: "start", name: "bash", toolCallId: "tc-live", argsText: '{"command":"ls"}' });
    await sleep(300);
    const mid = await s.json(`JSON.stringify({
      ctx: document.getElementById('perch-fact-context').textContent,
      bar: document.getElementById('perch-ctxbar-fill').style.width,
      uptime: document.getElementById('perch-fact-uptime').textContent,
      planbar: !document.getElementById('perch-planbar').hidden,
      planfill: document.getElementById('perch-planbar-fill').style.width,
      steps: document.querySelectorAll('#perch-plan-steps .plan-step').length,
      chipSpin: !!document.querySelector('#perch-transcript .tool-chip .spin'),
      chipName: (document.querySelector('#perch-transcript .tool-chip .tn')||{}).textContent,
      spinAnim: getComputedStyle(document.querySelector('#perch-transcript .tool-chip .spin')).animationName })`);
    assert.equal(mid.ctx, "50% \u00b7 131k/262k");
    assert.equal(mid.bar, "50%");
    assert.equal(mid.uptime, "1m", "minute granularity under an hour — pi-lab's own idiom");
    assert.equal(mid.planbar, true);
    assert.equal(mid.planfill, "50%");
    assert.equal(mid.steps, 2);
    assert.equal(mid.chipSpin, true, "the chip spins while the tool runs");
    assert.equal(mid.chipName, "bash");
    assert.equal(mid.spinAnim, "perch-spin");

    broadcast("tool", { phase: "end", name: "bash", toolCallId: "tc-live", resultText: "total 8", isError: false });
    await sleep(200);
    const done = await s.json(`(function(){
      var chip=document.querySelector('#perch-transcript .tool-chip');
      chip.click();                                   /* expand */
      var d=chip.parentElement.querySelector('.tool-details');
      return JSON.stringify({ spin: !!chip.querySelector('.spin'),
        status: chip.lastElementChild.textContent,
        open: !d.hidden,
        pres: Array.from(d.querySelectorAll('pre')).map(function(p){return p.textContent;}) });
    })()`);
    assert.equal(done.spin, false, "the spinner is removed when the call ends");
    assert.equal(done.status, "done");
    assert.equal(done.open, true, "and a tap expands args + result");
    assert.deepEqual(done.pres, ['{"command":"ls"}', "total 8"]);
  } finally { await s.close(); }
});

test("seam live: a tool that finishes while history loads is ONE chip, and one still running survives", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  // Review M1 (perch-md): tool frames were drawn on arrival while the history
  // batch was in flight, and the batch then drew the same finished call again
  // from its toolResult — two chips for one call.
  historyEvents = [
    { type: "message", message: { role: "toolResult", toolCallId: "tc-seam", toolName: "bash",
      content: [{ type: "text", text: "seam result" }], isError: false } },
  ];
  transcriptDelayMs = 1500;
  const s = await session();
  try {
    await s.evalIn(`location.hash='${SID}'; 'go'`);
    await sleep(600);                                  // stream open, history still pending
    broadcast("tool", { phase: "start", name: "bash", toolCallId: "tc-seam", argsText: "{}" });
    broadcast("tool", { phase: "end", name: "bash", toolCallId: "tc-seam", resultText: "seam result", isError: false });
    broadcast("tool", { phase: "start", name: "grep", toolCallId: "tc-new", argsText: "{}" });
    await sleep(2000);                                 // the batch has landed and flushed
    broadcast("tool", { phase: "end", name: "grep", toolCallId: "tc-new", resultText: "found", isError: false });
    await sleep(300);
    const seen = await s.json(`JSON.stringify(Array.from(document.querySelectorAll('#perch-transcript .tool-chip')).map(function(c){
      return { name: c.querySelector('.tn').textContent, spin: !!c.querySelector('.spin'), status: c.lastElementChild.textContent }; }))`);
    assert.deepEqual(seen.map((c) => c.name), ["bash", "grep"],
      "one chip per call — the seam must not draw tc-seam twice: " + JSON.stringify(seen));
    assert.equal(seen[1].spin, false, "the call still running at flush time settles when its end arrives");
    assert.equal(seen[1].status, "done");
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Composer dictation (perch-hub/dictation.js) across Turbo visits: the mic is
// released, the one new document listener (visibilitychange) is bound once
// per realm, and a snapshot taken mid-recording never comes back on Back.
// ---------------------------------------------------------------------------

test("dictation: five Turbo visits after a recording leave no listener, track or AudioContext behind; Back shows idle", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const s = await session();
  try {
    // The realm survives Turbo visits, so one patch sees every instance's
    // streams and contexts.
    await s.evalIn(`(function(){
      var D=window.__dictLeak={streams:[],ctxs:[]};
      var md=navigator.mediaDevices, real=md.getUserMedia.bind(md);
      md.getUserMedia=function(c){ return real(c).then(function(st){ D.streams.push(st); return st; }); };
      var RAC=window.AudioContext;
      window.AudioContext=function(o){ var c=new RAC(o); D.ctxs.push(c); return c; };
      window.AudioContext.prototype=RAC.prototype;
      return 'ok';
    })()`);
    await s.open();
    const MIC = "getComputedStyle(document.getElementById('perch-dictate')).display!=='none'";
    const STATE = "document.getElementById('perch-composer').getAttribute('data-dictation')";
    const waitEval = async (expr, what) => {
      for (const end = Date.now() + 8000; ;) {
        let v = null; try { v = await s.evalIn(expr); } catch {}
        if (v) return v;
        if (Date.now() > end) throw new Error("timed out waiting for " + what);
        await sleep(80);
      }
    };
    await waitEval(MIC, "the mic");
    await s.evalIn("document.getElementById('perch-dictate').click(); 'ok'");
    await waitEval(STATE + "==='recording'", "recording");
    await s.evalIn("document.getElementById('perch-dict-cancel').click(); 'ok'");
    await waitEval(STATE + "==='idle'", "idle");
    // Measured AFTER the first recording: the shell binds one window click
    // listener lazily on the page's first click of any button (a tab button
    // does it too, measured), which is not this script's and not a leak.
    const before = await s.listenerCounts();
    for (let i = 0; i < 4; i++) {
      await s.visit("/dashboard/perch#" + SID);
      await waitEval(`window.__crowPerchHub.gen===${i + 2}`, "visit " + (i + 2));
    }
    assert.equal(await s.evalIn("window.__crowPerchHub.gen"), 5, "five script instances really ran");
    const after = await s.listenerCounts();
    assert.deepEqual(after, before, "window/document listener counts are flat across instances");
    assert.equal(after["document.visibilitychange"], before["document.visibilitychange"]);

    // Mid-recording: a Turbo visit away, then Back.
    await waitEval(MIC, "the mic on the latest instance");
    await s.evalIn("document.getElementById('perch-dictate').click(); 'ok'");
    await waitEval(STATE + "==='recording'", "recording again");
    await s.visit("/dashboard/elsewhere");
    await waitEval("!!document.getElementById('elsewhere')", "the other page");
    await s.evalIn("history.back(); 'ok'");
    await waitEval("!!document.getElementById('perch-composer')&&window.__crowPerchHub.gen>=6", "Back to Perch");
    await sleep(400);
    const back = await s.json(`JSON.stringify({state:${STATE},bar:document.getElementById('perch-dictation-bar').hidden})`);
    assert.equal(back.state, "idle", "a snapshot of a recording never comes back");
    assert.equal(back.bar, true, "the bar is hidden");
    const media = await s.json(`(function(){ var D=window.__dictLeak; var live=0;
      D.streams.forEach(function(st){ st.getTracks().forEach(function(t){ if(t.readyState!=='ended') live++; }); });
      return JSON.stringify({streams:D.streams.length,live:live,open:D.ctxs.filter(function(c){return c.state!=='closed';}).length,ctxs:D.ctxs.length}); })()`);
    assert.equal(media.streams, 2, "two recordings were made");
    assert.equal(media.live, 0, "no live MediaStreamTrack");
    assert.equal(media.open, 0, "no unclosed AudioContext (of " + media.ctxs + ")");
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Queue item 23a: the history load retries ONCE on a dropped connection or a
// 5xx, says why on the Activity rail, and a load token keeps every late or
// overlapping answer out of the transcript. Each of these was red before the
// client change (the overlapping-load ones through the per-request delay in
// transcriptPlan, which holds ONE answer back while the next comes at once).
// ---------------------------------------------------------------------------

const FAILED = "Could not load this session's history.";
const userMsg = (text, ts = Date.now() - 60000) => ({ type: "message", timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ text }] } });
const botMsg = (text) => ({ type: "message", message: { role: "assistant", content: [{ text }] } });
/** Poll until fn() is truthy or the deadline passes; never throws, so the
 *  assertions that follow say what was wrong. */
async function until(fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(60)) {
    try { if (await fn()) return true; } catch { /* page mid-navigation */ }
  }
  return false;
}
const openHash = (s) => s.evalIn(`location.hash='${SID}'; 'go'`);

test("history retry: a 503 then a good answer renders the history once, with no failure note", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [userMsg("hello"), botMsg("first answer"), botMsg("second answer")];
  transcriptPlan = [503];
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1 && openStreams.length === 1, 4000);
    await sleep(300);                                  // inside the retry wait
    // A phone frame parks during the wait and replays once the batch lands.
    broadcast("phone_call", { call_id: "call-seam", status: "live" });
    await until(() => transcriptHits >= 2, 5000);
    await until(async () => (await s.json(PAGE_STATE)).botLines.length >= 2, 3000);
    await sleep(600);
    const seen = await s.json(PAGE_STATE);
    assert.equal(transcriptHits, 2, "exactly one retry");
    assert.deepEqual(seen.botLines, ["first answer", "second answer"]);
    assert.deepEqual(seen.userLines, ["hello"]);
    assert.deepEqual(seen.notes, [], "a blip that the retry covered is not a failure: " + JSON.stringify(seen.notes));
    assert.equal(seen.activity.filter((a) => a.includes("history: HTTP 503 (retrying)")).length, 1,
      "the rail says why: " + JSON.stringify(seen.activity));
    assert.equal(await s.evalIn("document.querySelectorAll('#perch-transcript .phonecard').length"), 1,
      "the phone frame pushed during the wait renders once");
  } finally { await s.close(); }
});

test("history retry: two failures say so once and stop", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [botMsg("unseen")];
  transcriptPlan = [503, 502];
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 2, 6000);
    await until(async () => (await s.json(PAGE_STATE)).notes.length >= 1, 3000);
    await sleep(2500);                                  // long past a second retry's wait
    const seen = await s.json(PAGE_STATE);
    assert.equal(transcriptHits, 2, "one retry, never a second");
    assert.deepEqual(seen.notes, [FAILED]);
    assert.ok(seen.activity.some((a) => a.includes("history: HTTP 503 (retrying)")), JSON.stringify(seen.activity));
    assert.ok(seen.activity.some((a) => a.endsWith("history: HTTP 502")), JSON.stringify(seen.activity));
  } finally { await s.close(); }
});

test("history retry: a dropped connection is retried", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [botMsg("after the drop")];
  transcriptPlan = ["drop"];
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 2, 6000);
    await until(async () => (await s.json(PAGE_STATE)).botLines.length >= 1, 3000);
    await sleep(400);
    const seen = await s.json(PAGE_STATE);
    // The server count includes the browser's own silent re-sends of the
    // dropped GET (see dropUntil), so the page's single retry is pinned by
    // its rail: exactly one failure line, and it says it is retrying.
    assert.ok(transcriptHits >= 2, String(transcriptHits));
    assert.deepEqual(seen.activity.filter((a) => a.includes("history:")).length, 1, JSON.stringify(seen.activity));
    assert.deepEqual(seen.botLines, ["after the drop"]);
    assert.deepEqual(seen.notes, []);
    assert.ok(seen.activity.some((a) => a.includes("history: network (retrying)")), JSON.stringify(seen.activity));
  } finally { await s.close(); }
});

test("history retry: a Turbo visit back into the session during the wait — the retired instance sends nothing more", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [botMsg("only once")];
  // The first instance's load fails, and the visit lands inside its retry
  // wait. The NEW instance's own load fails too and retries once: three
  // requests in all. A retired instance whose timer still fired makes four
  // (and draws its batch into the new page).
  transcriptPlan = [503, 503];
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1, 4000);
    await sleep(300);
    await s.evalIn(`Turbo.visit('/dashboard/perch#${SID}',{action:'replace'}); 'go'`);
    await until(() => transcriptHits >= 3, 7000);
    await sleep(2500);                                  // past the retired instance's would-be timer
    const seen = await s.json(PAGE_STATE);
    assert.equal(await s.evalIn("window.__crowPerchHub.gen"), 2, "fixture check: the visit re-ran the script");
    assert.equal(transcriptHits, 3, "the retired instance's retry must not fire: " + transcriptHits + " requests");
    assert.deepEqual(seen.botLines, ["only once"]);
    assert.deepEqual(seen.notes, []);
  } finally { await s.close(); }
});

test("history retry: a retired instance's late answer does not land in the next page", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [botMsg("from the old page")];
  transcriptPlan = [{ status: 200, delayMs: 1500 }];
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1, 4000);
    await sleep(200);
    await s.visit("/dashboard/perch");                 // lands on the list; the old load is still in flight
    await sleep(1500);
    const seen = await s.json(PAGE_STATE);
    assert.notEqual(seen.view, "chat", "precondition: the new page opened nothing");
    assert.equal(await s.evalIn("window.__crowPerchHub.gen"), 2, "fixture check: the visit re-ran the script");
    assert.deepEqual(seen.botLines, [], "the retired instance wrote into the new document: " + JSON.stringify(seen.botLines));
    assert.deepEqual(seen.notes, []);
    assert.equal(transcriptHits, 1);
  } finally { await s.close(); }
});

test("history retry: leaving and re-entering the session while its first load is in flight renders one batch", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [botMsg("one"), botMsg("two")];
  transcriptPlan = [{ status: 200, delayMs: 1500 }];   // the first load is slow, the second answers at once
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1, 4000);
    await s.evalIn(`location.hash=''; 'go'`);
    await sleep(200);
    await openHash(s);
    await until(() => transcriptHits >= 2, 4000);
    await sleep(2000);                                  // the slow first answer has landed
    const seen = await s.json(PAGE_STATE);
    assert.equal(seen.view, "chat", "precondition: the session is open again");
    assert.deepEqual(seen.botLines, ["one", "two"], "each message exactly once: " + JSON.stringify(seen.botLines));
  } finally { await s.close(); }
});

test("history retry: a reconnect resync while the first load is in flight renders one batch", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [botMsg("one"), botMsg("two")];
  transcriptPlan = [{ status: 200, delayMs: 5000 }];   // still in flight when the stream reopens
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1 && openStreams.length === 1, 4000);
    await sleep(300);
    dropStreams();                                      // the reconnect's onopen resyncs history
    await until(() => transcriptHits >= 2, 6000);
    await until(async () => (await s.json(PAGE_STATE)).botLines.length >= 2, 3000);
    await sleep(Math.max(0, 5600 - 300));               // the slow first answer has landed
    const seen = await s.json(PAGE_STATE);
    assert.deepEqual(seen.botLines, ["one", "two"], "each message exactly once: " + JSON.stringify(seen.botLines));
  } finally { await s.close(); }
});

test("history retry: a message sent during the retry wait shows once when the retried batch already has it", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  historyEvents = [userMsg("hello"), botMsg("hi")];
  transcriptPlan = [503];
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1, 4000);
    await sleep(300);                                   // inside the retry wait
    await s.evalIn(`(function(){ var i=document.getElementById('perch-input'); i.value='again';
      document.getElementById('perch-send').click(); return 'sent'; })()`);
    await until(() => transcriptHits >= 2, 5000);
    await sleep(800);
    const seen = await s.json(PAGE_STATE);
    assert.deepEqual(seen.userLines, ["hello", "again"],
      "the operator's line once, after the history it follows: " + JSON.stringify(seen.userLines));
    assert.deepEqual(seen.botLines, ["hi"]);
    assert.deepEqual(seen.notes, []);
  } finally { await s.close(); }
});

test("history retry: the operator repeating an OLDER line during the wait keeps both lines", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  // "again" is already in the history from a minute ago; the new "again" has
  // not reached pi's file when the retried batch is read. Matching on text
  // alone dropped the new line.
  historyEvents = [userMsg("again"), botMsg("ok")];
  transcriptPlan = [503];
  persistSends = false;
  const s = await session();
  try {
    await openHash(s);
    await until(() => transcriptHits >= 1, 4000);
    await sleep(300);
    await s.evalIn(`(function(){ var i=document.getElementById('perch-input'); i.value='again';
      document.getElementById('perch-send').click(); return 'sent'; })()`);
    await until(() => transcriptHits >= 2, 5000);
    await sleep(800);
    const seen = await s.json(PAGE_STATE);
    assert.deepEqual(seen.userLines, ["again", "again"], "the repeat is a new message: " + JSON.stringify(seen.userLines));
    assert.deepEqual(seen.botLines, ["ok"]);
  } finally { await s.close(); }
});
