/**
 * Satellite bundle management (SAT-3, spec §7.0–§7.2, §8). Signed routes on agent.js's signed
 * router (auth.js has verified every request; answers go through sendSigned):
 *
 *   POST bundles/install            {id, env?, consent_token?} → 202 {job_id}
 *   POST bundles/uninstall          {id} → 202 {job_id}
 *   POST bundles/repin              {id} → {ok, sha256}
 *   POST bundles/:id/start|stop|restart → {ok}
 *   GET  bundles/:id/env            {keys:[{name, set, secret, generated}]} — never a value
 *   PUT  bundles/:id/env            {env:{KEY: value|null}} — values in, never out
 *   POST bundles/:id/consent        {token, accept} → {ok, consent_token, expires_at}
 *   GET  bundles/:id/logs?tail=&since=  {log, truncated} (256 KiB, redacted)
 *   GET  bundles/:id/backups        {backups:[{name, size, sha256, created_at}]}
 *   GET  bundles/:id/backups/:name  the file, plain octet-stream (the one non-JSON answer;
 *                                   its sha256 is in the signed manifest above)
 *   POST bundles/:id/bot-access     501 not_supported (bundle-defined exec: Gitea G4)
 *   GET  jobs/:id                   {id, bundle_id, action, status, log, started_at, completed_at}
 *
 * Only owner callers (owner-local / owner-remote) manage bundles; a `bot:` caller gets 403.
 * Bundles come only from the agent's own checkout ($SAT_HOME/app/bundles/<id>) and are
 * installed with bundle-core in a full Crow's formats under crowHome = SAT_HOME: installed.json,
 * mcp-addons.json (600), bundles/<id>/.env (600). Generated secrets are sealed in satellite.db's
 * crow_keychain with the keychain core (key: $SAT_HOME/secrets/keychain.key). No skill sync,
 * no panels, no gateway env. docker / compose / proc / cgroup reads are injected (`deps`).
 */
import { closeSync, constants as fsConstants, cpSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  appendLog, blankHardFailKeys, createJob, dockerRunner as coreDockerRunner, finishJob, installedPath, jobs, MISSING_VAR_RE,
  readInstalled, run, runCompose, TEARDOWN_DUMMY, validateComposeFile, writeInstalled, writeInstallEnv,
} from "../gateway/bundle-core.js";
import { composeEnv, loadComposeModel, looksLikeHostPath } from "../gateway/compose-guard.js";
import { envValueProblem, parseEnvText, pathEnvKeys, updateEnvText } from "../gateway/bundle-env-codec.js";
import { planGeneratedEnv, writePrivateFile } from "../gateway/bundle-env-secrets.js";
import { composeProjectName } from "../gateway/bundle-lifecycle.js";
import { loadKeychainKey } from "../gateway/keychain/key.js";
import { ensureWriteKey, markBundleRemoved, readableSecretsSync, saveExtensionSecret } from "../gateway/keychain/store.js";
import { launcherPin } from "../shared/resolve-command.js";
import { redactSecrets } from "../shared/redact-secrets.js";
import { repinAddon } from "../../scripts/ops/pin-addon-command.mjs";
import { bundleCurrentUseMb, runGate } from "./gate.js";
import { checkSatelliteCompose } from "./compose-rules.js";
import { readTextOrNull } from "./status.js";

export const LOG_CAP_BYTES = 262144;
export const DEFAULT_LOG_TAIL = 200;
export const MAX_LOG_TAIL = 5000;
export const CONSENT_TTL_MS = 10 * 60000;
const BUNDLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SINCE = /^[0-9A-Za-z][0-9A-Za-z:.+-]{0,39}$/; // never a leading "-" (it would read as a flag)

class Refusal extends Error {
  constructor(status, code, extra = {}) { super(code); Object.assign(this, { status, code, extra }); }
}

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };
const readManifest = (dir) => readJson(join(dir, "manifest.json"), null);
const requiresConsent = (m) => !!(m && (m.privileged === true || m.consent_required === true));
const consentMessage = (m) => m?.install_consent_messages?.en ?? m?.install_consent_message ?? "This extension needs your consent to install.";
const nonBlank = (v) => v !== undefined && v !== null && String(v) !== "";

/** better-sqlite3 behind the small async libsql surface the keychain store uses. */
function keychainDb(raw) {
  return {
    async execute(q) {
      const { sql, args = [] } = typeof q === "string" ? { sql: q } : q;
      const st = raw.prepare(sql);
      if (st.reader) return { rows: st.all(...args) };
      const r = st.run(...args);
      return { rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: r.changes };
    },
    async executeMultiple(sql) { raw.exec(sql); },
  };
}

/**
 * Request env → validated values. Only keys the manifest declares; never a generated key (those
 * are minted here), never a host path (a remote caller cannot point a bundle at host folders),
 * never a value a .env line cannot hold. null / "" mean "no value".
 */
function validateEnv(manifest, env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw new Refusal(400, "bad_env");
  const specs = new Map((manifest?.env_vars || []).map((v) => [v.name, v]));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const spec = specs.get(k);
    if (!spec) throw new Refusal(400, "unknown_env_key", { key: k.slice(0, 64) });
    if (spec.generate) throw new Refusal(400, "generated_env_key", { key: k });
    if (v === null || v === "") { out[k] = null; continue; }
    if (typeof v !== "string") throw new Refusal(400, "bad_env", { key: k });
    if (envValueProblem(v)) throw new Refusal(400, "bad_env_value", { key: k });
    if (looksLikeHostPath(v)) throw new Refusal(400, "host_path_refused", { key: k });
    out[k] = v;
  }
  return out;
}

export function createBundleManager({
  db, satHome, now = Date.now, appBundlesDir = join(satHome, "app", "bundles"),
  composeRunner, dockerRunner = coreDockerRunner(), readText = readTextOrNull, mcpPids = () => [], npmRunner = run,
}) {
  const compose = composeRunner || ((args, opts = {}) => runCompose(args, { ...opts, crowHome: satHome }));
  const kdb = keychainDb(db);
  const bundlesDir = join(satHome, "bundles");
  const instPath = installedPath(satHome);
  const addonsPath = join(satHome, "mcp-addons.json");
  const challenges = new Map();
  const consentTokens = new Map();

  // A job that was running when the agent stopped never finishes: say so.
  try { db.prepare("UPDATE jobs SET status = 'interrupted', completed_at = ? WHERE status = 'running'").run(new Date(now()).toISOString()); } catch { /* best effort */ }

  const jobStmt = db.prepare(`INSERT INTO jobs (id, bundle_id, action, status, log_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, log_json = excluded.log_json, completed_at = excluded.completed_at`);
  const persist = (job) => {
    try { jobStmt.run(job.id, job.bundleId, job.action, job.status, JSON.stringify(job.log), job.startedAt, job.completedAt); } catch { /* never blocks a job */ }
  };
  function newJob(bundleId, action) {
    const job = createJob(bundleId, action);
    Object.defineProperty(job, "satHome", { value: satHome }); // the registry is process-wide
    // bundle-core counts ids per process; a satellite job id must survive restarts in satellite.db.
    jobs.delete(job.id);
    job.id = randomBytes(8).toString("hex");
    jobs.set(job.id, job);
    persist(job);
    return job;
  }
  const log = (job, line) => { appendLog(job, line); persist(job); };
  const finish = (job, status) => { finishJob(job, status); persist(job); };
  const activeJob = (bundleId) => [...jobs.values()].find((j) => j.bundleId === bundleId && j.status === "running") || null;
  // One install at a time across the agent: two concurrent installs would each pass the memory
  // gate against the same MemAvailable before either reservation is recorded.
  const activeInstall = () => [...jobs.values()].find((j) => j.action === "install" && j.status === "running" && j.satHome === satHome) || null;

  const installed = () => readInstalled(instPath);
  const record = (id) => installed().find((b) => b.id === id) || null;
  const destOf = (id) => join(bundlesDir, id);
  const manifestOf = (id) => readManifest(destOf(id)) || readManifest(join(appBundlesDir, id));
  const envOf = (id) => { try { return parseEnvText(readFileSync(join(destOf(id), ".env"), "utf8")); } catch { return {}; } };

  /** Every value a bundle's logs must not show: its .env, its MCP entry, the keychain. */
  function secretsFor(id) {
    const out = Object.values(envOf(id)).filter(nonBlank).map(String);
    for (const v of Object.values(readJson(addonsPath, {})?.[id]?.env || {})) if (nonBlank(v)) out.push(String(v));
    const key = loadKeychainKey({ crowHome: satHome });
    for (const e of readableSecretsSync(db, key)) out.push(e.secret);
    return out;
  }

  const ctxFor = (id) => ({
    crowHome: satHome, dataDir: join(satHome, "data"), appRoot: join(satHome, "app"),
    shipped: (() => { try { return new Set(readdirSync(join(appBundlesDir, id))); } catch { return null; } })(),
    operatorRoots: [], otherRoots: [], home: process.env.HOME || homedir(),
  });
  const runConfig = (args, { cwd, env }) => compose(args, { cwd, env, timeout: 60_000 });

  /** The satellite's one compose check (compose-guard strict + satellite rules; consent never
   * widens it). → {valid, reason?, model?} */
  async function checkCompose(id, manifest) {
    const dir = destOf(id);
    const loaded = await loadComposeModel(dir, { env: composeEnv(process.env, satHome), runConfig });
    if (loaded.error) return { valid: false, reason: loaded.error };
    const c = checkSatelliteCompose(loaded.model, { bundleDir: dir, manifest, ctx: ctxFor(id) });
    return c.valid ? { valid: true, model: loaded.model } : c;
  }

  async function teardown(args, cwd) {
    try {
      return await compose(args, { cwd });
    } catch (err) {
      if (!MISSING_VAR_RE.test(`${err?.stderr || ""}\n${err?.message || ""}`)) throw err;
      const keys = blankHardFailKeys(cwd, "docker-compose.yml", satHome);
      if (!keys.length) throw err;
      return compose(args, { cwd, extraEnv: Object.fromEntries(keys.map((k) => [k, TEARDOWN_DUMMY])) });
    }
  }

  const projectOf = (rec) => rec.compose_project || (() => {
    let text = "";
    try { text = readFileSync(join(destOf(rec.id), "docker-compose.yml"), "utf8"); } catch { /* none */ }
    return composeProjectName(text, destOf(rec.id), envOf(rec.id));
  })();
  const currentUseMb = (rec) => bundleCurrentUseMb({ project: projectOf(rec), dockerRunner, readText, mcpPids: () => mcpPids(rec.id) });

  function writeAddonEntry(id, manifest, values) {
    const addons = readJson(addonsPath, {});
    const env = {};
    for (const k of manifest.server.envKeys || []) if (nonBlank(values[k])) env[k] = String(values[k]);
    for (const v of manifest.env_vars || []) if (v.default && !env[v.name]) env[v.name] = v.default;
    const pin = launcherPin(manifest.server.command, destOf(id));
    addons[id] = { command: manifest.server.command, args: manifest.server.args || [], ...(Object.keys(env).length ? { env } : {}), ...(pin ? { command_sha256: pin } : {}) };
    writePrivateFile(addonsPath, JSON.stringify(addons, null, 2));
  }

  // ── consent ────────────────────────────────────────────────────────────────
  const sweep = (m) => { for (const [k, v] of m) if (v.expiresAt <= now()) m.delete(k); };
  function challengeFor(id, manifest) {
    sweep(challenges);
    const token = randomBytes(16).toString("hex");
    const expiresAt = now() + CONSENT_TTL_MS;
    challenges.set(token, { bundleId: id, expiresAt });
    return { token, expires_at: new Date(expiresAt).toISOString(), message: consentMessage(manifest), privileged: manifest.privileged === true, consent_required: manifest.consent_required === true };
  }
  function answerConsent(id, { token, accept } = {}) {
    sweep(challenges);
    const c = typeof token === "string" && HEX32.test(token) ? challenges.get(token) : null;
    if (!c || c.bundleId !== id) throw new Refusal(403, "consent_invalid");
    challenges.delete(token);
    if (accept !== true) throw new Refusal(400, "consent_declined");
    const ct = randomBytes(16).toString("hex");
    const expiresAt = now() + CONSENT_TTL_MS;
    consentTokens.set(ct, { bundleId: id, expiresAt });
    return { ok: true, consent_token: ct, expires_at: new Date(expiresAt).toISOString() };
  }

  // ── install ────────────────────────────────────────────────────────────────
  async function startInstall(body = {}) {
    const id = body.id;
    if (typeof id !== "string" || !BUNDLE_ID.test(id)) throw new Refusal(400, "bad_bundle_id");
    const manifest = readManifest(join(appBundlesDir, id));
    if (!manifest || manifest.id !== id) throw new Refusal(404, "unknown_bundle");
    if (record(id)) throw new Refusal(409, "already_installed");
    if (activeJob(id) || activeInstall()) throw new Refusal(409, "job_running");
    const env = validateEnv(manifest, body.env);
    const gate = await runGate({ manifest, installed: installed(), manifestFor: manifestOf, readText, currentUseMb });
    if (!gate.ok) throw new Refusal(gate.status || 409, gate.code, { reason: gate.reason, ...(gate.shortfall_mb !== undefined ? { need_mb: gate.need_mb, free_mb: gate.free_mb, shortfall_mb: gate.shortfall_mb } : {}) });
    let consentVerified = false;
    if (requiresConsent(manifest)) {
      const t = body.consent_token;
      if (t === undefined || t === null) throw new Refusal(403, "consent_required", { challenge: challengeFor(id, manifest) });
      sweep(consentTokens);
      const c = typeof t === "string" && HEX32.test(t) ? consentTokens.get(t) : null;
      if (!c || c.bundleId !== id) throw new Refusal(403, "consent_invalid");
      consentTokens.delete(t);
      consentVerified = true;
    }
    if (activeJob(id) || activeInstall()) throw new Refusal(409, "job_running"); // the gate awaited: re-check
    const job = newJob(id, "install");
    runInstall(job, { id, manifest, env, consentVerified }).catch((err) => {
      log(job, `Install failed: ${String(err?.message || err).slice(0, 300)}`);
      finish(job, "failed");
    });
    return { job_id: job.id };
  }

  async function runInstall(job, { id, manifest, env, consentVerified }) {
    const src = join(appBundlesDir, id);
    const dest = destOf(id);
    let recorded = false;
    let keychainWritten = false;
    const fail = async (reason) => {
      log(job, reason);
      if (!recorded) {
        rmSync(dest, { recursive: true, force: true });
        // Nothing was installed: the secrets saved for it are not live either.
        if (keychainWritten) { try { await markBundleRemoved(kdb, id); } catch { /* stays active */ } }
      }
      finish(job, "failed");
    };
    try {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(bundlesDir, { recursive: true, mode: 0o700 });
      cpSync(src, dest, { recursive: true, filter: (p) => basename(p) !== ".env" });
      log(job, "Copied bundle files");

      if (existsSync(join(dest, "package.json")) && !existsSync(join(dest, "node_modules"))) {
        const ci = existsSync(join(dest, "package-lock.json"));
        log(job, `Installing bundle dependencies (npm ${ci ? "ci" : "install"})…`);
        try {
          await npmRunner("npm", [ci ? "ci" : "install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: dest, timeout: 300_000 });
          log(job, "Dependencies installed");
        } catch (err) {
          log(job, `Warning: npm install failed: ${String(err?.message || err).slice(0, 200)}`);
        }
      }

      const composePath = join(dest, "docker-compose.yml");
      const hasCompose = existsSync(composePath);
      if (hasCompose) {
        // Strict: no consent unlock on a satellite (the model check below is strict too).
        const t = validateComposeFile(composePath, id, { manifest: { ...manifest, privileged: false, consent_required: false }, consentVerified: false });
        if (!t.valid) return fail(`Security check failed: ${t.reason}`);
      }

      // Generated secrets: sealed in the keychain FIRST, then the retained copy and .env.
      const plan = planGeneratedEnv(id, manifest, { destDir: dest, crowHome: satHome, composeText: hasCompose ? readFileSync(composePath, "utf8") : null, priorInstall: false });
      const specs = new Map((manifest.env_vars || []).map((v) => [v.name, v]));
      const plain = {};
      for (const [k, v] of Object.entries(plan.env)) {
        const p = plan.minted[k] ?? (specs.get(k)?.store_as ? null : v);
        if (nonBlank(p)) plain[k] = String(p);
      }
      if (Object.keys(plain).length) {
        const key = await ensureWriteKey(kdb, { crowHome: satHome });
        keychainWritten = true;
        for (const [k, secret] of Object.entries(plain)) {
          await saveExtensionSecret(kdb, key, { bundleId: id, envKey: k, label: `${manifest.name || id} ${k}`, secret, origin: "generated", now: new Date(now()) });
        }
        log(job, `Saved ${Object.keys(plain).length} generated secret(s) in this server's keychain`);
      }
      plan.persist();
      const typed = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== null));
      writeInstallEnv(dest, { ...typed, ...plan.env }, manifest, (m) => log(job, m), { crowHome: satHome });

      let project = null;
      let upFailure = null;
      if (hasCompose) {
        const c = await checkCompose(id, manifest);
        if (!c.valid) return fail(`Security check failed: ${c.reason}`);
        project = c.model.name;
        log(job, "Security check passed");
        try {
          await compose(["pull"], { cwd: dest, timeout: 600_000 });
          log(job, "Docker images pulled");
        } catch (err) {
          log(job, `Warning: docker compose pull failed: ${String(err?.message || err).slice(0, 200)}`);
        }
        try {
          await compose(["up", "-d"], { cwd: dest, timeout: 600_000 });
          log(job, "Containers started");
        } catch (err) {
          upFailure = `docker compose up failed: ${String(err?.stderr || err?.message || err).slice(0, 500)}`;
          log(job, upFailure);
        }
      }

      const list = installed().filter((b) => b.id !== id);
      list.push({
        id, type: manifest.type || "bundle", version: manifest.version, installedAt: new Date(now()).toISOString(),
        consent: requiresConsent(manifest)
          ? { verified: consentVerified, privileged: manifest.privileged === true, consent_required: manifest.consent_required === true }
          : { verified: false, privileged: false, consent_required: false },
        ...(project ? { compose_project: project } : {}),
      });
      writeInstalled(instPath, list);
      recorded = true;

      if (manifest.server) {
        const hashed = new Set((manifest.env_vars || []).filter((v) => v?.store_as).map((v) => v.name));
        const gen = Object.fromEntries(Object.entries(plan.env).filter(([k]) => !hashed.has(k)));
        writeAddonEntry(id, manifest, { ...typed, ...gen });
        log(job, `Registered MCP server '${id}'`);
      }
      if (upFailure) return fail("Installed, but the containers did not start: fix the settings and Start it");
      finish(job, "complete");
    } catch (err) {
      await fail(`Install failed: ${String(err?.message || err).slice(0, 300)}`);
    }
  }

  // ── uninstall ──────────────────────────────────────────────────────────────
  function startUninstall(body = {}) {
    const id = body.id;
    if (typeof id !== "string" || !BUNDLE_ID.test(id)) throw new Refusal(400, "bad_bundle_id");
    if (!record(id)) throw new Refusal(404, "not_installed");
    if (activeJob(id)) throw new Refusal(409, "job_running");
    const job = newJob(id, "uninstall");
    (async () => {
      const dest = destOf(id);
      if (existsSync(join(dest, "docker-compose.yml"))) {
        try {
          await teardown(["down"], dest);
          log(job, "Containers removed");
        } catch (err) {
          log(job, `docker compose down failed (nothing removed; retry): ${String(err?.stderr || err?.message || err).slice(0, 300)}`);
          return finish(job, "failed");
        }
      }
      writeInstalled(instPath, installed().filter((b) => b.id !== id));
      const addons = readJson(addonsPath, null);
      if (addons && addons[id]) { delete addons[id]; writePrivateFile(addonsPath, JSON.stringify(addons, null, 2)); }
      rmSync(dest, { recursive: true, force: true });
      try { await markBundleRemoved(kdb, id); } catch { /* keychain rows stay active */ }
      log(job, "Uninstalled (generated secrets kept for a reinstall; backups kept)");
      finish(job, "complete");
    })().catch((err) => { log(job, `Uninstall failed: ${String(err?.message || err).slice(0, 300)}`); finish(job, "failed"); });
    return { job_id: job.id };
  }

  function installedId(id) {
    if (typeof id !== "string" || !BUNDLE_ID.test(id)) throw new Refusal(400, "bad_bundle_id");
    const rec = record(id);
    if (!rec) throw new Refusal(404, "not_installed");
    return rec;
  }

  // ── start / stop / restart ─────────────────────────────────────────────────
  async function lifecycle(id, action) {
    installedId(id);
    if (activeJob(id)) throw new Refusal(409, "job_running");
    const dest = destOf(id);
    if (!existsSync(join(dest, "docker-compose.yml"))) throw new Refusal(409, "no_containers");
    try {
      if (action === "stop") {
        await teardown(["stop"], dest);
      } else {
        // Start and restart both re-run the check; restart recreates the containers so a
        // changed .env (PUT env) really applies (`compose restart` keeps the old env).
        const c = await checkCompose(id, manifestOf(id));
        if (!c.valid) throw new Refusal(422, "compose_refused", { reason: c.reason });
        await compose(action === "start" ? ["up", "-d"] : ["up", "-d", "--force-recreate"], { cwd: dest, timeout: 600_000 });
      }
    } catch (err) {
      if (err instanceof Refusal) throw err;
      throw new Refusal(502, "compose_failed", { reason: redactSecrets(String(err?.stderr || err?.message || err).slice(0, 500), secretsFor(id)) });
    }
    return { ok: true };
  }

  // ── env ────────────────────────────────────────────────────────────────────
  function envKeys(id) {
    const manifest = manifestOf(id) || {};
    const env = envOf(id);
    const specs = manifest.env_vars || [];
    const names = [...specs.map((v) => v.name), ...Object.keys(env).filter((k) => !specs.some((v) => v.name === k))];
    return names.map((name) => {
      const s = specs.find((v) => v.name === name) || {};
      return { name, set: nonBlank(env[name]), secret: s.secret === true, generated: !!s.generate };
    });
  }
  function putEnv(id, body = {}) {
    installedId(id);
    const manifest = manifestOf(id);
    const updates = validateEnv(manifest, body.env);
    const path = join(destOf(id), ".env");
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { /* none yet */ }
    const set = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== null));
    const remove = Object.keys(updates).filter((k) => updates[k] === null);
    writePrivateFile(path, updateEnvText(text, set, { pathKeys: pathEnvKeys(manifest), remove }));
    // The MCP child reads its env from mcp-addons.json, never the .env: keep its keys in step.
    const addons = readJson(addonsPath, null);
    if (addons?.[id] && manifest?.server) {
      const listed = new Set(manifest.server.envKeys || []);
      const e = { ...(addons[id].env || {}) };
      for (const [k, v] of Object.entries(updates)) {
        if (!listed.has(k)) continue;
        if (v === null) delete e[k]; else e[k] = v;
      }
      addons[id] = { ...addons[id], env: e };
      if (!Object.keys(e).length) delete addons[id].env;
      writePrivateFile(addonsPath, JSON.stringify(addons, null, 2));
    }
    return { ok: true, restart_needed: true, keys: envKeys(id) };
  }

  // ── logs ───────────────────────────────────────────────────────────────────
  async function logs(id, query = {}) {
    installedId(id);
    let tail = DEFAULT_LOG_TAIL;
    if (query.tail !== undefined) {
      if (typeof query.tail !== "string" || !/^\d{1,5}$/.test(query.tail) || +query.tail < 1 || +query.tail > MAX_LOG_TAIL) throw new Refusal(400, "bad_tail");
      tail = +query.tail;
    }
    if (query.since !== undefined && (typeof query.since !== "string" || !SINCE.test(query.since))) throw new Refusal(400, "bad_since");
    const args = ["logs", "--no-color", "--tail", String(tail), ...(query.since ? [`--since=${query.since}`] : [])];
    let text;
    try {
      const r = await compose(args, { cwd: destOf(id), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      text = `${r?.stdout || ""}${r?.stderr || ""}`;
    } catch (err) {
      text = `${err?.stdout || ""}${err?.stderr || err?.message || ""}`;
    }
    let buf = Buffer.from(redactSecrets(text, secretsFor(id)), "utf8");
    const truncated = buf.length > LOG_CAP_BYTES;
    if (truncated) {
      // Newest lines win: keep the tail, starting at a whole line (a newline is a clean UTF-8 cut).
      buf = buf.subarray(buf.length - LOG_CAP_BYTES);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) buf = buf.subarray(nl + 1);
      else { let i = 0; while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++; buf = buf.subarray(i); }
    }
    return { log: buf.toString("utf8"), truncated };
  }

  // ── backups ────────────────────────────────────────────────────────────────
  const backupsDir = (id) => join(satHome, "backups", id);
  // Opened with O_NOFOLLOW and checked with fstat on that same fd: a symlink (or a file swapped
  // for one after a listing) is never followed, and what is hashed or sent is what was checked.
  const openRegular = (p) => {
    let fd;
    try { fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK || 0)); } catch { return null; }
    const st = fstatSync(fd);
    if (!st.isFile()) { closeSync(fd); return null; }
    return { fd, st };
  };
  const sha256Fd = (fd) => new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(null, { fd, autoClose: true }).on("error", fail).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex")));
  });
  async function backupList(id) {
    if (typeof id !== "string" || !BUNDLE_ID.test(id)) throw new Refusal(400, "bad_bundle_id");
    let names = [];
    try { names = readdirSync(backupsDir(id)); } catch { return { backups: [] }; }
    const out = [];
    for (const name of names) {
      if (!BACKUP_NAME.test(name)) continue;
      const f = openRegular(join(backupsDir(id), name));
      if (!f) continue;
      out.push({ name, size: f.st.size, sha256: await sha256Fd(f.fd), created_at: f.st.mtime.toISOString() });
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.name.localeCompare(b.name)));
    return { backups: out };
  }
  function backupFile(id, name) {
    if (typeof id !== "string" || !BUNDLE_ID.test(id)) throw new Refusal(400, "bad_bundle_id");
    if (typeof name !== "string" || !BACKUP_NAME.test(name)) throw new Refusal(400, "bad_name");
    const f = openRegular(join(backupsDir(id), name));
    if (!f) throw new Refusal(404, "not_found");
    return { fd: f.fd, size: f.st.size };
  }

  function repin(body = {}) {
    installedId(body.id);
    try {
      return { ok: true, sha256: repinAddon({ crowHome: satHome, id: body.id }).sha256 };
    } catch (err) {
      throw new Refusal(400, "repin_failed", { reason: String(err?.message || err).replaceAll(satHome, "$SAT_HOME").slice(0, 300) });
    }
  }

  function botAccess(id) {
    installedId(id);
    const hook = manifestOf(id)?.satellite?.bot_access;
    throw new Refusal(501, hook ? "not_implemented" : "not_supported");
  }

  function job(id) {
    const live = jobs.get(id);
    let j = live ? { id: live.id, bundle_id: live.bundleId, action: live.action, status: live.status, log: live.log, started_at: live.startedAt, completed_at: live.completedAt } : null;
    if (!j && typeof id === "string" && /^[0-9a-f]{16}$/.test(id)) {
      const r = db.prepare("SELECT id, bundle_id, action, status, log_json, started_at, completed_at FROM jobs WHERE id = ?").get(id);
      if (r) j = { id: r.id, bundle_id: r.bundle_id, action: r.action, status: r.status, log: readJsonText(r.log_json), started_at: r.started_at, completed_at: r.completed_at };
    }
    if (!j) throw new Refusal(404, "unknown_job");
    const secrets = j.bundle_id ? secretsFor(j.bundle_id) : [];
    return { ...j, log: j.log.map((l) => redactSecrets(l, secrets)) };
  }

  return { startInstall, startUninstall, repin, lifecycle, envKeys: (id) => (installedId(id), { keys: envKeys(id) }), putEnv, answerConsent, logs, backupList, backupFile, botAccess, job };
}

function readJsonText(t) { try { const v = JSON.parse(t); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }

/** Mount the routes on the signed router. ctx: agent ctx + bundle deps. */
export function registerBundleRoutes(router, { db, satHome, now, sendSigned, ...deps }) {
  const m = createBundleManager({ db, satHome, now, ...deps });
  const ownerOnly = (req, res, next) => (String(req.satCaller || "").startsWith("owner-") ? next() : sendSigned(res, 403, { error: "owner_only" }));
  router.use(["/bundles", "/jobs"], ownerOnly);
  const h = (fn, status = 200) => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res)).then((out) => {
      if (out !== undefined) sendSigned(res, status, out);
    }).catch((err) => {
      if (err instanceof Refusal) return sendSigned(res, err.status, { error: err.code, ...err.extra });
      next(err);
    });
  };
  router.post("/bundles/install", h((req) => m.startInstall(req.satBody), 202));
  router.post("/bundles/uninstall", h((req) => m.startUninstall(req.satBody), 202));
  router.post("/bundles/repin", h((req) => m.repin(req.satBody)));
  for (const action of ["start", "stop", "restart"]) router.post(`/bundles/:id/${action}`, h((req) => m.lifecycle(req.params.id, action)));
  router.get("/bundles/:id/env", h((req) => m.envKeys(req.params.id)));
  router.put("/bundles/:id/env", h((req) => m.putEnv(req.params.id, req.satBody)));
  router.post("/bundles/:id/consent", h((req) => m.answerConsent(req.params.id, req.satBody)));
  router.get("/bundles/:id/logs", h((req) => m.logs(req.params.id, req.query)));
  router.get("/bundles/:id/backups", h((req) => m.backupList(req.params.id)));
  router.get("/bundles/:id/backups/:name", h((req, res) => {
    const f = m.backupFile(req.params.id, req.params.name);
    res.status(200).set({ "Content-Type": "application/octet-stream", "Content-Length": String(f.size), "Cache-Control": "no-store" });
    createReadStream(null, { fd: f.fd, autoClose: true }).on("error", () => res.destroy()).pipe(res);
    return undefined;
  }));
  router.post("/bundles/:id/bot-access", h((req) => m.botAccess(req.params.id)));
  router.get("/jobs/:id", h((req) => m.job(req.params.id)));
  return m;
}
