/**
 * Save one login item into the user's own local Vaultwarden with the official Bitwarden
 * CLI (@bitwarden/cli, a dependency of the vaultwarden bundle — installed beside it).
 *
 * Secrets: the master password travels ONLY in the login step's env (--passwordenv);
 * the item JSON travels on stdin (base64, `create item` reads it when no arg is given);
 * the session key travels in BW_SESSION. The vault email IS a `login` argument (bw has no
 * env/stdin form for it; spec R11). Every step runs with a minimal env inside a private
 * mkdtemp dir under <CROW_HOME>/tmp (BITWARDENCLI_APPDATA_DIR = HOME = that dir), removed
 * in finally; dirs a crash left behind are swept on the next run. When `prlimit` exists the
 * CLI runs with core dumps off, so a crash cannot write the master password to disk.
 * One overall deadline (90 s) bounds the whole save. Failures come back as fixed
 * sentences; CLI output is never echoed.
 *
 * Post-spike rulings (Task 6, CLI pinned at 2026.8.0):
 * - R-B: every CLI version refuses http:// servers, so the status reports `secure` and a
 *   non-https serverUrl is refused (VAULT_REASONS.insecureUrl) before anything is spawned.
 * - R-D: one stable vault device per Crow instance. Only a device GUID is persisted, in
 *   <CROW_HOME>/secrets/vault-device-id (600 in a 700 dir, beside the keychain key. The
 *   r4 and pi-lab backups do not copy secrets/; a container instance's whole-volume tar would, so its
 *   backup.sh excludes the whole secrets dir (spec §9.7)); each save seeds a fresh appdata dir's data.json with it.
 *   Session, tokens and keys never outlive a save.
 * - R-E: reasons are only the fixed VAULT_REASONS sentences, never CLI stdout/stderr.
 */
import { spawn } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync, rmSync, statSync,
  openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { BUNDLES_DIR, CROW_HOME } from "../bundles-config.js";
import { parseEnvText } from "../bundle-env-codec.js";

export const VAULT_REASONS = Object.freeze({
  missingCli: "The Bitwarden command-line tool is not installed. Update the Vaultwarden extension, then try again.",
  badInput: "Enter your vault email and master password.",
  wrongCredentials: "Vaultwarden did not accept that email or master password.",
  twoStep: "Your vault account uses two-step login, which Crow cannot complete. Add this password to your vault by hand (Settings → Passwords shows it).",
  unreachable: "Crow could not reach your Vaultwarden. Is it running?",
  timeout: "Vaultwarden took too long to answer.",
  createFailed: "Crow signed in to your vault but could not create the item.",
  failed: "Saving to Vaultwarden did not work.",
  insecureUrl: "Vault saving needs Vaultwarden on a secure https address — see the Vaultwarden setup page.",
});

/**
 * data.json `stateVersion` the seeded appdata dir declares. Tied to the @bitwarden/cli
 * 2026.8.0 pin (the spike read 83 from that release); bump it together with the pin.
 */
export const BW_STATE_VERSION = 83;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isHttps = (url) => typeof url === "string" && /^https:\/\//i.test(url);

const STALE_MS = 10 * 60 * 1000;
const PRLIMIT = ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p)) || null;

/**
 * serverOutdated: an install that predates vaultwarden 1.1.0 keeps its OLD compose file (a
 * docker refresh never touches docker-compose.yml), and Vaultwarden < 1.37 does not support
 * Bitwarden clients 2026.7.0+ (re-review m4) — say so instead of failing with "create failed".
 */
export function vaultwardenStatus({ bundlesDir = BUNDLES_DIR } = {}) {
  const dir = join(bundlesDir, "vaultwarden");
  if (!existsSync(dir)) return { installed: false, cliPath: null, serverUrl: null, secure: false, serverOutdated: null };
  const cli = join(dir, "node_modules", "@bitwarden", "cli", "build", "bw.js");
  // The URL the CLI must use: VAULTWARDEN_DOMAIN (what Vaultwarden advertises — the https
  // Serve address once set up) else VAULTWARDEN_URL else the default (R-B).
  let url = "http://localhost:8097";
  try {
    const env = parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
    url = env.VAULTWARDEN_DOMAIN || env.VAULTWARDEN_URL || url;
  } catch { /* default */ }
  let serverOutdated = null;
  try {
    const m = readFileSync(join(dir, "docker-compose.yml"), "utf8").match(/vaultwarden\/server:(\d+)\.(\d+)\.(\d+)/);
    if (m && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 37))) {
      serverOutdated = `Reinstall the Vaultwarden extension to update its server: saving to the vault needs Vaultwarden 1.37 or newer, and this install runs ${m[1]}.${m[2]}.${m[3]}. Your vault data is kept.`;
    }
  } catch { /* no compose file: nothing to judge */ }
  const serverUrl = url.replace(/\/+$/, "");
  return { installed: true, cliPath: existsSync(cli) ? cli : null, serverUrl, secure: isHttps(serverUrl), serverOutdated };
}

export function vaultDeviceIdPath(crowHome = CROW_HOME) {
  return join(crowHome, "secrets", "vault-device-id");
}

function readDeviceId(path) {
  if (!existsSync(path)) return { state: "missing", id: null };
  try {
    const id = readFileSync(path, "utf8").trim();
    return UUID_RE.test(id) ? { state: "ok", id } : { state: "invalid", id: null };
  } catch {
    return { state: "invalid", id: null };
  }
}

/**
 * The instance's vault device GUID (R-D), minted on first use. Crash-safe like key.js: a 600
 * temp file is written + fsync'd, then hard-linked to the final name (EEXIST = another
 * writer won; use theirs). An invalid/unreadable file is moved aside, never trusted. The
 * file holds only the GUID.
 */
export function ensureVaultDeviceId({ crowHome = CROW_HOME } = {}) {
  const path = vaultDeviceIdPath(crowHome);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const cur = readDeviceId(path);
  if (cur.state === "ok") return cur.id;
  if (cur.state === "invalid") renameSync(path, `${path}.invalid-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${randomUUID()}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  try { const dfd = openSync(dir, "r"); fsyncSync(dfd); closeSync(dfd); } catch { /* best effort */ }
  const after = readDeviceId(path);
  if (after.state !== "ok") throw new Error("vault device id unavailable");
  return after.id;
}

/** Seed a fresh appdata dir so the CLI presents the instance's stable device id (R-D). */
function seedAppData(dir, deviceId) {
  const fd = openSync(join(dir, "data.json"), "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ stateVersion: BW_STATE_VERSION, global_applicationId_appId: deviceId }));
  } finally {
    closeSync(fd);
  }
}

/** Remove crow-bw-* dirs older than 10 minutes (a crashed save's data.json holds tokens). */
export function sweepStaleVaultDirs(tmpRoot, { now = Date.now() } = {}) {
  let n = 0;
  try {
    for (const name of readdirSync(tmpRoot)) {
      if (!name.startsWith("crow-bw-")) continue;
      const p = join(tmpRoot, name);
      try { if (now - statSync(p).mtimeMs > STALE_MS) { rmSync(p, { recursive: true, force: true }); n++; } } catch {}
    }
  } catch { /* no tmp root yet */ }
  return n;
}

function runStep({ nodePath, cliPath, args, env, stdin = "", timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    const argv = [cliPath, ...args];
    try {
      child = PRLIMIT
        ? spawn(PRLIMIT, ["--core=0", "--", nodePath, ...argv], { env, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(nodePath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve({ code: -1, stdout: "", stderr: "", spawnError: true });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, Math.max(1, timeoutMs));
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, spawnError: true }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Map a failed login's stderr to a fixed sentence (never the text itself — R-E). The exact
 * 2026.8.0 texts are checked first (R-C): "Insecure URL not allowed"
 * (InsecureUrlNotAllowedError), "Code is required." (two-step, under BW_NOINTERACTION), and
 * "Username or password is incorrect".
 */
export function classifyLogin(stderr) {
  stderr = String(stderr || "");
  if (/InsecureUrlNotAllowed|Insecure URL not allowed/i.test(stderr)) return VAULT_REASONS.insecureUrl;
  if (/\bCode is required\b/i.test(stderr)) return VAULT_REASONS.twoStep;
  if (/Username or password is incorrect/i.test(stderr)) return VAULT_REASONS.wrongCredentials;
  if (/two[- ]?step|two[- ]?factor|2fa/i.test(stderr)) return VAULT_REASONS.twoStep;
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|connect|getaddrinfo|socket hang up/i.test(stderr)) return VAULT_REASONS.unreachable;
  if (/password|credential|incorrect|invalid|username/i.test(stderr)) return VAULT_REASONS.wrongCredentials;
  return VAULT_REASONS.failed;
}

export async function saveToVault({
  cliPath, serverUrl, email, masterPassword, item,
  deadlineMs = 90_000, tmpRoot = join(CROW_HOME, "tmp"), nodePath = process.execPath, crowHome = CROW_HOME,
} = {}) {
  if (!cliPath || !existsSync(cliPath)) return { ok: false, reason: VAULT_REASONS.missingCli };
  if (!email || !masterPassword || !item || typeof item.password !== "string" || !serverUrl) return { ok: false, reason: VAULT_REASONS.badInput };
  if (!isHttps(serverUrl)) return { ok: false, reason: VAULT_REASONS.insecureUrl };
  const deadline = Date.now() + deadlineMs;
  let dir = null;
  try {
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    chmodSync(tmpRoot, 0o700);
    sweepStaleVaultDirs(tmpRoot);
    const deviceId = ensureVaultDeviceId({ crowHome });
    dir = mkdtempSync(join(tmpRoot, "crow-bw-"));
    chmodSync(dir, 0o700);
    seedAppData(dir, deviceId);
    const baseEnv = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: dir, BITWARDENCLI_APPDATA_DIR: dir, BW_NOINTERACTION: "true", NODE_OPTIONS: "" };
    const step = (args, extra = {}, stdin = "") => runStep({ nodePath, cliPath, args, env: { ...baseEnv, ...extra }, stdin, timeoutMs: deadline - Date.now() });

    const cfg = await step(["config", "server", serverUrl]);
    if (cfg.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    if (cfg.spawnError || cfg.code !== 0) return { ok: false, reason: VAULT_REASONS.failed };

    const login = await step(["login", email, "--passwordenv", "CROW_BW_MASTER", "--raw"], { CROW_BW_MASTER: masterPassword });
    if (login.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    const session = login.stdout.trim();
    if (login.code !== 0 || !session) return { ok: false, reason: classifyLogin(login.stderr) };

    const payload = {
      type: 1, name: String(item.name || "Crow password").slice(0, 200), notes: item.notes || null,
      favorite: false, folderId: null, organizationId: null, collectionIds: null, reprompt: 0, fields: [],
      login: { username: item.username || null, password: item.password, totp: null, uris: item.url ? [{ match: null, uri: item.url }] : [] },
    };
    const created = await step(["create", "item"], { BW_SESSION: session }, Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
    if (Date.now() < deadline) await step(["logout"], { BW_SESSION: session });
    if (created.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    if (created.code !== 0) return { ok: false, reason: VAULT_REASONS.createFailed };
    return { ok: true };
  } catch {
    return { ok: false, reason: VAULT_REASONS.failed };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}
