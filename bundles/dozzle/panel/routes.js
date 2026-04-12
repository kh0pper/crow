import { Router } from "express";

const DOZZLE_URL = () =>
  (process.env.DOZZLE_URL || "http://localhost:8095").replace(/\/+$/, "");

export default function dozzleRouter(authMiddleware) {
  const router = Router();

  router.get("/api/dozzle/status", authMiddleware, async (_req, res) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetch(`${DOZZLE_URL()}/healthcheck`, { signal: ctl.signal });
      res.json({ url: DOZZLE_URL(), reachable: r.ok, http_status: r.status });
    } catch (err) {
      res.json({ error: `Cannot reach Dozzle: ${err.message}` });
    } finally {
      clearTimeout(t);
    }
  });

  return router;
}
