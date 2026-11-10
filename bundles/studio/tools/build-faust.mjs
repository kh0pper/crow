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
 * Declarations are only half the story, because Faust's own libraries are not
 * uniformly declared:
 *
 * 1. **Undeclared libraries.** A library with no `declare license` anywhere
 *    contributes no licence entry at all, so a meta-driven lint cannot see it.
 *    Those libraries are refused unless `REVIEWED_UNDECLARED` below lists the
 *    library AT THAT VERSION, with the terms its file header states in a
 *    comment. A faustwasm upgrade that bumps a library changes its version and
 *    so refuses until someone reads the new header — which is the point.
 * 2. **Comment-only GPL.** `basics.lib`'s `sliding*` block is GPL-3.0-only,
 *    declared in a `// SPDX-License-Identifier: GPL-3.0` comment and in no
 *    `declare` at all, so the meta is silent about it; and permissively
 *    declared functions call it (`filters.lib/avg_rect` is `ba.slidingMean`,
 *    `co.RMS_compression_gain_mono_db` is `ba.slidingRMS`). `COMMENT_ONLY_GPL`
 *    below is the denylist of both, refused by name from the compiled meta AND
 *    from the `.dsp` source text.
 *
 * The denylist is maintained by review, not derived: the meta records the
 * licences a program's own functions declare, not the call graph under them, so
 * a new path into that code (a new effect, a faustwasm upgrade) is a thing to
 * read for. NOTICES.md says so too.
 *
 * The effects are compiled with `-ftz 2`, so denormals are flushed inside the
 * DSP's own state (a deterministic bit mask, bit-identical in Chromium and
 * Node) and not only at the host's output (`engine/faust-host.js` flushes that
 * too, which is what catches a value a module computes without storing it).
 *
 * `lintMeta` is exported as a pure function so the tests can feed it a meta
 * array directly as well as a compiled one; `lintSource` lints a `.dsp`'s text,
 * and `compileProgram` runs both through `lintProgram`.
 *
 * ## What it produces (bundles/studio/vendor/faust/)
 *
 *   <kind>.wasm               the compiled mono DSP, as the factory returned it
 *   <kind>.json               the factory JSON (parameter paths/indices, size)
 *   LICENSES.json             kind → sorted [{function, licence}]
 *   NOTICES.md                how the lint decides, the per-kind licence table,
 *                             the reviewed undeclared libraries, every
 *                             author/copyright line the metas carry, and the
 *                             MIT and STK 4.3 texts
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

/** What a licence entry is called when the library declared none. */
const NO_DECLARATION = "no licence declaration";

/** The version a library is reported at when its meta carries none. */
const UNKNOWN_VERSION = "unknown";

/**
 * The licence GPL-only code is reported under when only a comment states it.
 * Deliberately spelled out: the compiled meta names no licence for it at all, so
 * a reader of a refusal has to be told where the GPL claim comes from.
 */
const COMMENT_ONLY_GPL_LICENCE = "GPL-3.0 (declared only in a comment)";

/**
 * The Faust libraries Crow may use even though they declare NO licence, keyed by
 * library AND by the version the compiler's meta reports.
 *
 * The compiler copies a library's `declare license` into the compiled meta and
 * nothing else, so a library whose terms live only in its file header is
 * invisible to a meta-driven lint — it would pass whatever its header says. Each
 * entry below is a header someone read: the terms stated, and where in
 * `node_modules/@grame/faustwasm/libfaust-wasm/libfaust-wasm.data` they are (the
 * Faust libraries as the compiler ships them, quoted so the citation survives a
 * package upgrade the way the version pin does not).
 *
 * The version is part of the key on purpose: `faustwasm` upgrades have changed
 * these files, so a new version refuses the build — "<lib> <version> has no
 * licence declaration and is not on the reviewed list" — until its header has
 * been read and this list updated. That is the whole point of the pin.
 *
 * `oscillators.lib` is here although the task that added this list named six
 * libraries: `reverb` reaches it through `re.jpverb`'s LFO, and the build's own
 * undeclared-library report said so. `signals.lib` is v1.8.0 and `routes.lib`
 * v1.4.1 (the two names are easy to swap: the file whose banner says
 * `signals.lib` declares "Faust Routing Library" v1.8.0).
 *
 * @type {ReadonlyArray<{library: string, version: string, licence: string}>}
 */
export const REVIEWED_UNDECLARED = Object.freeze([
  Object.freeze({
    library: "basics.lib",
    version: "1.23.6",
    licence:
      "LGPL-2.1-or-later with the Faust exception (GRAME header comment, libfaust-wasm.data ~4238-4268; its 'further contributions' note, ~4201-4210, says code without an indication of its own is 'expected' to be LGPL, STK-4.3, MIT, BSD or similar)",
  }),
  Object.freeze({
    library: "delays.lib",
    version: "1.3.3",
    licence:
      "LGPL-2.1-or-later with the Faust exception (header comment, libfaust-wasm.data ~11392-11421)",
  }),
  Object.freeze({
    library: "oscillators.lib",
    version: "1.9.5",
    licence:
      "LGPL-2.1-or-later with the Faust exception (GRAME header comment, libfaust-wasm.data ~42320-42360); the functions Crow uses from it declare their own STK-4.3",
  }),
  Object.freeze({
    library: "phaflangers.lib",
    version: "1.1.3",
    licence:
      "STK-4.3 (the MIT-style Synthesis ToolKit licence): it has no GRAME/LGPL block at all, and its JOS section header, libfaust-wasm.data ~45554-45562, places the functions below it under STK-4.3; its 'further contributions' note, ~45871-45879, is the same 'expected' wording",
  }),
  Object.freeze({
    library: "platform.lib",
    version: "1.3.1",
    licence:
      "LGPL-2.1-or-later with the Faust exception (header comment, libfaust-wasm.data ~52482-52515)",
  }),
  Object.freeze({
    library: "routes.lib",
    version: "1.4.1",
    licence:
      "LGPL-2.1-or-later with the Faust exception (header comment, libfaust-wasm.data ~55017-55050)",
  }),
  Object.freeze({
    library: "signals.lib",
    version: "1.8.0",
    licence:
      "LGPL-2.1-or-later with the Faust exception (GRAME header comment, libfaust-wasm.data ~55723-55757)",
  }),
]);

/** `library.lib` → the reviewed entry for it. */
const REVIEWED_BY_LIBRARY = new Map(REVIEWED_UNDECLARED.map((entry) => [entry.library, entry]));

/**
 * GPL-3.0-only code that a Faust library declares only in a COMMENT, plus the
 * functions that call it.
 *
 * `basics.lib`'s "Sliding Reduce" section is contributed by Bart Brouns under
 * `// SPDX-License-Identifier: GPL-3.0` and declares no licence, so the compiled
 * meta says nothing about it: a program whose whole `process` is
 * `ba.slidingMax(64,128)` compiles with no GPL entry anywhere and passed the old
 * lint. The same silence covers functions that declare a permissive licence and
 * call it anyway — `fi.avg_rect` is `x : ba.slidingMean(...)` — so those names
 * are here too, and so are their callers (`an.band_powers` and the descriptors
 * built on it), one and two hops out. Each entry is a name a person found by
 * reading the library bodies; see the note in NOTICES.md about why the list is
 * maintained by review rather than derived.
 *
 * Checked and deliberately absent: `fi.avg_tau`, `fi.avg_t60` and `fi.avg_t19`
 * are one-pole averages (`fi.lptau`/`fi.lpt60`/`fi.lpt19`), not sliding ones.
 * `co.RMS_compression_gain_mono_db` and `co.peak_expansion_gain_mono_db` are
 * listed for completeness — they call the GPL code and also declare GPL-3.0-only
 * themselves, so they refuse either way.
 *
 * @type {ReadonlyArray<{library: string, prefix: string, name: string}>}
 */
export const COMMENT_ONLY_GPL = Object.freeze([
  // basics.lib: the GPL-3.0 comment-only section (libfaust-wasm.data ~7615).
  { library: "basics.lib", prefix: "ba", name: "slidingReduce" },
  { library: "basics.lib", prefix: "ba", name: "slidingSum" },
  { library: "basics.lib", prefix: "ba", name: "slidingSump" },
  { library: "basics.lib", prefix: "ba", name: "slidingMax" },
  { library: "basics.lib", prefix: "ba", name: "slidingMin" },
  { library: "basics.lib", prefix: "ba", name: "slidingMean" },
  { library: "basics.lib", prefix: "ba", name: "slidingMeanp" },
  { library: "basics.lib", prefix: "ba", name: "slidingRMS" },
  { library: "basics.lib", prefix: "ba", name: "slidingRMSp" },
  // Declared functions whose BODIES call the code above.
  { library: "filters.lib", prefix: "fi", name: "avg_rect" }, // : ba.slidingMean
  { library: "compressors.lib", prefix: "co", name: "RMS_compression_gain_mono_db" }, // : ba.slidingRMS
  { library: "compressors.lib", prefix: "co", name: "peak_expansion_gain_mono_db" }, // : ba.slidingMax
  // ... and the functions that call fi.avg_rect (libfaust-wasm.data ~2029-4017).
  { library: "analyzers.lib", prefix: "an", name: "abs_envelope_rect" },
  { library: "analyzers.lib", prefix: "an", name: "ms_envelope_rect" },
  { library: "analyzers.lib", prefix: "an", name: "band_powers" },
  { library: "analyzers.lib", prefix: "an", name: "spectral_flux" },
  { library: "analyzers.lib", prefix: "an", name: "loudness_meansquare" },
  { library: "analyzers.lib", prefix: "an", name: "spectral_centroid" },
  { library: "analyzers.lib", prefix: "an", name: "spectral_spread" },
  { library: "analyzers.lib", prefix: "an", name: "loudness_momentary" },
  { library: "analyzers.lib", prefix: "an", name: "loudness_shortterm" },
  { library: "analyzers.lib", prefix: "an", name: "loudness_integrated" },
]);

/** `library.lib/function` → its denylist entry. */
const DENIED_BY_FUNCTION = new Map(
  COMMENT_ONLY_GPL.map((entry) => [`${entry.library}/${entry.name}`, entry]),
);

/**
 * The denylist entry for one function of one library, or null.
 * @param {string} library `filters.lib`
 * @param {string} [name] the function, as the meta spells it
 * @returns {{library: string, prefix: string, name: string}|null}
 */
function denialFor(library, name) {
  if (!name) return null; // a library-level entry is not a function of the denylist
  return DENIED_BY_FUNCTION.get(`${library}/${name}`) || null;
}

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

/**
 * Every `library.lib` the meta mentions, with the version it reports.
 * @param {Array<Object<string, string>>|null} meta a compiled program's meta
 * @returns {Map<string, string>}
 */
export function libraryVersions(meta) {
  const versions = new Map();
  for (const entry of Array.isArray(meta) ? meta : []) {
    if (!entry || typeof entry !== "object") continue;
    for (const [key, value] of Object.entries(entry)) {
      const match = /^([^/]+\.lib)\/version$/.exec(key);
      if (!match) continue;
      versions.set(match[1], String(value == null ? "" : value).trim());
    }
  }
  return versions;
}

/**
 * Lint a compiled program's meta array — the licence gate the whole task exists
 * for. Pure: it reads the array and returns a verdict, so a test can hand it a
 * hand-written array as easily as a compiled one.
 *
 * Three refusals come out of it: a declared licence Crow may not ship, a
 * denylisted (comment-only GPL) function, and a library that declares nothing
 * and is not on `REVIEWED_UNDECLARED` at the version the meta reports.
 *
 * @param {Array<Object<string, string>>|null} meta the factory JSON's `meta`
 * @returns {{ok: boolean,
 *            refused: Array<{function: string, licence: string, note?: string}>,
 *            accepted: Array<{function: string, licence: string}>,
 *            undeclared: Array<{library: string, version: string,
 *                               reviewed: object|null}>,
 *            unknown: boolean}}
 *   `refused` names each function (or library) whose licence may not ship, with
 *   the licence it declared — or a `note` that says it in a sentence, for a
 *   library with no declaration at all; `accepted` is everything the lint let
 *   through; `undeclared` is every library used without a declaration, reviewed
 *   or not (the notices list them); `unknown` says the program carried no
 *   licence entry at all.
 */
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
      // A denylisted function refuses whatever its own declaration says: the
      // point of the list is that its body calls GPL-only code.
      if (denialFor(match[1], match[2])) {
        refused.push({ function: where, licence: COMMENT_ONLY_GPL_LICENCE });
        continue;
      }
      const licence = String(value == null ? "" : value).trim();
      if (isAllowedLicence(licence)) accepted.push({ function: where, licence });
      else refused.push({ function: where, licence });
    }
  }
  // Libraries that declare no licence at all: the meta is silent about their
  // terms, so they are judged against the reviewed list, at this version.
  const versions = libraryVersions(meta);
  const undeclared = [];
  for (const library of undeclaredLibraries(meta)) {
    const version = versions.get(library) || UNKNOWN_VERSION;
    const reviewed = REVIEWED_BY_LIBRARY.get(library) || null;
    undeclared.push({ library, version, reviewed });
    if (reviewed && reviewed.version === version) continue;
    refused.push({
      function: library,
      licence: NO_DECLARATION,
      note: `${library} ${version} has no licence declaration and is not on the reviewed list`,
    });
  }
  if (accepted.length === 0 && refused.length === 0) {
    return {
      ok: false,
      refused: [{ function: "(the compiled program)", licence: UNKNOWN_LICENCE }],
      accepted,
      undeclared,
      unknown: true,
    };
  }
  return { ok: refused.length === 0, refused, accepted, undeclared, unknown: false };
}

/**
 * Lint a `.dsp` SOURCE for the denylisted, comment-only GPL functions — the half
 * a compiled meta cannot see. A `.dsp` that calls `ba.slidingMax(…)` compiles
 * with no GPL entry anywhere, so the text is what catches it; the meta check in
 * `lintMeta` is what catches a *declared* function whose body calls one
 * (`fi.avg_rect`), which the source text need not mention.
 *
 * Only the prefixed spellings are matched (`ba.slidingMax`, `fi.avg_rect`, …),
 * because that is how the standard libraries are called through
 * `stdfaust.lib`; a comment that mentions one refuses too, which is a cheap
 * price for not missing a real call.
 *
 * @param {string} source the `.dsp` text
 * @returns {Array<{function: string, licence: string}>} the denied uses
 */
export function lintSource(source) {
  const text = String(source == null ? "" : source);
  const refused = [];
  for (const entry of COMMENT_ONLY_GPL) {
    // `(?<![\w.])` so `x.ba.slidingMax` is not a call to `ba.slidingMax`.
    const pattern = new RegExp(`(?<![\\w.])${entry.prefix}\\.${entry.name}(?![\\w])`);
    if (pattern.test(text)) {
      refused.push({ function: `${entry.library}/${entry.name}`, licence: COMMENT_ONLY_GPL_LICENCE });
    }
  }
  return refused;
}

/**
 * Both halves of the lint for one program: its compiled meta and its source.
 * @param {Array<Object<string, string>>|null} meta the factory JSON's `meta`
 * @param {string} source the `.dsp` text
 * @returns {ReturnType<typeof lintMeta>}
 */
export function lintProgram(meta, source) {
  const lint = lintMeta(meta);
  const refused = [...lint.refused];
  for (const item of lintSource(source)) {
    if (refused.some((have) => have.function === item.function)) continue;
    refused.push(item);
  }
  return { ...lint, ok: refused.length === 0, refused };
}

/**
 * A sentence naming each refused function and its licence, for the build's
 * stderr and for a test's assertion message.
 * @param {string} kind the effect
 * @param {ReturnType<typeof lintMeta>} lint
 * @returns {string}
 */
export function refusalMessage(kind, lint) {
  const parts = lint.refused
    // The "no licence at all" entry is the message itself, not one of its parts.
    .filter((item) => !(lint.unknown && item.function === "(the compiled program)"))
    .map((item) => (item.note ? item.note : `${item.function}: ${item.licence}`))
    .join(", ");
  if (lint.unknown) {
    const nothing = `${kind}.dsp compiled to a program whose meta names no licence at all, so Crow cannot state its terms`;
    return parts === "" ? nothing : `${nothing}; it also uses code Crow may not ship: ${parts}`;
  }
  return `${kind}.dsp uses code Crow may not ship: ${parts}`;
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

/** The compiler options every effect is built with. */
const COMPILE_OPTIONS =
  "-ftz 2";

/**
 * Compile one effect WITHOUT judging its licence: the raw result, for the lint's
 * own tests and for `compileEffect` below.
 *
 * `-ftz 2` flushes denormals to zero inside the DSP's own arithmetic — a
 * deterministic bit mask on every float op, bit-identical in Chromium and Node —
 * so a delay line or a filter state cannot hold a denormal (slow, and different
 * on each CPU) between blocks. `engine/faust-host.js` flushes its output too;
 * that one catches a value a module computes without storing it.
 * @param {string} kind the effect's name (its `.dsp` file's base name)
 * @param {string} source the Faust source
 * @returns {Promise<{kind: string, wasm: Buffer, json: string, meta: object[],
 *                    credits: Array<{library: string, function: string,
 *                                    author: string, copyright: string}>,
 *                    lint: ReturnType<typeof lintMeta>}>}
 * @throws {Error} when the source does not compile
 */
export async function compileProgram(kind, source) {
  const compiler = await faustCompiler();
  let factory;
  try {
    factory = await compiler.createMonoDSPFactory(kind, source, COMPILE_OPTIONS);
  } catch (error) {
    throw new Error(`build-faust: ${kind}.dsp did not compile: ${error?.message || error}`);
  }
  if (!factory) throw new Error(`build-faust: ${kind}.dsp produced no factory`);
  const json = String(factory.json);
  const meta = JSON.parse(json).meta;
  return {
    kind,
    wasm: Buffer.from(factory.code),
    json,
    meta,
    credits: creditEntries(meta),
    lint: lintProgram(meta, source),
  };
}

/**
 * Compile one effect, refusing it when its licence may not ship.
 * @param {string} kind the effect's name (its `.dsp` file's base name)
 * @param {string} source the Faust source
 * @returns {Promise<{kind: string, wasm: Buffer, json: string, meta: object[],
 *                    credits: Array<object>, lint: ReturnType<typeof lintMeta>}>}
 * @throws {Error} when the source does not compile, or its licence may not ship
 */
export async function compileEffect(kind, source) {
  const effect = await compileProgram(kind, source);
  if (!effect.lint.ok) throw new Error(`build-faust: ${refusalMessage(kind, effect.lint)}`);
  return effect;
}

/**
 * The author and copyright lines a compiled program's meta carries, per library
 * and function — what the permissive licences require to travel with the code,
 * and what this repository's `node_modules` is not (it is not shipped). Values
 * have their line breaks collapsed, so a `declare … copyright` that spans three
 * lines stays one deterministic line of Markdown.
 * @param {Array<Object<string, string>>|null} meta a compiled program's meta
 * @returns {Array<{library: string, function: string, author: string,
 *                  copyright: string}>} `function` is "" for a library's own
 *   entry; sorted by library then function
 */
export function creditEntries(meta) {
  const found = new Map();
  for (const entry of Array.isArray(meta) ? meta : []) {
    if (!entry || typeof entry !== "object") continue;
    for (const [key, value] of Object.entries(entry)) {
      const match = /^([^/]+\.lib)\/(?:([^:]+):)?(author|copyright)$/.exec(key);
      if (!match) continue;
      const field = match[3];
      const id = `${match[1]}\u0000${match[2] || ""}`;
      const item = found.get(id) || {
        library: match[1],
        function: match[2] || "",
        author: "",
        copyright: "",
      };
      item[field] = String(value == null ? "" : value)
        .replace(/\s+/g, " ")
        .trim();
      found.set(id, item);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.library === b.library
      ? byCodePoint(a.function, b.function)
      : byCodePoint(a.library, b.library),
  );
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
    "document's `EFFECT_PARAMS`. They are compiled with `-ftz 2`, so a denormal",
    "is flushed inside the DSP's own state rather than left to slow the block",
    "down; `engine/faust-host.js` flushes its output as well.",
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
    "declared, and `NOTICES.md` is the redistribution notice: how the lint",
    "decides, the reviewed libraries that declare nothing, the author and",
    "copyright lines, and the MIT and STK 4.3 texts. The build refuses any",
    "function whose licence Crow may not ship — the GPL-only and AGPL-only ones",
    "included, and GPL code that is declared only in a comment — so this",
    "directory only ever holds permissively licensed code.",
    "",
  ].join("\n");
}

/**
 * The Faust libraries a compiled program used that declared no licence at all.
 *
 * The compiler emits a licence entry only where a library declares one, so a
 * meta-driven lint cannot see the terms of a function whose library is silent.
 * The lint refuses such a library unless `REVIEWED_UNDECLARED` names it at the
 * version the meta reports; this function is how both find them, and their list
 * goes into NOTICES.md so the gap is on the record rather than implied.
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
 * The MIT licence, with a placeholder for the copyright line: the copyright of
 * each MIT function is in the meta and is reproduced above it, so the text is
 * written once instead of once per function.
 */
const MIT_TEXT = [
  "Copyright (c) the authors of the functions listed above",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
].join("\n");

/**
 * The notices: what the lint does, the per-kind licence table, the reviewed
 * libraries that declare nothing, the copyright and author lines the licences
 * require to travel with the code, and the licence texts themselves.
 *
 * This file is the redistribution notice for `vendor/faust/`: everything a
 * recipient needs is either here or next to it (`LICENSE-faustwasm.txt`). It
 * deliberately does not point at `node_modules`, which is a build-time thing and
 * is not shipped.
 *
 * @param {Object<string, Array<{function: string, licence: string}>>} licences
 *   kind → the licence entries the compiled effect carried, as LICENSES.json
 * @param {string} stkText the STK 4.3 text, verbatim
 * @param {Object<string, Array<{library: string, version: string,
 *                              reviewed: object|null}>>} [undeclared]
 *   kind → the libraries that declared no licence, as `lintMeta` reports them
 * @param {Array<{library: string, function: string, author: string,
 *               copyright: string}>} [credits] every author/copyright line the
 *   compiled metas carried, merged across kinds
 * @returns {string}
 */
export function noticesText(licences, stkText, undeclared = {}, credits = []) {
  const kinds = Object.keys(licences).sort(byCodePoint);
  /** licence → every function that declared it, across all the effects. */
  const byLicence = new Map();
  for (const kind of kinds) {
    for (const entry of licences[kind]) {
      const list = byLicence.get(entry.licence) || new Set();
      list.add(entry.function);
      byLicence.set(entry.licence, list);
    }
  }
  /** @param {string} licence @returns {string[]} sorted function names */
  const functionsUnder = (licence) => [...(byLicence.get(licence) || [])].sort(byCodePoint);
  const mit = functionsUnder("MIT");
  const bsd = [...functionsUnder("BSD-2-Clause"), ...functionsUnder("BSD-3-Clause")].sort(
    byCodePoint,
  );

  const lines = [
    "# Faust effect licences",
    "",
    "Studio's Faust effects are compiled from `bundles/studio/effects/*.dsp` with",
    "the Faust compiler (`@grame/faustwasm`, at build time only, LGPL-2.1 — its",
    "notice is `LICENSE-faustwasm.txt` beside this file). The Faust standard",
    "library is licensed per function, so each compiled effect carries the union",
    "of the licences its functions declared.",
    "",
    "## How the lint decides what ships",
    "",
    "`bundles/studio/tools/build-faust.mjs` refuses an effect unless all three of",
    "these pass:",
    "",
    "1. **The licence declarations in the compiled meta.** Only MIT,",
    "   BSD-2-Clause, BSD-3-Clause, STK-4.3 and LGPL-2.1 with the Faust exception",
    "   may ship; anything else (the GPL-only and AGPL-only functions included)",
    "   refuses the build.",
    "2. **An allowlist of reviewed libraries that declare nothing.** Faust's own",
    "   libraries do not all carry a `declare license`, and a library that",
    "   declares nothing contributes nothing to the meta — so the build refuses",
    "   any such library unless the allowlist names it *at the version the meta",
    "   reports*, with the terms its file header states in a comment. A",
    "   `faustwasm` upgrade that bumps one of these libraries refuses the build",
    "   until someone reads the new header.",
    "3. **A denylist of GPL-3.0-only code that is declared only in a comment.**",
    "   `basics.lib`'s `sliding*` block carries",
    "   `// SPDX-License-Identifier: GPL-3.0` and no `declare license` at all, so",
    "   a program that calls it compiles with no GPL entry anywhere; and",
    "   permissively declared functions call it in turn (`filters.lib/avg_rect`",
    "   is `ba.slidingMean`). Those names are refused by match on the compiled",
    "   meta and on the `.dsp` sources.",
    "",
    "**The denylist is maintained by review, not derived from the meta.** The",
    "meta records the licences a program's own functions declare, not the call",
    "graph beneath them: a function that calls `fi.avg_rect` (which calls",
    "`ba.slidingMean`) leaves no trace of the GPL code in the top-level meta.",
    "Reading each new effect's sources, and re-reading the libraries on a",
    "`faustwasm` upgrade, is what keeps the list complete.",
    "",
    "## What each effect uses",
    "",
  ];
  for (const kind of kinds) {
    lines.push(`### ${kind}`, "");
    const perKind = new Map();
    for (const entry of licences[kind]) {
      const list = perKind.get(entry.licence) || [];
      list.push(entry.function);
      perKind.set(entry.licence, list);
    }
    for (const licence of [...perKind.keys()].sort(byCodePoint)) {
      const functions = perKind.get(licence).sort(byCodePoint);
      lines.push(`- ${licence}: ${functions.map((name) => `\`${name}\``).join(", ")}`);
    }
    lines.push("");
  }

  // The reviewed undeclared libraries, with the terms their headers state.
  const silent = new Map(); // library → {version, reviewed, kinds}
  for (const kind of kinds) {
    for (const item of undeclared[kind] || []) {
      const have = silent.get(item.library) || {
        version: item.version,
        reviewed: item.reviewed,
        kinds: [],
      };
      have.kinds.push(kind);
      silent.set(item.library, have);
    }
  }
  if (silent.size > 0) {
    lines.push(
      "## Libraries that declare no licence",
      "",
      "The compiler emits a licence entry only for a function or library that",
      "declares one, so these libraries were used without the compiled meta",
      "stating any terms for them. None of them is accepted on trust: each is on",
      "the build's reviewed allowlist, at the version below, because its file",
      "header (a comment, which the compiler never copies into a meta) states",
      "terms Crow may ship under. They are Faust's own libraries; the citations",
      "are the Faust libraries as `faustwasm` ships them, in its",
      "`libfaust-wasm.data`.",
      "",
    );
    for (const library of [...silent.keys()].sort(byCodePoint)) {
      const item = silent.get(library);
      const terms = item.reviewed
        ? item.reviewed.licence
        : "NOT REVIEWED — the build refuses this library";
      lines.push(
        `- \`${library}\` ${item.version} — ${terms}.`,
        `  Used by: ${item.kinds.join(", ")}.`,
      );
    }
    lines.push("");
  }

  // Author and copyright lines, grouped per library: what MIT, BSD and STK-4.3
  // all require to be passed on with the code.
  if (credits.length > 0) {
    lines.push(
      "## Copyright and authorship",
      "",
      "The compiler's meta records the author and copyright line a library",
      "declares, per function where it declares one and per library otherwise.",
      "They are reproduced here, grouped by library, because MIT, BSD and STK-4.3",
      "all require the notice to travel with the code. A function with no entry",
      "of its own is covered by its library's entry, or (for a library in the",
      "list above) by the header cited there.",
      "",
    );
    const byLibrary = new Map();
    for (const item of credits) {
      const list = byLibrary.get(item.library) || [];
      list.push(item);
      byLibrary.set(item.library, list);
    }
    for (const library of [...byLibrary.keys()].sort(byCodePoint)) {
      lines.push(`### ${library}`, "");
      const items = byLibrary
        .get(library)
        .sort((a, b) => byCodePoint(a.function, b.function));
      for (const item of items) {
        const who = item.function ? `\`${item.function}\`` : "the library itself";
        const facts = [];
        if (item.author) facts.push(`author: ${item.author}`);
        if (item.copyright) facts.push(`copyright: ${item.copyright}`);
        lines.push(`- ${who} — ${facts.join("; ")}`);
      }
      lines.push("");
    }
  }

  const notes = [
    "## Notes",
    "",
    "- **MIT.** Its text is below, once. The MIT functions this build ships are",
    mit.length > 0
      ? `  ${mit.map((name) => `\`${name}\``).join(", ")}. Their copyright lines are under "Copyright and authorship".`
      : "  none of the functions this build uses.",
    "- **BSD-2-Clause and BSD-3-Clause** likewise ask only that the copyright",
    "  notice travel with the code; it is under 'Copyright and authorship'.",
  ];
  if (bsd.length > 0) {
    notes.push(`  The BSD functions this build ships are ${bsd.map((name) => `\`${name}\``).join(", ")}.`);
  }
  notes.push(
    "- **LicenseRef-LGPL-2.1-or-later-with-Faust-exception** is the LGPL with the",
    "  Faust exception, which lets generated code ship under Crow's own terms.",
    "  The compiler package's own LGPL notice — a different thing, and not the",
    "  licence of the compiled effects — is `LICENSE-faustwasm.txt`.",
    "- **STK-4.3** is the permissive, MIT-style licence of the Synthesis ToolKit",
    "  (no relation to the MIT-declared functions above), which the filter and",
    "  effect libraries' `jos` sections carry. Its text is below.",
    "- **`pf.phaser2_stereo`** (the phaser effect) carries no licence",
    "  declaration, so it appears in no row above: `phaflangers.lib` is one of",
    "  the reviewed libraries in the list above, and its JOS section header",
    "  places the functions below it under STK-4.3 — which is what the phaser",
    "  ships under, NOT the MIT of the reverb's `jpverb` or of the `_tpt_df`",
    "  filters.",
    "",
    "## MIT",
    "",
    "```text",
    MIT_TEXT,
    "```",
    "",
  );
  lines.push(...notes);
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
  // The author/copyright lines, merged across the effects: a function used by
  // three effects is one notice, not three.
  const credited = new Map();
  for (const kind of kinds) {
    const source = readFileSync(join(SOURCE_DIR, `${kind}.dsp`), "utf8");
    const effect = await compileEffect(kind, source);
    files.set(`${kind}.wasm`, effect.wasm);
    files.set(`${kind}.json`, effect.json);
    licences[kind] = sortedLicences(effect.lint.accepted);
    undeclared[kind] = effect.lint.undeclared;
    for (const credit of effect.credits) {
      credited.set(`${credit.library}\u0000${credit.function}`, credit);
    }
  }
  const credits = [...credited.values()].sort((a, b) =>
    a.library === b.library
      ? byCodePoint(a.function, b.function)
      : byCodePoint(a.library, b.library),
  );
  // Sorted keys, so two runs of the same sources produce the same bytes.
  const sortedKinds = {};
  for (const kind of Object.keys(licences).sort(byCodePoint)) sortedKinds[kind] = licences[kind];
  files.set("LICENSES.json", `${JSON.stringify(sortedKinds, null, 2)}\n`);
  files.set("NOTICES.md", noticesText(sortedKinds, stkNoticeText(info.dir), undeclared, credits));
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