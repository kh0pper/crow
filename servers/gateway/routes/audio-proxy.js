/**
 * Owning-instance audio stream-proxy (federated playback).
 *
 * A paired peer (e.g. grackle's glasses voice loop) cannot reach this instance's
 * internal Funkwhale (http://crow-funkwhale) nor hold its token. This route lets
 * the peer stream audio THROUGH us: we reconstruct the listen URL from OUR OWN
 * Funkwhale addon env (never from caller input — no SSRF), fetch it with OUR
 * token, follow the storage redirect (dropping the bearer), and stream the bytes
 * back to the peer. The peer authenticates with its instance bearer
 * (instanceAuthMiddleware) and the funkwhale capability must be exposed to peers.
 *
 * Mounted under /audio → outside PUBLIC_FUNNEL_PREFIXES → Funnel-blocked.
 */
import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExposedCapabilities } from "../peer-exposure.js";
import { resolveCrowHome } from "../proxy.js";

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const CODECS = new Set(["mp3", "ogg", "opus"]);

/** Pure param validation (testable). */
export function validateAudioParams({ cap, id, codec } = {}) {
  if (cap !== "funkwhale") return { ok: false, error: "unsupported_capability" };
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad_id" };
  if (!CODECS.has(codec)) return { ok: false, error: "bad_codec" };
  return { ok: true, id, codec };
}

/** Read the local Funkwhale addon env from ~/.crow/mcp-addons.json. */
export function readFunkwhaleEnv(crowHome = resolveCrowHome()) {
  try {
    const cfg = JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8"));
    const fw = cfg?.funkwhale?.env || cfg?.funkwhale || {};
    const url = fw.FUNKWHALE_URL;
    const token = fw.FUNKWHALE_ACCESS_TOKEN;
    if (url && token) return { url: String(url).replace(/\/+$/, ""), token: String(token) };
  } catch { /* not installed / unreadable */ }
  return null;
}

export default function audioProxyRouter({ createDbClient, fetchImpl = fetch, fwEnv = readFunkwhaleEnv, getExposed = getExposedCapabilities } = {}) {
  const router = Router();

  router.get("/audio/stream", async (req, res) => {
    if (!req.instanceAuth?.instance) return res.status(401).json({ error: "peer_auth_required" });

    const v = validateAudioParams({ cap: req.query.cap, id: req.query.id, codec: req.query.codec });
    if (!v.ok) return res.status(400).json({ error: v.error });

    const db = createDbClient();
    try {
      const exposed = await getExposed(db);
      if (!exposed.has("funkwhale")) return res.status(403).json({ error: "not_exposed" });
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
