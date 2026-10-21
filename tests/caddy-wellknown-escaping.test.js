/**
 * Caddy well-known handlers (queue item 26f): a user-supplied value in a
 * `respond "<json>"` body can never become a Caddy placeholder ({$ENV} at parse
 * time, {env.X} / {file.X} / {http.*} at request time) or end the quoted token,
 * and the JSON the client receives is exactly the JSON that was asked for.
 *
 * Caddy semantics modelled here (caddyserver/caddy master, read 2026-10-20):
 *  - caddyfile/lexer.go: inside "...", a backslash escapes only `"`; `\x` stays `\x`.
 *  - caddyfile/parse.go replaceEnvVars: `{$NAME}` is replaced on the raw text first.
 *  - replacer.go replace(): every unescaped `{` up to the next `}` is a key; an unknown
 *    key is skipped and the scan resumes at the next character (nested keys expand).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const P = await import("../bundles/caddy/server/federation-profiles.js");

/** The token inside respond "...": the lexer's view of a quoted string. */
function lexQuoted(line) {
  const start = line.indexOf('"');
  let out = "";
  let escaped = false;
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i];
    if (!escaped && ch === "\\") { escaped = true; continue; }
    if (escaped) { if (ch !== '"') out += "\\"; out += ch; escaped = false; continue; }
    if (ch === '"') return { token: out, rest: line.slice(i + 1) };
    out += ch;
  }
  throw new Error("unterminated quoted token");
}
const respondLine = (block) => block.split("\n").find((l) => /^\s*respond /.test(l));

/** Every key Caddy's replacer would look up in `s` (unknown keys resume at the next char). */
function replacerKeys(s) {
  const keys = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{" || (i > 0 && s[i - 1] === "\\")) continue;
    const end = s.indexOf("}", i);
    if (end < 0) continue;
    keys.push(s.slice(i + 1, end));
  }
  return keys;
}

const HOSTILE = [
  "{$CADDY_EMAIL}",
  "{env.HOME}",
  "{file./srv/caddy/caddy/acme/key.pem}",
  "{http.request.header.Authorization}",
  "\\{env.HOME\\}",
  "{host}",
  "{$X:default}",
  'a"b',
  "back\\slash",
  'tail\\',
  "\\\"",
  "new\nline",
  "uni ☃  ",
  "}{",
];

function assertSafe(block, expectedValue, label) {
  const line = respondLine(block);
  assert.ok(line, `${label}: has a respond line`);
  assert.ok(!block.includes("{$"), `${label}: no parse-time env span`);
  const { token, rest } = lexQuoted(line);
  assert.match(rest, /^ 200$/, `${label}: the quoted token ends where it should (rest=${JSON.stringify(rest)})`);
  for (const key of replacerKeys(token)) {
    assert.ok(key === "" || key.startsWith('"'), `${label}: replacer key ${JSON.stringify(key)} could match a placeholder`);
  }
  assert.deepEqual(JSON.parse(token), expectedValue, `${label}: JSON round-trips`);
}

test("renderWellKnownHandle: hostile strings stay data, and the JSON round-trips", () => {
  for (const v of HOSTILE) {
    const value = { "m.server": v, links: [{ href: v, [v]: [v, 1, true, null] }] };
    assertSafe(P.renderWellKnownHandle("/.well-known/matrix/server", JSON.stringify(value)), value, JSON.stringify(v));
  }
  // A body that is not an object at all (body_json is the caller's own JSON).
  for (const value of [["{env.HOME}"], "{file./etc/passwd}", { "": {} }, {}, [], { a: {} }]) {
    assertSafe(P.renderWellKnownHandle("/.well-known/nodeinfo", JSON.stringify(value)), value, JSON.stringify(value));
  }
});

test("renderWellKnownHandle: pretty-printed or escaped input is normalised; invalid JSON throws", () => {
  const value = { a: "x\"y", b: "{env.X}" };
  assertSafe(P.renderWellKnownHandle("/.well-known/nodeinfo", JSON.stringify(value, null, 2)), value, "pretty");
  assertSafe(P.renderWellKnownHandle("/.well-known/nodeinfo", '{"a":"\\u007benv.X\\u007d"}'), { a: "{env.X}" }, "pre-escaped");
  assert.throws(() => P.renderWellKnownHandle("/.well-known/nodeinfo", "{not json"));
  assert.throws(() => P.renderWellKnownHandle("/.well-known/nodeinfo", '{"a":1e400}'), /too large/);
});

test("buildWellKnownJson values (delegate_to, homeserver_base_url, href) cannot inject either", () => {
  const cases = [
    ["matrix-server", { delegate_to: "{env.SECRET}:443" }],
    ["matrix-client", { homeserver_base_url: "https://{$CADDY_EMAIL}", identity_server_base_url: "{file./etc/shadow}" }],
    ["nodeinfo", { href: 'https://x/"}\n}\n:80 {\nrespond {env.HOME}' }],
  ];
  for (const [kind, opts] of cases) {
    const json = P.buildWellKnownJson(kind, opts);
    assertSafe(P.renderWellKnownHandle(P.WELLKNOWN_PATHS[kind], json), JSON.parse(json), kind);
  }
});

async function withTools(names, fn) {
  const loads = [];
  const admin = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { loads.push({ url: req.url, body: b }); res.end("{}"); }); });
  await new Promise((r) => admin.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "crow-caddy-wk-"));
  const saved = { a: process.env.CADDY_ADMIN_URL, c: process.env.CADDY_CONFIG_DIR };
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${admin.address().port}`;
  process.env.CADDY_CONFIG_DIR = dir;
  const { createCaddyServer } = await import("../bundles/caddy/server/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createCaddyServer({ networkNames: async () => new Set(names) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("");
  try { return await fn(call, { loads, caddyfile: () => (existsSync(join(dir, "Caddyfile")) ? readFileSync(join(dir, "Caddyfile"), "utf8") : "") }); } finally {
    await client.close(); admin.close(); rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["CADDY_ADMIN_URL", saved.a], ["CADDY_CONFIG_DIR", saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("tools: caddy_set_wellknown and caddy_add_federation_site write no live placeholder", async () => {
  await withTools(["crow-gotosocial"], async (call, { loads, caddyfile }) => {
    let out = await call("caddy_set_wellknown", { domain: "example.com", kind: "matrix-server", opts: { delegate_to: "{env.HOME}" } });
    assert.match(out, /Set well-known/, out);
    out = await call("caddy_set_wellknown", { domain: "example.com", kind: "nodeinfo", body_json: '["{$CADDY_EMAIL}","{file./etc/passwd}"]' });
    assert.match(out, /Set well-known/, out);
    out = await call("caddy_add_federation_site", { domain: "g.example.com", upstream: "crow-gotosocial:8080", profile: "activitypub", wellknown: { nodeinfo: { href: "https://g.example.com/{env.SECRET}" } } });
    assert.match(out, /federation site/, out);
    for (const text of [caddyfile(), ...loads.map((l) => l.body)]) {
      assert.ok(!/\{\$|\{env\.|\{file\.|\{http\./.test(text), text);
    }
    assert.match(caddyfile(), /\\u007benv\.HOME\\u007d/);
    // Replacing the same handle again (the brace-counting block replacer) keeps one clean block.
    out = await call("caddy_set_wellknown", { domain: "example.com", kind: "matrix-server", opts: { delegate_to: "}}{{{env.HOME}" } });
    assert.match(out, /Set well-known/, out);
    const site = caddyfile().split("\n\n").find((b) => b.startsWith("example.com"));
    assert.equal((site.match(/handle \/\.well-known\/matrix\/server/g) || []).length, 1, site);
    assert.equal((site.match(/handle \/\.well-known\/nodeinfo/g) || []).length, 1, site);
    assert.match(site, /\\u007d\\u007d\\u007b\\u007b\\u007benv\.HOME\\u007d/);
  });
});

test("site addresses are a hostname allowlist: quotes, #, $, |, backslash and braces are refused", async () => {
  await withTools(["crow-gotosocial"], async (call, { loads }) => {
    for (const domain of ['a.example.com"', "a.example.com#x", "{$HOME}.example.com", "a|b.example.com", "a\\b.example.com", "a{b}.example.com", "a b.example.com", "a`b.example.com", "a;b.example.com", "import", "IMPORT"]) {
      for (const [tool, extra] of [["caddy_add_site", { upstream: "crow-gotosocial:8080" }], ["caddy_set_wellknown", { kind: "matrix-server", opts: { delegate_to: "m.example.com:443" } }], ["caddy_add_federation_site", { upstream: "crow-gotosocial:8080", profile: "activitypub" }]]) {
        assert.match(await call(tool, { domain, ...extra }), /domain/i, `${tool} ${JSON.stringify(domain)}`);
      }
    }
    assert.equal(loads.length, 0);
    for (const domain of ["a.example.com", "*.example.com", ":8080", "[::1]:8443", "http://a.example.com", "a.example.com/path", "xn--bcher-kva.example"]) {
      const out = await call("caddy_add_site", { domain, upstream: "crow-gotosocial:8080" });
      assert.match(out, /Added site/, `${domain}: ${out}`);
    }
  });
});
