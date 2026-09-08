/**
 * validateAvatar — bound a profile picture (spec 2026-09-08 §1, §4.1).
 * Zero-import, pure: `unknown` in, `string|null` out.
 *
 * A picture travels as an inline `data:` image: in the pairing handshake, in
 * the `profile` crow_social message, on the instance-sync contacts wire, and
 * it is rendered in the dashboard and the Ramble panel through `<img src>`
 * only (so an SVG cannot run script). The three rules, in order:
 *   1. non-string → null;
 *   2. longer than AVATAR_MAX_BYTES characters (the stored string) → null;
 *   3. must match AVATAR_RE: one of four image types, base64 payload only
 *      (no whitespace, no `<`, no second `data:`), nothing after it.
 * Every ingress runs this; every render trusts nothing else.
 */
export const AVATAR_MAX_BYTES = 32768;
export const AVATAR_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export function validateAvatar(value) {
  if (typeof value !== "string") return null;
  if (value.length > AVATAR_MAX_BYTES) return null;
  return AVATAR_RE.test(value) ? value : null;
}

/**
 * The contact editor's `avatar_url` field (a LOCAL override the user types;
 * Review R2-S5): "" clears; a valid inline avatar renders; a short http(s)
 * URL is kept for the user's own reference (the dashboard CSP never renders
 * it, contactAvatar skips it). Anything else — an oversize inline image, a
 * javascript: or data:text URL — is null (the editor answers 400, the sync
 * apply stores NULL). Bounded so a pasted multi-MB value never rides the
 * contacts wire.
 */
const URL_FIELD_RE = /^https?:\/\/[^\s]{1,2040}$/;
export function avatarFieldValue(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v === "") return "";
  if (validateAvatar(v)) return v;
  return URL_FIELD_RE.test(v) ? v : null;
}
