/**
 * Cert renewal and mgmt-key rotation, satellite side (SAT-3, spec §3.2).
 *
 * `POST /satellite/v1/cert {cert}` is a signed call, so it is already verified against the
 * CURRENT pinned mgmt key; acceptCert then checks the root signature, crow_id/root_pubkey against
 * the pin, satellite_pubkey, the clock, `issued_at` strictly later than the stored cert's, and a
 * never-seen serial. A different `mgmt_pubkey` is a rotation: the old key is refused from the
 * moment the new pin is stored (auth.js reads the pin per request).
 *
 * Write order and the crash window (pairing's rule: cert.json is the commit marker, and paired
 * means cert.json AND a pinned.json that matches it, see pairing.js certIsLive):
 *
 *   0. record the serial in cert_serials (db transaction around 1–3)
 *   1. cert.next.json  ← the new cert (staged)
 *   2. pinned.json     ← the new pin (new mgmt_pubkey on a rotation)
 *   3. cert.json       ← the new cert (commit)
 *   4. remove cert.next.json
 *
 * Each file write is atomic (temp + rename). A crash:
 *   - before 2: the old pin still matches the old cert: still paired on the old key; the staged
 *     cert does not match the pin and is discarded at boot. crow's call failed, it retries with a
 *     fresh cert (a serial recorded or not makes no difference to a fresh serial).
 *   - between 2 and 3: on a rotation the pin (new key) no longer matches cert.json (old key), so
 *     neither key would work and the box would look unpaired. `recoverStagedCert` at boot finds
 *     cert.next.json matching the pin and rolls forward: cert.json ← staged. Fail closed in the
 *     meantime (no key is accepted while the files disagree), never fail open.
 *   - after 3: committed; a leftover staged file equals cert.json and is removed at boot.
 * A write that throws (disk full): when cert.json still holds the old cert, the old pin is restored
 * (best effort) and the staged file removed; when cert.json already holds the new cert, the new pin
 * and the staged file are kept, so the files agree and boot recovery can finish. If the restore
 * itself fails, boot recovery rolls forward to the staged cert.
 */
import { acceptCert, verifyCertSignature } from "../shared/satellite-protocol.js";
import { readCert, readPinned, readStagedCert, removeStagedCert, writeCert, writePinned, writeStagedCert } from "./keys.js";

const DEFAULT_IO = Object.freeze({ writeStagedCert, writePinned, writeCert });

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The pin for an accepted cert: the cert's identity fields over the old pin (target_sha kept). */
export function pinFor(cert, oldPinned) {
  const p = cert.payload;
  return {
    target_sha: null,
    ...(oldPinned || {}),
    crow_id: p.crow_id, root_pubkey: p.root_pubkey, mgmt_pubkey: p.mgmt_pubkey,
    primary_url: p.primary_url, primary_instance_id: p.primary_instance_id,
  };
}

const pinMatches = (cert, pinned) => !!pinned && pinned.crow_id === cert.payload.crow_id
  && pinned.root_pubkey === cert.payload.root_pubkey && pinned.mgmt_pubkey === cert.payload.mgmt_pubkey;

/**
 * Check and store a renewed or rotated cert. `state` = {cert, pinned} (updated in place on
 * success). → {ok:true, rotated} or {ok:false, status, code}. Throws only on an I/O failure.
 */
export function applyNewCert({ db, key, satHome, state, now, io = DEFAULT_IO }, cert) {
  if (!isObj(cert) || !isObj(cert.payload)) return { ok: false, status: 400, code: "bad_request" };
  const seen = db.prepare("SELECT 1 FROM cert_serials WHERE serial = ?");
  const t = now();
  const res = acceptCert(cert, {
    ownPubHex: key.ed25519_pub, pinned: state.pinned, current: state.cert, serialSeen: (s) => !!seen.get(String(s)), now: t,
  });
  if (!res.ok) return { ok: false, status: 400, code: res.code };
  const mgmt = cert.payload.mgmt_pubkey;
  if (typeof mgmt !== "string" || !HEX64.test(mgmt) || mgmt === key.ed25519_pub) return { ok: false, status: 400, code: "bad_cert" };
  const oldPinned = state.pinned;
  const pinned = pinFor(cert, oldPinned);
  const rotated = mgmt !== oldPinned.mgmt_pubkey;
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO cert_serials (serial, accepted_at) VALUES (?, ?)").run(String(cert.payload.serial), new Date(t).toISOString());
      io.writeStagedCert(satHome, cert);
      io.writePinned(satHome, pinned);
      io.writeCert(satHome, cert);
    })();
  } catch (err) {
    if (readCert(satHome)?.sig === state.cert?.sig) {
      try { writePinned(satHome, oldPinned); removeStagedCert(satHome); } catch { /* boot recovery rolls forward */ }
    }
    throw err;
  }
  removeStagedCert(satHome);
  state.cert = cert;
  state.pinned = pinned;
  return { ok: true, rotated };
}

/**
 * Boot: finish or discard a cert commit a crash interrupted. Rolls forward when cert.next.json
 * verifies, is for this satellite, matches pinned.json, and is newer than cert.json with the same
 * crow_id/root_pubkey (or there is no cert.json). Always removes the staged file.
 * → "rolled_forward" | "discarded" | "none".
 */
export function recoverStagedCert({ db, key, satHome, now = Date.now }) {
  const staged = readStagedCert(satHome);
  if (!staged) { removeStagedCert(satHome); return "none"; }
  const pinned = readPinned(satHome);
  const cur = readCert(satHome);
  let forward = false;
  if (isObj(staged) && verifyCertSignature(staged) && staged.payload.satellite_pubkey === key.ed25519_pub && pinMatches(staged, pinned)) {
    const c = cur?.payload;
    forward = !c || (c.crow_id === staged.payload.crow_id && c.root_pubkey === staged.payload.root_pubkey
      && Date.parse(staged.payload.issued_at) > Date.parse(c.issued_at));
  }
  if (forward) {
    writeCert(satHome, staged);
    db.prepare("INSERT OR IGNORE INTO cert_serials (serial, accepted_at) VALUES (?, ?)").run(String(staged.payload.serial), new Date(now()).toISOString());
  }
  removeStagedCert(satHome);
  return forward ? "rolled_forward" : "discarded";
}
