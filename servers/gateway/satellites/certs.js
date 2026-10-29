/**
 * Satellite certificates and revocations, crow side (SAT-1, spec §3.2, §3.3). The crow root key
 * (the identity's Ed25519 key) signs these two things and nothing else here.
 */
import {
  buildCertPayload, signCert, verifyCertSignature, signRevocation, satelliteIdFromPub,
} from "../../shared/satellite-protocol.js";

const privHexOf = (identity) => {
  const p = identity?.ed25519Priv;
  const hex = Buffer.isBuffer(p) || p instanceof Uint8Array ? Buffer.from(p).toString("hex") : p;
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) throw new TypeError("certs: identity has no root key");
  return hex;
};
const pubHexOf = (identity) => identity?.ed25519Pubkey
  || (identity?.ed25519Pub ? Buffer.from(identity.ed25519Pub).toString("hex") : null);

/** A signed `{payload, sig}` cert for `satellite_pubkey`; throws if it would not verify. */
export function issueCert({ identity, instanceId, primaryUrl, satellite_id, satellite_pubkey, mgmt_pubkey, now = Date.now() }) {
  if (typeof satellite_pubkey !== "string" || satelliteIdFromPub(satellite_pubkey) !== satellite_id) {
    throw new TypeError("certs: satellite_id does not derive from satellite_pubkey");
  }
  if (typeof mgmt_pubkey !== "string" || !/^[0-9a-f]{64}$/.test(mgmt_pubkey) || mgmt_pubkey === satellite_pubkey) {
    throw new TypeError("certs: bad mgmt_pubkey");
  }
  if (typeof instanceId !== "string" || !instanceId) throw new TypeError("certs: missing instance id");
  if (typeof primaryUrl !== "string" || !/^https:\/\//.test(primaryUrl)) throw new TypeError("certs: primary url must be https");
  const payload = buildCertPayload({
    crow_id: identity?.crowId,
    root_pubkey: pubHexOf(identity),
    primary_instance_id: instanceId,
    primary_url: primaryUrl,
    satellite_id, satellite_pubkey, mgmt_pubkey,
    now,
  });
  const cert = signCert(privHexOf(identity), payload);
  if (!verifyCertSignature(cert)) throw new Error("certs: issued cert does not verify (identity crow_id/key mismatch?)");
  return cert;
}

/** A signed revocation, shaped for store.recordRevocation. */
export function revokeSatelliteRecord({ identity, serial, satellite_id, reason = null, now = Date.now() }) {
  const revoked_at = new Date(now).toISOString();
  const rec = signRevocation(privHexOf(identity), { serial, satellite_id, revoked_at, reason });
  return { serial, satellite_id, revoked_at, reason, payload_json: JSON.stringify(rec.payload), sig: rec.sig };
}
