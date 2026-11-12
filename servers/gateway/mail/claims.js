/**
 * One account, one instance (RF6): which paired instance holds a mail address.
 *
 * A claim cannot be one shared `dashboard_settings` key per address. Those rows replicate
 * last-writer-wins per key, so two instances claiming the same address would overwrite each other
 * forever — and an equal Lamport timestamp with a different value lets the incoming row win, so the
 * value would flap. Each instance therefore writes only its OWN key,
 * `mail_claim_<address hash>_<instance id>`, and the holder is a pure function of the whole set:
 * earliest `claimedAt`, then the lowest instance id. Every instance computes the same winner from
 * the same rows, so a partition heals to one answer instead of oscillating.
 *
 * A released claim is a tombstone, not a delete: deleting the row would let the next refresh re-emit
 * the old claim, and a peer that had not yet seen the delete could resurrect it. The tombstone keeps
 * the instance id so the row stays that instance's own.
 *
 * What a claim value must never hold: the address itself, a host, a port or a username. Instances
 * carrying the user's mail are not a secret, the mailbox address is. The key carries only the
 * first 32 hex of a sha256 of the lower-cased address (unsalted by design: these rows travel only
 * between a person's own paired instances; an HMAC with a fleet secret is the upgrade if one exists
 * someday), and the value carries an instance id, its display name and a time.
 *
 * Liveness: a claim only counts while its instance is in `crow_instances` with status `active` or
 * `offline` (or is this instance), so a wiped or revoked instance that never got to write a tombstone
 * cannot hold an address forever.
 *
 * Convergence assumes every instance has the same view of live/revoked instances (a full mesh); with
 * different views two instances can both connect an address, and the clock-skew advantage of an
 * earlier `claimedAt` is accepted by design.
 *
 * This module writes through `writeSetting(..., {allowLocalFallback: false})`, so a key that is not
 * in `SYNC_ALLOWLIST` throws `NotSyncable` instead of silently staying local — a claim that does not
 * replicate is worse than a loud failure.
 */
import { createHash } from "node:crypto";
import { MailError } from "./errors.js";
import { readSettings, writeSetting } from "../dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

/** The allowlist prefix in servers/gateway/dashboard/settings/sync-allowlist.js. */
const CLAIM_PREFIX = "mail_claim_";
const HASH_LEN = 32;
const HASH_RE = /^[0-9a-f]{32}$/;
/** Instance ids are 32 hex on a real instance; the shape is loose enough for a test id. */
const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_MAX = 120;
const ADDRESS_MAX = 254;

/* ------------------------------------------------------------------ keys */

function normalizeAddress(address) {
  if (typeof address !== "string") throw new MailError("BAD_INPUT", "address");
  const value = address.trim().toLowerCase();
  if (!value || value.length > ADDRESS_MAX || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new MailError("BAD_INPUT", "address");
  }
  return value;
}

function normalizeInstanceId(instanceId) {
  if (typeof instanceId !== "string" || !INSTANCE_ID_RE.test(instanceId)) {
    throw new MailError("BAD_INPUT", "instance_id");
  }
  return instanceId;
}

/** The instance id to write under: the caller's, or this process's own. */
function resolveInstanceId(instanceId) {
  return normalizeInstanceId(instanceId === undefined || instanceId === null ? getOrCreateLocalInstanceId() : instanceId);
}

/** A display name is shown to the owner inside one fixed sentence, so control characters go. */
function cleanName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, NAME_MAX);
}

/** First 32 hex of sha256 of the lower-cased, trimmed address. */
export function addressHash(address) {
  return createHash("sha256").update(normalizeAddress(address), "utf8").digest("hex").slice(0, HASH_LEN);
}

/** This instance's own settings key for an address. */
export function claimKey(address, instanceId) {
  return `${CLAIM_PREFIX}${addressHash(address)}_${normalizeInstanceId(instanceId)}`;
}

/**
 * The hash and instance id a claim key carries, or null when the key is not exactly one of ours.
 * The key's suffix IS the instance id: a value naming another instance is not a claim at all, so a
 * mislabelled row can never lock an address to an instance that cannot write that key.
 */
function keyParts(key) {
  if (typeof key !== "string" || !key.startsWith(CLAIM_PREFIX)) return null;
  const rest = key.slice(CLAIM_PREFIX.length);
  const at = rest.indexOf("_");
  if (at !== HASH_LEN) return null;
  const hash = rest.slice(0, at);
  if (!HASH_RE.test(hash)) return null;
  const instanceId = rest.slice(at + 1);
  if (!INSTANCE_ID_RE.test(instanceId)) return null;
  return { hash, instanceId };
}

/** The address hash a key carries, or null when the key is not exactly one of ours. */
function hashOfKey(key) {
  return keyParts(key)?.hash ?? null;
}

/* ------------------------------------------------------------------ rows */

/** A claim time is a positive safe integer; anything else is no time at all (and sorts last). */
function claimTimeOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseClaim(key, value) {
  const parts = keyParts(key);
  if (!parts) return null;
  let raw;
  try {
    raw = JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  // Exact, no trim: `" instP "` in the value is not the `instP` the key names.
  if (typeof raw.instanceId !== "string" || raw.instanceId !== parts.instanceId) return null;
  return {
    key,
    instanceId: parts.instanceId,
    instanceName: cleanName(raw.instanceName),
    claimedAt: claimTimeOrNull(raw.claimedAt),
    released: raw.released === true,
    releasedAt: Number.isFinite(raw.releasedAt) ? Number(raw.releasedAt) : null,
  };
}

function claimTime(claim) {
  return Number.isFinite(claim?.claimedAt) ? Number(claim.claimedAt) : Number.POSITIVE_INFINITY;
}

/** Earliest claim first, then the lowest instance id: the total order the winner is read off. */
function compareClaims(a, b) {
  const ta = claimTime(a);
  const tb = claimTime(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = String(a?.instanceId ?? "");
  const ib = String(b?.instanceId ?? "");
  if (ia !== ib) return ia < ib ? -1 : 1;
  const ka = String(a?.key ?? "");
  const kb = String(b?.key ?? "");
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Every claim row for one address, this instance's own included.
 *
 * `readSettings` runs a LIKE query and `_` is a LIKE wildcard, so the pattern alone can also match a
 * key that merely has any character where `mail_claim_` has its underscores. The `startsWith` filter
 * keeps only keys that really carry this address's prefix.
 */
export async function listClaims(db, address) {
  const prefix = `${CLAIM_PREFIX}${addressHash(address)}_`;
  const rows = await readSettings(db, `${prefix}%`);
  const claims = [];
  for (const [key, value] of rows) {
    if (!key.startsWith(prefix)) continue;
    const claim = parseClaim(key, value);
    if (claim) claims.push(claim);
  }
  return claims.sort(compareClaims);
}

/* ------------------------------------------------------------------ liveness */

/** Instance ids that may hold a claim: this instance plus the active/offline rows in the registry. */
async function liveInstanceIds(db, localInstanceId) {
  const live = new Set([localInstanceId]);
  const { rows } = await db.execute({
    sql: "SELECT id FROM crow_instances WHERE status IN ('active', 'offline')",
    args: [],
  });
  for (const row of rows) if (row.id) live.add(String(row.id));
  return live;
}

/**
 * The claim that holds the address, or null when nobody does.
 * Pure: same claims and same live set give the same answer on every instance.
 */
export function pickClaimWinner(claims, { liveInstanceIds } = {}) {
  const live = liveInstanceIds == null
    ? null
    : (liveInstanceIds instanceof Set ? liveInstanceIds : new Set(liveInstanceIds));
  let winner = null;
  for (const claim of claims || []) {
    if (!claim || claim.released || !claim.instanceId) continue;
    if (live && !live.has(claim.instanceId)) continue;
    if (!winner || compareClaims(claim, winner) < 0) winner = claim;
  }
  return winner;
}

/* ------------------------------------------------------------------ writes */

/** The registry name for an instance, used when the caller passes none. */
async function registryName(db, instanceId) {
  const { rows } = await db.execute({
    sql: "SELECT name FROM crow_instances WHERE id = ?",
    args: [instanceId],
  });
  return cleanName(rows[0]?.name);
}

/**
 * Write this instance's own claim. Called when an account is connected.
 *
 * `claimedAt` is inherited from an existing live claim of ours (a reconnect must not lose its place
 * in the queue) unless the caller passes `now`.
 */
export async function writeClaim(db, address, { localInstanceId, instanceName, now } = {}) {
  const instanceId = resolveInstanceId(localInstanceId);
  const key = claimKey(address, instanceId);
  const existing = (await listClaims(db, address)).find((c) => c.key === key) ?? null;
  const inherited = existing && !existing.released && existing.instanceId === instanceId ? existing : null;

  const claimedAt = claimTimeOrNull(now) ?? claimTimeOrNull(inherited?.claimedAt) ?? Date.now();
  const name = typeof instanceName === "string" && instanceName.trim()
    ? cleanName(instanceName)
    : (inherited?.instanceName || await registryName(db, instanceId));

  const value = JSON.stringify({ instanceId, instanceName: name, claimedAt });
  await writeSetting(db, key, value, { scope: "global", allowLocalFallback: false });
  return { key, instanceId, instanceName: name, claimedAt, released: false, releasedAt: null };
}

/**
 * Give the address up: rewrite this instance's own claim as a tombstone (never a delete, see the
 * module comment). Called when an account is removed.
 */
export async function releaseClaim(db, address, { localInstanceId, now } = {}) {
  const instanceId = resolveInstanceId(localInstanceId);
  const key = claimKey(address, instanceId);
  const releasedAt = Number.isFinite(now) ? Number(now) : Date.now();
  const value = JSON.stringify({ released: true, instanceId, releasedAt });
  await writeSetting(db, key, value, { scope: "global", allowLocalFallback: false });
  return { key, instanceId, instanceName: "", claimedAt: null, released: true, releasedAt };
}

/**
 * Re-write this instance's own claim with the same value, so a peer paired after the claim was made
 * receives it (an emit reaches only the peers already known, and the one-shot settings re-emit is
 * long done). The supervisor calls this at start and once a day.
 *
 * Writes nothing unless the row under our own key is ours and still live: a tombstone must never be
 * resurrected, and a key carrying another instance's id is not ours to touch.
 */
export async function refreshClaim(db, address, { localInstanceId, instanceName } = {}) {
  const instanceId = resolveInstanceId(localInstanceId);
  const key = claimKey(address, instanceId);
  const own = (await listClaims(db, address)).find((c) => c.key === key) ?? null;
  if (!own || own.released || own.instanceId !== instanceId) return false;

  const name = typeof instanceName === "string" && instanceName.trim()
    ? cleanName(instanceName)
    : (own.instanceName || await registryName(db, instanceId));
  const value = JSON.stringify({ instanceId, instanceName: name, claimedAt: own.claimedAt });
  await writeSetting(db, key, value, { scope: "global", allowLocalFallback: false });
  return true;
}

/* ------------------------------------------------------------------ queries */

/** May this instance connect the address? */
export async function checkClaim(db, address, { localInstanceId } = {}) {
  const instanceId = resolveInstanceId(localInstanceId);
  const live = await liveInstanceIds(db, instanceId);
  const winner = pickClaimWinner(await listClaims(db, address), { liveInstanceIds: live });
  if (!winner || winner.instanceId === instanceId) return { ok: true };
  return { ok: false, instanceName: winner.instanceName };
}

/**
 * The supervisor's claim re-check: `(account) => {claimed, instanceName}`. The account may be a
 * store `Account` or a bare address string.
 */
export function makeIsClaimedElsewhere(db, { localInstanceId } = {}) {
  return async function isClaimedElsewhere(account) {
    const address = typeof account === "string" ? account : account?.address;
    if (!address) return { claimed: false, instanceName: null };
    const verdict = await checkClaim(db, address, { localInstanceId });
    return verdict.ok ? { claimed: false, instanceName: null } : { claimed: true, instanceName: verdict.instanceName };
  };
}

/**
 * Addresses held by another live instance — what "Mail is set up on <instance>" is built from. No
 * hash leaves this function: the caller only ever shows a name and a time.
 */
export async function listForeignClaims(db, { localInstanceId } = {}) {
  const instanceId = resolveInstanceId(localInstanceId);
  const live = await liveInstanceIds(db, instanceId);
  const rows = await readSettings(db, `${CLAIM_PREFIX}%`);

  const groups = new Map();
  for (const [key, value] of rows) {
    const hash = hashOfKey(key);
    if (!hash) continue;
    const claim = parseClaim(key, value);
    if (!claim) continue;
    const group = groups.get(hash);
    if (group) group.push(claim);
    else groups.set(hash, [claim]);
  }

  const out = [];
  for (const claims of groups.values()) {
    const winner = pickClaimWinner(claims, { liveInstanceIds: live });
    if (winner && winner.instanceId !== instanceId) {
      out.push({ instanceName: winner.instanceName, claimedAt: winner.claimedAt });
    }
  }
  return out.sort((a, b) =>
    (claimTime(a) - claimTime(b)) ||
    (a.instanceName < b.instanceName ? -1 : a.instanceName > b.instanceName ? 1 : 0));
}

/** The one fixed sentence the owner sees when an address is held elsewhere. */
export function claimedElsewhereSentence(instanceName) {
  const name = cleanName(instanceName) || "another Crow";
  return `This account is already connected on ${name}`;
}