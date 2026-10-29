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
import { activeProjects } from "../../../shared/shell-items.js";
import { attachableBots, projectBots, startData } from "./project-home/data.js";

export default {
  id: "perch",
  name: "Perch Hub",
  icon: "bot",
  route: "/dashboard/perch",
  navOrder: 15.5,
  category: "ai",

  async handler(req, res, { db, lang, layout }) {
    // engineStatus() is a LEAF module of synchronous fs stats
    // (bot-engine-status.js:84) — safe and cheap from a route. /roost cannot
    // report engine state, so without this the list looks normal and the
    // first tap fails with a raw error.
    const newMode = !!(req.crowMode && req.crowMode.mode === "new");
    // New mode: the header names a session's project and sends Back to its
    // home, so the page carries the active projects' {id, slug, name}.
    let projects = [];
    if (newMode && db) {
      try { projects = await activeProjects(db); }
      catch (err) { console.warn("[perch] project list failed:", err?.message || err); }
    }
    // New mode: "Start a session" (shared/session-cards.js) offers the
    // project's bots in a project, every Perch-attachable bot elsewhere, with
    // the lead (or ?bot=<id>, the Bot Builder card's Chat link) picked.
    let start = null;
    if (newMode) {
      const scope = req.crowScope || { all: true };
      const want = req.query && typeof req.query.bot === "string" ? req.query.bot : null;
      try {
        const bots = !db ? [] : scope.projectId ? await projectBots(db, scope.projectId) : await attachableBots(db);
        start = startData(bots, want);
      } catch (err) {
        console.warn("[perch] start bots failed:", err?.message || err);
        start = startData([]);
      }
    }
    return layout({
      title: t("perch.title", lang),
      // Shell P2: in the new shell the Chat tab shows the current project's
      // conversations. Classic Perch gets no scope and stays as it was.
      content: perchHubContent(lang, engineStatus(),
        newMode ? { scope: req.crowScope || { all: true }, projects, start } : {}),
    });
  },
};
