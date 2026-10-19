/**
 * Caddy federation profiles (bundles/caddy/server/federation-profiles.js): the two
 * split-upstream profiles, lemmy and activitypub-mastodon, and the validation of the
 * second upstream they take.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const P = await import("../bundles/caddy/server/federation-profiles.js");
const { upsertRawSite, parseSites } = await import("../bundles/caddy/server/caddyfile.js");

const balanced = (s) => {
  let d = 0;
  for (const ch of s) { if (ch === "{") d++; else if (ch === "}") { d--; if (d < 0) return false; } }
  return d === 0;
};
const handles = (s) => s.split("\n").filter((l) => /^handle\b/.test(l));

test("every profile renders balanced braces", () => {
  for (const p of P.SUPPORTED_PROFILES) {
    const out = P.renderProfileDirectives(p, "app:80", P.profileTakesBackend(p) ? { backend: "api:81" } : {});
    assert.ok(balanced(out), p);
  }
});

test("lemmy: API, media, feeds, nodeinfo, well-known, ActivityPub and POST go to the backend; the rest to lemmy-ui", () => {
  const out = P.renderProfileDirectives("lemmy", "crow-lemmy-ui:1234", { backend: "crow-lemmy:8536" });
  const pathLine = out.split("\n").find((l) => /^\s*path /.test(l));
  // lemmy-ansible's nginx rules (0.19 line).
  assert.deepEqual(pathLine.trim().split(/\s+/).slice(1), ["/api", "/api/*", "/pictrs", "/pictrs/*", "/feeds", "/feeds/*", "/nodeinfo", "/nodeinfo/*", "/version", "/.well-known/*", "/sitemap.xml"]);
  const block = (name) => out.slice(out.indexOf(`@${name} {`), out.indexOf("}", out.indexOf(`@${name} {`)) + 1);
  assert.match(block("lemmy_activitypub"), /^\s*method GET HEAD$/m);
  assert.match(block("lemmy_activitypub"), /^\s*header_regexp Accept \(\?i\)application\/\(activity\|ld\)\[\+\]json$/m);
  assert.match(block("lemmy_write"), /^\s*not method GET HEAD$/m);
  assert.doesNotMatch(out, /\\/, "no backslash for the Caddyfile lexer");
  // The rendered regex itself (Go's (?i) prefix becomes JS's "i" flag).
  const rendered = block("lemmy_activitypub").match(/header_regexp Accept (\S+)/)[1];
  const re = new RegExp(rendered.replace(/^\(\?i\)/, ""), "i");
  for (const ok of ["application/activity+json", 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"', "text/html, Application/Activity+JSON"]) assert.match(ok, re, ok);
  for (const no of ["application/json", "text/html", "application/xhtml+xml"]) assert.doesNotMatch(no, re, no);
  const h = handles(out);
  assert.deepEqual(h, ["handle @lemmy_backend {", "handle @lemmy_activitypub {", "handle @lemmy_write {", "handle {"]);
  // The three routed handles proxy to the backend, the catch-all to the UI.
  const blocks = out.split(/^handle /m).slice(1);
  for (const b of blocks.slice(0, 3)) assert.match(b, /reverse_proxy crow-lemmy:8536 \{/);
  assert.match(blocks[3], /reverse_proxy crow-lemmy-ui:1234 \{/);
  assert.doesNotMatch(blocks[3], /crow-lemmy:8536/);
  assert.match(out, /max_size 40MB/);
  assert.match(out, /header_up X-Forwarded-Proto \{scheme\}/);
});

test("lemmy and activitypub-mastodon have default backends (the containers' names)", () => {
  assert.match(P.renderProfileDirectives("lemmy", "crow-lemmy-ui:1234"), /reverse_proxy crow-lemmy:8536 \{/);
  assert.match(P.renderProfileDirectives("activitypub-mastodon", "crow-mastodon-web:3000"), /reverse_proxy crow-mastodon-streaming:4000 \{/);
});

test("activitypub-mastodon: the streaming API goes to the streaming server, the rest to web", () => {
  const out = P.renderProfileDirectives("activitypub-mastodon", "crow-mastodon-web:3000", { backend: "crow-mastodon-streaming:4000" });
  assert.match(out, /^@mastodon_streaming path \/api\/v1\/streaming \/api\/v1\/streaming\/\*$/m);
  assert.doesNotMatch(out.split(/^handle /m)[1], /read_timeout/, "no read timeout on the long-lived stream");
  const blocks = out.split(/^handle /m).slice(1);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^@mastodon_streaming \{/);
  assert.match(blocks[0], /reverse_proxy crow-mastodon-streaming:4000 \{/);
  assert.match(blocks[1], /^\{/);
  assert.match(blocks[1], /reverse_proxy crow-mastodon-web:3000 \{/);
});

test("a second upstream is refused for a profile that has one upstream (never silently ignored)", () => {
  for (const p of ["activitypub", "matrix", "peertube", "generic-ws"]) {
    assert.throws(() => P.renderProfileDirectives(p, "app:80", { backend: "api:81" }), /backend/i, p);
  }
});

test("upstreams are host[:port] only: nothing that could end the line, open a block or start a comment", () => {
  for (const ok of ["crow-lemmy:8536", "lemmy:8536", "crow_x:1", "http://crow-lemmy:8536", "HTTPS://crow-lemmy:443", "lemmy", "crow-lemmy:65535"]) {
    assert.equal(P.upstreamLike(ok), true, ok);
  }
  for (const bad of ["a b", "a\nb", "a{", "a}", "a#x", "a;b", "", "a:99999", "a:65536", "a:0", "a:8/x", "-x", "a\"b", "a'b", "a`b", "unix//x", "$x", "a\\b",
    "lemmy.example.com:80", "crow-lemmy.:80", "10.89.0.5:8040", "[fd00::5]:8040", "1x:80"]) {
    assert.equal(P.upstreamLike(bad), false, JSON.stringify(bad));
  }
  // Never Caddy itself: its admin API (0.0.0.0:2019 inside its container) would take a
  // proxied POST /load from the internet. Fail-closed: IP literals in every form are out.
  for (const caddy of ["127.0.0.1:2019", "crow-lemmy:2019", "crow-lemmy:02019", "crow-lemmy:002019", "crow-lemmy:+2019", "localhost:8080", "LOCALHOST:1", "x.localhost:1",
    "localhost.:80", "127.0.0.2:80", "127.1:80", "2130706433:80", "0x7f000001:80", "0x7f.1:80", "0177.0.0.1:80", "0.0.0.0:80", "0:80", "[::1]:80", "[::]:80",
    "[0:0:0:0:0:0:0:1]:80", "[::ffff:127.0.0.1]:80", "[::ffff:7f00:1]:80", "crow-caddy:80", "CROW-CADDY:80", "caddy:443", "http://127.0.0.1:8536", "localtest.me:80"]) {
    assert.ok(P.upstreamProblem(caddy), caddy);
    assert.throws(() => P.renderProfileDirectives("lemmy", "crow-lemmy-ui:1234", { backend: caddy }), /upstream/, caddy);
    assert.throws(() => P.renderProfileDirectives("activitypub", caddy), /upstream/, caddy);
  }
  assert.match(P.upstreamProblem("crow-lemmy:02019"), /leading zeros/);
  assert.match(P.upstreamProblem("crow-lemmy:2019"), /2019/);
  assert.match(P.upstreamProblem("crow-caddy:80"), /Caddy itself/);
  assert.throws(() => P.renderProfileDirectives("lemmy", "crow-lemmy-ui:1234", { backend: "x # y" }), /upstream/i);
  assert.throws(() => P.renderProfileDirectives("lemmy", "x{", {}), /upstream/i);
});

test("the rendered site round-trips through the Caddyfile writer: one block, well-known handles first", () => {
  const body = [P.renderWellKnownHandle("/.well-known/nodeinfo", '{"links":[]}'), P.renderProfileDirectives("lemmy", "crow-lemmy-ui:1234")].join("\n");
  const src = upsertRawSite("{\n  admin 0.0.0.0:2019\n}\n", "lemmy.example.com", body);
  const sites = parseSites(src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].address, "lemmy.example.com");
  assert.ok(balanced(src));
  const order = sites[0].body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("handle"));
  assert.equal(order[0], "handle /.well-known/nodeinfo {");
  // Re-running replaces, never duplicates.
  const again = upsertRawSite(src, "lemmy.example.com", body);
  assert.equal(parseSites(again).length, 1);
});

// ---- the tool handlers (an in-memory MCP client, a stub admin API, a scratch config) ----

import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createCaddyServer } = await import("../bundles/caddy/server/server.js");

async function withTools(names, fn) {
  const loads = [];
  const admin = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { loads.push({ url: req.url, body: b }); res.end("{}"); }); });
  await new Promise((r) => admin.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "crow-caddy-tools-"));
  const saved = { a: process.env.CADDY_ADMIN_URL, c: process.env.CADDY_CONFIG_DIR };
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${admin.address().port}`;
  process.env.CADDY_CONFIG_DIR = dir;
  const server = createCaddyServer({ networkNames: async () => { if (names instanceof Error) throw names; return new Set(names); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("");
  try { return await fn(call, { loads, caddyfile: () => (existsSync(join(dir, "Caddyfile")) ? readFileSync(join(dir, "Caddyfile"), "utf8") : "") }); } finally {
    await client.close(); admin.close(); rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["CADDY_ADMIN_URL", saved.a], ["CADDY_CONFIG_DIR", saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("tool: the lemmy profile writes one split site when both containers are on Caddy's network", async () => {
  await withTools(["crow-lemmy", "crow-lemmy-ui", "lemmy"], async (call, { loads, caddyfile }) => {
    const out = await call("caddy_add_federation_site", { domain: "lemmy.example.com", upstream: "crow-lemmy-ui:1234", profile: "lemmy" });
    assert.match(out, /Added federation site lemmy\.example\.com/, out);
    assert.equal(loads.length, 1);
    assert.match(caddyfile(), /handle @lemmy_write \{/);
  });
});

test("tool: upstreams must be containers on crow-federation; Caddy itself, its admin port and unknown names are refused (all three tools)", async () => {
  await withTools(["crow-lemmy-ui", "crow-dendrite"], async (call, { loads }) => {
    const cases = [
      ["caddy_add_federation_site", { domain: "l.example.com", upstream: "crow-lemmy-ui:1234", profile: "lemmy" }, /crow-lemmy is not a container/],
      ["caddy_add_federation_site", { domain: "l.example.com", upstream: "crow-lemmy-ui:1234", profile: "lemmy", backend_upstream: "crow-lemmy-ui:2019" }, /2019/],
      ["caddy_add_federation_site", { domain: "g.example.com", upstream: "grackle:3002", profile: "activitypub" }, /not a container/],
      ["caddy_add_site", { domain: "a.example.com", upstream: "localhost:2019" }, /Caddy/],
      ["caddy_add_site", { domain: "a.example.com", upstream: "127.0.0.1:3001" }, /upstream/],
      ["caddy_add_matrix_federation_port", { domain: "m.example.com", upstream_8448: "crow-caddy:2019" }, /2019|Caddy/],
      ["caddy_add_matrix_federation_port", { domain: "m.example.com", upstream_8448: "tailnet-box:8448" }, /not a container/],
    ];
    for (const [tool, args, re] of cases) assert.match(await call(tool, args), re, `${tool} ${JSON.stringify(args)}`);
    assert.equal(loads.length, 0, "nothing reached Caddy");
    assert.match(await call("caddy_add_matrix_federation_port", { domain: "m.example.com", upstream_8448: "crow-dendrite:8448" }), /Added Matrix federation listener/);
  });
  await withTools(new Error("docker: not found"), async (call, { loads }) => {
    assert.match(await call("caddy_add_site", { domain: "a.example.com", upstream: "crow-x:80" }), /could not list the containers/, "fail-closed without Docker");
    assert.equal(loads.length, 0);
  });
});

test("tool: wellknown is refused for the split profiles; a wellknown body_json must be JSON", async () => {
  await withTools(["crow-lemmy", "crow-lemmy-ui", "crow-gotosocial"], async (call, { loads }) => {
    assert.match(await call("caddy_add_federation_site", { domain: "l.example.com", upstream: "crow-lemmy-ui:1234", profile: "lemmy", wellknown: { nodeinfo: { href: "https://l.example.com/nodeinfo/2.0" } } }), /leave wellknown out/);
    assert.match(await call("caddy_add_federation_site", { domain: "g.example.com", upstream: "crow-gotosocial:8080", profile: "activitypub", wellknown: { nodeinfo: { body_json: "{not json" } } }), /not valid JSON/);
    assert.match(await call("caddy_add_federation_site", { domain: "g.example.com", upstream: "crow-gotosocial:8080", profile: "activitypub", backend_upstream: "crow-lemmy:8536" }), /backend/i);
    assert.equal(loads.length, 0);
  });
});

test("tool: caddy_add_site's extra_directives can't close the block, proxy elsewhere or reach the admin API", async () => {
  await withTools(["crow-gotosocial"], async (call, { loads }) => {
    for (const bad of ["}\n:9443 {\nreverse_proxy localhost:2019", "reverse_proxy crow-x:80", "import /etc/x", "handle /x {", "respond 2019", "header X 1 # c", "admin off"]) {
      assert.match(await call("caddy_add_site", { domain: "a.example.com", upstream: "crow-gotosocial:8080", extra_directives: bad }), /extra_directives/, JSON.stringify(bad));
    }
    assert.equal(loads.length, 0);
    assert.match(await call("caddy_add_site", { domain: "a.example.com", upstream: "crow-gotosocial:8080", extra_directives: "encode gzip\nheader X-Frame-Options DENY" }), /Added site/);
  });
});
