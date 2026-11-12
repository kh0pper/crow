/**
 * Bot Builder — Safety tab: email sending, folders, "always ask before…".
 */
import { escapeHtml, actionBar } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { segGroup, card } from "./ui.js";
import { confirmView } from "./def-adapter.js";
import { selectedWriteTools, loadSources, sourceDisplay, satelliteReadMarks, satelliteMarksFrom } from "./sources.js";
import { resolveCrowHome } from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { getManifest } from "../../../bundles-config.js";
import { sourceLabel } from "./tool-access.js";
import { installPaths, satelliteInstalls } from "../../../satellites/installs.js";
import { getBotOptin } from "../../../satellites/store.js";
import {
  instanceContainment, LEVEL_CONTAINED, LEVEL_PARTLY, LEVEL_NOT, OPEN_DATA_DBS,
} from "../../../../../scripts/pi-bots/containment-status.mjs";
import { containmentBots, currentProbe, LEVEL_KEY } from "../../settings/sections/bot-runtime.js";
import { renderGitAccessCard } from "./git-access.js";

export async function renderSafety(ctx) {
  const { db, def, lang, hidden } = ctx;
  const pp = def.permission_policy || {};

  const es = pp.external_send === "allow" ? "allow" : (pp.external_send && pp.external_send !== "draft_only" ? "custom" : "draft_only");
  const esOpts = [
    { value: "draft_only", label: t("botbuilder.sfEmailDraft", lang) },
    { value: "allow", label: t("botbuilder.sfEmailSend", lang) },
  ];
  if (es === "custom") esOpts.push({ value: "custom", label: fill(t("botbuilder.sfKept", lang), { value: String(pp.external_send) }) });
  const email = card(t("botbuilder.sfEmailTitle", lang),
    segGroup({ name: "email_mode", legend: t("botbuilder.sfEmailLegend", lang), current: es, options: esOpts, hint: t("botbuilder.sfEmailHint", lang) }));

  // The project folder the bridge adds to read_paths by itself — shown, never stored.
  let projectReadDir = null;
  if (def.project_id != null) {
    try {
      const ps = (await db.execute({ sql: "SELECT workspace_dir, archived_at FROM project_spaces WHERE id=?", args: [def.project_id] })).rows[0];
      if (ps && ps.workspace_dir && !ps.archived_at) projectReadDir = String(ps.workspace_dir);
    } catch { projectReadDir = null; }
  }
  const readPaths = Array.isArray(pp.read_paths) ? pp.read_paths : [];
  const writePaths = Array.isArray(pp.write_paths) ? pp.write_paths : [];
  // What the folder lists really are (audit N1b-9, review N5-4). In the default
  // tier a bot's commands run as this account, so the lists are advice, not limits;
  // only a contain-tier spawn enforces them, and only for the bots it covers. The
  // level is COMPUTED by containment-status.mjs through the same helper Settings →
  // Bot Runtime uses — never re-derived here, and never inferred from this
  // process's env.
  const level = await instanceLevel(db, lang, { botId: ctx.botId, bot: ctx.bot });
  const foldersSpeech = level.enforced
    ? t(level.dbsOpen ? "botbuilder.sfFoldersEnforcedDbs" : "botbuilder.sfFoldersEnforced", lang)
    : t("botbuilder.sfFoldersNotLimits", lang);
  const folders = card(t("botbuilder.sfFoldersTitle", lang),
    `<div class="btb-group"><label for="sf-read">${escapeHtml(t("botbuilder.labelReadPaths", lang))}</label>` +
    `<textarea id="sf-read" name="pp_read_paths" rows="3" class="btb-textarea" placeholder="/home/you/notes">${escapeHtml(readPaths.join("\n"))}</textarea>` +
    (projectReadDir ? `<p class="btb-hint" data-testid="read-paths-project">${t("botbuilder.readPathsProjectAuto", lang)} <code>${escapeHtml(projectReadDir)}</code></p>` : "") +
    `<p class="btb-hint">${t("botbuilder.hintReadPaths", lang)}</p></div>` +
    `<div class="btb-group"><label for="sf-write">${escapeHtml(t("botbuilder.sfWritePaths", lang))}</label>` +
    `<textarea id="sf-write" name="pp_write_paths" rows="3" class="btb-textarea">${escapeHtml(writePaths.join("\n"))}</textarea>` +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.sfWritePathsHint", lang))}</p></div>` +
    `<p class="btb-hint" data-testid="containment-level">${escapeHtml(level.text)}</p>` +
    `<p class="btb-hint" data-testid="containment-folders">${escapeHtml(foldersSpeech)}` +
    (level.runsChecked ? ` ${escapeHtml(t("botbuilder.sfContainmentRunsChecked", lang))}` : "") +
    (level.enforced ? "" : ` <a href="/dashboard/settings?section=bot-runtime">${escapeHtml(t("botbuilder.sfContainmentLink", lang))}</a>`) +
    `</p>`);

  const crowHome = ctx.crowHome || resolveCrowHome();
  // Satellite-hosted bundles (SAT-7 part B): the per-bot "also on other people's turns" opt-in,
  // shown only when a satellite bundle is installed. Grants themselves live on Abilities (one row
  // per source) and are never auto-granted; this switch only widens WHEN a granted tool may run.
  const satCard = await satelliteOptinCard({ db, botId: ctx.botId, lang, crowHome });
  // One probe for this page: the same sources the tool names and their labels come from.
  let sources = null;
  try { sources = (await loadSources({ db, projectId: def.project_id ?? null, crowHome })).sources; } catch { sources = null; }
  let catalog = null;
  if (sources) {
    catalog = {};
    for (const src of sources) if (src.ok) catalog[src.server] = src.catalog;
  }
  // A satellite-hosted bundle's tools are write-class whatever their names say (SAT-7 §9.1), so a
  // granted one stays on this list even when its source did not load at all.
  let satMarks = null;
  try {
    satMarks = sources ? satelliteMarksFrom(sources, crowHome) : await satelliteReadMarks(db, crowHome);
  } catch { satMarks = satelliteMarksFrom([], crowHome); }
  const tools = selectedWriteTools(def, catalog, satMarks);
  const srcLabel = new Map((sources || []).map((src) => [src.server, src]));
  const view = confirmView(pp.confirm, tools);
  const checked = new Set(view.checked);
  const boxes = tools.length
    ? tools.map((tl) => {
        const known = srcLabel.get(tl.server);
        const src = known ? sourceDisplay(known, lang) : sourceLabel(tl.server, lang);
        return `<label class="btb-check-row"><input type="checkbox" name="confirm_tool" value="${escapeHtml(tl.key)}"${checked.has(tl.key) ? " checked" : ""}> ` +
          `<span><code>${escapeHtml(tl.name)}</code> <span class="btb-muted">· ${escapeHtml(src.name)}${src.account ? " · " + escapeHtml(src.account) : ""}</span></span></label>`;
      }).join("")
    : `<p class="btb-hint">${escapeHtml(t("botbuilder.sfConfirmNone", lang))}</p>`;
  const other = `<details class="btb-details"${view.other.length ? " open" : ""}><summary>${escapeHtml(fill(t("botbuilder.sfConfirmOther", lang), { n: view.other.length }))}</summary>` +
    `<textarea name="confirm_other" rows="3" class="btb-textarea" aria-label="${escapeHtml(t("botbuilder.sfConfirmOtherLabel", lang))}">${escapeHtml(view.other.join("\n"))}</textarea>` +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.sfConfirmOtherHint", lang))}</p></details>`;
  const ask = card(t("botbuilder.sfConfirmTitle", lang),
    `<div class="btb-check-list">${boxes}</div>` + other + `<input type="hidden" name="confirm_rendered" value="1">` +
    `<input type="hidden" name="confirm_offered" value="${escapeHtml(JSON.stringify(tools.map((x) => x.key)))}">`,
    t("botbuilder.sfConfirmLead", lang));

  // The Git access card is its OWN section with its OWN forms: nested forms are
  // invalid, so it is appended AFTER this form's closing tag (git-access.js).
  const gitCard = await renderGitAccessCard(ctx);

  return `<form method="POST" class="btb-form" id="btb-safety-form">${hidden("safety")}` +
    email + folders + satCard + ask +
    `<p class="btb-hint" data-testid="safety-summary">${escapeHtml(t(level.enforced ? "botbuilder.sfSummaryContained" : "botbuilder.sfSummaryNotContained", lang))}</p>` +
    actionBar(`<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.sfSave", lang))}</button>`) + `</form>` + gitCard;
}

/**
 * THIS bot's containment, in the words Settings → Bot Runtime uses (audit N1b-9,
 * review N5-4).
 *
 * `enforced` is true only when THIS bot has its own `contained` / `partly contained`
 * entry in containmentBots(): that helper lists only ENABLED pi bots, and the contain
 * tier can cover a subset of them (CROW_PI_CONTAIN_BOTS), so another bot's
 * containment says nothing about this bot's folders. `dbsOpen` follows this bot's own
 * open lines (containment-status.mjs's OPEN_DATA_DBS), so the database sentence
 * appears only when it is true FOR THIS BOT.
 *
 * `runsChecked` is true for a pi bot the list does not cover because it is disabled:
 * pi_contain.mjs picks the tier at every pi spawn (containSelected), so containment is
 * decided when the bot runs — which is never a reason to claim the folders are limits
 * now, and never a claim about a non-pi engine, which pi_contain does not touch.
 *
 * Never throws: an unreadable level, a failed probe (review L4) or a bad record leaves
 * the not-limits wording, because this page may not print limits it cannot show.
 *
 * @returns {Promise<{level:string, enforced:boolean, dbsOpen:boolean, runsChecked:boolean, text:string}>}
 */
async function instanceLevel(db, lang, { botId = null, bot = null } = {}) {
  try {
    const bots = await containmentBots(db);
    const probe = currentProbe();
    const inst = instanceContainment(bots, { host: { bwrap: probe.ok === true } });
    const level = Object.hasOwn(LEVEL_KEY, inst.level) ? inst.level : LEVEL_NOT;
    const mine = botId ? bots.find((b) => b && String(b.botId) === String(botId)) : null;
    // A spawn record is history: if bwrap is not on this host now, nothing is contained
    // now, whatever an earlier run recorded.
    const enforced = probe.ok === true && !!mine
      && (mine.level === LEVEL_CONTAINED || mine.level === LEVEL_PARTLY);
    const dbsOpen = enforced && Array.isArray(mine.open)
      && mine.open.some((line) => String(line).endsWith(OPEN_DATA_DBS));
    // The same key (and the same words) Bot Runtime's own level line uses, so the two
    // surfaces can never drift; "no bots" when this process could observe none.
    // This page is about ONE bot: when it has its own entry, the line shows that bot's
    // level (never the instance-wide minimum, which could read "not contained" right
    // above "containment is on for this bot"); otherwise the instance's level.
    const shown = mine
      ? (enforced ? (Object.hasOwn(LEVEL_KEY, mine.level) ? mine.level : LEVEL_NOT) : LEVEL_NOT)
      : level;
    const text = bots.length > 0
      ? fill(t("settings.botRuntimeContainmentLevel", lang), { level: t(LEVEL_KEY[shown], lang) })
      : t("settings.containment.noBots", lang);
    const runsChecked = !enforced && !mine && isDisabledPiBot(bot);
    return { level: shown, enforced, dbsOpen, runsChecked, text };
  } catch {
    return {
      level: LEVEL_NOT, enforced: false, dbsOpen: false, runsChecked: false,
      text: fill(t("settings.botRuntimeContainmentLevel", lang), { level: t(LEVEL_KEY[LEVEL_NOT], lang) }),
    };
  }
}

/** A pi bot the containment list does not cover because it is disabled (so nothing ran here). */
function isDisabledPiBot(bot) {
  if (!bot || Number(bot.enabled) === 1) return false;
  let def = {};
  try { def = JSON.parse(bot.definition || "{}") || {}; } catch { def = {}; }
  return def.engine == null || def.engine === "pi";
}

/**
 * The satellite opt-in card, or "" when this Crow hosts no satellite bundle. The warning is
 * rendered hidden and revealed by a tiny inline script when the box is on (and on load when it
 * starts checked): client code never builds text, it only un-hides the paragraph rendered here.
 * Its wording names the INSTALLED bundles (their manifest display name, falling back to the id),
 * never a fixed one. Nothing here is appended after the card except the script, so the copy is
 * rendered server-side only.
 */
async function satelliteOptinCard({ db, botId, lang, crowHome }) {
  let installed = [];
  try { installed = satelliteInstalls(installPaths(crowHome)); } catch { installed = []; }
  if (!installed.length) return "";
  let on = false;
  try { on = await getBotOptin(db, botId); } catch { on = false; }
  const warnId = "sf-sat-warn";
  const warning = fill(t("botbuilder.sfSatAnyTurnWarn", lang), { bundles: bundleNamesList(installed.map((r) => bundleDisplayName(r.id)), lang) });
  const body = `<div class="btb-check-list"><label class="btb-check-row">` +
      `<input type="checkbox" name="sat_any_turn" value="on" id="sf-sat-any" data-warn="${warnId}"${on ? " checked" : ""}> ` +
      `<span>${escapeHtml(t("botbuilder.sfSatAnyTurn", lang))}</span></label></div>` +
    `<p class="btb-hint btb-warn" id="${warnId}"${on ? "" : " hidden"}>${escapeHtml(warning)}</p>` +
    `<input type="hidden" name="sat_any_turn_rendered" value="1">`;
  const script = `<script>(function(){var b=document.getElementById('sf-sat-any');if(!b)return;function u(){` +
    `var w=document.getElementById(b.getAttribute('data-warn'));if(w)w.hidden=!b.checked;}b.addEventListener('change',u);u();})();</script>`;
  return card(t("botbuilder.sfSatTitle", lang), body, t("botbuilder.sfSatLead", lang)) + script;
}

/** A satellite bundle's display name: its manifest's `name` (the app checkout's copy), else the id. */
function bundleDisplayName(id) {
  try {
    const m = getManifest(id);
    if (m && typeof m.name === "string" && m.name.trim()) return m.name.trim();
  } catch { /* not in this checkout: the id is still true */ }
  return String(id);
}

/** "A", "A and B", "A, B and C" (Spanish: "y") — the reader's own list, never a comma-only join. */
function bundleNamesList(names, lang) {
  const list = names.filter((n) => typeof n === "string" && n);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(", ") + (lang === "es" ? " y " : " and ") + list[list.length - 1];
}
