/**
 * Settings Section: Text size (A11Y-TEXTSIZE, 2026-10-03)
 *
 * The dashboard-wide text size. Per DEVICE, so there is no server state and
 * no POST: the choice lives in localStorage and is applied on <html> by the
 * layout's pre-paint head script (shared/text-size.js). This page only drives
 * that same runtime (window.crowTextSize) — picking a size applies it at once.
 * Perch's A− / A / A+ steps the same preference, so the two never diverge.
 */

import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";
import { TEXT_SIZES, TEXT_SIZE_DEFAULT } from "../../shared/text-size.js";

export default {
  id: "text-size",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 13 4 13 7"/><line x1="8.5" y1="4" x2="8.5" y2="20"/><line x1="6.5" y1="20" x2="10.5" y2="20"/><polyline points="14 13 14 11 21 11 21 13"/><line x1="17.5" y1="11" x2="17.5" y2="20"/><line x1="16" y1="20" x2="19" y2="20"/></svg>`,
  labelKey: "settings.section.textSize",
  navOrder: 15,

  // Per device: the server cannot know this browser's choice, so no preview.
  async getPreview() { return ""; },

  async render({ lang }) {
    // Server renders Default checked; the script below corrects it to this
    // device's stored size before the user can interact (and with scripts
    // blocked the page is honest: nothing is stored, Default is in force).
    const options = TEXT_SIZES.map((s) => `
        <label class="crow-text-size-option" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;min-height:44px;padding:0 0.75rem;border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);font-size:0.95rem">
          <input type="radio" name="crow_text_size" value="${s.id}"${s.id === TEXT_SIZE_DEFAULT ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto">
          ${escapeHtml(t(s.labelKey, lang))}
        </label>`).join("");
    return `<form id="crow-text-size-form" onsubmit="return false">
      <fieldset style="border:0;padding:0;margin:0 0 1rem">
        <legend style="font-size:0.85rem;color:var(--crow-text-secondary);margin-bottom:0.5rem;font-weight:500">${escapeHtml(t("settings.textSize.legend", lang))}</legend>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${options}
        </div>
      </fieldset>
      <p style="margin:0 0 0.75rem;padding:0.75rem 1rem;background:var(--crow-bg-elevated);border-radius:var(--crow-radius-card)">${escapeHtml(t("settings.textSize.sample", lang))}</p>
      <p style="color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(t("settings.textSize.hint", lang))}</p>
    </form>
    <script>
    (function(){
      var form=document.getElementById('crow-text-size-form');
      var TS=window.crowTextSize;
      if(!form||!TS) return;
      function sync(){
        var cur=TS.get(), radios=form.querySelectorAll('input[name="crow_text_size"]');
        for(var i=0;i<radios.length;i++) radios[i].checked=(radios[i].value===cur);
      }
      sync();
      form.addEventListener('change',function(e){
        var r=e.target; if(r&&r.name==='crow_text_size'&&r.checked) TS.set(r.value);
      });
      /* A change from another tab re-applies <html> and fires crow:text-size.
         Turbo keeps window across visits, so bind ONE listener and point it
         at the newest page's sync (no listener per visit). */
      window.__crowTextSizeSettingsSync=function(){ if(document.body.contains(form)) sync(); };
      if(!window.__crowTextSizeSettingsBound){
        window.__crowTextSizeSettingsBound=true;
        window.addEventListener('crow:text-size',function(){ var f=window.__crowTextSizeSettingsSync; if(f) f(); });
      }
    })();
    <\/script>`;
  },

  async handleAction() { return false; },
};
