/**
 * Crow Mail's search view, older mail and refresh controls (plan 2, Task 6), through the REAL dashboard
 * router over a scratch CROW_DATA_DIR and CROW_HOME: accounts, folders and messages are written with
 * plan 1's stores, then the page is read over HTTP.
 *
 * The shapes this file pins: a search box on the list header and on the search view, with `q` cut at
 * 200; `view=search` answering the local index (plan 1's `searchLocal`, one row per logical message)
 * and falling back to the inbox when `q` is empty; an account scope narrowing the hits; a hostile query
 * (`"`, `NEAR(`, `*`, `AND`, 10,000 characters, only punctuation) answering a page, never a 500; the
 * "Search older mail on the server" button beneath the hits, with the query and the account scope on
 * it; the "Look further back" button on the last page of a list, naming the folder ids it would ask
 * for (the viewed folder, or each account's inbox on All); the refresh button in the header naming the
 * account ids; and the flash a reloading action leaves behind, carrying its count as an integer.
 *
 * The copy this file pins is the operator-approved set: the search box's placeholder, the refresh
 * button's own word, "No messages match." on a search that found nothing (an empty inbox keeps "No
 * messages here."), and one sentence per flash kind — with the singular of the remote-search count.
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

const dir = mkdtempSync(join(tmpdir(), "mail-reader-search-"));
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
writeFileSync(join(dir, "instance-id"), "instance-mail-search");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const NET = serveHeaders("operator@example.com");
let server, base, MODE;
const stores = { accounts: null, messages: null };

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

/** Account A: its inbox and a Gmail-style label folder. Account B: its inbox. */
async function seed(db) {
  const a = await stores.accounts.createAccount(db, accountInput("Personal", "alex@example.com", "alexuser"));
  const b = await stores.accounts.createAccount(db, accountInput("Work", "sam@example.com", "samuser"));
  const aFolders = (await stores.messages.upsertFolders(db, a.id, [
    { path: "INBOX", name: "Inbox" },
    { path: "Label", name: "Label" },
  ])).folders;
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

/** The row anchors a page lists. */
function rowAnchors(html) {
  return [...html.matchAll(/<a class="ml-row"[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
}

/** The href of one anchor with its HTML attribute escaping undone. */
function hrefOf(anchor) {
  return /href="([^"]*)"/.exec(anchor)[1].replace(/&amp;/g, "&");
}

/** The search box's value, as an attribute (escaped). */
function searchValue(html) {
  const m = /<input class="ml-btn ml-search-input" type="search" name="q" value="([^"]*)"/.exec(html);
  assert.ok(m, "the search box is on the page");
  return m[1];
}

/** The search heading's text, as an attribute (escaped). */
function headingValue(html) {
  const m = /<h2 class="ml-search-heading">([^<]*)<\/h2>/.exec(html);
  assert.ok(m, "the heading is on the page");
  return m[1];
}

/** One button's own attributes, found by one of its data hooks. */
function buttonHtml(html, hook) {
  const m = new RegExp(`<button[^>]*${hook}[^>]*>`).exec(html);
  return m ? m[0] : null;
}

function attrOf(tag, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------- search */

test("a subject word finds the message and the row links by mid", async () => {
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    await deliver(db, {
      accountId: a.id, folderId: aInbox, subject: "Lighthouse report",
      messageId: "<lh-1@mail.example.test>", text: "The keeper replied.",
    });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Groceries for Friday" });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail?view=search&q=lighthouse");
    assert.equal(r.status, 200);
    const anchors = rowAnchors(r.body);
    assert.equal(anchors.length, 1, "only the matching message is listed");
    const href = hrefOf(anchors[0]);
    const url = new URL("http://127.0.0.1" + href);
    assert.equal(url.pathname, "/dashboard/mail");
    assert.equal(url.searchParams.get("view"), "message");
    assert.equal(url.searchParams.get("mid"), "<lh-1@mail.example.test>", "the row links by Message-ID");
    assert.match(url.searchParams.get("row") ?? "", /^\d+$/);

    const follow = await get(href);
    assert.equal(follow.status, 200);
    assert.match(follow.body, /Lighthouse report/);
  });
});

test("hostile queries answer a no-results page, never a 500", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Quarterly report", text: "the lighthouse keeper" });
  });
  await withFlag(async () => {
    const hostile = ['"', "NEAR(", "*", "AND", "a".repeat(10_000), "?!.,;:()[]{}", '"unclosed', "NEAR(a b, 5)", "()"];
    for (const q of hostile) {
      const r = await get("/dashboard/mail?view=search&q=" + encodeURIComponent(q));
      assert.equal(r.status, 200, `${JSON.stringify(q).slice(0, 24)} answers a page`);
      assert.equal(rowAnchors(r.body).length, 0, `${JSON.stringify(q).slice(0, 24)} matches nothing`);
      assert.match(r.body, /<p class="ml-note">No messages match\.<\/p>/, JSON.stringify(q).slice(0, 24));
    }
  });
});

test("q is cut at 200", async () => {
  await withDb(async (db) => { await seed(db); });
  await withFlag(async () => {
    const r = await get("/dashboard/mail?view=search&q=" + "z".repeat(250));
    assert.equal(r.status, 200);
    assert.equal(searchValue(r.body), "z".repeat(200), "the box holds 200 characters");
    assert.equal(headingValue(r.body), "z".repeat(200), "and so does the heading");
    assert.doesNotMatch(r.body, new RegExp(`z{201}`));
  });
});

test("an empty q shows the inbox", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Plain inbox mail" });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail?view=search&q=");
    assert.equal(r.status, 200);
    assert.match(r.body, /Plain inbox mail/, "the inbox list, not the search view");
    assert.equal(buttonHtml(r.body, "data-ml-search-remote"), null);
    assert.match(r.body, /data-ml-refresh/, "the inbox header's refresh control");
  });
});

test("account scope narrows results", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    ids = { a, b };
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Sharedword from Alex" });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Sharedword from Sam" });
  });
  await withFlag(async () => {
    const all = await get("/dashboard/mail?view=search&q=sharedword");
    assert.equal(all.status, 200);
    assert.equal(rowAnchors(all.body).length, 2, "both accounts on All");

    const one = await get(`/dashboard/mail?view=search&q=sharedword&acct=${ids.b.id}`);
    assert.equal(one.status, 200);
    assert.equal(rowAnchors(one.body).length, 1);
    assert.match(one.body, /Sharedword from Sam/);
    assert.doesNotMatch(one.body, /Sharedword from Alex/);
    assert.equal(attrOf(buttonHtml(one.body, "data-ml-search-remote"), "data-acct"), ids.b.id);
  });
});

test("a Gmail-style duplicate is listed once", async () => {
  await withDb(async (db) => {
    const { a, aInbox, aLabel } = await seed(db);
    for (const folderId of [aInbox, aLabel]) {
      await deliver(db, {
        accountId: a.id, folderId, subject: "Label copy", date: T0,
        messageId: "<dup-1@mail.example.test>", text: "duplicatedword in both folders",
      });
    }
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail?view=search&q=duplicatedword");
    assert.equal(r.status, 200);
    assert.equal(rowAnchors(r.body).length, 1, "one row for one message in two folders");
  });
});

test("the remote-search button is there with no results and with results", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Remote search target" });
  });
  await withFlag(async () => {
    const hit = await get("/dashboard/mail?view=search&q=remote");
    assert.equal(hit.status, 200);
    const withResults = buttonHtml(hit.body, "data-ml-search-remote");
    assert.ok(withResults, "the button is there beside the hits");
    assert.equal(attrOf(withResults, "data-q"), "remote");
    assert.equal(attrOf(withResults, "data-acct"), "all");
    assert.match(hit.body, />Search older mail on the server<\/button>/);

    const none = await get("/dashboard/mail?view=search&q=nothereatall");
    assert.equal(none.status, 200);
    const withoutResults = buttonHtml(none.body, "data-ml-search-remote");
    assert.ok(withoutResults, "and with no hits");
    assert.equal(attrOf(withoutResults, "data-q"), "nothereatall");
  });
});

test("the query is escaped in the input value and the heading", async () => {
  await withDb(async (db) => { await seed(db); });
  await withFlag(async () => {
    const q = '"><script>alert(1)</script>';
    const r = await get("/dashboard/mail?view=search&q=" + encodeURIComponent(q));
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /<script>alert/);
    const escaped = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;";
    assert.equal(searchValue(r.body), escaped);
    assert.equal(headingValue(r.body), escaped);
    const remote = buttonHtml(r.body, "data-ml-search-remote");
    assert.equal(attrOf(remote, "data-q"), escaped);
  });
});

/* -------------------------------------------------- older mail and refreshing */

test("the refresh button carries the account ids and the older button the folder ids", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    ids = { a, b, aInbox, bInbox };
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "One" });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Two" });
  });
  await withFlag(async () => {
    const all = await get("/dashboard/mail");
    assert.equal(all.status, 200);
    const refresh = buttonHtml(all.body, "data-ml-refresh");
    assert.ok(refresh, "the header has a refresh control");
    assert.deepEqual(
      attrOf(refresh, "data-accounts").split(",").sort(),
      [ids.a.id, ids.b.id].sort(),
    );
    const older = buttonHtml(all.body, "data-ml-older");
    assert.deepEqual(
      attrOf(older, "data-folders").split(",").map(Number).sort((x, y) => x - y),
      [ids.aInbox, ids.bInbox].sort((x, y) => x - y),
      "each account's inbox on All",
    );
    assert.match(all.body, />Look further back<\/button>/);
    assert.match(all.body, /<button[^>]*data-ml-refresh[^>]*>Refresh<\/button>/, "the refresh control's own word");

    const one = await get(`/dashboard/mail?acct=${ids.b.id}`);
    assert.equal(attrOf(buttonHtml(one.body, "data-ml-refresh"), "data-accounts"), ids.b.id);
    assert.equal(attrOf(buttonHtml(one.body, "data-ml-older"), "data-folders"), String(ids.bInbox));

    for (const page of [all.body, one.body]) {
      assert.doesNotMatch(page, /mail\.example\.test/, "no host");
      assert.doesNotMatch(page, /alexuser|samuser/, "no username");
      const tags = [...page.matchAll(/<button[^>]*data-ml-(?:older|refresh)[^>]*>/g)].map((m) => m[0]);
      assert.ok(tags.length >= 1);
      for (const tag of tags) {
        const values = [...tag.matchAll(/data-(?:accounts|folders)="([^"]*)"/g)].map((m) => m[1]).join(",");
        assert.match(values, /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/, "names are ids only");
      }
    }
  });
});

test("a flash value renders its approved sentence with N as an integer and any other value nothing", async () => {
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Flash base" });
  });
  await withFlag(async () => {
    const older = await get("/dashboard/mail?flash=older:12");
    assert.equal(older.status, 200);
    assert.match(older.body, /<p class="ml-note ml-flash" role="status" data-ml-flash="older" data-count="12">Loaded older mail\.<\/p>/);
    assert.doesNotMatch(older.body, /Loaded older mail\. 12/, "the older sentence does not show the count");

    const padded = await get("/dashboard/mail?flash=older:0012");
    assert.equal(/data-ml-flash="older" data-count="([^"]*)"/.exec(padded.body)?.[1], "12", "N as an integer");
    assert.match(padded.body, />Loaded older mail\.<\/p>/);

    const start = await get("/dashboard/mail?flash=start");
    assert.equal(start.status, 200);
    assert.match(start.body, /<p class="ml-note ml-flash" role="status" data-ml-flash="start">That's the oldest mail on the server\.<\/p>/);
    assert.doesNotMatch(start.body, /data-count=/, "the start flash has no count");

    const remote = await get("/dashboard/mail?view=search&q=flash&flash=remote:7");
    assert.equal(remote.status, 200);
    assert.match(remote.body, /data-ml-flash="remote" data-count="7">Found 7 more on the server\.<\/p>/);

    const one = await get("/dashboard/mail?view=search&q=flash&flash=remote:1");
    assert.equal(one.status, 200);
    assert.match(one.body, /data-ml-flash="remote" data-count="1">Found 1 more on the server\.<\/p>/, "the singular sentence");

    const paddedOne = await get("/dashboard/mail?view=search&q=flash&flash=remote:0001");
    assert.match(paddedOne.body, /data-count="1">Found 1 more on the server\.<\/p>/, "the singular takes the integer");

    const zero = await get("/dashboard/mail?view=search&q=flash&flash=remote:0");
    assert.match(zero.body, /data-ml-flash="remote" data-count="0">Found 0 more on the server\.<\/p>/);

    for (const bad of ["older", "older:", "older:-1", "older:1.5", "remote:7.5", "start:2", "junk:3", "remote:", "12"]) {
      const r = await get("/dashboard/mail?flash=" + encodeURIComponent(bad));
      assert.equal(r.status, 200, bad);
      assert.doesNotMatch(r.body, /data-ml-flash/, `"${bad}" renders nothing`);
      assert.doesNotMatch(r.body, /Loaded older mail\.|That's the oldest mail|more on the server\./, bad);
    }
  });
});

test("the search box carries the approved placeholder and the button keeps its word", async () => {
  await withDb(async (db) => { await seed(db); });
  await withFlag(async () => {
    for (const path of ["/dashboard/mail", "/dashboard/mail?view=search&q=placeholder"]) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      const input = /<input class="ml-btn ml-search-input"[^>]*>/.exec(r.body)?.[0];
      assert.ok(input, `${path}: the search box is on the page`);
      assert.equal(attrOf(input, "placeholder"), "Search mail", path);
      assert.match(r.body, /<button class="ml-btn" type="submit">Search<\/button>/, path);
    }
  });
});

test("no hits says No messages match. while an empty inbox still says No messages here.", async () => {
  await withDb(async (db) => { await seed(db); });
  await withFlag(async () => {
    const search = await get("/dashboard/mail?view=search&q=nothingmatchesthis");
    assert.equal(search.status, 200);
    assert.match(search.body, /<div class="ml-list"><p class="ml-note">No messages match\.<\/p><\/div>/);
    assert.doesNotMatch(search.body, /No messages here\./);

    const inbox = await get("/dashboard/mail");
    assert.equal(inbox.status, 200);
    assert.match(inbox.body, /<div class="ml-list"><p class="ml-note">No messages here\.<\/p><\/div>/);
    assert.doesNotMatch(inbox.body, /No messages match\./);
  });
});

test("Look further back appears only on the last page", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, aInbox } = await seed(db);
    ids = { a, aInbox };
    for (let i = 0; i < 70; i += 1) {
      await deliver(db, { accountId: a.id, folderId: aInbox, subject: `Message ${i}`, date: T0 + i * 60_000 });
    }
  });
  await withFlag(async () => {
    const seen = [];
    let href = `/dashboard/mail?acct=${ids.a.id}&folder=${ids.aInbox}`;
    for (let guard = 0; href && guard < 10; guard += 1) {
      const r = await get(href);
      assert.equal(r.status, 200);
      seen.push(r.body);
      const more = /<a class="ml-more" href="([^"]+)"/.exec(r.body);
      href = more ? more[1].replace(/&amp;/g, "&") : null;
    }
    assert.equal(seen.length, 3, "70 messages over pages of 30");
    for (const page of seen.slice(0, -1)) {
      assert.equal(buttonHtml(page, "data-ml-older"), null, "no older control while a cursor remains");
    }
    const older = buttonHtml(seen[seen.length - 1], "data-ml-older");
    assert.ok(older, "the last page offers it");
    assert.equal(attrOf(older, "data-folders"), String(ids.aInbox));
  });
});

test("the All view lists each account's inbox folder id", async () => {
  let ids;
  await withDb(async (db) => {
    const { a, b, aInbox, bInbox } = await seed(db);
    ids = { aInbox, bInbox };
    await deliver(db, { accountId: a.id, folderId: aInbox, subject: "Alex one" });
    await deliver(db, { accountId: b.id, folderId: bInbox, subject: "Sam one" });
  });
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    const folders = attrOf(buttonHtml(r.body, "data-ml-older"), "data-folders").split(",").map(Number);
    assert.deepEqual(folders.sort((x, y) => x - y), [ids.aInbox, ids.bInbox].sort((x, y) => x - y));
  });
});