/**
 * Pull a satellite bundle's newest backup to crow (SAT-5, spec §7.2, §14 "restore Gitea from
 * crow's pulled dumps"). The nightly pull TIMER is deferred to deploy (it needs a CROW-SCHEDULE
 * registration); this is the function it will call.
 *
 *   1. signed GET bundles/<id>/backups → [{name, size, sha256, created_at}] (the manifest; a
 *      signed JSON answer, so name, size and hash are the satellite's word)
 *   2. signed GET bundles/<id>/backups/<name> → the plain octet-stream (the one non-JSON
 *      answer; it is checked against the signed manifest instead)
 *   3. streamed to a 0600 temp file in <root>/<sat>/<bundle>/ (dirs 0700, never a symlink),
 *      refusing more bytes than the manifest's size; kept only when size AND sha256 match,
 *      then renamed into place. Anything else leaves no file.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsc, createReadStream, existsSync, lstatSync, mkdirSync, openSync, renameSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSatelliteId, signRequest } from "../../shared/satellite-protocol.js";
import { satelliteFetch, satelliteBaseUrl, sendOnce, satFail } from "./client.js";
import { getSatellite } from "./store.js";
import { loadMgmtKey } from "./mgmt-keys.js";

export const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUNDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_PULL_TIMEOUT_MS = 30 * 60000;
export const defaultBackupRoot = () => join(homedir(), "backups", "satellites");

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  chmodSync(path, 0o700);
  return true;
}

// Streamed: a backup may be large (review L1).
const fileSha = (p) => new Promise((ok, fail) => {
  const h = createHash("sha256");
  createReadStream(p).on("error", fail).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex")));
});

export const DEFAULT_MAX_BACKUP_BYTES = 2 * 1024 ** 3;
export const DISK_MARGIN_BYTES = 256 * 1024 ** 2;

/** → {pulled:true, name, path, size, sha256} | {pulled:false, code}. Throws only on a bad bundle id. */
export async function pullNewestBackup(satId, bundle, {
  db, fetchImpl = globalThis.fetch, env = process.env, root = defaultBackupRoot(), timeoutMs = DEFAULT_PULL_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BACKUP_BYTES, statfs = statfsSync,
} = {}) {
  if (!BUNDLE_RE.test(String(bundle))) throw new TypeError("pullNewestBackup: bad bundle id");
  if (!isSatelliteId(satId)) return { pulled: false, code: "not_found" };
  const sat = await getSatellite(db, satId);
  if (!sat || sat.status === "revoked") return { pulled: false, code: "not_found" };

  let list;
  try {
    const r = await satelliteFetch(sat, { method: "GET", path: `/satellite/v1/bundles/${bundle}/backups`, caller: "owner-local", fetchImpl, env });
    if (r.status !== 200) return { pulled: false, code: typeof r.json?.error === "string" ? r.json.error : `status_${r.status}` };
    list = r.json?.backups;
  } catch (err) {
    return { pulled: false, code: err?.code || "unreachable" };
  }
  if (!Array.isArray(list) || !list.length) return { pulled: false, code: "no_backups" };
  const newest = [...list].sort((a, b) => String(b?.created_at).localeCompare(String(a?.created_at)))[0];
  const { name, size, sha256 } = newest || {};
  if (typeof name !== "string" || !BACKUP_NAME_RE.test(name) || !Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(String(sha256))) {
    return { pulled: false, code: "bad_manifest" };
  }
  if (size > maxBytes) return { pulled: false, code: "too_large" };

  const satDir = join(root, satId);
  const dir = join(satDir, bundle);
  if (!ensurePrivateDir(root) || !ensurePrivateDir(satDir) || !ensurePrivateDir(dir)) return { pulled: false, code: "bad_destination" };
  const dest = join(dir, name);
  if (existsSync(dest)) {
    try {
      const st = lstatSync(dest);
      if (st.isFile() && st.size === size && (await fileSha(dest)) === sha256) return { pulled: false, code: "up_to_date", name, path: dest };
    } catch { /* re-download */ }
  }

  // Room for the file plus a margin, before anything is downloaded.
  try {
    const f = statfs(dir);
    if (Number(f.bavail) * Number(f.bsize) < size + DISK_MARGIN_BYTES) return { pulled: false, code: "no_space" };
  } catch { return { pulled: false, code: "no_space" }; }

  const key = loadMgmtKey(satId, { env });
  if (!key) return { pulled: false, code: "no_mgmt_key" };
  const path = `/satellite/v1/bundles/${bundle}/backups/${name}`;
  const headers = { Accept: "application/octet-stream", ...signRequest(key.ed25519_priv, { method: "GET", pathQuery: path, body: "", satelliteId: satId, caller: "owner-local" }) };
  let res;
  try {
    res = await sendOnce(fetchImpl, satelliteBaseUrl(sat.tailnet_host) + path, { method: "GET", headers, body: "", timeoutMs });
  } catch (err) {
    return { pulled: false, code: err?.code || "unreachable" };
  }
  const ct = String(res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  if (res.status !== 200 || ct !== "application/octet-stream" || !res.body) {
    try { await res.body?.cancel(); } catch { /* gone */ }
    return { pulled: false, code: res.status !== 200 ? `status_${res.status}` : "bad_content_type" };
  }

  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.part`);
  let fd = null;
  let keep = false;
  try {
    fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW || 0), 0o600);
    const h = createHash("sha256");
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > size) {
        try { await reader.cancel(); } catch { /* gone */ }
        throw satFail("too_large");
      }
      h.update(value);
      writeSync(fd, value);
    }
    closeSync(fd);
    fd = null;
    if (got !== size) return { pulled: false, code: "size_mismatch" };
    if (h.digest("hex") !== sha256) return { pulled: false, code: "sha256_mismatch" };
    renameSync(tmp, dest);
    keep = true;
    return { pulled: true, name, path: dest, size, sha256 };
  } catch (err) {
    return { pulled: false, code: err?.code === "too_large" ? "too_large" : "write_failed" };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
    if (!keep) { try { unlinkSync(tmp); } catch { /* never created */ } }
  }
}
