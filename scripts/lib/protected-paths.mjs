/**
 * Path helpers shared by the suite guard (scripts/lib/suite-guard.mjs) and the
 * test cleanup helper (tests/helpers/safe-rm.js).
 *
 * A "protected root" is a real instance's directory that no test process may
 * delete or adopt as its own: the real user's ~/.crow, plus every instance path
 * the invoking shell or the checkout .env named. scripts/run-suite.mjs passes
 * them to every test process as CROW_SUITE_PROTECTED_ROOTS (newline separated).
 */
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** realpath of `p`, resolving through its nearest existing ancestor when `p` does not exist. */
export function realish(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch { /* walk up */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    tail.push(basename(cur));
    cur = up;
  }
}

export const within = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The real user's ~/.crow, from the passwd entry (a test can change HOME; it cannot change this). */
export function realUserCrowDir() {
  let home;
  try { home = userInfo().homedir; } catch { home = homedir(); }
  return join(home, ".crow");
}

/** The protected roots for this process, realpath'd. */
export function protectedRoots(env = process.env) {
  const roots = [realUserCrowDir()];
  for (const r of String(env.CROW_SUITE_PROTECTED_ROOTS || "").split("\n")) if (r.trim()) roots.push(r.trim());
  return [...new Set(roots.map(realish))];
}

/** The protected root `p` is inside, or that `p` contains; null when neither. */
export function protectedHit(p, roots = protectedRoots()) {
  const target = realish(p);
  for (const root of roots) if (within(target, root) || within(root, target)) return root;
  return null;
}
