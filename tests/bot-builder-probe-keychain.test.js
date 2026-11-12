/**
 * Task 1.9 — the Bot Builder probe (Tools tab) understands `keychainEnv`:
 *   - a sealed add-on that is CONNECTED is read from the live connection (no second spawn);
 *   - with no live entry it is hydrated with this process's role and probed;
 *   - a missing keychain row, or a process that never registered a role (the ext_registry
 *     CLI), answers ok:false with the fixed sentence — never a key-less spawn.
 * Scratch CROW_HOME / CROW_DATA_DIR / keychain; the secret is a sentinel, and the cached
 * probe result must never carry it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey } from "../servers/gateway/keychain/key.js";
import { saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const REPO = join(import.meta.dirname, "..");

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-probe-keychain-"));
const HOME = join(SCRATCH, "home");
const DATA = join(SCRATCH, "data");
mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_APP_ROOT = REPO;
delete process.env.CROW_ADDON_HOST;

const DB_PATH = join(DATA, "crow.db");
const raw = new Database(DB_PATH);
raw.exec(KEYCHAIN_DDL);
raw.exec(SCAN_TABLE_DDL);
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

await saveExtensionSecret(db, KEY, { bundleId: "sealed-ext", envKey: "SECRET_TOKEN", label: "Sealed", secret: SENTINEL, origin: "typed" });
writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({
  "sealed-ext": { command: "node", args: ["x.js"], env: { DEMO_URL: "http://demo.local" }, keychainEnv: ["SECRET_TOKEN"] },
  "sealed-missing": { command: "node", args: ["x.js"], env: {}, keychainEnv: ["MISSING_TOKEN"] },
}), { mode: 0o600 });

const { ADDON_KEYS_UNREADABLE, registerAddonUnsealer } = await import("../servers/shared/addon-secrets.js");
registerAddonUnsealer("gateway");
const { extensionTools, listInstalledExtensions } = await import("../scripts/pi-bots/ext_registry.mjs");
const { probeExtensions } = await import("../servers/gateway/dashboard/panels/bot-builder/data-queries.js");
const { connectedServers, getAddonLiveTools } = await import("../servers/gateway/proxy.js");

after(() => {
  try { raw.close(); } catch { /* already closed */ }
});

function extOf(id) {
  return listInstalledExtensions(HOME).find((e) => e.id === id);
}

test("a sealed add-on with a live connection returns its tools in the probe's shape, with no spawn", async () => {
  assert.deepEqual(extOf("sealed-ext").block.keychainEnv, ["SECRET_TOKEN"], "the stored entry lists the name");
  connectedServers.set("sealed-ext", {
    client: {}, status: "connected", isAddon: true,
    tools: [{ name: "live_tool", description: "from the running copy", inputSchema: { type: "object" } }],
  });
  try {
    let spawned = false;
    const r = await extensionTools(extOf("sealed-ext"), {
      crowHome: HOME,
      liveTools: getAddonLiveTools,
      probe: async () => { spawned = true; return { ok: true, tools: [] }; },
    });
    assert.equal(r.ok, true);
    assert.equal(spawned, false, "nothing spawned a second copy");
    // Same shape probeServerTools returns: no raw inputSchema, hasPattern present.
    assert.deepEqual(r.tools, [{ name: "live_tool", description: "from the running copy", hasPattern: false, label: "live_tool", subgroup: null }]);
    assert.equal(JSON.stringify(r).includes(SENTINEL), false, "the live list carries names only");
  } finally {
    connectedServers.delete("sealed-ext");
  }
});

test("a sealed add-on's LIVE tool whose inputSchema has a pattern reports hasPattern true", async () => {
  connectedServers.set("sealed-ext", {
    client: {}, status: "connected", isAddon: true,
    tools: [
      { name: "bare_tool", description: "no regex", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "regex_tool", description: "a regex", inputSchema: { type: "object", properties: { q: { type: "string", pattern: "^[a-z]+$" } } } },
    ],
  });
  try {
    const r = await extensionTools(extOf("sealed-ext"), {
      crowHome: HOME,
      liveTools: getAddonLiveTools,
      probe: async () => { throw new Error("must not spawn"); },
    });
    assert.equal(r.ok, true, r.error);
    const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    assert.equal(byName.regex_tool.hasPattern, true, "the nested pattern is found in the live schema");
    assert.equal(byName.bare_tool.hasPattern, false);
    assert.equal("inputSchema" in byName.regex_tool, false, "the raw schema does not ride along");
    assert.equal(JSON.stringify(r).includes(SENTINEL), false);
  } finally {
    connectedServers.delete("sealed-ext");
  }
});

test("with no live entry the probe receives a hydrated block (key in env) and the answer carries no value", async () => {
  let seen = null;
  const r = await extensionTools(extOf("sealed-ext"), {
    crowHome: HOME,
    liveTools: () => null,
    probe: async (block) => { seen = block; return { ok: true, tools: [{ name: "t", description: "d" }] }; },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.env.SECRET_TOKEN, SENTINEL, "the probe block carries the key");
  assert.equal(seen.env.DEMO_URL, "http://demo.local");
  assert.equal("keychainEnv" in seen, false, "the hydrated block has no list to leak");
  assert.equal(JSON.stringify(r).includes(SENTINEL), false, "the returned tools are names only");
});

test("a listed name with no keychain row answers ok:false with the fixed sentence, never a key-less spawn", async (t) => {
  const out = captureOutput(t);
  let spawned = false;
  const r = await extensionTools(extOf("sealed-missing"), {
    crowHome: HOME,
    liveTools: () => null,
    probe: async () => { spawned = true; return { ok: true, tools: [] }; },
  });
  assert.deepEqual(r, { ok: false, serverId: "sealed-missing", group: "sealed-missing", error: ADDON_KEYS_UNREADABLE });
  assert.equal(spawned, false);
  assert.equal(out.text().split(SENTINEL).length - 1, 0);
});

test("a process that never registered a role (the ext_registry CLI) answers ok:false without spawning", () => {
  const mod = new URL("../scripts/pi-bots/ext_registry.mjs", import.meta.url).href;
  const script = `
    const { extensionTools } = await import(${JSON.stringify(mod)});
    const { listInstalledExtensions } = await import(${JSON.stringify(mod)});
    const ext = listInstalledExtensions(process.env.CROW_HOME).find((e) => e.id === "sealed-ext");
    const r = await extensionTools(ext, { crowHome: process.env.CROW_HOME, probe: async () => { throw new Error("must not spawn"); } });
    console.log(JSON.stringify(r));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME, CROW_HOME: HOME, CROW_DATA_DIR: DATA, CROW_APP_ROOT: REPO },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const r = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.deepEqual(r, { ok: false, serverId: "sealed-ext", group: "sealed-ext", error: ADDON_KEYS_UNREADABLE });
  assert.equal(child.stdout.includes(SENTINEL), false);
});

test("probeExtensions passes the live getter, caches names only, and never re-spawns a cached entry", async (t) => {
  const out = captureOutput(t);
  connectedServers.set("sealed-ext", {
    client: {}, status: "connected", isAddon: true,
    tools: [{ name: "cached_live", description: "d" }],
  });
  try {
    const first = await probeExtensions(HOME);
    const probe = first.find(({ ext }) => ext.id === "sealed-ext")?.probe;
    assert.equal(probe.ok, true, probe.error);
    assert.ok(probe.tools.some((x) => x.name === "cached_live"), "tools came from the live connection");
    assert.equal(JSON.stringify(first).includes(SENTINEL), false, "the cached surface carries no value");

    // The cache answers the second render: a probe that would throw proves nothing spawned.
    connectedServers.delete("sealed-ext");
    const second = await probeExtensions(HOME, { probe: async () => { throw new Error("must not spawn"); } });
    assert.equal(JSON.stringify(second), JSON.stringify(first), "the 5-minute cache is reused");
    assert.equal(JSON.stringify(second).includes(SENTINEL), false);
  } finally {
    connectedServers.delete("sealed-ext");
  }
  assert.equal(out.text().split(SENTINEL).length - 1, 0);
  assert.deepEqual(scanDb(DB_PATH, SENTINEL), []);
});