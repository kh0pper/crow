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

/** The whole page. Static shell only — every list row and transcript line is
 *  rendered client-side, the same split birdDrawerMarkup() uses. */
export function perchHubDocument(lang = "en", engine = { state: "ready" }) {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(t("perch.title", lang))}</title>
<style>${perchHubCss()}</style>
</head>
<body data-view="list">
${engineBanner(engine, lang)}
<header><div class="brand">Perch<small>${escapeHtml(t("perch.subtitle", lang))}</small></div>
<nav class="machines"><a href="/dashboard/bot-board">${escapeHtml(t("perch.navBoard", lang))}</a></nav></header>
<div class="hub-split">
  <div id="perch-list">
    <h2>${escapeHtml(t("perch.sessionsHeading", lang))}</h2>
    <div id="perch-list-body"><div class="empty">${escapeHtml(t("perch.loading", lang))}</div></div>
  </div>
  <div id="perch-chat">
    <button type="button" id="perch-back" class="quiet">${escapeHtml(t("perch.back", lang))}</button>
    <div class="perch-head"><div><div class="title" id="perch-bot-name"></div>
      <div class="meta" id="perch-session-meta"></div></div>
      <div class="state" id="perch-state"></div></div>
    <div id="perch-transcript"></div>
    <div id="perch-ask"></div>
    <div id="perch-composer">
      <textarea id="perch-input" placeholder="${escapeHtml(t("perch.composerPlaceholder", lang))}"></textarea>
      <div class="send-row">
        <button type="button" class="primary" id="perch-send">${escapeHtml(t("perch.send", lang))}</button>
        <button type="button" id="perch-abort" style="display:none">${escapeHtml(t("perch.abort", lang))}</button>
      </div>
    </div>
  </div>
</div>
<script>${perchHubJs(lang)}</script>
</body></html>`;
}
