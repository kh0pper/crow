/**
 * Perch Hub Panel — bot chat surface, registered so it gets a nav entry and
 * a launcher icon like every other panel (it did not, before this file —
 * it was a bare route mounted straight onto /dashboard from index.js).
 *
 * Renders through the dashboard shell's layout(), like every other panel.
 * It used to render its own standalone document (perchHubDocument, now
 * perchHubContent) and bypass layout() deliberately — that's what made the
 * crow sidebar disappear on this page. perch-hub/css.js now scopes every
 * Perch style under #perch-hub-root specifically so this is safe: Perch
 * keeps its own palette without leaking onto the sidebar or any other
 * panel.
 */

import { perchHubContent } from "../perch-hub/html.js";
import { engineStatus } from "../../bot-engine-status.js";
import { t } from "../shared/i18n.js";

export default {
  id: "perch",
  name: "Perch Hub",
  icon: "messages",
  route: "/dashboard/perch",
  navOrder: 15.5,
  category: "ai",

  async handler(req, res, { lang, layout }) {
    // engineStatus() is a LEAF module of synchronous fs stats
    // (bot-engine-status.js:84) — safe and cheap from a route. /roost cannot
    // report engine state, so without this the list looks normal and the
    // first tap fails with a raw error.
    return layout({
      title: t("perch.title", lang),
      content: perchHubContent(lang, engineStatus()),
    });
  },
};
