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
