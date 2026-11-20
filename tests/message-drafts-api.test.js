// Crow Messages' draft routes (bot-door plan, PR A): the owner's own HTTP surface for a draft of a
// message to a conversation, under /dashboard/messages/api/drafts.
//
// Harness: tests/mail-drafts-api.test.js's — a real init-db'd scratch crow.db copied per test
// (CROW_DATA_DIR, so nothing can touch the real ~/.crow), an ephemeral express app wired the way
// servers/gateway/index.js and dashboard/index.js wire it (the global 1mb JSON parser skipped by
// index.js's own `_hasOwnParser` predicate, read from its source; then a session stub, the dashboard's
// real CSRF middleware, then the real router), the real store and the real seal, and the real owner
// rule with the request marked as coming from the owner's laptop (tests/helpers/off-box.js).
//
// What the test injects is the seam around the routes (`setMessagesDraftsRuntime`): a fixed clock, a
// fixed keychain seed, and — for the send tests — a recorder (the routes' transitions) plus, for the
// delivery itself, the factory seam the Messages tests already use for crow_send_message.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "message-drafts-api-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { createHash } = await import("node:crypto");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const {
  MESSAGES_DRAFTS_API_PREFIX,
  clearMessagesDraftsRuntime,
  messagesDraftsRouter,
  setMessagesDraftsRuntime,
} = await import("../servers/gateway/routes/messages-drafts-api.js");
const store = await import("../servers/gateway/messages/drafts-store.js");
const { sendDraftMessage } = await import("../servers/gateway/messages/drafts-send.js");
const { getRoomMessages } = await import("../servers/gateway/dashboard/panels/messages/rooms-store.js");
const bus = (await import("../servers/shared/event-bus.js")).default;

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";
const DRAFTS = MESSAGES_DRAFTS_API_PREFIX;
const SEED = Buffer.from("a fixed keychain seed for the draft routes");
const NOW = 1_767_225_600_000;

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

const open = [];
const servers = [];

after(() => {
  clearMessagesDraftsRuntime();
  for (const s of servers) s.close();
  for (const c of open) {
    try { c.close(); } catch { /* already closed */ }
  }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
  const raw = new Database(MASTER);
  const insert = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))");
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

beforeEach(() => {
  clearMessagesDraftsRuntime();
  bus.removeAllListeners(store.DRAFT_CHANGED_EVENT);
});

afterEach(() => {
  clearMessagesDraftsRuntime();
  bus.removeAllListeners(store.DRAFT_CHANGED_EVENT);
});

/* ------------------------------------------------------------------ plumbing */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let n = 0;

/** The scratch app: one per test, with the real router, the real CSRF rail and a recording sender. */
async function setup({ send } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const sent = [];
  setMessagesDraftsRuntime({
    loadSeed: async () => SEED,
    now: () => NOW,
    send: typeof send === "function"
      ? send
      : async (db, draft, text, deps) => {
        sent.push({ draftId: draft.id, text, deps });
        return { ok: true, messageId: "900" };
      },
  });

  const db = createDbClient(crow);
  open.push(db);

  const app = express();
  // servers/gateway/index.js's split, using the REAL predicate read from its source.
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  assert.ok(predicate, "index.js's _hasOwnParser is where it was");
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  const globalJson = expressJson({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));

  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const router = messagesDraftsRouter(sessionGate, { openDb: () => createDbClient(crow) });
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(router);
  app.use(dash);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const port = server.address().port;

  /** One request. `csrf: null` sends no CSRF header; `token: null` sends no session cookie. */
  const call = (method, path, { body, headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) => {
    const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = {
      ...(payload === null
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
    };
    if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
    if (token && csrf) h["x-crow-csrf"] = csrf;
    if (laptop) h["x-test-from"] = "laptop";
    Object.assign(h, headers);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* the CSRF refusal is plain text */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on("error", reject);
      req.end(payload === null ? undefined : payload);
    });
  };

  // One contact and one room, the two conversation kinds.
  const peerPubkey = "02" + "a".repeat(64);
  const contact = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:peer', 'Peer', ?, ?, 'crow')`,
    args: [peerPubkey, "e".repeat(64)],
  });
  const contactId = Number(contact.lastInsertRowid);
  const group = await db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES ('Den', ?, 'crow:me', 'addressed')",
    args: ["r".repeat(32)],
  });
  const roomId = Number(group.lastInsertRowid);
  await db.execute({
    sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
    args: [roomId, contactId],
  });

  /** The audience a draft for the contact is sealed with: the row, its crow id and its KEY. */
  const peerAudience = () => [{ contactId, crowId: "crow:peer", pubkey: peerPubkey }];

  return { db, crow, contactId, roomId, peerPubkey, peerAudience, sent, router, call };
}

/* -------------------------------------------------------------------- tests */

test("no session is refused before any route runs", async () => {
  const s = await setup();
  for (const [method, path, body] of [
    ["GET", DRAFTS, undefined],
    ["PUT", DRAFTS, { conversationKind: "contact", conversationId: 1, body: "hi", expectVersion: 0 }],
    ["POST", `${DRAFTS}/msgd-0123456789abcdef/send`, { body: "hi", expectVersion: 1 }],
  ]) {
    const res = await s.call(method, path, { body, token: null });
    assert.equal(res.status, 401, `${method} ${path}: ${res.text}`);
  }
});

test("a peer's single-sign-on session gets 403 owner_only on every route", async () => {
  const s = await setup();
  const created = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: 0 },
  });
  assert.equal(created.status, 201, created.text);
  const id = created.json.draft.id;

  for (const [method, path, body] of [
    ["GET", DRAFTS, undefined],
    ["GET", `${DRAFTS}/${id}`, undefined],
    ["PUT", DRAFTS, { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: 0 }],
    ["PATCH", `${DRAFTS}/${id}/body`, { body: "hi again", expectVersion: 1 }],
    ["POST", `${DRAFTS}/${id}/send`, { body: "hi", expectVersion: 1 }],
    ["POST", `${DRAFTS}/${id}/discard`, {}],
  ]) {
    const res = await s.call(method, path, { body, token: SSO });
    assert.equal(res.status, 403, `${method} ${path}: ${res.text}`);
    assert.equal(res.json?.error, "owner_only", `${method} ${path}`);
  }
  assert.equal((await store.getDraft(s.db, id)).state, "open", "nothing was changed by a refused session");
});

test("missing CSRF token is refused before any route runs", async () => {
  const s = await setup();
  const res = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: 0 },
    csrf: null,
  });
  assert.equal(res.status, 403, res.text);
  assert.match(res.text, /CSRF/);
  assert.equal((await store.listDrafts(s.db, {})).length, 0, "no draft was written");
});

test("cross-site fetch metadata is refused; a same-origin write is not", async () => {
  const s = await setup();
  const create = { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: 0 };

  const crossSite = await s.call("PUT", DRAFTS, { body: create, headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403, crossSite.text);
  assert.equal(crossSite.json?.error, "cross_site");

  const sameSiteOtherPort = await s.call("PUT", DRAFTS, { body: create, headers: { "sec-fetch-site": "same-site" } });
  assert.equal(sameSiteOtherPort.status, 403, "same-site from another origin is another origin");

  const foreignOrigin = await s.call("PUT", DRAFTS, {
    body: create,
    headers: { origin: "https://elsewhere.example" },
  });
  assert.equal(foreignOrigin.status, 403, foreignOrigin.text);
  assert.equal(foreignOrigin.json?.error, "cross_site");

  assert.equal((await store.listDrafts(s.db, {})).length, 0, "nothing was written by a refused write");

  // The owner's own page: `same-origin`, or a request with no fetch metadata at all (curl, a test).
  const own = await s.call("PUT", DRAFTS, { body: create, headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(own.status, 201, own.text);
  assert.equal(own.json.draft.body, "hi");
});

test("create/upsert, read and the conversation list — in the panel's own row shape", async () => {
  const s = await setup();
  const created = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "Are we still on?", expectVersion: 0 },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.created, true);
  assert.equal(created.json.label, "Peer");
  const draft = created.json.draft;
  assert.equal(draft.state, "open");
  assert.equal(draft.version, 1);
  assert.deepEqual(draft.recipients, s.peerAudience(), "the audience comes from the conversation, sealed with its key");

  // The conversation's open draft is what the card asks for — and it is a DISPLAY row, the same shape
  // the panel's server render draws. A live refresh feeds this straight into the row builder, so a
  // row without `kind`/`label` would draw blank and a room's id would open a contact thread.
  const list = await s.call("GET", `${DRAFTS}?conversation=contact:${s.contactId}`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.drafts.length, 1);
  const row = list.json.drafts[0];
  assert.equal(row.id, draft.id);
  assert.equal(row.kind, "contact", "the row names the conversation kind the click handler switches on");
  assert.equal(row.label, "Peer", "and the name a person reads");
  assert.equal(row.conversationId, s.contactId);
  assert.equal(row.body, "Are we still on?");
  assert.equal(row.preview, "Are we still on?");
  assert.equal(row.botName, null);
  assert.equal(row.version, 1);
  assert.equal(typeof row.updatedAt, "number");

  // A second create for the same conversation is refused, not an overwrite: someone else's words are
  // already there. The client adopts the row it is handed.
  const again = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "Are we still on for Sunday?", expectVersion: 0 },
  });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error, "changed");
  assert.equal(again.json.draft.id, draft.id);
  assert.equal(again.json.draft.body, "Are we still on?", "the stored words were not replaced");
  assert.equal(again.json.version, 1);

  // An upsert that names the version it was drawn from is the edit it says it is.
  const edited = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "Are we still on for Sunday?", expectVersion: 1 },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.created, false);
  assert.equal(edited.json.draft.id, draft.id);
  assert.equal(edited.json.draft.version, 2);

  const one = await s.call("GET", `${DRAFTS}/${draft.id}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.draft.body, "Are we still on for Sunday?");
  assert.deepEqual(one.json.audit.map((r) => r.action), ["create", "edit"]);
  assert.doesNotMatch(JSON.stringify(one.json.audit), /Are we still on/,
    "the audit trail never carries the message text");

  // A room is a conversation too; its row opens the ROOM, and its audience is its members.
  const room = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "room", conversationId: s.roomId, body: "Hello den", expectVersion: 0 },
  });
  assert.equal(room.status, 201, room.text);
  assert.deepEqual(room.json.draft.recipients, s.peerAudience());
  const roomRow = (await s.call("GET", `${DRAFTS}?conversation=room:${s.roomId}`)).json.drafts[0];
  assert.equal(roomRow.kind, "room", "a room draft's row says so, so it opens the room");
  assert.equal(roomRow.label, "Den");
  assert.equal(roomRow.conversationId, s.roomId);

  assert.equal((await s.call("GET", `${DRAFTS}?state=all`)).json.drafts.length, 2);
  assert.equal((await s.call("GET", `${DRAFTS}/${"msgd-" + "0".repeat(16)}`)).status, 404);
});

test("the create takes no origin: the owner route never writes a bot's draft", async () => {
  const s = await setup();
  for (const extra of [{ origin: "bot" }, { origin: "bot", botId: "hank" }, { botId: "hank" }]) {
    const res = await s.call("PUT", DRAFTS, {
      body: { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: 0, ...extra },
    });
    assert.equal(res.status, 400, `${JSON.stringify(extra)}: ${res.text}`);
    assert.equal(res.json.error, "bad_input");
  }
  assert.equal((await store.listDrafts(s.db, {})).length, 0, "nothing was written");
});

test("the create requires the version it was drawn from (0 = create only)", async () => {
  const s = await setup();
  for (const body of [
    { conversationKind: "contact", conversationId: s.contactId, body: "hi" },
    { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: -1 },
    { conversationKind: "contact", conversationId: s.contactId, body: "hi", expectVersion: "1" },
  ]) {
    const res = await s.call("PUT", DRAFTS, { body });
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
  }
  assert.equal((await store.listDrafts(s.db, {})).length, 0);
});

test("autosave is a compare-and-set; a stale version answers 409 with the current one", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "draft one", expectVersion: 0 },
  });
  const id = json.draft.id;

  const saved = await s.call("PATCH", `${DRAFTS}/${id}/body`, { body: { body: "draft two", expectVersion: 1 } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.draft.version, 2);

  const stale = await s.call("PATCH", `${DRAFTS}/${id}/body`, { body: { body: "draft three", expectVersion: 1 } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, "changed");
  assert.equal(stale.json.version, 2, "the answer carries the version to redraw from");
  assert.equal(stale.json.draft.body, "draft two");

  // The autosave's body shape is not negotiable: both fields, and no others.
  const noVersion = await s.call("PATCH", `${DRAFTS}/${id}/body`, { body: { body: "x" } });
  assert.equal(noVersion.status, 400, noVersion.text);
  const extraKey = await s.call("PATCH", `${DRAFTS}/${id}/body`, {
    body: { body: "x", expectVersion: 2, origin: "bot" },
  });
  assert.equal(extraKey.status, 400, extraKey.text);
  assert.equal((await store.getDraft(s.db, id)).body, "draft two");
});

test("send posts the exact text through the send path and closes the draft", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "written earlier", expectVersion: 0 },
  });
  const id = json.draft.id;
  const text = "  Exactly these words, with their spaces  ";

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: text, expectVersion: 1 } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.draft.state, "sent");
  assert.equal(res.json.draft.sentMessageId, "900");

  assert.equal(s.sent.length, 1, "the delivery went out once");
  assert.equal(s.sent[0].text, text, "the text is sent exactly as posted");
  assert.doesNotMatch(s.sent[0].text, /Sent by/i, "nothing is appended to an owner's message");

  assert.deepEqual((await store.listAudit(s.db, id)).map((row) => row.action), ["create", "send"]);

  // A second tap finds the draft closed.
  const again = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: text, expectVersion: 2 } });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error, "not_open");
  assert.equal(s.sent.length, 1, "and sends nothing a second time");
});

test("a stale send is 409 changed and sends nothing", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "one", expectVersion: 0 },
  });
  const id = json.draft.id;
  await s.call("PATCH", `${DRAFTS}/${id}/body`, { body: { body: "two", expectVersion: 1 } });

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "two", expectVersion: 1 } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, "changed");
  assert.equal(res.json.version, 2);
  assert.equal(s.sent.length, 0, "nothing was delivered");
  assert.equal((await store.getDraft(s.db, id)).state, "open", "and the draft is untouched");
});

test("a seal this instance did not write blocks the send", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "hello", expectVersion: 0 },
  });
  const id = json.draft.id;

  // A writer with database access re-points the draft's audience and leaves the seal alone.
  await s.db.execute({
    sql: "UPDATE message_drafts SET recipients_json = ? WHERE id = ?",
    args: [JSON.stringify([{ contact_id: 999, crow_id: "crow:somebody-else", secp256k1_pubkey: "02" + "f".repeat(64) }]), id],
  });

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "hello", expectVersion: 1 } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, "seal_invalid");
  assert.equal(res.json.draft.id, id, "the refusal carries the row, so the card can show it and offer Discard");
  assert.equal(res.json.version, 1);
  assert.equal(s.sent.length, 0, "a draft whose seal does not verify is never delivered");
  assert.equal((await store.getDraft(s.db, id)).state, "open");
});

test("a recipient whose key changed since the draft was written is refused", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "hello", expectVersion: 0 },
  });
  const id = json.draft.id;
  assert.deepEqual(json.draft.recipients, s.peerAudience(), "the draft snapped the contact's key");

  // The contact's key is replaced (a re-key, a re-invite, somebody else entirely).
  await s.db.execute({
    sql: "UPDATE contacts SET secp256k1_pubkey = ? WHERE id = ?",
    args: ["02" + "9".repeat(64), s.contactId],
  });

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "hello", expectVersion: 1 } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, "pubkey_changed");
  assert.equal(res.json.draft.id, id);
  assert.equal(s.sent.length, 0, "the message was not delivered to a key the draft did not name");
  assert.equal((await store.getDraft(s.db, id)).state, "open", "and the words are still there");
});

test("a blocked recipient is refused", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "hello", expectVersion: 0 },
  });
  const id = json.draft.id;
  await s.db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [s.contactId] });

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "hello", expectVersion: 1 } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, "blocked");
  assert.equal(s.sent.length, 0);
  assert.equal((await store.getDraft(s.db, id)).state, "open");
});

test("a delivery that does not land answers 502 WITH the reopened draft and its version", async () => {
  const s = await setup({
    send: async () => ({ ok: false, reason: "delivery_failed" }),
  });
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "keep trying", expectVersion: 0 },
  });
  const id = json.draft.id;

  const failed = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "keep trying", expectVersion: 1 } });
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.json.error, "delivery_failed");
  assert.equal(failed.json.draft.id, id);
  assert.equal(failed.json.draft.state, "open", "the failed send put the draft back");
  assert.equal(failed.json.version, 2, "and the answer says which version to retry from");

  // The retry the client makes with THAT version is accepted — not a 409 against a stale one.
  const retry = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "keep trying", expectVersion: failed.json.version } });
  assert.equal(retry.status, 502, "the recorder still fails, but the version was accepted");
  assert.equal(retry.json.version, 3);
});

test("a delivery that lands on a row somebody moved on is closed as sent, with a `sent-late` audit row", async () => {
  // The boot pass in another gateway sharing this crow.db saw a `sending` row whose sender it thought
  // was gone and reopened it while this send was still in flight. The message went out regardless.
  const s = await setup({
    send: async (db, draft) => {
      await db.execute({
        sql: "UPDATE message_drafts SET state = 'open', fail_reason = 'send_interrupted' WHERE id = ? AND state = 'sending'",
        args: [draft.id],
      });
      return { ok: true, messageId: "901" };
    },
  });
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "already gone out", expectVersion: 0 },
  });
  const id = json.draft.id;

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "already gone out", expectVersion: 1 } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true, "the delivery did land, whatever the row said");
  assert.equal(res.json.draft.state, "sent");

  const row = await store.getDraft(s.db, id);
  assert.equal(row.state, "sent", "the draft is not left open holding text that already went out");
  assert.equal(row.sentMessageId, "901", "and it carries the transport's own id");
  assert.equal(row.failReason, null);
  assert.deepEqual((await store.listAudit(s.db, id)).map((r) => [r.action, r.actor]),
    [["create", "owner"], ["send", "owner"], ["sent-late", "system"]],
    "a reader can explain why a row nobody tapped is closed");

  // There is no open draft left to tap again: the double send cannot happen.
  const again = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "already gone out", expectVersion: 1 } });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error, "not_open");
});

test("a room whose membership changed since the draft was written blocks the send", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "room", conversationId: s.roomId, body: "Hello den", expectVersion: 0 },
  });
  const id = json.draft.id;
  assert.deepEqual(json.draft.recipients, s.peerAudience());

  const other = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:late', 'Late', ?, ?, 'crow')`,
    args: ["02" + "b".repeat(64), "f".repeat(64)],
  });
  await s.db.execute({
    sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
    args: [s.roomId, Number(other.lastInsertRowid)],
  });

  const res = await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "Hello den", expectVersion: 1 } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, "recipients_changed");
  assert.equal(s.sent.length, 0);
  assert.equal((await store.getDraft(s.db, id)).state, "open");
});

test("discard closes the draft; a second discard is 409 not_open", async () => {
  const s = await setup();
  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "never mind", expectVersion: 0 },
  });
  const id = json.draft.id;

  const discarded = await s.call("POST", `${DRAFTS}/${id}/discard`, { body: {} });
  assert.equal(discarded.status, 200, discarded.text);
  assert.equal(discarded.json.draft.state, "discarded");

  const again = await s.call("POST", `${DRAFTS}/${id}/discard`, { body: {} });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error, "not_open");

  // The conversation is free for a new draft.
  const fresh = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "new plan", expectVersion: 0 },
  });
  assert.equal(fresh.status, 201, fresh.text);
});

test("every write pokes message-drafts:changed with ids only", async () => {
  const s = await setup();
  const seen = [];
  bus.on(store.DRAFT_CHANGED_EVENT, (payload) => seen.push(payload));

  const { json } = await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "the words", expectVersion: 0 },
  });
  const id = json.draft.id;
  await s.call("PATCH", `${DRAFTS}/${id}/body`, { body: { body: "the words again", expectVersion: 1 } });
  await s.call("POST", `${DRAFTS}/${id}/send`, { body: { body: "the words again", expectVersion: 2 } });
  await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "a second draft", expectVersion: 0 },
  });
  const second = (await s.call("GET", `${DRAFTS}?conversation=contact:${s.contactId}`)).json.drafts[0];
  await s.call("POST", `${DRAFTS}/${second.id}/discard`, { body: {} });

  assert.deepEqual(seen.map((p) => p.action), ["create", "edit", "send", "send", "create", "discard"]);
  for (const payload of seen) {
    assert.deepEqual(Object.keys(payload).sort(),
      ["action", "conversationId", "conversationKind", "draftId"],
      "ids and the action word only");
  }
  assert.doesNotMatch(JSON.stringify(seen), /the words/, "no message text rides the live channel");
});

test("a body over the route's cap is 413 and malformed JSON is 400", async () => {
  const s = await setup();
  const big = { conversationKind: "contact", conversationId: s.contactId, body: "x".repeat(70_000), expectVersion: 0 };
  const tooLarge = await s.call("PUT", DRAFTS, { body: big });
  assert.equal(tooLarge.status, 413, tooLarge.text);
  assert.equal(tooLarge.json.error, "too_large");

  const malformed = await s.call("PUT", DRAFTS, { body: "{ not json" });
  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(malformed.json.error, "bad_input");
  assert.equal((await store.listDrafts(s.db, {})).length, 0);
});

/* ------------------------------------------------- against the existing send paths */

test("the contact send is the peer send path: crow_send_message gets the exact text", async () => {
  const s = await setup();
  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "written", expectVersion: 0 },
  })).json.draft;

  const calls = [];
  const sharingClientFactory = async () => ({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "Message delivered to Peer via 1 relay(s)." }] };
    },
    close: async () => {},
  });

  const text = "Exactly these words";
  const result = await sendDraftMessage(s.db, draft, text, { sharingClientFactory });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "crow_send_message", "the existing Messages send tool is the one used");
  assert.equal(calls[0].args.message, text, "and it carries the draft's text, exactly");
  // The draft send names the contact by its UNIQUE CROW ID, never by a display name: the row it just
  // verified by primary key is the only row this tool is allowed to find (see the redirect test below).
  assert.equal(calls[0].args.contact, "crow:peer", "the verified row's crow id, not a name");
});

/**
 * The sharing server's REAL `crow_send_message` handler, captured off a stub MCP server, delivering
 * through a recorder. Used where a test is about WHICH CONTACT the tool resolves to: a stub that just
 * records the argument cannot tell an exact lookup from one that a display name hijacked.
 */
async function realSendTool({ db, onSend }) {
  const { registerMessagingTools } = await import("../servers/sharing/tools/messaging.js");
  let captured = null;
  registerMessagingTools({
    tool: (name, description, schema, handler) => { if (name === "crow_send_message") captured = handler; },
  }, {
    db,
    identity: { crowId: "crow:me", displayName: "Me" },
    nostrManager: {
      sendMessage: async (row, text) => {
        onSend({ row, text });
        return { relays: ["wss://relay.invalid"] };
      },
    },
  });
  assert.ok(captured, "the sharing server's send tool was captured");
  return captured;
}

/** A sharing MCP client whose `crow_send_message` call runs the real tool handler above. */
function realToolClient(handler, calls = []) {
  return async () => ({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return handler({ contact: args.contact, message: args.message });
    },
    close: async () => {},
  });
}

const PUBKEY_A = "02" + "a".repeat(64);

// SECURITY (delivery integrity): a send path that resolves its destination by a NAME can land on a
// row the draft never checked — here, a contact whose display name IS the real recipient's crow id.
test("a contact whose display name is another contact's crow id cannot redirect a draft send", async () => {
  const s = await setup();
  // The address book as it can actually look: the impostor is FIRST, and the real recipient answers
  // to the crow id the impostor's display name spells.
  await s.db.execute({ sql: "DELETE FROM contact_group_members" });
  await s.db.execute({ sql: "DELETE FROM contacts" });
  const fake = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:impostor', 'crow:peer', ?, ?, 'crow')`,
    args: ["02" + "c".repeat(64), "d".repeat(64)],
  });
  const fakeId = Number(fake.lastInsertRowid);
  const real = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:peer', 'Peer', ?, ?, 'crow')`,
    args: [PUBKEY_A, "e".repeat(64)],
  });
  const realId = Number(real.lastInsertRowid);

  // The trap, shown: an identifier-only lookup with the recipient's crow id lands on the impostor.
  const naive = await s.db.execute({
    sql: "SELECT id FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0 ORDER BY id ASC",
    args: ["crow:peer", "crow:peer"],
  });
  assert.equal(Number(naive.rows[0].id), fakeId, "a name-blind lookup really does resolve to the impostor");

  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: realId, body: "for Peer only", expectVersion: 0 },
  })).json.draft;
  assert.deepEqual(draft.recipients, [{ contactId: realId, crowId: "crow:peer", pubkey: PUBKEY_A }],
    "the draft sealed the real row and its key");

  const delivered = [];
  const handler = await realSendTool({ db: s.db, onSend: (x) => delivered.push(x) });
  const result = await sendDraftMessage(s.db, draft, "for Peer only", {
    sharingClientFactory: realToolClient(handler),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(delivered.length, 1, "delivered once");
  assert.equal(Number(delivered[0].row.id), realId, "to the contact the draft was sealed for");
  assert.equal(String(delivered[0].row.crow_id), "crow:peer");
  assert.equal(String(delivered[0].row.secp256k1_pubkey), PUBKEY_A, "and to that row's key");
});

// SECURITY (delivery integrity, the LAST window): the sealed row is re-read by primary id immediately
// before the handoff — and the tool then resolves its destination by name once more. This test moves
// the address book INSIDE that window (the real row's crow id replaced, an impostor's display name
// made to spell it) and the send must STILL refuse: the sealed row travels into the tool as an
// internal guard — carried on the sharing server's construction options, never as a tool argument —
// so the tool's own lookup cannot land on another row. Without the guard this send reaches the
// impostor (the test is the pin on that).
test("a row moved between the check and the tool's own lookup cannot receive the draft", async () => {
  const s = await setup();
  await s.db.execute({ sql: "DELETE FROM contact_group_members" });
  await s.db.execute({ sql: "DELETE FROM contacts" });
  const fake = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:impostor', 'nothing yet', ?, ?, 'crow')`,
    args: ["02" + "c".repeat(64), "d".repeat(64)],
  });
  const fakeId = Number(fake.lastInsertRowid);
  const real = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:peer', 'Peer', ?, ?, 'crow')`,
    args: [PUBKEY_A, "e".repeat(64)],
  });
  const realId = Number(real.lastInsertRowid);

  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: realId, body: "for Peer only", expectVersion: 0 },
  })).json.draft;
  assert.deepEqual(draft.recipients, [{ contactId: realId, crowId: "crow:peer", pubkey: PUBKEY_A }]);

  const delivered = [];
  const { registerMessagingTools } = await import("../servers/sharing/tools/messaging.js");

  /**
   * The production factory's shape: the guard arrives in the FACTORY's options (the sharing server's
   * construction options) and is handed to the tool's ctx. The tool ARGUMENT is still just the
   * identifier and the text, so nothing on the MCP surface can set or weaken it.
   */
  const factory = async (options = {}) => {
    let handler = null;
    registerMessagingTools(
      { tool: (name, _desc, _schema, h) => { if (name === "crow_send_message") handler = h; } },
      {
        db: s.db,
        identity: { crowId: "crow:me", displayName: "Me" },
        nostrManager: {
          sendMessage: async (row, text) => {
            delivered.push({ id: Number(row.id), text });
            return { relays: ["wss://relay.invalid"] };
          },
        },
        ...(options.internalSendGuard ? { internalSendGuard: options.internalSendGuard } : {}),
      },
    );
    assert.ok(handler, "the sharing server's send tool was captured");
    return {
      callTool: async ({ arguments: args }) => {
        // THE WINDOW: between handlePeerSend's primary-key read and the tool's own SELECT.
        await s.db.execute({ sql: "UPDATE contacts SET crow_id = 'crow:moved' WHERE id = ?", args: [realId] });
        await s.db.execute({ sql: "UPDATE contacts SET display_name = 'crow:peer' WHERE id = ?", args: [fakeId] });
        return handler({ contact: args.contact, message: args.message });
      },
      close: async () => {},
    };
  };

  const result = await sendDraftMessage(s.db, draft, "for Peer only", { sharingClientFactory: factory });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "recipients_changed", "the tool refused, and that refusal reached the send path");
  assert.deepEqual(delivered, [], "the impostor received nothing");
  assert.equal((await store.getDraft(s.db, draft.id)).state, "open", "and the words are still there to send again");
});

// SECURITY (delivery integrity): the row a draft sealed is re-read by primary id immediately before
// the handoff, so a key or an identity that moved in the window between check and send is refused
// and NOTHING is handed to the sharing tool.
test("a recipient re-keyed or re-pointed between the check and the send is refused before handoff", async () => {
  const s = await setup();
  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "contact", conversationId: s.contactId, body: "hello", expectVersion: 0 },
  })).json.draft;

  const calls = [];
  const stub = async () => ({
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { content: [{ type: "text", text: "delivered" }] }; },
    close: async () => {},
  });

  // The same person, a different key: a re-invite, a peer re-install, somebody else entirely.
  await s.db.execute({
    sql: "UPDATE contacts SET secp256k1_pubkey = ? WHERE id = ?",
    args: ["02" + "9".repeat(64), s.contactId],
  });
  const rekeyed = await sendDraftMessage(s.db, draft, "hello", { sharingClientFactory: stub });
  assert.equal(rekeyed.ok, false);
  assert.equal(rekeyed.reason, "pubkey_changed");
  assert.equal(calls.length, 0, "nothing was handed to the sharing tool");

  // The key back, the crow id replaced: the row is not the person the draft sealed.
  await s.db.execute({ sql: "UPDATE contacts SET secp256k1_pubkey = ? WHERE id = ?", args: [s.peerPubkey, s.contactId] });
  await s.db.execute({ sql: "UPDATE contacts SET crow_id = ? WHERE id = ?", args: ["crow:replaced", s.contactId] });
  const repointed = await sendDraftMessage(s.db, draft, "hello", { sharingClientFactory: stub });
  assert.equal(repointed.ok, false);
  assert.equal(repointed.reason, "recipients_changed");
  assert.equal(calls.length, 0, "still nothing handed off");
});

test("a handoff refusal answers 409 with its own code and the reopened draft", async () => {
  for (const reason of ["pubkey_changed", "recipients_changed", "blocked"]) {
    const s = await setup({ send: async () => ({ ok: false, reason }) });
    const { json } = await s.call("PUT", DRAFTS, {
      body: { conversationKind: "contact", conversationId: s.contactId, body: "hello", expectVersion: 0 },
    });
    const res = await s.call("POST", `${DRAFTS}/${json.draft.id}/send`, { body: { body: "hello", expectVersion: 1 } });
    assert.equal(res.status, 409, `${reason}: ${res.text}`);
    assert.equal(res.json.error, reason, "its own code, not delivery_failed");
    assert.equal(res.json.draft.state, "open", "and the words are still there to fix");
  }
});

test("a room member re-keyed or added between the check and the send is refused, and nothing is stored", async () => {
  const s = await setup();
  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "room", conversationId: s.roomId, body: "Hello den", expectVersion: 0 },
  })).json.draft;

  await s.db.execute({
    sql: "UPDATE contacts SET secp256k1_pubkey = ? WHERE id = ?",
    args: ["02" + "9".repeat(64), s.contactId],
  });
  const rekeyed = await sendDraftMessage(s.db, draft, "Hello den", { managers: null });
  assert.equal(rekeyed.ok, false);
  assert.equal(rekeyed.reason, "pubkey_changed");
  assert.equal((await getRoomMessages(s.db, s.roomId)).length, 0, "the refusal is before the write");

  await s.db.execute({ sql: "UPDATE contacts SET secp256k1_pubkey = ? WHERE id = ?", args: [s.peerPubkey, s.contactId] });
  const other = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES ('crow:late', 'Late', ?, ?, 'crow')`,
    args: ["02" + "b".repeat(64), "f".repeat(64)],
  });
  await s.db.execute({
    sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
    args: [s.roomId, Number(other.lastInsertRowid)],
  });
  const widened = await sendDraftMessage(s.db, draft, "Hello den", { managers: null });
  assert.equal(widened.ok, false);
  assert.equal(widened.reason, "recipients_changed");
  assert.equal((await getRoomMessages(s.db, s.roomId)).length, 0, "still nothing stored");
});

// A member BLOCKED after the draft was written drops out of `listRoomMembers` (that is the list the
// room panel draws and the fan-out uses), so the audience is not the sealed one: the answer is
// `recipients_changed`, NOT `blocked` — which is the blocked answer only a 1:1 contact gives, because
// a contact is looked up by id whatever its state.
test("a room member blocked between the check and the send answers recipients_changed, not blocked", async () => {
  const s = await setup();
  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "room", conversationId: s.roomId, body: "Hello den", expectVersion: 0 },
  })).json.draft;
  assert.deepEqual(draft.recipients, s.peerAudience(), "the draft sealed the member and its key");

  await s.db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [s.contactId] });
  const result = await sendDraftMessage(s.db, draft, "Hello den", { managers: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "recipients_changed", "the blocked member is simply not in the live set");
  assert.equal((await getRoomMessages(s.db, s.roomId)).length, 0, "nothing was stored or fanned out");
});

test("the room send is the room send path and stores the exact text", async () => {
  const s = await setup();
  const draft = (await s.call("PUT", DRAFTS, {
    body: { conversationKind: "room", conversationId: s.roomId, body: "written", expectVersion: 0 },
  })).json.draft;

  const text = "Hello den, exactly this";
  const result = await sendDraftMessage(s.db, draft, text, { managers: null });
  assert.equal(result.ok, true, JSON.stringify(result));

  const rows = await getRoomMessages(s.db, s.roomId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, text, "the room row holds the text as posted");
  assert.equal(rows[0].direction, "sent");
  assert.equal(rows[0].author_kind, "human", "an owner's draft is the owner's message");
});