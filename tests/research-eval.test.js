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
