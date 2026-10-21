/**
 * How Crow reaches Caddy's admin API: a unix socket in Caddy's config dir.
 *
 * The admin API can rewrite Caddy's whole config (POST /load). It used to listen on
 * 0.0.0.0:2019 inside the container, so every app on the shared crow-federation network
 * could reach it. It now listens on <config dir>/run/admin.sock (in the container:
 * /srv/caddy/run/admin.sock), a file only the host user and root can open, and no other
 * container mounts.
 *
 * CADDY_ADMIN_URL:
 *   unset, or the old default (a loopback :2019 URL) -> <CADDY_CONFIG_DIR>/run/admin.sock.
 *     Only while that socket does not exist AND the Caddyfile still says
 *     `admin 0.0.0.0:2019` (a container from before the move, not yet recreated) is
 *     http://127.0.0.1:2019 used instead, so the tools keep working mid-rollout. Never
 *     otherwise: another Caddy on that port (a host's own) must not receive Crow's config.
 *   unix:/abs/path or unix:///abs/path -> that socket.
 *   any other http(s):// URL -> used as is (an operator's own setup).
 *
 * node:http, not fetch: fetch cannot dial a unix socket without undici's Agent.
 */
import http from "node:http";
import https from "node:https";
import { lstatSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export const LEGACY_ADMIN_URL = "http://127.0.0.1:2019";
export const CONTAINER_ADMIN_SOCKET = "/srv/caddy/run/admin.sock";

/** The admin socket's host path for a Caddy config dir. */
export function adminSocketPath(configDir) {
  return join(configDir, "run", "admin.sock");
}

// sockaddr_un.sun_path is 108 bytes on Linux (one for the NUL).
const MAX_SOCKET_PATH = 107;

/** True for the URLs the bundle used to ship or document: loopback, port 2019. */
export function isLegacyAdminUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  return url.protocol === "http:" && url.port === "2019" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && (url.pathname === "/" || url.pathname === "");
}

/**
 * True when the Caddyfile still has the exact old admin line the entrypoint migrates
 * (`admin 0.0.0.0:2019`): the container has not been recreated yet. Any other TCP admin
 * line is the operator's own and never makes Crow fall back to 127.0.0.1:2019, which
 * the new compose file no longer publishes (another Caddy may own it).
 */
export function caddyfileHasTcpAdmin(source) {
  return /^[ \t]*admin[ \t]+0\.0\.0\.0:2019[ \t]*$/m.test(String(source || ""));
}

function socketState(path) {
  try { return lstatSync(path).isSocket() ? "socket" : "other"; } catch (err) {
    return err?.code === "ENOENT" ? "missing" : "unknown"; // EACCES etc.: let the request say why
  }
}

function readSource(configDir) {
  try { return readFileSync(join(configDir, "Caddyfile"), "utf8"); } catch { return ""; }
}

function unixTarget(socketPath) {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(`Caddy admin socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH}-byte unix socket limit: use a shorter CADDY_CONFIG_DIR or set CADDY_ADMIN_URL=unix:/short/path`);
  }
  return { kind: "unix", socketPath, label: `unix:${socketPath}` };
}

/**
 * Where the admin API is: { kind: "unix", socketPath, label } or { kind: "http", baseUrl, label }
 * (`fallback: true` when the legacy TCP address stands in for a socket that is not there yet).
 * `state` and `source` are injectable for tests.
 */
export function adminTarget({ env = process.env, configDir, state = socketState, source = readSource } = {}) {
  const raw = String(env.CADDY_ADMIN_URL || "").trim().replace(/\/+$/, "");
  if (raw.toLowerCase().startsWith("unix:")) {
    const socketPath = raw.slice(5).replace(/^\/\/(?=\/)/, "");
    if (!isAbsolute(socketPath)) throw new Error(`CADDY_ADMIN_URL ${JSON.stringify(raw)}: a unix socket needs an absolute path (unix:/path/to/admin.sock)`);
    return unixTarget(socketPath);
  }
  if (raw && !isLegacyAdminUrl(raw)) {
    let url;
    try { url = new URL(raw); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol)) throw new Error(`CADDY_ADMIN_URL ${JSON.stringify(raw)} is neither unix:/path nor an http(s) URL`);
    return { kind: "http", baseUrl: raw, label: raw };
  }
  if (!configDir) throw new Error("adminTarget: configDir is required");
  const socketPath = adminSocketPath(configDir);
  if (state(socketPath) === "missing" && caddyfileHasTcpAdmin(source(configDir))) {
    return { kind: "http", baseUrl: LEGACY_ADMIN_URL, label: LEGACY_ADMIN_URL, fallback: true, socketPath };
  }
  return unixTarget(socketPath);
}

/** Why the admin API could not be reached, in words an operator can act on. */
function unreachable(target, err) {
  const code = err?.code || "";
  const where = target.fallback
    ? `${target.socketPath} (not there yet) or ${target.baseUrl}`
    : target.label;
  const hint = code === "EACCES"
    ? " Permission denied: the socket's folder (run/ in CADDY_CONFIG_DIR) must belong to the user Crow runs as. Make the config dir that user's (chown -R), then recreate the caddy container (its entrypoint gives run/ to the config dir's owner)."
    : code === "ENOENT"
      ? " The socket is not there: is the caddy container running, and was it recreated after the bundle update (docker compose up -d --force-recreate)? Check 'docker ps' for crow-caddy and 'docker logs crow-caddy'."
      : " Is the caddy container running? Check 'docker ps' for crow-caddy and 'docker logs crow-caddy'.";
  const e = new Error(`Cannot reach Caddy admin API at ${where} (${code || err?.message || "error"}).${hint}`);
  e.code = code;
  return e;
}

/**
 * One request to the admin API. Resolves { status, statusText, ok, text } for any HTTP
 * answer; rejects only when Caddy could not be reached or did not answer in time.
 */
export function adminRequest(target, path, { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(String(body));
    const hdrs = { ...headers };
    if (payload) hdrs["Content-Length"] = String(payload.length);
    let req;
    const onResponse = (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode || 0;
        resolve({ status, statusText: res.statusMessage || "", ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => reject(unreachable(target, err)));
    };
    if (target.kind === "unix") {
      // Caddy skips its Host check on a unix socket; "localhost" keeps the request well-formed.
      req = http.request({ socketPath: target.socketPath, path, method, headers: { Host: "localhost", ...hdrs } }, onResponse);
    } else {
      const url = new URL(target.baseUrl.replace(/\/+$/, "") + path);
      const lib = url.protocol === "https:" ? https : http;
      req = lib.request(url, { method, headers: hdrs }, onResponse);
    }
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`Caddy admin request timed out: ${path}`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.on("error", (err) => reject(err?.code === "ETIMEDOUT" ? err : unreachable(target, err)));
    if (payload) req.write(payload);
    req.end();
  });
}
