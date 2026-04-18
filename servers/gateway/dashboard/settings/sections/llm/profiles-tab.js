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

export default {
  async render({ req, db, lang }) {
    const active = resolveSubtab(req);
    const tabs = SUBTABS.map((s) => {
      const isActive = s.id === active.id;
      const style = `padding:0.4rem 0.8rem;display:inline-block;text-decoration:none;font-size:0.82rem;border-bottom:2px solid ${isActive ? "var(--crow-accent)" : "transparent"};color:${isActive ? "var(--crow-text-primary)" : "var(--crow-text-secondary)"};font-weight:${isActive ? "600" : "normal"};margin-bottom:-1px`;
      return `<a href="?section=llm&tab=profiles&subtab=${s.id}" data-turbo-frame="_top" style="${style}">${escapeHtml(s.label)}</a>`;
    }).join("");

    const innerBody = await active.section.render({ req, db, lang });

    return `
      <nav style="display:flex;gap:0.25rem;border-bottom:1px solid var(--crow-border);margin-bottom:1rem;padding-left:0.25rem">
        ${tabs}
      </nav>
      <div class="llm-profiles-body">${innerBody}</div>
    `;
  },

  async handleAction({ req, res, db, action }) {
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
