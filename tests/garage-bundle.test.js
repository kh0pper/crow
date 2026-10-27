/**
 * File Storage (Garage) bundle — Garage migration PR 1.
 *
 * The bundle must: pin Garage v2.4.1 by digest; publish the S3 port on the chosen bind
 * address and the admin port on loopback only; keep every secret out of garage.toml;
 * generate every secret (and the S3 key id) into the Crow keychain so a reinstall with no
 * .env restores the same values (Garage refuses to start when the default key's secret
 * changes); never hand the master admin token to the gateway or another bundle; keep
 * GARAGE_BIND_ADDR / GARAGE_DATA_PATH across a reinstall; and never re-render or re-copy
 * garage.toml / docker-compose.yml on a manifest-bump refresh.
 *
 * Scratch CROW_HOME + data dir, stubbed `docker compose` and `docker`: nothing touches the host.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-garage-home-"));
process.env.CROW_HOME = TMP_HOME;
const TMP_DATA = mkdtempSync(join(tmpdir(), "crow-garage-data-"));
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CROW_HOME = TMP_HOME;
const B = await import("../servers/gateway/routes/bundles.js");
const K = await import("../servers/gateway/keychain/store.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { createDbClient } = await import("../servers/db.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const { renderGarageToml } = await import("../bundles/garage/scripts/render-config.mjs");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-garage-app-"));
const GW_ENV = join(mkdtempSync(join(tmpdir(), "crow-garage-gw-")), ".env");
writeFileSync(GW_ENV, "# gateway env (test)\n");
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(GW_ENV);
B._setRestartHookForTest(() => {});
B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null); B._setDockerRunnerForTest(null);
  B._setRestartHookForTest(null); B._setAppEnvPathForTest(null);
  for (const d of [TMP_HOME, TMP_DATA, FIXTURES]) rmScratch(d);
});

const DIR = join(REPO, "bundles", "garage");
const DIGEST = "sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020";
const manifest = () => JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const compose = () => readFileSync(join(DIR, "docker-compose.yml"), "utf8");
const spec = (name) => manifest().env_vars.find((v) => v.name === name);

// ── compose ──

test("image: Garage v2.4.1 pinned by its manifest-list digest, never a floating tag", () => {
  const images = [...compose().matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(images, [`dxflrs/garage:v2.4.1@${DIGEST}`]);
  assert.doesNotMatch(compose(), /:latest\b/);
});

test("command: single node with the env-provided default key", () => {
  assert.match(compose(), /command:\s*\["\/garage", "server", "--single-node", "--default-access-key"\]/);
});

test("ports: S3 3900 on GARAGE_BIND_ADDR (default loopback), admin 3903 on loopback only, RPC never published", () => {
  const ports = [...compose().matchAll(/^\s*-\s+"([^"]+:\d+:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(ports, ["${GARAGE_BIND_ADDR:-127.0.0.1}:3900:3900", "127.0.0.1:3903:3903"]);
  assert.doesNotMatch(compose(), /3901:3901|3902:3902/);
});

test("healthcheck: exec form `/garage health` (the image has no shell)", () => {
  assert.match(compose(), /test:\s*\["CMD", "\/garage", "health"\]/);
  assert.doesNotMatch(compose(), /CMD-SHELL/);
});

test("secrets reach Garage only through the environment, each hard-required", () => {
  for (const k of ["GARAGE_RPC_SECRET", "GARAGE_ADMIN_TOKEN", "GARAGE_METRICS_TOKEN", "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY"]) {
    assert.match(compose(), new RegExp(`${k}: "\\$\\{${k}:\\?`), k);
  }
  assert.match(compose(), /- \.\/garage\.toml:\/etc\/garage\.toml:ro/);
  assert.match(compose(), /- garage-meta:\/var\/lib\/garage\/meta/);
  assert.match(compose(), /- \$\{GARAGE_DATA_PATH:-garage-data\}:\/var\/lib\/garage\/data/);
});

test("port registry rows: 3900 S3, 3902 reserved, 3903 admin (asserted here as well as by check-ports)", () => {
  const doc = readFileSync(join(REPO, "docs/developers/port-allocation.md"), "utf8");
  assert.match(doc, /^\| 3900 \| [^|]+\| garage \(S3 API/m);
  assert.match(doc, /^\| 3902 \| [^|]+\| garage \(web endpoint, reserved/m);
  assert.match(doc, /^\| 3903 \| 127\.0\.0\.1 \| garage \(admin API/m);
});

// ── garage.toml ──

test("garage.toml shipped == the renderer's default output (no drift)", () => {
  assert.equal(readFileSync(join(DIR, "garage.toml"), "utf8"), renderGarageToml());
});

test("garage.toml: single node, sqlite, fsync on, no compression, us-east-1, and no secrets or v2.5-only keys", () => {
  const t = renderGarageToml();
  for (const line of [
    'replication_factor = 1', 'db_engine = "sqlite"', "metadata_fsync = true", "data_fsync = true",
    'compression_level = "none"', 's3_region = "us-east-1"', 'api_bind_addr = "[::]:3900"', 'api_bind_addr = "[::]:3903"',
    'data_dir = "/var/lib/garage/data"', 'metadata_dir = "/var/lib/garage/meta"', 'metadata_auto_snapshot_interval = "6h"',
  ]) assert.ok(t.includes(line), line);
  assert.doesNotMatch(t, /public_endpoint/);
  assert.doesNotMatch(t, /^\s*(rpc_secret|admin_token|metrics_token)\s*=/m);
});

test("garage.toml: two data dirs render the capacity form, and each writable dir needs a capacity", () => {
  const t = renderGarageToml({ dataDirs: [{ path: "/data/a", capacity: "150G" }, { path: "/data/b", capacity: "90G" }] });
  assert.match(t, /data_dir = \[\n {2}\{ path = "\/data\/a", capacity = "150G" \},\n {2}\{ path = "\/data\/b", capacity = "90G" \},\n\]/);
  assert.throws(() => renderGarageToml({ dataDirs: [{ path: "/data/a" }, { path: "/data/b", capacity: "1G" }] }), /needs a capacity/);
  assert.throws(() => renderGarageToml({ dataDirs: ["relative/dir"] }), /absolute/);
  assert.throws(() => renderGarageToml({ dataDirs: [] }), /at least one/);
});

// ── manifest ──

test("manifest: valid contract; every generated value is keychain-saved; master tokens never propagate", () => {
  const m = manifest();
  assert.deepEqual(validateManifest(m, DIR).errors || [], []);
  const gen = m.env_vars.filter((v) => v.generate);
  assert.deepEqual(gen.map((v) => v.name).sort(), ["GARAGE_ADMIN_TOKEN", "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY", "GARAGE_METRICS_TOKEN", "GARAGE_RPC_SECRET"]);
  for (const v of gen) {
    assert.equal(v.keychain, true, `${v.name} keychain`);
    assert.equal(v.secret, true, `${v.name} secret`);
    assert.ok(v.keychain_label, `${v.name} keychain_label`);
  }
  assert.equal(spec("GARAGE_RPC_SECRET").generate, "hex32");
  assert.equal(spec("GARAGE_DEFAULT_ACCESS_KEY").generate, "garage_key_id");
  assert.equal(spec("GARAGE_DEFAULT_SECRET_KEY").generate, "hex32");
  for (const k of ["GARAGE_ADMIN_TOKEN", "GARAGE_RPC_SECRET", "GARAGE_METRICS_TOKEN", "GARAGE_BIND_ADDR", "GARAGE_DATA_PATH"]) {
    assert.equal(spec(k).propagate, false, `${k} stays out of the gateway .env`);
  }
  assert.deepEqual(Object.keys(S.gatewayGeneratedEnv(m, { GARAGE_ADMIN_TOKEN: "a", GARAGE_RPC_SECRET: "b", GARAGE_METRICS_TOKEN: "c", GARAGE_DEFAULT_ACCESS_KEY: "GKx", GARAGE_DEFAULT_SECRET_KEY: "d" })).sort(), ["S3_ACCESS_KEY", "S3_SECRET_KEY"]);
});

// ── install / reinstall / refresh ──

function stage() {
  const dir = join(FIXTURES, "garage");
  rmSync(dir, { recursive: true, force: true });
  cpSync(DIR, dir, { recursive: true });
  // No ports: the installer would otherwise try `sudo -n ufw` on this host.
  const m = { ...manifest(), ports: [] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  return m;
}
const installedEnv = () => parseEnvText(readFileSync(join(CROW_HOME, "bundles", "garage", ".env"), "utf8"));
const formDefaults = (m) => Object.fromEntries(m.env_vars.filter((v) => !v.generate && v.default).map((v) => [v.name, v.default]));
// As the owner's own dashboard session submits it (ownerEnv: a typed folder is granted).
async function install(envVars, opts = {}) {
  const m = stage();
  const job = B._createJobForTest("garage", "install");
  const out = await B.runInstallJob("garage", envVars, { job, installedSnapshot: [], consentVerified: false, manifest: m, keychain: null, ownerEnv: envVars, ...opts });
  assert.equal(out.ok, true, out.reason);
  return { env: installedEnv(), job };
}
async function entries() {
  const d = createDbClient();
  try { return (await K.listEntries(d, { keyId: loadKeychainKey().id })).filter((e) => e.bundle_id === "garage"); }
  finally { d.close(); }
}

let FIRST;
test("fresh install: every secret minted in its shape, saved to the keychain; the gateway gets S3_* only", async () => {
  const { env, job } = await install(formDefaults(manifest()));
  FIRST = env;
  assert.match(env.GARAGE_RPC_SECRET, /^[0-9a-f]{64}$/);
  assert.match(env.GARAGE_DEFAULT_ACCESS_KEY, /^GK[0-9a-f]{24}$/);
  assert.match(env.GARAGE_DEFAULT_SECRET_KEY, /^[0-9a-f]{64}$/);
  assert.match(env.GARAGE_ADMIN_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.match(env.GARAGE_METRICS_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(env.GARAGE_BIND_ADDR, "127.0.0.1");
  const rows = await entries();
  assert.deepEqual(rows.map((r) => r.env_key).sort(), ["GARAGE_ADMIN_TOKEN", "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY", "GARAGE_METRICS_TOKEN", "GARAGE_RPC_SECRET"]);
  const gw = parseEnvText(readFileSync(GW_ENV, "utf8"));
  assert.equal(gw.S3_ACCESS_KEY, env.GARAGE_DEFAULT_ACCESS_KEY);
  assert.equal(gw.S3_SECRET_KEY, env.GARAGE_DEFAULT_SECRET_KEY);
  assert.equal(gw.S3_ENDPOINT, "127.0.0.1:3900");
  for (const k of ["GARAGE_ADMIN_TOKEN", "GARAGE_RPC_SECRET", "GARAGE_METRICS_TOKEN", "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY", "GARAGE_BIND_ADDR", "GARAGE_DATA_PATH"]) {
    assert.equal(gw[k], undefined, `${k} never reaches the gateway .env`);
  }
  const log = job.log.join("\n");
  for (const k of ["GARAGE_ADMIN_TOKEN", "GARAGE_RPC_SECRET", "GARAGE_DEFAULT_SECRET_KEY"]) assert.ok(!log.includes(env[k]), `${k} value never reaches the job log`);
});

test("in-place reinstall keeps GARAGE_BIND_ADDR, GARAGE_DATA_PATH and every generated value", async () => {
  const dataPath = mkdtempSync(join(tmpdir(), "crow-garage-objects-"));
  try {
    // The owner sets both once (a typed folder is granted to this extension)...
    let { env } = await install({ ...formDefaults(manifest()), GARAGE_BIND_ADDR: "100.64.20.5", GARAGE_DATA_PATH: dataPath });
    assert.equal(env.GARAGE_BIND_ADDR, "100.64.20.5");
    assert.equal(env.GARAGE_DATA_PATH, dataPath);
    // ...then reinstalls with the form as it comes (its defaults): nothing is reset.
    ({ env } = await install(formDefaults(manifest())));
    assert.equal(env.GARAGE_BIND_ADDR, "100.64.20.5", "the form's default 127.0.0.1 does not overwrite the kept bind address");
    assert.equal(env.GARAGE_DATA_PATH, dataPath, "the data folder is kept");
    for (const k of ["GARAGE_RPC_SECRET", "GARAGE_ADMIN_TOKEN", "GARAGE_METRICS_TOKEN", "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY"]) {
      assert.equal(env[k], FIRST[k], `${k} kept`);
    }
  } finally {
    rmScratch(dataPath);
  }
});

test("rebuilt machine (no .env, no retained copy): the keychain restores the same key id and secrets", async () => {
  rmSync(join(CROW_HOME, "bundles", "garage"), { recursive: true, force: true });
  rmSync(S.retainedEnvPath(CROW_HOME, "garage"), { force: true });
  const { env } = await install(formDefaults(manifest()));
  for (const k of ["GARAGE_RPC_SECRET", "GARAGE_ADMIN_TOKEN", "GARAGE_METRICS_TOKEN", "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY"]) {
    assert.equal(env[k], FIRST[k], `${k} restored from the keychain, not re-minted`);
  }
});

test("a manifest-bump refresh never re-renders or re-copies garage.toml or docker-compose.yml", async () => {
  const dest = join(CROW_HOME, "bundles", "garage");
  writeFileSync(join(dest, "garage.toml"), "# owner's two-dir layout\n");
  writeFileSync(join(dest, "docker-compose.yml"), "# installed compose\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "garage" }]));
  const m = stage();
  writeFileSync(join(FIXTURES, "garage", "manifest.json"), JSON.stringify({ ...m, version: "9.9.9" }));
  const runs = [];
  const out = await B.repairInstalledBundleAssets({ appBundles: FIXTURES, run: async (...a) => { runs.push(a); return { stdout: "", stderr: "" }; }, skillMode: "off", log: () => {} });
  assert.ok(out.repaired.some((r) => r.startsWith("garage: refreshed")), JSON.stringify(out));
  assert.equal(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")).version, "9.9.9");
  assert.equal(readFileSync(join(dest, "garage.toml"), "utf8"), "# owner's two-dir layout\n");
  assert.equal(readFileSync(join(dest, "docker-compose.yml"), "utf8"), "# installed compose\n");
});

// ── installing Garage never repoints storage that already works ──

async function installWith({ gwEnv = "# gateway env (test)\n", sharedRow = false, minioInstalled = false }) {
  writeFileSync(GW_ENV, gwEnv);
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify(minioInstalled ? [{ id: "minio" }] : []));
  const d = createDbClient();
  try {
    await d.execute({ sql: "DELETE FROM dashboard_settings WHERE key LIKE 'storage.shared.%'", args: [] });
    if (sharedRow) await d.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('storage.shared.endpoint', '100.64.20.5:9000')", args: [] });
  } finally { d.close(); }
  const { job } = await install(formDefaults(manifest()));
  return { gw: parseEnvText(readFileSync(GW_ENV, "utf8")), log: job.log.join("\n") };
}

test("no storage set up yet: installing Garage points Crow's storage at it (S3_* in the gateway .env)", async () => {
  const { gw } = await installWith({});
  assert.equal(gw.S3_ENDPOINT, "127.0.0.1:3900");
  assert.equal(gw.S3_ACCESS_KEY, FIRST.GARAGE_DEFAULT_ACCESS_KEY);
  assert.ok(gw.S3_SECRET_KEY);
});

for (const [label, state] of [
  ["MinIO configured through the gateway env only", { gwEnv: "MINIO_ENDPOINT=localhost\nMINIO_PORT=9000\nMINIO_ROOT_PASSWORD=p\n" }],
  ["Shared Storage rows in the DB", { sharedRow: true }],
  ["the MinIO extension installed", { minioInstalled: true }],
]) {
  test(`storage already set up (${label}): installing Garage leaves it pointing where it is`, async () => {
    const { gw, log } = await installWith(state);
    for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) assert.equal(gw[k], undefined, `${k} not written`);
    if (state.gwEnv) assert.equal(gw.MINIO_ENDPOINT, "localhost", "the MinIO env is untouched");
    assert.match(log, /left as it is/);
  });
}
