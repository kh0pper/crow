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

let _mgrMod = null;
let _testSink = null;

/** Test seam: inject a spy sink ({ emitChange }), or null to reset. */
export function __setEmitSinkForTest(sink) { _testSink = sink; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

export async function emitContactChange(op, row) {
  try { (await sink())?.emitChange("contacts", op, row); } catch { /* never throw */ }
}

export async function emitContactDelete(crowId) {
  if (!crowId) return;
  try { (await sink())?.emitChange("contacts", "delete", { crow_id: crowId }); } catch { /* never throw */ }
}
