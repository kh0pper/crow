/**
 * MOVED to core: servers/shared/device-store.js (kiosk K1, spec 2026-10-03 §4.1).
 * This shim keeps the old path working from the repo AND from an installed copy
 * (~/.crow/bundles/meta-glasses/server/), which cannot reach core by a relative
 * path. Resolution: CROW_APP_ROOT → repo-relative → ~/crow (ramble app-root.js
 * pattern). Kept until the glasses loop moves to servers/gateway/voice/turn.js.
 */
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REL = join("servers", "shared", "device-store.js");
const target = [
  process.env.CROW_APP_ROOT,
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  join(homedir(), "crow"),
].filter(Boolean).map((root) => join(root, REL)).find((p) => existsSync(p));
if (!target) throw new Error("meta-glasses device-store shim: cannot locate servers/shared/device-store.js (set CROW_APP_ROOT)");
const core = await import(pathToFileURL(target).href);

export const {
  listDevices, findDevice, pairDevice, unpairDevice, verifyToken, updateDeviceProfiles,
  tokenHash, normalizeKioskSettings, unbindBotFromOtherDevices, KIOSK_DEFAULTS, DEVICE_KINDS, LAST_SEEN_WRITE_MS,
} = core;
