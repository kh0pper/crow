/**
 * The words of a briefing (bundles/media/server/briefing-text.js, strings.js): cleaning feed text
 * for speech, choosing stories, the dated script. Fixtures copy the SHAPES real feeds produce
 * (entity-encoded markup, search-feed link summaries, boilerplate tails); the text is made up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanForSpeech, firstSentences, selectStories, spokenWhen, briefingTitle, buildScript, spokenSourceName } from "../bundles/media/server/briefing-text.js";
import { STRINGS, tr, reasonText } from "../bundles/media/server/strings.js";

const at = (s) => Date.parse(s);
const TZ = "America/Chicago";

test("cleanForSpeech: markup, entity-encoded markup, entities, addresses and boilerplate never reach the voice", () => {
  const cases = [
    // a search-feed summary as stored today: a live link tag and an outlet in a font tag
    ['<a href="https://news.example.invalid/rss/articles/CBMi1AFBVV95cUxOTkhvZ0xS?oc=5" target="_blank">Team rues poor fourth quarter</a>&nbsp;&nbsp;<font color="#6f6f6f">Example Outlet</font>', "Team rues poor fourth quarter Example Outlet"],
    ["&lt;p&gt;Markets &amp;amp; rates rose.&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;", "Markets & rates rose."],
    ["The base said &#8220;no&#8221; to the plan.&#160; Officials didn&#039;t comment&#8230;", "The base said “no” to the plan. Officials didn’t comment…".replace("’", "'")],
    ["Rates held steady on Friday. The post Rates held steady appeared first on Example Daily.", "Rates held steady on Friday."],
    ["Council approves budget. Read more at https://example.invalid/a?b=1&c=2 today", "Council approves budget."],
    ["A long story about rivers [&#8230;]", "A long story about rivers"],
    ["See www.example.invalid/x for details.", "See for details."],
    ["<p>Headlines for October 02; &#8220;Cruel &amp; Unusual&#8221;: a report</p>\n\n<p>Second   paragraph</p>", "Headlines for October 02; “Cruel & Unusual”: a report Second paragraph"],
    ["<style>p{color:red}</style>Text<br/>here", "Text here"],
    ["&bogus; &#0; &#xD800; ok", "ok"],
    [null, ""], [undefined, ""], [42, "42"],
  ];
  for (const [input, want] of cases) assert.equal(cleanForSpeech(input), want, String(input));
  for (const [input] of cases) assert.doesNotMatch(cleanForSpeech(input), /[<>]|&[a-z#]|https?:|www\./i, String(input));
});

test("cleanForSpeech: hostile input is bounded", () => {
  const t0 = Date.now();
  for (const evil of ["<".repeat(200_000), "&".repeat(200_000), "<a ".repeat(50_000), "The post ".repeat(40_000), "Read more ".repeat(40_000), "http://" + "a".repeat(200_000), "[" + " ".repeat(200_000)]) {
    assert.ok(cleanForSpeech(evil).length <= 20_000);
  }
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test("firstSentences: two sentences, at most 400 characters, always ends cleanly", () => {
  assert.equal(firstSentences("One. Two. Three."), "One. Two.");
  assert.equal(firstSentences("The U.S. base closed. Second one. Third."), "The U.S. base closed. Second one.");
  assert.equal(firstSentences("No full stop here"), "No full stop here.");
  assert.equal(firstSentences("He said “stop.” Then left. More."), "He said “stop.” Then left.");
  const long = firstSentences(`${"word ".repeat(120).trim()}. Next.`);
  assert.ok(long.length <= 401 && long.endsWith("…"), long.slice(-20));
  assert.equal(firstSentences(`A${"a".repeat(389)}. B${"b".repeat(40)}.`), `A${"a".repeat(389)}.`, "a second sentence that would pass the limit is left out");
  assert.equal(firstSentences(`${"word ".repeat(79)}end. ${"x".repeat(40)}`).endsWith("end."), true, "a cut that lands on a sentence end gets no ellipsis");
  assert.equal(firstSentences(""), "");
});

const row = (id, source_id, source_name, title, summary, extra = {}) => ({ id, source_id, source_name, title, summary, content_full: null, url: `https://example.invalid/${id}`, ...extra });

test("selectStories: one per source first, a cap per source, same-title items once, text cleaned", () => {
  const rows = [
    row(1, 10, "Busy Wire", "Alpha happens", "Alpha text is here for the listener."),
    row(2, 10, "Busy Wire", "Beta happens", "Beta text is here for the listener."),
    row(3, 10, "Busy Wire", "Gamma happens", "Gamma text is here for the listener."),
    row(4, 11, "Quiet Paper &#8211; News", "ALPHA happens!", "A second telling of alpha."),
    row(5, 11, "Quiet Paper &#8211; News", "Delta &amp; more", "<p>Delta text is here.</p> The post Delta appeared first on Quiet Paper."),
    row(6, 12, "Third Source", "Epsilon", "Epsilon", { url: "javascript:alert(1)" }),
    row(7, 12, "Third Source", "", "No title at all."),
  ];
  const picked = selectStories(rows, { maxStories: 8, perSource: 2 });
  assert.deepEqual(picked.map((s) => s.article_id), [1, 5, 6, 2], "round one across sources, then round two; source 10 capped at two; the repeat of alpha told once");
  assert.equal(picked[1].title, "Delta & more");
  assert.equal(picked[1].source, "Quiet Paper", "the feed's tagline is not spoken");
  assert.equal(picked[1].text, "Delta text is here.");
  assert.equal(picked[2].text, "", "a summary that only repeats the title adds nothing");
  assert.equal(picked[2].link, null, "only http(s) links are kept");
  assert.equal(picked[0].link, "https://example.invalid/1");
  assert.deepEqual(selectStories(rows, { maxStories: 2, perSource: 2 }).map((s) => s.article_id), [1, 5]);
  assert.deepEqual(selectStories(rows, { maxStories: 8, perSource: 1 }).map((s) => s.article_id), [1, 5, 6]);
  assert.deepEqual(selectStories([], {}), []);
  assert.deepEqual(selectStories(null, {}), []);
  assert.deepEqual(selectStories(rows, {}), selectStories(rows, {}), "the same rows give the same stories");
});

test("spokenWhen: the day, date and time of day in the briefing's zone, in both languages", () => {
  const morning = at("2026-10-06T12:45:00Z");   // 07:45 in Chicago
  assert.deepEqual(spokenWhen(morning, TZ, "en"), { weekday: "Tuesday", date: "October 6th", daypart: "morning", time: "7:45 AM", ymd: "2026-10-06", dow: 2 });
  assert.equal(spokenWhen(morning, TZ, "es").weekday, "martes");
  assert.equal(spokenWhen(morning, TZ, "es").date, "6 de octubre");
  assert.equal(spokenWhen(at("2026-10-06T02:10:00Z"), TZ, "en").weekday, "Monday", "21:10 on Monday in Chicago, though Tuesday in UTC");
  assert.equal(spokenWhen(at("2026-10-06T02:10:00Z"), TZ, "en").daypart, "evening");
  assert.equal(spokenWhen(at("2026-10-06T18:00:00Z"), TZ, "en").daypart, "afternoon");
  const dates = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map((d) => spokenWhen(Date.UTC(2026, 9, d, 15), "UTC", "en").date.split(" ")[1]);
  assert.deepEqual(dates, ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
});

test("buildScript: a dated first paragraph, one paragraph per story naming its source, a closing line true in every case", () => {
  const when = spokenWhen(at("2026-10-06T12:45:00Z"), TZ, "en");
  const stories = [
    { title: "Council approves budget", text: "The vote was seven to two. Work starts in spring.", source: "Example Daily" },
    { title: "Is the river rising?", text: "", source: "Quiet Paper" },
  ];
  const s = buildScript({ stories, when, lang: "en", show: "The Example Hour" });
  assert.equal(s.paragraphs.length, 4);
  assert.equal(s.chapters.length, 4);
  assert.equal(s.paragraphs[0], "Good morning. It's Tuesday, October 6th. Here are 2 stories.");
  assert.equal(s.paragraphs[1], "From Example Daily. Council approves budget. The vote was seven to two. Work starts in spring.");
  assert.equal(s.paragraphs[2], "From Quiet Paper. Is the river rising?");
  assert.equal(s.paragraphs[3], "That's your briefing. Today's The Example Hour follows as soon as it is published.");
  assert.deepEqual(s.chapters, ["Introduction", "Council approves budget", "Is the river rising?", "Closing"]);
  for (const p of s.paragraphs) assert.doesNotMatch(p, /\n/);
  assert.equal(buildScript({ stories: [], when, lang: "en" }).paragraphs.join(" "), "Good morning. It's Tuesday, October 6th. There are no new stories from your sources. That's your briefing.");
  assert.equal(buildScript({ stories: stories.slice(0, 1), when, lang: "en" }).paragraphs[0], "Good morning. It's Tuesday, October 6th. Here is one story.");
  const es = buildScript({ stories, when: spokenWhen(at("2026-10-06T23:30:00Z"), TZ, "es"), lang: "es" });
  assert.equal(es.paragraphs[0], "Buenas noches. Es martes, 6 de octubre. Estas son 2 noticias.");
  assert.equal(es.paragraphs[1].startsWith("De Example Daily."), true);
  assert.equal(es.paragraphs.at(-1), "Ese es tu resumen.");
});

test("titles: a daily briefing is named for its time of day and weekday; a manual one carries its time", () => {
  const when = spokenWhen(at("2026-10-06T12:45:00Z"), TZ, "en");
  assert.equal(briefingTitle({ kind: "daily", when, lang: "en" }), "Morning briefing, Tuesday");
  assert.equal(briefingTitle({ kind: "daily", when: spokenWhen(at("2026-10-06T12:45:00Z"), TZ, "es"), lang: "es" }), "Resumen de la mañana, martes");
  assert.equal(briefingTitle({ kind: "manual", when, lang: "en" }), "Briefing, Tuesday 7:45 AM");
  assert.equal(briefingTitle({ kind: "manual", topic: "<b>water</b>", when, lang: "en" }), "Briefing on water, Tuesday");
});

test("strings: English and Spanish have the same keys and the same slots; unknown keys and languages fall back", () => {
  const slots = (s) => (s.match(/\{[a-z_]+\}/g) || []).sort().join(",");
  assert.deepEqual(Object.keys(STRINGS.es).sort(), Object.keys(STRINGS.en).sort());
  for (const k of Object.keys(STRINGS.en)) {
    assert.equal(slots(STRINGS.es[k]), slots(STRINGS.en[k]), k);
    assert.ok(STRINGS.es[k].trim() && STRINGS.en[k].trim(), k);
  }
  assert.equal(tr("intro_count", "es", { n: 3 }), "Estas son 3 noticias.");
  assert.equal(tr("intro_count", "fr", { n: 3 }), "Here are 3 stories.");
  assert.equal(tr("no_such_key", "en"), "no_such_key");
  assert.equal(tr("intro_count", "en"), "Here are  stories.");
  assert.equal(reasonText("voice_failed", "en"), "the local voice did not answer.");
  assert.equal(reasonText("voice_failed", "es"), "la voz local no respondió.");
  assert.equal(reasonText("ENOENT: x", "en"), "something went wrong (ENOENT: x).");
});

test("source names are spoken without the feed's tagline", () => {
  const cases = {
    "Al Jazeera – Breaking News, World News and Video from Al Jazeera": "Al Jazeera",
    "NYT > Top Stories": "NYT",
    "PBS NewsHour - The Latest": "PBS NewsHour",
    "NOTUS | News of the United States": "NOTUS",
    "NPR Topics: Politics": "NPR Topics: Politics",
    "Texas Tribune": "Texas Tribune",
    "Drop Site News": "Drop Site News",
    "Up-to-date &amp; Local": "Up-to-date & Local",
    "A | tagline only": "A | tagline only",
  };
  for (const [name, spoken] of Object.entries(cases)) assert.equal(spokenSourceName(name), spoken, name);
  const [story] = selectStories([{ id: 1, title: "Budget passes", summary: "The vote was close tonight in the chamber.", source_id: 1, source_name: "NYT > Top Stories", url: "https://news.example.invalid/1" }]);
  assert.equal(story.source, "NYT");
});
