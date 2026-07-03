/**
 * Short-code single-use ledger (Messages Phase 2 PR2 / C2).
 *
 * Backed by dashboard_settings (key below) — NO schema change. The key is NOT
 * in the instance-sync allowlist, so the ledger is INSTANCE-LOCAL by design:
 * the fleet shares one Nostr identity, so an invite_accepted echo may land on
 * a sibling instance that never saw the inviteId → callers treat "unknown" as
 * fail-open (proceed as a normal invite). That is safe: replaying a captured
 * invite_accepted only re-promotes the same authenticated contact (R4 gate,
 * idempotent). Single-use here is a best-effort EXTRA layer on the generating
 * instance; entropy x scrypt x expiry carry the real MITM defense.
 *
 * TTL is ~72h — far beyond the 10-minute CODE expiry — because PR3 retries
 * invite_accepted for up to ~60h (offline inviter) and a legit late echo must
 * still find its row. The code window is enforced elsewhere (envelope expires).
 */

const KEY = "sharing:shortcode_invites";
export const LEDGER_TTL_MS = 72 * 60 * 60 * 1000;

// inviteId is attacker-controlled (echoed from a NIP-44-decrypted invite_accepted
// payload sent by any authenticated contact). It must never be used to index a
// plain object: an id of "__proto__"/"constructor"/"prototype" would let a
// sender pollute Object.prototype process-wide (CWE-1321). Defense in depth:
// (1) the ledger itself is a null-prototype object below, so even a magic key
// can't resolve onto Object.prototype, and (2) these ids are rejected outright
// before ever touching the ledger.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isValidInviteId(inviteId) {
  return typeof inviteId === "string" && inviteId.length > 0 && !DANGEROUS_KEYS.has(inviteId);
}

async function loadLedger(db) {
  try {
    const res = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [KEY],
    });
    if (!res.rows.length) return Object.create(null);
    const parsed = JSON.parse(res.rows[0].value);
    return parsed && typeof parsed === "object"
      ? Object.assign(Object.create(null), parsed)
      : Object.create(null);
  } catch {
    return Object.create(null); // corrupt/missing → self-heal empty
  }
}

function prune(ledger, now) {
  for (const [id, entry] of Object.entries(ledger)) {
    if (!entry || typeof entry.recordedAt !== "number" || now - entry.recordedAt > LEDGER_TTL_MS) {
      delete ledger[id];
    }
  }
  return ledger;
}

async function saveLedger(db, ledger) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [KEY, JSON.stringify(ledger)],
  });
}

export async function recordShortInvite(db, inviteId, codeExpiresAt) {
  if (!isValidInviteId(inviteId)) return; // bogus/dangerous id: caller bug, not a use case
  const now = Date.now();
  const ledger = prune(await loadLedger(db), now);
  ledger[inviteId] = { state: "outstanding", codeExpiresAt, recordedAt: now };
  await saveLedger(db, ledger);
}

export async function consumeShortInvite(db, inviteId) {
  if (!isValidInviteId(inviteId)) return "unknown"; // never index the ledger with a dangerous key
  const now = Date.now();
  const ledger = prune(await loadLedger(db), now);
  const hasEntry = Object.prototype.hasOwnProperty.call(ledger, inviteId);
  const entry = hasEntry ? ledger[inviteId] : undefined;
  if (!entry) { await saveLedger(db, ledger); return "unknown"; }
  if (entry.state === "consumed") { await saveLedger(db, ledger); return "replayed"; }
  // C1(b): the inviter stops honoring a short code after its 10-min window,
  // even though the ledger row is retained (72h TTL) for replay discrimination.
  if (typeof entry.codeExpiresAt === "number" && now > entry.codeExpiresAt) {
    await saveLedger(db, ledger);
    return "expired";
  }
  entry.state = "consumed";
  await saveLedger(db, ledger);
  return "consumed";
}
