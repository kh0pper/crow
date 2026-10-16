import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLink, agentWanted, AGENT_URL } from "../bundles/kiosk/public/agent-link.js";

function harness() {
  const sockets = [], timers = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    open() { this.readyState = 1; this.onopen?.(); }
    recv(obj) { this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
  const clearTimer = (t) => { t.cleared = true; };
  const fire = () => { const t = timers.shift(); if (!t.cleared) t.fn(); return t.ms; };
  return { sockets, timers, FakeWS, setTimer, clearTimer, fire };
}

test("only a page launched with ?agent=1 opens the loopback socket", () => {
  assert.equal(agentWanted("?agent=1"), true);
  for (const s of ["", "?agent=0", "?x=1", "?agent=yes", undefined]) assert.equal(agentWanted(s), false, String(s));
  assert.equal(AGENT_URL, "ws://127.0.0.1:8770");
});

test("events from the agent reach the page callbacks; junk is ignored", () => {
  const h = harness(); const got = [];
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer,
    onWake: (m) => got.push(["wake", m.score]), onTouchWhileDark: () => got.push(["touch"]),
    onStatus: (s) => got.push(["status", s && s.wake]), onBtState: (b) => got.push(["bt", b.connected]) });
  link.start();
  const ws = h.sockets[0]; ws.open();
  assert.equal(link.connected, false, "connected only after the agent's status frame");
  ws.recv({ type: "agent", v: 1, wake: true, bt: { type: "bt_state", configured: true, connected: true } });
  assert.equal(link.connected, true);
  ws.recv({ type: "wake", score: 0.9 }); ws.recv({ type: "touch_while_dark" }); ws.recv({ type: "bt_state", configured: true, connected: false, name: "Kitchen speaker" });
  ws.recv("not json"); ws.recv({ type: "exec" }); ws.recv("null");
  assert.deepEqual(got, [["status", true], ["bt", true], ["wake", 0.9], ["touch"], ["bt", false]]);
  assert.equal(link.bt.name, "Kitchen speaker");
});

test("page state is sent while open and replayed after a reconnect, with backoff", () => {
  const h = harness();
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer });
  link.start();
  link.speaking(true);                      // not open yet: remembered, not sent
  h.sockets[0].open();
  assert.deepEqual(h.sockets[0].sent, [{ type: "speaking", on: true }]);
  link.display(false); link.media(true, 250); link.speaking(false);
  assert.deepEqual(h.sockets[0].sent.slice(1), [{ type: "display", on: false }, { type: "media", on: true, level: 100 }, { type: "speaking", on: false }]);
  h.sockets[0].drop();
  assert.equal(h.fire(), 1000);
  h.sockets[1].drop();
  assert.equal(h.fire(), 2000, "backoff doubles while the agent is away");
  h.sockets[2].open();
  assert.deepEqual(h.sockets[2].sent, [{ type: "display", on: false }, { type: "speaking", on: false }, { type: "media", on: true, level: 100 }]);
  h.sockets[2].drop();
  assert.equal(h.fire(), 1000, "a successful open resets the backoff");
});

test("the loopback backoff is capped at 5 s (the agent is on the same box; a restart takes seconds)", () => {
  const h = harness();
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer });
  link.start();
  const waits = [];
  for (let i = 0; i < 6; i++) { h.sockets.at(-1).drop(); waits.push(h.fire()); }
  assert.deepEqual(waits, [1000, 2000, 4000, 5000, 5000, 5000]);
});

test("close code 4000 (a newer page replaced this one) is final: no reconnect, so two pages never fight over the agent", () => {
  const h = harness(); const statuses = [];
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer, onStatus: (s) => statuses.push(s) });
  link.start(); const ws = h.sockets[0]; ws.open();
  ws.recv({ type: "agent", v: 1, wake: false, bt: { type: "bt_state", configured: true, connected: false } });
  ws.drop(4000);
  assert.equal(h.timers.length, 0, "no reconnect is scheduled");
  assert.equal(h.sockets.length, 1);
  assert.equal(statuses.at(-1), null, "the page is told the agent is gone");
  assert.equal(link.connected, false);
});

test("bt_state's reason reaches the page unchanged; an old agent without it is passed through as-is", () => {
  const h = harness(); const got = [];
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer, onBtState: (b) => got.push(b) });
  link.start(); const ws = h.sockets[0]; ws.open();
  ws.recv({ type: "agent", v: 1, wake: false, bt: { type: "bt_state", configured: true, connected: false, reason: "adapter_blocked" } });
  ws.recv({ type: "bt_state", configured: true, connected: false, reason: "not_paired" });
  ws.recv({ type: "bt_state", configured: true, connected: false });
  assert.deepEqual(got.map((b) => b.reason), ["adapter_blocked", "not_paired", undefined]);
  assert.equal(link.bt.reason, undefined);
});

test("stop() closes and does not reconnect; no WebSocket means a quiet no-op", () => {
  const h = harness();
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer });
  link.start(); h.sockets[0].open(); link.stop();
  assert.equal(h.timers.length, 0);
  const none = createAgentLink({ WebSocketImpl: undefined, setTimer: h.setTimer, clearTimer: h.clearTimer });
  none.start(); none.display(true);
  assert.equal(none.connected, false);
});

test("btReconnect: sends one bt_reconnect with a request id and resolves with the matching bt_state", async () => {
  const h = harness();
  const link = createAgentLink({ WebSocketImpl: h.FakeWS, setTimer: h.setTimer, clearTimer: h.clearTimer });
  assert.equal((await link.btReconnect()).result, "agent_unavailable", "no socket yet");
  link.start(); const ws = h.sockets[0]; ws.open();
  const p = link.btReconnect();
  const sent = ws.sent.at(-1);
  assert.deepEqual(Object.keys(sent).sort(), ["req", "type"], "no MAC or other argument");
  assert.equal(sent.type, "bt_reconnect");
  ws.recv({ type: "bt_state", connected: false, result: "rate_limited", req: "other" });
  ws.recv({ type: "bt_state", connected: true, result: "ok", req: sent.req });
  assert.equal((await p).result, "ok");
  const q = link.btReconnect();
  h.timers.filter((t) => t.ms === 30000).at(-1).fn();
  assert.equal((await q).result, "timeout");
  const r = link.btReconnect();
  ws.drop();
  assert.equal((await r).result, "agent_unavailable");
});
