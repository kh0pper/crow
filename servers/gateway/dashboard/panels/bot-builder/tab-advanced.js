/**
 * Bot Builder — Advanced view: learning, helper agents, command list, board
 * and project, other Crows, tool-connection check, raw settings, delete.
 * Settings most bots never need, kept off the four main tabs.
 */
import { escapeHtml, actionBar } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t, tJs, fill } from "../../shared/i18n.js";
import { createDbClient } from "../../../../db.js";
import { serversForBot } from "../../../../../scripts/pi-bots/mcp_writer.mjs";
import { MULTI_AGENT_CAPABLE, isMultiAgentCapable } from "../../../../../scripts/pi-bots/pi_extensions_allowlist.mjs";
import { resolveModel } from "../../../../../scripts/pi-bots/model_resolver.mjs";
import { listProposals } from "../../../../../scripts/pi-bots/skill_proposals.mjs";
import { listBotSkillEvents } from "../../../../../scripts/pi-bots/skill_provenance.mjs";
import { readSetting } from "../../settings/registry.js";
import { TASKS_DB, gatherPeerTools, remoteInvocationOn } from "./data-queries.js";
import { hasArchivedAtColumn } from "../../../board/util.js";
import { learningMode } from "./def-adapter.js";
import { storedToBashUi } from "./bash-mode.js";
import { segGroup, scriptJson } from "./ui.js";

// Board / project: the former Project / Tracker tab, unchanged in behaviour.
async function renderBoard(ctx) {
  const { req, db, def, botId, lang } = ctx;
  // The board form saves through save_advanced (section "board"), which
  // only rewrites what changed; the legacy save_tracker stays for old pages.
  const hidden = () => ctx.hidden("advanced") + `<input type="hidden" name="adv_section" value="board">`;
  let body;
  let projects = [];
  try { projects = (await db.execute({ sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows; } catch {}
  let projOpts = projects.map((p) => `<option value="${p.id}"${Number(def.project_id) === Number(p.id) ? " selected" : ""}>#${p.id} &mdash; ${escapeHtml(p.name || "")} (${escapeHtml(p.slug || "")})</option>`).join("");
  // A linked project that is archived (so not in the list) stays linked.
  if (def.project_id != null && !projects.some((p) => Number(p.id) === Number(def.project_id))) {
    projOpts = `<option value="${Number(def.project_id)}" selected>${escapeHtml(fill(t("botbuilder.avProjectArchived", lang), { id: String(def.project_id) }))}</option>` + projOpts;
  }
  // Tracker defs for custom tracker dropdown — board_defs slug rows (Track 0
  // Phase B: tracker_defs/tracker_items converged into tasks.db). status_values
  // and fields_json AS columns_json MUST be selected here: the def editor below
  // reads selTracker.status_values / .columns_json from this same array, and
  // its save handler rebuilds columns_json from whatever it rendered — omitting
  // these columns fed it undefined/undefined, which wiped the def's fields on
  // the next "Save tracker definition" click (round-2 data-loss finding).
  let trackerDefs = [];
  {
    let tdefsDb;
    try {
      tdefsDb = createDbClient(TASKS_DB);
      trackerDefs = (await tdefsDb.execute({
        sql: "SELECT id, slug, display_name, status_values, fields_json AS columns_json FROM board_defs WHERE slug IS NOT NULL ORDER BY slug",
        args: [],
      })).rows;
    } catch {
    } finally {
      if (tdefsDb) { try { tdefsDb.close(); } catch {} }
    }
  }
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
      const guardArchived = (await hasArchivedAtColumn(tdb)) ? " AND archived_at IS NULL" : "";
      const rows = (await tdb.execute({
        sql: `SELECT status, COUNT(*) AS n FROM tasks_items WHERE project_id=?${guardArchived} GROUP BY status`,
        args: [Number(pid)],
      })).rows || [];
      // Group-by, not a hardcoded four: boards carry per-board status values
      // now (board_defs), and a custom status must count rather than vanish.
      let total = 0;
      const countParts = rows.map((r) => {
        total += Number(r.n);
        return `${escapeHtml(String(r.status))} <b>${Number(r.n)}</b>`;
      }).join(" &middot; ");
      snap =
        `<div class="btb-snapshot">` +
        `<b>${escapeHtml(fill(t("botbuilder.avSnapKanban", lang), { id: String(pid), n: total }))}</b> ` +
        (countParts || escapeHtml(t("botbuilder.avSnapNoCards", lang))) +
        `<br><a href="${boardHref}">${escapeHtml(t("botbuilder.avOpenBoard", lang))} &nearr;</a>` +
        `</div>`;
    } catch {
      snap = `<p class="btb-hint">${t("botbuilder.hintSnapshotUnavailable", lang)}</p>`;
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  } else if (ttype === "custom" && tc.tracker_slug) {
    let snapDb;
    try {
      snapDb = createDbClient(TASKS_DB);
      const tdef = (await snapDb.execute({ sql: "SELECT id, display_name, status_values FROM board_defs WHERE slug=?", args: [tc.tracker_slug] })).rows[0];
      if (tdef) {
        const guardArchived = (await hasArchivedAtColumn(snapDb)) ? " AND archived_at IS NULL" : "";
        const statusRows = (await snapDb.execute({ sql: `SELECT status, COUNT(*) AS n FROM tasks_items WHERE board_id=?${guardArchived} GROUP BY status`, args: [tdef.id] })).rows || [];
        const statusMap = {}; let total = 0;
        for (const r of statusRows) { statusMap[r.status] = Number(r.n); total += Number(r.n); }
        const statusList = JSON.parse(tdef.status_values || "[]");
        const countParts = statusList.map((s) => `${escapeHtml(s)} <b>${statusMap[s] || 0}</b>`).join(" &middot; ");
        snap =
          `<div class="btb-snapshot">` +
          `<b>${escapeHtml(fill(t("botbuilder.avSnapCustom", lang), { name: tdef.display_name, n: total }))}</b> ${countParts}` +
          `<br><a href="${boardHref}">${escapeHtml(t("botbuilder.avOpenBoard", lang))} &nearr;</a>` +
          `</div>`;
      }
    } catch {
      snap = `<p class="btb-hint">${t("botbuilder.hintSnapshotUnavailable", lang)}</p>`;
    } finally {
      if (snapDb) { try { snapDb.close(); } catch {} }
    }
  }
  body =
    `<form method="POST" class="btb-form">${hidden("tracker")}` +
    `<div class="btb-group"><label>${t("botbuilder.labelLinkedProject", lang)}</label>` +
    `<select name="project_id" class="btb-select"><option value="">${escapeHtml(t("botbuilder.bxNone", lang))}</option>${projOpts}</select></div>` +
    `<p class="btb-hint">${t("botbuilder.hintProjectDetermines", lang)}</p>` +
    `<hr class="btb-divider">` +
    `<div class="btb-group"><label>${t("botbuilder.labelTrackerType", lang)}</label>` +
    `<select name="tracker_type" class="btb-select">` +
    `<option value="kanban"${ttSel("kanban")}>${t("botbuilder.trackerOptKanban", lang)}</option>` +
    `<option value="task-list"${ttSel("task-list")}>${t("botbuilder.trackerOptTaskList", lang)}</option>` +
    `<option value="custom"${ttSel("custom")}>${t("botbuilder.trackerOptCustom", lang)}</option>` +
    `<option value="none"${ttSel("none")}>${t("botbuilder.trackerOptNone", lang)}</option>` +
    `</select></div>` +
    `<div id="custom-tracker-fields" style="${ttype !== "custom" ? "display:none" : ""}">` +
    `<div class="btb-group"><label>${t("botbuilder.labelTrackerSlug", lang)}</label>` +
    `<select name="tracker_slug" class="btb-select"><option value="">${escapeHtml(t("botbuilder.avSelectBoard", lang))}</option>` +
    // a custom board that was deleted stays selected (and saved) as itself
    (tc.tracker_slug && !trackerDefs.some((td) => td.slug === tc.tracker_slug)
      ? `<option value="${escapeHtml(tc.tracker_slug)}" selected>${escapeHtml(fill(t("botbuilder.avBoardMissing", lang), { slug: tc.tracker_slug }))}</option>` : "") +
    `${trackerOpts}</select></div>` +
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
        `<h4 style="margin:0 0 .5rem">${escapeHtml(fill(t("botbuilder.avTdefTitle", lang), { name: selTracker.display_name }))}</h4>` +
        `<p class="btb-hint" style="margin:0 0 .75rem">${t("botbuilder.hintTrackerDefEdit", lang)}</p>` +
        `<div id="bb-tracker-def-msg" class="btb-tdef-msg"></div>` +
        `<div class="btb-group"><label>${t("botbuilder.tdefLabelDisplayName", lang)}</label>` +
        `<input id="bb-tdef-name" value="${escapeHtml(selTracker.display_name)}" class="btb-input" style="max-width:300px"></div>` +
        `<div class="btb-group"><label>${t("botbuilder.tdefLabelStatusColumns", lang)}</label>` +
        `<input id="bb-tdef-statuses" value="${escapeHtml(svText)}" class="btb-input" placeholder="pending, processing, received, done"></div>` +
        `<p class="btb-hint" style="margin-top:-.5rem">${t("botbuilder.hintTrackerColumns", lang)}</p>` +
        `<div class="btb-group"><label>${t("botbuilder.tdefLabelDataFields", lang)}</label>` +
        `<div class="table-scroll"><table class="btb-table">` +
        `<thead><tr><th>${t("botbuilder.avThKey", lang)}</th><th>${t("botbuilder.avThLabel", lang)}</th><th>${t("botbuilder.avThType", lang)}</th><th>${t("botbuilder.avThReq", lang)}</th></tr></thead>` +
        `<tbody id="bb-tdef-cols">${colRows}</tbody></table></div></div>` +
        `<button type="button" class="btb-btn btb-btn-sec btb-btn-sm" id="bb-tdef-add-col">+ ${t("botbuilder.avAddField", lang)}</button>` +
        `<div style="margin-top:.75rem">` +
        `<button type="button" class="btb-btn" id="bb-tdef-save">${t("botbuilder.avSaveTdef", lang)}</button>` +
        `</div>` +
        `<script>(function(){
          var API='/dashboard/bot-board-api';
          var slug=${scriptJson(tc.tracker_slug)};
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
            if(!name){tdefMsg('${tJs("botbuilder.avTdefNameReq", lang)}','err');return;}
            var svRaw=document.getElementById('bb-tdef-statuses').value;
            var statuses=svRaw.split(',').map(function(s){return s.trim();}).filter(Boolean);
            if(!statuses.length){tdefMsg('${tJs("botbuilder.avTdefStatusReq", lang)}','err');return;}
            var cols=[];
            var tbody=document.getElementById('bb-tdef-cols');
            var rows=tbody.querySelectorAll('tr');
            rows.forEach(function(row){
              var inputs=row.querySelectorAll('input,select');
              var key=(inputs[0]&&inputs[0].value||'').trim();
              if(!key)return;
              cols.push({key:key,label:(inputs[1]&&inputs[1].value||'').trim()||key,type:(inputs[2]&&inputs[2].value||'text'),required:!!(inputs[3]&&inputs[3].checked)});
            });
            tdefMsg('${tJs("botbuilder.avSaving", lang)}','');
            fetch(API+'/tracker/'+encodeURIComponent(slug),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:name,status_values:statuses,columns_json:cols}),credentials:'same-origin'})
            .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
            .then(function(r){
              if(r.ok){tdefMsg('${tJs("botbuilder.avTdefSaved", lang)}','ok');}
              else{tdefMsg((r.j&&(r.j.error||r.j.reason))||'${tJs("botbuilder.avSaveFailed", lang)}','err');}
            });
          };
        })();</script>`;
    })();
  return body;
}

function section(id, title, summaryNote, body, open) {
  return `<details class="btb-adv-sec" id="${id}"${open ? " open" : ""}><summary><span class="btb-adv-title">${escapeHtml(title)}</span>` +
    (summaryNote ? ` <span class="btb-adv-note">${escapeHtml(summaryNote)}</span>` : "") + `</summary><div class="btb-adv-body">${body}</div></details>`;
}

function advForm(ctx, sectionId, inner, saveLabel) {
  return `<form method="POST" class="btb-form">${ctx.hidden("advanced")}<input type="hidden" name="adv_section" value="${sectionId}">` +
    inner + actionBar(`<button type="submit" class="btb-btn">${escapeHtml(saveLabel)}</button>`) + `</form>`;
}

function renderLearning(ctx) {
  const { def, botId, lang } = ctx;
  const pp = def.permission_policy || {};
  const mode = learningMode(pp);
  const opts = [
    { value: "off", label: t("botbuilder.avLearnOff", lang) },
    { value: "propose", label: t("botbuilder.avLearnPropose", lang) },
    { value: "auto", label: t("botbuilder.avLearnAuto", lang) },
  ];
  if (mode === "custom") opts.push({ value: "custom", label: t("botbuilder.avLearnCustom", lang) });
  const ctl = advForm(ctx, "learning", segGroup({
    name: "learn_mode", legend: t("botbuilder.avLearnLegend", lang), current: mode, options: opts,
    hint: t(mode === "custom" ? "botbuilder.avLearnHintCustom" : "botbuilder.avLearnHint", lang),
  }), t("botbuilder.avSave", lang));

  let proposals = [];
  try { proposals = listProposals(def.session_dir); } catch { proposals = []; }
  const proposalsHtml = proposals.length
    ? proposals.map((p) => {
        const badges = p.flags.length
          ? p.flags.map((f) => `<span class="btb-flag" title="${escapeHtml(f.snippet)}">&#9888; ${escapeHtml(f.label)}</span>`).join("")
          : `<span class="btb-muted">${escapeHtml(t("botbuilder.avNoFlags", lang))}</span>`;
        const ta = `bb-prop-${escapeHtml(p.name)}`;
        return `<div class="btb-proposal"><div><code>${escapeHtml(p.name)}.md</code> ${badges}</div>` +
          `<textarea id="${ta}" class="btb-textarea btb-textarea-wide" rows="10" aria-label="${escapeHtml(p.name)}">${escapeHtml(p.text)}</textarea>` +
          `<div class="btb-actions-row">` +
          `<button type="button" class="btb-btn bb-prop-approve" data-name="${escapeHtml(p.name)}" data-ta="${ta}">${escapeHtml(t("botbuilder.avApprove", lang))}</button>` +
          `<button type="button" class="btb-btn btb-btn-sec bb-prop-reject" data-name="${escapeHtml(p.name)}">${escapeHtml(t("botbuilder.avReject", lang))}</button>` +
          `<span class="bb-prop-status btb-send-status" aria-live="polite"></span></div></div>`;
      }).join("")
    : `<p class="btb-muted">${t("botbuilder.noticeNoProposedSkills", lang)}</p>`;
  const propScript = `<script>(function(){
    var API='/dashboard/bot-board-api';
    var bot=${scriptJson(botId)};
    function post(url,body,el,onok){
      el.textContent='${tJs("botbuilder.avWorking", lang)}';
      fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'})
        .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
        .then(function(x){ if(x.ok&&x.j&&x.j.ok){ onok(); } else { el.textContent=(x.j&&(x.j.error||x.j.reason))||'${tJs("botbuilder.avSaveFailed", lang)}'; } })
        .catch(function(e){ el.textContent='${tJs("botbuilder.avSaveFailed", lang)}'+' '+e.message; });
    }
    document.querySelectorAll('.bb-prop-approve').forEach(function(btn){
      btn.onclick=function(){
        var name=this.getAttribute('data-name');
        var ta=document.getElementById(this.getAttribute('data-ta'));
        var st=this.parentNode.querySelector('.bb-prop-status');
        if(!confirm('${tJs("botbuilder.confirmApproveSkill", lang)}'.replace('{name}',name))) return;
        post(API+'/bot/'+encodeURIComponent(bot)+'/proposed-skill/approve',{name:name,content:ta.value},st,function(){ location.reload(); });
      };
    });
    document.querySelectorAll('.bb-prop-reject').forEach(function(btn){
      btn.onclick=function(){
        var name=this.getAttribute('data-name');
        var st=this.parentNode.querySelector('.bb-prop-status');
        if(!confirm('${tJs("botbuilder.confirmRejectSkill", lang)}'.replace('{name}',name))) return;
        post(API+'/bot/'+encodeURIComponent(bot)+'/proposed-skill/reject',{name:name},st,function(){ location.reload(); });
      };
    });
  })();</script>`;

  let events = [];
  try { events = listBotSkillEvents(botId, 25); } catch { events = []; }
  const rows = events.map((e) =>
    `<tr><td>${escapeHtml(e.created_at || "")}</td><td>${escapeHtml(t("botbuilder.avEvent_" + (["create", "patch", "propose", "downgrade", "reject"].includes(e.action) ? e.action : "other"), lang))}</td>` +
    `<td><code>${escapeHtml(e.skill_name || "")}</code></td><td>${escapeHtml(e.mode || "")}</td>` +
    `<td>${e.flags_json && e.flags_json !== "null" ? "&#9888;" : ""}</td></tr>`).join("");
  const history = `<div class="btb-group"><label>${t("botbuilder.labelSelfLearningHistory", lang)}</label>` +
    `<p class="btb-hint">${t("botbuilder.hintSelfLearningFeed", lang)}</p>` +
    (events.length
      ? `<div class="table-scroll"><table class="btb-table"><thead><tr><th>${t("botbuilder.avThWhen", lang)}</th><th>${t("botbuilder.avThWhat", lang)}</th><th>${t("botbuilder.avThSkill", lang)}</th><th>${t("botbuilder.avThMode", lang)}</th><th>&#9888;</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="btb-hint">${t("botbuilder.noticeNoSelfLearning", lang)}</p>`) + `</div>`;

  const note = t("botbuilder.learnState_" + mode, lang) + (proposals.length ? " · " + fill(t("botbuilder.avWaitingN", lang), { n: proposals.length }) : "");
  return section("learning", t("botbuilder.avLearnTitle", lang), note,
    ctl + `<div class="btb-group"><label>${t("botbuilder.labelProposedSkills", lang)}</label>` +
    `<p class="btb-hint">${t("botbuilder.skillsHintProposals", lang)}</p>${proposalsHtml}</div>` + propScript + history,
    ctx.q.open === "learning" || proposals.length > 0);
}

async function renderHelpers(ctx) {
  const { def, lang } = ctx;
  const on = !!(def.permission_policy && def.permission_policy.multi_agent === true);
  let modelKey = (def.models && def.models.default) || "";
  let capable = false;
  try {
    const r = await resolveModel(def, { escalate: false });
    modelKey = r.key || modelKey;
    capable = isMultiAgentCapable(r.provider, r.model);
  } catch { capable = false; }
  const explain = capable
    ? fill(t("botbuilder.avHelpersCapable", lang), { model: modelKey })
    : fill(t("botbuilder.avHelpersNotCapable", lang), { model: modelKey || "—", list: MULTI_AGENT_CAPABLE.join(", ") });
  const body = advForm(ctx, "helpers",
    `<label class="btb-checkbox btb-check-row"><input type="checkbox" name="multi_agent"${on ? " checked" : ""}> ${escapeHtml(t("botbuilder.avHelpersLabel", lang))}</label>` +
    `<input type="hidden" name="multi_agent__was" value="${on ? "on" : "off"}">` +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.avHelpersHint", lang))}</p><p class="btb-hint">${escapeHtml(explain)}</p>`,
    t("botbuilder.avSave", lang));
  const note = on ? (capable ? t("botbuilder.avOnWorks", lang) : t("botbuilder.avOnBlocked", lang)) : t("botbuilder.abOff", lang);
  return section("helpers", t("botbuilder.avHelpersTitle", lang), note, body, false);
}

function renderCommandList(ctx) {
  const { def, lang } = ctx;
  const pp = def.permission_policy || {};
  const mode = storedToBashUi(pp);
  const allow = Array.isArray(pp.bash_allow) ? pp.bash_allow : [];
  const body = advForm(ctx, "commands",
    `<label class="btb-checkbox btb-check-row"><input type="checkbox" name="cmd_list"${mode === "list" ? " checked" : ""}> ${escapeHtml(t("botbuilder.avCmdUseList", lang))}</label>` +
    `<input type="hidden" name="cmd_mode__was" value="${escapeHtml(mode)}">` +
    `<div class="btb-group"><label for="av-allow">${escapeHtml(t("botbuilder.avCmdAllowed", lang))}</label>` +
    `<textarea id="av-allow" name="pp_bash_allow" rows="4" class="btb-textarea">${escapeHtml(allow.join("\n"))}</textarea>` +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.avCmdAllowedHint", lang))}</p></div>`,
    t("botbuilder.avSave", lang));
  return section("commands", t("botbuilder.avCmdTitle", lang), mode === "list" ? t("botbuilder.avInUse", lang) : t("botbuilder.avNotInUse", lang), body, false);
}

async function renderPeers(ctx) {
  const { req, db, def, botId, lang } = ctx;
  const peerTools = await gatherPeerTools(db);
  const remoteOn = await remoteInvocationOn(db);
  const seen = new Set();
  const caps = [];
  for (const tb of peerTools) {
    const key = `${tb.instanceId}::${tb.canonicalId}`;
    if (!tb.canonicalId || seen.has(key)) continue;
    seen.add(key);
    caps.push(tb);
  }
  const selected = new Set((def.tools && def.tools.remote_mcp) || []);
  let capsHtml = "";
  if (caps.length) {
    capsHtml = advForm(ctx, "peers",
      `<p class="btb-hint">${t(remoteOn ? "botbuilder.hintPeerCapsOn" : "botbuilder.hintPeerCapsOff", lang)}</p>` +
      `<ul class="btb-plain-list">` + caps.map((tb) => {
        const key = `${tb.instanceId}::${tb.canonicalId}`;
        const label = `${escapeHtml(tb.name)} <span class="btb-muted">(${escapeHtml(tb.category)} · ${escapeHtml(tb.instanceName)})</span>`;
        if (remoteOn && tb.exposed === true) {
          return `<li><label class="btb-checkbox"><input type="checkbox" name="remote_mcp" value="${escapeHtml(key)}"${selected.has(key) ? " checked" : ""}> ${label}</label></li>`;
        }
        return `<li><label class="btb-checkbox btb-disabled"><input type="checkbox" disabled> ${label} <span class="btb-muted">— ${escapeHtml(t(remoteOn ? "botbuilder.avPeerNotExposed" : "botbuilder.avPeerOff", lang))}</span></label></li>`;
      }).join("") + `</ul>`,
      t("botbuilder.avSave", lang));
  } else {
    capsHtml = `<p class="btb-hint">${escapeHtml(t("botbuilder.avPeerNone", lang))}</p>`;
  }
  let isManaged = false;
  try { const a = JSON.parse((await readSetting(db, "remote_managed_bots")) || "[]"); if (Array.isArray(a)) isManaged = a.includes(botId); } catch {}
  const managed =
    `<form method="POST" class="btb-form"><input type="hidden" name="action" value="toggle_peer_managed">` +
    `<input type="hidden" name="bot_id" value="${escapeHtml(botId)}">${csrfInput(req)}` +
    `<label class="btb-checkbox btb-check-row"><input type="checkbox" name="managed"${isManaged ? " checked" : ""} onchange="this.form.requestSubmit ? this.form.requestSubmit() : this.form.submit()"> ` +
    `${escapeHtml(t("botbuilder.avPeerManaged", lang))}</label>` +
    `<noscript><button type="submit" class="btb-btn btb-btn-sec btb-btn-sm">${escapeHtml(t("botbuilder.avSave", lang))}</button></noscript></form>`;
  return section("peers", t("botbuilder.avPeersTitle", lang), isManaged ? t("botbuilder.avShared", lang) : t("botbuilder.avNotShared", lang), managed + capsHtml, false);
}

function renderCheck(ctx) {
  const { req, botId, lang, q } = ctx;
  const msg = q.mcp ? `<p class="btb-notice-ok">${escapeHtml(String(q.mcp))}</p>` : "";
  return section("check", t("botbuilder.btnRegenMcp", lang), "",
    msg + `<p class="btb-hint">${escapeHtml(t("botbuilder.avCheckHint", lang))}</p>` +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.avCheckServers", lang))} <code>${escapeHtml(serversForBot(ctx.def).join(", ") || "—")}</code></p>` +
    `<form method="POST"><input type="hidden" name="action" value="regen_mcp"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">${csrfInput(req)}` +
    `<button type="submit" class="btb-btn btb-btn-sec">${escapeHtml(t("botbuilder.avCheckNow", lang))}</button></form>`,
    !!q.mcp);
}

async function renderRaw(ctx) {
  const { def, lang } = ctx;
  let eff = "";
  try {
    const rDef = await resolveModel(def, { escalate: false });
    const rEsc = await resolveModel(def, { escalate: true });
    const maOn = !!(def.permission_policy && def.permission_policy.multi_agent);
    const capable = isMultiAgentCapable(rDef.provider, rDef.model);
    const escConfigured = !!(def.models && def.models.escalation);
    eff = `<dl class="btb-kv">` +
      `<dt>${escapeHtml(t("botbuilder.avRunsWith", lang))}</dt><dd><code>${escapeHtml(rDef.key)}</code>${rDef.source === "fallback" ? ` <span class="btb-review-fallback">${escapeHtml(t("botbuilder.avFallback", lang))}</span>` : ""}</dd>` +
      `<dt>${escapeHtml(t("botbuilder.bxStronger", lang))}</dt><dd>${escConfigured ? `<code>${escapeHtml(rEsc.key)}</code>` + (rEsc.escalationRequestedButUnavailable ? ` <span class="btb-review-fallback">${escapeHtml(t("botbuilder.avEscUnavailable", lang))}</span>` : "") : escapeHtml(t("botbuilder.bxNone", lang))}</dd>` +
      `<dt>${escapeHtml(t("botbuilder.avHelpersTitle", lang))}</dt><dd>${escapeHtml(t(maOn && capable ? "botbuilder.avHelpersAllowed" : "botbuilder.avHelpersBlocked", lang))}</dd>` +
      `</dl>`;
  } catch (e) {
    eff = `<p class="btb-notice-warn">${escapeHtml(String(e.message || e))}</p>`;
  }
  return section("raw", t("botbuilder.avRawTitle", lang), "",
    eff + `<div class="btb-group"><label>${escapeHtml(t("botbuilder.avStoredDef", lang))}</label>` +
    `<pre class="btb-pre">${escapeHtml(JSON.stringify(def, null, 2))}</pre></div>`, false);
}

function renderDelete(ctx) {
  const { botId, lang } = ctx;
  return section("delete", t("botbuilder.avDeleteTitle", lang), "",
    `<p class="btb-hint">${escapeHtml(t("botbuilder.avDeleteHint", lang))}</p>` +
    `<p><a class="btb-danger-link" href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&amp;confirm_delete=1">${t("botbuilder.deleteBotLink", lang)}</a></p>`, false);
}

export async function renderAdvanced(ctx) {
  const { lang } = ctx;
  const board = section("board", t("botbuilder.avBoardTitle", ctx.lang), "", await renderBoard(ctx), ctx.q.open === "board");
  return `<p class="btb-hint">${escapeHtml(t("botbuilder.avLead", lang))}</p>` +
    renderLearning(ctx) + await renderHelpers(ctx) + renderCommandList(ctx) + board +
    await renderPeers(ctx) + renderCheck(ctx) + await renderRaw(ctx) + renderDelete(ctx) +
    // a #fragment (bot-board's "set up" link lands on #board) opens its section
    `<script>(function(){var h=(location.hash||'').slice(1);if(!h)return;var d=document.getElementById(h);if(d&&d.tagName==='DETAILS'){d.open=true;}})();</script>`;
}
