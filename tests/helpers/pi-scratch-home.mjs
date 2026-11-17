/**
 * A scratch HOME for any test that lets the bot bridge look at the host's homes.
 *
 * Import it FIRST — before anything that reads HOME while it is imported
 * (scripts/pi-bots/bridge.mjs, mcp_writer.mjs and model_resolver.mjs freeze
 * HOME and their instance paths at import time):
 *
 *   import "./helpers/pi-scratch-home.mjs";                    // static, first
 *   const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
 *
 * or, in a file whose imports are all dynamic:
 *
 *   const { SCRATCH_HOME } = await import("./helpers/pi-scratch-home.mjs");
 *
 * WHY. Every PiRpc spawn builds its hideFiles/hidePinDirs from
 * secret-values.js `instanceSecretsDirs()`, which by design enumerates EVERY
 * Crow home on the host: the children of $HOME (each `$HOME/.crow*`, whatever
 * it is called), the same-shaped siblings of this instance's CROW_HOME, and
 * whatever a user unit or /etc/crow declares (that second half is pointed at
 * scratch dirs below with _setSystemScanDirsForTest). For each home it finds,
 * the bridge lists the bundles' .env files — and a bundle installed as a
 * symlink into ANOTHER checkout is a link that leads outside the trusted roots
 * of the checkout under test, so a bubblewrapped spawn is refused:
 *
 *   A bot could not start: bundles/<id> is a link that leads outside the Crow
 *   folders, so Crow can't hide it. It is in the Crow home /home/x/.crow
 *
 * `npm test` sets CROW_HOME but leaves HOME alone, and a raw `node --test` sets
 * neither, so without this the operator's real ~/.crow decides whether a test
 * spawns — which is why such a test passed in one checkout and threw in a
 * worktree of it. The scratch home also keeps the operator's ~/.ssh and
 * ~/.pi/agent untouched.
 *
 * NOT re-homed: a CROW_HOME that is already set. The suite runner points it (and
 * CROW_DATA_DIR / CROW_INSTANCES_JSON_PATH) at its own scratch, and modules
 * freeze those paths when they are imported; moving them here would silently
 * repoint a test's database. Only a raw `node --test`, with no CROW_HOME, gets
 * them — under this scratch home, so nothing resolves to ~/.crow either way.
 *
 * The home is EMPTY apart from what a test creates: the scan seam's own dirs sit
 * beside it under one scratch root, so the co-host scan finds nothing to add.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSystemScanDirsForTest } from "../../servers/shared/secret-values.js";
import { rmScratch } from "./safe-rm.js";

const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "crow-test-home-"));
/** The scratch home this process now runs with. */
export const SCRATCH_HOME = join(SCRATCH_ROOT, "home");
mkdirSync(SCRATCH_HOME, { recursive: true });
process.env.HOME = SCRATCH_HOME;

if (!process.env.CROW_HOME) {
  process.env.CROW_HOME = join(SCRATCH_HOME, ".crow");
  process.env.CROW_DATA_DIR ||= join(process.env.CROW_HOME, "data");
  process.env.CROW_DB_PATH ||= join(process.env.CROW_DATA_DIR, "crow.db");
  process.env.CROW_INSTANCES_JSON_PATH ||= join(SCRATCH_HOME, "instances.json");
}
mkdirSync(process.env.CROW_HOME, { recursive: true });
if (process.env.CROW_DATA_DIR) mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

// The /etc half of the co-host scan: a dev box whose /etc declares another Crow
// home must not change these spawns. The per-user half follows the scratch HOME.
const SCAN_UNITS = join(SCRATCH_ROOT, "scan-units");
const SCAN_ENV = join(SCRATCH_ROOT, "scan-etc-crow");
mkdirSync(SCAN_UNITS, { recursive: true });
mkdirSync(SCAN_ENV, { recursive: true });
_setSystemScanDirsForTest({ unitDirs: [SCAN_UNITS], envFileDirs: [SCAN_ENV] });

process.on("exit", () => { try { rmScratch(SCRATCH_ROOT); } catch { /* gone */ } });