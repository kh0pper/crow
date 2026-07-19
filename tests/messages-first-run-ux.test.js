/**
 * Messages panel first-run UX — BEHAVIOR, executed (C1/C3 Task 6).
 *
 * Three independent additions on top of the existing AI chat flow:
 *   1. `provider_warming` SSE event narrates the "thinking" pill with the
 *      server's translated message (native providers); falls back to
 *      messages.thinking when the event carries no message (Docker/cloud).
 *   2. `?ai=<id>` deep-link opens the AI conversation and focuses the
 *      composer, mirroring the existing `?open=<id>` (peer) / `?openRoom=<id>`
 *      hooks (client.js:146-206).
 *   3. Suggested-prompt chips render only on an AI conversation with zero
 *      messages, and go through the SAME send path as the Send button
 *      (sendCurrentMessage → sendAiMessage), never form.submit().
 *
 * A source-text regex cannot prove any of these — the pill's actual DOM
 * text after an event, whether a chip click really posts through the real
 * send path, and whether chips disappear once a message is sent all
 * require the real client running against real DOM. So this file RUNS the
 * real client (messagesClientJS) against real server-rendered markup
 * (buildMessagesHTML) via linkedom + node:vm — mirrors
 * tests/model-catalog-client-contract.test.js's established pattern for
 * this exact class of panel (PR #235).
 *
 * client.js declares its handlers (msgSelectItem, sendAiMessage, ...) as
 * top-level `function` statements inside the served <script> — no IIFE
 * wrapper. vm.createContext's sandbox object IS the script's global object,
 * so after vm.runInContext those functions are directly callable as
 * ctx.msgSelectItem(...) etc. This matters because html.js's avatar items
 * use inline onclick="" attributes, and linkedom does not evaluate HTML
 * attribute-string event handlers (no eval of markup) — clicking them is a
 * no-op in this harness, so this file drives navigation via the exposed
 * top-level functions instead, and reserves DOM click() for elements the
 * client wires with real addEventListener (the el() helper), which is the
 * send button / chips / composer under test here anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";
import { messagesClientJS } from "../servers/gateway/dashboard/panels/messages/client.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const CLIENT_HTML = messagesClientJS({ aiConfigured: true, storageAvailable: false, lang: "en" });
/** The top-level script the browser would execute, lifted out of the emitted <script>. */
const CLIENT_JS = CLIENT_HTML.slice(
  CLIENT_HTML.indexOf("<script>") + "<script>".length,
  CLIENT_HTML.lastIndexOf("</script>"),
);

function baseHtmlOpts(overrides = {}) {
  return {
    items: [{ type: "ai", id: 7, displayName: "Chat Buddy" }],
    totalUnread: 0,
    aiConfigured: true,
    storageAvailable: false,
    inviteResult: null,
    inviteError: null,
    lang: "en",
    botInvite: null,
    botDirectory: { groups: [], total: 0, notAddedCount: 0 },
    requests: [],
    csrf: "",
    inviteShare: null,
    personInvite: null,
    shortCodeShare: null,
    ...overrides,
  };
}

/**
 * Render the page, build a DOM, and execute the real client against it.
 *
 * @param {object} opts
 * @param {Function} [opts.fetchImpl] (url, init) => {ok, status, json()/body} —
 *   a stub response shape; omit for a blanket harmless 200 {}.
 * @param {string} [opts.search] window.location.search, e.g. "?ai=7"
 * @param {object} [opts.htmlOpts] overrides for buildMessagesHTML
 */
/**
 * linkedom quirk (verified empirically, not documented): an unqualified
 * `window.foo = x` assignment inside vm-executed code does NOT stay scoped
 * to that window instance — it mirrors onto the real process `globalThis`,
 * and a FRESH window from a later parseHTML() call reads it right back
 * (its HTMLElement/Window classes are singletons shared across every
 * parseHTML() call in the process, not per-call). client.js relies on
 * exactly this pattern for its once-per-window guards
 * (window.__msgOpenHookBound, window.__msgOutsideClickBound,
 * window.__crowMsgStream, window.__msgPollInterval) so Turbo re-entries
 * don't double-bind listeners — but that means those flags leak ACROSS
 * TESTS in this same process and a later test's __msgOpenHookBound block
 * silently no-ops. Clearing them from the real globalThis before every
 * boot() is what keeps each test's "fresh page load" honest.
 */
const LEAKED_ONCE_GUARDS = ["__msgOpenHookBound", "__msgOutsideClickBound", "__crowMsgStream", "__msgPollInterval"];

function boot({ fetchImpl, search = "", htmlOpts } = {}) {
  for (const key of LEAKED_ONCE_GUARDS) delete globalThis[key];

  const html = buildMessagesHTML(baseHtmlOpts(htmlOpts));

  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);

  // messages/client.js reads window.location.search (the ?ai=/?open= deep
  // link hooks) and window.location.href — linkedom has no Location object
  // by default, so a minimal stand-in is required for the top-level
  // __msgOpenHookBound block to run at all, in every test (not just the
  // deep-link ones).
  window.location = {
    search,
    href: "https://crow.test/dashboard/messages" + search,
    pathname: "/dashboard/messages",
    reload() {},
  };

  // HTMLElement is also one of the shared singleton classes (see note
  // above), so this is reassigned fresh per boot() rather than chained
  // onto whatever a previous test's boot() left behind.
  let focusCalls = 0;
  window.HTMLElement.prototype.focus = function () {
    focusCalls++;
  };

  const calls = []; // every fetch the client made: {url, init, body}
  const timers = []; // setTimeout is queued, never real: tests flush it

  const fetchStub = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const result = fetchImpl
      ? fetchImpl(String(url), init)
      : { ok: true, status: 200, json: () => Promise.resolve({}) };
    return Promise.resolve(result);
  };

  const ctx = vm.createContext({
    window,
    document,
    location: window.location,
    fetch: fetchStub,
    console,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams,
    TextDecoder,
  });
  vm.runInContext(CLIENT_JS, ctx);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  /** Drain the promise microtask queue (the fetch stub resolves immediately). */
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  /** Run whatever setTimeout callbacks are currently queued (fireOpen's retry loop). */
  const flushTimers = () => {
    const q = timers.splice(0);
    q.forEach((fn) => fn());
  };

  return { window, document, ctx, $, $$, click, settle, flushTimers, calls, focusCalls: () => focusCalls };
}

/** Build one SSE "event: X\ndata: {...}\n\n" chunk. */
function sseChunk(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A manually-driven reader stand-in for response.body.getReader(): push()/end()
 * control exactly when reader.read() resolves, so a test can inspect DOM
 * state BETWEEN SSE events without racing real timers or guessing microtask
 * counts.
 */
function makeManualReader() {
  const queue = [];
  const waiting = [];
  const encoder = new TextEncoder();
  return {
    pushText(text) {
      const value = encoder.encode(text);
      if (waiting.length) waiting.shift()({ done: false, value });
      else queue.push({ done: false, value });
    },
    end() {
      if (waiting.length) waiting.shift()({ done: true, value: undefined });
      else queue.push({ done: true, value: undefined });
    },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/** Open AI conversation 7 by driving the real top-level msgSelectItem the
 * way html.js's onclick="" would (that attribute isn't evaluated in
 * linkedom, see file header). The response body is controlled entirely by
 * the caller's fetchImpl. */
async function openAiConversation({ ctx, settle }) {
  ctx.msgSelectItem("ai", 7);
  await settle();
}

// ─── 1. provider_warming SSE handler (client.js ~582-655 if-chain) ───

test("BEHAVIOR: a provider_warming event WITH a message narrates the thinking pill with that exact text", async () => {
  const manual = makeManualReader();
  const fetchImpl = (url) => {
    if (url.endsWith("/api/chat/conversations/7")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ conversation: { id: 7, title: "Chat" }, messages: [] }) };
    }
    if (url.endsWith("/api/chat/conversations/7/messages")) {
      return { ok: true, status: 200, body: { getReader: () => manual } };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const harness = boot({ fetchImpl });
  const { ctx, document, click, settle } = harness;

  await openAiConversation(harness);
  const textarea = document.getElementById("msg-input");
  assert.ok(textarea, "composer rendered after opening the ai conversation");
  textarea.value = "hi";

  click(document.getElementById("msg-send-btn"));
  await settle();

  manual.pushText(sseChunk("provider_warming", { provider_id: "llama-cpp", message: "Loading Llama 3.1 8B (first run — this can take a few minutes)..." }));
  await settle();

  const typing = document.querySelector(".msg-typing");
  assert.ok(typing, "the thinking pill is present while warming");
  assert.match(
    typing.textContent,
    /^Loading Llama 3\.1 8B \(first run — this can take a few minutes\)\.\.\. /,
    "pill text was replaced with the server's translated message, not left on the generic default",
  );
  assert.ok(typing.querySelector(".msg-cancel-btn"), "the Cancel control survives the text swap");

  manual.pushText(sseChunk("done", {}));
  manual.end();
  await settle();
  assert.equal(document.querySelector(".msg-typing"), null, "pill is removed once the stream completes");
});

test("BEHAVIOR: a provider_warming event with NO message (Docker/cloud path) falls back to messages.thinking, distinguishably from whatever text preceded it", async () => {
  const manual = makeManualReader();
  const fetchImpl = (url) => {
    if (url.endsWith("/api/chat/conversations/7")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ conversation: { id: 7, title: "Chat" }, messages: [] }) };
    }
    if (url.endsWith("/api/chat/conversations/7/messages")) {
      return { ok: true, status: 200, body: { getReader: () => manual } };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const harness = boot({ fetchImpl });
  const { ctx, document, click, settle } = harness;

  await openAiConversation(harness);
  document.getElementById("msg-input").value = "hi";
  click(document.getElementById("msg-send-btn"));
  await settle();

  // Prove the branch actually ran (rather than the pill just never having
  // changed) by first flipping the pill to a DIFFERENT known text via the
  // existing tool_call_start branch, then sending a message-less
  // provider_warming and checking it reverts to the thinking translation.
  manual.pushText(sseChunk("tool_call_start", { name: "crow_search_memories" }));
  await settle();
  assert.match(document.querySelector(".msg-typing").textContent, /^Using crow_search_memories\.\.\. /);

  manual.pushText(sseChunk("provider_warming", { provider_id: "docker-provider" }));
  await settle();

  const typing = document.querySelector(".msg-typing");
  const thinkingRe = new RegExp("^" + t("messages.thinking", "en").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " ");
  assert.match(typing.textContent, thinkingRe, "no message field falls back to the translated messages.thinking text");

  manual.pushText(sseChunk("done", {}));
  manual.end();
  await settle();
});

// ─── 2. ?ai=<id> deep-link (client.js __msgOpenHookBound block) ───

test("BEHAVIOR: ?ai=<id> opens that AI conversation and focuses the composer, mirroring ?open=<id>", async () => {
  const fetchImpl = (url) => {
    if (url.endsWith("/api/chat/conversations/7")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ conversation: { id: 7, title: "Chat" }, messages: [] }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const { document, settle, flushTimers, focusCalls } = boot({ fetchImpl, search: "?ai=7" });

  // fireOpen's retry loop: tick #1 fires attempt() synchronously (kicks off
  // the async loadAiConversation fetch), then queues a 100ms isDone check.
  flushTimers();
  await settle();
  // The isDone check: by now the fetch has resolved and rendered — this
  // tick both confirms and (per the brief) focuses the composer.
  flushTimers();
  await settle();

  const viewport = document.getElementById("msg-viewport");
  assert.ok(viewport, "the ai conversation viewport rendered from the ?ai= deep link, with no click on the avatar strip");
  assert.equal(focusCalls(), 1, "the composer was focused exactly once after the conversation opened");
});

test("BEHAVIOR: a non-numeric ?ai= is ignored (mirrors the existing ?open= guard)", async () => {
  const { document, settle, flushTimers } = boot({ search: "?ai=not-a-number" });
  flushTimers();
  await settle();
  flushTimers();
  await settle();
  assert.equal(document.getElementById("msg-viewport"), null, "no conversation opened for a non-numeric ai id");
});

// ─── 3. Suggested-prompt chips on empty AI conversations ───

test("BEHAVIOR: an AI conversation with zero messages renders exactly 3 suggestion chips with the real i18n copy", async () => {
  const fetchImpl = (url) => {
    if (url.endsWith("/api/chat/conversations/7")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ conversation: { id: 7, title: "Chat" }, messages: [] }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const harness = boot({ fetchImpl });
  await openAiConversation(harness);

  const chips = harness.$$(".msg-suggest-chip");
  assert.equal(chips.length, 3, "exactly three suggestion chips render on a zero-message ai conversation");
  const texts = chips.map((c) => c.textContent);
  assert.deepEqual(texts, [
    t("messages.suggest1", "en"),
    t("messages.suggest2", "en"),
    t("messages.suggest3", "en"),
  ]);
});

test("BEHAVIOR: an AI conversation with existing messages renders NO suggestion chips", async () => {
  const fetchImpl = (url) => {
    if (url.endsWith("/api/chat/conversations/7")) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          conversation: { id: 7, title: "Chat" },
          messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there" }],
        }),
      };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const harness = boot({ fetchImpl });
  await openAiConversation(harness);

  assert.equal(harness.$$(".msg-suggest-chip").length, 0, "a conversation that already has messages never shows suggestion chips");
});

test("BEHAVIOR: clicking a chip sends it through the REAL send path (sendCurrentMessage → sendAiMessage POST), not form.submit(), and the chips disappear", async () => {
  const manual = makeManualReader();
  const fetchImpl = (url) => {
    if (url.endsWith("/api/chat/conversations/7")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ conversation: { id: 7, title: "Chat" }, messages: [] }) };
    }
    if (url.endsWith("/api/chat/conversations/7/messages")) {
      return { ok: true, status: 200, body: { getReader: () => manual } };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const harness = boot({ fetchImpl });
  const { document, click, settle, calls } = harness;
  await openAiConversation(harness);

  const firstChip = harness.$$(".msg-suggest-chip")[0];
  assert.ok(firstChip, "first chip present");
  const chipText = firstChip.textContent;
  assert.equal(chipText, t("messages.suggest1", "en"));

  click(firstChip);
  await settle();

  const sendCalls = calls.filter((c) => c.url.endsWith("/api/chat/conversations/7/messages"));
  assert.equal(sendCalls.length, 1, "clicking the chip posted exactly one message through the real send endpoint");
  assert.equal(sendCalls[0].body.content, chipText, "the posted content is exactly the chip's text");
  assert.equal(sendCalls[0].init.method, "POST");

  assert.equal(harness.$$(".msg-suggest-chip").length, 0, "chips are removed once the first message sends");
  assert.ok(document.querySelector(".msg-bubble.sent, .msg-bubble"), "the user's bubble rendered in the viewport");

  manual.pushText(sseChunk("done", {}));
  manual.end();
  await settle();
});
