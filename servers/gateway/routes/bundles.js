/**
 * Add-on API Routes — Install, uninstall, start, stop, status
 *
 * Supports all add-on types:
 *   - bundle:     Docker Compose services (pull images, start/stop containers)
 *   - mcp-server: External MCP servers (register in ~/.crow/mcp-addons.json)
 *   - skill:      Markdown skill files (copy to ~/.crow/skills/)
 *   - panel:      Dashboard panels (copy to ~/.crow/panels/, register in panels.json)
 *
 * POST /bundles/api/install   — Install an add-on
 * POST /bundles/api/uninstall — Remove an add-on
 * POST /bundles/api/start     — Start bundle containers (Docker only)
 * POST /bundles/api/stop      — Stop bundle containers (Docker only)
 * GET  /bundles/api/status    — Get status of all installed add-ons
 * POST /bundles/api/env       — Save env vars for an add-on
 * GET  /bundles/api/jobs/:id  — Poll install job progress
 */

import { Router } from "express";
import { createNotification } from "../../shared/notifications.js";
import bus from "../../shared/event-bus.js";
import { isSupervised } from "../../shared/supervisor.js";
import { createDbClient } from "../../db.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, copyFileSync, unlinkSync, symlinkSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { checkInstall as checkHardwareGate } from "../hardware-gate.js";
import { checkGpuArchCompatible } from "../gpu-arch.js";
import { forwardBundleAction } from "../../shared/peer-forward.js";
import { auditCrossHostCall, crossHostVerifyMiddleware } from "../../shared/cross-host-auth.js";
import { getOrCreateLocalInstanceId, getInstance } from "../instance-registry.js";
import {
  registerProviderFromManifest,
  unregisterProvidersByBundle,
} from "../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../shared/providers.js";
import { writeSetting } from "../dashboard/settings/registry.js";
import { getCollection } from "../dashboard/panels/extensions/collections.js";
import { beginInstallSet, endInstallSet, isInstallSetRunning } from "../install-lock.js";

/**
 * Seed an STT/TTS profile from a bundle manifest's {stt,tts}ProfileSeed into the
 * dashboard_settings `{stt,tts}_profiles` array, via the settings sync layer.
 *
 * Idempotent: skips when a profile with the same provider+baseUrl already exists.
 * Does NOT force isDefault (only the first profile of an empty list becomes the
 * default, matching the settings-page add handler).
 *
 * @param {object} db         libsql client
 * @param {"stt"|"tts"} kind
 * @param {object} seed       manifest.{stt,tts}ProfileSeed
 * @param {(msg:string)=>void} log
 */
async function seedProfile(db, kind, seed, log) {
  if (!seed || !seed.provider) return;
  const key = `${kind}_profiles`;
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [key],
  });
  let profiles = [];
  try { profiles = JSON.parse(rows[0]?.value || "[]"); } catch {}
  const baseUrl = (seed.baseUrl || "").trim();
  if (profiles.some((p) => p.provider === seed.provider && (p.baseUrl || "").trim() === baseUrl)) {
    log(`${kind.toUpperCase()} profile already present (${seed.provider} ${baseUrl}); skipping seed`);
    return;
  }
  const profile = {
    id: randomBytes(4).toString("hex"),
    name: seed.name || `${seed.provider} (local)`,
    provider: seed.provider,
    apiKey: seed.apiKey || "",
    baseUrl,
    isDefault: profiles.length === 0,
  };
  if (kind === "tts") profile.defaultVoice = seed.defaultVoice || "";
  else profile.defaultModel = seed.defaultModel || "";
  if (seed.language !== undefined) profile.language = seed.language;
  profiles.push(profile);
  await writeSetting(db, key, JSON.stringify(profiles));
  log(`Seeded ${kind.toUpperCase()} profile: ${profile.name} (${seed.provider} ${baseUrl})`);
}

/**
 * Reverse seedProfile on uninstall: remove the profile(s) this bundle's manifest
 * seeded (matched by provider+baseUrl). Keeps a default if any remain.
 */
async function unseedProfile(db, kind, seed, log) {
  if (!seed || !seed.provider) return;
  const key = `${kind}_profiles`;
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [key],
  });
  let profiles = [];
  try { profiles = JSON.parse(rows[0]?.value || "[]"); } catch {}
  const baseUrl = (seed.baseUrl || "").trim();
  const before = profiles.length;
  profiles = profiles.filter((p) => !(p.provider === seed.provider && (p.baseUrl || "").trim() === baseUrl));
  if (profiles.length === before) return;
  if (profiles.length && !profiles.some((p) => p.isDefault)) profiles[0].isDefault = true;
  await writeSetting(db, key, JSON.stringify(profiles));
  log(`Removed ${before - profiles.length} ${kind.toUpperCase()} profile(s) seeded by bundle`);
}

// PR 0: Consent token configuration (server-validated, race-safe install consent)
const CONSENT_TOKEN_TTL_SECONDS = 15 * 60; // 15 min — covers slow image pulls
const CONSENT_TOKEN_SCHEMA_VERSION = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Respect the instance's CROW_HOME (matches proxy.js resolveCrowHome). Without
// this, installs on an alternate instance (CROW_HOME=~/.crow-mpa, ~/.crow-finance)
// wrote bundle files + mcp-addons.json into the MAIN ~/.crow, re-coupling the
// instances. Falls back to ~/.crow when unset (the main instance).
const CROW_HOME = process.env.CROW_HOME || join(homedir(), ".crow");
const BUNDLES_DIR = join(CROW_HOME, "bundles");
const SKILLS_DIR = join(CROW_HOME, "skills");
const PANELS_DIR = join(CROW_HOME, "panels");
const MCP_ADDONS_PATH = join(CROW_HOME, "mcp-addons.json");
const PANELS_CONFIG_PATH = join(CROW_HOME, "panels.json");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");
const APP_ROOT = resolve(__dirname, "../../..");
const APP_BUNDLES = join(APP_ROOT, "bundles");
const APP_ENV_PATH = join(APP_ROOT, ".env");

// -----------------------------------------------------------------------
// Cross-host manifest support (Phase 5-MVP)
// -----------------------------------------------------------------------

const BUNDLE_HOST_ALLOW_PATH = join(CROW_HOME, "bundle-host-allow.json");

/**
 * Read the host-allowlist (~/.crow/bundle-host-allow.json) — an array of
 * bundle IDs that may carry a cross-host `host:` field.
 * Returns a Set.
 */
function readBundleHostAllowlist() {
  try {
    if (existsSync(BUNDLE_HOST_ALLOW_PATH)) {
      const arr = JSON.parse(readFileSync(BUNDLE_HOST_ALLOW_PATH, "utf-8"));
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set();
}

/**
 * Read a bundle's manifest.json and return its `host` field if present and
 * the manifest is trusted enough to carry a non-local host directive.
 *
 * Trust sources (any one suffices):
 *   1. Bundle ID appears in registry/add-ons.json (installed via official registry).
 *   2. Bundle ID appears in ~/.crow/bundle-host-allow.json.
 *   3. Env CROW_BUNDLE_HOST_ALLOW_ALL=1 (dev mode).
 *
 * Returns: { host: <instance-id | 'local' | null>, trusted: boolean,
 *            reason: string if untrusted }
 */
function resolveManifestHost(bundleId) {
  // Look for the manifest in installed location first, then app repo
  const candidates = [
    join(BUNDLES_DIR, bundleId, "manifest.json"),
    join(APP_BUNDLES, bundleId, "manifest.json"),
  ];
  let manifest = null;
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        manifest = JSON.parse(readFileSync(p, "utf-8"));
        break;
      }
    } catch {}
  }
  if (!manifest) return { host: null, trusted: false, reason: "no_manifest" };

  const host = manifest.host || null;
  if (!host || host === "local") return { host: host || "local", trusted: true };

  // Non-local host — enforce trust boundary
  if (process.env.CROW_BUNDLE_HOST_ALLOW_ALL === "1") {
    return { host, trusted: true, reason: "dev_allow_all" };
  }

  // Check registry
  try {
    const registryPath = join(APP_ROOT, "registry", "add-ons.json");
    if (existsSync(registryPath)) {
      const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
      const known = (reg["add-ons"] || []).some((a) => a.id === bundleId);
      if (known) return { host, trusted: true, reason: "registry" };
    }
  } catch {}

  // Check local allowlist
  const allow = readBundleHostAllowlist();
  if (allow.has(bundleId)) return { host, trusted: true, reason: "allowlist" };

  return { host, trusted: false, reason: "untrusted_manifest_host" };
}

function resolvePanelPath(manifest, bundleId) {
  if (!manifest?.panel) return null;
  if (typeof manifest.panel === "string") return manifest.panel;
  const panelId = manifest.panel.id || bundleId;
  return `panel/${panelId}.js`;
}

// In-memory job tracking (simple — no DB table needed for MVP)
const jobs = new Map();
let jobCounter = 0;

function createJob(bundleId, action) {
  const id = String(++jobCounter);
  const job = {
    id,
    bundleId,
    action,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);
  // NOTE: eviction is armed in finishJob(), NOT here. A collection install can
  // run for tens of minutes (multi-GB image pulls); a creation-time timer would
  // delete the job mid-flight, the client's poll would 404, and its catch-path
  // would mistake that for a gateway restart (spurious reload + lost summary).
  return job;
}

function appendLog(job, line) {
  job.log.push(line);
  emitJobChanged(job);
}

const JOB_TTL_MS = 600_000;

function finishJob(job, status) {
  job.status = status;
  job.completedAt = new Date().toISOString();
  // Evict N minutes after the job ENDS — never while it runs.
  const timer = setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  // Non-enumerable: GET /bundles/api/jobs/:id does res.json(job); an enumerable
  // Timeout (circular _idlePrev/_idleNext) would make JSON.stringify throw.
  Object.defineProperty(job, "_evictTimer", { value: timer, configurable: true, writable: true });
  emitJobChanged(job);
}

/** Test-only seams (jobs are in-process; tests need to create/inspect/finish one). */
export function _createJobForTest(bundleId, action) { return createJob(bundleId, action); }
export function _getJobForTest(id) { return jobs.get(id); }
export function _finishJobForTest(job, status) { return finishJob(job, status); }

// Broadcasts the job's new state to any live Turbo Stream subscribers
// (see /dashboard/streams/jobs in routes/streams.js). All mutations go
// through appendLog/finishJob so this is the chokepoint. Non-throwing.
function emitJobChanged(job) {
  try {
    bus.emit("jobs:changed", {
      jobId: job.id,
      status: job.status,
      addonId: job.addonId || null,
      action: job.action || null,
      lastLine: job.log.length > 0 ? job.log[job.log.length - 1] : "",
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  } catch {}
}

/** Read installed.json as array */
/**
 * First path segment of a manifest-declared path, or null for a falsy/non-string
 * input. Used to derive extra refresh-eligible roots from manifest.server.args[0],
 * .panel, .panelRoutes, .skills[] — see isValidPathSegment for the guard that
 * keeps a hostile declared path (e.g. "../x") from ever being joined.
 */
function firstPathSegment(p) {
  if (!p || typeof p !== "string") return null;
  const seg = p.split("/")[0];
  return seg || null;
}

/** A single, plain, non-traversal path segment (no "/", not "." or ".."). */
function isValidPathSegment(seg) {
  return typeof seg === "string" && seg.length > 0 && seg !== "." && seg !== ".." && !seg.includes("/") && !seg.includes("\\");
}

/**
 * Copy one explicit-include item (a top-level file or a directory) from a
 * bundle's repo source into its installed dest dir. No-op (returns false) if
 * the item doesn't exist in the repo source. cpSync is additive: dest-only
 * files not present in the source survive.
 */
function copyBundleRefreshItem(appSrc, destDir, item) {
  const src = join(appSrc, item);
  if (!existsSync(src)) return false;
  const dst = join(destDir, item);
  if (statSync(src).isDirectory()) {
    cpSync(src, dst, { recursive: true });
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  return true;
}

/**
 * True iff the repo package.json declares a dependency NAME absent from the
 * installed bundle's node_modules/ — the ONLY npm-install trigger (R1/R2:
 * narrow, added-dep-only; a removed dep or a version-range-only bump must NOT
 * fire a boot-time npm install). existsSync(join(nm, depName)) handles
 * @scope/name naturally.
 */
function bundleNeedsNpmInstall(appSrc, destDir) {
  const pkg = readJsonSafe(join(appSrc, "package.json"), null);
  if (!pkg || !pkg.dependencies || typeof pkg.dependencies !== "object") return false;
  const nodeModules = join(destDir, "node_modules");
  return Object.keys(pkg.dependencies).some((depName) => !existsSync(join(nodeModules, depName)));
}

/**
 * D1 (BH-4): version-keyed refresh of one installed first-party bundle.
 *
 * If the repo manifest and the installed manifest are both readable and their
 * `version` strings differ (both-undefined counts as EQUAL — crow's no-version
 * bundles like vllm/llama must never churn; otherwise a difference in either
 * direction refreshes, since the repo is the source of truth and installed
 * copies are snapshots, not forks), this:
 *   1. Copies the explicit-include set of code artifacts from appSrc → destDir
 *      (type-aware: docker-surface bundles get a narrower set, since existing
 *      docker bundles bind-mount config/scripts/etc into LIVE containers and a
 *      refresh must never mutate a running container's mounts).
 *   2. Re-copies the served PANELS_DIR artifacts (<id>.js, <id>-routes.js),
 *      rmSync-first for determinism, and ensures the PANELS_DIR node_modules
 *      symlink exists (install-parity — an April-era install may predate it).
 *   3. Runs `npm install --omit=dev` in destDir, via the injected runner,
 *      ONLY when an added dependency name triggers it (warn-only; never
 *      throws into the caller).
 *
 * Returns null (caller falls back to the existing missing-only repair) when
 * either manifest is unreadable/missing or the versions are equal. Otherwise
 * returns { oldVersion, newVersion, touched }.
 */
async function refreshVersionedBundle({ id, appSrc, destDir, runner }) {
  const repoManifest = readJsonSafe(join(appSrc, "manifest.json"), null);
  const installedManifest = readJsonSafe(join(destDir, "manifest.json"), null);
  if (!repoManifest || !installedManifest) return null;

  const oldVersion = installedManifest.version;
  const newVersion = repoManifest.version;
  const bothUndefined = oldVersion === undefined && newVersion === undefined;
  if (bothUndefined || oldVersion === newVersion) return null;

  const isDocker = !!repoManifest.docker;
  const touched = [];

  // Explicit-include set (R1 MAJOR-4: generalized to cover JS AND Python
  // first-party bundles). R2 MAJOR-2: type-aware restriction — docker-surface
  // bundles get ONLY manifest.json/settings-section.js/server//panel//skills/
  // + validated manifest-declared roots, NEVER config/scripts/templates/src
  // (existing bundles bind-mount exactly those into live containers).
  const topFiles = isDocker
    ? ["manifest.json", "settings-section.js"]
    : ["manifest.json", "package.json", "package-lock.json", "pyproject.toml", "uv.lock", "settings-section.js", "main.py", "run.sh", "config.py"];
  const dirs = isDocker
    ? ["server", "panel", "skills"]
    : ["server", "panel", "skills", "curriculum", "public", "scripts", "templates", "routes", "config", "src"];
  // Never copied for ANY type: docker-compose.yml, Dockerfile, entrypoint.sh,
  // .env*, node_modules/, data/ — simply absent from both lists above.

  // Manifest-declared roots: the bundle contract is manifest-declaration-
  // driven, so any path a manifest names is code by definition. Each is
  // reduced to its first path segment and validated to a single plain segment
  // before any join (R2 minor — same traversal class F-HEALTH-1 fixed for
  // bundleId elsewhere in this file).
  const declaredRoots = new Set();
  const declare = (p) => {
    const seg = firstPathSegment(p);
    if (seg && isValidPathSegment(seg)) declaredRoots.add(seg);
  };
  if (repoManifest.server?.args?.[0]) declare(repoManifest.server.args[0]);
  if (typeof repoManifest.panel === "string") declare(repoManifest.panel);
  else if (repoManifest.panel && typeof repoManifest.panel === "object") declaredRoots.add("panel");
  if (repoManifest.panelRoutes) declare(repoManifest.panelRoutes);
  if (Array.isArray(repoManifest.skills)) {
    for (const s of repoManifest.skills) declare(s);
  }

  for (const item of new Set([...topFiles, ...dirs, ...declaredRoots])) {
    if (copyBundleRefreshItem(appSrc, destDir, item)) touched.push(item);
  }

  // Served panel artifacts — exactly as install does (bundles.js ~:1170-1184),
  // rmSync-first (R1 minor: crow's live panel files are legacy symlinks into
  // the bundle dir; cpSync-over-symlink is safe on Node 20, but rm-first is
  // deterministic across Node versions, and post-refresh they're regular files).
  mkdirSync(PANELS_DIR, { recursive: true });
  const panelRelPath = resolvePanelPath(repoManifest, id);
  if (panelRelPath) {
    const panelSrc = join(destDir, panelRelPath);
    if (existsSync(panelSrc)) {
      const panelDst = join(PANELS_DIR, `${id}.js`);
      rmSync(panelDst, { force: true });
      cpSync(panelSrc, panelDst);
      touched.push(`panels/${id}.js`);
    }
  }
  if (repoManifest.panelRoutes) {
    const routesSrc = join(destDir, repoManifest.panelRoutes);
    if (existsSync(routesSrc)) {
      const routesDst = join(PANELS_DIR, `${id}-routes.js`);
      rmSync(routesDst, { force: true });
      cpSync(routesSrc, routesDst);
      touched.push(`panels/${id}-routes.js`);
    }
  }
  // Install-parity: ensure the PANELS_DIR node_modules symlink exists (an
  // April-era install may predate it — bundles.js:1186).
  const nmLink = join(PANELS_DIR, "node_modules");
  if (!existsSync(nmLink)) {
    const gatewayNm = join(APP_ROOT, "node_modules");
    if (existsSync(gatewayNm)) {
      try { symlinkSync(gatewayNm, nmLink); } catch {}
    }
  }

  // npm step: narrow, added-dep-name-only trigger; warn-only; via the
  // injected runner so tests never shell out to a real npm.
  if (bundleNeedsNpmInstall(appSrc, destDir)) {
    try {
      await runner("npm", ["install", "--omit=dev"], { cwd: destDir });
      touched.push("npm install");
    } catch (err) {
      console.warn(`[bundles] npm install failed for ${id}: ${err.message}`);
    }
  }

  console.log(`[bundles] refreshed ${id} ${oldVersion} -> ${newVersion}`);
  return { oldVersion, newVersion, touched };
}

/**
 * Repair missing bundle UI artifacts for already-installed bundles, and
 * (D1, BH-4) refresh a bundle's installed copy when the repo manifest's
 * version has moved past the installed manifest's version.
 *
 * Prior incident (2026-04-14): the Companion bundle's docker service was migrated
 * from grackle to crow, but ~/.crow/bundles/companion/settings-section.js was
 * absent on crow because only the docker volumes moved over. This meant the
 * Settings → Companion section disappeared until the file was manually copied.
 *
 * Prior incident (2026-07-11, BH-4): W2-5 migrated bundles/maker-lab/ in-repo
 * from research_projects to project_spaces, but the missing-only repair below
 * never refreshes a file that's merely stale-but-present — the installed copy
 * was an April snapshot, so /dashboard/maker-lab 500'd on `no such table:
 * research_projects` for months. The version-keyed refresh phase (above,
 * refreshVersionedBundle) is the fix: ANY version delta re-copies the
 * bundle's code + served panel artifacts, since the repo is the source of
 * truth. It runs BEFORE — and, when it fires, supersedes — the missing-only
 * repair for that bundle.
 *
 * This function idempotently re-copies settings-section.js and panel/ from the
 * app repo (appBundles) into ~/.crow/bundles/<id>/ for every installed bundle.
 * It's safe to run on every gateway start — cpSync overwrites identical files.
 *
 * @param {{appBundles?: string, run?: Function}} [opts]
 *   appBundles: override the repo bundles root (test seam; defaults to APP_BUNDLES).
 *   run: override the shell runner used for the npm-install step (test seam;
 *        defaults to the module's `run`).
 * @returns {Promise<{repaired: string[], errors: Array<{id, error}>}>}
 */
export async function repairInstalledBundleAssets({ appBundles = APP_BUNDLES, run: runner = run } = {}) {
  const repaired = [];
  const errors = [];

  let installed;
  try {
    installed = getInstalled();
  } catch (err) {
    return { repaired, errors: [{ id: "*", error: `read installed: ${err.message}` }] };
  }
  if (!Array.isArray(installed) || installed.length === 0) {
    return { repaired, errors };
  }

  for (const entry of installed) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!id || !isValidBundleId(id)) continue;

    const appSrc = join(appBundles, id);
    if (!existsSync(appSrc)) continue; // not a first-party bundle — skip

    const destDir = join(BUNDLES_DIR, id);
    const touched = [];
    try {
      mkdirSync(destDir, { recursive: true });

      // D1: version-keyed refresh phase, BEFORE the missing-only repair below.
      const refreshed = await refreshVersionedBundle({ id, appSrc, destDir, runner });
      if (refreshed) {
        repaired.push(`${id}: refreshed ${refreshed.oldVersion} -> ${refreshed.newVersion} (${refreshed.touched.join(", ") || "no files changed"})`);
        continue; // refresh fully supersedes the missing-only phase for this bundle
      }

      // settings-section.js: single file — copy if missing or stale-size
      const settingsSrc = join(appSrc, "settings-section.js");
      const settingsDst = join(destDir, "settings-section.js");
      if (existsSync(settingsSrc) && !existsSync(settingsDst)) {
        copyFileSync(settingsSrc, settingsDst);
        touched.push("settings-section.js");
      }

      // panel/: dir — copy recursively if missing
      const panelSrc = join(appSrc, "panel");
      const panelDst = join(destDir, "panel");
      if (existsSync(panelSrc) && !existsSync(panelDst)) {
        cpSync(panelSrc, panelDst, { recursive: true });
        touched.push("panel/");
      }

      // manifest.json: refresh if missing (keeps operator from losing bundle metadata)
      const manifestSrc = join(appSrc, "manifest.json");
      const manifestDst = join(destDir, "manifest.json");
      if (existsSync(manifestSrc) && !existsSync(manifestDst)) {
        copyFileSync(manifestSrc, manifestDst);
        touched.push("manifest.json");
      }

      if (touched.length > 0) {
        repaired.push(`${id}: ${touched.join(", ")}`);
      }
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }

  return { repaired, errors };
}

function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      return Array.isArray(data) ? data : Object.entries(data).map(([id, v]) => ({ id, ...v }));
    }
  } catch { /* ignore */ }
  return [];
}

/** Write installed.json */
function saveInstalled(arr) {
  mkdirSync(dirname(INSTALLED_PATH), { recursive: true });
  writeFileSync(INSTALLED_PATH, JSON.stringify(arr, null, 2));
}

/** Read manifest.json for a bundle from app source */
function getManifest(bundleId) {
  const manifestPath = join(APP_BUNDLES, bundleId, "manifest.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

/** Run a shell command safely with execFile */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Detect available Docker Compose command.
 * Returns { cmd, args } for either `docker compose` (v2) or `python3 -m compose` (v1 fallback).
 */
let _composeCmd = null;
async function getComposeCmd() {
  if (_composeCmd) return _composeCmd;
  // Try docker compose v2 first
  try {
    await run("docker", ["compose", "version"]);
    _composeCmd = { cmd: "docker", prefix: ["compose"] };
    return _composeCmd;
  } catch {}
  // Try python3 -m compose (docker-compose v1 via python package)
  try {
    await run("python3", ["-m", "compose", "version"]);
    _composeCmd = { cmd: "python3", prefix: ["-m", "compose"] };
    return _composeCmd;
  } catch {}
  // Try docker-compose binary directly
  try {
    await run("docker-compose", ["version"]);
    _composeCmd = { cmd: "docker-compose", prefix: [] };
    return _composeCmd;
  } catch {}
  throw new Error("No docker compose command found. Install docker-compose-plugin or docker-compose.");
}

/** Run a docker compose command with the detected compose variant */
async function runCompose(composeArgs, opts = {}) {
  const compose = await getComposeCmd();
  return run(compose.cmd, [...compose.prefix, ...composeArgs], opts);
}

/** Read JSON file with fallback */
function readJsonSafe(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch { /* ignore */ }
  return fallback;
}

/** Write JSON file (creates parent dirs) */
function writeJsonSafe(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Append or replace a managed env block inside the given .env file.
 * blockName is the human marker: "# crow-<name> BEGIN" / "# crow-<name> END".
 * version: optional fingerprint of the block's contents, stamped as a comment
 *   so drift between bundle .env and current DB config is detectable later.
 * Idempotent — existing block is replaced in place.
 */
function appendManagedBlock(envPath, blockName, kvPairs, version) {
  const begin = `# crow-${blockName} BEGIN (managed by gateway — do not edit)`;
  const end = `# crow-${blockName} END`;
  const lines = [begin];
  if (version) lines.push(`# crow-${blockName}-version: ${version}`);
  for (const [k, v] of Object.entries(kvPairs)) lines.push(`${k}=${v}`);
  lines.push(end, "");
  const block = lines.join("\n");

  let cur = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const pattern = new RegExp(`${begin.replace(/[().*+?^$|\\/[\]{}]/g, "\\$&")}[\\s\\S]*?${end}\\n?`);
  if (pattern.test(cur)) {
    cur = cur.replace(pattern, "");
  }
  if (cur.length && !cur.endsWith("\n")) cur += "\n";
  writeFileSync(envPath, cur + block);
}

/**
 * Read the version stamp written by appendManagedBlock. Returns null if the
 * block is missing or has no version comment.
 */
function readManagedBlockVersion(envPath, blockName) {
  if (!existsSync(envPath)) return null;
  const cur = readFileSync(envPath, "utf8");
  const m = cur.match(new RegExp(`# crow-${blockName}-version: (\\S+)`));
  return m ? m[1] : null;
}

/**
 * Translate shared-storage config from dashboard_settings into the bundle's
 * app-specific S3 env shape and write a managed block to its .env.
 *
 * Returns { version, keys } on success, null if DB has no shared-storage
 * config (so the caller can log "on-disk fallback").
 */
async function injectSharedStorage({ destDir, bundleId, translator, bucketSuffix }) {
  const { loadSharedStorageFromDb } = await import("../../storage/s3-client.js");
  const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
  const { translate } = await import("../storage-translators.js");
  const shared = await loadSharedStorageFromDb(createDbClient(), loadOrCreateIdentity());
  if (!shared) return null;

  const scheme = shared.useSSL ? "https" : "http";
  const endpointUrl = `${scheme}://${shared.host}:${shared.port}`;
  const bucket = `${shared.bucketPrefix}-${bucketSuffix || bundleId}`;

  const translated = translate(translator, {
    endpoint: endpointUrl,
    region: shared.region,
    bucket,
    accessKey: shared.accessKey,
    secretKey: shared.secretKey,
  });

  // Per-translator side knobs that have to be on for S3 storage to work end
  // to end. These are NOT part of the storage-translator output (which is
  // pure config-mapping) but are required side-effects of having the bundle
  // talk to S3 instead of on-disk media.
  //   funkwhale: PROXY_MEDIA=False makes Django redirect to presigned S3
  //              URLs instead of nginx X-Accel-Redirect (which only works
  //              for on-disk media; X-Accel against an S3 path 404s).
  const SIDE_KNOBS = {
    funkwhale: { PROXY_MEDIA: "False" },
    // mastodon, peertube, pixelfed, etc. work with their default toggles —
    // their translators set every required env var.
  };
  Object.assign(translated, SIDE_KNOBS[translator] || {});

  // Version stamp: sha256 of the translated (plaintext) block with keys
  // sorted lexicographically. Hashing plaintext rather than sealed ciphertext
  // so re-seals with fresh nonces don't spuriously signal drift.
  const sortedKeys = Object.keys(translated).sort();
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, translated[k]]));
  const version = createHash("sha256").update(canonical).digest("hex");

  appendManagedBlock(join(destDir, ".env"), "shared-storage", translated, version);
  return { version, keys: sortedKeys };
}

/** Validate bundle ID format (alphanumeric + hyphens only) */
function isValidBundleId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 64;
}

/**
 * Validate a docker-compose.yml for security issues.
 * Rejects: sensitive host mounts, privileged mode, dangerous capabilities.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
/**
 * Inspect a compose file for security concerns.
 *
 * @param {string} composePath - path to docker-compose.yml
 * @param {string} bundleId
 * @param {object} [opts]
 * @param {object} [opts.manifest] - bundle manifest; if it has `privileged: true`
 *   AND `opts.consentVerified` is true, NET_ADMIN/host-network/privileged are allowed.
 *   Read-only Docker socket mounts are allowed when manifest declares `consent_required: true`
 *   (and consent has been verified) — bundles like netdata/dozzle need this.
 * @param {boolean} [opts.consentVerified=false] - true when the install request supplied a
 *   valid consent token consumed by validateConsentToken().
 * @returns {{valid: boolean, reason?: string}}
 */
function validateComposeFile(composePath, bundleId, opts = {}) {
  const { manifest, consentVerified = false } = opts;
  const isPrivilegedAllowed = !!(manifest?.privileged && consentVerified);
  const isConsentBundle = !!(manifest?.consent_required && consentVerified);
  try {
    const content = readFileSync(composePath, "utf8");

    // Sensitive host paths that should never be mounted (regardless of consent)
    const sensitivePatterns = [
      /^\s*-\s+["']?\/:/m,                    // root mount /
      /^\s*-\s+["']?\/etc[/:]/m,              // /etc
      /^\s*-\s+["']?~?\/?\.ssh[/:]/m,         // ~/.ssh
      /^\s*-\s+["']?~?\/?\.crow\/data[/:]/m,  // ~/.crow/data
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(content)) {
        return { valid: false, reason: `Compose file mounts a sensitive host path (matched: ${pattern.source})` };
      }
    }

    // Docker socket — allowed read-only ONLY when manifest has consent_required and consent was verified
    // (netdata, dozzle pattern). Read-write Docker socket is never allowed via this path.
    const rwSocketPattern = /^\s*-\s+["']?\/var\/run\/docker\.sock(?!\s*:[^:]*:\s*ro)/m;
    const anySocketPattern = /^\s*-\s+["']?\/var\/run\/docker/m;
    if (rwSocketPattern.test(content)) {
      return { valid: false, reason: "Read-write Docker socket mounts are not permitted" };
    }
    if (anySocketPattern.test(content) && !isConsentBundle && !isPrivilegedAllowed) {
      return { valid: false, reason: "Docker socket mount requires manifest 'consent_required: true' and verified consent" };
    }

    // Privileged mode
    if (/^\s*privileged:\s*true/m.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file uses privileged mode but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    // Dangerous capabilities (NET_ADMIN etc.) — gated by manifest.privileged + consent
    if (/NET_ADMIN|SYS_ADMIN|SYS_PTRACE|SYS_RAWIO|NET_RAW/m.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file requests dangerous capabilities (NET_ADMIN, SYS_ADMIN, NET_RAW, etc.) but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    // Host networking — gated by manifest.privileged + consent
    if (/network_mode:\s*host/i.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file uses host networking but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Could not read compose file: ${err.message}` };
  }
}

// --- PR 0: Consent token helpers (server-validated install consent) ---

/**
 * Mint a single-use consent token for a bundle install. Stores in install_consents table
 * with an expiry. The client passes this token back on POST /install.
 */
async function mintConsentToken(db, bundleId) {
  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO install_consents (token, bundle_id, schema_version, created_at, expires_at, consumed)
          VALUES (?, ?, ?, ?, ?, 0)`,
    args: [token, bundleId, CONSENT_TOKEN_SCHEMA_VERSION, now, now + CONSENT_TOKEN_TTL_SECONDS],
  });
  return { token, expires_in_seconds: CONSENT_TOKEN_TTL_SECONDS };
}

/**
 * Atomically validate-and-consume a consent token. Returns true only if:
 *   - token row exists for the given bundleId
 *   - schema_version matches current version
 *   - not yet expired
 *   - not yet consumed
 * The consume step is atomic to prevent double-spend / double-install races.
 */
async function validateConsentToken(db, bundleId, token) {
  if (!token || typeof token !== "string") return false;
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: `UPDATE install_consents
          SET consumed = 1
          WHERE token = ?
            AND bundle_id = ?
            AND schema_version = ?
            AND consumed = 0
            AND expires_at > ?
          RETURNING token`,
    args: [token, bundleId, CONSENT_TOKEN_SCHEMA_VERSION, now],
  });
  return result.rows.length > 0;
}

/**
 * Best-effort cleanup of expired consent tokens. Called opportunistically.
 */
async function pruneExpiredConsents(db) {
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: "DELETE FROM install_consents WHERE expires_at < ? OR consumed = 1",
    args: [now],
  }).catch(() => {});
}

/**
 * Determine whether a bundle requires consent (privileged or consent_required).
 */
function manifestRequiresConsent(manifest) {
  return !!(manifest && (manifest.privileged === true || manifest.consent_required === true));
}

/**
 * Pick the install_consent_message for the user's preferred language.
 * Falls back to English, then to a generic message.
 */
function pickConsentMessage(manifest, lang = "en") {
  if (manifest?.install_consent_messages && typeof manifest.install_consent_messages === "object") {
    return manifest.install_consent_messages[lang]
      ?? manifest.install_consent_messages.en
      ?? manifest.install_consent_message
      ?? "This bundle requires explicit consent to install.";
  }
  return manifest?.install_consent_message ?? "This bundle requires explicit consent to install.";
}

/**
 * Summarize the privileged capabilities a bundle requests, for display in the install modal.
 */
function summarizePrivileges(manifest, composePath) {
  const caps = [];
  if (manifest?.privileged) {
    try {
      const content = readFileSync(composePath, "utf8");
      if (/network_mode:\s*host/i.test(content)) caps.push("host networking");
      if (/NET_ADMIN/.test(content)) caps.push("NET_ADMIN (modify firewall)");
      if (/NET_RAW/.test(content)) caps.push("NET_RAW (raw sockets)");
      if (/SYS_ADMIN/.test(content)) caps.push("SYS_ADMIN (system administration)");
      if (/SYS_PTRACE/.test(content)) caps.push("SYS_PTRACE (process tracing)");
      if (/^\s*privileged:\s*true/m.test(content)) caps.push("full privileged mode");
    } catch { /* ignore */ }
  }
  if (manifest?.consent_required && !manifest?.privileged) {
    try {
      const content = readFileSync(composePath, "utf8");
      if (/\/var\/run\/docker/.test(content)) caps.push("read Docker socket (sees all containers/env)");
    } catch { /* ignore */ }
  }
  return caps;
}

/**
 * Find installed bundles that depend on a given bundle (via requires.bundles).
 * Used to block uninstall when dependents would break.
 */
function findDependents(bundleId) {
  const installed = getInstalled();
  const dependents = [];
  for (const entry of installed) {
    if (entry.id === bundleId) continue;
    const m = getManifest(entry.id);
    const reqs = m?.requires?.bundles;
    if (Array.isArray(reqs) && reqs.includes(bundleId)) {
      dependents.push(entry.id);
    }
  }
  return dependents;
}

/**
 * Propagate env vars from a bundle install to the gateway's .env file.
 * Uncomments and sets values for vars that are already present as comments,
 * or appends them if not found.
 */
function propagateEnvToGateway(envVars) {
  if (!envVars || typeof envVars !== "object" || Object.keys(envVars).length === 0) return;
  if (!existsSync(APP_ENV_PATH)) return;

  let content = readFileSync(APP_ENV_PATH, "utf8");

  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined || value === "") continue;
    // Match commented-out or existing lines like: # KEY=value or KEY=value
    const pattern = new RegExp(`^(#\\s*)?${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, `${key}=${value}`);
    } else {
      // Append if not found at all
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  writeFileSync(APP_ENV_PATH, content);
}

/**
 * Re-comment env vars in the gateway's .env file during uninstall.
 * Turns `KEY=value` back into `# KEY=value`.
 */
function revertEnvInGateway(envKeys) {
  if (!envKeys || envKeys.length === 0) return;
  if (!existsSync(APP_ENV_PATH)) return;

  let content = readFileSync(APP_ENV_PATH, "utf8");

  for (const key of envKeys) {
    // Match uncommented lines like KEY=value
    const pattern = new RegExp(`^(${key}=.*)$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, "# $1");
    }
  }

  writeFileSync(APP_ENV_PATH, content);
}

/**
 * Schedule a graceful gateway restart so new env vars take effect.
 * Uses the same pattern as auto-update: exit with code 1 so the supervisor restarts.
 * Emits 'crow:shutdown' on process so the HTTP server can close its listening
 * socket before the exit — prevents EADDRINUSE when the supervisor starts the new instance.
 * When unsupervised, just sets process.env so the storage server can reinitialize.
 */
function scheduleGatewayRestart(delayMs = 2000) {
  if (isSupervised()) {
    // Supervised — close server, then exit to trigger restart
    console.log("[bundles] Restarting gateway to apply new configuration...");
    setTimeout(() => {
      process.emit("crow:shutdown");
      // Give server.close() time to release the port, then exit
      setTimeout(() => process.exit(1), 1000);
    }, delayMs);
  } else {
    // Unsupervised — reload env vars into current process
    try {
      const envContent = readFileSync(APP_ENV_PATH, "utf8");
      for (const line of envContent.split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && !match[1].startsWith("#")) {
          process.env[match[1]] = match[2];
        }
      }
      console.log("[bundles] Reloaded env vars into current process");
    } catch {}
  }
}

/**
 * Map AI bundle IDs to AI Provider settings for auto-configuration.
 * When a local AI bundle is installed, these settings are written to .env
 * so the BYOAI Chat in the Messages panel works immediately.
 */
function getAiProviderConfig(bundleId, envVars) {
  const configs = {
    ollama: {
      provider: "ollama",
      baseUrl: envVars?.OLLAMA_HOST || "http://localhost:11434",
    },
    localai: {
      provider: "openai",
      baseUrl: (envVars?.LOCALAI_HOST || "http://localhost:8080") + "/v1",
    },
  };
  return configs[bundleId] || null;
}

/**
 * All install-time gates, as an outcome function.
 *
 * The single-install route maps the outcome to HTTP; the collection installer
 * (Task 6) maps it to a per-member skip/fail entry. Semantics are identical to
 * the pre-refactor inline chain in POST /bundles/api/install (order matters:
 * id → source exists → already-installed → dependencies → hardware → GPU →
 * consent → hosted-host-networking refusal).
 *
 * @returns {Promise<
 *   { ok: true, manifest: object, installed: Array, consentVerified: boolean, hardwareWarning?: object }
 * | { ok: false, status: number, code: string, error: string, extra?: object }>}
 *   codes: invalid_id | not_found | already_installed | missing_dependencies |
 *          hardware_gate | gpu_arch_gate | consent_required | consent_invalid | hosted_forbidden
 */
export async function validateInstall(bundleId, { envVars = {}, consentToken = null, forceInstall = false } = {}) {
  if (!bundleId || !isValidBundleId(bundleId)) {
    return { ok: false, status: 400, code: "invalid_id", error: "Invalid bundle ID" };
  }

  // Check source exists
  const sourceDir = join(APP_BUNDLES, bundleId);
  if (!existsSync(sourceDir)) {
    return { ok: false, status: 404, code: "not_found", error: `Bundle '${bundleId}' not found` };
  }

  // Check not already installed
  const installed = getInstalled();
  if (installed.find((i) => i.id === bundleId)) {
    return { ok: false, status: 409, code: "already_installed", error: `Bundle '${bundleId}' is already installed` };
  }

  // PR 0: dependency check — refuse install if any required bundle is missing
  const manifest = getManifest(bundleId);
  const requiredBundles = manifest?.requires?.bundles || [];
  if (requiredBundles.length > 0) {
    const installedIds = new Set(installed.map((i) => i.id));
    const missing = requiredBundles.filter((id) => !installedIds.has(id));
    if (missing.length > 0) {
      return {
        ok: false, status: 400, code: "missing_dependencies",
        error: `Bundle '${bundleId}' requires the following bundles to be installed first: ${missing.join(", ")}`,
        extra: { missing_dependencies: missing },
      };
    }
  }

  // PR 3: advisory Android-app version gate. The gateway can't verify the
  // user's phone from here — the check happens on the phone when the panel
  // JS reads navigator.userAgent. Log a warning so ops can see the
  // requirement and include it in the install response for UIs that want
  // to surface it.
  const minAndroidApp = manifest?.requires?.min_android_app;
  if (minAndroidApp) {
    console.log(`[bundles] ${bundleId} declares min_android_app=${minAndroidApp} — enforced client-side on the Crow Android app`);
  }

  // F.0: hardware gate — refuse install if RAM/disk headroom is insufficient,
  // warn (but allow) if under the recommended threshold. MemAvailable + SSD-
  // backed swap at half-weight is the effective-RAM basis; already-installed
  // bundles' recommended_ram_mb is subtracted from the pool. Bypass via
  // `force_install: true` (CLI-only — the web UI never surfaces this flag).
  let hardwareWarning;
  if (!forceInstall) {
    const gate = checkHardwareGate({
      manifest,
      installed,
      manifestLookup: (id) => getManifest(id),
      dataDir: CROW_HOME,
    });
    if (!gate.allow) {
      return { ok: false, status: 400, code: "hardware_gate", error: gate.reason, extra: { hardware_gate: gate } };
    }
    if (gate.level === "warn") {
      // Attach warning to the job so the UI can surface it; install proceeds.
      hardwareWarning = gate;
    }
  }

  // GPU arch gate — refuse install if the bundle's required GPU architecture
  // family doesn't match what the host actually has (e.g. CUDA-only bundle on
  // an AMD ROCm box). No force_install bypass: the install would crash anyway.
  {
    const gpuCheck = checkGpuArchCompatible(manifest);
    if (!gpuCheck.ok) {
      return { ok: false, status: 400, code: "gpu_arch_gate", error: gpuCheck.reason, extra: { gpu_arch_gate: gpuCheck } };
    }
  }

  // PR 0: consent token check — required for privileged or consent_required bundles
  let consentVerified = false;
  if (manifestRequiresConsent(manifest)) {
    if (!consentToken) {
      return {
        ok: false, status: 403, code: "consent_required",
        error: "Consent token required. Call GET /bundles/api/consent-challenge/:id to obtain one.",
        extra: { consent_required: true },
      };
    }
    const consentDb = createDbClient();
    try {
      consentVerified = await validateConsentToken(consentDb, bundleId, consentToken);
    } finally {
      try { consentDb.close(); } catch {}
    }
    if (!consentVerified) {
      return {
        ok: false, status: 403, code: "consent_invalid",
        error: "Consent token is invalid, expired, or already consumed. Mint a new one and retry.",
        extra: { consent_expired: true },
      };
    }
  }

  // Block bundles with network_mode: host on managed hosting (security risk on shared infrastructure)
  if (process.env.CROW_HOSTED) {
    const composePath = join(sourceDir, "docker-compose.yml");
    if (existsSync(composePath)) {
      const composeContent = readFileSync(composePath, "utf8");
      if (/network_mode:\s*host/i.test(composeContent)) {
        return {
          ok: false, status: 403, code: "hosted_forbidden",
          error: "This bundle requires host networking and is not available on managed hosting.",
        };
      }
    }
  }

  return { ok: true, manifest, installed, consentVerified, ...(hardwareWarning ? { hardwareWarning } : {}) };
}

/**
 * Run one bundle install against an existing job.
 *
 * Outcome-returning by design: the collection installer shares ONE job across N
 * members, so this function must not decide the job's fate. With deferRestart:true
 * it never calls finishJob() and never calls scheduleGatewayRestart() — it reports
 * `needsRestart` and the caller does exactly one restart at the end.
 *
 * @param {object} opts
 * @param {object} opts.job              the job to append logs to
 * @param {Array}  opts.installedSnapshot  getInstalled() as of validation (the body pushes onto it)
 * @param {boolean} opts.consentVerified  from validateInstall — gates validateComposeFile
 * @param {object} opts.manifest          the on-disk manifest
 * @param {boolean} opts.deferRestart     true → return needsRestart instead of restarting
 * @returns {Promise<{ok:true, needsRestart:boolean}|{ok:false, reason:string}>}
 */
export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, deferRestart = false }) {
  let needsRestart = false;
  try {
    const addonType = manifest?.type || "bundle";
    const sourceDir = join(APP_BUNDLES, bundleId);

    // 1. Copy bundle files to ~/.crow/bundles/<id>
    const destDir = join(BUNDLES_DIR, bundleId);
    mkdirSync(destDir, { recursive: true });
    cpSync(sourceDir, destDir, { recursive: true });
    appendLog(job, "Copied bundle files");

    // 1.5 If the bundle ships its own package.json (typically because it
    // brings an MCP server using @modelcontextprotocol/sdk), install
    // those deps now. Without this the proxy spawns the MCP child and it
    // immediately dies with ERR_MODULE_NOT_FOUND for the SDK, which
    // surfaces user-side as "I don't have a music player integration
    // installed" or similar mysteries.
    if (existsSync(join(destDir, "package.json")) && !existsSync(join(destDir, "node_modules"))) {
      appendLog(job, "Installing bundle dependencies (npm install)…");
      try {
        execFileSync("npm", ["install", "--omit=optional", "--no-audit", "--no-fund"], {
          cwd: destDir,
          env: process.env,
          timeout: 120_000,
          stdio: "pipe",
        });
        appendLog(job, "Dependencies installed");
      } catch (err) {
        appendLog(job, `Warning: npm install failed: ${err.message?.slice(0, 200)}`);
        // Don't fail install; some bundles may have optional deps that
        // can't resolve in every environment. The MCP server will fail
        // to start later but the bundle install itself succeeds.
      }
    }

    // 2. Write env vars if provided
    if (envVars && typeof envVars === "object") {
      const envLines = Object.entries(envVars)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`);
      if (envLines.length > 0) {
        writeFileSync(join(destDir, ".env"), envLines.join("\n") + "\n");
        appendLog(job, `Wrote ${envLines.length} env vars`);
      }
    } else if (existsSync(join(destDir, ".env.example")) && !existsSync(join(destDir, ".env"))) {
      cpSync(join(destDir, ".env.example"), join(destDir, ".env"));
      appendLog(job, "Created .env from .env.example");
    }

    // 2.5 Inject shared-storage vars if bundle declares a translator.
    // Gateway owns the translation in-process (configure-storage.mjs is not
    // invoked by the install flow — it's a manual-recovery tool only).
    if (manifest?.storage?.translator) {
      try {
        const injected = await injectSharedStorage({
          destDir,
          bundleId: bundleId,
          translator: manifest.storage.translator,
          bucketSuffix: manifest.storage.bucket || bundleId,
        });
        if (injected === null) {
          appendLog(job, "No shared-storage config in DB; bundle will use on-disk storage.");
        } else {
          appendLog(job, `Injected shared-storage vars via translator=${manifest.storage.translator} (version=${injected.version.slice(0, 8)})`);
        }
      } catch (err) {
        appendLog(job, `Warning: shared-storage injection failed: ${err.message}`);
      }
    }

    // 3. Type-specific install steps
    if (addonType === "bundle") {
      // Docker bundle — pull images and start containers
      const composePath = join(destDir, "docker-compose.yml");
      if (existsSync(composePath)) {
        // PR 0: validate compose for ALL bundles (first-party + community).
        // First-party bundles with privileged/host-network must declare manifest.privileged
        // and the install request must include a verified consent token.
        const validation = validateComposeFile(composePath, bundleId, {
          manifest,
          consentVerified,
        });
        if (!validation.valid) {
          appendLog(job, `Security check failed: ${validation.reason}`);
          // Clean up copied files
          rmSync(destDir, { recursive: true, force: true });
          return { ok: false, reason: `Security check failed: ${validation.reason}` };
        }
        appendLog(job, "Security check passed");

        appendLog(job, "Pulling Docker images...");
        try {
          await runCompose(["pull"], { cwd: destDir });
          appendLog(job, "Docker images pulled");
        } catch (err) {
          appendLog(job, `Warning: docker compose pull failed: ${err.message}`);
        }

        // Start containers (add --build if compose file has build directives)
        const composeContent = readFileSync(composePath, "utf8");
        const needsBuild = /^\s+build:/m.test(composeContent);
        const upArgs = needsBuild ? ["up", "-d", "--build"] : ["up", "-d"];
        appendLog(job, needsBuild ? "Building and starting containers..." : "Starting containers...");
        try {
          await runCompose(upArgs, { cwd: destDir });
          appendLog(job, "Containers started");
        } catch (err) {
          const detail = err.stderr || err.message;
          appendLog(job, `docker compose up failed: ${detail}`);
          // Still add to installed.json so user can configure env vars and hit "Start"
          const installed2 = getInstalled();
          if (!installed2.find((i) => i.id === bundleId)) {
            installed2.push({ id: bundleId, type: addonType, version: manifest?.version, installedAt: new Date().toISOString() });
            saveInstalled(installed2);
          }
          return { ok: false, reason: `docker compose up failed: ${detail}` };
        }
      }

      // Propagate env vars to gateway .env so dependent services connect
      if (envVars && Object.keys(envVars).length > 0) {
        propagateEnvToGateway(envVars);
        appendLog(job, "Configuration applied to gateway");
        needsRestart = true;
      }

      // Bundle types can also have MCP servers — register if manifest has server config
      if (manifest?.server) {
        const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
        const env = {};
        if (manifest.server.envKeys && envVars) {
          for (const key of manifest.server.envKeys) {
            if (envVars[key]) env[key] = envVars[key];
          }
        }
        if (manifest.env_vars) {
          for (const v of manifest.env_vars) {
            if (v.default && !env[v.name]) env[v.name] = v.default;
          }
        }
        // Do NOT bake an absolute CROW_DB_PATH here. mcp-addons.json can be
        // shared by more than one gateway on a host (e.g. grackle runs a
        // main gateway + a separate-DB instance off the same ~/.crow), so a
        // hard-coded path is correct for one and a cross-instance DB leak for
        // the other — which crash-loops the wrong gateway on "database is
        // locked". The MCP child instead inherits the SPAWNING gateway's
        // CROW_DB_PATH via process.env at launch (its own default otherwise),
        // so each gateway's children always use that gateway's DB.
        mcpAddons[bundleId] = {
          command: manifest.server.command,
          args: manifest.server.args || [],
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
        appendLog(job, `Registered MCP server '${bundleId}'`);
        needsRestart = true;
      }

      // Bundle types can also have panels — install them
      if (manifest?.panel) {
        mkdirSync(PANELS_DIR, { recursive: true });
        const panelPath = resolvePanelPath(manifest, bundleId);
        const panelSrc = join(destDir, panelPath);
        if (existsSync(panelSrc)) {
          cpSync(panelSrc, join(PANELS_DIR, `${bundleId}.js`));
          appendLog(job, `Installed panel: ${bundleId}`);
        }
        if (manifest.panelRoutes) {
          const routesSrc = join(destDir, manifest.panelRoutes);
          if (existsSync(routesSrc)) {
            cpSync(routesSrc, join(PANELS_DIR, `${bundleId}-routes.js`));
            appendLog(job, `Installed panel routes: ${bundleId}-routes`);
          }
        }
        // Ensure panels dir can resolve gateway dependencies
        const nmLink = join(PANELS_DIR, "node_modules");
        if (!existsSync(nmLink)) {
          const gatewayNm = join(APP_ROOT, "node_modules");
          if (existsSync(gatewayNm)) {
            try { symlinkSync(gatewayNm, nmLink); } catch {}
          }
        }
        const panelsConfig = readJsonSafe(PANELS_CONFIG_PATH, []);
        if (!panelsConfig.includes(bundleId)) {
          panelsConfig.push(bundleId);
          writeJsonSafe(PANELS_CONFIG_PATH, panelsConfig);
        }
        needsRestart = true;
      }
    } else if (addonType === "mcp-server") {
      // MCP server — register in mcp-addons.json
      if (manifest?.server) {
        const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
        const env = {};
        // Collect user-provided env vars
        if (manifest.server.envKeys && envVars) {
          for (const key of manifest.server.envKeys) {
            if (envVars[key]) env[key] = envVars[key];
          }
        }
        // Also include default values from manifest.env_vars
        if (manifest.env_vars) {
          for (const v of manifest.env_vars) {
            if (v.default && !env[v.name]) env[v.name] = v.default;
          }
        }
        mcpAddons[bundleId] = {
          command: manifest.server.command,
          args: manifest.server.args || [],
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
        appendLog(job, `Registered MCP server '${bundleId}'`);
      }

      // Install npm dependencies if package.json exists
      const pkgJson = join(destDir, "package.json");
      if (existsSync(pkgJson)) {
        appendLog(job, "Installing dependencies...");
        try {
          const { execFileSync } = await import("node:child_process");
          execFileSync("npm", ["install", "--prefix", destDir, "--omit=dev"], {
            stdio: "pipe",
            timeout: 120_000,
          });
          appendLog(job, "Dependencies installed");
        } catch (npmErr) {
          appendLog(job, `Warning: npm install failed — ${npmErr.message}`);
        }
      }

      // Install panel + routes if present in manifest
      if (manifest?.panel) {
        mkdirSync(PANELS_DIR, { recursive: true });
        const panelPath = resolvePanelPath(manifest, bundleId);
        const panelSrc = join(destDir, panelPath);
        if (existsSync(panelSrc)) {
          cpSync(panelSrc, join(PANELS_DIR, `${bundleId}.js`));
          appendLog(job, `Installed panel: ${bundleId}`);
        }
        if (manifest.panelRoutes) {
          const routesSrc = join(destDir, manifest.panelRoutes);
          if (existsSync(routesSrc)) {
            cpSync(routesSrc, join(PANELS_DIR, `${bundleId}-routes.js`));
            appendLog(job, `Installed panel routes: ${bundleId}-routes`);
          }
        }
        // Ensure panels dir can resolve gateway dependencies (express, multer, etc.)
        const nmLink = join(PANELS_DIR, "node_modules");
        if (!existsSync(nmLink)) {
          const gatewayNm = join(APP_ROOT, "node_modules");
          if (existsSync(gatewayNm)) {
            try {
              symlinkSync(gatewayNm, nmLink);
              appendLog(job, "Linked gateway node_modules for panel route resolution");
            } catch {}
          }
        }
        // Register in panels.json
        const panelsConfig = readJsonSafe(PANELS_CONFIG_PATH, []);
        if (!panelsConfig.includes(bundleId)) {
          panelsConfig.push(bundleId);
          writeJsonSafe(PANELS_CONFIG_PATH, panelsConfig);
        }
        needsRestart = true;
      }
    } else if (addonType === "skill") {
      // Skill — copy skill files to ~/.crow/skills/
      mkdirSync(SKILLS_DIR, { recursive: true });
      if (manifest?.skills) {
        for (const skillPath of manifest.skills) {
          const src = join(destDir, skillPath);
          const dest = join(SKILLS_DIR, skillPath.split("/").pop());
          if (existsSync(src)) {
            cpSync(src, dest);
            appendLog(job, `Installed skill: ${skillPath.split("/").pop()}`);
          }
        }
      }
    } else if (addonType === "panel") {
      // Panel — copy panel file to ~/.crow/panels/ and register
      mkdirSync(PANELS_DIR, { recursive: true });
      if (manifest?.panel) {
        const panelPath = resolvePanelPath(manifest, bundleId);
        const src = join(destDir, panelPath);
        const dest = join(PANELS_DIR, panelPath.split("/").pop());
        if (existsSync(src)) {
          cpSync(src, dest);
          const panelsCfg = readJsonSafe(PANELS_CONFIG_PATH, []);
          if (!panelsCfg.includes(bundleId)) {
            panelsCfg.push(bundleId);
            writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg);
          }
          appendLog(job, `Installed panel: ${panelPath.split("/").pop()}`);
        }
      }
    }

    // 3b. Handle panel field on any add-on type
    if (manifest.panel && addonType !== "panel") {
      const panelPath = resolvePanelPath(manifest, bundleId);
      const panelSourceDir = join(APP_BUNDLES, bundleId, panelPath.replace(/[^a-zA-Z0-9_\-\/\.]/g, ""));
      if (existsSync(panelSourceDir)) {
        const panelFilename = panelPath.split("/").pop();
        const panelDest = join(CROW_HOME, "panels", panelFilename);
        // Ensure panels directory exists
        mkdirSync(join(CROW_HOME, "panels"), { recursive: true });
        copyFileSync(panelSourceDir, panelDest);
        // Register in panels.json
        const panelsJsonPath = join(CROW_HOME, "panels.json");
        let panelsList = [];
        if (existsSync(panelsJsonPath)) {
          try { panelsList = JSON.parse(readFileSync(panelsJsonPath, "utf8")); } catch {}
        }
        const panelId = panelFilename.replace(/\.js$/, "");
        if (!panelsList.includes(panelId)) {
          panelsList.push(panelId);
          writeFileSync(panelsJsonPath, JSON.stringify(panelsList, null, 2));
        }
        needsRestart = true;
        appendLog(job, `Installed panel: ${panelFilename}`);
      }
    }

    // 4. Copy any associated skills (bundles and mcp-servers can have skills too)
    if (addonType !== "skill" && manifest?.skills) {
      mkdirSync(SKILLS_DIR, { recursive: true });
      for (const skillPath of manifest.skills) {
        const src = join(destDir, skillPath);
        const dest = join(SKILLS_DIR, skillPath.split("/").pop());
        if (existsSync(src)) {
          cpSync(src, dest);
          appendLog(job, `Installed skill: ${skillPath.split("/").pop()}`);
        }
      }
    }

    // 5. Auto-configure AI Provider when installing local AI bundles
    if (manifest?.category === "ai" && addonType === "bundle") {
      const aiConfig = getAiProviderConfig(bundleId, envVars);
      if (aiConfig) {
        try {
          const { resolveEnvPath, writeEnvVar, sanitizeEnvValue } = await import("../env-manager.js");
          const envPath = resolveEnvPath();
          writeEnvVar(envPath, "AI_PROVIDER", sanitizeEnvValue(aiConfig.provider));
          writeEnvVar(envPath, "AI_BASE_URL", sanitizeEnvValue(aiConfig.baseUrl));
          // Invalidate cached provider config
          try {
            const { invalidateConfigCache } = await import("../ai/provider.js");
            invalidateConfigCache();
          } catch {}
          appendLog(job, `AI Chat configured — provider: ${aiConfig.provider}, endpoint: ${aiConfig.baseUrl}`);
          appendLog(job, "Open Messages → AI Chat to start chatting with your local AI");
          needsRestart = true;
        } catch (err) {
          appendLog(job, `Note: Could not auto-configure AI Chat: ${err.message}. Set it manually in Settings.`);
        }
      }
    }

    // 6. Track installation
    installedSnapshot.push({
      id: bundleId,
      type: addonType,
      version: manifest?.version || "1.0.0",
      installedAt: new Date().toISOString(),
    });
    saveInstalled(installedSnapshot);
    appendLog(job, "Installation tracked");

    // Open firewall ports and set up Tailscale HTTPS for direct-mode web UIs
    if (manifest?.ports && Array.isArray(manifest.ports)) {
      const { execFileSync: efs } = await import("node:child_process");
      for (const port of manifest.ports) {
        // Open firewall for Tailscale
        try {
          efs("sudo", ["-n", "ufw", "allow", "from", "100.64.0.0/10", "to", "any", "port", String(port), "proto", "tcp", "comment", `Crow: ${manifest.name || bundleId}`], { timeout: 10000 });
          appendLog(job, `Opened firewall port ${port}/tcp for Tailscale`);
        } catch {
          appendLog(job, `Note: Could not open port ${port} (sudo/ufw not available — open manually if needed)`);
        }
      }
      // Set up Tailscale HTTPS proxy for direct-mode webUI ports (SPA apps need TLS due to HSTS)
      if (manifest?.webUI?.proxyMode === "direct" && manifest.webUI.port) {
        try {
          efs("sudo", ["-n", "tailscale", "serve", "--bg", "--https", String(manifest.webUI.port), `http://localhost:${manifest.webUI.port}`], { timeout: 15000 });
          appendLog(job, `Set up Tailscale HTTPS on port ${manifest.webUI.port}`);
        } catch {
          appendLog(job, `Note: Could not set up Tailscale HTTPS for port ${manifest.webUI.port}`);
        }
      }
    }

    let notifDb;
    try {
      notifDb = createDbClient();
      await createNotification(notifDb, {
        title: `Installed: ${manifest?.name || bundleId}`,
        type: "system",
        source: "bundle-installer",
        action_url: "/dashboard/extensions",
      });
    } catch {} finally {
      notifDb?.close();
    }

    // Phase 5-full: auto-register providers declared in manifest.providers[]
    try {
      const manifest = getManifest(bundleId);
      if (manifest?.providers?.length) {
        const providerDb = createDbClient();
        let hostIp = "127.0.0.1";
        if (manifest.host && manifest.host !== "local") {
          try {
            const peer = await getInstance(providerDb, manifest.host);
            hostIp = peer?.tailscale_ip || peer?.gateway_url?.replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/\/.*/, "") || hostIp;
          } catch {}
        }
        const port = manifest.port || 0;
        for (const pdef of manifest.providers) {
          try {
            const r = await registerProviderFromManifest({
              db: providerDb, manifest, providerDef: pdef, port, hostIp,
            });
            appendLog(job, `Registered provider: ${pdef.id} (${r.lamport_ts})`);
          } catch (err) {
            appendLog(job, `Provider register skipped for ${pdef.id}: ${err.message}`);
          }
        }
        invalidateProvidersCache();
      }
    } catch (err) {
      appendLog(job, `Provider auto-register skipped: ${err.message}`);
    }

    // Seed STT/TTS profiles declared in manifest.{stt,tts}ProfileSeed.
    try {
      const manifest = getManifest(bundleId);
      if (manifest?.sttProfileSeed || manifest?.ttsProfileSeed) {
        const seedDb = createDbClient();
        if (manifest.sttProfileSeed) await seedProfile(seedDb, "stt", manifest.sttProfileSeed, (m) => appendLog(job, m));
        if (manifest.ttsProfileSeed) await seedProfile(seedDb, "tts", manifest.ttsProfileSeed, (m) => appendLog(job, m));
      }
    } catch (err) {
      appendLog(job, `Profile seed skipped: ${err.message}`);
    }

    return { ok: true, needsRestart };
  } catch (err) {
    const reason = err?.message || String(err);
    appendLog(job, `Install failed: ${reason}`);
    return { ok: false, reason };
  }
}

/**
 * Re-validate a collection's membership against the ON-DISK manifests.
 * registry/collections.json is data, not a trust boundary: this is the gate that
 * stops a tampered file from one-click-installing a privileged, consent-required,
 * or host-networking bundle without the consent ceremony.
 */
export function validateCollectionServerSide(collection) {
  if (!collection || !Array.isArray(collection.members) || collection.members.length === 0) {
    return { ok: false, error: "Collection has no members" };
  }
  const seen = new Set();
  for (const m of collection.members) {
    if (!m?.id || !isValidBundleId(m.id)) return { ok: false, error: `Invalid member id '${m?.id}'` };
    if (!existsSync(join(APP_BUNDLES, m.id))) return { ok: false, error: `Member '${m.id}' is not a known bundle` };
    const man = getManifest(m.id);
    if (man?.privileged === true || man?.consent_required === true) {
      return { ok: false, error: `Member '${m.id}' requires explicit consent — install it individually` };
    }
    if (man?.requires?.gpu || man?.requires?.min_vram_gb) {
      return { ok: false, error: `Member '${m.id}' is GPU-gated — install it individually` };
    }
    for (const dep of man?.requires?.bundles || []) {
      if (!seen.has(dep) && !getInstalled().some((i) => i.id === dep)) {
        return { ok: false, error: `Member '${m.id}' requires '${dep}', which is neither installed nor earlier in the collection` };
      }
    }
    seen.add(m.id);
  }
  return { ok: true };
}

/** Display plan (what the user is told will happen). Execution re-checks every gate live. */
export function planInstallSet(collection) {
  const installedIds = new Set(getInstalled().map((i) => i.id));
  return collection.members.map((m) => {
    if (installedIds.has(m.id)) return { id: m.id, action: "skip", reason: "already installed" };
    if (!existsSync(join(APP_BUNDLES, m.id))) return { id: m.id, action: "skip", reason: "not found in this Crow's bundle set" };
    const gpu = checkGpuArchCompatible(getManifest(m.id));
    if (!gpu.ok) return { id: m.id, action: "skip", reason: gpu.reason || "incompatible with this host's GPU" };
    return { id: m.id, action: "install" };
  });
}

/**
 * Manifest-required env keys that are still EMPTY in the bundle's written .env.
 * Keys with a value (including .env.example defaults — DB passwords, secret keys)
 * count as configured and are NEVER surfaced: those are consumed at first container
 * boot, and changing them afterwards breaks the app or strands its data.
 * @param {object} [envOverride] test seam — the parsed .env
 */
export function needsConfigKeys(bundleId, envOverride = null) {
  const man = getManifest(bundleId);
  const required = (man?.env_vars || []).filter((v) => v.required).map((v) => v.name);
  if (required.length === 0) return [];
  let env = envOverride;
  if (!env) {
    env = {};
    const envPath = join(BUNDLES_DIR, bundleId, ".env");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    }
  }
  return required.filter((k) => !env[k] || env[k].trim() === "");
}

/**
 * @returns {Router}
 */
export default function bundlesRouter() {
  const router = Router();

  // GET /bundles/api/status — List installed bundles with container status
  router.get("/bundles/api/status", async (req, res) => {
    const installed = getInstalled();
    const results = [];

    for (const entry of installed) {
      const bundleDir = join(BUNDLES_DIR, entry.id);
      const composePath = join(bundleDir, "docker-compose.yml");
      const manifest = getManifest(entry.id);
      const info = { ...entry, name: manifest?.name || entry.id, type: manifest?.type || entry.type || "unknown" };

      if (existsSync(composePath)) {
        try {
          const { stdout } = await runCompose(["ps", "--format", "json"], { cwd: bundleDir });
          const containers = stdout.trim().split("\n").filter(Boolean).map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          info.containers = containers.map((c) => ({
            name: c.Name || c.Service,
            state: c.State || "unknown",
            status: c.Status || "",
          }));
          info.running = containers.some((c) => c.State === "running");
        } catch {
          info.containers = [];
          info.running = false;
        }
      } else {
        info.containers = null; // MCP server type — no containers
        info.running = null;
      }

      results.push(info);
    }

    res.json({ bundles: results });
  });

  // GET /bundles/api/consent-challenge/:id — Mint a consent token for a privileged or consent_required bundle.
  // Returns { required: false } for bundles that don't need consent (so the UI can skip the modal).
  router.get("/bundles/api/consent-challenge/:id", async (req, res) => {
    const bundleId = req.params.id;
    if (!bundleId || !isValidBundleId(bundleId)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }
    const manifest = getManifest(bundleId);
    if (!manifest) {
      return res.status(404).json({ error: `Bundle '${bundleId}' not found` });
    }
    if (!manifestRequiresConsent(manifest)) {
      return res.json({ required: false });
    }
    const composePath = join(APP_BUNDLES, bundleId, "docker-compose.yml");
    const lang = (req.query.lang || req.headers["accept-language"] || "en").toString().slice(0, 2).toLowerCase();
    const db = createDbClient();
    try {
      await pruneExpiredConsents(db);
      const { token, expires_in_seconds } = await mintConsentToken(db, bundleId);
      // Compute prereq install state for UI to show prereq checklist
      const reqBundles = manifest.requires?.bundles || [];
      const installedIds = new Set(getInstalled().map((i) => i.id));
      const prereqs = reqBundles.map((id) => ({ id, installed: installedIds.has(id) }));
      res.json({
        required: true,
        bundle_id: bundleId,
        bundle_name: manifest.name || bundleId,
        privileged: !!manifest.privileged,
        consent_required: !!manifest.consent_required,
        message: pickConsentMessage(manifest, lang),
        capabilities: summarizePrivileges(manifest, composePath),
        prereqs,
        min_android_app: manifest.requires?.min_android_app || null,
        token,
        expires_in_seconds,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to mint consent token: ${err.message}` });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // POST /bundles/api/install — Install a bundle
  router.post("/bundles/api/install", async (req, res) => {
    const { bundle_id, env_vars, consent_token } = req.body;

    const v = await validateInstall(bundle_id, {
      envVars: env_vars,
      consentToken: consent_token,
      forceInstall: !!req.body.force_install,
    });
    if (!v.ok) {
      return res.status(v.status).json({ error: v.error, ...(v.extra || {}) });
    }
    if (v.hardwareWarning) req._hardwareWarning = v.hardwareWarning;

    // Create job for async tracking
    const job = createJob(bundle_id, "install");
    res.json({ ok: true, job_id: job.id, message: `Installing ${bundle_id}...` });

    // Run install async (don't block the response). The single-install route
    // owns the job's lifecycle: runInstallJob only reports an outcome.
    (async () => {
      const out = await runInstallJob(bundle_id, env_vars, {
        job,
        installedSnapshot: v.installed,
        consentVerified: v.consentVerified,
        manifest: v.manifest,
        deferRestart: false,
      });
      if (!out.ok) {
        finishJob(job, "failed");
        return;
      }
      finishJob(job, out.needsRestart ? "complete_restart" : "complete");
      if (out.needsRestart) {
        appendLog(job, "Scheduling gateway restart to load new panels/servers...");
        scheduleGatewayRestart(3000);
      }
    })();
  });

  // POST /bundles/api/install-set — install a themed collection in one click.
  // ONE job for the whole set (the client polls it like any install), members run
  // sequentially in the collection's topological order, a member failure does NOT
  // abort the set, and exactly ONE gateway restart happens at the end.
  router.post("/bundles/api/install-set", async (req, res) => {
    const { collection_id } = req.body || {};

    const collection = getCollection(collection_id);
    if (!collection) return res.status(404).json({ error: `Unknown collection '${collection_id}'` });

    const v = validateCollectionServerSide(collection);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // Refuse to start while ANY install/uninstall job is running: a single install
    // finishing mid-set fires its own immediate restart and would kill this runner.
    // Predicate is status === "running" — finished jobs linger in the Map for their
    // TTL, so a presence check would 409 every set for 10 minutes after any install.
    const busy = [...jobs.values()].some(
      (j) => j.status === "running" && (j.action === "install" || j.action === "uninstall" || j.action === "install-set"),
    );
    if (busy || isInstallSetRunning()) {
      return res.status(409).json({ error: "Another install is in progress — wait for it to finish and try again." });
    }

    const plan = planInstallSet(collection);
    const job = createJob(collection.id, "install-set");
    try {
      beginInstallSet(collection.id);
    } catch {
      finishJob(job, "failed");
      return res.status(409).json({ error: "A collection install is already in progress." });
    }

    res.json({ job_id: job.id, plan });

    (async () => {
      let anyRestart = false;
      const needsConfig = [];
      try {
        appendLog(job, `Installing collection '${collection.name}' (${plan.filter((p) => p.action === "install").length} to install, ${plan.filter((p) => p.action === "skip").length} skipped)`);

        for (const member of collection.members) {
          // Live gate re-check: getInstalled() has grown as earlier members landed,
          // so cumulative RAM commitments and intra-set dependencies are enforced for
          // real — not against a stale pre-set snapshot.
          const mv = await validateInstall(member.id, {});
          if (!mv.ok) {
            appendLog(job, `SUMMARY member ${member.id} skipped ${mv.error}`);
            continue;
          }
          appendLog(job, `Installing ${member.id}...`);
          const out = await runInstallJob(member.id, {}, {
            job,
            installedSnapshot: mv.installed,
            consentVerified: mv.consentVerified,
            manifest: mv.manifest,
            deferRestart: true,
          });
          if (!out.ok) {
            appendLog(job, `SUMMARY member ${member.id} failed ${out.reason}`);
            continue; // continue-on-error: one bad member must not sink the collection
          }
          if (out.needsRestart) anyRestart = true;
          const keys = needsConfigKeys(member.id);
          if (keys.length > 0) needsConfig.push({ id: member.id, keys });
          appendLog(job, `SUMMARY member ${member.id} installed`);
        }

        for (const nc of needsConfig) appendLog(job, `NEEDS_CONFIG ${nc.id} ${nc.keys.join(",")}`);
        appendLog(job, "Collection install complete");
        finishJob(job, anyRestart ? "complete_restart" : "complete");
        if (anyRestart) scheduleGatewayRestart(3000);
      } catch (err) {
        appendLog(job, `Collection install failed: ${err?.message || err}`);
        finishJob(job, "failed");
      } finally {
        endInstallSet();
      }
    })();
  });

  // POST /bundles/api/uninstall — Remove a bundle
  router.post("/bundles/api/uninstall", async (req, res) => {
    const { bundle_id, delete_data } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' is not installed` });
    }

    // PR 0: refuse to uninstall when other installed bundles depend on this one
    const dependents = findDependents(bundle_id);
    if (dependents.length > 0) {
      return res.status(409).json({
        error: `Cannot uninstall '${bundle_id}' — other installed bundles depend on it: ${dependents.join(", ")}. Uninstall the dependents first.`,
        dependents,
      });
    }

    const job = createJob(bundle_id, "uninstall");
    res.json({ ok: true, job_id: job.id, message: `Removing ${bundle_id}...` });

    (async () => {
      try {
        const manifest = getManifest(bundle_id);
        const addonType = manifest?.type || "bundle";

        // 1. Type-specific cleanup
        if (addonType === "bundle") {
          const composePath = join(bundleDir, "docker-compose.yml");
          if (existsSync(composePath)) {
            appendLog(job, "Stopping containers...");
            const downArgs = ["down", "--remove-orphans"];
            if (delete_data) downArgs.push("-v");
            try {
              await runCompose(downArgs, { cwd: bundleDir });
              appendLog(job, delete_data ? "Containers stopped, volumes removed" : "Containers stopped (data preserved)");
            } catch (err) {
              appendLog(job, `Warning: docker compose down: ${err.message}`);
            }
          }
        } else if (addonType === "mcp-server") {
          // Remove from mcp-addons.json
          const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
          if (mcpAddons[bundle_id]) {
            delete mcpAddons[bundle_id];
            writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
            appendLog(job, "Removed MCP server registration");
          }
          // Disconnect the live proxy connection
          try {
            const { disconnectAddonServer } = await import("../proxy.js");
            await disconnectAddonServer(bundle_id);
            appendLog(job, "Disconnected addon server");
          } catch {}
          // Remove panel + routes files
          const panelFile = join(PANELS_DIR, `${bundle_id}.js`);
          const routesFile = join(PANELS_DIR, `${bundle_id}-routes.js`);
          if (existsSync(panelFile)) { rmSync(panelFile); appendLog(job, "Removed panel"); }
          if (existsSync(routesFile)) { rmSync(routesFile); appendLog(job, "Removed panel routes"); }
          // Remove from panels.json
          const panelsCfg2 = readJsonSafe(PANELS_CONFIG_PATH, []);
          const idx2 = panelsCfg2.indexOf(bundle_id);
          if (idx2 !== -1) {
            panelsCfg2.splice(idx2, 1);
            writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg2);
          }
        } else if (addonType === "panel") {
          // Remove from panels.json and delete panel file
          const panelsCfg = readJsonSafe(PANELS_CONFIG_PATH, []);
          const idx = panelsCfg.indexOf(bundle_id);
          if (idx !== -1) {
            panelsCfg.splice(idx, 1);
            writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg);
          }
          if (manifest?.panel) {
            const panelPath = resolvePanelPath(manifest, bundle_id);
            const panelFile = join(PANELS_DIR, panelPath.split("/").pop());
            if (existsSync(panelFile)) rmSync(panelFile);
            appendLog(job, "Removed panel file and registration");
          }
        }

        // 1b. Handle panel cleanup for any add-on type
        let needsRestart = false;
        if (manifest && manifest.panel && addonType !== "panel") {
          const panelPath = resolvePanelPath(manifest, bundle_id);
          const panelFilename = panelPath.split("/").pop();
          const panelDest = join(CROW_HOME, "panels", panelFilename);
          const panelId = panelFilename.replace(/\.js$/, "");
          // Remove panel file
          if (existsSync(panelDest)) {
            unlinkSync(panelDest);
          }
          // Remove from panels.json
          const panelsJsonPath = join(CROW_HOME, "panels.json");
          if (existsSync(panelsJsonPath)) {
            try {
              let panelsList = JSON.parse(readFileSync(panelsJsonPath, "utf8"));
              panelsList = panelsList.filter(p => p !== panelId);
              writeFileSync(panelsJsonPath, JSON.stringify(panelsList, null, 2));
            } catch {}
          }
          needsRestart = true;
          appendLog(job, `Removed panel: ${panelFilename}`);
        }

        // 2. Remove associated skills (all types can have skills)
        if (manifest?.skills) {
          for (const skillPath of manifest.skills) {
            const skillFile = join(SKILLS_DIR, skillPath.split("/").pop());
            if (existsSync(skillFile)) {
              rmSync(skillFile);
              appendLog(job, `Removed skill: ${skillPath.split("/").pop()}`);
            }
          }
        }

        // 3. Re-comment env vars in gateway .env
        if (addonType === "bundle" && manifest?.env_vars) {
          const envKeys = manifest.env_vars.map((v) => v.name);
          revertEnvInGateway(envKeys);
          appendLog(job, "Reverted gateway configuration");
          needsRestart = true;
        }

        // 4. Close firewall ports (if manifest has ports and ufw is available)
        if (manifest?.ports && Array.isArray(manifest.ports)) {
          const { execFileSync: efs } = await import("node:child_process");
          for (const port of manifest.ports) {
            try {
              efs("sudo", ["-n", "ufw", "delete", "allow", "from", "100.64.0.0/10", "to", "any", "port", String(port), "proto", "tcp"], { timeout: 10000 });
              appendLog(job, `Closed firewall port ${port}/tcp`);
            } catch {
              appendLog(job, `Note: Could not close port ${port} (sudo/ufw not available)`);
            }
          }
          // Remove Tailscale HTTPS proxy for direct-mode webUI
          if (manifest?.webUI?.proxyMode === "direct" && manifest.webUI.port) {
            try {
              efs("sudo", ["-n", "tailscale", "serve", `--https=${manifest.webUI.port}`, "off"], { timeout: 10000 });
              appendLog(job, `Removed Tailscale HTTPS on port ${manifest.webUI.port}`);
            } catch {}
          }
        }

        // 5. Remove bundle files
        rmSync(bundleDir, { recursive: true, force: true });
        appendLog(job, "Bundle files removed");

        // 6. Update installed.json
        const installed = getInstalled().filter((i) => i.id !== bundle_id);
        saveInstalled(installed);
        appendLog(job, "Installation record removed");

        let notifDb;
        try {
          notifDb = createDbClient();
          await createNotification(notifDb, {
            title: `Removed: ${manifest?.name || bundle_id}`,
            type: "system",
            source: "bundle-installer",
            action_url: "/dashboard/extensions",
          });
        } catch {} finally {
          notifDb?.close();
        }

        // Phase 5-full: soft-disable providers registered by this bundle
        try {
          const r = await unregisterProvidersByBundle(createDbClient(), addonId);
          if (r.disabled > 0) {
            appendLog(job, `Disabled ${r.disabled} provider(s) registered by bundle`);
            invalidateProvidersCache();
          }
        } catch (err) {
          appendLog(job, `Provider unregister skipped: ${err.message}`);
        }

        // Reverse STT/TTS profile seeding from this bundle's manifest. Use the
        // in-scope `manifest` (read before the bundle dir was removed above).
        try {
          if (manifest?.sttProfileSeed || manifest?.ttsProfileSeed) {
            const seedDb = createDbClient();
            if (manifest.sttProfileSeed) await unseedProfile(seedDb, "stt", manifest.sttProfileSeed, (m) => appendLog(job, m));
            if (manifest.ttsProfileSeed) await unseedProfile(seedDb, "tts", manifest.ttsProfileSeed, (m) => appendLog(job, m));
          }
        } catch (err) {
          appendLog(job, `Profile unseed skipped: ${err.message}`);
        }

        finishJob(job, needsRestart ? "complete_restart" : "complete");

        // Auto-restart gateway after uninstall if panels/servers were removed
        if (needsRestart) {
          scheduleGatewayRestart(3000);
        }
      } catch (err) {
        appendLog(job, `Error: ${err.message}`);
        finishJob(job, "failed");
      }
    })();
  });

  // Cross-host verification middleware — runs before start/stop, only acts if
  // X-Crow-Signature header is present (otherwise falls through to existing auth).
  const dbForXhost = createDbClient();
  const xhostVerify = crossHostVerifyMiddleware(dbForXhost, {
    optional: true, // non-signed requests fall through to dashboardAuth/OAuth
    audit: (req) => `bundle.${(req.path.split("/").pop() || "")}`,
    auditBundleId: true,
    // emptyBodyString stays at the default "{}" — bundle signers hash JSON.stringify(body || {})
  });

  /**
   * Unified bundle-action dispatcher: if the bundle manifest declares
   * `host: <instance-id>` (and trust boundary passes), forward to that peer.
   * Otherwise run the action locally via runCompose.
   *
   * Called by both start and stop handlers.
   */
  async function dispatchBundleAction({ action, bundleId, actor, req, res }) {
    // First: resolve manifest host (if peer). Only honored when trusted.
    const hostInfo = resolveManifestHost(bundleId);
    if (hostInfo.host && hostInfo.host !== "local") {
      if (!hostInfo.trusted) {
        await auditCrossHostCall(dbForXhost, {
          direction: "outbound",
          action: `bundle.${action}`,
          bundleId,
          actor,
          error: `blocked_manifest_host:${hostInfo.reason}`,
        });
        return res.status(403).json({
          error: "manifest_host_not_trusted",
          reason: hostInfo.reason,
          hint: "Install the bundle via `crow bundle install` or add it to ~/.crow/bundle-host-allow.json",
        });
      }
      // Forward to peer
      const localId = getOrCreateLocalInstanceId();
      const result = await forwardBundleAction({
        db: dbForXhost,
        sourceInstanceId: localId,
        targetInstanceId: hostInfo.host,
        action,
        bundleId,
        actor,
      });
      if (!result.ok) {
        return res.status(result.status || 502).json({
          error: `cross_host_${action}_failed`,
          reason: result.error,
        });
      }
      return res.json({
        ok: true,
        via: "cross-host",
        target: hostInfo.host,
        message: result.body?.message || `Bundle '${bundleId}' ${action}ped (remote)`,
      });
    }

    // Local path
    const bundleDir = join(BUNDLES_DIR, bundleId);
    const composePath = join(bundleDir, "docker-compose.yml");
    if (!existsSync(composePath)) {
      return res.status(404).json({ error: `Bundle '${bundleId}' has no Docker containers` });
    }
    try {
      if (action === "start") {
        const content = readFileSync(composePath, "utf8");
        const upArgs = /^\s+build:/m.test(content) ? ["up", "-d", "--build"] : ["up", "-d"];
        await runCompose(upArgs, { cwd: bundleDir });
      } else if (action === "stop") {
        await runCompose(["stop"], { cwd: bundleDir });
      } else {
        return res.status(400).json({ error: `unsupported action: ${action}` });
      }
      return res.json({ ok: true, message: `Bundle '${bundleId}' ${action}ped` });
    } catch (err) {
      return res.status(500).json({ error: `Failed to ${action}: ${err.stderr || err.message}` });
    }
  }

  // POST /bundles/api/start — Start bundle containers (local or peer)
  router.post("/bundles/api/start", xhostVerify, async (req, res) => {
    const { bundle_id } = req.body || {};
    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }
    return dispatchBundleAction({
      action: "start",
      bundleId: bundle_id,
      actor: req.crossHostAuth?.sourceInstanceId || "local",
      req,
      res,
    });
  });

  // POST /bundles/api/stop — Stop bundle containers (local or peer)
  router.post("/bundles/api/stop", xhostVerify, async (req, res) => {
    const { bundle_id } = req.body || {};
    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }
    return dispatchBundleAction({
      action: "stop",
      bundleId: bundle_id,
      actor: req.crossHostAuth?.sourceInstanceId || "local",
      req,
      res,
    });
  });

  // POST /bundles/api/env — Save env vars for an installed bundle
  router.post("/bundles/api/env", (req, res) => {
    const { bundle_id, env_vars } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' is not installed` });
    }

    if (!env_vars || typeof env_vars !== "object") {
      return res.status(400).json({ error: "env_vars must be an object" });
    }

    // Read existing .env, merge with new values
    const envPath = join(bundleDir, ".env");
    const existing = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match) existing[match[1]] = match[2];
      }
    }

    Object.assign(existing, env_vars);
    const envContent = Object.entries(existing)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    writeFileSync(envPath, envContent);

    res.json({ ok: true, message: "Environment variables saved" });
  });

  // GET /bundles/api/jobs/:id — Poll job progress
  router.get("/bundles/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  // POST /bundles/api/restart — Client-triggered gateway restart
  // Called by the client after it confirms the job is done and is ready for the restart.
  router.post("/bundles/api/restart", (req, res) => {
    res.json({ ok: true, message: "Restarting..." });
    scheduleGatewayRestart(1000);
  });

  // GET /bundles/api/shared-storage/status — List installed S3-capable bundles
  // with their on-disk managed-block version vs the current DB hash. The Nest
  // Shared Storage section reads this to render the drift banner.
  router.get("/bundles/api/shared-storage/status", async (req, res) => {
    try {
      const { loadSharedStorageFromDb } = await import("../../storage/s3-client.js");
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const { translate } = await import("../storage-translators.js");
      const shared = await loadSharedStorageFromDb(createDbClient(), loadOrCreateIdentity());

      const installed = getInstalled();
      const entries = [];
      for (const inst of installed) {
        const manifest = getManifest(inst.id);
        if (!manifest?.storage?.translator) continue;
        const bundleDir = join(BUNDLES_DIR, inst.id);
        const envPath = join(bundleDir, ".env");
        const onDiskVersion = readManagedBlockVersion(envPath, "shared-storage");

        let currentVersion = null;
        if (shared) {
          const scheme = shared.useSSL ? "https" : "http";
          const translated = translate(manifest.storage.translator, {
            endpoint: `${scheme}://${shared.host}:${shared.port}`,
            region: shared.region,
            bucket: `${shared.bucketPrefix}-${manifest.storage.bucket || inst.id}`,
            accessKey: shared.accessKey,
            secretKey: shared.secretKey,
          });
          const sortedKeys = Object.keys(translated).sort();
          const canonical = JSON.stringify(sortedKeys.map((k) => [k, translated[k]]));
          currentVersion = createHash("sha256").update(canonical).digest("hex");
        }

        entries.push({
          id: inst.id,
          name: manifest.name || inst.id,
          translator: manifest.storage.translator,
          bucket: `${shared?.bucketPrefix || "crow"}-${manifest.storage.bucket || inst.id}`,
          onDiskVersion: onDiskVersion || null,
          currentVersion,
          drift: onDiskVersion && currentVersion && onDiskVersion !== currentVersion,
          missing: shared && !onDiskVersion, // shared config exists but bundle has no block
        });
      }

      res.json({
        ok: true,
        shared_configured: !!shared,
        bundles: entries,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /bundles/api/shared-storage/apply/:id — Rewrite the shared-storage
  // managed block in an installed bundle's .env from current DB config, then
  // docker compose up -d --force-recreate to pick up the new env.
  router.post("/bundles/api/shared-storage/apply/:id", async (req, res) => {
    const bundleId = req.params.id;
    if (!isValidBundleId(bundleId)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }
    const manifest = getManifest(bundleId);
    if (!manifest?.storage?.translator) {
      return res.status(400).json({ error: `Bundle '${bundleId}' does not declare manifest.storage.translator` });
    }
    const bundleDir = join(BUNDLES_DIR, bundleId);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    }

    try {
      const injected = await injectSharedStorage({
        destDir: bundleDir,
        bundleId,
        translator: manifest.storage.translator,
        bucketSuffix: manifest.storage.bucket || bundleId,
      });
      if (injected === null) {
        return res.status(400).json({ error: "No shared-storage config in DB. Enter MinIO endpoint + credentials in Settings → Shared Storage first." });
      }
      // Force-recreate so the affected containers pick up the new env.
      const composePath = join(bundleDir, "docker-compose.yml");
      if (existsSync(composePath)) {
        await runCompose(["up", "-d", "--force-recreate"], { cwd: bundleDir });
      }
      res.json({ ok: true, version: injected.version, recreated: existsSync(composePath) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
