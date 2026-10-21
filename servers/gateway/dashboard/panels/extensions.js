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
import { localModelsCounts } from "./extensions/local-models-card.js";

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
    // First-view banner (Crow keychain): ids + labels only, never secrets.
    let keychainPending = [];
    try {
      const { pendingFirstViews } = await import("../../keychain/store.js");
      const { loadKeychainKey } = await import("../../keychain/key.js");
      keychainPending = (await pendingFirstViews(db, { keyId: loadKeychainKey()?.id || null })).map((e) => ({ id: e.id, label: e.label }));
    } catch { /* no banner rather than no page */ }
    // Vault saving needs Vaultwarden on https (post-spike R-B); any failure = not secure.
    let vaultSecure = false;
    if (installed.vaultwarden) {
      try {
        const { vaultwardenStatus } = await import("../../keychain/vault-save.js");
        vaultSecure = vaultwardenStatus().secure === true;
      } catch { vaultSecure = false; }
    }

    // Add-on launchers that a re-pin would fix (an updated uv, an edited run.sh).
    let needsRepin = {};
    try {
      const { addonsNeedingRepin } = await import("./extensions/data-queries.js");
      needsRepin = addonsNeedingRepin(Object.keys(installed));
    } catch { needsRepin = {}; }

    // The Local models card's counts come from the lifecycle listing
    // (provider rows), computed here so html.js stays pure.
    let localModels = { registered: 0, resident: 0 };
    try {
      const { defaultLifecycleCore } = await import("../../models/lifecycle-deps.js");
      const core = defaultLifecycleCore();
      localModels = localModelsCounts(() => core.listing());
    } catch { /* zero counts rather than no page */ }

    const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
      installed, available, collections, registrySource, communityStores, bundleStatus, needsConfig, needsRepin, dockerOk, keychainPending, vaultSecure, localModels, lang,
      // A skill's "Go to <extension>" arrives as ?q=<id>: the search box starts filled in.
      searchQuery: typeof req.query?.q === "string" ? req.query.q.slice(0, 100) : "",
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
