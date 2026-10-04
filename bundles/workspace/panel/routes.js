/**
 * Workspace panel routes:
 *  - K5 live-edit endpoints (/api/workspace/live/v1/*): editor-session-JWT auth, NO dashboard session
 *    (server/live/routes-live.js; express's Router/json are injected from here — F2);
 *  - the K5 close-time queue worker (one per gateway process; starts once Workspace is set up);
 *  - Quick edit (/api/workspace/quick/*): dashboard session + CSRF, writes as crow-bot (Task 14 modules).
 *
 * The gateway calls this factory SYNCHRONOUSLY, so every bundle module and the DB are resolved lazily on first use.
 * COPIED ALONE to $CROW_HOME/panels/workspace-routes.js, so bundle modules are imported by absolute URL from
 * BUNDLE_DIR (the ramble pattern) — never by a relative ../server import. STRICT_PANEL_MOUNT: every middleware is
 * path-scoped (this router is mounted at the app root).
 */
import express from "express";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "workspace"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "workspace") : null,
  resolve(__dirname, ".."),
].filter(Boolean);
/** The ONE bundle-dir resolver: panel/workspace.js (also copied alone) imports it from this file. */
export const BUNDLE_DIR = CANDIDATES.find((p) => existsSync(join(p, "manifest.json")) && existsSync(join(p, "server", "config.js"))) || CANDIDATES.at(-1);
const bundleImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);
const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export default function workspaceRouter(authMiddleware, seams = {}) {
  const router = express.Router();
  const clock = seams.clock || realClock;
  let csrf = seams.csrf || null;
  const csrfMw = async (req, res, next) => {
    if (!csrf) { const root = process.env.CROW_APP_ROOT || resolve(BUNDLE_DIR, "..", ".."); csrf = (await import(pathToFileURL(join(root, "servers", "gateway", "dashboard", "shared", "csrf.js")).href)).csrfMiddleware; }
    return csrf(req, res, next);
  };

  // ---- K5 live endpoints (Task 13). Registered synchronously, built on first request. ----
  let live = null;
  router.use("/api/workspace/live/v1", (req, res, next) => {
    live ??= (async () => {
      const [{ openWorkspaceDb }, { getConfig }, { liveRouter }] = await Promise.all([bundleImport("server/db.js"), bundleImport("server/config.js"), bundleImport("server/live/routes-live.js")]);
      return liveRouter({ Router: express.Router, json: express.json, db: await openWorkspaceDb(), getConfig, clock });
    })();
    live.then((r) => r(req, res, next), (e) => { live = null; console.warn(`[workspace] live endpoints unavailable: ${e.message}`); if (!res.headersSent) res.status(503).json({ error: "unavailable" }); });
  });

  // ---- K5 close-time worker: one per gateway process; waits until Workspace is set up (getConfig not_ready). ----
  if (seams.startWorker !== false) {
    const tryStart = async () => {
      try {
        const [{ openWorkspaceDb }, { getConfig }, { startQueueWorker }] = await Promise.all([bundleImport("server/db.js"), bundleImport("server/config.js"), bundleImport("server/queue/worker.js")]);
        getConfig();
        startQueueWorker({ db: await openWorkspaceDb(), getConfig, clock }); // recovers rows stranded in applying_close first
      } catch { setTimeout(tryStart, 5 * 60e3).unref(); }
    };
    setTimeout(tryStart, 5000).unref();
  }

  // ---- Quick edit (Task 14; handlers import their modules on first use) ----
  router.use("/api/workspace/quick", express.urlencoded({ extended: false, limit: "64kb" }), authMiddleware, csrfMw);
  const back = (res, form, notice, extra = {}) => res.redirect(303, `/dashboard/workspace?${new URLSearchParams({ view: "quick", path: String(form.path || ""), notice, ...extra }).toString()}`);
  const handle = (fn, okNotice, { choice = false } = {}) => async (req, res) => {
    const form = req.body || {};
    const lang = (req.headers["accept-language"] || "").startsWith("es") ? "es" : "en";
    try {
      const [{ getConfig }, actions] = await Promise.all([bundleImport("server/config.js"), bundleImport("server/quick/actions.js")]);
      const r = await fn(actions, getConfig(), form);
      if (r?.queued) { const { renderQueued } = await bundleImport("server/quick/view.js"); return res.status(200).type("html").send(renderQueued({ lang, csrf: req.csrfToken || form._csrf, form, r })); }
      return back(res, form, okNotice, r?.version_id ? { v: r.version_id } : {});
    } catch (err) {
      if (choice && ["open_in_editor", "locked_by_person", "stale_editor_lock"].includes(err?.code)) {
        const { renderChoice } = await bundleImport("server/quick/view.js");
        return res.status(200).type("html").send(renderChoice({ lang, csrf: req.csrfToken || form._csrf, form, err }));
      }
      // Review I10 / T14 minor: only the error CODE travels in the URL (browser history, access logs); the page shows
      // a localized text for it and never reflects a message from the query string.
      const code = /^[a-z_]{1,40}$/.test(String(err?.code || "")) ? err.code : "error";
      return back(res, form, code);
    }
  };
  router.post("/api/workspace/quick/save", handle((a, cfg, f) => a.quickSave(cfg, f, clock), "saved", { choice: true }));
  router.post("/api/workspace/quick/undo", handle((a, cfg, f) => a.quickUndo(cfg, f, clock), "undone"));
  router.post("/api/workspace/quick/restore", handle((a, cfg, f) => a.quickRestore(cfg, f, clock), "restored"));
  router.post("/api/workspace/quick/cancel", handle(async (a, cfg, f) => { const { queueDefs } = await bundleImport("server/tools/queue.js"); await queueDefs[1].run({ change_id: String(f.change_id || "") }); return {}; }, "cancelled"));
  return router;
}
