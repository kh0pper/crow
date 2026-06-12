/**
 * Bot Builder Panel — Editor
 *
 * Renders the tabbed single-bot editor (?bot=<id>&tab=<tab>).
 * Inline <script> fragments are frozen content — only the 4 tJs() calls
 * already in the sessions tab use i18n; all other inline JS stays EN.
 */
import { escapeHtml, section, badge, formField, actionBar } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";
import { createDbClient } from "../../../../db.js";
import { serversForBot } from "../../../../../scripts/pi-bots/mcp_writer.mjs";
import {
  MULTI_AGENT_CAPABLE,
  isMultiAgentCapable,
} from "../../../../../scripts/pi-bots/pi_extensions_allowlist.mjs";
import { resolveModel } from "../../../../../scripts/pi-bots/model_resolver.mjs";
import {
  resolveCrowHome,
  listInstalledExtensions,
  extensionSkills,
} from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { skillDirs } from "../../../../../scripts/pi-bots/skill_resolver.mjs";
import { listProposals } from "../../../../../scripts/pi-bots/skill_proposals.mjs";
import { listBotSkillEvents } from "../../../../../scripts/pi-bots/skill_provenance.mjs";
import { getTtsProfiles } from "../../../ai/tts/index.js";
import { getSttProfiles } from "../../../ai/stt/index.js";
import { readSetting } from "../../settings/registry.js";
import {
  TASKS_DB, PI_BUILTIN, PI_EXT_ALLOWLIST, TABS,
  probeAll, probeExtensions, loadVisionProfiles, gatherPeerTools, remoteInvocationOn,
  loadModelOptions, loadSkills,
} from "./data-queries.js";

// Tab id → i18n key map
const TAB_KEYS = {
  ai:          "botbuilder.tabAi",
  tools:       "botbuilder.tabTools",
  gateways:    "botbuilder.tabGateways",
  tracker:     "botbuilder.tabTracker",
  skills:      "botbuilder.tabSkills",
  permissions: "botbuilder.tabPermissions",
  triggers:    "botbuilder.tabTriggers",
  sessions:    "botbuilder.tabSessions",
  review:      "botbuilder.tabReview",
};

export async function renderBotEditor(req, res, { db, layout, lang, PAGE_CSS, botId, notice, q }) {
  let bot;
  try {
    bot = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
  } catch { bot = null; }
  if (!bot) return res.send(layout({
    title: "Bot Builder",
    content: PAGE_CSS + section("Bot Builder",
      `<p>${t("botbuilder.noticeUnknownBot", lang)}</p><p><a href="/dashboard/bot-builder">&larr; ${t("botbuilder.noticeAllBots", lang)}</a></p>`),
  }));
  let def; try { def = JSON.parse(bot.definition || "{}"); } catch { def = {}; }
  // M3b: column is authoritative — overwrite any stale JSON copy of project_id.
  def.project_id = bot.project_id == null ? null : Number(bot.project_id);
  const tabId = TABS.find((tb) => tb[0] === (q.tab || "ai")) ? String(q.tab || "ai") : "ai";

  const nav = `<div class="btb-tabs">` +
    TABS.map(([id, lbl]) =>
      `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${id}" ` +
      `class="btb-tab${id === tabId ? " btb-tab-active" : ""}">${escapeHtml(t(TAB_KEYS[id] || "", lang) || lbl)}</a>`
    ).join("") +
    `</div>`;

  const hidden = (tb) => `<input type="hidden" name="action" value="save_${tb}"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">`;
  let body = "";

  if (tabId === "ai") {
    // Provider->model picker, grouped by provider via <optgroup> (the
    // server-rendered "cascading" shape — no client JS, Phase-2.3 style).
    const { opts: mOpts, error: mErr } = await loadModelOptions(db);
    const byProv = {};
    for (const o of mOpts) (byProv[o.provider] = byProv[o.provider] || []).push(o);
    const optGroups = (sel) =>
      Object.keys(byProv)
        .map(
          (p) =>
            `<optgroup label="${escapeHtml(p)}">` +
            byProv[p]
              .map((m) => `<option value="${escapeHtml(m.key)}"${m.key === sel ? " selected" : ""}>${escapeHtml(m.label)}</option>`)
              .join("") +
            `</optgroup>`
        )
        .join("");
    const mErrHtml = mErr ? `<p class="btb-warn">${escapeHtml(mErr)}</p>` : "";
    // A6: reference Settings plumbing. Voice profiles come from Settings ->
    // LLM (dashboard_settings); read-only here — the actual per-device bind
    // happens in the glasses gateway tab (Slice B B4).
    const [ttsProfiles, sttProfiles, visionProfiles] = await Promise.all([
      getTtsProfiles(db).catch(() => []),
      getSttProfiles(db).catch(() => []),
      loadVisionProfiles(db),
    ]);
    const profileSelect = (name, profiles) =>
      `<select name="${name}" class="btb-select" disabled>` +
      `<option value="">&mdash; platform default &mdash;</option>` +
      profiles
        .map((p) => `<option value="${escapeHtml(String(p.id))}">${escapeHtml(p.name || String(p.id))}</option>`)
        .join("") +
      `</select>`;
    body =
      `<form method="POST" class="btb-form">${hidden("ai")}` +
      mErrHtml +
      `<div class="btb-group"><label>${t("botbuilder.labelDefaultModel", lang)}</label>` +
      `<select name="model_default" class="btb-select">${optGroups((def.models || {}).default)}</select></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelEscalationModel", lang)}</label>` +
      `<select name="model_escalation" class="btb-select"><option value="">&mdash; none &mdash;</option>${optGroups((def.models || {}).escalation)}</select></div>` +
      `<p class="btb-hint">Escalation only applies when an inbound message contains the <code>!escalate</code> token (operator-driven, per-turn). Otherwise the bot always runs on its Default model. The token is stripped before the model sees the message.</p>` +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><label>${t("botbuilder.labelFastVoiceModel", lang)}</label>` +
      `<select name="fast_voice_model" class="btb-select"><option value="">&mdash; (use Default model) &mdash;</option>${optGroups(def.fast_voice_model)}</select></div>` +
      `<p class="btb-hint">Stored as a <code>provider_id/model_id</code> key. Drives the fast glasses voice turn when this bot is bound to a device (Slice B); resolved via <code>resolve-profile.js</code>.</p>` +
      `<div class="btb-group"><label>${t("botbuilder.labelVoiceProfiles", lang)}</label>` +
      `<p class="btb-hint">STT/TTS/Vision plumbing from Settings &rarr; LLM. Bound per device in the glasses gateway (Slice B) — shown here so a bot's voice stack is visible while building.</p>` +
      `<div class="btb-checkbox-group">` +
      `<label>STT&nbsp;${profileSelect("stt_profile_ref", sttProfiles)}</label>` +
      `<label>TTS&nbsp;${profileSelect("tts_profile_ref", ttsProfiles)}</label>` +
      `<label>Vision&nbsp;${profileSelect("vision_profile_ref", visionProfiles)}</label>` +
      `</div></div>` +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveAi", lang)}</button>`) + `</form>`;
  } else if (tabId === "tools") {
    const probe = await probeAll();
    const selBuiltin = new Set((def.tools && def.tools.pi_builtin) || []);
    const selMcp = new Set((def.tools && def.tools.crow_mcp) || []);
    const selExt = new Set((def.tools && def.tools.pi_extensions) || []);
    const builtinBoxes = `<div class="btb-checkbox-group">` +
      PI_BUILTIN.map((tb) =>
        `<label class="btb-checkbox"><input type="checkbox" name="builtin_${tb}"${selBuiltin.has(tb) ? " checked" : ""}> ${tb}</label>`
      ).join("") + `</div>`;
    let mcpHtml = "";
    if (probe._error) {
      mcpHtml = `<p class="btb-err">MCP probe unavailable: ${escapeHtml(probe._error)}</p>`;
    } else {
      for (const srv of Object.keys(probe)) {
        const p = probe[srv];
        if (!p.ok) {
          mcpHtml += `<p class="btb-mcp-section"><b>${escapeHtml(srv)}</b> <span class="btb-err">(probe failed: ${escapeHtml(String(p.error || "").slice(0, 80))})</span></p>`;
          continue;
        }
        mcpHtml += `<p class="btb-mcp-section"><b>${escapeHtml(srv)}</b> <span class="btb-mcp-count">(${p.tools.length} tools)</span></p>`;
        mcpHtml += `<div class="btb-mcp-grid">` + p.tools.map((tb) => {
          const v = `${srv}/${tb.name}`;
          const warn = tb.hasPattern ? ` <span title="schema has a pattern/regex — pi tolerates it (S4), operator awareness only" class="btb-mcp-regex">&#9888; regex</span>` : "";
          return `<label class="btb-mcp-tool"><input type="checkbox" name="crow_mcp" value="${escapeHtml(v)}"${selMcp.has(v) ? " checked" : ""}> ${escapeHtml(tb.name)}${warn}</label>`;
        }).join("") + `</div>`;
      }
    }
    // A6: installed extensions (addon servers absent from canonical) folded
    // in as their own group with an install-state badge. Checkboxes share
    // the `crow_mcp` field (value = serverId/tool) so the save handler and
    // A5 minting key on the addon id identically.
    const extProbes = await probeExtensions(resolveCrowHome());
    let extToolsHtml = "";
    if (extProbes.length) {
      extToolsHtml += `<hr class="btb-divider"><div class="btb-group"><label>Extensions</label>` +
        `<p class="btb-hint">Add-on MCP servers (mcp-addons.json) minted into this bot's <code>.mcp.json</code>. Work under pi (Slice A); voice availability is mapped in Slice B.</p>`;
      for (const { ext, probe } of extProbes) {
        const cap = ext.capabilities ? `, ${escapeHtml(ext.group)}` : "";
        const badge = `<span class="btb-mcp-count">[installed: addon${cap}]</span>`;
        if (!probe.ok) {
          extToolsHtml += `<p class="btb-mcp-section"><b>${escapeHtml(ext.id)}</b> ${badge} <span class="btb-err">(probe failed: ${escapeHtml(String(probe.error || "").slice(0, 80))})</span></p>`;
          continue;
        }
        extToolsHtml += `<p class="btb-mcp-section"><b>${escapeHtml(ext.id)}</b> <span class="btb-mcp-count">(${probe.tools.length} tools)</span> ${badge}</p>`;
        extToolsHtml += `<div class="btb-mcp-grid">` + probe.tools.map((tb) => {
          const v = `${ext.id}/${tb.name}`;
          const warn = tb.hasPattern ? ` <span title="schema has a pattern/regex — pi tolerates it (S4), operator awareness only" class="btb-mcp-regex">&#9888; regex</span>` : "";
          return `<label class="btb-mcp-tool"><input type="checkbox" name="crow_mcp" value="${escapeHtml(v)}"${selMcp.has(v) ? " checked" : ""}> ${escapeHtml(tb.label || tb.name)}${warn}</label>`;
        }).join("") + `</div>`;
      }
      extToolsHtml += `</div>`;
    }
    const extBoxes = `<div class="btb-checkbox-group">` +
      PI_EXT_ALLOWLIST.map((e) =>
        `<label class="btb-checkbox"><input type="checkbox" name="ext_${e}"${selExt.has(e) ? " checked" : ""}> ${e}</label>`
      ).join("") + `</div>`;
    // R13 (Phase 3.2): non-blocking SOFT-WARN for `subagent` (Phase-2.3 /
    // S4 pattern — never fail-closed in the UI; the pi-lab gate is the
    // hard runtime backstop). Selecting it here does nothing unless the
    // bot's resolved model is MULTI_AGENT_CAPABLE AND Permissions →
    // Multi-agent is on.
    const subWarn = PI_EXT_ALLOWLIST.includes("subagent")
      ? `<p class="btb-warn">&#9888; <code>subagent</code> is runtime-blocked unless this bot's resolved model is in MULTI_AGENT_CAPABLE <em>and</em> Permissions &rarr; Multi-agent is on. Capable models: <code>${escapeHtml(MULTI_AGENT_CAPABLE.join(", "))}</code>.</p>`
      : "";
    const peerTools = await gatherPeerTools(db);
    const remoteOn = await remoteInvocationOn(db);
    // De-dup to one row per (instance, capability).
    const seenRemote = new Set();
    const remoteCaps = [];
    for (const tb of peerTools) {
      const key = `${tb.instanceId}::${tb.canonicalId}`;
      if (!tb.canonicalId || seenRemote.has(key)) continue;
      seenRemote.add(key);
      remoteCaps.push(tb);
    }
    const selectedRemote = new Set((def.tools && def.tools.remote_mcp) || []);
    const peerToolsHtml = remoteCaps.length === 0 ? "" :
      `<details class="btb-remote-caps"><summary>Peer instance capabilities (${new Set(remoteCaps.map((tb) => tb.instanceId)).size}) &#9656;</summary>` +
      (remoteOn
        ? `<p class="btb-hint">Exposed peer capabilities are selectable. The peer enforces what's allowed (F4a Layer 2a).</p>`
        : `<p class="btb-hint">Read-only — enable <strong>Settings &rarr; Remote Tool Invocation</strong> to wire these into a bot.</p>`) +
      `<ul style="list-style:none;padding-left:0">` + remoteCaps.map((tb) => {
        const key = `${tb.instanceId}::${tb.canonicalId}`;
        const selectable = remoteOn && tb.exposed === true;
        const checked = selectedRemote.has(key) ? " checked" : "";
        const label = `${escapeHtml(tb.name)} <span class="btb-muted">(${escapeHtml(tb.category)} · ${escapeHtml(tb.instanceName)})</span>`;
        if (selectable) {
          return `<li><label><input type="checkbox" name="remote_mcp" value="${escapeHtml(key)}"${checked}> ${label}</label></li>`;
        }
        const why = remoteOn ? "not exposed by that instance" : "invocation disabled";
        return `<li><label style="opacity:.55"><input type="checkbox" disabled> ${label} <span class="btb-muted">— ${why}</span></label></li>`;
      }).join("") + `</ul></details>`;
    body =
      `<form method="POST" class="btb-form">${hidden("tools")}` +
      `<div class="btb-group"><label>${t("botbuilder.labelPiBuiltin", lang)}</label>${builtinBoxes}</div>` +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><label>${t("botbuilder.labelCrowMcpTools", lang)}</label>` +
      `<p class="btb-hint">Live tools/list; &#9888; regex = non-blocking soft-warn, S4</p>${mcpHtml}</div>` +
      extToolsHtml +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><label>${t("botbuilder.labelPiExtensions", lang)}</label>` +
      `<p class="btb-hint">Curated allowlist only; others need install-approval</p>${extBoxes}${subWarn}</div>` +
      peerToolsHtml +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveTools", lang)}</button>`) + `</form>`;
  } else if (tabId === "gateways") {
    const gw = (def.gateways && def.gateways[0]) || {};
    const gwType = gw.type || "gmail";
    const gwTypes = [
      { value: "gmail", label: "Gmail", available: true },
      { value: "discord", label: "Discord", available: true },
      { value: "telegram", label: "Telegram", available: true },
      { value: "slack", label: "Slack", available: true },
      { value: "glasses", label: "Meta Glasses", available: true },
      { value: "companion", label: "AI Companion (kiosk)", available: true },
      { value: "crow-messages", label: "Crow Messages", available: false },
      { value: "signal", label: "Signal", available: false },
      { value: "none", label: "None (no gateway)", available: true },
    ];
    const typeOpts = gwTypes.map((tb) =>
      `<option value="${tb.value}"${gwType === tb.value ? " selected" : ""}>${escapeHtml(tb.label)}${tb.available ? "" : " — coming soon"}</option>`
    ).join("");
    // Server-rendered, type-aware fields. Changing the type auto-submits so
    // the form re-renders with the right fields for that gateway (any
    // not-yet-filled values save empty — a harmless draft until completed).
    let gwFields, gwHint;
    if (gwType === "discord") {
      gwFields =
        `<div class="btb-group"><label>Bot token</label>` +
        `<input type="password" name="gw_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.token || "")}"></div>` +
        formField("Guild ID (optional)", "gw_guild_id", { value: gw.guild_id || "" }) +
        `<div class="btb-group"><label>Channel IDs (one per line, optional — blank = any channel)</label>` +
        `<textarea name="gw_channel_ids" rows="3" class="btb-textarea">${escapeHtml((gw.channel_ids || []).join("\n"))}</textarea></div>` +
        `<div class="btb-group"><label>Allowlist — Discord user IDs (one per line)</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>`;
      gwHint = `<p class="btb-hint">Discord runs via the long-lived <code>pibot-discord.service</code> (discord_gateway.mjs holds a WebSocket per bot). The <code>MessageContent</code> privileged intent must be enabled in the Discord Developer Portal. After changing token/guild/channel config, restart the service: <code>sudo systemctl restart pibot-discord</code>.</p>`;
    } else if (gwType === "telegram") {
      gwFields =
        `<div class="btb-group"><label>Bot token (from @BotFather)</label>` +
        `<input type="password" name="gw_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.token || "")}"></div>` +
        `<div class="btb-group"><label>Allowlist — Telegram user IDs (one per line, blank = anyone)</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>` +
        `<div class="btb-group"><label>Restrict to chat IDs (one per line, optional)</label>` +
        `<textarea name="gw_chat_ids" rows="3" class="btb-textarea">${escapeHtml((gw.chat_ids || []).join("\n"))}</textarea></div>`;
      gwHint = `<p class="btb-hint">Telegram runs via the long-lived <code>pibot-gateways.service</code> (gateways/telegram.mjs, long-poll — dials out, no inbound port). After changing config, restart: <code>sudo systemctl restart pibot-gateways</code>.</p>`;
    } else if (gwType === "slack") {
      gwFields =
        `<div class="btb-group"><label>Bot token (xoxb-…)</label>` +
        `<input type="password" name="gw_bot_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.bot_token || "")}"></div>` +
        `<div class="btb-group"><label>App-level token (xapp-…, connections:write)</label>` +
        `<input type="password" name="gw_app_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.app_token || "")}"></div>` +
        `<div class="btb-group"><label>Allowlist — Slack user IDs (one per line, blank = anyone)</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>` +
        `<div class="btb-group"><label>Restrict to channel IDs (one per line, optional)</label>` +
        `<textarea name="gw_channel_ids" rows="3" class="btb-textarea">${escapeHtml((gw.channel_ids || []).join("\n"))}</textarea></div>`;
      gwHint = `<p class="btb-hint">Slack runs via the long-lived <code>pibot-gateways.service</code> (gateways/slack.mjs, Socket Mode — dials out, no inbound port). Needs Socket Mode enabled + an app-level token with <code>connections:write</code>. After changing config, restart: <code>sudo systemctl restart pibot-gateways</code>.</p>`;
    } else if (gwType === "glasses") {
      // Slice B (B4): bind this bot to a paired meta-glasses device. Saving
      // sets the device's bound_bot_id (the voice turn reads it) + the voice
      // plumbing (STT/TTS/Vision), and mirrors {device_id, fast_voice_model}
      // onto the gateway record.
      let devices = [];
      try {
        const { listDevices } = await import("../../../../../bundles/meta-glasses/server/device-store.js");
        devices = await listDevices(db).catch(() => []);
      } catch { devices = []; }
      const selDev = devices.find((d) => String(d.id) === String(gw.device_id || "")) || null;
      const devOpts = `<option value="">&mdash; select a paired device &mdash;</option>` +
        devices.map((d) => {
          const boundElse = d.bound_bot_id && d.bound_bot_id !== botId ? ` — bound to ${escapeHtml(d.bound_bot_id)}` : "";
          return `<option value="${escapeHtml(String(d.id))}"${String(d.id) === String(gw.device_id || "") ? " selected" : ""}>${escapeHtml(d.name || String(d.id))}${boundElse}</option>`;
        }).join("");

      // fast_voice_model picker (provider/model optgroups, same as the AI tab).
      let fvmOpts = "";
      try {
        const { opts: mOpts } = await loadModelOptions(db);
        const byProv = {};
        for (const o of mOpts) (byProv[o.provider] = byProv[o.provider] || []).push(o);
        const cur = gw.fast_voice_model || def.fast_voice_model || "";
        fvmOpts = `<option value="">&mdash; (use the bot's AI-tab Fast voice model) &mdash;</option>` +
          Object.keys(byProv).map((p) =>
            `<optgroup label="${escapeHtml(p)}">` +
            byProv[p].map((m) => `<option value="${escapeHtml(m.key)}"${m.key === cur ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("") +
            `</optgroup>`).join("");
      } catch { fvmOpts = `<option value="">&mdash; (use the bot's AI-tab Fast voice model) &mdash;</option>`; }

      // Editable STT/TTS/Vision selects, pre-filled from the selected device.
      const [ttsP, sttP, visionP] = await Promise.all([
        getTtsProfiles(db).catch(() => []),
        getSttProfiles(db).catch(() => []),
        loadVisionProfiles(db),
      ]);
      const profileSel = (name, profiles, selId) =>
        `<select name="${name}" class="btb-select"><option value="">&mdash; device / platform default &mdash;</option>` +
        profiles.map((p) => `<option value="${escapeHtml(String(p.id))}"${String(p.id) === String(selId || "") ? " selected" : ""}>${escapeHtml(p.name || String(p.id))}</option>`).join("") +
        `</select>`;

      // Q3: warn about selected tools with no voice equivalent (omitted from
      // the voice tool set rather than advertised as unrunnable).
      let noVoiceWarn = "";
      try {
        const { voiceUnavailableSelections } = await import("../../../ai/tool-executor.js");
        const unavailable = voiceUnavailableSelections(def);
        if (unavailable.length) {
          noVoiceWarn =
            `<p class="btb-notice-warn">These selected tools have no voice equivalent and will NOT be available when driving this bot by voice (they still work under the pi runtime): ` +
            `<code>${unavailable.map(escapeHtml).join("</code>, <code>")}</code>.</p>`;
        }
      } catch { /* tool-executor unavailable: skip the warning */ }

      gwFields =
        `<div class="btb-group"><label>Paired device</label>` +
        `<select name="gw_device_id" class="btb-select">${devOpts}</select></div>` +
        (devices.length ? "" : `<p class="btb-hint">No paired glasses devices yet. Pair one in the Meta Glasses panel first.</p>`) +
        `<div class="btb-group"><label>Fast voice model (overrides the AI tab for this binding)</label>` +
        `<select name="gw_fast_voice_model" class="btb-select">${fvmOpts}</select></div>` +
        `<div class="btb-group"><label>Voice plumbing (bound to the device)</label>` +
        `<div class="btb-checkbox-group">` +
        `<label>STT&nbsp;${profileSel("gw_stt_profile_id", sttP, selDev && selDev.stt_profile_id)}</label>` +
        `<label>TTS&nbsp;${profileSel("gw_tts_profile_id", ttsP, selDev && selDev.tts_profile_id)}</label>` +
        `<label>Vision&nbsp;${profileSel("gw_vision_profile_id", visionP, selDev && selDev.vision_profile_id)}</label>` +
        `</div></div>` +
        noVoiceWarn;
      gwHint = `<p class="btb-hint">Saving binds the device (<code>bound_bot_id</code>) so the meta-glasses fast voice turn runs THIS bot's persona, skills, scoped tools, and permissions. One bot &harr; one device; re-binding unbinds the prior device. No gateway restart needed — the voice turn reads the binding live (30s cache).</p>`;
    } else if (gwType === "companion") {
      // Bind this bot to a companion kiosk device (tablet/room). Reuses the
      // glasses device-store; the device is tagged device_kind:"companion".
      // The companion_features here drive the kiosk UI (avatar/voice/social).
      // The fast->escalate model pair is global (the model proxy), so it's NOT
      // configured per device here — see the AI tab / docs/architecture/companion.md.
      let devices = [];
      try {
        const { listDevices } = await import("../../../../../bundles/meta-glasses/server/device-store.js");
        // Any paired device can be bound as a companion kiosk; binding tags it
        // device_kind:"companion". Show all so a fresh device can be claimed.
        devices = await listDevices(db).catch(() => []);
      } catch { devices = []; }
      const devOpts = `<option value="">&mdash; select a paired device &mdash;</option>` +
        devices.map((d) => {
          const boundElse = d.bound_bot_id && d.bound_bot_id !== botId ? ` — bound to ${escapeHtml(d.bound_bot_id)}` : "";
          const kind = (d.device_kind || "glasses") === "companion" ? "" : " [glasses]";
          return `<option value="${escapeHtml(String(d.id))}"${String(d.id) === String(gw.device_id || "") ? " selected" : ""}>${escapeHtml(d.name || String(d.id))}${kind}${boundElse}</option>`;
        }).join("");
      const cf = def.companion_features || {};
      const chk = (v) => (v ? " checked" : "");
      const hs = cf.hearing_style || "push_to_talk";
      const hsOpt = (v, l) => `<option value="${v}"${hs === v ? " selected" : ""}>${l}</option>`;
      gwFields =
        `<div class="btb-group"><label>Paired kiosk device</label>` +
        `<select name="gw_device_id" class="btb-select">${devOpts}</select></div>` +
        (devices.length ? "" : `<p class="btb-hint">No paired devices yet. Pair a kiosk/companion device first (Meta Glasses panel pairs devices; kiosks reuse that store).</p>`) +
        `<div class="btb-group"><label>Avatar (Live2D model name, blank = bot/default)</label>` +
        `<input type="text" name="gw_avatar_model" class="btb-input" value="${escapeHtml(cf.avatar_model || "")}"></div>` +
        `<div class="btb-group"><label>Hearing style</label>` +
        `<select name="gw_hearing_style" class="btb-select">${hsOpt("push_to_talk", "Push to talk")}${hsOpt("wake_word", "Wake word")}${hsOpt("always_listening", "Always listening")}</select></div>` +
        `<div class="btb-group"><label>Voice idle timeout (seconds before pet/idle)</label>` +
        `<input type="number" name="gw_voice_idle_timeout" class="btb-input" value="${escapeHtml(String(cf.voice_idle_timeout ?? 30))}"></div>` +
        `<div class="btb-group"><label>Features</label><div class="btb-checkbox-group">` +
        `<label><input type="checkbox" name="gw_avatar_animation"${chk(cf.avatar_animation)}> Avatar animation / lip-sync</label>` +
        `<label><input type="checkbox" name="gw_pet_mode"${chk(cf.pet_mode)}> Pet / idle animation</label>` +
        `<label><input type="checkbox" name="gw_social_chat"${chk(cf.social_chat)}> Social / chatroom &amp; DM features</label>` +
        `<label><input type="checkbox" name="gw_memory_integration"${chk(cf.memory_integration)}> Auto memory integration</label>` +
        `</div></div>`;
      gwHint = `<p class="btb-hint">Saving binds the device (<code>bound_bot_id</code>, <code>device_kind:companion</code>) so this kiosk shows THIS bot's persona/avatar and the feature toggles above. The fast&rarr;escalate model pair is global to the companion container (the model proxy). Changing avatar/persona takes effect on the next kiosk session; toggles apply live. See <code>docs/guide/kiosk-mode.md</code>.</p>`;
    } else if (gwType === "none") {
      gwFields = "";
      gwHint = `<p class="btb-hint">No gateway — this bot is driven only by direct injection / cards, not inbound messages.</p>`;
    } else {
      gwFields =
        formField("Gmail address (+alias)", "gw_address", { value: gw.address || "" }) +
        `<div class="btb-group"><label>Allowlist (one address per line)</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>`;
      gwHint = `<p class="btb-hint">Gmail polls <code>to:&lt;+alias&gt;@maestro.press</code> via bridge_tick.mjs (pibot-bridge.timer, ~1 min).</p>`;
    }
    body =
      `<form method="POST" class="btb-form">${hidden("gateways")}` +
      `<div class="btb-group"><label>${t("botbuilder.labelGatewayType", lang)}</label>` +
      `<select name="gw_type" class="btb-select" onchange="this.form.submit()">${typeOpts}</select></div>` +
      gwFields + gwHint +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveGateways", lang)}</button>`) + `</form>`;
  } else if (tabId === "tracker") {
    let projects = [];
    try { projects = (await db.execute({ sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows; } catch {}
    const projOpts = projects.map((p) => `<option value="${p.id}"${Number(def.project_id) === Number(p.id) ? " selected" : ""}>#${p.id} &mdash; ${escapeHtml(p.name || "")} (${escapeHtml(p.slug || "")})</option>`).join("");
    // Tracker defs for custom tracker dropdown
    let trackerDefs = [];
    try { trackerDefs = (await db.execute({ sql: "SELECT id, slug, display_name FROM tracker_defs ORDER BY slug", args: [] })).rows; } catch {}
    const tc = def.tracker_config || {};
    const ttype = tc.type || "kanban";
    const ttSel = (v) => ttype === v ? " selected" : "";
    const trackerOpts = trackerDefs.map((td) =>
      `<option value="${escapeHtml(td.slug)}"${tc.tracker_slug === td.slug ? " selected" : ""}>${escapeHtml(td.display_name)} (${escapeHtml(td.slug)})</option>`
    ).join("");
    const cfFields = Array.isArray(tc.context_fields) ? tc.context_fields.join(", ") : "";
    const qfKey = tc.queue_filter ? Object.keys(tc.queue_filter)[0] || "" : "";
    const qfVal = tc.queue_filter && qfKey ? tc.queue_filter[qfKey] || "" : "";
    let snap = "";
    const pid = def.project_id;
    const boardHref = "/dashboard/bot-board?bot=" + encodeURIComponent(botId);
    if (pid != null && pid !== "" && (ttype === "kanban" || ttype === "task-list")) {
      let tdb;
      try {
        tdb = createDbClient(TASKS_DB);
        const rows = (await tdb.execute({
          sql: "SELECT status, COUNT(*) AS n FROM tasks_items WHERE project_id=? GROUP BY status",
          args: [Number(pid)],
        })).rows || [];
        const c = { pending: 0, in_progress: 0, done: 0, cancelled: 0 };
        for (const r of rows) c[r.status] = Number(r.n);
        const total = c.pending + c.in_progress + c.done + c.cancelled;
        snap =
          `<div class="btb-snapshot">` +
          `<b>Kanban snapshot</b> (project #${escapeHtml(String(pid))}, ${total} cards): ` +
          `pending <b>${c.pending}</b> &middot; in_progress <b>${c.in_progress}</b> &middot; ` +
          `done <b>${c.done}</b> &middot; cancelled <b>${c.cancelled}</b>` +
          `<br><a href="${boardHref}">Open board &nearr;</a>` +
          `</div>`;
      } catch {
        snap = `<p class="btb-hint">(Kanban snapshot unavailable.)</p>`;
      } finally {
        if (tdb) { try { tdb.close(); } catch {} }
      }
    } else if (ttype === "custom" && tc.tracker_slug) {
      try {
        const tdef = (await db.execute({ sql: "SELECT id, display_name, status_values FROM tracker_defs WHERE slug=?", args: [tc.tracker_slug] })).rows[0];
        if (tdef) {
          const statusRows = (await db.execute({ sql: "SELECT status, COUNT(*) AS n FROM tracker_items WHERE tracker_id=? GROUP BY status", args: [tdef.id] })).rows || [];
          const statusMap = {}; let total = 0;
          for (const r of statusRows) { statusMap[r.status] = Number(r.n); total += Number(r.n); }
          const statusList = JSON.parse(tdef.status_values || "[]");
          const countParts = statusList.map((s) => `${escapeHtml(s)} <b>${statusMap[s] || 0}</b>`).join(" &middot; ");
          snap =
            `<div class="btb-snapshot">` +
            `<b>${escapeHtml(tdef.display_name)} snapshot</b> (${total} items): ${countParts}` +
            `<br><a href="${boardHref}">Open board &nearr;</a>` +
            `</div>`;
        }
      } catch {
        snap = `<p class="btb-hint">(Tracker snapshot unavailable.)</p>`;
      }
    }
    body =
      `<form method="POST" class="btb-form">${hidden("tracker")}` +
      `<div class="btb-group"><label>${t("botbuilder.labelLinkedProject", lang)}</label>` +
      `<select name="project_id" class="btb-select"><option value="">&mdash; none &mdash;</option>${projOpts}</select></div>` +
      `<p class="btb-hint">Project determines workspace, tasks DB, and member ACL.</p>` +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><label>${t("botbuilder.labelTrackerType", lang)}</label>` +
      `<select name="tracker_type" class="btb-select">` +
      `<option value="kanban"${ttSel("kanban")}>Kanban (tasks_items board)</option>` +
      `<option value="task-list"${ttSel("task-list")}>Task list (flat checklist)</option>` +
      `<option value="custom"${ttSel("custom")}>Custom tracker (tracker_defs)</option>` +
      `<option value="none"${ttSel("none")}>None (no tracker)</option>` +
      `</select></div>` +
      `<div id="custom-tracker-fields" style="${ttype !== "custom" ? "display:none" : ""}">` +
      `<div class="btb-group"><label>${t("botbuilder.labelTrackerSlug", lang)}</label>` +
      `<select name="tracker_slug" class="btb-select"><option value="">&mdash; select &mdash;</option>${trackerOpts}</select></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelContextFields", lang)}</label>` +
      `<input name="context_fields" value="${escapeHtml(cfFields)}" class="btb-input" placeholder="label, status, action_needed, pir_number"></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelQueueFilter", lang)}</label>` +
      `<input name="queue_filter_key" value="${escapeHtml(qfKey)}" class="btb-input" style="max-width:220px;display:inline-block" placeholder="processing_lease_status"> = ` +
      `<input name="queue_filter_value" value="${escapeHtml(qfVal)}" class="btb-input" style="max-width:220px;display:inline-block" placeholder="queued"></div>` +
      `</div>` +
      snap +
      `<script>document.querySelector('[name=tracker_type]').onchange=function(){` +
      `document.getElementById('custom-tracker-fields').style.display=this.value==='custom'?'':'none';}</script>` +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveTrackerConfig", lang)}</button>`) + `</form>` +
      // Tracker definition editor (below the config form)
      (function() {
        if (ttype !== "custom" || !tc.tracker_slug) return "";
        const selTracker = trackerDefs.find((td) => td.slug === tc.tracker_slug);
        if (!selTracker) return "";
        let sv = []; try { sv = JSON.parse(selTracker.status_values || "[]"); } catch {}
        let cols = []; try { cols = JSON.parse(selTracker.columns_json || "[]"); } catch {}
        const svText = sv.join(", ");
        const colRows = cols.map((c, i) =>
          `<tr>` +
          `<td><input name="col_key_${i}" value="${escapeHtml(c.key || "")}" style="width:120px"></td>` +
          `<td><input name="col_label_${i}" value="${escapeHtml(c.label || "")}" style="width:140px"></td>` +
          `<td><select name="col_type_${i}">` +
          ["text","number","date","datetime","boolean","json"].map((tp) => `<option${tp === (c.type || "text") ? " selected" : ""}>${tp}</option>`).join("") +
          `</select></td>` +
          `<td><input type="checkbox" name="col_req_${i}"${c.required ? " checked" : ""}></td>` +
          `</tr>`
        ).join("");
        return `<hr class="btb-divider">` +
          `<h4 style="margin:0 0 .5rem">Tracker definition: ${escapeHtml(selTracker.display_name)}</h4>` +
          `<p class="btb-hint" style="margin:0 0 .75rem">Edit the tracker's column headers (statuses) and data fields. Changes apply to all items in this tracker.</p>` +
          `<div id="bb-tracker-def-msg" class="btb-tdef-msg"></div>` +
          `<div class="btb-group"><label>Display name</label>` +
          `<input id="bb-tdef-name" value="${escapeHtml(selTracker.display_name)}" class="btb-input" style="max-width:300px"></div>` +
          `<div class="btb-group"><label>Status columns (comma-separated, in display order)</label>` +
          `<input id="bb-tdef-statuses" value="${escapeHtml(svText)}" class="btb-input" placeholder="pending, processing, received, done"></div>` +
          `<p class="btb-hint" style="margin-top:-.5rem">These become the board columns. Changing them does not migrate existing items &mdash; items with removed statuses will appear in an "other" column.</p>` +
          `<div class="btb-group"><label>Data fields (columns_json)</label>` +
          `<table class="btb-table">` +
          `<thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Req</th></tr></thead>` +
          `<tbody id="bb-tdef-cols">${colRows}</tbody></table></div>` +
          `<button type="button" class="btb-btn btb-btn-sec btb-btn-sm" id="bb-tdef-add-col">+ Add field</button>` +
          `<div style="margin-top:.75rem">` +
          `<button type="button" class="btb-btn" id="bb-tdef-save">Save tracker definition</button>` +
          `</div>` +
          `<script>(function(){
            var API='/dashboard/bot-board-api';
            var slug=${JSON.stringify(tc.tracker_slug)};
            var msgEl=document.getElementById('bb-tracker-def-msg');
            function tdefMsg(t,c){msgEl.style.color=c==='ok'?'var(--crow-success)':c==='err'?'var(--crow-error)':'';msgEl.textContent=t||'';}
            var colIdx=${cols.length};
            document.getElementById('bb-tdef-add-col').onclick=function(){
              var tbody=document.getElementById('bb-tdef-cols');
              var tr=document.createElement('tr');
              function td(child){var t=document.createElement('td');t.appendChild(child);return t;}
              var ki=document.createElement('input');ki.name='col_key_'+colIdx;ki.style.width='120px';ki.placeholder='field_key';
              var li=document.createElement('input');li.name='col_label_'+colIdx;li.style.width='140px';li.placeholder='Display Label';
              var sel=document.createElement('select');sel.name='col_type_'+colIdx;
              ['text','number','date','datetime','boolean','json'].forEach(function(t){var o=document.createElement('option');o.value=t;o.textContent=t;if(t==='text')o.selected=true;sel.appendChild(o);});
              var cb=document.createElement('input');cb.type='checkbox';cb.name='col_req_'+colIdx;
              tr.appendChild(td(ki));tr.appendChild(td(li));tr.appendChild(td(sel));tr.appendChild(td(cb));
              tbody.appendChild(tr);
              colIdx++;
            };
            document.getElementById('bb-tdef-save').onclick=function(){
              var name=document.getElementById('bb-tdef-name').value.trim();
              if(!name){tdefMsg('Display name required.','err');return;}
              var svRaw=document.getElementById('bb-tdef-statuses').value;
              var statuses=svRaw.split(',').map(function(s){return s.trim();}).filter(Boolean);
              if(!statuses.length){tdefMsg('At least one status required.','err');return;}
              var cols=[];
              var tbody=document.getElementById('bb-tdef-cols');
              var rows=tbody.querySelectorAll('tr');
              rows.forEach(function(row){
                var inputs=row.querySelectorAll('input,select');
                var key=(inputs[0]&&inputs[0].value||'').trim();
                if(!key)return;
                cols.push({key:key,label:(inputs[1]&&inputs[1].value||'').trim()||key,type:(inputs[2]&&inputs[2].value||'text'),required:!!(inputs[3]&&inputs[3].checked)});
              });
              tdefMsg('Saving...','');
              fetch(API+'/tracker/'+encodeURIComponent(slug),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:name,status_values:statuses,columns_json:cols}),credentials:'same-origin'})
              .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
              .then(function(r){
                if(r.ok){tdefMsg('Saved. Reload the Bot Board to see changes.','ok');}
                else{tdefMsg((r.j&&(r.j.error||r.j.reason))||'save failed','err');}
              });
            };
          })();</script>`;
      })();
  } else if (tabId === "skills") {
    // A6: group skills by contributing extension. An installed extension
    // with a capabilities.skills list (Slice B once bundles are installed)
    // gets its own group; everything else falls under "General". On MPA in
    // Slice A no installed addon declares skills, so this renders as the
    // General group over <crowHome>/skills, ~/.crow/skills, ~/crow/skills.
    const skCrowHome = resolveCrowHome();
    const allSkills = loadSkills(skCrowHome);
    const sel = new Set((def.skills || []));
    const renderBoxes = (names) =>
      `<div class="btb-checkbox-group">` +
      names.map((s) => `<label class="btb-checkbox"><input type="checkbox" name="skills" value="${escapeHtml(s)}"${sel.has(s) ? " checked" : ""}> ${escapeHtml(s)}</label>`).join("") +
      `</div>`;
    const claimed = new Set();
    let groupsHtml = "";
    for (const ext of listInstalledExtensions(skCrowHome)) {
      const names = extensionSkills(ext).filter((n) => allSkills.includes(n));
      if (!names.length) continue;
      names.forEach((n) => claimed.add(n));
      groupsHtml += `<div class="btb-group"><label>${escapeHtml(ext.group || ext.id)}</label>${renderBoxes(names)}</div>`;
    }
    // Slice C: `skill-writing` is FEATURED in its own card (one-click
    // attach), so exclude it from the General group to avoid a duplicate
    // checkbox with the same name="skills" value.
    const featured = allSkills.includes("skill-writing") ? "skill-writing" : null;
    const general = allSkills.filter((n) => !claimed.has(n) && n !== featured);
    if (general.length) {
      groupsHtml += `<div class="btb-group"><label>General</label>` +
        `<p class="btb-hint">${escapeHtml(skillDirs(skCrowHome).join(", "))}</p>${renderBoxes(general)}</div>`;
    }
    // Slice C: prominent "Skill authoring" card.
    const ppSelf = !!(def.permission_policy && def.permission_policy.self_authoring);
    const featuredCard =
      `<div style="border:1px solid var(--crow-accent);border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;background:var(--crow-bg-elevated)">` +
      `<div style="font-weight:600;margin-bottom:.35rem">&#9997; Skill authoring</div>` +
      `<p class="btb-hint">Attach <code>skill-writing</code> to teach this bot how to design skills. To let it ` +
      `<strong>propose</strong> new skills on its own (drafted into a staging dir for your approval), enable ` +
      `<strong>Self-authoring skills</strong> on the ` +
      `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&amp;tab=permissions">Permissions</a> tab — ` +
      `currently <strong>${ppSelf ? "ON" : "OFF"}</strong>. Proposals stay inert until you approve them below.</p>` +
      (featured
        ? `<label class="btb-checkbox"><input type="checkbox" name="skills" value="skill-writing"${sel.has("skill-writing") ? " checked" : ""}> Attach <code>skill-writing</code> (one-click)</label>`
        : `<p class="btb-muted">skill-writing.md not found in ${escapeHtml(skillDirs(skCrowHome).join(", "))}.</p>`) +
      `</div>`;
    // Slice C: proposed-skills review (drafted by a self_authoring bot into
    // <def.session_dir>/proposed-skills). Operator reviews/edits, then
    // Approve (promote to ~/.crow/skills + attach) or Reject (discard).
    const proposals = listProposals(def.session_dir);
    const proposalsHtml = proposals.length
      ? proposals.map((p) => {
          const badges = p.flags.length
            ? p.flags.map((f) => `<span title="${escapeHtml(f.snippet)}" style="display:inline-block;background:#5c1a1a;color:#ffd9d9;border-radius:4px;padding:.1rem .4rem;font-size:.72rem;margin:0 .25rem .25rem 0">&#9888; ${escapeHtml(f.label)}</span>`).join("")
            : `<span style="color:var(--crow-text-muted);font-size:.78rem">No guardrail phrases flagged</span>`;
          const ta = `bb-prop-${escapeHtml(p.name)}`;
          return `<div style="border:1px solid var(--crow-border);border-radius:6px;padding:.6rem;margin:.5rem 0">` +
            `<div style="margin-bottom:.3rem"><code>${escapeHtml(p.name)}.md</code> ${badges}</div>` +
            `<textarea id="${ta}" class="btb-textarea btb-textarea-wide" rows="12">${escapeHtml(p.text)}</textarea>` +
            `<div style="margin-top:.4rem;display:flex;gap:.5rem;align-items:center">` +
            `<button class="btb-btn bb-prop-approve" data-name="${escapeHtml(p.name)}" data-ta="${ta}">Approve &rarr; ~/.crow/skills</button>` +
            `<button class="btb-btn bb-prop-reject" data-name="${escapeHtml(p.name)}">Reject</button>` +
            `<span class="bb-prop-status btb-send-status"></span>` +
            `</div></div>`;
        }).join("")
      : `<p class="btb-muted">${t("botbuilder.noticeNoProposedSkills", lang)}</p>`;
    const propScript = `<script>(function(){
          var API='/dashboard/bot-board-api';
          var bot=${JSON.stringify(botId)};
          function post(url,body,el,onok){
            el.textContent='Working...';
            fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'})
              .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
              .then(function(x){ if(x.ok&&x.j&&x.j.ok){ onok(); } else { el.textContent=(x.j&&(x.j.error||x.j.reason))||'failed'; } })
              .catch(function(e){ el.textContent='Error: '+e.message; });
          }
          document.querySelectorAll('.bb-prop-approve').forEach(function(btn){
            btn.onclick=function(){
              var name=this.getAttribute('data-name');
              var ta=document.getElementById(this.getAttribute('data-ta'));
              var st=this.parentNode.querySelector('.bb-prop-status');
              if(!confirm('${tJs("botbuilder.confirmApproveSkill", lang)}'.replace('{name}',name))) return;
              post(API+'/bot/'+encodeURIComponent(bot)+'/proposed-skill/approve',{name:name,content:ta.value},st,function(){ st.textContent='Approved.'; location.reload(); });
            };
          });
          document.querySelectorAll('.bb-prop-reject').forEach(function(btn){
            btn.onclick=function(){
              var name=this.getAttribute('data-name');
              var st=this.parentNode.querySelector('.bb-prop-status');
              if(!confirm('${tJs("botbuilder.confirmRejectSkill", lang)}'.replace('{name}',name))) return;
              post(API+'/bot/'+encodeURIComponent(bot)+'/proposed-skill/reject',{name:name},st,function(){ st.textContent='Rejected.'; location.reload(); });
            };
          });
        })();</script>`;
    body =
      `<form method="POST" class="btb-form">${hidden("skills")}` +
      featuredCard +
      groupsHtml +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><label>${t("botbuilder.labelSystemPrompt", lang)}</label>` +
      `<textarea name="system_prompt" rows="10" class="btb-textarea btb-textarea-wide">${escapeHtml(def.system_prompt || "")}</textarea></div>` +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveSkillsPrompt", lang)}</button>`) + `</form>` +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><label>${t("botbuilder.labelProposedSkills", lang)}</label>` +
      `<p class="btb-hint">Drafted by this bot into <code>&lt;session_dir&gt;/proposed-skills/</code>. Review and edit (sanitize any &#9888; flagged phrasing), then Approve to copy into <code>~/.crow/skills</code> and attach, or Reject to discard. Inert until approved.</p>` +
      proposalsHtml +
      `</div>` + propScript +
      // Plan §B5: self-learning provenance/audit feed — what the post-turn
      // review pass has written/proposed/downgraded for this bot.
      (() => {
        let events = [];
        try { events = listBotSkillEvents(botId, 25); } catch { events = []; }
        const badgeFor = (a) => a === "create" ? "✍ auto-create" : a === "patch" ? "✎ auto-patch"
          : a === "propose" ? "✉ proposed" : a === "downgrade" ? "⚠ downgraded" : a === "reject" ? "✗ rejected" : a;
        const rows = events.map((e) =>
          `<tr><td>${escapeHtml(e.created_at || "")}</td><td>${escapeHtml(badgeFor(e.action))}</td>` +
          `<td><code>${escapeHtml(e.skill_name || "")}</code></td><td>${escapeHtml(e.mode || "")}</td>` +
          `<td>${e.flags_json && e.flags_json !== "null" ? "&#9888;" : ""}</td></tr>`).join("");
        return `<hr class="btb-divider">` +
          `<div class="btb-group"><label>${t("botbuilder.labelSelfLearningHistory", lang)}</label>` +
          `<p class="btb-hint">Post-turn review activity for this bot (<code>bot_skill_events</code>). <strong>auto-create/auto-patch</strong> went live in <code>~/.crow/skills</code>; <strong>proposed/downgraded</strong> are waiting for you above. &#9888; = guardrail phrasing was flagged.</p>` +
          (events.length
            ? `<table class="btb-table"><thead><tr><th>when</th><th>action</th><th>skill</th><th>mode</th><th>&#9888;</th></tr></thead><tbody>${rows}</tbody></table>`
            : `<p class="btb-hint">${t("botbuilder.noticeNoSelfLearning", lang)}</p>`) +
          `</div>`;
      })();
  } else if (tabId === "permissions") {
    const pp = def.permission_policy || {};
    const bashSel = (v) => (pp.bash || "deny") === v ? " selected" : "";
    const esSel = (v) => (pp.external_send || "draft_only") === v ? " selected" : "";
    const slSel = (v) => (pp.skill_learning || "off") === v ? " selected" : "";
    const managedRaw = await readSetting(db, "remote_managed_bots");
    let isManaged = false;
    try { const a = JSON.parse(managedRaw || "[]"); if (Array.isArray(a)) isManaged = a.includes(botId); } catch {}
    body =
      `<form method="POST" class="btb-form">${hidden("permissions")}` +
      `<div class="btb-group"><label>${t("botbuilder.labelBash", lang)}</label>` +
      `<select name="pp_bash" class="btb-select"><option${bashSel("deny")}>deny</option><option${bashSel("allowlist")}>allowlist</option><option${bashSel("sandbox")}>sandbox</option></select></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelBashAllowPrefixes", lang)}</label>` +
      `<textarea name="pp_bash_allow" rows="3" class="btb-textarea">${escapeHtml((pp.bash_allow || []).join("\n"))}</textarea></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelWritePaths", lang)}</label>` +
      `<textarea name="pp_write_paths" rows="3" class="btb-textarea">${escapeHtml((pp.write_paths || []).join("\n"))}</textarea></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelExternalSend", lang)}</label>` +
      `<select name="pp_external_send" class="btb-select"><option${esSel("draft_only")}>draft_only</option><option${esSel("allow")}>allow</option></select></div>` +
      `<div class="btb-group"><label>${t("botbuilder.labelConfirmTools", lang)}</label>` +
      `<textarea name="pp_confirm" rows="3" class="btb-textarea">${escapeHtml((pp.confirm || []).join("\n"))}</textarea></div>` +
      `<div class="btb-group"><label class="btb-checkbox"><input type="checkbox" name="pp_multi_agent"${pp.multi_agent ? " checked" : ""}> Multi-agent (allow the <code>subagent</code> tool)</label></div>` +
      `<p class="btb-hint">Multi-agent is gated by pi-lab/permission-gating.ts (Phase 3.1): <code>subagent</code> is allowed only when this is on AND the bot's resolved model is MULTI_AGENT_CAPABLE; recursion is depth-capped. Off by default.</p>` +
      `<div class="btb-group"><label class="btb-checkbox"><input type="checkbox" name="pp_self_authoring"${pp.self_authoring ? " checked" : ""}> Self-authoring skills (let this bot <strong>propose</strong> new skills)</label></div>` +
      `<p class="btb-hint">When on, the bot may DRAFT a skill file into its confined staging dir (<code>&lt;session_dir&gt;/proposed-skills/</code>). Proposals are <strong>inert</strong> — they never load and never reach <code>~/.crow/skills</code> until you approve them on the <strong>Skills &amp; Prompt</strong> tab. Skills are pure prompt text; approving one can never grant a tool or change this policy. Off by default.</p>` +
      `<div class="btb-group"><label>${t("botbuilder.labelSelfLearning", lang)}</label>` +
      `<select name="pp_skill_learning" class="btb-select"><option${slSel("off")}>off</option><option${slSel("propose")}>propose</option><option${slSel("auto")}>auto</option></select></div>` +
      `<p class="btb-hint">After each turn, an idle-only, cheap-model review decides whether to write or improve a skill (Hermes-style). <strong>propose</strong> drafts into the staging dir for your approval (same flow as self-authoring, but auto-triggered). <strong>auto</strong> writes/patches directly, behind guardrails: guardrail-phrase drafts are blocked to a proposal; high-blast-radius bots (open <code>external_send</code>, non-<code>deny</code> bash, or multi-agent) silently degrade to propose; a bot may only patch skills it itself auto-authored, never operator- or repo-authored ones. Runs ONLY when no pi turn is live, so it never starves real turns. Off by default. Auto-written skills appear under <strong>Skills &amp; Prompt</strong>.</p>` +
      `<p class="btb-hint">Enforced by pi-lab/permission-gating.ts via PI_BOT_PERMISSION_POLICY (Phase 2.2). Default-deny for safety.</p>` +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSavePermissions", lang)}</button>`) + `</form>` +
      `<form method="POST" style="margin-top:1rem">` +
      `<input type="hidden" name="action" value="toggle_peer_managed">` +
      `<input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
      `<label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">` +
      `<input type="checkbox" name="managed" ${isManaged ? "checked" : ""} onchange="this.form.submit()">` +
      `<span>Manageable by trusted peers (cross-instance edit/run — requires the master toggle in Settings &rarr; Remote Bot Management)</span>` +
      `</label></form>`;
  } else if (tabId === "triggers") {
    const tr = def.triggers || {};
    body =
      `<form method="POST" class="btb-form">${hidden("triggers")}` +
      `<div class="btb-group"><label class="btb-checkbox"><input type="checkbox" name="tr_gateway"${tr.gateway ? " checked" : ""}> ${t("botbuilder.labelGatewayTriggered", lang)}</label></div>` +
      formField(t("botbuilder.labelCron", lang), "tr_cron", { value: tr.cron || "", placeholder: "*/15 * * * *" }) +
      `<p class="btb-hint">The bridge runs its OWN timer over triggers.cron &mdash; NOT the schedules table / pipeline-runner (plan &sect;2).</p>` +
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveTriggers", lang)}</button>`) + `</form>`;
  } else if (tabId === "sessions") {
    // S3: session resume UX — list, send-message, transcript viewer, stop
    let sessions = [];
    try {
      sessions = (await db.execute({
        sql: `SELECT id, pi_session_id, pi_session_dir, gateway_thread_id, status, control,
                model, escalated, card_id, datetime(updated_at) AS updated_at
              FROM bot_sessions WHERE bot_id=? ORDER BY id DESC LIMIT 30`,
        args: [botId],
      })).rows || [];
    } catch {}
    const statusClass = (s) => {
      if (s === "active" || s === "done") return "btb-ok";
      if (s === "waiting-user") return "btb-status-warn";
      if (s === "error") return "btb-err";
      return "btb-muted";
    };
    const sessHtml = sessions.length
      ? `<table class="btb-table">
              <thead><tr>
              <th>${t("botbuilder.thId", lang)}</th>
              <th>${t("botbuilder.thStatus", lang)}</th>
              <th>${t("botbuilder.thModel", lang)}</th>
              <th>${t("botbuilder.thThread", lang)}</th>
              <th>${t("botbuilder.thUpdated", lang)}</th>
              <th>${t("botbuilder.thActions", lang)}</th>
              </tr></thead><tbody>` +
        sessions.map((s) => {
          const cls = statusClass(s.status);
          const canSend = s.status === "active" || s.status === "waiting-user";
          const canStop = s.status === "active" || s.status === "waiting-user";
          const threadShort = (s.gateway_thread_id || "").slice(0, 20);
          const actions = [];
          if (canSend) actions.push(`<button class="bb-sess-send btb-sess-btn" data-thread="${escapeHtml(s.gateway_thread_id || "")}">Send</button>`);
          if (canStop) actions.push(`<button class="bb-sess-stop btb-sess-btn" data-thread="${escapeHtml(s.gateway_thread_id || "")}">Stop</button>`);
          if (s.pi_session_id && s.pi_session_dir) actions.push(`<a href="/dashboard/bot-board-api/session/${s.id}/transcript" target="_blank" class="btb-sess-link">Transcript</a>`);
          return `<tr>
                <td>${s.id}</td>
                <td class="${cls}">${escapeHtml(s.status || "")}</td>
                <td class="btb-mono" style="font-family:monospace;font-size:.78rem">${escapeHtml(s.model || "—")}</td>
                <td class="btb-mono" style="font-family:monospace;font-size:.78rem" title="${escapeHtml(s.gateway_thread_id || "")}">${escapeHtml(threadShort)}</td>
                <td class="btb-muted">${escapeHtml(s.updated_at || "")}</td>
                <td>${actions.join(" ")}</td>
              </tr>`;
        }).join("") + `</tbody></table>`
      : `<p class="btb-muted">${t("botbuilder.noticeNoSessions", lang)}</p>`;
    // Send-message form (shown via JS when Send button clicked)
    const sendForm =
      `<div id="bb-sess-send-panel" class="btb-send-panel">` +
      `<label>Send message to session (thread: <code id="bb-sess-thread"></code>)</label><br>` +
      `<textarea id="bb-sess-msg" rows="3" class="btb-textarea btb-textarea-wide"></textarea>` +
      `<button id="bb-sess-send-btn" class="btb-btn">Send via bridge --inject</button>` +
      `<span id="bb-sess-send-status" class="btb-send-status"></span>` +
      `</div>`;
    const sessScript = `<script>(function(){
          var panel=document.getElementById('bb-sess-send-panel');
          var threadEl=document.getElementById('bb-sess-thread');
          var msgEl=document.getElementById('bb-sess-msg');
          var statusEl=document.getElementById('bb-sess-send-status');
          var curThread=null;
          document.querySelectorAll('.bb-sess-send').forEach(function(btn){
            btn.onclick=function(){ curThread=this.getAttribute('data-thread');
              threadEl.textContent=curThread; panel.style.display=''; msgEl.focus(); };
          });
          document.querySelectorAll('.bb-sess-stop').forEach(function(btn){
            btn.onclick=function(){
              if(!confirm('${tJs("botbuilder.confirmStopSession", lang)}')) return;
              var t=this.getAttribute('data-thread');
              fetch('/dashboard/bot-board-api/session/stop',{method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({bot_id:'${escapeHtml(botId)}',gateway_thread_id:t}),
                credentials:'same-origin'})
              .then(function(r){return r.json();})
              .then(function(j){ if(j.ok) location.reload(); else crowToast('${tJs("botbuilder.stopSessionFailed", lang)}', {type:'error', details: j.reason||j.error||''}); });
            };
          });
          var sendBtn=document.getElementById('bb-sess-send-btn');
          if(sendBtn) sendBtn.onclick=function(){
            var msg=msgEl.value.trim();
            if(!msg||!curThread){ statusEl.textContent='Message required'; return; }
            statusEl.textContent='Sending...';
            fetch('/dashboard/bot-board-api/session/send',{method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({bot_id:'${escapeHtml(botId)}',gateway_thread_id:curThread,message:msg}),
              credentials:'same-origin'})
            .then(function(r){return r.json();})
            .then(function(j){ if(j.ok){ statusEl.textContent='Dispatched.'; msgEl.value=''; }
              else statusEl.textContent=j.error||'failed'; })
            .catch(function(e){ statusEl.textContent='Error: '+e.message; });
          };
        })();</script>`;
    body = sessHtml + sendForm + sessScript;
  } else if (tabId === "review") {
    const mcpMsg = q.mcp ? `<p class="btb-notice-ok">${escapeHtml(String(q.mcp))}</p>` : "";
    // R13/R14 (Phase 3.2): show the EFFECTIVE runtime decision the bridge
    // will make — resolved default/escalation provider/model (via the 3.0
    // resolver, fail-closed, never throws), the multi_agent flag, and the
    // computed isMultiAgentCapable verdict for the default-resolved pair.
    let effHtml;
    try {
      const rDef = await resolveModel(def, { escalate: false });
      const rEsc = await resolveModel(def, { escalate: true });
      const maOn = !!(def.permission_policy && def.permission_policy.multi_agent);
      const capable = isMultiAgentCapable(rDef.provider, rDef.model);
      const escConfigured = !!(def.models && def.models.escalation);
      const fb = (r) => (r.source === "fallback" ? ` <span class="btb-review-fallback">(fail-closed fallback)</span>` : "");
      const subAllowed = maOn && capable;
      effHtml =
        `<div class="btb-group"><b>Effective runtime decision</b> <span class="btb-hint" style="display:inline">(computed via model_resolver.mjs + pi_extensions_allowlist.mjs)</span></div>` +
        `<table class="btb-review-table">` +
        `<tr><td>Default model</td><td><code>${escapeHtml(rDef.key)}</code> <span class="btb-review-source">source=${escapeHtml(rDef.source)}</span>${fb(rDef)}</td></tr>` +
        `<tr><td>Escalation model</td><td>` +
          (escConfigured
            ? `<code>${escapeHtml(rEsc.key)}</code> <span class="btb-review-source">source=${escapeHtml(rEsc.source)}</span>` +
              (rEsc.escalationRequestedButUnavailable ? ` <span class="btb-review-fallback">(configured value not in models.json &mdash; would fall back + notice)</span>` : "")
            : `<span class="btb-muted">&mdash; none (escalation disabled; <code>!escalate</code> is a no-op)</span>`) +
        `</td></tr>` +
        `<tr><td>multi_agent flag</td><td>${maOn ? `<b class="btb-ok">on</b>` : `<span class="btb-muted">off</span>`}</td></tr>` +
        `<tr><td>isMultiAgentCapable(default)</td><td>${capable ? `<b class="btb-ok">true</b>` : `<span class="btb-err">false</span>`}</td></tr>` +
        `<tr><td>&rarr; <code>subagent</code> at runtime</td><td>${subAllowed ? `<b class="btb-ok">ALLOWED</b>` : `<b class="btb-err">BLOCKED</b> <span class="btb-muted">(${escapeHtml(!maOn ? "multi_agent off" : "model not MULTI_AGENT_CAPABLE")})</span>`}</td></tr>` +
        `</table>` +
        `<p class="btb-hint">This mirrors the pi-lab gate (Phase 3.1): the bridge only offers <code>subagent</code> when both are true; the gate is the hard backstop. Escalation is per-turn via <code>!escalate</code> only.</p>`;
    } catch (e) {
      effHtml = `<p class="btb-notice-warn">${escapeHtml(String(e.message || e))}</p>`;
    }
    body =
      mcpMsg +
      effHtml +
      `<hr class="btb-divider">` +
      `<div class="btb-group"><b>Computed definition</b> (pi_bot_defs.definition)</div>` +
      `<pre class="btb-pre">${escapeHtml(JSON.stringify(def, null, 2))}</pre>` +
      `<p style="margin:.75rem 0">Per-bot MCP servers from selection: <code>${escapeHtml(serversForBot(def).join(", ") || "(none)")}</code></p>` +
      `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.75rem 0">` +
      `<form method="POST"><input type="hidden" name="action" value="regen_mcp"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
      `<button type="submit" class="btb-btn">${t("botbuilder.btnRegenMcp", lang)}</button></form>` +
      `<form method="POST"><input type="hidden" name="action" value="toggle"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
      `<button type="submit" class="btb-btn btb-btn-sec">${bot.enabled ? t("botbuilder.btnDisableBot", lang) : t("botbuilder.btnEnableBot", lang)}</button></form>` +
      `</div>` +
      `<p class="btb-hint">Saving a bot writes pi_bot_defs only. The bridge spawn-per-turn picks up changes on the next inbound; no gateway restart needed.</p>`;
  }

  return res.send(layout({
    title: "Bot Builder — " + escapeHtml(botId),
    content: PAGE_CSS + section(
      `Edit bot: ${escapeHtml(bot.display_name || botId)} ${bot.enabled ? badge("enabled", "connected") : badge("disabled", "draft")}`,
      `<p><a href="/dashboard/bot-builder">&larr; ${t("botbuilder.noticeAllBots", lang)}</a></p>` + notice +
      nav + body
    ),
  }));
}
