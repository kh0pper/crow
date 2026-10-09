// Crow Artifacts — artifacts, immutable versions, access and audit
// (spec §4.1–§4.3, §7.1, §7.4).
//
// Actors (resolved by mcp.js / the panel routes, never from user input):
//   { kind: "session" }            the operator (dashboard session or full local token)
//   { kind: "bot", id, thread, gateway }   a bot with a VERIFIED signature
//   { kind: "unattributed" }       anything else: sees nothing (fail closed)
import { randomBytes, createHash } from "node:crypto";
import { LIMITS } from "./limits.js";
import { renderVersion } from "./render.js";
import { appImport } from "./app-root.js";
// R2-H2: the OS-released cross-process lock (servers/shared/sqlite-lock.js).
const { withSqliteLock } = await appImport("servers/shared/sqlite-lock.js");

const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});
const now = () => Date.now();

export function newArtifactId() { return "art_" + randomBytes(9).toString("base64url"); }

export async function audit(db, { artifactId = null, actor, action, target = null, detail = null }) {
  await db.execute({
    sql: "INSERT INTO artifact_audit (artifact_id, actor_kind, actor_id, action, target, detail_json) VALUES (?,?,?,?,?,?)",
    args: [artifactId, actor?.kind || "system", actor?.id || null, action, target, detail == null ? null : JSON.stringify(detail).slice(0, 4000)],
  });
}

export async function getArtifact(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM artifacts WHERE id=? AND deleted_at IS NULL", args: [String(id)] });
  return rows[0] || null;
}

/** H6: operator sees everything; a verified bot sees what it made or what was
 *  explicitly shared with it, never received artifacts; nobody else sees anything. */
export async function canAccess(db, actor, art) {
  if (!art || !actor) return false;
  if (actor.kind === "session") return true;
  if (actor.kind !== "bot" || !actor.id) return false;
  if (flagUntrusted(art.received)) return false;   // received, or unknown → no bot access
  if (art.created_by_bot === actor.id) return true;
  const { rows } = await db.execute({ sql: "SELECT 1 FROM artifact_bot_access WHERE artifact_id=? AND bot_id=?", args: [art.id, actor.id] });
  return rows.length > 0;
}

export async function requireAccess(db, actor, id) {
  const art = await getArtifact(db, id);
  // Same answer for "missing" and "not yours": no existence oracle.
  if (!art || !(await canAccess(db, actor, art))) throw err("not_found", "no such artifact");
  return art;
}

export async function listArtifacts(db, actor, { limit = 50 } = {}) {
  if (actor?.kind === "session") {
    return (await db.execute({ sql: "SELECT * FROM artifacts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?", args: [limit] })).rows;
  }
  if (actor?.kind !== "bot" || !actor.id) return [];
  return (await db.execute({
    sql: "SELECT * FROM artifacts WHERE deleted_at IS NULL AND received=0 AND (created_by_bot=? OR id IN (SELECT artifact_id FROM artifact_bot_access WHERE bot_id=?)) ORDER BY updated_at DESC LIMIT ?",
    args: [actor.id, actor.id, limit],
  })).rows;
}

/**
 * One writer at a time per process (spec §4.3 quota): the quota check, the
 * blob writes and the version row happen inside this lock, so two concurrent
 * writes cannot both pass a check meant for one. The MCP mount and the panel
 * routes live in the same gateway process and share this module.
 */
let chain = Promise.resolve();
export function withWriteLock(fn, blobs = null) {
  const inner = blobs && blobs.lockPath ? () => withSqliteLock(blobs.lockPath, fn) : fn;
  const run = chain.then(inner, inner);
  chain = run.catch(() => {});
  return run;
}

/** REAL usage: bytes of objects on disk (decoded, deduplicated, every version,
 *  orphans included until GC) plus the source copies held in the DB. Never a
 *  size a client declared. */
export async function instanceUsage(db, blobs) {
  const src = Number((await db.execute({ sql: "SELECT COALESCE(SUM(length(CAST(source_json AS BLOB))),0) AS n FROM artifact_versions", args: [] })).rows[0].n);
  return (blobs ? await blobs.usage() : 0) + src;
}

/** Plan the files WITHOUT writing: keys, sizes, and how many bytes are new. */
async function planFiles(blobs, files, sourceJson) {
  if (files.length > LIMITS.filesPerVersion) throw err("too_many_files", `over ${LIMITS.filesPerVersion} files`);
  const size = files.reduce((n, f) => n + f.body.length, 0) + Buffer.byteLength(sourceJson);
  if (size > LIMITS.versionBytes) throw err("too_large", `version is ${size} bytes; the cap is ${LIMITS.versionBytes}`);
  const manifest = files.map((f) => ({ path: f.path, key: blobs.keyOf(f.body), contentType: f.contentType, size: f.body.length, body: f.body }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const seen = new Set();
  let newBytes = Buffer.byteLength(sourceJson);
  for (const m of manifest) if (!seen.has(m.key) && !(await blobs.has(m.key))) { seen.add(m.key); newBytes += m.size; }
  const contentHash = createHash("sha256").update(JSON.stringify(manifest.map((m) => [m.path, m.key, m.contentType]))).digest("hex");
  return { manifest, size, newBytes, contentHash };
}
async function writePlanned(blobs, plan, db) {
  // R3-M3: never write into a store that is not this database's (first use
  // of an empty store claims it).
  if (db) { const m = await storeMatches(db, blobs); if (!m.ok) throw err("store_mismatch", `artifact store does not belong to this database: ${m.reason}`); }
  for (const m of plan.manifest) await blobs.put(m.body);
  return plan.manifest.map(({ body, ...rest }) => rest);
}

/** Every object key any version row references. */
async function liveKeys(db) {
  const { rows } = await db.execute({ sql: "SELECT files_json FROM artifact_versions", args: [] });
  const live = new Set();
  for (const r of rows) for (const f of JSON.parse(r.files_json)) live.add(f.key);
  return { live, rows: rows.length };
}

/**
 * R3-M3: is this blob store the one this DB describes? The DB holds a
 * store_id (artifact_store_meta); the store holds a marker file. A missing
 * marker is written only when the store is EMPTY (first use). Anything else —
 * no DB id, a different marker, a marker-less store that already has objects —
 * is a mismatch, and nothing is deleted.
 */
export async function storeMatches(db, blobs) {
  const r = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [] })).rows[0];
  const dbId = r && r.value;
  if (!dbId || !blobs.readMarker) return { ok: false, reason: "no store id" };
  const marker = await blobs.readMarker();
  if (!marker) {
    if ((await blobs.keys()).length) return { ok: false, reason: "store has objects but no marker" };
    try { await blobs.writeMarker(dbId); } catch { return { ok: false, reason: "marker write failed" }; }
    return { ok: true };
  }
  return marker === dbId ? { ok: true } : { ok: false, reason: "marker does not match this database" };
}

/** Targeted: delete exactly these keys if no version references them now
 *  (after a prune, a drop or a failed insert released them). */
export async function gcKeys(db, blobs, keys) {
  if (!keys || !keys.length) return 0;
  if (!(await storeMatches(db, blobs)).ok) return 0;
  const { live } = await liveKeys(db);
  let n = 0;
  for (const k of new Set(keys)) if (!live.has(k)) { await blobs.del(k); n++; }
  return n;
}

/**
 * Full reclaim of unreferenced objects (the sweep). Refuses — deleting
 * nothing and reporting why — when the store does not match the DB, when the
 * DB has no versions but the store has objects, or when the dry-run count
 * looks like a mismatch (more than `maxOrphans`, or more than `maxFraction`
 * of a store of at least 20 objects). Objects younger than `minAgeMs` are
 * never deleted.
 */
export async function gcBlobs(db, blobs, { minAgeMs = 10 * 60 * 1000, maxOrphans = 200, maxFraction = 0.5, now = Date.now(), log = (m) => console.warn(m) } = {}) {
  const match = await storeMatches(db, blobs);
  if (!match.ok) { log(`[artifacts] reclaim refused: ${match.reason}`); return { deleted: 0, refused: match.reason }; }
  const { live, rows } = await liveKeys(db);
  const all = await blobs.keys();
  if (rows === 0 && all.length) { log("[artifacts] reclaim refused: the database has no versions but the store has objects"); return { deleted: 0, refused: "empty database" }; }
  const orphans = [];
  for (const k of all) if (!live.has(k)) { const m = await blobs.mtimeOf(k); if (m != null && now - m >= minAgeMs) orphans.push(k); }
  if (orphans.length > maxOrphans || (all.length >= 20 && orphans.length > maxFraction * all.length)) {
    log(`[artifacts] reclaim refused: ${orphans.length} of ${all.length} objects look orphaned — a store/database mismatch is more likely than real orphans`);
    return { deleted: 0, refused: "too many orphans", count: orphans.length };
  }
  if (orphans.length) log(`[artifacts] reclaim: deleting ${orphans.length} unreferenced object(s)`);
  for (const k of orphans) await blobs.del(k);
  return { deleted: orphans.length };
}

/**
 * R2-M2: crash-safe accounting. Under the write lock: delete objects no
 * version references (stored before a crash, never recorded) and temp files
 * older than `tmpMaxAgeMs` (a crash inside put()). Run at mount start and by
 * the sweep. Nothing a live writer holds can be touched: writers hold the lock.
 */
export async function reconcileBlobs(db, blobs, { tmpMaxAgeMs = 5 * 60 * 1000, now = Date.now(), ...gc } = {}) {
  return withWriteLock(async () => {
    const g = await gcBlobs(db, blobs, { now, ...gc });
    const objects = g.deleted;
    if (g.refused) return { objects: 0, temps: 0, refused: g.refused };
    let temps = 0;
    if (blobs.tmpFiles) for (const f of await blobs.tmpFiles()) if (now - f.mtimeMs > tmpMaxAgeMs) { await blobs.delTmp(f.name); temps++; }
    return { objects, temps };
  }, blobs);
}

/** §4.3: a full quota BLOCKS (never deletes) and says what holds the space. */
async function assertQuota(db, blobs, extra) {
  const used = await instanceUsage(db, blobs);
  if (used + extra <= LIMITS.instanceBytes) return;
  const { rows } = await db.execute({ sql: "SELECT id, title, published_version FROM artifacts WHERE deleted_at IS NULL AND published_version IS NOT NULL", args: [] });
  throw err("quota_full", `artifact storage is full (${used} of ${LIMITS.instanceBytes} bytes)`, { holders: rows.map((r) => ({ id: r.id, title: r.title, published_version: r.published_version })) });
}

export async function createArtifact(db, blobs, { title, type, source, actor, changeNote = null, origin = {}, untrusted = false }, deps = {}) {
  if (!actor || (actor.kind !== "session" && !(actor.kind === "bot" && actor.id))) throw err("forbidden", "an attributed caller is required");
  const t = String(title || "").trim().slice(0, LIMITS.titleChars);
  if (!t) throw err("bad_request", "title required");
  const rendered = await renderVersion(type, source, deps);
  const sourceJson = JSON.stringify(source);
  return withWriteLock(async () => {
  const plan = await planFiles(blobs, rendered.files, sourceJson);
  await assertQuota(db, blobs, plan.newBytes);
  const manifest = await writePlanned(blobs, plan, db);
  const { size, contentHash } = plan;
  const id = newArtifactId();
  const bot = actor.kind === "bot" ? actor.id : null;
  try { await db.batch([
    { sql: "INSERT INTO artifacts (id,title,type,created_by_bot,origin_session,origin_card,current_version,title_tainted,received) VALUES (?,?,?,?,?,?,1,?,0)", args: [id, t, type, bot, origin.session || actor.thread || null, origin.card || null, untrusted ? 1 : 0] },
    { sql: "INSERT INTO artifact_versions (artifact_id,n,state,files_json,source_json,size,content_hash,made_by,made_by_bot,change_note,anchor_map_json,untrusted_input) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [id, 1, "current", JSON.stringify(manifest), sourceJson, size, contentHash, bot ? "bot" : "user", bot, changeNote ? String(changeNote).slice(0, LIMITS.changeNoteChars) : null, rendered.anchorMap ? JSON.stringify(rendered.anchorMap) : null, untrusted ? 1 : 0] },
  ]); } catch (e) { await gcKeys(db, blobs, manifest.map((m) => m.key)); throw e; }
  await audit(db, { artifactId: id, actor, action: "create", target: "v1" });
  return { id, versionN: 1 };
  }, blobs);
}

/** Tainted = made from non-owner text (or derived from such a version) and
 *  not yet approved by the owner. */
/** A trust flag is CLEAN only when it is exactly 0; NULL, missing, corrupt or
 *  any other value reads as untrusted (security review: no NULL-as-clean). */
export function flagUntrusted(x) { return x == null || x === "" || Number(x) !== 0; }
export function isTainted(v) { return !v || (flagUntrusted(v.untrusted_input) && !v.trust_cleared_at); }

/** The owner's explicit approval (the Publish/approve action): the ONLY thing
 *  that clears taint. Audited. */
export async function approveVersion(db, { artifactId, n, actor }) {
  if (actor?.kind !== "session") throw err("forbidden", "only the owner approves a version");
  const r = await db.execute({ sql: "UPDATE artifact_versions SET trust_cleared_at=datetime('now') WHERE artifact_id=? AND n=? AND (untrusted_input IS NULL OR untrusted_input<>0) AND trust_cleared_at IS NULL", args: [artifactId, Number(n)] });
  if (Number(r.rowsAffected) === 1) await audit(db, { artifactId, actor, action: "approve", target: `v${n}` });
  if (Number(n) === 1) await db.execute({ sql: "UPDATE artifacts SET title_tainted=0 WHERE id=?", args: [artifactId] });
  return { approved: Number(r.rowsAffected) === 1 };
}

/**
 * A new version (§4.2, §7.4). Compare-and-set: when `baseVersion` is given and
 * the artifact's current version has moved, the result is stored PROPOSED and
 * the owner chooses. `untrusted` marks a version made by a round that held
 * non-owner text (§7.3). A version appears only once all its files are stored.
 */
export async function addVersion(db, blobs, { artifactId, source, actor, baseVersion = null, roundId = null, madeBy = null, changeNote = null, untrusted = false, proposedReason = null }, deps = {}) {
  const art = await requireAccess(db, actor, artifactId);
  if (flagUntrusted(art.received)) throw err("forbidden", "a received artifact cannot be edited");
  const rendered = await renderVersion(art.type, source, deps);
  const sourceJson = JSON.stringify(source);
  const bot = actor.kind === "bot" ? actor.id : null;
  return withWriteLock(async () => {
  const plan = await planFiles(blobs, rendered.files, sourceJson);
  await assertQuota(db, blobs, plan.newBytes);
  const manifest = await writePlanned(blobs, plan, db);
  const { size, contentHash } = plan;
  // Number and CAS inside one transaction (better-sqlite3 batch).
  for (let attempt = 0; attempt < 3; attempt++) {
    const { rows } = await db.execute({ sql: "SELECT COALESCE(MAX(n),0)+1 AS n, (SELECT current_version FROM artifacts WHERE id=?) AS cur FROM artifact_versions WHERE artifact_id=?", args: [artifactId, artifactId] });
    const n = Number(rows[0].n), cur = Number(rows[0].cur);
    const stale = baseVersion != null && Number(baseVersion) !== cur;
    const state = stale || proposedReason ? "proposed" : "current";
    // Taint is INHERITED (§7.3): a version derived from a tainted one — by a
    // later round, an owner edit, a hand-off, a revert — stays tainted until
    // the owner approves it. Both the declared base and the current version
    // count, since the author may have read either.
    const derivedFrom = baseVersion != null ? Number(baseVersion) : cur;
    const parents = (await db.execute({ sql: "SELECT untrusted_input, trust_cleared_at FROM artifact_versions WHERE artifact_id=? AND n IN (?,?)", args: [artifactId, derivedFrom, cur] })).rows;
    const tainted = untrusted || parents.some(isTainted);
    const stmts = [
      { sql: "INSERT INTO artifact_versions (artifact_id,n,state,files_json,source_json,size,content_hash,made_by,made_by_bot,round_id,untrusted_input,derived_from,change_note,anchor_map_json,proposed_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [artifactId, n, state, JSON.stringify(manifest), sourceJson, size, contentHash, madeBy || (bot ? "bot" : "user"), bot, roundId, tainted ? 1 : 0, derivedFrom, changeNote ? String(changeNote).slice(0, LIMITS.changeNoteChars) : null, rendered.anchorMap ? JSON.stringify(rendered.anchorMap) : null, stale ? "base_moved" : proposedReason] },
    ];
    if (state === "current") {
      stmts.push({ sql: "UPDATE artifact_versions SET state='past' WHERE artifact_id=? AND n=? AND state='current'", args: [artifactId, cur] });
      // The CAS: only moves when current is still what we read.
      stmts.push({ sql: "UPDATE artifacts SET current_version=?, updated_at=datetime('now') WHERE id=? AND current_version=?", args: [n, artifactId, cur] });
    }
    try {
      const res = await db.batch(stmts);
      if (state === "current" && Number(res.at(-1).rowsAffected) !== 1) throw err("cas_lost");
      await audit(db, { artifactId, actor, action: state === "current" ? "version" : "version-proposed", target: `v${n}`, detail: { base: baseVersion, roundId, untrusted: tainted } });
      const pruned = await prune(db, artifactId);
      if (pruned.keys.length) await gcKeys(db, blobs, pruned.keys);
      return { n, state, anchorMap: rendered.anchorMap, untrusted: tainted };
    } catch (e) {
      if (attempt < 2 && (e.code === "cas_lost" || /UNIQUE|PRIMARY KEY/.test(String(e.message)))) continue;
      await gcKeys(db, blobs, manifest.map((m) => m.key));
      throw e;
    }
  }
  await gcKeys(db, blobs, manifest.map((m) => m.key));
  throw err("busy", "could not store the version");
  }, blobs);
}

/** The owner makes a proposed version current (or drops it). */
export async function decideProposed(db, { artifactId, n, accept, actor, blobs = null }) {
  if (actor?.kind !== "session") throw err("forbidden", "only the owner decides proposed versions");
  const { rows } = await db.execute({ sql: "SELECT state FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, n] });
  if (!rows[0] || rows[0].state !== "proposed") throw err("not_found", "no such proposed version");
  if (!accept) {
    const files = JSON.parse((await db.execute({ sql: "SELECT files_json FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, n] })).rows[0].files_json);
    await db.execute({ sql: "DELETE FROM artifact_versions WHERE artifact_id=? AND n=? AND state='proposed'", args: [artifactId, n] });
    if (blobs) await withWriteLock(() => gcKeys(db, blobs, files.map((f) => f.key)), blobs);
    await audit(db, { artifactId, actor, action: "proposed-dropped", target: `v${n}` });
    return { dropped: true };
  }
  await db.batch([
    { sql: "UPDATE artifact_versions SET state='past' WHERE artifact_id=? AND state='current'", args: [artifactId] },
    { sql: "UPDATE artifact_versions SET state='current' WHERE artifact_id=? AND n=?", args: [artifactId, n] },
    { sql: "UPDATE artifacts SET current_version=?, updated_at=datetime('now') WHERE id=?", args: [n, artifactId] },
  ]);
  await audit(db, { artifactId, actor, action: "proposed-accepted", target: `v${n}` });
  return { current: n };
}

/** §4.3 pruning: keep the last N versions; never current, published, proposed
 *  (the owner has not decided), flagged, or the base of an active round. */
export async function prune(db, artifactId) {
  const { rows } = await db.execute({
    sql: `SELECT v.n FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id
          WHERE v.artifact_id=? AND v.state='past' AND v.flagged_reason IS NULL
            AND (a.published_version IS NULL OR a.published_version<>v.n)
            AND v.n NOT IN (SELECT base_version FROM artifact_rounds WHERE artifact_id=? AND status IN ('queued','pending','delivering','working'))
          ORDER BY v.n DESC`,
    args: [artifactId, artifactId],
  });
  const total = Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_versions WHERE artifact_id=?", args: [artifactId] })).rows[0].c);
  const excess = total - LIMITS.versionsKept;
  if (excess <= 0) return { victims: [], keys: [] };
  const victims = rows.slice(-excess).map((r) => Number(r.n));
  const keys = [];
  for (const n of victims) {
    const v = (await db.execute({ sql: "SELECT files_json FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, n] })).rows[0];
    if (v) for (const f of JSON.parse(v.files_json)) keys.push(f.key);
    await db.execute({ sql: "DELETE FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, n] });
  }
  return { victims, keys };
}

export async function getVersion(db, artifactId, n) {
  const { rows } = await db.execute({ sql: "SELECT * FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, Number(n)] });
  return rows[0] || null;
}

/** The artifact origin's content provider (core server.js resolveContent). */
export function contentResolver(db, blobs) {
  return async ({ artifactId, versionN, path }) => {
    const v = await getVersion(db, artifactId, versionN);
    if (!v || v.flagged_reason) return null;
    const f = JSON.parse(v.files_json).find((x) => x.path === path);
    if (!f) return null;
    const body = await blobs.get(f.key);
    return body ? { body, contentType: f.contentType } : null;
  };
}

/** §5.1 tripwire: the version tried to leave its frame. */
export async function flagVersion(db, { artifactId, n, reason, actor }) {
  await db.execute({ sql: "UPDATE artifact_versions SET flagged_reason=? WHERE artifact_id=? AND n=? AND flagged_reason IS NULL", args: [String(reason).slice(0, 64), artifactId, Number(n)] });
  await audit(db, { artifactId, actor, action: "tripwire", target: `v${n}`, detail: { reason } });
}
