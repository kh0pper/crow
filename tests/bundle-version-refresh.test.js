/**
 * Bundle version-aware refresh (BH-4, D1) — tests/bundle-version-refresh.test.js
 *
 * `repairInstalledBundleAssets()` now runs a version-keyed refresh phase
 * BEFORE its long-standing missing-only repair: for each installed first-party
 * bundle whose repo manifest.version differs from the installed manifest's
 * version (both-undefined counts as equal), it re-copies the bundle's
 * explicit-include code artifacts + the served PANELS_DIR panel/routes files,
 * and — only when a repo package.json declares a dependency name absent from
 * the installed node_modules/ — runs a (test-injected) npm install.
 *
 * CROW_HOME is env-keyed (read once at module import) so the DEST side
 * (~/.crow/bundles, ~/.crow/panels) is redirected to a scratch tmp dir set
 * BEFORE the dynamic import below — this file never touches the real
 * ~/.crow. The SOURCE side (the repo's bundles/ dir) is redirected per-call
 * via the injectable `appBundles` param, so each test gets its own throwaway
 * "repo". The npm runner is always the injected fake — no real npm ever runs.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** Write `content` to `root/relPath`, creating parent dirs as needed. */
function put(root, relPath, content) {
  const p = join(root, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function readAt(root, relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

function freshRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Fake npm runner: records calls, never shells out. */
function fakeRunner() {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

let CROW_HOME;
let repairInstalledBundleAssets;

before(async () => {
  CROW_HOME = freshRoot("crowhome-refresh-");
  // Module-level const in bundles.js reads process.env.CROW_HOME once at
  // import time — MUST be set before the dynamic import.
  process.env.CROW_HOME = CROW_HOME;
  ({ repairInstalledBundleAssets } = await import("../servers/gateway/routes/bundles.js"));
});

after(() => {
  delete process.env.CROW_HOME;
});

/** Overwrite ~/.crow/installed.json (scratch CROW_HOME) with the given ids. */
function setInstalled(ids) {
  put(CROW_HOME, "installed.json", JSON.stringify(ids.map((id) => ({ id }))));
}

function destBundleDir(id) {
  return join(CROW_HOME, "bundles", id);
}
function destPanelsDir() {
  return join(CROW_HOME, "panels");
}

// ---------------------------------------------------------------------------
// Test 1 + 3: version differs → refresh runs; code + panel artifacts
// overwritten; instance-local files (.env, data/, extra node_modules entry)
// survive byte-identical.
// ---------------------------------------------------------------------------
describe("version differs → refresh (+ instance-local preservation)", () => {
  const id = "widget-v";
  let repoRoot;
  let runner;
  let result;

  before(async () => {
    repoRoot = freshRoot("crowrepo-widgetv-");
    // --- repo (source) side: version 1.1.0 ---
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
      id, name: "Widget", version: "1.1.0", type: "mcp-server", category: "misc",
      description: "d", server: { command: "node", args: ["server/index.js"] },
      panel: `panel/${id}.js`, panelRoutes: "panel/routes.js", skills: [`skills/${id}.md`],
    }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { leftpad: "^1.0.0" } }));
    put(repoRoot, `${id}/server/index.js`, "console.log('v2 server');\n");
    put(repoRoot, `${id}/panel/${id}.js`, "export default 'v2-panel';\n");
    put(repoRoot, `${id}/panel/routes.js`, "export default 'v2-routes';\n");
    put(repoRoot, `${id}/skills/${id}.md`, "# v2 skill\n");
    put(repoRoot, `${id}/settings-section.js`, "export const settings = 'v2';\n");

    // --- installed (dest) side: stale version 1.0.0 ---
    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    put(CROW_HOME, `bundles/${id}/server/index.js`, "console.log('v1 STALE server');\n");
    put(CROW_HOME, `bundles/${id}/.env`, "SECRET=abc123\n");
    put(CROW_HOME, `bundles/${id}/data/marker.txt`, "learner-data\n");
    // leftpad already present → the npm trigger for THIS bundle must stay silent.
    put(CROW_HOME, `bundles/${id}/node_modules/leftpad/index.js`, "module.exports = () => {};\n");
    put(CROW_HOME, `bundles/${id}/node_modules/extra-pkg/marker.js`, "extra file preserved\n");
    put(CROW_HOME, `panels/${id}.js`, "OLD PANEL CONTENT\n");
    put(CROW_HOME, `panels/${id}-routes.js`, "OLD ROUTES CONTENT\n");

    setInstalled([id]);

    // Single invocation — its outcome is asserted from multiple angles below
    // (overwritten-vs-preserved). A second invocation would find manifest.json
    // already equalized to 1.1.0 by the first run and correctly no-op, which
    // would defeat a test that wants to observe the refresh itself.
    runner = fakeRunner();
    result = await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
  });

  test("code files + panel artifacts are overwritten from the repo", () => {
    assert.deepEqual(result.errors, []);
    assert.ok(result.repaired.some((r) => r.includes(id)), "repaired list mentions the bundle");

    assert.equal(readAt(destBundleDir(id), "server/index.js"), "console.log('v2 server');\n");
    assert.equal(readAt(destBundleDir(id), "settings-section.js"), "export const settings = 'v2';\n");
    assert.equal(readAt(destBundleDir(id), "skills/widget-v.md"), "# v2 skill\n");
    assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "1.1.0");
    assert.equal(readAt(destPanelsDir(), `${id}.js`), "export default 'v2-panel';\n");
    assert.equal(readAt(destPanelsDir(), `${id}-routes.js`), "export default 'v2-routes';\n");

    // leftpad already present in node_modules → no npm trigger for this bundle.
    assert.equal(runner.calls.length, 0, "npm must not fire when no dep name is missing");
  });

  test("instance-local files survive the refresh byte-identical", () => {
    assert.equal(readAt(destBundleDir(id), ".env"), "SECRET=abc123\n");
    assert.equal(readAt(destBundleDir(id), "data/marker.txt"), "learner-data\n");
    assert.equal(readAt(destBundleDir(id), "node_modules/extra-pkg/marker.js"), "extra file preserved\n");
  });
});

// ---------------------------------------------------------------------------
// Test 2: version equal → refresh phase is a no-op; existing missing-only
// repair behavior is unchanged (a present-but-stale file is NOT touched; a
// genuinely missing file still gets repaired).
// ---------------------------------------------------------------------------
describe("version equal → no refresh (missing-only behavior preserved)", () => {
  const id = "widget-eq";
  let repoRoot;

  before(() => {
    repoRoot = freshRoot("crowrepo-widgeteq-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "Widget Eq", version: "2.0.0", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/server/index.js`, "REPO CONTENT\n");
    put(repoRoot, `${id}/settings-section.js`, "export const settings = 'repo';\n");

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "2.0.0", type: "mcp-server" }));
    put(CROW_HOME, `bundles/${id}/server/index.js`, "DEST STALE CONTENT DIFFERENT\n");
    // settings-section.js deliberately absent on the dest side — missing-only
    // repair should still fill it in even though the refresh phase is a no-op.

    setInstalled([id]);
  });

  test("a present-but-differing file is left untouched (no refresh fired)", async () => {
    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(readAt(destBundleDir(id), "server/index.js"), "DEST STALE CONTENT DIFFERENT\n");
    assert.equal(runner.calls.length, 0);
  });

  test("a genuinely missing file is still repaired by the existing missing-only phase", async () => {
    assert.equal(readAt(destBundleDir(id), "settings-section.js"), "export const settings = 'repo';\n");
  });
});

// ---------------------------------------------------------------------------
// Test 4: npm trigger — added dep name fires; removed-dep-only and
// version-range-only changes do NOT.
// ---------------------------------------------------------------------------
describe("npm trigger — added-dep-name-only", () => {
  test("an added dependency name absent from installed node_modules fires npm", async () => {
    const id = "widget-npm-added";
    const repoRoot = freshRoot("crowrepo-npmadd-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { qrcode: "^1.5.0" } }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    // node_modules exists but has no qrcode/ dir — the ADDED dep.
    put(CROW_HOME, `bundles/${id}/node_modules/.keep`, "");
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 1, "npm must fire for an added dep name");
    assert.equal(runner.calls[0].cmd, "npm");
    assert.deepEqual(runner.calls[0].args, ["install", "--omit=dev"]);
    assert.equal(runner.calls[0].opts.cwd, destBundleDir(id));
  });

  test("a removed-dep-only change does NOT fire npm", async () => {
    const id = "widget-npm-removed";
    const repoRoot = freshRoot("crowrepo-npmrm-");
    // Repo DROPS old-dep entirely; the only remaining dep (kept-dep) is
    // already present on the installed side.
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "kept-dep": "^1.0.0" } }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    put(CROW_HOME, `bundles/${id}/node_modules/kept-dep/index.js`, "module.exports = {};\n");
    put(CROW_HOME, `bundles/${id}/node_modules/old-dep/index.js`, "module.exports = {};\n"); // stale, no longer declared
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 0, "npm must NOT fire when nothing new was added");
  });

  test("a version-range-only change to an already-present dep does NOT fire npm", async () => {
    const id = "widget-npm-range";
    const repoRoot = freshRoot("crowrepo-npmrange-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "kept-dep": "^2.0.0" } })); // range bumped, name unchanged

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    put(CROW_HOME, `bundles/${id}/node_modules/kept-dep/index.js`, "module.exports = {};\n");
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 0, "npm must NOT fire on a version-range-only change");
  });
});

// ---------------------------------------------------------------------------
// Test 4b: docker-type restriction (config/scripts NOT copied even if
// present in the repo) + manifest-declared-root path-traversal rejection.
// ---------------------------------------------------------------------------
describe("4b — docker-type restriction + declared-root traversal rejection", () => {
  test("docker-surface bundle: config/ and scripts/ are NOT copied even when present in repo", async () => {
    const id = "widget-docker";
    const repoRoot = freshRoot("crowrepo-docker-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
      id, name: "D", version: "2.0.0", type: "bundle", category: "misc", description: "d",
      docker: { composefile: "docker-compose.yml" },
    }));
    put(repoRoot, `${id}/docker-compose.yml`, "services: {}\n");
    put(repoRoot, `${id}/config/settings.yml`, "repo config\n");
    put(repoRoot, `${id}/scripts/bootstrap.sh`, "#!/bin/sh\necho repo script\n");
    put(repoRoot, `${id}/server/index.js`, "docker server v2\n"); // still allowed for docker type

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "bundle" }));
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });

    assert.ok(!existsSync(join(destBundleDir(id), "config")), "config/ must not be copied for a docker-surface bundle");
    assert.ok(!existsSync(join(destBundleDir(id), "scripts")), "scripts/ must not be copied for a docker-surface bundle");
    assert.equal(readAt(destBundleDir(id), "server/index.js"), "docker server v2\n", "server/ is still copied for docker-surface bundles");
  });

  test("non-docker (mcp-server) bundle: config/ and scripts/ ARE copied", async () => {
    const id = "widget-nondocker";
    const repoRoot = freshRoot("crowrepo-nondocker-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "M", version: "2.0.0", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/config/settings.yml`, "repo config\n");
    put(repoRoot, `${id}/scripts/bootstrap.sh`, "#!/bin/sh\necho repo script\n");

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    setInstalled([id]);

    await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });

    assert.equal(readAt(destBundleDir(id), "config/settings.yml"), "repo config\n");
    assert.equal(readAt(destBundleDir(id), "scripts/bootstrap.sh"), "#!/bin/sh\necho repo script\n");
  });

  test("a manifest-declared root of \"../x\" is rejected — no copy outside the bundle dir", async () => {
    const id = "widget-traversal";
    const repoRoot = freshRoot("crowrepo-traversal-");
    // A hostile/malformed manifest declares a server entrypoint that walks up
    // out of the bundle dir. Also plant the "escape" file just outside the
    // bundle dir in the same repo root to prove it's never touched.
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
      id, name: "T", version: "2.0.0", type: "mcp-server", category: "misc", description: "d",
      server: { command: "node", args: ["../x/evil.js"] },
    }));
    put(repoRoot, "x/evil.js", "should never be reachable via the bundle dir\n");

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    setInstalled([id]);

    const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(errors, []);
    // The only valid first segment of "../x/evil.js" is "..", which must be
    // rejected outright — no "../x" (or anything else escaping the bundle
    // dir) may appear inside the installed bundle's directory.
    assert.ok(!existsSync(join(destBundleDir(id), "..", "x")), "declared root must never escape the bundle dir");
  });
});

// ---------------------------------------------------------------------------
// Docker build contexts (phone runner/): a compose `build: ./runner` dir is a
// build input, so a version bump refreshes it; a context escaping the bundle
// dir, the bundle root ".", and a context that is also a bind mount are not.
// ---------------------------------------------------------------------------
describe("docker build contexts refresh on a version bump", () => {
  test("build: ./runner is refreshed; ../x and . are ignored; nothing is rebuilt", async () => {
    const id = "widget-build-ctx";
    const repoRoot = freshRoot("crowrepo-buildctx-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
      id, name: "B", version: "0.2.0", type: "bundle", category: "misc", description: "d",
      docker: { composefile: "docker-compose.yml" },
    }));
    put(repoRoot, `${id}/docker-compose.yml`, [
      "services:",
      "  runner:",
      "    build: ./runner",
      "  sidecar:",
      "    build:",
      "      context: ../x",
      "      dockerfile: Dockerfile",
      "  root:",
      "    build: .",
      "  mounted:",
      "    build: ./cfg",
      "    volumes:",
      "      - ./cfg:/cfg",
      "",
    ].join("\n"));
    put(repoRoot, `${id}/runner/Dockerfile`, "FROM python:3.12-slim # v2\n");
    put(repoRoot, `${id}/runner/src/app.py`, "TIMEOUT = 120\n");
    put(repoRoot, `${id}/runner/.venv/lib/junk.py`, "dev venv\n");
    put(repoRoot, `${id}/cfg/live.yml`, "repo cfg\n");
    put(repoRoot, "x/Dockerfile", "outside the bundle\n");

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "0.1.0", type: "bundle" }));
    put(CROW_HOME, `bundles/${id}/runner/src/app.py`, "TIMEOUT = 20\n");
    put(CROW_HOME, `bundles/${id}/.env`, "SECRET=keep\n");
    setInstalled([id]);

    const runner = fakeRunner();
    const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.deepEqual(errors, []);

    const dest = destBundleDir(id);
    assert.equal(readAt(dest, "runner/src/app.py"), "TIMEOUT = 120\n", "runner/ source refreshed");
    assert.equal(readAt(dest, "runner/Dockerfile"), "FROM python:3.12-slim # v2\n");
    assert.ok(!existsSync(join(dest, "runner", ".venv")), "local .venv is never copied");
    assert.ok(!existsSync(join(dest, "..", "x")), "a context escaping the bundle dir is ignored");
    assert.ok(!existsSync(join(dest, "docker-compose.yml")), "build: . never sweeps in the bundle root");
    assert.ok(!existsSync(join(dest, "cfg")), "a context that is also a bind mount is not touched");
    assert.equal(readAt(dest, ".env"), "SECRET=keep\n");
    assert.equal(runner.calls.length, 0, "no rebuild (or any command) runs on refresh");
  });

  test("the same version does not touch the build context", async () => {
    const id = "widget-build-ctx-same";
    const repoRoot = freshRoot("crowrepo-buildctx-same-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "B", version: "0.2.0", type: "bundle", category: "misc", description: "d", docker: { composefile: "docker-compose.yml" } }));
    put(repoRoot, `${id}/docker-compose.yml`, "services:\n  runner:\n    build: ./runner\n");
    put(repoRoot, `${id}/runner/src/app.py`, "TIMEOUT = 120\n");
    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "0.2.0", type: "bundle" }));
    put(CROW_HOME, `bundles/${id}/runner/src/app.py`, "TIMEOUT = 20\n");
    setInstalled([id]);
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
  });
});

// ---------------------------------------------------------------------------
// Test 4c (C4 Task 3): version-drift on an EXACT-pinned dep also fires npm —
// today only an added dep NAME does. A range-pinned dep stays presence-only
// (no version comparison at all), exactly as before.
// ---------------------------------------------------------------------------
describe("npm trigger — exact-pin version-drift (C4 Task 3)", () => {
  test("an exact-pinned dep whose installed version differs from the pin fires npm (version-drift, not just added-name)", async () => {
    const id = "widget-npm-pin-drift";
    const repoRoot = freshRoot("crowrepo-npmpindrift-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "pinned-dep": "2.0.0" } })); // exact semver pin

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    // Installed dep is present by NAME but at the OLD pinned version — the
    // presence-only check this task replaces would bless this as complete.
    put(CROW_HOME, `bundles/${id}/node_modules/pinned-dep/package.json`, JSON.stringify({ name: "pinned-dep", version: "1.0.0" }));
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 1, "npm must fire when an exact-pinned dep's installed version differs from the pin");
    assert.deepEqual(runner.calls[0].args, ["install", "--omit=dev"]);
  });

  test("an exact-pinned dep already at the pinned version does NOT fire npm", async () => {
    const id = "widget-npm-pin-match";
    const repoRoot = freshRoot("crowrepo-npmpinmatch-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "pinned-dep": "2.0.0" } }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    put(CROW_HOME, `bundles/${id}/node_modules/pinned-dep/package.json`, JSON.stringify({ name: "pinned-dep", version: "2.0.0" }));
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 0, "npm must NOT fire when the exact-pinned dep is already at the pinned version");
  });

  test("range dep unchanged behavior: a range-pinned dep present by name never triggers on version alone", async () => {
    const id = "widget-npm-range-mismatch";
    const repoRoot = freshRoot("crowrepo-npmrangemismatch-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "ranged-dep": "^3.0.0" } }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    // Installed version (1.0.0) doesn't even satisfy ^3.0.0 — range deps stay
    // presence-only, so this must NOT trigger a refresh.
    put(CROW_HOME, `bundles/${id}/node_modules/ranged-dep/package.json`, JSON.stringify({ name: "ranged-dep", version: "1.0.0" }));
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 0, "range-pinned deps must stay presence-only — no version comparison");
  });

  test("an exact-pinned dep with no readable installed package.json is treated as drifted (fires npm)", async () => {
    const id = "widget-npm-pin-unreadable";
    const repoRoot = freshRoot("crowrepo-npmpinunreadable-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "N", version: "1.0.1", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "pinned-dep": "2.0.0" } }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "mcp-server" }));
    // pinned-dep/ exists (dir present) but has no package.json inside it.
    mkdirSync(join(CROW_HOME, `bundles/${id}/node_modules/pinned-dep`), { recursive: true });
    setInstalled([id]);

    const runner = fakeRunner();
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
    assert.equal(runner.calls.length, 1, "an unreadable installed package.json for an exact-pinned dep must be treated as drift, not silently trusted");
  });
});

// ---------------------------------------------------------------------------
// Test 4d (C4 Task 3): the boot-time refresh's npm step stays warn-only even
// for an npm_required bundle — hard-fail must never leak into gateway boot.
// The install-time hard-fail path (runInstallJob, tests/bundle-npm-required
// .test.js) is a completely separate code path from refreshVersionedBundle.
// ---------------------------------------------------------------------------
describe("npm_required refresh at boot stays warn-only (hard-fail must never leak into gateway boot)", () => {
  test("an npm_required bundle whose boot-time refresh npm step throws is still just a warning — no throw, no error reported, destDir survives", async () => {
    const id = "widget-npm-required-boot";
    const repoRoot = freshRoot("crowrepo-npmrequiredboot-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
      id, name: "N", version: "1.0.1", type: "bundle", category: "ai", description: "d",
      npm_required: true,
    }));
    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "added-dep": "^1.0.0" } }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "bundle" }));
    // node_modules exists but lacks added-dep → the npm trigger fires.
    put(CROW_HOME, `bundles/${id}/node_modules/.keep`, "");
    setInstalled([id]);

    const throwingRunner = async () => { throw new Error("simulated npm failure at boot"); };
    const { errors, repaired } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: throwingRunner });

    assert.deepEqual(errors, [], "a failing npm step at boot must never surface as an error — warn-only even for npm_required");
    assert.ok(repaired.some((r) => r.includes(id)), "the refresh itself must still be reported as having run");
    assert.ok(existsSync(destBundleDir(id)), "destDir must NOT be removed — boot-time refresh never hard-fails, unlike the install-time path");
  });
});

// ---------------------------------------------------------------------------
// Test 5: unreadable/missing installed manifest → falls back to missing-only
// repair, no throw.
// ---------------------------------------------------------------------------
describe("unreadable/missing installed manifest → missing-only fallback, no throw", () => {
  test("installed bundle with no manifest.json at all falls back cleanly", async () => {
    const id = "widget-nomanifest";
    const repoRoot = freshRoot("crowrepo-nomanifest-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "NM", version: "1.0.0", type: "mcp-server", category: "misc", description: "d" }));
    put(repoRoot, `${id}/settings-section.js`, "export const settings = 'repo';\n");

    // Dest dir exists but has never had a manifest.json copied to it.
    mkdirSync(destBundleDir(id), { recursive: true });
    setInstalled([id]);

    const { repaired, errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(errors, []);
    // Missing-only phase still ran: settings-section.js + manifest.json get
    // filled in because they were absent.
    assert.equal(readAt(destBundleDir(id), "settings-section.js"), "export const settings = 'repo';\n");
    assert.ok(JSON.parse(readAt(destBundleDir(id), "manifest.json")).id === id);
    assert.ok(repaired.some((r) => r.includes(id)));
  });

  test("installed manifest.json that fails to parse falls back cleanly (no throw)", async () => {
    const id = "widget-badjson";
    const repoRoot = freshRoot("crowrepo-badjson-");
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({ id, name: "BJ", version: "1.0.0", type: "mcp-server", category: "misc", description: "d" }));

    put(CROW_HOME, `bundles/${id}/manifest.json`, "{ not valid json !!");
    setInstalled([id]);

    await assert.doesNotReject(async () => {
      const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
      assert.deepEqual(errors, []);
    });
  });
});

// ---------------------------------------------------------------------------
// B3 (2026-10-02): build-context refresh hardening.
//   - a context is never refreshed when ANY bind of the installed copy
//     overlaps it: a bind of a subdirectory, a long-syntax `source:`, a
//     parent bind (the bundle root), or a ${VAR} that expands onto it;
//   - manifest.docker.composefile is honoured;
//   - a failed copy leaves the installed manifest at the OLD version, so the
//     next boot retries the refresh.
// ---------------------------------------------------------------------------
describe("B3 — build-context refresh hardening", () => {
  /** A docker bundle at 0.1.0 installed, 0.2.0 in the repo, with runner/ source. */
  function dockerFixture(id, compose, { manifestExtra = {}, composeName = "docker-compose.yml", installedEnv = null } = {}) {
    const repoRoot = freshRoot(`crowrepo-${id}-`);
    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
      id, name: "B", version: "0.2.0", type: "bundle", category: "misc", description: "d",
      docker: { composefile: "docker-compose.yml" }, ...manifestExtra,
    }));
    put(repoRoot, `${id}/${composeName}`, compose);
    put(repoRoot, `${id}/runner/src/app.py`, "TIMEOUT = 120\n");
    put(repoRoot, `${id}/runner/state/seed.txt`, "repo seed\n");
    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "0.1.0", type: "bundle" }));
    put(CROW_HOME, `bundles/${id}/runner/src/app.py`, "TIMEOUT = 20\n");
    if (installedEnv !== null) put(CROW_HOME, `bundles/${id}/.env`, installedEnv);
    setInstalled([id]);
    return repoRoot;
  }
  const runnerRefreshed = (id) => readAt(destBundleDir(id), "runner/src/app.py") === "TIMEOUT = 120\n";

  const SKIPPED = [
    ["a bind of a SUBDIRECTORY of the context", "b3-subdir",
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - ./runner/state:/state\n"],
    ["a long-syntax `source:` bind of the context", "b3-long",
      "services:\n  r:\n    build:\n      context: ./runner\n    volumes:\n      - type: bind\n        source: ./runner\n        target: /app\n"],
    ["a long-syntax `source:` bind of a subdirectory (quoted)", "b3-long-sub",
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - type: bind\n        source: \"./runner/state\"\n        target: /state\n"],
    ["a PARENT bind (the bundle root)", "b3-parent",
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - .:/srv\n"],
    ["a parent bind written ./", "b3-parent-slash",
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - \"./:/srv:ro\"\n"],
    ["a ${VAR:-default} bind whose default is the context", "b3-var-default",
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - ${RUNNER_SRC_DIR_UNSET_B3:-./runner}:/app\n"],
  ];
  for (const [label, id, compose] of SKIPPED) {
    test(`${label} → the context is NOT refreshed`, async () => {
      const repoRoot = dockerFixture(id, compose);
      const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
      assert.deepEqual(errors, []);
      assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n", "live-mounted context left alone");
      assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "0.2.0", "the rest of the refresh still ran");
    });
  }

  test("a ${VAR} bind resolved from the INSTALLED .env onto the context → NOT refreshed", async () => {
    const id = "b3-var-dotenv";
    const repoRoot = dockerFixture(id,
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - ${B3_RUNNER_DIR}:/app\n",
      { installedEnv: "B3_RUNNER_DIR=./runner/src\n" });
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
  });

  test("an absolute bind of the installed context → NOT refreshed", async () => {
    const id = "b3-abs";
    const repoRoot = dockerFixture(id,
      `services:\n  r:\n    build: ./runner\n    volumes:\n      - ${join(CROW_HOME, "bundles", id, "runner")}:/app\n`);
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
  });

  // Fix round 1 (I1): the live mounts come from the INSTALLED compose and any
  // override compose merges in — the repo compose alone is not the truth.
  test("a bind only the INSTALLED compose declares (repo dropped it) → NOT refreshed", async () => {
    const id = "b3-installed-only";
    const repoRoot = dockerFixture(id, "services:\n  r:\n    build: ./runner\n");
    put(CROW_HOME, `bundles/${id}/docker-compose.yml`, "services:\n  r:\n    build: ./runner\n    volumes:\n      - ./runner/src:/app\n");
    const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(errors, []);
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
    assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "0.2.0");
  });

  for (const name of ["docker-compose.override.yml", "docker-compose.override.yaml", "compose.override.yml"]) {
    test(`a bind in an installed ${name} → NOT refreshed`, async () => {
      const id = "b3-ovr-" + name.replace(/[^a-z]/g, "");
      const repoRoot = dockerFixture(id, "services:\n  r:\n    build: ./runner\n");
      put(CROW_HOME, `bundles/${id}/${name}`, "services:\n  r:\n    volumes:\n      - ./runner/src:/app\n");
      await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
      assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
    });
  }

  test("a non-default composefile's installed <name>.override.yml is scanned too", async () => {
    const id = "b3-ovr-composefile";
    const repoRoot = dockerFixture(id, "services:\n  r:\n    build: ../runner\n",
      { manifestExtra: { docker: { composefile: "deploy/stack.yml" } }, composeName: "deploy/stack.yml" });
    put(CROW_HOME, `bundles/${id}/deploy/stack.override.yml`, "services:\n  r:\n    volumes:\n      - ../runner:/app\n");
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
  });

  test("an installed compose with only named volumes does not block (control)", async () => {
    const id = "b3-installed-ctl";
    const repoRoot = dockerFixture(id, "services:\n  r:\n    build: ./runner\n");
    put(CROW_HOME, `bundles/${id}/docker-compose.yml`, "services:\n  r:\n    build: ./runner\n    volumes:\n      - data:/d\nvolumes:\n  data:\n");
    await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.ok(runnerRefreshed(id));
  });

  // Fix round 1 (M2): compose runs get CROW_HOME from composeEnv() even when
  // the gateway's own env lacks it — the bind scan must expand it the same way.
  test("a ${CROW_HOME} bind expands like the compose run does, even with CROW_HOME unset in process.env", async () => {
    const id = "b3-crowhome";
    const repoRoot = dockerFixture(id,
      "services:\n  r:\n    build: ./runner\n    volumes:\n      - ${CROW_HOME}/bundles/" + id + "/runner/src:/app\n");
    const saved = process.env.CROW_HOME;
    delete process.env.CROW_HOME;
    try {
      await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    } finally {
      process.env.CROW_HOME = saved;
    }
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
  });

  test("named volumes, ports, env entries and binds elsewhere do NOT block the refresh", async () => {
    const id = "b3-unrelated";
    const repoRoot = dockerFixture(id, [
      "services:",
      "  r:",
      "    build: ./runner",
      "    ports:",
      "      - \"3065:3065\"",
      "    environment:",
      "      - DATA_DIR=/data",
      "    volumes:",
      "      - runner-data:/data",
      "      - ./config:/config:ro",
      "      - ${B3_UNSET_DATA_DIR_X:-./data}:/var/data",
      "      - type: volume",
      "        source: other-data",
      "        target: /other",
      "volumes:",
      "  runner-data:",
      "  other-data:",
      "",
    ].join("\n"));
    const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(errors, []);
    assert.ok(runnerRefreshed(id), "an unrelated bind never blocks the context refresh");
  });

  test("manifest.docker.composefile is honoured (contexts read from the declared file, resolved from its directory)", async () => {
    const id = "b3-composefile";
    const repoRoot = dockerFixture(id,
      "services:\n  r:\n    build: ../runner\n",
      { manifestExtra: { docker: { composefile: "deploy/stack.yml" } }, composeName: "deploy/stack.yml" });
    const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(errors, []);
    assert.ok(runnerRefreshed(id), "build: ../runner from deploy/stack.yml is the bundle's runner/");
  });

  test("a composefile that escapes the bundle dir is ignored (no contexts refreshed)", async () => {
    const id = "b3-composefile-escape";
    const repoRoot = dockerFixture(id, "services:\n  r:\n    build: ./runner\n",
      { manifestExtra: { docker: { composefile: "../other.yml" } } });
    put(repoRoot, "other.yml", "services:\n  r:\n    build: ./" + id + "/runner\n");
    const { errors } = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(errors, []);
    assert.equal(readAt(destBundleDir(id), "runner/src/app.py"), "TIMEOUT = 20\n");
  });

  test("the real phone bundle still refreshes its runner/ build context (named volume only)", async () => {
    const repoBundles = new URL("../bundles", import.meta.url).pathname;
    put(CROW_HOME, "bundles/phone/manifest.json", JSON.stringify({ id: "phone", version: "0.0.1", type: "bundle" }));
    setInstalled(["phone"]);
    const { errors, repaired } = await repairInstalledBundleAssets({ appBundles: repoBundles, run: fakeRunner() });
    assert.deepEqual(errors, []);
    assert.ok(repaired.some((r) => r.startsWith("phone: refreshed") && r.includes("build:runner")), JSON.stringify(repaired));
    assert.ok(existsSync(join(destBundleDir("phone"), "runner", "Dockerfile")));
  });

  test("a failed build-context copy leaves the installed manifest at the OLD version, and the next boot retries", async () => {
    const id = "b3-failed-copy";
    const repoRoot = dockerFixture(id, "services:\n  r:\n    build: ./runner\n");
    // A regular FILE where the context's subdirectory belongs: cpSync cannot
    // copy runner/src/ over it, so the build-context copy throws mid-refresh.
    const { rmSync } = await import("node:fs");
    rmSync(join(destBundleDir(id), "runner", "src"), { recursive: true, force: true });
    put(CROW_HOME, `bundles/${id}/runner/src`, "not a directory\n");

    const first = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.equal(first.errors.length, 1, "the failure is reported");
    assert.equal(first.errors[0].id, id);
    assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "0.1.0",
      "the manifest (the refresh's commit marker) was NOT bumped");

    // Operator clears the blocker; the next boot sees the version delta again.
    rmSync(join(destBundleDir(id), "runner", "src"), { force: true });
    const second = await repairInstalledBundleAssets({ appBundles: repoRoot, run: fakeRunner() });
    assert.deepEqual(second.errors, []);
    assert.ok(second.repaired.some((r) => r.includes(`${id}: refreshed 0.1.0 -> 0.2.0`)), JSON.stringify(second.repaired));
    assert.ok(runnerRefreshed(id));
    assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "0.2.0");
  });
});
