/**
 * crow_add_source opens the page before storing it; crow_fetch_source refreshes it.
 *
 * Every fetch goes through the injected `fetchPage` seam (a stub keyed by URL that counts its
 * calls), so these tests make no network calls. The scratch HOME / data dir is set before any app
 * import; init-db builds a full crow.db there.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-addsrc-"));
const DATA = join(HOME, ".crow", "data");
mkdirSync(DATA, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(HOME, ".crow");
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = join(DATA, "crow.db");
after(() => rmSync(HOME, { recursive: true, force: true }));

execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: ROOT, env: process.env, stdio: "pipe" });
const CORE = join(DATA, "crow.db");

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { createProjectServer } = await import("../servers/research/server.js");
const { OWNER } = await import("../servers/research/actor.js");
const { makeOldFkDb, openFixtureDb } = await import("./helpers/research-fixtures.js");

const BOT = { kind: "bot", id: "b1" };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const text = (r) => (r.content || []).map((c) => c.text).join("\n");

function okPage(finalUrl, body, extra = {}) {
  return {
    ok: true, fetch_status: "fetched", final_url: finalUrl, http_status: 200, content_type: "text/plain",
    text: body, readable_text: body, truncated: false, sha256: sha(body), fetched_at: new Date().toISOString(), ...extra,
  };
}
const failPage = (reason) => ({ ok: false, fetch_status: "failed", reason, final_url: null, http_status: null });

/** A fetchPage stub: canned results by URL (mutable), every call recorded. */
function makeStub(pages = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const v = fn.pages[url];
    return v || failPage("could not resolve the host");
  };
  fn.pages = pages;
  fn.calls = calls;
  return fn;
}

async function connect(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}
const clientFor = (stub, actor = OWNER, path = CORE) => connect(createProjectServer(path, { fetchPage: stub, actor }));

function raw(path = CORE) { return new Database(path); }
function row(id, path = CORE) { const d = raw(path); try { return d.prepare("SELECT * FROM research_sources WHERE id = ?").get(id); } finally { d.close(); } }
function note(id) { const d = raw(); try { return d.prepare("SELECT * FROM research_notes WHERE id = ?").get(id); } finally { d.close(); } }
function addQuoteNote(sourceId, content, quoteFound = null) {
  const d = raw();
  try {
    return Number(d.prepare("INSERT INTO research_notes (source_id, content, note_type, quote_found) VALUES (?, ?, 'quote', ?)")
      .run(sourceId, content, quoteFound).lastInsertRowid);
  } finally { d.close(); }
}
function insertRow(cols) {
  const d = raw();
  try {
    const keys = Object.keys(cols);
    return Number(d.prepare(`INSERT INTO research_sources (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => cols[k])).lastInsertRowid);
  } finally { d.close(); }
}
const idOf = (r) => Number(text(r).match(/\(id: (\d+)/)[1]);

let projectSeq = 0;
async function newProject(client) {
  const r = await client.callTool({ name: "crow_create_project", arguments: { name: `p${++projectSeq}` } });
  return Number(text(r).match(/id: (\d+)/)[1]);
}
const add = (client, args) => client.callTool({ name: "crow_add_source", arguments: { title: "T", source_type: "web_article", ...args } });
const refetch = (client, args) => client.callTool({ name: "crow_fetch_source", arguments: args });

// ---------------------------------------------------------------- add_source

test("a web source is fetched and stored citable with a preview", async () => {
  const page = "a".repeat(1199) + "B" + "Z" + "c".repeat(1799);
  assert.equal(page.length, 3000);
  const stub = makeStub({ "https://example.com/a": okPage("https://example.com/a", page) });
  const client = await clientFor(stub);
  const pid = await newProject(client);
  const r = await add(client, { url: "https://example.com/a", project_id: pid });
  assert.ok(!r.isError, text(r));
  const t = text(r);
  assert.ok(t.startsWith("Source added (id:"), t);
  assert.ok(t.includes("CITABLE: Crow fetched this page."), t);
  assert.ok(t.includes(page.slice(0, 1200)), "the first 1200 chars are shown");
  assert.ok(!t.includes(page.slice(0, 1201)), "char 1201 is not shown");
  assert.ok(t.length < 2000, `result is ${t.length} chars`);
  const open = "--- fetched page text (untrusted, first 1200 chars) ---";
  const close = "--- end fetched page text ---";
  assert.ok(t.indexOf(open) >= 0 && t.indexOf(close) > t.indexOf(open), t);
  const between = t.slice(t.indexOf(open) + open.length, t.indexOf(close));
  assert.equal(between.trim(), page.slice(0, 1200));

  const s = row(idOf(r));
  assert.equal(s.fetch_status, "fetched");
  assert.equal(s.fetched_text, page);
  assert.equal(s.content_sha256, sha(page));
  assert.equal(s.final_url, "https://example.com/a");
  assert.equal(s.http_status, 200);
  assert.ok(s.fetched_at);
  assert.equal(s.fetch_error, null);

  const d = raw();
  const audit = d.prepare("SELECT * FROM project_audit_log WHERE action = 'source.add' AND target = ?").get(`source:${s.id}`);
  d.close();
  assert.equal(audit.actor_type, "local");
  assert.equal(JSON.parse(audit.payload).fetch_status, "fetched");
  for (const c of stub.calls) assert.ok(!c.opts || !("allowPrivate" in c.opts), "the research server never passes allowPrivate");
});

test("the research server never opts into private addresses", () => {
  const dir = join(ROOT, "servers", "research");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    assert.ok(!readFileSync(join(dir, f), "utf8").includes("allowPrivate"), `${f} mentions allowPrivate`);
  }
});

test("final_url is stored without its fragment", async () => {
  const stub = makeStub({ "https://example.com/frag-src": okPage("https://example.com/frag#x", "fragment page text") });
  const client = await clientFor(stub);
  const r = await add(client, { url: "https://example.com/frag-src" });
  assert.equal(row(idOf(r)).final_url, "https://example.com/frag");
});

test("a failed fetch still stores the row, marked not citable", async () => {
  const stub = makeStub({ "https://no-such-host.invalid/x": failPage("could not resolve the host") });
  const client = await clientFor(stub);
  const r = await add(client, { url: "https://no-such-host.invalid/x" });
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).includes("NOT citable: Crow could not open this page (could not resolve the host)."), text(r));
  assert.ok(!text(r).includes("--- fetched page text"), "no preview for a failed fetch");
  const s = row(idOf(r));
  assert.equal(s.fetch_status, "failed");
  assert.equal(s.fetch_error, "could not resolve the host");
  assert.equal(s.fetched_text, null);
});

test("any source with a url is fetched, regardless of source_type", async () => {
  const stub = makeStub({ "https://example.com/book": okPage("https://example.com/book", "book page") });
  const client = await clientFor(stub);
  const r = await add(client, { source_type: "book", url: "https://example.com/book" });
  assert.equal(stub.calls.length, 1);
  assert.equal(row(idOf(r)).fetch_status, "fetched");
});

test("a source with no url is not_applicable and never fetched", async () => {
  const stub = makeStub();
  const client = await clientFor(stub);
  const r = await add(client, { source_type: "interview" });
  assert.ok(!r.isError, text(r));
  assert.equal(stub.calls.length, 0);
  const s = row(idOf(r));
  assert.equal(s.fetch_status, "not_applicable");
  for (const c of ["fetched_at", "final_url", "http_status", "content_sha256", "fetched_text", "fetch_error"]) assert.equal(s[c], null, c);
});

test("dedupe returns the existing id for the same url or final_url in the same project", async () => {
  const stub = makeStub({ "https://example.com/a2-redirect": okPage("https://example.com/a2", "a2 text") });
  const client = await clientFor(stub);
  const pid = await newProject(client);
  const first = await add(client, { url: "https://example.com/a2-redirect", project_id: pid });
  const id = idOf(first);
  const again = await add(client, { url: "https://example.com/a2", project_id: pid });
  assert.equal(idOf(again), id);
  assert.ok(text(again).includes(`Source already exists (id: ${id}, fetched). Use crow_fetch_source to refresh it.`), text(again));
  const same = await add(client, { url: "https://example.com/a2-redirect", project_id: pid });
  assert.equal(idOf(same), id);
  assert.equal(stub.calls.length, 1, "a duplicate is found before any fetch");
  const d = raw();
  const n = d.prepare("SELECT COUNT(*) c FROM research_sources WHERE project_id = ?").get(pid).c;
  d.close();
  assert.equal(n, 1);

  // After a fetch: a URL that redirects onto an existing final_url is still the same source.
  stub.pages["https://example.com/other-alias"] = okPage("https://example.com/a2#top", "a2 text");
  const alias = await add(client, { url: "https://example.com/other-alias", project_id: pid });
  assert.equal(idOf(alias), id);

  const pid2 = await newProject(client);
  const other = await add(client, { url: "https://example.com/a2", project_id: pid2 });
  assert.notEqual(idOf(other), id, "a different project gets its own row");
});

test("dedupe ignores the URL fragment", async () => {
  const stub = makeStub({
    "https://example.com/a3": okPage("https://example.com/a3", "a3 text"),
    "https://example.com/dead#one": failPage("timed out"),
  });
  const client = await clientFor(stub);
  const pid = await newProject(client);
  const id = idOf(await add(client, { url: "https://example.com/a3", project_id: pid }));
  assert.equal(idOf(await add(client, { url: "https://example.com/a3#part", project_id: pid })), id);
  // A failed row has no final_url; its stored url's fragment is ignored too.
  const dead = idOf(await add(client, { url: "https://example.com/dead#one", project_id: pid }));
  assert.equal(idOf(await add(client, { url: "https://example.com/dead#two", project_id: pid })), dead);
  assert.equal(idOf(await add(client, { url: "https://example.com/dead", project_id: pid })), dead);
  assert.equal(stub.calls.length, 2);
});

test("caller full_text is stored as-is and never becomes fetched_text", async () => {
  const stub = makeStub({ "https://example.com/ft": okPage("https://example.com/ft", "the real page") });
  const client = await clientFor(stub);
  const r = await add(client, { url: "https://example.com/ft", full_text: "what the bot says the page said" });
  const s = row(idOf(r));
  assert.equal(s.full_text, "what the bot says the page said");
  assert.equal(s.fetched_text, "the real page");

  const r2 = await add(client, { source_type: "document", full_text: "pasted text only" });
  const s2 = row(idOf(r2));
  assert.equal(s2.full_text, "pasted text only");
  assert.equal(s2.fetched_text, null);
});

// ---------------------------------------------------------------- fetch_source

test("crow_fetch_source retries a failed source and re-checks its quotes", async () => {
  const url = "https://example.com/retry";
  const stub = makeStub({ [url]: failPage("timed out") });
  const client = await clientFor(stub);
  const pid = await newProject(client);
  const id = idOf(await add(client, { url, project_id: pid }));
  assert.equal(row(id).fetch_status, "failed");
  const good = addQuoteNote(id, "the quick brown fox jumps over the lazy dog");
  const bad = addQuoteNote(id, "the slow green turtle naps under the busy cat");

  stub.pages[url] = okPage(url, "Intro. The quick brown fox jumps over the lazy dog. Outro.");
  const r = await refetch(client, { id });
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).includes("CITABLE: Crow fetched this page."), text(r));
  const s = row(id);
  assert.equal(s.fetch_status, "fetched");
  assert.equal(s.fetch_error, null);
  assert.ok(s.fetched_text.includes("quick brown fox"));
  assert.equal(note(good).quote_found, 1);
  assert.equal(note(bad).quote_found, 0);

  const d = raw();
  const audit = d.prepare("SELECT * FROM project_audit_log WHERE action = 'source.fetch' AND target = ?").get(`source:${id}`);
  d.close();
  assert.ok(audit, "source.fetch is audited");
});

test("crow_fetch_source never replaces text a passing quote check relies on", async () => {
  const url = "https://example.com/kept";
  const original = "We ship weekly, and we test every release.";
  const stub = makeStub({ [url]: okPage(url, original) });
  const owner = await clientFor(stub);
  const pid = await newProject(owner);
  const id = idOf(await add(owner, { url, project_id: pid }));
  const relied = addQuoteNote(id, "We ship weekly", 1);

  stub.pages[url] = okPage(url, "A completely rewritten page about something else.");
  const r = await refetch(owner, { id });
  assert.ok(!r.isError, text(r));
  assert.equal(row(id).fetched_text, original, "the stored text is kept");
  assert.equal(row(id).content_sha256, sha(original));
  assert.ok(text(r).includes(`#${relied}`), `the result names the kept check: ${text(r)}`);

  const bot = await clientFor(stub, BOT);
  const rb = await refetch(bot, { id, force: true });
  assert.ok(rb.isError, text(rb));
  assert.match(text(rb), /only the owner/);
  assert.equal(row(id).fetched_text, original);

  const rf = await refetch(owner, { id, force: true });
  assert.ok(!rf.isError, text(rf));
  assert.equal(row(id).fetched_text, "A completely rewritten page about something else.");
  assert.equal(note(relied).quote_found, 0, "quotes are re-checked against the new text");
});

test("an unchanged page only refreshes the fetch metadata", async () => {
  const url = "https://example.com/same";
  const stub = makeStub({ [url]: okPage(url, "same text", { fetched_at: "2026-01-01T00:00:00.000Z" }) });
  const client = await clientFor(stub);
  const id = idOf(await add(client, { url }));
  const n = addQuoteNote(id, "same text", 1);
  stub.pages[url] = okPage("https://example.com/same-moved#z", "same text", { http_status: 203, fetched_at: "2026-02-02T00:00:00.000Z" });
  const r = await refetch(client, { id });
  assert.ok(!r.isError, text(r));
  const s = row(id);
  assert.equal(s.fetched_at, "2026-02-02T00:00:00.000Z");
  assert.equal(s.http_status, 203);
  assert.equal(s.final_url, "https://example.com/same-moved");
  assert.equal(s.fetched_text, "same text");
  assert.equal(note(n).quote_found, 1);
});

test("a failed re-fetch never downgrades a fetched row", async () => {
  const url = "https://example.com/stable";
  const stub = makeStub({ [url]: okPage(url, "stable text") });
  const client = await clientFor(stub);
  const id = idOf(await add(client, { url }));
  const before = row(id);
  stub.pages[url] = failPage("timed out");
  const r = await refetch(client, { id });
  assert.ok(text(r).includes("timed out"), text(r));
  assert.deepEqual(row(id), before);
});

test("crow_fetch_source on a missing id is not found", async () => {
  const client = await clientFor(makeStub());
  const r = await refetch(client, { id: 999999 });
  assert.ok(r.isError);
  assert.match(text(r), /Source #999999 not found/);
});

test("a legacy row that fetches becomes fetched", async () => {
  const url = "https://example.com/legacy";
  const id = insertRow({ title: "Old", source_type: "web_article", url, citation_apa: "Old.", fetch_status: "legacy" });
  const stub = makeStub({ [url]: okPage(url, "legacy page text") });
  const client = await clientFor(stub);
  const r = await refetch(client, { id });
  assert.ok(!r.isError, text(r));
  const s = row(id);
  assert.equal(s.fetch_status, "fetched");
  assert.equal(s.fetched_text, "legacy page text");
});

test("crow_fetch_source on a source with no url fetches nothing", async () => {
  const stub = makeStub();
  const client = await clientFor(stub);
  const id = idOf(await add(client, { source_type: "interview" }));
  const r = await refetch(client, { id });
  assert.match(text(r), /no URL/);
  assert.equal(stub.calls.length, 0);
  assert.equal(row(id).fetch_status, "not_applicable");
});

// ---------------------------------------------------------------- deploy window

test("on an old-FK DB add_source degrades to the pre-0013 columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-addsrc-oldfk-"));
  try {
    const path = makeOldFkDb(join(dir, "old.db"));
    // A real old-FK host still has the FK parent tables; SQLite refuses any insert without them.
    const f = openFixtureDb(path);
    f.exec("CREATE TABLE research_projects (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE data_backends (id INTEGER PRIMARY KEY)");
    f.close();
    const stub = makeStub({ "https://example.com/oldfk": okPage("https://example.com/oldfk", "old fk page") });
    const server = createProjectServer(path, { fetchPage: stub, actor: OWNER });
    assert.equal(server.research.schema.ready, false);
    const client = await connect(server);
    const r = await add(client, { url: "https://example.com/oldfk" });
    assert.ok(!r.isError, text(r));
    assert.ok(text(r).includes("waiting for a schema upgrade"), text(r));
    const d = raw(path);
    const cols = d.prepare("PRAGMA table_info(research_sources)").all().map((c) => c.name);
    d.close();
    assert.ok(!cols.includes("fetch_status"), "no 0013 column was added");
    const s = row(idOf(r), path);
    assert.equal(s.url, "https://example.com/oldfk");
    assert.equal(stub.calls.length, 0, "nothing is fetched that could not be stored");
    // Dedupe still works on url alone.
    assert.equal(idOf(await add(client, { url: "https://example.com/oldfk#frag" })), s.id);
    const rf = await refetch(client, { id: s.id });
    assert.ok(rf.isError);
    assert.match(text(rf), /waiting for a schema upgrade/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
