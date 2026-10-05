/**
 * Shows that follow a briefing (bundles/media/server/attachments.js): which days, which feed item
 * is "today's episode", the watcher's cadence against a real feed server (conditional requests),
 * the late notice, giving up, and two runners. Feeds and names are made up.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freshMediaDb, seedSource, startFeedServer, rss, REPO } from "./helpers/media-fixtures.js";
import { normalizeConfig } from "../bundles/media/server/schedule.js";
import { planAttachments, matchEpisode, pollIntervalMs, watchAttachments, resetWatcherState } from "../bundles/media/server/attachments.js";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const run = promisify(execFile);
const at = (s) => Date.parse(s);
const OCC = at("2026-10-06T13:00:00Z");   // Tuesday 08:00 in America/Chicago
const TZ = "America/Chicago";
const hush = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const ep = (date, extra = {}) => ({ title: `The Example Hour ${date} ${extra.day || ""}`.trim(), guid: `ep-${date}`, link: `https://show.example.invalid/${date}`, pubDate: `${date}T12:00:00Z`, enclosure: `https://media.example.invalid/hour-${date}.mp3`, duration: "59:00", ...extra });
const EXTRA = { title: '"A Longer Talk": web extra', guid: "extra-1", pubDate: "2026-10-06T12:00:00Z", enclosure: "https://media.example.invalid/extra.mp3", duration: "18:30" };

test("which days: the weekday is the occurrence's in the schedule's zone; a missing or disabled show is left out", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const show = await seedSource(f.db, { name: "The Example Hour &amp; Friends", url: "https://show.example.invalid/p.xml", type: "podcast" });
  const off = await seedSource(f.db, { name: "Off Air", url: "https://off.example.invalid/p.xml", type: "podcast", enabled: 0 });
  const cfg = normalizeConfig({ tz: TZ, attach: [{ source_id: show, title_prefix: "The Example Hour 20" }, { source_id: off }, { source_id: 99999 }] });
  const tue = await planAttachments(f.db, cfg, OCC);
  assert.deepEqual(tue, [{ key: `show:${show}`, source_id: show, title: "The Example Hour & Friends", status: "pending", expect: "2026-10-06", title_prefix: "The Example Hour 20", wait_until: "2026-10-06T16:30:00.000Z", article_id: null, url: null, duration_sec: null, first_seen_at: null }]);
  assert.deepEqual(await planAttachments(f.db, cfg, at("2026-10-10T13:00:00Z")), [], "Saturday");
  assert.deepEqual(await planAttachments(f.db, cfg, at("2026-10-11T13:00:00Z")), [], "Sunday");
  assert.equal((await planAttachments(f.db, cfg, at("2026-10-09T13:00:00Z"))).length, 1, "Friday");
  // 03:30Z on Saturday is still Friday evening in Chicago: the zone decides, not UTC.
  assert.equal((await planAttachments(f.db, cfg, at("2026-10-10T03:30:00Z"))).length, 1);
  const weekend = normalizeConfig({ tz: TZ, attach: [{ source_id: show, days: [0, 6], wait_hours: 1 }] });
  assert.equal((await planAttachments(f.db, weekend, at("2026-10-10T13:00:00Z")))[0].wait_until, "2026-10-10T14:00:00.000Z");
  assert.deepEqual(await planAttachments(f.db, normalizeConfig({ tz: TZ }), OCC), []);
});

test("which item is today's episode: stamp window, audio at an http(s) address, and a plain-text title prefix", () => {
  const { items } = { items: [
    { title: EXTRA.title, pub_date: EXTRA.pubDate, enclosureAudio: EXTRA.enclosure, duration: 1110 },
    { title: "The Example Hour 2026-10-06 Tuesday", pub_date: "2026-10-06T12:00:00Z", enclosureAudio: "https://media.example.invalid/hour-1006.mp3", duration: 3540 },
    { title: "The Example Hour 2026-10-05 Monday", pub_date: "2026-10-05T12:00:00Z", enclosureAudio: "https://media.example.invalid/hour-1005.mp3", duration: 3540 },
  ] };
  const att = (title_prefix) => ({ title_prefix });
  assert.equal(matchEpisode(att("The Example Hour 20"), OCC, items).enclosureAudio, "https://media.example.invalid/hour-1006.mp3", "the web extra carries the same stamp; the prefix tells them apart");
  assert.equal(matchEpisode(att("the example hour 20"), OCC, items).duration, 3540, "case does not matter");
  assert.equal(matchEpisode(att(""), OCC, items).title, EXTRA.title, "without a prefix or a date the first audio item in the window is taken");
  assert.equal(matchEpisode({ title_prefix: "", expect: "2026-10-06" }, OCC, items).enclosureAudio, "https://media.example.invalid/hour-1006.mp3", "without a prefix, the item titled with the day's date wins over an extra listed first");
  assert.equal(matchEpisode({ title_prefix: "", expect: "2026-10-06" }, OCC, items.slice(0, 1)).title, EXTRA.title, "no dated title in the window: the first audio item still counts");
  assert.equal(matchEpisode({ title_prefix: "Nope", expect: "2026-10-06" }, OCC, items), null, "a prefix, when set, is the rule");
  // The live shape: the feed titles its episodes with dates and carries undated extras stamped like today's episode.
  const yesterdayOnly = [items[0], items[2]];
  assert.equal(matchEpisode({ title_prefix: "", expect: "2026-10-06" }, OCC, yesterdayOnly), null, "an undated extra is never taken for the episode of a feed that dates its titles");
  assert.equal(matchEpisode({ title_prefix: "", expect: "2026-10-06" }, OCC, [items[0], items[1], items[2]]).title, items[1].title, "then today's dated episode lands and is taken");
  assert.equal(matchEpisode(att("The Example Hour 20"), OCC, items.slice(2)), null, "yesterday's episode (25 hours before) is not today's");
  assert.equal(matchEpisode(att("The Example Hour 20"), OCC + 86_400_000, items), null, "nor is today's tomorrow's");
  const edge = (pub_date, enclosureAudio = "https://media.example.invalid/e.mp3") => matchEpisode(att(""), OCC, [{ title: "E", pub_date, enclosureAudio }]) !== null;
  assert.deepEqual([edge("2026-10-06T07:00:00Z"), edge("2026-10-06T06:59:59Z"), edge("2026-10-07T07:00:00Z"), edge("2026-10-07T07:00:01Z")], [true, false, true, false], "6 hours before to 18 hours after");
  assert.deepEqual([edge("2026-10-06T12:00:00Z", "javascript:alert(1)"), edge("2026-10-06T12:00:00Z", null), edge("2026-10-06T12:00:00Z", "ftp://x.example.invalid/e.mp3"), edge("not a date"), edge(null)], [false, false, false, false, false]);
  const t0 = Date.now();
  assert.equal(matchEpisode(att("(a+)+$"), OCC, [{ title: "a".repeat(50_000) + "!", pub_date: "2026-10-06T12:00:00Z", enclosureAudio: "https://media.example.invalid/e.mp3" }]), null, "a prefix is text, never a pattern");
  assert.ok(Date.now() - t0 < 500);
  assert.equal(matchEpisode(att(""), OCC, null), null);
});

test("cadence: every minute for the first 20 minutes after the occurrence, every 5 minutes before and after", () => {
  const min = 60_000;
  assert.deepEqual([-15, 0, 1, 19, 20, 21, 200].map((m) => pollIntervalMs(OCC + m * min, OCC) / min), [5, 1, 1, 1, 5, 5, 5]);
});

async function world({ announced = null, feedItems, prefix = "The Example Hour 20" }) {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const state = { items: feedItems, version: 1 };
  const feeds = await startFeedServer({
    "/show.xml": (req) => (req.headers["if-none-match"] === `"v${state.version}"` ? { status: 304 } : { headers: { ETag: `"v${state.version}"` }, body: rss("The Example Hour", state.items) }),
  });
  cleanups.push(() => feeds.close());
  const show = await seedSource(f.db, { name: "The Example Hour", url: `${feeds.base}/show.xml`, type: "podcast" });
  const cfg = normalizeConfig({ tz: TZ, attach: [{ source_id: show, title_prefix: prefix }] });
  const attachments = await planAttachments(f.db, cfg, OCC);
  const id = Number((await f.db.execute({
    sql: "INSERT INTO media_briefings (title, script, kind, status, scheduled_for, attachments, announced_at, lang) VALUES ('Morning briefing, Tuesday', 'text', 'daily', 'ready', ?, ?, ?, 'en')",
    args: [new Date(OCC).toISOString(), JSON.stringify(attachments), announced],
  })).lastInsertRowid);
  resetWatcherState();
  const watch = (iso) => hush(() => watchAttachments(f.db, { now: () => at(iso) }));
  const att = async () => JSON.parse((await f.db.execute({ sql: "SELECT attachments FROM media_briefings WHERE id = ?", args: [id] })).rows[0].attachments)[0];
  const notices = async () => (await f.db.execute("SELECT title, action_url, priority, source FROM notifications ORDER BY id")).rows.map((r) => ({ ...r }));
  return { ...f, feeds, state, show, id, watch, att, notices };
}

test("the usual morning: not there at 8:00, there at 8:04, filled in without a second notice", async () => {
  const w = await world({ announced: "2026-10-06T13:00:00.000Z", feedItems: [ep("2026-10-05", { day: "Monday" })] });
  assert.deepEqual(await w.watch("2026-10-06T13:00:10Z"), { polled: 1, ready: 0, missed: 0 });
  assert.equal(w.feeds.hits.length, 1);
  assert.deepEqual(await w.watch("2026-10-06T13:00:40Z"), { polled: 0, ready: 0, missed: 0 }, "not again inside the minute");
  assert.deepEqual(await w.watch("2026-10-06T13:01:10Z"), { polled: 1, ready: 0, missed: 0 });
  assert.deepEqual(w.feeds.hits.map((h) => h.etag), [null, '"v1"'], "the second request is conditional");
  assert.equal((await w.att()).status, "pending");
  // 8:04: the feed now carries today's episode and a web extra with the same stamp.
  w.state.items = [EXTRA, ep("2026-10-06", { day: "Tuesday" }), ep("2026-10-05", { day: "Monday" })];
  w.state.version = 2;
  assert.deepEqual(await w.watch("2026-10-06T13:04:10Z"), { polled: 1, ready: 1, missed: 0 });
  const a = await w.att();
  const article = (await w.db.execute({ sql: "SELECT id, title, audio_url FROM media_articles WHERE guid = 'ep-2026-10-06'", args: [] })).rows[0];
  assert.deepEqual([a.status, a.url, a.duration_sec, a.first_seen_at, a.article_id, a.episode_title], ["ready", "https://media.example.invalid/hour-2026-10-06.mp3", 3540, "2026-10-06T13:04:10.000Z", Number(article.id), "The Example Hour 2026-10-06 Tuesday"]);
  assert.equal(article.audio_url, a.url, "the episode is stored as an item of the show");
  assert.deepEqual(await w.notices(), [], "it landed 4 minutes after the announcement: the queue picks it up, no second notice");
  assert.deepEqual(await w.watch("2026-10-06T13:05:10Z"), { polled: 0, ready: 0, missed: 0 }, "nothing left to watch");
  assert.equal(w.feeds.hits.length, 3);
});

test("no title prefix (what the Briefings tab saves): the episode titled with today's date wins over a same-stamp extra listed first", async () => {
  const w = await world({ announced: "2026-10-06T13:00:00.000Z", prefix: "", feedItems: [EXTRA, ep("2026-10-05", { day: "Monday" })] });
  assert.equal((await w.att()).expect, "2026-10-06");
  assert.deepEqual(await w.watch("2026-10-06T13:01:10Z"), { polled: 1, ready: 0, missed: 0 }, "only the same-stamp extra is out: still pending");
  assert.equal((await w.att()).status, "pending");
  w.state.items = [EXTRA, ep("2026-10-06", { day: "Tuesday" }), ep("2026-10-05", { day: "Monday" })];
  w.state.version = 2;
  assert.deepEqual(await w.watch("2026-10-06T13:04:10Z"), { polled: 1, ready: 1, missed: 0 });
  assert.equal((await w.att()).url, "https://media.example.invalid/hour-2026-10-06.mp3");
});

test("a late episode: more than 10 minutes after the announcement, one low-priority notice with a play link", async () => {
  const w = await world({ announced: "2026-10-06T13:00:00.000Z", feedItems: [ep("2026-10-05")] });
  await w.watch("2026-10-06T13:00:10Z");
  w.state.items = [ep("2026-10-06"), ep("2026-10-05")];
  w.state.version = 2;
  assert.deepEqual(await w.watch("2026-10-06T14:40:10Z"), { polled: 1, ready: 1, missed: 0 });
  const a = await w.att();
  assert.deepEqual(await w.notices(), [{ title: "Today's The Example Hour is ready", action_url: `/dashboard/media?play=episode:${a.article_id}`, priority: "low", source: "media:show" }]);
  await w.watch("2026-10-06T14:45:10Z");
  assert.equal((await w.notices()).length, 1);
});

test("an episode that is already out when the briefing is written is found before the announcement, with no notice", async () => {
  const w = await world({ announced: null, feedItems: [ep("2026-10-06"), ep("2026-10-05")] });
  assert.deepEqual(await w.watch("2026-10-06T12:46:00Z"), { polled: 1, ready: 1, missed: 0 });
  assert.equal((await w.att()).status, "ready");
  assert.deepEqual(await w.notices(), []);
});

test("never published: checked until the limit, then marked missed, with no notice and no more requests", async () => {
  const w = await world({ announced: "2026-10-06T13:00:00.000Z", feedItems: [ep("2026-10-05")] });
  await w.watch("2026-10-06T13:00:10Z");
  await w.watch("2026-10-06T16:29:00Z");
  assert.equal((await w.att()).status, "pending");
  assert.deepEqual(await w.watch("2026-10-06T16:30:01Z"), { polled: 0, ready: 0, missed: 1 });
  assert.deepEqual([(await w.att()).status, (await w.att()).url], ["missed", null]);
  const hits = w.feeds.hits.length;
  await w.watch("2026-10-06T16:35:00Z");
  assert.equal(w.feeds.hits.length, hits);
  assert.deepEqual(await w.notices(), []);
});

test("a feed that fails is tried again; a show that was removed is skipped; neither stops the watcher", async () => {
  const w = await world({ announced: "2026-10-06T13:00:00.000Z", feedItems: [ep("2026-10-06")] });
  await w.db.execute({ sql: "UPDATE media_sources SET url = ? WHERE id = ?", args: [`${w.feeds.base}/gone.xml`, w.show] });
  assert.deepEqual(await w.watch("2026-10-06T13:00:10Z"), { polled: 1, ready: 0, missed: 0 });
  await w.db.execute({ sql: "UPDATE media_sources SET url = ? WHERE id = ?", args: [`${w.feeds.base}/show.xml`, w.show] });
  assert.deepEqual(await w.watch("2026-10-06T13:01:10Z"), { polled: 1, ready: 1, missed: 0 });
  const gone = await world({ announced: null, feedItems: [ep("2026-10-06")] });
  await gone.db.execute({ sql: "UPDATE media_sources SET enabled = 0 WHERE id = ?", args: [gone.show] });
  assert.deepEqual(await gone.watch("2026-10-06T13:00:10Z"), { polled: 1, ready: 0, missed: 0 });
  assert.equal(gone.feeds.hits.length, 0);
});

test("two runners see the late episode at the same moment: it is filled once and announced once", { timeout: 90_000 }, async () => {
  const w = await world({ announced: "2026-10-06T13:00:00.000Z", feedItems: [ep("2026-10-06"), ep("2026-10-05")] });
  const script = `
    const { createDbClient } = await import("./bundles/media/server/db.js");
    const { watchAttachments } = await import("./bundles/media/server/attachments.js");
    const db = createDbClient(process.argv[1]);
    while (Date.now() < Number(process.argv[2])) {}
    const r = await watchAttachments(db, { now: () => Date.parse("2026-10-06T14:40:00Z") });
    db.close();
    process.stdout.write(JSON.stringify(r));`;
  const startAt = Date.now() + 2000;
  const results = (await Promise.all([1, 2, 3].map(() => run(process.execPath, ["--input-type=module", "-e", script, w.dbPath, String(startAt)], { cwd: REPO, timeout: 30_000 })))).map((r) => JSON.parse(r.stdout));
  assert.equal(results.reduce((n, r) => n + r.ready, 0), 1, JSON.stringify(results));
  assert.equal((await w.att()).status, "ready");
  assert.equal((await w.notices()).length, 1);
  assert.equal(Number((await w.db.execute("SELECT COUNT(*) AS n FROM media_articles WHERE guid = 'ep-2026-10-06'")).rows[0].n), 1);
});
