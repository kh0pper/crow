/**
 * `firstAdmin` — how a bundle's OWN first admin account comes to exist
 * (security audit N3-4), as a PURE module: manifest in, strings and plain data
 * out. No fs, no db, no express — the Extensions renderer (html.js) imports this
 * and stays unit-testable without the operator's ~/.crow.
 *
 * The finding: a freshly installed app's own first-run admin page is reachable
 * over loopback by anyone or anything else on the machine, and an audit VM run
 * showed another account claiming uptime-kuma's setup page before the owner did.
 * Every web app bundle therefore declares one of:
 *
 *   crow           Crow creates the admin at install — a generated password in
 *                  the keychain, or a postInstall hook. Nothing to claim, and
 *                  nothing to show the operator.
 *   finish-setup   the app has its own first-run admin page. The operator is
 *                  told, plainly, to finish it NOW, with a direct link.
 *   default-login  the app ships a documented default login (user + password):
 *                  the same notice, with a different first sentence.
 *   external       it connects to an app you already run, whose login is that
 *                  app's (Immich, Kodi): nothing of ours to claim. No notice.
 *   none           no login of its own. No notice.
 *
 * FAIL-SAFE default: a web UI bundle with NO usable declaration (a third-party
 * or community-store manifest written before this field existed, or a typo'd
 * mode) is treated as `finish-setup`, so the operator still gets the card and
 * the bell. Silence is only ever an explicit `crow`/`external`/`none`.
 *
 * The bell and the "Done" marker (db-backed, per install) live in
 * servers/gateway/bundle-first-admin.js, which re-exports everything here.
 */
import { t, fill } from "./i18n.js";
import { appTileLink } from "./app-link.js";

/** The modes a manifest may declare (same list as the contract). */
export const FIRST_ADMIN_MODES = Object.freeze(["crow", "finish-setup", "default-login", "external", "none"]);

/** The two modes that put a card in front of the operator and ring the bell. */
export const OPERATOR_FIRST_ADMIN_MODES = Object.freeze(["finish-setup", "default-login"]);

export const FIRST_ADMIN_TITLE_KEY = "bundles.firstAdmin.title";
export const FIRST_ADMIN_FINISH_BODY_KEY = "bundles.firstAdmin.finishSetupBody";
export const FIRST_ADMIN_DEFAULT_LOGIN_BODY_KEY = "bundles.firstAdmin.defaultLoginBody";

/**
 * The manifest's firstAdmin block, normalized. A web UI with no usable
 * declaration (missing, or a mode the schema does not know) is `finish-setup`:
 * a third-party manifest cannot silence the warning by saying nothing. A
 * manifest with no web UI declares nothing at all → null.
 *
 * @param {object|null} manifest
 * @returns {{mode: string, path: string|null, user: string|null, note: string|null}|null}
 */
export function firstAdminOf(manifest) {
  const m = manifest && typeof manifest === "object" ? manifest : null;
  if (!m) return null;
  const hasWebUI = !!(m.webUI && typeof m.webUI === "object");
  const fa = m.firstAdmin && typeof m.firstAdmin === "object" ? m.firstAdmin : null;
  const declared = fa && FIRST_ADMIN_MODES.includes(fa.mode) ? fa : null;
  if (!declared) {
    return hasWebUI ? { mode: "finish-setup", path: null, user: null, note: null } : null;
  }
  return {
    mode: declared.mode,
    path: typeof declared.path === "string" && declared.path.startsWith("/") ? declared.path : null,
    user: typeof declared.user === "string" && declared.user.trim() !== "" ? declared.user.trim() : null,
    note: typeof declared.note === "string" && declared.note.trim() !== "" ? declared.note.trim() : null,
  };
}

/** Does this bundle's install leave an admin account someone else could claim? */
export function firstAdminNeedsOperator(manifest) {
  const fa = firstAdminOf(manifest);
  return !!fa && OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode);
}

/**
 * Where the app's setup page lives, by the SAME rule the Nest tile uses
 * (shared/app-link.js). `firstAdmin.path` wins over `webUI.path` when the
 * manifest names a more specific page (a login or setup screen).
 */
export function firstAdminLink(bundleId, manifest) {
  const webUI = manifest && typeof manifest === "object" && manifest.webUI && typeof manifest.webUI === "object"
    ? manifest.webUI
    : {};
  const fa = firstAdminOf(manifest);
  return appTileLink(bundleId, fa && fa.path ? { ...webUI, path: fa.path } : webUI);
}

/** The card's title — the same words the bell uses. */
export function firstAdminTitle(name, lang = "en") {
  return fill(t(FIRST_ADMIN_TITLE_KEY, lang), { name });
}

/**
 * The card's (and the bell's) sentence for a normalized firstAdmin record, in
 * `lang` — the app's note appended when it has one. Null when it needs no
 * notice. Pure; the renderer escapes it.
 *
 * @param {{mode: string, user: string|null, note: string|null}|null} fa firstAdminOf() output
 * @param {string} name the app's display name
 */
export function firstAdminBody(fa, name, lang = "en") {
  if (!fa || !OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode)) return null;
  const body = fa.mode === "default-login"
    ? fill(t(FIRST_ADMIN_DEFAULT_LOGIN_BODY_KEY, lang), { name, user: fa.user || "" })
    : fill(t(FIRST_ADMIN_FINISH_BODY_KEY, lang), { name });
  return fa.note ? `${body} ${fa.note}` : body;
}

/**
 * The cards the Extensions page shows, in `Object.keys(installed)` order.
 * PURE: no fs, no db — `manifests` and `done` are handed in (panels/extensions.js
 * reads them), which keeps html.js's purity rule.
 *
 * @param {object} o
 * @param {Record<string, {installedAt?: string, installed_at?: string, mode?: string}>} o.installed
 * @param {Record<string, object|null>} o.manifests     id → installed manifest
 * @param {Record<string, string>} [o.done]             id → the install a Done press covered
 * @param {Set<string>|string[]} [o.liveProxyIds]       ids with a live /proxy route THIS process
 * @param {boolean} [o.proxyMountFailed]                the proxy router failed to mount at boot
 * @returns {Array<{id:string,name:string,mode:string,user:string|null,note:string|null,link:object,installId:string|null,restartPending:boolean,linkUnavailable:boolean}>}
 */
export function pendingFirstAdminNotices({ installed = {}, manifests = {}, done = {}, liveProxyIds = [], proxyMountFailed = false } = {}) {
  const live = liveProxyIds instanceof Set ? liveProxyIds : new Set(liveProxyIds || []);
  const out = [];
  for (const id of Object.keys(installed || {})) {
    const entry = installed[id] || {};
    if (entry.mode === "satellite") continue; // hosted elsewhere: its own box's setup, not this one's
    const manifest = manifests ? manifests[id] : null;
    const fa = firstAdminOf(manifest);
    if (!fa || !OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode)) continue;
    const installId = typeof entry.installedAt === "string" ? entry.installedAt
      : typeof entry.installed_at === "string" ? entry.installed_at : null;
    // Done is per install: a reinstall (a new installedAt) asks again, because
    // its own first-run page is back to being claimable.
    if (installId && done && done[id] === installId) continue;
    if (!installId && done && done[id]) continue;
    const link = firstAdminLink(id, manifest);
    const subpath = link.proxyMode === "subpath";
    out.push({
      id,
      name: (manifest && typeof manifest.name === "string" && manifest.name) || id,
      mode: fa.mode,
      user: fa.user,
      note: fa.note,
      link,
      installId,
      // The proxy route table is built once at boot: a subpath bundle installed
      // into a running gateway has no /proxy/<id> until the process comes back.
      // A direct-mode app is its own origin, so it needs no route. If the router
      // failed to mount at all, no restart will produce the route: the card says
      // the link is unavailable instead of promising a restart that cannot help.
      restartPending: subpath && !proxyMountFailed && !live.has(id),
      linkUnavailable: subpath && !!proxyMountFailed,
    });
  }
  return out;
}
