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
 *     dashboard uses). Its `GET /api/studio/songs/:id/project-bot` route names
 *     the bot the panel's "Ask the agent" box talks to: the enabled bot whose
 *     home project is the song's project, read through the injected
 *     `projectBotOf` (this module owns no database);
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
 * their own — except one. A take chunk is 1 MiB of raw 24-bit PCM, which the
 * gateway's JSON parser leaves alone (`application/octet-stream` is not JSON),
 * so the chunk route runs the byte parser the gateway injects as `rawBody`.
 *
 * Take uploads are the one way a recording reaches storage. The panel PUTs a
 * take whose id it chose in 1 MiB pieces (`PUT /api/studio/takes/:take_id`,
 * then `PUT .../chunks/:index` with raw bytes), asks
 * `GET /api/studio/takes/:take_id` what has arrived after a reload, and says
 * `POST .../finish` once the last piece is in. A sample import or recording
 * uses the very same four routes with `kind: "sample"` in the begin body; the
 * service behind them files it under the song's `samples/` directory and puts
 * it in the song with `sample.add`. The service (`takes-upload.js`: staging on
 * disk, the streamed WAV, the internal `take.add`/`sample.add`) arrives
 * injected as `takeUploads`; when it is null — an instance that cannot stage
 * uploads — every take route answers 503 with one fixed sentence. What it
 * produces is played back through
 * `GET /api/studio/songs/:id/takes/:take_id/audio` and
 * `GET /api/studio/songs/:id/samples/:sample_id/audio`, which stream the WAV
 * from object storage (the injected `takeStorage`) and only from the exact key
 * `finish` wrote under the song's own `studio/<song_id>/takes/` or
 * `studio/<song_id>/samples/`.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { encodeDocState } from "./doc.js";
import { createLibraryStore } from "./library-store.js";

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

/** Where the take upload routes live. */
const TAKES_BASE = "/api/studio/takes";

/**
 * The largest take chunk the routes accept: 1 MiB plus one stereo 24-bit
 * frame, because the client cuts its chunks on frame boundaries and a frame is
 * three or six bytes wide (the same margin `takes-upload.js` allows itself).
 */
const CHUNK_LIMIT_BYTES = 1048576 + 6;

/** What a client whose chunk is over the limit is told. */
const CHUNK_TOO_LARGE_TEXT = "A take chunk can be at most 1 MiB.";

/**
 * What a client is told when its chunk body was not raw bytes at all.
 *
 * The gateway's global JSON parser runs before this router, so a chunk sent as
 * `application/json` arrives here already parsed into an object: the bytes the
 * recorder sends are gone, and staging an empty chunk would silently drop the
 * audio. It is refused instead.
 */
const CHUNK_NOT_BYTES_TEXT = "Send a take chunk as raw audio bytes.";

/** What every take route answers when this instance cannot stage takes. */
const TAKES_UNAVAILABLE_TEXT = "Studio cannot take recordings on this instance.";

/** What the audio route answers when this instance has no object storage. */
const STORAGE_UNAVAILABLE_TEXT = "Crow storage is not available on this instance.";

/**
 * What a caller is told for a library file this Crow does not hold: a catalog
 * entry nobody downloaded, a download still running, or another song's file.
 * The panel turns this into the "Get this instrument" action (plan 1d, Review
 * Focus 5).
 */
const MISSING_INSTRUMENT_TEXT = "This instrument is not on this Crow yet.";

/** What the library routes answer when this instance can hold no instruments. */
const LIBRARY_UNAVAILABLE_TEXT = "Studio cannot download instruments on this instance.";

/** What a caller is told when Studio itself could not download. */
const LIBRARY_FAILED_TEXT = "Studio could not download that instrument.";
const LIBRARY_OUT_OF_DATE_TEXT = "This song's copy of that instrument is out of date: the catalog now offers a different file. Remove it from the song and add it again to get the new one.";

/** What an agent is told when it asks to download a catalog file. */
const AGENT_DOWNLOAD_REFUSED_TEXT =
  "Downloading instruments is for the person at the Studio page; an agent cannot download one.";

/** How often the instrument housekeeping pass runs once Studio is up. */
export const LIBRARY_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The Content-Type one library kind is served with. */
const CONTENT_TYPE_BY_KIND = Object.freeze({
  font: "application/octet-stream",
  nam: "application/octet-stream",
  ir: "audio/wav",
});

/**
 * A stored WAV never changes under its key — the key is fixed per take or
 * sample id — so a browser may keep it for as long as it likes, and only in
 * private caches.
 */
const AUDIO_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * The two kinds of stored audio an audio route streams: the container a song
 * holds it in, the directory `finish` files it under, and the answer a caller
 * gets for one this song does not hold.
 * @type {Readonly<Object<string, {container: string, dir: string, noun: string, param: string}>>}
 */
const AUDIO_KINDS = Object.freeze({
  take: { container: "takes", dir: "takes", noun: "take", param: "take_id" },
  sample: { container: "samples", dir: "samples", noun: "sample", param: "sample_id" },
});

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
  // A command only Studio itself may run, tried through a door that is not
  // Studio's own: the caller may not have it, whatever it asks the song.
  studio_only: 403,
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
  ["resample.js", join("engine", "resample.js")],
  ["sampler-voice.js", join("engine", "sampler-voice.js")],
  ["perf-fx.js", join("engine", "perf-fx.js")],
  ["resample-worker.js", join("engine", "resample-worker.js")],
  ["chop.js", join("engine", "chop.js")],
  ["chop-worker.js", join("engine", "chop-worker.js")],
  ["calibrate-emitter.js", join("engine", "calibrate-emitter.js")],
  ["calibrate-detector.js", join("engine", "calibrate-detector.js")],
  ["recorder-processor.js", join("engine", "recorder-processor.js")],
  ["studio-processor.js", join("engine", "studio-processor.js")],
  // The SoundFont hosts: one synth per font, one MIDI channel per track. Part of
  // the worklet module (engine-client.js's SOURCE_FILES) like the rest.
  ["font-voice.js", join("engine", "font-voice.js")],
  ["engine-client.js", join("engine", "engine-client.js")],
  ["sunvox.js", join("vendor", "sunvox", "sunvox.js")],
  ["sunvox.wasm", join("vendor", "sunvox", "sunvox.wasm")],
  ["sunvox_lib_loader.js", join("vendor", "sunvox", "sunvox_lib_loader.js")],
  // The vendored SoundFont synth: one import-free classic script that defines
  // globalThis.StudioSpessa. It is part of the worklet module
  // (engine-client.js's SOURCE_FILES), served here so the browser can fetch it.
  ["spessasynth.js", join("vendor", "spessasynth", "spessasynth.js")],
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

/**
 * The one answer a take or sample its song does not hold gets.
 *
 * The same body is used for a take (or sample) of another song and for one
 * whose storage key names anything but this song's own `takes/` (or `samples/`)
 * directory, so a caller cannot tell which of the two it met.
 * @param {string} noun "take" or "sample"
 * @param {string} id
 * @returns {{error: string}}
 */
function noSuchAudio(noun, id) {
  return { error: `There is no ${noun} ${id} in this song.` };
}

/**
 * Answer with an error a take route threw.
 *
 * `takes-upload.js` writes its refusals for the caller and marks them with
 * `error.status` (400, 403, 404, 409, 413, 503, 507), so that status is used
 * as-is. Anything without one is a bug: its message could name a file or a
 * query, so it is logged here and replaced by a fixed sentence.
 * @param {object} res - the Express response
 * @param {unknown} err
 * @returns {void}
 */
function sendTakeError(res, err) {
  if (res.headersSent) return;
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    res.status(status).json({ error: String(err?.message || INTERNAL_ERROR_TEXT) });
    return;
  }
  console.warn("[studio] take upload:", err);
  res.status(500).json({ error: "Studio could not save that take." });
}

/**
 * Answer with an error a library route threw.
 *
 * `library-store.js` and the download route mark each refusal with `error.status` (400, 404, 409, 413,
 * 502, 503), because a download's failures — an unknown catalog row, a body
 * past its size, a hash that does not match, a network that is down — are
 * exactly the cases a caller needs to read. Anything without a status is a bug:
 * its message may name a path, so it is logged here and replaced.
 * @param {object} res - the Express response
 * @param {unknown} err
 * @returns {void}
 */
function sendLibraryError(res, err) {
  if (res.headersSent) return;
  // The hub's own read is where a song outside this caller's projects is
  // refused, and an ACL refusal is a 403 with the ACL's sentence.
  if (err?.name === "AclError") {
    res.status(403).json({ error: String(err?.message || LIBRARY_FAILED_TEXT) });
    return;
  }
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    res.status(status).json({ error: String(err?.message || LIBRARY_FAILED_TEXT) });
    return;
  }
  console.warn("[studio] library:", err);
  res.status(500).json({ error: LIBRARY_FAILED_TEXT });
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
 * @param {((projectId: number) => Promise<{bot_id: string, name: string}|null>)|null}
 *   [options.projectBotOf] the project's bot: the first ENABLED `pi_bot_defs`
 *   row whose `project_id` is that project, by display name. The panel loader
 *   reads it on the gateway's own client; a caller that injects nothing has no
 *   project bot, so the ask box stays disabled.
 * @param {{begin: Function, putChunk: Function, status: Function,
 *          finish: Function, sweepStale: Function}|null} [options.takeUploads]
 *   the upload service (`createTakeUploads`), which stages takes and samples.
 *   Null means this instance cannot stage uploads, and every upload route then
 *   answers 503.
 * @param {{getObject: Function, defaultBucket: Function,
 *          storagePrefixFor?: Function}|null} [options.takeStorage]
 *   object storage for the finished take or sample: `getObject(key, {bucket})`
 *   resolves to `{stream, stat}`, `defaultBucket()` names the bucket, and the
 *   optional `storagePrefixFor(projectId)` answers the project's
 *   `project_spaces.storage_prefix` (this module owns no database, so the
 *   adapter answers it; without it only keys under the empty prefix match).
 *   Null means the audio routes answer 503.
 * @param {((limit: number) => Function)|null} [options.rawBody] a factory for
 *   an `express.raw`-shaped parser, used for the take chunk body only (the
 *   gateway passes `(limit) => express.raw({type: () => true, limit,
 *   inflate: false})`). Without it the chunk route answers 503, because raw
 *   bytes are the one body this router has to parse itself.
 * @param {((songId: string) => Promise<object|null>)|null} [options.songRowOf]
 *   one song's row by id — the store's single-row lookup (`getSongRow`, the
 *   same function the hub reads a song with), injected because this module
 *   owns no database. The audio route needs one song's project and asks this
 *   instead of reading every song; without it the hub's song list is filtered
 *   here, which is the same answer at the cost of the whole list.
 * @param {{entries: Function, entry: Function, download: Function,
 *          fileFor: Function, fileForHash: Function, holds: Function,
 *          gc: Function}|null}
 *   [options.libraryStore] the instrument catalog and its stored copies
 *   (`createLibraryStore`). Without it this module builds one over `crowHome`
 *   and the bundle's own `library/catalog.json`; a caller with neither gets
 *   the 503 the library routes answer.
 * @param {((projectId: number) => Promise<void>)|null} [options.assertCanWrite]
 *   asserts the caller may write in one project (`write_files` in the project
 *   ACL), by throwing its refusal. The download route asks this BEFORE it
 *   fetches anything, so a read-only member never reaches the network. Injected
 *   because this module owns no database; without it a download is refused,
 *   because this Crow cannot prove the caller may write.
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
  projectBotOf = null,
  takeUploads = null,
  takeStorage = null,
  rawBody = null,
  songRowOf = null,
  libraryStore = null,
  assertCanWrite = null,
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

  // The project's bot, for the panel's "Ask the agent" box. Same contract as
  // the bot scope above: injected, and absent means "no bot", never a guess.
  const projectBot = typeof projectBotOf === "function" ? projectBotOf : async () => null;

  // One song's row, for the routes that need one song and not the catalogue.
  const songRowLookup = typeof songRowOf === "function" ? songRowOf : null;

  // The instrument catalog and the one stored copy of each of its files. It is
  // this bundle's own `library/catalog.json` over the instance's Crow home
  // unless a caller injects a store (a test with a local HTTP stub does). No
  // Crow home means no place to keep an instrument, and the library routes say
  // so with one fixed sentence rather than failing on a path.
  const library = libraryStore ?? (crowHome ? createLibraryStore({ crowHome }) : null);

  // The project's write capability, checked before a download fetches anything.
  // Absent it, no download runs: this Crow cannot prove the caller may write.
  const canWrite = typeof assertCanWrite === "function" ? assertCanWrite : null;

  /**
   * The row of one song: through the store's single-row lookup when one is
   * injected, otherwise by filtering the hub's song list.
   * @param {string} song_id
   * @returns {Promise<object|null>}
   */
  async function readSongRow(song_id) {
    if (songRowLookup) return songRowLookup(String(song_id));
    const songs = await hub.listSongs({});
    if (!Array.isArray(songs)) return null;
    return songs.find((song) => song && song.id === song_id) ?? null;
  }

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
   * The hub calls this after every applied step (`{update, entry}`), after
   * every presence change (`{presence}`) and when a song's document was dropped
   * and rebuilt, whole (`{state}` — a state frame, which the page answers by
   * building its document from the server's again). A `{state, resync: true}`
   * frame says the same document was rebuilt under the page rather than
   * answering a fresh hello, so the page keeps the commands it already has on
   * the wire and says nothing about reconnecting. Anything else is ignored, so
   * the hub can add payloads later without this layer guessing at them.
   * @param {string} song_id
   * @param {{update?: Uint8Array, entry?: object|null, presence?: object[],
   *          state?: Uint8Array, history?: object[], resync?: boolean}} payload
   * @returns {void}
   */
  function broadcast(song_id, payload) {
    if (!payload || typeof payload !== "object") return;
    if ("presence" in payload && payload.state == null) {
      sendToSong(song_id, { type: "presence", presence: payload.presence ?? [] });
      return;
    }
    if (payload.state != null) {
      sendToSong(song_id, {
        type: "state",
        update: toBase64(payload.state),
        history: payload.history ?? [],
        presence: payload.presence ?? hub.presence(song_id),
        resync: payload.resync === true,
      });
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

  /**
   * Answer one library route, or refuse it when this instance can hold no
   * instruments (no Crow home, or no catalog beside the bundle).
   * @param {(req: object, res: object) => Promise<void>} fn
   * @returns {Function} an Express handler
   */
  function libraryHandled(fn) {
    return (req, res) => {
      if (!library) {
        res.status(503).json({ error: LIBRARY_UNAVAILABLE_TEXT });
        return;
      }
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((err) => sendLibraryError(res, err));
    };
  }

  /**
   * Whether a request carries the Studio agent's own credentials.
   *
   * The download route is a person's: it is behind the dashboard session and
   * the CSRF header, so an agent that has neither is refused above. What this
   * adds is the case of a process that DOES hold a session (the MCP layer runs
   * as the operator) — presenting the agent token marks it as the agent, and a
   * download is people-only (plan 1d, Global Constraints).
   * @param {object} req
   * @returns {boolean}
   */
  function agentCaller(req) {
    return String(req.get("x-studio-token") ?? "").trim() !== "";
  }

  /**
   * Send one library file's bytes, on the audio route's header discipline: the
   * Content-Type, an immutable private cache and a Content-Length only once the
   * file is really there.
   * @param {object} res
   * @param {string} path the file on disk
   * @param {string} contentType
   * @returns {void}
   */
  function sendStoredFile(res, path, contentType) {
    let size = 0;
    try {
      const info = statSync(path);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      res.status(404).json({ error: MISSING_INSTRUMENT_TEXT });
      return;
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", AUDIO_CACHE_CONTROL);
    res.setHeader("Content-Length", String(size));
    const stream = createReadStream(path);
    stream.on("error", (err) => {
      if (res.headersSent) {
        // A half-sent instrument must not look complete.
        res.destroy();
        return;
      }
      console.warn("[studio] library file:", err);
      res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
    });
    res.on("error", () => stream.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  /**
   * Answer one take route, or refuse it when this instance cannot stage takes.
   *
   * The refusal comes before the body is read and before the hub is asked
   * anything, so a gateway without the upload service never touches a take.
   * @param {(req: object, res: object) => Promise<void>} fn
   * @returns {Function} an Express handler
   */
  function takesHandled(fn) {
    return (req, res) => {
      if (!takeUploads) {
        res.status(503).json({ error: TAKES_UNAVAILABLE_TEXT });
        return;
      }
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((err) => sendTakeError(res, err));
    };
  }

  /**
   * The storage key one stored object may be played from, exactly as `finish`
   * wrote it: `<prefix>studio/<song_id>/<dir>/<id>.wav`, where `dir` is `takes`
   * for a take and `samples` for a sample.
   *
   * The prefix is the song project's `project_spaces.storage_prefix`, which
   * this module cannot read (it owns no database), so the injected storage
   * adapter answers it. Without that answer the prefix is empty, and an object
   * whose key names any prefix at all is then refused rather than fetched —
   * the route never streams something it cannot place inside the song's own
   * `takes/` or `samples/` directory.
   *
   * @param {number|null} projectId the project the song lives in
   * @param {string} songId
   * @param {string} dir the kind's directory, "takes" or "samples"
   * @param {string} id the take or sample id
   * @returns {Promise<string>}
   */
  async function audioKeyOf(projectId, songId, dir, id) {
    const prefix =
      typeof takeStorage?.storagePrefixFor === "function"
        ? String((await takeStorage.storagePrefixFor(projectId)) ?? "")
        : "";
    return `${prefix}studio/${songId}/${dir}/${id}.wav`;
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
   *
   * The dashboard's routes include the take upload and take playback routes;
   * they are the only ones behind `dashboardAuth` that parse a body themselves
   * (the chunk's raw bytes, through `rawBody`).
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

    // The bot "Ask the agent" talks to: the enabled bot whose home project is
    // this song's project. A song outside the song list is a 404 (the page
    // then keeps the box disabled); a project with no enabled bot answers
    // `{bot_id: null}`, which is the same disabled box.
    //
    // The song's project comes from the hub's own song list, so the page is
    // told the same project the agent routes scope by, and `project_id` rides
    // back with the bot because the page files its Perch session under it.
    r.get("/api/studio/songs/:id/project-bot", dashboardAuth, handled(async (req, res) => {
      const song_id = String(req.params.id ?? "");
      const songs = await hub.listSongs({});
      const row = Array.isArray(songs) ? songs.find((song) => song && song.id === song_id) : null;
      if (!row) return res.status(404).json({ error: "not_found" });
      const projectId = Number(row.project_id);
      const bot = Number.isInteger(projectId) ? await projectBot(projectId) : null;
      const botId = bot && bot.bot_id ? String(bot.bot_id) : null;
      return res.json({
        bot_id: botId,
        name: botId ? String(bot.name || botId) : null,
        project_id: Number.isInteger(projectId) ? projectId : null,
      });
    }));

    // The engine's worklet module, composed here from the same source files a
    // Node render composes (engine-client's SOURCE_FILES and
    // composeEngineModule). A browser page under the dashboard's CSP cannot
    // load a worklet from a blob: URL; a same-origin script it can.
    // Cached per set of source-file modification times, so a bundle refresh
    // without a gateway restart never serves a stale module next to fresh assets.
    let engineModule = null;
    let engineModuleKey = "";
    r.get("/dashboard/studio/assets/engine-module.js", dashboardAuth, (req, res) => {
      if (!bundleDir) return res.status(404).json({ error: "not_found" });
      try {
        const engine = createRequire(import.meta.url)(join(bundleDir, "engine", "engine-client.js"));
        const paths = engine.SOURCE_FILES.map((name) => join(bundleDir, ASSET_FILES.get(name)));
        const key = paths.map((path) => statSync(path).mtimeMs).join(":");
        if (engineModule == null || key !== engineModuleKey) {
          engineModule = engine.composeEngineModule(paths.map((path) => readFileSync(path, "utf8")));
          engineModuleKey = key;
        }
      } catch (error) {
        console.warn("[studio] could not compose the engine module:", error?.message || error);
        return res.status(500).json({ error: "internal" });
      }
      res.type("text/javascript");
      res.setHeader("Cache-Control", "private, no-cache");
      return res.send(engineModule);
    });

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

    // ---- takes -----------------------------------------------------------
    //
    // A recording arrives as a client-chosen id and 1 MiB pieces, because the
    // browser that made it may be offline, may lose the network mid-take, or
    // may have its tab closed (spec §5.7, Review Focus 1). Everything here is
    // the dashboard's own: the author of a take is the person at the page, and
    // no route lets a caller name a storage key — `finish` writes it.
    //
    // `rawBody` is the gateway's byte parser (express.raw), made for this one
    // route: the gateway's global JSON parser skips a chunk's
    // `application/octet-stream`, so the bytes are read here. Its errors are
    // turned into JSON the way the Perch dictation route does, because the
    // gateway has no error middleware and a bare next(err) would answer HTML.
    const chunkBody = typeof rawBody === "function" ? rawBody(CHUNK_LIMIT_BYTES) : null;

    /** Read one chunk's raw bytes, or refuse it in JSON. */
    function parseChunkBody(req, res, next) {
      if (!takeUploads || !chunkBody) return res.status(503).json({ error: TAKES_UNAVAILABLE_TEXT });
      return chunkBody(req, res, (err) => {
        if (!err) return next();
        if (res.headersSent || res.destroyed) return undefined;
        if (err.type === "entity.too.large") {
          return res.status(413).json({ error: CHUNK_TOO_LARGE_TEXT });
        }
        return res.status(400).json({ error: "That chunk could not be read." });
      });
    }

    // Begin (or re-begin) one upload: a take, a sample, or — with
    // `kind: "font"` — a SoundFont bank the operator brought. Idempotent for the
    // same details, so a client that lost the answer can simply ask again. A
    // bank sends no rate or channels: it sends the file's name, its size, and
    // the first twelve bytes of it, so a file Studio cannot play is refused
    // before any of it is staged.
    r.put(`${TAKES_BASE}/:take_id`, dashboardAuth, requireCsrf, takesHandled(async (req, res) => {
      const body = req.body ?? {};
      const begun = await takeUploads.begin(String(req.params.take_id ?? ""), {
        kind: body.kind,
        song_id: body.song_id,
        project_id: body.project_id,
        clip_id: body.clip_id,
        name: body.name,
        origin: body.origin,
        target: body.target,
        file_name: body.file_name,
        bytes: body.bytes,
        head: body.head,
        rate: body.rate,
        channels: body.channels,
        offset_frames: body.offset_frames,
        compensated: body.compensated,
        bpm: body.bpm,
        author: HUMAN_AUTHOR,
      });
      res.json({ chunk_bytes: begun.chunk_bytes });
    }));

    // One chunk of a take, as raw 24-bit interleaved PCM. A body that did not
    // arrive as bytes (the gateway's JSON parser consumed it) is refused: an
    // empty chunk would stage nothing and lose the recording.
    r.put(`${TAKES_BASE}/:take_id/chunks/:index`, dashboardAuth, requireCsrf, parseChunkBody, takesHandled(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: CHUNK_NOT_BYTES_TEXT });
      }
      const staged = await takeUploads.putChunk(
        String(req.params.take_id ?? ""),
        Number(req.params.index),
        req.body,
      );
      res.json({ sha256: staged.sha256 });
    }));

    // What has arrived, so a panel that was reloaded resumes where it stopped.
    r.get(`${TAKES_BASE}/:take_id`, dashboardAuth, takesHandled(async (req, res) => {
      res.json(await takeUploads.status(String(req.params.take_id ?? "")));
    }));

    // The last piece is in: stream the WAV into storage and put the take (or
    // the sample, with its pad assignment) in the song. A retried finish
    // returns the same object without uploading again.
    r.post(`${TAKES_BASE}/:take_id/finish`, dashboardAuth, requireCsrf, takesHandled(async (req, res) => {
      const finished = await takeUploads.finish(String(req.params.take_id ?? ""), {
        chunk_hashes: req.body?.chunk_hashes,
      });
      res.json(finished);
    }));

    // One stored WAV of a song — a take's or a sample's — for the panel to play
    // and for a render to fetch. The read check is the one every other read
    // route makes: the hub's own `openSong`, which throws for an unknown song
    // and for a project the caller may not see (its AclError becomes a 403 in
    // `handled`).
    //
    // Storage is the one dependency that can fail at any point in this route,
    // and its errors are answered here rather than in `handled`: an S3 error's
    // message names the bucket and the key it was asked for, and its `code` is
    // a string, which `errorText` would take for a caller-safe StudioError.
    // A missing object is the take (or sample) this song does not have (404);
    // anything else about the store is a 503 with one fixed sentence. The
    // audio headers go out only with the first byte of the WAV, because a
    // Content-Length the response will not honour is the one answer that
    // cannot be taken back.
    async function serveAudio(req, res, kind) {
      const spec = AUDIO_KINDS[kind] ?? AUDIO_KINDS.take;
      const songId = String(req.params.id ?? "");
      const objectId = String(req.params[spec.param] ?? "");
      const missing = () => noSuchAudio(spec.noun, objectId);
      if (!takeStorage || typeof takeStorage.getObject !== "function") {
        return res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      }

      const row = await readSongRow(songId);
      if (!row) return res.status(404).json(missing());

      const opened = await hub.openSong(songId);
      const container = opened?.snapshot?.[spec.container];
      const stored = container && typeof container === "object" ? container[objectId] : null;
      if (!stored || typeof stored.storage_key !== "string") {
        return res.status(404).json(missing());
      }

      // Only the key `finish` writes may be streamed: one under this song's own
      // `studio/<song_id>/<dir>/`, named for this exact take (or sample). A key
      // anywhere else — another song's, another project's, or one with a `..`
      // in it — is an object this song does not hold.
      const expected = await audioKeyOf(Number(row.project_id), songId, spec.dir, objectId);
      if (stored.storage_key !== expected) return res.status(404).json(missing());

      const bucket = typeof takeStorage.defaultBucket === "function" ? takeStorage.defaultBucket() : undefined;

      let object = null;
      try {
        object = await takeStorage.getObject(stored.storage_key, { bucket });
      } catch (err) {
        const code = String(err?.code ?? "");
        if (code === "NotFound" || code === "NoSuchKey") {
          // The song points at an object whose audio is not in the bucket: for
          // this route that is something that cannot be played, not a bug.
          return res.status(404).json(missing());
        }
        console.warn(`[studio] ${spec.noun} audio:`, err);
        return res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      }

      const stream = object?.stream;
      if (!stream || typeof stream.pipe !== "function" || typeof stream.on !== "function") {
        console.warn(`[studio] ${spec.noun} audio: storage returned no stream for`, objectId);
        return res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      }

      const size = Number(object?.stat?.size ?? object?.stat?.metaData?.["content-length"]);

      let headed = false;
      /** The audio headers, set once and only once the WAV is really coming. */
      function sendAudioHeaders() {
        if (headed) return;
        headed = true;
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Cache-Control", AUDIO_CACHE_CONTROL);
        if (Number.isFinite(size) && size >= 0) res.setHeader("Content-Length", String(size));
      }

      /** Take back any audio header that was set before the first byte failed. */
      function dropAudioHeaders() {
        if (res.headersSent) return;
        for (const name of ["Content-Type", "Content-Length", "Cache-Control"]) {
          res.removeHeader(name);
        }
      }

      // The first chunk (or an empty object's end) is what makes this a WAV
      // response: until one of them arrives, an error is still a clean JSON
      // 503 with no audio headers on it.
      stream.once("data", sendAudioHeaders);
      stream.once("end", sendAudioHeaders);
      stream.on("error", (err) => {
        if (res.headersSent) {
          // The headers are out, so the only honest answer is to cut the
          // response: a half-sent WAV must not look complete.
          res.destroy();
          return;
        }
        console.warn(`[studio] ${spec.noun} audio stream:`, err);
        dropAudioHeaders();
        res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      });
      // A client that goes away mid-WAV has nobody left to answer, so the stream
      // is dropped and the response torn down; neither is an error to report.
      res.on("error", () => {
        if (typeof stream.destroy === "function") stream.destroy();
      });
      res.on("close", () => {
        if (typeof stream.unpipe === "function") stream.unpipe(res);
        if (typeof stream.destroy === "function") stream.destroy();
      });
      return stream.pipe(res);
    }

    // One take's recorded audio, and one sample's imported or recorded audio, on
    // the same rules (an exact key, immutable caching, the storage errors above).
    r.get("/api/studio/songs/:id/takes/:take_id/audio", dashboardAuth, handled(async (req, res) => {
      await serveAudio(req, res, "take");
    }));

    r.get("/api/studio/songs/:id/samples/:sample_id/audio", dashboardAuth, handled(async (req, res) => {
      await serveAudio(req, res, "sample");
    }));

    // ---- the instrument library -----------------------------------------
    //
    // A song's library names the banks (and later the captures and cabinets) it
    // can play. A catalog entry is a row in `library/catalog.json`; its file is
    // downloaded ONCE per instance, verified against the row's sha256 and size,
    // and kept at `<CROW_HOME>/studio/library/<sha256>.<ext>`, where every song
    // that names it reads the same copy.
    //
    // The download is a PERSON's action (Global Constraints: "Downloads are
    // people-only"): it is behind the dashboard session and the CSRF header,
    // and it refuses a caller that presents the Studio agent token. It also
    // needs `write_files` in the song's project, asserted BEFORE anything is
    // fetched, so a member who may only read a song cannot start one. A `GET`
    // of the stored bytes follows the sample route's rules — the song's own ACL
    // read, the entry's own hash or exact storage key, and the storage errors.

    /** One in-flight download per (song, catalog entry), so a double click
     * downloads once and adds one library entry. */
    const downloads = new Map();

    /** @returns {object|null} the entry a song already holds for one catalog row. */
    function catalogEntryIn(snap, catalogId) {
      const entries = snap?.library;
      if (!entries || typeof entries !== "object") return null;
      for (const entry of Object.values(entries)) {
        if (entry && entry.catalog_id === catalogId) return entry;
      }
      return null;
    }

    r.post("/api/studio/library/download", dashboardAuth, requireCsrf, libraryHandled(async (req, res) => {
      if (agentCaller(req)) return res.status(403).json({ error: AGENT_DOWNLOAD_REFUSED_TEXT });
      if (!canWrite) return res.status(503).json({ error: LIBRARY_UNAVAILABLE_TEXT });
      const songId = String(req.body?.song_id ?? "");
      const catalogId = String(req.body?.catalog_id ?? "");
      if (songId === "" || catalogId === "") {
        return res.status(400).json({ error: "A download needs a song and a catalog entry." });
      }

      // The song has to exist, and this caller has to be able to write in its
      // project, before anything is fetched: a read-only member is refused here
      // (its ACL refusal becomes a 403) with nothing over the network.
      const row = await readSongRow(songId);
      if (!row) return res.status(404).json({ error: `There is no song "${songId}".` });
      await canWrite(Number(row.project_id));
      const opened = await hub.openSong(songId);

      // The song may already hold this catalog file. Whether that answers the
      // ask is a question about THIS Crow's disk, not about the song: a stored
      // file that is gone, or whose bytes no longer hash to the entry, is
      // fetched again and the song keeps the entry it already has — no second
      // `library.add`.
      const existing = catalogEntryIn(opened?.snapshot, catalogId);

      const key = `${songId}:${catalogId}`;
      const running = downloads.get(key);
      if (running) return res.json(await running);
      const work = (async () => {
        if (existing) {
          // The song's entry names the bytes it was made with. When the catalog
          // row has since moved to a different file, fetching it again would
          // never match the song's hash, so the ask is answered with a sentence
          // instead of a download that can only fail (and would repeat).
          const current = await library.entry(catalogId);
          if (String(current.sha256 ?? "") !== String(existing.sha256 ?? "")) {
            const error = new Error(LIBRARY_OUT_OF_DATE_TEXT);
            error.status = 409;
            throw error;
          }
          if (await library.holds(String(existing.sha256 ?? ""))) {
            return { entry: existing, downloaded: false };
          }
          const refetched = await library.download(catalogId);
          return { entry: existing, downloaded: refetched.fetched };
        }
        const downloaded = await library.download(catalogId);
        const entry = {
          // `lib-` plus a uuid: 40 characters, the library id rule's exact limit.
          id: `lib-${randomUUID()}`,
          kind: downloaded.entry.kind,
          name: downloaded.entry.name,
          source: "catalog",
          catalog_id: catalogId,
          sha256: downloaded.entry.sha256,
          bytes: downloaded.entry.bytes,
          licence: downloaded.entry.licence,
          credit: downloaded.entry.credit,
          author_label: HUMAN_AUTHOR.label,
        };
        // Studio's own command (`internal: true`), issuing as the person at the
        // page: only the route knows which file was stored and what its hash is.
        // The new entry's own id is part of the `cmd_id`, so a download that
        // follows a remove inside the hub's de-duplication window is a new step
        // rather than a replay of the add that was undone.
        const applied = await hub.runCommand({
          song_id: songId,
          cmd_id: `library-download:${key}:${entry.id}`,
          command: "library.add",
          args: { entry },
          author: HUMAN_AUTHOR,
          internal: true,
        });
        if (applied?.ok !== true) {
          const error = new Error(String(applied?.error ?? LIBRARY_FAILED_TEXT));
          error.status = statusForCode(applied?.code);
          throw error;
        }
        return { entry: applied.entry?.after?.[`library:${entry.id}|*`] ?? entry, downloaded: downloaded.fetched };
      })().finally(() => downloads.delete(key));
      downloads.set(key, work);
      return res.json(await work);
    }));

    // One library file, for the panel to load into the worklet. A catalog entry
    // serves this Crow's verified copy; an uploaded entry serves the exact
    // storage key its upload wrote under this song's own `library/` directory.
    // Anything else — a catalog file nobody downloaded, another song's upload, a
    // key that is not this entry's — is MISSING_INSTRUMENT_TEXT.
    r.get("/api/studio/songs/:id/library/:library_id/file", dashboardAuth, handled(async (req, res) => {
      const songId = String(req.params.id ?? "");
      const libraryId = String(req.params.library_id ?? "");
      const missing = () => res.status(404).json({ error: MISSING_INSTRUMENT_TEXT });

      const row = await readSongRow(songId);
      if (!row) return missing();
      // The hub's own read: an unknown song and a project this caller may not
      // see both refuse here (the ACL error becomes a 403 in `handled`).
      const opened = await hub.openSong(songId);
      const entry = opened?.snapshot?.library?.[libraryId];
      if (!entry || typeof entry !== "object") return missing();
      const contentType = CONTENT_TYPE_BY_KIND[entry.kind] ?? "application/octet-stream";

      // A bundled file ships inside the bundle itself (`library/files/`), not in
      // a song's storage and not in the download cache. Nothing serves one yet
      // (Crow's own captures arrive with a later task), so it reads as a file
      // this Crow does not have rather than as a storage failure.
      if (entry.source === "bundled") return missing();

      if (entry.catalog_id) {
        if (!library) return res.status(503).json({ error: LIBRARY_UNAVAILABLE_TEXT });
        const path = await library.fileForHash(String(entry.sha256 ?? ""));
        if (!path) return missing();
        return sendStoredFile(res, path, contentType);
      }

      // An uploaded file: the exact key its finish wrote, under this song's own
      // `studio/<song_id>/library/`, named for this entry. A key anywhere else
      // — another song's, another project's, or one with a `..` in it — is not
      // something this song holds.
      const storedKey = typeof entry.storage_key === "string" ? entry.storage_key : "";
      if (storedKey === "" || !takeStorage || typeof takeStorage.getObject !== "function") {
        return res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      }
      const ownKey = await audioKeyOf(Number(row.project_id), songId, "library", libraryId);
      // `audioKeyOf` says `.wav`; a library file's extension follows its kind,
      // so the entry's own key must start with the id it belongs to instead.
      const ownPrefix = ownKey.slice(0, ownKey.length - "wav".length);
      if (!storedKey.startsWith(ownPrefix) || storedKey.slice(ownPrefix.length).includes("/")) {
        return missing();
      }

      const bucket = typeof takeStorage.defaultBucket === "function" ? takeStorage.defaultBucket() : undefined;
      let object = null;
      try {
        object = await takeStorage.getObject(storedKey, { bucket });
      } catch (err) {
        const code = String(err?.code ?? "");
        if (code === "NotFound" || code === "NoSuchKey") return missing();
        console.warn("[studio] library file:", err);
        return res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      }
      const stream = object?.stream;
      if (!stream || typeof stream.pipe !== "function" || typeof stream.on !== "function") {
        console.warn("[studio] library file: storage returned no stream for", libraryId);
        return res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      }
      const size = Number(object?.stat?.size ?? object?.stat?.metaData?.["content-length"]);
      let headed = false;
      const sendHeaders = () => {
        if (headed) return;
        headed = true;
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", AUDIO_CACHE_CONTROL);
        if (Number.isFinite(size) && size >= 0) res.setHeader("Content-Length", String(size));
      };
      stream.once("data", sendHeaders);
      stream.once("end", sendHeaders);
      stream.on("error", (err) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        console.warn("[studio] library file stream:", err);
        for (const name of ["Content-Type", "Content-Length", "Cache-Control"]) res.removeHeader(name);
        res.status(503).json({ error: STORAGE_UNAVAILABLE_TEXT });
      });
      res.on("error", () => {
        if (typeof stream.destroy === "function") stream.destroy();
      });
      res.on("close", () => {
        if (typeof stream.unpipe === "function") stream.unpipe(res);
        if (typeof stream.destroy === "function") stream.destroy();
      });
      return stream.pipe(res);
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

/**
 * Sweep the instrument library on Studio's start and then every 24 hours.
 *
 * One pass is `libraryGc` (`library-store.js`) with `inUse` the sha256 of every
 * library entry of every song in THIS instance's studio database, read from the
 * hub (`libraryHashes()`, which loads each song's document the same way the
 * song list and `openSong` read it). When a song's document cannot be read that
 * read throws and the pass is SKIPPED, deleting nothing: a pass that saw only
 * part of the instance could collect a file a song it could not read still
 * names.
 *
 * A failure is logged and never thrown — housekeeping must not take Studio
 * down — and a caller without both halves (no hub read, no store) simply gets
 * no pass.
 * @param {{hub: object, library: object, intervalMs?: number,
 *          log?: {warn: Function, log: Function}}} options
 * @returns {{run: () => Promise<object|null>, ready: Promise<object|null>,
 *            stop: () => void}} one pass on demand (null when it was skipped),
 *   the first pass's promise, and a stop for the daily timer
 */
export function startLibraryGc({ hub, library, intervalMs = LIBRARY_GC_INTERVAL_MS, log = console } = {}) {
  const canRun = Boolean(
    hub && typeof hub.libraryHashes === "function" && library && typeof library.gc === "function",
  );
  let inFlight = null;

  /** @returns {Promise<object|null>} the pass's result, or null when it was skipped */
  function run() {
    if (!canRun) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const inUse = await hub.libraryHashes();
        const result = await library.gc({ inUse });
        if (Array.isArray(result?.removed) && result.removed.length > 0) {
          log.log(`[studio] library housekeeping removed ${result.removed.length} unused file(s)`);
        }
        return result;
      } catch (err) {
        // A song whose document could not be read, or a disk that failed:
        // NOTHING was deleted this pass (see `libraryGc`).
        log.warn("[studio] library housekeeping skipped:", err?.message || err);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const ready = run();
  const timer = setInterval(() => {
    run();
  }, intervalMs);
  timer.unref?.();
  return { run, ready, stop: () => clearInterval(timer) };
}