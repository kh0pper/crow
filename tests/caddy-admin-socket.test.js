/**
 * Caddy's admin API moves off 0.0.0.0:2019 (reachable from every container on the
 * crow-federation network) onto a unix socket in Caddy's config dir. Covers the target
 * resolution, real requests over a unix socket, the mid-rollout TCP fallback, the
 * compose file / default Caddyfile, the entrypoint's migration of an existing Caddyfile,
 * and the MCP tools + panel routes going through the socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const A = await import("../bundles/caddy/server/admin-client.js");
const C = await import("../bundles/caddy/server/caddyfile.js");
const COMPOSE = readFileSync(new URL("../bundles/caddy/docker-compose.yml", import.meta.url), "utf8");
const MANIFEST = JSON.parse(readFileSync(new URL("../bundles/caddy/manifest.json", import.meta.url), "utf8"));

function tmp(prefix = "crow-caddy-admin-") { return mkdtempSync(join(tmpdir(), prefix)); }

/** A fake admin API on a unix socket; records each request. */
async function socketAdmin(socketPath, reply = () => [200, "{}"]) {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: b, type: req.headers["content-type"] });
      const [status, text] = reply(req);
      res.statusCode = status;
      res.end(text);
    });
  });
  await new Promise((r) => srv.listen(socketPath, r));
  return { seen, close: () => new Promise((r) => srv.close(r)) };
}

test("adminTarget: unset or an old loopback :2019 default -> the socket in the config dir; unix: and other URLs as given", () => {
  const dir = "/srv/x";
  const sock = join(dir, "run", "admin.sock");
  const opts = { configDir: dir, state: () => "socket", source: () => "" };
  for (const v of [undefined, "", "http://127.0.0.1:2019", "http://127.0.0.1:2019/", "http://localhost:2019", "http://[::1]:2019/"]) {
    assert.deepEqual(A.adminTarget({ env: v === undefined ? {} : { CADDY_ADMIN_URL: v }, ...opts }), { kind: "unix", socketPath: sock, label: `unix:${sock}` }, String(v));
  }
  assert.equal(A.adminTarget({ env: { CADDY_ADMIN_URL: "unix:/run/caddy.sock" }, configDir: dir }).socketPath, "/run/caddy.sock");
  assert.equal(A.adminTarget({ env: { CADDY_ADMIN_URL: "unix:///run/caddy.sock" }, configDir: dir }).socketPath, "/run/caddy.sock");
  assert.throws(() => A.adminTarget({ env: { CADDY_ADMIN_URL: "unix:relative.sock" }, configDir: dir }), /absolute/);
  assert.throws(() => A.adminTarget({ env: { CADDY_ADMIN_URL: `unix:/${"d".repeat(120)}/admin.sock` }, configDir: dir }), /107-byte/);
  assert.deepEqual(A.adminTarget({ env: { CADDY_ADMIN_URL: "http://10.9.8.7:2999" }, configDir: dir }), { kind: "http", baseUrl: "http://10.9.8.7:2999", label: "http://10.9.8.7:2999" });
  assert.throws(() => A.adminTarget({ env: { CADDY_ADMIN_URL: "ftp://x" }, configDir: dir }), /neither/);
});

test("adminTarget: the old TCP address stands in ONLY while the socket is missing and the Caddyfile still has the TCP admin line", () => {
  const legacy = "{\n\temail {$CADDY_EMAIL}\n\tadmin 0.0.0.0:2019\n}\n";
  const migrated = "{\n\tadmin unix//srv/caddy/run/admin.sock|0222\n}\n";
  const t = A.adminTarget({ env: {}, configDir: "/srv/x", state: () => "missing", source: () => legacy });
  assert.equal(t.kind, "http");
  assert.equal(t.baseUrl, "http://127.0.0.1:2019");
  assert.equal(t.fallback, true);
  assert.equal(A.adminTarget({ env: { CADDY_ADMIN_URL: "http://127.0.0.1:2019" }, configDir: "/srv/x", state: () => "missing", source: () => legacy }).fallback, true);
  // Migrated Caddyfile, no Caddyfile, or an operator's own TCP admin line that the entrypoint
  // leaves alone: no fallback (the new compose doesn't publish 2019; another Caddy may own it).
  for (const src of [migrated, "", "{\n\tadmin :2019 {\n\t\torigins x\n\t}\n}\n", "{\n  admin  0.0.0.0:2019 # mine\n}\n", "{\n\tadmin localhost:2019\n}\n"]) assert.equal(A.adminTarget({ env: {}, configDir: "/srv/x", state: () => "missing", source: () => src }).kind, "unix");
  // A socket we can't stat (EACCES) or a stale non-socket file: no fallback, the request says why.
  for (const st of ["unknown", "other"]) assert.equal(A.adminTarget({ env: {}, configDir: "/srv/x", state: () => st, source: () => legacy }).kind, "unix");
  // An explicit unix: target never falls back.
  assert.equal(A.adminTarget({ env: { CADDY_ADMIN_URL: "unix:/nope.sock" }, configDir: "/srv/x", state: () => "missing", source: () => legacy }).kind, "unix");
});

test("adminTarget reads the real filesystem: a migrated dir with no socket names the socket, not TCP", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "Caddyfile"), C.DEFAULT_CADDYFILE);
    assert.equal(A.adminTarget({ env: {}, configDir: dir }).kind, "unix");
    writeFileSync(join(dir, "Caddyfile"), "{\n\tadmin 0.0.0.0:2019\n}\n");
    assert.equal(A.adminTarget({ env: {}, configDir: dir }).fallback, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("adminRequest: GET and POST over a real unix socket; HTTP errors resolve, a missing socket rejects clearly", async () => {
  const dir = tmp();
  const socketPath = join(dir, "admin.sock");
  const admin = await socketAdmin(socketPath, (req) => (req.url === "/bad" ? [400, "nope"] : [200, '{"ok":1}']));
  try {
    const target = { kind: "unix", socketPath, label: `unix:${socketPath}` };
    const g = await A.adminRequest(target, "/config/");
    assert.equal(g.status, 200);
    assert.equal(g.text, '{"ok":1}');
    const p = await A.adminRequest(target, "/load", { method: "POST", headers: { "Content-Type": "text/caddyfile" }, body: "a.example.com {\n}\n" });
    assert.equal(p.ok, true);
    assert.deepEqual(admin.seen[1], { method: "POST", url: "/load", body: "a.example.com {\n}\n", type: "text/caddyfile" });
    const bad = await A.adminRequest(target, "/bad");
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
  } finally { await admin.close(); rmSync(dir, { recursive: true, force: true }); }
  await assert.rejects(A.adminRequest({ kind: "unix", socketPath: join(dir, "gone.sock"), label: "x" }, "/config/"), /Cannot reach Caddy admin API.*recreated/s);
});

test("adminRequest: a stale socket file and an unreadable run/ folder fail with a clear reason", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "stale.sock"), "");
    await assert.rejects(A.adminRequest({ kind: "unix", socketPath: join(dir, "stale.sock"), label: "x" }, "/config/"), /Cannot reach Caddy admin API/);
    if (process.getuid?.() !== 0) {
      mkdirSync(join(dir, "run"), { mode: 0o000 });
      try {
        await assert.rejects(A.adminRequest(A.adminTarget({ env: {}, configDir: dir }), "/config/"), /EACCES.*Permission denied/s);
      } finally { chmodSync(join(dir, "run"), 0o700); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compose: no 2019 publish, admin on the socket, run/ owned by the config dir's owner, socket healthcheck", () => {
  const ports = COMPOSE.match(/\n    ports:\n((?:      - .*\n)+)/)[1];
  assert.ok(!/2019/.test(ports), "no 2019 publish");
  assert.ok(!/2019/.test(COMPOSE.match(/healthcheck:[\s\S]*/)[0]), "healthcheck does not use 2019");
  const heredoc = COMPOSE.match(/<<CADDYFILE_EOF\n([\s\S]*?)\n\s*CADDYFILE_EOF\n/)[1];
  assert.ok(!/2019|0\.0\.0\.0/.test(heredoc), "the default Caddyfile has no TCP admin");
  assert.match(heredoc, /^\s*admin unix\/\/srv\/caddy\/run\/admin\.sock\|0222$/m);
  assert.match(COMPOSE, /test -S \/srv\/caddy\/run\/admin\.sock/);
  assert.match(C.DEFAULT_CADDYFILE, /^\tadmin unix\/\/srv\/caddy\/run\/admin\.sock\|0222$/m);
  assert.ok(!/2019/.test(C.DEFAULT_CADDYFILE));
  assert.ok(!MANIFEST.ports.includes(2019));
  assert.ok(!MANIFEST.env_vars.find((v) => v.name === "CADDY_ADMIN_URL").default, "no default: unset means the socket");
  assert.deepEqual(MANIFEST.refreshFiles, ["docker-compose.yml"]);
  assert.deepEqual(MANIFEST.docker.precreate, ["caddy", "caddy/run"], "the gateway user creates the config dir, so Docker never makes it root-owned");
});

/** The entrypoint script from the compose file, with /srv/caddy pointed at `root`. */
function entrypointFor(root) {
  const m = COMPOSE.match(/entrypoint:\n\s+- sh\n\s+- -c\n\s+- \|\n([\s\S]*?)\n\s{4}init:/);
  assert.ok(m, "entrypoint block found");
  // Compose interpolates the block: a literal $ must be written $$ (anything else would be
  // substituted from the host env and this test would check a different script).
  assert.ok(!/\$/.test(m[1].replace(/\$\$/g, "")), "every $ in the entrypoint is escaped as $$");
  const lines = m[1].split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join("\n")
    .replace(/\$\$/g, "$") // compose's escape for a literal $
    .replace(/(?<!unix\/)\/srv\/caddy/g, root) // the in-container admin address stays as written
    .replace(/^exec caddy .*$/m, "echo started");
}

// The container is alpine: busybox sh, sed, grep, stat, cp. Run the script with
// busybox's applets when the host has busybox, and with the host tools always.
const BUSYBOX = ["/usr/bin/busybox", "/bin/busybox"].find((p) => existsSync(p));
function shells() {
  const runner = (cmd, extraEnv = {}) => (script, env) => {
    const r = spawnSync(cmd, ["-c", script], { env: { ...env, ...extraEnv }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`entrypoint exited ${r.status}: ${r.stderr}`);
    return r.stderr;
  };
  const out = [["host", runner("sh")]];
  if (BUSYBOX) {
    const bin = mkdtempSync(join(tmpdir(), "crow-bb-"));
    for (const a of ["sh", "sed", "grep", "stat", "cp", "chown", "chmod", "mkdir", "rm", "cat", "echo", "test", "["]) symlinkSync(BUSYBOX, join(bin, a));
    out.push(["busybox", runner(join(bin, "sh"), { PATH: bin })]);
  }
  return out;
}
const runEntrypoint = (run, root) => run(entrypointFor(root), { ...process.env, CADDY_EMAIL: "ops@example.com" });

for (const [shellName, run] of shells()) test(`entrypoint (${shellName}): a fresh dir gets the socket Caddyfile; an old one has exactly its legacy admin line migrated (with a backup)`, () => {
  const fresh = tmp();
  try {
    mkdirSync(join(fresh, "run"));
    writeFileSync(join(fresh, "run", "admin.sock"), "stale");
    runEntrypoint(run, fresh);
    const cf = readFileSync(join(fresh, "Caddyfile"), "utf8");
    assert.match(cf, /admin unix\/\/srv\/caddy\/run\/admin\.sock\|0222/);
    assert.match(cf, /email \{\$CADDY_EMAIL\}/, "the email placeholder is written literally, expanded by Caddy");
    const st = statSync(join(fresh, "run"));
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal(st.uid, statSync(fresh).uid);
    assert.equal(existsSync(join(fresh, "run", "admin.sock")), false, "a stale socket is removed before Caddy starts");
  } finally { rmSync(fresh, { recursive: true, force: true }); }

  const old = tmp();
  try {
    const legacy = "# Crow-managed\n{\n\temail {$CADDY_EMAIL}\n\tadmin 0.0.0.0:2019\n}\n\na.example.com {\n\trespond \"admin 0.0.0.0:2019\" 200\n}\n";
    writeFileSync(join(old, "Caddyfile"), legacy);
    const err = runEntrypoint(run, old);
    assert.match(err, /moved the admin API/);
    assert.doesNotMatch(err, /WARNING/);
    const cf = readFileSync(join(old, "Caddyfile"), "utf8");
    assert.match(cf, /^\tadmin unix\/\/srv\/caddy\/run\/admin\.sock\|0222$/m);
    assert.match(cf, /respond "admin 0\.0\.0\.0:2019" 200/, "only the exact global-option line changes");
    assert.equal(readFileSync(join(old, "Caddyfile.bak-admin-tcp"), "utf8"), legacy);
    assert.equal(statSync(join(old, "Caddyfile")).uid, statSync(old).uid);
    // Idempotent: a second start changes nothing and keeps the first backup.
    assert.doesNotMatch(runEntrypoint(run, old), /moved|WARNING/);
    assert.equal(readFileSync(join(old, "Caddyfile"), "utf8"), cf);
    assert.equal(readFileSync(join(old, "Caddyfile.bak-admin-tcp"), "utf8"), legacy);
  } finally { rmSync(old, { recursive: true, force: true }); }

  for (const mine of ["{\n\tadmin localhost:2020\n}\n", "{\n\tadmin :2019 {\n\t\torigins x\n\t}\n}\n", "{\n  admin  0.0.0.0:2019 # mine\n}\n"]) {
    const custom = tmp();
    try {
      writeFileSync(join(custom, "Caddyfile"), mine);
      assert.match(runEntrypoint(run, custom), /WARNING the Caddyfile's admin line is not Crow's socket line/, JSON.stringify(mine));
      assert.equal(readFileSync(join(custom, "Caddyfile"), "utf8"), mine, "an operator's own admin line is left alone");
      assert.equal(existsSync(join(custom, "Caddyfile.bak-admin-tcp")), false);
    } finally { rmSync(custom, { recursive: true, force: true }); }
  }
});

test("adminLineWarning: only Crow's socket line is quiet", () => {
  assert.equal(C.adminLineWarning(C.DEFAULT_CADDYFILE), null);
  assert.equal(C.adminLineWarning(""), null);
  assert.match(C.adminLineWarning("{\n\tadmin 0.0.0.0:2019\n}\n"), /reachable from every container/);
  assert.match(C.adminLineWarning("{\n\tadmin :2019 {\n\t\torigins x\n\t}\n}\n"), /reachable from every container/);
  assert.match(C.adminLineWarning("a.example.com {\n\trespond hi\n}\n"), /no admin line/);
  assert.equal(C.adminLineWarning("{\n\tadmin unix//srv/caddy/run/admin.sock|0222 {\n\t\torigins x\n\t}\n}\n"), null, "options after the socket are fine");
  assert.match(C.adminLineWarning("{\n\tadmin off\n}\n"), /turns the admin API off/);
  assert.doesNotMatch(C.adminLineWarning("{\n\tadmin off\n}\n"), /reachable/);
});

test("ensureConfigDir creates run/ 0700 next to the Caddyfile", () => {
  const dir = tmp();
  try {
    C.ensureConfigDir(join(dir, "caddy"));
    assert.equal(statSync(join(dir, "caddy", "run")).mode & 0o777, 0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP tools reach Caddy over the config dir's socket when CADDY_ADMIN_URL is unset", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "run"), { recursive: true, mode: 0o700 });
  const admin = await socketAdmin(join(dir, "run", "admin.sock"), (req) => [200, req.url === "/config/" ? JSON.stringify({ apps: { http: { servers: { srv0: { listen: [":443"], routes: [{}] } } } } }) : "{}"]);
  const saved = { a: process.env.CADDY_ADMIN_URL, c: process.env.CADDY_CONFIG_DIR };
  delete process.env.CADDY_ADMIN_URL;
  process.env.CADDY_CONFIG_DIR = dir;
  const { createCaddyServer } = await import("../bundles/caddy/server/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createCaddyServer({ networkNames: async () => new Set(["crow-app"]) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("");
  try {
    const status = JSON.parse(await call("caddy_status"));
    assert.equal(status.admin_api, `unix:${join(dir, "run", "admin.sock")}`);
    assert.equal(status.routes_loaded, 1);
    assert.equal(status.admin_warning, undefined);
    assert.match(await call("caddy_add_site", { domain: "a.example.com", upstream: "crow-app:80" }), /Added site/);
    assert.ok(admin.seen.some((r) => r.method === "POST" && r.url === "/load" && r.type === "text/caddyfile" && r.body.includes("a.example.com")));
    assert.match(await call("caddy_reload"), /Caddy reloaded/);
    assert.match(await call("caddy_remove_site", { domain: "a.example.com", confirm: "yes" }), /Removed site/);
  } finally {
    await client.close(); await admin.close(); rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["CADDY_ADMIN_URL", saved.a], ["CADDY_CONFIG_DIR", saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("panel routes reach Caddy over the socket (status + add site)", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "run"), { recursive: true, mode: 0o700 });
  const admin = await socketAdmin(join(dir, "run", "admin.sock"));
  const saved = { a: process.env.CADDY_ADMIN_URL, c: process.env.CADDY_CONFIG_DIR };
  delete process.env.CADDY_ADMIN_URL;
  process.env.CADDY_CONFIG_DIR = dir;
  const express = (await import("express")).default;
  const { default: caddyRouter } = await import("../bundles/caddy/panel/routes.js");
  const app = express();
  app.use(express.json());
  app.use(caddyRouter((_req, _res, next) => next()));
  const web = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const st = await (await fetch(`${base}/api/caddy/status`)).json();
    assert.equal(st.error, undefined, JSON.stringify(st));
    assert.equal(st.admin_api, `unix:${join(dir, "run", "admin.sock")}`);
    const add = await (await fetch(`${base}/api/caddy/sites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: "p.example.com", upstream: "crow-app:80" }) })).json();
    assert.deepEqual(add, { ok: true });
    assert.ok(admin.seen.some((r) => r.url === "/load" && r.body.includes("p.example.com")));
    const bad = await (await fetch(`${base}/api/caddy/sites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: 'p.example.com"#', upstream: "crow-app:80" }) })).json();
    assert.match(bad.error, /domain/i);
    for (const upstream of ["crow-caddy:2019", "localhost:8080", "127.0.0.1:3001", "crow-app:2019", "host.example.net:80"]) {
      const r = await (await fetch(`${base}/api/caddy/sites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: "q.example.com", upstream }) })).json();
      assert.match(r.error || "", /Invalid upstream/, upstream);
    }
  } finally {
    web.close(); await admin.close(); rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["CADDY_ADMIN_URL", saved.a], ["CADDY_CONFIG_DIR", saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
