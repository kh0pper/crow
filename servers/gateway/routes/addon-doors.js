/**
 * Add-on doors that must run in the gateway (D3: browser container control).
 *
 * A walled add-on has no docker socket and no shell; `crow_browser_launch`'s
 * restart and proxy relaunch used to be two `docker` calls from the add-on's own
 * process. They run here instead, with an argv that is fixed in this file:
 *
 *   POST /api/addon-doors/browser/container
 *     { action: "restart" | "recreate", proxy_url? }
 *
 * Order, every refusal a JSON body that never echoes docker's output:
 *   1. the socket carries the add-on relay mark (isAddonRelayAddr)      else 403
 *   2. Bearer <this spawn's browser door token>, for exactly this
 *      method and path (validateAddonDoorToken)                         else 401
 *   3. action is one of the two words; proxy_url only with "recreate",
 *      and then "" or a proxy URL the browser would accept              else 400
 *   4. the container name comes from THIS instance's installed bundle
 *      .env, never from the request, and must be a plain docker name    else 500
 *   5. docker restart, or a compose recreate of the bundle's own file  else 502
 *
 * Nothing from the request reaches the argv: only the validated proxy_url, as
 * CROW_BROWSER_PROXY in the compose run's environment. The socket carries the
 * relay mark only because the relay process — outside the sandbox — binds it, so
 * an add-on cannot choose it, and the token is the one value the relay lets
 * through to this path.
 *
 * Mountable on a bare express app: every dependency is a parameter.
 */
import express, { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isAddonRelayAddr } from "../../shared/bot-doors.js";
import { validateAddonDoorToken } from "../../shared/addon-doors.js";
import { parseEnvText } from "../bundle-env-codec.js";
import { resolveCrowHome } from "../../shared/crow-home.js";

export const BROWSER_CONTAINER_PATH = "/api/addon-doors/browser/container";

/** What the browser's own compose file falls back to when the .env names nothing. */
export const DEFAULT_CONTAINER_NAME = "crow-browser";

/** A docker container name: what `docker` itself accepts, and nothing else. */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The proxy schemes `crow_browser_launch` documents. */
const PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:"]);

/** Longest proxy_url this door carries. */
const PROXY_MAX_CHARS = 512;

/** Bounds on the two docker calls (a compose recreate may rebuild an image). */
const RESTART_TIMEOUT_MS = 30_000;
const RECREATE_TIMEOUT_MS = 90_000;

/**
 * The validated form of a `proxy_url` body field, or null when it is not one.
 *
 * `""` clears the proxy. Otherwise an absolute URL with one of the browser's
 * schemes, a host, an explicit port, no userinfo, no path beyond "/", no query
 * or fragment, and no whitespace or control character.
 * @param {unknown} value
 * @returns {string|null}
 */
export function proxyUrlValue(value) {
  if (typeof value !== "string" || value.length > PROXY_MAX_CHARS) return null;
  if (value === "") return "";
  // Refuse before the parser can normalise anything away (a space, a tab, a NUL).
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!PROXY_SCHEMES.has(url.protocol)) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  if (url.port === "") return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search !== "" || url.hash !== "") return null;
  return value;
}

/**
 * This instance's browser container name, read from the installed bundle's .env
 * (the same file the browser server reads), or null when the file names one that
 * docker would not accept as a plain container name.
 * @param {string} crowHome
 * @returns {string|null}
 */
export function browserContainerName(crowHome) {
  let name = DEFAULT_CONTAINER_NAME;
  try {
    const values = parseEnvText(readFileSync(join(crowHome, "bundles", "browser", ".env"), "utf8"));
    const named = values.CROW_BROWSER_CONTAINER_NAME;
    if (typeof named === "string" && named.trim() !== "") name = named.trim();
  } catch {
    // No .env (a fresh install, or one never written): the default name.
  }
  return CONTAINER_NAME_RE.test(name) ? name : null;
}

/** A path a compose run may use as CROW_HOME: symlinks resolved when possible. */
function canonicalHome(crowHome) {
  try {
    return realpathSync(crowHome);
  } catch {
    return resolve(crowHome);
  }
}

/**
 * The environment a compose recreate runs with: the gateway's own PATH, HOME and
 * LANG, this instance's canonical home, and the validated proxy. Nothing else of
 * the gateway's environment is inherited by the docker call.
 * @param {string} crowHome
 * @param {string|undefined} proxy - undefined when the request named none
 */
function composeEnv(crowHome, proxy) {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CROW_HOME = canonicalHome(crowHome);
  if (proxy !== undefined) env.CROW_BROWSER_PROXY = proxy;
  return env;
}

/**
 * @param {object} [o]
 * @param {string} [o.crowHome] - this instance's Crow home (default: the gateway's)
 * @param {Function} [o.runner] - `(file, args, options) => Promise`; tests inject one
 * @param {Function} [o.json] - the JSON body parser (a 4 KB cap by default)
 */
export function addonDoorsRouter({
  crowHome = null,
  runner = null,
  json = null,
} = {}) {
  const run = typeof runner === "function" ? runner : promisify(execFile);
  const parseJson = typeof json === "function" ? json : express.json({ limit: "4kb" });
  const home = typeof crowHome === "string" && crowHome !== "" ? crowHome : null;
  const router = Router();

  router.post(BROWSER_CONTAINER_PATH, parseJson, async (req, res) => {
    const fail = (status, error) => {
      if (!res.headersSent) res.status(status).json({ ok: false, error });
    };

    // 1. Only a socket the add-on relay opened.
    let marked = false;
    try { marked = isAddonRelayAddr(req.socket?.remoteAddress) === true; } catch { marked = false; }
    if (!marked) return fail(403, "not an add-on door caller");

    // 2. Only this spawn's browser door token, for this door.
    const auth = String(req.headers.authorization || "");
    let doorOk = false;
    try {
      doorOk = validateAddonDoorToken(auth.startsWith("Bearer ") ? auth.slice(7) : "", "browser", "POST", BROWSER_CONTAINER_PATH) === true;
    } catch { doorOk = false; }
    if (!doorOk) return fail(401, "unauthorized");

    // 3. The request: two words, and a proxy only where one can be applied.
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!body) return fail(400, "bad_request");
    const action = body.action;
    if (action !== "restart" && action !== "recreate") return fail(400, "bad_request");
    let proxy;
    if (Object.hasOwn(body, "proxy_url")) {
      if (action !== "recreate") return fail(400, "bad_request");
      const value = proxyUrlValue(body.proxy_url);
      if (value === null) return fail(400, "bad_request");
      proxy = value;
    }

    // 4. This instance's container, from its own bundle .env — never the request.
    const base = home || resolveCrowHome();
    const container = browserContainerName(base);
    if (!container) return fail(500, "browser container name is invalid");

    // 5. The fixed docker calls.
    try {
      if (action === "restart") {
        await run("docker", ["restart", container], { timeout: RESTART_TIMEOUT_MS });
      } else {
        await run(
          "docker",
          ["compose", "-f", join(base, "bundles", "browser", "docker-compose.yml"), "up", "-d", "--force-recreate"],
          { timeout: RECREATE_TIMEOUT_MS, cwd: join(base, "bundles", "browser"), env: composeEnv(base, proxy) },
        );
      }
    } catch {
      return fail(502, "docker failed");
    }
    return res.json({ ok: true });
  });

  return router;
}