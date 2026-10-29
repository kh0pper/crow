/**
 * Satellite-hosted bundles, crow's own records (SAT-5, spec §8):
 *
 *   installed.json[id] = {id, mode:"satellite", host:<satellite_id>, version, installed_at}
 *   mcp-addons.json[id] = {transport:"satellite", satellite_id, bundle:id}   (mode 600)
 *   skills: synced from crow's OWN checkout (bundle-skill-sync.js), removed on uninstall/unpair.
 *
 * One host per bundle id, both ways: a bundle is either local or on exactly one satellite. The
 * local install path already refuses an id present in installed.json (validateInstall); the
 * satellite path refuses an id that is in installed.json, in mcp-addons.json or in the local
 * bundles dir. Boot repair skips satellite entries (routes/bundles.js), so nothing is ever
 * copied into ~/.crow/bundles for them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { readInstalled, writeInstalled } from "../bundle-core.js";
import { writePrivateFile } from "../bundle-env-secrets.js";
import { syncBundleSkills, removeBundleSkills, readSkillLedger, skillSyncMode } from "../bundle-skill-sync.js";

export const SATELLITE_MODE = "satellite";
export const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const isSatelliteEntry = (rec) => !!rec && typeof rec === "object" && rec.mode === SATELLITE_MODE;

/** The files this module touches, for one Crow home (tests pass a scratch one). */
export function installPaths(crowHome = resolveCrowHome()) {
  return {
    crowHome,
    installed: join(crowHome, "installed.json"),
    addons: join(crowHome, "mcp-addons.json"),
    bundlesDir: join(crowHome, "bundles"),
    skillsDir: join(crowHome, "skills"),
    recordPath: join(crowHome, "skill-installs.json"),
  };
}

function readAddons(path) {
  if (!existsSync(path)) return {};
  const j = JSON.parse(readFileSync(path, "utf8")); // unreadable → throw: never rewrite it from {}
  return j && typeof j === "object" && !Array.isArray(j) ? j : {};
}

/**
 * Where `id` lives: {where:"local"} | {where:"satellite", host} | {where:null}.
 * Local = an installed.json entry that is not a satellite entry, an mcp-addons entry that is not
 * a satellite entry, or a local bundles/<id> folder.
 */
export function bundleHost(id, paths = installPaths()) {
  const rec = readInstalled(paths.installed).find((r) => r?.id === id);
  if (rec) return isSatelliteEntry(rec) ? { where: "satellite", host: rec.host } : { where: "local" };
  let addons = {};
  try { addons = readAddons(paths.addons); } catch { return { where: "local" }; } // unknown: fail closed
  const a = addons[id];
  if (a) return a.transport === SATELLITE_MODE ? { where: "satellite", host: a.satellite_id } : { where: "local" };
  if (existsSync(join(paths.bundlesDir, id))) return { where: "local" };
  return { where: null };
}

/** The satellite entries in installed.json (optionally for one satellite). */
export function satelliteInstalls(paths = installPaths(), satelliteId = null) {
  return readInstalled(paths.installed).filter((r) => isSatelliteEntry(r) && (!satelliteId || r.host === satelliteId));
}

function readManifest(appBundles, id) {
  try { return JSON.parse(readFileSync(join(appBundles, id, "manifest.json"), "utf8")); } catch { return null; }
}

/**
 * Record a finished satellite install. Idempotent (a second call for the same satellite only
 * refreshes the version). Refuses (returns {ok:false, code}) when the id is local or on another
 * satellite. Skills are synced from crow's checkout; a skill failure never undoes the record.
 */
export function recordSatelliteInstall({ id, satelliteId, version = null, appBundles, paths = installPaths(), now = Date.now, skillMode = skillSyncMode(), log = () => {} }) {
  if (!BUNDLE_ID_RE.test(String(id))) return { ok: false, code: "bad_bundle_id" };
  const host = bundleHost(id, paths);
  if (host.where === "local") return { ok: false, code: "installed_locally" };
  if (host.where === "satellite" && host.host !== satelliteId) return { ok: false, code: "installed_on_other_server" };

  const list = readInstalled(paths.installed).filter((r) => r?.id !== id);
  const prev = readInstalled(paths.installed).find((r) => r?.id === id);
  list.push({
    id, mode: SATELLITE_MODE, host: satelliteId, version: version == null ? null : String(version),
    installed_at: prev?.installed_at || new Date(now()).toISOString(),
  });
  writeInstalled(paths.installed, list);

  const addons = readAddons(paths.addons);
  addons[id] = { transport: SATELLITE_MODE, satellite_id: satelliteId, bundle: id };
  writePrivateFile(paths.addons, JSON.stringify(addons, null, 2));

  let skills = [];
  const manifest = readManifest(appBundles, id);
  if (manifest) {
    try {
      const out = syncBundleSkills({
        id, src: join(appBundles, id), manifest, mode: skillMode, install: !prev,
        skillsDir: paths.skillsDir, recordPath: paths.recordPath, ledger: readSkillLedger(appBundles), log,
      });
      skills = out.lines.filter((l) => l.action === "install" || l.action === "refresh" || l.action === "adopt").map((l) => l.skill);
    } catch (err) {
      log(`[satellites] skills for ${id}: ${err.message}`);
    }
  }
  return { ok: true, skills };
}

/** Remove crow's records of one satellite bundle (only when that satellite hosts it). */
export function removeSatelliteInstall({ id, satelliteId, appBundles, paths = installPaths(), log = () => {} }) {
  const rec = readInstalled(paths.installed).find((r) => r?.id === id);
  if (rec && !(isSatelliteEntry(rec) && rec.host === satelliteId)) return { ok: false, code: "not_on_this_server" };
  if (rec) writeInstalled(paths.installed, readInstalled(paths.installed).filter((r) => r?.id !== id));
  let addons = null;
  try { addons = readAddons(paths.addons); } catch (err) { log(`[satellites] mcp-addons unreadable: ${err.message}`); }
  if (addons && addons[id]?.transport === SATELLITE_MODE && addons[id].satellite_id === satelliteId) {
    delete addons[id];
    writePrivateFile(paths.addons, JSON.stringify(addons, null, 2));
  }
  const removed = [];
  const manifest = readManifest(appBundles, id);
  if (manifest) {
    try {
      const out = removeBundleSkills({
        id, manifest, src: join(appBundles, id), skillsDir: paths.skillsDir, recordPath: paths.recordPath,
        ledger: readSkillLedger(appBundles), log,
      });
      removed.push(...out.removed);
    } catch (err) {
      log(`[satellites] skills for ${id}: ${err.message}`);
    }
  }
  return { ok: true, skills_removed: removed };
}

/** Unpair: every record of this satellite goes (installed.json, mcp-addons.json, skills). */
export function removeAllForSatellite({ satelliteId, appBundles, paths = installPaths(), log = () => {} }) {
  const ids = new Set(satelliteInstalls(paths, satelliteId).map((r) => r.id));
  try {
    for (const [id, a] of Object.entries(readAddons(paths.addons))) {
      if (a?.transport === SATELLITE_MODE && a.satellite_id === satelliteId) ids.add(id);
    }
  } catch { /* the installed.json ids still go */ }
  for (const id of ids) removeSatelliteInstall({ id, satelliteId, appBundles, paths, log });
  return [...ids];
}
