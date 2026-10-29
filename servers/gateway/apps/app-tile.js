/**
 * The embedded app tile (R1.2 PR 5): any VNC-backed ("desktop") app shown in
 * a Perch session, generalised from the live browser tile.
 *
 * A desktop app is a catalog app whose manifest declares
 * `desktop: { path, lease? }`. Its tile is a watch-only noVNC view; Take over
 * is offered only when the manifest declares the lease AND the bundle's own
 * server has reported that it enforces it (leaseEnforced): a declared lease
 * nobody enforces would hand the operator a "you have it" that bots ignore.
 *
 * The browser keeps its own tile (the CDP screencast, its allowlist and its
 * shots stay browser-only); this module only answers "what is this app's
 * tile" and "may it be taken over".
 */
import { join } from "node:path";
import { listApps } from "./catalog.js";
import { getManifest } from "../routes/extension-proxy.js";
import { leaseDir, readEnforced, APP_ID_RE } from "../../shared/browser-lease.js";
import { defaultCrowHome } from "./launcher.js";

export { APP_ID_RE };

/**
 * A desktop path: relative, plain segments, no "..", and its last segment a
 * noVNC page (vnc.html or vnc_lite.html), so a desktop app's tile can only
 * ever frame a VNC viewer, never another page of the app.
 */
const PATH_RE = /^(?:[A-Za-z0-9._~-]+\/)*vnc(?:_lite)?\.html$/;

function cleanPath(p) {
  const s = String(p == null ? "" : p).replace(/^\/+/, "");
  if (!s || s.length > 200 || !PATH_RE.test(s)) return null;
  if (s.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return s;
}

/**
 * The bundles whose own server is KNOWN (reviewed gateway code, not a file a
 * bot can write) to enforce the lease, with the first bundle version whose
 * lease guard did. enforced.json alone is not enough: its directory is
 * bot-writable, so a forged marker could otherwise make the UI say the
 * operator holds an app the bot still drives. Adding an app here is a code
 * review decision.
 */
export const LEASE_ENFORCERS = Object.freeze({ browser: "1.3.9" });

/** a >= b for dotted numeric versions ("1.3.11" >= "1.3.9"); anything else is false. */
export function versionAtLeast(a, b) {
  const re = /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/;
  if (typeof a !== "string" || typeof b !== "string" || !re.test(a) || !re.test(b)) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

/** This instance's lease directory for an app (throws on a bad id). */
export function appLeaseDir(appId, { crowHome = defaultCrowHome() } = {}) {
  return leaseDir((name) => join(crowHome, name), appId);
}

/** The catalog entry of an installed desktop app with a usable path, or null. */
export function desktopApp(appId, { crowHome = defaultCrowHome() } = {}) {
  if (typeof appId !== "string" || !APP_ID_RE.test(appId)) return null;
  let apps;
  try { apps = listApps({ crowHome }); } catch { return null; }
  const a = apps.find((x) => x.id === appId);
  if (!a || a.kind !== "desktop" || !cleanPath(a.desktopPath)) return null;
  return a;
}

/**
 * True only when the app's lease directory holds an enforced.json that parses
 * and whose bundleVersion equals the installed manifest's version. A bundle
 * upgraded since its server last started reads false until it restarts.
 */
export function leaseEnforced(appId, { crowHome = defaultCrowHome() } = {}) {
  let dir;
  try { dir = appLeaseDir(appId, { crowHome }); } catch { return false; }
  const rec = readEnforced(dir);
  if (!rec) return false;
  const m = getManifest(appId, crowHome);
  return !!m && typeof m.version === "string" && m.version === rec.bundleVersion;
}

/**
 * Take over is offered: the manifest declares the lease, the app is a known
 * enforcer at or past its first enforcing version, and its server reported
 * enforcing it for the installed version.
 */
export function takeOverOffered(app, { crowHome = defaultCrowHome() } = {}) {
  if (!app || app.leaseDeclared !== true) return false;
  if (!Object.prototype.hasOwnProperty.call(LEASE_ENFORCERS, app.id)) return false;
  const m = getManifest(app.id, crowHome);
  if (!m || !versionAtLeast(m.version, LEASE_ENFORCERS[app.id])) return false;
  return leaseEnforced(app.id, { crowHome });
}

/** The noVNC page of a desktop app, without a query. */
export function desktopBase(app) {
  const p = cleanPath(app && app.desktopPath);
  return p ? "/proxy/" + app.id + "/" + p : null;
}

/**
 * What the session's tile shows: { id, label, src, takeOver }, or null for an
 * app that is not an installed desktop app. src is the watch-only view.
 */
export function appTileInfo(appId, { crowHome = defaultCrowHome() } = {}) {
  const app = desktopApp(appId, { crowHome });
  if (!app) return null;
  return {
    id: app.id,
    label: String(app.label),
    src: desktopBase(app) + "?view_only=true&autoconnect=true&resize=scale",
    takeOver: takeOverOffered(app, { crowHome }),
  };
}
