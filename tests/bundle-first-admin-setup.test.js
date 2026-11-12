/**
 * N3-4 phase 2a — Crow creates an app's first admin ITSELF, and the "Finish <app>'s
 * setup now" card clears once the keychain holds that app's admin login.
 *
 * What this file covers, in order:
 *   1. the contract for `firstAdmin: { mode: "crow", via: "setup", ... }`,
 *   2. the setup-script protocol on stdin (spawnGroup `input`, and stdin still closed
 *      when no input is given),
 *   3. runFirstAdminSetup over every exit code, every keychain failure and the seams —
 *      including the bundle's mcp-addons.json entry (an MCP child reads THAT, never the
 *      bundle's .env) and the report that a restart is needed for it, which never starts
 *      the restart itself,
 *   4. the same function against a REAL bash script in a temp bundle dir,
 *   5. pendingFirstAdminNotices with `adminSaved` / `autoResults`,
 *   6. the bell for a crow/setup bundle (silent on ok, once on anything else),
 *   7. the two routes (owner-only, installed-only, 400 for a non-setup app, 409 while a
 *      run is in flight — the install path's run included — `needs_restart` when the MCP
 *      entry was written and NO gateway restart started by either route, and the real
 *      keychain write),
 *   8. the card: the Set-it-up button, the password field and the escaping.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR before anything Crow-side is imported, so this file
 * never reads or writes the operator's ~/.crow. No docker, no real app.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-fa-setup-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const TMP_BUNDLES = mkdtempSync(join(tmpdir(), "crow-fa-setup-src-"));
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: TMP_DATA },
  stdio: "pipe",
  cwd: REPO,
});

const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const { spawnGroup } = await import("../servers/gateway/bundle-lifecycle.js");
const {
  runFirstAdminSetup,
  saveFirstAdminLogin,
  firstAdminSetupPlan,
  firstAdminResultMessage,
  writeBundleEnv,
  tryBeginFirstAdminSetup,
  endFirstAdminSetup,
  KEYCHAIN_UNOPENABLE,
  PASSWORD_NOT_KEPT,
  FIRST_ADMIN_UNPROVEN,
} = await import("../servers/gateway/bundle-first-admin-setup.js");
const {
  pendingFirstAdminNotices,
  notifyFirstAdmin,
  firstAdminBody,
  firstAdminSavedKey,
  firstAdminAutoResults,
  writeFirstAdminAutoResult,
  firstAdminAutoKey,
  FIRST_ADMIN_SAVED_KEY,
} = await import("../servers/gateway/bundle-first-admin.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
const { extensionsClientJS } = await import("../servers/gateway/dashboard/panels/extensions/client.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
const express = (await import("express")).default;
const B = await import("../servers/gateway/routes/bundles.js");

B._setAppBundlesForTest(TMP_BUNDLES);

after(() => {
  B._setOwnerCheckForTest(null);
  B._setFirstAdminSetupDepsForTest(null);
  for (const d of [TMP_HOME, TMP_BUNDLES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const INSTALL = "2026-11-01T10:00:00.000Z";
const PASSPHRASE = "generated-Secret_1";

/** The manifest shape this phase introduces. */
const SETUP_MANIFEST = {
  id: "frigate",
  name: "Frigate",
  description: "d",
  type: "bundle",
  category: "cameras",
  origin: "official",
  webUI: { port: 8971, path: "/", label: "Frigate" },
  firstAdmin: {
    mode: "crow",
    via: "setup",
    setup: { script: "scripts/first-admin.sh", timeout_s: 30 },
    user: "admin",
    secretEnv: "FRIGATE_PASSWORD",
    userEnv: "FRIGATE_USER",
  },
  env_vars: [{ name: "FRIGATE_PASSWORD", secret: true }, { name: "FRIGATE_USER" }],
};

/** A throwaway bundle dir <root>/<id> with optional files. */
function tmpBundle(id, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "crow-fa-setup-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { root, dir };
}

/**
 * The two folders one setup run uses: Crow's own (reviewed) copy of the bundle, which
 * holds the manifest and the script, and the installed copy, which is only the cwd,
 * CROW_BUNDLE_DIR and the .env target.
 */
function bundleDirs(files = {}) {
  const reviewed = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n", ...files });
  const installed = tmpBundle("frigate");
  return { repoDir: reviewed.dir, destDir: installed.dir };
}

const errs = (manifest, dir) => validateManifest(manifest, dir).errors || [];
const okManifest = (manifest, dir) => validateManifest(manifest, dir).ok;
const errText = (manifest, dir) => errs(manifest, dir).join("\n");

// ── 1. the contract ──────────────────────────────────────────────────────────────────

test("contract: mode crow via setup is valid with a script, a user and a secretEnv", () => {
  const { dir } = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  assert.equal(okManifest(SETUP_MANIFEST, dir), true, errText(SETUP_MANIFEST, dir));
  // timeout_s is optional; userEnv too.
  const minimal = {
    ...SETUP_MANIFEST,
    firstAdmin: { mode: "crow", via: "setup", setup: { script: "scripts/first-admin.sh" }, user: "admin", secretEnv: "FRIGATE_PASSWORD" },
  };
  assert.equal(okManifest(minimal, dir), true, errText(minimal, dir));
  // secretEnv does NOT need a generate/keychain env_vars entry: Crow generates it itself.
  const undeclared = { ...minimal, env_vars: [] };
  assert.equal(okManifest(undeclared, dir), true, errText(undeclared, dir));
});

test("contract: setup.script is required, must ship in the bundle, and must be a relative .sh", () => {
  const { dir } = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  const noSetup = { ...SETUP_MANIFEST, firstAdmin: { mode: "crow", via: "setup", user: "admin", secretEnv: "FRIGATE_PASSWORD" } };
  assert.match(errText(noSetup, dir), /needs setup\.script/);
  const missing = {
    ...SETUP_MANIFEST,
    firstAdmin: { ...SETUP_MANIFEST.firstAdmin, setup: { script: "scripts/nope.sh" } },
  };
  assert.match(errText(missing, dir), /setup\.script "scripts\/nope\.sh" not found/);
  for (const bad of ["/abs/first-admin.sh", "../outside.sh", "scripts/first-admin.py", "."]) {
    const m = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, setup: { script: bad } } };
    assert.match(errText(m, dir), /relative \.sh path inside the bundle/, String(bad));
  }
  // An empty string never reaches the contract rule: the schema demands one character.
  const empty = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, setup: { script: "" } } };
  assert.equal(okManifest(empty, dir), false);
  const badTimeout = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, setup: { script: "scripts/first-admin.sh", timeout_s: 6000 } } };
  assert.match(errText(badTimeout, dir), /timeout_s/);
});

test("contract: via setup needs user and secretEnv; user is not a free-floating field", () => {
  const { dir } = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  const noUser = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, user: undefined } };
  assert.match(errText(noUser, dir), /via "setup" needs user/);
  const noSecret = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, secretEnv: undefined } };
  assert.match(errText(noSecret, dir), /via "setup" needs secretEnv/);
  // `user` stays refused everywhere else.
  assert.match(errText({ ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, via: "env", secretEnv: "FRIGATE_PASSWORD" } }, dir), /user is only allowed/);
  // `userEnv` still has to name a declared env var.
  const badUserEnv = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, userEnv: "NOT_DECLARED" } };
  assert.match(errText(badUserEnv, dir), /userEnv must name a declared env_vars entry/);
});

test("contract: via setup refuses Compose's, Docker's and Crow's own env prefixes", () => {
  const { dir } = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  for (const [field, name, prefix] of [
    ["secretEnv", "CROW_PASSWORD", "CROW_"],
    ["secretEnv", "COMPOSE_PROJECT_NAME", "COMPOSE_"],
    ["userEnv", "DOCKER_USER", "DOCKER_"],
  ]) {
    const m = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, [field]: name } };
    assert.match(errText(m, dir), new RegExp(`firstAdmin\\.${field} "${name}" must not start with ${prefix}`), `${field}=${name}`);
  }
});

test("contract: `setup` rides only with via setup, and setup is only a crow mechanism", () => {
  const { dir } = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  const withEnv = {
    ...SETUP_MANIFEST,
    firstAdmin: { mode: "crow", via: "env", secretEnv: "FRIGATE_PASSWORD", setup: { script: "scripts/first-admin.sh" } },
  };
  assert.match(errText(withEnv, dir), /firstAdmin\.setup is only allowed with mode "crow" via "setup"/);
  const onNone = { ...SETUP_MANIFEST, firstAdmin: { mode: "none", setup: { script: "scripts/first-admin.sh" } } };
  assert.equal(okManifest(onNone, dir), false);
});

test("contract: a community bundle is refused at run time even if its manifest asks for setup", () => {
  const community = { ...SETUP_MANIFEST, origin: "community" };
  const plan = firstAdminSetupPlan(community);
  assert.match(plan.refused, /first-party bundles only/);
});

test("contract: urlEnv names a declared, non-secret env_vars entry, and rides only with crow", () => {
  const { dir } = tmpBundle("frigate", { "scripts/first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  const withUrl = (urlEnv) => ({ ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, urlEnv } });
  const declared = {
    ...withUrl("FRIGATE_URL"),
    env_vars: [...SETUP_MANIFEST.env_vars, { name: "FRIGATE_URL", default: "http://127.0.0.1:8971" }],
  };
  assert.equal(okManifest(declared, dir), true, errText(declared, dir));
  assert.match(errText(withUrl("NOT_DECLARED"), dir), /firstAdmin\.urlEnv must name a declared env_vars entry/);
  // An address is not a secret: a secret entry is refused even though it IS declared.
  assert.match(errText(withUrl("FRIGATE_PASSWORD"), dir), /firstAdmin\.urlEnv "FRIGATE_PASSWORD" must name a non-secret env_vars entry/);
  // Like the other mechanism fields, it is only allowed with mode crow.
  const finish = { ...declared, firstAdmin: { mode: "finish-setup", urlEnv: "FRIGATE_URL" } };
  assert.match(errText(finish, dir), /firstAdmin\.urlEnv is only allowed with mode "crow"/);
  // Its SHAPE is the schema's job: an env name is upper case letters, digits and _.
  assert.equal(okManifest(withUrl("frigate_url"), dir), false);
});

test("the plan refuses an env name the run would write into the bundle's .env", () => {
  const withSecret = (secretEnv) => ({ ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, secretEnv } });
  const withUser = (userEnv) => ({ ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, userEnv } });
  for (const name of ["crow_password", "CROW_PASSWORD", "COMPOSE_PASSWORD", "DOCKER_PASSWORD", "has-dash", "1PASSWORD", ""]) {
    assert.match(firstAdminSetupPlan(withSecret(name)).refused, /secretEnv/, String(name));
  }
  for (const name of ["crow_user", "CROW_USER", "COMPOSE_USER", "not a name"]) {
    assert.match(firstAdminSetupPlan(withUser(name)).refused, /userEnv/, String(name));
  }
  const withUrlEnv = (urlEnv) => ({ ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, urlEnv } });
  for (const name of ["crow_url", "CROW_URL", "COMPOSE_URL", "not a name"]) {
    assert.match(firstAdminSetupPlan(withUrlEnv(name)).refused, /urlEnv/, String(name));
  }
  assert.equal(firstAdminSetupPlan(withUrlEnv("FRIGATE_URL")).urlEnv, "FRIGATE_URL");
  assert.equal(firstAdminSetupPlan(SETUP_MANIFEST).urlEnv, null, "urlEnv is optional");
  assert.equal(firstAdminSetupPlan(withSecret("FRIGATE_PASSWORD")).refused, undefined, "a plain env name is fine");
});

test("the plan clamps the timeout and demands what the protocol cannot work without", () => {
  const base = firstAdminSetupPlan(SETUP_MANIFEST);
  assert.deepEqual(
    { script: base.script, timeoutMs: base.timeoutMs, user: base.user, secretEnv: base.secretEnv, userEnv: base.userEnv },
    { script: "scripts/first-admin.sh", timeoutMs: 30_000, user: "admin", secretEnv: "FRIGATE_PASSWORD", userEnv: "FRIGATE_USER" },
  );
  const noTimeout = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, setup: { script: "scripts/x.sh" } } };
  assert.equal(firstAdminSetupPlan(noTimeout).timeoutMs, 180_000, "180 s is the default");
  const huge = { ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, setup: { script: "scripts/x.sh", timeout_s: 99_999 } } };
  assert.equal(firstAdminSetupPlan(huge).timeoutMs, 600_000, "600 s is the ceiling");
  assert.equal(firstAdminSetupPlan({ firstAdmin: { mode: "crow", via: "env", secretEnv: "X" } }), null, "not a setup bundle");
  assert.equal(firstAdminSetupPlan({}), null);
});

// ── 2. the stdin half of the protocol ───────────────────────────────────────────────

test("spawnGroup delivers `input` on stdin and closes it; without input stdin stays closed", async () => {
  const env = { PATH: process.env.PATH };
  const reader = 'IFS= read -r LINE || exit 5; [ "$LINE" = "expected-value" ] && exit 0; exit 9';
  const got = await spawnGroup("bash", ["-c", reader], { env, timeout: 10_000, input: "expected-value\n" });
  assert.equal(got.stdout, "");
  // A different first line is a different answer: the exit code reaches the caller.
  await assert.rejects(
    spawnGroup("bash", ["-c", reader], { env, timeout: 10_000, input: "something-else\n" }),
    (err) => err.exitCode === 9,
  );
  // No `input` → stdin is /dev/null, so a `read` fails instead of hanging forever.
  await assert.rejects(
    spawnGroup("bash", ["-c", 'IFS= read -r LINE && exit 0; exit 7'], { env, timeout: 10_000 }),
    (err) => err.exitCode === 7,
  );
});

test("spawnGroup survives a large input to a script that never reads it", async () => {
  // The child exits before draining the pipe: its stdin write fails with EPIPE, which is
  // the child's business — the call still resolves instead of crashing the gateway.
  const env = { PATH: process.env.PATH };
  const got = await spawnGroup("bash", ["-c", "exit 0"], { env, timeout: 30_000, input: `${"x".repeat(1024 * 1024)}\n` });
  assert.equal(got.stdout, "");
  assert.equal(got.stderr, "");
});

// ── 3. runFirstAdminSetup, over the seams ───────────────────────────────────────────

/** Every seam the setup run needs, with the calls recorded. */
function seams(over = {}) {
  const calls = { runScript: [], save: [], writeEnv: [], marker: [], warn: [], mcpEnv: [], reload: [] };
  const deps = {
    runScript: async (cmd, args, opts) => { calls.runScript.push({ cmd, args, opts }); return { stdout: "step one\nstep two\n", stderr: "" }; },
    openDb: () => ({ close() {} }),
    hasSaved: async () => false,
    ensureWriteKey: async () => ({ id: "k1", seed: Buffer.alloc(32) }),
    newSecret: () => PASSPHRASE,
    save: async (db, key, entry) => { calls.save.push(entry); return { id: 1 }; },
    writeEnv: (dir, values) => { calls.writeEnv.push({ dir, values }); },
    writeMarker: async (db, id, value) => { calls.marker.push({ id, ...value }); return true; },
    now: () => Date.parse("2026-11-05T12:00:00Z"),
    warn: (m) => { calls.warn.push(String(m)); },
    // The bundle's MCP entry, and the report that a restart is needed for it: recorded,
    // never a real file and never a real restart.
    applyMcpEnv: async (id, values, manifest) => { calls.mcpEnv.push({ id, values, manifest }); return true; },
    requestReload: async () => { calls.reload.push(true); },
    ...over,
  };
  return { calls, deps };
}

const runSetup = async (deps, extra = {}) => {
  const { dirs: given, ...rest } = extra;
  const dirs = given || bundleDirs();
  return {
    dirs,
    out: await runFirstAdminSetup({
      bundleId: "frigate",
      manifest: SETUP_MANIFEST,
      scriptDir: dirs.repoDir,
      destDir: dirs.destDir,
      installId: INSTALL,
      crowHome: TMP_HOME,
      deps,
      ...rest,
    }),
  };
};

test("exit 0: the generated password is saved as a generated keychain entry, marked ok, and reaches .env", async () => {
  const { calls, deps } = seams();
  const { out, dirs } = await runSetup(deps);
  assert.equal(out.result, "ok");
  assert.equal(out.mcpEnvUpdated, true, "the login reached the bundle's MCP entry");
  assert.deepEqual(out.log, ["step one", "step two"], "the script's stdout is the log");
  assert.equal(calls.runScript.length, 1);
  const run = calls.runScript[0];
  assert.equal(run.cmd, "bash");
  assert.equal(run.args[0], join(dirs.repoDir, "scripts", "first-admin.sh"), "the REVIEWED copy of the script runs");
  assert.equal(run.opts.cwd, dirs.destDir, "cwd is the installed bundle dir");
  assert.equal(run.opts.env.CROW_BUNDLE_DIR, dirs.destDir);
  assert.equal(run.opts.input, `${PASSPHRASE}\n`, "the password is one stdin line");
  assert.equal(run.opts.env.CROW_FIRST_ADMIN_USER, "admin");
  assert.equal(run.opts.env.CROW_HOME, TMP_HOME);
  assert.equal(run.opts.timeout, 30_000);
  assert.deepEqual(calls.save.length, 1);
  assert.deepEqual(
    {
      bundleId: calls.save[0].bundleId,
      envKey: calls.save[0].envKey,
      label: calls.save[0].label,
      username: calls.save[0].username,
      url: calls.save[0].url,
      secret: calls.save[0].secret,
      origin: calls.save[0].origin,
      firstView: calls.save[0].firstView,
    },
    {
      bundleId: "frigate",
      envKey: "FRIGATE_PASSWORD",
      label: "Frigate — admin login",
      username: "admin",
      url: null,
      secret: PASSPHRASE,
      origin: "generated",
      firstView: true,
    },
  );
  assert.deepEqual(calls.writeEnv, [{ dir: dirs.destDir, values: { FRIGATE_PASSWORD: PASSPHRASE, FRIGATE_USER: "admin" } }]);
  assert.deepEqual(calls.marker, [{ id: "frigate", install: INSTALL, result: "ok" }]);
  // Security review round 2, finding 1: an MCP tool child is spawned with ITS mcp-addons.json
  // entry and never reads the bundle's .env, so the same values go there — and the run reports
  // that a restart is needed to load it (review round 3, finding 1: it never starts one).
  assert.deepEqual(calls.mcpEnv, [{ id: "frigate", values: { FRIGATE_PASSWORD: PASSPHRASE, FRIGATE_USER: "admin" }, manifest: SETUP_MANIFEST }]);
  assert.equal(calls.reload.length, 1, "exactly one restart-needed report");
  assert.equal(JSON.stringify(out).includes(PASSPHRASE), false, "and never the password in the answer");
});

test("a failed setup leaves the bundle's MCP entry alone", async () => {
  const { calls, deps } = seams({
    runScript: async () => { throw Object.assign(new Error("exit 1"), { exitCode: 1, stdout: "", stderr: "login API returned 500" }); },
  });
  const { out } = await runSetup(deps);
  assert.equal(out.result, "failed");
  assert.deepEqual(calls.mcpEnv, [], "no login was made, so nothing may be written into the entry");
  assert.equal(calls.reload.length, 0, "and nothing to report");
});

test("the real seam writes the bundle's own mcp-addons entry, and a bundle without one is no error", async () => {
  const addonsPath = join(TMP_HOME, "mcp-addons.json");
  rmSync(addonsPath, { force: true });
  // No entry: this app has no MCP server. Nothing is written, no restart is reported, and the
  // run is still an ok — the login is in the keychain either way.
  const none = seams();
  delete none.deps.applyMcpEnv;
  const without = await runSetup(none.deps);
  assert.equal(without.out.result, "ok");
  assert.equal(without.out.mcpEnvUpdated, undefined);
  assert.equal(existsSync(addonsPath), false, "an entry-less bundle is not given a file");
  assert.equal(none.calls.reload.length, 0);

  // The entry the install registered: both login values land in it, the other values stay.
  writeFileSync(addonsPath, JSON.stringify({ frigate: { command: "node", args: ["server/index.js"], env: { FRIGATE_URL: "http://127.0.0.1:8971" } } }), { mode: 0o600 });
  const withEntry = seams();
  delete withEntry.deps.applyMcpEnv;
  const second = await runSetup(withEntry.deps);
  assert.equal(second.out.result, "ok");
  assert.equal(second.out.mcpEnvUpdated, true);
  assert.equal(withEntry.calls.reload.length, 1);
  const doc = JSON.parse(readFileSync(addonsPath, "utf8"));
  assert.equal(doc.frigate.env.FRIGATE_PASSWORD, PASSPHRASE, "the MCP child gets the password it needs");
  assert.equal(doc.frigate.env.FRIGATE_USER, "admin");
  assert.equal(doc.frigate.env.FRIGATE_URL, "http://127.0.0.1:8971", "every other value is kept");
  assert.equal(statSync(addonsPath).mode & 0o777, 0o600, "the file that now holds a secret stays private");
  assert.equal(JSON.stringify(second.out).includes(PASSPHRASE), false);
  // Nothing of this file may leak into the route tests below (they use the real seams).
  rmSync(addonsPath, { force: true });
});

test("firstAdmin.urlEnv: the saved login carries the installed .env address, and only when it is an http(s) URL", async () => {
  const withUrl = (urlEnv) => ({ ...SETUP_MANIFEST, firstAdmin: { ...SETUP_MANIFEST.firstAdmin, urlEnv } });
  const savedUrl = async ({ urlEnv, env }) => {
    const dirs = bundleDirs();
    if (env !== undefined) writeFileSync(join(dirs.destDir, ".env"), env);
    const { calls, deps } = seams();
    const { out } = await runSetup(deps, { dirs, manifest: urlEnv === undefined ? SETUP_MANIFEST : withUrl(urlEnv) });
    assert.equal(out.result, "ok");
    return calls.save[0].url;
  };

  // The installed .env is read through Crow's own codec, so a quoted value decodes the same.
  assert.equal(await savedUrl({ urlEnv: "FRIGATE_URL", env: 'FRIGATE_URL="http://127.0.0.1:8971/calibre/"\n' }), "http://127.0.0.1:8971/calibre/");
  assert.equal(await savedUrl({ urlEnv: "FRIGATE_URL", env: "FRIGATE_URL=https://frigate.example.com\n" }), "https://frigate.example.com");
  // No urlEnv at all (every manifest before this field), an unset value, and no .env: null.
  assert.equal(await savedUrl({ env: "FRIGATE_URL=http://127.0.0.1:8971\n" }), null);
  assert.equal(await savedUrl({ urlEnv: "FRIGATE_URL", env: "FRIGATE_PASSWORD=old\n" }), null);
  assert.equal(await savedUrl({ urlEnv: "FRIGATE_URL" }), null);
  // Anything that is not an http(s) address of at most 512 characters is not the app's address.
  for (const value of ["ftp://127.0.0.1:8971", "/srv/frigate", "127.0.0.1:8971", `http://127.0.0.1:8971/${"a".repeat(500)}`]) {
    assert.equal(await savedUrl({ urlEnv: "FRIGATE_URL", env: `FRIGATE_URL=${value}\n` }), null, value);
  }
  // A credential embedded in the env value is NOT the app's address: the keychain's `url`
  // column is plain metadata, so it must never become a second copy of a password.
  for (const value of [
    "http://admin:s3cret@127.0.0.1:8971",
    "https://admin:s3cret@frigate.example.com/",
    "http://admin@127.0.0.1:8971",
    "http://:s3cret@127.0.0.1:8971",
  ]) {
    assert.equal(await savedUrl({ urlEnv: "FRIGATE_URL", env: `FRIGATE_URL=${value}\n` }), null, value);
  }
});

test("exit 3 (kept) and exit 4 (not running) save nothing and say what they are", async () => {
  for (const [exitCode, expected] of [[3, "kept"], [4, "not-running"]]) {
    const { calls, deps } = seams({
      runScript: async () => { throw Object.assign(new Error(`exit ${exitCode}`), { exitCode, stdout: "app said no\n", stderr: `boom\n\nexit ${exitCode}` }); },
    });
    const { out } = await runSetup(deps);
    assert.equal(out.result, expected);
    assert.equal(out.log.includes("app said no"), true);
    assert.equal(calls.save.length, 0, `${expected}: no password to save`);
    assert.equal(calls.writeEnv.length, 0);
    assert.deepEqual(calls.marker, [{ id: "frigate", install: INSTALL, result: expected }]);
  }
});

test("any other exit and a timeout are failures, with the script's own words", async () => {
  const failed = seams({
    runScript: async () => { throw Object.assign(new Error("exit 1"), { exitCode: 1, stdout: "", stderr: "login API returned 500\nexit 1" }); },
  });
  const out = await runSetup(failed.deps);
  assert.equal(out.out.result, "failed");
  assert.match(out.out.reason, /login API returned 500/);
  assert.doesNotMatch(out.out.reason, /^exit /);
  assert.deepEqual(failed.calls.marker, [{ id: "frigate", install: INSTALL, result: "failed" }]);

  const timedOut = seams({
    runScript: async () => { throw Object.assign(new Error("timed out after 30s"), { timedOut: true, stdout: "", stderr: "timed out after 30s" }); },
  });
  const slow = await runSetup(timedOut.deps);
  assert.equal(slow.out.result, "failed");
  assert.match(slow.out.reason, /timed out after 30s/);
});

test("exit 5: the app took the password, so it is saved like exit 0 and reported as unconfirmed", async () => {
  const { calls, deps } = seams({
    runScript: async () => {
      throw Object.assign(new Error("exit 5"), { exitCode: 5, stdout: "set the password\n", stderr: "" });
    },
  });
  const { out, dirs } = await runSetup(deps);
  assert.equal(out.result, "ok", "an app that already holds the password must not lose it over a proof");
  assert.equal(calls.save.length, 1, "the keychain keeps it, like exit 0");
  assert.deepEqual(
    { bundleId: calls.save[0].bundleId, envKey: calls.save[0].envKey, secret: calls.save[0].secret, origin: calls.save[0].origin, firstView: calls.save[0].firstView },
    { bundleId: "frigate", envKey: "FRIGATE_PASSWORD", secret: PASSPHRASE, origin: "generated", firstView: true },
  );
  assert.deepEqual(calls.writeEnv, [{ dir: dirs.destDir, values: { FRIGATE_PASSWORD: PASSPHRASE, FRIGATE_USER: "admin" } }]);
  assert.equal(calls.mcpEnv.length, 1, "an unproven login is still pushed to the MCP entry");
  assert.equal(calls.reload.length, 1, "and reported, exactly as exit 0 does");
  assert.equal(out.reason, FIRST_ADMIN_UNPROVEN);
  assert.equal(out.reason, "Crow saved the new login, but could not log in with it to confirm");
  assert.equal(out.log.includes(FIRST_ADMIN_UNPROVEN), true, "the install log carries the sentence too");
  assert.equal(out.log.includes("set the password"), true, "and the script's own line, so the operator sees both");
  assert.deepEqual(calls.marker, [{ id: "frigate", install: INSTALL, result: "ok" }]);
  assert.equal(JSON.stringify(out).includes(PASSPHRASE), false, "redaction still applies");
  assert.equal(JSON.stringify(calls.marker).includes(PASSPHRASE), false);
  assert.equal(
    firstAdminResultMessage({ result: out.result, name: "Frigate", user: "admin", reason: out.reason }),
    "Crow created Frigate's admin login (admin) and saved it in Settings → Passwords. Crow saved the new login, but could not log in with it to confirm.",
  );
});

test("exit 5 with a keychain that will not save still keeps the password in .env", async () => {
  const { calls, deps } = seams({
    runScript: async () => { throw Object.assign(new Error("exit 5"), { exitCode: 5, stdout: "", stderr: "" }); },
    save: async () => { throw new Error("seal failed"); },
  });
  const { out } = await runSetup(deps);
  assert.equal(out.result, "ok");
  assert.equal(calls.writeEnv.length, 1);
  assert.match(out.reason, /could not log in with it to confirm; saved in the extension's settings file only/);
  assert.equal(JSON.stringify(out).includes(PASSPHRASE), false);
});

test("an exit-5 script that echoes the password gets its words back redacted", async () => {
  const echo = [
    "#!/usr/bin/env bash",
    "set -eu",
    "IFS= read -r PW",
    'printf "%s\\n" "$PW"',
    "exit 5",
    "",
  ].join("\n");
  const { newSecretValue } = await import("../servers/gateway/bundle-env-secrets.js");
  const password = newSecretValue("secret");
  const dirs = bundleDirs({ "scripts/first-admin.sh": echo });
  const out = await runFirstAdminSetup({
    bundleId: "frigate",
    manifest: SETUP_MANIFEST,
    scriptDir: dirs.repoDir,
    destDir: dirs.destDir,
    installId: INSTALL,
    crowHome: TMP_HOME,
    deps: { ...seams().deps, runScript: spawnGroup, newSecret: () => password },
  });
  assert.equal(out.result, "ok");
  assert.deepEqual(out.log, ["[hidden]", FIRST_ADMIN_UNPROVEN], "the echoed password is replaced, not dropped");
  assert.equal(JSON.stringify(out).includes(password), false);
});

test("an existing ACTIVE keychain entry wins: nothing runs, nothing is overwritten, no marker", async () => {
  const { calls, deps } = seams({ hasSaved: async (_db, id, key) => id === "frigate" && key === "FRIGATE_PASSWORD" });
  const { out } = await runSetup(deps);
  assert.equal(out.result, "ok");
  assert.equal(out.alreadySaved, true, "the caller is told this was NOT a change");
  assert.equal(calls.runScript.length, 0, "the script must never run over a login Crow already has");
  assert.equal(calls.save.length, 0);
  // The keychain entry alone hides the card: a marker would keep it hidden after the
  // operator deletes the entry, so nothing is written here.
  assert.deepEqual(calls.marker, []);
});

test("only the already-saved path answers alreadySaved; a run that created the login does not", async () => {
  const fresh = seams();
  const ran = await runSetup(fresh.deps);
  assert.equal(ran.out.result, "ok", "result stays 'ok': the install path and the card route read it");
  assert.equal("alreadySaved" in ran.out, false, "this run really changed the app's login");
});

test("a keychain that cannot be opened or written stops everything BEFORE the app is touched", async () => {
  for (const over of [
    { openDb: () => { throw new Error("db is gone"); } },
    { hasSaved: async () => { throw new Error("no such table"); } },
    { ensureWriteKey: async () => { throw new Error("key file damaged"); } },
  ]) {
    const { calls, deps } = seams(over);
    const { out } = await runSetup(deps);
    assert.equal(out.result, "failed");
    assert.equal(out.reason, KEYCHAIN_UNOPENABLE);
    assert.equal(calls.runScript.length, 0, "the app's login must not change when the password cannot be kept");
    assert.equal(calls.save.length, 0);
  }
});

test("a keychain save that fails AFTER the app changed still parks the password in .env, undeclared", async () => {
  const manifest = { ...SETUP_MANIFEST, env_vars: [] }; // neither name is a declared env var
  const { calls, deps } = seams({ save: async () => { throw new Error("seal failed"); } });
  const dirs = bundleDirs();
  const out = await runFirstAdminSetup({
    bundleId: "frigate", manifest, scriptDir: dirs.repoDir, destDir: dirs.destDir, installId: INSTALL, crowHome: TMP_HOME, deps,
  });
  assert.equal(out.result, "ok");
  assert.equal(out.reason, "saved in the extension's settings file only");
  assert.deepEqual(calls.writeEnv, [{ dir: dirs.destDir, values: { FRIGATE_PASSWORD: PASSPHRASE } }]);
  assert.deepEqual(calls.marker, [{ id: "frigate", install: INSTALL, result: "ok" }]);
});

test("when BOTH copies fail, the run says the login has to be reset in the app", async () => {
  const { calls, deps } = seams({ save: async () => { throw new Error("seal failed"); }, writeEnv: () => { throw new Error("disk full"); } });
  const { out } = await runSetup(deps);
  assert.equal(out.result, "failed", "a password that only the app holds is not an ok");
  assert.equal(out.reason, PASSWORD_NOT_KEPT);
  assert.equal(out.reason, "the app's admin password changed but Crow could not keep it; reset it in the app");
  assert.deepEqual(calls.marker, [{ id: "frigate", install: INSTALL, result: "failed" }], "the card and the bell stay");
  assert.equal(calls.runScript.length, 1, "the app really was given the password");
});

test("the password never reaches a returned line, a log line or the console", async () => {
  const said = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...a) => said.push(a.map(String).join(" "));
  console.log = (...a) => said.push(a.map(String).join(" "));
  try {
    const { calls, deps } = seams({ save: async () => { throw new Error("seal failed"); } });
    const { out } = await runSetup(deps);
    assert.equal(out.result, "ok");
    assert.equal(calls.warn.length, 0, "nothing to warn about: the .env kept it");
    assert.equal(JSON.stringify(out).includes(PASSPHRASE), false);
    assert.equal(JSON.stringify(calls.marker).includes(PASSPHRASE), false);
    assert.equal(said.join("\n").includes(PASSPHRASE), false);

    const broken = seams({ save: async () => { throw new Error("seal failed"); }, writeEnv: () => { throw new Error("disk full"); } });
    const lost = (await runSetup(broken.deps)).out;
    assert.equal(lost.result, "failed");
    assert.equal(lost.reason, PASSWORD_NOT_KEPT);
    assert.equal(JSON.stringify(lost).includes(PASSPHRASE), false);
    assert.equal(said.join("\n").includes(PASSPHRASE), false, "the warning names nothing secret");
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
});

test("a script that prints the password gets its words back redacted", async () => {
  const echo = [
    "#!/usr/bin/env bash",
    "set -eu",
    "IFS= read -r PW",
    'printf "%s\\n" "$PW"',
    'printf "%s\\n" "$PW" >&2',
    "exit 1",
    "",
  ].join("\n");
  const { newSecretValue } = await import("../servers/gateway/bundle-env-secrets.js");
  const password = newSecretValue("secret");
  const dirs = bundleDirs({ "scripts/first-admin.sh": echo });
  const out = await runFirstAdminSetup({
    bundleId: "frigate",
    manifest: SETUP_MANIFEST,
    scriptDir: dirs.repoDir,
    destDir: dirs.destDir,
    installId: INSTALL,
    crowHome: TMP_HOME,
    deps: { ...seams().deps, runScript: spawnGroup, newSecret: () => password },
  });
  assert.equal(out.result, "failed");
  assert.ok(out.log.length > 0, "the script's own stdout line is still shown");
  assert.deepEqual(out.log, ["[hidden]"], "the echoed password is replaced, not dropped");
  assert.match(out.reason, /\[hidden\]/, "the stderr tail is kept, redacted");
  assert.equal(JSON.stringify(out).includes(password), false);
});

test("a non-setup manifest is skipped without running anything", async () => {
  const { calls, deps } = seams();
  const dirs = bundleDirs();
  const out = await runFirstAdminSetup({ bundleId: "frigate", manifest: { firstAdmin: { mode: "finish-setup" } }, scriptDir: dirs.repoDir, destDir: dirs.destDir, deps });
  assert.equal(out.result, "skipped");
  assert.equal(calls.runScript.length, 0);
  assert.deepEqual(out.log, []);
});

test("a refused plan (community) fails before the db or the script", async () => {
  const { calls, deps } = seams();
  const dirs = bundleDirs();
  const out = await runFirstAdminSetup({
    bundleId: "frigate", manifest: { ...SETUP_MANIFEST, origin: "community" }, scriptDir: dirs.repoDir, destDir: dirs.destDir, deps,
  });
  assert.equal(out.result, "failed");
  assert.match(out.reason, /first-party bundles only/);
  assert.equal(calls.runScript.length, 0);
});

test("there is no script to run without Crow's own copy of the bundle", async () => {
  const { calls, deps } = seams();
  const dirs = bundleDirs();
  for (const scriptDir of [null, "", join(dirs.destDir, "nope")]) {
    const out = await runFirstAdminSetup({
      bundleId: "frigate", manifest: SETUP_MANIFEST, scriptDir, destDir: dirs.destDir, installId: INSTALL, crowHome: TMP_HOME, deps,
    });
    assert.equal(out.result, "failed", String(scriptDir));
    assert.match(out.reason, /missing from the bundle/, String(scriptDir));
  }
  assert.equal(calls.runScript.length, 0, "the installed copy is never used as the source");
});

test("a setup script that is a symlink out of the reviewed bundle is refused, not run", async () => {
  const { calls, deps } = seams();
  const outside = tmpBundle("elsewhere", { "first-admin.sh": "#!/usr/bin/env bash\nexit 0\n" });
  const dirs = bundleDirs();
  rmSync(join(dirs.repoDir, "scripts", "first-admin.sh"));
  symlinkSync(join(outside.dir, "first-admin.sh"), join(dirs.repoDir, "scripts", "first-admin.sh"));
  const out = await runFirstAdminSetup({
    bundleId: "frigate", manifest: SETUP_MANIFEST, scriptDir: dirs.repoDir, destDir: dirs.destDir, installId: INSTALL, crowHome: TMP_HOME, deps,
  });
  assert.equal(out.result, "failed");
  assert.match(out.reason, /outside Crow's own copy of the bundle/);
  assert.equal(calls.runScript.length, 0, "nothing outside the reviewed tree is executed");
  assert.equal(calls.save.length, 0);
});

test("one setup run per bundle at a time, whoever starts it", async () => {
  const { calls, deps } = seams();
  assert.equal(tryBeginFirstAdminSetup("frigate"), true, "the install path can take the lock");
  const { out } = await runSetup(deps);
  assert.equal(out.result, "busy");
  assert.equal(calls.runScript.length, 0, "a run in flight is not raced");
  endFirstAdminSetup("frigate");
  // Released: the next call runs normally.
  const again = await runSetup(seams().deps);
  assert.equal(again.out.result, "ok");
  assert.equal(tryBeginFirstAdminSetup("frigate"), true);
  endFirstAdminSetup("frigate");
});

test("the result sentences are the operator's, and carry no password", () => {
  assert.equal(
    firstAdminResultMessage({ result: "ok", name: "Frigate", user: "admin" }),
    "Crow created Frigate's admin login (admin) and saved it in Settings → Passwords.",
  );
  assert.equal(
    firstAdminResultMessage({ result: "kept", name: "Frigate" }),
    "Frigate already has its own admin; Crow left it alone. Save the login you use on the Extensions card.",
  );
  assert.equal(
    firstAdminResultMessage({ result: "failed", name: "Frigate", reason: "the app is not answering" }),
    "Crow could not set up Frigate's admin login: the app is not answering. Use 'Set it up for me' on the Extensions card.",
  );
  assert.equal(firstAdminResultMessage({ result: "busy", name: "Frigate" }), "Crow is already setting up Frigate's admin login.");
});

// ── 4. the same run against a REAL script (no docker) ───────────────────────────────

const REAL_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -eu",
  "IFS= read -r PW",
  'printf "%s" "$PW" > "$CROW_BUNDLE_DIR/stdin.txt"',
  'printf "%s" "${CROW_FIRST_ADMIN_USER:-}" > "$CROW_BUNDLE_DIR/user.txt"',
  'pwd > "$CROW_BUNDLE_DIR/cwd.txt"',
  'env > "$CROW_BUNDLE_DIR/env.txt"',
  'printf "created the admin\\n"',
  "exit 0",
  "",
].join("\n");

test("real script: it reads the password from stdin, sees the username, and the password is kept out of its env", async () => {
  const dirs = bundleDirs({ "scripts/first-admin.sh": REAL_SCRIPT });
  const dir = dirs.destDir;
  const { newSecretValue } = await import("../servers/gateway/bundle-env-secrets.js");
  const { calls, deps } = seams({ runScript: spawnGroup, newSecret: () => newSecretValue("secret"), writeEnv: writeBundleEnv });
  // A distinct bundle id: this run really writes the keychain, and the route tests below
  // must not find this login already there.
  const out = await runFirstAdminSetup({
    bundleId: "frigate-real", manifest: { ...SETUP_MANIFEST, id: "frigate-real" },
    scriptDir: dirs.repoDir, destDir: dir, installId: INSTALL, crowHome: TMP_HOME, deps,
  });
  assert.equal(out.result, "ok", out.reason);
  assert.deepEqual(out.log, ["created the admin"]);

  const password = calls.save[0].secret;
  assert.match(password, /^[A-Za-z0-9_-]{43}$/, "newSecretValue gives a URL- and shell-safe value");
  assert.equal(readFileSync(join(dir, "stdin.txt"), "utf8"), password, "the stdin line is exactly the password");
  assert.equal(readFileSync(join(dir, "user.txt"), "utf8"), "admin", "CROW_FIRST_ADMIN_USER is in the environment");
  assert.equal(readFileSync(join(dir, "cwd.txt"), "utf8").trim(), dir, "the script runs in the installed bundle dir");
  assert.equal(existsSync(join(dirs.repoDir, "cwd.txt")), false, "and never in Crow's own copy");
  const envDump = readFileSync(join(dir, "env.txt"), "utf8");
  assert.equal(envDump.includes(password), false, "the password is on stdin only, never in the environment");
  assert.match(envDump, /CROW_FIRST_ADMIN_USER=admin/);

  // The real .env writer: mode 600, and the declared keys hold the login.
  const envPath = join(dir, ".env");
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.deepEqual(parseEnvText(readFileSync(envPath, "utf8")), { FRIGATE_PASSWORD: password, FRIGATE_USER: "admin" });
});

// ── 5. the card list ────────────────────────────────────────────────────────────────

const CROW_ENV = {
  id: "flux", name: "Miniflux", webUI: { port: 8085, path: "/", label: "Miniflux" },
  firstAdmin: { mode: "crow", via: "env", secretEnv: "MINIFLUX_ADMIN_PASSWORD" },
};
const FINISH = { id: "kuma", name: "Uptime Kuma", webUI: { port: 3007, path: "/", label: "Uptime Kuma" }, firstAdmin: { mode: "finish-setup" } };
const OLD_INSTALL = "2026-10-01T10:00:00.000Z";

test("a keychain that holds the app's admin login hides its card, whatever the mode", () => {
  const installed = { frig: { installedAt: INSTALL }, kuma: { installedAt: INSTALL } };
  const manifests = { frig: SETUP_MANIFEST, kuma: FINISH };
  // No marker for either: both would normally ask.
  assert.deepEqual(pendingFirstAdminNotices({ installed, manifests, liveProxyIds: ["frig", "kuma"] }).map((c) => c.id), ["frig", "kuma"]);
  const saved = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: ["frig", "kuma"], adminSaved: new Set(["frig", "kuma"]) });
  assert.deepEqual(saved, [], "the keychain holds both logins: nothing left to ask");
});

test("crow/setup asks until Crow's own run for THIS install returned ok", () => {
  const installed = { frig: { installedAt: INSTALL } };
  const manifests = { frig: SETUP_MANIFEST };
  const live = ["frig"];
  // ok for this install: silent.
  assert.deepEqual(pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, autoResults: { frig: { install: INSTALL, result: "ok" } } }), []);
  // ok for an OLDER install: the app was installed again, so ask again — and offer the run.
  const older = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, autoResults: { frig: { install: OLD_INSTALL, result: "ok" } } });
  assert.equal(older.length, 1);
  assert.equal(older[0].via, "setup");
  assert.equal(older[0].canAuto, true);
  assert.equal(older[0].canSave, true);
  assert.equal(older[0].user, "admin", "the save form is prefilled with the manifest's user");
  // kept: the app has its own admin, so there is nothing to create — only to save.
  const kept = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, autoResults: { frig: { install: INSTALL, result: "kept" } } });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kept, true);
  assert.equal(kept[0].canAuto, false);
  assert.equal(kept[0].canDone, true, "a kept card keeps its Done button: there is nothing left for Crow to do");
  assert.match(firstAdminBody(kept[0], "Frigate", "en"), /already has an admin/);
  // And Done really does close a kept card for this install (review round 3, finding 3).
  assert.deepEqual(
    pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, autoResults: { frig: { install: INSTALL, result: "kept" } }, done: { frig: INSTALL } }),
    [],
    "a kept setup install can be marked done",
  );
  // An upgraded setup install with no kept record ignores the old Done marker: the card's job is
  // still to create or save the login Crow does not have.
  // not-running / failed still offer the run.
  for (const result of ["not-running", "failed"]) {
    const card = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, autoResults: { frig: { install: INSTALL, result } } });
    assert.equal(card[0].canAuto, true, result);
  }
  // Done does NOT clear this card (review round 2, finding 2): the keychain holds no login for
  // the app, and a Done marker pressed under the OLD `finish-setup` declaration carries the same
  // install stamp — it must not hide the card that creates or saves the login.
  const donePressed = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, done: { frig: INSTALL } });
  assert.equal(donePressed.length, 1, "an old Done press cannot hide a card whose login Crow does not have");
  assert.equal(donePressed[0].canDone, false, "and the card offers no Done button that could not work");
  // Once the keychain holds the login, the card is gone without any marker.
  assert.deepEqual(pendingFirstAdminNotices({ installed, manifests, liveProxyIds: live, done: { frig: INSTALL }, adminSaved: new Set(["frig"]) }), []);
});

test("crow via env/postInstall still has no card, and the card text is the new sentence", () => {
  assert.deepEqual(pendingFirstAdminNotices({ installed: { flux: { installedAt: INSTALL } }, manifests: { flux: CROW_ENV }, liveProxyIds: ["flux"] }), []);
  const cards = pendingFirstAdminNotices({ installed: { frig: { installedAt: INSTALL } }, manifests: { frig: SETUP_MANIFEST }, liveProxyIds: ["frig"] });
  assert.equal(
    firstAdminBody(cards[0], "Frigate", "en"),
    "Crow can create Frigate's admin login for you and save it in Settings → Passwords.",
  );
  assert.notEqual(firstAdminBody(cards[0], "Frigate", "es"), firstAdminBody(cards[0], "Frigate", "en"));
  // A finish-setup card is unchanged, and never offers the automatic run.
  const finish = pendingFirstAdminNotices({ installed: { kuma: { installedAt: INSTALL } }, manifests: { kuma: FINISH }, liveProxyIds: ["kuma"] });
  assert.equal(finish[0].canAuto, false);
  assert.equal(finish[0].canSave, true);
});

test("the cards' admin key is secretEnv when declared, else FIRST_ADMIN_SAVED_KEY", () => {
  assert.equal(FIRST_ADMIN_SAVED_KEY, "APP_ADMIN_PASSWORD");
  assert.equal(firstAdminSavedKey(SETUP_MANIFEST), "FRIGATE_PASSWORD");
  assert.equal(firstAdminSavedKey(FINISH), FIRST_ADMIN_SAVED_KEY);
  assert.equal(firstAdminSavedKey(CROW_ENV), "MINIFLUX_ADMIN_PASSWORD");
  assert.equal(firstAdminSavedKey(null), FIRST_ADMIN_SAVED_KEY);
});

// ── 6. the bell ─────────────────────────────────────────────────────────────────────

/** dashboard_settings stub: the marker rows, and the language setting. */
function markerDb(rows = new Map()) {
  return {
    rows,
    execute: async ({ sql, args = [] }) => {
      if (/LIKE \?/i.test(sql)) {
        const prefix = String(args[0] || "").replace(/%$/, "");
        return { rows: [...rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
      }
      if (/SELECT value FROM dashboard_settings/i.test(sql)) {
        const key = /'language'/.test(sql) ? "language" : args[0];
        return { rows: rows.has(key) ? [{ value: rows.get(key) }] : [] };
      }
      if (/INSERT INTO dashboard_settings/i.test(sql)) {
        rows.set(args[0], args[1]);
        return { rows: [], rowsAffected: 1 };
      }
      return { rows: [] };
    },
  };
}

const collector = () => {
  const calls = [];
  const notify = async (_db, opts) => { calls.push(opts); return { id: calls.length }; };
  return { calls, notify };
};

test("a crow/setup bundle rings the bell only when its own run did not return ok", async () => {
  const { calls, notify } = collector();
  await notifyFirstAdmin({ db: markerDb(), bundleId: "frig", manifest: SETUP_MANIFEST, installId: INSTALL, autoResult: "ok", notify });
  assert.equal(calls.length, 0, "Crow created the admin: nothing to tell");
  for (const result of ["failed", "not-running", "kept", null]) {
    const c = collector();
    await notifyFirstAdmin({ db: markerDb(), bundleId: "frig", manifest: SETUP_MANIFEST, installId: INSTALL, autoResult: result, notify: c.notify });
    assert.equal(c.calls.length, 1, String(result));
    assert.equal(c.calls[0].action_url, "/dashboard/extensions?q=frig");
    assert.match(c.calls[0].body, /Frigate/);
  }
  // Once per install, like every other bell.
  const db = markerDb();
  const twice = collector();
  await notifyFirstAdmin({ db, bundleId: "frig", manifest: SETUP_MANIFEST, installId: INSTALL, autoResult: "failed", notify: twice.notify });
  await notifyFirstAdmin({ db, bundleId: "frig", manifest: SETUP_MANIFEST, installId: INSTALL, autoResult: "failed", notify: twice.notify });
  assert.equal(twice.calls.length, 1);
  assert.ok(calls);
});

test("the auto marker round-trips through dashboard_settings, and stays a first_admin_* key", async () => {
  const db = markerDb();
  const rows = db.rows;
  assert.equal(await writeFirstAdminAutoResult(db, "frig", { install: INSTALL, result: "ok" }), true);
  assert.equal(rows.get(firstAdminAutoKey("frig")), JSON.stringify({ install: INSTALL, result: "ok" }));
  assert.deepEqual(await firstAdminAutoResults(db), { frig: { install: INSTALL, result: "ok" } });
  rows.set(firstAdminAutoKey("broken"), "not json");
  assert.equal((await firstAdminAutoResults(db)).broken, undefined, "an unreadable marker is not a result");
  assert.deepEqual(await firstAdminAutoResults(null), {});
  const { isSyncable, isInstanceScope } = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
  assert.equal(isSyncable(firstAdminAutoKey("frig")), false);
  assert.equal(isInstanceScope(firstAdminAutoKey("frig")), true, "first_admin_* covers the new prefix");
});

// ── 7. the routes ───────────────────────────────────────────────────────────────────

const SETUP_ID = "frigate";
const PLAIN_ID = "kuma";
const NOT_SETUP_MANIFEST = { id: PLAIN_ID, name: "Uptime Kuma", type: "bundle", version: "1.0.0", webUI: { port: 3007, path: "/", label: "Uptime Kuma" }, firstAdmin: { mode: "finish-setup" } };

/** Write the manifest into both the source root and the installed tree, and record the install. */
function seedInstalled(manifest) {
  return seedInstalledPair(manifest, manifest);
}

/**
 * The two copies a first-admin run reads: the REPO manifest (what Crow reviews and runs)
 * and the INSTALLED one (which must never decide anything). Each gets its own scripts
 * folder holding both script names.
 */
function seedInstalledPair(repoManifest, installedManifest) {
  const id = repoManifest.id;
  for (const [root, manifest] of [[TMP_BUNDLES, repoManifest], [join(TMP_HOME, "bundles"), installedManifest]]) {
    const dir = join(root, id);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(dir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(dir, "scripts", "other-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
  }
  const installedPath = join(TMP_HOME, "installed.json");
  const current = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  const rest = current.filter((e) => e && e.id !== id);
  rest.push({ id, type: "bundle", version: "1.0.0", installedAt: INSTALL });
  writeFileSync(installedPath, JSON.stringify(rest, null, 2));
  return join(TMP_HOME, "bundles", id);
}

/** Record an install whose bundle is present in the installed tree only. */
function recordInstallOnly(id) {
  const installedPath = join(TMP_HOME, "installed.json");
  const current = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  current.push({ id, type: "bundle", version: "1.0.0", installedAt: INSTALL });
  writeFileSync(installedPath, JSON.stringify(current, null, 2));
}

async function withServer({ owner = true, crossHost = false } = {}, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (crossHost) req.crossHostAuth = { sourceInstanceId: "peer" }; next(); });
  B._setOwnerCheckForTest(() => owner);
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    return await fn(post);
  } finally {
    server.close();
    B._setOwnerCheckForTest(null);
  }
}

test("both routes are owner-only: a non-owner session and a peer request get 403 with a plain sentence", async () => {
  seedInstalled(SETUP_MANIFEST);
  await withServer({ owner: false }, async (post) => {
    for (const [path, body] of [
      ["/bundles/api/first-admin-auto", { bundle_id: SETUP_ID }],
      ["/bundles/api/first-admin-save", { bundle_id: SETUP_ID, username: "admin", password: "Typed-Pass-1" }],
    ]) {
      const r = await post(path, body);
      assert.equal(r.status, 403, path);
      assert.match(r.body.error, /owner at this machine's dashboard/);
    }
  });
  await withServer({ owner: true, crossHost: true }, async (post) => {
    // Case and a trailing slash too: Express matches both, so the deny list must.
    for (const path of ["/bundles/api/first-admin-auto", "/bundles/api/first-admin-save", "/BUNDLES/API/FIRST-ADMIN-AUTO/"]) {
      const r = await post(path, { bundle_id: SETUP_ID, password: "Typed-Pass-1" });
      assert.equal(r.status, 403, `${path}: a peer may not set an app's admin login`);
    }
  });
});

test("an app whose admin Crow cannot create itself is refused with the plain sentence", async () => {
  seedInstalled(NOT_SETUP_MANIFEST);
  await withServer({ owner: true }, async (post) => {
    const r = await post("/bundles/api/first-admin-auto", { bundle_id: PLAIN_ID });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "This app can't be set up automatically; finish it in the app.");
    const unknown = await post("/bundles/api/first-admin-auto", { bundle_id: "not-installed" });
    assert.equal(unknown.status, 404);
  });
});

test("a second run while one is in flight is a 409, and the first still finishes", async () => {
  const gated = { ...SETUP_MANIFEST, id: "frigate-gate", name: "Frigate Gate" };
  seedInstalled(gated);
  let started = false;
  let release;
  const gate = new Promise((res) => { release = res; });
  B._setFirstAdminSetupDepsForTest({
    runScript: async () => { started = true; await gate; return { stdout: "", stderr: "" }; },
    // Nothing real is written: this test is about the in-flight guard.
    save: async () => ({ id: 1 }),
    writeEnv: () => {},
  });
  try {
    await withServer({ owner: true }, async (post) => {
      const first = post("/bundles/api/first-admin-auto", { bundle_id: "frigate-gate" });
      const deadline = Date.now() + 10_000;
      while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(started, true, "the first run reached the script");
      const second = await post("/bundles/api/first-admin-auto", { bundle_id: "frigate-gate" });
      assert.equal(second.status, 409);
      assert.match(second.body.error, /already setting up/);
      release();
      const done = await first;
      assert.equal(done.status, 200);
      assert.equal(done.body.result, "ok");
    });
  } finally {
    B._setFirstAdminSetupDepsForTest(null);
  }
});

test("the install path's run and the card's run are the same lock", async () => {
  const gated = { ...SETUP_MANIFEST, id: "frigate-install-lock", name: "Frigate Lock" };
  seedInstalled(gated);
  // The install path holds the lock while its script runs (runFirstAdminSetup owns it).
  assert.equal(tryBeginFirstAdminSetup("frigate-install-lock"), true);
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: "frigate-install-lock" });
      assert.equal(r.status, 409, "a card run never races the install's");
      assert.match(r.body.error, /already setting up/);
    });
  } finally {
    endFirstAdminSetup("frigate-install-lock");
  }
});

test("the route builds its plan from the REPO manifest, never from the installed copy", async () => {
  const reviewed = { ...SETUP_MANIFEST, id: "frigate-reviewed", name: "Frigate Reviewed" };
  const installedCopy = {
    ...reviewed,
    origin: "community",
    firstAdmin: { ...reviewed.firstAdmin, setup: { script: "scripts/other-admin.sh", timeout_s: 30 }, user: "mallory" },
  };
  // The installed copy cannot even offer the reviewed script's name.
  seedInstalledPair(reviewed, installedCopy);
  const dir = join(TMP_HOME, "bundles", "frigate-reviewed");
  rmSync(join(dir, "scripts", "first-admin.sh"));
  const ran = [];
  B._setFirstAdminSetupDepsForTest({
    runScript: async (cmd, args, opts) => { ran.push({ cmd, args, opts }); return { stdout: "created\n", stderr: "" }; },
    save: async () => ({ id: 1 }),
    writeEnv: () => {},
  });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: "frigate-reviewed" });
      // A community origin or a missing script would both refuse: only the repo copy works.
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.result, "ok");
      assert.match(r.body.message, /\(admin\)/, "the repo manifest's user");
    });
  } finally {
    B._setFirstAdminSetupDepsForTest(null);
  }
  assert.equal(ran.length, 1, "exactly one script ran");
  assert.equal(ran[0].args[0], join(TMP_BUNDLES, "frigate-reviewed", "scripts", "first-admin.sh"), "the repo copy of the script");
  assert.equal(ran[0].opts.cwd, dir, "cwd is the installed bundle dir");
  assert.equal(ran[0].opts.env.CROW_BUNDLE_DIR, dir);
  assert.equal(ran[0].opts.env.CROW_FIRST_ADMIN_USER, "admin");
});

test("no repo manifest means the route refuses and runs nothing", async () => {
  const id = "frigate-installed-only";
  const dir = join(TMP_HOME, "bundles", id);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...SETUP_MANIFEST, id, name: "Frigate Installed Only" }, null, 2));
  writeFileSync(join(dir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
  recordInstallOnly(id);
  let ran = 0;
  B._setFirstAdminSetupDepsForTest({ runScript: async () => { ran++; return { stdout: "", stderr: "" }; } });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: id });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "This app can't be set up automatically; finish it in the app.");
    });
  } finally {
    B._setFirstAdminSetupDepsForTest(null);
  }
  assert.equal(ran, 0, "the installed copy's manifest and script are not a source");
});

test("the auto route runs the setup and the real keychain, marker and .env all come out right", async () => {
  const dir = seedInstalled(SETUP_MANIFEST);
  B._setFirstAdminSetupDepsForTest({ runScript: async () => ({ stdout: "created the admin\n", stderr: "" }) });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: SETUP_ID });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(r.body.result, "ok");
      assert.match(r.body.message, /^Crow created Frigate's admin login \(admin\) and saved it in Settings → Passwords\.$/);
      assert.deepEqual(r.body.log, ["created the admin"]);
      assert.equal(r.body.needs_restart, false, "this scratch install registered no MCP entry, so nothing needs a restart");
      assert.equal(JSON.stringify(r.body).includes("APP_ADMIN"), false, "never a secret in the answer");
    });
    const { createDbClient } = await import("../servers/db.js");
    const { listEntries, openEntrySecret } = await import("../servers/gateway/keychain/store.js");
    const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
    const db = createDbClient();
    try {
      const key = loadKeychainKey({ crowHome: TMP_HOME });
      const entry = (await listEntries(db, { keyId: key?.id ?? null })).find((e) => e.bundle_id === SETUP_ID && e.env_key === "FRIGATE_PASSWORD");
      assert.ok(entry, "the password is in the keychain");
      assert.equal(entry.status, "active");
      assert.equal(entry.origin, "generated");
      assert.equal(entry.username, "admin");
      const secret = await openEntrySecret(db, key, entry.id);
      assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
      const env = parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
      assert.equal(env.FRIGATE_PASSWORD, secret, "the bundle .env carries the same password");
      assert.equal(env.FRIGATE_USER, "admin");
      const marker = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [firstAdminAutoKey(SETUP_ID)] });
      assert.deepEqual(JSON.parse(marker.rows[0].value), { install: INSTALL, result: "ok" });
    } finally {
      db.close();
    }
  } finally {
    B._setFirstAdminSetupDepsForTest(null);
  }
});

test("an unproven login comes back as ok with its sentence, and the keychain keeps it", async () => {
  const unproven = { ...SETUP_MANIFEST, id: "frigate-unproven", name: "Frigate Unproven" };
  seedInstalled(unproven);
  B._setFirstAdminSetupDepsForTest({
    runScript: async () => { throw Object.assign(new Error("exit 5"), { exitCode: 5, stdout: "set the password\n", stderr: "" }); },
  });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: "frigate-unproven" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true, "the app holds the password, so the login is kept");
      assert.equal(r.body.result, "ok");
      assert.equal(r.body.reason, "Crow saved the new login, but could not log in with it to confirm");
      assert.match(r.body.message, /^Crow created Frigate Unproven's admin login \(admin\) and saved it in Settings → Passwords\. Crow saved the new login, but could not log in with it to confirm\.$/);
      assert.deepEqual(r.body.log, ["set the password", "Crow saved the new login, but could not log in with it to confirm"]);
    });
    const { createDbClient } = await import("../servers/db.js");
    const { listEntries, openEntrySecret } = await import("../servers/gateway/keychain/store.js");
    const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
    const db = createDbClient();
    try {
      const key = loadKeychainKey({ crowHome: TMP_HOME });
      const entry = (await listEntries(db, { keyId: key?.id ?? null })).find((e) => e.bundle_id === "frigate-unproven");
      assert.ok(entry, "the password the app took is in the keychain");
      assert.equal(entry.origin, "generated");
      assert.match(await openEntrySecret(db, key, entry.id), /^[A-Za-z0-9_-]{43}$/);
    } finally {
      db.close();
    }
  } finally {
    B._setFirstAdminSetupDepsForTest(null);
  }
});

test("first-admin-save stores the operator's own login under the bundle's admin key", async () => {
  const saveManifest = { ...SETUP_MANIFEST, id: "frigate-save", name: "Frigate Save" };
  seedInstalled(saveManifest);
  // This bundle registers an MCP server, so the saved login also lands in its entry: the answer
  // then says a restart is needed to load it (and the route starts none).
  writeFileSync(
    join(TMP_HOME, "mcp-addons.json"),
    JSON.stringify({ "frigate-save": { command: "node", args: ["server/index.js"], env: {} } }),
    { mode: 0o600 },
  );
  await withServer({ owner: true }, async (post) => {
    const bad = await post("/bundles/api/first-admin-save", { bundle_id: "frigate-save", username: "admin", password: "" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Enter the password/);
    const notString = await post("/bundles/api/first-admin-save", { bundle_id: "frigate-save", username: 42, password: "x" });
    assert.equal(notString.status, 400);

    const r = await post("/bundles/api/first-admin-save", { bundle_id: "frigate-save", username: "alex", password: "Typed-Pass-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The login went into the bundle's MCP entry (frigate registers one), so the answer says a
    // restart is needed — and the route started none itself.
    assert.deepEqual(r.body, { ok: true, needs_restart: true });
  });
  const { createDbClient } = await import("../servers/db.js");
  const { listEntries, openEntrySecret } = await import("../servers/gateway/keychain/store.js");
  const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
  const db = createDbClient();
  try {
    const key = loadKeychainKey({ crowHome: TMP_HOME });
    const entry = (await listEntries(db, { keyId: key?.id ?? null })).find((e) => e.bundle_id === "frigate-save" && e.env_key === "FRIGATE_PASSWORD");
    assert.ok(entry, "the login is in the keychain");
    assert.equal(entry.origin, "typed");
    assert.equal(entry.username, "alex");
    assert.equal(entry.first_view_pending, false, "the operator typed it: nothing to show once");
    assert.equal(await openEntrySecret(db, key, entry.id), "Typed-Pass-1");
  } finally {
    db.close();
  }
});

test("saving the login never overwrites one Crow already keeps", async () => {
  const keepManifest = { ...SETUP_MANIFEST, id: "frigate-kept", name: "Frigate Kept" };
  seedInstalled(keepManifest);
  await withServer({ owner: true }, async (post) => {
    const first = await post("/bundles/api/first-admin-save", { bundle_id: "frigate-kept", username: "admin", password: "Typed-Pass-1" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await post("/bundles/api/first-admin-save", { bundle_id: "frigate-kept", username: "admin", password: "Typed-Pass-2" });
    assert.equal(second.status, 409, "the login Crow keeps is not replaced from this form");
    assert.equal(second.body.error, "Crow already keeps a login for this app. Change it in Settings → Passwords.");
  });
  const { createDbClient } = await import("../servers/db.js");
  const { listEntries, openEntrySecret } = await import("../servers/gateway/keychain/store.js");
  const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
  const db = createDbClient();
  try {
    const key = loadKeychainKey({ crowHome: TMP_HOME });
    const entry = (await listEntries(db, { keyId: key?.id ?? null })).find((e) => e.bundle_id === "frigate-kept" && e.env_key === "FRIGATE_PASSWORD");
    assert.ok(entry);
    assert.equal(await openEntrySecret(db, key, entry.id), "Typed-Pass-1", "nothing was saved over it");
  } finally {
    db.close();
  }
});

test("both card routes answer needs_restart and neither restarts the gateway itself", async () => {
  // Review round 3, finding 1: a restart started from these routes would kill any install job
  // that is running. They report that one is needed instead, and the card says so.
  const autoManifest = { ...SETUP_MANIFEST, id: "frigate-restart-auto", name: "Frigate Restart Auto" };
  const saveManifest = { ...SETUP_MANIFEST, id: "frigate-restart-save", name: "Frigate Restart Save" };
  seedInstalled(autoManifest);
  seedInstalled(saveManifest);
  writeFileSync(
    join(TMP_HOME, "mcp-addons.json"),
    JSON.stringify({
      "frigate-restart-auto": { command: "node", args: ["server/index.js"], env: {} },
      "frigate-restart-save": { command: "node", args: ["server/index.js"], env: {} },
    }),
    { mode: 0o600 },
  );
  const restarts = [];
  B._setRestartHookForTest((delayMs) => restarts.push(delayMs));
  B._setFirstAdminSetupDepsForTest({ runScript: async () => ({ stdout: "created the admin\n", stderr: "" }) });
  try {
    await withServer({ owner: true }, async (post) => {
      const auto = await post("/bundles/api/first-admin-auto", { bundle_id: "frigate-restart-auto" });
      assert.equal(auto.status, 200, JSON.stringify(auto.body));
      assert.equal(auto.body.result, "ok");
      assert.equal(auto.body.needs_restart, true, "the MCP entry was written, so a restart loads it");
      const saved = await post("/bundles/api/first-admin-save", { bundle_id: "frigate-restart-save", username: "admin", password: "Typed-Pass-7" });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.needs_restart, true, "and the operator's login reached its entry too");
    });
  } finally {
    B._setFirstAdminSetupDepsForTest(null);
    B._setRestartHookForTest(null);
  }
  assert.deepEqual(restarts, [], "neither route restarts the gateway itself");
});

test("saveFirstAdminLogin reports a keychain failure instead of throwing", async () => {
  const said = [];
  const { result } = await saveFirstAdminLogin({
    bundleId: SETUP_ID,
    manifest: SETUP_MANIFEST,
    username: "admin",
    password: "Typed-Pass-2",
    deps: {
      openDb: () => ({ close() {} }),
      hasSaved: async () => false,
      ensureWriteKey: async () => { throw new Error("key file damaged"); },
      save: async () => ({ id: 1 }),
      warn: (m) => said.push(String(m)),
    },
  });
  assert.equal(result, "failed");
  assert.equal(said.join("\n").includes("Typed-Pass-2"), false, "the cause is logged, never the password");
});

test("a login the operator saved also reaches the bundle's MCP entry — and a bundle without one is no error", async () => {
  const calls = { mcpEnv: [], reload: [] };
  const deps = {
    openDb: () => ({ close() {} }),
    hasSaved: async () => false,
    ensureWriteKey: async () => ({ id: "k1", seed: Buffer.alloc(32) }),
    save: async () => ({ id: 1 }),
    applyMcpEnv: async (id, values, manifest) => { calls.mcpEnv.push({ id, values, manifest }); return true; },
    requestReload: async () => { calls.reload.push(true); },
  };
  const saved = await saveFirstAdminLogin({ bundleId: "frigate", manifest: SETUP_MANIFEST, username: "admin", password: "Typed-Pass-1", deps });
  assert.deepEqual(saved, { result: "saved", mcpEnvUpdated: true });
  // Same entries a setup run writes: without them Crow's own tools keep answering 401.
  assert.deepEqual(calls.mcpEnv, [{ id: "frigate", values: { FRIGATE_PASSWORD: "Typed-Pass-1", FRIGATE_USER: "admin" }, manifest: SETUP_MANIFEST }]);
  assert.equal(calls.reload.length, 1, "and one report that a restart is needed");

  // A finish-setup app has no `secretEnv`/`userEnv` to write — nothing is pushed, no error.
  calls.mcpEnv.length = 0;
  calls.reload.length = 0;
  const finish = await saveFirstAdminLogin({
    bundleId: "kuma",
    manifest: FINISH,
    username: "alex",
    password: "Typed-Pass-1",
    deps: { ...deps, applyMcpEnv: async () => { throw new Error("there is nothing to write"); } },
  });
  assert.deepEqual(finish, { result: "saved", mcpEnvUpdated: false });
  assert.deepEqual(calls.mcpEnv, []);
  assert.equal(calls.reload.length, 0);
});

// ── 8. the card ─────────────────────────────────────────────────────────────────────

const CLIENT_HTML = extensionsClientJS("en", { servicesUi: false });
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));

const CARD = {
  id: "frig",
  name: "Frigate",
  mode: "crow",
  via: "setup",
  user: "admin",
  note: null,
  link: { href: "/proxy/frig/", onclick: "", proxyMode: "subpath", path: "/" },
  installId: INSTALL,
  restartPending: false,
  linkUnavailable: false,
  kept: false,
  canAuto: true,
  canSave: true,
};

function renderCards(cards, lang = "en") {
  return buildExtensionsHTML({
    installed: Object.fromEntries(cards.map((c) => [c.id, { installedAt: INSTALL }])),
    available: [], collections: [], needsConfig: {}, keychainPending: [],
    registrySource: "local", communityStores: [], bundleStatus: {},
    firstAdminPending: cards, lang,
  }).viewsHtml;
}

function boot(html, { fetchImpl } = {}) {
  const { window, document } = parseHTML(`<html><body><div class="main-content">${html}${OVERLAY_HTML}</div></body></html>`);
  const calls = [];
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, method: init?.method });
    const answer = fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) };
    return Promise.resolve(answer);
  };
  const location = { hash: "", href: "https://crow.test/dashboard/extensions", reload() {} };
  const ctx = vm.createContext({
    window, document, location, console, AbortController,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchStub,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(CLIENT_JS, ctx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, calls, settle, click: (el) => el.dispatchEvent(new window.Event("click", { bubbles: true })) };
}

test("the card offers Set it up for me, and the save form has a real password field", () => {
  const { document } = boot(renderCards([CARD]));
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.ok(card, "the card is rendered");
  assert.match(card.textContent, /Crow can create Frigate's admin login for you and save it in Settings → Passwords\./);
  const auto = card.querySelector(".ext-firstadmin-auto");
  assert.ok(auto, "Set it up for me is offered");
  assert.equal(auto.textContent, t("bundles.firstAdmin.setItUp", "en"));
  const pass = card.querySelector(".ext-firstadmin-save-pass");
  assert.ok(pass, "the save form is there");
  assert.equal(pass.getAttribute("type"), "password");
  assert.equal(pass.getAttribute("autocomplete"), "off");
  const user = card.querySelector(".ext-firstadmin-save-user");
  assert.equal(user.getAttribute("value"), "admin", "the username is prefilled from the manifest");
  assert.ok(card.querySelector(".ext-firstadmin-done"), "Done is still there");
});

test("a kept result offers no automatic run, and the body says the app already has an admin", () => {
  const { document } = boot(renderCards([{ ...CARD, kept: true, canAuto: false }]));
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.equal(card.querySelector(".ext-firstadmin-auto"), null);
  assert.match(card.textContent, /Frigate already has an admin\. Save the login you use so Crow can keep it for you\./);
  assert.ok(card.querySelector(".ext-firstadmin-save"), "saving the operator's own login is still offered");
});

test("Set it up for me replaces the card with where it was saved, and shows no password", async () => {
  const { document, calls, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: "ok", message: "Crow created Frigate's admin login (admin) and saved it in Settings → Passwords.", log: [] }),
    }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  click(card.querySelector(".ext-firstadmin-auto"));
  await settle();
  const posted = calls.find((c) => c.url.endsWith("/first-admin-auto"));
  assert.ok(posted, "the button posts the request");
  assert.equal(posted.method, "POST");
  assert.deepEqual(posted.body, { bundle_id: "frig" });
  const after = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.equal(after.textContent.trim(), t("bundles.firstAdmin.savedInPasswords", "en"));
  assert.equal(after.querySelector(".ext-firstadmin-save"), null, "the form is gone with the card's contents");
});

test("an ok run Crow could not confirm keeps that sentence on the cleared card", async () => {
  const reason = "Crow saved the new login, but could not log in with it to confirm";
  const message = `Crow created Frigate's admin login (admin) and saved it in Settings → Passwords. ${reason}.`;
  const { document, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: "ok", reason, message, log: [] }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  click(card.querySelector(".ext-firstadmin-auto"));
  await settle();
  const after = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.equal(after.querySelector(".ext-firstadmin__saved").textContent, t("bundles.firstAdmin.savedInPasswords", "en"));
  assert.equal(after.querySelector(".ext-firstadmin__msg").textContent, reason, "a cleared card is never a false 'it works'");
});

test("a failed after-step shows its own warning on the cleared card, next to the saved line", async () => {
  const afterFailure = "Crow could not apply the follow-up change to Frigate, so registration may still be open: press Restart on the Extensions card.";
  const message = "Crow created Frigate's admin login (admin) and saved it in Settings → Passwords.";
  const { document, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: "ok", after: "recreate-failed: port is already allocated", afterFailure, message, log: [] }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  click(card.querySelector(".ext-firstadmin-auto"));
  await settle();
  const after = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.equal(after.querySelector(".ext-firstadmin__saved").textContent, t("bundles.firstAdmin.savedInPasswords", "en"));
  const note = after.querySelector(".ext-firstadmin__msg");
  assert.ok(note, "the warning is shown, not swallowed");
  assert.equal(note.textContent, afterFailure);
  assert.match(after.textContent, /registration may still be open/);
});

test("an ok run that closed registration shows the saved line and no warning", async () => {
  const { document, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: "ok", after: "applied", message: "saved", log: [] }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  click(card.querySelector(".ext-firstadmin-auto"));
  await settle();
  const after = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.equal(after.querySelector(".ext-firstadmin__msg"), null, "nothing to warn about");
});

test("a run that did not create the login shows the server's sentence and keeps the card", async () => {
  const message = "Crow could not set up Frigate's admin login: the app is not answering. Use 'Set it up for me' on the Extensions card.";
  const { document, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: false, result: "not-running", message, log: [] }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  const button = card.querySelector(".ext-firstadmin-auto");
  click(button);
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, t("bundles.firstAdmin.setItUp", "en"));
  assert.ok(card.querySelector(".ext-firstadmin__msg").textContent.includes("the app is not answering"));
});

test("saving the login the operator made posts it and clears the card", async () => {
  const { document, calls, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  const form = card.querySelector(".ext-firstadmin-save");
  form.querySelector(".ext-firstadmin-save-pass").value = "Typed-Pass-1";
  form.dispatchEvent(new (document.defaultView.Event)("submit", { bubbles: true, cancelable: true }));
  await settle();
  const posted = calls.find((c) => c.url.endsWith("/first-admin-save"));
  assert.ok(posted, "the form posts the login");
  assert.deepEqual(posted.body, { bundle_id: "frig", username: "admin", password: "Typed-Pass-1" });
  assert.equal(document.querySelectorAll(".ext-firstadmin").length, 0, "the keychain holds it now");
  assert.equal(calls.some((c) => c.url.includes("first-admin-done")), false);
  assert.ok(click);
});

test("an ok run that wrote the bundle's MCP entry says to restart, in Configure's words", async () => {
  const { document, settle, click } = boot(renderCards([CARD]), {
    fetchImpl: () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: "ok", needs_restart: true, message: "Crow created Frigate's admin login (admin) and saved it in Settings → Passwords.", log: [] }),
    }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  click(card.querySelector(".ext-firstadmin-auto"));
  await settle();
  const after = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.equal(after.querySelector(".ext-firstadmin__saved").textContent, t("bundles.firstAdmin.savedInPasswords", "en"));
  assert.equal(after.querySelector(".ext-firstadmin__needs-restart").textContent, t("extensions.configureNeedsRestart", "en"), "the same sentence Configure's save shows");
});

test("a saved login that reached the MCP entry leaves the card saying to restart", async () => {
  const { document, settle } = boot(renderCards([CARD]), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, needs_restart: true }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  const form = card.querySelector(".ext-firstadmin-save");
  form.querySelector(".ext-firstadmin-save-pass").value = "Typed-Pass-1";
  form.dispatchEvent(new (document.defaultView.Event)("submit", { bubbles: true, cancelable: true }));
  await settle();
  const after = document.querySelector('.ext-firstadmin[data-addon-id="frig"]');
  assert.ok(after, "the card stays to carry the sentence");
  assert.equal(after.textContent.trim(), t("extensions.configureNeedsRestart", "en"));
  assert.equal(after.querySelector(".ext-firstadmin-save"), null, "its form is gone");
});

test("the card escapes the app name and the username it comes with", () => {
  const html = renderCards([{ ...CARD, id: "x", name: '<img src=x onerror=alert(1)>', user: '"><script>alert(2)</script>' }]);
  assert.equal(/<img src=x/.test(html), false, "the app name is escaped");
  assert.equal(html.includes('"><script>alert(2)'), false, "the prefilled username is escaped");
});
test("a password Crow could not keep says to reset it in the app, not to retry", async () => {
  const { firstAdminResultMessage, PASSWORD_NOT_KEPT } = await import("../servers/gateway/bundle-first-admin-setup.js");
  const msg = firstAdminResultMessage({ result: "failed", name: "Demo", reason: PASSWORD_NOT_KEPT });
  assert.ok(msg.includes("reset it in the app"));
  assert.ok(!msg.includes("Set it up for me"));
});
