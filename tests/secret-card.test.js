/**
 * Credential card (R1.2 spec §10.2, §10.3; plan Task 3): the engine's `secret_request` frame,
 * the GET refetch, the submit route and the hub card's strings.
 *
 * Runs on the credential canary harness (tests/fixtures/credential-canary.mjs): the REAL Perch
 * engine with a fake pi and held timers, the REAL perch-api router behind the REAL CSRF rail,
 * and a scratch crow.db and CROW_HOME. The harness wires the request store's card hook to its
 * engine, as boot/mcp-mounts.js does in the gateway. The browser half is
 * tests/secret-card-live.test.js.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createCanaryHarness, makeCanary } from "./fixtures/credential-canary.mjs";

const STALL_MS = 60_000;
const IDLE_MS = 300_000;

let h, store, keychainKey, perchHubJs, t;
before(async () => {
  h = await createCanaryHarness({ env: { PERCH_TURN_STALL_MS: String(STALL_MS), PERCH_INTERACTIVE_IDLE_MS: String(IDLE_MS) } });
  store = await import("../servers/gateway/secrets/request-store.js");
  keychainKey = await import("../servers/gateway/keychain/key.js");
  ({ perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js"));
  ({ t } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  const { default: secretSubmitRouter } = await import("../servers/gateway/routes/secret-submit.js");
  h.mountDashboard(secretSubmitRouter(h.sessionGate));
});
after(async () => { if (h) await h.close(); });

const sessions = [];
beforeEach(async () => {
  // One card per test: stop the sessions the last test left awake (the awake cap is small).
  for (const sid of sessions.splice(0)) { try { await h.engine.stop(sid); } catch { /* gone */ } }
});

async function session(botId) {
  const s = await h.spawnSession(botId);
  sessions.push(s.sessionId);
  return s;
}

/** A request plus its open card, the way crow_request_secret makes them. */
function openCard(s, botId, label = "Example site") {
  const { id } = store.createSecretRequest({ sessionId: s.sessionId, threadId: s.threadId, botId, kind: "password", target: "keychain", label });
  const shown = store.emitSecretCard(s.sessionId, store.secretFrame(store.getSecretRequest(id), "open"), { botId });
  return { id, shown };
}

const cardFrames = (sid) => h.frames.filter((f) => f.sessionId === sid && f.event.type === "secret_request").map((f) => f.event);
const submitPath = (id, sid) => `/dashboard/perch-api/secret/${id}?sid=${encodeURIComponent(sid)}`;

const get = (path) => h.get(path);

test("frame has no value field: allowlisted primitive keys, a 32-hex id, a state enum, the store's label", async () => {
  const s = await session("frame-bot");
  const { id, shown } = openCard(s, "frame-bot", "Example site");
  assert.deepEqual(shown, { delivered: true, botId: "frame-bot" });
  const [open] = cardFrames(s.sessionId);
  assert.deepEqual(open, { type: "secret_request", id, label: "Example site", state: "open" });

  const e = h.engine;
  // A caller's extra keys never reach a subscriber, and the shown label is the store's.
  const before = cardFrames(s.sessionId).length;
  assert.equal(e.emitSecretCard(s.sessionId, { type: "secret_request", id, state: "open", label: "Your bank", value: "x", text: "y" }, { botId: "frame-bot" }).delivered, true);
  const again = cardFrames(s.sessionId).slice(before);
  assert.deepEqual(again, [{ type: "secret_request", id, label: "Example site", state: "open" }]);
  // Refusals.
  const refused = (frame, opts) => e.emitSecretCard(s.sessionId, frame, opts).reason;
  assert.equal(refused({ type: "secret_request", id, state: "open" }, {}), "bot_required");
  assert.equal(refused({ type: "secret_request", id, state: "open" }, { botId: "other-bot" }), "bot_mismatch");
  assert.equal(refused({ type: "ask_user", id, state: "open" }, { botId: "frame-bot" }), "bad_frame");
  assert.equal(refused({ type: "secret_request", id, state: "open", label: { nested: 1 } }, { botId: "frame-bot" }), "bad_frame");
  assert.equal(refused({ type: "secret_request", id: "not-hex", state: "open" }, { botId: "frame-bot" }), "bad_frame");
  assert.equal(refused({ type: "secret_request", id, state: "filled" }, { botId: "frame-bot" }), "bad_frame");
  assert.equal(refused({ type: "secret_request", id: "f".repeat(32), state: "open" }, { botId: "frame-bot" }), "no_request");
  assert.equal(refused({ type: "secret_request", id: "f".repeat(32), state: "done" }, { botId: "frame-bot" }), "no_card");
  assert.equal(e.emitSecretCard("perchlive-nope", { type: "secret_request", id, state: "open" }, { botId: "frame-bot" }).reason, "no_session");
  // Another session's request cannot be opened in this chat.
  const s2 = await session("frame-bot-2");
  assert.equal(e.emitSecretCard(s2.sessionId, { type: "secret_request", id, state: "open" }, { botId: "frame-bot-2" }).reason, "no_request");
  // Every frame any subscriber saw is the four keys, primitives only.
  for (const f of h.frames.filter((x) => x.event.type === "secret_request")) {
    assert.deepEqual(Object.keys(f.event).sort(), ["id", "label", "state", "type"]);
    for (const v of Object.values(f.event)) assert.ok(v === null || typeof v === "string");
  }
  // The "needs you" push says a password is wanted, never a label or a value.
  await h.tick(20);
  const { rows } = await h.db.execute({ sql: "SELECT body FROM notifications WHERE body = ?", args: ["A bot needs a password"] });
  assert.ok(rows.length >= 1, "the attention row");
  store.cancelSecret(id, s.sessionId);
});

test("card renders and survives reload via GET", async () => {
  const s = await session("reload-bot");
  const { id } = openCard(s, "reload-bot", "Reload site");
  const r = await get(`/dashboard/perch-api/interactive/${s.sessionId}/secret`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const req = store.getSecretRequest(id);
  assert.deepEqual(r.json, { id, label: "Reload site", kind: "password", expiresAt: req.expiresAt });
  // A late subscriber (a reconnecting stream) gets the open card replayed.
  const seen = [];
  const off = await h.engine.subscribe(s.sessionId, (e) => seen.push(e));
  off();
  assert.deepEqual(seen.filter((e) => e.type === "secret_request"), [{ type: "secret_request", id, label: "Reload site", state: "open" }]);
  // Another chat has none; after the card is answered this one has none either.
  const s2 = await session("reload-bot-2");
  assert.equal((await get(`/dashboard/perch-api/interactive/${s2.sessionId}/secret`)).json, null);
  store.cancelSecret(id, s.sessionId);
  assert.equal((await get(`/dashboard/perch-api/interactive/${s.sessionId}/secret`)).json, null);
  // The hub script loads it alongside the other on-load fetches and still parses.
  const js = perchHubJs("en");
  assert.doesNotThrow(() => new Function(js), "the hub script parses");
  assert.match(js, /loadSecret\(current\.sid\);/);
  assert.match(js, /on\('secret_request'/);
  assert.match(js, /\/interactive\/'\+encodeURIComponent\(mySid\)\+'\/secret'/);
});

test("submit stores and emits done", async () => {
  keychainKey.createKeychainKey({ crowHome: h.crowHome });
  const c = makeCanary();
  const s = await session("submit-bot");
  const { id } = openCard(s, "submit-bot", "Submit site");
  const r = await h.post(submitPath(id, s.sessionId), { value: c });
  assert.deepEqual([r.status, r.json], [200, { ok: true, code: "saved" }]);
  const states = cardFrames(s.sessionId).map((f) => f.state);
  assert.deepEqual(states, ["open", "done"]);
  const row = (await h.keychainRows()).find((x) => x.label === "Submit site");
  assert.ok(row);
  assert.equal(await h.openKeychain(row.id), c);
  const audit = (await h.db.execute("SELECT details FROM audit_log WHERE event_type='keychain_add'")).rows.map((x) => JSON.parse(x.details));
  assert.ok(audit.some((d) => d.source === "secret_request" && d.bot_id === "submit-bot" && d.label === "Submit site"));
  // Single use: a second submit of the same id is refused, and nothing more is stored.
  const again = await h.post(submitPath(id, s.sessionId), { value: c });
  assert.deepEqual([again.status, again.json], [404, { error: "not_found" }]);
  assert.equal((await h.keychainRows()).filter((x) => x.label === "Submit site").length, 1);
  // The stall watchdog and idle timer re-arm once the card is gone (the idle timer is held).
  assert.equal((await h.engine.get(s.sessionId)).state, "awake");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("submit refusals: empty value, another session, expired, no keychain key", async () => {
  const s = await session("refuse-bot");
  const s2 = await session("refuse-bot-2");
  const { id } = openCard(s, "refuse-bot");
  for (const body of [{}, { value: "" }, { value: 12345678 }, { value: "x".repeat(1025) }]) {
    const r = await h.post(submitPath(id, s.sessionId), body);
    assert.deepEqual([r.status, r.json], [400, { error: "bad_value" }], JSON.stringify(body).slice(0, 40));
  }
  assert.ok(store.getSecretRequest(id), "a bad value never burns the request");
  const wrong = await h.post(submitPath(id, s2.sessionId), { value: "hunter2-but-longer" });
  assert.deepEqual([wrong.status, wrong.json], [404, { error: "not_found" }]);
  const none = await h.post(`/dashboard/perch-api/secret/${id}`, { value: "hunter2-but-longer" });
  assert.equal(none.status, 404, "no session named: refused");
  assert.ok(store.getSecretRequest(id), "another session's submit never burns it");
  // Expired: the clock moves past the ten minutes.
  const real = Date.now();
  store._setClockForTest(() => real + store.SECRET_REQUEST_TTL_MS + 1);
  try {
    const late = await h.post(submitPath(id, s.sessionId), { value: "hunter2-but-longer" });
    assert.deepEqual([late.status, late.json], [410, { error: "expired" }]);
  } finally { store._setClockForTest(null); }
  assert.equal(cardFrames(s.sessionId).at(-1).state, "expired");
  // No keychain key: a fixed code, the card says it failed, nothing stored, no key created.
  const { rmSync } = await import("node:fs");
  rmSync(keychainKey.keychainKeyPath(h.crowHome), { force: true });
  const s3 = await session("nokey-bot");
  const k = openCard(s3, "nokey-bot", "No key site");
  const r = await h.post(submitPath(k.id, s3.sessionId), { value: "hunter2-but-longer" });
  assert.deepEqual([r.status, r.json], [200, { ok: false, code: "not_set_up" }]);
  assert.equal(cardFrames(s3.sessionId).at(-1).state, "failed");
  assert.equal(keychainKey.keychainKeyState({ crowHome: h.crowHome }).state, "missing");
  store.takeSecretNotes(s.sessionId); store.takeSecretNotes(s3.sessionId);
});

test("cancel leaves the quiet line", async () => {
  const s = await session("cancel-bot");
  const { id } = openCard(s, "cancel-bot");
  const r = await h.post(submitPath(id, s.sessionId), { cancel: true });
  assert.deepEqual([r.status, r.json], [200, { ok: true, code: "closed" }]);
  assert.deepEqual(cardFrames(s.sessionId).map((f) => f.state), ["open", "closed"]);
  assert.equal(store.getSecretRequest(id), null);
  assert.equal((await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "ok?" })).status, 202);
  assert.match(h.pi().lastTurn().message, /^\[Crow\] You closed the form\. Nothing was sent\.\n\nok\?$/);
  await h.endTurn("fine");
});

test("CSRF required", async () => {
  const s = await session("csrf-bot");
  const { id } = openCard(s, "csrf-bot");
  const noHeader = await h.post(submitPath(id, s.sessionId), { value: "hunter2-but-longer" }, { headers: { "x-crow-csrf": "" } });
  assert.equal(noHeader.status, 403);
  const wrong = await h.post(submitPath(id, s.sessionId), { value: "hunter2-but-longer" }, { headers: { "x-crow-csrf": "nope" } });
  assert.equal(wrong.status, 403);
  const noSession = await h.post(submitPath(id, s.sessionId), { value: "hunter2-but-longer" }, { headers: { cookie: "crow_csrf=tok" } });
  assert.equal(noSession.status, 401);
  const peer = await h.post(submitPath(id, s.sessionId), { value: "hunter2-but-longer" }, { headers: { "x-crow-signature": "abc" } });
  assert.deepEqual([peer.status, peer.json], [403, { error: "forbidden" }]);
  assert.ok(store.getSecretRequest(id), "no refused submit burns the request");
  assert.equal(cardFrames(s.sessionId).length, 1, "only the open frame");
  store.cancelSecret(id, s.sessionId);
});

test("restart drops the request", async () => {
  const s = await session("restart-bot");
  const { id } = openCard(s, "restart-bot");
  // A gateway restart: the in-memory store starts empty (and so does the engine; this one's
  // card state is settled by the hibernate a restart's shutdown runs, below).
  store._resetSecretStoreForTest();
  store.setEmitSecretCard((sid, f, o) => h.engine.emitSecretCard(sid, f, o));
  assert.equal((await get(`/dashboard/perch-api/interactive/${s.sessionId}/secret`)).json, null, "the reload shows no card");
  const r = await h.post(submitPath(id, s.sessionId), { value: "hunter2-but-longer" });
  assert.deepEqual([r.status, r.json], [404, { error: "not_found" }], "a late submit answers at once");
  // The shutdown's own path: a hibernate expires the card and the bot is told on its next turn.
  const s2 = await session("restart-bot-2");
  const k = openCard(s2, "restart-bot-2");
  await h.engine._hibernateForTest(s2.sessionId);
  assert.equal(cardFrames(s2.sessionId).at(-1).state, "expired");
  assert.equal(store.getSecretRequest(k.id), null);
  assert.deepEqual(store.takeSecretNotes(s2.sessionId), ["The password request expired. Nothing was sent."]);
});

test("stall/idle paused while open", async () => {
  // Stall: a turn in flight, a card opens; the child keeps talking (which re-arms the watchdog
  // whenever nothing waits on the operator), then ten stall windows pass with no stall.
  const s = await session("stall-bot");
  assert.equal((await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "work" })).status, 202);
  const { id } = openCard(s, "stall-bot");
  const errs = () => h.frames.filter((f) => f.sessionId === s.sessionId && f.event.type === "error" && /stall/.test(f.event.text)).length;
  h.pi().emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "waiting for the password" } });
  await h.tick();
  h.clock.advance(STALL_MS * 10);
  await h.tick();
  assert.equal(errs(), 0, "a bot waiting on a typed password is not stalled");
  // Idle: the turn ends while the card is open; the idle window passes with no hibernation.
  await h.endTurn("I'll wait for the card.");
  h.clock.advance(IDLE_MS * 3);
  await h.tick();
  assert.equal((await h.engine.get(s.sessionId)).state, "awake", "an open card blocks hibernation");
  // Cycle refuses too, like a pending ask.
  await assert.rejects(h.engine.cycle(s.sessionId), (e) => e.code === "cycle_busy");
  // The card closes: the idle countdown resumes.
  store.cancelSecret(id, s.sessionId);
  store.emitSecretCard(s.sessionId, { type: "secret_request", id, label: null, state: "closed" }, { botId: "stall-bot" });
  h.clock.advance(IDLE_MS + 1);
  await h.tick(10);
  assert.equal((await h.engine.get(s.sessionId)).state, "hibernating", "the idle countdown resumes after");
  store.takeSecretNotes(s.sessionId);

  // And the watchdog resumes once the card is gone (a second session, a fresh turn).
  const s2 = await session("stall-bot-2");
  assert.equal((await h.post(`/dashboard/perch-api/interactive/${s2.sessionId}/message`, { message: "work" })).status, 202);
  const k = openCard(s2, "stall-bot-2");
  store.cancelSecret(k.id, s2.sessionId);
  store.emitSecretCard(s2.sessionId, { type: "secret_request", id: k.id, label: null, state: "closed" }, { botId: "stall-bot-2" });
  h.clock.advance(STALL_MS + 1);
  await h.tick();
  assert.equal(h.frames.filter((f) => f.sessionId === s2.sessionId && f.event.type === "error" && /stall/.test(f.event.text)).length, 1);
  await h.tick(10);
  store.takeSecretNotes(s2.sessionId);
});

test("the expiry timer flips an open card to expired on its own; claim, cancel and forget clear it", async () => {
  const timers = new Map();
  let seq = 0;
  store._setTimersForTest({ setTimer: (fn, ms) => { const i = ++seq; timers.set(i, { fn, ms }); return i; }, clearTimer: (i) => timers.delete(i) });
  try {
    const s = await session("timer-bot");
    const { id } = openCard(s, "timer-bot");
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].ms, store.SECRET_REQUEST_TTL_MS);
    const due = store.getSecretRequest(id).expiresAt;
    store._setClockForTest(() => due);
    const [entry] = timers.values();
    timers.clear();
    entry.fn();
    assert.equal(store.getSecretRequest(id), null);
    assert.equal(cardFrames(s.sessionId).at(-1).state, "expired");
    assert.deepEqual(store.takeSecretNotes(s.sessionId), ["The password request expired. Nothing was sent."]);
    store._setClockForTest(null);

    const a = openCard(s, "timer-bot");
    store.cancelSecret(a.id, s.sessionId);
    assert.equal(timers.size, 0, "cancel clears it");
    const b = openCard(s, "timer-bot");
    store.claimSecret(b.id, { sessionId: s.sessionId });
    assert.equal(timers.size, 0, "a claim clears it");
    store.emitSecretCard(s.sessionId, { type: "secret_request", id: b.id, label: null, state: "done" }, { botId: "timer-bot" });
    openCard(s, "timer-bot");
    store.forgetSession(s.sessionId);
    assert.equal(timers.size, 0, "forgetSession clears it");
  } finally {
    store._setTimersForTest(null);
    store._setClockForTest(null);
  }
});

test("stop and archive forget the session's request and notes", async () => {
  const s = await session("stop-bot");
  const { id } = openCard(s, "stop-bot");
  await h.engine.stop(s.sessionId);
  assert.equal(store.getSecretRequest(id), null);
  assert.deepEqual(store.takeSecretNotes(s.sessionId), [], "a stopped session keeps no notes");
  assert.equal(cardFrames(s.sessionId).at(-1).state, "expired");

  const s2 = await session("archive-bot");
  const k = openCard(s2, "archive-bot");
  await h.engine.setArchived(s2.sessionId, true);
  assert.equal(store.getSecretRequest(k.id), null);
  assert.equal(cardFrames(s2.sessionId).at(-1).state, "expired");
  assert.equal((await h.engine.get(s2.sessionId)).state, "awake", "archiving never touches the child");
});

test("en and es", () => {
  const keys = ["perch.secretTitle", "perch.secretTitleNoLabel", "perch.secretAsks", "perch.secretHelp", "perch.secretEnter",
    "perch.secretSave", "perch.secretNotNow", "perch.secretField", "perch.secretSaved", "perch.secretClosed",
    "perch.secretExpired", "perch.secretGone", "perch.secretNotSetUp", "perch.secretFailed", "perch.secretSaving"];
  for (const k of keys) {
    const en = t(k, "en"), es = t(k, "es");
    assert.ok(en && en !== k, k + " en");
    assert.ok(es && es !== k && es !== en, k + " es");
  }
  assert.equal(t("perch.secretHelp", "en"), "A browser can't block screenshots; enter this where no one is watching.");
  assert.equal(t("perch.secretSaved", "en"), "Saved. Nothing about it reaches the bot except its name.");
  assert.equal(t("perch.secretTitle", "en"), "🔒 Password for {label}");
  assert.equal(t("perch.secretAsks", "en"), "{bot} asks for: {label}");
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);
    assert.ok(js.includes(t("perch.secretEnter", lang).replace(/'/g, "\\'")), lang + " carries its own strings");
    assert.doesNotThrow(() => new Function(js), lang + " parses");
  }
});
