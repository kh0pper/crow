import { withinRange } from "./anchors.js";

export function anchorOf(row) {
  return { anchor_kind: row.anchor_kind, lat: row.lat, lon: row.lon, accuracy_m: row.accuracy_m, anchor_ref: row.anchor_ref, geohash: row.geohash };
}
export function teaser(row) {
  if (row.reveal !== "locked") return { ...row };
  const { content_text, content_ref, thumb_enc, locked_blob, ...safe } = row;
  return safe;
}
export function revealContent(row, here) {
  const content = { content_text: row.content_text, content_kind: row.content_kind, content_ref: row.content_ref };
  if (row.reveal !== "locked") return { unlocked: true, content };
  if (withinRange(anchorOf(row), here)) return { unlocked: true, content };
  return { unlocked: false, content: null };
}
