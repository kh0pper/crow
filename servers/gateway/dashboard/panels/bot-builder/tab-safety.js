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
  const folders = card(t("botbuilder.sfFoldersTitle", lang),
    `<div class="btb-group"><label for="sf-read">${escapeHtml(t("botbuilder.labelReadPaths", lang))}</label>` +
    `<textarea id="sf-read" name="pp_read_paths" rows="3" class="btb-textarea" placeholder="/home/you/notes">${escapeHtml(readPaths.join("\n"))}</textarea>` +
    (projectReadDir ? `<p class="btb-hint" data-testid="read-paths-project">${t("botbuilder.readPathsProjectAuto", lang)} <code>${escapeHtml(projectReadDir)}</code></p>` : "") +
    `<p class="btb-hint">${t("botbuilder.hintReadPaths", lang)}</p></div>` +
    `<div class="btb-group"><label for="sf-write">${escapeHtml(t("botbuilder.sfWritePaths", lang))}</label>` +
    `<textarea id="sf-write" name="pp_write_paths" rows="3" class="btb-textarea">${escapeHtml(writePaths.join("\n"))}</textarea>` +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.sfWritePathsHint", lang))}</p></div>`);

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

  return `<form method="POST" class="btb-form" id="btb-safety-form">${hidden("safety")}` +
    email + folders + satCard + ask +
    `<p class="btb-hint">${t("botbuilder.hintPermEnforced", lang)}</p>` +
    actionBar(`<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.sfSave", lang))}</button>`) + `</form>`;
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
