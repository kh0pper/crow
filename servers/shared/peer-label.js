/**
 * How a paired peer instance is named on content it writes here (item 46 follow-up, PR-A).
 *
 * A tool call from a peer (bearer-authenticated, PT-1) carries no proof of WHICH bot or person on the
 * peer made it, so it is labelled only as coming from that instance: "Crow (via <name>)". The name is
 * this instance's own crow_instances row for the peer, which the peer chose when it enrolled, so:
 *  - it is cleaned to an allowlist (NFKC, default-ignorable code points removed, then only letters,
 *    digits, space, ".", "_" and "-"; spaces collapsed; 40 characters), and that exact string is shown;
 *    an empty result is "peer";
 *  - every row's final label is computed together, to a fixpoint: any two labels that are equal under
 *    NFKC + lowercase + a homoglyph skeleton (and any label equal to this instance's own name) are all
 *    suffixed with the first 8 hex of sha256(id) in square brackets ("raven [1a2b3c4d]"; brackets are
 *    never in a cleaned name), then with the full 64 hex if they still collide.
 * Nothing a caller claims (tool arguments, `_meta`) is ever used. A signed bot actor that upgrades this
 * to "<bot> (bot from <name>)" comes later, from the sending gateway (the private engineering notes).
 */
import { createHash } from "node:crypto";

const PEER_TOKEN = "peer-instance";
const MAX_NAME = 40;

/** The cleaned, displayable name ("" when nothing allowed is left). */
export function cleanPeerName(name) {
  const s = String(name == null ? "" : name)
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[^\p{L}\p{N} ._-]/gu, " ")
    .replace(/ +/g, " ")
    .trim();
  return Array.from(s).slice(0, MAX_NAME).join("").trim();
}

/** The id suffix: the first 8 hex of sha256(id), or all 64 with `full`. Distinct ids, distinct suffixes. */
export function idSuffix(id, full = false) {
  const h = createHash("sha256").update(String(id == null ? "" : id)).digest("hex");
  return full ? h : h.slice(0, 8);
}

// Common Latin look-alikes in Cyrillic and Greek (lowercase), plus a few Latin digit/letter pairs.
const HOMOGLYPHS = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
  "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u051b": "q", "\u051d": "w", "\u04bb": "h",
  "\u04cf": "l", "\u0432": "b", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u0442": "t", "\u0457": "i",
  "\u0491": "r", "\u0261": "g",
  "\u03b1": "a", "\u03b5": "e", "\u03bf": "o", "\u03c1": "p", "\u03bd": "v", "\u03c4": "t", "\u03b9": "i",
  "\u03ba": "k", "\u03c7": "x", "\u03c5": "u", "\u03b7": "n", "\u03bc": "u", "\u03c9": "w", "\u03b2": "b",
  "0": "o", "1": "l", "i": "l",
};
/** The comparison key for labels: NFKC, lowercase, homoglyph skeleton, "rn"→"m", "vv"→"w", and trailing
 *  separator-class characters and spaces folded away ("raven." and "raven" are the same label). */
export function labelSkeleton(s) {
  return Array.from(String(s).normalize("NFKC").toLowerCase()).map((c) => HOMOGLYPHS[c] ?? c).join("")
    .replace(/rn/g, "m").replace(/vv/g, "w").replace(/[\s._\-\u00b7]+$/u, "");
}

// The suffix is in square brackets, which cleanPeerName can never produce, so no name can imitate one.
const labelAt = (base, id, level) => (level === 0 ? base : `${base} [${idSuffix(id, level === 2)}]`);

/**
 * Final labels for every row (Map id → label), to a fixpoint. `ownName` is a taken label: a row whose
 * label matches it is suffixed. Rows are deduplicated by id.
 */
export function peerLabels(rows, { ownName = null } = {}) {
  const list = [];
  const seen = new Set();
  for (const r of rows || []) {
    if (!r || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    list.push({ id: String(r.id), base: cleanPeerName(r.name) || "peer", level: 0 });
  }
  const own = ownName != null && cleanPeerName(ownName) ? labelSkeleton(cleanPeerName(ownName)) : null;
  for (let changed = true; changed;) {
    changed = false;
    const groups = new Map();
    for (const e of list) {
      const k = labelSkeleton(labelAt(e.base, e.id, e.level));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    for (const [k, g] of groups) {
      if (g.length < 2 && k !== own) continue;
      for (const e of g) if (e.level < 2) { e.level += 1; changed = true; }
    }
  }
  return new Map(list.map((e) => [e.id, labelAt(e.base, e.id, e.level)]));
}

/**
 * The display name for peer `row` ({id, name}), given the other crow_instances rows (any status) and this
 * instance's own name. Rows with id `ownId` are this instance itself: they count only through `ownName`.
 */
export function peerDisplayName(row, { others = [], ownName = null, ownId = null } = {}) {
  const rows = [row, ...others.filter((o) => o && String(o.id) !== String(row?.id) && (ownId == null || String(o.id) !== String(ownId)))];
  return peerLabels(rows, { ownName }).get(String(row?.id));
}

/**
 * Resolve the display name for an authenticated peer row from the DB. Fails toward the suffixed form:
 * if the other names cannot be read, a collision cannot be ruled out.
 */
export async function resolvePeerLabel(db, row, localId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT id, name FROM crow_instances WHERE id != ?", args: [String(row.id)] });
    const own = rows.find((r) => r.id === localId);
    return peerDisplayName(row, { others: rows, ownName: own ? own.name : null, ownId: localId });
  } catch {
    return labelAt(cleanPeerName(row?.name) || "peer", String(row?.id), 1);
  }
}

/**
 * The `_meta` a gateway forwards to the server it calls for a peer's tool call:
 * `{ kind: "peer", instance, from }` (only the fields it knows), or `{}` for any non-peer caller.
 * Built only from the server-side auth record (req.auth, set by mountMcpServer), never from the call.
 */
export function peerActorMeta(extra) {
  const auth = extra && extra.authInfo;
  if (!auth || auth.token !== PEER_TOKEN) return {};
  const actor = { kind: "peer" };
  const cid = typeof auth.clientId === "string" && auth.clientId.startsWith("instance:") ? auth.clientId.slice(9) : "";
  if (cid) actor.instance = cid;
  const from = auth.extra && typeof auth.extra.peerName === "string" ? auth.extra.peerName : "";
  if (from) actor.from = from;
  return { _meta: { "crow/actor": actor } };
}
