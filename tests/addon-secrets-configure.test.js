/**
 * Task 1.5a — the Configure save (POST /bundles/api/env) and applyEnvToMcpAddons:
 * the seal, the per-add-on lock, the reordering, the opt-out and the previous_key slot.
 *
 * What this file pins down:
 *   1. with sealing ON, a save seals the secret (`keychainEnv` + a keychain row, no plain
 *      value in mcp-addons.json) and keeps the URL plain;
 *   2. a seal failure leaves mcp-addons.json AND the .env byte-identical;
 *   3. two concurrent saves of ONE add-on agree across the .env, the keychain row and the
 *      entry; concurrent saves of TWO add-ons both survive;
 *   4. with sealing OFF (PR1's default) the output is today's plain one — and a failed
 *      entry write now stops the .env write (the deliberate reorder);
 *   5. the opt-out after sealing (flag 0) writes the value plain and un-lists the name;
 *   6. a tax-shaped previous_key slot is filled from the OLD KEYCHAIN value;
 *   7. the sentinel never reaches the console, an audit row, a notification or the file.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR before anything Crow-side is imported; every secret is
 * a sentinel.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-addon-cfg-home-"));
const DATA = join(HOME, "data");
mkdirSync(DATA, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_APP_ENV_PATH = join(HOME, "gateway.env");
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
// PR1 ships sealing OFF: nothing turns it on but the operator's flag. Each test sets it.
delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const B = await import("../servers/gateway/routes/bundles.js");
const { hydrateAddonEntry, readAddonSecretsSync } = await import("../servers/shared/addon-secrets.js");
const { gatewayKeychainPaths } = await import("../servers/gateway/addon-keys-paths.js");
const { keychainKeyPath } = await import("../servers/gateway/keychain/key.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { captureOutput, scanDb } = await import("./helpers/sentinel-scan.mjs");

B._setAppEnvPathForTest(process.env.CROW_APP_ENV_PATH);

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const SENTINEL3 = "sentinel-" + randomUUID();
/** Root ignores the mode bits, so a test that needs an unwritable directory is skipped there. */
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const MCP_ADDONS = join(HOME, "mcp-addons.json");
const INSTALLED = join(HOME, "installed.json");
const KEY_PATH = keychainKeyPath(HOME);

after(() => {
  B._setOwnerCheckForTest(null);
  B._setAppEnvPathForTest(null);
  delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Run one section with the sealing switch at `on`; restores it afterwards. */
async function withSealing(on, fn) {
  const before = process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  if (on) process.env.CROW_ADDON_SECRETS_KEYCHAIN = "1";
  else delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
    else process.env.CROW_ADDON_SECRETS_KEYCHAIN = before;
  }
}

const HA_MANIFEST = (id) => ({
  id,
  name: "Home Assistant",
  description: "d",
  type: "mcp-server",
  category: "automation",
  version: "1.0.0",
  server: { command: "node", args: ["server/index.js"], envKeys: ["HA_URL", "HA_TOKEN"] },
  env_vars: [
    { name: "HA_URL", default: "http://localhost:8123" },
    { name: "HA_TOKEN", secret: true },
  ],
});

/** An mcp-server add-on: installed manifest, an .env, an mcp-addons entry, an install row. */
function seedBundle(id, manifest, { dotEnv = "", entry = null } = {}) {
  const dir = join(HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (dotEnv !== null) writeFileSync(join(dir, ".env"), dotEnv, { mode: 0o600 });
  const all = existsSync(MCP_ADDONS) ? JSON.parse(readFileSync(MCP_ADDONS, "utf8")) : {};
  all[id] = entry || { command: "node", args: ["server/index.js"], env: {} };
  writeFileSync(MCP_ADDONS, JSON.stringify(all, null, 2), { mode: 0o600 });
  const installed = existsSync(INSTALLED) ? JSON.parse(readFileSync(INSTALLED, "utf8")) : [];
  writeFileSync(INSTALLED, JSON.stringify([...installed.filter((i) => i.id !== id), { id, type: "mcp-server", version: "1.0.0", installedAt: "2026-11-01T10:00:00.000Z" }]));
  return dir;
}

const readEntry = (id) => JSON.parse(readFileSync(MCP_ADDONS, "utf8"))[id] || {};
const readEnv = (dir) => (existsSync(join(dir, ".env")) ? parseEnvText(readFileSync(join(dir, ".env"), "utf8")) : {});

/** The spawn-time view of an entry — the same unseal a child start takes. */
const spawnEnv = (id) => hydrateAddonEntry(id, readEntry(id), { unsealer: "gateway", ...gatewayKeychainPaths() })?.env || {};

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  B._setOwnerCheckForTest(() => true); // the local owner: provenance, nothing else here
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/bundles/api/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    return await fn(post);
  } finally {
    server.close();
    B._setOwnerCheckForTest(null);
  }
}

const save = (post, id, env) => post({ bundle_id: id, env_vars: env });

// ─── 1. sealing ON ──────────────────────────────────────────────────────────

test("sealing on: the secret is sealed (row + keychainEnv, no value in the file) and the URL stays plain", async (t) => {
  const dir = seedBundle("cfg-seal", HA_MANIFEST("cfg-seal"), { dotEnv: "HA_URL=http://localhost:8123\nHA_TOKEN=\n" });
  const out = captureOutput(t);
  await withSealing(true, () => withServer(async (post) => {
    const r = await save(post, "cfg-seal", { HA_URL: "http://ha.local:8123", HA_TOKEN: SENTINEL });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(JSON.stringify(r.body).includes(SENTINEL), false, "an answer never carries a value");
  }));

  const entry = readEntry("cfg-seal");
  assert.deepEqual(entry.env, { HA_URL: "http://ha.local:8123" }, "the URL stays plain; the token left the env");
  assert.deepEqual(entry.keychainEnv, ["HA_TOKEN"], "the entry keeps the NAME of the secret");
  assert.equal(readFileSync(MCP_ADDONS, "utf8").includes(SENTINEL), false, "no plain secret in mcp-addons.json");
  assert.deepEqual(
    readAddonSecretsSync("cfg-seal", ["HA_TOKEN"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
    { HA_TOKEN: SENTINEL },
    "the keychain row holds the value the spawn would take",
  );
  // The .env is the bundle's own file (PR3 strips only the entry), so it holds the value.
  assert.equal(readEnv(dir).HA_TOKEN, SENTINEL);
  assert.equal(spawnEnv("cfg-seal").HA_TOKEN, SENTINEL, "the child's env gets the unsealed value");
  assert.equal(out.text().includes(SENTINEL), false, "no console line carries a value");
  assert.deepEqual(scanDb(gatewayKeychainPaths().dbPath, SENTINEL), [], "no audit row or bell carries a value");
});

// ─── 2. a seal failure writes nothing ───────────────────────────────────────

test("a seal failure leaves mcp-addons.json and the .env BYTE-IDENTICAL", async () => {
  const dir = seedBundle("cfg-fail", HA_MANIFEST("cfg-fail"), { dotEnv: "HA_URL=http://localhost:8123\nHA_TOKEN=\n" });
  await withSealing(true, async () => {
    // A first save puts a row in the keychain, so a damaged key file must be refused.
    await withServer(async (post) => {
      const ok = await save(post, "cfg-fail", { HA_TOKEN: SENTINEL });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });
    const envBefore = readFileSync(join(dir, ".env"), "utf8");
    const fileBefore = readFileSync(MCP_ADDONS, "utf8");
    const keyBefore = readFileSync(KEY_PATH, "utf8");
    writeFileSync(KEY_PATH, ""); // damaged, while rows depend on it
    try {
      await withServer(async (post) => {
        const r = await save(post, "cfg-fail", { HA_URL: "http://other.local:8123", HA_TOKEN: SENTINEL2 });
        assert.equal(r.status, 500);
        assert.equal(r.body.error, B.ADDON_KEYS_SAVE_FAILED);
        // Truthful after a read-back proof failure: this save's rows may already be written, so
        // the sentence says the key is unconfirmed instead of claiming nothing was saved.
        assert.match(r.body.error, /could not confirm the new key was saved correctly\. Open Configure and save it again\./);
        assert.equal(/nothing was saved/.test(r.body.error), false);
        assert.equal(JSON.stringify(r.body).includes(SENTINEL2), false);
      });
    } finally {
      writeFileSync(KEY_PATH, keyBefore);
    }
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), envBefore, "the .env was not touched");
    assert.equal(readFileSync(MCP_ADDONS, "utf8"), fileBefore, "the entry was not touched");
    assert.deepEqual(
      readAddonSecretsSync("cfg-fail", ["HA_TOKEN"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
      { HA_TOKEN: SENTINEL },
      "the stored value is still the first one",
    );
  });
});

// ─── 3. concurrency (the per-add-on lock) ───────────────────────────────────

test("two concurrent saves of ONE add-on: the .env, the keychain row and the entry agree", async () => {
  const dir = seedBundle("cfg-race", HA_MANIFEST("cfg-race"), { dotEnv: "HA_TOKEN=\n" });
  await withSealing(true, () => withServer(async (post) => {
    const [a, b] = await Promise.all([
      save(post, "cfg-race", { HA_URL: "http://a.local:8123", HA_TOKEN: SENTINEL }),
      save(post, "cfg-race", { HA_URL: "http://b.local:8123", HA_TOKEN: SENTINEL2 }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
  }));
  const row = readAddonSecretsSync("cfg-race", ["HA_TOKEN"], { unsealer: "gateway", ...gatewayKeychainPaths() }).HA_TOKEN;
  assert.ok([SENTINEL, SENTINEL2].includes(row), "one of the two saves won");
  assert.equal(readEnv(dir).HA_TOKEN, row, "the .env holds the same value as the keychain");
  assert.equal(spawnEnv("cfg-race").HA_TOKEN, row, "and so does the spawn env");
  assert.deepEqual(readEntry("cfg-race").keychainEnv, ["HA_TOKEN"]);
  // The URL and the secret came from the SAME save: no half-applied pair.
  const url = readEntry("cfg-race").env.HA_URL;
  assert.equal(url, row === SENTINEL ? "http://a.local:8123" : "http://b.local:8123");
  assert.equal(readEnv(dir).HA_URL, url, "the entry and the .env agree on which save won");
});

test("concurrent saves of TWO add-ons both survive (the file write replaces only its entry)", async () => {
  seedBundle("cfg-race-a", HA_MANIFEST("cfg-race-a"), { dotEnv: "HA_TOKEN=\n" });
  seedBundle("cfg-race-b", HA_MANIFEST("cfg-race-b"), { dotEnv: "HA_TOKEN=\n" });
  await withSealing(true, () => withServer(async (post) => {
    const [a, b] = await Promise.all([
      save(post, "cfg-race-a", { HA_TOKEN: SENTINEL }),
      save(post, "cfg-race-b", { HA_TOKEN: SENTINEL2 }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
  }));
  assert.deepEqual(readEntry("cfg-race-a").keychainEnv, ["HA_TOKEN"]);
  assert.deepEqual(readEntry("cfg-race-b").keychainEnv, ["HA_TOKEN"]);
  assert.equal(spawnEnv("cfg-race-a").HA_TOKEN, SENTINEL);
  assert.equal(spawnEnv("cfg-race-b").HA_TOKEN, SENTINEL2);
});

// Review round 2, item 2: a .env write that fails AFTER a successful seal is the accepted
// outcome — keychain + entry keep the new value, the .env keeps the old one, and the answer
// is the existing env_write sentence (the next save rewrites the .env).
test("a .env write failure after the seal answers env_write, with the key already sealed", { skip: IS_ROOT ? "root can write a read-only directory" : false }, async () => {
  const bundleDir = seedBundle("cfg-envwrite", HA_MANIFEST("cfg-envwrite"), { dotEnv: "HA_TOKEN=\n" });
  const envBefore = readFileSync(join(bundleDir, ".env"), "utf8");
  await withSealing(true, async () => {
    chmodSync(bundleDir, 0o555); // the .env's atomic write needs a temp file in this dir
    try {
      await withServer(async (post) => {
        const r = await save(post, "cfg-envwrite", { HA_TOKEN: SENTINEL });
        assert.equal(r.status, 500, JSON.stringify(r.body));
        assert.equal(r.body.code, "env_write");
        assert.match(r.body.error, /saved the key but could not write the extension's settings file/);
        assert.equal(JSON.stringify(r.body).includes(SENTINEL), false);
      });
    } finally {
      chmodSync(bundleDir, 0o755);
    }
  });
  assert.equal(readFileSync(join(bundleDir, ".env"), "utf8"), envBefore, "the .env still holds what it held");
  const entryText = JSON.stringify(readEntry("cfg-envwrite"));
  assert.deepEqual(readEntry("cfg-envwrite").keychainEnv, ["HA_TOKEN"], "the entry holds the name");
  assert.equal(entryText.includes(SENTINEL), false, "and never the plain value");
  assert.deepEqual(
    readAddonSecretsSync("cfg-envwrite", ["HA_TOKEN"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
    { HA_TOKEN: SENTINEL },
    "the keychain took the key, so it is not lost",
  );
});

// ─── 4. sealing OFF (PR1's default) ─────────────────────────────────────────

test("sealing off (the flag unset): today's plain output, and no keychain row is made", async () => {
  const dir = seedBundle("cfg-plain", HA_MANIFEST("cfg-plain"), { dotEnv: "HA_TOKEN=\n" });
  await withSealing(false, () => withServer(async (post) => {
    const r = await save(post, "cfg-plain", { HA_URL: "http://ha.local:8123", HA_TOKEN: SENTINEL });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }));
  const entry = readEntry("cfg-plain");
  assert.equal(entry.env.HA_TOKEN, SENTINEL, "plain, as before");
  assert.equal("keychainEnv" in entry, false);
  assert.equal(readEnv(dir).HA_TOKEN, SENTINEL);
  assert.throws(
    () => readAddonSecretsSync("cfg-plain", ["HA_TOKEN"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
    (err) => err.code === "ROWS_MISSING",
    "no keychain row was written with sealing off",
  );
});

// The reorder (1.5a) is NOT inert with the flag off: the MCP entry is written before the
// .env, so a failed entry write now fails the whole save instead of leaving a stale entry
// beside a fresh .env. Deliberate: one consistent state beats two half-applied files.
// A read-only CROW_HOME is how the failure is produced; root ignores the mode bits.
test("reorder: a failed MCP entry write stops the .env write too", { skip: IS_ROOT ? "root can write a read-only directory" : false }, async () => {
  const dir = seedBundle("cfg-reorder", HA_MANIFEST("cfg-reorder"), { dotEnv: "HA_TOKEN=\n" });
  const envBefore = readFileSync(join(dir, ".env"), "utf8");
  await withSealing(false, async () => {
    chmodSync(HOME, 0o555); // mcp-addons.json lives here: its write fails, the .env's does not
    try {
      await withServer(async (post) => {
        const r = await save(post, "cfg-reorder", { HA_URL: "http://ha.local:8123", HA_TOKEN: SENTINEL });
        assert.equal(r.status, 500, JSON.stringify(r.body));
        assert.match(r.body.error, /Failed to save environment/);
        assert.equal(JSON.stringify(r.body).includes(SENTINEL), false);
      });
    } finally {
      chmodSync(HOME, 0o755);
    }
  });
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), envBefore, "the .env was not written after the entry write failed");
});

// ─── 5. the opt-out after sealing (0.3 row 4) ───────────────────────────────

test("opt-out after sealing: flag 0 writes the new value plain, un-lists it, and keeps the row", async () => {
  const dir = seedBundle("cfg-optout", HA_MANIFEST("cfg-optout"), { dotEnv: "HA_TOKEN=\n" });
  await withSealing(true, () => withServer(async (post) => {
    const sealed = await save(post, "cfg-optout", { HA_TOKEN: SENTINEL });
    assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
  }));
  assert.deepEqual(readEntry("cfg-optout").keychainEnv, ["HA_TOKEN"]);

  await withSealing(false, () => withServer(async (post) => {
    const plain = await save(post, "cfg-optout", { HA_TOKEN: SENTINEL2 });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
  }));

  const entry = readEntry("cfg-optout");
  assert.equal("keychainEnv" in entry, false, "the name is un-listed, so the plain value is the one used");
  assert.equal(entry.env.HA_TOKEN, SENTINEL2);
  assert.equal(spawnEnv("cfg-optout").HA_TOKEN, SENTINEL2, "the spawn env carries the value just typed");
  assert.equal(readEnv(dir).HA_TOKEN, SENTINEL2);
  assert.deepEqual(
    readAddonSecretsSync("cfg-optout", ["HA_TOKEN"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
    { HA_TOKEN: SENTINEL },
    "the owner's keychain entry is kept (Settings → Passwords)",
  );
});

// ─── 6. previous_key after sealing (tax) ────────────────────────────────────

const TAX_MANIFEST = (id) => ({
  id,
  name: "Tax",
  description: "d",
  type: "mcp-server",
  category: "finance",
  version: "1.0.0",
  server: { command: "node", args: ["server/index.js"], envKeys: ["TAX_KEY", "TAX_KEY_PREV"] },
  env_vars: [
    { name: "TAX_KEY", secret: true, previous_key: "TAX_KEY_PREV" },
    { name: "TAX_KEY_PREV", secret: true },
  ],
});

test("previous_key rotation after sealing fills the slot from the OLD KEYCHAIN value", async () => {
  const dir = seedBundle("cfg-tax", TAX_MANIFEST("cfg-tax"), { dotEnv: "TAX_KEY=\n" });
  await withSealing(true, async () => {
    await withServer(async (post) => {
      const first = await save(post, "cfg-tax", { TAX_KEY: SENTINEL });
      assert.equal(first.status, 200, JSON.stringify(first.body));
    });
    assert.deepEqual(readEntry("cfg-tax").keychainEnv, ["TAX_KEY"]);
    // The .env loses the old key: the ONLY remaining copy is the keychain.
    writeFileSync(join(dir, ".env"), "OTHER=1\n", { mode: 0o600 });
    await withServer(async (post) => {
      const rotated = await save(post, "cfg-tax", { TAX_KEY: SENTINEL2 });
      assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    });
  });
  assert.deepEqual(
    readAddonSecretsSync("cfg-tax", ["TAX_KEY", "TAX_KEY_PREV"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
    { TAX_KEY: SENTINEL2, TAX_KEY_PREV: SENTINEL },
    "the slot holds the key the child was running on; the new key is the current one",
  );
  assert.deepEqual(readEntry("cfg-tax").keychainEnv, ["TAX_KEY", "TAX_KEY_PREV"]);
  const dot = readEnv(dir);
  assert.equal(dot.TAX_KEY, SENTINEL2);
  assert.equal(dot.TAX_KEY_PREV, SENTINEL);
});

test("previous_key: an unreadable current key is reported by NAME, and the slot is simply not filled", async () => {
  seedBundle("cfg-tax-unreadable", TAX_MANIFEST("cfg-tax-unreadable"), {
    dotEnv: "OTHER=1\n",
    // A listed name with no active row: the spawn-time read fails closed.
    entry: { command: "node", args: ["server/index.js"], env: {}, keychainEnv: ["GHOST_KEY"] },
  });
  await withSealing(true, () => withServer(async (post) => {
    const r = await save(post, "cfg-tax-unreadable", { TAX_KEY: SENTINEL });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(JSON.stringify(r.body).includes(SENTINEL), false, "the warning names the key, never a value");
    const warnings = r.body.warnings || [];
    assert.ok(
      warnings.some((w) => w.includes("TAX_KEY's current key could not be read, so it was not kept in TAX_KEY_PREV.")),
      JSON.stringify(warnings),
    );
  }));
  const entry = readEntry("cfg-tax-unreadable");
  assert.equal(entry.env?.TAX_KEY_PREV, undefined, "no slot was filled");
  assert.equal(readEnv(join(HOME, "bundles", "cfg-tax-unreadable")).TAX_KEY_PREV, undefined);
  assert.deepEqual(
    readAddonSecretsSync("cfg-tax-unreadable", ["TAX_KEY"], { unsealer: "gateway", ...gatewayKeychainPaths() }),
    { TAX_KEY: SENTINEL },
    "the new key was sealed anyway",
  );
});

// ─── 7. the sentinel scan over every path above ─────────────────────────────

test("no Configure save leaks the sentinel: console, audit rows, notifications, the file", async (t) => {
  const out = captureOutput(t);
  const dir = seedBundle("cfg-scan", HA_MANIFEST("cfg-scan"), { dotEnv: "HA_TOKEN=\n" });
  await withSealing(true, () => withServer(async (post) => {
    assert.equal((await save(post, "cfg-scan", { HA_TOKEN: SENTINEL })).status, 200);
    // A seal refusal (damaged key file, rows exist).
    const keyBefore = readFileSync(KEY_PATH, "utf8");
    writeFileSync(KEY_PATH, "");
    try {
      const r = await save(post, "cfg-scan", { HA_TOKEN: SENTINEL3 });
      assert.equal(r.status, 500);
    } finally {
      writeFileSync(KEY_PATH, keyBefore);
    }
    // The opt-out path, writing a plain value.
    process.env.CROW_ADDON_SECRETS_KEYCHAIN = "0";
    assert.equal((await save(post, "cfg-scan", { HA_TOKEN: SENTINEL2 })).status, 200);
    process.env.CROW_ADDON_SECRETS_KEYCHAIN = "1";
  }));

  const text = out.text();
  // The whole document holds the other tests' entries too (some written plain on purpose),
  // so the file assertions are scoped to THIS add-on's entry.
  const entryText = JSON.stringify(readEntry("cfg-scan"));
  const dotEnv = readFileSync(join(dir, ".env"), "utf8");
  for (const sentinel of [SENTINEL, SENTINEL2, SENTINEL3]) {
    assert.equal(text.split(sentinel).length - 1, 0, "no console line carries a value");
    assert.deepEqual(scanDb(gatewayKeychainPaths().dbPath, sentinel), [], "no audit row or bell carries a value");
  }
  // The opt-out wrote SENTINEL2 plainly — deliberate, and the file is private (0600).
  assert.equal(entryText.includes(SENTINEL2), true);
  assert.equal(entryText.includes(SENTINEL), false, "the sealed value is not in the file");
  assert.equal(dotEnv.includes(SENTINEL2), true, "the bundle's own .env is where the value goes");
});