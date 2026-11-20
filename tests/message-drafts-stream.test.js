/**
 * message-drafts-stream — the SSE route behind the Messages page's live Drafts section and composer
 * (/dashboard/streams/message-drafts).
 *
 * The route is the only consumer of the draft store's `message-drafts:changed` bus event
 * (servers/gateway/messages/drafts-store.js). What it forwards is an ALLOW-LISTED, ids-only frame:
 * the draft id, the conversation kind and local id, and the action word. The store never puts a
 * draft's text on the bus, and this route does not either — a payload that grows a field (a body, a
 * bot name, an audience) must not reach a browser through it, so the test emits a fat payload and
 * asserts the frame is exactly the four ids/words.
 *
 * OWNER ONLY: `dashboardAuth` lets a peer's single-sign-on session onto the dashboard, but which
 * conversations hold unsent words is the owner's business, so the route applies the same rule the
 * drafts API does (`isLocalPasswordSessionOn`) and answers 403 `owner_only` before opening a stream.
 * The last test drives that with the REAL rule against a scratch crow.db and two real sessions.
 *
 * Harness: tests/messages-stream-events.test.js's — the route handler is called directly (the
 * router's `dashboardAuth` is a no-op here, since the route is reached through `router.use`), with a
 * fake `res` that satisfies openStream/openAuthedStream and captures the `close` listener so the
 * 30 s heartbeat and the 5 min session recheck are cleared and the runner never hangs. The owner
 * rule is injected through the router's own seam except where the test is ABOUT the rule.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import bus from "../servers/shared/event-bus.js";
import streamsRouter from "../servers/gateway/routes/streams.js";
import { DRAFT_CHANGED_EVENT } from "../servers/gateway/messages/drafts-store.js";
import { isLocalPasswordSessionOn } from "../servers/gateway/dashboard/local-session.js";
import { markFromLaptop } from "./helpers/off-box.js";

const PATH = "/dashboard/streams/message-drafts";
const DRAFT_ID = "msgd-" + "a".repeat(32);

function fakeRes() {
  let headersSent = false;
  let ended = false;
  const chunks = [];
  const listeners = { close: [], error: [] };
  const res = {
    statusCode: 200,
    get headersSent() { return headersSent; },
    get writableEnded() { return ended; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; ended = true; return res; },
    writeHead() { headersSent = true; },
    flushHeaders() {},
    write(data) { chunks.push(data); return true; },
    end() { ended = true; },
    on(event, listener) { if (listeners[event]) listeners[event].push(listener); },
  };
  return { res, chunks, fireClose() { for (const l of listeners.close) l(); } };
}

/**
 * The route's handler. `owner` defaults to a true-checking stub: these tests are about the frames,
 * not the owner rule (which has its own test below).
 */
function getHandler(owner = async () => true) {
  const router = streamsRouter((req, res, next) => next(), { draftsOwnerCheck: owner });
  const layer = router.stack.find((l) => l.route && l.route.path === PATH);
  assert.ok(layer, `route ${PATH} must be registered`);
  return layer.route.stack[0].handle;
}

test("every draft write reaches the stream as a crow-draft frame carrying ids only", async () => {
  const handler = getHandler();
  const { res, chunks, fireClose } = fakeRes();
  await handler({ dashboardSession: "tok-draft-stream" }, res);
  try {
    bus.emit(DRAFT_CHANGED_EVENT, {
      draftId: DRAFT_ID,
      conversationKind: "contact",
      conversationId: 7,
      action: "edit",
      // Fields the store does not send, and that must never be forwarded even if they appear.
      body: "the words of the message",
      botName: "Hank",
      recipients: ["crow:peer"],
    });

    const out = chunks.join("");
    assert.equal(out, `event: crow-draft\ndata: ${JSON.stringify({
      draftId: DRAFT_ID,
      conversationKind: "contact",
      conversationId: 7,
      action: "edit",
    })}\n\n`, "exactly the four ids/words, and nothing else");
    assert.doesNotMatch(out, /the words of the message/, "no message text rides the live channel");
    assert.doesNotMatch(out, /Hank/, "no bot name either");
    assert.doesNotMatch(out, /crow:peer/, "and no recipient address");
  } finally {
    fireClose();
  }
});

test("a room's frames carry the room kind, so the panel opens the right thread", async () => {
  const handler = getHandler();
  const { res, chunks, fireClose } = fakeRes();
  await handler({ dashboardSession: "tok-draft-room" }, res);
  try {
    bus.emit(DRAFT_CHANGED_EVENT, {
      draftId: DRAFT_ID,
      conversationKind: "room",
      conversationId: 12,
      action: "send",
    });
    assert.match(chunks.join(""), /event: crow-draft\ndata: \{"draftId":"msgd-a{32}","conversationKind":"room","conversationId":12,"action":"send"\}\n\n/);
  } finally {
    fireClose();
  }
});

test("the boot sweep's reopen is forwarded too, with its own action word", async () => {
  const handler = getHandler();
  const { res, chunks, fireClose } = fakeRes();
  await handler({ dashboardSession: "tok-draft-reopen" }, res);
  try {
    bus.emit(DRAFT_CHANGED_EVENT, {
      draftId: DRAFT_ID, conversationKind: "contact", conversationId: 3, action: "reopened",
    });
    assert.match(chunks.join(""), /"action":"reopened"/);
  } finally {
    fireClose();
  }
});

test("malformed or foreign bus payloads are dropped instead of forwarded", async () => {
  const handler = getHandler();
  const { res, chunks, fireClose } = fakeRes();
  await handler({ dashboardSession: "tok-draft-bad" }, res);
  try {
    for (const payload of [
      null,
      {},
      { draftId: "not a draft id", conversationKind: "contact", conversationId: 1 },
      { draftId: DRAFT_ID, conversationKind: "group", conversationId: 1 },
      { draftId: DRAFT_ID, conversationKind: "contact", conversationId: "seven" },
      { draftId: DRAFT_ID, conversationKind: "contact", conversationId: -3 },
      { conversationKind: "contact", conversationId: 1 },
    ]) {
      bus.emit(DRAFT_CHANGED_EVENT, payload);
    }
    assert.equal(chunks.join(""), "", "nothing reached the browser");
  } finally {
    fireClose();
  }
});

test("the stream stops listening once its connection closes", async () => {
  const handler = getHandler();
  const first = fakeRes();
  await handler({ dashboardSession: "tok-draft-close" }, first.res);
  first.fireClose();

  assert.equal(bus.listenerCount(DRAFT_CHANGED_EVENT), 0, "the handler was removed on close");
  bus.emit(DRAFT_CHANGED_EVENT, { draftId: DRAFT_ID, conversationKind: "contact", conversationId: 1, action: "create" });
  assert.equal(first.chunks.join(""), "", "and a closed stream writes nothing");
});

/* ------------------------------------------------------- the owner rule, for real */

const root = mkdtempSync(join(tmpdir(), "message-drafts-stream-"));
const OWNER = "stream-owner-session";
const SSO = "stream-peer-sso-session";

before(() => {
  mkdirSync(join(root, "data"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "data"), CROW_HOME: join(root, "home"), CROW_DB_PATH: "" },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const raw = new Database(join(root, "data", "crow.db"));
  const hash = (t) => createHash("sha256").update(t).digest("hex");
  const insert = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))");
  insert.run(hash(OWNER), "dashboard");
  insert.run(hash(SSO), "dashboard sso src:peer-1");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  process.env.CROW_DATA_DIR = join(root, "data");
  process.env.CROW_HOME = join(root, "home");
  process.env.CROW_DB_PATH = "";
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a peer's single-sign-on session gets 403 owner_only and opens no stream", async () => {
  const handler = getHandler(isLocalPasswordSessionOn);

  // The owner, from off-box: a stream opens and listens.
  const ownerRes = fakeRes();
  const ownerReq = markFromLaptop({ dashboardSession: OWNER });
  await handler(ownerReq, ownerRes.res);
  assert.notEqual(ownerRes.res.statusCode, 403, "the owner's own session is not refused");
  assert.equal(bus.listenerCount(DRAFT_CHANGED_EVENT), 1);
  ownerRes.fireClose();
  assert.equal(bus.listenerCount(DRAFT_CHANGED_EVENT), 0);

  // A peer's SSO session, from off-box: refused before any stream or bus handler exists.
  const ssoRes = fakeRes();
  await handler(markFromLaptop({ dashboardSession: SSO }), ssoRes.res);
  assert.equal(ssoRes.res.statusCode, 403);
  assert.deepEqual(ssoRes.res.body, { error: "owner_only", message: "Only the owner can see this." });
  assert.equal(ssoRes.chunks.join(""), "", "nothing was streamed");
  assert.equal(bus.listenerCount(DRAFT_CHANGED_EVENT), 0, "and no handler was left registered");
});