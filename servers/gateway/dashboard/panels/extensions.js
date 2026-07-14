/**
 * Extensions Panel — App store-style add-on browser
 *
 * Security note: All dynamic content is server-side escaped via escapeHtml().
 * Client-side modal content uses DOM manipulation with textContent for user data.
 * The Crow's Nest is auth-protected and only accessible on local/Tailscale networks.
 */

import { t } from "../shared/i18n.js";
import { extensionStyles } from "./extensions/css.js";
import { fetchRegistryData, fetchBundleStatus, fetchNeedsConfig, dockerAvailable } from "./extensions/data-queries.js";
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

    const { installed, available, collections, registrySource, communityStores } = await fetchRegistryData();
    const { bundleStatus } = fetchBundleStatus(installed);
    // Config completeness is computed HERE, never in html.js (which stays pure and
    // is unit-tested without ~/.crow).
    const needsConfig = fetchNeedsConfig(installed);
    // Docker banner state (Item 4-PR5): cached ~60s with a short probe timeout,
    // so a hung docker daemon can never block the page render.
    const dockerOk = await dockerAvailable();

    const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
      installed, available, collections, registrySource, communityStores, bundleStatus, needsConfig, dockerOk, lang,
    });

    // ─── Modal + client-side JavaScript ───
    const interactiveScript = extensionsClientJS(lang);

    const content = `
      ${extensionStyles()}
      ${viewsHtml}
      ${addonRegistryScript}
      ${collectionsScript}
      ${interactiveScript}
    `;

    return layout({ title: t("extensions.pageTitle", lang), content });
  },
};
