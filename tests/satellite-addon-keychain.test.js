/**
 * Task 1.10 — the satellite as an add-on-secrets WRITER and as the spawn-time READER.
 *
 * The satellite owns its own `mcp-addons.json` and its own keychain (`crow_keychain` in
 * satellite.db, key $SAT_HOME/secrets/keychain.key). With `CROW_ADDON_SECRETS_KEYCHAIN=1`:
 *
 *   1. install seals the typed and the generated secret: both names are listed in the entry's
 *      `keychainEnv`, neither value is in the file, both rows are active, and the spawn reader
 *      gets them back (the install's own tool-cache child proves the seal→spawn path);
 *   2. PUT env seals a newly typed value (the row follows), and `null` un-lists the name while
 *      KEEPING its row;
 *   3. two concurrent PUTs of one bundle end with the file, the `.env` and the row agreeing on
 *      the last value (the per-id write lock, 0.6.3);
 *   4. a real child is spawned with the unsealed value in its env, and a listed key that cannot
 *      be read stops the child (START_FAILED_TEXT) instead of starting it with a partial env;
 *   5. the sentinel never reaches the console, the job log, the satellite's audit table or the
 *      keychain in the clear.
 *
 * The harness is tests/satellite-agent-bundles.test.js's: a scratch $SAT_HOME, a paired fake
 * satellite identity, a fake compose/docker world and an injected /proc/meminfo — no docker.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satkeys-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satkeys-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { ensureSatelliteKey, writeCert, writePinned } = await import("../servers/satellite/keys.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { createBundleManager } = await import("../servers/satellite/bundles.js");
const { START_FAILED_TEXT } = await import("../servers/satellite/mcp-host.js");
const { ADDON_KEYS_UNREADABLE, readAddonSecretsSync } = await import("../servers/shared/addon-secrets.js");

const FIXTURE = join(import.meta.dirname, "fixtures", "sat-fake-mcp-server.mjs");
const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const agents = [];
after(async () => {
  for (const a of agents) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const identity = fakeIdentity();
const HOST = "satellite.example.ts.net";
const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const SENTINEL3 = "sentinel-" + randomUUID();

function pairedHome() {
  const home = tmp("satkeys-home-");
  const key = ensureSatelliteKey(home);
  const mgmt = P.generateKeypair();
  const c = issueCert({
    identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444",
    satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.pubHex, now: Date.now(),
  });
  writePinned(home, {
    crow_id: c.payload.crow_id, root_pubkey: c.payload.root_pubkey, mgmt_pubkey: c.payload.mgmt_pubkey,
    primary_url: c.payload.primary_url, primary_instance_id: c.payload.primary_instance_id, target_sha: null,
  });
  writeCert(home, c);
  return { home, key, mgmt };
}

/**
 * The bundle in the agent's own checkout: DEMO_URL (a default), DEMO_TOKEN (typed, `secret`),
 * DEMO_DATA (a plain setting) and DEMO_KEY (generated). `server/index.js` is the fake MCP
 * server, so a spawned child can report the env it was given.
 */
function appBundle(home, id, { manifest = {}, server = null } = {}) {
  const dir = join(home, "app", "bundles", id);
  mkdirSync(join(dir, "server"), { recursive: true });
  const m = {
    id, name: id, version: "1.0.0", type: "bundle",
    satellite: { min_ram_mb: 120 }, mcp: { mem_mb: 40 },
    server: { command: "node", args: ["server/index.js"], envKeys: ["DEMO_URL", "DEMO_TOKEN", "DEMO_KEY"] },
    env_vars: [
      { name: "DEMO_URL", default: "http://localhost:3999" },
      { name: "DEMO_TOKEN", secret: true },
      { name: "DEMO_DATA" },
      { name: "DEMO_KEY", generate: "secret" },
    ],
    ...manifest,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  app:\n    image: demo:1\n");
  writeFileSync(join(dir, "server", "index.js"), server || "// mcp server\n");
  return dir;
}
const fakeMcpServer = () => `import ${JSON.stringify(pathToFileURL(FIXTURE).href)};\n`;

const goodService = () => ({ image: "demo:1", mem_limit: "134217728", oom_score_adj: 500, ports: [{ target: 3000, published: "3999", host_ip: "127.0.0.1", protocol: "tcp" }] });

function fakeDocker() {
  const w = { calls: [] };
  w.composeRunner = async (args, opts = {}) => {
    w.calls.push({ args, cwd: opts.cwd });
    if (args.includes("config")) return { stdout: JSON.stringify({ name: "demo", services: { app: goodService() } }), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  w.dockerRunner = async () => ({ stdout: "" });
  return w;
}

const meminfo = (mb) => `MemTotal: 999424 kB\nMemAvailable: ${mb * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`;

async function boot({ world = fakeDocker(), setup } = {}) {
  const s = pairedHome();
  if (setup) setup(s.home);
  const a = await startAgent({
    env: { CROW_HOME: s.home, CROW_SATELLITE_PORT: "0" }, out: () => {}, authLog: () => {}, sha: "a".repeat(40),
    bundleDeps: {
      composeRunner: world.composeRunner, dockerRunner: world.dockerRunner, mcpPids: () => [],
      readText: (p) => (p === "/proc/meminfo" ? meminfo(800) : null),
      npmRunner: async () => { throw new Error("npm must not run in this test"); },
    },
  });
  agents.push(a);
  return { ...s, a, world };
}

const serveFetch = (port) => async (url, init = {}) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } });
};
const call = (t, method, path, body) => satelliteFetch(
  { id: t.a.satelliteId, tailnet_host: HOST, satellite_pubkey: t.a.key.ed25519_pub },
  { method, path: `/satellite/v1/${path}`, body, caller: "owner-local", maxBytes: 1024 * 1024, fetchImpl: serveFetch(t.a.port), mgmtKey: { ed25519_priv: t.mgmt.privHex } },
);

async function waitJob(t, id) {
  for (let i = 0; i < 500; i++) {
    const r = await call(t, "GET", `jobs/${id}`);
    assert.equal(r.status, 200);
    if (r.json.status !== "running") return r.json;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  throw new Error("job did not finish");
}

async function installDemand(t, env = { DEMO_TOKEN: SENTINEL }) {
  const r = await call(t, "POST", "bundles/install", { id: "demo", env });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  return waitJob(t, r.json.job_id);
}

/** Run `fn` with the sealing switch explicitly ON (PR1 ships it OFF). */
async function withSealing(on, fn) {
  const before = process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  if (on) process.env.CROW_ADDON_SECRETS_KEYCHAIN = "1";
  else delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
    else process.env.CROW_ADDON_SECRETS_KEYCHAIN = before;
  }
}

const addonsOf = (home) => JSON.parse(readFileSync(join(home, "mcp-addons.json"), "utf8"));
const dotEnvOf = (home) => readFileSync(join(home, "bundles", "demo", ".env"), "utf8");
const unseal = (t, names) => readAddonSecretsSync("demo", names, { unsealer: "satellite", rawDb: t.a.db, key: loadKeychainKey({ crowHome: t.home }) });
const rowsOf = (t) => t.a.db.prepare("SELECT env_key, origin, status, secret_sealed FROM crow_keychain WHERE bundle_id = 'demo' ORDER BY env_key").all();

let rpcId = 1;
async function callTool(t, name, args = {}) {
  const id = rpcId++;
  return call(t, "POST", "mcp/demo", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}
const textOf = (r) => r.json.result.content.map((c) => c.text).join("");

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── 1. install seals ───────────────────────────────────────────────────────

test("install (sealing on): typed and generated secrets are listed by NAME, neither value is in the entry, both rows active", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  const job = await withSealing(true, () => installDemand(t));
  assert.equal(job.status, "complete", job.log.join("\n"));

  const entry = addonsOf(t.home).demo;
  assert.deepEqual(entry.keychainEnv, ["DEMO_KEY", "DEMO_TOKEN"], "both secrets are listed, typed first alphabetically");
  assert.equal(entry.env.DEMO_TOKEN, undefined, "the typed key is not in mcp-addons.json");
  assert.equal(entry.env.DEMO_KEY, undefined, "neither is the generated one");
  assert.equal(entry.env.DEMO_URL, "http://localhost:3999", "a default stays plain");
  assert.equal(readFileSync(join(t.home, "mcp-addons.json"), "utf8").includes(SENTINEL), false, "no typed value in the file");

  const rows = rowsOf(t);
  assert.deepEqual(rows.map((r) => [r.env_key, r.origin, r.status]), [["DEMO_KEY", "generated", "active"], ["DEMO_TOKEN", "typed", "active"]]);
  assert.ok(rows.every((r) => !r.secret_sealed.includes(SENTINEL)), "the keychain holds ciphertext, never the value");

  // The spawn reader (the one the child manager uses) gets both back.
  const read = unseal(t, entry.keychainEnv);
  assert.equal(read.DEMO_TOKEN, SENTINEL);
  assert.match(read.DEMO_KEY, /^[A-Za-z0-9_-]{43}$/);
  // The bundle's own .env still carries the value: that is where the container reads it.
  assert.ok(dotEnvOf(t.home).includes(SENTINEL));
  assert.equal(job.log.join("\n").includes(SENTINEL), false, "the job log never carries a value");
});

// ─── 2. PUT env: seal a new value, and clearing it keeps the row ────────────

test("PUT env (sealing on): a new typed value is sealed (row updated); null un-lists the name and KEEPS its row", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  await withSealing(true, () => installDemand(t));

  const p = await withSealing(true, () => call(t, "PUT", "bundles/demo/env", { env: { DEMO_TOKEN: SENTINEL2 } }));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  let entry = addonsOf(t.home).demo;
  assert.deepEqual(entry.keychainEnv, ["DEMO_KEY", "DEMO_TOKEN"]);
  assert.equal(entry.env.DEMO_TOKEN, undefined, "the new value is not written plain");
  assert.equal(unseal(t, ["DEMO_TOKEN"]).DEMO_TOKEN, SENTINEL2, "the row holds the value just typed");
  assert.ok(dotEnvOf(t.home).includes(SENTINEL2), "the .env gets it too (the container reads that file)");
  assert.equal(readFileSync(join(t.home, "mcp-addons.json"), "utf8").includes(SENTINEL2), false);

  const cleared = await withSealing(true, () => call(t, "PUT", "bundles/demo/env", { env: { DEMO_TOKEN: null } }));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  entry = addonsOf(t.home).demo;
  assert.deepEqual(entry.keychainEnv, ["DEMO_KEY"], "a cleared field stops being listed");
  assert.equal(dotEnvOf(t.home).includes(SENTINEL2), false, "the .env no longer has it");
  const row = rowsOf(t).find((r) => r.env_key === "DEMO_TOKEN");
  assert.equal(row.status, "active", "the keychain row is KEPT (the owner's key, in Settings)");
  assert.equal(unseal(t, ["DEMO_TOKEN"]).DEMO_TOKEN, SENTINEL2);
});

// ─── 3. two concurrent PUTs: one write section at a time ────────────────────

test("two concurrent PUTs of one bundle: the .env, the entry and the row agree on the last value", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  await withSealing(true, () => installDemand(t));
  // A second manager over the same $SAT_HOME / satellite.db: the per-id write lock is what
  // serializes the two saves (0.6.3), so the second call's values are the ones left behind.
  const m = createBundleManager({ db: t.a.db, satHome: t.home });
  await withSealing(true, async () => {
    const [first, second] = await Promise.all([
      m.putEnv("demo", { env: { DEMO_TOKEN: SENTINEL2 } }),
      m.putEnv("demo", { env: { DEMO_TOKEN: SENTINEL3 } }),
    ]);
    assert.equal(first.ok && second.ok, true);
  });
  const entry = addonsOf(t.home).demo;
  assert.deepEqual(entry.keychainEnv, ["DEMO_KEY", "DEMO_TOKEN"]);
  assert.equal(entry.env.DEMO_TOKEN, undefined);
  const envText = dotEnvOf(t.home);
  assert.ok(!envText.includes(SENTINEL2), "the first save's value was replaced, not interleaved");
  assert.ok(envText.includes(`DEMO_TOKEN=${SENTINEL3}`), "the last save's value is the one in the .env");
  assert.equal(unseal(t, ["DEMO_TOKEN"]).DEMO_TOKEN, SENTINEL3, "and the one in the keychain");
});

// ─── 4. the spawn reader ────────────────────────────────────────────────────

test("spawn: the child's env carries the unsealed value; a listed key that cannot be read yields START_FAILED_TEXT", async (t) => {
  const out = captureOutput(t);
  const live = await boot({ setup: (h) => appBundle(h, "demo", { server: fakeMcpServer() }) });
  const job = await withSealing(true, () => installDemand(live));
  assert.equal(job.status, "complete", job.log.join("\n"));
  await waitFor(() => live.a.mcpHost.pids("demo").length === 0, "the tool-cache child to stop");

  const r = await callTool(live, "demo_echo", { env: ["DEMO_TOKEN", "DEMO_KEY"] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const seen = JSON.parse(textOf(r)).env;
  assert.equal(seen.DEMO_TOKEN, SENTINEL, "the child was started with the unsealed key");
  assert.match(seen.DEMO_KEY, /^[A-Za-z0-9_-]{43}$/);

  // The row goes away (an uninstall, a restored DB, a row sealed under another key): the child
  // must not start with half its env.
  await live.a.mcpHost.stopChildren();
  live.a.db.prepare("UPDATE crow_keychain SET status = 'extension_removed' WHERE bundle_id = 'demo' AND env_key = 'DEMO_TOKEN'").run();
  const refused = await callTool(live, "demo_echo", {});
  assert.equal(refused.status, 200);
  assert.equal(refused.json.result.isError, true);
  assert.equal(textOf(refused), START_FAILED_TEXT);
  assert.deepEqual(live.a.mcpHost.pids("demo"), [], "no child was started");
  // The console says what happened — the id, the code and the NAMES, never a value.
  const said = out.text();
  assert.ok(said.includes(ADDON_KEYS_UNREADABLE), "the fixed sentence reaches the log");
  assert.ok(said.includes("DEMO_TOKEN"), "the key names reach the log");
  assert.equal(said.includes(SENTINEL), false, "the value never does");
  assert.equal(job.log.join("\n").includes(SENTINEL), false);

  // With the row back, the next call starts a child again (the failure was not sticky).
  live.a.db.prepare("UPDATE crow_keychain SET status = 'active' WHERE bundle_id = 'demo' AND env_key = 'DEMO_TOKEN'").run();
  const again = await callTool(live, "demo_echo", { env: ["DEMO_TOKEN"] });
  assert.equal(JSON.parse(textOf(again)).env.DEMO_TOKEN, SENTINEL);
});

// ─── 5. the opt-out: a listed name written plain is un-listed (0.3 row 4) ──

test("PUT env (sealing off): a listed name written plain is un-listed so the new value wins; its row is kept", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  await withSealing(true, () => installDemand(t));
  assert.deepEqual(addonsOf(t.home).demo.keychainEnv, ["DEMO_KEY", "DEMO_TOKEN"]);

  const p = await withSealing(false, () => call(t, "PUT", "bundles/demo/env", { env: { DEMO_TOKEN: SENTINEL2 } }));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const entry = addonsOf(t.home).demo;
  assert.deepEqual(entry.keychainEnv, ["DEMO_KEY"], "the name just written plain is no longer listed");
  assert.equal(entry.env.DEMO_TOKEN, SENTINEL2, "and the plain value is the one the child will use");
  const row = rowsOf(t).find((r) => r.env_key === "DEMO_TOKEN");
  assert.equal(row.status, "active", "the owner's saved key is kept");
  assert.equal(unseal(t, ["DEMO_TOKEN"]).DEMO_TOKEN, SENTINEL, "the row still holds the earlier value");
  assert.ok(dotEnvOf(t.home).includes(SENTINEL2));
});

// ─── 6. the sentinel scan ───────────────────────────────────────────────────

test("no sentinel reaches the console, the job log, the satellite's audit rows or a keychain row in the clear", async (t) => {
  const out = captureOutput(t);
  const live = await boot({ setup: (h) => appBundle(h, "demo", { server: fakeMcpServer() }) });
  const job = await withSealing(true, () => installDemand(live));
  await withSealing(true, () => call(live, "PUT", "bundles/demo/env", { env: { DEMO_TOKEN: SENTINEL2 } }));
  await callTool(live, "demo_echo", { env: ["DEMO_TOKEN"] });

  assert.equal(job.log.join("\n").includes(SENTINEL), false);
  assert.equal(job.log.join("\n").includes(SENTINEL2), false);
  assert.equal(out.text().includes(SENTINEL) || out.text().includes(SENTINEL2), false, "no console line carries a value");
  const stored = JSON.stringify(live.a.db.prepare("SELECT log_json FROM jobs").all());
  assert.equal(stored.includes(SENTINEL) || stored.includes(SENTINEL2), false, "the persisted job log carries no value");
  assert.equal(JSON.stringify(live.a.db.prepare("SELECT * FROM audit").all()).includes(SENTINEL), false);
  assert.equal(JSON.stringify(rowsOf(live)).includes(SENTINEL), false, "the keychain rows are sealed");
  assert.deepEqual(scanDb(join(live.home, "satellite.db"), SENTINEL), [], "no scanned table (audit log, bell) holds a value");
});