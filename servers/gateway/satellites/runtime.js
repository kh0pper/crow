/**
 * The gateway's one satellite runtime (SAT-5): the management service, the status poller
 * (60 s) and the daily cert renewer, built lazily so importing the router never starts
 * anything. startSatelliteTimers() is called once from gateway boot; both timers are unref'd
 * in-process intervals (no system timer) and each tick is one SELECT when nothing is paired.
 * CROW_SATELLITE_TIMERS=0 turns them off.
 */
import { createDbClient } from "../../db.js";
import { createSatelliteManager } from "./manage.js";
import { createSatellitePoller } from "./poller.js";
import { createCertRenewer } from "./renewal.js";

let runtime = null;

export function getSatelliteRuntime() {
  if (!runtime) {
    const poller = createSatellitePoller({ dbFactory: createDbClient });
    const renewer = createCertRenewer({ dbFactory: createDbClient });
    const manager = createSatelliteManager({ dbFactory: createDbClient, poller, renewer });
    runtime = { manager, poller, renewer, started: false };
  }
  return runtime;
}

export function startSatelliteTimers({ env = process.env, log = (m) => console.log(m) } = {}) {
  if (String(env.CROW_SATELLITE_TIMERS ?? "").trim() === "0") return false;
  const r = getSatelliteRuntime();
  if (r.started) return true;
  r.poller.start();
  r.renewer.start();
  r.started = true;
  log("[satellites] status poller (60 s) and daily cert renewal started");
  return true;
}

/** Test-only. */
export function _resetSatelliteRuntimeForTest() {
  if (runtime) { runtime.poller.stop(); runtime.renewer.stop(); }
  runtime = null;
}
