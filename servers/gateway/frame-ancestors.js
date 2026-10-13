/**
 * CSP frame-ancestors for every gateway response: who may embed a gateway
 * page in a frame.
 *
 * The gateway itself ('self') and the SAME hostname on any https port. The
 * one cross-origin framer is the AI Companion, which is served from this
 * host on its own port and frames `https://<its hostname>:<gateway port>/…`
 * (bundles/companion/scripts/crow-wm.js). Any other site — the old rule was
 * `'self' https:`, i.e. every https origin — can no longer frame the
 * dashboard (clickjacking).
 *
 * The hostname comes from the request's Host header. That is safe here: for a
 * framed page the browser sets Host from the URL being framed, never from the
 * parent page, so a foreign parent cannot choose it. It is still validated as
 * a plain DNS name or IPv4 address before it is written into the header; any
 * other shape (IPv6 literal, empty, CSP syntax) falls back to 'self' only.
 */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function frameAncestorsFor(hostHeader) {
  const host = typeof hostHeader === "string" ? hostHeader.trim().toLowerCase().replace(/:\d{1,5}$/, "") : "";
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return "frame-ancestors 'self'";
  return `frame-ancestors 'self' https://${host}:*`;
}
