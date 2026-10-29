/**
 * The satellite agent (SAT-3, spec §6, §11.1): a slim Express app on 127.0.0.1:3014 behind
 * Tailscale Serve, managed only by the crow primary.
 *
 *   GET /health                       unsigned, any peer class: {ok, protocol, time}
 *   everything else                   classifyPeer(req).via === "serve" only, else 404 (empty)
 *   unpaired (no live cert):          POST /satellite/v1/pair/hello, POST /satellite/v1/pair/complete
 *   paired:                           both pairing routes 409 {error:"already_paired"}
 *
 * Never imports the dashboard, memory, sharing, router, init-db or crow.db.
 */
import express from "express";
import { classifyPeer } from "../shared/peer-class.js";
import { AGENT_PROTOCOL } from "../shared/satellite-protocol.js";
import { openSatelliteDb } from "./db.js";
import { ensureSatelliteKey, readCert, readPinned, writeCert, writePinned } from "./keys.js";
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

export function createSatelliteApp({ db, key, satHome, now = Date.now, out = console.log }) {
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

  app.use(express.json({ limit: "1mb" }));

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

  app.use((_req, res) => refuse(res, 404, "not_found"));

  // Body-parser failures (bad JSON, too large) and anything unexpected: JSON, no stack.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") return refuse(res, 400, "bad_json");
    if (err?.type === "entity.too.large") return refuse(res, 413, "too_large");
    console.error(`[satellite] ${err?.stack || err}`);
    refuse(res, 500, "internal");
  });

  return { app, isPaired };
}

/**
 * Open state, build the app and listen. Guards are the caller's job (index.js).
 * → {server, host, port, app, db, key, home, satelliteId, isPaired, issuePairCode, close}.
 */
export async function startAgent({ env = process.env, now = Date.now, out = console.log } = {}) {
  const satHome = resolveSatHome(env);
  const { host, port } = resolveBind(env);
  const db = openSatelliteDb(satHome);
  const key = ensureSatelliteKey(satHome, { now: now() });
  const { app, isPaired } = createSatelliteApp({ db, key, satHome, now, out });
  const server = await new Promise((ok, fail) => {
    const s = app.listen(port, host, () => ok(s));
    s.once("error", fail);
  });
  const addr = server.address();
  let closed = false;
  return {
    server, app, db, key, home: satHome, host: addr.address, port: addr.port, satelliteId: key.satellite_id,
    isPaired,
    issuePairCode: () => issuePairCode(db, { now: now() }),
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      db.close();
    },
  };
}
