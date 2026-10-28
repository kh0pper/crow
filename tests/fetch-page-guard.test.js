/**
 * guardedRequest (servers/shared/fetch-page.js): the request half of fetch-before-cite.
 *
 * URLs reach it from bots that may be prompt-injected, so every test here pins one wall of the
 * guard: scheme and credentials, the address the socket actually connects to (DNS rebinding),
 * every redirect hop, the byte cap on DECOMPRESSED output, and one deadline for the whole call.
 *
 * No real network: one local server on 127.0.0.1, names resolved through an injected lookup.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { guardedRequest, MAX_PAGE_BYTES, MAX_REDIRECTS, FETCH_TIMEOUT_MS, USER_AGENT } from "../servers/shared/fetch-page.js";

const HTML = "<!doctype html><html><head><title>Test page</title></head><body><p>Hello from the test page.</p></body></html>";
const SIX_MB = 6 * 1024 * 1024;

let server;
let port;
let count = 0;
let lastHeaders = null;
const timers = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    count += 1;
    lastHeaders = req.headers;
    const path = req.url;
    if (path === "/ok") {
      res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
      return res.end(HTML);
    }
    if (path === "/redir") {
      res.writeHead(302, { Location: `http://internal.test:${port}/ok` });
      return res.end();
    }
    if (path === "/redir-ok") {
      res.writeHead(301, { Location: "/ok" });
      return res.end("moved");
    }
    if (path === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      return res.end();
    }
    if (path === "/big") {
      res.writeHead(200, { "Content-Type": "text/plain" }); // chunked, no Content-Length
      const chunk = Buffer.alloc(64 * 1024, 97);
      let sent = 0;
      const pump = () => {
        while (sent < SIX_MB) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => {});
      return pump();
    }
    if (path === "/declared-big") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(SIX_MB) });
      res.write("a"); // then stall
      return;
    }
    if (path === "/drip") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const t = setInterval(() => { try { res.write("x"); } catch {} }, 200);
      timers.add(t);
      res.on("close", () => { clearInterval(t); timers.delete(t); });
      return;
    }
    if (path === "/gz") {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      return res.end(zlib.gzipSync(HTML));
    }
    if (path === "/deflate") {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "deflate" });
      return res.end(zlib.deflateSync(HTML));
    }
    if (path === "/br") {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "br" });
      return res.end(zlib.brotliCompressSync(HTML));
    }
    if (path === "/bomb") {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      res.on("error", () => {});
      return res.end(BOMB);
    }
    if (path === "/compress") {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "compress" });
      return res.end(HTML);
    }
    if (path === "/not-found") {
      res.writeHead(404, { "Content-Type": "text/html; charset=windows-1252" });
      return res.end("gone");
    }
    const slow = path.match(/^\/slow-redir\/(\d)$/);
    if (slow) {
      const n = Number(slow[1]);
      const t = setTimeout(() => {
        timers.delete(t);
        res.writeHead(302, { Location: n < 4 ? `/slow-redir/${n + 1}` : "/ok" });
        res.end();
      }, 200);
      timers.add(t);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const BOMB = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0));

/** A dns.lookup-shaped stub over a name→address table, recording every call. */
function stubLookup(table) {
  const calls = [];
  const fn = (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    calls.push(hostname);
    const address = typeof table === "function" ? table(hostname, calls.length) : table[hostname];
    if (!address) return process.nextTick(() => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    const family = address.includes(":") ? 6 : 4;
    if (options && options.all) return process.nextTick(() => callback(null, [{ address, family }]));
    process.nextTick(() => callback(null, address, family));
  };
  fn.calls = calls;
  return fn;
}

const allowAll = () => true;
const okLookup = () => stubLookup({ "ok.test": "127.0.0.1" });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

test("exact constants", () => {
  assert.equal(MAX_PAGE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_REDIRECTS, 5);
  assert.equal(FETCH_TIMEOUT_MS, 15000);
  assert.equal(USER_AGENT, "Mozilla/5.0 (compatible; Crow-Research/1.0)");
});

test("fetches through the injected lookup and reports final_url/status", async () => {
  const lookup = okLookup();
  const res = await guardedRequest(`http://ok.test:${port}/ok`, { lookup, isAllowedAddress: allowAll });
  assert.equal(res.http_status, 200);
  assert.ok(res.final_url.endsWith("/ok"));
  assert.equal(res.content_type, "text/html");
  assert.equal(res.charset, "utf-8");
  assert.equal(res.buffer.toString("utf8"), HTML);
  assert.deepEqual(lookup.calls, ["ok.test"]);
  assert.equal(lastHeaders["user-agent"], USER_AGENT);
  assert.equal(lastHeaders["accept-encoding"], "gzip, deflate, br");
});

test("a followed redirect reports the final URL", async () => {
  const res = await guardedRequest(`http://ok.test:${port}/redir-ok`, { lookup: okLookup(), isAllowedAddress: allowAll });
  assert.equal(res.http_status, 200);
  assert.equal(res.final_url, `http://ok.test:${port}/ok`);
});

test("non-2xx responses resolve; the caller decides", async () => {
  const res = await guardedRequest(`http://ok.test:${port}/not-found`, { lookup: okLookup(), isAllowedAddress: allowAll });
  assert.equal(res.http_status, 404);
  assert.equal(res.charset, "windows-1252");
  assert.equal(res.buffer.toString(), "gone");
});

test("refuses an IP-literal private host before connecting", async () => {
  const before = count;
  await rejectsWith(guardedRequest(`http://127.0.0.1:${port}/ok`), "EBLOCKED");
  await rejectsWith(guardedRequest(`http://[::ffff:127.0.0.1]:${port}/ok`), "EBLOCKED");
  await rejectsWith(guardedRequest(`http://[::1]:${port}/ok`), "EBLOCKED");
  assert.equal(count, before);
});

test("refuses when the name resolves to a blocked address", async () => {
  const before = count;
  await rejectsWith(guardedRequest(`http://ok.test:${port}/ok`, { lookup: okLookup() }), "EBLOCKED");
  assert.equal(count, before);
});

test("rebinding: the socket connects only to the address that was checked", async () => {
  const before = count;
  const lookup = stubLookup((_h, n) => (n === 1 ? "127.0.0.2" : "127.0.0.1"));
  await rejectsWith(
    guardedRequest(`http://rebind.test:${port}/ok`, { lookup, isAllowedAddress: (ip) => ip === "127.0.0.2" }),
    "ECONNREFUSED",
  );
  assert.equal(count, before);
  assert.equal(lookup.calls.length, 1);
});

test("every redirect hop is re-checked", async () => {
  const lookup = stubLookup({ "ok.test": "127.0.0.1", "internal.test": "192.0.2.5" });
  await rejectsWith(
    guardedRequest(`http://ok.test:${port}/redir`, { lookup, isAllowedAddress: (ip) => ip === "127.0.0.1" }),
    "EBLOCKED",
  );
  assert.deepEqual(lookup.calls, ["ok.test", "internal.test"]);
});

test("more than 5 redirects fail", async () => {
  const before = count;
  await rejectsWith(guardedRequest(`http://ok.test:${port}/loop`, { lookup: okLookup(), isAllowedAddress: allowAll }), "EREDIRECTS");
  assert.equal(count - before, MAX_REDIRECTS + 1);
});

test("non-http schemes and URL credentials are refused", async () => {
  const lookup = okLookup();
  for (const url of ["file:///etc/passwd", "ftp://x.test/", "http://u:p@ok.test/", "https://u@ok.test/", "not a url"]) {
    await rejectsWith(guardedRequest(url, { lookup, isAllowedAddress: allowAll }), "EBADURL");
  }
  assert.equal(lookup.calls.length, 0);
});

test("a redirect to a non-http scheme is refused", async () => {
  const s = http.createServer((_req, res) => { res.writeHead(302, { Location: "file:///etc/passwd" }); res.end(); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    await rejectsWith(
      guardedRequest(`http://ok.test:${s.address().port}/`, { lookup: okLookup(), isAllowedAddress: allowAll }),
      "EBADURL",
    );
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

test("a declared Content-Length over maxBytes is refused before the body is read", async () => {
  const t0 = Date.now();
  await rejectsWith(
    guardedRequest(`http://ok.test:${port}/declared-big`, { lookup: okLookup(), isAllowedAddress: allowAll, timeoutMs: 5000 }),
    "ETOOBIG",
  );
  assert.ok(Date.now() - t0 < 2000, "rejected well before timeoutMs");
});

test("a streamed body over maxBytes is ETOOBIG, with no partial result", async () => {
  await rejectsWith(guardedRequest(`http://ok.test:${port}/big`, { lookup: okLookup(), isAllowedAddress: allowAll }), "ETOOBIG");
  // and an explicit small cap applies too
  await rejectsWith(
    guardedRequest(`http://ok.test:${port}/ok`, { lookup: okLookup(), isAllowedAddress: allowAll, maxBytes: 10 }),
    "ETOOBIG",
  );
});

test("gzip, deflate and br bodies are decompressed", async () => {
  for (const p of ["/gz", "/deflate", "/br"]) {
    const res = await guardedRequest(`http://ok.test:${port}${p}`, { lookup: okLookup(), isAllowedAddress: allowAll });
    assert.equal(res.buffer.toString("utf8"), HTML, p);
  }
});

test("the cap counts decompressed bytes (gzip bomb)", async () => {
  assert.ok(BOMB.length < 100 * 1024, `bomb is small on the wire (${BOMB.length})`);
  await rejectsWith(
    guardedRequest(`http://ok.test:${port}/bomb`, { lookup: okLookup(), isAllowedAddress: allowAll, maxBytes: 5 * 1024 * 1024 }),
    "ETOOBIG",
  );
});

test("an unknown Content-Encoding is refused", async () => {
  await rejectsWith(guardedRequest(`http://ok.test:${port}/compress`, { lookup: okLookup(), isAllowedAddress: allowAll }), "EBADENCODING");
});

test("one deadline spans every redirect hop", async () => {
  await rejectsWith(
    guardedRequest(`http://ok.test:${port}/slow-redir/1`, { lookup: okLookup(), isAllowedAddress: allowAll, timeoutMs: 500 }),
    "ETIMEDOUT",
  );
});

test("drip server aborts at the overall deadline and the abort maps to ETIMEDOUT", async () => {
  const t0 = Date.now();
  await rejectsWith(
    guardedRequest(`http://ok.test:${port}/drip`, { lookup: okLookup(), isAllowedAddress: allowAll, timeoutMs: 500 }),
    "ETIMEDOUT",
  );
  assert.ok(Date.now() - t0 < 1500, `settled in ${Date.now() - t0} ms`);
});

test("allowPrivate opens the guard (reader operator opt-out only)", async () => {
  const res = await guardedRequest(`http://127.0.0.1:${port}/ok`, { allowPrivate: true });
  assert.equal(res.http_status, 200);
});

test("DNS failures surface their own code", async () => {
  await rejectsWith(guardedRequest(`http://missing.test:${port}/ok`, { lookup: okLookup(), isAllowedAddress: allowAll }), "ENOTFOUND");
});

test("a mixed DNS answer (one allowed address, one blocked) is refused whole", async () => {
  const before = count;
  const lookup = (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    const all = [{ address: "127.0.0.3", family: 4 }, { address: "127.0.0.1", family: 4 }];
    if (options && options.all) return process.nextTick(() => callback(null, all));
    process.nextTick(() => callback(null, all[0].address, 4));
  };
  await rejectsWith(
    guardedRequest(`http://mixed.test:${port}/ok`, { lookup, isAllowedAddress: (ip) => ip === "127.0.0.3" }),
    "EBLOCKED",
  );
  assert.equal(count, before, "nothing connected");
});

test("an HTTP proxy from the environment is never used", async () => {
  // A proxy that would see the request if the guard honoured HTTP_PROXY / NODE_USE_ENV_PROXY
  // (read at process start, so the request runs in a child with that env).
  let proxyHits = 0;
  const proxy = http.createServer((req, res) => { proxyHits += 1; res.writeHead(502); res.end(); });
  proxy.on("connect", (_req, sock) => { proxyHits += 1; sock.destroy(); });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const mod = new URL("../servers/shared/fetch-page.js", import.meta.url).href;
    const script = `
      import { guardedRequest } from ${JSON.stringify(mod)};
      const lookup = (h, o, cb) => { if (typeof o === "function") { cb = o; o = {}; }
        if (o && o.all) return cb(null, [{ address: "127.0.0.1", family: 4 }]); cb(null, "127.0.0.1", 4); };
      const r = await guardedRequest(${JSON.stringify(`http://ok.test:${port}/ok`)}, { lookup, isAllowedAddress: () => true });
      process.stdout.write(String(r.http_status));
    `;
    const before = count;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, NODE_USE_ENV_PROXY: "1", NO_PROXY: "", no_proxy: "" },
      timeout: 20000,
    });
    assert.equal(stdout, "200", "the request went straight to the page");
    assert.equal(count, before + 1);
    assert.equal(proxyHits, 0, "the proxy saw nothing");
  } finally {
    await new Promise((r) => proxy.close(r));
  }
});
