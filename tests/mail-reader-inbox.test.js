/**
 * Crow Mail's inbox list, account chips and folder drawer (plan 2, Task 4), through the REAL dashboard
 * router over a scratch CROW_DATA_DIR and CROW_HOME: accounts, folders and messages are written with
 * plan 1's stores, then the page is read over HTTP.
 *
 * The page's shape: one unified inbox across two accounts, a chip narrowing it to one, a folder link
 * listing that folder (a Gmail-style label folder included); keyset paging, where "Load more" follows
 * nextCursor with no repeat and no gap; row links carrying account, Message-ID and the row hint, and a
 * message with no Message-ID linked by row alone; a folder drawer that skips \All, \Flagged and
 * \Important (never synced) and still lists a label; a folder the server deleted giving a 200 page
 * saying so with a way back; placeholders for a message with no subject and no sender; the unread dot;
 * mail text with <script>, quotes and a javascript: URL staying text; the digest slot on the All view
 * only; 44 px targets; and no body in any row.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "mail-reader-inbox-"));
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
writeFileSync(join(dir, "instance-id"), "instance-mail-inbox");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const NET = serveHeaders("operator@example.com");
let server, base, MODE;
const stores = { accounts: null, messages: null, queries: null };

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')")
    .run(hashToken("owner-sess"), "dashboard");
  c.close();

  stores.accounts = await import("../servers/gateway/mail/store/accounts.js");
  stores.messages = await import("../servers/gateway/mail/store/messages.js");
  stores.queries = await import("../servers/gateway/mail/store/reader-queries.js");

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

/** Account A: its inbox, a Gmail-style label folder and the three virtual folders. Account B: inbox. */
const A_FOLDERS = [
  { path: "INBOX", name: "Inbox" },
  { path: "Label", name: "Label" },
  { path: "All Mail", name: "All Mail", specialUse: "\\All" },
  { path: "Flagged", name: "Flagged", specialUse: "\\Flagged" },
  { path: "Important", name: "Important", specialUse: "\\Important" },
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
  date = T0, messageId = null, isRead = false, snippet = "", text = "",
}) {
  return stores.messages.upsertMessage(db, {
    accountId,
    folderId,
    uid: nextUid++,
    flags: isRead ? ["\\Seen"] : [],
    internalDate: date,
    messageId,
    inReplyTo: null,
    references: [],
    subject,
    from,
    to: [],
    cc: [],
    replyTo: [],
    date,
    text,
    html: null,
    snippet,
    attachments: [],
    truncated: false,
    parseError: null,
  });
}

/** The row ids a page lists, in order. */
function rowIds(html) {
  return [...html.matchAll(/<a class="ml-row" href="[^"]*row=(\d+)"/g)].map((m) => Number(m[1]));
}

/** The panel's own <style> block: the one that carries a .ml rule. */
function mailStyle(body) {
  for (const m of body.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    if (/\.ml\s*\{/.test(m[1])) return m[1];
  }
  return "";
}

/** One rule's declarations, or null when that class has no rule at all. */
function ruleBody(css, selector) {
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}");
  const m = pattern.exec(css);
  return m ? m[1] : null;
}

/** The "Load more" href, with the HTML attribute escaping undone, or null on the last page. */
function moreHref(html) {
  const m = /<a class="ml-more" href="([^"]+)"/.exec(html);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function rowAnchors(html) {
  return [...html.matchAll(/<a class="ml-row"[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
}

/* --------------------------------------------------------------- the list */

test("All lists the newest inbox mail across two accounts", async () => {
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Older from Alex", date: T0 });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Newest from Sam", date: T0 + 7_200_000 });
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Middle from Alex", date: T0 + 3_600_000 });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    const newest = r.body.indexOf("Newest from Sam");
    const middle = r.body.indexOf("Middle from Alex");
    const older = r.body.indexOf("Older from Alex");
    assert.ok(newest > 0, "the newest message is listed");
    assert.ok(middle > newest, "newest first");
    assert.ok(older > middle, "then the older one");
  });
});

test("a chip filters to one account and aria-current moves", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    ids = { a, b };
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Alex only" });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Sam only" });
  });
  await withFlag(async () => {
    const all = await get("/dashboard/mail");
    assert.equal(all.status, 200);
    assert.match(all.body, /<a class="ml-chip" href="\/dashboard\/mail" aria-current="page">All<\/a>/);
    assert.match(all.body, /<a class="ml-chip" href="\/dashboard\/mail\?acct=[^"]+">Work<\/a>/);

    const one = await get(`/dashboard/mail?acct=${ids.b.id}`);
    assert.equal(one.status, 200);
    assert.match(one.body, new RegExp(`<a class="ml-chip" href="/dashboard/mail\\?acct=${ids.b.id}" aria-current="page">Work</a>`));
    assert.match(one.body, /<a class="ml-chip" href="\/dashboard\/mail">All<\/a>/);
    assert.match(one.body, /Sam only/);
    assert.doesNotMatch(one.body, /Alex only/);
  });
});

test("a folder link lists that folder including a Gmail-style label folder", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, aInbox, aLabel } = await seed(db);
    ids = { a, aInbox, aLabel };
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Inbox only", date: T0 });
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Both copies", date: T0 + 60_000, messageId: "<both@mail.example.test>" });
    await deliver(db, { accountId: a.id, folderId: aLabel, subject: "Both copies", date: T0 + 60_000, messageId: "<both@mail.example.test>" });
    await deliver(db, { accountId: a.id, folderId: aLabel, subject: "Label only", date: T0 + 120_000 });
  });
  await withFlag(async () => {
    const r = await get(`/dashboard/mail?acct=${ids.a.id}&folder=${ids.aLabel}`);
    assert.equal(r.status, 200);
    assert.match(r.body, /Both copies/);
    assert.match(r.body, /Label only/);
    assert.doesNotMatch(r.body, /Inbox only/);
    // The folder drawer marks the folder being looked at.
    assert.match(r.body, new RegExp(`<a class="ml-folder" href="[^"]*folder=${ids.aLabel}" aria-current="page">`));

    const inbox = await get(`/dashboard/mail?acct=${ids.a.id}&folder=${ids.aInbox}`);
    assert.equal(inbox.status, 200);
    assert.match(inbox.body, /Inbox only/);
    assert.doesNotMatch(inbox.body, /Label only/);
  });
});

test("Load more follows nextCursor with no repeat and no gap across 70 messages", async () => {
  let seeded = [];
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    for (let i = 0; i < 70; i += 1) {
      const row = await deliver(db, {
        accountId: a.id, folderId: aInbox, subject: `Message ${i}`, date: T0 + i * 60_000,
      });
      seeded.push(row.id);
    }
  });
  await withFlag(async () => {
    const pages = [];
    const seen = [];
    let href = "/dashboard/mail";
    for (let guard = 0; href && guard < 10; guard += 1) {
      const r = await get(href);
      assert.equal(r.status, 200);
      const ids = rowIds(r.body);
      assert.ok(ids.length > 0, "every page lists something");
      pages.push(ids.length);
      seen.push(...ids);
      href = moreHref(r.body);
    }
    assert.equal(pages.length, 3, "70 messages over pages of 30");
    assert.deepEqual(seen, [...seeded].reverse(), "newest first, each message once, nothing skipped");
  });
});

test("every row link carries mid and row and round-trips through the router to the same message", async () => {
  const odd = "<100%+&#<spaced>@mail.example.test>";
  let expected = [];
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    for (const messageId of [odd, "<plain@mail.example.test>", null]) {
      const row = await deliver(db, {
        accountId: a.id, folderId: aInbox, subject: messageId ? `With ${messageId.length} chars` : "No id at all",
        date: T0 + expected.length * 60_000, messageId,
      });
      expected.push({ rowId: row.id, messageId });
    }
    expected.reverse();
  });
  await withFlag(async () => {
    const page = await get("/dashboard/mail");
    assert.equal(page.status, 200);
    const hrefs = [...page.body.matchAll(/<a class="ml-row" href="([^"]+)"/g)]
      .map((m) => m[1].replace(/&amp;/g, "&"));
    assert.equal(hrefs.length, 3);

    for (const [index, href] of hrefs.entries()) {
      const url = new URL("http://127.0.0.1" + href);
      assert.equal(url.pathname, "/dashboard/mail");
      assert.equal(url.searchParams.get("view"), "message");
      assert.equal(url.searchParams.get("row"), String(expected[index].rowId));
      if (expected[index].messageId === null) assert.equal(url.searchParams.get("mid"), null);
      else assert.equal(url.searchParams.get("mid"), expected[index].messageId);
      const follow = await get(href);
      assert.equal(follow.status, 200, href);
    }

    await withDb(async (db) => {
      for (const [index, href] of hrefs.entries()) {
        const url = new URL("http://127.0.0.1" + href);
        const found = await stores.queries.resolveMessageRef(db, {
          accountId: url.searchParams.get("a"),
          mid: url.searchParams.get("mid"),
          row: url.searchParams.get("row"),
        });
        assert.ok(found, `the link resolves: ${href}`);
        assert.equal(found.id, expected[index].rowId);
      }
    });
  });
});

test("a message with no Message-ID links by row", async () => {
  let rowId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    rowId = (await deliver(db, { accountId: a.id, folderId: aInbox, subject: "No Message-ID" })).id;
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    const m = /<a class="ml-row" href="([^"]+)"/.exec(r.body);
    assert.ok(m, "the row is there");
    const href = m[1].replace(/&amp;/g, "&");
    assert.match(href, /[?&]row=\d+/);
    assert.doesNotMatch(href, /[?&]mid=/);
    const url = new URL("http://127.0.0.1" + href);
    assert.equal(url.searchParams.get("row"), String(rowId));
  });
});

test("the folder drawer hides \\All, \\Flagged and \\Important but still lists a Gmail label folder", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, aLabel } = await seed(db);
    ids = { a, aLabel };
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.match(r.body, /<summary class="ml-drawer-summary">Folders<\/summary>/);
    assert.match(r.body, new RegExp(`<a class="ml-folder" href="[^"]*folder=${ids.aLabel}"`));
    for (const name of ["All Mail", "Flagged", "Important"]) {
      assert.doesNotMatch(r.body, new RegExp(`<a class="ml-folder"[^>]*>${name}`), name);
    }
  });
});

test("a folder id deleted by a resync gives the no-longer-here sentence and a link back, 200", async () => {
  let ids;
  let goneId;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    ids = { a, aInbox };
    const temp = await stores.messages.upsertFolders(db, a.id, [{ path: "Temp", name: "Temp" }]);
    goneId = temp.folders.find((folder) => folder.path === "Temp").id;
    // The next listing the server sends no longer carries it.
    const resync = await stores.messages.upsertFolders(db, a.id, A_FOLDERS);
    assert.equal(resync.deleted, 1, "the resync removed the temp folder");
  });
  await withFlag(async () => {
    const r = await get(`/dashboard/mail?acct=${ids.a.id}&folder=${goneId}`);
    assert.equal(r.status, 200);
    // The sentence is plain text, and the way back is a separate link of its own.
    assert.match(r.body, /<p class="ml-note">That folder is no longer here\.<\/p>/);
    const back = /<a class="ml-back" href="([^"]*)">([^<]*)<\/a>/.exec(r.body);
    assert.ok(back, "a separate way back");
    assert.equal(back[1], "/dashboard/mail");
    assert.equal(back[2], "Back to the inbox");
    assert.equal(rowIds(r.body).length, 0);
    // The card's own way back is a 44px target, and its rule ships with the page drawing it.
    assert.match(ruleBody(mailStyle(r.body), ".ml-back") ?? "", /min-height: 44px/);
  });
});

test("an empty folder and an empty account view say No messages here. and have no rows", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    ids = { a, aInbox };
  });
  await withFlag(async () => {
    for (const path of ["/dashboard/mail", `/dashboard/mail?acct=${ids.a.id}`, `/dashboard/mail?acct=${ids.a.id}&folder=${ids.aInbox}`]) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      assert.equal(rowIds(r.body).length, 0, path);
      assert.match(r.body, /<div class="ml" data-ml>/, path);
      assert.equal(
        r.body.split("No messages here.").length - 1,
        1,
        `${path}: the sentence is there once, where the list would be`,
      );
      assert.match(r.body, /<div class="ml-list"><p class="ml-note">No messages here\.<\/p><\/div>/, path);
    }
  });
});

test("a message with no subject and no sender shows the placeholders", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "", from: { name: "", address: "" }, snippet: "",
    });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.match(r.body, /<span class="ml-sender">Unknown sender<\/span>/);
    assert.match(r.body, /<span class="ml-subject">\(no subject\)<\/span>/);
  });
});

test("a subject, sender name, snippet and account label with <script>, quotes and a javascript: URL stay text", async () => {
  const nasty = 'R&D "quoted" <script>alert(1)</script>';
  await withDb(async (db) => {
    const a = await stores.accounts.createAccount(db, accountInput(nasty, "alex@example.com", "alexuser"));
    const inbox = (await stores.messages.upsertFolders(db, a.id, [{ path: "INBOX", name: "Inbox" }])).folders[0].id;
    await deliver(db, {
      accountId: a.id,
      folderId: inbox,
      subject: `<script>alert(1)</script> "quoted"`,
      from: { name: `Sam <script>alert(2)</script>`, address: "sam@example.com" },
      snippet: `javascript:alert(3) <img src=x onerror=alert(4)> "x"`,
      date: T0,
    });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /<script>alert/);
    assert.doesNotMatch(r.body, /<img src=x onerror/);
    assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(r.body, /Sam &lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.match(r.body, /R&amp;D &quot;quoted&quot; &lt;script&gt;/);
    // Every row anchor is one whole tag: a quote in the mail text did not close an attribute.
    const anchors = rowAnchors(r.body);
    assert.equal(anchors.length, 1);
    assert.match(anchors[0], /^<a class="ml-row" href="\/dashboard\/mail\?view=message&amp;a=[^"]+&amp;row=\d+">/);
    for (const m of r.body.matchAll(/href="([^"]*)"/g)) {
      assert.doesNotMatch(m[1], /javascript:/i, m[1]);
    }
  });
});

test("unread rows carry the unread dot, read rows do not", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Unread one", date: T0, isRead: false });
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Read one", date: T0 + 60_000, isRead: true });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    const anchors = rowAnchors(r.body);
    assert.equal(anchors.length, 2);
    const unread = anchors.find((a) => a.includes("Unread one"));
    const read = anchors.find((a) => a.includes("Read one"));
    // The dot is the only mark of an unread message, so it names itself instead of hiding.
    assert.match(unread, /<span class="ml-dot" role="img" aria-label="Unread"><\/span>/);
    assert.doesNotMatch(unread, /aria-hidden/);
    assert.doesNotMatch(read, /ml-dot/);
  });
});

test("the digest slot exists on the All view and not on a folder view", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    ids = { a, aInbox };
  });
  await withFlag(async () => {
    const all = await get("/dashboard/mail");
    assert.equal(all.status, 200);
    assert.match(all.body, /<div data-mail-digest-slot><\/div>/);

    const folder = await get(`/dashboard/mail?acct=${ids.a.id}&folder=${ids.aInbox}`);
    assert.equal(folder.status, 200);
    assert.doesNotMatch(folder.body, /data-mail-digest-slot/);
  });
});

test("the All view pages over usable accounts only, with a claimed account in the way", async () => {
  const usable = [];
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    await db.execute({
      sql: "UPDATE mail_accounts SET status = 'claimed_elsewhere' WHERE id = ?",
      args: [b.id],
    });
    // A claimed message newer than anything usable heads the stored list.
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Claimed top", date: T0 + 9_000_000 });
    for (let i = 0; i < 40; i += 1) {
      const row = await deliver(db, {
        accountId: a.id, folderId: aInbox, subject: `Usable ${i}`, date: T0 + i * 120_000,
      });
      usable.push(row.id);
      await deliver(db, {
        accountId: b.id, folderId: bInbox, subject: `Claimed ${i}`, date: T0 + i * 120_000 + 60_000,
      });
    }
  });
  await withFlag(async () => {
    const first = await get("/dashboard/mail");
    assert.equal(first.status, 200);
    const one = rowIds(first.body);
    assert.equal(one.length, 30, "a full page of messages this instance may read");
    assert.deepEqual(one, [...usable].reverse().slice(0, 30));
    assert.doesNotMatch(first.body, /No messages here\./);
    assert.doesNotMatch(first.body, /Claimed /);

    const href = moreHref(first.body);
    assert.ok(href, "the rest of the mail is one link away");
    const second = await get(href);
    assert.equal(second.status, 200);
    const two = rowIds(second.body);
    assert.equal(two.length, 10, "the page after it holds the rest, not an empty list");
    assert.deepEqual(two, [...usable].reverse().slice(30));
    assert.equal(new Set([...one, ...two]).size, 40, "no repeat");
    assert.equal(moreHref(second.body), null, "and the cursor is spent");
  });
});

test("a folder name with <script> and quotes in the drawer stays text", async () => {
  let folderId;
  const name = 'R&D "quoted" <script>alert(1)</script>';
  await withDb(async (db) => {
    const { a } = await seed(db);
    const added = await stores.messages.upsertFolders(db, a.id, [{ path: "Odd", name }]);
    folderId = added.folders.find((folder) => folder.path === "Odd").id;
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /<script>alert/);
    const escaped = "R&amp;D &quot;quoted&quot; &lt;script&gt;alert(1)&lt;/script&gt;";
    assert.ok(r.body.includes(escaped), "the folder name is escaped text");
    const anchors = [...r.body.matchAll(/<a class="ml-folder"[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    const anchor = anchors.find((a) => a.includes("R&amp;D"));
    assert.ok(anchor, "the folder is listed");
    assert.match(anchor, new RegExp(`folder=${folderId}"`), "the link keeps its folder id");
    assert.ok(anchor.includes(escaped), "the name is text inside the link, never markup");
  });
});

test("a garbage cursor answers 200 with the first page, never a 500", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    for (let i = 0; i < 5; i += 1) {
      await deliver(db, { accountId: a.id, folderId: aInbox, subject: `Kept ${i}`, date: T0 + i * 60_000 });
    }
  });
  await withFlag(async () => {
    const plain = await get("/dashboard/mail");
    assert.equal(plain.status, 200);
    const expected = rowIds(plain.body);
    assert.equal(expected.length, 5);
    for (const cursor of ["not-a-cursor", "%%%", "AAAA", "2026:1", "-1"]) {
      const r = await get(`/dashboard/mail?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(r.status, 200, cursor);
      assert.deepEqual(rowIds(r.body), expected, `${cursor} starts again at the first page`);
    }
  });
});

test("an unknown acct falls back to the All view", async () => {
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "From Alex", date: T0 });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "From Sam", date: T0 + 60_000 });
  });
  await withFlag(async () => {
    for (const acct of ["nope", "0", "all-the-things"]) {
      const r = await get(`/dashboard/mail?acct=${acct}`);
      assert.equal(r.status, 200, acct);
      assert.match(r.body, /<a class="ml-chip" href="\/dashboard\/mail" aria-current="page">All<\/a>/, acct);
      assert.match(r.body, /From Alex/, acct);
      assert.match(r.body, /From Sam/, acct);
    }
  });
});

test("a folder of another account than the chip does not list that account's mail", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, b, aInbox, aLabel, bInbox } = await seed(db);
    ids = { a, b, aLabel };
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Alex inbox" });
    await deliver(db, { accountId: a.id, folderId: aLabel, subject: "Alex label only", date: T0 + 60_000 });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Sam inbox", date: T0 + 120_000 });
  });
  await withFlag(async () => {
    const r = await get(`/dashboard/mail?acct=${ids.b.id}&folder=${ids.aLabel}`);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /Alex label only/);
    assert.match(r.body, /Sam inbox/);
    assert.match(r.body, new RegExp(`<a class="ml-chip" href="/dashboard/mail\\?acct=${ids.b.id}" aria-current="page">`));
  });
});

test("rowTime reads today as H:MM, this year as Mon D, another year as Mon D, YYYY", async () => {
  const { rowTime } = await import("../servers/gateway/dashboard/panels/mail/html.js");
  const now = Date.UTC(2026, 4, 14, 20, 0, 0);
  const at = (options) => rowTime(options.date, { now, tz: "UTC", lang: "en" });
  assert.equal(at({ date: Date.UTC(2026, 4, 14, 8, 5) }), "8:05");
  assert.equal(at({ date: Date.UTC(2026, 4, 14, 18, 30) }), "18:30");
  assert.equal(at({ date: Date.UTC(2026, 4, 14, 0, 0) }), "0:00");
  assert.equal(at({ date: Date.UTC(2026, 0, 5, 12, 0) }), "Jan 5");
  assert.equal(at({ date: Date.UTC(2025, 0, 5, 12, 0) }), "Jan 5, 2025");
});

test("the list header's own elements have rules and the search input is a 44px target", async () => {
  await withDb(async (db) => { await seed(db); });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    const css = mailStyle(r.body);
    assert.ok(css, "the panel emits its own stylesheet");
    for (const selector of [".ml-head", ".ml-search", ".ml-search-input", ".ml-search-heading", ".ml-actions", ".ml-flash"]) {
      const body = ruleBody(css, selector);
      assert.ok(body !== null, `${selector} has a rule in the inbox view's stylesheet`);
      assert.match(body, /min-width: 0/, `${selector} may shrink`);
    }
    assert.match(ruleBody(css, ".ml-search-input"), /min-height: 44px/);
    assert.match(ruleBody(css, ".ml-btn"), /min-height: 44px/);
    assert.doesNotMatch(css, /overflow-x/);
    // The controls that are only data-* hooks ride the 44px .ml-btn class.
    for (const hook of ["data-ml-refresh", "data-ml-older", "data-ml-search-remote"]) {
      for (const m of r.body.matchAll(new RegExp(`<button[^>]*${hook}[^>]*>`, "g"))) {
        assert.match(m[0], /class="ml-btn/, hook);
      }
    }
  });
});

test("every row and chip has min-height 44px in the stylesheet", async () => {
  await withDb(async (db) => { await seed(db); });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    const css = mailStyle(r.body);
    assert.ok(css, "the panel emits its own stylesheet");
    for (const selector of [".ml-row", ".ml-chip", ".ml-folder", ".ml-drawer-summary", ".ml-more", ".ml-back", ".ml-btn"]) {
      const body = ruleBody(css, selector);
      assert.ok(body !== null, `${selector} has a rule`);
      assert.match(body, /min-height: 44px/, selector);
    }
  });
});

test("no row shows a body", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "Has a body", text: "BODY-MARKER-9f3 do not leak me",
    });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /BODY-MARKER-9f3/);
  });
});