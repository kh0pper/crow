/**
 * The satellite agent (SAT-3, spec §6, §11.1): a slim Express app on 127.0.0.1:3014 behind
 * Tailscale Serve, managed only by the crow primary.
 *
 *   GET /health                       unsigned, any peer class: {ok, protocol, time}
 *   everything else                   classifyPeer(req).via === "serve" only, else 404 (empty)
 *   unpaired (no live cert):          POST /satellite/v1/pair/hello, POST /satellite/v1/pair/complete
 *   paired:                           both pairing routes 409 {error:"already_paired"}
 *   /satellite/v1/* (not pair/*)      signed requests only (auth.js), signed JSON answers:
 *                                     GET status, POST cert, POST unpair (routes.js), bundle
 *                                     management + jobs (bundles.js), POST mcp/<bundle>
 *                                     (mcp-host.js), POST update (update.js), plus whatever
 *                                     `signedRoutes` registers
 *
 * Never imports the dashboard, memory, sharing, router, init-db or crow.db.
 */
import express from "express";
import { classifyPeer } from "../shared/peer-class.js";
import { AGENT_PROTOCOL } from "../shared/satellite-protocol.js";
import { openSatelliteDb } from "./db.js";
import { ensureSatelliteKey, readCert, readPinned, writeCert, writePinned } from "./keys.js";
import { createSatAuth } from "./auth.js";
import { recoverStagedCert } from "./certs.js";
import { registerCoreRoutes } from "./routes.js";
import { registerBundleRoutes } from "./bundles.js";
import { createMcpHost, registerMcpRoutes } from "./mcp-host.js";
import { applyPendingDbRestore, createUpdater, registerUpdateRoute } from "./update.js";
import { createScheduler } from "./scheduler.js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPLETE_PER_SOURCE_PER_MIN, PairRefusal, certIsLive, createHelloLimiter, handleComplete, handleHello, issuePairCode,
} from "./pairing.js";
import { noteRefusedOnce } from "../gateway/loopback-gate.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_PORT = 3014;
export const DEFAULT_HOST = "127.0.0.1";

/** SAT_HOME = CROW_HOME for the satellite process (spec §3.1); never the full Crow's ~/.crow. */
export function resolveSatHome(env = process.env) {
  return resolve(env.CROW_HOME || join(homedir(), ".crow-satellite"));
}

export function resolveBind(env = process.env) {
  const host = String(env.CROW_SATELLITE_HOST || "").trim() || DEFAULT_HOST;
  const raw = String(env.CROW_SATELLITE_PORT ?? "").trim();
  const port = raw === "" ? DEFAULT_PORT : Number(raw);
  if (!/^\d{1,5}$/.test(raw || String(DEFAULT_PORT)) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CROW_SATELLITE_PORT must be a port number, got "${raw}"`);
  }
  return { host, port };
}

/** The pairing source: Serve's class and the tailnet client it names. */
const sourceOf = (req) => { const p = classifyPeer(req); return `${p.via}:${p.client || "unknown"}`; };

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The agent checkout's HEAD sha, or null (no git, not a checkout). */
export function readAppSha(root = APP_ROOT) {
  try {
    const s = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * `signedRoutes`: functions (router, ctx) that add routes behind auth (later tasks' bundle, job
 * and MCP routes); ctx = {db, key, satHome, state, now, out, sendSigned}. `bundleDeps`: the
 * bundle manager's injectable runners and readers (composeRunner, dockerRunner, readText,
 * mcpPids, npmRunner, appBundlesDir); omitted, the real docker / compose / proc are used.
 * `mcpOptions`: the MCP host's timings (idleMs, killGraceMs, ...; tests shorten them).
 * `updateDeps`: the updater's runner, appRoot, fetchCheckRuns and exit (update.js).
 * The MCP host's running-child pids feed the install gate's current-use reader unless
 * bundleDeps.mcpPids is given.
 */
export function createSatelliteApp({ db, key, satHome, now = Date.now, out = console.log, sha = null, signedRoutes = [], statusReaders, authLog = console.warn, bundleDeps = {}, mcpOptions = {}, updateDeps = {} }) {
  // A cert commit a crash interrupted is finished (or discarded) before anything reads the files.
  recoverStagedCert({ db, key, satHome, now });
  const state = { cert: readCert(satHome), pinned: readPinned(satHome) };
  const isPaired = () => certIsLive(state.cert, state.pinned, key.ed25519_pub, now());
  // A paired cert's serial is always recorded (a crash may have lost the row): never re-accepted.
  if (isPaired()) {
    db.prepare("INSERT OR IGNORE INTO cert_serials (serial, accepted_at) VALUES (?, ?)")
      .run(String(state.cert.payload.serial), new Date(now()).toISOString());
  }
  const limiter = createHelloLimiter();
  const completeLimiter = createHelloLimiter({ perSource: COMPLETE_PER_SOURCE_PER_MIN, global: Infinity });
  const noteRefused = (route, code, source) => noteRefusedOnce(`satellite ${route}`, `${code} from ${source}`, { now: now() });
  const audit = db.prepare("INSERT INTO audit (ts, route, caller, result) VALUES (?, ?, ?, ?)");
  const record = (route, result) => { try { audit.run(new Date(now()).toISOString(), route, "pairing", result); } catch { /* never blocks */ } };

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, protocol: AGENT_PROTOCOL, time: new Date(now()).toISOString() });
  });

  // The network class gate: Serve only, everything else sees nothing.
  app.use((req, res, next) => {
    if (classifyPeer(req).via !== "serve") return res.status(404).end();
    next();
  });

  // Pairing parses JSON; the signed routes below keep their raw bytes (the signature covers them).
  app.use("/satellite/v1/pair", express.json({ limit: "1mb" }));

  const refuse = (res, status, code) => res.status(status).json({ error: code });

  app.post("/satellite/v1/pair/hello", (req, res) => {
    if (isPaired()) return refuse(res, 409, "already_paired");
    const source = sourceOf(req);
    if (!limiter.hit(source, now())) {
      noteRefused("pair/hello", "rate_limited", source);
      return refuse(res, 429, "rate_limited");
    }
    try {
      res.json(handleHello({ db, key, now }, req.body, source));
    } catch (err) {
      if (err instanceof PairRefusal) return refuse(res, err.status, err.code);
      throw err;
    }
  });

  app.post("/satellite/v1/pair/complete", (req, res) => {
    if (isPaired()) return refuse(res, 409, "already_paired");
    const source = sourceOf(req);
    if (!completeLimiter.hit(source, now())) {
      noteRefused("pair/complete", "rate_limited", source);
      return refuse(res, 429, "rate_limited");
    }
    try {
      const r = handleComplete({
        db, key, now,
        // pinned.json first, cert.json last: the cert is the commit marker (a crash in between
        // leaves a pin without a cert, which is simply unpaired).
        persist: ({ cert, pinned }) => { writePinned(satHome, pinned); writeCert(satHome, cert); },
      }, req.body, source);
      state.pinned = r.pinned;
      state.cert = r.cert;
      record("pair/complete", "ok");
      out(`Paired with ${r.pinned.crow_id}`);
      res.json({ ok: true, sig: r.sig });
    } catch (err) {
      if (err instanceof PairRefusal) {
        record("pair/complete", err.code);
        if (err.status === 403) noteRefused("pair/complete", err.code, source);
        return refuse(res, err.status, err.code);
      }
      throw err;
    }
  });

  const auth = createSatAuth({ db, key, now, getState: () => state, log: authLog });
  const signed = express.Router();
  signed.use(auth.begin);
  signed.use(express.raw({ type: () => true, limit: "1mb" }));
  signed.use(auth.verify);
  const ctx = { db, key, satHome, state, now, out, sendSigned: auth.sendSigned };
  const readManifest = (id) => { try { return JSON.parse(readFileSync(join(satHome, "bundles", id, "manifest.json"), "utf8")); } catch { return null; } };
  const mcpHost = createMcpHost({ db, satHome, readText: bundleDeps.readText, manifestFor: readManifest, ...mcpOptions });
  registerCoreRoutes(signed, { ...ctx, sha, statusReaders, toolsStatus: mcpHost.toolsStatus });
  registerBundleRoutes(signed, {
    ...ctx, mcpPids: (id) => mcpHost.pids(id), ...bundleDeps,
    toolCache: { refresh: (id, version) => mcpHost.refreshToolCache(id, version), remove: (id) => mcpHost.removeBundle(id) },
  });
  registerMcpRoutes(signed, { host: mcpHost, satHome, sendSigned: auth.sendSigned });
  registerUpdateRoute(signed, { updater: createUpdater({ db, satHome, now, log: out, ...updateDeps }), sendSigned: auth.sendSigned });
  for (const add of signedRoutes) add(signed, ctx);
  signed.use((_req, res) => auth.sendSigned(res, 404, { error: "not_found" }));
  app.use("/satellite/v1", signed);

  app.use((_req, res) => refuse(res, 404, "not_found"));

  // Body-parser failures (bad JSON, too large) and anything unexpected: JSON, no stack; signed
  // when the request was a signed-route request with a well-formed nonce.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const send = res.locals?.satAudit ? (status, code) => auth.sendSigned(res, status, { error: code }) : (status, code) => refuse(res, status, code);
    if (res.headersSent) return;
    if (err?.type === "entity.parse.failed") return send(400, "bad_json");
    if (err?.type === "entity.too.large") return send(413, "too_large");
    console.error(`[satellite] ${err?.stack || err}`);
    send(500, "internal");
  });

  return { app, isPaired, state, refusals: auth.refusals, mcpHost };
}

/**
 * Open state, build the app and listen. Guards are the caller's job (index.js).
 * → {server, host, port, app, db, key, home, satelliteId, isPaired, issuePairCode, close}.
 */
export async function startAgent({ env = process.env, now = Date.now, out = console.log, sha, signedRoutes, statusReaders, authLog, bundleDeps, mcpOptions, updateDeps = {} } = {}) {
  const satHome = resolveSatHome(env);
  const { host, port } = resolveBind(env);
  // A rolled-back update's migration: its backup goes back before satellite.db is opened.
  applyPendingDbRestore(satHome, out);
  const db = openSatelliteDb(satHome);
  const key = ensureSatelliteKey(satHome, { now: now() });
  let handle = null;
  // The supervised restart: close cleanly, then exit with the code the unit restarts on.
  const exit = updateDeps.exit || (async (code) => { try { await handle?.close(); } finally { process.exit(code); } });
  const { app, isPaired, state, refusals, mcpHost } = createSatelliteApp({
    db, key, satHome, now, out, sha: sha === undefined ? readAppSha() : sha, signedRoutes, statusReaders, authLog, bundleDeps, mcpOptions, updateDeps: { ...updateDeps, exit },
  });
  const server = await new Promise((ok, fail) => {
    const s = app.listen(port, host, () => ok(s));
    s.once("error", fail);
  });
  const addr = server.address();
  const scheduler = createScheduler({ db, now, log: out, getCert: () => state.cert });
  scheduler.start();
  // A bundle whose version changed (or whose cache is missing) gets its tool list re-cached.
  const reconciled = mcpHost.reconcile().catch((err) => out(`satellite: tool cache reconcile failed: ${err?.message || err}`));
  let closed = false;
  handle = {
    server, app, db, key, home: satHome, host: addr.address, port: addr.port, satelliteId: key.satellite_id,
    isPaired, scheduler, refusals, mcpHost,
    issuePairCode: () => issuePairCode(db, { now: now() }),
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      refusals.flush();
      await mcpHost.stopAll();
      await reconciled;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      db.close();
    },
  };
  return handle;
}
