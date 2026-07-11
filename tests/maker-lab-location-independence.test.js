/**
 * Maker Lab location-independence (BH-4 phase 2) — tests/maker-lab-location-independence.test.js
 *
 * PR #166's version-refresh copies bundle code from the repo into
 * `~/.crow/bundles/<id>/` and the served panel into `~/.crow/panels/<id>.js`.
 * Deploy revealed maker-lab was REPO-LOCATION-DEPENDENT: five static
 * relative imports of repo-shared `servers/` modules only resolved from the
 * repo tree, so the installed panel failed
 * (`Cannot find module '/home/servers/shared/project-spaces.js'`) and the
 * MCP child crash-looped.
 *
 * Fix: a resolver (`bundles/maker-lab/server/app-root.js`, inlined in
 * panel/maker-lab.js since that file is copied ALONE) that finds the repo
 * root from `CROW_APP_ROOT` (set by the gateway for its spawned addon
 * children) or an in-repo relative guess, then dynamic-imports through it.
 *
 * This file:
 *  (a) is a class-regression net — no static repo-relative `servers/`
 *      import may reappear anywhere under bundles/maker-lab/{panel,server}.
 *  (b)/(c) prove the installed-location shape actually works: copy the
 *      panel (alone) / the server tree to a scratch temp dir mimicking
 *      ~/.crow/panels or ~/.crow/bundles/maker-lab, then import it in a
 *      SUBPROCESS with CROW_APP_ROOT set — it must succeed.
 *  (d) is a mutation check: a synthetic copy carrying the PRE-FIX static
 *      import reproduces the crash (proving (a)/(c) are a real regression
 *      net), then the current (fixed) content is proven green in the same
 *      spot. Only a throwaway temp copy is ever mutated — the tracked repo
 *      file under test is never touched.
 *
 * NEVER touches ~/.crow (prod). All subprocess imports run against scratch
 * temp dirs + an explicit CROW_APP_ROOT env var.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MAKER_LAB_DIR = join(REPO_ROOT, "bundles", "maker-lab");

/** Recursively list every .js file under `dir`. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Import `absPath` in a fresh node subprocess with `env` merged over the
 * current process env. Returns { status, stdout, stderr }. Never throws on
 * a non-zero exit — callers assert on `status` themselves.
 */
function runImport(absPath, env = {}) {
  const url = pathToFileURL(absPath).href;
  const code = `import(${JSON.stringify(url)}).then(() => process.exit(0)).catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: dirname(absPath),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Import routes.js's default export (the kiosk router factory) in a fresh
 * node subprocess, then invoke the router's FIRST layer directly — the
 * `router.use(["/kiosk", "/maker-lab"], ...)` gate middleware that every
 * kiosk route passes through before its own handler runs. This is the
 * non-vacuous check the panel/maker-lab.js-only `runImport` can't give us:
 * routes.js's lazy db.js/retention-sweep.js imports are wrapped in
 * try/catch, so a bare "the module imported without throwing" (exit 0)
 * would pass whether or not the import inside the try actually succeeded —
 * the catch swallows it either way. Driving the gate for real distinguishes
 * "resolved" (calls next()) from "silently degraded" (500 db_unavailable).
 *
 * Calling `router.stack[0].handle` directly (rather than routing a request
 * through the full Router matcher) is deliberate: it exercises exactly the
 * gate closure we care about without also dispatching into a real route
 * handler, which would need a fully-migrated schema in the scratch DB.
 *
 * Returns { status, stdout, stderr, observed } — `observed` is null on a
 * non-zero exit (see stderr) or the parsed `{ nextCalled: true }` /
 * `{ status: 500, body: { error: "db_unavailable" } }` result otherwise.
 */
function runKioskGateCheck(absPath, env = {}) {
  const url = pathToFileURL(absPath).href;
  const code = `
    import(${JSON.stringify(url)}).then((mod) => {
      const router = mod.default();
      const gate = router.stack[0];
      let observed = null;
      const req = { method: "GET", url: "/kiosk/api/context", headers: {}, secure: false };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { observed = { status: this.statusCode, body }; },
      };
      gate.handle(req, res, (err) => {
        if (!observed) observed = { nextCalled: true, err: err ? String(err.message || err) : null };
      });
      process.stdout.write(JSON.stringify(observed));
      process.exit(0);
    }).catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: dirname(absPath),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  let observed = null;
  try { observed = result.stdout ? JSON.parse(result.stdout.trim()) : null; } catch { observed = null; }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", observed };
}

describe("maker-lab location independence (BH-4 phase 2)", () => {
  test("no static repo-relative `servers/` import remains under panel/ or server/", () => {
    const files = [
      ...listJsFiles(join(MAKER_LAB_DIR, "panel")),
      ...listJsFiles(join(MAKER_LAB_DIR, "server")),
    ];
    assert.ok(files.length > 0, "expected to find .js files under bundles/maker-lab");
    const staticServersImport = /from\s+["'](?:\.\.\/){2,3}servers\//;
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (staticServersImport.test(src)) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      `static repo-relative "servers/" import(s) found in: ${offenders.map((f) => f.replace(REPO_ROOT + "/", "")).join(", ")}`
    );
  });

  test("installed-location panel import succeeds with CROW_APP_ROOT set (copied alone, like ~/.crow/panels)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maker-lab-panel-"));
    cpSync(join(MAKER_LAB_DIR, "panel", "maker-lab.js"), join(tmp, "maker-lab.js"));
    // Mirror the real PANELS_DIR/node_modules symlink bundles.js maintains
    // for panel route resolution (bundles.js:407-411) — the panel's `import
    // QRCode from "qrcode"` needs a resolvable node_modules alongside it.
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tmp, "node_modules"));

    const withRoot = runImport(join(tmp, "maker-lab.js"), { CROW_APP_ROOT: REPO_ROOT });
    assert.equal(withRoot.status, 0, `expected import to succeed with CROW_APP_ROOT set:\n${withRoot.stderr}`);

    // Without CROW_APP_ROOT, from a location that doesn't look like the repo,
    // the relative guess won't find servers/db.js either — it MAY fail. That
    // failure mode isn't part of the contract (a bare in-repo run without the
    // gateway's env line still works via the relative guess); only the
    // success-with-CROW_APP_ROOT path above is asserted.
  });

  test("installed-location server db.js import succeeds with CROW_APP_ROOT set (whole server/ tree copied, like ~/.crow/bundles/maker-lab)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maker-lab-server-"));
    cpSync(join(MAKER_LAB_DIR, "server"), join(tmp, "server"), { recursive: true });

    const result = runImport(join(tmp, "server", "db.js"), { CROW_APP_ROOT: REPO_ROOT });
    assert.equal(result.status, 0, `expected server/db.js to import cleanly from an installed-location copy:\n${result.stderr}`);
  });

  test("mutation: a synthetic pre-fix static import reproduces the crash, then the current content is proven green in the same spot", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maker-lab-mutant-"));
    cpSync(join(MAKER_LAB_DIR, "server"), join(tmp, "server"), { recursive: true });
    const dbPath = join(tmp, "server", "db.js");
    const current = readFileSync(dbPath, "utf8");

    // Recreate the PRE-FIX static import this bundle shipped with when PR
    // #166's version-refresh deploy crash-looped the MCP child: it only
    // resolved from the repo tree, so an installed copy crashed with
    // "Cannot find module '/home/servers/db.js'" (live gateway log evidence).
    // This mutation is applied ONLY to the throwaway tmp copy above — the
    // tracked repo file under test is never written to.
    const mutated = current.replace(
      `import { appImport } from "./app-root.js";\n\nconst { createDbClient: createSharedDbClient } = await appImport("servers/db.js");`,
      `import { createDbClient as createSharedDbClient } from "../../../servers/db.js";`
    );
    assert.notEqual(mutated, current, "mutation pattern did not match current db.js content — update this test alongside db.js");

    writeFileSync(dbPath, mutated);
    const red = runImport(dbPath, { CROW_APP_ROOT: REPO_ROOT });
    assert.notEqual(red.status, 0, "expected the pre-fix static import to fail from an installed-location copy");
    assert.match(red.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/, `expected a module-resolution error, got:\n${red.stderr}`);

    // Restore the tmp copy to the current (fixed) content and prove it's
    // green in the exact same installed-location spot — the "red-then-
    // restored" proof that the fix (not the test environment) is what
    // makes this pass.
    writeFileSync(dbPath, current);
    const green = runImport(dbPath, { CROW_APP_ROOT: REPO_ROOT });
    assert.equal(green.status, 0, `expected the current (fixed) content to import cleanly after restoring it:\n${green.stderr}`);
  });

  // ─── BH-4 phase 2 follow-up: panel/routes.js is ALSO copied alone ────────
  //
  // routes.js is copied to ~/.crow/panels/maker-lab-routes.js independently
  // of panel/maker-lab.js (bundles.js resolves `manifest.panelRoutes`
  // separately from `manifest.panel`). Its two try/catch-guarded lazy
  // imports of ../server/db.js and ../server/retention-sweep.js used to
  // resolve relative to __dirname, which on the installed copy is
  // ~/.crow/panels — not the bundle dir — so the import silently failed,
  // createDbClient/startRetentionSweep stayed null, and the gate middleware
  // (`router.use(["/kiosk","/maker-lab"], ...)`, first thing every kiosk
  // route hits) 500'd db_unavailable on every request. Fixed the same way
  // as maker-lab.js: an inlined app-root resolver + bundle-absolute imports.

  test("installed-location routes.js import succeeds with CROW_APP_ROOT set (copied alone, like ~/.crow/panels)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maker-lab-routes-import-"));
    cpSync(join(MAKER_LAB_DIR, "panel", "routes.js"), join(tmp, "maker-lab-routes.js"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tmp, "node_modules"));

    const withRoot = runImport(join(tmp, "maker-lab-routes.js"), { CROW_APP_ROOT: REPO_ROOT });
    assert.equal(withRoot.status, 0, `expected import to succeed with CROW_APP_ROOT set:\n${withRoot.stderr}`);
  });

  test("installed-location routes.js: the db lazy-import actually resolves (non-vacuous — a bare successful import doesn't prove this, since the try/catch swallows a failed import into a null createDbClient)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maker-lab-routes-gate-"));
    cpSync(join(MAKER_LAB_DIR, "panel", "routes.js"), join(tmp, "maker-lab-routes.js"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tmp, "node_modules"));

    // Scratch DB path so createDbClient() (real better-sqlite3 client) never
    // touches ~/.crow — CROW_DB_PATH takes priority over CROW_DATA_DIR/HOME
    // resolution in servers/db.js's createDbClient().
    const scratchDbPath = join(tmp, "scratch.db");
    const result = runKioskGateCheck(join(tmp, "maker-lab-routes.js"), {
      CROW_APP_ROOT: REPO_ROOT,
      CROW_DB_PATH: scratchDbPath,
    });
    assert.equal(result.status, 0, `expected the gate-check subprocess to exit cleanly:\n${result.stderr}`);
    assert.ok(result.observed, `expected a parsed observation from the gate-check subprocess, got stdout: ${result.stdout}`);
    assert.equal(
      result.observed.nextCalled,
      true,
      `expected the kiosk gate middleware to resolve the db and call next(); got: ${JSON.stringify(result.observed)}`
    );
    assert.equal(
      result.observed.status,
      undefined,
      `gate middleware must not have set a db_unavailable response status; got: ${JSON.stringify(result.observed)}`
    );
  });

  test("class-regression: the fixed `../server/{db,retention-sweep}.js` lazy dynamic-import pattern does not reappear anywhere under panel/*.js", () => {
    // Narrower than the static-import net above (which only ever matched
    // `from "../../../servers/..."`, i.e. the shared top-level servers/
    // tree): this catches the DYNAMIC `import(pathToFileURL(resolve(__dirname,
    // "../server/...")))` shape that caused this exact regression — a
    // relative resolution assuming a sibling ../server/ dir that doesn't
    // exist once a panel/*.js file is copied alone. Scoped to the two
    // targets this follow-up fixed (db.js, retention-sweep.js) rather than
    // every `../server/*` lazy import in panel/*.js: panel/routes.js and
    // panel/maker-lab.js both have other pre-existing lazy imports of this
    // same shape (device-binding.js, sessions.js, hint-pipeline.js,
    // resolve-llm-endpoint.js, lesson-validator.js) that are a real but
    // separate, tracked, out-of-scope gap — asserting a blanket "zero
    // matches" here would either force fixing them as a drive-by (out of
    // this follow-up's stated scope) or require a brittle allowlist that
    // doesn't buy anything additional over a green earlier-run gate check.
    const files = listJsFiles(join(MAKER_LAB_DIR, "panel"));
    const lazyBrokenImport = /pathToFileURL\(resolve\(__dirname,\s*["'`]\.\.\/server\/(db|retention-sweep)\.js["'`]\)\)/;
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (lazyBrokenImport.test(src)) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      `broken "../server/{db,retention-sweep}.js" lazy dynamic-import pattern reappeared in: ` +
        `${offenders.map((f) => f.replace(REPO_ROOT + "/", "")).join(", ")}`
    );
  });
});
