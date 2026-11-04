/**
 * Extensions › Servers, server side (SAT-5): the paired satellites the page needs at render time
 * (names for the Installed rows, active ones for the host picker) and the bundle ids that may be
 * installed on a server. The cards themselves are filled by servers-client.js from
 * GET /api/satellites. Never throws: a failure is "no servers" rather than no page.
 *
 * SAT-8: `offsite` is the one line the Servers view shows about crow's own off-site backup — when
 * the last upload and the last successful check happened, and whether a keychain Export holds the
 * key at all (without one, no upload runs: see satellites/offsite.js).
 */
import { listSatellites } from "../../../satellites/store.js";
import { getSatelliteRuntime } from "../../../satellites/runtime.js";
import { readOffsiteStatus } from "../../../satellites/offsite.js";
import { offsiteKeyInExport } from "../../../satellites/offsite-key.js";

export async function serversPanelData(db, {
  eligible = () => getSatelliteRuntime().manager.eligibleBundles(),
  status = readOffsiteStatus, exported = offsiteKeyInExport,
} = {}) {
  let satellites = [];
  try {
    satellites = (await listSatellites(db)).filter((s) => s.status !== "revoked").map((s) => ({ id: s.id, name: s.name, status: s.status }));
  } catch { satellites = []; }
  let satelliteEligibleIds = [];
  try { satelliteEligibleIds = eligible(); } catch { satelliteEligibleIds = []; }
  let offsite = null;
  try {
    // The vault lives on a paired server: with none there is nothing to say (and the export prompt
    // would be advice a Crow that cannot have an off-site copy should not give).
    if (satellites.length) {
      const st = await status(db);
      offsite = {
        uploaded_at: typeof st?.last_uploaded_at === "string" ? st.last_uploaded_at : null,
        verified_at: typeof st?.last_verified_at === "string" ? st.last_verified_at : null,
        exported: (await exported(db)) === true,
      };
    }
  } catch { offsite = null; }
  return { satellites, satelliteEligibleIds, offsite };
}
