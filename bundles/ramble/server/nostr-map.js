/**
 * Ramble <-> Nostr event mapping — PURE functions only.
 *
 * markToEvent() turns a `ramble_marks` row into an UNSIGNED event template
 * ({ kind, created_at, tags, content }); eventToMark() inverts a received
 * event back into a row shaped for `insertRemoteMark` (marks.js). No
 * signing, no relays, no DB access here — Task 10 signs with
 * `finalizeEvent` from nostr-tools/pure and does the wire I/O.
 *
 * Phase-1 wire is public-only (Global Constraints D1): markToEvent throws
 * RambleNotPublic for any row whose visibility isn't 'public'.
 *
 * Kinds: 30078 is NIP-78 (arbitrary app data), so ramble uses adjacent
 * unclaimed numbers instead: 30397 (addressable, marks) and 20397
 * (ephemeral, caws).
 *
 * `ramble_marks` timestamps are milliseconds; Nostr `created_at` and NIP-40
 * `expiration` are seconds — every ms<->s conversion happens at this
 * boundary, nowhere else.
 */

import { createRequire } from "node:module";
import { sanitizeWorldName } from "./grid.js";

const require = createRequire(import.meta.url);
const { isValidBird } = require("./bird-svg.cjs");

export const MARK_KIND = 30397;
export const CAW_KIND = 20397;

const MAX_TEXT_LEN = 2000;

export class RambleNotPublic extends Error {
  constructor(message) {
    super(message);
    this.name = "RambleNotPublic";
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateText(text) {
  return typeof text === "string" ? text.slice(0, MAX_TEXT_LEN) : null;
}

// A non-numeric or non-positive `expiration` tag (malformed input, or an
// empty string which Number() turns into 0) must never surface as NaN --
// NaN silently poisons `expires_at` and throws downstream on the libsql
// cross-process path ("Only finite numbers..."). Fail closed to null.
function parseExpirationMs(expirationTag) {
  if (expirationTag == null) return null;
  const n = Number(expirationTag);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 1000;
}

function geohashPrefixTags(geohash) {
  const tags = [];
  for (let n = 1; n <= geohash.length; n++) tags.push(["g", geohash.slice(0, n)]);
  return tags;
}

/**
 * Build an unsigned Nostr event template from a public `ramble_marks` row.
 * Tag order: g (shortest first), d (marks only), k, rv, expiration (if
 * set), crow (if crowId given).
 */
export function markToEvent(row, { precision = 5, crowId = null, bird = null, name = null } = {}) {
  if (row.visibility !== "public") {
    throw new RambleNotPublic(`markToEvent: mark ${row.mark_id} is not public (visibility=${row.visibility})`);
  }
  if (!row.geohash) {
    throw new Error(`markToEvent: mark ${row.mark_id} has no geohash`);
  }

  const isCaw = row.kind === "caw";
  const created_at = Math.floor((row.created_at ?? Date.now()) / 1000);
  const text = truncateText(row.content_text);

  // Caws are the user's own position: coarse presence only, geohash
  // truncated to `precision` BEFORE prefix expansion so no g tag ever
  // reveals more precision than the caller asked to publish.
  const wireGeohash = isCaw ? row.geohash.slice(0, clamp(precision, 1, 12)) : row.geohash;

  const tags = geohashPrefixTags(wireGeohash);
  if (!isCaw) tags.push(["d", row.mark_id]);
  tags.push(["k", row.anchor_kind]);
  tags.push(["rv", row.reveal]);
  if (row.expires_at != null) tags.push(["expiration", String(Math.floor(row.expires_at / 1000))]);
  if (crowId) tags.push(["crow", crowId]);

  let content;
  if (isCaw) {
    // No coordinates on a caw, ever — presence is conveyed only by the
    // truncated geohash g tags above.
    content = { v: 1, text, locked: false };
  } else {
    content = { v: 1, text, content_kind: row.content_kind ?? "none" };
    if (row.content_ref != null) content.content_ref = row.content_ref;
    if (row.lat != null) content.lat = row.lat;
    if (row.lon != null) content.lon = row.lon;
    if (row.accuracy_m != null) content.accuracy_m = row.accuracy_m;
    // Phase-1 limitation (Task 4): a 'locked' mark still ships its text in
    // the clear on the wire; `locked:true` just tells honest clients to
    // gate display until the viewer is in range.
    content.locked = row.reveal === "locked";
  }

  // The author's currently-active bird rides on BOTH marks and caws (never
  // coordinates, even on a caw -- only species/seed) so a viewer can render
  // whose bird left a pin, or whose bird is nearby right now. A bird that
  // fails isValidBird (unknown species, non-uint32 seed) is silently
  // dropped rather than shipped malformed.
  if (isValidBird(bird)) content.bird = { species: bird.species, seed: bird.seed };

  // The author's chosen world name (spec 2026-09-08 §2.2). The transport
  // hands it over only for pseudonym/real rows — a rotating row never gets
  // one — and it is sanitized again here so a bad setting cannot reach a relay.
  const cleanName = sanitizeWorldName(name);
  if (cleanName) content.name = cleanName;

  return { kind: isCaw ? CAW_KIND : MARK_KIND, created_at, tags, content: JSON.stringify(content) };
}

/**
 * Invert a received Nostr event into a row shaped for `insertRemoteMark`.
 * Returns null for event kinds ramble doesn't publish, and for events that
 * carry neither a `g` tag nor parseable JSON content (nothing usable).
 */
export function eventToMark(event) {
  if (event.kind !== MARK_KIND && event.kind !== CAW_KIND) return null;

  const tags = event.tags ?? [];
  const gValues = tags.filter((t) => t[0] === "g").map((t) => t[1]);
  const dTag = tags.find((t) => t[0] === "d")?.[1] ?? null;
  const kTag = tags.find((t) => t[0] === "k")?.[1] ?? null;
  const rvTag = tags.find((t) => t[0] === "rv")?.[1] ?? null;
  const expirationTag = tags.find((t) => t[0] === "expiration")?.[1] ?? null;
  const crowTag = tags.find((t) => t[0] === "crow")?.[1] ?? null;

  const parsedContent = safeParseJson(event.content);
  if (gValues.length === 0 && parsedContent === null) return null;
  const content = parsedContent ?? {};

  const longestG = gValues.length > 0
    ? gValues.reduce((longest, g) => (g.length > longest.length ? g : longest))
    : null;

  const isCaw = event.kind === CAW_KIND;

  // A bad/malformed content.bird must never reject the event -- it just
  // doesn't carry a bird (both fields null).
  const validBird = isValidBird(content.bird) ? content.bird : null;

  return {
    mark_id: dTag ?? event.id,
    author: event.pubkey,
    author_level: crowTag ? "real" : null,
    kind: isCaw ? "caw" : "mark",
    anchor_kind: kTag ?? "geo",
    geohash: longestG,
    lat: content.lat ?? null,
    lon: content.lon ?? null,
    accuracy_m: content.accuracy_m ?? null,
    visibility: "public",
    reveal: rvTag ?? (content.locked ? "locked" : "open"),
    content_text: truncateText(content.text),
    content_kind: content.content_kind ?? "none",
    content_ref: content.content_ref ?? null,
    created_at: event.created_at * 1000,
    expires_at: parseExpirationMs(expirationTag),
    nostr_event_id: event.id,
    origin: "remote",
    publish_state: "remote",
    crow_id: crowTag ?? null,
    bird_species: validBird ? validBird.species : null,
    bird_seed: validBird ? validBird.seed : null,
    author_name: sanitizeWorldName(content.name),
  };
}
