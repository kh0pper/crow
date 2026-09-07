/**
 * Ramble mark store — CRUD for `ramble_marks` and `ramble_blocks`.
 *
 * No Nostr, no persona derivation, no HTTP — just the store: create/list/get/
 * unlock/expire marks, plus the small persona-block list that gates receipt
 * of remote marks and list visibility. Confidentiality against relays is a
 * later layer (Task 9); content is stored in the clear locally here.
 */

import { randomUUID } from "node:crypto";
import { encodeGeohash } from "./anchors.js";
import { teaser, revealContent } from "./reveal.js";
import { escapeLikePattern } from "./db.js";

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble marks] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

function defaultTtlSeconds(kind, visibility) {
  if (kind === "caw") return 3600;
  if (visibility === "public") return 86400;
  return null; // contacts/group/private marks are persistent by default
}

function defaultReveal(visibility) {
  return visibility === "public" ? "locked" : "open";
}

function anchorColumns(anchor) {
  const anchor_kind = anchor.anchor_kind;
  if (anchor_kind === "geo") {
    const lat = anchor.lat ?? null;
    const lon = anchor.lon ?? null;
    // Sparse geo rows (every caw on the wire: coarse geohash only, no exact
    // coordinates) must not be re-derived from undefined lat/lon -- the
    // caller (insertRemoteMark) falls back to the incoming geohash instead.
    const geohash = lat != null && lon != null ? encodeGeohash(lat, lon, 7) : null;
    return {
      anchor_kind,
      geohash,
      lat,
      lon,
      accuracy_m: anchor.accuracy_m ?? null,
      anchor_ref: null,
    };
  }
  return {
    anchor_kind,
    geohash: null,
    lat: null,
    lon: null,
    accuracy_m: null,
    anchor_ref: anchor.anchor_ref ?? null,
  };
}

export async function createMark(db, opts, { emit } = {}) {
  const {
    author, author_level, kind, anchor, visibility, content, ttlSeconds, bird,
  } = opts;
  const reveal = opts.reveal ?? defaultReveal(visibility);
  const mark_id = randomUUID();
  const created_at = Date.now();
  const ttl = ttlSeconds ?? defaultTtlSeconds(kind, visibility);
  const expires_at = ttl == null ? null : created_at + ttl * 1000;
  const { anchor_kind, geohash, lat, lon, accuracy_m, anchor_ref } = anchorColumns(anchor);
  const content_text = content?.content_text ?? null;
  const content_kind = content?.content_kind ?? "none";
  const content_ref = content?.content_ref ?? null;
  // The author's currently-active bird, so your own pins show your bird too
  // (createMark is the local-author path; insertRemoteMark is the wire path).
  const bird_species = bird?.species ?? null;
  const bird_seed = bird?.seed ?? null;

  await db.execute({
    sql: `INSERT INTO ramble_marks (
            mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, accuracy_m, anchor_ref,
            visibility, reveal, content_text, content_kind, content_ref,
            created_at, expires_at, publish_state, origin, bird_species, bird_seed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'local', ?, ?)`,
    args: [
      mark_id, author, author_level ?? null, kind, anchor_kind, geohash, lat, lon, accuracy_m, anchor_ref,
      visibility, reveal, content_text, content_kind, content_ref,
      created_at, expires_at, bird_species, bird_seed,
    ],
  });

  const row = await getMark(db, mark_id);
  await safeEmit(emit, "ramble_marks", "insert", row);
  return row;
}

export async function getMark(db, mark_id) {
  const result = await db.execute({ sql: "SELECT * FROM ramble_marks WHERE mark_id = ?", args: [mark_id] });
  return result.rows[0] ?? null;
}

export async function listMarks(db, opts = {}) {
  const { visibility, geohashPrefix, cells, includeExpired = false, limit = 200 } = opts;
  const clauses = ["author NOT IN (SELECT persona FROM ramble_blocks)"];
  const args = [];

  if (visibility) {
    clauses.push("visibility = ?");
    args.push(visibility);
    // A private mark is "just me" — but "me" spans every instance the user
    // owns: origin='local' (authored here) and origin='sync' (replicated in
    // from one of the user's OWN other instances via instance-sync,
    // applyRambleMark) are both legitimately "mine". The only origin that
    // must never carry a private row is 'remote' — that's the Nostr wire,
    // and insertRemoteMark rejects visibility='private' before it can even
    // reach the table; this clause is the belt to that suspenders.
    if (visibility === "private") {
      clauses.push("origin <> 'remote'");
    }
  } else {
    // No visibility filter = the owner's overview across everything. Private
    // rows must still only surface when they're the user's own (local or
    // synced-from-own-instance) — never a private row that arrived off the
    // Nostr wire, which should never exist but is guarded here regardless.
    clauses.push("NOT (visibility = 'private' AND origin = 'remote')");
  }
  if (!includeExpired) {
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    args.push(Date.now());
  }
  if (geohashPrefix) {
    clauses.push("geohash LIKE ? ESCAPE '\\'");
    args.push(`${escapeLikePattern(geohashPrefix)}%`);
  }
  if (cells && cells.length > 0) {
    const cellClauses = cells.map(() => "geohash LIKE ? ESCAPE '\\'");
    clauses.push(`(${cellClauses.join(" OR ")})`);
    for (const cell of cells) args.push(`${escapeLikePattern(cell)}%`);
  }

  const sql = `SELECT * FROM ramble_marks WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const result = await db.execute({ sql, args });
  return result.rows.map(teaser);
}

export async function unlockMark(db, mark_id, here) {
  const row = await getMark(db, mark_id);
  if (!row) return { unlocked: false, content: null, missing: true };
  // The sweep (expireMarks) runs on the drain tick, so a row can still be in
  // the table for up to one tick past its TTL. `listMarks` already filters
  // those out; unlock must agree, or an expired mark would still hand over
  // its content to anyone standing in range.
  if (row.expires_at != null && row.expires_at <= Date.now()) {
    return { unlocked: false, content: null, expired: true };
  }
  return revealContent(row, here);
}

export async function expireMarks(db, now = Date.now(), { emit } = {}) {
  const result = await db.execute({
    sql: "SELECT * FROM ramble_marks WHERE expires_at IS NOT NULL AND expires_at <= ?",
    args: [now],
  });
  const rows = result.rows;
  if (rows.length === 0) return 0;

  await db.execute({
    sql: "DELETE FROM ramble_marks WHERE expires_at IS NOT NULL AND expires_at <= ?",
    args: [now],
  });

  for (const row of rows) {
    if (row.origin === "local") {
      // eslint-disable-next-line no-await-in-loop
      await safeEmit(emit, "ramble_marks", "delete", row);
    }
  }
  return rows.length;
}

export async function insertRemoteMark(db, row) {
  // A private mark is "just me" — it can only ever be authored locally.
  // Any row arriving over the wire claiming visibility='private' is either a
  // bug or a spoof attempt; reject it outright, before dedup or blocklist
  // checks even run.
  if (row.visibility === "private") return { inserted: false, invalid: true };
  if (await isBlocked(db, row.author)) return { inserted: false, blocked: true };

  const existing = await db.execute({
    sql: "SELECT 1 FROM ramble_marks WHERE nostr_event_id = ? OR mark_id = ? LIMIT 1",
    args: [row.nostr_event_id ?? null, row.mark_id],
  });
  if (existing.rows.length > 0) return { inserted: false };

  const created_at = row.created_at ?? Date.now();
  let expires_at = null;
  if (row.expires_at != null && row.created_at != null) {
    expires_at = Date.now() + Math.max(0, row.expires_at - row.created_at);
  } else if (row.expires_at != null) {
    expires_at = row.expires_at;
  }

  const { anchor_kind, geohash, lat, lon, accuracy_m, anchor_ref } = anchorColumns({
    anchor_kind: row.anchor_kind,
    lat: row.lat,
    lon: row.lon,
    accuracy_m: row.accuracy_m,
    anchor_ref: row.anchor_ref,
  });
  // A remote row that already carries a computed geohash (as in the wire
  // format) should keep it rather than being recomputed here.
  const finalGeohash = row.geohash ?? geohash;

  const mark_id = row.mark_id ?? randomUUID();

  await db.execute({
    sql: `INSERT INTO ramble_marks (
            mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, accuracy_m, anchor_ref,
            visibility, reveal, content_text, content_kind, content_ref,
            created_at, expires_at, nostr_event_id, publish_state, origin, bird_species, bird_seed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', 'remote', ?, ?)`,
    args: [
      mark_id, row.author, row.author_level ?? null, row.kind, anchor_kind, finalGeohash, lat, lon, accuracy_m, anchor_ref,
      row.visibility ?? "public", row.reveal ?? "open", row.content_text ?? null, row.content_kind ?? "none", row.content_ref ?? null,
      created_at, expires_at, row.nostr_event_id ?? null, row.bird_species ?? null, row.bird_seed ?? null,
    ],
  });

  const stored = await getMark(db, mark_id);
  return { inserted: true, row: stored };
}

export async function isBlocked(db, persona) {
  const result = await db.execute({ sql: "SELECT 1 FROM ramble_blocks WHERE persona = ? LIMIT 1", args: [persona] });
  return result.rows.length > 0;
}

export async function blockPersona(db, persona, reason, { emit } = {}) {
  const created_at = Date.now();
  await db.execute({
    sql: `INSERT INTO ramble_blocks (persona, reason, created_at) VALUES (?, ?, ?)
          ON CONFLICT(persona) DO UPDATE SET reason = excluded.reason`,
    args: [persona, reason ?? null, created_at],
  });

  // Local marks by yourself are never deleted, even if you somehow block
  // your own persona -- only already-stored remote marks by that author.
  await db.execute({
    sql: "DELETE FROM ramble_marks WHERE author = ? AND origin = 'remote'",
    args: [persona],
  });

  const row = await db.execute({ sql: "SELECT * FROM ramble_blocks WHERE persona = ?", args: [persona] });
  const stored = row.rows[0];
  await safeEmit(emit, "ramble_blocks", "insert", stored);
  return stored;
}

export async function unblockPersona(db, persona, { emit } = {}) {
  await db.execute({ sql: "DELETE FROM ramble_blocks WHERE persona = ?", args: [persona] });
  await safeEmit(emit, "ramble_blocks", "delete", { persona });
}
