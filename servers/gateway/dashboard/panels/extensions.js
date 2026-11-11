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
import { serversClientJS } from "./extensions/servers-client.js";
import { serversPanelData } from "./extensions/servers-data.js";
import { isLocalPasswordSessionOn } from "../local-session.js";

// Test-only: stand in for the invite-state read, which logs in to the app's own
// admin panel (a test has no container). The session gate in front of it still runs.
let _inviteStatesForTest = null;
export function _setInviteStatesForTest(fn) { _inviteStatesForTest = fn || null; }

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
    // Satellite-hosted bundles (SAT-5) have no local folder, containers or env: the local
    // status and config readers only ever see the local ones.
    const localInstalled = Object.fromEntries(Object.entries(installed).filter(([, v]) => v?.mode !== "satellite"));
    const { bundleStatus } = fetchBundleStatus(localInstalled);
    // Config completeness is computed HERE, never in html.js (which stays pure and
    // is unit-tested without ~/.crow).
    const needsConfig = fetchNeedsConfig(localInstalled);
    const { satellites, satelliteEligibleIds, offsite } = await serversPanelData(db);
    // Installed service add-ons already configured Crow-wide (legacy, before project
    // connections): Configure keeps their account fields (project services Task 12).
    let legacyAccounts = {};
    try {
      const { configuredAccountFields } = await import("../../bundles-config.js");
      for (const id of Object.keys(localInstalled)) if (configuredAccountFields(id).length) legacyAccounts[id] = true;
    } catch { legacyAccounts = {}; }
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
      needsRepin = addonsNeedingRepin(Object.keys(localInstalled));
    } catch { needsRepin = {}; }

    // Security audit N3-4: installed apps whose OWN first-admin setup the operator
    // has not said is finished. Read here (fs + db) so html.js stays pure. Two extra
    // inputs decide whether a card is still owed: the keychain holding this app's
    // admin login (ONE metadata query, no decryption) and what Crow's own setup run
    // did for this install.
    let firstAdminPending = [];
    try {
      const { getManifest, getLiveProxyIds, getProxyMountFailure } = await import("../../routes/extension-proxy.js");
      const { pendingFirstAdminNotices, firstAdminDoneValues, firstAdminAutoResults, firstAdminSavedBundleIds } = await import("../../bundle-first-admin.js");
      const manifests = {};
      for (const id of Object.keys(localInstalled)) manifests[id] = getManifest(id);
      // Security audit N3-4 phase 2e: an invite-only app's card is decided by what its
      // OWN admin API reports (accounts + sign-ups). The handler is resolved from the
      // REVIEWED repo manifest (bundles-config getManifest — the same copy the routes
      // use), never from the installed manifest, which the bundle's own container can
      // rewrite; and only the real Vaultwarden bundle may run it. Computing a state
      // means logging in to the app's admin panel, so it is done on the owner's own
      // session only; otherwise the card stays "cannot read" (cached ~5 min).
      let inviteStates = {};
      try {
        if (localInstalled.vaultwarden && await isLocalPasswordSessionOn(db, req)) {
          const { getManifest: getReviewedManifest } = await import("../../bundles-config.js");
          const { inviteStatesFor } = await import("../../first-admin/vaultwarden-invite.js");
          const readInviteStates = _inviteStatesForTest || inviteStatesFor;
          inviteStates = await readInviteStates({
            installed: localInstalled,
            manifest: getReviewedManifest("vaultwarden"),
            db,
          });
        }
      } catch (err) {
        // No state is the safe direction (the card says it cannot read the app), but
        // a silent catch hid a broken import once: say so, one line, no secrets.
        inviteStates = {};
        console.warn(`[extensions] invite state not computed: ${err?.message ?? err}`);
      }
      firstAdminPending = pendingFirstAdminNotices({
        installed: localInstalled,
        manifests,
        done: await firstAdminDoneValues(db),
        liveProxyIds: getLiveProxyIds(),
        // A router that failed to mount is not a pending restart (N5).
        proxyMountFailed: !!getProxyMountFailure(),
        adminSaved: await firstAdminSavedBundleIds(db, manifests),
        autoResults: await firstAdminAutoResults(db),
        inviteStates,
      });
    } catch { /* no card rather than no page */ }

    // API-key cards: an installed add-on whose REQUIRED, typed secret env var is still
    // empty and whose manifest explains where the key comes from. Emptiness is the same
    // needsConfig map the page already computed; both the fields and the manifest are read
    // from the REVIEWED repo copy (getManifest), never the installed one. A card disappears
    // by itself once the key is set, so nothing is stored.
    let apiKeyCards = [];
    try {
      const { getManifest: getReviewedManifest } = await import("../../bundles-config.js");
      const { pendingApiKeyCards } = await import("../shared/api-key-card.js");
      const apiKeyManifests = {};
      for (const id of Object.keys(localInstalled)) apiKeyManifests[id] = getReviewedManifest(id);
      apiKeyCards = pendingApiKeyCards({ installed: localInstalled, manifests: apiKeyManifests, needsConfig });
    } catch { apiKeyCards = []; }

    // The Local models card's counts come from the lifecycle listing
    // (provider rows), computed here so html.js stays pure.
    let localModels = { registered: 0, resident: 0 };
    try {
      const { defaultLifecycleCore } = await import("../../models/lifecycle-deps.js");
      const core = defaultLifecycleCore();
      localModels = localModelsCounts(() => core.listing());
    } catch { /* zero counts rather than no page */ }

    // The wall lines: what each connected add-on can reach, and the summary sentence
    // above the installed list. Both come from ONE snapshot of proxy.js's entries, so
    // the modal and the status block cannot describe the same add-on differently.
    let addonWall = {};
    let addonWallStatusHtml = "";
    try {
      const { CROW_HOME, APP_ROOT } = await import("../../bundles-config.js");
      const { addonWallEntriesNow, renderAddonWallStatus } = await import("../shared/addon-wall-status.js");
      const { addonWallDetails } = await import("../shared/addon-wall-details.js");
      const wallEntries = await addonWallEntriesNow();
      addonWall = addonWallDetails({ crowHome: CROW_HOME, appRoot: APP_ROOT, entries: wallEntries });
      addonWallStatusHtml = renderAddonWallStatus({ lang, entries: wallEntries });
    } catch { /* no line rather than no page */ }

    const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
      installed, available, collections, registrySource, communityStores, bundleStatus, needsConfig, needsRepin, legacyAccounts, dockerOk, keychainPending, vaultSecure, localModels, lang,
      firstAdminPending,
      apiKeyCards,
      satellites, satelliteEligibleIds, offsite,
      addonWall,
      addonWallStatusHtml,
      // A skill's "Go to <extension>" arrives as ?q=<id>: the search box starts filled in.
      searchQuery: typeof req.query?.q === "string" ? req.query.q.slice(0, 100) : "",
    });

    // ─── Modal + client-side JavaScript ───
    const interactiveScript = extensionsClientJS(lang);
    const serversScript = serversClientJS(lang);

    const content = `
      ${extensionStyles()}
      ${viewsHtml}
      ${addonRegistryScript}
      ${collectionsScript}
      ${serversScript}
      ${interactiveScript}
    `;

    return layout({ title: t("extensions.pageTitle", lang), content });
  },
};
