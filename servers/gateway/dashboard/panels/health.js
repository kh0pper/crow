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
import { getPeerOverview } from "../overview-cache.js";
import { readSetting } from "../settings/registry.js";
import { t } from "../shared/i18n.js";

/**
 * Build the per-instance tabs strip model. Local tab first, then each
 * trusted peer. Offline/unavailable peers get aria-disabled.
 */
function buildInstanceTabs(trustedInstances, peerOverviews) {
  const tabs = [{ id: "local", name: "This Crow", status: "online", isLocal: true }];
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
        res.redirectAfterPost("/dashboard/nest");
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
        res.redirectAfterPost("/dashboard/nest");
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
    const css = nestCSS();
    const html = buildNestHTML(data, lang);
    const js = nestClientJS(lang);
    const content = css + html + js;

    // Build instance tabs strip data for the layout when unified is on AND
    // at least one trusted peer exists. Otherwise strip stays hidden via
    // body.unified-off CSS.
    const hasTrustedPeers = Array.isArray(nestOpts.trustedInstances) && nestOpts.trustedInstances.length > 0;
    const instanceTabs = nestOpts.unifiedOn && hasTrustedPeers
      ? buildInstanceTabs(nestOpts.trustedInstances, nestOpts.peerOverviews || [])
      : null;

    return layout({ title: t("health.pageTitle", lang), content, instanceTabs });
  },
};
