/**
 * The generic widget page (widgets phase 2, Task 3): /dashboard/widgets, one swipe (or one tap) in
 * from For You. It is the same grid as For You — widgets/grid-html.js draws it, widgets/grid-client.js
 * applies this device's layout and runs Edit mode — over EVERY widget the registry offers, with
 * "What needs me" and "Today + Ramble" as its default first screenful (spec §2.2). The rest are
 * offered by "+ Add widget" on this device only.
 *
 * Where the layout lives: `crow.widgets.layout.widgets` in this browser's localStorage (the spec's
 * per-device fallback), never the server, never a paired instance. The server cannot know which
 * cells this device removed, so it draws all of them and the client decides.
 *
 * Gates, in this order, on every method:
 *   - CROW_FOR_YOU must be "1" (forYouEnabled): the generic page is For You's own surface, so it is
 *     enabled with it and needs no second flag;
 *   - the request must be the owner's own local password session (isLocalPasswordSessionOn), else
 *     404: exactly For You's gate (panels/for-you.js), because both pages read the same data —
 *     What needs me, the bird's mood and steps, the calendar;
 *   - anything that is not GET/HEAD is 404: this page has no form.
 *
 * The reads are For You's own: `forYouContext` (panels/for-you.js) hands the registry the same
 * one-per-request weather, project list and "What needs me" summary, with the same seams; each
 * widget's load is bounded (widgets/registry.js WIDGET_TIMEOUT_MS), so a hung feed is one error cell.
 * Hidden from the classic sidebar and the drawer: For You's header link and the shell's swipe are
 * the way in (shell/chrome.js's for-you entry, shell/client.js's reveal chain).
 */
import { t } from "../shared/i18n.js";
import { isLocalPasswordSessionOn } from "../local-session.js";
import { forYouEnabled } from "../../for-you/flag.js";
import { readForYouSettings } from "../../for-you/settings.js";
import { loadWidgets, widgetsForPage } from "../../widgets/registry.js";
import { widgetsGridCss } from "../../widgets/grid-css.js";
import { widgetsMoreCss } from "../../widgets/more-html.js";
import { gridClientJs } from "../../widgets/grid-client.js";
import { instanceZone } from "../../../shared/schedule-store.js";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { forYouContext } from "./for-you.js";
import { widgetsPageHtml } from "./for-you/html.js";
import { forYouCss } from "./for-you/css.js";
import { forYouClientJs } from "./for-you/client.js";

export default {
  id: "widgets",
  name: "Widgets",
  icon: "grid",
  route: "/dashboard/widgets",
  navOrder: 15.8,
  category: "ai",
  hidden: true, // reached from For You's header link and the shell's swipe

  async handler(req, res, { db, layout, lang, enabled = forYouEnabled }) {
    if (!enabled() || !(await isLocalPasswordSessionOn(db, req))) {
      res.status(404).type("text").send("Not found");
      return null;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).type("text").send("Not found");
      return null;
    }
    const settings = await readForYouSettings(db);
    const crowHome = resolveCrowHome();
    const now = Date.now();
    let tz;
    try { tz = await instanceZone(db); } catch { tz = undefined; }
    // For You's own context: the same single-read weather, project list and summary, so a widget
    // moved from one page to the other shows the same thing on both.
    const context = forYouContext(db, { settings, crowHome, now, tz, lang });
    // Each widget degrades alone: a failed or timed-out read is its own one-line error cell.
    // `crowHome` is where the installed add-ons' own widgets come from (widgets/addons.js).
    const cells = await loadWidgets(widgetsForPage("widgets", { settings, crowHome }), context);
    return layout({
      title: t("widgets.page.title", lang),
      content: forYouCss() + widgetsGridCss() + widgetsMoreCss()
        + widgetsPageHtml({ cells }, lang, now)
        + forYouClientJs() + gridClientJs(),
    });
  },
};