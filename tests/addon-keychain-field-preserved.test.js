/**
 * Task 1.11 — the writers that run outside one gateway write section still keep an entry's
 * `keychainEnv` list:
 *
 *   1. `repinAddon` (the operator CLI and the Extensions one-click re-pin) replaces the
 *      command and its pin on a SPREAD entry, so the list (and every other field) survives;
 *   2. migrate-linked's migration write and its `--undo` both carry the list: the migration
 *      works on a deep copy of the entry and the backup holds the entry from before it, so a
 *      list can never be dropped (the plan's compare-and-swap, 0.6.4, depends on this);
 *   3. crow's satellite install record writes a satellite entry that names no keys, and never
 *      touches another add-on's list in the same document.
 *
 * A plain value that a listed name still holds is NOT this writer's business either: 0.1
 * leaves that to PR3's migration (after its read-back proof), so the value is carried
 * through byte for byte here — and never logged.
 *
 * Scratch homes under os.tmpdir(); nothing here reads ~/.crow, shells out or uses the network.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureOutput } from "./helpers/sentinel-scan.mjs";

const REPO = join(import.meta.dirname, "..");
const dirs = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// The satellite install record resolves the instance's data dir at import time.
process.env.CROW_HOME = tmp("addon-preserved-home-");
process.env.CROW_DATA_DIR = tmp("addon-preserved-data-");
delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;

const { repinAddon } = await import("../scripts/ops/pin-addon-command.mjs");
const MIGRATE = join(REPO, "scripts", "addon-sandbox", "migrate-linked.mjs");
const { migrateLinkedAddons, undoMigration } = await import(pathToFileURL(MIGRATE).href);
const I = await import("../servers/gateway/satellites/installs.js");

/** Every value in this file is a sentinel: no writer may log or persist it anywhere new. */
const SENTINEL = "sentinel-" + randomUUID();

const WALLED = { CROW_ADDON_WALLS_DEFAULT: "walled" };
const NOW = () => new Date("2026-01-02T03:04:05Z");
const STAMP = "20260102T030405Z";
const NO_SELF = { names: [], addrs: [] };

const readAddons = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeAddons = (p, addons) => writeFileSync(p, JSON.stringify(addons, null, 2), { mode: 0o600 });

function put(root, rel, content = "") {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** A Crow home with an mcp-addons.json (0600), a bundles/ dir and a separate data dir. */
function makeHome(root) {
  const crowHome = join(root, "home");
  mkdirSync(join(crowHome, "bundles"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const addonsPath = join(crowHome, "mcp-addons.json");
  writeAddons(addonsPath, {});
  return { crowHome, dataDir: join(root, "data"), addonsPath, appRoot: join(root, "app") };
}

function fakeRunner() {
  return async () => ({ stdout: "", stderr: "" });
}

// ─── 1. pin-addon-command ───────────────────────────────────────────────────

test("repinAddon: the pin is rewritten on a spread entry — keychainEnv, env and ownerSet survive", (t) => {
  const out = captureOutput(t);
  const home = tmp("addon-preserved-pin-");
  put(home, "bundles/rk/run.sh", "#!/bin/bash\nv1\n");
  chmodSync(join(home, "bundles", "rk", "run.sh"), 0o755);
  const addonsPath = join(home, "mcp-addons.json");
  // A realistic sealed entry, with a plain value left over for a listed name (0.3 row 2 —
  // stripped by PR3's migration after proof, never by a writer).
  writeAddons(addonsPath, {
    rk: {
      command: "./run.sh", args: ["--mcp"],
      env: { RK_URL: "http://127.0.0.1:8600", RK_TOKEN: SENTINEL },
      keychainEnv: ["RK_TOKEN"],
      ownerSet: ["RK_URL"],
    },
  });

  const r = repinAddon({ crowHome: home, id: "rk" });
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  const entry = readAddons(addonsPath).rk;
  assert.equal(entry.command, "./run.sh");
  assert.equal(entry.command_sha256, r.sha256, "the pin was written");
  assert.deepEqual(entry.args, ["--mcp"], "the rest of the entry is untouched");
  assert.deepEqual(entry.keychainEnv, ["RK_TOKEN"], "the list survives the CLI write");
  assert.deepEqual(entry.ownerSet, ["RK_URL"]);
  assert.equal(entry.env.RK_TOKEN, SENTINEL, "a leftover plain value is PR3's to strip, not a writer's");
  assert.equal(entry.env.RK_URL, "http://127.0.0.1:8600");
  assert.equal(out.text().includes(SENTINEL), false, "nothing logs the value");
});

// ─── 2. migrate-linked: the migration write and --undo ──────────────────────

test("migrate-linked: the rewritten entry keeps keychainEnv, and --undo restores the entry with it", async (t) => {
  const out = captureOutput(t);
  const root = tmp("addon-preserved-migrate-");
  const { crowHome, dataDir, addonsPath } = makeHome(root);
  const source = join(root, "src", "acme");
  put(source, "run.sh", "#!/bin/sh\nexec node server/index.js\n");
  put(source, "server/index.js", "// an mcp server\n");
  put(source, "manifest.json", JSON.stringify({ id: "acme", version: "1.0.0" }));
  symlinkSync(source, join(crowHome, "bundles", "acme"), "dir");
  chmodSync(join(source, "run.sh"), 0o755);
  const original = {
    command: join(source, "run.sh"), args: ["--mcp"], cwd: source,
    env: { ACME_URL: "http://127.0.0.1:8601", ACME_TOKEN: SENTINEL },
    keychainEnv: ["ACME_TOKEN"],
    ownerSet: ["ACME_URL"],
  };
  writeAddons(addonsPath, { acme: original });

  const r = await migrateLinkedAddons({
    crowHome, appRoot: join(root, "app"), dataDir, mcpAddonsPath: addonsPath,
    env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["acme"], JSON.stringify(r.failed));
  const migrated = readAddons(addonsPath).acme;
  assert.deepEqual(migrated.keychainEnv, ["ACME_TOKEN"], "the migration write keeps the list");
  assert.equal(migrated.cwd, undefined, "the entry really was rewritten");
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), false);

  const undo = await undoMigration({
    crowHome, ids: ["acme"], mcpAddonsPath: addonsPath, now: () => new Date("2026-02-03T04:05:06Z"), log: () => {},
  });
  assert.deepEqual(undo.restored, ["acme"]);
  assert.deepEqual(readAddons(addonsPath).acme, original, "--undo restores the entry, its keychainEnv included");
  assert.ok(readFileSync(join(crowHome, "addon-walls-migrate", `acme-${STAMP}.undone.json`)).length > 0, "the backup is kept, marked undone");
  assert.equal(out.text().includes(SENTINEL), false, "nothing logs the value");
});

// ─── 3. crow's satellite install record ────────────────────────────────────

test("satellite installs: the satellite entry has no keychainEnv, and another add-on's list is kept", () => {
  const home = tmp("addon-preserved-sat-");
  const app = tmp("addon-preserved-sat-app-");
  mkdirSync(join(app, "demo"), { recursive: true });
  writeFileSync(join(app, "demo", "manifest.json"), JSON.stringify({ id: "demo", version: "1.2.0" }));
  const paths = I.installPaths(home);
  writeAddons(paths.addons, {
    // A local add-on that shares the document: the satellite record must not lose its list.
    funkwhale: {
      command: "node", args: ["server/index.js"],
      env: { FUNKWHALE_URL: "http://127.0.0.1:8600", FUNKWHALE_ACCESS_TOKEN: SENTINEL },
      keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"],
    },
  });

  const r = I.recordSatelliteInstall({ id: "demo", satelliteId: "sat_aaaaaaaaaaaaaaaaaaaa", version: "1.2.0", appBundles: app, paths, skillMode: "off" });
  assert.equal(r.ok, true);
  const addons = readAddons(paths.addons);
  assert.deepEqual(addons.demo, { transport: "satellite", satellite_id: "sat_aaaaaaaaaaaaaaaaaaaa", bundle: "demo" });
  assert.equal("keychainEnv" in addons.demo, false, "a satellite entry names no keys, so it lists none");
  assert.deepEqual(addons.funkwhale.keychainEnv, ["FUNKWHALE_ACCESS_TOKEN"], "the local add-on's list survives");
  assert.equal(addons.funkwhale.env.FUNKWHALE_ACCESS_TOKEN, SENTINEL);

  // Removing the satellite record only touches its own entry.
  const rm = I.removeSatelliteInstall({ id: "demo", satelliteId: "sat_aaaaaaaaaaaaaaaaaaaa", appBundles: app, paths });
  assert.equal(rm.ok, true);
  const after = readAddons(paths.addons);
  assert.equal(after.demo, undefined);
  assert.deepEqual(after.funkwhale.keychainEnv, ["FUNKWHALE_ACCESS_TOKEN"]);
});