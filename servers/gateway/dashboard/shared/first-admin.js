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
 *                  the keychain, a postInstall hook, or (via "setup") a script
 *                  the installer runs with the password on stdin. Nothing to
 *                  claim, and nothing to show the operator.
 *   finish-setup   the app has its own first-run admin page. The operator is
 *                  told, plainly, to finish it NOW, with a direct link.
 *   default-login  the app ships a documented default login (user + password):
 *                  the same notice, with a different first sentence.
 *   external       it connects to an app you already run, whose login is that
 *                  app's (Immich, Kodi): nothing of ours to claim. No notice.
 *   none           no login of its own. No notice.
 *
 * One extra field rides on `finish-setup` (security audit N3-4 phase 2e):
 *
 *   invite         the app CAN be made invite-only by Crow, through its own admin
 *                  API — `{ "mode": "finish-setup", "invite": "vaultwarden" }`. The
 *                  name selects a CODE-HELD handler (first-admin/registry.js); the
 *                  card then asks for the owner's email, invites it, closes
 *                  sign-ups, and goes away once a registered account exists.
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
import { isAdminPanelTokenEnvKey, isInviteHandlerName, inviteHandlerBundleId } from "../../first-admin/registry.js";

/** The modes a manifest may declare (same list as the contract). */
export const FIRST_ADMIN_MODES = Object.freeze(["crow", "finish-setup", "default-login", "external", "none"]);

/** The two modes that put a card in front of the operator and ring the bell. */
export const OPERATOR_FIRST_ADMIN_MODES = Object.freeze(["finish-setup", "default-login"]);

export const FIRST_ADMIN_TITLE_KEY = "bundles.firstAdmin.title";
export const FIRST_ADMIN_FINISH_BODY_KEY = "bundles.firstAdmin.finishSetupBody";
export const FIRST_ADMIN_DEFAULT_LOGIN_BODY_KEY = "bundles.firstAdmin.defaultLoginBody";
export const FIRST_ADMIN_SETUP_BODY_KEY = "bundles.firstAdmin.setupBody";
export const FIRST_ADMIN_KEPT_BODY_KEY = "bundles.firstAdmin.keptBody";

/** The card's sentences for an invite-only app (N3-4 phase 2e). */
export const FIRST_ADMIN_INVITE_CLOSE_BODY_KEY = "bundles.firstAdmin.invite.closeBody";
export const FIRST_ADMIN_INVITE_CREATE_BODY_KEY = "bundles.firstAdmin.invite.createBody";
export const FIRST_ADMIN_INVITE_CREATE_OPEN_BODY_KEY = "bundles.firstAdmin.invite.createOpenBody";
export const FIRST_ADMIN_INVITE_BODY_KEY = "bundles.firstAdmin.invite.inviteBody";
export const FIRST_ADMIN_INVITE_SIGNUPS_OPEN_KEY = "bundles.firstAdmin.invite.signupsOpen";
export const FIRST_ADMIN_INVITE_OTHERS_KEY = "bundles.firstAdmin.invite.others";

/**
 * The keychain entry name a bundle's admin login is saved under when its
 * manifest does not declare `firstAdmin.secretEnv` (the Extensions card's own
 * "save the login I made" form uses the same key, so the card can find it).
 */
export const FIRST_ADMIN_SAVED_KEY = "APP_ADMIN_PASSWORD";

/**
 * The manifest's firstAdmin block, normalized. A web UI with no usable
 * declaration (missing, or a mode the schema does not know) is `finish-setup`:
 * a third-party manifest cannot silence the warning by saying nothing. A
 * manifest with no web UI declares nothing at all → null.
 *
 * `invite` is kept only when the mode is `finish-setup` AND the name is one of
 * Crow's code-held handlers: anything else is as good as absent (the contract
 * refuses it at build time; runtime stays fail-safe). The handler is also bound to
 * the ONE bundle it belongs to, which needs the bundle id: pendingFirstAdminNotices
 * drops the invite card for any other bundle (inviteHandlerBundleId), and the
 * gateway resolves a handler with inviteHandlerFor(manifest, bundleId).
 *
 * @param {object|null} manifest
 * @returns {{mode: string, path: string|null, user: string|null, note: string|null, invite: string|null}|null}
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
    // Kept only when it really names a handler (N3-4 phase 2e); absent otherwise, so
    // the normalized shape of every other bundle is unchanged.
    ...(declared.mode === "finish-setup" && isInviteHandlerName(declared.invite) ? { invite: declared.invite } : {}),
  };
}

/**
 * The mechanism a `crow` manifest names — "env", "postInstall" or "setup" — or
 * null. Anything else (another mode, a typo) is not a mechanism.
 */
export function firstAdminVia(manifest) {
  const fa = manifest && typeof manifest === "object" ? manifest.firstAdmin : null;
  if (!fa || typeof fa !== "object" || fa.mode !== "crow") return null;
  return fa.via === "env" || fa.via === "postInstall" || fa.via === "setup" ? fa.via : null;
}

/**
 * The keychain entry name holding this bundle's admin login: the manifest's
 * `firstAdmin.secretEnv` when it declares one, else FIRST_ADMIN_SAVED_KEY. For a
 * `crow`/`via: "setup"` bundle it is the entry Crow itself writes.
 *
 * An admin-PANEL token is not a login: a Vaultwarden-shaped
 * `VAULTWARDEN_ADMIN_TOKEN` names the keychain entry for the /admin token, and
 * `null` is returned for it so that entry can never hide the "create your own
 * account" card.
 *
 * @returns {string|null}
 */
export function firstAdminSavedKey(manifest) {
  const fa = manifest && typeof manifest === "object" ? manifest.firstAdmin : null;
  const declared = fa && typeof fa.secretEnv === "string" ? fa.secretEnv.trim() : "";
  const key = declared || FIRST_ADMIN_SAVED_KEY;
  return isAdminPanelTokenEnvKey(key) ? null : key;
}

/** Does this bundle's install leave an admin account someone else could claim? */
export function firstAdminNeedsOperator(manifest) {
  const fa = firstAdminOf(manifest);
  return !!fa && OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode);
}

/**
 * Does this manifest owe the operator a notice (a card, a bell)?
 *
 * `crow`/`via: "setup"` is owed one UNLESS Crow's own setup run for this install
 * returned "ok" AND its follow-up step did not fail — a script that failed, found
 * the app not answering, or left an admin the app already had must not disappear
 * silently, and neither must an installed app whose registration Crow could not
 * close afterwards (afterResult).
 *
 * An invite-only app (`firstAdmin.invite`) is owed one UNLESS Crow's invite step
 * for this install invited the owner's email AND confirmed sign-ups off: after
 * that there is no account anyone else could claim.
 *
 * @param {object|null} manifest
 * @param {{autoResult?: string|null, inviteResult?: {result?: string, signups?: string|null}|null, afterResult?: {ok?: boolean}|null}} [o]
 *        the setup run's / invite step's / after-step's result for this install
 */
export function firstAdminNeedsNotice(manifest, { autoResult = null, inviteResult = null, afterResult = null } = {}) {
  const fa = firstAdminOf(manifest);
  if (!fa) return false;
  if (fa.invite) {
    const r = inviteResult && typeof inviteResult === "object" ? inviteResult : null;
    const invited = !!r && (r.result === "invited" || r.result === "already");
    return !(invited && r.signups === "off");
  }
  if (firstAdminVia(manifest) === "setup") return autoResult !== "ok" || firstAdminAfterFailed(afterResult);
  return OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode);
}

/**
 * Did the install's follow-up step (`firstAdmin.setup.after`) report a failure?
 * The install path hands over `applyFirstAdminAfter`'s own `{ ok, outcome }`; anything
 * absent or ok is "nothing went wrong".
 *
 * @param {{ok?: boolean}|null} afterResult
 */
export function firstAdminAfterFailed(afterResult) {
  return !!afterResult && typeof afterResult === "object" && afterResult.ok === false;
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
  if (!fa) return null;
  if (fa.mode === "crow" && fa.via === "setup") {
    // `kept`: the setup script found an admin the app already had, so there is no
    // new login for Crow to keep — but the one the operator uses is still worth saving.
    const body = fill(t(fa.kept ? FIRST_ADMIN_KEPT_BODY_KEY : FIRST_ADMIN_SETUP_BODY_KEY, lang), { name });
    return fa.note ? `${body} ${fa.note}` : body;
  }
  if (!OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode)) return null;
  const body = fa.mode === "default-login"
    ? fill(t(FIRST_ADMIN_DEFAULT_LOGIN_BODY_KEY, lang), { name, user: fa.user || "" })
    : fill(t(FIRST_ADMIN_FINISH_BODY_KEY, lang), { name });
  return fa.note ? `${body} ${fa.note}` : body;
}

/**
 * The card's sentence for an invite-only app, by the state its admin API reported.
 * `invite.kind`:
 *   close    someone already registered, yet sign-ups are still open
 *   create   the owner's address is invited but no account exists yet
 *   invite   nobody at all: ask for the email to invite
 * ("done" never reaches a card, and "blocked" keeps the normal finish-setup body.)
 *
 * @param {{kind: string, email: string|null, signups: string, others?: string[]}|null} invite
 *   `others` are registered addresses that are not the owner's: named in one extra
 *   sentence, so an account nobody expected cannot hide behind the card.
 * @param {string} name the app's display name
 */
export function firstAdminInviteBody(invite, name, lang = "en") {
  if (!invite) return null;
  if (invite.kind === "close") return withOthers(fill(t(FIRST_ADMIN_INVITE_CLOSE_BODY_KEY, lang), { name }), invite, lang);
  if (invite.kind === "create") {
    // Never claim sign-ups are closed when the app said they are not.
    const key = invite.signups === "on" ? FIRST_ADMIN_INVITE_CREATE_OPEN_BODY_KEY : FIRST_ADMIN_INVITE_CREATE_BODY_KEY;
    return withOthers(fill(t(key, lang), { name, email: invite.email || "" }), invite, lang);
  }
  if (invite.kind === "invite") {
    const body = fill(t(FIRST_ADMIN_INVITE_BODY_KEY, lang), { name });
    const open = invite.signups === "on" ? `${body} ${t(FIRST_ADMIN_INVITE_SIGNUPS_OPEN_KEY, lang)}` : body;
    return withOthers(open, invite, lang);
  }
  return null;
}

/** `body` plus the "also registered" sentence when there is one. */
function withOthers(body, invite, lang) {
  const others = firstAdminInviteOthers(invite, lang);
  return others ? `${body} ${others}`.trim() : body;
}

/**
 * Why the invite card could not read the app's accounts/sign-ups — one plain
 * sentence, appended to the normal finish-setup card (kind "blocked").
 */
export function firstAdminInviteReason(reason, name, lang = "en") {
  const key = reason === "not-local" ? "notLocal"
    : reason === "no-token" ? "noToken"
      : reason === "unreachable" ? "unreachable"
        : reason === "rate-limited" ? "rateLimited"
          : "unknown";
  return fill(t(`bundles.firstAdmin.invite.reason.${key}`, lang), { name });
}

/**
 * The "these are not accounts you made" sentence for an invite card whose app has
 * registered accounts other than the one Crow invited, or null. `others` comes from
 * the handler (it reads the recorded invite, never the editable `.env`); the
 * renderer escapes the result.
 *
 * @param {{others?: string[]}|null} invite
 * @param {string} lang
 */
export function firstAdminInviteOthers(invite, lang = "en") {
  const others = invite && Array.isArray(invite.others) ? invite.others.filter((e) => typeof e === "string" && e !== "") : [];
  if (others.length === 0) return null;
  return fill(t(FIRST_ADMIN_INVITE_OTHERS_KEY, lang), { emails: others.slice(0, 5).join(", ") });
}

/**
 * PURE: no fs, no db — `manifests`, `done`, `adminSaved` and `autoResults` are
 * handed in (panels/extensions.js reads them), which keeps html.js's purity rule.
 *
 * @param {object} o
 * @param {Record<string, {installedAt?: string, installed_at?: string, mode?: string}>} o.installed
 * @param {Record<string, object|null>} o.manifests     id → installed manifest
 * @param {Record<string, string>} [o.done]             id → the install a Done press covered
 * @param {Set<string>|string[]} [o.liveProxyIds]       ids with a live /proxy route THIS process
 * @param {boolean} [o.proxyMountFailed]                the proxy router failed to mount at boot
 * @param {Set<string>|string[]} [o.adminSaved]         ids whose keychain holds that bundle's admin login
 * @param {Record<string, {install?: string|null, result?: string}>} [o.autoResults]
 *        id → the `first_admin_auto:<id>` marker (what Crow's own setup run did)
 * @param {Record<string, object>} [o.inviteStates]
 *        id → what the app's own admin API reported (`firstAdmin.invite`), or
 *        absent when it could not be read
 * @returns {Array<{id:string,name:string,mode:string,via:string|null,user:string|null,note:string|null,link:object,installId:string|null,restartPending:boolean,linkUnavailable:boolean,kept:boolean,canAuto:boolean,canSave:boolean,canDone:boolean,invite:object|null}>}
 */
export function pendingFirstAdminNotices({
  installed = {},
  manifests = {},
  done = {},
  liveProxyIds = [],
  proxyMountFailed = false,
  adminSaved = [],
  autoResults = {},
  inviteStates = {},
} = {}) {
  const live = liveProxyIds instanceof Set ? liveProxyIds : new Set(liveProxyIds || []);
  const saved = adminSaved instanceof Set ? adminSaved : new Set(adminSaved || []);
  const auto = autoResults && typeof autoResults === "object" ? autoResults : {};
  const invites = inviteStates && typeof inviteStates === "object" ? inviteStates : {};
  const out = [];
  for (const id of Object.keys(installed || {})) {
    const entry = installed[id] || {};
    if (entry.mode === "satellite") continue; // hosted elsewhere: its own box's setup, not this one's
    const manifest = manifests ? manifests[id] : null;
    const fa = firstAdminOf(manifest);
    if (!fa) continue;
    const installId = typeof entry.installedAt === "string" ? entry.installedAt
      : typeof entry.installed_at === "string" ? entry.installed_at : null;
    // An invite-only app's card is decided by its OWN admin API, not by a keychain
    // entry: its saved admin token is the /admin panel token, never the operator's
    // login (firstAdminSavedKey returns null for those). And a handler only ever
    // applies to the bundle it is written for: a manifest that merely NAMES one
    // (`invite: "vaultwarden"` on another bundle) gets no invite card at all.
    const invite = fa.invite && inviteHandlerBundleId(fa.invite) === id ? inviteNotice(fa.invite, invites[id]) : null;
    // A registered account with sign-ups closed: nothing left to ask.
    if (invite && invite.kind === "done") continue;
    // The keychain holds this app's admin login: there is nothing left to ask the
    // operator for, whatever the mode (Crow's own generated login, or one they saved).
    // An invite-only app is the exception: its state comes from the app's own admin
    // API, and a saved /admin token is not the operator's account, so a keychain
    // entry must never hide "create your account" or "anyone can still sign up".
    if (!invite) {
      const savedKey = firstAdminSavedKey(manifest);
      if (savedKey && saved.has(id)) continue;
    }
    const setup = firstAdminVia(manifest) === "setup";
    let kept = false;
    let canAuto = false;
    if (setup) {
      const record = auto[id];
      const thisInstall = record && typeof record === "object" && installId && record.install === installId ? record : null;
      // Crow already created this install's admin and saved it: silence.
      if (thisInstall && thisInstall.result === "ok") continue;
      // "kept": the app has its own admin, so there is nothing to create. The card
      // only asks the operator to save the login they use.
      kept = !!(thisInstall && thisInstall.result === "kept");
      canAuto = !kept;
    } else if (!OPERATOR_FIRST_ADMIN_MODES.includes(fa.mode)) {
      continue; // crow via env/postInstall, external, none: nothing to claim
    }
    // Done is per install: a reinstall (a new installedAt) asks again, because
    // its own first-run page is back to being claimable. On an invite-only app the
    // marker only ever hides the "Crow could not read the app" card: a "close" /
    // "create" / "invite" state is a live warning and always shows.
    const inviteHides = !invite || invite.kind === "blocked";
    // A `crow`/via setup bundle never takes the Done marker. Reaching this point means the
    // keychain holds no login for it, and the card's whole purpose is to create or save one;
    // a marker pressed under an OLD `finish-setup` declaration carries the same install stamp
    // (a version refresh does not reinstall), so it would hide exactly that card — how an
    // upgraded install ended up requiring a login nobody had (review round 2, finding 2).
    const doneApplies = !setup;
    if (doneApplies && inviteHides && installId && done && done[id] === installId) continue;
    if (doneApplies && inviteHides && !installId && done && done[id]) continue;
    const link = firstAdminLink(id, manifest);
    const subpath = link.proxyMode === "subpath";
    // An invite card asks the operator to invite or to close sign-ups — not to save
    // a login (its own admin API is the signal, a saved login must not hide it) and,
    // except on the "cannot read the app" card, not to press Done.
    const inviteAction = !!invite && invite.kind !== "blocked";
    out.push({
      id,
      name: (manifest && typeof manifest.name === "string" && manifest.name) || id,
      mode: fa.mode,
      via: setup ? "setup" : null,
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
      kept,
      canAuto,
      canSave: !invite,
      // No Done on a setup card either: it could not hide the card (above), so a button
      // that does nothing would only look broken.
      canDone: !inviteAction && !setup,
      invite,
    });
  }
  return out;
}

/**
 * The card shape for an invite-only app, from the state its admin API reported.
 * PURE. `state` absent (the read failed) is the same as an unreadable one.
 *
 *   done     a registered account exists AND sign-ups are off → no card at all
 *   close    a registered account exists, sign-ups on/unknown → Close sign-ups
 *   create   no registered account yet, an INVITED address exists → create it
 *   invite   nobody at all → ask for the email to invite
 *   blocked  nothing could be read → the normal finish-setup card + why
 *
 * Only `_status === 1` is "invited": a disabled account (`_status === 2`) is present
 * but neither registered nor invited, so it never turns the card into "create"
 * (and never into "done" either).
 *
 * @param {string} handler the manifest's `firstAdmin.invite` name
 * @param {object|null|undefined} state vaultwardenState() output
 * @returns {{handler: string, kind: string, email: string|null, signups: string, reason: string|null, others: string[]}}
 */
export function inviteNotice(handler, state) {
  const s = state && typeof state === "object" ? state : null;
  if (!s) return { handler, kind: "blocked", email: null, signups: "unknown", reason: "unknown", others: [] };
  const signups = s.signups === "on" || s.signups === "off" ? s.signups : "unknown";
  const others = Array.isArray(s.others) ? s.others.filter((e) => typeof e === "string" && e !== "").slice(0, 5) : [];
  if (s.reason) {
    return { handler, kind: "blocked", email: null, signups, reason: typeof s.reason === "string" ? s.reason : "unknown", others };
  }
  const users = Array.isArray(s.users) ? s.users : [];
  const registered = users.find((u) => u && u.registered === true) || null;
  const invited = users.find((u) => u && u.invited === true && typeof u.email === "string" && u.email !== "") || null;
  if (registered) {
    const email = typeof registered.email === "string" && registered.email ? registered.email : null;
    if (signups === "off") return { handler, kind: "done", email, signups, reason: null, others };
    return { handler, kind: "close", email, signups, reason: null, others };
  }
  if (invited) return { handler, kind: "create", email: invited.email, signups, reason: null, others };
  return { handler, kind: "invite", email: null, signups, reason: null, others };
}
