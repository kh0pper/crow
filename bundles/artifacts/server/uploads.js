// Crow Artifacts — the two-step upload (artifact_upload_begin → PUT → commit).
//
// Why: a source that travels in ONE tool argument is bounded by the model's
// output-token limit. A 31 KB page hit it twice and once lost 5 characters on
// the way. So a big source goes over the wire as a FILE: the bot asks for a
// one-time URL, PUTs the bytes there, then commits by id — and the commit runs
// the SAME doCreate/doUpdate body the inline tools run, so every validation,
// version, audit, round and link gate applies unchanged.
//
// Staging is IN MEMORY: no table, no schema change, no disk copy. An entry
// lives at most UPLOAD_TTL_MS and holds only text the commit will consume.
//
// The token IS the capability: the bot has no session cookie here, so the URL
// path is the whole authorization. Only its sha256 is kept, and the lookup
// compares digests — an entry cannot be reconstructed from the Map.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { LIMITS } from "./limits.js";

export const UPLOAD_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_PER_ACTOR = 8;
export const MAX_PENDING_TOTAL = 32;
/** The source fields a file may fill. `source` is a diagram's Design-kit spec
 *  text (engine comes from the commit); every one of them is UTF-8 text. */
export const UPLOAD_FIELDS = Object.freeze(["html", "markdown", "svg", "source"]);
export const UPLOAD_PATH_PREFIX = "/artifacts/upload";
/** How often the one background sweep runs (armed by the first begin). */
export const SWEEP_INTERVAL_MS = 60 * 1000;

const err = (code, message) => Object.assign(new Error(message || code), { code });
const digestOf = (token) => createHash("sha256").update(String(token == null ? "" : token), "utf8").digest();

/** token sha256 (hex) → entry. Nothing else keys it, and nothing else is kept. */
const pending = new Map();

/** Static refusal text (the artifacts fail() contract: never authored text). */
const NO_SUCH = "no such upload: it has expired, was already used, or is not yours";
const OVER_CAP = "the file is bigger than this upload allows: start again with artifact_upload_begin and a smaller file";
const NOT_UTF8 = "the file is not UTF-8 text: artifacts sources are text";
const SHA_MISMATCH = "the file's sha256 does not match the one declared at artifact_upload_begin";
const HAS_FILE = "this upload already has its file: commit it, or start a new upload";
const ALREADY_READ = "the request body had already been read";
const CUT_SHORT = "the upload was cut short: send the whole file in one PUT";

/** The ceiling for a field, before any declared size is applied. */
export function capForField(field) {
  let max = LIMITS.uploadBytes;
  // The document renderer (marked) has a cliff on long escape-dense input, and
  // renders in the gateway process: markdown keeps its own, smaller cap.
  if (field === "markdown") max = Math.min(max, LIMITS.documentMarkdownBytes);
  // A Design-kit diagram's `source` is a mermaid/D2/Vega-Lite spec: short by
  // nature, and rendered in the kit. It never needs the 4 MiB a page may.
  if (field === "source") max = Math.min(max, LIMITS.diagramSourceBytes);
  return max;
}

/** The byte cap that applies to ONE entry's PUT: the field ceiling, lowered to
 *  the size the bot declared at begin (a file may never exceed its own claim). */
export function maxBytesFor(entry) {
  const ceiling = capForField(entry.field);
  return entry.declaredBytes == null ? ceiling : Math.min(ceiling, entry.declaredBytes);
}

export function uploadPathFor(token) { return `${UPLOAD_PATH_PREFIX}/${token}`; }

const sameActor = (e, actor) =>
  e.actorKind === (actor?.kind ?? null) && e.actorId === (actor?.id ?? null) && e.thread === (actor?.thread ?? null);

/** Drop finished/expired staging: an entry is never needed after its TTL. */
function sweep(now = Date.now()) {
  for (const [k, e] of pending) if (e.expiresAt <= now) pending.delete(k);
}

let sweepTimer = null;
/** Arm the one background sweep lazily, on the first begin. `unref()`: it must
 *  never hold the process (or a test run) open. */
function armSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  return sweepTimer;
}

/**
 * Begin an upload. Nothing is stored but the INTENT: field, owner, optional
 * target artifact, declared size and (optionally) the file's sha256.
 * @returns {{token: string, path: string, expiresAt: number, maxBytes: number}}
 */
export function beginUpload({ actor, field, artifactId = null, declaredBytes = null, sha256 = null, now = Date.now() } = {}) {
  armSweep();
  sweep(now);
  if (!UPLOAD_FIELDS.includes(field)) throw err("bad_request", "field must be html, markdown, svg or source");
  const ceiling = capForField(field);
  if (declaredBytes != null && (!Number.isInteger(declaredBytes) || declaredBytes < 0)) throw err("bad_request", "bytes must be the whole number of bytes in the file");
  if (declaredBytes != null && declaredBytes > ceiling) throw err("too_big", "the declared size is over what one upload may carry: split the source or send it inline");
  if (sha256 != null && !/^[0-9a-f]{64}$/i.test(String(sha256))) throw err("bad_request", "sha256 must be 64 hex characters");
  let mine = 0;
  for (const e of pending.values()) if (!e.used && sameActor(e, actor)) mine++;
  if (mine >= MAX_PENDING_PER_ACTOR) throw err("rate_limited", "too many uploads are waiting for you: finish or let them expire (10 minutes)");
  if (pending.size >= MAX_PENDING_TOTAL) throw err("rate_limited", "too many uploads are waiting on this instance: let them expire (10 minutes)");

  const token = randomBytes(32).toString("hex");
  const key = digestOf(token).toString("hex");
  pending.set(key, {
    key, actorKind: actor?.kind ?? null, actorId: actor?.id ?? null, thread: actor?.thread ?? null,
    field, artifactId: artifactId == null ? null : String(artifactId),
    declaredBytes, sha256: sha256 == null ? null : String(sha256).toLowerCase(),
    expiresAt: now + UPLOAD_TTL_MS, bytes: null, writing: false,
  });
  return { token, path: uploadPathFor(token), expiresAt: now + UPLOAD_TTL_MS, maxBytes: maxBytesFor(pending.get(key)) };
}

/** The entry a token names, or null. Compared by digest, every candidate, in
 *  constant time per candidate (never by string equality on the path value). */
export function findUpload(token) {
  const d = digestOf(token);
  let hit = null;
  for (const [k, e] of pending) {
    const same = timingSafeEqual(Buffer.from(k, "hex"), d);
    if (same && !hit) hit = e;
  }
  return hit;
}

/**
 * Take an upload for its commit (ONE use, and a commit that fails still burns
 * it — the bot can simply begin again). Every refusal is the same static
 * answer except "no file yet", so a token cannot be probed for ownership.
 * @returns {object} the live entry, already marked used
 */
export function takeUpload(token, actor, now = Date.now()) {
  sweep(now);   // cheap: a commit is the other moment staging is known to be done
  const e = findUpload(token);
  if (!e || e.used || e.expiresAt <= now || !sameActor(e, actor)) throw err("not_found", NO_SUCH);
  if (e.bytes == null) throw err("bad_request", "this upload has no file yet: PUT it to its put_url first");
  e.used = true;
  return e;
}

/** Forget one entry (after its commit, success or failure). */
export function dropUpload(entry) { if (entry && entry.key) pending.delete(entry.key); }

/**
 * The PUT side: read the raw body (any content-type — `curl -T` sends
 * application/octet-stream), stop the moment it passes the cap, and keep the
 * bytes as a UTF-8 string on the entry.
 *
 * Refusals: unknown/expired/used token 404; a file already stored, or another
 * PUT still in flight 409; a body over the cap 413; bytes that are not UTF-8
 * 400; a declared sha256 that does not match 400.
 *
 * ONE PUT per token: the entry is claimed (`writing`) synchronously before the
 * first await, so N concurrent PUTs cannot all buffer a file (or race to
 * overwrite the winner's bytes). The claim is released on every refusal and
 * error path, so a retry after an aborted PUT still works.
 */
export async function handleUploadPut(req, res) {
  sweep();   // cheap: a PUT is where staging is looked at
  const token = req?.params?.upload_id ?? pathToken(req?.url);
  const entry = token ? findUpload(token) : null;
  const now = Date.now();
  if (!entry || entry.used || entry.expiresAt <= now) { if (entry) pending.delete(entry.key); return refuse(req, res, 404, NO_SUCH); }
  if (entry.bytes != null) return refuse(req, res, 409, HAS_FILE);
  if (entry.writing) return refuse(req, res, 409, HAS_FILE);
  if (req.readableEnded) return refuse(req, res, 400, ALREADY_READ);

  entry.writing = true;
  try {
    const cap = maxBytesFor(entry);
    const read = await readCapped(req, cap);
    if (read.over) return refuse(req, res, 413, OVER_CAP);
    if (read.error) return refuse(req, res, 400, CUT_SHORT);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(read.body); }
    catch { return refuse(req, res, 400, NOT_UTF8); }
    if (entry.sha256) {
      const got = createHash("sha256").update(read.body).digest();
      if (!timingSafeEqual(got, Buffer.from(entry.sha256, "hex"))) return refuse(req, res, 400, SHA_MISMATCH);
    }
    // Re-check after the await: a commit may have taken (and dropped) the
    // entry, the TTL may have run out, or the sweep may have dropped it while
    // the body was still arriving. A late PUT never lands on a spent token and
    // never swaps the bytes a commit already took.
    if (pending.get(entry.key) !== entry || entry.used || entry.expiresAt <= Date.now()) return refuse(req, res, 404, NO_SUCH);
    entry.bytes = text;
    entry.size = read.body.length;
    send(res, 200, "application/json", JSON.stringify({ ok: true, bytes: read.body.length, field: entry.field, max_bytes: cap }));
    return undefined;
  } finally {
    // Released on success too: the file is on the entry now, which is the
    // durable half of the claim.
    entry.writing = false;
  }
}

/** The token out of a raw request URL (when no route param is available). */
function pathToken(url) {
  if (typeof url !== "string") return null;
  let p;
  try { p = new URL(url, "http://upload.invalid").pathname; } catch { return null; }
  const m = /^\/artifacts\/upload\/([0-9a-f]{64})\/?$/.exec(p);
  return m ? m[1] : null;
}

/** Test seam: bytes this handler has consumed, and how often it stopped early.
 *  A PUT must never buffer more than the cap — this is what a test measures. */
export const readMeter = { bytes: 0, capped: 0 };
export function _resetReadMeter() { readMeter.bytes = 0; readMeter.capped = 0; }
/** Test seams: drop all staging, and make one entry look expired. */
export function _resetUploadsForTest() { pending.clear(); }
export function _expireForTest(token) { const e = findUpload(token); if (!e) return false; e.expiresAt = Date.now() - 1; return true; }

/**
 * Read a body with a hard byte ceiling. Stops (pauses the request) the moment
 * the ceiling is passed: the refused peer may keep sending, but nothing more
 * of it is read or kept. Never retains more than `cap` bytes.
 */
function readCapped(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      readMeter.bytes += buf.length;
      if (total > cap) { readMeter.capped++; settle({ over: true }); return; }
      chunks.push(buf);
    };
    const onEnd = () => settle({ body: Buffer.concat(chunks, total) });
    const onError = () => settle({ error: true });
    // A peer that hangs up mid-body never emits "end": the stream closes short.
    const onClose = () => settle({ error: true });
    function settle(v) {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
      // Stop the socket feeding us: no more bytes are read (or kept).
      try { req.pause(); } catch { /* already closed */ }
      resolve(v);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function refuse(req, res, status, text) {
  try { req.pause(); } catch { /* already closed */ }
  send(res, status, "text/plain; charset=utf-8", text);
  // Hang up once the refusal is on the wire: the peer may still be streaming
  // the rest of a file we will never read.
  res.once("finish", () => { try { req.destroy(); } catch { /* already gone */ } });
}

function send(res, status, type, text) {
  if (res.headersSent) return;
  res.status(status).type(type);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
  res.end(text);
}