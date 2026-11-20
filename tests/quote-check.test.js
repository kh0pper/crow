import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { check, normalise, round4, tokenise } from "../servers/shared/quote-check.js";

const CASES = JSON.parse(readFileSync(new URL("./fixtures/quote-check/cases.json", import.meta.url), "utf8"));

const LIMITS = [
  "A verified quote EXISTS in a source. It does not prove the source SUPPORTS the claim made with it.",
  "Paraphrases are not checked; only quoted passages and citation strings.",
  "The check is only as good as the source text extraction (PDF text layers, OCR).",
  "A citation that exists in a source can still be the wrong citation for the claim.",
];

function compareItems(label, actual, expected) {
  assert.equal(actual.length, expected.length, `${label}.length`);
  expected.forEach((item, i) => {
    for (const [key, value] of Object.entries(item)) {
      if (key === "note") continue;
      assert.deepEqual(actual[i][key], value, `${label}[${i}].${key}`);
    }
  });
}

for (const c of CASES) {
  test(c.name, () => {
    const result = check(c.answer, c.sources, c.opts);
    compareItems("quotes", result.quotes, c.expect.quotes);
    compareItems("citations", result.citations, c.expect.citations);
    assert.deepEqual(result.summary, c.expect.summary);
  });
}

test("result carries quotes, citations, summary, limits in that order", () => {
  const result = check("Nothing quoted here.", [{ id: "s1", text: "Nothing quoted here." }], {});
  assert.deepEqual(Object.keys(result), ["quotes", "citations", "summary", "limits"]);
  assert.deepEqual(result.limits, LIMITS);
});

test("shipped patterns file matches the corpus copy byte for byte", () => {
  const shipped = readFileSync(new URL("../servers/shared/quote-check-patterns.json", import.meta.url));
  const corpus = readFileSync(new URL("./fixtures/quote-check/patterns.json", import.meta.url));
  assert.ok(shipped.equals(corpus));
});

test("normalise joins a hyphenated line break and returns offsets", () => {
  const out = normalise("enroll-\n ment");
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
  assert.equal(out[0], "enrollment");
  assert.ok(Array.isArray(out[1]));
  assert.equal(typeof out[1][0], "number");
});

test("tokenise splits on punctuation and hyphens", () => {
  assert.deepEqual(tokenise("722(g)(3)(a) best-interest"), ["722", "g", "3", "a", "best", "interest"]);
});

test("a ligature in the source matches a quote spelled out", () => {
  const answer = 'The note says "the final rule applies to every district grant program".';
  const sources = [{ id: "s1", text: "The \uFB01nal rule applies to every district grant program.\n" }];
  const result = check(answer, sources, {});
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].status, "verified");
  assert.equal(result.quotes[0].score, 1);
  assert.equal(result.quotes[0].best_match, "The \uFB01nal rule applies to every district grant program");
});

test("an astral character before the quote keeps best_match on the quote", () => {
  const answer = 'The report says "the panel will review each application within thirty days".';
  const sources = [{ id: "s1", text: "\u{1F600} the panel will review each application within thirty days.\n" }];
  const result = check(answer, sources, {});
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].status, "verified");
  assert.equal(result.quotes[0].score, 1);
  assert.equal(result.quotes[0].best_match, "the panel will review each application within thirty days");
});

test("CRLF line endings keep line numbers right", () => {
  const answer = 'It reads "the clerk recorded that the hearing closed at noon on the ninth".';
  const sources = [
    { id: "s1", text: "First line.\r\nSecond line.\r\nThe clerk recorded that the hearing closed at noon on the ninth.\r\nFourth.\r\n" },
  ];
  const result = check(answer, sources, {});
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].status, "verified");
  assert.equal(result.quotes[0].line, 3);
  assert.equal(result.quotes[0].page, 1);
});

const QUOTE_SOURCE = [{ id: "s1", text: "alpha beta gamma delta epsilon zeta eta theta\n" }];

// a candidate quote never crosses a blank line: newline, optional whitespace
// other than a newline, newline
test("a quote may span single line breaks", () => {
  const result = check('It says "alpha beta gamma\ndelta\nepsilon zeta eta theta".', QUOTE_SOURCE, {});
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].status, "verified");
  assert.equal(result.summary.quotes_verified, 1);
});

test("a curly quote may span single line breaks", () => {
  const result = check("It says \u201calpha beta gamma\ndelta\nepsilon zeta eta theta\u201d.", QUOTE_SOURCE, {});
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].status, "verified");
});

const BLANK_LINES = [
  ["spaces", "alpha beta gamma\n  \ndelta epsilon zeta eta theta"],
  ["a tab-only line", "alpha beta gamma\n\t\ndelta epsilon zeta eta theta"],
  ["a carriage-return-only line", "alpha beta gamma\n\r\ndelta epsilon zeta eta theta"],
];

for (const [name, body] of BLANK_LINES) {
  test(`a quote does not cross a blank line of ${name}`, () => {
    const result = check(`It says "${body}".`, QUOTE_SOURCE, {});
    assert.equal(result.quotes.length, 0);
    assert.equal(result.summary.quotes_total, 0);
  });

  test(`a curly quote does not cross a blank line of ${name}`, () => {
    const result = check(`It says \u201c${body}\u201d.`, QUOTE_SOURCE, {});
    assert.equal(result.quotes.length, 0);
    assert.equal(result.summary.quotes_total, 0);
  });
}

test("round4 rounds an exact tie to the even 4th decimal", () => {
  assert.equal(round4(0.15625), 0.1562);
  assert.equal(round4(0.09375), 0.0938);
});

test("round4 rounds the exact binary value, not a scaled approximation", () => {
  // 0.95625 is just above the decimal in binary, so it rounds up
  assert.equal(round4(0.95625), 0.9563);
});

function numberedWords(count) {
  return Array.from({ length: count }, (_, i) => `w${i}`);
}

for (const [positions, expected] of [
  [[0, 20, 40, 60, 80, 100, 120], 0.9563], // d = 7, span 160: 1 - 7/160
  [[0, 15, 30, 45, 60, 75, 90, 105, 120], 0.9437], // d = 9, span 160: 1 - 9/160
]) {
  test(`a 160-token quote with ${positions.length} substituted tokens scores ${expected}`, () => {
    const quote = numberedWords(160);
    const sourceWords = quote.slice();
    for (const pos of positions) sourceWords[pos] = `z${pos}`;
    const answer = `The report says "${quote.join(" ")}".`;
    const result = check(answer, [{ id: "s1", text: `${sourceWords.join(" ")}\n` }], {});
    assert.equal(result.quotes.length, 1);
    assert.equal(result.quotes[0].score, expected);
  });
}

test("a letter before the digits blocks the Unicode word boundary", () => {
  const result = check("A\u00e942 USC \u00a7 1234", [{ id: "s1", text: "42 USC \u00a7 1234\n" }], {});
  assert.equal(result.citations.length, 0);
  assert.equal(result.summary.citations_total, 0);
});

test("a section number written in Arabic-Indic digits is a section citation", () => {
  const result = check("Section \u0663.\u0663.\u0668", [{ id: "s1", text: "3.3.8 Heading\n" }], {});
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].kind, "section");
});

test("a page number written in Arabic-Indic digits is a page citation", () => {
  const source = [{ id: "s1", text: "Cover note.\fCross-reference p. \u0663 here.\fThird page.\fFourth page.\n" }];
  const result = check("See p. \u0663 for the table.", source, {});
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].kind, "page");
  assert.equal(result.citations[0].status, "verified");
  assert.equal(result.citations[0].page, 2);
});

test("a surrogate pair before a section label is read as one code point", () => {
  // U+1E951 is an Adlam digit, so the label sits inside a longer number
  const result = check("SAAH 3.3.8", [{ id: "s1", text: "\u{1E951}3.3.8 Heading\n" }], {});
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].kind, "section");
  assert.equal(result.citations[0].status, "not_found");
});

test("a 33,000-token source matches a 20-token quote quickly", () => {
  let state = 0x9e3779b9;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const words = [];
  for (let i = 0; i < 33000; i++) words.push(`w${next() % 3000}`);
  const text = `${words.join(" ")}\n`;

  const quote = words.slice(15000, 15020);
  quote[4] = "zq1";
  quote[13] = "zq2";
  const answer = `The report says "${quote.join(" ")}".`;

  const started = performance.now();
  const result = check(answer, [{ id: "s1", text }], {});
  const elapsed = performance.now() - started;

  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].status, "verified");
  assert.ok(elapsed < 1000, `elapsed ${elapsed.toFixed(1)} ms`);
});