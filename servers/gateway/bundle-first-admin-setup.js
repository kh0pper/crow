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
 *   bash <Crow's own copy of the bundle>/<setup.script>, cwd = the installed bundle dir,
 *   in its own process group, minimal env (hookEnv) + CROW_FIRST_ADMIN_USER=<user>. The
 *   PASSWORD goes on stdin only, as ONE line terminated by a newline — never in env,
 *   argv or a log.
 *
 *   exit 0   the app's admin <user> now has exactly that password
 *   exit 3   the app already has its own admin (set up earlier by the operator)
 *   exit 4   the app is not running / not answering; nothing changed
 *   exit 5   the app itself confirmed the new password, but logging in with it did not succeed
 *   other    failed (a timeout counts as failed)
 *
 * The manifest and the script come from Crow's OWN copy of the bundle (the reviewed
 * repo tree, `scriptDir`), never from ~/.crow/bundles/<id>: that folder can be mounted
 * into the bundle's own container, so nothing in it decides what Crow runs (the same
 * rule as startConsent in routes/bundles.js). The installed folder is only the working
 * directory, CROW_BUNDLE_DIR and where `.env` is written.
 *
 * On exit 0 the password goes into Crow's keychain (origin "generated", one first-view
 * grant so the operator can read it once), and into the bundle's .env under `secretEnv`
 * (and `user` under `userEnv`) when those are declared env_vars — some bundles' own MCP
 * servers log in with the value from .env. When the manifest also names `urlEnv` (a
 * declared, non-secret env_vars entry), the keychain row's address is that installed
 * .env value if it is an http(s) URL of at most 512 characters (firstAdminLoginUrl).
 * Exit 5 is saved the same way: the app accepted the password, so it must be kept; the run
 * reports `ok` with FIRST_ADMIN_UNPROVEN in its reason and its log, because Crow could not
 * log in with it to confirm.
 *
 * The same values also go into the bundle's mcp-addons.json entry (applyEnvToMcpAddons): an
 * MCP child is spawned with ITS entry's env and never reads the bundle's .env, so a bundle
 * whose own server logs in (calibre-server, kavita, navidrome) would otherwise start with a
 * username and no password and answer 401 to every call. mcp-addons.json is read when the child
 * is spawned, so a running one keeps the old env until the gateway restarts — but the run never
 * restarts the gateway itself: a restart here kills any install job that is running (review
 * round 3, finding 1). It reports `mcpEnvUpdated`, the card routes answer `needs_restart`, and
 * the Extensions card shows Configure's own "restart to apply" sentence. A keychain save
 * that fails AFTER the app's password changed still parks the password in .env, under
 * `secretEnv` even when the manifest does not declare it. When BOTH the keychain and the .env write fail, the run
 * reports `failed` and says the app's password has changed and must be reset in the app:
 * the login then exists only inside the app, so the card and the bell stay.
 *
 * NEITHER the returned log lines nor the reason ever carry the password: every
 * occurrence of it is replaced with `[hidden]` before the answer is built.
 *
 * The outcome is remembered per install (`first_admin_auto:<id>`), which is what lets
 * the Extensions card go away on its own and what keeps the bell silent — see
 * bundle-first-admin.js. Every seam (script runner, db, keychain, .env writer, clock)
 * is injectable so tests need no keychain and no containers.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { safeRelPath, spawnGroup, hookEnv, tailLines } from "./bundle-lifecycle.js";
import { newSecretValue, writeBundleEnv } from "./bundle-env-secrets.js";
import { parseEnvText } from "./bundle-env-codec.js";
import { createDbClient } from "../db.js";
import { ensureWriteKey, ensureKeychainTable, saveExtensionSecret } from "./keychain/store.js";
import { writeFirstAdminAutoResult } from "./bundle-first-admin.js";
import { firstAdminSavedKey } from "./dashboard/shared/first-admin.js";

export const FIRST_ADMIN_SETUP_MAX_TIMEOUT_S = 600;
export const FIRST_ADMIN_SETUP_DEFAULT_TIMEOUT_S = 180;

/** The sentence both the install log and the card's route use for a keychain that will not open. */
export const KEYCHAIN_UNOPENABLE = "Crow's keychain could not be opened, so it did not change the app's login";

/**
 * The answer when the REVIEWED manifest cannot be read (or asks for nothing): Crow will
 * not run a script an unreadable declaration points at, so the app is finished by hand.
 */
export const SETUP_UNAVAILABLE = "This app can't be set up automatically; finish it in the app.";

/** The reason BOTH copies of the new password failing leaves: the app holds it, Crow does not. */
export const PASSWORD_NOT_KEPT = "the app's admin password changed but Crow could not keep it; reset it in the app";

/**
 * Exit 5's sentence: the app took the password (Crow therefore KEEPS it, exactly like exit
 * 0), but logging in with it did not succeed, so Crow cannot claim the login works.
 */
export const FIRST_ADMIN_UNPROVEN = "Crow saved the new login, but could not log in with it to confirm";

/** Env names a manifest may hand Crow: shell-safe, and none of the reserved prefixes. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ["COMPOSE_", "DOCKER_", "CROW_"];

/** Why this declared env name cannot be used, or null when it can. */
function envNameRefusal(name, field) {
  if (!ENV_NAME_RE.test(name)) {
    return `firstAdmin.${field} "${name}" must be a plain uppercase env name (letters, digits and _)`;
  }
  const prefix = RESERVED_ENV_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `firstAdmin.${field} "${name}" must not start with ${prefix}: that prefix is reserved`;
  return null;
}

/**
 * One automatic first-admin run per bundle at a time — the install path and the
 * Extensions card share this set, so two scripts racing to create the same account
 * cannot both run. Returns false when a run for this id is already in flight.
 */
const FIRST_ADMIN_RUNNING = new Set();
export function tryBeginFirstAdminSetup(bundleId) {
  const id = String(bundleId || "");
  if (!id || FIRST_ADMIN_RUNNING.has(id)) return false;
  FIRST_ADMIN_RUNNING.add(id);
  return true;
}
export function endFirstAdminSetup(bundleId) {
  FIRST_ADMIN_RUNNING.delete(String(bundleId || ""));
}

/**
 * The setup script a manifest declares, normalized — or null when this bundle's admin is
 * not created by a script, `{ refused }` when the declaration cannot be run:
 *   - a community bundle (its script would be host shell code from a third party),
 *   - a script that is not a relative `.sh` path inside the bundle,
 *   - a `user` / `secretEnv` the protocol cannot work without.
 *
 * @param {object|null} manifest
 * @returns {{script: string, timeoutMs: number, user: string, secretEnv: string, userEnv: string|null, urlEnv: string|null}|{refused: string}|null}
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
  const secretProblem = envNameRefusal(secretEnv, "secretEnv");
  if (secretProblem) return { refused: secretProblem };
  const userEnv = typeof fa.userEnv === "string" && fa.userEnv.trim() ? fa.userEnv.trim() : null;
  if (userEnv) {
    const userProblem = envNameRefusal(userEnv, "userEnv");
    if (userProblem) return { refused: userProblem };
  }
  // Optional: the declared, non-secret env var whose installed value is the app's own
  // address. Saved with the login when it is an http(s) URL (see firstAdminLoginUrl).
  const urlEnv = typeof fa.urlEnv === "string" && fa.urlEnv.trim() ? fa.urlEnv.trim() : null;
  if (urlEnv) {
    const urlProblem = envNameRefusal(urlEnv, "urlEnv");
    if (urlProblem) return { refused: urlProblem };
  }
  const t = setup && Number.isInteger(setup.timeout_s) ? setup.timeout_s : FIRST_ADMIN_SETUP_DEFAULT_TIMEOUT_S;
  return {
    script,
    timeoutMs: Math.min(Math.max(t, 1), FIRST_ADMIN_SETUP_MAX_TIMEOUT_S) * 1000,
    user,
    secretEnv,
    userEnv,
    urlEnv,
  };
}

/** The longest address a saved login carries (a URL longer than this is not the app's). */
export const FIRST_ADMIN_URL_MAX_LENGTH = 512;

/**
 * The address saved beside a new login: the installed `.env` value of the manifest's
 * `firstAdmin.urlEnv`, but only when it really is an http(s) URL of at most
 * FIRST_ADMIN_URL_MAX_LENGTH characters. Anything else (unset, a path, another scheme, a
 * value a hand edit mangled) is null: the keychain row then has no address, exactly as
 * before this field existed.
 *
 * @param {() => object} readEnv  the installed bundle's parsed `.env`
 * @param {string|null} urlEnv    the env var the manifest named, or null
 * @returns {string|null}
 */
export function firstAdminLoginUrl(readEnv, urlEnv) {
  if (!urlEnv) return null;
  let env;
  try {
    env = readEnv();
  } catch {
    return null;
  }
  const value = env && typeof env === "object" ? env[urlEnv] : undefined;
  if (typeof value !== "string") return null;
  if (!value || value.length > FIRST_ADMIN_URL_MAX_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // The keychain's `url` column is plain metadata, not a secret: a credential embedded in
    // the env value (`http://user:pw@host`) must never be copied into it.
    if (parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return value;
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
    const saved = user
      ? `Crow created ${app}'s admin login (${user}) and saved it in Settings → Passwords.`
      : `Crow created ${app}'s admin login and saved it in Settings → Passwords.`;
    // An ok with a reason is a login Crow could keep but not confirm (exit 5), or one that
    // only reached the extension's settings file: the sentence says so, plainly.
    const extra = reason && String(reason).trim() ? String(reason).trim().replace(/[.!]?$/, ".") : "";
    return extra ? `${saved} ${extra}` : saved;
  }
  if (result === "kept") {
    return `${app} already has its own admin; Crow left it alone. Save the login you use on the Extensions card.`;
  }
  if (result === "busy") {
    return `Crow is already setting up ${app}'s admin login.`;
  }
  const why = reason && String(reason).trim() ? String(reason).trim() : "the setup script did not finish";
  // A retry cannot help once the app's password changed (the script would answer "kept").
  if (why === PASSWORD_NOT_KEPT) return `Crow could not set up ${app}'s admin login: ${why}, then save it on the Extensions card.`;
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

/** The line-preserving bundle .env writer, shared with the "after setup" step. */
export { writeBundleEnv } from "./bundle-env-secrets.js";

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
    // The installed .env, for the login's address (firstAdmin.urlEnv) only.
    readEnv: (dir) => parseEnvText(readFileSync(join(dir, ".env"), "utf8")),
    writeMarker: writeFirstAdminAutoResult,
    now: () => Date.now(),
    warn: (m) => console.warn(m),
    // The bundle's MCP entry (mcp-addons.json) is the routes module's. Imported lazily: that
    // module imports THIS one, and it resolves its paths from CROW_HOME when it is first loaded.
    applyMcpEnv: async (id, values, reviewed) => {
      const [{ applyEnvToMcpAddons }, { MCP_ADDONS_PATH }, { withAddonLock }] = await Promise.all([
        import("./routes/bundles.js"),
        import("./bundles-config.js"),
        import("./addon-secrets-seal.js"),
      ]);
      // The per-add-on lock (0.6.1 / 1.5b): a sealing writer never runs un-locked. It is
      // re-entrant per id, so the install path — which holds it while it registers the
      // entry — can call this seam for the same add-on without deadlocking.
      return withAddonLock(id, () => applyEnvToMcpAddons(id, values, MCP_ADDONS_PATH, reviewed));
    },
    // mcp-addons.json is read when an MCP child is spawned, so the entry a run just wrote is
    // only loaded by a restart. This run never starts one — a restart mid-install kills the job
    // that asked for it (review round 3, finding 1) — it reports, exactly like Configure's save:
    // the card route's `needs_restart` is what the operator sees.
    requestReload: async ({ bundleId: id } = {}) => {
      console.log(`[bundles] ${id || "bundle"}: the new admin login is in the extension's MCP settings; restart the gateway to load it`);
    },
  };
}

/**
 * The script Crow will run: inside `scriptDir` (Crow's own copy of the bundle) and
 * nowhere else — the real path is resolved first, so a symlink cannot point the run at
 * a file outside the reviewed tree.
 *
 * @returns {{ok: true, path: string}|{ok: false, reason: string}}
 */
function resolveReviewedScript(scriptDir, relScript) {
  const missing = { ok: false, reason: `the setup script ${relScript} is missing from the bundle` };
  if (typeof scriptDir !== "string" || !scriptDir) return missing;
  let root;
  try {
    root = realpathSync(scriptDir);
  } catch {
    return missing;
  }
  let real;
  try {
    real = realpathSync(join(scriptDir, relScript));
  } catch {
    return missing;
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (real !== root && !real.startsWith(prefix)) {
    return { ok: false, reason: `the setup script ${relScript} is outside Crow's own copy of the bundle` };
  }
  return { ok: true, path: real };
}

/**
 * Run this bundle's first-admin setup script once, and keep the new login.
 *
 * NEVER throws and NEVER returns or logs the password (every occurrence of it in the
 * log lines and the reason is replaced with `[hidden]`). Returns
 * `{ result: "ok"|"kept"|"not-running"|"failed"|"busy"|"skipped", reason?, log, mcpEnvUpdated? }`
 * where `log` is the last 20 non-empty lines of the script's stdout (the installer appends
 * them to its job log; the route hands them to the card) and `mcpEnvUpdated` says the
 * bundle's mcp-addons.json entry was written with the new login, so a gateway restart is needed
 * before its MCP child uses it (the card route answers `needs_restart`; nothing restarts here).
 * `"busy"` means another run for this bundle — the install path's or the card's — is
 * already in flight.
 *
 * @param {object} o
 * @param {string} o.bundleId
 * @param {object} o.manifest             the REVIEWED manifest (getManifest), never the installed one
 * @param {string} o.scriptDir            Crow's own copy of the bundle: the script is resolved from here
 * @param {string} o.destDir              the installed bundle dir (cwd, CROW_BUNDLE_DIR, .env)
 * @param {string|null} [o.installId]     installed.json's installedAt for this install
 * @param {string|null} [o.crowHome]
 * @param {object} [o.deps]               seams: runScript, openDb, hasSaved, ensureWriteKey,
 *                                        newSecret, save, writeEnv, writeMarker, now, warn,
 *                                        applyMcpEnv, requestReload
 */
export async function runFirstAdminSetup({
  bundleId,
  manifest,
  scriptDir = null,
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
  const script = resolveReviewedScript(scriptDir, plan.script);
  if (!dir || !script.ok) {
    return { result: "failed", reason: script.ok ? `the setup script ${plan.script} is missing from the bundle` : script.reason, log: [] };
  }
  const abs = script.path;

  if (!tryBeginFirstAdminSetup(bundleId)) return { result: "busy", log: [] };
  try {
    const name = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId || "the app";
    const declaredEnv = new Set(
      (Array.isArray(manifest?.env_vars) ? manifest.env_vars : []).map((v) => (v && typeof v.name === "string" ? v.name : null)).filter(Boolean),
    );
    const log = [];
    let db = null;
    // exit 5: the app took the password (so it is saved like exit 0), but the login it was
    // proved with did not work. The run still reports ok — with the sentence that says so.
    let unproven = false;
    // The password is only known after newSecret(); until then (and on every early
    // return) the redaction is a no-op.
    let password = null;
    const redact = (text) => {
      const s = String(text ?? "");
      if (!password) return s;
      return s.split(password).join("[hidden]");
    };
    const record = async (result, reason = null, extra = {}) => {
      try {
        if (db) await d.writeMarker(db, bundleId, { install: installId, result });
      } catch { /* the marker is bookkeeping: never the outcome's own failure */ }
      const why = reason ? redact(reason) : null;
      return { result, ...(why ? { reason: why } : {}), log: log.map(redact), ...extra };
    };

    // The bundle's own MCP server gets its env from ITS mcp-addons.json entry, never from the
    // bundle's .env (addon-env.js): without this it starts after setup with a username and no
    // password and answers 401 to every call. The entry is the one the operator's Configure
    // save writes, and the report below is the same one that save gives: it says a restart is
    // needed, it does not start one. True when the entry was written; a bundle that is not an
    // MCP add-on has none, and that is no error.
    const pushLoginToMcp = async (values) => {
      if (!values || Object.keys(values).length === 0) return false;
      let wrote = false;
      try {
        wrote = !!(await d.applyMcpEnv(bundleId, values, manifest));
      } catch {
        // mcp-addons.json is not this run's to fail over: the keychain already holds the
        // login, and the next Configure save writes the entry again.
        return false;
      }
      if (!wrote) return false;
      try {
        await d.requestReload({ bundleId });
      } catch { /* the values are saved; a report that fails is not the login's problem */ }
      return true;
    };

    try {
      try {
        db = await d.openDb();
      } catch {
        return { result: "failed", reason: KEYCHAIN_UNOPENABLE, log };
      }

      // A login the keychain already holds is NEVER replaced: the operator may have saved a
      // working one by hand, or an earlier run already made it. Nothing runs — and no
      // marker is written, so the keychain entry alone is what hides the card (deleting it
      // brings the card back, as it should).
      let already = false;
      try {
        already = !!(await d.hasSaved(db, bundleId, plan.secretEnv));
      } catch {
        return await record("failed", KEYCHAIN_UNOPENABLE);
      }
      if (already) return { result: "ok", log };

      // The keychain has to be writable BEFORE the app's login changes: a password the app
      // holds and nothing here does would lock the app.
      let key;
      try {
        key = await d.ensureWriteKey(db, { crowHome });
      } catch {
        return await record("failed", KEYCHAIN_UNOPENABLE);
      }

      password = d.newSecret();
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
        // 5 is NOT a refusal to fall back to "failed": the app already holds the new
        // password, so the run goes on to keep it and reports why it is unproven.
        if (err && err.exitCode === 5) unproven = true;
        else return await record("failed", scriptFailureReason(err));
      }
      log.push(...tailLines(stdout, 20));
      if (unproven) log.push(FIRST_ADMIN_UNPROVEN);

      let saved = true;
      try {
        await d.save(db, key, {
          bundleId,
          envKey: plan.secretEnv,
          label: firstAdminLabel(name),
          username: plan.user,
          url: firstAdminLoginUrl(() => d.readEnv(dir), plan.urlEnv),
          secret: password,
          origin: "generated",
          firstView: true,
          now: new Date(d.now()),
        });
      } catch {
        // Handled below: the app's password has changed, so the value goes into .env, or
        // the run says the login has to be reset in the app.
        saved = false;
      }

      const declaredValues = {};
      if (declaredEnv.has(plan.secretEnv)) declaredValues[plan.secretEnv] = password;
      if (plan.userEnv && declaredEnv.has(plan.userEnv)) declaredValues[plan.userEnv] = plan.user;

      if (saved) {
        if (Object.keys(declaredValues).length > 0) {
          try { d.writeEnv(dir, declaredValues); } catch { /* the keychain holds it: .env is a convenience */ }
        }
        const mcpEnvUpdated = await pushLoginToMcp(declaredValues);
        return await record("ok", unproven ? FIRST_ADMIN_UNPROVEN : null, mcpEnvUpdated ? { mcpEnvUpdated } : {});
      }

      // The keychain save failed AFTER the app's password changed. Some bundles' MCP servers
      // log in with the value from .env, so it goes there even when undeclared — and into the
      // bundle's MCP entry for the same reason.
      const fallbackValues = { ...declaredValues, [plan.secretEnv]: password };
      try {
        d.writeEnv(dir, fallbackValues);
        const mcpEnvUpdated = await pushLoginToMcp(fallbackValues);
        const reasons = [];
        if (unproven) reasons.push(FIRST_ADMIN_UNPROVEN);
        reasons.push("saved in the extension's settings file only");
        return await record("ok", reasons.join("; "), mcpEnvUpdated ? { mcpEnvUpdated } : {});
      } catch {
        // Both copies failed: the app now holds a password nobody here keeps. Say so
        // plainly instead of reporting a login Crow cannot show the operator.
        d.warn(`[bundles] ${bundleId}: the new admin login could not be saved to the keychain or the settings file`);
        return await record("failed", PASSWORD_NOT_KEPT);
      }
    } catch (err) {
      // Never throws into the install path, and never echoes anything secret.
      try { d.warn(`[bundles] ${bundleId}: first-admin setup stopped (${err && (err.code || err.name) ? err.code || err.name : "error"})`); } catch { /* console gone */ }
      return await record("failed", "Crow's own setup stopped unexpectedly");
    } finally {
      try { db?.close?.(); } catch { /* already closed */ }
    }
  } finally {
    endFirstAdminSetup(bundleId);
  }
}

/**
 * The Extensions card's "Save the login you made": store the operator's own admin login
 * under this bundle's admin key, so Crow keeps it (and the card can go away). Never
 * throws. A login Crow already keeps is left untouched: that one is changed in
 * Settings → Passwords, not from this form.
 *
 * Like a setup run, a saved login also reaches the bundle's MCP entry (applyEnvToMcpAddons),
 * and the answer says whether it did (`mcpEnvUpdated`): an MCP child reads ITS entry, never the
 * bundle's .env, so without that write the operator's login would leave Crow's own tools
 * answering 401 (review round 2, finding 1 — same gap as the automatic run). Nothing restarts
 * the gateway from here (review round 3, finding 1): the route hands `needs_restart` to the
 * card, which shows Configure's own sentence.
 *
 * @returns {Promise<{result: "saved"|"already"|"failed", mcpEnvUpdated: boolean}>}
 *          `"already"` = an active entry exists for this bundle's admin key;
 *          `"failed"` = the caller's fixed sentence.
 */
export async function saveFirstAdminLogin({ bundleId, manifest, username = "", password, crowHome = process.env.CROW_HOME || null, deps = {} } = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const name = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId || "the app";
  const envKey = firstAdminSavedKey(manifest);
  let db = null;
  try {
    db = await d.openDb();
    if (await d.hasSaved(db, bundleId, envKey)) return { result: "already", mcpEnvUpdated: false };
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
    // What the run would have written: the declared names only, never a key the manifest
    // does not declare. A failed mcp-addons write is not the save's failure — the keychain
    // holds the login, and the next Configure save writes the entry again.
    const declaredEnv = new Set(
      (Array.isArray(manifest?.env_vars) ? manifest.env_vars : []).map((v) => (v && typeof v.name === "string" ? v.name : null)).filter(Boolean),
    );
    const values = {};
    const plan = firstAdminSetupPlan(manifest);
    const secretKey = plan && !plan.refused ? plan.secretEnv : envKey;
    if (secretKey && declaredEnv.has(secretKey)) values[secretKey] = password;
    const user = typeof username === "string" ? username.trim() : "";
    if (plan && !plan.refused && plan.userEnv && user && declaredEnv.has(plan.userEnv)) values[plan.userEnv] = user;
    let mcpEnvUpdated = false;
    if (Object.keys(values).length > 0) {
      try { mcpEnvUpdated = !!(await d.applyMcpEnv(bundleId, values, manifest)); } catch { mcpEnvUpdated = false; }
      if (mcpEnvUpdated) { try { await d.requestReload({ bundleId }); } catch { /* the values are saved */ } }
    }
    return { result: "saved", mcpEnvUpdated };
  } catch (err) {
    try { d.warn(`[bundles] ${bundleId}: the admin login was not saved (${err && (err.code || err.name) ? err.code || err.name : "error"})`); } catch { /* console gone */ }
    return { result: "failed", mcpEnvUpdated: false };
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}