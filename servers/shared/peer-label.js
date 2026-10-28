/**
 * How a paired peer instance is named on content it writes here (item 46 follow-up, PR-A).
 *
 * A tool call from a peer (bearer-authenticated, PT-1) carries no proof of WHICH bot or person on the
 * peer made it, so it is labelled only as coming from that instance: "Crow (via <name>)". The name is
 * this instance's own crow_instances row for the peer. The peer chose that name when it enrolled, so it
 * is not unique: when it matches another row's name or this instance's own name (case-folded), or is
 * empty after cleaning, a short id suffix is added ("wren·1a2b"). Nothing a caller claims (tool
 * arguments, `_meta`) is ever used. A signed bot actor that upgrades this to "<bot> (bot from <name>)"
 * comes later, from the sending gateway (the private engineering notes).
 */
import { sanitizeActorName } from "../../scripts/pi-bots/actor-env.mjs";

const PEER_TOKEN = "peer-instance";
const SEP = "·";

// The suffix separator and characters that look like it. A name that contains one (after NFKC folding,
// which maps e.g. U+0387 and U+FF65 onto these) could imitate another peer's suffixed label, so it is
// rejected as a name (the peer is then shown as "peer·<id>").
const SEP_LOOKALIKES = /[\u00b7\u0387\u16eb\u2022\u2027\u2219\u22c5\u2981\u2e30\u2e31\u2e33\u30fb\ua78f\uff65\u1427\u0701\u0702]/u;

/** Strip control/format characters and parentheses (a name must not fake a nested label), trim, cap at 40.
 *  A name holding the suffix separator or a look-alike is rejected (""). */
export function cleanPeerName(name) {
  const clean = sanitizeActorName(String(name == null ? "" : name).replace(/[()]/g, ""), "");
  return SEP_LOOKALIKES.test(clean.normalize("NFKC")) ? "" : clean;
}

/** The last `n` letters or digits of the id: stable, short, and shown in Settings next to the full id. */
export function idSuffix(id, n = 4) {
  const s = String(id == null ? "" : id).replace(/[^A-Za-z0-9]/g, "");
  return (Number.isFinite(n) ? s.slice(-n) : s) || "0000";
}

const fold = (s) => s.normalize("NFKC").toLowerCase();

/** One row's label with an `n`-character suffix when it needs one (`needs`), else its bare name. */
function labelAt(base, id, needs, n) {
  if (!base) return `peer${SEP}${idSuffix(id, n)}`;
  return needs ? `${base}${SEP}${idSuffix(id, n)}` : base;
}

/**
 * The display name for peer `row` ({id, name}), given every OTHER crow_instances row (any status, this
 * instance's own row included) and this instance's own name. Two passes: a name that matches another
 * row's name or the own name (case-folded) is suffixed; then, if the resulting FINAL label still equals
 * another row's final label or the own name, the suffix grows (8 characters, then the whole id).
 */
export function peerDisplayName(row, { others = [], ownName = null } = {}) {
  const rows = [row, ...others.filter((o) => o && o.id !== row?.id)];
  const own = ownName != null ? fold(cleanPeerName(ownName)) : null;
  const bases = rows.map((r) => cleanPeerName(r?.name));
  const counts = new Map();
  for (const b of bases) if (b) counts.set(fold(b), (counts.get(fold(b)) || 0) + 1);
  const needs = bases.map((b) => !b || counts.get(fold(b)) > 1 || (own !== null && fold(b) === own));
  const othersFinal = new Set(rows.slice(1).map((r, i) => fold(labelAt(bases[i + 1], r.id, needs[i + 1], 4))));
  if (own) othersFinal.add(own);
  let label = labelAt(bases[0], row?.id, needs[0], 4);
  for (const n of [8, Infinity]) {
    if (!othersFinal.has(fold(label))) break;
    label = labelAt(bases[0], row?.id, true, n);
  }
  return label;
}

/**
 * Resolve the display name for an authenticated peer row from the DB. Fails toward the suffixed form:
 * if the other names cannot be read, a collision cannot be ruled out.
 */
export async function resolvePeerLabel(db, row, localId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT id, name FROM crow_instances WHERE id != ?", args: [String(row.id)] });
    const own = rows.find((r) => r.id === localId);
    return peerDisplayName(row, { others: rows, ownName: own ? own.name : null });
  } catch {
    const base = cleanPeerName(row?.name);
    return `${base || "peer"}${SEP}${idSuffix(row?.id)}`;
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
