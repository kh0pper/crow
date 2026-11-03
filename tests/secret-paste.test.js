/**
 * The credential card, Task 4: the composer's paste detector and the server-side strip
 * (credential card spec §10.2/§10.3).
 *
 * Both halves run here:
 *  - the SERVER half on the credential canary harness (tests/fixtures/credential-canary.mjs): the
 *    REAL Perch engine with a fake pi and the REAL perch-api router, so "the strip happened before
 *    the engine saw it" is measured on what pi was actually handed;
 *  - the CLIENT half on the full-script vm harness (tests/fixtures/perch-hub-vm.mjs), the same
 *    shape tests/perch-hub-client.test.js uses, so send(), the warning card and the draft guard
 *    are the emitted script's own, not a copy.
 *
 * No secret in this file is a literal: every value comes from makeCanary().
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCanaryHarness, makeCanary } from "./fixtures/credential-canary.mjs";
import {
  mountHub, openChatSession, findByClass, clickClass, stdFetch, makeResponse, FakeEventSource, makeStorage,
} from "./fixtures/perch-hub-vm.mjs";

/** The plan's exact note, prefixed to a message whose secret the server removed. */
const NOTE = "[The operator's message had a secret in it, and it was removed. Suggest they change that password.]";

let h;
before(async () => { h = await createCanaryHarness(); });
after(async () => { if (h) await h.close(); });

const sessions = [];
/** A fresh session (the awake cap is small, so the previous test's are stopped). */
async function session(botId) {
  for (const sid of sessions.splice(0)) { try { await h.engine.stop(sid); } catch { /* gone */ } }
  const s = await h.spawnSession(botId);
  sessions.push(s.sessionId);
  return s;
}

const messagePath = (sid) => `/dashboard/perch-api/interactive/${sid}/message`;
const steerPath = (sid) => `/dashboard/perch-api/interactive/${sid}/steer`;
const answerPath = (sid) => `/dashboard/perch-api/interactive/${sid}/answer`;

// ---------------------------------------------------------------------------
// The client: the warning before a send, and no draft while it is open
// ---------------------------------------------------------------------------

test("warn before send, no draft write", async () => {
  const c = makeCanary();
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const input = hub.els["perch-input"];
  input.value = "my password: " + c;

  hub.els["perch-send"].onclick();

  const pane = hub.els["perch-secret-warn"];
  assert.equal(pane.hidden, false, "the warning is on screen");
  assert.equal(findByClass(pane, "secret-warn-title").textContent,
    "This looks like a password. Remove it, or send it anyway?");
  assert.equal(findByClass(pane, "secret-warn-remove").textContent, "Remove it");
  assert.equal(findByClass(pane, "secret-warn-send").textContent, "Send anyway");
  assert.equal(findByClass(pane, "secret-warn-keep").textContent, "It's not a secret");
  assert.equal(hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message")).length, 0,
    "nothing is sent while the warning is open");
  assert.equal(input.value, "my password: " + c, "the operator's text stays put for the choice");

  // Typing still schedules a draft save; while the warning is open that save writes nothing with
  // the secret in it (B1: the stored draft is the stripped text).
  input.oninput();
  for (const [id, fn] of [...hub.timers]) {
    if (hub.timerDelays.get(id) === 300) { hub.timers.delete(id); hub.timerDelays.delete(id); fn(); }
  }
  const draftsWhileOpen = JSON.stringify([...hub.storage._map.entries()]);
  assert.ok(!draftsWhileOpen.includes(c), "no draft holds the secret while the warning is open: " + draftsWhileOpen);
  assert.ok(draftsWhileOpen.includes("[secret removed]"), "the draft holds the stripped text");
});

test("remove strips locally", async () => {
  const c = makeCanary();
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const input = hub.els["perch-input"];
  input.value = "my password: " + c + " thanks";

  hub.els["perch-send"].onclick();
  clickClass(hub.els["perch-secret-warn"], "secret-warn-remove");

  assert.equal(hub.els["perch-secret-warn"].hidden, true, "the warning closes");
  assert.equal(input.value, "my password: [secret removed] thanks", "only the value is replaced");
  assert.ok(!input.value.includes(c));
  assert.equal(hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message")).length, 0,
    "Remove it sends nothing");
  // The draft written once the choice is made holds the stripped text, never the value.
  const drafts = JSON.stringify([...hub.storage._map.entries()]);
  assert.ok(drafts.includes("[secret removed]") && !drafts.includes(c), drafts);
});

test("send anyway posts the strip ack, and the count is shown", async () => {
  const c = makeCanary();
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/message": () => makeResponse(202, { turnId: "t1", removed: 1 }) }),
  });
  await openChatSession(hub);
  hub.els["perch-input"].value = "my password: " + c;
  hub.els["perch-send"].onclick();
  clickClass(hub.els["perch-secret-warn"], "secret-warn-send");
  await new Promise((r) => setTimeout(r, 0));

  const posts = hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message"));
  assert.equal(posts.length, 1, "one send, now the operator has chosen");
  assert.deepEqual(JSON.parse(posts[0].opts.body), { message: "my password: " + c, secretAck: "strip" });
  const notes = hub.els["perch-transcript"].children
    .filter((n) => String(n.className || "").includes("note")).map((n) => n.textContent);
  assert.ok(notes.includes("1 secret removed before sending."), JSON.stringify(notes));
});

test("send anyway keeps the secret out of the echo, the draft and the retry record", async () => {
  const c = makeCanary();
  const storage = makeStorage();
  const written = [];
  const set = storage.setItem;
  storage.setItem = (k, v) => { written.push(String(v)); set(k, v); };
  // The send fails (a lost connection), so the client also keeps the words as the unsent draft.
  const hub = await mountHub({ storage, fetchImpl: stdFetch({ "/message": () => makeResponse(0, null) }) });
  await openChatSession(hub);
  hub.els["perch-input"].value = "my password: " + c + " thanks";
  hub.els["perch-send"].onclick();
  clickClass(hub.els["perch-secret-warn"], "secret-warn-send");
  await new Promise((r) => setTimeout(r, 0));
  const posts = hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message"));
  assert.equal(JSON.parse(posts[0].opts.body).message, "my password: " + c + " thanks", "only the request body carries the original");
  const deep = (n) => String(n.textContent || "") + (n.children || []).map(deep).join(" ");
  const rows = hub.els["perch-transcript"].children.map(deep);
  assert.ok(rows.some((t) => t.includes("my password: [secret removed] thanks")), "the echo is the stripped text: " + JSON.stringify(rows));
  assert.ok(!rows.some((t) => t.includes(c)), "the canary is not on screen");
  assert.ok(!written.some((v) => v.includes(c)), "nothing written to sessionStorage holds the canary");
  assert.ok(!hub.els["perch-input"].value.includes(c), "a failed send does not put the canary back in the composer");
});

test("the removed count has a plural form", async () => {
  const c = makeCanary();
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/message": () => makeResponse(202, { turnId: "t1", removed: 3 }) }),
  });
  await openChatSession(hub);
  hub.els["perch-input"].value = "my password: " + c;
  hub.els["perch-send"].onclick();
  clickClass(hub.els["perch-secret-warn"], "secret-warn-send");
  await new Promise((r) => setTimeout(r, 0));
  const notes = hub.els["perch-transcript"].children
    .filter((n) => String(n.className || "").includes("note")).map((n) => n.textContent);
  assert.ok(notes.includes("3 secrets removed before sending."), JSON.stringify(notes));
});

test("a paste opens the warning before Send", async () => {
  const c = makeCanary();
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  hub.els["perch-input"].value = "token: " + c;
  hub.els["perch-input"]._dispatch("paste", {});
  for (const [id, fn] of [...hub.timers]) {
    if (hub.timerDelays.get(id) === 0) { hub.timers.delete(id); hub.timerDelays.delete(id); fn(); }
  }
  assert.equal(hub.els["perch-secret-warn"].hidden, false, "the paste is caught, not only the send");
  assert.equal(hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message")).length, 0);
});

test("the paste warning's help text links to the project's Services page", async () => {
  const c = makeCanary();
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  hub.els["perch-input"].value = "password: " + c;
  hub.els["perch-send"].onclick();
  const a = findByClass(hub.els["perch-secret-warn"], "secret-warn-link");
  assert.ok(a, "the warning carries the Services link");
  assert.equal(a.href, "/dashboard/project/home/services");
  assert.equal(a.textContent, "Open Services");
});

test("a typed (not pasted) secret never reaches sessionStorage", async () => {
  const c = makeCanary();
  const storage = makeStorage();
  const written = [];
  const set = storage.setItem;
  storage.setItem = (k, v) => { written.push(String(v)); set(k, v); };
  const hub = await mountHub({ storage, fetchImpl: stdFetch() });
  await openChatSession(hub);
  const input = hub.els["perch-input"];
  input.value = "my password: " + c;
  input.oninput();                                   /* typed, not pasted */
  for (const [id, fn] of [...hub.timers]) {
    if (hub.timerDelays.get(id) === 300) { hub.timers.delete(id); hub.timerDelays.delete(id); fn(); }
  }
  assert.ok(written.length, "the draft timer ran");
  assert.ok(!written.some((v) => v.includes(c)), "the draft holds no canary: " + JSON.stringify(written));
  assert.ok(written.some((v) => v.includes("[secret removed]")), "it holds the stripped text instead");
  // The warning opening does not put it back either (the stored draft is overwritten stripped).
  hub.els["perch-send"].onclick();
  assert.equal(hub.els["perch-secret-warn"].hidden, false, "the warning is on screen");
  assert.ok(!written.some((v) => v.includes(c)), "still nothing with the warning open");
  assert.ok(!JSON.stringify([...hub.storage._map.entries()]).includes(c), "and nothing stored holds it");
});

test("the ask text field warns before submit", async () => {
  const c = makeCanary();
  const hub = await mountHub({ fetchImpl: stdFetch({ "/answer": () => makeResponse(200, { ok: true, removed: 0 }) }) });
  await openChatSession(hub);
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es._serverFrame("ask_user", { requestId: "r1", method: "input", title: "Which password?", placeholder: "type it" });
  await new Promise((r) => setTimeout(r, 0));
  const controls = findByClass(hub.els["perch-ask"], "ask-controls");
  assert.ok(controls, "the ask card has its controls");
  const field = controls.children[0], submit = controls.children[1];
  field.value = "my password: " + c;
  submit.onclick();
  assert.equal(hub.els["perch-secret-warn"].hidden, false, "the answer warns before it is sent");
  assert.equal(hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/answer")).length, 0,
    "nothing is answered while the warning is open");
  clickClass(hub.els["perch-secret-warn"], "secret-warn-send");
  await new Promise((r) => setTimeout(r, 0));
  const posts = hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/answer"));
  assert.equal(posts.length, 1, "one answer, now the operator has chosen");
  assert.deepEqual(JSON.parse(posts[0].opts.body), { requestId: "r1", value: "my password: " + c, secretAck: "strip" });
});

// ---------------------------------------------------------------------------
// The server: the strip, its note, and the per-send override
// ---------------------------------------------------------------------------

test("send anyway strips server-side with the note", async () => {
  const c = makeCanary();
  const s = await session("strip-bot");
  const r = await h.post(messagePath(s.sessionId), { message: `my password: ${c} thanks`, secretAck: "strip" });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { turnId: r.json.turnId, removed: 1 }, "the count only");
  assert.ok(!r.text.includes(c), "the response never echoes the value");
  const sent = h.pi().lastTurn().message;
  assert.ok(sent.startsWith(NOTE + "\n\n"), "the fixed note leads the message: " + JSON.stringify(sent));
  assert.match(sent, /\[secret removed\]/);
  assert.ok(!sent.includes(c), "the value never reached the model");
  await h.endTurn("noted");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("override is honoured once", async () => {
  const c = makeCanary();
  const s = await session("override-bot");

  // "It's not a secret": sent unchanged, and the server-side strip does not fire.
  const keep = await h.post(messagePath(s.sessionId), { message: `it is ${c} actually`, secretAck: "keep" });
  assert.equal(keep.status, 202);
  assert.equal(keep.json.removed, 0);
  assert.ok(h.pi().lastTurn().message.includes(c), "keep sends the operator's text unchanged");
  await h.endTurn("ok");

  // The NEXT send carries no ack: nothing was remembered, so the strip is back.
  const next = await h.post(messagePath(s.sessionId), { message: `again ${c}` });
  assert.equal(next.json.removed, 1);
  assert.ok(h.pi().lastTurn().message.startsWith(NOTE));
  assert.ok(!h.pi().lastTurn().message.includes(c), "the next send strips again");
  await h.endTurn("ok");

  // Any value other than "keep" strips — a stray ack is not a bypass.
  const bogus = await h.post(messagePath(s.sessionId), { message: `and ${c}`, secretAck: "nonsense" });
  assert.equal(bogus.json.removed, 1);
  assert.ok(!h.pi().lastTurn().message.includes(c));
  await h.endTurn("ok");

  // The client's half of "honoured once": the same text warns again on the next tap.
  const hub = await mountHub({
    fetchImpl: stdFetch({ "/message": () => makeResponse(202, { turnId: "t1", removed: 0 }) }),
  });
  await openChatSession(hub);
  hub.els["perch-input"].value = "it is " + c + " actually";
  hub.els["perch-send"].onclick();
  clickClass(hub.els["perch-secret-warn"], "secret-warn-keep");
  await new Promise((r) => setTimeout(r, 0));
  let posts = hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message"));
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).secretAck, "keep");
  hub.els["perch-input"].value = "it is " + c + " actually";
  hub.els["perch-send"].onclick();
  assert.equal(hub.els["perch-secret-warn"].hidden, false, "the answer is per send, never remembered");
  posts = hub.fetchCalls.filter((x) => x.method === "POST" && x.path.endsWith("/message"));
  assert.equal(posts.length, 1, "and nothing went out on the second tap before the choice");
});

test("strip is surgical", async () => {
  const c = makeCanary();
  const s = await session("surgical-bot");
  const r = await h.post(messagePath(s.sessionId), { message: `please use ${c} for the deploy token, then tell me` });
  assert.equal(r.json.removed, 1);
  assert.equal(h.pi().lastTurn().message, NOTE + "\n\n" + "please use [secret removed] for the deploy token, then tell me",
    "only the key is replaced; the words around it survive");
  await h.endTurn("ok");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("steer is covered", async () => {
  const c = makeCanary();
  const s = await session("steer-api-bot");
  assert.equal((await h.post(messagePath(s.sessionId), { message: "start" })).status, 202);
  const r = await h.post(steerPath(s.sessionId), { message: `use ${c} instead` });
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 1);
  const frames = JSON.stringify(h.pi().sent);
  assert.ok(frames.includes("[secret removed]"), "the steer reached the child stripped: " + frames);
  assert.ok(!frames.includes(c), "the value never reached the child");
  await h.endTurn("ok");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("an ask answer with a secret is stripped server-side", async () => {
  const c = makeCanary();
  const s = await session("ask-strip-bot");
  h.pi().emit({ type: "extension_ui_request", id: "ask-1", method: "input", title: "Which password?", placeholder: "type it" });
  await h.tick();
  const r = await h.post(answerPath(s.sessionId), { requestId: "ask-1", value: `my password: ${c}` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, 1, "the count, never the value");
  const sent = JSON.stringify(h.pi().sent);
  assert.ok(sent.includes("[secret removed]"), "the child got the stripped answer: " + sent);
  assert.ok(!sent.includes(c), "the value never reached the child");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("keep on an ask answer is honoured once", async () => {
  const c = makeCanary();
  const s = await session("ask-keep-bot");
  h.pi().emit({ type: "extension_ui_request", id: "ask-k1", method: "editor", title: "Notes", placeholder: "" });
  await h.tick();
  const keep = await h.post(answerPath(s.sessionId), { requestId: "ask-k1", value: `it is ${c} actually`, secretAck: "keep" });
  assert.equal(keep.status, 200, keep.text);
  assert.equal(keep.json.removed, 0);
  assert.ok(JSON.stringify(h.pi().sent).includes(c), "keep sends the operator's answer unchanged (this once)");

  // The next answer carries no ack: nothing was remembered, so the strip is back.
  h.pi().emit({ type: "extension_ui_request", id: "ask-k2", method: "input", title: "And again?", placeholder: "" });
  await h.tick();
  const next = await h.post(answerPath(s.sessionId), { requestId: "ask-k2", value: `again ${c}` });
  assert.equal(next.json.removed, 1);
  const last = JSON.stringify(h.pi().sent[h.pi().sent.length - 1]);
  assert.ok(last.includes("[secret removed]"), last);
  assert.ok(!last.includes(c), "the next answer strips again");
  await h.endTurn("ok");
});

// ---------------------------------------------------------------------------
// N1/N2 (credential card review): a label the bot itself offered is never stripped
// ---------------------------------------------------------------------------

test("an option label that looks like a token is sent as offered", async () => {
  const c = makeCanary();
  const s = await session("select-offered-bot");
  const label = "Session " + c;
  h.pi().emit({ type: "extension_ui_request", id: "ask-o1", method: "select", title: "Which session?", options: [label, "Another session"] });
  await h.tick();
  const r = await h.post(answerPath(s.sessionId), { requestId: "ask-o1", value: label });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, 0, "the bot's own option is not something to strip");
  const sent = h.pi().sent.filter((f) => f && f.type === "extension_ui_response");
  assert.deepEqual(sent.at(-1), { type: "extension_ui_response", id: "ask-o1", value: label },
    "the child gets the option exactly as it offered it: " + JSON.stringify(sent.at(-1)));
  assert.ok(!JSON.stringify(sent).includes(NOTE), "and no false 'your message had a secret' note");
  // A select value the card did NOT offer is still stripped (the escape hatch stays shut).
  h.pi().emit({ type: "extension_ui_request", id: "ask-o2", method: "select", title: "Which session?", options: ["one", "two"] });
  await h.tick();
  const r2 = await h.post(answerPath(s.sessionId), { requestId: "ask-o2", value: "token: " + c });
  assert.equal(r2.json.removed, 1);
  const last = JSON.stringify(h.pi().sent[h.pi().sent.length - 1]);
  assert.ok(last.includes("[secret removed]") && !last.includes(c), last);
  await h.endTurn("ok");
});

test("a combined card's chosen option is sent as offered, and its Other text is still stripped", async () => {
  const offered = makeCanary();
  const typed = makeCanary();
  const { ASK_OTHER, askOptionRow } = await import("../servers/gateway/perch-interactive.js");
  const s = await session("combined-offered-bot");
  const label = "Session " + offered;
  const q0 = { header: "Auth", question: "Which session?", options: [{ label, description: "the live one" }, { label: "Another session" }] };
  const q1 = { header: "Notes", question: "Anything else?", options: [{ label: "Nothing" }] };
  h.pi().emit({ type: "extension_ui_request", method: "notify", message: "crow-ask:" + JSON.stringify({ id: "ask-c1", questions: [q0, q1] }) });
  // The child's first select is upgraded into the combined card (the options are its own rows).
  h.pi().emit({ type: "extension_ui_request", id: "ask-c1", method: "select", title: "Which session?", options: [askOptionRow(q0.options[0]), askOptionRow(q0.options[1])] });
  await h.tick();
  const r = await h.post(answerPath(s.sessionId), {
    requestId: "ask-c1",
    answers: [
      { question: "Which session?", selected: [label], other: null },
      { question: "Anything else?", selected: [], other: "password: " + typed },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.removed >= 1, "the Other text was stripped: " + r.text);
  // The rest of the answer dance: the child's next two dialogs consume the scripted replies.
  h.pi().emit({ type: "extension_ui_request", id: "ask-c1-b", method: "select", options: [ASK_OTHER] });
  await h.tick();
  h.pi().emit({ type: "extension_ui_request", id: "ask-c1-c", method: "input" });
  await h.tick();
  const values = h.pi().sent.filter((f) => f && f.type === "extension_ui_response").map((f) => String(f.value));
  assert.ok(values.includes(askOptionRow(q0.options[0])), "the chosen option is sent as offered: " + JSON.stringify(values));
  assert.ok(!values.some((v) => v.includes(offered) && v.includes("[secret removed]")), "the offered label is never rewritten");
  const other = values.find((v) => v !== askOptionRow(q0.options[0]) && v !== ASK_OTHER);
  assert.ok(other && other.includes("[secret removed]"), "the Other text is stripped: " + JSON.stringify(values));
  assert.ok(!other.includes(typed), "the typed secret never reaches the child: " + JSON.stringify(other));
  await h.endTurn("ok");
});

test("a non-string answer value is stripped too", async () => {
  const c = makeCanary();
  const s = await session("array-answer-bot");
  h.pi().emit({ type: "extension_ui_request", id: "ask-a1", method: "input", title: "Which password?", placeholder: "type it" });
  await h.tick();
  const r = await h.post(answerPath(s.sessionId), { requestId: "ask-a1", value: ["my password: " + c] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, 1, "the count, never the value");
  const last = JSON.stringify(h.pi().sent[h.pi().sent.length - 1]);
  assert.ok(last.includes("[secret removed]"), last);
  assert.ok(!last.includes(c), "a non-string free-text answer cannot skip the strip: " + last);
  await h.endTurn("ok");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test("en and es", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const keys = ["perch.secretWarnTitle", "perch.secretWarnHelp", "perch.secretWarnServices",
    "perch.secretWarnRemove", "perch.secretWarnSend", "perch.secretWarnKeep",
    "perch.secretRemovedOne", "perch.secretRemoved",
    "perch.connectTitle", "perch.connectHelp", "perch.connectOpen"];
  for (const k of keys) {
    const en = t(k, "en"), es = t(k, "es");
    assert.ok(en && en !== k, k + " en");
    assert.ok(es && es !== k && es !== en, k + " es");
  }
  assert.equal(t("perch.secretWarnTitle", "en"), "This looks like a password. Remove it, or send it anyway?");
  assert.equal(t("perch.secretWarnSend", "en"), "Send anyway");
  assert.equal(t("perch.secretWarnKeep", "en"), "It's not a secret");
  assert.equal(t("perch.secretRemovedOne", "en"), "1 secret removed before sending.");
  assert.equal(t("perch.secretRemoved", "en"), "{n} secrets removed before sending.");
  assert.equal(t("perch.secretWarnRemove", "es"), "Quitarla");
  // The paste warning's strings reach both emitted scripts.
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);
    assert.ok(js.includes(t("perch.secretWarnKeep", lang).replace(/'/g, "\\'")), lang + " carries its own strings");
    assert.doesNotThrow(() => new Function(js), lang + " parses");
  }
});