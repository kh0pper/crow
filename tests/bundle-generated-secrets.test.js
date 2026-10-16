/**
 * Required passwords/keys Crow can choose itself are GENERATED at install and saved to
 * the Crow keychain (queue item 30, fix B), the same way browser/minio/vaultwarden do it:
 * env_vars[].generate + keychain (+ propagate where an MCP child reads the value from
 * process.env). A collection install (empty env, no keychain request) must still end up
 * with a value and a keychain entry. No test here prints a generated value.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-gensec-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-gensec-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CROW_HOME = process.env.CROW_HOME;
const B = await import("../servers/gateway/routes/bundles.js");
const K = await import("../servers/gateway/keychain/store.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { createDbClient } = await import("../servers/db.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-gensec-app-"));
const GW_ENV = join(mkdtempSync(join(tmpdir(), "crow-gensec-gw-")), ".env");
writeFileSync(GW_ENV, "# gateway env (test)\n");
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(GW_ENV);
B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
const hookRuns = [];
B._setHookRunnerForTest(async (...args) => { hookRuns.push(args); return { stdout: "", stderr: "" }; });
after(() => {
  B._setAppEnvPathForTest(null);
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setHookRunnerForTest(null);
  for (const d of [CROW_HOME, process.env.CROW_DATA_DIR, FIXTURES]) rmSync(d, { recursive: true, force: true });
});

const manifestOf = (id) => JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
const specOf = (id, name) => (manifestOf(id).env_vars || []).find((v) => v.name === name);

// The keys this fix generates, and how each one reaches its consumer.
// campaigns/tax encryption keys are NOT here: generating them waits for the recovery-key
// decision (see tests/bundle-form-friction.test.js EXEMPT).
const EXPECT = [
  { id: "miniflux", key: "MINIFLUX_ADMIN_PASSWORD", propagate: false, username: "${MINIFLUX_ADMIN_USER}" },
  { id: "maker-lab-advanced", key: "MLA_ADMIN_PASSWORD", propagate: false, username: "${MLA_ADMIN_USER}" },
  { id: "actual-budget", key: "ACTUAL_SERVER_PASSWORD", propagate: false },
  { id: "lemmy", key: "LEMMY_ADMIN_PASSWORD", propagate: false, username: "admin_pending" },
];

test("each key is generated, keychain-saved, and propagated only where an MCP child reads it", () => {
  for (const e of EXPECT) {
    const v = specOf(e.id, e.key);
    assert.ok(v, `${e.id}: ${e.key} is declared`);
    assert.equal(v.generate, "secret", `${e.id}.${e.key} generate`);
    assert.equal(v.keychain, true, `${e.id}.${e.key} keychain`);
    assert.equal(v.secret, true, `${e.id}.${e.key} secret`);
    assert.equal(v.propagate === true, e.propagate, `${e.id}.${e.key} propagate`);
    assert.ok(typeof v.keychain_label === "string" && v.keychain_label.length > 0, `${e.id}.${e.key} keychain_label`);
    if (e.username) assert.equal(v.keychain_username, e.username, `${e.id}.${e.key} keychain_username`);
    const r = validateManifest(manifestOf(e.id), join(REPO, "bundles", e.id));
    assert.deepEqual(r.errors || [], [], `${e.id} manifest contract`);
  }
});

test("every username a keychain entry names has a default, so the entry is never left without one", () => {
  assert.equal(specOf("maker-lab-advanced", "MLA_ADMIN_USER").default, "admin");
  assert.equal(specOf("miniflux", "MINIFLUX_ADMIN_USER").default, "admin");
});

test("no generated key here goes to the shared gateway .env (co-hosted instances share it)", () => {
  for (const e of EXPECT) assert.equal(S.gatewayGeneratedKeys(manifestOf(e.id)).includes(e.key), false, `${e.id}.${e.key}`);
});

/** Copy just the manifest + .env.example (no package.json: no npm in a unit test). */
function stage(id) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(REPO, "bundles", id, "manifest.json"), join(dir, "manifest.json"));
  for (const f of [".env.example", "docker-compose.yml"]) {
    if (existsSync(join(REPO, "bundles", id, f))) copyFileSync(join(REPO, "bundles", id, f), join(dir, f));
  }
  if (existsSync(join(REPO, "bundles", id, "scripts"))) cpSync(join(REPO, "bundles", id, "scripts"), join(dir, "scripts"), { recursive: true });
  return manifestOf(id);
}

async function entriesFor(id) {
  const d = createDbClient();
  try { return (await K.listEntries(d, { keyId: loadKeychainKey().id })).filter((e) => e.bundle_id === id); }
  finally { d.close(); }
}

for (const e of EXPECT.filter((x) => ["miniflux", "actual-budget"].includes(x.id))) {
  test(`collection-style install of ${e.id} (empty env, no keychain request): value minted, keychain entry made, .env holds it`, async () => {
    const manifest = stage(e.id);
    const job = B._createJobForTest(e.id, "install");
    const out = await B.runInstallJob(e.id, {}, { job, installedSnapshot: [], consentVerified: false, manifest, keychain: null });
    assert.equal(out.ok, true, out.reason);
    const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", e.id, ".env"), "utf8"));
    assert.match(env[e.key] || "", /^[A-Za-z0-9_-]{43}$/, `${e.key} is a freshly minted secret, not a placeholder`);
    const rows = await entriesFor(e.id);
    assert.equal(rows.length, 1, "one keychain entry");
    assert.equal(rows[0].env_key, e.key);
    assert.equal(rows[0].first_view_pending, true);
    const d = createDbClient();
    try { assert.equal(await K.openEntrySecret(d, loadKeychainKey(), rows[0].id), env[e.key], "keychain holds the same value"); }
    finally { d.close(); }
    const gw = parseEnvText(readFileSync(GW_ENV, "utf8"));
    assert.equal(gw[e.key], undefined, `the shared gateway env never gets ${e.key}`);
    const addons = JSON.parse(readFileSync(join(CROW_HOME, "mcp-addons.json"), "utf8"));
    const listed = (manifest.server?.envKeys || []).includes(e.key);
    assert.equal(addons[e.id]?.env?.[e.key] === env[e.key], listed, `${e.key} reaches this instance's MCP entry only when server.envKeys lists it`);
    if (e.id === "miniflux") assert.equal(rows[0].username, "admin");
    const log = job.log.join("\n");
    assert.ok(!log.includes(env[e.key]), "the value never reaches the job log");
  });
}

test("reinstall keeps the kept value (never regenerated)", async () => {
  const id = "miniflux";
  const before = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8")).MINIFLUX_ADMIN_PASSWORD;
  assert.ok(before);
  rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
  const manifest = stage(id);
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest, keychain: null });
  assert.equal(out.ok, true, out.reason);
  const afterVal = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8")).MINIFLUX_ADMIN_PASSWORD;
  assert.equal(afterVal, before);
});

test("lemmy: no literal admin password in the compose file; the config mount is not read-only-and-written", () => {
  const compose = readFileSync(join(REPO, "bundles", "lemmy", "docker-compose.yml"), "utf8");
  assert.match(compose, /admin_password:\s*"\$\$\{CROW_LEMMY_ADMIN_PASSWORD\}"/);
  assert.match(compose, /CROW_LEMMY_ADMIN_PASSWORD:\s*"\$\{LEMMY_ADMIN_PASSWORD\}"/);
  const script = compose.slice(compose.indexOf("cat > /config"), compose.indexOf("exec /app/lemmy"));
  assert.doesNotMatch(script, /(?<!\$)\$\{LEMMY_(DB_PASSWORD|PICTRS_API_KEY|ADMIN_PASSWORD)\}/, "no compose-interpolated secret in the script text (PID 1's command line)");
  assert.doesNotMatch(compose, /-\s+\.\/config:\/config:ro/, "the entrypoint writes /config/config.hjson");
});

test("no tracked compose file hard-codes a password, secret or admin password literal", () => {
  const out = execFileSync("git", ["ls-files", "bundles/*/docker-compose.yml"], { cwd: REPO, encoding: "utf8" }).trim().split("\n");
  // Documented false positives: file → key, with the reason.
  const ALLOW = {
    "bundles/searxng/docker-compose.yml": { secret_key: "a sed command that rewrites secret_key from $SEARXNG_SECRET_KEY (no literal)" },
  };
  const bad = [];
  for (const rel of out) {
    const lines = readFileSync(join(REPO, rel), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (/^\s*#/.test(l)) return;
      // ${X} / ${X:-fallback} are env references (static :- fallbacks are a separate,
      // known item); only a literal written in the file counts here.
      l = l.replace(/\$\{[^}]*\}/g, "$REF");
      // KEY: value / KEY=value / key: "value" where KEY names a password and the value is a literal
      const m = l.match(/([A-Za-z_]*(?:password|PASSWORD|_SECRET|secret_key)[A-Za-z_]*)\s*[:=]\s*["']?([^"'\s$#{][^"'\s#]*)/);
      if (!m) return;
      if (/^(true|false|null|file|\/run\/secrets\/)/i.test(m[2])) return;
      if (ALLOW[rel]?.[m[1]]) return;
      bad.push(`${rel}:${i + 1} ${m[1]}`);
    });
  }
  assert.deepEqual(bad, [], `literal passwords in compose files:\n  ${bad.join("\n  ")}`);
});

// ---- actual-budget: set the generated password on a NEW local server ----------
const AB = await import("../bundles/actual-budget/server/bootstrap.js");
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    const r = routes[path];
    if (!r) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

test("actual-budget: a new loopback server is bootstrapped with the generated password, once", async () => {
  const f = fakeFetch({
    "/account/needs-bootstrap": { status: 200, body: { status: "ok", data: { bootstrapped: false } } },
    "/account/bootstrap": { status: 200, body: { status: "ok", data: {} } },
  });
  assert.equal(await AB.ensureBootstrapped("http://localhost:5006", "pw-generated", { fetchImpl: f }), "bootstrapped");
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["GET /account/needs-bootstrap", "POST /account/bootstrap"]);
  assert.deepEqual(f.calls[1].body, { password: "pw-generated" });
});

test("actual-budget: an already set-up server is never sent the password", async () => {
  const f = fakeFetch({ "/account/needs-bootstrap": { status: 200, body: { status: "ok", data: { bootstrapped: true } } } });
  assert.equal(await AB.ensureBootstrapped("http://127.0.0.1:5006/", "pw", { fetchImpl: f }), "ready");
  assert.equal(f.calls.length, 1);
  const raced = fakeFetch({
    "/account/needs-bootstrap": { status: 200, body: { status: "ok", data: { bootstrapped: false } } },
    "/account/bootstrap": { status: 400, body: { status: "error", reason: "already-bootstrapped" } },
  });
  assert.equal(await AB.ensureBootstrapped("http://localhost:5006", "pw", { fetchImpl: raced }), "ready");
});

test("actual-budget: a remote server is never bootstrapped by Crow; no password means no call", async () => {
  for (const url of ["http://actual.example.invalid:5006", "http://10.1.2.3:5006", "http://localhost.evil.example:5006", "not a url"]) {
    const f = fakeFetch({});
    assert.equal(await AB.ensureBootstrapped(url, "pw", { fetchImpl: f }), "skipped", url);
    assert.equal(f.calls.length, 0, url);
  }
  const f = fakeFetch({});
  assert.equal(await AB.ensureBootstrapped("http://localhost:5006", "", { fetchImpl: f }), "skipped");
  assert.equal(f.calls.length, 0);
  assert.equal(AB.isLoopbackUrl("http://[::1]:5006"), true);
});

test("actual-budget: a refused bootstrap is an error that names the reason, not the password", async () => {
  const f = fakeFetch({
    "/account/needs-bootstrap": { status: 200, body: { status: "ok", data: { bootstrapped: false } } },
    "/account/bootstrap": { status: 400, body: { status: "error", reason: "invalid-password" } },
  });
  await assert.rejects(AB.ensureBootstrapped("http://localhost:5006", "pw-secret-x", { fetchImpl: f }), (err) => /invalid-password/.test(err.message) && !err.message.includes("pw-secret-x"));
});

test("actual-budget install runs its postInstall hook (sets the password right away)", () => {
  assert.ok(hookRuns.length >= 1, "postInstall hook invoked");
  assert.equal(manifestOf("actual-budget").postInstall.script, "scripts/set-server-password.sh");
});

test("actual-budget: a typed password wins; the generated one only ever goes to a loopback URL", () => {
  const env = { ACTUAL_SERVER_PASSWORD: "gen" };
  assert.equal(AB.effectivePassword("http://localhost:5006", env), "gen");
  assert.equal(AB.effectivePassword("https://actual.example.invalid", env), "");
  assert.equal(AB.effectivePassword("https://actual.example.invalid", { ...env, ACTUAL_PASSWORD: "typed" }), "typed");
  assert.equal(AB.effectivePassword("http://127.0.0.1:5006", { ...env, ACTUAL_PASSWORD: "typed" }), "typed");
});

test("set-server-password.sh: bootstraps a new local server once, sends the password only in the body, never prints it", async () => {
  const http = await import("node:http");
  const { execFile } = await import("node:child_process");
  let bootstrapped = false;
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/account/needs-bootstrap") return res.end(JSON.stringify({ status: "ok", data: { bootstrapped } }));
      if (req.url === "/account/bootstrap") {
        bodies.push(body);
        if (bootstrapped) return res.end(JSON.stringify({ status: "error", reason: "already-bootstrapped" }));
        bootstrapped = true;
        return res.end(JSON.stringify({ status: "ok", data: {} }));
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "crow-ab-hook-"));
  const pw = "Abc_def-123ghiJKLmnoPQRstuVWXyz0123456789abc";
  writeFileSync(join(dir, ".env"), `ACTUAL_URL=http://localhost:5006\nACTUAL_SERVER_PASSWORD=${pw}\n`);
  // async (not spawnSync): the fake server answers on this same event loop
  const run = () => new Promise((resolve) => execFile("bash", [join(REPO, "bundles/actual-budget/scripts/set-server-password.sh")], {
    env: { PATH: process.env.PATH, CROW_BUNDLE_DIR: dir, ACTUAL_BOOTSTRAP_URL: `http://127.0.0.1:${srv.address().port}`, ACTUAL_BOOTSTRAP_TRIES: "2" },
    encoding: "utf8",
  }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
  try {
    const first = await run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Set the generated password/);
    assert.deepEqual(bodies.map((b) => JSON.parse(b)), [{ password: pw }]);
    const second = await run();
    assert.match(second.stdout, /already has a password/);
    assert.equal(bodies.length, 1, "a set-up server is not sent the password again");
    for (const o of [first, second]) assert.ok(!o.stdout.includes(pw) && !o.stderr.includes(pw), "never printed");
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
