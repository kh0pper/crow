/**
 * Import FIRST in a media test file: gives the file its own instance home, data directory and
 * database before any bundle module reads them. `npm test` shares one scratch home between test
 * files that run at the same time, and the media bundle keeps briefing audio at a fixed name
 * (<data dir>/media/audio/briefing-<id>.mp3) and opens the instance database by default, so two
 * files sharing that home overwrite each other's rows and files.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "crow-media-test-"));
process.env.CROW_HOME = ISOLATED_HOME;
process.env.CROW_DATA_DIR = ISOLATED_HOME;
process.env.CROW_DB_PATH = join(ISOLATED_HOME, "crow.db");
process.on("exit", () => { try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch {} });
