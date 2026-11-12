/**
 * Task 1.8a — the other gateway READERS understand `keychainEnv`:
 *   - bundles-config's needs-config/configured-field predicates count a listed name as set
 *     WITHOUT unsealing (Extensions renders on every request);
 *   - the audio proxy and the pinned upstream hydrate the funkwhale entry when the process
 *     registered an unsealer, and keep today's plain-env answer in a process that did not;
 *   - cred-ref keeps reading a token FILE from the entry's plain env (a path is never sealed);
 *   - a project connection's child env never gains an add-on entry value.
 * Scratch CROW_HOME / CROW_DATA_DIR / keychain; every secret is a sentinel.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey, keychainKeyPath } from "../servers/gateway/keychain/key.js";
import { saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-readers-"));
const HOME = join(SCRATCH, "home");
const DATA = join(SCRATCH, "data");
mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_ADDON_HOST;
delete process.env.FUNKWHALE_URL;
delete process.env.FUNKWHALE_ACCESS_TOKEN;

const DB_PATH = join(DATA, "crow.db");
const raw = new Database(DB_PATH);
raw.exec(KEYCHAIN_DDL);
raw.exec(SCAN_TABLE_DDL);
const KEY = createKeychainKey({ crowHome: HOME });
const ADDONS = join(HOME, "mcp-addons.json");

/** better-sqlite3 behind the small async libsql surface the keychain store uses. */
const db = {
  async execute(q) {
    const { sql, args = [] } = typeof q === "string" ? { sql: q } : q;
    const st = raw.prepare(sql);
    if (st.reader) return { rows: st.all(...args) };
    const r = st.run(...args);
    return { rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: r.changes };
  },
  async executeMultiple(sql) { raw.exec(sql); },
};

await saveExtensionSecret(db, KEY, { bundleId: "funkwhale", envKey: "FUNKWHALE_ACCESS_TOKEN", label: "Funkwhale token", secret: SENTINEL, origin: "typed" });
await saveExtensionSecret(db, KEY, { bundleId: "home-assistant", envKey: "HA_TOKEN", label: "HA token", secret: SENTINEL2, origin: "typed" });

const FUNKWHALE = { command: "node", args: ["x.js"], env: { FUNKWHALE_URL: "http://funkwhale.local" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"] };
function writeAddons(addons) { writeFileSync(ADDONS, JSON.stringify(addons), { mode: 0o600 }); }
writeAddons({ funkwhale: FUNKWHALE, "home-assistant": { command: "node", args: ["x.js"], env: { HA_URL: "http://ha.example" }, keychainEnv: ["HA_TOKEN"] } });

// This process runs as the gateway (0.5: the caller opts in).
const { registerAddonUnsealer, sealableEnv } = await import("../servers/shared/addon-secrets.js");
registerAddonUnsealer("gateway");
const { needsConfigKeys, configuredAccountFields, resolveEffectiveEnv } = await import("../servers/gateway/bundles-config.js");
const { readFunkwhaleEnv } = await import("../servers/gateway/routes/audio-proxy.js");
const { musicUpstreamConfig } = await import("../servers/gateway/media/pinned-upstream.js");
const { resolveTokenFile } = await import("../servers/gateway/staged/cred-ref.js");
const { connectionChildEnv } = await import("../servers/gateway/services/children.js");
const { keychainEnvNames } = await import("../servers/shared/addon-secrets.js");

after(() => {
  try { raw.close(); } catch { /* already closed */ }
});

// ---- predicates: a listed name is configured, values never read -------------

test("needs-config: a required key listed in keychainEnv is not missing; without the list it is", (t) => {
  const out = captureOutput(t);
  const { keychainSet } = resolveEffectiveEnv("home-assistant", null);
  assert.deepEqual([...keychainSet], ["HA_TOKEN"], "the NAMES only");
  assert.deepEqual(needsConfigKeys("home-assistant"), [], "a sealed required key is configured");
  writeAddons({ "home-assistant": { command: "node", args: ["x.js"], env: { HA_URL: "http://ha.example" } } });
  try {
    assert.deepEqual(needsConfigKeys("home-assistant"), ["HA_TOKEN"], "unsealed and unset: reported, as before");
    assert.deepEqual(configuredAccountFields("home-assistant"), ["HA_URL"], "only the plain field");
  } finally {
    writeAddons({ funkwhale: FUNKWHALE, "home-assistant": { command: "node", args: ["x.js"], env: { HA_URL: "http://ha.example" }, keychainEnv: ["HA_TOKEN"] } });
  }
  assert.deepEqual(configuredAccountFields("home-assistant"), ["HA_URL", "HA_TOKEN"], "both count once listed");
  assert.equal(out.text().split(SENTINEL).length - 1, 0, "no value reaches a render-path reader");
  assert.equal(out.text().split(SENTINEL2).length - 1, 0);
});

// ---- the funkwhale readers -------------------------------------------------

test("audio proxy and musicUpstreamConfig unseal the token when this process registered a role", () => {
  const fw = readFunkwhaleEnv(HOME);
  assert.deepEqual(fw, { url: "http://funkwhale.local", token: SENTINEL });
  const cfg = musicUpstreamConfig({ crowHome: HOME, env: {} });
  assert.equal(cfg.token, SENTINEL);
  assert.equal(cfg.origin, "http://funkwhale.local");
});

test("in a process that did not register (an add-on child), the readers keep the plain/env answer and never open crow.db", () => {
  const never = join(SCRATCH, "never-opened.db");
  const url = new URL("../servers/gateway/media/pinned-upstream.js", import.meta.url).href;
  const audioUrl = new URL("../servers/gateway/routes/audio-proxy.js", import.meta.url).href;
  const script = `
    const pinned = await import(${JSON.stringify(url)});
    const audio = await import(${JSON.stringify(audioUrl)});
    const cfg = pinned.musicUpstreamConfig({ crowHome: process.env.CROW_HOME, env: { FUNKWHALE_URL: "http://fw.local", FUNKWHALE_ACCESS_TOKEN: "env-token" } });
    if (!cfg || cfg.token !== "env-token") throw new Error("no env fallback: " + JSON.stringify(cfg));
    const direct = audio.readFunkwhaleEnv(process.env.CROW_HOME);
    if (direct !== null) throw new Error("expected the plain entry alone (no token): " + JSON.stringify(direct));
    console.log("ok");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      PATH: process.env.PATH,
      CROW_HOME: HOME,
      HOME,
      CROW_DATA_DIR: DATA,
      // A database that does not exist: a reader that tried to unseal would throw here.
      CROW_DB_PATH: never,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /ok/);
  assert.equal(existsSync(never), false, "nothing opened (or created) the database");
  assert.equal(r.stdout.includes(SENTINEL), false, "and no value was printed");
});

// ---- a token FILE is a path: never sealed, still resolved ------------------

test("a google-workspace-shaped entry keeps GOOGLE_TOKEN_FILE plain and cred-ref still resolves it", () => {
  const tokenFile = join(HOME, "gmail-token.json");
  writeFileSync(tokenFile, "{}");
  // The classifier keeps a location/URL suffix plain (0.2 rule 4), so sealing moves only the
  // credential names and the entry still carries the path.
  const split = sealableEnv({ GOOGLE_CLIENT_ID: SENTINEL, GOOGLE_CLIENT_SECRET: SENTINEL2, GOOGLE_TOKEN_FILE: tokenFile },
    { env_vars: [{ name: "GOOGLE_CLIENT_ID", secret: true }, { name: "GOOGLE_CLIENT_SECRET", secret: true }, { name: "GOOGLE_TOKEN_FILE" }] });
  assert.deepEqual(Object.keys(split.seal).sort(), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  assert.deepEqual(split.keep, { GOOGLE_TOKEN_FILE: tokenFile }, "a path is never sealed");

  const entry = { command: "uvx", args: ["workspace-mcp"], env: { ...split.keep }, keychainEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] };
  assert.deepEqual(keychainEnvNames(entry), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  writeAddons({ "google-workspace": entry });
  try {
    assert.equal(resolveTokenFile({ server: "google-workspace", role: "primary", source: "addons" }, { addons: ADDONS }), tokenFile);
  } finally {
    writeAddons({ funkwhale: FUNKWHALE });
  }
});

// ---- a project connection's child env never gains an entry value -----------

test("a sealed add-on entry yields the same connectionChildEnv as a plain one (the entry is ignored)", () => {
  const service = { fields: [{ name: "API_KEY" }], derivedEnv: { AUTH: { template: "Bearer ${API_KEY}" } } };
  const config = { API_KEY: "conn-" + randomUUID() };
  const sealed = { command: "node", env: {}, keychainEnv: ["CROW_ADDON_ONLY"] };
  const plain = { command: "node", env: { CROW_ADDON_ONLY: SENTINEL } };
  const a = connectionChildEnv({ addonEntry: sealed, service, config, base: {}, crowHome: HOME });
  const b = connectionChildEnv({ addonEntry: plain, service, config, base: {}, crowHome: HOME });
  assert.deepEqual(a, b, "the entry (sealed or not) never reaches a project child");
  assert.equal("CROW_ADDON_ONLY" in a, false);
  assert.equal(a.API_KEY, config.API_KEY);
  assert.equal(a.AUTH, `Bearer ${config.API_KEY}`);
});

// ---- the sentinel scan -----------------------------------------------------

test("no reader leaks a sentinel to the console, the audit logs or the bell", (t) => {
  const out = captureOutput(t);
  readFunkwhaleEnv(HOME);
  musicUpstreamConfig({ crowHome: HOME, env: {} });
  needsConfigKeys("home-assistant");
  assert.equal(out.text().split(SENTINEL).length - 1, 0, "no console line carries a value");
  assert.equal(out.text().split(SENTINEL2).length - 1, 0);
  assert.deepEqual(scanDb(DB_PATH, SENTINEL), []);
  assert.deepEqual(scanDb(DB_PATH, SENTINEL2), []);
  assert.equal(existsSync(keychainKeyPath(HOME)), true, "the scratch key file is this home's");
});