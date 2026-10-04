/** The live-edit plugin's client loop (crow-live.js) in a fake editor frame with a virtual clock: poll cadence by
 * focus/visibility, how each server answer is handled, and the "Crow is editing…" indicator's minimum time on screen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SRC = readFileSync(join(import.meta.dirname, "..", "bundles", "workspace", "onlyoffice-plugin", "crow-live.js"), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

/** answer(path, opts) → {status, body}. Returns the harness: advance(ms), log of requests and indicator calls. */
function editor(answer, { focus = true, visibility = "visible", parentReadable = true } = {}) {
  let now = 1_000_000, nextId = 1; const timers = new Map();
  const state = { focus, visibility };
  const requests = [], methods = [], commands = [];
  const doc = { get visibilityState() { return state.visibility; }, addEventListener() {} };
  const ctx = {
    Date: { now: () => now }, Math, JSON, encodeURIComponent, Error,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: async (url, opts = {}) => {
      requests.push({ at: now, url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
      const r = await answer(url, opts);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    document: doc,
    Asc: {
      scope: {},
      plugin: {
        info: { jwt: "tok", documentId: "doc-key", isViewMode: false },
        executeMethod: (name, args) => methods.push({ at: now, name, args }),
        callCommand: (fn, close, recalc, cb) => { commands.push({ at: now }); Promise.resolve().then(() => cb({ ok: true })); },
      },
    },
    crowCommand: function () {},
  };
  ctx.window = ctx; ctx.top = ctx;
  ctx.parent = parentReadable ? { document: { hasFocus: () => state.focus }, addEventListener() {} } : ctx;
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end; await flush();
  };
  return { ctx, state, requests, methods, commands, advance, start: () => ctx.Asc.plugin.event_onDocumentContentReady(), polls: () => requests.filter((r) => r.url.startsWith("/crow-live/v1/pending")) };
}
const none = async () => ({ status: 401, body: { error: "unauthorized" } }); // the server's answer when nothing waits

test("cadence: 5 s while the editor has focus, 15 s visible but unfocused, 60 s hidden; a 401 (nothing queued) keeps the cadence", async () => {
  const e = editor(none);
  e.start(); await e.advance(1000);
  assert.equal(e.polls().length, 1);
  await e.advance(60000);
  const n = e.polls().length;
  assert.ok(n >= 12 && n <= 13, `focused: one poll per 5 s (got ${n})`);
  assert.ok(n < 60, "well under the server's 60/min per (document, user)");
  e.state.focus = false; await e.advance(5000); const a = e.polls().length; await e.advance(60000);
  assert.equal(e.polls().length - a, 4, "visible, unfocused: every 15 s");
  e.state.visibility = "hidden"; await e.advance(15000); const b = e.polls().length; await e.advance(120000);
  assert.equal(e.polls().length - b, 2, "hidden: every 60 s");
  assert.equal(e.ctx.crowLive.pollDelay(), 60000);
  e.state.visibility = "visible"; e.state.focus = true;
  assert.equal(e.ctx.crowLive.pollDelay(), 5000);
});

test("no readable parent frame: a visible tab counts as focused", async () => {
  const e = editor(none, { parentReadable: false });
  assert.equal(e.ctx.crowLive.pollDelay(), 5000);
  e.state.visibility = "hidden"; assert.equal(e.ctx.crowLive.pollDelay(), 60000);
});

test("429 and network errors back off 60 s; 426 (outdated plugin) stops polling", async () => {
  const e = editor(async () => ({ status: 429, body: {} }));
  e.start(); await e.advance(1000); await e.advance(59000);
  assert.equal(e.polls().length, 1, "no retry inside the back-off");
  await e.advance(1000); assert.equal(e.polls().length, 2);
  const s = editor(async () => ({ status: 426, body: {} }));
  s.start(); await s.advance(1000); await s.advance(600000);
  assert.equal(s.polls().length, 1);
});

test("a queued change is claimed within one focused poll (≤ 5 s) and the indicator stays up ≥ 2 s around the apply", async () => {
  let queued = false;
  const e = editor(async (url) => {
    if (url.startsWith("/crow-live/v1/pending")) return queued ? (queued = false, { status: 200, body: [{ change_id: "pc_1", tool: "ws_docs_append", args: { markdown: "x" }, pre: null }] }) : { status: 401, body: {} };
    if (url === "/crow-live/v1/claim") return { status: 200, body: { lease_until: 0, apply_token: "at" } };
    if (url === "/crow-live/v1/ack") return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });
  e.start(); await e.advance(7000);
  const t0 = e.requests.at(-1).at; queued = true;
  await e.advance(5000);
  const claim = e.requests.find((r) => r.url === "/crow-live/v1/claim");
  assert.ok(claim && claim.at - t0 <= 5000, "claimed within one poll interval");
  const start = e.methods.find((m) => m.name === "StartAction");
  assert.ok(start, "StartAction sent"); assert.deepEqual([...start.args], ["Information", "Crow is editing…"]);
  assert.equal(e.commands.length, 1);
  const ack = e.requests.find((r) => r.url === "/crow-live/v1/ack");
  assert.equal(ack.body.outcome, "applied"); assert.equal(ack.body.apply_token, "at");
  assert.ok(!e.methods.some((m) => m.name === "EndAction") || e.methods.find((m) => m.name === "EndAction").at - start.at >= 2000);
  await e.advance(5000);
  const end = e.methods.find((m) => m.name === "EndAction");
  assert.ok(end, "EndAction sent"); assert.ok(end.at - start.at >= 2000, `indicator visible ${end.at - start.at} ms`);
  assert.deepEqual([...end.args], ["Information", "Crow is editing…"]);
});

test("view mode never polls", async () => {
  const e = editor(none); e.ctx.Asc.plugin.info.isViewMode = true;
  e.start(); await e.advance(120000);
  assert.equal(e.polls().length, 0);
});

const queueOf = (changes, { throwOnCommand = false } = {}) => async (url) => {
  if (url.startsWith("/crow-live/v1/pending")) { const c = changes.shift(); return c ? { status: 200, body: [c] } : { status: 401, body: {} }; }
  if (url === "/crow-live/v1/claim") return { status: 200, body: { lease_until: 0, apply_token: "at" } };
  if (url === "/crow-live/v1/ack") return { status: 200, body: { ok: true } };
  return { status: 404, body: {} };
};

test("a wake-up (tab/window focus) never cuts an error back-off short, nor polls sooner than one focused interval", async () => {
  const e = editor(async () => ({ status: 429, body: {} }));
  e.start(); await e.advance(1000);
  for (let i = 0; i < 10; i++) { e.ctx.crowLive.wake(); await e.advance(1000); }
  assert.equal(e.polls().length, 1, "still backing off");
  const ok = editor(none); ok.start(); await ok.advance(1000);
  ok.ctx.crowLive.wake(); await ok.advance(1000);
  assert.equal(ok.polls().length, 1, "no poll within 5 s of the last one");
});

test("two changes back to back: one StartAction, one EndAction (≥ 2 s after the start)", async () => {
  const c = (id) => ({ change_id: id, tool: "ws_docs_append", args: { markdown: id }, pre: null });
  const e = editor(queueOf([c("pc_a"), c("pc_b")]));
  e.start(); await e.advance(1000); await e.advance(10000);
  assert.equal(e.commands.length, 2);
  assert.equal(e.methods.filter((m) => m.name === "StartAction").length, 1);
  assert.equal(e.methods.filter((m) => m.name === "EndAction").length, 1);
  const [s, end] = [e.methods.find((m) => m.name === "StartAction"), e.methods.find((m) => m.name === "EndAction")];
  assert.ok(end.at - s.at >= 2000);
});

test("callCommand throwing: the claim is acked failed (not applied_nothing), the indicator ends, polling continues", async () => {
  const e = editor(queueOf([{ change_id: "pc_t", tool: "ws_docs_append", args: {}, pre: null }]));
  e.ctx.Asc.plugin.callCommand = () => { throw new Error("editor busy"); };
  e.start(); await e.advance(1000); await e.advance(4000);
  const ack = e.requests.find((r) => r.url === "/crow-live/v1/ack");
  assert.equal(ack.body.outcome, "failed"); assert.equal(ack.body.applied_nothing, false);
  assert.ok(e.methods.some((m) => m.name === "EndAction"));
  const n = e.polls().length; await e.advance(10000);
  assert.ok(e.polls().length > n, "still polling at the normal cadence");
});
