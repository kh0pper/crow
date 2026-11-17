// Crow Mail's draft attachments, Save as draft, Discard and the sent receipt (plan 3, Task 12).
//
// Two harnesses, because the task has two halves. The first is the draft store's (tests/
// mail-drafts-preflight.test.js): a scratch DB built from MAIL_DDL, the account send columns,
// MAIL_DRAFTS_DDL and the `storage_files` and `contacts` tables init-db.js gives an instance, with a
// fake mail adapter behind a supervisor and a fake object store behind `makeDraftReaders`' own
// `getObject`/`isConfigured` seam, so nothing here opens a socket. The second is the draft routes'
// (tests/mail-drafts-api.test.js): a real init-db'd scratch crow.db copied per test, an ephemeral
// express app wired the way the gateway wires it (the global 1mb parser skipped by index.js's own
// `_hasOwnParser` predicate, then a session stub, the dashboard's real CSRF middleware, then the real
// mail API router), the real account and draft stores, and a recording supervisor.
//
// The services are the real ones. What the route half injects is the seam around them
// (`setMailDraftsRuntime`): a fixed clock, a keychain seed and a timer that never fires.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { MAIL_ERROR_TEXT } from "../servers/gateway/mail/errors.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import { createDraft, getDraft, listRevisions } from "../servers/gateway/mail/drafts/store.js";
import { MAX_SEND_BYTES, preflight } from "../servers/gateway/mail/drafts/preflight.js";
import { MAX_SEND_BYTES as READERS_MAX_SEND_BYTES, makeDraftReaders } from "../servers/gateway/mail/drafts/readers.js";
import { CHANGED_SENTENCE, SEND_FAIL_REASONS } from "../servers/gateway/mail/send/send-service.js";
import {
  zoneOffsetMinutesAt,
  wallClockAt,
} from "../servers/gateway/mail/send/schedule-service.js";
import { instanceZone } from "../servers/shared/schedule-store.js";
import { createFakeMailAdapter, DEFAULT_FOLDERS } from "./fixtures/fake-mail-adapter.mjs";

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const HOST = "mail.example.test";
const THREAD_MID = "<files-1@mail.example.test>";
const T0 = 1_700_000_000_000;

const root = mkdtempSync(join(tmpdir(), "mail-drafts-attach-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const {
  MAIL_API_PREFIX,
  mailApiRouter,
  clearMailApiRuntime,
} = await import("../servers/gateway/routes/mail-api.js");
const {
  clearMailDraftsRuntime,
  setMailDraftsRuntime,
} = await import("../servers/gateway/routes/mail-drafts-api.js");

const OWNER = "owner-local-password-session";
const CSRF = "csrf-token-value";
const DRAFTS = `${MAIL_API_PREFIX}/drafts`;
const SEED = Buffer.from("a fixed keychain seed for the draft attachment routes");
const NOW = 1_767_225_600_000;
const SEEDED_ID = "md-0123456789abcdef";

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

const open = [];
const servers = [];
const dirs = [];

after(() => {
  clearMailApiRuntime();
  clearMailDraftsRuntime();
  for (const s of servers) s.close();
  for (const c of open) {
    try {
      c.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
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
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))")
    .run(hashToken(OWNER), "dashboard");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

beforeEach(() => {
  clearMailApiRuntime();
  clearMailDraftsRuntime();
  process.env.CROW_MAIL = "1";
});

afterEach(() => {
  clearMailDraftsRuntime();
});

/* ================================================================ the light harness */

/** The mail tables, the account send columns, the draft tables, storage_files and contacts. */
async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-drafts-attach-db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS storage_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      s3_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      bucket TEXT DEFAULT 'crow-files',
      uploaded_by TEXT,
      reference_type TEXT,
      reference_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      project_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crow_id TEXT NOT NULL UNIQUE,
      display_name TEXT,
      ed25519_pubkey TEXT NOT NULL,
      secp256k1_pubkey TEXT NOT NULL,
      email TEXT
    );
  `);
  return db;
}

async function makeAccount(db, overrides = {}) {
  const account = await createAccount(db, {
    label: "Alex",
    address: ALEX,
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
    ...overrides,
  });
  return updateAccount(db, account.id, { displayName: overrides.displayName ?? "Alex" });
}

async function seedFolder(db, accountId, { path, name, specialUse }) {
  const result = await db.execute({
    sql: `INSERT INTO mail_folders (account_id, path, name, special_use, delimiter)
          VALUES (?, ?, ?, ?, '/')`,
    args: [accountId, path, name, specialUse],
  });
  return Number(result.lastInsertRowid);
}

/** One stored message: the columns the thread reader and the attachment picker read. */
async function seedMessage(db, accountId, folderId, {
  uid = 1, messageId, threadId = null, fromAddr = SAM, subject = "Files",
  date = T0, attachments = [],
}) {
  const result = await db.execute({
    sql: `INSERT INTO mail_messages
            (account_id, folder_id, uid, thread_id, message_id, subject, from_name, from_addr,
             from_text, to_json, cc_json, reply_to_json, to_text, date, has_attachments,
             attachments_json, body_text, snippet)
          VALUES (?, ?, ?, ?, ?, ?, 'Sam', ?, ?, ?, '[]', '[]', '', ?, ?, ?, 'hello', 'hello')`,
    args: [
      accountId, folderId, uid, threadId, messageId, subject, fromAddr,
      `Sam ${fromAddr}`, JSON.stringify([{ name: "Alex", address: ALEX }]), date,
      attachments.length ? 1 : 0, JSON.stringify(attachments),
    ],
  });
  return Number(result.lastInsertRowid);
}

async function seedFile(db, {
  key, name = "notes.txt", mime = "text/plain", size = null, bucket = "crow-files", projectId = null,
}) {
  const result = await db.execute({
    sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, project_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [key, name, mime, size, bucket, projectId],
  });
  return Number(result.lastInsertRowid);
}

/**
 * A fake object store behind `makeDraftReaders`' seam: one object per key, the bytes as a stream the
 * way the real client answers, and every key it was asked for, so a test can show that a refused
 * reference never reached it.
 */
function fakeObjectStore(objects = {}) {
  const calls = [];
  return {
    calls,
    async getObject(key, opts = {}) {
      calls.push({ key, bucket: opts?.bucket ?? null });
      const found = objects[key];
      if (found == null) throw new Error("NoSuchKey");
      const buffer = Buffer.from(found);
      return { stream: Readable.from([buffer]), stat: { size: buffer.length, metaData: {} } };
    },
  };
}

/** The two readers over one scratch DB, with the object store replaced by a fake. */
function readersFor(db, { storage = fakeObjectStore(), supervisor = null } = {}) {
  return makeDraftReaders({
    db,
    supervisor,
    getObject: storage.getObject,
    isConfigured: () => true,
    defaultBucket: () => "crow-files",
  });
}

/** A RevisionInput for a reply to sam@example.com, with the attachments a test names. */
function revInput(overrides = {}) {
  return {
    to: [{ address: SAM }],
    cc: [],
    bcc: [],
    subject: "Re: Files",
    body: "Hello Sam,\n\nHere it is.\n",
    inReplyTo: THREAD_MID,
    references: [],
    attachments: [],
    ...overrides,
  };
}

async function makeDraft(db, account, overrides = {}) {
  const draft = await createDraft(db, {
    accountId: account.id,
    mode: overrides.mode ?? "reply",
    replyToMid: overrides.replyToMid ?? THREAD_MID,
    threadKey: overrides.threadKey ?? "thread-1",
    projectId: overrides.projectId ?? null,
    first: overrides.first ?? revInput(),
    author: "user",
  }, { now: () => T0 });
  const [rev] = await listRevisions(db, draft.id);
  return { account, draft, rev };
}

const BOUNDARY = "b1";

/** A multipart message with a text part and one attachment, as the adapter hands one back. */
function rawWithAttachment({ bytes, filename = "agenda.txt" }) {
  return Buffer.from([
    `From: Sam <${SAM}>`,
    `To: Alex <${ALEX}>`,
    "Subject: Files",
    "Date: Wed, 01 Oct 2025 10:00:00 +0000",
    `Message-ID: ${THREAD_MID}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Hello there",
    `--${BOUNDARY}`,
    `Content-Type: text/plain; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(bytes).toString("base64"),
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n"), "utf8");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/* ============================================================ the readers, and preflight */

test("a thread attachment ref resolves to the stored part's bytes and matches its hash", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  const bytes = Buffer.from("the agenda, as bytes");
  const raw = rawWithAttachment({ bytes });
  const fake = createFakeMailAdapter();
  const uid = fake.deliver("INBOX", raw);
  await seedMessage(db, account.id, inbox, { uid, messageId: THREAD_MID });

  const supervisor = { async withAdapter(accountId, fn) { return fn(fake); } };
  const readers = readersFor(db, { supervisor });
  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({
      attachments: [{ source: "thread", accountId: account.id, mid: THREAD_MID, index: 0, filename: "agenda.txt", size: bytes.length }],
    }),
  });

  const checked = await preflight(db, draft, rev, {
    accountId: account.id,
    deps: { readMessageRaw: readers.readMessageRaw },
  });
  assert.equal(checked.ok, true);
  const part = checked.message.attachments[0];
  assert.equal(sha256(part.content), sha256(bytes), "the bytes that would go out are the part's own");
  assert.equal(part.filename, "agenda.txt");
  assert.equal(part.contentType, "text/plain");
});

test("a storage file scoped to another project reads as absent, and its bytes are never fetched", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const elsewhere = Buffer.from("another project's notes");
  const otherId = await seedFile(db, { key: "projects/other/notes.txt", name: "notes.txt", size: elsewhere.length, projectId: 9 });
  const storage = fakeObjectStore({ "projects/other/notes.txt": elsewhere });
  const readers = readersFor(db, { storage });

  assert.equal(await readers.readStorageFile(String(otherId), { projectId: 4 }), null);
  assert.deepEqual(storage.calls, [], "the row is refused before the object store is asked for anything");

  const { draft, rev } = await makeDraft(db, account, {
    projectId: 4,
    first: revInput({
      attachments: [{ source: "storage", fileId: String(otherId), filename: "notes.txt", size: elsewhere.length }],
    }),
  });
  const refused = await preflight(db, draft, rev, {
    accountId: account.id,
    deps: { readStorageFile: (fileId, ctx) => readers.readStorageFile(fileId, ctx) },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "bad_input");
  assert.deepEqual(storage.calls, [], "nothing was read for a file this draft's project does not own");

  // The same file read from the project it belongs to, and from a draft that carries no project.
  const own = await readers.readStorageFile(String(otherId), { projectId: 9 });
  assert.equal(own.content.toString("utf8"), elsewhere.toString("utf8"));
  assert.equal(own.filename, "notes.txt");
  assert.equal(own.contentType, "text/plain");
  assert.equal(await readers.readStorageFile(String(otherId), { projectId: null }), null,
    "a project-scoped file is not readable from a draft with no project");
});

test("a storage id that is not digits reads as nothing and never reaches the object store", async () => {
  const db = await freshDb();
  const bytes = Buffer.from("the shared file");
  const id = await seedFile(db, { key: "projects/7-notes.txt", name: "notes.txt", size: bytes.length, projectId: 7 });
  const storage = fakeObjectStore({ "projects/7-notes.txt": bytes });
  const readers = readersFor(db, { storage });

  assert.equal((await readers.readStorageFile(String(id), { projectId: 7 })).content.toString("utf8"), "the shared file");

  for (const ref of [
    "projects/7-notes.txt", // the object key itself
    "projects/other/7-notes.txt", // a key that looks like a path
    "../crow.db", // a path out of the storage prefix
    "file-1",
    `${id}abc`,
    ` ${id}`,
    "-1",
    "0x10",
    "",
    null,
    42,
    { id },
  ]) {
    assert.equal(await readers.readStorageFile(ref, { projectId: 7 }), null, `${String(ref)} names no file id`);
  }
  assert.deepEqual(storage.calls.map((call) => call.key), ["projects/7-notes.txt"],
    "only the row's own key was ever fetched, and only once");
});

test("a storage file over the send cap is refused before any byte is read", async () => {
  const db = await freshDb();
  const storage = fakeObjectStore({});
  const readers = readersFor(db, { storage });
  const id = await seedFile(db, { key: "big.bin", name: "big.bin", mime: "application/octet-stream", size: MAX_SEND_BYTES + 1 });
  assert.equal(await readers.readStorageFile(String(id), { projectId: null }), null);
  assert.deepEqual(storage.calls, [], "the row's own size is enough to refuse it");

  // A row with no recorded size is measured after the fetch, so an old row cannot slip past either.
  const unknownId = await seedFile(db, { key: "old.bin", name: "old.bin", size: null });
  const oversized = fakeObjectStore({ "old.bin": Buffer.alloc(MAX_SEND_BYTES + 1) });
  const second = readersFor(db, { storage: oversized });
  assert.equal(await second.readStorageFile(String(unknownId), { projectId: null }), null);
  assert.equal(oversized.calls.length, 1);
});

test("the 18 MiB cap counts the attachments' raw bytes, not their base64 form", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  assert.equal(MAX_SEND_BYTES, 18 * 1024 * 1024);
  assert.equal(READERS_MAX_SEND_BYTES, MAX_SEND_BYTES, "the readers and preflight cap a send at the same size");

  const half = Buffer.alloc(9 * 1024 * 1024, 7);
  const files = { "a.bin": half, "b.bin": half };
  const refs = ["a.bin", "b.bin"].map((fileId) => ({
    source: "storage", fileId, filename: fileId, size: files[fileId].length,
  }));
  const { draft, rev } = await makeDraft(db, account, { first: revInput({ attachments: refs }) });
  const deps = { readStorageFile: async (fileId) => files[fileId] };

  const exact = await preflight(db, draft, rev, { accountId: account.id, deps });
  assert.equal(exact.ok, true, "exactly 18 MiB of raw bytes is inside the cap");

  // The base64 form of the same two parts would be a third larger; only the raw sizes are counted.
  assert.ok(Math.ceil(MAX_SEND_BYTES * 4 / 3) > MAX_SEND_BYTES);
  const over = await preflight(db, draft, {
    ...rev,
    attachments: [{ source: "storage", fileId: "a.bin", filename: "a.bin", size: half.length + 1 }],
  }, {
    accountId: account.id,
    deps: { readStorageFile: async () => Buffer.alloc(MAX_SEND_BYTES + 1, 7) },
  });
  assert.equal(over.ok, false);
  assert.equal(over.code, "too_large");
});

test("a storage read that cannot happen answers nothing instead of throwing", async () => {
  const db = await freshDb();
  const id = await seedFile(db, { key: "projects/7-notes.txt", name: "notes.txt", size: 4, projectId: 7 });

  // Storage not configured: no object store to ask, so the reference resolves to nothing.
  const unconfiguredStore = fakeObjectStore({ "projects/7-notes.txt": "four" });
  const unconfigured = makeDraftReaders({
    db,
    getObject: unconfiguredStore.getObject,
    isConfigured: () => false,
    defaultBucket: () => "crow-files",
  });
  assert.equal(await unconfigured.readStorageFile(String(id), { projectId: 7 }), null);
  assert.deepEqual(unconfiguredStore.calls, []);

  // A configured store with no such object, one that throws, and one whose stream fails part-way.
  const missing = readersFor(db, { storage: fakeObjectStore({}) });
  assert.equal(await missing.readStorageFile(String(id), { projectId: 7 }), null);

  const throwing = readersFor(db, {
    storage: { async getObject() { throw new Error("the object store is down"); } },
  });
  assert.equal(await throwing.readStorageFile(String(id), { projectId: 7 }), null);

  const brokenStream = makeDraftReaders({
    db,
    getObject: async () => ({
      stream: Readable.from((async function* fail() { throw new Error("reset"); })()),
      stat: { size: 4 },
    }),
    isConfigured: () => true,
    defaultBucket: () => "crow-files",
  });
  assert.equal(await brokenStream.readStorageFile(String(id), { projectId: 7 }), null);
});

/* ============================================================ the route harness */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let n = 0;

/**
 * The scratch app: one per test, with the real router. `supervisor: false` builds a router with none
 * running; `folders` replaces the fake mailbox's folders; `runtime` adds to the injected seam.
 */
async function setup({ folders, supervisor = true, runtime = {} } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  setMailDraftsRuntime({
    loadKey: async () => SEED,
    // The hold's own timer is the send service's path, not this file's: nothing should fire.
    schedule: () => null,
    now: () => NOW,
    ...runtime,
  });

  const db = createDbClient(crow);
  open.push(db);

  const fake = createFakeMailAdapter(folders ? { folders } : {});
  const supervisorHost = supervisor
    ? {
      calls: [],
      async requestSync(accountId) {
        this.calls.push(["requestSync", accountId]);
      },
      async withAdapter(accountId, fn) {
        this.calls.push(["withAdapter", accountId]);
        return fn(fake);
      },
    }
    : null;

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
  const router = mailApiRouter(sessionGate, {
    openDb: () => createDbClient(crow),
    supervisor: supervisorHost,
  });
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(router);
  app.use(dash);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const port = server.address().port;

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
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON (the CSRF refusal is plain text)
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on("error", reject);
      req.end(payload === null ? undefined : payload);
    });
  };

  const account = await makeAccount(db);
  return { db, crow, account, supervisor: supervisorHost, fake, router, call };
}

/** One stored draft with one revision, ready for a tap. */
async function newDraft(s, over = {}) {
  return createDraft(s.db, {
    accountId: s.account.id,
    mode: over.mode ?? "new",
    replyToMid: over.replyToMid ?? null,
    threadKey: over.threadKey ?? null,
    projectId: over.projectId ?? null,
    first: {
      to: over.to ?? [{ address: SAM }],
      cc: over.cc ?? [],
      bcc: over.bcc ?? [],
      subject: over.subject ?? "Weekend",
      body: over.body ?? "Are we still on for Saturday?",
      attachments: over.attachments ?? [],
    },
    author: "user",
  });
}

/** A zone-qualified ISO instant for `at` in the instance zone, as the schedule sheet posts one. */
async function zonedTime(db, at) {
  const zone = await instanceZone(db);
  const wall = wallClockAt(at, zone);
  const offset = zoneOffsetMinutesAt(at, zone);
  const pad = (value) => String(value).padStart(2, "0");
  const sign = offset < 0 ? "-" : "+";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:00${sign}${hours}:${minutes}`;
}

/* ============================================================ Save as draft, Discard */

test("save-draft calls saveDraft once, leaves the draft where it is and names only the folder", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/save-draft`, { body: { expectHash: draft.headHash } });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true, folder: "Drafts" }, "the answer is the folder, never the content");
  assert.doesNotMatch(res.text, /Are we still on for Saturday/);

  assert.equal(s.fake.calls.filter((entry) => entry.method === "saveDraft").length, 1, "one append, one call");
  assert.equal(s.fake.drafts.length, 1);
  assert.equal(s.fake.drafts[0].folderPath, "Drafts");
  assert.match(s.fake.drafts[0].raw.toString("utf8"), /^Subject: Weekend$/m);
  assert.equal(s.fake.calls.filter((entry) => entry.method === "send").length, 0, "saving a draft sends nothing");

  const row = await getDraft(s.db, draft.id);
  assert.equal(row.state, "draft");
  assert.equal(row.headRev, 1);
  assert.equal(row.headHash, draft.headHash);
  assert.equal((await listRevisions(s.db, draft.id)).length, 1, "no revision was written");
});

test("save-draft on a mailbox with no Drafts folder gives the fixed NOT_FOUND sentence", async () => {
  const folders = DEFAULT_FOLDERS.filter((folder) => folder.specialUse !== "\\Drafts");
  const s = await setup({ folders });
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/save-draft`, { body: { expectHash: draft.headHash } });

  assert.equal(res.status, 404, res.text);
  assert.equal(res.json?.error, "not_found");
  assert.equal(res.json?.message, MAIL_ERROR_TEXT.NOT_FOUND);
  assert.equal((await getDraft(s.db, draft.id)).state, "draft");
  assert.equal(s.fake.drafts.length, 0);
});

test("save-draft on a frozen draft is 409 frozen, and on a stale hash 409 changed", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const scheduled = await s.call("POST", `${DRAFTS}/${draft.id}/schedule`, {
    body: { hash: draft.headHash, dueAt: await zonedTime(s.db, NOW + 2 * 60 * 60 * 1000) },
  });
  assert.equal(scheduled.status, 200, scheduled.text);

  const frozen = await s.call("POST", `${DRAFTS}/${draft.id}/save-draft`, { body: { expectHash: draft.headHash } });
  assert.equal(frozen.status, 409, frozen.text);
  assert.equal(frozen.json?.error, "frozen");
  assert.equal(frozen.json?.state, "scheduled");
  assert.equal(s.fake.drafts.length, 0, "a frozen draft reaches no adapter");

  const fresh = await newDraft(s);
  const stale = await s.call("POST", `${DRAFTS}/${fresh.id}/save-draft`, { body: { expectHash: "not-the-head" } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json?.error, "changed");
  assert.equal(stale.json?.message, CHANGED_SENTENCE);
  assert.equal(s.fake.drafts.length, 0);
});

test("save-draft without expectHash is 400, and with no supervisor 409 not_sendable", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  for (const body of [{}, { expectHash: 42 }, { expectHash: null }, { expectHash: "" }]) {
    const res = await s.call("POST", `${DRAFTS}/${draft.id}/save-draft`, { body });
    assert.equal(res.status, 400, JSON.stringify(body) + " -> " + res.text);
    assert.equal(res.json?.error, "bad_input");
  }
  assert.equal(s.fake.calls.filter((entry) => entry.method === "saveDraft").length, 0);

  const noSupervisor = await setup({ supervisor: false });
  const other = await newDraft(noSupervisor);
  const refused = await noSupervisor.call("POST", `${DRAFTS}/${other.id}/save-draft`, {
    body: { expectHash: other.headHash },
  });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json?.error, "not_sendable");
  assert.equal(refused.json?.message, SEND_FAIL_REASONS.supervisor_missing);
  assert.equal(refused.json?.reason, "supervisor_missing");
  assert.equal((await getDraft(noSupervisor.db, other.id)).state, "draft");
});

test("discard removes nothing from the provider", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/discard`, { body: {} });

  assert.equal(res.status, 200, res.text);
  assert.equal((await getDraft(s.db, draft.id)).state, "discarded");
  assert.deepEqual(s.fake.calls.filter((entry) => ["saveDraft", "appendToSent", "send"].includes(entry.method)), []);
  assert.equal(s.fake.drafts.length, 0);
  assert.equal(s.fake.appended.length, 0);
  assert.equal(s.fake.sent.length, 0);
});

/* ============================================================ the receipt */

test("the receipt is null until the draft is sent, and links the reader only once the copy is stored", async () => {
  const s = await setup();
  const draft = await newDraft(s);

  const before = await s.call("GET", `${DRAFTS}/${draft.id}`);
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json?.receipt, null, "an unsent draft has no receipt");

  const messageId = "<sent-1@mail.example.test>";
  const sentAt = NOW + 20_000;
  // The claim writes the Message-ID and the settle writes `sent_at`; this is that row.
  await s.db.execute({
    sql: "UPDATE mail_drafts SET state = 'sent', sent_at = ?, message_id = ? WHERE id = ?",
    args: [sentAt, messageId, draft.id],
  });

  const syncing = await s.call("GET", `${DRAFTS}/${draft.id}`);
  assert.equal(syncing.json?.receipt?.sentAt, sentAt);
  assert.equal(syncing.json?.receipt?.messageId, messageId);
  assert.equal(syncing.json?.receipt?.accountLabel, "Alex", "the account's display name, as the row carries it");
  assert.equal(syncing.json?.receipt?.readerLink, null, "the Sent copy has not been synced yet");

  const sent = await seedFolder(s.db, s.account.id, { path: "Sent", name: "Sent", specialUse: "\\Sent" });
  await seedMessage(s.db, s.account.id, sent, { uid: 3, messageId, fromAddr: ALEX, subject: "Weekend", date: sentAt });

  const linked = await s.call("GET", `${DRAFTS}/${draft.id}`);
  assert.equal(linked.json?.receipt?.readerLink,
    `/dashboard/mail?view=message&a=${s.account.id}&mid=${encodeURIComponent(messageId)}`);

  // With no display name the label is the account's address, the other field the row has.
  await updateAccount(s.db, s.account.id, { displayName: null });
  const named = await s.call("GET", `${DRAFTS}/${draft.id}`);
  assert.equal(named.json?.receipt?.accountLabel, ALEX);
});

/* ============================================================ the attachment picker */

test("attachable lists the thread's stored parts and the owner's own newest files", async () => {
  const s = await setup();
  // `storage_files.project_id` is a real reference, so the two projects a file can be filed under
  // have to exist before a row can name them.
  for (const [id, slug] of [[7, "proj-seven"], [9, "proj-nine"]]) {
    await s.db.execute({ sql: "INSERT INTO project_spaces (id, slug, name) VALUES (?, ?, ?)", args: [id, slug, slug] });
  }
  const inbox = await seedFolder(s.db, s.account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  const thread = await s.db.execute({
    sql: `INSERT INTO mail_threads (account_id, thread_key, subject, last_date, message_count, unread_count)
          VALUES (?, 'thread-1', 'Files', ?, 1, 0)`,
    args: [s.account.id, T0],
  });
  const threadId = Number(thread.lastInsertRowid);
  await seedMessage(s.db, s.account.id, inbox, {
    uid: 1, messageId: THREAD_MID, threadId,
    attachments: [
      { filename: "agenda.txt", contentType: "text/plain", size: 11, disposition: "attachment" },
    ],
  });

  // 40 files of this draft's project, 15 with no project, one of another project.
  const ids = [];
  for (let i = 1; i <= 40; i += 1) {
    ids.push(await seedFile(s.db, { key: `projects/7/f${i}.txt`, name: `f${i}.txt`, size: 100 + i, projectId: 7 }));
  }
  for (let i = 1; i <= 15; i += 1) {
    ids.push(await seedFile(s.db, { key: `global/g${i}.txt`, name: `g${i}.txt`, size: 200 + i, projectId: null }));
  }
  const foreign = await seedFile(s.db, { key: "projects/9/secret.txt", name: "secret.txt", size: 9, projectId: 9 });

  const headFile = ids[ids.length - 1];
  const draft = await newDraft(s, {
    mode: "reply",
    replyToMid: THREAD_MID,
    threadKey: "thread-1",
    projectId: 7,
    subject: "Re: Files",
    attachments: [
      { source: "storage", fileId: String(headFile), filename: "g15.txt", size: 215 },
      { source: "thread", accountId: s.account.id, mid: THREAD_MID, index: 0, filename: "agenda.txt", size: 11 },
    ],
  });

  const res = await s.call("GET", `${DRAFTS}/${draft.id}/attachable`);
  assert.equal(res.status, 200, res.text);
  const body = res.json;

  assert.deepEqual(body.thread, [{ mid: THREAD_MID, index: 0, filename: "agenda.txt", size: 11, contentType: "text/plain" }]);
  assert.equal(body.storage.length, 50, "the picker lists the newest fifty");
  assert.deepEqual(Object.keys(body.storage[0]), ["fileId", "filename", "size", "contentType"]);
  assert.ok(body.storage.every((file) => /^[0-9]+$/.test(file.fileId)), "a file id is a digits-only string");
  assert.equal(body.storage[0].fileId, String(headFile), "newest first");
  assert.ok(!body.storage.some((file) => file.fileId === String(foreign)), "another project's file is not offered");
  assert.ok(body.storage.some((file) => file.filename === "g15.txt"), "a file with no project is offered");

  assert.equal(body.maxBytes, MAX_SEND_BYTES);
  assert.equal(body.totalBytes, 226, "the head revision's own attachment sizes, raw");

  const missing = await s.call("GET", `${DRAFTS}/${SEEDED_ID}/attachable`);
  assert.equal(missing.status, 404, missing.text);
});