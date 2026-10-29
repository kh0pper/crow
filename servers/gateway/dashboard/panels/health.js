/**
 * Crow's Nest — Home Screen Panel
 *
 * App launcher hub with recent activity feed.
 * Orchestrator: imports modular data queries, HTML, CSS, client JS.
 */

import { nestCSS } from "./nest/css.js";
import { buildNestHTML } from "./nest/html.js";
import { nestClientJS } from "./nest/client.js";
import { getNestData, getTrustedInstances } from "./nest/data-queries.js";
import { collectHealthSignals, invalidateHealthCache } from "./nest/health-signals.js";
import { getPeerOverview } from "../overview-cache.js";
import { readSetting, writeSetting } from "../settings/registry.js";
import { Router } from "express";
import { parseCookies } from "../auth.js";
import { SUPPORTED_LANGS } from "../shared/i18n.js";
import { resolveRequestMode, safeReturnPath } from "../shell/request.js";
import { getInstance, getOrCreateLocalInstanceId } from "../../instance-registry.js";
import { t } from "../shared/i18n.js";
import { attentionGroupHtml } from "../shell/attention.js";
import { renderFixItCards } from "../../fix-it/index.js";

async function resolveLocalInstanceName(db, lang) {
  try {
    const id = getOrCreateLocalInstanceId();
    const inst = await getInstance(db, id);
    if (inst && inst.name) return inst.name;
  } catch { /* fall through */ }
  return t("nest.thisCrow", lang) || "This Crow";
}

/**
 * Build the per-instance tabs strip model. Local tab first (labeled with
 * the local instance's own name), then each trusted peer. Offline or
 * unavailable peers get aria-disabled.
 */
function buildInstanceTabs(trustedInstances, peerOverviews, localName) {
  const tabs = [{ id: "local", name: localName, status: "online", isLocal: true }];
  for (let i = 0; i < trustedInstances.length; i++) {
    const inst = trustedInstances[i];
    const overview = peerOverviews[i];
    const online = overview && overview.status === "ok";
    tabs.push({
      id: inst.id,
      name: inst.name || "peer",
      status: online ? "online" : "offline",
      isLocal: false,
    });
  }
  return tabs;
}

const ACK_KEY_CAP = 50;
const ATTENTION_FALLBACK = "/dashboard/attention";

/**
 * Health attention routes. Mount after dashboardAuth + csrfMiddleware, and
 * before the /dashboard/:panelId catch-all.
 *   POST /dashboard/health/ack  - "This is expected" for a foreign Funnel mapping.
 *   GET  /dashboard/attention/fragment - the sheet's "Needs attention" group.
 *   GET  /dashboard/attention   - where alert notifications land: the sheet in
 *                                 new mode, the nest's health card in classic.
 */
export function healthAttentionRouter({ createDbClient }) {
  const router = Router();

  router.post("/dashboard/health/ack", async (req, res) => {
    const kind = req.body ? req.body.kind : undefined;
    const key = req.body && typeof req.body.key === "string" ? req.body.key : "";
    if (kind !== "exposure-foreign" || key === "" || key.length > 1024) {
      return res.status(400).type("text/plain").send("unknown kind or empty key");
    }
    const db = createDbClient();
    try {
      let keys = [];
      try {
        const parsed = JSON.parse((await readSetting(db, "health_ack_exposure_foreign")) || "[]");
        if (Array.isArray(parsed)) keys = parsed.filter((k) => typeof k === "string");
      } catch {}
      if (!keys.includes(key)) keys.push(key);
      keys = keys.slice(-ACK_KEY_CAP);
      await writeSetting(db, "health_ack_exposure_foreign", JSON.stringify(keys), { scope: "local" });
      invalidateHealthCache();
    } finally {
      db.close();
    }
    const raw = req.body.back;
    const back = safeReturnPath(raw);
    // safeReturnPath's fallback is the shell's Chat; this route's is the attention route.
    return res.redirect(303, back === "/dashboard/perch" && raw !== "/dashboard/perch" ? ATTENTION_FALLBACK : back);
  });

  // The sheet's "Needs attention" group, loaded each time the sheet opens.
  router.get("/dashboard/attention/fragment", async (req, res) => {
    const cookieLang = parseCookies(req).crow_lang;
    const lang = SUPPORTED_LANGS.includes(cookieLang) ? cookieLang : "en";
    const db = createDbClient();
    let issues = [];
    try {
      issues = (await collectHealthSignals(db, { lang })).issues || [];
    } catch {
      issues = [];
    } finally {
      db.close();
    }
    res.set("Cache-Control", "no-store");
    res.type("text/html").send(attentionGroupHtml(issues, lang));
  });

  router.get("/dashboard/attention", async (req, res) => {
    const db = createDbClient();
    try {
      const isNew = (await resolveRequestMode(req, res, db)).mode === "new";
      return res.redirect(303, isNew ? "/dashboard/perch?sheet=attention" : "/dashboard/nest?open=1");
    } catch {
      return res.redirect(303, "/dashboard/nest?open=1");
    } finally {
      db.close();
    }
  });

  return router;
}

export default {
  id: "nest",
  name: "Crow's Nest",
  icon: "health",
  route: "/dashboard/nest",
  navOrder: 1,
  hidden: false,
  category: "core",
  preload: true,

  async handler(req, res, { db, lang, layout }) {
    // Handle POST actions (pin/unpin)
    if (req.method === "POST") {
      const { action } = req.body;
      if (action === "pin") {
        const { item_type, item_id, item_label, item_href } = req.body;
        if (item_type && item_id && item_label && item_href) {
          const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nest_pinned_items'", args: [] });
          const pinned = rows[0]?.value ? JSON.parse(rows[0].value) : [];
          // Avoid duplicates
          if (!pinned.find(p => p.type === item_type && p.id === item_id)) {
            pinned.push({ type: item_type, id: item_id, label: item_label, href: item_href });
            await db.execute({
              sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nest_pinned_items', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
              args: [JSON.stringify(pinned), JSON.stringify(pinned)],
            });
          }
        }
        res.redirectAfterPost("/dashboard/nest?open=1");
        return;
      }
      if (action === "unpin") {
        const { item_type, item_id } = req.body;
        const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nest_pinned_items'", args: [] });
        let pinned = rows[0]?.value ? JSON.parse(rows[0].value) : [];
        pinned = pinned.filter(p => !(p.type === item_type && p.id === item_id));
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nest_pinned_items', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [JSON.stringify(pinned), JSON.stringify(pinned)],
        });
        res.redirectAfterPost("/dashboard/nest?open=1");
        return;
      }
    }

    // Resolve unified-dashboard opts. Two entry paths lead here:
    //   1. /dashboard  → wrapper in dashboard/index.js prefetches + stashes
    //      req._crowNest and reroutes. We inherit that data.
    //   2. /dashboard/nest  → direct nav (bookmarks, cross-instance links).
    //      The wrapper didn't run; we must fetch here ourselves.
    // Falling through to branch 2 is the common case on an already-running
    // deployment — /dashboard/nest is the typical bookmark target.
    let nestOpts = req._crowNest;
    if (!nestOpts) {
      const unifiedEnvOn = process.env.CROW_UNIFIED_DASHBOARD !== "0";
      const setting = await readSetting(db, "unified_dashboard_enabled");
      const unifiedOn = unifiedEnvOn && setting !== "false";
      nestOpts = { unifiedOn, trustedInstances: [], peerOverviews: [] };
      if (unifiedOn) {
        try {
          const trusted = await getTrustedInstances(db);
          if (trusted.length > 0) {
            const budget = new Promise((r) => setTimeout(() => r("__budget__"), 1500));
            const fan = Promise.allSettled(trusted.map(i => getPeerOverview(db, i.id)));
            const settled = await Promise.race([fan, budget]);
            const peerOverviews = Array.isArray(settled)
              ? settled.map((s, i) => s.status === "fulfilled" ? s.value : {
                  instanceId: trusted[i].id,
                  status: "unavailable",
                  reason: s.reason?.message || "rejected",
                  tiles: [],
                })
              : trusted.map(i => ({
                  instanceId: i.id,
                  status: "unavailable",
                  reason: "budget_exceeded",
                  tiles: [],
                }));
            nestOpts.trustedInstances = trusted;
            nestOpts.peerOverviews = peerOverviews;
          }
        } catch (err) {
          console.warn("[nest] unified fetch failed, falling back to single-instance:", err.message);
        }
      }
    }

    const data = await getNestData(db, lang, nestOpts);

    // Collect health signals (30s cached; fails gracefully to null if throws)
    let healthSignals = null;
    try {
      healthSignals = await collectHealthSignals(db, { lang });
    } catch {}

    // Fix-it cards (fails gracefully to "" if anything throws)
    let fixItHtml = "";
    try {
      fixItHtml = await renderFixItCards(db, { lang, req });
    } catch {}

    // Flash param from post-backup / fix-it redirects
    const flash = (typeof req.query?.flash === "string" &&
      ["backup_ok", "backup_fail", "fixit_fixed", "fixit_dismissed", "fixit_error"].includes(req.query.flash))
      ? req.query.flash
      : null;

    const css = nestCSS();
    const html = buildNestHTML({ ...data, healthSignals, flash, fixItHtml }, lang);
    const js = nestClientJS(lang);
    const content = css + html + js;

    // Build instance tabs strip data for the layout when unified is on AND
    // at least one trusted peer exists. Otherwise strip stays hidden via
    // body.unified-off CSS.
    const hasTrustedPeers = Array.isArray(nestOpts.trustedInstances) && nestOpts.trustedInstances.length > 0;
    const localName = nestOpts.unifiedOn && hasTrustedPeers
      ? await resolveLocalInstanceName(db, lang)
      : null;
    const instanceTabs = nestOpts.unifiedOn && hasTrustedPeers
      ? buildInstanceTabs(nestOpts.trustedInstances, nestOpts.peerOverviews || [], localName)
      : null;

    return layout({ title: t("health.pageTitle", lang), content, instanceTabs });
  },
};
