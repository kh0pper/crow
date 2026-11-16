/**
 * Crow Mail's reader markup (plan 2). One hidden panel at /dashboard/mail draws every view; the
 * view is chosen by the query string, and this module is the dispatcher the panel hands it to.
 *
 * The empty states come first because they win over every view: no accounts at all ("Connect your
 * mail"), addresses another live instance holds ("Mail is set up on <instance>", plus the way to a
 * different account), and the case where every local account is held elsewhere (the same sentence,
 * naming the holder).
 *
 * With usable accounts the inbox view (Task 4) is drawn here: account chips over one unified inbox,
 * a Folders drawer per account (minus the three virtual folders plan 1 never syncs), and one row per
 * message — unread dot, sender, subject, the first line and the time in the instance's zone. The
 * row's link names the account, the Message-ID and the row id (a hint the message view checks,
 * Decision 9). "Load more" follows plan 1's keyset cursor.
 *
 * Every value that came from outside — mail text from the wire above all — is escaped here and is
 * never used for markup, a URL or an attribute. No secret, host, port or username of an account
 * reaches this module: `accountsOverview` does not read them, and nothing here looks at the
 * connection settings.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { SKIP_SPECIAL_USE } from "../../../mail/sync/engine.js";

const e = escapeHtml;

/**
 * Plan 1's own fallback for a name the claim rows left blank (`claimedElsewhereSentence` uses the
 * same words), so an account whose claim has since cleared still says where its mail is.
 */
const UNNAMED_INSTANCE = "another Crow";

/** The reader's own page; every link in it is built from this. */
const MAIL_HREF = "/dashboard/mail";

/** The settings view is where an account is connected; the empty states link to it. */
const SETTINGS_HREF = `${MAIL_HREF}?view=settings`;

/** The unified inbox is `acct=all`; a chip or a folder narrows it to one account id. */
const ALL_ACCOUNTS = "all";

/** The three special-use folders plan 1 never syncs: listed empty forever, so never drawn. */
const SKIPPED_SPECIAL_USE = new Set(SKIP_SPECIAL_USE.map((flag) => flag.toLowerCase()));

const LOCALES = { en: "en-US", es: "es-ES" };

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
function pageShell(inner, lang) {
  return `<div class="ml" data-ml>
    <h1 class="ml-title">${e(t("mail.title", lang))}</h1>
    ${inner}
  </div>`;
}

/* ---------------------------------------------------------------- inbox view */

/** The account's label, escaped; the label is the owner's own text. */
function accountLabel(account) {
  const label = typeof account?.label === "string" ? account.label.trim() : "";
  return label || UNNAMED_INSTANCE;
}

/** A folder's name as the server reported it, or its path when it sent none. */
function folderLabel(folder) {
  const name = typeof folder?.name === "string" ? folder.name.trim() : "";
  if (name) return name;
  return typeof folder?.path === "string" ? folder.path : "";
}

/** True for a virtual folder plan 1 never syncs (`\All`, `\Flagged`, `\Important`). */
function isSkippedFolder(folder) {
  const special = typeof folder?.specialUse === "string" ? folder.specialUse : "";
  return special.split(/\s+/).some((token) => SKIPPED_SPECIAL_USE.has(token.trim().toLowerCase()));
}

/** A person's words for a sender: the name, else the address, else the placeholder. */
function senderOf(item, lang) {
  const name = typeof item?.fromName === "string" ? item.fromName.trim() : "";
  if (name) return name;
  const address = typeof item?.fromAddr === "string" ? item.fromAddr.trim() : "";
  return address || t("mail.unknownSender", lang);
}

/** The subject, or the placeholder a message without one gets. */
function subjectOf(item, lang) {
  const subject = typeof item?.subject === "string" ? item.subject.trim() : "";
  return subject || t("mail.noSubject", lang);
}

function localeOf(lang) {
  return LOCALES[lang] ?? LOCALES.en;
}

/** A formatter that falls back to the host's zone rather than throwing on an unknown time zone. */
function formatterOf(locale, options, tz) {
  try {
    return new Intl.DateTimeFormat(locale, tz ? { ...options, timeZone: tz } : options);
  } catch {
    try {
      return new Intl.DateTimeFormat(locale, options);
    } catch {
      return null;
    }
  }
}

/** The calendar day of one instant in the instance's zone, as `YYYY-MM-DD` plus the year. */
function dayOf(ms, locale, tz) {
  const formatter = formatterOf(locale, { year: "numeric", month: "2-digit", day: "2-digit" }, tz);
  if (!formatter) return { day: "", year: "" };
  const parts = formatter.formatToParts(new Date(ms));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  return { day: `${year}-${value("month")}-${value("day")}`, year };
}

/**
 * The list's time column: today `H:MM`, this year `Mon D`, else `Mon D, YYYY`, read in the instance's
 * zone (`instanceZone`) rather than the server's.
 */
function rowTime(date, { now, tz, lang }) {
  const ms = Number(date);
  if (!Number.isFinite(ms)) return "";
  const locale = localeOf(lang);
  try {
    const here = dayOf(now, locale, tz);
    const there = dayOf(ms, locale, tz);
    if (there.day && there.day === here.day) {
      const clock = formatterOf(locale, { hour: "numeric", minute: "2-digit", hourCycle: "h23" }, tz);
      return clock ? clock.format(new Date(ms)) : "";
    }
    const options = there.year && there.year === here.year
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
    const formatter = formatterOf(locale, options, tz);
    return formatter ? formatter.format(new Date(ms)) : "";
  } catch {
    return "";
  }
}

/** "All", then one chip per usable account; the active one carries aria-current. */
function chips({ accounts, acct, lang }) {
  const all = `<a class="ml-chip" href="${MAIL_HREF}"${acct === ALL_ACCOUNTS ? ' aria-current="page"' : ""}>${e(t("mail.chipAll", lang))}</a>`;
  const perAccount = accounts.map((account) => {
    const href = `${MAIL_HREF}?acct=${encodeURIComponent(account.id)}`;
    const current = acct === account.id ? ' aria-current="page"' : "";
    return `<a class="ml-chip" href="${e(href)}"${current}>${e(accountLabel(account))}</a>`;
  });
  return `<div class="ml-chips">${all}${perAccount.join("")}</div>`;
}

/**
 * One `<details>` drawer, each account's folders with their unread counts. The three virtual folders
 * plan 1 never syncs are left out (they would always read empty). It opens on its own when a folder
 * is being looked at, so the reader can see which one.
 */
function folderDrawer({ accounts, folders, folderId, lang }) {
  const groups = accounts.map((account) => {
    const list = folders.filter((folder) => folder.accountId === account.id && !isSkippedFolder(folder));
    if (!list.length) return "";
    const items = list.map((folder) => {
      const href = `${MAIL_HREF}?acct=${encodeURIComponent(account.id)}&folder=${Number(folder.id)}`;
      const current = Number(folder.id) === folderId ? ' aria-current="page"' : "";
      const count = Number(folder.unreadCount ?? 0);
      const unread = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
      return `<li class="ml-folder-item"><a class="ml-folder" href="${e(href)}"${current}>${e(folderLabel(folder))}<span class="ml-count">${unread}</span></a></li>`;
    }).join("");
    return `<p class="ml-drawer-account">${e(accountLabel(account))}</p><ul class="ml-folders">${items}</ul>`;
  }).filter(Boolean).join("");
  if (!groups) return "";
  const open = folderId === null ? "" : " open";
  return `<details class="ml-drawer"${open}><summary class="ml-drawer-summary">${e(t("mail.folders", lang))}</summary>`
    + `<div class="ml-drawer-body">${groups}</div></details>`;
}

/**
 * One message row. The link names the account and the Message-ID, plus the row id as a hint that the
 * message view checks against the Message-ID (Decision 9); a message with no Message-ID is linked by
 * its row alone.
 */
function row(item, { now, tz, lang }) {
  const mid = typeof item.messageId === "string" && item.messageId !== "" ? item.messageId : null;
  const params = ["view=message", `a=${encodeURIComponent(item.accountId)}`];
  if (mid !== null) params.push(`mid=${encodeURIComponent(mid)}`);
  params.push(`row=${Number(item.id)}`);
  const href = `${MAIL_HREF}?${params.join("&")}`;
  const dot = item.isRead ? "" : '<span class="ml-dot" aria-hidden="true"></span>';
  const snippet = typeof item.snippet === "string" ? item.snippet : "";
  return `<a class="ml-row" href="${e(href)}">${dot}<span class="ml-sender">${e(senderOf(item, lang))}</span>`
    + `<span class="ml-subject">${e(subjectOf(item, lang))}</span>`
    + `<span class="ml-snippet">${e(snippet)}</span>`
    + `<span class="ml-time">${e(rowTime(item.date, { now, tz, lang }))}</span></a>`;
}

/** The keyset cursor's own link, keeping whichever view the reader is on. */
function loadMoreHref(acct, folderId, cursor) {
  const params = [];
  if (folderId === null) params.push(`acct=${encodeURIComponent(acct)}`);
  else params.push(`acct=${encodeURIComponent(acct)}`, `folder=${Number(folderId)}`);
  params.push(`cursor=${encodeURIComponent(cursor)}`);
  return `${MAIL_HREF}?${params.join("&")}`;
}

/**
 * The inbox view: chips, the folder drawer, the digest slot (All view only, filled by a later plan),
 * then the rows and "Load more".
 *
 * `page` is plan 1's `listMessages` answer — `{items, nextCursor}` — or `{missing: true}` for a
 * folder id that no longer exists (deleted on the server, so a resync removed it).
 *
 * @param {{
 *   accounts?: object[], folders?: object[], page?: object|null, acct?: string,
 *   folderId?: number|null, now?: number, lang?: string, tz?: string
 * }} options
 * @returns {string}
 */
export function inboxViewHtml({
  accounts = [],
  folders = [],
  page = null,
  acct = ALL_ACCOUNTS,
  folderId = null,
  now = Date.now(),
  lang = "en",
  tz = undefined,
} = {}) {
  const head = chips({ accounts, acct, lang }) + folderDrawer({ accounts, folders, folderId, lang });

  if (page && page.missing) {
    // The sentence is the way back: one line of copy, and it is the link to the inbox.
    return `${head}<section class="ml-empty" data-ml-empty="folder-gone">
      <a class="ml-note" href="${MAIL_HREF}">${e(t("mail.folderGone", lang))}</a>
    </section>`;
  }

  const items = Array.isArray(page?.items) ? page.items : [];
  const cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  const digest = acct === ALL_ACCOUNTS && folderId === null ? '<div data-mail-digest-slot></div>' : "";
  const rows = items.map((item) => row(item, { now, tz, lang })).join("");
  const more = cursor === null
    ? ""
    : `<a class="ml-more" href="${e(loadMoreHref(acct, folderId, cursor))}">${e(t("mail.loadMore", lang))}</a>`;
  return `${head}${digest}<div class="ml-list">${rows}</div>${more}`;
}

/**
 * The view dispatcher. `accounts` and `elsewhere` are what `accountsOverview` returns: usable
 * accounts (any status but `claimed_elsewhere`), the held ones with their `heldBy`, and the
 * addresses other live instances hold. The empty states win over the view: a reader with no mail
 * to read gets the same page whichever view it asked for.
 *
 * @param {{
 *   view?: string, accounts?: object[], elsewhere?: object[], lang?: string, folders?: object[],
 *   page?: object|null, acct?: string, folderId?: number|null, now?: number, tz?: string
 * }} options
 * @returns {string}
 */
export function renderMailPage({
  view = "inbox",
  accounts = [],
  elsewhere = [],
  lang = "en",
  folders = [],
  page = null,
  acct = ALL_ACCOUNTS,
  folderId = null,
  now = Date.now(),
  tz = undefined,
} = {}) {
  const usable = accounts.filter((a) => a.status !== "claimed_elsewhere");

  if (!accounts.length) {
    if (!elsewhere.length) return pageShell(connectCard(lang), lang);
    return pageShell(elsewhereCard(elsewhere.map((x) => x.instanceName), lang), lang);
  }
  if (!usable.length) return pageShell(elsewhereCard(accounts.map((a) => a.heldBy), lang), lang);

  // `view` picks the view inside the page; message, search and settings are built in later tasks,
  // and until then only the inbox has anything to draw.
  if (view === "inbox" && page) {
    return pageShell(inboxViewHtml({ accounts: usable, folders, page, acct, folderId, now, lang, tz }), lang);
  }
  return pageShell("", lang);
}

export default renderMailPage;