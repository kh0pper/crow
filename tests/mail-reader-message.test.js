/**
 * Crow Mail's open message and conversation view (plan 2, Task 5), through the REAL dashboard router
 * over a scratch CROW_DATA_DIR and CROW_HOME: accounts, folders and messages are written with plan
 * 1's stores, then the page is read over HTTP.
 *
 * The page's shape: a message is opened by account and Message-ID (or by row alone for a message with
 * no Message-ID), with its subject, sender and date; the whole conversation in order, one `<details>`
 * per message, the newest and the opened one open, each section carrying one `data-ml-frame-slot` and
 * no iframe (the body is served by the frame route); the reply slot plans 3 and 4 fill; attachments
 * with a name, a size and a download link; a message with no readable body saying so instead of a
 * slot; a back link that only ever points back into Mail; and nothing of a message's html and no
 * write of any kind on the GET.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { mailCss } from "../servers/gateway/dashboard/panels/mail/css.js";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "mail-reader-message-"));
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
writeFileSync(join(dir, "instance-id"), "instance-mail-message");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const NET = serveHeaders("operator@example.com");
let server, base, MODE;
const stores = { accounts: null, messages: null, frame: null };

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const MINUTE = 60_000;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')")
    .run(hashToken("owner-sess"), "dashboard");
  c.close();

  stores.accounts = await import("../servers/gateway/mail/store/accounts.js");
  stores.messages = await import("../servers/gateway/mail/store/messages.js");
  stores.frame = await import("../servers/gateway/mail/reader/frame-doc.js");

  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  delete process.env.CROW_MAIL;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const c = new Database(DB_FILE);
  try {
    c.prepare("DELETE FROM mail_messages").run();
    c.prepare("DELETE FROM mail_folders").run();
    c.prepare("DELETE FROM mail_threads").run();
    c.prepare("DELETE FROM mail_image_allow").run();
    c.prepare("DELETE FROM mail_sync_state").run();
    c.prepare("DELETE FROM mail_accounts").run();
  } finally { c.close(); }
});

const jar = `crow_session=owner-sess; crow_csrf=tok; ${MODE}=new`;
async function get(path) {
  const r = await fetch(base + path, { headers: { ...NET, cookie: jar }, redirect: "manual" });
  return { status: r.status, body: await r.text() };
}

async function withFlag(fn) {
  process.env.CROW_MAIL = "1";
  try { return await fn(); } finally { delete process.env.CROW_MAIL; }
}

async function withDb(fn) {
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try { return await fn(db); } finally { db.close(); }
}

const accountInput = (label, address, username) => ({
  label,
  address,
  username,
  authKind: "password",
  imap: { host: "mail.example.test", port: 993, security: "ssl" },
  smtp: { host: "mail.example.test", port: 465, security: "ssl" },
});

const A_FOLDERS = [
  { path: "INBOX", name: "Inbox" },
  { path: "Label", name: "Label" },
];

async function seed(db) {
  const a = await stores.accounts.createAccount(db, accountInput("Personal", "alex@example.com", "alexuser"));
  const b = await stores.accounts.createAccount(db, accountInput("Work", "sam@example.com", "samuser"));
  const aFolders = (await stores.messages.upsertFolders(db, a.id, A_FOLDERS)).folders;
  const bFolders = (await stores.messages.upsertFolders(db, b.id, [{ path: "INBOX", name: "Inbox" }])).folders;
  const pick = (list, path) => list.find((folder) => folder.path === path).id;
  return {
    a,
    b,
    aInbox: pick(aFolders, "INBOX"),
    aLabel: pick(aFolders, "Label"),
    bInbox: pick(bFolders, "INBOX"),
  };
}

let nextUid = 1;

/** One stored message through plan 1's upsertMessage. */
async function deliver(db, {
  accountId, folderId, subject = "", from = { name: "Alex", address: "alex@example.com" },
  date = T0, messageId = null, inReplyTo = null, isRead = false, snippet = "", text = "",
  html = null, parseError = null, attachments = [], cc = [],
}) {
  return stores.messages.upsertMessage(db, {
    accountId,
    folderId,
    uid: nextUid++,
    flags: isRead ? ["\\Seen"] : [],
    internalDate: date,
    messageId,
    inReplyTo,
    references: [],
    subject,
    from,
    to: [{ name: "Sam", address: "sam@example.com" }],
    cc,
    replyTo: [],
    date,
    text,
    html,
    snippet,
    attachments,
    truncated: false,
    parseError,
  });
}

/** The message view's URL for one link. */
function messageHref(accountId, mid, extra = {}) {
  const params = new URLSearchParams({ view: "message", a: accountId });
  if (mid != null && mid !== "") params.set("mid", mid);
  for (const [key, value] of Object.entries(extra)) {
    if (value != null && value !== "") params.set(key, String(value));
  }
  return `/dashboard/mail?${params.toString()}`;
}

const sectionIds = (html) => [...html.matchAll(/<details class="ml-msg-section" data-ml-msg="(\d+)"/g)]
  .map((m) => Number(m[1]));
const openSectionIds = (html) => [...html.matchAll(/<details class="ml-msg-section" data-ml-msg="(\d+)" open>/g)]
  .map((m) => Number(m[1]));
const slotSrcs = (html) => [...html.matchAll(/data-ml-frame-slot data-src="([^"]*)"/g)].map((m) => m[1]);
const sandboxes = (html) => [...html.matchAll(/data-sandbox="([^"]*)"/g)].map((m) => m[1]);
const attachmentHrefs = (html) => [...html.matchAll(/<a class="ml-attachment-link" href="([^"]*)" download/g)]
  .map((m) => m[1]);
const attachmentNames = (html) => [...html.matchAll(/<span class="ml-attachment-name">([^<]*)<\/span>/g)]
  .map((m) => m[1]);
const attachmentSizes = (html) => [...html.matchAll(/<span class="ml-size">([^<]*)<\/span>/g)]
  .map((m) => m[1]);
function backHref(html) {
  const m = /<a class="ml-back" href="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}
function backText(html) {
  const m = /<a class="ml-back" href="[^"]*">([^<]*)<\/a>/.exec(html);
  return m ? m[1] : null;
}

/* The action bar: one `data-row` per control, the folders the move select offers, and the mark-read
   marker the client reads for the opened unread message. */
const actionRows = (html, action) => [...html.matchAll(new RegExp(`data-ml-action="${action}" data-row="(\\d+)"`, "g"))]
  .map((m) => Number(m[1]));
const moveFolderIds = (html) => [...html.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
const unreadMarkerRow = (html) => {
  const m = /data-ml-unread-row="(\d+)"/.exec(html);
  return m ? Number(m[1]) : null;
};

/** The folders an action can need: an inbox, a label, an archive and a trash row. */
const ACTION_FOLDERS = [
  { path: "INBOX", name: "Inbox" },
  { path: "Label", name: "Label" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  { path: "Trash", name: "Trash", specialUse: "\\Trash" },
];

/** One account with exactly the folders given, plus a `folderId(path)` lookup. */
async function seedWith(db, listing, {
  label = "Personal", address = "alex@example.com", username = "alexuser",
} = {}) {
  const account = await stores.accounts.createAccount(db, accountInput(label, address, username));
  const folders = (await stores.messages.upsertFolders(db, account.id, listing)).folders;
  const folderId = (path) => folders.find((folder) => folder.path === path)?.id ?? null;
  return { account, folders, folderId };
}

/* ------------------------------------------------------------ the opened message */

test("opens by account and Message-ID and shows subject, sender, date", async () => {
  const mid = "<hello@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "Hello there", date: T0, messageId: mid, text: "Hello from Alex",
    });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.match(r.body, /<h2 class="ml-msg-subject">Hello there<\/h2>/);
    assert.match(r.body, /<span class="ml-msg-name">Alex<\/span>/);
    assert.match(r.body, /alex@example\.com/);
    assert.match(r.body, /January/);
    assert.match(r.body, /2026/);
    assert.equal(sectionIds(r.body).length, 1);
    assert.equal(slotSrcs(r.body).length, 1);
    assert.equal(backText(r.body), "← Inbox");
  });
});

test("Message-IDs with < > % + & # space unicode and 900 chars open the right message", async () => {
  const mids = [
    "<100%+&#<spaced>@mail.example.test>",
    "<ünïcode and space@mail.example.test>",
    `<${"a".repeat(896)}@mail.example.test>`,
  ];
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    for (const [index, messageId] of mids.entries()) {
      await deliver(db, {
        accountId: a.id, folderId: aInbox, subject: `Odd id ${index}`, date: T0 + index * MINUTE, messageId,
      });
    }
  });
  await withFlag(async () => {
    for (const [index, mid] of mids.entries()) {
      const r = await get(messageHref(accountId, mid));
      assert.equal(r.status, 200, mid);
      assert.match(r.body, new RegExp(`Odd id ${index}`), mid);
      for (const other of mids.filter((_, i) => i !== index)) {
        assert.notEqual(mid, other);
      }
    }
  });
});

test("after a UIDVALIDITY reset the same link still opens it", async () => {
  const mid = "<survives@mail.example.test>";
  let accountId, staleRow, freshRow;
  await withFlag(async () => {
    await withDb(async (db) => {
      const { a, aInbox } = await seed(db);
      accountId = a.id;
      const stored = await deliver(db, {
        accountId: a.id, folderId: aInbox, subject: "Survives a reset", date: T0, messageId: mid, text: "survives",
      });
      staleRow = stored.id;
      // The server's UIDVALIDITY changed: every row of the folder is gone, then the mail is re-synced
      // under new row ids. The link a person still holds carries the old row id.
      await stores.messages.resetFolder(db, aInbox, 2);
      const again = await deliver(db, {
        accountId: a.id, folderId: aInbox, subject: "Survives a reset", date: T0, messageId: mid, text: "survives",
      });
      freshRow = again.id;
      assert.notEqual(freshRow, staleRow);
    });

    const r = await get(messageHref(accountId, mid, { row: staleRow }));
    assert.equal(r.status, 200);
    assert.match(r.body, /Survives a reset/);
    assert.deepEqual(slotSrcs(r.body), [`/dashboard/mail/api/messages/${freshRow}/frame`]);
  });
});

test("a message with no Message-ID opens by row, and a row from another account is not found", async () => {
  let aId;
  let aRow, bRow, bMid = "<b-only@mail.example.test>";
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    aId = a.id;
    aRow = (await deliver(db, { accountId: a.id, folderId: aInbox, subject: "No id, by row alone" })).id;
    bRow = (await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Other account", messageId: bMid })).id;
  });
  await withFlag(async () => {
    const byRow = await get(messageHref(aId, null, { row: aRow }));
    assert.equal(byRow.status, 200);
    assert.match(byRow.body, /No id, by row alone/);

    // The row belongs to the other account, so it is not the hint it claims to be, and the id it
    // names is not in this account either.
    const crossed = await get(messageHref(aId, bMid, { row: bRow }));
    assert.equal(crossed.status, 404);
    assert.match(crossed.body, /This message is no longer here\./);
    assert.doesNotMatch(crossed.body, /Other account/);
    assert.equal(slotSrcs(crossed.body).length, 0);
  });
});

test("unknown account or id gives the not-here page and no mail data", async () => {
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Secret subject", messageId: "<known@mail.example.test>" });
  });
  await withFlag(async () => {
    for (const path of [
      messageHref("no-such-account", "<known@mail.example.test>"),
      messageHref(accountId, "<never-stored@mail.example.test>"),
      messageHref(accountId, null, { row: 999999 }),
    ]) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
      assert.match(r.body, /This message is no longer here\./, path);
      assert.match(r.body, /<a class="ml-back" href="\/dashboard\/mail">/, path);
      assert.doesNotMatch(r.body, /Secret subject/, path);
      assert.doesNotMatch(r.body, /data-ml-frame-slot/, path);
      assert.doesNotMatch(r.body, /data-mail-reply-slot/, path);
    }
  });
});

/* -------------------------------------------------------------- the conversation */

test("a thread of 200 messages renders 200 details, each with one frame slot, no iframe and no body text", async () => {
  const root = "<root@mail.example.test>";
  let accountId, newestMid = "<m-199@mail.example.test>";
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "Thread 0", date: T0, messageId: root,
      text: "BODY-MARKER-200-0",
    });
    for (let i = 1; i < 200; i += 1) {
      await deliver(db, {
        accountId: a.id,
        folderId: aInbox,
        subject: `Thread ${i}`,
        date: T0 + i * 1000,
        messageId: `<m-${i}@mail.example.test>`,
        inReplyTo: root,
        text: `BODY-MARKER-200-${i}`,
      });
    }
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, newestMid));
    assert.equal(r.status, 200);
    assert.equal(sectionIds(r.body).length, 200);
    assert.equal(slotSrcs(r.body).length, 200);
    assert.doesNotMatch(r.body, /<iframe/i);
    assert.doesNotMatch(r.body, /BODY-MARKER-200/);
    // The newest message is one of the open sections.
    const open = openSectionIds(r.body);
    assert.ok(open.length >= 1 && open.length <= 2, `at most two open sections: ${open.join(",")}`);
  });
});

test("a label-folder duplicate appears once", async () => {
  const mid = "<both@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox, aLabel } = await seed(db);
    accountId = a.id;
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Both copies", date: T0, messageId: mid });
    await deliver(db, { accountId: a.id, folderId: aLabel, subject: "Both copies", date: T0, messageId: mid });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.equal(sectionIds(r.body).length, 1);
  });
});

test("the page never contains message html", async () => {
  const mid = "<html-marker@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "Has an html body",
      messageId: mid,
      text: "plain part",
      html: '<p>BODY-HTML-MARKER-77</p><img src="https://mail.example.test/p.png">',
    });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /BODY-HTML-MARKER-77/);
    assert.doesNotMatch(r.body, /mail\.example\.test\/p\.png/);
  });
});

test("every frame slot's data-sandbox is FRAME_IFRAME_SANDBOX and never allow-same-origin", async () => {
  const root = "<sandbox-root@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "One", date: T0, messageId: root, text: "one" });
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "Two", date: T0 + MINUTE,
      messageId: "<sandbox-two@mail.example.test>", inReplyTo: root, text: "two",
    });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, root));
    assert.equal(r.status, 200);
    const values = sandboxes(r.body);
    assert.equal(values.length, 2);
    for (const value of values) {
      assert.equal(value, stores.frame.FRAME_IFRAME_SANDBOX);
      assert.match(value, /allow-scripts/);
      assert.doesNotMatch(value, /allow-same-origin/);
    }
  });
});

test("the reply slot carries account, mid and thread, and is empty", async () => {
  const mid = "<reply-slot@mail.example.test>";
  let accountId, threadId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    const stored = await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Slotted", messageId: mid });
    threadId = stored.threadId;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    const slot = `<div data-mail-reply-slot data-account="${accountId}" data-mid="&lt;reply-slot@mail.example.test&gt;" data-thread="${threadId}"></div>`;
    assert.ok(r.body.includes(slot), slot);
  });
});

test("a subject with quotes and <script> stays text", async () => {
  const mid = "<nasty@mail.example.test>";
  let accountId;
  const subject = `R&D "quoted" <script>alert(1)</script>`;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, { accountId: a.id, folderId: aInbox, subject, from: { name: "Sam", address: "sam@example.com" }, messageId: mid });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /<script>alert/);
    assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(r.body, /R&amp;D &quot;quoted&quot;/);
  });
});

test("the expanded recipients label the To list and the Cc list", async () => {
  const mid = "<recipients@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "Two lists",
      messageId: mid,
      cc: [{ name: "Kim", address: "kim@example.test" }],
      text: "hello",
    });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.match(r.body, /<p class="ml-recipients-label">to<\/p>/);
    assert.match(r.body, /<p class="ml-recipients-label">Cc<\/p>/);
    assert.match(r.body, /<li>Kim &lt;kim@example\.test&gt;<\/li>/);
  });
});

test("attachments are listed with name, size and a download link that skips Turbo", async () => {
  const mid = "<attached@mail.example.test>";
  let accountId, rowId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    const stored = await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "With attachments",
      messageId: mid,
      text: "see attached",
      attachments: [
        { filename: "report.pdf", contentType: "application/pdf", size: 2048 },
        { filename: "notes.txt", contentType: "text/plain", size: 12 },
      ],
    });
    rowId = stored.id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.match(r.body, /<h3 class="ml-attachments-title">Attachments<\/h3>/);
    assert.match(r.body, />report\.pdf</);
    assert.match(r.body, />2 KB</);
    assert.match(r.body, />notes\.txt</);
    assert.deepEqual(attachmentNames(r.body), ["report.pdf", "notes.txt"]);
    assert.deepEqual(attachmentSizes(r.body), ["2 KB", "1 KB"]);
    assert.deepEqual(attachmentHrefs(r.body), [
      `/dashboard/mail/api/messages/${rowId}/attachments/0`,
      `/dashboard/mail/api/messages/${rowId}/attachments/1`,
    ]);
    for (const tag of r.body.match(/<a class="ml-attachment-link"[^>]*>/g) || []) {
      assert.match(tag, /data-turbo="false"/, tag);
      assert.match(tag, /data-turbo-prefetch="false"/, tag);
      assert.match(tag, / download/, tag);
    }
    // The download link says "Download": the file's name stands beside it as plain text.
    assert.equal((r.body.match(/>Download<\/a>/g) || []).length, 2);
    assert.doesNotMatch(r.body, /<a class="ml-attachment-link"[^>]*>report\.pdf<\/a>/);
  });
});

test("attachment sizes are whole KB below 1 MB and one-decimal MB from 1 MB", async () => {
  const mid = "<sizes@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "Four sizes",
      messageId: mid,
      text: "see attached",
      attachments: [
        { filename: "empty.bin", contentType: "application/octet-stream", size: 0 },
        { filename: "tiny.bin", contentType: "application/octet-stream", size: 1 },
        { filename: "photo.png", contentType: "image/png", size: 240 * 1024 },
        { filename: "video.mp4", contentType: "video/mp4", size: Math.round(1.2 * 1048576) },
      ],
    });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.deepEqual(attachmentSizes(r.body), ["0 KB", "1 KB", "240 KB", "1.2 MB"]);
  });
});

test("a nameless attachment is shown as Untitled attachment", async () => {
  const mid = "<nameless@mail.example.test>";
  let accountId, rowId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    rowId = (await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "An unnamed file",
      messageId: mid,
      text: "see attached",
      attachments: [{ filename: "", contentType: "application/octet-stream", size: 1024 }],
    })).id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.deepEqual(attachmentNames(r.body), ["Untitled attachment"]);
    assert.deepEqual(attachmentHrefs(r.body), [`/dashboard/mail/api/messages/${rowId}/attachments/0`]);
  });
});

test("a forged duplicate Message-ID in one thread is its own entry and the real link opens the real one", async () => {
  const shared = "<shared-id@mail.example.test>";
  let accountId, realMid = shared;
  let realId, forgedId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    realId = (await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "The real one", date: T0, messageId: shared, text: "real body",
    })).id;
    // The forged reuse shares the id, so thread assignment folds it into the same conversation, but
    // it is a different message (another sender, another date).
    forgedId = (await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "The forged one",
      from: { name: "Sam", address: "sam@example.com" },
      date: T0 + MINUTE,
      messageId: shared,
      text: "forged body",
    })).id;
    assert.notEqual(realId, forgedId);
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, realMid));
    assert.equal(r.status, 200);
    assert.deepEqual(sectionIds(r.body).sort((x, y) => x - y), [realId, forgedId].sort((x, y) => x - y));
    // The header is the real message's, and the real message's own section is the opened one.
    assert.match(r.body, /<h2 class="ml-msg-subject">The real one<\/h2>/);
    assert.match(r.body, new RegExp(`<details class="ml-msg-section" data-ml-msg="${realId}" open>`));
    assert.match(r.body, /The forged one/);
  });
});

test("a click from a label folder opens that folder's copy", async () => {
  const mid = "<label-click@mail.example.test>";
  let accountId, labelRow;
  await withDb(async (db) => {
    const { a, aInbox, aLabel } = await seed(db);
    accountId = a.id;
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Copied", date: T0, messageId: mid, text: "same body" });
    labelRow = (await deliver(db, {
      accountId: a.id, folderId: aLabel, subject: "Copied", date: T0, messageId: mid, text: "same body",
    })).id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid, { row: labelRow }));
    assert.equal(r.status, 200);
    assert.equal(sectionIds(r.body).length, 1);
    assert.deepEqual(openSectionIds(r.body), [labelRow]);
    assert.deepEqual(slotSrcs(r.body), [`/dashboard/mail/api/messages/${labelRow}/frame`]);
  });
});

/* ---------------------------------------------------------------- back and writes */

test("the back link rejects a value that is not a mail list link", async () => {
  const mid = "<back@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Back test", messageId: mid });
  });
  await withFlag(async () => {
    for (const back of ["https://mail.example.test/x", "javascript:alert(1)", "//mail.example.test/x", "/dashboard/settings"]) {
      const r = await get(messageHref(accountId, mid, { back }));
      assert.equal(r.status, 200, back);
      assert.equal(backHref(r.body), "/dashboard/mail", back);
    }
    const mail = await get(messageHref(accountId, mid, { back: `/dashboard/mail?acct=${accountId}&folder=7` }));
    assert.equal(mail.status, 200);
    assert.equal(backHref(mail.body), `/dashboard/mail?acct=${accountId}&amp;folder=7`);
  });
});

test("the GET writes nothing: is_read stays as it was", async () => {
  // The action bar draws controls only; the GET itself writes nothing (the mark-read POST is the
  // client's, after the page is shown).
  const mid = "<unread@mail.example.test>";
  let accountId, rowId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    rowId = (await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Still unread", messageId: mid })).id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
  });
  await withDb(async (db) => {
    const message = await stores.messages.getMessage(db, rowId);
    assert.equal(message.isRead, false);
    assert.deepEqual(message.flags, []);
  });
});

/* -------------------------------------------------------------- the action bar */

test("the action bar shows Archive only when an archive target exists and Delete only with Trash", async () => {
  const plainMid = "<plain-actions@mail.example.test>";
  const unreadMid = "<unread-actions@mail.example.test>";
  const richMid = "<rich-actions@mail.example.test>";
  let plainAccount, plainRow, unreadRow, richAccount, richRow;
  await withDb(async (db) => {
    const plain = await seedWith(db, [{ path: "INBOX", name: "Inbox" }]);
    plainAccount = plain.account.id;
    plainRow = (await deliver(db, {
      accountId: plain.account.id,
      folderId: plain.folderId("INBOX"),
      subject: "Nothing to act on",
      messageId: plainMid,
      isRead: true,
    })).id;
    unreadRow = (await deliver(db, {
      accountId: plain.account.id,
      folderId: plain.folderId("INBOX"),
      subject: "Still unread",
      messageId: unreadMid,
    })).id;

    const rich = await seedWith(db, ACTION_FOLDERS, { label: "Work", address: "sam@example.com", username: "samuser" });
    richAccount = rich.account.id;
    richRow = (await deliver(db, {
      accountId: rich.account.id,
      folderId: rich.folderId("INBOX"),
      subject: "Both targets",
      messageId: richMid,
      isRead: true,
    })).id;
  });
  await withFlag(async () => {
    const plain = await get(messageHref(plainAccount, plainMid));
    assert.equal(plain.status, 200);
    assert.deepEqual(actionRows(plain.body, "archive"), [], "no archive target");
    assert.deepEqual(actionRows(plain.body, "delete"), [], "no Trash folder");
    assert.deepEqual(actionRows(plain.body, "unread"), [plainRow], "a read message offers Mark unread");
    assert.match(plain.body, /data-ml-action="unread" data-row="\d+">Mark unread<\/button>/);
    assert.equal(unreadMarkerRow(plain.body), null, "a read message arms no mark-read");

    const unread = await get(messageHref(plainAccount, unreadMid));
    assert.equal(unread.status, 200);
    assert.deepEqual(actionRows(unread.body, "unread"), [], "an unread message does not offer Mark unread");
    assert.equal(unreadMarkerRow(unread.body), unreadRow, "and the reader marks it read once it is shown");

    const rich = await get(messageHref(richAccount, richMid));
    assert.equal(rich.status, 200);
    assert.deepEqual(actionRows(rich.body, "archive"), [richRow]);
    assert.deepEqual(actionRows(rich.body, "delete"), [richRow]);
    assert.match(rich.body, /data-ml-action="archive" data-row="\d+">Archive<\/button>/);
    assert.match(rich.body, /data-ml-action="delete" data-row="\d+">Delete<\/button>/);
  });
});

test("the move select lists the account's other folders, never the current one nor the \\All view", async () => {
  const mid = "<move-select@mail.example.test>";
  let accountId, rowId, inboxId, ids;
  await withDb(async (db) => {
    const seeded = await seedWith(db, [...ACTION_FOLDERS, { path: "All Mail", name: "All Mail", specialUse: "\\All" }]);
    accountId = seeded.account.id;
    inboxId = seeded.folderId("INBOX");
    ids = {
      label: seeded.folderId("Label"),
      archive: seeded.folderId("Archive"),
      trash: seeded.folderId("Trash"),
      all: seeded.folderId("All Mail"),
    };
    rowId = (await deliver(db, {
      accountId, folderId: inboxId, subject: "Move me", messageId: mid, isRead: true,
    })).id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    const offered = moveFolderIds(r.body);
    assert.deepEqual(offered.slice().sort((x, y) => x - y), [ids.label, ids.archive, ids.trash].sort((x, y) => x - y));
    assert.equal(offered.includes(inboxId), false, "the folder the message is in is not a destination");
    assert.equal(offered.includes(ids.all), false, "\\All is a virtual view, not a folder to move to");
    assert.match(r.body, /<option value="" disabled selected>Move…<\/option>/);
    assert.match(r.body, /data-ml-action="move" data-row="\d+">Move<\/button>/);
    assert.deepEqual([...new Set(actionRows(r.body, "move"))], [rowId], "the select and the button name the opened row");
  });
});

test("Delete is absent in Trash, and Archive is absent in the archive folder and in the \\All view", async () => {
  const trashMid = "<in-trash@mail.example.test>";
  const archiveMid = "<in-archive@mail.example.test>";
  const allMid = "<in-all@mail.example.test>";
  const allInboxMid = "<all-is-the-archive@mail.example.test>";
  let accountId, allAccountId, trashRow, archiveRow, allRow, allAccountInboxRow;
  await withDb(async (db) => {
    const seeded = await seedWith(db, [...ACTION_FOLDERS, { path: "All Mail", name: "All Mail", specialUse: "\\All" }]);
    accountId = seeded.account.id;
    const store = async (path, messageId) => deliver(db, {
      accountId,
      folderId: seeded.folderId(path),
      subject: path,
      messageId,
      isRead: true,
    });
    trashRow = (await store("Trash", trashMid)).id;
    archiveRow = (await store("Archive", archiveMid)).id;
    allRow = (await store("All Mail", allMid)).id;

    const other = await seedWith(db, [
      { path: "INBOX", name: "Inbox" },
      { path: "All Mail", name: "All Mail", specialUse: "\\All" },
    ], { label: "Work", address: "sam@example.com", username: "samuser" });
    allAccountId = other.account.id;
    allAccountInboxRow = (await deliver(db, {
      accountId: allAccountId,
      folderId: other.folderId("INBOX"),
      subject: "Archived through \\All only",
      messageId: allInboxMid,
      isRead: true,
    })).id;
    assert.ok(allRow);
  });
  await withFlag(async () => {
    const trash = await get(messageHref(accountId, trashMid));
    assert.deepEqual(actionRows(trash.body, "delete"), [], "already in Trash");
    assert.deepEqual(actionRows(trash.body, "archive"), [trashRow]);

    const archive = await get(messageHref(accountId, archiveMid));
    assert.deepEqual(actionRows(archive.body, "archive"), [], "already archived");
    assert.deepEqual(actionRows(archive.body, "delete"), [archiveRow]);

    const all = await get(messageHref(accountId, allMid));
    assert.deepEqual(actionRows(all.body, "archive"), [], "already in an \\All folder");

    const byAll = await get(messageHref(allAccountId, allInboxMid));
    assert.deepEqual(actionRows(byAll.body, "archive"), [allAccountInboxRow], "\\All is the archive target");
    assert.deepEqual(actionRows(byAll.body, "delete"), [], "and there is still no Trash folder");
  });
});

test("opening from a label folder acts on that folder's row, not the inbox copy", async () => {
  const mid = "<label-actions@mail.example.test>";
  let accountId, inboxRow, labelRow;
  await withDb(async (db) => {
    const seeded = await seedWith(db, ACTION_FOLDERS);
    accountId = seeded.account.id;
    inboxRow = (await deliver(db, {
      accountId, folderId: seeded.folderId("INBOX"), subject: "Copied", date: T0, messageId: mid, isRead: true,
    })).id;
    labelRow = (await deliver(db, {
      accountId, folderId: seeded.folderId("Label"), subject: "Copied", date: T0, messageId: mid, isRead: true,
    })).id;
  });
  await withFlag(async () => {
    const inbox = await get(messageHref(accountId, mid));
    const label = await get(messageHref(accountId, mid, { row: labelRow }));
    assert.equal(label.status, 200);
    assert.deepEqual(actionRows(label.body, "archive"), [labelRow]);
    assert.deepEqual(actionRows(inbox.body, "archive"), [inboxRow]);
    assert.notEqual(labelRow, inboxRow, "the two copies are different rows");
  });
});

test("every action control is a 44 px target in the stylesheet", () => {
  const css = mailCss({ message: true });
  assert.match(css, /\.ml-msg-actions \.ml-btn, \.ml-move-select \{ min-height: 44px; \}/);
  assert.match(css, /\.ml-move-select \{[^}]*min-height: 44px/);
  assert.match(css, /\.ml-btn\[hidden\] \{ display: none; \}/);
});

/* ------------------------------------------------------------- no readable body */

test("a parse_error message says it has no text, has no slot, and still lists its attachments", async () => {
  const mid = "<broken@mail.example.test>";
  let accountId, rowId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    rowId = (await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "Could not be read",
      messageId: mid,
      text: "",
      html: null,
      parseError: "parse_failed",
      attachments: [{ filename: "scan.pdf", contentType: "application/pdf", size: 1024 }],
    })).id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.match(r.body, /This message has no text to show\./);
    assert.equal(slotSrcs(r.body).length, 0);
    assert.doesNotMatch(r.body, /data-ml-frame-slot/);
    assert.deepEqual(attachmentHrefs(r.body), [`/dashboard/mail/api/messages/${rowId}/attachments/0`]);
    assert.match(r.body, />scan\.pdf</);
  });
});

test("a message with an empty body says it has no text, has no slot, and still lists its attachments", async () => {
  const mid = "<empty@mail.example.test>";
  let accountId, rowId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    rowId = (await deliver(db, {
      accountId: a.id,
      folderId: aInbox,
      subject: "Nothing to read",
      messageId: mid,
      text: "",
      html: null,
      attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", size: 4096 }],
    })).id;
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.match(r.body, /This message has no text to show\./);
    assert.equal(slotSrcs(r.body).length, 0);
    assert.deepEqual(attachmentHrefs(r.body), [`/dashboard/mail/api/messages/${rowId}/attachments/0`]);
  });
});

test("a message with a body does not say it has no text", async () => {
  const mid = "<has-text@mail.example.test>";
  let accountId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    accountId = a.id;
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "Has text", messageId: mid, text: "a readable body",
    });
  });
  await withFlag(async () => {
    const r = await get(messageHref(accountId, mid));
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /This message has no text to show\./);
    assert.equal(slotSrcs(r.body).length, 1);
  });
});