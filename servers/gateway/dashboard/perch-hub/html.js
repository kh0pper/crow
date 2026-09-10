import { t } from "../shared/i18n.js";
import { escapeHtml } from "../shared/components.js";
import { perchHubCss } from "./css.js";
import { perchHubJs } from "./client.js";

/** engineStatus() returns installing | absent | unhealthy | ready
 *  (bot-engine-status.js:84-101). Only "absent" means "not installed" — telling
 *  an operator whose engine is mid-install, or whose breaker is open, to go
 *  install it sends them somewhere that cannot help. */
function engineBanner(engine, lang) {
  const state = (engine && engine.state) || "ready";
  if (state === "ready") return "";
  if (state === "absent") {
    return `<div class="empty" id="perch-engine-banner">${escapeHtml(t("perch.engineAbsent", lang))} ` +
      `<a href="/dashboard/extensions">${escapeHtml(t("perch.engineInstall", lang))}</a></div>`;
  }
  const key = state === "installing" ? "perch.engineInstalling" : "perch.engineUnhealthy";
  return `<div class="empty" id="perch-engine-banner">${escapeHtml(t(key, lang))}</div>`;
}

/** Perch's markup + styles + client script, meant to be handed to a panel's
 *  `layout()` as `content` (dashboard/panels/perch-hub.js does exactly
 *  that) — NOT a standalone document. Rendering inside the dashboard shell
 *  is what keeps the crow sidebar present on this page; the old
 *  perchHubDocument() bypassed layout() entirely and that's what made the
 *  nav vanish here. Everything Perch-specific is scoped under
 *  #perch-hub-root (see css.js for why that scoping is load-bearing, not
 *  cosmetic) so it can't leak onto the sidebar or any other panel, and vice
 *  versa. Static shell only — every list row and transcript line is
 *  rendered client-side, the same split birdDrawerMarkup() uses. */
export function perchHubContent(lang = "en", engine = { state: "ready" }) {
  return `<style>${perchHubCss()}</style>
<div id="perch-hub-root">
${engineBanner(engine, lang)}
<!-- No brand block here. The shell's .content-header already renders
     <h2>Perch</h2> from this panel's title (panels/perch-hub.js), and
     Perch's own <div class="brand">Perch</div> printed the same word again
     directly underneath it. The shell header is canonical now; the
     "your bot sessions" subtitle went with the block rather than being
     restated somewhere it would read as a second page title. This header
     survives only to carry the link back to the board. -->
<header><nav class="machines"><a href="/dashboard/bot-board">${escapeHtml(t("perch.navBoard", lang))}</a></nav></header>
<div class="hub-split">
  <div id="perch-list">
    <h2>${escapeHtml(t("perch.sessionsHeading", lang))}</h2>
    <!-- The launcher sits OUTSIDE #perch-list-body on purpose. renderList()
         and showListNote() both clearEl() that body, so a launch control
         living inside it would be wiped by every poll and every note — and
         the defect this fixes is precisely that the only way to start a
         session was a row that disappears once the bot is busy. Out here it
         is unconditional, independent of what the rows contain.
         It ships disabled: renderLauncher() enables it once the first
         /roost answers, so the pre-data frame never claims "no bots". -->
    <div id="perch-launch">
      <label class="field-label" id="perch-new-bot-label" for="perch-new-bot" hidden>${escapeHtml(t("perch.newSessionBot", lang))}</label>
      <select id="perch-new-bot" aria-labelledby="perch-new-bot-label" hidden></select>
      <!-- The model for the session about to be started. Populated from
           GET /bots/<id>/models (session-free — there is no session yet to
           ask), pre-selected on the bot's own configured default, so the
           common case stays one tap on the button beside it. Hidden until
           that list arrives: an empty-but-visible picker is the state this
           whole task exists to stop shipping. -->
      <label class="field-label" id="perch-new-model-label" for="perch-new-model" hidden>${escapeHtml(t("perch.newSessionModel", lang))}</label>
      <select id="perch-new-model" aria-labelledby="perch-new-model-label" hidden></select>
      <button type="button" class="primary" id="perch-new" disabled>${escapeHtml(t("perch.newSession", lang))}</button>
      <div class="empty" id="perch-launch-note" hidden></div>
    </div>
    <div id="perch-list-body"><div class="empty">${escapeHtml(t("perch.loading", lang))}</div></div>
  </div>
  <!-- ⚠ #perch-chat is now GLOBALLY significant, not just a local handle:
       layout.js keys a document-wide app-shell clamp on "body:has(#perch-chat)"
       (height:100dvh + overflow:hidden on .main-content, an internally
       scrolling .content-body). Any other panel that reuses this id silently
       inherits that clamp. Rename here and that rule goes dead too. -->
  <div id="perch-chat">
    <button type="button" id="perch-back" class="quiet">${escapeHtml(t("perch.back", lang))}</button>
    <!-- Close lives in .perch-head, NOT in #perch-composer: the composer's
         sticky box is what keeps Send reachable at any scroll position
         (css.js:89-91), and .perch-head is already a non-scrolling child of
         the #perch-chat flex column, so a control here is permanently on
         screen without touching that box. -->
    <!-- The session's operator-set name sits between the bot name and the
         session id, never replacing either: the id stays the identity (the
         close confirmation names it), the name is the convenience. Hidden
         until there is one; rendered with textContent, never markup. -->
    <div class="perch-head"><div><div class="title" id="perch-bot-name"></div>
      <div class="session-name" id="perch-session-name" hidden></div>
      <div class="meta" id="perch-session-meta"></div></div>
      <div class="state" id="perch-state"></div>
      <button type="button" id="perch-rename" class="quiet">${escapeHtml(t("perch.rename", lang))}</button>
      <button type="button" id="perch-close" class="quiet">${escapeHtml(t("perch.close", lang))}</button></div>
    <div class="field-row">
      <div class="field"><span class="field-label" id="perch-model-label">${escapeHtml(t("perch.modelLabel", lang))}</span>
        <select id="perch-model" aria-labelledby="perch-model-label" disabled></select></div>
      <div class="field"><span class="field-label" id="perch-thinking-label">${escapeHtml(t("perch.thinkingLabel", lang))}</span>
        <select id="perch-thinking" aria-labelledby="perch-thinking-label" disabled></select></div>
      <div class="field"><span class="field-label" id="perch-permission-label">${escapeHtml(t("perch.permissionLabel", lang))}</span>
        <select id="perch-permission" aria-labelledby="perch-permission-label">
          <option value="guarded">${escapeHtml(t("perch.permGuarded", lang))}</option>
          <option value="ask">${escapeHtml(t("perch.permAsk", lang))}</option>
          <option value="bypass">${escapeHtml(t("perch.permBypass", lang))}</option>
        </select></div>
      <div class="field"><span class="field-label" id="perch-plan-mode-label">${escapeHtml(t("perch.planModeLabel", lang))}</span>
        <input type="checkbox" id="perch-plan-mode" aria-labelledby="perch-plan-mode-label"></div>
    </div>
    <div id="perch-transcript"></div>
    <div id="perch-ask"></div>
    <div id="perch-composer">
      <textarea id="perch-input" placeholder="${escapeHtml(t("perch.composerPlaceholder", lang))}"></textarea>
      <div class="send-row">
        <button type="button" id="perch-attach" class="quiet">${escapeHtml(t("perch.attachFile", lang))}</button>
        <input type="file" id="perch-file-input" style="display:none" accept="image/*">
        <button type="button" class="primary" id="perch-send">${escapeHtml(t("perch.send", lang))}</button>
        <button type="button" id="perch-abort" style="display:none">${escapeHtml(t("perch.abort", lang))}</button>
      </div>
    </div>
  </div>
</div>
</div>
<script>${perchHubJs(lang)}</script>`;
}
