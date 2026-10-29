/**
 * Follow-the-primary update (SAT-6, spec §10, S11 a): crow sends `POST /satellite/v1/update
 * {target_sha}` with its own boot sha; the satellite never runs ahead of crow.
 *
 * Accepted only when, in order:
 *   - target_sha is a full 40-hex sha;
 *   (no "heard from crow lately" check here: this path is crow's own signed request, which proves
 *     crow is reachable. The 7-day rule, UNREACHABLE_MAX_MS / crowUnreachable(), is for a future
 *     satellite-initiated update: a satellite cut off from crow for a week never updates itself);
 *   - it differs from the current HEAD;
 *   - after `git fetch origin main` it is a known commit, an ancestor of (or equal to)
 *     origin/main, and a fast-forward of HEAD;
 *   - classifyCheckRuns (shared with the gateway's auto-update) says "green" for it. Unlike the
 *     gateway, "unknown" and "pending" refuse: a satellite updates only to a knowably green sha.
 * Then (apply): satellite.db backup → `git merge --ff-only <target>` → `npm ci --omit=dev` only if
 * package-lock.json changed (systemd-run --user --scope -p MemoryMax=600M, nice, ionice; the MCP
 * children are paused first via `beforeInstall`, and resumed by `afterRollback` if the update
 * rolls back without a restart) → the
 * NEW tree's `cli.js self-check` (its module graph loads) → its `cli.js migrate`
 * (SAT_SCHEMA_VERSION, each step transactional) → supervised restart: exit
 * UPDATE_RESTART_EXIT_CODE, which the unit's Restart=on-failure restarts.
 * Any failure rolls back: `git reset --hard <previous sha>`, `npm ci` again if it had run, and if
 * the migration had started, a restore marker so the next boot puts the backup back before
 * satellite.db is opened (applyPendingDbRestore), then the restart.
 * Every git / npm / node / systemd call goes through the injectable `runner`.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run as execRun } from "../gateway/bundle-core.js";
import { classifyCheckRuns } from "../shared/ci-check-runs.js";
import { SATELLITE_DB_FILE } from "./db.js";

export const UPDATE_RESTART_EXIT_CODE = 75;
export const UNREACHABLE_MAX_MS = 7 * 86400000;

/**
 * The 7-day rule for a satellite-INITIATED update (not used by crow's POST /update): true when
 * the newest signed call in the audit log is older than UNREACHABLE_MAX_MS, or there is none.
 */
export function crowUnreachable(db, now = Date.now()) {
  const last = Date.parse(db.prepare("SELECT MAX(ts) AS ts FROM audit WHERE caller IS NOT NULL").get()?.ts || "");
  return !Number.isFinite(last) || now - last > UNREACHABLE_MAX_MS;
}
export const DB_RESTORE_MARKER = "update-restore-db.json";
export const LAST_RESULT_FILE = "update-last.json";
const BACKUPS_KEPT = 3;
const SHA = /^[0-9a-f]{40}$/;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** [cmd, args] for the capped dependency install. */
export function npmCiCommand() {
  return ["systemd-run", ["--user", "--scope", "-p", "MemoryMax=600M", "nice", "-n", "10", "ionice", "-c2", "-n7", "npm", "ci", "--omit=dev"]];
}

const backupDir = (satHome) => join(satHome, "backups", "satellite-db");

/** GitHub check-runs for `sha` on origin's repo, or null (not GitHub, network, non-200). */
async function githubCheckRuns({ runner, appRoot, sha, fetchImpl = globalThis.fetch }) {
  try {
    const { stdout } = await runner("git", ["remote", "get-url", "origin"], { cwd: appRoot, timeout: 15000 });
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(String(stdout || ""));
    if (!m) return null;
    const resp = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/${sha}/check-runs`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "crow-satellite-update" }, signal: AbortSignal.timeout(15000),
    });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

/**
 * At boot, before satellite.db is opened: a rolled-back migration's backup replaces the db (and
 * its WAL / SHM). → true when a restore was applied. A marker that names anything outside
 * $SAT_HOME/backups/satellite-db is dropped, never followed.
 */
export function applyPendingDbRestore(satHome, log = console.warn) {
  const marker = join(satHome, DB_RESTORE_MARKER);
  if (!existsSync(marker)) return false;
  let backup = null;
  try { backup = JSON.parse(readFileSync(marker, "utf8"))?.backup; } catch { /* unreadable */ }
  const root = resolve(backupDir(satHome)) + sep;
  const ok = typeof backup === "string" && resolve(backup).startsWith(root) && existsSync(backup) && statSync(backup).isFile();
  if (ok) {
    const db = join(satHome, SATELLITE_DB_FILE);
    for (const p of [`${db}-wal`, `${db}-shm`]) rmSync(p, { force: true });
    copyFileSync(backup, db);
    chmodSync(db, 0o600);
    log(`satellite: restored satellite.db from ${backup.replace(satHome, "$SAT_HOME")} after a rolled-back update`);
  } else {
    log("satellite: ignored an update restore marker that names no usable backup");
  }
  unlinkSync(marker);
  return ok;
}

export function createUpdater({
  db, satHome, appRoot = APP_ROOT, runner = execRun, now = Date.now, log = console.log,
  fetchCheckRuns, exit = (code) => process.exit(code), nodePath = process.execPath, beforeInstall = async () => {}, afterRollback = async () => {},
}) {
  const git = (args, timeout = 120000) => runner("git", args, { cwd: appRoot, timeout });
  const checkRuns = fetchCheckRuns || ((sha) => githubCheckRuns({ runner, appRoot, sha }));
  const cli = join(appRoot, "servers", "satellite", "cli.js");
  const nodeCli = (cmd) => runner(nodePath, [cli, cmd], { cwd: appRoot, timeout: 120000, env: { ...process.env, CROW_HOME: satHome } });
  let busy = false;

  const refuse = (status, code, extra = {}) => ({ ok: false, status, code, ...extra });
  const succeeds = async (fn) => { try { await fn(); return true; } catch { return false; } };

  function writeLast(rec) {
    try { writeFileSync(join(satHome, LAST_RESULT_FILE), JSON.stringify({ ...rec, at: new Date(now()).toISOString() }, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }

  /** Every acceptance rule; no change to the tree except the fetch. */
  async function check(target) {
    if (typeof target !== "string" || !SHA.test(target)) return refuse(400, "bad_target_sha");
    let from;
    try { from = String((await git(["rev-parse", "HEAD"], 15000)).stdout || "").trim(); } catch { return refuse(500, "no_checkout"); }
    if (!SHA.test(from)) return refuse(500, "no_checkout");
    if (from === target) return refuse(409, "already_current");
    try { await git(["fetch", "origin", "main"], 300000); } catch { return refuse(502, "fetch_failed"); }
    if (!(await succeeds(() => git(["cat-file", "-e", `${target}^{commit}`], 15000)))) return refuse(409, "unknown_sha");
    if (!(await succeeds(() => git(["merge-base", "--is-ancestor", target, "origin/main"], 15000)))) return refuse(409, "not_on_main");
    if (!(await succeeds(() => git(["merge-base", "--is-ancestor", from, target], 15000)))) return refuse(409, "not_fast_forward");
    const ci = classifyCheckRuns(await checkRuns(target));
    if (ci !== "green") return refuse(409, "ci_not_green", { ci });
    let lockChanged;
    try {
      lockChanged = String((await git(["diff", "--name-only", from, target, "--", "package-lock.json"], 15000)).stdout || "").trim() !== "";
    } catch { return refuse(500, "diff_failed"); }
    return { ok: true, from, to: target, lockChanged };
  }

  async function backupDb(from) {
    const dir = backupDir(satHome);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `pre-update-${from.slice(0, 12)}.db`);
    rmSync(path, { force: true });
    await db.backup(path);
    chmodSync(path, 0o600);
    const old = readdirSync(dir).filter((f) => /^pre-update-[0-9a-f]{12}\.db$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(BACKUPS_KEPT);
    for (const { f } of old) rmSync(join(dir, f), { force: true });
    return path;
  }

  async function apply({ from, to, lockChanged }) {
    const steps = [];
    const note = (m) => { steps.push(m); log(`satellite update: ${m}`); };
    let backup;
    try { backup = await backupDb(from); } catch (err) {
      writeLast({ from, to, result: "failed", steps: [`backup failed: ${err?.message || err}`] });
      return refuse(500, "backup_failed");
    }
    note(`satellite.db backed up`);
    let npmRan = false;
    let migrating = false;
    try {
      await git(["merge", "--ff-only", to], 120000);
      note(`fast-forwarded ${from.slice(0, 12)} → ${to.slice(0, 12)}`);
      if (lockChanged) {
        npmRan = true;
        // npm ci under 600 MB on a small box: the MCP children are paused (stopped, and no new
        // one starts) until the update restarts or rolls back (§10).
        try { await beforeInstall(); } catch { /* best effort */ }
        const [cmd, args] = npmCiCommand();
        await runner(cmd, args, { cwd: appRoot, timeout: 1800000 });
        note("dependencies installed (npm ci --omit=dev)");
      }
      await nodeCli("self-check");
      note("self-check passed");
      migrating = true;
      await nodeCli("migrate");
      note("satellite.db migrated");
    } catch (err) {
      note(`failed: ${String(err?.stderr || err?.message || err).trim().slice(0, 300)}`);
      let rolled = true;
      try {
        await git(["reset", "--hard", from], 120000);
        note(`rolled back to ${from.slice(0, 12)}`);
        if (npmRan) {
          const [cmd, args] = npmCiCommand();
          await runner(cmd, args, { cwd: appRoot, timeout: 1800000 });
          note("previous dependencies re-installed");
        }
      } catch (e) {
        rolled = false;
        note(`rollback failed: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`);
      }
      if (migrating) {
        // The migration may have moved satellite.db past what the old code knows: the next boot
        // restores the backup before opening it.
        writeFileSync(join(satHome, DB_RESTORE_MARKER), JSON.stringify({ backup, from, to }), { mode: 0o600 });
      }
      writeLast({ from, to, result: rolled ? "rolled_back" : "rollback_failed", steps });
      if (migrating) await exit(UPDATE_RESTART_EXIT_CODE);
      else { try { await afterRollback(); } catch { /* best effort */ } } // no restart: un-pause the MCP children
      return refuse(500, rolled ? "rolled_back" : "rollback_failed", { steps });
    }
    writeLast({ from, to, result: "restarting", steps });
    note("restarting");
    await exit(UPDATE_RESTART_EXIT_CODE);
    return { ok: true, from, to, steps };
  }

  /** check + apply, awaited (the whole update). */
  async function update(target) {
    if (busy) return refuse(409, "update_running");
    busy = true;
    try {
      const c = await check(target);
      return c.ok ? await apply(c) : c;
    } finally {
      busy = false;
    }
  }

  /** check now; apply after the caller has answered (the route's 202). */
  async function start(target) {
    if (busy) return refuse(409, "update_running");
    busy = true;
    let c;
    try { c = await check(target); } catch (err) { busy = false; throw err; }
    if (!c.ok) { busy = false; return c; }
    setImmediate(() => {
      apply(c).catch((err) => log(`satellite update: ${err?.message || err}`)).finally(() => { busy = false; });
    });
    return { ok: true, from: c.from, to: c.to, npm: c.lockChanged };
  }

  return { check, apply, update, start };
}

/** POST /satellite/v1/update {target_sha} on the signed router: owners only (crow's management). */
export function registerUpdateRoute(router, { updater, sendSigned }) {
  router.post("/update", async (req, res, next) => {
    if (!String(req.satCaller || "").startsWith("owner-")) return sendSigned(res, 403, { error: "owner_only" });
    try {
      const r = await updater.start(req.satBody?.target_sha);
      if (!r.ok) {
        const { ok: _ok, status, code, ...extra } = r;
        return sendSigned(res, status, { error: code, ...extra });
      }
      return sendSigned(res, 202, r);
    } catch (err) {
      return next(err);
    }
  });
}
