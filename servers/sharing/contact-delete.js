/**
 * Contact deletion primitives — tombstones (F-CONTACT-1, design §D3).
 *
 * Pure DB helpers with ZERO imports from the sharing layer. contact-sync.js
 * imports this module, and contact-sync.js is itself imported by
 * contact-promote.js (which is on the managers.js → nostr.js import chain), so
 * any sharing-side import here would risk the very cycle the lazy dynamic import
 * in contact-sync.js exists to avoid. Keep this module dependency-free.
 *
 * Tombstones are LOCAL state, never synced, never pruned (design §D3). They are
 * NEVER written for `req:`-prefixed crow_ids — those rows are per-instance
 * message-request state that never sync. Every helper is guarded (it runs on the
 * receive path and must never throw) and no-ops on a `req:` id.
 */

/** @param {string} id @returns {boolean} true for a per-instance `req:` row. */
function isReqId(id) {
  return typeof id === "string" && id.startsWith("req:");
}

/**
 * UPSERT a tombstone keeping the MAX lamport_ts. deleted_at is set to now (unix
 * seconds) on first write and preserved on conflict. No-op for `req:` ids.
 *
 * `kind` says WHY the contact is gone, and that decides whether the tombstone's
 * lamport is a meaningful bound on an incoming `insert` (see instance-sync.js
 * `_applyContact`):
 *   - `null`    AUTHORITATIVE — a user delete. Its lamport is a GLOBAL emit lamport
 *               (emitContactDelete broadcast it) ⇒ comparable to an insert's ⇒ keeps
 *               the `insert <= tomb.lamport_ts ⇒ drop` stale-replay gate.
 *   - `'prune'` GARBAGE COLLECTION — the advertised-contact prune (2a/F4). It emits
 *               nothing and stamps the tombstone with a LOCAL row lamport ⇒ NOT
 *               comparable across instances ⇒ must not gate inserts on lamport.
 *
 * Precedence on conflict is AUTHORITATIVE-ALWAYS-WINS — the safe, more-restrictive
 * direction. prune+prune ⇒ 'prune'; ANY authoritative delete on either side ⇒ NULL.
 * A GC write must never weaken a real user delete into a permissive gate; the reverse
 * (an authoritative delete strengthening a prune tombstone) is exactly what we want.
 *
 * ⚠️ LAMPORTS ARE COMMENSURABLE ONLY *WITHIN* A KIND — never MAX across them.
 * The two kinds stamp `lamport_ts` from different clocks:
 *   - authoritative → a GLOBAL emit lamport (emitContactDelete broadcast it);
 *   - 'prune'       → the pruned row's LOCAL row lamport (nothing was emitted).
 * `lamport_ts` has exactly ONE consumer — the `insert <= tomb.lamport_ts ⇒ drop`
 * stale-replay gate — and that gate is only meaningful against a global lamport. A
 * blanket `MAX(lamport_ts, excluded.lamport_ts)` on a kind TRANSITION launders the
 * local number into the global field and arms the gate at a value no emitter can
 * exceed: the genuine re-add is dropped, every later `op="update"` from the re-adder is
 * then dropped unconditionally by the same tombstone ⇒ PERMANENT silent divergence,
 * zero `sync_conflicts`. (This is why an authoritative delete emitted at a LOW lamport
 * is not merely a curiosity: `emitContactDelete` sends `{crow_id}` alone — a row with
 * no `lamport_ts` — so emitChange's counter floor never applies to deletes, and a
 * lagging or post-DB-recovery instance really does delete at a low lamport.)
 *
 * So on a transition the SURVIVING kind's OWN lamport wins, and MAX applies only when
 * both sides are the same kind.
 *
 * @param {object} db async db client ({ execute })
 * @param {string} crowId
 * @param {number} lamportTs the delete's Lamport clock
 * @param {"prune"|null} [kind] null (default) = authoritative user delete
 */
/**
 * The tombstone UPSERT as a STATEMENT, so a caller can commit it atomically with other
 * writes via `db.batch()` (which wraps its statements in one transaction). The advertised-
 * contact prune needs exactly that: its DELETE and its tombstone MUST land together, or
 * not at all. See `contact-prune.js` for why neither ordering is safe on its own.
 * Callers using this bypass writeTombstone's `req:` guard — check `isReqId` yourself.
 */
export function tombstoneStatement(crowId, lamportTs, kind = null) {
  return {
    sql: `INSERT INTO contact_tombstones (crow_id, lamport_ts, deleted_at, kind)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(crow_id) DO UPDATE SET
            lamport_ts = CASE
              WHEN contact_tombstones.kind = 'prune' AND excluded.kind IS NULL
                THEN excluded.lamport_ts               -- GC → authoritative: the DELETE's global lamport
              WHEN contact_tombstones.kind IS NULL AND excluded.kind = 'prune'
                THEN contact_tombstones.lamport_ts     -- authoritative → GC: the delete's lamport stands
              ELSE MAX(contact_tombstones.lamport_ts, excluded.lamport_ts) -- same kind ⇒ comparable
            END,
            kind = CASE WHEN contact_tombstones.kind = 'prune' AND excluded.kind = 'prune'
                        THEN 'prune' ELSE NULL END`,
    args: [crowId, Number(lamportTs) || 0, Math.floor(Date.now() / 1000), kind === "prune" ? "prune" : null],
  };
}

export async function writeTombstone(db, crowId, lamportTs, kind = null) {
  if (!db || !crowId || isReqId(crowId)) return;
  try {
    await db.execute(tombstoneStatement(crowId, lamportTs, kind));
  } catch { /* never throw into a receive path */ }
}

/**
 * `kind` is SELECTed deliberately: the apply gate branches on it, and a gate cannot
 * read a column the query never returned. (Omitting it is a SILENT no-op — the gate
 * would see `undefined`, take the authoritative branch, and drop every genuine re-add
 * with no error. This is the same trap that killed design v2.)
 * @param {object} db async db client
 * @param {string} crowId
 * @returns {Promise<{crow_id:string,lamport_ts:number,deleted_at:number,kind:"prune"|null}|null>}
 */
export async function readTombstone(db, crowId) {
  if (!db || !crowId || isReqId(crowId)) return null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT crow_id, lamport_ts, deleted_at, kind FROM contact_tombstones WHERE crow_id = ?`,
      args: [crowId],
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Remove a tombstone (a local re-create supersedes it). No-op for `req:` ids.
 * @param {object} db async db client
 * @param {string} crowId
 */
export async function clearTombstone(db, crowId) {
  if (!db || !crowId || isReqId(crowId)) return;
  try {
    await db.execute({ sql: `DELETE FROM contact_tombstones WHERE crow_id = ?`, args: [crowId] });
  } catch { /* never throw */ }
}

/**
 * Cached lazy dynamic import of contact-sync.js. contact-sync.js STATICALLY
 * imports this module (for writeTombstone), so a static import back here would
 * be a cycle. Resolve it the way the repo already does (see the `_mgrMod` note
 * atop contact-sync.js) — a cached lazy dynamic import. Do NOT simplify to a
 * static import, and keep the tombstone primitives above import-free so
 * contact-sync.js's static import of them stays acyclic.
 */
let _syncMod = null;
async function loadSyncMod() {
  if (!_syncMod) _syncMod = await import("./contact-sync.js");
  return _syncMod;
}

/**
 * Tear down a contact's live wiring BEFORE its row is removed (design §4.1).
 * Each step is independently guarded — the `wireFullContact` convention
 * (contact-promote.js:76). A partial `managers` object (e.g. missing peerManager
 * in tests) must not throw. Load-bearing ordering: unwire runs before the DELETE
 * so an in-flight `subscribeToContact` onevent INSERT against a deleted
 * contact_id cannot raise FOREIGN KEY constraint failed.
 * @param {object} managers { nostrManager?, syncManager?, peerManager? }
 * @param {{id:number, crow_id:string}} row the contact being deleted
 */
export async function unwireContact(managers, row) {
  const { nostrManager, syncManager, peerManager } = managers || {};
  try { if (nostrManager) await nostrManager.unsubscribeFromContact(row.crow_id); } catch { /* guarded */ }
  try { if (syncManager) await syncManager.closeContactFeeds(row.id); } catch { /* guarded */ }
  try { if (peerManager) await peerManager.leaveContact(row.crow_id); } catch { /* guarded */ }
}

/**
 * Read-only blast-radius counts for the delete confirmation (design §2.1, §4.1).
 * Each count is independently guarded: a missing table on an older DB yields 0
 * for that key rather than throwing. `projectMemberships` counts the real
 * `project_members` table (the design's `project_space_members` is a prose
 * misnomer — that table does not exist; its columns match `project_members`).
 * @param {object} db async db client
 * @param {number} contactId
 * @returns {Promise<{messages:number, sharedItems:number, groups:number, projectsOwned:number, projectMemberships:number}>}
 */
export async function deleteContactCascadePreview(db, contactId) {
  const count = async (sql) => {
    try {
      const { rows } = await db.execute({ sql, args: [contactId] });
      return Number(rows?.[0]?.n ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    messages: await count("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?"),
    sharedItems: await count("SELECT COUNT(*) AS n FROM shared_items WHERE contact_id = ?"),
    groups: await count("SELECT COUNT(*) AS n FROM contact_group_members WHERE contact_id = ?"),
    projectsOwned: await count("SELECT COUNT(*) AS n FROM project_spaces WHERE owner_contact_id = ?"),
    projectMemberships: await count("SELECT COUNT(*) AS n FROM project_members WHERE contact_id = ?"),
  };
}

/**
 * Delete a contact locally and durably (design §4.1). Order is LOAD-BEARING:
 *   1. refuse `origin='local-bot'` (this instance recreates those at boot).
 *   2. unwireContact — BEFORE the row is removed (see its note).
 *   3. DELETE FROM contacts — FK ON DELETE CASCADE destroys the DM history.
 *   4. emitContactDelete — broadcasts the delete AND writes the local tombstone
 *      (the single home for the originating tombstone write; do NOT write it here).
 * @param {object} db async db client
 * @param {object} managers { nostrManager?, syncManager?, peerManager? }
 * @param {{id:number, crow_id:string, origin?:string, lamport_ts?:number}} row
 * @returns {Promise<{ok:true} | {ok:false, reason:string}>}
 */
export async function deleteContactLocal(db, managers, row) {
  if (!row || row.id == null) return { ok: false, reason: "no-row" };
  if (row.origin === "local-bot") return { ok: false, reason: "local-bot" };
  await unwireContact(managers, row);
  await db.execute({ sql: `DELETE FROM contacts WHERE id = ?`, args: [row.id] });
  const sync = await loadSyncMod();
  await sync.emitContactDelete(db, row.crow_id, row.lamport_ts);
  return { ok: true };
}
