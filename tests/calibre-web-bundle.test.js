/**
 * Calibre-Web bundle auth contract (W5.7).
 *
 * Stock Calibre-Web has NO API-key mechanism — OPDS uses HTTP Basic auth and
 * the non-OPDS web routes (/shelf/*, /ajax/*) are session-protected and
 * answer Basic-auth'd requests with a redirect to /login. The bundle was
 * originally written against a fictional bearer-token API; this test pins
 * the corrected contract against a stub that behaves like stock:
 *   1. Correct Basic creds → OPDS search parses entries.
 *   2. Wrong creds → 401 surfaces the username/password guidance.
 *   3. Session-only route redirect → honest "needs a browser session" error,
 *      NOT a silently-followed redirect to the login page.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const USER = "reader";
const PASS = "s3cret";
const GOOD = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

const OPDS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>urn:uuid:book-42</id>
    <title>The Heron Manual</title>
    <author><name>R. Corvid</name></author>
    <summary>Field notes on wading birds.</summary>
    <updated>2026-06-12T00:00:00Z</updated>
    <link href="/download/42/epub" rel="http://opds-spec.org/acquisition" type="application/epub+zip"/>
  </entry>
</feed>`;

let stub = null;
let client = null;

before(async () => {
  stub = http.createServer((req, res) => {
    if (req.headers.authorization !== GOOD) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="calibre"' });
      return res.end("Unauthorized");
    }
    if (req.url.startsWith("/opds/search")) {
      res.writeHead(200, { "Content-Type": "application/atom+xml" });
      return res.end(OPDS_FEED);
    }
    if (req.url.startsWith("/shelf/add/")) {
      // Stock behavior: session-protected web route redirects to login.
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const port = stub.address().port;

  // Env must be set BEFORE the module import — it reads env at load time.
  process.env.CALIBRE_WEB_URL = `http://127.0.0.1:${port}`;
  process.env.CALIBRE_WEB_USERNAME = USER;
  process.env.CALIBRE_WEB_PASSWORD = PASS;

  const { createCalibreWebServer } = await import("../bundles/calibre-web/server/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createCalibreWebServer();
  client = new Client({ name: "cw-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
});

after(async () => {
  if (client) await client.close().catch(() => {});
  if (stub) stub.close();
});

test("OPDS search works with Basic auth and parses entries", async () => {
  const res = await client.callTool({ name: "crow_calibreweb_search", arguments: { query: "heron" } });
  const text = res.content.map((c) => c.text || "").join("\n");
  assert.match(text, /The Heron Manual/);
  assert.match(text, /R\. Corvid/);
  assert.match(text, /epub/);
});

test("wrong credentials surface the username/password guidance", async () => {
  const prev = process.env.CALIBRE_WEB_PASSWORD;
  // The module captured creds at import time, so simulate bad creds by
  // pointing a SECOND import at the same stub via a child process. The child
  // must run ASYNC: the stub lives in THIS process, so a sync exec would
  // block the event loop and deadlock the child's request against it.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout: out } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { createCalibreWebServer } = await import("./bundles/calibre-web/server/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createCalibreWebServer();
    const client = new Client({ name: "cw-bad", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const res = await client.callTool({ name: "crow_calibreweb_search", arguments: { query: "x" } });
    console.log("OUT:" + res.content.map((c) => c.text || "").join("\\n"));
    process.exit(0);
  `], {
    env: { ...process.env, CALIBRE_WEB_PASSWORD: "wrong" },
    cwd: new URL("..", import.meta.url).pathname,
    timeout: 30_000,
  });
  assert.match(out, /CALIBRE_WEB_USERNAME and CALIBRE_WEB_PASSWORD/);
  process.env.CALIBRE_WEB_PASSWORD = prev;
});

test("session-only route fails honestly instead of following the login redirect", async () => {
  const res = await client.callTool({ name: "crow_calibreweb_add_to_shelf", arguments: { shelf_id: 1, book_id: 42 } });
  const text = res.content.map((c) => c.text || "").join("\n");
  assert.match(text, /browser session/i);
  assert.doesNotMatch(text, /added to shelf/);
});
