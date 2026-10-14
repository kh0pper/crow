// D24 (spec v1.6): a frame that never loaded shows "couldn't load — retry";
// a frame whose content was parsed and stayed silent is still flagged. The
// decision rides SERVER-side, per-token evidence the frame content cannot
// touch: did the origin serve this token's document, inject the anchor
// helper into it, and serve the helper (a parser-blocking script placed
// before any bot byte)?
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { startArtifactOrigin } from "../servers/gateway/artifact-origin/server.js";
import { createViewTokenStore, loadDecision, TOKEN_ID_RE } from "../servers/gateway/artifact-origin/view-tokens.js";

const sha = (t) => createHash("sha256").update(t).digest("hex");

let server, port, tokens;
const FILES = {
  "index.html": { body: "<!doctype html><html><body>hi</body></html>", contentType: "text/html; charset=utf-8" },
  "app.js": { body: "1", contentType: "text/javascript" },
};
const TEXT = { "index.html": { body: "plain", contentType: "text/plain" } };
before(async () => {
  tokens = createViewTokenStore();
  server = await startArtifactOrigin({
    port: 0, tokens, publicBase: null,
    resolveContent: async (q) => (q.artifactId === "txt" ? TEXT : FILES)[q.path] || null,
  });
  port = server.address().port;
});
after(() => { server?.closeAllConnections?.(); server?.close(); });

function req(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject); r.end();
  });
}
const mintPage = (o = {}) => tokens.mint({ artifactId: "a1", versionN: 1, type: "page", dashboardOrigin: "https://dash.example", ...o });

test("mint returns a tokenId: the SHA-256 the store keys on, never the secret", () => {
  const g = mintPage();
  assert.match(g.tokenId, TOKEN_ID_RE);
  assert.equal(g.tokenId, sha(g.token));
  assert.notEqual(g.tokenId, g.token);
  const ev = tokens.evidence(g.tokenId);
  assert.deepEqual(ev, { artifactId: "a1", versionN: 1, scripted: true, docServed: false, helperInjected: false, helperServed: false });
});

test("the origin records docServed + helperInjected on the document and helperServed on the helper", async () => {
  const g = mintPage();
  const r = await req(`/v/${g.token}/`);
  assert.equal(r.status, 200);
  let ev = tokens.evidence(g.tokenId);
  assert.equal(ev.docServed, true);
  assert.equal(ev.helperInjected, true);
  assert.equal(ev.helperServed, false, "the document alone does not prove it was parsed");
  assert.equal((await req(`/v/${g.token}/__crow/anchor-helper.js?n=x`)).status, 200);
  ev = tokens.evidence(g.tokenId);
  assert.equal(ev.helperServed, true);
});

test("HEAD, 404s and subresources never count as the document or the helper", async () => {
  const g = mintPage();
  await req(`/v/${g.token}/`, "HEAD");
  await req(`/v/${g.token}/__crow/anchor-helper.js`, "HEAD");
  await req(`/v/${g.token}/missing.html`);
  await req(`/v/${g.token}/app.js`);
  assert.deepEqual(tokens.evidence(g.tokenId), { artifactId: "a1", versionN: 1, scripted: true, docServed: false, helperInjected: false, helperServed: false });
});

test("a non-HTML document is served without the helper (docServed, no helperInjected)", async () => {
  const g = tokens.mint({ artifactId: "txt", versionN: 1, type: "page", dashboardOrigin: null });
  await req(`/v/${g.token}/`);
  const ev = tokens.evidence(g.tokenId);
  assert.equal(ev.docServed, true);
  assert.equal(ev.helperInjected, false);
});

test("a scripts-off (D20) or sealed grant is recorded as not speaking; a document (D28) speaks", async () => {
  const off = mintPage({ scriptsOff: true });
  await req(`/v/${off.token}/`);
  assert.equal(tokens.evidence(off.tokenId).scripted, false);
  assert.equal(tokens.evidence(off.tokenId).helperInjected, false);
  const dia = tokens.mint({ artifactId: "a1", versionN: 1, type: "diagram", dashboardOrigin: null });
  assert.equal(tokens.evidence(dia.tokenId).scripted, false);
  const doc = tokens.mint({ artifactId: "a1", versionN: 1, type: "document", dashboardOrigin: null });
  assert.equal(tokens.evidence(doc.tokenId).scripted, true, "D28: the no-helper → flag arm of the D24 table applies to documents too (review M2)");
});

test("evidence is unknown (null) after revokeToken, revokeArtifact, expiry, or for a bad id", () => {
  let t = 0;
  const s = createViewTokenStore({ now: () => t, ttlMs: 100 });
  const a = s.mint({ artifactId: "x", versionN: 1, type: "page", dashboardOrigin: null });
  const b = s.mint({ artifactId: "x", versionN: 1, type: "page", dashboardOrigin: null });
  assert.ok(s.evidence(a.tokenId));
  assert.equal(s.revokeToken(a.tokenId), true);
  assert.equal(s.evidence(a.tokenId), null);
  assert.equal(s.check(a.token), null, "a revoked token no longer serves");
  assert.ok(s.check(b.token), "revokeToken drops only that token");
  assert.equal(s.revokeToken(a.tokenId), false, "unknown id: nothing to revoke");
  t = 101;
  assert.equal(s.evidence(b.tokenId), null, "expired");
  for (const bad of [undefined, null, "", "zz", b.token, "A".repeat(64), {}]) assert.equal(s.evidence(bad), null);
  const c = s.mint({ artifactId: "y", versionN: 1, type: "page", dashboardOrigin: null });
  s.revokeArtifact("y");
  assert.equal(s.evidence(c.tokenId), null);
});

test("evidence() returns a copy: callers cannot write the record", () => {
  const g = mintPage();
  const ev = tokens.evidence(g.tokenId);
  ev.helperServed = true;
  assert.equal(tokens.evidence(g.tokenId).helperServed, false);
  const grant = tokens.check(g.token);
  grant.ev = { helperServed: true };
  assert.equal(tokens.evidence(g.tokenId).helperServed, false);
});

test("loadDecision: the D24 table", () => {
  const ev = (o) => ({ artifactId: "a", versionN: 1, scripted: true, docServed: false, helperInjected: false, helperServed: false, ...o });
  assert.deepEqual(loadDecision(ev({ docServed: true, helperInjected: true, helperServed: true })), { decision: "flag", reason: "parsed-no-hello" });
  assert.deepEqual(loadDecision(ev({ docServed: true, helperInjected: false })), { decision: "flag", reason: "no-helper" });
  assert.deepEqual(loadDecision(ev({ docServed: true, helperInjected: true })), { decision: "retry", reason: "not-parsed" });
  assert.deepEqual(loadDecision(ev({})), { decision: "retry", reason: "not-served" });
  assert.deepEqual(loadDecision(null), { decision: "retry", reason: "unknown" });
  // helperServed wins no matter what else is (or is not) recorded: content
  // can only ADD evidence, and adding it can only move toward a flag.
  assert.equal(loadDecision(ev({ helperServed: true })).decision, "flag");
  assert.deepEqual(loadDecision(ev({ scripted: false, docServed: true })), { decision: "retry", reason: "not-scripted" });
});
