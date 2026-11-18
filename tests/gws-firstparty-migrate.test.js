/**
 * Moving the google-workspace add-on onto the first-party bundle
 * (scripts/addon-sandbox/migrate-gws-firstparty.mjs), and its --undo.
 *
 * Scratch Crow home and scratch repo root under os.tmpdir(): the repo root holds
 * its own minimal bundles/google-workspace (so this test pins the shape it
 * expects instead of following the real manifest), a fake uv/uvx pair beside each
 * other, and a sibling installed bundle so "nothing happened to google-workspace"
 * is asserted against a boot pass that really ran. Nothing here reads ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ── the scratch world (before any project module is imported: they bind paths) ─

const HOME = mkdtempSync(join(tmpdir(), "gws-firstparty-home-"));
const SCRATCH_REPO = mkdtempSync(join(tmpdir(), "gws-firstparty-repo-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");

const NOW = () => new Date("2026-01-02T03:04:05Z");
const NOW_ISO = "2026-01-02T03:04:05.000Z";
const STAMP = "20260102T030405Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const BUNDLES = join(SCRATCH_REPO, "bundles");
const LAUNCHER_DIR = join(SCRATCH_REPO, "scratch-bin");
const UV = join(LAUNCHER_DIR, "uv");
const UVX = join(LAUNCHER_DIR, "uvx");

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const mode = (p) => statSync(p).mode & 0o777;

function put(root, rel, text, fileMode = 0o644) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  chmodSync(p, fileMode);
  return p;
}
const readAt = (root, rel) => readFileSync(join(root, rel), "utf8");

/** The repo bundle this migration copies: minimal, but shaped like the real one. */
const MANIFEST = {
  id: "google-workspace",
  name: "Google Workspace",
  version: "1.2.0",
  type: "bundle",
  server: {
    command: "uv",
    args: ["run", "--quiet", "--frozen", "google-workspace-mcp"],
    envKeys: [
      "GOOGLE_CREDENTIALS_FILE", "GOOGLE_TOKEN_FILE", "GWS_FILES_DIR", "GMAIL_SEND_TO_SELF_ALLOWLIST",
      "GWS_OUTBOUND_GUARD", "GWS_OUTBOUND_ALLOWLIST",
    ],
  },
  requires: { env: ["GOOGLE_CREDENTIALS_FILE", "GOOGLE_TOKEN_FILE"], bins: ["uv"] },
  env_vars: [
    { name: "GOOGLE_CREDENTIALS_FILE", required: true, path: true },
    { name: "GOOGLE_TOKEN_FILE", required: true, path: true },
    { name: "GWS_FILES_DIR", required: false, path: true },
    { name: "GMAIL_SEND_TO_SELF_ALLOWLIST", required: false, advanced: true },
    { name: "GWS_OUTBOUND_GUARD", required: false, advanced: true },
    { name: "GWS_OUTBOUND_ALLOWLIST", required: false, advanced: true },
  ],
  sandbox: {
    network: "internet",
    files: { write: ["env:GWS_FILES_DIR"], oauthDir: "env:GOOGLE_TOKEN_FILE" },
  },
};

/** What migrate-linked's stub leaves in the installed folder. */
const STUB = {
  id: "google-workspace",
  name: "google-workspace",
  type: "mcp-server",
  version: "0.0.0-local",
  sandbox: { files: { oauthDir: "env:GOOGLE_TOKEN_FILE" } },
};

/** The old launch entry: uvx, a git commit pin, the owner's three values. */
const OLD_ENTRY = () => ({
  command: UVX,
  args: ["--from", `git+https://github.com/example/google-workspace-mcp@${SHA}`, "google-workspace-mcp"],
  command_sha256: sha256(UVX),
  env: {
    GMAIL_SEND_TO_SELF_ALLOWLIST: "alex@example.com",
    GOOGLE_CREDENTIALS_FILE: "/home/alex/.config/google-workspace-mcp/credentials.json",
    GOOGLE_TOKEN_FILE: "/home/alex/.config/google-workspace-mcp/token.json",
  },
});

const SIBLING = { id: "overlay", type: "bundle", version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" };

put(BUNDLES, "google-workspace/manifest.json", `${JSON.stringify(MANIFEST, null, 2)}\n`);
put(BUNDLES, "google-workspace/pyproject.toml", "[project]\nname = \"google-workspace-mcp\"\n");
put(BUNDLES, "google-workspace/uv.lock", "version = 1\n");
// A package folder no version-refresh list names: only a whole-tree install copy has it.
put(BUNDLES, "google-workspace/google_workspace_mcp/__init__.py", "# package\n");
// A sibling first-party bundle that IS installed, so the boot pass has real work to do.
put(BUNDLES, "overlay/manifest.json", `${JSON.stringify({ id: "overlay", name: "Overlay", type: "bundle", version: "1.0.0" }, null, 2)}\n`);
put(BUNDLES, "overlay/panel/overlay.js", "// panel\n");
// A fake launcher pair: uv sits next to uvx, exactly like ~/.local/bin on a real host.
put(LAUNCHER_DIR, "uv", "#!/bin/sh\nexit 0\n", 0o755);
put(LAUNCHER_DIR, "uvx", "#!/bin/sh\nexit 0\n", 0o755);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(SCRATCH_REPO, { recursive: true, force: true });
  delete process.env.CROW_HOME;
  delete process.env.CROW_DATA_DIR;
});

// Project modules read CROW_HOME at import time: import them only after it is set.
const { migrateGwsFirstparty, undoGwsFirstparty } = await import("../scripts/addon-sandbox/migrate-gws-firstparty.mjs");
const { repairInstalledBundleAssets } = await import("../servers/gateway/routes/bundles.js");
const { addonLauncherStatus, checkLauncherArgs, resolveAddonCommand } = await import("../servers/shared/resolve-command.js");
const { addonWallMode } = await import("../scripts/addon-sandbox/spawn.mjs");
const { profileFor } = await import("../scripts/addon-sandbox/profile.mjs");

// ── the fixture ─────────────────────────────────────────────────────────────

const ADDRESS = join(HOME, "mcp-addons.json");
const INSTALLED = join(HOME, "installed.json");
const DEST = join(HOME, "bundles", "google-workspace");
const BACKUP_ROOT = join(HOME, "addon-walls-migrate");
const STUB_COPY = join(HOME, "bundles", `google-workspace.pre-firstparty-${STAMP}`);
const BACKUP_DIR = join(BACKUP_ROOT, `google-workspace-${STAMP}`);

/**
 * Put the home back into the live state, byte for byte, and return it. Both JSON
 * files end in a newline on purpose: --undo must come back byte-identical.
 */
function fixture({ entry = OLD_ENTRY(), installed = [SIBLING], withStub = true } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, "bundles"), { recursive: true });
  const stubText = `${JSON.stringify(STUB, null, 2)}\n`;
  if (withStub) put(HOME, "bundles/google-workspace/manifest.json", stubText);
  const addonsText = `${JSON.stringify({ "google-workspace": entry }, null, 2)}\n`;
  put(HOME, "mcp-addons.json", addonsText, 0o600);
  const installedText = `${JSON.stringify(installed, null, 2)}\n`;
  put(HOME, "installed.json", installedText, 0o644);
  return { stubText, addonsText, installedText, entry };
}

const runMigration = (over = {}) => migrateGwsFirstparty({
  crowHome: HOME, repoRoot: SCRATCH_REPO, uvPath: UV, env: {}, now: NOW, log: () => {}, ...over,
});

/** Every path in the home with a file's sha256, so "nothing changed" is checkable. */
function homeTree(root = HOME) {
  const out = [];
  const walk = (dir, prefix) => {
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) { out.push(`${rel}/`); walk(abs, rel); continue; }
      if (st.isSymbolicLink()) { out.push(`${rel} -> link`); continue; }
      out.push(`${rel} ${sha256(abs)} ${(st.mode & 0o777).toString(8)}`);
    }
  };
  walk(root, "");
  return out;
}

const entryNow = () => JSON.parse(readAt(HOME, "mcp-addons.json"))["google-workspace"];
const installedNow = () => JSON.parse(readAt(HOME, "installed.json"));

// ── the migration ───────────────────────────────────────────────────────────

test("a legacy uvx/git+ entry over the 0.0.0-local stub becomes the first-party launch", async () => {
  const baseline = fixture();

  const r = await runMigration();
  assert.equal(r.status, "migrated", r.reason);
  assert.equal(r.stamp, STAMP);

  const entry = entryNow();
  // The launch: the absolute uv beside the entry's own uvx, running the installed copy.
  assert.equal(entry.command, UV);
  assert.deepEqual(entry.args, MANIFEST.server.args, "args come from the repo manifest");
  assert.equal(JSON.stringify(entry).includes("git+"), false, "the git source is gone");

  // The pin is the shared launcherPin's (never a hand-rolled hash), and the
  // gateway's own checker accepts it at spawn.
  assert.equal(entry.command_sha256, sha256(UV));
  assert.equal(resolveAddonCommand(entry.command, { sha256: entry.command_sha256, cwd: DEST }).missing, false);
  assert.equal(checkLauncherArgs(entry.command, entry.args), null);
  assert.equal(addonLauncherStatus(entry, DEST).ok, true);

  // The env: every existing key/value kept, the two uv settings added, nothing else.
  for (const [key, value] of Object.entries(baseline.entry.env)) {
    assert.equal(entry.env[key], value, `${key} is untouched`);
  }
  assert.equal(entry.env.UV_NO_CACHE, "1");
  assert.equal(entry.env.UV_PROJECT_ENVIRONMENT, join(HOME, "data", "google-workspace", ".venv"));
  assert.equal(entry.env.GWS_FILES_DIR, undefined, "the files folder stays the wall window's job");
  assert.equal(entry.env.GWS_OUTBOUND_GUARD, undefined, "the outbound guard is NOT turned on");
  assert.equal(entry.env.GWS_OUTBOUND_ALLOWLIST, undefined);
  assert.deepEqual(entry.ownerSet, ["GMAIL_SEND_TO_SELF_ALLOWLIST", "GOOGLE_CREDENTIALS_FILE", "GOOGLE_TOKEN_FILE"]);
  assert.equal(mode(ADDRESS), 0o600, "the entry file keeps its private mode");

  // installed.json: the record an install writes, appended after the sibling.
  assert.deepEqual(installedNow(), [
    SIBLING,
    { id: "google-workspace", type: "bundle", version: "1.2.0", installedAt: NOW_ISO },
  ]);

  // The stub is backed up as it was, and the repo bundle is copied in whole —
  // including the package folder no version-refresh list names.
  assert.equal(readAt(STUB_COPY, "manifest.json"), baseline.stubText, "the stub is byte-identical in its copy");
  assert.deepEqual(readdirSync(STUB_COPY), ["manifest.json"]);
  assert.equal(readAt(DEST, "manifest.json"), readAt(BUNDLES, "google-workspace/manifest.json"));
  assert.equal(readAt(DEST, "google_workspace_mcp/__init__.py"), "# package\n");
  assert.equal(readAt(DEST, "uv.lock"), "version = 1\n");
  assert.equal(lstatSync(DEST).isSymbolicLink(), false, "a plain folder, never a link into the checkout");

  // The backup folder: what it read, and what it wrote.
  assert.ok(existsSync(join(BACKUP_DIR, "backup.json")));
  assert.ok(existsSync(join(BACKUP_DIR, "written.json")));
  const backup = JSON.parse(readAt(BACKUP_DIR, "backup.json"));
  assert.deepEqual(backup.entry, baseline.entry);
  assert.equal(backup.addons.text, baseline.addonsText);
  assert.equal(backup.installed.text, baseline.installedText);
  assert.equal(backup.stubName, `google-workspace.pre-firstparty-${STAMP}`);

  // Nothing about the wall moved, and the data folder the entry points uv at exists.
  assert.equal(existsSync(join(HOME, "addon-walls.json")), false, "no wall choice was written");
  assert.ok(existsSync(join(HOME, "data", "google-workspace")));
});

test("a second run is a no-op: no new backup, both files byte-identical", async () => {
  fixture();
  assert.equal((await runMigration()).status, "migrated");

  const addons = readAt(HOME, "mcp-addons.json");
  const installed = readAt(HOME, "installed.json");
  const tree = homeTree();

  const again = await runMigration({ now: () => new Date("2026-02-03T04:05:06Z") });
  assert.equal(again.status, "already-migrated");
  assert.equal(readAt(HOME, "mcp-addons.json"), addons, "mcp-addons.json is byte-identical");
  assert.equal(readAt(HOME, "installed.json"), installed, "installed.json is byte-identical");
  assert.deepEqual(homeTree(), tree, "no file changed and no folder appeared");
  assert.deepEqual(readdirSync(BACKUP_ROOT), [`google-workspace-${STAMP}`], "no second backup");
});

test("--undo restores the entry, the installed folder and installed.json byte-for-byte", async () => {
  const baseline = fixture();
  assert.equal((await runMigration()).status, "migrated");

  const r = await undoGwsFirstparty({ crowHome: HOME, log: () => {} });
  assert.equal(r.status, "restored", r.reason);

  assert.equal(readAt(HOME, "mcp-addons.json"), baseline.addonsText, "mcp-addons.json is byte-identical");
  assert.equal(readAt(HOME, "installed.json"), baseline.installedText, "installed.json is byte-identical");
  assert.equal(readAt(DEST, "manifest.json"), baseline.stubText, "the stub is byte-identical");
  assert.deepEqual(readdirSync(DEST), ["manifest.json"], "the migrated copy is gone again");
  assert.equal(mode(ADDRESS), 0o600);
  assert.deepEqual(entryNow(), baseline.entry);

  // Consumed, never deleted: the backup and the folder copy both stay.
  assert.ok(existsSync(`${BACKUP_DIR}.undone`), "the backup is renamed, not removed");
  assert.equal(readAt(STUB_COPY, "manifest.json"), baseline.stubText, "the folder copy stays");
  // A second undo has nothing live left.
  assert.equal((await undoGwsFirstparty({ crowHome: HOME, log: () => {} })).status, "no-backup");
});

test("--undo refuses when the home changed since the migration, and --force restores anyway", async () => {
  const baseline = fixture();
  assert.equal((await runMigration()).status, "migrated");

  // The wall window (or the owner in Extensions) edits the entry afterwards.
  const doc = JSON.parse(readAt(HOME, "mcp-addons.json"));
  doc["google-workspace"].env.GWS_FILES_DIR = "/home/alex/files";
  put(HOME, "mcp-addons.json", `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  const edited = readAt(HOME, "mcp-addons.json");

  const refused = await undoGwsFirstparty({ crowHome: HOME, log: () => {} });
  assert.equal(refused.status, "refused");
  assert.ok(refused.diffs.some((d) => d.includes("mcp-addons.json")), JSON.stringify(refused.diffs));
  assert.equal(readAt(HOME, "mcp-addons.json"), edited, "nothing was done");
  assert.ok(existsSync(BACKUP_DIR), "the backup is still live");

  const forced = await undoGwsFirstparty({ crowHome: HOME, force: true, log: () => {} });
  assert.equal(forced.status, "restored", forced.reason);
  // Forced: the entry key and this add-on's record only, straight from the backup.
  assert.deepEqual(entryNow(), baseline.entry);
  assert.deepEqual(installedNow().map((r) => r.id), [SIBLING.id]);
  assert.equal(readAt(DEST, "manifest.json"), baseline.stubText);
});

test("--dry-run prints the plan and changes nothing at all", async () => {
  fixture();
  const before = homeTree();
  const lines = [];

  const r = await runMigration({ dryRun: true, log: (line) => lines.push(String(line)) });
  assert.equal(r.status, "dry-run");
  assert.deepEqual(homeTree(), before, "not one byte changed");
  assert.equal(existsSync(BACKUP_ROOT), false, "no backup folder");
  assert.equal(existsSync(STUB_COPY), false, "no folder copy");

  const text = lines.join("\n");
  assert.match(text, /plan \(dry run/);
  assert.match(text, /installed\.json \+=/);
  assert.ok(text.includes(UV), "the plan names the uv it would launch");
  assert.ok(text.includes("--frozen"), "and the args from the manifest");
  assert.ok(text.includes(`--undo ${STAMP}`), "and how to undo");
});

test("an entry without GOOGLE_TOKEN_FILE is refused, and nothing changes", async () => {
  const entry = OLD_ENTRY();
  delete entry.env.GOOGLE_TOKEN_FILE;
  fixture({ entry });
  const before = homeTree();

  const r = await runMigration();
  assert.equal(r.status, "refused");
  assert.match(r.reason, /GOOGLE_TOKEN_FILE/);
  assert.deepEqual(homeTree(), before, "nothing changed");
});

test("an entry in neither known shape is refused, and nothing changes", async () => {
  fixture({ entry: { command: "uvx", args: ["some-other-package"], env: OLD_ENTRY().env } });
  const before = homeTree();

  const r = await runMigration();
  assert.equal(r.status, "refused");
  assert.match(r.reason, /not the legacy uvx\/git\+ shape/);
  assert.deepEqual(homeTree(), before);
});

test("an installed folder that is neither the stub nor Crow's copy is refused", async () => {
  fixture();
  put(HOME, "bundles/google-workspace/manifest.json", `${JSON.stringify({ ...STUB, version: "0.9.0-branch" }, null, 2)}\n`);
  const before = homeTree();

  const r = await runMigration();
  assert.equal(r.status, "refused");
  assert.match(r.reason, /neither the 0\.0\.0-local stub/);
  assert.deepEqual(homeTree(), before);
});

test("uv that cannot be found is refused before anything is written", async () => {
  // A bare `uvx` has no launcher folder to look beside, so only PATH could answer.
  fixture({ entry: { ...OLD_ENTRY(), command: "uvx" } });
  const before = homeTree();

  const r = await migrateGwsFirstparty({
    crowHome: HOME, repoRoot: SCRATCH_REPO, env: { PATH: "" }, now: NOW, log: () => {},
  });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /uv was not found/);
  assert.deepEqual(homeTree(), before);
});

test("a later-window entry keeps its own keys, claimed as the owner's; the guard stays as it was", async () => {
  const entry = OLD_ENTRY();
  entry.env.GWS_FILES_DIR = "/home/alex/files";
  entry.env.GWS_OUTBOUND_GUARD = "1";
  fixture({ entry });

  assert.equal((await runMigration()).status, "migrated");
  const now = entryNow();
  assert.equal(now.env.GWS_FILES_DIR, "/home/alex/files", "the files folder is not touched");
  assert.equal(now.env.GWS_OUTBOUND_GUARD, "1");
  assert.deepEqual(now.ownerSet, [
    "GMAIL_SEND_TO_SELF_ALLOWLIST", "GOOGLE_CREDENTIALS_FILE", "GOOGLE_TOKEN_FILE",
    "GWS_FILES_DIR", "GWS_OUTBOUND_GUARD",
  ]);
});

// ── the boot after the migration ────────────────────────────────────────────

test("the boot after the migration raises no card, refreshes nothing, and leaves it unwalled", async () => {
  fixture();
  assert.equal((await runMigration()).status, "migrated");

  const repairedBefore = readAt(HOME, "installed.json");
  const warnings = [];
  const out = await repairInstalledBundleAssets({
    appBundles: BUNDLES,
    env: {},
    log: (line) => warnings.push(String(line)),
  });

  // The pass ran (the sibling bundle was repaired), and said nothing about ours.
  assert.ok(out.repaired.some((line) => String(line).startsWith("overlay: ")), JSON.stringify(out.repaired));
  assert.ok(!out.repaired.some((line) => String(line).includes("google-workspace")), JSON.stringify(out.repaired));
  assert.ok(!out.errors.some((e) => String(e?.id || "").includes("google-workspace")), JSON.stringify(out.errors));
  assert.ok(!warnings.some((line) => line.includes("google-workspace")), "nothing was logged about it");
  assert.equal(existsSync(join(HOME, "alerts", "pending")), false, "no alert was spooled");
  assert.equal(readAt(HOME, "installed.json"), repairedBefore, "the record still carries 1.2.0");
  assert.equal(readAt(DEST, "manifest.json"), readAt(BUNDLES, "google-workspace/manifest.json"), "the copy is unchanged");

  // Still unwalled: the migration changes no wall mode (walls are off by default here).
  assert.equal(addonWallMode({ id: "google-workspace", gatewayEnv: {}, crowHome: HOME }).mode, "unwalled");
  assert.equal(existsSync(join(HOME, "addon-walls.json")), false);

  // And the wall's own reading of the copy is clean now: the stub's sandbox block no
  // longer differs from the repo's, and the token folder is the owner's own grant.
  const profile = profileFor({
    id: "google-workspace",
    entry: entryNow(),
    appBundlesDir: BUNDLES,
    installedBundlesDir: join(HOME, "bundles"),
    pastDefaultsAll: {},
  });
  assert.deepEqual(profile.refused.filter((r) => r?.what === "installed manifest differs"), [],
    "the installed copy is Crow's copy");
  assert.equal(profile.files.oauthDir?.path, OLD_ENTRY().env.GOOGLE_TOKEN_FILE, "the token folder, owner-typed");
  assert.equal(profile.network.internet, true);
});