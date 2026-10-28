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
