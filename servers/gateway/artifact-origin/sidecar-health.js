/**
 * Health of the artifact sidecar node (Crow Artifacts, step 1).
 *
 * The artifact origin gets its own hostname from a SIDECAR Tailscale node: a
 * second tailscaled (userspace networking, its own state and MagicDNS name)
 * whose Serve config proxies https://<instance>-artifacts.<tailnet>:443 to the
 * origin as the sidecar sees it from its OWN network namespace. Two things can
 * quietly go wrong there:
 *   - the node is logged out or its key expires: every artifact frame breaks;
 *   - its Serve config gains Funnel or another mapping: more than the origin
 *     is exposed (public links are a later step and bring their own rule).
 *
 * The third, worse failure is a sidecar sharing the HOST's network namespace
 * (`network_mode: host`). tailscaled's userspace netstack
 * (wgengine/netstack/netstack.go) forwards an inbound TCP connection on ANY
 * port of the node's tailnet address to 127.0.0.1:<same port> and dials it with
 * a plain Go dialer inside the namespace the sidecar runs in. Under host
 * networking that 127.0.0.1 is this computer's loopback, so every loopback port
 * here — the dashboard, an admin API, a database — answers the tailnet. A live
 * Serve Proxy whose host is 127.0.0.1, ::1 or localhost is exactly that shape,
 * so it is reported as `host-loopback`, never as a mere `unexpected-mapping`.
 *
 * `sidecarHealth()` is pure (fixture JSON in, problems out). The reader runs
 * the tailscale CLI against the sidecar's LocalAPI socket (no sudo) at most
 * every 5 minutes. Anything unreadable is a problem ("unreachable"), never ok.
 *
 * Problem codes: logged-out, key-expiring, funnel-on, host-loopback,
 * unexpected-mapping, unreachable.
 */
import { execFile } from "node:child_process";

export const KEY_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;
export const SIDECAR_READ_EVERY_MS = 5 * 60 * 1000;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function validPort(p) {
  const n = typeof p === "number" ? p : (typeof p === "string" && /^\d{1,5}$/.test(p) ? Number(p) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** Loopback as a Serve proxy target can spell it: the host-networking shape. */
export const LOOPBACK_PROXY_HOSTS = new Set(["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "localhost"]);

/** Addresses that are not "a specific non-loopback address": they publish everywhere. */
const WILDCARD_BINDS = new Set(["", "0.0.0.0", "::", "*", "0:0:0:0:0:0:0:0"]);

const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const IPV6_CHARS_RE = /^[0-9A-Fa-f:.]+$/;

/** A bare (lowercased) name, IPv4 or IPv6 literal — brackets stripped, never a port. */
function cleanHost(raw) {
  const h = String(raw ?? "").trim();
  if (!h) return null;
  if (h.startsWith("[") || h.endsWith("]")) {
    if (!(h.startsWith("[") && h.endsWith("]")) || h.length < 3) return null;
    const inner = h.slice(1, -1);
    return IPV6_CHARS_RE.test(inner) && inner.includes(":") ? inner.toLowerCase() : null;
  }
  // An IPv6 literal always has at least two colons; one colon is `host:port`.
  if ((h.match(/:/g) || []).length >= 2) return IPV6_CHARS_RE.test(h) ? h.toLowerCase() : null;
  return HOST_LABEL_RE.test(h) ? h.toLowerCase() : null;
}

/** Is this host loopback (127.0.0.1, ::1, localhost)? Brackets and case are ignored. */
export function isLoopbackHost(host) {
  const h = cleanHost(host);
  return h != null && LOOPBACK_PROXY_HOSTS.has(h);
}

/**
 * The one shape `{{ORIGIN_TARGET}}` may take: `http://<hostname|IPv4>:<port>`,
 * with no path, userinfo or query (IPv6 brackets optional).
 *
 * @returns {{ host: string, port: number, url: string } | null}
 */
export function parseOriginTarget(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s !== value) return null;   // no stray whitespace, no numbers
  const m = /^http:\/\/([^/?#@\s]+):(\d{1,5})$/.exec(s);
  if (!m) return null;                 // a scheme other than http, or a path/userinfo/query
  const host = cleanHost(m[1]);
  const port = validPort(m[2]);
  if (!host || !port) return null;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return { host, port, url: `http://${hostPart}:${port}` };
}

/**
 * The Serve Proxy target this instance's sidecar should have, and the problem
 * when there cannot be one:
 *   - `CROW_ARTIFACT_SIDECAR_TARGET` wins when set (it must parse, else it
 *     cannot be judged and the mapping is reported as unexpected);
 *   - else the origin is reached at `http://<CROW_ARTIFACT_ORIGIN_BIND>:<port>`
 *     when that bind is a specific, non-loopback address (a docker bridge
 *     gateway, a container name);
 *   - else the bind is loopback (or a wildcard, or unknown), and the only way a
 *     sidecar reaches a loopback origin is host networking: `host-loopback`.
 *
 * @param {{ target?: string|null, bind?: string|null, originPort?: number|string|null }} o
 * @returns {{ target: string|null, problem: string|null }}
 */
export function expectedSidecarTarget({ target = null, bind = null, originPort = null } = {}) {
  if (target != null && String(target).trim() !== "") {
    // An env value is trimmed, the way every other env read here is
    // (runtime.js); the SHAPE itself is then checked strictly.
    const t = parseOriginTarget(String(target).trim());
    return t ? { target: t.url, problem: null } : { target: null, problem: "unexpected-mapping" };
  }
  const port = validPort(originPort);
  if (!port) return { target: null, problem: "unexpected-mapping" };
  const raw = String(bind ?? "").trim();
  const bare = cleanHost(raw);
  if (bare == null || WILDCARD_BINDS.has(raw.replace(/^\[|\]$/g, "")) || isLoopbackHost(bare)) {
    return { target: null, problem: "host-loopback" };
  }
  const t = parseOriginTarget(`http://${bare.includes(":") ? `[${bare}]` : bare}:${port}`);
  return t ? { target: t.url, problem: null } : { target: null, problem: "unexpected-mapping" };
}

/** Every `Proxy` the live Serve config would forward to (Web host → handler → Proxy). */
function liveProxyTargets(cfg) {
  if (!isObj(cfg) || !isObj(cfg.Web)) return [];
  const out = [];
  for (const web of Object.values(cfg.Web)) {
    const handlers = isObj(web) && isObj(web.Handlers) ? web.Handlers : null;
    if (!handlers) continue;
    for (const h of Object.values(handlers)) if (isObj(h) && typeof h.Proxy === "string") out.push(h.Proxy);
  }
  return out;
}

/** The host of one `scheme://host[:port]` proxy value; null when there is none readable. */
function proxyHostOf(proxy) {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(String(proxy ?? "").trim());
  if (!m) return null;
  let hp = m[1].replace(/^.*@/, "");
  if (!hp) return null;
  if (hp.startsWith("[")) {
    const end = hp.indexOf("]");
    return end > 0 ? cleanHost(hp.slice(0, end + 1)) : null;
  }
  const colons = (hp.match(/:/g) || []).length;
  if (colons === 1) hp = hp.slice(0, hp.indexOf(":"));
  else if (colons > 1) hp = hp.slice(0, hp.lastIndexOf(":"));   // bare IPv6, port after it
  return cleanHost(hp);
}

/** True only for exactly one 443 HTTPS listener whose one "/" handler proxies to `target`. */
function mappingIsExpected(cfg, target) {
  if (typeof target !== "string" || !target) return false;
  if (!isObj(cfg)) return false;
  for (const k of Object.keys(cfg)) if (!["TCP", "Web", "AllowFunnel"].includes(k)) return false;   // Services, Foreground, …
  const tcp = isObj(cfg.TCP) ? cfg.TCP : null;
  if (!tcp || Object.keys(tcp).length !== 1 || !Object.hasOwn(tcp, "443")) return false;
  const l = tcp["443"];
  if (!isObj(l) || l.HTTPS !== true || Object.keys(l).some((k) => k !== "HTTPS")) return false;
  const web = isObj(cfg.Web) ? cfg.Web : null;
  const hosts = web ? Object.keys(web) : [];
  if (hosts.length !== 1 || !hosts[0].endsWith(":443")) return false;
  const handlers = isObj(web[hosts[0]]) && isObj(web[hosts[0]].Handlers) ? web[hosts[0]].Handlers : null;
  if (!handlers || Object.keys(handlers).length !== 1 || !Object.hasOwn(handlers, "/")) return false;
  const h = handlers["/"];
  return isObj(h) && Object.keys(h).length === 1 && h.Proxy === target;
}

/**
 * @param {{ statusJson: any, serveConfig: any, target?: string|null, bind?: string|null,
 *           originPort?: number|string|null, now?: number }} o
 *   statusJson: `tailscale status --json` of the sidecar; serveConfig: its
 *   `serve status -json` (the TS_SERVE_CONFIG shape: TCP / Web / AllowFunnel);
 *   target/bind/originPort are the instance's settings (expectedSidecarTarget).
 * @returns {{ ok: boolean, problems: string[], keyExpiry: string|null }}
 */
export function sidecarHealth({ statusJson, serveConfig, target = null, bind = null, originPort = null, now = Date.now() }) {
  if (!isObj(statusJson) || serveConfig == null) return { ok: false, problems: ["unreachable"], keyExpiry: null };
  const problems = [];
  if (statusJson.BackendState !== "Running") problems.push("logged-out");

  let keyExpiry = null;
  const raw = isObj(statusJson.Self) ? statusJson.Self.KeyExpiry : null;
  const at = typeof raw === "string" ? Date.parse(raw) : NaN;
  // Go's zero time (year 1) or an unparseable value: no expiry known.
  if (Number.isFinite(at) && at > Date.UTC(1971, 0, 1)) {
    keyExpiry = raw;
    if (at - now <= KEY_EXPIRY_WARN_MS) problems.push("key-expiring");
  }

  const funnel = isObj(serveConfig) && isObj(serveConfig.AllowFunnel) ? serveConfig.AllowFunnel : {};
  if (Object.values(funnel).some((v) => v === true)) problems.push("funnel-on");

  // Order matters: a loopback Proxy is the host-networking shape and says more
  // than "some other mapping" would, so it is reported INSTEAD of it. With a
  // loopback bind (or a wildcard/unknown one) there is no reachable target at
  // all, which is the same finding.
  const expected = expectedSidecarTarget({ target, bind, originPort });
  const liveLoopback = liveProxyTargets(serveConfig).some((p) => isLoopbackHost(proxyHostOf(p)));
  if (liveLoopback) problems.push("host-loopback");
  else if (expected.problem) problems.push(expected.problem);
  else if (!mappingIsExpected(serveConfig, expected.target)) problems.push("unexpected-mapping");

  return { ok: problems.length === 0, problems, keyExpiry };
}

/**
 * Render the shipped serve config template for one instance.
 *
 * `{{ORIGIN_TARGET}}` is the origin as the SIDECAR sees it, and it is never
 * loopback: see the header above. It accepts `http://<hostname|IPv4>:<port>`
 * and nothing else — no path, userinfo or query (IPv6 brackets optional) — and
 * throws otherwise. ${TS_CERT_DOMAIN} is left for tailscaled, which substitutes
 * its own MagicDNS name when it loads TS_SERVE_CONFIG.
 */
export function renderServeConfig(tmpl, { target } = {}) {
  const t = parseOriginTarget(target);
  if (!t) throw new Error("renderServeConfig: target must be http://<hostname|IPv4>:<port> (no path, userinfo or query)");
  return String(tmpl).replaceAll("{{ORIGIN_TARGET}}", t.url);
}

const defaultExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/**
 * A cached reader for the gateway. Returns null when this instance has no
 * sidecar configured (CROW_ARTIFACT_SIDECAR_SOCKET and CROW_ARTIFACT_ORIGIN_PORT
 * both needed), else the latest sidecarHealth() result, re-read at most every
 * 5 minutes. The expected target comes from CROW_ARTIFACT_SIDECAR_TARGET, else
 * from CROW_ARTIFACT_ORIGIN_BIND (see expectedSidecarTarget).
 */
export function createSidecarHealthReader({ env = process.env, exec = defaultExec, now = () => Date.now() } = {}) {
  let cache = null, cacheAt = 0;
  return async function readSidecarHealth() {
    const socket = env.CROW_ARTIFACT_SIDECAR_SOCKET;
    const originPort = validPort(env.CROW_ARTIFACT_ORIGIN_PORT);
    if (!socket || !originPort) return null;
    const t = now();
    if (cache && t - cacheAt < SIDECAR_READ_EVERY_MS) return cache;
    let result;
    try {
      const [st, sv] = await Promise.all([
        exec("tailscale", ["--socket", socket, "status", "--json"]),
        exec("tailscale", ["--socket", socket, "serve", "status", "-json"]),
      ]);
      result = sidecarHealth({
        statusJson: JSON.parse(st),
        serveConfig: JSON.parse(sv),
        target: env.CROW_ARTIFACT_SIDECAR_TARGET || null,
        bind: env.CROW_ARTIFACT_ORIGIN_BIND || null,
        originPort,
        now: t,
      });
    } catch {
      result = { ok: false, problems: ["unreachable"], keyExpiry: null };
    }
    cache = result; cacheAt = t;
    return result;
  };
}
