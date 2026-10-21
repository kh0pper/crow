/**
 * Secrets from systemd credentials (queue item 19, migration step 0).
 *
 * A unit can hand the gateway (or the bot runner) a secret with
 *     LoadCredential=SOME_TOKEN:/etc/crow/credentials/SOME_TOKEN
 * instead of Environment= or EnvironmentFile=. systemd places the file in
 * $CREDENTIALS_DIRECTORY, readable only by the unit. Applied here, the value
 * lives in this process's memory: it is not printed by `systemctl show` (which
 * any local user can run) and is not part of the process's initial
 * /proc/<pid>/environ. Children spawned with process.env still inherit it
 * (pi children do not: servers/shared/bot-env.js passes an allowlist).
 *
 * Rules (each refusal is one warning naming the key, never the value):
 *  - only files named like an env key (^[A-Z_][A-Z0-9_]*$); anything else in
 *    the directory (e.g. a board-actor-secret credential) is left alone;
 *  - the directory's REAL path must lie under /run/credentials/ or, for user
 *    units, under $XDG_RUNTIME_DIR/credentials/ with the runtime dir under
 *    /run/user/;
 *  - regular files only, opened O_NOFOLLOW; at most 64 KiB; not empty; no NUL;
 *  - one trailing newline (\n or \r\n) is trimmed;
 *  - a key already in the environment wins (the same rule as the checkout
 *    .env), so a stale Environment= line is noticed instead of silently
 *    replaced.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** Names this process applied from credentials (values are never kept here). */
const applied = new Set();
export function credentialKeyNames() { return [...applied]; }
/**
 * A copy of `env` without the keys applied from credentials, for a child's
 * environment. Returns `env` itself when nothing was applied, so callers that
 * pass undefined/inherit keep their exact behaviour.
 */
export function withoutCredentialKeys(env) {
  if (!applied.size || !env) return env;
  const out = { ...env };
  for (const k of applied) delete out[k];
  return out;
}
/** Test seam. */
export function _resetCredentialKeysForTest() { applied.clear(); }

export function credentialRoots(env = process.env, { realpathFn = realpathSync } = {}) {
  const roots = ["/run/credentials"];
  const xdg = String((env && env.XDG_RUNTIME_DIR) || "").trim();
  if (xdg) {
    try {
      const r = realpathFn(xdg);
      if (r.startsWith("/run/user/")) roots.push(join(r, "credentials"));
    } catch { /* no runtime dir */ }
  }
  return roots;
}

function readCredential(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return { reason: e.code === "ELOOP" ? "is a symlink" : "cannot be opened (" + (e.code || "error") + ")" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { reason: "is not a regular file" };
    if (st.size > MAX_CREDENTIAL_BYTES) return { reason: "is larger than " + MAX_CREDENTIAL_BYTES + " bytes" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const got = readSync(fd, buf, off, st.size - off, off);
      if (got <= 0) break;
      off += got;
    }
    let value = buf.subarray(0, off).toString("utf8");
    buf.fill(0);
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if (!value) return { reason: "is empty" };
    if (value.includes("\0")) return { reason: "contains a NUL byte" };
    return { value };
  } finally {
    closeSync(fd);
  }
}

/**
 * Apply $CREDENTIALS_DIRECTORY's env-key files to `env`.
 * @returns {{applied: string[], skipped: {name: string, reason: string}[], problem: string|null}}
 */
export function applyCredentialFiles(env = process.env, { dir, roots, log = console } = {}) {
  const result = { applied: [], skipped: [], problem: null };
  const raw = String(dir ?? (env && env.CREDENTIALS_DIRECTORY) ?? "").trim();
  if (!raw) return result;
  let real;
  try { real = realpathSync(raw); } catch {
    result.problem = "CREDENTIALS_DIRECTORY does not exist";
    log.warn(`[credentials] ${result.problem}; no credentials applied`);
    return result;
  }
  const allowed = roots || credentialRoots(env);
  if (!allowed.some((r) => real.startsWith(r.replace(/\/+$/, "") + "/"))) {
    result.problem = "CREDENTIALS_DIRECTORY is not under " + allowed.join(" or ");
    log.warn(`[credentials] ${result.problem}; no credentials applied`);
    return result;
  }
  let names = [];
  try { names = readdirSync(real).sort(); } catch (e) {
    result.problem = "CREDENTIALS_DIRECTORY cannot be read (" + (e.code || "error") + ")";
    log.warn(`[credentials] ${result.problem}`);
    return result;
  }
  for (const name of names) {
    if (!KEY_RE.test(name)) continue;
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      result.skipped.push({ name, reason: "already set in the environment" });
      log.warn(`[credentials] ${name}: already set in the environment, the credential is ignored (remove the old Environment=/EnvironmentFile= entry)`);
      continue;
    }
    const r = readCredential(join(real, name));
    if (r.reason) {
      result.skipped.push({ name, reason: r.reason });
      log.warn(`[credentials] ${name}: ${r.reason}; skipped`);
      continue;
    }
    env[name] = r.value;
    result.applied.push(name);
    if (env === process.env) applied.add(name);
  }
  if (result.applied.length) {
    log.log(`[credentials] applied ${result.applied.length} key(s) from systemd credentials: ${result.applied.join(", ")}`);
  }
  return result;
}
