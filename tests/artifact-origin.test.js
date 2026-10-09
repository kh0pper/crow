// The artifact origin's header, routing and network rules (spec §5.1, §5.2, §13).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startArtifactOrigin, cleanRelPath, artifactRequestAllowed } from "../servers/gateway/artifact-origin/server.js";
import { createViewTokenStore } from "../servers/gateway/artifact-origin/view-tokens.js";
import { cspFor, iframeSandboxFor, ARTIFACT_TYPES } from "../servers/gateway/artifact-origin/policy.js";

let server, port, tokens, seen = [];
const FILES = {
  "index.html": { body: "<!doctype html><html><head><title>x</title></head><body>hi</body></html>", contentType: "text/html; charset=utf-8" },
  "a/b.css": { body: "body{}", contentType: "text/css" },
};

before(async () => {
  tokens = createViewTokenStore();
  server = await startArtifactOrigin({
    port: 0,
    tokens,
    publicBase: null,
    resolveContent: async (q) => { seen.push(q); return FILES[q.path] || null; },
  });
  port = server.address().port;
});
after(() => { server?.closeAllConnections?.(); server?.close(); });

function reqAt(p, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: p, path, method, headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on("error", reject); r.end();
  });
}
function req(path, opts) { return reqAt(port, path, opts); }

/** Raw socket request → raw response text (for Node-level parse errors). */
function rawRequest(p, payload, waitMs = 600) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(p, "127.0.0.1", () => sock.write(payload));
    let buf = "";
    sock.on("data", (d) => (buf += d));
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); resolve(buf); }, waitMs);
  });
}

function assertBaseHeaders(r, label) {
  const csp = r.headers["content-security-policy"] || "";
  assert.match(csp, /(^|; )sandbox( allow-scripts)?(;|$)/, `${label}: CSP sandbox on every response`);
  assert.match(csp, /default-src 'none'/, `${label}: default-src none`);
  assert.match(csp, /connect-src 'none'/, `${label}: connect-src none`);
  assert.doesNotMatch(csp, /unsafe-eval/, `${label}: never unsafe-eval`);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/, `${label}: no widening sandbox flags`);
  assert.equal(r.headers["x-content-type-options"], "nosniff", label);
  assert.equal(r.headers["referrer-policy"], "no-referrer", label);
  assert.equal(r.headers["cache-control"], "no-store, private", label);
  assert.equal(r.headers["set-cookie"], undefined, `${label}: never sets a cookie`);
  assert.ok(r.status < 300 || r.status >= 400, `${label}: never redirects (${r.status})`);
}

test("every route and error path carries the sandbox CSP and the base headers", async () => {
  const { token } = tokens.mint({ artifactId: "a1", versionN: 1, type: "document", dashboardOrigin: "https://dash.example" });
  const cases = [
    ["/", "root"], ["/dashboard", "dashboard"], ["/api/x", "api"], ["/v/", "v"], [`/v/${token}`, "no trailing slash"],
    [`/v/${"x".repeat(43)}/`, "unknown token"], [`/v/short/`, "short token"], [`/v/${token}/`, "index"],
    [`/v/${token}/a/b.css`, "css"], [`/v/${token}/missing.png`, "missing"], [`/v/${token}/../etc/passwd`, "traversal"],
    [`/v/${token}/%2e%2e/x`, "encoded traversal"], [`/v/${token}/a%2fb.css`, "encoded slash"],
  ];
  for (const [p, label] of cases) assertBaseHeaders(await req(p), label);
  for (const m of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) assertBaseHeaders(await req(`/v/${token}/`, { method: m }), m);
  assertBaseHeaders(await req(`/v/${token}/`, { headers: { range: "bytes=0-3" } }), "range");
});

test("a valid token serves its version; a missing trailing slash is a 404, never a redirect", async () => {
  const { token } = tokens.mint({ artifactId: "a1", versionN: 3, type: "document", dashboardOrigin: "https://dash.example" });
  const ok = await req(`/v/${token}/`);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /hi/);
  assert.equal(seen.at(-1).versionN, 3);
  assert.equal(seen.at(-1).path, "index.html");
  assert.match(ok.headers["content-security-policy"], /frame-ancestors https:\/\/dash\.example/);
  assert.match(ok.headers["content-security-policy"], /; sandbox$/, "document is script-free");
  assert.equal(ok.headers["access-control-allow-origin"], undefined, "no ACAO on script-free types");
  assert.equal((await req(`/v/${token}`)).status, 404);
  const r = await req(`/v/${token}/`, { headers: { range: "bytes=0-3" } });
  assert.equal(r.status, 200, "range is not honoured: full 200");
});

test("HEAD returns headers and no body", async () => {
  const { token } = tokens.mint({ artifactId: "a1", versionN: 1, type: "document", dashboardOrigin: null });
  const r = await req(`/v/${token}/`, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "");
});

test("a throwing resolver still gets a 500 with the base headers (review R2)", async () => {
  const { token } = tokens.mint({ artifactId: "a1", versionN: 1, type: "page", dashboardOrigin: null });
  const s = await startArtifactOrigin({ port: 0, tokens, resolveContent: async () => { throw new Error("boom"); } });
  try {
    const r = await reqAt(s.address().port, `/v/${token}/`);
    assert.equal(r.status, 500);
    assertBaseHeaders(r, "resolver-throw 500");
    const h = await reqAt(s.address().port, `/v/${token}/`, { method: "HEAD" });
    assert.equal(h.status, 500);
    assert.equal(h.body, "");
    assertBaseHeaders(h, "resolver-throw 500 HEAD");
  } finally { s.closeAllConnections?.(); s.close(); }
});

test("Node-level parse errors (400/431) carry the base headers too (review L1)", async () => {
  const malformed = await rawRequest(port, "XYZZY / HTTP/1.1\r\nHost: x\r\n\r\n");
  assert.match(malformed, /^HTTP\/1\.1 400 Bad Request\r\n/, "malformed method → 400");
  assert.match(malformed, /content-security-policy: [^\r]*; sandbox\r\n/i, "strict CSP with sandbox");
  assert.match(malformed, /x-content-type-options: nosniff/i);
  assert.match(malformed, /content-length: 0\r\nconnection: close/i);
  assert.doesNotMatch(malformed, /set-cookie/i);
  const huge = await rawRequest(port, `GET / HTTP/1.1\r\nHost: x\r\nbig: ${"a".repeat(20000)}\r\n\r\n`);
  assert.match(huge, /^HTTP\/1\.1 431 /, "oversized header → 431");
  assert.match(huge, /content-security-policy: [^\r]*; sandbox\r\n/i);
  assert.match(huge, /x-content-type-options: nosniff/i);
});

test("the fallback CSP base is localhost — a forged Host header cannot widen script-src (review L3)", async () => {
  const { token } = tokens.mint({ artifactId: "a2", versionN: 1, type: "page", dashboardOrigin: null });
  const r = await req(`/v/${token}/`, { headers: { host: "evil.test:9" } });
  assert.equal(r.status, 200);
  const csp = r.headers["content-security-policy"];
  assert.ok(csp.includes(`script-src http://localhost:${port}/v/${token}/`), csp);
  assert.doesNotMatch(csp, /evil\.test/);
});

test("scripted types get allow-scripts, ACAO on 200s, and the anchor helper injected", async () => {
  const { token, nonce } = tokens.mint({ artifactId: "a2", versionN: 1, type: "page", dashboardOrigin: "https://dash.example" });
  const r = await req(`/v/${token}/`);
  assert.match(r.headers["content-security-policy"], /; sandbox allow-scripts$/);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.match(r.body, /^<!doctype html><script src="__crow\/anchor-helper\.js\?n=/);
  const h = await req(`/v/${token}/__crow/anchor-helper.js?n=x`);
  assert.equal(h.status, 200);
  assert.ok(h.body.includes(JSON.stringify(nonce)), "helper carries this load's nonce");
  const miss = await req(`/v/${token}/nope.js`);
  assert.equal(miss.status, 404);
  assert.equal(miss.headers["access-control-allow-origin"], undefined, "no ACAO on errors");
});

test("the Cookie header never reaches the content resolver, and Funnel traffic is refused", async () => {
  const { token } = tokens.mint({ artifactId: "a1", versionN: 1, type: "document", dashboardOrigin: null });
  let sawCookie = false;
  const s2 = await startArtifactOrigin({ port: 0, tokens, resolveContent: async () => null });
  // Wrap: the handler strips the cookie from every header view first; prove it
  // via a probe server that re-reads headers, rawHeaders and headersDistinct
  // AFTER the handler ran (review L2).
  const probe = http.createServer((rq, rs) => {
    s2.emit("request", rq, rs);
    sawCookie = sawCookie || ("cookie" in rq.headers)
      || (Array.isArray(rq.rawHeaders) && rq.rawHeaders.some((h, i) => i % 2 === 0 && String(h).toLowerCase() === "cookie"))
      || (() => { try { return rq.headersDistinct != null && "cookie" in rq.headersDistinct; } catch { return false; } })();
  });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  try {
    await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: probe.address().port, path: `/v/${token}/`, headers: { cookie: "crow_session=SECRET; crow_csrf=X" } }, (res) => { res.resume(); res.on("end", resolve); });
    });
    assert.equal(sawCookie, false, "cookie removed from headers, rawHeaders and headersDistinct before any later listener could read it");
  } finally { probe.closeAllConnections?.(); probe.close(); s2.close(); }   // a failure must not hang the file (re-check note)
  const f = await req(`/v/${token}/`, { headers: { "tailscale-funnel-request": "?1" } });
  assert.equal(f.status, 403);
  assertBaseHeaders(f, "funnel 403");
  const old = process.env.CROW_DASHBOARD_PUBLIC; process.env.CROW_DASHBOARD_PUBLIC = "true";
  try { assert.equal((await req(`/v/${token}/`, { headers: { "tailscale-funnel-request": "?1" } })).status, 403, "CROW_DASHBOARD_PUBLIC never opens the origin"); }
  finally { if (old === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = old; }
});

test("network rule: loopback, tailnet and private peers allowed; public peers and Funnel refused", () => {
  const mk = (addr, headers = {}) => ({ headers, socket: { remoteAddress: addr } });
  assert.equal(artifactRequestAllowed(mk("127.0.0.1")), true);
  assert.equal(artifactRequestAllowed(mk("::ffff:100.64.20.5")), true);
  assert.equal(artifactRequestAllowed(mk("172.18.0.3")), true);
  assert.equal(artifactRequestAllowed(mk("8.8.8.8")), false);
  assert.equal(artifactRequestAllowed(mk("8.8.8.8", { "tailscale-user-login": "someone@example.com" })), false, "the client-supplied login header is not an access path (review L4)");
  assert.equal(artifactRequestAllowed(mk("127.0.0.1", { "tailscale-funnel-request": "?1" })), false);
});

test("path cleaning rejects traversal, encoded separators and control characters", () => {
  assert.equal(cleanRelPath(""), "index.html");
  assert.equal(cleanRelPath("a/b.css"), "a/b.css");
  for (const bad of ["../x", "a/../b", "a//b", "%2e%2e/x", "a%2fb", "a%5cb", "a%00b", "./x", "a/", "%E0%A4%A"]) {
    assert.equal(cleanRelPath(bad), null, bad);
  }
});

test("tokens: expiry, revocation and format", () => {
  let t = 1000;
  const s = createViewTokenStore({ now: () => t, ttlMs: 50 });
  const { token } = s.mint({ artifactId: "z", versionN: 1, type: "page", dashboardOrigin: null });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(s.check(token));
  t += 51;
  assert.equal(s.check(token), null, "expired");
  const b = s.mint({ artifactId: "z", versionN: 2, type: "page", dashboardOrigin: null });
  s.revokeArtifact("z");
  assert.equal(s.check(b.token), null, "revoked");
  assert.equal(s.check("not a token"), null);
});

test("mint refuses a dashboardOrigin that is not a bare origin (frame-ancestors interpolation, review R4)", () => {
  const s = createViewTokenStore();
  for (const bad of [
    "https://x; sandbox allow-scripts allow-same-origin",   // would win over the real sandbox (first directive)
    "https://a.example/x", "https://a.example/?q=1", "javascript:alert(1)", "https://u:p@a.example",
    "https://*.example", "not a url", "", 42, {},
  ]) {
    assert.throws(() => s.mint({ artifactId: "z", versionN: 1, type: "page", dashboardOrigin: bad }), /bad_grant/, `refused: ${JSON.stringify(bad)}`);
  }
  assert.ok(s.mint({ artifactId: "z", versionN: 1, type: "page", dashboardOrigin: "https://dash.example" }));
  assert.ok(s.mint({ artifactId: "z", versionN: 1, type: "page", dashboardOrigin: "http://localhost:3001" }));
  assert.ok(s.mint({ artifactId: "z", versionN: 1, type: "page", dashboardOrigin: null }));
  assert.equal(s.mint({ artifactId: "z", versionN: 1, type: "page" }).expiresAt > 0, true);
});

test("CSP table: every type has a policy, scripted types match the iframe sandbox, none allow eval or connect", () => {
  for (const type of ARTIFACT_TYPES) {
    const csp = cspFor(type, { tokenBase: "https://a.example/v/T/", frameAncestors: "https://d.example" });
    assert.match(csp, /connect-src 'none'/, type);
    assert.match(csp, /worker-src 'none'/, type);
    assert.doesNotMatch(csp, /unsafe-eval/, type);
    const sandbox = csp.split("; ").find((d) => d.startsWith("sandbox"));
    assert.equal(sandbox.replace(/^sandbox ?/, ""), iframeSandboxFor(type), type);
  }
  assert.doesNotMatch(cspFor("pdf", { tokenBase: "https://a.example/v/T/" }), /script-src[^;]*unsafe-inline/, "pdf: no inline script (§5.2a)");
});

test("R-M1: helper injection is linear and bounded on hostile HTML", async () => {
  const { injectHelper } = await import("../servers/gateway/artifact-origin/server.js");
  assert.match(injectHelper("<HTML><Head data-x=1><title>t</title>", "n"), /^<script src="__crow\/anchor-helper\.js\?n=n"><\/script><HTML>/);
  for (const [label, html] of [["many <head no >", "<head ".repeat(500000)], ["huge", "x".repeat(20 * 1024 * 1024)], ["<head then far >", "<head" + " ".repeat(2000000) + ">"]]) {
    const t0 = process.hrtime.bigint(); injectHelper(html, "n"); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `${label}: ${ms.toFixed(0)} ms`);
  }
});

test("D20: a scripts-off grant on a scripted type is served script-free (no allow-scripts, no helper, no ACAO)", async () => {
  const { token } = tokens.mint({ artifactId: "a2", versionN: 1, type: "page", dashboardOrigin: "https://dash.example", scriptsOff: true });
  const r = await req(`/v/${token}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-security-policy"], /; sandbox$/);
  assert.doesNotMatch(r.headers["content-security-policy"], /script-src/);
  assert.doesNotMatch(r.body, /anchor-helper/);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
  assert.equal((await req(`/v/${token}/__crow/anchor-helper.js`)).status, 404);
});

test("no-parse helper placement: after BOM/whitespace/doctype, else at byte 0; never depends on the page's tags", async () => {
  const { injectHelper } = await import("../servers/gateway/artifact-origin/server.js");
  const H = '<script src="__crow/anchor-helper.js?n=n"></script>';
  assert.equal(injectHelper("<!DOCTYPE html><html><head>", "n"), "<!DOCTYPE html>" + H + "<html><head>");
  assert.equal(injectHelper("\uFEFF  <!doctype html>\n<p>", "n"), "\uFEFF  <!doctype html>" + H + "\n<p>");
  assert.equal(injectHelper("<!-- unclosed <head>", "n"), H + "<!-- unclosed <head>");
  assert.equal(injectHelper("<textarea><head></textarea>", "n"), H + "<textarea><head></textarea>");
  assert.equal(injectHelper("\u0130".repeat(700) + "<head>", "n").indexOf(H), 0);
});

test("scripts-off (D20) renditions are served byte-for-byte: safety comes from the CSP header, not from rewriting", async () => {
  const { token } = tokens.mint({ artifactId: "a3", versionN: 1, type: "page", dashboardOrigin: null, scriptsOff: true });
  const body = '<a href="https://e.example/x">x</a><script>alert(1)</script>';
  FILES["index.html"] = { body, contentType: "text/html" };
  try {
    const r = await req(`/v/${token}/`);
    assert.equal(r.body, body);
    assert.match(r.headers["content-security-policy"], /; sandbox$/);
    assert.doesNotMatch(r.headers["content-security-policy"], /script-src/);
  } finally { FILES["index.html"] = { body: "<!doctype html><html><head><title>x</title></head><body>hi</body></html>", contentType: "text/html; charset=utf-8" }; }
});

// ---- Task 1.2: runtime singletons and start-from-env ----

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

test("runtime: parseOriginUrl accepts scheme://host[:port] only", async () => {
  const { parseOriginUrl } = await import("../servers/gateway/artifact-origin/runtime.js");
  assert.equal(parseOriginUrl("https://a.example"), "https://a.example");
  assert.equal(parseOriginUrl("https://a.example/"), "https://a.example");
  assert.equal(parseOriginUrl("http://localhost:3090"), "http://localhost:3090");
  for (const bad of ["https://a.example/x", "https://a.example/?q=1", "https://a.example/#f", "https://u:p@a.example", "https://u@a.example", "ftp://a.example", "javascript:alert(1)", "not a url", "", null, undefined]) {
    assert.equal(parseOriginUrl(bad), null, `refused: ${String(bad)}`);
  }
});

test("runtime: nothing starts without a port; a bad port or origin URL is refused", async () => {
  const rt = await import("../servers/gateway/artifact-origin/runtime.js");
  rt._resetForTest();
  assert.equal(await rt.startArtifactOriginFromEnv({}), null);
  assert.equal(rt.artifactOriginInfo(), null);
  assert.equal(rt.isolationFor("localhost:3001"), "unavailable");
  for (const p of ["abc", "-1", "0.5", "70000", "0", "0x0BF2", "1e3", "+3090", "3090abc"]) {
    await assert.rejects(rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: p }), /CROW_ARTIFACT_ORIGIN_PORT/, `port ${p}`);
  }
  assert.equal(rt.artifactOriginInfo(), null, "hex/exponent/zero forms start nothing either (review R1)");
  await assert.rejects(rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: "3999", CROW_ARTIFACT_ORIGIN_URL: "https://a.example/path" }), /CROW_ARTIFACT_ORIGIN_URL/);
  assert.equal(rt.artifactOriginInfo(), null, "a refused start leaves no info behind");
});

test("runtime: start-from-env listens on loopback; isolation is shared-host on the fallback and own-host on its own hostname", async () => {
  const rt = await import("../servers/gateway/artifact-origin/runtime.js");
  rt._resetForTest();
  const p = await freePort();
  const srv = await rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: String(p) });
  try {
    assert.ok(srv);
    assert.equal(srv.address().address, "127.0.0.1");
    assert.equal(srv.address().port, p);
    assert.deepEqual(rt.artifactOriginInfo(), { baseUrl: `http://localhost:${p}`, port: p, configured: false });
    assert.equal(rt.isolationFor("localhost:3001"), "shared-host");
    // No resolver registered yet: a live token still gets a sandboxed 404.
    const { token } = rt.viewTokens().mint({ artifactId: "a", versionN: 1, type: "page" });
    const r = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: p, path: `/v/${token}/` }, (res) => { res.resume(); res.on("end", () => resolve(res)); }).on("error", reject);
    });
    assert.equal(r.statusCode, 404);
    assert.match(r.headers["content-security-policy"], /sandbox/);
  } finally { rt._resetForTest(); }

  const p2 = await freePort();
  await rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: String(p2), CROW_ARTIFACT_ORIGIN_URL: "https://art.example" });
  try {
    assert.deepEqual(rt.artifactOriginInfo(), { baseUrl: "https://art.example", port: p2, configured: true });
    assert.equal(rt.isolationFor("crow.example:8444"), "own-host");
    assert.equal(rt.isolationFor("ART.example"), "shared-host", "same hostname, any case or port, is shared");
  } finally { rt._resetForTest(); }
});

test("runtime: a second start-from-env returns the running server instead of orphaning it (review L6)", async () => {
  const rt = await import("../servers/gateway/artifact-origin/runtime.js");
  rt._resetForTest();
  const p = await freePort();
  const a = await rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: String(p) });
  try {
    assert.ok(a);
    const b = await rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: String(p) });
    assert.equal(a, b, "the same server object; no orphaned listener");
    assert.equal(b.address().port, p);
  } finally { rt._resetForTest(); }
});

test("viewerCsp: frame-src is only the artifact origin's /v/ path; anything that is not a bare origin frames nothing", async () => {
  const { viewerCsp } = await import("../servers/gateway/artifact-origin/policy.js");
  const frameSrc = (csp) => /(?:^|; )frame-src ([^;]*)/.exec(csp)?.[1];
  assert.equal(frameSrc(viewerCsp("https://art.example")), "https://art.example/v/");
  assert.equal(frameSrc(viewerCsp("http://localhost:3090")), "http://localhost:3090/v/");
  for (const bad of [null, "", "https://art.example/x", "https://art.example; frame-src *", "https://*.example", "javascript:x", "https://a.example:3090 https:"]) {
    assert.equal(frameSrc(viewerCsp(bad)), "'none'", `refused: ${String(bad)}`);
  }
  const csp = viewerCsp("https://art.example");
  assert.doesNotMatch(frameSrc(csp), /'self'|https:(?!\/\/)/, "no 'self', no scheme source");
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});
