/**
 * Peer instance ids — the ONE identity a per-peer grant may be keyed by.
 *
 * N1b-8 (security audit): a one-click "Allow" card must never widen a
 * capability to every peer. The grant is recorded against the peer that asked,
 * and the peer's identity is the id the request was VERIFIED with
 * (`req.instanceAuth.instance.id`, resolved from the bearer token hash by
 * `validateInstanceToken`) — never a name, hostname or id a request body
 * asserts about itself.
 *
 * The shape is the one enrollment already enforces on `source_instance_id`
 * (servers/gateway/routes/instance-enroll.js, ID_RE): [A-Za-z0-9._:-], 1..128
 * characters. Anything else (an object, a display name with spaces, an empty
 * string, a `__proto__`-style key) is not a peer id and must be refused rather
 * than used as a JSON object key.
 */
const PEER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * @param {unknown} raw
 * @returns {string|null} the trimmed id when it is id-shaped, else null.
 */
export function normalizePeerId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!PEER_ID_RE.test(id)) return null;
  // The regex allows `_`, so `__proto__`-style names DO pass it: this guard is
  // what keeps them from becoming JSON object keys.
  if (id === "__proto__" || id === "prototype" || id === "constructor") return null;
  return id;
}