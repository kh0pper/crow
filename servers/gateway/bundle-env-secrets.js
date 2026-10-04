/**
 * Installer-generated bundle secrets + bundle .env hygiene (config-friction stage 1, F1).
 *
 *   env_vars[].generate: "secret"   → 32 random bytes, base64url (43 chars; no `$`,
 *                                     quotes or spaces: safe in compose .env, URLs, bash)
 *   env_vars[].generate: "laravel_key" → `base64:` + 32 random bytes, base64 (Laravel
 *                                     APP_KEY: Pixelfed refuses any other shape)
 *   env_vars[].generate: "vapid_private_key" / "vapid_public_key" (+ `pair: <private
 *                                     key's name>` on the public one) → a P-256 Web Push
 *                                     keypair, urlsafe base64 exactly as Mastodon's
 *                                     `rake mastodon:webpush:generate_vapid_key` prints it
 *   env_vars[].propagate: true       → a generated key that gateway-side code reads from
 *                                     process.env (phone's runner secret, coturn's TURN
 *                                     secret, MinIO root): ALSO written to the gateway .env
 *
 *   env_vars[].keychain: true        → the minted plaintext goes to the Crow keychain BEFORE
 *                                     anything is persisted (planGeneratedEnv → persist())
 *   env_vars[].store_as: "argon2id"  → the .env and the retained copy hold an Argon2id PHC
 *                                     hash of it instead (Vaultwarden ADMIN_TOKEN)
 *   env_vars[].generatable: true     → a HUMAN password field: the forms offer Generate and
 *                                     "Save to Crow keychain" (keychainEligibleKeys)
 *
 * NEVER regenerated on reinstall: bundles bind-mount their data and the kept DB still
 * expects the old password. Order: installed .env → retained copy at
 * <CROW_HOME>/secrets/bundle-env/<id>.env (dir 700, file 600; uninstall never deletes
 * it) → new value. Generated keys are hidden from the forms (html.js), ignored in
 * requests (stripGeneratedKeys), never install-blocking, never sent to the gateway .env.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes, createHash, createECDH } from "node:crypto";
import { parseEnvText, formatEnvLines } from "./bundle-env-codec.js";
export { parseEnvText };
import { argon2idPhc } from "./keychain/argon2-phc.js";

const GENERATE_KINDS = new Set(["secret", "laravel_key", "vapid_private_key", "vapid_public_key"]);
export const GENERATE_KIND_NAMES = Object.freeze([...GENERATE_KINDS]);

/** Ruby's Base64.urlsafe_encode64 (padded) — the form the webpush gem reads and prints. */
const urlsafePadded = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

/** A fresh P-256 keypair, both halves in the webpush gem's encoding. */
export function newVapidKeypair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: urlsafePadded(ecdh.getPrivateKey()), publicKey: urlsafePadded(ecdh.getPublicKey()) };
}

/** The uncompressed public key for an encoded private key, or null if it is not one. */
export function vapidPublicFromPrivate(privateKey) {
  try {
    const raw = Buffer.from(String(privateKey).replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (raw.length === 0 || raw.length > 32) return null;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(32 - raw.length), raw]));
    return urlsafePadded(ecdh.getPublicKey());
  } catch {
    return null;
  }
}


function readEnvSafe(path) {
  try { return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {}; } catch { return {}; }
}

export function generatedEnvKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate))
    .map((v) => v.name);
}

export function newSecretValue(kind = "secret") {
  if (kind === "laravel_key") return `base64:${randomBytes(32).toString("base64")}`;
  return randomBytes(32).toString("base64url");
}

/**
 * `${KEY:-fallback}` defaults in a compose file, KEY → fallback (non-blank only). An
 * install made before a key was generated ran on this fallback when its .env left the
 * key blank — that is the password its kept database still expects.
 */
export function composeFallbacks(composeText) {
  const out = {};
  // `:-` only: a bare `${X-y}` applies y when X is UNSET, and Crow's .env always sets it.
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g;
  let m;
  const text = String(composeText || "");
  while ((m = re.exec(text)) !== null) {
    if (m.index > 0 && text[m.index - 1] === "$") continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (v && !v.includes("$") && !(m[1] in out)) out[m[1]] = v;
  }
  return out;
}

/**
 * Write a secret-bearing file: a fresh 600 temp file in the same dir, then an atomic
 * rename — the content is never readable at a wider mode, not even briefly.
 */
export function writePrivateFile(path, content) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function retainedEnvPath(crowHome, bundleId) {
  return join(crowHome, "secrets", "bundle-env", `${bundleId}.env`);
}

export function keychainGeneratedKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate) && v.keychain === true)
    .map((v) => v.name);
}

/** Typed fields the forms may offer to save to the keychain: opt-in only (Kevin Q1). */
export function keychainEligibleKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && v.secret === true && !v.generate && (v.generatable === true || v.keychain === true))
    .map((v) => v.name);
}

/**
 * Mint or reuse every generated secret WITHOUT persisting anything (C5). Returns
 * { env, minted, persist }:
 *   env      values for the bundle .env (a PHC hash for store_as:"argon2id")
 *   minted   plaintext of keychain:true keys created by THIS call (empty on reinstall)
 *   persist  writes the retained copy; call it only after `minted` is safely in the
 *            keychain — otherwise a lost plaintext would leave an unusable hash behind.
 * Order per key: installed .env → retained copy → new value (never regenerated).
 */
export function planGeneratedEnv(bundleId, manifest, { destDir, crowHome, composeText = null, priorInstall = false }) {
  const keys = generatedEnvKeys(manifest);
  if (keys.length === 0) return { env: {}, minted: {}, reusedPlain: {}, persist() {} };
  if (typeof bundleId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(bundleId) || bundleId.length > 64) {
    throw new Error(`Invalid bundle ID: ${JSON.stringify(bundleId)}`);
  }
  const byName = new Map((manifest.env_vars || []).map((v) => [v.name, v]));
  const installedPath = join(destDir, ".env");
  const installed = readEnvSafe(installedPath);
  // `priorInstall` (the caller saw an .env BEFORE copying the bundle source in — a source
  // tree may carry its own .env): a key that prior .env leaves blank ran on the compose
  // fallback, which its kept database still expects — never mint over it.
  const legacy = priorInstall && existsSync(installedPath) ? composeFallbacks(composeText) : {};
  const retainedPath = retainedEnvPath(crowHome, bundleId);
  const retained = readEnvSafe(retainedPath);
  const env = {};
  const minted = {};
  // keychain:true values kept from an earlier install (typed, or generated before): the
  // keychain may not hold them, and the form no longer shows the field — see install-hooks.
  const reusedPlain = {};
  const existingFor = (k) => installed[k] || retained[k] || legacy[k] || "";
  // Private halves first, so a public half can be derived from (or minted with) its pair.
  const order = [...keys].sort((a, b) => (byName.get(a)?.generate === "vapid_public_key") - (byName.get(b)?.generate === "vapid_public_key"));
  const pairs = {};
  for (const k of order) {
    const spec = byName.get(k) || {};
    const existing = existingFor(k);
    if (spec.generate === "vapid_public_key") {
      const priv = env[spec.pair];
      if (!priv || byName.get(spec.pair)?.generate !== "vapid_private_key") {
        throw new Error(`${k}: generate "vapid_public_key" needs pair: <a generate "vapid_private_key" var>`);
      }
      // Always the private key's own pair (a kept public key that no longer matches is
      // replaced); an undecodable private key keeps whatever public key was there.
      env[k] = pairs[spec.pair] || vapidPublicFromPrivate(priv) || existing;
      continue;
    }
    if (existing) {
      env[k] = existing;
      if (spec.keychain === true && !spec.store_as) {
        reusedPlain[k] = { plain: existing, origin: installed[k] || legacy[k] ? "typed" : "generated" };
      }
      continue;
    }
    let plain;
    if (spec.generate === "vapid_private_key") {
      const pair = newVapidKeypair();
      plain = pair.privateKey;
      pairs[k] = pair.publicKey;
    } else {
      plain = newSecretValue(spec.generate);
    }
    env[k] = spec.store_as === "argon2id" ? argon2idPhc(plain) : plain;
    if (spec.keychain === true) minted[k] = plain;
  }
  const persist = () => {
    const dir = dirname(retainedPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writePrivateFile(
      retainedPath,
      `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
        `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
        formatEnvLines({ ...retained, ...env }),
    );
  };
  return { env, minted, reusedPlain, persist };
}

/**
 * Back-compat: mint/reuse AND persist in one call. Refuses keychain:true manifests —
 * their plaintext must reach the keychain first (planGeneratedEnv), never be dropped.
 */
export function resolveGeneratedEnv(bundleId, manifest, opts) {
  if (keychainGeneratedKeys(manifest).length > 0) {
    throw new Error("resolveGeneratedEnv cannot handle keychain:true env vars; use planGeneratedEnv and save `minted` first");
  }
  const plan = planGeneratedEnv(bundleId, manifest, opts);
  plan.persist();
  return plan.env;
}

/**
 * `keychain_label` / `keychain_username` / `keychain_url` templates: `${VAR}` from the
 * install env. Any referenced var that is unset or blank → null (the field is dropped).
 */
export function expandKeychainTemplate(template, env) {
  if (typeof template !== "string" || template === "") return null;
  let blank = false;
  const out = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env && env[name];
    if (v === undefined || v === null || String(v) === "") { blank = true; return ""; }
    return String(v);
  });
  return blank ? null : out;
}

export function stripGeneratedKeys(manifest, envVars) {
  if (!envVars || typeof envVars !== "object") return envVars;
  const drop = new Set(generatedEnvKeys(manifest));
  const out = {};
  for (const [k, v] of Object.entries(envVars)) if (!drop.has(k)) out[k] = v;
  return out;
}

/**
 * Never written to the gateway's own .env: generated secrets (unless the manifest says
 * `propagate: true` — gateway-side code reads them from process.env) + `propagate: false`.
 * A store_as hash is never propagated: the gateway would get a hash, not the secret.
 */
export function gatewayExcludedKeys(manifest) {
  const out = new Set();
  for (const v of manifest?.env_vars || []) {
    if (!v || typeof v.name !== "string") continue;
    if (v.propagate === false) out.add(v.name);
    else if (GENERATE_KINDS.has(v.generate) && (v.propagate !== true || v.store_as)) out.add(v.name);
  }
  return out;
}

/** Generated keys the gateway .env receives (`propagate: true`, never a stored hash). */
export function gatewayGeneratedKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate) && v.propagate === true && !v.store_as)
    .map((v) => v.name);
}

/**
 * Uninstall: copy the effective value of every generated key (the installed .env's, else
 * the compose fallback a blank key ran on) into the retained copy, for keys it does not
 * hold yet. An install made before these keys were generated has no retained copy; without
 * this its reinstall would mint new DB passwords against the kept database volume.
 * Returns the number of keys added. Never throws.
 */
export function retainGeneratedForReinstall(bundleId, manifest, { destDir, crowHome, composeText = null, includeFallbacks = true }) {
  try {
    const keys = generatedEnvKeys(manifest);
    if (keys.length === 0 || !/^[a-z0-9][a-z0-9-]*$/.test(String(bundleId)) || String(bundleId).length > 64) return 0;
    const installedPath = join(destDir, ".env");
    if (!existsSync(installedPath)) return 0;
    const installed = readEnvSafe(installedPath);
    // A data-deleting uninstall drops the fallbacks: they are publicly known values, kept
    // only because a kept database still expects them — and there is none any more.
    const legacy = includeFallbacks ? composeFallbacks(composeText) : {};
    const retainedPath = retainedEnvPath(crowHome, bundleId);
    const retained = readEnvSafe(retainedPath);
    const add = {};
    for (const k of keys) {
      if (retained[k]) continue;
      const v = installed[k] || legacy[k];
      if (v) add[k] = v;
    }
    if (Object.keys(add).length === 0) return 0;
    const dir = dirname(retainedPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writePrivateFile(
      retainedPath,
      `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
        `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
        formatEnvLines({ ...retained, ...add }),
    );
    return Object.keys(add).length;
  } catch {
    return 0;
  }
}

/**
 * `env_vars[].check: "not_breached"` — refuse a value found in known data breaches,
 * the same Have I Been Pwned check Nextcloud's password_policy enforces by default, so
 * the install is refused up front instead of failing in the post-install hook.
 * k-anonymity: only the first 5 hex chars of the SHA-1 leave the machine. Network
 * failure -> no verdict (the app's own policy decides; bootstrap explains recovery).
 */
export async function breachedValueViolation(manifest, envVars, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const vals = envVars && typeof envVars === "object" ? envVars : {};
  for (const v of manifest?.env_vars || []) {
    if (!v || v.check !== "not_breached") continue;
    const val = vals[v.name];
    if (val === undefined || val === null || val === "") continue;
    const sha = createHash("sha1").update(String(val)).digest("hex").toUpperCase();
    let text;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, { signal: ctl.signal, headers: { "Add-Padding": "true" } });
      if (!r.ok) continue;
      text = await r.text();
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
    for (const line of String(text).split("\n")) {
      const [suffix, count] = line.trim().split(":");
      if (suffix === sha.slice(5) && Number(count) > 0) {
        return { key: v.name, why: "appears in known data breaches (haveibeenpwned.com), so the app's password policy would reject it; choose another" };
      }
    }
  }
  return null;
}

/** First supplied value breaking its manifest `pattern`, or null. Names the KEY, never the value. */
export function envPatternViolation(manifest, envVars) {
  const vals = envVars && typeof envVars === "object" ? envVars : {};
  for (const v of manifest?.env_vars || []) {
    if (!v || typeof v.pattern !== "string") continue;
    const val = vals[v.name];
    if (val === undefined || val === null || val === "") continue;
    let re;
    try { re = new RegExp(v.pattern); } catch { return { key: v.name, why: "has an invalid format rule in its manifest" }; }
    if (!re.test(String(val))) {
      return { key: v.name, why: v.pattern_hint ? `must be ${v.pattern_hint}` : "does not match the allowed format" };
    }
  }
  return null;
}
