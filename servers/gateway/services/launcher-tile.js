/**
 * The launcher's "Add a service" tile (project services Task 13): a page link to the scoped
 * project's Services page, for a project owner, while CROW_SERVICES_UI is on. Imported once at
 * dashboard boot (dashboard/index.js); the flag and the owner check are read per request.
 */
import { registerLauncherTile } from "../apps/extra-tiles.js";
import { servicesUiEnabled } from "./ui-flag.js";

registerLauncherTile({
  id: "add-service",
  labelKey: "shell.addService",
  icon: "plus",
  when: (c) => !!c.projectSlug && !!c.canManage && servicesUiEnabled(),
  href: (c) => "/dashboard/project/" + encodeURIComponent(c.projectSlug) + "/services",
});
