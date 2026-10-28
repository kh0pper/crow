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
  assert.equal(normalizeForMatch("We ship  “week­ly” — Now"), 'we ship "weekly" - now');
  assert.equal(normalizeForMatch("it’s a ‘test’ … ok"), "it's a 'test' ... ok");
  assert.equal(normalizeForMatch(null), "");
});

test("[sic], numeric and superscript footnote markers are removed", () => {
  assert.equal(normalizeForMatch("growth[12] was strong¹ [sic]"), "growth was strong");
  assert.equal(normalizeForMatch("a claim[citation needed] here[a]"), "a claim here");
});

test("outer quote marks and a trailing attribution are stripped", () => {
  const r = matchQuote("“We ship weekly.” — A. Person, CEO", page("Intro. We ship weekly. More text."));
  assert.deepEqual(r, { found: 1, where: "readable", reason: null });
  assert.equal(matchQuote("'we ship weekly'", page("so we ship weekly today")).found, 1);
  // unquoted quote with a trailing attribution: the fallback candidate cuts it
  assert.equal(matchQuote("We ship weekly now - A. Person", page("they said we ship weekly now.")).found, 1);
});

test("ellipsis pieces match in order, never out of order", () => {
  assert.equal(matchQuote("alpha … gamma", page("alpha beta gamma")).found, 1);
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

test("short ellipsis pieces are ignored; all-short quotes are not checked", () => {
  const r = matchQuote("the … the", page("the cat and the dog"));
  assert.equal(r.found, null);
  assert.match(r.reason, /too short/);
  assert.equal(r.where, null);
  // "we" is ignored, "ship weekly" decides
  assert.equal(matchQuote("we … ship weekly", page("they ship weekly")).found, 1);
  assert.equal(matchQuote("we … ship weekly", page("they ship monthly")).found, 0);
  assert.equal(matchQuote("", page("anything")).found, null);
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
    assert.equal(r.found, c.expect, `${c.page}: ${JSON.stringify(c.quote)} → ${JSON.stringify(r)}`);
  }
});
