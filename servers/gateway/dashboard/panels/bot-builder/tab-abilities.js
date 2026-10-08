/**
 * Bot Builder — Abilities tab: files, run commands, memory, connected
 * services (one row per tool source: Off / Read-only / All / Custom…), skills.
 *
 * A source's mode is derived from the stored selection (tool-access.js). The
 * tool catalog the page was rendered with rides along as one hidden JSON
 * input, so a save expands All / Read-only without spawning MCP servers
 * again, and a source that failed to load is never rewritten.
 *
 * Inline script rule: ES5, no literal backtick, DOM text via textContent.
 */
import { escapeHtml, actionBar } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import {
  resolveCrowHome, listInstalledExtensions, extensionSkills,
} from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { loadSkills } from "./data-queries.js";
import { loadSources, MEMORY_SOURCE, sourceDisplay } from "./sources.js";
import { sourceMode } from "./tool-access.js";
import { filesMode } from "./def-adapter.js";
import { storedToBashUi, BASH_MODES_LIVE } from "./bash-mode.js";
import { segGroup, card } from "./ui.js";

function sourceRow(src, selected, lang, { memory = false } = {}) {
  const key = src.server;
  const fieldId = `src-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const disp = sourceDisplay(src, lang);
  const label = memory ? t("botbuilder.abMemory", lang) : disp.name;
  if (!src.ok) {
    const n = selected.filter((k) => k.startsWith(key + "/")).length;
    return `<div class="btb-src" data-src="${escapeHtml(key)}">` +
      `<div class="btb-src-head"><span class="btb-src-name">${escapeHtml(label)}</span>` +
      (disp.account ? ` <span class="btb-acct">${escapeHtml(disp.account)}</span>` : "") + `</div>` +
      `<p class="btb-hint">${escapeHtml(fill(t("botbuilder.abSourceFailed", lang), { n }))}` +
      (src.error ? ` <span class="btb-muted">(${escapeHtml(String(src.error).slice(0, 80))})</span>` : "") + `</p></div>`;
  }
  const mode = sourceMode(key, selected, src.catalog);
  const nRead = src.catalog.filter((x) => x.access === "read").length;
  const total = src.catalog.length;
  const sel = new Set(selected);
  const opts = memory
    ? [
        { value: "off", label: t("botbuilder.abOff", lang) },
        { value: "all", label: t("botbuilder.abOn", lang) },
        { value: "custom", label: t("botbuilder.abCustom", lang) },
      ]
    : [
        { value: "off", label: t("botbuilder.abOff", lang) },
        ...(nRead > 0 && nRead < total ? [{ value: "read", label: t("botbuilder.abReadOnly", lang) }] : []),
        { value: "all", label: t("botbuilder.abAll", lang) },
        { value: "custom", label: t("botbuilder.abCustom", lang) },
      ];
  // memory has no Read-only button: a stored read-only selection shows as Custom
  const shown = opts.some((o) => o.value === mode) ? mode : "custom";
  const on = selected.filter((k) => k.startsWith(key + "/")).length;
  const head = `<div class="btb-src-head"><span class="btb-src-name" id="${fieldId}-name">${escapeHtml(label)}</span>` +
    (disp.account ? ` <span class="btb-acct">${escapeHtml(disp.account)}</span>` : "") +
    ` <span class="btb-count" data-src-count>${escapeHtml(fill(t("botbuilder.abCount", lang), { on, total, reads: nRead }))}</span></div>`;
  const group = segGroup({
    name: `src__${key}`, legend: label, legendHidden: true, options: opts, current: shown, id: fieldId,
    hint: memory ? t("botbuilder.abMemoryHint", lang) : "",
  });
  const tools = src.catalog.map((x) => {
    const v = `${key}/${x.name}`;
    return `<label class="btb-tool" data-access="${x.access}"><input type="checkbox" name="tool__${escapeHtml(key)}" value="${escapeHtml(v)}"${sel.has(v) ? " checked" : ""}>` +
      `<span class="btb-tool-name">${escapeHtml(x.label && x.label !== x.name ? x.label : x.name)}</span>` +
      `<span class="btb-tag btb-tag-${x.access}">${escapeHtml(t(x.access === "read" ? "botbuilder.abTagRead" : "botbuilder.abTagWrite", lang))}</span></label>`;
  }).join("");
  const custom = `<details class="btb-details btb-custom"${shown === "custom" ? " open" : ""}><summary>${escapeHtml(fill(t("botbuilder.abChooseTools", lang), { n: total }))}</summary>` +
    `<div class="btb-custom-body"><input type="search" class="btb-input btb-tool-filter" aria-label="${escapeHtml(fill(t("botbuilder.abFilterLabel", lang), { source: label }))}" placeholder="${escapeHtml(t("botbuilder.abFilterPlaceholder", lang))}">` +
    `<div class="btb-tool-list">${tools}</div></div></details>`;
  return `<div class="btb-src" data-src="${escapeHtml(key)}">${head}${group}${custom}</div>`;
}

export async function renderAbilities(ctx) {
  const { def, lang, hidden } = ctx;
  const tools = def.tools || {};
  const selected = Array.isArray(tools.crow_mcp) ? tools.crow_mcp.filter((x) => typeof x === "string") : [];
  const builtin = Array.isArray(tools.pi_builtin) ? tools.pi_builtin : [];
  const pp = def.permission_policy || {};

  // ---- on this computer ----
  const fMode = filesMode(builtin);
  const filesCtl = segGroup({
    name: "files_mode", legend: t("botbuilder.abFiles", lang), current: fMode,
    options: [
      { value: "read", label: t("botbuilder.abFilesRead", lang) },
      { value: "edit", label: t("botbuilder.abFilesEdit", lang) },
    ],
    hint: t("botbuilder.abFilesHint", lang),
  });
  const cMode = storedToBashUi(pp);
  const cmdOpts = [
    { value: "off", label: t("botbuilder.abCmdOff", lang) },
    { value: "ask", label: t("botbuilder.abCmdAsk", lang) },
    { value: "auto", label: t("botbuilder.abCmdAuto", lang) },
  ].map((o) => (BASH_MODES_LIVE.has(o.value) || o.value === cMode)
    ? o : { ...o, disabled: true, note: t("botbuilder.abSoon", lang) });
  if (cMode === "list") cmdOpts.push({ value: "list", label: t("botbuilder.abCmdList", lang) });
  const cmdCtl = segGroup({
    name: "cmd_mode", legend: t("botbuilder.abCmd", lang), current: cMode, options: cmdOpts,
    hint: t(cMode === "list" ? "botbuilder.abCmdHintList" : "botbuilder.abCmdHint", lang),
  });

  const { error: probeErr, sources } = await loadSources();
  const memSrc = sources.find((s) => s.server === MEMORY_SOURCE);
  const others = sources.filter((s) => s.server !== MEMORY_SOURCE);
  const memRow = memSrc ? sourceRow(memSrc, selected, lang, { memory: true }) : "";

  const computer = card(t("botbuilder.abComputerTitle", lang), filesCtl + cmdCtl + memRow);

  const catalog = {};
  for (const s of sources) if (s.ok) catalog[s.server] = s.catalog.map((x) => [x.name, x.access]);
  const servicesBody =
    (probeErr ? `<p class="btb-err">${escapeHtml(fill(t("botbuilder.abProbeError", lang), { error: probeErr }))}</p>` : "") +
    (others.length ? others.map((s) => sourceRow(s, selected, lang)).join("") : `<p class="btb-hint">${escapeHtml(t("botbuilder.abNoSources", lang))}</p>`) +
    `<input type="hidden" name="src_catalog" value="${escapeHtml(JSON.stringify(catalog))}">`;
  const services = card(t("botbuilder.abServicesTitle", lang), servicesBody, t("botbuilder.abServicesLead", lang));

  // ---- skills (def.skills is the one store) ----
  const crowHome = resolveCrowHome();
  const allSkills = loadSkills(crowHome);
  const selSkills = new Set(Array.isArray(def.skills) ? def.skills : []);
  const chip = (s) => `<label class="btb-chip"><input type="checkbox" name="skills" value="${escapeHtml(s)}"${selSkills.has(s) ? " checked" : ""}> <span>${escapeHtml(s)}</span></label>`;
  const claimed = new Set();
  let groups = "";
  for (const ext of listInstalledExtensions(crowHome)) {
    const names = extensionSkills(ext).filter((n) => allSkills.includes(n));
    if (!names.length) continue;
    names.forEach((n) => claimed.add(n));
    groups += `<div class="btb-group"><label>${escapeHtml(ext.group || ext.id)}</label><div class="btb-chips">${names.map(chip).join("")}</div></div>`;
  }
  const general = allSkills.filter((n) => !claimed.has(n));
  // a selected skill whose file is gone stays visible (and selected) so a save keeps it
  const missing = [...selSkills].filter((n) => !allSkills.includes(n));
  if (general.length || missing.length) {
    groups += `<div class="btb-group"><label>${escapeHtml(t("botbuilder.skillsGroupGeneral", lang))}</label><div class="btb-chips">` +
      general.map(chip).join("") +
      missing.map((s) => `<label class="btb-chip btb-chip-missing"><input type="checkbox" name="skills" value="${escapeHtml(s)}" checked> <span>${escapeHtml(s)}</span> <span class="btb-muted">${escapeHtml(t("botbuilder.abSkillMissing", lang))}</span></label>`).join("") +
      `</div></div>`;
  }
  const skills = card(t("botbuilder.abSkillsTitle", lang),
    groups + `<input type="hidden" name="skills_rendered" value="1">`, t("botbuilder.abSkillsLead", lang));

  return `<form method="POST" class="btb-form" id="btb-abilities-form">${hidden("abilities")}` +
    computer + services + skills +
    actionBar(`<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.abSave", lang))}</button>`) +
    `</form>` + abilitiesScript();
}

function abilitiesScript() {
  return `<script>(function(){
    var rows=document.querySelectorAll('.btb-src[data-src]');
    for(var r=0;r<rows.length;r++){(function(row){
      var radios=row.querySelectorAll('input[type=radio]');
      var boxes=row.querySelectorAll('.btb-tool input[type=checkbox]');
      var det=row.querySelector('details.btb-custom');
      var filter=row.querySelector('.btb-tool-filter');
      function setMode(m){
        for(var i=0;i<radios.length;i++){ if(radios[i].value===m){ radios[i].checked=true; } }
      }
      function derive(){
        var on=0, reads=0, readsOn=0;
        for(var i=0;i<boxes.length;i++){
          var isRead=boxes[i].parentNode.getAttribute('data-access')==='read';
          if(isRead) reads++;
          if(boxes[i].checked){ on++; if(isRead) readsOn++; }
        }
        var m='custom';
        if(on===0) m='off';
        else if(on===boxes.length) m='all';
        else if(on===reads && readsOn===reads) m='read';
        var has=false;
        for(var j=0;j<radios.length;j++){ if(radios[j].value===m && !radios[j].disabled) has=true; }
        setMode(has?m:'custom');
      }
      for(var i=0;i<radios.length;i++){
        radios[i].addEventListener('change',function(){
          var m=this.value;
          if(m==='custom'){ if(det) det.open=true; return; }
          for(var k=0;k<boxes.length;k++){
            var isRead=boxes[k].parentNode.getAttribute('data-access')==='read';
            boxes[k].checked = m==='all' || (m==='read' && isRead);
          }
        });
      }
      for(var b=0;b<boxes.length;b++){ boxes[b].addEventListener('change',derive); }
      if(filter){ filter.addEventListener('input',function(){
        var v=filter.value.toLowerCase();
        for(var k=0;k<boxes.length;k++){
          var lab=boxes[k].parentNode;
          lab.hidden = !!v && lab.textContent.toLowerCase().indexOf(v)===-1;
        }
      }); }
    })(rows[r]);}
  })();</script>`;
}
