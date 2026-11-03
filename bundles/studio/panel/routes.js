/**
 * Studio panel routes (gateway process). Installed as a COPY at
 * ~/.crow/panels/studio-routes.js, so everything is resolved by path: the
 * studio bundle dir (installed copy first) and the app root (CROW_APP_ROOT).
 *
 * This file only wires things together. The router, the agent token and the
 * WebSocket live in `../server/web.js`, which receives every gateway
 * dependency by injection; one session hub is built here for the life of the
 * gateway process, on the gateway's own database client, and its broadcasts go
 * straight back into the web layer so an edit reaches every open client.
 * The bot scope is wired here too: a Crow bot's linked project comes from
 * `pi_bot_defs` on that same client, and the voice-bot rule from the app's own
 * `servers/gateway/voice/crow-voice.js`. The panel's "Ask the agent" box asks
 * the same table for the song project's bot (`projectBotOf` below).
 *
 * Request bodies are left to the gateway: its global JSON parser (1 MB cap)
 * runs before the panel router, so nothing here adds one — with one exception.
 * A take chunk is 1 MiB of raw 24-bit PCM, which the JSON parser leaves alone,
 * so the take upload service is wired here too: its storage adapter
 * (`server/take-storage.js`, over `servers/storage/s3-client.js`), the song
 * lookup on the gateway's client, its staging directory under CROW_HOME, and
 * an `express.raw` parser that the web layer applies to the chunk route alone
 * (its errors become JSON there).
 */
import { Router, raw } from "express";
import { WebSocketServer } from "ws";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const isBundle = (p) => !!p && existsSync(join(p, "manifest.json")) && existsSync(join(p, "server", "hub.js"));
const BUNDLE_DIR = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "studio"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "studio") : null,
  resolve(here, ".."),
].filter(Boolean).find(isBundle);
if (!BUNDLE_DIR) throw new Error("studio: bundle directory not found");
const bImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);

const { appImport } = await bImport("server/app-root.js");
const { createDbClient } = await appImport("servers/db.js");
// The dashboard's own session and CSRF checks. The WebSocket reuses them
// rather than minting anything: a Studio socket is a dashboard session.
const { isAllowedNetwork, sessionFromRequest, verifySession } = await appImport("servers/gateway/dashboard/auth.js");
const { csrfTokenAccepted } = await appImport("servers/gateway/dashboard/shared/csrf.js");
// The real peer classifier. Serve proxies tailnet traffic from a loopback
// socket, so `req.socket.remoteAddress` alone cannot tell a local caller from
// a tailnet one; the agent routes ask this instead.
const { classifyPeer } = await appImport("servers/shared/peer-class.js");
// The one definition of Crow's voice bot, so the Studio agent API never keeps a
// second copy of that id: the voice bot reads every song and writes none.
const { isVoiceBotId } = await appImport("servers/gateway/voice/crow-voice.js");
// The real project ACL module: the hub decides no access by itself.
const projectAcl = await appImport("servers/shared/project-acl.js");
const { createHub } = await bImport("server/hub.js");
const { createStudioWeb, ensureAgentToken } = await bImport("server/web.js");
const { createTakeUploads } = await bImport("server/takes-upload.js");
// The take storage adapter: the instance's object storage, narrowed to the
// calls the uploads and the audio route make. It is built whether or not
// storage is configured yet, and it asks on every call, so a Shared Storage
// setting saved after boot works without a restart.
const { createTakeStorage } = await bImport("server/take-storage.js");
// The song table: a take's project is its song's project, never a caller's
// word for it. The studio tables are created by the hub, so this is the same
// function the hub itself reads a song row with.
const { getSongRow } = await bImport("server/store.js");
// The instance's object storage, wired to the database's Shared Storage
// settings at boot by the gateway. A failure to load it must not stop the
// panel: takes still stage on disk and only the upload to the bucket refuses.
const s3 = await appImport("servers/storage/s3-client.js").catch(() => null);

const db = createDbClient();
const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");

// One hub per gateway process. The hub's broadcasts reach the web layer that
// is built just below it; by the time any edit runs, `web` is assigned.
let web = null;
const hub = createHub({
  db,
  acl: projectAcl,
  onBroadcast: (song_id, payload) => web?.broadcast(song_id, payload),
});

/** The one promise that makes sure the studio tables exist (see `ensureStudioTables`). */
let studioTablesReady = null;

/**
 * The finished-take storage the audio route reads through and the uploads write
 * through. Built unconditionally: `take-storage.js` decides availability per
 * call, so an instance whose Shared Storage is configured later (the Nest's
 * save handler calls `resetStorageClient()`) starts using it at once, and one
 * with no storage at all answers 503 with one fixed sentence. When
 * `servers/storage/s3-client.js` itself cannot be loaded, `s3` is null and the
 * same adapter refuses every call, which is the same 503.
 */
const takeStorage = createTakeStorage({ client: s3, db });

/**
 * The studio tables are created by the hub before its own first use, and a
 * take's song lookup reads `studio_songs` directly, so an upload that arrives
 * before any other Studio call makes sure of them first. One attempt per
 * process; a failure is retried by the next call.
 * @returns {Promise<void>}
 */
function ensureStudioTables() {
  if (!studioTablesReady) {
    studioTablesReady = Promise.resolve()
      .then(() => hub.listSongs({}))
      .then(() => undefined)
      .catch((error) => {
        studioTablesReady = null;
        throw error;
      });
  }
  return studioTablesReady;
}

/**
 * The take upload service: staging under `<CROW_HOME>/studio-staging`, the
 * streamed WAV into project storage, the internal `take.add` through the hub.
 * Null when it cannot be built, which makes every take route answer 503 — but
 * staging works even with no storage, so a take recorded now is not lost.
 */
let takeUploads = null;
try {
  takeUploads = createTakeUploads({
    stagingDir: join(crowHome, "studio-staging"),
    storage: takeStorage,
    db,
    acl: projectAcl,
    hub,
    // A take is filed in its song's project, read on the gateway's own client
    // through the function the hub itself reads a song row with.
    songs: {
      async projectOf(songId) {
        await ensureStudioTables();
        const row = await getSongRow(db, String(songId));
        return row ? Number(row.project_id) : null;
      },
    },
    now: () => Date.now(),
  });
  // Unfinished uploads nobody came back for are dropped once, at boot: the
  // panel re-begins and re-sends from its own IndexedDB copy when that happens.
  takeUploads.sweepStale().catch((error) => {
    console.warn("[studio] take staging sweep failed:", error?.message || error);
  });
} catch (error) {
  takeUploads = null;
  console.warn("[studio] takes cannot be recorded on this instance:", error?.message || error);
}

web = createStudioWeb({
  hub,
  Router,
  WebSocketServer,
  auth: { isAllowedNetwork, sessionFromRequest, verifySession, csrfTokenAccepted, classifyPeer },
  crowHome,
  bundleDir: BUNDLE_DIR,
  // The take upload routes (staging, the streamed WAV, the internal take.add)
  // and the object storage the finished take is streamed back from. A chunk's
  // raw body is the one body the gateway's JSON parser does not read, so the
  // byte parser is built here too, and its errors become JSON in the web layer.
  takeUploads,
  takeStorage,
  // The song's own row for one id, through the store's single-row lookup (the
  // same function the hub reads a song with): the audio route needs one song's
  // project, never the whole catalogue.
  songRowOf: (songId) => getSongRow(db, String(songId)),
  rawBody: (limit) => raw({ type: () => true, limit, inflate: false }),
  // Which songs a Crow bot may see. A bot's home project is the one its
  // `pi_bot_defs` row names — the same rule the Board applies to a bot's cards
  // — read on the gateway's own client. Without a project it sees no song.
  botScope: {
    async projectOf(botId) {
      const { rows } = await db.execute({
        sql: "SELECT project_id FROM pi_bot_defs WHERE bot_id = ?",
        args: [String(botId)],
      });
      const linked = rows[0]?.project_id;
      return linked == null ? null : Number(linked);
    },
    isVoiceBot: (botId) => isVoiceBotId(String(botId)) === true,
  },
  // The bot the panel's "Ask the agent" box talks to: the first ENABLED bot
  // whose home project is this song's project, by display name — the same
  // `pi_bot_defs.project_id` link the bot scope above reads. No enabled bot
  // means no bot to ask, and the box stays disabled.
  async projectBotOf(projectId) {
    const id = Number(projectId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const { rows } = await db.execute({
      sql:
        "SELECT bot_id, display_name FROM pi_bot_defs " +
        "WHERE project_id = ? AND enabled = 1 ORDER BY display_name LIMIT 1",
      args: [id],
    });
    const row = rows?.[0];
    if (!row) return null;
    return { bot_id: String(row.bot_id), name: String(row.display_name || row.bot_id) };
  },
});

// Mint the agent token at boot so a Studio MCP process started from the same
// CROW_HOME finds it; the first agent request mints it too if this fails.
try {
  ensureAgentToken(crowHome);
} catch {
  console.warn("[studio] the agent token could not be minted at boot; the first agent call retries it");
}

/** The panel's HTTP routes, mounted behind the dashboard's session check. */
export default function studioRouter(dashboardAuth) {
  return web.router(dashboardAuth);
}

/** The `/api/studio/ws` upgrade handler, collected by panel-registry.js. */
export function setupWebSocket(server) {
  return web.attachUpgrade(server);
}