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
/** method(name, args, cb): an optional answer for executeMethod (e.g. GetAllComments). */
function editor(answer, { focus = true, visibility = "visible", parentReadable = true, method = null, callbackUrl = null } = {}) {
  let now = 1_000_000, nextId = 1; const timers = new Map();
  const state = { focus, visibility };
  const requests = [], methods = [], commands = [];
  const doc = { get visibilityState() { return state.visibility; }, addEventListener() {} };
  const ctx = {
    Date: { now: () => now }, Math, JSON, encodeURIComponent, decodeURIComponent, Error, atob,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: async (url, opts = {}) => {
      requests.push({ at: now, url, method: opts.method || "GET", headers: { ...(opts.headers || {}) }, body: opts.body ? JSON.parse(opts.body) : null });
      const r = await answer(url, opts);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    document: doc,
    Asc: {
      scope: {},
      plugin: {
        info: { jwt: "tok", documentId: "doc-key", isViewMode: false, ...(callbackUrl ? { documentCallbackUrl: callbackUrl } : {}) },
        executeMethod: (name, args, cb) => { methods.push({ at: now, name, args }); if (method) method(name, args, cb); },
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

// ---- 0.3.0: comment reports (comment loop Phase 1, shadow mode) ---------------------------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const CALLBACK = `/apps/onlyoffice/track?doc=${b64u({ alg: "HS256" })}.${b64u({ userId: "admin", fileId: 4242, action: "track" })}.sig`;
const cm = (Id, Text, { UserName = "admin", Time = "1793157691225", QuoteText = "con", Replies = [] } = {}) => ({ Id, Data: { Text, Time, UserName, QuoteText, Solved: false, UserData: "", Replies } });
/** An editor whose GetAllComments answers from `doc` (mutable), synchronously like the editor does. */
function commentEditor(answer = none, doc = []) {
  const e = editor(answer, { callbackUrl: CALLBACK, method: (name, args, cb) => { if (name === "GetAllComments" && cb) cb(JSON.parse(JSON.stringify(doc))); } });
  e.doc = doc;
  e.fire = (kind, ev) => e.ctx.Asc.plugin[kind === "add" ? "event_onAddComment" : "event_onChangeCommentData"](JSON.parse(JSON.stringify(ev)));
  e.reports = () => e.requests.filter((r) => r.url === "/crow-live/v1/comments");
  return e;
}
const okComments = async (url) => (url === "/crow-live/v1/comments" ? { status: 200, body: { state: "shadow" } } : { status: 401, body: {} });

test("baseline at ready: loaded comments and pre-ready events never report", async () => {
  const loaded = cm("1_1", "@hank an old request");
  const e = commentEditor(okComments, [loaded]);
  const early = cm("1_2", "@hank arrived before ready");
  e.doc.push(early); e.fire("add", early); // queued by waitEvents, delivered before ready
  e.start(); await e.advance(100);
  e.fire("add", loaded); e.fire("add", early); e.fire("change", loaded); // a DS that re-announces on load
  await e.advance(1000);
  assert.equal(e.reports().length, 0);
  assert.equal(e.methods.filter((m) => m.name === "GetAllComments").length, 1, "one baseline read");
  assert.ok(!e.methods.some((m) => m.name === "StartAction"), "no indicator");
});

test("a new @hank comment reports once within the event turn; plain text never reports", async () => {
  const e = commentEditor(okComments, []);
  e.start(); await e.advance(100);
  const plain = cm("1_3", "just a note about the menu");
  e.doc.push(plain); e.fire("add", plain);
  const hank = cm("1_4", "@hank please tidy this", { QuoteText: "p1\r\np2\r\n" });
  e.doc.push(hank); e.fire("add", hank);
  assert.equal(e.reports().length, 1, "sent in the same turn as the event");
  e.fire("add", hank); e.fire("change", hank);
  await e.advance(30000);
  assert.equal(e.reports().length, 1, "once");
  const [r] = e.reports();
  assert.equal(r.method, "POST");
  assert.equal(r.headers["X-Crow-File-Hint"], "4242", "the documentCallbackUrl doc token's fileId");
  assert.deepEqual(r.body, { key: "doc-key", pv: "0.3.0", kind: "add", occ: [0], attempt: 0,
    thread: { Id: "1_4", Text: "@hank please tidy this", Time: "1793157691225", UserName: "admin", QuoteText: "p1\r\np2\r\n", Solved: false, Replies: [] } });
  // a reply without a mention on that thread: nothing new names anyone → no report; a reply with one → "change"
  const withReply = cm("1_4", hank.Data.Text, { QuoteText: hank.Data.QuoteText, Replies: [{ Text: "thanks", Time: "1793157699000", UserName: "admin" }] });
  e.doc[1] = withReply; e.fire("change", withReply);
  assert.equal(e.reports().length, 1);
  const withMention = cm("1_4", hank.Data.Text, { QuoteText: hank.Data.QuoteText, Replies: [...withReply.Data.Replies, { Text: "@hank also this", Time: "1793157700000", UserName: "admin" }] });
  e.doc[1] = withMention; e.fire("change", withMention);
  assert.equal(e.reports().length, 2);
  assert.equal(e.reports()[1].body.kind, "change"); assert.deepEqual(e.reports()[1].body.occ, [0, 0, 0]);
  // over the server's limits: never sent
  const huge = cm("1_9", `@hank ${"x".repeat(4096)}`);
  e.doc.push(huge); e.fire("add", huge);
  const many = cm("1_10", "@hank many", { Replies: Array.from({ length: 51 }, (_, i) => ({ Text: `r${i}`, Time: "1793157700000", UserName: "admin" })) });
  e.doc.push(many); e.fire("add", many);
  assert.equal(e.reports().length, 2);
});

test("plugin occ matches saved occ for two pasted duplicates", async () => {
  const { commentDocx } = await import("./helpers/workspace-comment-docx.js");
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const { readCommentThreads } = await import("../bundles/workspace/server/ooxml/docx-comments.js");
  const K = await import("../bundles/workspace/server/comments/keys.js");
  const time = 1793157691225, iso = new Date(Math.floor(time / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const e = commentEditor(okComments, []);
  e.start(); await e.advance(100);
  const a = cm("1_6", "@hank dup", { Time: String(time) }), b = cm("1_11", "@hank dup", { Time: String(time) });
  e.doc.push(a, b); e.fire("add", a); e.fire("add", b);
  const occs = e.reports().map((r) => r.body.occ);
  assert.deepEqual(occs, [[0], [1]]);
  const saved = readCommentThreads(openDocx(commentDocx({ threads: [0, 1].map(() => ({ author: "admin", date: iso, text: "@hank dup", quoted: "con" })) }))).threads;
  const savedFps = K.flatten(saved).map(K.fingerprint);
  const liveFps = e.reports().map((r) => K.fingerprint(K.flatten(K.fromLive(r.body.thread, r.body.occ))[0]));
  assert.deepEqual(K.flatten(saved).map((c) => c.occ), [0, 1]);
  assert.deepEqual(liveFps, savedFps, "the same two fingerprints");
});

test("401 retry: re-sent at +5 s and +15 s, then dropped; polling cadence unchanged", async () => {
  const e = commentEditor(none, []);
  const control = editor(none);
  e.start(); control.start(); await e.advance(100); await control.advance(100);
  const t0 = e.requests.at(-1)?.at ?? 0;
  const hank = cm("1_5", "@hank are you there");
  e.doc.push(hank); e.fire("add", hank);
  const sentAt = e.reports()[0].at;
  assert.ok(sentAt >= t0);
  await e.advance(120000); await control.advance(120000);
  assert.deepEqual(e.reports().map((r) => r.at - sentAt), [0, 5000, 15000]);
  assert.deepEqual(e.reports().map((r) => r.body.attempt), [0, 1, 2], "each send carries its attempt number");
  assert.equal(e.polls().length, control.polls().length, "the same poll cadence as an editor with no reports");
  const d = commentEditor(async (url) => (url === "/crow-live/v1/comments" ? { status: 429, body: {} } : { status: 401, body: {} }), []);
  d.start(); await d.advance(100);
  const h2 = cm("1_7", "@hank again"); d.doc.push(h2); d.fire("add", h2);
  await d.advance(60000);
  assert.equal(d.reports().length, 1, "429: dropped, no retry");
});

test("the existing /pending→claim→callCommand→ack loop is unchanged with 0.3.0", async () => {
  const e = commentEditor(queueOf([{ change_id: "pc_c", tool: "ws_docs_append", args: { markdown: "x" }, pre: null }]), []);
  e.start(); await e.advance(1000); await e.advance(4000);
  assert.match(e.polls()[0].url, /&pv=0\.3\.0$/);
  assert.equal(e.polls()[0].headers["X-Crow-File-Hint"], "4242");
  const claim = e.requests.find((r) => r.url === "/crow-live/v1/claim");
  assert.equal(claim.body.pv, "0.3.0");
  assert.equal(e.commands.length, 1);
  const ack = e.requests.find((r) => r.url === "/crow-live/v1/ack");
  assert.equal(ack.body.outcome, "applied");
  assert.equal(e.reports().length, 0);
});

test("no documentCallbackUrl (or a malformed one): no hint header", async () => {
  const e = editor(none); e.start(); await e.advance(1000);
  assert.equal(e.polls()[0].headers["X-Crow-File-Hint"], undefined);
  const bad = editor(none, { callbackUrl: "/track?doc=not-a-jwt" }); bad.start(); await bad.advance(1000);
  assert.equal(bad.polls()[0].headers["X-Crow-File-Hint"], undefined);
});

test("a thread inside the character limits but over 250000 UTF-8 bytes is not sent", async () => {
  const e = commentEditor(okComments, []);
  e.start(); await e.advance(100);
  const wide = "日".repeat(4000); // 3 bytes each: 12 kB per item, under TEXT_MAX characters
  const replies = Array.from({ length: 25 }, () => ({ Text: wide, Time: "1793157700000", UserName: "admin" }));
  const big = cm("1_20", `@hank ${wide}`, { Replies: replies });
  assert.ok(JSON.stringify(big.Data).length < 2 * 256 * 1024 && Buffer.byteLength(JSON.stringify(big.Data)) > 250000);
  e.doc.push(big); e.fire("add", big);
  assert.equal(e.reports().length, 0, "over the byte budget: skipped");
  const ok = cm("1_21", "@hank small");
  e.doc.push(ok); e.fire("add", ok);
  assert.equal(e.reports().length, 1, "control: a normal thread is sent");
});
