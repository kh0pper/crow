/**
 * Boot safety for the first-party `google-workspace` bundle (PR-1).
 *
 * The live state this guards: an instance whose google-workspace add-on was
 * copied into the Crow home BEFORE the bundle existed here. Its installed copy
 * (`<CROW_HOME>/bundles/google-workspace/`) is only the stub manifest
 * `migrate-linked` writes (`version: "0.0.0-local"`, a `sandbox.files.oauthDir`
 * block, nothing else), and `mcp-addons.json` still holds the old
 * `uvx --from git+…@<sha>` entry with no `installed.json` record.
 *
 * Landing a tracked repo manifest must NOT disturb that install. This proves
 * the boot does none of it:
 *   - `refreshVersionedBundle` never runs for it (the boot's per-bundle loop is
 *     driven by installed.json, and a migrated add-on has no record there), so
 *     the stub manifest is not replaced by the repo's `1.0.0` one;
 *   - `migrate-linked` does not treat the entry as linked (no symlink, no
 *     `cwd`, and a `command` that is either the bare `uvx` of the oldest
 *     installs or the absolute launcher path today's installs have — the
 *     `how: "command"` branch of `linkedSource`), so it rewrites nothing — no
 *     backup folder, no entry change;
 *   - the compose catch-up is docker-only and never reached;
 *   - the boot reports no repair and no error for the id, so no card is raised.
 *
 * Scope of "changes nothing": it is exactly the boot pass above. One thing DOES
 * change when the bundle's registry entry lands, and it is not boot logic: the
 * entry's declared env keys (`server.envKeys` + `env_vars`) turn on the
 * gateway-env passthrough (`declaredPassthrough` in servers/gateway/addon-env.js,
 * spread into the child's environment by `addonStdioEnv` in
 * servers/gateway/proxy.js). So a gateway whose OWN environment holds
 * GOOGLE_BIGQUERY_PROJECT, GDOCS_DEFAULT_FONT or GWS_FORMS_SHIM_SCRIPT_ID now
 * hands those values to the running (unwalled) child as well — values that
 * reached it as undefined before. Nothing else about the install moves: no file
 * in the Crow home is written, and no add-on is restarted. The test after the
 * loop documents that passthrough with a scratch environment.
 *
 * A sibling bundle IS in installed.json and IS repaired in the same pass, which
 * is what makes "nothing happened to google-workspace" mean something.
 *
 * The last test records a separate rule, unchanged here: on a walls-on host the
 * next SPAWN is refused ("its installed files changed; reinstall it to wall it")
 * because the stub's sandbox block differs from the repo's. That is the wall's
 * own rule, not boot logic, and is not touched here — the migration that
 * replaces the stub with the real install is a later PR; until then such a host
 * stays unwalled (walls are off by default).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dirname, "..");
/** The 40-hex commit an old `uvx --from git+…@<sha>` entry pins. */
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** What migrate-linked leaves behind when the source has no manifest of its own. */
const STUB = {
  id: "google-workspace",
  name: "google-workspace",
  type: "mcp-server",
  version: "0.0.0-local",
  sandbox: { files: { oauthDir: "env:GOOGLE_TOKEN_FILE" } },
};
const OLD_ENTRY = {
  command: "uvx",
  args: ["--from", `git+https://github.com/example/google-workspace-mcp@${SHA}`, "google-workspace-mcp"],
  env: {
    GOOGLE_CREDENTIALS_FILE: "/home/alex/.config/google-workspace-mcp/credentials.json",
    GOOGLE_TOKEN_FILE: "/home/alex/.config/google-workspace-mcp/token.json",
  },
};

let CROW_HOME;
let repoRoot;
let launcherPath;
let repairInstalledBundleAssets;
let profileFor;
let addonStdioEnv;

const put = (root, rel, text) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const readAt = (root, rel) => readFileSync(join(root, rel), "utf8");

/**
 * The live entry's own shape today: `command` is an ABSOLUTE launcher path
 * (something like ~/.local/bin/uvx), not a bare `uvx` looked up on PATH. That is
 * a different branch of `linkedSource` in scripts/addon-sandbox/migrate-linked.mjs,
 * so it is exercised on its own: the launcher exists but sits outside the
 * checkout's `bundles/google-workspace`, which is what keeps the entry unlinked.
 */
const absoluteEntry = () => ({ ...OLD_ENTRY, command: launcherPath });

before(async () => {
  CROW_HOME = mkdtempSync(join(tmpdir(), "gws-boot-home-"));
  process.env.CROW_HOME = CROW_HOME;
  repoRoot = mkdtempSync(join(tmpdir(), "gws-boot-repo-"));

  // A scratch absolute launcher for the absolute-command entry variant. Never a
  // real home path, and never inside the checkout's own bundles/google-workspace
  // (a launcher in there is the ONE thing migrate-linked does copy).
  launcherPath = join(repoRoot, "scratch-bin", "uvx");
  put(repoRoot, "scratch-bin/uvx", "#!/bin/sh\nexit 0\n");

  // The repo's real bundle manifest is the thing that must change nothing.
  const realManifest = JSON.parse(readFileSync(join(REPO, "bundles", "google-workspace", "manifest.json"), "utf8"));
  assert.notEqual(realManifest.version, STUB.version, "the repo manifest ships a different version than the stub");
  put(repoRoot, "google-workspace/manifest.json", `${JSON.stringify(realManifest, null, 2)}\n`);

  // A sibling first-party bundle that IS installed and needs a repair, so the
  // per-bundle loop really runs in the same pass.
  put(repoRoot, "overlay/manifest.json", `${JSON.stringify({
    id: "overlay", name: "Overlay", description: "d", type: "bundle", category: "misc", version: "1.0.0",
  }, null, 2)}\n`);
  put(repoRoot, "overlay/panel/overlay.js", "// panel\n");

  // App modules read CROW_HOME at import time: import them only after it is set.
  ({ repairInstalledBundleAssets } = await import("../servers/gateway/routes/bundles.js"));
  ({ addonStdioEnv } = await import("../servers/gateway/proxy.js"));
  ({ profileFor } = await import("../scripts/addon-sandbox/profile.mjs"));
});

after(() => {
  delete process.env.CROW_HOME;
});

/** Put the Crow home back into the live state, byte for byte, and return it. */
function fixture(entry = OLD_ENTRY) {
  const stubText = `${JSON.stringify(STUB, null, 2)}\n`;
  const entryText = `${JSON.stringify({ "google-workspace": entry }, null, 2)}\n`;
  const installedText = `${JSON.stringify([{ id: "overlay" }], null, 2)}\n`;
  put(CROW_HOME, "bundles/google-workspace/manifest.json", stubText);
  mkdirSync(join(CROW_HOME, "bundles", "overlay"), { recursive: true });
  put(CROW_HOME, "mcp-addons.json", entryText);
  put(CROW_HOME, "installed.json", installedText);
  return { stubText, entryText, installedText };
}

const noCardFor = (out) => !out.errors.some((e) => String(e?.id || "").includes("google-workspace"))
  && !out.repaired.some((line) => String(line).includes("google-workspace"));

describe("boot leaves a pre-existing google-workspace install alone", () => {
  // Both entry shapes the live population has: the bare `uvx` of the oldest
  // installs, and the absolute launcher path today's installs get. The second
  // one is what exercises the `isAbsolute(entry.command)` branch of
  // migrate-linked's `linkedSource` (a launcher outside the checkout's bundle
  // folder is not a link, so nothing is copied).
  const ENTRY_SHAPES = [
    ["bare `uvx` entry", () => OLD_ENTRY],
    ["absolute launcher entry", absoluteEntry],
  ];
  for (const [envLabel, env] of [
    ["walls off (the shipping default)", {}],
    ["walls on", { CROW_ADDON_WALLS_DEFAULT: "walled" }],
  ]) {
    for (const [entryLabel, entryOf] of ENTRY_SHAPES) {
      test(`${envLabel}, ${entryLabel}: no refresh, no migration, no card, entry untouched`, async () => {
        const wanted = entryOf();
        const baseline = fixture(wanted);
        const warnings = [];
        const out = await repairInstalledBundleAssets({
          appBundles: repoRoot,
          env,
          log: (m) => warnings.push(String(m)),
        });

        // 1. The installed copy is still the stub: refreshVersionedBundle never saw it.
        assert.equal(readAt(CROW_HOME, "bundles/google-workspace/manifest.json"), baseline.stubText,
          "the installed stub manifest is byte-identical (not replaced by the repo's version)");
        assert.equal(JSON.parse(readAt(CROW_HOME, "bundles/google-workspace/manifest.json")).version, "0.0.0-local");

        // 2. The registry entry is untouched: still the old uvx git ref, nothing pinned.
        assert.equal(readAt(CROW_HOME, "mcp-addons.json"), baseline.entryText, "mcp-addons.json is byte-identical");
        const entry = JSON.parse(readAt(CROW_HOME, "mcp-addons.json"))["google-workspace"];
        assert.equal(entry.command, wanted.command);
        assert.equal(entry.command_sha256, undefined, "nothing re-pinned it");
        assert.deepEqual(entry.env, OLD_ENTRY.env, "its two owner paths are untouched");

        // 3. No record was invented for it (an installed.json entry is what puts a
        //    bundle into the boot's per-bundle loop, and so into the refresh). The
        //    file itself may gain the VERSION of the bundle this pass processed.
        const installed = JSON.parse(readAt(CROW_HOME, "installed.json"));
        assert.deepEqual(installed.map((r) => r?.id), ["overlay"], "no google-workspace record was added");

        // 4. No card: the boot reports no repair and no error for the id, says nothing
        //    about it on its log line, and the alert spool (a path that must not write
        //    crow.db uses it) stays empty.
        assert.ok(noCardFor(out), JSON.stringify({ repaired: out.repaired, errors: out.errors }));
        assert.ok(!warnings.some((line) => line.includes("google-workspace")),
          "nothing about it was logged as refreshed or skipped: " + JSON.stringify(warnings));
        assert.equal(existsSync(join(CROW_HOME, "alerts", "pending")), false, "no alert was spooled");

        // 5. Nothing was even ATTEMPTED: migrate-linked writes its backup first.
        assert.equal(existsSync(join(CROW_HOME, "addon-walls-migrate")), false,
          "no migration backup: the entry was never treated as a linked add-on");

        // 6. ...while the same pass did its ordinary work on the real installed
        //    bundle, so "nothing happened" is not "the loop never ran".
        assert.ok(out.repaired.some((line) => String(line).startsWith("overlay: ")),
          "the installed sibling bundle was repaired in this pass: " + JSON.stringify(out.repaired));
        assert.ok(existsSync(join(CROW_HOME, "bundles", "overlay", "panel", "overlay.js")), "and its panel was copied");
      });
    }
  }
});

test("what DOES change is the gateway-env passthrough for the keys the entry declares (not a boot write)", () => {
  // The one real behaviour change of publishing the bundle (see the header):
  // declaredPassthrough hands a child any key its registry entry declares
  // (server.envKeys + env_vars) that is present in the GATEWAY's environment.
  // These three reached the child as undefined before; now they arrive.
  const base = {
    GOOGLE_BIGQUERY_PROJECT: "scratch-project",
    GDOCS_DEFAULT_FONT: "Scratch Font",
    GWS_FORMS_SHIM_SCRIPT_ID: "scratch-script-id",
    GOOGLE_OAUTH_LOCAL_PORT: "8090",
    SCRATCH_UNDECLARED_KEY: "never",
  };
  const childEnv = addonStdioEnv({ env: {} }, base, "google-workspace");
  assert.equal(childEnv.GOOGLE_BIGQUERY_PROJECT, "scratch-project", "a declared key reaches the child from the gateway's env");
  assert.equal(childEnv.GDOCS_DEFAULT_FONT, "Scratch Font");
  assert.equal(childEnv.GWS_FORMS_SHIM_SCRIPT_ID, "scratch-script-id");
  // Undeclared names are not a passthrough, whatever the gateway holds.
  assert.equal(childEnv.SCRATCH_UNDECLARED_KEY, undefined, "only the entry's declared keys pass through");
  // GOOGLE_OAUTH_LOCAL_PORT is deliberately not declared: only the one-time
  // `google-workspace-mcp-authorize` CLI reads it, in the owner's own shell, and
  // the server path never calls authorize() — the gateway has nothing to hand on.
  assert.equal(childEnv.GOOGLE_OAUTH_LOCAL_PORT, undefined);
  const repoManifest = JSON.parse(readFileSync(join(REPO, "bundles", "google-workspace", "manifest.json"), "utf8"));
  assert.ok(!(repoManifest.server?.envKeys || []).includes("GOOGLE_OAUTH_LOCAL_PORT"), "so the manifest does not declare it");
  assert.ok(!(repoManifest.env_vars || []).some((v) => v?.name === "GOOGLE_OAUTH_LOCAL_PORT"),
    "and not as an env_var either: the server path reads no such name");
});

test("a walls-on host refuses the SPAWN of that install until its copy matches Crow's (unchanged rule, not boot)", () => {
  const stubText = `${JSON.stringify(STUB, null, 2)}\n`;
  put(CROW_HOME, "bundles/google-workspace/manifest.json", stubText);
  const profile = profileFor({
    id: "google-workspace",
    entry: {},
    appBundlesDir: repoRoot,
    installedBundlesDir: join(CROW_HOME, "bundles"),
    pastDefaultsAll: {},
  });
  // The stub's sandbox block (`files.oauthDir` only) differs from the repo's
  // (`network: "internet"` + the same oauthDir), which is the wall's own
  // "installed files changed" rule (scripts/addon-sandbox/gateway-wall.mjs).
  assert.ok(profile.refused.some((r) => r?.what === "installed manifest differs"),
    "the spawn is refused on a walls-on host: " + JSON.stringify(profile.refused));
  // The repo copy is still what policy is read from, so the grant itself is
  // right the moment the installed copy catches up.
  assert.deepEqual(profile.files.oauthDir, null, "no owner value in a manifest-only profile");
  assert.equal(profile.network.internet, true, "the repo copy's network line");
});