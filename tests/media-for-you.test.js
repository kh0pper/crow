/**
 * Media Hub's picks for the For You page (bundles/media/server/for-you.js) and its "hide this
 * source" route: few good stories over many weak ones, each with the evidence for why it is
 * there, no podcast or read or thumbed-down story, at most two per source, and a hidden source
 * left out until it is shown again. The route needs a session and the gateway's CSRF check.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import express from "express";
import { seedSource, seedArticle, REPO } from "./helpers/media-fixtures.js";
import { createDbClient } from "../servers/db.js";
import { initMediaTables } from "../bundles/media/server/init-tables.js";
import { forYouStories, hiddenSources, setSourceHidden, scoreStory, PICK_MAX, LIKED } from "../bundles/media/server/for-you.js";

let db, server, base;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
// Sessions: "owner" is a local password session (scopes 'dashboard'), "plain" has no password
// scope, "sso" was minted by a paired instance's sign-in. The stub auth admits all three, as
// dashboardAuth does (its verifier ignores scopes).
const SESSIONS = { owner: "dashboard", plain: "", sso: "dashboard sso src:instance-peer" };
const AUTH = { Cookie: "crow_session=owner; crow_csrf=tok", "Content-Type": "application/json" };
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
  for (const [tok, scopes] of Object.entries(SESSIONS)) {
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now', '+1 day'))",
      args: [createHash("sha256").update(tok).digest("hex"), scopes],
    });
  }
  const quiet = console.error; console.error = () => {};
  try {
    await initMediaTables(db);
    const { default: mediaRouter } = await import("../bundles/media/panel/routes.js");
    const app = express();
    app.use(express.json());
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
  for (const t of ["media_feedback", "media_article_states", "media_articles", "media_interest_profiles", "media_sources"]) await db.execute(`DELETE FROM ${t}`);
});

async function article(source_id, title, h, extra = {}) {
  const id = await seedArticle(db, { source_id, title, summary: extra.summary ?? `Summary of ${title}.`, pub_date: hoursAgo(h), url: extra.url === undefined ? `https://news.example.invalid/${encodeURIComponent(title)}` : extra.url });
  if (extra.topics) await db.execute({ sql: "UPDATE media_articles SET topics = ? WHERE id = ?", args: [JSON.stringify(extra.topics), id] });
  return id;
}
const profile = (type, key, affinity) => db.execute({ sql: "INSERT INTO media_interest_profiles (profile_type, profile_key, affinity, interaction_count) VALUES (?, ?, ?, 3)", args: [type, key, affinity] });

test("scoreStory: the most specific liked match is the why; a neutral story is 'new'", () => {
  const prof = new Map([["topic:local ai", { key: "local ai", affinity: 0.8 }], ["source:7", { key: "7", affinity: 0.9 }]]);
  const a = { source_id: 7, source_name: "Wire", topics: JSON.stringify(["Local AI"]), pub_date: hoursAgo(1) };
  assert.deepEqual(scoreStory(a, prof, NOW).why, { kind: "topic", label: "local ai", affinity: 0.8 });
  assert.deepEqual(scoreStory({ ...a, topics: "[]" }, prof, NOW).why, { kind: "source", label: "Wire", affinity: 0.9 });
  assert.deepEqual(scoreStory({ ...a, source_id: 8, topics: "[]" }, prof, NOW).why, { kind: "new" });
  assert.deepEqual(scoreStory({ ...a, source_id: 8, topics: "[]", popularity_score: 9 }, prof, NOW).why, { kind: "popular" });
  // A topic you don't like (below LIKED) is never the reason.
  assert.deepEqual(scoreStory(a, new Map([["topic:local ai", { key: "local ai", affinity: LIKED - 0.01 }]]), NOW).why, { kind: "new" });
});

test("the picks: capped, at most two per source, best first; podcasts, read, thumbed-down, stale and linkless stories never", async () => {
  const sources = [];
  for (let i = 0; i < 6; i++) sources.push(await seedSource(db, { name: `Wire ${i}`, url: `https://wire${i}.example.invalid/feed` }));
  for (const s of sources) for (let k = 0; k < 3; k++) await article(s, `Story ${s}-${k}`, 1 + k);
  const pod = await seedSource(db, { name: "A show", url: "https://show.example.invalid/feed", type: "podcast" });
  await article(pod, "Episode 1", 1);
  const read = await article(sources[0], "Already read", 1);
  await db.execute({ sql: "INSERT INTO media_article_states (article_id, is_read) VALUES (?, 1)", args: [read] });
  const down = await article(sources[1], "Thumbed down", 1);
  await db.execute({ sql: "INSERT INTO media_feedback (article_id, feedback) VALUES (?, 'down')", args: [down] });
  await article(sources[2], "Two days old", 60);
  await article(sources[3], "No link", 1, { url: null });
  await article(sources[3], "Not a web link", 1, { url: "javascript:alert(1)" });

  const picks = await forYouStories(db, { now: NOW });
  assert.equal(picks.length, PICK_MAX);
  const titles = picks.map((p) => p.title);
  for (const bad of ["Episode 1", "Already read", "Thumbed down", "Two days old", "No link", "Not a web link"]) assert.ok(!titles.includes(bad), bad);
  const per = new Map();
  for (const p of picks) per.set(p.sourceId, (per.get(p.sourceId) || 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 2), "two per source at most");
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1].score >= picks[i].score, "best first");
  assert.ok(picks.every((p) => /^https:\/\//.test(p.url) && p.sourceName.startsWith("Wire")));
  assert.equal((await forYouStories(db, { now: NOW, limit: 3 })).length, 3);
});

test("fewer when there aren't good ones: a disliked source's old stories don't make the cut, and none is fine", async () => {
  assert.deepEqual(await forYouStories(db, { now: NOW }), []);
  const meh = await seedSource(db, { name: "Meh", url: "https://meh.example.invalid/feed" });
  await profile("source", String(meh), 0.1);
  await article(meh, "Old and unloved", 40);
  const good = await seedSource(db, { name: "Good", url: "https://good.example.invalid/feed" });
  await profile("source", String(good), 0.9);
  await article(good, "Fresh and liked", 1);
  const picks = await forYouStories(db, { now: NOW });
  assert.deepEqual(picks.map((p) => p.title), ["Fresh and liked"]);
  assert.deepEqual(picks[0].why, { kind: "source", label: "Good", affinity: 0.9 });
});

test("a hidden source is left out until it is shown again", async () => {
  const s = await seedSource(db, { name: "Loud", url: "https://loud.example.invalid/feed" });
  await article(s, "Loud story", 1);
  assert.equal((await forYouStories(db, { now: NOW })).length, 1);
  assert.equal(await setSourceHidden(db, s, true), true);
  assert.deepEqual(await forYouStories(db, { now: NOW }), []);
  assert.deepEqual(await hiddenSources(db), [{ id: s, name: "Loud" }]);
  assert.equal(await setSourceHidden(db, s, false), true);
  assert.equal((await forYouStories(db, { now: NOW })).length, 1);
  assert.equal(await setSourceHidden(db, 99999, true), false);
});

test("POST /api/media/sources/:id/hidden: a session, the owner only, CSRF, then a boolean, then the source", async () => {
  const s = await seedSource(db, { name: "Loud", url: "https://loud.example.invalid/feed" });
  const post = (path, body, headers = AUTH) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await post(`/api/media/sources/${s}/hidden`, { hidden: true }, { "Content-Type": "application/json" })).status, 401);
  assert.equal((await post(`/api/media/sources/${s}/hidden`, { hidden: true })).status, 403, "no CSRF header");
  const H = { ...AUTH, "X-Crow-Csrf": "tok" };
  // Only the owner: a session without the password scope, or a paired instance's SSO session,
  // gets 404 and changes nothing.
  for (const who of ["plain", "sso"]) {
    const r = await post(`/api/media/sources/${s}/hidden`, { hidden: true }, { ...H, Cookie: `crow_session=${who}; crow_csrf=tok` });
    assert.equal(r.status, 404, who);
  }
  assert.deepEqual(await hiddenSources(db), [], "no non-owner change landed");
  assert.equal((await post(`/api/media/sources/${s}/hidden`, { hidden: "yes" }, H)).status, 400);
  assert.equal((await post("/api/media/sources/99999/hidden", { hidden: true }, H)).status, 404);
  const ok = await post(`/api/media/sources/${s}/hidden`, { hidden: true }, H);
  assert.deepEqual([ok.status, await ok.json()], [200, { ok: true, hidden: true }]);
  assert.deepEqual(await hiddenSources(db), [{ id: s, name: "Loud" }]);
  await post(`/api/media/sources/${s}/hidden`, { hidden: false }, H);
  assert.deepEqual(await hiddenSources(db), []);
});
