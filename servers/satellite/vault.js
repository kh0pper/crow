/**
 * The satellite's vault: the encrypted `crow.db` backups crow uploads nightly (SAT-8, spec §12.3,
 * §5.2). Signed routes on agent.js's signed router (auth.js has verified every request; answers go
 * through sendSigned):
 *
 *   GET    vault                  → the signed manifest, a JSON array [{name, size, sha256, mtime}]
 *   PUT    vault/:name            → streamed upload; signed JSON {ok, name, size, sha256}
 *   GET    vault/:name            → the file, plain octet-stream (signed by the manifest above, the
 *                                   same pattern as bundle backups: no per-file signature)
 *   DELETE vault/:name            → signed JSON {ok, name}
 *
 * The directory is `$SAT_HOME/vault/<crow_id_hash>/`, where `crow_id_hash` is the first 16 hex of
 * sha256 of the PINNED crow_id — the pin, never the primary's instance id, so a rebuilt crow that
 * comes back with the same Crow ID (same seed) finds its backups again (spec §12.4). Dirs are 0700
 * and files 0600, and no component is ever followed through a symlink (lstat, like backup-pull).
 *
 * Only `crow-db-YYYYMMDD.vault` is accepted as a name: the name is a date, and the weekly verify
 * decrypts the file under that date (the rollback check in crow-vault.js).
 *
 * Upload is the ONE streamed body on the satellite: a 100 MB file cannot be buffered for a
 * signature, so the signed request covers the body's hash given up front in
 * `X-Crow-Sat-Body-Sha256` (agent.js skips express.raw for exactly this route, auth.js verifies the
 * signature over that header value before a byte is read — see vaultStreamScope below). The bytes
 * then stream to `<name>.<random>.tmp`, hashing as they go; the file is fsynced, the hash compared,
 * and only a match is renamed into place. Anything else unlinks the temp file.
 *
 * Quota: 2 GB per crow_id_hash directory, counted with the incoming Content-Length, refused (413
 * `quota`) before a byte is written. crow decides what to delete (retention is crow-side).
 *
 * Only owner callers may touch the vault: a bot has no business with crow's database, and the
 * spec's management surface (§8) is driven by owner sessions.
 */
import { constants as fsc, chmodSync, closeSync, createReadStream, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream";

export const VAULT_QUOTA_BYTES = 2 * 1024 ** 3;
/** `crow-db-<YYYYMMDD>.vault` and nothing else (spec §12.3). */
export const VAULT_NAME = /^crow-db-(\d{4})(\d{2})(\d{2})\.vault$/;
export const VAULT_HEADER = "X-Crow-Sat-Body-Sha256";

/** First 16 hex of sha256(pinned crow_id), UTF-8: the directory the vault lives in. */
export function vaultDirHash(crowId) {
  return createHash("sha256").update(String(crowId), "utf8").digest("hex").slice(0, 16);
}

/** True for an accepted name: the pattern AND a real calendar day (2026-02-30 is refused). */
export function isValidVaultName(name) {
  const m = VAULT_NAME.exec(typeof name === "string" ? name : "");
  if (!m) return false;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso;
}

/**
 * mkdir -p at 0700, then prove by lstat that the final component is a real directory and not a
 * symlink (a link planted at `vault/` or `vault/<hash>/` must never be written through).
 */
function ensurePrivateDir(path) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    chmodSync(path, 0o700);
    return true;
  } catch {
    return false;
  }
}

/** Opened with O_NOFOLLOW and checked on that same fd: a symlink is never followed or hashed. */
function openRegular(path) {
  let fd;
  try { fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | (fsc.O_NONBLOCK || 0)); } catch { return null; }
  let st;
  try { st = fstatSync(fd); } catch { closeSync(fd); return null; }
  if (!st.isFile()) { closeSync(fd); return null; }
  return { fd, st };
}

const sha256Fd = (fd) => new Promise((ok, fail) => {
  const h = createHash("sha256");
  createReadStream(null, { fd, autoClose: true }).on("error", fail).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex")));
});

const refusal = (status, code) => ({ ok: false, status, code });

/**
 * The vault directory for the pinned crow_id (creating it), or a refusal. Nothing here trusts the
 * filesystem: every entry is lstat'ed and only regular files count.
 */
export function createVaultStore({ satHome, getCrowId, quotaBytes = VAULT_QUOTA_BYTES, now = Date.now }) {
  const dirFor = () => {
    const crowId = String(getCrowId() || "");
    if (!crowId) return null;
    return join(satHome, "vault", vaultDirHash(crowId));
  };

  /** The vault directory, created and proven private, or {ok:false}. */
  function openDir() {
    const dir = dirFor();
    if (!dir) return refusal(403, "not_paired");
    if (!ensurePrivateDir(join(satHome, "vault")) || !ensurePrivateDir(dir)) return refusal(500, "unsafe_vault_dir");
    return { ok: true, dir };
  }

  /** Bytes on disk in the vault (temp files included: they would count against the quota anyway). */
  function usageBytes(dir) {
    let total = 0;
    let names = [];
    try { names = readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile()) total += st.size;
      } catch { /* vanished */ }
    }
    return total;
  }

  /**
   * Temp files of uploads that died (power loss, a killed agent) are swept after a day: otherwise
   * a crashed 100 MB upload would hold quota for ever. Only regular `*.tmp` files, never a link.
   */
  function sweepStaleTmp(dir, olderThanMs = 24 * 3600 * 1000) {
    const cutoff = now() - olderThanMs;
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile() && !st.isSymbolicLink() && st.mtimeMs < cutoff) unlinkSync(join(dir, name));
      } catch { /* raced with a live upload */ }
    }
  }

  async function list() {
    const d = openDir();
    if (!d.ok) return d;
    let names = [];
    try { names = readdirSync(d.dir); } catch { return { ok: true, objects: [] }; }
    const out = [];
    for (const name of names) {
      if (!isValidVaultName(name)) continue;
      const f = openRegular(join(d.dir, name));
      if (!f) continue;
      const sha256 = await sha256Fd(f.fd).catch(() => null);
      if (!sha256) continue;
      out.push({ name, size: f.st.size, sha256, mtime: f.st.mtime.toISOString() });
    }
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.name.localeCompare(b.name)));
    return { ok: true, objects: out };
  }

  /**
   * Stream a body to `<name>`: temp file, hash while writing, fsync, compare, rename. `declaredLength`
   * and `declaredSha256` are the Content-Length and the body hash the signature covered; the quota is
   * checked with the length before any byte is written, so an over-quota upload costs nothing.
   */
  async function put({ name, declaredLength, declaredSha256, stream }) {
    if (!isValidVaultName(name)) return refusal(400, "bad_name");
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) return refusal(400, "bad_length");
    const d = openDir();
    if (!d.ok) return d;
    sweepStaleTmp(d.dir);
    if (usageBytes(d.dir) + declaredLength > quotaBytes) return refusal(413, "quota");

    const tmp = join(d.dir, `${name}.${randomBytes(6).toString("hex")}.tmp`);
    let fd = null;
    let keep = false;
    try {
      fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW || 0), 0o600);
      const h = createHash("sha256");
      let got = 0;
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        got += buf.length;
        if (got > declaredLength) {
          stream.destroy?.();
          return refusal(400, "bad_length");
        }
        h.update(buf);
        writeSync(fd, buf);
      }
      if (got !== declaredLength) return refusal(400, "bad_length");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      const sha256 = h.digest("hex");
      if (typeof declaredSha256 !== "string" || declaredSha256 !== sha256) return refusal(400, "hash_mismatch");
      chmodSync(tmp, 0o600);
      renameSync(tmp, join(d.dir, name));
      keep = true;
      return { ok: true, name, size: got, sha256 };
    } catch {
      stream.destroy?.();
      return refusal(500, "write_failed");
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      if (!keep) { try { unlinkSync(tmp); } catch { /* never created */ } }
    }
  }

  /** The open file for the plain download, or null (404: absent, a directory, a symlink). */
  function open(name) {
    if (!isValidVaultName(name)) return { ok: false, status: 400, code: "bad_name" };
    const d = openDir();
    if (!d.ok) return d;
    const f = openRegular(join(d.dir, name));
    if (!f) return refusal(404, "not_found");
    return { ok: true, fd: f.fd, size: f.st.size };
  }

  function remove(name) {
    if (!isValidVaultName(name)) return refusal(400, "bad_name");
    const d = openDir();
    if (!d.ok) return d;
    const path = join(d.dir, name);
    try {
      const st = lstatSync(path);
      // A symlink or a directory at a vault name is not a vault object: never unlink through it.
      if (!st.isFile() || st.isSymbolicLink()) return refusal(404, "not_found");
    } catch {
      return refusal(404, "not_found");
    }
    try {
      unlinkSync(path);
    } catch {
      return refusal(404, "not_found");
    }
    return { ok: true, name };
  }

  return { put, list, open, remove };
}

/**
 * Pre-parser middleware for the signed router: the streamed vault PUT declares its body hash
 * instead of carrying bytes for it. Marks the request (so agent.js skips express.raw and auth.js
 * verifies the signature over the declared hash) and refuses a PUT that carries no usable header
 * before anything is read. Every other route keeps the raw-body parser unchanged.
 */
export function vaultStreamScope(sendSigned) {
  return (req, res, next) => {
    if (!(req.method === "PUT" && /^\/vault\/[^/]+$/.test(req.path))) return next();
    const declared = req.get(VAULT_HEADER.toLowerCase());
    const length = req.get("content-length");
    if (typeof declared !== "string" || !/^[0-9a-f]{64}$/.test(declared) || !/^\d{1,12}$/.test(String(length ?? ""))) {
      return sendSigned(res, 400, { error: "bad_body_hash" });
    }
    req.satBodySha256 = declared;
    req.satContentLength = Number(length);
    next();
  };
}

/** Mount the vault routes on the signed router. ctx: agent ctx (+ optional quotaBytes). */
export function registerVaultRoutes(router, { satHome, state, sendSigned, quotaBytes }) {
  const store = createVaultStore({ satHome, getCrowId: () => state.pinned?.crow_id || null, quotaBytes });
  const ownerOnly = (req, res, next) => (String(req.satCaller || "").startsWith("owner-") ? next() : sendSigned(res, 403, { error: "owner_only" }));
  router.use("/vault", ownerOnly);
  const h = (fn, status = 200) => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res)).then((out) => {
      if (out === undefined) return;
      if (out.ok === false) return sendSigned(res, out.status, { error: out.code });
      sendSigned(res, status, out);
    }).catch(next);
  };

  router.get("/vault", h(async () => {
    const r = await store.list();
    return r.ok ? r.objects : r; // the manifest is the list itself (the bundle-backup pattern)
  }));
  router.put("/vault/:name", h((req) => store.put({
    name: req.params.name,
    declaredLength: req.satContentLength,
    declaredSha256: req.satBodySha256, // the hash the request was signed over (vaultStreamScope)
    stream: req,
  })));
  router.get("/vault/:name", h((req, res) => {
    const f = store.open(req.params.name);
    if (f.ok === false) return f;
    res.status(200).set({ "Content-Type": "application/octet-stream", "Content-Length": String(f.size), "Cache-Control": "no-store" });
    // pipeline, not .pipe: a client that goes away mid-download destroys the answer, and pipeline
    // then destroys the file stream too, closing the fd. .pipe alone leaves it open until GC.
    pipeline(createReadStream(null, { fd: f.fd, autoClose: true }), res, () => {});
    return undefined;
  }));
  router.delete("/vault/:name", h((req) => store.remove(req.params.name)));
  return store;
}