/**
 * This gateway's address for paired instances, and the tailnet lookups that
 * repair a peer row the sync transport cannot dial.
 *
 * Root cause (black-swan's six-week stall, 2026-08..10): pairing handed peers
 * CROW_GATEWAY_URL when CROW_PEER_GATEWAY_URL was unset, and self-
 * registration fell back to "the first HTTPS URL" in `tailscale serve
 * status`. Both are typically the :443 endpoint — the public Funnel on crow
 * (which refuses private routes), a private Serve on black-swan — and
 * instance sync never dials :443. A peer that stored that URL with no
 * tailscale_ip had nothing to dial.
 *
 * Two separate things now travel at pairing:
 *   - gateway_url — the URL for browsers and HTTP peer calls (SSO, proxy):
 *       1. CROW_PEER_GATEWAY_URL (explicit override), else
 *       2. a NON-FUNNEL Serve HTTPS endpoint proxying "/" to our backend port
 *          (non-443 preferred; a private :443 Serve is fine for HTTP), else
 *       3. http://<own tailnet IP>:<backend port>.
 *     Never CROW_GATEWAY_URL (the PUBLIC URL: OAuth issuer, blog links).
 *   - tailscale_ip + sync_port — the direct backend dial the sync transport
 *     uses whenever gateway_url is not itself dialable (:443).
 *
 * Every probe is bounded (3 s) and never throws.
 */
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { getOwnTailnetIp } from "./tailnet-ip.js";

const PROBE_TIMEOUT_MS = 3000;

/** True for a Tailscale address: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip) {
  const v = String(ip || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (isIP(v) === 6) return /^fd7a:115c:a1e0:/.test(v);
  return false;
}

function parseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try { return new URL(s.includes("://") ? s : `https://${s}`); } catch { return null; }
}

function effectivePort(u) {
  return u.port ? parseInt(u.port, 10) : (u.protocol === "http:" ? 80 : 443);
}

/**
 * True when instance sync (and peer RPC) can use this gateway_url: http(s),
 * a real non-loopback, non-wildcard host, and NOT port 443 (Funnel / the
 * public door — the sync transport never dials it).
 */
export function isDialableGatewayUrl(raw) {
  const u = parseUrl(raw);
  if (!u?.hostname) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return false;
  if (host === "0.0.0.0" || host === "::") return false;
  return effectivePort(u) !== 443;
}

/** The hostname of a gateway_url (lower-case, no brackets), or null. */
export function gatewayUrlHost(raw) {
  const u = parseUrl(raw);
  return u?.hostname ? u.hostname.replace(/^\[|\]$/g, "").toLowerCase() : null;
}

/**
 * True when a gateway_url can be handed to a peer at all: http(s), a real,
 * non-loopback, non-wildcard host. Port 443 is fine HERE — a private :443
 * Serve (black-swan) is the right URL for browsers and HTTP peer calls; the
 * sync transport simply dials tailscale_ip + backend port instead of it.
 */
export function isPeerUsableUrl(raw) {
  const u = parseUrl(raw);
  if (!u?.hostname) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return false;
  return !(host === "0.0.0.0" || host === "::");
}

/**
 * From `tailscale serve status --json`: the private (non-Funnel) Serve HTTPS
 * endpoint that proxies "/" to localhost:<port>, or null. A non-443 endpoint
 * is preferred (the sync transport can dial it directly); a private :443 one
 * is still returned when it is the only one. Funnel-enabled host:ports are
 * never returned.
 */
export function serveUrlForPort(status, port) {
  if (!status || typeof status !== "object" || !port) return null;
  const funnel = status.AllowFunnel || {};
  const web = status.Web || {};
  const want = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${Number(port)}/?$`);
  const hits = [];
  for (const [hostPort, cfg] of Object.entries(web)) {
    const m = /^(.+):(\d+)$/.exec(hostPort);
    if (!m) continue;
    const servePort = Number(m[2]);
    if (funnel[hostPort]) continue;
    const proxy = cfg?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string" || !want.test(proxy)) continue;
    hits.push({ url: `https://${m[1].toLowerCase()}${servePort === 443 ? "" : `:${servePort}`}`, port: servePort });
  }
  // Non-443 first (directly dialable by sync), then by port: deterministic.
  hits.sort((x, y) => (x.port === 443) - (y.port === 443) || x.port - y.port);
  return hits[0]?.url || null;
}

function runJson(execImpl, args) {
  try {
    const out = execImpl("tailscale", args, { timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(String(out));
  } catch {
    return null;
  }
}

/**
 * This gateway's tailnet dial address: { gateway_url, tailscale_ip, sync_port,
 * source } (fields null when unknown). `source` names which rung produced
 * gateway_url: "configured" | "serve" | "tailnet-ip" | null.
 */
export function deriveSelfDialAddress({
  port, env = process.env, execFileSyncImpl = execFileSync, configuredUrl,
} = {}) {
  const backend = Number(port) > 0 && Number(port) < 65536 ? Number(port) : null;
  let tailscaleIp = null;
  // Only the real binary's answer is cached (tailnet-ip.js); an injected
  // probe (tests) must never poison or read that process-wide cache.
  try { tailscaleIp = getOwnTailnetIp({ env, execFileSyncImpl, cache: execFileSyncImpl === execFileSync }); } catch { tailscaleIp = null; }
  if (tailscaleIp && !isTailnetAddress(tailscaleIp) && !env.CROW_TAILNET_IP) tailscaleIp = null;
  const out = { gateway_url: null, tailscale_ip: tailscaleIp || null, sync_port: backend, source: null };
  if (configuredUrl) {
    out.gateway_url = configuredUrl;
    out.source = "configured";
    return out;
  }
  if (backend) {
    const serve = serveUrlForPort(runJson(execFileSyncImpl, ["serve", "status", "--json"]), backend);
    if (serve) {
      out.gateway_url = serve;
      out.source = "serve";
      return out;
    }
  }
  if (tailscaleIp && backend) {
    const host = tailscaleIp.includes(":") ? `[${tailscaleIp}]` : tailscaleIp;
    out.gateway_url = `http://${host}:${backend}`;
    out.source = "tailnet-ip";
  }
  return out;
}

/**
 * This node's MagicDNS tailnet suffix (`<tailnet>.ts.net`, lower-case, no
 * trailing dot) from `tailscale status --json` (MagicDNSSuffix, else
 * Self.DNSName minus its first label) — or null. Never throws.
 */
export function ownTailnetSuffix({ execFileSyncImpl = execFileSync, status } = {}) {
  const st = status ?? runJson(execFileSyncImpl, ["status", "--json"]);
  if (!st || typeof st !== "object") return null;
  const clean = (v) => String(v || "").toLowerCase().replace(/\.$/, "");
  const suffix = clean(st.MagicDNSSuffix || st.CurrentTailnet?.MagicDNSSuffix);
  if (suffix.endsWith(".ts.net")) return suffix;
  const name = clean(st.Self?.DNSName);
  const parts = name.split(".");
  return parts.length >= 4 && name.endsWith(".ts.net") ? parts.slice(1).join(".") : null;
}

/**
 * The tailnet IP (IPv4 preferred) of the tailnet node whose MagicDNS name is
 * `hostname`, from `tailscale status --json` — or null. Used to repair a peer
 * row that holds only an undialable :443 MagicDNS URL: the HOST is right, the
 * port is not, and tailscaled already knows the host's address.
 */
export function lookupTailnetIpForHost(hostname, { execFileSyncImpl = execFileSync, status } = {}) {
  const want = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!want || !want.endsWith(".ts.net")) return null;
  const st = status ?? runJson(execFileSyncImpl, ["status", "--json"]);
  if (!st || typeof st !== "object") return null;
  const nodes = [st.Self, ...Object.values(st.Peer || {})].filter(Boolean);
  for (const n of nodes) {
    const name = String(n.DNSName || "").toLowerCase().replace(/\.$/, "");
    if (name !== want) continue;
    const ips = (Array.isArray(n.TailscaleIPs) ? n.TailscaleIPs : []).filter(isTailnetAddress);
    return ips.find((ip) => isIP(ip) === 4) || ips[0] || null;
  }
  return null;
}

/** dashboard_settings_overrides key prefix for a peer's learned backend port (LOCAL scope, never synced). */
export const SYNC_PORT_KEY_PREFIX = "tailnet_sync_port:";
/** …and for "this peer has completed a challenge-response handshake with us" (downgrade guard). */
export const SYNC_CR_KEY_PREFIX = "tailnet_sync_cr:";

/**
 * Remember a peer's backend sync port (from pairing or a signed handshake)
 * as a local override. Returns true when the stored value changed. Never throws.
 */
export async function rememberPeerSyncPort(db, localInstanceId, peerId, port) {
  const n = Number(port);
  if (!db || !localInstanceId || !peerId || !Number.isInteger(n) || n <= 0 || n >= 65536) return false;
  try {
    const r = await db.execute({
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            WHERE dashboard_settings_overrides.value IS NOT excluded.value`,
      args: [`${SYNC_PORT_KEY_PREFIX}${peerId}`, localInstanceId, String(n)],
    });
    return Number(r.rowsAffected ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Pairing: the gateway_url to store for a peer — its advertised URL when
 * dialable, else the URL the operator typed when dialable, else whatever we
 * have (a MagicDNS host still lets the tailnet-sync boot repair resolve the
 * peer's tailnet IP).
 */
export function pickPeerGatewayUrl(advertised, typed) {
  if (advertised && isDialableGatewayUrl(advertised)) return String(advertised).replace(/\/+$/, "");
  if (typed && isDialableGatewayUrl(typed)) return String(typed).replace(/\/+$/, "");
  return advertised || typed || null;
}

/**
 * `tailscale status --json` via async execFile (never blocks the gateway
 * event loop), or null. The boot/refresh repair calls it ONCE per pass.
 */
export async function tailscaleStatusAsync({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(stdout))); } catch { resolve(null); }
    });
  });
}

/**
 * The OPERATOR's local re-pair (`crow instance pair`, run in a shell on this
 * host) resets what tailnet-sync learned about the peer's protocol: its
 * challenge-response pin (the downgrade guard) is cleared, so a peer
 * re-paired onto older code can link again. NEVER call this from an inbound
 * network request (e.g. /instance/enroll-request): that would let any caller
 * downgrade a pinned peer to the replayable legacy handshake. Never throws.
 */
export async function forgetPeerHandshakeState(db, localInstanceId, peerId) {
  if (!db || !localInstanceId || !peerId) return;
  try {
    await db.execute({
      sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
      args: [`${SYNC_CR_KEY_PREFIX}${peerId}`, localInstanceId],
    });
  } catch { /* table missing on an old DB */ }
}
