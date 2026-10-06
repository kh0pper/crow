/**
 * The Media panel as rendered (bundles/media/panel/media.js), driven through its real handler with
 * the dashboard's real shared components: the Briefings tab, and the places where feed-controlled
 * text meets HTML. Hostile feed values must come out as inert data: escaped, never inside an
 * inline event handler, and never as a non-http(s) address.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { seedSource, seedArticle, fakeMp3, REPO } from "./helpers/media-fixtures.js";
import { createDbClient } from "../servers/db.js";
import { initMediaTables } from "../bundles/media/server/init-tables.js";
import { resolveAudioDir } from "../bundles/media/server/speech.js";
import { saveSchedule } from "../bundles/media/server/schedule.js";
import { writeLocalSetting, JOB_STATE_KEY } from "../bundles/media/server/settings.js";
import { STRINGS } from "../bundles/media/server/strings.js";
import panel from "../bundles/media/panel/media.js";

let db, show, ids;
const HOSTILE_URL = "https://media.example.invalid/a.mp3');alert(document.cookie);//";
const HOSTILE_TITLE = `Rates "rise" </script><img src=x onerror=alert(1)> it's \\ here`;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, stdio: "pipe" });
  db = createDbClient();
  const quiet = console.error; console.error = () => {};
  try { await initMediaTables(db); } finally { console.error = quiet; }
  const site = await seedSource(db, { name: "Example <b>Wire</b>", url: "https://wire.example.invalid/feed" });
  show = await seedSource(db, { name: "The Example Hour", url: "https://show.example.invalid/p.xml", type: "podcast" });
  const now = Date.now();
  ids = {
    hostile: await seedArticle(db, { source_id: site, title: HOSTILE_TITLE, summary: "A summary.", pub_date: new Date(now - 60_000).toISOString(), url: "javascript:alert(1)", audio_url: HOSTILE_URL }),
    plain: await seedArticle(db, { source_id: site, title: "A plain story", summary: "Plain.", pub_date: new Date(now - 120_000).toISOString(), url: "https://wire.example.invalid/plain", audio_url: "https://media.example.invalid/ok.mp3" }),
    episode: await seedArticle(db, { source_id: show, title: "The Example Hour 2026-10-06", pub_date: new Date(now - 180_000).toISOString(), audio_url: "https://media.example.invalid/hour.mp3" }),
  };
  await saveSchedule(db, { time: "08:00", tz: "America/Chicago", attach: [{ source_id: show }] });
  await writeLocalSetting(db, JOB_STATE_KEY, JSON.stringify({ tick_at: new Date(now - 20_000).toISOString(), state: "on", error: null }));
  const audio = join(resolveAudioDir(), "panel-briefing.mp3");
  writeFileSync(audio, fakeMp3(100));
  const ins = async (cols) => Number((await db.execute({ sql: `INSERT INTO media_briefings (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`, args: Object.values(cols) })).lastInsertRowid);
  ids.failed = await ins({ title: "Morning briefing, Sunday", kind: "daily", status: "failed", error: "stuck", scheduled_for: "2026-10-04T13:00:00.000Z" });
  ids.textOnly = await ins({ title: "Morning briefing, Monday", script: "Good morning. It's Monday.\n\nThat's your briefing.", kind: "daily", status: "ready", error: "voice_failed", scheduled_for: "2026-10-05T13:00:00.000Z", items_json: "[]" });
  ids.ready = await ins({
    title: `Morning briefing, Tuesday <i>x</i> it's`, script: `Good morning. It's Tuesday, October 6th. Here is one story.\n\nFrom Example Wire. ${HOSTILE_TITLE}\n\nThat's your briefing.`,
    kind: "daily", status: "ready", audio_path: audio, duration_sec: 372, scheduled_for: "2026-10-06T13:00:00.000Z", ready_at: "2026-10-06T12:46:00.000Z",
    items_json: JSON.stringify([{ title: HOSTILE_TITLE, link: "javascript:alert(2)", source: "Example <b>Wire</b>", article_id: ids.hostile }, { title: "A plain story", link: "https://wire.example.invalid/plain", source: "Example Wire", article_id: ids.plain }]),
    attachments: JSON.stringify([
      { key: `show:${show}`, title: "The Example Hour", status: "ready", url: "https://media.example.invalid/hour.mp3", episode_title: `Episode "one" <b>`, article_id: ids.episode, wait_until: "2026-10-06T16:30:00.000Z" },
      { key: "show:98", title: "Bad' Show", status: "ready", url: "javascript:alert(3)", article_id: 5, wait_until: "2026-10-06T16:30:00.000Z" },
      { key: "show:99", title: "Late <Show>", status: "pending", url: null, wait_until: "2026-10-06T16:30:00.000Z" },
    ]),
  });
});
after(() => { try { db?.close(); } catch {} });

async function render(query, lang = "en") {
  const out = await panel.handler({ method: "GET", query, body: {} }, {}, { db, appRoot: REPO, lang, layout: (opts) => opts });
  const { document } = parseHTML(`<!doctype html><html><body>${out.content}</body></html>`);
  return { html: out.content, scripts: out.scripts, document };
}

test("feed cards: a hostile enclosure address and title are inert data, never part of a handler; a javascript: link is not a link", async () => {
  const { html, document } = await render({ tab: "feed" });
  const plays = [...document.querySelectorAll('[data-media-action="play"]')];
  assert.ok(plays.length >= 2);
  const hostile = plays.find((b) => b.getAttribute("data-audio-url") === new URL(HOSTILE_URL).href);
  assert.ok(hostile, "the address survives byte for byte, as data");
  assert.equal(hostile.getAttribute("data-title"), HOSTILE_TITLE);
  assert.equal(hostile.getAttribute("onclick"), null);
  for (const el of document.querySelectorAll("[onclick]")) {
    const code = el.getAttribute("onclick");
    assert.ok(!code.includes("example.invalid") && !code.includes("alert(") && !code.includes("Rates"), `feed data inside an inline handler: ${code}`);
  }
  assert.doesNotMatch(html, /crowPlayer\.load\('/, "the old inline player call is gone");
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.equal(document.querySelectorAll("img[onerror]").length, 0);
  assert.ok(html.includes("it&#39;s"), "single quotes are encoded");
  const listen = document.querySelector(`[data-media-action="listen"][data-article-id="${ids.hostile}"]`);
  assert.equal(listen.getAttribute("data-title"), HOSTILE_TITLE);
  assert.equal(listen.getAttribute("onclick"), null);
  assert.ok([...document.querySelectorAll("a[href]")].some((a) => a.getAttribute("href") === "https://wire.example.invalid/plain"));
});

test("Briefings tab: schedule line with its zone, scheduler heartbeat, cards with status, a ready show, a pending show, script and story links", async () => {
  const { html, document } = await render({ tab: "briefings" });
  assert.match(html, /Next briefing: \w+day, \w+ \d+(,| at) 8:00 AM \(America\/Chicago\)/);
  assert.match(html, /Scheduler last checked \d{1,2}:\d\d [AP]M\./);
  assert.match(html, /Voice: local only\. Nothing is sent to a cloud voice\./);
  assert.equal(document.querySelector("#media-sched-time").getAttribute("value"), "08:00");
  assert.equal(document.querySelector(`#media-sched-show option[value="${show}"]`).hasAttribute("selected"), true);
  const cards = [...document.querySelectorAll("[data-briefing]")];
  assert.equal(cards.length, 3);
  const data = JSON.parse(cards[0].getAttribute("data-briefing"));
  assert.deepEqual(data, {
    id: ids.ready, title: "Morning briefing, Tuesday <i>x</i> it's", src: `/api/media/briefings/${ids.ready}/audio`,
    shows: [
      { title: "The Example Hour", status: "ready", url: "https://media.example.invalid/hour.mp3", episode: 'Episode "one" <b>', article_id: ids.episode, wait_until: "2026-10-06T16:30:00.000Z" },
      { title: "Bad' Show", status: "ready", url: "", episode: "", article_id: 5, wait_until: "2026-10-06T16:30:00.000Z" },
      { title: "Late <Show>", status: "pending", url: "", episode: "", article_id: null, wait_until: "2026-10-06T16:30:00.000Z" },
    ],
  }, "what Play reads: plain data in one attribute; an address that is not http(s) is dropped");
  assert.ok(cards[0].querySelector('[data-media-action="briefing-play"]'));
  assert.match(cards[0].textContent, /2 stories · 6:12 · /);
  assert.match(cards[0].textContent, /Then: Episode "one" <b>/);
  assert.match(cards[0].textContent, /Late <Show>: not published yet, checking until 11:30 AM/);
  assert.equal(cards[0].querySelectorAll('[data-media-action="play"]').length, 1, "only the show with an http(s) address gets a play button");
  assert.equal(cards[0].querySelector("i"), null, "markup in a title is text");
  assert.equal(cards[0].querySelector("img"), null);
  const paragraphs = [...cards[0].querySelectorAll("details p")].map((p) => p.textContent);
  assert.deepEqual(paragraphs, ["Good morning. It's Tuesday, October 6th. Here is one story.", `From Example Wire. ${HOSTILE_TITLE}`, "That's your briefing."]);
  const links = [...cards[0].querySelectorAll("details a")].map((a) => a.getAttribute("href"));
  assert.deepEqual(links, ["https://wire.example.invalid/plain"], "a story link that is not http(s) is shown as text");
  assert.match(cards[1].textContent, /Ready to read\. No audio: the local voice did not answer\./);
  assert.equal(cards[1].querySelector('[data-media-action="briefing-play"]'), null);
  assert.match(cards[2].textContent, /Could not be made: it did not finish\./);
  assert.equal(document.querySelectorAll("[data-briefing] [onclick], .card [onclick]").length, 0, "no inline handlers on this tab");
  assert.equal(document.querySelectorAll("audio").length, 0, "playback goes through the shared player bar");
  assert.doesNotMatch(html, /<script/i);
});

test("notification links land on the Briefings tab and mark the control to press", async () => {
  const play = await render({ play: `briefing:${ids.ready}` });
  const focused = play.document.querySelectorAll("[data-media-focus]");
  assert.equal(focused.length, 1);
  assert.ok(focused[0].getAttribute("data-media-action") === "briefing-play");
  assert.equal(JSON.parse(focused[0].closest("[data-briefing]").getAttribute("data-briefing")).id, ids.ready);
  const open = await render({ open: `briefing:${ids.textOnly}` });
  assert.equal(open.document.querySelectorAll("[data-media-focus]").length, 0);
  assert.equal(open.document.querySelectorAll("details[open]").length, 1, "the text is opened");
  const episode = await render({ play: `episode:${ids.episode}` });
  const ep = episode.document.querySelector("[data-media-focus]");
  assert.deepEqual([ep.getAttribute("data-media-action") === "play", ep.getAttribute("data-audio-url")], [true, "https://media.example.invalid/hour.mp3"]);
  for (const bad of ["briefing:1;zzqq(1)", "<zzqq>", "episode:-1", "zzqq"]) {
    const r = await render({ play: bad });
    assert.equal(r.document.querySelectorAll("[data-media-focus]").length, 0, bad);
    assert.ok(!r.html.includes("zzqq"), "the link value is never written into the page");
  }
  assert.ok((await render({})).html.includes("media-grid"), "with no link the page opens on the feed, as before");
});

test("schedule states: off, not set, a row News cannot run, a skipped morning, a silent scheduler", async () => {
  await saveSchedule(db, { enabled: false });
  assert.match((await render({ tab: "briefings" })).html, /The daily briefing is off\./);
  await db.execute("UPDATE schedules SET enabled = 1, cron_expression = '@daily' WHERE task = 'media:briefing'");
  assert.match((await render({ tab: "briefings" })).html, /The schedule &quot;@daily&quot; is not one News can run\./);
  await db.execute("DELETE FROM schedules WHERE task = 'media:briefing'");
  assert.match((await render({ tab: "briefings" })).html, /No daily briefing is scheduled yet\./);
  // Every minute of every day: the last occurrence is always just past, and with no catch-up it counts as skipped.
  await saveSchedule(db, { cron: "* * * * *", catch_up_hours: 0 }, { now: Date.now() - 3_600_000 });
  await writeLocalSetting(db, JOB_STATE_KEY, JSON.stringify({ tick_at: new Date(Date.now() - 3_600_000).toISOString(), state: "on", error: null }));
  const stale = (await render({ tab: "briefings" })).html;
  assert.match(stale, /briefing was skipped: Crow was not running in time\./);
  assert.match(stale, /<strong>The scheduler has not checked in since /);
  await saveSchedule(db, { time: "08:00", catch_up_hours: 4 });
});

test("Spanish: the tab's own strings come from the Spanish table", async () => {
  const { html } = await render({ tab: "briefings" }, "es");
  for (const key of ["tab_schedule", "tab_make", "tab_save", "tab_latest", "tab_earlier", "tab_voice", "tab_show_days"]) {
    assert.ok(html.includes(STRINGS.es[key].replace(/"/g, "&quot;")), key);
    assert.ok(!html.includes(STRINGS.en[key]), `${key} is still English`);
  }
  assert.match(html, /Próximo resumen: \p{L}+, \d+ de \p{L}+(,| a las) 8:00 /u);
  assert.match(html, /Listo para leer\. Sin audio: la voz local no respondió\./);
});

test("the page script is plain JavaScript inside a template literal: it parses, has one delegated listener, no backticks and no interpolation", async () => {
  const { scripts } = await render({ tab: "briefings" });
  assert.doesNotThrow(() => new Function(scripts), "the script must parse");
  assert.ok(!scripts.includes("`"), "no backticks in client code");
  assert.ok(!scripts.includes("${"), "no template interpolation in client code");
  assert.match(scripts, /document\.addEventListener\('click'/);
  assert.match(scripts, /window\.crowPlayer\.queue\(items\)/);
  assert.match(scripts, /window\.crowPlayer\.addToQueue\(/, "a show that lands later is appended");
  assert.doesNotMatch(scripts, /location\.reload\(\);\s*}\)\s*\.catch\(function\(e\) \{ alert\('Error/, "the old generate handler is gone");
  const src = readFileSync(join(REPO, "bundles/media/panel/media.js"), "utf8");
  const tabStart = src.indexOf("// --- Briefings tab ---"), tabEnd = src.indexOf("// --- Podcasts tab ---");
  assert.doesNotMatch(src.slice(tabStart, tabEnd), /onclick=/, "the Briefings tab has no inline handlers");
  assert.doesNotMatch(src, /process\.env\.HOME \|\| "", "\.crow", "bundles"/, "the panel looks for its own instance's installed copy");
});

test("the tab row wraps on a narrow screen instead of widening the page", async () => {
  const { document } = await render({ tab: "briefings" });
  const nav = document.querySelector(".media-tabs");
  assert.ok(nav, "the tab row is there");
  assert.match(nav.getAttribute("style"), /flex-wrap:\s*wrap/);
  assert.ok(nav.querySelectorAll("a").length >= 7);
});
