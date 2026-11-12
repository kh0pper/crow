/**
 * Music panel status route.
 *
 * The Music panel used to ask GET /api/funkwhale/status, a route that only exists
 * while the Funkwhale PANEL is registered — so on an instance with the add-on
 * installed but its panel not mounted, the check failed and the panel told the
 * owner the library was missing. This route belongs to the gateway itself: it
 * reads the local Funkwhale addon env (the same reader the audio proxy uses) and
 * answers one word, never the address and never the token.
 *
 *   GET /api/music/status -> { state: "ready" | "unreachable" | "not_configured" }
 *
 * Always 200 for those three answers, no-store, behind dashboard auth.
 * Mounted at /api/music → outside PUBLIC_FUNNEL_PREFIXES → Funnel-blocked.
 */
import { Router } from "express";
import { readFunkwhaleEnv } from "./audio-proxy.js";

export default function musicStatusRouter(dashboardAuth, { fwEnv = readFunkwhaleEnv, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const router = Router();

  router.get("/api/music/status", dashboardAuth, async (_req, res) => {
    res.set("Cache-Control", "no-store");

    let fw = null;
    try { fw = fwEnv(); } catch { fw = null; } // an unreadable entry is "not configured", never a 500
    if (!fw || !fw.url) return res.status(200).json({ state: "not_configured" });

    try {
      // NodeInfo is public on Funkwhale: no bearer is sent, and a redirect is not followed.
      const up = await fetchImpl(`${fw.url}/api/v1/instance/nodeinfo/2.0/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.status(200).json({ state: up && up.ok ? "ready" : "unreachable" });
    } catch {
      // Network failure, timeout, DNS: the library is configured but did not answer.
      return res.status(200).json({ state: "unreachable" });
    }
  });

  return router;
}
