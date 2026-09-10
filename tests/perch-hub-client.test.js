// The client script is a string. These tests extract named functions from it
// with new Function(...) and exercise them against the real /roost payload
// shape, so the list logic is covered without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

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
  const guards = (js.match(/current\.sid\s*!==/g) || []).length;
  assert.ok(guards >= 6, "expected at least 6 identity guards, found " + guards);
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
