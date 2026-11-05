#!/usr/bin/env node
/**
 * Build Studio's vendored JavaScript: the SoundFont synth, as ONE import-free
 * classic script.
 *
 *     node bundles/studio/tools/build-vendor.mjs          # (re)write the bundle
 *     node bundles/studio/tools/build-vendor.mjs --check  # CI: refuse stale output
 *
 * ## Why a build step at all
 *
 * `spessasynth_core` is an ES module with two bare imports of its own
 * (`fflate` for SF3's Ogg Vorbis blocks, `stb-vorbis` for the decoder). A
 * worklet cannot `import`, and `engine-client.js` builds the worklet module by
 * gluing classic scripts together (`SOURCE_FILES`), so the synth has to arrive
 * as one script that defines a global and imports nothing. SunVox is vendored
 * the same way; this is that vendor step, checked in.
 *
 * ## What it produces
 *
 *   vendor/spessasynth/spessasynth.js   the IIFE bundle (globalThis.StudioSpessa)
 *   vendor/spessasynth/LICENSE-*.txt    each package's own licence, verbatim
 *
 * The bundle is `format: "iife"` under the global name `StudioSpessa`, with
 * `platform: "neutral"` and the `browser` condition — so `fflate` resolves to
 * its browser build, not the Node one that reaches for `worker_threads`. It is
 * not minified (`minify: false`) and keeps every legal comment in place
 * (`legalComments: "inline"`), because the file is checked in and read by
 * people: a licence line that disappeared in a build would be a licence bug.
 * A banner names the three packages, their versions and their licences.
 *
 * After esbuild returns, the output is scanned for the Node-shaped things a
 * worklet scope does not have — `require(`, `process.`, a `node:` import, a
 * bare `import(` — and the build REFUSES rather than check in a script that
 * would throw in an `AudioWorkletGlobalScope`. That check is the reason this
 * script exists instead of a one-line `esbuild` invocation: `callSunVoxFactory`
 * in `studio-processor.js` has to hide `process` from Emscripten by hand, and a
 * vendored bundle that needs the same trick is a bundle that should be fixed
 * at build time instead.
 *
 * `--check` builds to memory and byte-compares against the checked-in file (and
 * against each licence copy), refusing when anything differs. CI runs it, so a
 * dependency bump that nobody re-vendored fails the static checks.
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/** The bundle root: `bundles/studio`. */
export const BUNDLE_DIR = dirname(TOOLS_DIR);

/** Where the built script and its licences live. */
export const VENDOR_DIR = join(BUNDLE_DIR, "vendor", "spessasynth");

/** The one file a worklet loads. */
export const OUT_FILE = join(VENDOR_DIR, "spessasynth.js");

/** The global the bundle defines; `SOURCE_FILES` relies on this name. */
export const GLOBAL_NAME = "StudioSpessa";

/**
 * What goes into the bundle, and the licence file each one's own LICENSE
 * becomes. `spessasynth_core` is the entry; the other two are its imports, and
 * they are named here so the banner and the licence copies cannot drift from
 * what esbuild actually inlined.
 */
const PACKAGES = [
  { name: "spessasynth_core", licenceFile: "LICENSE-spessasynth_core.txt" },
  { name: "fflate", licenceFile: "LICENSE-fflate.txt" },
  { name: "stb-vorbis", licenceFile: "LICENSE-stb-vorbis.txt" },
];

/**
 * The entry esbuild bundles. A virtual module, so the bundle is
 * `export * from "spessasynth_core"` and nothing else: the IIFE's value is the
 * package's own namespace, which is what `StudioSpessa.SpessaSynthProcessor`
 * reads.
 */
const ENTRY = 'export * from "spessasynth_core";\n';

/**
 * The Node-shaped things an `AudioWorkletGlobalScope` does not have. A match
 * means the bundle would throw in the worklet, so the build refuses. The
 * patterns are deliberately narrow: `process` is only a problem as the Node
 * global (`process.env`, and not a method called `process()` nor the word
 * "process." at the end of a comment).
 */
const FORBIDDEN = [
  { pattern: /\brequire\s*\(/, what: "a require() call" },
  { pattern: /(?<![\w$.])process\.[A-Za-z_$]/, what: "a process.* read" },
  { pattern: /(?:from|import)\s*\(?\s*["']node:/, what: "a node: import" },
  { pattern: /\b__dirname\b/, what: "__dirname" },
  { pattern: /\bworker_threads\b/, what: "worker_threads" },
];

/**
 * Find one package's directory on disk: resolve its entry from this file, then
 * walk up to the nearest `package.json`. That is the copy esbuild will inline,
 * and the copy whose version and LICENSE belong in the banner and vendor dir.
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
  throw new Error(`build-vendor: could not find the package directory for ${name}`);
}

/**
 * One package's version, licence and LICENSE text.
 * @param {{name: string, licenceFile: string}} spec
 * @returns {{name: string, version: string, license: string, licenceFile: string,
 *            licenceText: string}}
 */
function packageInfo(spec) {
  const dir = packageDir(spec.name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenceText = readFileSync(join(dir, "LICENSE"), "utf8");
  if (!licenceText.trim()) {
    throw new Error(`build-vendor: ${spec.name} has an empty LICENSE file`);
  }
  return {
    name: spec.name,
    version: String(manifest.version ?? "unknown"),
    license: String(manifest.license ?? manifest.licences ?? "see LICENSE"),
    licenceFile: spec.licenceFile,
    licenceText,
  };
}

/**
 * The banner at the top of the checked-in script: what is in it, which
 * versions, and under which licences.
 * @param {ReturnType<typeof packageInfo>[]} packages
 * @returns {string}
 */
function bannerFor(packages) {
  const lines = [
    "/*!",
    " * Studio's vendored SoundFont synth.",
    " *",
    " * Generated by bundles/studio/tools/build-vendor.mjs — do not edit by hand.",
    " * One import-free classic script: it defines globalThis.StudioSpessa and",
    " * nothing else, so it can be glued into the AudioWorklet module with the",
    " * other engine sources (engine/engine-client.js, SOURCE_FILES).",
    " *",
    " * Bundled packages, at the versions npm installed (see package-lock):",
  ];
  for (const pkg of packages) {
    lines.push(` *   ${pkg.name} ${pkg.version} (${pkg.license})`);
  }
  lines.push(
    " *",
    " * Licences: verbatim copies of each package's LICENSE sit next to this",
    " * file (LICENSE-*.txt); bundles/studio/vendor/THIRD-PARTY-NOTICES.md",
    " * repeats them for the Extensions page's third-party list.",
    " */",
    "",
  );
  return lines.join("\n");
}

/**
 * Refuse a bundle that would not run in a worklet scope.
 * @param {string} code the built script
 * @returns {void}
 * @throws {Error} naming the first Node-shaped construct found
 */
function assertWorkletSafe(code) {
  for (const { pattern, what } of FORBIDDEN) {
    const match = pattern.exec(code);
    if (!match) continue;
    const at = Math.max(0, match.index);
    const line = code.slice(0, at).split("\n").length;
    const snippet = code.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, " ");
    throw new Error(
      `build-vendor: the bundle contains ${what} (line ${line}), which an AudioWorkletGlobalScope does not have; ` +
        `fix the package's Node branch or alias its browser build in tools/build-vendor.mjs. Near: ${snippet}`,
    );
  }
}

/**
 * Build the bundle in memory.
 * @returns {Promise<{code: string, packages: ReturnType<typeof packageInfo>[],
 *                    licences: Map<string, string>}>}
 */
export async function buildVendor() {
  const packages = PACKAGES.map(packageInfo);
  const result = await build({
    // Pinned, so the source paths esbuild writes into its `//` comments do not
    // depend on the directory the build was started from (`--check` compares
    // bytes).
    absWorkingDir: BUNDLE_DIR,
    stdin: { contents: ENTRY, resolveDir: BUNDLE_DIR, sourcefile: "studio-vendor-entry.js" },
    bundle: true,
    write: false,
    format: "iife",
    globalName: GLOBAL_NAME,
    // `neutral` keeps Node's conditions out; `browser` puts fflate's browser
    // build in (its Node build requires worker_threads).
    platform: "neutral",
    conditions: ["browser"],
    // `spessasynth_core` publishes `main`/`module` and no `exports`, while
    // fflate and stb-vorbis branch on `exports` (which esbuild honours first).
    mainFields: ["browser", "module", "main"],
    target: ["es2020"],
    minify: false,
    legalComments: "inline",
    logLevel: "silent",
    define: {
      // The only Node globals a browser-shaped dependency might still probe.
      global: "globalThis",
      "process.env.NODE_ENV": '"production"',
    },
    banner: { js: bannerFor(packages) },
    // esbuild's IIFE puts the namespace in a module-scoped `var`. The worklet
    // module is an ES module in Node, where that `var` is NOT a global, so the
    // name is published explicitly for both hosts.
    footer: { js: `\nglobalThis.${GLOBAL_NAME} = ${GLOBAL_NAME};\n` },
  });
  if (result.errors.length > 0) {
    throw new Error(`build-vendor: esbuild failed: ${result.errors.map((error) => error.text).join("; ")}`);
  }
  const code = result.outputFiles[0].text;
  assertWorkletSafe(code);
  const licences = new Map(packages.map((pkg) => [pkg.licenceFile, pkg.licenceText]));
  return { code, packages, licences };
}

/**
 * Write the bundle and its licences.
 * @param {{code: string, licences: Map<string, string>}} built
 * @returns {string[]} the files written
 */
export function writeVendor(built) {
  mkdirSync(VENDOR_DIR, { recursive: true });
  const written = [];
  writeFileSync(OUT_FILE, built.code, { encoding: "utf8", mode: 0o644 });
  written.push(OUT_FILE);
  for (const [name, text] of built.licences) {
    const file = join(VENDOR_DIR, name);
    writeFileSync(file, text, { encoding: "utf8", mode: 0o644 });
    written.push(file);
  }
  return written;
}

/**
 * A short description of how one checked-in file differs from the build: its
 * size and the first differing byte, which is what a stale bundle usually needs
 * to be understood.
 * @param {string} actual the build's text
 * @param {string} expected the file on disk
 * @returns {string}
 */
function difference(actual, expected) {
  if (expected === undefined) return "is missing";
  let at = 0;
  const limit = Math.min(actual.length, expected.length);
  while (at < limit && actual[at] === expected[at]) at += 1;
  return `differs at byte ${at} (build ${actual.length} bytes, file ${expected.length} bytes)`;
}

/**
 * Refuse when the checked-in output is not what this script would produce.
 * @param {{code: string, licences: Map<string, string>}} built
 * @returns {string[]} what is stale, and how
 */
export function staleOutput(built) {
  const stale = [];
  const onDisk = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : undefined;
  if (onDisk !== built.code) stale.push(`${OUT_FILE} ${difference(built.code, onDisk)}`);
  for (const [name, text] of built.licences) {
    const file = join(VENDOR_DIR, name);
    const copy = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (copy !== text) stale.push(`${file} ${difference(text, copy)}`);
  }
  return stale;
}

/** The command line: `--check` refuses stale output, anything else rebuilds. */
async function main(argv) {
  const check = argv.includes("--check");
  const built = await buildVendor();
  if (check) {
    const stale = staleOutput(built);
    if (stale.length > 0) {
      console.error("build-vendor: the checked-in vendor bundle is stale:");
      for (const file of stale) console.error(`  ${file}`);
      console.error("Run: node bundles/studio/tools/build-vendor.mjs");
      process.exitCode = 1;
      return;
    }
    console.log(`build-vendor: up to date (${built.code.length} bytes)`);
    return;
  }
  const written = writeVendor(built);
  for (const file of written) console.log(`build-vendor: wrote ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}