/**
 * Extensions Panel — App store-style add-on browser
 *
 * Security note: All dynamic content is server-side escaped via escapeHtml().
 * Client-side modal content uses DOM manipulation with textContent for user data.
 * The Crow's Nest is auth-protected and only accessible on local/Tailscale networks.
 */

import { t } from "../shared/i18n.js";
import { extensionStyles } from "./extensions/css.js";
import { fetchRegistryData, fetchBundleStatus } from "./extensions/data-queries.js";
import { extensionsClientJS } from "./extensions/client.js";
import { handleExtensionsPost } from "./extensions/api-handlers.js";
import { buildExtensionsHTML } from "./extensions/html.js";

export default {
  id: "extensions",
  name: "Extensions",
  icon: "extensions",
  route: "/dashboard/extensions",
  navOrder: 80,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    // Handle POST for store management
    if (req.method === "POST" && req.body) {
      await handleExtensionsPost(req, res);
      if (res.headersSent) return;
    }

    const { installed, available, registrySource, communityStores } = await fetchRegistryData();
    const { bundleStatus } = fetchBundleStatus(installed);

    const {
      searchHtml,
      installedHtml,
      sourceNote,
      tabsHtml,
      gridHtml,
      storesHtml,
      helpHtml,
      addonRegistryScript,
    } = buildExtensionsHTML({ installed, available, registrySource, communityStores, bundleStatus, lang });

    // ─── Modal + client-side JavaScript ───
    // Modal JS preserved verbatim from original; filter + search JS rewritten
    const interactiveScript = extensionsClientJS(lang);

    const content = `
      ${extensionStyles()}
      ${searchHtml}
      ${installedHtml}
      ${sourceNote}
      ${tabsHtml}
      ${gridHtml}
      ${storesHtml}
      ${helpHtml}
      ${addonRegistryScript}
      ${interactiveScript}
    `;

    return layout({ title: t("extensions.pageTitle", lang), content });
  },
};
