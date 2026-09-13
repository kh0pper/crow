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
      <!-- Open-anywhere C2: the directory the session about to be started
           runs in. EMPTY means "the bot's default" and the key is never
           sent — the route/engine treat an absent cwd as the world root.
           The browse button opens the server-backed picker modal (built
           client-side; GET /dashboard/perch-api/browse). -->
      <label class="field-label" id="perch-new-cwd-label" for="perch-new-cwd">${escapeHtml(t("perch.cwdLabel", lang))}</label>
      <input type="text" id="perch-new-cwd" aria-labelledby="perch-new-cwd-label" placeholder="${escapeHtml(t("perch.cwdPlaceholder", lang))}" autocomplete="off" spellcheck="false">
      <button type="button" id="perch-browse-btn">${escapeHtml(t("perch.browse", lang))}</button>
      <div class="empty" id="perch-cwd-note">${escapeHtml(t("perch.cwdDefaultNote", lang))}</div>
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
    <!-- Identity stays in the head: the bot name, the operator's session name
         and the session id are what tell the operator WHICH session any tab
         below is about. Everything OPERATIONAL (state pill, rename, close,
         the model/thinking/permission/plan controls) moved into the Session
         tab in Phase D — the head is never a control surface, which is also
         why the old "close lives in .perch-head so it is permanently on
         screen" comment no longer applies: Close now lives in the Session
         tab AND on every list row, and the sticky composer keeps Send (the
         control that must never leave the screen) reachable. -->
    <!-- The session's operator-set name sits between the bot name and the
         session id, never replacing either: the id stays the identity (the
         close confirmation names it), the name is the convenience. Hidden
         until there is one; rendered with textContent, never markup. -->
    <div class="perch-head"><div><div class="title" id="perch-bot-name"></div>
      <div class="session-name" id="perch-session-name" hidden></div>
      <div class="meta" id="perch-session-meta"></div></div></div>
    <!-- Phase D1: the tab strip. FOUR buttons, inline SVG glyphs ported from
         the original pi-lab hub's icon set (~/pi-lab/extensions/web/public/
         app.html, the I set) recoloured via currentColor so crow's teal owns
         them. Every button carries a visible text label beside its glyph
         (house rule: no unlabelled controls). Desktop: a top strip in the
         right pane. Phone: the strip joins the #perch-chat flex chain as a
         non-shrinking LAST sibling (css.js order:10) — a bottom tab bar
         without position:fixed, so the composer sits above it inside the
         chat tab and the flex chain that keeps Send reachable is untouched.
         aria-selected is flipped by the client's switchTab(). -->
    <nav id="perch-tabs" role="tablist" aria-label="${escapeHtml(t("perch.tabsLabel", lang))}">
      <button type="button" role="tab" id="perch-tab-btn-chat" data-tab="chat" aria-controls="perch-tab-chat" aria-selected="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/></svg>${escapeHtml(t("perch.tabChat", lang))}</button>
      <button type="button" role="tab" id="perch-tab-btn-session" data-tab="session" aria-controls="perch-tab-session" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 9h20"/><circle cx="8" cy="9" r="2.4" fill="currentColor" stroke="none"/><path d="M4 20h16M8 11v4m0 0h8m-8 0-3 5m11-9v4m0 0 3 5"/></svg>${escapeHtml(t("perch.tabSession", lang))}</button>
      <button type="button" role="tab" id="perch-tab-btn-files" data-tab="files" aria-controls="perch-tab-files" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></svg>${escapeHtml(t("perch.tabFiles", lang))}</button>
      <button type="button" role="tab" id="perch-tab-btn-activity" data-tab="activity" aria-controls="perch-tab-activity" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 8L9 4l-3 8H2"/></svg>${escapeHtml(t("perch.tabActivity", lang))}</button>
    </nav>
    <!-- Chat tab: transcript + ask cards + composer, exactly the old column —
         the section wrapper inherits the flex chain (#perch-tab-chat is
         flex:1/min-height:0/display:flex column in css.js) so the transcript
         stays the ONLY scroller and the sticky composer backstop is intact. -->
    <section id="perch-tab-chat" role="tabpanel" aria-labelledby="perch-tab-btn-chat">
    <!-- Wave 1: the attention banner. An ask card blocks the turn until
         answered; on a phone the card can be a scroll away, so the banner
         says why the bot went quiet. Toggled by renderAsk/answerAsk — the
         same pendingUi lifecycle the list row's "waiting on you" state and
         the engine's replay-on-subscribe already ride. -->
    <div id="perch-attn" class="attn-banner" hidden>⚠ ${escapeHtml(t("perch.waitingBanner", lang))}</div>
    <div id="perch-transcript"></div>
    <div id="perch-ask"></div>
    <!-- The working strip: the chat tab's own "the bot is busy" signal.
         Since Phase D moved the state pill into the Session tab, the only
         in-chat evidence of a running turn was Send flipping to Steer —
         which reads as a button change, not as activity. A turning gear
         beside one word, driven by the SAME turnInFlight flag that flips
         the composer (setTurnInFlight), so the two can never disagree.
         aria-live=polite: a screen reader announces the state change
         without interrupting mid-sentence. -->
    <div id="perch-working" hidden aria-live="polite">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span>${escapeHtml(t("perch.working", lang))}</span></div>
    <div id="perch-composer">
      <textarea id="perch-input" placeholder="${escapeHtml(t("perch.composerPlaceholder", lang))}"></textarea>
      <div class="send-row">
        <button type="button" id="perch-attach" class="quiet">${escapeHtml(t("perch.attachFile", lang))}</button>
        <input type="file" id="perch-file-input" style="display:none" accept="image/*">
        <button type="button" class="primary" id="perch-send">${escapeHtml(t("perch.send", lang))}</button>
        <button type="button" id="perch-abort" style="display:none">${escapeHtml(t("perch.abort", lang))}</button>
      </div>
    </div>
    </section>
    <!-- Session tab: the controls row (moved verbatim — ids unchanged, so
         every client binding and state-frame sync keeps working), the
         read-only cwd display with its "Change directory" button (D2 wires
         it to the browse modal + control({cwd})), and the state pill beside
         rename/close. -->
    <section id="perch-tab-session" role="tabpanel" aria-labelledby="perch-tab-btn-session" hidden>
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
    <div class="field-row">
      <div class="field"><span class="field-label" id="perch-cwd-label">${escapeHtml(t("perch.cwdLabel", lang))}</span>
        <div class="meta" id="perch-session-cwd"></div>
        <button type="button" id="perch-change-cwd">${escapeHtml(t("perch.changeDirectory", lang))}</button></div>
    </div>
    <div class="session-row">
      <div class="state" id="perch-state"></div>
      <button type="button" id="perch-rename" class="quiet">${escapeHtml(t("perch.rename", lang))}</button>
      <button type="button" id="perch-close" class="quiet">${escapeHtml(t("perch.close", lang))}</button>
    </div>
    </section>
    <!-- Files tab: the session's outputs, listed by D3's endpoint and linked
         through the existing workspace download route. Populated on tab
         activation, never on session open. -->
    <section id="perch-tab-files" role="tabpanel" aria-labelledby="perch-tab-btn-files" hidden>
    <div class="files-bar"><button type="button" id="perch-files-refresh" class="quiet">${escapeHtml(t("perch.filesRefresh", lang))}</button></div>
    <div id="perch-files-list"></div>
    </section>
    <!-- Activity tab: log/tool/plan/error FRAMES land here (D2), so the chat
         transcript stays a conversation. -->
    <section id="perch-tab-activity" role="tabpanel" aria-labelledby="perch-tab-btn-activity" hidden>
    <div id="perch-activity-list"></div>
    </section>
  </div>
</div>
</div>
<script>${perchHubJs(lang)}</script>`;
}
