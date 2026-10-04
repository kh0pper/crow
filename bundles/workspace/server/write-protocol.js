/**
 * The ONE path that changes a Workspace file (spec §5). Lock check → wait → queue | optional editor drop →
 * read → mutate → If-Match PUT (one retry) → label versions → version_id. Restores and creations
 * share the same guard. Writes to one file are serialized in-process and spaced ≥ 1.1 s.
 */
import { WsError } from "./result.js";
import { stat, resolveRef, getFile, putFile, remove, normEtag } from "./nc/dav.js";
import { httpFail } from "./nc/http.js";
import { classifyLock } from "./nc/locks.js";
import { dropUsers } from "./nc/onlyoffice.js";
import { listVersions, labelVersion, restoreVersion } from "./nc/versions.js";
import { joinPath } from "./nc/paths.js";

export const MAX_EDIT_BYTES = 50 * 1024 * 1024;
export const WRITE_SPACING_MS = 1100; // R-COLLIDE: 1100 ms spacing gives distinct versions (spike)
/** Wall clock; tools inject their own (tests use a virtual one). */
export const systemClock = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
/**
 * The exact label shapes Crow writes ("Crow: …", "Before Crow: …", "Undo: …", "Quick edit: …", "Crow (queued): …").
 * Any other non-empty label was given by a person ("Crow's nest final") and is never overwritten (review I9).
 */
export const CROW_LABEL_RE = /^(Before )?(Crow|Undo|Quick edit)( \(queued\))?: /;

const queues = new Map();
// Last write per file, kept PER CLOCK: comparing a time from one clock with another (e.g. wall vs virtual)
// would produce a negative or huge gap, so each injected clock has its own record.
const lastWrites = new WeakMap();
const lastWriteOf = (clock) => { let m = lastWrites.get(clock); if (!m) { m = new Map(); lastWrites.set(clock, m); } return m; };
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function serialized(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

export function encodeVersionId({ f, b, a }) { return `v1.${Buffer.from(JSON.stringify({ f, b: String(b), a: normEtag(a) })).toString("base64url")}`; }
export function decodeVersionId(id) {
  const bad = () => new WsError("bad_version_id", "That version_id was not issued by the Workspace tools.");
  if (typeof id !== "string" || !id.startsWith("v1.") || !/^[A-Za-z0-9_-]+$/.test(id.slice(3))) throw bad();
  let o; try { o = JSON.parse(Buffer.from(id.slice(3), "base64url").toString("utf8")); } catch { throw bad(); }
  if (!Number.isInteger(o?.f) || !/^\d{1,12}$/.test(String(o?.b)) || typeof o?.a !== "string") throw bad();
  return o;
}

async function waitUnlocked(cfg, segs, waitS, clock) {
  const deadline = clock.now() + waitS * 1000;
  for (;;) {
    const e = await stat(cfg, segs);
    if (!e.lock || clock.now() >= deadline) return e;
    await clock.sleep(Math.min(2000, deadline - clock.now()));
  }
}

/** K5: thrown by settleLock when the write should be queued instead (caught by the with* wrappers). */
export class QueueSignal { constructor(entry, lock) { this.entry = entry; this.lock = lock; } }

/**
 * Wait up to waitS for the lock to clear; then queue (if_open "queue" + a provider), refuse, or — only for
 * if_open "force_close" on a live editor session and only when allowDrop — drop the editor once (spec §5.10:
 * a second drop is never sent without asking again). Returns the unlocked entry and whether a drop was sent.
 */
async function settleLock(cfg, segs, { waitS, ifOpen, clock, queue = null, allowDrop = true }) {
  let e = await waitUnlocked(cfg, segs, ifOpen === "force_close" ? 0 : waitS, clock);
  if (!e.lock) return { e, dropped: false };
  const c = await classifyLock(cfg, e);
  if (ifOpen === "queue" && queue) throw new QueueSignal(e, c); // default: smooth, nobody is kicked out
  if (ifOpen !== "force_close" || !c.data.can_proceed) throw new WsError(c.code, c.message, c.data);
  if (!allowDrop) throw new WsError(c.code, `${c.message} It was already closed once for this change; ask the user again before closing it a second time.`, c.data);
  await dropUsers(cfg, c.key, c.users);
  e = await waitUnlocked(cfg, segs, 30, clock);
  if (e.lock) throw new WsError("could_not_close_editor", "The editor did not close within 30 seconds. Try again later.", { open_by: c.data.open_by });
  return { e, dropped: true };
}

async function spacing(fileId, clock) {
  const gap = clock.now() - (lastWriteOf(clock).get(fileId) ?? -Infinity);
  if (gap < WRITE_SPACING_MS) await clock.sleep(WRITE_SPACING_MS - Math.max(0, gap));
}

/**
 * Review C2: Nextcloud keys versions by mtime SECONDS and overwrites the version row when two writes
 * share an mtime (files_versions FileEventsListener.php:326-333), across ALL processes (pi bots spawn
 * their own server; Quick edit runs in the gateway). So the spacing rule is enforced against the
 * SERVER's current mtime, not just this process's last write: never write until ≥ 1.1 s after the
 * file's current mtime. A write that lands DURING the sleep resets the gap, so the check loops until the
 * file is unchanged across a sleep. Returns the latest read.
 *
 * Review N1: the loop is bounded, and the LAST round never returns a fresh read (that read could be a foreign
 * save from this very second). With `ifMatchGuarded` (a PUT with If-Match follows) the last round sleeps out the
 * gap on the read it already has and returns it un-re-read: a save during that sleep changes the etag, so the
 * PUT takes the 412 path instead of sharing the save's second. Without it (a restore MOVE has no If-Match)
 * the last round throws a retryable `busy`.
 */
const MTIME_ROUNDS = 5;
async function settleMtime(cur, reread, clock, { ifMatchGuarded }) {
  for (let i = 0; ; i++) {
    const ageMs = clock.now() - cur.mtime * 1000;
    if (ageMs >= WRITE_SPACING_MS) return cur;
    if (i === MTIME_ROUNDS - 1 && !ifMatchGuarded) throw new WsError("busy", "The file is being saved repeatedly right now (someone is editing it). Nothing was changed; try again in a few seconds.");
    await clock.sleep(WRITE_SPACING_MS - Math.max(0, ageMs));
    if (i === MTIME_ROUNDS - 1) return cur;
    const next = await reread();
    const same = next.mtime === cur.mtime && normEtag(next.etag) === normEtag(cur.etag);
    cur = next;
    if (same) return cur;
  }
}

async function guard(cfg, ref) {
  const segs = Array.isArray(ref) ? ref : await resolveRef(cfg, ref);
  const e0 = await stat(cfg, segs);
  if (e0.isFolder) throw new WsError("not_a_file", `"${e0.path}" is a folder`);
  if (!e0.permissions.includes("W")) throw new WsError("read_only", `Crow bot can read "${e0.name}" but was not given edit rights. Ask the owner to share it with edit permission.`);
  return { segs, e0 };
}

/**
 * A share's mount point (owned by someone else, top of what was shared) is not trashed by DELETE: Nextcloud
 * only UNSHARES it from Crow bot. Every DELETE path (trash tool, undo of a created file) refuses it.
 */
export async function refuseShareRoot(cfg, segs, e) {
  if (!e.ownerId || e.ownerId === cfg.user) return;
  const parent = segs.length > 1 ? await stat(cfg, segs.slice(0, -1)) : null;
  if (!parent || parent.ownerId !== e.ownerId) throw new WsError("share_root", `"${e.name}" is shared with Crow bot by ${e.ownerName || e.ownerId}; deleting it would only remove Crow's access, not the files. Ask the owner to delete it, or trash items inside it.`);
}

/** Spec §5.4: changed_since carries {modified, modified_by_label} (the label of the version now current, if any). */
async function changedSince(cfg, now, message) {
  const rows = await listVersions(cfg, now.fileId).catch(() => null);
  const row = rows?.find((v) => v.versionId === String(now.mtime));
  return new WsError("changed_since", message, { modified: now.modified, modified_by_label: row?.label || null });
}

const mayLabel = (row) => !row.label || CROW_LABEL_RE.test(row.label);
const tryLabel = (cfg, fileId, versionId, text) => labelVersion(cfg, fileId, versionId, clip(text, 120)).then(() => true, () => false);

/**
 * Label the before/after versions and build the result. `afterIsOurs(after)` says whether the current file is
 * still what THIS write produced (PUT etag, or the restored revision's mtime); if not, the after row belongs to
 * someone else's later write and is never labelled. If the version list cannot be read, nothing is labelled
 * (a row might carry a person's label we cannot see).
 */
async function finish(cfg, segs, fileId, beforeVersion, out, label, clock, { putEtag = "", afterIsOurs } = {}) {
  lastWriteOf(clock).set(fileId, clock.now());
  const after = await stat(cfg, segs);
  const ours = afterIsOurs ? afterIsOurs(after) : true;
  // Review C2: the after-etag is the one THIS write produced (the PUT's own ETag). A restore has none: if someone
  // else already saved on top, a token would carry THEIR etag, so none is issued (version_id null). A PUT keeps its
  // honest token (undo then refuses with changed_since). Either way the result says why.
  const afterEtag = putEtag || after.etag;
  const issueToken = ours || !!putEtag;
  const summary = clip(out.summary || "edit", 100);
  const rows = await listVersions(cfg, fileId).catch(() => null);
  let okB = true, okA = true;
  if (!rows) { okB = false; okA = false; }
  else {
    // Review I9: never overwrite a label a person gave a version; only fill empty or Crow-written ones.
    const before = beforeVersion === "0" ? null : rows.find((v) => v.versionId === beforeVersion);
    if (before && mayLabel(before)) okB = await tryLabel(cfg, fileId, beforeVersion, `Before ${label}: ${summary}`);
    // Review r2: after a restore, after.mtime IS the restored revision's existing row; apply the same rule.
    const afterRow = rows.find((v) => v.versionId === String(after.mtime));
    if (!ours) okA = false;
    else if (!afterRow || mayLabel(afterRow)) okA = await tryLabel(cfg, fileId, String(after.mtime), `${label}: ${summary}`);
  }
  return {
    ...(out.data || {}), path: after.path, file_id: fileId, changed: out.changed,
    version_id: issueToken ? encodeVersionId({ f: fileId, b: beforeVersion, a: afterEtag }) : null, version_label: `${label}: ${summary}`,
    ...(!ours ? { label_warning: "Saved, but someone else saved the file right after, so this change cannot be undone automatically. Use ws_drive_list_versions and ws_drive_restore_version if needed." }
      : okA && okB ? {} : { label_warning: "Saved, but Workspace did not accept the version label." }),
  };
}

const putEtagOf = (res) => normEtag(res.headers.get("oc-etag") || res.headers.get("etag") || "");
const queueOrThrow = (sig, queue) => { if (sig instanceof QueueSignal) return queue.enqueue(sig); throw sig; };

/**
 * Spec §5 step 6: a 423 goes back to the lock check. The first retry uses the caller's wait; a second 423 (the lock
 * re-appeared after that retry) goes back once more with no wait — "queue" still queues, and if the lock has
 * already cleared the write simply proceeds. Never a second drop (allowDrop). A third 423 gives up.
 */
const MAX_423_RETRIES = 2;
const lockedOut = () => new WsError("locked", "The file keeps getting locked; nothing was changed. Try again shortly.");

export async function withFileWrite(cfg, ref, mutate, { waitS: waitS0 = 0, ifOpen = "queue", label = "Crow", clock = systemClock, queue = null } = {}) {
  const { segs, e0 } = await guard(cfg, ref);
  return serialized(e0.fileId, async () => {
    let dropped = false, retried412 = false, n423 = 0, waitS = waitS0;
    for (;;) {
      let e;
      // Spec §5 step 6: a 423 retry goes back to the lock check with the caller's if_open unchanged
      // (queue by default); the only thing it may not do is drop the editor a second time.
      try { const s = await settleLock(cfg, segs, { waitS, ifOpen, clock, queue, allowDrop: !dropped }); e = s.e; dropped ||= s.dropped; }
      catch (sig) { return queueOrThrow(sig, queue); }
      await spacing(e.fileId, clock);
      const read = () => getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
      const cur = await settleMtime(await read(), read, clock, { ifMatchGuarded: true });
      const out = await mutate(cur.bytes, e);
      if (!out || !out.changed) return { ...(out?.data || {}), path: e.path, file_id: e.fileId, changed: 0, version_id: null };
      const res = await putFile(cfg, segs, out.bytes, { ifMatch: cur.etag });
      if (res.status === 412) { if (!retried412) { retried412 = true; continue; } throw new WsError("changed_concurrently", `Someone else saved "${e.name}" at the same moment. Read it again and retry.`); }
      if (res.status === 423) { if (++n423 > MAX_423_RETRIES) throw lockedOut(); if (n423 === 2) waitS = 0; continue; }
      if (!res.ok) throw httpFail(res, "save the change");
      const putEtag = putEtagOf(res);
      return finish(cfg, segs, e.fileId, String(cur.mtime), out, label, clock, { putEtag, afterIsOurs: (a) => !putEtag || normEtag(a.etag) === putEtag });
    }
  });
}

export async function withFileRestore(cfg, ref, versionId, { waitS: waitS0 = 0, ifOpen = "queue", label = "Crow", summary = "restore", clock = systemClock, expectEtag = null, queue = null } = {}) {
  const { segs, e0 } = await guard(cfg, ref);
  return serialized(e0.fileId, async () => {
    let dropped = false, n423 = 0, waitS = waitS0;
    for (;;) {
      // NOTE (review C4b): a restore touches the file back to the revision's mtime, so after a restore the
      // "current" version id equals the restored revision's id. finish() then labels that row "Undo: …"
      // (unless a person labelled it), the intended reading in the version sidebar.
      let e;
      try { const s = await settleLock(cfg, segs, { waitS, ifOpen, clock, queue, allowDrop: !dropped }); e = s.e; dropped ||= s.dropped; }
      catch (sig) { return queueOrThrow(sig, queue); }
      await spacing(e.fileId, clock);
      // Review I4: the entry used for the undo token's "before" and for the etag re-check is the one read
      // AFTER the gap, never one from before the sleep.
      const read = () => stat(cfg, segs);
      const now = await settleMtime(await read(), read, clock, { ifMatchGuarded: false });
      // Review C3: re-check AFTER the lock settled (a force_close drop saves the person's typing, which
      // changes the etag). Undo must never restore over work that landed after the Crow edit.
      if (expectEtag !== null && normEtag(now.etag) !== expectEtag) throw await changedSince(cfg, now, `"${now.name}" changed after that edit (last modified ${now.modified}); nothing was undone. Use ws_drive_list_versions and ws_drive_restore_version to choose explicitly.`);
      const res = await restoreVersion(cfg, now.fileId, versionId);
      if (res.status === 423) { if (++n423 > MAX_423_RETRIES) throw lockedOut(); if (n423 === 2) waitS = 0; continue; }
      if (![201, 204].includes(res.status)) throw httpFail(res, "restore that version");
      // A restore touches the file back to the revision's mtime; any other mtime means someone wrote after it.
      return finish(cfg, segs, now.fileId, String(now.mtime), { changed: 1, summary }, label, clock, { afterIsOurs: (a) => String(a.mtime) === String(versionId) });
    }
  });
}

/** A NEW file (If-None-Match: *), version_id with before = "0" (undo moves it to the trash). */
export async function createFile(cfg, folderSegs, name, bytes, { label = "Crow", summary = "create", clock = systemClock, contentType } = {}) {
  const segs = [...folderSegs, name];
  const res = await putFile(cfg, segs, bytes, { ifNoneMatch: "*", contentType });
  if (res.status === 412) throw new WsError("exists", `"${joinPath(segs)}" already exists`);
  if (![201, 204].includes(res.status)) throw httpFail(res, "create the file");
  const e = await stat(cfg, segs);
  const putEtag = putEtagOf(res);
  return finish(cfg, segs, e.fileId, "0", { changed: 1, summary }, label, clock, { putEtag, afterIsOurs: (a) => !putEtag || normEtag(a.etag) === putEtag });
}

export async function undoFileChange(cfg, ref, versionId, { waitS = 0, ifOpen = "queue", clock = systemClock, queue = null } = {}) {
  const v = decodeVersionId(versionId);
  // Review I7: version_ids are unsigned, so the target is validated like any write (a file, writable) — a forged
  // {f:<folder id>, b:"0"} must never reach DELETE.
  const { segs, e0: e } = await guard(cfg, ref);
  if (e.fileId !== v.f) throw new WsError("bad_version_id", "That version_id belongs to a different file.");
  if (normEtag(e.etag) !== v.a) throw await changedSince(cfg, e, `"${e.name}" changed after that edit (last modified ${e.modified}). Nothing was undone. To go back anyway, use ws_drive_list_versions and ws_drive_restore_version.`);
  if (v.b === "0") {
    await refuseShareRoot(cfg, segs, e);
    // F12: the created-file branch follows the same K5 rules as every write (queue by default, wait 0).
    return serialized(e.fileId, async () => {
      try { await settleLock(cfg, segs, { waitS, ifOpen, clock, queue }); }
      catch (sig) { return queueOrThrow(sig, queue); }
      const now = await stat(cfg, segs); // review C3: re-check after the lock settled
      if (normEtag(now.etag) !== v.a) throw await changedSince(cfg, now, `"${now.name}" was changed after Crow created it; it was not removed.`);
      await remove(cfg, segs);
      return { path: e.path, file_id: e.fileId, undone: "The file Crow created was moved to the Workspace trash." };
    });
  }
  if (!(await listVersions(cfg, v.f)).some((x) => x.versionId === v.b)) throw new WsError("version_gone", "Workspace no longer keeps the version from before that edit, so it cannot be undone automatically.");
  return withFileRestore(cfg, segs, v.b, { waitS, ifOpen, clock, queue, label: "Undo", summary: "undo of a Crow edit", expectEtag: v.a });
}
