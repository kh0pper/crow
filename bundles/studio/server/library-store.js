/**
 * The Studio instrument catalog and the one stored copy of each catalog file.
 *
 * A song names a library entry (`lib-…`) that points at a catalog row; the
 * catalog row (`library/catalog.json`, checked in and vetted) names the file's
 * URLs, its sha256 and its size. The file itself is fetched ONCE per instance
 * into `<CROW_HOME>/studio/library/<sha256>.<ext>` and shared by every song on
 * the instance, so a second song that wants the same bank reuses it.
 *
 * ## Who may download
 *
 * Nobody on their own: the gateway's human-only route
 * (`POST /api/studio/library/download` in server/web.js) is the only caller.
 * An agent cannot download (Global Constraints: "Downloads are people-only"),
 * and the route refuses an agent's request before this module is reached.
 *
 * ## What a download promises
 *
 * The catalog is the contract, and this module keeps it or fails:
 *
 *   - the bytes are streamed to a private temporary file (0600) in the library
 *     directory and hashed as they arrive — never assembled in memory, so a
 *     40 MB bank costs one chunk of memory, not 40;
 *   - a body larger than the catalog's `bytes` is refused as soon as it passes
 *     that size, and a body that finishes with the wrong size or the wrong
 *     sha256 is refused too;
 *   - every refusal removes the temporary file, so a failed download leaves
 *     NOTHING behind (no half file under a name some song would trust);
 *   - only a verified file is renamed to its sha256 name, which is what makes
 *     that name worth something: a file called `<sha256>.sf3` is the file with
 *     that hash.
 *
 * A second call for a file that is already stored hashes the stored copy and
 * returns it without touching the network (or, if the stored copy does not
 * match — a disk that lost bytes — replaces it with a fresh download).
 * `holdsFile` is that same question asked by a caller that already has an
 * entry: does this Crow really hold the file with this hash?
 *
 * A transfer has two deadlines, enforced through one AbortController: the whole
 * download must finish within ten minutes, and no chunk may take longer than
 * thirty seconds to arrive. A stalled transfer is abandoned — its temporary
 * file removed, the row's next URL tried — and when nothing arrives the caller
 * gets a 504 saying the download timed out.
 *
 * Redirects are followed by hand (`redirect: "manual"`), at most three, and
 * only to an https URL whose host the catalog row itself names. Anything else
 * is refused before a byte is kept.
 *
 * ## Cleanup
 *
 * `libraryGc` removes stored files no song uses whose mtime is older than 30
 * days (and a temporary file an interrupted download left behind, after a day).
 * What "no song uses" means is the caller's `inUse` set: this module owns no
 * database. In the gateway the caller is `startLibraryGc` (`server/web.js`),
 * which runs one pass when Studio starts and then every 24 hours, with `inUse`
 * the sha256 of every library entry of every song in THIS instance's studio
 * database — the hub's `libraryHashes()`, a read-only walk that loads a song's
 * document the same way the song list and `openSong` read it. A song whose
 * document cannot be read makes that walk throw, and a pass that could not see
 * every song deletes NOTHING: the GC never decides on partial knowledge. The
 * file's mtime is refreshed whenever a download returns it, so a bank that is
 * in use is never "old".
 *
 * ## Mirrors are optional
 *
 * A catalog row carries one `urls` list — the sources its size and sha256 were
 * verified against, tried in order — and an optional `mirrors` field that is
 * empty today and read by nothing here. A mirror joins `urls` only once its
 * bytes have been checked against the same pin; until then it is not a source
 * this module would trust.
 *
 * ## No app modules
 *
 * This file imports only Node built-ins. `CROW_HOME`, `fetch` and the catalog
 * path arrive as arguments, so the same code runs in the gateway, in a test
 * with a local HTTP stub and a catalog override, and in a bundle install.
 *
 * A refusal carries `error.status` for the route: 400 for an invalid request,
 * 404 for an unknown catalog id, 413 for a body past its size, 502 when the
 * bytes do not match the catalog, 503 when the network or the disk failed, and
 * 504 when the download timed out.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The bundle root: `bundles/studio`. */
const BUNDLE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The vetted catalog, as it is checked in. */
export const DEFAULT_CATALOG_PATH = join(BUNDLE_DIR, "library", "catalog.json");

/** The library entry kinds a catalog row may have. */
export const CATALOG_KINDS = Object.freeze(["font", "nam", "ir"]);

/** The file extension each kind gets when its URL does not name one. */
const EXTENSION_BY_KIND = Object.freeze({ font: "sf3", nam: "nam", ir: "wav" });

/** Extensions a stored file may carry: the formats Studio reads (plan 1d). */
const KNOWN_EXTENSIONS = Object.freeze(["sf2", "sf3", "nam", "wav", "a2"]);

/** How old a stored file nothing uses must be before `libraryGc` removes it. */
export const GC_AGE_DAYS = 30;

/**
 * How old an interrupted download's temporary file must be before it is
 * collected. A refusal removes its own; only a crash leaves one, and a day is
 * long enough that a slow 40 MB download is never mistaken for rubbish.
 */
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long one catalog file's whole download may take before it is abandoned.
 * 40 MB over a slow line is minutes, not tens of minutes.
 */
export const DOWNLOAD_DEADLINE_MS = 10 * 60 * 1000;

/**
 * How long a transfer may go without delivering a chunk before it counts as
 * stalled: a server that accepted the connection and then stopped talking.
 */
export const DOWNLOAD_IDLE_MS = 30 * 1000;

/** What a caller is told when a download ran out of time. */
export const DOWNLOAD_TIMEOUT_TEXT = "The download timed out; try again later.";

/** How many redirects one download follows before it is refused. */
const MAX_REDIRECTS = 3;

/** The statuses that are a redirect to follow (304 is not one). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Every stored file's name is `<sha256>.<ext>`; nothing else is Studio's. */
const STORED_NAME = /^([0-9a-f]{64})\.([a-z0-9]{2,4})$/;

/** A refusal a caller can read, with the HTTP status the route answers. */
class LibraryError extends Error {
  /**
   * @param {string} code a Studio refusal code ("invalid", "not_found", "limit")
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    this.status = status;
  }
}

/** @returns {LibraryError} the catalog has no such row. */
function noSuchEntry(catalogId) {
  return new LibraryError(
    "not_found",
    `The instrument catalog has no entry "${catalogId}".`,
    404,
  );
}

/** @returns {LibraryError} the catalog row is not something this module can fetch. */
function badCatalog(message) {
  return new LibraryError("invalid", message, 500);
}

/** @returns {LibraryError} the catalog file is missing or unreadable. */
function noCatalog() {
  return new LibraryError("invalid", "This Crow has no instrument catalog.", 503);
}

/** @returns {LibraryError} every stored file lives under the Crow home. */
function noHome() {
  return new LibraryError("invalid", "Studio has no Crow home to keep instruments in.", 503);
}

/**
 * Validate one catalog row. The catalog is checked in, so a bad row is a
 * programming error rather than a caller's mistake — but it must fail BEFORE a
 * download starts, not after 40 MB and a hash that never matches.
 * @param {object} row
 * @param {number} index
 * @returns {object} the row, with the fields this module reads, normalised
 */
function validateEntry(row, index) {
  const where = `catalog row ${index}`;
  if (!row || typeof row !== "object") throw badCatalog(`${where} is not an object.`);
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) throw badCatalog(`${where} has no id.`);
  if (!CATALOG_KINDS.includes(row.kind)) {
    throw badCatalog(`Catalog entry "${id}" has an unknown kind "${row.kind}".`);
  }
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name || name.length > 80) throw badCatalog(`Catalog entry "${id}" needs a name of 1-80 characters.`);
  const urls = Array.isArray(row.urls) ? row.urls : [];
  if (urls.length === 0) throw badCatalog(`Catalog entry "${id}" names no URL.`);
  for (const url of urls) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw badCatalog(`Catalog entry "${id}" has a URL that is not http(s): ${String(url)}`);
    }
  }
  // `mirrors` is optional and read by nothing here: a row's `urls` are the
  // sources its size and sha256 were verified against, tried in order. Mirrors
  // stay empty until a second copy's bytes have been checked against the same
  // pin — that is when such a copy would join `urls` and be tried here.
  const sha256 = typeof row.sha256 === "string" ? row.sha256.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw badCatalog(`Catalog entry "${id}" needs a sha256 of 64 hexadecimal characters.`);
  }
  const bytes = Number(row.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw badCatalog(`Catalog entry "${id}" needs a positive byte count.`);
  }
  return {
    id,
    kind: row.kind,
    name,
    urls: urls.map((url) => String(url)),
    sha256,
    bytes,
    licence: typeof row.licence === "string" ? row.licence : "",
    credit: typeof row.credit === "string" ? row.credit : "",
    default: row.default === true,
    optional: row.optional === true,
  };
}

/**
 * Read and validate a catalog file.
 * @param {{catalogPath?: string}} [options]
 * @returns {Promise<{entries: object[]}>}
 */
export async function readCatalog({ catalogPath = DEFAULT_CATALOG_PATH } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    // The path and the parser's message are not the caller's business: the
    // catalog is a file on this instance, not something the request named.
    console.warn(`[studio] instrument catalog ${catalogPath}:`, error?.message || error);
    throw noCatalog();
  }
  const rows = Array.isArray(parsed?.entries) ? parsed.entries : null;
  if (!rows) throw badCatalog("The instrument catalog has no entries array.");
  const entries = rows.map(validateEntry);
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw badCatalog(`The instrument catalog names "${entry.id}" twice.`);
    seen.add(entry.id);
  }
  return { entries };
}

/**
 * One catalog row, or a 404 refusal.
 * @param {string} catalogId
 * @param {{catalogPath?: string}} [options]
 * @returns {Promise<object>}
 */
export async function catalogEntry(catalogId, options = {}) {
  const id = String(catalogId ?? "");
  const { entries } = await readCatalog(options);
  const found = entries.find((entry) => entry.id === id);
  if (!found) throw noSuchEntry(id);
  return found;
}

/** @returns {string} the library directory for one Crow home. */
export function libraryDir(crowHome) {
  return join(crowHome, "studio", "library");
}

/** @returns {number} `Date.now()`, injectable so a test controls age. */
function nowMillis(now) {
  return typeof now === "function" ? Number(now()) : Date.now();
}

/**
 * The extension a stored file for one catalog row carries: the URL's own when
 * it is a format Studio reads, otherwise the kind's default. Only for building
 * a path — nothing is derived from a caller's string.
 * @param {object} entry
 * @returns {string}
 */
export function extensionFor(entry) {
  const urls = Array.isArray(entry?.urls) ? entry.urls : [];
  for (const url of urls) {
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = "";
    }
    const ext = extname(pathname).replace(/^\./, "").toLowerCase();
    if (KNOWN_EXTENSIONS.includes(ext)) return ext;
  }
  return EXTENSION_BY_KIND[entry?.kind] ?? "bin";
}

/**
 * The one path a catalog file is stored at once verified:
 * `<CROW_HOME>/studio/library/<sha256>.<ext>`. The name is the hash, so two
 * songs that want the same bank share this file and no song has to trust a name
 * the server did not compute.
 * @param {object} entry - a catalog row
 * @param {{crowHome: string}} options
 * @returns {string}
 */
export function storedFileFor(entry, { crowHome }) {
  if (!crowHome) throw noHome();
  return join(libraryDir(crowHome), `${entry.sha256}.${extensionFor(entry)}`);
}

/** @returns {Promise<{size: number, sha256: string}|null>} a file's size and hash */
async function hashFile(path) {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest("hex") };
}

/**
 * The stored copy of one hash, whatever extension it carries.
 *
 * A downloaded file is named `<sha256>.<ext>`, and the extension follows the
 * catalog row that fetched it, so a route that only knows the sha256 (a library
 * entry whose catalog row has since changed) asks by hash. Null when this Crow
 * does not hold the file.
 * @param {string} sha256
 * @param {{crowHome: string}} options
 * @returns {Promise<string|null>}
 */
export async function storedFileByHash(sha256, { crowHome } = {}) {
  const hash = String(sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!crowHome) return null;
  const dir = libraryDir(crowHome);
  const names = await readdir(dir).catch(() => null);
  if (!names) return null;
  for (const name of names) {
    const match = STORED_NAME.exec(name);
    if (match && match[1] === hash) return join(dir, name);
  }
  return null;
}

/**
 * The stored copy of one hash, whatever extension it carries, when its bytes
 * still hash to that name.
 *
 * A route that already has a library entry asks this about the entry's own
 * sha256: a Crow that lost the file (a pruned cache, a restored home) or holds
 * bytes that no longer hash to the name must download it again, and an entry
 * whose file is really here is answered without the network.
 * @param {string} sha256
 * @param {{crowHome: string}} options
 * @returns {Promise<boolean>}
 */
export async function holdsFile(sha256, { crowHome } = {}) {
  const hash = String(sha256 ?? "").toLowerCase();
  const path = await storedFileByHash(hash, { crowHome });
  if (!path) return false;
  const info = await hashFile(path);
  return Boolean(info && info.sha256 === hash);
}

/** @returns {LibraryError} a 504 refusal saying the transfer ran out of time. */
function timedOut() {
  return new LibraryError("timeout", DOWNLOAD_TIMEOUT_TEXT, 504);
}

/** @returns {LibraryError} a refusal of a redirect the catalog does not allow. */
function refusedRedirect(why) {
  return new LibraryError("redirect", `The download redirected ${why}; nothing was kept.`, 502);
}

/**
 * The hosts a catalog row may redirect to: its own URLs' hosts and ports, and
 * nothing else. A catalog row is the contract, so a redirect may move between
 * the hosts the row itself names but never to one it does not.
 * @param {object} entry
 * @returns {Set<string>}
 */
function redirectHosts(entry) {
  const hosts = new Set();
  for (const url of entry.urls) {
    try {
      hosts.add(new URL(url).host.toLowerCase());
    } catch {
      // Already validated by `validateEntry`; a row that got here has valid URLs.
    }
  }
  return hosts;
}

/**
 * Fetch one URL, following its redirects by hand.
 *
 * `redirect: "manual"` keeps the decision here instead of inside `fetch`: a
 * redirect is followed only when it is https and points at a host the catalog
 * row itself names, at most `MAX_REDIRECTS` times. Anything else is refused
 * before a byte is written.
 * @param {string} url
 * @param {object} entry the catalog row, for the hosts it is allowed to reach
 * @param {Function} fetchImpl
 * @param {AbortSignal} signal
 * @returns {Promise<object>} the final (non-redirect) response
 */
async function fetchFollowing(url, entry, fetchImpl, signal) {
  const hosts = redirectHosts(entry);
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(Number(response?.status))) return response;
    await response.body?.cancel?.().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw refusedRedirect("too many times");
    const location = response.headers?.get?.("location");
    if (!location) throw refusedRedirect("nowhere");
    let next;
    try {
      next = new URL(String(location), current);
    } catch {
      throw refusedRedirect("nowhere");
    }
    if (next.protocol !== "https:" || !hosts.has(next.host.toLowerCase())) {
      throw refusedRedirect("somewhere the catalog does not name");
    }
    current = next.href;
  }
}

/**
 * Stream one URL into `destination` (a temporary file), hashing as it goes.
 *
 * Two deadlines ride on one AbortController: the whole transfer must finish
 * within `deadlineMs`, and no chunk may take longer than `idleMs` to arrive. A
 * timeout refuses with code "timeout" and status 504, which the caller treats
 * like a network failure — the temporary file goes and the row's next URL is
 * tried.
 * @param {string} url
 * @param {object} entry the catalog row, for the size and the expected hash
 * @param {string} destination
 * @param {Function} fetchImpl
 * @param {{deadlineMs?: number, idleMs?: number}} [limits]
 * @returns {Promise<void>}
 */
async function fetchInto(url, entry, destination, fetchImpl, limits = {}) {
  const deadlineMs = Number(limits.deadlineMs ?? DOWNLOAD_DEADLINE_MS);
  const idleMs = Number(limits.idleMs ?? DOWNLOAD_IDLE_MS);
  const controller = new AbortController();
  // One timer for the whole transfer: it aborts the request as well as the body
  // read, so a server that never answers a header is abandoned too.
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? setTimeout(() => controller.abort(timedOut()), deadlineMs)
    : null;
  deadline?.unref?.();
  try {
    let response;
    try {
      response = await fetchFollowing(url, entry, fetchImpl, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw timedOut();
      if (error instanceof LibraryError) throw error;
      throw new LibraryError("network", `The download failed: ${error?.message || error}`, 502);
    }
    if (!response || !response.ok) {
      const status = Number(response?.status);
      // A 404 from a mirror means "try the next URL"; 5xx too. Everything else is
      // the same answer for this row.
      const error = new LibraryError(
        "network",
        `The download failed (${Number.isFinite(status) ? status : "no response"}).`,
        502,
      );
      error.retryable = true;
      await response?.body?.cancel?.().catch(() => {});
      throw error;
    }
    // A Content-Length past the catalog's size is refused before a byte is
    // written. A server that lies is caught by the running count below.
    const announced = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(announced) && announced > entry.bytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new LibraryError(
        "limit",
        `That download is larger than the catalog says (${announced} bytes, expected ${entry.bytes}).`,
        413,
      );
    }

    const handle = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let written = 0;
    try {
      const body = response.body;
      if (!body) throw new LibraryError("network", "The download returned no body.", 502);
      // Read the body by hand: each chunk gets its own idle deadline, and the
      // overall deadline above stays armed for the whole transfer.
      const iterator = body[Symbol.asyncIterator]();
      for (;;) {
        let step;
        const idle = Number.isFinite(idleMs) && idleMs > 0
          ? setTimeout(() => controller.abort(timedOut()), idleMs)
          : null;
        idle?.unref?.();
        try {
          step = await iterator.next();
        } catch (error) {
          if (controller.signal.aborted) throw timedOut();
          if (error instanceof LibraryError) throw error;
          throw new LibraryError("network", `The download failed: ${error?.message || error}`, 502);
        } finally {
          if (idle) clearTimeout(idle);
        }
        if (step.done) break;
        const chunk = step.value;
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        written += bytes.byteLength;
        if (written > entry.bytes) {
          throw new LibraryError(
            "limit",
            `That download is larger than the catalog says (over ${entry.bytes} bytes).`,
            413,
          );
        }
        hash.update(bytes);
        await handle.write(bytes);
      }
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    await handle.close();
    const sha256 = hash.digest("hex");
    if (written !== entry.bytes) {
      throw new LibraryError(
        "invalid",
        `That download does not match the catalog (${written} bytes, expected ${entry.bytes}); nothing was kept.`,
        502,
      );
    }
    if (sha256 !== entry.sha256) {
      throw new LibraryError(
        "invalid",
        `That download does not match the catalog's sha256; nothing was kept.`,
        502,
      );
    }
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

/**
 * Fetch one catalog file into an already-open temporary file path, removing the
 * temporary file on any refusal.
 * @param {object} entry
 * @param {string} temporary
 * @param {Function} fetchImpl
 * @param {{deadlineMs?: number, idleMs?: number}} [limits]
 * @returns {Promise<void>}
 */
async function fetchVerified(entry, temporary, fetchImpl, limits = {}) {
  let lastError = null;
  for (const url of entry.urls) {
    try {
      await fetchInto(url, entry, temporary, fetchImpl, limits);
      return;
    } catch (error) {
      lastError = error;
      await unlink(temporary).catch(() => {});
      // A wrong size or hash from one mirror is not something a second URL
      // fixes for the same catalog row? It may be: mirrors do go stale. Only a
      // network answer (and a transfer that ran out of time) moves on to the
      // next URL; every other refusal is final, because the catalog is the
      // contract.
      if (error?.code !== "network" && error?.code !== "timeout") throw error;
    }
  }
  throw lastError ?? new LibraryError("network", "The download failed.", 502);
}

/**
 * Download one catalog file, verify it, and store it once per instance.
 *
 * Every URL of the row is tried in turn (primary first), and a network failure
 * moves to the next. The verified file is stored at
 * `<CROW_HOME>/studio/library/<sha256>.<ext>` with mode 0600. A refusal leaves
 * no file behind, temporary or final.
 *
 * @param {string} catalogId
 * @param {{crowHome: string, fetchImpl?: Function, catalogPath?: string,
 *          now?: () => number, deadlineMs?: number, idleMs?: number}} options
 *   `deadlineMs` and `idleMs` override the transfer's ten-minute total and
 *   thirty-second per-chunk deadlines (a test that stalls a stub uses them).
 * @returns {Promise<{entry: object, path: string, sha256: string, bytes: number,
 *                    fetched: boolean}>} `fetched` is false when the stored copy
 *   was already there and matched, and nothing went over the network
 */
export async function downloadCatalogEntry(catalogId, options = {}) {
  const { crowHome, fetchImpl = globalThis.fetch, catalogPath, now, deadlineMs, idleMs } = options;
  if (!crowHome) throw noHome();
  if (typeof fetchImpl !== "function") {
    throw new LibraryError("network", "This instance cannot download instruments.", 503);
  }
  const entry = await catalogEntry(catalogId, { catalogPath });
  const path = storedFileFor(entry, { crowHome });
  const dir = libraryDir(crowHome);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // A stored copy that still matches the catalog is the answer: no network, and
  // its mtime is refreshed so the housekeeping pass sees it as in use.
  const existing = await hashFile(path);
  if (existing && existing.size === entry.bytes && existing.sha256 === entry.sha256) {
    const stamp = new Date(nowMillis(now));
    await chmod(path, 0o600).catch(() => {});
    await utimes(path, stamp, stamp).catch(() => {});
    return { entry, path, sha256: entry.sha256, bytes: entry.bytes, fetched: false };
  }
  if (existing) {
    // Something is there under the right name but is not what the name says.
    // It is not a file any song may play, so it goes and the row is fetched.
    await unlink(path).catch(() => {});
  }

  // A hidden temporary name: `libraryGc` only ever looks at `<sha256>.<ext>`,
  // so a download in flight is never collected.
  const temporary = join(dir, `.part-${randomBytes(8).toString("hex")}-${entry.sha256}`);
  try {
    await fetchVerified(entry, temporary, fetchImpl, { deadlineMs, idleMs });
    await chmod(temporary, 0o600).catch(() => {});
    // An atomic rename: a reader sees no file or the verified one.
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { entry, path, sha256: entry.sha256, bytes: entry.bytes, fetched: true };
}

/**
 * Remove stored files no song uses that are older than `olderThanDays`.
 *
 * A file is "in use" when some song on the instance names its sha256, which is
 * the caller's set (this module owns no database). A file that is not in use is
 * only removed once its mtime is older than the limit, so a download made today
 * survives a song that was deleted an hour later — undoing that deletion keeps
 * working without a re-download.
 *
 * @param {{crowHome: string, inUse?: Set<string>, olderThanDays?: number,
 *          now?: () => number}} options
 * @returns {Promise<{removed: string[], freed_bytes: number}>}
 */
export async function libraryGc({ crowHome, inUse, olderThanDays = GC_AGE_DAYS, now } = {}) {
  if (!crowHome) throw noHome();
  const used = inUse instanceof Set ? inUse : new Set(inUse ?? []);
  const dir = libraryDir(crowHome);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: [], freed_bytes: 0 };
    throw error;
  }
  const limitMs = Number(olderThanDays) * 24 * 60 * 60 * 1000;
  const current = nowMillis(now);
  const removed = [];
  let freed = 0;
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) continue;
    const isTemporary = name.startsWith(".part-");
    const match = STORED_NAME.exec(name);
    if (!isTemporary && !match) continue;
    if (!isTemporary && used.has(match[1])) continue;
    const age = current - info.mtimeMs;
    if (isTemporary ? age < TEMP_MAX_AGE_MS : age < limitMs) continue;
    try {
      await unlink(path);
    } catch {
      continue;
    }
    removed.push(name);
    freed += info.size;
  }
  return { removed, freed_bytes: freed };
}

/**
 * A library store bound to one instance: the gateway builds one per process and
 * the routes call it without repeating `crowHome` and the catalog path.
 * @param {{crowHome: string, catalogPath?: string, fetchImpl?: Function,
 *          now?: () => number, deadlineMs?: number, idleMs?: number}} options
 * @returns {object} the bound calls the web layer uses
 */
export function createLibraryStore({ crowHome, catalogPath, fetchImpl, now, deadlineMs, idleMs } = {}) {
  const base = { crowHome, catalogPath, fetchImpl, now, deadlineMs, idleMs };
  return {
    crowHome,
    catalogPath: catalogPath ?? DEFAULT_CATALOG_PATH,
    /** @returns {Promise<object[]>} every catalog row */
    async entries() {
      return (await readCatalog(base)).entries;
    },
    /** @returns {Promise<object>} one catalog row, or a 404 refusal */
    async entry(catalogId) {
      return catalogEntry(catalogId, base);
    },
    /** @param {string} catalogId @returns {Promise<object>} see downloadCatalogEntry */
    async download(catalogId) {
      return downloadCatalogEntry(catalogId, base);
    },
    /** @param {object} entry @returns {string} where its stored copy lives */
    fileFor(entry) {
      return storedFileFor(entry, base);
    },
    /** @param {string} sha256 @returns {Promise<string|null>} the stored copy, by hash */
    async fileForHash(sha256) {
      return storedFileByHash(sha256, base);
    },
    /** @param {string} sha256 @returns {Promise<boolean>} whether its verified copy is here */
    async holds(sha256) {
      return holdsFile(sha256, base);
    },
    /** @param {object} options see libraryGc */
    async gc(options = {}) {
      return libraryGc({ ...base, ...options });
    },
  };
}