/**
 * Kiosk panel routes (gateway process). Installed as a COPY at
 * ~/.crow/panels/kiosk-routes.js, so everything is resolved by path: the kiosk
 * bundle dir (installed copy first) and the app root (CROW_APP_ROOT).
 * Builds the runtime once (top-level await) and mints the announce token.
 */
import express, { Router } from "express";
import { WebSocketServer } from "ws";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const isBundle = (p) => !!p && existsSync(join(p, "manifest.json")) && existsSync(join(p, "server", "runtime.js"));
const BUNDLE_DIR = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "kiosk"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "kiosk") : null,
  resolve(here, ".."),
].filter(Boolean).find(isBundle);
if (!BUNDLE_DIR) throw new Error("kiosk: bundle directory not found");
const bImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);

const { APP_ROOT, appImport } = await bImport("server/app-root.js");
const { createDbClient, resolveDataDir } = await appImport("servers/db.js");
// sessionFromRequest / verifySession / csrfTokenAccepted are the gateway's own dashboard-session
// checks; the runtime turns session mode (the dashboard's Talk to Crow) off when any is missing.
const { isAllowedNetwork, sessionFromRequest, verifySession } = await appImport("servers/gateway/dashboard/auth.js");
const { csrfMiddleware, csrfTokenAccepted } = await appImport("servers/gateway/dashboard/shared/csrf.js");
const deviceStore = await appImport("servers/shared/device-store.js");
const { createVoiceTurnRunner, defaultVoiceDeps } = await appImport("servers/gateway/voice/turn.js");
const { wrapPcmAsWav } = await appImport("servers/gateway/voice/turn-helpers.js");
const { readSetting, writeSetting } = await appImport("servers/gateway/dashboard/settings/registry.js");
const { ensureKioskAnnounceToken, validateKioskAnnounceToken } = await appImport("servers/gateway/local-token.js");
const { PERCH_TOKENS } = await appImport("servers/gateway/dashboard/shared/design-tokens.js");
const { readPortrait } = await appImport("servers/sharing/profile-avatar.js");
const { createKioskRuntime, createSttWarmup, kioskThemeCss } = await bImport("server/runtime.js");
const { resolveDisplayBird } = await bImport("server/bird.js");

/** An installed add-on's environment, read at the moment it is needed (a token change applies without a restart). Never logged. */
const ADDONS_FILE = join(process.env.CROW_HOME || join(homedir(), ".crow"), "mcp-addons.json");
function addonEnv(id) {
  try { const env = JSON.parse(readFileSync(ADDONS_FILE, "utf8"))?.[id]?.env; return env && typeof env === "object" ? env : null; } catch { return null; }
}

const vdeps = await defaultVoiceDeps();
const voice = createVoiceTurnRunner(vdeps);
// R13: at most one warm-up transcription per STT profile per 10 min (throttle lives in runtime.js).
const sttWarmup = createSttWarmup({
  openDb: () => createDbClient(),
  getSttProfile: vdeps.getSttProfile,
  createSttAdapter: vdeps.createSttAdapter,
  wrapPcmAsWav,
});

const runtime = createKioskRuntime({
  Router, json: express.json, WebSocketServer,
  isAllowedNetwork, csrfMiddleware,
  sessionFromRequest, verifySession, csrfTokenAccepted,
  openDb: () => createDbClient(),
  deviceStore, voice, sttWarmup, wrapPcmAsWav,
  settings: { readSetting, writeSetting },
  resolveDisplayBird: (db) => resolveDisplayBird(db, { readPortrait }),
  themeCss: () => kioskThemeCss(PERCH_TOKENS),
  files: { publicDir: join(BUNDLE_DIR, "public"), birdSvgPath: join(APP_ROOT, "bundles", "ramble", "server", "bird-svg.cjs") },
  announceToken: { validate: validateKioskAnnounceToken },
  addonEnv, dataDir: resolveDataDir(),
});

{
  const db = createDbClient();
  ensureKioskAnnounceToken(db)
    .then((r) => { if (r.minted) console.log("[kiosk] announce token minted"); })
    .catch((err) => console.warn(`[kiosk] announce token mint failed: ${err.message}`))
    .finally(() => { try { db.close(); } catch {} });
}

// Smoke 2026-10-04: the first inference after a whisper start took 8.2 s even with the
// model preloaded, so warm every paired display's STT now (retried until whisper answers).
runtime.bootWarmup().catch(() => {});
runtime.migrateVolumeCaps().catch(() => {});   // rev 7b (M2): old linear caps → the 5 dB scale, once

export default function kioskRouter(dashboardAuth) { return runtime.router(dashboardAuth); }
export function setupWebSocket(server) { return runtime.attachUpgrade(server); }
