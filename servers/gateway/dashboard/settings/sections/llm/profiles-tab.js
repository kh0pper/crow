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
  const base = `font-size:0.68rem;padding:1px 8px;border-radius:var(--crow-radius-pill);letter-spacing:0.02em;font-family:'JetBrains Mono',monospace`;
  if (p?.provider_id) {
    const label = `→ ${escapeHtml(p.provider_id)}${p.model_id ? " · " + escapeHtml(p.model_id) : ""}`;
    return `<span style="${base};background:var(--crow-accent-muted);color:var(--crow-accent)" title="${label}">pointer</span>`;
  }
  if (p?.baseUrl) {
    return `<span style="${base};background:var(--crow-bg-elevated);color:var(--crow-text-muted);border:1px solid var(--crow-border)">direct</span>`;
  }
  return "";
}

function profileRow(p) {
  return `<li class="llm-profile-row">
    <span class="llm-profile-name">${escapeHtml(p.name || p.id || "(unnamed)")}</span>
    ${profileBadge(p)}
  </li>`;
}

function block(title, section, profiles) {
  const body = profiles.length
    ? `<ul class="llm-profile-list">${profiles.map(profileRow).join("")}</ul>`
    : `<div class="llm-profile-empty">No profiles yet.</div>`;
  return `
    <section class="llm-profile-block">
      <header class="llm-profile-header">
        <h3>${escapeHtml(title)}</h3>
        <a href="?section=${escapeHtml(section)}" class="llm-profile-link">Manage &rsaquo;</a>
      </header>
      ${body}
    </section>
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

    return `<style>
      .llm-profile-grid {
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
        gap:0.85rem;
      }
      .llm-profile-block {
        border:1px solid var(--crow-border);
        border-radius:var(--crow-radius-card);
        background:var(--crow-bg-surface);
        padding:0.85rem 1rem;
      }
      .llm-profile-header {
        display:flex; justify-content:space-between; align-items:baseline;
        margin-bottom:0.65rem;
        padding-bottom:0.45rem;
        border-bottom:1px solid var(--crow-border);
      }
      .llm-profile-header h3 { margin:0; font-size:0.88rem; color:var(--crow-text-primary); }
      .llm-profile-link { font-size:0.75rem; color:var(--crow-accent); text-decoration:none; }
      .llm-profile-link:hover { text-decoration:underline; }
      .llm-profile-list { list-style:none; padding:0; margin:0; }
      .llm-profile-row {
        display:flex; justify-content:space-between; align-items:center; gap:0.5rem;
        padding:0.35rem 0;
        border-bottom:1px dashed var(--crow-border);
      }
      .llm-profile-row:last-child { border-bottom:none; }
      .llm-profile-name { font-size:0.85rem; color:var(--crow-text-primary); font-weight:500; }
      .llm-profile-empty { font-size:0.8rem; color:var(--crow-text-muted); padding:0.3rem 0; }
    </style>

    <p class="llm-section-hint">
      Profile summaries — the <strong>pointer</strong> badge means the profile resolves via the providers DB (preferred). <strong>direct</strong> profiles carry their own <code>baseUrl</code> + <code>apiKey</code> (legacy; migration rewrites them on startup). Full editors live on the legacy per-type sections for now — polish merges them here in a follow-up.
    </p>
    <div class="llm-profile-grid">
      ${block("Chat profiles", "ai-profiles", chat)}
      ${block("TTS profiles", "tts-profiles", tts)}
      ${block("STT profiles", "stt-profiles", stt)}
      ${block("Vision profiles", "vision-profiles", vision)}
    </div>`;
  },

  async handleAction() {
    // v1: no write actions; delegate to legacy sections via the "Manage →" links.
    return false;
  },
};
