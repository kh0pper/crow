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

import { invalidateAppCatalog } from "../apps/catalog.js";
import { launcherPin } from "../../shared/resolve-command.js";
import { declaredRoots as bundleDeclaredRoots, badBundlePath, badPanelId } from "../../shared/bundle-declared-paths.js";
import { trustedBinsMissing } from "../../shared/trusted-bins.js";
import { Router } from "express";
import { createNotification } from "../../shared/notifications.js";
import { reportImagePullFailure } from "../bundle-pull-alert.js";
import { markFirstAdminDone, reportFirstAdminNotice, firstAdminVia, clearFirstAdminNotice } from "../bundle-first-admin.js";
import { runFirstAdminSetup, saveFirstAdminLogin, firstAdminSetupPlan, firstAdminResultMessage, SETUP_UNAVAILABLE } from "../bundle-first-admin-setup.js";
import { applyFirstAdminAfter, firstAdminAfterPlan, firstAdminAfterFailureSentence } from "../bundle-first-admin-after.js";
import {
  inviteHandlerFor,
  inviteFirstAdminOnInstall,
  inviteResultSentence,
  closeSignupsSentence,
  clearInviteStateCache,
} from "../first-admin/vaultwarden-invite.js";
import bus from "../../shared/event-bus.js";
import { isSupervised } from "../../shared/supervisor.js";
import { createDbClient } from "../../db.js";
import { execFile } from "node:child_process";
import { withoutCredentialKeys } from "../../shared/credentials-env.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, cpSync, rmSync, copyFileSync, unlinkSync, symlinkSync, readlinkSync, renameSync, statSync, realpathSync, readdirSync, lstatSync, mkdtempSync, openSync, closeSync, fchmodSync, fstatSync, constants as fsConstants } from "node:fs";
import { join, dirname, resolve as resolvePath, relative as relativePath, isAbsolute, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
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
import { dockerAvailable } from "../dashboard/panels/extensions/data-queries.js";
import { beginInstallSet, endInstallSet, isInstallSetRunning } from "../install-lock.js";
import { setActiveJobSource, ENGINE_CHANNELS } from "../bot-engine-status.js";
import {
  CROW_HOME,
  BUNDLES_DIR,
  MCP_ADDONS_PATH,
  APP_ROOT,
  APP_BUNDLES,
  getManifest,
  getInstalledFirstManifest,
  manifestComposeFile,
  needsConfigKeys,
  _setAppBundlesForTest,
} from "../bundles-config.js";
import { isModelOrchestrationDisabled, isModelBundleManifest } from "../../shared/model-orchestration.js";
import { syncBundleSkills, removeBundleSkills, readSkillLedger, skillSyncMode } from "../bundle-skill-sync.js";
import { isSatelliteEntry } from "../satellites/installs.js";
import { envValueProblem, encodeEnvValue, formatEnvLines, updateEnvText, pathEnvKeys } from "../bundle-env-codec.js";
import { sanitizeKeychainRequest, recordKeychainForInstall, markBundleKeychainRemoved, keychainRestoreValues, backfillKeychainEntries, restoreServicesAfterInstall } from "../keychain/install-hooks.js";
import { projectsUsingBundle } from "../../shared/service-connections.js";
import { stopChildrenForBundle } from "../services/children.js";
import { precreateDirs, runPostInstall, hookEnv, spawnGroup, pullTimeoutMs, resolveComposeProject, classifyProjectOwners } from "../bundle-lifecycle.js";
import { provisionNtfy, deprovisionNtfy, AUTOWIRE_KIND } from "../push/ntfy-provision.js";
import { checkComposeModel, guardCtx, loadComposeModel, usesHostNetwork, resolveHostPath, composeEnv as composeEnvFor, composeImageChanges, composeOverrideFiles, expandComposeVars, hostGrants, missingRequiredComposeVars, normalizeHostGrants, parseDotEnv } from "../compose-guard.js";
import { COMPOSE_EDITED_FILE, COMPOSE_IMAGE_CHANGE_FILE, COMPOSE_NEEDS_CONFIG_FILE, COMPOSE_SHA_FILE, COMPOSE_STATE_FILE, beginComposeHistoryPass, clearComposeEdited, clearComposeImageChange, clearComposeNeedsConfig, clearComposeState, composeInPastCommits, markComposeEdited, markComposeImageChange, markComposeNeedsConfig, readComposeEdited, readComposeImageChange, readComposeState, readRecordedComposeSha, recordInstalledCompose, sha256, writeComposeState } from "../bundle-compose-state.js";
import { grantCandidates, activeRoots, otherBundlesRoots, migrateGrants, recordGrants, dropGrants, composeReferencedKeys, readGrants, ungrantedFolderKeys } from "../folder-grants.js";
import { isLocalPasswordSession } from "../dashboard/local-session.js";
import { resolveDataDir } from "../../db.js";
import { PINNED_PATH_ENV_KEYS } from "../../shared/crow-home.js";
import { recordKeptData, clearKeptData, keptDataMatches, recordKeptDataOnUninstall, setWallMode, ADDON_WALL_SWITCH_KEYS } from "../../shared/addon-walls-file.js";
import { legacyOwnerKeys, profileFor, pendingHostFields } from "../../../scripts/addon-sandbox/profile.mjs";
import { pinEntryIfWalled, PinRefused } from "../../../scripts/addon-sandbox/pin.mjs";
import { sandboxLine } from "../../../scripts/addon-sandbox/words.mjs";
import { addonWallStatus } from "../dashboard/shared/addon-wall-status.js";
import { isStorageEnvConsumer } from "../addon-env.js";
import { readStoredNtfyConfig } from "../push/ntfy-config.js";
import { isPlaceholderValue } from "../bundle-env-placeholders.js";
import { keychainGeneratedKeys, planGeneratedEnv, retainedEnvPath, legacyFallbackKeys, stripGeneratedKeys, parseEnvText, writePrivateFile, gatewayExcludedKeys, gatewayGeneratedEnv, gatewayEnvNames, retainGeneratedForReinstall, envPatternViolation, breachedValueViolation, mintMissingFlaggedKeys } from "../bundle-env-secrets.js";
import {
  jobs, createJob, appendLog, finishJob, setJobChangedHook,
  readInstalled, writeInstalled,
  run, getComposeCmd, dockerRunner, composeEnv as coreComposeEnv,
  runCompose as coreRunCompose, runComposeTeardown as coreRunComposeTeardown,
  blankHardFailKeys as coreBlankHardFailKeys, composeServiceRunning as coreComposeServiceRunning,
  composeProjectRunning, MISSING_VAR_RE, nonBlankEnv, hardFailComposeKeys,
  validateComposeFile, HOST_NETWORK, writeInstallEnv, crowHomeDefaultRel, scrubPlaceholderLines,
} from "../bundle-core.js";
// Moved to ../bundle-core.js; re-exported so existing importers and tests are unchanged.
export {
  _runOptsForTest, _setComposeRunnerForTest, _setDockerRunnerForTest,
  hardFailComposeKeys, writeInstallEnv, crowHomeDefaultRel, scrubPlaceholderLines,
} from "../bundle-core.js";

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

// CROW_HOME / BUNDLES_DIR / APP_ROOT / APP_BUNDLES / getManifest / needsConfigKeys and
// the _setAppBundlesForTest seam all live in ../bundles-config.js — the single source of
// truth (imported here as ESM live bindings, so _setAppBundlesForTest repoints the one
// and only APP_BUNDLES binding for every reader). Re-exported below for pre-existing
// importers (tests/bundles-install-set.test.js, tests/install-set-e2e.test.js).
const SKILLS_DIR = join(CROW_HOME, "skills");
// The skill sync's record (bundle-skill-sync.js): outside skills/ so the
// resolver and the Skills panel never see it.
const SKILL_RECORD_PATH = join(CROW_HOME, "skill-installs.json");
const PANELS_DIR = join(CROW_HOME, "panels");
const PANELS_CONFIG_PATH = join(CROW_HOME, "panels.json");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");
// CROW_APP_ENV_PATH: set only by scripts/run-suite.mjs, so a suite run inside
// a real checkout never reads or rewrites that checkout's .env.
const defaultAppEnvPath = () => process.env.CROW_APP_ENV_PATH || join(APP_ROOT, ".env");
let APP_ENV_PATH = defaultAppEnvPath();
/** Test-only: repoint the gateway .env that propagateEnvToGateway writes (normally <repo>/.env). */
export function _setAppEnvPathForTest(path) { APP_ENV_PATH = path || defaultAppEnvPath(); }
// Test-only: replace the HIBP range fetch used by env_vars[].check "not_breached".
let _breachFetchForTest = null;
export function _setBreachFetchForTest(fn) { _breachFetchForTest = fn || null; }

export { needsConfigKeys, _setAppBundlesForTest };
export { validateComposeFile as _validateComposeFileForTest };

// Docker-availability probe (Item 4-PR5) — implemented in the extensions
// panel's data-queries.js (the panel render path may not import this module;
// see that file). Re-exported here so route-layer consumers share the ONE
// cached probe with the extensions-page banner.
export { dockerAvailable };

// Test-only: override the collections.json path read by POST /install-set
// (getCollection() defaults to the real registry/collections.json, which has
// no path parameter at that call site — a fixture collection needs this seam
// to be reachable at all).
let _collectionsPathOverride = null;
export function _setCollectionsPathForTest(path) { _collectionsPathOverride = path; }

// Test-only: replace the gateway-restart side effect (which calls process.exit)
// so install-set E2E tests can assert it fires exactly once without killing
// the test process. Pass null to restore the real behavior.
let _restartHookForTest = null;
export function _setRestartHookForTest(fn) { _restartHookForTest = fn; }

// Test-only: a barrier the install-set runner awaits at the TOP of every member
// iteration, including the first. Without it, every fixture install in the E2E
// suite is pure synchronous file I/O with no real async wait, so the whole set
// finishes before a concurrent HTTP request's socket data can even be read —
// the busy-gate (second POST while the set runs → 409) would be untestable over
// real HTTP: there is no run happening for the second call to observe. A test
// installs a pending promise to park the runner mid-set deterministically, then
// resolves it; this replaces an earlier wall-clock step-delay seam.
//
// Production default is null, which makes `if (_installSetBarrier)` in the
// runner false — the branch is never entered, so production takes no await and
// arms no timer. `_getInstallSetBarrierForTest` exists so a test can prove that
// default by mechanism rather than trusting this comment.
let _installSetBarrier = null;
export function _setInstallSetBarrierForTest(promiseOrNull) { _installSetBarrier = promiseOrNull || null; }
export function _getInstallSetBarrierForTest() { return _installSetBarrier; }

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

// ---- panel / panel routes: the two files the gateway copies into PANELS_DIR and RUNS ----
// Defence in depth beside the manifest contract (which reads the same two rules from
// shared/bundle-declared-paths.js): a value that is absolute, climbs with a `..` segment or
// carries a `\` would be copied with `join(destDir, value)` — which keeps all three INSIDE the
// folder — and then imported, so a hand-edited or pre-contract manifest could put arbitrary
// bundle files on the panel surface. Install and refresh SKIP such a declaration with one log
// line (never throw: a broken manifest must not take an install or a boot down).
// One line per manifest value, however many copy sites ask (the install calls the resolver once
// per branch): a mistake is reported once.
const warnedPanelDeclarations = new Set();
function warnRefusedPanel(key, value, why) {
  const k = `${key}\u0000${String(value)}`;
  if (warnedPanelDeclarations.has(k)) return;
  warnedPanelDeclarations.add(k);
  console.warn(`[bundles] ${key} '${String(value).slice(0, 80)}' ${why} — not installed`);
}

/** True when the declared panel path is refused (and logged once); false when it may be copied. */
function panelPathRefused(value, key) {
  if (!badBundlePath(value)) return false;
  warnRefusedPanel(key, value, "is not a relative path inside the bundle");
  return true;
}

function resolvePanelPath(manifest, bundleId) {
  if (!manifest?.panel) return null;
  if (typeof manifest.panel === "string") return panelPathRefused(manifest.panel, "manifest.panel") ? null : manifest.panel;
  // The gateway builds `panel/<id>.js`: the id is a file name, so a path that separates or
  // climbs (or an id of the wrong TYPE — a number, an array, an object) is refused rather than
  // stringified into a path (the contract refuses the same values).
  if (manifest.panel.id !== undefined && badPanelId(manifest.panel.id)) {
    warnRefusedPanel("manifest.panel.id", manifest.panel.id, "is not a plain name (^[a-z0-9][a-z0-9-]*$)");
    return null;
  }
  return `panel/${manifest.panel.id || bundleId}.js`;
}

/** `manifest.panelRoutes` as a checked bundle-relative path, or null when it may not be copied. */
function resolvePanelRoutesPath(manifest) {
  if (!manifest?.panelRoutes) return null;
  return panelPathRefused(manifest.panelRoutes, "manifest.panelRoutes") ? null : manifest.panelRoutes;
}

// The job registry (jobs, createJob, appendLog, finishJob, JOB_TTL_MS) lives in
// ../bundle-core.js; its change hook is wired to the dashboard event below.

/**
 * Read-only (project services Task 12): the non-archived projects with a live connection of this
 * bundle, as [{slug, name}]. [] on any failure (no service_connections table yet, a busy DB): the
 * uninstall itself never depends on it.
 */
let _uninstallAffectedForTest = null;
/** Test seam: replaces the uninstall route's affected-projects query (tests only). */
export function _setUninstallAffectedForTest(fn) { _uninstallAffectedForTest = fn || null; }

export async function uninstallAffectedProjects(bundleId, { dbFactory = createDbClient } = {}) {
  let db;
  try {
    db = dbFactory();
    return await projectsUsingBundle(db, bundleId);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

/** Test-only seams (jobs are in-process; tests need to create/inspect/finish one). */
export function _createJobForTest(bundleId, action) { return createJob(bundleId, action); }
export function _getJobForTest(id) { return jobs.get(id); }
export function _finishJobForTest(job, status) { return finishJob(job, status); }

/**
 * C4 Task 3 (r1 critical #4): the unfinished ("running") install job for
 * bundleId, if any — either a direct single-bundle install job whose
 * bundleId matches, OR an in-flight "install-set" job whose collection
 * contains bundleId as a member (r2: an Agents-collection install must read
 * as "installing" for every member it's carrying, not just the literal
 * collection id — this is what lets a later status seam (Task 4) report
 * a member bundle as installing instead of absent).
 *
 * Exported (not wired into a status seam here — that's Task 4's
 * setActiveJobSource) so POST /bundles/api/install can refuse a second
 * concurrent install of the SAME bundle right now, and Task 4 can reuse the
 * exact same lookup for engineStatus.
 *
 * @param {string} bundleId
 * @returns {{id:string}|null}
 */
export function activeJobFor(bundleId) {
  for (const job of jobs.values()) {
    if (job.status !== "running") continue;
    if (job.action === "install" && job.bundleId === bundleId) return job;
    if (job.action === "install-set") {
      const collection = getCollection(job.bundleId, _collectionsPathOverride || undefined);
      if (collection?.members?.some((m) => m.id === bundleId)) return job;
    }
  }
  return null;
}

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
setJobChangedHook(emitJobChanged);

/**
 * Replace one file at `dst` with a copy of `src` WITHOUT ever writing into the
 * existing file.
 *
 * A refresh can land while a process is running from the installed copy: a
 * shared library under `vendor/` (Studio's `sunvox.so`) is mapped by a live
 * engine, and truncating that inode under it would fault the process. So the
 * bytes go to a temporary file beside the destination, its mode is copied from
 * the source, and a rename puts it in place — the path gets a new inode and
 * whoever holds the old one keeps the old bytes. The temporary file joins the
 * `.<name>.refresh-*` family and is removed on failure.
 * @param {string} src
 * @param {string} dst
 * @returns {void}
 */
function replaceFileAtomic(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  const temp = join(dirname(dst), `.${basename(dst)}.refresh-${randomBytes(6).toString("hex")}`);
  try {
    copyFileSync(src, temp);
    // copyFileSync gives the temp file the source's permissions on Linux; set
    // them explicitly anyway so an executable/read-only source keeps its bits.
    chmodSync(temp, statSync(src).mode & 0o777);
    renameSync(temp, dst);
  } catch (err) {
    try { unlinkSync(temp); } catch {}
    throw err;
  }
}

/**
 * Copy a directory tree the way cpSync recursive does, but every file is
 * replaced atomically (see replaceFileAtomic) and symlinks are recreated rather
 * than followed. Files the destination has and the source does not are left
 * alone, exactly as cpSync leaves them.
 * @param {string} src
 * @param {string} dst
 * @returns {void}
 */
function replaceTreeAtomic(src, dst) {
  // A destination that is a symlink (or a file) where the source has a
  // directory is replaced, never followed: writing through it would land the
  // copy wherever the link points. A directory made here takes the source
  // directory's own permission bits.
  const existing = lstatSync(dst, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) rmSync(dst, { force: true });
  if (!existing || !existing.isDirectory()) {
    mkdirSync(dirname(dst), { recursive: true });
    mkdirSync(dst, { mode: statSync(src).mode & 0o777 });
  }
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(from);
      rmSync(to, { force: true });
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(target, to);
    } else if (entry.isDirectory()) {
      replaceTreeAtomic(from, to);
    } else if (entry.isFile()) {
      replaceFileAtomic(from, to);
    }
  }
}

/**
 * Copy one explicit-include item (a top-level file or a directory) from a
 * bundle's repo source into its installed dest dir. No-op (returns false) if
 * the item doesn't exist in the repo source. Additive: dest-only files not
 * present in the source survive. Never rewrites a destination file in place —
 * a temp file beside each is renamed into place, so a library under `vendor/`
 * that a running process has mapped keeps its old inode and bytes.
 */
function copyBundleRefreshItem(appSrc, destDir, item) {
  const src = join(appSrc, item);
  if (!existsSync(src)) return false;
  const dst = join(destDir, item);
  if (statSync(src).isDirectory()) {
    replaceTreeAtomic(src, dst);
  } else {
    replaceFileAtomic(src, dst);
  }
  return true;
}

/**
 * The bundle-relative compose path and the compose variable expansion live in
 * bundles-config.js (manifestComposeFile) and compose-guard.js
 * (expandComposeVars, composeOverrideFiles): the bind-drift detector reads the
 * same rules without importing this route module.
 */

/** The host-side part of a short-syntax volume (`src:dst[:mode]`), brace-aware. */
function shortVolumeSource(item) {
  let depth = 0;
  for (let i = 0; i < item.length; i++) {
    const ch = item[i];
    if (ch === "$" && item[i + 1] === "{") { depth++; i++; continue; }
    if (ch === "}" && depth > 0) { depth--; continue; }
    if (ch === ":" && depth === 0) return item.slice(0, i);
  }
  return item;
}

/**
 * Every host path a compose file binds into a container, as absolute paths.
 * Reads the TEXT (no YAML parser): short-syntax list items (`- ./x:/y`) and
 * long-syntax `source:` keys. Values are expanded compose-style against
 * `env`; a relative source resolves against `projectDir` (where compose runs:
 * the INSTALLED bundle's compose dir), `~` against HOME. Anything that is not
 * a path after expansion (a named volume, a port, an env entry) is skipped.
 */
function composeBindSources(text, projectDir, env, { rwOnly = false } = {}) {
  const out = [];
  const clean = (v) => String(v).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const consider = (rawSrc) => {
    let src = expandComposeVars(clean(rawSrc), env).trim();
    if (!src) return;
    if (src === "~" || src.startsWith("~/")) src = join(env.HOME || "", src.slice(1));
    if (!(src.startsWith(".") || src.startsWith("/"))) return;   // named volume, port, …
    out.push(isAbsolute(src) ? resolvePath(src) : resolvePath(projectDir, src));
  };
  for (const line of String(text).split(/\r?\n/)) {
    const longForm = /^\s*(?:-\s+)?source:\s*(.+)$/.exec(line);
    if (longForm) { consider(longForm[1]); continue; }
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (!item) continue;
    const vol = clean(item[1]); const src = shortVolumeSource(vol);
    // rwOnly: skip a short-syntax mount whose mode (the LAST ":" segment of "src:dst:mode") lists "ro";
    // long syntax is always counted (conservative)
    const rest = vol.slice(src.length + 1).split(":");
    if (rwOnly && rest.length >= 2 && /(^|,)ro(,|$)/.test(rest.at(-1))) continue;
    consider(src);
  }
  return out;
}

/**
 * Bundle-relative compose files whose binds reach the live container: the
 * installed copy of the compose file itself, and the override files compose
 * merges from the same directory (docker-compose.override.y[a]ml,
 * compose.override.y[a]ml, and `<name>.override.<ext>` for a non-default
 * composefile).
 */
function installedComposeFiles(composeRel) {
  return [composeRel, ...composeOverrideFiles(composeRel)];
}

/** realpath when the path exists, else the lexical path. */
function realOrSelf(p) {
  try { return realpathSync.native(p); } catch { return resolvePath(p); }
}

/** True when a and b are the same path or one contains the other. */
function pathsOverlap(a, b) {
  const ab = relativePath(a, b);
  const ba = relativePath(b, a);
  const inside = (rel) => rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return inside(ab) || inside(ba);
}

/** The env compose expands ${VAR} with for the INSTALLED bundle: its .env, then the shell env (shell wins). */
function composeExpandEnv(destDir) {
  const fileVars = {};
  try {
    Object.assign(fileVars, parseEnvText(readFileSync(join(destDir, ".env"), "utf8")));
  } catch { /* no .env → process env only */ }
  // compose: shell env wins over .env; composeEnv() adds the CROW_HOME every
  // compose run gets (the prod gateway unit may not export it).
  return { ...fileVars, ...composeEnv() };
}

/**
 * The compose `build:` contexts of a bundle (`build: ./runner` or
 * `build:\n  context: ./runner`), read from the compose TEXT the same way the
 * rest of this file reads compose (line regexes, no YAML parser). The compose
 * file is `manifest.docker.composefile` (default docker-compose.yml); contexts
 * and binds resolve against that file's directory, as compose resolves them.
 *
 * Returns only contexts that are relative, resolve to a directory STRICTLY
 * inside the bundle dir (never the bundle root ".": that would sweep in
 * compose/.env/data), stay inside it after symlink resolution, and do not
 * overlap any bind mount of the INSTALLED copy — the context itself, a
 * subdirectory of it, or a parent of it (refresh must never mutate a live
 * container's mounts). Bind sources come from short syntax and long-syntax
 * `source:`, with ${VAR} expanded against the installed .env + process env.
 * Each context is returned as a bundle-relative path.
 *
 * @param {string} appSrc   repo bundle dir (copy source)
 * @param {object} [opts]
 * @param {object} [opts.manifest]  repo manifest (for docker.composefile)
 * @param {string} [opts.destDir]   installed bundle dir (where compose runs); defaults to appSrc
 * @param {object} [opts.env]       env for ${VAR} expansion; defaults to destDir/.env + process.env
 */
function composeBuildContexts(appSrc, { manifest = null, destDir = appSrc, env = null } = {}) {
  const composeRel = manifestComposeFile(manifest);
  if (!composeRel) return [];
  let text;
  try { text = readFileSync(join(appSrc, composeRel), "utf8"); } catch { return []; }
  const composeDirRel = dirname(composeRel);
  const lines = text.split(/\r?\n/);
  const raw = [];
  const clean = (v) => String(v).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)build:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = clean(m[2]);
    if (inline && !inline.startsWith("{")) { raw.push(inline); continue; }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
      const ind = /^(\s*)/.exec(lines[j])[1].length;
      if (ind <= indent) break;
      const c = /^\s+context:\s*(.+)$/.exec(lines[j]);
      if (c) { raw.push(clean(c[1])); break; }
    }
  }
  if (raw.length === 0) return [];
  let rootReal;
  try { rootReal = realpathSync.native(appSrc); } catch { return []; }

  const expandEnv = env || composeExpandEnv(destDir);
  const destReal = realOrSelf(destDir);
  // The LIVE mounts come from the INSTALLED compose (never refreshed, may be
  // operator-edited) plus any override compose merges in from that dir — not
  // only from the repo copy. Scan the union, all against the installed env.
  const bindTexts = [text];
  for (const rel of installedComposeFiles(composeRel)) {
    try {
      const p = join(destDir, rel);
      if (existsSync(p)) bindTexts.push(readFileSync(p, "utf8"));
    } catch { /* unreadable → skip that file */ }
  }
  const projectDir = join(destReal, composeDirRel);
  const binds = bindTexts.flatMap((t) => composeBindSources(t, projectDir, expandEnv)).map(realOrSelf);

  const out = new Set();
  for (const ctx of raw) {
    if (!ctx || isAbsolute(ctx) || ctx.includes("$") || ctx.includes("\\")) continue;
    const rel = relativePath(appSrc, resolvePath(appSrc, composeDirRel, ctx));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const src = join(appSrc, rel);
    let real;
    try { real = realpathSync.native(src); if (!statSync(real).isDirectory()) continue; } catch { continue; }
    const realRel = relativePath(rootReal, real);
    if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) continue;
    const installedCtx = realOrSelf(join(destReal, rel));
    if (binds.some((b) => pathsOverlap(b, installedCtx))) continue;
    out.add(rel);
  }
  return [...out];
}

/** Never refreshed through manifest.refreshFiles, at any depth: instance-local secrets and state. */
const REFRESH_FILES_NEVER = /^(\.env.*|data|node_modules|\.git)$/i;

/**
 * manifest.refreshFiles (Crow Workspace W2, F4): an OPT-IN list of bundle-relative paths a docker bundle wants
 * re-copied on a version change — e.g. ["docker-compose.yml", "onlyoffice-plugin"]: the compose that adds a
 * read-only plugin mount, and the plugin directory it mounts. The running containers are NOT recreated (they keep
 * the old compose until the bundle is restarted). An entry is copied only when it is a plain relative path inside
 * the bundle (no absolute path, "..", "\\" or "$"; never manifest.json, which is the refresh's commit marker), names
 * no .env*, data, node_modules or .git at any depth, exists in the repo copy (realpath inside the bundle), and does
 * not overlap a READ-WRITE bind mount of the installed compose or its overrides (that is data). Returns the
 * bundle-relative paths to copy.
 */
function manifestRefreshFiles(manifest, appSrc, destDir) {
  const list = manifest?.refreshFiles;
  if (!Array.isArray(list) || !list.length) return [];
  let rootReal;
  try { rootReal = realpathSync.native(appSrc); } catch { return []; }
  const composeRel = manifestComposeFile(manifest);
  const destReal = realOrSelf(destDir);
  const env = composeExpandEnv(destDir);
  const texts = [];
  for (const f of composeRel ? [join(appSrc, composeRel), ...installedComposeFiles(composeRel).map((r) => join(destDir, r))] : []) {
    try { if (existsSync(f)) texts.push(readFileSync(f, "utf8")); } catch { /* unreadable → skip */ }
  }
  const projectDir = join(destReal, composeRel ? dirname(composeRel) : ".");
  const rwBinds = texts.flatMap((t) => composeBindSources(t, projectDir, env, { rwOnly: true })).map(realOrSelf);
  const out = new Set();
  for (const p of list.slice(0, 50)) {
    if (typeof p !== "string" || !p || isAbsolute(p) || p.includes("\\") || p.includes("$")) continue;
    const rel = relativePath(".", p);
    if (!rel || rel === "manifest.json" || rel.startsWith("..") || isAbsolute(rel)) continue;
    // The installed compose's bookkeeping is Crow's own record, never a repo file.
    if (rel === COMPOSE_SHA_FILE || rel === COMPOSE_EDITED_FILE || rel === COMPOSE_STATE_FILE || rel === COMPOSE_NEEDS_CONFIG_FILE || rel === COMPOSE_IMAGE_CHANGE_FILE) continue;
    if (rel.split("/").some((seg) => REFRESH_FILES_NEVER.test(seg))) continue;
    let real;
    try { real = realpathSync.native(join(appSrc, rel)); } catch { continue; }
    const realRel = relativePath(rootReal, real);
    if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) continue;
    const installed = realOrSelf(join(destReal, rel));
    if (rwBinds.some((b) => pathsOverlap(b, installed))) continue;
    out.add(rel);
  }
  return [...out];
}

/** Local dev/test droppings never copied with a build context. */
const BUILD_CONTEXT_SKIP = new Set([".venv", "__pycache__", ".pytest_cache", "node_modules", ".git"]);

/**
 * N8-1: bring an installed docker bundle's compose file up to the repo's copy,
 * at ANY version, on EVERY boot — unless the owner edited it.
 *
 * A docker bundle's compose is code: it declares the ports, mounts and settings the
 * container runs with. It used to be copied only at install or on a version change
 * that opted in with `refreshFiles`, so ~40 bundles whose binds were later tightened
 * to loopback kept their old (wider) bind forever. It is now refreshed by default.
 * The version gate is deliberately NOT part of the decision: the release that tightens
 * a bind is a commit to the compose file, not necessarily a manifest version bump, so
 * an install whose version already equals the repo's can still be running an old file
 * (the live case this exists for).
 *
 * The decision, cheapest first:
 *
 *   installed bytes == repo bytes     write the record if missing; done — no git.
 *   installed sha == recorded sha      Crow's own copy, the repo moved on: copy the
 *                                      repo file; no git.
 *   verdict cached for this pair       reuse it: steady-state boots only hash files.
 *   otherwise                          ONE bounded history lookup (`git log --raw`,
 *                                      one call, blob ids compared in Node): a hit
 *                                      means unmodified → copy; a lookup that
 *                                      cannot answer, or has no entry for the path
 *                                      at all (a bundle folder git does not track),
 *                                      means unknown; no hit means edited.
 *
 *   edited     the installed bytes match nothing the checkout shipped: left exactly as
 *              it is, marked (`.crow-compose.edited`) for the Fix-it card, logged by
 *              bundle name only.
 *   unknown    no git / no checkout / a timeout / a path the checkout does not track:
 *              nothing is copied and NO edit mark is written (we do not know), one log
 *              line. Never cached, so the next boot decides again.
 *   needs-config the shipped compose requires a `${X:?…}` the installed .env does not
 *              set: copying it would break Start, so the old copy stays and a card
 *              names the key to set first.
 *   image-change the shipped compose would also change a service's `image:`, resolved
 *              against the installed .env the way the drift code resolves it. That may
 *              be an OLDER tag than what is running, and a downgraded image can migrate
 *              the data's schema on the next restart, so the old copy stays and a card
 *              offers "Apply the update" (which keeps the current file as `<compose>.bak`).
 *              The restart-to-apply card then appears as usual.
 *
 * The verdict is cached in `.crow-compose.state.json` for the (installed bytes, repo
 * compose) pair, so a given pair costs at most one git call — ever. `unknown` is the
 * exception: it is not a decision, so it is never cached, and after the first lookup
 * in a boot pass that cannot answer, the rest of that pass runs no git at all.
 *
 * Owner-specific settings belong in `docker-compose.override.yml`, which Crow never
 * writes, reads as part of the live model and does not include here. An installed copy
 * whose manifest carries `"refresh": false` never reaches this function.
 *
 * @returns {Promise<"copied"|"current"|"edited"|"unknown"|"needs-config"|"image-change"|"none">}
 */
async function catchUpInstalledCompose({ id, appSrc, destDir, repoRoot, repoManifest, installedManifest, runner, log = (m) => console.log(m) }) {
  if (installedManifest?.refresh === false) return "none";
  const composeRel = manifestComposeFile(repoManifest);
  if (!composeRel) return "none";
  const src = join(appSrc, composeRel);
  const dst = join(destDir, composeRel);
  // The install copies the whole tree, so a missing installed compose is a broken
  // install, not an owner edit: leave it alone (nothing runs from it).
  if (!existsSync(src) || !existsSync(dst)) return "none";

  let repoBytes;
  let installedBytes;
  try {
    repoBytes = readFileSync(src);
    installedBytes = readFileSync(dst);
  } catch {
    return "none";
  }
  const repoComposeSha = sha256(repoBytes);
  const installedSha = sha256(installedBytes);

  // 1. Already the repo's copy. Nothing to decide, and never a git call.
  if (installedSha === repoComposeSha) {
    const state = readComposeState(destDir);
    if (!state || state.installedSha !== installedSha || state.repoComposeSha !== repoComposeSha || state.verdict !== "match") {
      writeComposeState(destDir, { installedSha, repoComposeSha, verdict: "match" });
    }
    if (readRecordedComposeSha(destDir) !== installedSha) recordInstalledCompose(destDir, repoManifest);
    // The owner may have restored the file by hand, or an earlier boot kept it:
    // the notes clear by themselves now that the bytes are Crow's own again.
    clearComposeEdited(destDir);
    clearComposeNeedsConfig(destDir);
    clearComposeImageChange(destDir);
    return "current";
  }

  // 2. The installed bytes are exactly what Crow wrote last time: the repo has moved
  //    on and the owner has not touched it. Refresh without git.
  let verdict = null;
  const recorded = readRecordedComposeSha(destDir);
  if (recorded && recorded === installedSha) {
    verdict = "match";
  } else {
    const cached = readComposeState(destDir);
    // "unknown" is never a decision: a record that says so (kept for the bind-drift
    // detector) must not make "Crow could not tell" permanent for this pair.
    if (cached && cached.installedSha === installedSha && cached.repoComposeSha === repoComposeSha && cached.verdict && cached.verdict !== "unknown") {
      verdict = cached.verdict;
    }
  }

  // 3. Nothing cached for this exact pair: ONE bounded history lookup decides between
  //    "unmodified" and "owner edit". Unavailable history (and a path the checkout does
  //    not track at all) is `unknown`, never `edited`.
  if (!verdict) {
    const hit = await composeInPastCommits({ appRoot: repoRoot, bundleId: id, composeRel, bytes: installedBytes, runner });
    if (hit === null) {
      // Recorded for the bind-drift detector (its "Crow now ships it tighter" card reads
      // this verdict), but never used as a decision: the cached check above skips
      // "unknown", so the next boot asks git again. Logged once per pair, not every boot.
      const prev = readComposeState(destDir);
      const samePair = prev && prev.installedSha === installedSha && prev.repoComposeSha === repoComposeSha && prev.verdict === "unknown";
      writeComposeState(destDir, { installedSha, repoComposeSha, verdict: "unknown" });
      // No hold is in effect: this boot could not decide, so an image-change note
      // from an earlier pair would claim a reason that no longer applies.
      clearComposeImageChange(destDir);
      if (!samePair) log(`[bundles] ${id}: cannot tell whether the installed ${composeRel} has local changes (git history unavailable) — left as it is`);
      return "unknown";
    }
    verdict = hit ? "match" : "edited";
    writeComposeState(destDir, { installedSha, repoComposeSha, verdict });
  }

  if (verdict === "edited") {
    clearComposeImageChange(destDir);
    if (!readComposeEdited(destDir)) {
      markComposeEdited(destDir, composeRel);
      log(`[bundles] ${id}: installed ${composeRel} has local changes — not updated; move your changes into docker-compose.override.yml so Crow can update the compose file`);
    }
    return "edited";
  }

  // 4. An image the repo would change is never swapped in silently: the new tag may be
  //    OLDER than the one running, and a downgraded image can migrate the data's schema
  //    on its next restart. The comparison reads both files the same way (the installed
  //    .env and the gateway's allowlisted env resolve `${VAR:-default}`), service by
  //    service, and a service added or removed counts as a change. A hold never lasts
  //    past the condition: the note clears as soon as the two files agree on images.
  const composeEnvNow = { ...parseDotEnv(join(destDir, ".env")), ...composeEnvFor(process.env, CROW_HOME) };
  const imageChanges = composeImageChanges(installedBytes.toString("utf8"), repoBytes.toString("utf8"), composeEnvNow);
  if (imageChanges.length === 0) clearComposeImageChange(destDir);

  // 5. A refresh must never break Start: a compose that requires a variable the
  //    installed .env cannot fill is not copied. The old copy keeps working and the
  //    Fix-it card names the key to set first; the next boot retries.
  const missing = missingRequiredComposeVars(repoBytes.toString("utf8"), {
    dotEnv: parseDotEnv(join(destDir, ".env")),
    env: process.env,
  });
  if (missing.length > 0) {
    markComposeNeedsConfig(destDir, { compose: composeRel, missing });
    writeComposeState(destDir, { installedSha, repoComposeSha, verdict: "needs-config" });
    log(`[bundles] ${id}: not updating ${composeRel} — it needs ${missing.join(", ")} set first`);
    return "needs-config";
  }

  // 6. Held: the shipped compose is not copied, and the note names the images (never a
  //    registry path built from anything else) for the Fix-it card's "Apply the update".
  if (imageChanges.length > 0) {
    markComposeImageChange(destDir, imageChanges);
    writeComposeState(destDir, { installedSha, repoComposeSha, verdict: "image-change" });
    log(`[bundles] ${id}: not updating ${composeRel} — it would also change the image of ${imageChanges.map((c) => c.service).join(", ")}; kept as it is until the owner applies the update`);
    return "image-change";
  }

  copyBundleRefreshItem(appSrc, destDir, composeRel);
  recordInstalledCompose(destDir, repoManifest);
  writeComposeState(destDir, { installedSha: repoComposeSha, repoComposeSha, verdict: "match" });
  clearComposeNeedsConfig(destDir);
  clearComposeImageChange(destDir);
  return "copied";
}

/**
 * True iff the repo package.json declares a dependency NAME absent from the
 * installed bundle's node_modules/ (R1/R2: narrow, added-dep-only; a removed
 * dep or a version-range-only bump must NOT fire a boot-time npm install), OR
 * (C4 Task 3) the dependency IS present but is pinned to an exact semver
 * (`/^\d+\.\d+\.\d+$/`) in the repo package.json and the installed copy's own
 * package.json reports a different version — version-drift on an exact pin
 * must also refresh, since presence-by-name alone would bless a stale
 * install forever. Range-pinned deps stay presence-only: existence of the
 * name is the only thing checked, exactly as before.
 * existsSync(join(nm, depName)) handles @scope/name naturally.
 */
/**
 * Numeric x.y.z comparison for manifest.min_node (the npm_required engine
 * floor — bot-engine 0.82.0 hard-requires Node >= 22.19). True when
 * `current` satisfies `min`. Malformed input fails OPEN (true): a manifest
 * typo must not brick installs; a payload that truly needs the floor still
 * fails honestly at npm/spawn time.
 */
function nodeSatisfiesMin(current, min) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
  };
  const c = parse(current), n = parse(min);
  if (!c || !n) return true;
  for (let i = 0; i < 3; i++) { if (c[i] !== n[i]) return c[i] > n[i]; }
  return true;
}

function bundleNeedsNpmInstall(appSrc, destDir) {
  const pkg = readJsonSafe(join(appSrc, "package.json"), null);
  if (!pkg || !pkg.dependencies || typeof pkg.dependencies !== "object") return false;
  const nodeModules = join(destDir, "node_modules");
  return Object.keys(pkg.dependencies).some((depName) => {
    const depDir = join(nodeModules, depName);
    if (!existsSync(depDir)) return true;
    const pin = pkg.dependencies[depName];
    if (typeof pin === "string" && /^\d+\.\d+\.\d+$/.test(pin)) {
      const installedPkg = readJsonSafe(join(depDir, "package.json"), null);
      if (!installedPkg || installedPkg.version !== pin) return true;
    }
    return false;
  });
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
 *      refresh must never mutate a running container's mounts). A docker bundle
 *      may opt specific code paths in with manifest.refreshFiles (see
 *      manifestRefreshFiles: never .env*, data, or a read-write mount).
 *   2. Re-copies the served PANELS_DIR artifacts (<id>.js, <id>-routes.js),
 *      rmSync-first for determinism, and ensures the PANELS_DIR node_modules
 *      symlink exists (install-parity — an April-era install may predate it).
 *   3. For a docker bundle, manifest.refreshFiles is copied as before. The compose
 *      file itself is NOT part of this version-keyed step: it is caught up on every
 *      boot at any version by catchUpInstalledCompose, which never overwrites an
 *      owner edit and never breaks Start on a missing required key. The running
 *      container keeps the old bind until the bundle is restarted; a Fix-it card
 *      says so (fix-it/detectors/bundle-bind-drift.js).
 *   4. Runs `npm install --omit=dev` in destDir, via the injected runner,
 *      ONLY when an added dependency name triggers it (warn-only; never
 *      throws into the caller).
 *
 * Returns null (caller falls back to the existing missing-only repair) when
 * either manifest is unreadable/missing or the versions are equal. Otherwise
 * returns { oldVersion, newVersion, touched }.
 */
async function refreshVersionedBundle({ id, appSrc, destDir, runner, log = (m) => console.log(m) }) {
  const repoManifest = readJsonSafe(join(appSrc, "manifest.json"), null);
  const installedManifest = readJsonSafe(join(destDir, "manifest.json"), null);
  if (!repoManifest || !installedManifest) return null;

  const oldVersion = installedManifest.version;
  const newVersion = repoManifest.version;
  const bothUndefined = oldVersion === undefined && newVersion === undefined;
  if (bothUndefined || oldVersion === newVersion) return null;

  // Operator opt-out: an INSTALLED manifest carrying `"refresh": false` marks
  // a copy the operator maintains by hand (a fork deployed over a first-party
  // bundle id). Overwriting it with the repo's code silently removes whatever
  // the fork added, so leave it alone and say so on every boot it applies.
  if (installedManifest.refresh === false) {
    console.log(`[bundles] ${id}: installed copy opts out of refresh ("refresh": false) — repo ${newVersion}, installed ${oldVersion}, left as installed`);
    return null;
  }

  const isDocker = !!repoManifest.docker;
  const touched = [];

  // Explicit-include set (R1 MAJOR-4: generalized to cover JS AND Python
  // first-party bundles). R2 MAJOR-2: type-aware restriction — docker-surface
  // bundles get ONLY manifest.json/settings-section.js/server//panel//skills/
  // + validated manifest-declared roots, NEVER config/scripts/templates/src
  // (existing bundles bind-mount exactly those into live containers).
  // package.json/package-lock.json are never bind-mounted into containers, so docker
  // bundles get them too — otherwise a dependency added in a version bump (vaultwarden →
  // @bitwarden/cli) would be "installed" against the OLD package.json (review C6).
  const topFiles = isDocker
    ? ["manifest.json", "settings-section.js", "package.json", "package-lock.json"]
    : ["manifest.json", "package.json", "package-lock.json", "pyproject.toml", "uv.lock", "settings-section.js", "main.py", "run.sh", "config.py"];
  // engine/ + pdf/: tax's calculator, ingest and form filler (its panel imports the
  // installed engine/, so a version bump must ship it with the panel).
  // vendor/ + library/: third-party code a bundle ships pre-built (Studio's SunVox
  // and SoundFont synth) and its data catalogs — code and data the new version
  // needs, refreshed like engine/.
  const dirs = isDocker
    ? ["server", "panel", "skills"]
    : ["server", "panel", "skills", "curriculum", "public", "scripts", "templates", "routes", "config", "src", "engine", "pdf", "vendor", "library"];
  // Never copied for ANY type: docker-compose.yml, Dockerfile, entrypoint.sh,
  // .env*, node_modules/, data/ — simply absent from both lists above. The ONE
  // exception is a docker bundle's explicit opt-in, manifest.refreshFiles
  // (manifestRefreshFiles): named code paths such as its compose file or a
  // read-only-mounted plugin dir — still never .env*, data, node_modules, .git
  // or anything a read-write bind mount reaches.

  // Manifest-declared roots (shared/bundle-declared-paths.js): the bundle contract is
  // manifest-declaration-driven, so any path a manifest names is code by definition.
  // Each is reduced to its first path segment and validated to a single plain segment
  // before any join (R2 minor — same traversal class F-HEALTH-1 fixed for bundleId
  // elsewhere in this file). The install security check reads the same list, so the
  // two can never disagree about what a manifest declares.
  const declaredRoots = bundleDeclaredRoots(repoManifest);

  // manifest.json is the refresh's commit marker: the version it carries is
  // what makes the NEXT boot skip this bundle. It is copied LAST (below), so
  // a copy that throws part-way leaves the installed version stale and the
  // next boot retries the whole refresh instead of blessing a half-copy.
  for (const item of new Set([...topFiles, ...dirs, ...declaredRoots])) {
    if (item === "manifest.json") continue;
    if (copyBundleRefreshItem(appSrc, destDir, item)) touched.push(item);
  }

  // Docker bundles: compose `build:` context dirs (e.g. phone's runner/) are
  // build INPUTS, not bind mounts, so the live-mount rationale above does not
  // apply — without this a version bump never ships the image's source.
  // No automatic rebuild: Extensions Restart/Start runs `up -d --build`.
  if (isDocker) {
    const contexts = composeBuildContexts(appSrc, { manifest: repoManifest, destDir });
    for (const rel of contexts) {
      cpSync(join(appSrc, rel), join(destDir, rel), {
        recursive: true,
        filter: (src) => !BUILD_CONTEXT_SKIP.has(basename(src)),
      });
      touched.push(`build:${rel}`);
    }
    if (contexts.length) {
      console.log(`[bundles] ${id}: build source refreshed (${contexts.join(", ")}) — Restart/Start it in Extensions to rebuild the image`);
    }
    const opted = manifestRefreshFiles(repoManifest, appSrc, destDir).filter((rel) => copyBundleRefreshItem(appSrc, destDir, rel));
    for (const rel of opted) touched.push(`refresh:${rel}`);
    if (opted.length) {
      console.log(`[bundles] ${id}: refreshFiles copied (${opted.join(", ")}) — running containers keep the old files/compose until the bundle is restarted`);
    }
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
  const routesRelPath = resolvePanelRoutesPath(repoManifest);
  if (routesRelPath) {
    const routesSrc = join(destDir, routesRelPath);
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
    // npm_required bundles (vaultwarden: the Bitwarden CLI) install exactly as the install
    // path does — lock file, no lifecycle scripts — and are never blessed half-installed:
    // on failure the installed manifest (the commit marker) keeps the OLD version, so the
    // next boot retries (re-review m4). Still warn-only: boot never hard-fails.
    const required = repoManifest.npm_required === true;
    const npmArgs = required
      ? [existsSync(join(destDir, "package-lock.json")) ? "ci" : "install", "--omit=dev", "--ignore-scripts"]
      : ["install", "--omit=dev"];
    try {
      await runner("npm", npmArgs, { cwd: destDir });
      touched.push(`npm ${npmArgs[0]}`);
    } catch (err) {
      console.warn(`[bundles] npm ${npmArgs[0]} failed for ${id}: ${err.message}`);
      if (required) {
        console.warn(`[bundles] ${id}: left at ${oldVersion} so the next boot retries the dependency install`);
        return { oldVersion, newVersion: oldVersion, touched: [...touched, "npm failed — will retry"] };
      }
    }
  }

  // A version that ADDS an MCP server must register it for existing installs (W2: the
  // workspace bundle gained a server; refresh used to copy server/ and never register it).
  if (repoManifest.server && !repoManifest.server.url) {
    // A file that exists but does not parse is left alone: rewriting it from {} would wipe every other add-on.
    // Like a failed npm_required install, the manifest (commit marker) stays old so the next boot retries.
    const addons = readJsonSafe(MCP_ADDONS_PATH, null) ?? (existsSync(MCP_ADDONS_PATH) ? null : {});
    if (!addons) {
      console.warn(`[bundles] ${id}: ${MCP_ADDONS_PATH} exists but could not be parsed; MCP server not registered, left at ${oldVersion} so the next boot retries`);
      return { oldVersion, newVersion: oldVersion, touched: [...touched, "mcp-addons.json unreadable — will retry"] };
    }
    if (!addons[id]) {
      // No provenance: this boot/update path registers defaults on behalf of no request
      // (`owner` stays false), so the entry gets an empty `ownerSet`.
      addons[id] = mcpAddonEntryFor(repoManifest, null, { bundleDir: destDir });
      writeJsonSafe(MCP_ADDONS_PATH, addons);
      touched.push("mcp-addons entry (restart to load)");
    } else if (typeof addons[id].command === "string" && !addons[id].command.startsWith("/") && addons[id].command.includes("/")) {
      // The update just replaced the bundle's own launcher (./run.sh): re-pin
      // it, since this flow owns that entry (an operator-pinned absolute
      // launcher is left alone — re-pin it with scripts/ops/pin-addon-command.mjs).
      const pin = launcherPin(addons[id].command, destDir);
      if (pin && pin !== addons[id].command_sha256) {
        addons[id] = { ...addons[id], command_sha256: pin };
        writeJsonSafe(MCP_ADDONS_PATH, addons);
        touched.push("mcp-addons launcher re-pinned");
      }
    }
  }

  // Commit marker last — see the include loop above.
  if (copyBundleRefreshItem(appSrc, destDir, "manifest.json")) touched.push("manifest.json");

  console.log(`[bundles] refreshed ${id} ${oldVersion} -> ${newVersion}`);
  return { oldVersion, newVersion, touched };
}

/**
 * Install-time skill copy (both install paths): the same rules as the boot
 * sync, copying from the INSTALLED bundle dir (review L9: that also serves
 * third-party bundles, which have no repo source). Always mode "on": an
 * install is the operator's explicit action, so CROW_SKILL_SYNC (which
 * governs the silent boot pass) does not apply, and a skill the owner had
 * deleted is installed again (review 3). An edited copy already in place is
 * kept, never overwritten.
 */
function installBundleSkills(bundleId, destDir, manifest, job) {
  mkdirSync(SKILLS_DIR, { recursive: true });
  const { lines, kept } = syncBundleSkills({
    id: bundleId, src: destDir, manifest, mode: "on", install: true, skillsDir: SKILLS_DIR,
    recordPath: SKILL_RECORD_PATH, ledger: readSkillLedger(APP_BUNDLES), log: () => {},
  });
  for (const l of lines) {
    if (l.action === "install" || l.action === "refresh" || l.action === "adopt" || l.action === "same") appendLog(job, `Installed skill: ${l.skill}`);
  }
  for (const k of kept) appendLog(job, `Kept your edited copy of skill ${k.skill} (the bundle's version was not applied)`);
}

/**
 * Repair missing bundle UI artifacts for already-installed bundles, and
 * (D1, BH-4) refresh a bundle's installed copy when the repo manifest's
 * version has moved past the installed manifest's version.
 *
 * Prior incident (2026-04-14): the Companion bundle's docker service was migrated
 * from the home server to crow, but ~/.crow/bundles/companion/settings-section.js was
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
/**
 * Boot: save the keychain:true generated keys of extensions installed before their manifest
 * saved them to the keychain (install-hooks backfillKeychainEntries). Values come from the
 * installed .env, else the retained copy, else the MCP entry; never logged.
 */
/**
 * Boot pass (project services Task 12, review M1): every INSTALLED bundle gets the restore an
 * install runs (restoreServicesAfterInstall: service secrets 'extension_removed' → active, then
 * needs_install connections → active / error). A crash between the install record and the
 * install's own restore would otherwise leave the connections paused on an installed bundle.
 * Safe to repeat (both steps touch only paused rows) and never revives 'disconnected'.
 * @returns {Promise<number>} connections restored
 */
export async function restoreInstalledBundleServices({ log = (m) => console.log(`[services] ${m}`) } = {}) {
  let n = 0;
  for (const rec of getInstalled()) {
    const id = rec?.id;
    if (typeof id !== "string" || !isValidBundleId(id)) continue;
    if (isSatelliteEntry(rec)) continue; // hosted on a satellite (SAT-5)
    n += (await restoreServicesAfterInstall(id, { log: (m) => log(`${id}: ${m}`) })).connections;
  }
  return n;
}

export async function backfillBundleKeychain({ log = (m) => console.log(`[keychain] ${m}`) } = {}) {
  let n = 0;
  const addons = readJsonSafe(MCP_ADDONS_PATH, {}) || {};
  for (const rec of getInstalled()) {
    const id = rec?.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
    if (isSatelliteEntry(rec)) continue; // its secrets live on the satellite (SAT-5)
    const manifest = getInstalledFirstManifest(id);
    const keys = keychainGeneratedKeys(manifest);
    if (keys.length === 0) continue;
    let installed = {}, retained = {};
    try { installed = parseEnvText(readFileSync(join(BUNDLES_DIR, id, ".env"), "utf8")); } catch { /* none */ }
    try { retained = parseEnvText(readFileSync(retainedEnvPath(CROW_HOME, id), "utf8")); } catch { /* none */ }
    const entryEnv = addons?.[id]?.env || {};
    const values = {};
    const legacyKeys = legacyFallbackKeys(retained);
    for (const k of keys) {
      const plain = installed[k] || retained[k] || entryEnv[k] || "";
      // A published compose default an old install ran on is never saved (see planGeneratedEnv).
      if (legacyKeys.has(k) && plain === retained[k]) continue;
      // The retained copy only ever holds values Crow generated; anything else was typed.
      if (plain) values[k] = { plain, origin: retained[k] && retained[k] === plain ? "generated" : "typed" };
    }
    n += await backfillKeychainEntries(id, manifest, values, { log });
  }
  return n;
}

export async function repairInstalledBundleAssets({ appBundles = APP_BUNDLES, run: runner = run, skillMode = skillSyncMode(), skillLedger = null, log = (m) => console.log(m), env = process.env, migrateLinked = null } = {}) {
  // This is one boot pass for the compose history lookups: a git that hangs or
  // cannot answer costs ONE timeout per pass, not one per installed bundle.
  beginComposeHistoryPass();
  const repaired = [];
  const errors = [];

  // Add-on walls: a checkout-linked add-on is copied into the Crow home before any
  // add-on starts, and ONLY on a host whose walls are on (the gate is the first
  // statement of migrateLinkedAddons: with the switch unset it reads nothing and
  // changes nothing). Never blocks the rest of the repair.
  try {
    const migrate = typeof migrateLinked === "function"
      ? migrateLinked
      : (await import("../../../scripts/addon-sandbox/migrate-linked.mjs")).migrateLinkedAddons;
    const r = await migrate({ crowHome: CROW_HOME, appRoot: APP_ROOT, dataDir: resolveDataDir(), env, mcpAddonsPath: MCP_ADDONS_PATH, log });
    for (const id of r?.migrated || []) repaired.push(`${id}: moved into the Crow home for its wall`);
    for (const id of r?.repointed || []) repaired.push(`${id}: its own-host URL repointed to its local port`);
    for (const f of r?.failed || []) errors.push({ id: f.id, error: `wall migration: ${f.reason}` });
  } catch (err) {
    errors.push({ id: "*", error: `wall migration: ${err?.message || err}` });
  }
  // The compose catch-up's git lookups run against the checkout `appBundles` comes
  // from (APP_BUNDLES is <repo>/bundles), never against a different constant: a test
  // or an alternate source tree must resolve its own history.
  const repoRoot = dirname(appBundles);
  // Skill sync (bundle-skill-sync.js): what it did per skill, and the copies
  // it kept (the caller notifies the owner once per edited skill per repo hash).
  const skillLines = [];
  const skillsKept = [];
  const ledger = skillLedger || readSkillLedger(appBundles);
  // id -> the INSTALLED manifest's version once this pass is done with that bundle
  // (see the sync at the end: the record's version must follow the installed copy).
  const installedVersions = new Map();

  let installed;
  try {
    installed = getInstalled();
  } catch (err) {
    return { repaired, errors: [{ id: "*", error: `read installed: ${err.message}` }], skillLines, skillsKept };
  }
  if (!Array.isArray(installed) || installed.length === 0) {
    return { repaired, errors, skillLines, skillsKept };
  }

  for (const entry of installed) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!id || !isValidBundleId(id)) continue;
    // Every installed bundle .env holds secrets: tighten legacy 644/777 files at boot.
    try {
      const envP = join(BUNDLES_DIR, id, ".env");
      if (existsSync(envP)) chmodSync(envP, 0o600);
    } catch { /* never block boot repair on a chmod */ }

    const appSrc = join(appBundles, id);
    if (!existsSync(appSrc)) continue; // not a first-party bundle — skip

    // A satellite-hosted bundle (SAT-5) runs on the satellite: nothing is copied here and its
    // mcp-addons satellite entry is never touched; only its skills are synced from this checkout.
    if (isSatelliteEntry(entry)) {
      try {
        const out = syncBundleSkills({
          id, src: appSrc, manifest: readJsonSafe(join(appSrc, "manifest.json"), null),
          mode: skillMode, skillsDir: SKILLS_DIR, recordPath: SKILL_RECORD_PATH, ledger, log,
        });
        skillLines.push(...out.lines);
        skillsKept.push(...out.kept);
      } catch (err) {
        errors.push({ id, error: `skill sync: ${err.message}` });
      }
      continue;
    }

    const destDir = join(BUNDLES_DIR, id);
    const touched = [];
    try {
      mkdirSync(destDir, { recursive: true });

      // Skill sync, on EVERY boot (version bump or not) and BEFORE the
      // refresh's `continue` below (review L9). It reads the INSTALLED
      // manifest's "refresh": false itself (that check otherwise lives only
      // inside refreshVersionedBundle, which runs on a version delta). Its
      // own catch: a skill problem never blocks the bundle's code repair.
      try {
        const out = syncBundleSkills({
          id, src: appSrc, manifest: readJsonSafe(join(appSrc, "manifest.json"), null),
          installedManifest: readJsonSafe(join(destDir, "manifest.json"), null),
          mode: skillMode, skillsDir: SKILLS_DIR, recordPath: SKILL_RECORD_PATH, ledger, log,
        });
        skillLines.push(...out.lines);
        skillsKept.push(...out.kept);
      } catch (err) {
        errors.push({ id, error: `skill sync: ${err.message}` });
      }

      // D1: version-keyed refresh phase, BEFORE the missing-only repair below.
      //
      // Mint-then-refresh (browser CDP gate): a key the manifest flags `mint_if_missing` is
      // ADDED first, so an install made before the key existed has it before any code that
      // reads it is copied in. A failed mint leaves the installed version stale and skips the
      // refresh, so the next boot retries the whole thing instead of shipping half of it.
      const repoManifest = readJsonSafe(join(appSrc, "manifest.json"), null);
      if (mintMissingFlaggedKeys(id, repoManifest, { destDir, crowHome: CROW_HOME, log }) === null) {
        errors.push({ id, error: "could not generate a missing key — refresh skipped, retried on the next boot" });
        continue;
      }
      const refreshed = await refreshVersionedBundle({ id, appSrc, destDir, runner, log });

      // N8-1: the compose catch-up runs at ANY version, on EVERY boot. The release
      // that tightens a bind is a commit to the compose file, not necessarily a
      // manifest bump, so an install whose version already equals the repo's can
      // still be running an old file (the live case this exists for). Runs after the
      // version refresh, whose manifest copy is what the installed `refresh` flag is
      // read from. Its own catch: a compose problem never blocks the code repair.
      try {
        if (repoManifest?.docker) {
          const composeOutcome = await catchUpInstalledCompose({
            id, appSrc, destDir, repoRoot, repoManifest,
            installedManifest: readJsonSafe(join(destDir, "manifest.json"), null),
            runner, log,
          });
          if (composeOutcome === "copied") {
            repaired.push(`${id}: compose updated (restart the bundle to apply its network settings)`);
          }
          // `edited` / `needs-config` / `image-change` / `unknown` are steady states
          // with their own one-time log line (written when the note is created) —
          // repeating them in the boot repair report would nag on every start.
        }
      } catch (err) {
        errors.push({ id, error: `compose refresh: ${err.message}` });
      }

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
    } finally {
      // Read AFTER the refresh/repair above (a `continue` still runs this): the
      // installed manifest is the copy that is actually on disk. A bundle whose
      // copy is missing or unreadable simply has no version to record.
      const version = readJsonSafe(join(destDir, "manifest.json"), null)?.version;
      if (version !== undefined && version !== null && version !== "") installedVersions.set(id, version);
    }
  }

  // installed.json's version must follow the installed copy: the refresh above
  // rewrites the files (and manifest.json) but never the record, so the
  // Extensions page kept showing the version from the first install — and a
  // record left stale by an earlier boot never caught up either.
  try {
    if (installedVersions.size > 0) {
      // Re-read fresh: an install that wrote installed.json during this pass is
      // not in the snapshot from the top of the function and must survive.
      const current = getInstalled();
      const next = [];
      const lines = [];
      for (const rec of current) {
        // A bare "id" string record carries no fields to update.
        if (!rec || typeof rec !== "object" || Array.isArray(rec)) { next.push(rec); continue; }
        const version = installedVersions.get(rec.id);
        if (version === undefined || rec.version === version) { next.push(rec); continue; }
        lines.push(`${rec.id}: installed.json version ${rec.version} -> ${version}`);
        next.push({ ...rec, version });
      }
      if (lines.length > 0) {
        saveInstalled(next); // the one writer: atomic, and it drops the apps catalog cache
        repaired.push(...lines);
      }
    }
  } catch (err) {
    errors.push({ id: "*", error: `installed.json version sync: ${err.message}` });
  }

  return { repaired, errors, skillLines, skillsKept };
}

// Test-only: replace the post-Start/Stop/install re-run of the bind-drift check.
let _bindDriftRecheckForTest = null;
export function _setBindDriftRecheckForTest(fn) { _bindDriftRecheckForTest = fn || null; }

/**
 * Re-run the bind-drift check for ONE bundle after its containers changed (a Start,
 * a stop, an install's `up`): a "restart to apply" card must clear as soon as the
 * binds are in effect, and a stop leaves no bind that could drift. Fire-and-forget —
 * the check is best effort (it never throws), a slow docker must not delay the
 * response, and the card simply stays until the next boot if this does not land.
 * Opens its own db handle so the install job (which has no request db) can call it too.
 */
function rebindDriftCheck(bundleId) {
  if (_bindDriftRecheckForTest) {
    try { _bindDriftRecheckForTest(bundleId); } catch { /* a test seam never throws here */ }
    return;
  }
  setImmediate(async () => {
    let db;
    try {
      const { runBootCheck } = await import("../fix-it/index.js");
      db = createDbClient();
      await runBootCheck(db, "bundle-bind-drift", { only: [bundleId] });
    } catch { /* the card stays until the next boot */ }
    finally { try { db?.close(); } catch { /* already closed */ } }
  });
}

function getInstalled() { return readInstalled(INSTALLED_PATH); }

/** Write installed.json: temp file + rename (bundle-core writeInstalled), so a reader never sees a
 *  torn file (a torn read parses as "nothing installed", and the next save would then write that
 *  back, wiping every entry). */
export function saveInstalled(arr, path = INSTALLED_PATH) {
  writeInstalled(path, arr);
  invalidateAppCatalog(); // every install/remove path writes through here
}

// run / getComposeCmd / the compose and docker runner seams: ../bundle-core.js.
/** The environment every gateway-driven `docker compose` run gets (bundle-core.js composeEnv, with this instance's CROW_HOME). */
export function composeEnv(base = process.env) {
  return coreComposeEnv(base, CROW_HOME);
}


// Test-only: replace the post-install hook runner / the `docker` CLI runner.
let _hookRunnerForTest = null;
export function _setHookRunnerForTest(fn) { _hookRunnerForTest = fn || null; }

// Test-only: seams for the first-admin setup run (script runner, keychain, .env writer).
let _firstAdminSetupDepsForTest = null;
export function _setFirstAdminSetupDepsForTest(d) { _firstAdminSetupDepsForTest = d || null; }

// Test-only: seams for the first-admin INVITE step (fetch, keychain reader, clock).
let _firstAdminInviteDepsForTest = null;
export function _setFirstAdminInviteDepsForTest(d) { _firstAdminInviteDepsForTest = d || null; }

/**
 * Ownership of this bundle's compose project. refusal: another Crow install of the SAME
 * bundle on this host owns it (callers refuse). warning: containers from a legacy path
 * share the project (callers log and proceed, as before this guard existed).
 */
async function composeOwnership(bundleId, bundleDir, manifest) {
  const rel = manifestComposeFile(manifest) || "docker-compose.yml";
  let text = "";
  try { text = readFileSync(join(bundleDir, rel), "utf8"); } catch { return { project: null, refusal: null, warning: null }; }
  const projectDir = join(bundleDir, dirname(rel));
  let envVars = {};
  try { envVars = parseEnvText(readFileSync(join(projectDir, ".env"), "utf8")); } catch { /* no .env */ }
  const runner = dockerRunner();
  const project = await resolveComposeProject({ projectDir, composeText: text, envVars, runner, env: composeEnv() });
  const { owner, unrelated } = await classifyProjectOwners({ project, projectDir, bundleId, crowHome: CROW_HOME, runner });
  return {
    project,
    refusal: owner ? `This extension's containers (compose project "${project}") belong to another Crow install on this host (${owner}): manage them from there.` : null,
    warning: unrelated.length ? `compose project "${project}" also has containers started from ${unrelated.join(", ")} (legacy path) — continuing` : null,
  };
}
/** Read-only, for operators and the pre-merge smoke: the guard's verdict for an installed bundle. */
export async function composeOwnershipCheck(bundleId) {
  return composeOwnership(bundleId, join(BUNDLES_DIR, bundleId), getInstalledFirstManifest(bundleId));
}

// runCompose / runComposeTeardown / composeServiceRunning: ../bundle-core.js, bound here to
// this instance's CROW_HOME (the same value composeEnv() gives every compose run).
const runCompose = (composeArgs, opts = {}) => coreRunCompose(composeArgs, { ...opts, crowHome: CROW_HOME });
const runComposeTeardown = (args, opts) => coreRunComposeTeardown(args, { ...opts, crowHome: CROW_HOME });
const blankHardFailKeys = (cwd, composeRel) => coreBlankHardFailKeys(cwd, composeRel, CROW_HOME);
const composeServiceRunning = (bundleDir) => coreComposeServiceRunning(bundleDir, { crowHome: CROW_HOME });

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
  // mcp-addons.json carries MCP children's secrets (generated keys reach their MCP entry
  // here): always written atomically at mode 600, whatever the umask or the old file's mode.
  if (path === MCP_ADDONS_PATH) { writePrivateFile(path, JSON.stringify(data, null, 2)); return; }
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * panels.json comes in two shapes and the loader (panel-registry.js
 * loadExternalPanels) accepts both: a bare array of ids, or an object
 * `{ enabled: [...] }` (crow's own file is the object form). The installer used
 * to assume the bare array and threw `includes is not a function` on the object
 * form. These helpers read either shape and write back the SAME shape, keeping
 * any other keys an object-form file carries.
 */
function readPanelsConfig(path) {
  const raw = readJsonSafe(path, null);
  if (Array.isArray(raw)) return { raw, list: raw.filter((x) => typeof x === "string"), objectForm: false };
  if (raw && typeof raw === "object") {
    const list = Array.isArray(raw.enabled) ? raw.enabled.filter((x) => typeof x === "string") : [];
    return { raw, list, objectForm: true };
  }
  return { raw: null, list: [], objectForm: false };
}

function writePanelsConfig(path, { raw, objectForm }, list) {
  writeJsonSafe(path, objectForm ? { ...raw, enabled: list } : list);
}

/** Enable a panel id in panels.json (either shape). Returns true when the file changed. */
export function addPanelEnabled(panelId, path = PANELS_CONFIG_PATH) {
  const cfg = readPanelsConfig(path);
  if (cfg.list.includes(panelId)) return false;
  writePanelsConfig(path, cfg, [...cfg.list, panelId]);
  return true;
}

/** Remove a panel id from panels.json (either shape). Returns true when the file changed. */
export function removePanelEnabled(panelId, path = PANELS_CONFIG_PATH) {
  if (!existsSync(path)) return false;
  const cfg = readPanelsConfig(path);
  if (!cfg.list.includes(panelId)) return false;
  writePanelsConfig(path, cfg, cfg.list.filter((p) => p !== panelId));
  return true;
}

/**
 * The mcp-addons.json entry for a manifest that declares `server` — the single shape both
 * install (either branch) and the version refresh write. envKeys values come only from an
 * install request; every truthy env_vars default rides along (unchanged install behaviour).
 */
// `reqEnv` may carry generated values (runInstallJob passes them): only keys the manifest
// lists in server.envKeys reach the entry, so a generated secret reaches its own MCP child
// through this instance's mcp-addons.json (mode 600) and never the shared gateway .env.
/** Generated values an MCP child may get: never a stored hash (store_as), which is useless
 * to the child and must not look like the secret. */
function generatedPlainForMcp(manifest, generated) {
  const hashed = new Set((manifest?.env_vars || []).filter((v) => v && v.store_as).map((v) => v.name));
  return Object.fromEntries(Object.entries(generated || {}).filter(([k]) => !hashed.has(k)));
}

export function mcpAddonEntryFor(manifest, reqEnv = null, { bundleDir = null, edited = null, generatedKeys = [], owner = false, priorEntry = null, bundleId = null } = {}) {
  const env = {};
  const fromRequest = new Set();
  for (const key of manifest?.server?.envKeys || []) {
    if (reqEnv && reqEnv[key]) { env[key] = reqEnv[key]; fromRequest.add(key); }
  }
  for (const v of manifest?.env_vars || []) if (v.default && !env[v.name]) env[v.name] = v.default;
  // Which values the OWNER entered (never a manifest default): the form's edited list,
  // plus a requested value that differs from its manifest default and from every default a
  // version of the manifest has shipped (a generated key is minted by Crow, not typed).
  // `owner` is the caller's proof that this write is the local owner's own request — a
  // caller that passes nothing gets no provenance at all (fail closed), and the wall's
  // host/bind rules read only owner-set values.
  // The array is ALWAYS written, empty included: an entry with no `ownerSet` reads as a
  // legacy one on the wall side, where every non-default value counts as owner-typed.
  // A reinstall over an existing entry keeps the claims on values it did not change (the
  // same rule Configure uses); only the owner's own request adds new ones.
  // A generated key is minted by Crow, never typed, so it is never carried either.
  const generatedSet = new Set(Array.isArray(generatedKeys) ? generatedKeys : []);
  const carried = carriedOwnerKeys(priorEntry, env, manifest, bundleId || manifest?.id || null).filter((k) => !generatedSet.has(k));
  const fresh = owner === true
    ? ownerSetFor({ env, fromRequest, edited, generatedKeys, manifest, priorEnv: null, bundleId: null })
    : [];
  const ownerSet = [...new Set([...carried, ...fresh])].sort();
  // A launcher outside the root-owned system dirs (a ./run.sh in the bundle)
  // is started only when pinned; the operator's install/update click is the
  // consent for in-bundle code, so the flow that writes the entry pins it.
  const pin = bundleDir ? launcherPin(manifest.server.command, bundleDir) : null;
  return { command: manifest.server.command, args: manifest.server.args || [], ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(pin ? { command_sha256: pin } : {}), ownerSet };
}

/**
 * The entry an install writes: `mcpAddonEntryFor`'s, pinned to one exact version
 * when this host's walls are on (scripts/addon-sandbox/pin.mjs).
 *
 * With the walls off nothing is resolved and the entry is written unchanged.
 * A launcher that cannot be pinned to one version fails the install, and no
 * entry is written: a walled add-on must not run tomorrow whatever the registry
 * serves then.
 */
async function pinnedMcpEntry({ manifest, reqEnv, generated, ownerEnv, editedEnv, destDir, bundleId, priorEntry, job }) {
  const built = mcpAddonEntryFor(manifest, { ...(reqEnv || {}), ...generatedPlainForMcp(manifest, generated) }, {
    bundleDir: destDir,
    edited: ownerEnv !== null ? editedEnv : null,
    owner: ownerEnv !== null,
    generatedKeys: Object.keys(generated || {}),
    priorEntry,
    bundleId,
  });
  let entry = built;
  try {
    entry = await pinEntryIfWalled(built, { env: process.env });
  } catch (err) {
    if (!(err instanceof PinRefused)) throw err;
    appendLog(job, `Could not pin ${bundleId} to one version: ${err.message}`);
    throw new Error(`could not pin ${bundleId} to one version: ${err.message}`);
  }
  if (JSON.stringify(entry) !== JSON.stringify(built)) appendLog(job, `Pinned ${bundleId} to one exact version`);
  return entry;
}

/**
 * The owner claims of a prior entry that survive a rewrite: its own `ownerSet` (or, for a
 * legacy entry, the past-defaults rule materialised once) minus every key whose value the
 * rewrite changes.
 */
function carriedOwnerKeys(priorEntry, nextEnv, manifest, bundleId) {
  if (!priorEntry || typeof priorEntry !== "object") return [];
  const priorEnv = priorEntry.env && typeof priorEntry.env === "object" ? priorEntry.env : {};
  const base = Array.isArray(priorEntry.ownerSet)
    ? priorEntry.ownerSet
    : legacyOwnerSet(priorEnv, manifest, pastDefaultsForEntry(bundleId));
  return base.filter((k) => typeof k === "string"
    && Object.prototype.hasOwnProperty.call(nextEnv || {}, k)
    && String(priorEnv[k] ?? "") === String(nextEnv[k]));
}

/**
 * `registry/addon-past-defaults.json` `.defaults`, read lazily (a missing or unreadable
 * file means "no past defaults"). It holds every `env_vars[].default` each manifest has
 * ever shipped, which is how an entry written before `ownerSet` existed is judged.
 */
function pastDefaultsForEntry(bundleId) {
  if (!bundleId) return {};
  try {
    const doc = JSON.parse(readFileSync(new URL("../../../registry/addon-past-defaults.json", import.meta.url), "utf8"));
    const defaults = doc && typeof doc === "object" ? doc.defaults : null;
    return defaults && typeof defaults === "object" ? defaults[bundleId] || {} : {};
  } catch { return {}; }
}

/**
 * The legacy seed for an entry written before `ownerSet` existed. Without a manifest object
 * there is nothing to judge a value against, so it seeds nothing (fail closed).
 */
function legacyOwnerSet(priorEnv, manifest, pastDefaults) {
  if (!manifest || typeof manifest !== "object") return [];
  return legacyOwnerKeys(priorEnv, manifest, pastDefaults);
}

/**
 * Whether ONE env value was typed by the owner, or merely written by the server.
 *
 * - a key the server filled (`injected`: a generated secret, a `previous_key` slot the
 *   Configure route carried over) is never owner-typed;
 * - a key in the form's `edited` list is owner-typed;
 * - anything else is the form re-sending a filled field, so it counts only when the
 *   manifest is a real object AND declares a default for the key AND this value differs
 *   from that default AND from every default any version has shipped. A manifest
 *   default is not a choice; neither is the absence of one (`manifest === null` can never
 *   make a key owner-typed).
 */
function isOwnerTyped(key, value, { editedSet = new Set(), manifest = null, pastDefaults = {}, injected = new Set() } = {}) {
  if (injected.has(key)) return false;
  if (editedSet.has(key)) return true;
  if (!manifest || typeof manifest !== "object") return false;
  const defaults = new Map((manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && v.default !== undefined && v.default !== null)
    .map((v) => [v.name, String(v.default)]));
  if (!defaults.has(key)) return false;
  const text = String(value);
  if (defaults.get(key) === text) return false;
  const past = pastDefaults && Object.prototype.hasOwnProperty.call(pastDefaults, key) ? pastDefaults[key] : null;
  const known = Array.isArray(past) ? past.map(String) : [];
  return !known.includes(text);
}

/**
 * The sorted, unique `ownerSet` for an entry being written.
 *
 * `fromRequest` holds the keys that came from the install request (never a manifest
 * default). `priorEnv` seeds a LEGACY entry (one with no `ownerSet`): a value that equals
 * no default the manifest has ever shipped was owner-entered.
 */
function ownerSetFor({ env, fromRequest = new Set(), edited = null, generatedKeys = [], injected = [], manifest, priorEnv, bundleId }) {
  const editedSet = new Set(Array.isArray(edited) ? edited : []);
  const injectedSet = new Set([
    ...(Array.isArray(generatedKeys) ? generatedKeys : []),
    ...(Array.isArray(injected) ? injected : []),
  ]);
  const pastDefaults = pastDefaultsForEntry(bundleId);
  const owner = new Set(priorEnv ? legacyOwnerSet(priorEnv, manifest, pastDefaults) : []);
  for (const key of Object.keys(env || {})) {
    // A manifest default that reached `env` on its own is not the owner's.
    if (!fromRequest.has(key)) continue;
    if (isOwnerTyped(key, env[key], { editedSet, manifest, pastDefaults, injected: injectedSet })) owner.add(key);
  }
  return [...owner].sort();
}

/**
 * Keys Configure may push into an MCP entry. OPT-IN (review C1): only a manifest whose server declares
 * `configureEnv: "envKeys-only"` is filtered. kodi/media/tax read secrets from process.env that they do
 * not list in envKeys, so filtering everyone would silently break their Configure.
 */
function mcpForwardableKeys(manifest) {
  if (!manifest || manifest.server?.configureEnv !== "envKeys-only") return null; // unchanged behaviour
  const listed = new Set(manifest.server?.envKeys || []);
  const blocked = new Set((manifest.env_vars || []).filter((v) => v && (v.secret === true || v.generate) && !listed.has(v.name)).map((v) => v.name));
  return (k) => !blocked.has(k);
}

/**
 * Push env values into the add-on's mcp-addons.json entry.
 *
 * MCP children are spawned with the add-on base allowlist, the keys the bundle's registry
 * entry declares, the storage env the four storage-reading bundles keep, and then
 * (config.env||{}) from mcp-addons.json (addon-env.js, proxy.js) — never the gateway's whole
 * environment, and they never read bundles/<id>/.env. Before this,
 * mcp-addons env was only ever written at install time, so post-install
 * configuration silently did nothing (home-assistant would stay dead no matter
 * how carefully you filled in HA_URL/HA_TOKEN).
 *
 * @returns {boolean} true if the add-on registers an MCP server and the file was written
 */
export function applyEnvToMcpAddons(bundleId, envVars, path = MCP_ADDONS_PATH, manifest = null, { edited = null, injected = [], owner = false } = {}) {
  const mcpAddons = readJsonSafe(path, {});
  const entry = mcpAddons[bundleId];
  if (!entry) return false; // not an MCP add-on — nothing to configure
  const allowed = mcpForwardableKeys(manifest);
  const priorEnv = { ...(entry.env || {}) };
  const merged = { ...(entry.env || {}) };
  // Skip falsy values: proxy.js merges the child's entry env last (over the base allowlist
  // and the declared passthrough), so a blank here would SHADOW a working ambient value that
  // the bundle's registry entry declares rather than clear it. The two
  // install-time writers of this file (see the mcp_server registration paths) guard the
  // same way. Clearing a value stays the .env file's job.
  const written = [];
  for (const [k, v] of Object.entries(envVars || {})) {
    if (v && (!allowed || allowed(k))) { merged[k] = v; written.push(k); }
  }
  entry.env = merged;
  // Provenance for the wall's host/bind rules: only a value the OWNER typed counts, and only
  // when this save is the local owner's own request (`owner`) — anyone else's write proves
  // nothing, so it neither adds a key nor leaves a stale claim on one it rewrote. A legacy
  // entry is seeded from the past-defaults rule.
  if (written.length > 0) {
    const isOwner = owner === true;
    const editedSet = new Set(Array.isArray(edited) ? edited : []);
    const injectedSet = new Set(Array.isArray(injected) ? injected : []);
    const pastDefaults = pastDefaultsForEntry(bundleId);
    // A legacy entry (no `ownerSet`) is materialised first, whoever saves: leaving it
    // legacy would let a non-owner's new value count as owner-typed on the wall side.
    const next = new Set(Array.isArray(entry.ownerSet) ? entry.ownerSet : legacyOwnerSet(priorEnv, manifest, pastDefaults));
    for (const k of written) {
      // A non-owner save drops the claim only on a value it CHANGED: the form re-sends every
      // filled field, and an unchanged value is still the one the owner typed.
      if (!isOwner) { if (String(priorEnv[k] ?? "") !== String(merged[k])) next.delete(k); continue; }
      if (isOwnerTyped(k, merged[k], { editedSet, manifest, pastDefaults, injected: injectedSet })) next.add(k);
    }
    const sorted = [...next].sort();
    // Always written, empty included (an absent list reads as a legacy entry).
    entry.ownerSet = sorted;
  }
  mcpAddons[bundleId] = entry;
  writeJsonSafe(path, mcpAddons);
  return true;
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
  for (const [k, v] of Object.entries(kvPairs)) lines.push(`${k}=${encodeEnvValue(v)}`);
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

// validateComposeFile (the compose text check) and HOST_NETWORK: ../bundle-core.js.

/** What the owner consented to at install, kept on the installed.json record. */
function consentRecord(manifest, consentVerified) {
  // Always written (also for a bundle that asked for nothing), so a missing record can only
  // mean "installed before this was kept", never "a bundle that asked for nothing".
  if (!manifestRequiresConsent(manifest)) return { consent: { verified: false, privileged: false, consent_required: false } };
  return { consent: { verified: !!consentVerified, privileged: manifest?.privileged === true, consent_required: manifest?.consent_required === true } };
}

/**
 * The manifest + consent a later `compose up` (Start, recreate) is checked with. Consent
 * is the owner's, given at install and kept on the installed record, and covers only what
 * the manifest asked for THEN (a refresh that makes a bundle privileged does not inherit
 * it). A peer instance's request never carries it. A record from before this was kept
 * (no `consent` field) keeps its installed manifest's flags: it was installed through the
 * consent gate of its time.
 */
function startConsent(bundleId, { crossHost = false } = {}) {
  // Trust flags never come from the installed copy: its folder can be mounted into the
  // bundle's own container. They come from the reviewed repo manifest (privileged,
  // consent_required, origin, inference), capped by what the owner consented to.
  const installed = getInstalledFirstManifest(bundleId) || {};
  const repo = getManifest(bundleId);
  const trust = {
    privileged: repo?.privileged === true,
    consent_required: repo?.consent_required === true,
    origin: repo ? repo.origin : "community",
    inference: repo?.inference === true,
    // What the reviewed manifest declares the containers need (GPU, shm, shared env
    // files): always set from the repo, so an installed copy's own claim never survives.
    host_grants: repo && repo.origin !== "community" ? normalizeHostGrants(repo.host_grants) : null,
    id: bundleId,
  };
  const manifest = { ...installed, ...trust };
  if (!manifestRequiresConsent(manifest) || crossHost) return { manifest, consentVerified: false };
  const rec = getInstalled().find((i) => i.id === bundleId);
  if (!rec) return { manifest, consentVerified: false };
  if (!rec.consent) return { manifest, consentVerified: true }; // installed before consent was kept: the repo flags, as of then
  if (rec.consent.verified !== true) return { manifest, consentVerified: false };
  return {
    manifest: { ...manifest, privileged: trust.privileged && rec.consent.privileged === true, consent_required: trust.consent_required && rec.consent.consent_required === true },
    consentVerified: true,
  };
}

export { startConsent as _startConsentForTest, consentRecord as _consentRecordForTest };

/**
 * Recreate one installed bundle's containers through the same guards a Start runs — the ONE
 * path every non-interactive recreate uses (the shared-storage re-apply and the first-admin
 * "after" step). It never throws: the caller gets a plain reason and reports it.
 *
 * The order is Start's: ownership (never another install's containers), the consent + compose
 * safety check on what Compose will apply NOW (textCheck: false — an operator's override is
 * part of that model, and the installed bundle was consented to at install), then
 * `up -d --force-recreate` so the container really takes the new environment.
 *
 * It is never called for a peer request (no request reaches it: both callers are local) and
 * never for a satellite (that bundle's containers run on another instance's host).
 *
 * @param {string} bundleId
 * @returns {Promise<{ok: true, recreated: boolean} | {ok: false, code: string, reason: string}>}
 */
async function recreateBundleGuarded(bundleId) {
  if (!bundleId || !isValidBundleId(bundleId)) return { ok: false, code: "invalid_bundle", reason: "That is not a valid bundle id." };
  const entry = getInstalled().find((i) => i && i.id === bundleId);
  if (!entry) return { ok: false, code: "not_installed", reason: `Bundle '${bundleId}' is not installed` };
  if (isSatelliteEntry(entry)) {
    return { ok: false, code: "satellite", reason: `Bundle '${bundleId}' runs on another instance, so this one cannot restart it` };
  }
  const orchRefusal = bundleOrchestrationRefusal(bundleId);
  if (orchRefusal) return { ok: false, code: orchRefusal.code || "orchestration_refused", reason: orchRefusal.error };
  const bundleDir = join(BUNDLES_DIR, bundleId);
  // No compose file: an MCP-server or skill-only bundle has no containers to recreate.
  if (!existsSync(join(bundleDir, "docker-compose.yml"))) return { ok: true, recreated: false };
  try {
    const own = await composeOwnership(bundleId, bundleDir, getInstalledFirstManifest(bundleId));
    if (own.refusal) return { ok: false, code: "compose_project_foreign", reason: own.refusal };
    if (own.warning) console.warn(`[bundles] ${bundleId} recreate: ${own.warning}`);
    const sc = startConsent(bundleId);
    const gate = await checkBundleCompose(bundleDir, { bundleId, manifest: sc.manifest, consentVerified: sc.consentVerified, textCheck: false });
    if (!gate.valid) return { ok: false, code: "compose_security_check", reason: `Security check failed: ${gate.reason}` };
    await runCompose(["up", "-d", "--force-recreate"], { cwd: bundleDir });
    return { ok: true, recreated: true };
  } catch (err) {
    return { ok: false, code: "compose_failed", reason: String((err && (err.stderr || err.message)) || "docker compose up failed").trim() };
  }
}
export { recreateBundleGuarded as _recreateBundleGuardedForTest };

// Follow-up B: who may allow a folder outside Crow's home (the owner at this machine's own
// dashboard), and the folders each check may admit.
let _ownerCheckForTest = null;
export function _setOwnerCheckForTest(fn) { _ownerCheckForTest = fn || null; }
async function isLocalOwner(req) {
  if (_ownerCheckForTest) return !!(await _ownerCheckForTest(req));
  return isLocalPasswordSession(req);
}
const dataDirsForGrants = () => [...new Set([resolveDataDir(), join(CROW_HOME, "data")])];
/** The folders outside Crow's home a check of this bundle may admit, and other bundles'. */
function grantRootsFor(bundleId, bundleDir, { exclude = null } = {}) {
  const home = process.env.HOME || homedir();
  try { migrateGrants({ crowHome: CROW_HOME, dataDirs: dataDirsForGrants(), home, exclude }); } catch (err) {
    console.warn(`[bundles] folder-grant migration: ${err.message}`); // no grants then: fail closed
  }
  return {
    operatorRoots: activeRoots(bundleId, { crowHome: CROW_HOME, bundleDir, home }),
    otherRoots: otherBundlesRoots(bundleId, { crowHome: CROW_HOME, home }),
  };
}
/**
 * A value Compose could turn into a host path outside the bundle folder: absolute or ~/,
 * a ../ segment, or an interpolation ($X, ${X}). A URL, a time zone, a token or ./sub stays
 * where it is. Non-owners may not set such a value for a setting the compose file uses.
 */
export function reachesHostPath(v) {
  const t = String(v ?? "").replace(/\$\$/g, ""); // $$ is a literal $ to Compose
  return /^[\/~]/.test(t) || /(^|[\/])\.\.([\/]|$)/.test(t) || /\$\{?[A-Za-z_]/.test(t);
}
/**
 * A folder two extensions share may be mounted only as itself. An extension that already
 * mounts something INSIDE the folder was checked before the share existed, and Docker
 * restarts it without a check, so the new extension's container could first swap that
 * subfolder for a symlink. Such a grant is refused, in either install order (the other
 * order is refused by the check itself). Reads the compose model of each other extension
 * holding that same live folder; an unreadable one refuses (fail closed).
 * @returns {Promise<string|null>} why the folder can't be granted
 */
async function sharedFolderConflict(bundleId, real) {
  const home = process.env.HOME || homedir();
  const all = readGrants(CROW_HOME);
  const inside = (p, root) => p !== root && p.startsWith(root.endsWith("/") ? root : `${root}/`);
  for (const id of Object.keys(all)) {
    if (id === bundleId || id.startsWith("_") || !isValidBundleId(id)) continue;
    const dir = join(BUNDLES_DIR, id);
    if (!activeRoots(id, { crowHome: CROW_HOME, bundleDir: dir, home, grants: all }).some((r) => resolveHostPath(r) === real)) continue;
    const loaded = await loadComposeModel(dir, { env: composeEnv(), runConfig: runComposeConfig });
    if (loaded.error || !loaded.model) return `the extension ${id} was allowed the same folder, and its compose file could not be read`;
    const sources = [];
    for (const svc of Object.values(loaded.model.services || {})) for (const v of (svc && svc.volumes) || []) if (v?.type === "bind" && typeof v.source === "string") sources.push(v.source);
    for (const v of Object.values(loaded.model.volumes || {})) if (typeof v?.driver_opts?.device === "string") sources.push(v.driver_opts.device);
    if (sources.some((src) => inside(resolveHostPath(src), real))) {
      return `the extension ${id} mounts a folder inside it (two extensions may share a folder only when neither mounts a folder inside it)`;
    }
  }
  return null;
}
/** Remove the grants sharedFolderConflict refuses; `refused[key]` says why. */
async function dropSharedFolderConflicts(bundleId, grants, refused) {
  for (const [k, g] of Object.entries(grants)) {
    const why = await sharedFolderConflict(bundleId, g.real);
    if (why) { delete grants[k]; refused[k] = why; }
  }
}

/**
 * Before an install copies a bundle over an existing folder: back up what the copy and the
 * .env writes will touch, so an install refused before its containers start leaves the
 * earlier install as it was (its code, compose file and .env), never half-replaced and
 * never deleted (its data and secrets live there). A fresh install's folder is removed.
 * node_modules is not backed up (dependencies, rebuilt by npm): one the install created is
 * removed. `settle()` restores unless `commit()` ran first.
 */
export function snapshotInstallDir(sourceDir, destDir, { backupRoot }) {
  let done = false;
  if (!existsSync(destDir)) {
    return { commit() { done = true; }, settle() { if (!done) { done = true; rmSync(destDir, { recursive: true, force: true }); } } };
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = mkdtempSync(join(backupRoot, "install-"));
  const saved = [];
  const added = [];
  const present = (r) => { try { return lstatSync(join(destDir, r)); } catch { return null; } };
  const save = (r) => { saved.push(r); cpSync(join(destDir, r), join(backup, r), { recursive: true, verbatimSymlinks: true }); };
  const visit = (rel) => {
    let ents = [];
    try { ents = readdirSync(join(sourceDir, rel), { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const r = rel ? join(rel, ent.name) : ent.name;
      if (r === "node_modules") continue;
      const st = present(r);
      if (!st) added.push(r);
      else if (ent.isDirectory() && st.isDirectory()) visit(r);
      else save(r);
    }
  };
  visit("");
  if (!saved.includes(".env") && !added.includes(".env")) { if (present(".env")) save(".env"); else added.push(".env"); }
  if (!present("node_modules")) added.push("node_modules");
  return {
    commit() { done = true; rmSync(backup, { recursive: true, force: true }); },
    settle() {
      if (done) return;
      done = true;
      // Never through a link: a container with the bundle folder mounted read-write may have
      // swapped a folder on the way for a symlink to a host folder since the snapshot.
      const realParents = (r) => {
        let cur = destDir;
        for (const part of [".", ...dirname(r).split("/").filter((x) => x && x !== ".")]) {
          if (part !== ".") cur = join(cur, part);
          let st;
          try { st = lstatSync(cur); } catch { return part !== "."; } // gone below destDir: recreated by cp
          if (!st.isDirectory() || st.isSymbolicLink()) return false;
        }
        return true;
      };
      for (const r of added) if (realParents(r)) rmSync(join(destDir, r), { recursive: true, force: true });
      for (const r of saved) {
        if (!realParents(r)) continue;
        rmSync(join(destDir, r), { recursive: true, force: true });
        cpSync(join(backup, r), join(destDir, r), { recursive: true, verbatimSymlinks: true });
      }
      rmSync(backup, { recursive: true, force: true });
    },
  };
}
export function _migrateGrantsForTest() { return migrateGrants({ crowHome: CROW_HOME, dataDirs: dataDirsForGrants(), home: process.env.HOME || homedir() }); }

// Test-only: replace `docker compose config` (the model the shared check reads).
let _composeConfigRunnerForTest = null;
export function _setComposeConfigRunnerForTest(fn) { _composeConfigRunnerForTest = fn || null; }
async function runComposeConfig(args, { cwd, env }) {
  if (_composeConfigRunnerForTest) return _composeConfigRunnerForTest(args, { cwd, env });
  const compose = await getComposeCmd();
  return run(compose.cmd, [...compose.prefix, ...args], { cwd, env, timeout: 60_000 });
}

/**
 * THE install security check, shared by every path that runs `docker compose up` on a
 * bundle: install (single + collection, via runInstallJob), Start/recreate, and the
 * shared-storage re-apply. `textCheck` (install only) also checks the file as shipped —
 * e.g. no extra compose files; at Start an operator's own override is part of the model
 * that is checked instead. The model check reads what Compose will actually apply.
 */
export async function checkBundleCompose(bundleDir, { bundleId, manifest, consentVerified = false, textCheck = true, operatorRoots } = {}) {
  if (textCheck) {
    const t = validateComposeFile(join(bundleDir, "docker-compose.yml"), bundleId, { manifest, consentVerified });
    if (!t.valid) return t;
  }
  const loaded = await loadComposeModel(bundleDir, { env: composeEnv(), runConfig: runComposeConfig });
  if (loaded.error) return { valid: false, reason: loaded.error };
  // Everything the bundle ships (settings-section.js, run.sh, src/ …) is code or config the
  // gateway may load: never mountable read-write. (compose-guard.js also refuses
  // settings-section.js and the manifest-declared compose/panel paths on its own, for the
  // paths that never build this list: the gpu-orchestrator, the preview renderer, a satellite.)
  let shipped = null;
  try { shipped = new Set(readdirSync(join(APP_BUNDLES, bundleId || basename(bundleDir)))); } catch { /* not in the repo */ }
  // Folders outside Crow's home: given by the install (its owner-typed folders, nothing
  // from .env or a record), else the bundle's live grants (Start, shared-storage re-apply).
  const id = bundleId || basename(bundleDir);
  const g = grantRootsFor(id, bundleDir, { exclude: operatorRoots !== undefined ? id : null });
  const roots = operatorRoots !== undefined ? operatorRoots : g.operatorRoots;
  return checkComposeModel(loaded.model, { bundleDir, manifest, consentVerified, ctx: guardCtx({ crowHome: CROW_HOME, dataDir: resolveDataDir(), appRoot: APP_ROOT, shipped, operatorRoots: roots, otherRoots: g.otherRoots, home: process.env.HOME || homedir() }) });
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
      if (HOST_NETWORK.test(content)) caps.push("host networking");
      if (/NET_ADMIN/.test(content)) caps.push("NET_ADMIN (modify firewall)");
      if (/NET_RAW/.test(content)) caps.push("NET_RAW (raw sockets)");
      if (/SYS_ADMIN/.test(content)) caps.push("SYS_ADMIN (system administration)");
      if (/SYS_PTRACE/.test(content)) caps.push("SYS_PTRACE (process tracing)");
      if (/^\s*["']?privileged["']?\s*:\s*["']?true\b/im.test(content)) caps.push("full privileged mode");
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

// --- Add-on walls: what the install modal and the add-on page say ---

/**
 * The past defaults the provenance rule needs, read once from the checkout.
 * A missing or unreadable file is `{}`: no owner value is then mistaken for a
 * past default, which only makes the rule stricter.
 */
let _addonPastDefaults = null;
function addonPastDefaults() {
  if (_addonPastDefaults) return _addonPastDefaults;
  try {
    const doc = JSON.parse(readFileSync(join(APP_ROOT, "registry", "addon-past-defaults.json"), "utf8"));
    _addonPastDefaults = doc && typeof doc.defaults === "object" && doc.defaults ? doc.defaults : {};
  } catch {
    _addonPastDefaults = {};
  }
  return _addonPastDefaults;
}

/** The host summary codes that mean no add-on runs walled on this computer. */
const WALLS_OFF_CODES = new Set(["kill-switch", "no-bwrap", "host-off"]);

/**
 * Whether walls are on for this host. The host summary decides: the per-host
 * default, the kill switch and whether this computer can run a wall at all
 * (the bwrap probe), never the default alone.
 */
export function addonWallsOnHere(env = process.env, { probe } = {}) {
  const { code } = addonWallStatus({ env, probe, lang: "en", entries: [] });
  return !WALLS_OFF_CODES.has(code);
}

/**
 * The two wall fields a consent-challenge answer carries.
 *
 * `sandbox_line` is built from the MANIFEST-ONLY profile (no owner values), so a
 * field the owner has not filled in yet reads "the address you enter below". A
 * profile that cannot be built gives null: an install never shows a guess.
 * `sandbox_state` is the host summary sentence, and only while walls are not on
 * for this host — on a walled host the line speaks for itself.
 *
 * @returns {{sandbox_line: {en:string, es:string}|null, sandbox_state: {en:string, es:string}|null}}
 */
export function addonWallConsentFields(bundleId, manifest, env = process.env, { probe } = {}) {
  const wallsOn = addonWallsOnHere(env, { probe });
  let line = null;
  if (manifest && manifest.server) {
    try {
      const profile = profileFor({
        id: bundleId,
        entry: {},
        appBundlesDir: APP_BUNDLES,
        installedBundlesDir: BUNDLES_DIR,
        pastDefaultsAll: addonPastDefaults(),
      });
      const opts = {
        walled: wallsOn,
        pendingHostFields: pendingHostFields(manifest, profile),
        residuals: isStorageEnvConsumer(bundleId) ? [{ kind: "storage" }] : [],
      };
      line = { en: sandboxLine(profile, "en", opts), es: sandboxLine(profile, "es", opts) };
    } catch {
      line = null;
    }
  }
  const state = wallsOn
    ? null
    : {
      en: addonWallStatus({ env, probe, lang: "en", entries: [] }).sentence,
      es: addonWallStatus({ env, probe, lang: "es", entries: [] }).sentence,
    };
  return { sandbox_line: line, sandbox_state: state };
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
// Instance paths are on it too: a (community) manifest that declares
// CROW_DATA_DIR must never repoint, re-comment or reload the gateway's own.
const GATEWAY_ENV_DENYLIST = new Set([
  "CROW_DASHBOARD_PUBLIC", "NODE_OPTIONS", "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  ...PINNED_PATH_ENV_KEYS,
  // The add-on wall switches are the operator's, set in the gateway's unit only:
  // a bundle manifest declaring one must never write it into the gateway's .env.
  ...ADDON_WALL_SWITCH_KEYS,
]);

function propagateEnvToGateway(envVars) {
  if (!envVars || typeof envVars !== "object" || Object.keys(envVars).length === 0) return false;
  if (!existsSync(APP_ENV_PATH)) return false;

  const before = readFileSync(APP_ENV_PATH, "utf8");
  let content = before;

  for (const [key, rawValue] of Object.entries(envVars)) {
    // Belt-and-braces only. The real gates are upstream: callers pass ONLY the
    // manifest-declared keys (declaredEnvSubset) and the routes REJECT bad
    // keys / multi-line values with 400 invalid_env (findInvalidEnv). Here: a
    // key is interpolated into a RegExp, so it must be a plain env name; a
    // value is one line; and a few gateway-control keys are never writable
    // from a bundle, whatever a (community) manifest declares.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (GATEWAY_ENV_DENYLIST.has(key)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue).replace(/[\r\n\0]/g, "");
    if (value === "") continue;
    // Match commented-out or existing lines like: # KEY=value or KEY=value
    const pattern = new RegExp(`^(#\\s*)?${key}=.*$`, "m");
    if (pattern.test(content)) {
      // Function replacement: a `$` in the value must stay literal.
      content = content.replace(pattern, () => `${key}=${value}`);
    } else {
      // Append if not found at all
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  if (content === before) return false;
  writeFileSync(APP_ENV_PATH, content);
  return true;
}

/**
 * Configure-time counterpart of install's gateway env propagation: push the
 * subset of `envVars` the bundle's manifest declares in env_vars into the
 * gateway .env. Docker bundles only — that is the install path that propagates
 * (and the uninstall path that re-comments them). Returns true when the gateway
 * .env changed (the caller reports needs_restart).
 */
export function propagateBundleEnvToGateway(bundleId, envVars) {
  const manifest = getInstalledFirstManifest(bundleId);
  if (!manifest || (manifest.type || "bundle") !== "bundle") return false;
  const subset = declaredEnvSubset(manifest, envVars);
  if (Object.keys(subset).length === 0) return false;
  return propagateEnvToGateway(subset);
}

/**
 * Only the keys the bundle's manifest declares in env_vars. Request bodies
 * (install AND Configure) can carry any key — e.g. CROW_DASHBOARD_PUBLIC — and
 * only the declared ones may ever reach the gateway's own .env.
 */
export function declaredEnvSubset(manifest, envVars) {
  const excluded = gatewayExcludedKeys(manifest);
  const declared = new Set((manifest?.env_vars || []).map((v) => v && v.name).filter((n) => n && !excluded.has(n)));
  const subset = {};
  for (const [k, v] of Object.entries(envVars && typeof envVars === "object" ? envVars : {})) {
    if (declared.has(k)) subset[k] = v;
  }
  return subset;
}

const STORAGE_ENV_KEYS = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"];

/**
 * Whether Crow's file storage is already set up some other way: Shared Storage rows in
 * the DB, a MINIO_ENDPOINT or S3_ENDPOINT in the gateway .env, or the MinIO bundle installed.
 * An unreadable DB counts as configured (never repoint storage on a guess).
 */
export async function storageAlreadyConfigured(bundleId = null) {
  if (getInstalled().some((i) => (typeof i === "string" ? i : i?.id) === "minio" && bundleId !== "minio")) return true;
  try {
    const env = parseEnvText(readFileSync(APP_ENV_PATH, "utf8"));
    if (env.S3_ENDPOINT || env.MINIO_ENDPOINT) return true;
  } catch { /* no gateway .env */ }
  let db;
  try {
    db = createDbClient();
    const { rows } = await db.execute({ sql: "SELECT 1 FROM dashboard_settings WHERE key LIKE 'storage.shared.%' AND value IS NOT NULL AND value != '' LIMIT 1", args: [] });
    return rows.length > 0;
  } catch {
    return true;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || GATEWAY_ENV_DENYLIST.has(key)) continue;
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
  if (_restartHookForTest) {
    _restartHookForTest(delayMs);
    return;
  }
  if (isSupervised()) {
    // Supervised — close server, then exit to trigger restart
    console.log("[bundles] Restarting gateway to apply new configuration...");
    setTimeout(() => {
      process.emit("crow:shutdown");
      // Give server.close() time to release the port, then exit
      setTimeout(() => process.exit(1), 1000);
    }, delayMs);
  } else {
    // Unsupervised — reload env vars into current process. Instance paths
    // (CROW_HOME, CROW_DATA_DIR, CROW_DB_PATH, ...) and the other
    // GATEWAY_ENV_DENYLIST keys are never changed in a running process. On
    // 2026-10-17 this reload copied a checkout .env's CROW_DATA_DIR into a
    // test process, whose cleanup then deleted the live data dir.
    try {
      const envContent = readFileSync(APP_ENV_PATH, "utf8");
      const skipped = [];
      for (const line of envContent.split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!match) continue;
        if (GATEWAY_ENV_DENYLIST.has(match[1])) {
          if (process.env[match[1]] !== match[2]) skipped.push(match[1]);
          continue;
        }
        process.env[match[1]] = match[2];
      }
      console.log("[bundles] Reloaded env vars into current process");
      if (skipped.length) console.warn(`[bundles] .env reload left protected keys unchanged (restart to apply): ${skipped.join(", ")}`);
    } catch {}
  }
}
/** Test-only: the real restart scheduler (unsupervised in a suite: the .env reload) and the gateway .env writers. */
// The restart scheduler stays internal to this module: nothing else may start a gateway restart
// on its own (the first-admin runs only REPORT that one is needed — see bundle-first-admin-setup.js).
export { scheduleGatewayRestart as _scheduleGatewayRestartForTest, propagateEnvToGateway as _propagateEnvToGatewayForTest, revertEnvInGateway as _revertEnvInGatewayForTest };

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
 * docker-at-point-of-use → hosted-host-networking refusal → consent).
 *
 * @returns {Promise<
 *   { ok: true, manifest: object, installed: Array, consentVerified: boolean, hardwareWarning?: object }
 * | { ok: false, status: number, code: string, error: string, extra?: object }>}
 *   codes: invalid_id | not_found | already_installed | missing_dependencies |
 *          missing_required_env (requireEnv only) | hardware_gate | gpu_arch_gate | docker_unavailable | consent_required |
 *          consent_invalid | hosted_forbidden
 */
/**
 * Host-level switch (spec 2026-09-24 D4): under CROW_DISABLE_MODEL_ORCHESTRATION
 * a model bundle (inference / GPU / provider rows) is never installed, started
 * or stopped here — including a start a peer forwards to this instance.
 * Unknown ids return null: other gates own not-found.
 */
export function bundleOrchestrationRefusal(bundleId) {
  if (!isModelOrchestrationDisabled()) return null;
  if (!isModelBundleManifest(getInstalledFirstManifest(bundleId))) return null;
  return {
    status: 409,
    code: "MODEL_ORCHESTRATION_DISABLED",
    error: `Bundle '${bundleId}' serves a model, and model orchestration is disabled on this host (CROW_DISABLE_MODEL_ORCHESTRATION)`,
  };
}

// nonBlankEnv, hardFailComposeKeys: ../bundle-core.js (hardFailComposeKeys re-exported above).

/**
 * The env keys a compose file consumes: every `${KEY…}` / `$KEY` it
 * interpolates, plus — when a service loads the bundle's own `.env` through
 * `env_file:` — every key (`all: true`), since that file reaches the
 * container verbatim. `$$` is a literal dollar, not a reference.
 */
export function composeConsumedKeys(composeText) {
  const text = String(composeText || "");
  const keys = new Set();
  const re = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > 0 && text[m.index - 1] === "$") continue;
    keys.add(m[1] || m[2]);
  }
  let all = false;
  const lines = text.split(/\r?\n/);
  const isDotEnv = (v) => /^["']?(\.\/)?\.env["']?$/.test(String(v).replace(/\s+#.*$/, "").trim());
  for (let i = 0; i < lines.length && !all; i++) {
    const m2 = /^(\s*)env_file:\s*(.*)$/.exec(lines[i]);
    if (!m2) continue;
    const inline = m2[2].trim();
    if (inline) {
      const flow = /^\[(.*)\]$/.exec(inline.replace(/\s+#.*$/, "").trim());
      if (flow ? flow[1].split(",").some(isDotEnv) : isDotEnv(inline)) all = true;
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
      if (/^(\s*)/.exec(lines[j])[1].length <= m2[1].length) break;
      const item = /^\s*(?:-\s+)?(?:path:\s*)?(.+)$/.exec(lines[j]);
      if (item && isDotEnv(item[1])) { all = true; break; }
    }
  }
  return { keys, all };
}

/**
 * The env keys whose blank value makes `docker compose up` FAIL — and so the
 * only keys that may block an install. A key blocks iff the manifest marks it
 * `required`, it has no non-blank manifest `default`, AND the bundle's compose
 * interpolates it hard-fail (`${KEY:?…}` / `${KEY?…}`).
 *
 * `required: true` alone does NOT block: for most self-host bundles it means
 * "the MCP integration needs this", and the credential (gitea's GITEA_TOKEN,
 * jellyfin's API key, …) can only exist after the container has run and the
 * user has created it in the app. Those install blank and surface as "Needs
 * setup" → Configure, exactly as before.
 *
 * install_required: true blocks regardless of compose (a key used only by a post-install hook).
 *
 * Names only, never values (D5). Served to the install modal through the
 * consent-challenge response so client and server gate on the SAME list.
 */
export function installBlockingEnvKeys(bundleId, manifest = getManifest(bundleId)) {
  if (!bundleId || !isValidBundleId(bundleId)) return [];
  const composePath = join(APP_BUNDLES, bundleId, "docker-compose.yml");
  let text = "";
  try { if (existsSync(composePath)) text = readFileSync(composePath, "utf8"); } catch { /* unreadable → only install_required can block */ }
  const hard = hardFailComposeKeys(text);
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && !v.generate && !nonBlankEnv(v.default) && !crowHomeDefaultRel(v)
      && (v.install_required === true || (v.required && hard.has(v.name))))
    .map((v) => v.name);
}

/**
 * installBlockingEnvKeys minus those the request supplies non-blank, or that an earlier
 * install's .env (an in-place reinstall: the folder is still there) already holds. The
 * install form does not pre-fill those, and the reinstall keeps the .env's lines.
 */
export function missingInstallEnv(bundleId, envVars, manifest = getManifest(bundleId)) {
  const provided = envVars && typeof envVars === "object" ? envVars : {};
  const blocking = installBlockingEnvKeys(bundleId, manifest);
  let prior = {};
  if (blocking.length > 0) {
    try { prior = parseEnvText(readFileSync(join(BUNDLES_DIR, bundleId, ".env"), "utf8")); } catch { /* no earlier install */ }
  }
  const kept = (k) => nonBlankEnv(prior[k]) && !isPlaceholderValue(prior[k]);
  return blocking.filter((k) => !nonBlankEnv(provided[k]) && !kept(k));
}

/**
 * An in-place reinstall (the earlier install's folder and .env are still there): the
 * install form pre-fills every field with its manifest default and submits it, so a
 * default in the request is not a choice the owner made. Such a value is dropped when the
 * earlier .env already holds a real (non-blank, non-placeholder) value for that key, so
 * the kept value stays; a field the owner edited (`edited`, from the form) always wins,
 * even when it equals the default. A first install (empty `prior`) is unchanged.
 */
export function keepPriorOverDefaults(manifest, envVars, prior, edited = null) {
  if (!envVars || typeof envVars !== "object") return envVars;
  const editedSet = new Set(Array.isArray(edited) ? edited : []);
  const defaults = new Map((manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && v.default !== undefined && v.default !== null)
    .map((v) => [v.name, String(v.default)]));
  const out = {};
  for (const [k, v] of Object.entries(envVars)) {
    const kept = prior?.[k];
    const isDefault = defaults.has(k) && String(v) === defaults.get(k);
    if (isDefault && !editedSet.has(k) && nonBlankEnv(kept) && !isPlaceholderValue(kept) && String(kept) !== String(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Fields the owner cleared in the form on a reinstall (edited, submitted blank) whose
 * earlier value should be unset: only non-secret, non-required (nor install_required), declared
 * fields. A blank secret field means "keep it" (the form never shows its value), and a
 * required field is never unset by clearing it.
 */
export function clearedInstallEnv(manifest, envVars, prior, edited) {
  if (!Array.isArray(edited) || edited.length === 0) return [];
  const req = envVars && typeof envVars === "object" ? envVars : {};
  const byName = new Map((manifest?.env_vars || []).filter((v) => v && typeof v.name === "string").map((v) => [v.name, v]));
  return [...new Set(edited)].filter((k) => {
    const v = byName.get(k);
    if (!v || v.required || v.install_required || nonBlankEnv(req[k]) || !nonBlankEnv(prior?.[k])) return false;
    return !isSecretEnvField(v, String(prior[k]));
  });
}

/**
 * For the install form on an in-place reinstall: the earlier .env's values for the keys
 * the manifest declares, so the form shows them instead of the defaults. Secret and
 * generated keys never leave the server: they are only listed as already set.
 */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASS(?:WORD)?|PWD|KEY|CREDENTIAL|DSN|TOPIC|COOKIE|SALT|WEBHOOK|AUTH/i;
const SECRET_QUERY_NAME = /key|token|secret|sig|auth|pass|credential|session/i;
// A non-URL value carrying a credential: "Server=h;Password=p", "host=h password=p".
const SECRET_VALUE = /(pass(word)?|pwd|secret|token|api[_-]?key)\s*[=:]/i;
// A path segment that is itself a token (webhook URLs embed theirs in the path).
const TOKEN_PATH_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;
/**
 * Whether an env field must be treated as a secret: marked so in the manifest, a name
 * that reads like one (an ntfy topic is a capability), or a value that is a URL carrying
 * credentials (user:pass@ or a key/token/signature query parameter).
 */
export function isSecretEnvField(v, value) {
  if (!v) return true;
  if (v.secret === true || v.generate || v.store_as) return true;
  if (SECRET_ENV_NAME.test(String(v.name || ""))) return true;
  if (typeof value !== "string") return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) {
    let u;
    try { u = new URL(value.trim()); } catch { return SECRET_VALUE.test(value); }
    if (u.username || u.password) return true;
    for (const k of u.searchParams.keys()) if (SECRET_QUERY_NAME.test(k)) return true;
    // A fragment that carries parameters (#token=…, #access_token=…: OAuth implicit flow).
    for (const k of new URLSearchParams(u.hash.replace(/^#/, "")).keys()) if (SECRET_QUERY_NAME.test(k)) return true;
    if (/(^|\.)hooks\.slack\.com$/i.test(u.hostname) && u.pathname.startsWith("/services/")) return true;
    if (u.pathname.split("/").some((seg) => TOKEN_PATH_SEGMENT.test(seg))) return true;
    return false;
  }
  return SECRET_VALUE.test(value);
}

export function existingInstallEnv(bundleId, manifest = getManifest(bundleId)) {
  const out = { values: {}, secretSet: [] };
  if (!bundleId || !isValidBundleId(bundleId)) return out;
  let prior;
  try { prior = parseEnvText(readFileSync(join(BUNDLES_DIR, bundleId, ".env"), "utf8")); } catch { return out; }
  for (const v of manifest?.env_vars || []) {
    if (!v || typeof v.name !== "string") continue;
    const val = prior[v.name];
    if (!nonBlankEnv(val) || isPlaceholderValue(val)) continue;
    if (isSecretEnvField(v, String(val))) out.secretSet.push(v.name);
    else out.values[v.name] = String(val);
  }
  return out;
}

/**
 * The first env entry that may not be written to an .env file, or null.
 * Keys must be plain upper-case env names; a value may not carry CR, LF or
 * NUL (it would add lines to the file, and a stripped copy in one file vs a
 * raw copy in another makes shared secrets silently diverge). Callers REJECT
 * (400 invalid_env), they never strip. Returns the KEY only — never the value.
 */
export function findInvalidEnv(envVars) {
  if (!envVars || typeof envVars !== "object") return null;
  for (const [k, v] of Object.entries(envVars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return { key: k, why: "is not a valid environment variable name" };
    // A bundle .env is also Docker Compose's own settings file: COMPOSE_FILE would swap the
    // file the install security check read, and Start never re-checks it.
    if (/^(?:COMPOSE|DOCKER)_/.test(k) && k !== "COMPOSE_PROJECT_NAME") return { key: k, why: "controls Docker itself, so an extension can't set it" };
    if (v !== undefined && v !== null) {
      const problem = envValueProblem(v);
      if (problem) return { key: k, why: problem };
    }
  }
  return null;
}

/** Existence without following a symlink: a dangling or directory symlink still counts. */
function pathExistsNoFollow(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Whether `manifest` is a stdio MCP add-on — the only kind that owns a data folder.
 * A remote MCP (`server.url`) has no child process and no data dir of its own.
 */
function isStdioAddonManifest(manifest) {
  return !!manifest?.server && !manifest.server.url;
}

/**
 * Review item 5: refuse an install over a pre-existing `<dataDir>/<id>`, so an add-on
 * never starts inside a folder someone else filled (a hand-made dir, a leftover of
 * another tool). The one exception is Crow's own kept data, recorded per add-on in
 * `<crowHome>/addon-walls.json` (`keptData`): an install records the folder it made
 * `<dataDir>/<id>` and keeps that record while the add-on is installed, and an uninstall
 * never deletes the folder, so the record also covers a reinstall over it. A record names
 * ONE folder — its device, inode and owner — so a folder swapped in after the uninstall
 * (or a symlink to one) inherits nothing. A record whose folder is gone is stale and
 * dropped here. Nothing inside the folder is read for this decision — a planted
 * `addon-walls.json` there grants nothing.
 *
 * @returns {object|null} the refusal ({ok:false,status,code,error,extra}) or null.
 */
export function addonDataDirRefusal(manifest, bundleId, { dataDir, crowHome }) {
  if (!isStdioAddonManifest(manifest) || !bundleId) return null;
  const dir = join(dataDir, bundleId);
  if (!pathExistsNoFollow(dir)) {
    // No folder, so any record for it is stale: drop it rather than let it name a
    // folder a later install would then create.
    try { clearKeptData(crowHome, bundleId); } catch (err) {
      console.warn(`[bundles] could not clear the kept-data record for '${bundleId}': ${err?.message || err}`);
    }
    return null;
  }
  // A symlink never matches (the record names a plain directory), so it is always refused.
  if (keptDataMatches(crowHome, bundleId, dir)) return null;
  return {
    ok: false, status: 409, code: "addon_data_dir_exists",
    error: "A folder for this add-on already exists; remove or rename it, then install again",
    extra: { code: "addon_data_dir_exists" },
  };
}

/**
 * Review item 5: create the add-on's own data folder, BEFORE its MCP entry is
 * registered, so a folder that cannot be made fails the install with no entry left
 * behind. `<dataDir>` itself already exists (Crow's home); the folder is made 0700
 * and recorded as Crow's own kept data — the record names exactly the folder Crow made,
 * so a failed install can be retried and an in-place reinstall over that same folder is
 * allowed. The record stays while the add-on is installed; one whose folder is gone is
 * dropped by the next check (see addonDataDirRefusal).
 *
 * The folder just made is opened once and every later step goes through that fd: the
 * mode is set on the fd and the record is the fd's own `fstat`, so nothing between the
 * `mkdir` and the record can swap a different directory (or a symlink) in at the path.
 *
 * Exported for tests. `mkdir` is the check: a folder that appeared between
 * validateInstall and here is only accepted when the kept-data record already names
 * exactly that folder (an uninstall kept it), otherwise the install fails.
 */
export function ensureAddonDataDir(bundleId, manifest) {
  if (!isStdioAddonManifest(manifest) || !bundleId) return;
  const dir = join(resolveDataDir(), bundleId);
  // Never `recursive`: the data dir itself is the instance's own and must already exist.
  // A failure here fails the install (runInstallJob's handler) instead of leaving an
  // add-on recorded whose only writable folder was never made.
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    if (keptDataMatches(CROW_HOME, bundleId, dir)) return;
    throw new Error("a folder for this add-on appeared during the install; remove or rename it, then install again");
  }
  let fd;
  try {
    // O_NOFOLLOW: a symlink swapped in after the mkdir is refused, never followed.
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fchmodSync(fd, 0o700);
    const st = fstatSync(fd, { bigint: true });
    if (!st.isDirectory()) throw new Error("the add-on's data folder is not a directory");
    try {
      recordKeptData(CROW_HOME, bundleId, st);
    } catch (err) {
      console.warn(`[bundles] could not record the data folder for '${bundleId}': ${err?.message || err}`);
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

/**
 * `requireEnv` (single-install route only): refuse with 400 missing_required_env
 * when an installBlockingEnvKeys() key would install blank — `docker compose up`
 * would then fail on `${VAR:?...}` and leave a half-installed bundle. Collection installs
 * deliberately do NOT pass it: they install members blank and surface the gap
 * via NEEDS_CONFIG + the Configure flow.
 */
export async function validateInstall(bundleId, { envVars = {}, consentToken = null, forceInstall = false, requireEnv = false } = {}) {
  if (!bundleId || !isValidBundleId(bundleId)) {
    return { ok: false, status: 400, code: "invalid_id", error: "Invalid bundle ID" };
  }

  const orchRefusal = bundleOrchestrationRefusal(bundleId);
  if (orchRefusal) return { ok: false, ...orchRefusal };

  // Models plan 3a: model bundles (manifest `inference: true`) are installed
  // from the Model Catalog now, which registers native llama-server models.
  // A direct POST is refused; force_install does not bypass it. Deliberately
  // narrow: not isModelBundleManifest(), which would also catch TTS/STT and
  // GPU apps such as kokoro or ollama. install-set shares this gate (no
  // collection lists an inference bundle).
  if (getManifest(bundleId)?.inference === true) {
    return {
      ok: false, status: 409, code: "model_bundle_moved",
      error: `'${bundleId}' is a model bundle — models are installed from the Model Catalog (/dashboard/model-catalog)`,
    };
  }

  // Check source exists
  const sourceDir = join(APP_BUNDLES, bundleId);
  if (!existsSync(sourceDir)) {
    return { ok: false, status: 404, code: "not_found", error: `Bundle '${bundleId}' not found` };
  }

  // Check not already installed
  const installed = getInstalled();
  const onSatellite = installed.find((i) => i.id === bundleId && isSatelliteEntry(i));
  if (onSatellite) {
    // One host per bundle id (SAT-5, spec §8): a bundle on a satellite is never also local.
    return { ok: false, status: 409, code: "installed_on_satellite", error: `Bundle '${bundleId}' is installed on a server; manage it from Extensions › Servers`, extra: { code: "installed_on_satellite", host: onSatellite.host } };
  }
  if (installed.find((i) => i.id === bundleId)) {
    // `extra.code` is the stable answer clients match (the Services Install sheet); the text stays.
    return { ok: false, status: 409, code: "already_installed", error: `Bundle '${bundleId}' is already installed`, extra: { code: "already_installed" } };
  }

  // Review item 5: a data folder this add-on did not get from Crow (and that no
  // uninstall recorded as kept) is refused BEFORE anything is copied, so the add-on
  // can never start inside a folder someone else prepared (see addonDataDirRefusal).
  const dataDirRefusal = addonDataDirRefusal(getManifest(bundleId), bundleId, { dataDir: resolveDataDir(), crowHome: CROW_HOME });
  if (dataDirRefusal) return dataDirRefusal;

  // PR 0: dependency check — refuse install if any required bundle is missing
  const manifest = getManifest(bundleId);

  // requires-bins gate: a bin the add-on launches bare (uvx) must resolve as
  // trusted (root-owned, system dirs) or the installed entry is refused at
  // spawn. Not bypassed by force_install — the install would never start.
  // Lifts by itself once the bin is installed system-wide.
  const untrustedBins = trustedBinsMissing(manifest);
  if (untrustedBins.length > 0) {
    return {
      ok: false, status: 409, code: "bins_not_trusted",
      error: `Bundle '${bundleId}' needs ${untrustedBins.join(", ")} installed system-wide (root-owned, in /usr/local/bin or /usr/bin), not in a home folder, before Crow can run it`,
      extra: { code: "bins_not_trusted", bins: untrustedBins },
    };
  }
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

  // Compose-blocking env present? Before the docker/consent gates so a doomed
  // install never consumes a single-use consent token.
  if (requireEnv) {
    const missingEnv = missingInstallEnv(bundleId, envVars, manifest);
    if (missingEnv.length > 0) {
      return {
        ok: false, status: 400, code: "missing_required_env",
        error: `Bundle '${bundleId}' needs a value for: ${missingEnv.join(", ")}`,
        extra: { code: "missing_required_env", missing_env: missingEnv },
      };
    }
  }

  // A supplied value that breaks its manifest pattern (e.g. an admin password with `$`
  // or a space) is refused BEFORE anything is copied — never a half-install.
  const badPattern = envPatternViolation(manifest, envVars);
  if (badPattern) {
    return {
      ok: false, status: 400, code: "invalid_env",
      error: `Environment variable '${badPattern.key}' ${badPattern.why}`,
      extra: { code: "invalid_env", key: badPattern.key },
    };
  }
  const breached = await breachedValueViolation(manifest, envVars, { fetchImpl: _breachFetchForTest || globalThis.fetch });
  if (breached) {
    return {
      ok: false, status: 400, code: "invalid_env",
      error: `Environment variable '${breached.key}' ${breached.why}`,
      extra: { code: "invalid_env", key: breached.key },
    };
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

  // Item 4-PR5: docker at point of use — a deploys-kind bundle (type "bundle"
  // with a docker-compose.yml) needs a reachable Docker daemon. Refuse with an
  // honest 4xx BEFORE any compose invocation (and before the consent check, so
  // a doomed install never consumes a single-use consent token). No
  // forceInstall bypass: the compose calls would just fail cryptically.
  // connects/builtin add-ons (mcp-server/skill/panel, or no compose file)
  // never hit this gate. The install-set runner shares this guard via its
  // per-member validateInstall call (member skips with this reason).
  {
    const composePath = join(sourceDir, "docker-compose.yml");
    if ((manifest?.type || "bundle") === "bundle" && existsSync(composePath) && !(await dockerAvailable())) {
      return {
        ok: false, status: 412, code: "docker_unavailable",
        error: "Docker isn't available on this host, and this extension deploys containers. Install Docker and make sure the daemon is running and reachable by this service (on a Crow appliance, re-run scripts/crow-install.sh — it installs Docker and grants access), then try again.",
        extra: { code: "docker_unavailable" },
      };
    }
  }

  // Block bundles with network_mode: host on managed hosting (security risk on shared
  // infrastructure). Checked BEFORE consent, so a host-network bundle (they are all
  // privileged) is refused without spending the user's consent token first.
  if (process.env.CROW_HOSTED) {
    const composePath = join(sourceDir, "docker-compose.yml");
    if (existsSync(composePath)) {
      const composeContent = readFileSync(composePath, "utf8");
      // The text check, then the model Compose resolves (catches ${N:-host}, LAN-level
      // network drivers). A model that can't be read is refused here (fail-closed).
      let hostNet = HOST_NETWORK.test(composeContent);
      if (!hostNet) {
        const loaded = await loadComposeModel(sourceDir, { env: composeEnv(), runConfig: runComposeConfig });
        hostNet = !!loaded.error || usesHostNetwork(loaded.model);
      }
      if (hostNet) {
        return {
          ok: false, status: 403, code: "hosted_forbidden",
          error: "This bundle requires host networking and is not available on managed hosting.",
        };
      }
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

  return { ok: true, manifest, installed, consentVerified, ...(hardwareWarning ? { hardwareWarning } : {}) };
}

/**
 * Run one bundle install against an existing job.
 *
 * Outcome-returning by design: the collection installer shares ONE job across N
 * members, so this function must not decide the job's fate. It never calls
 * finishJob() and never calls scheduleGatewayRestart() itself under any
 * circumstance — it only reports `needsRestart`; the caller (the single-install
 * route, or the set runner after all members finish) owns the restart.
 *
 * @param {object} opts
 * @param {object} opts.job              the job to append logs to
 * @param {Array}  opts.installedSnapshot  getInstalled() as of validation (the body pushes onto it)
 * @param {boolean} opts.consentVerified  from validateInstall — gates validateComposeFile
 * @param {object} opts.manifest          the on-disk manifest
 * @returns {Promise<{ok:true, needsRestart:boolean}|{ok:false, reason:string}>}
 */
// writeInstallEnv, crowHomeDefaultRel, scrubPlaceholderLines: ../bundle-core.js (re-exported above).

export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, keychain = null, ownerEnv = null, editedEnv = null }) {
  let needsRestart = false;
  // Set when `docker compose up` fails. The install does NOT stop there: the
  // non-container steps (gateway env, MCP registration, panel + routes,
  // panels.json, skills) still run, so a bundle the user fixes via Configure +
  // Start is complete. The job still ends not-ok with this reason.
  let composeFailure = null;
  let runHook = false;
  let hookFailure = null;
  // Until the pre-up checks pass, a failed or refused install puts the folder back (below).
  let installSnap = null;
  try {
    const addonType = manifest?.type || "bundle";
    const sourceDir = join(APP_BUNDLES, bundleId);

    // 1. Copy bundle files to ~/.crow/bundles/<id>
    const destDir = join(BUNDLES_DIR, bundleId);
    // Seen BEFORE the copy: the source tree may carry its own .env (a dev checkout).
    const priorInstallEnv = existsSync(join(destDir, ".env"));
    // The earlier install's values: one the request repeats is not a new choice (the .env
    // may hold a value something other than the owner wrote), so it is never granted.
    let priorEnvValues = {};
    let priorEnvText = null;
    if (priorInstallEnv) { try { priorEnvText = readFileSync(join(destDir, ".env"), "utf8"); priorEnvValues = parseEnvText(priorEnvText); } catch { /* unreadable: nothing excluded beyond the rest */ } }
    // The form's pre-filled defaults never overwrite a value the earlier install's .env holds;
    // only a field the owner edited does (keepPriorOverDefaults).
    let clearedEnv = [];
    if (priorInstallEnv) {
      clearedEnv = clearedInstallEnv(manifest, envVars, priorEnvValues, editedEnv);
      envVars = keepPriorOverDefaults(manifest, envVars, priorEnvValues, editedEnv);
      if (ownerEnv) ownerEnv = keepPriorOverDefaults(manifest, ownerEnv, priorEnvValues, editedEnv);
    }
    // The INSTALLED compose, read before the copy replaces it: a pre-generation install whose
    // .env left a generated key blank ran on that compose's `${KEY:-fallback}`, and the repo
    // copy may no longer carry it (queue item 30d: minio's is `:?` now).
    let priorComposeText = null;
    if (priorInstallEnv) {
      let priorManifest = null;
      try { priorManifest = JSON.parse(readFileSync(join(destDir, "manifest.json"), "utf8")); } catch { /* fall back to the repo manifest */ }
      const rel = manifestComposeFile(priorManifest || manifest) || "docker-compose.yml";
      try { priorComposeText = readFileSync(join(destDir, rel), "utf8"); } catch { priorComposeText = null; }
    }
    installSnap = snapshotInstallDir(sourceDir, destDir, { backupRoot: join(CROW_HOME, ".install-rollback") });
    mkdirSync(destDir, { recursive: true });
    cpSync(sourceDir, destDir, { recursive: true });
    // N8-1: remember the compose bytes as installed, so a later version change can
    // tell an unmodified compose from an owner edit (catchUpInstalledCompose).
    recordInstalledCompose(destDir, manifest);
    appendLog(job, "Copied bundle files");

    // 1.5 If the bundle ships its own package.json (typically because it
    // brings an MCP server using @modelcontextprotocol/sdk), install
    // those deps now. Without this the proxy spawns the MCP child and it
    // immediately dies with ERR_MODULE_NOT_FOUND for the SDK, which
    // surfaces user-side as "I don't have a music player integration
    // installed" or similar mysteries.
    //
    // C4 Task 3: manifest.npm_required === true means the bundle is USELESS
    // without a working install (e.g. bot-engine's pi CLI) — hard-fail on any
    // npm problem instead of the warn-only behavior every other bundle keeps.
    // Never skip because node_modules exists: an interrupted prior install can
    // leave a PARTIAL tree that would pass an absence-only check on retry
    // (r1 critical #3), so npm_required bundles always rm -rf node_modules
    // first and reinstall clean.
    const pkgJsonPath = join(destDir, "package.json");
    if (manifest?.npm_required === true) {
      // Engine floor: refuse honestly instead of installing a payload that
      // will crash at first spawn on an older Node (bot-engine 0.82.0 on
      // Node 20 dies with an opaque undici stack).
      if (typeof manifest.min_node === "string" && manifest.min_node.trim()
          && !nodeSatisfiesMin(process.versions.node, manifest.min_node)) {
        const reason = `requires Node.js >= ${manifest.min_node.trim()} — this Crow runs Node ${process.versions.node}; upgrade Node.js, restart Crow, and retry`;
        appendLog(job, "npm install refused: " + reason);
        return { ok: false, reason };
      }
      if (!existsSync(pkgJsonPath)) {
        appendLog(job, "npm install failed: package.json missing from bundle (npm_required)");
        return { ok: false, reason: "npm install failed: package.json missing from bundle" };
      }

      rmSync(join(destDir, "node_modules"), { recursive: true, force: true });
      const hasLock = existsSync(join(destDir, "package-lock.json"));
      const npmArgs = [
        hasLock ? "ci" : "install",
        "--omit=optional", "--no-audit", "--no-fund", "--ignore-scripts",
      ];
      appendLog(job, `Installing bundle dependencies (npm ${npmArgs[0]}, required)…`);
      try {
        // run()'s default execFile timeout is already 300_000 (pi payload can
        // exceed 120s on slow links) — no override needed here.
        await run("npm", npmArgs, { cwd: destDir, env: withoutCredentialKeys(process.env) });
        appendLog(job, "Dependencies installed");
      } catch (err) {
        const stderrTail = String(err.stderr || err.message || "").slice(-2000).trim();
        appendLog(job, `npm install failed: ${stderrTail}`);
        return { ok: false, reason: `npm install failed: ${stderrTail}` };
      }

      const missing = (manifest.verify_paths || []).filter((p) => !existsSync(join(destDir, p)));
      if (missing.length > 0) {
        appendLog(job, `npm install verification failed: missing ${missing.join(", ")}`);
        return { ok: false, reason: `npm install failed: verify_paths missing: ${missing.join(", ")}` };
      }
    } else if (existsSync(pkgJsonPath) && !existsSync(join(destDir, "node_modules"))) {
      appendLog(job, "Installing bundle dependencies (npm install)…");
      try {
        // A bundle's own install scripts run here: never hand them a credential-applied key.
        await run("npm", ["install", "--omit=optional", "--no-audit", "--no-fund"], {
          cwd: destDir,
          env: withoutCredentialKeys(process.env),
          timeout: 120_000,
        });
        appendLog(job, "Dependencies installed");
      } catch (err) {
        appendLog(job, `Warning: npm install failed: ${err.message?.slice(0, 200)}`);
        // Don't fail install; some bundles may have optional deps that
        // can't resolve in every environment. The MCP server will fail
        // to start later but the bundle install itself succeeds.
      }
    }

    // 2. Write env vars (provided values -> .env.example fallback -> manifest
    // placeholder; ladder extracted so it is unit-testable). Generated secrets
    // (env_vars[].generate) are minted or reused here: never taken from the request,
    // never shown, never sent to the gateway .env. reqEnv is the request env with
    // generated keys stripped, and is the only request env used below.
    const reqEnv = stripGeneratedKeys(manifest, envVars);
    let composeTextForEnv = null;
    try { const cp = join(destDir, "docker-compose.yml"); if (existsSync(cp)) composeTextForEnv = readFileSync(cp, "utf8"); } catch { /* no fallbacks */ }
    // A rebuilt machine (crow.db restored + keychain Export imported) has no .env and no
    // retained copy: its keychain:true generated keys come back from the keychain instead of
    // being minted again (recovery keys, queue item 30). Best-effort; values never logged.
    const kcRestore = await keychainRestoreValues(bundleId, manifest);
    const plan = planGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME, composeText: priorComposeText ?? composeTextForEnv, priorInstall: priorInstallEnv, keychain: kcRestore.values });
    // A key the keychain holds but cannot read (sealed with a keychain key this machine does
    // not have: crow.db restored, Export not imported yet) is never minted over: the new
    // value would replace that entry, and a later Import skips a bundle+key that has a
    // readable entry, so the old key (and the data saved with it) would be lost for good.
    const mintingKc = Object.keys(plan.minted).filter((k) => manifest.env_vars?.find((v) => v.name === k)?.keychain === true);
    const blocked = kcRestore.failed ? mintingKc : mintingKc.filter((k) => kcRestore.unreadable.includes(k));
    if (blocked.length > 0) {
      // A prior install's folder (its .env holds other generated secrets) is put back as it was.
      const reason = kcRestore.failed
        ? `Crow keychain could not be read, so ${blocked.join(", ")} was not generated (a new value could replace one saved there). Try the install again; nothing was written.`
        : `Crow keychain holds ${blocked.join(", ")} for this extension, sealed with a keychain key this machine does not have. Import your keychain Export first (Settings → Security & passwords → Saved passwords & keys → Import), then install again. To start fresh instead, delete the old saved password(s) there (this needs a dashboard password or two-factor sign-in).`;
      appendLog(job, reason);
      return { ok: false, reason };
    }
    if (plan.restored.length > 0) appendLog(job, `Restored ${plan.restored.length} key(s) from Crow keychain (Settings → Security & passwords → Saved passwords & keys): ${plan.restored.join(", ")}`);
    if (plan.replaced.length > 0) appendLog(job, `${plan.replaced.join(", ")} was the example value once published in Crow's repository: a new key was generated, and the old one kept in its previous-key slot so data saved with it still opens`);
    if (plan.replaceSkipped?.length > 0) appendLog(job, `${plan.replaceSkipped.join(", ")} is still the example value once published in Crow's repository, but its previous-key slot already holds another key, so it was left as it is. Open that data, clear the previous-key slot in Configure, then reinstall.`);
    const generated = plan.env;
    const writeEnv = { ...(reqEnv || {}), ...generated };
    let installEnv = writeEnv;
    let baseText = null;
    let baseIsExample = false;
    if (Object.keys(generated).length > 0) {
      // Writing values bypasses the .env / .env.example rungs, so seed from them:
      // existing .env, else .env.example — LINE-PRESERVING (C4): the base's own lines are
      // kept verbatim and only the request + generated keys are set on top.
      const envP = join(destDir, ".env");
      const exP = join(destDir, ".env.example");
      try {
        if (existsSync(envP)) baseText = readFileSync(envP, "utf8");
        else if (existsSync(exP)) { baseText = scrubPlaceholderLines(readFileSync(exP, "utf8")); baseIsExample = true; }
      } catch { /* unreadable base: fall back to provided values only */ }
      if (baseText !== null) installEnv = { ...parseEnvText(baseText), ...writeEnv };
    } else if (priorEnvText !== null) {
      // An in-place reinstall keeps the earlier .env's lines (values the form did not ask
      // for again, see missingInstallEnv); only the typed keys are set on top.
      baseText = priorEnvText;
    }
    // Keychain FIRST (review C5, plan P7): a generated token's plaintext must be safely in
    // the keychain before its hash reaches .env or the retained copy; if that save fails,
    // abort with nothing persisted so a retry mints a fresh token. Typed fields and the
    // optional vault copy run here too — before any pull, so the master password lives
    // for seconds and a later compose failure still leaves the password saved.
    const kc = await recordKeychainForInstall({ bundleId, manifest, env: installEnv, minted: plan.minted, reusedPlain: plan.reusedPlain, keychainReq: keychain, log: (m) => appendLog(job, m) });
    if (!kc.mintedSaved) {
      return { ok: false, reason: "could not save the generated password to Crow keychain; nothing was written — retry the install" };
    }
    plan.persist();
    let retainedForPaths = null;
    try { retainedForPaths = parseEnvText(readFileSync(retainedEnvPath(CROW_HOME, bundleId), "utf8")); } catch { /* none kept */ }
    writeInstallEnv(destDir, writeEnv, manifest, (msg) => appendLog(job, msg), { baseText, baseIsExample, crowHome: CROW_HOME, retained: retainedForPaths, clear: clearedEnv });
    if (clearedEnv.length > 0) appendLog(job, `Cleared ${clearedEnv.join(", ")} (emptied in the form)`);
    if (Object.keys(generated).length > 0) {
      appendLog(job, `Generated ${Object.keys(generated).length} internal secret(s) — stored at mode 600, never shown`);
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

    // No compose check ahead: the copy stands from here.
    if (!(addonType === "bundle" && existsSync(join(destDir, "docker-compose.yml")))) installSnap.commit();

    // 3. Type-specific install steps
    if (addonType === "bundle") {
      // Docker bundle — pull images and start containers
      const composePath = join(destDir, "docker-compose.yml");
      if (existsSync(composePath)) {
        // PR 0: validate compose for ALL bundles (first-party + community).
        // First-party bundles with privileged/host-network must declare manifest.privileged
        // and the install request must include a verified consent token.
        // Folders outside Crow's home the OWNER typed in this install (never a default, an
        // example or a retained value): granted once the check passes with exactly these.
        let grants = {};
        if (ownerEnv) {
          let exampleEnv = {};
          try { exampleEnv = parseEnvText(readFileSync(join(destDir, ".env.example"), "utf8")); } catch { /* none */ }
          const home = process.env.HOME || homedir();
          const refused = {};
          const typed = Object.fromEntries(Object.entries(stripGeneratedKeys(manifest, ownerEnv) || {}).filter(([k, v]) => priorEnvValues[k] === undefined || String(priorEnvValues[k]) !== String(v)));
          grants = grantCandidates({ manifest, submitted: typed, composeText: readFileSync(composePath, "utf8"), exampleEnv, retained: retainedForPaths || {}, crowHome: CROW_HOME, dataDirs: dataDirsForGrants(), home, appRoot: APP_ROOT, otherRoots: otherBundlesRoots(bundleId, { crowHome: CROW_HOME, home }), refused });
          await dropSharedFolderConflicts(bundleId, grants, refused);
          for (const [k, why] of Object.entries(refused)) appendLog(job, `The folder in ${k} is not allowed: ${why}`);
        }
        // Plus folders this bundle was allowed before (a reinstall restoring a kept value):
        // a grant is key + folder, so it counts only while that key still names it.
        const kept = activeRoots(bundleId, { crowHome: CROW_HOME, bundleDir: destDir, home: process.env.HOME || homedir() });
        const validation = await checkBundleCompose(destDir, { bundleId, manifest, consentVerified, operatorRoots: [...Object.values(grants).map((g) => g.real), ...kept] });
        if (!validation.valid) {
          appendLog(job, `Security check failed: ${validation.reason}`);
          // The copied files go; an earlier install is put back as it was (`finally` below).
          return { ok: false, reason: `Security check failed: ${validation.reason}` };
        }
        appendLog(job, "Security check passed");

        const own = await composeOwnership(bundleId, destDir, manifest);
        if (own.refusal) {
          appendLog(job, `Install refused: ${own.refusal}`);
          return { ok: false, reason: own.refusal };
        }
        if (own.warning) appendLog(job, `Note: ${own.warning}`);
        try {
          const made = precreateDirs(manifest, CROW_HOME);
          if (made.length) appendLog(job, `Prepared data folders: ${made.map((p) => relativePath(CROW_HOME, p)).join(", ")}`);
        } catch (err) {
          appendLog(job, `Install refused: ${err.message}`);
          return { ok: false, reason: err.message };
        }
        // Every pre-up check passed: the copied files stand from here, and so do the
        // folders the owner chose (recorded only now: a refused install keeps its old grants).
        installSnap.commit();
        if (Object.keys(grants).length) {
          recordGrants(CROW_HOME, bundleId, grants);
          appendLog(job, `Allowed the folder(s) you chose outside Crow's home: ${Object.keys(grants).join(", ")}`);
        }

        appendLog(job, "Pulling Docker images...");
        try {
          await runCompose(["pull"], { cwd: destDir, timeout: pullTimeoutMs(manifest) });
          appendLog(job, "Docker images pulled");
        } catch (err) {
          appendLog(job, `Warning: docker compose pull failed: ${err.message}`);
          // Log-only was invisible to an owner who never opens the job log (audit
          // N1c-7): one bell per bundle per 24 h, fixed text, never the output.
          // The compose text goes along so a service this repo BUILDS itself
          // (companion, sdxl, scratch-offline) does not ring: it has nothing to
          // download. An unreadable compose is no evidence of a local build, so
          // the bell still rings then.
          let pullComposeText = "";
          try { pullComposeText = readFileSync(composePath, "utf8"); } catch { /* ring */ }
          await reportImagePullFailure({
            bundleId,
            bundleName: manifest?.name,
            composeText: pullComposeText,
            output: `${err.stderr ?? ""}\n${err.message ?? ""}`,
          });
        }

        // Start containers (add --build if compose file has build directives)
        const composeContent = readFileSync(composePath, "utf8");
        const needsBuild = /^\s+build:/m.test(composeContent);
        const upArgs = needsBuild ? ["up", "-d", "--build"] : ["up", "-d"];
        appendLog(job, needsBuild ? "Building and starting containers..." : "Starting containers...");
        try {
          await runCompose(upArgs, { cwd: destDir, timeout: pullTimeoutMs(manifest) });
          appendLog(job, "Containers started");
          // The containers were created from the installed compose just now: let the
          // bind-drift check see them, so a stale "restart to apply" card from an
          // earlier copy resolves without waiting for the next gateway boot (N8-1).
          rebindDriftCheck(bundleId);
        } catch (err) {
          const detail = err.stderr || err.message;
          appendLog(job, `docker compose up failed: ${detail}`);
          // Still add to installed.json so user can configure env vars and hit
          // "Start" — recorded NOW so a later step throwing can't lose it.
          const installed2 = getInstalled();
          if (!installed2.find((i) => i.id === bundleId)) {
            installed2.push({ id: bundleId, type: addonType, version: manifest?.version, installedAt: new Date().toISOString(), ...consentRecord(manifest, consentVerified) });
            saveInstalled(installed2);
          }
          composeFailure = `docker compose up failed: ${detail}`;
          appendLog(job, "Continuing with the non-container install steps (panel, MCP server, gateway config, skills) so Configure + Start can finish the job");
        }
        runHook = !composeFailure && !!manifest?.postInstall;
      }

      // Propagate the manifest-DECLARED env vars to the gateway .env so
      // dependent services connect. Undeclared request keys never reach it.
      // Generated keys reach it only where the manifest says `propagate: true` (gateway-side
      // code reads them from process.env: phone's runner secret, coturn, MinIO root).
      // propagate_as renames on the way (Garage's default key id → S3_ACCESS_KEY).
      const gatewayEnv = { ...declaredEnvSubset(manifest, reqEnv || {}), ...gatewayGeneratedEnv(manifest, generated) };
      // S3_* outranks MINIO_* in the storage client: on a host whose storage already works
      // (Shared Storage rows, a MINIO_*/S3_* gateway env, or MinIO installed), installing a
      // new engine must not repoint storage at its empty buckets on the next restart. The
      // explicit "Upgrade storage engine" step switches it after the data is copied.
      if (STORAGE_ENV_KEYS.some((k) => k in gatewayEnv) && (await storageAlreadyConfigured(bundleId))) {
        for (const k of STORAGE_ENV_KEYS) delete gatewayEnv[k];
        appendLog(job, "Crow's file storage already points at another storage engine; left as it is (switch it with Upgrade storage engine)");
      }
      if (Object.keys(gatewayEnv).length > 0) {
        propagateEnvToGateway(gatewayEnv);
        appendLog(job, "Configuration applied to gateway");
        needsRestart = true;
      }

      // Bundle types can also have MCP servers — register if manifest has server config
      if (manifest?.server) {
        // The data folder first: a folder this add-on cannot get fails the install with
        // no half-registered MCP server left in mcp-addons.json.
        ensureAddonDataDir(bundleId, manifest);
        const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
        // Do NOT bake an absolute CROW_DB_PATH here. mcp-addons.json can be
        // shared by more than one gateway on a host (e.g. the home server runs a
        // main gateway + a separate-DB instance off the same ~/.crow), so a
        // hard-coded path is correct for one and a cross-instance DB leak for
        // the other — which crash-loops the wrong gateway on "database is
        // locked". The MCP child instead inherits the SPAWNING gateway's
        // CROW_DB_PATH via process.env at launch (its own default otherwise),
        // so each gateway's children always use that gateway's DB.
        mcpAddons[bundleId] = await pinnedMcpEntry({
          manifest,
          reqEnv,
          generated,
          ownerEnv,
          editedEnv,
          destDir,
          bundleId,
          priorEntry: mcpAddons[bundleId] || null,
          job,
        });
        writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
        appendLog(job, `Registered MCP server '${bundleId}'`);
        needsRestart = true;
      }

      // Bundle types can also have panels — install them
      if (manifest?.panel) {
        mkdirSync(PANELS_DIR, { recursive: true });
        const panelPath = resolvePanelPath(manifest, bundleId);
        const panelSrc = panelPath ? join(destDir, panelPath) : null;
        if (panelSrc && existsSync(panelSrc)) {
          cpSync(panelSrc, join(PANELS_DIR, `${bundleId}.js`));
          appendLog(job, `Installed panel: ${bundleId}`);
        }
        const routesRel = resolvePanelRoutesPath(manifest);
        if (routesRel) {
          const routesSrc = join(destDir, routesRel);
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
        addPanelEnabled(bundleId);
        needsRestart = true;
      }
    } else if (addonType === "mcp-server") {
      // MCP server — register in mcp-addons.json
      if (manifest?.server) {
        // Before the entry is written (see the bundle branch above).
        ensureAddonDataDir(bundleId, manifest);
        const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
        mcpAddons[bundleId] = await pinnedMcpEntry({
          manifest,
          reqEnv,
          generated,
          ownerEnv,
          editedEnv,
          destDir,
          bundleId,
          priorEntry: mcpAddons[bundleId] || null,
          job,
        });
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
            env: withoutCredentialKeys(process.env),
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
        const panelSrc = panelPath ? join(destDir, panelPath) : null;
        if (panelSrc && existsSync(panelSrc)) {
          cpSync(panelSrc, join(PANELS_DIR, `${bundleId}.js`));
          appendLog(job, `Installed panel: ${bundleId}`);
        }
        const routesRel = resolvePanelRoutesPath(manifest);
        if (routesRel) {
          const routesSrc = join(destDir, routesRel);
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
        addPanelEnabled(bundleId);
        needsRestart = true;
      }
    } else if (addonType === "skill") {
      // Skill — copy skill files to ~/.crow/skills/
      installBundleSkills(bundleId, destDir, manifest, job);
    } else if (addonType === "panel") {
      // Panel — copy panel file to ~/.crow/panels/ and register
      mkdirSync(PANELS_DIR, { recursive: true });
      if (manifest?.panel) {
        const panelPath = resolvePanelPath(manifest, bundleId);
        const src = panelPath ? join(destDir, panelPath) : null;
        const dest = panelPath ? join(PANELS_DIR, panelPath.split("/").pop()) : null;
        if (src && dest && existsSync(src)) {
          cpSync(src, dest);
          addPanelEnabled(bundleId);
          appendLog(job, `Installed panel: ${panelPath.split("/").pop()}`);
        }
      }
    }

    // 3b. Handle panel field on any add-on type
    if (manifest.panel && addonType !== "panel") {
      const panelPath = resolvePanelPath(manifest, bundleId);
      const panelSourceDir = panelPath ? join(APP_BUNDLES, bundleId, panelPath.replace(/[^a-zA-Z0-9_\-\/\.]/g, "")) : null;
      if (panelSourceDir && existsSync(panelSourceDir)) {
        const panelFilename = panelPath.split("/").pop();
        const panelDest = join(CROW_HOME, "panels", panelFilename);
        // Ensure panels directory exists
        mkdirSync(join(CROW_HOME, "panels"), { recursive: true });
        copyFileSync(panelSourceDir, panelDest);
        // Register in panels.json (either shape — see addPanelEnabled)
        addPanelEnabled(panelFilename.replace(/\.js$/, ""));
        needsRestart = true;
        appendLog(job, `Installed panel: ${panelFilename}`);
      }
    }

    // 3c. A `webUI` block needs a gateway restart before it does anything.
    // extension-proxy builds its whole route table ONCE, from
    // getProxiedExtensions(), at factory-construction time
    // (boot/late-mounts.js), long before this install runs, so a bundle
    // installed into a running gateway has no /proxy/<id> route until the
    // process comes back. Any add-on type, not just "bundle": the proxy reads
    // webUI off the manifest regardless of type.
    if (manifest?.webUI) {
      needsRestart = true;
      appendLog(job, "Web UI registered — gateway restart required to route it");
    }

    // 4. Copy any associated skills (bundles and mcp-servers can have skills too)
    if (addonType !== "skill" && manifest?.skills) {
      installBundleSkills(bundleId, destDir, manifest, job);
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

    // 6. Track installation (a compose-up failure already recorded the id;
    // installedSnapshot predates that write, so dedupe against it here).
    // The stamp is also this install's identity for the first-admin notice below:
    // a reinstall gets a new one, which is what makes that notice (and the
    // Extensions card's Done state) per-install rather than forever.
    const installedStamp = new Date().toISOString();
    if (!installedSnapshot.find((i) => i.id === bundleId)) installedSnapshot.push({
      id: bundleId,
      type: addonType,
      version: manifest?.version || "1.0.0",
      installedAt: installedStamp,
      ...consentRecord(manifest, consentVerified),
    });
    // Written from a FRESH read (SAT-5 review M3): the snapshot is as of validation, and anything
    // recorded since (a satellite install, another bundle) must survive. Only this bundle's own
    // entry comes from the snapshot, at its current position when it already has one.
    let recordedInstallAt = installedStamp;
    {
      const own = installedSnapshot.find((i) => i.id === bundleId);
      if (own && typeof own.installedAt === "string") recordedInstallAt = own.installedAt;
      const current = getInstalled();
      const at = current.findIndex((i) => i?.id === bundleId);
      if (at >= 0) current[at] = own; else current.push(own);
      saveInstalled(current);
    }
    appendLog(job, "Installation tracked");
    // Recorded: the project connections an earlier uninstall paused come back (and their
    // keychain secrets), for every bundle, unconditionally (Task 12).
    await restoreServicesAfterInstall(bundleId, { log: (m) => appendLog(job, m) });

    // Post-install hook — AFTER the install is recorded, so a gateway restart mid-hook
    // leaves a recorded bundle + a re-runnable script, never orphan containers.
    if (runHook) {
      const hook = await runPostInstall({
        manifest, destDir: join(BUNDLES_DIR, bundleId),
        env: hookEnv(join(BUNDLES_DIR, bundleId), CROW_HOME),
        log: (m) => appendLog(job, m),
        runner: _hookRunnerForTest || spawnGroup,
      });
      if (!hook.ok) {
        hookFailure = hook.reason;
        appendLog(job, `Post-install setup did not finish: ${hook.reason}`);
        if (hook.rerun) appendLog(job, `Fix the cause, then re-run it: ${hook.rerun}`);
      }
    }

    // Security audit N3-4 phase 2a: a `crow`/`via: "setup"` bundle gets its admin
    // account from a script Crow runs itself, with a password it generates. Only when
    // the app is actually up (the same condition as the post-install hook): a script
    // that talks to a stopped app can only fail. Its outcome is remembered per install
    // (the Extensions card reads it) and decides whether the bell rings below.
    // The REVIEWED manifest and script decide what runs: the installed folder can be
    // mounted into the bundle's own container, so it is not trusted (see startConsent).
    let firstAdminAuto = null;
    // What the manifest's own follow-up step did for THIS install ({ok, outcome}), or null
    // when it did not run: a failure here has to reach the owner, not only the job log.
    let firstAdminAfter = null;
    if (!composeFailure && firstAdminVia(manifest) === "setup") {
      const reviewed = getManifest(bundleId);
      const plan = firstAdminSetupPlan(reviewed);
      if (!plan) {
        // No reviewed declaration to run a script from: say so and leave the app to the operator.
        firstAdminAuto = "failed";
        appendLog(job, SETUP_UNAVAILABLE);
      } else if (plan.refused) {
        firstAdminAuto = "failed";
        appendLog(job, firstAdminResultMessage({
          result: "failed",
          name: reviewed?.name || bundleId,
          reason: plan.refused,
        }));
      } else {
        const auto = await runFirstAdminSetup({
          bundleId,
          manifest: reviewed,
          scriptDir: join(APP_BUNDLES, bundleId),
          destDir: join(BUNDLES_DIR, bundleId),
          installId: recordedInstallAt,
          crowHome: CROW_HOME,
          deps: {
            // The install path owns its ONE restart (runInstallJob never schedules one itself:
            // a restart in the middle of the job kills it). A login written into the bundle's
            // MCP entry needs that restart to be loaded, so it is requested here instead of
            // started, and `needsRestart` below makes sure the caller's restart happens.
            requestReload: () => {},
            ...(_firstAdminSetupDepsForTest || {}),
          },
        });
        if (auto.mcpEnvUpdated) {
          needsRestart = true;
          appendLog(job, "The new login also went into the extension's MCP settings; the restart below loads it");
        }
        firstAdminAuto = auto.result;
        for (const line of auto.log || []) appendLog(job, `  ${line}`);
        appendLog(job, firstAdminResultMessage({
          result: auto.result,
          name: reviewed?.name || bundleId,
          user: typeof reviewed?.firstAdmin?.user === "string" ? reviewed.firstAdmin.user : null,
          reason: auto.reason || null,
        }));
        // "Crow creates, then closes" (N3-4): the manifest's own after-step — the values the
        // app needs to stop accepting sign-ups, and one guarded recreate so it reads them.
        // Only when the app really holds Crow's password (exit 0 or 5); a failure here never
        // undoes the account, which is already in the keychain.
        if (auto.result === "ok" && firstAdminAfterPlan(reviewed)) {
          const after = await applyFirstAdminAfter({
            bundleId,
            manifest: reviewed,
            destDir: join(BUNDLES_DIR, bundleId),
            recreate: recreateBundleGuarded,
          });
          if (after.line) appendLog(job, after.line);
          firstAdminAfter = { ok: after.ok, outcome: after.outcome };
          if (!after.ok) appendLog(job, firstAdminAfterFailureSentence(reviewed?.name || bundleId));
        }
      }
    }

    // Security audit N3-4 phase 2e: an INVITE-ONLY app (manifest
    // `firstAdmin.invite`) gets the owner's email invited through its own admin API
    // and sign-ups closed, so nobody else can register. Runs only when the app is
    // actually up (the same condition as the post-install hook) and the operator
    // filled the email in; the REVIEWED manifest decides, and the step never throws
    // into the install (one plain job-log sentence per result).
    let inviteOutcome = null;
    if (!composeFailure) {
      inviteOutcome = await inviteFirstAdminOnInstall({
        bundleId,
        manifest: getManifest(bundleId),
        installDir: join(BUNDLES_DIR, bundleId),
        log: (m) => appendLog(job, m),
        deps: _firstAdminInviteDepsForTest || {},
      });
    }

    // ntfy autowire (spec 2026-10-03): Crow creates its own login + private topic on the
    // server it just started. Non-fatal — Settings › Notifications can re-run it.
    if (manifest?.autowire === AUTOWIRE_KIND && !composeFailure) {
      if (process.env.NTFY_TOPIC) {
        appendLog(job, "Phone notifications: NTFY_TOPIC is set in this gateway's environment, so it keeps using that configuration");
      } else {
        let port;
        try { port = parseEnvText(readFileSync(join(BUNDLES_DIR, bundleId, ".env"), "utf8")).NTFY_PORT; } catch { /* no .env */ }
        const wired = await provisionNtfy({ runner: dockerRunner(), port, log: (m) => appendLog(job, m) });
        if (!wired.ok) appendLog(job, `Phone notifications are not set up yet: ${wired.reason} (Settings › Notifications can retry)`);
      }
    }

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

    // Security audit N3-4: a bundle that does NOT create its own first admin
    // leaves an app setup page anyone on this machine can claim. One bell, once
    // per install, pointing at the Extensions card that says what to do. Silent
    // for `crow` via env/postInstall, `external` and `none` manifests, and for a
    // `crow`/via-"setup" bundle whose own setup run returned "ok" AND whose
    // follow-up step (setup.after) did not fail — an app that still accepts
    // sign-ups is exactly as claimable as one nobody set up. Never in the job log
    // (the owner reads the bell, and the log line would be a second,
    // easier-to-miss copy).
    //
    // BEFORE the half-failure returns below: a compose/hook failure still leaves
    // an app that can start (the owner fixes Configure + Start), so its setup
    // page is just as claimable — the notice must not be skipped (review S3).
    await reportFirstAdminNotice({
      bundleId,
      manifest,
      bundleName: manifest?.name || bundleId,
      // The stamp installed.json actually holds: an in-place reinstall keeps its
      // entry (and does not re-ring), and only a reinstall after an uninstall —
      // a new record — asks again.
      installId: recordedInstallAt,
      // What Crow's own setup run did for THIS install (null when it did not run):
      // an "ok" stays silent, everything else asks the operator to look.
      autoResult: firstAdminAuto,
      // ...and what its follow-up step did: an install whose registration Crow could
      // not close still leaves the app's door open, so that rings even though the
      // account itself was created.
      afterResult: firstAdminAfter,
      // What the invite step did for THIS install: an invited email plus confirmed-
      // closed sign-ups means there is nothing left for anyone to claim.
      inviteResult: inviteOutcome,
    });

    if (composeFailure) {
      // Last log line = what the client shows on a failed job: keep the cause in it.
      appendLog(job, `Installed, but the containers did not start (${composeFailure.slice(0, 400)}) — fix the configuration with Configure, then press Start`);
      return { ok: false, reason: composeFailure, needsRestart };
    }
    if (hookFailure) {
      appendLog(job, `Installed and running, but setup is incomplete (${hookFailure.slice(0, 400)})`);
      return { ok: false, reason: hookFailure, needsRestart };
    }

    return { ok: true, needsRestart };
  } catch (err) {
    const reason = err?.message || String(err);
    appendLog(job, `Install failed: ${reason}`);
    return { ok: false, reason: composeFailure ? `${composeFailure}; then: ${reason}` : reason };
  } finally {
    // Failed or refused before the pre-up checks passed: the earlier install comes back as
    // it was (a fresh install's folder goes). A no-op once committed.
    try { installSnap?.settle(); } catch (err) { appendLog(job, `Could not put the earlier install back: ${err.message}`); }
  }
}

/**
 * Re-validate a collection's membership against the ON-DISK manifests.
 * registry/collections.json is data, not a trust boundary: this is the gate that
 * stops a tampered file from one-click-installing a privileged, consent-required,
 * or host-networking bundle without the consent ceremony.
 */
export function validateCollectionServerSide(collection, { manifestFor = getManifest } = {}) {
  if (!collection || !Array.isArray(collection.members) || collection.members.length === 0) {
    return { ok: false, error: "Collection has no members" };
  }
  const seen = new Set();
  for (const m of collection.members) {
    if (!m?.id || !isValidBundleId(m.id)) return { ok: false, error: `Invalid member id '${m?.id}'` };
    if (!existsSync(join(APP_BUNDLES, m.id))) return { ok: false, error: `Member '${m.id}' is not a known bundle` };
    const man = manifestFor(m.id);
    if (man?.origin === "community") {
      // Provenance: curated collections are first-party only. A third-party
      // listing must be installed individually, where the store surfaces its
      // Community badge and caution (docs/developers/bundles.md).
      return { ok: false, error: `Member '${m.id}' is a community bundle — install it individually` };
    }
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
 * @returns {Router}
 */
/**
 * POST /bundles/api/repin — the owner's one-click re-pin of an add-on launcher
 * (Extensions "Needs re-pin"). Owner session only: a signed cross-host (peer)
 * request is refused — a peer must never be able to bless a launcher here.
 */
export async function handleRepinRequest(req, res, { crowHome = CROW_HOME } = {}) {
  if (req.crossHostAuth) return res.status(403).json({ error: "re-pin is an owner action on this instance" });
  const id = req.body && req.body.bundle_id;
  if (!id || !isValidBundleId(id)) return res.status(400).json({ error: "Invalid bundle ID" });
  try {
    const { repinAddon } = await import("../../../scripts/ops/pin-addon-command.mjs");
    const r = repinAddon({ crowHome, id });
    return res.json({ ok: true, message: `Re-pinned ${id}. Restart the gateway to start it.`, sha256: r.sha256 });
  } catch (e) {
    return res.status(400).json({ error: String((e && e.message) || e) });
  }
}

// Test seam: the reconnect the "Wall it again" route runs. Null uses proxy.js.
let _addonWallReconnectForTest = null;
export function _setAddonWallReconnectForTest(fn) { _addonWallReconnectForTest = fn || null; }

/**
 * Connect one add-on again after its wall mode changed. Never throws: a
 * reconnect failure is an answer (ok:false), not a broken route.
 */
async function reconnectForWall(id) {
  if (_addonWallReconnectForTest) {
    try { return (await _addonWallReconnectForTest(id)) || {}; } catch { return { ok: false, status: "error" }; }
  }
  try {
    const proxy = await import("../proxy.js");
    return (await proxy.reconnectAddonServer(id)) || {};
  } catch {
    return { ok: false, status: "error" };
  }
}

/**
 * POST /bundles/api/addon-wall/:id — the owner's "Wall it again".
 *
 * It can only ever set `walled`: the one way back to an unwalled add-on is the
 * Fix-it remedy, which is backed by a live failure record.
 */
export async function handleAddonWallRequest(req, res, { crowHome = CROW_HOME } = {}) {
  if (req.crossHostAuth) return res.status(403).json({ error: "walling an add-on is an owner action on this instance", code: "owner_only" });
  const id = req.params && req.params.id;
  if (!id || !isValidBundleId(id)) return res.status(400).json({ error: "Invalid bundle ID" });
  if (!req.body || req.body.mode !== "walled") return res.status(400).json({ error: "Only mode \"walled\" is accepted" });
  if (!(await isLocalOwner(req))) {
    return res.status(403).json({ error: "Only the owner at this machine's dashboard can change an add-on's wall", code: "owner_only" });
  }
  let written = false;
  try { written = setWallMode(crowHome, id, "walled"); } catch { written = false; }
  if (!written) return res.status(500).json({ error: "Could not save that choice. Try again." });
  const out = await reconnectForWall(id);
  return res.json({ ok: out.ok === true, status: typeof out.status === "string" ? out.status : null });
}

export default function bundlesRouter() {
  // Folder grants (follow-up B): grandfather the folders installed extensions already use,
  // once, before any request.
  try { _migrateGrantsForTest(); } catch (err) { console.warn(`[bundles] folder-grant migration: ${err.message}`); }
  const router = Router();

  // C4 Task 4: register this module's jobs Map as bot-engine-status's active-job
  // source. Inverted (bundles.js calls INTO bot-engine-status, not the reverse) so
  // bot-engine-status stays a leaf — it must never import this 2,500-line file.
  setActiveJobSource(activeJobFor);

  // Cross-host verification. dashboard/index.js routes ANY request bearing an
  // x-crow-signature header straight here, BEFORE dashboardAuth and CSRF — so a
  // bogus header would otherwise reach install/uninstall/restart/env with no auth
  // at all. Mount router-wide (not per-route): denylist-by-omission is how
  // /restart (unauthenticated gateway DoS) and /env (unauthenticated secret write)
  // stayed exposed. optional:true ⇒ unsigned requests fall through to the normal
  // dashboardAuth+CSRF mount, so the dashboard path is unaffected.
  const dbForXhost = createDbClient();
  const xhostVerify = crossHostVerifyMiddleware(dbForXhost, {
    optional: true, // non-signed requests fall through to dashboardAuth/OAuth
    audit: (req) => `bundle.${(req.path.split("/").pop() || "")}`,
    auditBundleId: true,
    // emptyBodyString stays at the default "{}" — bundle signers hash JSON.stringify(body || {})
  });
  router.use(xhostVerify);

  // Owner actions. A signed peer instance may start/stop, read status and Configure
  // (which never saves to the keychain for a peer, and whose result Start re-checks
  // without consent), never install, mint consent, uninstall or re-apply storage here:
  // a peer-minted consent token would let it apply a privileged bundle the owner never saw.
  const OWNER_ONLY = new Set(["/bundles/api/install", "/bundles/api/install-set", "/bundles/api/uninstall", "/bundles/api/repin", "/bundles/api/first-admin-done", "/bundles/api/first-admin-auto", "/bundles/api/first-admin-save", "/bundles/api/first-admin-invite", "/bundles/api/first-admin-close-signups"]);
  router.use((req, res, next) => {
    if (!req.crossHostAuth) return next();
    // Express matches routes case-insensitively and ignores a trailing slash: compare
    // the same normalized form, so /INSTALL or /install/ can't slip past.
    const p = String(req.path || "").toLowerCase().replace(/\/+$/, "").replace(/\/{2,}/g, "/");
    if (OWNER_ONLY.has(p) || p.startsWith("/bundles/api/consent-challenge/") || p.startsWith("/bundles/api/addon-wall/") || p.startsWith("/bundles/api/shared-storage/apply/")) {
      return res.status(403).json({ error: "This is an owner action on this instance; a peer instance can't perform it", code: "owner_only" });
    }
    return next();
  });

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

  // POST /bundles/api/first-admin-done — the operator says this app's setup is
  // finished (security audit N3-4). Nothing can detect that from the outside, so
  // the operator's word is the signal; it is remembered per install and locally
  // (never synced to a paired instance). Owner action: a peer has its own box.
  router.post("/bundles/api/first-admin-done", async (req, res) => {
    const bundleId = req.body && req.body.bundle_id;
    if (!bundleId || !isValidBundleId(bundleId)) return res.status(400).json({ error: "Invalid bundle ID" });
    const entry = getInstalled().find((i) => i && i.id === bundleId);
    if (!entry) return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    const db = createDbClient();
    try {
      const stamp = await markFirstAdminDone(db, bundleId, entry.installedAt || entry.installed_at || null);
      res.json({ ok: true, bundle_id: bundleId, install: stamp });
    } catch (err) {
      // Never the raw message (it can carry a path or a DB URL): a fixed sentence
      // for the page, the cause in the gateway log (review round 1, N6).
      console.warn(`[bundles] POST /bundles/api/first-admin-done failed: ${err?.message || err}`);
      res.status(500).json({ error: "Could not record that. Try again." });
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // POST /bundles/api/first-admin-auto — "Set it up for me" (N3-4 phase 2a): Crow runs
  // the bundle's own setup script, generates the admin password itself and keeps it in
  // its keychain. Owner action at this machine's dashboard only: an app's admin login
  // is not something a peer instance or a session made elsewhere may set.
  router.post("/bundles/api/first-admin-auto", async (req, res) => {
    if (!(await isLocalOwner(req))) {
      return res.status(403).json({ error: "Only the owner at this machine's dashboard can set up an app's admin login", code: "owner_only" });
    }
    const bundleId = req.body && req.body.bundle_id;
    if (!bundleId || !isValidBundleId(bundleId)) return res.status(400).json({ error: "Invalid bundle ID" });
    const entry = getInstalled().find((i) => i && i.id === bundleId);
    if (!entry) return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    // The REVIEWED manifest and script, never the installed copy: the installed folder
    // can be mounted into the bundle's own container, so its manifest and scripts are
    // not trusted to decide what Crow runs (the same rule as startConsent).
    const manifest = getManifest(bundleId);
    const plan = firstAdminSetupPlan(manifest);
    if (!plan) return res.status(400).json({ error: SETUP_UNAVAILABLE });
    if (plan.refused) {
      return res.status(400).json({ error: `Crow can't set up this app's admin login: ${plan.refused}`, code: "first_admin_unavailable" });
    }
    const out = await runFirstAdminSetup({
      bundleId,
      manifest,
      scriptDir: join(APP_BUNDLES, bundleId),
      destDir: join(BUNDLES_DIR, bundleId),
      installId: entry.installedAt || entry.installed_at || null,
      crowHome: CROW_HOME,
      deps: _firstAdminSetupDepsForTest || {},
    });
    // One run per bundle at a time, the install path's included (runFirstAdminSetup owns
    // the lock): two scripts racing to create the same account is exactly how an app ends
    // up with a login nobody knows.
    if (out.result === "busy") {
      return res.status(409).json({ error: "Crow is already setting up this app's admin login. Wait for it to finish." });
    }
    // "Crow creates, then closes": the manifest's after-step runs only once the app holds
    // Crow's password. Its own failure is reported, never treated as the setup's: the login
    // is saved either way.
    const name = manifest?.name || bundleId;
    const installId = entry.installedAt || entry.installed_at || null;
    let after = null;
    let afterResult = null;
    const log = [...(out.log || [])];
    if (out.result === "ok" && firstAdminAfterPlan(manifest)) {
      const step = await applyFirstAdminAfter({
        bundleId,
        manifest,
        destDir: join(BUNDLES_DIR, bundleId),
        recreate: recreateBundleGuarded,
      });
      if (step.line) log.push(step.line);
      if (!step.ok) log.push(firstAdminAfterFailureSentence(name));
      after = step.outcome;
      afterResult = { ok: step.ok, outcome: step.outcome };
    }
    // A follow-up step that failed leaves the app's door open while the card now reads as
    // finished, so it rings the same one bell the install path rings for this install. It is
    // stamped per install (an install that already rang stays silent — the card sentence is
    // the answer there); a follow-up that succeeded rings nothing, as on the install path.
    if (afterResult && !afterResult.ok) {
      await reportFirstAdminNotice({
        bundleId,
        manifest,
        bundleName: name,
        installId,
        autoResult: out.result,
        afterResult,
      });
    }
    // The card shows this sentence as-is; it never carries the password.
    res.json({
      ok: out.result === "ok",
      result: out.result,
      message: firstAdminResultMessage({
        result: out.result,
        name,
        user: typeof manifest?.firstAdmin?.user === "string" ? manifest.firstAdmin.user : null,
        reason: out.reason || null,
      }),
      // An ok can carry a reason (the app took the password, but Crow could not log in with
      // it to confirm): the card keeps that sentence under the "saved" line.
      ...(out.reason ? { reason: out.reason } : {}),
      // The after-step's own plain outcome (absent when this app declares none).
      ...(after ? { after } : {}),
      // ...and, when it did not finish, the sentence the card shows so a failed follow-up
      // never looks like success.
      ...(afterResult && !afterResult.ok ? { afterFailure: firstAdminAfterFailureSentence(name) } : {}),
      // The new login was written into the bundle's mcp-addons.json entry, which an MCP child
      // reads only when it is spawned. NOTHING restarts the gateway from here: a restart while
      // another bundle's install job runs kills that job (review round 3, finding 1). The card
      // shows the same "restart to apply" sentence Configure's save answers with.
      needs_restart: !!out.mcpEnvUpdated,
      log,
    });
  });

  // POST /bundles/api/first-admin-save — "Save the login you made": the operator's own
  // admin username + password for this app, into Crow's keychain under the bundle's
  // admin key. Owner action only, as above.
  router.post("/bundles/api/first-admin-save", async (req, res) => {
    if (!(await isLocalOwner(req))) {
      return res.status(403).json({ error: "Only the owner at this machine's dashboard can save an app's admin login", code: "owner_only" });
    }
    const bundleId = req.body && req.body.bundle_id;
    if (!bundleId || !isValidBundleId(bundleId)) return res.status(400).json({ error: "Invalid bundle ID" });
    const entry = getInstalled().find((i) => i && i.id === bundleId);
    if (!entry) return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    const rawUser = req.body.username;
    if (rawUser !== undefined && rawUser !== null && typeof rawUser !== "string") {
      return res.status(400).json({ error: "username must be text" });
    }
    const username = typeof rawUser === "string" ? rawUser.slice(0, 200) : "";
    const password = req.body.password;
    if (typeof password !== "string" || password === "" || password.length > 1024) {
      return res.status(400).json({ error: "Enter the password you use for this app." });
    }
    const saved = await saveFirstAdminLogin({
      bundleId,
      // The entry name comes from the reviewed copy, like the card and the auto route: the
      // installed copy can be written from inside the bundle's container. No reviewed copy →
      // the generic key (firstAdminSavedKey), and the name falls back to the bundle id.
      manifest: getManifest(bundleId) || null,
      username,
      password,
      crowHome: CROW_HOME,
      deps: _firstAdminSetupDepsForTest || {},
    });
    // A login Crow already keeps is changed in Settings → Passwords, never here (this form
    // is the way to give Crow one, not to overwrite the one it has).
    if (saved.result === "already") {
      return res.status(409).json({ error: "Crow already keeps a login for this app. Change it in Settings → Passwords." });
    }
    if (saved.result !== "saved") return res.status(500).json({ error: "Could not save the password. Try again." });
    // The operator's login also went into the bundle's MCP entry when it was written: the card
    // asks for the restart, this route never starts one (review round 3, finding 1).
    res.json({ ok: true, needs_restart: !!saved.mcpEnvUpdated });
  });

  // POST /bundles/api/first-admin-invite — the operator's own email, invited through
  // an app's admin API (security audit N3-4 phase 2e). Only the real Vaultwarden
  // bundle: the handler is resolved from the REVIEWED manifest (getManifest, bundled
  // with its bundle id — the installed copy can be written from inside the bundle's
  // container), and only the owner at this machine's dashboard. Sentences are fixed:
  // nothing from the app is echoed.
  router.post("/bundles/api/first-admin-invite", async (req, res) => {
    if (!(await isLocalOwner(req))) {
      return res.status(403).json({ error: "Only the owner at this machine's dashboard can invite an account", code: "owner_only" });
    }
    const bundleId = req.body && req.body.bundle_id;
    if (!bundleId || !isValidBundleId(bundleId)) return res.status(400).json({ error: "Invalid bundle ID" });
    const entry = getInstalled().find((i) => i && i.id === bundleId);
    if (!entry) return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    const manifest = getManifest(bundleId);
    const handler = inviteHandlerFor(manifest, bundleId);
    if (!handler) {
      return res.status(400).json({ error: "This extension does not invite anyone; there is nothing to invite.", code: "no_invite_handler" });
    }
    const rawEmail = req.body && typeof req.body.email === "string" ? req.body.email.trim().slice(0, 320) : "";
    const name = manifest?.name || bundleId;
    const out = await handler.inviteResult({
      email: rawEmail,
      installDir: join(BUNDLES_DIR, bundleId),
      // The reviewed manifest decides the port the admin token is sent to (B2).
      manifest,
      ...(_firstAdminInviteDepsForTest || {}),
    });
    // The card re-renders from a fresh read: never a stale "nobody is invited yet".
    clearInviteStateCache(bundleId);
    const message = inviteResultSentence(out.result, { email: rawEmail, name, signups: out.signups });
    if (out.result === "invalid-email") {
      return res.status(400).json({ ok: false, result: out.result, error: message });
    }
    if (out.result !== "invited" && out.result !== "already") {
      // A 200 with ok:false, like the auto route: the card shows the sentence, and the
      // failure is the app's state (no token, not running), not a broken request.
      return res.json({ ok: false, result: out.result, error: message });
    }
    return res.json({ ok: true, result: out.result, signups: out.signups, message });
  });

  // POST /bundles/api/first-admin-close-signups — close the app's sign-ups to
  // everyone, then re-read it. Owner action, invite-handler bundles only.
  router.post("/bundles/api/first-admin-close-signups", async (req, res) => {
    if (!(await isLocalOwner(req))) {
      return res.status(403).json({ error: "Only the owner at this machine's dashboard can close an app's sign-ups", code: "owner_only" });
    }
    const bundleId = req.body && req.body.bundle_id;
    if (!bundleId || !isValidBundleId(bundleId)) return res.status(400).json({ error: "Invalid bundle ID" });
    const entry = getInstalled().find((i) => i && i.id === bundleId);
    if (!entry) return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    const manifest = getManifest(bundleId);
    const handler = inviteHandlerFor(manifest, bundleId);
    if (!handler) {
      return res.status(400).json({ error: "This extension does not invite anyone; there is nothing to close.", code: "no_invite_handler" });
    }
    const name = manifest?.name || bundleId;
    const result = await handler.closeSignups({
      installDir: join(BUNDLES_DIR, bundleId),
      // The reviewed manifest decides the port the admin token is sent to (B2).
      manifest,
      ...(_firstAdminInviteDepsForTest || {}),
    });
    clearInviteStateCache(bundleId);
    const message = closeSignupsSentence(result, { name });
    if (result !== "off") return res.json({ ok: false, result, error: message });
    return res.json({ ok: true, result, message });
  });

  // GET /bundles/api/engine-blast — Uninstall blast-radius for the bot engine
  // (C4 Task 10): which enabled bot channels would stop working if bot-engine
  // is uninstalled. Reads pi_bot_defs directly (same async createDbClient()
  // client bot-builder's api-handlers.js already uses for this table — see
  // its save_gateways handler) rather than pulling in any bot-builder module,
  // so this route carries no dependency on the bot-builder panel.
  router.get("/bundles/api/engine-blast", async (req, res) => {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE enabled = 1",
        args: [],
      });
      const engineChannelSet = new Set(ENGINE_CHANNELS);
      const channels = [];
      for (const row of rows) {
        let def;
        try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
        const gateways = Array.isArray(def?.gateways) ? def.gateways : [];
        const types = [...new Set(
          gateways.map((gw) => gw && gw.type).filter((type) => engineChannelSet.has(type)),
        )];
        if (types.length > 0) {
          channels.push({ bot_id: row.bot_id, display_name: row.display_name, types });
        }
      }
      res.json({ channels });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // POST /bundles/api/addon-wall/:id — "Wall it again" on an installed add-on.
  // Owner at this machine only, and only ever toward `walled`.
  router.post("/bundles/api/addon-wall/:id", (req, res) => handleAddonWallRequest(req, res, { crowHome: CROW_HOME }));

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
    // Carries kept settings and a consent token: never cached.
    res.set("Cache-Control", "no-store");
    // The keys the install modal must gate on — the server's own list, so the
    // client can never disagree with validateInstall's 400.
    const installRequired = missingInstallEnv(bundleId, {}, manifest);
    // In-place reinstall: the form shows the kept values (never a secret's value).
    // Kept values go only to the owner at this machine's own dashboard; anyone else learns
    // which secrets are set (names only), never a value.
    const existing = existingInstallEnv(bundleId, manifest);
    const existingFields = { existing_secret_set: existing.secretSet };
    if (await isLocalOwner(req)) existingFields.existing_env = existing.values;
    // What the add-on can reach, from its manifest only: shown whether or not this
    // bundle needs consent, so no install form is silent about it.
    const wallFields = addonWallConsentFields(bundleId, manifest);
    if (!manifestRequiresConsent(manifest)) {
      return res.json({ required: false, install_required: installRequired, ...existingFields, ...wallFields });
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
        install_required: installRequired,
        ...existingFields,
        ...wallFields,
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

    // Before anything is copied or written: a bad key / multi-line value would
    // corrupt the bundle .env (and diverge from the gateway copy).
    const badEnv = findInvalidEnv(env_vars);
    if (badEnv) {
      return res.status(400).json({ code: "invalid_env", key: badEnv.key, error: `Environment variable '${badEnv.key}' ${badEnv.why}` });
    }

    const v = await validateInstall(bundle_id, {
      envVars: env_vars,
      consentToken: consent_token,
      forceInstall: !!req.body.force_install,
      requireEnv: true,
    });
    if (!v.ok) {
      return res.status(v.status).json({ error: v.error, ...(v.extra || {}) });
    }
    if (v.hardwareWarning) req._hardwareWarning = v.hardwareWarning;

    // D6.9: a collection install-set owns the process's next restart and runs
    // its members with deferred restart; a single install finishing mid-set
    // would fire scheduleGatewayRestart() itself and kill the set runner.
    // Checked here — immediately before createJob, after validateInstall's
    // await has already settled — so nothing can race past this point into
    // job creation.
    if (isInstallSetRunning()) {
      return res.status(409).json({ error: "A collection install is in progress — wait for it to finish and try again." });
    }

    // C4 Task 3 (r1 critical #4): refuse a second concurrent install of the
    // SAME bundle — without this, two rapid clicks (or a client retry racing
    // its own in-flight request) run runInstallJob twice concurrently against
    // the same destDir. `error` is required: the shipped extensions client
    // renders res.data.error verbatim on a non-ok install (client.js:425).
    const existingJob = activeJobFor(bundle_id);
    if (existingJob) {
      return res.status(409).json({
        code: "already_installing",
        job_id: existingJob.id,
        error: `${bundle_id} is already installing (job ${existingJob.id}) — attach to that job instead of starting a new install.`,
      });
    }

    // Create job for async tracking
    // Keychain saves (and a vault login) are the owner's: the same local-password,
    // off-box check as every other owner action, not merely "a session exists".
    const owner = await isLocalOwner(req);
    const keychainReq = sanitizeKeychainRequest(req.body?.keychain, { localSession: owner });
    if (!owner && env_vars && typeof env_vars === "object") {
      // The same rule as Configure: a non-owner (a peer sign-in session) can't point a setting
      // the compose file uses at a host path, at install either.
      let used = new Set();
      try { used = composeReferencedKeys(readFileSync(join(APP_BUNDLES, bundle_id, "docker-compose.yml"), "utf8")); } catch { /* no compose */ }
      const bad = Object.keys(env_vars).filter((k) => used.has(k) && reachesHostPath(env_vars[k]));
      if (bad.length) return res.status(403).json({ code: "folder_needs_owner", key: bad[0], error: `Folder settings (${bad.join(", ")}) are set from this machine's own dashboard, signed in with its password.` });
    }
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
        keychain: keychainReq,
        ownerEnv: owner ? env_vars : null,
        editedEnv: Array.isArray(req.body.env_edited) ? req.body.env_edited.filter((k) => typeof k === "string") : null,
      });
      if (!out.ok) {
        finishJob(job, "failed");
        // A compose-up failure still installs the panel / MCP server / gateway
        // env (runInstallJob reports needsRestart for those); load them so
        // Configure + Start finishes the bundle without another restart dance.
        if (out.needsRestart) {
          console.log(`[bundles] ${bundle_id}: install failed after non-container steps — restarting gateway to load them`);
          scheduleGatewayRestart(3000);
        }
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

    const collection = getCollection(collection_id, _collectionsPathOverride || undefined);
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
          // Test-only barrier (see _setInstallSetBarrierForTest) — null in
          // production, so this branch is never entered: no await, no timer.
          if (_installSetBarrier) await _installSetBarrier;
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
          });
          if (!out.ok) {
            if (out.needsRestart) anyRestart = true; // compose failed, but its panel/MCP landed
            // A compose-failed member is still RECORDED installed (Configure +
            // Start finishes it) — so it belongs in the NEEDS_CONFIG checklist.
            if (getInstalled().some((i) => i.id === member.id)) {
              const failedKeys = needsConfigKeys(member.id);
              if (failedKeys.length > 0) needsConfig.push({ id: member.id, keys: failedKeys });
            }
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
    // Fallback-password retention keys on volumes ACTUALLY removed (a refused/failed down -v keeps them).
    let volumesRemoved = false;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const orchRefusal = bundleOrchestrationRefusal(bundle_id);
    if (orchRefusal) return res.status(orchRefusal.status).json({ error: orchRefusal.error, code: orchRefusal.code });

    if (getInstalled().some((i) => i.id === bundle_id && isSatelliteEntry(i))) {
      return res.status(409).json({ error: `Bundle '${bundle_id}' is installed on a server; remove it from Extensions › Servers`, code: "installed_on_satellite" });
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

    // The projects whose connections this uninstall pauses (read-only, project services Task 12).
    // Awaited HERE, before the install-set check below: nothing may await between that check
    // and createJob (D6.9). This list names only NON-ARCHIVED projects, the ones the owner can
    // act on. job.affectedProjects is a second list: it starts empty and is filled only by the
    // job, with every project whose rows it actually paused (markConnectionsNeedInstall's
    // RETURNING, archived projects included); a job that fails first reports none.
    const affectedProjects = await (_uninstallAffectedForTest || uninstallAffectedProjects)(bundle_id);

    // D6.9: same reverse guard as /install — an uninstall finishing mid-set
    // would fire its own restart and kill the set runner. Checked immediately
    // before createJob so nothing can race past this point into job creation.
    if (isInstallSetRunning()) {
      return res.status(409).json({ error: "A collection install is in progress — wait for it to finish and try again." });
    }

    const job = createJob(bundle_id, "uninstall");
    job.affectedProjects = [];
    res.json({ ok: true, job_id: job.id, message: `Removing ${bundle_id}...`, affectedProjects });

    (async () => {
      try {
        const manifest = getManifest(bundle_id);
        const addonType = manifest?.type || "bundle";

        // 1. Type-specific cleanup
        if (addonType === "bundle") {
          const composePath = join(bundleDir, "docker-compose.yml");
          if (existsSync(composePath)) {
            const own = await composeOwnership(bundle_id, bundleDir, getInstalledFirstManifest(bundle_id));
            if (own.warning) appendLog(job, `Note: ${own.warning}`);
            if (own.refusal) {
              appendLog(job, `Containers left running: ${own.refusal}`);
            } else {
              if (manifest?.autowire === AUTOWIRE_KIND && readStoredNtfyConfig()) {
                // Revoke this instance's tokens while the server is still up, then forget them.
                await deprovisionNtfy({ runner: dockerRunner() });
                appendLog(job, "Phone notifications turned off (this Crow's notification tokens were revoked)");
              }
              appendLog(job, "Stopping containers...");
              const downArgs = ["down", "--remove-orphans"];
              if (delete_data) downArgs.push("-v");
              try {
                await runComposeTeardown(downArgs, { cwd: bundleDir });
                if (delete_data) volumesRemoved = true;
                appendLog(job, delete_data ? "Containers stopped, volumes removed" : "Containers stopped (data preserved)");
              } catch (err) {
                appendLog(job, `Warning: docker compose down: ${err.message}`);
                // Removing the folder now would leave running containers with no compose
                // file to stop them from: keep the extension installed instead.
                const blank = err.blankKeys || (MISSING_VAR_RE.test(`${err?.stderr || ""}\n${err?.message || ""}`) ? blankHardFailKeys(bundleDir) : []);
                const fix = blank.length ? ` Set ${blank.join(", ")} in Configure, then uninstall again.` : "";
                const project = own.project || basename(bundleDir);
                let running = false;
                let checkError = null;
                try { running = await composeProjectRunning(project); } catch (e) { checkError = String(e?.stderr || e?.message || e).trim().split("\n")[0]; }
                if (running) {
                  appendLog(job, `Containers are still running and could not be stopped; the extension was left installed so you can stop it.${fix}`);
                  finishJob(job, "failed");
                  return;
                }
                if (checkError !== null && blank.length) {
                  // Docker answers nothing, and the compose file can't be read without these
                  // values: keep it, so the containers can still be stopped later.
                  appendLog(job, `Containers may still be running (could not check: ${checkError}); the extension was left installed so you can stop it.${fix}`);
                  finishJob(job, "failed");
                  return;
                }
                if (checkError !== null) appendLog(job, `Note: could not check: ${checkError}. Nothing marks the containers as running, so the uninstall continues`);
              }
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
          removePanelEnabled(bundle_id);
        } else if (addonType === "panel") {
          // Remove from panels.json and delete panel file
          removePanelEnabled(bundle_id);
          if (manifest?.panel) {
            const panelPath = resolvePanelPath(manifest, bundle_id);
            const panelFile = panelPath ? join(PANELS_DIR, panelPath.split("/").pop()) : null;
            if (panelFile && existsSync(panelFile)) rmSync(panelFile);
            appendLog(job, "Removed panel file and registration");
          }
        }

        // 1b. Handle panel cleanup for any add-on type
        let needsRestart = false;
        if (manifest && manifest.panel && addonType !== "panel") {
          const panelPath = resolvePanelPath(manifest, bundle_id);
          const panelFilename = panelPath ? panelPath.split("/").pop() : null;
          const panelDest = panelFilename ? join(CROW_HOME, "panels", panelFilename) : null;
          const panelId = panelFilename ? panelFilename.replace(/\.js$/, "") : null;
          // Remove panel file
          if (panelDest && existsSync(panelDest)) {
            unlinkSync(panelDest);
          }
          // Remove from panels.json (either shape)
          if (panelId) removePanelEnabled(panelId);
          needsRestart = true;
          if (panelFilename) appendLog(job, `Removed panel: ${panelFilename}`);
        }

        // 2. Remove associated skills (all types can have skills)
        // Review L7: only copies provably ours and unedited are deleted; an
        // edited copy (or the operator's symlink) is kept and logged.
        if (manifest?.skills) {
          const { removed, kept } = removeBundleSkills({
            id: bundle_id, manifest, src: join(BUNDLES_DIR, bundle_id), skillsDir: SKILLS_DIR,
            recordPath: SKILL_RECORD_PATH, ledger: readSkillLedger(APP_BUNDLES),
          });
          for (const k of removed) appendLog(job, `Removed skill: ${k}`);
          for (const k of kept) appendLog(job, `Kept skill ${k}: it was edited after install (delete it in Skills if you no longer want it)`);
        }

        // 3. Re-comment env vars in gateway .env
        if (addonType === "bundle" && manifest?.env_vars) {
          revertEnvInGateway(gatewayEnvNames(manifest));
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

        // 4b. Tear down a proxied web UI. The gateway keeps its /proxy/<id>
        // route until it restarts, so this flips needsRestart the same way a
        // removed panel does.
        if (manifest?.webUI) {
          needsRestart = true;
        }

        // 5. Remove bundle files — first keeping every generated secret's effective value
        // (incl. one an older install typed, or ran on as a compose fallback) for a reinstall.
        let composeTextForRetain = null;
        try { const cp = join(bundleDir, "docker-compose.yml"); if (existsSync(cp)) composeTextForRetain = readFileSync(cp, "utf8"); } catch {}
        const keptSecrets = retainGeneratedForReinstall(bundle_id, manifest, { destDir: bundleDir, crowHome: CROW_HOME, composeText: composeTextForRetain, includeFallbacks: !volumesRemoved });
        if (keptSecrets) appendLog(job, `Kept ${keptSecrets} generated secret(s) / library path(s) for a later reinstall (mode 600)`);
        rmSync(bundleDir, { recursive: true, force: true });
        appendLog(job, "Bundle files removed");

        // 6. Update installed.json
        const previousEntry = getInstalled().find((i) => i.id === bundle_id) || null;
        const installed = getInstalled().filter((i) => i.id !== bundle_id);
        saveInstalled(installed);
        appendLog(job, "Installation record removed");
        // Review item 5: uninstall never removes the add-on's own data folder (whatever
        // `delete_data` did to its containers' volumes). It is recorded as Crow's own kept
        // data only when it is provably the folder Crow made: a folder swapped in since the
        // install is never re-recorded (addon-walls-file.js decides, and explains in the log).
        try {
          recordKeptDataOnUninstall(bundle_id, {
            crowHome: CROW_HOME,
            dataDir: resolveDataDir(),
            log: (line) => appendLog(job, line),
          });
        } catch (err) {
          console.warn(`[bundles] could not record the kept data folder for '${bundle_id}': ${err?.message || err}`);
        }
        // Its project connections' children stop now (their rows are paused just below).
        try { await stopChildrenForBundle(bundle_id); } catch { appendLog(job, "Warning: could not stop this extension's project connections"); }
        const keptPasswords = await markBundleKeychainRemoved(bundle_id, {
          onPaused: (projects) => {
            // The projects whose connections this uninstall paused (needs_install, secrets kept).
            job.affectedProjects = projects;
            if (projects.length) appendLog(job, `Paused this extension's connections in ${projects.length} project(s) until it is installed again`);
          },
        });
        if (keptPasswords) appendLog(job, `Kept ${keptPasswords} saved password(s) in Crow keychain, marked "extension removed" (Settings → Security & passwords → Saved passwords & keys)`);

        // Its "Finish <app>'s setup now" card and bell are about an app that is gone
        // (audit N5-4). The card follows installed.json; the bell has to be dismissed,
        // or it outlives the app it asked about.
        try {
          const noticeDb = createDbClient();
          try {
            const cleared = await clearFirstAdminNotice(noticeDb, bundle_id, {
              installId: (previousEntry && (previousEntry.installedAt || previousEntry.installed_at)) || null,
            });
            if (cleared.dismissed) appendLog(job, "Cleared its finish-setup notice");
          } finally {
            noticeDb?.close();
          }
        } catch { appendLog(job, "Note: could not clear its finish-setup notice"); }

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
        // The install registered them under the manifest id (registerProviderFromManifest:
        // bundleId = manifest.id), which is this bundle's id.
        let providerDb;
        try {
          providerDb = createDbClient();
          const r = await unregisterProvidersByBundle(providerDb, manifest?.id || bundle_id);
          if (r.disabled > 0) {
            appendLog(job, `Disabled ${r.disabled} provider(s) registered by bundle`);
            invalidateProvidersCache();
          }
        } catch (err) {
          appendLog(job, `Provider unregister skipped: ${err.message}`);
        } finally {
          try { providerDb?.close(); } catch {}
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

        // Auto-restart gateway after uninstall if panels/servers/web UIs were removed
        if (needsRestart) {
          scheduleGatewayRestart(3000);
        }
      } catch (err) {
        appendLog(job, `Error: ${err.message}`);
        finishJob(job, "failed");
      }
    })();
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
    const orchRefusal = bundleOrchestrationRefusal(bundleId);
    if (orchRefusal) return res.status(orchRefusal.status).json({ error: orchRefusal.error, code: orchRefusal.code });

    const bundleDir = join(BUNDLES_DIR, bundleId);
    const composePath = join(bundleDir, "docker-compose.yml");
    if (!existsSync(composePath)) {
      return res.status(404).json({ error: `Bundle '${bundleId}' has no Docker containers` });
    }
    try {
      const own = await composeOwnership(bundleId, bundleDir, getInstalledFirstManifest(bundleId));
      if (own.refusal) return res.status(409).json({ error: own.refusal, code: "compose_project_foreign" });
      if (own.warning) console.warn(`[bundles] ${bundleId} ${action}: ${own.warning}`);
      if (action === "start") {
        // The same check as install, on what Compose will apply NOW (Configure may have
        // changed .env; an override may sit next to the file). The installed bundle was
        // consented to at install, so a consent bundle keeps its consent here.
        const sc = startConsent(bundleId, { crossHost: !!req?.crossHostAuth });
        const gate = await checkBundleCompose(bundleDir, { bundleId, manifest: sc.manifest, consentVerified: sc.consentVerified, textCheck: false });
        if (!gate.valid) return res.status(403).json({ error: `Security check failed: ${gate.reason}`, code: "compose_security_check" });
        const content = readFileSync(composePath, "utf8");
        const upArgs = /^\s+build:/m.test(content) ? ["up", "-d", "--build"] : ["up", "-d"];
        // recreate:true (the Configure dialog's explicit Restart): new env only
        // reaches a container that is re-created, so force it.
        if (req?.body?.recreate === true) upArgs.push("--force-recreate");
        await runCompose(upArgs, { cwd: bundleDir });
        // The containers were just (re)created from the installed compose: re-run the
        // bind-drift check for this bundle so a "restart to apply" card clears now,
        // without waiting for the next gateway start (N8-1).
        rebindDriftCheck(bundleId);
      } else if (action === "stop") {
        await runComposeTeardown(["stop"], { cwd: bundleDir });
        // Nothing is running any more, so no bind can be wider than the compose:
        // the drift card must resolve now, not at the next boot.
        rebindDriftCheck(bundleId);
      } else {
        return res.status(400).json({ error: `unsupported action: ${action}` });
      }
      return res.json({ ok: true, message: `Bundle '${bundleId}' ${action}ped` });
    } catch (err) {
      return res.status(500).json({ error: `Failed to ${action}: ${err.stderr || err.message}` });
    }
  }

  // POST /bundles/api/start — Start bundle containers (local or peer)
  router.post("/bundles/api/repin", (req, res) => handleRepinRequest(req, res));

  router.post("/bundles/api/start", async (req, res) => {
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
  router.post("/bundles/api/stop", async (req, res) => {
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
  router.post("/bundles/api/env", async (req, res) => {
    // async (M8's compose ps) → Express 4 no longer catches a sync throw here:
    // a rejected handler promise is an unhandled rejection, which the crash
    // guard re-throws and the gateway dies. Every throw becomes a 500 instead.
    try {
      const { bundle_id } = req.body;
      let { env_vars } = req.body;

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
      // Generated secrets are never operator input — a request cannot rotate a DB
      // password out from under its database.
      env_vars = stripGeneratedKeys(getInstalledFirstManifest(bundle_id), env_vars);
      // Validate BEFORE writing either file, so the bundle .env and the gateway
      // .env can never hold different copies of the same secret.
      const badEnv = findInvalidEnv(env_vars);
      if (badEnv) {
        return res.status(400).json({ code: "invalid_env", key: badEnv.key, error: `Environment variable '${badEnv.key}' ${badEnv.why}` });
      }
      const badPattern = envPatternViolation(getInstalledFirstManifest(bundle_id), env_vars);
      if (badPattern) {
        return res.status(400).json({ code: "invalid_env", key: badPattern.key, error: `Environment variable '${badPattern.key}' ${badPattern.why}` });
      }

      // Folders outside Crow's home (follow-up B): only the owner at this machine's own
      // dashboard sets one; a peer's or a peer sign-in's request that tries is refused.
      const owner = await isLocalOwner(req);
      let folderKeys = new Set();
      try { folderKeys = composeReferencedKeys(readFileSync(join(bundleDir, "docker-compose.yml"), "utf8")); } catch { /* no compose */ }
      const homeForGrants = process.env.HOME || homedir();
      const pathishKeys = Object.keys(env_vars).filter((k) => folderKeys.has(k) && reachesHostPath(env_vars[k]));
      if (pathishKeys.length && !owner) {
        return res.status(403).json({ code: "folder_needs_owner", key: pathishKeys[0], error: `Folder settings (${pathishKeys.join(", ")}) are set from this machine's own dashboard, signed in with its password.` });
      }

      // Read the existing .env. The save is LINE-PRESERVING (C4): only the submitted
      // keys change; every other line (legacy values, comments) stays byte-for-byte.
      const envPath = join(bundleDir, ".env");
      const oldEnvText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      const existing = parseEnvText(oldEnvText);

      // env_vars[].previous_key (tax's encryption key): a key change that does not fill the
      // previous-key slot itself keeps the outgoing key there, so returns saved with it stay
      // readable. The outgoing key is the one the MCP child will start with (its entry, the
      // gateway env, this .env). The slot always takes the key just replaced: the tax
      // server moves every return to the current key when it starts, so an older key in
      // the slot only still matters if it did not start since the last change — the
      // warning (key names only) says so.
      const keyWarnings = [];
      // The `previous_key` slots THIS request made the server fill: those values are the
      // server's, not the owner's, so they are never recorded as owner-entered.
      const injectedSlots = [];
      {
        const entryEnv = readJsonSafe(MCP_ADDONS_PATH, {})?.[bundle_id]?.env || {};
        for (const v of getInstalledFirstManifest(bundle_id)?.env_vars || []) {
          const prev = v && typeof v.previous_key === "string" ? v.previous_key : null;
          if (!prev || env_vars[v.name] === undefined || env_vars[v.name] === "" || env_vars[prev] !== undefined) continue;
          const next = String(env_vars[v.name]);
          const old = entryEnv[v.name] || process.env[v.name] || existing[v.name] || "";
          if (!old || old === next) continue;
          const kept = entryEnv[prev] || process.env[prev] || existing[prev] || "";
          env_vars[prev] = old;
          injectedSlots.push(prev);
          if (kept && kept !== old && kept !== next) {
            keyWarnings.push(`${prev} now holds the key you just replaced (it held an older one). Data still on that older key, only if the extension did not restart since the last change, opens only if you enter it in ${prev}.`);
          }
        }
      }

      // Keys whose value this save actually changes (names only, never values).
      const changedKeys = Object.keys(env_vars).filter((k) => {
        const next = env_vars[k];
        if (next === undefined) return false;
        return existing[k] === undefined ? String(next) !== "" : String(existing[k]) !== String(next);
      });

      Object.assign(existing, env_vars); // the effective env after this save
      writePrivateFile(envPath, updateEnvText(oldEnvText, env_vars, { pathKeys: pathEnvKeys(getInstalledFirstManifest(bundle_id)) }));
      const folderWarnings = [];
      if (owner && folderKeys.size) {
        // The owner typed these folders here: allow them (a default is not a choice). Only
        // keys this save CHANGES: an unchanged value may have been written by something else
        // (a hand edit, a CLI install, a container that can write the .env), and the form
        // sends every filled field. A changed key the owner set to anything else loses its
        // grant; an unchanged one keeps whatever it had.
        const changed = new Set(changedKeys);
        const man = getInstalledFirstManifest(bundle_id);
        let composeTextG = "";
        try { composeTextG = readFileSync(join(bundleDir, "docker-compose.yml"), "utf8"); } catch { /* none */ }
        let exampleEnv = {};
        try { exampleEnv = parseEnvText(readFileSync(join(bundleDir, ".env.example"), "utf8")); } catch { /* none */ }
        // The form prefills (and sends) the manifest default: a default or an example is never
        // taken as the owner's choice, here as at install.
        try { migrateGrants({ crowHome: CROW_HOME, dataDirs: dataDirsForGrants(), home: homeForGrants }); } catch { /* best-effort */ }
        const refused = {};
        const submittedChanged = Object.fromEntries(Object.entries(env_vars).filter(([k]) => changed.has(k)));
        const g = grantCandidates({ manifest: man, submitted: submittedChanged, composeText: composeTextG, exampleEnv, crowHome: CROW_HOME, dataDirs: dataDirsForGrants(), home: homeForGrants, appRoot: APP_ROOT, otherRoots: otherBundlesRoots(bundle_id, { crowHome: CROW_HOME, home: homeForGrants }), refused });
        await dropSharedFolderConflicts(bundle_id, g, refused);
        recordGrants(CROW_HOME, bundle_id, g);
        dropGrants(CROW_HOME, bundle_id, [...changed].filter((k) => folderKeys.has(k) && !g[k]));
        // Say why a folder this save names is still not allowed (Start would refuse it).
        let ungranted = [];
        try { ungranted = ungrantedFolderKeys(bundle_id, { crowHome: CROW_HOME, dataDirs: dataDirsForGrants(), home: homeForGrants, bundleDir, appRoot: APP_ROOT }); } catch { /* none */ }
        for (const k of ungranted) {
          if (env_vars[k] === undefined) continue;
          const why = refused[k] || (changed.has(k)
            ? "it can't be allowed"
            : "it did not change in this save, and a folder is allowed only when you type it here (retype it, for example with a trailing /)");
          folderWarnings.push(`${k} was saved, but its folder is not allowed, so the extension will not start with it: ${why}.`);
        }
      }
      keyWarnings.push(...folderWarnings);
      // The owner check made at the top of this route (local password session, off-box).
      const keychainReq = sanitizeKeychainRequest(req.body?.keychain, { localSession: owner });
      // keychain_configure:false fields (Workspace admin password): setup applied the stored value
      // once and Configure cannot re-apply a new one, so never overwrite the stored copy here.
      const noConfigureKc = new Set((getInstalledFirstManifest(bundle_id)?.env_vars || []).filter((v) => v && v.keychain_configure === false).map((v) => v.name));
      keychainReq.save = keychainReq.save.filter((k) => !noConfigureKc.has(k));
      const kcLog = [];
      const kc = keychainReq.save.length
        ? await recordKeychainForInstall({ bundleId: bundle_id, manifest: getInstalledFirstManifest(bundle_id), env: existing, minted: {}, keychainReq, log: (m) => kcLog.push(m) })
        : null;

      // Also configure the MCP child, which reads mcp-addons.json — not this .env. `owner` is
      // the check made at the top of this route: only the local owner's own request leaves
      // provenance behind (a peer's or a token's save proves nothing about who typed what).
      const mcpUpdated = applyEnvToMcpAddons(bundle_id, env_vars, MCP_ADDONS_PATH, getInstalledFirstManifest(bundle_id), {
        edited: owner ? changedKeys : [],
        injected: injectedSlots,
        owner,
      });

      // And the gateway's own env, exactly as install does for docker bundles:
      // gateway-side panel routes read their config from process.env (the phone
      // bundle's PHONE_RUNNER_SECRET), so a value entered here never reached them.
      // Only keys the manifest declares — never arbitrary request keys.
      const gatewayUpdated = propagateBundleEnvToGateway(bundle_id, env_vars);
      const needsRestart = mcpUpdated || gatewayUpdated;

      // B4: a running container keeps the env it was created with. When the
      // compose file consumes a key this save changed (minio's root creds: the
      // gateway's copy moves, the container's does not), say so and name the
      // keys; the client offers an explicit Restart (start with recreate:true →
      // `up -d --force-recreate`). Nothing is restarted implicitly here.
      let bundleRestartKeys = [];
      const composePathForEnv = join(bundleDir, "docker-compose.yml");
      if (changedKeys.length > 0 && existsSync(composePathForEnv)) {
        try {
          const consumed = composeConsumedKeys(readFileSync(composePathForEnv, "utf8"));
          bundleRestartKeys = changedKeys.filter((k) => consumed.all || consumed.keys.has(k));
        } catch { /* unreadable compose → no claim either way */ }
      }
      // Only a RUNNING container holds stale values. A stopped one picks the new
      // .env up on its next start, and offering "Restart now" there would start
      // a bundle the operator had stopped. Unknown (ps failed) → assume running:
      // a needless warning beats a silently stale container.
      let bundleRunning = false;
      if (bundleRestartKeys.length > 0) {
        bundleRunning = await composeServiceRunning(bundleDir);
      }
      const needsBundleRestart = bundleRestartKeys.length > 0 && bundleRunning;
      const appliesOnNextStart = bundleRestartKeys.length > 0 && !bundleRunning;

      // RE-DERIVE config state from the files we just wrote and hand it back: the
      // client must not decide "configured" itself. submitConfigureOnly guards only
      // the all-blank case and its `if (inp && inp.value)` accepts whitespace (which
      // needsConfigKeys trims away), so filling 1 of 12 keys still 200s — a client
      // that cleared its badge on any 200 would hide a still-unconfigured bundle.
      // Key NAMES only; never values (D5).
      let message = needsRestart
        ? (mcpUpdated
          ? "Environment variables saved — restart the gateway to apply them to the MCP server"
          : "Environment variables saved — restart the gateway to apply them")
        : "Environment variables saved";
      if (needsBundleRestart) {
        message += `. Restart the bundle to apply ${bundleRestartKeys.join(", ")} to its container — it keeps its old values until then`;
      } else if (appliesOnNextStart) {
        message += `. The bundle is not running; ${bundleRestartKeys.join(", ")} will apply on its next start`;
      }
      if (keyWarnings.length) message += `. ${keyWarnings.join(" ")}`;
      res.json({
        ok: true,
        message,
        ...(keyWarnings.length ? { warnings: keyWarnings } : {}),
        needs_restart: needsRestart,
        needs_bundle_restart: needsBundleRestart,
        applies_on_next_start: appliesOnNextStart,
        bundle_restart_keys: bundleRestartKeys,
        needs_config: needsConfigKeys(bundle_id),
        keychain: kc ? { saved: kc.saved, vault: kc.vault, messages: kcLog } : null,
      });
    } catch (err) {
      console.warn(`[bundles] POST /bundles/api/env failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: `Failed to save environment: ${err?.message || err}` });
    }
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
    const orchRefusal = bundleOrchestrationRefusal(bundleId);
    if (orchRefusal) return res.status(orchRefusal.status).json({ error: orchRefusal.error, code: orchRefusal.code });

    const manifest = getManifest(bundleId);
    if (!manifest?.storage?.translator) {
      return res.status(400).json({ error: `Bundle '${bundleId}' does not declare manifest.storage.translator` });
    }
    const bundleDir = join(BUNDLES_DIR, bundleId);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundleId}' is not installed` });
    }

    try {
      // Same ownership guard as start/stop: never recreate another install's containers.
      const own = await composeOwnership(bundleId, bundleDir, getInstalledFirstManifest(bundleId));
      if (own.refusal) return res.status(409).json({ error: own.refusal, code: "compose_project_foreign" });
      const injected = await injectSharedStorage({
        destDir: bundleDir,
        bundleId,
        translator: manifest.storage.translator,
        bucketSuffix: manifest.storage.bucket || bundleId,
      });
      if (injected === null) {
        return res.status(400).json({ error: "No shared-storage config in DB. Enter MinIO endpoint + credentials in Settings → Shared Storage first." });
      }
      // Force-recreate so the affected containers pick up the new env: the same guarded path
      // every non-interactive recreate uses (consent + compose safety check + ownership).
      const rec = await recreateBundleGuarded(bundleId);
      if (!rec.ok) {
        const status = rec.code === "compose_project_foreign" ? 409 : rec.code === "compose_security_check" ? 403 : 500;
        return res.status(status).json({ error: rec.reason, ...(rec.code ? { code: rec.code } : {}) });
      }
      res.json({ ok: true, version: injected.version, recreated: rec.recreated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
