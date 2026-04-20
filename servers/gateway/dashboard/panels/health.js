/**
 * Crow's Nest — Home Screen Panel
 *
 * App launcher hub with recent activity feed.
 * Orchestrator: imports modular data queries, HTML, CSS, client JS.
 */

import { nestCSS } from "./nest/css.js";
import { buildNestHTML } from "./nest/html.js";
import { nestClientJS } from "./nest/client.js";
import { getNestData } from "./nest/data-queries.js";
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

    // If the /dashboard wrapper stashed unified data, thread it through to
    // the nest data query + renderer. Otherwise the single-instance code
    // path is unchanged.
    const nestOpts = req._crowNest || {};
    const data = await getNestData(db, lang, nestOpts);
    const css = nestCSS();
    const html = buildNestHTML(data, lang);
    const js = nestClientJS(lang);
    const content = css + html + js;

    // Build instance tabs strip data for the layout when unified is on.
    const instanceTabs = nestOpts.unifiedOn && Array.isArray(nestOpts.trustedInstances)
      ? buildInstanceTabs(nestOpts.trustedInstances, nestOpts.peerOverviews || [])
      : null;

    return layout({ title: t("health.pageTitle", lang), content, instanceTabs });
  },
};
