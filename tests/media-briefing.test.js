/**
 * The briefing object (bundles/media/server/briefing.js): table changes, the claim, the builder
 * (site feeds only), the row contract other parts of Crow read, the latest-briefing answer and the
 * start-up repair. The voice is the gateway's real Kokoro adapter against a local stand-in server.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { freshMediaDb, startFakeVoice, setVoiceProfiles, CLOUD_DEFAULT, localVoice, seedSource, seedArticle, fakeMp3, REPO, FRAME_SECONDS } from "./helpers/media-fixtures.js";
import { createDbClient } from "../servers/db.js";
import { initMediaTables } from "../bundles/media/server/init-tables.js";
import { resolveDataDir } from "../bundles/media/server/db.js";
import { scanMp3, resolveAudioDir } from "../bundles/media/server/speech.js";
import {
  BRIEFING_SOURCE_TYPES, createBriefing, briefingSourceIds, writeBriefing, voiceBriefing, makeBriefing, failBriefing,
  getBriefing, getLatestBriefing, listBriefings, repairBriefingAudio,
} from "../bundles/media/server/briefing.js";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const quiet = { speech: { log: () => {} } };
const NOW = Date.parse("2026-10-06T12:45:00Z");   // 07:45 Tuesday in America/Chicago
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];

async function world() {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const voice = await startFakeVoice(); cleanups.push(() => voice.close());
  await setVoiceProfiles(f.db, [CLOUD_DEFAULT, localVoice(voice.url)]);
  return { ...f, voice };
}

test("table changes are additive and bundle-owned: old rows read as manual and ready; no core schema is involved", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const cols = (await f.db.execute("PRAGMA table_info(media_briefings)")).rows.map((r) => r.name);
  for (const c of ["kind", "status", "scheduled_for", "attempts", "items_json", "chapters", "attachments", "lang", "tts_provider", "model", "error", "file_size", "ready_at", "announced_at"]) assert.ok(cols.includes(c), c);
  assert.ok((await f.db.execute("PRAGMA table_info(media_audio_cache)")).rows.some((r) => r.name === "provider"));
  // A database made by media 1.0.0: the old table shape with a row in it.
  const old = createDbClient(join(f.dir, "old.db")); cleanups.push(() => { try { old.close(); } catch {} });
  await old.executeMultiple(`CREATE TABLE media_briefings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, script TEXT, audio_path TEXT, article_ids TEXT, duration_sec REAL, voice TEXT DEFAULT 'en-US-AriaNeural', created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO media_briefings (title, script) VALUES ('News Briefing', 'old text');`);
  const hush = console.error; console.error = () => {};
  try { await initMediaTables(old); await initMediaTables(old); } finally { console.error = hush; }
  const row = await one(old, "SELECT title, script, kind, status, scheduled_for FROM media_briefings WHERE id = 1");
  assert.deepEqual({ ...row }, { title: "News Briefing", script: "old text", kind: "manual", status: "ready", scheduled_for: null });
  const idx = await one(old, "SELECT sql FROM sqlite_master WHERE name = 'idx_media_briefings_scheduled'");
  assert.match(idx.sql, /UNIQUE INDEX.*scheduled_for.*WHERE scheduled_for IS NOT NULL/s);
  const core = readFileSync(join(REPO, "scripts", "init-db.js"), "utf8");
  assert.doesNotMatch(core, /CREATE TABLE IF NOT EXISTS media_/, "media tables are the bundle's, not the core schema's");
});

test("the claim: one daily briefing per occurrence, however many callers; manual briefings are not limited", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const occ = "2026-10-06T13:00:00.000Z";
  const first = await createBriefing(f.db, { kind: "daily", scheduledFor: occ });
  assert.ok(first > 0);
  assert.equal(await createBriefing(f.db, { kind: "daily", scheduledFor: occ }), null);
  assert.ok(await createBriefing(f.db, { kind: "daily", scheduledFor: "2026-10-07T13:00:00.000Z" }) > first);
  assert.ok(await createBriefing(f.db, { kind: "manual" }) > 0);
  assert.ok(await createBriefing(f.db, { kind: "manual" }) > 0);
  const row = await one(f.db, "SELECT kind, status, attempts, audio_path, voice FROM media_briefings WHERE id = ?", [first]);
  assert.deepEqual({ ...row }, { kind: "daily", status: "generating", attempts: 1, audio_path: null, voice: null });
});

test("the claim holds across processes: four runners start together, one gets the occurrence", { timeout: 60_000 }, async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const startAt = Date.now() + 1500;
  const script = `
    const { createDbClient } = await import("./bundles/media/server/db.js");
    const { createBriefing } = await import("./bundles/media/server/briefing.js");
    const db = createDbClient(process.argv[1]);
    while (Date.now() < Number(process.argv[2])) {}
    const id = await createBriefing(db, { kind: "daily", scheduledFor: "2026-10-06T13:00:00.000Z" });
    db.close();
    process.stdout.write(id === null ? "lost" : "won");`;
  const runs = await Promise.all([1, 2, 3, 4].map(() =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, f.dbPath, String(startAt)], { cwd: REPO, timeout: 30_000 })));
  assert.deepEqual(runs.map((r) => r.stdout).sort(), ["lost", "lost", "lost", "won"]);
  assert.equal((await one(f.db, "SELECT COUNT(*) AS n FROM media_briefings")).n, 1);
});

async function seedNews(db) {
  const wire = await seedSource(db, { name: "Example Wire", url: "https://wire.example.invalid/feed", category: "world" });
  const paper = await seedSource(db, { name: "Example Paper", url: "https://paper.example.invalid/rss" });
  const off = await seedSource(db, { name: "Disabled Feed", url: "https://off.example.invalid/rss", enabled: 0 });
  const search = await seedSource(db, { name: "Search: local news", url: "https://search.example.invalid/rss?q=local", type: "google_news", category: "world" });
  const video = await seedSource(db, { name: "Example Channel", url: "https://video.example.invalid/feed", type: "youtube" });
  const show = await seedSource(db, { name: "The Example Hour", url: "https://show.example.invalid/podcast.xml", type: "podcast" });
  const ids = {};
  ids.w1 = await seedArticle(db, { source_id: wire, title: "Bridge reopens after repairs", summary: "The bridge reopened on Monday. Crews finished two weeks early.", pub_date: ago(2), url: "https://wire.example.invalid/1" });
  ids.w2 = await seedArticle(db, { source_id: wire, title: "Water board sets new rates", summary: "Rates rise four percent in January.", pub_date: ago(3) });
  ids.w3 = await seedArticle(db, { source_id: wire, title: "Third wire story", summary: "A third item from the same source.", pub_date: ago(4) });
  ids.p1 = await seedArticle(db, { source_id: paper, title: "School year calendar approved", summary: "&lt;p&gt;Classes begin August 12.&lt;/p&gt; The post School year calendar approved appeared first on Example Paper.", pub_date: ago(5) });
  ids.pOld = await seedArticle(db, { source_id: paper, title: "Last week's story", summary: "Too old for today.", pub_date: ago(60) });
  ids.pAudio = await seedArticle(db, { source_id: paper, title: "An audio item in a site feed", summary: "Has an enclosure.", pub_date: ago(1), audio_url: "https://paper.example.invalid/a.mp3" });
  ids.off = await seedArticle(db, { source_id: off, title: "From a disabled source", summary: "Should not appear.", pub_date: ago(1) });
  ids.search = await seedArticle(db, { source_id: search, title: "Newest of all: a search-feed headline about the world", summary: '<a href="https://search.example.invalid/rss/articles/CBMi">Newest of all</a>&nbsp;&nbsp;<font color="#6f6f6f">Outlet</font>', pub_date: ago(0.1) });
  ids.video = await seedArticle(db, { source_id: video, title: "A video upload", summary: null, pub_date: ago(0.2) });
  ids.show = await seedArticle(db, { source_id: show, title: "The Example Hour 2026-10-06", summary: "Episode notes.", pub_date: ago(0.3), audio_url: "https://show.example.invalid/e.mp3" });
  return { ids, sources: { wire, paper, off, search, video, show } };
}

test("site feeds only: a search feed can never be in a briefing, nor a video channel, a show, a disabled source or an audio item", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const { ids, sources } = await seedNews(f.db);
  assert.deepEqual([...BRIEFING_SOURCE_TYPES], ["rss"]);
  assert.ok(Object.isFrozen(BRIEFING_SOURCE_TYPES));
  assert.deepEqual(await briefingSourceIds(f.db), [sources.wire, sources.paper]);
  const refreshed = [];
  const id = await createBriefing(f.db, { kind: "manual" });
  const r = await writeBriefing(f.db, id, { kind: "manual", tz: "America/Chicago", lang: "en" }, { now: () => NOW, refresh: async (db, sourceIds, capMs) => { refreshed.push([sourceIds, capMs]); } });
  assert.deepEqual(refreshed, [[[sources.wire, sources.paper], 90_000]], "only the briefing's own sources are refreshed first");
  const row = await one(f.db, "SELECT * FROM media_briefings WHERE id = ?", [id]);
  assert.deepEqual(JSON.parse(row.article_ids), [ids.w1, ids.p1, ids.w2], "one per source, then a second round; the third wire story is over the cap");
  assert.equal(r.stories, 3);
  for (const banned of ["search-feed", "Newest of all", "Outlet", "video upload", "Example Hour", "disabled source", "audio item", "Last week", "<", "&lt;", "http", "appeared first"]) {
    assert.ok(!row.script.includes(banned), `script must not contain "${banned}"`);
  }
  // Even a topic that matches the search feed's category and headline cannot pull it in.
  const id2 = await createBriefing(f.db, { kind: "manual" });
  await writeBriefing(f.db, id2, { kind: "manual", topic: "world", tz: "America/Chicago" }, { now: () => NOW });
  const row2 = await one(f.db, "SELECT article_ids, title FROM media_briefings WHERE id = ?", [id2]);
  assert.deepEqual(JSON.parse(row2.article_ids), [ids.w1, ids.w2], "the topic narrows site-feed stories; it never widens the source rule");
  assert.equal(row2.title, "Briefing on world, Tuesday");
  // Turning a search feed's type into anything but a site feed keeps it out; only source_type 'rss' is quoted.
  await f.db.execute({ sql: "UPDATE media_sources SET source_type = 'google_news' WHERE id = ?", args: [sources.paper] });
  assert.deepEqual(await briefingSourceIds(f.db), [sources.wire]);
});

test("the text stage: dated script, snapshot of stories, chapters, and a window that starts at the previous daily briefing", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const { ids } = await seedNews(f.db);
  const occ = Date.parse("2026-10-06T13:00:00Z");
  const id = await createBriefing(f.db, { kind: "daily", scheduledFor: new Date(occ).toISOString() });
  await writeBriefing(f.db, id, { kind: "daily", occurrenceMs: occ, tz: "America/Chicago", lang: "en", attachments: [{ key: "show:9", title: "The Example Hour", status: "pending" }] }, { now: () => NOW });
  const row = await one(f.db, "SELECT * FROM media_briefings WHERE id = ?", [id]);
  assert.equal(row.title, "Morning briefing, Tuesday");
  assert.equal(row.status, "generating", "the text stage does not publish");
  const paragraphs = row.script.split("\n\n");
  assert.equal(paragraphs[0], "Good morning. It's Tuesday, October 6th. Here are 3 stories.");
  assert.equal(paragraphs[1], "From Example Wire. Bridge reopens after repairs. The bridge reopened on Monday. Crews finished two weeks early.");
  assert.equal(paragraphs[2], "From Example Paper. School year calendar approved. Classes begin August 12.");
  assert.equal(paragraphs.at(-1), "That's your briefing. Today's The Example Hour follows as soon as it is published.");
  assert.deepEqual(JSON.parse(row.items_json)[0], { title: "Bridge reopens after repairs", link: "https://wire.example.invalid/1", source: "Example Wire", article_id: ids.w1 });
  assert.deepEqual(JSON.parse(row.chapters).map((c) => c.title), ["Introduction", "Bridge reopens after repairs", "School year calendar approved", "Water board sets new rates", "Closing"]);
  assert.equal(JSON.parse(row.attachments)[0].key, "show:9");
  // A briefing never depends on article rows staying alive.
  await f.db.execute("DELETE FROM media_articles");
  assert.equal((await getBriefing(f.db, id)).items.length, 3);
  // Tomorrow's daily briefing starts where a finished one left off.
  await f.db.execute({ sql: "UPDATE media_briefings SET status = 'ready' WHERE id = ?", args: [id] });
  const s = (await f.db.execute("SELECT id FROM media_sources WHERE name = 'Example Wire'")).rows[0].id;
  await seedArticle(f.db, { source_id: s, title: "Before the last briefing", summary: "Already covered yesterday.", pub_date: new Date(occ - 3_600_000).toISOString() });
  const fresh = await seedArticle(f.db, { source_id: s, title: "After the last briefing", summary: "New since yesterday morning.", pub_date: new Date(occ + 3_600_000).toISOString() });
  const next = await createBriefing(f.db, { kind: "daily", scheduledFor: "2026-10-07T13:00:00.000Z" });
  await writeBriefing(f.db, next, { kind: "daily", occurrenceMs: occ + 86_400_000, tz: "America/Chicago" }, { now: () => NOW + 86_400_000 });
  assert.deepEqual(JSON.parse((await one(f.db, "SELECT article_ids FROM media_briefings WHERE id = ?", [next])).article_ids), [fresh]);
});

test("the voice stage keeps the row contract: path only after the file exists, real duration, chapters with start times", async () => {
  const w = await world();
  await seedNews(w.db);
  const id = await createBriefing(w.db, { kind: "manual" });
  const made = await makeBriefing(w.db, id, { kind: "manual", tz: "America/Chicago" }, { now: () => NOW, ...quiet });
  assert.deepEqual([made.audio, made.error, made.stories], [true, null, 3]);
  const row = await one(w.db, "SELECT * FROM media_briefings WHERE id = ?", [id]);
  const audioDir = resolve(resolveDataDir(), "media", "audio") + sep;
  assert.equal(row.status, "ready");
  assert.ok(row.audio_path.startsWith(audioDir) && row.audio_path.endsWith(`briefing-${id}.mp3`), row.audio_path);
  const scanned = scanMp3(readFileSync(row.audio_path));
  assert.ok(Math.abs(row.duration_sec - scanned.duration_sec) < 0.11, "duration is counted from the frames in the file");
  assert.equal(row.file_size, readFileSync(row.audio_path).length);
  assert.equal(row.tts_provider, "kokoro");
  assert.equal(row.voice, "af_heart");
  assert.equal(row.error, null);
  assert.ok(row.ready_at.endsWith("Z"));
  assert.match(row.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, "created_at stays a SQLite UTC timestamp");
  const starts = JSON.parse(row.chapters).map((c) => c.start_sec);
  assert.equal(starts.length, 5);
  assert.equal(starts[0], 0);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], `chapter ${i} starts after chapter ${i - 1}`);
  assert.ok(starts.at(-1) < row.duration_sec);
  assert.equal(w.voice.requests.length, 5, "one request per paragraph here");
  assert.equal(w.voice.requests[0].input, "Good morning. It's Tuesday, October 6th. Here are 3 stories.");

  // While the voice is still working, the row names no file.
  w.voice.state.mode = "stall";
  const id2 = await createBriefing(w.db, { kind: "manual" });
  const pending = makeBriefing(w.db, id2, { kind: "manual", tz: "America/Chicago" }, { now: () => NOW, speech: { log: () => {}, requestTimeoutMs: 600 } });
  await new Promise((ok) => setTimeout(ok, 250));
  const mid = await one(w.db, "SELECT status, audio_path, script FROM media_briefings WHERE id = ?", [id2]);
  assert.deepEqual([mid.status, mid.audio_path, mid.script.startsWith("Good morning.")], ["generating", null, true]);
  const late = await pending;
  assert.deepEqual([late.audio, late.error], [false, "voice_timeout"]);
  const after2 = await one(w.db, "SELECT status, audio_path, duration_sec, error FROM media_briefings WHERE id = ?", [id2]);
  assert.deepEqual({ ...after2 }, { status: "ready", audio_path: null, duration_sec: null, error: "voice_timeout" }, "ready to read, no audio, with the reason");
  assert.equal(existsSync(join(resolveAudioDir(), `briefing-${id2}.mp3`)), false);
});

test("no local voice: the briefing is still published as text, no cloud voice is called, and failure states are terminal once", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const voice = await startFakeVoice(); cleanups.push(() => voice.close());
  await setVoiceProfiles(f.db, [CLOUD_DEFAULT, { ...CLOUD_DEFAULT, id: "c2", provider: "openai", apiKey: "k", baseUrl: voice.url, isDefault: false }]);
  await seedNews(f.db);
  const id = await createBriefing(f.db, { kind: "manual" });
  const made = await makeBriefing(f.db, id, { kind: "manual", tz: "UTC" }, { now: () => NOW, ...quiet });
  assert.deepEqual([made.audio, made.error], [false, "no_local_voice"]);
  assert.equal(voice.requests.length, 0);
  const b = await getBriefing(f.db, id);
  assert.deepEqual([b.status, b.audio_url, b.error, b.items.length], ["ready", null, "no_local_voice", 3]);
  // audio: false is "text only" by request.
  const id2 = await createBriefing(f.db, { kind: "manual" });
  assert.equal((await makeBriefing(f.db, id2, { kind: "manual", tz: "UTC" }, { now: () => NOW, audio: false })).error, "disabled");
  // A thrown error is recorded and rethrown; the row stays 'generating' for the caller to retry or fail.
  const id3 = await createBriefing(f.db, { kind: "manual" });
  await assert.rejects(makeBriefing(f.db, id3, { kind: "manual", tz: "UTC" }, { now: () => NOW, refresh: async () => { throw new Error("feeds exploded"); } }), /feeds exploded/);
  assert.deepEqual({ ...(await one(f.db, "SELECT status, error FROM media_briefings WHERE id = ?", [id3])) }, { status: "generating", error: "feeds exploded" });
  assert.equal(await failBriefing(f.db, id3, "feeds exploded"), true);
  assert.equal(await failBriefing(f.db, id3, "again"), false, "only one caller moves a row to failed");
  assert.equal((await voiceBriefing(f.db, id3, quiet)).error, "not_generating");
});

/** The kiosk news adapter's reader, as its plan gives it (table read; no import of bundle code). */
async function kioskReads(db, { dataDir, now, maxAgeDays = 7 }) {
  const root = resolve(String(dataDir)) + sep;
  const inside = (p) => typeof p === "string" && resolve(p).startsWith(root) && existsSync(p);
  const rows = (await db.execute({ sql: "SELECT id, title, audio_path, created_at FROM media_briefings WHERE audio_path IS NOT NULL ORDER BY id DESC LIMIT 5", args: [] })).rows;
  const b = rows.find((r) => inside(r.audio_path));
  if (!b) return { play: null, say: "none" };
  const t = Date.parse(`${String(b.created_at || "").replace(" ", "T")}Z`);
  const days = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
  return days !== null && days > maxAgeDays ? { play: null, say: "stale", days } : { play: Number(b.id), title: b.title, file: b.audio_path };
}

test("latest briefing: the function, and the kiosk's table read, give the same answer at every age", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const dir = resolveAudioDir();
  const mk = async (name, { ageHours, kind = "manual", audio = true, status = "ready" }) => {
    const path = audio ? join(dir, `latest-${name}.mp3`) : null;
    if (audio === true) writeFileSync(path, fakeMp3(50));
    const r = await f.db.execute({
      sql: "INSERT INTO media_briefings (title, script, audio_path, duration_sec, kind, status, created_at) VALUES (?, 'text', ?, ?, ?, ?, ?)",
      args: [name, path, audio ? 50 * FRAME_SECONDS : null, kind, status, sqlTime(NOW - ageHours * 3_600_000)],
    });
    return Number(r.lastInsertRowid);
  };
  const oldDaily = await mk("old daily", { ageHours: 30, kind: "daily" });
  const manual = await mk("manual", { ageHours: 5 });
  await mk("text only", { ageHours: 2, audio: false });
  await mk("missing file", { ageHours: 1, audio: "missing" });           // a path with no file behind it
  await mk("still generating", { ageHours: 0.1, audio: false, status: "generating" });
  const opts = { now: NOW };
  const latest = await getLatestBriefing(f.db, opts);
  assert.equal(latest.id, manual, "newest by id that really has audio");
  assert.equal(latest.audio_url, `/api/media/briefings/${manual}/audio`);
  assert.equal(latest.age_hours, 5);
  assert.deepEqual(Object.keys(latest).sort(), ["age_hours", "attachments", "audio_url", "chapters", "created_at", "date", "duration_sec", "error", "id", "items", "kind", "lang", "late", "ready_at", "scheduled_for", "script", "status", "title"].sort());
  assert.equal((await getLatestBriefing(f.db, { ...opts, kind: "daily" })).id, oldDaily);
  assert.equal((await getLatestBriefing(f.db, { ...opts, withAudio: false })).title, "missing file", "without the audio rule: the newest finished text");
  assert.equal(await getLatestBriefing(f.db, { ...opts, maxAgeHours: 5 }), null, "strictly less than the limit");
  assert.equal((await getLatestBriefing(f.db, { ...opts, maxAgeHours: 5.01 })).id, manual);
  assert.equal(await getLatestBriefing(f.db, { ...opts, kind: "daily", maxAgeHours: 24 }), null, "too old is null, never an older stand-in");
  // Kiosk parity: its rule "whole days old <= 7" is maxAgeHours 192 here.
  const dataDir = resolveDataDir();
  for (const hoursLater of [0, 24 * 6, 24 * 7 + 18, 24 * 8 - 5.01, 24 * 8 - 4.99, 24 * 30]) {
    const now = NOW + hoursLater * 3_600_000;
    const kiosk = await kioskReads(f.db, { dataDir, now });
    const ours = await getLatestBriefing(f.db, { now, maxAgeHours: 192 });
    assert.equal(ours ? ours.id : null, kiosk.play, `at +${hoursLater} h`);
    if (ours) assert.ok(resolve(kiosk.file).startsWith(resolve(dir) + sep));
  }
  assert.equal((await listBriefings(f.db, { now: NOW })).length, 5);
  assert.equal(await getBriefing(f.db, 9999), null);
  assert.equal(await getBriefing(f.db, "x"), null);
});

test("start-up repair: a path with no file, an empty file or a file outside the audio directory is cleared; text and good audio are kept", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const dir = resolveAudioDir();
  const good = join(dir, "repair-good.mp3"); writeFileSync(good, fakeMp3(5));
  const empty = join(dir, "repair-empty.mp3"); writeFileSync(empty, "");
  const outside = join(dir, "..", "repair-outside.mp3"); writeFileSync(outside, fakeMp3(5));
  cleanups.push(() => rmSync(outside, { force: true }));
  const ins = async (path) => Number((await f.db.execute({ sql: "INSERT INTO media_briefings (title, script, audio_path, duration_sec) VALUES ('t', 'the text', ?, 9)", args: [path] })).lastInsertRowid);
  const ids = { good: await ins(good), empty: await ins(empty), gone: await ins(join(dir, "briefing-1775364451000.mp3")), outside: await ins(outside), passwd: await ins("/etc/passwd"), none: await ins(null) };
  const src = await seedSource(f.db, { name: "S", url: "https://s.example.invalid/f" });
  const a1 = await seedArticle(f.db, { source_id: src, title: "A1", pub_date: ago(1) });
  const a2 = await seedArticle(f.db, { source_id: src, title: "A2", pub_date: ago(1) });
  await f.db.execute({ sql: "INSERT INTO media_audio_cache (article_id, content_hash, audio_path) VALUES (?, 'h', ?), (?, 'h', ?)", args: [a1, good, a2, join(dir, "article-gone.mp3")] });
  const hush = console.error; console.error = () => {};
  let result;
  try { result = await repairBriefingAudio(f.db); assert.deepEqual(await repairBriefingAudio(f.db), { cleared: 0, dropped: 0 }, "a second run changes nothing"); } finally { console.error = hush; }
  assert.deepEqual(result, { cleared: 4, dropped: 1 });
  const rows = (await f.db.execute("SELECT id, audio_path, duration_sec, script, error FROM media_briefings ORDER BY id")).rows;
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by[ids.good].audio_path, good);
  assert.equal(by[ids.good].duration_sec, 9);
  for (const k of ["empty", "gone", "outside", "passwd"]) assert.deepEqual([by[ids[k]].audio_path, by[ids[k]].duration_sec, by[ids[k]].script, by[ids[k]].error], [null, null, "the text", "audio_missing"], k);
  assert.equal(by[ids.none].error, null);
  assert.deepEqual((await f.db.execute("SELECT article_id FROM media_audio_cache")).rows.map((r) => r.article_id), [a1]);
});
