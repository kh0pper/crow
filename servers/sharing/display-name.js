/**
 * sanitizeDisplayName — bound a remote-controlled, dashboard-rendered contact
 * display name (design §D5). Zero-import, pure: `string|null` in, `string|null`
 * out. This does NOT HTML-escape — escaping happens at the sinks; this strips
 * dangerous characters, blocks identity-string impersonation, and caps length.
 *
 * The value arrives from a handshake payload or a sync-apply and renders in the
 * dashboard, notification titles, logs and MCP tool text. A signature check
 * proves same-key, not honest content, so every ingress must run this.
 *
 * The seven rules, IN ORDER (order is load-bearing — strip before the prefix
 * check so a bidi-obfuscated `crow:` cannot slip through, and cap LAST):
 *   1. Non-string (incl. null/undefined) -> null.
 *   2. Strip C0 controls (U+0000-U+001F), DEL (U+007F), C1 controls
 *      (U+0080-U+009F). This removes \n \r \t and NUL — the point, for log
 *      injection.
 *   3. Strip Unicode bidi overrides + isolates (U+202A-U+202E, U+2066-U+2069);
 *      an RTL override rewrites how the surrounding row reads.
 *   4. Collapse internal whitespace runs to a single space; trim ends.
 *   5. Reject /^(crow|req):/i — a peer must not name itself an identity string
 *      (isPlaceholderName in contact-promote.js keys on exactly those prefixes).
 *   6. Cap at 64 characters, counted by Unicode code point (not UTF-16 unit,
 *      so an emoji is not sliced in half).
 *   7. Empty after all of the above -> null.
 */
export function sanitizeDisplayName(value) {
  // 1. Non-string.
  if (typeof value !== "string") return null;

  let s = value
    // 2. C0 controls, DEL, C1 controls -> removed.
    .replace(/[\x00-\x1F\x7F\x80-\x9F]/g, "")
    // 3. Bidi overrides + isolates -> removed.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")

  // 4. Collapse remaining whitespace runs, trim ends.
  s = s.replace(/\s+/g, " ").trim();

  // 5. Reject identity-string prefixes.
  if (/^(crow|req):/i.test(s)) return null;

  // 6. Cap at 64 code points (Array.from splits on code points, not UTF-16).
  const points = Array.from(s);
  if (points.length > 64) s = points.slice(0, 64).join("");

  // 7. Empty -> null.
  return s.length > 0 ? s : null;
}
