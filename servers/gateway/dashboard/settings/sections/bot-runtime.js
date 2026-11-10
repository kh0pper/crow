/**
 * Settings Section: Bot Runtime (Multi-Instance group) — F3b.
 *
 * Toggles feature_flags.bot_runtime (local-only; absent from sync-allowlist).
 * When ON, the gateway process itself runs bots (poll Gmail / answer
 * Telegram/Slack/Discord) via bot-runtime.js's in-process bridge tick +
 * supervised Discord child (C4 Task 6) — no separate install step, no
 * restart to flip. The old copy here claimed the runtime units had to be
 * installed first (scripts/pi-bots/install-runtime.sh) — that predates
 * gateway supervision and is false on every default host now; standalone
 * systemd units are only relevant on a host explicitly configured with
 * PIBOT_SUPERVISOR=external (C4 Task 9 reword).
 */
import { readSetting, writeSetting } from "../registry.js";
import { t, fill } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";
import { isMpaHost } from "../../../../shared/mpa-detect.js";
import {
  instanceContainment, recordedContainment, unobservedContainment,
  LEVEL_CONTAINED, LEVEL_PARTLY, LEVEL_NOT,
  OPEN_DATA_DBS, OPEN_BROWSER, OPEN_SECRETS_SWAP, OPEN_UNCONTAINED, OPEN_NO_BWRAP, OPEN_UNOBSERVED,
} from "../../../../../scripts/pi-bots/containment-status.mjs";
import { botSandboxProbe, renderBotSandboxStatus, spawnsOutsideThisProcess } from "../../shared/bot-sandbox-status.js";
import { secretsAncestorsReport } from "../../../../../servers/shared/secrets-ancestors.js";
import { secretsDir } from "../../../../../servers/shared/secret-values.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

/**
 * The runtime state as the runner sees it: an explicit boolean flag wins,
 * else the host default (isMpaHost). Same rule as botRuntimeActive
 * (panels/bot-runtime-flag.js) and runtime-gate.mjs. Reading the flag with
 * `=== true` alone showed "disabled" on default-on hosts while bots ran, and
 * a Save from that page then wrote `false` and stopped them.
 */
function resolveRuntime(flags) {
  const explicit = typeof flags?.bot_runtime === "boolean";
  return { on: explicit ? flags.bot_runtime : isMpaHost(), explicit };
}

// ---- honest containment status (bot containment Phase 1, Task 8) ------------
// The status words and open lines are computed (containment-status.mjs) from
// the defs plus the last spawn's tier; nothing is stored. Phase 1 can never
// report "contained" for a bot: crow.db is bound read-write.

const LEVEL_KEY = {
  [LEVEL_CONTAINED]: "settings.containment.levelContained",
  [LEVEL_PARTLY]: "settings.containment.levelPartly",
  [LEVEL_NOT]: "settings.containment.levelNot",
};
/** The i18n key of a level word (the Bot Builder Safety tab shows the same words). */
export { LEVEL_KEY };

const WHY_KEY = {
  "world-writable without sticky": "settings.containment.whyWorldWritable",
  "writable by the bot uid": "settings.containment.whyBotUid",
  "group-writable by the bot's group": "settings.containment.whyBotGroup",
  "group-writable by a group with other members": "settings.containment.whySharedGroup",
  "owned by another user": "settings.containment.whyOtherOwner",
  "cannot stat": "settings.containment.whyCannotStat",
};

/** Test seam: whether this host can start the contain tier at all. A function
 *  may also return a full probe object (ok/reason/setpriv), which then also
 *  drives the sandbox status line. */
let hostBwrapProbe = null;
export function _setHostBwrapProbeForTest(fn) { hostBwrapProbe = typeof fn === "function" ? fn : null; }

/** One probe for both the containment level and the sandbox status line, so the
 *  two can never contradict each other. Never throws. */
export function currentProbe() {
  if (hostBwrapProbe) {
    try {
      const v = hostBwrapProbe();
      if (v && typeof v === "object") return v;
      return { ok: v === true, pidns: v === true, setpriv: null, reason: v === true ? null : "no bwrap (test seam)" };
    } catch {
      return { ok: false, pidns: false, setpriv: null, reason: "no bwrap (test seam)" };
    }
  }
  return botSandboxProbe();
}

/**
 * The i18n text of one open line. The English output is byte-identical to the
 * policy sentence containment-status.mjs produced (the docs and the spawn log
 * quote it); an instance line's leading `<bot id>: ` is kept verbatim.
 */
export function containmentLineText(line, lang = "en") {
  const s = String(line == null ? "" : line);
  const prefixed = /^([^:\n]+): ([\s\S]+)$/.exec(s);
  if (prefixed) return prefixed[1] + ": " + containmentLineText(prefixed[2], lang);
  if (s === OPEN_DATA_DBS) return t("settings.containment.openDataDbs", lang);
  if (s === OPEN_BROWSER) return t("settings.containment.openBrowser", lang);
  if (s === OPEN_SECRETS_SWAP) return t("settings.containment.openSecretsSwap", lang);
  if (s === OPEN_UNCONTAINED) return t("settings.containment.openUncontained", lang);
  if (s === OPEN_NO_BWRAP) return t("settings.containment.openNoBwrap", lang);
  if (s === OPEN_UNOBSERVED) return t("settings.containment.openUnobserved", lang);
  let m = /^(.+) runs inside the sandbox with its own credentials$/.exec(s);
  if (m) return fill(t("settings.containment.openAddOnServer", lang), { server: m[1] });
  m = /^provider (.+) has no door$/.exec(s);
  if (m) return fill(t("settings.containment.openNoDoor", lang), { id: m[1] });
  return s;
}

/**
 * The containment block of the Bot Runtime section. `bots` comes from
 * botContainment/recordedContainment, `host.bwrap` from the sandbox probe,
 * `ancestors` from secretsAncestorsStatus (Phase 1 warns about them).
 */
export function renderContainmentStatus({ bots = [], host = {}, ancestors = null, hasBots = null, lang = "en" } = {}) {
  const list = Array.isArray(bots) ? bots : [];
  const anyBots = hasBots === null ? list.length > 0 : hasBots === true;
  const inst = instanceContainment(list, { host });
  const lines = inst.open.map((line) => containmentLineText(line, lang));
  const findings = ancestors && Array.isArray(ancestors.findings) ? ancestors.findings : [];
  for (const f of findings) {
    const whyKey = WHY_KEY[f && f.why];
    const why = whyKey ? t(whyKey, lang) : String((f && f.why) || "");
    lines.push(fill(t("settings.containment.ancestorFinding", lang), { path: String((f && f.path) || ""), why }));
  }
  if (ancestors && ancestors.refused) lines.push(t("settings.containment.ancestorRefused", lang));
  const levelLine = anyBots
    ? fill(t("settings.botRuntimeContainmentLevel", lang), { level: t(LEVEL_KEY[inst.level] || LEVEL_KEY[LEVEL_NOT], lang) })
    : t("settings.containment.noBots", lang);
  const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `<div class="crow-containment" id="crow-containment">
      <h3 style="margin:0 0 0.5rem">${escapeHtml(t("settings.containment.title", lang))}</h3>
      <p id="crow-containment-level" style="margin:0 0 0.5rem;font-weight:600">${escapeHtml(levelLine)}</p>
      ${items ? `<p style="margin:0 0 0.25rem;color:var(--crow-text-secondary);font-size:0.9rem">${escapeHtml(t("settings.containment.openHeading", lang))}</p><ul id="crow-containment-open" style="margin:0 0 0.75rem;padding-left:1.25rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">${items}</ul>` : ""}
      <p style="margin:0 0 1.5rem;color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(t("settings.containment.note", lang))}</p>
    </div>`;
}

/**
 * Enabled pi bots, with the facts the status needs. Never throws.
 *
 * `spawnsOutsideThisProcess()` (shared/bot-sandbox-status.js) is true when the
 * spawns happen somewhere this process cannot see: PIBOT_SUPERVISOR=external
 * hands every channel bot to the host's own units, with an env this gateway
 * never reads, and the supervised Discord child is a separate process too, so a
 * record made here covers at most the Perch spawns and never the channel turns.
 * The same helper drives the sandbox status line, so both surfaces agree.
 *
 * Exported for the Bot Builder Safety tab, which shows the SAME computed level
 * rather than its own guess (audit N1b-9).
 */
export async function containmentBots(db) {
  let rows = [];
  try {
    const r = await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition FROM pi_bot_defs", args: [] });
    rows = (r && r.rows) || [];
  } catch { return []; }             // a host without the bot table yet: nothing to report
  const unobserved = spawnsOutsideThisProcess();
  const bots = [];
  for (const row of rows) {
    if (!row || Number(row.enabled) !== 1) continue;
    let def = {};
    try { def = JSON.parse(row.definition || "{}") || {}; } catch { def = {}; }
    // A def that names another engine is not a pi spawn and keeps its own story.
    if (def.engine != null && def.engine !== "pi") continue;
    const botId = String(row.bot_id || "");
    // A record exists only in the process that spawned the bot. With no record
    // (or a supervisor that spawns elsewhere) the bot counts as NOT contained:
    // the tier is never inferred from THIS process's env, which may differ from
    // the env the bot actually spawned with.
    const recorded = unobserved ? null : recordedContainment(botId);
    const status = recorded && typeof recorded.level === "string"
      ? { level: recorded.level, open: recorded.open }
      : unobservedContainment();
    bots.push({ botId, level: status.level, open: status.open });
  }
  return bots;
}

/**
 * The secrets dir's ancestors, as the status shows them (Phase 1: a warning).
 * `refused` is the report's own verdict — a bot uid configured AND something
 * open — never just "CROW_BOT_UID is set" (a clean tree is not refused).
 * `opts` carries the check's test seams (stat, groupMembers, ownerUid).
 */
export function secretsAncestorsStatus(env = process.env, opts = {}) {
  try {
    return secretsAncestorsReport({ env, secretsDir: secretsDir(env), ...opts });
  } catch { return { ok: true, findings: [], refused: false }; }
}

export default {
  id: "bot-runtime",
  group: "advanced",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>`,
  labelKey: "settings.section.botRuntime",
  navOrder: 8,

  async getPreview({ db, settings, lang }) {
    let flags = {};
    try {
      flags = db ? await readFlags(db) : (JSON.parse(settings?.feature_flags || "{}") || {});
    } catch {}
    return resolveRuntime(flags).on ? t("settings.enabledOption", lang) : t("settings.disabledOption", lang);
  },

  async render({ db, lang }) {
    const { on, explicit } = resolveRuntime(await readFlags(db));
    const defaultNote = explicit
      ? ""
      : `<div style="margin-top:0.5rem;color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(t(on ? "settings.botRuntimeDefaultOn" : "settings.botRuntimeDefaultOff", lang))}</div>`;
    const bots = await containmentBots(db);
    const probe = currentProbe();
    const sandboxStatus = renderBotSandboxStatus({ probe, lang });
    const containment = renderContainmentStatus({ bots, host: { bwrap: probe.ok === true }, ancestors: secretsAncestorsStatus(), lang });
    return `${sandboxStatus}${containment}<form method="POST">
      <input type="hidden" name="action" value="set_bot_runtime">
      <input type="hidden" name="was" value="${on ? "on" : "off"}">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        ${t("settings.botRuntimeBody", lang)}
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>${escapeHtml(t("settings.botRuntimeCheckbox", lang))}</span>
      </label>
      ${defaultNote}
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">${escapeHtml(t("common.save", lang))}</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_bot_runtime") return false;
    const flags = await readFlags(db);
    const want = req.body.enabled === "on";
    const shown = req.body.was === "on" ? true : req.body.was === "off" ? false : null;
    const current = resolveRuntime(flags).on;
    // Write only when the operator changed the box (vs what the page showed)
    // AND it differs from the live state. A plain Save is a no-op.
    if ((shown === null || want !== shown) && want !== current) {
      flags.bot_runtime = want;
      await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    }
    res.redirectAfterPost("/dashboard/settings?section=bot-runtime");
    return true;
  },
};
