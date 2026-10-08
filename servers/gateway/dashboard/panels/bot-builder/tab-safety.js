/**
 * Bot Builder — Safety tab: email sending, folders, "always ask before…".
 */
import { escapeHtml, actionBar } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { segGroup, card } from "./ui.js";
import { confirmView } from "./def-adapter.js";
import { selectedWriteTools, loadSources, sourceDisplay } from "./sources.js";
import { sourceLabel } from "./tool-access.js";

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

  let catalog = null;
  try {
    const { sources } = await loadSources();
    catalog = {};
    for (const src of sources) if (src.ok) catalog[src.server] = src.catalog;
  } catch { catalog = null; }
  const tools = selectedWriteTools(def, catalog);
  const srcLabel = new Map();
  try { for (const src of (await loadSources()).sources) srcLabel.set(src.server, src); } catch { /* names only */ }
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
    email + folders + ask +
    `<p class="btb-hint">${t("botbuilder.hintPermEnforced", lang)}</p>` +
    actionBar(`<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.sfSave", lang))}</button>`) + `</form>`;
}
