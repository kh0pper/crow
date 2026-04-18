/**
 * Profiles tab — unifies the chat / TTS / STT / vision profile editors
 * behind a single subtab switcher. The underlying section modules
 * (ai-profiles, tts-profiles, stt-profiles, vision-profiles) are
 * imported here rather than re-registered in the main Settings menu
 * — that way the LLM section presents the single "AI Profiles" UX the
 * consolidation plan targets while keeping the existing sections'
 * render + handleAction logic as the source of truth. When a POST
 * reaches llm.handleAction we delegate down this chain in order; each
 * profile section's action handler is namespaced by a distinct `action`
 * value (save_ai_profile, save_tts_profile, etc.) so there's no
 * ambiguity over who handles what.
 *
 * All four profile sections respond with res.json(...), not redirects,
 * so there's no URL rewriting to do — existing client-side fetch +
 * reload flows keep working unchanged under the new URL.
 */

import { escapeHtml } from "../../../shared/components.js";
import { readSetting, upsertSetting } from "../../registry.js";
import aiProfilesSection from "../ai-profiles.js";
import ttsProfilesSection from "../tts-profiles.js";
import sttProfilesSection from "../stt-profiles.js";
import visionProfilesSection from "../vision-profiles.js";

const SUBTABS = [
  { id: "chat",   label: "Chat",   section: aiProfilesSection },
  { id: "tts",    label: "TTS",    section: ttsProfilesSection },
  { id: "stt",    label: "STT",    section: sttProfilesSection },
  { id: "vision", label: "Vision", section: visionProfilesSection },
];

function resolveSubtab(req) {
  const id = (req?.query?.subtab || "chat").toLowerCase();
  return SUBTABS.find((s) => s.id === id) || SUBTABS[0];
}

async function readFeatureFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function renderFeatureFlagsBanner(flags) {
  const smartOn = flags?.smart_chat === true;
  // NOT in SYNC_ALLOWLIST by design — feature flags stay local so a
  // paired instance can't flip each other's experimental features on.
  return `<div class="llm-ff-banner">
    <div class="llm-ff-head">
      <span class="llm-ff-title">Experimental</span>
      <span class="llm-ff-hint">Local-only flags; never replicated to paired instances.</span>
    </div>
    <form method="post" class="llm-ff-form">
      <input type="hidden" name="action" value="toggle_feature_flag">
      <input type="hidden" name="flag" value="smart_chat">
      <input type="hidden" name="value" value="${smartOn ? "off" : "on"}">
      <label class="llm-ff-toggle">
        <input type="checkbox" ${smartOn ? "checked" : ""} onchange="this.form.submit()">
        <span class="llm-ff-label">Smart Chat (auto-routing profiles)</span>
      </label>
      <span class="llm-ff-sub">Enables <code>kind: "auto"</code> profiles below. Routes each message to code / vision / fast / deep / default providers based on slash-commands, image attachments, or keywords. Server-side gate — non-UI clients can't route.</span>
    </form>
  </div>
  <style>
    .llm-ff-banner { border:1px solid var(--crow-border); background:var(--crow-bg-surface); border-radius:var(--crow-radius-card); padding:0.7rem 1rem; margin-bottom:1rem; }
    .llm-ff-head { display:flex; align-items:baseline; gap:0.7rem; margin-bottom:0.3rem; }
    .llm-ff-title { font-family:'JetBrains Mono',monospace; font-size:0.78rem; color:var(--crow-brand-gold); letter-spacing:0.04em; text-transform:uppercase; }
    .llm-ff-hint { font-size:0.72rem; color:var(--crow-text-muted); }
    .llm-ff-form { display:flex; flex-direction:column; gap:0.3rem; }
    .llm-ff-toggle { display:flex; align-items:center; gap:0.5rem; cursor:pointer; }
    .llm-ff-toggle input[type="checkbox"] { margin:0; }
    .llm-ff-label { font-size:0.88rem; color:var(--crow-text-primary); font-weight:500; }
    .llm-ff-sub { font-size:0.78rem; color:var(--crow-text-secondary); line-height:1.45; }
    .llm-ff-sub code { background:var(--crow-bg-elevated); padding:1px 5px; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:0.75rem; }
  </style>`;
}

export default {
  async render({ req, db, lang }) {
    const active = resolveSubtab(req);
    const tabs = SUBTABS.map((s) => {
      const isActive = s.id === active.id;
      const style = `padding:0.4rem 0.8rem;display:inline-block;text-decoration:none;font-size:0.82rem;border-bottom:2px solid ${isActive ? "var(--crow-accent)" : "transparent"};color:${isActive ? "var(--crow-text-primary)" : "var(--crow-text-secondary)"};font-weight:${isActive ? "600" : "normal"};margin-bottom:-1px`;
      return `<a href="?section=llm&tab=profiles&subtab=${s.id}" data-turbo-frame="_top" style="${style}">${escapeHtml(s.label)}</a>`;
    }).join("");

    const innerBody = await active.section.render({ req, db, lang });
    const flags = await readFeatureFlags(db);
    // Flag banner only appears on the Chat subtab — it's what the flag
    // actually gates. TTS/STT/Vision tabs stay uncluttered.
    const banner = active.id === "chat" ? renderFeatureFlagsBanner(flags) : "";

    return `
      ${banner}
      <nav style="display:flex;gap:0.25rem;border-bottom:1px solid var(--crow-border);margin-bottom:1rem;padding-left:0.25rem">
        ${tabs}
      </nav>
      <div class="llm-profiles-body">${innerBody}</div>
    `;
  },

  async handleAction({ req, res, db, action }) {
    // Feature-flag toggle (applies to any Profiles subtab).
    if (action === "toggle_feature_flag") {
      const { flag, value } = req.body || {};
      if (!flag || typeof flag !== "string") {
        res.status(400).type("text/plain").send("flag required");
        return true;
      }
      const flags = await readFeatureFlags(db);
      flags[flag] = value === "on" || value === "true";
      await upsertSetting(db, "feature_flags", JSON.stringify(flags));
      res.redirectAfterPost("?section=llm&tab=profiles&subtab=chat");
      return true;
    }

    // Delegate to each wrapped section's action handler in turn. Each
    // section's actions have distinct names (save_ai_profile,
    // save_tts_profile, etc.) so the first match wins cleanly.
    for (const { section } of SUBTABS) {
      if (typeof section.handleAction !== "function") continue;
      const handled = await section.handleAction({ req, res, db, action });
      if (handled) return true;
    }
    return false;
  },
};
