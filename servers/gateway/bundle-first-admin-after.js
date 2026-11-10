/**
 * `firstAdmin.setup.after` — what Crow does right after it created an app's admin account
 * (security audit N3-4, operator ruling "Crow creates, then closes").
 *
 * Some apps can be given their admin from a script, but keep the door open afterwards: an
 * app whose own registration page accepts anyone still does, even with Crow's account in
 * place. Those bundles declare the follow-up step beside the setup script:
 *
 *   "firstAdmin": { "mode": "crow", "via": "setup",
 *                   "setup": { "script": "scripts/first-admin.sh", "timeout_s": 180,
 *                              "after": { "env": { "APP_ENABLE_REGISTRATION": "false" },
 *                                         "recreate": true } },
 *                   "user": "admin", "secretEnv": "APP_ADMIN_PASSWORD" }
 *
 * The step runs ONLY when the setup script reported ok (exit 0 or 5: the app holds the
 * password either way):
 *
 *   1. `after.env` is written into the installed bundle's `.env` with the same
 *      line-preserving, mode-600 writer every install-time step uses, then
 *   2. `after.recreate: true` recreates the bundle's containers ONCE, through the caller's
 *      guarded recreate (routes/bundles.js `recreateBundleGuarded`: the same consent +
 *      compose safety check + ownership check a Start runs).
 *
 * A failure here NEVER undoes the account: the password is already in Crow's keychain and
 * the app still holds it. The answer says the change may not have taken effect (a new
 * `.env` value only reaches a container that is re-created), so the operator is told to
 * press Restart.
 *
 * Everything the step touches is a seam (`writeEnv`, `recreate`), so tests need neither a
 * bundle directory nor a container. The rules for the declaration itself live here and are
 * used by the manifest contract (scripts/lib/bundle-contract.mjs), so a manifest cannot say
 * something the runtime would not do.
 */
import { writeBundleEnv } from "./bundle-env-secrets.js";
import { envValueProblem } from "./bundle-env-codec.js";

/** The longest value a manifest may hand an app through `after.env`. */
export const FIRST_ADMIN_AFTER_MAX_VALUE = 200;

/** The keys `after` may carry. Anything else is refused rather than silently ignored. */
const AFTER_KEYS = new Set(["env", "recreate"]);

/** A name compose can read back as this exact variable (no lowercase, no dots, no dashes). */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Prefixes that change how compose (or docker) itself runs, not how the app does. */
const RESERVED_ENV_PREFIXES = ["COMPOSE_", "DOCKER_"];

/** The setup block a manifest declares, or null. */
function setupOf(manifest) {
  const fa = manifest && typeof manifest === "object" ? manifest.firstAdmin : null;
  const setup = fa && fa.setup && typeof fa.setup === "object" ? fa.setup : null;
  return setup || null;
}

/**
 * Why this manifest's `firstAdmin.setup.after` cannot be used — [] when it can (or when
 * there is none). The rules: only `env` and `recreate`; every `env` key is a valid env name
 * (`A-Z`, digits, `_`), is not Compose's or Docker's own (`COMPOSE_`/`DOCKER_`), is not one of
 * the two names Crow writes itself (`firstAdmin.secretEnv`/`userEnv`), and names an env_vars
 * entry the bundle DECLARES that Crow does not keep secret or generate (Crow never writes a
 * variable the app's own manifest did not declare, and never a plaintext value over a
 * generated one); `env` values are plain strings of at most 200 characters that the .env
 * codec can write; `recreate` is a boolean; and the block has to do something.
 *
 * @param {object|null} manifest a REVIEWED manifest
 * @returns {string[]} plain sentences, empty when the declaration is usable
 */
export function firstAdminAfterProblems(manifest) {
  const setup = setupOf(manifest);
  const after = setup ? setup.after : undefined;
  if (after === undefined) return [];
  if (!after || typeof after !== "object" || Array.isArray(after)) {
    return ["firstAdmin.setup.after must be an object with env and/or recreate"];
  }
  const errors = [];
  const unknown = Object.keys(after).filter((k) => !AFTER_KEYS.has(k));
  if (unknown.length > 0) {
    errors.push(`firstAdmin.setup.after may only carry env and recreate (got ${unknown.join(", ")})`);
  }
  if (after.recreate !== undefined && typeof after.recreate !== "boolean") {
    errors.push("firstAdmin.setup.after.recreate must be a boolean");
  }
  let envKeys = [];
  if (after.env !== undefined) {
    if (!after.env || typeof after.env !== "object" || Array.isArray(after.env)) {
      errors.push("firstAdmin.setup.after.env must be an object of KEY: value pairs");
    } else {
      envKeys = Object.keys(after.env);
      const declared = new Map();
      for (const v of Array.isArray(manifest.env_vars) ? manifest.env_vars : []) {
        if (v && typeof v.name === "string" && !declared.has(v.name)) declared.set(v.name, v);
      }
      // The two values the setup run writes itself: a plaintext step must not race it.
      const fa = manifest.firstAdmin && typeof manifest.firstAdmin === "object" ? manifest.firstAdmin : null;
      const owned = new Set([fa?.secretEnv, fa?.userEnv].filter((n) => typeof n === "string" && n !== ""));
      for (const key of envKeys) {
        const value = after.env[key];
        const entry = declared.get(key);
        if (!ENV_NAME.test(key)) {
          errors.push(`firstAdmin.setup.after.env ${key} must be an env name: capitals, digits and underscores, starting with a letter`);
        } else if (RESERVED_ENV_PREFIXES.some((p) => key.startsWith(p))) {
          errors.push(`firstAdmin.setup.after.env ${key} must not start with COMPOSE_ or DOCKER_ — those change how compose itself runs`);
        } else if (owned.has(key)) {
          errors.push(`firstAdmin.setup.after.env ${key} is one of the two values Crow writes itself (firstAdmin.secretEnv/firstAdmin.userEnv), so it cannot be set here`);
        } else if (!entry) {
          errors.push(`firstAdmin.setup.after.env ${key} must name a declared env_vars entry`);
        } else if (typeof value !== "string") {
          errors.push(`firstAdmin.setup.after.env ${key} must be a plain string`);
        } else if (entry.secret === true || entry.generate !== undefined || entry.keychain === true) {
          errors.push(`firstAdmin.setup.after.env ${key} names an env_vars entry Crow keeps secret or generates, so it cannot be given a value here`);
        } else if (value.length > FIRST_ADMIN_AFTER_MAX_VALUE) {
          errors.push(`firstAdmin.setup.after.env ${key} must be at most ${FIRST_ADMIN_AFTER_MAX_VALUE} characters`);
        } else {
          const problem = envValueProblem(value);
          if (problem) errors.push(`firstAdmin.setup.after.env ${key} ${problem}`);
        }
      }
    }
  }
  // A block that writes nothing and recreates nothing is a declaration that does nothing:
  // the manifest author meant something else.
  if (errors.length === 0 && envKeys.length === 0 && after.recreate !== true) {
    errors.push("firstAdmin.setup.after does nothing: give it env values, recreate: true, or remove it");
  }
  return errors;
}

/**
 * The normalized after-step — `{ env, recreate }` — or null when the manifest declares none
 * (or declares one the contract refuses: nothing then runs, which is the safe direction).
 *
 * @param {object|null} manifest
 * @returns {{env: Record<string, string>, recreate: boolean}|null}
 */
export function firstAdminAfterPlan(manifest) {
  if (firstAdminAfterProblems(manifest).length > 0) return null;
  const setup = setupOf(manifest);
  const after = setup ? setup.after : undefined;
  if (!after) return null;
  return { env: { ...(after.env || {}) }, recreate: after.recreate === true };
}

/** One line, no quotes, no newlines, nothing long: the answer is a log line, not a dump. */
function plainReason(value, fallback) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.replace(/"/g, "'").slice(0, FIRST_ADMIN_AFTER_MAX_VALUE);
}

/** `after: "applied"` / `after: "<what failed>: <plain reason>"` — the one line callers log. */
const afterLine = (outcome) => `after: "${outcome}"`;
/**
 * The sentence appended to the card's answer when the after-step did not finish. The
 * account is fine (Crow saved the password); what may not have taken effect is the change,
 * because a container keeps its old environment until it is re-created.
 */
export function firstAdminAfterFailureSentence(name) {
  const app = name || "the app";
  return `Crow could not apply the follow-up change to ${app}, so registration may still be open: press Restart on the Extensions card.`;
}

/**
 * Run this bundle's declared after-step. Never throws.
 *
 * @param {object} o
 * @param {string} o.bundleId
 * @param {object|null} o.manifest      the REVIEWED manifest (getManifest), never the installed one
 * @param {string|null} o.destDir       the installed bundle dir (where `.env` lives)
 * @param {Function} [o.writeEnv]       seam: (destDir, values) => void
 * @param {Function|null} [o.recreate]  seam: (bundleId) => Promise<{ok: boolean, reason?: string}>
 * @returns {Promise<{ok: boolean, applied: boolean, outcome: string|null, line: string|null, reason: string|null}>}
 *          `outcome` is what the line carries (`applied`, `recreate-failed: …`), and both are
 *          null when the manifest declares no after-step at all.
 */
export async function applyFirstAdminAfter({
  bundleId,
  manifest = null,
  destDir = null,
  writeEnv = writeBundleEnv,
  recreate = null,
} = {}) {
  const plan = firstAdminAfterPlan(manifest);
  if (!plan) return { ok: true, applied: false, outcome: null, line: null, reason: null };
  // Two failure words, because they need different words: the settings file did not take the
  // value at all (`env-failed`), or it did and only a re-create can make the app read it
  // (`recreate-failed`).
  const fail = (kind, reason) => {
    const outcome = `${kind}: ${reason}`;
    return { ok: false, applied: false, outcome, line: afterLine(outcome), reason };
  };
  if (typeof destDir !== "string" || destDir === "") {
    return fail("env-failed", "no installed folder to write the change into");
  }
  const values = Object.keys(plan.env);
  if (values.length > 0) {
    try {
      writeEnv(destDir, plan.env);
    } catch (err) {
      return fail("env-failed", plainReason(err && (err.code || err.message), "the settings file could not be written"));
    }
  }
  if (!plan.recreate) return { ok: true, applied: true, outcome: "applied", line: afterLine("applied"), reason: null };
  if (typeof recreate !== "function") {
    // The env change is on disk; only a re-create can make the app read it.
    return fail("recreate-failed", "Crow cannot restart a bundle from here");
  }
  let out;
  try {
    out = await recreate(bundleId);
  } catch (err) {
    return fail("recreate-failed", plainReason(err && (err.stderr || err.message), "the bundle could not be restarted"));
  }
  if (!out || out.ok !== true) {
    return fail("recreate-failed", plainReason(out && out.reason, "the bundle could not be restarted"));
  }
  return { ok: true, applied: true, outcome: "applied", line: afterLine("applied"), reason: null };
}