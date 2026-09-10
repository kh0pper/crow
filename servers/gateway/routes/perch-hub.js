import { Router } from "express";
import { perchHubDocument } from "../dashboard/perch-hub/html.js";
import { SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { parseCookies } from "../dashboard/auth.js";
import { engineStatus } from "../bot-engine-status.js";

/** Mounted at "/dashboard" by dashboard/index.js, so this serves
 *  /dashboard/perch and inherits that mount's auth + CSRF chain. */
export default function perchHubRouter(dashboardAuth) {
  const router = Router();
  // Belt and braces, deliberately. dashboard/index.js:614 already applies
  // dashboardAuth to the whole /dashboard mount BEFORE this router is added at
  // ~713, so this is redundant TODAY. It is kept because perchApiRouter does
  // the same (routes/perch-interactive-api.js:628-633: "installs dashboardAuth
  // on its own prefix so it is closed wherever it is mounted") — the router
  // stays safe if it is ever re-mounted somewhere else. dashboardAuth is
  // idempotent, so running twice costs a session lookup and nothing else.
  router.use("/perch", dashboardAuth);
  router.get("/perch", (req, res) => {
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    // engineStatus() is a LEAF module of synchronous fs stats
    // (bot-engine-status.js:84) — safe and cheap from a route. /roost cannot
    // report engine state, so without this the list looks normal and the first
    // tap fails with a raw error.
    res.type("html").send(perchHubDocument(lang, engineStatus()));
  });
  return router;
}
