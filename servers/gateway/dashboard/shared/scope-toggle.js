/**
 * Scope Toggle Component — renders inline "Apply to: all instances / only this instance"
 * radios for a settings fieldset. Posts to POST /api/settings/scope when changed.
 *
 * Usage (from a settings section render()):
 *   import { renderScopeToggle, scopeToggleScript } from "../../shared/scope-toggle.js";
 *
 *   const scopeHtml = await renderScopeToggle(db, "ai_profiles", { lang });
 *   const scriptTag = scopeToggleScript();
 *
 *   return `${scopeHtml} ... form ...  ${scriptTag}`;
 *
 * The script is idempotent — safe to include once per section.
 */

import { getSettingScope } from "../settings/registry.js";
import { isSyncable } from "../settings/sync-allowlist.js";

const SCRIPT_FLAG = "__crowScopeToggleInstalled";

export async function renderScopeToggle(db, key, { lang = "en", label = null, helperText = null } = {}) {
  if (!isSyncable(key)) {
    // Offer a read-only badge for non-syncable keys so operators understand
    return `<div class="scope-toggle scope-toggle--local-only" style="font-size:0.78rem;color:var(--crow-text-muted);padding:0.5rem 0.75rem;margin-bottom:0.75rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px">
      <strong style="color:var(--crow-text)">Local only.</strong> Setting <code>${escapeAttr(key)}</code> is not in the sync allowlist; it stays on this instance.
    </div>`;
  }

  let scope = "global";
  try { scope = await getSettingScope(db, key); } catch {}
  if (scope === "none") scope = "global"; // sensible default

  const globalChecked = scope === "global" ? "checked" : "";
  const localChecked = scope === "local" ? "checked" : "";
  const titleLabel = label || "Apply to";
  const helper = helperText || "Changes to shared settings replicate to paired Crow peers within ~10 seconds.";

  return `<div class="scope-toggle" data-key="${escapeAttr(key)}" style="font-size:0.82rem;padding:0.5rem 0.75rem;margin-bottom:0.75rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px">
    <span style="color:var(--crow-text-muted);margin-right:0.75rem">${escapeHtml(titleLabel)}:</span>
    <label style="margin-right:1rem;cursor:pointer">
      <input type="radio" name="scope-${escapeAttr(key)}" value="global" ${globalChecked}
        onchange="crowScopeChange(this)"> All instances
    </label>
    <label style="cursor:pointer">
      <input type="radio" name="scope-${escapeAttr(key)}" value="local" ${localChecked}
        onchange="crowScopeChange(this)"> Only this instance
    </label>
    <span class="scope-toggle-status" style="margin-left:0.75rem;font-size:0.75rem;color:var(--crow-text-muted)"></span>
    <div style="font-size:0.72rem;color:var(--crow-text-muted);margin-top:4px">${escapeHtml(helper)}</div>
  </div>`;
}

export function scopeToggleScript() {
  return `<script>
  if (!window.${SCRIPT_FLAG}) {
    window.${SCRIPT_FLAG} = true;
    window.crowScopeChange = async function(radio) {
      var wrapper = radio.closest('.scope-toggle');
      if (!wrapper) return;
      var key = wrapper.getAttribute('data-key');
      var status = wrapper.querySelector('.scope-toggle-status');
      if (status) status.textContent = 'Saving…';
      try {
        var res = await fetch('/api/settings/scope', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key, scope: radio.value }),
        });
        var data = await res.json();
        if (status) {
          if (data.ok) {
            status.textContent = 'Saved (' + data.scope + ')';
            status.style.color = 'var(--crow-success)';
          } else {
            status.textContent = data.error || 'Failed';
            status.style.color = 'var(--crow-error)';
          }
        }
      } catch (e) {
        if (status) { status.textContent = e.message; status.style.color = 'var(--crow-error)'; }
      }
    };
  }
  <\/script>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }
