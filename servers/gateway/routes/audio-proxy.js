/**
 * Owning-instance audio stream-proxy (federated playback).
 *
 * A paired peer (e.g. the home server's glasses voice loop) cannot reach this instance's
 * internal Funkwhale (http://crow-funkwhale) nor hold its token. This route lets
 * the peer stream audio THROUGH us: we reconstruct the listen URL from OUR OWN
 * Funkwhale addon env (never from caller input — no SSRF), fetch it with OUR
 * token, follow the storage redirect (dropping the bearer), and stream the bytes
 * back to the peer. The peer authenticates with its instance bearer
 * (instanceAuthMiddleware) and the funkwhale capability must be exposed to THAT
 * peer (the all-trusted-peers allowlist, or its own per-device grant — N1b-8).
 *
 * Mounted under /audio → outside PUBLIC_FUNNEL_PREFIXES → Funnel-blocked.
 */
import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExposedCapabilities, isCapabilityExposedToPeer } from "../peer-exposure.js";
import { resolveCrowHome } from "../proxy.js";
import { AddonKeysUnavailableError, hydrateAddonEntry, processUnsealer } from "../../shared/addon-secrets.js";
import { gatewayKeychainPaths } from "../addon-keys-paths.js";

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const CODECS = new Set(["mp3", "ogg", "opus"]);

/** Pure param validation (testable). */
export function validateAudioParams({ cap, id, codec } = {}) {
  if (cap !== "funkwhale") return { ok: false, error: "unsupported_capability" };
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad_id" };
  if (!CODECS.has(codec)) return { ok: false, error: "bad_codec" };
  return { ok: true, id, codec };
}

/**
 * Read the local Funkwhale addon env from <crowHome>/mcp-addons.json, unsealing the entry's
 * listed keychain names with THIS process's role (the gateway registers one; a child gets null
 * and falls back to the plain values + its own env). A key that cannot be produced keeps
 * today's answer: the plain entry env only — never half a secret.
 *
 * The result is the usable pair { url, token } plus `hostname` — the label the panel prints.
 * `hostname` is carried non-enumerably: it is not part of the pair a caller streams with, so a
 * consumer that copies the answer (spread, JSON) keeps getting exactly the two values it uses.
 */
export function readFunkwhaleEnv(crowHome = resolveCrowHome()) {
  let entry = null;
  try {
    const cfg = JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8"));
    entry = cfg?.funkwhale ?? null;
  } catch {
    return null; // not installed / unreadable
  }
  let hydrated = entry;
  if (entry && typeof entry === "object") {
    try {
      hydrated = hydrateAddonEntry("funkwhale", entry, { unsealer: processUnsealer(), ...gatewayKeychainPaths() });
    } catch (err) {
      if (!(err instanceof AddonKeysUnavailableError)) throw err;
      hydrated = entry; // a child's own env is all it gets (0.5); a listed name has no plain value
    }
  }
  const fw = hydrated?.env || hydrated || {};
  const url = fw.FUNKWHALE_URL;
  const token = fw.FUNKWHALE_ACCESS_TOKEN;
  if (!(url && token)) return null;
  const out = { url: String(url).replace(/\/+$/, ""), token: String(token) };
  Object.defineProperty(out, "hostname", {
    value: fw.FUNKWHALE_HOSTNAME ? String(fw.FUNKWHALE_HOSTNAME) : "",
    enumerable: false,
    writable: false,
  });
  return out;
}

export default function audioProxyRouter({ createDbClient, fetchImpl = fetch, fwEnv = readFunkwhaleEnv, getExposed = getExposedCapabilities, isExposedToPeer = isCapabilityExposedToPeer, now = () => Date.now() } = {}) {
  const router = Router();

  router.get("/audio/stream", async (req, res) => {
    if (!req.instanceAuth?.instance) return res.status(401).json({ error: "peer_auth_required" });

    const v = validateAudioParams({ cap: req.query.cap, id: req.query.id, codec: req.query.codec });
    if (!v.ok) return res.status(400).json({ error: v.error });

    const db = createDbClient();
    try {
      // Exposure is per-caller: the all-trusted-peers allowlist OR a grant made
      // to THIS peer (N1b-8 — a peer-scoped Allow must work for audio too).
      const exposed = await getExposed(db);
      let allowed = exposed.has("funkwhale");
      if (!allowed) {
        try { allowed = await isExposedToPeer(db, "funkwhale", req.instanceAuth.instance.id, { now: now() }); }
        catch { allowed = false; } // fail closed
      }
      if (!allowed) return res.status(403).json({ error: "not_exposed" });
    } finally { try { db.close(); } catch {} }

    const fw = fwEnv();
    if (!fw) return res.status(503).json({ error: "funkwhale_not_configured" });

    const listenUrl = `${fw.url}/api/v1/listen/${encodeURIComponent(v.id)}/?to=${v.codec}`;
    try {
      let up = await fetchImpl(listenUrl, { redirect: "manual", headers: { Authorization: `Bearer ${fw.token}` } });
      if (up.status >= 300 && up.status < 400) {
        const loc = up.headers.get("location");
        if (!loc) return res.status(502).json({ error: "redirect_no_location" });
        // Storage redirect carries its own auth — drop our bearer on this hop.
        up = await fetchImpl(new URL(loc, listenUrl).toString(), { redirect: "follow" });
      }
      if (!up.ok || !up.body) return res.status(502).json({ error: `upstream_${up.status}` });

      res.status(200);
      const ct = up.headers.get("content-type"); if (ct) res.setHeader("content-type", ct);
      const cl = up.headers.get("content-length"); if (cl) res.setHeader("content-length", cl);

      const reader = up.body.getReader();
      res.on("close", () => { try { reader.cancel(); } catch {} });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: String(err.message || err) });
      else { try { res.end(); } catch {} }
    }
  });

  return router;
}
