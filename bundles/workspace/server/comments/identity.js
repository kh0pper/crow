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
 * Strip the connector's "<instanceid>_" prefix from a uid ("oc3q5ynue57b_admin" → "admin").
 * Nextcloud instance ids are "oc" + lower-case letters and digits; anything else is returned unchanged.
 */
export function stripInstance(uid) {
  const s = String(uid ?? "");
  const m = /^oc[a-z0-9]+_(.+)$/.exec(s);
  return m ? m[1] : s;
}

/** A bot's comment: "<name> (bot)" (actor.js authorFor), or a people.xml uid of crow-bot. */
export function isBotAuthor(author, peopleUid) {
  if (normName(author).endsWith(" (bot)")) return true;
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
const uidsOf = (list) => (list || []).map((u) => stripInstance(u));

/**
 * §3.2 fast path, rules (a)–(d). reporterUid = live.uids[at] (prefix-stripped again here, harmlessly);
 * sessionUids = a fresh info's users; sessionRow = the workspace_editor_sessions row of the key.
 * → {ok, reason, sole}; sole = (b) and (c): the session held owners only, now and ever.
 */
export function liveOwner({ reporterUid, sessionUids, sessionRow, payloadName, tokenName, ownerUids, ownerNames }) {
  const owners = ownerSet(ownerUids);
  const now = uidsOf(sessionUids);
  const sole = now.length > 0 && now.every((u) => owners.has(u)) && !everNonOwner(sessionRow, ownerUids);
  if (!owners.has(stripInstance(reporterUid))) return { ok: false, reason: "non_owner_author", sole };
  if (!sole) return { ok: false, reason: "coworker_in_session", sole };
  const p = normName(payloadName);
  if (!p || p !== normName(tokenName) || !nameSet(ownerNames).has(p)) return { ok: false, reason: "unverified_author", sole };
  return { ok: true, reason: null, sole };
}

/**
 * §3.6 saved path + I-2. All of: w:author is an owner display name; people.xml maps it to an owner uid; at most one
 * version since the last scan; no key of the file sampled since sinceMs with a non-owner; the newest (current) version
 * was written by an owner, inside a sampled window where the owners were alone. → {ok, reason, sole}.
 */
export async function savedOwner({ author, peopleUid, newestVersion, versionsSince, db, fileId, sinceMs, ownerUids, ownerNames }) {
  const owners = ownerSet(ownerUids);
  const rows = (await db.execute({ sql: "SELECT * FROM workspace_editor_sessions WHERE file_id=? AND last_seen>=?", args: [Number(fileId), Number(sinceMs) || 0] })).rows;
  const coworker = rows.some((r) => everNonOwner(r, ownerUids));
  const window = newestVersion ? await soleOwnerWindowAt(db, fileId, Number(newestVersion.versionId), ownerUids) : false;
  const sole = !coworker && window;
  const no = (reason) => ({ ok: false, reason, sole });
  if (!nameSet(ownerNames).has(normName(author))) return no("non_owner_author");
  if (!peopleUid) return no("unmapped_author");
  if (!owners.has(stripInstance(peopleUid))) return no("non_owner_author");
  if (Number(versionsSince) > 1) return no("multi_version");
  if (coworker) return no("coworker_in_session");
  if (!newestVersion || !owners.has(stripInstance(newestVersion.author))) return no("non_owner_version");
  if (!window) return no("no_sole_owner_window");
  return { ok: true, reason: null, sole };
}

/** → {kind: "history"|"unverified"|"would_fire", reason}. */
export function verdictOf(history, identity) {
  if (history === "history") return { kind: "history", reason: "history" };
  if (history === "unknown") return { kind: "unverified", reason: "date_unknown" };
  if (identity?.ok) return { kind: "would_fire", reason: "owner_verified" };
  return { kind: "unverified", reason: identity?.reason || "unverified" };
}
