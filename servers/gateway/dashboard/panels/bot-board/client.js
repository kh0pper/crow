/**
 * Bot Board Panel — Client JavaScript
 *
 * SSE live overlay, drag-and-drop, and slide-over drawer logic.
 * Returns an inline <script> block; uses tJs() for JS-context strings.
 */

import { tJs } from "../../shared/i18n.js";
import { birdDrawerJs } from "./drawer.js";

export function clientJs(botId, trackerType, projectId, trackerSlug, contextFields, lang, includeArchived) {
  const bi = botId == null ? "null" : JSON.stringify(String(botId));
  const tt = JSON.stringify(String(trackerType || "none"));
  const pj = projectId == null ? "null" : JSON.stringify(Number(projectId));
  const ts = trackerSlug ? JSON.stringify(String(trackerSlug)) : "null";
  const cf = contextFields ? JSON.stringify(contextFields) : "[]";
  // D-T1.6: the "Show archived" view mixes archived cards INTO the DOM, but
  // the SSE tick's row set always excludes them (streams.js) — with the live
  // overlay attached, every archived-visible card would look "removed" on
  // the very first tick and reload the page immediately. The archived view
  // is a static inspect/manage screen; skip EventSource entirely for it.
  const ia = includeArchived ? "true" : "false";
  // Optional notes viewer base URL (e.g. "https://host/notes/"). When unset,
  // the drawer shows plain "note #<id>" text — honest absence over a dead
  // link to somebody's lab host.
  const nb = JSON.stringify(String(process.env.CROW_BOT_BOARD_NOTES_URL || ""));
  return `<script>(function(){
  var NOTES_BASE=${nb};
  var BOT_ID=${bi};
  var TRACKER_TYPE=${tt};
  var PROJECT=${pj};
  var INCLUDE_ARCHIVED=${ia};
  window._trackerSlug=${ts};
  window._bbContextFields=${cf};
  document.body.classList.add('bb-js');
  var API='/dashboard/bot-board-api';
  function $(id){return document.getElementById(id);}
  function clearEl(e){ while(e&&e.firstChild) e.removeChild(e.firstChild); }
  function optEl(v,t,sel){ var o=document.createElement('option'); o.value=v; o.textContent=t; if(sel) o.selected=true; return o; }
  function api(method,path,body){
    return fetch(API+path,{method:method,headers:{'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,credentials:'same-origin'})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,status:r.status,j:j};});});
  }
  function reload(){ location.reload(); }

  var drawer=$('bb-drawer'), trackerDrawer=$('bb-tracker-drawer'), cur=null, dragId=null, dragType=null;
  // Track 1: plans are RECORDS now (board_plans), not a file — no mtime
  // optimistic-concurrency any more. planCurrentStatus drives the Approve
  // button's visibility (only a 'draft' current version is approvable).
  var planVersions=[], planCurrentVersion=null, planCurrentStatus=null;
  function openDrawer(el){ if(el){el.classList.add('bb-open');el.setAttribute('aria-hidden','false');} }
  function closeDrawer(el){ if(el){el.classList.remove('bb-open');el.setAttribute('aria-hidden','true');} }
  function msg(el,txt,cls){ if(!el) return; el.className='bb-msg '+(cls||''); el.textContent=txt||''; }
  // Track 1 (D-T1.6): a 409 from an archive-aware route carries r.j.code —
  // map the KNOWN codes to the i18n'd string; anything else falls back to
  // the server's raw (EN-only) reason, same as every other error path here.
  function errText(r,fallback){
    if(r&&r.j&&r.j.code==='archived') return '${tJs("board.errArchived", lang)}';
    if(r&&r.j&&r.j.code==='locked') return '${tJs("board.errLocked", lang)}';
    return (r&&r.j&&(r.j.reason||r.j.error))||fallback;
  }

  // ---- Plan tab: version history strip + approve button (built once; no
  // static markup edit needed — inserted next to the existing plan fields) ----
  var planVersionsWrap=null, planApproveBtn=null;
  (function buildPlanVersionUi(){
    var ta=$('bb-d-plan');
    if(ta && ta.parentNode){
      planVersionsWrap=document.createElement('div');
      planVersionsWrap.id='bb-d-plan-versions';
      planVersionsWrap.className='bb-msg';
      planVersionsWrap.style.cssText='margin:.3rem 0 .5rem;display:flex;flex-wrap:wrap;gap:.3rem;align-items:center';
      ta.parentNode.insertBefore(planVersionsWrap, ta);
    }
    var saveBtn=$('bb-d-plan-save');
    if(saveBtn && saveBtn.parentNode){
      planApproveBtn=document.createElement('button');
      planApproveBtn.type='button';
      planApproveBtn.className='bb-btn bb-sec';
      planApproveBtn.id='bb-d-plan-approve';
      planApproveBtn.style.cssText='display:none;margin-left:.4rem';
      planApproveBtn.textContent='${tJs("botboard.btnApprovePlan", lang)}';
      saveBtn.parentNode.insertBefore(planApproveBtn, saveBtn.nextSibling);
    }
  })();
  function renderPlanVersions(){
    if(!planVersionsWrap) return;
    clearEl(planVersionsWrap);
    if(!planVersions.length) return;
    var label=document.createElement('span');
    label.textContent='${tJs("botboard.planVersionsLabel", lang)}';
    planVersionsWrap.appendChild(label);
    planVersions.forEach(function(v){
      var b=document.createElement('span');
      b.className='bb-list-status';
      b.textContent='v'+v.version+' ('+v.status+')';
      planVersionsWrap.appendChild(b);
    });
  }

  // ---- Kanban card drawer ----
  function cardData(cardEl){
    return {id:Number(cardEl.getAttribute('data-card')),
            status:cardEl.getAttribute('data-status'),
            locked:cardEl.getAttribute('data-locked')==='1',
            archived:cardEl.getAttribute('data-archived')==='1',
            itemType:cardEl.getAttribute('data-item-type')||'kanban'};
  }
  // Track 1 (D-T1.6): the drawer disables the same field set for an archived
  // card as for a locked one — archived refuses move/update just like a
  // bot-held lock does — and swaps which of Archive/Unarchive is shown.
  function applyArchivedUi(archiveBtn,unarchiveBtn,fieldIds,archived,locked){
    if(archiveBtn) archiveBtn.style.display=(!archived&&!locked)?'':'none';
    if(unarchiveBtn) unarchiveBtn.style.display=archived?'':'none';
    fieldIds.forEach(function(i){ var e=$(i); if(e) e.disabled=locked||archived; });
  }
  function fillDrawer(cardEl){
    cur=cardData(cardEl);
    $('bb-d-title').textContent='${tJs("botboard.jsCardPrefix", lang)}'+cur.id;
    var t0=cardEl.querySelector('.bb-title');
    $('bb-d-title-in').value=t0?t0.textContent:'';
    $('bb-d-status').value=cur.status;
    msg($('bb-d-msg'),'','');
    var lk=$('bb-d-lock'), unlock=$('bb-d-unlock');
    if(cur.locked){ lk.textContent='\\uD83D\\uDD12 ${tJs("botboard.jsCardLockedPre", lang)}\\u2014 ${tJs("botboard.jsCardLockedPost", lang)}';
      unlock.style.display=''; } else { lk.textContent=''; unlock.style.display='none'; }
    var d_archiveBtn=$('bb-d-archive'), d_unarchiveBtn=$('bb-d-unarchive');
    var DRAWER_FIELD_IDS=['bb-d-title-in','bb-d-status','bb-d-prio','bb-d-due','bb-d-owner','bb-d-tags','bb-d-desc','bb-d-project','bb-d-autonomy','bb-d-save','bb-d-cancel','bb-d-plan','bb-d-plan-save','bb-d-plan-approve'];
    applyArchivedUi(d_archiveBtn,d_unarchiveBtn,DRAWER_FIELD_IDS,cur.archived,cur.locked);
    api('GET','/card/'+cur.id).then(function(r){
      if(r.ok&&r.j&&r.j.card){var c=r.j.card;
        // Server truth wins over the DOM snapshot (cur.archived came from the
        // stale card face) — refresh cur + the Archive/Unarchive affordance.
        cur.archived=c.archived_at!=null;
        applyArchivedUi(d_archiveBtn,d_unarchiveBtn,DRAWER_FIELD_IDS,cur.archived,cur.locked);
        $('bb-d-title-in').value=c.title||'';
        // An off-def status must stay representable: inject it as an option so
        // Save cannot silently rewrite the card to the first configured value.
        var ss0=$('bb-d-status'), want=c.status||'pending';
        if(ss0 && ![].slice.call(ss0.options).some(function(o){return o.value===want;})){
          ss0.appendChild(optEl(want, want+' (off-board)', false));
        }
        $('bb-d-status').value=want;
        $('bb-d-prio').value=c.priority==null?'':String(c.priority);
        $('bb-d-due').value=c.due_date||'';
        $('bb-d-owner').value=c.owner||'';
        $('bb-d-tags').value=c.tags||'';
        $('bb-d-desc').value=c.description||'';
        if($('bb-d-autonomy')) $('bb-d-autonomy').value=r.j.autonomy||c.autonomy||'gated';
        var ps=$('bb-d-project'); clearEl(ps); ps.appendChild(optEl('','\\u2014 none \\u2014',false));
        (r.j.projects||[]).forEach(function(p){
          ps.appendChild(optEl(String(p.id),'#'+p.id+' \\u2014 '+(p.name||''),Number(c.project_id)===Number(p.id)));
        });
        // Track 1 Task 9 (D-T1.3/D-T1.5): the drawer's history strip and
        // result/approve affordances hydrate off the SAME GET /card/:id
        // response — additive keys, no extra round trip.
        renderHistory(r.j.mutations||[]);
        renderResults(r.j.latest_results||[], (r.j.board&&r.j.board.terminal_values)||[]);
      } else if(!r.ok){ crowToast('${tJs("botboard.loadFailed", lang)}', {type:'error'}); }
    }).catch(function(){ crowToast('${tJs("botboard.loadFailed", lang)}', {type:'error'}); });
    loadPlan();
    openDrawer(drawer);
  }
  function loadPlan(){
    var pm=$('bb-d-plan-msg'); msg(pm,'loading\\u2026','');
    api('GET','/card/'+cur.id+'/plan').then(function(r){
      if(r.ok&&r.j){
        planVersions=r.j.versions||[];
        renderPlanVersions();
        if(r.j.current){
          $('bb-d-plan').value=r.j.current.body_md||'';
          planCurrentVersion=r.j.current.version;
          planCurrentStatus=r.j.current.status;
          msg(pm,'','');
        } else {
          $('bb-d-plan').value='';
          planCurrentVersion=null; planCurrentStatus=null;
          msg(pm,'${tJs("botboard.planPlaceholder", lang)}','');
        }
        if(planApproveBtn) planApproveBtn.style.display=(planCurrentStatus==='draft')?'':'none';
        renderPre();
      } else { msg(pm, (r.j&&r.j.reason)||'plan unavailable','warn'); }
    }).catch(function(){ crowToast('${tJs("botboard.loadFailed", lang)}', {type:'error'}); });
  }
  function renderPre(){ var el=$('bb-d-plan-pre'); if(el) el.textContent=$('bb-d-plan').value; }

  // ---- History strip (D-T1.3): read-only, latest N=10 board_mutations,
  // actor-attributed — GET /card/:id's additive 'mutations' key. ----
  var MUTATION_VERB_LABELS={
    create:'${tJs("board.mutationVerb.create", lang)}',
    update:'${tJs("board.mutationVerb.update", lang)}',
    move:'${tJs("board.mutationVerb.move", lang)}',
    archive:'${tJs("board.mutationVerb.archive", lang)}',
    unarchive:'${tJs("board.mutationVerb.unarchive", lang)}',
    plan_save:'${tJs("board.mutationVerb.plan_save", lang)}',
    plan_approve:'${tJs("board.mutationVerb.plan_approve", lang)}',
    result_report:'${tJs("board.mutationVerb.result_report", lang)}',
    result_decide:'${tJs("board.mutationVerb.result_decide", lang)}'
  };
  function actorLabel(m){
    if(m.actor_kind==='bot') return m.actor_id||'bot';
    if(m.actor_kind==='session') return '${tJs("board.actorSession", lang)}';
    return '${tJs("board.actorHuman", lang)}';
  }
  function renderHistory(mutations){
    var el=$('bb-d-history'); if(!el) return;
    clearEl(el);
    if(!mutations||!mutations.length){ el.textContent='${tJs("board.noHistory", lang)}'; return; }
    mutations.forEach(function(m){
      var row=document.createElement('div');
      row.className='bb-history-row';
      row.style.cssText='font-size:.8rem;padding:.15rem 0;border-bottom:1px solid var(--crow-border-subtle,#0000)';
      row.textContent=(MUTATION_VERB_LABELS[m.verb]||m.verb)+' \\u2014 '+actorLabel(m)+' \\u2014 '+(m.created_at||'');
      el.appendChild(row);
    });
  }

  // ---- Result banner + approve/reject/"approve & mark done" (D-T1.5) ----
  // GET /card/:id's additive 'latest_results' key (newest first, D-T1.5's
  // result-service.listResults). Only the latest 'recorded' result gets an
  // affordance — a decided (approved/rejected) result is history, not action.
  function decideResult(resultId,decision){
    if(!cur) return;
    api('POST','/card/'+cur.id+'/result/'+resultId+'/decide',{decision:decision}).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("botboard.jsSaved", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-d-msg'),errText(r,'failed'),'err');
    });
  }
  function approveAndMarkDone(resultId){
    if(!cur) return;
    // Two writes, both recorded (D-T1.5): decide (approve) the result, THEN
    // move the card to 'done' — decideResult never auto-moves, by design.
    api('POST','/card/'+cur.id+'/result/'+resultId+'/decide',{decision:'approved'}).then(function(r){
      if(!r.ok){ msg($('bb-d-msg'),errText(r,'failed'),'err'); return; }
      api('POST','/card/'+cur.id+'/move',{status:'done'}).then(function(r2){
        if(r2.ok){ msg($('bb-d-msg'),'${tJs("botboard.jsSaved", lang)}','ok'); setTimeout(reload,400); }
        else msg($('bb-d-msg'),errText(r2,'failed'),'err');
      });
    });
  }
  // Track 3 Task 14: the SAME Accept/Reject affordance, now on the card FACE
  // itself (data-result-actions, html.js's cardFaceHtml) — reads cardId/
  // resultId off the delegated click's own DOM instead of the drawer's cur.
  function cardResultDecide(actionsEl,btnEl){
    var cardEl=actionsEl.closest('.bb-card');
    var cardId=cardEl?Number(cardEl.getAttribute('data-card')):null;
    var resultId=Number(actionsEl.getAttribute('data-result-id'));
    if(cardId==null||!Number.isFinite(cardId)||!resultId) return;
    var action=btnEl.getAttribute('data-result-action');
    var buttons=[].slice.call(actionsEl.querySelectorAll('button'));
    buttons.forEach(function(b){ b.disabled=true; });
    if(action==='accept'){
      // Two-step (spec §4), same order as the drawer's own
      // approveAndMarkDone above: decide (approve) THEN the existing
      // move-to-'done' call — never a combined endpoint.
      api('POST','/card/'+cardId+'/result/'+resultId+'/decide',{decision:'approved'}).then(function(r){
        if(!r.ok){ buttons.forEach(function(b){ b.disabled=false; }); crowToast(errText(r,'failed'),{type:'error'}); return; }
        api('POST','/card/'+cardId+'/move',{status:'done'}).then(function(r2){
          if(r2.ok) reload();
          else { buttons.forEach(function(b){ b.disabled=false; }); crowToast(errText(r2,'failed'),{type:'error'}); }
        });
      }).catch(function(){ buttons.forEach(function(b){ b.disabled=false; }); crowToast('${tJs("botboard.loadFailed", lang)}',{type:'error'}); });
    } else {
      api('POST','/card/'+cardId+'/result/'+resultId+'/decide',{decision:'rejected'}).then(function(r){
        if(r.ok) reload();
        else { buttons.forEach(function(b){ b.disabled=false; }); crowToast(errText(r,'failed'),{type:'error'}); }
      }).catch(function(){ buttons.forEach(function(b){ b.disabled=false; }); crowToast('${tJs("botboard.loadFailed", lang)}',{type:'error'}); });
    }
  }
  function renderResults(results,terminalValues){
    var wrap=$('bb-d-result-wrap'); if(!wrap) return;
    clearEl(wrap);
    var latest=(results||[])[0];
    if(!latest||latest.status!=='recorded') return;
    var hasDoneTerminal=(terminalValues||[]).indexOf('done')>=0;
    var box=document.createElement('div');
    box.className='bb-msg '+(latest.outcome==='success'?'bb-marker-waiting':'bb-marker-failed');
    var head=document.createElement('div');
    head.textContent=(latest.outcome==='success'?'${tJs("board.markerWaiting", lang)}':'${tJs("board.markerFailed", lang)}');
    box.appendChild(head);
    if(latest.summary_md){
      var sm=document.createElement('div');
      sm.style.cssText='white-space:pre-wrap;font-size:.82rem;margin-top:.2rem';
      sm.textContent=latest.summary_md;
      box.appendChild(sm);
    }
    var btnRow=document.createElement('div'); btnRow.style.marginTop='.4rem';
    var approveBtn=document.createElement('button');
    approveBtn.type='button'; approveBtn.className='bb-btn bb-sec';
    approveBtn.textContent='${tJs("board.btnApproveResult", lang)}';
    approveBtn.onclick=function(){ decideResult(latest.id,'approved'); };
    btnRow.appendChild(approveBtn);
    var rejectBtn=document.createElement('button');
    rejectBtn.type='button'; rejectBtn.className='bb-btn bb-sec'; rejectBtn.style.marginLeft='.3rem';
    rejectBtn.textContent='${tJs("board.btnRejectResult", lang)}';
    rejectBtn.onclick=function(){ decideResult(latest.id,'rejected'); };
    btnRow.appendChild(rejectBtn);
    // "approve & mark done" — enabled ONLY on a recorded-SUCCESS result when
    // the resolved board def carries 'done' among its terminal values (a
    // board that never reaches 'done' has no affordance to offer here).
    if(latest.outcome==='success'&&hasDoneTerminal){
      var doneBtn=document.createElement('button');
      doneBtn.type='button'; doneBtn.className='bb-btn'; doneBtn.style.marginLeft='.3rem';
      doneBtn.id='bb-d-approve-done';
      doneBtn.textContent='${tJs("board.btnApproveMarkDone", lang)}';
      doneBtn.onclick=function(){ approveAndMarkDone(latest.id); };
      btnRow.appendChild(doneBtn);
    }
    box.appendChild(btnRow);
    wrap.appendChild(box);
  }

  // ---- Tracker item drawer ----
  function fillTrackerDrawer(cardEl){
    var cd=cardData(cardEl);
    cur=cd;
    var td=trackerDrawer; if(!td) return;
    $('bb-td-title').textContent='${tJs("botboard.jsItemPrefix", lang)}'+cd.id;
    msg($('bb-td-msg'),'','');
    var lk=$('bb-td-lock'), clBtn=$('bb-td-clear-lease');
    if(cd.locked){ lk.textContent='\\uD83D\\uDD12 ${tJs("botboard.jsItemLockedPre", lang)}\\u2014 ${tJs("botboard.jsItemLockedPost", lang)}';
      if(clBtn) clBtn.style.display=''; } else { lk.textContent=''; if(clBtn) clBtn.style.display='none'; }
    var td_archiveBtn=$('bb-td-archive'), td_unarchiveBtn=$('bb-td-unarchive');
    var TRACKER_FIELD_IDS=['bb-td-label','bb-td-status','bb-td-prio','bb-td-action','bb-td-save'];
    applyArchivedUi(td_archiveBtn,td_unarchiveBtn,TRACKER_FIELD_IDS,cd.archived,cd.locked);
    api('GET','/tracker-item/'+cd.id).then(function(r){
      if(!r.ok||!r.j||!r.j.item) { msg($('bb-td-msg'),'${tJs("botboard.jsItemLoadFailed", lang)}','err'); crowToast('${tJs("botboard.loadFailed", lang)}', {type:'error'}); return; }
      var item=r.j.item, tracker=r.j.tracker;
      cur.archived=item.archived_at!=null;
      applyArchivedUi(td_archiveBtn,td_unarchiveBtn,TRACKER_FIELD_IDS,cur.archived,cd.locked);
      $('bb-td-label').value=item.label||'';
      $('bb-td-prio').value=item.priority==null?'':String(item.priority);
      $('bb-td-action').value=item.action_needed||'';
      // Populate status dropdown from tracker def
      var ss=$('bb-td-status'); clearEl(ss);
      if(tracker&&tracker.status_values){
        var svs=[]; try{svs=JSON.parse(tracker.status_values||'[]');}catch(e){svs=[];}
        svs.forEach(function(s){ ss.appendChild(optEl(s,s,s===item.status)); });
      }
      // Populate data fields (Feature 4 — enhanced detail view)
      var fieldsDiv=$('bb-td-fields'); clearEl(fieldsDiv);
      if(tracker&&tracker.columns_json){
        var cols=[]; try{cols=JSON.parse(tracker.columns_json||'[]');}catch(e){cols=[];}
        var data=item.data||{};
        var secH=document.createElement('h4');secH.className='bb-td-section';secH.textContent='${tJs("botboard.jsSectionDataFields", lang)}';
        fieldsDiv.appendChild(secH);
        cols.forEach(function(cf){
          var key=typeof cf==='string'?cf:(cf.key||cf.name||'');
          if(!key||key==='label'||key==='status') return;
          var displayLabel=typeof cf==='object'&&cf.label?cf.label:key;
          var ftype=typeof cf==='object'?(cf.type||'text'):'text';
          var ro=typeof cf==='object'?!!cf.readonly:false;
          var row=document.createElement('div');row.className='bb-td-field-row';
          var lb=document.createElement('label');lb.className='bb-td-field-label';lb.textContent=displayLabel;
          row.appendChild(lb);
          if(ftype==='json'){
            var pre=document.createElement('pre');pre.className='bb-pre';pre.style.maxHeight='200px';
            var jv=data[key];
            try{pre.textContent=typeof jv==='string'?JSON.stringify(JSON.parse(jv),null,2):(jv!=null?JSON.stringify(jv,null,2):'');}
            catch(e){pre.textContent=jv!=null?String(jv):'';}
            row.appendChild(pre);
          } else if(ftype==='boolean'){
            var cb=document.createElement('input');cb.type='checkbox';
            cb.setAttribute('data-field-key',key);cb.className='bb-td-data-field';
            cb.checked=!!data[key];cb.disabled=cd.locked||ro;
            row.appendChild(cb);
          } else if(ftype==='date'){
            var di=document.createElement('input');di.type='date';
            di.setAttribute('data-field-key',key);di.className='bb-td-data-field';
            di.value=data[key]||'';di.disabled=cd.locked||ro;
            row.appendChild(di);
          } else if(ro){
            var sp=document.createElement('span');sp.className='bb-td-readonly';
            sp.textContent=data[key]!=null?String(data[key]):'\\u2014';
            row.appendChild(sp);
          } else if(key==='status_notes'||key==='description'||ftype==='textarea'){
            var ta=document.createElement('textarea');ta.rows=3;
            ta.setAttribute('data-field-key',key);ta.className='bb-td-data-field';
            ta.style.fontFamily='inherit';ta.value=data[key]||'';ta.disabled=cd.locked;
            row.appendChild(ta);
          } else {
            var inp=document.createElement('input');inp.type='text';
            inp.setAttribute('data-field-key',key);inp.className='bb-td-data-field';
            inp.value=data[key]!=null?String(data[key]):'';inp.disabled=cd.locked||ro;
            row.appendChild(inp);
          }
          fieldsDiv.appendChild(row);
        });
        // History section
        var histH=document.createElement('h4');histH.className='bb-td-section';histH.textContent='${tJs("botboard.jsSectionHistory", lang)}';
        fieldsDiv.appendChild(histH);
        var histDiv=document.createElement('div');histDiv.style.fontSize='.82rem';histDiv.style.color='var(--crow-text-secondary)';
        if(item.updated_at){var up=document.createElement('div');up.textContent='${tJs("botboard.jsUpdatedPrefix", lang)}'+item.updated_at;histDiv.appendChild(up);}
        if(item.created_at){var cr=document.createElement('div');cr.textContent='${tJs("botboard.jsCreatedPrefix", lang)}'+item.created_at;histDiv.appendChild(cr);}
        if(data.status_notes){var sn=document.createElement('div');sn.style.marginTop='.3rem';sn.style.whiteSpace='pre-wrap';sn.textContent=data.status_notes;histDiv.appendChild(sn);}
        fieldsDiv.appendChild(histDiv);
        // Related links section
        var hasLinks=data.note_id||data.review_thread_id||data.pir_number;
        if(hasLinks){
          var linkH=document.createElement('h4');linkH.className='bb-td-section';linkH.textContent='${tJs("botboard.jsSectionRelated", lang)}';
          fieldsDiv.appendChild(linkH);
          var linkDiv=document.createElement('div');
          if(data.pir_number){var pn=document.createElement('div');pn.style.fontWeight='600';pn.style.fontSize='.95rem';pn.textContent='PIR #'+data.pir_number;linkDiv.appendChild(pn);}
          if(data.note_id){var nl;if(NOTES_BASE){nl=document.createElement('a');nl.className='bb-td-link';nl.href=NOTES_BASE+data.note_id;nl.target='_blank';nl.textContent='View note \\u2192 #'+data.note_id;}else{nl=document.createElement('span');nl.className='bb-td-link';nl.textContent='note #'+data.note_id;}linkDiv.appendChild(nl);}
          if(data.review_thread_id){var rt=document.createElement('div');rt.className='bb-td-link';rt.textContent='Thread: '+data.review_thread_id;rt.style.cursor='pointer';rt.title='Click to copy';rt.onclick=function(ev){ev.stopPropagation();navigator.clipboard.writeText(data.review_thread_id);msg($('bb-td-msg'),'Copied thread ID.','ok');};linkDiv.appendChild(rt);}
          fieldsDiv.appendChild(linkDiv);
        }
      }
      // Lease info
      var leaseDiv=$('bb-td-lease');
      if(leaseDiv){
        clearEl(leaseDiv);
        if(item.processing_lease||item.processing_lease_status){
          var t=document.createElement('span');
          t.textContent='${tJs("botboard.jsLeasePrefix", lang)}'+(item.processing_lease_status||'none')+
            (item.processing_lease?' ('+item.processing_lease+')':'');
          leaseDiv.appendChild(t);
        }
      }
    });
    openDrawer(td);
  }

  // ---- Click handler: dispatch by item type ----
  document.addEventListener('click',function(ev){
    // Track 3 Task 14: card-face result-gate Accept/Reject — checked FIRST,
    // before the bird glyph AND the card-open branches below, and returns
    // unconditionally: a click anywhere inside the .bb-result-actions
    // wrapper (data-result-actions) must NEVER also open the card drawer.
    var resultActionsEl=ev.target.closest && ev.target.closest('[data-result-actions]');
    if(resultActionsEl){
      var resultActionBtn=ev.target.closest('[data-result-action]');
      if(resultActionBtn){
        ev.preventDefault();
        ev.stopPropagation();
        cardResultDecide(resultActionsEl,resultActionBtn);
      }
      return;
    }
    // Track 3 Task 13: a card-face bird glyph opens the SESSION drawer, not
    // the card drawer — checked first so it wins over the card-body handler
    // below. botId is unknown here (cardFaceHtml's birdHtml carries no
    // data-bot); the drawer discovers it off the first SSE 'state' frame.
    var birdGlyph=ev.target.closest && ev.target.closest('.bb-bird[data-bird-sid]');
    if(birdGlyph && ev.target.closest('.bb-card')){
      ev.preventDefault();
      ev.stopPropagation();
      openBirdDrawer(birdGlyph.getAttribute('data-bird-sid'));
      return;
    }
    var c=ev.target.closest && ev.target.closest('.bb-card');
    if(c && !ev.target.closest('.bb-nojs-move')){
      ev.preventDefault();
      var itemType=c.getAttribute('data-item-type')||'kanban';
      if(itemType==='tracker'){ fillTrackerDrawer(c); }
      else { fillDrawer(c); }
    }
  });

  // ---- Kanban drawer events ----
  if($('bb-d-close')) $('bb-d-close').onclick=function(){ closeDrawer(drawer); cur=null; };
  if($('bb-d-save')) $('bb-d-save').onclick=function(){
    if(!cur||cur.locked||cur.archived) return;
    var body={title:$('bb-d-title-in').value,status:$('bb-d-status').value,
      priority:$('bb-d-prio').value===''?null:Number($('bb-d-prio').value),
      due_date:$('bb-d-due').value||null,owner:$('bb-d-owner').value||null,
      tags:$('bb-d-tags').value||null,description:$('bb-d-desc').value||null,
      autonomy:$('bb-d-autonomy')?$('bb-d-autonomy').value:undefined};
    api('POST','/card/'+cur.id,body).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("botboard.jsSaved", lang)}','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'\\uD83D\\uDD12 '+errText(r,'locked by a bot'),'err'); }
      else { msg($('bb-d-msg'),errText(r,'save failed'),'err'); }
    });
  };
  var projSel=$('bb-d-project');
  if(projSel) projSel.onchange=function(){
    if(!cur||cur.locked) return;
    var v=projSel.value===''?null:Number(projSel.value);
    api('POST','/card/'+cur.id+'/project',{project_id:v}).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("botboard.jsProjectUpdated", lang)}','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'\\uD83D\\uDD12 locked','err'); }
      else msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  if($('bb-d-cancel')) $('bb-d-cancel').onclick=function(){
    if(!cur||cur.locked||!confirm('${tJs("botboard.confirmCancelCard", lang)}'.replace('#{id}',cur.id))) return;
    api('POST','/card/'+cur.id+'/cancel').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("botboard.jsCancelled", lang)}','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'\\uD83D\\uDD12 locked','err'); }
      else msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  if($('bb-d-unlock')) $('bb-d-unlock').onclick=function(){
    if(!cur||!confirm('${tJs("botboard.confirmForceUnlock", lang)}'.replace('#{id}',cur.id))) return;
    api('POST','/card/'+cur.id+'/force-unlock').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("botboard.jsForceUnlocked", lang)}','ok'); setTimeout(reload,500); }
      else msg($('bb-d-msg'),(r.j&&(r.j.reason||r.j.error))||'refused (fail-closed: pi not confirmed dead)','err');
    });
  };
  if($('bb-d-archive')) $('bb-d-archive').onclick=function(){
    if(!cur||cur.locked||cur.archived||!confirm('${tJs("board.archive", lang)}?')) return;
    api('POST','/card/'+cur.id+'/archive').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("board.archivedToast", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-d-msg'),errText(r,'archive failed'),'err');
    });
  };
  if($('bb-d-unarchive')) $('bb-d-unarchive').onclick=function(){
    if(!cur||!cur.archived) return;
    api('POST','/card/'+cur.id+'/unarchive').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("board.unarchivedToast", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-d-msg'),errText(r,'unarchive failed'),'err');
    });
  };
  var planToggled=false;
  if($('bb-d-plan-toggle')) $('bb-d-plan-toggle').onclick=function(){
    planToggled=!planToggled; renderPre();
    $('bb-d-plan').style.display=planToggled?'none':'';
    $('bb-d-plan-pre').style.display=planToggled?'':'none';
    this.textContent=planToggled?'${tJs("botboard.jsToggleEdit", lang)}':'${tJs("botboard.jsTogglePreview", lang)}';
  };
  if($('bb-d-plan')) $('bb-d-plan').addEventListener('input',renderPre);
  // Save ALWAYS appends a new draft version (plan-service.savePlan, D-T1.4) —
  // there is no mtime optimistic-concurrency any more; a record is never
  // edited in place, so two saves in flight just produce two versions.
  if($('bb-d-plan-save')) $('bb-d-plan-save').onclick=function(){
    if(!cur||cur.locked) return;
    api('POST','/card/'+cur.id+'/plan',{body_md:$('bb-d-plan').value}).then(function(r){
      if(r.ok){ msg($('bb-d-plan-msg'),'${tJs("botboard.jsPlanSaved", lang)}','ok'); loadPlan(); }
      else msg($('bb-d-plan-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err');
    });
  };
  if(planApproveBtn) planApproveBtn.onclick=function(){
    if(!cur||cur.locked||planCurrentVersion==null) return;
    api('POST','/card/'+cur.id+'/plan/approve',{version:planCurrentVersion}).then(function(r){
      if(r.ok){ msg($('bb-d-plan-msg'),'${tJs("botboard.jsPlanApproved", lang)}','ok'); loadPlan(); }
      else msg($('bb-d-plan-msg'),(r.j&&(r.j.error||r.j.reason))||'approve failed','err');
    });
  };

  // ---- Tracker drawer events ----
  if($('bb-td-close')) $('bb-td-close').onclick=function(){ closeDrawer(trackerDrawer); cur=null; };
  if($('bb-td-save')) $('bb-td-save').onclick=function(){
    if(!cur||cur.locked||cur.archived) return;
    var body={label:$('bb-td-label').value,status:$('bb-td-status').value,
      priority:$('bb-td-prio').value===''?null:Number($('bb-td-prio').value),
      action_needed:$('bb-td-action').value||null};
    // Collect data fields
    var dataFields=document.querySelectorAll('.bb-td-data-field');
    if(dataFields.length){
      var data={};
      dataFields.forEach(function(inp){
        var fk=inp.getAttribute('data-field-key');
        if(!fk) return;
        if(inp.type==='checkbox') data[fk]=inp.checked;
        else data[fk]=inp.value;
      });
      body.data=data;
    }
    api('POST','/tracker-item/'+cur.id,body).then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'${tJs("botboard.jsSaved", lang)}','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-td-msg'),'\\uD83D\\uDD12 '+errText(r,'locked by a bot'),'err'); }
      else { msg($('bb-td-msg'),errText(r,'save failed'),'err'); }
    });
  };
  if($('bb-td-clear-lease')) $('bb-td-clear-lease').onclick=function(){
    if(!cur||!confirm('${tJs("botboard.confirmClearLease", lang)}'.replace('#{id}',cur.id))) return;
    api('POST','/tracker-item/'+cur.id+'/force-clear-lease').then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'${tJs("botboard.jsLeaseCleared", lang)}','ok'); setTimeout(reload,500); }
      else msg($('bb-td-msg'),errText(r,'failed'),'err');
    });
  };
  if($('bb-td-archive')) $('bb-td-archive').onclick=function(){
    if(!cur||cur.locked||cur.archived||!confirm('${tJs("board.archive", lang)}?')) return;
    api('POST','/tracker-item/'+cur.id+'/archive').then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'${tJs("board.archivedToast", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-td-msg'),errText(r,'archive failed'),'err');
    });
  };
  if($('bb-td-unarchive')) $('bb-td-unarchive').onclick=function(){
    if(!cur||!cur.archived) return;
    api('POST','/tracker-item/'+cur.id+'/unarchive').then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'${tJs("board.unarchivedToast", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-td-msg'),errText(r,'unarchive failed'),'err');
    });
  };

  // ---- Drag and drop ----
  document.addEventListener('dragstart',function(e){
    // Track 3 Task 14: the SAME data-result-actions guard the click handler
    // above uses — a drag started from inside the Accept/Reject buttons must
    // never pick up the whole card.
    if(e.target.closest && e.target.closest('[data-result-actions]')){ e.preventDefault(); return; }
    var c=e.target.closest&&e.target.closest('.bb-card'); if(!c) return;
    if(c.getAttribute('data-locked')==='1'||c.getAttribute('data-archived')==='1'){ e.preventDefault(); return; }
    dragId=Number(c.getAttribute('data-card'));
    dragType=c.getAttribute('data-item-type')||'kanban';
    e.dataTransfer.effectAllowed='move';
  });
  document.addEventListener('dragend',function(){ dragId=null; dragType=null;
    document.querySelectorAll('.bb-col').forEach(function(x){x.classList.remove('bb-dragover');}); });
  document.querySelectorAll('.bb-col').forEach(function(col){
    col.addEventListener('dragover',function(e){ e.preventDefault(); col.classList.add('bb-dragover'); });
    col.addEventListener('dragleave',function(){ col.classList.remove('bb-dragover'); });
    col.addEventListener('drop',function(e){
      e.preventDefault(); col.classList.remove('bb-dragover');
      if(dragId==null) return;
      var st=col.getAttribute('data-col'), id=dragId, dt=dragType; dragId=null; dragType=null;
      if(dt==='tracker'){
        api('POST','/tracker-item/'+id+'/move',{status:st}).then(function(r){
          if(r.ok) reload();
          else if(r.status===409&&r.j&&r.j.code==='archived') crowToast(errText(r,''), {type:'error'});
          else if(r.status===409) crowToast('${tJs("botboard.trackerItemLocked", lang)}'.replace('#{id}',id), {type:'error'});
          else crowToast(errText(r,'${tJs("botboard.moveItemFailed", lang)}'), {type:'error'});
        });
      } else {
        api('POST','/card/'+id+'/move',{status:st}).then(function(r){
          if(r.ok) reload();
          else if(r.status===409&&r.j&&r.j.code==='archived') crowToast(errText(r,''), {type:'error'});
          else if(r.status===409) crowToast('${tJs("botboard.cardLocked", lang)}'.replace('#{id}',id), {type:'error'});
          else crowToast(errText(r,'${tJs("botboard.moveFailed", lang)}'), {type:'error'});
        });
      }
    });
  });

  // ---- New project / card / bulk (kanban only) ----
  var np=$('bb-newproj');
  var npBtn=$('bb-new-proj-btn'); if(npBtn) npBtn.onclick=function(){ msg($('bb-np-msg'),'',''); openDrawer(np); };
  if($('bb-np-close')) $('bb-np-close').onclick=function(){ closeDrawer(np); };
  if($('bb-np-save')) $('bb-np-save').onclick=function(){
    var name=$('bb-np-name').value.trim();
    if(!name){ msg($('bb-np-msg'),'${tJs("botboard.jsNameRequired", lang)}','err'); return; }
    api('POST','/project',{name:name,description:$('bb-np-desc').value||null}).then(function(r){
      if(r.ok){ var id=r.j&&r.j.id; location.href='/dashboard/bot-board'+(BOT_ID?'?bot='+encodeURIComponent(BOT_ID):''); }
      else msg($('bb-np-msg'),(r.j&&(r.j.error||r.j.reason))||'create failed','err');
    });
  };

  var nc=$('bb-newcard');
  var ncBtn=$('bb-new-card-btn');
  if(ncBtn) ncBtn.onclick=function(){ msg($('bb-nc-msg'),'',''); openDrawer(nc); };
  var ncClose=$('bb-nc-close'); if(ncClose) ncClose.onclick=function(){ closeDrawer(nc); };
  var ncSave=$('bb-nc-save');
  if(ncSave) ncSave.onclick=function(){
    var title=$('bb-nc-title').value.trim();
    if(!title){ msg($('bb-nc-msg'),'${tJs("botboard.jsTitleRequired", lang)}','err'); return; }
    api('POST','/card',{title:title,description:$('bb-nc-desc').value||null,
      due_date:$('bb-nc-due').value||null,owner:$('bb-nc-owner').value||null,
      tags:$('bb-nc-tags').value||null,project_id:PROJECT,
      autonomy:$('bb-nc-autonomy')?$('bb-nc-autonomy').value:undefined}).then(function(r){
      if(r.ok){ msg($('bb-nc-msg'),'Created #'+(r.j&&r.j.id)+'.','ok'); setTimeout(reload,500); }
      else msg($('bb-nc-msg'),(r.j&&(r.j.error||r.j.reason))||'create failed','err');
    });
  };

  var bk=$('bb-bulk');
  var bkBtn=$('bb-bulk-btn');
  if(bkBtn) bkBtn.onclick=function(){
    msg($('bb-bk-msg'),'loading\\u2026',''); openDrawer(bk);
    api('GET','/project/'+PROJECT+'/unlinked').then(function(r){
      var L=$('bb-bk-list'); clearEl(L);
      if(r.ok&&r.j&&r.j.cards&&r.j.cards.length){
        r.j.cards.forEach(function(c){
          var lab=document.createElement('label'); lab.style.display='block'; lab.style.padding='.2rem 0';
          var cb=document.createElement('input'); cb.type='checkbox'; cb.value=String(c.id);
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(' #'+c.id+' \\u2014 '+(c.title||'')));
          L.appendChild(lab);
        });
        msg($('bb-bk-msg'),'','');
      } else if(r.ok){ var p=document.createElement('p'); p.style.color='var(--crow-text-muted)';
        p.textContent='${tJs("botboard.jsNoUnlinkedCards", lang)}'; L.appendChild(p); msg($('bb-bk-msg'),'','');
      } else msg($('bb-bk-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  if($('bb-bk-close')) $('bb-bk-close').onclick=function(){ closeDrawer(bk); };
  if($('bb-bk-save')) $('bb-bk-save').onclick=function(){
    var ids=[].slice.call($('bb-bk-list').querySelectorAll('input:checked')).map(function(x){return Number(x.value);});
    if(!ids.length){ msg($('bb-bk-msg'),'${tJs("botboard.jsSelectAtLeastOne", lang)}','err'); return; }
    if(ids.length>200){ msg($('bb-bk-msg'),'${tJs("botboard.jsMaxPerAssign", lang)}','err'); return; }
    api('POST','/project/'+PROJECT+'/bulk-assign',{card_ids:ids}).then(function(r){
      if(r.ok){ var a=((r.j&&r.j.applied)||[]).length, s=((r.j&&r.j.skipped)||[]).length;
        msg($('bb-bk-msg'),'Applied '+a+', skipped '+s+'.','ok'); setTimeout(reload,800); }
      else msg($('bb-bk-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };

  // ---- New tracker item ----
  var ntiDrawer=$('bb-new-tracker-item');
  var ntiBtn=$('bb-new-tracker-item-btn');
  if(ntiBtn && ntiDrawer) ntiBtn.onclick=function(){
    msg($('bb-nti-msg'),'','');
    $('bb-nti-label').value='';
    $('bb-nti-action').value='';
    // Populate status dropdown from tracker data (fetch tracker def)
    if(BOT_ID && TRACKER_TYPE==='custom'){
      var slug=document.querySelector('[data-col]');
      if(slug){
        var statusSel=$('bb-nti-status');
        clearEl(statusSel);
        document.querySelectorAll('[data-col]').forEach(function(col){
          var sv=col.getAttribute('data-col');
          statusSel.appendChild(optEl(sv,sv,statusSel.options.length===0));
        });
      }
      // Populate data fields from columns_json
      api('GET','/trackers').then(function(r){
        if(!r.ok||!r.j||!r.j.trackers) return;
        var fieldsDiv=$('bb-nti-fields');
        clearEl(fieldsDiv);
        // Find the tracker for this bot by checking which tracker slug is on the board
        var firstCol=document.querySelector('[data-col]');
        if(!firstCol) return;
        r.j.trackers.forEach(function(t){
          var cols; try{cols=JSON.parse(t.columns_json||'[]');}catch(e){return;}
          cols.forEach(function(col){
            if(col.key==='label'||col.key==='status'||col.key==='action_needed'||col.key==='priority') return;
            var label=document.createElement('label');
            label.textContent=col.label||col.key;
            var input=document.createElement('input');
            input.type='text';
            input.setAttribute('data-field-key',col.key);
            fieldsDiv.appendChild(label);
            fieldsDiv.appendChild(input);
          });
        });
      });
    }
    openDrawer(ntiDrawer);
  };
  if($('bb-nti-close')) $('bb-nti-close').onclick=function(){ closeDrawer(ntiDrawer); };
  if($('bb-nti-save')) $('bb-nti-save').onclick=function(){
    var label=($('bb-nti-label').value||'').trim();
    if(!label){ msg($('bb-nti-msg'),'Label required.','err'); return; }
    var status=$('bb-nti-status').value;
    var priority=$('bb-nti-prio').value;
    var action=$('bb-nti-action').value||null;
    // Collect data fields
    var data={};
    var fields=$('bb-nti-fields');
    if(fields){
      fields.querySelectorAll('input[data-field-key]').forEach(function(inp){
        var v=inp.value.trim();
        if(v) data[inp.getAttribute('data-field-key')]=v;
      });
    }
    // Determine tracker_slug from the URL or bot definition
    var slugMatch=location.search.match(/bot=([^&]+)/);
    var botIdForCreate=slugMatch?decodeURIComponent(slugMatch[1]):BOT_ID;
    api('GET','/tracker/'+encodeURIComponent(status)+'/items').catch(function(){ crowToast('${tJs("botboard.loadFailed", lang)}', {type:'error'}); });
    // We need the tracker_slug. Get it from the page title or fetch it.
    api('POST','/tracker-item',{
      tracker_slug:window._trackerSlug||'',
      bot_id:botIdForCreate,
      label:label,
      status:status,
      priority:priority?Number(priority):3,
      action_needed:action,
      data:data
    }).then(function(r){
      if(r.ok){ msg($('bb-nti-msg'),'Created #'+(r.j&&r.j.id)+'.','ok'); setTimeout(reload,500); }
      else msg($('bb-nti-msg'),(r.j&&(r.j.error||r.j.reason))||'create failed','err');
    }).catch(function(e){ crowToast('${tJs("botboard.loadFailed", lang)}', {type:'error', details: e.message}); });
  };

  // ---- Search and filter (Feature 1) ----
  // Track 0: the kanban board adopts the tracker affordances wholesale.
  if(TRACKER_TYPE==='custom'||TRACKER_TYPE==='kanban'){
    var searchInput=$('bb-search');
    var chips=document.querySelectorAll('.bb-chip');
    var activeStatuses={};
    var actionNeededFilter=false;
    function statusFilterOn(){ for(var k in activeStatuses) return true; return false; }

    function applyFilters(){
      var q=(searchInput?searchInput.value:'').toLowerCase().trim();
      var colCounts={};
      document.querySelectorAll('.bb-col').forEach(function(col){
        colCounts[col.getAttribute('data-col')]={total:0,visible:0};
      });
      // Mode-aware: kanban card faces carry no data-item-type (same rule as
      // buildListTable) — the tracker-only selector here counted zero cards on
      // every kanban board and rewrote all the column headers to 0.
      document.querySelectorAll(TRACKER_TYPE==='custom'?'.bb-card[data-item-type="tracker"]':'.bb-card').forEach(function(card){
        var matchSearch=!q||(card.getAttribute('data-search-text')||'').indexOf(q)>=0;
        var st=card.getAttribute('data-status');
        var matchStatus=!statusFilterOn()||!!activeStatuses[st];
        var matchAction=!actionNeededFilter||card.getAttribute('data-action-needed')==='1';
        var vis=matchSearch&&matchStatus&&matchAction;
        card.style.display=vis?'':'none';
        if(colCounts[st]){colCounts[st].total++;if(vis)colCounts[st].visible++;}
      });
      document.querySelectorAll('.bb-col').forEach(function(col){
        var st=col.getAttribute('data-col'),h4=col.querySelector('h4');
        if(!h4) return;
        var spans=h4.querySelectorAll('span');
        if(spans.length<2) return;
        var c=colCounts[st]||{total:0,visible:0};
        var filt=q||statusFilterOn()||actionNeededFilter;
        spans[spans.length-1].textContent=filt?c.visible+'/'+c.total:String(c.total);
      });
      document.querySelectorAll('#bb-list-wrap tr[data-card]').forEach(function(row){
        var mS=!q||(row.getAttribute('data-search-text')||'').indexOf(q)>=0;
        var rSt=row.getAttribute('data-status');
        var mSt=!statusFilterOn()||!!activeStatuses[rSt];
        var mA=!actionNeededFilter||row.getAttribute('data-action-needed')==='1';
        row.style.display=(mS&&mSt&&mA)?'':'none';
      });
      updateFilterHash();
    }
    window._bbApplyFilters=applyFilters;

    function updateFilterHash(){
      var parts=[];
      if(searchInput&&searchInput.value) parts.push('search='+encodeURIComponent(searchInput.value));
      var sk=Object.keys(activeStatuses);
      if(sk.length) parts.push('status='+sk.join(','));
      if(actionNeededFilter) parts.push('action=1');
      // Track 3 Task 13: preserve foreign hash keys the drawer owns (bird,
      // card) — a filter interaction must never blow away a live drawer
      // deep link (review finding 7). window._bbForeignHash is populated by
      // parseFilterHash below and by the drawer itself (bdSetHashKey).
      if(window._bbForeignHash){
        for(var fk in window._bbForeignHash){
          if(Object.prototype.hasOwnProperty.call(window._bbForeignHash,fk) && window._bbForeignHash[fk]!=null){
            parts.push(fk+'='+encodeURIComponent(window._bbForeignHash[fk]));
          }
        }
      }
      var h=parts.length?'#'+parts.join('&'):'';
      if(location.hash!==h) history.replaceState(null,'',location.pathname+location.search+h);
    }

    function parseFilterHash(){
      var h=location.hash.replace(/^#/,'');
      if(!h) return;
      h.split('&').forEach(function(part){
        var eq=part.indexOf('=');
        if(eq<0) return;
        var k=part.substring(0,eq),v=decodeURIComponent(part.substring(eq+1));
        if(k==='search'&&searchInput) searchInput.value=v;
        if(k==='status') v.split(',').forEach(function(s){ if(s) activeStatuses[s]=1; });
        if(k==='action'&&v==='1') actionNeededFilter=true;
        // Track 3 Task 13: bird/card are keys THIS parser doesn't own —
        // remembered so updateFilterHash can round-trip them, and read below
        // (after parseFilterHash runs) to drive the drawer's own hash open.
        if(k==='bird'||k==='card'){
          window._bbForeignHash=window._bbForeignHash||{};
          window._bbForeignHash[k]=v;
        }
      });
      chips.forEach(function(chip){
        var sf=chip.getAttribute('data-status-filter');
        if(sf) chip.classList.toggle('bb-chip-active',!!activeStatuses[sf]);
        if(chip.getAttribute('data-filter')==='action-needed') chip.classList.toggle('bb-chip-active',actionNeededFilter);
      });
    }

    if(searchInput) searchInput.addEventListener('input',applyFilters);
    chips.forEach(function(chip){
      chip.addEventListener('click',function(){
        var sf=chip.getAttribute('data-status-filter');
        if(sf){
          if(activeStatuses[sf]){delete activeStatuses[sf];chip.classList.remove('bb-chip-active');}
          else{activeStatuses[sf]=1;chip.classList.add('bb-chip-active');}
        }
        if(chip.getAttribute('data-filter')==='action-needed'){
          actionNeededFilter=!actionNeededFilter;
          chip.classList.toggle('bb-chip-active',actionNeededFilter);
        }
        applyFilters();
      });
    });

    parseFilterHash();
    applyFilters();

    // Track 3 Task 13: hash-driven drawer open — #bird=<sid> opens straight
    // to that session, #card=<id> scrolls the card into view and opens its
    // live bird's drawer if one is on it. Runs AFTER parseFilterHash so a
    // drawer link co-existing with a search/status hash is never lost.
    if(window._bbForeignHash){
      if(window._bbForeignHash.bird && typeof openBirdDrawer==='function'){
        openBirdDrawer(window._bbForeignHash.bird);
      } else if(window._bbForeignHash.card && typeof bdFocusCard==='function'){
        bdFocusCard(window._bbForeignHash.card);
      }
    }

    // ---- View toggle + list + collapsible columns (Feature 3) ----
    var bbBoard=$('bb-board');
    var bbListWrap=$('bb-list-wrap');
    var viewBtns=document.querySelectorAll('.bb-view-btn');
    var currentView='columns';
    var sortKey=null,sortAsc=true;

    function switchView(view){
      currentView=view;
      if(view==='list'){
        if(bbBoard) bbBoard.style.display='none';
        if(bbListWrap){bbListWrap.style.display='';buildListTable();applyFilters();}
      } else {
        if(bbBoard) bbBoard.style.display='';
        if(bbListWrap) bbListWrap.style.display='none';
      }
      viewBtns.forEach(function(btn){btn.classList.toggle('bb-view-btn-active',btn.getAttribute('data-view')===view);});
      try{localStorage.setItem('bb-view-'+BOT_ID,view);}catch(e){}
    }
    viewBtns.forEach(function(btn){
      btn.addEventListener('click',function(){switchView(btn.getAttribute('data-view'));});
    });

    function buildListTable(){
      if(!bbListWrap) return;
      clearEl(bbListWrap);
      var table=document.createElement('table');
      table.className='bb-list-table';
      var thead=document.createElement('thead');
      var hr=document.createElement('tr');
      var cols=[{key:'id',label:'#'},{key:'label',label:'Label'},{key:'status',label:'Status'},
                {key:'priority',label:'Pri'},{key:'action',label:'Action Needed'}];
      var cf=window._bbContextFields||[];
      cf.forEach(function(c){
        var key=typeof c==='string'?c:(c.key||c.name||'');
        if(!key||key==='label'||key==='status'||key==='priority'||key==='action_needed') return;
        cols.push({key:key,label:typeof c==='object'&&c.label?c.label:key});
      });
      cols.forEach(function(col){
        var th=document.createElement('th');
        th.textContent=col.label;
        th.setAttribute('data-sort-key',col.key);
        if(sortKey===col.key) th.classList.add(sortAsc?'bb-sort-asc':'bb-sort-desc');
        th.onclick=function(){sortListByKey(col.key);};
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody=document.createElement('tbody');
      var cards=[].slice.call(document.querySelectorAll(TRACKER_TYPE==='custom'?'.bb-card[data-item-type="tracker"]':'.bb-card'));
      if(sortKey) cards.sort(function(a,b){
        var va=cardSortVal(a,sortKey),vb=cardSortVal(b,sortKey);
        if(va===vb) return 0;
        return (va<vb?-1:1)*(sortAsc?1:-1);
      });
      cards.forEach(function(card){
        var tr=document.createElement('tr');
        tr.setAttribute('data-card',card.getAttribute('data-card'));
        tr.setAttribute('data-status',card.getAttribute('data-status'));
        tr.setAttribute('data-item-type','tracker');
        tr.setAttribute('data-search-text',card.getAttribute('data-search-text')||'');
        tr.setAttribute('data-action-needed',card.getAttribute('data-action-needed')||'0');
        tr.setAttribute('data-priority',card.getAttribute('data-priority')||'');
        var data={}; try{data=JSON.parse(card.getAttribute('data-json')||'{}');}catch(e){data={};}
        cols.forEach(function(col){
          var td=document.createElement('td');
          if(col.key==='id') td.textContent='#'+card.getAttribute('data-card');
          else if(col.key==='label'){var t=card.querySelector('.bb-title');td.textContent=t?t.textContent:'';}
          else if(col.key==='status'){var sp=document.createElement('span');sp.className='bb-list-status';sp.textContent=card.getAttribute('data-status');td.appendChild(sp);}
          else if(col.key==='priority') td.textContent=card.getAttribute('data-priority')||'\\u2014';
          else if(col.key==='action'){
            if(card.getAttribute('data-action-needed')==='1'){
              var sub=card.querySelector('.bb-sub');td.textContent=sub?sub.textContent.replace(/^\\u26A0\\s*/,''):'Yes';
              td.style.color='#b8860b';
            } else td.textContent='\\u2014';
          } else {var v=data[col.key];td.textContent=v!=null?String(v):'';}
          tr.appendChild(td);
        });
        tr.onclick=function(){
          var cid=this.getAttribute('data-card');
          var orig=document.querySelector('.bb-card[data-card="'+cid+'"]');
          if(orig){ if(TRACKER_TYPE==='custom') fillTrackerDrawer(orig); else fillDrawer(orig); }
        };
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      bbListWrap.appendChild(table);
    }

    function cardSortVal(card,key){
      if(key==='id') return Number(card.getAttribute('data-card'))||0;
      if(key==='priority') return Number(card.getAttribute('data-priority'))||99;
      if(key==='status') return card.getAttribute('data-status')||'';
      if(key==='label'){var t=card.querySelector('.bb-title');return t?t.textContent.toLowerCase():'';}
      if(key==='action') return card.getAttribute('data-action-needed')==='1'?0:1;
      var data={};try{data=JSON.parse(card.getAttribute('data-json')||'{}');}catch(e){}
      var v=data[key];return v!=null?String(v).toLowerCase():'';
    }

    function sortListByKey(key){
      if(sortKey===key) sortAsc=!sortAsc;
      else{sortKey=key;sortAsc=true;}
      buildListTable();
      applyFilters();
    }

    // Collapsible columns
    var collapsedKey='bb-collapsed-'+BOT_ID;
    function getCollapsed(){try{return JSON.parse(localStorage.getItem(collapsedKey)||'[]');}catch(e){return [];}}
    function saveCollapsed(arr){try{localStorage.setItem(collapsedKey,JSON.stringify(arr));}catch(e){}}

    function toggleColumn(colEl){
      var st=colEl.getAttribute('data-col');
      var collapsed=getCollapsed();
      var idx=collapsed.indexOf(st);
      if(idx>=0){collapsed.splice(idx,1);colEl.classList.remove('bb-col-collapsed');}
      else{collapsed.push(st);colEl.classList.add('bb-col-collapsed');}
      saveCollapsed(collapsed);
      var btn=colEl.querySelector('.bb-col-toggle');
      if(btn) btn.textContent=idx>=0?'\\u2212':'+';
    }

    document.querySelectorAll('.bb-col-toggle').forEach(function(btn){
      btn.addEventListener('click',function(ev){
        ev.stopPropagation();
        var col=btn.closest('.bb-col');
        if(col) toggleColumn(col);
      });
    });

    function restoreCollapsedColumns(){
      var collapsed=getCollapsed();
      collapsed.forEach(function(st){
        var col=document.querySelector('.bb-col[data-col="'+st+'"]');
        if(col){col.classList.add('bb-col-collapsed');var btn=col.querySelector('.bb-col-toggle');if(btn) btn.textContent='+';}
      });
    }

    restoreCollapsedColumns();
    var savedView;try{savedView=localStorage.getItem('bb-view-'+BOT_ID);}catch(e){}
    if(savedView==='list') switchView('list');
  }

  // ---- Board settings drawer (Track 0) ----
  var cfgDrawer=$('bb-cfg');
  if(cfgDrawer && $('bb-cfg-open')){
    function cfgTerminalBoxes(statuses, checked){
      var wrap=$('bb-cfg-terminals'); clearEl(wrap);
      statuses.forEach(function(sv){
        var lb=document.createElement('label'); lb.style.fontWeight='normal';
        var cb=document.createElement('input'); cb.type='checkbox'; cb.value=sv;
        cb.checked=checked.indexOf(sv)>=0;
        lb.appendChild(cb); lb.appendChild(document.createTextNode(' '+sv));
        wrap.appendChild(lb);
      });
    }
    function cfgStatusList(){
      return $('bb-cfg-statuses').value.split('\\n').map(function(x){return x.trim();}).filter(Boolean);
    }
    function cfgFieldRow(f){
      f=f||{};
      var row=document.createElement('div'); row.className='bb-cfg-field-row';
      row.style.cssText='display:flex;gap:.4rem;margin:.25rem 0;align-items:center';
      function inp(cls,ph,val,w){var i=document.createElement('input');i.type='text';i.className=cls;i.placeholder=ph;i.value=val||'';i.style.width=w;return i;}
      row.appendChild(inp('bb-cfg-f-key','key',f.key,'8rem'));
      row.appendChild(inp('bb-cfg-f-label','label',f.label,'9rem'));
      var sel=document.createElement('select'); sel.className='bb-cfg-f-storage';
      ['data','column'].forEach(function(v){sel.appendChild(optEl(v,v,(f.storage||'data')===v));});
      row.appendChild(sel);
      row.appendChild(inp('bb-cfg-f-options','options (comma-separated)',(f.options||[]).join(', '),'14rem'));
      var rm=document.createElement('button'); rm.type='button'; rm.className='bb-btn bb-sec'; rm.textContent='\u2715';
      rm.onclick=function(){row.remove();};
      row.appendChild(rm);
      return row;
    }
    $('bb-cfg-open').onclick=function(){
      var pid=cfgDrawer.getAttribute('data-project');
      msg($('bb-cfg-msg'),'','');
      api('GET','/board-def?project_id='+encodeURIComponent(pid)).then(function(r){
        if(!r.ok||!r.j){ msg($('bb-cfg-msg'),(r.j&&r.j.error)||'load failed','err'); return; }
        $('bb-cfg-name').value=r.j.display_name||'';
        $('bb-cfg-statuses').value=(r.j.status_values||[]).join('\\n');
        cfgTerminalBoxes(r.j.status_values||[], r.j.terminal_values||[]);
        var fw=$('bb-cfg-fields'); clearEl(fw);
        (r.j.fields||[]).forEach(function(f){ fw.appendChild(cfgFieldRow(f)); });
        openDrawer(cfgDrawer);
      });
    };
    $('bb-cfg-close').onclick=function(){ closeDrawer(cfgDrawer); };
    $('bb-cfg-statuses').addEventListener('input',function(){
      var checked=[].slice.call(document.querySelectorAll('#bb-cfg-terminals input:checked')).map(function(c){return c.value;});
      cfgTerminalBoxes(cfgStatusList(), checked);
    });
    $('bb-cfg-addfield').onclick=function(){ $('bb-cfg-fields').appendChild(cfgFieldRow()); };
    $('bb-cfg-save').onclick=function(){
      var pid=cfgDrawer.getAttribute('data-project');
      var fields=[].slice.call(document.querySelectorAll('#bb-cfg .bb-cfg-field-row')).map(function(row){
        var opts=(row.querySelector('.bb-cfg-f-options').value||'').split(',').map(function(x){return x.trim();}).filter(Boolean);
        var f={key:row.querySelector('.bb-cfg-f-key').value.trim(),
               label:row.querySelector('.bb-cfg-f-label').value.trim(),
               storage:row.querySelector('.bb-cfg-f-storage').value};
        if(opts.length) f.options=opts;
        return f;
      }).filter(function(f){return f.key;});
      var body={project_id:Number(pid),
        display_name:$('bb-cfg-name').value.trim(),
        status_values:cfgStatusList(),
        terminal_values:[].slice.call(document.querySelectorAll('#bb-cfg-terminals input:checked')).map(function(c){return c.value;}),
        fields:fields};
      api('POST','/board-def',body).then(function(r){
        if(r.ok){ msg($('bb-cfg-msg'),'${tJs("botboard.cfgSaved", lang)}','ok'); setTimeout(reload,400); }
        else msg($('bb-cfg-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err');
      });
    };
  }

  // ---- Track 3 Task 12: the roost strip ("birds on a wire") ----
  // i18n text baked in at render time (SAME idiom as MUTATION_VERB_LABELS
  // above) — a bird-state SSE frame patches the DOM in place and has no
  // server round-trip to re-fetch a translated string from.
  var ROOST_STATE_TEXT={
    idle:'${tJs("botboard.roostStateIdle", lang)}',
    working:'${tJs("botboard.roostStateWorking", lang)}',
    waiting:'${tJs("botboard.roostStateWaiting", lang)}',
    hibernating:'${tJs("botboard.roostStateHibernating", lang)}',
    observing:'${tJs("botboard.roostStateObserving", lang)}'
  };
  // Only the three LIVE-session states have a primary-action label to patch
  // (idle→dispatch and observing→attach-link never arrive over this SSE
  // channel — those are session-existence changes, not a state transition
  // on an already-live session; see the bird-state handler's own note).
  var ROOST_ACTION_TEXT={
    working:'${tJs("botboard.roostActionOpen", lang)}',
    hibernating:'${tJs("botboard.roostActionOpen", lang)}',
    waiting:'${tJs("botboard.roostActionAnswer", lang)}'
  };

  function perchApi(method,path,body){
    return fetch('/dashboard/perch-api'+path,{method:method,headers:{'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,credentials:'same-origin'})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,status:r.status,j:j};});});
  }

  // Task 13: the session drawer. Its emitted source lives in drawer.js (kept
  // out of THIS file to stay under the line budget) — spliced in here as a
  // bare block of statements sharing this IIFE's scope ($, clearEl,
  // openDrawer/closeDrawer, perchApi, crowToast, msg). Defines
  // openBirdDrawer(sessionId, botId, botName), closeBirdDrawer() and
  // bdFocusCard(cardId) — every roost/bird/hash entry point below calls one
  // of those three.
  ${birdDrawerJs(lang)}

  var roostDispatchEl=$('bb-roost-dispatch'), roostDispatchBotId=null;
  // Track 3 Task 14: the SAME dialog doubles as the drawer's attach-to-card
  // card picker — roostDispatchMode selects which POST 'bb-rd-send' below
  // fires; roostDispatchSid carries the already-live session it attaches
  // (dispatch mode never sets it, attach mode never sets roostDispatchBotId).
  var roostDispatchMode='dispatch', roostDispatchSid=null;
  function closeRoostDispatch(){ closeDrawer(roostDispatchEl); roostDispatchBotId=null; roostDispatchMode='dispatch'; roostDispatchSid=null; }
  if($('bb-rd-close')) $('bb-rd-close').onclick=closeRoostDispatch;

  // Card options come from the DOM (the currently rendered board), minus GET
  // /roost's occupiedCardIds — the SAME set a fresh dispatch OR attach would
  // 409 against (hibernating claims don't lock, so the DOM's own lock badges
  // can't answer this by themselves). Shared by both openRoostDispatch and
  // openRoostAttachCard below — the only difference between the two modes is
  // what 'bb-rd-send' posts, never how the card list is built.
  function bdLoadRoostDispatchCards(){
    var sel=$('bb-rd-card');
    if(sel) clearEl(sel);
    perchApi('GET','/roost').then(function(r){
      var occupied={};
      if(r.ok && r.j && r.j.occupiedCardIds){ r.j.occupiedCardIds.forEach(function(id){ occupied[Number(id)]=true; }); }
      var cards=[].slice.call(document.querySelectorAll('#bb-board .bb-card[data-card]'));
      var free=cards.filter(function(c){ return !occupied[Number(c.getAttribute('data-card'))]; });
      if(!sel) return;
      clearEl(sel);
      if(!free.length){
        msg($('bb-rd-msg'),'${tJs("botboard.roostDispatchNoCards", lang)}','warn');
        return;
      }
      free.forEach(function(c){
        var id=c.getAttribute('data-card');
        var titleEl=c.querySelector('.bb-title');
        sel.appendChild(optEl(id,'#'+id+' '+(titleEl?titleEl.textContent:''),false));
      });
    }).catch(function(){ msg($('bb-rd-msg'),'${tJs("botboard.loadFailed", lang)}','err'); });
  }

  // idle→Send out opens this.
  function openRoostDispatch(botId){
    roostDispatchMode='dispatch';
    roostDispatchSid=null;
    roostDispatchBotId=botId;
    msg($('bb-rd-msg'),'','');
    if($('bb-rd-note')) $('bb-rd-note').value='';
    if($('bb-rd-note-wrap')) $('bb-rd-note-wrap').style.display='';
    bdLoadRoostDispatchCards();
    openDrawer(roostDispatchEl);
  }

  // Track 3 Task 14: the drawer's "Attach to card" button opens this — SAME
  // dialog, SAME free-card picker, but posts attach-card against an
  // ALREADY-LIVE session instead of spawning a new one via dispatch. No note
  // field (attach-card's route takes no note).
  function openRoostAttachCard(sid){
    roostDispatchMode='attach';
    roostDispatchSid=sid;
    roostDispatchBotId=null;
    msg($('bb-rd-msg'),'','');
    if($('bb-rd-note-wrap')) $('bb-rd-note-wrap').style.display='none';
    bdLoadRoostDispatchCards();
    openDrawer(roostDispatchEl);
  }

  if($('bb-rd-send')) $('bb-rd-send').onclick=function(){
    var sel=$('bb-rd-card');
    var cardId=sel?sel.value:'';
    if(!cardId) return;
    var sendBtn=$('bb-rd-send');
    if(roostDispatchMode==='attach'){
      if(!roostDispatchSid) return;
      if(sendBtn) sendBtn.disabled=true;
      perchApi('POST','/interactive/'+encodeURIComponent(roostDispatchSid)+'/attach-card',{card_id:Number(cardId)}).then(function(r){
        if(!r.ok){
          if(sendBtn) sendBtn.disabled=false;
          msg($('bb-rd-msg'),(r.j&&r.j.error)||'${tJs("botboard.roostActionFailed", lang)}','err');
          return;
        }
        msg($('bb-rd-msg'),'${tJs("botboard.bdAttachSent", lang)}','ok');
        var attachedSid=roostDispatchSid;
        closeRoostDispatch();
        // Header updates: the drawer's own card-link + result gate re-read
        // straight off GET /bots/:id/sessions — the SAME source
        // bdLoadSessionMeta already hydrates from on open.
        if(bd.sid===attachedSid) bdAfterAttachCard();
      }).catch(function(){
        if(sendBtn) sendBtn.disabled=false;
        msg($('bb-rd-msg'),'${tJs("botboard.roostActionFailed", lang)}','err');
      });
      return;
    }
    if(!roostDispatchBotId) return;
    var note=$('bb-rd-note')?$('bb-rd-note').value:'';
    if(sendBtn) sendBtn.disabled=true;
    perchApi('POST','/bots/'+encodeURIComponent(roostDispatchBotId)+'/dispatch',{card_id:Number(cardId),note:note}).then(function(r){
      if(r.ok){
        // Fix round 1: a successful dispatch used to close the dialog and
        // call the (still-stub) openBirdDrawer — invisible, indistinguishable
        // from a dropped click. The strip/card-face bird can't be patched
        // into existence client-side (a bird-less card face carries no
        // .bb-bird span to patch — see the bird-state handler below), so the
        // honest fix is: show a perceivable success line, THEN reload. The
        // reloaded SSR renders the bird on the strip + card truthfully.
        msg($('bb-rd-msg'),'${tJs("botboard.roostDispatchSent", lang)}','ok');
        setTimeout(reload,600);
      } else if(r.status===409 && r.j && r.j.error==='card_occupied'){
        // A raced dispatch — surfaced as the dialog's OWN error line, not a
        // toast: the picker is still open and the operator needs to pick a
        // different card, not just be told something went wrong elsewhere.
        if(sendBtn) sendBtn.disabled=false;
        msg($('bb-rd-msg'),'${tJs("botboard.roostDispatchOccupied", lang)}','err');
      } else {
        if(sendBtn) sendBtn.disabled=false;
        msg($('bb-rd-msg'),(r.j&&r.j.error)||'${tJs("botboard.roostActionFailed", lang)}','err');
      }
    }).catch(function(){
      if(sendBtn) sendBtn.disabled=false;
      msg($('bb-rd-msg'),'${tJs("botboard.roostActionFailed", lang)}','err');
    });
  };

  // Click delegation over the whole roost strip: the overflow-menu toggle,
  // then every data-roost-action button. Plain <a> primary/setup links (the
  // observing state, and the overflow menu's Setup item) are NOT
  // data-roost-action — they navigate normally, no JS involved.
  document.addEventListener('click',function(ev){
    var menuBtn=ev.target.closest&&ev.target.closest('[data-roost-menu-toggle]');
    if(menuBtn){
      ev.preventDefault();
      var wrap=menuBtn.closest&&menuBtn.closest('.bb-roost-bird');
      var menu=wrap?wrap.querySelector('.bb-roost-menu'):null;
      var wasOpen=menu&&menu.classList.contains('bb-open');
      [].slice.call(document.querySelectorAll('.bb-roost-menu.bb-open')).forEach(function(m){
        m.classList.remove('bb-open'); m.setAttribute('aria-hidden','true');
      });
      [].slice.call(document.querySelectorAll('[data-roost-menu-toggle]')).forEach(function(b){
        b.setAttribute('aria-expanded','false');
      });
      if(menu && !wasOpen){ menu.classList.add('bb-open'); menu.setAttribute('aria-hidden','false'); menuBtn.setAttribute('aria-expanded','true'); }
      return;
    }
    if(!(ev.target.closest && ev.target.closest('.bb-roost-menu'))){
      [].slice.call(document.querySelectorAll('.bb-roost-menu.bb-open')).forEach(function(m){
        m.classList.remove('bb-open'); m.setAttribute('aria-hidden','true');
      });
    }
    var actBtn=ev.target.closest&&ev.target.closest('[data-roost-action]');
    if(!actBtn) return;
    var action=actBtn.getAttribute('data-roost-action');
    var botId=actBtn.getAttribute('data-bot');
    var sid=actBtn.getAttribute('data-sid');
    if(action==='dispatch'){ openRoostDispatch(botId); return; }
    // The DOM already carries the bird's display name (.bb-roost-name,
    // rendered by roostBirdHtml) — read it here rather than a fresh API
    // round trip just to fill in the drawer header.
    var birdWrap=actBtn.closest&&actBtn.closest('.bb-roost-bird');
    var nameEl=birdWrap&&birdWrap.querySelector('.bb-roost-name');
    var botName=nameEl?nameEl.textContent:null;
    if(action==='open' || action==='answer'){ openBirdDrawer(sid,botId,botName); return; }
    if(action==='sessions'){ openBirdDrawer(sid||null,botId,botName); return; }
    if(action==='talk'){
      perchApi('POST','/bots/'+encodeURIComponent(botId)+'/interactive').then(function(r){
        if(r.ok){ openBirdDrawer(r.j&&r.j.sessionId,botId,botName); }
        else { crowToast((r.j&&r.j.error)||'${tJs("botboard.roostActionFailed", lang)}', {type:'error'}); }
      }).catch(function(){ crowToast('${tJs("botboard.roostActionFailed", lang)}', {type:'error'}); });
      return;
    }
    if(action==='recall'){
      if(!sid || !confirm('${tJs("botboard.roostConfirmRecall", lang)}')) return;
      perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/stop').then(function(r){
        if(!r.ok){ crowToast((r.j&&r.j.error)||'${tJs("botboard.roostActionFailed", lang)}', {type:'error'}); }
      }).catch(function(){ crowToast('${tJs("botboard.roostActionFailed", lang)}', {type:'error'}); });
      return;
    }
  });

  // ---- EventSource live overlay ----
  if(window.EventSource && !INCLUDE_ARCHIVED){
    var esUrl=null;
    if(BOT_ID!=null){
      esUrl='/dashboard/streams/bot-board?bot='+encodeURIComponent(BOT_ID);
    } else if(PROJECT!=null){
      esUrl='/dashboard/streams/bot-board?project='+PROJECT;
    }
    if(esUrl){
      var es=new EventSource(esUrl);
      // Reload-storm guard, SHARED by every live-diff path below (board-config
      // drift, the default frame's card diff, and — fix round 1 — bird-state
      // falling through to a full refresh): one reload per 10s window,
      // persisted across the reload it triggers, so a render/stream mismatch
      // that can never converge degrades to "slow to catch up" instead of a
      // reload loop.
      function guardedReload(){
        var now=Date.now(), lastReload=0;
        try{ lastReload=Number(sessionStorage.getItem('bb-live-reload'))||0; }catch(e){}
        if(now-lastReload>10000){
          try{ sessionStorage.setItem('bb-live-reload',String(now)); }catch(e){}
          reload();
        }
      }
      es.addEventListener('board-config',function(ev){
        var cfg; try{ cfg=JSON.parse(ev.data); }catch(e){ return; }
        if(!cfg||!cfg.statuses||!cfg.statuses.length) return;
        // Compare against the CONFIGURED list stamped at render (data-statuses),
        // never the rendered columns: off-def cards legitimately add extra
        // columns, and diffing those against the def would reload forever.
        var board=document.getElementById('bb-board');
        var rendered=null;
        try{ rendered=board?JSON.parse(board.getAttribute('data-statuses')||'null'):null; }catch(e){ rendered=null; }
        if(rendered && rendered.length && JSON.stringify(rendered)!==JSON.stringify(cfg.statuses)){
          guardedReload();
        }
      });
      // Track 3 Task 12: bird-state patches classes IN PLACE — card face
      // glyph AND any roost-strip glyph carrying the SAME session id — and
      // never reloads for a transition it CAN patch. A session starting
      // fresh (a card face with no .bb-bird span to patch at all, or a strip
      // bird whose glyph carries no matching data-bird-sid) can't be patched
      // into existence client-side — fix round 1: that falls through to the
      // SAME guarded-reload path the default frame's card diff uses, so
      // OTHER tabs converge within a tick instead of staying stale forever.
      es.addEventListener('bird-state',function(ev){
        var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
        if(!d) return;
        var needsRefresh=false;
        for(var cid in d){
          if(!Object.prototype.hasOwnProperty.call(d,cid)) continue;
          var info=d[cid]||{};
          var state=info.state, sid=info.sid;
          if(!state) continue;
          var cardGlyph=document.querySelector('.bb-card[data-card="'+cid+'"] .bb-bird');
          if(cardGlyph){
            cardGlyph.className='bb-bird bb-bird--'+state;
            if(sid!=null) cardGlyph.setAttribute('data-bird-sid',String(sid));
          } else {
            needsRefresh=true;
          }
          if(sid!=null){
            var roostGlyphs=document.querySelectorAll('.bb-roost-bird .bb-bird[data-bird-sid="'+sid+'"]');
            if(!roostGlyphs.length) needsRefresh=true;
            [].slice.call(roostGlyphs).forEach(function(g){
              g.className='bb-bird bb-bird--'+state;
              var wrap=g.closest&&g.closest('.bb-roost-bird');
              if(!wrap) return;
              wrap.setAttribute('data-roost-state',state);
              var stateEl=wrap.querySelector('.bb-roost-state');
              if(stateEl && ROOST_STATE_TEXT[state]) stateEl.textContent=ROOST_STATE_TEXT[state];
              var primary=wrap.querySelector('.bb-roost-primary');
              if(primary && ROOST_ACTION_TEXT[state]) primary.textContent=ROOST_ACTION_TEXT[state];
            });
          }
        }
        if(needsRefresh && !document.hidden) guardedReload();
      });
      es.onmessage=function(ev){
        var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
        if(!d||!d.cards) return;
        var openDrawerId = drawer&&drawer.classList.contains('bb-open')&&cur?cur.id:null;
        var busyId = dragId!=null ? dragId : openDrawerId;
        var changed=false;
        var frameIds={};
        d.cards.forEach(function(c){
          frameIds[c.id]=true;
          var el=document.querySelector('.bb-card[data-card="'+c.id+'"]');
          var curStatus=el?el.getAttribute('data-status'):null;
          var curLocked=el?(el.getAttribute('data-locked')==='1'):false;
          var newLocked=!!(d.locks&&d.locks[c.id]);
          if(!el || curStatus!==c.status || curLocked!==newLocked){ if(c.id!==busyId) changed=true; }
        });
        // Track 1 (D-T1.6): the diff above is one-directional — a DOM card
        // that's ABSENT from the frame (archived from ANOTHER tab/session)
        // never trips anything on its own, so it would ghost on this board
        // forever. Compare the DOM card-id set against the frame's id set;
        // any DOM card missing from the frame counts as a change too.
        if(!changed){
          var domCards=document.querySelectorAll('#bb-board .bb-card[data-card]');
          for(var di=0;di<domCards.length;di++){
            var domId=Number(domCards[di].getAttribute('data-card'));
            if(domId!==busyId && !frameIds[domId]){ changed=true; break; }
          }
        }
        // Reload-storm guard: if the rendered board can never converge with
        // the stream snapshot (a render/stream query mismatch), an
        // unconditional reload loops forever — each fresh page re-detects
        // the same diff. SHARED with board-config/bird-state above
        // (guardedReload — fix round 1): one reload per 10s window,
        // persisted across the reload it triggers.
        if(changed && !document.hidden){
          guardedReload();
        }
      };
      es.onerror=function(){ /* EventSource auto-reconnects; server resends a full snapshot */ };
    }
  }
})();</script>`;
}
