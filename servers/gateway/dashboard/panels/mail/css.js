/**
 * Crow Mail reader styles. Every rule is scoped under .ml, so the page reads the same in the new
 * shell and in classic. Phone first (390 px): one column, no fixed widths, every target at least
 * 44 px; from 1024 px the column is capped so lines stay readable. Colours and radii are the
 * --crow-* tokens, which follow the OS between light and dark.
 *
 * The list rules (the search box, the refresh control, the chips, the folder drawer and the message
 * rows) come with the inbox view, the conversation's rules with the message view and the account
 * cards with the settings view, which is why they are behind `inbox`, `message` and `settings`: a
 * page that draws only an empty state ships only that state's rules. The way back a card offers
 * (`.ml-back`) is in the base rules, because a state card rather than the conversation draws it.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 *
 * The one rule that has to name the document rather than .ml — Chrome Android's own pull-to-refresh,
 * which would otherwise fire beside the reader's — is injected by the panel's client script: every
 * rule here stays under .ml, so the panel's stylesheet never reaches outside its page.
 */

/** The list header (the search box and the refresh control), account chips, the folder drawer, and one row per message. */
const INBOX_RULES = `
  .ml-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .ml-search { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 12rem; min-width: 0; margin: 0; }
  .ml-search-input {
    display: block; flex: 1 1 8rem; min-width: 0; min-height: 44px; padding: 0 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill);
    background: var(--crow-bg-surface); color: var(--crow-text-primary); font: inherit; font-size: 0.9rem;
    text-align: start;
  }
  .ml-search-heading { margin: 0; min-width: 0; font-size: 1.05rem; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .ml-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .ml-flash { min-width: 0; }
  .ml-chips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .ml-chip {
    display: inline-flex; align-items: center; min-height: 44px; max-width: 100%; padding: 0 14px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-pill); background: transparent;
    color: var(--crow-text-primary); font-size: 0.9rem; text-decoration: none; overflow-wrap: anywhere;
  }
  .ml-chip[aria-current="page"] { background: var(--crow-accent); border-color: var(--crow-accent); color: var(--crow-accent-contrast); font-weight: 600; }
  .ml-drawer { border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface); min-width: 0; }
  .ml-drawer-summary { display: flex; align-items: center; min-height: 44px; padding: 0 14px; box-sizing: border-box; cursor: pointer; font-size: 0.9rem; font-weight: 600; }
  .ml-drawer-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 0 12px 12px; }
  .ml-drawer-account { margin: 0; font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .ml-folders { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ml-folder-item { min-width: 0; }
  .ml-folder {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 0 8px;
    box-sizing: border-box; border-radius: 8px; color: var(--crow-text-primary); font-size: 0.9rem; text-decoration: none;
    overflow-wrap: anywhere;
  }
  .ml-folder[aria-current="page"] { background: var(--crow-bg-elevated); font-weight: 600; }
  .ml-count { flex: none; font-size: 0.8rem; color: var(--crow-text-secondary); }
  .ml-list { display: flex; flex-direction: column; min-width: 0; }
  .ml-row {
    display: grid; min-height: 44px; min-width: 0; padding: 10px 12px; box-sizing: border-box; grid-template-columns: auto 1fr auto;
    grid-template-areas: "dot sender time" "dot subject subject" "dot snippet snippet"; column-gap: 8px; row-gap: 2px;
    border-bottom: 1px solid var(--crow-border); color: var(--crow-text-primary); text-decoration: none;
  }
  .ml-dot { grid-area: dot; align-self: center; width: 8px; height: 8px; border-radius: 50%; background: var(--crow-accent); }
  .ml-sender { grid-area: sender; min-width: 0; font-size: 0.9rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ml-subject { grid-area: subject; min-width: 0; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ml-snippet { grid-area: snippet; min-width: 0; font-size: 0.85rem; color: var(--crow-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ml-time { grid-area: time; font-size: 0.8rem; color: var(--crow-text-secondary); white-space: nowrap; }
  .ml-more {
    display: inline-flex; align-items: center; justify-content: center; align-self: flex-start; min-height: 44px; padding: 0 16px;
    box-sizing: border-box; border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill);
    color: var(--crow-text-primary); font-size: 0.9rem; text-decoration: none;
  }`;

/**
 * The message view (Task 5): the header, one conversation section per message, the frame slot the
 * client fills, the hidden image banner, the attachment rows and the no-body sentence.
 */
const MESSAGE_RULES = `
  .ml-message { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ml-msg-head { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ml-msg-subject { margin: 0; font-size: 1.2rem; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
  .ml-msg-from { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 0.95rem; min-width: 0; }
  .ml-msg-name { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .ml-msg-addr { color: var(--crow-text-secondary); min-width: 0; overflow-wrap: anywhere; }
  .ml-msg-recipients { min-width: 0; }
  .ml-msg-recipients > summary {
    display: flex; align-items: center; min-height: 44px; cursor: pointer; font-size: 0.9rem;
    color: var(--crow-text-secondary); overflow-wrap: anywhere;
  }
  .ml-recipients { list-style: none; margin: 0; padding: 0 0 4px; display: flex; flex-direction: column; gap: 2px; font-size: 0.9rem; overflow-wrap: anywhere; }
  .ml-msg-date { margin: 0; font-size: 0.85rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .ml-msg-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .ml-msg-actions .ml-btn, .ml-move-select { min-height: 44px; }
  .ml-msg-actions .ml-status-line { flex-basis: 100%; }
  .ml-move-select {
    display: block; min-width: 0; max-width: 100%; min-height: 44px; padding: 0 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill);
    background: var(--crow-bg-surface); color: var(--crow-text-primary); font: inherit; font-size: 0.9rem;
  }
  .ml-thread { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .ml-msg-section { border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface); min-width: 0; }
  .ml-msg-section[open] > .ml-msg-summary { border-bottom: 1px solid var(--crow-border); }
  .ml-msg-summary { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; box-sizing: border-box; cursor: pointer; font-size: 0.9rem; min-width: 0; }
  .ml-msg-who { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .ml-msg-when { margin-left: auto; font-size: 0.8rem; color: var(--crow-text-secondary); white-space: nowrap; }
  .ml-msg-section-subject { margin: 0; padding: 8px 12px 0; font-size: 0.95rem; font-weight: 600; overflow-wrap: anywhere; }
  .ml-img-banner { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; padding: 8px 12px; }
  .ml-img-banner[hidden] { display: none; }
  .ml-frame { min-width: 0; padding: 0 12px 8px; }
  .ml-frame iframe { display: block; width: 100%; min-height: 120px; border: 0; }
  .ml-no-body { padding: 8px 12px 12px; }
  .ml-attachments { list-style: none; margin: 0; padding: 0 12px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ml-attachment { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ml-attachment-link {
    display: inline-flex; align-items: center; min-height: 44px; color: var(--crow-accent);
    font-size: 0.9rem; text-decoration: none; overflow-wrap: anywhere;
  }
  .ml-size { margin-left: auto; font-size: 0.8rem; color: var(--crow-text-secondary); white-space: nowrap; }
  /* The reply slot (plan 3, Task 11): the five actions, then the bot picker the client fills. Every
     control is a 44 px target, like the message bar's. */
  .ml-reply-slot { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .ml-reply-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .ml-bot-picker {
    display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface);
  }
  .ml-bot-picker[hidden] { display: none; }
  .ml-picker-refusal { color: var(--crow-text-primary); }
  .ml-picker-refusal[hidden] { display: none; }
  .ml-picker-list { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ml-picker-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .ml-picker-group-name { margin: 0; font-size: 0.8rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .ml-bot-pick { flex-direction: column; align-items: flex-start; min-width: 0; width: 100%; }
  .ml-pick-name { min-width: 0; overflow-wrap: anywhere; }
  .ml-pick-reason { min-width: 0; font-size: 0.8rem; font-weight: 400; color: var(--crow-text-secondary); overflow-wrap: anywhere; }`;

/**
 * The settings view (Task 7): the account cards (label field, address, status, sync, the local-models
 * switch, the password control, the allowed senders and the remove block) and the add-account form.
 * Every input and button is a 44 px target; no rule sets a fixed width, so the page never scrolls
 * sideways on a phone.
 */
const SETTINGS_RULES = `
  .ml-settings { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ml-card, .ml-add {
    display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 16px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface);
  }
  .ml-card-title { margin: 0; min-width: 0; font-size: 1.05rem; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
  .ml-address { color: var(--crow-text-secondary); }
  .ml-status { font-weight: 600; }
  .ml-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 0; }
  .ml-field-label { min-width: 0; font-size: 0.8rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .ml-input {
    display: block; width: 100%; min-height: 44px; min-width: 0; padding: 0 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: 8px;
    background: var(--crow-bg-elevated); color: var(--crow-text-primary); font: inherit; font-size: 0.9rem;
  }
  .ml-switch { display: flex; align-items: center; gap: 8px; min-height: 44px; min-width: 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .ml-help { margin: 0; min-width: 0; font-size: 0.8rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .ml-synced { font-size: 0.8rem; color: var(--crow-text-secondary); }
  .ml-allow-title { margin: 0; min-width: 0; font-size: 0.9rem; font-weight: 600; overflow-wrap: anywhere; }
  .ml-update-password { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .ml-update-password > summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; }
  .ml-allow { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ml-allow-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
  .ml-allow-sender { min-width: 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .ml-danger {
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0;
    padding-top: 8px; border-top: 1px solid var(--crow-border);
  }`;

/**
 * @param {{inbox?: boolean, message?: boolean, settings?: boolean}} options `inbox` adds the list
 *   rules (chips, folder drawer, message rows), `message` the conversation's and `settings` the
 *   account cards and the add-account form; a view that draws none ships none.
 * @returns {string}
 */
export function mailCss({ inbox = false, message = false, settings = false } = {}) {
  return `<style>
  .ml { max-width: 44rem; min-width: 0; overscroll-behavior-y: contain; display: flex; flex-direction: column; gap: 12px; color: var(--crow-text-primary); }
  .ml-title { margin: 0; font-size: 1.5rem; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
  .ml-empty {
    display: flex; flex-direction: column; align-items: flex-start; gap: 12px; min-width: 0; padding: 16px;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface);
  }
  .ml-note { margin: 0; font-size: 0.95rem; line-height: 1.45; overflow-wrap: anywhere; }
  .ml-btn {
    display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; box-sizing: border-box;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill); background: transparent;
    color: var(--crow-text-primary); font: inherit; font-size: 0.9rem; text-decoration: none; cursor: pointer; text-align: center;
  }
  .ml-btn--primary { background: var(--crow-accent); border-color: var(--crow-accent); color: var(--crow-accent-contrast); font-weight: 600; }
  .ml-btn[hidden] { display: none; }
  .ml-page-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ml-page-head .ml-title { flex: 1 1 auto; min-width: 0; }
  .ml-gear {
    flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;
    padding: 0; box-sizing: border-box;
  }
  .ml-gear-icon { display: block; width: 20px; height: 20px; }
  .ml-back {
    display: inline-flex; align-items: center; align-self: flex-start; min-height: 44px; padding: 0 12px;
    box-sizing: border-box; border-radius: var(--crow-radius-pill); color: var(--crow-text-primary);
    font-size: 0.9rem; text-decoration: none; overflow-wrap: anywhere;
  }
  .ml a:focus-visible, .ml button:focus-visible, .ml summary:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }${inbox ? INBOX_RULES : ""}${message ? MESSAGE_RULES : ""}${settings ? SETTINGS_RULES : ""}
</style>`;
}

export default mailCss;