/**
 * Kiosk panel routes (gateway process). Installed as a COPY at
 * ~/.crow/panels/kiosk-routes.js, so everything is resolved by path: the kiosk
 * bundle dir (installed copy first) and the app root (CROW_APP_ROOT).
 * Builds the runtime once (top-level await) and mints the announce token.
 */
import express, { Router } from "express";
import { WebSocketServer } from "ws";
import { existsSync } from "node:fs";
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
const { createDbClient } = await appImport("servers/db.js");
const { isAllowedNetwork } = await appImport("servers/gateway/dashboard/auth.js");
const { csrfMiddleware } = await appImport("servers/gateway/dashboard/shared/csrf.js");
const deviceStore = await appImport("servers/shared/device-store.js");
const { createVoiceTurnRunner, defaultVoiceDeps } = await appImport("servers/gateway/voice/turn.js");
const { wrapPcmAsWav } = await appImport("servers/gateway/voice/turn-helpers.js");
const { readSetting, writeSetting } = await appImport("servers/gateway/dashboard/settings/registry.js");
const { ensureKioskAnnounceToken, validateKioskAnnounceToken } = await appImport("servers/gateway/local-token.js");
const { PERCH_TOKENS } = await appImport("servers/gateway/dashboard/shared/design-tokens.js");
const { readPortrait } = await appImport("servers/sharing/profile-avatar.js");
const { createKioskRuntime, createSttWarmup, kioskThemeCss } = await bImport("server/runtime.js");
const { resolveDisplayBird } = await bImport("server/bird.js");

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
  openDb: () => createDbClient(),
  deviceStore, voice, sttWarmup, wrapPcmAsWav,
  settings: { readSetting, writeSetting },
  resolveDisplayBird: (db) => resolveDisplayBird(db, { readPortrait }),
  themeCss: () => kioskThemeCss(PERCH_TOKENS),
  files: { publicDir: join(BUNDLE_DIR, "public"), birdSvgPath: join(APP_ROOT, "bundles", "ramble", "server", "bird-svg.cjs") },
  announceToken: { validate: validateKioskAnnounceToken },
});

{
  const db = createDbClient();
  ensureKioskAnnounceToken(db)
    .then((r) => { if (r.minted) console.log("[kiosk] announce token minted"); })
    .catch((err) => console.warn(`[kiosk] announce token mint failed: ${err.message}`))
    .finally(() => { try { db.close(); } catch {} });
}

export default function kioskRouter(dashboardAuth) { return runtime.router(dashboardAuth); }
export function setupWebSocket(server) { return runtime.attachUpgrade(server); }
