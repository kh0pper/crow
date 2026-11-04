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
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CTRL = /[\u0000-\u001f\u007f]/;
const NO_SEQ = new Set(["project.ack", "project.refuse"]);

/** Build a frame envelope. Undefined epoch/seq are omitted. */
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

const isObj = (x) => {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
};
const isId = (x) => typeof x === "string" && ID_RE.test(x);
// S3: an ack or refusal names its frame's stream the way the outbox does (streamOf):
// a target instance id, or "*" when the frame had none.
const isStream = (x) => x === "*" || isId(x);
const isEpoch = (x) => typeof x === "string" && HEX32.test(x);
const isText = (x, max) =>
  typeof x === "string" && x.length > 0 && x.length <= max && x.isWellFormed() && !CTRL.test(x);
const isSeq = (x) => Number.isSafeInteger(x) && x > 0;

/**
 * The fields every frame shares, checked before the kind-specific rules. An
 * unknown kind (a newer Crow's) never reaches cleanBody, but the receiver still
 * needs its stream address to consume the seq (R4), so parseFrame hands it back.
 * Null means the envelope itself is broken: bad_frame, with nothing to consume.
 */
function parseEnvelope(payload) {
  const { project_uuid, from_instance_id, to_instance_id, epoch, seq } = payload;
  if (typeof project_uuid !== "string" || !HEX32.test(project_uuid)) return null;
  if (!isId(from_instance_id) || !(to_instance_id === null || isId(to_instance_id))) return null;
  const envelope = { project_uuid, from_instance_id, to_instance_id };
  // A future kind may be unsequenced, so epoch and seq are optional here — but an
  // epoch without its seq cannot name a stream, and either one malformed is a
  // broken frame, not an unknown kind.
  if (epoch !== undefined) {
    if (typeof epoch !== "string" || !HEX32.test(epoch)) return null;
    envelope.epoch = epoch;
  }
  if (seq !== undefined) {
    if (!isSeq(seq)) return null;
    envelope.seq = seq;
  }
  return envelope;
}

/** Rebuild a body from known keys only; null when invalid. */
function cleanBody(kind, b) {
  switch (kind) {
    case "project.invite":
      // S2: gen is the owner's increasing invite generation: required, positive.
      return isText(b.name, 200) && ROLES.includes(b.role) && isId(b.owner_instance_id) && isSeq(b.gen)
        ? { name: b.name, role: b.role, owner_instance_id: b.owner_instance_id, gen: b.gen } : null;
    case "project.accept":
      return isId(b.visitor_instance_id) ? { visitor_instance_id: b.visitor_instance_id } : null;
    case "project.decline":
      if (b.reason === undefined) return {};
      return b.reason === "declined" || b.reason === "left" ? { reason: b.reason } : null;
    case "project.role":
      return ROLES.includes(b.role) ? { role: b.role } : null;
    case "project.unshare":
      return {};
    case "project.ack":
      // S3: the body names the stream it acks.
      return isEpoch(b.epoch) && isStream(b.stream)
        && Array.isArray(b.seqs) && b.seqs.length <= 256 && b.seqs.every(isSeq)
        ? { epoch: b.epoch, stream: b.stream, seqs: b.seqs.slice() } : null;
    case "project.refuse": {
      if (!isEpoch(b.epoch) || !isStream(b.stream) || !isSeq(b.seq) || !REFUSALS.includes(b.reason)) return null;
      const out = { epoch: b.epoch, stream: b.stream, seq: b.seq, reason: b.reason };
      if (b.detail !== undefined) {
        if (!(typeof b.detail === "string" && b.detail.length <= 200 && b.detail.isWellFormed() && !CTRL.test(b.detail))) return null;
        out.detail = b.detail;
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * Validate an untrusted payload. On success returns a REBUILT frame (known
 * fields only), never the raw payload. Never throws.
 * An unknown kind returns `unsupported` together with its parsed envelope (when
 * the envelope is valid) so the receive pipeline can consume its seq; a broken
 * envelope is `bad_frame` with no envelope (there is no stream to name).
 * @returns {{ok:true, frame:object}|{ok:false, reason:"bad_frame"|"unsupported", envelope?:object}}
 */
export function parseFrame(payload) {
  const bad = { ok: false, reason: "bad_frame" };
  try {
    if (!isObj(payload) || payload.type !== C2C_TYPE) return bad;
    if (payload.v !== 1) return { ok: false, reason: "unsupported" };
    const kind = payload.kind;
    if (typeof kind !== "string" || kind.length > 64) return bad;
    if (!PLAN1_KINDS.includes(kind)) {
      const envelope = parseEnvelope(payload);
      return envelope ? { ok: false, reason: "unsupported", envelope } : bad;
    }
    const { project_uuid, from_instance_id, to_instance_id, epoch, seq, body } = payload;
    if (typeof project_uuid !== "string" || !HEX32.test(project_uuid)) return bad;
    if (!isId(from_instance_id) || !(to_instance_id === null || isId(to_instance_id))) return bad;
    const frame = { type: C2C_TYPE, v: 1, kind, project_uuid };
    if (NO_SEQ.has(kind)) {
      // S3: an ack or refusal names its stream in the body only, so it carries
      // neither an envelope seq nor an envelope epoch. It also names the instance it
      // answers: its target is the answered frame's from_instance_id and is required
      // (a null target is a frame nobody could have sent it about).
      if (seq !== undefined || epoch !== undefined) return bad;
      if (!isId(to_instance_id)) return bad;
    } else {
      if (!isSeq(seq) || typeof epoch !== "string" || !HEX32.test(epoch)) return bad;
      frame.epoch = epoch;
      frame.seq = seq;
    }
    frame.from_instance_id = from_instance_id;
    frame.to_instance_id = to_instance_id;
    if (!isObj(body)) return bad;
    if (Buffer.byteLength(JSON.stringify(body)) > BODY_CAPS[kind]) return bad;
    const clean = cleanBody(kind, body);
    if (!clean) return bad;
    frame.body = clean;
    return { ok: true, frame };
  } catch {
    return bad;
  }
}
