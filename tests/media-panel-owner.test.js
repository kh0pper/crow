/**
 * The Media Hub panel page is the owner's: bundles/media/panel/media.js answers anything that is
 * not the owner with the same 404 an unknown page gets — the rendered page and its POST forms
 * alike — and changes nothing. The owner is a local password session used from another machine
 * (servers/gateway/dashboard/local-session.js): not a plain session, not a session a paired
 * instance's sign-in minted ('dashboard sso'), and not the owner's own session replayed from
 * this box (servers/shared/self-origin.js).
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { REPO, seedSource, seedArticle } from "./helpers/media-fixtures.js";
import { fromLaptop } from "./helpers/off-box.js";
import { createDbClient } from "../servers/db.js";
import { initMediaTables } from "../bundles/media/server/init-tables.js";
import panel from "../bundles/media/panel/media.js";

let db;
// "owner" is a local password session (scopes 'dashboard'), "plain" has no password scope, "sso"
// was minted by a paired instance's sign-in. The panel's owner check is what tells them apart.
const SESSIONS = { owner: "dashboard", plain: "", sso: "dashboard sso src:instance-peer" };
const FEED_URL = "https://feeds.example.invalid/owner-panel.xml";

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, stdio: "pipe" });
  db = createDbClient();
  for (const [who, scopes] of Object.entries(SESSIONS)) {
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now', '+1 day'))",
      args: [createHash("sha256").update(who).digest("hex"), scopes],
    });
  }
  const quiet = console.error; console.error = () => {};
  try { await initMediaTables(db); } finally { console.error = quiet; }
});
after(() => { try { db?.close(); } catch {} });
beforeEach(async () => {
  for (const t of ["media_playlist_items", "media_playlists", "media_article_states", "media_articles", "media_sources"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

/** A request for the panel, from the owner's laptop (tests/helpers/off-box.js) unless fromBox. */
function request({ method = "GET", query = { tab: "feed" }, body = {} }, dashboardSession, { fromBox = false } = {}) {
  const req = { method, query, body, dashboardSession };
  if (fromBox) req.socket = { remoteAddress: "127.0.0.1" };
  else fromLaptop(req);
  return req;
}

/** Drives the real handler with a recording res; `page` is what layout() was asked to render. */
async function run(req) {
  const res = {
    statusCode: null, sent: null, redirects: [],
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(value) { this.sent = value; return this; },
    redirectAfterPost(url) { this.redirects.push(url); return null; },
  };
  let page = null;
  const returned = await panel.handler(req, res, {
    db, appRoot: REPO, lang: "en", layout: (opts) => { page = opts; return opts; },
  });
  return { res, page, returned };
}

const count = async (table) => Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
const tally = async () => ({ media_sources: await count("media_sources"), media_playlists: await count("media_playlists") });

test("not the owner: the page and the POST forms answer the owner check's 404 and change nothing", async () => {
  const source = await seedSource(db, { name: "Example Wire", url: "https://wire.example.invalid/feed" });
  await seedArticle(db, { source_id: source, title: "Bridge reopens after repairs", pub_date: new Date().toISOString(), url: "https://wire.example.invalid/1" });
  const playlist = Number((await db.execute({ sql: "INSERT INTO media_playlists (name) VALUES (?)", args: ["Mix"] })).lastInsertRowid);
  const was = await tally();

  const cases = [
    { at: "a plain session", session: "plain", fromBox: false },
    { at: "an SSO session", session: "sso", fromBox: false },
    { at: "the owner's session from this box", session: "owner", fromBox: true },
  ];
  for (const { at, session, fromBox } of cases) {
    const ask = (over = {}) => run(request(over, session, { fromBox }));

    const page = await ask();
    assert.deepEqual([page.res.statusCode, page.res.sent, page.returned, page.page], [404, "Not found", null, null], `${at}: GET the panel page`);

    const added = await ask({ method: "POST", query: {}, body: { action: "add_source", url: FEED_URL, name: "Owner Panel Wire" } });
    assert.deepEqual([added.res.statusCode, added.res.sent, added.res.redirects, added.returned], [404, "Not found", [], null], `${at}: POST add_source`);

    const deleted = await ask({ method: "POST", query: {}, body: { action: "delete_playlist", playlist_id: String(playlist) } });
    assert.deepEqual([deleted.res.statusCode, deleted.res.sent, deleted.res.redirects, deleted.returned], [404, "Not found", [], null], `${at}: POST delete_playlist`);
  }

  assert.deepEqual(await tally(), was, "no session added or removed a source or a playlist");
  assert.deepEqual((await db.execute("SELECT id, name FROM media_playlists")).rows.map((r) => ({ ...r })), [{ id: playlist, name: "Mix" }], "the playlist is still there");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM media_sources WHERE url = ?", args: [FEED_URL] })).rows[0].n, 0, "the feed address was never added");
});

test("the owner from the laptop gets the page", async () => {
  const source = await seedSource(db, { name: "Example Wire", url: "https://wire.example.invalid/feed" });
  await seedArticle(db, { source_id: source, title: "Bridge reopens after repairs", pub_date: new Date().toISOString(), url: "https://wire.example.invalid/1" });

  for (const tab of ["feed", "sources", "playlists"]) {
    const { res, page, returned } = await run(request({ query: { tab } }, "owner"));
    assert.equal(res.statusCode, null, `owner GET tab=${tab} is not refused`);
    assert.equal(res.sent, null, `owner GET tab=${tab} is answered by the page, not the refusal`);
    assert.ok(page && typeof page.content === "string" && page.content.length > 0, `owner GET tab=${tab} renders`);
    assert.deepEqual(returned, page, `owner GET tab=${tab} returns the rendered page`);
    assert.match(page.content, /media-tabs/, `owner GET tab=${tab} is the panel page`);
  }
});