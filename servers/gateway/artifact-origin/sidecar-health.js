/**
 * Health of the artifact sidecar node (Crow Artifacts, step 1).
 *
 * The artifact origin gets its own hostname from a SIDECAR Tailscale node: a
 * second tailscaled (userspace networking, its own state and MagicDNS name)
 * whose Serve config proxies https://<instance>-artifacts.<tailnet>:443 to
 * the loopback origin port. Two things can quietly go wrong there:
 *   - the node is logged out or its key expires: every artifact frame breaks;
 *   - its Serve config gains Funnel or another mapping: more than the origin
 *     is exposed (public links are a later step and bring their own rule).
 *
 * `sidecarHealth()` is pure (fixture JSON in, problems out). The reader runs
 * the tailscale CLI against the sidecar's LocalAPI socket (no sudo) at most
 * every 5 minutes. Anything unreadable is a problem ("unreachable"), never ok.
 *
 * Problem codes: logged-out, key-expiring, funnel-on, unexpected-mapping,
 * unreachable.
 */
import { execFile } from "node:child_process";

export const KEY_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;
export const SIDECAR_READ_EVERY_MS = 5 * 60 * 1000;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function validPort(p) {
  const n = typeof p === "number" ? p : (typeof p === "string" && /^\d{1,5}$/.test(p) ? Number(p) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** True only for exactly one 443 HTTPS listener whose one "/" handler proxies to http://127.0.0.1:<originPort>. */
function mappingIsExpected(cfg, originPort) {
  const port = validPort(originPort);
  if (!port || !isObj(cfg)) return false;
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
  return isObj(h) && Object.keys(h).length === 1 && h.Proxy === `http://127.0.0.1:${port}`;
}

/**
 * @param {{ statusJson: any, serveConfig: any, originPort: number|string|null, now?: number }} o
 *   statusJson: `tailscale status --json` of the sidecar; serveConfig: its
 *   `serve status -json` (the TS_SERVE_CONFIG shape: TCP / Web / AllowFunnel).
 * @returns {{ ok: boolean, problems: string[], keyExpiry: string|null }}
 */
export function sidecarHealth({ statusJson, serveConfig, originPort, now = Date.now() }) {
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
  if (!mappingIsExpected(serveConfig, originPort)) problems.push("unexpected-mapping");

  return { ok: problems.length === 0, problems, keyExpiry };
}

/**
 * Render the shipped serve config template for one instance. Only
 * {{ORIGIN_PORT}} is ours; ${TS_CERT_DOMAIN} is left for tailscaled, which
 * substitutes its own MagicDNS name when it loads TS_SERVE_CONFIG.
 */
export function renderServeConfig(tmpl, { originPort }) {
  const port = validPort(originPort);
  if (!port) throw new Error("renderServeConfig: originPort must be a port number (1-65535)");
  return String(tmpl).replaceAll("{{ORIGIN_PORT}}", String(port));
}

const defaultExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/**
 * A cached reader for the gateway. Returns null when this instance has no
 * sidecar configured (CROW_ARTIFACT_SIDECAR_SOCKET and CROW_ARTIFACT_ORIGIN_PORT
 * both needed), else the latest sidecarHealth() result, re-read at most every
 * 5 minutes.
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
      result = sidecarHealth({ statusJson: JSON.parse(st), serveConfig: JSON.parse(sv), originPort, now: t });
    } catch {
      result = { ok: false, problems: ["unreachable"], keyExpiry: null };
    }
    cache = result; cacheAt = t;
    return result;
  };
}
