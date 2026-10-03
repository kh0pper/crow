/**
 * Installer-generated bundle secrets + bundle .env hygiene (config-friction stage 1, F1).
 *
 *   env_vars[].generate: "secret"   → 32 random bytes, base64url (43 chars; no `$`,
 *                                     quotes or spaces: safe in compose .env, URLs, bash)
 *
 * NEVER regenerated on reinstall: bundles bind-mount their data and the kept DB still
 * expects the old password. Order: installed .env → retained copy at
 * <CROW_HOME>/secrets/bundle-env/<id>.env (dir 700, file 600; uninstall never deletes
 * it) → new value. Generated keys are hidden from the forms (html.js), ignored in
 * requests (stripGeneratedKeys), never install-blocking, never sent to the gateway .env.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";

const GENERATE_KINDS = new Set(["secret"]);

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readEnvSafe(path) {
  try { return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {}; } catch { return {}; }
}

export function generatedEnvKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate))
    .map((v) => v.name);
}

export function newSecretValue() {
  return randomBytes(32).toString("base64url");
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

export function resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }) {
  const keys = generatedEnvKeys(manifest);
  if (keys.length === 0) return {};
  if (typeof bundleId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(bundleId) || bundleId.length > 64) {
    throw new Error(`Invalid bundle ID: ${JSON.stringify(bundleId)}`);
  }
  const installed = readEnvSafe(join(destDir, ".env"));
  const retainedPath = retainedEnvPath(crowHome, bundleId);
  const retained = readEnvSafe(retainedPath);
  const out = {};
  for (const k of keys) out[k] = installed[k] || retained[k] || newSecretValue();
  const dir = dirname(retainedPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const merged = { ...retained, ...out };
  writePrivateFile(
    retainedPath,
    `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
      `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
      Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );
  return out;
}

export function stripGeneratedKeys(manifest, envVars) {
  if (!envVars || typeof envVars !== "object") return envVars;
  const drop = new Set(generatedEnvKeys(manifest));
  const out = {};
  for (const [k, v] of Object.entries(envVars)) if (!drop.has(k)) out[k] = v;
  return out;
}

/** Never written to the gateway's own .env: generated secrets + `propagate: false` vars. */
export function gatewayExcludedKeys(manifest) {
  const out = new Set(generatedEnvKeys(manifest));
  for (const v of manifest?.env_vars || []) {
    if (v && typeof v.name === "string" && v.propagate === false) out.add(v.name);
  }
  return out;
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
