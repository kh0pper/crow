/**
 * The seed never enters a bot — a CI guard over bot-reachable code.
 *
 * One exception, stated here so nobody reads this header as a claim the code does not keep:
 * Ramble's stdio server (bundles/ramble/server/server.js) still derives the PUBLIC persona
 * authors from the instance identity, so it is on the TEMPORARY allow-list below until its
 * public-persona cache PR lands. Everywhere else — and Ramble too, once that PR is in — the
 * seed never enters a bot.
 *
 * The bot-run extensions need CREDENTIALS, never the instance seed: storage needs the opened
 * Shared Storage settings (piped over the fd by scripts/pi-bots/mcp_writer.mjs), and Ramble
 * needs public persona authors. So no code that a Crow bot can execute may import the two
 * modules that hold the seed:
 *
 *   servers/sharing/identity.js    — the master seed, every derived key, loadOrCreateIdentity
 *   servers/sharing/secret-box.js  — the HKDF "crow-secret-box-v1" seal key over that seed
 *
 * "Bot-reachable" is DERIVED, not hard-coded:
 *   - every stdio server the bot catalog can emit (CORE_SERVERS + CONDITIONAL_SERVERS): the
 *     directory of that server's entry file, walked whole;
 *   - every bundle's server/ (any add-on can be enabled for a bot in Bot Builder);
 *   - scripts/pi-bots/** — the engine itself, and the fetch/CLI helpers it runs.
 *
 * COMBINED_SERVER (crow-core) is deliberately NOT in that set: scripts/pi-bots/crow-server-
 * catalog.mjs emits per-server blocks only and never crow-core, so no bot runs it — it is the
 * OWNER's combined spawn, and it imports the whole sharing server. A test below pins the
 * exclusion (the catalog must never start emitting crow-core); if that changes, this set must
 * grow and the sharing tree must stop needing the seed. For the same reason crow-sharing's
 * directory is never a ROOT (it is a BOT_EXCLUDED_SERVERS name), though the walk still walks
 * INTO servers/sharing through imports — see the next paragraph.
 *
 * The guard is TRANSITIVE. A bot that imports a module which imports the seed has reached the
 * seed, so the walk follows the static import graph from that file set — relative specifiers,
 * `require("…")`, literal `import("…")` and the bundle `appImport("…")` seam, including
 * re-exports (`export … from`) — and fails on the FIRST file that reaches the two modules
 * below, reporting the whole chain (`servers/memory/server.js -> … -> servers/sharing/identity.js`).
 *
 * The stop set is ALLOWED_HOST_SIDE: a file listed there IS the host side (it opens a value
 * and pipes the opened config), so a chain that reaches it is fine and the walk stops there.
 * The seed's own home is walked like any other tree — reaching servers/sharing/identity.js
 * from anywhere is exactly the violation.
 *
 * A non-literal specifier (`import(name)`, a template literal, `require(prefix + name)`,
 * `appImport(dynamic)`) cannot be followed by any static check, so a bot-reachable file that
 * uses one FAILS unless it is in ALLOWED_DYNAMIC_IMPORT with a reason.
 *
 * REMAINING LIMIT, stated plainly: this is static analysis of the source. It follows only
 * specifiers written as string literals in this repo's bot-reachable trees. Code reached
 * through a node_modules package's own internals, through a computed specifier in a file that
 * is allow-listed with a reason, or through a file this walk cannot resolve (a missing
 * extension-less path, a symlink target outside the repo) is NOT covered — the allow-list
 * entries and the review of each non-literal import are the human half of the check.
 *
 * ALLOWED_HOST_SIDE lists the files that legitimately touch the seed, each with the reason.
 * Every entry is one of two shapes: the bridge's HOST-SIDE hydration (it opens the value and
 * pipes only the opened config, never the key) or a module whose seed use sits behind a
 * host-only condition (the gateway process, never a bot child).
 * A NEW entry must be justified in the same way — "it is convenient" is exactly the change
 * this test exists to refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CORE_SERVERS, CONDITIONAL_SERVERS, ROOT } from "../scripts/server-registry.js";
import { crowServerCatalog } from "../scripts/pi-bots/crow-server-catalog.mjs";

/** The two modules a bot-reachable file may never import. */
const SEED_MODULES = [
  "servers/sharing/identity.js",
  "servers/sharing/secret-box.js",
].map((p) => resolve(ROOT, p));

/** Where those modules live: not a ROOT of the walk, see the header. */
const SEED_HOME = resolve(ROOT, "servers", "sharing");

/**
 * Files allowed to reach the seed, each because it is HOST-SIDE. Keys and values are repo
 * relative paths and the reason. Adding an entry is a security decision, not a formality.
 */
export const ALLOWED_HOST_SIDE = Object.freeze({
  "servers/storage/s3-client.js":
    "the storage client. Its openers (loadSharedStorageFromDb/Sync, useDbStorageConfig, " +
    "useDbStorageConfigFromInstance, initStorageFromInstance) open storage.shared.* for the " +
    "OWNER's path and for the bot engine's hydrate step; a hydrated bot turn goes through " +
    "adoptHostStorage and never reaches them, and a file-delivery bot turn is explicitly off " +
    "(tests/pibot-shared-storage-hydrate.test.js pins both).",
  "scripts/pi-bots/mcp_writer.mjs":
    "the bot engine's host-side hydration: it reads the identity, opens the storage settings " +
    "and pipes ONLY the opened config (CROW_STORAGE_FROM_HOST=1 + S3_*) into the in-memory " +
    "config; the seed and the seal key never enter the config.",
  "scripts/pi-bots/bridge.mjs":
    "the bot ENGINE — the host process that spawns pi; a bot never loads it. Its one seed import " +
    "is identity.js's identityDataDir, used only as the ANCHOR of the directory whose " +
    "identity.json the child's sandbox must mask (it is handed to identityCandidates()); the " +
    "path is passed on and the seed itself is never read, opened or derived from.",
  "scripts/pi-bots/identity-candidates.mjs":
    "the ONE list of identity-named files a spawn must mask. Its identity.js import sits inside " +
    "identityAnchors(), the host-side anchor resolver called by the bridge's spawn path and by " +
    "the boot check; only the seed directory PATH is taken from it, and it is imported lazily " +
    "so this module stays dependency-free for the settings and unit-test callers.",
  "scripts/pi-bots/gateways/crow-messages.mjs":
    "Crow Messages' HOST-SIDE adapter (the pibot-gateways process, never a bot child): it reads " +
    "the instance identity to address this instance on its own relay, which is the same " +
    "authority the gateway has.",
  "servers/sharing/instance-sync.js":
    "instance sync's signing (identity.js's sign/verify) is reached only from emitChange and " +
    "the feed paths, which run in the GATEWAY process that owns the feeds; a bot's server " +
    "reaches this module through sync-emit only for its pure helpers (SYNCED_TABLES, " +
    "shouldSyncRow, shouldInitInstanceSync, stripLocalOnlyColumns), and takes the queue path " +
    "there instead of signing anything.",
  "servers/sharing/managers.js":
    "the sharing-managers aggregator (peer manager, sync, nostr). servers/shared/history/erase.js " +
    "reaches it through a LAZY import inside the peer-announce path only; a bot child that loads " +
    "erase.js for its DDL/tombstone tables never calls eraseEventsFor, so no manager (and no " +
    "identity) is loaded on that path.",
  "servers/gateway/keychain/store.js":
    "the keychain seals under its OWN key (keychain/key.js), never the instance seed; " +
    "secret-box is only its AES-GCM helper and this module never reads identity.json. " +
    "Bot-reachable code reaches it through servers/shared/addon-secrets.js's sync reader, " +
    "which reads an add-on's own listed env keys — the intended door.",
  "servers/gateway/routes/bundles.js":
    "the gateway's add-on routes: its identity read is inside injectSharedStorage, an async " +
    "bundle-INSTALL path that only the gateway runs. A bot child loads this module only " +
    "because servers/shared/project-lifecycle.js imports the gateway proxy, and never calls " +
    "that function (lazy, literal import).",
  "bundles/ramble/server/server.js":
    "TEMPORARY, and the last one: Ramble's stdio server still derives the PUBLIC persona " +
    "authors from the identity (it never signs there). The public-persona cache — the gateway " +
    "writes the authors to ramble_settings and this server reads them — replaces it; when that " +
    "lands this entry must be deleted.",
});

/**
 * Files allowed to use a NON-literal import specifier (`import(x)`, a template literal,
 * `require(prefix + y)`, `appImport(dynamic)`), each with the reason the target can only be
 * one of a known set. A static walk cannot follow these, so every entry is a place where the
 * guard is knowingly blind. Keep it empty unless there is no alternative.
 */
export const ALLOWED_DYNAMIC_IMPORT = Object.freeze({
  "bundles/*/server/app-root.js":
    "the app-root seam ITSELF: appImport(rel) is import(pathToFileURL(join(APP_ROOT, rel)).href), " +
    "fixed by construction. Every call site passes a literal, and the transitive walk reads each " +
    "of those appImport(\"…\") edges.",
  "bundles/artifacts/server/design.js":
    "createDesign takes importKit/importShared as INJECTED seams (tests pass fakes); the defaults " +
    "load the installed Design-kit copy from a computed path and the app's shared design-kit " +
    "module through a literal appImport, neither of which reaches the seed.",
  "bundles/meta-glasses/server/device-store.js":
    "a shim that loads the app's servers/shared/device-store.js from the first of three fixed " +
    "repo roots that has it (CROW_APP_ROOT, the checkout, ~/crow) — one fixed repo file, no " +
    "caller-controlled path.",
  "bundles/meta-glasses/server/server.js":
    "_providerPath is one of the fixed repo paths to the AI provider adapter module, chosen by a " +
    "version check — never a caller-controlled specifier.",
  "bundles/studio/server/render.js":
    "require(join(ENGINE_DIR, \"resample.js\")): a fixed file name inside the bundle's own engine " +
    "directory, not a caller-controlled path.",
});

/** File extensions the guard reads (the trees it scans are JS/ESM). */
const CODE_FILE = /\.(?:js|mjs|cjs)$/;

/** Every regular file under `dir` (recursive, no symlinks followed). */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && CODE_FILE.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * The bot-reachable file set, derived from the registry + the bundles tree + scripts/pi-bots.
 * `root` is the repo root (a fixture root in the temp-copy test).
 */
export function botReachableFiles({ root = ROOT } = {}) {
  const files = [];
  const seen = new Set();
  const add = (list) => { for (const f of list) if (!seen.has(f)) { seen.add(f); files.push(f); } };
  const seedHome = resolve(root, "servers", "sharing");
  for (const spec of [...CORE_SERVERS, ...CONDITIONAL_SERVERS]) {
    const entry = Array.isArray(spec.args) ? spec.args[0] : null;
    if (typeof entry !== "string" || !entry) continue;
    const dir = resolve(root, dirname(entry));
    // The seed's own home: the definition modules live there and every file in that tree
    // reads them. The guard is about code that must never reach for them (see the header).
    if (dir === seedHome || dir.startsWith(seedHome + sep)) continue;
    add(walk(dir));
  }
  let bundles = [];
  try { bundles = readdirSync(resolve(root, "bundles"), { withFileTypes: true }); } catch { bundles = []; }
  for (const b of bundles) {
    if (!b.isDirectory()) continue;
    const serverDir = resolve(root, "bundles", b.name, "server");
    let st = null;
    try { st = statSync(serverDir); } catch { st = null; }
    if (st && st.isDirectory()) add(walk(serverDir));
  }
  add(walk(resolve(root, "scripts", "pi-bots")));
  return files;
}

/** The string-literal specifier of every import/require/appImport call in `src`. */
export function importSpecifiers(src) {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,                        // import … from "x" | export … from "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,             // dynamic import("x")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,            // createRequire / CJS
    /\bappImport\s*\(\s*["']([^"']+)["']\s*\)/g,          // the app-root seam bundles use
  ];
  const out = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

/** Does this specifier name one of the seed modules, from a file at `file`? */
export function namesSeedModule(spec, file, { root = ROOT } = {}) {
  const guarded = SEED_MODULES.map((p) => (root === ROOT ? p : resolve(root, relative(ROOT, p))));
  const clean = String(spec).split("?")[0];
  if (!clean) return false;
  let abs = null;
  if (clean.startsWith(".")) abs = resolve(dirname(file), clean);
  else if (clean.startsWith("/")) abs = clean;
  // The appImport seam names a REPO-relative path ("servers/storage/s3-client.js"), which a
  // bundle resolves against its app root. A bare package name never is one.
  else if (/^(?:servers|bundles|scripts|src)\//.test(clean)) abs = resolve(root, clean);
  else return false;
  return guarded.includes(abs) || guarded.includes(abs + ".js");
}

/**
 * The repo file a specifier names, from a file at `file`, or null when it names nothing this
 * guard can read. Only the shapes a bot-reachable file uses to reach repo code resolve: a
 * relative specifier, an app-root one ("servers/…", "bundles/…", "scripts/…", "src/…") and
 * an absolute path inside the root. A bare package name (a node: builtin, "zod", "@scope/x")
 * names code outside this repo — see the header's remaining limit.
 */
export function resolveImportTarget(spec, file, { root = ROOT } = {}) {
  const clean = String(spec || "").split("?")[0];
  if (!clean) return null;
  let abs = null;
  if (clean.startsWith(".")) abs = resolve(dirname(file), clean);
  else if (clean.startsWith("/")) abs = clean;
  else if (/^(?:servers|bundles|scripts|src)\//.test(clean)) abs = resolve(root, clean);
  else return null;
  const candidates = [abs, abs + ".js", abs + ".mjs", abs + ".cjs", join(abs, "index.js")];
  for (const candidate of candidates) {
    if (candidate !== root && !candidate.startsWith(root + sep)) continue; // never outside the root
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* try the next shape */ }
  }
  return null;
}

/**
 * The TRANSITIVE walk: every chain from the bot-reachable file set to a seed module.
 *
 * Breadth-first over the static import graph, one entry per file (the shortest chain wins so
 * the report is readable). ALLOWED_HOST_SIDE is the stop set: a file listed there is host
 * side, so a chain that reaches it is fine and the walk does not continue through it — those
 * files are reported back in `reachedAllowed` so the list itself cannot rot.
 *
 * @returns {{violations: Array<{file: string, spec: string, line: number, chain: string[]}>,
 *            reachedAllowed: Set<string>}} repo-relative paths throughout
 */
export function walkSeedImports(files, { root = ROOT, allow = ALLOWED_HOST_SIDE } = {}) {
  const relOf = (f) => relative(root, f).split(sep).join("/");
  const allowAbs = new Set(Object.keys(allow).map((relPath) => resolve(root, relPath)));
  const violations = [];
  const reachedAllowed = new Set();
  const visited = new Set();
  const queue = [...files].map((file) => ({ file, chain: [relOf(file)] }));
  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    // An allow-listed file IS the host side: it is a stop, never a violation (whatever it
    // imports is the host's business), and it counts as reached so the list cannot rot.
    if (allowAbs.has(file)) { reachedAllowed.add(relOf(file)); continue; }
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    for (const spec of importSpecifiers(src)) {
      if (namesSeedModule(spec, file, { root })) {
        violations.push({ file: relOf(file), spec, line: lineOf(src, spec), chain: [...chain, spec] });
        continue;
      }
      const target = resolveImportTarget(spec, file, { root });
      if (!target) continue;
      if (allowAbs.has(target)) { reachedAllowed.add(relOf(target)); continue; }
      if (visited.has(target)) continue;
      queue.push({ file: target, chain: [...chain, relOf(target)] });
    }
  }
  return { violations, reachedAllowed };
}

/** The 1-based line a specifier sits on, for the failure message (0 when it cannot be found). */
function lineOf(src, spec) {
  const at = src.split("\n").findIndex((line) => line.includes(spec));
  return at === -1 ? 0 : at + 1;
}

/** The shapes a static walk cannot follow: a computed / template / concatenated specifier. */
const NON_LITERAL_IMPORTS = [
  /\bimport\(\s*(?=[^"'\s])/,     // dynamic import(name), import(`./x/${y}.js`)
  /\brequire\(\s*(?=[^"'\s])/,    // require(prefix + name)
  /\bappImport\(\s*(?=[^"'\s])/,  // the app-root seam with a computed path
];

/**
 * True when `rel` is on a reviewed list: an exact key, or a key holding one `*` that matches
 * exactly one path segment (e.g. "bundles/∗/server/app-root.js").
 */
function allowListHas(allow, rel) {
  if (Object.prototype.hasOwnProperty.call(allow, rel)) return true;
  for (const key of Object.keys(allow)) {
    if (!key.includes("*")) continue;
    const re = new RegExp("^" + key.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$");
    if (re.test(rel)) return true;
  }
  return false;
}

/**
 * `text` with COMMENTS blanked to spaces (newlines kept, string bodies untouched), so a
 * position in the result is the same position — and the same line — in the original. Only the
 * DETECTOR needs this: prose like "// `import()` cannot load it" is not a call, while a real
 * `import("…")` must stay visible (a literal specifier is not the thing being refused).
 */
function blankedForScan(text) {
  const out = text.split("");
  let i = 0;
  let mode = null; // null | "line" | "block" | a quote character
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === null) {
      if (c === "/" && next === "/") { mode = "line"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === "/" && next === "*") { mode = "block"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { mode = c; i += 1; continue; }
      i += 1;
      continue;
    }
    if (mode === "line") { if (c === "\n") mode = null; else out[i] = " "; i += 1; continue; }
    if (mode === "block") {
      if (c === "*" && next === "/") { out[i] = " "; out[i + 1] = " "; mode = null; i += 2; continue; }
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // Inside a string: only find its end (a backslash escapes the next character).
    if (c === "\\") { i += 2; continue; }
    if (c === mode) mode = null;
    i += 1;
  }
  return out.join("");
}

/**
 * Bot-reachable files that use a non-literal import specifier, minus ALLOWED_DYNAMIC_IMPORT.
 * Such a file could import the seed (or anything else) and no static check would see it, so
 * the guard fails on it unless the file's reason is on the reviewed list. Each entry is
 * `"<file>:<line>: <source line>"` so the failure names the call.
 */
export function nonLiteralImportViolations(files, { root = ROOT, allow = ALLOWED_DYNAMIC_IMPORT } = {}) {
  const out = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    if (allowListHas(allow, rel)) continue;
    let raw;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    const src = blankedForScan(raw);
    let best = null;
    for (const re of NON_LITERAL_IMPORTS) {
      const m = new RegExp(re.source, "g").exec(src);
      if (m && (best === null || m.index < best.index)) best = m;
    }
    if (!best) continue;
    const line = src.slice(0, best.index).split("\n").length;
    const snippet = raw.split("\n")[line - 1].trim().slice(0, 120);
    out.push(`${rel}:${line}: ${snippet}`);
  }
  return out;
}

/**
 * The violations in a file list: `[{file, spec, chain}]` for every chain that reaches a guard
 * module. Pure apart from reading the files, so a fixture list can be checked.
 */
export function seedImportViolations(files, { root = ROOT, allow = ALLOWED_HOST_SIDE } = {}) {
  return walkSeedImports(files, { root, allow }).violations;
}

// ─── the guard itself ───────────────────────────────────────────────────────

test("no bot-reachable file — transitively — imports the seed or the seal helpers", () => {
  const files = botReachableFiles();
  assert.ok(files.length > 100, "the derived set is the real tree, not a handful of files: " + files.length);
  const { violations } = walkSeedImports(files);
  assert.deepEqual(
    violations,
    [],
    "bot-reachable code must not reach the identity or the seal helpers. Move the work host-side " +
    "(scripts/pi-bots/mcp_writer.mjs opens a value and pipes the OPENED config), lazy-import it " +
    "behind the host-only condition, or add the file to ALLOWED_HOST_SIDE with the host-side reason. " +
    "Chains: " + violations.map((v) => `${v.file}:${v.line} -> ${v.spec} (${v.chain.join(" -> ")})`).join(" | "),
  );
});

test("no bot-reachable file uses a non-literal import specifier (a reviewed list only)", () => {
  const offenders = nonLiteralImportViolations(botReachableFiles());
  assert.deepEqual(
    offenders,
    [],
    "a computed import(" + "…" + ") cannot be followed by this guard, so it could reach the seed unseen. " +
    "Use a literal specifier, or add the file to ALLOWED_DYNAMIC_IMPORT with the reason its target " +
    "can only be a known set. Offenders: " + offenders.join(", "),
  );
});

test("the derived set covers the places that matter (it cannot shrink silently)", () => {
  const files = botReachableFiles().map((f) => relative(ROOT, f).split(sep).join("/"));
  for (const rel of [
    "servers/storage/index.js",
    "servers/storage/s3-client.js",
    "servers/memory/index.js",
    "bundles/studio/server/index.js",
    "bundles/sunvox-studio/server/server.js",
    "bundles/data-dashboard/server/server.js",
    "bundles/ramble/server/server.js",
    "scripts/pi-bots/mcp_writer.mjs",
    "scripts/pi-bots/bot-world.mjs",
    "scripts/pi-bots/gateways/crow-messages.mjs",
  ]) {
    assert.ok(files.includes(rel), rel + " is bot-reachable and must be in the guarded set");
  }
  assert.ok(!files.some((f) => f.startsWith("servers/sharing/")), "the seed's own home is not scanned");
  assert.ok(!files.some((f) => f.startsWith("servers/core/")), "crow-core is the owner's combined spawn, never a bot entry");
});

test("the exclusion of the combined crow-core server still holds (the catalog never emits it)", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-seed-catalog-"));
  try {
    const { servers } = crowServerCatalog(home);
    assert.equal(Object.prototype.hasOwnProperty.call(servers, "crow-core"), false,
      "bots get per-server blocks; if the catalog ever emits crow-core, add it back to the guarded set");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every ALLOWED_HOST_SIDE entry exists, still reaches the seed, and is still on a real chain", () => {
  const { reachedAllowed } = walkSeedImports(botReachableFiles());
  for (const [rel, reason] of Object.entries(ALLOWED_HOST_SIDE)) {
    const file = resolve(ROOT, rel);
    assert.ok(reason.length > 40, rel + ": the allow-list entry carries a reason");
    const src = readFileSync(file, "utf8");
    assert.ok(
      importSpecifiers(src).some((spec) => namesSeedModule(spec, file)),
      rel + " is on the allow-list but no longer imports the seed: delete the entry",
    );
    assert.ok(
      reachedAllowed.has(rel),
      rel + " is on the allow-list but nothing bot-reachable reaches it any more: delete the entry",
    );
  }
  for (const [rel, reason] of Object.entries(ALLOWED_DYNAMIC_IMPORT)) {
    assert.ok(reason.length > 20, rel + ": the non-literal-import entry carries a reason");
    assert.ok(
      botReachableFiles().some((f) => allowListHas({ [rel]: reason }, relative(ROOT, f).split(sep).join("/"))),
      rel + " is allow-listed for a non-literal import but no bot-reachable file matches it",
    );
  }
});

// ─── the guard refuses a planted import (fixture list + a temp tree) ─────────

test("a fixture list IS flagged: relative, dynamic, require and the appImport seam alike", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-seed-guard-"));
  try {
    mkdirSync(join(root, "servers", "sharing"), { recursive: true });
    mkdirSync(join(root, "bundles", "planted", "server"), { recursive: true });
    mkdirSync(join(root, "scripts", "pi-bots"), { recursive: true });
    writeFileSync(join(root, "servers", "sharing", "identity.js"), "export const x = 1;\n");
    writeFileSync(join(root, "servers", "sharing", "secret-box.js"), "export const y = 1;\n");
    const planted = {
      "bundles/planted/server/index.js": 'import { loadIdentityIfPresent } from "../../../servers/sharing/identity.js";\n',
      "bundles/planted/server/dynamic.mjs": 'const m = await import("../../../servers/sharing/secret-box.js");\n',
      "scripts/pi-bots/require-it.mjs": 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst box = require("../../servers/sharing/secret-box.js");\n',
      "scripts/pi-bots/seam.mjs": 'const { loadIdentityIfPresent } = await appImport("servers/sharing/identity.js");\n',
      "scripts/pi-bots/clean.mjs": 'import { readFileSync } from "node:fs";\n',
    };
    for (const [rel, src] of Object.entries(planted)) writeFileSync(join(root, rel), src);
    const files = Object.keys(planted).map((rel) => join(root, rel));
    const violations = seedImportViolations(files, { root });
    const flagged = violations.map((v) => v.file).sort();
    assert.deepEqual(flagged, [
      "bundles/planted/server/dynamic.mjs",
      "bundles/planted/server/index.js",
      "scripts/pi-bots/require-it.mjs",
      "scripts/pi-bots/seam.mjs",
    ]);
    assert.equal(violations.some((v) => v.file === "scripts/pi-bots/clean.mjs"), false, "a plain import is fine");

    // The allow-list is by path, and the same planted import under an allowed name is skipped.
    const allowed = seedImportViolations([join(root, "scripts/pi-bots/seam.mjs")], {
      root, allow: { "scripts/pi-bots/seam.mjs": "a fixture that stands in for the host-side hydration" },
    });
    assert.deepEqual(allowed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a planted import in a COPY of the real tree is caught by the same derivation", () => {
  // Copy the shape, not the bytes: the derivation walks whatever `root` it is given, so a
  // planted file in a bot-reachable directory of a copy is found without touching this repo.
  const root = mkdtempSync(join(tmpdir(), "crow-seed-copy-"));
  try {
    mkdirSync(join(root, "servers", "sharing"), { recursive: true });
    mkdirSync(join(root, "servers", "storage"), { recursive: true });
    writeFileSync(join(root, "servers", "sharing", "identity.js"), "export const x = 1;\n");
    writeFileSync(join(root, "servers", "storage", "index.js"), "// the child entry\n");
    writeFileSync(join(root, "servers", "storage", "sneaky.js"),
      'import { loadOrCreateIdentity } from "../sharing/identity.js";\n');
    const files = botReachableFiles({ root });
    const rels = files.map((f) => relative(root, f).split(sep).join("/")).sort();
    assert.deepEqual(rels, ["servers/storage/index.js", "servers/storage/sneaky.js"], "the copy's own tree is derived");
    // The chain is reported whole: the entry that was imported, then the specifier that reaches
    // the seed.
    assert.deepEqual(
      seedImportViolations(files, { root }).map(({ file, spec, chain }) => ({ file, spec, chain })),
      [
        { file: "servers/storage/sneaky.js", spec: "../sharing/identity.js", chain: ["servers/storage/sneaky.js", "../sharing/identity.js"] },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});