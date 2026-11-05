/**
 * The vendored SoundFont synth: one import-free classic script that runs in a
 * worklet scope, and a build that is up to date with its packages.
 *
 * Studio's engine is ONE AudioWorklet module glued from classic scripts
 * (`engine/engine-client.js`, `SOURCE_FILES`), and a worklet cannot `import`.
 * So `spessasynth_core` — an ES module with two bare imports of its own — is
 * bundled by `tools/build-vendor.mjs` into `vendor/spessasynth/spessasynth.js`
 * and checked in. These tests pin the two things that check-in depends on:
 *
 *   1. the script is self-contained and evaluates in a scope with no `require`,
 *      no `process`, no `document` and no `window` — an AudioWorkletGlobalScope
 *      — and `StudioSpessa.SpessaSynthProcessor` is there afterwards; and
 *   2. the checked-in file (and each licence copy) is exactly what the build
 *      produces from the installed packages, so a dependency bump nobody
 *      re-vendored fails here and in CI's `build-vendor --check`.
 *
 * The evaluation is a real one: the whole ~2 MB script is compiled and run in a
 * fresh `vm` context, and the class is instantiated, because a bundle that
 * merely parses is not a bundle that a worklet can load.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const BUNDLE_DIR = fileURLToPath(new URL("../bundles/studio/", import.meta.url));
const VENDOR_DIR = join(BUNDLE_DIR, "vendor", "spessasynth");
const SCRIPT = join(VENDOR_DIR, "spessasynth.js");
const NOTICES = join(BUNDLE_DIR, "vendor", "THIRD-PARTY-NOTICES.md");

/** The root `package.json`, for the versions the banner has to name. */
const rootPackage = JSON.parse(readFileSync(join(BUNDLE_DIR, "..", "..", "package.json"), "utf8"));

/**
 * One package's directory, found the way `tools/build-vendor.mjs` finds it:
 * resolve the entry the way Node would, then walk up to its `package.json`.
 * (`stb-vorbis` publishes no `./package.json` export, so it cannot be resolved
 * as a subpath.)
 * @param {string} name
 * @returns {string}
 */
function packageDir(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (let up = 0; up < 8; up += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the package directory for ${name}`);
}

/** @returns {string} the checked-in vendor script. */
function vendorScript() {
  return readFileSync(SCRIPT, "utf8");
}

/**
 * The globals an `AudioWorkletGlobalScope` has that this bundle might reach
 * for. Deliberately absent: `process`, `require`, `module`, `window`,
 * `document`, `global` and `Buffer` — a bundle that needs one of those cannot
 * run in the worklet, and this test is where that is caught.
 * @returns {object} a fresh context
 */
function workletScope() {
  return {
    WebAssembly,
    TextDecoder,
    TextEncoder,
    Atomics,
    SharedArrayBuffer,
    console,
    performance,
    setTimeout,
    clearTimeout,
  };
}

test("the vendored synth is one script with no imports and loads in a worklet scope", () => {
  const source = vendorScript();

  // One classic script: no module syntax, no CommonJS, no Node built-ins.
  assert.doesNotMatch(source, /^\s*import\s/m, "the bundle must not import anything");
  assert.doesNotMatch(source, /^\s*export\s/m, "the bundle must not export anything");
  assert.doesNotMatch(source, /\brequire\s*\(/, "the bundle must not call require()");
  assert.doesNotMatch(source, /(?<![\w$.])process\.[A-Za-z_$]/, "the bundle must not read the Node global process");
  assert.doesNotMatch(source, /["']node:/, "the bundle must not name a node: module");
  assert.doesNotMatch(source, /\b__dirname\b/, "the bundle must not use __dirname");

  const context = vm.createContext(workletScope());
  // No `process`, no `require`, no `document`, no `window`, no `global`.
  for (const absent of ["process", "require", "module", "window", "document", "global", "Buffer"]) {
    assert.equal(vm.runInContext(`typeof ${absent}`, context), "undefined", `${absent} must not exist in the scope`);
  }

  vm.runInContext(source, context, { filename: "spessasynth.js" });

  assert.equal(typeof context.StudioSpessa, "object", "the bundle must define globalThis.StudioSpessa");
  assert.equal(
    typeof context.StudioSpessa.SpessaSynthProcessor,
    "function",
    "StudioSpessa.SpessaSynthProcessor must be a class the processor can construct",
  );

  // The class really is the synth host: constructing it in the same scope (no
  // Node globals) works and gives an object with the per-channel render call
  // the engine drives.
  const synth = vm.runInContext("new StudioSpessa.SpessaSynthProcessor(48000)", context);
  assert.equal(typeof synth.process, "function", "a processor needs SpessaSynthProcessor.process()");
  assert.equal(typeof synth.soundBankManager, "object", "a processor needs its soundBankManager");
});

test("the vendored bundle names its packages and licences, and carries each licence", () => {
  const source = vendorScript();

  for (const name of ["spessasynth_core", "fflate", "stb-vorbis"]) {
    const dir = packageDir(name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.ok(
      source.slice(0, 2000).includes(`${name} ${manifest.version}`),
      `the banner must name ${name} ${manifest.version}`,
    );
    const copy = join(VENDOR_DIR, `LICENSE-${name}.txt`);
    assert.ok(existsSync(copy), `${copy} must be there`);
    assert.equal(
      readFileSync(copy, "utf8"),
      readFileSync(join(dir, "LICENSE"), "utf8"),
      `${copy} must be the package's own LICENSE, verbatim`,
    );
  }

  // The Extensions page's third-party list repeats all three.
  const notices = readFileSync(NOTICES, "utf8");
  for (const name of ["spessasynth_core", "fflate", "stb-vorbis"]) {
    assert.match(notices, new RegExp(name), `THIRD-PARTY-NOTICES.md must name ${name}`);
  }
});

test("vendor bundles are up to date", () => {
  // esbuild is a build-time devDependency (ruled 2026-11-05): a checkout that
  // lost it cannot rebuild the bundle, so say that plainly here.
  assert.ok(rootPackage.devDependencies?.esbuild, "esbuild must stay a root devDependency");

  // `--check` rebuilds to memory and byte-compares. Its own exit code is the
  // assertion; the output says which file is stale when it refuses.
  const output = execFileSync(process.execPath, [join(BUNDLE_DIR, "tools", "build-vendor.mjs"), "--check"], {
    cwd: BUNDLE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /up to date/, "a fresh vendor bundle says so");
});