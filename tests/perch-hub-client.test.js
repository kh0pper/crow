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
  // 12 as of the launch-model wave: openSession's /roost fetch, startSession's
  // spawn continuation AND its launch-model control continuation, every SSE
  // listener (shared through on()), onStreamError's options probe, the
  // reconnect timer, loadHistory, loadOptions, send(), answerAsk, and
  // attachFile's upload continuation. A regression that drops one — the count
  // that shipped with only 6 asserted — is invisible until an operator hits
  // the exact race the dropped guard covered.
  const guards = (js.match(/current\.sid\s*!==/g) || []).length;
  assert.equal(guards, 12, "expected exactly 12 identity guards, found " + guards);
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
  assert.ok(!/\.outerHTML\s*\+?=/.test(js), "no .outerHTML assignment");
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(js), "no insertAdjacentHTML call");
  assert.ok(!/document\.write\s*\(/.test(js), "no document.write call");

  // ONE innerHTML assignment is now permitted — server-rendered, sanitized
  // markdown for a bot message — and the permission is written as a COUNT plus
  // a location, not as a hole. A second one, anywhere, fails here.
  const assignments = js.match(/\.innerHTML\s*\+?=/g) || [];
  assert.equal(assignments.length, 1, "exactly one .innerHTML assignment: " + assignments.length);
  assert.match(js, /function setSanitizedHtml\(node,html\)\{ node\.innerHTML=html; \}/,
    "and it is the single named sink, so a reader can find every path into it at once");
  // …and that sink has exactly one caller. Reusing it for anything that is not
  // server-sanitized is the way this permission would rot.
  const calls = js.match(/setSanitizedHtml\(/g) || [];
  assert.equal(calls.length, 2, "one definition, one call site: " + calls.length);
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

test("the two pickers are gated separately — the fallback list must not be disabled by a missing thinking list", async () => {
  // The engine's hibernating answer is now {models: <provider catalogue>,
  // thinkingLevels: null}: a model switch made while asleep binds at the next
  // wake and really works, a thinking switch does nothing at all. One shared
  // gate would disable the picker that WORKS because of the one that does not,
  // which is the dead dropdown this wave exists to end.
  const listUsable = await extract("listUsable");
  assert.equal(listUsable([{ id: "m" }]), true);
  assert.equal(listUsable([]), false);
  assert.equal(listUsable(null), false);
  assert.equal(listUsable(undefined), false);
  assert.equal(listUsable("crow-local/qwen"), false, "a string is not a list");
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
  const node = Object.assign(target, {
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
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.unshift(node); else this.children.splice(i, 0, node);
      return node;
    },
    setAttribute(name, val) { attrs[name] = String(val); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    click() { if (this.onclick) this.onclick(); },
  });
  // defineProperty, NOT a `get firstChild()` in the object literal above:
  // Object.assign copies a getter's VALUE, not the getter, so firstChild was
  // frozen at null (children was empty at creation) for the life of every
  // element. clearEl()'s `while(node.firstChild)` therefore never removed
  // anything, and #perch-list-body silently ACCUMULATED every render on top of
  // the last. Found while debugging an off-by-four row count; the assertions
  // it weakened were the ones that read the list body.
  Object.defineProperty(node, "firstChild", {
    get() { return this.children[0] || null; },
    configurable: true,
  });
  // innerHTML: the ONE sanitized sink the client has (server-rendered
  // markdown). Recorded rather than parsed — this harness is not a DOM, and
  // what matters here is WHICH path appendMessage took and with what string.
  // The rendered result itself is measured live in perch-hub-render.test.js.
  node.innerHTML = "";
  // A real <select> exposes its options BOTH as .children and as .options;
  // the client reads .options (the idiomatic API) and this harness had only
  // the former, which surfaced as a TypeError rather than as a failed
  // assertion the first time production code used it.
  Object.defineProperty(node, "options", {
    get() { return this.children; },
    configurable: true,
  });
  return node;
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
async function mountHub({ fetchImpl, confirmImpl, promptImpl, initialHash = "", split = false,
                          legacyMediaQuery = false } = {}) {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");

  const IDS = ["perch-list-body", "perch-transcript", "perch-ask", "perch-bot-name",
    "perch-session-meta", "perch-state", "perch-model", "perch-thinking", "perch-permission",
    "perch-plan-mode", "perch-input", "perch-send", "perch-back", "perch-abort",
    "perch-attach", "perch-file-input", "perch-chat",
    // Task C: the unconditional launcher and the two close controls.
    "perch-new", "perch-new-bot", "perch-new-bot-label", "perch-launch-note", "perch-close",
    // The launch-model picker.
    "perch-new-model", "perch-new-model-label",
    // Session rename: the header control and the name line it writes.
    "perch-rename", "perch-session-name"];
  const els = {};
  for (const id of IDS) els[id] = makeFakeElement(id === "perch-plan-mode" ? "input" : "div");

  const bodyEl = makeFakeElement("body");
  const fetchCalls = [];
  const fetchFn = fetchImpl || (() => Promise.resolve(makeResponse(200, {})));

  // addEventListener on the DOCUMENT, not just window: the hub script now
  // listens for Turbo's turbo:before-render to retire itself when the shell
  // swaps the body out from under it (perch-hub/client.js's ONE ACTIVE
  // INSTANCE block). A document without it throws at script-run time, which
  // would fail every test in this harness for the wrong reason.
  const docTarget = makeEventTarget();
  const doc = Object.assign(docTarget, {
    cookie: "crow_csrf=test-csrf-token",
    body: bodyEl,
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return makeFakeElement(tag); },
  });

  const winTarget = makeEventTarget();
  const vvTarget = makeEventTarget();
  const visualViewport = Object.assign(vvTarget, { height: 700, offsetTop: 0 });
  // The split-view media query. `split: true` puts the harness at >=900px,
  // where .hub-split is a two-column grid and the session list stays on screen
  // with a chat open — the state finding 1 is about. `mq._set(matches)` fires a
  // real change event, which is how a window crossing the breakpoint behaves.
  const mqTarget = makeEventTarget();
  const mq = Object.assign(mqTarget, {
    matches: !!split,
    media: "(min-width:900px)",
    _set(v) { this.matches = !!v; this._dispatch("change", { matches: this.matches }); },
  });
  // Q8: pre-2019 Safari exposes only addListener on a MediaQueryList. Drop the
  // modern spelling and map the legacy one onto the same dispatcher, so a test
  // can prove the fallback binds rather than silently doing nothing.
  if (legacyMediaQuery) {
    const modern = mq.addEventListener.bind(mqTarget);
    mq.addListener = (fn) => modern("change", fn);
    mq.removeListener = () => {};
    delete mq.addEventListener;                    // the only spelling that browser has
  }
  const win = Object.assign(winTarget, {
    visualViewport, innerHeight: 800,
    matchMedia: () => mq,
  });

  // history is counted, not simulated: assigning location.hash pushes an entry,
  // location.replace('#') does not. Both fire hashchange — verified in a real
  // browser, where the tidier-looking location.replace(pathname) fires NONE and
  // would leave the operator on a dead chat view. `replaced` records the raw
  // argument so a test can prove the terminal path took the replace form.
  // initialHash is set BEFORE the script runs, which is the only way to reach
  // the genuinely cold deep-link path: the bootstrap branches on
  // parseHash(location.hash) at load, so a hash assigned afterwards has always
  // been preceded by a list render that already populated rowIndex.
  const locState = { hash: initialHash };
  const history = { pushes: 0, replaces: 0 };
  const location = {
    get hash() { return locState.hash; },
    set hash(v) { locState.hash = v; history.pushes++; winTarget._dispatch("hashchange", {}); },
    replace(v) {
      const next = String(v);
      locState.hash = next === "#" || next === "" ? "" : next;
      history.replaces++;
      winTarget._dispatch("hashchange", {});
    },
    href: "",
  };

  // Timers are recorded, never actually fired by the real clock — nothing
  // under test needs a real 2s/10s wait, and a live setInterval would leak a
  // handle past the end of every test that mounts this harness.
  let timerSeq = 1;
  const timers = new Map();
  // Every confirm() the script asks is recorded with the exact prompt text, so
  // a test can prove BOTH that the gate was consulted and what it said.
  // Default: the operator cancels. A stop that fires anyway under this default
  // is a stop with no gate, which is the failure mode the confirmation exists
  // to prevent.
  const confirms = [];
  // Renaming asks through prompt(), the same native primitive the close gate
  // uses for confirm(). Recorded with its prefill so a test can prove BOTH
  // that the operator was asked and what they were shown. Default: cancelled
  // (null) — a rename that posts under this default is a rename with no
  // operator input at all.
  const prompts = [];
  const sandbox = {
    document: doc,
    confirm(msg) { confirms.push(String(msg)); return confirmImpl ? confirmImpl(String(msg)) : false; },
    prompt(msg, prefill) {
      prompts.push({ msg: String(msg), prefill: prefill == null ? null : String(prefill) });
      return promptImpl ? promptImpl(String(msg), prefill) : null;
    },
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

  return { els, doc, win, location, fetchCalls, sandbox, timers, confirms, prompts, history, mq };
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

// ---------------------------------------------------------------------------
// Task C — Perch owns its own session lifecycle.
//
// Kevin, verbatim: "there is no way to launch a new session, rather you can
// only interact with already existing sessions" and "it looks like there are 8
// sessions running, most of which were started by mistake, and I cannot close
// them".
//
// Every test below drives a REAL onclick handler through mountHub() and
// asserts on the REAL fetch bodies. Extracting the new pure functions and
// asserting on their return values would prove nothing about whether anything
// is bound to a control — which is the exact class of miss this file already
// carries a scar for (see "perch-send, perch-back and perch-abort are actually
// wired to handlers" above, where send() was correct, unit-tested, and wired
// to nothing).
// ---------------------------------------------------------------------------

/** Kevin's instance, reduced: ONE perch-attached bot, and it is busy. There is
 *  no idle row here, because listRows() drops a bot's idle row the moment it
 *  has a live session — so a launcher derived from rows would be absent. A
 *  fixture with an empty roost, or with one idle bot, would NOT reproduce the
 *  reported bug and would pass against the broken code. */
const ROOST_ALL_BUSY = {
  birds: [{
    id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [
      { sessionId: "perchlive-11111111", state: "awake", cardId: null, pendingUi: false },
      { sessionId: "perchlive-22222222", state: "awake", cardId: null, pendingUi: false },
      { sessionId: "perchlive-33333333", state: "hibernating", cardId: null, pendingUi: false },
    ],
  }],
};

const ROOST_TWO_BOTS = {
  birds: [
    { id: "alpha", name: "Alpha", perch_attached: true, state: "working",
      sessions: [{ sessionId: "perchlive-aaaa1111", state: "awake", cardId: null, pendingUi: false }] },
    { id: "beta", name: "Beta", perch_attached: true, state: "working",
      sessions: [{ sessionId: "perchlive-bbbb2222", state: "awake", cardId: null, pendingUi: false }] },
    { id: "quiet", name: "Quiet", perch_attached: false, state: "observing", sessions: [] },
  ],
};

const ROOST_NO_ATTACHED = {
  birds: [{ id: "quiet", name: "Quiet", perch_attached: false, state: "observing", sessions: [] }],
};

/** A fetchImpl serving a fixed roost, with the spawn/stop/session routes
 *  answering 200 by default and overridable per test. */
function roostFetch(roost, overrides = {}) {
  return (method, path) => {
    for (const [matcher, fn] of Object.entries(overrides)) {
      if (path.includes(matcher)) return fn(method, path);
    }
    if (path === "/roost") return makeResponse(200, roost);
    if (path.endsWith("/interactive")) return makeResponse(200, { sessionId: "perchlive-99999999" });
    if (path.endsWith("/stop")) return makeResponse(200, { ok: true });
    if (path.endsWith("/options")) return makeResponse(200, { models: [], thinkingLevels: [] });
    if (path.endsWith("/transcript")) return makeResponse(200, { events: [] });
    if (path.endsWith("/models")) return makeResponse(200, { models: LAUNCH_MODELS, default: "crow-local/qwen" });
    return makeResponse(200, {});
  };
}

/** The launcher's session-free list, as GET /bots/:id/models answers it:
 *  annotated entries plus the bot's own configured default. */
const LAUNCH_MODELS = [
  { provider: "crow-local", id: "qwen", name: "Qwen", availability: "up" },
  { provider: "raven-flash", id: "flash-next", name: "Flash Next", availability: "on_demand" },
  { provider: "crow-dsv4", id: "deepseek-v4", name: "DeepSeek V4", availability: "unavailable" },
];

/** Every button rendered into the list, flattened, with the row it came from. */
function listButtons(hub) {
  const out = [];
  for (const row of hub.els["perch-list-body"].children) {
    for (const child of row.children || []) {
      if (child.tagName === "BUTTON") out.push({ row, btn: child, text: child.textContent });
    }
  }
  return out;
}

const notesIn = (el) => el.children.filter((c) => String(c.className).includes("note"))
  .map((c) => c.textContent);

// ---- C1: a launcher that exists when every attached bot is already busy ----

test("C1: the launch control is live while EVERY attached bot already has a session", async () => {
  // The reported state exactly. Before this change the ONLY way to spawn was
  // an idle row, and listRows() emits none here.
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });

  assert.equal(hub.els["perch-new"].disabled, false,
    "the launcher must be usable even though no bot is idle");
  assert.equal(listButtons(hub).some((b) => b.text === "Talk"), false,
    "fixture check: there is genuinely no idle row to spawn from, which is the bug");

  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  const spawns = hub.fetchCalls.filter((c) => c.path.endsWith("/interactive"));
  assert.equal(spawns.length, 1, "one spawn went out");
  assert.equal(spawns[0].method, "POST");
  assert.equal(spawns[0].path, "/bots/r4-assistant/interactive",
    "spawned against the perch-attached bot from the roost the list already fetched");
  assert.equal(hub.location.hash, "perchlive-99999999",
    "startSession()'s own hash navigation ran — the launcher reuses it rather than respawning it");
});

test("C1: the bot ROSTER still rides the list's own /roost — the models call is the only addition", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  const gets = hub.fetchCalls.filter((c) => c.method === "GET").map((g) => g.path);
  // Two, not one: the roster comes off /roost as it always has, and the model
  // picker needs a list /roost does not carry. It is fetched per BOT, not per
  // poll — the test below pins that.
  assert.deepEqual(gets, ["/roost", "/bots/r4-assistant/models"], JSON.stringify(gets));
});

test("C1: with more than one attached bot the picker decides, and only attached bots are offered", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_TWO_BOTS) });
  const sel = hub.els["perch-new-bot"];
  assert.equal(sel.hidden, false, "two bots means the operator picks");
  assert.deepEqual(sel.children.map((o) => o.value), ["alpha", "beta"],
    "the un-attached bot must not be offered — POST /bots/quiet/interactive 403s");

  sel.value = "beta";
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const spawns = hub.fetchCalls.filter((c) => c.path.endsWith("/interactive"));
  assert.equal(spawns[0].path, "/bots/beta/interactive", "the picked bot, not the first one");
});

test("C1: one attached bot spawns with no picker at all", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  assert.equal(hub.els["perch-new-bot"].hidden, true, "a one-item dropdown is a tap for nothing");
  assert.equal(hub.els["perch-new-bot-label"].hidden, true);
});

test("C1: with no attached bot the launcher says so instead of offering a guaranteed 403", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_NO_ATTACHED) });
  assert.equal(hub.els["perch-new"].disabled, true);
  assert.equal(hub.els["perch-launch-note"].hidden, false);
  assert.equal(hub.els["perch-launch-note"].textContent,
    "No bot has a Perch channel attached, so there is nothing to start.");

  // Even driven directly — a stale enabled button, a keyboard activation — it
  // must not fire a spawn that cannot succeed.
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.fetchCalls.filter((c) => c.path.endsWith("/interactive")).length, 0);
});

test("C1: the launcher's picker survives a poll, so a mid-tap refresh cannot change the bot", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_TWO_BOTS) });
  hub.els["perch-new-bot"].value = "beta";
  // Re-run the poll body exactly as the 10s interval would.
  for (const fn of hub.timers.values()) fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.els["perch-new-bot"].value, "beta", "a poll must not reset the operator's pick");
  assert.deepEqual(hub.els["perch-new-bot"].children.map((o) => o.value), ["alpha", "beta"],
    "and must not duplicate the options either");
});

test("C1: the idle-row Talk button still spawns — same call, not a second path", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST) });
  const talk = listButtons(hub).find((b) => b.text === "Talk");
  assert.ok(talk, "an attached bot with no session keeps its row");
  talk.btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  const spawns = hub.fetchCalls.filter((c) => c.path.endsWith("/interactive"));
  assert.equal(spawns[0].path, "/bots/idle-bot/interactive");
});

// ---- C2: closing a session ------------------------------------------------

test("C2: a row's Close asks first, and a cancelled confirm posts nothing at all", async () => {
  // confirmImpl defaults to false: the operator says no.
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  const close = listButtons(hub).find((b) => b.text === "Close");
  assert.ok(close, "every live row needs a close control");
  close.btn.onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(hub.confirms.length, 1, "the gate was consulted");
  assert.match(hub.confirms[0], /cannot be reopened/i,
    "stop() is terminal — the copy has to say so, or the confirm is decoration");
  assert.equal(hub.fetchCalls.filter((c) => c.path.endsWith("/stop")).length, 0,
    "a declined confirm must leave the conversation alive");
});

test("C2: a confirmed row Close posts /interactive/<sid>/stop and refreshes the list", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY), confirmImpl: () => true });
  const before = hub.fetchCalls.filter((c) => c.path === "/roost").length;
  const close = listButtons(hub).find((b) => b.text === "Close");
  close.btn.onclick();
  await new Promise((r) => setTimeout(r, 0));

  const stops = hub.fetchCalls.filter((c) => c.path.endsWith("/stop"));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].method, "POST");
  assert.equal(stops[0].path, "/interactive/perchlive-11111111/stop");
  assert.ok(hub.fetchCalls.filter((c) => c.path === "/roost").length > before,
    "the stopped row has to leave the list, which takes a re-poll");
});

test("C2: closing the session you are IN returns to the list — no chat view on a dead stream", async () => {
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY), confirmImpl: () => true,
  });
  hub.location.hash = "perchlive-11111111";
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.doc.body.getAttribute("data-view"), "chat", "precondition: we are in the chat view");

  hub.els["perch-close"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(hub.fetchCalls.filter((c) => c.path.endsWith("/stop")).at(-1).path,
    "/interactive/perchlive-11111111/stop");
  assert.equal(hub.location.hash, "", "history stays correct: the hash drives the view, not a direct call");
  assert.equal(hub.doc.body.getAttribute("data-view"), "list");
  assert.equal(FakeEventSource.instances.at(-1).closed, true, "the SSE stream must not be left open");
});

test("C2: closing a DIFFERENT session while a chat is open does not yank the operator out of it", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY), confirmImpl: () => true });
  hub.location.hash = "perchlive-22222222";
  await new Promise((r) => setTimeout(r, 0));
  // The desktop split keeps the list rendered beside the chat, so its rows —
  // and their Close buttons — are still reachable while a session is open.
  const close = listButtons(hub).find((b) => b.text === "Close");
  close.btn.onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(hub.fetchCalls.filter((c) => c.path.endsWith("/stop")).at(-1).path,
    "/interactive/perchlive-11111111/stop", "the row's own session, not the open one");
  assert.equal(hub.location.hash, "perchlive-22222222", "the open session stays open");
  assert.equal(hub.doc.body.getAttribute("data-view"), "chat");
});

test("C2: a 410 means it is already gone — refresh, and show no error", async () => {
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/stop": () => makeResponse(410, { error: "stopped" }) }),
    confirmImpl: () => true,
  });
  const before = hub.fetchCalls.filter((c) => c.path === "/roost").length;
  listButtons(hub).find((b) => b.text === "Close").btn.onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(hub.fetchCalls.filter((c) => c.path === "/roost").length > before, "still refreshes");
  const shown = hub.els["perch-list-body"].children.map((c) => c.textContent);
  assert.equal(shown.includes("That session did not close."), false,
    "the operator's goal is already true — an error here would be a lie");
});

test("C2: a 404 is treated the same way as a 410", async () => {
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/stop": () => makeResponse(404, { error: "no_such_session" }) }),
    confirmImpl: () => true,
  });
  listButtons(hub).find((b) => b.text === "Close").btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  const shown = hub.els["perch-list-body"].children.map((c) => c.textContent);
  assert.equal(shown.includes("That session did not close."), false);
});

test("C2: any other failure is an error note, not a silent no-op", async () => {
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/stop": () => makeResponse(500, null) }),
    confirmImpl: () => true,
  });
  listButtons(hub).find((b) => b.text === "Close").btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  const shown = hub.els["perch-list-body"].children.map((c) => c.textContent);
  assert.ok(shown.includes("That session did not close."),
    "a stop that failed must say so — the row is still there and the operator needs to know why");
});

test("C2: a failure while that session is OPEN reaches the transcript, not the hidden list", async () => {
  // showListNote() writes into #perch-list-body, which the chat view hides on
  // a phone — routing an in-chat failure there would be an invisible error.
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/stop": () => makeResponse(500, { error: "engine_down" }) }),
    confirmImpl: () => true,
  });
  hub.location.hash = "perchlive-11111111";
  await new Promise((r) => setTimeout(r, 0));
  hub.els["perch-close"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(notesIn(hub.els["perch-transcript"]).includes("engine_down"));
  assert.equal(hub.doc.body.getAttribute("data-view"), "chat",
    "a session that did NOT stop must not be abandoned as though it had");
});

test("C2: an idle bot row offers no Close — there is nothing to stop", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST) });
  const idleRow = hub.els["perch-list-body"].children
    .find((row) => row.children.some((c) => c.textContent === "Talk"));
  assert.ok(idleRow);
  assert.equal(idleRow.children.some((c) => c.textContent === "Close"), false);
});

test("C2: every live row gets its own Close, bound to its own session id", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY), confirmImpl: () => true });
  const closes = listButtons(hub).filter((b) => b.text === "Close");
  assert.equal(closes.length, 3, "three live sessions, three close controls");
  closes[2].btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.fetchCalls.filter((c) => c.path.endsWith("/stop")).at(-1).path,
    "/interactive/perchlive-33333333/stop", "each row closes ITS session, not a shared one");
});

test("C2: the session id is encoded into the stop path, never concatenated raw", async () => {
  const js = (await import("../servers/gateway/dashboard/perch-hub/client.js")).perchHubJs("en");
  const code = maskComments(js);
  assert.ok(/interactive\/'\+encodeURIComponent\([^)]*\)\+'\/stop/.test(code),
    "this value reaches an API path — every use site encodes it");
  // parseHash must stay strict: it is the gate that keeps ".." out of the ids
  // this file concatenates into paths.
  assert.ok(/\/\^perchlive-\[0-9a-f\]\{8\}\$\//.test(code),
    "the engine-minted id pattern must not be loosened to admit the new controls");
});

test("C: the new controls are wired at bootstrap, not merely defined", async () => {
  const js = (await import("../servers/gateway/dashboard/perch-hub/client.js")).perchHubJs("en");
  const code = maskComments(js);   // a comment quoting the binding must not satisfy this
  assert.ok(/el\(\s*['"]perch-new['"]\s*\)\.onclick\s*=/.test(code), "#perch-new has no handler bound");
  assert.ok(/el\(\s*['"]perch-close['"]\s*\)\.onclick\s*=/.test(code), "#perch-close has no handler bound");
});

test("C: no hardcoded English — every new string comes from the perch.* i18n block", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const en = perchHubJs("en"), es = perchHubJs("es");
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  // Asserted against the RAW table, not through t(): t() falls back to en for a
  // missing es, so a key with no Spanish at all still returns a string and a
  // t()-based check passes on exactly the omission it is meant to catch.
  for (const key of ["perch.newSession", "perch.newSessionBot", "perch.noAttachedBots",
                     "perch.close", "perch.closeConfirm", "perch.closeFailed"]) {
    const entry = translations[key];
    assert.ok(entry, key + " is not in the translations table");
    assert.equal(typeof entry.en, "string", key + " has no en string");
    assert.equal(typeof entry.es, "string", key + " has no es string");
    // "Bot" is "Bot" in Spanish; every key that carries a real sentence must
    // actually differ.
    if (entry.en.includes(" ")) {
      assert.notEqual(entry.es, entry.en, key + " is untranslated — es must not be the English string");
    }
  }
  // The client-side ones must actually reach the emitted script, in BOTH langs.
  for (const [key, text] of [["perch.close", "Close"], ["perch.closeConfirm", "cannot be reopened"]]) {
    assert.ok(en.includes(text), key + " must be interpolated into the en script");
  }
  assert.ok(es.includes("No se podrá volver a abrir") || es.includes("No se podr"),
    "the es script must carry the es confirm copy, not the English one");
});

// ---------------------------------------------------------------------------
// Task C — fix round 1.
// ---------------------------------------------------------------------------

/** ROOST_ALL_BUSY, but with a card on the first session, so the row subtitle
 *  has all three parts to show. Mirrors routes/perch.js:484-513: cardId is a
 *  number or null on every session entry. */
const ROOST_ALL_BUSY_CARDED = {
  birds: [{
    id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [
      { sessionId: "perchlive-11111111", state: "awake", cardId: 248, pendingUi: false },
      { sessionId: "perchlive-22222222", state: "awake", cardId: null, pendingUi: false },
      { sessionId: "perchlive-33333333", state: "hibernating", cardId: null, pendingUi: false },
    ],
  }],
};

const subtitles = (hub) => hub.els["perch-list-body"].children
  .map((row) => (row.children || []).filter((c) => String(c.className) === "roost-main")[0])
  .filter(Boolean)
  .map((main) => main.children.filter((c) => String(c.className) === "roost-when")[0])
  .map((w) => (w ? w.textContent : null));

// ---- Finding 1: eight identical rows ----

test("F1: a row says WHICH session it is, not just which bot", async () => {
  const rowSubtitle = await extract("rowSubtitle",
    "var WAITING_ON_YOU='waiting on you', ROW_CARD='card {id}';" +
    "function shortSid(s){return String(s==null?'':s).replace(/^perchlive-/,'');}");
  assert.equal(rowSubtitle({ state: "awake", sessionId: "perchlive-11111111", cardId: 248 }),
    "awake · 11111111 · card 248");
  assert.equal(rowSubtitle({ state: "awake", sessionId: "perchlive-22222222", cardId: null }),
    "awake · 22222222");
  assert.equal(rowSubtitle({ state: "awake", sessionId: "perchlive-33333333", cardId: null, pendingUi: true }),
    "waiting on you · 33333333", "pendingUi still outranks the state word");
  // An idle bot row is unchanged: no session, so nothing to disambiguate.
  assert.equal(rowSubtitle({ state: "idle", sessionId: null, cardId: null }), "idle");
  // cardId 0 is a real id, not an absence.
  assert.equal(rowSubtitle({ state: "awake", sessionId: "perchlive-abcdef01", cardId: 0 }),
    "awake · abcdef01 · card 0");
});

test("F1: eight sessions on one bot render eight DISTINGUISHABLE rows", async () => {
  // The reported shape. Before this fix every row read "R4 Assistant / awake"
  // and the only way to tell them apart was Open -> read the meta -> Back,
  // once per candidate, each pass sitting on top of an irreversible Close.
  const eight = {
    birds: [{
      id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
      sessions: Array.from({ length: 8 }, (_, i) => ({
        sessionId: "perchlive-" + String(i).repeat(8), state: "awake", cardId: null, pendingUi: false,
      })),
    }],
  };
  const hub = await mountHub({ fetchImpl: roostFetch(eight) });
  const seen = subtitles(hub);
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).size, 8, "every row must be distinguishable: " + JSON.stringify(seen));
});

test("F1: the irreversible confirm names the session it is about to destroy", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY_CARDED), confirmImpl: () => false });
  listButtons(hub).filter((b) => b.text === "Close")[1].btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.confirms.length, 1);
  assert.match(hub.confirms[0], /R4 Assistant 22222222/,
    "a confirm that names nothing cannot correct a mis-tap, which is all it is for");
  assert.match(hub.confirms[0], /cannot be reopened/i);
});

test("F1: a cold deep link can still name its session in the confirm", async () => {
  // A GENUINELY cold link: the hash is set before the script runs, so the
  // bootstrap goes straight to openSession and no list render has populated
  // rowIndex. An earlier version of this test assigned the hash afterwards,
  // which meant renderList had already cached every row and openSession took
  // its warm branch — the cold path was never executed, and removing the
  // rowIndex write left the test green. The mutation was right; the test was
  // not exercising what it named.
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY_CARDED),
    confirmImpl: () => false,
    initialHash: "perchlive-22222222",
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.doc.body.getAttribute("data-view"), "chat", "precondition: opened cold");
  assert.equal(hub.els["perch-list-body"].children.length, 0,
    "precondition: nothing rendered the list, so rowIndex was never warmed");
  hub.els["perch-close"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(hub.confirms.at(-1), /R4 Assistant 22222222/,
    "without the cold-path rowIndex write this reads 'Close 22222222?' — an " +
    "irreversible prompt with no bot name on it");
});

// ---- Finding 3: a failed /roost must not re-create the original symptom ----

test("F3: a failed /roost says so instead of showing a false empty list", async () => {
  const hub = await mountHub({ fetchImpl: () => makeResponse(503, { error: "upstream" }) });
  const shown = hub.els["perch-list-body"].children.map((c) => c.textContent);
  assert.equal(shown.includes("No live sessions."), false,
    "a failed roost is not an empty roost — saying so is a lie");
  assert.ok(shown.includes("Could not reach the session list."));
  assert.equal(hub.els["perch-launch-note"].hidden, false,
    "and a greyed-out New session button with no reason beside it is the exact " +
    "'I can only interact with what already exists' state this task ends");
  assert.equal(hub.els["perch-launch-note"].textContent, "Could not reach the session list.");
});

test("F3: a roster we already know survives a blip and stays spawnable", async () => {
  let fail = false;
  const hub = await mountHub({
    fetchImpl: (method, path) => (path === "/roost" && fail)
      ? makeResponse(503, { error: "upstream" })
      : roostFetch(ROOST_ALL_BUSY)(method, path),
  });
  assert.equal(hub.els["perch-new"].disabled, false, "precondition: a good first poll");

  fail = true;
  for (const fn of hub.timers.values()) fn();          // the 10s poll, failing
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.els["perch-new"].disabled, false,
    "the bots did not vanish because one poll failed — spawning is still worth attempting");

  fail = false;
  for (const fn of hub.timers.values()) fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.els["perch-launch-note"].hidden, true, "and it self-heals on the next good poll");
  assert.equal(hub.els["perch-list-body"].children.length, 3);
});

// ---- Finding 5: a stop failure you navigated away from must still land ----

test("F5: a stop that fails after you move on surfaces on the next list render", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY_CARDED, {
      "/stop": () => gate.then(() => makeResponse(500, { error: "engine_down" })),
    }),
    confirmImpl: () => true,
  });

  hub.location.hash = "perchlive-11111111";
  await new Promise((r) => setTimeout(r, 0));
  hub.els["perch-close"].onclick();                    // slow POST, still in flight
  await new Promise((r) => setTimeout(r, 0));

  hub.location.hash = "perchlive-22222222";            // the operator moves on
  await new Promise((r) => setTimeout(r, 0));

  release();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  // Nothing may be written into the hidden list body while a chat is open.
  assert.equal(hub.doc.body.getAttribute("data-view"), "chat");

  hub.els["perch-back"].onclick();                     // back to the list
  await new Promise((r) => setTimeout(r, 0));
  const shown = hub.els["perch-list-body"].children.map((c) => c.textContent);
  assert.ok(shown.some((t) => /11111111 did not close/.test(String(t))),
    "the session is still alive and still costing a pi child — the operator has to be told, " +
    "and told WHICH one: " + JSON.stringify(shown));
});

// ---- Finding 7: Back after a close must not be a one-way trap ----

test("F7: closing the open session REPLACES the dead entry instead of stacking one", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY), confirmImpl: () => true });
  hub.location.hash = "perchlive-11111111";
  await new Promise((r) => setTimeout(r, 0));
  const pushesBefore = hub.history.pushes;

  hub.els["perch-close"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(hub.history.pushes, pushesBefore,
    "pushing on top of #perchlive-<gone> means Back lands on the dead deep link, " +
    "which bounces through noteAndReturnToList into another entry, forever");
  assert.equal(hub.history.replaces, 1);
  assert.equal(hub.location.hash, "", "and it still reaches the list");
  assert.equal(hub.doc.body.getAttribute("data-view"), "list");
});

test("F7: a dead deep link also replaces rather than stacking", async () => {
  // noteAndReturnToList is the other terminal path — the one Back would land
  // on if the close path stacked. It must not stack either.
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  hub.location.hash = "perchlive-deadbeef";            // valid shape, absent from /roost
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.history.replaces, 1, "the bounce back off a gone session must replace");
  const shown = hub.els["perch-list-body"].children.map((c) => c.textContent);
  assert.ok(shown.includes("That session is gone."), "and the parked note must still land");
});

test("F7: an ordinary Back out of a live session still uses a normal navigation", async () => {
  // Only the TERMINAL paths replace. Leaving a session that still exists is
  // ordinary navigation and must stay in history, or Back stops working.
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  hub.location.hash = "perchlive-11111111";
  await new Promise((r) => setTimeout(r, 0));
  const replacesBefore = hub.history.replaces;
  hub.els["perch-back"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.history.replaces, replacesBefore, "#perch-back is not a terminal path");
  assert.equal(hub.doc.body.getAttribute("data-view"), "list");
});

test("F1/F3/F5: the new strings are translated, with matching placeholders", async () => {
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const key of ["perch.rowCard", "perch.roostUnreachable", "perch.closeFailedFor", "perch.closeConfirm"]) {
    const e = translations[key];
    assert.ok(e, key + " missing");
    assert.equal(typeof e.es, "string", key + " has no es string");
    assert.notEqual(e.es, e.en, key + " is untranslated");
    const ph = (s) => (s.match(/\{[a-z]+\}/gi) || []).sort().join(",");
    assert.equal(ph(e.es), ph(e.en), key + "'s placeholders differ between en and es");
  }
  // {session} has to survive into the emitted script, or the confirm names nothing.
  const es = (await import("../servers/gateway/dashboard/perch-hub/client.js")).perchHubJs("es");
  assert.ok(es.includes("{session}"), "the es confirm must still carry the placeholder");
});

test("harness integrity: clearEl actually clears, so a re-render replaces rather than accumulates", async () => {
  // This harness's fake element used `get firstChild()` inside an object
  // literal handed to Object.assign, which copies the getter's VALUE. It was
  // frozen at null, clearEl()'s `while(node.firstChild)` never removed
  // anything, and every render piled on top of the last. Every assertion that
  // read #perch-list-body was weaker than it looked: `includes(...)` checks
  // could be satisfied by a stale render from three polls ago.
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  assert.equal(hub.els["perch-list-body"].children.length, 3);
  for (let i = 0; i < 3; i++) {
    for (const fn of hub.timers.values()) fn();
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(hub.els["perch-list-body"].children.length, 3,
    "four polls must leave three rows, not twelve");
  // And the primitive itself, directly.
  const node = hub.doc.createElement("div");
  node.appendChild(hub.doc.createElement("span"));
  assert.ok(node.firstChild, "firstChild must be a live getter, not a value snapshotted at creation");
  node.removeChild(node.firstChild);
  assert.equal(node.firstChild, null);
});

// ---- Finding 6: a failed spawn must not blank the rows you came to close ----

test("F6: a failed spawn keeps the session rows and their Close buttons on screen", async () => {
  // showListNote clears #perch-list-body. With the launcher now always
  // present, a spawn failure became a routine way to lose every row — and
  // every Close — for up to 10s, for an operator whose whole task is closing
  // sessions. The note belongs on the launcher that produced it.
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/interactive": () => makeResponse(409, { error: "engine_required" }) }),
  });
  assert.equal(hub.els["perch-list-body"].children.length, 3, "precondition");

  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(hub.els["perch-launch-note"].hidden, false, "the failure must still be reported");
  assert.equal(hub.els["perch-launch-note"].textContent, "The bot engine is not installed.");
  assert.equal(hub.els["perch-list-body"].children.length, 3,
    "and the rows the operator came to close must survive it");
  assert.equal(listButtons(hub).filter((b) => b.text === "Close").length, 3);
});

test("F6: a 403 and a shapeless 200 report on the launcher too", async () => {
  for (const [resp, expected] of [
    [makeResponse(403, { error: "perch_not_attached" }), "That bot has no Perch channel attached."],
    [makeResponse(200, {}), "Could not start a session."],
  ]) {
    const hub = await mountHub({
      fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/interactive": () => resp }),
    });
    hub.els["perch-new"].onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(hub.els["perch-launch-note"].textContent, expected);
    assert.equal(hub.els["perch-list-body"].children.length, 3, "rows survive: " + expected);
  }
});

// ---------------------------------------------------------------------------
// The launcher's model picker — "I would like to choose the model I want to
// use for the session up front."
// ---------------------------------------------------------------------------

test("the picker lists the bot's models, opens on its configured default, and says which are unavailable", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  const sel = hub.els["perch-new-model"];
  assert.equal(sel.hidden, false, "one attached bot still gets a MODEL picker — models are per bot, not per roster");
  assert.equal(hub.els["perch-new-model-label"].hidden, false);
  assert.deepEqual(sel.children.map((o) => o.value),
    ["crow-local/qwen", "raven-flash/flash-next", "crow-dsv4/deepseek-v4"]);
  assert.equal(sel.value, "crow-local/qwen", "pre-selected on the bot's own model, so launching stays one tap");
  assert.deepEqual(sel.children.map((o) => o.textContent), [
    "Qwen — bot default",
    "Flash Next — starts on demand",
    "DeepSeek V4 — not running",
  ], "an unavailable model must be visibly unavailable, never silently selectable");
});

test("launching on the default spawns and opens — no redundant model switch", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const posts = hub.fetchCalls.filter((c) => c.method === "POST").map((c) => c.path);
  assert.deepEqual(posts, ["/bots/r4-assistant/interactive"],
    "the spawn already resolved this model; switching to it would warm a provider twice for no change");
  assert.equal(hub.location.hash, "perchlive-99999999");
});

test("launching on a NON-default model switches it before the session is opened at all", async () => {
  let releaseControl;
  const controlPending = new Promise((r) => { releaseControl = r; });
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, {
      "/control": () => controlPending.then(() => makeResponse(200, { applied: { model: "raven-flash/flash-next" } })),
    }),
  });
  hub.els["perch-new-model"].value = "raven-flash/flash-next";
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));

  const control = hub.fetchCalls.filter((c) => c.path.includes("/control"));
  assert.equal(control.length, 1, "the model is applied through control(), not through a new spawn parameter");
  assert.equal(control[0].path, "/interactive/perchlive-99999999/control");
  assert.deepEqual(JSON.parse(control[0].opts.body), { model: { provider: "raven-flash", id: "flash-next" } },
    "the exact body the route reads — {provider, id}, mapped to modelId engine-side");
  // THE POINT: the chat is not reachable until the switch has landed, so the
  // first message cannot go out on the model the spawn happened to resolve.
  assert.equal(hub.location.hash, "", "the session must not open while the switch is still in flight");
  releaseControl();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.location.hash, "perchlive-99999999", "and it opens once the switch has landed");
});

test("a refused model switch opens the session anyway and says what happened", async () => {
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/control": () => makeResponse(409, { error: "turn_in_progress" }) }),
  });
  hub.els["perch-new-model"].value = "raven-flash/flash-next";
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.els["perch-launch-note"].textContent,
    "The session started on the bot's own model; the switch did not take.");
  assert.equal(hub.location.hash, "perchlive-99999999",
    "the session is real and usable — stranding a live child behind an error would be worse");
});

test("the model list is fetched per BOT, not per poll", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_ALL_BUSY) });
  const modelGets = () => hub.fetchCalls.filter((c) => c.path.endsWith("/models")).length;
  assert.equal(modelGets(), 1);
  hub.els["perch-new-model"].value = "raven-flash/flash-next";
  for (const fn of hub.timers.values()) fn();          // the 10s poll body, verbatim
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(modelGets(), 1, "a poll must not refetch — repopulating would throw away a mid-tap pick");
  assert.equal(hub.els["perch-new-model"].value, "raven-flash/flash-next", "and the pick survives");
});

test("with several bots the model list follows the roster select", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_TWO_BOTS) });
  const modelPaths = () => hub.fetchCalls.filter((c) => c.path.endsWith("/models")).map((c) => c.path);
  assert.deepEqual(modelPaths(), ["/bots/alpha/models"], "the bot the launcher would spawn against");
  hub.els["perch-new-bot"].value = "beta";
  hub.els["perch-new-bot"].onchange();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(modelPaths(), ["/bots/alpha/models", "/bots/beta/models"],
    "models are per-bot; a picker still showing alpha's models must not choose for beta");
});

test("a model list that does not arrive leaves NO picker, rather than an empty enabled one", async () => {
  const hub = await mountHub({
    fetchImpl: roostFetch(ROOST_ALL_BUSY, { "/models": () => makeResponse(503, { error: "upstream" }) }),
  });
  assert.equal(hub.els["perch-new-model"].hidden, true);
  assert.equal(hub.els["perch-new-model-label"].hidden, true);
  assert.equal(hub.els["perch-new"].disabled, false, "and the launcher still works — the model is optional");
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const posts = hub.fetchCalls.filter((c) => c.method === "POST").map((c) => c.path);
  assert.deepEqual(posts, ["/bots/r4-assistant/interactive"], "no control from a picker that is not there");
});

test("with no attached bot there is no model picker either", async () => {
  const hub = await mountHub({ fetchImpl: roostFetch(ROOST_NO_ATTACHED) });
  assert.equal(hub.els["perch-new-model"].hidden, true);
  assert.equal(hub.fetchCalls.filter((c) => c.path.endsWith("/models")).length, 0,
    "no bot to ask about");
});

test("the drawer's model picker is ENABLED on a hibernating session's fallback list", async () => {
  // Kevin's actual bug: he switched a session's model, a deploy restarted the
  // gateway, and the picker "stopped working". The switch itself was always
  // honoured (control() stores it, startChild reads it before warmModel); only
  // the list was missing, and an empty dropdown reads as a broken page.
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/options": () => makeResponse(200, {
      models: [{ provider: "crow-local", id: "qwen", name: "Qwen", availability: "up" }],
      thinkingLevels: null, current: "crow-local/qwen", source: "providers" }) }),
  });
  await openChatSession(hub);
  const modelSel = hub.els["perch-model"], thinkSel = hub.els["perch-thinking"];
  assert.equal(modelSel.disabled, false, "the fallback list is a real list and the switch really binds at the next wake");
  assert.deepEqual(modelSel.children.map((o) => o.value), ["crow-local/qwen"]);
  assert.equal(modelSel.value, "crow-local/qwen",
    "and it must SAY which one is live — enabled-and-listing was the assertion this bug walked through");
  assert.equal(thinkSel.disabled, true,
    "thinking stays disabled: control()'s thinking branch is a no-op with no child, so offering it would lie");
  assert.equal(thinkSel.children.length, 0);
});

// ---------------------------------------------------------------------------
// Finding 1 — in split view the list is VISIBLE, so it must keep polling.
// ---------------------------------------------------------------------------

test("below the breakpoint, opening a session stops the list poll — the list really is hidden there", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch(), split: false });
  assert.equal(hub.timers.size > 0, true, "the list view polls");
  await openChatSession(hub);
  assert.equal(hub.timers.size, 0, "nothing left ticking behind a hidden list");
});

test("in SPLIT view, opening a session keeps the list polling and refreshes it at once", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch(), split: true });
  const roostsBefore = hub.fetchCalls.filter((c) => c.path === "/roost").length;
  await openChatSession(hub);
  assert.ok(hub.timers.size > 0,
    "the list is on screen beside the chat; a frozen list is what showed an idle row for an awake session");
  const roosts = hub.fetchCalls.filter((c) => c.path === "/roost").length;
  assert.ok(roosts > roostsBefore, "and it refreshes immediately, so the session just opened appears as a row");
});

test("crossing the breakpoint with a chat open starts and stops the poll, with no navigation at all", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch(), split: false });
  await openChatSession(hub);
  assert.equal(hub.timers.size, 0);
  hub.mq._set(true);                       // the operator widened the window
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(hub.timers.size > 0, "the list just came on screen; it must not sit there stale");
  hub.mq._set(false);                      // and narrowed it again
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.timers.size, 0);
});

test("in split view the poll renders the newly opened session as a live row with a Close", async () => {
  // Kevin's screenshot: an awake session open on the right, and on the left a
  // single "R4 Assistant / idle" row with a Talk button. Close lives on live
  // rows only, so that surface offered no way to end anything.
  let roost = { birds: [{ id: "r4", name: "R4 Assistant", perch_attached: true, state: "idle", sessions: [] }] };
  const hub = await mountHub({ fetchImpl: stdFetch({ "/roost": () => makeResponse(200, roost) }), split: true });
  assert.deepEqual(listButtons(hub).map((b) => b.text), ["Talk"], "precondition: an idle bot, nothing live");

  // The session exists now — exactly what the frozen list never learned.
  roost = { birds: [{ id: "r4", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [{ sessionId: "perchlive-aaaaaaaa", state: "awake", cardId: null, pendingUi: false }] }] };
  await openChatSession(hub);
  await new Promise((r) => setTimeout(r, 0));
  for (const fn of hub.timers.values()) fn();          // the 10s poll body, verbatim
  await new Promise((r) => setTimeout(r, 0));

  const texts = listButtons(hub).map((b) => b.text);
  assert.ok(texts.includes("Open"), "the live session must be a row: " + JSON.stringify(texts));
  assert.ok(texts.includes("Close"), "and it must offer the Close the operator went looking for");
  assert.equal(texts.includes("Talk"), false, "the bot is no longer idle");
});

// ---------------------------------------------------------------------------
// Finding 3 — sessions can be named. "It seems like there is not a way to
// rename the sessions."
// ---------------------------------------------------------------------------

const ROOST_NAMED = {
  birds: [{ id: "r4", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [{ sessionId: "perchlive-aaaaaaaa", state: "awake", cardId: 248, pendingUi: false,
      label: "Nov package copy pass" }] }],
};

test("a named session renders its name AND keeps the id subtitle it always had", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch({ "/roost": () => makeResponse(200, ROOST_NAMED) }) });
  const rowEl = hub.els["perch-list-body"].children[0];
  const texts = rowEl.children.find((c) => c.className === "roost-main").children.map((c) => c.textContent);
  assert.deepEqual(texts, ["R4 Assistant", "Nov package copy pass", "awake · aaaaaaaa · card 248"],
    "the name is a convenience; the machine id is the identity and stays visible");
});

test("an unnamed session falls back to exactly the subtitle it had before", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  const rowEl = hub.els["perch-list-body"].children[0];
  const texts = rowEl.children.find((c) => c.className === "roost-main").children.map((c) => c.textContent);
  assert.deepEqual(texts, ["R4 Assistant", "awake · aaaaaaaa"], "no empty name line, no change to the old rendering");
});

test("a name containing markup is rendered as TEXT, in the row and in the confirm", async () => {
  const nasty = "<img src=x onerror=alert(1)>";
  const roost = { birds: [{ id: "r4", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [{ sessionId: "perchlive-aaaaaaaa", state: "awake", cardId: null, pendingUi: false, label: nasty }] }] };
  const hub = await mountHub({ fetchImpl: stdFetch({ "/roost": () => makeResponse(200, roost) }) });
  const rowEl = hub.els["perch-list-body"].children[0];
  const nameLine = rowEl.children.find((c) => c.className === "roost-main").children
    .find((c) => c.className === "roost-name");
  // line() builds with textContent; the value is never assigned to an HTML
  // sink (the whole-script no-innerHTML test above covers that structurally).
  assert.equal(nameLine.textContent, nasty);
  const close = listButtons(hub).find((b) => b.text === "Close");
  close.btn.onclick();
  assert.equal(hub.confirms.length, 1);
  assert.ok(hub.confirms[0].includes(nasty), "the confirm carries it as text too: " + hub.confirms[0]);
  assert.ok(hub.confirms[0].includes("aaaaaaaa"),
    "and still names the id — two sessions can carry the same name: " + hub.confirms[0]);
});

test("renaming from a row asks first, posts the new name, and needs no confirmation", async () => {
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/rename": () => makeResponse(200, { label: "Nov package" }) }),
    promptImpl: () => "  Nov   package  ",
  });
  const rename = listButtons(hub).find((b) => b.text === "Rename");
  assert.ok(rename, "a live row must offer it");
  rename.btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.prompts.length, 1, "the operator was asked");
  assert.equal(hub.confirms.length, 0, "renaming is reversible — no confirmation gate");
  const posts = hub.fetchCalls.filter((c) => c.path.includes("/rename"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/interactive/perchlive-aaaaaaaa/rename");
  assert.deepEqual(JSON.parse(posts[0].opts.body), { label: "  Nov   package  " },
    "raw as typed — the ENGINE normalizes, so what is stored is what comes back");
});

test("a cancelled rename posts nothing at all", async () => {
  // promptImpl defaults to null, which is what Cancel gives.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  listButtons(hub).find((b) => b.text === "Rename").btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.prompts.length, 1);
  assert.equal(hub.fetchCalls.filter((c) => c.path.includes("/rename")).length, 0);
});

test("an EMPTY answer clears the name — that is an action, not a cancel", async () => {
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/roost": () => makeResponse(200, ROOST_NAMED),
                          "/rename": () => makeResponse(200, { label: null }) }),
    promptImpl: () => "",
  });
  const rename = listButtons(hub).find((b) => b.text === "Rename");
  assert.equal(hub.prompts[0], undefined);
  rename.btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.prompts[0].prefill, "Nov package copy pass", "the prompt is prefilled with the current name");
  const posts = hub.fetchCalls.filter((c) => c.path.includes("/rename"));
  assert.equal(posts.length, 1, "an empty string must reach the engine; only null (Cancel) is a no-op");
  assert.deepEqual(JSON.parse(posts[0].opts.body), { label: "" });
});

test("the chat header shows the name, and a state frame keeps it current", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch({ "/roost": () => makeResponse(200, ROOST_NAMED) }) });
  await openChatSession(hub);
  assert.equal(hub.els["perch-session-name"].textContent, "Nov package copy pass");
  assert.equal(hub.els["perch-session-name"].hidden, false);
  assert.equal(hub.els["perch-session-meta"].textContent, "perchlive-aaaaaaaa",
    "the id line is untouched — it is the identity");

  // Renamed from somewhere else (another tab, a list row): the engine echoes
  // the label on every state frame.
  FakeEventSource.instances[0]._serverFrame("state", { state: "awake", turnInFlight: false, label: "Renamed elsewhere" });
  assert.equal(hub.els["perch-session-name"].textContent, "Renamed elsewhere");

  FakeEventSource.instances[0]._serverFrame("state", { state: "awake", turnInFlight: false, label: null });
  assert.equal(hub.els["perch-session-name"].hidden, true, "a cleared name hides the line rather than showing an empty one");
});

test("the header's Rename control is wired and prefilled from the open session", async () => {
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/roost": () => makeResponse(200, ROOST_NAMED),
                          "/rename": () => makeResponse(200, { label: "Renamed" }) }),
    promptImpl: () => "Renamed",
  });
  await openChatSession(hub);
  hub.els["perch-rename"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.prompts[0].prefill, "Nov package copy pass");
  const posts = hub.fetchCalls.filter((c) => c.path.includes("/rename"));
  assert.equal(posts[0].path, "/interactive/perchlive-aaaaaaaa/rename");
  assert.equal(hub.els["perch-session-name"].textContent, "Renamed",
    "the header reflects what the engine STORED, not what was typed");
});

test("a refused rename says so instead of silently keeping the old name", async () => {
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/rename": () => makeResponse(404, { error: "no_such_session" }) }),
    promptImpl: () => "whatever",
  });
  listButtons(hub).find((b) => b.text === "Rename").btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  const noteText = hub.els["perch-list-body"].children.map((c) => c.textContent).join(" ");
  assert.ok(noteText.includes("That session was not renamed."), noteText);
});

test("a transcript that FAILED to load says so, instead of reporting an empty one", async () => {
  // The old code collapsed a 500, a dropped tunnel and a logged-out session
  // into "No transcript yet." — a reassuring sentence about a conversation
  // that is still there. Flagged twice before this fix.
  const hub = await mountHub({ fetchImpl: stdFetch({ "/transcript": () => makeResponse(503, { error: "upstream" }) }) });
  await openChatSession(hub);
  assert.deepEqual(notesIn(hub.els["perch-transcript"]), ["Could not load this session's history."]);
});

test("a genuinely empty transcript still reports empty, not failed", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });      // 200 with events: []
  await openChatSession(hub);
  assert.deepEqual(notesIn(hub.els["perch-transcript"]), ["No transcript yet."]);
});

test("the emitted script is syntactically valid JS", async () => {
  // Cheap guard for a trap this file has hit three times: the whole client is
  // emitted INSIDE a template literal, so one unescaped backtick — in a
  // COMMENT is the usual way — terminates the literal and turns the rest of
  // the script into code evaluated at emit time. The symptom is a
  // ReferenceError from perchHubJs() itself, nowhere near the typo.
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);          // throws on its own if the literal broke
    assert.doesNotThrow(() => new Function(js), lang + " must emit parseable JS");
  }
});

// ---------------------------------------------------------------------------
// Fix round 1 Q1 — the select must report the model the session is ON.
// ---------------------------------------------------------------------------

const THREE_MODELS = [
  { provider: "crow-local", id: "qwen", name: "Qwen", availability: "up" },
  { provider: "raven-flash", id: "flash-next", name: "Flash Next", availability: "on_demand" },
  { provider: "crow-dsv4", id: "deepseek-v4", name: "DeepSeek V4", availability: "unavailable" },
];
const optionsWith = (current) => stdFetch({
  "/options": () => makeResponse(200, { models: THREE_MODELS, thinkingLevels: ["off", "high"], current }),
});

test("the drawer's model select reads the session's model, not whichever option sorts first", async () => {
  // The measured bug: nothing ever assigned modelSel.value, so the picker
  // asserted crow-local/qwen — the first entry — for a session running
  // flash-next, on the one control this feature exists for.
  const hub = await mountHub({ fetchImpl: optionsWith("raven-flash/flash-next") });
  await openChatSession(hub);
  assert.equal(hub.els["perch-model"].value, "raven-flash/flash-next");
  assert.notEqual(hub.els["perch-model"].value, hub.els["perch-model"].children[0].value,
    "fixture check: the live model is deliberately NOT option 0, or this proves nothing");
});

test("a state frame moves the select — pi's own /model and auto-fallbacks were on the wire all along", async () => {
  const hub = await mountHub({ fetchImpl: optionsWith("crow-local/qwen") });
  await openChatSession(hub);
  assert.equal(hub.els["perch-model"].value, "crow-local/qwen");
  FakeEventSource.instances[0]._serverFrame("state",
    { state: "awake", turnInFlight: false, model: "crow-dsv4/deepseek-v4" });
  assert.equal(hub.els["perch-model"].value, "crow-dsv4/deepseek-v4");
});

test("a model the list does not carry is added and selected, not silently dropped", async () => {
  // A provider row removed since the session started, or a model pi resolved
  // on its own. Leaving the select on nothing would report the same "don't
  // know" the empty dropdown did.
  const hub = await mountHub({ fetchImpl: optionsWith("retired-provider/old-model") });
  await openChatSession(hub);
  const sel = hub.els["perch-model"];
  assert.equal(sel.value, "retired-provider/old-model");
  assert.equal(sel.children[0].value, "retired-provider/old-model", "prepended, so it reads first");
  assert.equal(sel.children[0].textContent, "retired-provider/old-model — current");
  assert.equal(sel.children.length, 4, "and the catalogue is still all there");
});

test("a disabled model select is never given a value — there is no list to be right about", async () => {
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/options": () => makeResponse(200, { models: [], thinkingLevels: [], current: "crow-local/qwen" }) }),
  });
  await openChatSession(hub);
  assert.equal(hub.els["perch-model"].disabled, true);
  assert.equal(hub.els["perch-model"].children.length, 0,
    "an unlisted-current option must not resurrect a picker with no catalogue behind it");
});

// ---------------------------------------------------------------------------
// Fix round 1 Q2 — a bot with no configured default
// ---------------------------------------------------------------------------

const modelsFetch = (dflt) => roostFetch(ROOST_ALL_BUSY, {
  "/models": () => makeResponse(200, { models: LAUNCH_MODELS, default: dflt }),
});

test("a bot with NO configured default offers 'the bot's own model', preselected", async () => {
  // Measured: 3 of 5 R4 bot defs carry models:null. Without this option nothing
  // was preselected, the browser picked option 0, and tapping New session fired
  // a REAL control() switch onto whatever sorted first in provider order.
  const hub = await mountHub({ fetchImpl: modelsFetch(null) });
  const sel = hub.els["perch-new-model"];
  assert.equal(sel.children[0].value, "");
  assert.equal(sel.children[0].textContent, "The bot's own model");
  assert.equal(sel.value, "", "preselected, so one tap means what it always meant");
});

test("launching on 'the bot's own model' sends NO control at all", async () => {
  const hub = await mountHub({ fetchImpl: modelsFetch(null) });
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const posts = hub.fetchCalls.filter((c) => c.method === "POST").map((c) => c.path);
  assert.deepEqual(posts, ["/bots/r4-assistant/interactive"],
    "letting the spawn resolve the model is the whole point of the option");
});

test("a default naming a model the catalogue no longer carries falls back the same way", async () => {
  // A def pointing at a provider row that has since been disabled.
  const hub = await mountHub({ fetchImpl: modelsFetch("retired-provider/gone") });
  const sel = hub.els["perch-new-model"];
  assert.equal(sel.value, "", "no silent switch onto option 0");
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hub.fetchCalls.filter((c) => c.method === "POST").map((c) => c.path),
    ["/bots/r4-assistant/interactive"]);
});

test("a bot WITH a configured default gets no sentinel — it already has an answer", async () => {
  const hub = await mountHub({ fetchImpl: modelsFetch("raven-flash/flash-next") });
  const sel = hub.els["perch-new-model"];
  assert.equal(sel.children.filter((o) => o.value === "").length, 0);
  assert.equal(sel.value, "raven-flash/flash-next");
});

test("the sentinel is still an explicit choice: picking a real model from it switches", async () => {
  const hub = await mountHub({ fetchImpl: modelsFetch(null) });
  hub.els["perch-new-model"].value = "crow-dsv4/deepseek-v4";
  hub.els["perch-new"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const control = hub.fetchCalls.filter((c) => c.path.includes("/control"));
  assert.equal(control.length, 1, "an operator who DID choose still gets their choice");
  assert.deepEqual(JSON.parse(control[0].opts.body), { model: { provider: "crow-dsv4", id: "deepseek-v4" } });
});

// ---------------------------------------------------------------------------
// Fix round 1 Q8 — the pre-2019 MediaQueryList spelling
// ---------------------------------------------------------------------------

test("the breakpoint listener binds through addListener where that is the only spelling", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch(), split: false, legacyMediaQuery: true });
  await openChatSession(hub);
  assert.equal(hub.timers.size, 0, "precondition: narrow, chat open, list hidden, nothing polling");
  hub.mq._set(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(hub.timers.size > 0,
    "on that browser the re-evaluation would otherwise silently never bind");
});

// ---------------------------------------------------------------------------
// TASK-3 item 1 — every turn's output was rendered TWICE.
//
// The engine streams message-level (perch-interactive.js:1257, "delta-level is
// a recorded non-goal"), so `text` fires once per completed assistant message.
// At turn end `reply` carries replyTextOf(end) — every assistant message of
// that turn CONCATENATED. A two-message turn therefore rendered three entries:
// each message, then both again as one block.
//
// COUNT assertions throughout: a contains-assertion passes through a duplicate
// happily, which is how this survived.
// ---------------------------------------------------------------------------

/** Bot entries currently in the transcript, in order. */
function botEntries(hub) {
  return hub.els["perch-transcript"].children
    .filter((c) => String(c.className).includes("entry") && String(c.className).includes("bot"))
    .map((c) => (c.children.find((k) => String(k.className).includes("what")) || {}).textContent);
}

/** Drive one turn on the open session's stream. */
function runTurn(hub, texts, replyText) {
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  for (const t of texts) es._serverFrame("text", { text: t });
  if (replyText !== null) es._serverFrame("reply", { text: replyText });
  return es;
}

test("a several-message turn renders one entry per message, not per message plus the join", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  runTurn(hub, ["Let me check.", "There are four boards."], "Let me check.There are four boards.");
  assert.deepEqual(botEntries(hub), ["Let me check.", "There are four boards."],
    "the concatenated reply must not be appended on top of the messages it is made of");
});

test("a one-message turn renders exactly one entry", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  runTurn(hub, ["Just the one."], "Just the one.");
  assert.deepEqual(botEntries(hub), ["Just the one."]);
});

test("a ZERO-message turn still renders its reply — that text arrived by no other path", async () => {
  // The decisive case, and it is reachable for a real operator: the stream
  // carries NO backlog, so anyone who opens the drawer mid-turn sees no `text`
  // frames for the messages already streamed. `reply` is then the only source
  // of that turn's answer, and it is the more authoritative one anyway
  // (replyTextOf reads the agent_end the engine was handed, never the child's
  // accumulating log, which trimLog() empties).
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  runTurn(hub, [], "The whole answer, and the only copy of it.");
  assert.deepEqual(botEntries(hub), ["The whole answer, and the only copy of it."]);
});

test("an ABORTED turn renders nothing extra and still leaves the composer usable", async () => {
  // An aborted turn emits no reply at all (perch-interactive.js:1418 — the
  // invariant is stated over the turn, so an abort landing during the metering
  // awaits still silences it). The flag is cleared by the state frame, which is
  // why dropping the append from `reply` could never have stranded it.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("text", { text: "half an answer" });
  es._serverFrame("state", { state: "awake", turnInFlight: false });   // the abort's own state event
  assert.deepEqual(botEntries(hub), ["half an answer"]);
  assert.equal(hub.els["perch-send"].textContent, "Send", "back to Send, not stuck on Steer");
});

test("two turns in a row: the second turn's reply is judged on ITS OWN turn", async () => {
  // The per-turn flag has to reset when a turn STARTS, or turn 2's
  // reply-only answer would be swallowed by turn 1 having rendered.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  runTurn(hub, ["turn one streamed"], "turn one streamed");
  runTurn(hub, [], "turn two arrived only as a reply");
  assert.deepEqual(botEntries(hub), ["turn one streamed", "turn two arrived only as a reply"]);
});

test("a mid-turn state frame does not reset the per-turn flag and re-admit the duplicate", async () => {
  // stateEvent() is emitted for model_select, ask_user, aborts — several can
  // land between the first `text` and the `reply`, all carrying
  // turnInFlight:true. Resetting on every true frame instead of on the
  // false->true transition would put the duplicate straight back.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("text", { text: "the answer" });
  es._serverFrame("state", { state: "awake", turnInFlight: true, model: "crow-local/qwen" });
  es._serverFrame("reply", { text: "the answer" });
  assert.deepEqual(botEntries(hub), ["the answer"]);
});

test("an empty reply on a turn that rendered nothing appends no empty entry", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  runTurn(hub, [], "");
  assert.deepEqual(botEntries(hub), []);
  assert.equal(hub.els["perch-send"].textContent, "Send", "and the flag is still cleared");
});

// ---------------------------------------------------------------------------
// TASK-3 item 2 — bot markdown is rendered, from server-sanitized HTML.
// ---------------------------------------------------------------------------

/** The .what node of the last bot entry. */
function lastWhat(hub) {
  const entries = hub.els["perch-transcript"].children.filter((c) => String(c.className).includes("entry"));
  const row = entries[entries.length - 1];
  return row && row.children.find((k) => String(k.className).includes("what"));
}

test("a bot message with server-rendered html takes the sanitized-HTML path", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  FakeEventSource.instances[0]._serverFrame("state", { state: "awake", turnInFlight: true });
  FakeEventSource.instances[0]._serverFrame("text",
    { text: "## Boards\n\nThere are **four**.", html: "<h2>Boards</h2><p>There are <strong>four</strong>.</p>" });
  const what = lastWhat(hub);
  assert.equal(what.className, "what md", "a distinct class, so the stylesheet can undo pre-wrap for real blocks");
  assert.equal(what.innerHTML, "<h2>Boards</h2><p>There are <strong>four</strong>.</p>");
  assert.equal(what.textContent, "", "the raw markdown must not ALSO be written as text");
});

test("a message with no html falls back to textContent — byte-for-byte the old behaviour", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  FakeEventSource.instances[0]._serverFrame("state", { state: "awake", turnInFlight: true });
  // What a failed render, an older gateway, or a non-prose frame all produce.
  FakeEventSource.instances[0]._serverFrame("text", { text: "## not rendered" });
  const what = lastWhat(hub);
  assert.equal(what.className, "what");
  assert.equal(what.textContent, "## not rendered");
  assert.equal(what.innerHTML, "", "nothing may reach the sink without server-rendered html");
});

test("the operator's own message is never routed through the HTML sink", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  hub.els["perch-input"].value = "**not mine to render**";
  hub.els["perch-send"].onclick();
  await new Promise((r) => setTimeout(r, 0));
  const what = lastWhat(hub);
  assert.equal(what.className, "what");
  assert.equal(what.textContent, "**not mine to render**");
});

test("history renders each message's own html, and still one entry per message", async () => {
  const events = [
    { type: "message", message: { role: "user", content: "how many boards?" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "**four**" }] },
      html: "<p><strong>four</strong></p>" },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "board_list_boards" }] } },
  ];
  const hub = await mountHub({ fetchImpl: stdFetch({ "/transcript": () => makeResponse(200, { events }) }) });
  await openChatSession(hub);
  const rows = hub.els["perch-transcript"].children.filter((c) => String(c.className).includes("entry"));
  assert.equal(rows.length, 3, "one entry per message, unchanged by rendering");
  const whats = rows.map((r) => r.children.find((k) => String(k.className).includes("what")));
  assert.equal(whats[0].className, "what", "the user's line stays plain");
  assert.equal(whats[1].className, "what md");
  assert.equal(whats[1].innerHTML, "<p><strong>four</strong></p>");
  assert.equal(whats[2].className, "what", "a tool-call message keeps the [tool: name] line");
  assert.equal(whats[2].textContent, "[tool: board_list_boards]");
});

test("rendering does not re-open the duplicate: a turn with html still renders once", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("text", { text: "**one**", html: "<p><strong>one</strong></p>" });
  es._serverFrame("text", { text: "**two**", html: "<p><strong>two</strong></p>" });
  es._serverFrame("reply", { text: "**one****two**", html: "<p><strong>one</strong><strong>two</strong></p>" });
  const rows = hub.els["perch-transcript"].children.filter((c) => String(c.className).includes("entry bot"));
  assert.equal(rows.length, 2, "the concatenated reply is still suppressed when the messages rendered");
});

// ---------------------------------------------------------------------------
// Fix round 2 N1 — a reconnect across a turn boundary silently ate the answer.
//
// The suppression flag was client state that survived a stream teardown and
// reset only on a turnInFlight false->true transition. A reconnect that never
// saw the separating false frame therefore carried a stale "already rendered"
// across into the NEXT turn and dropped its reply. The engine's
// replay-on-subscribe does not close it: the replayed frame is true and the
// client is already true, so there is no transition.
//
// The frames now carry the turn they belong to, so `reply` judges its own turn.
// BOTH reconnect shapes are driven below, with entry COUNTS.
// ---------------------------------------------------------------------------

/** Drop the live stream the way a blip does, and let the backoff timer
 *  re-open it — the real path (onStreamError -> options probe ->
 *  scheduleReconnect -> openStream), not a reach into the closure. */
async function reconnect(hub) {
  const before = FakeEventSource.instances.length;
  FakeEventSource.instances[before - 1]._nativeError();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  for (const fn of hub.timers.values()) fn();          // the 2s backoff, fired
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(FakeEventSource.instances.length > before, "the reconnect must actually open a new stream");
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

test("N1 CROSS-turn reconnect: the next turn's reply still renders", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es1 = FakeEventSource.instances[0];
  es1._serverFrame("state", { state: "awake", turnInFlight: true });
  es1._serverFrame("text", { text: "turn 1 streamed half", turnId: "turn-1" });
  assert.deepEqual(botEntries(hub), ["turn 1 streamed half"]);

  // The blip: turn 1 ends and turn 2 runs inside it, so the client never sees
  // the turnInFlight:false that separates them.
  const es2 = await reconnect(hub);
  es2._serverFrame("state", { state: "awake", turnInFlight: true });   // the engine's replay
  es2._serverFrame("reply", { text: "turn 2's whole answer", turnId: "turn-2" });

  assert.deepEqual(botEntries(hub), ["turn 1 streamed half", "turn 2's whole answer"],
    "measured before the fix: turn 2 never rendered at all");
});

test("N1 SAME-turn reconnect: the reply is still suppressed, no duplicate", async () => {
  // The case a bare reset in openStream() would have broken — which is why
  // this is a turn id and not a reset.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es1 = FakeEventSource.instances[0];
  es1._serverFrame("state", { state: "awake", turnInFlight: true });
  es1._serverFrame("text", { text: "the answer", turnId: "turn-1" });

  const es2 = await reconnect(hub);
  es2._serverFrame("state", { state: "awake", turnInFlight: true });
  es2._serverFrame("reply", { text: "the answer", turnId: "turn-1" });   // the SAME turn ends

  assert.deepEqual(botEntries(hub), ["the answer"], "one entry, not two");
});

test("N1: a reply for a turn whose text was never seen renders, reconnect or not", async () => {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("text", { text: "turn 1", turnId: "turn-1" });
  es._serverFrame("state", { state: "awake", turnInFlight: false });
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("reply", { text: "turn 2, reply only", turnId: "turn-2" });
  assert.deepEqual(botEntries(hub), ["turn 1", "turn 2, reply only"]);
});

test("N1 fallback: frames with no turn id still use the transition flag", async () => {
  // A gateway older than this script, or the child speaking outside a turn.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("text", { text: "streamed" });                       // no turnId
  es._serverFrame("reply", { text: "streamed" });                      // no turnId
  assert.deepEqual(botEntries(hub), ["streamed"], "the old mechanism still suppresses the join");
});

test("N1 sibling: an unparseable text frame appends nothing and suppresses nothing", async () => {
  // on()'s JSON.parse failure hands the listener d={}. That used to append an
  // empty .entry.bot AND mark the turn rendered, so the real reply was dropped
  // too — one malformed frame cost the whole answer.
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[0];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._t._dispatch("text", { data: "{ this is not json" });             // the real failure shape
  assert.deepEqual(botEntries(hub), [], "no empty entry");
  es._serverFrame("reply", { text: "the real answer", turnId: "turn-1" });
  assert.deepEqual(botEntries(hub), ["the real answer"]);
});
