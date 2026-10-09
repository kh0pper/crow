// Crow Artifacts — the object store behind versions (spec §4.3, §11).
// Content-addressed: key = "sha256/<hex>". Versions are immutable, so an
// object is written once and shared by every version that carries the same
// bytes.
//
// ONE ASYNC INTERFACE for every backend (plan review R-H2):
//   keyOf(buf) -> key (sync, pure)
//   put(buf) -> Promise<key>, get(key) -> Promise<Buffer|null>, has(key) -> Promise<bool>,
//   del(key) -> Promise, keys() -> Promise<string[]>,
//   usage() -> Promise<bytes>   EXACT at call time (no cache): the quota is
//                               checked inside the write lock against it.
//   lockPath                    the SQLite file the cross-process lock uses
//                               (servers/shared/sqlite-lock.js; OS-released).
// Backends: local disk (here; the no-MinIO install) and MinIO
// (blob-store-minio.js, plan Task 2.2) over servers/storage/s3-client.js.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, constants as FS } from "node:fs";
import { open, rename, readFile, unlink, readdir, lstat, statfs } from "node:fs/promises";
import { join } from "node:path";

const KEY_RE = /^sha256\/[0-9a-f]{64}$/;
export const keyOf = (buf) => "sha256/" + createHash("sha256").update(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))).digest("hex");

/** R3-L5: fcntl locks are unreliable on network filesystems (SQLite's own
 *  warning). statfs magic numbers → a name, or null for a local filesystem. */
const NETWORK_FS = new Map([[0x6969, "nfs"], [0xff534d42, "cifs"], [0xfe534d42, "smb2"], [0x517b, "smb"], [0x65735546, "fuse"]]);
export function networkFsName(type) { return NETWORK_FS.get(Number(type) >>> 0) || null; }
export async function networkFsKind(path) { try { return networkFsName((await statfs(path)).type); } catch { return null; } }

export function createLocalBlobStore(root) {
  mkdirSync(join(root, "sha256"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });
  const pathOf = (key) => {
    if (!KEY_RE.test(key)) throw new Error("bad_key");
    return join(root, key);
  };
  return {
    kind: "local",
    lockPath: join(root, "write-lock.db"),   // servers/shared/sqlite-lock.js (R2-H2)
    keyOf,
    // R2-M2: temp files being written (or left by a crash) count too.
    async usage() {
      let n = 0;
      for (const d of ["sha256", "tmp"]) for (const f of await readdir(join(root, d))) { try { const st = await lstat(join(root, d, f)); if (st.isFile()) n += st.size; } catch {} }
      return n;
    },
    async tmpFiles() {
      const out = [];
      for (const f of await readdir(join(root, "tmp"))) { try { const st = await lstat(join(root, "tmp", f)); out.push({ name: f, mtimeMs: st.mtimeMs, size: st.size }); } catch {} }
      return out;
    },
    async delTmp(name) { if (/^[0-9a-f]{16}$/.test(name)) { try { await unlink(join(root, "tmp", name)); } catch {} } },
    async put(buf) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      const key = keyOf(b);
      const p = pathOf(key);
      if (existsSync(p)) return key;
      const tmp = join(root, "tmp", randomBytes(8).toString("hex"));
      // O_EXCL + O_NOFOLLOW: never write through a planted symlink.
      const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      try { await fh.writeFile(b); } finally { await fh.close(); }
      await rename(tmp, p);
      return key;
    },
    async get(key) {
      const p = pathOf(key);
      let fh;
      try { fh = await open(p, FS.O_RDONLY | FS.O_NOFOLLOW); } catch { return null; }
      try { return await fh.readFile(); } finally { await fh.close(); }
    },
    async has(key) { return existsSync(pathOf(key)); },
    async mtimeOf(key) { try { return (await lstat(pathOf(key))).mtimeMs; } catch { return null; } },
    // R3-M3: the store's identity, which must match the DB's before any reclaim.
    async readMarker() { try { return (await readFile(join(root, "store-id"), "utf8")).trim() || null; } catch { return null; } },
    async writeMarker(id) {
      const fh = await open(join(root, "store-id"), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      try { await fh.writeFile(String(id)); } finally { await fh.close(); }
    },
    async del(key) { try { await unlink(pathOf(key)); } catch {} },
    async keys() { return (await readdir(join(root, "sha256"))).map((f) => "sha256/" + f); },
  };
}
