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

/** Strip control/format characters and parentheses (a name must not fake a nested label), trim, cap at 40. */
export function cleanPeerName(name) {
  return sanitizeActorName(String(name == null ? "" : name).replace(/[()]/g, ""), "");
}

/** The last 4 letters or digits of the id: stable, short, and shown in Settings next to the full id. */
export function idSuffix(id) {
  const s = String(id == null ? "" : id).replace(/[^A-Za-z0-9]/g, "");
  return s.slice(-4) || "0000";
}

const fold = (s) => s.normalize("NFKC").toLowerCase();

/**
 * The display name for peer `row` ({id, name}), given every OTHER crow_instances row (any status, this
 * instance's own row included) and this instance's own name.
 */
export function peerDisplayName(row, { others = [], ownName = null } = {}) {
  const base = cleanPeerName(row?.name);
  const suffix = idSuffix(row?.id);
  if (!base) return `peer${SEP}${suffix}`;
  const f = fold(base);
  const clash = others.some((o) => o && o.id !== row.id && fold(cleanPeerName(o.name)) === f)
    || (ownName != null && fold(cleanPeerName(ownName)) === f);
  return clash ? `${base}${SEP}${suffix}` : base;
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
