/**
 * Research-eval scratch instances: a throwaway CROW_HOME under the temp dir with a real crow.db
 * (init-db + one research project), for one (case, rep) row.
 *
 * A template is built once per run (or per test file) by one scratch-init.mjs child, and each
 * row copies its crow.db. CROW_JOURNAL_MODE=DELETE in the scratch env keeps every write in the
 * single DB file (no -wal), so a plain file copy is a complete database. The copied DBs keep the
 * template's absolute workspace_dir, so a template must outlive every scratch copied from it.
 *
 * Nothing here writes to process.env or keeps module-level state: two scratches built at once
 * are independent. The real ~/.crow is never read or written; every home is refused unless it is
 * strictly below the temp dir and clear of every protected instance directory.
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { protectedHit, realish, realUserCrowDir, within } from "../lib/protected-paths.mjs";
import { skillRequiredTools } from "../pi-bots/skill-tools.mjs";

const execFileP = promisify(execFile);

export const ROOT = join(import.meta.dirname, "..", "..");
export const SKILL = "research-pipeline";
const INIT = join(import.meta.dirname, "scratch-init.mjs");
const INIT_TIMEOUT_MS = 120_000;

/** Variables a scratch child must never inherit: they would point it at a real instance or the network. */
const DROP = ["CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_ALLOW_SHARED_DATA_DIR", "BRAVE_API_KEY", "INVOCATION_ID",
  "CROW_SUPERVISED", "CROW_ACTOR_KIND", "CROW_ACTOR_BOT_ID"];

/**
 * The environment of a scratch instance's children. Pure: returns a new object built from a copy
 * of process.env and never assigns to process.env.
 * @param {string} home the scratch CROW_HOME
 * @param {string} botId the acting bot's id (the fixture server attributes every write to it)
 */
export function scratchEnv(home, botId) {
  const env = { ...process.env };
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
function freshHome() {
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

/** Runs scratch-init.mjs in `home` (init-db + one project, one child) → its projectId. */
async function initHome(home, botId) {
  const resultPath = join(home, "init-result.json");
  try {
    await execFileP(process.execPath, [INIT, resultPath], {
      env: scratchEnv(home, botId), cwd: ROOT, timeout: INIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const tail = String(err.stderr || "").trim().split("\n").slice(-5).join("\n");
    throw new Error(`research-eval scratch-init failed: ${err.message}${tail ? `\n${tail}` : ""}`);
  }
  const { projectId } = JSON.parse(readFileSync(resultPath, "utf8"));
  if (!Number.isInteger(projectId)) throw new Error(`research-eval scratch-init returned no project id (${projectId})`);
  return projectId;
}

/**
 * The template home: one scratch-init child, built ONCE per run or per test file. Keep it until
 * the last scratch copied from it is done (the copies keep its workspace_dir).
 * @returns {Promise<{home: string, dbPath: string, projectId: number, cleanup: () => void}>}
 */
export async function makeTemplate({ botId = "research-eval" } = {}) {
  const home = freshHome();
  try {
    const projectId = await initHome(home, botId);
    return { home, dbPath: join(home, "data", "crow.db"), projectId, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
}

/**
 * One row's scratch instance. With `template`, its crow.db is a copy of the template's; without,
 * it runs its own scratch-init child.
 * @returns {Promise<{home, dataDir, dbPath, projectId, botId, granted: string[], env, sessionPath, fetchLogPath, cleanup}>}
 */
export async function makeScratch({ botId = "research-eval", template } = {}) {
  const home = freshHome();
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    const dataDir = join(home, "data");
    const dbPath = join(dataDir, "crow.db");
    let projectId;
    if (template) {
      mkdirSync(dataDir, { recursive: true });
      copyFileSync(template.dbPath, dbPath);
      projectId = template.projectId;
    } else {
      projectId = await initHome(home, botId);
    }
    return {
      home, dataDir, dbPath, projectId, botId,
      granted: skillRequiredTools(SKILL, { crowHome: home, repoSkillsDir: join(ROOT, "skills") }),
      env: scratchEnv(home, botId),
      sessionPath: join(home, "session.jsonl"),
      fetchLogPath: join(home, "fetch.jsonl"),
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
