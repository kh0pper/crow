/**
 * The research-eval fixture server's start guard. assertEvalEnv lives in ../lib/eval-guard.mjs
 * (shared with the live pi driver) and is re-exported here, so the server stack still loads only
 * after it passes. The one static import below keeps this file's import surface to the
 * protected-path helpers (tests/research-eval.test.js checks that); the re-export is not an import.
 */
import { protectedHit, protectedRoots, realish, realUserCrowDir, within } from "../lib/protected-paths.mjs";

export { assertEvalEnv } from "../lib/eval-guard.mjs";
export { protectedHit, protectedRoots, realish, realUserCrowDir, within };
