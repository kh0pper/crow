/**
 * This gateway's TAILNET dial address — what a paired instance should dial to
 * reach it — and the tailnet lookups that repair a peer row pointing at an
 * undialable address.
 *
 * Root cause this replaces (black-swan's six-week stall, 2026-08..10): pairing
 * handed peers CROW_GATEWAY_URL when CROW_PEER_GATEWAY_URL was unset, and the
 * gateway's own self-registration fell back to "the first HTTPS URL" in
 * `tailscale serve status`. Both are typically the :443 endpoint — public
 * Funnel on crow, a private Serve on black-swan — and instance sync never
 * dials :443 (Funnel refuses private routes; see peerToWsUrlCandidates). A
 * peer that stored that URL, with no tailscale_ip, had nothing to dial.
 *
 * Derivation order (deriveSelfDialAddress):
 *   1. CROW_PEER_GATEWAY_URL — the operator's explicit override, used as-is.
 *   2. A Tailscale Serve HTTPS endpoint that proxies "/" to THIS gateway's
 *      backend port, is not Funnel-enabled, and is not on :443.
 *   3. http://<own tailnet IP>:<backend port> — the direct backend dial.
 * Never CROW_GATEWAY_URL: that is the PUBLIC URL (OAuth issuer, blog links).
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
 * From `tailscale serve status --json`: the private Serve HTTPS endpoint that
 * proxies "/" to localhost:<port>, or null. Funnel-enabled host:ports and
 * :443 are skipped (never a sync dial target).
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
    if (servePort === 443 || funnel[hostPort]) continue;
    const proxy = cfg?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string" || !want.test(proxy)) continue;
    hits.push({ url: `https://${m[1].toLowerCase()}:${servePort}`, port: servePort });
  }
  hits.sort((x, y) => x.port - y.port); // deterministic
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
