/**
 * Media Hub's picks for the For You page (bundles/media/server/for-you.js) and its "hide this
 * source" route: few good stories over many weak ones, each with the evidence for why it is
 * there, no podcast or read or thumbed-down story, at most two per source, and a hidden source
 * left out until it is shown again. The route needs a session and the gateway's CSRF check.
 * For You's Listen section (1.2.3): today's daily briefing with audio (36 h at most, else the
 * next scheduled time) and the newest three unplayed https podcast episodes.
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
  // Popularity is never a reason (Media Hub never writes popularity_score).
  assert.deepEqual(scoreStory({ ...a, source_id: 8, topics: "[]", popularity_score: 9 }, prof, NOW).why, { kind: "new" });
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

test("story summaries: feed HTML becomes text, Google News items show their publisher and no repeated title", async () => {
  const { storySummary, htmlToText } = await import("../bundles/media/server/for-you.js");
  const g = '<a href="https://news.google.com/rss/articles/X?oc=5" target="_blank">More rain likely for South Texas Friday.</a>&nbsp;&nbsp;<font color="#6f6f6f">San Antonio Express-News</font>';
  assert.deepEqual(storySummary(g, "More rain likely for South Texas Friday."), { summary: null, publisher: "San Antonio Express-News" });
  assert.deepEqual(storySummary("<p>Rates rose <b>0.25%</b> &amp; markets fell.</p>", "Fed raises rates"), { summary: "Rates rose 0.25% & markets fell.", publisher: null });
  assert.deepEqual(storySummary("Fed raises rates", "Fed raises rates"), { summary: null, publisher: null });
  assert.deepEqual(storySummary(null, "x"), { summary: null, publisher: null });
  assert.equal(htmlToText("a&#39;b &#x41; &nbsp;c"), "a'b A c");
  assert.equal(htmlToText("x&#99999999;y&#x110000;z&#0;w"), "x y z w", "out-of-range code points never throw");
  assert.doesNotMatch(String(storySummary("<script>x</script>hi", "t").summary), /</);
});

// ---- Listen (media 1.2.3) -------------------------------------------------------------------

const sqlAgo = (h) => new Date(NOW - h * 3600000).toISOString().replace("T", " ").slice(0, 19);
async function briefing({ h, kind = "daily", audio = true, status = "ready", title = "Morning briefing" }) {
  const { resolveAudioDir } = await import("../bundles/media/server/speech.js");
  const r = await db.execute({ sql: "INSERT INTO media_briefings (title, kind, status, duration_sec, created_at) VALUES (?, ?, ?, 312.4, ?)", args: [title, kind, status, sqlAgo(h)] });
  const id = Number(r.lastInsertRowid);
  if (audio) {
    const { writeFileSync } = await import("node:fs");
    const file = `${resolveAudioDir()}/briefing-${id}.mp3`;
    writeFileSync(file, Buffer.from("ID3 not really audio, but not empty"));
    await db.execute({ sql: "UPDATE media_briefings SET audio_path = ? WHERE id = ?", args: [file, id] });
  }
  return id;
}

test("Listen briefing: the newest daily briefing with audio from the last 36 h; else none, with the next scheduled time", async () => {
  const { forYouBriefing, BRIEFING_MAX_AGE_HOURS } = await import("../bundles/media/server/for-you.js");
  await db.execute("DELETE FROM media_briefings");
  await db.execute("DELETE FROM schedules WHERE task = 'media:briefing'");
  assert.equal(BRIEFING_MAX_AGE_HOURS, 36);
  assert.deepEqual(await forYouBriefing(db, { now: NOW }), { briefing: null, next: null }, "no briefing, no schedule");

  await briefing({ h: 40, title: "Morning briefing, Monday" });
  assert.equal((await forYouBriefing(db, { now: NOW })).briefing, null, "older than 36 h is not today's");

  const today = await briefing({ h: 4, title: "Morning briefing, Wednesday" });
  await briefing({ h: 2, title: "A topic briefing", kind: "manual" });
  await briefing({ h: 1, title: "Still voicing", status: "generating", audio: false });
  await briefing({ h: 1, title: "Voice failed", audio: false });
  const r = await forYouBriefing(db, { now: NOW });
  assert.deepEqual(r, {
    briefing: { id: today, title: "Morning briefing, Wednesday", durationSec: 312.4, createdAt: new Date(NOW - 4 * 3600000).toISOString(), audioUrl: `/api/media/briefings/${today}/audio` },
    next: null,
  });

  // None ready: the schedule's next run, when it is on.
  await db.execute("DELETE FROM media_briefings");
  await db.execute("INSERT INTO schedules (task, cron_expression, description, enabled) VALUES ('media:briefing', '0 8 * * *', 'Daily news briefing (News)', 1)");
  const none = await forYouBriefing(db, { now: NOW });
  assert.equal(none.briefing, null);
  const at = Date.parse(none.next.at);
  assert.ok(at > NOW && at <= NOW + 24 * 3600000, none.next.at);
  assert.equal(typeof none.next.tz, "string");
  await db.execute("UPDATE schedules SET enabled = 0 WHERE task = 'media:briefing'");
  assert.equal((await forYouBriefing(db, { now: NOW })).next, null, "a schedule that is off has no next time");
  await db.execute("DELETE FROM schedules WHERE task = 'media:briefing'");
});

test("Listen podcasts: the newest three unplayed episodes with an https enclosure, from enabled podcast sources only", async () => {
  const { forYouEpisodes, httpsUrl } = await import("../bundles/media/server/for-you.js");
  assert.deepEqual(await forYouEpisodes(db), { shows: 0, episodes: [] }, "no podcasts followed");
  const show = await seedSource(db, { name: "A &amp; B Show", url: "https://show.example.invalid/feed", type: "podcast" });
  const off = await seedSource(db, { name: "Paused show", url: "https://off.example.invalid/feed", type: "podcast", enabled: 0 });
  const news = await seedSource(db, { name: "Wire", url: "https://wire.example.invalid/feed" });
  const ep = (source_id, title, h, audio_url) => seedArticle(db, { source_id, title, pub_date: hoursAgo(h), audio_url });
  const e1 = await ep(show, "Episode 1", 1, "https://cdn.example.invalid/1.mp3");
  const played = await ep(show, "Episode 2 (played)", 2, "https://cdn.example.invalid/2.mp3");
  await db.execute({ sql: "INSERT INTO media_article_states (article_id, is_read) VALUES (?, 1)", args: [played] });
  await ep(show, "Episode 3 (http)", 3, "http://cdn.example.invalid/3.mp3");
  const e4 = await ep(show, "Episode 4", 4, "https://cdn.example.invalid/4.mp3");
  const e5 = await ep(show, "Episode 5", 5, "https://cdn.example.invalid/5.mp3");
  await ep(show, "Episode 6", 6, "https://cdn.example.invalid/6.mp3");
  await ep(off, "From a paused show", 0.5, "https://cdn.example.invalid/p.mp3");
  await ep(news, "A story with audio", 0.5, "https://cdn.example.invalid/n.mp3");

  const r = await forYouEpisodes(db);
  assert.equal(r.shows, 1);
  assert.deepEqual(r.episodes.map((e) => e.id), [e1, e4, e5]);
  assert.deepEqual(r.episodes[0], { id: e1, title: "Episode 1", show: "A & B Show", sourceId: show, publishedAt: hoursAgo(1), audioUrl: "https://cdn.example.invalid/1.mp3" });
  assert.equal((await forYouEpisodes(db, { limit: 1 })).episodes.length, 1);
  assert.equal(httpsUrl("https://user:pw@cdn.example.invalid/x.mp3"), "", "no credentials in an address");
  assert.equal(httpsUrl("javascript:alert(1)"), "");
});

test("story titles and source names are plain text: feed entities are decoded (operator report 2026-10-30)", async () => {
  const src = await seedSource(db, { name: "Al Jazeera &#8211; Breaking News", url: "https://aj.example.invalid/feed" });
  await article(src, "Showers &amp; downpours for San Antonio again today", 1);
  const [p] = await forYouStories(db, { now: NOW });
  assert.equal(p.title, "Showers & downpours for San Antonio again today");
  assert.equal(p.sourceName, "Al Jazeera – Breaking News");
});
