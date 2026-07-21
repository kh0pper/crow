/**
 * Bot Builder — guided creation wizard (Item 5 PR1, spec §D1).
 *
 * Five server-rendered steps at /dashboard/bot-builder?new=1:
 *   template → basics → model → channel → review
 *
 * State machine (spec §D1): every step renders ONE form that POSTs
 * action="wizard_step" with all previously-collected fields re-emitted as
 * hidden inputs and Back/Next as submit buttons (name="nav"). No DB row
 * exists until the final create. Step forms carry data-turbo="false" —
 * render-on-POST is incompatible with Turbo Drive's must-redirect rule for
 * top-level form submissions (round-2 CRITICAL-A; form-level precedent:
 * panels/contacts/html.js, shared/peer-invite-ui.js). The final create
 * (action="wizard_create", handled PRG in api-handlers.js) redirects 303.
 * A bare GET on ?new=1 always renders step 0 fresh; no GET deep-link into a
 * middle step exists. The wizard introduces NO inline JS — changing the
 * channel type re-renders via an explicit "update fields" submit button
 * (nav="reload") instead of an onchange auto-submit.
 */

import { escapeHtml, section, stepper, button, callout, docsUrl } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t } from "../../shared/i18n.js";
import { loadModelOptions, defaultDefinition, probeAll, loadSkills } from "./data-queries.js";
import {
  renderGatewayFields, normalizeGatewayFields, SIMPLE_GATEWAY_TYPES,
  buildCrowMessagesGatewayConfig,
} from "./gateway-fields.js";
import { BOT_TEMPLATES, getTemplate, applyTemplate, availableMcpSet } from "./templates.js";
import { resolveCrowHome } from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { emitBotDefsChanged } from "./defs-changed.js";
import { engineRequiredFor } from "./engine-gate.js";

export const WIZARD_STEP_KEYS = ["template", "basics", "model", "channel", "review"];

// Channel types offered by the wizard. Simple types render their fields via
// the shared gateway-fields module; device-bound types persist a type-only
// draft record and finish on the Gateways tab (spec §D3). "none" is the
// always-present "skip for now" (spec §D1 step 3).
const WIZARD_GW_TYPES = ["none", "crow-messages", "gmail", "discord", "telegram", "slack", "glasses", "companion"];

// Every field the wizard collects; the carry re-emits these as hidden inputs
// on steps that don't edit them (spec §D1: state lives in the POST body).
const WIZARD_FIELDS = [
  "tpl", "display_name", "custom_bot_id", "bot_id", "model",
  "gw_type", "gw_address", "gw_token", "gw_bot_token", "gw_app_token",
  "gw_guild_id", "gw_channel_ids", "gw_allowlist", "gw_chat_ids",
];

export function wizardStateFromBody(b) {
  const state = {};
  for (const f of WIZARD_FIELDS) {
    const v = (b || {})[f];
    if (typeof v === "string" && v !== "") state[f] = v;
  }
  return state;
}

// Hidden-input value escape: escapeHtml plus explicit newline entities so
// multi-line values (allowlists, channel id lists) survive the attribute
// round-trip byte-for-byte.
function carryEscape(v) {
  return escapeHtml(String(v)).replace(/\r/g, "").replace(/\n/g, "&#10;");
}

function hiddenCarry(state, excludeNames = []) {
  const skip = new Set(excludeNames);
  return WIZARD_FIELDS
    .filter((f) => !skip.has(f) && state[f] != null)
    .map((f) => `<input type="hidden" name="${f}" value="${carryEscape(state[f])}">`)
    .join("");
}

export function slugifyBotId(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Slug + collision suffix (-2, -3, …) against pi_bot_defs (spec §D1 step 1).
 */
export async function uniqueBotId(db, wanted) {
  const base = slugifyBotId(wanted);
  if (!base) return "";
  let candidate = base;
  for (let n = 2; n < 100; n++) {
    let taken = false;
    try {
      taken = !!(await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id=?", args: [candidate] })).rows[0];
    } catch { taken = false; }
    if (!taken) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now() % 100000}`;
}

function navButtons(lang, { backTo, next = true, nextDisabled = false } = {}) {
  const parts = [];
  if (backTo != null) {
    parts.push(button(t("botbuilder.wizBack", lang), { type: "submit", name: "nav", value: "back", variant: "ghost" }));
  }
  if (next) {
    parts.push(button(t("botbuilder.wizNext", lang), {
      type: "submit", name: "nav", value: "next", variant: "primary",
      attrs: nextDisabled ? "disabled" : "",
    }));
  }
  return `<div style="display:flex;gap:var(--crow-space-3);margin-top:var(--crow-space-5);flex-wrap:wrap">${parts.join("")}</div>`;
}

function tplCards(state, lang) {
  const sel = getTemplate(state.tpl) ? state.tpl : BOT_TEMPLATES[0].id;
  return `<div class="btb-wiz-cards">` + BOT_TEMPLATES.map((tp) => {
    const needs = t(`botbuilder.tpl_${tp.id}_needs`, lang);
    return `<label class="btb-wiz-card${tp.id === sel ? " btb-wiz-card-sel" : ""}">` +
      `<input type="radio" name="tpl" value="${escapeHtml(tp.id)}"${tp.id === sel ? " checked" : ""}>` +
      `<span class="btb-wiz-card-title">${t(`botbuilder.tpl_${tp.id}_title`, lang)}</span>` +
      `<span class="btb-wiz-card-desc">${t(`botbuilder.tpl_${tp.id}_desc`, lang)}</span>` +
      (needs ? `<span class="btb-wiz-card-needs">${needs}</span>` : "") +
      `</label>`;
  }).join("") + `</div>`;
}

async function modelSelect(db, state, lang) {
  const { opts, error } = await loadModelOptions(db);
  const byProv = {};
  for (const o of opts) (byProv[o.provider] = byProv[o.provider] || []).push(o);
  const groups = Object.keys(byProv).map((p) =>
    `<optgroup label="${escapeHtml(p)}">` +
    byProv[p].map((m) => `<option value="${escapeHtml(m.key)}"${m.key === state.model ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("") +
    `</optgroup>`).join("");
  const empty = !!error || opts.length === 0;
  // Same honesty contract as the create form (Item 4 PR1): empty ⇒ warn +
  // providers link + Next disabled; never a submittable empty select.
  const warn = empty
    ? `<p class="btb-warn">${escapeHtml(error || t("botbuilder.wizNoModels", lang))} ` +
      `<a href="/dashboard/settings?section=llm&amp;tab=providers">${t("botbuilder.createProvidersLink", lang)}</a></p>`
    : "";
  return {
    empty,
    html: warn + (empty ? "" :
      `<div class="btb-group"><label>${t("botbuilder.wizModelLabel", lang)}</label>` +
      `<select name="model" class="btb-select">${groups}</select></div>` +
      `<p class="btb-hint">${t("botbuilder.wizModelHint", lang)}</p>`),
  };
}

function channelBody(state, lang) {
  const tpl = getTemplate(state.tpl) || BOT_TEMPLATES[0];
  const gwType = WIZARD_GW_TYPES.includes(state.gw_type) ? state.gw_type : tpl.gwType;
  const opts = WIZARD_GW_TYPES.map((v) =>
    `<option value="${v}"${v === gwType ? " selected" : ""}>${t(`botbuilder.wizGw_${v.replace(/-/g, "_")}`, lang)}</option>`).join("");
  let fields = "";
  if (SIMPLE_GATEWAY_TYPES.includes(gwType) && gwType !== "none") {
    const r = renderGatewayFields(gwType, gatewayDraftFromState(state, gwType), lang);
    fields = r.fields + r.hint;
  } else if (gwType === "crow-messages") {
    fields = `<p class="btb-hint">${t("botbuilder.wizGwCrowMessagesNote", lang)}</p>`;
  } else if (gwType === "glasses" || gwType === "companion") {
    fields = `<p class="btb-hint">${t("botbuilder.wizGwFinishLaterNote", lang)}</p>`;
  } else {
    fields = `<p class="btb-hint">${t("botbuilder.wizGwNoneNote", lang)}</p>`;
  }
  return `<div class="btb-group"><label>${t("botbuilder.wizChannelLabel", lang)}</label>` +
    `<select name="gw_type" class="btb-select">${opts}</select> ` +
    button(t("botbuilder.wizUpdateFields", lang), { type: "submit", name: "nav", value: "reload", variant: "ghost", size: "sm" }) +
    `</div>` + fields;
}

// Rehydrate a gateway record from carried wizard fields so renderGatewayFields
// can pre-fill inputs when the user comes Back to the channel step.
function gatewayDraftFromState(state, gwType) {
  const body = {};
  for (const f of WIZARD_FIELDS) if (state[f] != null) body[f] = state[f];
  const arr = normalizeGatewayFields(gwType, body);
  return (arr && arr[0]) || {};
}

async function reviewBody(db, state, lang) {
  const tpl = getTemplate(state.tpl) || BOT_TEMPLATES[0];
  const gwType = WIZARD_GW_TYPES.includes(state.gw_type) ? state.gw_type : tpl.gwType;
  const finishLater = gwType === "glasses" || gwType === "companion";
  const rows = [
    [t("botbuilder.wizReviewTemplate", lang), t(`botbuilder.tpl_${tpl.id}_title`, lang)],
    [t("botbuilder.wizReviewName", lang), escapeHtml(state.display_name || "")],
    [t("botbuilder.wizReviewBotId", lang), `<code>${escapeHtml(state.bot_id || "")}</code>`],
    [t("botbuilder.wizReviewModel", lang), `<code>${escapeHtml(state.model || "")}</code>`],
    [t("botbuilder.wizReviewChannel", lang),
      t(`botbuilder.wizGw_${gwType.replace(/-/g, "_")}`, lang) +
      (finishLater ? ` — ${t("botbuilder.wizGwFinishLaterShort", lang)}` : "")],
  ];
  return `<table class="btb-review-table">` +
    rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("") +
    `</table>` +
    `<p class="btb-hint">${t("botbuilder.wizReviewHint", lang)}</p>`;
}

/**
 * Render the wizard (GET entry or a wizard_step POST). Returns the page via
 * res.send(layout(...)). notice is the panel's standard notice block.
 */
export async function renderWizard(req, res, { db, layout, lang, PAGE_CSS, notice }) {
  const b = req.method === "POST" ? (req.body || {}) : {};
  const state = wizardStateFromBody(b);
  const last = WIZARD_STEP_KEYS.length - 1;

  // GET always starts fresh at step 0 (spec §D1: no GET deep-links).
  let step = 0;
  let error = "";
  if (req.method === "POST" && String(b.action) === "wizard_create" && String(b.nav || "") === "create") {
    // A create POST reaching the RENDER path means handleWizardCreate's
    // server-side re-validation failed and deliberately sent nothing
    // (review MINOR-2: a redirect to ?new=1 would discard everything the
    // user typed). Re-derive the failure and re-render THAT step with the
    // carry intact.
    const { opts } = await loadModelOptions(db);
    if (!(state.display_name || "").trim() || !slugifyBotId(state.bot_id || state.custom_bot_id || state.display_name)) {
      step = WIZARD_STEP_KEYS.indexOf("basics");
      error = t("botbuilder.wizNameRequired", lang);
    } else if (!state.model || !opts.some((o) => o.key === state.model)) {
      step = WIZARD_STEP_KEYS.indexOf("model");
      error = t("botbuilder.createModelInvalid", lang);
    } else {
      // Task 7 follow-up (C4): mirror handleWizardCreate's engine-attach
      // gate so the re-derivation covers every reason it can decline to
      // send. A complete engine-channel record (gmail/discord/telegram/
      // slack) with the bot engine absent bounces back to the channel step,
      // same carry-preserving convention as the name/model checks above.
      const gwTpl = getTemplate(state.tpl) || BOT_TEMPLATES[BOT_TEMPLATES.length - 1];
      const gwType = WIZARD_GW_TYPES.includes(state.gw_type) ? state.gw_type : gwTpl.gwType;
      const gwCandidate = normalizeGatewayFields(gwType, b);
      if (gwCandidate && engineRequiredFor(gwCandidate[0])) {
        step = WIZARD_STEP_KEYS.indexOf("channel");
        error = t("botbuilder.wizEngineRequired", lang);
      } else {
        step = last; // unexpected fall-through: re-render review, state intact
      }
    }
  } else if (req.method === "POST") {
    const posted = Math.min(Math.max(parseInt(b.step, 10) || 0, 0), last);
    const nav = String(b.nav || "next");
    if (nav === "back") {
      step = Math.max(posted - 1, 0);
    } else if (nav === "reload") {
      step = posted;
    } else {
      // next: validate the posted step's own inputs before advancing.
      step = Math.min(posted + 1, last);
      if (posted === 0 && !getTemplate(state.tpl)) {
        state.tpl = BOT_TEMPLATES[0].id;
      }
      if (posted === 1) {
        if (!(state.display_name || "").trim()) {
          step = 1;
          error = t("botbuilder.wizNameRequired", lang);
        } else {
          state.bot_id = await uniqueBotId(db, state.custom_bot_id || state.display_name);
          if (!state.bot_id) { step = 1; error = t("botbuilder.wizNameRequired", lang); }
        }
      }
      if (posted === 2) {
        const { opts } = await loadModelOptions(db);
        if (!state.model || !opts.some((o) => o.key === state.model)) {
          step = 2;
          error = t("botbuilder.createModelInvalid", lang);
        }
      }
    }
  }

  const stem = WIZARD_STEP_KEYS[step];
  let body = "";
  let nextDisabled = false;
  // Fields the CURRENT step edits (excluded from the hidden carry so the
  // visible inputs are the single source for them on this POST).
  let editing = [];

  if (stem === "template") {
    const tutorialHref = docsUrl((lang === "es" ? "es/" : "") + "guide/bot-builder-tutorial");
    body = `<p class="btb-hint">${t("botbuilder.wizTemplateIntro", lang)} ` +
      `<a href="${escapeHtml(tutorialHref)}" target="_blank" rel="noopener">${t("botbuilder.tutorialLink", lang)}</a></p>` +
      tplCards(state, lang);
    editing = ["tpl"];
  } else if (stem === "basics") {
    body =
      `<div class="btb-group"><label>${t("botbuilder.wizNameLabel", lang)}</label>` +
      `<input type="text" name="display_name" class="btb-input" required value="${escapeHtml(state.display_name || "")}" placeholder="${escapeHtml(t("botbuilder.wizNamePlaceholder", lang))}"></div>` +
      `<p class="btb-hint">${t("botbuilder.wizNameHint", lang)}</p>` +
      `<details><summary>${t("botbuilder.wizAdvancedId", lang)}</summary>` +
      `<div class="btb-group"><label>${t("botbuilder.wizCustomIdLabel", lang)}</label>` +
      `<input type="text" name="custom_bot_id" class="btb-input" value="${escapeHtml(state.custom_bot_id || "")}" placeholder="research-scout"></div>` +
      `<p class="btb-hint">${t("botbuilder.wizCustomIdHint", lang)}</p></details>`;
    editing = ["display_name", "custom_bot_id"];
  } else if (stem === "model") {
    const m = await modelSelect(db, state, lang);
    body = m.html;
    nextDisabled = m.empty;
    editing = ["model"];
  } else if (stem === "channel") {
    body = channelBody(state, lang);
    editing = ["gw_type", "gw_address", "gw_token", "gw_bot_token", "gw_app_token", "gw_guild_id", "gw_channel_ids", "gw_allowlist", "gw_chat_ids"];
  } else {
    body = await reviewBody(db, state, lang);
    editing = [];
  }

  const isReview = stem === "review";
  const steps = WIZARD_STEP_KEYS.map((k) => ({ label: t(`botbuilder.wizStep_${k}`, lang) }));
  const errHtml = error ? callout(escapeHtml(error), "error") : "";
  const createBtn = button(t("botbuilder.wizCreate", lang), { type: "submit", name: "nav", value: "create", variant: "primary" });
  const backBtn = button(t("botbuilder.wizBack", lang), { type: "submit", name: "nav", value: "back", variant: "ghost" });
  const nav = isReview
    ? `<div style="display:flex;gap:var(--crow-space-3);margin-top:var(--crow-space-5);flex-wrap:wrap">${backBtn}${createBtn}</div>`
    : navButtons(lang, { backTo: step > 0 ? step - 1 : null, nextDisabled });

  // ONE form per step; data-turbo="false" per spec §D1 (render-on-POST).
  // The review step posts action="wizard_create" (nav=back falls through to
  // a re-render in the panel handler; nav=create is PRG in api-handlers).
  const action = isReview ? "wizard_create" : "wizard_step";
  const form =
    `<form method="POST" class="btb-form" data-turbo="false">` +
    `<input type="hidden" name="action" value="${action}">` +
    `<input type="hidden" name="step" value="${step}">` +
    csrfInput(req) +
    hiddenCarry(state, editing) +
    errHtml + body + nav +
    `</form>`;

  const cancel = `<p style="margin-top:var(--crow-space-4)"><a href="/dashboard/bot-builder">&larr; ${t("botbuilder.wizCancel", lang)}</a></p>`;
  return res.send(layout({
    title: t("botbuilder.wizTitle", lang),
    content: PAGE_CSS + (notice || "") +
      stepper(steps, step) +
      section(t(`botbuilder.wizStep_${stem}`, lang), form) +
      cancel,
  }));
}

/**
 * Final create (action="wizard_create", nav="create") — PRG, called from
 * api-handlers.js. Re-validates everything server-side (never trusts the
 * carry). nav="back" returns WITHOUT sending, so the panel handler falls
 * through to renderWizard, which re-renders the channel step.
 */
export async function handleWizardCreate(req, res, { db, lang }) {
  const b = req.body || {};
  if (String(b.nav || "") === "back") return; // fall through to render

  // Validation failures return WITHOUT sending: the panel handler then falls
  // through to renderWizard, which re-derives the failure and re-renders the
  // failing step with the carry intact (review MINOR-2 — never discard what
  // the user typed).
  const state = wizardStateFromBody(b);
  const display = (state.display_name || "").trim();
  if (!display) return;
  const { opts } = await loadModelOptions(db);
  if (!state.model || !opts.some((o) => o.key === state.model)) return;
  const botId = slugifyBotId(state.bot_id || state.custom_bot_id || display);
  if (!botId) return;

  // Conflict tolerance (spec §D1): the slug was collision-suffixed at the
  // basics step, so an existing id at final POST is practically always a
  // duplicate submit — redirect to that bot with the created notice, never
  // an error banner.
  try {
    const existing = (await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
    if (existing) {
      return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&created=${encodeURIComponent(botId)}`);
    }
  } catch { /* fall through to insert; a real conflict errors there */ }

  const def = defaultDefinition(botId, null, state.model);
  const tpl = getTemplate(state.tpl) || BOT_TEMPLATES[BOT_TEMPLATES.length - 1];

  // Channel: simple types normalize through the shared module; crow-messages
  // gets its minimal host-managed record; device-bound types persist a
  // type-only draft (same W1-4 draft semantics as the Gateways tab — every
  // consumer keys on required fields / device binding, never bare type).
  const gwType = WIZARD_GW_TYPES.includes(state.gw_type) ? state.gw_type : tpl.gwType;
  const simpleGateways = normalizeGatewayFields(gwType, b);

  // Task 7 follow-up (C4): the same server-side attach gate api-handlers.js
  // enforces on the Gateways-tab save must also cover wizard create — the
  // wizard builds a complete engine-channel record through the identical
  // normalizeGatewayFields machinery, so a bot with a working discord/gmail/
  // telegram/slack channel could otherwise get INSERTed while the engine is
  // absent (nothing would ever poll it). Checked before the template
  // overlay/MCP probe below (which can spawn every MCP server) so a reject
  // doesn't pay for work whose result is thrown away. Returns WITHOUT
  // sending, same convention as every other validation failure above
  // (display_name, model) — the panel handler falls through to renderWizard,
  // which re-derives this exact failure and re-renders the channel step with
  // the carry intact.
  if (simpleGateways && engineRequiredFor(simpleGateways[0])) return;

  // Template overlay, filtered against the live probe + skills on THIS
  // install (spec §D2). probeAll() may return {_error} on a fresh install
  // with no canonical mcp.json — availableMcpSet then yields the empty set
  // and all template tool additions drop (parity with plain create). Only
  // probe when the template actually adds tools: probing spawns every MCP
  // server (12s timeout each on a cold cache), and most templates add none.
  let availableMcp = new Set();
  if (((tpl.tools || {}).crow_mcp || []).length) {
    try { availableMcp = availableMcpSet(await probeAll()); } catch { availableMcp = new Set(); }
  }
  let availableSkills = [];
  if ((tpl.skills || []).length) {
    try { availableSkills = loadSkills(resolveCrowHome()); } catch { availableSkills = []; }
  }
  applyTemplate(def, tpl, { availableMcp, availableSkills });

  if (simpleGateways) {
    def.gateways = simpleGateways;
  } else if (gwType === "crow-messages") {
    def.gateways = [buildCrowMessagesGatewayConfig(b)];
  } else if (gwType === "glasses" || gwType === "companion") {
    def.gateways = [{ type: gwType }];
  }

  try {
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,NULL,1)",
      args: [botId, display, JSON.stringify(def)],
    });
  } catch (e) {
    return res.redirectAfterPost("/dashboard/bot-builder?new=1&error=" + encodeURIComponent(String(e.message || e)));
  }
  emitBotDefsChanged(botId);
  return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&created=${encodeURIComponent(botId)}`);
}
