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
 *    never in a cleaned name), then with 24 hex if they still collide. The base is cut (24, then 13
 *    characters) so the whole label always fits the 40-character comment-author cap.
 * Nothing a caller claims (tool arguments, `_meta`) is ever used. A bot actor signed by the sending GATEWAY
 * upgrades this to "<bot> (bot from <name>)" (PR-B, peerActorMeta below; the private engineering notes).
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
// Every label fits the 40-character author cap: a suffixed base is cut to 24 characters before " [8 hex]"
// (35 at most), and the rare second level cuts it to 13 before " [24 hex]" (40 at most).
const SUFFIXED = [null, { base: 24, hex: 8 }, { base: 13, hex: 24 }];
const cutBase = (base, n) => Array.from(base).slice(0, n).join("").trim() || "peer";
const labelAt = (base, id, level) => {
  if (level === 0) return base;
  const { base: n, hex } = SUFFIXED[level];
  return `${cutBase(base, n)} [${idSuffix(id, true).slice(0, hex)}]`;
};

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
 *
 * With `allowRemoteBot` (only a server that understands it: see remoteBotActorAllowed), a peer call whose
 * auth record carries a verified `remoteActor` (the peer GATEWAY signed which of its bots made the call,
 * servers/shared/remote-actor.js) for the bearer's own instance is forwarded as
 * `{ kind: "bot", id: "<bot>@<instance>", name, instance, from }` (`from` only when known). Consumers must
 * treat `kind: "bot"` WITH `instance` as a remote bot (never a local one, never the owner) and split the id
 * on the LAST "@". Anything else, or no option, is the peer form above.
 */
export function peerActorMeta(extra, { allowRemoteBot = false } = {}) {
  const auth = extra && extra.authInfo;
  if (!auth || auth.token !== PEER_TOKEN) return {};
  const cid = typeof auth.clientId === "string" && auth.clientId.startsWith("instance:") ? auth.clientId.slice(9) : "";
  const from = auth.extra && typeof auth.extra.peerName === "string" ? auth.extra.peerName : "";
  const ra = auth.extra && auth.extra.remoteActor;
  if (allowRemoteBot && cid && ra && typeof ra === "object" && ra.kind === "bot" && ra.instanceId === cid
    && typeof ra.id === "string" && ra.id && typeof ra.name === "string" && ra.name) {
    const actor = { kind: "bot", id: `${ra.id}@${cid}`, name: ra.name, instance: cid };
    if (from) actor.from = from;
    return { _meta: { "crow/actor": actor } };
  }
  const actor = { kind: "peer" };
  if (cid) actor.instance = cid;
  if (from) actor.from = from;
  return { _meta: { "crow/actor": actor } };
}

/**
 * Add-ons that understand the remote bot form of `crow/actor`, with the first version that does. An older
 * copy would read `kind: "bot"` as a LOCAL bot, so it keeps getting the peer form. Shared by the proxy's
 * add-on connect (servers/gateway/proxy.js) and, through the entry flag, router.js.
 */
export const REMOTE_BOT_ACTOR_MIN = Object.freeze({ workspace: "0.4.3" });

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** True only for a manifest `{ id, version }` in REMOTE_BOT_ACTOR_MIN at or above its version (plain x.y.z). */
export function remoteBotActorAllowed(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  const id = manifest.id;
  if (typeof id !== "string" || !Object.hasOwn(REMOTE_BOT_ACTOR_MIN, id)) return false;
  const v = SEMVER_RE.exec(typeof manifest.version === "string" ? manifest.version : "");
  const min = SEMVER_RE.exec(REMOTE_BOT_ACTOR_MIN[id]);
  if (!v || !min) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(v[i]), b = Number(min[i]);
    if (a !== b) return a > b;
  }
  return true;
}
