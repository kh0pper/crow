/**
 * How a paired peer instance is named on content it writes here (item 46 follow-up, PR-A).
 *
 * A tool call from a peer (bearer-authenticated, PT-1) carries no proof of WHICH bot or person on the
 * peer made it, so it is labelled only as coming from that instance: "Crow (via <name>)". The name is
 * this instance's own crow_instances row for the peer, which the peer chose when it enrolled, so:
 *  - it is cleaned to an ASCII allowlist (NFKC, default-ignorable code points removed, then only A-Z,
 *    a-z, 0-9, space, ".", "_" and "-"; spaces collapsed; 40 characters), and that exact string is shown;
 *    fewer than 2 letters or digits left is "peer", always suffixed (so a non-Latin name shows as
 *    "peer [hex]" in comment labels);
 *  - every row's final label is computed together, to a fixpoint: any two labels that are equal
 *    case-insensitively, trailing separators folded (and any label equal to this instance's own name) are all
 *    suffixed with the first 8 hex of sha256(id) in square brackets ("raven [1a2b3c4d]"; brackets are
 *    never in a cleaned name), then with the full 64 hex if they still collide.
 * Nothing a caller claims (tool arguments, `_meta`) is ever used. A signed bot actor that upgrades this
 * to "<bot> (bot from <name>)" comes later, from the sending gateway (the private engineering notes).
 */
import { createHash } from "node:crypto";

const PEER_TOKEN = "peer-instance";
const MAX_NAME = 40;

/** The cleaned, displayable name: ASCII letters, digits, space, ".", "_" and "-" only, or "" when fewer
 *  than 2 letters or digits are left (the caller then shows "peer"). Non-ASCII is dropped on purpose: it
 *  makes every bracket and look-alike impossible in a name, so no name can imitate a "[hex]" suffix. */
export function cleanPeerName(name) {
  const s = String(name == null ? "" : name)
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[^A-Za-z0-9 ._-]/g, " ")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return (s.match(/[A-Za-z0-9]/g) || []).length >= 2 ? s : "";
}

/** The id suffix: the first 8 hex of sha256(id), or all 64 with `full`. Distinct ids, distinct suffixes. */
export function idSuffix(id, full = false) {
  const h = createHash("sha256").update(String(id == null ? "" : id)).digest("hex");
  return full ? h : h.slice(0, 8);
}

/** The comparison key for labels (collision checks only; the displayed name stays as cleaned): lowercase,
 *  trailing separators and spaces folded away ("Raven." = "raven"), then a small ASCII confusable fold:
 *  0→o; 1, i and l → l; 5→s; rn→m; vv→w; cl→d ("Iark" = "1ark" = "lark", "h0me" = "home"). */
export function labelSkeleton(s) {
  return String(s).toLowerCase().replace(/[\s._-]+$/, "")
    .replace(/0/g, "o").replace(/[1il]/g, "l").replace(/5/g, "s")
    .replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
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
    // A name that cleaned to nothing is "peer", which says nothing on its own, so it is always suffixed.
    const base = cleanPeerName(r.name);
    list.push({ id: String(r.id), base: base || "peer", level: base ? 0 : 1 });
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
