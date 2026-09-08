/**
 * Ramble delivery — the contacts wire, minus Nostr (spec §4, phase 3).
 *
 * Three things live here:
 *   1. the payload codecs: what a mark, a gifted egg or a swap step looks like
 *      INSIDE a NIP-44 DM. Every inbound field is bounded here and nowhere else
 *      (the transport hands a decrypted object straight to these parsers);
 *   2. audience resolution against the CORE tables `contacts`,
 *      `contact_groups`, `contact_group_members` (read only — ramble never
 *      creates or writes them). `group:<group_uid>` means a plain contact
 *      group; the phase-1 `ramble_groups` shared-key table is unused;
 *   3. the LOCAL `ramble_outbox` queue: one row per (recipient, thing to
 *      send). The gateway transport (servers/gateway/boot/ramble-transport.js)
 *      drains it into `nostrManager.sendControl` and deletes each row once a
 *      relay accepted the DM.
 *
 * An egg on the wire is unhatched by definition: `eggPayload` ships exactly
 * { egg_id, warmth, found_cell, found_week } and `parseEggPayload` ignores
 * anything else, so species/seed can never travel (Global Constraints).
 */
import { createRequire } from "node:module";
import { CELL7_RE, WEEK_RE } from "./nests.js";

const require = createRequire(import.meta.url);
const { isValidBird } = require("./bird-svg.cjs");

export const CROW_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
/** mark_id / egg_id / trade_id — the same shape routes.js already accepts. */
export const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
export const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/;
const GROUP_UID_RE = /^[A-Za-z0-9_:.-]{1,120}$/;
const ANCHOR_KIND_RE = /^[a-z]{1,16}$/;
export const MAX_TEXT_LEN = 2000;
export const MAX_WARMTH = 100000;
const MAX_CREATED_AT = 4102444800000; // 2100-01-01
export const DELIVERY_KINDS = ["mark", "egg", "trade"];
export const TRADE_STATES = ["proposed", "accepted", "completed", "expired", "declined"];
export const MAX_DELIVERY_ATTEMPTS = 20;

export function isRambleEnvelope(p) {
  return !!p && typeof p === "object" && !Array.isArray(p) && typeof p.type === "string" && p.type.startsWith("ramble.");
}

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const idOrNull = (v) => (typeof v === "string" && ID_RE.test(v) ? v : null);
const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/* ------------------------------------------------------------------ eggs */

/** The unhatched egg as it travels: no species, no seed, no status, no origin. */
export function eggPayload(egg) {
  return {
    egg_id: egg.egg_id,
    warmth: Math.max(0, Math.min(MAX_WARMTH, Math.trunc(Number(egg.warmth) || 0))),
    found_cell: egg.found_cell ?? null,
    found_week: egg.found_week ?? null,
  };
}

/** Inverse of eggPayload with bounds: null only when there is no usable egg_id. */
export function parseEggPayload(egg) {
  if (!egg || typeof egg !== "object" || Array.isArray(egg)) return null;
  const egg_id = idOrNull(egg.egg_id);
  if (!egg_id) return null;
  const warmth = Number.isInteger(egg.warmth) ? Math.max(0, Math.min(MAX_WARMTH, egg.warmth)) : 0;
  const found_cell = typeof egg.found_cell === "string" && CELL7_RE.test(egg.found_cell) ? egg.found_cell : null;
  const found_week = typeof egg.found_week === "string" && WEEK_RE.test(egg.found_week) ? egg.found_week : null;
  return { egg_id, warmth, found_cell, found_week };
}

export function giftPayload(egg) {
  return { type: "ramble.egg", v: 1, egg: eggPayload(egg) };
}

/* ----------------------------------------------------------------- marks */

/**
 * A `ramble_marks` row as it travels to a contact. No visibility, author,
 * origin or publish bookkeeping: the recipient sets those from the DM
 * itself (the sender IS the contact the DM came from).
 */
export function markPayload(row, { bird = null } = {}) {
  const mark = {
    mark_id: row.mark_id,
    kind: row.kind,
    anchor_kind: row.anchor_kind,
    geohash: row.geohash ?? null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    accuracy_m: row.accuracy_m ?? null,
    anchor_ref: row.anchor_ref ?? null,
    reveal: row.reveal ?? "open",
    content_text: typeof row.content_text === "string" ? row.content_text.slice(0, MAX_TEXT_LEN) : null,
    content_kind: row.content_kind ?? "none",
    content_ref: row.content_ref ?? null,
    created_at: row.created_at,
  };
  if (isValidBird(bird)) mark.bird = { species: bird.species, seed: bird.seed };
  return mark;
}

export function markEnvelope(row, { bird = null } = {}) {
  return { type: "ramble.mark", v: 1, mark: markPayload(row, { bird }) };
}

/**
 * Inverse of markPayload, shaped for `insertRemoteMark`. `author` is the
 * VERIFIED sender (the contact's x-only pubkey the DM decrypted under), never
 * anything from the payload. Contacts marks are persistent (`expires_at`
 * null) and always land as visibility 'contacts' — a group uid means nothing
 * to the recipient. Returns null when there is nothing safe to store.
 */
export function payloadToMark(mark, { author, eventId = null } = {}) {
  if (!mark || typeof mark !== "object" || Array.isArray(mark)) return null;
  if (typeof author !== "string" || !/^[0-9a-f]{64}$/.test(author)) return null;
  const mark_id = idOrNull(mark.mark_id);
  if (!mark_id) return null;
  const kind = mark.kind === "caw" ? "caw" : (mark.kind === "mark" ? "mark" : null);
  if (!kind) return null;
  const lat = num(mark.lat, -90, 90);
  const lon = num(mark.lon, -180, 180);
  const geohash = typeof mark.geohash === "string" && GEOHASH_RE.test(mark.geohash) ? mark.geohash : null;
  if (!geohash && (lat == null || lon == null)) return null; // nothing to pin
  const bird = isValidBird(mark.bird) ? mark.bird : null;
  return {
    mark_id,
    author,
    author_level: "real",
    kind,
    anchor_kind: typeof mark.anchor_kind === "string" && ANCHOR_KIND_RE.test(mark.anchor_kind) ? mark.anchor_kind : "geo",
    geohash,
    lat,
    lon,
    accuracy_m: num(mark.accuracy_m, 0, 100000),
    anchor_ref: str(mark.anchor_ref, 256),
    visibility: "contacts",
    reveal: mark.reveal === "locked" ? "locked" : "open",
    content_text: typeof mark.content_text === "string" ? mark.content_text.slice(0, MAX_TEXT_LEN) : null,
    content_kind: str(mark.content_kind, 64) ?? "none",
    content_ref: str(mark.content_ref, 1024),
    created_at: num(mark.created_at, 0, MAX_CREATED_AT) ?? Date.now(),
    expires_at: null,
    nostr_event_id: eventId,
    origin: "remote",
    publish_state: "remote",
    bird_species: bird ? bird.species : null,
    bird_seed: bird ? bird.seed : null,
  };
}

/* ---------------------------------------------------------------- trades */

export function tradePayload({ trade_id, state, my_egg_id = null, want_egg_id = null }, egg = null) {
  const out = { type: "ramble.trade", v: 1, trade: { trade_id, state, my_egg_id, want_egg_id } };
  if (egg) out.egg = eggPayload(egg);
  return out;
}

/** Null for anything malformed: a bad id, an unknown state, an egg without an id. */
export function parseTradePayload(p) {
  if (!isRambleEnvelope(p) || p.type !== "ramble.trade") return null;
  const t = p.trade;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const trade_id = idOrNull(t.trade_id);
  const state = TRADE_STATES.includes(t.state) ? t.state : null;
  if (!trade_id || !state) return null;
  const my_egg_id = t.my_egg_id == null ? null : idOrNull(t.my_egg_id);
  if (t.my_egg_id != null && !my_egg_id) return null;
  const want_egg_id = t.want_egg_id == null ? null : idOrNull(t.want_egg_id);
  if (t.want_egg_id != null && !want_egg_id) return null;
  const egg = p.egg == null ? null : parseEggPayload(p.egg);
  if (p.egg != null && !egg) return null;
  return { trade_id, state, my_egg_id, want_egg_id, egg };
}

/* -------------------------------------------------------------- audience */

/** A deliverable contact: full (not a request), unblocked, not a bot, with a key. */
function contactFilter(alias) {
  const a = alias ? `${alias}.` : "";
  return `${a}is_blocked = 0 AND ${a}request_status IS NULL AND COALESCE(${a}is_bot, 0) = 0
          AND ${a}secp256k1_pubkey IS NOT NULL AND ${a}secp256k1_pubkey <> '' AND ${a}crow_id NOT LIKE 'req:%'`;
}

export async function resolveContact(db, crowId) {
  if (typeof crowId !== "string" || !CROW_ID_RE.test(crowId)) return null;
  const { rows } = await db.execute({
    sql: `SELECT id, crow_id, display_name, secp256k1_pubkey FROM contacts WHERE crow_id = ? AND ${contactFilter("")}`,
    args: [crowId],
  });
  return rows[0] ?? null;
}

export async function listAudiences(db) {
  const { rows: c } = await db.execute({
    sql: `SELECT crow_id, display_name FROM contacts WHERE ${contactFilter("")} ORDER BY display_name, crow_id`,
    args: [],
  });
  const { rows: g } = await db.execute({
    sql: `SELECT g.group_uid, g.name,
                 (SELECT count(*) FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
                   WHERE m.group_id = g.id AND ${contactFilter("c")}) AS member_count
            FROM contact_groups g WHERE g.group_uid IS NOT NULL AND g.room_uid IS NULL ORDER BY g.name, g.group_uid`,
    args: [],
  });
  return {
    contacts: c.map((r) => ({ crow_id: r.crow_id, display_name: r.display_name ?? null })),
    groups: g.map((r) => ({ group_uid: r.group_uid, name: r.name, member_count: Number(r.member_count) || 0 })),
  };
}

/**
 * x-only pubkey -> { crow_id, name } for every unblocked full contact, bots
 * included on purpose (naming a bot's mark is harmless). ORDER BY id +
 * first-wins so two rows sharing a key name the older one deterministically.
 * Tolerant: an empty map when the core table is unreadable (the stdio MCP
 * process on a fresh db).
 */
export async function contactsByPubkey(db) {
  const map = new Map();
  try {
    const { rows } = await db.execute({ sql: "SELECT crow_id, display_name, secp256k1_pubkey FROM contacts WHERE is_blocked = 0 AND request_status IS NULL ORDER BY id", args: [] });
    for (const r of rows) {
      const pk = String(r.secp256k1_pubkey || "");
      const key = pk.length === 66 ? pk.slice(2) : pk;
      if (key && !map.has(key)) map.set(key, { crow_id: r.crow_id, name: r.display_name || r.crow_id });
    }
  } catch { /* no core tables: nobody is a contact */ }
  return map;
}

/**
 * Who a mark with this visibility goes to. `contacts` = every deliverable
 * contact; `group:<uid>` = the deliverable members of that PLAIN contact group
 * (rooms — room_uid NOT NULL — are not groups). Public/private marks never
 * take this path at all.
 */
export async function resolveAudience(db, visibility) {
  if (visibility === "contacts") {
    const { rows } = await db.execute({ sql: `SELECT crow_id FROM contacts WHERE ${contactFilter("")} ORDER BY id`, args: [] });
    return { ok: true, crowIds: rows.map((r) => r.crow_id) };
  }
  if (typeof visibility === "string" && visibility.startsWith("group:")) {
    const uid = visibility.slice("group:".length);
    if (!GROUP_UID_RE.test(uid)) return { ok: false, reason: "unknown-group" };
    const { rows: g } = await db.execute({ sql: "SELECT id FROM contact_groups WHERE group_uid = ? AND room_uid IS NULL", args: [uid] });
    if (!g[0]) return { ok: false, reason: "unknown-group" };
    const { rows } = await db.execute({
      sql: `SELECT c.crow_id FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
             WHERE m.group_id = ? AND ${contactFilter("c")} ORDER BY c.id`,
      args: [g[0].id],
    });
    return { ok: true, crowIds: rows.map((r) => r.crow_id) };
  }
  return { ok: false, reason: "not-deliverable" };
}

/* ---------------------------------------------------------------- outbox */

/** One outbox row per unique, well-formed recipient. Returns how many were queued. */
export async function enqueueDeliveries(db, { toCrowIds, kind, refId, payload, now = Date.now() }) {
  if (!DELIVERY_KINDS.includes(kind)) throw new Error(`unknown delivery kind: ${kind}`);
  const unique = [...new Set(toCrowIds)].filter((c) => typeof c === "string" && CROW_ID_RE.test(c));
  if (unique.length === 0) return 0;
  const json = JSON.stringify(payload);
  await db.batch(unique.map((to) => ({
    sql: `INSERT INTO ramble_outbox (to_crow_id, kind, ref_id, payload_json, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    args: [to, kind, refId, json, now],
  })));
  return unique.length;
}

/** Queue a contacts/group mark for every member of its audience (snapshot at authoring time). */
export async function enqueueMark(db, row, { bird = null, now = Date.now() } = {}) {
  const audience = await resolveAudience(db, row.visibility);
  if (!audience.ok) return { ok: false, reason: audience.reason, recipients: 0 };
  const recipients = await enqueueDeliveries(db, {
    toCrowIds: audience.crowIds, kind: "mark", refId: row.mark_id, payload: markEnvelope(row, { bird }), now,
  });
  if (recipients === 0) {
    // Nobody to send to: the row would otherwise sit 'pending' forever with
    // no outbox row to ever settle it (review round 1, S4).
    await db.execute({
      sql: "UPDATE ramble_marks SET publish_state = 'published' WHERE mark_id = ? AND publish_state = 'pending'",
      args: [row.mark_id],
    });
  }
  return { ok: true, recipients };
}

/**
 * Gifts and trade steps first, then marks, then insertion order. A MARK row
 * can sit queued while the privacy grid is closed; without this ordering
 * fifty gated mark rows would fill every batch and starve the trades behind
 * them (review round 1, C1).
 *
 * `excludeIds` lets a caller page past rows it has already looked at this
 * tick (e.g. a batch of gate-skipped mark rows) without re-fetching them —
 * the fix for the one-level-down defect where 50+ gate-skipped `contacts`
 * mark rows refill every batch and a `group:` mark row behind them (a
 * DIFFERENT, currently-open audience) is never reached.
 */
export async function pendingDeliveries(db, limit = 50, { excludeIds = [] } = {}) {
  const exclude = excludeIds.length > 0
    ? ` WHERE id NOT IN (${excludeIds.map(() => "?").join(", ")})`
    : "";
  const { rows } = await db.execute({
    sql: `SELECT * FROM ramble_outbox${exclude} ORDER BY CASE WHEN kind = 'mark' THEN 1 ELSE 0 END, id LIMIT ?`,
    args: [...excludeIds, limit],
  });
  return rows;
}

export async function deleteDelivery(db, id) {
  await db.execute({ sql: "DELETE FROM ramble_outbox WHERE id = ?", args: [id] });
}

/**
 * Count one failed attempt; at `max` the row is parked (deleted) so a
 * recipient whose relays never accept cannot occupy a drain slot forever —
 * the same R15 rule the public drain applies to marks.
 */
export async function noteDeliveryFailure(db, row, max = MAX_DELIVERY_ATTEMPTS) {
  const attempts = (Number(row.attempts) || 0) + 1;
  if (attempts >= max) {
    await deleteDelivery(db, row.id);
    return { parked: true, attempts };
  }
  await db.execute({ sql: "UPDATE ramble_outbox SET attempts = ? WHERE id = ?", args: [attempts, row.id] });
  return { parked: false, attempts };
}

export async function remainingDeliveries(db, kind, refId) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_outbox WHERE kind = ? AND ref_id = ?", args: [kind, refId] });
  return Number(rows[0]?.n ?? 0);
}
