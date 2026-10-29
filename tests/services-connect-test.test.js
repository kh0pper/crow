import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { lookup as dnsLookup } from "node:dns";
import { rememberInstanceSecretsDirs } from "../servers/shared/secret-values.js";
import {
  renderTemplate, normalizeAddress, testConnection, isForbiddenTarget, probeOwnAddresses, folderRefusal, BODY_CAP_BYTES,
} from "../servers/gateway/services/connect-test.js";

const ERROR_CLASSES = new Set([
  "unreachable", "auth_failed", "timeout", "bad_address", "redirect",
  "unexpected_response", "forbidden_target", "not_found", "not_a_vault", "bad_value",
]);

const servers = [];
after(() => { for (const s of servers) s.close(); });

/** A local fixture. Returns { port, hits, url, last }. */
async function fixture(handler) {
  const state = { hits: 0, last: null };
  const srv = http.createServer((req, res) => {
    state.hits++;
    state.last = { url: req.url, headers: req.headers };
    handler(req, res);
  });
  srv.on("connection", (s) => srv._socks.add(s));
  srv._socks = new Set();
  const close = srv.close.bind(srv);
  srv.close = () => { for (const s of srv._socks) s.destroy(); close(); };
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  state.port = srv.address().port;
  state.url = `http://127.0.0.1:${state.port}`;
  return state;
}

const HA_FIELDS = [
  { name: "HA_URL", kind: "address" },
  { name: "HA_TOKEN", kind: "secret" },
];
const haService = (expect = [200]) => ({
  id: "home-assistant",
  fields: HA_FIELDS,
  labelFrom: "address",
  test: { kind: "http", url: "${HA_URL}/api/", headers: { Authorization: "Bearer ${HA_TOKEN}" }, expect },
});
// The gateway port in most tests: one nobody listens on, so the fixture's port is never "own".
const NOT_GATEWAY = 1;

function assertClass(r, cls) {
  assert.equal(r.ok, false);
  assert.equal(r.error, cls);
  assert.ok(ERROR_CLASSES.has(r.error));
  assert.deepEqual(Object.keys(r).sort(), ["error", "ok"]);
}

// ---------- normalizeAddress ----------

test("normalizeAddress: trims, strips one trailing slash, canonical form", () => {
  assert.equal(normalizeAddress("  http://ha.example.lan:8123/  "), "http://ha.example.lan:8123");
  assert.equal(normalizeAddress("https://canvas.example.lan/sub/"), "https://canvas.example.lan/sub");
  assert.equal(normalizeAddress("https://canvas.example.lan/sub//"), "https://canvas.example.lan/sub/");
  assert.equal(normalizeAddress("HTTP://HA.Example.LAN"), "http://ha.example.lan");
});

test("normalizeAddress: refuses non-http schemes, userinfo, no host, query, fragment", () => {
  for (const bad of [
    "file:///etc/passwd", "javascript:alert(1)", "ftp://ha.example.lan",
    "http://user:pw@ha.example.lan", "http://user@ha.example.lan", "http://@ha.example.lan",
    "@evil.example/", "ha.example.lan", "", null, undefined, 42, "http://",
    "http://ha.example.lan/?x=1", "http://ha.example.lan/#frag", "http://ha.example.lan/?",
  ]) {
    assert.equal(normalizeAddress(bad), null, String(bad));
  }
});

// ---------- renderTemplate ----------

test("renderTemplate: address fields normalised, others encodeURIComponent'd in a URL", () => {
  const fields = [{ name: "BASE", kind: "address" }, { name: "ID", kind: "text" }, { name: "KEY", kind: "secret" }];
  assert.equal(
    renderTemplate("${BASE}/users/${ID}/items?key=${KEY}", { BASE: "https://zotero.example.lan/", ID: "a b/c", KEY: "k&v=1#x" }, { fields }),
    "https://zotero.example.lan/users/a%20b%2Fc/items?key=k%26v%3D1%23x",
  );
});

test("renderTemplate: a value can't change the URL's host", () => {
  const fields = [{ name: "ID", kind: "text" }, { name: "BASE", kind: "address" }];
  const out = renderTemplate("https://api.example.lan/u/${ID}", { ID: "@evil.example/" }, { fields });
  assert.equal(out, "https://api.example.lan/u/%40evil.example%2F");
  assert.equal(new URL(out).hostname, "api.example.lan");
  // An address field carrying userinfo is refused, not inserted.
  assert.throws(() => renderTemplate("${BASE}/api/", { BASE: "http://ha.example.lan@evil.example/" }, { fields }), { code: "bad_address" });
  assert.throws(() => renderTemplate("${BASE}/api/", { BASE: "@evil.example/" }, { fields }), { code: "bad_address" });
  // A placeholder in the authority (no shipped manifest does this) is caught by the host check.
  assert.throws(() => renderTemplate("https://api.example.lan${ID}/x", { ID: ".evil.example" }, { fields }), { code: "bad_address" });
});

test("renderTemplate: header values lose CR/LF/NUL, so no new header line", () => {
  const fields = [{ name: "TOKEN", kind: "secret" }];
  const out = renderTemplate("Bearer ${TOKEN}", { TOKEN: "abc\r\nX: y\0z" }, { fields, in: "header" });
  assert.equal(out, "Bearer abcX: yz");
  assert.doesNotMatch(out, /[\r\n\0]/);
});

test("renderTemplate: unknown or missing values render empty", () => {
  assert.equal(renderTemplate("https://x.example.lan/a${NOPE}b", {}, { fields: [] }), "https://x.example.lan/ab");
  assert.equal(renderTemplate("a${NOPE}b", {}, { fields: [], in: "header" }), "ab");
});

// ---------- isForbiddenTarget ----------

test("isForbiddenTarget: loopback, unspecified and own addresses in every spelling", () => {
  const own = new Set(["localhost", "127.0.0.1", "::1", "100.64.20.5", "fd00::5"]);
  for (const a of [
    "127.0.0.1", "127.9.9.9", "::1", "0.0.0.0", "::", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "[::ffff:7f00:1]", "0:0:0:0:0:0:0:1", "::ffff:0.0.0.0", "100.64.20.5", "::ffff:100.64.20.5",
    "FD00:0::5", "localhost", "localhost.", "a.localhost",
  ]) {
    assert.equal(isForbiddenTarget(a, own), true, a);
  }
  for (const a of ["203.0.113.7", "100.64.20.6", "fd00::6", "ha.example.lan"]) {
    assert.equal(isForbiddenTarget(a, own), false, a);
  }
});

test("new URL folds decimal, octal, hex and short IPv4 to the dotted form the check sees", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const s = { fields: [{ name: "U", kind: "address" }], test: { kind: "http", url: "${U}/", expect: [200] } };
  for (const host of ["2130706433", "017700000001", "0x7f.0.0.1", "127.1", "[::ffff:127.0.0.1]", "0"]) {
    const r = await testConnection(s, { values: { U: `http://${host}:${fx.port}` }, gatewayPort: fx.port, ownAddrs: new Set() });
    assertClass(r, "forbidden_target");
  }
  assert.equal(fx.hits, 0);
});

// ---------- http probe ----------

test("ok and label: expected status passes; loopback address gets the 'this Crow' label", async () => {
  const fx = await fixture((req, res) => { res.writeHead(200); res.end("{\"message\":\"API running.\"}"); });
  const r = await testConnection(haService(), {
    values: { HA_URL: fx.url + "/", HA_TOKEN: "test-token-1" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(),
  });
  assert.deepEqual(r, { ok: true, label: `this Crow :${fx.port}` });
  assert.equal(fx.last.url, "/api/");
  assert.equal(fx.last.headers.authorization, "Bearer test-token-1");
  const es = await testConnection(haService(), {
    values: { HA_URL: fx.url, HA_TOKEN: "test-token-1" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), lang: "es",
  });
  assert.deepEqual(es, { ok: true, label: `este Crow :${fx.port}` });
});

test("label: a non-loopback address labels with its hostname (resolved through the checked lookup)", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const resolve = (host, opts, cb) => dnsLookup("127.0.0.1", opts, cb);
  const r = await testConnection(haService(), {
    values: { HA_URL: `http://ha.example.lan:${fx.port}`, HA_TOKEN: "test-token-1" },
    gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), resolve,
  });
  assert.deepEqual(r, { ok: true, label: "ha.example.lan" });
  assert.equal(fx.hits, 1);
});

test("no label for a service without labelFrom", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const svc = { fields: [{ name: "U", kind: "address" }], test: { kind: "http", url: "${U}/x", expect: [200] } };
  const r = await testConnection(svc, { values: { U: fx.url }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
  assert.deepEqual(r, { ok: true });
});

test("auth failed: 401 and 403", async () => {
  for (const code of [401, 403]) {
    const fx = await fixture((req, res) => { res.writeHead(code); res.end("nope secret-body"); });
    const r = await testConnection(haService(), { values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
    assertClass(r, "auth_failed");
  }
});

test("unexpected response: other statuses, and the body never comes back", async () => {
  const fx = await fixture((req, res) => { res.writeHead(500); res.end("upstream-secret-text"); });
  const r = await testConnection(haService(), { values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
  assertClass(r, "unexpected_response");
  assert.doesNotMatch(JSON.stringify(r), /upstream-secret-text/);
});

test("redirect not followed", async () => {
  const target = await fixture((req, res) => res.end("ok"));
  const fx = await fixture((req, res) => { res.writeHead(302, { Location: target.url + "/api/" }); res.end(); });
  const r = await testConnection(haService(), { values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
  assertClass(r, "redirect");
  assert.equal(fx.hits, 1);
  assert.equal(target.hits, 0);
});

test("timeout: a server that never answers times out within the deadline", async () => {
  const fx = await fixture(() => {});
  const t0 = Date.now();
  const r = await testConnection(haService(), {
    values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), timeoutMs: 200,
  });
  assertClass(r, "timeout");
  assert.ok(Date.now() - t0 < 200 + 1800, `took ${Date.now() - t0} ms`); // deadline + loaded-runner slack
});

test("slow drip: the deadline covers the body, not just the headers", async () => {
  const fx = await fixture((req, res) => {
    res.writeHead(200);
    const iv = setInterval(() => { if (res.destroyed) return clearInterval(iv); res.write("x"); }, 100);
    res.on("close", () => clearInterval(iv));
  });
  const t0 = Date.now();
  const r = await testConnection(haService(), {
    values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), timeoutMs: 300,
  });
  assertClass(r, "timeout");
  assert.ok(Date.now() - t0 < 300 + 1800, `took ${Date.now() - t0} ms`); // a drip would run forever
});

test("body capped and dropped: a huge body is cut at 64 KB and the socket closed", async () => {
  let written = 0;
  let closedEarly = false;
  const chunk = Buffer.alloc(16 * 1024, 97);
  const fx = await fixture((req, res) => {
    res.writeHead(200);
    const pump = () => {
      while (written < 50 * 1024 * 1024) {
        if (res.destroyed) return;
        written += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    res.on("close", () => { if (!res.writableFinished) closedEarly = true; });
    pump();
  });
  const r = await testConnection(haService(), { values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
  assert.equal(r.ok, true);
  assert.ok(!("body" in r));
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(closedEarly, true);
  assert.ok(written < 50 * 1024 * 1024);
});

test("own port refused: loopback, localhost, [::1] and 0.0.0.0 on the gateway port never connect", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  for (const host of ["127.0.0.1", "localhost", "[::1]", "0.0.0.0", "[::ffff:127.0.0.1]", "[::]"]) {
    const r = await testConnection(haService(), {
      values: { HA_URL: `http://${host}:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port, ownAddrs: new Set(["127.0.0.1", "::1", "localhost"]),
    });
    assertClass(r, "forbidden_target");
  }
  assert.equal(fx.hits, 0);
});

test("own non-loopback address on the gateway port is refused", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const resolve = (host, opts, cb) => dnsLookup("127.0.0.1", opts, cb);
  const r = await testConnection(haService(), {
    values: { HA_URL: `http://100.64.20.5:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port, ownAddrs: new Set(["100.64.20.5"]), resolve,
  });
  assertClass(r, "forbidden_target");
  assert.equal(fx.hits, 0);
});

test("default own addresses: every interface address (bridges included) is refused on the gateway port", async () => {
  const own = probeOwnAddresses();
  const all = Object.values(networkInterfaces()).flat().map((a) => a.address);
  for (const a of all) assert.ok(own.has(a), a);
  // An ephemeral fixture port, never a real gateway port: a regression would hit the fixture only.
  const fx = await fixture((req, res) => res.end("ok"));
  const v4 = all.filter((a) => !a.includes(":"));
  for (const a of v4) {
    const r = await testConnection(haService(), { values: { HA_URL: `http://${a}:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port });
    assertClass(r, "forbidden_target");
  }
  assert.equal(fx.hits, 0);
});

test("loopback on another port is allowed (a local Home Assistant)", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const r = await testConnection(haService(), {
    values: { HA_URL: `http://localhost:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port + 1 === 65536 ? 1 : fx.port + 1, ownAddrs: new Set(["127.0.0.1", "::1", "localhost"]),
  });
  assert.equal(r.ok, true);
});

test("DNS rebinding: the address checked is the one the socket connects to", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  // First answer public, every later answer loopback: a check-then-connect design would pass the
  // check and connect to loopback. The one lookup the socket uses is the one checked.
  let calls = 0;
  const resolve = (host, opts, cb) => {
    calls++;
    const addr = calls === 1 ? "203.0.113.7" : "127.0.0.1";
    if (opts && opts.all) cb(null, [{ address: addr, family: 4 }]);
    else cb(null, addr, 4);
  };
  const r = await testConnection(haService(), {
    values: { HA_URL: `http://rebind.example.lan:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port, ownAddrs: new Set(), resolve, timeoutMs: 500,
  });
  // The single lookup answered 203.0.113.7 (unroutable here), so it never reaches the fixture.
  assert.notEqual(r.ok, true);
  assert.equal(fx.hits, 0);
  assert.equal(calls, 1);

  // A name that resolves to loopback on the gateway port is refused before connecting.
  const toLoop = (host, opts, cb) => dnsLookup("127.0.0.1", opts, cb);
  const r2 = await testConnection(haService(), {
    values: { HA_URL: `http://rebind.example.lan:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port, ownAddrs: new Set(), resolve: toLoop,
  });
  assertClass(r2, "forbidden_target");
  assert.equal(fx.hits, 0);

  // A lookup answering several addresses is refused if any of them is forbidden.
  const mixed = (host, opts, cb) => cb(null, [{ address: "203.0.113.7", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }]);
  const r3 = await testConnection(haService(), {
    values: { HA_URL: `http://rebind.example.lan:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port, ownAddrs: new Set(), resolve: mixed,
  });
  assertClass(r3, "forbidden_target");
  assert.equal(fx.hits, 0);
});

test("bad address: file:, javascript:, userinfo, empty", async () => {
  for (const addr of ["file:///etc/passwd", "javascript:alert(1)", "http://alex:pw@ha.example.lan", "http://alex@127.0.0.1:1", "", "@evil.example/"]) {
    const r = await testConnection(haService(), { values: { HA_URL: addr, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
    assertClass(r, "bad_address");
  }
});

test("unreachable: DNS failure and a closed port", async () => {
  const fail = (host, opts, cb) => { const e = new Error("getaddrinfo ENOTFOUND upstream-detail"); e.code = "ENOTFOUND"; cb(e); };
  const r = await testConnection(haService(), {
    values: { HA_URL: "http://nowhere.example.lan", HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), resolve: fail,
  });
  assertClass(r, "unreachable");
  const fx = await fixture(() => {});
  const port = fx.port;
  servers.pop().close();
  await new Promise((res) => setTimeout(res, 20));
  const r2 = await testConnection(haService(), { values: { HA_URL: `http://127.0.0.1:${port}`, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set() });
  assertClass(r2, "unreachable");
});

test("query encoding: a text field can't add a parameter or change the host", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const svc = {
    fields: [{ name: "BASE", kind: "address" }, { name: "KEY", kind: "secret" }, { name: "ID", kind: "text" }],
    test: { kind: "http", url: "${BASE}/1/members/${ID}?key=${KEY}", expect: [200] },
  };
  const r = await testConnection(svc, {
    values: { BASE: fx.url, KEY: "k&admin=1", ID: "@evil.example/" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(),
  });
  assert.equal(r.ok, true);
  assert.equal(fx.last.url, "/1/members/%40evil.example%2F?key=k%26admin%3D1");
  const q = new URL(fx.last.url, "http://x").searchParams;
  assert.equal(q.get("key"), "k&admin=1");
  assert.equal(q.get("admin"), null);
});

test("header injection: CR/LF in a secret never adds a header", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const r = await testConnection(haService(), {
    values: { HA_URL: fx.url, HA_TOKEN: "test-token-2\r\nX: y" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(),
  });
  assert.equal(r.ok, true);
  assert.equal(fx.last.headers.authorization, "Bearer test-token-2X: y");
  assert.equal(fx.last.headers.x, undefined);
});

test("service with no test is never reported as working", async () => {
  const r = await testConnection({ fields: [], test: null }, { values: {} });
  assertClass(r, "unexpected_response");
});

// ---------- folder probe ----------

const obsidian = {
  fields: [{ name: "OBSIDIAN_VAULT_PATH", kind: "folder" }],
  test: { kind: "folder", expect_entry: ".obsidian" },
};

test("folder cases: vault ok, missing, not a directory, not absolute, not a vault", async () => {
  const root = mkdtempSync(join(tmpdir(), "svc-folder-"));
  try {
    const crowHome = join(root, "crow-home");
    mkdirSync(join(crowHome, "secrets"), { recursive: true });
    const vault = join(root, "vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const run = (p) => testConnection(obsidian, { values: { OBSIDIAN_VAULT_PATH: p }, crowHome, otherSecretsDirs: [] });
    assert.deepEqual(await run(vault), { ok: true });
    assert.deepEqual(await run(vault + "/"), { ok: true });
    assertClass(await run(join(root, "missing")), "not_found");
    assertClass(await run("relative/vault"), "not_found");
    assertClass(await run(""), "not_found");
    assertClass(await run(join(vault, ".obsidian", "nope")), "not_found");
    // A file is not a directory.
    const file = join(root, "file.txt");
    (await import("node:fs")).writeFileSync(file, "x");
    assertClass(await run(file), "not_found");
    assertClass(await run(plain), "not_a_vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folder: anything under <crowHome>/secrets is refused, after realpath (symlinks too)", async () => {
  const root = mkdtempSync(join(tmpdir(), "svc-folder-"));
  try {
    const crowHome = join(root, "crow-home");
    const secrets = join(crowHome, "secrets");
    mkdirSync(join(secrets, "inner", ".obsidian"), { recursive: true });
    mkdirSync(join(secrets, ".obsidian"), { recursive: true });
    const link = join(root, "innocent");
    symlinkSync(join(secrets, "inner"), link);
    const homeLink = join(root, "home-link");
    symlinkSync(crowHome, homeLink);
    const run = (p, home = crowHome) => testConnection(obsidian, { values: { OBSIDIAN_VAULT_PATH: p }, crowHome: home, otherSecretsDirs: [] });
    assertClass(await run(secrets), "forbidden_target");
    assertClass(await run(join(secrets, "inner")), "forbidden_target");
    assertClass(await run(link), "forbidden_target");
    assertClass(await run(join(crowHome, "x", "..", "secrets", "inner")), "forbidden_target");
    // Through a symlinked crowHome, either way round.
    assertClass(await run(join(homeLink, "secrets", "inner")), "forbidden_target");
    assertClass(await run(join(secrets, "inner"), homeLink), "forbidden_target");
    // A folder that CONTAINS the secrets dir would hand the child every secret: refused too.
    mkdirSync(join(crowHome, ".obsidian"), { recursive: true });
    assertClass(await run(crowHome), "forbidden_target");
    assertClass(await run(root), "forbidden_target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folder: a manifest expect_entry with a path separator is never followed", async () => {
  const root = mkdtempSync(join(tmpdir(), "svc-folder-"));
  try {
    mkdirSync(join(root, "v"));
    const svc = { fields: obsidian.fields, test: { kind: "folder", expect_entry: "../v" } };
    const r = await testConnection(svc, { values: { OBSIDIAN_VAULT_PATH: join(root, "v") }, crowHome: join(root, "h"), otherSecretsDirs: [] });
    assertClass(r, "not_a_vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- fix round 1 ----------

test("folderRefusal: the rest of crowHome, other instances' secrets, symlinks into each, and parents", () => {
  const root = mkdtempSync(join(tmpdir(), "svc-folder-"));
  try {
    // Two fake homes under a fake $HOME: the primary .crow and this instance .crow-b.
    const fakeHome = join(root, "home");
    const primary = join(fakeHome, ".crow");
    const crowHome = join(fakeHome, ".crow-b");
    for (const d of [join(primary, "secrets", "x", ".obsidian"), join(crowHome, "secrets"),
      join(crowHome, "bundles", "b1", ".obsidian"), join(crowHome, "data", ".obsidian"),
      join(root, "vault", ".obsidian")]) mkdirSync(d, { recursive: true });
    const links = join(root, "links");
    mkdirSync(links);
    symlinkSync(join(primary, "secrets", "x"), join(links, "other-secrets"));
    symlinkSync(join(crowHome, "bundles", "b1"), join(links, "bundles"));
    symlinkSync(join(crowHome, "data"), join(links, "data"));
    const opts = {
      crowHome, expectEntry: ".obsidian",
      env: { HOME: fakeHome, CROW_HOME: crowHome },
      instanceScan: { home: fakeHome, unitDirs: [], envFileDirs: [] },
    };
    for (const p of [
      join(primary, "secrets"), join(primary, "secrets", "x"), join(links, "other-secrets"),
      join(crowHome, "bundles"), join(crowHome, "bundles", "b1"), join(links, "bundles"),
      join(crowHome, "data"), join(links, "data"), crowHome, fakeHome, root,
    ]) {
      assert.equal(folderRefusal(p, opts), "forbidden_target", p);
    }
    assert.equal(folderRefusal(join(root, "vault"), opts), null);
    assert.equal(folderRefusal(links, opts), "not_a_vault");
    assert.equal(folderRefusal(join(root, "nope"), opts), "not_found");
    // A scan that can't complete refuses (fail closed).
    assert.equal(folderRefusal(join(root, "vault"), { crowHome, otherSecretsDirs: { [Symbol.iterator]() { throw new Error("x"); } } }), "forbidden_target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folderRefusal: the bot launcher's remembered-instance rule applies; a remembered dir that is gone or replaced refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "svc-folder-known-"));
  try {
    const fakeHome = join(root, "home");
    const crowHome = join(fakeHome, ".crow-b");
    const other = join(fakeHome, ".crow-c");
    for (const d of [join(crowHome, "secrets"), join(other, "secrets", "v", ".obsidian"), join(root, "vault", ".obsidian")]) mkdirSync(d, { recursive: true });
    const env = { HOME: fakeHome, CROW_HOME: crowHome };
    const opts = { crowHome, expectEntry: ".obsidian", env, instanceScan: { home: fakeHome, unitDirs: [], envFileDirs: [] } };
    // An earlier spawn hid the other instance's secrets dir and remembered it.
    rememberInstanceSecretsDirs([join(other, "secrets")], env);
    assert.equal(folderRefusal(join(other, "secrets", "v"), opts), "forbidden_target");
    assert.equal(folderRefusal(join(root, "vault"), opts), null);
    // A bot moves that home out of the scan's reach: every folder is refused until the operator forgets it.
    renameSync(other, join(root, "moved"));
    assert.equal(folderRefusal(join(root, "vault"), opts), "forbidden_target", "a remembered dir that is gone fails closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1: a text value of '.' or '..' in a URL is refused, never resolved as a dot segment", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  const fields = [{ name: "BASE", kind: "address" }, { name: "ID", kind: "text" }];
  for (const v of [".", ".."]) {
    assert.throws(() => renderTemplate("${BASE}/api/states/${ID}/x", { BASE: fx.url, ID: v }, { fields }), { code: "bad_value" });
    const r = await testConnection({ fields, test: { kind: "http", url: "${BASE}/api/states/${ID}/x", expect: [200] } }, {
      values: { BASE: fx.url, ID: v }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(),
    });
    assertClass(r, "bad_value");
  }
  assert.equal(fx.hits, 0);
  // Dots inside a longer value are inert.
  assert.equal(renderTemplate("${BASE}/u/${ID}", { BASE: fx.url, ID: "a..b" }, { fields }), `${fx.url}/u/a..b`);
});

test("M2: an unusable gateway port fails closed (every port guarded)", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  for (const gp of [NaN, "abc", 0, 70000, 1.5]) {
    for (const host of ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]) {
      const r = await testConnection(haService(), {
        values: { HA_URL: `http://${host}:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: gp, ownAddrs: new Set(),
      });
      assertClass(r, "forbidden_target");
    }
  }
  assert.equal(fx.hits, 0);
});

test("0.x.y.z (this network) is refused on the gateway port", async () => {
  const fx = await fixture((req, res) => res.end("ok"));
  for (const host of ["0.1.2.3", "0.0.0.1", "[::ffff:0.1.2.3]"]) {
    const r = await testConnection(haService(), { values: { HA_URL: `http://${host}:${fx.port}`, HA_TOKEN: "x" }, gatewayPort: fx.port, ownAddrs: new Set() });
    assertClass(r, "forbidden_target");
  }
  assert.equal(fx.hits, 0);
});

test("M3: the body cap is exact: reaching BODY_CAP_BYTES settles, the rest is never awaited", async () => {
  assert.equal(BODY_CAP_BYTES, 64 * 1024);
  // Exactly the cap is sent, then the server stalls with more promised: settling must not wait.
  const fx = await fixture((req, res) => {
    res.writeHead(200, { "Content-Length": String(BODY_CAP_BYTES * 2) });
    res.write(Buffer.alloc(BODY_CAP_BYTES, 97));
  });
  const r = await testConnection(haService(), {
    values: { HA_URL: fx.url, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), timeoutMs: 1500,
  });
  assert.deepEqual(r, { ok: true, label: `this Crow :${fx.port}` });
});

test("slow DNS: a resolver slower than the deadline times out", async () => {
  const slow = (host, opts, cb) => setTimeout(() => cb(null, [{ address: "127.0.0.1", family: 4 }]), 1500);
  const t0 = Date.now();
  const r = await testConnection(haService(), {
    values: { HA_URL: "http://slow.example.lan:1", HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY + 1, ownAddrs: new Set(), resolve: slow, timeoutMs: 200,
  });
  assertClass(r, "timeout");
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("slow headers: a header block that drips times out", async () => {
  const net = await import("node:net");
  const srv = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.write("HTTP/1.1 200 OK\r\n");
    const iv = setInterval(() => { if (sock.destroyed) return clearInterval(iv); sock.write("X-Drip: a\r\n"); }, 50);
    sock.on("close", () => clearInterval(iv));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await testConnection(haService(), {
      values: { HA_URL: `http://127.0.0.1:${srv.address().port}`, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), timeoutMs: 300,
    });
    assertClass(r, "timeout");
  } finally {
    srv.close();
  }
});

test("an oversized response header is unreachable, never a crash", async () => {
  const net = await import("node:net");
  const srv = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.end("HTTP/1.1 200 OK\r\nX-Big: " + "a".repeat(200 * 1024) + "\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await testConnection(haService(), {
      values: { HA_URL: `http://127.0.0.1:${srv.address().port}`, HA_TOKEN: "x" }, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(),
    });
    assertClass(r, "unreachable");
  } finally {
    srv.close();
  }
});

/** A self-signed cert for ha.example.lan, made at test time (no key material in the repo). */
function selfSigned(dir) {
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=ha.example.lan", "-addext", "subjectAltName=DNS:ha.example.lan",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } catch {
    return null;
  }
}

test("https: verified TLS, the checked lookup, and own-port refusal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "svc-tls-"));
  const tls = selfSigned(dir);
  rmSync(dir, { recursive: true, force: true });
  if (!tls) return t.skip("openssl not available");
  let hits = 0;
  const srv = https.createServer(tls, (req, res) => { hits++; res.end("ok"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const toLoop = (host, opts, cb) => dnsLookup("127.0.0.1", opts, cb);
  try {
    const values = { HA_URL: `https://ha.example.lan:${port}`, HA_TOKEN: "x" };
    // A name resolving to loopback on the gateway port: refused in the lookup, 0 hits.
    assertClass(await testConnection(haService(), { values, gatewayPort: port, ownAddrs: new Set(), resolve: toLoop }), "forbidden_target");
    assert.equal(hits, 0);
    // Self-signed is not trusted by default: unreachable (certificate rejected).
    assertClass(await testConnection(haService(), { values, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), resolve: toLoop }), "unreachable");
    // With the CA trusted, the same probe passes through the checked lookup.
    const request = (url, opts) => https.request(url, { ...opts, ca: tls.cert });
    assert.deepEqual(
      await testConnection(haService(), { values, gatewayPort: NOT_GATEWAY, ownAddrs: new Set(), resolve: toLoop, request }),
      { ok: true, label: "ha.example.lan" },
    );
    assert.equal(hits, 1);
  } finally {
    srv.close();
  }
});
