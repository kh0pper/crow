/**
 * Settings Section: New Crow (redesign P2, Task 2.4)
 *
 * A classic device's way into the new three-tab shell: a "Use the new Crow"
 * form that POSTs /dashboard/mode (mode=new). The mode is per device (a
 * cookie), so there is no server state to preview. Going back is in the new
 * shell's avatar sheet.
 */

import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";

export default {
  id: "crow-mode",
  group: "appearance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></svg>`,
  labelKey: "settings.section.crowMode",
  navOrder: 12,

  async getPreview() { return ""; },

  async render({ lang }) {
    const fill = "var f=this.querySelector('input[name=_csrf]');var m=document.cookie.match(/(?:^|;\\s*)crow_csrf=([^;]*)/);if(f&&m)f.value=decodeURIComponent(m[1]);";
    return `<p style="color:var(--crow-text-secondary);font-size:0.9rem;margin:0 0 1rem">${escapeHtml(t("shell.tryBody", lang))}</p>
    <form method="post" action="/dashboard/mode" onsubmit="${escapeHtml(fill)}"><input type="hidden" name="_csrf" value=""><input type="hidden" name="mode" value="new"><button type="submit" class="btn btn-primary" style="min-height:44px">${escapeHtml(t("shell.useNew", lang))}</button></form>`;
  },
};
