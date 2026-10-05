/**
 * The media panel's HTTP routes that Phase 0 adds or rewrites (bundles/media/panel/routes.js),
 * served by a real Express app over real HTTP: the latest-briefing contract, making a briefing,
 * the schedule, audio with byte ranges and path confinement, auth on every route, the gateway's
 * real CSRF check and its real Funnel guard.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { startFakeVoice, setVoiceProfiles, CLOUD_DEFAULT, localVoice, seedSource, seedArticle, fakeMp3, REPO, FRAME_BYTES } from "./helpers/media-fixtures.js";
import { createDbClient } from "../servers/db.js";
import { rejectFunneledMiddleware } from "../servers/gateway/funnel.js";
import { resolveAudioDir } from "../bundles/media/server/speech.js";

let db, voice, server, base, publicBase, mediaRouter, routesModule;
const AUTH_HEADER = { Cookie: "crow_session=s1; crow_csrf=tok123" };
const auth = (req, res, next) => (String(req.headers.cookie || "").includes("crow_session=s1") ? next() : res.status(401).json({ error: "login required" }));

before(async () => {
  // The routes open the instance database themselves: this file's own one (helpers/media-isolate.js).
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, stdio: "pipe" });
  const quiet = console.error; console.error = () => {};
  try { routesModule = await import("../bundles/media/panel/routes.js"); } finally { console.error = quiet; }
  mediaRouter = routesModule.default;
  db = createDbClient();
  voice = await startFakeVoice();
  await setVoiceProfiles(db, [CLOUD_DEFAULT, localVoice(voice.url)]);
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.use(express.json());
  app.use(mediaRouter(auth));
  server = app.listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.closeAllConnections(); await new Promise((ok) => server.close(ok));
  await voice?.close();
  try { db?.close(); } catch {}
});

const get = (path, headers = {}) => fetch(base + path, { headers: { ...AUTH_HEADER, ...headers } });
const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { ...AUTH_HEADER, "Content-Type": "application/json", "X-Crow-Csrf": "tok123", ...headers }, body: JSON.stringify(body || {}) });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((ok) => setTimeout(ok, 50)); } };

test("every route in the panel router starts with the dashboard's auth, and answers 401 without a session", async () => {
  const router = mediaRouter(auth);
  const routes = router.stack.filter((l) => l.route);
  assert.ok(routes.length >= 25, `${routes.length} routes`);
  for (const l of routes) assert.equal(l.route.stack[0].handle, auth, `${Object.keys(l.route.methods)} ${l.route.path} must run auth first`);
  for (const path of ["/api/media/briefings/latest", "/api/media/briefings/1", "/api/media/briefings/1/audio", "/api/media/briefings/schedule", "/api/media/briefings", "/api/media/articles/1/audio"]) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(`${base}/api/media/briefings`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/api/media/briefings/schedule`, { method: "POST" })).status, 401);
});

test("nothing is reachable over Funnel: the gateway's own guard refuses every media path, session or not", async () => {
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  const paths = ["/api/media/briefings/latest", "/api/media/briefings/1", "/api/media/briefings/1/audio", "/api/media/briefings/schedule", "/api/media/articles/1/audio", "/dashboard/media"];
  for (const path of paths) {
    assert.equal(PUBLIC_FUNNEL_PREFIXES.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p)), false, path);
    assert.equal((await get(path, { "Tailscale-Funnel-Request": "?1" })).status, 403, path);
  }
});

test("latest briefing over HTTP: 404 with a word when there is none, then the same object the function returns", async () => {
  const none = await get("/api/media/briefings/latest");
  assert.deepEqual([none.status, await none.json()], [404, { error: "no_briefing" }]);
  const wire = await seedSource(db, { name: "Example Wire", url: "http://127.0.0.1:9/feed" });
  await seedArticle(db, { source_id: wire, title: "Bridge reopens after repairs", summary: "The bridge reopened on Monday.", pub_date: new Date(Date.now() - 3_600_000).toISOString(), url: "https://wire.example.invalid/1" });
  const made = await post("/api/media/briefings", { count: "5" });
  assert.equal(made.status, 202);
  const first = await made.json();
  assert.deepEqual([first.status, first.kind, first.audio_url], ["generating", "manual", null]);
  const again = await (await post("/api/media/briefings", {})).json();
  assert.equal(again.id, first.id, "a second press while one is being made returns the same briefing");
  const ready = await until(async () => { const b = await (await get(`/api/media/briefings/${first.id}`)).json(); return b.status === "ready" ? b : null; });
  assert.equal(ready.audio_url, `/api/media/briefings/${first.id}/audio`);
  assert.ok(ready.duration_sec > 0);
  assert.equal(ready.items[0].link, "https://wire.example.invalid/1");
  assert.match(ready.script, /^Good (morning|afternoon|evening)\. It's /);
  const latest = await (await get("/api/media/briefings/latest")).json();
  const { getLatestBriefing } = await import("../bundles/media/server/briefing.js");
  const direct = await getLatestBriefing(db);
  assert.deepEqual({ ...latest, age_hours: 0 }, { ...direct, age_hours: 0 }, "the route and the exported function agree");
  assert.deepEqual(Object.keys(latest).sort(), ["age_hours", "attachments", "audio_url", "chapters", "created_at", "date", "duration_sec", "error", "id", "items", "kind", "lang", "late", "ready_at", "scheduled_for", "script", "status", "title"]);
  assert.equal((await get("/api/media/briefings/latest?kind=daily")).status, 404);
  assert.equal((await get("/api/media/briefings/latest?max_age_hours=0.000001")).status, 404);
  assert.equal((await get("/api/media/briefings/latest?max_age_hours=36")).status, 200);
  assert.equal((await get("/api/media/briefings/latest?audio=0")).status, 200);
  assert.equal((await get("/api/media/briefings/999999")).status, 404);
  assert.equal((await get("/api/media/briefings/1e3")).status, 404, "an id is digits only");
  const list = await (await get("/api/media/briefings")).json();
  assert.equal(list.briefings[0].id, first.id);
});

test("state-changing routes use the gateway's CSRF check: a session without the echoed token is refused", async () => {
  const noToken = await post("/api/media/briefings/schedule", { time: "08:00" }, { "X-Crow-Csrf": "" });
  assert.equal(noToken.status, 403);
  const wrong = await post("/api/media/briefings", {}, { "X-Crow-Csrf": "other" });
  assert.equal(wrong.status, 403);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM schedules WHERE task = 'media:briefing'")).rows[0].n, 0);
});

test("the schedule over HTTP: read, set a time and a show, refuse what cannot run", async () => {
  assert.equal((await (await get("/api/media/briefings/schedule")).json()).view.state, "unset");
  const show = await seedSource(db, { name: "The Example Hour", url: "https://show.example.invalid/p.xml", type: "podcast" });
  const saved = await post("/api/media/briefings/schedule", { time: "07:30", enabled: true, max_stories: 6, show_source_id: show, show_title_prefix: "The Example Hour 20" });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual([body.view.state, body.view.time, body.cfg.max_stories, body.cfg.attach[0].source_id, body.cfg.attach[0].days], ["on", "07:30", 6, show, [1, 2, 3, 4, 5]]);
  assert.deepEqual((await db.execute("SELECT cron_expression, enabled FROM schedules WHERE task = 'media:briefing'")).rows.map((r) => ({ ...r })), [{ cron_expression: "30 7 * * *", enabled: 1 }]);
  const bad = await post("/api/media/briefings/schedule", { time: "25:99" });
  assert.deepEqual([bad.status, (await bad.json()).code], [400, "bad_time"]);
  const notShow = await post("/api/media/briefings/schedule", { show_source_id: 424242 });
  assert.deepEqual([notShow.status, (await notShow.json()).code], [400, "bad_source"]);
  assert.equal((await (await post("/api/media/briefings/schedule", { enabled: false, show_source_id: 0 })).json()).view.state, "off");
});

test("briefing audio: whole file, single byte ranges, 416 for a bad range, and only files inside the audio directory", async () => {
  const dir = resolveAudioDir();
  const good = join(dir, "routes-range.mp3");
  const bytes = fakeMp3(20, { id3: false });
  writeFileSync(good, bytes);
  const outside = join(dir, "..", "routes-outside.mp3");
  writeFileSync(outside, bytes);
  try { symlinkSync(outside, join(dir, "routes-link.mp3")); } catch {}
  const ins = async (path) => Number((await db.execute({ sql: "INSERT INTO media_briefings (title, script, audio_path) VALUES ('t', 's', ?)", args: [path] })).lastInsertRowid);
  const id = await ins(good);
  const size = bytes.length;
  assert.equal(size, 20 * FRAME_BYTES);

  const whole = await get(`/api/media/briefings/${id}/audio`);
  assert.deepEqual([whole.status, whole.headers.get("content-type"), whole.headers.get("accept-ranges"), whole.headers.get("content-length")], [200, "audio/mpeg", "bytes", String(size)]);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  const range = async (value) => { const r = await get(`/api/media/briefings/${id}/audio`, { Range: value }); return [r.status, r.headers.get("content-range"), (await r.arrayBuffer()).byteLength]; };
  assert.deepEqual(await range("bytes=0-99"), [206, `bytes 0-99/${size}`, 100]);
  assert.deepEqual(await range("bytes=100-"), [206, `bytes 100-${size - 1}/${size}`, size - 100]);
  assert.deepEqual(await range("bytes=-50"), [206, `bytes ${size - 50}-${size - 1}/${size}`, 50]);
  assert.deepEqual(await range(`bytes=10-${size + 5000}`), [206, `bytes 10-${size - 1}/${size}`, size - 10], "an end past the file is clamped");
  assert.deepEqual(await range(`bytes=${size - 1}-`), [206, `bytes ${size - 1}-${size - 1}/${size}`, 1]);
  for (const bad of [`bytes=${size}-`, "bytes=5-2", "bytes=abc", "bytes=-", "bytes=-0", "bytes=0-1,5-6", "items=0-5", "bytes=1e3-", `bytes=${"9".repeat(30)}-`]) {
    assert.deepEqual(await range(bad), [416, `bytes */${size}`, 0], bad);
  }
  const mid = await get(`/api/media/briefings/${id}/audio`, { Range: "bytes=384-767" });
  assert.deepEqual(Buffer.from(await mid.arrayBuffer()), bytes.subarray(384, 768), "the bytes asked for");

  for (const path of [outside, "/etc/passwd", join(dir, "..", "..", "crow.db"), join(dir, "routes-link.mp3"), join(dir, "missing.mp3"), join(dir, "..", "audio", "..", "routes-outside.mp3")]) {
    const r = await get(`/api/media/briefings/${await ins(path)}/audio`);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get("content-type").includes("json"), true);
  }
  assert.equal((await get(`/api/media/briefings/${await ins(null)}/audio`)).status, 404);
  assert.equal((await get("/api/media/briefings/abc/audio")).status, 404);
});

test("article audio is made by the local voice and served with the same rules; with no local voice the reason comes back", async () => {
  const src = await seedSource(db, { name: "Example Paper", url: "http://127.0.0.1:9/paper" });
  const a = await seedArticle(db, { source_id: src, title: "School calendar approved", content_full: "Classes begin on August twelfth this year.", pub_date: new Date().toISOString() });
  assert.equal((await get(`/api/media/articles/${a}/audio`)).status, 404);
  const made = await post(`/api/media/articles/${a}/listen`, {});
  assert.equal(made.status, 200);
  assert.deepEqual(Object.keys(await made.json()).sort(), ["audio_url", "cached", "duration"]);
  const ranged = await get(`/api/media/articles/${a}/audio`, { Range: "bytes=0-9" });
  assert.deepEqual([ranged.status, (await ranged.arrayBuffer()).byteLength], [206, 10]);
  await db.execute({ sql: "UPDATE media_audio_cache SET audio_path = '/etc/passwd' WHERE article_id = ?", args: [a] });
  assert.equal((await get(`/api/media/articles/${a}/audio`)).status, 404);
  await setVoiceProfiles(db, [CLOUD_DEFAULT]);
  const b = await seedArticle(db, { source_id: src, title: "Another story to read", content_full: "Some text that would be read aloud.", pub_date: new Date().toISOString() });
  const refused = await post(`/api/media/articles/${b}/listen`, {});
  assert.deepEqual([refused.status, await refused.json()], [503, { error: "No audio: no local voice is set up." }]);
  await setVoiceProfiles(db, [CLOUD_DEFAULT, localVoice(voice.url)]);
});

test("the routes file finds this instance's installed copy first (CROW_HOME), not another instance's", () => {
  const src = readFileSync(join(REPO, "bundles/media/panel/routes.js"), "utf8");
  assert.match(src, /process\.env\.CROW_HOME \|\| join\(homedir\(\), "\.crow"\)/);
  assert.doesNotMatch(src, /join\(homedir\(\), "\.crow", "bundles"/);
});
