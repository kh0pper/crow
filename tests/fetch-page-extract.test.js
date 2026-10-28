/**
 * fetchPage (servers/shared/fetch-page.js): extraction in a worker, text caps, content hash.
 * No real network: a local server on 127.0.0.1 and an injected lookup.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fetchPage, splitFetchedText, storedTextMaybeTruncated, FULL_TEXT_MARKER, FETCHED_TEXT_MAX } from "../servers/shared/fetch-page.js";
import { extractReadable } from "../servers/shared/fetch-page-worker.js";

const FIX = new URL("./fixtures/research-pages/", import.meta.url);
const ARTICLE = "<!doctype html><html><head><title>T</title></head><body><nav>Home About</nav><article><h1>Headline</h1><p>First paragraph of the article with enough words to count as content for the reader.</p><p>Second paragraph continues with more words so the extractor keeps this block.</p></article><footer>Copyright footer</footer></body></html>";
const sha = (s) => createHash("sha256").update(s).digest("hex");
let server, port;
const OPTS = () => ({
  lookup: (h, o, cb) => { if (typeof o === "function") cb = o; if (h === "no-such-host.invalid") { const e = new Error("nx"); e.code = "ENOTFOUND"; return cb(e); } cb(null, [{ address: "127.0.0.1", family: 4 }]); },
  isAllowedAddress: () => true,
});

before(async () => {
  server = http.createServer((req, res) => {
    const p = req.url;
    if (p === "/html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(ARTICLE); }
    if (p === "/plain") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("just plain text"); }
    if (p === "/pdf") { res.writeHead(200, { "Content-Type": "application/pdf" }); return res.end("%PDF-1.4 x"); }
    if (p === "/huge") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("a".repeat(300000)); }
    if (p.startsWith("/sized/")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<p>${p.slice(7)}</p>`); }
    if (p === "/1252") { res.writeHead(200, { "Content-Type": "text/html; charset=windows-1252" }); return res.end(fs.readFileSync(new URL("article-1252.html", FIX))); }
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());
const u = (p) => `http://page.test:${port}${p}`;

test("HTML → fetched with readable text first, full text after the marker", async () => {
  const r = await fetchPage(u("/html"), OPTS());
  assert.equal(r.fetch_status, "fetched");
  assert.ok(r.text.startsWith(r.readable_text));
  assert.ok(r.text.includes(FULL_TEXT_MARKER));
  assert.ok(r.readable_text.includes("First paragraph"));
  assert.ok(!r.readable_text.includes("Copyright footer"));
  assert.ok(splitFetchedText(r.text).body.includes("Copyright footer"));
  assert.equal(splitFetchedText(r.text).readable, r.readable_text);
  assert.equal(r.sha256, sha(r.text));
  assert.ok(!("preview" in r));
});
test("text/plain passes through", async () => {
  const r = await fetchPage(u("/plain"), OPTS());
  assert.equal(r.text, "just plain text");
  assert.ok(!r.text.includes(FULL_TEXT_MARKER));
});
test("other content types are fetched_no_text", async () => {
  const r = await fetchPage(u("/pdf"), OPTS());
  assert.equal(r.ok, true); assert.equal(r.fetch_status, "fetched_no_text"); assert.equal(r.text, null); assert.equal(r.sha256, null);
});
test("HTTP 404 is failed with the status in the reason", async () => {
  const r = await fetchPage(u("/missing"), OPTS());
  assert.equal(r.ok, false); assert.equal(r.fetch_status, "failed"); assert.equal(r.http_status, 404); assert.match(r.reason, /HTTP 404/);
});
test("a resolver failure is failed, never thrown", async () => {
  const r = await fetchPage(`http://no-such-host.invalid:${port}/`, OPTS());
  assert.equal(r.ok, false); assert.match(r.reason, /could not resolve/); assert.equal(r.http_status, null);
});
test("unknown error codes get a default reason", async () => {
  const r = await fetchPage(`http://page.test:${port}/`, { ...OPTS(), lookup: (h, o, cb) => { const e = new Error("x"); e.code = "EWEIRD"; (typeof o === "function" ? o : cb)(e); } });
  assert.match(r.reason, /could not be fetched \(EWEIRD\)/);
});
test("decodes the declared charset", async () => {
  const r = await fetchPage(u("/1252"), OPTS());
  assert.equal(r.fetch_status, "fetched");
  assert.ok(r.text.includes("’") && r.text.includes("—"), r.text);
});
test("text is capped at FETCHED_TEXT_MAX and flagged truncated", async () => {
  const r = await fetchPage(u("/huge"), OPTS());
  assert.equal(r.text.length, FETCHED_TEXT_MAX); assert.equal(r.truncated, true);
});
const SIZED = new URL("sized-worker.mjs", FIX);
const sized = (r, b) => fetchPage(u(`/sized/R=${r};B=${b}`), { ...OPTS(), workerUrl: SIZED });

test("HTML: a cap inside the full-text marker drops the marker, keeps the readable text whole", async () => {
  const R = FETCHED_TEXT_MAX - 5; // the marker would start 5 chars before the cap
  const r = await sized(R, 1000);
  assert.equal(r.fetch_status, "fetched");
  assert.equal(r.truncated, true);
  assert.equal(r.text, "r".repeat(R), "no partial marker is stored");
  assert.ok(!r.text.includes("[crow"));
  assert.equal(r.readable_text, r.text);
  assert.equal(splitFetchedText(r.text).readable, r.readable_text);
  assert.equal(r.sha256, sha(r.text));
});

test("a stored copy cut inside the marker still reads back as maybe-truncated", async () => {
  const r = await sized(FETCHED_TEXT_MAX - 5, 1000);
  assert.equal(storedTextMaybeTruncated(r.text), true);
  assert.equal(storedTextMaybeTruncated((await sized(1000, FETCHED_TEXT_MAX)).text), true);
  assert.equal(storedTextMaybeTruncated("short page"), false);
  assert.equal(storedTextMaybeTruncated(null), false);
});

test("HTML: readable + marker + body cut together at the cap", async () => {
  const r = await sized(1000, FETCHED_TEXT_MAX);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, FETCHED_TEXT_MAX);
  assert.ok(r.text.startsWith("r".repeat(1000) + FULL_TEXT_MARKER));
  assert.equal(r.readable_text, "r".repeat(1000));
  const parts = splitFetchedText(r.text);
  assert.equal(parts.readable, r.readable_text);
  assert.equal(parts.body.length, FETCHED_TEXT_MAX - 1000 - FULL_TEXT_MARKER.length);
});

test("HTML: readable text longer than the cap is cut and carries no marker", async () => {
  const r = await sized(FETCHED_TEXT_MAX + 50, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "r".repeat(FETCHED_TEXT_MAX));
  assert.equal(r.readable_text, r.text, "readable_text is the cut readable text");
  assert.ok(!r.text.includes(FULL_TEXT_MARKER));
});

test("extractReadable is importable without starting a worker", () => {
  const out = extractReadable(ARTICLE, "http://page.test/");
  assert.ok(out.readable.includes("First paragraph")); assert.ok(out.body.includes("Copyright footer"));
});
test("a worker that blows its memory limit resolves extract_failed", async () => {
  const r = await fetchPage(u("/html"), { ...OPTS(), workerUrl: new URL("memory-hog-worker.mjs", FIX), extractTimeoutMs: 20000 });
  assert.equal(r.ok, false); assert.match(r.reason, /extraction failed/);
});
test("a hung extractor times out without blocking", async () => {
  const t = Date.now();
  const r = await fetchPage(u("/html"), { ...OPTS(), workerUrl: new URL("hang-worker.mjs", FIX), extractTimeoutMs: 300 });
  assert.equal(r.ok, false); assert.match(r.reason, /extraction timed out/); assert.ok(Date.now() - t < 1500);
});

test("extractReadable keeps a separator at block boundaries", async () => {
  const { matchQuote } = await import("../servers/research/quote-match.js");
  const html = "<!doctype html><html><body><article><h1>Road</h1><p>The road will be widened by four kilometres.</p><p>Work starts in March after the vote.</p><ul><li>alpha</li><li>beta</li></ul>one<br>two</article></body></html>";
  const { readable, body } = extractReadable(html, "http://page.test/");
  for (const t of [readable, body]) {
    assert.ok(!t.includes("kilometres.Work"), t);
    assert.match(t, /kilometres\.\s+Work starts/);
    assert.match(t, /alpha\s+beta/);
    assert.match(t, /one\s+two/);
  }
  const m = matchQuote("kilometres. Work starts", { readable, body, truncated: false });
  assert.equal(m.found, 1, JSON.stringify(m));
});
