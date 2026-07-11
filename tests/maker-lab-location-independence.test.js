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
});
