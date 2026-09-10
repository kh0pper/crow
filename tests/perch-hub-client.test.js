// The client script is a string. These tests extract named functions from it
// with new Function(...) and exercise them against the real /roost payload
// shape, so the list logic is covered without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

/** Replace the interior of every block and line comment with spaces (keeping
 *  length and newlines), so a `{` or `}` inside a comment can't unbalance the
 *  depth counter below. Same length as the input, so indices found against
 *  the masked copy still address the original source. Does not account for
 *  braces inside string/template literals — none of this codebase's
 *  extracted functions put one there. */
function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Brace-matched end index of the function body starting at `start` (the
 *  index of "function <name>"), depth-counted against a comment-masked copy
 *  of `src` so a stray brace inside a comment can't extend the match past
 *  the real end. */
function braceMatchEnd(src, start) {
  const masked = maskComments(src);
  let depth = 0, end = -1;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return end;
}

/** Pull one named function out of the emitted script and make it callable. */
async function extract(name, extra = "") {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const src = perchHubJs("en");
  const start = src.indexOf("function " + name);
  assert.ok(start > -1, name + " is not in the emitted script");
  const end = braceMatchEnd(src, start);
  return new Function(extra + src.slice(start, end + 1) + "; return " + name + ";")();
}

const ROOST = {
  birds: [
    { id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
      sessions: [{ sessionId: "perchlive-aa", state: "awake", cardId: 49, pendingUi: false, control: "run" }] },
    { id: "asker", name: "Asker", perch_attached: true, state: "waiting",
      sessions: [{ sessionId: "perchlive-bb", state: "awake", cardId: null, pendingUi: true, control: "run" }] },
    { id: "idle-bot", name: "Idle Bot", perch_attached: true, state: "idle", sessions: [] },
    { id: "quiet", name: "Quiet", perch_attached: false, state: "observing", sessions: [] },
  ],
  occupiedCardIds: [49],
};

test("every live session becomes a row, whichever bot it belongs to", async () => {
  const rowsFor = await extract("listRows");
  const rows = rowsFor(ROOST);
  const live = rows.filter((r) => r.sessionId);
  assert.equal(live.length, 2);
  assert.deepEqual(live.map((r) => r.sessionId).sort(), ["perchlive-aa", "perchlive-bb"]);
});

test("a bot with no session still gets a row, so you can start one", async () => {
  const rowsFor = await extract("listRows");
  const idle = rowsFor(ROOST).find((r) => r.botId === "idle-bot");
  assert.ok(idle, "an attached bot with no session must be startable from here");
  assert.equal(idle.sessionId, null);
});

test("a bot without perch attached is not offered — the spawn would 403", async () => {
  const rowsFor = await extract("listRows");
  assert.ok(!rowsFor(ROOST).some((r) => r.botId === "quiet"));
});

test("a session waiting on you sorts above a working one", async () => {
  const rowsFor = await extract("listRows");
  const rows = rowsFor(ROOST).filter((r) => r.sessionId);
  assert.equal(rows[0].sessionId, "perchlive-bb", "pendingUi first — it is blocked on you");
});

test("a stopped session is not a tappable row that dead-ends", async () => {
  const rowsFor = await extract("listRows");
  const rows = rowsFor({ birds: [{ id: "b", name: "B", perch_attached: true, state: "idle",
    sessions: [{ sessionId: "perchlive-dead0000", state: "stopped", cardId: null, pendingUi: false }] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, null, "the bot stays startable; the dead session does not show");
});

test("an empty roost is an empty list, not a crash", async () => {
  const rowsFor = await extract("listRows");
  assert.deepEqual(rowsFor({ birds: [], occupiedCardIds: [] }), []);
  assert.deepEqual(rowsFor({}), []);
  assert.deepEqual(rowsFor(null), []);
});

test("only a real engine-minted session id opens a chat", async () => {
  const parseHash = await extract("parseHash");
  // The engine mints "perchlive-" + 8 hex (perch-interactive.js:1473). A loose
  // pattern would let ".." through, and openStream builds a URL from this.
  assert.deepEqual(parseHash("#perchlive-ab12cd34"), { sessionId: "perchlive-ab12cd34" });
  assert.deepEqual(parseHash("perchlive-ab12cd34"), { sessionId: "perchlive-ab12cd34" });
  for (const bad of ["", "#", undefined, "#..", "#../../etc/passwd", "#<script>",
                     "#perchlive-XYZ", "#perchlive-ab12", "#not a session"]) {
    assert.equal(parseHash(bad), null, JSON.stringify(bad) + " must not open a chat");
  }
});

test("plan_state carries an OBJECT and must never be printed raw", async () => {
  const planStateText = await extract("planStateText");
  // The exact frame the engine replays onto EVERY new subscriber.
  assert.equal(planStateText({ enabled: false, executing: false, todosDone: 0, todosTotal: 0, todos: [] }), "");
  assert.equal(planStateText({ enabled: true, executing: false, todosDone: 0, todosTotal: 0 }), "plan mode on");
  assert.equal(planStateText({ enabled: true, executing: false, todosDone: 2, todosTotal: 5 }), "plan mode on (2/5)");
  assert.equal(planStateText({ enabled: true, executing: true, todosDone: 3, todosTotal: 7 }), "executing the plan (3/7)");
  assert.equal(planStateText(undefined), "");
  assert.equal(planStateText("legacy string"), "legacy string");
});

test("a transcript message's content array is walked, not stringified", async () => {
  const messageText = await extract("messageText");
  assert.equal(messageText({ content: "plain" }), "plain");
  assert.equal(messageText({ content: [{ text: "a" }, { text: "b" }] }), "a\nb");
  assert.equal(messageText({ content: [{ type: "toolCall", name: "board_get_item" }] }), "[tool: board_get_item]");
  assert.equal(messageText({ text: "fallback" }), "fallback");
  assert.equal(messageText({}), "");
  assert.equal(messageText(null), "");
});

test("turnInFlight mirrors the engine, and a stopped session is never in flight", async () => {
  // Round-1 review: an earlier draft gated the false on having first seen true.
  // That is NOT what the drawer does (drawer.js:829), and it wedges: a turn
  // that dies before any turnInFlight:true frame leaves the composer stuck on
  // Steer forever, and every later send 409s with no_turn.
  const flagFor = await extract("turnFlagFor");
  assert.equal(flagFor({ state: "awake", turnInFlight: true }), true);
  assert.equal(flagFor({ state: "awake", turnInFlight: false }), false);
  assert.equal(flagFor({ state: "stopped", turnInFlight: true }), false);
  assert.equal(flagFor({}), false);
});

test("the composer posts a message when idle and steers a running turn", async () => {
  const sendPath = await extract("sendPath");
  assert.equal(sendPath("perchlive-aa11bb22", false), "/interactive/perchlive-aa11bb22/message");
  assert.equal(sendPath("perchlive-aa11bb22", true), "/interactive/perchlive-aa11bb22/steer");
});

test("an empty or whitespace-only message is not sent", async () => {
  const sendable = await extract("sendable");
  assert.equal(sendable(""), false);
  assert.equal(sendable("   \n "), false);
  assert.equal(sendable("hello"), true);
});

test("a dead session stops the retry loop instead of burning five reconnects", async () => {
  // 404 no_such_session / 410 stopped are terminal. Retrying them five times
  // then saying "reconnect failed" hides the real answer from the operator.
  const terminal = await extract("isTerminalStreamStatus");
  assert.equal(terminal(404), true);
  assert.equal(terminal(410), true);
  assert.equal(terminal(401), true);   // logged out — retrying cannot help
  assert.equal(terminal(500), false);  // a real blip; retry is right
  assert.equal(terminal(0), false);
});

test("something actually runs at load — a deep link must not land on an empty list", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // Task 7 navigates with location.href, a FULL load, which fires no
  // hashchange. A listener alone leaves every hand-off on a stuck list.
  assert.ok(/if\(parseHash\(location\.hash\)\)\s*applyHash\(\);/.test(js),
    "a deep-linked session must open on first paint");
  assert.ok(/else\s*\{\s*startListPolling\(\);\s*loadList\(\);/.test(js),
    "and a bare /dashboard/perch must load the list rather than sit on the placeholder");
});

test("every string constant the script references is bound", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // new Function binds references at CALL time, so a parse test cannot catch a
  // missing constant — it surfaces as a ReferenceError on the error path, which
  // is the path nobody exercises by hand.
  for (const name of ["SESSION_GONE", "NO_TRANSCRIPT", "RECONNECTING",
                      "RECONNECT_FAILED", "ASK_STALE", "STEER_LABEL", "SEND_LABEL"]) {
    if (!js.includes(name)) continue;               // not every task binds all of them
    assert.ok(new RegExp("var\\s+" + name + "\\s*=").test(js), name + " is used but never bound");
  }
});

test("async continuations are guarded — a fast back button must not cross sessions", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // The guards are load-bearing and were previously pinned only by a commit
  // message. openSession's /roost fetch, loadHistory, onStreamError's options
  // fetch, the reconnect timer, answerAsk, and every SSE listener.
  // 11 as of this fix wave: openSession's /roost fetch, startSession's spawn
  // continuation, every SSE listener (shared through on()), onStreamError's
  // options probe, the reconnect timer, loadHistory, loadOptions, send(),
  // answerAsk, and attachFile's upload continuation. A regression that drops
  // one — the count that shipped with only 6 asserted — is invisible until
  // an operator hits the exact race the dropped guard covered.
  const guards = (js.match(/current\.sid\s*!==/g) || []).length;
  assert.equal(guards, 11, "expected exactly 11 identity guards, found " + guards);
});

test("the emitted script never assigns to an innerHTML-class sink", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // crow_csrf is deliberately not HttpOnly, so an injection into any of
  // these sinks exfiltrates it. A bare `.includes("innerHTML")` substring
  // check also fails on a comment that WARNS against innerHTML, which is
  // backwards — assert on the assignment/call shape instead.
  // Matches both plain (=) and compound (+=) assignment — a compound
  // assignment against these sinks parses and executes the same injection
  // and a narrower regex let it through undetected.
  assert.ok(!/\.innerHTML\s*\+?=/.test(js), "no .innerHTML assignment");
  assert.ok(!/\.outerHTML\s*\+?=/.test(js), "no .outerHTML assignment");
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(js), "no insertAdjacentHTML call");
  assert.ok(!/document\.write\s*\(/.test(js), "no document.write call");
});

/** A function's OWN source, brace-matched. Never a fixed-size window: every
 *  magic-number slice in earlier drafts of this plan was wrong, and this one
 *  would straddle the very next function (resetBackoff, whose whole body is
 *  `retries=0`) and fail against correct code. */
async function fnSrc(name) {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const src = perchHubJs("en");
  const start = src.indexOf("function " + name);
  assert.ok(start > -1, name + " is not in the emitted script");
  const end = braceMatchEnd(src, start);
  return src.slice(start, end + 1);
}

test("the reconnect cap is actually reachable", async () => {
  const js = (await import("../servers/gateway/dashboard/perch-hub/client.js")).perchHubJs("en");
  assert.ok(!(await fnSrc("cancelReconnect")).includes("retries=0"),
    "cancelling the timer must not reset the counter — closeStream() runs before every schedule");
  assert.ok(js.includes("function resetBackoff"), "the counter resets on a stream that opened, not on cancel");
  assert.ok(/scheduleReconnect\(\)/.test(js), "no argument — the arity mismatch that made this dead code");
});

test("a model option shows its human name and says when it is not serving", async () => {
  const modelOptionText = await extract("modelOptionText");
  assert.equal(modelOptionText({ provider: "crow-local", id: "qwen3.6-35b-a3b",
    name: "Qwen3.6 35B A3B", availability: "up" }), "Qwen3.6 35B A3B");
  assert.equal(modelOptionText({ provider: "p", id: "m", name: "Big Model",
    availability: "on_demand" }), "Big Model — starts on demand");
  assert.equal(modelOptionText({ provider: "crow-dsv4", id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash", availability: "unavailable" }), "DeepSeek-V4-Flash — not running");
  // No name on the entry falls back to provider/id, never to "undefined".
  assert.equal(modelOptionText({ provider: "p", id: "m", availability: "up" }), "p/m");
});

test("a hibernating session disables the pickers rather than emptying them", async () => {
  const optionsUsable = await extract("optionsUsable");
  assert.equal(optionsUsable({ models: null, thinkingLevels: null }), false);
  assert.equal(optionsUsable({ models: [], thinkingLevels: [] }), false);
  assert.equal(optionsUsable({ models: [{ id: "m", provider: "p" }], thinkingLevels: ["off"] }), true);
  assert.equal(optionsUsable(null), false);
});

test("control bodies use the exact keys the route reads, not camelCase", async () => {
  const controlBody = await extract("controlBody");
  assert.deepEqual(controlBody("model", "crow-local/qwen3.6-35b-a3b"),
    { model: { provider: "crow-local", id: "qwen3.6-35b-a3b" } });
  assert.deepEqual(controlBody("thinking", "off"), { thinking: "off" });
  // The silent-failure guards: the route drops unknown keys and still 200s.
  assert.deepEqual(controlBody("permission", "bypass"), { permission_mode: "bypass" });
  assert.deepEqual(controlBody("plan", true), { plan_mode: true });
});

// Carried-over fix (found during Task 4): send(), closeSession() and the
// abort path were all written but never connected to a DOM control, so the
// chat view rendered and Send did nothing. Every review round missed it
// because every test here extracts a pure function and asserts behaviour,
// never reachability. This test pins reachability with structural regexes
// against the assignment expression itself — a bare substring scan on
// "send" false-negatives here, because that word also appears inside the
// string 'The message did not send.' (SEND_FAILED's translation).
test("perch-send, perch-back and perch-abort are actually wired to handlers", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // Masked against comments (same helper the extractor uses): a comment
  // that merely NAMES the binding expression — e.g. one documenting this
  // very fix — must not satisfy the assertion. Caught live while writing
  // this test: replacing the real binding line with a comment that quoted
  // it verbatim kept this test green until the mask was added.
  const code = maskComments(js);
  assert.ok(/el\(\s*['"]perch-send['"]\s*\)\.onclick\s*=\s*send\s*;/.test(code),
    "#perch-send has no click handler bound to send()");
  assert.ok(/el\(\s*['"]perch-back['"]\s*\)\.onclick\s*=\s*function\s*\(\)\s*\{\s*location\.hash\s*=\s*'';/.test(code),
    "#perch-back must set location.hash='' so applyHash -> closeSession runs and history stays correct");
  assert.ok(/el\(\s*['"]perch-abort['"]\s*\)\.onclick\s*=/.test(code),
    "#perch-abort has no click handler bound");
  assert.ok(/interactive\/'\+encodeURIComponent\(current\.sid\)\+'\/abort/.test(code),
    "the abort handler must POST /interactive/<sid>/abort");
});

test("ask options are plain strings, exactly as the engine sends them", async () => {
  const askOptions = await extract("askOptions");
  // cardFrom() does options.slice() on whatever pi sent — strings.
  assert.deepEqual(askOptions({ requestId: "r1", method: "select", options: ["yes", "no"] }), ["yes", "no"]);
  assert.deepEqual(askOptions({ requestId: "r2", method: "input", placeholder: "name" }), []);
  assert.deepEqual(askOptions({ requestId: "r3", method: "confirm" }), []);
  assert.deepEqual(askOptions({ method: "select", options: ["a"] }), [], "no requestId is unanswerable");
  assert.deepEqual(askOptions(null), []);
});

test("a confirm card answers with confirmed, never value — this one denies permissions if wrong", async () => {
  const payloadFor = await extract("answerPayloadFor");
  const card = { requestId: "r9", method: "confirm", title: "Run bash?" };
  assert.deepEqual(payloadFor(card, { confirm: true }), { requestId: "r9", confirmed: true });
  assert.deepEqual(payloadFor(card, { confirm: false }), { requestId: "r9", confirmed: false });
  // The bug being guarded: {value:"yes"} on a confirm card reads as DENY.
  const wrong = payloadFor(card, { confirm: true });
  assert.ok(!("value" in wrong), "a confirm card must not carry value");
});

test("select, input and editor answer with value", async () => {
  const payloadFor = await extract("answerPayloadFor");
  assert.deepEqual(payloadFor({ requestId: "r1", method: "select" }, { value: "yes" }),
    { requestId: "r1", value: "yes" });
  assert.deepEqual(payloadFor({ requestId: "r2", method: "input" }, { value: "Kevin" }),
    { requestId: "r2", value: "Kevin" });
  assert.deepEqual(payloadFor({ requestId: "r3", method: "editor" }, { value: "line\nline" }),
    { requestId: "r3", value: "line\nline" });
});

test("cancel is a real answer and outranks the method", async () => {
  const payloadFor = await extract("answerPayloadFor");
  // engine.answer checks cancelled FIRST, before the confirm branch.
  assert.deepEqual(payloadFor({ requestId: "r4", method: "confirm" }, { cancelled: true }),
    { requestId: "r4", cancelled: true });
  assert.deepEqual(payloadFor({ requestId: "r5", method: "select" }, { cancelled: true }),
    { requestId: "r5", cancelled: true });
});

test("an editor card offers its prefill and an input its placeholder", async () => {
  const askFields = await extract("askFields");
  assert.deepEqual(askFields({ requestId: "r1", method: "editor", prefill: "draft" }),
    { initial: "draft", placeholder: "" });
  assert.deepEqual(askFields({ requestId: "r2", method: "input", placeholder: "your name" }),
    { initial: "", placeholder: "your name" });
  assert.deepEqual(askFields({ requestId: "r3", method: "select", options: ["a"] }),
    { initial: "", placeholder: "" });
});

// attachToCard (and its ATTACH_FAILED string) was zero-reference dead code —
// no UI ever called it. Removed; it returns in a later PR with a real
// trigger, at which point it gets its own test again.
test("attachToCard is gone — dead code with no UI trigger, not a live route binding", async () => {
  const js = (await import("../servers/gateway/dashboard/perch-hub/client.js")).perchHubJs("en");
  assert.ok(!js.includes("attachToCard"));
  assert.ok(!js.includes("ATTACH_FAILED"));
});

// ---------------------------------------------------------------------------
// Full-script harness — runs the WHOLE emitted IIFE (not one extracted
// function) against a fake DOM/fetch/EventSource in a fresh vm context.
// Needed for anything the pure-function extractor above cannot see: real
// bootstrap-time bindings (el('x').onchange=...), the effect of a rejected
// fetch() on the promise chain, and event-listener collisions on the same
// EventSource instance. vm.createContext gives ECMAScript builtins (Array,
// JSON, Math, Promise, encodeURIComponent, ...) for free; document, window,
// location, EventSource, fetch and the timer functions are supplied here.
// ---------------------------------------------------------------------------

function makeEventTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    _dispatch(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev)); },
    _listenerCount(type) { return (listeners[type] || []).length; },
  };
}

function makeFakeElement(tag) {
  const target = makeEventTarget();
  const attrs = {};
  return Object.assign(target, {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    style: {},
    className: "",
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    placeholder: "",
    type: "",
    files: null,
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
    get firstChild() { return this.children[0] || null; },
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.unshift(node); else this.children.splice(i, 0, node);
      return node;
    },
    setAttribute(name, val) { attrs[name] = String(val); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    click() { if (this.onclick) this.onclick(); },
  });
}

/** A fake EventSource that keeps addEventListener('error', ...) listeners
 *  SEPARATE from the onerror property — exactly like a real one, where a
 *  native connection failure reaches every "error" listener (not just
 *  onerror) with an event that carries no .data, and a named server frame
 *  reaches only addEventListener('error', ...) with a real .data string. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this._t = makeEventTarget();
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) { this._t.addEventListener(type, fn); }
  removeEventListener(type, fn) { this._t.removeEventListener(type, fn); }
  close() { this.closed = true; }
  _open() { if (this.onopen) this.onopen(); }
  /** A real named SSE frame: `event: <type>\ndata: <json>`. */
  _serverFrame(type, dataObj) { this._t._dispatch(type, { data: JSON.stringify(dataObj) }); }
  /** A native connection failure: type "error", no .data, delivered to every
   *  "error" listener AND the onerror property — the collision I3 fixes. */
  _nativeError() {
    const ev = {};
    this._t._dispatch("error", ev);
    if (this.onerror) this.onerror(ev);
  }
}
FakeEventSource.instances = [];

function makeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Mounts the real emitted script in a fresh vm context. `fetchImpl(method,
 *  path, opts)` decides how every perchApi call resolves; the default 200s
 *  everything with `{}`. Returns the fake DOM pieces and every fetch call
 *  made, in order, so a test can assert on both wiring and traffic. */
async function mountHub({ fetchImpl } = {}) {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");

  const IDS = ["perch-list-body", "perch-transcript", "perch-ask", "perch-bot-name",
    "perch-session-meta", "perch-state", "perch-model", "perch-thinking", "perch-permission",
    "perch-plan-mode", "perch-input", "perch-send", "perch-back", "perch-abort",
    "perch-attach", "perch-file-input", "perch-chat"];
  const els = {};
  for (const id of IDS) els[id] = makeFakeElement(id === "perch-plan-mode" ? "input" : "div");

  const bodyEl = makeFakeElement("body");
  const fetchCalls = [];
  const fetchFn = fetchImpl || (() => Promise.resolve(makeResponse(200, {})));

  const doc = {
    cookie: "crow_csrf=test-csrf-token",
    body: bodyEl,
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return makeFakeElement(tag); },
  };

  const winTarget = makeEventTarget();
  const vvTarget = makeEventTarget();
  const visualViewport = Object.assign(vvTarget, { height: 700, offsetTop: 0 });
  const win = Object.assign(winTarget, { visualViewport, innerHeight: 800 });

  const locState = { hash: "" };
  const location = {
    get hash() { return locState.hash; },
    set hash(v) { locState.hash = v; winTarget._dispatch("hashchange", {}); },
    href: "",
  };

  // Timers are recorded, never actually fired by the real clock — nothing
  // under test needs a real 2s/10s wait, and a live setInterval would leak a
  // handle past the end of every test that mounts this harness.
  let timerSeq = 1;
  const timers = new Map();
  const sandbox = {
    document: doc,
    window: win,
    location,
    EventSource: FakeEventSource,
    fetch(url, opts) {
      const method = (opts && opts.method) || "GET";
      const path = String(url).replace(/^.*perch-api/, "");
      fetchCalls.push({ method, path, opts });
      return Promise.resolve(fetchFn(method, path, opts));
    },
    setTimeout(fn) { const id = timerSeq++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = timerSeq++; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    FileReader: class {
      constructor() { this.onload = null; this.result = null; }
      readAsDataURL(file) {
        this.result = "data:" + (file.type || "") + ";base64," + (file.b64 || "AAAA");
        if (this.onload) this.onload();
      }
    },
  };
  vm.createContext(sandbox);
  FakeEventSource.instances.length = 0;
  vm.runInContext(js, sandbox);

  // Drain one microtask hop so the bootstrap's own loadList() promise chain
  // (perchApi -> .then -> renderList) has actually run before a test reads
  // fetchCalls or the DOM it produced.
  await new Promise((r) => setTimeout(r, 0));

  return { els, doc, win, location, fetchCalls, sandbox, timers };
}

/** Opens a chat session the same way a real click does: seed a /roost
 *  response with one live session, let the bootstrap's loadList() render it,
 *  then click its row button — this drives openSession()/afterHeader() as
 *  real user input would, rather than reaching into the closure. */
async function openChatSession(hub, sid = "perchlive-aaaaaaaa") {
  hub.location.hash = sid;
  await new Promise((r) => setTimeout(r, 0));
}

const ROOST_ONE_LIVE = {
  birds: [{ id: "r4", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [{ sessionId: "perchlive-aaaaaaaa", state: "awake", cardId: null, pendingUi: false }] }],
};

/** A fetchImpl covering the calls afterHeader() fires on a cold deep link
 *  (GET /roost to resolve the bot, then options + transcript + the SSE
 *  connect isn't fetch-based). Individual tests override specific paths via
 *  `overrides`. */
function stdFetch(overrides = {}) {
  return (method, path) => {
    for (const [matcher, fn] of Object.entries(overrides)) {
      if (path.includes(matcher)) return fn(method, path);
    }
    if (path === "/roost") return makeResponse(200, ROOST_ONE_LIVE);
    if (path.endsWith("/options")) return makeResponse(200, { models: [], thinkingLevels: [] });
    if (path.endsWith("/transcript")) return makeResponse(200, { events: [] });
    return makeResponse(200, {});
  };
}

// ---- C1: the queued image actually rides the next message, then clears ----

test("C1: an attached image rides the NEXT /message body and the queue empties", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);

  // attachFile() is reached only through the real onchange binding — set a
  // file on the fake input and fire it, exactly as a browser would.
  hub.els["perch-file-input"].files = [{ name: "shot.png", type: "image/png", b64: "Zm9v" }];
  hub.els["perch-file-input"].onchange();
  await new Promise((r) => setTimeout(r, 0));

  hub.els["perch-input"].value = "look at this";
  hub.els["perch-send"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  const sent = hub.fetchCalls.filter((c) => c.path.endsWith("/message"));
  assert.equal(sent.length, 1, "one message went out");
  const body = JSON.parse(sent[0].opts.body);
  assert.deepEqual(body.images, [{ mime: "image/png", data_b64: "Zm9v" }],
    "the image the drawer's own wire shape uses — {mime,data_b64}");

  // A second send with nothing newly attached must not resend the same image.
  hub.els["perch-input"].value = "and again";
  hub.els["perch-send"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const secondBody = JSON.parse(hub.fetchCalls.filter((c) => c.path.endsWith("/message")).at(-1).opts.body);
  assert.equal("images" in secondBody, false, "the queue must be empty on the next send");
});

test("C1: a non-image upload is never queued onto a send", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  hub.els["perch-file-input"].files = [{ name: "notes.txt", type: "text/plain", b64: "aGk=" }];
  hub.els["perch-file-input"].onchange();
  await new Promise((r) => setTimeout(r, 0));
  hub.els["perch-input"].value = "hello";
  hub.els["perch-send"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const sent = hub.fetchCalls.filter((c) => c.path.endsWith("/message"));
  const body = JSON.parse(sent.at(-1).opts.body);
  assert.equal("images" in body, false);
});

// ---- C2: perchApi resolves (never rejects) on a network-level failure ----

test("C2: a destroyed socket reaches onStreamError and schedules a reconnect", async () => {
  // The options probe onStreamError fires rejects at the transport level —
  // exactly what a dropped tunnel/gateway restart looks like from fetch().
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/options": () => Promise.reject(new Error("network down")) }),
  });
  await openChatSession(hub);
  assert.equal(FakeEventSource.instances.length, 1);
  const es = FakeEventSource.instances[0];
  es._nativeError();                          // the onerror property fires this
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));  // one more hop: options probe -> scheduleReconnect

  const notes = hub.els["perch-transcript"].children
    .filter((c) => c.className.includes("note")).map((c) => c.textContent);
  assert.ok(notes.includes("Reconnecting…"),
    "scheduleReconnect() must run — before this fix the options probe's promise " +
    "never settled and this .then() body never ran at all");
});

test("C2: a failed send appends a visible note instead of vanishing silently", async () => {
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/message": () => Promise.reject(new Error("network down")) }),
  });
  await openChatSession(hub);
  hub.els["perch-input"].value = "hello";
  hub.els["perch-send"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const notes = hub.els["perch-transcript"].children
    .filter((c) => c.className.includes("note")).map((c) => c.textContent);
  assert.ok(notes.includes("The message did not send."),
    "send()'s .then must actually run on a rejected fetch for this note to appear");
});

// ---- I3: a native connection error must not masquerade as an engine frame ----

test("I3: a native EventSource error prints nothing; a real error FRAME prints its text", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];

  const notesBefore = hub.els["perch-transcript"].children.length;
  es._t._dispatch("error", {});               // native: no .data, addEventListener path only
  await new Promise((r) => setTimeout(r, 0));
  const notesAfterNative = hub.els["perch-transcript"].children
    .filter((c) => c.className.includes("note")).map((c) => c.textContent);
  assert.ok(!notesAfterNative.includes("error"),
    "a native connection failure must not print a bare 'error' note");

  es._serverFrame("error", { text: "pi crashed" });
  await new Promise((r) => setTimeout(r, 0));
  const notesAfterFrame = hub.els["perch-transcript"].children
    .filter((c) => c.className.includes("note")).map((c) => c.textContent);
  assert.ok(notesAfterFrame.includes("pi crashed"),
    "a real engine error FRAME must still render its text");
  assert.ok(notesBefore <= notesAfterFrame.length - 1);
});

// ---- I2: bindings a green suite could previously delete undetected ----

test("I2: perchApi sends X-Crow-Csrf carrying the actual cookie value", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  assert.ok(hub.fetchCalls.length >= 1, "the bootstrap's own loadList() must have fired");
  const headers = hub.fetchCalls[0].opts.headers;
  assert.equal(headers["X-Crow-Csrf"], "test-csrf-token",
    "must carry the value parsed out of document.cookie, not a hardcoded or absent header");
});

test("I2: the model/thinking/permission/plan-mode pickers are wired to POST /control", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  hub.fetchCalls.length = 0;

  hub.els["perch-model"].value = "crow-local/qwen3.6-35b-a3b";
  hub.els["perch-model"].onchange();
  hub.els["perch-thinking"].value = "high";
  hub.els["perch-thinking"].onchange();
  hub.els["perch-permission"].value = "bypass";
  hub.els["perch-permission"].onchange();
  hub.els["perch-plan-mode"].checked = true;
  hub.els["perch-plan-mode"].onchange();
  await new Promise((r) => setTimeout(r, 0));

  const controlCalls = hub.fetchCalls.filter((c) => c.path.endsWith("/control"));
  assert.equal(controlCalls.length, 4, "all four pickers must post a control change");
  const bodies = controlCalls.map((c) => JSON.parse(c.opts.body));
  assert.deepEqual(bodies[0], { model: { provider: "crow-local", id: "qwen3.6-35b-a3b" } });
  assert.deepEqual(bodies[1], { thinking: "high" });
  assert.deepEqual(bodies[2], { permission_mode: "bypass" });
  assert.deepEqual(bodies[3], { plan_mode: true });
});

test("I2: an ask_user frame actually renders the card — the listener is live", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("ask_user", { requestId: "r1", method: "confirm", title: "Run bash?" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.els["perch-ask"].children.length, 1, "renderAsk must have written a card");
  assert.equal(hub.els["perch-ask"].children[0].className, "ask-card");
});

test("I2: the attach button opens the file picker", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  let clicked = false;
  hub.els["perch-file-input"].click = () => { clicked = true; };
  hub.els["perch-attach"].onclick();
  assert.ok(clicked, "#perch-attach must delegate to the hidden file input");
});

test("I2: applyVV is bound to BOTH visualViewport events, not two different handlers", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const vv = hub.win.visualViewport;
  assert.equal(vv._listenerCount("resize"), 1);
  assert.equal(vv._listenerCount("scroll"), 1);
  // Firing either must run the SAME real computation, not a no-op stand-in —
  // rebinding both calls to `function(){}` still satisfies "one listener
  // each", so the proof has to be behavioral: it must actually move the
  // padding, from the visualViewport numbers this harness set.
  hub.win.innerHeight = 800;
  vv.height = 650; vv.offsetTop = 0;           // 150px of keyboard behind the layout viewport
  vv._dispatch("resize", {});
  assert.equal(hub.els["perch-chat"].style.paddingBottom, "150px");
  hub.els["perch-chat"].style.paddingBottom = "";
  vv.height = 800;                             // keyboard gone
  vv._dispatch("scroll", {});
  assert.equal(hub.els["perch-chat"].style.paddingBottom, "",
    "scroll must run the identical calculation, not a stub bound separately");
});
