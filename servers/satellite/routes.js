/**
 * The core signed management routes (SAT-3, spec §3.2, §3.3, §8), mounted on agent.js's signed
 * router (so every one has passed auth.js and answers through sendSigned):
 *
 *   GET  /satellite/v1/status   collectStatus (≤ 64 KiB)
 *   POST /satellite/v1/cert     {cert} → renew or rotate (certs.js) → {ok, serial, expires_at, rotated}
 *   POST /satellite/v1/unpair   delete cert.json + pinned.json (vault, bundles, installed.json,
 *                               secrets and satellite.db stay), back to unpaired mode, a fresh
 *                               pairing code on the console → {ok:true}
 */
import { installedPath, readInstalled } from "../gateway/bundle-core.js";
import { applyNewCert } from "./certs.js";
import { removePairingFiles } from "./keys.js";
import { issuePairCode, pairCodeLines } from "./pairing.js";
import { collectStatus } from "./status.js";

export function registerCoreRoutes(router, { db, key, satHome, state, now, out, sendSigned, sha, statusReaders = {} }) {
  router.get("/status", (_req, res) => {
    sendSigned(res, 200, collectStatus({
      satelliteId: key.satellite_id, sha, cert: state.cert, installed: readInstalled(installedPath(satHome)), satHome, ...statusReaders,
    }));
  });

  router.post("/cert", (req, res) => {
    const r = applyNewCert({ db, key, satHome, state, now }, req.satBody?.cert);
    if (!r.ok) return sendSigned(res, r.status, { error: r.code });
    out(r.rotated ? "Management key rotated; the old key is refused from now on" : `Cert renewed, expires ${state.cert.payload.expires_at}`);
    sendSigned(res, 200, { ok: true, serial: state.cert.payload.serial, expires_at: state.cert.payload.expires_at, rotated: r.rotated });
  });

  router.post("/unpair", (_req, res) => {
    state.cert = null;
    state.pinned = null;
    removePairingFiles(satHome);
    sendSigned(res, 200, { ok: true });
    out("Unpaired by crow; management and tool calls are off");
    for (const line of pairCodeLines(issuePairCode(db, { now: now() }), key.satellite_id)) out(line);
  });
}
