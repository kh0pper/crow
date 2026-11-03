/**
 * Staged sends, Task 3: the routes (routes/perch-interactive-api.js), the send-once rule and the
 * edit/discard writes (staged/send-service.js), the bot notes and the new-recipient hint
 * (staged/new-recipients.js).
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR — nothing can touch ~/.crow), an
 * ephemeral express server wired the way servers/gateway/index.js + dashboard/index.js wire it (the
 * global 1mb JSON parser that skips index.js's own `_hasOwnParser` predicate, read from its source,
 * then the dashboard's real CSRF middleware, then the real perch-api router), a real Gmail client
 * against tests/fixtures/fake-gmail.mjs (so every assertion about "was it sent" is a count in the
 * fake), a real owner rule (isLocalPasswordSessionOn) with the request marked as coming from the
 * operator's laptop (tests/helpers/off-box.js), and a fake interactive engine that records the text
 * of each turn.
 *
 * No pi, no network, no host config.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createFakeGmail, makeDraftRaw } from "./fixtures/fake-gmail.mjs";

const dir = mkdtempSync(join(tmpdir(), "staged-routes-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

/** The owner's own local password session, and the two sessions that are signed in but never the owner. */
const OWNER_TOKEN = "owner-local-password-session";
const SSO_TOKEN = "peer-sso-session";
const ONHOST_TOKEN = "minted-on-this-machine-session";
const CSRF = "csrf-token-value";

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

let server, db, store, service, configPaths, createClient;
let fake, engineTexts;
/** Every test gets its own session, so the card's list only ever returns that test's rows. */
let SESSION = "sess-0";
/**
 * The router's Gmail seam, per test: null = the real client over the current fake. A test that needs
 * to hold a provider call open, or make one throw a non-provider error, sets this.
 */
let gmailSeam = null;

/** Fake interactive engine: it only has to record what the bot was told. */
const fakeEngine = {
  async message(sid, text) {
    engineTexts.push({ sid, text });
    return { turnId: "turn-" + engineTexts.length };
  },
};

/* ------------------------------------------------------------------ HTTP */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * One request. `token: null` sends no session cookie, `csrf: null` sends no X-Crow-Csrf header, and
 * `laptop: false` leaves the request classified as coming from this machine (a test's own call is
 * loopback, which the owner rule treats as this machine unless the peer memo says otherwise).
 */
function call(method, path, { body, contentType = "application/json", headers = {}, token = OWNER_TOKEN, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": contentType, "content-length": Buffer.byteLength(payload) }) };
  if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
  if (token && csrf) h["x-crow-csrf"] = csrf;
  if (laptop) h["x-test-from"] = "laptop";
  Object.assign(h, headers);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: h }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(payload === null ? undefined : payload);
  });
}

const post = (path, body, opts) => call("POST", path, { body, ...opts });
const get = (path, opts) => call("GET", path, opts);
const sendPath = (id) => "/dashboard/perch-api/staged/" + encodeURIComponent(id) + "/send";
const editPath = (id) => "/dashboard/perch-api/staged/" + encodeURIComponent(id) + "/edit";
const discardPath = (id) => "/dashboard/perch-api/staged/" + encodeURIComponent(id) + "/discard";
const listPath = (sid = SESSION) => "/dashboard/perch-api/interactive/" + encodeURIComponent(sid) + "/staged";
const messagePath = (sid = SESSION) => "/dashboard/perch-api/interactive/" + encodeURIComponent(sid) + "/message";

/** The real Gmail client over the CURRENT fake (a test replaces `fake` between requests). */
function realClient(credRef) {
  return createClient({ credRef, fetchImpl: (url, init) => fake.fetchImpl(url, init), configPaths });
}

/** Capture console.warn while `fn` runs: the gateway's log sink is console, and a test that cares
 *  about a log line must not depend on the host's console. (Tests in a file run one at a time.) */
async function warnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try {
    return { lines, result: await fn() };
  } finally {
    console.warn = original;
  }
}

/* ----------------------------------------------------------------- setup */

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });

  const { default: express } = await import("express");
  const { createDbClient } = await import("../servers/db.js");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { createGmailClient } = await import("../servers/gateway/staged/gmail-client.js");
  createClient = createGmailClient;
  const { markFromLaptop } = await import("./helpers/off-box.js");
  store = await import("../servers/gateway/staged/store.js");
  service = await import("../servers/gateway/staged/send-service.js");

  // An operator-owned config naming one token file (fake values): cred-ref.js resolves the row's
  // {server, role} through it, exactly as it does in production.
  const tokenFile = join(dir, "gws-token.json");
  writeFileSync(tokenFile, JSON.stringify({ token: "fake-access-token", refresh_token: "fake-refresh", client_id: "fake-id", client_secret: "fake-secret" }));
  const canonical = join(dir, "mcp.json");
  writeFileSync(canonical, JSON.stringify({ mcpServers: { "google-workspace": { command: "gws", args: [], env: { GOOGLE_TOKEN_FILE: tokenFile } } } }));
  configPaths = { canonical, addons: join(process.env.CROW_HOME, "mcp-addons.json") };

  db = createDbClient(DB_FILE);
  const day = "datetime('now','+1 day')";
  await db.execute({ sql: `INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ${day})`, args: [hashToken(OWNER_TOKEN)] });
  await db.execute({ sql: `INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard sso src:peer-1', ${day})`, args: [hashToken(SSO_TOKEN)] });
  await db.execute({ sql: `INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard onhost', ${day})`, args: [hashToken(ONHOST_TOKEN)] });

  const app = express();
  // Express skips its stack log when env is "test"; a route that leaked would print in production.
  app.set("env", "development");
  // servers/gateway/index.js's split, using the REAL predicate (read from its source, the idiom the
  // other gateway tests use): the global 1mb parser skips the paths whose router parses its own body
  // (`_hasOwnParser`), so a staged POST never reaches the global parser — trailing slash included.
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  assert.ok(predicate, "index.js's _hasOwnParser is where it was");
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  const globalJson = express.json({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));

  // dashboard/index.js's rails: dashboardAuth, then the real CSRF middleware, then the router.
  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(perchInteractiveApiRouter(sessionGate, {
    engine: () => fakeEngine,
    annotate: async (m) => m,
    providerModels: () => [],
    piProviders: () => null,
    // The Gmail seam: a real client (real MIME rewriting, real canonical hashing) over the fake API.
    stagedGmail: (credRef) => (gmailSeam ? gmailSeam(credRef) : realClient(credRef)),
  }));
  app.use(dash);
  const { bodyErrorHandler } = await import("../servers/gateway/body-error-handler.js");
  app.use(bodyErrorHandler);

  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  try { db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

let sessionSeq = 0;
beforeEach(() => {
  service._resetStagedNotesForTest();
  engineTexts = [];
  SESSION = "sess-" + (++sessionSeq);
  gmailSeam = null;
  fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw(), threadId: "t1" } } });
});

/** A staged row (canonical snapshot + hash from the store) with the base fields every test shares. */
async function seedRow(over = {}) {
  const id = await store.createStaged(db, {
    sessionId: SESSION,
    threadId: SESSION,
    botId: "writer",
    channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" },
    providerDraftId: "d1",
    providerThreadId: "t1",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hello", body: "Hello there" },
    tainted: false,
    ...over,
  });
  return { id, row: await store.getStaged(db, id) };
}

/** A draft the fake serves, whose canonical snapshot is the row's own (so the hash matches). */
const draftFor = (over = {}) => ({ raw: makeDraftRaw(over), threadId: "t1" });

const rowById = (items, id) => items.find((i) => i.id === id);

/* ------------------------------------------------------------------ tests */

test("send once under concurrent claims", async () => {
  const { id, row } = await seedRow();

  const [a, b] = await Promise.all([
    post(sendPath(id), { content_hash: row.contentHash }),
    post(sendPath(id), { content_hash: row.contentHash }),
  ]);

  const sent = [a, b].filter((r) => r.status === 200);
  const refused = [a, b].filter((r) => r.status === 409);
  assert.equal(sent.length, 1, `exactly one send answered ok: ${JSON.stringify([a.status, b.status])}`);
  assert.deepEqual(sent[0].json.state, "sent");
  assert.deepEqual(refused[0].json, { error: "already_sent" });
  assert.equal(fake.calls.send, 1, "exactly one drafts.send reached the provider");

  const after = await store.getStaged(db, id);
  assert.equal(after.state, "sent");
  assert.ok(after.providerMessageId, "the provider's message id is recorded");
  // What left is the approved snapshot rebuilt by the client, not the provider's stored draft.
  assert.match(fake.sent[0].raw, /Subject: Hello/);
  // The answer carries the message id and nothing of the draft.
  assert.ok(!sent[0].text.includes("alex@example.com"));
  assert.ok(!sent[0].text.includes("Hello there"));
});

test("provider changed refuses", async () => {
  // The bot edited the draft in Gmail after the card was rendered.
  fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({ body: "Something else entirely" }), threadId: "t1" } } });
  const { id, row } = await seedRow();

  const r = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "changed");
  assert.equal(fake.calls.send, 0, "nothing was sent");
  assert.equal(fake.calls.get, 1, "the provider was re-read before the send");
  // The row the card had is replaced by one carrying Gmail's own snapshot: back to review, not
  // failed (the next test is what the card then shows).
  assert.equal((await store.getStaged(db, id)).state, "replaced");
  assert.equal((await store.getStaged(db, r.json.id)).state, "staged");
  assert.deepEqual(service.claimStagedNotes(SESSION), [], "the bot is told nothing: nothing happened");
});

test("a draft the bot changed in Gmail shows its new text after changed", async () => {
  fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({ body: "The bot's newer words" }), threadId: "t1" } } });
  const { id, row } = await seedRow();

  const r = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "changed");
  assert.notEqual(r.json.id, id, "the answer names the row that replaced the card's");
  assert.match(r.json.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(fake.calls.send, 0);

  // The card's own read shows the NEW text under the NEW id, still sendable (the credential was
  // kept), and the old id is not open any more.
  const list = await get(listPath());
  assert.equal(list.status, 200, list.text);
  const item = rowById(list.json.items, r.json.id);
  assert.ok(item, "the new row is on the card");
  assert.equal(item.snapshot.body, "The bot's newer words");
  assert.equal(item.contentHash, r.json.contentHash);
  assert.equal(item.sendable, true);
  assert.equal(rowById(list.json.items, id), undefined, "the replaced row is not open");
  const fresh = await store.getStaged(db, r.json.id);
  assert.deepEqual(fresh.credRef, row.credRef, "the credential is kept");
  assert.equal(fresh.sessionId, SESSION);
  assert.equal(fresh.providerDraftId, row.providerDraftId);

  // The new hash is a real one: approving it sends.
  const sent = await post(sendPath(r.json.id), { content_hash: r.json.contentHash });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(sent.json.state, "sent");
  assert.equal(fake.calls.send, 1);
});

test("gone draft", async () => {
  fake = createFakeGmail({ drafts: {} });
  const { id, row } = await seedRow();

  const r = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: false, state: "failed", failReason: "This draft is gone from Gmail" });
  assert.equal(fake.calls.send, 0);
  const after = await store.getStaged(db, id);
  assert.equal(after.state, "failed");
  assert.equal(after.failReason, "This draft is gone from Gmail");
});

test("placeholders refused server-side", async () => {
  const { id, row } = await seedRow({
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hello [Client Name]", body: "Hi there" },
  });

  const r = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: "placeholders" });
  assert.equal(fake.calls.get, 0, "refused before the provider was even read");
  assert.equal(fake.calls.send, 0);
  assert.equal((await store.getStaged(db, id)).state, "staged", "the row is untouched");
});

test("edit updates provider and replaces", async () => {
  const { id, row } = await seedRow();

  const r = await post(editPath(id), {
    to: ["alex@example.com", " bob@example.com "],
    cc: [],
    bcc: [],
    subject: "New subject",
    body: "New body",
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.code, "edited");
  assert.notEqual(r.json.id, id, "a new row");
  assert.match(r.json.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(!r.text.includes("bob@example.com"), "the answer carries no address");

  const old = await store.getStaged(db, id);
  assert.equal(old.state, "replaced");
  const fresh = await store.getStaged(db, r.json.id);
  assert.deepEqual(fresh.snapshot, {
    to: ["alex@example.com", "bob@example.com"], cc: [], bcc: [], subject: "New subject", body: "New body",
  });
  assert.equal(fresh.contentHash, r.json.contentHash, "the answer's hash is the row's");
  assert.equal(fresh.state, "staged");

  assert.equal(fake.updates.length, 1, "the provider draft was rewritten once");
  assert.match(fake.updates[0].raw, /Subject: New subject/);
  assert.match(fake.updates[0].raw, /To: alex@example.com, bob@example.com/);
  assert.match(fake.updates[0].raw, /Message-ID: <draft-1@example.com>/, "threading headers are kept");
  assert.notEqual(fresh.contentHash, row.contentHash);
});

test("discard", async () => {
  const { id } = await seedRow();
  const r = await post(discardPath(id), {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, code: "discarded", state: "discarded" });
  assert.equal((await store.getStaged(db, id)).state, "discarded");
  assert.equal(fake.calls.get + fake.calls.send + fake.calls.update, 0, "the provider is never touched");
});

test("CSRF and session required", async () => {
  const { id, row } = await seedRow();

  // Signed in, but no CSRF token: the dashboard rail refuses before the router runs.
  const noCsrf = await post(sendPath(id), { content_hash: row.contentHash }, { csrf: null });
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.text, /CSRF/i);
  assert.equal(noCsrf.json, null, "the CSRF rail answers plain text, not our JSON");

  // The CSRF token without a session: nothing to be signed in to.
  for (const [what, r] of [
    ["POST", await post(discardPath(id), {}, { token: null })],
    ["GET", await get(listPath(), { token: null })],
  ]) {
    assert.equal(r.status, 401, what);
    assert.deepEqual(r.json, { error: "unauthorized" }, what);
  }
  // …and the refused POSTs changed nothing.
  assert.equal((await store.getStaged(db, id)).state, "staged");
  assert.equal(fake.calls.send, 0);
});

test("notes ride next message", async () => {
  fake = createFakeGmail({ drafts: { d1: draftFor(), d2: draftFor({ subject: "Second", body: "Second body" }), d3: draftFor({ subject: "Third", body: "Third body" }) } });
  const a = await seedRow({ providerDraftId: "d1" });
  const b = await seedRow({ providerDraftId: "d2", snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Second", body: "Second body" } });
  const c = await seedRow({ providerDraftId: "d3", snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Third", body: "Third body" } });

  assert.equal((await post(sendPath(a.id), { content_hash: a.row.contentHash })).status, 200);
  assert.equal((await post(editPath(b.id), { to: ["alex@example.com"], cc: [], bcc: [], subject: "Second", body: "Second body, edited" })).status, 200);
  assert.equal((await post(discardPath(c.id), {})).status, 200);

  const first = await post(messagePath(), { message: "hello" });
  assert.equal(first.status, 202, first.text);
  const text = engineTexts.at(-1).text;
  assert.equal(text, [
    "[Crow] The operator sent your draft to 1 recipients (message msg-1).",
    "[Crow] The operator edited your draft before sending.",
    "[Crow] The operator discarded your draft.",
    "",
    "hello",
  ].join("\n"));

  // Taken once: the next turn gets the operator's text alone.
  assert.equal((await post(messagePath(), { message: "again" })).status, 202);
  assert.equal(engineTexts.at(-1).text, "again");
});

test("new recipients cached", async () => {
  const snapshot = {
    to: ["known@example.com", "written@example.com", "stranger@example.com"],
    cc: [], bcc: [], subject: "Hello", body: "Hello there",
  };
  fake = createFakeGmail({
    drafts: { d1: draftFor({ to: "known@example.com, written@example.com, stranger@example.com" }) },
  });
  fake.sentTo.add("written@example.com");
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, email) VALUES ('crow-1', 'ed-1', 'secp-1', 'known@example.com')",
    args: [],
  });
  const { id } = await seedRow({ snapshot });

  const r = await get(listPath());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(rowById(r.json.items, id).newRecipients, ["stranger@example.com"]);

  // Cached on the row (the hint is one Gmail query per address, once).
  const stored = await store.getStaged(db, id);
  assert.deepEqual(stored.newRecipients, ["stranger@example.com"]);

  // A contact is never asked about; a past correspondent is asked once. The address is QUOTED in
  // the query, so nothing in it can be read as Gmail search syntax.
  const asked = [...fake.sentQueries].sort();
  assert.deepEqual(asked, ['in:sent to:"stranger@example.com"', 'in:sent to:"written@example.com"']);
  const before = fake.calls.sentTo;
  await get(listPath());
  assert.equal(fake.calls.sentTo, before, "the second read uses the cache");
});

test("five lists of one row make one search per address, at most", async () => {
  // A REAL "none": both addresses are past correspondents. The empty answer is cached as "[]", so
  // the card's read never becomes a Gmail query again — it used to be thrown away and re-asked,
  // once per address per read.
  fake = createFakeGmail({ drafts: { d1: draftFor({ to: "written@example.com, also@example.com" }) } });
  fake.sentTo.add("written@example.com");
  fake.sentTo.add("also@example.com");
  const { id } = await seedRow({
    snapshot: { to: ["also@example.com", "written@example.com"], cc: [], bcc: [], subject: "Hello", body: "Hello there" },
  });

  for (let i = 0; i < 5; i++) {
    const r = await get(listPath());
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(rowById(r.json.items, id).newRecipients, [], `read ${i + 1}: a real "none" is shown`);
  }
  assert.equal(fake.calls.sentTo, 2, "one search per address, ever");
  assert.deepEqual((await store.getStaged(db, id)).newRecipients, [], "the empty answer is cached on the row");
});

test("owner only", async () => {
  const cases = [
    ["an SSO session", SSO_TOKEN, true, 403],
    ["a session minted on this machine", ONHOST_TOKEN, true, 403],
    ["a request from this machine", OWNER_TOKEN, false, 403],
    ["no session", null, true, 401],
  ];
  for (const [label, token, laptop, status] of cases) {
    const { id, row } = await seedRow();
    const opts = { token, laptop };
    const answers = [
      await get(listPath(), opts),
      await post(sendPath(id), { content_hash: row.contentHash }, opts),
      await post(editPath(id), { to: ["alex@example.com"], cc: [], bcc: [], subject: "S", body: "B" }, opts),
      await post(discardPath(id), {}, opts),
    ];
    for (const r of answers) {
      assert.equal(r.status, status, `${label}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, status === 403 ? { error: "not_owner" } : { error: "unauthorized" }, label);
    }
    // Refused before anything was read or written.
    assert.equal(fake.calls.get, 0, `${label}: the provider was never read`);
    assert.equal(fake.calls.send, 0, `${label}: nothing was sent`);
    assert.equal(fake.updates.length, 0, `${label}: nothing was updated`);
    const after = await store.getStaged(db, id);
    assert.equal(after.state, "staged", `${label}: the row is untouched`);
    assert.equal(after.contentHash, row.contentHash, `${label}: the snapshot is untouched`);
  }
});

test("an unfaithful draft settles failed and is not sent", async () => {
  // A Reply-To: a shape Crow cannot rebuild from the approved snapshot, so the operator sends it
  // from Gmail (gmail-client.js `faithful`).
  const raw = makeDraftRaw().replace("To: alex@example.com\r\n", "To: alex@example.com\r\nReply-To: other@example.com\r\n");
  fake = createFakeGmail({ drafts: { d1: { raw, threadId: "t1" } } });
  const { id, row } = await seedRow();

  const r = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: false, state: "failed", failReason: "This draft can only be sent from Gmail" });
  assert.equal(fake.calls.send, 0);
  const after = await store.getStaged(db, id);
  assert.equal(after.state, "failed");
  assert.equal(after.failReason, "This draft can only be sent from Gmail");
});

test("a row with no credential is never sent or edited", async () => {
  const { id, row } = await seedRow({ credRef: null });

  const send = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(send.status, 409);
  assert.deepEqual(send.json, { error: "open_in_gmail" });

  const edit = await post(editPath(id), { to: ["alex@example.com"], cc: [], bcc: [], subject: "S", body: "B" });
  assert.equal(edit.status, 409);
  assert.deepEqual(edit.json, { error: "open_in_gmail" });

  assert.equal(fake.calls.get + fake.calls.send + fake.calls.update, 0, "the provider is never touched");
  const after = await store.getStaged(db, id);
  assert.equal(after.state, "staged");
  assert.equal(after.contentHash, row.contentHash);

  // "Not now" is still the operator's to give: a row Crow cannot send can be dismissed.
  assert.equal((await post(discardPath(id), {})).status, 200);
  assert.equal((await store.getStaged(db, id)).state, "discarded");
});

test("a stuck sending row is settled on list", async () => {
  fake = createFakeGmail({ drafts: { d1: draftFor() } });   // d2 is gone
  const readable = await seedRow({ providerDraftId: "d1" });
  const gone = await seedRow({ providerDraftId: "d2" });
  // Older than the ten-minute threshold: the claim is a crash, not a send that is still going.
  const stale = Date.now() - 15 * 60 * 1000;
  for (const { id, row } of [readable, gone]) {
    assert.equal(await store.claimSend(db, id, row.contentHash), true, "the send was taken and never finished");
    await db.execute({ sql: "UPDATE staged_sends SET updated_at = ? WHERE id = ?", args: [stale, id] });
  }

  const r = await get(listPath());
  assert.equal(r.status, 200, r.text);
  assert.equal(rowById(r.json.items, readable.id).state, "staged", "still there: the claim never reached the provider");
  const settledGone = rowById(r.json.items, gone.id);
  assert.equal(settledGone.state, "failed");
  assert.equal(settledGone.failReason, "Sent or deleted in Gmail");
  assert.equal(fake.calls.send, 0, "a retry is never issued for an interrupted send");
});

test("edit refuses a bad address and changes nothing", async () => {
  const { id, row } = await seedRow();
  for (const to of [["Bob"], ["a@example.com b@example.com"], [], "alex@example.com", ["Alex <alex@example.com>"]]) {
    const r = await post(editPath(id), { to, cc: [], bcc: [], subject: "New", body: "New body" });
    assert.equal(r.status, 400, `to=${JSON.stringify(to)}: ${r.text}`);
    assert.deepEqual(r.json, { error: "bad_address" });
  }
  assert.equal(fake.updates.length, 0, "the provider was never written");
  const after = await store.getStaged(db, id);
  assert.equal(after.state, "staged");
  assert.equal(after.contentHash, row.contentHash);
  assert.deepEqual(after.snapshot, row.snapshot);
  // And the row is still editable afterwards: nothing was half-written.
  const ok = await post(editPath(id), { to: ["alex@example.com"], cc: [], bcc: [], subject: "New", body: "New body" });
  assert.equal(ok.status, 200, ok.text);
});

/* ------------------------------------------------- the edit/send race (H1) */

/**
 * P1: an edit whose `updateDraft` fails while a send is in flight. The edit used to settle the row
 * `failed` from `sending`, so the send's own settle was lost AND the operator's next tap claimed the
 * row again — two `drafts.send` calls for one approved draft. The edit now writes its failure only
 * as a CAS on the row it claimed, so a row the send holds is never touched.
 */
test("a failed edit during a send does not reopen it", async () => {
  const { id, row } = await seedRow();

  let editEntered; const editReached = new Promise((r) => { editEntered = r; });
  let editRelease; const editGate = new Promise((r) => { editRelease = r; });
  let sendEntered; const sendReached = new Promise((r) => { sendEntered = r; });
  let sendRelease; const sendGate = new Promise((r) => { sendRelease = r; });
  gmailSeam = (credRef) => {
    const client = realClient(credRef);
    return {
      ...client,
      async updateDraft() {
        editEntered();
        await editGate;
        throw Object.assign(new Error("the provider refused the rewrite"), { code: "other" });
      },
      async sendDraft(draftId, opts) {
        sendEntered();
        await sendGate;
        return client.sendDraft(draftId, opts);
      },
    };
  };

  // The edit takes its claim first, then waits at the provider with the row still `staged`.
  const edit = post(editPath(id), { to: ["alex@example.com"], cc: [], bcc: [], subject: "Edited", body: "Edited body" });
  await editReached;

  // The operator taps Send: the claim wins and the send is away at the provider, row `sending`.
  const sending = post(sendPath(id), { content_hash: row.contentHash });
  await sendReached;
  assert.equal((await store.getStaged(db, id)).state, "sending");

  // Now the edit's rewrite fails. This is the write that used to flip a `sending` row to `failed`.
  editRelease();
  const edited = await edit;
  assert.equal(edited.status, 409, edited.text);
  assert.deepEqual(edited.json, { error: "changed" }, "the edit wrote nothing: a send had the row");
  assert.equal((await store.getStaged(db, id)).state, "sending",
    "the failed edit left the send's claim alone");

  sendRelease();
  const sent = await sending;
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(sent.json.state, "sent");
  assert.equal((await store.getStaged(db, id)).state, "sent", "the send settled normally");
  assert.equal(fake.calls.send, 1);

  // The operator taps Send again: nothing goes out a second time.
  const again = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(again.status, 409, again.text);
  assert.deepEqual(again.json, { error: "already_sent" });
  assert.equal(fake.calls.send, 1, "still exactly one drafts.send");
});

/**
 * A message that reached the provider WAS sent, whatever the row says afterwards: a lost settle (a
 * sweeper or a second device moved the claim while the send was away) is logged with the fixed line
 * and the answer still says `sent`, note and audit included.
 */
test("a lost settle after a real send is logged and still answers sent", async () => {
  const { id, row } = await seedRow();

  gmailSeam = (credRef) => {
    const client = realClient(credRef);
    return {
      ...client,
      async sendDraft(draftId, opts) {
        const sent = await client.sendDraft(draftId, opts);
        // The row is touched while the send is away: this is exactly the sweep P2 used to cause.
        await store.settle(db, id, { state: "staged" });
        return sent;
      },
    };
  };

  const { lines, result: r } = await warnings(() => post(sendPath(id), { content_hash: row.contentHash }));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, state: "sent", messageId: "msg-1" }, "the truth: it was sent");
  assert.equal(fake.calls.send, 1);
  assert.deepEqual(lines.filter((l) => l.startsWith("[staged] settle lost")), ["[staged] settle lost " + id],
    "one fixed line, the id and nothing else");

  // The bot is still told, and the audit row still records the send.
  assert.deepEqual(service.claimStagedNotes(SESSION), [
    "The operator sent your draft to 1 recipients (message msg-1).",
  ]);
  const audits = await db.execute({ sql: "SELECT details FROM audit_log WHERE event_type = 'staged_send'" });
  const mine = audits.rows
    .map((row) => JSON.parse(String(row.details)))
    .filter((details) => details.staged_id === id && details.state === "sent");
  assert.equal(mine.length, 1, "the send is still audited as sent");
  // …and the lost settle changed nothing about the message's own record of who it went to.
  assert.equal(fake.sent.length, 1);
});

/* ------------------------------------------------------ the sweeper (M1/P2) */

/**
 * P2: the sweeper used to put a live `sending` row back to `staged` once 120 s had passed, and the
 * operator's next tap sent a second copy. The threshold is ten minutes now, and the settle back to
 * `staged` is a CAS on the stamp the sweeper read.
 */
test("the sweeper never reopens a send still in flight", async () => {
  const slow = await seedRow();
  assert.equal(await store.claimSend(db, slow.id, slow.row.contentHash), true);
  await db.execute({
    sql: "UPDATE staged_sends SET updated_at = ? WHERE id = ?",
    args: [Date.now() - 5 * 60 * 1000, slow.id],
  });
  let list = await get(listPath());
  assert.equal(list.status, 200, list.text);
  assert.equal(rowById(list.json.items, slow.id).state, "sending",
    "five minutes is a send that is merely slow, not a crash");
  assert.equal(fake.calls.send, 0);

  // Past the threshold, but the row is touched while the sweeper holds it (a claim settled and
  // taken again, as a retry or a second sweeper would): the CAS leaves it alone.
  fake = createFakeGmail({ drafts: { d1: draftFor(), d2: draftFor({ subject: "Slow", body: "Slow body" }) } });
  const live = await seedRow({
    providerDraftId: "d2",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Slow", body: "Slow body" },
  });
  assert.equal(await store.claimSend(db, live.id, live.row.contentHash), true);
  await db.execute({
    sql: "UPDATE staged_sends SET updated_at = ? WHERE id = ?",
    args: [Date.now() - 11 * 60 * 1000, live.id],
  });
  gmailSeam = (credRef) => {
    const client = realClient(credRef);
    return {
      ...client,
      async getDraft(draftId) {
        const draft = await client.getDraft(draftId);
        if (draftId === "d2") {
          // The send in flight settles and re-claims its row while the sweeper is reading.
          await store.settle(db, live.id, { state: "staged" });
          await store.claimSend(db, live.id, live.row.contentHash);
        }
        return draft;
      },
    };
  };
  const { lines, result } = await warnings(() => get(listPath()));
  assert.equal(result.status, 200, result.text);
  assert.equal(rowById(result.json.items, live.id).state, "sending",
    "touched since the sweeper read it: left alone");
  assert.equal(fake.calls.send, 0, "and never sent a second time");
  assert.deepEqual(lines.filter((l) => l.startsWith("[staged] settle lost")), ["[staged] settle lost " + live.id]);
});

/* --------------------------------------------------- the edit's address rule (M2) */

test("edit refuses group syntax, header injection and control characters", async () => {
  const { id, row } = await seedRow();
  const base = { to: ["alex@example.com"], cc: [], bcc: [], subject: "New", body: "New body" };
  const cases = [
    { to: ["alex@example.com: bob@example.com;"] },
    { to: ["alex@example.com\r\nBcc: evil@example.net"] },
    { cc: ["alex@example.com:"] },
    { bcc: ["alex@example.com\u0000"] },
  ];
  for (const over of cases) {
    const r = await post(editPath(id), { ...base, ...over });
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${r.text}`);
    assert.deepEqual(r.json, { error: "bad_address" });
  }
  assert.equal(fake.updates.length, 0, "the provider was never written");
  const after = await store.getStaged(db, id);
  assert.equal(after.state, "staged");
  assert.equal(after.contentHash, row.contentHash);
  assert.deepEqual(after.snapshot, row.snapshot);

  // A lone address passes (and is lower-cased, trimmed); that is exactly what the card posts.
  const ok = await post(editPath(id), { ...base, to: [" Alex@Example.COM "] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(fake.updates.length, 1);
  assert.deepEqual((await store.getStaged(db, ok.json.id)).snapshot.to, ["alex@example.com"]);
});

/* ------------------------------------------- the ambiguous failure and its retry */

test("a retry after an ambiguous send failure never sends twice", async () => {
  // Gmail accepted the draft and deleted it, but the answer never arrived. From the gateway the
  // failure is indistinguishable from one before the send, so the row settles `failed` and stays
  // retryable — and the retry's re-read is a 404, so nothing goes out a second time.
  fake = createFakeGmail({ drafts: { d1: draftFor() } });
  fake.sentDeletesDraft = true;
  let lost = false;
  gmailSeam = (credRef) => createClient({
    credRef,
    configPaths,
    fetchImpl: async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (!lost && String(url).endsWith("/drafts/send")) {
        lost = true;
        return { ok: false, status: 502, json: async () => ({}), text: async () => "" };
      }
      return res;
    },
  });
  const { id, row } = await seedRow();

  const first = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, { ok: false, state: "failed", failReason: "Gmail could not send this draft" });
  assert.equal(fake.calls.send, 1);
  assert.equal(fake.sent.length, 1, "the message really did go out");
  assert.equal((await store.getStaged(db, id)).state, "failed");

  const retry = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(retry.status, 200, retry.text);
  assert.deepEqual(retry.json, { ok: false, state: "failed", failReason: "This draft is gone from Gmail" });
  assert.equal(fake.calls.send, 1, "no second drafts.send");
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.errorBodyReads, 0, "and no failed response body was read");
});

/* ------------------------------------------------- non-provider failures, and logs */

test("a non-GmailError throw logs the fixed class-only line", async () => {
  const { id, row } = await seedRow();
  gmailSeam = () => ({
    async getDraft() {
      throw Object.assign(new Error("alex@example.com is not a draft"), { name: "TypeError" });
    },
  });

  const { lines, result: r } = await warnings(() => post(sendPath(id), { content_hash: row.contentHash }));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: false, state: "failed", failReason: "Gmail could not send this draft" });
  assert.deepEqual(lines, ["[staged] send failed: TypeError"], "the class only, never the message");
  assert.ok(!lines.join("\n").includes("alex@example.com"), "no address in a log");
  assert.equal(fake.calls.send, 0);
});

/* --------------------------------------------------------------- the parser split (L2) */

test("a trailing-slash POST still uses the route's own parser", async () => {
  const { id } = await seedRow();
  // Express routes non-strictly, so `/…/edit/` reaches the same route: the gateway's global 1mb
  // parser must skip it too, or a body carrying a draft would be read and logged by THAT handler.
  const { lines, result: r } = await warnings(() =>
    post("/dashboard/perch-api/staged/" + encodeURIComponent(id) + "/edit/", `{"to": "alex@example.com"`));
  assert.equal(r.status, 400, r.text);
  assert.deepEqual(r.json, { error: "bad_body" });
  assert.deepEqual(lines, ["[perch-interactive-api] bad body"], "the perch router's handler, not the global one");
  assert.equal(fake.updates.length, 0);
  assert.equal((await store.getStaged(db, id)).state, "staged");
});

/* --------------------------------------------------- unfaithful drafts and channels */

test("an unfaithful draft is never stripped by an edit", async () => {
  // An edit rewrites the whole message from the card's five fields, so rewriting a draft Crow cannot
  // rebuild (here: a Reply-To; an attachment is the same verdict) would drop what the operator never
  // saw. The edit refuses and points at Gmail instead.
  const raw = makeDraftRaw().replace("To: alex@example.com\r\n", "To: alex@example.com\r\nReply-To: other@example.com\r\n");
  fake = createFakeGmail({ drafts: { d1: { raw, threadId: "t1" } } });
  const { id, row } = await seedRow();

  const r = await post(editPath(id), { to: ["alex@example.com"], cc: [], bcc: [], subject: "New", body: "New body" });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, { error: "open_in_gmail" });
  assert.equal(fake.updates.length, 0, "Gmail was never written");
  const after = await store.getStaged(db, id);
  assert.equal(after.state, "staged");
  assert.equal(after.contentHash, row.contentHash);
  assert.deepEqual(after.snapshot, row.snapshot);
});

test("a send on another channel is refused", async () => {
  const { id, row } = await seedRow({ channel: "slack" });
  const r = await post(sendPath(id), { content_hash: row.contentHash });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, { error: "unsupported_channel" });
  assert.equal(fake.calls.get + fake.calls.send, 0, "the provider was never read");
  assert.equal((await store.getStaged(db, id)).state, "staged");
});

/* ------------------------------------------------------------------ the note queue (L6) */

test("a taken note queue is evicted, not left empty behind", () => {
  service.addStagedNote("s-note", "The operator discarded your draft.");
  assert.deepEqual(service.claimStagedNotes("s-note"), ["The operator discarded your draft."]);
  assert.equal(service._stagedNotesForTest("s-note"), null, "the entry is gone, not kept empty");

  service.returnStagedNotes("s-note-2", []);
  assert.equal(service._stagedNotesForTest("s-note-2"), null, "an empty hand-back creates nothing");

  service.returnStagedNotes("s-note-3", ["line"]);
  assert.deepEqual(service.claimStagedNotes("s-note-3"), ["line"]);
  assert.equal(service._stagedNotesForTest("s-note-3"), null);
});