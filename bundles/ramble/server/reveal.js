import { withinRange } from "./anchors.js";

export function anchorOf(row) {
  return { anchor_kind: row.anchor_kind, lat: row.lat, lon: row.lon, accuracy_m: row.accuracy_m, anchor_ref: row.anchor_ref, geohash: row.geohash };
}
export function teaser(row) {
  if (row.reveal === "open") return { ...row };
  // For locked (or any non-open value): return only safe fields
  const allowed = ["mark_id", "author", "author_level", "kind", "anchor_kind", "geohash", "reveal", "visibility", "created_at", "expires_at", "content_kind", "origin", "publish_state", "bird_species", "bird_seed"];
  const safe = {};
  for (const field of allowed) {
    if (field in row) safe[field] = row[field];
  }
  return safe;
}
export function revealContent(row, here) {
  const content = { content_text: row.content_text, content_kind: row.content_kind, content_ref: row.content_ref };
  if (row.reveal === "open") return { unlocked: true, content };
  if (withinRange(anchorOf(row), here)) return { unlocked: true, content };
  return { unlocked: false, content: null };
}
