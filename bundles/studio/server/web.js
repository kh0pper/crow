/**
 * Studio web layer — the panel's HTTP router and the live sync WebSocket.
 *
 * Everything the gateway owns is injected: the Express `Router` and body
 * parser, the `ws` WebSocketServer, the dashboard's auth helpers and the
 * session hub. This module imports no express, no ws and nothing from the
 * gateway's own tree, so it can be built and exercised against a scratch
 * database with fakes, and a bundle install still resolves (the only bundle
 * import is `./doc.js`, for the encoded Yjs state).
 *
 * Two kinds of HTTP caller share the router:
 *
 *   - the dashboard, behind `dashboardAuth`, with the CSRF header on every
 *     state-changing call (double submit, the same rule the rest of the
 *     dashboard uses);
 *   - the Studio MCP process, on `/api/studio/agent/*`, which is loopback
 *     only and presents the boot token from `<CROW_HOME>/studio-agent-token`.
 *     Its author is always forced to kind "agent": an MCP call is never
 *     attributed to the person.
 *
 * The WebSocket at `/api/studio/ws` follows the kiosk session-display
 * sequence: no Funnel header, an allowed network, a same-origin handshake, a
 * live dashboard session, then a first "hello" frame that echoes the CSRF
 * token. A client that reconnects after a sleep gets the full current state,
 * and a command it resends keeps its `cmd_id`, so the hub applies it once.
 *
 * Studio routes are never Funnel-public.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeDocState } from "./doc.js";

/** File under CROW_HOME holding the per-boot token the MCP process presents. */
const TOKEN_FILE = "studio-agent-token";

/** The one upgrade path this module owns. Every other upgrade is left alone. */
const WS_PATH = "/api/studio/ws";

/** A socket that never says hello is closed with 4401 after this long. */
const HELLO_TIMEOUT_MS = 10_000;

/** How often every open socket's dashboard session is re-checked. */
const SESSION_RECHECK_MS = 60_000;

/** Largest frame a client may send (a clip write is far below this). */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** How much history a client gets in its first "state" frame. */
const HISTORY_PAGE = 50;

/** The author every dashboard-issued command carries (spec §5.3). */
const HUMAN_AUTHOR = Object.freeze({ kind: "human", id: "local", label: "You" });

/** The addresses that may present the agent token. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** HTTP status for each hub refusal code. */
const STATUS_BY_CODE = Object.freeze({
  acl: 403,
  not_found: 404,
  invalid: 400,
  limit: 400,
  locked: 409,
  focused: 409,
  human_only: 409,
  conflict: 409,
});

/**
 * The only files the panel may load from the bundle: the engine assets and
 * the vendored SunVox runtime. A name outside this map is a 404, so the route
 * can never reach another file in the bundle.
 * @type {Map<string, string>}
 */
const ASSET_FILES = new Map([
  ["sequencer.js", join("engine", "sequencer.js")],
  ["studio-processor.js", join("engine", "studio-processor.js")],
  ["engine-client.js", join("engine", "engine-client.js")],
  ["sunvox.js", join("vendor", "sunvox", "sunvox.js")],
  ["sunvox.wasm", join("vendor", "sunvox", "sunvox.wasm")],
  ["sunvox_lib_loader.js", join("vendor", "sunvox", "sunvox_lib_loader.js")],
]);

/** @returns {string} the current Studio home (`<CROW_HOME>` or `~/.crow`). */
function defaultCrowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/**
 * Read (or mint) the token the Studio MCP process presents on its HTTP routes.
 *
 * The first call writes 32 random bytes in hex to `<crowHome>/studio-agent-token`
 * with mode 0600 and returns it; later calls return the same file's content, so
 * a restarted MCP process reads the token the running gateway is expecting.
 * The mode is re-applied on every read, so a token file that lost its
 * permissions is tightened again.
 *
 * @param {string} [crowHome] - the Crow home; defaults to `<CROW_HOME>` or `~/.crow`
 * @returns {string} the token, hex, never logged
 */
export function ensureAgentToken(crowHome = defaultCrowHome()) {
  const dir = crowHome || defaultCrowHome();
  const path = join(dir, TOKEN_FILE);

  let existing = "";
  try {
    existing = String(readFileSync(path, "utf8")).trim();
  } catch {
    existing = "";
  }
  if (existing) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // A file we can read but not chmod is still usable; nothing to do.
    }
    return existing;
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The write below reports the real problem.
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Same as above: the mode in writeFileSync already asked for 0600.
  }
  return token;
}

/** @returns {string} one host, lower-cased, from a possibly comma-joined header. */
function hostOf(value) {
  return String(value || "").split(",")[0].trim().toLowerCase();
}

/**
 * Cross-site WebSocket hijacking guard, copied from the kiosk session display
 * (the module is bundle-local there, so this is the same logic, not an import).
 *
 * A browser attaches cookies to a WebSocket handshake whatever page opened it.
 * Page script cannot forge either header: `Sec-Fetch-Site`, when present, must
 * say same-origin, and otherwise `Origin` must name this host (or the host a
 * reverse proxy forwarded).
 *
 * @param {object} req - the upgrade request
 * @returns {boolean}
 */
function sameOriginUpgrade(req) {
  const headers = req?.headers || {};
  const site = headers["sec-fetch-site"];
  if (site !== undefined && String(site).toLowerCase() !== "same-origin") return false;
  let originHost = "";
  try {
    originHost = new URL(String(headers.origin || "")).host.toLowerCase();
  } catch {
    originHost = "";
  }
  if (!originHost) return false;
  return (
    originHost === hostOf(headers.host) ||
    (!!headers["x-forwarded-host"] && originHost === hostOf(headers["x-forwarded-host"]))
  );
}

/** @returns {boolean} true when `presented` equals `expected`, in constant time. */
function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** @returns {string} a Yjs blob as base64 for the wire. */
function toBase64(bytes) {
  return Buffer.from(bytes ?? new Uint8Array()).toString("base64");
}

/**
 * Normalise the author an MCP caller sends. The kind is always "agent": an
 * agent can name itself, never the person.
 * @param {{id?: string, label?: string}|null} author
 * @returns {{kind: "agent", id: string, label: string}}
 */
function agentAuthor(author) {
  return {
    kind: "agent",
    id: String(author?.id || "mcp").slice(0, 80),
    label: String(author?.label || "Agent (MCP)").slice(0, 80),
  };
}

/** @returns {number} the HTTP status for a hub refusal code. */
function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 400;
}

/** Answer with a hub result: 200 when it applied, the code's status when not. */
function sendResult(res, result) {
  const status = result?.ok === true ? 200 : statusForCode(result?.code);
  res.status(status).json(result);
}

/**
 * Answer with an error a read threw.
 *
 * The hub's reads throw (there is no half-answer to hand back): a StudioError
 * keeps its code, an ACL refusal becomes 403 with code "acl", and anything
 * else is a 500.
 */
function sendError(res, err) {
  if (res.headersSent) return;
  const code = typeof err?.code === "string" ? err.code : null;
  if (!code) {
    res.status(500).json({ ok: false, error: err?.message || "Studio error" });
    return;
  }
  const isAcl = err?.name === "AclError";
  res.status(isAcl ? 403 : (STATUS_BY_CODE[code] ?? 500)).json({
    ok: false,
    code: isAcl ? "acl" : code,
    error: err?.message || "Studio error",
  });
}

/** Wrap an async route so a thrown error becomes a response, not a rejection. */
function handled(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => sendError(res, err));
  };
}

/** Send one JSON text frame, if the socket is still open. */
function send(ws, message) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // A socket that died mid-send is picked up by its close handler.
  }
}

/** Refuse an upgrade before it is one: a plain HTTP status, then the socket goes. */
function refuse(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  } catch {
    // The peer is already gone.
  }
  try {
    socket.destroy();
  } catch {
    // Same.
  }
}

/**
 * Build the Studio web layer for one gateway process.
 *
 * @param {object} options
 * @param {object} options.hub - the session hub (createHub); the only writer
 * @param {Function} options.Router - Express's Router constructor
 * @param {Function} options.WebSocketServer - the `ws` WebSocketServer class
 * @param {Function} options.jsonParser - Express JSON body middleware
 * @param {{isAllowedNetwork: Function, sessionFromRequest: Function,
 *          verifySession: Function, csrfTokenAccepted: Function}} options.auth
 *   the gateway's dashboard-session checks (auth.js and shared/csrf.js)
 * @param {string} [options.crowHome] - where the agent token file lives
 * @param {string} [options.bundleDir] - the bundle directory asset routes read
 * @returns {{router: Function, attachUpgrade: Function, broadcast: Function}}
 *   `router(dashboardAuth)` builds the Express router, `attachUpgrade(server)`
 *   installs the `/api/studio/ws` handler, and `broadcast(song_id, payload)`
 *   is what the hub's `onBroadcast` calls.
 */
export function createStudioWeb({
  hub,
  Router,
  WebSocketServer,
  jsonParser,
  auth,
  crowHome,
  bundleDir,
} = {}) {
  if (!hub || typeof hub.openSong !== "function" || typeof hub.runCommand !== "function") {
    throw new TypeError("Studio web: the session hub is required");
  }
  if (typeof Router !== "function") throw new TypeError("Studio web: Router is required");
  if (typeof WebSocketServer !== "function") throw new TypeError("Studio web: WebSocketServer is required");
  if (typeof jsonParser !== "function") throw new TypeError("Studio web: the JSON body parser is required");
  for (const name of ["isAllowedNetwork", "sessionFromRequest", "verifySession", "csrfTokenAccepted"]) {
    if (typeof auth?.[name] !== "function") throw new TypeError(`Studio web: auth.${name} is required`);
  }

  /** `<song_id> → <client_id → socket record>` for every client that said hello. */
  const rooms = new Map();

  /** The boot token, minted on first use so a fresh CROW_HOME works. */
  let cachedToken = null;
  function agentToken() {
    if (!cachedToken) cachedToken = ensureAgentToken(crowHome || defaultCrowHome());
    return cachedToken;
  }

  /** Send one message to every open client of a song. */
  function sendToSong(song_id, message) {
    const room = rooms.get(song_id);
    if (!room) return;
    const text = JSON.stringify(message);
    for (const record of room.values()) {
      if (record.ws.readyState !== 1) continue;
      try {
        record.ws.send(text);
      } catch {
        // A failed send closes the socket; the close handler cleans up.
      }
    }
  }

  /**
   * Push one hub broadcast to the song's clients.
   *
   * The hub calls this after every applied step (`{update, entry}`) and after
   * every presence change (`{presence}`). Anything else is ignored, so the hub
   * can add payloads later without this layer guessing at them.
   * @param {string} song_id
   * @param {{update?: Uint8Array, entry?: object|null, presence?: object[]}} payload
   * @returns {void}
   */
  function broadcast(song_id, payload) {
    if (!payload || typeof payload !== "object") return;
    if ("presence" in payload) {
      sendToSong(song_id, { type: "presence", presence: payload.presence ?? [] });
      return;
    }
    if (payload.update != null) {
      sendToSong(song_id, {
        type: "update",
        update: toBase64(payload.update),
        entry: payload.entry ?? null,
      });
    }
  }

  /** Remember a helloed socket under its song and client id. */
  function register(record) {
    let room = rooms.get(record.song_id);
    if (!room) {
      room = new Map();
      rooms.set(record.song_id, room);
    }
    const prior = room.get(record.client_id);
    if (prior && prior !== record) {
      // The same client reconnected without its old socket closing first.
      try {
        prior.ws.close(4000, "superseded");
      } catch {
        // It is going away either way.
      }
    }
    room.set(record.client_id, record);
  }

  /** Forget a socket and drop its presence. */
  function unregister(record) {
    const room = rooms.get(record.song_id);
    if (room && room.get(record.client_id) === record) room.delete(record.client_id);
    if (room && room.size === 0) rooms.delete(record.song_id);
    Promise.resolve()
      .then(() => hub.clientGone(record.song_id, record.client_id))
      .catch(() => {
        // Presence is best effort; the socket is already gone.
      });
  }

  /** The first frame: hello, the CSRF echo, then the song's full state. */
  async function handleHello(record, raw) {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      msg = null;
    }
    if (!msg || msg.type !== "hello" || !auth.csrfTokenAccepted(record.req, msg.csrf)) {
      try {
        record.ws.close(4401, "unauthorized");
      } catch {
        // Already closing.
      }
      return;
    }

    const song_id = typeof msg.song_id === "string" ? msg.song_id : "";
    const client_id = typeof msg.client_id === "string" && msg.client_id !== ""
      ? msg.client_id.slice(0, 80)
      : randomUUID();
    if (!song_id) {
      send(record.ws, { type: "error", error: "hello needs a song_id" });
      try {
        record.ws.close(4404, "no song");
      } catch {
        // Already closing.
      }
      return;
    }

    let opened;
    let history = [];
    try {
      opened = await hub.openSong(song_id);
      history = await hub.history(song_id, { limit: HISTORY_PAGE });
    } catch (err) {
      send(record.ws, { type: "error", error: err?.message || "The song could not be opened." });
      try {
        record.ws.close(4404, "song unavailable");
      } catch {
        // Already closing.
      }
      return;
    }

    record.song_id = song_id;
    record.client_id = client_id;
    record.helloed = true;
    // Registered before the state goes out, so a step applied in between still
    // reaches this client; Yjs applies the update and then the full state
    // idempotently whichever order they arrive in.
    register(record);

    send(record.ws, {
      type: "state",
      update: toBase64(encodeDocState(opened.doc)),
      history,
      presence: hub.presence(song_id),
    });
  }

  /** Every later frame: command, undo/redo, focus. */
  async function handleMessage(record, raw) {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(record.ws, { type: "error", error: "bad message" });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      send(record.ws, { type: "error", error: "bad message" });
      return;
    }

    const author = record.author;
    const cmd_id = msg.cmd_id == null ? null : String(msg.cmd_id);
    try {
      if (msg.type === "command") {
        const result = await hub.runCommand({
          song_id: record.song_id,
          cmd_id,
          command: msg.command,
          args: msg.args ?? {},
          author,
        });
        send(record.ws, { type: "result", cmd_id, ...result });
        return;
      }
      if (msg.type === "undo" || msg.type === "redo") {
        const run = msg.type === "undo" ? hub.undo : hub.redo;
        const result = await run({
          song_id: record.song_id,
          cmd_id,
          entry_id: msg.entry_id,
          author,
        });
        send(record.ws, { type: "result", cmd_id, ...result });
        return;
      }
      if (msg.type === "focus") {
        await hub.setFocus(record.song_id, record.client_id, msg.ref ?? null, author);
        return;
      }
      send(record.ws, { type: "error", error: "bad message" });
    } catch (err) {
      send(record.ws, { type: "error", error: err?.message || "The command failed." });
    }
  }

  /** A freshly upgraded socket, before it has said hello. */
  function openSocket(ws, req, token) {
    const record = { ws, req, token, song_id: null, client_id: null, helloed: false, author: HUMAN_AUTHOR };
    const helloTimer = setTimeout(() => {
      if (record.helloed) return;
      try {
        ws.close(4401, "hello timeout");
      } catch {
        // Already closing.
      }
    }, HELLO_TIMEOUT_MS);
    if (typeof helloTimer.unref === "function") helloTimer.unref();

    ws.on("error", () => {
      // A close follows; nothing else to do.
    });
    ws.on("message", (raw) => {
      Promise.resolve()
        .then(() => (record.helloed ? handleMessage(record, raw) : handleHello(record, raw)))
        .catch(() => {
          send(ws, { type: "error", error: "bad message" });
        });
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (record.helloed && record.song_id && record.client_id) unregister(record);
    });
  }

  /**
   * Re-check every open socket's dashboard session.
   *
   * A logout, an expiry or a revoked session closes the socket with 4401, so a
   * laptop left open overnight stops receiving the song.
   * @returns {Promise<void>}
   */
  async function revalidateSessions() {
    const records = [];
    for (const room of rooms.values()) records.push(...room.values());
    for (const record of records) {
      let session = null;
      try {
        session = await auth.verifySession(record.token);
      } catch {
        session = null;
      }
      if (session) continue;
      try {
        record.ws.close(4401, "session expired");
      } catch {
        // Already closing.
      }
    }
  }

  /**
   * Install the `/api/studio/ws` upgrade handler on the gateway's HTTP server.
   *
   * Only this one path is touched: every other upgrade is left to whoever owns
   * it, and a socket this module refuses is answered and destroyed before it
   * becomes a WebSocket.
   * @param {object} httpServer - the gateway's node:http server
   * @returns {{close: Function}} a handle that clears the session re-check
   */
  function attachUpgrade(httpServer) {
    if (!httpServer || typeof httpServer.on !== "function") {
      throw new TypeError("Studio web: an http server is required");
    }
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_MESSAGE_BYTES,
    });

    const recheck = setInterval(() => {
      Promise.resolve()
        .then(revalidateSessions)
        .catch(() => {
          // A re-check failure is retried next minute.
        });
    }, SESSION_RECHECK_MS);
    if (typeof recheck.unref === "function") recheck.unref();

    httpServer.on("close", () => clearInterval(recheck));

    httpServer.on("upgrade", (req, socket, head) => {
      const path = String(req.url || "").split("?")[0];
      if (path !== WS_PATH) return; // Not ours: leave the socket alone.

      if (req.headers["tailscale-funnel-request"] || !auth.isAllowedNetwork(req)) {
        return refuse(socket, 403, "Forbidden");
      }
      if (!sameOriginUpgrade(req)) return refuse(socket, 403, "Forbidden");

      socket.on("error", () => {
        // The peer went away during the handshake.
      });

      // Everything else is decided before the upgrade: the cookie must be a
      // live dashboard session, and hello has to echo its CSRF value.
      Promise.resolve()
        .then(() => auth.sessionFromRequest(req))
        .then((token) => {
          if (socket.destroyed) return;
          if (!token) return refuse(socket, 401, "Unauthorized");
          wss.handleUpgrade(req, socket, head, (ws) => openSocket(ws, req, token));
        })
        .catch(() => {
          if (!socket.destroyed) refuse(socket, 401, "Unauthorized");
        });
    });

    return {
      close: () => {
        clearInterval(recheck);
        // ws does not end upgraded sockets on close() in noServer mode, and an
        // open upgraded socket keeps httpServer.close() waiting forever.
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // Already gone.
          }
        }
        try {
          wss.close();
        } catch {
          // Already closed with the server.
        }
      },
    };
  }

  /** Loopback only, no Funnel, and the boot token — in that order. */
  function agentGuard(req, res, next) {
    if (req.headers["tailscale-funnel-request"]) {
      return res.status(403).json({ ok: false, error: "refused" });
    }
    const address = String(req.socket?.remoteAddress || "");
    if (!LOOPBACK_ADDRESSES.has(address)) {
      return res.status(403).json({ ok: false, error: "refused" });
    }
    if (!tokenMatches(req.get("x-studio-token"), agentToken())) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  }

  /** The dashboard's double-submit check for one state-changing call. */
  function requireCsrf(req, res, next) {
    if (!auth.csrfTokenAccepted(req, req.get("x-crow-csrf"))) {
      return res.status(403).json({ error: "csrf" });
    }
    return next();
  }

  /** @returns {{project_ids?: number[]}} the filter a `project_id` query asks for. */
  function songFilter(query) {
    const projectId = Number(query?.project_id);
    return Number.isInteger(projectId) ? { project_ids: [projectId] } : {};
  }

  /** @returns {{limit?: number}} the page a `limit` query asks for. */
  function historyOptions(query) {
    const limit = Number(query?.limit);
    return Number.isFinite(limit) && limit > 0 ? { limit } : {};
  }

  /**
   * Build the Express router for the dashboard's own routes (behind
   * `dashboardAuth`) and the agent routes (behind `agentGuard`).
   * @param {Function} dashboardAuth - the gateway's dashboard session middleware
   * @returns {object} an Express Router
   */
  function router(dashboardAuth) {
    if (typeof dashboardAuth !== "function") {
      throw new TypeError("Studio web: dashboardAuth is required");
    }
    const r = Router();
    const AGENT = "/api/studio/agent";

    // ---- dashboard -------------------------------------------------------

    r.get("/api/studio/songs", dashboardAuth, handled(async (req, res) => {
      res.json(await hub.listSongs(songFilter(req.query)));
    }));

    r.post("/api/studio/songs", dashboardAuth, jsonParser, requireCsrf, handled(async (req, res) => {
      const result = await hub.createSong({
        project_id: req.body?.project_id,
        title: req.body?.title,
        author: HUMAN_AUTHOR,
      });
      if (result.ok !== true) return sendResult(res, result);
      res.json({ song_id: result.song_id });
    }));

    // The engine assets the panel loads. The whitelist is the whole contract:
    // a name that is not in it never touches the filesystem.
    r.get("/dashboard/studio/assets/:file", dashboardAuth, (req, res) => {
      const relative = ASSET_FILES.get(String(req.params.file || ""));
      if (!relative || !bundleDir) return res.status(404).json({ error: "not_found" });
      const path = join(bundleDir, relative);
      if (!existsSync(path)) return res.status(404).json({ error: "not_found" });
      return res.sendFile(path);
    });

    // ---- the Studio MCP process -----------------------------------------

    r.get(`${AGENT}/songs`, agentGuard, handled(async (req, res) => {
      res.json(await hub.listSongs(songFilter(req.query)));
    }));

    r.post(`${AGENT}/songs`, agentGuard, jsonParser, handled(async (req, res) => {
      const result = await hub.createSong({
        project_id: req.body?.project_id,
        title: req.body?.title,
        author: agentAuthor(req.body?.author),
      });
      if (result.ok !== true) return sendResult(res, result);
      res.json({ song_id: result.song_id });
    }));

    r.get(`${AGENT}/songs/:id/snapshot`, agentGuard, handled(async (req, res) => {
      const opened = await hub.openSong(req.params.id);
      res.json({
        song_id: req.params.id,
        snapshot: opened.snapshot,
        state: toBase64(encodeDocState(opened.doc)),
      });
    }));

    r.get(`${AGENT}/songs/:id/history`, agentGuard, handled(async (req, res) => {
      res.json(await hub.history(req.params.id, historyOptions(req.query)));
    }));

    r.post(`${AGENT}/songs/:id/command`, agentGuard, jsonParser, handled(async (req, res) => {
      const result = await hub.runCommand({
        song_id: req.params.id,
        cmd_id: req.body?.cmd_id ?? null,
        command: req.body?.command,
        args: req.body?.args ?? {},
        author: agentAuthor(req.body?.author),
      });
      sendResult(res, result);
    }));

    r.post(`${AGENT}/songs/:id/undo`, agentGuard, jsonParser, handled(async (req, res) => {
      const result = await hub.undo({
        song_id: req.params.id,
        cmd_id: req.body?.cmd_id ?? null,
        entry_id: req.body?.entry_id,
        author: agentAuthor(req.body?.author),
      });
      sendResult(res, result);
    }));

    r.post(`${AGENT}/songs/:id/redo`, agentGuard, jsonParser, handled(async (req, res) => {
      const result = await hub.redo({
        song_id: req.params.id,
        cmd_id: req.body?.cmd_id ?? null,
        entry_id: req.body?.entry_id,
        author: agentAuthor(req.body?.author),
      });
      sendResult(res, result);
    }));

    return r;
  }

  return { router, attachUpgrade, broadcast };
}