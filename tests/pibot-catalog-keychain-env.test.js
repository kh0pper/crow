/**
 * Task 2.1 — a sealed add-on (mcp-addons.json entry with `keychainEnv`) is MARKED and
 * never unsealed on the bot-config path.
 *
 * The catalog and `extraServersFromExtensions` build spawn blocks for bots. Neither may
 * resolve a keychain handle, so neither may put a value in a block: a listed name's plain
 * copy is stripped, the `keychainEnv` field never travels, and the names the block still
 * owes the keychain come back as `needsKeys` (names only) for the process that CAN unseal.
 *
 * Every assertion about secrecy is a substring scan over the whole result — a sentinel that
 * appears anywhere (a block, a warning, a written file) fails the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crowServerCatalog } from "../scripts/pi-bots/crow-server-catalog.mjs";
import { extraServersFromExtensions, writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

/** A value no block may ever carry. */
const SENTINEL = "SENTINEL-value-8c1f-never-in-a-block";

function instance(addons, { bundleDirs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-kc-"));
  const home = join(dir, ".crow");
  mkdirSync(join(home, "data"), { recursive: true });
  for (const id of bundleDirs || Object.keys(addons)) mkdirSync(join(home, "bundles", id), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify(addons));
  const binding = {
    CROW_HOME: home,
    CROW_DATA_DIR: join(home, "data"),
    CROW_DB_PATH: join(home, "data", "crow.db"),
    CROW_TASKS_DB_PATH: join(home, "data", "tasks.db"),
  };
  return { dir, home, binding };
}

const sealedEntry = (extra = {}) => ({
  command: "node",
  args: ["server/index.js"],
  env: { HA_URL: "http://ha.example:8123", HA_TOKEN: SENTINEL },
  keychainEnv: ["HA_TOKEN"],
  ...extra,
});

const plainEntry = () => ({
  command: "node",
  args: ["server/index.js"],
  env: { HA_URL: "http://ha.example:8123", HA_TOKEN: SENTINEL },
});

// ─── the catalog ────────────────────────────────────────────────────────────

test("catalog: a sealed add-on keeps its block, loses the listed plain value and the keychainEnv field", () => {
  const { home, binding } = instance({ sealed: sealedEntry() });
  const result = crowServerCatalog(home, { binding });
  const block = result.servers.sealed;
  assert.ok(block, "the block is still offered — a sealed add-on is not unconfigured");
  assert.equal(block.env.HA_TOKEN, undefined, "a listed name's plain value must not board a bot config");
  assert.equal(block.env.HA_URL, "http://ha.example:8123", "an unlisted name survives");
  assert.equal("keychainEnv" in block, false, "the list itself is not part of a spawn block");
  assert.deepEqual(result.needsKeys, { sealed: ["HA_TOKEN"] }, "the names it owes the keychain are reported");
  assert.equal(JSON.stringify(result).includes(SENTINEL), false, "no secret value anywhere in the result");
});

test("catalog: an unsealed add-on is byte-identical to today — nothing stripped, no needsKeys entry", () => {
  const { home, binding } = instance({ plain: plainEntry() });
  const result = crowServerCatalog(home, { binding });
  assert.deepEqual(result.servers.plain, {
    command: process.execPath,
    args: ["server/index.js"],
    env: { HA_URL: "http://ha.example:8123", HA_TOKEN: SENTINEL, CROW_HOME: home },
    cwd: join(home, "bundles", "plain"),
  });
  assert.deepEqual(result.needsKeys, {}, "an entry with no listed names owes nothing");
});

test("catalog: an empty keychainEnv list is the same block as no field at all", () => {
  const without = instance({ same: plainEntry() });
  const emptyField = instance({ same: { ...plainEntry(), keychainEnv: [] } });
  const bare = crowServerCatalog(without.home, { binding: without.binding });
  const empty = crowServerCatalog(emptyField.home, { binding: emptyField.binding });
  // The instance home differs between the two fixtures; normalize it before comparing.
  const strip = (block, home) => JSON.parse(JSON.stringify(block).split(home).join("<HOME>"));
  assert.deepEqual(strip(empty.servers.same, emptyField.home), strip(bare.servers.same, without.home));
  assert.deepEqual(empty.needsKeys, {});
});

test("catalog: a sealed service add-on gets no derived env, so the plaintext cannot come back through a header", () => {
  // render's manifest derives AUTH_HEADER: "Bearer ${RENDER_API_KEY}" from the entry's own env.
  const sealedHome = instance({
    render: { command: "node", args: ["server/index.js"], env: { RENDER_API_KEY: SENTINEL }, keychainEnv: ["RENDER_API_KEY"] },
  });
  const sealed = crowServerCatalog(sealedHome.home, { binding: sealedHome.binding });
  assert.ok(sealed.servers.render, "still configured: a listed name counts as set (entryConfiguredNames)");
  assert.equal(sealed.servers.render.env.RENDER_API_KEY, undefined);
  assert.equal(sealed.servers.render.env.AUTH_HEADER, undefined,
    "a derived header rendered from the stripped plaintext would put the secret back in the block");
  assert.deepEqual(sealed.needsKeys, { render: ["RENDER_API_KEY"] });
  assert.equal(JSON.stringify(sealed).includes(SENTINEL), false);

  // Control: the same entry UNSEALED does get the derived header — the fixture exercises the path.
  const plainHome = instance({ render: { command: "node", args: ["server/index.js"], env: { RENDER_API_KEY: "plain-value" } } });
  const plain = crowServerCatalog(plainHome.home, { binding: plainHome.binding });
  assert.equal(plain.servers.render.env.AUTH_HEADER, "Bearer plain-value");
});

test("catalog: an add-on that READS another add-on (ADDON_SECRET_SHARES) owes those names too", () => {
  const { home, binding } = instance({
    "sunvox-studio": {
      command: "node",
      args: ["server/index.js"],
      env: { SUNVOX_TOKEN: SENTINEL },
      keychainEnv: ["SUNVOX_TOKEN"],
    },
  });
  const result = crowServerCatalog(home, { binding });
  assert.deepEqual(result.needsKeys["sunvox-studio"],
    ["SUNVOX_TOKEN", "FUNKWHALE_URL", "FUNKWHALE_ACCESS_TOKEN"],
    "its own listed names, then the names it shares from funkwhale — deduped, never a value");
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("catalog: an add-on that never got a block owes no keys (nothing to hydrate)", () => {
  const { home, binding } = instance({ sealed: sealedEntry() }, { bundleDirs: [] });
  const result = crowServerCatalog(home, { binding });
  assert.equal(result.servers.sealed, undefined);
  assert.match(String(result.unconfigured.sealed), /not installed/);
  assert.deepEqual(result.needsKeys, {});
});

// ─── extraServersFromExtensions ─────────────────────────────────────────────

const extraDef = (ids) => ({ tools: { crow_mcp: ids.map((i) => i + "/t") } });
const NO_CANONICAL = { mcpServers: {} };

test("extraServersFromExtensions: returns { servers, needsKeys } and strips a sealed name the same way", () => {
  const { home } = instance({ sealed: sealedEntry(), plain: plainEntry() });
  const warn = console.warn; console.warn = () => {};
  let out;
  try {
    out = extraServersFromExtensions(extraDef(["sealed", "plain"]), home, { canonical: NO_CANONICAL });
  } finally { console.warn = warn; }
  assert.deepEqual(Object.keys(out).sort(), ["needsKeys", "servers"]);
  assert.equal("keychainEnv" in out.servers.sealed, false, "no keychainEnv field ever goes into a block");
  assert.equal(out.servers.sealed.env.HA_TOKEN, undefined, "the listed name's plain value is dropped");
  assert.equal(out.servers.sealed.env.HA_URL, "http://ha.example:8123");
  assert.deepEqual(out.needsKeys, { sealed: ["HA_TOKEN"] });
  assert.equal(out.servers.plain.env.HA_TOKEN, SENTINEL, "an unsealed entry is untouched here");
  assert.equal(JSON.stringify(out).includes("keychainEnv"), false, "the field name itself does not travel");
});

test("extraServersFromExtensions: a sealed entry with no other env gains no env object", () => {
  const { home } = instance({
    bare: { command: "node", args: ["server/index.js"], env: { HA_TOKEN: SENTINEL }, keychainEnv: ["HA_TOKEN"] },
  });
  const warn = console.warn; console.warn = () => {};
  let out;
  try {
    out = extraServersFromExtensions(extraDef(["bare"]), home, { canonical: NO_CANONICAL });
  } finally { console.warn = warn; }
  assert.equal("env" in out.servers.bare, false, "the only value was sealed, so nothing is left to pass");
  assert.deepEqual(out.needsKeys, { bare: ["HA_TOKEN"] });
  assert.equal(JSON.stringify(out).includes(SENTINEL), false);
});

// ─── writeBotMcp end to end ────────────────────────────────────────────────

test("writeBotMcp: a sealed add-on reaches neither the file nor the result with a value, and is reported in needsKeys", () => {
  const { dir, home, binding } = instance({ sealed: sealedEntry() });
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify(NO_CANONICAL));

  const res = writeBotMcp({ tools: { crow_mcp: ["sealed/t"] } }, {
    sessionDir, canonicalPath, crowHome: home, binding,
  });
  assert.deepEqual(res.needsKeys, { sealed: ["HA_TOKEN"] });
  assert.equal(res.json.mcpServers.sealed.env.HA_TOKEN, undefined);
  assert.equal("keychainEnv" in res.json.mcpServers.sealed, false);

  const written = readFileSync(join(sessionDir, ".mcp.json"), "utf8");
  assert.equal(written.includes(SENTINEL), false, "the written .mcp.json carries no secret value");
  assert.equal(written.includes("keychainEnv"), false, "and no keychainEnv field");
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "nor does anything else the caller gets back");
});

test("writeBotMcp: an unsealed bot config reports no needsKeys at all", () => {
  const { dir, home, binding } = instance({ plain: plainEntry() });
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify(NO_CANONICAL));
  const res = writeBotMcp({ tools: { crow_mcp: ["plain/t"] } }, {
    sessionDir, canonicalPath, crowHome: home, binding,
  });
  assert.deepEqual(res.needsKeys, {});
  assert.equal(res.json.mcpServers.plain.env.HA_TOKEN, SENTINEL, "today's behaviour, unchanged");
});