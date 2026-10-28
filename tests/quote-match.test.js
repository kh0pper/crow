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

test("a spaced ellipsis splits pieces", () => {
  assert.equal(matchQuote("alpha . . . gamma", page("alpha beta gamma")).found, 1);
});

test("combining marks and astral letters count as word characters", () => {
  assert.equal(matchQuote("ship weekly", page("we ship weekly\u0332 report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we \u{10330}ship weekly report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we ship weekly\u{10330} report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we \u{1f600} ship weekly report")).found, 1);
});

test("a bracketed placeholder stands in for a short page span only", () => {
  const near = page("The CEO said that we ship weekly.");
  assert.equal(matchQuote("The CEO said [that] we ship weekly", near).found, 1);
  const pad = "Other business was discussed at length. ".repeat(4); // > 60 chars
  const far = page("The CEO said the review takes a month. " + pad + "Good teams never ship bugs.");
  const r = matchQuote("The CEO said [the company will] never ship bugs", far);
  assert.equal(r.found, null);
  assert.match(r.reason, /far apart/);
  // the spliced words are not on the page at all: 0
  assert.equal(matchQuote("The CEO said [the company will] never ship bugs", page("The CEO said little.")).found, 0);
  // exactly 60 page characters between the pieces is still a match; 61 is not
  const g = (n) => page("start piece " + "x".repeat(n - 2) + " end piece");
  assert.equal(matchQuote("start piece [gap] end piece", g(60)).found, 1);
  assert.equal(matchQuote("start piece [gap] end piece", g(61)).found, null);
});

test("ellipsis pieces may be at most 400 page characters apart", () => {
  const apart = (n) => page("alpha piece " + "y".repeat(n - 2) + " omega piece");
  assert.equal(matchQuote("alpha piece ... omega piece", apart(100)).found, 1);
  assert.equal(matchQuote("alpha piece ... omega piece", apart(400)).found, 1);
  const r = matchQuote("alpha piece ... omega piece", apart(1000));
  assert.equal(r.found, null);
  assert.match(r.reason, /far apart/);
  const pad = "Filler sentence for the gap. ".repeat(40);
  assert.equal(matchQuote("We never ... ship bugs", page("We never met. " + pad + "They ship bugs.")).found, null);
  // a later, closer occurrence is found by backtracking
  assert.equal(matchQuote("alpha piece ... omega piece",
    page("alpha piece " + "z".repeat(1000) + " alpha piece then omega piece")).found, 1);
  // far apart in readable but close in body: the body match wins
  assert.deepEqual(matchQuote("alpha piece ... omega piece",
    { readable: apart(1000).readable, body: "alpha piece and omega piece", truncated: false }),
    { found: 1, where: "body", reason: null });
});

test("[sic] and numeric footnotes still drop without a gap", () => {
  assert.equal(matchQuote("growth[3] was strong", page("growth was strong")).found, 1);
  assert.equal(matchQuote("growth was strong [sic]", page("growth[12] was strong")).found, 1);
  assert.equal(matchQuote("growth [citation needed] was strong", page("growth was strong")).found, 1);
});

test("ellipsis pieces match in order, never out of order", () => {
  assert.equal(matchQuote("alpha \u2026 gamma", page("alpha beta gamma")).found, 1);
  assert.equal(matchQuote("alpha ... gamma", page("alpha beta gamma")).found, 1);
  assert.equal(matchQuote("gamma ... alpha", page("alpha beta gamma")).found, 0);
});

test("bracketed insertion splits like an ellipsis", () => {
  assert.equal(matchQuote("[the company] will ship weekly", page("Acme will ship weekly")).found, 1);
  assert.equal(matchQuote("Acme said [that] it will ship weekly", page("Acme said it will ship weekly")).found, 1);
});

test("a quote's closing punctuation need not match the page's", () => {
  assert.equal(matchQuote("We ship weekly.", page("we ship weekly, and test daily")).found, 1);
});

test("a changed first-letter case still matches", () => {
  assert.equal(matchQuote("Will ship weekly", page("acme will ship weekly")).found, 1);
});

test("pieces match on word boundaries only", () => {
  assert.equal(matchQuote("ship weekly", page("the relationship weekly report")).found, 0);
  assert.equal(matchQuote("ship weekly", page("we ship weekly")).found, 1);
  assert.equal(matchQuote("ship week", page("we ship weekly")).found, 0);
  // a non-boundary hit is skipped and a later boundary hit is accepted
  assert.equal(matchQuote("ship weekly", page("relationship weekly, and we ship weekly")).found, 1);
});

test("short pieces must occur inside their gap; all-short quotes are not checked", () => {
  const r = matchQuote("the \u2026 the", page("the cat and the dog"));
  assert.equal(r.found, null);
  assert.match(r.reason, /too short/);
  assert.equal(r.where, null);
  // a short piece is checked, not ignored
  assert.equal(matchQuote("we \u2026 ship weekly", page("they ship weekly")).found, 0);
  assert.equal(matchQuote("we \u2026 ship weekly", page("we, they say, ship weekly")).found, 1);
  assert.equal(matchQuote("we \u2026 ship weekly", page("they ship monthly")).found, 0);
  assert.equal(matchQuote("", page("anything")).found, null);
});

test("a short piece cannot be slipped in or out (bypass)", () => {
  assert.equal(matchQuote("We will ... not ... raise prices", page("We will raise prices this year.")).found, 0);
  assert.equal(matchQuote("No ... we will raise prices", page("we will raise prices.")).found, 0);
  assert.equal(matchQuote("No ... we will raise prices", page("No, we will raise prices.")).found, 1);
  // a leading short piece must sit within the gap limit before the first long piece
  assert.equal(matchQuote("No ... we will raise prices", page("No. " + "Filler words here. ".repeat(30) + "we will raise prices.")).found, 0);
  // a trailing short piece likewise
  assert.equal(matchQuote("we will raise prices [in] May", page("we will raise prices in May.")).found, 1);
  assert.equal(matchQuote("we will raise prices [by] may", page("we will raise prices soon.")).found, 0);
});

test("a placeholder or omission cannot add or remove a negation", () => {
  const add = matchQuote("We will [not] raise prices", page("We will raise prices."));
  assert.equal(add.found, null);
  assert.equal(add.reason, "couldn't check exactly: a negation was added or left out");
  const neg = page("We will not, this year, raise prices.");
  assert.match(matchQuote("We will ... raise prices", neg).reason, /negation/);
  assert.equal(matchQuote("We will ... raise prices", neg).found, null);
  assert.equal(matchQuote("We will [ ] raise prices", neg).found, null);
  // a word ending in n't counts as a negation
  assert.equal(matchQuote("We [have, this year,] raised prices", page("We haven't, this year, raised prices.")).found, null);
  // a matching negation in the bracket is fine
  assert.equal(matchQuote("We will [not] raise prices", neg).found, 1);
  // a clean occurrence elsewhere on the page still counts
  assert.equal(matchQuote("We will ... raise prices", page("We will not raise prices in May. In June we will finally raise prices.")).found, 1);
  // a leading bracket that adds a negation
  assert.equal(matchQuote("[Never] will we raise prices", page("Will we raise prices?")).found, null);
});

test("a capitalisation bracket keeps its letter", () => {
  assert.equal(matchQuote("[I]t was great", page("It was great.")).found, 1);
  assert.equal(matchQuote("[A]ll staff agreed", page("All staff agreed.")).found, 1);
  assert.equal(normalizeForMatch("[I]t was"), "it was");
  // standalone single-letter brackets are dropped as before
  assert.equal(normalizeForMatch("a claim[a] here"), "a claim here");
});

test("matching is bounded on a crafted page and quote", () => {
  // 200k chars of one repeated word; "omega" occurs only BEFORE them, so no in-order placement
  // exists and a naive backtracking search would try a huge number of them
  const big = page("omega " + "word ".repeat(40000));
  const quote = Array.from({ length: 31 }, () => "word").concat("omega").join(" ... ");
  let t0 = Date.now();
  const r = matchQuote(quote, big);
  let elapsed = Date.now() - t0;
  assert.equal(r.found, null);
  assert.equal(r.reason, "couldn't check: too many possible placements");
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
  // a piece that is not on the page at all fails fast with 0
  t0 = Date.now();
  assert.equal(matchQuote(Array.from({ length: 31 }, () => "word").concat("absent").join(" ... "), big).found, 0);
  elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
  // more than 32 pieces (empty ones between separators count too) is not checked
  assert.equal(matchQuote(Array.from({ length: 33 }, () => "word").join(" ... "), big).reason, "too long to check");
  assert.equal(matchQuote("word " + "... ".repeat(40) + "word", big).reason, "too long to check");
  // a normal quote on a big page still matches
  assert.equal(matchQuote("we ship weekly", page("word ".repeat(40000) + "we ship weekly.")).found, 1);
  assert.equal(matchQuote(Array.from({ length: 32 }, () => "word").join(" ... "), big).found, 1);
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
