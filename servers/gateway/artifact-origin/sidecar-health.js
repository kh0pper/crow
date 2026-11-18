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
 * (`network_mode: host` — or `service:<x>` / `container:<x>`, which borrow
 * another container's namespace and are the same shape by another name).
 * tailscaled's userspace netstack (wgengine/netstack/netstack.go) forwards an
 * inbound TCP connection on ANY port of the node's tailnet address to
 * 127.0.0.1:<same port> and dials it with a plain Go dialer inside the
 * namespace the sidecar runs in. Under host networking that 127.0.0.1 is this
 * computer's loopback, so every loopback port here — the dashboard, an admin
 * API, a database — answers the tailnet. That shape is caught from BOTH ends:
 *   - a Serve Proxy target that names this machine in ANY spelling a dialer
 *     accepts (`127.0.0.2`, `127.1`, `localhost`, `localhost.`, `::1`,
 *     `::ffff:127.0.0.1`, a bare `3090` …) is `host-loopback`, never a mere
 *     `unexpected-mapping`;
 *   - and, ACTIVELY, the reader connects to the sidecar's own tailnet address
 *     on this gateway's HTTP port: netstack completes that connect only after
 *     its backend dial to 127.0.0.1:<port> succeeded, so a completed connect
 *     IS a shared namespace (`sidecarSharesHostLoopback`). A refused connect
 *     or a timeout is the sidecar's own namespace.
 *
 * `sidecarHealth()` is pure (fixture JSON in, problems out). The reader runs
 * the tailscale CLI against the sidecar's LocalAPI socket (no sudo) plus the
 * probe above, at most every 5 minutes. Anything unreadable is a problem
 * ("unreachable"), never ok.
 *
 * Problem codes: logged-out, key-expiring, funnel-on, host-loopback,
 * unexpected-mapping, unreachable.
 */
import { execFile } from "node:child_process";
import net from "node:net";
import { gatewayListenPort } from "../listen-port.js";

export const KEY_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;
export const SIDECAR_READ_EVERY_MS = 5 * 60 * 1000;
/** How long the netns probe may take to connect (a netstack answer is immediate). */
export const NETNS_PROBE_TIMEOUT_MS = 2000;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function validPort(p) {
  const n = typeof p === "number" ? p : (typeof p === "string" && /^\d{1,5}$/.test(p) ? Number(p) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const IPV6_CHARS_RE = /^[0-9A-Fa-f:.]+$/;

/** A bare (lowercased) name, IPv4 or IPv6 literal — brackets stripped, never a port.
 *  A single trailing dot (the rooted spelling, `localhost.`) is dropped. */
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
  const rooted = h.endsWith(".") ? h.slice(0, -1) : h;
  return HOST_LABEL_RE.test(rooted) ? rooted.toLowerCase() : null;
}

/** `127.0.0.0/8` (all of it: a dialer routes every 127.x to loopback) or `0.0.0.0`. */
function isLoopbackOrWildcardV4(dotted) {
  return dotted === "0.0.0.0" || dotted.startsWith("127.");
}

/**
 * `::1`, `::` (publishes everywhere), and the IPv4-mapped forms
 * (`::ffff:127.0.0.1`, `::ffff:0.0.0.0`) — as WHATWG URL serialises them.
 */
function isLoopbackOrWildcardV6(normalised) {
  if (normalised === "::1" || normalised === "::") return true;
  if (!normalised.startsWith("::ffff:")) return false;
  const tail = normalised.slice("::ffff:".length);
  if (net.isIPv4(tail)) return isLoopbackOrWildcardV4(tail);          // kept dotted by some serialisers
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!m) return false;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return isLoopbackOrWildcardV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
}

/**
 * Is this host THIS MACHINE, or a wildcard that publishes everywhere?
 *
 * One helper for every place the question is asked (a live Serve Proxy target,
 * an explicit `CROW_ARTIFACT_SIDECAR_TARGET`, a derived bind, a rendered serve
 * config), because chasing a list of spellings is how `127.0.0.2`, `127.1`,
 * `0.0.0.0` or `[::ffff:127.0.0.1]` slipped past the old exact-match set.
 *
 * Covers, in any form a dialer accepts:
 *   - all of `127.0.0.0/8` — dotted, short (`127.1`), decimal (`2130706433`) and
 *     hex/octal (`0x7f.1`, `0177.0.0.1`), all normalised through WHATWG URL
 *     parsing, which is what a browser and tailscaled's own URL parser do;
 *   - `0.0.0.0` and `::` (publish everywhere, so a sidecar reaching one is
 *     reaching the host's own stack);
 *   - `::1` in any expansion, and the IPv4-mapped `::ffff:127.*` /
 *     `::ffff:0.0.0.0` forms;
 *   - the names `localhost`, `localhost.` and anything `*.localhost`.
 * Brackets, case and a trailing root dot are ignored; anything unreadable is
 * not loopback (callers treat an unreadable shape the way their contract says).
 */
export function isLoopbackOrWildcardHost(host) {
  const h = cleanHost(host);
  if (h == null) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  let norm;
  try { norm = new URL(`http://${h.includes(":") ? `[${h}]` : h}/`).hostname.replace(/^\[|\]$/g, ""); }
  catch { return false; }                                            // not a host literal at all
  const fam = net.isIP(norm);
  if (fam === 4) return isLoopbackOrWildcardV4(norm);
  if (fam === 6) return isLoopbackOrWildcardV6(norm);
  return false;
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
 *   - `CROW_ARTIFACT_SIDECAR_TARGET` wins when set (it must parse, and a
 *     loopback/wildcard host in it is the same host-networking shape as a
 *     loopback bind, so it cannot be judged reachable either);
 *   - else the origin is reached at `http://<CROW_ARTIFACT_ORIGIN_BIND>:<port>`
 *     when that bind is a specific, non-loopback address (a docker bridge
 *     gateway, a container name);
 *   - else the bind is loopback in any spelling (or a wildcard, or unknown),
 *     and the only way a sidecar reaches a loopback origin is host networking:
 *     `host-loopback`.
 *
 * @param {{ target?: string|null, bind?: string|null, originPort?: number|string|null }} o
 * @returns {{ target: string|null, problem: string|null }}
 */
export function expectedSidecarTarget({ target = null, bind = null, originPort = null } = {}) {
  if (target != null && String(target).trim() !== "") {
    // An env value is trimmed, the way every other env read here is
    // (runtime.js); the SHAPE itself is then checked strictly.
    const t = parseOriginTarget(String(target).trim());
    if (!t) return { target: null, problem: "unexpected-mapping" };
    if (isLoopbackOrWildcardHost(t.host)) return { target: null, problem: "host-loopback" };
    return { target: t.url, problem: null };
  }
  const port = validPort(originPort);
  if (!port) return { target: null, problem: "unexpected-mapping" };
  const raw = String(bind ?? "").trim();
  const bare = cleanHost(raw);
  // Loopback in ANY spelling, a wildcard (0.0.0.0, ::) or a shape nobody can
  // read: there is no non-loopback target a sidecar could reach.
  if (bare == null || isLoopbackOrWildcardHost(raw)) return { target: null, problem: "host-loopback" };
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

/**
 * The host of one Serve Proxy value: `scheme://host[:port]`, or tailscaled's
 * own shorthand `host:port` / `port` (a value with no scheme); null when
 * there is none readable. Brackets are stripped.
 */
function proxyHostOf(proxy) {
  const s = String(proxy ?? "").trim();
  if (!s) return null;
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(s);
  let hp = (m ? m[1] : s.replace(/[?#].*$/, "")).replace(/^.*@/, "");
  if (!hp) return null;
  if (hp.startsWith("[")) {
    const end = hp.indexOf("]");
    return end > 0 ? cleanHost(hp.slice(0, end + 1)) : null;
  }
  const colons = (hp.match(/:/g) || []).length;
  if (colons === 1) hp = hp.slice(0, hp.indexOf(":"));
  else if (colons > 1) hp = hp.slice(0, hp.lastIndexOf(":"));   // bare IPv6, port after it
  return cleanHost(hp);   // a rooted name (`localhost.`) is dropped by cleanHost
}

/**
 * Does a live Serve Proxy value point at this computer's loopback?
 *
 * `tailscale serve` takes more than a URL: a bare port (`3090`) and
 * `localhost:3090` both proxy 127.0.0.1, so a target with no scheme has to be
 * judged too — otherwise the oldest, easiest host-networking mapping would be
 * the one spelling the audit missed.
 */
function proxyIsLoopback(proxy) {
  const s = String(proxy ?? "").trim();
  if (!s) return false;
  // A bare port is tailscaled's shorthand for 127.0.0.1:<port> (and "3090" is
  // also a legal decimal IPv4, 0.0.12.18, so this check has to come first).
  if (/^\d{1,5}$/.test(s)) return true;
  return isLoopbackOrWildcardHost(proxyHostOf(s));
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
 *           originPort?: number|string|null, sharedLoopback?: boolean, now?: number }} o
 *   statusJson: `tailscale status --json` of the sidecar; serveConfig: its
 *   `serve status -json` (the TS_SERVE_CONFIG shape: TCP / Web / AllowFunnel);
 *   target/bind/originPort are the instance's settings (expectedSidecarTarget);
 *   sharedLoopback is the active probe's verdict (sidecarSharesHostLoopback).
 * @returns {{ ok: boolean, problems: string[], keyExpiry: string|null }}
 */
export function sidecarHealth({ statusJson, serveConfig, target = null, bind = null, originPort = null, sharedLoopback = false, now = Date.now() }) {
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
  // than "some other mapping" would, so it is reported INSTEAD of it. The same
  // finding comes from the active probe (the sidecar's own tailnet address
  // answered this gateway's loopback port) and from a loopback bind (or a
  // wildcard/unknown one), where no reachable target exists at all.
  const expected = expectedSidecarTarget({ target, bind, originPort });
  const liveLoopback = liveProxyTargets(serveConfig).some(proxyIsLoopback);
  if (liveLoopback || sharedLoopback === true) problems.push("host-loopback");
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
 * throws otherwise. A target that names this machine in any spelling, or a
 * wildcard that publishes everywhere, throws too (render time is the only
 * place the mistake can be caught before tailscaled serves it).
 * ${TS_CERT_DOMAIN} is left for tailscaled, which substitutes its own MagicDNS
 * name when it loads TS_SERVE_CONFIG.
 */
export function renderServeConfig(tmpl, { target } = {}) {
  const t = parseOriginTarget(target);
  if (!t) throw new Error("renderServeConfig: target must be http://<hostname|IPv4>:<port> (no path, userinfo or query)");
  if (isLoopbackOrWildcardHost(t.host)) {
    throw new Error("renderServeConfig: target must not be loopback or a wildcard address — the sidecar needs its own network namespace (see docs/architecture/artifacts.md)");
  }
  return String(tmpl).replaceAll("{{ORIGIN_TARGET}}", t.url);
}

const defaultExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** TCP connect that resolves on `connect` and rejects on error or timeout. */
const defaultConnect = (host, port, timeoutMs = NETNS_PROBE_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const sock = net.connect({ host, port });
  const finish = (err) => {
    sock.removeAllListeners();
    sock.destroy();
    if (err) reject(err); else resolve();
  };
  sock.setTimeout(timeoutMs, () => finish(new Error("timeout")));
  sock.once("connect", () => finish(null));
  sock.once("error", (err) => finish(err));
});

/**
 * The ACTIVE half of the isolation check: does the sidecar share THIS
 * computer's network namespace?
 *
 * A non-loopback Serve target is necessary but not proof — an operator can
 * write `http://172.30.0.1:3090` on a sidecar that still runs with host
 * networking, and netstack answers it. So the probe uses the sidecar's own
 * dialer: connect to the sidecar's tailnet IPv4 (`status --json` →
 * `Self.TailscaleIPs`) on a port that is known to listen on this gateway's
 * LOOPBACK (the gateway's own HTTP port). Netstack completes that connect only
 * after its backend dial to 127.0.0.1:<port> succeeded, so a completed connect
 * IS a shared namespace. A refusal, a timeout, or no sidecar address means the
 * sidecar has a namespace of its own.
 *
 * Only ever called for a Running sidecar, and it never throws.
 *
 * @param {{ statusJson: any, port?: number|string|null, connect?: Function,
 *           timeoutMs?: number }} o
 * @returns {Promise<boolean>} true = shared (the netstack answered this machine's loopback)
 */
export async function sidecarSharesHostLoopback({ statusJson, port = null, connect = defaultConnect, timeoutMs = NETNS_PROBE_TIMEOUT_MS } = {}) {
  try {
    if (!isObj(statusJson) || statusJson.BackendState !== "Running") return false;
    const p = validPort(port);
    if (!p) return false;
    const ips = isObj(statusJson.Self) && Array.isArray(statusJson.Self.TailscaleIPs) ? statusJson.Self.TailscaleIPs : [];
    const v4 = ips.map((ip) => String(ip ?? "").trim()).find((ip) => net.isIPv4(ip));
    if (!v4) return false;
    await connect(v4, p, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * A cached reader for the gateway. Returns null when this instance has no
 * sidecar configured (CROW_ARTIFACT_SIDECAR_SOCKET and CROW_ARTIFACT_ORIGIN_PORT
 * both needed), else the latest sidecarHealth() result, re-read at most every
 * 5 minutes. The expected target comes from CROW_ARTIFACT_SIDECAR_TARGET, else
 * from CROW_ARTIFACT_ORIGIN_BIND (see expectedSidecarTarget); the netns probe
 * connects to the gateway's own port (`PORT` / `CROW_GATEWAY_PORT`, the same
 * expression the listener uses).
 */
export function createSidecarHealthReader({ env = process.env, exec = defaultExec, connect = defaultConnect, now = () => Date.now() } = {}) {
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
      const statusJson = JSON.parse(st);
      // Bounded (2 s) and never throwing; cached with the result it belongs to.
      const sharedLoopback = await sidecarSharesHostLoopback({ statusJson, port: gatewayListenPort(env), connect });
      result = sidecarHealth({
        statusJson,
        serveConfig: JSON.parse(sv),
        target: env.CROW_ARTIFACT_SIDECAR_TARGET || null,
        bind: env.CROW_ARTIFACT_ORIGIN_BIND || null,
        originPort,
        sharedLoopback,
        now: t,
      });
    } catch {
      result = { ok: false, problems: ["unreachable"], keyExpiry: null };
    }
    cache = result; cacheAt = t;
    return result;
  };
}
