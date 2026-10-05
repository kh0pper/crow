/**
 * bundle-installed-copy-imports — a bundle must work from its INSTALLED copy,
 * not only from the app checkout.
 *
 * WHY THIS TEST EXISTS: the Extensions page installs a bundle by copying
 * `bundles/<id>/` to `<CROW_HOME>/bundles/<id>/`, and copies its panel and
 * panel-routes files a second time to `<CROW_HOME>/panels/<id>.js` and
 * `<CROW_HOME>/panels/<id>-routes.js`. A module that imports
 * `../../../servers/db.js` resolves in the checkout and nowhere else: the
 * installed MCP server dies at spawn with ERR_MODULE_NOT_FOUND (or, when the
 * import sits in a try/catch, silently runs without rate limits, confirm
 * gates or notifications), and an installed panel never loads.
 *
 * WHAT IT DOES: lays every bundle out the way an install does, in a scratch
 * home OUTSIDE the repo (so a repo-relative specifier cannot resolve by
 * accident), then
 *
 *   1. statically resolves every relative `import` / `export … from` /
 *      `import()` / `require()` specifier reachable from the modules the
 *      gateway loads, and requires each to land on a file inside the installed
 *      bundle;
 *   2. checks that every literal app path a bundle hands to the app-root
 *      mechanism (`appImport("servers/…")`, `join(appRoot, "servers/…")`)
 *      names a file the app really ships;
 *   3. imports each panel / panel-routes / settings-section module from the
 *      scratch copy in a throwaway child process (scratch HOME, CROW_HOME and
 *      data dir; sockets and subprocesses disabled) and reports any module
 *      that could not be found.
 *
 * The supported way out of a bundle is the app root, never a relative path:
 * `server/app-root.js` (`appImport`) for the MCP server process, and
 * `process.env.CROW_APP_ROOT` / the handler's `appRoot` for code the gateway
 * loads. See docs/developers/bundles.md, "Running from the installed copy".
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  readdirSync, readFileSync, existsSync, statSync, cpSync, mkdirSync, mkdtempSync,
  rmSync, writeFileSync, symlinkSync,
} from "node:fs";
import { join, dirname, resolve, relative, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(ROOT, "bundles");

/**
 * Known violations, each owned by work already in flight. An entry silences
 * exactly one (bundle, file, specifier) and MUST be deleted with the fix: the
 * "allowlist is not stale" test below fails for any entry that no longer
 * matches a real violation.
 */
const KNOWN_VIOLATIONS = [
  // tracked: media phase 1 (the analyzer is removed there)
  { bundle: "media", file: "server/ai-analyzer.js", spec: "../../gateway/ai/provider.js", tracked: "media phase 1" },
  // tracked: funkwhale rework (its owner). Each import sits in a try/catch, so the installed
  // server starts but runs WITHOUT rate limiting, the moderation queue and notifications.
  { bundle: "funkwhale", file: "server/server.js", spec: "../../../servers/shared/rate-limiter.js", tracked: "funkwhale rework" },
  { bundle: "funkwhale", file: "server/server.js", spec: "../../../servers/db.js", tracked: "funkwhale rework" },
  { bundle: "funkwhale", file: "server/server.js", spec: "../../../servers/shared/notifications.js", tracked: "funkwhale rework" },
];

// ---------------------------------------------------------------------------
// Installed-tree layout
// ---------------------------------------------------------------------------

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-installed-copy-"));
const HOME = join(SCRATCH, "home");
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Never part of what a bundle's code can rely on being copied. */
const SKIP_DIRS = new Set(["node_modules", ".git", "data", ".venv", "__pycache__"]);
/** Directories whose modules the gateway (or panel code) loads by computed path. */
const CODE_DIRS = ["server", "panel", "panels", "routes"];
const JS_RE = /\.(js|mjs|cjs)$/;

const inside = (p, dir) => p === dir || p.startsWith(dir + sep);
/** A resolved path as the operator would see it in the log: relative to the instance home when under it. */
function shownPath(target, bundle) {
  const home = dirname(bundle.panelsDir);
  return inside(target, home) ? `<CROW_HOME>/${relative(home, target).split(sep).join("/")}` : "a path above <CROW_HOME>";
}
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const isRelative = (s) => s === "." || s === ".." || s.startsWith("./") || s.startsWith("../");

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, out);
    else if (ent.isFile() && JS_RE.test(ent.name)) out.push(p);
  }
  return out;
}

/** Mirrors resolvePanelPath() in servers/gateway/routes/bundles.js. */
function panelSourcePath(manifest, id) {
  if (!manifest?.panel) return null;
  if (typeof manifest.panel === "string") return manifest.panel;
  return `panel/${manifest.panel.id || id}.js`;
}

/**
 * Copy one bundle into `home` exactly as the install path does and return the
 * modules the gateway loads from it:
 *   - the MCP server entry (spawned with cwd = the installed bundle dir),
 *   - `<home>/panels/<id>.js` and `<home>/panels/<id>-routes.js` (COPIES of the
 *     manifest's panel / panelRoutes files; this is where they execute),
 *   - `settings-section.js` (imported in place),
 *   - every module under server/, panel/, panels/ and routes/ — these are
 *     imported by computed path (bundle dir + name) from panel code and from
 *     the gateway's own mounts, which static analysis cannot follow.
 */
function installBundle({ id, srcDir, home }) {
  const manifest = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8"));
  const dest = join(home, "bundles", id);
  cpSync(srcDir, dest, { recursive: true, filter: (src) => !SKIP_DIRS.has(basename(src)) });
  const panelsDir = join(home, "panels");
  mkdirSync(panelsDir, { recursive: true });

  const entries = [];
  const gatewayLoaded = [];
  const add = (file, source, surface) => entries.push({ file, source, surface });

  const serverEntry = manifest.server?.command === "node" && typeof manifest.server.args?.[0] === "string"
    && !manifest.server.args[0].startsWith("-") ? manifest.server.args[0] : null;
  if (serverEntry) add(join(dest, serverEntry), serverEntry, "server");

  const panelRel = panelSourcePath(manifest, id);
  const copiedSources = new Set();
  if (panelRel && isFile(join(dest, panelRel))) {
    const installed = join(panelsDir, `${id}.js`);
    cpSync(join(dest, panelRel), installed);
    add(installed, panelRel, "panel");
    gatewayLoaded.push({ file: installed, source: panelRel });
    copiedSources.add(join(dest, panelRel));
  }
  if (typeof manifest.panelRoutes === "string" && isFile(join(dest, manifest.panelRoutes))) {
    const installed = join(panelsDir, `${id}-routes.js`);
    cpSync(join(dest, manifest.panelRoutes), installed);
    add(installed, manifest.panelRoutes, "panelRoutes");
    gatewayLoaded.push({ file: installed, source: manifest.panelRoutes });
    copiedSources.add(join(dest, manifest.panelRoutes));
  }
  if (isFile(join(dest, "settings-section.js"))) {
    add(join(dest, "settings-section.js"), "settings-section.js", "settings");
    gatewayLoaded.push({ file: join(dest, "settings-section.js"), source: "settings-section.js" });
  }
  for (const d of CODE_DIRS) {
    for (const file of walkJs(join(dest, d))) {
      // The panel / routes entry files execute from <home>/panels/, covered above.
      if (!copiedSources.has(file)) add(file, relative(dest, file).split(sep).join("/"), "code");
    }
  }
  return { id, manifest, dest, panelsDir, entries, gatewayLoaded };
}

// ---------------------------------------------------------------------------
// Static analysis
// ---------------------------------------------------------------------------

function parseModule(src, label) {
  const opts = {
    ecmaVersion: "latest", allowHashBang: true, allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
  };
  try { return acorn.parse(src, { ...opts, sourceType: "module" }); } catch (moduleErr) {
    try { return acorn.parse(src, { ...opts, sourceType: "script" }); } catch {
      throw new Error(`${label}: ${moduleErr.message}`);
    }
  }
}

const stringLiteral = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : null);
const APP_PATH_RE = /^(servers|scripts|bundles)\/[\w@./-]+\.(js|mjs|cjs)$/;
const DEFAULT_HOME_BUNDLES_RE = /(^|\/)\.crow\/bundles(\/|$)/;

/** Every specifier a module can resolve at load or call time, by kind. */
function moduleSpecifiers(src, label) {
  const ast = parseModule(src, label);
  const out = [];
  walk.simple(ast, {
    ImportDeclaration(n) { out.push({ kind: "import", spec: n.source.value }); },
    ExportNamedDeclaration(n) { if (n.source) out.push({ kind: "import", spec: n.source.value }); },
    ExportAllDeclaration(n) { out.push({ kind: "import", spec: n.source.value }); },
    ImportExpression(n) {
      const s = stringLiteral(n.source);
      if (s !== null) out.push({ kind: "import", spec: s });
      else if (n.source.type === "TemplateLiteral") {
        const head = n.source.quasis[0].value.cooked ?? "";
        out.push(n.source.expressions.length === 0 ? { kind: "import", spec: head } : { kind: "template", spec: head });
      }
    },
    CallExpression(n) {
      const callee = n.callee.type === "Identifier" ? n.callee.name
        : n.callee.type === "MemberExpression" && n.callee.property.type === "Identifier" ? n.callee.property.name : null;
      if (!callee || n.arguments.length === 0) return;
      if (callee === "require" && n.callee.type === "Identifier") {
        const s = stringLiteral(n.arguments[0]);
        if (s !== null) out.push({ kind: "require", spec: s });
      } else if (callee === "appImport") {
        const s = stringLiteral(n.arguments[0]);
        if (s !== null) out.push({ kind: "app", spec: s, shown: `appImport("${s}")` });
      } else if (callee === "join" || callee === "resolve") {
        // join(appRoot, "servers", "gateway", "x.js") / join(appRoot, "servers/gateway/x.js"):
        // the trailing run of string literals is an app path when it starts at servers/ or scripts/.
        const tail = [];
        for (let i = n.arguments.length - 1; i >= 0; i--) {
          const s = stringLiteral(n.arguments[i]);
          if (s === null) break;
          tail.unshift(s);
        }
        for (let i = 0; i < tail.length; i++) {
          const p = tail.slice(i).join("/");
          if (APP_PATH_RE.test(p)) { out.push({ kind: "app", spec: p, shown: `${callee}(…, "${tail.slice(i).join('", "')}")` }); break; }
        }
        // join(homedir(), ".crow", "bundles", "<id>", …): the DEFAULT home, hardcoded.
        // A co-hosted instance (its own CROW_HOME) would load another instance's copy, or nothing.
        const lits = n.arguments.map(stringLiteral);
        for (let i = 0; i < lits.length; i++) {
          if (lits[i] === null) continue;
          let j = i;
          while (j < lits.length && lits[j] !== null) j++;
          const run = lits.slice(i, j);
          if (DEFAULT_HOME_BUNDLES_RE.test(run.join("/"))) {
            out.push({ kind: "home", spec: `${callee}(…, "${run.join('", "')}")` });
          }
          i = j;
        }
      }
    },
  });
  return out;
}

/**
 * Resolve everything reachable from an installed bundle's loaded modules.
 * Returns [{ bundle, file, spec, why }] where `file` is the bundle-relative
 * SOURCE path (stable across the two install locations).
 */
function analyzeBundle(bundle, { appRoot = ROOT } = {}) {
  const { id, dest, panelsDir } = bundle;
  const violations = [];
  const seenFiles = new Set();
  const seenViolations = new Set();
  const report = (file, spec, why) => {
    const key = `${file}\0${spec}`;
    if (seenViolations.has(key)) return;
    seenViolations.add(key);
    violations.push({ bundle: id, file, spec, why });
  };
  const ownPanelFiles = new Set([join(panelsDir, `${id}.js`), join(panelsDir, `${id}-routes.js`)]);
  const queue = bundle.entries.map((e) => ({ file: e.file, source: e.source }));

  while (queue.length) {
    const { file, source } = queue.shift();
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    if (!JS_RE.test(file)) continue;
    const runsFrom = inside(file, panelsDir) ? `, which runs from panels/${basename(file)}` : "";
    let specs;
    try { specs = moduleSpecifiers(readFileSync(file, "utf8"), `${id}/${source}`); } catch (err) {
      report(source, "(parse)", `cannot be parsed: ${err.message}`);
      continue;
    }
    for (const s of specs) {
      if (s.kind === "app") {
        if (!isFile(join(appRoot, s.spec))) report(source, s.shown, `the app ships no ${s.spec}`);
        continue;
      }
      if (s.kind === "home") {
        report(source, s.spec, "hardcodes the default home; an instance with its own CROW_HOME finds another instance's copy or none — " +
          'use join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", …)');
        continue;
      }
      if (!isRelative(s.spec)) continue; // bare packages: tests/bundle-server-deps.test.js
      const base = dirname(file);
      if (s.kind === "template") {
        // `./locales/${lang}.js`: only the static directory prefix can be checked.
        const dir = resolve(base, s.spec.endsWith("/") ? s.spec : dirname(s.spec));
        if (!inside(dir, dest)) report(source, `${s.spec}\${…}`, `leaves the installed bundle${runsFrom}`);
        else if (!existsSync(dir)) report(source, `${s.spec}\${…}`, `no such directory in the installed bundle${runsFrom}`);
        continue;
      }
      let target = resolve(base, s.spec);
      if (s.kind === "require" && !isFile(target)) {
        const hit = [".js", ".cjs", ".json", `${sep}index.js`].map((x) => target + x).find(isFile);
        if (hit) target = hit;
      }
      const allowed = inside(target, dest) || ownPanelFiles.has(target);
      if (!allowed) {
        report(source, s.spec, `resolves to ${shownPath(target, bundle)}, outside the installed bundle${runsFrom}`);
        continue;
      }
      if (!isFile(target)) {
        report(source, s.spec, `no such file in the installed bundle${runsFrom}`);
        continue;
      }
      queue.push({ file: target, source: inside(target, dest) ? relative(dest, target).split(sep).join("/") : source });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Run the static pass over every bundle (module scope: cheap, synchronous)
// ---------------------------------------------------------------------------

const installed = [];
for (const ent of readdirSync(BUNDLES, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const srcDir = join(BUNDLES, ent.name);
  if (!existsSync(join(srcDir, "manifest.json"))) continue;
  installed.push(installBundle({ id: ent.name, srcDir, home: HOME }));
}
const found = new Map(installed.map((b) => [b.id, analyzeBundle(b)]));
const knownKey = (v) => `${v.bundle}\0${v.file}\0${v.spec}`;
const known = new Set(KNOWN_VIOLATIONS.map(knownKey));
const describe = (v) => `  ${v.bundle}: ${v.file} imports ${JSON.stringify(v.spec)} — ${v.why}`;
const FIX_HINT = "\nA bundle reaches app code through the app root (server/app-root.js appImport(), " +
  "process.env.CROW_APP_ROOT, the panel handler's appRoot) and its own code through its installed " +
  "directory — never a relative path out of the bundle. See docs/developers/bundles.md.";

test("the installed tree is built outside the repo and covers the bundles", () => {
  assert.ok(!inside(SCRATCH, ROOT), "scratch install tree must not live inside the repo");
  assert.ok(installed.length > 50, `expected the full bundle set, got ${installed.length}`);
  const dd = installed.find((b) => b.id === "data-dashboard");
  assert.ok(dd, "data-dashboard must be scanned");
  assert.ok(dd.entries.some((e) => e.surface === "server"), "data-dashboard server entry must be an entry point");
  assert.ok(dd.entries.some((e) => e.surface === "panel" && inside(e.file, join(HOME, "panels"))),
    "a panel must be analysed where the install copies it (<home>/panels/<id>.js)");
});

for (const b of installed) {
  test(`bundle ${b.id}: installed copy imports nothing outside itself`, () => {
    const unknown = found.get(b.id).filter((v) => !known.has(knownKey(v)));
    assert.equal(unknown.length, 0,
      `${unknown.length} import(s) only resolve from the app checkout:\n${unknown.map(describe).join("\n")}${FIX_HINT}`);
  });
}

test("allowlist is not stale: every KNOWN_VIOLATIONS entry still names a real violation", () => {
  const live = new Set([...found.values()].flat().map(knownKey));
  const stale = KNOWN_VIOLATIONS.filter((k) => !live.has(knownKey(k)));
  assert.equal(stale.length, 0,
    `fixed (or moved) — delete from KNOWN_VIOLATIONS:\n${stale.map((k) => `  ${k.bundle}: ${k.file} ${JSON.stringify(k.spec)} (tracked: ${k.tracked})`).join("\n")}`);
  for (const k of KNOWN_VIOLATIONS) assert.ok(k.tracked, `allowlist entry ${k.bundle}:${k.file} needs a "tracked" owner`);
});

// ---------------------------------------------------------------------------
// The analyzer itself: a fixture bundle with one of each defect
// ---------------------------------------------------------------------------

test("analyzer self-check: a fixture bundle with each defect is caught, and its clean imports are not", () => {
  const fx = mkdtempSync(join(SCRATCH, "fixture-"));
  const src = join(fx, "repo", "bundles", "fx");
  const app = join(fx, "repo");
  const w = (rel, body) => { mkdirSync(dirname(join(src, rel)), { recursive: true }); writeFileSync(join(src, rel), body); };
  mkdirSync(join(app, "servers", "shared"), { recursive: true });
  writeFileSync(join(app, "servers", "db.js"), "export const createDbClient = () => ({});\n");
  w("manifest.json", JSON.stringify({
    id: "fx", server: { command: "node", args: ["server/index.js"] }, panel: "panel/fx.js", panelRoutes: "panel/routes.js",
  }));
  w("server/index.js", [
    'import { a } from "./ok.js";',
    'import { createDbClient } from "../../../servers/db.js";',
    'export * from "../../../servers/shared/x.js";',
    'const lazy = async () => import("../../../servers/shared/lazy.js");',
    "const tpl = async (n) => import(`../../../servers/${n}.js`);",
    "const okTpl = async (n) => import(`./locales/${n}.js`);",
    'const { appImport } = await import("./app-root.js");',
    'await appImport("servers/db.js");',
    'await appImport("servers/nope.js");',
    "// import('../../../servers/in-a-comment.js')",
    'const s = "import x from \'../../../servers/in-a-string.js\'";',
  ].join("\n"));
  w("server/ok.js", 'export const a = 1;\nimport "./missing.js";\n');
  w("server/app-root.js", "export const appImport = (rel) => import(rel);\n");
  w("server/locales/en.js", "export default {};\n");
  w("server/legacy.cjs", 'const j = require("./ok");\nconst k = require("../../../servers/db");\n');
  w("panel/fx.js", [
    'import { join } from "node:path";',
    'import { helper } from "./helper.js";',
    "export default { id: 'fx', handler: async (req, res, { appRoot }) => {",
    '  await import(join(appRoot, "servers/db.js"));',
    '  await import(join(appRoot, "servers", "gateway", "gone.js"));',
    '  const ok = join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "fx", "server");',
    '  const bad = join(homedir(), ".crow", "bundles", "fx", "server");',
    "} };",
  ].join("\n"));
  w("panel/helper.js", "export const helper = 1;\n");
  w("panel/routes.js", 'import express from "express";\nexport default () => null;\n');

  const home = join(fx, "home");
  const got = analyzeBundle(installBundle({ id: "fx", srcDir: src, home }), { appRoot: app })
    .map((v) => `${v.file} | ${v.spec}`).sort();
  assert.deepEqual(got, [
    'panel/fx.js | ./helper.js',
    'panel/fx.js | join(…, ".crow", "bundles", "fx", "server")',
    'panel/fx.js | join(…, "servers", "gateway", "gone.js")',
    "server/index.js | ../../../servers/${…}",
    "server/index.js | ../../../servers/db.js",
    "server/index.js | ../../../servers/shared/lazy.js",
    "server/index.js | ../../../servers/shared/x.js",
    'server/index.js | appImport("servers/nope.js")',
    "server/legacy.cjs | ../../../servers/db",
    "server/ok.js | ./missing.js",
  ]);
});

// ---------------------------------------------------------------------------
// Runtime: load what the gateway loads, from the scratch copy
// ---------------------------------------------------------------------------

const RUNNER = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports, createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Hermetic: no sockets (network, docker.sock), no subprocesses.
const net = require("node:net");
net.Socket.prototype.connect = function () { throw new Error("sockets are disabled in the installed-copy guard"); };
const cp = require("node:child_process");
for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cp[k] = () => { throw new Error("subprocesses are disabled in the installed-copy guard"); };
}
syncBuiltinESMExports();
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});
const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const PER_IMPORT_MS = Number(process.argv[3]);
const results = [];
for (const job of jobs) {
  let timer;
  const outcome = await Promise.race([
    import(pathToFileURL(job.file).href).then(() => ({ ok: true }), (err) => ({ ok: false, code: err && err.code, message: String((err && err.message) || err) })),
    new Promise((r) => { timer = setTimeout(() => r({ ok: false, code: "GUARD_TIMEOUT", message: "import did not settle" }), PER_IMPORT_MS); }),
  ]);
  clearTimeout(timer);
  results.push({ ...job, ...outcome });
}
process.stdout.write("\\n@@RESULTS@@" + JSON.stringify(results) + "@@END@@\\n", () => process.exit(0));
`;

function runChild(args, { env, timeoutMs }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { env, cwd: SCRATCH, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, out, err }); });
  });
}

test("gateway-loaded modules import cleanly from the installed copy (child process, scratch home)", { timeout: 150_000 }, async (t) => {
  const allowlistedBundles = new Set(KNOWN_VIOLATIONS.map((k) => k.bundle));
  const jobs = installed.flatMap((b) => b.gatewayLoaded.map((g) => ({ bundle: b.id, file: g.file, source: g.source })));
  assert.ok(jobs.length > 50, `expected the panel/routes set, got ${jobs.length}`);

  // What an install provides: <home>/panels/node_modules -> the gateway's packages.
  // One link at the scratch root gives every installed module the same view.
  symlinkSync(join(ROOT, "node_modules"), join(SCRATCH, "node_modules"), "dir");
  const dataDir = join(SCRATCH, "data");
  mkdirSync(dataDir, { recursive: true });
  const runner = join(SCRATCH, "runner.mjs");
  const jobsFile = join(SCRATCH, "jobs.json");
  writeFileSync(runner, RUNNER);
  writeFileSync(jobsFile, JSON.stringify(jobs));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CROW_") && !k.startsWith("CROW_DISABLE_")) delete env[k];
  Object.assign(env, {
    HOME: SCRATCH, USERPROFILE: SCRATCH, // os.homedir(): no path can fall back to a real ~/.crow or ~/crow
    CROW_HOME: HOME, CROW_DATA_DIR: dataDir, CROW_DB_PATH: join(dataDir, "crow.db"),
    CROW_APP_ROOT: ROOT, // exactly what the gateway exports for itself and its children
    NODE_ENV: "test",
  });

  const run = await runChild([runner, jobsFile, "20000"], { env, timeoutMs: 120_000 });
  const m = /@@RESULTS@@(.*)@@END@@/s.exec(run.out);
  assert.ok(m, `the import runner did not finish (exit ${run.code}, signal ${run.signal}).\nstderr tail:\n${run.err.slice(-2000)}`);
  const results = JSON.parse(m[1]);
  assert.equal(results.length, jobs.length);

  // A missing MODULE FILE is this guard's failure. A missing bare package is
  // tests/bundle-server-deps.test.js's; any other load-time error (a module
  // that needs a live service or a migrated database) is noted, not judged.
  const missingFile = (r) => r.code === "ERR_MODULE_NOT_FOUND" && /Cannot find module/.test(r.message);
  const failures = results.filter((r) => !r.ok && missingFile(r) && !allowlistedBundles.has(r.bundle));
  for (const r of results.filter((x) => !x.ok && !failures.includes(x))) {
    t.diagnostic(`${r.bundle}/${r.source}: not judged (${r.code || "error"}) ${r.message.split("\n")[0].replaceAll(SCRATCH, "<scratch>").replaceAll(ROOT, "<app>")}`);
  }
  assert.equal(failures.length, 0,
    `module(s) not found when loaded from the installed copy:\n${failures.map((r) =>
      `  ${r.bundle}: ${r.source} — ${r.message.split("\n")[0].replaceAll(SCRATCH, "<scratch>").replaceAll(ROOT, "<app>")}`).join("\n")}${FIX_HINT}`);
});
