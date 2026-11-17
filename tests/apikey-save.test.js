/**
 * POST /bundles/api/apikey-save and its module (servers/gateway/bundle-apikey-save.js).
 *
 * An API-key card writes ONE typed, user-supplied third-party key for a declared secret
 * env var of an installed add-on. What this file pins down:
 *
 *   1. owner only — a peer, a token or a satellite request never reaches the write;
 *   2. the env name comes from the REVIEWED manifest (getManifest), and may only be a
 *      declared, secret, non-generated var, and never one that controls how a program runs;
 *   3. value checks (type, empty, length, CR/LF, the manifest's own pattern);
 *   4. the writes: keychain first (always, sealed, kind 'extension'), then the add-on's
 *      mcp-addons.json entry (owner provenance), then an existing bundle .env + the
 *      gateway env; a keychain failure writes nothing else;
 *   5. the value never appears in a response, a thrown error, a log line or a bell;
 *   6. nothing is synced (crow_keychain is on the never-sync list).
 *
 * Scratch CROW_HOME/CROW_DATA_DIR/CROW_APP_ENV_PATH before anything Crow-side is
 * imported, so this file never reads or writes the operator's ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import express from "express";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-apikey-save-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const TMP_BUNDLES = mkdtempSync(join(tmpdir(), "crow-apikey-save-src-"));
const GATEWAY_ENV = join(TMP_HOME, "gateway.env");
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_APP_ENV_PATH = GATEWAY_ENV;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: TMP_DATA },
  stdio: "pipe",
  cwd: REPO,
});

const B = await import("../servers/gateway/routes/bundles.js");
const { saveApiKey, isDeniedApiKeyEnvName, API_KEY_ENV_DENY, API_KEY_MAX_LENGTH, API_KEY_SAVE_REFUSALS } =
  await import("../servers/gateway/bundle-apikey-save.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { createDbClient } = await import("../servers/db.js");
const { listEntries, openEntrySecret } = await import("../servers/gateway/keychain/store.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { AddonKeysUnavailableError, hydrateAddonEntry } = await import("../servers/shared/addon-secrets.js");
const { gatewayKeychainPaths } = await import("../servers/gateway/addon-keys-paths.js");
const { captureOutput, scanDb } = await import("./helpers/sentinel-scan.mjs");
const { randomUUID } = await import("node:crypto");

B._setAppBundlesForTest(TMP_BUNDLES);
B._setAppEnvPathForTest(GATEWAY_ENV);

const INSTALLED = join(TMP_HOME, "installed.json");
const MCP_ADDONS = join(TMP_HOME, "mcp-addons.json");
const INSTALL = "2026-11-01T10:00:00.000Z";
/** A value distinctive enough that any leak is unmistakable. */
const VALUE = "sk-test-VALUE-123456";
const VALUE2 = "sk-test-VALUE-654321";

after(() => {
  B._setOwnerCheckForTest(null);
  B._setApiKeySaveDepsForTest(null);
  B._setAppEnvPathForTest(null);
  for (const d of [TMP_HOME, TMP_BUNDLES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const DEMO = {
  id: "apikey-demo",
  name: "Demo App",
  version: "1.0.0",
  description: "d",
  type: "mcp-server",
  category: "misc",
  server: { command: "node", args: ["server/index.js"], envKeys: ["DEMO_API_KEY"] },
  env_vars: [
    { name: "DEMO_API_KEY", description: "demo key", required: true, secret: true, explain: { en: "the demo key" }, signup_url: "https://keys.example.com/" },
    { name: "DEMO_GENERATED", description: "minted", required: false, secret: true, generate: "secret" },
    { name: "DEMO_PLAIN", description: "not a secret", required: false },
    { name: "DEMO_PATTERN_KEY", description: "patterned", required: false, secret: true, pattern: "^sk-[a-z0-9]+$" },
  ],
};

/** Write a bundle into the repo copy and the installed tree, and record the install. */
function seed(id, manifest, { installedManifest = null, dotEnv = null, mcp = true, installMode = null } = {}) {
  const repoDir = join(TMP_BUNDLES, id);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const dir = join(TMP_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(installedManifest || manifest, null, 2));
  if (dotEnv !== null) writeFileSync(join(dir, ".env"), dotEnv, { mode: 0o600 });
  const current = existsSync(INSTALLED) ? JSON.parse(readFileSync(INSTALLED, "utf8")) : [];
  const rest = current.filter((e) => e && e.id !== id);
  rest.push({ id, type: manifest.type || "bundle", version: manifest.version || "1.0.0", installedAt: INSTALL, ...(installMode ? { mode: installMode } : {}) });
  writeFileSync(INSTALLED, JSON.stringify(rest, null, 2));
  if (mcp) {
    const all = existsSync(MCP_ADDONS) ? JSON.parse(readFileSync(MCP_ADDONS, "utf8")) : {};
    all[id] = { command: "node", args: ["server/index.js"], env: {} };
    writeFileSync(MCP_ADDONS, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  return dir;
}

const readMcp = (id) => (JSON.parse(readFileSync(MCP_ADDONS, "utf8"))[id] || {}).env || {};
const readMcpEntry = (id) => JSON.parse(readFileSync(MCP_ADDONS, "utf8"))[id] || {};
const readDotEnv = (dir) => (existsSync(join(dir, ".env")) ? parseEnvText(readFileSync(join(dir, ".env"), "utf8")) : {});

/** The keychain rows for one bundle, decrypted with this scratch home's key. */
async function keychainRows(bundleId) {
  const db = createDbClient();
  try {
    const key = loadKeychainKey({ crowHome: TMP_HOME });
    const rows = (await listEntries(db, { keyId: key?.id ?? null })).filter((e) => e.bundle_id === bundleId);
    const out = [];
    for (const row of rows) out.push({ ...row, secret: await openEntrySecret(db, key, row.id) });
    return out;
  } finally {
    db.close();
  }
}

/** Capture every console.warn/log line, so a leak into a log is caught here. */
function captureConsole() {
  const lines = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...a) => lines.push(a.map(String).join(" "));
  console.log = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => { console.warn = realWarn; console.log = realLog; } };
}

async function withServer({ owner = true } = {}, fn) {
  const app = express();
  app.use(express.json());
  B._setOwnerCheckForTest(() => owner);
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    return await fn(post);
  } finally {
    server.close();
    B._setOwnerCheckForTest(null);
  }
}

const save = (post, body) => post("/bundles/api/apikey-save", body);

// ── 1. owner only ───────────────────────────────────────────────────────────────────

test("the route is owner-only: a request without the local owner's session never reaches the write", async () => {
  const dir = seed("apikey-owner", { ...DEMO, id: "apikey-owner", name: "Owner Only" }, { dotEnv: "OTHER=1\n" });
  await withServer({ owner: false }, async (post) => {
    const r = await save(post, { bundle_id: "apikey-owner", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "owner_only");
    assert.equal(r.body.ok, undefined, "a refusal carries no success field");
  });
  assert.deepEqual(readMcp("apikey-owner"), {}, "nothing was written into the MCP entry");
  assert.deepEqual(readDotEnv(dir), { OTHER: "1" }, "nothing was written into the .env");
  assert.deepEqual(await keychainRows("apikey-owner"), [], "and nothing into the keychain");
});

// ── 2. what may be set ──────────────────────────────────────────────────────────────

test("undeclared, generated, non-secret and unknown keys are refused with a fixed sentence", async () => {
  seed("apikey-shapes", { ...DEMO, id: "apikey-shapes", name: "Shapes" });
  await withServer({ owner: true }, async (post) => {
    const cases = [
      [{ bundle_id: "apikey-shapes", env_key: "NOT_DECLARED", value: VALUE }, /does not declare/],
      [{ bundle_id: "apikey-shapes", env_key: "DEMO_GENERATED", value: VALUE }, /generates that value/],
      [{ bundle_id: "apikey-shapes", env_key: "DEMO_PLAIN", value: VALUE }, /not a secret/],
      [{ bundle_id: "apikey-shapes", env_key: "", value: VALUE }, /does not declare/],
      [{ bundle_id: "apikey-shapes", env_key: ["DEMO_API_KEY"], value: VALUE }, /does not declare/],
    ];
    for (const [body, re] of cases) {
      const r = await save(post, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, re);
      assert.equal(JSON.stringify(r.body).includes(VALUE), false, "a refusal never echoes the value");
    }
    const badId = await save(post, { bundle_id: "not a bundle id", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(badId.status, 400);
    assert.match(badId.body.error, /Invalid bundle ID/);
    const missing = await save(post, { bundle_id: "apikey-not-installed", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /is not installed/);
  });
  assert.deepEqual(readMcp("apikey-shapes"), {});
});

test("value checks: empty, whitespace, too long, a line break and a pattern violation are refused", async () => {
  const dotEnv = "OTHER=1\n";
  const dir = seed("apikey-values", { ...DEMO, id: "apikey-values", name: "Values" }, { dotEnv });
  await withServer({ owner: true }, async (post) => {
    const cases = [
      [undefined, /Enter the key/],
      [null, /Enter the key/],
      [42, /Enter the key/],
      ["", /Enter the key/],
      ["   ", /Enter the key/],
      ["x".repeat(API_KEY_MAX_LENGTH + 1), /too long/],
      [`${VALUE}\nSECOND=1`, /line break/],
      [`${VALUE}\rX`, /line break/],
    ];
    for (const [value, re] of cases) {
      const r = await save(post, { bundle_id: "apikey-values", env_key: "DEMO_API_KEY", value });
      assert.equal(r.status, 400, String(value).slice(0, 20));
      assert.match(r.body.error, re);
    }
    // A value the manifest's own `pattern` refuses.
    const off = await save(post, { bundle_id: "apikey-values", env_key: "DEMO_PATTERN_KEY", value: VALUE });
    assert.equal(off.status, 400);
    assert.match(off.body.error, /format this extension expects/);
    // ...and one it accepts.
    const on = await save(post, { bundle_id: "apikey-values", env_key: "DEMO_PATTERN_KEY", value: "sk-abc123" });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    // The maximum length itself is allowed.
    const max = await save(post, { bundle_id: "apikey-values", env_key: "DEMO_API_KEY", value: "k".repeat(API_KEY_MAX_LENGTH) });
    assert.equal(max.status, 200, JSON.stringify(max.body));
  });
  assert.deepEqual(readMcp("apikey-values"), {}, "both typed keys are sealed, so neither stays plain in the entry");
  assert.deepEqual(readMcpEntry("apikey-values").keychainEnv, ["DEMO_API_KEY", "DEMO_PATTERN_KEY"], "the entry names them instead");
  const sealedValues = Object.fromEntries((await keychainRows("apikey-values")).map((r) => [r.env_key, r.secret]));
  assert.deepEqual(sealedValues, { DEMO_API_KEY: "k".repeat(API_KEY_MAX_LENGTH), DEMO_PATTERN_KEY: "sk-abc123" });
  assert.equal(readFileSync(MCP_ADDONS, "utf8").includes("sk-abc123"), false, "a sealed key is not in the file");
  assert.equal(readDotEnv(dir).OTHER, "1", "the other line survived");
});

test("every denied env name is refused, in the route and in the shared rule", async () => {
  const denied = [
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME",
    "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
    "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
    "BASH_ENV", "ENV", "PATH", "HOME", "IFS", "SHELL", "GCONV_PATH",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "PROXY_HOST",
    "CROW_SMTP_PASS", "COMPOSE_FILE", "DOCKER_HOST",
    // Case does not matter.
    "node_options", "http_proxy",
  ];
  for (const name of denied) assert.equal(isDeniedApiKeyEnvName(name), true, name);
  for (const name of ["DEMO_API_KEY", "TS_AUTHKEY", "VLLM_HF_TOKEN", "BRAVE_API_KEY", "OPENAI_API_KEY"]) {
    assert.equal(isDeniedApiKeyEnvName(name), false, name);
  }
  assert.ok(API_KEY_ENV_DENY.exact.includes("NODE_OPTIONS"));
  assert.ok(API_KEY_ENV_DENY.prefixes.includes("LD_"));

  const manifest = {
    ...DEMO,
    id: "apikey-denied",
    name: "Denied",
    env_vars: denied.map((name) => ({ name, required: true, secret: true, explain: "x" })),
  };
  seed("apikey-denied", manifest);
  await withServer({ owner: true }, async (post) => {
    for (const name of denied) {
      const r = await save(post, { bundle_id: "apikey-denied", env_key: name, value: VALUE });
      assert.equal(r.status, 400, name);
      assert.match(r.body.error, /controls how programs run/, name);
    }
  });
  assert.deepEqual(readMcp("apikey-denied"), {});
});

test("the key and its help come from the REVIEWED manifest, never the installed copy", async () => {
  const installedCopy = {
    ...DEMO,
    id: "apikey-reviewed",
    env_vars: [...DEMO.env_vars, { name: "INSTALLED_ONLY_KEY", required: true, secret: true, explain: "added in the installed tree" }],
  };
  seed("apikey-reviewed", { ...DEMO, id: "apikey-reviewed", name: "Reviewed" }, { installedManifest: installedCopy });
  await withServer({ owner: true }, async (post) => {
    const tampered = await save(post, { bundle_id: "apikey-reviewed", env_key: "INSTALLED_ONLY_KEY", value: VALUE });
    assert.equal(tampered.status, 400, "the installed copy's extra key is not a declaration");
    assert.match(tampered.body.error, /does not declare/);
    const real = await save(post, { bundle_id: "apikey-reviewed", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(real.status, 200, JSON.stringify(real.body));
  });
  assert.deepEqual(readMcp("apikey-reviewed"), {}, "the reviewed key is sealed, so no plain value lands in the entry");
  assert.deepEqual(readMcpEntry("apikey-reviewed").keychainEnv, ["DEMO_API_KEY"], "only the reviewed, declared key is listed");
});

// ── 3. the writes ───────────────────────────────────────────────────────────────────

test("a save writes the keychain, the MCP entry and an existing .env, and says a restart applies it", async () => {
  const dir = seed(
    "apikey-writes",
    { ...DEMO, id: "apikey-writes", name: "Writes App" },
    { dotEnv: "# kept by the operator\nOTHER=1\nDEMO_API_KEY=\n" },
  );
  writeFileSync(GATEWAY_ENV, "# gateway env\n");
  await withServer({ owner: true }, async (post) => {
    const r = await save(post, { bundle_id: "apikey-writes", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ["needs_config", "needs_restart", "ok"], "the answer carries the two facts only");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.needs_restart, true, "the MCP entry was written, so a spawned child needs a restart");
    assert.deepEqual(r.body.needs_config, [], "the required key is no longer missing");
    assert.equal(JSON.stringify(r.body).includes(VALUE), false);
  });

  // (a) the keychain: one sealed 'extension' row under this bundle and env key.
  const rows = await keychainRows("apikey-writes");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "extension");
  assert.equal(rows[0].bundle_id, "apikey-writes");
  assert.equal(rows[0].env_key, "DEMO_API_KEY");
  assert.equal(rows[0].label, "Writes App - DEMO_API_KEY");
  assert.equal(rows[0].origin, "typed");
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].secret, VALUE, "the stored value is the one that was typed");
  assert.equal(rows[0].first_view_pending, false);
  // Sealed at rest: the column holds a sealed blob, not the key.
  const sealedDb = createDbClient();
  try {
    const sealed = await sealedDb.execute({
      sql: "SELECT secret_sealed FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ?",
      args: ["apikey-writes", "DEMO_API_KEY"],
    });
    const blob = String((sealed.rows || [])[0]?.secret_sealed ?? "");
    assert.ok(blob.length > 0);
    assert.equal(blob.includes(VALUE), false, "the key is not stored in the clear");
  } finally {
    sealedDb.close();
  }

  // (b) the MCP entry (what the bundle's own tools read) lists the key by NAME — the value is
  // sealed in the keychain, and the owner provenance is recorded on the save.
  const entry = readMcpEntry("apikey-writes");
  assert.equal("DEMO_API_KEY" in readMcp("apikey-writes"), false, "the entry holds no plain value");
  assert.deepEqual(entry.keychainEnv, ["DEMO_API_KEY"], "it lists the key's name");
  assert.equal(readFileSync(MCP_ADDONS, "utf8").includes(VALUE), false, "the key is not in the file");
  assert.equal(hydrateAddonEntry("apikey-writes", entry, { unsealer: "gateway", ...gatewayKeychainPaths() }).env.DEMO_API_KEY, VALUE, "and the keychain holds it");
  assert.deepEqual(entry.ownerSet, ["DEMO_API_KEY"]);
  assert.equal(statSync(MCP_ADDONS).mode & 0o777, 0o600, "the file holding the key stays private");

  // (c) the .env, line-preserving, at mode 600.
  const envText = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envText, /# kept by the operator/);
  assert.equal(readDotEnv(dir).OTHER, "1");
  assert.equal(readDotEnv(dir).DEMO_API_KEY, VALUE);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
});

test("re-saving a key overwrites the same keychain row and the same files", async () => {
  const dir = seed("apikey-resave", { ...DEMO, id: "apikey-resave", name: "Resave" }, { dotEnv: "DEMO_API_KEY=\n" });
  await withServer({ owner: true }, async (post) => {
    const first = await save(post, { bundle_id: "apikey-resave", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await save(post, { bundle_id: "apikey-resave", env_key: "DEMO_API_KEY", value: VALUE2 });
    assert.equal(second.status, 200, JSON.stringify(second.body));
  });
  const rows = await keychainRows("apikey-resave");
  assert.equal(rows.length, 1, "a rotated key updates the one row");
  assert.equal(rows[0].secret, VALUE2);
  const resaved = readMcpEntry("apikey-resave");
  assert.deepEqual(resaved.keychainEnv, ["DEMO_API_KEY"]);
  assert.equal(hydrateAddonEntry("apikey-resave", resaved, { unsealer: "gateway", ...gatewayKeychainPaths() }).env.DEMO_API_KEY, VALUE2, "the rotated value is what the child gets");
  assert.equal(readFileSync(MCP_ADDONS, "utf8").includes(VALUE2), false, "no plain copy in the entry");
  assert.equal(readDotEnv(dir).DEMO_API_KEY, VALUE2);
});

test("a docker bundle's own gateway env gets the key too; a bundle without a .env is not given one", async () => {
  writeFileSync(GATEWAY_ENV, "# gateway env\n");
  seed("apikey-docker", { ...DEMO, id: "apikey-docker", name: "Docker App", type: "bundle" }, { dotEnv: "DEMO_API_KEY=\n" });
  seed("apikey-noenv", { ...DEMO, id: "apikey-noenv", name: "No Env" });
  await withServer({ owner: true }, async (post) => {
    const docker = await save(post, { bundle_id: "apikey-docker", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(docker.status, 200, JSON.stringify(docker.body));
    assert.equal(docker.body.needs_restart, true);
    const plain = await save(post, { bundle_id: "apikey-noenv", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
  });
  assert.equal(parseEnvText(readFileSync(GATEWAY_ENV, "utf8")).DEMO_API_KEY, VALUE);
  assert.equal(existsSync(join(TMP_HOME, "bundles", "apikey-noenv", ".env")), false, "a bundle with no .env gets none");
});

// ── 4. failures ─────────────────────────────────────────────────────────────────────

test("a keychain that will not open answers 500 and writes nothing else", async () => {
  const dotEnv = "OTHER=1\nDEMO_API_KEY=\n";
  const dir = seed("apikey-kcfail", { ...DEMO, id: "apikey-kcfail", name: "Keychain Fail" }, { dotEnv });
  const before = readFileSync(MCP_ADDONS, "utf8");
  const captured = captureConsole();
  B._setApiKeySaveDepsForTest({ ensureWriteKey: async () => { throw Object.assign(new Error("damaged key file"), { code: "KEY_DAMAGED" }); } });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await save(post, { bundle_id: "apikey-kcfail", env_key: "DEMO_API_KEY", value: VALUE });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, API_KEY_SAVE_REFUSALS.keychain);
      assert.equal(JSON.stringify(r.body).includes(VALUE), false);
    });
  } finally {
    B._setApiKeySaveDepsForTest(null);
    captured.restore();
  }
  assert.equal(readFileSync(MCP_ADDONS, "utf8"), before, "the MCP entry was not touched");
  assert.deepEqual(readDotEnv(dir), { OTHER: "1", DEMO_API_KEY: "" }, "the .env was not touched");
  assert.deepEqual(await keychainRows("apikey-kcfail"), []);
  assert.equal(captured.lines.join("\n").includes(VALUE), false, "the log line names the key, never its value");
  assert.match(captured.lines.join("\n"), /apikey-kcfail: DEMO_API_KEY/);
});

test("the key file is gone while rows exist: the card's save refuses with the keychain sentence and mints NO new key", async () => {
  // Earlier saves in this file wrote keychain rows under the scratch home's key.
  const keyFile = join(TMP_HOME, "secrets", "keychain.key");
  assert.equal(existsSync(keyFile), true, "the key this test removes was minted by an earlier save");
  const dir = seed("apikey-nokey", { ...DEMO, id: "apikey-nokey", name: "No Key" }, { dotEnv: "OTHER=1\nDEMO_API_KEY=\n" });
  const mcpBefore = readFileSync(MCP_ADDONS, "utf8");
  const envBefore = readFileSync(join(dir, ".env"), "utf8");
  const keyBefore = readFileSync(keyFile);
  rmSync(keyFile);
  let minted = null;
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await save(post, { bundle_id: "apikey-nokey", env_key: "DEMO_API_KEY", value: VALUE });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, API_KEY_SAVE_REFUSALS.keychain, "the fixed keychain sentence, never a driver message");
      assert.equal(JSON.stringify(r.body).includes(VALUE), false);
      minted = existsSync(keyFile); // judged INSIDE, before the restore below
    });
    assert.equal(minted, false, "a new keychain key was not minted over the rows it would orphan");
  } finally {
    // Put the key back so the tests after this one still read their rows.
    if (!existsSync(keyFile)) writeFileSync(keyFile, keyBefore, { mode: 0o600 });
  }
  assert.equal(readFileSync(MCP_ADDONS, "utf8"), mcpBefore, "the MCP entry was not touched");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), envBefore, "the .env was not touched");
  assert.deepEqual(await keychainRows("apikey-nokey"), [], "and no row was written");
});

test("no response, error sentence or log line from any refusal carries the value", async () => {
  seed("apikey-quiet", { ...DEMO, id: "apikey-quiet", name: "Quiet" }, { dotEnv: "DEMO_API_KEY=\n" });
  const captured = captureConsole();
  try {
    await withServer({ owner: true }, async (post) => {
      const bodies = [
        { bundle_id: "apikey-quiet", env_key: "NOT_DECLARED", value: VALUE },
        { bundle_id: "apikey-quiet", env_key: "DEMO_GENERATED", value: VALUE },
        { bundle_id: "apikey-quiet", env_key: "DEMO_PLAIN", value: VALUE },
        { bundle_id: "apikey-quiet", env_key: "DEMO_API_KEY", value: `${VALUE}\nX=1` },
        { bundle_id: "apikey-quiet", env_key: "DEMO_API_KEY", value: "k".repeat(API_KEY_MAX_LENGTH + 1) },
        { bundle_id: "apikey-quiet", env_key: "DEMO_PATTERN_KEY", value: VALUE },
        { bundle_id: "nope", env_key: "DEMO_API_KEY", value: VALUE },
      ];
      for (const body of bodies) {
        const r = await save(post, body);
        assert.equal(JSON.stringify(r.body).includes(VALUE), false);
      }
    });
  } finally {
    captured.restore();
  }
  assert.equal(captured.lines.join("\n").includes(VALUE), false);
});

test("the module refuses without a reviewed manifest, and reports a keychain failure as an answer", async () => {
  const none = await saveApiKey({ bundleId: "apikey-x", manifest: null, envKey: "DEMO_API_KEY", value: VALUE });
  assert.equal(none.ok, false);
  assert.equal(none.status, 400);
  assert.equal(none.error, API_KEY_SAVE_REFUSALS.no_manifest);

  let applied = 0;
  const deps = {
    findInvalidEnv: () => null,
    envPatternViolation: () => null,
    openDb: () => ({ close() {} }),
    ensureWriteKey: async () => ({ id: "k1", seed: Buffer.alloc(32) }),
    save: async () => { throw new Error("seal failed"); },
    applyEnv: async () => { applied++; return true; },
    propagate: () => { applied++; return true; },
    needsConfig: () => [],
    bundleDir: join(TMP_HOME, "bundles", "apikey-y"),
    warn: () => {},
  };
  const failed = await saveApiKey({ bundleId: "apikey-y", manifest: DEMO, envKey: "DEMO_API_KEY", value: VALUE, deps });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500);
  assert.equal(failed.error, API_KEY_SAVE_REFUSALS.keychain);
  assert.equal(applied, 0, "nothing else is written when the keychain fails");
  assert.equal(JSON.stringify(failed).includes(VALUE), false);
});

test("the module's seams see the exact keychain entry, MCP write and restart answer", async () => {
  const calls = { saved: [], env: [], propagated: [] };
  const deps = {
    findInvalidEnv: () => null,
    envPatternViolation: () => null,
    openDb: () => ({ close() {} }),
    ensureWriteKey: async () => ({ id: "k1", seed: Buffer.alloc(32) }),
    save: async (_db, _key, entry) => { calls.saved.push(entry); return { id: 1 }; },
    applyEnv: async (id, values, manifest) => { calls.env.push({ id, values, manifest }); return true; },
    propagate: (id, values) => { calls.propagated.push({ id, values }); return false; },
    needsConfig: () => ["DEMO_API_KEY"],
    bundleDir: TMP_BUNDLES,
    now: () => Date.parse("2026-11-05T12:00:00Z"),
    warn: () => {},
  };
  const out = await saveApiKey({ bundleId: "apikey-demo", manifest: DEMO, envKey: "DEMO_API_KEY", value: VALUE, deps });
  assert.deepEqual(out, { ok: true, needs_restart: true, needs_config: ["DEMO_API_KEY"] });
  assert.deepEqual(calls.saved.map((s) => ({ bundleId: s.bundleId, envKey: s.envKey, label: s.label, origin: s.origin, secret: s.secret })), [{
    bundleId: "apikey-demo",
    envKey: "DEMO_API_KEY",
    label: "Demo App - DEMO_API_KEY",
    origin: "typed",
    secret: VALUE,
  }]);
  assert.deepEqual(calls.env, [{ id: "apikey-demo", values: { DEMO_API_KEY: VALUE }, manifest: DEMO }]);
  assert.equal(calls.propagated.length, 0, "no .env in that dir, so the gateway env is not touched");
});

test("sealing off (CROW_ADDON_SECRETS_KEYCHAIN=0): the card writes the key plain into the entry and lists nothing", async () => {
  const dir = seed("apikey-off", { ...DEMO, id: "apikey-off", name: "Off App" }, { dotEnv: "DEMO_API_KEY=\n" });
  await withSealing(false, () => withServer({ owner: true }, async (post) => {
    const r = await save(post, { bundle_id: "apikey-off", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }));
  const entry = readMcpEntry("apikey-off");
  assert.equal(entry.env.DEMO_API_KEY, VALUE, "the operator opted out: today's plain shape");
  assert.equal("keychainEnv" in entry, false, "and the entry lists nothing");
  assert.equal(readDotEnv(dir).DEMO_API_KEY, VALUE);
  // The keychain row is still written (the card always keeps a typed key) — only the entry is plain.
  assert.equal((await keychainRows("apikey-off")).length, 1);
});

// ── 6. sealing ON (task 1.5b: the card's key goes to the keychain, not the file) ─────

/** Run `fn` with the add-on-secrets sealing switch at `on` (off is the operator's explicit "0"). */
async function withSealing(on, fn) {
  const before = process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  process.env.CROW_ADDON_SECRETS_KEYCHAIN = on ? "1" : "0";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
    else process.env.CROW_ADDON_SECRETS_KEYCHAIN = before;
  }
}

test("sealing on: the card's key is sealed (keychainEnv + a row), not left plain in the entry", async () => {
  const dir = seed("apikey-sealed", { ...DEMO, id: "apikey-sealed", name: "Sealed App" }, { dotEnv: "DEMO_API_KEY=\n" });
  await withSealing(true, () => withServer({ owner: true }, async (post) => {
    const r = await save(post, { bundle_id: "apikey-sealed", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.needs_restart, true);
    assert.equal(JSON.stringify(r.body).includes(VALUE), false);
  }));

  const entry = readMcpEntry("apikey-sealed");
  assert.deepEqual(entry.keychainEnv, ["DEMO_API_KEY"], "the entry keeps the NAME of the key");
  assert.equal(JSON.stringify(entry).includes(VALUE), false, "and never the value");
  assert.deepEqual(entry.ownerSet, ["DEMO_API_KEY"], "the owner provenance survives the seal");
  const rows = await keychainRows("apikey-sealed");
  assert.equal(rows.length, 1, "one row (step 1 and the seal write the same one)");
  assert.equal(rows[0].secret, VALUE);
  assert.equal(readDotEnv(dir).DEMO_API_KEY, VALUE, "the bundle's own .env still gets the key");
  assert.deepEqual(
    hydrateAddonEntry("apikey-sealed", entry, { unsealer: "gateway", ...gatewayKeychainPaths() }).env,
    { DEMO_API_KEY: VALUE },
    "the spawn env gets the key back from the keychain",
  );
});

test("a seal failure on the MCP entry answers the fixed keychain sentence and does not write the .env", async () => {
  const dir = seed("apikey-sealfail", { ...DEMO, id: "apikey-sealfail", name: "Seal Fail" }, { dotEnv: "OTHER=1\nDEMO_API_KEY=\n" });
  const envBefore = readFileSync(join(dir, ".env"), "utf8");
  const entryBefore = JSON.stringify(readMcpEntry("apikey-sealfail"));
  B._setApiKeySaveDepsForTest({
    applyEnv: async () => { throw new AddonKeysUnavailableError("ROWS_MISSING", "apikey-sealfail", ["DEMO_API_KEY"]); },
  });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await save(post, { bundle_id: "apikey-sealfail", env_key: "DEMO_API_KEY", value: VALUE });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, API_KEY_SAVE_REFUSALS.keychain);
      assert.equal(JSON.stringify(r.body).includes(VALUE), false);
    });
  } finally {
    B._setApiKeySaveDepsForTest(null);
  }
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), envBefore, "the .env was not written");
  assert.equal(JSON.stringify(readMcpEntry("apikey-sealfail")), entryBefore, "the entry was not touched");
});

test("first-writer-wins: an entry that only LISTS the key is answered from its ACTIVE keychain row", async () => {
  // With add-on sealing ON the entry keeps no plain value for a declared key — only its NAME in
  // `keychainEnv`. `hasValue` (the first-writer-wins check) must therefore answer from the active
  // crow_keychain row: otherwise a generated-value save would happily overwrite the operator's
  // key that the keychain already holds.
  const dir = seed("apikey-fw-sealed", { ...DEMO, id: "apikey-fw-sealed", name: "First Writer" }, { dotEnv: "DEMO_API_KEY=\n" });
  await withSealing(true, () => withServer({ owner: true }, async (post) => {
    const first = await save(post, { bundle_id: "apikey-fw-sealed", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(first.status, 200, JSON.stringify(first.body));
  }));

  const entry = readMcpEntry("apikey-fw-sealed");
  assert.deepEqual(entry.keychainEnv, ["DEMO_API_KEY"], "the entry lists the name");
  assert.equal(readMcp("apikey-fw-sealed").DEMO_API_KEY, undefined, "and holds no plain value to compare");
  assert.equal(JSON.stringify(entry).includes(VALUE), false);

  const second = await saveApiKey({
    bundleId: "apikey-fw-sealed",
    manifest: { ...DEMO, id: "apikey-fw-sealed" },
    envKey: "DEMO_API_KEY",
    value: VALUE2,
    firstWriterWins: true,
    crowHome: TMP_HOME,
  });
  assert.deepEqual(second, { ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value });
  assert.equal(second.error, "This extension already has a value for that key; Crow left it alone.");
  assert.equal(JSON.stringify(second).includes(VALUE2), false, "the refusal never echoes the value");

  const rows = await keychainRows("apikey-fw-sealed");
  assert.equal(rows.length, 1, "no second row");
  assert.equal(rows[0].secret, VALUE, "the first writer's value is still the one saved");
  assert.equal(rows[0].status, "active");
  assert.equal(readMcp("apikey-fw-sealed").DEMO_API_KEY, undefined, "nothing was written into the entry");
  assert.equal(readDotEnv(dir).DEMO_API_KEY, VALUE, "nor into the bundle's .env");

  // Control: the LISTING alone is not a value. A fresh add-on whose entry lists the name with no
  // row behind it is saved normally — the 409 above came from the row, not from `keychainEnv`.
  seed("apikey-fw-fresh", { ...DEMO, id: "apikey-fw-fresh", name: "Fresh" });
  const listingOnly = JSON.parse(readFileSync(MCP_ADDONS, "utf8"));
  listingOnly["apikey-fw-fresh"].keychainEnv = ["DEMO_API_KEY"];
  writeFileSync(MCP_ADDONS, JSON.stringify(listingOnly, null, 2), { mode: 0o600 });
  assert.deepEqual(await keychainRows("apikey-fw-fresh"), [], "no row yet");
  const remembered = [];
  const fresh = await saveApiKey({
    bundleId: "apikey-fw-fresh",
    manifest: { ...DEMO, id: "apikey-fw-fresh" },
    envKey: "DEMO_API_KEY",
    value: VALUE2,
    firstWriterWins: true,
    crowHome: TMP_HOME,
    deps: {
      withLock: (id, fn) => fn(),
      findInvalidEnv: () => null,
      envPatternViolation: () => null,
      openDb: () => ({ close() {} }),
      ensureWriteKey: async () => ({ id: "key-1", seed: Buffer.alloc(32) }),
      save: async () => { throw new Error("a first-writer-wins save never takes the overwriting path"); },
      remember: async (_db, _key, entry) => { remembered.push(entry); return 11; },
      applyEnv: async () => true,
      propagate: () => false,
      needsConfig: () => [],
      mcpValue: () => "",
      now: () => Date.parse("2026-11-12T09:30:00Z"),
      warn: () => {},
    },
  });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(remembered.length, 1, "the atomic write claimed the key");
  assert.equal(remembered[0].secret, VALUE2);
});

test("no API-key save leaks the sentinel: console, audit rows, notifications, the entry", async (t) => {
  const out = captureOutput(t);
  const SENTINEL = "sentinel-" + randomUUID();
  seed("apikey-scan", { ...DEMO, id: "apikey-scan", name: "Scan App" }, { dotEnv: "DEMO_API_KEY=\n" });
  await withSealing(true, () => withServer({ owner: true }, async (post) => {
    const ok = await save(post, { bundle_id: "apikey-scan", env_key: "DEMO_API_KEY", value: SENTINEL });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    B._setApiKeySaveDepsForTest({ applyEnv: async () => { throw new AddonKeysUnavailableError("ROWS_MISSING", "apikey-scan", ["DEMO_API_KEY"]); } });
    try {
      const bad = await save(post, { bundle_id: "apikey-scan", env_key: "DEMO_API_KEY", value: SENTINEL });
      assert.equal(bad.status, 500);
    } finally {
      B._setApiKeySaveDepsForTest(null);
    }
  }));
  assert.equal(out.text().includes(SENTINEL), false, "no console line carries a value");
  assert.deepEqual(scanDb(gatewayKeychainPaths().dbPath, SENTINEL), [], "no audit row or bell carries a value");
  assert.equal(JSON.stringify(readMcpEntry("apikey-scan")).includes(SENTINEL), false);
});

// ── 7. nothing is synced ────────────────────────────────────────────────────────────
test("the keychain table is on the never-sync list, so a saved key reaches no peer", () => {
  const src = readFileSync(join(REPO, "servers/sharing/instance-sync.js"), "utf8");
  const start = src.indexOf("export const LOCAL_ONLY_TABLES");
  assert.ok(start > 0, "instance-sync still declares the local-only tables");
  const list = src.slice(start, src.indexOf("]);", start));
  assert.match(list, /"crow_keychain"/, "crow_keychain is never replicated");
});
test("review fixes: more runtime-control names are denied, a satellite install and a previous_key slot are refused, a symlinked .env is not followed", async () => {
  for (const n of ["NODE_TLS_REJECT_UNAUTHORIZED", "OPENSSL_CONF", "GIT_SSH_COMMAND", "GLIBC_TUNABLES", "MALLOC_CONF", "BASH_FUNC_x%%", "PROMPT_COMMAND", "NPM_CONFIG_REGISTRY", "XDG_CONFIG_HOME", "REQUESTS_CA_BUNDLE", "SSLKEYLOGFILE", "OPENSSL_MODULES"]) {
    assert.equal(isDeniedApiKeyEnvName(n), true, n);
  }
  assert.equal(isDeniedApiKeyEnvName("DEMO_API_KEY"), false);
  const manifest = { ...DEMO, id: "apikey-review", name: "Review App", env_vars: [...DEMO.env_vars, { name: "DEMO_ROTATING", required: false, secret: true, previous_key: "DEMO_ROTATING_PREV" }] };
  const dir = seed("apikey-review", manifest, { dotEnv: "DEMO_API_KEY=\n" });
  // satellite install, seeded once: the entry (mode: "satellite") plus the bundle copy
  seed("apikey-sat", { ...DEMO, id: "apikey-sat", name: "Sat" }, { installMode: "satellite" });
  const satEntries = JSON.parse(readFileSync(INSTALLED, "utf8")).filter((e) => e && e.id === "apikey-sat");
  assert.equal(satEntries.length, 1, "the satellite fixture is one install entry");
  assert.equal(satEntries[0].mode, "satellite");
  await withServer({ owner: true }, async (post) => {
    const sat = await save(post, { bundle_id: "apikey-sat", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(sat.status, 400);
    assert.match(sat.body.error, /runs on another machine/, "refused because the install is a satellite");
    assert.equal(JSON.stringify(sat.body).includes(VALUE), false);
    const rot = await save(post, { bundle_id: "apikey-review", env_key: "DEMO_ROTATING", value: VALUE });
    assert.equal(rot.status, 400);
    assert.equal(rot.body.error, API_KEY_SAVE_REFUSALS.rotating, "the refusal says the key is rotated in Configure, not that it is undeclared");
    assert.notEqual(rot.body.error, API_KEY_SAVE_REFUSALS.undeclared);
    assert.equal(JSON.stringify(rot.body).includes(VALUE), false);
    // a symlinked .env: refused, and the link target is never written
    const target = join(TMP_HOME, "symlink-target.txt");
    writeFileSync(target, "UNTOUCHED=1\n");
    rmSync(join(dir, ".env"));
    symlinkSync(target, join(dir, ".env"));
    const link = await save(post, { bundle_id: "apikey-review", env_key: "DEMO_API_KEY", value: VALUE });
    assert.equal(link.status, 500);
    assert.equal(readFileSync(target, "utf8"), "UNTOUCHED=1\n");
    assert.equal(JSON.stringify(link.body).includes(VALUE), false);
  });
});
