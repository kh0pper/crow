// Crow Mail's attachment download (plan 2, Task 5a): the bytes of one attachment out of one message
// on the server, the extractor plan 3 imports to forward an attachment, and the two header-safe
// spellings of a filename a download answer carries.
//
// Harness: plan 1's Task 19 (tests/mail-api-messages.test.js) — a real init-db'd scratch crow.db
// copied per test (CROW_DATA_DIR, so nothing can touch ~/.crow), an ephemeral express app wired the
// way servers/gateway/index.js and dashboard/index.js wire it (the Funnel refusal first, then a
// session stub, the dashboard's real CSRF middleware, then the real mail API router), the real
// account, folder and message stores, and a fake mail adapter behind a supervisor that records its
// calls. The refusals of a claimed or signed-out account are driven through the real supervisor, so
// "the adapter factory is never called" is that module's own answer, not a stub's.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "mail-reader-attachments-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { mailApiRouter, clearMailApiRuntime, MAIL_API_PREFIX } = await import("../servers/gateway/routes/mail-api.js");
const { rejectFunneledMiddleware } = await import("../servers/gateway/funnel.js");
const { MAIL_ERROR_TEXT } = await import("../servers/gateway/mail/errors.js");
const { createMailSupervisor } = await import("../servers/gateway/mail/sync/supervisor.js");
const { parseRawMessageFull } = await import("../servers/gateway/mail/parse.js");
const { createAccount, updateAccount } = await import("../servers/gateway/mail/store/accounts.js");
const {
  getMessage, upsertFolders, upsertMessage,
} = await import("../servers/gateway/mail/store/messages.js");
const {
  MAX_ATTACHMENT_BYTES, encodeRfc5987, extractAttachment, extractAttachmentFromParsed,
  safeAttachmentName,
} = await import("../servers/gateway/mail/reader/attachments.js");
const { messageViewHtml } = await import("../servers/gateway/dashboard/panels/mail/html.js");
const { createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";

/** The operator-approved copy both 413 `too_large` answers carry, pinned here as the approved text. */
const ATTACHMENT_TOO_LARGE_TEXT = "This attachment is over about 18 MB, too large to download here.";

const MESSAGES = `${MAIL_API_PREFIX}/messages`;
const attachmentPath = (id, index) => `${MESSAGES}/${id}/attachments/${index}`;

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

const open = [];
const servers = [];
after(() => {
  clearMailApiRuntime();
  for (const s of servers) s.close();
  for (const c of open) { try { c.close(); } catch { /* closed */ } }
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
  clearMailApiRuntime();
  process.env.CROW_MAIL = "1";
});

/* ------------------------------------------------------------------ HTTP */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let server = null;

/** One request, the body as bytes (an attachment is binary) plus its text and JSON forms. */
function call(method, path, { body, headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) };
  if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
  if (token && csrf) h["x-crow-csrf"] = csrf;
  if (laptop) h["x-test-from"] = "laptop";
  Object.assign(h, headers);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(bytes.toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString("utf8"), json });
      });
    });
    req.on("error", reject);
    req.end(payload === null ? undefined : payload);
  });
}

const get = (path, opts) => call("GET", path, opts);

/** Wait until `predicate()` holds: a background call lands after its answer is sent. */
async function waitFor(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/* ----------------------------------------------------------------- setup */

let n = 0;

/** A supervisor that hands the fake adapter of one account to `fn`, and records its own calls. */
function makeSupervisor(adapterFor) {
  const calls = [];
  return {
    calls,
    async syncNow(accountId) { calls.push(["syncNow", accountId]); },
    async requestSync(accountId) { calls.push(["requestSync", accountId]); },
    async withAdapter(accountId, fn) {
      calls.push(["withAdapter", accountId]);
      return fn(adapterFor(accountId));
    },
  };
}

/**
 * One scratch database and one app. With `realSupervisor` the supervisor is plan 1's own module, so
 * its refusals for a claimed or signed-out account are what the route meets; `factoryCalls` records
 * whether an adapter was ever built.
 */
async function setup({ realSupervisor = false, factoryCalls = [] } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const db = createDbClient(crow);
  open.push(db);

  const adapters = new Map();
  const adapterFor = (accountId) => {
    if (!adapters.has(accountId)) adapters.set(accountId, createFakeMailAdapter());
    return adapters.get(accountId);
  };
  const supervisor = realSupervisor
    ? createMailSupervisor({
      db,
      credentials: null,
      adapterFactory: () => {
        factoryCalls.push("adapter");
        return createFakeMailAdapter();
      },
    })
    : makeSupervisor(adapterFor);

  const app = express();
  // servers/gateway/index.js's split, using the REAL predicate read from its source: the global 1mb
  // parser skips the paths whose router parses its own body.
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  assert.ok(predicate, "index.js's _hasOwnParser is where it was");
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  const globalJson = expressJson({ limit: "1mb" });
  app.use(rejectFunneledMiddleware());
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));

  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(mailApiRouter(sessionGate, { openDb: () => createDbClient(crow), supervisor }));
  app.use(dash);

  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);

  const count = async (table, where = "", args = []) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`, args });
    return Number(rows[0].n);
  };

  return { db, crow, adapters, adapterFor, supervisor, factoryCalls, count };
}

/* ----------------------------------------------------------------- seeds */

const ENDPOINT = { host: "mail.example.test", port: 993, security: "ssl" };
const DEFAULT_FOLDERS = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  { path: "Sent", name: "Sent", specialUse: "\\Sent", delimiter: "/" },
];

const DATE_HEADER = "Wed, 01 Oct 2025 10:00:00 +0000";
const DATE_MS = Date.parse(DATE_HEADER);
const BOUNDARY = "b1";

/** The invisible format characters a filename may not carry into a header: the zero-width and bidi
 *  marks, the bidi embeddings and overrides, the bidi isolates, the Arabic letter mark and a BOM. */
const INVISIBLE_CODES = [
  0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
];

const TEXT_BYTES = Buffer.from("first attachment body\n", "utf8");
const PDF_BYTES = Buffer.from("%PDF-1.4\n% a small pdf\n", "utf8");
const HTML_BYTES = Buffer.from("<!doctype html><p>a page</p>", "utf8");
const INLINE_BYTES = Buffer.from("inline-image-bytes", "utf8");

async function seedAccount(s, { address = "alex@example.com", label = "Personal" } = {}) {
  const account = await createAccount(s.db, {
    label,
    address,
    authKind: "password",
    imap: ENDPOINT,
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const listed = await upsertFolders(s.db, account.id, DEFAULT_FOLDERS);
  return {
    account,
    folders: listed.folders,
    inbox: listed.folders.find((folder) => folder.path === "INBOX"),
  };
}

/* ---------------------------------------------------------------- messages */

/** One MIME part block: its headers as written, then its body as written. */
function mimePart(headers, body) {
  return [`--${BOUNDARY}`, ...headers, "", body].join("\r\n");
}

/** A multipart/mixed message holding the parts given, in that order. */
function messageWith(parts, { messageId = "<files-1@mail.example.test>", subject = "Files" } = {}) {
  return [
    "From: Sam <sam@example.com>",
    "To: Alex <alex@example.com>",
    `Subject: ${subject}`,
    `Date: ${DATE_HEADER}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    ...parts,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

const TEXT_PART = mimePart(['Content-Type: text/plain; charset="utf-8"'], "Hello there");

/**
 * One attachment part. `filenameHeader` replaces the generated filename parameter verbatim, so a test
 * can send the RFC 2231 form (the one that carries an arbitrary name).
 */
function attachmentPart({
  type, filename = null, bytes = Buffer.alloc(0), encoding = "base64",
  contentId = null, disposition = "attachment", filenameHeader = null,
}) {
  const nameParam = filenameHeader !== null ? filenameHeader : (filename ? `; filename="${filename}"` : "");
  const headers = [`Content-Type: ${type}${filename && filenameHeader === null ? `; name="${filename}"` : ""}`];
  if (contentId) headers.push(`Content-ID: <${contentId}>`);
  headers.push(`Content-Disposition: ${disposition}${nameParam}`);
  if (encoding) headers.push(`Content-Transfer-Encoding: ${encoding}`);
  const body = encoding === "base64"
    ? Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\r\n")
    : Buffer.from(bytes).toString("utf8");
  return mimePart(headers, body);
}

/** A message with a plain body and three parts: a text file, a PDF and an html page. */
function filesMessage(over = {}) {
  return messageWith([
    TEXT_PART,
    attachmentPart({ type: "text/plain", filename: "notes.txt", bytes: TEXT_BYTES }),
    attachmentPart({ type: "application/pdf", filename: "report.pdf", bytes: PDF_BYTES }),
    attachmentPart({ type: "text/html", filename: "page.html", bytes: HTML_BYTES }),
  ], over);
}

/** A message with an inline part beside an attached one. */
function inlineAndAttachedMessage(over = {}) {
  return messageWith([
    TEXT_PART,
    attachmentPart({
      type: "image/png",
      filename: "inline.png",
      bytes: INLINE_BYTES,
      contentId: "inline-1@mail.example.test",
      disposition: "inline",
    }),
    attachmentPart({ type: "application/pdf", filename: "report.pdf", bytes: PDF_BYTES }),
  ], over);
}

/**
 * Deliver a raw message to the fake mailbox and store the row a sync would store for it, from the
 * same parse the route compares the fetched bytes with.
 */
async function storeMessage(s, account, folder, raw, { internalDate = DATE_MS } = {}) {
  const uid = s.adapterFor(account.id).deliver(folder.path, raw, { internalDate });
  const parsed = (await parseRawMessageFull(raw)).parsed;
  const written = await upsertMessage(s.db, {
    accountId: account.id,
    folderId: folder.id,
    uid,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    replyTo: parsed.replyTo,
    date: parsed.date,
    text: parsed.text,
    html: parsed.html,
    snippet: parsed.snippet,
    attachments: parsed.attachments,
    flags: [],
    internalDate,
    truncated: parsed.truncated,
    parseError: parsed.parseError,
  });
  return { uid, id: written.id, message: await getMessage(s.db, written.id) };
}

/* ------------------------------------------------------------- the download */

test("downloads attachment 0 with the right bytes", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());

  const r = await get(attachmentPath(id, 0));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.bytes, TEXT_BYTES);
  assert.equal(Number(r.headers["content-length"]), TEXT_BYTES.length);
});

test("every attachment is octet-stream, with nosniff, the sandbox CSP, no-store and a download disposition", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());

  for (const [index, bytes] of [[0, TEXT_BYTES], [1, PDF_BYTES], [2, HTML_BYTES]]) {
    const r = await get(attachmentPath(id, index));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers["content-type"], "application/octet-stream", `index ${index}: the sender's type is not echoed`);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["content-security-policy"], "sandbox; default-src 'none'");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(r.headers["content-disposition"], /^attachment; filename="[^"]*"; filename\*=UTF-8''\S+$/);
    assert.deepEqual(r.bytes, bytes, `index ${index} carries its own bytes`);
  }
});

test("a filename with a path, a quote and unicode is sanitised in both the plain and the filename* form", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const raw = messageWith([
    TEXT_PART,
    attachmentPart({
      type: "application/octet-stream",
      bytes: TEXT_BYTES,
      filenameHeader: "; filename*=UTF-8''..%2F..%2Fse%22cret%20na%C3%AFve.txt",
    }),
  ]);
  const { id } = await storeMessage(s, account, inbox, raw);

  const r = await get(attachmentPath(id, 0));
  assert.equal(r.status, 200, r.text);
  const disposition = r.headers["content-disposition"];
  assert.equal(
    disposition,
    "attachment; filename=\"....secret na_ve.txt\"; filename*=UTF-8''....secret%20na%C3%AFve.txt",
  );
  assert.equal(disposition.includes("\r"), false, "no CR in the header");
  assert.equal(disposition.includes("\n"), false, "no LF in the header");
  assert.equal(disposition.includes("%2F"), false, "no path separator survives");
  assert.equal(disposition.includes("se%22cret"), false, "the quote is gone");
});

test("encodeRfc5987 escapes the four characters encodeURIComponent leaves alone", () => {
  assert.equal(encodeRfc5987("a'b(c)*"), "a%27b%28c%29%2A");
  const encoded = encodeRfc5987("naïve report (1)*.txt");
  for (const raw of ["'", "(", ")", "*"]) assert.equal(encoded.includes(raw), false, `${raw} is encoded`);
  assert.equal(encoded, "na%C3%AFve%20report%20%281%29%2A.txt");
});

test("safeAttachmentName drops bidi and invisible format characters", () => {
  assert.equal(safeAttachmentName("report\u202efdp.exe"), "reportfdp.exe");
  for (const code of INVISIBLE_CODES) {
    const ch = String.fromCodePoint(code);
    const label = `U+${code.toString(16).toUpperCase()}`;
    assert.equal(safeAttachmentName(`a${ch}b.txt`), "ab.txt", `${label} is dropped`);
    assert.equal(safeAttachmentName(`${ch}${ch}`), "attachment", `${label} alone leaves no name`);
  }
});

test("safeAttachmentName strips separators, quotes and control characters, and caps at 120", () => {
  assert.equal(safeAttachmentName("../../se\"cret\r\nname naïve.txt"), "....secretname naïve.txt");
  assert.equal(safeAttachmentName("notes.txt"), "notes.txt");
  assert.equal(safeAttachmentName(""), "attachment");
  assert.equal(safeAttachmentName(null), "attachment");
  const long = safeAttachmentName("a".repeat(200));
  assert.equal(long.length, 120);
  assert.equal(Array.from(long).length, 120);
});

test("a filename carrying a right-to-left override keeps none of it in either header form", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const raw = messageWith([
    TEXT_PART,
    attachmentPart({
      type: "application/octet-stream",
      bytes: TEXT_BYTES,
      filenameHeader: "; filename*=UTF-8''report%E2%80%AEfdp.exe",
    }),
  ]);
  const { id } = await storeMessage(s, account, inbox, raw);

  const r = await get(attachmentPath(id, 0));
  assert.equal(r.status, 200, r.text);
  const disposition = r.headers["content-disposition"];
  assert.equal(
    disposition,
    "attachment; filename=\"reportfdp.exe\"; filename*=UTF-8''reportfdp.exe",
  );
  for (const code of INVISIBLE_CODES) {
    const ch = String.fromCodePoint(code);
    const label = `U+${code.toString(16).toUpperCase()}`;
    assert.equal(disposition.includes(ch), false, `${label} is absent from the header`);
    assert.equal(disposition.includes(encodeRfc5987(ch)), false, `${label} is absent from filename*`);
  }
});

test("the attachment index is the one GET /messages/:id lists, for inline and attached parts", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, inlineAndAttachedMessage());

  const listed = await get(`${MESSAGES}/${id}`);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.attachments.map((entry) => entry.filename), ["inline.png", "report.pdf"]);

  const expected = [INLINE_BYTES, PDF_BYTES];
  for (let index = 0; index < expected.length; index += 1) {
    const r = await get(attachmentPath(id, index));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.bytes, expected[index], `index ${index} is ${listed.json.attachments[index].filename}`);
    assert.equal(listed.json.attachments[index].size, expected[index].length, "the listed size is the served size");
  }
});

test("an index out of range, negative or non-numeric is 404", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());

  for (const index of ["3", "99", "-1", "one", "1.5"]) {
    const r = await get(attachmentPath(id, index));
    assert.equal(r.status, 404, `${index}: ${r.text}`);
    assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, index);
  }
});

test("a message the adapter reports with an empty Buffer is 413 too_large, not 404", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id, uid } = await storeMessage(s, account, inbox, filesMessage());
  const adapter = s.adapterFor(account.id);
  adapter.get = async () => [{ uid, flags: [], internalDate: DATE_MS, raw: Buffer.alloc(0) }];

  const r = await get(attachmentPath(id, 0));
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json.error, "too_large");
  assert.equal(r.json.message, ATTACHMENT_TOO_LARGE_TEXT);
});

test("an attachment over MAX_ATTACHMENT_BYTES is 413", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);

  // A part sent as 8bit rather than base64, so a body over the ceiling still fits under the raw limit:
  // base64 inflates by a third, which is why the raw-size rule is the one a person meets first.
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0x41);
  const head = Buffer.from([
    "From: Sam <sam@example.com>",
    "To: Alex <alex@example.com>",
    "Subject: A big file",
    `Date: ${DATE_HEADER}`,
    "Message-ID: <big@mail.example.test>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Hello there",
    `--${BOUNDARY}`,
    'Content-Type: application/octet-stream; name="big.bin"',
    'Content-Disposition: attachment; filename="big.bin"',
    "Content-Transfer-Encoding: 8bit",
    "",
    "",
  ].join("\r\n"), "utf8");
  const raw = Buffer.concat([head, big, Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8")]);

  const uid = s.adapterFor(account.id).deliver(inbox.path, raw, { internalDate: DATE_MS });
  const written = await upsertMessage(s.db, {
    accountId: account.id,
    folderId: inbox.id,
    uid,
    messageId: "<big@mail.example.test>",
    subject: "A big file",
    from: { name: "Sam", address: "sam@example.com" },
    to: [],
    cc: [],
    replyTo: [],
    date: DATE_MS,
    text: "Hello there",
    html: null,
    snippet: "Hello there",
    attachments: [{ filename: "big.bin", contentType: "application/octet-stream", size: big.length }],
    flags: [],
    internalDate: DATE_MS,
  });

  const r = await get(attachmentPath(written.id, 0));
  assert.equal(r.status, 413, r.text.slice(0, 200));
  assert.equal(r.json.error, "too_large");
  assert.equal(r.json.message, ATTACHMENT_TOO_LARGE_TEXT);
});

test("the frame, attachment and password routes log no query string and no password", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());
  const password = "seeded-app-password-not-for-a-log";

  // The password is planted where a leak would come from: an adapter failure that quotes it, the way a
  // driver's own text can. The download must answer the fixed code sentence and log its code only.
  s.adapterFor(account.id).get = async () => {
    throw new Error(`cannot open the message with ${password} (asked with images=1)`);
  };
  // A claimed account is refused before the probe, so the password route reads its body here and
  // dials nothing.
  await updateAccount(s.db, account.id, { status: "claimed_elsewhere" });

  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => { lines.push(args.map((arg) => String(arg)).join(" ")); };
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    const frame = await get(`${MESSAGES}/${id}/frame?images=1`);
    assert.equal(frame.status, 200, frame.text);

    const download = await get(attachmentPath(id, 0));
    assert.equal(download.status, 502, download.text);
    assert.equal(download.text.includes(password), false);

    const refused = await call("PUT", `${MAIL_API_PREFIX}/accounts/${account.id}/password`, {
      body: { password },
    });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.text.includes(password), false);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.ok(lines.some((line) => line.includes("PROTOCOL")), "the failed fetch logs its own code");
  for (const line of lines) {
    assert.equal(line.includes("images=1"), false, `no log line carries the query string: ${line}`);
    assert.equal(line.includes(password), false, `no log line carries the password: ${line}`);
  }
});

test("a uid the server no longer holds is 404", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id, uid } = await storeMessage(s, account, inbox, filesMessage());
  s.adapterFor(account.id).expunge(inbox.path, uid);

  const r = await get(attachmentPath(id, 0));
  assert.equal(r.status, 404, r.text);
  assert.deepEqual(r.json, { error: "not_found", message: "Not found." });
});

test("a different message at the row's uid is 409 changed_on_server, with no bytes and a full sync", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const stored = await storeMessage(s, account, inbox, filesMessage({ messageId: "<real@mail.example.test>" }));
  const adapter = s.adapterFor(account.id);

  // The folder's UIDs all mean something else now, and the uid the row remembers holds a different
  // message: `get` takes no UIDVALIDITY argument, so the fetched content is what says so.
  adapter.bumpUidValidity(inbox.path);
  adapter.expunge(inbox.path, stored.uid);
  const other = messageWith([
    TEXT_PART,
    attachmentPart({ type: "text/plain", filename: "other.txt", bytes: Buffer.from("other", "utf8") }),
  ], { messageId: "<other@mail.example.test>", subject: "Other" });
  const otherUid = adapter.deliver(inbox.path, other, { internalDate: DATE_MS });
  const realGet = adapter.get.bind(adapter);
  adapter.get = async (path, uids) => (await realGet(path, [otherUid]))
    .map((item) => ({ ...item, uid: uids[0] }));

  const r = await get(attachmentPath(stored.id, 0));
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, "changed_on_server");
  assert.equal(r.json.message, MAIL_ERROR_TEXT.CHANGED);
  assert.equal(r.text.includes(TEXT_BYTES.toString("utf8")), false, "no bytes of either message");
  await waitFor(
    () => s.supervisor.calls.some(([name, id]) => name === "requestSync" && id === account.id),
    "a full sync",
  );
});

test("a message whose Message-ID, From and Date all match is served", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const stored = await storeMessage(s, account, inbox, filesMessage());
  assert.equal(stored.message.messageId, "<files-1@mail.example.test>");
  assert.equal(stored.message.fromAddr, "sam@example.com");

  const r = await get(attachmentPath(stored.id, 1));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.bytes, PDF_BYTES);
});

test("a claimed_elsewhere or auth_failed account is refused and the adapter factory is never called", async () => {
  const factoryCalls = [];
  const s = await setup({ realSupervisor: true, factoryCalls });
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());

  for (const [status, code, httpStatus] of [
    ["claimed_elsewhere", "CLAIMED_ELSEWHERE", 409],
    ["auth_failed", "AUTH_FAILED", 400],
  ]) {
    await updateAccount(s.db, account.id, { status });
    const r = await get(attachmentPath(id, 0));
    assert.equal(r.status, httpStatus, `${status}: ${r.text}`);
    assert.equal(r.json.error, code);
    assert.equal(r.json.message, MAIL_ERROR_TEXT[code]);
  }
  assert.deepEqual(factoryCalls, [], "no connection was opened");
});

test("a failing adapter answers only the fixed sentence", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());
  const adapter = s.adapterFor(account.id);
  adapter.get = async () => {
    throw new Error("get failed for alex@example.com on mail.example.test with swordfish");
  };

  const r = await get(attachmentPath(id, 0));
  assert.equal(r.status, 502, r.text);
  assert.deepEqual(r.json, { error: "PROTOCOL", message: MAIL_ERROR_TEXT.PROTOCOL });
  for (const value of ["alex@example.com", "mail.example.test", "swordfish"]) {
    assert.equal(r.text.includes(value), false, `the answer carries no ${value}`);
  }
});

test("flag unset is 404, a peer SSO session 403, and a Funnel-flagged request rejected", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const { id } = await storeMessage(s, account, inbox, filesMessage());

  delete process.env.CROW_MAIL;
  try {
    const r = await get(attachmentPath(id, 0));
    assert.equal(r.status, 404, r.text);
    assert.deepEqual(r.json, { error: "not_found", message: "Not found." });
  } finally {
    process.env.CROW_MAIL = "1";
  }

  const sso = await get(attachmentPath(id, 0), { token: SSO });
  assert.equal(sso.status, 403, sso.text);
  assert.deepEqual(sso.json, { error: "owner_only", message: "Only the owner can see this." });
  assert.equal(sso.text.includes(TEXT_BYTES.toString("utf8")), false);

  const funneled = await get(attachmentPath(id, 0), { headers: { "tailscale-funnel-request": "1" } });
  assert.equal(funneled.status, 403, funneled.text);
  assert.equal(funneled.text.includes(TEXT_BYTES.toString("utf8")), false);
});

/* -------------------------------------------------------------- the extractor */

test("extractAttachment returns null for garbage and never throws", async () => {
  for (const raw of [Buffer.from("not a message at all\r\n\r\n"), Buffer.alloc(0), Buffer.from([0xff, 0x00, 0xfe])]) {
    assert.equal(await extractAttachment(raw, 0), null);
  }
  const raw = filesMessage();
  assert.equal(await extractAttachment(raw, -1), null);
  assert.equal(await extractAttachment(raw, 1.5), null);
  assert.equal(await extractAttachment(raw, "zero"), null);
  assert.equal(await extractAttachment(raw, 99), null);

  const first = await extractAttachment(raw, 0);
  assert.equal(first.filename, "notes.txt");
  assert.equal(first.contentType, "text/plain");
  assert.equal(first.size, TEXT_BYTES.length);
  assert.deepEqual(first.content, TEXT_BYTES);
});

test("extractAttachmentFromParsed answers what extractAttachment does, from one parse", async () => {
  const raw = filesMessage();
  const full = await parseRawMessageFull(raw);

  for (const index of [0, 1, 2, "1"]) {
    assert.deepEqual(
      extractAttachmentFromParsed(full, index),
      await extractAttachment(raw, index),
      `index ${index}`,
    );
  }
  for (const index of [3, 99, -1, 1.5, "zero", null]) {
    assert.equal(extractAttachmentFromParsed(full, index), null, `index ${String(index)}`);
  }

  assert.equal(extractAttachmentFromParsed(null, 0), null);
  assert.equal(extractAttachmentFromParsed(undefined, 0), null);
  assert.equal(extractAttachmentFromParsed({}, 0), null);
  assert.equal(extractAttachmentFromParsed({ parsed: null, attachmentContents: [] }, 0), null);
  assert.equal(extractAttachmentFromParsed({ parsed: { attachments: [] }, attachmentContents: [] }, 0), null);
  assert.equal(extractAttachmentFromParsed({ parsed: { attachments: [{}] }, attachmentContents: [] }, 0), null);

  const failed = await parseRawMessageFull(Buffer.from("not a message at all\r\n\r\n"));
  assert.equal(extractAttachmentFromParsed(failed, 0), null);
});

/* ------------------------------------------------------------- the page link */

test("the message page's download link skips Turbo", () => {
  const page = messageViewHtml({
    message: {
      id: 7,
      accountId: "ma-0123456789abcdef",
      folderId: 1,
      uid: 1,
      threadId: 3,
      messageId: "<files-1@mail.example.test>",
      subject: "Files",
      fromName: "Sam",
      fromAddr: "sam@example.com",
      to: [],
      cc: [],
      date: DATE_MS,
      isRead: true,
      attachments: [{ filename: "notes.txt", contentType: "text/plain", size: TEXT_BYTES.length }],
      snippet: "Hello there",
      bodyText: "Hello there",
      bodyHtml: null,
      truncated: false,
      parseError: null,
    },
    thread: [],
    account: { id: "ma-0123456789abcdef" },
    lang: "en",
  });

  const tag = /<a class="ml-attachment-link"[^>]*>/.exec(page);
  assert.ok(tag, "the page carries the download link");
  assert.match(tag[0], /href="\/dashboard\/mail\/api\/messages\/7\/attachments\/0"/);
  assert.match(tag[0], / download/);
  assert.match(tag[0], /data-turbo="false"/);
  assert.match(tag[0], /data-turbo-prefetch="false"/);
});