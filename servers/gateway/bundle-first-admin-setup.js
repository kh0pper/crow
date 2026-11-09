/**
 * Crow creates an app's first admin itself (security audit N3-4, phase 2a).
 *
 * Some apps can be given their admin account from a script once they are running:
 * Frigate mints a login through its own API, other apps have a one-shot CLI. Those
 * bundles declare
 *
 *   "firstAdmin": { "mode": "crow", "via": "setup",
 *                   "setup": { "script": "scripts/first-admin.sh", "timeout_s": 180 },
 *                   "user": "admin", "secretEnv": "FRIGATE_PASSWORD",
 *                   "userEnv": "FRIGATE_USER" }
 *
 * and the installer runs that script AFTER `compose up` succeeded, once per install.
 * The script protocol (docs/developers/bundles.md):
 *
 *   bash <installed bundle>/<setup.script>, cwd = the bundle dir, in its own process
 *   group, minimal env (hookEnv) + CROW_FIRST_ADMIN_USER=<user>. The PASSWORD goes on
 *   stdin only, as ONE line terminated by a newline — never in env, argv or a log.
 *
 *   exit 0   the app's admin <user> now has exactly that password
 *   exit 3   the app already has its own admin (set up earlier by the operator)
 *   exit 4   the app is not running / not answering; nothing changed
 *   other    failed (a timeout counts as failed)
 *
 * On exit 0 the password goes into Crow's keychain (origin "generated", one first-view
 * grant so the operator can read it once), and into the bundle's .env under `secretEnv`
 * (and `user` under `userEnv`) when those are declared env_vars — some bundles' own MCP
 * servers log in with the value from .env. A keychain save that fails AFTER the app's
 * password changed still parks the password in .env, under `secretEnv` even when the
 * manifest does not declare it: the new login must never exist nowhere.
 *
 * The outcome is remembered per install (`first_admin_auto:<id>`), which is what lets
 * the Extensions card go away on its own and what keeps the bell silent — see
 * bundle-first-admin.js. Every seam (script runner, db, keychain, .env writer, clock)
 * is injectable so tests need no keychain and no containers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeRelPath, spawnGroup, hookEnv, tailLines } from "./bundle-lifecycle.js";
import { newSecretValue, writePrivateFile } from "./bundle-env-secrets.js";
import { updateEnvText } from "./bundle-env-codec.js";
import { createDbClient } from "../db.js";
import { ensureWriteKey, ensureKeychainTable, saveExtensionSecret } from "./keychain/store.js";
import { writeFirstAdminAutoResult } from "./bundle-first-admin.js";
import { firstAdminSavedKey } from "./dashboard/shared/first-admin.js";

export const FIRST_ADMIN_SETUP_MAX_TIMEOUT_S = 600;
export const FIRST_ADMIN_SETUP_DEFAULT_TIMEOUT_S = 180;

/** The sentence both the install log and the card's route use for a keychain that will not open. */
export const KEYCHAIN_UNOPENABLE = "Crow's keychain could not be opened, so it did not change the app's login";

/**
 * The setup script a manifest declares, normalized — or null when this bundle's admin is
 * not created by a script, `{ refused }` when the declaration cannot be run:
 *   - a community bundle (its script would be host shell code from a third party),
 *   - a script that is not a relative `.sh` path inside the bundle,
 *   - a `user` / `secretEnv` the protocol cannot work without.
 *
 * @param {object|null} manifest
 * @returns {{script: string, timeoutMs: number, user: string, secretEnv: string, userEnv: string|null}|{refused: string}|null}
 */
export function firstAdminSetupPlan(manifest) {
  const fa = manifest && typeof manifest === "object" ? manifest.firstAdmin : null;
  if (!fa || typeof fa !== "object" || fa.mode !== "crow" || fa.via !== "setup") return null;
  if (manifest.origin === "community") {
    return { refused: "setup scripts run host shell code and are honored for first-party bundles only" };
  }
  const setup = fa.setup && typeof fa.setup === "object" ? fa.setup : null;
  const script = safeRelPath(setup ? setup.script : undefined);
  if (!script || !script.endsWith(".sh")) {
    return { refused: `firstAdmin.setup.script must be a relative .sh path inside the bundle` };
  }
  const user = typeof fa.user === "string" ? fa.user.trim() : "";
  if (!user) return { refused: "firstAdmin.user is missing: the setup script needs the admin username to create" };
  const secretEnv = typeof fa.secretEnv === "string" ? fa.secretEnv.trim() : "";
  if (!secretEnv) return { refused: "firstAdmin.secretEnv is missing: the keychain has nowhere to keep the admin password" };
  const t = setup && Number.isInteger(setup.timeout_s) ? setup.timeout_s : FIRST_ADMIN_SETUP_DEFAULT_TIMEOUT_S;
  const userEnv = typeof fa.userEnv === "string" && fa.userEnv.trim() ? fa.userEnv.trim() : null;
  return {
    script,
    timeoutMs: Math.min(Math.max(t, 1), FIRST_ADMIN_SETUP_MAX_TIMEOUT_S) * 1000,
    user,
    secretEnv,
    userEnv,
  };
}

/** `name — admin login`: the keychain label, as every other generated entry is labelled. */
export const firstAdminLabel = (name) => `${name} — admin login`;

/**
 * The one plain sentence a result is reported with — the install log's line and the
 * card's route answer (`message`). No password, ever: the operator reads it in Settings.
 *
 * @param {{result: string, name?: string, user?: string|null, reason?: string|null}} o
 */
export function firstAdminResultMessage({ result, name = null, user = null, reason = null } = {}) {
  const app = name || "the app";
  if (result === "ok") {
    return user
      ? `Crow created ${app}'s admin login (${user}) and saved it in Settings → Passwords.`
      : `Crow created ${app}'s admin login and saved it in Settings → Passwords.`;
  }
  if (result === "kept") {
    return `${app} already has its own admin; Crow left it alone. Save the login you use on the Extensions card.`;
  }
  const why = reason && String(reason).trim() ? String(reason).trim() : "the setup script did not finish";
  return `Crow could not set up ${app}'s admin login: ${why}. Use 'Set it up for me' on the Extensions card.`;
}

/** The tail of a script's stderr, minus spawnGroup's own "exit N" / "timed out" line. */
function scriptFailureReason(err) {
  const lines = String(err?.stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^exit\s/i.test(l) && !/^timed out after\s/i.test(l));
  if (lines.length) return lines.slice(-3).join(" | ");
  if (err?.exitCode !== undefined && err.exitCode !== null) return `the setup script exited with code ${err.exitCode}`;
  return err && err.message ? String(err.message) : "the setup script failed";
}

/** Write one key/value set into the bundle's own .env: mode 600, line-preserving, atomic. */
export function writeBundleEnv(destDir, values) {
  const path = join(destDir, ".env");
  let text = "";
  try {
    if (existsSync(path)) text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  writePrivateFile(path, updateEnvText(text, values));
}

function defaultDeps() {
  return {
    runScript: spawnGroup,
    openDb: () => createDbClient(),
    // Metadata only: an active extension entry for this bundle + key, whatever key sealed it.
    hasSaved: async (db, bundleId, envKey) => {
      await ensureKeychainTable(db);
      const { rows } = await db.execute({
        sql: "SELECT 1 FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ? AND status = 'active' LIMIT 1",
        args: [bundleId, envKey],
      });
      return (rows || []).length > 0;
    },
    ensureWriteKey: (db, { crowHome } = {}) => ensureWriteKey(db, { crowHome: crowHome || undefined }),
    newSecret: () => newSecretValue("secret"),
    save: saveExtensionSecret,
    writeEnv: writeBundleEnv,
    writeMarker: writeFirstAdminAutoResult,
    now: () => Date.now(),
    warn: (m) => console.warn(m),
  };
}

/**
 * Run this bundle's first-admin setup script once, and keep the new login.
 *
 * NEVER throws and NEVER logs the password. Returns
 * `{ result: "ok"|"kept"|"not-running"|"failed"|"skipped", reason?, log }` where `log` is
 * the last 20 non-empty lines of the script's stdout (the installer appends them to its
 * job log; the route hands them to the card).
 *
 * @param {object} o
 * @param {string} o.bundleId
 * @param {object} o.manifest             the INSTALLED manifest
 * @param {string} o.destDir              the installed bundle dir (the script's cwd)
 * @param {string|null} [o.installId]     installed.json's installedAt for this install
 * @param {string|null} [o.crowHome]
 * @param {object} [o.deps]               seams: runScript, openDb, hasSaved, ensureWriteKey,
 *                                        newSecret, save, writeEnv, writeMarker, now, warn
 */
export async function runFirstAdminSetup({
  bundleId,
  manifest,
  destDir = null,
  installId = null,
  crowHome = process.env.CROW_HOME || null,
  deps = {},
} = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const plan = firstAdminSetupPlan(manifest);
  if (!plan) return { result: "skipped", reason: "this app's admin login is not created by a setup script", log: [] };
  if (plan.refused) return { result: "failed", reason: plan.refused, log: [] };

  const dir = typeof destDir === "string" && destDir ? destDir : null;
  const abs = dir ? join(dir, plan.script) : null;
  if (!abs || !existsSync(abs)) {
    return { result: "failed", reason: `the setup script ${plan.script} is missing from the bundle`, log: [] };
  }

  const name = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId || "the app";
  const declaredEnv = new Set(
    (Array.isArray(manifest?.env_vars) ? manifest.env_vars : []).map((v) => (v && typeof v.name === "string" ? v.name : null)).filter(Boolean),
  );
  const log = [];
  let db = null;
  const record = async (result, reason = null) => {
    try {
      if (db) await d.writeMarker(db, bundleId, { install: installId, result });
    } catch { /* the marker is bookkeeping: never the outcome's own failure */ }
    return { result, ...(reason ? { reason } : {}), log };
  };

  try {
    try {
      db = await d.openDb();
    } catch {
      return { result: "failed", reason: KEYCHAIN_UNOPENABLE, log };
    }

    // A login the keychain already holds is NEVER replaced: the operator may have saved a
    // working one by hand, or an earlier run already made it. Nothing runs.
    let already = false;
    try {
      already = !!(await d.hasSaved(db, bundleId, plan.secretEnv));
    } catch {
      return await record("failed", KEYCHAIN_UNOPENABLE);
    }
    if (already) return await record("ok");

    // The keychain has to be writable BEFORE the app's login changes, or the new password
    // would exist nowhere — the app would be locked to a secret nobody holds.
    let key;
    try {
      key = await d.ensureWriteKey(db, { crowHome });
    } catch {
      return await record("failed", KEYCHAIN_UNOPENABLE);
    }

    const password = d.newSecret();
    let stdout = "";
    try {
      const out = await d.runScript("bash", [abs], {
        cwd: dir,
        env: { ...hookEnv(dir, crowHome || ""), CROW_FIRST_ADMIN_USER: plan.user },
        timeout: plan.timeoutMs,
        input: `${password}\n`,
      });
      stdout = String((out && out.stdout) || "");
    } catch (err) {
      log.push(...tailLines(err && err.stdout, 20));
      if (err && err.timedOut) {
        return await record("failed", `the setup script timed out after ${Math.round(plan.timeoutMs / 1000)}s`);
      }
      if (err && err.exitCode === 3) return await record("kept");
      if (err && err.exitCode === 4) return await record("not-running");
      return await record("failed", scriptFailureReason(err));
    }
    log.push(...tailLines(stdout, 20));

    let saved = true;
    try {
      await d.save(db, key, {
        bundleId,
        envKey: plan.secretEnv,
        label: firstAdminLabel(name),
        username: plan.user,
        url: null,
        secret: password,
        origin: "generated",
        firstView: true,
        now: new Date(d.now()),
      });
    } catch {
      // Reported as a reason below, never as a lost login: the app's password has changed.
      saved = false;
    }

    const declaredValues = {};
    if (declaredEnv.has(plan.secretEnv)) declaredValues[plan.secretEnv] = password;
    if (plan.userEnv && declaredEnv.has(plan.userEnv)) declaredValues[plan.userEnv] = plan.user;

    if (saved) {
      if (Object.keys(declaredValues).length > 0) {
        try { d.writeEnv(dir, declaredValues); } catch { /* the keychain holds it: .env is a convenience */ }
      }
      return await record("ok");
    }

    // The keychain save failed AFTER the app's password changed. Some bundles' MCP servers
    // log in with the value from .env, so it goes there even when undeclared: the password
    // must never exist nowhere.
    try {
      d.writeEnv(dir, { ...declaredValues, [plan.secretEnv]: password });
      return await record("ok", "saved in the extension's settings file only");
    } catch {
      d.warn(`[bundles] ${bundleId}: the new admin login could not be saved to the keychain or the settings file`);
      return await record("ok", "the new password could not be saved");
    }
  } catch (err) {
    // Never throws into the install path, and never echoes anything secret.
    try { d.warn(`[bundles] ${bundleId}: first-admin setup stopped (${err && (err.code || err.name) ? err.code || err.name : "error"})`); } catch { /* console gone */ }
    return await record("failed", "Crow's own setup stopped unexpectedly");
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}

/**
 * The Extensions card's "Save the login you made": store the operator's own admin login
 * under this bundle's admin key, so Crow keeps it (and the card can go away). Never
 * throws; a false answer means the caller's fixed sentence.
 *
 * @returns {Promise<boolean>}
 */
export async function saveFirstAdminLogin({ bundleId, manifest, username = "", password, crowHome = process.env.CROW_HOME || null, deps = {} } = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const name = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId || "the app";
  const envKey = firstAdminSavedKey(manifest);
  let db = null;
  try {
    db = await d.openDb();
    const key = await d.ensureWriteKey(db, { crowHome });
    await d.save(db, key, {
      bundleId,
      envKey,
      label: firstAdminLabel(name),
      username: typeof username === "string" && username.trim() ? username.trim() : null,
      url: null,
      secret: password,
      origin: "typed",
      firstView: false,
      now: new Date(d.now()),
    });
    return true;
  } catch (err) {
    try { d.warn(`[bundles] ${bundleId}: the admin login was not saved (${err && (err.code || err.name) ? err.code || err.name : "error"})`); } catch { /* console gone */ }
    return false;
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}