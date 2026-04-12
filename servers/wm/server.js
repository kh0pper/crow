/**
 * Crow Window Manager MCP Server
 *
 * Minimal server with 2 tools for voice-controlled window management
 * in the AI Companion's kiosk mode. Designed for small local LLMs
 * (Qwen 3.5 4B) — simple params, smart frontend defaults.
 *
 * The server is stateless. Tool results are JSON strings that the
 * frontend's injected JS parses to execute window operations.
 *
 * Factory function: createWmServer(dbPath?, options?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import net from "node:net";
import YouTubeSR from "youtube-sr";
const YouTube = YouTubeSR.default || YouTubeSR;

// Lazy-loaded sharing server functions for social commands
let _sendRoomInvite = null;
let _sendVoiceMemo = null;
let _sendReaction = null;
async function getSendRoomInvite() {
  if (!_sendRoomInvite) {
    try {
      const { sendRoomInvite } = await import("../sharing/server.js");
      _sendRoomInvite = sendRoomInvite;
    } catch {
      // Sharing server not available (standalone WM mode)
    }
  }
  return _sendRoomInvite;
}
async function getSendVoiceMemo() {
  if (!_sendVoiceMemo) {
    try {
      const { sendVoiceMemo } = await import("../sharing/server.js");
      _sendVoiceMemo = sendVoiceMemo;
    } catch {}
  }
  return _sendVoiceMemo;
}
async function getSendReaction() {
  if (!_sendReaction) {
    try {
      const { sendReaction } = await import("../sharing/server.js");
      _sendReaction = sendReaction;
    } catch {}
  }
  return _sendReaction;
}
let _sendBotRelay = null;
async function getSendBotRelay() {
  if (!_sendBotRelay) {
    try {
      const { sendBotRelay } = await import("../sharing/server.js");
      _sendBotRelay = sendBotRelay;
    } catch {}
  }
  return _sendBotRelay;
}

const VALID_APPS = ["youtube", "browser", "blog", "jellyfin", "plex", "romm", "nest", "videocall"];

// Pet-mode AppImage (Phase 3.1): built by bundles/companion/scripts/build-pet-linux.sh
// and installed to ~/.crow/bin/. Linux-only; tracked PID lives in-memory so
// a restart of the WM server orphans the pet — caller re-launches explicitly.
const PET_APPIMAGE_PATH = resolve(homedir(), ".crow/bin/open-llm-vtuber.AppImage");
const PET_VALID_ANCHORS = ["right", "left", "bottom-right", "bottom-left"];
let petPid = null;

// Kill-switch. CROW_PET_MODE env wins over the manifest for quick operator
// toggling. Manifest default: true on Linux x86_64, false elsewhere (no
// AppImage exists for other platforms anyway). Read once at module load —
// changes require a gateway restart, which matches how manifests are reloaded.
function readPetModeEnabled() {
  const envOverride = process.env.CROW_PET_MODE;
  if (envOverride !== undefined) {
    return String(envOverride).toLowerCase() !== "false" && envOverride !== "0";
  }
  try {
    const serverDir = fileURLToPath(new URL(".", import.meta.url));
    const manifestPath = resolve(serverDir, "../../bundles/companion/manifest.json");
    if (existsSync(manifestPath)) {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const flag = raw?.companion?.pet_mode;
      if (flag === false) return false;
      if (flag === true) return true;
    }
  } catch { /* fall through to platform default */ }
  return process.platform === "linux" && process.arch === "x64";
}
const PET_MODE_ENABLED = readPetModeEnabled();

// Socket path resolution mirrors patch 0008's server-side logic.
function petSocketPath() {
  if (process.env.CROW_PET_SOCKET) return process.env.CROW_PET_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/crow-pet.sock`;
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return `/tmp/crow-pet-${uid}.sock`;
}

// Send a JSON op to the running pet's control socket. Short timeout —
// if the pet is wedged we fall back to respawn rather than hang.
function sendPetOp(msg, timeoutMs = 500) {
  return new Promise((resolveP) => {
    const sockPath = petSocketPath();
    if (!existsSync(sockPath)) return resolveP({ ok: false, error: "no-socket" });
    const c = net.createConnection(sockPath);
    let buf = "";
    const timer = setTimeout(() => { try { c.destroy(); } catch {} resolveP({ ok: false, error: "timeout" }); }, timeoutMs);
    c.setEncoding("utf8");
    c.on("connect", () => { c.write(JSON.stringify(msg) + "\n"); });
    c.on("data", (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        try { resolveP(JSON.parse(buf.slice(0, idx))); }
        catch { resolveP({ ok: false, error: "bad-response" }); }
        try { c.end(); } catch {}
      }
    });
    c.on("error", (e) => { clearTimeout(timer); resolveP({ ok: false, error: String(e.message || e) }); });
  });
}

async function launchPet(anchor) {
  if (!PET_MODE_ENABLED) {
    return { error: "Pet mode is disabled on this install. Set companion.pet_mode: true in bundles/companion/manifest.json (or unset CROW_PET_MODE=false) and restart the gateway to enable." };
  }
  if (process.platform !== "linux") {
    return { error: "Pet mode is Linux-only. Use web-tiled mode on this platform." };
  }
  if (!existsSync(PET_APPIMAGE_PATH)) {
    return { error: `Pet AppImage not found at ${PET_APPIMAGE_PATH}. Run bundles/companion/scripts/build-pet-linux.sh to build it.` };
  }
  if (petPid) {
    try {
      process.kill(petPid, 0);
      // Pet is alive — try to re-anchor via control socket instead of respawning.
      const effectiveAnchor = anchor || "bottom-right";
      const r = await sendPetOp({ op: "anchor", spec: { anchor: effectiveAnchor, width: 320, height: 480 } });
      if (r.ok) return { pid: petPid, anchor: effectiveAnchor, reanchored: true };
      return { error: `Pet is already running (pid ${petPid}) but control socket is unreachable: ${r.error}. Use 'close pet' first.` };
    }
    catch { petPid = null; }
  }
  // Default to bottom-right — keeps the mascot out of the Blockly kiosk's
  // workspace on a typical 1920x1080 layout. Patch 0007 reads CROW_PET_ANCHOR
  // at launch and calls setPetBounds({ anchor, width: 320, height: 480 }).
  const effectiveAnchor = anchor || "bottom-right";
  const env = { ...process.env, CROW_PET_ANCHOR: effectiveAnchor };
  // Detach so the pet outlives the MCP process; ignore I/O.
  const child = spawn(PET_APPIMAGE_PATH, [], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  petPid = child.pid;
  return { pid: child.pid, anchor: effectiveAnchor };
}

function closePet() {
  if (!petPid) return { ok: false, error: "Pet is not running." };
  try { process.kill(petPid, "SIGTERM"); const was = petPid; petPid = null; return { ok: true, pid: was }; }
  catch (e) { petPid = null; return { ok: false, error: String(e.message || e) }; }
}

const APP_DESCRIPTIONS = VALID_APPS.map(a => {
  switch (a) {
    case "youtube": return "youtube — Play YouTube videos (query: video ID or search terms)";
    case "browser": return "browser — Open any web page (query: full URL starting with https://)";
    case "blog": return "blog — Read a Crow blog post (query: post slug or empty for blog home)";
    case "jellyfin": return "jellyfin — Browse Jellyfin media library";
    case "plex": return "plex — Browse Plex media library";
    case "romm": return "romm — Browse and play retro games";
    case "nest": return "nest — Open a Crow's Nest dashboard panel (query: panel name like memory, messages, files, settings)";
    case "videocall": return "videocall — Open a video call in a window (query: room=CODE&token=TOKEN)";
    default: return a;
  }
}).join("\n");

/** Search YouTube using youtube-sr and return the first video result */
async function searchYouTube(query) {
  try {
    const results = await YouTube.search(query, { limit: 1, type: "video" });
    if (results.length > 0 && results[0].id) {
      return { videoId: results[0].id, title: results[0].title || query };
    }
  } catch { /* search failed */ }
  return null;
}

/** Search the web using Brave Search API and return formatted results */
async function searchWeb(query, count = 5) {
  const apiKey = process.env.BRAVE_API_KEY || "";
  if (!apiKey) return { error: "Web search is not configured. Set BRAVE_API_KEY in .env." };
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return { error: `Search failed: ${res.status}` };
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, count);
    if (results.length === 0) return { error: `No results found for "${query}".` };
    const stripHtml = (s) => s.replace(/<[^>]*>/g, "")
      .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/").replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const blocks = [{ type: "heading", text: `Search: ${query}` }];
    for (const r of results) {
      blocks.push({
        type: "card",
        title: stripHtml(r.title || "Untitled"),
        body: stripHtml(r.description || ""),
        link: r.url || "",
      });
    }
    return { blocks, title: `Search: ${query}` };
  } catch (e) {
    return { error: `Search failed: ${e.message}` };
  }
}

/** Resolve app + query into a URL the frontend will load in an iframe */
async function resolveUrl(app, query, gatewayHost) {
  switch (app) {
    case "youtube": {
      if (!query) {
        return { error: "Please specify what to play or search for on YouTube. Example: 'open youtube lofi hip hop radio'" };
      }
      // 11-char alphanumeric = video ID
      if (/^[a-zA-Z0-9_-]{11}$/.test(query)) {
        return { url: `https://www.youtube.com/embed/${query}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(`https://${gatewayHost}`)}`, title: "YouTube" };
      }
      // Full YouTube URL — extract video ID
      const vidMatch = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
      if (vidMatch) {
        return { url: `https://www.youtube.com/embed/${vidMatch[1]}?autoplay=1&enablejsapi=1`, title: "YouTube" };
      }
      // Search query — resolve to a video ID server-side via Invidious API,
      // then return a YouTube embed URL (the only path YT allows in iframes)
      const result = await searchYouTube(query);
      if (result) {
        return { url: `https://www.youtube.com/embed/${result.videoId}?autoplay=1&enablejsapi=1`, title: result.title };
      }
      return { error: `Could not find YouTube videos for "${query}". Try a more specific search or provide a video ID.` };
    }
    case "browser": {
      if (!query) return { error: "The browser app requires a URL. Provide one in the query parameter." };
      if (!/^https?:\/\//i.test(query)) {
        return { error: `Invalid URL: "${query}". URLs must start with http:// or https://` };
      }
      return { url: query, title: query.replace(/^https?:\/\//, "").split("/")[0] };
    }
    case "blog": {
      const base = gatewayHost ? `https://${gatewayHost}` : "";
      return { url: `${base}/blog/${query || ""}`, title: query ? `Blog: ${query}` : "Blog" };
    }
    case "jellyfin": {
      const jellyfinUrl = process.env.JELLYFIN_URL || "";
      if (!jellyfinUrl) return { error: "Jellyfin is not configured. Set JELLYFIN_URL in .env." };
      return { url: jellyfinUrl, title: "Jellyfin" };
    }
    case "plex": {
      const plexUrl = process.env.PLEX_URL || "";
      if (!plexUrl) return { error: "Plex is not configured. Set PLEX_URL in .env." };
      // Plex web UI is at /web on port 32400
      const base = plexUrl.replace(/\/$/, "");
      return { url: base.includes(":") ? `${base}/web` : `${base}:32400/web`, title: "Plex" };
    }
    case "romm": {
      const rommHost = gatewayHost ? gatewayHost.split(":")[0] : "";
      const rommPort = process.env.ROMM_PORT || "3080";
      return { url: rommHost ? `https://${rommHost}:${rommPort}/` : `http://localhost:${rommPort}/`, title: "RoMM" };
    }
    case "nest": {
      const base = gatewayHost ? `https://${gatewayHost}` : "";
      return { url: `${base}/dashboard/${query || "nest"}`, title: query ? `Nest: ${query}` : "Crow's Nest" };
    }
    case "videocall": {
      if (!query) return { error: "Video call requires room and token parameters. Use: open videocall room=CODE&token=TOKEN" };
      const base = gatewayHost ? `https://${gatewayHost}` : "";
      return { url: `${base}/calls?${query}`, title: "Video Call" };
    }
    default:
      return { error: `Unknown app "${app}". Available apps: ${VALID_APPS.join(", ")}` };
  }
}

export function createWmServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-wm", version: "1.0.0" },
    { instructions: options.instructions || "Crow Window Manager — open and close app windows in kiosk mode." },
  );

  // Resolve the gateway hostname for URL generation.
  // The MCP bridge sets CROW_GATEWAY_URL="" so fall back to .env file.
  let gatewayHost = process.env.CROW_GATEWAY_HOST || "";
  if (!gatewayHost) {
    const gwUrl = process.env.CROW_GATEWAY_URL || "";
    if (gwUrl) {
      try { gatewayHost = new URL(gwUrl).host; } catch {}
    }
  }
  if (!gatewayHost) {
    try {
      const serverDir = fileURLToPath(new URL(".", import.meta.url));
      const envPath = resolve(serverDir, "../../.env");
      if (existsSync(envPath)) {
        const match = readFileSync(envPath, "utf-8").match(/CROW_GATEWAY_URL=(.+)/);
        if (match) {
          try {
            const u = new URL(match[1].trim());
            gatewayHost = u.host;
            // .env URL has no port; Tailscale HTTPS proxy is :8444
            if (!u.port) gatewayHost += ":8444";
          } catch {}
        }
      }
    } catch {}
  }

  // --- crow_wm --- Single consolidated tool for all window management
  // A 4B model can't reliably choose between multiple similar tools across turns.
  // One tool with a simple "command" string is far more reliable.
  server.tool(
    "crow_wm",
    `Screen control. ALWAYS call this tool when the user wants to: open/play/watch/search something, close a window, pause, resume, mute, or unmute. NEVER describe what you would do — ALWAYS call this tool.\n\nCommands:\n- open youtube <query> — search and play a YouTube video\n- open browser <url> — open a web page\n- open blog <slug> — open a blog post\n- open jellyfin — open media library\n- open plex — open Plex media library\n- open nest <panel> — open dashboard panel\n- open videocall <room=CODE&token=TOKEN> — open a video call\n- open pet [anchor] — launch the Live2D pet mascot (Linux only; anchor: right, left, bottom-right, bottom-left)\n- close / close youtube / close pet / close all — close windows\n- pause — pause current media\n- resume — resume current media\n- mute / unmute — audio control\n- save workspace <name> — save current window layout\n- load workspace <name> — restore a saved layout\n- list workspaces — show saved layouts\n- search <query> — search the web and show results on screen\n- display <title> | <content> — show information on screen (use | to separate title from body text; use || for paragraph breaks)\n- invite <name> — invite a contact to join your room\n- memo <contact> <message> — send a voice memo to a contact\n- react <contact> <emoji> — send an emoji reaction to a contact`,
    {
      command: z.string().max(2000).describe("What to do, e.g.: open youtube relaxing music, pause, resume, close youtube, close all, display Search Results | Result 1: ... || Result 2: ..."),
    },
    async ({ command }) => {
      const cmd = command.trim().toLowerCase();

      // Parse command
      if (cmd === "pause") {
        return ok({ action: "media", command: "pause", app: "youtube", _hint: "To unpause later, you MUST call crow_wm with command: resume" });
      }
      if (cmd === "resume" || cmd === "unpause" || cmd === "play" || cmd === "continue") {
        return ok({ action: "media", command: "play", app: "youtube" });
      }
      if (cmd === "mute") {
        return ok({ action: "media", command: "mute", app: "youtube" });
      }
      if (cmd === "unmute") {
        return ok({ action: "media", command: "unmute", app: "youtube" });
      }
      if (cmd === "close all") {
        return ok({ action: "close_all" });
      }
      if (cmd === "close" || cmd === "close window") {
        return ok({ action: "close_focused" });
      }
      if (cmd.startsWith("close ")) {
        const appName = cmd.slice(6).trim();
        if (appName === "pet") {
          const r = closePet();
          if (!r.ok) return err(r.error);
          return ok({ action: "pet_closed", pid: r.pid });
        }
        if (VALID_APPS.includes(appName)) return ok({ action: "close", app: appName });
        return ok({ action: "close_focused" });
      }
      if (cmd.startsWith("open ")) {
        const rest = cmd.slice(5).trim();
        // Pet mode (Phase 3.1): spawn the Live2D AppImage alongside Blockly.
        // Linux-only; gracefully errors on other platforms.
        if (rest === "pet" || rest.startsWith("pet ")) {
          const anchor = rest === "pet" ? null : rest.slice(4).trim();
          if (anchor && !PET_VALID_ANCHORS.includes(anchor)) {
            return err(`Invalid pet anchor "${anchor}". Valid: ${PET_VALID_ANCHORS.join(", ")}`);
          }
          const r = await launchPet(anchor);
          if (r.error) return err(r.error);
          return ok({ action: r.reanchored ? "pet_reanchored" : "pet_launched", pid: r.pid, anchor: r.anchor });
        }
        // Parse "open <app> <query>"
        for (const app of VALID_APPS) {
          if (rest === app || rest.startsWith(app + " ")) {
            const query = rest.slice(app.length).trim() || undefined;
            const result = await resolveUrl(app, query, gatewayHost);
            if (result.error) return err(result.error);
            return ok({ action: "open", app, url: result.url, title: result.title });
          }
        }
        // Default to browser if no app matched
        const result = await resolveUrl("browser", rest, gatewayHost);
        if (result.error) return err(result.error);
        return ok({ action: "open", app: "browser", url: result.url, title: result.title });
      }
      // App launcher
      if (cmd === "launcher" || cmd === "apps" || cmd === "open launcher" || cmd === "show apps") {
        return ok({ action: "show_launcher" });
      }

      // Workspace save/load
      if (cmd.startsWith("save workspace") || cmd.startsWith("save layout")) {
        const name = cmd.replace(/^save (workspace|layout)\s*/, "").trim() || "default";
        return ok({ action: "save_workspace", name });
      }
      if (cmd.startsWith("load workspace") || cmd.startsWith("load layout") || cmd.startsWith("restore workspace")) {
        const name = cmd.replace(/^(load|restore) (workspace|layout)\s*/, "").trim() || "default";
        return ok({ action: "load_workspace", name });
      }
      if (cmd === "list workspaces" || cmd === "list layouts") {
        return ok({ action: "list_workspaces" });
      }

      // Room invite
      if (cmd.startsWith("invite ")) {
        const contactName = command.trim().slice(7).trim(); // preserve original case
        if (!contactName) return err("Please specify who to invite. Example: invite Alice");
        const sendInvite = await getSendRoomInvite();
        if (!sendInvite) return err("Room invites are not available. The sharing server is not loaded.");
        const result = await sendInvite(contactName);
        if (!result.ok) return err(result.message);
        return ok({ action: "notification", message: result.message });
      }

      // Voice memo
      if (cmd.startsWith("memo ") || cmd.startsWith("voice memo ")) {
        const rest = command.trim().replace(/^(voice memo|memo)\s+/i, "").trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx < 1) return err("Usage: memo <contact> <message>");
        const contact = rest.slice(0, spaceIdx).trim();
        const message = rest.slice(spaceIdx + 1).trim();
        if (!message) return err("Please include a message. Example: memo Alice Hey, how are you?");
        const fn = await getSendVoiceMemo();
        if (!fn) return err("Voice memos are not available. The sharing server is not loaded.");
        const result = await fn(contact, message);
        if (!result.ok) return err(result.message);
        return ok({ action: "notification", message: result.message });
      }

      // Reaction
      if (cmd.startsWith("react ")) {
        const rest = command.trim().slice(6).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx < 1) return err("Usage: react <contact> <emoji>");
        const contact = rest.slice(0, spaceIdx).trim();
        const emoji = rest.slice(spaceIdx + 1).trim();
        const fn = await getSendReaction();
        if (!fn) return err("Reactions are not available. The sharing server is not loaded.");
        const result = await fn(contact, emoji);
        if (!result.ok) return err(result.message);
        return ok({ action: "notification", message: result.message });
      }

      // Bot relay
      if (cmd.startsWith("relay ") || cmd.startsWith("ask ") && cmd.includes(" to ")) {
        let instanceName, task;
        if (cmd.startsWith("relay ")) {
          const rest = command.trim().slice(6).trim();
          const spaceIdx = rest.indexOf(" ");
          if (spaceIdx < 1) return err("Usage: relay <instance> <task>");
          instanceName = rest.slice(0, spaceIdx).trim();
          task = rest.slice(spaceIdx + 1).trim();
        } else {
          // "ask colibri to turn on the lights"
          const match = command.trim().match(/^ask\s+(\S+)\s+to\s+(.+)$/i);
          if (!match) return err("Usage: ask <instance> to <task>");
          instanceName = match[1];
          task = match[2];
        }
        if (!task) return err("Please include a task. Example: relay colibri turn on the lights");
        const fn = await getSendBotRelay();
        if (!fn) return err("Bot relay is not available. The sharing server is not loaded.");
        const result = await fn(instanceName, task);
        if (!result.ok) return err(result.message);
        return ok({ action: "notification", message: `Relaying to ${instanceName}: ${task}` });
      }

      // Web search
      if (cmd.startsWith("search ") || cmd.startsWith("search for ") || cmd.startsWith("look up ") || cmd.startsWith("find articles ") || cmd.startsWith("find info ")) {
        const searchQuery = command.trim().replace(/^(search for|search|look up|find articles about|find articles|find info about|find info)\s+/i, "").trim();
        if (!searchQuery) return err("Please specify what to search for.");
        const result = await searchWeb(searchQuery);
        if (result.error) return err(result.error);
        return ok({ action: "open", app: "content", title: result.title, richContent: result.blocks });
      }

      // Display rich content
      if (cmd.startsWith("display ") || cmd.startsWith("show results ") || cmd.startsWith("show info ")) {
        // Use original command (not lowercased) to preserve content
        const orig = command.trim();
        const prefixLen = orig.toLowerCase().startsWith("display ") ? 8
          : orig.toLowerCase().startsWith("show results ") ? 13
          : orig.toLowerCase().startsWith("show info ") ? 10 : 8;
        const body = orig.slice(prefixLen).trim();
        // Parse "title | content" format; || = paragraph break
        const pipeIdx = body.indexOf(" | ");
        let title, contentStr;
        if (pipeIdx > 0) {
          title = body.slice(0, pipeIdx).trim();
          contentStr = body.slice(pipeIdx + 3).trim();
        } else {
          title = "Info";
          contentStr = body;
        }
        // Build rich content blocks from text
        const blocks = [{ type: "heading", text: title }];
        const paragraphs = contentStr.split("||").map(p => p.trim()).filter(Boolean);
        for (const para of paragraphs) {
          // Lines starting with "- " become list items
          const lines = para.split("\n").map(l => l.trim()).filter(Boolean);
          const listItems = lines.filter(l => l.startsWith("- "));
          if (listItems.length > 0 && listItems.length === lines.length) {
            blocks.push({ type: "list", items: listItems.map(l => l.slice(2)) });
          } else {
            blocks.push({ type: "text", text: para.replace(/\|\|/g, "\n") });
          }
        }
        return ok({ action: "open", app: "content", title, richContent: blocks });
      }

      // Fallback: try to interpret as "open youtube <query>"
      if (cmd.includes("youtube") || cmd.includes("video")) {
        const query = cmd.replace(/youtube|video|play|watch|on/gi, "").trim();
        if (!query) return ok({ action: "media", command: "play", app: "youtube" });
        const result = await resolveUrl("youtube", query, gatewayHost);
        if (result.error) return err(result.error);
        return ok({ action: "open", app: "youtube", url: result.url, title: result.title });
      }

      return err(`Unknown command: "${command}". Try: open youtube <query>, pause, resume, close`);
    },
  );

  function ok(payload) {
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }
  function err(message) {
    return { content: [{ type: "text", text: JSON.stringify({ action: "error", message }) }], isError: true };
  }

  return server;
}
