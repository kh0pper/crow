/**
 * Comment loop identity and history rules (spec §3.2, §3.5, §12 I-2 and the C1 nit).
 * Who wrote an @bot comment, and is it new? Nothing here talks to Nextcloud; the saved-path rule reads
 * workspace_editor_sessions only. Times: epoch ms, except version ids / mtimes (epoch s).
 */
import { everNonOwner, soleOwnerWindowAt } from "./sessions.js";

const SKEW_MS = 60_000;

/** Display-name comparison form: NFC, trimmed, lower-cased. */
export const normName = (s) => String(s ?? "").normalize("NFC").trim().toLowerCase();

/**
 * Every reason a verdict can carry, in one place (Task 9 imports it). The decision code uses these, never literals.
 */
export const VERDICT_REASONS = Object.freeze({
  HISTORY: "history",
  DATE_UNKNOWN: "date_unknown",
  OWNER_VERIFIED: "owner_verified",
  NON_OWNER_AUTHOR: "non_owner_author",
  COWORKER_IN_SESSION: "coworker_in_session",
  UNVERIFIED_AUTHOR: "unverified_author",
  UNMAPPED_AUTHOR: "unmapped_author",
  MULTI_VERSION: "multi_version",
  NON_OWNER_VERSION: "non_owner_version",
  NO_SOLE_OWNER_WINDOW: "no_sole_owner_window",
  UNVERIFIED: "unverified",
});
const R = VERDICT_REASONS;

/**
 * A people.xml uid ("<instanceid>_admin") → the bare Nextcloud uid, stripping EXACTLY "<instanceId>_". Null when the
 * instance id is unknown or the uid lacks that prefix (the caller fails closed: unmapped_author). Session uids
 * (already bare from docSession) and nc:version-author values are compared as they are, never through this.
 */
export function peopleUidOf(uid, instanceId) {
  const s = String(uid ?? ""), id = String(instanceId ?? "");
  if (!id) return null;
  const p = `${id}_`;
  return s.length > p.length && s.startsWith(p) ? s.slice(p.length) : null;
}

/**
 * A bot's comment: "<name> (bot)" (actor.js authorFor), the bare "Crow" the gateway writes as authorFor(null), or a
 * people.xml uid of crow-bot. Over-matching only suppresses a verdict, so this errs towards "bot".
 */
export function isBotAuthor(author, peopleUid) {
  const n = normName(author);
  if (n.endsWith(" (bot)") || n === "crow") return true;
  const u = String(peopleUid ?? "");
  return u.endsWith("_crow-bot") || u === "crow-bot";
}

const toMs = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  return typeof v === "number" ? v : Date.parse(String(v));
};

/**
 * §3.5. "history" when the comment predates watch_since, or the last scan already held its fingerprint, or, on a
 * file's first sighting, it predates min(first_seen of the session that produced the version, the previous version's
 * mtime) by more than 60 s of clock skew. "unknown" when it is a first sighting and neither threshold is known (C1 nit:
 * awaiting the owner, never silent history), or the date cannot be read. Otherwise "new".
 */
export function historyOf({ date, watchSince, knownFp, firstSighting, sessionFirstSeenMs, prevVersionMtimeS }) {
  if (knownFp) return "history";
  const d = toMs(date);
  if (!Number.isFinite(d)) return "unknown";
  if (Number.isFinite(Number(watchSince)) && watchSince !== null && d < Number(watchSince)) return "history";
  if (!firstSighting) return "new";
  const known = [];
  if (Number(sessionFirstSeenMs) > 0) known.push(Number(sessionFirstSeenMs));
  if (Number(prevVersionMtimeS) > 0) known.push(Number(prevVersionMtimeS) * 1000);
  if (!known.length) return "unknown";
  return d < Math.min(...known) - SKEW_MS ? "history" : "new";
}

const ownerSet = (ownerUids) => new Set((ownerUids || []).map(String));
const nameSet = (ownerNames) => new Set((ownerNames || []).map(normName).filter(Boolean));
const uidsOf = (list) => (list || []).map(String);

/**
 * §3.2 fast path, rules (a)–(d). reporterUid = live.uids[at], already bare (docSession strips the instance id), and
 * compared as it is;
 * sessionUids = a fresh info's users; sessionRow = the workspace_editor_sessions row of the key.
 * → {ok, reason, sole}; sole = (b) and (c): the session held owners only, now and ever.
 */
export function liveOwner({ reporterUid, sessionUids, sessionRow, payloadName, tokenName, ownerUids, ownerNames }) {
  const owners = ownerSet(ownerUids);
  const now = uidsOf(sessionUids);
  const sole = now.length > 0 && now.every((u) => owners.has(u)) && !everNonOwner(sessionRow, ownerUids);
  if (!owners.has(String(reporterUid ?? ""))) return { ok: false, reason: R.NON_OWNER_AUTHOR, sole };
  if (!sole) return { ok: false, reason: R.COWORKER_IN_SESSION, sole };
  const p = normName(payloadName);
  if (!p || p !== normName(tokenName) || !nameSet(ownerNames).has(p)) return { ok: false, reason: R.UNVERIFIED_AUTHOR, sole };
  return { ok: true, reason: null, sole };
}

/**
 * §3.6 saved path + I-2. All of: w:author is an owner display name; people.xml maps it to an owner uid (exactly
 * "<instanceId>_<uid>"; instanceId from the editor connector or config, never from the file); at most one
 * version since the last scan; no key of the file sampled since sinceMs with a non-owner; the newest (current) version
 * was written by an owner, inside a sampled window where the owners were alone. → {ok, reason, sole}.
 */
export async function savedOwner({ author, peopleUid, instanceId, newestVersion, versionsSince, db, fileId, sinceMs, ownerUids, ownerNames }) {
  const owners = ownerSet(ownerUids);
  const rows = (await db.execute({ sql: "SELECT * FROM workspace_editor_sessions WHERE file_id=? AND last_seen>=?", args: [Number(fileId), Number(sinceMs) || 0] })).rows;
  const coworker = rows.some((r) => everNonOwner(r, ownerUids));
  const window = newestVersion ? await soleOwnerWindowAt(db, fileId, Number(newestVersion.versionId), ownerUids) : false;
  const sole = !coworker && window;
  const no = (reason) => ({ ok: false, reason, sole });
  if (!nameSet(ownerNames).has(normName(author))) return no(R.NON_OWNER_AUTHOR);
  const uid = peopleUid ? peopleUidOf(peopleUid, instanceId) : null;
  if (uid === null) return no(R.UNMAPPED_AUTHOR);
  if (!owners.has(uid)) return no(R.NON_OWNER_AUTHOR);
  if (Number(versionsSince) > 1) return no(R.MULTI_VERSION);
  if (coworker) return no(R.COWORKER_IN_SESSION);
  if (!newestVersion || !owners.has(String(newestVersion.author ?? ""))) return no(R.NON_OWNER_VERSION);
  if (!window) return no(R.NO_SOLE_OWNER_WINDOW);
  return { ok: true, reason: null, sole };
}

/** → {kind: "history"|"unverified"|"would_fire", reason}. */
export function verdictOf(history, identity) {
  if (history === "history") return { kind: "history", reason: R.HISTORY };
  if (history === "unknown") return { kind: "unverified", reason: R.DATE_UNKNOWN };
  if (identity?.ok) return { kind: "would_fire", reason: R.OWNER_VERIFIED };
  return { kind: "unverified", reason: identity?.reason || R.UNVERIFIED };
}
