/**
 * Feed freshness (bundles/media/server/tasks.js, feed-fetcher.js): the interval check reads
 * SQLite's UTC timestamps as UTC in any process zone, a briefing can force a refresh of its own
 * sources, and a failing source is recorded without a notification per cycle.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshMediaDb, seedSource, startFeedServer, rss, REPO } from "./helpers/media-fixtures.js";
import { sourceIsDue, sqliteUtcMs, fetchAllFeeds, refreshSources, insertFeedItems, fetchSingleSource } from "../bundles/media/server/tasks.js";
import { parseFeed, parseDuration, fetchFeedIfChanged } from "../bundles/media/server/feed-fetcher.js";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const run = promisify(execFile);
const count = async (db, sql, args = []) => Number((await db.execute({ sql, args })).rows[0].n);
const item = (n) => ({ title: `Story ${n}`, link: `https://feed.example.invalid/${n}`, guid: `g${n}`, pubDate: "Mon, 05 Oct 2026 12:00:00 GMT", description: `Text ${n}.` });

test("a last_fetched stamp is UTC whatever zone the process runs in", async () => {
  assert.equal(sqliteUtcMs("2026-10-05 03:45:41"), Date.parse("2026-10-05T03:45:41Z"));
  assert.ok(Number.isNaN(sqliteUtcMs(null)));
  const script = `
    const { sourceIsDue } = await import("./bundles/media/server/tasks.js");
    const now = Date.parse("2026-10-05T04:16:00Z");
    const s = (last, every) => ({ last_fetched: last, fetch_interval_min: every });
    process.stdout.write(JSON.stringify([
      sourceIsDue(s("2026-10-05 03:45:41", 30), now),   // 30 min 19 s ago: due
      sourceIsDue(s("2026-10-05 04:10:00", 30), now),   // 6 min ago: not due
      sourceIsDue(s("2026-10-05 03:45:41", 60), now),   // interval 60: not due
      sourceIsDue(s(null, 30), now),                    // never fetched: due
      sourceIsDue(s("garbage", 30), now),               // unreadable: due
      sourceIsDue(s("2026-10-05 03:45:41", null), now), // default interval 30: due
    ]));`;
  for (const TZ of ["America/Chicago", "Asia/Kolkata", "UTC", "Pacific/Auckland"]) {
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO, env: { ...process.env, TZ }, timeout: 30_000 });
    assert.deepEqual(JSON.parse(stdout), [true, false, false, true, true, true], `TZ=${TZ}`);
  }
});

test("the periodic task fetches a source half an hour after its last fetch, in a zone behind UTC, and not again at once", { timeout: 60_000 }, async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const feeds = await startFeedServer({ "/a.xml": () => ({ body: rss("Feed A", [item(1), item(2)]) }) }); cleanups.push(() => feeds.close());
  const id = await seedSource(f.db, { name: "Feed A", url: `${feeds.base}/a.xml` });
  await f.db.execute({ sql: "UPDATE media_sources SET last_fetched = datetime('now', '-31 minutes') WHERE id = ?", args: [id] });
  const script = `
    const { createDbClient } = await import("./bundles/media/server/db.js");
    const { fetchAllFeeds } = await import("./bundles/media/server/tasks.js");
    const db = createDbClient(process.argv[1]);
    await fetchAllFeeds(db); await fetchAllFeeds(db);
    db.close();`;
  await run(process.execPath, ["--input-type=module", "-e", script, f.dbPath], { cwd: REPO, env: { ...process.env, TZ: "America/Chicago" }, timeout: 30_000 });
  assert.equal(feeds.hits.length, 1, "due once (31 minutes), then not due (just fetched)");
  assert.equal(await count(f.db, "SELECT COUNT(*) AS n FROM media_articles WHERE source_id = ?", [id]), 2);
});

test("a forced refresh fetches exactly the sources asked for, whatever their interval, and reports what happened", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const feeds = await startFeedServer({
    "/a.xml": () => ({ body: rss("A", [item(1), item(2)]) }),
    "/b.xml": () => ({ body: rss("B", [item(3)]) }),
    "/c.xml": () => ({ body: rss("C", [item(4)]) }),
    "/bad.xml": () => ({ status: 500, body: "nope" }),
  });
  cleanups.push(() => feeds.close());
  const a = await seedSource(f.db, { name: "A", url: `${feeds.base}/a.xml` });
  const b = await seedSource(f.db, { name: "B", url: `${feeds.base}/b.xml` });
  const c = await seedSource(f.db, { name: "C", url: `${feeds.base}/c.xml` });
  const bad = await seedSource(f.db, { name: "Bad", url: `${feeds.base}/bad.xml` });
  const off = await seedSource(f.db, { name: "Off", url: `${feeds.base}/a.xml?off`, enabled: 0 });
  await f.db.execute("UPDATE media_sources SET last_fetched = datetime('now')");   // none is due by interval
  await fetchAllFeeds(f.db);
  assert.equal(feeds.hits.length, 0, "nothing is due");
  assert.deepEqual(await refreshSources(f.db, [a, b, bad, off, 99999, "x"]), { fetched: 2, failed: 1, skipped: 0 });
  assert.deepEqual(feeds.hits.map((h) => h.url).sort(), ["/a.xml", "/b.xml", "/bad.xml"], "source C was not asked for; the disabled one is never fetched");
  assert.equal(await count(f.db, "SELECT COUNT(*) AS n FROM media_articles"), 3);
  assert.equal(await count(f.db, "SELECT COUNT(*) AS n FROM media_articles WHERE source_id = ?", [c]), 0);
  assert.match((await f.db.execute({ sql: "SELECT last_error FROM media_sources WHERE id = ?", args: [bad] })).rows[0].last_error, /HTTP 500/);
  assert.deepEqual(await refreshSources(f.db, [a, b, c, bad], 0), { fetched: 0, failed: 0, skipped: 4 }, "past the cap no batch starts");
  assert.deepEqual(await refreshSources(f.db, []), { fetched: 0, failed: 0, skipped: 0 });
  assert.deepEqual(await refreshSources({ execute: async () => { throw new Error("db gone"); } }, [1]), { fetched: 0, failed: 0, skipped: 0 }, "never throws");
});

test("a failing source makes no notification, on any cycle", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const feeds = await startFeedServer({}); cleanups.push(() => feeds.close());
  const bad = await seedSource(f.db, { name: "Gone", url: `${feeds.base}/missing.xml` });
  for (let i = 0; i < 3; i++) assert.equal((await fetchSingleSource(f.db, { id: bad, url: `${feeds.base}/missing.xml`, source_type: "rss" })).ok, false);
  assert.equal(await count(f.db, "SELECT COUNT(*) AS n FROM notifications"), 0);
  const src = readFileSync(join(REPO, "bundles/media/server/tasks.js"), "utf8");
  assert.doesNotMatch(src, /createNotification|notifications\.js|notifyIfAvailable/, "the feed task has no notification path at all");
});

test("items are stored once; an episode's audio address and length are parsed", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const id = await seedSource(f.db, { name: "Show", url: "https://show.example.invalid/feed.xml", type: "podcast" });
  const xml = rss("The Example Hour", [
    { ...item(1), title: "The Example Hour 2026-10-05 Monday", enclosure: "https://media.example.invalid/e1005.mp3", duration: "59:00" },
    { ...item(2), enclosure: "https://media.example.invalid/x.mp3", duration: "1:02:03" },
    { ...item(3) },
  ]);
  const { items } = parseFeed(xml);
  assert.deepEqual(items.map((i) => [i.enclosureAudio, i.duration]), [["https://media.example.invalid/e1005.mp3", 3540], ["https://media.example.invalid/x.mp3", 3723], [null, null]]);
  assert.equal(await insertFeedItems(f.db, { id }, items), 3);
  assert.equal(await insertFeedItems(f.db, { id }, items), 0, "the same items again add nothing");
  assert.equal(await insertFeedItems(f.db, { id }, null), 0);
  const row = (await f.db.execute("SELECT pub_date, audio_url FROM media_articles ORDER BY id LIMIT 1")).rows[0];
  assert.deepEqual({ ...row }, { pub_date: "2026-10-05T12:00:00.000Z", audio_url: "https://media.example.invalid/e1005.mp3" });
  assert.deepEqual(["3540", "59:00", "1:02:03", "0", "", "abc", "1:2:3:4", "-5", null].map(parseDuration), [3540, 3540, 3723, 0, null, null, null, null, null]);
});

test("a conditional fetch sends the saved ETag and reports an unchanged feed without a body", async () => {
  let version = 1;
  const feeds = await startFeedServer({
    "/show.xml": (req) => (req.headers["if-none-match"] === `"v${version}"` ? { status: 304 } : { headers: { ETag: `"v${version}"` }, body: rss("Show", [item(version)]) }),
  });
  cleanups.push(() => feeds.close());
  const first = await fetchFeedIfChanged(`${feeds.base}/show.xml`, null);
  assert.deepEqual([first.changed, first.etag, first.xml.includes("Story 1")], [true, '"v1"', true]);
  assert.deepEqual(await fetchFeedIfChanged(`${feeds.base}/show.xml`, first.etag), { changed: false });
  version = 2;
  const next = await fetchFeedIfChanged(`${feeds.base}/show.xml`, first.etag);
  assert.deepEqual([next.changed, next.etag], [true, '"v2"']);
  await assert.rejects(fetchFeedIfChanged(`${feeds.base}/missing.xml`, null), /HTTP 404/);
});
