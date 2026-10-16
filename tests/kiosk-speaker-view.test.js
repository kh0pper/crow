/**
 * The kiosk's speaker chip (public/speaker-view.js): a pure view over the agent link, driven here with
 * linkedom, the real en/es strings and a fake clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { createSpeakerView, sanitizeName, UNAVAILABLE_AFTER_MS } from "../bundles/kiosk/public/speaker-view.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

function timers() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; q.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { q.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}

function setup({ lang = "en", answer } = {}) {
  const { document, window } = parseHTML("<html><body><header><div id=speaker hidden></div></header></body></html>");
  const root = document.getElementById("speaker");
  const clock = timers();
  const taps = [];
  let resolveTap = null;
  const link = {
    btReconnect: () => { taps.push(1); return answer ? Promise.resolve(answer()) : new Promise((r) => { resolveTap = r; }); },
  };
  const t = (k) => STRINGS[lang][k] || "";
  const view = createSpeakerView(root, { doc: document, t, link, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const btn = () => root.querySelector("button");
  const line = () => root.querySelector(".k-spk-line").textContent;
  const label = () => root.querySelector(".k-spk-label").textContent;
  const tap = async () => { btn().dispatchEvent(new window.Event("click")); await new Promise((r) => setImmediate(r)); };
  return { document, window, root, clock, view, taps, btn, line, label, tap, t, answer: (m) => resolveTap(m) };
}

const UP = { type: "agent", v: 1, wake: false };
const bt = (o) => ({ type: "bt_state", configured: true, connected: false, link: false, hw_fault: false, name: "Kitchen speaker", ...o });

test("the chip stays hidden until it is started (a page without ?agent=1 never starts it)", () => {
  const s = setup();
  assert.equal(s.root.hidden, true);
  s.clock.advance(UNAVAILABLE_AFTER_MS * 2);
  assert.equal(s.root.hidden, true, "no timer runs before start()");
});

test("started: a neutral 'Connecting…' for the first 20 s, then 'Speaker control unavailable'; a tap then says the helper is not running", async () => {
  const s = setup();
  s.view.start();
  assert.equal(s.root.hidden, false);
  assert.equal(s.label(), s.t("speaker_connecting"));
  s.clock.advance(UNAVAILABLE_AFTER_MS - 1);
  assert.equal(s.label(), s.t("speaker_connecting"));
  s.clock.advance(1);
  assert.equal(UNAVAILABLE_AFTER_MS, 20000);
  assert.equal(s.label(), "Speaker control unavailable");
  await s.tap();
  assert.equal(s.taps.length, 0, "no reconnect is asked of an agent that is not there");
  assert.equal(s.line(), s.t("speaker_result_agent_unavailable"));
});

test("configured:false hides the chip (no speaker set up on this display)", () => {
  const s = setup();
  s.view.start();
  s.view.status(UP);
  s.view.bt(bt({ configured: false, name: null }));
  assert.equal(s.root.hidden, true);
  s.clock.advance(UNAVAILABLE_AFTER_MS * 2);
  assert.equal(s.root.hidden, true, "the agent answered: the unavailable timer is gone");
});

test("connected: glyph + the speaker's name as TEXT (review D3 payload), no Reconnect button text and no reason line", () => {
  const s = setup();
  s.view.start(); s.view.status(UP);
  s.view.bt(bt({ connected: true, link: true, name: "<img src=x onerror=alert(1)>", reason: null }));
  assert.equal(s.root.hidden, false);
  assert.equal(s.root.querySelectorAll("img").length, 0, "markup arrives as text");
  assert.equal(s.label(), "<img src=x onerror=alert(1)>");
  assert.ok(s.root.querySelector(".k-spk-glyph"), "a speaker glyph");
  assert.ok(s.root.classList.contains("is-connected"));
  assert.equal(s.line(), "");
  s.view.bt(bt({ connected: true, link: true, name: null, reason: null }));
  assert.equal(s.label(), "Speaker", "a nameless speaker is just 'Speaker'");
});

test("name sanitizing: C0/C1 controls and bidi overrides are stripped, at most 64 code points, non-strings are null", () => {
  assert.equal(sanitizeName("Kit\u0000chen\u0007 ‮speaker⁦\u0085"), "Kitchen speaker");
  assert.equal(sanitizeName("‪‫‬‭‮⁦⁧⁨⁩"), null);
  assert.equal(Array.from(sanitizeName("🔊".repeat(80))).length, 64, "code points, not UTF-16 units");
  for (const v of [null, undefined, 5, {}, ["x"]]) assert.equal(sanitizeName(v), null);
  assert.equal(sanitizeName("  "), null);
});

test("not connected: a 56 px 'Reconnect speaker' button with the agent's reason under it", () => {
  const s = setup();
  s.view.start(); s.view.status(UP);
  const cases = [
    [{ reason: "not_paired" }, "Not paired with this display — needs setup"],
    [{ reason: "adapter_blocked" }, "Bluetooth is off on this display"],
    [{ reason: "adapter_off" }, "Bluetooth is off on this display"],
    [{ reason: "no_adapter" }, STRINGS.en.speaker_reason_no_adapter],
    [{ reason: "no_answer" }, STRINGS.en.speaker_reason_no_answer],
    [{ reason: "off_or_out_of_range" }, "Speaker off or out of range"],
    [{ reason: "something_new" }, "Speaker off or out of range"],
    [{ reason: "hw_fault", hw_fault: true }, "Bluetooth needs a restart"],
    [{ reason: "no_sink", link: true }, "Connected but no sound output"],
    [{ hw_fault: true }, "Bluetooth needs a restart"],
    [{ link: true }, "Connected but no sound output"],
    [{}, "Speaker not connected — tap to reconnect"],
  ];
  for (const [o, want] of cases) {
    s.view.bt(bt(o));
    assert.equal(s.label(), "Reconnect speaker", JSON.stringify(o));
    assert.ok(s.btn().classList.contains("k-spk-btn"));
    assert.ok(!s.root.classList.contains("is-connected"));
    assert.equal(s.line(), want, JSON.stringify(o));
  }
});

test("Spanish strings are used when the page is in Spanish", () => {
  const s = setup({ lang: "es" });
  s.view.start(); s.view.status(UP);
  s.view.bt(bt({ reason: "not_paired" }));
  assert.equal(s.label(), STRINGS.es.speaker_reconnect);
  assert.equal(s.line(), STRINGS.es.speaker_reason_not_paired);
});

test("a tap asks the agent once, shows 'Reconnecting…', ignores taps while waiting, then shows the result", async () => {
  const s = setup();
  s.view.start(); s.view.status(UP);
  s.view.bt(bt({ reason: "off_or_out_of_range" }));
  await s.tap();
  assert.equal(s.taps.length, 1);
  assert.equal(s.line(), STRINGS.en.speaker_reconnecting);
  await s.tap();
  assert.equal(s.taps.length, 1, "one request at a time");
  s.answer(bt({ result: "failed", reason: "off_or_out_of_range" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.line(), STRINGS.en.speaker_result_failed);
  await s.tap();
  assert.equal(s.taps.length, 2, "the button works again after the answer");
});

test("every btReconnect result has its own status line", async () => {
  for (const r of ["ok", "failed", "busy", "rate_limited", "not_configured", "agent_unavailable", "timeout"]) {
    const s = setup({ answer: () => bt({ result: r }) });
    s.view.start(); s.view.status(UP); s.view.bt(bt({ reason: "off_or_out_of_range" }));
    await s.tap();
    const key = `speaker_result_${r}`;
    assert.ok(STRINGS.en[key], key);
    assert.equal(s.line(), STRINGS.en[key], r);
  }
  const s = setup({ answer: () => bt({ result: "not_paired" }) });
  s.view.start(); s.view.status(UP); s.view.bt(bt({}));
  await s.tap();
  assert.equal(s.line(), STRINGS.en.speaker_reason_not_paired, "not_paired reads like the reason");
});

test("a not_paired result sticks (even with an old agent that sends no reason) until the speaker's state changes", async () => {
  const s = setup({ answer: () => bt({ result: "not_paired" }) });
  s.view.start(); s.view.status(UP);
  s.view.bt(bt({}));
  await s.tap();
  assert.equal(s.line(), "Not paired with this display — needs setup");
  s.view.bt(bt({}));                 // a periodic repeat of the same state
  assert.equal(s.line(), "Not paired with this display — needs setup", "the same state keeps it");
  s.view.bt(bt({ connected: true, link: true, reason: null }));
  assert.equal(s.line(), "");
  s.view.bt(bt({}));
  assert.equal(s.line(), "Speaker not connected — tap to reconnect", "a changed state drops the sticky result");
});

test("the agent going away: back to 'Connecting…', and unavailable 20 s later unless it returns", () => {
  const s = setup();
  s.view.start(); s.view.status(UP);
  s.view.bt(bt({ connected: true, link: true, reason: null }));
  s.view.status(null);
  assert.equal(s.root.hidden, false);
  assert.equal(s.label(), STRINGS.en.speaker_connecting);
  s.clock.advance(UNAVAILABLE_AFTER_MS);
  assert.equal(s.label(), STRINGS.en.speaker_unavailable);
  s.view.status(UP);
  s.view.bt(bt({ reason: "off_or_out_of_range" }));
  assert.equal(s.label(), STRINGS.en.speaker_reconnect);
});

test("the view builds DOM with textContent only (no HTML parsing anywhere)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/kiosk/public/speaker-view.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("review: a failed tap on a display whose Bluetooth is off/blocked/missing/unanswering or faulted shows that cause, not 'is the speaker on?'", async () => {
  for (const [state, key] of [[{ reason: "adapter_off" }, "speaker_reason_adapter_off"], [{ reason: "adapter_blocked" }, "speaker_reason_adapter_off"], [{ reason: "no_adapter" }, "speaker_reason_no_adapter"], [{ reason: "no_answer" }, "speaker_reason_no_answer"], [{ reason: "hw_fault", hw_fault: true }, "speaker_reason_hw_fault"]]) {
    const s = setup();
    s.view.start(); s.view.status(UP); s.view.bt(bt(state));
    await s.tap();
    s.answer(bt({ ...state, result: "failed" }));
    await new Promise((r) => setImmediate(r));
    assert.equal(s.line(), STRINGS.en[key], JSON.stringify(state));
  }
  const old = setup();   // an old agent (no reason) keeps the tap's answer
  old.view.start(); old.view.status(UP); old.view.bt(bt({}));
  await old.tap();
  old.answer(bt({ result: "failed" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(old.line(), STRINGS.en.speaker_result_failed);
});

test("review: 'reconnected' clears after a few seconds while the speaker stays connected", async () => {
  const s = setup();
  s.view.start(); s.view.status(UP); s.view.bt(bt({ connected: true, reason: null }));
  await s.tap();
  s.answer(bt({ connected: true, reason: null, result: "ok" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.line(), STRINGS.en.speaker_result_ok);
  s.clock.advance(5000);
  assert.equal(s.line(), "");
});

test("review: zero-width and directional marks are stripped from the speaker's name too", () => {
  assert.equal(sanitizeName("Kit​chen‎  speaker﻿؜"), "Kitchen speaker");
});
