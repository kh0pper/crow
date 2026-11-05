/**
 * Side-effect module: a host set up as a satellite (CROW_PROFILE=satellite, spec §6.1) must never
 * run the full gateway. ./run-instance-paths-gate.js (servers/gateway/index.js's first import)
 * imports this before anything else, so the refusal happens before the checkout .env, the
 * instance-path gate, any DB or any listener. Exit 78 (EX_CONFIG), like the instance-path gate,
 * so a unit with RestartPreventExitStatus=78 does not restart-loop.
 */

// FIRST statement of the FIRST module the gateway graph evaluates: the
// environment exactly as systemd (or the shell) handed it over, before
// ./run-instance-paths-gate.js applies the checkout .env and pins
// CROW_DATA_DIR.
//
// The gateway's import check spawns a child that must be judged by the SAME
// instance-path rules the unit configures. A child given `{...process.env}`
// inherits the .env keys and the pinned CROW_DATA_DIR as if they were unit env,
// and the instance-paths gate then answers a different question — a waiver key
// that came from the checkout .env is no longer recognised as one, so the
// verdict flips (audit N1c-3, S1). Kept here because this module is evaluated
// before any other module in the graph can touch process.env.
export const ORIGINAL_ENV = Object.freeze({ ...process.env });

export const SATELLITE_PROFILE_EXIT_CODE = 78;

export function refuseSatelliteProfile({ env = process.env, log = console, exit = process.exit } = {}) {
  if (String(env.CROW_PROFILE || "").trim().toLowerCase() !== "satellite") return false;
  log.error("ERROR: CROW_PROFILE=satellite: this host runs the satellite agent (servers/satellite/index.js), not the Crow gateway");
  exit(SATELLITE_PROFILE_EXIT_CODE);
  return true;
}

refuseSatelliteProfile();
