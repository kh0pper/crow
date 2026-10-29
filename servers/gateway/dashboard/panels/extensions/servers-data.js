/**
 * Extensions › Servers, server side (SAT-5): the paired satellites the page needs at render time
 * (names for the Installed rows, active ones for the host picker) and the bundle ids that may be
 * installed on a server. The cards themselves are filled by servers-client.js from
 * GET /api/satellites. Never throws: a failure is "no servers" rather than no page.
 */
import { listSatellites } from "../../../satellites/store.js";
import { getSatelliteRuntime } from "../../../satellites/runtime.js";

export async function serversPanelData(db, { eligible = () => getSatelliteRuntime().manager.eligibleBundles() } = {}) {
  let satellites = [];
  try {
    satellites = (await listSatellites(db)).filter((s) => s.status !== "revoked").map((s) => ({ id: s.id, name: s.name, status: s.status }));
  } catch { satellites = []; }
  let satelliteEligibleIds = [];
  try { satelliteEligibleIds = eligible(); } catch { satelliteEligibleIds = []; }
  return { satellites, satelliteEligibleIds };
}
