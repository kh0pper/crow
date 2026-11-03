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
 *   - the Studio MCP process, on `/api/studio/agent/*`, which must be a truly
 *     local caller — `classifyPeer(req).via === "local"`: a loopback socket
 *     that is not a trusted proxy and that carries no forwarding and no
 *     tailscale-* header, so a Tailscale Serve proxy (which also reaches the
 *     gateway from a loopback socket) is refused — and presents the boot token
 *     from `<CROW_HOME>/studio-agent-token`. Its author is always
 *     `kind:"agent"`, with an `agent:` prefix on the id: an MCP call is never
 *     attributed to the person, and its id can never be the human's "local".
 *     A Crow bot among those authors is scoped to the project it is linked to:
 *     a song outside it answers like a missing one, and Crow's voice bot reads
 *     every song while changing none (see `botScope` and `scopeOf`).
 *
 * The WebSocket at `/api/studio/ws` follows the kiosk session-display
 * sequence: no Funnel header, an allowed network, a same-origin handshake, a
 * live dashboard session, then a first "hello" frame that echoes the CSRF
 * token. A client that reconnects after a sleep gets the full current state,
 * and a command it resends keeps its `cmd_id`, so the hub applies it once.
 *
 * Studio routes are never Funnel-public.
 *
 * Request bodies are capped at 1 MB by the gateway: its global JSON parser runs
 * before this router, so the routes here read `req.body` and add no parser of
 * their own.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
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

/** Open Studio sockets one session token may hold; the next upgrade is 429. */
const MAX_SOCKETS_PER_TOKEN = 20;

/** What a caller is told when Studio itself broke; the real error goes to the log. */
const INTERNAL_ERROR_TEXT = "Studio hit an internal error.";

/**
 * The prefix `agentAuthor` puts on a bot's author id. The MCP layer resolves a
 * Crow bot as `bot:<id>`, so the author the routes see is `agent:bot:<id>` and
 * the bare `<id>` is what the bot's own record is keyed by.
 */
const AGENT_BOT_PREFIX = "agent:bot:";

/** What Crow's voice is told when it tries to change a song it may read. */
const READ_ONLY_TEXT = "Crow's voice can read songs but not change them; ask the project's bot.";

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
  // The panel's read replica of the song needs Yjs in the browser. It is the
  // dependency the hub itself uses, so the page applies updates with exactly
  // the code the hub encoded them with. Its own imports are served beside it
  // (see the lib0 route below).
  ["yjs.mjs", join("node_modules", "yjs", "dist", "yjs.mjs")],
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
 *
 * The id is prefixed with `agent:` so that a caller naming itself "local" (or
 * anything else) still cannot pass for the human author the dashboard uses.
 * Control characters go, and the id is bounded like the label.
 * @param {{id?: string, label?: string}|null} author
 * @returns {{kind: "agent", id: string, label: string}}
 */
function agentAuthor(author) {
  const id = String(author?.id ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80);
  return {
    kind: "agent",
    id: `agent:${id || "mcp"}`,
    label: String(author?.label || "Agent (MCP)").slice(0, 80),
  };
}

/**
 * The author of one agent HTTP request.
 *
 * A mutation names its author in the body, which is the only place a label can
 * travel; a read has no body, so the MCP client puts the id it resolved in the
 * `x-studio-author` header instead. Either way the value goes through
 * `agentAuthor`, so the author can only ever be an agent — and it is taken at
 * its word for scope, because the token already marks a local process, which
 * could read crow.db itself (see the agent section below).
 * @param {object} req - the Express request
 * @returns {{kind: "agent", id: string, label: string}}
 */
function agentAuthorFor(req) {
  const body = req?.body?.author;
  if (body && typeof body === "object") return agentAuthor(body);
  const headerId = typeof req?.get === "function" ? String(req.get("x-studio-author") || "") : "";
  return agentAuthor(headerId ? { id: headerId } : null);
}

/**
 * The one answer a song a caller may not name gets.
 *
 * A song outside a bot's project answers with exactly this body, so it is
 * indistinguishable from a song that does not exist and another project's
 * songs cannot be probed.
 * @param {string} songId
 * @returns {{ok: false, code: "not_found", error: string}}
 */
function noSong(songId) {
  return { ok: false, code: "not_found", error: `There is no song "${songId}".` };
}

/**
 * The one answer a project a caller may not name gets (a bot may create a song
 * only in its own project, and never learns that another one exists).
 * @param {unknown} projectId
 * @returns {{ok: false, code: "not_found", error: string}}
 */
function noProject(projectId) {
  const id = Number(projectId);
  const error = Number.isInteger(id) && id > 0 ? `There is no project "${id}".` : "There is no such project.";
  return { ok: false, code: "not_found", error };
}

/**
 * Refuse a write from Crow's voice: it reads every song and changes none.
 * @param {object} res - the Express response
 * @returns {void}
 */
function sendReadOnly(res) {
  res.status(403).json({ ok: false, code: "read_only", error: READ_ONLY_TEXT });
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
 * The text one thrown error may be reported with.
 *
 * A refusal carries a code — a StudioError from the hub, or an AclError with
 * its name — and its message is written for the caller. Anything else is a bug:
 * its message may name a file, a query or a stack, so it is logged here and
 * replaced by one fixed sentence.
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  const code = typeof err?.code === "string" ? err.code : null;
  if (code || err?.name === "AclError") return String(err?.message || INTERNAL_ERROR_TEXT);
  console.warn("[studio]", err);
  return INTERNAL_ERROR_TEXT;
}

/**
 * Answer with an error a read threw.
 *
 * The hub's reads throw (there is no half-answer to hand back): a StudioError
 * keeps its code, an ACL refusal becomes 403 with code "acl", and anything
 * unexpected becomes a 500 with code "internal" and a fixed sentence, so a
 * broken query never reaches the caller.
 */
function sendError(res, err) {
  if (res.headersSent) return;
  const code = typeof err?.code === "string" ? err.code : null;
  const isAcl = err?.name === "AclError";
  if (!code && !isAcl) {
    res.status(500).json({ ok: false, code: "internal", error: errorText(err) });
    return;
  }
  res.status(isAcl ? 403 : (STATUS_BY_CODE[code] ?? 500)).json({
    ok: false,
    code: isAcl ? "acl" : code,
    error: errorText(err),
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
 * @param {{isAllowedNetwork: Function, sessionFromRequest: Function,
 *          verifySession: Function, csrfTokenAccepted: Function,
 *          classifyPeer: Function}} options.auth
 *   the gateway's dashboard-session checks (auth.js and shared/csrf.js) and the
 *   peer classifier (`servers/shared/peer-class.js`), which is what says
 *   whether an agent caller is really on this machine
 * @param {string} [options.crowHome] - where the agent token file lives
 * @param {string} [options.bundleDir] - the bundle directory asset routes read
 * @param {{projectOf: (botId: string) => Promise<number|null>,
 *          isVoiceBot: (botId: string) => boolean}|null} [options.botScope]
 *   which songs a Crow bot may see: the project linked to the bot
 *   (`pi_bot_defs.project_id`) and whether it is Crow's voice bot. The panel
 *   loader injects both; a caller that injects neither gets the strict
 *   default, in which every bot has no project and therefore sees no song.
 * @returns {{router: Function, attachUpgrade: Function, broadcast: Function}}
 *   `router(dashboardAuth)` builds the Express router, `attachUpgrade(server)`
 *   installs the `/api/studio/ws` handler, and `broadcast(song_id, payload)`
 *   is what the hub's `onBroadcast` calls.
 */
export function createStudioWeb({
  hub,
  Router,
  WebSocketServer,
  auth,
  crowHome,
  bundleDir,
  botScope = null,
} = {}) {
  if (!hub || typeof hub.openSong !== "function" || typeof hub.runCommand !== "function") {
    throw new TypeError("Studio web: the session hub is required");
  }
  if (typeof Router !== "function") throw new TypeError("Studio web: Router is required");
  if (typeof WebSocketServer !== "function") throw new TypeError("Studio web: WebSocketServer is required");
  for (const name of [
    "isAllowedNetwork",
    "sessionFromRequest",
    "verifySession",
    "csrfTokenAccepted",
    "classifyPeer",
  ]) {
    if (typeof auth?.[name] !== "function") throw new TypeError(`Studio web: auth.${name} is required`);
  }

  // Bot scope. Both halves arrive by injection because this module owns no
  // database and imports nothing from the gateway's own tree; without them a
  // bot has no project at all, which is the fail-closed default.
  const projectOfBot = typeof botScope?.projectOf === "function" ? botScope.projectOf : async () => null;
  const isVoiceBot = typeof botScope?.isVoiceBot === "function" ? botScope.isVoiceBot : () => false;

  /** `<song_id> → <client_id → socket record>` for every client that said hello. */
  const rooms = new Map();

  /** `<session token → Set<socket record>>` for every open socket, hello or not. */
  const openByToken = new Map();

  /** @returns {Set<object>} the open sockets holding one session token. */
  function openSocketsFor(token) {
    let open = openByToken.get(token);
    if (!open) {
      open = new Set();
      openByToken.set(token, open);
    }
    return open;
  }

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

  /**
   * Remember a helloed socket under its song and client id.
   * @param {object} record
   * @returns {void}
   */
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
    // The room this record actually joined, which is the only one its close may
    // speak for; a superseded record keeps pointing at the room it left.
    record.room = room;
  }

  /**
   * Forget a socket and drop its presence.
   *
   * Only the socket a room still holds may speak for its client: a socket that
   * a reconnect superseded is closed after its replacement joined, so its close
   * must not remove the live client or clear its focus.
   * @param {object} record
   * @returns {void}
   */
  function unregister(record) {
    const room = record.room;
    if (!room || room.get(record.client_id) !== record) return;
    room.delete(record.client_id);
    if (room.size === 0 && rooms.get(record.song_id) === room) rooms.delete(record.song_id);
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
      // The history first, then the document: the hub drops a song's cached
      // document when a save fails, so no doc reference outlives another hub
      // call — it is opened and read inside this one turn.
      history = await hub.history(song_id, { limit: HISTORY_PAGE });
      opened = await hub.openSong(song_id);
    } catch (err) {
      send(record.ws, { type: "error", error: errorText(err) });
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
      send(record.ws, { type: "error", error: errorText(err) });
    }
  }

  /**
   * A freshly upgraded socket, before it has said hello.
   * @returns {object} the record the upgrade handler tracks and the room holds
   */
  function openSocket(ws, req, token) {
    const record = {
      ws,
      req,
      token,
      song_id: null,
      client_id: null,
      room: null,
      helloing: false,
      helloed: false,
      author: HUMAN_AUTHOR,
    };
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
      // The first hello claims the socket synchronously, so a second frame that
      // arrives while the song is still being opened (a duplicate hello, or a
      // command) is answered instead of run: two hellos can never join two
      // rooms.
      if (record.helloed) {
        Promise.resolve()
          .then(() => handleMessage(record, raw))
          .catch((err) => {
            send(ws, { type: "error", error: errorText(err) });
          });
        return;
      }
      if (record.helloing) {
        send(ws, { type: "error", error: "bad message" });
        return;
      }
      record.helloing = true;
      Promise.resolve()
        .then(() => handleHello(record, raw))
        .catch((err) => {
          send(ws, { type: "error", error: errorText(err) });
        });
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (record.helloed) unregister(record);
    });
    return record;
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
      // live dashboard session, that session may hold at most
      // MAX_SOCKETS_PER_TOKEN open Studio sockets, and hello has to echo the
      // session's CSRF value.
      Promise.resolve()
        .then(() => auth.sessionFromRequest(req))
        .then((token) => {
          if (socket.destroyed) return;
          if (!token) return refuse(socket, 401, "Unauthorized");
          const open = openSocketsFor(token);
          if (open.size >= MAX_SOCKETS_PER_TOKEN) {
            return refuse(socket, 429, "Too Many Requests");
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            const record = openSocket(ws, req, token);
            open.add(record);
            ws.on("close", () => {
              open.delete(record);
              if (open.size === 0) openByToken.delete(token);
            });
          });
          return undefined;
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

  // ---- the Studio MCP process's gate ---------------------------------------
  //
  // The boot token is the gate, and it is a gate for LOCAL PROCESSES, not a
  // per-caller identity: whatever can read `<CROW_HOME>/studio-agent-token` and
  // reach a loopback socket is the agent. An uncontained process with a shell
  // can read that file — and such a process can open crow.db directly, so the
  // token hands it nothing it did not already have. A contained bot has no
  // CROW_HOME, so it has no token file and its agent calls fail closed. The
  // author an agent names is taken at its word for the same reason; what keeps
  // a Crow bot inside its own project is the scope check on every agent route
  // below, not the caller's honesty about who it is.

  /**
   * A truly local caller, no Funnel, and the boot token — in that order.
   *
   * `classifyPeer` is what makes "local" mean something behind Tailscale
   * Serve: Serve proxies tailnet traffic from a loopback socket, so
   * `remoteAddress` alone says 127.0.0.1 for a caller who is not on this
   * machine. Only `via === "local"` — a loopback socket that is not a trusted
   * proxy and carries no forwarding or tailscale-* header — may present the
   * token.
   */
  function agentGuard(req, res, next) {
    if (req.headers["tailscale-funnel-request"]) {
      return res.status(403).json({ ok: false, error: "refused" });
    }
    if (auth.classifyPeer(req)?.via !== "local") {
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
   * The song scope of one agent author, or null for an agent that is not a bot.
   *
   * A Crow bot is an agent whose id is `agent:bot:<botId>`. A bot sees the songs
   * of the project it is linked to (`pi_bot_defs.project_id`) and nothing else;
   * a bot with no project — including an unreadable one — sees nothing. Crow's
   * voice is the one reader that sees every song, because it hands work to the
   * right project's bot; it changes none of them (the routes refuse its writes).
   *
   * Every other agent — the operator's own Claude Code session, `agent:mcp` —
   * is not a bot: the project ACL is its scope, exactly as before.
   *
   * @param {{id?: string}|null} author - a sanitized agent author
   * @returns {Promise<{botId: string, projectId: number|null, voice: boolean}|null>}
   */
  async function scopeOf(author) {
    const id = String(author?.id ?? "");
    // Fail closed: only the operator's own MCP session ("agent:mcp") is
    // unscoped. A bot gets its project; any other agent id sees nothing.
    if (id === "agent:mcp") return null;
    if (!id.startsWith(AGENT_BOT_PREFIX)) return { botId: "", projectId: null, voice: false };
    const botId = id.slice(AGENT_BOT_PREFIX.length);

    let projectId = null;
    if (botId !== "") {
      try {
        const linked = await projectOfBot(botId);
        const value = Number(linked);
        if (linked != null && linked !== "" && Number.isInteger(value) && value > 0) projectId = value;
      } catch {
        // A project that cannot be read is no project: the bot fails closed.
        projectId = null;
      }
    }
    return { botId, projectId, voice: botId !== "" && isVoiceBot(botId) === true };
  }

  /**
   * The row of one song this caller may name, or null.
   *
   * Null is the answer for a missing song AND for a song outside a bot's
   * project, so the routes above answer both with one 404 body. A bot with no
   * project is settled before any query: it sees no song at all.
   *
   * @param {{projectId: number|null, voice: boolean}|null} scope - `scopeOf`'s
   *   answer; null for a non-bot agent, whose scope is the project ACL
   * @param {string} song_id
   * @returns {Promise<{id: string, project_id: number}|null>}
   */
  async function agentSongRow(scope, song_id) {
    if (scope && !scope.voice && scope.projectId == null) return null;
    const filter = scope && !scope.voice ? { project_ids: [scope.projectId] } : {};
    const songs = await hub.listSongs(filter);
    if (!Array.isArray(songs)) return null;
    return songs.find((song) => song && song.id === song_id) ?? null;
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

    r.post("/api/studio/songs", dashboardAuth, requireCsrf, handled(async (req, res) => {
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
      // Yjs is an ES module. Its MIME type is set here rather than left to the
      // send library's lookup table, because a module served as anything but
      // JavaScript is refused by the browser, and `.mjs` is not in every
      // version of that table.
      res.type("text/javascript");
      return res.sendFile(path);
    });

    // Yjs's ES module imports `lib0` by name, which a browser cannot resolve on
    // its own; the panel page carries an import map that points `lib0/` here
    // (panel/studio.js). One plain module file at a time, and nothing else in
    // the bundle's node_modules is reachable: the name is a bare word ending
    // in `.js`, resolved inside lib0's own directory only.
    r.get(/^\/dashboard\/studio\/assets\/lib0\/(.+)$/, dashboardAuth, (req, res) => {
      if (!bundleDir) return res.status(404).json({ error: "not_found" });
      const name = String(req.params[0] || "");
      // Plain path segments only (lib0 imports its own siblings such as
      // "./logging.common.js" and "./trait/equality.js"): no "..", no empty or
      // dot-leading segment, at most 3 deep, and the file must stay inside lib0.
      const segments = name.split("/");
      const plain = segments.length <= 3 && segments.every((seg) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(seg) && !seg.includes(".."));
      if (!plain) return res.status(404).json({ error: "not_found" });
      const root = join(bundleDir, "node_modules", "lib0");
      const path = join(root, name.endsWith(".js") ? name : `${name}.js`);
      if (!path.startsWith(root + sep) || !existsSync(path)) return res.status(404).json({ error: "not_found" });
      res.type("text/javascript");
      return res.sendFile(path);
    });

    // The SunVox module catalogue the panel's device pickers read: the same
    // engine the songs play through, asked once per process (catalogue.js
    // caches the promise), so a picker can never drift from the instrument it
    // creates. Only the self-contained generators are offered as a track.
    r.get("/api/studio/module-types", dashboardAuth, handled(async (_req, res) => {
      const catalogueModule = await import("./catalogue.js");
      const catalogue = await catalogueModule.moduleCatalogue();
      // GENERATOR_TYPES is a live binding: it is only filled once the
      // catalogue has been built, so it is read after the await, never
      // destructured before it.
      res.json({ generators: [...catalogueModule.GENERATOR_TYPES], modules: catalogue.modules });
    }));

    // ---- the Studio MCP process -----------------------------------------
    //
    // Every route resolves the caller's author first and its scope with it: a
    // Crow bot may name only the songs of its own project, a song outside it
    // answers with exactly the body a missing song gets, and Crow's voice reads
    // every song and writes none. The operator's own MCP session (`agent:mcp`)
    // is not a bot, so the project ACL remains its scope.

    r.get(`${AGENT}/songs`, agentGuard, handled(async (req, res) => {
      const filter = songFilter(req.query);
      const scope = await scopeOf(agentAuthorFor(req));
      if (!scope || scope.voice) return res.json(await hub.listSongs(filter));
      if (scope.projectId == null) return res.json([]);
      // Another project's songs are an empty list, never an error: a bot cannot
      // tell a project that has songs from one that does not.
      const asked = filter.project_ids?.[0];
      if (asked != null && asked !== scope.projectId) return res.json([]);
      return res.json(await hub.listSongs({ project_ids: [scope.projectId] }));
    }));

    r.post(`${AGENT}/songs`, agentGuard, handled(async (req, res) => {
      const author = agentAuthorFor(req);
      const scope = await scopeOf(author);
      if (scope?.voice) return sendReadOnly(res);
      if (scope) {
        const projectId = Number(req.body?.project_id);
        if (!Number.isInteger(projectId) || projectId !== scope.projectId) {
          // A bot may create a song only in its own project; any other project
          // is as hidden as one that does not exist.
          return res.status(404).json(noProject(req.body?.project_id));
        }
      }
      const result = await hub.createSong({
        project_id: req.body?.project_id,
        title: req.body?.title,
        author,
      });
      if (result.ok !== true) return sendResult(res, result);
      res.json({ song_id: result.song_id });
    }));

    r.get(`${AGENT}/songs/:id/snapshot`, agentGuard, handled(async (req, res) => {
      const scope = await scopeOf(agentAuthorFor(req));
      const row = await agentSongRow(scope, req.params.id);
      if (!row) return res.status(404).json(noSong(req.params.id));
      const opened = await hub.openSong(req.params.id);
      res.json({
        song_id: req.params.id,
        // The project a render is filed under is the hub's own answer, scoped
        // above — never something the agent's tool arguments can name.
        project_id: Number(row.project_id),
        // Crow's voice may read any song but not change one; a render files a
        // WAV into the project's storage, so the MCP side refuses it there.
        read_only: scope?.voice === true,
        snapshot: opened.snapshot,
        state: toBase64(encodeDocState(opened.doc)),
      });
    }));

    r.get(`${AGENT}/songs/:id/history`, agentGuard, handled(async (req, res) => {
      const scope = await scopeOf(agentAuthorFor(req));
      if (!(await agentSongRow(scope, req.params.id))) {
        return res.status(404).json(noSong(req.params.id));
      }
      res.json(await hub.history(req.params.id, historyOptions(req.query)));
    }));

    r.post(`${AGENT}/songs/:id/command`, agentGuard, handled(async (req, res) => {
      const author = agentAuthorFor(req);
      const scope = await scopeOf(author);
      if (scope?.voice) return sendReadOnly(res);
      if (!(await agentSongRow(scope, req.params.id))) {
        return res.status(404).json(noSong(req.params.id));
      }
      const result = await hub.runCommand({
        song_id: req.params.id,
        cmd_id: req.body?.cmd_id ?? null,
        command: req.body?.command,
        args: req.body?.args ?? {},
        author,
      });
      sendResult(res, result);
    }));

    r.post(`${AGENT}/songs/:id/undo`, agentGuard, handled(async (req, res) => {
      const author = agentAuthorFor(req);
      const scope = await scopeOf(author);
      if (scope?.voice) return sendReadOnly(res);
      if (!(await agentSongRow(scope, req.params.id))) {
        return res.status(404).json(noSong(req.params.id));
      }
      const result = await hub.undo({
        song_id: req.params.id,
        cmd_id: req.body?.cmd_id ?? null,
        entry_id: req.body?.entry_id,
        author,
      });
      sendResult(res, result);
    }));

    r.post(`${AGENT}/songs/:id/redo`, agentGuard, handled(async (req, res) => {
      const author = agentAuthorFor(req);
      const scope = await scopeOf(author);
      if (scope?.voice) return sendReadOnly(res);
      if (!(await agentSongRow(scope, req.params.id))) {
        return res.status(404).json(noSong(req.params.id));
      }
      const result = await hub.redo({
        song_id: req.params.id,
        cmd_id: req.body?.cmd_id ?? null,
        entry_id: req.body?.entry_id,
        author,
      });
      sendResult(res, result);
    }));

    return r;
  }

  return { router, attachUpgrade, broadcast };
}