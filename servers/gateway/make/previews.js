/**
 * Make's real previews (Task 4.5): a capture of a trusted artifact's current version,
 * drawn by the sandboxed preview renderer (preview/renderer.js + preview/render.js).
 *
 * Security rules (each re-checked where it matters):
 *   - previewEligible fails CLOSED. Received artifacts, untrusted-round output (a tainted
 *     current version), a flagged current version, a deleted artifact, a missing version
 *     row and every type but page / document / diagram never render: a type tile only.
 *   - Eligibility is checked when a listing asks (ensureArtifactPreview), again on fresh
 *     rows after the capture and before the write (C3: a page that turned ineligible
 *     during the render is discarded), and on EVERY request for the image (C5).
 *   - A render gets its own view token (scriptsOff, frame-ancestors 'none'), may load only
 *     that token's path (allowPrefix), and the token is revoked when the job ends, on
 *     success and on every failure.
 *   - A near-blank capture is stored as a `.blank` marker, never as an image.
 *   - preview_bad_status / preview_navigated / preview_too_large write nothing at all and
 *     are not tried again for that version for an hour; preview_timeout writes nothing,
 *     feeds the renderer's breaker (release({ timedOut: true })) and is tried again.
 *
 * Files: <dataDir>/previews/<artifactId>/<n>-<hash16>.png (or .blank). The URL carries the
 * version and the hash, so it is safe to cache for a year; sweepPreviews removes every
 * file that is not the current version's, and every directory whose artifact is gone or
 * ineligible (boot and hourly; a flagged version stops being served at once, because
 * the route re-checks).
 *
 * Jobs run one at a time from a capped queue (createPreviewQueue). Renders on one CDP
 * client are also serialized inside render.js (R15); this queue is about jobs, not CDP.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { flagUntrusted, isTainted } from "../../shared/artifact-trust.js";
import { MAIN_DOCUMENT_TYPES, renderInContext, isNearBlank } from "../preview/render.js";
import { createOriginFetcher } from "../preview/origin-fetch.js";
import { artifactOriginInfo, viewTokens } from "../artifact-origin/runtime.js";
import { previewRenderer, previewsEnabled, setPreviewsEnabled } from "../preview/renderer.js";
import { createDbClient, resolveDataDir } from "../../db.js";
import { installedBundle } from "./sources.js";

export const ARTIFACT_ID_RE = /^art_[A-Za-z0-9_-]{6,40}$/;
const HASH_RE = /^[0-9a-f]{16,}$/;
const H16_RE = /^[0-9a-f]{16}$/;
const WS_REF_RE = /^[1-9]\d{0,15}$/;
const HOUR_MS = 3600_000;
/** After a job found the renderer off, listings say so (no new job) for this long. */
const OFF_RECHECK_MS = 60_000;
const NO_SAVE = new Set(["preview_bad_status", "preview_navigated", "preview_too_large"]);

/** Reasons the renderer gives (acquire's { off }), and the line each one shows. */
export const RENDERER_REASONS = ["no_docker", "building", "build_failed", "start_failed", "sandbox_unavailable", "origin_unreachable"];
const LINE_KEYS = {
  no_docker: "shell.previewsNoDocker",
  building: "shell.previewsBuilding",
  build_failed: "shell.previewsBuildFailed",
  start_failed: "shell.previewsStartFailed",
  sandbox_unavailable: "shell.previewsNoSandbox",
  origin_unreachable: "shell.previewsOriginDown",
};
/** The i18n key of the one line under the filter chips, or null (no line). */
export const previewLineKey = (reason) => LINE_KEYS[reason] || null;

/**
 * May this artifact's current version be rendered? Fails closed, in this order.
 * @returns {{ ok: true } | { ok: false, reason: "received"|"untrusted"|"flagged"|"deleted"|"no_version"|"type" }}
 */
export function previewEligible(art, version) {
  if (!art || art.deleted_at) return { ok: false, reason: "deleted" };
  if (flagUntrusted(art.received)) return { ok: false, reason: "received" };
  if (typeof art.type !== "string" || !Object.hasOwn(MAIN_DOCUMENT_TYPES, art.type)) return { ok: false, reason: "type" };
  if (!version) return { ok: false, reason: "no_version" };
  if (version.flagged_reason) return { ok: false, reason: "flagged" };
  if (isTainted(version)) return { ok: false, reason: "untrusted" };
  return { ok: true };
}

const hash16 = (h) => String(h || "").slice(0, 16);
function keyParts(artifactId, n, contentHash) {
  if (!ARTIFACT_ID_RE.test(String(artifactId)) || !Number.isInteger(Number(n)) || Number(n) < 1 || !HASH_RE.test(String(contentHash || ""))) {
    throw Object.assign(new Error("bad preview key"), { code: "bad_key" });
  }
  return { id: String(artifactId), n: Number(n), h: hash16(contentHash) };
}

/** <dataDir>/previews/<artifactId>/<n>-<contentHash.slice(0,16)>.png */
export function previewFile(dataDir, artifactId, n, contentHash) {
  const k = keyParts(artifactId, n, contentHash);
  return join(dataDir, "previews", k.id, `${k.n}-${k.h}.png`);
}
const blankFile = (png) => png.replace(/\.png$/, ".blank");

/** /dashboard/make/preview/artifact/<id>?v=<n>&h=<hash16> (C5: the URL moves with the version). */
export function previewUrlFor(artifactId, n, contentHash) {
  const k = keyParts(artifactId, n, contentHash);
  return `/dashboard/make/preview/artifact/${k.id}?v=${k.n}&h=${k.h}`;
}

/** The artifact row and its CURRENT version's row (artifact_versions where n = current_version). */
export async function loadPreviewRows(db, artifactId) {
  if (!ARTIFACT_ID_RE.test(String(artifactId))) return { art: null, version: null };
  const { rows } = await db.execute({
    sql: "SELECT id, type, received, deleted_at, current_version FROM artifacts WHERE id = ?",
    args: [String(artifactId)],
  });
  const art = rows[0] || null;
  if (!art) return { art: null, version: null };
  const v = await db.execute({
    sql: "SELECT n, content_hash, untrusted_input, trust_cleared_at, flagged_reason FROM artifact_versions WHERE artifact_id = ? AND n = ?",
    args: [art.id, Number(art.current_version)],
  });
  return { art, version: v.rows[0] || null };
}

// ---- the job queue ----------------------------------------------------------------------

/**
 * One job at a time, at most `max` waiting or running, one per key.
 * add(key, fn) -> "queued" | "busy" (that key is already in) | "full".
 */
export function createPreviewQueue({ max = 24, log = console } = {}) {
  const keys = new Set();
  const waiting = [];
  let running = false;
  async function pump() {
    if (running) return;
    const next = waiting.shift();
    if (!next) return;
    running = true;
    try { await next.fn(); } catch (err) { log.warn?.(`[make] preview job failed: ${err?.message || err}`); }
    keys.delete(next.key);
    running = false;
    setImmediate(pump);
  }
  return {
    add(key, fn) {
      if (keys.has(key)) return "busy";
      if (keys.size >= max) return "full";
      keys.add(key);
      waiting.push({ key, fn });
      setImmediate(pump);
      return "queued";
    },
    has: (key) => keys.has(key),
    size: () => keys.size,
    /** Resolves once nothing is waiting or running (tests). */
    idle() {
      return new Promise((resolve) => {
        const check = () => (keys.size === 0 ? resolve() : setTimeout(check, 5));
        setImmediate(check);
      });
    },
  };
}

// ---- process state ----------------------------------------------------------------------

let failures = new Map();            // `${id}:${n}:${h16}` -> { code, at }: no-save failures
let offSeen = { reason: null, at: 0 }; // the renderer's last off, as a job saw it
let queueSingleton = null;
let fetcherSingleton = null;         // { key, fetcher }
let testDeps = null;

/** The process's job queue. */
export function previewQueue() {
  if (!queueSingleton) queueSingleton = createPreviewQueue();
  return queueSingleton;
}

/**
 * The gateway's one origin fetcher (suggestion 6): it connects to the artifact origin's
 * bind address, never to the host in a URL. null while the origin isn't configured.
 */
export function previewFetcher({ info = artifactOriginInfo(), create = createOriginFetcher } = {}) {
  if (!info?.bindHost || !info?.port) return null;
  const key = `${info.bindHost}:${info.port}`;
  if (fetcherSingleton?.key !== key) fetcherSingleton = { key, fetcher: create({ host: info.bindHost, port: info.port }) };
  return fetcherSingleton.fetcher;
}

/** Make's own workspace preview fetch: the installed Workspace bundle's fetchPreview. */
async function defaultWorkspacePreview(fileId) {
  const crowHome = process.env.CROW_HOME || join(process.env.HOME || "", ".crow");
  if (!installedBundle(crowHome, "workspace")) return null;
  const imp = (f) => import(pathToFileURL(join(crowHome, "bundles", "workspace", "server", f)).href);
  const [{ getConfig }, dav] = await Promise.all([imp("config.js"), imp("nc/dav.js")]);
  if (typeof dav.fetchPreview !== "function") return null;
  return dav.fetchPreview(getConfig(), fileId, { x: 640, y: 400 });
}

/** Everything a listing, a job and the routes use; tests replace it. */
export function previewDeps() {
  if (testDeps) return testDeps;
  return {
    dataDir: resolveDataDir(), queue: previewQueue(), renderer: previewRenderer(), fetcher: previewFetcher(),
    tokens: viewTokens(), info: artifactOriginInfo(), render: renderInContext, nearBlank: isNearBlank,
    now: Date.now, jobDb: null, workspacePreview: defaultWorkspacePreview,
  };
}

/** Tests only: replace every dependency (null restores the real ones). */
export function _setPreviewDepsForTest(d) { testDeps = d || null; }
/** Tests only: forget the no-save failures and the renderer's last off. */
export function _resetPreviewStateForTest() { failures = new Map(); offSeen = { reason: null, at: 0 }; }

// ---- ensure + the job -------------------------------------------------------------------

const off = (reason) => ({ status: "off", reason });

/**
 * What a tile shows for this artifact, queueing a render when there is nothing yet.
 * @returns {Promise<{ status: "ready", file: string, url: string } | { status: "pending", url: string } | { status: "off", reason: string }>}
 */
export async function ensureArtifactPreview(db, artifactId, deps = previewDeps()) {
  const { dataDir, queue, renderer, fetcher, info } = deps;
  const now = deps.now || Date.now;
  const { art, version } = await loadPreviewRows(db, artifactId);
  // 1. Not eligible: never queued.
  const el = previewEligible(art, version);
  if (!el.ok) return off(el.reason);
  const n = Number(art.current_version);
  let file, url;
  try {
    file = previewFile(dataDir, art.id, n, version.content_hash);
    url = previewUrlFor(art.id, n, version.content_hash);
  } catch {
    return off("no_version"); // a hash that isn't hex: nothing safe to name a file after
  }
  // 2. A file for the current version.
  if (existsSync(blankFile(file))) return off("blank");
  if (existsSync(file)) return { status: "ready", file, url };
  // 3. The renderer is off (as a job last saw it; a fresh job checks again after a minute).
  const lastOff = renderer?.lastOff?.() || null;
  if (lastOff && lastOff !== "not_enabled") {
    if (offSeen.reason !== lastOff) offSeen = { reason: lastOff, at: now() };
    if (now() - offSeen.at < OFF_RECHECK_MS) return off(lastOff);
  }
  if (!fetcher || !info?.baseUrl) return off("start_failed"); // no artifact origin: nothing to render from
  // 4. A no-save failure for this version less than an hour ago.
  const key = `${art.id}:${n}:${hash16(version.content_hash)}`;
  const failed = failures.get(key);
  if (failed && now() - failed.at < HOUR_MS) return off(failed.code);
  // 5. Queue it.
  if (queue.has(key)) return { status: "pending", url };
  const added = queue.add(key, () => runPreviewJob(art.id, n, version.content_hash, deps));
  if (added === "full") return off("busy");
  return { status: "pending", url };
}

function writeAtomic(target, bytes) {
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, bytes);
  try { renameSync(tmp, target); } catch (err) { try { unlinkSync(tmp); } catch {} throw err; }
}

/** One render of one version. Never throws (the queue logs anything unexpected). */
export async function runPreviewJob(artifactId, n, contentHash, deps = previewDeps()) {
  const { dataDir, renderer, fetcher, tokens, info } = deps;
  const now = deps.now || Date.now;
  const render = deps.render || renderInContext;
  const nearBlank = deps.nearBlank || isNearBlank;
  const db = deps.jobDb || createDbClient();
  const ownDb = !deps.jobDb;
  const key = `${artifactId}:${n}:${hash16(contentHash)}`;
  try {
    // Another job found the renderer off a moment ago: don't ask again yet.
    if (offSeen.reason && now() - offSeen.at < OFF_RECHECK_MS) return;
    // Still the eligible current version (a cheap check before any lease).
    let rows = await loadPreviewRows(db, artifactId);
    if (!previewEligible(rows.art, rows.version).ok || Number(rows.art.current_version) !== n || rows.version.content_hash !== contentHash) return;
    const type = rows.art.type;

    // 1. A lease on the renderer.
    const lease = await renderer.acquire();
    if (lease.off) { offSeen = { reason: lease.off, at: now() }; return; }
    offSeen = { reason: null, at: 0 };
    let minted = null;
    let timedOut = false;
    try {
      // 2. A token for this version only, scripts off, no frame ancestor.
      minted = tokens.mint({ artifactId, versionN: n, type, dashboardOrigin: null, scriptsOff: true });
      // 3. The render may load only this token's path (R4-C3).
      const prefix = `${info.baseUrl}/v/${minted.token}/`;
      const png = await render(lease.cdp, { url: prefix, allowPrefix: prefix, mainType: MAIN_DOCUMENT_TYPES[type], fetcher });
      // 4. Eligible still, on fresh rows (C3), and still the current version.
      rows = await loadPreviewRows(db, artifactId);
      if (!previewEligible(rows.art, rows.version).ok || Number(rows.art.current_version) !== n || rows.version.content_hash !== contentHash) return;
      const file = previewFile(dataDir, artifactId, n, contentHash);
      const dir = join(dataDir, "previews", artifactId);
      mkdirSync(dir, { recursive: true });
      // 5. Near-blank: the marker, never the image. 6. Otherwise the PNG, atomically.
      const target = (await nearBlank(png)) ? blankFile(file) : file;
      writeAtomic(target, target === file ? png : "");
      const keep = target.slice(dir.length + 1);
      for (const name of readdirSync(dir)) if (name !== keep) rmSync(join(dir, name), { force: true, recursive: true });
    } catch (err) {
      if (NO_SAVE.has(err?.code)) failures.set(key, { code: err.code, at: now() });
      else if (err?.code === "preview_timeout") timedOut = true;
      else console.warn(`[make] preview of ${artifactId} v${n} failed: ${err?.message || err}`);
    } finally {
      // 7. Always: the token is revoked and the lease released (a timeout feeds the breaker).
      // A throwing revoke must never skip the release (the lease would leak).
      if (minted) {
        try { tokens.revokeToken(minted.tokenId); } catch (err) { console.warn(`[make] preview token not revoked: ${err?.message || err}`); }
      }
      if (timedOut) lease.release({ timedOut: true });
      else lease.release();
    }
  } finally {
    if (ownDb) { try { db.close(); } catch {} }
  }
}

/**
 * Delete every preview directory whose artifact is gone or ineligible, and every file
 * that is not the current version's (a temp file is left alone for 10 minutes).
 * @returns {Promise<{ removed: number }>}
 */
export async function sweepPreviews(db, dataDir) {
  const root = join(dataDir, "previews");
  let removed = 0;
  let names;
  try { names = readdirSync(root); } catch { return { removed }; }
  for (const id of names) {
    if (!ARTIFACT_ID_RE.test(id)) continue;
    const dir = join(root, id);
    const { art, version } = await loadPreviewRows(db, id);
    if (!previewEligible(art, version).ok || !HASH_RE.test(String(version.content_hash || ""))) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
      continue;
    }
    const stem = `${Number(art.current_version)}-${hash16(version.content_hash)}`;
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (name === `${stem}.png` || name === `${stem}.blank`) continue;
      if (name.includes(".tmp-")) {
        try { if (Date.now() - statSync(join(dir, name)).mtimeMs < 10 * 60_000) continue; } catch { continue; }
      }
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return { removed };
}

/** Boot: sweep now, then hourly. Skipped on a --no-auth gateway. */
export function startPreviewSweep({ noAuth = false } = {}) {
  if (noAuth) return null;
  const run = async () => {
    const db = createDbClient();
    try {
      const { removed } = await sweepPreviews(db, resolveDataDir());
      if (removed) console.log(`[make] removed ${removed} stale preview file(s)`);
    } catch (err) {
      console.warn(`[make] preview sweep failed: ${err?.message || err}`);
    } finally {
      try { db.close(); } catch {}
    }
  };
  run();
  const iv = setInterval(run, HOUR_MS);
  iv.unref?.();
  return iv;
}

// ---- what a tile shows ------------------------------------------------------------------

/**
 * The preview fields of one Make item: { previewState, previewUrl, previewReason }.
 * previewState: "ready" | "pending" | "off" | "workspace" (the client tries the image).
 */
export async function itemPreview(db, item, deps) {
  if (item.kind === "workspace_file") {
    if (!WS_REF_RE.test(String(item.ref))) return { previewState: "off", previewUrl: null, previewReason: "type" };
    return { previewState: "workspace", previewUrl: `/dashboard/make/preview/workspace_file/${item.ref}`, previewReason: null };
  }
  if (item.kind !== "artifact") return { previewState: "off", previewUrl: null, previewReason: "type" };
  try {
    const r = await ensureArtifactPreview(db, item.ref, deps || previewDeps());
    if (r.status === "ready" || r.status === "pending") return { previewState: r.status, previewUrl: r.url, previewReason: null };
    return { previewState: "off", previewUrl: null, previewReason: r.reason };
  } catch (err) {
    console.warn(`[make] preview check failed for ${item.ref}: ${err?.message || err}`);
    return { previewState: "off", previewUrl: null, previewReason: "error" };
  }
}

// ---- routes (mounted in dashboard/index.js after dashboardAuth + csrfMiddleware) --------

const notFound = (res) => res.status(404).type("text/plain").send("not found");

/** GET /dashboard/make/preview/artifact/:id?v=&h= — eligibility re-checked on every request (C5). */
export async function serveArtifactPreview(req, res, db, deps = previewDeps()) {
  const id = String(req.params.id || "");
  const v = String(req.query.v ?? "");
  const h = String(req.query.h ?? "");
  if (!ARTIFACT_ID_RE.test(id) || !/^[1-9]\d{0,8}$/.test(v) || !H16_RE.test(h)) return notFound(res);
  const { art, version } = await loadPreviewRows(db, id);
  if (!previewEligible(art, version).ok) return notFound(res);
  if (Number(art.current_version) !== Number(v) || hash16(version.content_hash) !== h) return notFound(res);
  let file;
  try { file = previewFile(deps.dataDir, id, Number(v), version.content_hash); } catch { return notFound(res); }
  if (existsSync(blankFile(file))) return notFound(res);
  let png;
  try { png = readFileSync(file); } catch { return notFound(res); }
  res.set({ "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  return res.status(200).end(png);
}

/** GET /dashboard/make/preview/workspace_file/:id — Nextcloud's preview, else 404. */
export async function serveWorkspacePreview(req, res, deps = previewDeps()) {
  const ref = String(req.params.id || "");
  if (!WS_REF_RE.test(ref)) return notFound(res);
  let img = null;
  try { img = await deps.workspacePreview(Number(ref)); } catch (err) { console.warn(`[make] Workspace preview failed: ${err?.message || err}`); }
  if (!Buffer.isBuffer(img) || !img.length) return notFound(res);
  const type = /^image\/(png|jpeg|gif|webp)$/.test(String(img.contentType || "")) ? img.contentType : "image/png";
  res.set({ "Content-Type": type, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" });
  if (img.etag) res.set("ETag", String(img.etag));
  return res.status(200).end(img);
}

/** A same-site /dashboard/ path to go back to, else /dashboard/make. */
export function safeBack(raw) {
  const s = typeof raw === "string" ? raw : "";
  if (!/^\/dashboard(\/[A-Za-z0-9_-]+)*\/?(\?[A-Za-z0-9_=&%.-]*)?$/.test(s)) return "/dashboard/make";
  return s;
}

/**
 * POST /dashboard/make/previews/enable (session + CSRF, from the router): the switch on,
 * any remembered start failure forgotten (so the renderer tries at once), the image
 * build started, then back to where the button was.
 */
export async function enablePreviews(req, res, db, deps = previewDeps()) {
  try {
    await setPreviewsEnabled(db, true);
    offSeen = { reason: null, at: 0 };
    deps.renderer?.clearBackoff?.();
    Promise.resolve(deps.renderer?.prepare?.()).catch(() => {});
  } catch (err) {
    console.error(`[make] previews not turned on: ${err?.message || err}`);
  }
  return res.redirect(303, safeBack(req.body?.back));
}

export { previewsEnabled };
