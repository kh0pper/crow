/**
 * Bot Board Panel — Client JavaScript
 *
 * SSE live overlay, drag-and-drop, and slide-over drawer logic.
 * Returns an inline <script> block; uses tJs() for JS-context strings.
 */

import { tJs } from "../../shared/i18n.js";

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
    var DRAWER_FIELD_IDS=['bb-d-title-in','bb-d-status','bb-d-prio','bb-d-due','bb-d-owner','bb-d-tags','bb-d-desc','bb-d-project','bb-d-save','bb-d-cancel','bb-d-plan','bb-d-plan-save','bb-d-plan-approve'];
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
        var ps=$('bb-d-project'); clearEl(ps); ps.appendChild(optEl('','\\u2014 none \\u2014',false));
        (r.j.projects||[]).forEach(function(p){
          ps.appendChild(optEl(String(p.id),'#'+p.id+' \\u2014 '+(p.name||''),Number(c.project_id)===Number(p.id)));
        });
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
      tags:$('bb-d-tags').value||null,description:$('bb-d-desc').value||null};
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
      if(r.ok){ msg($('bb-d-msg'),'${tJs("board.archive", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-d-msg'),errText(r,'archive failed'),'err');
    });
  };
  if($('bb-d-unarchive')) $('bb-d-unarchive').onclick=function(){
    if(!cur||!cur.archived) return;
    api('POST','/card/'+cur.id+'/unarchive').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'${tJs("board.unarchive", lang)}','ok'); setTimeout(reload,400); }
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
      if(r.ok){ msg($('bb-td-msg'),'${tJs("board.archive", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-td-msg'),errText(r,'archive failed'),'err');
    });
  };
  if($('bb-td-unarchive')) $('bb-td-unarchive').onclick=function(){
    if(!cur||!cur.archived) return;
    api('POST','/tracker-item/'+cur.id+'/unarchive').then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'${tJs("board.unarchive", lang)}','ok'); setTimeout(reload,400); }
      else msg($('bb-td-msg'),errText(r,'unarchive failed'),'err');
    });
  };

  // ---- Drag and drop ----
  document.addEventListener('dragstart',function(e){
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
      tags:$('bb-nc-tags').value||null,project_id:PROJECT}).then(function(r){
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
          var now=Date.now(), lastReload=0;
          try{ lastReload=Number(sessionStorage.getItem('bb-live-reload'))||0; }catch(e){}
          if(now-lastReload>10000){
            try{ sessionStorage.setItem('bb-live-reload',String(now)); }catch(e){}
            reload();
          }
        }
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
        // the same diff. One reload per 10s window; persisted across the
        // reload it triggers.
        if(changed && !document.hidden){
          var now=Date.now(), lastReload=0;
          try{ lastReload=Number(sessionStorage.getItem('bb-live-reload'))||0; }catch(e){}
          if(now-lastReload>10000){
            try{ sessionStorage.setItem('bb-live-reload',String(now)); }catch(e){}
            reload();
          }
        }
      };
      es.onerror=function(){ /* EventSource auto-reconnects; server resends a full snapshot */ };
    }
  }
})();</script>`;
}
