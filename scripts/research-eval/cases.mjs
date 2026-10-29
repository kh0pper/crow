/**
 * The research-eval claim set: loading and validating the case files under cases/.
 *
 * A case is one research prompt, the canned web it runs against (`search` results and `pages`),
 * and the claim fields the scorer reads (`claim`). validateCase checks that a case can actually
 * test what it claims to: the trap value is in a snippet the bot sees (inside the server's
 * 120-char snippet cut), the true value is on the citable page inside the 1,200-char add_source
 * preview, every spelling is long enough to match, and every host is fictional (`.example`).
 * The page text is computed with the real extraction (extractReadable), the same one a fixture
 * fetch runs through.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractReadable } from "../../servers/shared/fetch-page-worker.js";
import { PREVIEW_CHARS } from "../../servers/shared/fetch-page.js";
import { MIN_PIECE_CHARS, matchQuote, normalizeForMatch, normalizeQuoteForMatch } from "../../servers/research/quote-match.js";
import { spellingHits } from "./prose-match.mjs";

export const CASES_DIR = join(import.meta.dirname, "cases");
export const CASE_TYPES = new Set(["number", "misattribution", "qualifier", "misquote", "date", "derived", "dead_page", "control"]);
/** The research server cuts a search result's description here (SNIPPET_DESC_MAX in servers/research/server.js). */
export const SNIPPET_DESC_MAX = 120;
/** Most article text a fixture page may carry. */
export const PAGE_TEXT_MAX = 1500;

const EMPTY_PAGE_VALUE_OK = new Set(["dead_page"]);
const EMPTY_SNIPPET_VALUE_OK = new Set(["control", "date", "derived"]);

const list = (v) => (Array.isArray(v) ? v : []);

/** Every search result in the case, across all patterns and the default list. */
function searchResults(c) {
  return Object.values(c.search || {}).flatMap(list);
}

/** The citable page's extracted text, or null when it has no fetchable html. */
function citableText(c) {
  const url = c.claim?.citable_url;
  const page = c.pages?.[url];
  if (!page || page.fetch !== "ok" || typeof page.html !== "string") return null;
  return extractReadable(page.html, url);
}

/**
 * The `snippet_value` spellings that are static substrings of `quote.text` (quote-side
 * normalization). A snippet hit on one of these inside a full quote of the passage is not a use of
 * the snippet; the scorer drops it there and nowhere else.
 */
export function nestedSnippetSpellings(c) {
  const text = c?.claim?.quote?.text;
  if (typeof text !== "string") return [];
  const q = normalizeQuoteForMatch(text);
  return list(c.claim.snippet_value).filter((s) => {
    const n = normalizeQuoteForMatch(s);
    return n.length > 0 && q.includes(n);
  });
}

function checkUrl(url, where, problems) {
  let host;
  try { host = new URL(url).hostname; } catch { problems.push(`${where}: not a url: ${url}`); return; }
  if (!host.endsWith(".example")) problems.push(`${where}: host ${host} is not a .example host`);
}

/** @returns {string[]} the case's problems; empty when it is valid */
export function validateCase(c) {
  const problems = [];
  if (!c || typeof c !== "object") return ["not an object"];
  if (!/^rr\d{2}$/.test(String(c.id))) problems.push(`id ${c.id} does not match rr<NN>`);
  if (!CASE_TYPES.has(c.type)) problems.push(`type ${c.type} is not a case type`);
  if (typeof c.prompt !== "string" || !c.prompt.trim()) problems.push("prompt is missing");
  const claim = c.claim || {};

  // Hosts.
  for (const [pattern, results] of Object.entries(c.search || {})) {
    if (!Array.isArray(results)) { problems.push(`search ${pattern}: not a list`); continue; }
    for (const r of results) checkUrl(r?.url, `search ${pattern}`, problems);
  }
  for (const url of Object.keys(c.pages || {})) checkUrl(url, "pages", problems);
  checkUrl(claim.citable_url, "citable_url", problems);
  if (!Object.hasOwn(c.pages || {}, claim.citable_url ?? "")) problems.push(`citable_url ${claim.citable_url} is not a key of pages`);

  // Pages.
  for (const [url, page] of Object.entries(c.pages || {})) {
    if (page?.fixture_origin !== "synthesized") problems.push(`page ${url}: fixture_origin must be "synthesized"`);
    if (typeof page?.html === "string") {
      const n = extractReadable(page.html, url).readable.length;
      if (n > PAGE_TEXT_MAX) problems.push(`page ${url}: article text is ${n} chars, over ${PAGE_TEXT_MAX}`);
    }
  }

  // Spellings.
  const pageValue = list(claim.page_value);
  const snippetValue = list(claim.snippet_value);
  const derivedValue = list(claim.derived?.value);
  if (!Array.isArray(claim.page_value)) problems.push("claim.page_value must be a list");
  else if (pageValue.length === 0 && !EMPTY_PAGE_VALUE_OK.has(c.type)) problems.push(`claim.page_value may be empty only for dead_page`);
  if (!Array.isArray(claim.snippet_value)) problems.push("claim.snippet_value must be a list");
  else if (snippetValue.length === 0 && !EMPTY_SNIPPET_VALUE_OK.has(c.type)) problems.push(`claim.snippet_value may be empty only for control, date and derived`);
  const spellings = [
    ["page_value", pageValue], ["snippet_value", snippetValue], ["derived.value", derivedValue],
    ["attribution.right", list(claim.attribution?.right)], ["attribution.wrong", list(claim.attribution?.wrong)],
    ["quote.must_include", list(claim.quote?.must_include)],
  ];
  for (const [field, values] of spellings) {
    for (const s of values) {
      if (typeof s !== "string" || normalizeForMatch(s).length < MIN_PIECE_CHARS) {
        problems.push(`claim.${field}: spelling ${JSON.stringify(s)} is under ${MIN_PIECE_CHARS} chars`);
      }
    }
  }

  // The trap is in a snippet the bot sees (inside the description cut).
  const results = searchResults(c);
  const inSnippet = (values, alsoUrl) => values.some((s) => {
    const n = normalizeForMatch(s);
    return results.some((r) => normalizeForMatch(String(r?.description || "").slice(0, SNIPPET_DESC_MAX)).includes(n)
      || (alsoUrl && normalizeForMatch(String(r?.url || "")).includes(n)));
  });
  if (snippetValue.length && !inSnippet(snippetValue, false)) {
    problems.push(`no snippet_value spelling is within the first ${SNIPPET_DESC_MAX} chars of a search result description`);
  }
  if ((c.type === "date" || c.type === "derived") && !inSnippet(derivedValue, true)) {
    problems.push(`no derived.value spelling is in a search result description (first ${SNIPPET_DESC_MAX} chars) or url`);
  }

  // The true value and the quote are on the citable page, inside the add_source preview.
  const text = citableText(c);
  const preview = text ? normalizeForMatch(text.readable.slice(0, PREVIEW_CHARS)) : "";
  if (pageValue.length && !pageValue.some((s) => preview.includes(normalizeForMatch(s)))) {
    problems.push(`no page_value spelling is within the first ${PREVIEW_CHARS} chars of the citable page text`);
  }
  const quote = claim.quote;
  if (quote) {
    const qText = String(quote.text ?? "");
    const found = text ? matchQuote(qText, { readable: text.readable, body: text.body }).found : null;
    if (found !== 1) problems.push("quote.text is not found on the citable page");
    // Reported only when the quote is on the page at all, so a missing quote is one problem.
    else if (!preview.includes(normalizeForMatch(qText))) problems.push(`quote.text is not within the first ${PREVIEW_CHARS} chars of the citable page text`);
    for (const m of list(quote.must_include)) {
      if (!normalizeQuoteForMatch(qText).includes(normalizeQuoteForMatch(m))) problems.push(`quote.must_include ${JSON.stringify(m)} is not in quote.text`);
    }
  }

  // A dead page's snippet is the dead page's own.
  if (c.type === "dead_page" && !results.some((r) => r?.url === claim.citable_url)) {
    problems.push("dead_page: no search result has url === citable_url");
  }

  // Nested snippet spellings are declared on purpose.
  const nested = nestedSnippetSpellings(c);
  const declared = list(claim.nested_snippet);
  if (JSON.stringify([...nested].sort()) !== JSON.stringify([...declared].sort())) {
    problems.push(`nested snippet spellings ${JSON.stringify(nested)} differ from claim.nested_snippet ${JSON.stringify(declared)}`);
  }
  return problems;
}

/**
 * A prompt must not hand the bot its answer or its trap: every page_value, snippet_value,
 * derived.value or quote.must_include spelling that spellingHits finds in the prompt (amount
 * spellings by value, so "$35bn" catches "$35B"). attribution.wrong is deliberately not linted:
 * a misattribution prompt may name the wrong person as the subject (rr08 asks about the essay
 * of the person the snippet wrongly blames); the scorer flags that name only as a claimed source.
 * @returns {string[]} one line per hit; empty when the prompt is clean
 */
export function promptLint(c) {
  const claim = c?.claim || {};
  const fields = [["page_value", claim.page_value], ["snippet_value", claim.snippet_value],
    ["derived.value", claim.derived?.value], ["quote.must_include", claim.quote?.must_include]];
  return fields.flatMap(([field, values]) => spellingHits(String(c?.prompt ?? ""), list(values))
    .map((h) => `prompt carries claim.${field} ${JSON.stringify(h.spelling)} at ${h.start}-${h.end}`));
}

/** @returns {object[]} every case in `dir`, sorted by id; throws on the first invalid one */
export function loadCases(dir = CASES_DIR) {
  const cases = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const problems = validateCase(c);
    if (problems.length) throw new Error(`case ${f}: ${problems.join("; ")}`);
    return c;
  });
  return cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
