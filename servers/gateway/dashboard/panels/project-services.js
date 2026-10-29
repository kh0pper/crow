/**
 * A project's Services page (project services Task 10): /dashboard/project/<slug>/services.
 * What is connected in this project, the owner-only note, the members note when the project has
 * members, and what is connected in other projects. Its data is loadServicesPage, the same
 * payload the JSON API serves; its row actions call that API.
 *
 * Hidden behind CROW_SERVICES_UI (servicesUiEnabled): with the flag off the page answers 404.
 * New shell only: classic mode goes to the Projects page. The scope comes from the path
 * (shell/request.js SLUG_SCOPED_PANELS: the slug wins over the cookie and nothing is written; the
 * GET is read-only because Turbo prefetches it). An unknown or archived slug is a 404.
 * The Add and Connect sheets (Task 11) read the page's JSON block: catalog cards and copy, no value.
 * Hidden from the classic sidebar; reached only through the route above.
 */

import { t } from "../shared/i18n.js";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { installedBundleIds } from "../../skills-catalog.js";
import { loadServicesPage } from "../../routes/services-api.js";
import { servicesUiEnabled } from "../../services/ui-flag.js";
import { projectMissingHtml } from "./project-home/html.js";
import { projectHomeCss } from "./project-home/css.js";
import { projectServicesHtml } from "./project-services/html.js";
import { projectServicesCss } from "./project-services/css.js";
import { projectServicesClientJs, projectServicesDataScript } from "./project-services/client.js";

export default {
  id: "project-services",
  name: "Services",
  icon: "folder",
  route: "/dashboard/project-services",
  navOrder: 15.6,
  category: "tools",
  hidden: true, // a project's Services page in the new shell; never in the classic nav

  async handler(req, res, { db, layout, lang, uiEnabled = servicesUiEnabled }) {
    if (!uiEnabled()) {
      res.status(404).type("text").send("Not found");
      return null;
    }
    if (!req.crowMode || req.crowMode.mode !== "new") return res.redirect(302, "/dashboard/projects");
    const slug = req.params && typeof req.params.slug === "string" ? req.params.slug : null;
    const scope = req.crowScope;
    const page = slug && scope && scope.projectId != null && scope.slug === slug
      ? await loadServicesPage(db, slug, { installedIds: installedBundleIds(resolveCrowHome()), lang })
      : null;
    if (!page) {
      res.status(404);
      return layout({ title: t("shell.projectPage", lang), content: projectHomeCss() + projectMissingHtml(lang) });
    }
    return layout({
      title: t("services.page.title", lang),
      content: projectServicesCss() + projectServicesHtml(page, lang) + projectServicesDataScript(page, lang) + projectServicesClientJs(),
    });
  },
};
