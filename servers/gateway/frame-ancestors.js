/**
 * CSP frame-ancestors for every gateway response: who may embed a gateway
 * page in a frame.
 *
 * The gateway itself ('self'), the SAME hostname on any https port, and the
 * hostnames of trusted paired instances. The cross-origin framers are the AI
 * Companion: served from this host on its own port, it frames
 * `https://<its hostname>:<gateway port>/…`, and its federation windows frame
 * a trusted peer's gateway at `https://<peer hostname>/proxy/…`
 * (bundles/companion/scripts/crow-wm.js). Any other site — the old rule was
 * `'self' https:`, i.e. every https origin — can no longer frame the
 * dashboard (clickjacking).
 *
 * The own hostname comes from the request's Host header. That is safe here:
 * for a framed page the browser sets Host from the URL being framed, never
 * from the parent page, so a foreign parent cannot choose it. Every hostname
 * is still validated as a plain DNS name or IPv4 address before it is written
 * into the header; any other shape (IPv6 literal, empty, CSP syntax) is
 * dropped, and an unusable Host falls back to 'self'.
 */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const MAX_PEERS = 32;

export function normalizeFrameHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (!host || host === "null" || host.length > 253 || !HOSTNAME_RE.test(host)) return null;
  return host;
}

export function frameAncestorsFor(hostHeader, peerHosts = []) {
  const own = normalizeFrameHost(hostHeader);
  const hosts = own ? [own] : [];
  for (const p of Array.isArray(peerHosts) ? peerHosts.slice(0, MAX_PEERS) : []) {
    const h = normalizeFrameHost(p);
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  return ["frame-ancestors 'self'", ...hosts.map((h) => `https://${h}:*`)].join(" ");
}

/**
 * The trusted peers' hostnames, cached. get() never waits: it returns the
 * last list and, when that is older than ttlMs, starts one background
 * refresh. A failed load keeps the previous list.
 */
export function createPeerFrameHosts(loadHosts, { ttlMs = 60_000, now = Date.now } = {}) {
  let hosts = [];
  let at = -Infinity;
  let inflight = null;
  return {
    get() {
      if (!inflight && now() - at >= ttlMs) {
        at = now();
        inflight = Promise.resolve()
          .then(loadHosts)
          .then((list) => { if (Array.isArray(list)) hosts = list.map(normalizeFrameHost).filter(Boolean); })
          .catch(() => {})
          .finally(() => { inflight = null; });
      }
      return hosts;
    },
    refreshed() { return inflight || Promise.resolve(); },
  };
}
