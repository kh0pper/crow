/**
 * Quote matching (servers/research/quote-match.js): does a quoted claim appear in a fetched
 * page's text? Pure functions, no network, no DB. Corpus pages are synthesized for this repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeForMatch, matchQuote, MIN_PIECE_CHARS } from "../servers/research/quote-match.js";
import { extractReadable } from "../servers/shared/fetch-page-worker.js";

const FIX = new URL("./fixtures/research-pages/", import.meta.url);
const page = (readable, body = "", truncated = false) => ({ readable, body, truncated });

test("MIN_PIECE_CHARS is 4", () => {
  assert.equal(MIN_PIECE_CHARS, 4);
});

test("NBSP, soft hyphen, curly quotes, dashes and case are normalized", () => {
  assert.equal(normalizeForMatch("We ship\u00a0 \u201cweek\u00adly\u201d \u2014 Now"), 'we ship "weekly" - now');
  assert.equal(normalizeForMatch("it\u2019s a \u2018test\u2019 \u2026 ok"), "it's a 'test' ... ok");
  assert.equal(normalizeForMatch(null), "");
});

test("[sic], numeric and superscript footnote markers are removed", () => {
  assert.equal(normalizeForMatch("growth[12] was strong\u00b9 [sic]"), "growth was strong");
  assert.equal(normalizeForMatch("a claim[citation needed] here[a]"), "a claim here");
});

test("outer quote marks and a trailing attribution are stripped", () => {
  const r = matchQuote("\u201cWe ship weekly.\u201d \u2014 A. Person, CEO", page("Intro. We ship weekly. More text."));
  assert.deepEqual(r, { found: 1, where: "readable", reason: null });
  assert.equal(matchQuote("'we ship weekly'", page("so we ship weekly today")).found, 1);
  // unquoted quote with a trailing attribution: the fallback candidate cuts it
  assert.equal(matchQuote("We ship weekly now - A. Person", page("they said we ship weekly now.")).found, 1);
});

test("a fabricated clause after a dash is not cut away", () => {
  const p = page("Intro. We ship weekly. More text.");
  assert.equal(matchQuote("We ship weekly - and we have never shipped a bug", p).found, 0);
  assert.equal(matchQuote("\"We ship weekly\" - and never ship bugs", p).found, 0);
  assert.equal(matchQuote("We ship weekly \u2014 the best team in the world", p).found, 0);
});

test("a title-cased fabricated tail is not an attribution", () => {
  const p = page("We ship weekly. Other text.");
  for (const q of [
    "We ship weekly \u2014 Never Shipped A Bug Ever",
    "We ship weekly - Always Zero Defects",
    "We ship weekly - The Company Has Never Shipped",
    "We ship weekly \u2014 Nothing",
    "We ship weekly - A",
    "\"We ship weekly\" Never Shipped Bugs",
  ]) assert.equal(matchQuote(q, p).found, 0, q);
  assert.equal(matchQuote("We ship weekly - A. Person, Chief Executive", p).found, 1);
  assert.equal(matchQuote("We ship weekly - Jane Doe", p).found, 1);
});

test("a real attribution tail is cut only after the full quote fails", () => {
  const p = page("Intro. We ship weekly. More text.");
  assert.equal(matchQuote("\"We ship weekly,\" \u2014 Jane Doe", p).found, 1);
  assert.equal(matchQuote("We ship weekly - Alex Rivera, CEO", p).found, 1);
  assert.equal(matchQuote("\u201cWe ship weekly\u201d Jane Doe of the Example Group", p).found, 1);
  // a title over 3 words is not an attribution
  assert.equal(matchQuote("We ship weekly - Alex Rivera, Chief Executive Officer Elect", p).found, 0);
  // the full quote is tried first: a dash that is part of the page text still matches
  assert.equal(matchQuote("easier to test - And Easier", page("easier to test - and easier to undo")).found, 1);
});

const CUT = "couldn't check exactly: Crow checks only exact wording; quote the passage without cuts, or verify by hand";

test("apostrophe-like marks fold to '", () => {
  assert.equal(normalizeForMatch("we don\u02bct, we can\u2019t, it\u2018s, it`s"), "we don't, we can't, it's, it's");
  assert.equal(matchQuote("We don\u02bct raise prices", page("We don't raise prices.")).found, 1);
});

test("any ellipsis in a quote is null, never 1 or 0", () => {
  for (const q of ["alpha \u2026 gamma", "alpha ... gamma", "alpha . . . gamma", "gamma ... alpha", "the \u2026 the"]) {
    assert.deepEqual(matchQuote(q, page("alpha beta gamma, the cat and the dog")), { found: null, where: null, reason: CUT }, q);
  }
});

test("any bracket other than the allowed marks is null, never 1 or 0", () => {
  for (const q of ["[the company] will ship weekly", "Acme said [that] it will ship weekly", "We will [ ] ship weekly",
    "We will ship weekly [this year]", "We will ship [weekly", "We will ship] weekly"]) {
    assert.deepEqual(matchQuote(q, page("Acme said it will ship weekly. We will ship weekly.")), { found: null, where: null, reason: CUT }, q);
  }
});

test("the security-review bypasses are never 1", () => {
  const cases = [
    ["We will [raise prices]", "We will not raise prices."],
    ["[They] raise prices every year", "They never raise prices every year."],
    ["We will raise prices [this year]", "We will raise prices."],
    ["We [do] raise prices", "We dont raise prices."],
    ["We will [not] raise prices", "We will raise prices."],
    ["We will ... raise prices", "We will not raise prices."],
    ["We hired [10] new staff", "We hired new staff."],
    ["Prices will [increase]", "Prices will decrease."],
    ["... we will raise prices", "Not true: we will raise prices"],
    ["We will ... not ... raise prices", "We will raise prices this year."],
  ];
  for (const [q, text] of cases) {
    const r = matchQuote(q, page(text));
    assert.notEqual(r.found, 1, `${q} vs ${text}`);
    assert.equal(r.found, null, `${q} vs ${text}`);
  }
  // without the edit, a changed word reads 0
  assert.equal(matchQuote("We will raise prices", page("We will not raise prices.")).found, 0);
  assert.equal(matchQuote("We do raise prices", page("We dont raise prices.")).found, 0);
});

test("combining marks and astral letters count as word characters", () => {
  assert.equal(matchQuote("ship weekly", page("we ship weekly\u0332 report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we \u{10330}ship weekly report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we ship weekly\u{10330} report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we \u{1f600} ship weekly report")).found, 1);
});

test("[sic], [citation needed] and attached footnotes drop", () => {
  assert.equal(matchQuote("growth[3] was strong", page("growth was strong")).found, 1);
  assert.equal(matchQuote("We hired new staff[3]", page("We hired new staff.")).found, 1);
  assert.equal(matchQuote("the end.[12] Next", page("the end. Next")).found, 1);
  assert.equal(matchQuote("a claim[a] here", page("a claim here")).found, 1);
  assert.equal(matchQuote("growth was strong [sic]", page("growth[12] was strong")).found, 1);
  assert.equal(matchQuote("growth [citation needed] was strong", page("growth was strong")).found, 1);
  // a spaced footnote-looking bracket is an edit, not a footnote
  assert.equal(matchQuote("We hired [10] new staff", page("We hired [10] new staff.")).found, null);
  assert.equal(normalizeForMatch("We hired [10] new staff"), "we hired [10] new staff");
});

test("a quote's closing punctuation need not match the page's", () => {
  assert.equal(matchQuote("We ship weekly.", page("we ship weekly, and test daily")).found, 1);
});

test("a changed first-letter case still matches", () => {
  assert.equal(matchQuote("Will ship weekly", page("acme will ship weekly")).found, 1);
});

test("matches on word boundaries only", () => {
  assert.equal(matchQuote("ship weekly", page("the relationship weekly report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we ship weekly")).found, 1);
  assert.equal(matchQuote("ship week", page("we ship weekly")).found, 0);
  // a non-boundary hit is skipped and a later boundary hit is accepted
  assert.equal(matchQuote("ship weekly", page("relationship weekly, and we ship weekly")).found, 1);
});

test("a quote under 4 normalized chars is not checked", () => {
  const r = matchQuote("the", page("the cat and the dog"));
  assert.deepEqual(r, { found: null, where: null, reason: "too short to check" });
  assert.equal(matchQuote("\"ab.\"", page("ab")).reason, "too short to check");
  assert.equal(matchQuote("", page("anything")).found, null);
  assert.equal(matchQuote("cats", page("the cats sat")).found, 1);
});

test("a capitalisation bracket keeps its letter", () => {
  assert.equal(matchQuote("[I]t was great", page("It was great.")).found, 1);
  assert.equal(matchQuote("[A]ll staff agreed", page("All staff agreed.")).found, 1);
  assert.equal(matchQuote("[N]ot so", page("Hot so.")).found, 0);
  assert.equal(normalizeForMatch("[I]t was"), "it was");
});

test("a leading or trailing ellipsis is a cut too", () => {
  assert.equal(matchQuote("... we will raise prices", page("Not true: we will raise prices")).reason, CUT);
  assert.equal(matchQuote("we will raise prices...", page("we will raise prices... not")).reason, CUT);
  assert.equal(matchQuote("we will raise prices\u2026", page("we will raise prices")).reason, CUT);
});

test("a quote over 2,000 normalized chars is not checked", () => {
  const q = "word ".repeat(401);
  assert.deepEqual(matchQuote(q, page(q)), { found: null, where: null, reason: "too long to check" });
  assert.equal(matchQuote("word ".repeat(399) + "word", page("word ".repeat(400))).found, 1);
});

test("matching is bounded on a crafted page and quote", () => {
  const timed = (q, p) => {
    const t0 = performance.now();
    const r = matchQuote(q, p);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `took ${ms} ms`);
    return r;
  };
  const aPage = page("a".repeat(200000));
  // every hit is inside the run of "a", so none is word-bounded: the candidate cap stops it
  assert.equal(timed("a".repeat(2000), aPage).reason, "couldn't check: too many possible placements");
  for (const q of ["b" + "a".repeat(1999), "a".repeat(1999) + "b", "a".repeat(1000) + "b" + "a".repeat(999)]) {
    assert.equal(timed(q, aPage).found, 0);
  }
  const spaced = page("a ".repeat(100000));
  assert.equal(timed("a ".repeat(999) + "a", spaced).found, 1);
  assert.equal(timed("a ".repeat(500) + "b " + "a ".repeat(499), spaced).found, 0);
  assert.equal(timed("a ".repeat(999) + "b", spaced).found, 0);
  // the old crafted placement input
  const big = page("omega " + "word ".repeat(40000));
  assert.equal(timed("word ".repeat(300) + "omega", big).found, 0);
  assert.equal(timed("we ship weekly", page("word ".repeat(40000) + "we ship weekly.")).found, 1);
  // both texts and the attribution form share one candidate cap
  assert.equal(timed("a".repeat(1980) + " - Jane Doe", { readable: aPage.readable, body: "b" + aPage.readable, truncated: false }).reason,
    "couldn't check: too many possible placements");
});

test("readable text first, then the full body", () => {
  assert.deepEqual(matchQuote("cookie banner text", page("article words here", "menu cookie banner text article words here")),
    { found: 1, where: "body", reason: null });
  assert.equal(matchQuote("article words", page("article words here", "menu article words here")).where, "readable");
});

test("not found on a complete page is 0; on a truncated page is null", () => {
  const complete = matchQuote("not on this page", page("some other text", "some other text", false));
  assert.equal(complete.found, 0);
  assert.equal(complete.where, null);
  const cut = matchQuote("not on this page", page("some other text", "some other text", true));
  assert.equal(cut.found, null);
  assert.match(cut.reason, /truncated/);
  // found on a truncated page is still found
  assert.equal(matchQuote("other text", page("some other text", "", true)).found, 1);
});

test("no text to check is null", () => {
  const r = matchQuote("we ship weekly", page("", ""));
  assert.equal(r.found, null);
  assert.ok(r.reason);
  assert.equal(matchQuote("we ship weekly", {}).found, null);
});

test("the saved corpus matches its expectations", () => {
  const { cases } = JSON.parse(fs.readFileSync(new URL("corpus.json", FIX), "utf8"));
  assert.ok(cases.length >= 12);
  assert.ok(cases.filter((c) => c.expect === 0).length >= 4);
  const texts = new Map();
  for (const c of cases) {
    if (!texts.has(c.page)) {
      const raw = fs.readFileSync(new URL(c.page, FIX), "utf8");
      texts.set(c.page, c.page.endsWith(".html")
        ? extractReadable(raw, `https://example.com/${c.page}`)
        : { readable: raw, body: raw });
    }
    const t = texts.get(c.page);
    const r = matchQuote(c.quote, { readable: t.readable, body: t.body, truncated: false });
    assert.equal(r.found, c.expect, `${c.page}: ${JSON.stringify(c.quote)} \u2192 ${JSON.stringify(r)}`);
  }
});
