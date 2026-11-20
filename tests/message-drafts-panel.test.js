/**
 * message-drafts-panel — PR A part 2: the Messages UI on top of the saved-draft store.
 *
 * Four layers, each one a thing the page actually does:
 *
 *   (a) RENDER — `buildMessagesHTML` draws the Drafts section above the hub: the count, one row per
 *       open draft (recipient, one-line preview, the "by <bot>" chip, when it changed), Send and
 *       Discard per row, an empty line when there is none, and the one Discard confirmation both
 *       places share. Everything escaped; a draft's text never lands in an attribute.
 *   (b) PANEL — the REAL panel handler against a real init-db'd crow.db, so the Drafts section is
 *       proven to be fed by the store (a bot draft's name looked up from `pi_bot_defs` server-side)
 *       rather than by the test — and proven to be drawn for the OWNER only: the panel applies the
 *       drafts API's own rule (`isLocalPasswordSessionOn`), so a peer's single-sign-on session gets
 *       no section, no rows, no preview and no `msg-drafts-data` block while the owner's page has
 *       all of them.
 *   (c) ROUTE — the drafts API answers `botName` for a bot's draft (and falls back to the bot id when
 *       the definition is gone), which is what the composer's banner reads.
 *   (d) BEHAVIOUR — the real client (messagesClientJS) executed over the real markup with linkedom +
 *       node:vm (tests/messages-first-run-ux.test.js's harness): prefill from the open draft, the
 *       debounced autosave with `expectVersion`, 409 → "changed elsewhere" + Reload, Send → receipt,
 *       Discard with the confirm (Escape closes it and focus returns), and the live `crow-draft`
 *       frame re-reading the row.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { fromLaptop } from "./helpers/off-box.js";

const dir = mkdtempSync(join(tmpdir(), "message-drafts-panel-"));
process.env.CROW_DATA_DIR = dir;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const SEED = Buffer.from("a fixed keychain seed for the drafts panel");
const NOW = 1_767_225_600_000;
// The two sessions the drafts API tells apart, inserted for real: this machine's own password login
// (`scopes: "dashboard"`) and a peer sign-in on this machine (`scopes: "dashboard sso ..."`). The
// panel runs the REAL owner rule (the drafts API's own `isLocalPasswordSessionOn`), so these are what
// decide whether the Drafts section is rendered at all.
const OWNER = "drafts-panel-owner-session";
const SSO = "drafts-panel-sso-session";
const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

let db = null;
let panel = null;
let buildMessagesHTML = null;
let messagesClientJS = null;
let store = null;
let t = null;
let fill = null;
const servers = [];

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  for (const [token, scopes] of [[OWNER, "dashboard"], [SSO, "dashboard sso src:peer-1"]]) {
    await db.execute({
      sql: `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at)
            VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))`,
      args: [hashToken(token), scopes],
    });
  }
  ({ default: panel } = await import("../servers/gateway/dashboard/panels/messages.js"));
  ({ buildMessagesHTML } = await import("../servers/gateway/dashboard/panels/messages/html.js"));
  ({ messagesClientJS } = await import("../servers/gateway/dashboard/panels/messages/client.js"));
  store = await import("../servers/gateway/messages/drafts-store.js");
  ({ t, fill } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); } catch {} try { s.close(); } catch {} }
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of ["message_drafts", "message_draft_audit", "messages", "contact_group_members",
    "contact_groups", "contacts", "pi_bot_defs", "providers", "dashboard_settings"]) {
    try { await db.execute(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

let seq = 0;
/** The pubkey mkContact gives a contact id (so a draft's snapshot matches the row it names). */
const pubkeyFor = (id) => "02" + String(id).padStart(2, "0") + "a".repeat(62);

async function mkContact({ name = "Peer", crowId = null, bot = null } = {}) {
  const id = ++seq;
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES (?, ?, ?, ?, ?, 'crow')`,
    args: [id, crowId || `crow:peer${id}`, name, pubkeyFor(id), "e".repeat(64)],
  });
  return id;
}

async function mkGroup(name = "Den") {
  const r = await db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES (?, ?, 'crow:me', 'addressed')",
    args: [name, "r".repeat(32)],
  });
  return Number(r.lastInsertRowid);
}

async function mkDraft({ contactId, body = "hello there", origin = "owner", botId = null, botName = null, version = 1 }) {
  const draft = await store.createDraft(db, {
    conversationKind: "contact",
    conversationId: contactId,
    body,
    recipients: [{ contactId, crowId: `crow:peer${contactId}`, pubkey: pubkeyFor(contactId) }],
    origin,
    botId,
    botName,
  }, { loadSeed: async () => SEED, now: NOW });
  assert.equal(draft.ok, true, "the store made the draft");
  if (version > 1) {
    await db.execute({ sql: "UPDATE message_drafts SET version = ? WHERE id = ?", args: [version, draft.draft.id] });
  }
  return { ...draft.draft, version: Math.max(version, draft.draft.version) };
}

async function mkBotDef(botId, displayName) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, '{}', 1)",
    args: [botId, displayName],
  });
}

/* ------------------------------------------------------------------ (a) RENDER */

function htmlOpts(overrides = {}) {
  return {
    items: [{ type: "peer", id: 3, displayName: "Peer", crowId: "crow:peer3", isBot: false, unread: 0 }],
    totalUnread: 0,
    aiConfigured: false,
    storageAvailable: false,
    inviteResult: null,
    inviteError: null,
    lang: "en",
    botInvite: null,
    botDirectory: { groups: [], total: 0, notAddedCount: 0 },
    requests: [],
    drafts: [],
    draftsOwner: true,
    csrf: "",
    inviteShare: null,
    personInvite: null,
    shortCodeShare: null,
    ...overrides,
  };
}

const DRAFT_ROW = (over = {}) => ({
  id: "msgd-" + "a".repeat(32),
  kind: "contact",
  conversationId: 3,
  label: "Peer",
  body: "Are we still on for Sunday?",
  preview: "Are we still on for Sunday?",
  origin: "owner",
  botId: null,
  botName: null,
  version: 4,
  updatedAt: Date.now() - 5 * 60_000,
  ...over,
});

test("the Drafts section renders above the hub, with its count, its rows and the empty line", () => {
  const html = buildMessagesHTML(htmlOpts({ drafts: [DRAFT_ROW()] }));
  assert.ok(html.includes('id="msg-drafts"'), "the section has its stable id");
  assert.ok(html.includes('id="msg-drafts-list"'), "the rows container has its stable id");
  assert.ok(
    html.indexOf('id="msg-drafts"') < html.indexOf('class="msg-hub"'),
    "the Drafts section comes before the conversation hub",
  );
  const count = html.match(/<span id="msg-drafts-count">([^<]*)<\/span>/);
  assert.ok(count, "the count element is rendered");
  assert.equal(count[1], fill(t("messages.draft.draftsHeading", "en"), { n: 1 }));
  assert.equal(count[1], "Drafts (1)");
  assert.ok(html.includes('class="msg-drafts-name">Peer<'), "the recipient's name is the row title");
  assert.ok(html.includes('class="msg-drafts-preview">Are we still on for Sunday?<'), "the body preview is drawn");
  assert.ok(html.includes('data-draft-id="msgd-' + "a".repeat(32) + '"'), "the row names its draft");
  assert.ok(html.includes('data-kind="contact"') && html.includes('data-conversation-id="3"'), "the row names its conversation");
  assert.ok(html.includes('class="msg-draft-send"'), "the row can send without opening the thread");
  assert.ok(html.includes('class="msg-draft-discard"'), "the row can discard without opening the thread");
  assert.match(html, /class="msg-drafts-time">5m ago</, "how long ago the draft changed");
  assert.ok(!html.includes('class="msg-drafts-by"'), "an owner's draft carries no bot chip");
  assert.ok(html.includes('id="msg-drafts" data-count="1" open'), "the list is open when there is something in it");
});

test("a bot draft's row carries the by-<bot> chip, and the text is escaped, not markup", () => {
  const html = buildMessagesHTML(htmlOpts({
    drafts: [DRAFT_ROW({
      id: "msgd-" + "b".repeat(32),
      label: "Peer <b>",
      body: "<img src=x onerror=alert(1)> hello",
      preview: "<img src=x onerror=alert(1)> hello",
      origin: "bot",
      botId: "hank",
      botName: "Hank",
    })],
  }));
  assert.ok(html.includes("by Hank"), "the chip names the bot");
  assert.ok(!html.includes("<img src=x"), "a draft's text is never markup");
  assert.ok(html.includes("&lt;img src=x"), "it is escaped");
  assert.ok(!html.includes("Peer <b>"), "the recipient name is escaped too");
});

test("no drafts: the section still renders, closed, with the empty line", () => {
  const html = buildMessagesHTML(htmlOpts());
  assert.ok(html.includes('id="msg-drafts"'));
  assert.ok(!html.includes('id="msg-drafts" data-count="0" open'), "nothing to show: the section starts folded");
  assert.ok(html.includes('id="msg-drafts-empty"'));
  assert.ok(html.includes(t("messages.draft.draftsEmpty", "en")));
  assert.match(html, /<span id="msg-drafts-count">Drafts \(0\)<\/span>/);
});

test("the Discard confirmation is one hidden dialog, with Cancel and Discard, for both places", () => {
  const html = buildMessagesHTML(htmlOpts());
  assert.ok(html.includes('id="msg-draft-confirm" hidden'), "the dialog starts hidden");
  assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'), "it is announced as a modal dialog");
  assert.ok(html.includes(t("messages.draft.discardConfirm", "en")), "the approved confirmation copy");
  assert.ok(html.includes('id="msg-draft-confirm-cancel"'), "a way out");
  assert.ok(html.includes('id="msg-draft-confirm-yes"'), "and the confirmation");
});

test("Spanish renders the approved copy for the section and the confirm", () => {
  const html = buildMessagesHTML(htmlOpts({
    lang: "es",
    drafts: [DRAFT_ROW({ origin: "bot", botId: "hank", botName: "Hank" })],
  }));
  assert.ok(html.includes("Borradores (1)"), "the heading");
  assert.ok(html.includes("de Hank"), "the chip");
  assert.ok(html.includes(t("messages.draft.discardConfirm", "es")), "the confirmation");
  const empty = buildMessagesHTML(htmlOpts({ lang: "es" }));
  assert.ok(empty.includes("No hay borradores guardados"), "the empty line");
});

/* ------------------------------------------------------------------ (b) PANEL */

async function renderPanel(lang = "en", { token = OWNER } = {}) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {}, headersSent: false };
  // From the owner's own laptop: the owner rule refuses a request that starts on this machine, and a
  // test's in-process request is from loopback.
  const req = fromLaptop({ method: "GET", query: {}, headers: {}, dashboardSession: token });
  const out = await panel.handler(req, res, { db, lang, layout });
  return typeof out === "string" ? out : captured;
}

test("the real panel handler feeds the section from the store, naming a bot server-side", async () => {
  const contactId = await mkContact({ name: "Yvonne", crowId: "crow:yvonne" });
  await mkBotDef("hank", "Hank");
  await mkDraft({ contactId, body: "Draft from the door", origin: "bot", botId: "hank" });

  const html = await renderPanel();
  assert.ok(html.includes('id="msg-drafts"'), "the section rendered");
  assert.match(html, /<span id="msg-drafts-count">Drafts \(1\)<\/span>/);
  assert.ok(html.includes('class="msg-drafts-name">Yvonne<'), "the recipient is the live contact's name");
  assert.ok(html.includes("Draft from the door"), "the preview is the stored text");
  assert.ok(html.includes("by Hank"), "the bot is named by its definition's display name, not its id");
  assert.ok(!html.includes("by hank"), "the id itself is not what a person reads");

  const data = html.match(/<script id="msg-drafts-data" type="application\/json">([^<]*)<\/script>/);
  assert.ok(data, "the panel embeds the rows for the client's live redraw");
  const rows = JSON.parse(data[1]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].botName, "Hank");
  assert.equal(rows[0].label, "Yvonne");
});

test("a room draft is listed under its room's name", async () => {
  const contactId = await mkContact({ name: "Yvonne", crowId: "crow:yvonne" });
  const groupId = await mkGroup("The Den");
  await db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)", args: [groupId, contactId] });
  await store.createDraft(db, {
    conversationKind: "room",
    conversationId: groupId,
    body: "Hello den",
    recipients: [{ contactId, crowId: "crow:yvonne", pubkey: pubkeyFor(contactId) }],
  }, { loadSeed: async () => SEED, now: NOW });

  const html = await renderPanel();
  assert.ok(html.includes('class="msg-drafts-name">The Den<'), "the room's name");
  assert.ok(html.includes('data-kind="room"'), "and its kind, so the row opens the room");
  assert.ok(html.includes('data-conversation-id="' + groupId + '"'));
});

test("a draft whose conversation is gone is not drawn", async () => {
  const contactId = await mkContact({ name: "Gone soon", crowId: "crow:gone" });
  await mkDraft({ contactId, body: "orphan" });
  await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [contactId] });
  const html = await renderPanel();
  assert.match(html, /<span id="msg-drafts-count">Drafts \(0\)<\/span>/, "the store still holds it, but it names nobody");
  assert.ok(!html.includes("orphan"), "so it is skipped");
});

// SECURITY (draft privacy): the drafts API answers only this machine's own password session, so the
// SERVER RENDER must refuse a peer's single-sign-on session the same words. Otherwise a peer session
// would be told 403 by the API while reading the draft bodies and previews straight out of the page.
test("a peer SSO session's page carries no draft text, no Drafts section and no data block", async () => {
  const contactId = await mkContact({ name: "Yvonne", crowId: "crow:yvonne" });
  await mkDraft({ contactId, body: "words the owner has not sent yet" });

  const sso = await renderPanel("en", { token: SSO });
  assert.ok(!sso.includes("words the owner has not sent yet"), "no draft body anywhere in the page");
  assert.ok(!sso.includes('id="msg-drafts"'), "no Drafts section");
  assert.ok(!sso.includes('class="msg-drafts-row"'), "no draft rows (their previews are in them)");
  assert.ok(!sso.includes('id="msg-drafts-data"'), "no data block for the client's live redraw");
  assert.ok(sso.includes('id="msg-chat"'), "the rest of the Messages page is still drawn");

  const owner = await renderPanel("en", { token: OWNER });
  assert.ok(owner.includes("words the owner has not sent yet"), "the owner's own page has the draft");
  assert.ok(owner.includes('id="msg-drafts"'), "and the section");
  assert.ok(owner.includes('id="msg-drafts-data"'), "and the data block");
});

/* ------------------------------------------------------------------ (c) ROUTE */

async function mountRouter() {
  const { default: express } = await import("express");
  const { messagesDraftsRouter } = await import("../servers/gateway/routes/messages-drafts-api.js");
  const { createDbClient } = await import("../servers/db.js");
  const app = express();
  const session = (req, res, next) => { req.dashboardSession = "sess"; next(); };
  app.use(messagesDraftsRouter(session, { openDb: () => createDbClient(), ownerCheck: async () => true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const port = server.address().port;
  return async (path) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("the drafts API answers the panel's display rows — kind, label, preview, botName — and not the store's raw columns", async () => {
  const contactId = await mkContact({ name: "Yvonne", crowId: "crow:yvonne" });
  await mkBotDef("hank", "Hank");
  const named = await mkDraft({ contactId, body: "from hank", origin: "bot", botId: "hank" });
  const get = await mountRouter();

  const one = await get(`/dashboard/messages/api/drafts/${named.id}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.draft.botName, "Hank", "the name the banner needs");

  const list = await get("/dashboard/messages/api/drafts?state=open");
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.drafts.length, 1);
  const row = list.json.drafts[0];
  assert.equal(row.botName, "Hank");
  // THE BLOCKER: the panel's live redraw feeds this list straight into the row builder, so a row
  // missing the recipient's name or its kind draws blank — and a room draft's row opens a contact
  // thread with the room's group id.
  assert.equal(row.kind, "contact", "the row says which thread a click opens");
  assert.equal(row.label, "Yvonne", "and the name a person reads");
  assert.equal(row.preview, "from hank");
  assert.equal(row.body, "from hank");
  assert.equal(row.version, 1);
  assert.equal(typeof row.updatedAt, "number");
  assert.equal(row.conversationKind, undefined, "the store's raw column name is not what the panel draws");

  // A room's row says `room`, so the click opens the room and not a contact with that id.
  const groupId = await mkGroup("The Den");
  await db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)", args: [groupId, contactId] });
  await store.createDraft(db, {
    conversationKind: "room",
    conversationId: groupId,
    body: "Hello den",
    recipients: [{ contactId, crowId: "crow:yvonne", pubkey: pubkeyFor(contactId) }],
  }, { loadSeed: async () => SEED, now: NOW });
  const rooms = (await get("/dashboard/messages/api/drafts?state=open")).json.drafts.filter((d) => d.kind === "room");
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].conversationId, groupId);
  assert.equal(rooms[0].label, "The Den");

  // An owner's draft never claims a bot.
  const other = await mkContact({ name: "Second", crowId: "crow:second" });
  const owner = await mkDraft({ contactId: other, body: "mine" });
  const mine = await get(`/dashboard/messages/api/drafts/${owner.id}`);
  assert.equal(mine.json.draft.botName, null);

  // The definition goes away: the snapshot still names the bot once one was sealed, and the id
  // stands in when neither exists.
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id = 'hank'" });
  const gone = await get(`/dashboard/messages/api/drafts/${named.id}`);
  assert.equal(gone.json.draft.botName, "hank");
});

/* -------------------------------------------------------------- (d) BEHAVIOUR */

const LEAKED = ["__msgOpenHookBound", "__msgOutsideClickBound", "__crowMsgStream", "__msgPollInterval",
  "__crowDraftStream", "__msgDraftConfirmBound"];

/**
 * The real client, executed over the real markup. `routes` maps a request to a reply:
 *   routes["GET /dashboard/messages/api/drafts?conversation=contact:3"] = { status, body }
 * Unmatched requests answer `{ ok: true, drafts: [] }`-ish empties, so a conversation can open.
 */
function boot({ routes = {}, lang = "en", drafts = [], width = 390, topic = 3 } = {}) {
  for (const key of LEAKED) delete globalThis[key];
  const html = buildMessagesHTML(htmlOpts({ lang, drafts }));
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.location = { search: "", href: "https://crow.test/dashboard/messages", pathname: "/dashboard/messages", reload() {} };
  window.innerWidth = width;
  const focusCalls = [];
  window.HTMLElement.prototype.focus = function () { focusCalls.push(this); };

  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const sockets = [];

  function FakeEventSource(url) {
    this.url = String(url);
    this._handlers = {};
    this.close = () => { this.closed = true; };
    sockets.push(this);
  }
  FakeEventSource.prototype.addEventListener = function (name, fn) {
    (this._handlers[name] = this._handlers[name] || []).push(fn);
  };
  FakeEventSource.prototype.emit = function (name, data) {
    for (const fn of this._handlers[name] || []) fn({ data: JSON.stringify(data) });
  };

  const reply = (url, init) => {
    const method = (init && init.method) || "GET";
    // Routes are keyed with the decoded URL (a conversation is `contact:3`, which the client sends
    // URL-encoded); a literal key always wins, then the decoded spelling is tried.
    let key = method + " " + String(url);
    let hit;
    if (Object.prototype.hasOwnProperty.call(routes, key)) hit = routes[key];
    else {
      try { key = method + " " + decodeURIComponent(String(url)); } catch { /* keep the raw key */ }
      hit = routes[key];
    }
    if (typeof hit === "function") return hit(calls[calls.length - 1]);
    if (hit) return hit;
    if (String(url).endsWith(`/api/messages/peer/${topic}`)) {
      return { status: 200, body: { contact: { id: topic, display_name: "Peer", crow_id: "crow:peer" + topic, verified: 0 }, messages: [] } };
    }
    if (String(url).includes("/api/messages/api/drafts") || String(url).startsWith("/dashboard/messages/api/drafts")) {
      if (String(url).includes("?state=open")) return { status: 200, body: { drafts } };
      return { status: 200, body: { drafts: [] } };
    }    return { status: 200, body: {} };
  };

  // `out.defer` (a promise a route may return) holds the reply open, so a test can make a write
  // land after something else has happened — the "Enter sent the message while the first create was
  // still in flight" race has no other way to be reproduced deterministically.
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    const out = reply(url, init);
    if (out && out.defer) await out.defer;
    return {
      ok: (out.status || 200) < 400,
      status: out.status || 200,
      json: () => Promise.resolve(out.body === undefined ? {} : out.body),
    };
  };

  const ctx = vm.createContext({
    window,
    document,
    location: window.location,
    fetch: fetchStub,
    console,
    EventSource: FakeEventSource,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams,
    TextDecoder,
    Date,
    JSON,
  });
  vm.runInContext(stripScriptTags(messagesClientJS({ aiConfigured: false, storageAvailable: false, lang })), ctx);

  const $ = (sel) => document.querySelector(sel);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const flushTimers = async () => {
    const q = [...timers.values()];
    timers.clear();
    for (const fn of q) await fn();
    await settle();
  };
  const type = async (text) => {
    const ta = document.getElementById("msg-input");
    ta.value = text;
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
  };
  const click = async (elm) => {
    elm.dispatchEvent(new window.Event("click", { bubbles: true }));
    await settle();
  };
  const key = async (k) => {
    const ev = new window.Event("keydown", { bubbles: true });
    ev.key = k;
    document.dispatchEvent(ev);
    await settle();
  };
  const draftSocket = () => sockets.find((s) => s.url === "/dashboard/streams/message-drafts");

  return { window, document, ctx, $, calls, settle, flushTimers, type, click, key, draftSocket, focusCalls, sockets };
}

function stripScriptTags(html) {
  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.lastIndexOf("</script>");
  return html.slice(start, end);
}

const API = "/dashboard/messages/api/drafts";
const A_DRAFT = {
  id: "msgd-" + "c".repeat(32),
  conversationKind: "contact",
  conversationId: 3,
  label: "Peer",
  body: "Saved words",
  origin: "owner",
  botId: null,
  botName: null,
  version: 3,
};
const LIST_ROW = {
  id: A_DRAFT.id,
  kind: "contact",
  conversationId: 3,
  label: "Peer",
  body: A_DRAFT.body,
  preview: A_DRAFT.body,
  origin: "owner",
  botId: null,
  botName: null,
  version: 3,
  updatedAt: Date.now() - 60_000,
};

test("BEHAVIOUR: opening a thread pre-fills its composer from the open draft", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();

  assert.equal(h.$("#msg-input").value, "Saved words", "the composer holds the saved text");
  assert.ok(h.$("#msg-draft-bar").className.includes("visible"), "the draft bar is shown");
  assert.equal(h.$("#msg-draft-bar-discard").hasAttribute("hidden"), false, "Discard is offered");
  assert.ok(!h.$("#msg-draft-banner").className.includes("visible"), "an owner's draft shows no bot banner");
});

test("BEHAVIOUR: a bot's draft shows the approved banner naming its definition", async () => {
  const h = boot({
    drafts: [],
    routes: {
      [`GET ${API}?conversation=contact:3`]: {
        status: 200,
        body: { drafts: [{ ...A_DRAFT, origin: "bot", botId: "hank", botName: "Hank" }] },
      },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  const banner = h.$("#msg-draft-banner");
  assert.ok(banner.className.includes("visible"), "the banner shows");
  assert.equal(banner.textContent, fill(t("messages.draft.draftBanner", "en"), { bot: "Hank" }));
  assert.match(banner.textContent, /Draft by Hank\./);
});

test("BEHAVIOUR: typing autosaves 800 ms later with the version the screen was drawn from", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      [`PATCH ${API}/${A_DRAFT.id}/body`]: { status: 200, body: { draft: { ...A_DRAFT, body: "Saved words, edited", version: 4 } } },
      [`GET ${API}?state=open`]: { status: 200, body: { drafts: [{ ...LIST_ROW, body: "Saved words, edited", version: 4 }] } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();

  await h.type("Saved words, edited");
  const patchesBefore = h.calls.filter((c) => c.init && c.init.method === "PATCH").length;
  assert.equal(patchesBefore, 0, "nothing is written on the keystroke itself");

  await h.flushTimers();
  const patches = h.calls.filter((c) => c.init && c.init.method === "PATCH");
  assert.equal(patches.length, 1, "one autosave after the debounce");
  assert.equal(patches[0].url, `${API}/${A_DRAFT.id}/body`);
  assert.deepEqual(patches[0].body, { body: "Saved words, edited", expectVersion: 3 }, "the version it was drawn from rides along");
  assert.equal(h.$("#msg-draft-status").textContent, t("messages.draft.saved", "en"));
});

test("BEHAVIOUR: the first keystroke in an empty composer creates the draft, create-only", async () => {
  const h = boot({
    routes: {
      [`PUT ${API}`]: { status: 201, body: { draft: A_DRAFT, created: true, label: "Peer" } },
      [`GET ${API}?state=open`]: { status: 200, body: { drafts: [LIST_ROW] } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type("A brand new thought");
  await h.flushTimers();
  const puts = h.calls.filter((c) => c.init && c.init.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body,
    { conversationKind: "contact", conversationId: 3, body: "A brand new thought", expectVersion: 0 },
    "create-only: the server never overwrites a draft this client has not read");
  assert.equal(h.$("#msg-draft-status").textContent, t("messages.draft.saved", "en"));
});

test("BEHAVIOUR: a create that answers 409 adopts the existing draft instead of overwriting it", async () => {
  const theirs = { ...A_DRAFT, body: "words the other tab saved", version: 2 };
  let reads = 0;
  const h = boot({
    routes: {
      [`PUT ${API}`]: { status: 409, body: { error: "changed", version: 2, draft: theirs } },
      [`GET ${API}?conversation=contact:3`]: () => {
        reads += 1;
        return { status: 200, body: { drafts: reads === 1 ? [] : [theirs] } };
      },
      [`GET ${API}?state=open`]: { status: 200, body: { drafts: [{ ...LIST_ROW, body: theirs.body, version: 2 }] } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type("my own words");
  await h.flushTimers();

  assert.equal(h.$("#msg-input").value, "my own words", "the local words stay in the box");
  assert.ok(h.$("#msg-draft-changed").className.includes("visible"),
    "and Reload is offered, because they are not what the row now holds");

  // Reload takes their words; a later save then carries THEIR version, so it is not a blind retry.
  await h.click(h.$("#msg-draft-reload"));
  await h.settle();
  assert.equal(h.$("#msg-input").value, "words the other tab saved");
});

test("BEHAVIOUR: a create still in flight when Enter sends is ignored and cancelled, never re-adopted", async () => {
  const sent = "words that went out";
  const lateDraft = { ...A_DRAFT, body: sent, version: 1, state: "open" };
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = boot({
    routes: {
      [`PUT ${API}`]: { status: 201, body: { draft: lateDraft, created: true }, defer: gate },
      [`POST /api/messages/peer/3/send`]: { status: 200, body: { ok: true, id: 77, delivery_status: "relayed" } },
      [`GET ${API}/${A_DRAFT.id}`]: { status: 200, body: { draft: lateDraft } },
      [`POST ${API}/${A_DRAFT.id}/discard`]: { status: 200, body: { ok: true, draft: { ...lateDraft, state: "discarded" } } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type(sent);

  // The autosave's create is in flight (the reply is held), and Enter sends the same words through
  // the normal peer path — which clears the box and moves the world on.
  const flushing = h.ctx.msgDraftFlushPending();
  await h.ctx.sendPeerMessage();
  await h.settle();

  release();
  await flushing;
  await h.settle();
  await h.settle();

  assert.equal(h.$("#msg-input").value, "", "the sent words did not come back into the composer");
  assert.equal(h.ctx._draft, null, "and nothing was adopted as the open draft");
  const sentDiscards = h.calls.filter((c) => c.url.endsWith("/discard") && c.init && c.init.method === "POST");
  assert.equal(sentDiscards.length, 1, "the late create's row was cancelled (discarded), not left as a draft of sent words");
  assert.deepEqual(sentDiscards[0].body, { expectVersion: 1 });
});

test("BEHAVIOUR: clearing the box discards the open draft instead of saving an empty one", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      [`POST ${API}/${A_DRAFT.id}/discard`]: { status: 200, body: { ok: true, draft: { ...A_DRAFT, state: "discarded" } } },
      [`GET ${API}?state=open`]: { status: 200, body: { drafts: [] } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  assert.equal(h.$("#msg-input").value, "Saved words");

  await h.type("");
  await h.flushTimers();

  const patches = h.calls.filter((c) => c.init && c.init.method === "PATCH");
  assert.equal(patches.length, 0, "no empty body was ever saved");
  const discards = h.calls.filter((c) => c.url.endsWith("/discard"));
  assert.equal(discards.length, 1, "the draft was discarded");
  assert.deepEqual(discards[0].body, { expectVersion: A_DRAFT.version });
  assert.equal(h.$("#msg-draft-status").textContent, t("messages.draft.discardedReceipt", "en"));
  assert.equal(h.$("#msg-draft-bar-discard").hasAttribute("hidden"), true, "there is no draft to discard any more");
});
test("BEHAVIOUR: a 409 shows changed elsewhere with Reload, and Reload takes the server's words", async () => {
  const serverRow = { ...A_DRAFT, body: "What the other view typed", version: 5 };
  let reads = 0;
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: () => {
        reads += 1;
        return { status: 200, body: { drafts: [reads === 1 ? A_DRAFT : serverRow] } };
      },
      [`PATCH ${API}/${A_DRAFT.id}/body`]: { status: 409, body: { error: "changed", version: 5, draft: serverRow } },
      [`GET ${API}?state=open`]: { status: 200, body: { drafts: [{ ...LIST_ROW, version: 5, body: serverRow.body }] } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type("my own words");
  await h.flushTimers();

  assert.ok(h.$("#msg-draft-changed").className.includes("visible"), "the changed-elsewhere line is shown");
  assert.equal(h.$("#msg-draft-status").textContent, "", "and no Saved/Saving claim is left standing");
  assert.equal(h.$("#msg-input").value, "my own words", "the local words are NOT overwritten");

  // Reload: the server's row replaces the local words. It is a GET, never a re-POST of the draft.
  const writesBefore = h.calls.filter((c) => c.init && c.init.method !== "GET").length;
  await h.click(h.$("#msg-draft-reload"));
  await h.settle();
  const writesAfter = h.calls.filter((c) => c.init && c.init.method !== "GET").length;
  assert.equal(writesAfter, writesBefore, "Reload writes nothing");
  assert.equal(h.$("#msg-input").value, serverRow.body, "the composer now holds the row as it is");
  assert.equal(h.$("#msg-draft-changed").className.includes("visible"), false, "and the warning is gone");
});

test("BEHAVIOUR: Send posts the composer's exact text and its version, then shows the receipt", async () => {
  let reads = 0;
  let sentAlready = false;
  const h = boot({
    drafts: [],
    routes: {
      [`GET ${API}?conversation=contact:3`]: () => {
        reads += 1;
        return { status: 200, body: { drafts: reads === 1 ? [A_DRAFT] : [] } };
      },
      [`GET ${API}?state=open`]: () => ({
        status: 200,
        body: { drafts: sentAlready ? [] : [{ ...LIST_ROW, body: "Saved words, final", version: 4 }] },
      }),
      [`PATCH ${API}/${A_DRAFT.id}/body`]: (call) => ({
        status: 200,
        body: { draft: { ...A_DRAFT, body: call.body.body, version: 4 } },
      }),
      [`POST ${API}/${A_DRAFT.id}/send`]: () => {
        sentAlready = true;
        return { status: 200, body: { ok: true, draft: { ...A_DRAFT, state: "sent", version: 4 } } };
      },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type("Saved words, final");
  await h.flushTimers();

  await h.click(h.$("#msg-send-btn"));
  await h.settle();

  const posts = h.calls.filter((c) => c.url === `${API}/${A_DRAFT.id}/send`);
  assert.equal(posts.length, 1, "the draft's send route is the one used");
  assert.deepEqual(posts[0].body, { body: "Saved words, final", expectVersion: 4 }, "exactly what the screen showed");
  assert.match(h.$("#msg-draft-status").textContent, /Sent to Peer/, "the receipt names the recipient");
  const ta = h.$("#msg-input");
  assert.equal(ta ? ta.value : "", "", "the composer is empty again");
});

test("BEHAVIOUR: Discard from a Drafts row asks first; Escape closes it and focus goes back", async () => {
  const h = boot({ drafts: [LIST_ROW] });
  const row = h.document.querySelector(".msg-drafts-row");
  assert.ok(row, "the row is on the page");

  h.ctx.msgDraftRowDiscard(row);
  await h.settle();
  const dialog = h.$("#msg-draft-confirm");
  assert.equal(dialog.hasAttribute("hidden"), false, "the confirmation is open");
  assert.equal(h.focusCalls[h.focusCalls.length - 1].id, "msg-draft-confirm-cancel", "focus starts on Cancel");

  await h.key("Escape");
  assert.equal(dialog.hasAttribute("hidden"), true, "Escape closes it");
  assert.ok(
    h.focusCalls[h.focusCalls.length - 1].className.includes("msg-draft-discard"),
    "focus returns to the Discard button that opened it",
  );
  assert.equal(h.calls.filter((c) => c.url.endsWith("/discard")).length, 0, "nothing was discarded by closing");

  // Opening it again and confirming does discard.
  h.ctx.msgDraftRowDiscard(row);
  await h.settle();
  await h.click(h.$("#msg-draft-confirm-yes"));
  await h.settle();
  const discards = h.calls.filter((c) => c.url.endsWith("/discard"));
  assert.equal(discards.length, 1, "one discard posted");
  assert.deepEqual(discards[0].body, { expectVersion: 3 }, "with the version the row was drawn from");
  assert.equal(dialog.hasAttribute("hidden"), true, "the dialog closed");
});

test("BEHAVIOUR: the live crow-draft frame re-reads the row (a newer version is adopted when nothing local is typed)", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: (() => {
        let n = 0;
        return () => {
          n += 1;
          return { status: 200, body: { drafts: [n === 1 ? A_DRAFT : { ...A_DRAFT, body: "Typed elsewhere", version: 9 }] } };
        };
      })(),
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  assert.equal(h.$("#msg-input").value, "Saved words");

  const socket = h.draftSocket();
  assert.ok(socket, "the panel opened the draft stream");
  socket.emit("crow-draft", { draftId: A_DRAFT.id, conversationKind: "contact", conversationId: 3, action: "edit" });
  await h.settle();
  await h.settle();

  assert.equal(h.$("#msg-input").value, "Typed elsewhere", "the composer took the newer row");
  assert.equal(h.$("#msg-draft-changed").className.includes("visible"), false, "nothing to reload: no local words were at risk");
});

test("BEHAVIOUR: a send or discard elsewhere clears the composer and the bar", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: (() => {
        let n = 0;
        return () => {
          n += 1;
          return { status: 200, body: { drafts: n === 1 ? [A_DRAFT] : [] } };
        };
      })(),
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  assert.equal(h.$("#msg-input").value, "Saved words");

  h.draftSocket().emit("crow-draft", { draftId: A_DRAFT.id, conversationKind: "contact", conversationId: 3, action: "send" });
  await h.settle();
  await h.settle();

  assert.equal(h.$("#msg-input").value, "", "the composer no longer holds a sent draft");
  assert.equal(h.$("#msg-draft-bar").className.includes("visible"), false, "and the bar is gone");
});

test("BEHAVIOUR: a 502 carries the reopened draft, and Retry uses the version it answers with", async () => {
  const reopened = { ...A_DRAFT, body: "Saved words, final", version: 5, state: "open" };
  let sends = 0;
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      [`PATCH ${API}/${A_DRAFT.id}/body`]: { status: 200, body: { draft: { ...A_DRAFT, body: "Saved words, final", version: 4 } } },
      [`POST ${API}/${A_DRAFT.id}/send`]: () => {
        sends += 1;
        return sends === 1
          ? { status: 502, body: { error: "delivery_failed", version: 5, draft: reopened } }
          : { status: 200, body: { ok: true, draft: { ...A_DRAFT, state: "sent", version: 6 } } };
      },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type("Saved words, final");
  await h.flushTimers();

  await h.click(h.$("#msg-send-btn"));
  await h.settle();
  assert.match(h.$("#msg-draft-status").textContent, /Not sent\. Your draft is still here/,
    "the approved \"not sent\" line");
  assert.equal(h.$("#msg-input").value, "Saved words, final", "the words are still in the box");

  // The retry carries the REOPENED row's version, not the one the failed attempt used — so it is not
  // answered 409 against a row that never moved out of `open`.
  await h.click(h.$("#msg-send-btn"));
  await h.settle();
  const posts = h.calls.filter((c) => c.url === `${API}/${A_DRAFT.id}/send`);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, { body: "Saved words, final", expectVersion: 5 });
});

test("BEHAVIOUR: a seal that does not verify shows the approved unverified line and disables Send", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      [`POST ${API}/${A_DRAFT.id}/send`]: { status: 409, body: { error: "seal_invalid", version: 3, draft: A_DRAFT } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.click(h.$("#msg-send-btn"));
  await h.settle();

  assert.equal(h.$("#msg-draft-status").textContent, t("messages.draft.unverified", "en"),
    "the approved sentence, never \"changed somewhere else\"");
  assert.equal(h.$("#msg-send-btn").disabled, true, "and Send is off: the server would refuse it");
  const posts = h.calls.filter((c) => c.url === `${API}/${A_DRAFT.id}/send`);
  assert.equal(posts.length, 1);
  await h.click(h.$("#msg-send-btn"));
  await h.settle();
  assert.equal(h.calls.filter((c) => c.url === `${API}/${A_DRAFT.id}/send`).length, 1,
    "a disabled Send posts nothing");
});

test("BEHAVIOUR: pubkey_changed and blocked show their approved sentences, not \"changed elsewhere\"", async () => {
  const cases = [
    ["pubkey_changed", fill(t("messages.draft.errPubkey", "en"), { name: "Peer" })],
    ["blocked", fill(t("messages.draft.errBlocked", "en"), { name: "Peer" })],
    ["recipients_changed", t("messages.draft.changedElsewhere", "en")],
    ["conversation_gone", t("messages.draft.changedElsewhere", "en")],
  ];
  for (const [error, sentence] of cases) {
    const h = boot({
      drafts: [LIST_ROW],
      routes: {
        [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
        [`POST ${API}/${A_DRAFT.id}/send`]: { status: 409, body: { error, version: 3, draft: A_DRAFT } },
      },
    });
    h.ctx.msgSelectItem("peer", 3);
    await h.settle();
    await h.click(h.$("#msg-send-btn"));
    await h.settle();
    assert.equal(h.$("#msg-draft-status").textContent, sentence, `${error} shows its own sentence`);
    assert.equal(h.$("#msg-draft-changed").className.includes("visible"), false,
      `${error} is not a lost race: no Reload line`);
  }
});

test("BEHAVIOUR: Send is held while the draft says it changed elsewhere — Reload comes first", async () => {
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      [`PATCH ${API}/${A_DRAFT.id}/body`]: { status: 409, body: { error: "changed", version: 9, draft: { ...A_DRAFT, version: 9 } } },
      [`POST ${API}/${A_DRAFT.id}/send`]: { status: 200, body: { ok: true, draft: { ...A_DRAFT, state: "sent" } } },
    },
  });
  h.ctx.msgSelectItem("peer", 3);
  await h.settle();
  await h.type("my own words");
  await h.flushTimers();
  assert.ok(h.$("#msg-draft-changed").className.includes("visible"), "the changed-elsewhere line is offered");

  await h.click(h.$("#msg-send-btn"));
  await h.settle();
  assert.equal(h.calls.filter((c) => c.url === `${API}/${A_DRAFT.id}/send`).length, 0,
    "sending is held while the row's current words are unanswered");
  assert.ok(h.$("#msg-draft-changed").className.includes("visible"), "and the way out (Reload) is still shown");
  assert.equal(h.$("#msg-input").value, "my own words", "the local words are kept, not re-sent");

  // Enter goes through the same guard: no second send path around it.
  await h.type("my own words again");
  await h.flushTimers();
  const ta = h.$("#msg-input");
  const enter = new h.window.Event("keydown", { bubbles: true });
  enter.key = "Enter";
  ta.dispatchEvent(enter);
  await h.settle();
  await h.settle();
  assert.equal(h.calls.filter((c) => c.url === `${API}/${A_DRAFT.id}/send`).length, 0,
    "Enter is held too");
});

test("BEHAVIOUR: seal_unavailable and no_recipients get their own approved lines, not \"changed elsewhere\"", async () => {
  // A send this Crow cannot verify (no usable key to check the seal with): the unverified line, and
  // Send goes off — it would be refused again.
  const send = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      [`POST ${API}/${A_DRAFT.id}/send`]: { status: 409, body: { error: "seal_unavailable", message: "…" } },
    },
  });
  send.ctx.msgSelectItem("peer", 3);
  await send.settle();
  await send.click(send.$("#msg-send-btn"));
  await send.settle();
  assert.equal(send.$("#msg-draft-status").textContent, t("messages.draft.unverified", "en"),
    "the approved unverified sentence");
  assert.equal(send.$("#msg-draft-changed").className.includes("visible"), false,
    "nothing changed elsewhere: no Reload line");
  assert.equal(send.$("#msg-send-btn").disabled, true, "and Send is off");

  // A create in a conversation with nobody in it: the approved "not sent, your draft is still here"
  // line — there is nothing to reload and nothing was lost.
  const create = boot({
    routes: {
      [`PUT ${API}`]: { status: 409, body: { error: "no_recipients", message: "…" } },
    },
  });
  create.ctx.msgSelectItem("peer", 3);
  await create.settle();
  await create.type("hello nobody");
  await create.flushTimers();
  assert.equal(create.$("#msg-draft-status").textContent, t("messages.draft.errSendFailed", "en"),
    "the approved not-sent line");
  assert.equal(create.$("#msg-draft-changed").className.includes("visible"), false,
    "and no changed-elsewhere line");
});

test("BEHAVIOUR: a failed send the open draft still holds offers ONE retry — the draft, not the bubble", async () => {
  const failedRow = (content) => ({
    id: 41,
    direction: "sent",
    content,
    delivery_status: "failed",
    created_at: new Date().toISOString(),
  });
  const threadWith = (content) => ({
    status: 200,
    body: {
      contact: { id: 3, display_name: "Peer", crow_id: "crow:peer3", verified: 0 },
      messages: [failedRow(content)],
    },
  });

  // The draft holds exactly the failed row's words: the reopened draft in the bar is the retry, so the
  // bubble gets its note and no second button.
  const held = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      "GET /api/messages/peer/3": threadWith(A_DRAFT.body),
    },
  });
  held.ctx.msgSelectItem("peer", 3);
  await held.settle();
  await held.settle();
  const failedBubble = held.document.querySelector(".msg-bubble-failed");
  assert.ok(failedBubble, "the failed row is drawn");
  assert.ok(failedBubble.querySelector(".msg-bubble-failed-note"), "with its note");
  assert.equal(failedBubble.querySelector(".msg-retry-btn"), null,
    "no second Retry: the reopened draft is the one retry path");
  assert.equal(held.$("#msg-draft-bar").className.includes("visible"), true, "and the draft bar (with its Send) is there");

  // A failed row the draft does NOT hold keeps its own Retry — that is a typed send that failed, and
  // the draft is not what would re-send it.
  const other = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?conversation=contact:3`]: { status: 200, body: { drafts: [A_DRAFT] } },
      "GET /api/messages/peer/3": threadWith("a different line that never left"),
    },
  });
  other.ctx.msgSelectItem("peer", 3);
  await other.settle();
  await other.settle();
  assert.ok(other.document.querySelector(".msg-bubble-failed .msg-retry-btn"),
    "a failed row outside the draft keeps its own Retry");
});

test("BEHAVIOUR: a room row redrawn from a live frame opens the ROOM, a contact row its contact", async () => {
  const roomRow = {
    id: "msgd-" + "d".repeat(32),
    kind: "room",
    conversationId: 12,
    label: "The Den",
    body: "Hello den",
    preview: "Hello den",
    origin: "owner",
    botId: null,
    botName: null,
    version: 1,
    updatedAt: Date.now() - 60_000,
  };
  const h = boot({
    drafts: [LIST_ROW],
    routes: {
      [`GET ${API}?state=open`]: { status: 200, body: { drafts: [LIST_ROW, roomRow] } },
      [`GET ${API}?conversation=room:12`]: { status: 200, body: { drafts: [{ ...roomRow }] } },
      "GET /api/messages/room/12": { status: 200, body: { room: { id: 12, name: "The Den" }, members: [], messages: [] } },
    },
  });
  // The live frame is what makes the client re-read the list: this is the redraw the blocker was in.
  h.draftSocket().emit("crow-draft", { draftId: roomRow.id, conversationKind: "room", conversationId: 12, action: "create" });
  await h.settle();
  await h.settle();

  const rows = h.document.querySelectorAll(".msg-drafts-row");
  assert.equal(rows.length, 2, "the redrawn list has both drafts");
  const roomEl = [...rows].find((r) => r.getAttribute("data-draft-id") === roomRow.id);
  assert.ok(roomEl, "the room's row is there");
  assert.equal(roomEl.getAttribute("data-kind"), "room", "it kept its kind through the redraw");
  assert.equal(roomEl.getAttribute("data-conversation-id"), "12");
  assert.match(roomEl.textContent, /The Den/, "and its name");

  await h.click(roomEl.querySelector(".msg-drafts-open"));
  await h.settle();
  assert.equal(h.ctx._activeItem.type, "room", "the click opened the room, not a contact");
  assert.equal(String(h.ctx._activeItem.id), "12");
  assert.equal(h.$(".msg-chat-header-name").textContent, "The Den");
  assert.equal(h.$("#msg-input").value, "Hello den", "the room's draft pre-filled its composer");

  // A contact row still opens its contact.
  const peerEl = [...h.document.querySelectorAll(".msg-drafts-row")]
    .find((r) => r.getAttribute("data-draft-id") === LIST_ROW.id);
  assert.equal(peerEl.getAttribute("data-kind"), "contact");
  await h.click(peerEl.querySelector(".msg-drafts-open"));
  await h.settle();
  assert.equal(h.ctx._activeItem.type, "peer");
  assert.equal(Number(h.ctx._activeItem.id), 3);
});