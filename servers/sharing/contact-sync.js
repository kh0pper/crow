/**
 * Phase 3 (D1): push contact mutations onto the instance-sync mesh.
 * Guarded + null-safe — a sync failure never breaks the local write, and the
 * sink is null pre-boot / in unit tests (no-op). Emits carry the FULL row for
 * insert/update; deletes carry only { crow_id } (the natural key). Carve-outs
 * (verified/last_seen/id/created_at columns, local-bot/pending rows) are
 * enforced downstream by EXCLUDED_COLUMNS.contacts + shouldSyncRow in
 * instance-sync.js.
 *
 * NOTE (R1): managers.js → nostr.js → contact-promote.js → contact-sync.js would
 * form an import cycle if we STATIC-imported managers here. A cached lazy dynamic
 * import keeps the static module graph acyclic; the import resolves once, before
 * any emit fires at runtime. Do NOT "simplify" this to a static import.
 */

import { writeTombstone } from "./contact-delete.js";
import { emitOrQueue } from "../shared/sync-emit.js";

let _mgrMod = null;
let _testSink = null;
let _testDb = null;

/**
 * Test seam: inject a spy sink ({ emitChange }), or null to reset. `db` is an
 * optional second arg — only needed by tests exercising the null-branch queue
 * path (emitContactChange has no db param of its own; production sources it
 * from the same shared-managers singleton `sink()` already reads).
 */
export function __setEmitSinkForTest(sink, db = null) { _testSink = sink; _testDb = db; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

/** The db to queue against when there's no live manager — test override, else the shared singleton's db (production; always constructed by the time a sharing entrypoint runs a tool). */
async function emitDb() {
  if (_testDb) return _testDb;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getManagersOrNull?.()?.db || null;
}

/** @returns {Promise<number|null|undefined>} the emitted lamport, or nullish when suppressed. */
export async function emitContactChange(op, row) {
  return await emitOrQueue(await sink(), await emitDb(), "contacts", op, row);
}

/**
 * Emit a contact delete AND write the local tombstone — the single home for the
 * originating instance's tombstone write (design §4.1, D3.3). The tombstone is
 * written at the emitted lamport, or at `fallbackLamportTs` when the emit was
 * suppressed (nullish return: feeds disabled / not synced / row not syncable).
 * Skipped entirely for `req:` ids (those rows never sync). Never throws.
 * @param {object} db async db client
 * @param {string} crowId
 * @param {number} fallbackLamportTs the row's own lamport_ts, used when no delete broadcast
 */
export async function emitContactDelete(db, crowId, fallbackLamportTs) {
  if (!crowId || crowId.startsWith("req:")) return;
  const result = await emitOrQueue(await sink(), db, "contacts", "delete", { crow_id: crowId });
  const lamport = result && typeof result === "object" ? result.lamport : result;
  await writeTombstone(db, crowId, lamport ?? fallbackLamportTs);
}
