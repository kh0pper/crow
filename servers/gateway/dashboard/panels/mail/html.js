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
 *
 * The message view (Task 5) draws one opened message's header, then its whole conversation oldest
 * first: one `<details>` per message, each carrying the frame slot the client fills with an
 * opaque-origin iframe (the body itself is served by the frame route and never written into this
 * page), its attachments, and — after the conversation — the reply slot a later plan fills. A
 * message with nothing to show says so in one sentence instead of a slot.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { SKIP_SPECIAL_USE } from "../../../mail/sync/engine.js";
import { FRAME_IFRAME_SANDBOX } from "../../../mail/reader/frame-doc.js";

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

/* -------------------------------------------------------------- message view */

/** The frame route's path for one stored row: the body is served there, never drawn here. */
function frameSrc(id) {
  return `${MAIL_HREF}/api/messages/${Number(id)}/frame`;
}

/** The attachment route's path for one attachment of one row (Task 5a serves it). */
function attachmentHref(id, index) {
  return `${MAIL_HREF}/api/messages/${Number(id)}/attachments/${Number(index)}`;
}

/** One addressee as plain text (`Name <address>`): mail text, so the caller escapes it. */
function personText(person) {
  const name = typeof person?.name === "string" ? person.name.trim() : "";
  const address = typeof person?.address === "string" ? person.address.trim() : "";
  if (name && address) return `${name} <${address}>`;
  return name || address;
}

/** A person's words for the header: the name, the address, or the placeholder. */
function fromHtml(message, lang) {
  const name = typeof message?.fromName === "string" ? message.fromName.trim() : "";
  const address = typeof message?.fromAddr === "string" ? message.fromAddr.trim() : "";
  if (name && address) {
    return `<span class="ml-msg-name">${e(name)}</span> <span class="ml-msg-addr">&lt;${e(address)}&gt;</span>`;
  }
  if (name) return `<span class="ml-msg-name">${e(name)}</span>`;
  if (address) return `<span class="ml-msg-addr">${e(address)}</span>`;
  return `<span class="ml-msg-name">${e(t("mail.unknownSender", lang))}</span>`;
}

/**
 * The recipients line, collapsed: its summary says who it is to, and opening it lists the To and Cc
 * addressees. A message with neither shows no line at all.
 */
function recipientsHtml(message, lang) {
  const to = Array.isArray(message?.to) ? message.to : [];
  const cc = Array.isArray(message?.cc) ? message.cc : [];
  if (!to.length && !cc.length) return "";
  const summary = `${t("mail.to", lang)} ${to.map(personText).filter(Boolean).join(", ")}`.trim();
  const list = (people) => (people.length
    ? `<ul class="ml-recipients">${people.map((person) => `<li>${e(personText(person))}</li>`).join("")}</ul>`
    : "");
  return `<details class="ml-msg-recipients"><summary>${e(summary)}</summary>${list(to)}${list(cc)}</details>`;
}

/** The full date and time, in the instance's zone. */
function fullDate(date, { lang, tz }) {
  const ms = Number(date);
  if (!Number.isFinite(ms)) return "";
  const formatter = formatterOf(localeOf(lang), { dateStyle: "full", timeStyle: "short" }, tz);
  if (!formatter) return "";
  try {
    return formatter.format(new Date(ms));
  } catch {
    return "";
  }
}

/** Whether a stored row has anything to show: neither its text nor its html is empty, no parse error. */
function hasReadableBody(row) {
  const parseError = typeof row?.parseError === "string" ? row.parseError.trim() : "";
  if (parseError !== "") return false;
  const text = typeof row?.bodyText === "string" ? row.bodyText.trim() : "";
  const html = typeof row?.bodyHtml === "string" ? row.bodyHtml.trim() : "";
  return text !== "" || html !== "";
}

/** A file size in the reader's own units: bytes below 1 KB, then KB, then MB. */
function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.trunc(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

/**
 * One message's attachments: a name (the download link's own text), its size, and the download link,
 * which skips Turbo so the file's own response is what the browser gets.
 */
function attachmentsHtml(row) {
  const list = Array.isArray(row?.attachments) ? row.attachments : [];
  if (!list.length) return "";
  const items = list.map((entry, index) => {
    const name = (typeof entry?.filename === "string" ? entry.filename.trim() : "") || "attachment";
    const size = formatSize(entry?.size);
    return `<li class="ml-attachment"><a class="ml-attachment-link" href="${e(attachmentHref(row.id, index))}" download data-turbo="false" data-turbo-prefetch="false">${e(name)}</a>`
      + (size ? `<span class="ml-size">${e(size)}</span>` : "")
      + "</li>";
  }).join("");
  return `<ul class="ml-attachments">${items}</ul>`;
}

/**
 * The remote-image controls for one section, hidden until the frame reports blocked images: this load
 * only ("Show images") and from now on for this sender ("Always show from <sender>").
 */
function imageBanner(row, accountId, lang) {
  const sender = typeof row?.fromAddr === "string" ? row.fromAddr : "";
  return `<div class="ml-img-banner" data-ml-img-banner hidden data-account="${e(accountId)}" data-sender="${e(sender)}">`
    + `<button type="button" class="ml-btn" data-ml-show-images>${e(t("mail.showImages", lang))}</button>`
    + `<button type="button" class="ml-btn" data-ml-always-images>${e(fill(t("mail.alwaysShowFrom", lang), { sender }))}</button>`
    + "</div>";
}

/**
 * One message of the conversation as a `<details>`. The body is never in the markup: the section
 * carries the frame slot the client fills (Task 8) — unless the message has nothing to show, which
 * says so in one sentence and still lists its attachments.
 */
function messageSection(row, { accountId, lang, tz, open }) {
  const sender = senderOf(row, lang);
  const summary = `<summary class="ml-msg-summary"><span class="ml-msg-who">${e(sender)}</span>`
    + `<span class="ml-msg-when">${e(fullDate(row.date, { lang, tz }))}</span></summary>`;
  // The section's own subject: a conversation can hold several (a reply that renamed it), and a
  // collapsed section has to be recognisable without opening it.
  const subject = `<p class="ml-msg-section-subject">${e(subjectOf(row, lang))}</p>`;
  const body = hasReadableBody(row)
    ? imageBanner(row, accountId, lang)
      + `<div class="ml-frame" data-ml-frame-slot data-src="${e(frameSrc(row.id))}" data-sandbox="${e(FRAME_IFRAME_SANDBOX)}"></div>`
    : `<p class="ml-note ml-no-body">${e(t("mail.noBody", lang))}</p>`;
  return `<details class="ml-msg-section" data-ml-msg="${Number(row.id)}"${open ? " open" : ""}>`
    + summary + subject + body + attachmentsHtml(row) + "</details>";
}

/** Whether two stored rows are copies of one message (the same id, sender and date, another folder). */
function isCopyOf(a, b) {
  const messageId = typeof a?.messageId === "string" && a.messageId !== "" ? a.messageId : null;
  if (messageId === null || messageId !== b?.messageId) return false;
  return (a.fromAddr ?? null) === (b.fromAddr ?? null) && Number(a.date) === Number(b.date);
}

/**
 * The conversation's sections: Task 1's order, one entry per logical message. The opened row is the
 * copy the person clicked, so when the thread lists its group's representative instead, the clicked
 * copy stands for the group (its own body and its own attachment indexes).
 */
function threadRows(message, thread) {
  const list = (Array.isArray(thread) ? thread : [])
    .filter((row) => row && typeof row === "object" && Number.isInteger(Number(row.id)));
  if (!list.length) return [message];
  if (list.some((row) => Number(row.id) === Number(message.id))) return list;
  const index = list.findIndex((row) => isCopyOf(row, message));
  if (index < 0) return list;
  const out = [...list];
  out[index] = message;
  return out;
}

/** The sentence a link that means nothing gets, with the way back to the list. */
function notHereCard(back, lang) {
  return `<section class="ml-empty" data-ml-empty="message-gone">
      <p class="ml-note">${e(t("mail.notHere", lang))}</p>
      <a class="ml-back" href="${e(back)}">&larr; ${e(t("mail.title", lang))}</a>
    </section>`;
}

/**
 * The message view: the opened message's header, then its whole conversation oldest first, then the
 * slot a later plan fills with the reply actions. Every section carries a frame slot and no iframe:
 * the body is served by the frame route and the client builds the frame.
 *
 * `thread` holds full rows (the caller looks each summary up, so a section can tell whether it has
 * a body and list its own attachments); `back` is a validated mail list link, never an outside URL.
 *
 * @param {{
 *   message?: object|null, thread?: object[], account?: object|null, lang?: string,
 *   back?: string, tz?: string
 * }} options
 * @returns {string}
 */
export function messageViewHtml({
  message = null,
  thread = [],
  account = null,
  lang = "en",
  back = MAIL_HREF,
  tz = undefined,
} = {}) {
  if (!message || typeof message !== "object") return "";

  const accountId = account?.id ?? message.accountId ?? "";
  const rows = threadRows(message, thread);
  const openedId = Number(message.id);
  const newestId = Number(rows[rows.length - 1]?.id);
  const sections = rows.map((row) => messageSection(row, {
    accountId,
    lang,
    tz,
    open: Number(row.id) === openedId || Number(row.id) === newestId,
  })).join("");
  const mid = typeof message.messageId === "string" ? message.messageId : "";
  const threadId = message.threadId == null ? "" : String(message.threadId);

  return `<article class="ml-message" data-ml-message>
      <a class="ml-back" href="${e(back)}">&larr; ${e(t("mail.title", lang))}</a>
      <header class="ml-msg-head">
        <h2 class="ml-msg-subject">${e(subjectOf(message, lang))}</h2>
        <p class="ml-msg-from">${fromHtml(message, lang)}</p>
        ${recipientsHtml(message, lang)}
        <p class="ml-msg-date">${e(fullDate(message.date, { lang, tz }))}</p>
      </header>
      <div class="ml-thread">${sections}</div>
      <div data-mail-reply-slot data-account="${e(accountId)}" data-mid="${e(mid)}" data-thread="${e(threadId)}"></div>
    </article>`;
}

/**
 * The view dispatcher. `accounts` and `elsewhere` are what `accountsOverview` returns: usable
 * accounts (any status but `claimed_elsewhere`), the held ones with their `heldBy`, and the
 * addresses other live instances hold. The empty states win over the view: a reader with no mail
 * to read gets the same page whichever view it asked for.
 *
 * `message` is the full row `resolveMessageRef` answered for a link, `thread` the conversation's
 * rows in Task 1's order (each looked up so a section can tell whether it has a body), and `missing`
 * a link that resolved to nothing: its page says so and offers the way back, never an error.
 *
 * @param {{
 *   view?: string, accounts?: object[], elsewhere?: object[], lang?: string, folders?: object[],
 *   page?: object|null, acct?: string, folderId?: number|null, now?: number, tz?: string,
 *   message?: object|null, thread?: object[], account?: object|null, back?: string, missing?: boolean
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
  message = null,
  thread = [],
  account = null,
  back = MAIL_HREF,
  missing = false,
} = {}) {
  const usable = accounts.filter((a) => a.status !== "claimed_elsewhere");

  if (!accounts.length) {
    if (!elsewhere.length) return pageShell(connectCard(lang), lang);
    return pageShell(elsewhereCard(elsewhere.map((x) => x.instanceName), lang), lang);
  }
  if (!usable.length) return pageShell(elsewhereCard(accounts.map((a) => a.heldBy), lang), lang);

  if (view === "message") {
    if (missing || !message) return pageShell(notHereCard(back, lang), lang);
    return pageShell(messageViewHtml({ message, thread, account, lang, back, tz }), lang);
  }

  // `view` picks the view inside the page; search and settings are built in later tasks, and until
  // then only the inbox has anything to draw.
  if (view === "inbox" && page) {
    return pageShell(inboxViewHtml({ accounts: usable, folders, page, acct, folderId, now, lang, tz }), lang);
  }
  return pageShell("", lang);
}

export default renderMailPage;