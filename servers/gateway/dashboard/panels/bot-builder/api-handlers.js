/**
 * Bot Builder Panel — POST API Handlers
 *
 * Handles create, toggle, toggle_peer_managed, save_tab_*, and regen_mcp.
 * The ?mcp= composed diagnostics message (regen_mcp) is frozen (do-not-translate).
 * Preserves redirectAfterPost semantics exactly.
 */

import {
  PI_BUILTIN, PI_EXT_ALLOWLIST,
  loadModelOptions, remoteInvocationOn, defaultDefinition, lines,
} from "./data-queries.js";
import { normalizeGatewayFields } from "./gateway-fields.js";
import { handleWizardCreate } from "./wizard.js";
import { handleDeleteConfirm } from "./delete-bot.js";
import { readSetting, writeSetting } from "../../settings/registry.js";
import { regenerateBotMcp } from "../bot-mcp-regen.js";
import { normalizeSkillName } from "../../../../../scripts/pi-bots/skill_proposals.mjs";
import { t, SUPPORTED_LANGS } from "../../shared/i18n.js";
import { parseCookies } from "../../auth.js";

// Same crow_lang-cookie resolution the dashboard router uses (index.js);
// defensive because POST handlers can be exercised with header-less reqs.
function reqLang(req) {
  try {
    const c = parseCookies(req).crow_lang;
    return SUPPORTED_LANGS.includes(c) ? c : "en";
  } catch { return "en"; }
}

// Moved to gateway-fields.js (Item 5 PR1 — it's normalization, and the wizard
// consumes it without an import cycle); imported for local use AND re-exported
// for existing importers (a bare `export ... from` creates no local binding).
import { buildCrowMessagesGatewayConfig } from "./gateway-fields.js";
export { buildCrowMessagesGatewayConfig };

export async function handleBotBuilderPost(req, res, { db }) {
  const b = req.body || {};
  const action = b.action;

  if (action === "create") {
    const display = (b.display_name || "").trim();
    const botId = (b.bot_id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const projectId = b.project_id ? Number(b.project_id) : null;
    const model = (b.model || "").trim();
    if (!botId || !display) return res.redirectAfterPost("/dashboard/bot-builder?error=name_required");
    // Item 4 PR1 (§2.1): the model must be one of THIS instance's provider
    // models — no silent fallback to a hardcoded default. Reject-and-banner,
    // never insert a row that can't run.
    const { opts: validOpts } = await loadModelOptions(db);
    const validModelKeys = new Set(validOpts.map((o) => o.key));
    if (!model || !validModelKeys.has(model)) {
      return res.redirectAfterPost(
        "/dashboard/bot-builder?error=" + encodeURIComponent(t("botbuilder.createModelInvalid", reqLang(req)))
      );
    }
    try {
      // M3b: project_id goes in the column, not the JSON. defaultDefinition
      // no longer includes it.
      // Item 5 PR1 (spec §D1): plain INSERT, never upsert — the old
      // ON CONFLICT DO UPDATE silently replaced an existing bot's entire
      // definition with fresh defaults (data loss). Editing is what the
      // editor is for; an existing id is rejected with a banner.
      const existing = (await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
      if (existing) {
        return res.redirectAfterPost(
          "/dashboard/bot-builder?error=" + encodeURIComponent(t("botbuilder.createExists", reqLang(req)).replace("{id}", botId))
        );
      }
      await db.execute({
        sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
        args: [botId, display, JSON.stringify(defaultDefinition(botId, projectId, model)), projectId],
      });
    } catch (e) {
      return res.redirectAfterPost("/dashboard/bot-builder?error=" + encodeURIComponent(String(e.message || e)));
    }
    // Item 5 PR2 (spec §D4): land on the readiness checklist, not the raw AI tab.
    return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&created=${encodeURIComponent(botId)}`);
  }

  // ---- guided-creation wizard final submit (Item 5 PR1, spec §D1) ----
  // PRG like every other action here; the intermediate wizard_step renders
  // happen in the panel handler (bot-builder.js), which has layout/lang.
  if (action === "wizard_create") {
    return handleWizardCreate(req, res, { db, lang: reqLang(req) });
  }

  // ---- delete a bot (Item 5 PR2, spec §D5) — PRG; confirm page is a GET ----
  if (action === "delete_confirm") {
    return handleDeleteConfirm(req, res, { db });
  }

  if (action === "toggle") {
    try {
      await db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 1 - enabled, updated_at=datetime('now') WHERE bot_id=?", args: [b.bot_id] });
    } catch { /* ignore */ }
    return res.redirectAfterPost("/dashboard/bot-builder");
  }

  if (action === "toggle_peer_managed") {
    const botId = (b.bot_id || "").trim();
    const raw = await readSetting(db, "remote_managed_bots");
    let list = [];
    try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const set = new Set(list.filter((x) => typeof x === "string" && x));
    if (b.managed === "on") set.add(botId); else set.delete(botId);
    await writeSetting(db, "remote_managed_bots", JSON.stringify([...set]), { scope: "local" });
    return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=permissions`);
  }

  // ---- Crow Messages gateway management actions (Plan 2) ----
  if (action === "gw_share" || action === "gw_newlink" || action === "gw_remove" || action === "gw_advanced_add") {
    const botId = (b.bot_id || "").trim();
    if (!botId) return res.redirectAfterPost("/dashboard/bot-builder");
    const admin = await import("./crow-messages-admin.js");
    try {
      if (action === "gw_share") {
        // Mint only if there isn't already an active link (idempotent Share).
        const active = await admin.getActiveInvite(db, botId);
        if (!active) await admin.mintInvite(db, botId, {});
      } else if (action === "gw_newlink") {
        await admin.rotateInvite(db, botId, {});
      } else if (action === "gw_remove") {
        if (b.sender_pubkey) await admin.removeAcl(db, botId, String(b.sender_pubkey).trim());
      } else if (action === "gw_advanced_add") {
        const pk = (b.sender_pubkey || "").trim();
        if (pk) await admin.addManualAcl(db, botId, pk, null, (b.display_name || "").trim() || null);
      }
    } catch (e) {
      return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=gateways&warn=${encodeURIComponent(e.message)}`);
    }
    return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=gateways`);
  }

  // tab saves — merge only that tab's fields into the existing definition
  if (action && action.startsWith("save_")) {
    const botId = b.bot_id;
    let row;
    try {
      // M3b: also fetch project_id column (authoritative). After parsing
      // the JSON we set def.project_id from the column so the rest of
      // this handler can keep reading `def.project_id` transparently.
      row = (await db.execute({ sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
    } catch { row = null; }
    if (!row) return res.redirectAfterPost("/dashboard/bot-builder?error=unknown_bot");
    let def;
    try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
    def.tools = def.tools || {};
    def.permission_policy = def.permission_policy || {};
    def.triggers = def.triggers || {};
    // M3b: column wins over JSON. Stale JSON copies of project_id will
    // never be re-baked because we don't read them anywhere downstream.
    def.project_id = row.project_id == null ? null : Number(row.project_id);
    let columnProjectIdUpdate = null;  // set when the project tab is saved
    const tab = action.slice(5);
    // Extra query suffix carried into the post-save redirect (e.g. a soft
    // validation warning for the AI tab). Never blocks the save.
    let extraQ = "";

    if (tab === "ai") {
      def.models = def.models || {};
      def.models.default = (b.model_default || def.models.default || "").trim();
      const esc = (b.model_escalation || "").trim();
      if (esc) def.models.escalation = esc; else delete def.models.escalation;
      // A6: fast voice model for the glasses fast turn (Slice B). Stored as
      // a provider_id/model_id key (same vocabulary as default/escalation),
      // resolved later via resolve-profile.js. Empty -> bot uses its default.
      const fvm = (b.fast_voice_model || "").trim();
      if (fvm) def.fast_voice_model = fvm; else delete def.fast_voice_model;
      try {
        const { opts } = await loadModelOptions(db);
        const validKeys = new Set(opts.map((o) => o.key));
        const bad = [];
        if (def.models.default && !validKeys.has(def.models.default)) bad.push("default (" + def.models.default + ")");
        if (def.models.escalation && !validKeys.has(def.models.escalation)) bad.push("escalation (" + def.models.escalation + ")");
        if (def.fast_voice_model && !validKeys.has(def.fast_voice_model)) bad.push("fast_voice_model (" + def.fast_voice_model + ")");
        if (bad.length) {
          extraQ = "&warn=" + encodeURIComponent(
            "not in provider registry: " + bad.join(", ") + " — saved anyway; runs will fail until this model is available on this instance.");
        }
      } catch {
        /* validation must never 500 the save */
      }
    } else if (tab === "tools") {
      const builtin = PI_BUILTIN.filter((t) => b["builtin_" + t]);
      const mcp = [].concat(b.crow_mcp || []).filter(Boolean);
      const exts = PI_EXT_ALLOWLIST.filter((e) => b["ext_" + e]);
      def.tools.pi_builtin = builtin.length ? builtin : ["read"];
      def.tools.crow_mcp = Array.isArray(mcp) ? mcp : [mcp];
      def.tools.pi_extensions = exts;
      // F4a L2b: persist remote capability selections (only when enabled).
      if (await remoteInvocationOn(db)) {
        let rsel = b.remote_mcp;
        if (rsel == null) rsel = [];
        else if (!Array.isArray(rsel)) rsel = [rsel];
        def.tools.remote_mcp = [...new Set(rsel.filter((x) => typeof x === "string" && x.includes("::")))];
      }
      // flag off: leave any existing def.tools.remote_mcp untouched (don't wipe a prior selection)
    } else if (tab === "gateways") {
      const gwType = (b.gw_type || "gmail").trim();
      // Simple types (gmail/discord/telegram/slack/none) normalize via the
      // shared gateway-fields module (Item 5 PR1, spec §D3) — wizard_create
      // maps the same field names through the same function.
      const simpleGateways = normalizeGatewayFields(gwType, b);
      if (simpleGateways) {
        def.gateways = simpleGateways;
      } else if (gwType === "glasses") {
        // Slice B (B4): bind this bot to a meta-glasses device. The device's
        // bound_bot_id is the source of truth the voice turn reads; the
        // gateway record mirrors it for the UI. One bot <-> one device.
        const deviceId = (b.gw_device_id || "").trim();
        const fvm = (b.gw_fast_voice_model || "").trim();
        const prior = (def.gateways || []).find((g) => g && g.type === "glasses");
        const priorDeviceId = prior && prior.device_id ? String(prior.device_id) : "";
        // Persist the TYPE even with no device: the type-change auto-submit
        // posts before a device is chosen, and dropping the record made the
        // dropdown snap back to gmail on re-render (W1-4). A device-less
        // record is a harmless UI draft — every consumer (bridge_tick,
        // discord_gateway, gateway_runner, voice turn) keys on its own type
        // plus required fields / device.bound_bot_id, never this record.
        def.gateways = [{ type: "glasses", ...(deviceId ? { device_id: deviceId } : {}), ...(fvm ? { fast_voice_model: fvm } : {}) }];
        // Keep def.fast_voice_model (read by the voice turn) in sync.
        if (fvm) def.fast_voice_model = fvm;
        try {
          const { listDevices, updateDeviceProfiles } = await import("../../../../../bundles/meta-glasses/server/device-store.js");
          if (deviceId) {
            // Unbind any OTHER device currently bound to this bot, and the
            // prior device if the binding moved ("" -> null via the store).
            const devices = await listDevices(db).catch(() => []);
            for (const d of devices) {
              if (d.bound_bot_id === botId && d.id !== deviceId) {
                await updateDeviceProfiles(db, d.id, { bound_bot_id: "" });
              }
            }
            if (priorDeviceId && priorDeviceId !== deviceId) {
              await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
            }
            const patch = { bound_bot_id: botId };
            if ("gw_tts_profile_id" in b) patch.tts_profile_id = (b.gw_tts_profile_id || "").trim();
            if ("gw_stt_profile_id" in b) patch.stt_profile_id = (b.gw_stt_profile_id || "").trim();
            if ("gw_vision_profile_id" in b) patch.vision_profile_id = (b.gw_vision_profile_id || "").trim();
            await updateDeviceProfiles(db, deviceId, patch);
          } else if (priorDeviceId) {
            // A device WAS bound and the form now submits none — explicit unbind.
            await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
          }
          // No device before, none now: pure type-change draft — mutate nothing.
        } catch (err) {
          extraQ = "&warn=" + encodeURIComponent("device binding incomplete: " + err.message);
        }
      } else if (gwType === "companion") {
        // Bind this bot to a companion kiosk device. Mirrors the glasses
        // binding (device.bound_bot_id is the source of truth) but tags the
        // device device_kind:"companion" so the companion path claims it, and
        // stores per-device companion_features that drive the kiosk UI.
        // The model pair (fast 4B -> 35B) is global (the gateway /llm/v1 router),
        // not per device — see docs/architecture/companion.md.
        let deviceId = (b.gw_device_id || "").trim();
        // One-step kiosk creation: a typed name (and no selected device)
        // pairs a fresh companion-kind device right here, so a host with
        // the companion bundle but NOT meta-glasses (whose panel used to be
        // the only pairing UI) still works out of the box.
        const newKioskName = (b.gw_new_kiosk_name || "").trim();
        if (!deviceId && newKioskName) {
          try {
            const { listDevices, pairDevice } = await import("../../../../../bundles/meta-glasses/server/device-store.js");
            const baseId = ("kiosk-" + newKioskName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)).replace(/-$/, "") || "kiosk";
            const taken = new Set((await listDevices(db).catch(() => [])).map((d) => String(d.id)));
            let newId = baseId;
            for (let n = 2; taken.has(newId); n++) newId = `${baseId}-${n}`;
            await pairDevice(db, { id: newId, name: newKioskName, generation: "unknown", device_kind: "companion" });
            deviceId = newId;
          } catch (err) {
            extraQ = "&warn=" + encodeURIComponent("could not create kiosk device: " + err.message);
          }
        }
        const features = {
          avatar_model: (b.gw_avatar_model || "").trim() || undefined,
          avatar_animation: b.gw_avatar_animation === "on" || b.gw_avatar_animation === "true",
          pet_mode: b.gw_pet_mode === "on" || b.gw_pet_mode === "true",
          social_chat: b.gw_social_chat === "on" || b.gw_social_chat === "true",
          memory_integration: b.gw_memory_integration === "on" || b.gw_memory_integration === "true",
          face_tracking: b.gw_face_tracking === "on" || b.gw_face_tracking === "true",
          hearing_style: (b.gw_hearing_style || "push_to_talk").trim(),
          voice_idle_timeout: Number(b.gw_voice_idle_timeout || 30) || 30,
        };
        const prior = (def.gateways || []).find((g) => g && g.type === "companion");
        const priorDeviceId = prior && prior.device_id ? String(prior.device_id) : "";
        // Persist the TYPE even with no device — same draft semantics as the
        // glasses branch above (W1-4: device-less save must not snap the
        // dropdown back to gmail).
        def.gateways = [{ type: "companion", ...(deviceId ? { device_id: deviceId } : {}) }];
        def.companion_features = features;
        try {
          const { listDevices, updateDeviceProfiles } = await import("../../../../../bundles/meta-glasses/server/device-store.js");
          if (deviceId) {
            const devices = await listDevices(db).catch(() => []);
            for (const d of devices) {
              if (d.bound_bot_id === botId && d.id !== deviceId) {
                await updateDeviceProfiles(db, d.id, { bound_bot_id: "" });
              }
            }
            if (priorDeviceId && priorDeviceId !== deviceId) {
              await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
            }
            await updateDeviceProfiles(db, deviceId, {
              bound_bot_id: botId,
              device_kind: "companion",
              companion_features: features,
            });
          } else if (priorDeviceId) {
            // A device WAS bound and the form now submits none — explicit unbind.
            await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
          }
          // No device before, none now: pure type-change draft — mutate nothing.
        } catch (err) {
          extraQ = "&warn=" + encodeURIComponent("companion binding incomplete: " + err.message);
        }
      } else if (gwType === "crow-messages") {
        // First-class P2P gateway (host adapter from Plan 1). Identity is derived
        // and invites/ACL live in their own tables (edited via gw_* actions); the
        // bot def only carries the type + the allow-paired toggle. This minimal
        // record is a valid host-managed gateway: gateway_runner.mjs:56 iterates
        // def.gateways[], and :89 calls adapter.start({bot_id, gw, log}) with this
        // exact object (the adapter reads gw.allow_paired_instances — Task 2).
        def.gateways = [buildCrowMessagesGatewayConfig(b)];
      } else {
        // Genuinely unsupported / coming-soon type (e.g. "signal"): refuse to
        // persist so the runner can't host a feature with no management UI.
        console.warn(`[bot-builder] ignoring save of unsupported gateway type "${gwType}" for bot ${botId}`);
      }
    } else if (tab === "tracker") {
      // M3b: project_id is owned by the column now.
      const next = b.project_id ? Number(b.project_id) : null;
      def.project_id = next;
      columnProjectIdUpdate = next;
      // S3: tracker_config
      const ttype = b.tracker_type || "kanban";
      def.tracker_config = def.tracker_config || {};
      def.tracker_config.type = ttype;
      if (ttype === "custom") {
        def.tracker_config.tracker_slug = (b.tracker_slug || "").trim();
        def.tracker_config.context_fields = (b.context_fields || "").split(",").map((s) => s.trim()).filter(Boolean);
        const qf = (b.queue_filter_key || "").trim();
        const qv = (b.queue_filter_value || "").trim();
        if (qf && qv) { def.tracker_config.queue_filter = { [qf]: qv }; }
        else { delete def.tracker_config.queue_filter; }
      } else if (ttype === "kanban" || ttype === "task-list") {
        delete def.tracker_config.tracker_slug;
        delete def.tracker_config.context_fields;
        delete def.tracker_config.queue_filter;
      } else if (ttype === "none") {
        delete def.tracker_config.tracker_slug;
        delete def.tracker_config.context_fields;
        delete def.tracker_config.queue_filter;
      }
    } else if (tab === "skills") {
      const rawSkills = [].concat(b.skills || []).filter(Boolean);
      def.skills = rawSkills.map((s) => normalizeSkillName(s)).filter(Boolean);
      if (def.skills.length < rawSkills.length) {
        const dropped = rawSkills.filter((s) => !normalizeSkillName(s));
        console.warn(`[bot-builder] Dropped invalid skill name(s) on save: ${JSON.stringify(dropped)}`);
      }
      def.tools.skills = def.skills;
      def.system_prompt = (b.system_prompt || "").trim();
    } else if (tab === "permissions") {
      def.permission_policy.bash = b.pp_bash || "deny";
      def.permission_policy.bash_allow = lines(b.pp_bash_allow);
      def.permission_policy.write_paths = lines(b.pp_write_paths);
      def.permission_policy.external_send = b.pp_external_send || "draft_only";
      def.permission_policy.confirm = lines(b.pp_confirm);
      // R13 (Phase 3.2): multi-agent opt-in. The pi-lab gate (Phase 3.1)
      // only ALLOWS the `subagent` tool when policy.multi_agent===true AND
      // the resolved model is MULTI_AGENT_CAPABLE; default false.
      def.permission_policy.multi_agent = !!b.pp_multi_agent;
      // Slice C: opt-in self-authoring. When true, the bridge lets the bot
      // DRAFT skill proposals into its confined staging dir (inert until an
      // operator approves them on the Skills tab). Default false.
      def.permission_policy.self_authoring = !!b.pp_self_authoring;
      // Plan §B2: post-turn self-learning. off (default) | propose | auto.
      //   propose = auto-trigger the operator-gated staging flow.
      //   auto    = write/patch directly, behind the §B2 guardrails (guardrail
      //             phrases hard-block to a draft; high-blast-radius bots degrade
      //             to propose; patch only this bot's own auto-authored skills).
      const sl = (b.pp_skill_learning || "off").trim();
      def.permission_policy.skill_learning = ["off", "propose", "auto"].includes(sl) ? sl : "off";
    } else if (tab === "triggers") {
      def.triggers.gateway = !!b.tr_gateway;
      def.triggers.cron = (b.tr_cron || "").trim();
    }

    try {
      // M3b: when the project tab is saved, the project_id column gets
      // updated alongside definition JSON — column is authoritative for
      // every downstream reader (bridge.mjs, bot-board, bot-board-api).
      if (columnProjectIdUpdate !== null) {
        await db.execute({
          sql: "UPDATE pi_bot_defs SET definition=?, project_id=?, updated_at=datetime('now') WHERE bot_id=?",
          args: [JSON.stringify(def), columnProjectIdUpdate, botId],
        });
      } else {
        await db.execute({
          sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?",
          args: [JSON.stringify(def), botId],
        });
      }
    } catch (e) {
      return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}&error=` + encodeURIComponent(String(e.message || e)));
    }
    return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}&saved=1${extraQ}`);
  }

  if (action === "regen_mcp") {
    const botId = b.bot_id;
    let msg;
    try {
      const r = await regenerateBotMcp(db, botId);
      // Frozen composed message — do NOT translate (spec rule 5, ?mcp= diagnostics)
      msg = `wrote ${r.path} (servers: ${r.servers.join(", ") || "none"}` +
        (r.minted && r.minted.length ? `; minted: ${r.minted.join(",")}` : "") +
        (r.warnings.length ? `; ⚠ ${r.warnings.join("; ")}` : "") +
        (r.journalGuarded.length ? `; journal-guarded: ${r.journalGuarded.join(",")}` : "") + ")";
    } catch (e) {
      msg = "ERROR: " + String(e.message || e);
    }
    return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&mcp=` + encodeURIComponent(msg));
  }
}
