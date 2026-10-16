/**
 * Kiosk B3: the hand-off protocol between the Talk to Crow frame (/display/session?bar=1) and the
 * dashboard's player bar. The frame posts `{ crow: "media", v: 1, op, … }` to its parent; the parent
 * (crow-talk.js) acts on one only after checking origin + source and running validateFrameMessage.
 *
 * Every op except `load` names the item id it is about, so a stale message can never touch whatever
 * the bar plays now. The ticket path must be exactly a kiosk display-ticket stream path: relative,
 * no host, no query, no `..` (the kiosk's TICKET_ID inside `/display/t/…/stream`; a test keeps the two
 * in step). Anything else is dropped whole: the result is a fresh plain object or null.
 *
 * validatorSource() is the function's own text, prefixed by the constants it reads, for embedding in
 * the dashboard's emitted script: the tested code and the shipped code are the same text. It must
 * therefore stay free of backticks and template placeholders (the dashboard script is itself a
 * template literal), and read nothing from module scope except the constants emitted with it.
 */
export const KIOSK_MEDIA_V = 1;
export const FRAME_OPS = Object.freeze(["load", "play", "pause", "volume", "stop"]);
export const TICKET_PATH_RE = /^\/display\/t\/[A-Za-z0-9_-]{22}\/stream$/;
export const ITEM_ID_RE = /^m\d{1,9}$/;
export const FRAME_TEXT_MAX = 80;
export const FRAME_SOURCE_MAX = 16;

export function validateFrameMessage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return null;
  if (data.crow !== "media" || data.v !== KIOSK_MEDIA_V) return null;
  const op = data.op;
  if (typeof op !== "string" || FRAME_OPS.indexOf(op) < 0) return null;
  const allowed = {
    load: ["crow", "v", "op", "id", "url", "title", "subtitle", "source", "live", "volume", "paused", "has_next", "has_previous"],
    play: ["crow", "v", "op", "id"],
    pause: ["crow", "v", "op", "id"],
    volume: ["crow", "v", "op", "id", "volume"],
    stop: ["crow", "v", "op", "id"],
  }[op];
  const keys = Object.getOwnPropertyNames(data);
  for (let i = 0; i < keys.length; i++) if (allowed.indexOf(keys[i]) < 0) return null;
  if (typeof data.id !== "string" || !ITEM_ID_RE.test(data.id)) return null;
  const text = (v, max) => (v === undefined ? "" : typeof v === "string" && v.length <= max ? v : null);
  const flag = (v) => (v === undefined ? false : typeof v === "boolean" ? v : null);
  const level = (v, dflt) => (v === undefined ? dflt : typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  if (op === "play" || op === "pause" || op === "stop") return { op: op, id: data.id };
  if (op === "volume") {
    if (data.volume === undefined) return null;
    const volume = level(data.volume, 1);
    return volume === null ? null : { op: op, id: data.id, volume: volume };
  }
  if (typeof data.url !== "string" || !TICKET_PATH_RE.test(data.url)) return null;
  if (typeof data.title !== "string") return null;
  const out = {
    op: op, id: data.id, url: data.url,
    title: text(data.title, FRAME_TEXT_MAX), subtitle: text(data.subtitle, FRAME_TEXT_MAX), source: text(data.source, FRAME_SOURCE_MAX),
    live: flag(data.live), volume: level(data.volume, 1), paused: flag(data.paused), has_next: flag(data.has_next), has_previous: flag(data.has_previous),
  };
  for (const k in out) if (out[k] === null) return null;
  return out;
}

/** The validator and the constants it reads, as plain script text (see the header). */
export function validatorSource() {
  return [
    "var KIOSK_MEDIA_V = " + KIOSK_MEDIA_V + ";",
    "var FRAME_OPS = " + JSON.stringify(FRAME_OPS) + ";",
    "var TICKET_PATH_RE = " + TICKET_PATH_RE.toString() + ";",
    "var ITEM_ID_RE = " + ITEM_ID_RE.toString() + ";",
    "var FRAME_TEXT_MAX = " + FRAME_TEXT_MAX + ";",
    "var FRAME_SOURCE_MAX = " + FRAME_SOURCE_MAX + ";",
    validateFrameMessage.toString(),
  ].join("\n");
}
