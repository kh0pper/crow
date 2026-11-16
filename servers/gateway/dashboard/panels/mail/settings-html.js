/**
 * Crow Mail's account settings page (plan 2, Task 7): one card per account and, below them, the
 * "Add an account" form. The page is drawn by the panel at `/dashboard/mail?view=settings`; every
 * control on it is a hook the client script reads (`data-ml-*`) and the request it makes goes to
 * `/dashboard/mail/api`, never to this page.
 *
 * A card shows the owner's own label (editable) and the mailbox address, a status in words — working,
 * a sign-in that needs the password again, or an account another instance holds — the last sync time
 * under its own "Last checked" label, the sync control, the local-models switch with its helper line,
 * the update-password control (only for an account the server refused), the senders whose images show
 * unasked (under their own heading), and remove behind its own sentence. Nothing drawn here is a
 * connection setting: `accountsOverview` carries no host, port or username, and this module never asks
 * the account store for one. The senders arrive from the caller as `allow[accountId] = [sender, …]`,
 * already lower-cased and sorted.
 *
 * Every value that came from the owner or from the wire (a label, an address, a sender) is escaped:
 * a label is text in the heading and an attribute in the rename field, and no value is ever used for
 * markup or an event handler. The page makes no request of its own and holds no script; its header row
 * carries the same settings gear every other view has.
 *
 * The add-account form's body is its own exported function so plan 5 replaces it whole (provider
 * presets, Gmail's app-password steps, the OAuth wizards) without touching the cards. Its fields are
 * the minimal set a password account needs; its security lists offer `ssl` and `starttls` only —
 * there is no plaintext option in the UI. The client turns the field names below into the connect
 * body (`imap: {host, port, security}` and the same for `smtp`).
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { anotherCrow, mailGearLink } from "./html.js";

const e = escapeHtml;

const LOCALES = { en: "en-US", es: "es-ES" };

function localeOf(lang) {
  return LOCALES[lang] ?? LOCALES.en;
}

/** The owner's own label, trimmed, and empty when they left it blank: the rename field's value. */
function typedLabelOf(account) {
  return typeof account?.label === "string" ? account.label.trim() : "";
}

/** The account's heading: the owner's words, else the mailbox address (never the blank label itself). */
function labelOf(account, lang) {
  const address = typeof account?.address === "string" ? account.address.trim() : "";
  return typedLabelOf(account) || address || anotherCrow(lang);
}

/** The name of the instance an account is connected on, or the fallback when none is stored. */
function heldNameOf(account, lang) {
  const name = typeof account?.heldBy === "string" ? account.heldBy.trim() : "";
  return name || anotherCrow(lang);
}

/** The status in words: working, a sign-in that needs the password, or held by another instance. */
function statusWord(account, lang) {
  const status = typeof account?.status === "string" ? account.status : "active";
  if (status === "auth_failed") return t("mail.statusAuthFailed", lang);
  if (status === "claimed_elsewhere") {
    return fill(t("mail.statusHeld", lang), { instance: heldNameOf(account, lang) });
  }
  return t("mail.statusWorking", lang);
}

/** One status line, carrying its code as data so a reload can be read without parsing the sentence. */
function statusHtml(account, lang) {
  const status = typeof account?.status === "string" ? account.status : "active";
  return `<p class="ml-note ml-status" data-ml-status="${e(status)}">${e(statusWord(account, lang))}</p>`;
}

/**
 * The last check as its own visible label and then a whole date and time in the instance's zone;
 * nothing at all when there is none.
 */
function lastSyncHtml(value, { lang, tz }) {
  const ms = Number(value);
  if (value == null || !Number.isFinite(ms)) return "";
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat(localeOf(lang), tz
      ? { dateStyle: "medium", timeStyle: "short", timeZone: tz }
      : { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
  let text;
  try {
    text = formatter.format(new Date(ms));
  } catch {
    return "";
  }
  return `<p class="ml-note ml-synced">${e(t("mail.lastChecked", lang))} <time datetime="${e(new Date(ms).toISOString())}">${e(text)}</time></p>`;
}

/**
 * The senders whose remote images show unasked on this account, under their own heading, each with its
 * own remove control. The list is context-free without that heading, so the whole block — heading and
 * list — is drawn only when there is something to remove.
 */
function allowListHtml(accountId, senders, lang) {
  const list = (Array.isArray(senders) ? senders : [])
    .filter((sender) => typeof sender === "string" && sender !== "");
  if (!list.length) return "";
  const items = list.map((sender) => `<li class="ml-allow-item">`
    + `<span class="ml-allow-sender">${e(sender)}</span>`
    + `<button class="ml-btn" type="button" data-ml-remove-sender data-account="${e(accountId)}" data-sender="${e(sender)}">${e(t("mail.remove", lang))}</button>`
    + "</li>").join("");
  return `<h3 class="ml-allow-title">${e(t("mail.allowedSendersHeading", lang))}</h3>`
    + `<ul class="ml-allow" data-ml-allow-list>${items}</ul>`;
}

/**
 * The password control, drawn only for an account the server refused: the field the new password is
 * typed into, and the button the client sends it with. An account that signs in has nothing here.
 */
function updatePasswordHtml(accountId, lang) {
  return `<details class="ml-update-password" data-ml-update-password data-account="${e(accountId)}">`
    + `<summary class="ml-field-label">${e(t("mail.updatePassword", lang))}</summary>`
    + `<label class="ml-field"><span class="ml-field-label">${e(t("mail.fieldPassword", lang))}</span>`
    + `<input class="ml-input" type="password" name="password" autocomplete="new-password" data-ml-password-input></label>`
    + `<button class="ml-btn" type="button" data-ml-password-save data-account="${e(accountId)}">${e(t("mail.updatePassword", lang))}</button>`
    + "</details>";
}

/**
 * Remove, behind its own sentence. The sentence stays hidden until the client's own first click on the
 * button, which is inert until then; the client sends the delete only on a later click.
 */
function removeAccountHtml(accountId, lang) {
  return `<div class="ml-danger" data-ml-remove-account data-account="${e(accountId)}">`
    + `<p class="ml-note" data-ml-confirm-sentence hidden>${e(t("mail.removeAccountConfirm", lang))}</p>`
    + `<button class="ml-btn" type="button" data-ml-remove-account-btn data-account="${e(accountId)}">${e(t("mail.removeAccount", lang))}</button>`
    + "</div>";
}

/** One account's card: its label, address, status and every control the owner may use on it. */
function accountCard(account, { senders = [], lang, tz }) {
  const id = String(account?.id ?? "");
  const label = labelOf(account, lang);
  const typedLabel = typedLabelOf(account);
  const address = typeof account?.address === "string" ? account.address : "";
  const checked = account?.localModelsOnly ? " checked" : "";
  const update = account?.status === "auth_failed" ? updatePasswordHtml(id, lang) : "";
  return `<section class="ml-card" data-ml-account="${e(id)}">
      <h2 class="ml-card-title">${e(label)}</h2>
      <p class="ml-note ml-address">${e(address)}</p>
      ${statusHtml(account, lang)}
      ${lastSyncHtml(account?.lastSyncAt, { lang, tz })}
      <label class="ml-field"><span class="ml-field-label">${e(t("mail.fieldLabel", lang))}</span>
        <input class="ml-input" type="text" name="label" data-ml-rename data-account="${e(id)}" value="${e(typedLabel)}"></label>
      <div class="ml-actions">
        <button class="ml-btn" type="button" data-ml-sync data-account="${e(id)}">${e(t("mail.syncNow", lang))}</button>
      </div>
      <div class="ml-field">
        <label class="ml-switch"><input type="checkbox" name="localModelsOnly" data-ml-local-models data-account="${e(id)}"${checked}> ${e(t("mail.localModelsOnly", lang))}</label>
        <p class="ml-help">${e(t("mail.localModelsOnlyHelp", lang))}</p>
      </div>
      ${update}
      ${allowListHtml(id, senders, lang)}
      ${removeAccountHtml(id, lang)}
    </section>`;
}

/**
 * The add-account form: the smallest set a password account needs, with `ssl` and `starttls` only.
 * Plan 5 replaces this whole function's body; the page above it does not change.
 *
 * The form is a set of fields for the client script, which cancels the submit and posts them to the
 * mail API's accounts route itself (that route is hardcoded in the script, not read from this markup,
 * so the markup names no target). It carries no `action` and names `method="post"`: without the
 * client handler a native submit would otherwise be a GET that puts the password in the URL.
 *
 * @param {string} [lang]
 * @returns {string}
 */
export function addAccountForm(lang = "en") {
  const text = (name, label, extra = "", type = "text") => `<label class="ml-field"><span class="ml-field-label">${e(label)}</span>`
    + `<input class="ml-input" type="${type}" name="${name}"${extra}></label>`;
  const security = (name) => `<label class="ml-field"><span class="ml-field-label">${e(t("mail.fieldSecurity", lang))}</span>`
    + `<select class="ml-input" name="${name}"><option value="ssl">ssl</option><option value="starttls">starttls</option></select></label>`;
  return `<form class="ml-add" data-ml-add-account method="post">
      <h2 class="ml-card-title">${e(t("mail.addAccount", lang))}</h2>
      ${text("label", t("mail.fieldLabel", lang))}
      ${text("address", t("mail.fieldAddress", lang), ' autocomplete="email"', "email")}
      <label class="ml-field"><span class="ml-field-label">${e(t("mail.fieldPassword", lang))}</span>
        <input class="ml-input" type="password" name="password" autocomplete="new-password"></label>
      ${text("imap-host", t("mail.fieldImapHost", lang))}
      ${text("imap-port", t("mail.fieldImapPort", lang), ' inputmode="numeric"')}
      ${security("imap-security")}
      ${text("smtp-host", t("mail.fieldSmtpHost", lang))}
      ${text("smtp-port", t("mail.fieldSmtpPort", lang), ' inputmode="numeric"')}
      ${security("smtp-security")}
      <button class="ml-btn ml-btn--primary" type="submit">${e(t("mail.addAccount", lang))}</button>
    </form>`;
}

/**
 * The settings view: the "Mail is set up on <instance>" lines for mail another live instance holds,
 * one card per account (any status — an account held elsewhere still needs its remove control), and
 * the add-account form, which stays available even when every account is held elsewhere: only the
 * same address is refused, by the connect route itself.
 *
 * @param {{
 *   accounts?: object[], elsewhere?: {instanceName?: string}[], allow?: Record<string, string[]>,
 *   lang?: string, tz?: string
 * }} [options]
 * @returns {string}
 */
export function settingsHtml({
  accounts = [],
  elsewhere = [],
  allow = {},
  lang = "en",
  tz = undefined,
} = {}) {
  const held = (Array.isArray(elsewhere) ? elsewhere : []).map((entry) => {
    const name = typeof entry?.instanceName === "string" && entry.instanceName.trim() !== ""
      ? entry.instanceName.trim()
      : anotherCrow(lang);
    return `<p class="ml-note">${e(fill(t("mail.elsewhereOn", lang), { instance: name }))}</p>`;
  }).join("");
  const cards = (Array.isArray(accounts) ? accounts : [])
    .map((account) => accountCard(account, { senders: allow?.[account?.id] ?? [], lang, tz }))
    .join("");
  return `<div class="ml" data-ml>
    <div class="ml-page-head">
      <h1 class="ml-title">${e(t("mail.title", lang))}</h1>
      ${mailGearLink(lang)}
    </div>
    <div class="ml-settings" data-ml-settings>${held}${cards}${addAccountForm(lang)}</div>
  </div>`;
}

export default settingsHtml;