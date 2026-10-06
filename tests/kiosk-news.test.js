/**
 * The news source (bundles/kiosk/server/sources/news.js): temp directories and an injected row
 * reader. No database is opened.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNewsSource, createMediaReader, asksForNews, NEWS_MAX_AGE_DAYS } from "../bundles/kiosk/server/sources/news.js";

const NOW = Date.UTC(2031, 2, 15, 12, 0, 0);
const DAY = 86_400_000;
const stamp = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 19).replace("T", " ");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A data directory with <dir>/media/audio/, a stand-in database file beside it, and a secret outside the audio directory. */
function dataDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiosk-news-")));
  dirs.push(dir);
  mkdirSync(join(dir, "media", "audio"), { recursive: true });
  writeFileSync(join(dir, "crow.db"), "not audio");
  writeFileSync(join(dir, "secret.mp3"), "outside the audio directory");
  return dir;
}
const audio = (dir, name) => { const p = join(dir, "media", "audio", name); writeFileSync(p, "ID3 fake audio"); return p; };
/** A reader over plain rows, newest first like the real query. */
function reader({ briefings = [], articles = [] } = {}) {
  const calls = [];
  return {
    calls,
    exists: async () => true,
    briefings: async (limit) => { calls.push(["briefings", limit]); return briefings.filter((b) => b.audio_path != null).sort((a, b) => b.id - a.id).slice(0, limit); },
    briefing: async (id) => { calls.push(["briefing", id]); return briefings.find((b) => b.id === id && b.audio_path != null) || null; },
    articles: async (text, limit) => { calls.push(["articles", text, limit]); return articles.filter((a) => a.title.toLowerCase().includes(text)).slice(0, limit); },
    article: async (id) => { calls.push(["article", id]); return articles.find((a) => a.id === id) || null; },
  };
}
const make = (dir, rows, extra = {}) => createNewsSource({ reader: reader(rows), dataDir: dir, now: () => NOW, ...extra });

test("a news request is one whose words, fillers aside, are ALL news words — a title with 'news' in it is not", () => {
  for (const yes of ["the news", "news", "the news briefing", "today's headlines", "my briefing", "the latest news", "las noticias", "las noticias de hoy", "el resumen de noticias", "Noticias", "titulares", "el boletín"]) assert.equal(asksForNews(yes), true, yes);
  for (const no of ["good news", "news of the world", "the evening news hour", "bad news travels fast", "jazz", "", "the", "de", null, "noticias del barrio", "briefing room sessions"]) assert.equal(asksForNews(no), false, String(no));
});

test("the newest briefing with audio plays when it is recent; a candidate carries no path, the playable carries the checked file", async () => {
  const dir = dataDir();
  const file = audio(dir, "b2.mp3");
  const src = make(dir, { briefings: [{ id: 1, title: "Old one", audio_path: null, created_at: stamp(0) }, { id: 2, title: "Tuesday briefing", audio_path: file, created_at: stamp(2) }] });
  assert.equal(src.kind, "news");
  assert.equal(src.contract, 1);
  assert.equal(src.available(), true);
  for (const what of ["the news briefing", "noticias", "today's headlines"]) {
    const found = await src.search(what);
    assert.deepEqual(found, [{ id: "news:briefing:2", kind: "briefing", title: "Tuesday briefing", subtitle: "", confident: true }], what);
    assert.ok(!JSON.stringify(found).includes(dir), "no path in a candidate");
  }
  const [c] = await src.search("the news");
  assert.deepEqual(await src.queue(c), [{ kind: "briefing", id: "news:briefing:2", title: "Tuesday briefing", subtitle: "", form: "audio", codec: "mp3", source: "news", upstream: { file, root: join(dir, "media", "audio") } }]);
  assert.deepEqual(await src.resolve(c), (await src.queue(c))[0]);
  assert.deepEqual(await src.search("jazz"), [], "not a news request: the next source is asked");
  assert.deepEqual(await src.search("good news"), [], "an album called Good News is not the briefing");
  assert.deepEqual(await src.search("good news", { explicit: true }), [], "…and with the news source named it is a title search that finds nothing");
  assert.equal((await src.search("", { explicit: true }))[0].id, "news:briefing:2", "the news source named with nothing else: the briefing");
  assert.deepEqual(await src.search(""), []);
  assert.equal(src.choose([c], "the first one").id, "news:briefing:2");
});

test("a briefing older than seven days is refused with its real age; exactly seven days plays", async () => {
  const dir = dataDir();
  const file = audio(dir, "b.mp3");
  const at = (days) => make(dir, { briefings: [{ id: 5, title: "Briefing", audio_path: file, created_at: stamp(days) }] }).search("the news");
  assert.equal(NEWS_MAX_AGE_DAYS, 7);
  assert.deepEqual(await at(183), [{ id: "news:briefing:5", kind: "briefing", title: "Briefing", subtitle: "", confident: true, refuse: { say: "say_news_stale", vars: { days: 183 } } }]);
  assert.equal((await at(7))[0].refuse, undefined);
  assert.deepEqual((await at(8))[0].refuse, { say: "say_news_stale", vars: { days: 8 } });
  assert.equal((await make(dir, { briefings: [{ id: 5, title: "Briefing", audio_path: file, created_at: stamp(20) }] }, { maxAgeDays: 30 }).search("the news"))[0].refuse, undefined);
  // A refused candidate is never turned into a stream.
  const src = make(dir, { briefings: [{ id: 5, title: "Briefing", audio_path: file, created_at: stamp(183) }] });
  const [stale] = await src.search("the news");
  assert.deepEqual(await src.queue(stale), []);
  await assert.rejects(src.resolve(stale));
  // A date that cannot be read: the file's own date decides.
  utimesSync(file, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
  assert.deepEqual((await make(dir, { briefings: [{ id: 5, title: "Briefing", audio_path: file, created_at: "sometime" }] }).search("the news"))[0].refuse, { say: "say_news_stale", vars: { days: 40 } });
});

test("a row whose FILE is gone has no audio: the answer is the 'none' line, never a stream of nothing", async () => {
  const dir = dataDir();
  const none = [{ id: "news:briefing:none", kind: "briefing", title: "News briefing", subtitle: "", confident: true, refuse: { say: "say_news_none" } }];
  // The only briefing with audio points at a file that no longer exists.
  assert.deepEqual(await make(dir, { briefings: [{ id: 2, title: "Spring briefing", audio_path: join(dir, "media", "audio", "gone.mp3"), created_at: stamp(180) }] }).search("the news"), none);
  assert.deepEqual(await make(dir, { briefings: [] }).search("the news"), none);
  assert.deepEqual(await make(dir, { briefings: [{ id: 1, title: "No audio", audio_path: null, created_at: stamp(0) }] }).search("the news"), none);
  assert.equal((await make(dir, { briefings: [] }).search("noticias", { lang: "es" }))[0].title, "Resumen de noticias");
  // The newest row's file is gone, an older one is there: the older one is the newest briefing with audio.
  const older = audio(dir, "older.mp3");
  const src = make(dir, { briefings: [{ id: 3, title: "Newest", audio_path: join(dir, "media", "audio", "gone.mp3"), created_at: stamp(0) }, { id: 2, title: "Older", audio_path: older, created_at: stamp(1) }] });
  const [c] = await src.search("the news");
  assert.equal(c.id, "news:briefing:2");
  // The file disappears between the answer and the stream.
  rmSync(older);
  assert.deepEqual(await src.queue(c), []);
  await assert.rejects(src.resolve(c), /audio file gone/);
});

test("only an .mp3 whose REAL path is inside <dataDir>/media/audio/ is ever served", async () => {
  const dir = dataDir();
  const good = audio(dir, "good.mp3");
  const root = join(dir, "media", "audio");
  mkdirSync(join(root, "folder.mp3"));
  mkdirSync(join(dir, "media", "other"));
  writeFileSync(join(dir, "media", "other", "x.mp3"), "outside");
  writeFileSync(join(root, "notes.txt"), "text");
  symlinkSync(join(dir, "secret.mp3"), join(root, "link-out.mp3"));        // a link out of the directory
  symlinkSync(join(dir, "crow.db"), join(root, "link-db.mp3"));            // …to the database, wearing an audio name
  symlinkSync(good, join(root, "link-in.mp3"));                            // a link that stays inside
  writeFileSync(join(root, "LOUD.MP3"), "ID3");
  const answer = (audio_path) => make(dir, { briefings: [{ id: 9, title: "Briefing", audio_path, created_at: stamp(0) }] });
  const refused = [join(dir, "crow.db"), join(dir, "secret.mp3"), join(dir, "media", "other", "x.mp3"), join(root, "notes.txt"), join(root, "folder.mp3"), join(root, "link-out.mp3"), join(root, "link-db.mp3"),
    join(root, "..", "..", "crow.db"), join(root, "..", "..", "secret.mp3"), "/etc/passwd", "/etc/hostname.mp3", "good.mp3", "", 42, null, `${good}\u0000.txt`, join(root, "a".repeat(2000) + ".mp3")];
  for (const p of refused) {
    const src = answer(p);
    assert.equal((await src.search("the news"))[0].refuse?.say, "say_news_none", String(p).slice(0, 80));
    assert.deepEqual(await src.queue({ id: "news:briefing:9" }), [], `queue ${String(p).slice(0, 80)}`);
  }
  for (const [p, real] of [[good, good], [join(root, "link-in.mp3"), good], [join(root, "LOUD.MP3"), join(root, "LOUD.MP3")], [join(root, "..", "audio", "good.mp3"), good]]) {
    const src = answer(p);
    assert.equal((await src.search("the news"))[0].refuse, undefined, p);
    assert.equal((await src.queue({ id: "news:briefing:9" }))[0].upstream.file, real, "the real path is what the relay gets");
  }
  // The audio directory itself may not exist yet.
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "kiosk-news-")));
  dirs.push(empty);
  assert.equal((await make(empty, { briefings: [{ id: 9, title: "B", audio_path: good, created_at: stamp(0) }] }).search("the news"))[0].refuse.say, "say_news_none");
});

test("not configured, or an instance without the media tables: no news here, and nothing throws", async () => {
  const dir = dataDir();
  for (const src of [createNewsSource(), createNewsSource({ reader: reader() }), createNewsSource({ dataDir: dir }), createNewsSource({ reader: reader(), dataDir: "" })]) {
    assert.equal(src.available(), false);
    assert.deepEqual(await src.search("the news"), []);
    assert.deepEqual(await src.queue({ id: "news:briefing:1" }), []);
    await assert.rejects(src.resolve({ id: "news:briefing:1" }));
  }
  const broken = { exists: async () => false, briefings: async () => { throw new Error("no such table: media_briefings"); }, briefing: async () => { throw new Error("no such table"); }, articles: async () => { throw new Error("no such table"); }, article: async () => { throw new Error("no such table"); } };
  const src = createNewsSource({ reader: broken, dataDir: dir, now: () => NOW });
  assert.equal(src.available(), true, "configured; whether the tables exist is the runtime's question (reader.exists)");
  assert.deepEqual(await src.search("the news"), []);
  assert.deepEqual(await src.search("anything", { explicit: true }), []);
  assert.deepEqual(await src.queue({ id: "news:briefing:1" }), []);
  for (const bad of [null, {}, { id: "briefing:1" }, { id: "news:briefing:../1" }, { id: "news:briefing:none" }, { id: "music:album:1" }]) assert.deepEqual(await make(dir, {}).queue(bad), [], JSON.stringify(bad));
});

test("an article read aloud is found by its title only when the request names the news source", async () => {
  const dir = dataDir();
  const a = audio(dir, "a1.mp3"), b = audio(dir, "a2.mp3");
  const rows = { articles: [{ id: 11, title: "Harbor dredging begins", audio_path: a }, { id: 12, title: "Harbor festival dates", audio_path: b }, { id: 13, title: "Harbor closed", audio_path: join(dir, "crow.db") }] };
  const src = make(dir, rows);
  assert.deepEqual(await src.search("harbor dredging"), [], "not without the source named");
  assert.deepEqual(await src.search("harbor dredging", { explicit: true }), [{ id: "news:article:11", kind: "article", title: "Harbor dredging begins", subtitle: "", confident: true }]);
  const many = await src.search("Harbor", { explicit: true });
  assert.deepEqual(many.map((c) => [c.id, c.confident]), [["news:article:11", false], ["news:article:12", false]], "the row that points outside the audio directory is not offered");
  assert.equal(src.choose(many, "harbor festival dates").id, "news:article:12");
  assert.deepEqual((await src.queue(many[1]))[0], { kind: "article", id: "news:article:12", title: "Harbor festival dates", subtitle: "", form: "audio", codec: "mp3", source: "news", upstream: { file: b, root: join(dir, "media", "audio") } });
});

test("the row reader: SELECT only, every value bound, the connection closed, LIKE wildcards in the words escaped", async () => {
  const seen = [];
  let open = 0;
  const openDb = () => { open += 1; return { execute: async (q) => { seen.push(q); if (q.sql.includes("FROM nowhere")) throw new Error("x"); return { rows: [{ id: 1, title: "T", audio_path: "/x.mp3", created_at: "2031-03-01 00:00:00" }] }; }, close: () => { open -= 1; } }; };
  const r = createMediaReader(openDb);
  assert.equal(await r.exists(), true);
  assert.equal((await r.briefings(5)).length, 1);
  assert.equal((await r.briefing(7)).id, 1);
  await r.articles("50%_off\\", 4);
  await r.article(3);
  assert.equal(open, 0, "every connection was closed");
  for (const q of seen) { assert.match(q.sql, /^SELECT /); assert.doesNotMatch(q.sql, /INSERT|UPDATE|DELETE|DROP|;/i); }
  assert.deepEqual(seen.map((q) => q.args), [[], [5], [7], ["%50\\%\\_off\\\\%", 4], [3]]);
  const failing = createMediaReader(() => ({ execute: async () => { throw new Error("no such table: media_briefings"); }, close: () => { open -= 1; } }));
  open = 1;
  assert.equal(await failing.exists(), false);
  assert.equal(open, 0, "closed after a failure too");
});

test("a news file through the REAL relay: served as audio/mpeg with one byte range; a file swapped for a link out of the audio directory after the ticket was made is refused", async () => {
  const http = await import("node:http");
  const { createRelay } = await import("../bundles/kiosk/server/relay.js");
  const { unlinkSync } = await import("node:fs");
  const dir = dataDir();
  const file = audio(dir, "b7.mp3");
  const src = make(dir, { briefings: [{ id: 7, title: "B", audio_path: file, created_at: stamp(0) }] });
  const [p] = await src.queue((await src.search("the news"))[0]);
  const relay = createRelay();
  const srv = http.createServer((req, res) => { relay.toResponse(p.upstream, req, res); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const all = await fetch(url);
    assert.deepEqual([all.status, all.headers.get("content-type"), await all.text()], [200, "audio/mpeg", "ID3 fake audio"]);
    const part = await fetch(url, { headers: { Range: "bytes=4-7" } });
    assert.deepEqual([part.status, part.headers.get("content-range"), await part.text()], [206, "bytes 4-7/14", "fake"]);
    assert.equal((await fetch(url, { headers: { Range: "bytes=99-" } })).status, 416);
    assert.equal((await fetch(url, { method: "HEAD" })).status, 405);
    unlinkSync(file);
    symlinkSync(join(dir, "secret.mp3"), file);
    const swapped = await fetch(url);
    assert.equal(swapped.status, 404);
    assert.ok(!(await swapped.text()).includes("outside"));
  } finally { srv.close(); }
});
