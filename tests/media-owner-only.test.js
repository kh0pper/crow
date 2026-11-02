/**
 * Media Hub's API is the owner's. Every /api/media/* route answers anything that is not the
 * owner with the same 404 an unknown path gets, and changes nothing. The owner is a local
 * password session used from another machine (servers/gateway/dashboard/local-session.js):
 * not a plain session, not a session a paired instance's sign-in minted ('dashboard sso'), and
 * not the owner's own session replayed from this box (servers/shared/self-origin.js).
 *
 * The two audio streams are the exception (the player bar keeps working on other devices): a
 * plain or SSO session reaches their handler, which gives its own answer — an unknown id is its
 * own 404 with its own message, not the owner check's.
 *
 * The router itself: every route but those two runs login, then the owner check, then (on a
 * write) the CSRF check.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { seedSource, seedArticle, fakeMp3, REPO } from "./helpers/media-fixtures.js";
import { markFromLaptop } from "./helpers/off-box.js";
import { createDbClient } from "../servers/db.js";
import { initMediaTables } from "../bundles/media/server/init-tables.js";

let db, server, base, mediaRouter;
// "owner" is a local password session (scopes 'dashboard'), "plain" has no password scope, "sso"
// was minted by a paired instance's sign-in. The stub auth admits all three, as dashboardAuth does
// (its verifier ignores scopes); the router's owner check is what tells them apart.
const SESSIONS = { owner: "dashboard", plain: "", sso: "dashboard sso src:instance-peer" };
const TOKEN = "tok";
const OWNER_REFUSAL = { error: "Not found" };
// A request that really is from this box: it gets no peer-class memo, so its loopback socket makes
// self-origin read it as this machine and the owner's turn is refused.
const FROM_BOX = { "X-Test-Origin": "box" };

const auth = (req, res, next) => {
  const m = /crow_session=([a-z]+)/.exec(String(req.headers.cookie || ""));
  if (!m || !(m[1] in SESSIONS)) return res.status(401).json({ error: "login required" });
  req.dashboardSession = m[1];
  next();
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, stdio: "pipe" });
  db = createDbClient();
  const { createHash } = await import("node:crypto");
  for (const [who, scopes] of Object.entries(SESSIONS)) {
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now', '+1 day'))",
      args: [createHash("sha256").update(who).digest("hex"), scopes],
    });
  }
  const quiet = console.error; console.error = () => {};
  try {
    await initMediaTables(db);
    const { default: router } = await import("../bundles/media/panel/routes.js");
    mediaRouter = router;
    const app = express();
    app.use(express.json());
    // This file's own client is loopback, so a request reads as the owner's laptop's only when the
    // test says so: plant the peer-class memo a direct TCP peer would produce (tests/helpers/off-box.js).
    app.use((req, _res, next) => { if (req.headers["x-test-origin"] !== "box") markFromLaptop(req); next(); });
    app.use(mediaRouter(auth));
    server = app.listen(0, "127.0.0.1");
    await new Promise((ok) => server.once("listening", ok));
    base = `http://127.0.0.1:${server.address().port}`;
  } finally { console.error = quiet; }
});
after(async () => {
  server?.closeAllConnections(); await new Promise((ok) => server.close(ok));
  try { db?.close(); } catch {}
});
beforeEach(async () => {
  for (const t of ["media_playlist_items", "media_playlists", "media_feedback", "media_article_states",
    "media_audio_cache", "media_articles", "media_briefings", "media_sources"]) await db.execute(`DELETE FROM ${t}`);
});

const headersFor = (who, extra = {}) => ({ Cookie: `crow_session=${who}; crow_csrf=${TOKEN}`, ...extra });
const get = (path, who, extra = {}) => fetch(base + path, { headers: headersFor(who, extra) });
const post = (path, who, body, extra = {}) => fetch(base + path, {
  method: "POST",
  headers: headersFor(who, { "Content-Type": "application/json", "X-Crow-Csrf": TOKEN, ...extra }),
  body: JSON.stringify(body ?? {}),
});
const del = (path, who, extra = {}) => fetch(base + path, { method: "DELETE", headers: headersFor(who, { "X-Crow-Csrf": TOKEN, ...extra }) });

const TABLES = ["media_sources", "media_articles", "media_article_states", "media_audio_cache", "media_playlists", "media_playlist_items", "media_briefings"];
async function tally() {
  const out = {};
  for (const t of TABLES) out[t] = Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}

async function seedPlaylist(name) {
  return Number((await db.execute({ sql: "INSERT INTO media_playlists (name) VALUES (?)", args: [name] })).lastInsertRowid);
}

const OWNER_GETS = {
  "/api/media/feed": "articles",
  "/api/media/sources": "sources",
  "/api/media/playlists": "playlists",
  "/api/media/briefings": "briefings",
  "/api/media/stats": "sources",
};

test("not the owner: a plain session, an SSO session and the owner replayed from this box get the owner check's 404 everywhere, and change nothing", async () => {
  const source = await seedSource(db, { name: "Example Wire", url: "https://wire.example.invalid/feed" });
  await seedArticle(db, { source_id: source, title: "Bridge reopens after repairs", pub_date: new Date().toISOString(), url: "https://wire.example.invalid/1" });
  const playlist = await seedPlaylist("Mix");
  const was = await tally();

  for (const [who, extra, at] of [["plain", {}, "a plain session"], ["sso", {}, "an SSO session"], ["owner", FROM_BOX, "the owner's session from this box"]]) {
    for (const path of Object.keys(OWNER_GETS)) {
      const r = await get(path, who, extra);
      assert.deepEqual([r.status, await r.json()], [404, OWNER_REFUSAL], `${at}: GET ${path}`);
    }
    // Both writes carry the CSRF token, so the only thing that can refuse them is the owner check.
    const added = await post("/api/media/sources", who, { url: "http://127.0.0.1:9/nothing.xml" }, extra);
    assert.deepEqual([added.status, await added.json()], [404, OWNER_REFUSAL], `${at}: POST /api/media/sources`);
    const gone = await del(`/api/media/playlists/${playlist}`, who, extra);
    assert.deepEqual([gone.status, await gone.json()], [404, OWNER_REFUSAL], `${at}: DELETE the playlist`);
  }

  assert.deepEqual(await tally(), was, "no session added, removed or touched anything");
  assert.deepEqual((await db.execute("SELECT id, name FROM media_playlists")).rows.map((r) => ({ ...r })), [{ id: playlist, name: "Mix" }], "the playlist is still there");
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM media_sources WHERE name = 'Example Wire'")).rows[0].n, 1);
});

test("the owner from the laptop gets the owner's own answers", async () => {
  const source = await seedSource(db, { name: "Example Wire", url: "https://wire.example.invalid/feed" });
  await seedArticle(db, { source_id: source, title: "Bridge reopens after repairs", pub_date: new Date().toISOString(), url: "https://wire.example.invalid/1" });
  for (const [path, key] of Object.entries(OWNER_GETS)) {
    const r = await get(path, "owner");
    assert.equal(r.status, 200, `owner GET ${path}`);
    assert.ok(key in await r.json(), `owner GET ${path} answered with ${key}`);
  }
});

test("the two audio streams stay open to any signed-in session: a plain and an SSO session reach the handler", async () => {
  const { resolveAudioDir } = await import("../bundles/media/server/speech.js");
  const dir = resolveAudioDir();
  const src = await seedSource(db, { name: "Example Paper", url: "https://paper.example.invalid/feed" });
  const article = await seedArticle(db, { source_id: src, title: "School calendar approved", pub_date: new Date().toISOString() });
  const bytes = fakeMp3(6, { id3: false });
  const articleFile = join(dir, "owner-only-article.mp3");
  const briefingFile = join(dir, "owner-only-briefing.mp3");
  writeFileSync(articleFile, bytes);
  writeFileSync(briefingFile, bytes);
  await db.execute({
    sql: "INSERT INTO media_audio_cache (article_id, content_hash, audio_path, file_size) VALUES (?, 'hash', ?, ?)",
    args: [article, articleFile, bytes.length],
  });
  const briefing = Number((await db.execute({
    sql: "INSERT INTO media_briefings (title, kind, status, audio_path, duration_sec) VALUES ('Morning briefing', 'daily', 'ready', ?, 5)",
    args: [briefingFile],
  })).lastInsertRowid);

  for (const who of ["plain", "sso"]) {
    const a = await get(`/api/media/articles/${article}/audio`, who, { Range: "bytes=0-9" });
    assert.deepEqual([a.status, (await a.arrayBuffer()).byteLength], [206, 10], `${who}: the article's audio is served`);
    const b = await get(`/api/media/briefings/${briefing}/audio`, who);
    assert.equal(b.status, 200, `${who}: the briefing's audio is served`);
    assert.deepEqual(Buffer.from(await b.arrayBuffer()), bytes);

    // An id with no audio is the handler's own 404 and the handler's own message, never the owner
    // check's {"error":"Not found"}, which is what proves the request reached the handler.
    const noArticle = await get("/api/media/articles/999999/audio", who);
    assert.equal(noArticle.status, 404);
    assert.notDeepEqual(await noArticle.json(), OWNER_REFUSAL, `${who}: the article audio handler answered`);
    const noBriefing = await get("/api/media/briefings/999999/audio", who);
    assert.equal(noBriefing.status, 404);
    assert.notDeepEqual(await noBriefing.json(), OWNER_REFUSAL, `${who}: the briefing audio handler answered`);
  }
});

test("every /api/media route runs the owner check right after login, except the two audio streams; a write runs CSRF after both", () => {
  const router = mediaRouter(auth);
  const open = new Set(["GET /api/media/articles/:id/audio", "GET /api/media/briefings/:id/audio"]);
  const seen = new Set();
  for (const layer of router.stack.filter((l) => l.route && l.route.path.startsWith("/api/media/"))) {
    for (const method of Object.keys(layer.route.methods)) {
      const key = `${method.toUpperCase()} ${layer.route.path}`;
      const names = layer.route.stack.map((s) => s.name);
      seen.add(key);
      const owner = names.indexOf("ownerOnly");
      if (open.has(key)) { assert.equal(owner, -1, `${key} must stay open to any signed-in session`); continue; }
      assert.equal(names[0], "auth", `${key} must run the login check first`);
      assert.equal(owner, 1, `${key} must run the owner check right after login`);
      const csrf = names.indexOf("csrfMiddleware");
      if (csrf !== -1) assert.ok(csrf > owner, `${key} must run the owner check before the CSRF check`);
    }
  }
  for (const key of open) assert.ok(seen.has(key), `${key} is in the router`);
  assert.ok(seen.size >= 25, `${seen.size} routes`);
});