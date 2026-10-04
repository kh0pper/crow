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
/** Labels Crow may (re)write. Any other non-empty label was given by a person and is never overwritten (review I9). */
export const CROW_LABEL_RE = /^(Before )?(Crow|Undo|Quick edit)\b/;

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
 * SERVER's current mtime, not just this process's last write: never PUT until ≥ 1.1 s after the
 * file's current mtime. This also separates an editor's drop-save from the bot write on top of it.
 */
async function mtimeGap(cur, clock) {
  const ageMs = clock.now() - cur.mtime * 1000;
  if (ageMs < WRITE_SPACING_MS) await clock.sleep(WRITE_SPACING_MS - Math.max(0, ageMs));
}

async function guard(cfg, ref) {
  const segs = Array.isArray(ref) ? ref : await resolveRef(cfg, ref);
  const e0 = await stat(cfg, segs);
  if (e0.isFolder) throw new WsError("not_a_file", `"${e0.path}" is a folder`);
  if (!e0.permissions.includes("W")) throw new WsError("read_only", `Crow bot can read "${e0.name}" but was not given edit rights. Ask the owner to share it with edit permission.`);
  return { segs, e0 };
}

const mayLabel = (row) => !!row && (!row.label || CROW_LABEL_RE.test(row.label));

async function finish(cfg, segs, fileId, beforeVersion, out, label, clock, putEtag = "") {
  lastWriteOf(clock).set(fileId, clock.now());
  const after = await stat(cfg, segs);
  const afterEtag = putEtag || after.etag;
  const summary = clip(out.summary || "edit", 100);
  const rows = await listVersions(cfg, fileId).catch(() => []);
  // Review I9: never overwrite a label a person gave a version; only fill empty or Crow-written ones.
  const before = beforeVersion === "0" ? null : rows.find((v) => v.versionId === beforeVersion);
  const okB = !mayLabel(before) ? true : await labelVersion(cfg, fileId, beforeVersion, clip(`Before ${label}: ${summary}`, 120)).then(() => true, () => false);
  // Review r2: after a restore, after.mtime IS the restored revision's existing row; apply the same rule.
  // A row not (yet) listed is labelled: it is the version this write just made.
  const afterRow = rows.find((v) => v.versionId === String(after.mtime));
  const okA = afterRow && !mayLabel(afterRow) ? true : await labelVersion(cfg, fileId, String(after.mtime), clip(`${label}: ${summary}`, 120)).then(() => true, () => false);
  return {
    ...(out.data || {}), path: after.path, file_id: fileId, changed: out.changed,
    version_id: encodeVersionId({ f: fileId, b: beforeVersion, a: afterEtag }), version_label: `${label}: ${summary}`,
    ...(okA && okB ? {} : { label_warning: "Saved, but Workspace did not accept the version label." }),
  };
}

const putEtagOf = (res) => normEtag(res.headers.get("oc-etag") || res.headers.get("etag") || "");

export async function withFileWrite(cfg, ref, mutate, { waitS = 0, ifOpen = "queue", label = "Crow", clock = systemClock, queue = null } = {}) {
  const { segs, e0 } = await guard(cfg, ref);
  return serialized(e0.fileId, async () => {
    let dropped = false;
    for (let attempt = 0; ; attempt++) {
      let e;
      // Spec §5 step 6: a 423 retry goes back to the lock check with the caller's if_open unchanged
      // (queue by default); the only thing it may not do is drop the editor a second time.
      try { const s = await settleLock(cfg, segs, { waitS, ifOpen, clock, queue, allowDrop: !dropped }); e = s.e; dropped ||= s.dropped; }
      catch (sig) { if (sig instanceof QueueSignal) return queue.enqueue(sig); throw sig; }
      await spacing(e.fileId, clock);
      let cur = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
      if (clock.now() - cur.mtime * 1000 < WRITE_SPACING_MS) { await mtimeGap(cur, clock); cur = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES }); }
      const out = await mutate(cur.bytes, e);
      if (!out || !out.changed) return { ...(out?.data || {}), path: e.path, file_id: e.fileId, changed: 0, version_id: null };
      const res = await putFile(cfg, segs, out.bytes, { ifMatch: cur.etag });
      if ((res.status === 412 || res.status === 423) && attempt === 0) continue;
      if (res.status === 412) throw new WsError("changed_concurrently", `Someone else saved "${e.name}" at the same moment. Read it again and retry.`);
      if (res.status === 423) { const again = await stat(cfg, segs); if (again.lock) { const c = await classifyLock(cfg, again); throw new WsError(c.code, c.message, c.data); } throw new WsError("locked", "The file is locked; try again."); }
      if (!res.ok) throw httpFail(res, "save the change");
      // Review C2: the after-etag is the one THIS PUT produced (ETag / OC-ETag header), never a later
      // stat that could include someone else's write; finish() falls back to stat only if both are absent.
      return finish(cfg, segs, e.fileId, String(cur.mtime), out, label, clock, putEtagOf(res));
    }
  });
}

export async function withFileRestore(cfg, ref, versionId, { waitS = 0, ifOpen = "queue", label = "Crow", summary = "restore", clock = systemClock, expectEtag = null, queue = null } = {}) {
  const { segs, e0 } = await guard(cfg, ref);
  return serialized(e0.fileId, async () => {
    let dropped = false;
    for (let attempt = 0; ; attempt++) {
      // NOTE (review C4b): a restore touches the file back to the revision's mtime, so after a restore the
      // "current" version id equals the restored revision's id. finish() then labels that row "Undo: …"
      // (unless a person labelled it), the intended reading in the version sidebar.
      let e;
      try { const s = await settleLock(cfg, segs, { waitS, ifOpen, clock, queue, allowDrop: !dropped }); e = s.e; dropped ||= s.dropped; }
      catch (sig) { if (sig instanceof QueueSignal) return queue.enqueue(sig); throw sig; }
      await spacing(e.fileId, clock);
      await mtimeGap(e, clock);
      // Review C3: re-check AFTER the lock settled (a force_close drop saves the person's typing, which
      // changes the etag). Undo must never restore over work that landed after the Crow edit.
      if (expectEtag !== null) { const now = await stat(cfg, segs); if (normEtag(now.etag) !== expectEtag) throw new WsError("changed_since", `"${now.name}" changed after that edit (last modified ${now.modified}); nothing was undone. Use ws_drive_list_versions and ws_drive_restore_version to choose explicitly.`, { modified: now.modified }); }
      const res = await restoreVersion(cfg, e.fileId, versionId);
      if (res.status === 423 && attempt === 0) continue;
      if (![201, 204].includes(res.status)) throw httpFail(res, "restore that version");
      return finish(cfg, segs, e.fileId, String(e.mtime), { changed: 1, summary }, label, clock);
    }
  });
}

/** A NEW file (If-None-Match: *), version_id with before = "0" (undo moves it to the trash). */
export async function createFile(cfg, folderSegs, name, bytes, { label = "Crow", summary = "create", clock = systemClock } = {}) {
  const segs = [...folderSegs, name];
  const res = await putFile(cfg, segs, bytes, { ifNoneMatch: "*" });
  if (res.status === 412) throw new WsError("exists", `"${joinPath(segs)}" already exists`);
  if (![201, 204].includes(res.status)) throw httpFail(res, "create the file");
  const e = await stat(cfg, segs);
  return finish(cfg, segs, e.fileId, "0", { changed: 1, summary }, label, clock, putEtagOf(res));
}

export async function undoFileChange(cfg, ref, versionId, { waitS = 0, ifOpen = "queue", clock = systemClock, queue = null } = {}) {
  const v = decodeVersionId(versionId);
  const segs = await resolveRef(cfg, ref);
  const e = await stat(cfg, segs);
  if (e.fileId !== v.f) throw new WsError("bad_version_id", "That version_id belongs to a different file.");
  if (normEtag(e.etag) !== v.a) throw new WsError("changed_since", `"${e.name}" changed after that edit (last modified ${e.modified}). Nothing was undone. To go back anyway, use ws_drive_list_versions and ws_drive_restore_version.`, { modified: e.modified });
  if (v.b === "0") {
    // F12: the created-file branch follows the same K5 rules as every write (queue by default, wait 0).
    return serialized(e.fileId, async () => {
      try { await settleLock(cfg, segs, { waitS, ifOpen, clock, queue }); }
      catch (sig) { if (sig instanceof QueueSignal) return queue.enqueue(sig); throw sig; }
      const now = await stat(cfg, segs); // review C3: re-check after the lock settled
      if (normEtag(now.etag) !== v.a) throw new WsError("changed_since", `"${now.name}" was changed after Crow created it; it was not removed.`, { modified: now.modified });
      await remove(cfg, segs);
      return { path: e.path, file_id: e.fileId, undone: "The file Crow created was moved to the Workspace trash." };
    });
  }
  if (!(await listVersions(cfg, v.f)).some((x) => x.versionId === v.b)) throw new WsError("version_gone", "Workspace no longer keeps the version from before that edit, so it cannot be undone automatically.");
  return withFileRestore(cfg, segs, v.b, { waitS, ifOpen, clock, queue, label: "Undo", summary: "undo of a Crow edit", expectEtag: v.a });
}
