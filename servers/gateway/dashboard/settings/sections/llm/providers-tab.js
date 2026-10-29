/**
 * Providers tab — unified list of local-bundle + cloud providers.
 * - Rows pulled from `listProvidersAll(db)` (same function the legacy
 *   providers section uses).
 * - "Add cloud provider" form: POSTs with provider_type set on the new row.
 * - "Sync bundle providers" button: re-runs syncProvidersFromModelsJson in
 *   manual mode: refreshes ENABLED providers from models.json; never
 *   re-enables a disabled (retired or uninstalled) provider, never adds one.
 * - Disable / enable / test buttons reuse the existing legacy actions.
 * - "Let bots use this provider" (cloud rows only): this box's consent for
 *   the cloud door (servers/shared/cloud-consent.js); off again by itself
 *   when the row's address or key changes.
 *
 * Every POST redirects back to ?section=llm&tab=providers so Turbo Drive
 * keeps the user on this tab.
 */

import { escapeHtml } from "../../../shared/components.js";
import {
  listProvidersAll,
  upsertProvider,
  disableProvider,
  syncProvidersFromModelsJson,
} from "../../../../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../../../../shared/providers.js";
import { KNOWN_PROVIDER_TYPES } from "../../../../../shared/provider-type.js";
import { hostLabel } from "../../../../../shared/provider-host.js";
import { getOwnAddresses } from "../../../../../shared/locality.js";
import { getOrCreateLocalInstanceId } from "../../../../instance-registry.js";
import { isExternalEngine, externalEngineInfo } from "../../../../../shared/provider-engine.js";
import { getProviderHealth } from "../../../../provider-health.js";
import { t, fill } from "../../../shared/i18n.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDefaultCrowHome } from "../../../../../shared/crow-home.js";
import { scanSlots, consumersOfModel, piConfigRefs } from "../../../../../shared/model-consumers.js";
import {
  readCloudConsent, ensureCloudConsentSalt, grantCloudConsent, revokeCloudConsent, consentVerdict, isCloudRow, consentTokenFor,
  cloudDoorIneligibleReason,
} from "../../../../../shared/cloud-consent.js";

const BACK = "?section=llm&tab=providers";

export function hostBadge(p, ctx) {
  const base = `font-size:0.72rem;padding:2px 8px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill)`;
  const { kind, text } = hostLabel(p, ctx);
  const color = kind === "cloud" ? "var(--crow-accent)" : "var(--crow-text-secondary)";
  const suffix = kind === "cloud" && p.provider_type ? ` · ${escapeHtml(p.provider_type)}` : "";
  return `<span class="llm-pill" style="${base};color:${color}" title="stored host: ${escapeHtml(String(p.host ?? ""))}">${escapeHtml(text)}${suffix}</span>`;
}

/** "external · <host>" pill for a row marked gpu_policy.engine.managed = "external"; "" otherwise.
 *  host/label are free text replicated from peers — escaped, never trusted. */
export function engineBadge(p, lang = "en") {
  const info = externalEngineInfo(p);
  if (!info) return "";
  const base = `font-size:0.72rem;padding:2px 8px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);margin-left:4px`;
  const text = fill(t("settings.providers.externalBadge", lang), { host: info.host || "?" });
  return `<span class="llm-pill" style="${base};color:var(--crow-text-secondary)" title="${escapeHtml(info.label || "")}">${escapeHtml(text)}</span>`;
}

/** Status dot. External engines show THIS instance's read-only probe result
 *  (external-engine-poll.js); every other row keeps the enabled/disabled dot. */
export function statusDot(p, { external = {}, lang = "en" } = {}) {
  let color;
  let title;
  if (p.disabled) {
    color = "var(--crow-text-muted)";
    title = "disabled (soft-delete)";
  } else if (!isExternalEngine(p)) {
    color = "var(--crow-success)";
    title = "enabled";
  } else {
    const h = external[p.id];
    if (!h || h.baseUrl !== p.baseUrl) {
      color = "var(--crow-text-muted)";
      title = t("settings.providers.engineUnprobed", lang);
    } else if (h.ready) {
      color = "var(--crow-success)";
      title = t("settings.providers.engineUp", lang);
    } else {
      color = "var(--crow-error)";
      title = t("settings.providers.engineDown", lang);
    }
  }
  const tEsc = escapeHtml(title);
  return `<span aria-label="${tEsc}" title="${tEsc}" style="color:${color};font-size:1.15rem;line-height:1">●</span>`;
}

/** Lowercase host, trailing "/" stripped, "/v1" kept. */
function normBaseUrl(u) {
  const raw = String(u || "").trim();
  try {
    const x = new URL(raw);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname}`.replace(/\/+$/, "");
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

/** ENABLED rows sharing a normalised base URL and key-presence -> Map<id, other ids>. Display only. */
export function duplicateClusters(providers) {
  const groups = new Map();
  for (const p of providers) {
    if (p.disabled) continue;
    const k = `${normBaseUrl(p.baseUrl)}|${p.apiKey ? 1 : 0}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(p.id);
  }
  const out = new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out.set(id, ids.filter((x) => x !== id));
  }
  return out;
}

/**
 * The "Let bots use this provider" switch for an enabled cloud row; "" otherwise.
 * A cloud row the cloud door would never serve gets a disabled switch and the
 * reason (cloudDoorIneligibleReason).
 * Turning it on sends back an opaque token for the address and key this page
 * showed (never the key or its fingerprint), so a row rewritten between the
 * render and the click is refused, not consented.
 */
export function botsSwitch(p, { consent, salt, lang = "en" }) {
  if (p.disabled || !isCloudRow(p)) return "";
  if (!salt) {
    // No salt (it could not be created): nothing can be checked or granted now.
    return `<div class="llm-bots-switch">
            <button type="button" role="switch" aria-checked="false" disabled><span class="llm-bots-track" aria-hidden="true"></span>${escapeHtml(t("providers.botsMayUse", lang))}</button>
            <div class="llm-bots-unavailable">${escapeHtml(t("providers.botsUnavailable", lang))}</div>
          </div>`;
  }
  const on = consentVerdict(p, Object.hasOwn(consent, p.id) ? consent[p.id] : null, { salt }) === "ok";
  const label = escapeHtml(t("providers.botsMayUse", lang));
  // A cloud row the door would never serve (cloud-consent.js, the one rule):
  // no switch that turns on, a plain reason instead. A leftover consent can
  // still be turned off.
  const why = cloudDoorIneligibleReason(p);
  if (why) {
    const reason = `<div class="llm-bots-unavailable">${escapeHtml(t(`providers.botsIneligible.${why}`, lang))}</div>`;
    if (on) {
      return `<form method="post" class="llm-bots-switch">
            <input type="hidden" name="action" value="llm_provider_bots_deny">
            <input type="hidden" name="id" value="${escapeHtml(p.id)}">
            <button type="submit" role="switch" aria-checked="true"><span class="llm-bots-track" aria-hidden="true"></span>${label}</button>
            ${reason}
          </form>`;
    }
    return `<div class="llm-bots-switch">
            <button type="button" role="switch" aria-checked="false" disabled><span class="llm-bots-track" aria-hidden="true"></span>${label}</button>
            ${reason}
          </div>`;
  }
  const token = !on ? `
            <input type="hidden" name="consent_token" value="${escapeHtml(consentTokenFor(p, salt))}">` : "";
  return `<form method="post" class="llm-bots-switch">
            <input type="hidden" name="action" value="${on ? "llm_provider_bots_deny" : "llm_provider_bots_allow"}">
            <input type="hidden" name="id" value="${escapeHtml(p.id)}">${token}
            <button type="submit" role="switch" aria-checked="${on ? "true" : "false"}"><span class="llm-bots-track" aria-hidden="true"></span>${label}</button>
          </form>`;
}

const HIDDEN_PROVIDERS = new Set(["crow-hf-token"]);
const USED_BY_MAX = 4;

/** pi's agent dir only when this instance owns the host-default home; else null. */
function defaultPiAgentDir() {
  try { return isDefaultCrowHome() ? join(homedir(), ".pi", "agent") : null; } catch { return null; }
}

const slotLabel = (s, lang) => (s.labelKey ? fill(t(s.labelKey, lang), s.labelParams || {}) : s.label);

function usedByCell(p, { slots, piRefs, scanned, scanOk, lang }) {
  const label = escapeHtml(t("settings.providers.usedBy", lang));
  if (!scanOk) return `<td class="llm-cell-usedby" data-label="${label}" style="color:var(--crow-text-muted)">—</td>`;
  const seen = new Set();
  const labels = [];
  const add = (l) => { if (l && !seen.has(l)) { seen.add(l); labels.push(l); } };
  for (const m of p.models || []) {
    if (!m?.id) continue;
    for (const s of consumersOfModel(slots, `${p.id}/${m.id}`)) add(slotLabel(s, lang));
  }
  for (const s of slots) if (s.providerOnly && s.value === p.id) add(slotLabel(s, lang));
  for (const r of piRefs[p.id] || []) add(slotLabel(r, lang));
  const hint = scanned ? "" : `<div style="font-size:0.7rem;color:var(--crow-text-muted)">${escapeHtml(t("settings.providers.piNotScanned", lang))}</div>`;
  if (!labels.length) {
    return `<td class="llm-cell-usedby" data-label="${label}"><span style="color:var(--crow-text-muted)">${escapeHtml(t("settings.providers.unused", lang))}</span>${hint}</td>`;
  }
  const shown = labels.slice(0, USED_BY_MAX).map(escapeHtml).join(", ");
  const more = labels.length > USED_BY_MAX ? ` <span style="color:var(--crow-text-muted)">${escapeHtml(fill(t("settings.providers.more", lang), { n: labels.length - USED_BY_MAX }))}</span>` : "";
  return `<td class="llm-cell-usedby" data-label="${label}" title="${escapeHtml(labels.join("\n"))}">${shown}${more}${hint}</td>`;
}

export default {
  /** piAgentDir / tasksDbPaths are test seams; production passes neither. */
  async render({ req, db, lang = "en", piAgentDir, tasksDbPaths }) {
    const all = await listProvidersAll(db);
    const providers = all.filter((p) => !HIDDEN_PROVIDERS.has(p.id));
    const dups = duplicateClusters(providers);
    const piDir = piAgentDir === undefined ? defaultPiAgentDir() : piAgentDir;
    let slots = [], piRefs = {}, scanOk = true;
    try {
      // Unattended detection is for the role-change warning, not this list.
      const scan = await scanSlots(db, { includeSubagents: false, piAgentDir: piDir, tasksDbPaths, withUnattended: false });
      scanOk = !scan.incomplete;
      slots = scan.filter((s) => !s.dead);
      piRefs = piConfigRefs(piDir);
    } catch { scanOk = false; }
    const usedCtx = { slots, piRefs, scanned: !!piDir, scanOk, lang };
    const external = getProviderHealth().external;
    let instanceNames = new Map();
    try {
      const { rows } = await db.execute("SELECT id, name FROM crow_instances");
      instanceNames = new Map(rows.map((r) => [r.id, r.name]));
    } catch {}
    let ownInstanceId = null;
    try { ownInstanceId = getOrCreateLocalInstanceId(); } catch {}
    const hostCtx = { ownAddrs: getOwnAddresses(), ownInstanceId, instanceNames };
    let salt = null;
    try { salt = await ensureCloudConsentSalt(db); } catch (err) { console.warn(`[llm-providers-tab] consent salt: ${err.message}`); }
    const consentCtx = { consent: await readCloudConsent(db), salt, lang };
    const botsNote = req?.query?.bots === "changed"
      ? `<p class="llm-bots-changed" role="status">${escapeHtml(t("providers.botsChanged", lang))}</p>`
      : "";
    const buildRow = (p) => {
      const models = (p.models || []).map((m) => escapeHtml(m.id || "?")).join(", ") || "—";
      const idEsc = escapeHtml(p.id);
      const dupOf = dups.get(p.id);
      const dupAttr = dupOf ? ` data-dup-of="${escapeHtml(dupOf.join(","))}"` : "";
      const dupBadge = dupOf
        ? ` <span class="llm-pill" style="font-size:0.7rem;padding:1px 7px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-secondary)">${escapeHtml(fill(t("settings.providers.sameService", lang), { ids: dupOf.join(", ") }))}</span>`
        : "";
      return `<tr class="${p.disabled ? "llm-row-disabled" : ""}"${dupAttr}>
        <td class="llm-cell-status">${statusDot(p, { external, lang })}</td>
        <td class="llm-cell-id">${idEsc}${dupBadge}</td>
        <td class="llm-cell-host">${hostBadge(p, hostCtx)}${engineBadge(p, lang)}${botsSwitch(p, consentCtx)}</td>
        <td class="llm-cell-endpoint" data-label="${escapeHtml(t("settings.providers.endpoint", lang))}">${escapeHtml(p.baseUrl || "—")}</td>
        <td class="llm-cell-models" data-label="${escapeHtml(t("settings.providers.models", lang))}" title="${escapeHtml(models)}">${models}</td>
        ${usedByCell(p, usedCtx)}
        <td class="llm-cell-actions">
          <form method="post" style="display:inline">
            <input type="hidden" name="action" value="${p.disabled ? "llm_provider_enable" : "llm_provider_disable"}">
            <input type="hidden" name="id" value="${idEsc}">
            <button class="btn btn-secondary btn-xs" type="submit">${p.disabled ? "Enable" : "Disable"}</button>
          </form>
        </td>
      </tr>`;
    };
    const active = providers.filter((p) => !p.disabled);
    const retired = providers.filter((p) => p.disabled);
    const rows = active.map(buildRow).join("");
    const head = `<thead><tr><th></th><th>ID</th><th>Host</th><th>${escapeHtml(t("settings.providers.endpoint", lang))}</th><th>${escapeHtml(t("settings.providers.models", lang))}</th><th>${escapeHtml(t("settings.providers.usedBy", lang))}</th><th></th></tr></thead>`;
    const retiredBlock = retired.length
      ? `<details data-show-retired style="margin-top:1rem">
      <summary class="llm-details-summary">${escapeHtml(fill(t("settings.providers.showRetired", lang), { n: retired.length }))}</summary>
      <div class="llm-card"><div class="table-scroll"><table class="llm-providers-table">${head}<tbody>${retired.map(buildRow).join("")}</tbody></table></div></div>
    </details>`
      : "";

    const typeOptions = KNOWN_PROVIDER_TYPES
      .map((t) => `<option value="${t}">${t}</option>`)
      .join("");

    return `<style>
      .llm-providers-table { width:100%; border-collapse:collapse; font-size:0.875rem; }
      .llm-providers-table thead tr { background:var(--crow-bg-elevated); }
      .llm-providers-table th {
        text-align:left; padding:10px 12px;
        color:var(--crow-text-muted);
        font-weight:500; font-size:0.72rem;
        letter-spacing:0.06em; text-transform:uppercase;
        border-bottom:1px solid var(--crow-border);
      }
      .llm-providers-table tbody tr { border-bottom:1px solid var(--crow-border); }
      .llm-providers-table tbody tr:last-child { border-bottom:none; }
      .llm-providers-table td { padding:10px 12px; vertical-align:middle; }
      .llm-row-disabled { opacity:0.6; }
      .llm-cell-status { width:24px; padding-left:12px !important; padding-right:0 !important; }
      .llm-cell-id { font-family:'JetBrains Mono',monospace; font-size:0.85rem; color:var(--crow-text-primary); white-space:nowrap; }
      .llm-cell-endpoint { font-family:'JetBrains Mono',monospace; font-size:0.78rem; color:var(--crow-text-muted); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .llm-cell-models { color:var(--crow-text-secondary); max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .llm-cell-actions { text-align:right; white-space:nowrap; width:1%; }
      .llm-pill { white-space:nowrap; }
      /* Phone: each provider is a compact two-column card (dot | id, badges,
         endpoint, models, used by) with its action on the first line; the
         head row is kept for screen readers only, each detail line carries its
         own label, and long ids and badges wrap instead of widening the list. */
      @media (max-width: 720px) {
        .llm-providers-table, .llm-providers-table tbody { display:block; width:100%; }
        .llm-providers-table thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
        .llm-providers-table tbody tr { display:grid; grid-template-columns:16px minmax(0,1fr) auto; column-gap:8px; row-gap:4px; align-items:center; padding:10px 12px; }
        .llm-providers-table td { display:block; min-width:0; max-width:none; padding:0 !important; }
        .llm-providers-table td[colspan] { grid-column:1 / -1; padding:1rem 0 !important; }
        .llm-cell-status { grid-column:1; grid-row:1; width:auto; }
        .llm-cell-id { grid-column:2; grid-row:1; white-space:normal; overflow-wrap:anywhere; font-size:0.8rem; line-height:1.35; }
        .llm-cell-actions { grid-column:3; grid-row:1; width:auto; }
        .llm-cell-host, .llm-cell-endpoint, .llm-cell-models, .llm-cell-usedby { grid-column:2 / 4; font-size:0.78rem; }
        .llm-cell-endpoint, .llm-cell-models { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .llm-providers-table td[data-label]::before { content:attr(data-label) ": "; color:var(--crow-text-muted); font-family:var(--crow-body-font, inherit); }
        .llm-pill { display:inline-block; max-width:100%; white-space:normal; overflow-wrap:anywhere; vertical-align:middle; }
        .llm-cell-id .llm-pill { margin-top:2px; }
      }
      .llm-bots-switch { margin-top:6px; }
      .llm-bots-changed { margin:0 0 0.85rem; padding:0.6rem 0.8rem; border-left:3px solid var(--crow-error); background:var(--crow-bg-elevated); border-radius:4px; font-size:0.85rem; }
      .llm-bots-switch button {
        display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:0 4px;
        background:none; border:none; cursor:pointer; color:var(--crow-text-secondary); font:inherit; font-size:0.78rem; text-align:left;
      }
      .llm-bots-track { position:relative; flex:none; width:30px; height:18px; border-radius:9px; background:var(--crow-border); }
      .llm-bots-track::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:var(--crow-bg-surface); }
      .llm-bots-switch button[aria-checked="true"] .llm-bots-track { background:var(--crow-accent); }
      .llm-bots-switch button[aria-checked="true"] .llm-bots-track::after { left:14px; }
      .llm-bots-switch button[disabled] { cursor:not-allowed; opacity:0.6; }
      .llm-bots-unavailable { font-size:0.75rem; color:var(--crow-text-muted); }
      .llm-bots-switch button:focus-visible { outline:2px solid var(--crow-accent); outline-offset:2px; }
      .btn-xs { padding:3px 10px; font-size:0.75rem; border-radius:var(--crow-radius-control); }
      .llm-card {
        border:1px solid var(--crow-border);
        border-radius:var(--crow-radius-card);
        background:var(--crow-bg-surface);
        overflow:hidden;
      }
      .llm-toolbar {
        display:flex; justify-content:space-between; align-items:center;
        margin-bottom:0.75rem; gap:0.75rem;
      }
      .llm-add-form { margin-top:1rem; padding:1.25rem; background:var(--crow-bg-elevated); border:1px solid var(--crow-border); border-radius:var(--crow-radius-card); }
      .llm-add-form .llm-field { margin-bottom:0.65rem; }
      .llm-add-form label { display:block; font-size:0.75rem; color:var(--crow-text-muted); margin-bottom:4px; letter-spacing:0.03em; }
      .llm-add-form input, .llm-add-form select {
        width:100%; padding:0.5rem 0.65rem;
        background:var(--crow-bg-surface);
        border:1px solid var(--crow-border);
        border-radius:6px;
        color:var(--crow-text-primary);
        box-sizing:border-box;
        font-size:0.85rem;
      }
      .llm-add-form input:focus, .llm-add-form select:focus {
        outline:none; border-color:var(--crow-accent);
        box-shadow:0 0 0 2px var(--crow-accent-muted);
      }
      .llm-sync-note {
        display:inline-flex; align-items:center; gap:0.35rem;
        padding:0.55rem 0.75rem;
        background:var(--crow-accent-muted);
        color:var(--crow-text-primary);
        border-radius:var(--crow-radius-pill);
        font-size:0.78rem;
        border:1px solid var(--crow-border);
      }
      .llm-details-summary {
        cursor:pointer;
        font-size:0.9rem;
        font-weight:500;
        padding:0.5rem 0.75rem;
        border-radius:6px;
        list-style:none;
      }
      .llm-details-summary::-webkit-details-marker { display:none; }
      .llm-details-summary::before { content:"+ "; color:var(--crow-accent); font-weight:600; }
      details[open] > .llm-details-summary::before { content:"− "; }
      details[open] > .llm-details-summary { background:var(--crow-bg-elevated); }
    </style>

    ${botsNote}
    <p class="llm-section-hint">
      ${escapeHtml(fill(t(active.length === 1 ? "settings.providers.enabledOne" : "settings.providers.enabledN", lang), { n: active.length }))} ${escapeHtml(t("settings.providers.introTail", lang))}
    </p>

    <div class="llm-toolbar">
      <div></div>
      <form method="post">
        <input type="hidden" name="action" value="llm_provider_sync">
        <button class="btn btn-secondary btn-sm" type="submit" title="${escapeHtml(t("settings.providers.syncHint", lang))}">${escapeHtml(t("settings.providers.syncButton", lang))}</button>
      </form>
    </div>

    <div class="llm-card">
      <div class="table-scroll"><table class="llm-providers-table">
        ${head}
        <tbody>${rows || `<tr><td colspan="7" style="padding:1.25rem;text-align:center;color:var(--crow-text-muted)">${escapeHtml(t(retired.length ? "settings.providers.noneEnabled" : "settings.providers.noneRegistered", lang))}</td></tr>`}</tbody>
      </table></div>
    </div>
    ${retiredBlock}

    <details style="margin-top:1.25rem">
      <summary class="llm-details-summary">Add cloud provider</summary>
      <form method="post" class="llm-add-form">
        <input type="hidden" name="action" value="llm_provider_add">
        <div style="font-size:0.78rem;color:var(--crow-text-muted);margin-bottom:0.85rem;padding:0.55rem 0.75rem;background:var(--crow-bg-surface);border-left:3px solid var(--crow-brand-gold);border-radius:4px">
          <strong style="color:var(--crow-text-secondary)">Note:</strong> this API key will sync to your paired Crow instances (local-lab threat model). A per-row local-only toggle is planned for v2.
        </div>
        <div class="llm-field">
          <label>Provider ID <span style="color:var(--crow-text-muted);font-weight:normal">— lowercase, used in dropdowns</span></label>
          <input type="text" name="id" required pattern="[a-z][a-z0-9-]*" placeholder="cloud-openai-main" style="font-family:'JetBrains Mono',monospace">
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:0.75rem">
          <div class="llm-field">
            <label>Type</label>
            <select name="provider_type">${typeOptions}</select>
          </div>
          <div class="llm-field">
            <label>Base URL</label>
            <input type="text" name="base_url" required placeholder="https://api.openai.com/v1" style="font-family:'JetBrains Mono',monospace">
          </div>
        </div>
        <div class="llm-field">
          <label>API key</label>
          <input type="password" name="api_key" autocomplete="off" placeholder="sk-…">
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:0.75rem">
          <div class="llm-field">
            <label>Default model</label>
            <input type="text" name="model_id" placeholder="gpt-4o-mini" style="font-family:'JetBrains Mono',monospace">
          </div>
          <div class="llm-field">
            <label>Description <span style="color:var(--crow-text-muted);font-weight:normal">— optional</span></label>
            <input type="text" name="description" placeholder="e.g. GPT-4o for research">
          </div>
        </div>
        <div style="margin-top:0.75rem">
          <button type="submit" class="btn btn-primary btn-sm">Add provider</button>
        </div>
      </form>
    </details>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "llm_provider_add") {
      const { id, provider_type, base_url, api_key, model_id, description } = req.body;
      if (!id || !base_url) {
        res.status(400).type("text/plain").send("id and base_url required");
        return true;
      }
      await upsertProvider(db, {
        id,
        baseUrl: base_url,
        apiKey: api_key || null,
        host: "cloud",
        bundleId: null,
        description: description || null,
        models: model_id ? [{ id: model_id }] : [],
        disabled: false,
        providerType: provider_type || null,
      });
      invalidateProvidersCache();
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_disable") {
      await disableProvider(db, req.body.id);
      invalidateProvidersCache();
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_enable") {
      const all = await listProvidersAll(db);
      const row = all.find((p) => p.id === req.body.id);
      if (row) {
        await upsertProvider(db, { ...row, disabled: false });
        invalidateProvidersCache();
      }
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_bots_allow" || action === "llm_provider_bots_deny") {
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      if (id) {
        if (action === "llm_provider_bots_allow") {
          const user = typeof req.dashboardUser === "string" && req.dashboardUser ? req.dashboardUser : "owner";
          const consentToken = typeof req.body?.consent_token === "string" ? req.body.consent_token : "";
          const r = await grantCloudConsent(db, id, { actor: `dashboard:${user}`, expect: { consentToken } });
          if (r.ok) console.log(`[llm-providers-tab] bots may use ${id} (dashboard:${user})`);
          else if (r.reason === "changed") { res.redirectAfterPost(`${BACK}&bots=changed`); return true; }
        } else {
          await revokeCloudConsent(db, id);
          console.log(`[llm-providers-tab] bots may no longer use ${id}`);
        }
      }
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_sync") {
      // Manual mode: refreshes enabled providers only. Never turns a disabled
      // (retired or uninstalled) provider back on and never adds a row.
      // (force:true used to resurrect every retired model in models.json.)
      const result = await syncProvidersFromModelsJson(db, { manual: true });
      console.log(`[llm-providers-tab] manual sync upserted=${result.upserted} skipped_disabled=${result.skipped_disabled} skipped_absent=${result.skipped_absent}`);
      invalidateProvidersCache();
      res.redirectAfterPost(BACK);
      return true;
    }
    return false;
  },
};
