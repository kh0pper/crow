/**
 * Version history, Task 5: the UI — the History view, the Jobs page, the Trash
 * page and the Settings → History section.
 *
 * Every fixture is a real scripts/init-db.js crow.db in its own temp dir with the
 * additive 0024 migration applied, as in tests/history-jobs-trash.test.js. Writes
 * go through the gateway's client inside a write context, so the versions they
 * produce are stamped the way a real write's are; the pages are then served by a
 * real express app with the dashboard's own order — auth stub, then the REAL
 * csrfMiddleware, then the panel's routes (mountHistoryRoutes, the same function
 * dashboard/index.js mounts) — so the CSRF rail and the owner rule are the
 * production ones, not a test copy.
 *
 * What this file is responsible for (the plan's Step 1 list plus the extras the
 * brief names):
 *   - every route renders for the owner and refuses an SSO or an on-host session,
 *     on POST **and on GET** (History content is content: an item's old text);
 *   - no rendered page names a developer tool (no git words in the copy) — only
 *     the TEXT nodes are checked, so a CSS class name can never be the reason a
 *     page passes;
 *   - every document-derived string is escaped (content, titles, bot names,
 *     machine names);
 *   - restoring from the page writes an attributed OWNER version;
 *   - the Trash note uses the configured days;
 *   - the erase switch and the Trash period save as local settings (never synced),
 *     and the erase switch is visible to the reader that actually gates emission;
 *   - en/es are at parity for this feature's keys.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fromLaptop, markFromLaptop } from "./helpers/off-box.js";

const REPO = new URL("..", import.meta.url).pathname;

/* One private home for the whole file: Crow's own modules resolve their data dir
 * from the environment, so nothing here can touch a real ~/.crow. */
const root = mkdtempSync(join(tmpdir(), "hist-ui-"));
process.env.CROW_HOME = join(root, "home");
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;
delete process.env.CROW_TASKS_DB_PATH;

const { default: express } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { run: migrate } = await import("../scripts/migrations/0024-item-versions.mjs");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
const { translations, t } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { escapeHtml } = await import("../servers/gateway/dashboard/shared/components.js");
const { withWriteContext, sessionHash8 } = await import("../servers/shared/history/write-context.js");
const { listVersions, historySize } = await import("../servers/shared/history/api.js");
const { eraseSyncEnabled } = await import("../servers/shared/history/erase.js");
const { default: historyPanel, mountHistoryRoutes } = await import("../servers/gateway/dashboard/panels/history.js");
const { default: settingsPanel } = await import("../servers/gateway/dashboard/panels/settings.js");
const settingsRegistry = await import("../servers/gateway/dashboard/settings/registry.js");
const { isInstanceScope, isSyncable } = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
const { default: historySection, HISTORY_SETTINGS } = await import("../servers/gateway/dashboard/settings/sections/history.js");

const MASTER = { crow: join(root, "master", "crow.db") };

/** The owner at their dashboard (a password session), a peer's SSO session, a sign-in ON this box. */
const OWN = "history-owner-session";
const SSO = "history-sso-session";
const ONHOST = "history-onhost-session";
const CSRF = "history-csrf-token";
const OWNER_CTX = { authorKind: "owner", authorId: sessionHash8(OWN), jobId: `session:${sessionHash8(OWN)}` };
const BOT = { authorKind: "bot", authorId: "helper", jobId: "card:9" };

const openClients = [];
const servers = [];
after(() => {
  for (const srv of servers) srv.close();
  for (const client of openClients) {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

before(async () => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master"), CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  migrate({ dbPath: MASTER.crow, log: () => {} });
  const raw = new Database(MASTER.crow);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const tok = raw.prepare(
    "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
  );
  tok.run(hashToken(OWN), "dashboard", future);
  tok.run(hashToken(SSO), "dashboard sso src:peer-1", future);
  tok.run(hashToken(ONHOST), "dashboard onhost", future);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  // The settings panel registers every built-in section (including History) at
  // import time; fail loudly here rather than silently rendering a menu without it.
  await settingsPanel;
});

/* --------------------------------------------------------------- fixtures */

let fixtureNo = 0;

/** A fresh copy of the migrated crow.db, plus an express app serving the routes. */
async function setup() {
  const dir = join(root, `t${++fixtureNo}`);
  mkdirSync(dir, { recursive: true });
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER.crow, crow);
  const db = createDbClient(crow);
  openClients.push(db);

  const app = express();
  app.use("/dashboard", express.urlencoded({ extended: false }));
  app.use("/dashboard", stubAuth);
  app.use("/dashboard", csrfMiddleware);
  mountHistoryRoutes(app, async (req, res) => {
    const client = createDbClient(crow);
    try {
      const html = await historyPanel.handler(req, res, { db: client, lang: "en", layout: fakeLayout });
      if (!res.headersSent) res.type("html").send(html);
    } catch (err) {
      if (!res.headersSent) res.status(500).type("text/plain").send(String((err && err.stack) || err));
    } finally {
      client.close();
    }
  });
  const srv = app.listen(0);
  servers.push(srv);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { dir, crow, db, base, close: () => srv.close() };
}

/** The dashboard's real layout is chrome; the pages under test are the content. */
const fakeLayout = ({ title, content }) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${content}</body></html>`;

/** A stand-in for dashboardAuth: a known session cookie becomes req.dashboardSession, off-box. */
function stubAuth(req, res, next) {
  const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
  if (m) {
    req.dashboardSession = decodeURIComponent(m[1]);
    markFromLaptop(req);
    return next();
  }
  res.redirect(303, "/dashboard/login");
}

const cookieFor = (session) => `crow_session=${session}; crow_csrf=${CSRF}`;

async function getPage(base, path, session = OWN) {
  return fetch(base + path, { headers: { cookie: cookieFor(session) }, redirect: "manual" });
}

async function postForm(base, path, fields, { session = OWN, csrf = CSRF } = {}) {
  const headers = { cookie: cookieFor(session), "content-type": "application/x-www-form-urlencoded" };
  if (csrf) headers["x-crow-csrf"] = csrf;
  return fetch(base + path, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" });
}

async function insertMemory(db, ctx, fields = {}) {
  const row = { content: "first text", category: "general", ...fields };
  const columns = Object.keys(row);
  const { lastInsertRowid } = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO memories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(lastInsertRowid);
}

async function updateMemory(db, ctx, id, fields) {
  const columns = Object.keys(fields);
  await withWriteContext(ctx, () =>
    db.execute({
      sql: `UPDATE memories SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      args: [...columns.map((c) => fields[c]), id],
    }),
  );
}

async function deleteMemory(db, ctx, id) {
  await withWriteContext(ctx, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
}

async function insertPost(db, ctx, fields = {}) {
  const row = { slug: "a-post", title: "A post", content: "body text", ...fields };
  const columns = Object.keys(row);
  const { lastInsertRowid } = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO blog_posts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(lastInsertRowid);
}

async function insertBot(db, { botId = "helper", displayName = "Helper" } = {}) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,NULL)",
    args: [botId, displayName, JSON.stringify({ engine: "pi" })],
  });
}

async function insertPeer(db, { id = "peer-1", name = "the other machine" } = {}) {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, trusted) VALUES (?,?,?,?, 'active', 1)",
    args: [id, name, `crow-${id}`, "https://crow.example.ts.net"],
  });
}

/* ------------------------------------------------------------- text tools */

/**
 * The page's TEXT: scripts, styles and every tag (so every attribute, and with
 * them every class name) are dropped before the no-git-words rule runs.
 */
function textOf(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const GIT_WORD_RE = /\b(?:git|commit|branch|repos?|repository|diff|revert)\b/i;

/* ------------------------------------------------------------------ tests */

test("each History route renders for the owner", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, OWNER_CTX, { content: "the first line" });
    await updateMemory(s.db, OWNER_CTX, id, { content: "the second line" });

    const item = await getPage(s.base, `/dashboard/history/memory/${id}`);
    assert.equal(item.status, 200);
    const itemHtml = await item.text();
    assert.match(itemHtml, /Restore this version/);
    assert.match(itemHtml, /the second line/);
    assert.match(itemHtml, /You/);

    const jobs = await getPage(s.base, "/dashboard/history/jobs");
    assert.equal(jobs.status, 200);
    assert.match(await jobs.text(), /Undo this job/);

    const trash = await getPage(s.base, "/dashboard/history/trash");
    assert.equal(trash.status, 200);
    assert.match(await trash.text(), /Empty Trash/);

    const index = await getPage(s.base, "/dashboard/history");
    assert.equal(index.status, 200);
    assert.match(await index.text(), /History/);
  } finally {
    s.close();
  }
});

test("an SSO session and an on-host session are refused on every History route, GET and POST", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, OWNER_CTX, { content: "private memory text" });
    const routes = [
      `/dashboard/history/memory/${id}`,
      "/dashboard/history/jobs",
      "/dashboard/history/trash",
      "/dashboard/history",
    ];
    const refusal = escapeHtml(t("history.onlyOwner", "en"));
    for (const session of [SSO, ONHOST]) {
      for (const route of routes) {
        // GET: refused as well, because an item's history IS its content.
        const got = await getPage(s.base, route, session);
        assert.equal(got.status, 403, `GET ${route} as ${session}`);
        const gotHtml = await got.text();
        assert.ok(gotHtml.includes(refusal), `GET ${route} as ${session} must say why`);
        assert.doesNotMatch(gotHtml, /private memory text/, "a refused page carries no row data");

        // POST: refused, and nothing is written.
        const posted = await postForm(s.base, route, { action: "empty_trash", confirm: "1" }, { session });
        assert.equal(posted.status, 403, `POST ${route} as ${session}`);
      }
    }
    // The refused POSTs changed nothing: the memory is still live and has its versions.
    const live = await s.db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [id] });
    assert.equal(live.rows.length, 1);
  } finally {
    s.close();
  }
});

test("a POST without the CSRF token is refused before the panel runs", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, OWNER_CTX, { content: "csrf check" });
    const versions = await listVersions(s.db, { itemType: "memory", itemId: String(id) });
    const target = versions[0].id;
    const res = await postForm(
      s.base,
      `/dashboard/history/memory/${id}`,
      { action: "restore", version_id: String(target) },
      { csrf: "" },
    );
    assert.equal(res.status, 403);
    assert.match(await res.text(), /CSRF/);
  } finally {
    s.close();
  }
});

test("no rendered History page names a developer tool", async () => {
  const s = await setup();
  try {
    await insertBot(s.db);
    await insertPeer(s.db);
    const id = await insertMemory(s.db, BOT, { content: "line one\nline two" });
    await updateMemory(s.db, BOT, id, { content: "line one\nline three" });
    await insertPost(s.db, BOT, { slug: "a-draft", title: "A draft", content: "words" });
    const gone = await insertMemory(s.db, OWNER_CTX, { content: "delete me" });
    await deleteMemory(s.db, OWNER_CTX, gone);

    const pages = [
      await (await getPage(s.base, `/dashboard/history/memory/${id}`)).text(),
      await (await getPage(s.base, "/dashboard/history/jobs")).text(),
      await (await getPage(s.base, "/dashboard/history/trash")).text(),
      await (await getPage(s.base, "/dashboard/history")).text(),
    ];
    for (const html of pages) {
      const text = textOf(html);
      assert.doesNotMatch(text, GIT_WORD_RE, `a History page's text needs no developer words: ${text.match(GIT_WORD_RE)?.[0]}`);
      // The neutral words the spec fixes ARE there.
      assert.match(text, /History/);
    }
    // "added"/"removed" describe a change, in the change view of the edited memory.
    assert.match(textOf(pages[0]), /added|removed/);
  } finally {
    s.close();
  }
});

test("every document string on the history pages is escaped", async () => {
  const s = await setup();
  try {
    await insertBot(s.db, { displayName: "<svg onload=alert(1)>Helper" });
    await insertPeer(s.db, { id: "peer-9", name: "<i>other box</i>" });
    const memoryText = "<script>alert('memory')</script>";
    const postTitle = "<img src=x onerror=alert(2)>";
    const id = await insertMemory(s.db, { authorKind: "peer", authorId: "peer-9", originInstance: "peer-9" }, { content: memoryText });
    await updateMemory(s.db, BOT, id, { content: `${memoryText} more` });
    const postId = await insertPost(s.db, BOT, { slug: "escaped-post", title: postTitle });
    const gone = await insertMemory(s.db, { authorKind: "peer", authorId: "peer-9", originInstance: "peer-9" }, {
      content: "<b>deleted body</b>",
    });
    await deleteMemory(s.db, { authorKind: "peer", authorId: "peer-9", originInstance: "peer-9" }, gone);

    const itemHtml = await (await getPage(s.base, `/dashboard/history/memory/${id}`)).text();
    assert.match(itemHtml, /&lt;script&gt;alert\('memory'\)&lt;\/script&gt;/);
    assert.doesNotMatch(itemHtml, /<script>alert\('memory'\)<\/script>/);
    assert.match(itemHtml, /&lt;svg onload=alert\(1\)&gt;Helper/);
    assert.doesNotMatch(itemHtml, /<svg onload=alert\(1\)>/);
    assert.match(itemHtml, /&lt;i&gt;other box&lt;\/i&gt;/);
    assert.doesNotMatch(itemHtml, /<i>other box<\/i>/);

    const jobsHtml = await (await getPage(s.base, "/dashboard/history/jobs")).text();
    assert.match(jobsHtml, /&lt;img src=x onerror=alert\(2\)&gt;/);
    assert.doesNotMatch(jobsHtml, /<img src=x onerror=alert\(2\)>/);

    const trashHtml = await (await getPage(s.base, "/dashboard/history/trash")).text();
    assert.match(trashHtml, /&lt;b&gt;deleted body&lt;\/b&gt;/);
    assert.doesNotMatch(trashHtml, /<b>deleted body<\/b>/);
    assert.match(trashHtml, /&lt;i&gt;other box&lt;\/i&gt;/);
    assert.ok(postId > 0);
  } finally {
    s.close();
  }
});

test("restoring from the page writes an attributed owner version", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, BOT, { content: "the original words" });
    await updateMemory(s.db, BOT, id, { content: "the changed words" });
    const versions = await listVersions(s.db, { itemType: "memory", itemId: String(id) });
    const oldest = versions[versions.length - 1];

    const res = await postForm(s.base, `/dashboard/history/memory/${id}`, { action: "restore", version_id: String(oldest.id) });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Restored\./);

    const row = await s.db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [id] });
    assert.equal(row.rows[0].content, "the original words");

    const after = await listVersions(s.db, { itemType: "memory", itemId: String(id) });
    const newest = after[0];
    assert.ok(newest.id > versions[0].id, "the restore is a NEW version, not a rewrite");
    assert.equal(newest.authorKind, "owner");
    assert.equal(newest.authorId, sessionHash8(OWN));
    assert.equal(newest.jobId, `session:${sessionHash8(OWN)}`);
    // Review focus 3: nothing after the restored version disappeared from the list.
    assert.equal(after.length, versions.length + 1);

    // Restoring the same version again changes nothing and writes nothing.
    const again = await postForm(s.base, `/dashboard/history/memory/${id}`, { action: "restore", version_id: String(oldest.id) });
    assert.match(await again.text(), /Nothing to restore/);
    assert.equal((await listVersions(s.db, { itemType: "memory", itemId: String(id) })).length, after.length);
  } finally {
    s.close();
  }
});

test("the Trash note uses the configured days", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, OWNER_CTX, { content: "gone soon" });
    await deleteMemory(s.db, OWNER_CTX, id);

    // Saved through the settings section, as the owner would.
    const res = { redirectAfterPost(url) { this.url = url; } };
    await historySection.handleAction({
      req: markFromLaptop(fromLaptop({ body: { action: "save_history_settings", trash_days: "7" }, query: {}, dashboardSession: OWN })),
      res,
      db: s.db,
      action: "save_history_settings",
      lang: "en",
    });
    assert.match(String(res.url), /saved=1/);

    const html = await (await getPage(s.base, "/dashboard/history/trash")).text();
    assert.match(html, /stay here for 7 days, then they are erased for good/);
  } finally {
    s.close();
  }
});

test("the erase sync switch saves a local setting the sweep's reader can see", async () => {
  const s = await setup();
  try {
    // A sync manager that would record an emit, so "never synced" is proved, not assumed.
    const emitted = [];
    settingsRegistry.setSettingsSyncManager({ emitChange: async (table, op, row) => { emitted.push({ table, op, row }); return 1; } });

    const res = { redirectAfterPost(url) { this.url = url; } };
    await historySection.handleAction({
      req: markFromLaptop(fromLaptop({
        body: { action: "save_history_settings", trash_days: "45", erase_sync: "1" },
        query: {},
        dashboardSession: OWN,
      })),
      res,
      db: s.db,
      action: "save_history_settings",
      lang: "en",
    });
    assert.match(String(res.url), /saved=1/);

    // The Trash period is a per-instance override (readSetting's first answer).
    assert.equal(await settingsRegistry.readSetting(s.db, HISTORY_SETTINGS.trashDays), "45");
    assert.equal(await settingsRegistry.getSettingScope(s.db, HISTORY_SETTINGS.trashDays), "local");
    const override = await s.db.execute({
      sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ?",
      args: [HISTORY_SETTINGS.trashDays],
    });
    assert.equal(override.rows[0]?.value, "45");

    // The erase switch is instance-scope: the GLOBAL row, because erase.js's
    // eraseSyncEnabled reads that table directly — and it now sees it.
    assert.equal(isSyncable(HISTORY_SETTINGS.eraseSync), false, "erase sync must never replicate");
    assert.equal(isInstanceScope(HISTORY_SETTINGS.eraseSync), true);
    assert.equal(await settingsRegistry.readSetting(s.db, HISTORY_SETTINGS.eraseSync), "true");
    assert.equal(await eraseSyncEnabled(s.db), true, "the reader that gates erase emission must see the switch");

    // Neither key may ever be in the sync allowlist, and nothing was emitted.
    for (const key of Object.values(HISTORY_SETTINGS)) {
      assert.equal(isSyncable(key), false, `${key} must not be syncable`);
    }
    assert.deepEqual(emitted, [], "no history setting may be emitted to a peer");

    // Switching it back off is saved too.
    const off = { redirectAfterPost(url) { this.url = url; } };
    await historySection.handleAction({
      req: markFromLaptop(fromLaptop({
        body: { action: "save_history_settings", trash_days: "30" },
        query: {},
        dashboardSession: OWN,
      })),
      res: off,
      db: s.db,
      action: "save_history_settings",
      lang: "en",
    });
    assert.equal(await eraseSyncEnabled(s.db), false);
  } finally {
    settingsRegistry.setSettingsSyncManager(null);
    s.close();
  }
});

test("the settings section refuses a non-owner and out-of-range days", async () => {
  const s = await setup();
  try {
    const sso = { redirectAfterPost(url) { this.url = url; } };
    await historySection.handleAction({
      req: fromLaptop({ body: { action: "save_history_settings", trash_days: "3" }, query: {}, dashboardSession: SSO }),
      res: sso,
      db: s.db,
      action: "save_history_settings",
      lang: "en",
    });
    assert.match(String(sso.url), /refused=not_owner/);
    assert.equal(await settingsRegistry.getSettingScope(s.db, HISTORY_SETTINGS.trashDays), "none");

    for (const days of ["0", "366", "abc"]) {
      const bad = { redirectAfterPost(url) { this.url = url; } };
      await historySection.handleAction({
        req: markFromLaptop(fromLaptop({ body: { action: "save_history_settings", trash_days: days }, query: {}, dashboardSession: OWN })),
        res: bad,
        db: s.db,
        action: "save_history_settings",
        lang: "en",
      });
      assert.match(String(bad.url), /refused=bad_days/, `trash_days=${days}`);
    }
    assert.equal(await settingsRegistry.getSettingScope(s.db, HISTORY_SETTINGS.trashDays), "none");
  } finally {
    s.close();
  }
});

test("Undo this job restores what it can and names what it could not", async () => {
  const s = await setup();
  try {
    const a = await insertMemory(s.db, OWNER_CTX, { content: "a before" });
    const b = await insertMemory(s.db, OWNER_CTX, { content: "b before" });
    // One bot job: it edits both memories and creates a post.
    await updateMemory(s.db, BOT, a, { content: "a after" });
    await updateMemory(s.db, BOT, b, { content: "b after" });
    const post = await insertPost(s.db, BOT, { slug: "job-post", title: "Made by the job" });
    // The owner edits B after the job: that item must be skipped, not overwritten.
    await updateMemory(s.db, OWNER_CTX, b, { content: "b edited by the owner" });

    const res = await postForm(s.base, "/dashboard/history/jobs", { action: "undo_job", job_id: BOT.jobId });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Undo result/);
    assert.match(html, /put back/, "the memory the job edited is restored");
    assert.match(html, /removed, and it is in the Trash/, "the post the job created goes to the Trash");
    assert.match(html, /skipped, it was edited after the job/);

    assert.equal((await s.db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [a] })).rows[0].content, "a before");
    assert.equal((await s.db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [b] })).rows[0].content, "b edited by the owner");
    assert.equal((await s.db.execute({ sql: "SELECT 1 FROM blog_posts WHERE id = ?", args: [post] })).rows.length, 0);
  } finally {
    s.close();
  }
});

test("Empty Trash asks on the page first, and only then erases", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, OWNER_CTX, { content: "to be erased" });
    await deleteMemory(s.db, OWNER_CTX, id);
    assert.ok((await listVersions(s.db, { itemType: "memory", itemId: String(id) })).length > 0);

    const ask = await postForm(s.base, "/dashboard/history/trash", { action: "empty_trash" });
    assert.equal(ask.status, 200);
    const askHtml = await ask.text();
    assert.match(askHtml, /Empty the Trash\?/);
    assert.ok((await listVersions(s.db, { itemType: "memory", itemId: String(id) })).length > 0, "asking erases nothing");

    const done = await postForm(s.base, "/dashboard/history/trash", { action: "empty_trash", confirm: "1" });
    assert.equal(done.status, 200);
    assert.match(await done.text(), /erased for good/);
    assert.equal((await listVersions(s.db, { itemType: "memory", itemId: String(id) })).length, 0, "emptying erases every version");
  } finally {
    s.close();
  }
});

test("the containment banner shows while a bot is not contained, and not once none is", async () => {
  const s = await setup();
  try {
    const id = await insertMemory(s.db, OWNER_CTX, { content: "banner check" });
    const banner = t("history.banner", "en");

    // No bots at all: no bot can write, so no caveat.
    const none = await (await getPage(s.base, `/dashboard/history/memory/${id}`)).text();
    assert.ok(!none.includes(banner), "no bots → no banner");

    // An enabled bot with no recorded contained spawn: not contained → the banner.
    await insertBot(s.db, { botId: "uncontained", displayName: "Uncontained" });
    const shown = await (await getPage(s.base, `/dashboard/history/memory/${id}`)).text();
    assert.ok(shown.includes(banner), "an uncontained bot → the banner");
  } finally {
    s.close();
  }
});

test("an unknown item type or a malformed id is a 404, not an empty History page", async () => {
  const s = await setup();
  try {
    for (const path of [
      "/dashboard/history/not_a_type/1",
      "/dashboard/history/memory/..%2f..%2fetc",
      "/dashboard/history/memory/" + "x".repeat(200),
    ]) {
      const res = await getPage(s.base, path);
      assert.equal(res.status, 404, path);
    }
    // A malformed page cursor is ignored, never a 500.
    const id = await insertMemory(s.db, OWNER_CTX, { content: "cursor check" });
    const badCursor = await getPage(s.base, `/dashboard/history/memory/${id}?before=nope`);
    assert.equal(badCursor.status, 200);
    assert.match(await badCursor.text(), /cursor check/);
  } finally {
    s.close();
  }
});

test("the Settings section renders for the owner with the size line and the read-only retention line", async () => {
  const s = await setup();
  try {
    await insertMemory(s.db, OWNER_CTX, { content: "size line" });
    // The section is registered on the real Settings menu (a deep link must not
    // bounce to the Settings home).
    assert.equal(settingsRegistry.getSettingsSection("history")?.id, "history");
    const html = await historySection.render({ req: { query: {}, csrfToken: CSRF }, db: s.db, lang: "en" });
    assert.match(html, /Forever/);
    assert.match(html, /Days a deleted item stays in the Trash/);
    assert.match(html, /Turn this on only when every paired Crow runs this version\./);
    assert.match(html, /Not used yet\./);
    const size = await historySize(s.db);
    assert.ok(size.versions > 0);
    assert.match(html, new RegExp(`${size.versions} versions, about`));
    assert.match(html, /name="_csrf" value="history-csrf-token"/);
  } finally {
    s.close();
  }
});

test("every history.* and settings.history* key has an en and an es string", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("history.") || k.startsWith("settings.history") || k === "settings.section.history");
  assert.ok(keys.length > 60, `expected the feature's key set, found ${keys.length}`);
  for (const key of keys) {
    for (const lang of ["en", "es"]) {
      assert.equal(typeof translations[key][lang], "string", `${key} missing ${lang}`);
      assert.ok(translations[key][lang].length > 0, `${key} has an empty ${lang}`);
    }
    assert.notEqual(translations[key].es, translations[key].en, `${key} is not translated`);
  }
});