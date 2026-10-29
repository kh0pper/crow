// An in-test satellite agent (SAT-1): just enough of the §4.2 pairing routes and the §5 signed
// management surface to drive crow's pairing client. It is a `fetchImpl`, no sockets. Every
// request is recorded ({url, method, headers, body}) so a test can inspect what crossed the wire.
import { randomBytes } from "node:crypto";
import {
  generateKeypair, satelliteIdFromPub, signBytes, helloSigningString, doneSigningString,
  pairMac, macEqualHex, certSha256, acceptCert, verifyRequest, signResponse, sha256Hex,
  normalizePairCode, AGENT_PROTOCOL,
} from "../../servers/shared/satellite-protocol.js";

export const FAKE_HOST = "satellite.example.ts.net";

export function createFakeSatellite({ code, tamper = {} } = {}) {
  const key = generateKeypair();
  const other = generateKeypair();
  const satId = satelliteIdFromPub(key.pubHex);
  const live = normalizePairCode(code);
  const state = { nonces: new Map(), wrong: 0, paired: null, unpaired: false, requests: [] };

  const json = (status, obj, extraHeaders = {}) => new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", ...extraHeaders },
  });

  function signed(status, obj, nonce) {
    const text = tamper.bigBody ? JSON.stringify({ pad: "x".repeat(tamper.bigBody) }) : JSON.stringify(obj);
    const priv = tamper.respSig ? other.privHex : key.privHex;
    const sig = signResponse(priv, { requestNonce: nonce, status, bodySha256: sha256Hex(text) });
    const ct = tamper.contentType || "application/json";
    return new Response(text, { status, headers: { "content-type": ct, "x-crow-sat-resp-sig": sig } });
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body == null ? "" : String(init.body);
    state.requests.push({ url: String(url), method, headers: { ...(init.headers || {}) }, body });
    if (tamper.unreachable) throw new TypeError("fetch failed");
    if (u.host !== FAKE_HOST || u.protocol !== "https:") throw new TypeError("fetch failed");
    const p = u.pathname;

    if (p === "/satellite/v1/pair/hello" && method === "POST") {
      const { nonce_c } = JSON.parse(body || "{}");
      const nonce_s = randomBytes(16).toString("hex");
      state.nonces.set(nonce_s, { nonce_c, used: false });
      const pub = tamper.helloPubkey ? other.pubHex : key.pubHex;
      const sig = signBytes(tamper.helloSig ? other.privHex : key.privHex,
        Buffer.from(helloSigningString({ nonceC: nonce_c, nonceS: nonce_s, satelliteId: satId })));
      return json(200, { satellite_id: satId, satellite_pubkey: pub, nonce_s, agent_protocol: AGENT_PROTOCOL, sig });
    }

    if (p === "/satellite/v1/pair/complete" && method === "POST") {
      if (state.paired) return json(409, { error: "already_paired" });
      const b = JSON.parse(body || "{}");
      const n = state.nonces.get(b.nonce_s);
      if (!n || n.used) return json(400, { error: "bad_nonce" });
      const expected = pairMac(live, { nonceC: n.nonce_c, nonceS: b.nonce_s, certSha256: certSha256(b.cert), satelliteId: satId });
      if (!macEqualHex(expected, b.mac)) {
        state.wrong += 1;
        return json(403, { error: "bad_mac" });
      }
      const ok = acceptCert(b.cert, { ownPubHex: key.pubHex });
      if (!ok.ok) return json(400, { error: ok.code });
      n.used = true;
      state.paired = { crow_id: b.crow_id, root_pubkey: b.root_pubkey, mgmt_pubkey: b.cert.payload.mgmt_pubkey, cert: b.cert, complete: b };
      const sig = signBytes(tamper.doneSig ? other.privHex : key.privHex,
        Buffer.from(doneSigningString({ nonceC: n.nonce_c, certSha256: certSha256(b.cert) })));
      return json(200, { ok: true, sig });
    }

    // Signed management routes (§5.1).
    if (!state.paired) return json(409, { error: "not_paired" });
    const v = verifyRequest(state.paired.mgmt_pubkey, {
      method, pathQuery: u.pathname + u.search, body, headers: init.headers || {}, satelliteId: satId,
    });
    if (!v.ok) return json(401, { error: v.code });
    if (p === "/satellite/v1/unpair" && method === "POST") {
      state.unpaired = JSON.parse(body || "{}");
      state.paired = null;
      return signed(200, { ok: true }, v.nonce);
    }
    if (p === "/satellite/v1/status") return signed(200, { ok: true, caller: v.caller }, v.nonce);
    return signed(404, { error: "not_found" }, v.nonce);
  }

  return { fetchImpl, state, satId, pubHex: key.pubHex, privHex: key.privHex, code };
}

/** A crow root identity shaped like servers/sharing/identity.js's (crowId bound to the key). */
export function fakeIdentity() {
  const k = generateKeypair();
  const hash = Buffer.from(sha256Hex(Buffer.from(k.pubHex, "hex")), "hex");
  const crowId = `crow:${hash.readBigUInt64BE(0).toString(36).slice(0, 10).padStart(10, "0")}`;
  return { crowId, ed25519Priv: Buffer.from(k.privHex, "hex"), ed25519Pubkey: k.pubHex, ed25519Pub: Buffer.from(k.pubHex, "hex") };
}
