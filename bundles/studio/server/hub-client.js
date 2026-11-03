/**
 * Studio hub client — the MCP process's only way to reach the live song.
 *
 * The session hub runs inside the Crow gateway (the bundle's `panelRoutes`);
 * this process is a separate stdio add-on, so every read and every edit goes
 * over the gateway's loopback agent API (`/api/studio/agent/*`). That API
 * refuses anyone who is not truly local and who does not present the per-boot
 * token the gateway writes to `<CROW_HOME>/studio-agent-token`, so this client
 * reads that file on EVERY call, not once at startup: the gateway can restart
 * (minting a new token and invalidating the old file) while an MCP process
 * keeps running, and the next call must then use the new value.
 *
 * Two failures are ordinary results, not exceptions, because the caller is an
 * agent that has to explain them in words:
 *
 *   - no token file: Studio is not up in the gateway yet (a fresh install, or
 *     a gateway started before the bundle was enabled);
 *   - the request never reached the gateway (the process is down, the port is
 *     wrong, the 15 s timeout expired).
 *
 * A 4xx/5xx answer is NOT an exception either: the route returns the hub's own
 * result (`{ok:false, code, error}`), and mapping the status back to a code
 * here would lose the message the agent needs. So the parsed JSON is returned
 * whatever the status, and only a body that is not JSON at all becomes an
 * "unavailable" result.
 *
 * The method list is the plan's Task 9 interface — one method per agent route,
 * no more — so the tool layer above it cannot reach anything the gateway does
 * not expose.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** File under CROW_HOME holding the per-boot token the gateway expects. */
const TOKEN_FILE = "studio-agent-token";

/** How long one call may take before it is reported as unreachable. */
const TIMEOUT_MS = 15_000;

/** What the agent is told when no token file exists yet. */
const NO_TOKEN = "Studio is not running in the Crow gateway yet (no agent token); restart the gateway.";

/** What the agent is told when the request never reached the gateway. */
const UNREACHABLE = "Studio could not reach the Crow gateway.";

/** @returns {string} the Crow home the default token path lives under. */
function crowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/**
 * Build a client for the gateway's Studio agent API.
 *
 * The default base url follows the kiosk add-on: `PORT` first (the gateway sets
 * it for its children), then `CROW_GATEWAY_PORT`, then 3001 — a host that sets
 * both to different values still reaches the gateway it was started by.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] - e.g. `http://127.0.0.1:3001`
 * @param {string} [options.tokenPath] - defaults to `<CROW_HOME>/studio-agent-token`
 * @param {Function} [options.fetchImpl] - the fetch to use (tests inject one)
 * @param {number} [options.timeoutMs] - per-call timeout, 15 s by default
 * @returns {{listSongs: Function, createSong: Function, snapshot: Function,
 *            history: Function, command: Function, undo: Function, redo: Function}}
 */
export function createHubClient({
  baseUrl = `http://127.0.0.1:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`,
  tokenPath = null,
  fetchImpl = null,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : (...args) => globalThis.fetch(...args);
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;

  /** @returns {string} the token path for this call, honouring a later CROW_HOME. */
  function tokenFile() {
    return tokenPath || join(crowHome(), TOKEN_FILE);
  }

  /** @returns {string|null} the token as the gateway wrote it, read fresh. */
  function readToken() {
    try {
      const token = String(readFileSync(tokenFile(), "utf8")).trim();
      return token === "" ? null : token;
    } catch {
      return null;
    }
  }

  /** @returns {{ok: false, code: string, error: string}} a result the agent can explain. */
  function unavailable(error) {
    return { ok: false, code: "unavailable", error };
  }

  /**
   * One agent-API call.
   * @param {"GET"|"POST"} method
   * @param {string} path - the route path, already escaped
   * @param {object} [body] - JSON body for a POST
   * @returns {Promise<object>} the route's JSON (the hub result, on any status)
   */
  async function call(method, path, body) {
    const token = readToken();
    if (!token) return unavailable(NO_TOKEN);

    let response;
    try {
      response = await doFetch(baseUrl + path, {
        method,
        headers: {
          "x-studio-token": token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(limit),
      });
    } catch {
      return unavailable(UNREACHABLE);
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") return parsed;
    return unavailable(`Studio answered HTTP ${response.status} with no JSON.`);
  }

  /** @returns {string} one path segment, escaped so an id cannot change the route. */
  function segment(value) {
    return encodeURIComponent(String(value));
  }

  /**
   * @param {{project_id?: number}} [filter]
   * @returns {Promise<Array<{id: string, project_id: number, title: string, updated_at: string}>|object>}
   */
  function listSongs(filter = {}) {
    const projectId = filter?.project_id;
    const query = projectId == null ? "" : `?project_id=${segment(projectId)}`;
    return call("GET", `/api/studio/agent/songs${query}`);
  }

  /**
   * @param {{project_id: number, title: string, author: object}} request
   * @returns {Promise<{ok: true, song_id: string}|{ok: false, code: string, error: string}>}
   */
  function createSong(request = {}) {
    return call("POST", "/api/studio/agent/songs", {
      project_id: request.project_id,
      title: request.title,
      author: request.author,
    });
  }

  /**
   * @param {string} song_id
   * @returns {Promise<{song_id: string, snapshot: object, state: string}|object>}
   */
  function snapshot(song_id) {
    return call("GET", `/api/studio/agent/songs/${segment(song_id)}/snapshot`);
  }

  /**
   * @param {string} song_id
   * @param {{limit?: number}} [options]
   * @returns {Promise<object[]|object>} the newest entries first
   */
  function history(song_id, options = {}) {
    const limit = options?.limit;
    const query = limit == null ? "" : `?limit=${segment(limit)}`;
    return call("GET", `/api/studio/agent/songs/${segment(song_id)}/history${query}`);
  }

  /**
   * @param {string} song_id
   * @param {{cmd_id: string, command: string, args: object, author: object}} request
   * @returns {Promise<object>} the hub result
   */
  function command(song_id, request = {}) {
    return call("POST", `/api/studio/agent/songs/${segment(song_id)}/command`, {
      cmd_id: request.cmd_id,
      command: request.command,
      args: request.args,
      author: request.author,
    });
  }

  /**
   * @param {string} song_id
   * @param {{cmd_id: string, entry_id: string, author: object}} request
   * @returns {Promise<object>} the hub result
   */
  function undo(song_id, request = {}) {
    return call("POST", `/api/studio/agent/songs/${segment(song_id)}/undo`, {
      cmd_id: request.cmd_id,
      entry_id: request.entry_id,
      author: request.author,
    });
  }

  /**
   * @param {string} song_id
   * @param {{cmd_id: string, entry_id: string, author: object}} request
   * @returns {Promise<object>} the hub result
   */
  function redo(song_id, request = {}) {
    return call("POST", `/api/studio/agent/songs/${segment(song_id)}/redo`, {
      cmd_id: request.cmd_id,
      entry_id: request.entry_id,
      author: request.author,
    });
  }

  return { listSongs, createSong, snapshot, history, command, undo, redo };
}