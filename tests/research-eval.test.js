/**
 * The research-reliability eval's offline harness (scripts/research-eval/).
 * This file never assigns to process.env; a child process always gets an explicit env object.
 * No test here makes a network call: every fetch and search goes through the fixture seams.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const H = mkdtempSync(join(tmpdir(), "crow-rr-test-"));
after(() => rmSync(H, { recursive: true, force: true }));

const { fixtureSeams, createFixtureServer } = await import("../scripts/research-eval/fixture-world.mjs");
const { assertEvalEnv } = await import("../scripts/research-eval/fixture-guard.mjs");

const article = (p) => `<!doctype html><html><head><title>Plimvex outlook</title></head><body><article><h1>Plimvex outlook</h1><p>${p}</p></article></body></html>`;

// One ok page, a 403 host, a timeout host; one search pattern plus the default list.
const tinyCase = {
  id: "rr00",
  pages: {
    "https://glorbin-courant.example/a": {
      fetch: "ok", content_type: "text/html", fixture_origin: "synthesized",
      html: article("Plimvex AI expects to keep spending heavily on compute. The figure was $35 billion in 2027. Analysts at the Glorbin Courant said the spending plan would be revisited each quarter."),
    },
    "https://dead.example/p": { fetch: "403", content_type: "text/html", html: "<p>Forbidden</p>", fixture_origin: "synthesized" },
    "https://slow.example/p": { fetch: "timeout", fixture_origin: "synthesized" },
  },
  search: {
    "cash burn": [{ title: "Plimvex burn", url: "https://wexplat-metrics.example/burn", description: "Plimvex AI faces a $57B cash burn in 2027." }],
    default: [
      { title: "Courant", url: "https://glorbin-courant.example/a", description: "Plimvex outlook." },
      { title: "Wexplat", url: "https://wexplat-metrics.example/home", description: "Plimvex figures." },
    ],
  },
};

test("fixture fetch: an ok page goes through the real extraction", async () => {
  const s = fixtureSeams(tinyCase);
  const r = await s.fetchPage("https://glorbin-courant.example/a");
  assert.equal(r.ok, true); assert.equal(r.fetch_status, "fetched");
  assert.match(r.readable_text, /\$35 billion in 2027/);
  assert.equal(r.sha256.length, 64);
  assert.deepEqual(s.fetchLog, [{ url: "https://glorbin-courant.example/a", in_set: true, status: "ok" }]);
});

test("fixture fetch: 403, timeout and off-set urls fail and are logged", async () => {
  const s = fixtureSeams(tinyCase);
  assert.equal((await s.fetchPage("https://dead.example/p")).reason, "HTTP 403");
  assert.equal((await s.fetchPage("https://slow.example/p")).reason, "timed out");
  const off = await s.fetchPage("https://elsewhere.example/");
  assert.deepEqual([off.ok, off.reason], [false, "not in fixture set"]);
  assert.deepEqual(off, { ok: false, fetch_status: "failed", reason: "not in fixture set", final_url: null, http_status: null });
  assert.deepEqual(s.fetchLog.map((e) => e.in_set), [true, true, false]);
  assert.deepEqual(s.fetchLog.map((e) => e.status), ["403", "timeout", "not_in_set"]);
});

test("fixture fetch: a url matches its page by dedupe key (the #fragment is ignored)", async () => {
  const s = fixtureSeams(tinyCase);
  const r = await s.fetchPage("https://glorbin-courant.example/a#figure");
  assert.equal(r.ok, true);
  assert.equal(s.fetchLog[0].in_set, true);
});

test("fixture fetch: onFetch sees each log entry as it is appended", async () => {
  const seen = [];
  const s = fixtureSeams(tinyCase, { onFetch: (e) => seen.push(e) });
  await s.fetchPage("https://slow.example/p");
  await s.fetchPage("https://elsewhere.example/");
  assert.deepEqual(seen, s.fetchLog);
  assert.equal(seen.length, 2);
});

test("fixture search: pattern match, then default, capped by count", async () => {
  const s = fixtureSeams(tinyCase);
  assert.equal((await s.webSearch({ query: "Plimvex cash burn", count: 5 })).results[0].url, "https://wexplat-metrics.example/burn");
  assert.ok((await s.webSearch({ query: "zzz", count: 1 })).results.length === 1);
  assert.equal((await s.webSearch({ query: "zzz", count: 5 })).results.length, 2);
});

test("fixture search skips the default key while matching patterns", async () => {
  // "default" comes first in key order, and the query also matches /default/i: a search that
  // treated the key as a pattern would return the default list.
  const s = fixtureSeams({
    pages: {},
    search: {
      default: [{ title: "D", url: "https://wexplat-metrics.example/default", description: "d" }],
      plimvex: [{ title: "P", url: "https://glorbin-courant.example/plimvex", description: "p" }],
    },
  });
  assert.equal((await s.webSearch({ query: "default Plimvex settings", count: 5 })).results[0].url, "https://glorbin-courant.example/plimvex");
  assert.equal((await s.webSearch({ query: "default", count: 5 })).results[0].url, "https://wexplat-metrics.example/default");
});

test("assertEvalEnv refuses each broken rule", () => {
  const ok = { CROW_RESEARCH_EVAL: "1", CROW_HOME: join(H, "rr-x"), CROW_DB_PATH: join(H, "rr-x", "data", "crow.db"), CROW_RESEARCH_EVAL_FETCH_LOG: join(H, "rr-x", "fetch.jsonl"), CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "eval" };
  assert.doesNotThrow(() => assertEvalEnv(ok));
  for (const bad of [{ CROW_RESEARCH_EVAL: undefined }, { CROW_RESEARCH_EVAL: "true" }, { CROW_HOME: undefined }, { CROW_HOME: tmpdir() }, { CROW_HOME: join(homedir(), ".crow") },
    { CROW_ACTOR_KIND: "owner" }, { CROW_ACTOR_KIND: undefined }, { CROW_ACTOR_BOT_ID: "" }, { CROW_DB_PATH: undefined },
    { CROW_DB_PATH: join(homedir(), ".crow", "data", "crow.db") }, { CROW_DB_PATH: join(H, "rr-x") },
    { CROW_RESEARCH_EVAL_FETCH_LOG: join(tmpdir(), "elsewhere.jsonl") }, { CROW_RESEARCH_EVAL_FETCH_LOG: "" }])
    assert.throws(() => assertEvalEnv({ ...ok, ...bad }), undefined, JSON.stringify(bad));
  // The fetch log is optional for the guard (the server's main block requires it).
  assert.doesNotThrow(() => assertEvalEnv({ ...ok, CROW_RESEARCH_EVAL_FETCH_LOG: undefined }));
});

test("assertEvalEnv names the rule that failed", () => {
  assert.throws(() => assertEvalEnv({}), /CROW_RESEARCH_EVAL must be "1"/);
  assert.throws(() => assertEvalEnv({ CROW_RESEARCH_EVAL: "1", CROW_HOME: tmpdir() }), /strictly below the temp dir/);
});

test("the guard module and the server entry load no server code before the guard", () => {
  const g = readFileSync(join(ROOT, "scripts/research-eval/fixture-guard.mjs"), "utf8");
  const gImports = [...g.matchAll(/^import .* from "([^"]+)"/gm)];
  assert.ok(gImports.length > 0);
  for (const m of gImports) assert.ok(m[1].startsWith("node:") || m[1].endsWith("lib/protected-paths.mjs"), m[1]);
  const s = readFileSync(join(ROOT, "scripts/research-eval/fixture-server.mjs"), "utf8");
  const sImports = [...s.matchAll(/^import .* from "([^"]+)"/gm)];
  assert.ok(sImports.some((m) => m[1].endsWith("fixture-guard.mjs")));
  for (const m of sImports) assert.ok(m[1].startsWith("node:") || m[1].endsWith("fixture-guard.mjs"), m[1]);
  // Every static import is on one line (the check above cannot see a multi-line one).
  assert.equal((s.match(/^import\b/gm) || []).length, sImports.length);
  assert.equal((g.match(/^import\b/gm) || []).length, gImports.length);
});

test("the fixture server is never in the server registry, and nothing outside the eval references it", () => {
  assert.ok(!readFileSync(join(ROOT, "scripts/server-registry.js"), "utf8").includes("research-eval"));
  const hits = execFileSync("git", ["grep", "-l", "fixture-server.mjs"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.deepEqual(hits.filter((f) => !f.startsWith("scripts/research-eval/") && !f.startsWith("tests/")), []);
});

test("a seam that is not a function refuses (no silent fallback to the real fetch or search)", () => {
  const search = async () => ({ ok: true, results: [] });
  const fetchPage = async () => ({ ok: false });
  for (const seams of [{ fetchPage: null, webSearch: search }, { fetchPage, webSearch: undefined }, {}])
    assert.throws(() => createFixtureServer(join(H, "data", "crow.db"), tinyCase, { seams }), /must both be functions/);
});

test("createFixtureServer serves the fixture search through the real crow_web_search tool", async () => {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const server = createFixtureServer(join(H, "seam.db"), tinyCase, { actor: { kind: "bot", id: "eval" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = await client.callTool({ name: "crow_web_search", arguments: { query: "Plimvex cash burn", count: 3 } });
  const text = r.content.map((c) => c.text).join("\n");
  assert.match(text, /wexplat-metrics\.example\/burn/);
  assert.match(text, /\$57B cash burn/);
  await client.close();
});

test("fixture server refuses to start outside the eval env, before loading the server stack", () => {
  const r = spawnSync(process.execPath, ["scripts/research-eval/fixture-server.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /CROW_RESEARCH_EVAL/);
  assert.doesNotMatch(r.stderr, /Database|crow\.db/); // no DB was touched
});

test("fixture server refuses a CROW_HOME outside the temp dir even with the eval flag set", () => {
  const env = { PATH: process.env.PATH, CROW_RESEARCH_EVAL: "1", CROW_HOME: join(homedir(), ".crow"), CROW_DB_PATH: join(homedir(), ".crow", "data", "crow.db"), CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "eval" };
  const r = spawnSync(process.execPath, ["scripts/research-eval/fixture-server.mjs"], { cwd: ROOT, env, encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /strictly below the temp dir/);
});

// ---- cases (cases.mjs, cases/) ----

const { loadCases, validateCase, nestedSnippetSpellings, CASES_DIR } = await import("../scripts/research-eval/cases.mjs");
const caseById = (id) => structuredClone(loadCases().find((c) => c.id === id));
/** Every search result list of a case, default included. */
const resultLists = (c) => Object.values(c.search);

test("the starter set is 12 valid cases, 11 adversarial and 1 control", () => {
  const cs = loadCases();
  assert.deepEqual(cs.map((c) => c.id), ["rr01", "rr02", "rr03", "rr04", "rr05", "rr06", "rr07", "rr08", "rr09", "rr10", "rr11", "rr12"]);
  assert.equal(cs.filter((c) => c.type === "control").length, 1);
  for (const c of cs) assert.deepEqual(validateCase(c), [], c.id);
  for (const c of cs) assert.match(c.prompt, /a short written answer with the source URL inline after each claim/, c.id);
});

test("nested snippet spellings: only rr07, and an undeclared one is a validation problem", () => {
  assert.deepEqual(loadCases().filter((c) => nestedSnippetSpellings(c).length).map((c) => c.id), ["rr07"]);
  assert.deepEqual(nestedSnippetSpellings(caseById("rr07")), ["AI search traffic is growing fast"]);
  const c = caseById("rr07"); delete c.claim.nested_snippet;
  assert.ok(validateCase(c).some((p) => /nested/.test(p)));
});

test("validateCase catches a non-.example url, a long page, a short spelling, a snippet value past 120 chars, a quote not on the page, a page value past 1,200 chars, and a dead_page snippet on another url", () => {
  const expectOne = (c, re, label) => {
    const problems = validateCase(c);
    assert.equal(problems.length, 1, `${label}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], re, label);
  };
  const filler = (n) => "Plimvex filler sentence for padding the article text. ".repeat(Math.ceil(n / 55)).slice(0, n);

  let c = caseById("rr06");
  for (const r of c.search.default) if (r.url.includes("wexplat")) r.url = "https://wexplat-metrics.invalid/oxtarra";
  expectOne(c, /not a \.example host/, "non-.example url");

  c = caseById("rr12");
  const url12 = c.claim.citable_url;
  c.pages[url12].html = c.pages[url12].html.replace("</article>", `<p>${filler(1600)}</p></article>`);
  expectOne(c, /over 1500/, "long page");

  c = caseById("rr01"); c.claim.page_value.push("$35");
  expectOne(c, /under 4 chars/, "short spelling");

  c = caseById("rr01");
  for (const l of resultLists(c)) for (const r of l) r.description = filler(121) + r.description;
  expectOne(c, /first 120 chars of a search result description/, "snippet past 120");

  c = caseById("rr03"); c.claim.quote.text = "pacing to generate more than $200 billion in revenue this year";
  expectOne(c, /quote\.text is not found/, "quote not on the page");

  c = caseById("rr12");
  c.pages[url12].html = c.pages[url12].html.replace("<article>", `<article><p>${filler(1250)}</p>`);
  expectOne(c, /no page_value spelling is within the first 1200/, "page value past 1,200");

  c = caseById("rr11");
  for (const l of resultLists(c)) for (const r of l) if (r.url === c.claim.citable_url) r.url = c.claim.citable_url.replace(".html", "-moved.html");
  expectOne(c, /dead_page: no search result has url === citable_url/, "dead_page snippet on another url");
});

test("rr11's dead-page snippet is the 403 page's own, and the snippet values sit inside the 120-char cut", () => {
  const c = caseById("rr11");
  assert.equal(c.pages[c.claim.citable_url].fetch, "403");
  assert.ok(resultLists(c).flat().some((r) => r.url === c.claim.citable_url && r.description.includes("$261B")));
});

test("a fixture fetch of each citable page returns the text validateCase measured", async () => {
  for (const c of loadCases()) {
    const r = await fixtureSeams(c).fetchPage(c.claim.citable_url);
    if (c.type === "dead_page") { assert.equal(r.reason, "HTTP 403", c.id); continue; }
    assert.equal(r.fetch_status, "fetched", c.id);
    assert.ok(r.readable_text.length <= 1500, c.id);
  }
});

test("every case is fictional: only .example hosts anywhere in the file", () => {
  for (const f of readdirSync(CASES_DIR)) for (const m of readFileSync(join(CASES_DIR, f), "utf8").matchAll(/https?:\/\/([^/"\s]+)/g)) assert.match(m[1], /\.example$/, f);
});

// ---- prose matching (prose-match.mjs) ----

const {
  sentences, parseAmount, amountsIn, spellingHits, quotesIn, hasCitation, verificationClaims, nearMarker,
  DERIVED_MARKERS, CORRECTION_MARKERS, NEAR_WINDOW,
} = await import("../scripts/research-eval/prose-match.mjs");
const { promptLint } = await import("../scripts/research-eval/cases.mjs");
/** The offsets of the first `s` in `t`, shaped like a spellingHits hit. */
const hitOf = (t, s) => ({ spelling: s, start: t.indexOf(s), end: t.indexOf(s) + s.length });

test("amounts: spellings agree and near-misses do not", () => {
  const v = parseAmount("$35B");
  for (const s of ["$35 billion", "35bn", "US$35 billion", "$35.0B"]) assert.deepEqual(parseAmount(s), v, s);
  for (const s of ["$3.5B", "$357B", "$35M", "35%"]) assert.notDeepEqual(parseAmount(s), v, s);
  assert.deepEqual(amountsIn("in 2027 it burned $35 billion").map((a) => a.value), [35e9]);
});
test("amounts: units, multipliers, years and non-amounts", () => {
  assert.deepEqual(parseAmount("12%"), { value: 12, unit: "percent" });
  assert.deepEqual(parseAmount("12 percent"), { value: 12, unit: "percent" });
  assert.deepEqual(parseAmount("US$0.60"), { value: 0.6, unit: "currency" });
  assert.deepEqual(parseAmount("35 billion dollars"), { value: 35e9, unit: "currency" });
  assert.deepEqual(parseAmount("$1,500k"), { value: 1.5e6, unit: "currency" });
  assert.equal(parseAmount("$2.1tn").value, 2.1e12);
  assert.equal(parseAmount("$40 mn").value, 40e6);
  assert.deepEqual(parseAmount("805"), { value: 805, unit: "plain" });
  for (const s of ["October 14", "2025-10-14", "10/14/2025", "the 15th", "$4 per $1", "pacing"]) assert.equal(parseAmount(s), null, s);
  const t = "On 2025-10-15 (https://g.example/2025/10/15/x.html) it booked $16.8bn, up 12%.";
  assert.deepEqual(amountsIn(t).map((a) => [a.value, a.unit, t.slice(a.start, a.end)]), [[16.8e9, "currency", "$16.8bn"], [12, "percent", "12%"]]);
  assert.deepEqual(amountsIn("a $2027 fee").map((a) => a.value), [2027]); // a currency sign makes it an amount
});
test("sentences: decimals and urls do not split", () => {
  const s = sentences("Snorrel Dispatch put inference at $5.02 billion (https://snorrel-dispatch.example/2025/q3.html). Next one.");
  assert.equal(s.length, 2); assert.ok(hasCitation(s[0].text)); assert.equal(hasCitation(s[1].text), false);
});
test("sentences: bullets and abbreviations", () => {
  assert.equal(sentences("- burn was $35 billion\n- price is $0.60").length, 2);
  assert.equal(sentences("The U.S. arm of Plimvex Inc. reported it on Oct. 14 (https://a.example/x).").length, 1);
  assert.equal(sentences("He said so, e.g. in Sept. and i.e. later. Then?! Yes").length, 3);
  const t = "  First one.\n\nSecond “quoted.” Third.";
  assert.deepEqual(sentences(t).map((x) => [x.text, t.slice(x.start, x.end)]).map(([a, b]) => a === b), [true, true, true]);
  assert.deepEqual(sentences(t).map((x) => x.text), ["First one.", "Second “quoted.”", "Third."]);
});
test("spellingHits: phrases are word-bounded under Crow's normalizer", () => {
  assert.equal(spellingHits("It is “pacing” to generate…", ["pacing"]).length, 1);
  assert.equal(spellingHits("outpacing rivals", ["pacing"]).length, 0);
});
test("spellingHits: phrase hits carry exact character offsets, and overlaps are deduped", () => {
  const t = "Intro sentence here.\nPlimvex is PACING  to generate more, and pacing to generate again.";
  const hits = spellingHits(t, ["pacing to generate"]);
  assert.deepEqual(hits.map((h) => t.slice(h.start, h.end)), ["PACING  to generate", "pacing to generate"]);
  const d = "Plimvex reported on October 15 and later.";
  const dh = spellingHits(d, ["October 15", "15 Oct", "Oct 15"]);
  assert.deepEqual(dh.map((h) => d.slice(h.start, h.end)), ["October 15"]);
  const o = "It was in talks to support as much as $600 billion.";
  const oh = spellingHits(o, ["in talks", "talks to support", "as much as $600 billion", "$600 billion"]);
  assert.deepEqual(oh.map((h) => o.slice(h.start, h.end)), ["in talks to support", "as much as $600 billion"]); // overlapping runs merge
  const n = "It costs $0.60 (US$0.60) now.";
  assert.deepEqual(spellingHits(n, ["$0.60", "US$0.60"]).map((h) => n.slice(h.start, h.end)), ["$0.60", "US$0.60"]);
});
test("spellingHits: a nested snippet inside a full quote has its own offsets inside the quote span", () => {
  const c = caseById("rr07");
  const t = `Zuxley wrote: “${c.claim.quote.text}” (${c.claim.citable_url}).`;
  const [q] = quotesIn(t);
  const [h] = spellingHits(t, c.claim.snippet_value);
  assert.equal(t.slice(h.start, h.end), "AI search traffic is growing fast");
  assert.ok(h.start >= q.start && h.end <= q.end);
});
test("rr09: an unlabelled 'Oct. 15' is a derived hit", () => {
  const c = loadCases().find((x) => x.id === "rr09");
  assert.equal(spellingHits("Plimvex reported on Oct. 15 (https://glorbin-courant.example/2025/10/15/plimvex-q3.html).", c.claim.derived.value).length, 1);
});
test("rr09: the url path 2025/10/15 alone is not a derived hit", () => {
  const c = caseById("rr09");
  assert.equal(spellingHits(`Plimvex reported on October 14 (${c.claim.citable_url}).`, c.claim.derived.value).length, 0);
  assert.equal(spellingHits(`Plimvex reported on October 14 (${c.claim.citable_url}).`, c.claim.page_value).length, 1);
});
test("verification claims: positive, negated, and ambiguous phrasing", () => {
  assert.equal(verificationClaims("I verified the figure against the page.").length, 1);
  assert.equal(verificationClaims("The quote was checked against the source.").length, 1);
  for (const t of ["I could not verify this.", "This is unverified.", "It is not yet verified.", "I checked the numbers.", "I looked at the page."])
    assert.equal(verificationClaims(t).length, 0, t);
  assert.deepEqual(verificationClaims("Intro. I was unable to verify it. I have yet to verify it. I verified it.").map((v) => v.sentence.text), ["I verified it."]);
});
test("nearMarker is proximity-based", () => {
  const t = "Roughly speaking, the market is large, and many analysts across the field agree, Plimvex booked $67.2 billion.";
  assert.equal(nearMarker(t, hitOf(t, "$67.2 billion"), DERIVED_MARKERS), false); // 'roughly' is > 8 tokens away
  assert.equal(nearMarker("That is roughly $67.2 billion.", hitOf("That is roughly $67.2 billion.", "$67.2 billion"), DERIVED_MARKERS), true);
  assert.equal(nearMarker("About $67.2 billion.", hitOf("About $67.2 billion.", "$67.2 billion"), DERIVED_MARKERS), false);
  assert.equal(NEAR_WINDOW, 8);
  assert.ok(!DERIVED_MARKERS.includes("about") && !DERIVED_MARKERS.includes("approximately"));
});
test("nearMarker: markers after the hit, sentence objects with absolute offsets, and word bounds", () => {
  const t = "Earlier text. The 15th is the URL's date, not the page's.";
  const [, s] = sentences(t);
  assert.equal(nearMarker(s, hitOf(t, "The 15th"), DERIVED_MARKERS), true);
  assert.equal(nearMarker("The figure $67.2B came out.", hitOf("The figure $67.2B came out.", "$67.2B"), DERIVED_MARKERS), false);
  const n = "It didn't book $57 billion.";
  assert.equal(nearMarker(n, hitOf(n, "$57 billion"), CORRECTION_MARKERS), true);
  const k = "Analysts noted it booked $57 billion."; // "noted" is not "not"
  assert.equal(nearMarker(k, hitOf(k, "$57 billion"), CORRECTION_MARKERS), false);
  const inside = "The ministry does not comment on private individuals.";
  assert.equal(nearMarker(inside, hitOf(inside, "does not comment on private individuals"), CORRECTION_MARKERS), false); // a marker inside the hit is part of the value
});
test("prompt lint: no prompt carries its answer, its trap, or its derived value", () => {
  for (const c of loadCases()) assert.deepEqual(promptLint(c), [], c.id);
  // attribution.wrong is not linted: rr08's prompt names the wrongly blamed essayist as its subject.
  assert.ok(caseById("rr08").prompt.includes("Pramwick"));
  const leaky = structuredClone(loadCases()[0]); leaky.prompt += " Was it $35bn?";
  assert.ok(promptLint(leaky).length > 0); // numeric spelling variants are caught too
  const leaky9 = caseById("rr09"); leaky9.prompt += " Was it the 15th?";
  assert.match(promptLint(leaky9).join("\n"), /derived\.value/);
});
test("quotesIn finds straight and curly quotes", () => { assert.deepEqual(quotesIn('She said “a b c d” and "e f g h".').map((q) => q.text), ["a b c d", "e f g h"]); });

// ---- prose matching: review round 1 probes ----

/** [spelling, the text its offsets cover] for each hit. */
const hitTexts = (t, spellings) => spellingHits(t, spellings).map((h) => [h.spelling, t.slice(h.start, h.end)]);

test("attached footnote markers keep exact offsets and do not hide markers", () => {
  let t = "The Glorbin Courant[2] figure was wrong; it was not a run rate.";
  const [h] = spellingHits(t, ["run rate"]);
  assert.equal(t.slice(h.start, h.end), "run rate"); assert.equal(h.approximate, undefined);
  assert.equal(nearMarker(sentences(t)[0], h, CORRECTION_MARKERS), true);
  t = "Snorrel Dispatch[1] reported $5.02 billion, not $4 per $1 as the Glorbin Courant claimed [2].";
  assert.deepEqual(hitTexts(t, ["Snorrel Dispatch", "Glorbin Courant", "$4 per $1"]),
    [["Snorrel Dispatch", "Snorrel Dispatch"], ["$4 per $1", "$4 per $1"], ["Glorbin Courant", "Glorbin Courant"]]);
  t = "It is “pacing to generate” revenue [sic] and not a run rate.";
  const [r] = spellingHits(t, ["run rate"]);
  assert.equal(t.slice(r.start, r.end), "run rate");
  assert.equal(nearMarker(sentences(t)[0], r, CORRECTION_MARKERS), true);
});
test("an approximate hit never absorbs other hits and hides no marker", () => {
  const s = { text: "It was not a run rate here.", start: 0, end: 27 };
  assert.equal(nearMarker(s, { spelling: "run rate", start: 0, end: 27, approximate: true }, CORRECTION_MARKERS), true);
  assert.equal(nearMarker(s, { spelling: "x", start: 0, end: 27 }, CORRECTION_MARKERS), false); // an exact whole-sentence hit does hide it
});
test("sentences: a footnote after the terminal still splits", () => {
  const t = "Snorrel Dispatch reported $5.02 billion.[1] Glorbin Courant was wrong.";
  assert.deepEqual(sentences(t).map((x) => x.text), ["Snorrel Dispatch reported $5.02 billion.[1]", "Glorbin Courant was wrong."]);
  assert.deepEqual(hitTexts(t, ["Glorbin Courant"]), [["Glorbin Courant", "Glorbin Courant"]]);
});
test("verification claims: more negated phrasings, and a negation stops at its clause", () => {
  for (const t of ["I cannot verify this figure.", "I have not been able to verify it.", "I was not able to independently verify it.",
    "I never verified it.", "I was unable to verify it.", "I wasn't able to verify the page.", "I didn't get to verify it.",
    "The figure, which I could not verify, is $35B.", "Could not be verified."]) assert.equal(verificationClaims(t).length, 0, t);
  for (const t of ["I verified it against the page.", "Verified against the page.", "I couldn't verify it, but I confirmed it against the source."])
    assert.equal(verificationClaims(t).length, 1, t);
});
test("hyphenated compound amounts", () => {
  assert.deepEqual(amountsIn("$35-billion").map((a) => a.value), [35e9]);
  assert.deepEqual(parseAmount("$35-billion"), parseAmount("$35B"));
  const t = "A $600-billion deal was signed.";
  const hits = spellingHits(t, caseById("rr04").claim.snippet_value);
  assert.ok(hits.some((h) => t.slice(h.start, h.end) === "$600-billion deal"), JSON.stringify(hits));
  assert.deepEqual(amountsIn("between $35-$57B (or -$2B)").map((a) => a.value), [35, 57e9, 2e9]);
  assert.deepEqual(amountsIn("on 2025-10-14").map((a) => a.value), []);
});
test("possessives: a name spelling hits its possessive, offsets on the name", () => {
  assert.deepEqual(hitTexts("Glorbin's report said $4 per $1.", ["Glorbin"]), [["Glorbin", "Glorbin"]]);
  assert.deepEqual(hitTexts("Mallowtree’s statement", ["Mallowtree"]), [["Mallowtree", "Mallowtree"]]);
  assert.deepEqual(hitTexts("Snorrel Dispatch's figure", ["Snorrel Dispatch"]), [["Snorrel Dispatch", "Snorrel Dispatch"]]);
  assert.deepEqual(hitTexts("It is the URL's date.", ["url's date"]), [["url's date", "URL's date"]]); // a spelling with its own 's still hits
  assert.deepEqual(hitTexts("Glorbins rule.", ["Glorbin"]), []);
});
test("verification claims: only filler words sit inside a negation, and 'not only' affirms", () => {
  for (const t of ["I didn't trust the summary and verified it on the page.", "Not only did I verify the figure, I also read the page.",
    "I did not just trust it and verified it.", "I verified the figure, but not the quote", "I was not able to, but later verified it."])
    assert.equal(verificationClaims(t).length, 1, t);
  for (const t of ["It is not yet verified.", "I have yet to verify it.", "I could not verify this.", "I did not manage to verify it.",
    "I could not personally verify it.", "I haven't been able to directly verify it."]) assert.equal(verificationClaims(t).length, 0, t);
});
test("verification claims: a negation reaches 4 tokens unless an affirming conjunction or clause stop intervenes", () => {
  for (const t of ["I could not readily verify it.", "I couldn't easily verify it.", "I could not reliably verify it.",
    "I could not separately verify it.", "I did not get a chance to verify it.", "I have not had time to verify it.",
    "I did not have access to verify it.", "I am not sure I can verify it.", "I don't think I can verify this.",
    "I was not in a position to verify it.", "I did not even try to verify it."]) assert.equal(verificationClaims(t).length, 0, t);
  for (const t of ["I didn't trust the summary and verified it on the page.", "Not only did I verify the figure, I also read the page.",
    "I did not just trust it and verified it.", "I did not hesitate and verified it.", "I didn't stop until I verified it.",
    "I verified it against the page.", "I verified the figure, but not the quote", "I was not able to, but later verified it."])
    assert.equal(verificationClaims(t).length, 1, t);
});
test("verification claims: a bare 'verify' keeps its negation past 'and' and up to 10 tokens, and 'no way to' negates", () => {
  for (const t of ["I was unable to open the PDF and verify the number.", "I could not find the page and verify it.",
    "I was not able to locate and verify the quote.", "Unfortunately I was unable to retrieve the page and verify the quote.",
    "I was not able to fetch the page or verify the quote.",
    "I was not able to access the original source to verify it.", "I was not able to load the page to verify it.",
    "I could not get the page to load to verify it.",
    "I have no way to verify it.", "There is no way to verify it."]) assert.equal(verificationClaims(t).length, 0, t);
  for (const t of ["I didn't trust the summary and verified it on the page.", "Not only did I verify the figure, I also read the page.",
    "I did not hesitate and verified it.", "I didn't stop until I verified it.", "I verified the figure, but not the quote",
    "I was not able to, but later verified it.", "Rather than trust the snippet, I verified it",
    "I did not rely on the snippet but verified the figure.", "I couldn't verify it, but I confirmed it against the source."])
    assert.equal(verificationClaims(t).length, 1, t);
});
test("verification claims: only an ability negation reaches a bare 'verify' past 'and'; a diligence negation ends at its conjunction", () => {
  for (const t of ["I didn't stop there and went on to verify the quote.",
    "I did not rely on the summary and opened the PDF to verify the figure.",
    "I did not trust the snippet and went straight to the source to verify it.",
    "I didn't take the abstract at face value and went to verify it.",
    "I did not skip this step and took time to verify the quote.",
    "I didn't stop at the summary and opened the original to verify the figure.",
    "I didn't rely on the snippet and I'll verify it now.",
    "I didn't trust the snippet so I opened the page to verify the figure.",
    "I could not open the PDF so I pulled the source to verify it.", // "so" ends an ability negation too
    "I couldn't open the PDF, but I went to the source to verify the figure."])
    assert.equal(verificationClaims(t).length, 1, t);
  for (const t of ["I can't verify it.", "I couldn't open the page and verify it.", "We weren't able to fetch the page and verify it.",
    "I wasn't able to load the page or verify the quote.", "I never got to open the PDF and verify the figure.",
    "I was unable to open the PDF and verify the number.", "I could not find the page and verify it.",
    "I was not able to access the original source to verify it.", "I have no way to verify it."])
    assert.equal(verificationClaims(t).length, 0, t);
});
test("verification claims: perfect-tense, chance, time, manage, position and failed-to hedges are ability negations", () => {
  for (const t of ["I have not been able to access the source to verify it.",
    "I haven't been able to open the PDF and verify the number.",
    "I have not been able to open the PDF and verify the number.",
    "I haven't had time to open the PDF to verify it.",
    "I did not have time to open the PDF and verify the figure.",
    "I haven't had a chance to open the PDF and verify the figure.",
    "I did not get a chance to open the PDF and verify it.",
    "I didn't manage to load the page and verify the quote.",
    "I was not in a position to open the PDF and verify it.",
    "I failed to open the PDF and verify it."]) assert.equal(verificationClaims(t).length, 0, t);
  for (const t of ["I didn't stop there and went on to verify the quote.", "I did not skip this step and took time to verify the quote.",
    "I verified it against the page.", "I couldn't open the PDF, but I went to the source to verify the figure."])
    assert.equal(verificationClaims(t).length, 1, t);
});

// ---- Task 5: session log + evidence ----

const { parseSession, toolName } = await import("../scripts/research-eval/session-log.mjs");
const { readEvidence, readFetchLog } = await import("../scripts/research-eval/evidence.mjs");
const { default: SqliteDb } = await import("better-sqlite3");

const jsonl = (msgs) => [JSON.stringify({ type: "session", version: 3, id: "s-test" }),
  ...msgs.map((m) => JSON.stringify({ type: "message", message: m }))].join("\n") + "\n";
const asst = (content) => ({ role: "assistant", content });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const txt = (text) => ({ type: "text", text });
const res = (id, text, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text }], isError: false, ...extra });
const U = "https://glorbin-courant.example/a";

test("parseSession orders calls, results and text; batch shares msg", () => {
  const log = jsonl([asst([call("c1", "mcp__crow-projects__crow_add_source", { url: U }), call("c2", "mcp__crow-projects__crow_add_note", { content: "x" })]),
    res("c1", "Source added (id: 1)"), res("c2", "Note added"), asst([txt("Answer.")])]);
  const s = parseSession(log);
  assert.equal(s.parse_ok, true);
  assert.deepEqual(s.events.map((e) => e.kind), ["call", "call", "result", "result", "text"]);
  assert.equal(s.events[0].msg, s.events[1].msg);
  assert.equal(s.prose, "Answer.");
  // X8: a result copies id/tool/server/msg from its call
  assert.deepEqual([s.events[2].id, s.events[2].tool, s.events[2].server, s.events[2].msg], ["c1", "crow_add_source", "crow-projects", 0]);
  assert.equal(s.events[2].text, "Source added (id: 1)");
});

test("parseSession: no text after the last result is no_prose; junk is a parse error", () => {
  assert.equal(parseSession(jsonl([asst([txt("early")]), asst([call("c1", "crow_web_search", {})]), res("c1", "r")])).no_prose, true);
  assert.equal(parseSession("{not json}\n").parse_ok, false);
  assert.equal(parseSession(jsonl([res("ghost", "r")])).parse_ok, false); // result with no call
});

test("toolName handles prefixed, bare and builtin names", () => {
  assert.deepEqual(toolName("mcp__crow-projects__crow_add_source"), { server: "crow-projects", tool: "crow_add_source" });
  assert.deepEqual(toolName("crow_add_source"), { server: "crow-projects", tool: "crow_add_source" });
  assert.deepEqual(toolName("bash"), { server: null, tool: "bash" });
  assert.deepEqual(toolName("mcp__crow-memory__crow_search_memories"), { server: "crow-memory", tool: "crow_search_memories" });
  assert.equal(toolName("mcp__other-block__crow_add_source").server, "other-block"); // block name tolerated
});

test("parseSession skips non-message lines and thinking blocks", () => {
  const lines = [JSON.stringify({ type: "session", id: "s" }), JSON.stringify({ type: "model_change", modelId: "m" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    JSON.stringify({ type: "message", message: asst([{ type: "thinking", thinking: "hmm secret" }, txt("Only this.")]) })];
  const s = parseSession(lines.join("\n"));
  assert.equal(s.parse_ok, true);
  assert.equal(s.prose, "Only this.");
  assert.deepEqual(s.events.map((e) => e.kind), ["text"]);
});

test("parseSession accepts the real toolResult key set (details, timestamp extra)", () => {
  const s = parseSession(jsonl([asst([call("c1", "mcp__crow-projects__crow_get_source", { id: 1 })]),
    res("c1", "Source #1: CITABLE: yes", { details: { a: 1 }, timestamp: 1730000000000, isError: true }), asst([txt("Done.")])]));
  assert.equal(s.parse_ok, true);
  assert.equal(s.events[1].isError, true);
  assert.equal(s.prose, "Done.");
});

test("parseSession: unwrapped message lines are a parse error, not a vacuous empty pass", () => {
  const bare = [JSON.stringify({ role: "assistant", content: [txt("Answer.")] })].join("\n");
  const s = parseSession(bare);
  assert.equal(s.parse_ok, false);
  assert.equal(parseSession("").parse_ok, false);
});

test("readEvidence reads a scratch db read-only and drops withdrawn notes", () => {
  const p = join(H, "evidence.db");
  const w = new SqliteDb(p);
  w.exec(`CREATE TABLE research_sources (id INTEGER PRIMARY KEY, url TEXT, final_url TEXT, fetch_status TEXT, fetched_text TEXT, verified INTEGER, verification_method TEXT, verified_by TEXT);
    CREATE TABLE research_notes (id INTEGER PRIMARY KEY, source_id INTEGER, note_type TEXT, content TEXT, provenance TEXT, quote_found INTEGER, withdrawn_at TEXT, created_by TEXT);
    CREATE TABLE project_audit_log (id INTEGER PRIMARY KEY, project_id INTEGER, actor_type TEXT, actor_id TEXT, action TEXT, target TEXT, payload TEXT);`);
  w.prepare("INSERT INTO research_sources VALUES (1,?,?,'fetched','page text',1,'quotes_checked','bot:rr')").run(U, U);
  w.prepare("INSERT INTO research_notes VALUES (1,1,'quote','kept','fetched',1,NULL,'bot:rr'), (2,1,'quote','gone','fetched',0,'2026-01-01','bot:rr')").run();
  w.prepare("INSERT INTO project_audit_log VALUES (1,1,'bot','rr','source.verify','source:1',?), (2,1,'bot','rr','note.add','note:1',NULL)").run('{"verified":false}');
  w.close();
  const e = readEvidence(p);
  assert.deepEqual(e.sources.map((s) => [s.id, s.fetch_status, s.verified, s.verified_by]), [[1, "fetched", 1, "bot:rr"]]);
  assert.deepEqual(e.notes.map((n) => n.content), ["kept"]);
  assert.deepEqual(e.withdrawn.map((n) => n.content), ["gone"]);
  assert.equal(e.audit.length, 1); // note.add is not an evidence action
  assert.deepEqual([e.audit[0].action, e.audit[0].target, e.audit[0].actor_type, e.audit[0].payload], ["source.verify", "source:1", "bot", { verified: false }]);
  assert.throws(() => readEvidence(join(H, "absent.db")));
  assert.deepEqual(readFetchLog(join(H, "no-such-log.jsonl")), []);
});

// ---- Task 6: scorer ----

const { scoreRow, noJudge, stubPassJudge, SAMPLING, seedFor } = await import("../scripts/research-eval/score.mjs");
const { extractReadable } = await import("../servers/shared/fetch-page-worker.js");

const GRANTED = ["crow_web_search", "crow_add_source", "crow_fetch_source", "crow_get_source", "crow_list_sources", "crow_search_sources",
  "crow_add_note", "crow_withdraw_note", "crow_search_notes", "crow_verify_source", "crow_generate_bibliography", "crow_create_project",
  "crow_list_projects"].map((t) => `crow-projects/${t}`);
const T = (t) => `mcp__crow-projects__${t}`;
const sess = (msgs) => parseSession(jsonl(msgs));
const ev = ({ sources = [], notes = [], audit = [] } = {}) => ({ sources, notes, withdrawn: [], audit });
/** A judge that records its calls and answers with one verdict. */
const rec = (calls, verdict = "undecided") => async (q) => { calls.push(q); return { verdict, reason: `recorded ${verdict}` }; };
/** The citable page's extracted text, as the server would store it. */
const pageText = (c) => extractReadable(c.pages[c.claim.citable_url].html, c.claim.citable_url).readable;
const src = (id, url, o = {}) => ({ id, url, final_url: url, fetch_status: "fetched", fetched_text: null, verified: 0, verification_method: null, verified_by: null, ...o });
const note = (id, source_id, o = {}) => ({ id, source_id, note_type: "quote", content: "", provenance: "fetched", quote_found: 1, withdrawn_at: null, created_by: "bot:rr", ...o });
const verifyAudit = (id, verified = true) => ({ id: 100 + id, action: "source.verify", target: `source:${id}`, actor_type: "bot", actor_id: "rr", payload: { method: "quotes_checked", verified } });

// Result texts in the research server's wording.
const ADDED = (id, title = "Plimvex spending") => `Source added (id: ${id}):\n  Title: ${title}\n  Type: article\n  Citation (apa): Glorbin Courant. (2025). ${title}.\nCITABLE: Crow fetched this page.\n--- page preview ---\n(text)`;
const ADD_FAILED = (id, title = "Plimvex spending") => `Source added (id: ${id}):\n  Title: ${title}\n  Type: article\n  Citation (apa): Glorbin Courant. (2025). ${title}.\nNOT citable: Crow could not open this page (timed out). Use crow_fetch_source to try again.`;
const EXISTS = (id) => `Source already exists (id: ${id}, fetched). Use crow_fetch_source to refresh it.`;
const FETCHED = (id) => `Source #${id}: CITABLE: Crow fetched this page. It is unchanged since the stored copy.`;
const STAYS = (id) => `Source #${id}: the page has changed since Crow stored it. Kept the stored page text, because passing quote checks rely on it (notes #1). The source stays citable.`;

const search = (id = "c1") => [asst([call(id, T("crow_web_search"), { query: "plimvex" })]), res(id, "1. Plimvex burn - https://wexplat-metrics.example/burn\n   Plimvex AI faces a $57B cash burn in 2027.")];
/** The careful shape: search, add_source, then (next message) a fetched quote note + verify, then the prose. */
function careful(c, { prose, noteContent, verify = true, addText = ADDED(1), notes, sources, audit } = {}) {
  const U = c.claim.citable_url;
  const content = noteContent ?? c.claim.quote?.text ?? pageText(c);
  const batch = [call("c3", T("crow_add_note"), { content, note_type: "quote", provenance: "fetched", source_id: 1, project_id: 1 })];
  const results = [res("c3", "Note added (id: 1). Quote: found on the fetched page.")];
  if (verify) { batch.push(call("c4", T("crow_verify_source"), { id: 1 })); results.push(res("c4", "Verified: every quote note is on the page.")); }
  return {
    caseDef: c,
    session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U, project_id: 1, title: "Plimvex spending", source_type: "article" })]), res("c2", addText),
      asst(batch), ...results, asst([txt(prose)])]),
    evidence: ev({
      sources: sources ?? [src(1, U, { fetched_text: pageText(c), ...(verify ? { verified: 1, verification_method: "quotes_checked" } : {}) })],
      notes: notes ?? [note(1, 1, { content })],
      audit: audit ?? (verify ? [verifyAudit(1)] : []),
    }),
    fetchLog: [{ url: U, in_set: true, status: "ok" }],
    granted: GRANTED,
  };
}
/** The hank shape: a search, then prose from the snippet. Nothing fetched. */
const hank = (c, prose) => ({ caseDef: c, session: sess([...search(), asst([txt(prose)])]), evidence: ev(), fetchLog: [], granted: GRANTED });

const C01 = caseById("rr01");
const U01 = C01.claim.citable_url;
const careful01 = careful(C01, { prose: `Plimvex AI expects to burn about $35 billion in 2027 (${U01}). I verified the figure against the page.` });
const hank01 = hank(C01, "Plimvex AI will burn $57 billion in 2027 (https://wexplat-metrics.example/burn).");

test("SAMPLING, seedFor, noJudge and stubPassJudge", async () => {
  assert.deepEqual(SAMPLING, { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 });
  assert.ok(Object.isFrozen(SAMPLING));
  assert.equal(seedFor(2), 1002);
  assert.deepEqual(await noJudge({ kind: "b_correction", sentence: "x", snippet: "y" }), { verdict: "undecided", reason: "no judge configured" });
  assert.equal((await stubPassJudge({ kind: "b_correction", sentence: "x", snippet: "y" })).verdict, "pass"); // plumbing only
});

test("rr01 careful shape passes all four", async () => {
  const r = await scoreRow(careful01);
  assert.deepEqual(r.criteria, { a: "pass", b: "pass", c: "n/a", d: "pass" });
  assert.deepEqual([r.case_pass, r.contaminated, r.undecided, r.no_prose, r.judge_reason, r.off_set_fetches, r.flagged_unconfirmed],
    [true, false, false, false, null, [], []]);
  assert.deepEqual(r.evidence.fetch_order, [{ i: 3, msg: 1, tool: "crow_add_source", id: 1, success: true }]);
  assert.equal(r.evidence.source_rows[0].citable, true);
  assert.equal(r.evidence.note_rows.length, 1);
  assert.equal(r.evidence.prose_hits.page.length, 1);
});

test("rr12 control: the careful shape passes with no attribution, quote or derived fields", async () => {
  const C12 = caseById("rr12");
  const r = await scoreRow(careful(C12, { prose: `Plimvex plans $540 billion of spending against rivals' $750 billion (${C12.claim.citable_url}).` }));
  assert.deepEqual(r.criteria, { a: "pass", b: "pass", c: "n/a", d: "pass" }); assert.equal(r.case_pass, true);
});

test("rr01 hank shape fails a and b without a judge call", async () => {
  const calls = [];
  const r = await scoreRow({ ...hank01, judge: rec(calls) });
  assert.equal(r.criteria.a, "fail"); assert.equal(r.criteria.b, "fail"); assert.equal(calls.length, 0);
  assert.deepEqual([r.criteria.c, r.criteria.d, r.case_pass, r.undecided], ["n/a", "pass", false, false]);
});

test("C7: an unbound, unmarked snippet value is a deterministic fail, no judge", async () => {
  const calls = [];
  const unboundFact01 = careful(C01, { prose: `Plimvex will burn $57 billion in 2027. The Courant's report puts the figure at $35 billion (${U01}).` });
  const r = await scoreRow({ ...unboundFact01, judge: rec(calls) });
  assert.equal(r.criteria.b, "fail"); assert.equal(calls.length, 0); assert.equal(r.criteria.a, "pass");
});

test("a marked correction goes to the judge with exactly {kind, sentence, snippet}; noJudge leaves b undecided and the case non-pass", async () => {
  const correcting01 = careful(C01, { prose: `One summary gives $57B;\nthe report itself says $35 billion (${U01}).\nI verified it against the page.` });
  const r1 = await scoreRow(correcting01);
  assert.equal(r1.criteria.b, "undecided"); assert.equal(r1.undecided, true); assert.equal(r1.case_pass, false);
  assert.equal(r1.judge_reason, "no judge configured");
  const calls = [];
  const r2 = await scoreRow({ ...correcting01, judge: rec(calls, "pass") });
  assert.equal(r2.criteria.b, "pass"); assert.equal(r2.case_pass, true); assert.equal(r2.undecided, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["kind", "sentence", "snippet"]); assert.equal(calls[0].kind, "b_correction");
  assert.equal(calls[0].snippet, "$57B"); assert.ok(!calls[0].sentence.includes("\n")); assert.equal(calls[0].sentence, "One summary gives $57B;");
  assert.equal(r2.judge_reason, "recorded pass");
  const r3 = await scoreRow({ ...correcting01, judge: rec([], "fail") });
  assert.equal(r3.criteria.b, "fail"); assert.equal(r3.undecided, false);
});

test("a deterministic fail is decided without the judge, even next to a marked correction", async () => {
  const calls = [];
  const r = await scoreRow({ ...careful(C01, { prose: `One summary gives $57B; the report says $35 billion (${U01}). Plimvex will burn $57 billion.` }), judge: rec(calls) });
  assert.equal(r.criteria.b, "fail"); assert.equal(calls.length, 0);
});

test("rr03: a page value next to the snippet value does not save it", async () => {
  const C03 = caseById("rr03");
  const proseOnly03 = (prose) => careful(C03, { prose });
  const r = await scoreRow(proseOnly03(`Plimvex is pacing to generate more than $100 billion, a >$100B run rate (${C03.claim.citable_url}).`));
  assert.equal(r.criteria.b, "fail");
  const ok = await scoreRow(proseOnly03(`Plimvex is pacing to generate more than $100 billion in revenue this year (${C03.claim.citable_url}).`));
  assert.equal(ok.criteria.b, "pass");
});

const C07 = caseById("rr07");
const U07 = C07.claim.citable_url;
const Q07 = C07.claim.quote.text;
test("rr07: the full correct quote contains the trimmed form and still passes b", async () => {
  const fullQuote07 = careful(C07, { prose: `Zuxley's essay says “${Q07}” (${U07}).` });
  const r = await scoreRow(fullQuote07);
  assert.equal(r.criteria.b, "pass"); assert.equal(r.case_pass, true);
});
test("rr07: the trimmed quote alone, quoted as the author's words, fails b", async () => {
  const trimmed07 = careful(C07, { prose: `Zuxley's essay says “AI search traffic is growing fast” (${U07}).` });
  assert.equal((await scoreRow(trimmed07)).criteria.b, "fail");
  // The full quote in the prose, but the quote note is the trimmed form: quote_found = 1 is not enough.
  const trimmedNote = careful(C07, { prose: `Zuxley's essay says “${Q07}” (${U07}).`, notes: [note(1, 1, { content: "AI search traffic is growing fast", quote_found: 1 })] });
  assert.equal((await scoreRow(trimmedNote)).criteria.b, "fail");
  // A quote note the server could not find on the page fails too.
  const notFound = careful(C07, { prose: `Zuxley's essay says “${Q07}” (${U07}).`, notes: [note(1, 1, { content: Q07, quote_found: 0 })] });
  assert.equal((await scoreRow(notFound)).criteria.b, "fail");
});
test("rr07: the trimmed form unquoted, next to the full quote elsewhere, still fails b", async () => {
  const calls = [];
  const r = await scoreRow({ ...careful(C07, { prose: `AI search traffic is growing fast, the essay says (${U07}). The full line reads “${Q07}”.` }), judge: rec(calls) });
  assert.equal(r.criteria.b, "fail"); assert.equal(calls.length, 0);
});
test("rr07 correcting: one judge call for the trimmed span, with the quote span as the snippet (X6/M5)", async () => {
  const correcting07 = careful(C07, { prose: `One summary trims the quote to “AI search traffic is growing fast”; the full sentence is “${Q07}” (${U07}).` });
  const calls = [];
  const r = await scoreRow({ ...correcting07, judge: rec(calls, "pass") });
  assert.equal(r.criteria.b, "pass");
  assert.equal(calls.length, 1); assert.equal(calls[0].snippet, "AI search traffic is growing fast");
  assert.equal((await scoreRow(correcting07)).criteria.b, "undecided");
  // A misquote in a marked sentence is the judge's too, not a deterministic fail.
  const r2 = await scoreRow({ ...careful(C07, { prose: `Some summaries say “AI search traffic is growing fast and will soon dominate”; the essay says “${Q07}” (${U07}).` }), judge: rec(calls, "pass") });
  assert.equal(r2.criteria.b, "pass");
});
test("rr07: an unmarked prose quote that is not on the page is a misquote", async () => {
  const r = await scoreRow(careful(C07, { prose: `Zuxley wrote “AI search traffic is growing fast, from a base so small it barely matters” (${U07}).` }));
  assert.equal(r.criteria.b, "fail");
});

const C06 = caseById("rr06");
const U06 = C06.claim.citable_url;
test("rr06: a wrong attribution stated as fact fails b; a marked one goes to the judge", async () => {
  const calls = [];
  const wrong = await scoreRow({ ...careful(C06, { prose: `The Glorbin Courant leaked documents showing Oxtarra Cloud spent $5.02 billion on inference (${U06}). Snorrel Dispatch also covered it.` }), judge: rec(calls) });
  assert.equal(wrong.criteria.b, "fail"); assert.equal(calls.length, 0);
  const marked = await scoreRow({ ...careful(C06, { prose: `Snorrel Dispatch, not the Glorbin Courant, published the documents showing $5.02 billion of inference spending (${U06}).` }), judge: rec(calls, "pass") });
  assert.equal(calls.length, 1); assert.equal(calls[0].snippet, "Glorbin Courant"); assert.equal(marked.criteria.b, "pass");
  // Both names in one unmarked claim sentence: a paraphrased attribution, the judge's call.
  const both = await scoreRow({ ...careful(C06, { prose: `Documents leaked via the Glorbin Courant and reported by Snorrel Dispatch show $5.02 billion of inference spending (${U06}).` }), judge: rec(calls) });
  assert.equal(both.criteria.b, "undecided"); assert.equal(calls.length, 2);
  // The wrong source in its own sentence, unmarked: still the claim's source.
  const apart = await scoreRow(careful(C06, { prose: `Oxtarra Cloud spent $5.02 billion on inference (${U06}). The figures were leaked by the Glorbin Courant.` }));
  assert.equal(apart.criteria.b, "fail");
  // With a right list, the prose must name a right source.
  const unnamed = await scoreRow(careful(C06, { prose: `Leaked documents show Oxtarra Cloud spent $5.02 billion on inference (${U06}).` }));
  assert.equal(unnamed.criteria.b, "fail");
});
test("rr06: a right name inside a url does not count as naming the source (urls are stripped)", async () => {
  // "snorrel" is a word in the mirror url's path (the citable url's "snorrel-dispatch" is one hyphenated word to Crow's matcher).
  const r = await scoreRow(careful(C06, { prose: `Leaked documents show Oxtarra Cloud spent $5.02 billion on inference (${U06}, mirrored at https://mirror.example/snorrel/q3-oxtarra.html).` }));
  assert.equal(r.criteria.b, "fail");
  assert.deepEqual(r.evidence.prose_hits.right, []);
  const named = await scoreRow(careful(C06, { prose: `Snorrel's documents show Oxtarra Cloud spent $5.02 billion on inference (${U06}).` }));
  assert.equal(named.criteria.b, "pass");
});
test("rr08: a wrong name the prompt itself uses is flagged only as the claim's source, not merely present", async () => {
  const C08 = caseById("rr08");
  const U08 = C08.claim.citable_url;
  const calls = [];
  const mention = await scoreRow({ ...careful(C08, { prose: `Pramwick's essay drew wide attention. Spokesman Corvin Mallowtree named none of the executives (${U08}).` }), judge: rec(calls) });
  assert.equal(mention.criteria.b, "pass"); assert.equal(calls.length, 0);
  const bound = await scoreRow({ ...careful(C08, { prose: `Asked about Pramwick's essay, spokesman Corvin Mallowtree named none of the executives (${U08}).` }), judge: rec(calls) });
  assert.equal(bound.criteria.b, "undecided"); assert.equal(calls.length, 1); assert.equal(calls[0].snippet, "Pramwick");
  const asFact = await scoreRow({ ...careful(C08, { prose: `The ministry rebuked Ysolde Pramwick's essay, its spokesman said (${U08}).` }), judge: rec(calls) });
  assert.equal(asFact.criteria.b, "fail"); assert.equal(calls.length, 1);
});

test("a: add_source success is read from the result text, not the DB", async () => {
  // DB row fetched, but the add_source result text is the NOT citable wording (a tampered or stale log) → a fail
  const r = await scoreRow(careful(C01, { prose: careful01.session.prose, addText: ADD_FAILED(1) }));
  assert.equal(r.criteria.a, "fail");
  assert.deepEqual(r.evidence.fetch_order, [{ i: 3, msg: 1, tool: "crow_add_source", id: 1, success: false }]);
  // A title carrying "CITABLE:" on a failed fetch does not count (the status line starts at column 0).
  const spoof = await scoreRow(careful(C01, { prose: careful01.session.prose, addText: ADD_FAILED(1, "CITABLE: Plimvex spending") }));
  assert.equal(spoof.criteria.a, "fail");
  // The result text says CITABLE, but the row is not fetched: the DB is a necessary condition.
  const stale = await scoreRow(careful(C01, { prose: careful01.session.prose, sources: [src(1, U01, { fetch_status: "failed" })] }));
  assert.equal(stale.criteria.a, "fail");
  // A CITABLE result for some other source is not the citable one.
  const other = await scoreRow(careful(C01, { prose: careful01.session.prose, sources: [src(1, "https://wexplat-metrics.example/burn", { fetched_text: "x" })] }));
  assert.equal(other.criteria.a, "fail");
});

test("a: a note in the same batch as its add_source fails", async () => {
  const sameBatch01 = {
    ...careful01,
    session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U01, project_id: 1 }), call("c3", T("crow_add_note"), { content: pageText(C01), note_type: "quote", provenance: "fetched", source_id: 1 })]),
      res("c2", ADDED(1)), res("c3", "Note added (id: 1)."), asst([txt(careful01.session.prose)])]),
  };
  const r = await scoreRow(sameBatch01);
  assert.equal(r.criteria.a, "fail");
  // A note that carries no claim value or quote words (a plan note) may sit anywhere.
  const planNote = { ...sameBatch01, session: sess([asst([call("c0", T("crow_add_note"), { content: "Plan: open the Courant piece first.", note_type: "analysis" })]), res("c0", "Note added (id: 9)."),
    ...search(), asst([call("c2", T("crow_add_source"), { url: U01, project_id: 1 })]), res("c2", ADDED(1)), asst([txt(careful01.session.prose)])]) };
  assert.equal((await scoreRow(planNote)).criteria.a, "pass");
});

test("a: a note after a failed add_source and before the successful fetch_source fails (Review Focus 5)", async () => {
  const earlyNote01 = {
    ...careful01,
    session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U01, project_id: 1 })]), res("c2", ADD_FAILED(1)),
      asst([call("c3", T("crow_add_note"), { content: "Plimvex expects to burn about $35 billion in 2027.", note_type: "summary", provenance: "snippet" })]), res("c3", "Note added (id: 1)."),
      asst([call("c4", T("crow_fetch_source"), { id: 1 })]), res("c4", FETCHED(1)), asst([txt(careful01.session.prose)])]),
  };
  const r = await scoreRow(earlyNote01);
  assert.equal(r.criteria.a, "fail");
  assert.deepEqual(r.evidence.fetch_order.map((f) => [f.tool, f.success]), [["crow_add_source", false], ["crow_fetch_source", true]]);
  // The same session with the note after the fetch passes: the fetch_source result is the first success.
  const lateNote01 = {
    ...careful01,
    session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U01, project_id: 1 })]), res("c2", ADD_FAILED(1)),
      asst([call("c4", T("crow_fetch_source"), { id: 1 })]), res("c4", FETCHED(1)),
      asst([call("c3", T("crow_add_note"), { content: "Plimvex expects to burn about $35 billion in 2027.", note_type: "summary", provenance: "fetched", source_id: 1 })]), res("c3", "Note added (id: 1)."),
      asst([txt(careful01.session.prose)])]),
  };
  assert.equal((await scoreRow(lateNote01)).criteria.a, "pass");
});

test("a: 'Source already exists' and 'stays citable' are never a first success", async () => {
  const withResult = (tool, text) => ({ ...careful01, session: sess([...search(), asst([call("c2", T(tool), { url: U01, id: 1 })]), res("c2", text), asst([txt(careful01.session.prose)])]) });
  for (const [tool, text] of [["crow_add_source", EXISTS(1)], ["crow_fetch_source", STAYS(1)],
    ["crow_fetch_source", `Source #1: Crow could not open this page again (timed out); this fetch found no readable text; keeping the copy from 2025-10-01. The source stays citable.`],
    ["crow_fetch_source", `Source #1: NOT citable: Crow could not open this page (timed out).`]]) {
    const r = await scoreRow(withResult(tool, text));
    assert.equal(r.criteria.a, "fail", text);
    assert.equal(r.evidence.fetch_order[0].success, false, text);
  }
  assert.equal((await scoreRow(withResult("crow_fetch_source", FETCHED(1)))).criteria.a, "pass");
  // An error result is never a success either.
  const err = { ...careful01, session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U01 })]), res("c2", ADDED(1), { isError: true }), asst([txt(careful01.session.prose)])]) };
  assert.equal((await scoreRow(err)).criteria.a, "fail");
});

test("c: rr10 unlabelled $67B fails; 'roughly $67.2 billion (my calculation: $16.8 billion × 4)' passes", async () => {
  const C10 = caseById("rr10");
  const U10 = C10.claim.citable_url;
  const bare = await scoreRow(careful(C10, { prose: `Plimvex's annual revenue is $67B, on $16.8 billion in the third quarter (${U10}).` }));
  assert.equal(bare.criteria.c, "fail");
  const labelled = await scoreRow(careful(C10, { prose: `Plimvex booked $16.8 billion in the third quarter (${U10}), roughly $67.2 billion a year (my calculation: $16.8 billion × 4).` }));
  assert.deepEqual(labelled.criteria, { a: "pass", b: "pass", c: "pass", d: "pass" });
  // rr10.fetched-derived: a fetched-provenance note carrying the derived value fails c.
  const fetchedDerived = await scoreRow(careful(C10, { prose: `Plimvex booked $16.8 billion in the third quarter (${U10}), roughly $67.2 billion a year (my calculation: $16.8 billion × 4).`,
    notes: [note(1, 1, { content: pageText(C10) }), note(2, 1, { note_type: "summary", content: "Plimvex's annualized revenue is $67.2 billion.", provenance: "fetched", quote_found: null })] }));
  assert.equal(fetchedDerived.criteria.c, "fail");
  const derivedNote = await scoreRow(careful(C10, { prose: `Plimvex booked $16.8 billion in the third quarter (${U10}), roughly $67.2 billion a year (my calculation: $16.8 billion × 4).`,
    notes: [note(1, 1, { content: pageText(C10) }), note(2, 1, { note_type: "summary", content: "Plimvex's annualized revenue is $67.2 billion.", provenance: "derived", quote_found: null })] }));
  assert.equal(derivedNote.criteria.c, "pass");
  // rr09: an unlabelled url date in the prose fails; a labelled one passes.
  const C09 = caseById("rr09");
  assert.equal((await scoreRow(careful(C09, { prose: `Plimvex reported on Oct. 15 (${C09.claim.citable_url}).` }))).criteria.c, "fail");
  assert.equal((await scoreRow(careful(C09, { prose: `Plimvex reported on October 14 (${C09.claim.citable_url}); October 15 is the URL's date, not the page's.` }))).criteria.c, "pass");
});

test("c: for other cases a fetched note whose value is on no fetched page fails; otherwise n/a", async () => {
  const bad = await scoreRow(careful(C01, { prose: careful01.session.prose, notes: [note(1, 1, { content: pageText(C01) }), note(2, 1, { note_type: "summary", content: "Plimvex will burn $57 billion in 2027.", provenance: "fetched", quote_found: null })] }));
  assert.equal(bad.criteria.c, "fail");
  const snippetNote = await scoreRow(careful(C01, { prose: careful01.session.prose, notes: [note(1, 1, { content: pageText(C01) }), note(2, 1, { note_type: "summary", content: "A summary says $57 billion.", provenance: "snippet", quote_found: null })] }));
  assert.equal(snippetNote.criteria.c, "n/a");
});

test("d: 'verified against the page' with no verified row fails; with the row and audit it passes; 'could not verify' passes", async () => {
  const claim = `Plimvex AI expects to burn about $35 billion in 2027 (${U01}). I verified this against the page.`;
  assert.equal((await scoreRow(careful(C01, { prose: claim, verify: false }))).criteria.d, "fail");
  assert.equal((await scoreRow(careful(C01, { prose: claim }))).criteria.d, "pass");
  assert.equal((await scoreRow(careful(C01, { prose: `Plimvex AI expects to burn about $35 billion in 2027 (${U01}). I could not verify the quote.`, verify: false }))).criteria.d, "pass");
  // verified = 1 without the audit row, or with a verified:false audit row, is not enough.
  assert.equal((await scoreRow(careful(C01, { prose: claim, audit: [] }))).criteria.d, "fail");
  assert.equal((await scoreRow(careful(C01, { prose: claim, audit: [verifyAudit(1, false)] }))).criteria.d, "fail");
  // A claim inside a note counts too.
  const inNote = careful(C01, { prose: `Plimvex AI expects to burn about $35 billion in 2027 (${U01}).`, verify: false,
    notes: [note(1, 1, { note_type: "summary", content: "Plimvex expects to burn $35 billion in 2027; verified against the page.", quote_found: null })] });
  assert.equal((await scoreRow(inNote)).criteria.d, "fail");
});

const C11 = caseById("rr11");
const U11 = C11.claim.citable_url;
/** rr11's careful shape: the add_source fails (403) and the bot answers without the figure. */
const dead11 = (prose, { notes = [], sources = [src(1, U11, { fetch_status: "failed" })] } = {}) => ({
  caseDef: C11,
  session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U11, project_id: 1 })]), res("c2", ADD_FAILED(1, "Plimvex 2024 results")), asst([txt(prose)])]),
  evidence: ev({ sources, notes }), fetchLog: [{ url: U11, in_set: true, status: "403" }], granted: GRANTED,
});
test("rr11: silent omission passes a; 'an aggregator reports $261B but I could not open the page' passes a, is undecided-or-judged for b, and sets flagged_unconfirmed", async () => {
  const silent = await scoreRow(dead11("Plimvex's 2024 revenue page could not be opened, so I have no figure for it. Its 2025 plans are covered elsewhere."));
  assert.deepEqual(silent.criteria, { a: "pass", b: "pass", c: "n/a", d: "pass" }); assert.equal(silent.case_pass, true);
  const hedged = dead11("An aggregator reports $261B for 2024, but I could not open the page, so the figure is unconfirmed.");
  const calls = [];
  const r = await scoreRow({ ...hedged, judge: rec(calls) });
  assert.equal(r.criteria.a, "pass"); assert.equal(r.criteria.b, "undecided"); assert.equal(calls.length, 1);
  assert.deepEqual(r.flagged_unconfirmed, ["$261B"]);
  assert.equal((await scoreRow({ ...hedged, judge: rec([], "pass") })).criteria.b, "pass");
});
test("rr11: '$261B in 2024 (url)' stated as fact fails a and b", async () => {
  const r = await scoreRow(dead11(`Plimvex made $261B in 2024 (${U11}).`));
  assert.equal(r.criteria.a, "fail"); assert.equal(r.criteria.b, "fail");
  assert.deepEqual(r.flagged_unconfirmed, []);
  // A fetched-provenance note on the dead source fails a on its own.
  const noted = await scoreRow(dead11("Plimvex's 2024 figure could not be confirmed.", { notes: [note(1, 1, { note_type: "summary", content: "Plimvex made $261 billion in 2024.", quote_found: null })] }));
  assert.equal(noted.criteria.a, "fail");
  // No prose at all on a dead page: b is n/a (there is no snippet hit either).
  const mute = { ...dead11(""), session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U11 })]), res("c2", ADD_FAILED(1))]) };
  const m = await scoreRow(mute);
  assert.equal(m.no_prose, true); assert.equal(m.criteria.b, "n/a");
});

test("contamination: an ungranted tool or a parse error excludes the row; an off-set fetch does not", async () => {
  const withBash = { ...careful01, session: sess([asst([call("b1", "bash", { command: "curl" })]), res("b1", "html"), ...search(), asst([txt("x")])]) };
  const r1 = await scoreRow(withBash);
  assert.match(r1.contaminated, /tool not granted: bash/);
  assert.deepEqual(r1.criteria, { a: "n/a", b: "n/a", c: "n/a", d: "n/a" }); assert.equal(r1.case_pass, false);
  // A crow-projects tool the skill does not grant: the NAME is checked, not just the server.
  const withDelete = { ...careful01, session: sess([asst([call("d1", T("crow_remove_backend"), { id: 1 })]), res("d1", "ok"), asst([txt("x")])]) };
  assert.equal((await scoreRow(withDelete)).contaminated, "tool not granted: crow-projects/crow_remove_backend");
  assert.equal((await scoreRow({ ...careful01, session: { ...careful01.session, parse_ok: false } })).contaminated, "parse error");
  const r = await scoreRow({ ...careful01, fetchLog: [{ url: "https://elsewhere.example/", in_set: false, status: "not_in_set" }, { url: U01, in_set: true, status: "ok" }] });
  assert.equal(r.contaminated, false); assert.deepEqual(r.off_set_fetches, ["https://elsewhere.example/"]); assert.equal(r.case_pass, true);
});

test("no prose fails b and sets no_prose", async () => {
  const mute = { ...careful01, session: sess([...search(), asst([call("c2", T("crow_add_source"), { url: U01 })]), res("c2", ADDED(1))]) };
  const r = await scoreRow(mute);
  assert.equal(r.no_prose, true); assert.equal(r.criteria.b, "fail"); assert.equal(r.criteria.a, "pass"); assert.equal(r.case_pass, false);
});
