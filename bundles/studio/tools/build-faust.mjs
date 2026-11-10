#!/usr/bin/env node
/**
 * Build Studio's Faust effects: compile every `effects/*.dsp` to WebAssembly,
 * lint the compiled metadata for a licence Crow may ship, and write the result.
 *
 *     node bundles/studio/tools/build-faust.mjs          # (re)write the output
 *     node bundles/studio/tools/build-faust.mjs --check  # CI: refuse stale output
 *
 * ## Why a build step at all
 *
 * A worklet cannot run Faust: the compiler (`libfaust`, ~10 MB of wasm) belongs
 * in a build. What ships is the compiled DSP — one `<kind>.wasm` per effect, the
 * bytes `WebAssembly.compile()` takes — plus the factory JSON the runtime needs
 * to find each control's parameter offset. `@grame/faustwasm` (LGPL-2.1) is a
 * root devDependency and stays at build time: `engine/faust-host.js` instantiates
 * the compiled modules itself, and supplies the `env` imports they ask for
 * (the math functions Faust's wasm calls out to), so nothing at runtime depends
 * on the compiler.
 *
 * ## The licence lint
 *
 * Faust's libraries are licensed PER FUNCTION, and the GPL-only ones (all of
 * `co.*`, `vital_rev`, `kb_rom_rev1`) may not be shipped in Crow. The compiled
 * meta JSON lists, as an array of one-key objects, every licence declaration the
 * program carries:
 *
 *     {"compressors.lib/compressor_mono:license": "GPL-3.0-only"}
 *     {"signals.lib/onePoleSwitching:licence": "LicenseRef-STK-4.3"}
 *     {"maths.lib/license": "LicenseRef-LGPL-2.1-or-later-with-Faust-exception"}
 *
 * Both spellings of the key (`license`, `licence`) occur. A function with no
 * entry of its own inherits its library's `<lib>.lib/license` entry, which is
 * why the library-level entries are linted too: a library that declares a
 * copyleft licence refuses the build even when the one function used from it
 * happens to carry a permissive entry of its own (the meta cannot say which of
 * that library's other functions were inlined). A program whose meta carries no
 * licence entry at all is refused as unknown — that is a compile whose terms
 * nobody can state.
 *
 * `lintMeta` is exported as a pure function so the tests can feed it a meta
 * array directly as well as a compiled one.
 *
 * ## What it produces (bundles/studio/vendor/faust/)
 *
 *   <kind>.wasm               the compiled mono DSP, as the factory returned it
 *   <kind>.json               the factory JSON (parameter paths/indices, size)
 *   LICENSES.json             kind → sorted [{function, licence}]
 *   NOTICES.md                the per-kind licence table and the STK 4.3 text
 *   README.md                 the banner: what this is, and faustwasm's version
 *   LICENSE-faustwasm.txt     faustwasm's own licence, verbatim (COPYING.txt)
 *
 * Everything is deterministic — sorted keys, no timestamps — so the same
 * sources and the same installed faustwasm produce byte-identical output.
 * `--check` compiles to memory, byte-compares the checked-in files and refuses
 * when one is stale or missing, naming it. CI runs it, so a Faust library that
 * changed under us (a dependency bump) fails the static checks instead of
 * shipping an un-linted effect.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/** The bundle root: `bundles/studio`. */
export const BUNDLE_DIR = dirname(TOOLS_DIR);

/** Where the Faust sources live. */
export const SOURCE_DIR = join(BUNDLE_DIR, "effects");

/** Where the compiled effects, their licences and the notices live. */
export const VENDOR_DIR = join(BUNDLE_DIR, "vendor", "faust");

/** The compiler package this build uses, at build time only. */
const FAUSTWASM_PACKAGE = "@grame/faustwasm";

/**
 * The licences Crow may ship Faust-generated code under, normalised to what a
 * library declares. Exactly these four families, and nothing else:
 *
 * - MIT;
 * - BSD-2-Clause and BSD-3-Clause;
 * - STK-4.3 (Faust spells it both `LicenseRef-STK-4.3` per function and
 *   `STK-4.3` at the library level; it is the same permissive, MIT-style
 *   licence, so both spellings are accepted);
 * - LGPL-2.1 with the Faust exception (again spelled several ways: `LGPL-2.1+`,
 *   `LGPL-2.1-only`, `LGPL with exception`).
 *
 * Everything else refuses the build and names the function and its licence.
 */
const ALLOWED_EXACT = Object.freeze(["MIT", "BSD-2-Clause", "BSD-3-Clause"]);

/** STK 4.3, however a library spells it. */
const STK_LICENCE = /^(?:LicenseRef-)?STK-4\.3$/i;

/** LGPL-2.1 with the Faust exception, however a library spells it. */
const LGPL_FAUST_EXCEPTION =
  /^(?:LicenseRef-)?LGPL(?:-2\.1(?:-only|-or-later|\+)?)?(?:-|[ ])with(?:-|[ ])(?:Faust(?:-|[ ]))?exception$/i;

/** What a licence entry is called when the meta carries none at all. */
const UNKNOWN_LICENCE = "unknown";

/**
 * @param {string} licence one licence id as a Faust library declares it
 * @returns {boolean} whether Crow may ship code under it
 */
export function isAllowedLicence(licence) {
  const value = String(licence == null ? "" : licence).trim();
  if (value === "") return false;
  if (ALLOWED_EXACT.includes(value)) return true;
  return STK_LICENCE.test(value) || LGPL_FAUST_EXCEPTION.test(value);
}

/**
 * Lint a compiled program's meta array — the licence gate the whole task exists
 * for. Pure: it reads the array and returns a verdict, so a test can hand it a
 * hand-written array as easily as a compiled one.
 *
 * @param {Array<Object<string, string>>|null} meta the factory JSON's `meta`
 * @returns {{ok: boolean, refused: Array<{function: string, licence: string}>,
 *            accepted: Array<{function: string, licence: string}>,
 *            unknown: boolean}}
 *   `refused` names each function (or library) whose licence may not ship, with
 *   the licence it declared; `accepted` is everything the lint let through;
 *   `unknown` says the program carried no licence entry at all.
 */
/**
 * Compare two strings by UTF-16 code units, as Array.prototype.sort does by
 * default. Never localeCompare: the output is checked in, and a locale-aware
 * order can differ between machines, so `--check` would flap.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function lintMeta(meta) {
  const refused = [];
  const accepted = [];
  const list = Array.isArray(meta) ? meta : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    for (const [key, value] of Object.entries(entry)) {
      // `<library>.lib/<function>:license`, or the library's own
      // `<library>.lib/license`. Any other key (a program-level `declare name`,
      // a parameter's `declare` inside a control) is not a licence claim.
      const match = /^([^/]+)\/(?:([^:]+):)?(licen[cs]e)$/.exec(key);
      if (!match) continue;
      const where = match[2] ? `${match[1]}/${match[2]}` : match[1];
      const licence = String(value == null ? "" : value).trim();
      if (isAllowedLicence(licence)) accepted.push({ function: where, licence });
      else refused.push({ function: where, licence });
    }
  }
  if (accepted.length === 0 && refused.length === 0) {
    return {
      ok: false,
      refused: [{ function: "(the compiled program)", licence: UNKNOWN_LICENCE }],
      accepted,
      unknown: true,
    };
  }
  return { ok: refused.length === 0, refused, accepted, unknown: false };
}

/**
 * A sentence naming each refused function and its licence, for the build's
 * stderr and for a test's assertion message.
 * @param {string} kind the effect
 * @param {ReturnType<typeof lintMeta>} lint
 * @returns {string}
 */
export function refusalMessage(kind, lint) {
  const parts = lint.refused.map((item) => `${item.function} (${item.licence})`).join(", ");
  if (lint.unknown) {
    return `${kind}.dsp compiled to a program whose meta names no licence at all, so Crow cannot state its terms`;
  }
  return `${kind}.dsp uses a function Crow may not ship: ${parts}`;
}

/**
 * Find one installed package's directory: resolve a file inside it the way Node
 * would, then walk up to the nearest `package.json`.
 * @param {string} name
 * @param {string} [entry] a subpath to resolve
 * @returns {string}
 */
function packageDir(name, entry = "") {
  let dir = dirname(fileURLToPath(import.meta.resolve(entry ? `${name}/${entry}` : name)));
  for (let up = 0; up < 8; up += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`build-faust: could not find the package directory for ${name}`);
}

/**
 * The installed faustwasm: its version, its licence, and its own licence text.
 * @returns {{name: string, version: string, license: string, licenceText: string,
 *            dir: string}}
 */
export function faustwasmInfo() {
  const dir = packageDir(FAUSTWASM_PACKAGE, "dist/esm/index.js");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // The package ships its LGPL text as COPYING.txt and no LICENSE file.
  const licenceFile = ["LICENSE", "COPYING.txt", "COPYING"].find((name) =>
    existsSync(join(dir, name)),
  );
  if (!licenceFile) throw new Error("build-faust: faustwasm ships no licence file to copy");
  const licenceText = readFileSync(join(dir, licenceFile), "utf8");
  if (!licenceText.trim()) throw new Error("build-faust: faustwasm's licence file is empty");
  return {
    name: FAUSTWASM_PACKAGE,
    version: String(manifest.version ?? "unknown"),
    license: String(manifest.license ?? "see COPYING.txt"),
    licenceText,
    dir,
  };
}

/** The compiler, built once per process (instantiating libfaust takes a moment). */
let compilerPromise = null;

/**
 * The Faust compiler: faustwasm's ESM entry, and the libfaust module it carries.
 *
 * `instantiateFaustModuleFromFile` is the package's own Node loader. It reads the
 * Emscripten glue with `fs`, wraps it in a module that defines `require` (the
 * glue reaches for `node:fs` on its Node branch) and imports that, writing one
 * short-lived file beside the glue; the package's pre-bundled ESM build cannot
 * be used here, because the same `require` comes out as a bare call there and a
 * Node ESM module has none.
 * @returns {Promise<object>} a `FaustCompiler`
 */
async function faustCompiler() {
  if (compilerPromise) return compilerPromise;
  compilerPromise = (async () => {
    const { dir } = faustwasmInfo();
    const FW = await import(pathToFileURL(join(dir, "dist", "esm", "index.js")).href);
    const module = await FW.instantiateFaustModuleFromFile(join(dir, "libfaust-wasm", "libfaust-wasm.js"));
    return new FW.FaustCompiler(new FW.LibFaust(module));
  })();
  return compilerPromise;
}

/**
 * The effects to build: every `effects/*.dsp`, in sorted order. The sources are
 * the list — a new effect is a new file, and the document's `EFFECT_PARAMS` is
 * what its controls are pinned to by a test.
 * @returns {string[]} the effect names, sorted
 */
export function effectKinds() {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".dsp"))
    .map((name) => name.slice(0, -".dsp".length))
    .sort();
}

/**
 * Compile one effect WITHOUT judging its licence: the raw result, for the lint's
 * own tests and for `compileEffect` below.
 * @param {string} kind the effect's name (its `.dsp` file's base name)
 * @param {string} source the Faust source
 * @returns {Promise<{kind: string, wasm: Buffer, json: string, meta: object[],
 *                    lint: ReturnType<typeof lintMeta>}>}
 * @throws {Error} when the source does not compile
 */
export async function compileProgram(kind, source) {
  const compiler = await faustCompiler();
  let factory;
  try {
    factory = await compiler.createMonoDSPFactory(kind, source, "");
  } catch (error) {
    throw new Error(`build-faust: ${kind}.dsp did not compile: ${error?.message || error}`);
  }
  if (!factory) throw new Error(`build-faust: ${kind}.dsp produced no factory`);
  const json = String(factory.json);
  const meta = JSON.parse(json).meta;
  return { kind, wasm: Buffer.from(factory.code), json, meta, lint: lintMeta(meta) };
}

/**
 * Compile one effect, refusing it when its licence may not ship.
 * @param {string} kind the effect's name (its `.dsp` file's base name)
 * @param {string} source the Faust source
 * @returns {Promise<{kind: string, wasm: Buffer, json: string, meta: object[],
 *                    lint: ReturnType<typeof lintMeta>}>}
 * @throws {Error} when the source does not compile, or its licence may not ship
 */
export async function compileEffect(kind, source) {
  const effect = await compileProgram(kind, source);
  if (!effect.lint.ok) throw new Error(`build-faust: ${refusalMessage(kind, effect.lint)}`);
  return effect;
}

/**
 * One effect's licence entries, deduplicated and sorted, as `LICENSES.json`
 * holds them: the function's meta name (`fi.lib/low_shelf`, or the library
 * itself for a library-level entry) and the licence it declared.
 * @param {Array<{function: string, licence: string}>} accepted
 * @returns {Array<{function: string, licence: string}>}
 */
function sortedLicences(accepted) {
  const seen = new Map();
  for (const item of accepted) seen.set(`${item.function}\u0000${item.licence}`, item);
  return [...seen.values()].sort((a, b) =>
    a.function === b.function
      ? byCodePoint(a.licence, b.licence)
      : byCodePoint(a.function, b.function),
  );
}

/**
 * Parse the STK 4.3 licence text out of the Faust libraries the compiler
 * carries. `wdmodels.lib` ships the licence appendix the Faust documentation
 * links to, so the text is taken from there verbatim (only trailing whitespace
 * is dropped, which is what makes it stable in a file people edit).
 * @param {string} dir the faustwasm package directory
 * @returns {string} the licence text, or "" when this package does not carry it
 */
export function stkNoticeText(dir) {
  const data = join(dir, "libfaust-wasm", "libfaust-wasm.data");
  if (!existsSync(data)) return "";
  const text = readFileSync(data, "utf8");
  const heading = "## STK 4.3 License";
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const end = text.indexOf("\n--------------------", start);
  if (end < 0) return "";
  const body = text
    .slice(start + heading.length, end)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
  return body.includes("Permission is hereby granted") ? body : "";
}

/**
 * The README (the banner): what the directory is, and the compiler's version and
 * licence.
 * @param {ReturnType<typeof faustwasmInfo>} info
 * @returns {string}
 */
export function readmeText(info) {
  return [
    "# Studio's Faust effects",
    "",
    "Generated by `bundles/studio/tools/build-faust.mjs` — do not edit by hand.",
    "",
    "Each `<kind>.wasm` is one effect from `bundles/studio/effects/<kind>.dsp`,",
    "compiled by the Faust compiler to a WebAssembly module, and each",
    "`<kind>.json` is the factory JSON that came with it: the runtime reads a",
    "control's parameter offset, range and default out of it",
    "(`engine/faust-host.js`), and a test compares its controls with the song",
    "document's `EFFECT_PARAMS`.",
    "",
    "The compiler, at build time only:",
    "",
    `  ${info.name} ${info.version} (${info.license})`,
    "",
    "Its licence is copied verbatim next to this file",
    "(`LICENSE-faustwasm.txt`); nothing at runtime loads the compiler, and the",
    "compiled effects carry no Faust compiler code.",
    "",
    "## Licences of what the compiled effects use",
    "",
    "`LICENSES.json` lists, per effect, every licence the compiled program's meta",
    "declared, and `NOTICES.md` carries the STK 4.3 text those functions are",
    "offered under. The build refuses any function whose licence Crow may not",
    "ship — the GPL-only and AGPL-only ones included — so this directory only",
    "ever holds permissively licensed code.",
    "",
  ].join("\n");
}

/**
 * The Faust libraries a compiled program used that declared no licence at all.
 *
 * The compiler emits a licence entry only where a library declares one, so a
 * meta-driven lint cannot see the terms of a function whose library is silent.
 * This is that gap, named: the library list goes into NOTICES.md so the gap is
 * on the record rather than implied. (In practice these are Faust's own
 * libraries — `delays.lib`, `phaflangers.lib`, `basics.lib`, `signals.lib` —
 * whose file headers carry the STK-4.3 / LGPL-with-Faust-exception notice the
 * functions above them declare.)
 * @param {Array<Object<string, string>>} meta a compiled program's meta array
 * @returns {string[]} the libraries with no licence entry anywhere, sorted
 */
export function undeclaredLibraries(meta) {
  const libraries = new Set();
  const declared = new Set();
  for (const entry of Array.isArray(meta) ? meta : []) {
    if (!entry || typeof entry !== "object") continue;
    for (const key of Object.keys(entry)) {
      const match = /^([^/]+\.lib)\//.exec(key);
      if (!match) continue;
      libraries.add(match[1]);
      if (/:licen[cs]e$/.test(key) || /^[^/]+\/licen[cs]e$/.test(key)) declared.add(match[1]);
    }
  }
  return [...libraries].filter((name) => !declared.has(name)).sort();
}

/**
 * The notices: the per-kind licence table, the permissive licences in full where
 * they ask for a notice, and where each text came from.
 * @param {Object<string, Array<{function: string, licence: string}>>} licences
 * @param {string} stkText
 * @param {Object<string, string[]>} [undeclared] kind → the libraries with no
 *   licence declaration, as `undeclaredLibraries` finds them
 * @returns {string}
 */
export function noticesText(licences, stkText, undeclared = {}) {
  const kinds = Object.keys(licences).sort();
  const lines = [
    "# Faust effect licences",
    "",
    "Studio's Faust effects are compiled from `bundles/studio/effects/*.dsp` with",
    "the Faust compiler (`@grame/faustwasm`, at build time only). The Faust",
    "standard library is licensed per function, so each compiled effect carries",
    "the union of the licences its functions declared. The build's licence lint",
    "allows only MIT, BSD-2-Clause, BSD-3-Clause, STK-4.3 and LGPL-2.1 with the",
    "Faust exception; everything else refuses the build.",
    "",
    "## What each effect uses",
    "",
  ];
  for (const kind of kinds) {
    const entries = licences[kind];
    lines.push(`### ${kind}`, "");
    const byLicence = new Map();
    for (const entry of entries) {
      const list = byLicence.get(entry.licence) || [];
      list.push(entry.function);
      byLicence.set(entry.licence, list);
    }
    for (const licence of [...byLicence.keys()].sort()) {
      const functions = byLicence.get(licence).sort();
      lines.push(`- ${licence}: ${functions.map((name) => `\`${name}\``).join(", ")}`);
    }
    lines.push("");
  }
  const silent = kinds.filter((kind) => (undeclared[kind] || []).length > 0);
  if (silent.length > 0) {
    lines.push(
      "## Libraries that declare no licence",
      "",
      "The compiler emits a licence entry only for a function or library that",
      "declares one. These libraries were used without a declaration, so the",
      "compiled meta states no terms for their functions. Every licence it DOES",
      "state is listed above and passed the lint; the silent ones are Faust's own",
      "libraries, whose file headers carry the STK-4.3 or LGPL-with-Faust-exception",
      "notice the declarations next to them use.",
      "",
    );
    for (const kind of silent) lines.push(`- ${kind}: ${undeclared[kind].join(", ")}`);
    lines.push("");
  }
  lines.push(
    "## Notes",
    "",
    "- **MIT** and **BSD** entries need no text of their own here: the Faust",
    "  libraries that declare them ship their own notices in",
    "  `node_modules/@grame/faustwasm` (the compiler package), and both licences",
    "  ask only that the copyright notice travel with the code. The functions",
    "  this directory uses under MIT are `re.jpverb` (Julian Parker, with fixes",
    "  by Till Bovermann) and the phaser/allpass functions of the phaser library",
    "  (Julius O. Smith III).",
    "- **LicenseRef-LGPL-2.1-or-later-with-Faust-exception** is the LGPL with the",
    "  Faust exception that lets generated code ship under Crow's own terms.",
    "- **STK-4.3** is the permissive, MIT-style licence of the Synthesis ToolKit,",
    "  which the filter and effect libraries' `jos` sections carry. Its text is",
    "  below.",
    "",
  );
  if (stkText) {
    lines.push(
      "## STK 4.3",
      "",
      "Taken verbatim from the Faust libraries the compiler ships, in",
      "`libfaust-wasm.data`: the licence appendix of `wdmodels.lib` (the text the",
      "Faust documentation links to as `stk-4.3-license`). Trailing whitespace is",
      "the only edit.",
      "",
      "```text",
      stkText,
      "```",
      "",
    );
  } else {
    lines.push(
      "## STK 4.3",
      "",
      "The installed Faust package does not carry the STK-4.3 text, so none is",
      "reproduced here. It is the standard Synthesis ToolKit 4.3 licence:",
      "permission is granted, free of charge, to use, copy, modify, merge,",
      "publish, distribute, sublicense and sell the software, provided the",
      "copyright notice and permission notice are included, with no warranty.",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Build everything in memory.
 * @returns {Promise<{files: Map<string, Buffer|string>,
 *                    licences: Object<string, Array<{function: string, licence: string}>>,
 *                    info: ReturnType<typeof faustwasmInfo>}>}
 */
export async function buildFaust() {
  const info = faustwasmInfo();
  const kinds = effectKinds();
  if (kinds.length === 0) throw new Error("build-faust: no effects/*.dsp to build");
  const files = new Map();
  const licences = {};
  const undeclared = {};
  for (const kind of kinds) {
    const source = readFileSync(join(SOURCE_DIR, `${kind}.dsp`), "utf8");
    const effect = await compileEffect(kind, source);
    files.set(`${kind}.wasm`, effect.wasm);
    files.set(`${kind}.json`, effect.json);
    licences[kind] = sortedLicences(effect.lint.accepted);
    undeclared[kind] = undeclaredLibraries(effect.meta);
  }
  // Sorted keys, so two runs of the same sources produce the same bytes.
  const sortedKinds = {};
  for (const kind of Object.keys(licences).sort()) sortedKinds[kind] = licences[kind];
  files.set("LICENSES.json", `${JSON.stringify(sortedKinds, null, 2)}\n`);
  files.set("NOTICES.md", noticesText(sortedKinds, stkNoticeText(info.dir), undeclared));
  files.set("README.md", readmeText(info));
  files.set("LICENSE-faustwasm.txt", info.licenceText);
  return { files, licences: sortedKinds, info };
}

/**
 * Write a build's files into a directory.
 * @param {{files: Map<string, Buffer|string>}} built
 * @param {string} [dir]
 * @returns {string[]} the files written
 */
export function writeFaust(built, dir = VENDOR_DIR) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, contents] of built.files) {
    const file = join(dir, name);
    writeFileSync(file, contents, typeof contents === "string" ? { encoding: "utf8" } : undefined);
    written.push(file);
  }
  return written;
}

/**
 * A short description of how one checked-in file differs from the build.
 * @param {Buffer|string} actual the build's bytes
 * @param {Buffer|string|undefined} expected the file on disk
 * @returns {string}
 */
function difference(actual, expected) {
  if (expected === undefined) return "is missing";
  const left = Buffer.isBuffer(actual) ? actual : Buffer.from(String(actual), "utf8");
  const right = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), "utf8");
  let at = 0;
  const limit = Math.min(left.length, right.length);
  while (at < limit && left[at] === right[at]) at += 1;
  return `differs at byte ${at} (build ${left.length} bytes, file ${right.length} bytes)`;
}

/**
 * Refuse when the checked-in output is not what this script would produce.
 * @param {{files: Map<string, Buffer|string>}} built
 * @param {string} [dir]
 * @returns {string[]} what is stale, and how
 */
export function staleOutput(built, dir = VENDOR_DIR) {
  const stale = [];
  for (const [name, contents] of built.files) {
    const file = join(dir, name);
    const onDisk = existsSync(file) ? readFileSync(file) : undefined;
    const expected = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
    if (onDisk === undefined || !onDisk.equals(expected)) {
      stale.push(`${file} ${difference(contents, onDisk)}`);
    }
  }
  // And a file the build would no longer produce (an effect that was removed or
  // renamed) is stale too: --check must not pass while a dead effect ships.
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (built.files.has(name)) continue;
      stale.push(`${join(dir, name)} is not part of this build`);
    }
  }
  return stale;
}

/** The command line: `--check` refuses stale output, anything else rebuilds. */
async function main(argv) {
  const check = argv.includes("--check");
  const built = await buildFaust();
  if (check) {
    const stale = staleOutput(built);
    if (stale.length > 0) {
      console.error("build-faust: the checked-in effects are stale:");
      for (const file of stale) console.error(`  ${file}`);
      console.error("Run: node bundles/studio/tools/build-faust.mjs");
      process.exitCode = 1;
      return;
    }
    console.log(`build-faust: up to date (${built.files.size} files)`);
    return;
  }
  for (const file of writeFaust(built)) console.log(`build-faust: wrote ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}