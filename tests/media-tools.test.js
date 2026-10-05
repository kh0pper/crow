/**
 * The three media tools Phase 0 rewrites, called through a real MCP client against a real
 * database (core `schedules` table included): schedule, briefing, listen. Voice is the gateway's
 * real adapter against a local stand-in server.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshMediaDb, startFakeVoice, setVoiceProfiles, CLOUD_DEFAULT, localVoice, seedSource, seedArticle, REPO } from "./helpers/media-fixtures.js";
import { createMediaServer, MEDIA_VERSION } from "../bundles/media/server/server.js";
import { insideAudioDir } from "../bundles/media/server/speech.js";
import { runScheduleTick, STUCK_MS } from "../bundles/media/server/schedule.js";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const hush = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

async function world({ voice = true } = {}) {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const v = await startFakeVoice(); cleanups.push(() => v.close());
  await setVoiceProfiles(f.db, voice ? [CLOUD_DEFAULT, localVoice(v.url)] : [CLOUD_DEFAULT]);
  const server = createMediaServer(f.dbPath);
  const client = new Client({ name: "media-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  cleanups.push(async () => { await client.close().catch(() => {}); });
  const call = async (name, args = {}) => { const r = await hush(() => client.callTool({ name, arguments: args })); return { text: r.content.map((c) => c.text || "").join("\n"), isError: !!r.isError }; };
  const wire = await seedSource(f.db, { name: "Example Wire", url: "http://127.0.0.1:9/feed" });
  const now = Date.now();
  const a1 = await seedArticle(f.db, { source_id: wire, title: "Bridge reopens after repairs", summary: "The bridge reopened on Monday. Crews finished two weeks early.", content_full: "The bridge reopened on Monday after six months of work. Crews finished two weeks early.", pub_date: new Date(now - 3_600_000).toISOString() });
  await seedArticle(f.db, { source_id: wire, title: "Water board sets new rates", summary: "Rates rise four percent in January.", pub_date: new Date(now - 7_200_000).toISOString() });
  return { ...f, voice: v, client, call, wire, a1 };
}
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((ok) => setTimeout(ok, 50)); } };

test("the server reports the bundle's manifest version", async () => {
  const w = await world();
  const manifest = JSON.parse(readFileSync(join(REPO, "bundles/media/manifest.json"), "utf8"));
  assert.equal(MEDIA_VERSION, manifest.version);
  assert.equal(w.client.getServerVersion().version, manifest.version);
});

test("crow_media_schedule_briefing writes the real schedules table: create, report, change, attach a show, refuse bad input", async () => {
  const w = await world();
  assert.match((await w.call("crow_media_schedule_briefing")).text, /No daily briefing is scheduled\./);
  const made = await w.call("crow_media_schedule_briefing", { time: "08:00", tz: "America/Chicago" });
  assert.equal(made.isError, false, made.text);
  assert.match(made.text, /Daily briefing: 08:00 \(America\/Chicago\)\./);
  assert.match(made.text, /Next: \w+day, \w+ \d+ at 8:00 AM\. Work starts 15 minutes earlier/);
  const row = (await w.db.execute("SELECT task, cron_expression, enabled, next_run FROM schedules")).rows;
  assert.equal(row.length, 1);
  assert.deepEqual([row[0].task, row[0].cron_expression, row[0].enabled], ["media:briefing", "0 8 * * *", 1]);
  assert.match(row[0].next_run, /T1[34]:00:00\.000Z$/, "08:00 in Chicago is 13:00Z or 14:00Z");
  const show = await seedSource(w.db, { name: "The Example Hour", url: "https://show.example.invalid/p.xml", type: "podcast" });
  const withShow = await w.call("crow_media_schedule_briefing", { cron: "30 7 * * 1-5", max_articles: 6, show_source_id: show, show_title_prefix: "The Example Hour 20" });
  assert.match(withShow.text, new RegExp(`Then plays: source ${show} on days 1,2,3,4,5 \\(titles starting "The Example Hour 20"\\)`));
  assert.match(withShow.text, /Stories: up to 6\. Voice: local only\./);
  assert.equal((await w.db.execute("SELECT COUNT(*) AS n FROM schedules")).rows[0].n, 1);
  assert.match((await w.call("crow_media_schedule_briefing", { show_source_id: 0 })).text, /No show follows it\./);
  assert.match((await w.call("crow_media_schedule_briefing", { enabled: false })).text, /The daily briefing is off/);
  for (const bad of [{ cron: "@daily" }, { time: "8am" }, { tz: "Mars/Olympus" }, { show_source_id: w.wire }]) {
    const r = await w.call("crow_media_schedule_briefing", bad);
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.match(r.text, /^The schedule was not changed: /);
  }
  assert.equal((await w.db.execute("SELECT cron_expression FROM schedules")).rows[0].cron_expression, "30 7 * * 1-5");
});

test("crow_media_briefing answers with the dated script at once and the local voice finishes in the background", async () => {
  const w = await world();
  const r = await w.call("crow_media_briefing", {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Briefing, \w+day \d{1,2}:\d\d [AP]M \(briefing \d+, 2 stories\)/);
  assert.match(r.text, /Good (morning|afternoon|evening)\. It's \w+day, \w+ \d+(st|nd|rd|th)\. Here are 2 stories\./);
  assert.match(r.text, /From Example Wire\. Bridge reopens after repairs\. The bridge reopened on Monday\. Crews finished two weeks early\./);
  assert.match(r.text, /The local voice is reading it now/);
  const row = await until(async () => { const x = (await w.db.execute("SELECT status, audio_path, tts_provider, kind, error FROM media_briefings ORDER BY id DESC LIMIT 1")).rows[0]; return x.status === "ready" ? x : null; });
  assert.deepEqual([row.kind, row.tts_provider, row.error, insideAudioDir(row.audio_path)], ["manual", "kokoro", null, true]);
  const textOnly = await w.call("crow_media_briefing", { audio: false, max_articles: 1, topic: "water" });
  assert.match(textOnly.text, /Briefing on water, \w+day \(briefing \d+, 1 story\)/);
  assert.match(textOnly.text, /Text only, as asked\.$/);
  const last = (await w.db.execute("SELECT status, audio_path, error FROM media_briefings ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual({ ...last }, { status: "ready", audio_path: null, error: "disabled" });
});

test("a hand-made briefing whose maker went away is closed out by the next schedule check", async () => {
  const w = await world();
  const old = new Date(Date.now() - STUCK_MS - 120_000).toISOString().slice(0, 19).replace("T", " ");
  await w.db.execute({ sql: "INSERT INTO media_briefings (title, kind, status, created_at) VALUES ('Briefing', 'manual', 'generating', ?), ('Briefing', 'manual', 'generating', datetime('now'))", args: [old] });
  await hush(() => runScheduleTick(w.db, { refresh: null }));
  assert.deepEqual((await w.db.execute("SELECT status, error FROM media_briefings ORDER BY id")).rows.map((r) => [r.status, r.error]), [["failed", "stuck"], ["generating", null]]);
});

test("crow_media_listen reads an article with the local voice, caches it, and never falls back to a cloud voice", async () => {
  const w = await world();
  const first = await w.call("crow_media_listen", { article_id: w.a1 });
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, /^Audio made with the local voice\.\nDuration: 0:\d\d\nURL: \/api\/media\/articles\/\d+\/audio$/);
  assert.deepEqual(w.voice.requests.map((q) => q.input), ["Bridge reopens after repairs.", "The bridge reopened on Monday after six months of work. Crews finished two weeks early."]);
  const cache = (await w.db.execute("SELECT audio_path, provider, voice, duration_sec FROM media_audio_cache")).rows[0];
  assert.deepEqual([insideAudioDir(cache.audio_path), cache.provider, cache.voice, cache.duration_sec > 0], [true, "kokoro", "af_heart", true]);
  assert.match((await w.call("crow_media_listen", { article_id: w.a1, voice: "female" })).text, /retrieved from cache/);
  assert.equal(w.voice.requests.length, 2, "the cached file is reused");
  assert.match((await w.call("crow_media_listen", { article_id: 999999 })).text, /not found/);

  const none = await world({ voice: false });
  const refused = await none.call("crow_media_listen", { article_id: none.a1 });
  assert.deepEqual([refused.isError, refused.text], [true, "No audio: no local voice is set up."]);
  assert.equal(none.voice.requests.length, 0);
  assert.equal((await none.db.execute("SELECT COUNT(*) AS n FROM media_audio_cache")).rows[0].n, 0);
});

test("the cloud voice path is gone from the bundle: no Edge import, no dependency, no setting read", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = walk(join(REPO, "bundles/media")).filter((p) => /\.(js|json|md)$/.test(p));
  assert.ok(files.length > 15);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /node-edge-tts|EdgeTTS|isEdgeTtsAvailable|edge-tts|BrianNeural/, file.slice(REPO.length + 1));
    assert.doesNotMatch(src, /key = 'tts_voice'/, `${file.slice(REPO.length + 1)}: the legacy voice setting is not read`);
  }
});
