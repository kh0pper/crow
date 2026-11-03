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
 * runs before the panel router, so nothing here adds one.
 */
import { Router } from "express";
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

web = createStudioWeb({
  hub,
  Router,
  WebSocketServer,
  auth: { isAllowedNetwork, sessionFromRequest, verifySession, csrfTokenAccepted, classifyPeer },
  crowHome,
  bundleDir: BUNDLE_DIR,
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