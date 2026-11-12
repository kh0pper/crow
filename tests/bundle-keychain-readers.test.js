/**
 * Task 1.8b — the three BUNDLE readers understand `keychainEnv`:
 *   - kiosk's add-on env reader (server/addon-env.js, used by the kiosk panel),
 *   - the tax panel's taxKeys() and the operator CLI (scripts/documents.mjs, role operator-cli),
 *   - campaigns' campaignsKey().
 * Each returns the keychain value for a sealed entry and the plain value for an unsealed one.
 * Scratch CROW_HOME / CROW_DATA_DIR / keychain; every secret is a sentinel.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey } from "../servers/gateway/keychain/key.js";
import { saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const SENTINEL3 = "sentinel-" + randomUUID();
const REPO = join(import.meta.dirname, "..");

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-bundle-readers-"));
const HOME = join(SCRATCH, "home");
const DATA = join(SCRATCH, "data");
mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_APP_ROOT = REPO;
delete process.env.CROW_ADDON_HOST;
delete process.env.CROW_TAX_ENCRYPTION_KEY;
delete process.env.CROW_CAMPAIGNS_ENCRYPTION_KEY;

const DB_PATH = join(DATA, "crow.db");
const raw = new Database(DB_PATH);
raw.exec(KEYCHAIN_DDL);
raw.exec(SCAN_TABLE_DDL);
raw.exec(`CREATE TABLE IF NOT EXISTS tax_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, doc_type TEXT NOT NULL, owner TEXT DEFAULT 'taxpayer', file_path TEXT NOT NULL, status TEXT DEFAULT 'uploaded', return_id TEXT, extracted_data TEXT, confidence TEXT, warnings TEXT, uploaded_at TEXT, ingested_at TEXT)`);
const KEY = createKeychainKey({ crowHome: HOME });

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
await saveExtensionSecret(db, KEY, { bundleId: "tax", envKey: "CROW_TAX_ENCRYPTION_KEY", label: "Tax key", secret: SENTINEL2, origin: "typed" });
await saveExtensionSecret(db, KEY, { bundleId: "campaigns", envKey: "CROW_CAMPAIGNS_ENCRYPTION_KEY", label: "Campaigns key", secret: SENTINEL3, origin: "typed" });

const ADDONS = join(HOME, "mcp-addons.json");
const sealedAddons = () => ({
  funkwhale: { command: "node", args: ["x.js"], env: { FUNKWHALE_URL: "http://funkwhale.local" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"] },
  tax: { command: "node", args: ["x.js"], env: {}, keychainEnv: ["CROW_TAX_ENCRYPTION_KEY"] },
  campaigns: { command: "node", args: ["x.js"], env: {}, keychainEnv: ["CROW_CAMPAIGNS_ENCRYPTION_KEY"] },
});
const plainAddons = () => ({
  funkwhale: { command: "node", args: ["x.js"], env: { FUNKWHALE_URL: "http://funkwhale.local", FUNKWHALE_ACCESS_TOKEN: "plain-fw" } },
  tax: { command: "node", args: ["x.js"], env: { CROW_TAX_ENCRYPTION_KEY: "plain-tax" } },
  campaigns: { command: "node", args: ["x.js"], env: { CROW_CAMPAIGNS_ENCRYPTION_KEY: "plain-campaigns" } },
});
const writeAddons = (v) => writeFileSync(ADDONS, JSON.stringify(v), { mode: 0o600 });

// This process runs as the gateway (the panels do; 0.5).
const { registerAddonUnsealer } = await import("../servers/shared/addon-secrets.js");
registerAddonUnsealer("gateway");
const { addonEnvFromFile } = await import("../bundles/kiosk/server/addon-env.js");
const { taxKeys } = await import("../bundles/tax/panel/routes.js");
const { campaignsKey } = await import("../bundles/campaigns/server/key.js");

after(() => {
  try { raw.close(); } catch { /* already closed */ }
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("the kiosk's add-on env reader unseals a listed token and returns the plain entry otherwise", (t) => {
  const out = captureOutput(t);
  writeAddons(sealedAddons());
  const sealed = addonEnvFromFile(ADDONS, "funkwhale");
  assert.equal(sealed.FUNKWHALE_ACCESS_TOKEN, SENTINEL, "the keychain value is the music source's token");
  assert.equal(sealed.FUNKWHALE_URL, "http://funkwhale.local");

  writeAddons(plainAddons());
  const plain = addonEnvFromFile(ADDONS, "funkwhale");
  assert.equal(plain.FUNKWHALE_ACCESS_TOKEN, "plain-fw", "an unsealed entry reads exactly as before");
  assert.equal(addonEnvFromFile(ADDONS, "not-installed"), null);
  assert.equal(out.text().split(SENTINEL).length - 1, 0, "nothing logged a value");
});

test("the tax panel's taxKeys() unseals the sealed key and reads the plain one otherwise", () => {
  writeAddons(sealedAddons());
  assert.equal(taxKeys().key, SENTINEL2);
  assert.equal(taxKeys().previous, "");
  writeAddons(plainAddons());
  assert.equal(taxKeys().key, "plain-tax");
});

test("campaignsKey() unseals the sealed key and still lets the gateway env override a plain entry", () => {
  writeAddons(sealedAddons());
  assert.equal(campaignsKey({ CROW_HOME: HOME }), SENTINEL3);
  writeAddons(plainAddons());
  assert.equal(campaignsKey({ CROW_HOME: HOME }), "plain-campaigns");
  assert.equal(campaignsKey({ CROW_HOME: HOME, CROW_CAMPAIGNS_ENCRYPTION_KEY: "env-campaigns" }), "plain-campaigns", "the entry wins, as in proxy.js");
});

test("the tax CLI reads a sealed key as the operator and prints counts only", () => {
  writeAddons(sealedAddons());
  // CROW_DATA_DIR makes the CLI, the bundle db factory and the keychain reader name ONE file.
  const r = spawnSync(process.execPath, [join(REPO, "bundles", "tax", "scripts", "documents.mjs"), "encrypt"], {
    env: { PATH: process.env.PATH, HOME, CROW_HOME: HOME, CROW_DATA_DIR: DATA, CROW_APP_ROOT: REPO },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const report = JSON.parse(r.stdout);
  assert.equal(typeof report, "object", "the CLI printed its JSON counts");
  assert.equal(r.stdout.includes(SENTINEL2), false, "never the key");
  assert.equal(r.stderr.includes(SENTINEL2), false);
});

test("no bundle reader leaks a sentinel to the console, the audit logs or the bell", (t) => {
  const out = captureOutput(t);
  writeAddons(sealedAddons());
  addonEnvFromFile(ADDONS, "funkwhale");
  taxKeys();
  campaignsKey({ CROW_HOME: HOME });
  for (const s of [SENTINEL, SENTINEL2, SENTINEL3]) {
    assert.equal(out.text().split(s).length - 1, 0);
    assert.deepEqual(scanDb(DB_PATH, s), []);
  }
});