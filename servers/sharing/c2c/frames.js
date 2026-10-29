/**
 * Crow-to-Crow project frames: build and validate the `project.*` frames two
 * Crows exchange over the contact peer channel. Pure: no DB, no I/O.
 * Every field of an incoming payload is untrusted; parseFrame never throws.
 */

export const C2C_TYPE = "c2c";

export const PLAN1_KINDS = [
  "project.invite", "project.accept", "project.decline", "project.role",
  "project.unshare", "project.ack", "project.refuse",
];

export const REFUSALS = [
  "update_required", "not_home", "unsupported", "forbidden",
  "stale_epoch", "gap", "busy", "bad_frame",
];

export const ROLES = ["viewer", "commenter", "editor"];

export const BODY_CAPS = {
  "project.invite": 4096,
  "project.accept": 1024,
  "project.decline": 1024,
  "project.role": 1024,
  "project.unshare": 1024,
  "project.ack": 8192,
  "project.refuse": 1024,
};

const HEX32 = /^[0-9a-f]{32}$/;
const ID_MAX = 128;
const NO_SEQ = new Set(["project.ack", "project.refuse"]);

/** Build a frame envelope (no validation; callers validate via parseFrame in tests). */
export function buildFrame({ kind, projectUuid, epoch, seq, fromInstanceId, toInstanceId, body }) {
  const frame = {
    type: C2C_TYPE, v: 1, kind,
    project_uuid: projectUuid,
    epoch,
    seq,
    from_instance_id: fromInstanceId,
    to_instance_id: toInstanceId,
    body: body ?? {},
  };
  if (epoch === undefined) delete frame.epoch;
  if (seq === undefined) delete frame.seq;
  return frame;
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max;
const isSeq = (x) => Number.isSafeInteger(x) && x > 0;

function validBody(kind, b) {
  switch (kind) {
    case "project.invite":
      return isStr(b.name, 200) && ROLES.includes(b.role) && isStr(b.owner_instance_id, ID_MAX);
    case "project.accept":
      return isStr(b.visitor_instance_id, ID_MAX);
    case "project.decline":
      return b.reason === undefined || b.reason === "declined" || b.reason === "left";
    case "project.role":
      return ROLES.includes(b.role);
    case "project.unshare":
      return true;
    case "project.ack":
      return Array.isArray(b.seqs) && b.seqs.length <= 256 && b.seqs.every(isSeq);
    case "project.refuse":
      return isSeq(b.seq) && REFUSALS.includes(b.reason)
        && (b.detail === undefined || (typeof b.detail === "string" && b.detail.length <= 200));
    default:
      return false;
  }
}

/** @returns {{ok:true, frame:object}|{ok:false, reason:"bad_frame"|"unsupported"}} */
export function parseFrame(payload) {
  const bad = { ok: false, reason: "bad_frame" };
  try {
    if (!isObj(payload)) return bad;
    if (payload.type !== C2C_TYPE || payload.v !== 1) return bad;
    const { kind } = payload;
    if (typeof kind !== "string" || kind.length > 64) return bad;
    if (!PLAN1_KINDS.includes(kind)) return { ok: false, reason: "unsupported" };
    if (typeof payload.project_uuid !== "string" || !HEX32.test(payload.project_uuid)) return bad;
    if (!isStr(payload.from_instance_id, ID_MAX) || !isStr(payload.to_instance_id, ID_MAX)) return bad;
    const ackish = NO_SEQ.has(kind);
    if (ackish) {
      if (payload.seq !== undefined) return bad;
      if (payload.epoch !== undefined && !(typeof payload.epoch === "string" && HEX32.test(payload.epoch))) return bad;
    } else {
      if (!isSeq(payload.seq)) return bad;
      if (typeof payload.epoch !== "string" || !HEX32.test(payload.epoch)) return bad;
    }
    if (!isObj(payload.body)) return bad;
    if (Buffer.byteLength(JSON.stringify(payload.body)) > BODY_CAPS[kind]) return bad;
    if (!validBody(kind, payload.body)) return bad;
    return { ok: true, frame: payload };
  } catch {
    return bad;
  }
}
