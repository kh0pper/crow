/**
 * Profiles tab — compact read-only summary of each profile type
 * (chat / tts / stt / vision) with inline counts and links into the
 * legacy sections where full CRUD still lives.
 *
 * v1 scope: the legacy sections (ai-profiles, tts-profiles, stt-profiles,
 * vision-profiles) handle create/edit/delete today; wiring equivalent
 * forms into the llm section is phase 6's UI polish work. This tab is
 * therefore a nav hub, not a full editor — but it DOES read profile
 * shape from dashboard_settings so migrations show up immediately.
 */

import { escapeHtml } from "../../../shared/components.js";

async function readJson(db, key) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
    if (!rows[0]?.value) return [];
    const v = JSON.parse(rows[0].value);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function profileBadge(p) {
  if (p?.provider_id) {
    return `<span style="font-size:0.7rem;padding:1px 6px;background:var(--crow-bg-deep);border-radius:3px;color:var(--crow-accent)">pointer → ${escapeHtml(p.provider_id)}${p.model_id ? " · " + escapeHtml(p.model_id) : ""}</span>`;
  }
  if (p?.baseUrl) {
    return `<span style="font-size:0.7rem;padding:1px 6px;background:var(--crow-bg-deep);border-radius:3px;color:var(--crow-text-muted)">direct</span>`;
  }
  return "";
}

function profileRow(p) {
  return `<li style="padding:4px 0;border-bottom:1px solid var(--crow-border)">
    <span style="font-weight:500">${escapeHtml(p.name || p.id || "(unnamed)")}</span>
    ${profileBadge(p)}
  </li>`;
}

function block(title, section, profiles) {
  const rows = profiles.length
    ? `<ul style="list-style:none;padding:0;margin:0">${profiles.map(profileRow).join("")}</ul>`
    : `<div style="font-size:0.8rem;color:var(--crow-text-muted);padding:0.5rem 0">No profiles yet.</div>`;
  return `
    <div style="flex:1;min-width:260px;padding:0.75rem;background:var(--crow-bg-deep);border-radius:4px;margin-right:0.75rem;margin-bottom:0.75rem">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5rem">
        <h3 style="margin:0;font-size:0.9rem">${escapeHtml(title)}</h3>
        <a href="?section=${escapeHtml(section)}" style="font-size:0.75rem;color:var(--crow-accent)">Manage →</a>
      </div>
      ${rows}
    </div>
  `;
}

export default {
  async render({ db }) {
    const [chat, tts, stt, vision] = await Promise.all([
      readJson(db, "ai_profiles"),
      readJson(db, "tts_profiles"),
      readJson(db, "stt_profiles"),
      readJson(db, "vision_profiles"),
    ]);

    return `
      <div style="margin-bottom:0.75rem;font-size:0.85rem;color:var(--crow-text-muted)">
        Profile summaries — the "pointer" badge indicates a profile resolves via the providers DB table (preferred). "direct" profiles carry their own baseUrl + apiKey (legacy; migration rewrites them on startup).
      </div>
      <div style="display:flex;flex-wrap:wrap">
        ${block("Chat profiles", "ai-profiles", chat)}
        ${block("TTS profiles", "tts-profiles", tts)}
        ${block("STT profiles", "stt-profiles", stt)}
        ${block("Vision profiles", "vision-profiles", vision)}
      </div>
    `;
  },

  async handleAction() {
    // v1: no write actions; delegate to legacy sections via the "Manage →" links.
    return false;
  },
};
