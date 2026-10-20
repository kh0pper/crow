/**
 * Preloaded into every test process by scripts/run-suite.mjs (NODE_OPTIONS
 * --import). Two guards against a test touching a real instance's data:
 *
 * 1. A delete (fs rm / rmdir / unlink, sync, callback and promise forms) of
 *    anything inside a protected root, or a recursive one of an ancestor of a
 *    root, throws ECROWSUITEGUARD instead of deleting. (2026-10-17: a test's
 *    cleanup deleted a live ~/.crow/data.) A shell `rm -rf` in a child is not
 *    covered; tests/test-cleanup-hygiene.test.js scans for those.
 * 2. Drift alarm: if a SET CROW_HOME / CROW_DATA_DIR / CROW_DB_PATH ever
 *    points inside a protected root (polled every 250 ms and at exit), the
 *    process prints a loud error and writes a record under
 *    $CROW_SUITE_SCRATCH/drift/; the runner then fails the run even when every
 *    test passed. It is an alarm, not a lock (a repoint and a delete inside
 *    one tick beat the poll; guard 1 is the lock). Unset keys are not
 *    checked: 50+ files delete them on purpose.
 *
 * Protected roots: scripts/lib/protected-paths.mjs.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { protectedRoots, realish, within } from "./protected-paths.mjs";

const ROOTS = protectedRoots();
const SCRATCH = process.env.CROW_SUITE_SCRATCH || "";
const DRIFT_KEYS = ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH"];

function refusal(path, root) {
  const err = new Error(`[suite-guard] refused to delete ${path}: it is, is inside, or contains the protected ${root}`);
  err.code = "ECROWSUITEGUARD";
  process.stderr.write(`\n${err.message}\n${err.stack}\n`);
  return err;
}

const asPath = (p) => (p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : typeof p === "string" ? p : null);

// Any delete inside a protected root is refused; a recursive one is also
// refused on an ancestor of a root.
function check(path, opts) {
  const p = asPath(path);
  if (p === null) return null;
  const target = realish(p);
  for (const root of ROOTS) {
    if (within(target, root) || (opts && opts.recursive && within(root, target))) return refusal(target, root);
  }
  return null;
}

const optsOf = (o) => (o && typeof o === "object" ? o : null);
const orig = {
  rmSync: fs.rmSync, rmdirSync: fs.rmdirSync, unlinkSync: fs.unlinkSync, rm: fs.rm, rmdir: fs.rmdir, unlink: fs.unlink,
  prm: fs.promises.rm, prmdir: fs.promises.rmdir, punlink: fs.promises.unlink,
};
for (const name of ["rmSync", "rmdirSync", "unlinkSync"]) {
  fs[name] = function (path, opts) { const e = check(path, optsOf(opts)); if (e) throw e; return orig[name].apply(this, arguments); };
}
for (const name of ["rm", "rmdir", "unlink"]) {
  fs[name] = function (path, opts, cb) {
    const e = check(path, optsOf(opts));
    if (e) { const done = typeof opts === "function" ? opts : cb; if (typeof done === "function") process.nextTick(done, e); return; }
    return orig[name].apply(this, arguments);
  };
}
for (const [name, key] of [["rm", "prm"], ["rmdir", "prmdir"], ["unlink", "punlink"]]) {
  fs.promises[name] = async function (path, opts) { const e = check(path, optsOf(opts)); if (e) throw e; return orig[key].apply(this, arguments); };
}
syncBuiltinESMExports();

const reported = new Set();
function checkDrift() {
  for (const k of DRIFT_KEYS) {
    const v = process.env[k];
    if (!v) continue;
    const real = realish(v);
    const root = ROOTS.find((r) => within(real, r));
    if (!root || reported.has(`${k}=${v}`)) continue;
    reported.add(`${k}=${v}`);
    const msg = `[suite-guard] DRIFT: ${k}=${v} points into the protected ${root} (a test process must never use a real instance's paths)`;
    process.stderr.write(`\n${msg}\n${new Error("drift seen here").stack}\n`);
    if (SCRATCH) {
      try {
        fs.mkdirSync(join(SCRATCH, "drift"), { recursive: true });
        fs.writeFileSync(join(SCRATCH, "drift", `${process.pid}-${reported.size}.json`),
          JSON.stringify({ pid: process.pid, argv: process.argv.slice(1), key: k, value: v, root }) + "\n");
      } catch { /* the stderr line still reports it */ }
    }
  }
}
checkDrift();
setInterval(checkDrift, 250).unref();
process.on("exit", checkDrift);
