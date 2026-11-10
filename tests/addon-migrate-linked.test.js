/**
 * Moving checkout-linked add-ons into the Crow home, and --undo.
 *
 * Scratch Crow homes, sources and app roots under os.tmpdir(); a fake runner
 * records the install commands instead of running npm/uv, and selfNames is
 * passed in, so nothing here reads ~/.crow, shells out or uses the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = join(import.meta.dirname, "..");
const MODULE = join(REPO, "scripts", "addon-sandbox", "migrate-linked.mjs");
const { findLinkedAddons, migrateLinkedAddons, undoMigration } = await import(pathToFileURL(MODULE).href);

const WALLED = { CROW_ADDON_WALLS_DEFAULT: "walled" };
const NOW = () => new Date("2026-01-02T03:04:05Z");
const STAMP = "20260102T030405Z";
const HEX40 = "0123456789abcdef0123456789abcdef01234567";

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const mode = (p) => statSync(p).mode & 0o777;

function put(root, rel, content = "") {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function scratch(t, name) {
  const root = mkdtempSync(join(tmpdir(), `crow-migrate-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A Crow home with an mcp-addons.json (0600) and an empty bundles/ + data/. */
function makeHome(root) {
  const crowHome = join(root, "home");
  mkdirSync(join(crowHome, "bundles"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const addonsPath = join(crowHome, "mcp-addons.json");
  writeFileSync(addonsPath, JSON.stringify({}, null, 2), { mode: 0o600 });
  return { crowHome, dataDir: join(root, "data"), addonsPath, appRoot: join(root, "app") };
}

function writeAddons(addonsPath, addons) {
  writeFileSync(addonsPath, JSON.stringify(addons, null, 2), { mode: 0o600 });
}
const readAddons = (addonsPath) => JSON.parse(readFileSync(addonsPath, "utf8"));

/** The backup files a home holds (`[]` when there is no backup folder at all). */
function backupsIn(crowHome) {
  const dir = join(crowHome, "addon-walls-migrate");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function fakeRunner() {
  const calls = [];
  const runner = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return { stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

const NO_SELF = { names: [], addrs: [] };

/** A source folder a bundle-shaped add-on would live in. */
function makeSource(root, name, extra = {}) {
  const source = join(root, "src", name);
  put(source, "run.sh", "#!/bin/sh\nexec node server/index.js\n");
  put(source, "server/index.js", "// an mcp server\n");
  put(source, "manifest.json", JSON.stringify({ id: name, version: "1.0.0" }));
  for (const [rel, content] of Object.entries(extra)) put(source, rel, content);
  return source;
}

function linkBundle(crowHome, id, source) {
  symlinkSync(source, join(crowHome, "bundles", id), "dir");
}

// ── the gate ────────────────────────────────────────────────────────────────

test("walls off (unset, off, or killed): nothing is read and nothing changes", async (t) => {
  for (const env of [{}, { CROW_ADDON_WALLS_DEFAULT: "off" }, { CROW_ADDON_WALLS_DEFAULT: "walled", CROW_ADDON_WALLS: "off" }]) {
    const root = scratch(t, "gate");
    const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
    const source = makeSource(root, "acme");
    linkBundle(crowHome, "acme", source);
    writeAddons(addonsPath, { acme: { command: join(source, "run.sh"), args: [] } });

    const addonsBefore = readFileSync(addonsPath, "utf8");
    const linkBefore = readlinkSync(join(crowHome, "bundles", "acme"));
    const listingBefore = readdirSync(join(crowHome, "bundles"));
    const runner = fakeRunner();

    const r = await migrateLinkedAddons({
      crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env, selfNames: NO_SELF, runner, now: NOW,
      log: () => {},
    });

    assert.equal(r.skipped, "walls off", `env ${JSON.stringify(env)}`);
    assert.deepEqual(r.migrated, []);
    assert.deepEqual(r.repointed, []);
    assert.deepEqual(r.failed, []);
    assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore, "mcp-addons.json is byte-identical");
    assert.equal(readlinkSync(join(crowHome, "bundles", "acme")), linkBefore, "the link is untouched");
    assert.deepEqual(readdirSync(join(crowHome, "bundles")), listingBefore, "no folder appears");
    assert.equal(existsSync(join(crowHome, "addon-walls-migrate")), false, "no backup folder");
    assert.equal(runner.calls.length, 0, "no install command ran");
  }
});

// ── the migration ───────────────────────────────────────────────────────────

test("a symlinked bundle is copied, the link kept aside, the entry rewritten and re-pinned; a second run is a no-op", async (t) => {
  const root = scratch(t, "symlink");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: join(source, "run.sh"), args: ["--mcp"], env: { KEEP: "1" }, ownerSet: [] } });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["acme"]);
  assert.deepEqual(r.failed, []);

  const installed = join(crowHome, "bundles", "acme");
  assert.equal(lstatSync(installed).isDirectory(), true);
  assert.equal(lstatSync(installed).isSymbolicLink(), false);
  assert.ok(existsSync(join(installed, "server", "index.js")), "the code came along");

  const kept = join(crowHome, "bundles", `acme.linked-${STAMP}`);
  assert.equal(lstatSync(kept).isSymbolicLink(), true, "the old link is kept as a link");
  assert.equal(readlinkSync(kept), source);

  const entry = readAddons(addonsPath).acme;
  assert.equal(entry.command, join(installed, "run.sh"), "the launcher now points into the copy");
  assert.equal(entry.command_sha256, sha256(join(installed, "run.sh")), "re-pinned to the copied launcher");
  assert.deepEqual(entry.args, ["--mcp"]);
  assert.deepEqual(entry.env, { KEEP: "1" });

  const after = readFileSync(addonsPath, "utf8");
  const again = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: () => new Date("2026-01-02T05:06:07Z"), log: () => {},
  });
  assert.deepEqual(again.migrated, []);
  assert.deepEqual(again.failed, []);
  assert.equal(readFileSync(addonsPath, "utf8"), after, "a second run changes nothing");
});

test("a symlink inside the source survives as a symlink with the same link text", async (t) => {
  const root = scratch(t, "innerlink");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme", { "data/real.txt": "bytes\n" });
  symlinkSync("real.txt", join(source, "data", "alias.txt"));
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  const copied = join(crowHome, "bundles", "acme", "data", "alias.txt");
  assert.equal(lstatSync(copied).isSymbolicLink(), true);
  assert.equal(readlinkSync(copied), "real.txt");
});

test("a source reached through a symlinked folder still gets its command rewritten; a second run is a no-op", async (t) => {
  const root = scratch(t, "symparent");
  const { crowHome, dataDir, addonsPath } = makeHome(root);
  const appReal = join(root, "app-real");
  put(appReal, "bundles/acme/run.sh", "#!/bin/sh\nexec node server/index.js\n");
  put(appReal, "bundles/acme/server/index.js", "// an mcp server\n");
  put(appReal, "bundles/acme/manifest.json", JSON.stringify({ id: "acme", version: "1.0.0" }));
  const appRoot = join(root, "app");
  symlinkSync(appReal, appRoot, "dir");
  writeAddons(addonsPath, { acme: { command: join(appRoot, "bundles", "acme", "run.sh"), args: [] } });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["acme"]);
  const installed = join(crowHome, "bundles", "acme");
  const entry = readAddons(addonsPath).acme;
  assert.equal(entry.command, join(installed, "run.sh"), "the launcher now points into the copy");
  assert.equal(entry.command_sha256, sha256(join(installed, "run.sh")), "re-pinned to the copied launcher");

  const after = readFileSync(addonsPath, "utf8");
  const again = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: () => new Date("2026-01-02T05:06:07Z"), log: () => {},
  });
  assert.deepEqual(again.migrated, [], "the entry no longer points into the checkout");
  assert.deepEqual(again.failed, []);
  assert.equal(readFileSync(addonsPath, "utf8"), after, "a second run changes nothing");
});

test(".venv, .git, __pycache__ (nested too) and node_modules are not copied", async (t) => {
  const root = scratch(t, "excluded");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme", {
    ".venv/lib/x.py": "x\n",
    ".git/HEAD": "ref\n",
    "__pycache__/a.pyc": "a\n",
    "node_modules/pkg/index.js": "// dep\n",
    "server/__pycache__/deep.pyc": "deep\n",
    "server/keep.js": "// keep\n",
  });
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["acme"]);
  const installed = join(crowHome, "bundles", "acme");
  for (const rel of [".venv", ".git", "__pycache__", "node_modules", join("server", "__pycache__")]) {
    assert.equal(existsSync(join(installed, rel)), false, `${rel} must not be copied`);
  }
  assert.ok(existsSync(join(installed, "server", "keep.js")));
});

test("a data file the entry names inside the source is copied to the data folder, the entry repointed, the source kept", async (t) => {
  const root = scratch(t, "envpath");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "texas", { "state/gov.db": "SQLite format 3\n" });
  const outside = put(root, "elsewhere/keep.db", "not mine\n");
  linkBundle(crowHome, "texas", source);
  writeAddons(addonsPath, {
    texas: { command: "node", args: ["server/index.js"], env: { GOV_DATA_DB_PATH: join(source, "state", "gov.db"), OTHER_DB: outside } },
  });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["texas"]);

  const moved = join(dataDir, "texas", "state", "gov.db");
  assert.equal(readFileSync(moved, "utf8"), "SQLite format 3\n", "the data file was copied out");
  assert.equal(readFileSync(join(source, "state", "gov.db"), "utf8"), "SQLite format 3\n", "the source file stays");
  assert.equal(readFileSync(outside, "utf8"), "not mine\n", "a path outside the source is untouched");

  const entry = readAddons(addonsPath).texas;
  assert.equal(entry.env.GOV_DATA_DB_PATH, moved);
  assert.equal(entry.env.OTHER_DB, outside);
});

test("a funkwhale-shaped entry (cwd in the app tree, no symlink) is copied, cwd dropped and its deps installed in the copy", async (t) => {
  const root = scratch(t, "cwd");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = join(appRoot, "bundles", "funkwhale");
  put(source, "server/index.js", "// server\n");
  put(source, "package.json", JSON.stringify({ name: "funkwhale", dependencies: {} }));
  put(source, "manifest.json", JSON.stringify({ id: "funkwhale", version: "1.0.7" }));
  writeAddons(addonsPath, {
    funkwhale: { command: "node", args: ["server/index.js"], cwd: source, env: { FUNKWHALE_URL: "http://crow-funkwhale:5000" }, ownerSet: [] },
  });

  const runner = fakeRunner();
  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner, now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["funkwhale"]);
  assert.deepEqual(r.failed, []);

  const installed = join(crowHome, "bundles", "funkwhale");
  assert.ok(existsSync(join(installed, "server", "index.js")), "the code was copied");

  const entry = readAddons(addonsPath).funkwhale;
  assert.equal("cwd" in entry, false, "cwd is dropped (the installed copy is the default)");
  assert.equal(entry.command, "node");

  assert.equal(runner.calls.length, 1);
  // The install runs on the copy while it is still the .migrating folder; the switch renames it.
  assert.deepEqual(runner.calls[0], { cmd: "npm", args: ["install", "--omit=dev"], cwd: `${installed}.migrating` });
});

test("a failed verify leaves the link, the entry and the bundles listing untouched, and reports the id", async (t) => {
  const root = scratch(t, "verify");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  const addonsBefore = readFileSync(addonsPath, "utf8");
  const listingBefore = readdirSync(join(crowHome, "bundles"));

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: NOW, log: () => {}, verify: () => false,
  });

  assert.deepEqual(r.migrated, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, "acme");
  assert.match(r.failed[0].reason, /does not match/);
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), true, "the link is untouched");
  assert.equal(readlinkSync(join(crowHome, "bundles", "acme")), source);
  assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore, "the entry is untouched");
  assert.deepEqual(readdirSync(join(crowHome, "bundles")), listingBefore, "the half-made copy is gone");
  assert.deepEqual(backupsIn(crowHome), [], "the backup of that attempt is gone");
});

test("a failure right after the old link was moved aside puts it back and leaves the bytes unchanged", async (t) => {
  const root = scratch(t, "switchfail");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  const addonsBefore = readFileSync(addonsPath, "utf8");
  const listingBefore = readdirSync(join(crowHome, "bundles"));

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: NOW, log: () => {},
    // The copy -> <id> rename is what fails here.
    afterSwitchStep: ({ step }) => {
      if (step === "aside") throw new Error("the copy could not be moved into place");
    },
  });

  assert.deepEqual(r.migrated, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, "acme");
  assert.match(r.failed[0].reason, /could not be moved into place/);
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), true, "the link is a link again");
  assert.equal(readlinkSync(join(crowHome, "bundles", "acme")), source);
  assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore, "the entry is untouched");
  assert.deepEqual(readdirSync(join(crowHome, "bundles")), listingBefore, "the copy is gone and no kept-aside folder is left");
  assert.deepEqual(backupsIn(crowHome), [], "the backup of that attempt is gone");
});

test("a failed registry write rolls the folder switch back and removes that attempt's backup", async (t) => {
  const root = scratch(t, "writefail");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  const addonsBefore = readFileSync(addonsPath, "utf8");
  const listingBefore = readdirSync(join(crowHome, "bundles"));

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: NOW, log: () => {},
    writeAddons: () => { throw new Error("the registry could not be written"); },
  });

  assert.deepEqual(r.migrated, []);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /registry could not be written/);
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), true, "the link is a link again");
  assert.equal(readlinkSync(join(crowHome, "bundles", "acme")), source);
  assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore, "the entry bytes are untouched");
  assert.deepEqual(readdirSync(join(crowHome, "bundles")), listingBefore, "the copy is gone and the link is the only entry");
  assert.deepEqual(backupsIn(crowHome), [], "the backup of that attempt is gone");
});

test("a data copy that stops part-way leaves nothing behind, and a retry copies the folder fresh", async (t) => {
  const root = scratch(t, "datapartial");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "texas", { "state/gov.db": "SQLite format 3\n" });
  linkBundle(crowHome, "texas", source);
  writeAddons(addonsPath, {
    texas: { command: "node", args: ["server/index.js"], env: { STATE_DIR: join(source, "state") } },
  });

  const lines = [];
  const addonsBefore = readFileSync(addonsPath, "utf8");
  const listingBefore = readdirSync(join(crowHome, "bundles"));

  const failed = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: NOW, log: (line) => lines.push(String(line)),
    // A copy that writes half the bytes and then gives up.
    copyData: (_from, to) => {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      writeFileSync(join(to, "gov.db"), "SQLite fo");
      throw new Error("the data copy stopped part-way");
    },
  });

  assert.deepEqual(failed.migrated, []);
  assert.equal(failed.failed.length, 1);
  assert.equal(failed.failed[0].id, "texas");
  assert.match(failed.failed[0].reason, /stopped part-way/);
  assert.equal(existsSync(join(dataDir, "texas")), false, "the part-made data folder is gone");
  assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore, "the entry is untouched");
  assert.deepEqual(readdirSync(join(crowHome, "bundles")), listingBefore, "the copy is gone");
  assert.deepEqual(backupsIn(crowHome), [], "the backup of that attempt is gone");

  lines.length = 0;
  const retry = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: NOW, log: (line) => lines.push(String(line)),
  });
  assert.deepEqual(retry.migrated, ["texas"]);
  assert.equal(readFileSync(join(dataDir, "texas", "state", "gov.db"), "utf8"), "SQLite format 3\n", "a fresh copy, not the rest of a partial one");
  assert.equal(lines.some((line) => /kept that copy/.test(line)), false, "the retry never read a partial copy as done");
});

test("a folder that could not be put back keeps its backup for --undo", async (t) => {
  const root = scratch(t, "undostuck");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  const kept = join(crowHome, "bundles", `acme.linked-${STAMP}`);
  const lines = [];
  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: fakeRunner(), now: NOW, log: (line) => lines.push(String(line)),
    // The kept-aside link is gone before the switch is undone, so the restoring
    // rename cannot put the folder back.
    afterSwitchStep: ({ step }) => {
      if (step !== "place") return;
      rmSync(kept, { recursive: true, force: true });
      throw new Error("the switch failed after the old link was moved aside");
    },
  });

  assert.deepEqual(r.migrated, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, "acme");
  assert.deepEqual(backupsIn(crowHome), [`acme-${STAMP}.json`], "the backup stays, and --undo can read it");
  assert.equal(
    lines.includes("[addon-migrate] acme: could not put the folders back; its backup is kept for --undo"),
    true,
  );
});

test("a failed install leaves nothing behind under the add-on's data folder", async (t) => {
  const root = scratch(t, "installfail");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme", {
    "package.json": JSON.stringify({ name: "acme", dependencies: {} }),
    "state/gov.db": "SQLite format 3\n",
  });
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, {
    acme: { command: "node", args: ["server/index.js"], env: { GOV_DATA_DB_PATH: join(source, "state", "gov.db") } },
  });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF,
    runner: async () => { throw new Error("npm install failed"); }, now: NOW, log: () => {},
  });

  assert.deepEqual(r.migrated, []);
  assert.equal(r.failed[0].id, "acme");
  assert.match(r.failed[0].reason, /npm install failed/);
  assert.equal(existsSync(join(dataDir, "acme")), false, "the data copy-out never ran, so no folder was made");
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), true, "the link is untouched");
  assert.deepEqual(backupsIn(crowHome), [], "the backup of that attempt is gone");
});

test("a uv project gets UV_PROJECT_ENVIRONMENT inside its data folder", async (t) => {
  const root = scratch(t, "uv");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme", { "pyproject.toml": "[project]\nname = 'acme'\n" });
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "uv", args: ["run", "main.py"] } });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["acme"]);
  const entry = readAddons(addonsPath).acme;
  assert.equal(entry.env.UV_PROJECT_ENVIRONMENT, join(dataDir, "acme", ".venv"));
  assert.equal(mode(join(dataDir, "acme")), 0o700);
});

test("google-workspace: no manifest plus a uvx git ref installs only the stub manifest", async (t) => {
  const root = scratch(t, "stub");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = join(root, "src", "google-workspace");
  put(source, "README.md", "code comes from the pinned git ref\n");
  linkBundle(crowHome, "google-workspace", source);
  writeAddons(addonsPath, { "google-workspace": { command: "uvx", args: ["--from", `git+https://example.invalid/ws@${HEX40}`, "workspace-mcp"], ownerSet: [] } });

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.migrated, ["google-workspace"]);

  const installed = join(crowHome, "bundles", "google-workspace");
  assert.deepEqual(readdirSync(installed), ["manifest.json"], "nothing from the source is copied");
  assert.deepEqual(JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8")), {
    id: "google-workspace",
    name: "google-workspace",
    type: "mcp-server",
    version: "0.0.0-local",
    sandbox: { files: { oauthDir: "env:GOOGLE_TOKEN_FILE" } },
  });
  assert.equal(readAddons(addonsPath)["google-workspace"].args[0], "--from", "the launcher args stay as they were");
});

test("a data folder that is a symlink fails the id and nothing is written through it", async (t) => {
  const root = scratch(t, "datalink");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme", { "state/gov.db": "SQLite format 3\n" });
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, {
    acme: { command: "node", args: ["server/index.js"], env: { GOV_DATA_DB_PATH: join(source, "state", "gov.db") } },
  });
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(dataDir, "acme"), "dir");

  const addonsBefore = readFileSync(addonsPath, "utf8");
  const listingBefore = readdirSync(join(crowHome, "bundles"));

  const r = await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });

  assert.deepEqual(r.migrated, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, "acme");
  assert.match(r.failed[0].reason, /data folder/);
  assert.equal(lstatSync(join(dataDir, "acme")).isSymbolicLink(), true, "the link is still a link");
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was written through it");
  assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore, "the entry is untouched");
  assert.deepEqual(readdirSync(join(crowHome, "bundles")), listingBefore, "nothing appeared in the bundles folder");
  assert.deepEqual(backupsIn(crowHome), [], "no backup was written for a failed id");
});

// ── finding ─────────────────────────────────────────────────────────────────

test("findLinkedAddons: only stdio, slug-id entries; a satellite, HTTP or non-slug entry is left out", async (t) => {
  const root = scratch(t, "find");
  const { crowHome, dataDir, appRoot } = makeHome(root);
  const source = join(root, "src", "acme");
  put(source, "manifest.json", "{}");
  for (const id of ["acme", "beta", "gamma", "delta"]) linkBundle(crowHome, id, source);
  const addons = {
    acme: { command: "node", args: [] },
    beta: { command: "node", args: [], url: "http://127.0.0.1:1/mcp" },
    gamma: { command: "node", args: [], satellite: { id: "s1" } },
    delta: { command: "node", args: [], transport: "http" },
    "Not A Slug": { command: "node", args: [] },
  };
  const found = findLinkedAddons({ crowHome, appRoot, dataDir, addons });
  assert.deepEqual(found.map((f) => f.id), ["acme"]);
  assert.equal(found[0].how, "symlink");
});

// ── funkwhale's own-host URL ────────────────────────────────────────────────

test("funkwhale: a URL naming this computer is repointed to its local port; another host and ownerSet are left alone", async (t) => {
  const root = scratch(t, "repoint");
  const { crowHome, dataDir, addonsPath } = makeHome(root);
  const selfNames = { names: ["crow.example.ts.net"], addrs: [] };

  writeAddons(addonsPath, {
    funkwhale: {
      command: "node", args: ["server/index.js"],
      env: { FUNKWHALE_URL: "https://crow.example.ts.net:8443", FUNKWHALE_ACCESS_TOKEN: "token-not-real" },
      ownerSet: ["FUNKWHALE_URL"],
    },
  });
  const r = await migrateLinkedAddons({
    crowHome, appRoot: REPO, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(r.repointed, ["funkwhale"]);
  let entry = readAddons(addonsPath).funkwhale;
  assert.equal(entry.env.FUNKWHALE_URL, "http://127.0.0.1:8600", "the compose default port");
  assert.deepEqual(entry.ownerSet, ["FUNKWHALE_URL"], "provenance is kept");
  assert.equal(entry.env.FUNKWHALE_ACCESS_TOKEN, "token-not-real");

  // The port the entry names wins over the manifest default.
  writeAddons(addonsPath, {
    funkwhale: { command: "node", args: ["server/index.js"], env: { FUNKWHALE_URL: "https://crow.example.ts.net:8443", FUNKWHALE_NGINX_BIND_PORT: "8611" } },
  });
  await migrateLinkedAddons({
    crowHome, appRoot: REPO, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames, runner: fakeRunner(), now: NOW, log: () => {},
  });
  entry = readAddons(addonsPath).funkwhale;
  assert.equal(entry.env.FUNKWHALE_URL, "http://127.0.0.1:8611");

  // Someone else's music server is none of our business.
  writeAddons(addonsPath, {
    funkwhale: { command: "node", args: ["server/index.js"], env: { FUNKWHALE_URL: "https://music.example.invalid" } },
  });
  const before = readFileSync(addonsPath, "utf8");
  const other = await migrateLinkedAddons({
    crowHome, appRoot: REPO, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(other.repointed, []);
  assert.equal(readFileSync(addonsPath, "utf8"), before, "another host's URL is untouched");
});

// ── undo ────────────────────────────────────────────────────────────────────

test("--undo restores the link and the entry, keeps the copy, and a second undo is a no-op", async (t) => {
  const root = scratch(t, "undo");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  const original = { command: join(source, "run.sh"), args: ["--mcp"], cwd: source, ownerSet: [] };
  writeAddons(addonsPath, { acme: original });

  await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), false);

  const undoAt = () => new Date("2026-02-03T04:05:06Z");
  const first = await undoMigration({ crowHome, ids: ["acme"], mcpAddonsPath: addonsPath, now: undoAt, log: () => {} });
  assert.deepEqual(first.restored, ["acme"]);
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), true, "the link is a link again");
  assert.equal(readlinkSync(join(crowHome, "bundles", "acme")), source, "and points where it did");
  assert.deepEqual(readAddons(addonsPath).acme, original, "the entry is back, deep-equal");
  assert.equal(lstatSync(join(crowHome, "bundles", "acme.migrated-20260203T040506Z")).isDirectory(), true, "the copy is kept");
  assert.ok(existsSync(join(crowHome, "addon-walls-migrate", `acme-${STAMP}.undone.json`)), "the backup is marked undone");

  const second = await undoMigration({ crowHome, ids: ["acme"], mcpAddonsPath: addonsPath, now: undoAt, log: () => {} });
  assert.deepEqual(second.restored, []);
  assert.deepEqual(second.skipped.map((s) => s.id), ["acme"]);
  assert.equal(readlinkSync(join(crowHome, "bundles", "acme")), source, "nothing moved");
  assert.deepEqual(readAddons(addonsPath).acme, original);
});

test("one --undo after a repoint and a later migration restores the original URL and the original link", async (t) => {
  const root = scratch(t, "undo-two");
  const { crowHome, dataDir, addonsPath } = makeHome(root);
  const selfNames = { names: ["crow.example.ts.net"], addrs: [] };
  const original = {
    command: "node", args: ["server/index.js"],
    env: { FUNKWHALE_URL: "https://crow.example.ts.net:8443" }, ownerSet: ["FUNKWHALE_URL"],
  };
  writeAddons(addonsPath, { funkwhale: original });

  const first = await migrateLinkedAddons({
    crowHome, appRoot: REPO, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.deepEqual(first.repointed, ["funkwhale"]);
  assert.equal(readAddons(addonsPath).funkwhale.env.FUNKWHALE_URL, "http://127.0.0.1:8600");

  // The owner links the bundle into the checkout afterwards, and a later boot migrates it.
  const source = makeSource(root, "funkwhale");
  linkBundle(crowHome, "funkwhale", source);
  const second = await migrateLinkedAddons({
    crowHome, appRoot: REPO, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames,
    runner: fakeRunner(), now: () => new Date("2026-01-02T04:05:06Z"), log: () => {},
  });
  assert.deepEqual(second.migrated, ["funkwhale"]);
  assert.equal(lstatSync(join(crowHome, "bundles", "funkwhale")).isSymbolicLink(), false);

  const r = await undoMigration({
    crowHome, ids: ["funkwhale"], mcpAddonsPath: addonsPath, now: () => new Date("2026-02-03T04:05:06Z"), log: () => {},
  });
  assert.deepEqual(r.restored, ["funkwhale"]);
  assert.equal(lstatSync(join(crowHome, "bundles", "funkwhale")).isSymbolicLink(), true, "the link is a link again");
  assert.equal(readlinkSync(join(crowHome, "bundles", "funkwhale")), source, "and points where it did");
  assert.deepEqual(readAddons(addonsPath).funkwhale, original, "the entry before the first change");
  assert.deepEqual(backupsIn(crowHome), [
    "funkwhale-20260102T030405Z.undone.json",
    "funkwhale-20260102T040506Z.undone.json",
  ], "both live backups are marked undone");
});

test("--undo skips a backup whose kept folder is a path or whose record names another add-on", async (t) => {
  const cases = [
    { name: "path", record: (id) => ({ id, linkName: "../../x" }) },
    { name: "other id", record: () => ({ id: "studio", linkName: null }) },
  ];
  for (const one of cases) {
    const root = scratch(t, "undo-forged");
    const { crowHome, addonsPath } = makeHome(root);
    const dir = join(crowHome, "addon-walls-migrate");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The folder "../../x" would name, and a folder outside the home: neither moves.
    mkdirSync(join(root, "x"), { recursive: true });
    writeFileSync(join(root, "x", "keep.txt"), "keep\n");
    writeAddons(addonsPath, { acme: { command: "node", args: ["now"] } });
    const before = readFileSync(addonsPath, "utf8");

    writeFileSync(join(dir, `acme-${STAMP}.json`), JSON.stringify({
      v: 1, at: "2026-01-02T03:04:05Z", kind: "migrate",
      entry: { command: "node", args: ["forged"] }, how: "symlink", source: null,
      ...one.record("acme"),
    }), { mode: 0o600 });

    const r = await undoMigration({
      crowHome, ids: ["acme"], mcpAddonsPath: addonsPath, now: () => new Date("2026-02-03T04:05:06Z"), log: () => {},
    });
    assert.deepEqual(r.restored, [], one.name);
    assert.equal(r.skipped[0].id, "acme", one.name);
    assert.equal(r.skipped[0].reason, "its backup does not match this add-on", one.name);
    assert.equal(readFileSync(addonsPath, "utf8"), before, one.name + ": the entry is untouched");
    assert.equal(readFileSync(join(root, "x", "keep.txt"), "utf8"), "keep\n", one.name + ": nothing was renamed out of it");
    assert.deepEqual(backupsIn(crowHome), [`acme-${STAMP}.json`], one.name + ": the backup is left as it was");
  }
});

test("a backup's numeric suffix orders it: -9 is older than -10, so its entry is the one restored", async (t) => {
  const root = scratch(t, "suffix");
  const { crowHome, addonsPath } = makeHome(root);
  const dir = join(crowHome, "addon-walls-migrate");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [suffix, arg] of [[9, "nine"], [10, "ten"]]) {
    writeFileSync(join(dir, `acme-${STAMP}-${suffix}.json`), JSON.stringify({
      v: 1, id: "acme", at: "2026-01-02T03:04:05Z", kind: "repoint",
      entry: { command: "node", args: [arg] }, how: null, source: null, linkName: null, linkTarget: null,
    }), { mode: 0o600 });
  }
  writeAddons(addonsPath, { acme: { command: "node", args: ["now"] } });

  const r = await undoMigration({
    crowHome, ids: ["acme"], mcpAddonsPath: addonsPath, now: () => new Date("2026-02-03T04:05:06Z"), log: () => {},
  });
  assert.deepEqual(r.restored, ["acme"]);
  assert.deepEqual(readAddons(addonsPath).acme, { command: "node", args: ["nine"] }, "the oldest live backup is the state before the first change");
  assert.deepEqual(backupsIn(crowHome), [`acme-${STAMP}-10.undone.json`, `acme-${STAMP}-9.undone.json`]);
});

test("undo with no ids restores every migrated add-on, and works with the walls off", async (t) => {
  const root = scratch(t, "undoall");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const addons = {};
  for (const id of ["acme", "beta"]) {
    const source = makeSource(root, id);
    linkBundle(crowHome, id, source);
    addons[id] = { command: "node", args: ["server/index.js"] };
  }
  writeAddons(addonsPath, addons);

  await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  const installed = readAddons(addonsPath);
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(crowHome, "bundles", "beta")).isSymbolicLink(), false);

  const prior = process.env.CROW_ADDON_WALLS;
  process.env.CROW_ADDON_WALLS = "off";
  try {
    const r = await undoMigration({ crowHome, ids: null, mcpAddonsPath: addonsPath, now: () => new Date("2026-03-04T05:06:07Z"), log: () => {} });
    assert.deepEqual(r.restored.sort(), ["acme", "beta"]);
  } finally {
    if (prior === undefined) delete process.env.CROW_ADDON_WALLS;
    else process.env.CROW_ADDON_WALLS = prior;
  }
  assert.deepEqual(readAddons(addonsPath), addons, "both entries are back");
  for (const id of ["acme", "beta"]) {
    assert.equal(lstatSync(join(crowHome, "bundles", id)).isSymbolicLink(), true);
  }
});

test("undo after a repoint puts the old URL back", async (t) => {
  const root = scratch(t, "undorepoint");
  const { crowHome, dataDir, addonsPath } = makeHome(root);
  const original = { command: "node", args: ["server/index.js"], env: { FUNKWHALE_URL: "https://crow.example.ts.net:8443" }, ownerSet: ["FUNKWHALE_URL"] };
  writeAddons(addonsPath, { funkwhale: original });

  await migrateLinkedAddons({
    crowHome, appRoot: REPO, dataDir, mcpAddonsPath: addonsPath, env: WALLED,
    selfNames: { names: ["crow.example.ts.net"], addrs: [] }, runner: fakeRunner(), now: NOW, log: () => {},
  });
  assert.equal(readAddons(addonsPath).funkwhale.env.FUNKWHALE_URL, "http://127.0.0.1:8600");

  const r = await undoMigration({ crowHome, ids: ["funkwhale"], mcpAddonsPath: addonsPath, now: () => new Date("2026-04-05T06:07:08Z"), log: () => {} });
  assert.deepEqual(r.restored, ["funkwhale"]);
  assert.deepEqual(readAddons(addonsPath).funkwhale, original);
});

test("the backup folder is 0700, its files 0600, and mcp-addons.json stays 0600", async (t) => {
  const root = scratch(t, "modes");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  writeAddons(addonsPath, { acme: { command: "node", args: ["server/index.js"] } });

  await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });
  const dir = join(crowHome, "addon-walls-migrate");
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, `acme-${STAMP}.json`)), 0o600);
  assert.equal(mode(addonsPath), 0o600);

  const record = JSON.parse(readFileSync(join(dir, `acme-${STAMP}.json`), "utf8"));
  assert.equal(record.v, 1);
  assert.equal(record.id, "acme");
  assert.equal(record.kind, "migrate");
  assert.equal(record.how, "symlink");
  assert.equal(record.source, source);
  assert.equal(record.linkName, `acme.linked-${STAMP}`);
  assert.equal(record.linkTarget, source);
  assert.deepEqual(record.entry, { command: "node", args: ["server/index.js"] });
});

// ── the CLI ─────────────────────────────────────────────────────────────────

function cliEnv(crowHome, dataDir, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CROW_")) env[k] = v;
  return { ...env, HOME: dirname(crowHome), CROW_HOME: crowHome, CROW_DATA_DIR: dataDir, ...extra };
}

test("CLI --undo restores the add-on, and a forward run with the walls off changes nothing", async (t) => {
  const root = scratch(t, "cli");
  const { crowHome, dataDir, addonsPath, appRoot } = makeHome(root);
  const source = makeSource(root, "acme");
  linkBundle(crowHome, "acme", source);
  const original = { command: "node", args: ["server/index.js"] };
  writeAddons(addonsPath, { acme: original });
  await migrateLinkedAddons({
    crowHome, appRoot, dataDir, mcpAddonsPath: addonsPath, env: WALLED, selfNames: NO_SELF, runner: fakeRunner(), now: NOW, log: () => {},
  });

  const undo = spawnSync(process.execPath, [MODULE, "--undo", "acme"], {
    env: cliEnv(crowHome, dataDir), encoding: "utf8", timeout: 60_000,
  });
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(lstatSync(join(crowHome, "bundles", "acme")).isSymbolicLink(), true);
  assert.deepEqual(readAddons(addonsPath).acme, original);

  // Forward, walls off: the line, exit 0, nothing moved.
  const listingBefore = readdirSync(join(crowHome, "bundles")).sort();
  const addonsBefore = readFileSync(addonsPath, "utf8");
  const forward = spawnSync(process.execPath, [MODULE], { env: cliEnv(crowHome, dataDir), encoding: "utf8", timeout: 60_000 });
  assert.equal(forward.status, 0, forward.stderr);
  assert.match(forward.stdout, /walls are off on this computer/);
  assert.equal(readFileSync(addonsPath, "utf8"), addonsBefore);
  assert.deepEqual(readdirSync(join(crowHome, "bundles")).sort(), listingBefore);
});

// ── funkwhale's import change ───────────────────────────────────────────────

test("funkwhale's installed copy resolves app code through CROW_APP_ROOT", async (t) => {
  const root = scratch(t, "fwimport");
  const copy = join(root, "installed", "server");
  cpSync(join(REPO, "bundles", "funkwhale", "server"), copy, { recursive: true });
  assert.ok(existsSync(join(copy, "app-root.js")), "the bundle ships app-root.js");

  const source = readFileSync(join(copy, "server.js"), "utf8");
  assert.match(source, /appImport\("servers\/db\.js"\)/);
  assert.equal(source.includes("../../../servers/"), false, "no repository-relative import is left");

  const env = cliEnv(join(root, "home"), join(root, "data"), { CROW_APP_ROOT: REPO });
  const code = [
    "import { pathToFileURL } from \"node:url\";",
    `const mod = await import(pathToFileURL(${JSON.stringify(join(copy, "app-root.js"))}).href);`,
    "const db = await mod.appImport(\"servers/db.js\");",
    "process.stdout.write(typeof db.createDbClient);",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root, env, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "function");
});