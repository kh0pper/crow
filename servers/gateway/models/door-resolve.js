// servers/gateway/models/door-resolve.js
/**
 * Door addressing (spec §5.1, §11.4). Pure: given the provider map (the
 * loadProviders() shape, ALREADY localized — an owned native row carries
 * baseUrl = loopback and doorUrl = its door) and the request's addressing
 * inputs, decide where a /llm request goes.
 *
 * Order: provider named by the path (/llm/p/<provider>/v1) or the
 * X-Crow-Provider header → qualified "<provider>/<model>" → a bare id that
 * matches exactly one forwardable non-companion row → companion heuristics.
 *
 * SECURITY (review C4): only rows Crow manages are forwardable — native,
 * external-engine, bundle — or rows that opt in with
 * gpu_policy.door_forward === true. A private address is never enough: any
 * paired peer can write base_url through sync. Link-local and cloud
 * metadata targets are refused for every row. The source-address and
 * Funnel checks live in the route (llm-router.js), not here.
 */
import { isIP } from "node:net";
import { isExternalEngine } from "../../shared/provider-engine.js";
import { classifyIp } from "../../shared/ip-classify.js";

export const DOOR_PROVIDER_HEADER = "x-crow-provider";
export const DOOR_HOP_HEADER = "x-crow-door-hop";

const FORBIDDEN_HOSTS = new Set([
  "169.254.169.254", "fd00:ec2::254", "100.100.100.200", "100.100.100.100",
  "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
]);

export function isDoorUrl(url) {
  // Case-insensitive: Express routes /LLM/v1 to the same handler (final review minor 1).
  try { return /\/llm(\/p\/[^/]+)?\/v1$/i.test(new URL(url).pathname.replace(/\/+$/, "")); } catch { return false; }
}

/** Canonical host for the blocklist (re-review N1): brackets off, lower-case,
 * ONE trailing dot stripped (`metadata.google.internal.`), and IPv4-mapped /
 * IPv4-compatible IPv6 unwrapped to IPv4. WHATWG URL rewrites
 * `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, and Node's dual-stack
 * socket still reaches the IPv4 metadata address through it. */
export function canonicalTargetHost(hostname) {
  let x = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (x.endsWith(".")) x = x.slice(0, -1);
  const dotted = x.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = x.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return x;
}

export function isForbiddenTarget(url) {
  let h;
  try { h = canonicalTargetHost(new URL(url).hostname); } catch { return true; }
  if (!h || FORBIDDEN_HOSTS.has(h)) return true;
  if (/^169\.254\./.test(h)) return true;                   // IPv4 link-local
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;           // IPv6 link-local
  return false;
}

export function doorKindOf(p) {
  if (!p) return "unmanaged";
  if (p.gpuPolicy?.runtime === "native") {
    return p.doorUrl || !isDoorUrl(p.baseUrl) ? "native-owned" : "native-foreign";
  }
  if (isExternalEngine(p)) return "external";
  if (p.bundleId) return "bundle";
  if (p.gpuPolicy?.door_forward === true) return "opt-in";
  return "unmanaged";
}

const forwardable = (p) => doorKindOf(p) !== "unmanaged";

function modelIdsOf(p) {
  return (Array.isArray(p?.models) ? p.models : []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
}

function forward(providers, providerId, modelId, hop) {
  const p = providers[providerId];
  if (!p) return { kind: "error", status: 404, code: "UNKNOWN_PROVIDER", message: `no enabled provider "${providerId}"` };
  const doorKind = doorKindOf(p);
  if (doorKind === "unmanaged") {
    return { kind: "error", status: 400, code: "NOT_FORWARDABLE", message: `provider "${providerId}" is not a Crow-managed local model (native, external engine or bundle) and has no door_forward opt-in` };
  }
  const ids = modelIdsOf(p);
  const mid = modelId || ids[0];
  if (!mid || !ids.includes(mid)) {
    return { kind: "error", status: 404, code: "MODEL_NOT_SERVED", message: `provider "${providerId}" does not serve "${modelId}"`, candidates: ids.map((i) => `${providerId}/${i}`) };
  }
  const url = String(p.baseUrl || "").replace(/\/+$/, "");
  if (!isForbiddenTarget(url) && !isLocalClassTarget(url)) {
    // Final review minor 2: a managed marker (door_forward, bundleId) on a
    // public-address row must not turn the door into a proxy for a paid cloud
    // key — the cloud allowlist is the consent gate, and the door has none.
    return { kind: "error", status: 400, code: "NOT_FORWARDABLE", message: `provider "${providerId}" is not on a loopback, private or tailnet address; the door never forwards to the internet` };
  }
  if (isForbiddenTarget(url)) {
    return { kind: "error", status: 400, code: "FORBIDDEN_TARGET", message: `provider "${providerId}" points at a link-local or metadata address; the door refuses it` };
  }
  // One door hop is the normal foreign-native case; a forward to another door
  // at hop >= 1, or ANY forward at hop >= 2 (every door forward now carries
  // hop+1), is a loop (final review minor 1).
  if ((isDoorUrl(url) && Number(hop) >= 1) || Number(hop) >= 2) {
    return { kind: "error", status: 508, code: "DOOR_LOOP", message: `refusing a second door hop to ${providerId}` };
  }
  return { kind: "forward", providerId, modelId: mid, url, apiKey: p.apiKey || "none", doorKind };
}

export function resolveDoorTarget({ providers = {}, providerHeader = null, model = null, companionModelIds = [], hop = 0 } = {}) {
  const header = typeof providerHeader === "string" && providerHeader.trim() ? providerHeader.trim() : null;
  const m = typeof model === "string" ? model.trim() : "";
  if (header) {
    const bare = m.startsWith(header + "/") ? m.slice(header.length + 1) : m;
    return forward(providers, header, bare || null, hop);
  }
  const slash = m.indexOf("/");
  if (slash > 0) {
    const pid = m.slice(0, slash);
    if (providers[pid]) return forward(providers, pid, m.slice(slash + 1), hop);
  }
  if (!m || companionModelIds.includes(m)) return { kind: "companion" };
  const candidates = Object.entries(providers).filter(([, p]) => forwardable(p) && modelIdsOf(p).includes(m)).map(([id]) => id);
  if (candidates.length === 0) return { kind: "companion" };
  if (candidates.length === 1) return forward(providers, candidates[0], m, hop);
  const defaults = candidates.filter((id) => providers[id]?.gpuPolicy?.defaultMember === true);
  if (defaults.length === 1) return forward(providers, defaults[0], m, hop);
  return {
    kind: "error", status: 400, code: "AMBIGUOUS_MODEL",
    message: `model "${m}" is served by more than one provider; use /llm/p/<provider>/v1, <provider>/<model>, or the ${DOOR_PROVIDER_HEADER} header`,
    candidates: candidates.map((id) => `${id}/${m}`),
  };
}

export function listDoorModels(providers = {}) {
  const out = [];
  for (const [pid, p] of Object.entries(providers)) {
    if (!forwardable(p) || isForbiddenTarget(p.baseUrl) || !isLocalClassTarget(p.baseUrl)) continue;
    const doorKind = doorKindOf(p);
    for (const mid of modelIdsOf(p)) out.push({ id: `${pid}/${mid}`, object: "model", owned_by: "crow", provider: pid, doorKind });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Loopback or the tailnet (Tailscale CGNAT 100.64.0.0/10, ULA fd7a:115c:a1e0::/48). */
export function isTrustedDoorSource(addr) {
  const a = String(addr || "").replace(/^::ffff:/i, "");
  if (a === "::1" || /^127\./.test(a)) return true;
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  return /^fd7a:115c:a1e0:/i.test(a);
}

/** Is this target on loopback, a private range, or the tailnet? Decided on the
 * host as an ADDRESS (never the display-only isPrivateHost), by the shared
 * classifier (servers/shared/ip-classify.js) on the expanded address, never on
 * a string prefix: IPv4 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10 (also in
 * their v4-mapped IPv6 spelling); IPv6 ::1 and fc00::/7 (incl. Tailscale's
 * fd7a:115c:a1e0::/48); the names `localhost` and `*.ts.net`. Not local:
 * link-local (isForbiddenTarget refuses it), the deprecated fec0::/10, an
 * IPv4 reached through a translator or tunnel (NAT64, 6to4, Teredo,
 * v4-compatible), and look-alikes such as `fc::1` (00fc::, outside fc00::/7).
 * Any other DNS name counts as public (final review minor 2). */
const LOCAL_CLASS = new Set(["loopback", "private", "cgnat", "ula"]);

export function isLocalClassTarget(url) {
  let h;
  try { h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return false; }
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".ts.net")) return true;
  const family = isIP(h);
  if (!family) return false;
  const { cls, v4, via } = classifyIp(h);
  if (via !== null && via !== "mapped") return false;
  if (!LOCAL_CLASS.has(cls)) return false;
  // "private" on a bare IPv6 address is fec0::/10 (deprecated site-local), not RFC 1918.
  if (cls === "private" && family === 6 && v4 === null) return false;
  return true;
}

/** One forwarding-header value -> the bare address it names, or null when it
 * names something that is not an address ("unknown", an obfuscated token). */
function bareForwardedAddr(v) {
  let x = String(v || "").trim().replace(/^"|"$/g, "");
  if (!x) return "";
  const br = x.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (br) return br[1];
  const v4port = x.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) return v4port[1];
  if (/^[0-9a-f:.]+$/i.test(x) && (x.includes(".") || x.includes(":"))) return x;
  return null;
}

function headerValues(h) {
  if (h == null) return [];
  return (Array.isArray(h) ? h : [h]).flatMap((v) => String(v).split(","));
}

/** Every address a request's forwarding headers name (X-Forwarded-For,
 * X-Real-IP, RFC 7239 Forwarded `for=`). `null` entries mark values that are
 * not addresses. Empty values are skipped. */
export function forwardedAddrs(headers = {}) {
  const out = [];
  for (const v of headerValues(headers["x-forwarded-for"])) { const a = bareForwardedAddr(v); if (a !== "") out.push(a); }
  for (const v of headerValues(headers["x-real-ip"])) { const a = bareForwardedAddr(v); if (a !== "") out.push(a); }
  for (const el of headerValues(headers["forwarded"])) {
    for (const pair of el.split(";")) {
      const m = pair.trim().match(/^for=(.*)$/i);
      if (m) { const a = bareForwardedAddr(m[1]); if (a !== "") out.push(a); }
    }
  }
  return out;
}

/** The ONE source check for /llm (door, companion /llm/v1, /llm/acquire).
 * `remoteAddr` is req.socket.remoteAddress — the TCP peer, which Express's
 * `trust proxy` setting (index.js sets 1) never changes; `req.ip` is the value
 * that setting rewrites from X-Forwarded-For, so it is never consulted here.
 * The socket must be loopback or tailnet, AND — because a same-box reverse
 * proxy (Tailscale Serve, or r4's sslip.io front door: black-swan Caddy ->
 * crow Serve :8449 -> r4 on loopback) makes every client look like loopback —
 * every address any forwarding header names must be loopback or tailnet too.
 * A header can only take trust away, never grant it (final review I1). */
export function isTrustedDoorRequest(remoteAddr, headers = {}) {
  if (!isTrustedDoorSource(remoteAddr)) return false;
  for (const a of forwardedAddrs(headers || {})) {
    if (a === null || !isTrustedDoorSource(a)) return false;
  }
  return true;
}
