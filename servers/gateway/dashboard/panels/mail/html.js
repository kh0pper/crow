/**
 * Crow Mail's reader markup (plan 2). One hidden panel at /dashboard/mail draws every view; the
 * view is chosen by the query string, and this module is the dispatcher the panel hands it to.
 *
 * This first slice draws the empty states only: no accounts at all ("Connect your mail"), addresses
 * another live instance holds ("Mail is set up on <instance>", plus the way to a different account),
 * and the case where every local account is held elsewhere (the same sentence, naming the holder).
 * When there ARE usable local accounts the page is the empty `<div class="ml" data-ml>` shell and
 * its title; the inbox that fills it arrives next, so nothing here reads a folder or a message.
 *
 * Every value that came from outside — an instance name above all — is escaped here. No secret,
 * host, port or username of an account ever reaches this module: `accountsOverview` does not read
 * them, and nothing in this file looks at the connection settings.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";

const e = escapeHtml;

/**
 * Plan 1's own fallback for a name the claim rows left blank (`claimedElsewhereSentence` uses the
 * same words), so an account whose claim has since cleared still says where its mail is.
 */
const UNNAMED_INSTANCE = "another Crow";

/** The settings view is where an account is connected; the empty states link to it. */
const SETTINGS_HREF = "/dashboard/mail?view=settings";

/** One name per instance, in the order given, with the blank case filled in. */
function instanceNames(names) {
  const out = [];
  for (const name of names) {
    const clean = typeof name === "string" ? name.trim() : "";
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.length ? out : [UNNAMED_INSTANCE];
}

/** "Connect your mail": one link to the settings view, which is where an account is added. */
function connectCard(lang) {
  return `<section class="ml-empty" data-ml-empty="connect">
      <a class="ml-btn ml-btn--primary" href="${SETTINGS_HREF}">${e(t("mail.emptyConnect", lang))}</a>
    </section>`;
}

/** "Mail is set up on <instance>", one line per holder, then the way to a different account. */
function elsewhereCard(names, lang) {
  const lines = instanceNames(names)
    .map((name) => `<p class="ml-note">${e(fill(t("mail.elsewhereOn", lang), { instance: name }))}</p>`)
    .join("");
  return `<section class="ml-empty" data-ml-empty="elsewhere">
      ${lines}
      <a class="ml-btn" href="${SETTINGS_HREF}">${e(t("mail.elsewhereConnect", lang))}</a>
    </section>`;
}

/** The page root: the title, then whichever view was asked for. */
function page(inner, lang) {
  return `<div class="ml" data-ml>
    <h1 class="ml-title">${e(t("mail.title", lang))}</h1>
    ${inner}
  </div>`;
}

/**
 * The view dispatcher. `accounts` and `elsewhere` are what `accountsOverview` returns: usable
 * accounts (any status but `claimed_elsewhere`), the held ones with their `heldBy`, and the
 * addresses other live instances hold. The empty states win over the view: a reader with no mail
 * to read gets the same page whichever view it asked for.
 *
 * @param {{view?: string, accounts?: object[], elsewhere?: object[], lang?: string}} options
 * @returns {string}
 */
export function renderMailPage({ view = "inbox", accounts = [], elsewhere = [], lang = "en" } = {}) {
  const usable = accounts.filter((a) => a.status !== "claimed_elsewhere");
  // `view` picks the view inside the page; inbox, message, search and settings are built next.
  void view;

  if (!accounts.length) {
    if (!elsewhere.length) return page(connectCard(lang), lang);
    return page(elsewhereCard(elsewhere.map((x) => x.instanceName), lang), lang);
  }
  if (!usable.length) return page(elsewhereCard(accounts.map((a) => a.heldBy), lang), lang);
  return page("", lang);
}

export default renderMailPage;