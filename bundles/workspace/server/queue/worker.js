/**
 * The close-time applier (spec §5.8): every 15 s, for each file with pending / unknown_after_claim changes (or live
 * changes not yet checked against the saved file): stat it; if it is unlocked AND ONLYOFFICE `info` says no session
 * (checked even when unlocked — the connector locks only after the editor fetched the file), verify live-applied
 * changes, then apply the waiting ones in seq order. Any lock (a person's, a live session, or a phone viewing it)
 * → nothing happens; a stale editor lock → one notification. Runs in the gateway only (one applier per host);
 * every transition is a CAS, so a second applier would still be safe.
 */
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { splitPath } from "../nc/paths.js";
import { docSession } from "../nc/onlyoffice.js";
import { MAX_EDIT_BYTES } from "../write-protocol.js";
import { filesWithWork, nextApplicable, releaseExpiredLeases, expireOld, recoverStranded, get, setPath } from "./store.js";
import { applyQueued, verifyLive } from "./apply.js";
import { notifyChange } from "./notify.js";

async function statFile(cfg, db, f) {
  try { return await stat(cfg, splitPath(f.path)); }
  catch (e) {
    if (e.code !== "not_found") throw e;
    // renamed or moved since it was queued: find it again by id and keep the rows in step
    const segs = await resolveRef(cfg, { file_id: Number(f.file_id) });
    const e2 = await stat(cfg, segs);
    if (Number(e2.fileId) !== Number(f.file_id)) throw e;
    await setPath(db, f.file_id, e2.path);
    return e2;
  }
}

const staleNotified = new Set();
async function notifyStaleOnce(db, fileId) {
  if (staleNotified.has(fileId)) return; staleNotified.add(fileId);
  const r = (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE file_id=? AND state='pending' ORDER BY seq LIMIT 1", args: [fileId] })).rows[0];
  if (r) await notifyChange(db, r, "failed", { message_for_user: "the file is still marked open in the editor but nobody is editing it; its owner can Unlock it in Workspace (⋯ → Unlock), then the change applies" });
}

/** One file, session already known to be over: verify live changes, then apply waiting ones in seq order. */
export async function processFile(ctx, db, f) {
  const lives = (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE file_id=? AND state='applied_live' AND verified=0 ORDER BY seq", args: [f.file_id] })).rows;
  if (lives.length) {
    const { bytes } = await getFile(ctx.getConfig(), splitPath(lives[0].path), { maxBytes: MAX_EDIT_BYTES });
    for (const r of lives) {
      const out = await verifyLive(db, r, bytes); // reads only: the bytes stay current for every row
      if (out.state === "failed") await notifyChange(db, await get(db, r.id), "failed", out);
    }
  }
  for (let row = await nextApplicable(db, f.file_id); row; row = await nextApplicable(db, f.file_id)) {
    const r = await applyQueued(ctx, db, row);
    if (r.state === "skipped" || r.state === "pending") break;
    await notifyChange(db, await get(db, row.id), r.state, r);
  }
}

export function makeTick({ db, getConfig, clock }) {
  return async function tick() {
    const cfg = getConfig(); const ctx = Object.freeze({ getConfig, clock });
    await releaseExpiredLeases(db, clock.now());
    for (const id of await expireOld(db, clock.now())) await notifyChange(db, await get(db, id), "expired");
    for (const f of await filesWithWork(db)) {
      try {
        const e = await statFile(cfg, db, f);
        if (e.lock) {
          if (e.lockType === 1) { const s = await docSession(cfg, e.fileId).catch(() => ({ live: true })); if (!s.live) await notifyStaleOnce(db, f.file_id); }
          continue; // any lock: wait (a person's lock, a live session — also a phone viewing it — or a stale one)
        }
        staleNotified.delete(f.file_id);
        const s = await docSession(cfg, e.fileId).catch(() => ({ live: true })); // unknown → treat as open
        if (s.live) continue;
        await processFile(ctx, db, { file_id: f.file_id, path: e.path });
      } catch (err) { console.warn(`[workspace] queue: file ${f.file_id}: ${err.code || ""} ${err.message}`); }
    }
  };
}

let running = null;
/** Idempotent per process: a second call returns the running worker's stop(). Recovers stranded rows once at start. */
export function startQueueWorker({ db, getConfig, clock, intervalMs = 15000 }) {
  if (running) return running;
  const tick = makeTick({ db, getConfig, clock }); let busy = false;
  const recovered = recoverStranded(db).catch((e) => console.warn(`[workspace] queue recover: ${e.message}`));
  const t = setInterval(() => {
    if (busy) return; busy = true;
    recovered.then(() => tick()).catch((e) => console.warn(`[workspace] queue tick: ${e.message}`)).finally(() => { busy = false; });
  }, intervalMs);
  t.unref?.();
  const stop = () => { clearInterval(t); if (running === stop) running = null; };
  running = stop; return stop;
}
export { recoverStranded };
