/**
 * rmScratch(path): the recursive delete a test's cleanup should use.
 *
 * It deletes `path` only when it is strictly inside os.tmpdir() and neither is
 * nor contains a protected root (the real user's ~/.crow, or an entry of
 * CROW_SUITE_PROTECTED_ROOTS set by scripts/run-suite.mjs). Anything else
 * throws. Pass it the path you created at setup, held in a constant; never
 * re-read process.env at cleanup time: on 2026-10-17 a cleanup read
 * CROW_DATA_DIR after code under test had repointed it at a live data dir.
 * (tests/test-cleanup-hygiene.test.js enforces that.)
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { realish, within, protectedHit } from "../../scripts/lib/protected-paths.mjs";

export function rmScratch(path) {
  if (typeof path !== "string" || path === "") throw new Error(`rmScratch: refusing a non-path (${String(path)})`);
  const target = realish(path);
  const tmp = realish(tmpdir());
  if (target === tmp || !within(target, tmp)) {
    throw new Error(`rmScratch: refusing ${target}: not strictly inside ${tmp}`);
  }
  const root = protectedHit(target);
  if (root) throw new Error(`rmScratch: refusing ${target}: it is, or contains, the protected ${root}`);
  rmSync(target, { recursive: true, force: true });
}
