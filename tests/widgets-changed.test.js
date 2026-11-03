/**
 * Widgets phase 1, Task 3: the silent `widgets:changed` push.
 *
 *   - a burst of board changes opens ONE 5 s window and sends once, at the end;
 *   - two bursts 6 s apart send twice;
 *   - a failing sender is swallowed (sync throw and rejected promise) and does
 *     not wedge the module;
 *   - sendNtfySilent publishes with tag `crow-widgets`, priority 1, an EMPTY
 *     body and no X-Title/X-Click — a locked phone learns nothing but "refresh".
 *
 * Hermetic: the clock and the timer are injected (no sleeps), and sendNtfySilent
 * runs against a captured global fetch with an env-configured topic.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  notifyWidgetsChanged, _resetWidgetsChangedForTest,
  WIDGETS_CHANGED_DEBOUNCE_MS, WIDGETS_CHANGED_TAG,
} from "../servers/gateway/widgets/changed.js";
import { sendNtfySilent } from "../servers/gateway/push/ntfy.js";

/** A manual clock + timer queue: nothing sleeps, every window is exact. */
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      const handle = { fn, at: t + ms, fired: false, unref() {} };
      timers.push(handle);
      return handle;
    },
    /** Run every timer due at or before t+ms, in time order, then set the clock. */
    advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 1000; guard++) {
        const due = timers
          .filter((h) => !h.fired && h.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.fired = true;
        t = due.at;
        due.fn();
      }
      t = target;
    },
    pending: () => timers.filter((h) => !h.fired).length,
  };
}

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => { _resetWidgetsChangedForTest(); });

// ---- the debounce ---------------------------------------------------------

test("debounces a burst into one send", async () => {
  const clock = fakeClock();
  const sent = [];
  const send = async (opts) => { sent.push(opts); };

  // 20 calls over one second — a bot moving 20 cards.
  for (let i = 0; i < 20; i++) {
    const r = notifyWidgetsChanged({ send, now: clock.now, setTimer: clock.setTimer });
    if (i === 0) assert.deepEqual(r, { scheduled: true, at: WIDGETS_CHANGED_DEBOUNCE_MS });
    else assert.deepEqual(r, { scheduled: false }, "the window is already open");
    clock.advance(50);
  }
  assert.equal(sent.length, 0, "nothing is sent inside the window — the send is on the trailing edge");

  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(sent.length, 1, "one send for the whole burst");
  assert.deepEqual(sent[0], { tag: WIDGETS_CHANGED_TAG });
  assert.equal(clock.pending(), 0);
});

test("two bursts 6 s apart send twice", async () => {
  const clock = fakeClock();
  const sent = [];
  const send = async () => { sent.push(1); };
  const call = () => notifyWidgetsChanged({ send, now: clock.now, setTimer: clock.setTimer });

  call();
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(sent.length, 1);

  clock.advance(1000); // t = 6000, 6 s after the first burst opened
  assert.deepEqual(call(), { scheduled: true, at: 6000 + WIDGETS_CHANGED_DEBOUNCE_MS });
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(sent.length, 2, "the second burst gets its own window");
});

test("a failing send is swallowed", async () => {
  const clock = fakeClock();
  let attempts = 0;

  // Async rejection.
  notifyWidgetsChanged({
    send: async () => { attempts++; throw new Error("ntfy is down"); },
    now: clock.now, setTimer: clock.setTimer,
  });
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(attempts, 1);

  // Synchronous throw.
  notifyWidgetsChanged({
    send: () => { attempts++; throw new Error("boom"); },
    now: clock.now, setTimer: clock.setTimer,
  });
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(attempts, 2);

  // The module is not wedged: the next change still schedules a window.
  let ok = 0;
  assert.equal(notifyWidgetsChanged({ send: async () => { ok++; }, now: clock.now, setTimer: clock.setTimer }).scheduled, true);
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(ok, 1);
});

test("a reset invalidates an already scheduled window", async () => {
  const clock = fakeClock();
  let sent = 0;
  notifyWidgetsChanged({ send: async () => { sent++; }, now: clock.now, setTimer: clock.setTimer });
  _resetWidgetsChangedForTest(); // what every test does between cases
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(sent, 0, "a stale timer must not send — nor clobber a newer window");
  // …and a fresh call opens a fresh window.
  notifyWidgetsChanged({ send: async () => { sent++; }, now: clock.now, setTimer: clock.setTimer });
  clock.advance(WIDGETS_CHANGED_DEBOUNCE_MS);
  await settle();
  assert.equal(sent, 1);
});

// ---- the wire: no content at all -----------------------------------------

test("sendNtfySilent sends no title, body or click", async () => {
  const saved = {
    fetch: globalThis.fetch,
    NTFY_TOPIC: process.env.NTFY_TOPIC,
    NTFY_HOST: process.env.NTFY_HOST,
    NTFY_AUTH_TOKEN: process.env.NTFY_AUTH_TOKEN,
    CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  };
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return new Response(null, { status: 200 });
  };
  process.env.NTFY_TOPIC = "crow-widgets-test";
  process.env.NTFY_HOST = "127.0.0.1";
  process.env.NTFY_AUTH_TOKEN = "tk_test_publish";
  process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "widgets-silent-"));

  try {
    const result = await sendNtfySilent();
    assert.equal(captured.length, 1, "one publish");
    const { url, init } = captured[0];

    assert.equal(init.method, "POST");
    assert.match(url, /\/crow-widgets-test$/, "publishes to the instance topic");
    assert.equal(init.headers["X-Tags"], "crow-widgets");
    assert.equal(init.headers["X-Priority"], "1");
    assert.equal(init.headers["X-Title"], undefined, "no title");
    assert.equal(init.headers["X-Click"], undefined, "no click URL");
    assert.equal(init.headers.Authorization, "Bearer tk_test_publish", "the same publisher credential");
    assert.equal(init.body, "", "the body is empty, not a title fallback");
    assert.equal(String(init.body).length, 0);
    assert.deepEqual(result, { ok: true, status: 200 });
  } finally {
    globalThis.fetch = saved.fetch;
    for (const k of ["NTFY_TOPIC", "NTFY_HOST", "NTFY_AUTH_TOKEN", "CROW_DATA_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("sendNtfySilent skips silently when push is not configured", async () => {
  const saved = {
    fetch: globalThis.fetch,
    NTFY_TOPIC: process.env.NTFY_TOPIC,
    CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  };
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 200 }); };
  delete process.env.NTFY_TOPIC;
  process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "widgets-unconfigured-"));

  try {
    assert.deepEqual(await sendNtfySilent(), { ok: false, skipped: true });
    assert.equal(called, false, "no request when there is no topic");
  } finally {
    globalThis.fetch = saved.fetch;
    for (const k of ["NTFY_TOPIC", "CROW_DATA_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});