/**
 * Scratch-instance environment and home helpers shared by the research-eval harness and the live
 * pi driver. Nothing here writes to process.env or keeps module-level state; every home is
 * refused unless it is strictly below the temp dir and clear of every protected instance dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedHit, realish, realUserCrowDir, within } from "./protected-paths.mjs";
import { INSTANCE_PATH_ENV_KEYS, PINNED_PATH_ENV_KEYS } from "../../servers/shared/crow-home.js";

/**
 * Variables a scratch child must never inherit: every pinned per-instance path (they would point
 * it at a real instance's files), the search key (the network), and the supervision and actor
 * markers. The scratch overrides below are applied after the drop.
 */
const DROP = [...new Set([...INSTANCE_PATH_ENV_KEYS, ...PINNED_PATH_ENV_KEYS, "BRAVE_API_KEY", "INVOCATION_ID",
  "CROW_SUPERVISED", "CROW_ACTOR_KIND", "CROW_ACTOR_BOT_ID"])];

/**
 * The environment of a scratch instance's children. Pure: returns a new object built from a copy
 * of `parent` (process.env by default) and never assigns to either.
 * @param {string} home the scratch CROW_HOME
 * @param {string} botId the acting bot's id (the fixture server attributes every write to it)
 * @param {Record<string, string|undefined>} [parent] the env to inherit from
 */
export function scratchEnv(home, botId, parent = process.env) {
  const env = { ...parent };
  for (const k of DROP) delete env[k];
  return {
    ...env,
    HOME: home,
    CROW_HOME: home,
    CROW_DATA_DIR: join(home, "data"),
    CROW_DB_PATH: join(home, "data", "crow.db"),
    CROW_APP_ENV_PATH: join(home, "gateway.env"),
    CROW_DISABLE_NOSTR: "1",
    CROW_DISABLE_INSTANCE_SYNC: "1",
    CROW_RESEARCH_EVAL: "1",
    CROW_ACTOR_KIND: "bot",
    CROW_ACTOR_BOT_ID: botId,
    CROW_JOURNAL_MODE: "DELETE",
  };
}

/** A fresh home strictly below the temp dir, refused when it touches a protected instance dir. */
export function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "crow-rr-"));
  const real = realish(home);
  const tmp = realish(tmpdir());
  const userCrow = realish(realUserCrowDir());
  const bad = real === tmp || !within(real, tmp) ? "is not strictly below the temp dir"
    : protectedHit(home) ? "overlaps a protected instance directory"
      : within(real, userCrow) || within(userCrow, real) ? "overlaps the real user's crow dir" : null;
  if (bad) {
    // Only a directory this call just created is removed.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`research-eval scratch refused: ${home} ${bad}`);
  }
  return home;
}
