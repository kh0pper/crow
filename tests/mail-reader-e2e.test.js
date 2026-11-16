/**
 * Crow Mail's reader end to end (plan 2, Task 10): the real dashboard router for the pages, the real
 * mail API, the real IMAP/SMTP adapter, the real sync engine and supervisor, over the in-process fake
 * IMAP and SMTP servers (tests/fixtures/fake-mail-server.mjs). Nothing here is a fake mail adapter.
 *
 * The harness is the reader panel's (tests/mail-reader-panel.test.js): a scratch CROW_DATA_DIR and
 * CROW_HOME, an init-db'd crow.db, an ephemeral express app wired as the gateway wires it (the mail
 * API on its own router, session + CSRF, in front of the dashboard router), the real owner rule, and
 * requests shaped like Serve's, so the real dashboardAuth lets them in. The mail API router is built
 * with this file's adapter factory (the real adapter, with short budgets) and no supervisor: the one
 * `startMailSync` starts and publishes is what answers it.
 *
 * The whole run's console output and the supervisor's own log lines are captured: the app password and
 * every subject must appear in none of them. The bodies of the pages are HTML, where a subject belongs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import {
  FRAME_HELPER_CSP_SOURCE,
  FRAME_IFRAME_SANDBOX,
} from "../servers/gateway/mail/reader/frame-doc.js";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "mail-reader-e2e-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_MAIL;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-mail-reader-e2e");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const NET = serveHeaders("operator@example.com");
const OWNER = "owner-local-password-session";
const CSRF = "csrf-token-value";
const DAY = 24 * 60 * 60 * 1000;
/** Short budgets: every connect here is a loopback socket. */
const FAST = { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 8000 };

const MAIL = "/dashboard/mail";
const API = `${MAIL}/api`;
const ACCOUNTS = `${API}/accounts`;
const IMAGE_ALLOW = `${API}/image-allow`;
const framePath = (id, query = "") => `${API}/messages/${id}/frame${query}`;
const attachmentPath = (id, index) => `${API}/messages/${id}/attachments/${index}`;
const olderPath = (id) => `${API}/folders/${id}/older`;

const BREAKFAST = "A note about breakfast";
const NEWSLETTER = "A newsletter with pictures";
const FILE_NOTE = "A note with a file";
const OLD_SUBJECT = "A receipt from last winter";
const SUBJECTS = [BREAKFAST, NEWSLETTER, FILE_NOTE, OLD_SUBJECT];

/** A marker inside the newsletter's html: it belongs in the frame and nowhere on the page. */
const BODY_MARKER = "newsletter-body-marker";
const NEWSLETTER_HTML = [
  `<p>${BODY_MARKER}</p>`,
  '<img src="https://cdn.example.test/photo.png" width="10" height="10" alt="A picture">',
  '<img src="https://track.example.test/pixel.gif" width="1" height="1">',
  "<script>window.markerScript = 1</script>",
].join("");

const ATTACHMENT_NAME = "notes.txt";
const ATTACHMENT_TEXT = "the attachment's own bytes\n";
const BOUNDARY = "reader-e2e-boundary";

let server, base, MODE, imap, smtp, createImapSmtpAdapter, startMailSync;
let makeRaw, FAKE_USER, FAKE_PASSWORD, messagesStore, claims;

/* ------------------------------------------------------------------ plumbing */

/** Wait for a predicate on real time: the sockets here are real. */
async function until(predicate, { timeoutMs = 10_000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** How many times a pattern occurs in a text. */
function countOf(text, needle) {
  return String(text).split(needle).length - 1;
}

/** A CSP header split into its directives, so a test names a directive and not a regex. */
function directives(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const text = part.trim();
    if (!text) continue;
    const at = text.indexOf(" ");
    const name = at < 0 ? text : text.slice(0, at);
    out[name] = at < 0 ? "" : text.slice(at + 1).trim();
  }
  return out;
}

/** One command line as a row link in a page: the panel escapes `&` in an attribute. */
function rowHref(page, messageId) {
  const wanted = `mid=${encodeURIComponent(messageId)}`;
  const match = /<a class="ml-row" href="([^"]+)"/g;
  for (const hit of String(page).matchAll(match)) {
    if (hit[1].includes(wanted)) return hit[1].replace(/&amp;/g, "&");
  }
  return null;
}

/** A raw message with one plain body and one attached file, as a server would send it. */
function messageWithAttachment({ date = new Date(), messageId = "files@example.test" } = {}) {
  const part = (headers, body) => [`--${BOUNDARY}`, ...headers, "", body].join("\r\n");
  return [
    "From: Sam <sam@example.com>",
    "To: Alex <alex@example.com>",
    `Subject: ${FILE_NOTE}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    part(['Content-Type: text/plain; charset="utf-8"'], "The file is attached."),
    part([
      `Content-Type: text/plain; charset="utf-8"; name="${ATTACHMENT_NAME}"`,
      `Content-Disposition: attachment; filename="${ATTACHMENT_NAME}"`,
      "Content-Transfer-Encoding: base64",
    ], Buffer.from(ATTACHMENT_TEXT, "utf8").toString("base64")),
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

/* ----------------------------------------------------------------- setup */

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')")
    .run(hashToken(OWNER), "dashboard");
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const settingsDb = createDbClient();
  try { await writeSetting(settingsDb, "shell_since", "2026-01-01 00:00:00"); } finally { settingsDb.close(); }

  messagesStore = await import("../servers/gateway/mail/store/messages.js");
  claims = await import("../servers/gateway/mail/claims.js");
  ({ createImapSmtpAdapter } = await import("../servers/gateway/mail/adapter/imap-smtp.js"));
  ({ startMailSync } = await import("../servers/gateway/boot/mail-boot.js"));
  const {
    FAKE_PASSWORD: password, FAKE_USER: user, createFakeImapServer, createFakeSmtpServer, makeRaw: raw,
  } = await import("./fixtures/fake-mail-server.mjs");
  FAKE_PASSWORD = password;
  FAKE_USER = user;
  makeRaw = raw;
  const { default: express } = await import("express");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { default: mailApiRouter } = await import("../servers/gateway/routes/mail-api.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { markFromLaptop } = await import("./helpers/off-box.js");
  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);

  imap = await createFakeImapServer();
  smtp = await createFakeSmtpServer();

  const adapterFactory = ({ account, credentials }) => createImapSmtpAdapter({
    account, credentials, timeouts: FAST,
  });

  const app = express();
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  // The mail API in front of the dashboard router, so this file's factory answers it and a request
  // marked as coming from the owner's laptop passes the owner rule.
  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const apiDash = express.Router();
  apiDash.use("/dashboard", csrfMiddleware);
  apiDash.use(mailApiRouter(sessionGate, {
    openDb: () => createDbClient(DB_FILE),
    adapterFactory,
  }));
  app.use(apiDash);
  // The pages: the panel dispatch, behind the dashboard's own auth and CSRF rails.
  app.use(dashboardRouter((req, res, next) => next()));

  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  delete process.env.CROW_MAIL;
  server?.closeAllConnections?.();
  server?.close();
  await imap?.close();
  await smtp?.close();
  rmSync(dir, { recursive: true, force: true });
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

/** One request from the owner's own laptop: the session cookie, the CSRF token, Serve's headers. */
async function call(method, path, { body } = {}) {
  const headers = {
    ...NET,
    cookie: `crow_session=${OWNER}; crow_csrf=${CSRF}; ${MODE}=new`,
    "x-crow-csrf": CSRF,
    "x-test-from": "laptop",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const bytes = Buffer.from(await r.arrayBuffer());
  const text = bytes.toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, bytes, text, json };
}

const get = (path) => call("GET", path);
const post = (path, body) => call("POST", path, { body });
const del = (path) => call("DELETE", path);

/* ----------------------------------------------------------------------- test */

test("a mailbox end to end through the reader: connect, sync, open, frame, images, attachment, search, older mail, a UIDVALIDITY reset, the flag and removal", async () => {
  const db = (await import("../servers/db.js")).createDbClient(DB_FILE);
  const output = [];
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => output.push(args.map((value) => String(value)).join(" "));
  console.log = record;
  console.warn = record;
  console.error = record;

  const count = async (table) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] });
    return Number(rows[0].n);
  };
  const rowValue = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];

  let handle = null;
  try {
    process.env.CROW_MAIL = "1";

    // The 200-day-old message arrives FIRST, so it holds the lowest UID: outside the 90-day window of
    // the first sync, and only on-demand paging can reach it.
    const now = Date.now();
    imap.deliver("INBOX", makeRaw({
      subject: OLD_SUBJECT,
      body: "Paid in full.",
      messageId: "winter@example.test",
      date: new Date(now - 200 * DAY),
    }), { internalDate: new Date(now - 200 * DAY) });

    /* --------------------------------------------------------------- connect */

    const created = await post(ACCOUNTS, {
      label: "Personal",
      address: FAKE_USER,
      username: FAKE_USER,
      imap: { host: imap.host, port: imap.port, security: "none" },
      smtp: { host: smtp.host, port: smtp.port, security: "none" },
      password: FAKE_PASSWORD,
    });
    assert.equal(created.status, 201, created.text);
    const accountId = created.json.account.id;
    assert.match(accountId, /^ma-[0-9a-f]{16}$/);

    handle = await startMailSync({
      db,
      env: { CROW_MAIL: "1" },
      noAuth: false,
      adapterFactory: ({ account, credentials }) => createImapSmtpAdapter({
        account, credentials, timeouts: FAST,
      }),
      now: Date.now,
      log: (line) => logs.push(line),
    });
    assert.equal(handle.started, true);
    const supervisor = handle.supervisor;
    assert.equal(await until(async () => (await supervisor.status(accountId)).watching === true), true,
      "the first sync finished and the watch is armed");
    assert.equal(await count("mail_messages"), 0, "the 200-day-old message is outside the window");

    /* --------------------------------------------------------------- deliver */

    imap.deliver("INBOX", makeRaw({
      from: "Sam <sam@example.com>",
      subject: BREAKFAST,
      body: "A marmalade note waits inside this message.",
      messageId: "breakfast@example.test",
      date: new Date(now),
    }), { internalDate: new Date(now) });
    imap.deliver("INBOX", makeRaw({
      from: "Sam <sam@example.com>",
      subject: NEWSLETTER,
      body: "Hello there.",
      html: NEWSLETTER_HTML,
      messageId: "newsletter@example.test",
      date: new Date(now),
    }), { internalDate: new Date(now) });
    imap.deliver("INBOX", messageWithAttachment({ date: new Date(now) }), { internalDate: new Date(now) });

    assert.equal(await until(async () => (await count("mail_messages")) === 3), true,
      `the sync brought all three in (logs: ${JSON.stringify(logs).slice(0, 400)})`);

    const nudged = await post(`${ACCOUNTS}/${accountId}/sync`, {});
    assert.ok(nudged.status === 202 || nudged.status === 200, nudged.text);

    /* ----------------------------------------------------------------- inbox */

    const inbox = await get(MAIL);
    assert.equal(inbox.status, 200, inbox.text.slice(0, 400));
    for (const subject of [BREAKFAST, NEWSLETTER, FILE_NOTE]) {
      assert.equal(inbox.text.includes(subject), true, `${subject} is listed`);
    }
    assert.equal(countOf(inbox.text, 'class="ml-row"'), 3, "one row per delivered message");

    const newsletterHref = rowHref(inbox.text, "<newsletter@example.test>");
    assert.ok(newsletterHref, "the row link carries the Message-ID");
    const filesHref = rowHref(inbox.text, "<files@example.test>");
    assert.ok(filesHref, "the message with a file links by its Message-ID");

    /* ---------------------------------------------------------- open and frame */

    const opened = await get(newsletterHref);
    assert.equal(opened.status, 200, opened.text.slice(0, 400));
    assert.match(opened.text, /<h2 class="ml-msg-subject">A newsletter with pictures<\/h2>/);
    assert.match(opened.text, /<span class="ml-msg-name">Sam<\/span>/);
    assert.match(opened.text, /&lt;sam@example\.com&gt;/);
    assert.equal(opened.text.includes(BODY_MARKER), false, "the page carries no message body");
    assert.equal(countOf(opened.text, "<iframe"), 0, "no iframe in the page: the client builds it");
    assert.match(opened.text, new RegExp(`data-sandbox="${FRAME_IFRAME_SANDBOX}"`),
      "the slot carries the one sandbox value");

    const slot = /data-src="(\/dashboard\/mail\/api\/messages\/(\d+)\/frame)"/.exec(opened.text);
    assert.ok(slot, "the section carries its frame slot");
    const openedId = Number(slot[2]);

    const frame = await get(slot[1]);
    assert.equal(frame.status, 200, frame.text.slice(0, 400));
    assert.equal(frame.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
    assert.equal(frame.headers.get("cache-control"), "no-store");
    const csp = directives(frame.headers.get("content-security-policy"));
    assert.equal(csp.sandbox, FRAME_IFRAME_SANDBOX);
    assert.equal(csp.sandbox.includes("allow-scripts"), true, "the one helper runs");
    assert.equal(csp.sandbox.includes("allow-same-origin"), false, "the frame has no dashboard origin");
    assert.equal(csp["script-src"], FRAME_HELPER_CSP_SOURCE, "the helper's own hash, nothing else");
    assert.equal(csp["default-src"], "'none'");
    assert.equal(csp["img-src"], "'none'", "images are blocked by default");
    assert.equal(countOf(frame.text, "<script"), 1, "the pinned helper is the only script");
    assert.equal(frame.text.includes(BODY_MARKER), true, "the body is in the frame");
    assert.equal(frame.text.includes("markerScript"), false, "the mail's own script never reaches the frame");
    assert.doesNotMatch(frame.text, / on[a-z]+=/);
    assert.equal(frame.text.includes("photo.png"), false, "a blocked image has no source");

    /* --------------------------------------------------- images, then the sender */

    const shown = await get(framePath(openedId, "?images=1"));
    assert.equal(shown.status, 200, shown.text.slice(0, 400));
    assert.equal(directives(shown.headers.get("content-security-policy"))["img-src"], "https:");
    assert.equal(shown.text.includes("photo.png"), true, "this load shows the picture");
    assert.equal(shown.text.includes("pixel.gif"), false, "a 1x1 pixel is dropped even when images show");

    const allowed = await post(IMAGE_ALLOW, { accountId, sender: "sam@example.com" });
    assert.equal(allowed.status, 200, allowed.text);
    const bySender = await get(framePath(openedId));
    assert.equal(directives(bySender.headers.get("content-security-policy"))["img-src"], "https:",
      "an allow-listed sender's images show without asking");
    assert.equal(bySender.text.includes("photo.png"), true);
    assert.equal(bySender.text.includes("pixel.gif"), false, "the pixel is gone for an allowed sender too");

    /* ------------------------------------------------------------ attachment */

    const filesPage = await get(filesHref);
    assert.equal(filesPage.status, 200, filesPage.text.slice(0, 400));
    assert.equal(filesPage.text.includes(ATTACHMENT_NAME), true, "the attachment is named");
    const link = /<a class="ml-attachment-link" href="([^"]+)" download data-turbo="false" data-turbo-prefetch="false">/.exec(filesPage.text);
    assert.ok(link, "the message page carries the download link");
    const download = await get(link[1]);
    assert.equal(download.status, 200, download.text.slice(0, 200));
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.equal(download.headers.get("content-disposition"),
      `attachment; filename="${ATTACHMENT_NAME}"; filename*=UTF-8''${ATTACHMENT_NAME}`);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(download.bytes, Buffer.from(ATTACHMENT_TEXT, "utf8"));

    /* ---------------------------------------------------------------- search */

    const search = await get(`${MAIL}?view=search&q=marmalade`);
    assert.equal(search.status, 200, search.text.slice(0, 400));
    assert.equal(search.text.includes(BREAKFAST), true, "the body word finds its message");
    assert.ok(rowHref(search.text, "<breakfast@example.test>"), "the hit links by Message-ID");
    assert.equal(search.text.includes(NEWSLETTER), false, "the other messages are not hits");

    /* ------------------------------------------------------------ older mail */

    const inboxFolder = (await messagesStore.listFolders(db, accountId)).find((folder) => folder.role === "inbox");
    assert.ok(inboxFolder, "the INBOX folder is stored");
    const older = await post(olderPath(inboxFolder.id), {});
    assert.equal(older.status, 200, older.text);
    assert.equal(older.json.added, 1, "the 200-day-old message is fetched on demand");
    assert.equal(older.json.reachedStart, true);
    assert.equal(await count("mail_messages"), 4);
    const withOld = await get(MAIL);
    assert.equal(withOld.text.includes(OLD_SUBJECT), true, "it is in the list");

    /* ----------------------------------------------- UIDVALIDITY, then the link */

    const beforeReset = await rowValue("SELECT id FROM mail_messages WHERE message_id = ?", ["<newsletter@example.test>"]);
    assert.ok(beforeReset, "the newsletter row is stored");
    const preResetId = Number(beforeReset.id);

    imap.bumpUidValidity("INBOX");
    const afterBump = await post(`${ACCOUNTS}/${accountId}/sync`, {});
    assert.ok(afterBump.status === 202 || afterBump.status === 200, afterBump.text);
    assert.equal(await until(async () => {
      const row = await rowValue("SELECT id FROM mail_messages WHERE message_id = ?", ["<newsletter@example.test>"]);
      return row != null && Number(row.id) !== preResetId && (await count("mail_messages")) === 3;
    }), true, "the reset re-stored the messages under new row ids");

    // The link was built before the reset, so its row hint is stale: the Message-ID is what finds it.
    const again = await get(newsletterHref);
    assert.equal(again.status, 200, "the earlier link still opens its message");
    assert.match(again.text, /<h2 class="ml-msg-subject">A newsletter with pictures<\/h2>/);
    const reslot = /data-src="\/dashboard\/mail\/api\/messages\/(\d+)\/frame"/.exec(again.text);
    assert.ok(reslot, "the message has its frame slot again");
    assert.notEqual(Number(reslot[1]), preResetId, "the row under the link changed");
    const reframed = await get(framePath(reslot[1]));
    assert.equal(reframed.status, 200, reframed.text.slice(0, 200));
    assert.equal(reframed.text.includes(BODY_MARKER), true, "and it is still that message");

    /* ------------------------------------------------------------ the flag off */

    const navOn = await get("/dashboard/project/garden");
    assert.equal(navOn.status, 200);
    assert.match(navOn.text, /href="\/dashboard\/mail"/, "the drawer links the reader while the flag is on");

    // The row whose message really carries an attachment: the reset re-stored it under a new id, so
    // the flag-off download below is checked against a row that answers 200 while the flag is on.
    const filesRow = await rowValue("SELECT id FROM mail_messages WHERE message_id = ?", ["<files@example.test>"]);
    assert.ok(filesRow, "the message with a file is stored");
    const filesId = Number(filesRow.id);
    const whileOn = await get(attachmentPath(filesId, 0));
    assert.equal(whileOn.status, 200, whileOn.text.slice(0, 200));
    assert.deepEqual(whileOn.bytes, Buffer.from(ATTACHMENT_TEXT, "utf8"), "the attachment downloads with the flag on");

    delete process.env.CROW_MAIL;
    try {
      // A message is still stored: a flag that stopped being honoured would answer 200 here.
      const offPage = await get(MAIL);
      assert.equal(offPage.status, 404, "the page is a 404");
      assert.equal(offPage.text, "Not found");
      for (const path of [`${MAIL}?view=message`, `${MAIL}?view=search`, `${MAIL}?view=settings`]) {
        const r = await get(path);
        assert.equal(r.status, 404, path);
        assert.equal(r.text, "Not found", path);
      }
      const offWrite = await post(IMAGE_ALLOW, { accountId, sender: "sam@example.com" });
      assert.equal(offWrite.status, 404, "the allow list's write is a 404 too");
      assert.deepEqual(offWrite.json, { error: "not_found", message: "Not found." });
      for (const path of [framePath(reslot[1]), attachmentPath(filesId, 0), `${IMAGE_ALLOW}?account=${accountId}`]) {
        const r = await get(path);
        assert.equal(r.status, 404, path);
        assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, path);
      }
      const navOff = await get("/dashboard/project/garden");
      assert.equal(navOff.status, 200);
      assert.equal(navOff.text.includes('href="/dashboard/mail"'), false, "no drawer link with the flag off");
    } finally {
      process.env.CROW_MAIL = "1";
    }

    /* -------------------------------------------------------------- removal */

    const removed = await del(`${ACCOUNTS}/${accountId}`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.ok, true);
    assert.equal(await count("mail_messages"), 0, "the stored mail is gone with the account");
    const liveClaims = (await claims.listClaims(db, FAKE_USER)).filter((claim) => !claim.released);
    assert.deepEqual(liveClaims, [], "the claim is a tombstone now");

    const empty = await get(MAIL);
    assert.equal(empty.status, 200, empty.text.slice(0, 300));
    assert.match(empty.text, /<a [^>]*href="\/dashboard\/mail\?view=settings"[^>]*>Connect your mail<\/a>/);
    assert.equal(countOf(empty.text, "ml-row"), 0, "no rows are left to read");
    const settings = await get(`${MAIL}?view=settings`);
    assert.equal(settings.status, 200);
    assert.match(settings.text, /data-ml-add-account/, "the way to connect an account is there");

    /* ---------------------------------------------------------------- output */

    const captured = output.join("\n");
    assert.equal(captured.includes(FAKE_PASSWORD), false, "the password never reaches the output");
    for (const subject of SUBJECTS) {
      assert.equal(captured.includes(subject), false, `no subject in the output (${subject})`);
    }
    const logged = JSON.stringify(logs);
    assert.equal(logged.includes(FAKE_PASSWORD), false, "the password never reaches a log line");
    for (const subject of SUBJECTS) {
      assert.equal(logged.includes(subject), false, `no subject in a log line (${subject})`);
    }
  } finally {
    if (handle != null) await handle.stop();
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    delete process.env.CROW_MAIL;
    try { db.close(); } catch { /* closed */ }
  }
});