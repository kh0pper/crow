/**
 * Side-effect module: a host set up as a satellite (CROW_PROFILE=satellite, spec §6.1) must never
 * run the full gateway. ./run-instance-paths-gate.js (servers/gateway/index.js's first import)
 * imports this before anything else, so the refusal happens before the checkout .env, the
 * instance-path gate, any DB or any listener. Exit 78 (EX_CONFIG), like the instance-path gate,
 * so a unit with RestartPreventExitStatus=78 does not restart-loop.
 */
export const SATELLITE_PROFILE_EXIT_CODE = 78;

export function refuseSatelliteProfile({ env = process.env, log = console, exit = process.exit } = {}) {
  if (String(env.CROW_PROFILE || "").trim().toLowerCase() !== "satellite") return false;
  log.error("ERROR: CROW_PROFILE=satellite: this host runs the satellite agent (servers/satellite/index.js), not the Crow gateway");
  exit(SATELLITE_PROFILE_EXIT_CODE);
  return true;
}

refuseSatelliteProfile();
