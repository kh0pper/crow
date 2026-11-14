import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

let B, dir, applyEnv, spawnEnv;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpaddons-"));
  process.env.CROW_HOME = dir;
  // Sealing is ON by default: a save seals a secret into THIS scratch data dir
  // and mints its key under the scratch home, so the schema has to exist.
  process.env.CROW_DATA_DIR = join(dir, "data");
  mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });
  B = await import("../servers/gateway/routes/bundles.js");
  // applyEnvToMcpAddons is async and refuses to run outside the add-on's lock (0.6.1).
  const { withAddonLock } = await import("../servers/gateway/addon-secrets-seal.js");
  applyEnv = (id, ...args) => withAddonLock(id, () => B.applyEnvToMcpAddons(id, ...args));
  // The spawn-time view: a listed name comes back from the keychain, never from the file.
  const { hydrateAddonEntry } = await import("../servers/shared/addon-secrets.js");
  const { gatewayKeychainPaths } = await import("../servers/gateway/addon-keys-paths.js");
  spawnEnv = (id, p) => hydrateAddonEntry(id, JSON.parse(readFileSync(p, "utf8"))[id], { unsealer: "gateway", ...gatewayKeychainPaths() })?.env || {};
});

/** Run `fn` with the sealing switch at `on` (off is the operator's explicit "0"). */
async function withSealing(on, fn) {
  const before = process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  process.env.CROW_ADDON_SECRETS_KEYCHAIN = on ? "1" : "0";
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
    else process.env.CROW_ADDON_SECRETS_KEYCHAIN = before;
  }
}

const manifest = {
  id: "workspace",
  server: { command: "node", args: ["server/index.js"], envKeys: ["PUBLIC_KEY_LISTED"], configureEnv: "envKeys-only" },
  env_vars: [
    { name: "WORKSPACE_ADMIN_PASSWORD", secret: true },
    { name: "WORKSPACE_DB_PASSWORD", secret: true, generate: "secret" },
    { name: "PUBLIC_KEY_LISTED", secret: true },
    { name: "WORKSPACE_PUBLIC_HOST" },
  ],
};

test("Configure never copies secret or generated keys into mcp-addons.json — a forwarded secret is sealed and only named", async () => {
  const p = join(dir, "mcp-addons.json");
  const LISTED = "sentinel-listed-" + randomUUID();
  writeFileSync(p, JSON.stringify({ workspace: { command: "node", args: ["server/index.js"] } }));
  const wrote = await applyEnv("workspace", {
    WORKSPACE_ADMIN_PASSWORD: "hunter2-hunter2", WORKSPACE_DB_PASSWORD: "dbpw", PUBLIC_KEY_LISTED: LISTED, WORKSPACE_PUBLIC_HOST: "crow.example.ts.net",
  }, p, manifest);
  assert.equal(wrote, true);
  const text = readFileSync(p, "utf8");
  assert.doesNotMatch(text, /hunter2|dbpw/);
  assert.equal(text.includes(LISTED), false, "the forwarded secret goes to the keychain, not the file");
  const entry = JSON.parse(text).workspace;
  assert.deepEqual(entry.env, { WORKSPACE_PUBLIC_HOST: "crow.example.ts.net" }, "only the non-secret setting stays in the entry");
  assert.deepEqual(entry.keychainEnv, ["PUBLIC_KEY_LISTED"], "the secret is listed by NAME");
  assert.equal(spawnEnv("workspace", p).PUBLIC_KEY_LISTED, LISTED, "and the keychain holds the value the child gets");
});

test("bundles that did not opt in (kodi) still receive their secrets on Configure (regression) — now sealed", async () => {
  const kodi = JSON.parse(readFileSync(join(REPO, "bundles", "kodi", "manifest.json"), "utf8"));
  const p = join(dir, "mcp-addons-kodi.json");
  const KODI_PASSWORD = "sentinel-kodi-" + randomUUID();
  writeFileSync(p, JSON.stringify({ kodi: { command: "node", args: ["server/index.js"] } }));
  await applyEnv("kodi", { KODI_PASSWORD }, p, kodi);
  const text = readFileSync(p, "utf8");
  const entry = JSON.parse(text).kodi;
  assert.equal(text.includes(KODI_PASSWORD), false, "a bundle without configureEnv still must not write the password plain");
  assert.deepEqual(entry.keychainEnv, ["KODI_PASSWORD"], "it lists the name instead");
  assert.equal(spawnEnv("kodi", p).KODI_PASSWORD, KODI_PASSWORD, "and the password reaches the child from the keychain");
});

test("sealing off (CROW_ADDON_SECRETS_KEYCHAIN=0): the kodi password is written plain, as before the keychain", async () => {
  const kodi = JSON.parse(readFileSync(join(REPO, "bundles", "kodi", "manifest.json"), "utf8"));
  const p = join(dir, "mcp-addons-kodi-off.json");
  const KODI_PASSWORD = "sentinel-kodi-off-" + randomUUID();
  writeFileSync(p, JSON.stringify({ kodi: { command: "node", args: ["server/index.js"] } }));
  await withSealing(false, () => applyEnv("kodi", { KODI_PASSWORD }, p, kodi));
  const entry = JSON.parse(readFileSync(p, "utf8")).kodi;
  assert.equal(entry.env.KODI_PASSWORD, KODI_PASSWORD, "the operator opted out: the old plain shape");
  assert.equal("keychainEnv" in entry, false, "and nothing is listed");
});

test("without a manifest the old behaviour is unchanged (back-compat)", async () => {
  const p = join(dir, "mcp-addons-2.json");
  writeFileSync(p, JSON.stringify({ x: { command: "node" } }));
  await applyEnv("x", { A: "1" }, p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).x.env, { A: "1" });
});

test("mcpAddonEntryFor mirrors the install shape", () => {
  assert.deepEqual(B.mcpAddonEntryFor({ server: { command: "node", args: ["server/index.js"] }, env_vars: [{ name: "P", default: "8456" }] }),
    { command: "node", args: ["server/index.js"], env: { P: "8456" }, ownerSet: [] });
  assert.deepEqual(B.mcpAddonEntryFor({ server: { command: "node" } }), { command: "node", args: [], ownerSet: [] });
});