/**
 * Bot Board Panel — the session drawer (Track 3 Task 13)
 *
 * The right slide-over that opens on a bird click, a card-face bird glyph
 * click, or a `#bird=<sid>`/`#card=<id>` hash deep link: live transcript +
 * composer/steer + inline ask_user cards for ONE interactive-engine session
 * (perch-interactive.js). Kept out of client.js (which just mounts/wires it)
 * to keep that file under its line-budget — everything here is plain
 * function declarations meant to be spliced into client.js's own top-level
 * IIFE, sharing its scope (`$`, `clearEl`, `openDrawer`, `closeDrawer`,
 * `perchApi`, `crowToast`, `msg`). No separate `<script>` tag, no import of
 * its own at runtime — `birdDrawerJs()` returns a bare string of statements,
 * NOT a self-executing block.
 *
 * TEMPLATE-LITERAL EMISSION RULES (repo-wide): the string this file returns
 * is itself embedded inside client.js's own template literal, so it can
 * never contain a raw backtick, and any `${` must be escaped as `\${` unless
 * it is a REAL interpolation into THIS module's own template literal (i.e. a
 * tJs()/t() call evaluated here, at render time, in Node).
 */
import { t, tJs } from "../../shared/i18n.js";
import { PERCH_TOKENS } from "../../shared/design-tokens.js";

/** Drawer-specific CSS — concatenated into css.js's botBoardStyles() output. */
export function birdDrawerCss() {
  return `
  .bb-bird-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:49}
  .bb-bird-backdrop.bb-open{opacity:1;pointer-events:auto}
  .bb-bird-drawer{display:flex;flex-direction:column}
  .bb-bd-menu-wrap{position:relative}
  .bb-bd-menu{display:none;position:absolute;top:100%;right:0;margin-top:.2rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.2);padding:.3rem;z-index:20;min-width:110px}
  .bb-bd-menu.bb-open{display:block}
  .bb-bd-menu button{display:block;width:100%;text-align:left;background:none;border:none;padding:.3rem .4rem;font-size:.75rem;color:var(--crow-text-primary);cursor:pointer;border-radius:4px;font:inherit}
  .bb-bd-menu button:hover{background:var(--crow-bg-elevated)}
  .bb-bd-transcript{flex:1;min-height:220px;margin:.5rem 0}
  .bb-bd-line{margin-bottom:.55rem;font-size:.85rem;display:flex;gap:.4rem;align-items:baseline;flex-wrap:wrap}
  .bb-bd-who{font-weight:600;font-size:.68rem;text-transform:uppercase;letter-spacing:.03em;color:var(--crow-text-muted);flex:0 0 auto}
  .bb-bd-body{flex:1 1 auto;min-width:60%;white-space:pre-wrap;word-break:break-word}
  .bb-bd-user .bb-bd-who{color:${PERCH_TOKENS.light.teal}}
  .bb-bd-sys{color:var(--crow-text-muted);font-size:.78rem;font-style:italic}
  .bb-bd-sys.bb-bd-err{color:#c0392b}
  .bb-bd-sys.bb-bd-warn{color:#b8860b}
  .bb-bd-copy{font-size:.65rem;padding:.05rem .35rem;background:none;border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-muted);cursor:pointer;flex:0 0 auto}
  .bb-bd-ask-card{background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px;padding:.6rem;margin:.5rem 0}
  .bb-bd-ask-title{font-weight:600;margin-bottom:.3rem}
  .bb-bd-ask-message{font-size:.85rem;color:var(--crow-text-secondary);margin-bottom:.4rem}
  .bb-bd-ask-opts{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.4rem}
  .bb-bd-ask-form{display:flex;gap:.4rem;margin-bottom:.4rem}
  .bb-bd-ask-form input,.bb-bd-ask-form textarea{flex:1;padding:.4rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font:inherit}
  .bb-bd-ask-answered{font-size:.82rem;color:var(--crow-text-muted);font-style:italic;margin:.5rem 0}
  .bb-bd-picker-row{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.4rem 0;border-bottom:1px solid var(--crow-border);font-size:.85rem}
  .bb-card-focus{outline:2px solid ${PERCH_TOKENS.light.teal};outline-offset:2px}
  .bb-bd-controls-row{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:.6rem 0}
  .bb-bd-controls-row select{width:auto;flex:1 1 auto;min-width:110px;padding:.3rem .4rem;font-size:.8rem}
  .bb-bd-plan-label{display:flex;align-items:center;gap:.3rem;font-size:.8rem;color:var(--crow-text-secondary);text-transform:none;letter-spacing:normal;margin:0;flex:0 0 auto}
  .bb-bd-plan-label input{width:auto}
  .bb-bd-controls-toggle-wrap{display:flex;gap:.4rem;flex-wrap:wrap;margin:.3rem 0}
  .bb-bd-controls-pane{margin:.4rem 0;padding:.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px}
  .bb-bd-tools{display:flex;flex-direction:column;gap:.25rem;margin:.4rem 0}
  .bb-bd-tool{display:flex;align-items:center;gap:.4rem;font-size:.82rem;color:var(--crow-text-primary)}
  .bb-bd-tool-locked{font-size:.78rem;color:var(--crow-text-muted)}
  .bb-bd-narrow-note{font-size:.72rem;color:var(--crow-text-muted);margin-top:.4rem}
  .bb-bd-files{display:flex;align-items:center;gap:.5rem;margin:.3rem 0}
  .bb-bd-files-queue{font-size:.75rem;color:var(--crow-text-muted)}
  @media (prefers-color-scheme: dark) {
    .bb-bd-user .bb-bd-who{color:${PERCH_TOKENS.dark.teal}}
    .bb-card-focus{outline-color:${PERCH_TOKENS.dark.teal}}
  }`;
}

/**
 * Drawer client JS — a bare block of statements (function/var declarations),
 * spliced into client.js's own IIFE via clientJs()'s template literal. Every
 * i18n string below is resolved HERE (Node, at render time) via t()/tJs();
 * nothing in the emitted output calls into i18n at runtime.
 *
 * @param {string} lang
 */
export function birdDrawerJs(lang) {
  return `
  // ---- Track 3 Task 13: the session drawer ----
  var bdBackdrop=$('bb-bird-backdrop'), bdEl=$('bb-bird-drawer');
  var bdMenuToggle=$('bb-bd-menu-toggle'), bdMenu=$('bb-bd-menu'), bdStopBtn=$('bb-bd-stop');
  var bdNameEl=$('bb-bd-name'), bdStateEl=$('bb-bd-state');
  var bdCardLinkWrap=$('bb-bd-card-link-wrap'), bdCardLink=$('bb-bd-card-link');
  var bdHibernatingEl=$('bb-bd-hibernating');
  var bdPickerEl=$('bb-bd-picker'), bdComposerEl=$('bb-bd-composer');
  var bdTranscriptEl=$('bb-bd-transcript'), bdAskEl=$('bb-bd-ask');
  var bdInputEl=$('bb-bd-input'), bdSendBtn=$('bb-bd-send'), bdAbortBtn=$('bb-bd-abort');
  // Track 3 Task 14: controls row (model/thinking/permission/plan), the
  // collapsible envelope+narrowing pane, files, attach-to-card and the
  // in-drawer result gate.
  var bdModelSel=$('bb-bd-model'), bdThinkingSel=$('bb-bd-thinking');
  var bdPermSel=$('bb-bd-permission'), bdPlanToggle=$('bb-bd-plan-toggle');
  var bdBindsAtWakeEl=$('bb-bd-bindsatwake'), bdApplyNowBtn=$('bb-bd-apply-now');
  var bdControlsToggle=$('bb-bd-controls-toggle'), bdControlsPaneEl=$('bb-bd-controls-pane');
  var bdAttachCardBtn=$('bb-bd-attach-card'), bdResultEl=$('bb-bd-result');
  var bdAttachBtn=$('bb-bd-attach'), bdFileInputEl=$('bb-bd-file-input'), bdFilesQueueEl=$('bb-bd-files-queue');

  var BD_STATE_TEXT={
    awake:'${tJs("botboard.bdStateAwake", lang)}',
    hibernating:'${tJs("botboard.roostStateHibernating", lang)}',
    stopped:'${tJs("botboard.bdStateStopped", lang)}'
  };

  function bdBlank(){
    return {sid:null,botId:null,botName:null,threadId:null,cardId:null,
      es:null,esTimer:null,esRetries:0,turnInFlight:false,turnHadText:false,pendingCard:null,
      savedNarrowing:undefined,uploads:[]};
  }
  var bd=bdBlank();

  function bdCloseStream(){
    if(bd.es){ try{bd.es.close();}catch(e){} }
    if(bd.esTimer){ clearTimeout(bd.esTimer); bd.esTimer=null; }
  }
  function bdReset(){
    bdCloseStream();
    bd=bdBlank();
  }

  function bdSetComposerVisible(v){ if(bdComposerEl) bdComposerEl.style.display=v?'':'none'; }

  function bdSetTurnInFlight(f){
    bd.turnInFlight=f;
    if(bdAbortBtn) bdAbortBtn.style.display=f?'':'none';
    if(bdSendBtn) bdSendBtn.textContent=f?'${tJs("botboard.bdSteer", lang)}':'${tJs("botboard.bdSend", lang)}';
    bdUpdateCycleDisabled();
  }

  // Track 3 Task 14: "apply now" (POST cycle) is refused mid-turn or with a
  // pending ask_user card (perch-interactive.js's own cycle_busy guard —
  // s.turn || s.pendingUi || s.cycling) — the drawer already tracks both
  // halves of that off the SSE stream (bd.turnInFlight, bd.pendingCard), so
  // the button disables itself the same way rather than round-tripping to
  // find out.
  function bdUpdateCycleDisabled(){
    if(bdApplyNowBtn) bdApplyNowBtn.disabled=!!(bd.turnInFlight||bd.pendingCard);
  }

  function bdSetState(state){
    bd.state=state;
    if(bdStateEl) bdStateEl.textContent=state?(BD_STATE_TEXT[state]||state):'';
    if(bdHibernatingEl) bdHibernatingEl.style.display=(state==='hibernating')?'':'none';
    if(state==='awake') bdLoadOptions(); else bdSetOptionsDisabled();
  }

  // ---- model / thinking-level menus (GET options — null when hibernating) ----
  function bdSetOptionsDisabled(){
    if(bdModelSel){ clearEl(bdModelSel); bdModelSel.disabled=true; }
    if(bdThinkingSel){ clearEl(bdThinkingSel); bdThinkingSel.disabled=true; }
  }
  function bdRenderOptions(models,thinkingLevels){
    if(bdModelSel){
      clearEl(bdModelSel);
      if(models&&models.length){
        bdModelSel.disabled=false;
        models.forEach(function(m){
          var o=document.createElement('option');
          o.value=m.provider+'/'+m.id;
          o.textContent=m.label||(m.provider+'/'+m.id);
          bdModelSel.appendChild(o);
        });
      } else { bdModelSel.disabled=true; }
    }
    if(bdThinkingSel){
      clearEl(bdThinkingSel);
      if(thinkingLevels&&thinkingLevels.length){
        bdThinkingSel.disabled=false;
        thinkingLevels.forEach(function(lvl){
          var o=document.createElement('option'); o.value=lvl; o.textContent=lvl;
          bdThinkingSel.appendChild(o);
        });
      } else { bdThinkingSel.disabled=true; }
    }
  }
  function bdLoadOptions(){
    if(!bd.sid) return;
    var mySid=bd.sid;
    perchApi('GET','/interactive/'+encodeURIComponent(bd.sid)+'/options').then(function(r){
      if(bd.sid!==mySid) return;
      if(!r.ok||!r.j){ bdSetOptionsDisabled(); return; }
      bdRenderOptions(r.j.models,r.j.thinkingLevels);
    }).catch(function(){ if(bd.sid===mySid) bdSetOptionsDisabled(); });
  }

  // ---- POST control (model/thinking/permission/plan) ----
  function bdShowBindsAtWake(bindsAtWake){
    var keys=bindsAtWake?Object.keys(bindsAtWake):[];
    if(bdBindsAtWakeEl) bdBindsAtWakeEl.style.display=keys.length?'':'none';
    bdUpdateCycleDisabled();
  }
  function bdControl(opts,onFail){
    if(!bd.sid) return;
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/control',opts).then(function(r){
      if(r.ok) bdShowBindsAtWake(r.j&&r.j.bindsAtWake);
      else { if(onFail) onFail(); crowToast((r.j&&r.j.error)||'${tJs("botboard.bdControlFailed", lang)}',{type:'error'}); }
    }).catch(function(){ if(onFail) onFail(); crowToast('${tJs("botboard.bdControlFailed", lang)}',{type:'error'}); });
  }
  if(bdModelSel) bdModelSel.onchange=function(){
    if(!bdModelSel.value) return;
    var slash=bdModelSel.value.indexOf('/');
    if(slash<0) return;
    bdControl({model:{provider:bdModelSel.value.slice(0,slash),id:bdModelSel.value.slice(slash+1)}});
  };
  if(bdThinkingSel) bdThinkingSel.onchange=function(){
    if(!bdThinkingSel.value) return;
    bdControl({thinking:bdThinkingSel.value});
  };
  if(bdPermSel) bdPermSel.onchange=function(){
    bdControl({permission_mode:bdPermSel.value});
  };
  if(bdPlanToggle) bdPlanToggle.onchange=function(){
    var v=bdPlanToggle.checked;
    bdControl({plan_mode:v},function(){ bdPlanToggle.checked=!v; });
  };
  if(bdApplyNowBtn) bdApplyNowBtn.onclick=function(){
    if(!bd.sid) return;
    bdApplyNowBtn.disabled=true;
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/cycle').then(function(r){
      if(r.ok){ if(bdBindsAtWakeEl) bdBindsAtWakeEl.style.display='none'; }
      else { bdUpdateCycleDisabled(); crowToast((r.j&&r.j.error)||'${tJs("botboard.bdCycleFailed", lang)}',{type:'error'}); }
    }).catch(function(){ bdUpdateCycleDisabled(); crowToast('${tJs("botboard.bdCycleFailed", lang)}',{type:'error'}); });
  };

  // ---- collapsible envelope + narrowing pane (ported from
  // bots-page.mjs:433-509, restated in THIS module's DOM-building idiom) ----
  function bdToggleControlsPane(){
    var open=bdControlsPaneEl && bdControlsPaneEl.style.display!=='none';
    if(open){
      if(bdControlsPaneEl) bdControlsPaneEl.style.display='none';
      if(bdControlsToggle) bdControlsToggle.setAttribute('aria-expanded','false');
      return;
    }
    if(bdControlsToggle) bdControlsToggle.setAttribute('aria-expanded','true');
    bdLoadControlsPane();
  }
  if(bdControlsToggle) bdControlsToggle.onclick=bdToggleControlsPane;

  function bdControlsPaneErr(){
    clearEl(bdControlsPaneEl);
    var e=document.createElement('div'); e.className='bb-msg err';
    e.textContent='${tJs("botboard.loadFailed", lang)}';
    bdControlsPaneEl.appendChild(e);
  }
  function bdLoadControlsPane(){
    if(!bdControlsPaneEl||!bd.botId) return;
    clearEl(bdControlsPaneEl);
    var loading=document.createElement('div'); loading.className='bb-msg';
    loading.textContent='\\u2026';
    bdControlsPaneEl.appendChild(loading);
    bdControlsPaneEl.style.display='';
    var mySid=bd.sid;
    perchApi('GET','/bots/'+encodeURIComponent(bd.botId)+'/envelope').then(function(r){
      if(bd.sid!==mySid) return;
      if(!r.ok||!r.j){ bdControlsPaneErr(); return; }
      bdRenderControlsPane(r.j);
    }).catch(function(){ if(bd.sid===mySid) bdControlsPaneErr(); });
  }
  /**
   * Tri-state saved narrowing off a bot_sessions row (bots-page.mjs
   * savedNarrowing(), restated): a Set is a real narrowing, null is
   * "reported, nothing narrowed", undefined is "not reported at all" — the
   * middle case must never collapse into the last one (that blamed the Crow
   * build for an empty session, the acceptance finding the source note
   * there records).
   */
  function bdSavedNarrowingFromRow(row){
    if(!row||!Object.prototype.hasOwnProperty.call(row,'narrowed_tools')) return undefined;
    var list=row.narrowed_tools;
    if(list==null) return null;
    if(typeof list==='string'){
      try{ list=JSON.parse(list); }catch(e){ return undefined; }
    }
    if(!Array.isArray(list)) return undefined;
    var s={}; list.forEach(function(id){ s[String(id)]=true; });
    return s;
  }
  function bdRenderControlsPane(envelope){
    clearEl(bdControlsPaneEl);
    var allowed=envelope.tools||[];
    var denied=envelope.denied||[];
    var saved=bd.savedNarrowing;
    var disabledSet=(saved&&typeof saved==='object')?saved:{};
    var head=document.createElement('div');
    head.className='bb-msg';
    var skillsTxt=(envelope.skills||[]).length?(' \\u00b7 ${tJs("botboard.bdEnvelopeSkillsPrefix", lang)}'+envelope.skills.join(', ')):'';
    head.textContent='${tJs("botboard.bdEnvelopeModelPrefix", lang)}'+(envelope.model||'${tJs("botboard.bdEnvelopeModelUnset", lang)}')+skillsTxt;
    bdControlsPaneEl.appendChild(head);
    var toolsWrap=document.createElement('div'); toolsWrap.className='bb-bd-tools';
    if(!allowed.length && !denied.length){
      var none=document.createElement('div'); none.className='bb-bd-tool-locked';
      none.textContent='${tJs("botboard.bdToolsNone", lang)}';
      toolsWrap.appendChild(none);
    }
    allowed.forEach(function(tool){
      var label=document.createElement('label'); label.className='bb-bd-tool';
      var cb=document.createElement('input'); cb.type='checkbox';
      cb.checked=!disabledSet[String(tool.id)];
      cb.setAttribute('data-bd-tool',tool.id);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' '+(tool.label||tool.id)));
      toolsWrap.appendChild(label);
    });
    denied.forEach(function(tool){
      var locked=document.createElement('div'); locked.className='bb-bd-tool-locked';
      locked.textContent='\\uD83D\\uDD12 '+(tool.label||tool.id);
      toolsWrap.appendChild(locked);
    });
    bdControlsPaneEl.appendChild(toolsWrap);
    var note=document.createElement('div'); note.className='bb-bd-narrow-note';
    note.textContent = (saved&&typeof saved==='object') ? '${tJs("botboard.bdNarrowNoteSaved", lang)}'
      : saved===null ? '${tJs("botboard.bdNarrowNoteEmpty", lang)}'
      : '${tJs("botboard.bdNarrowNoteUnknown", lang)}';
    bdControlsPaneEl.appendChild(note);
    var narrowMsg=document.createElement('div'); narrowMsg.className='bb-msg';
    bdControlsPaneEl.appendChild(narrowMsg);
    toolsWrap.addEventListener('change',function(ev){
      if(ev.target && ev.target.hasAttribute('data-bd-tool')) bdSaveNarrowing(toolsWrap,narrowMsg,ev.target);
    });
  }
  function bdSaveNarrowing(toolsWrap,narrowMsg,changedInput){
    if(!bd.botId||!bd.threadId) return;
    var boxes=[].slice.call(toolsWrap.querySelectorAll('[data-bd-tool]'));
    var disabled=boxes.filter(function(b){ return !b.checked; }).map(function(b){ return b.getAttribute('data-bd-tool'); });
    narrowMsg.className='bb-msg';
    narrowMsg.textContent='\\u2026';
    perchApi('POST','/bots/'+encodeURIComponent(bd.botId)+'/sessions/'+encodeURIComponent(bd.threadId)+'/narrow',{disabled_tools:disabled}).then(function(r){
      if(r.ok){
        narrowMsg.textContent=disabled.length
          ? '${tJs("botboard.bdNarrowedToPrefix", lang)}'+(boxes.length-disabled.length)+'${tJs("botboard.bdNarrowedToMid", lang)}'+boxes.length+'${tJs("botboard.bdNarrowedToSuffix", lang)}'
          : '${tJs("botboard.bdFullEnvelopeRestored", lang)}';
      } else {
        changedInput.checked=!changedInput.checked;
        narrowMsg.className='bb-msg err';
        narrowMsg.textContent=(r.j&&r.j.error==='widening_rejected')?'${tJs("botboard.bdNarrowRejected", lang)}':'${tJs("botboard.bdNarrowFailed", lang)}';
      }
    }).catch(function(){
      changedInput.checked=!changedInput.checked;
      narrowMsg.className='bb-msg err';
      narrowMsg.textContent='${tJs("botboard.bdNarrowFailed", lang)}';
    });
  }

  // ---- files: attach → base64 upload → queue onto the NEXT send's images ----
  function bdRenderFilesQueue(){
    if(!bdFilesQueueEl) return;
    bdFilesQueueEl.textContent=bd.uploads.length
      ? '${tJs("botboard.bdFilesQueuedPrefix", lang)}'+bd.uploads.map(function(u){ return u.name; }).join(', ')
      : '';
  }
  if(bdAttachBtn) bdAttachBtn.onclick=function(){ if(bdFileInputEl) bdFileInputEl.click(); };
  if(bdFileInputEl) bdFileInputEl.onchange=function(){
    var file=bdFileInputEl.files&&bdFileInputEl.files[0];
    bdFileInputEl.value='';
    if(!file||!bd.sid) return;
    var mySid=bd.sid;
    var reader=new FileReader();
    reader.onload=function(){
      if(bd.sid!==mySid) return;
      var result=String(reader.result||'');
      var comma=result.indexOf(',');
      var b64=comma>=0?result.slice(comma+1):result;
      perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/files',{name:file.name,data_b64:b64}).then(function(r){
        if(bd.sid!==mySid) return;
        if(r.ok){
          if(/^image\\//.test(file.type)) bd.uploads.push({mime:file.type,data_b64:b64,name:file.name});
          bdAppendNote('','${tJs("botboard.bdFileUploaded", lang)}'+' '+file.name);
          bdRenderFilesQueue();
        } else { crowToast((r.j&&r.j.error)||'${tJs("botboard.bdUploadFailed", lang)}',{type:'error'}); }
      }).catch(function(){ if(bd.sid===mySid) crowToast('${tJs("botboard.bdUploadFailed", lang)}',{type:'error'}); });
    };
    reader.readAsDataURL(file);
  };

  // ---- outputs/<sid>/<rel> links + inline images in bot text/reply (ported
  // from the workspace confinement contract routes/perch-interactive-api.js
  // enforces server-side — this is display-only, the actual jail is there).
  // Plain string scanning, deliberately NOT a regex built from bd.sid — a
  // dynamic session id has no business being interpolated into a regex
  // source string (metacharacter-escaping a caller-influenced value for THAT
  // purpose is exactly the kind of thing that goes quietly wrong). ----
  function bdIsBoundaryChar(ch){
    return ch===' '||ch==='\\t'||ch==='\\n'||ch==='\\r'||ch==='"'||ch==="'"||ch==='<'||ch==='>';
  }
  var BD_IMG_EXTS=['.png','.jpg','.jpeg','.webp','.gif'];
  function bdLooksLikeImage(rel){
    var lower=rel.toLowerCase();
    for(var i=0;i<BD_IMG_EXTS.length;i++){
      var ext=BD_IMG_EXTS[i];
      if(lower.length>=ext.length && lower.slice(lower.length-ext.length)===ext) return true;
    }
    return false;
  }
  function bdRenderBodyWithLinks(bodyEl,text){
    if(!bd.sid){ bodyEl.textContent=text; return; }
    var marker='outputs/'+bd.sid+'/';
    var pos=0, any=false;
    var idx=text.indexOf(marker,pos);
    while(idx>=0){
      any=true;
      if(idx>pos) bodyEl.appendChild(document.createTextNode(text.slice(pos,idx)));
      var relStart=idx+marker.length, relEnd=relStart;
      while(relEnd<text.length && !bdIsBoundaryChar(text.charAt(relEnd))) relEnd++;
      var rel=text.slice(relStart,relEnd);
      var url='/dashboard/perch-api/interactive/'+encodeURIComponent(bd.sid)+'/workspace/'+rel.split('/').map(encodeURIComponent).join('/');
      if(bdLooksLikeImage(rel)){
        var img=document.createElement('img');
        img.src=url; img.alt=rel; img.className='bb-bd-inline-img';
        bodyEl.appendChild(img);
      } else {
        var a=document.createElement('a');
        a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent=marker+rel;
        bodyEl.appendChild(a);
      }
      pos=relEnd;
      idx=text.indexOf(marker,pos);
    }
    if(!any){ bodyEl.textContent=text; return; }
    if(pos<text.length) bodyEl.appendChild(document.createTextNode(text.slice(pos)));
  }

  // ---- attach-to-card: header updates once client.js's dialog confirms ----
  function bdAfterAttachCard(){ bdLoadSessionMeta(); }

  // ---- result gate: a pending gated result on the session's OWN card ----
  function bdLoadResultGate(){
    if(!bdResultEl) return;
    if(!bd.cardId){ clearEl(bdResultEl); return; }
    var myCardId=bd.cardId, mySid=bd.sid;
    api('GET','/card/'+myCardId).then(function(r){
      if(bd.sid!==mySid||bd.cardId!==myCardId) return;
      if(!r.ok||!r.j) return;
      bdRenderResultGate((r.j.latest_results||[])[0]||null);
    }).catch(function(){});
  }
  function bdRenderResultGate(latest){
    if(!bdResultEl) return;
    clearEl(bdResultEl);
    if(!latest||latest.status!=='recorded'||latest.outcome!=='success') return;
    var box=document.createElement('div'); box.className='bb-msg bb-marker-waiting';
    var head=document.createElement('div');
    head.textContent='${tJs("board.markerWaiting", lang)}';
    box.appendChild(head);
    var row=document.createElement('div'); row.className='bb-result-actions';
    var acc=document.createElement('button'); acc.type='button'; acc.className='bb-btn bb-sec';
    acc.textContent='${tJs("board.btnApproveResult", lang)}';
    var rej=document.createElement('button'); rej.type='button'; rej.className='bb-btn bb-sec';
    rej.textContent='${tJs("board.btnRejectResult", lang)}';
    var buttons=[acc,rej];
    acc.onclick=function(){ bdDecideResultGate(latest.id,'approved',buttons); };
    rej.onclick=function(){ bdDecideResultGate(latest.id,'rejected',buttons); };
    row.appendChild(acc); row.appendChild(rej);
    box.appendChild(row);
    bdResultEl.appendChild(box);
  }
  function bdDecideResultGate(resultId,decision,buttons){
    if(!bd.cardId) return;
    var cardId=bd.cardId;
    buttons.forEach(function(b){ b.disabled=true; });
    // Two-step (spec §4), same order as the card-face handler (client.js):
    // decide first, THEN — on accept only — the existing move-to-'done' call.
    api('POST','/card/'+cardId+'/result/'+resultId+'/decide',{decision:decision}).then(function(r){
      if(!r.ok){ buttons.forEach(function(b){ b.disabled=false; }); crowToast((r.j&&r.j.error)||'${tJs("botboard.bdResultDecideFailed", lang)}',{type:'error'}); return; }
      if(decision==='approved'){
        api('POST','/card/'+cardId+'/move',{status:'done'}).then(function(r2){
          if(r2.ok) bdLoadResultGate();
          else { buttons.forEach(function(b){ b.disabled=false; }); crowToast((r2.j&&r2.j.error)||'${tJs("botboard.bdResultDecideFailed", lang)}',{type:'error'}); }
        }).catch(function(){ buttons.forEach(function(b){ b.disabled=false; }); crowToast('${tJs("botboard.bdResultDecideFailed", lang)}',{type:'error'}); });
      } else {
        bdLoadResultGate();
      }
    }).catch(function(){ buttons.forEach(function(b){ b.disabled=false; }); crowToast('${tJs("botboard.bdResultDecideFailed", lang)}',{type:'error'}); });
  }

  function bdUpdateHeader(){
    if(bdNameEl) bdNameEl.textContent=bd.botName||bd.botId||'';
  }

  // Round-trips the #bird= hash through the SAME foreign-key preservation
  // updateFilterHash()/parseFilterHash() carry (client.js, Feature 1) —
  // window._bbApplyFilters is that block's own escape hatch; a board with no
  // filter UI at all (custom-tracker paths without it, or this hook firing
  // before that block runs) falls back to writing the hash directly.
  function bdSetHashKey(key,value){
    window._bbForeignHash=window._bbForeignHash||{};
    if(value==null) delete window._bbForeignHash[key]; else window._bbForeignHash[key]=String(value);
    if(typeof window._bbApplyFilters==='function'){ window._bbApplyFilters(); return; }
    var parts=[];
    for(var k in window._bbForeignHash){
      if(Object.prototype.hasOwnProperty.call(window._bbForeignHash,k) && window._bbForeignHash[k]!=null){
        parts.push(k+'='+encodeURIComponent(window._bbForeignHash[k]));
      }
    }
    var h=parts.length?'#'+parts.join('&'):'';
    if(location.hash!==h) history.replaceState(null,'',location.pathname+location.search+h);
  }

  function bdAppendNote(cls,text){
    if(!bdTranscriptEl) return;
    var row=document.createElement('div');
    row.className='bb-bd-line bb-bd-sys'+(cls?' bb-bd-'+cls:'');
    row.textContent=text;
    bdTranscriptEl.appendChild(row);
    bdTranscriptEl.scrollTop=bdTranscriptEl.scrollHeight;
  }

  function bdAppendMessage(cls,who,text){
    if(!bdTranscriptEl) return;
    var row=document.createElement('div');
    row.className='bb-bd-line bb-bd-'+cls;
    var whoEl=document.createElement('span');
    whoEl.className='bb-bd-who';
    whoEl.textContent=who;
    row.appendChild(whoEl);
    var bodyEl=document.createElement('span');
    bodyEl.className='bb-bd-body';
    // Track 3 Task 14: bot text/reply content gets the outputs/<sid>/<rel>
    // link+inline-image treatment; every other line (user, sys/log/tool)
    // renders as plain text, unchanged.
    if(cls==='bot') bdRenderBodyWithLinks(bodyEl,text); else bodyEl.textContent=text;
    row.appendChild(bodyEl);
    if((cls==='bot'||cls==='user') && navigator.clipboard && navigator.clipboard.writeText){
      var copyBtn=document.createElement('button');
      copyBtn.type='button'; copyBtn.className='bb-bd-copy';
      copyBtn.textContent='${tJs("botboard.bdCopy", lang)}';
      copyBtn.onclick=function(){
        navigator.clipboard.writeText(text).then(function(){
          crowToast('${tJs("botboard.bdCopied", lang)}',{type:'success'});
        });
      };
      row.appendChild(copyBtn);
    }
    bdTranscriptEl.appendChild(row);
    bdTranscriptEl.scrollTop=bdTranscriptEl.scrollHeight;
  }

  /** Same content-block walk as the Perch Hub lens (bots-page.mjs
   * messageText()) — a raw pi transcript message's content array. */
  function bdMessageText(message){
    var content=message&&message.content;
    if(typeof content==='string') return content;
    if(Array.isArray(content)){
      return content.map(function(b){
        if(!b) return '';
        if(typeof b.text==='string') return b.text;
        if(b.type==='toolCall') return '[tool: '+(b.name||'?')+']';
        return b.type?'['+b.type+']':'';
      }).filter(Boolean).join('\\n');
    }
    if(typeof (message&&message.text)==='string') return message.text;
    return '';
  }

  function bdLoadTranscript(){
    if(!bd.botId||!bd.threadId) return;
    var mySid=bd.sid;
    perchApi('GET','/bots/'+encodeURIComponent(bd.botId)+'/sessions/'+encodeURIComponent(bd.threadId)+'/transcript').then(function(r){
      if(bd.sid!==mySid) return;
      if(!r.ok||!r.j||!r.j.events||!r.j.events.length){
        bdAppendNote('','${tJs("botboard.bdNoTranscript", lang)}');
        return;
      }
      r.j.events.filter(function(e){ return e&&e.type==='message'; }).forEach(function(e){
        var m=e.message||{};
        var role=String(m.role||'?');
        bdAppendMessage(role==='user'?'user':'bot', role, bdMessageText(m));
      });
    }).catch(function(){
      if(bd.sid!==mySid) return;
      bdAppendNote('err','${tJs("botboard.bdTranscriptFailed", lang)}');
    });
  }

  /** GET /bots/:id/sessions doubles as the source for the header's card link
   * (card_id) AND the control='interrupted' system note — the engine's own
   * SSE 'state' event carries neither (perch-interactive.js's stateEvent()
   * is deliberately thinner than snapshot()). */
  function bdLoadSessionMeta(){
    if(!bd.botId) return;
    var mySid=bd.sid;
    perchApi('GET','/bots/'+encodeURIComponent(bd.botId)+'/sessions').then(function(r){
      if(bd.sid!==mySid||!r.ok||!r.j||!r.j.sessions) return;
      var row=null;
      for(var i=0;i<r.j.sessions.length;i++){
        if(String(r.j.sessions[i].gateway_thread_id)===String(bd.threadId)){ row=r.j.sessions[i]; break; }
      }
      if(!row) return;
      // Track 3 Task 14: the SAME row carries this session's tri-state saved
      // narrowing (bots-page.mjs precedent, restated) — feeds the collapsible
      // envelope pane whenever it's next opened.
      bd.savedNarrowing=bdSavedNarrowingFromRow(row);
      if(row.card_id!=null && bdCardLink && bdCardLinkWrap){
        bd.cardId=row.card_id;
        bdCardLink.textContent='${tJs("botboard.bdCardLinkPrefix", lang)}'+row.card_id;
        bdCardLink.href='/dashboard/bot-board#card='+encodeURIComponent(row.card_id);
        bdCardLinkWrap.style.display='';
        bdLoadResultGate();
      }
      if(row.control==='interrupted'){
        bdAppendNote('warn','${tJs("botboard.bdInterruptedNote", lang)}');
      }
    }).catch(function(){});
  }

  // ---- ask_user cards: render VERBATIM, echo back UNTOUCHED ----
  // CARRIED CONTRACT (bots-page.mjs renderAskUser, restated): select options
  // are pre-rendered strings matched back by EXACT text — every option is a
  // button carrying that SAME string, both as its label and as the value
  // POST /answer sends. Never parsed, never re-composed.
  function bdAnswerAsk(value,label){
    if(!bd.pendingCard||!bd.sid) return;
    var payload=Object.assign({requestId:bd.pendingCard.requestId},value);
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/answer',payload).then(function(r){
      if(r.ok) bdCollapseAsk(label);
      else crowToast((r.j&&r.j.error)||'${tJs("botboard.bdAnswerFailed", lang)}',{type:'error'});
    }).catch(function(){ crowToast('${tJs("botboard.bdAnswerFailed", lang)}',{type:'error'}); });
  }

  function bdCollapseAsk(label){
    clearEl(bdAskEl);
    var d=document.createElement('div');
    d.className='bb-bd-ask-answered';
    d.textContent='${tJs("botboard.bdAnsweredPrefix", lang)} '+(label==null?'':label);
    bdAskEl.appendChild(d);
    bd.pendingCard=null;
    bdUpdateCycleDisabled();
  }

  function bdRenderAsk(card){
    bd.pendingCard=card;
    bdUpdateCycleDisabled();
    clearEl(bdAskEl);
    if(!card) return;
    var wrap=document.createElement('div');
    wrap.className='bb-bd-ask-card';
    var title=document.createElement('div');
    title.className='bb-bd-ask-title';
    title.textContent=card.title||'';
    wrap.appendChild(title);
    if(card.message){
      var msgEl=document.createElement('div');
      msgEl.className='bb-bd-ask-message';
      msgEl.textContent=card.message;
      wrap.appendChild(msgEl);
    }
    if(card.method==='select'){
      var opts=document.createElement('div'); opts.className='bb-bd-ask-opts';
      (card.options||[]).forEach(function(opt){
        var b=document.createElement('button');
        b.type='button'; b.className='bb-btn bb-sec';
        b.textContent=opt;
        b.onclick=function(){ bdAnswerAsk({value:opt},opt); };
        opts.appendChild(b);
      });
      wrap.appendChild(opts);
    } else if(card.method==='input'){
      var form=document.createElement('form'); form.className='bb-bd-ask-form';
      var inp=document.createElement('input'); inp.type='text'; inp.placeholder=card.placeholder||'';
      var sendBtn=document.createElement('button'); sendBtn.type='submit'; sendBtn.className='bb-btn';
      sendBtn.textContent='${tJs("botboard.bdSend", lang)}';
      form.appendChild(inp); form.appendChild(sendBtn);
      form.onsubmit=function(ev){ ev.preventDefault(); bdAnswerAsk({value:inp.value},inp.value); };
      wrap.appendChild(form);
    } else if(card.method==='confirm'){
      var opts2=document.createElement('div'); opts2.className='bb-bd-ask-opts';
      var yes=document.createElement('button'); yes.type='button'; yes.className='bb-btn';
      yes.textContent='${tJs("botboard.bdConfirmYes", lang)}';
      yes.onclick=function(){ bdAnswerAsk({confirmed:true},yes.textContent); };
      var no=document.createElement('button'); no.type='button'; no.className='bb-btn bb-sec';
      no.textContent='${tJs("botboard.bdConfirmNo", lang)}';
      no.onclick=function(){ bdAnswerAsk({confirmed:false},no.textContent); };
      opts2.appendChild(yes); opts2.appendChild(no);
      wrap.appendChild(opts2);
    } else if(card.method==='editor'){
      var form2=document.createElement('form'); form2.className='bb-bd-ask-form';
      var ta=document.createElement('textarea'); ta.rows=4; ta.value=card.prefill||'';
      var sendBtn2=document.createElement('button'); sendBtn2.type='submit'; sendBtn2.className='bb-btn';
      sendBtn2.textContent='${tJs("botboard.bdSend", lang)}';
      form2.appendChild(ta); form2.appendChild(sendBtn2);
      form2.onsubmit=function(ev){ ev.preventDefault(); bdAnswerAsk({value:ta.value},ta.value); };
      wrap.appendChild(form2);
    }
    var cancelBtn=document.createElement('button');
    cancelBtn.type='button'; cancelBtn.className='bb-btn bb-sec';
    cancelBtn.textContent='${tJs("botboard.bdAskCancel", lang)}';
    cancelBtn.onclick=function(){ bdAnswerAsk({cancelled:true},cancelBtn.textContent); };
    wrap.appendChild(cancelBtn);
    bdAskEl.appendChild(wrap);
  }

  // ---- SSE: parse BY EVENT NAME, never onmessage ----
  function bdOpenSse(){
    if(!window.EventSource || !bd.sid) return;
    var mySid=bd.sid;
    var es;
    try{ es=new EventSource('/dashboard/perch-api/interactive/'+encodeURIComponent(bd.sid)+'/events'); }
    catch(e){ bdAppendNote('err','${tJs("botboard.bdReconnectFailed", lang)}'); return; }
    bd.es=es;
    function parsed(e){ try{ return JSON.parse(e.data); }catch(err){ return {}; } }
    es.addEventListener('state',function(e){
      if(bd.sid!==mySid) return;
      var d=parsed(e);
      bd.esRetries=0;
      var learning=!bd.botId && d.botId;
      if(d.botId) bd.botId=String(d.botId);
      if(d.threadId) bd.threadId=String(d.threadId);
      if(learning){ bdUpdateHeader(); bdLoadTranscript(); bdLoadSessionMeta(); }
      bdSetState(d.state);
      // I3 (final review): the engine now reports whether a turn is
      // actually in flight — consume it here instead of relying only on the
      // SENDING tab's own optimistic bdSetTurnInFlight(true). Without this,
      // a reopened drawer / second tab / reconnect mid-turn (the PRIMARY
      // dispatch flow: Send-out fires turn 1, the operator opens the drawer
      // AFTER) never learns a turn is running until 'reply'/'stopped'.
      // I3 (final review): the engine now reports whether a turn is
      // actually in flight — consume it here instead of relying only on the
      // SENDING tab's own optimistic bdSetTurnInFlight(true). Without this,
      // a reopened drawer / second tab / reconnect mid-turn (the PRIMARY
      // dispatch flow: Send-out fires turn 1, the operator opens the drawer
      // AFTER) never learns a turn is running until 'reply'/'stopped'.
      bdSetTurnInFlight(d.state==='stopped' ? false : !!d.turnInFlight);
      // I2 (final review): bdResetControlsUi() hard-sets the permission
      // select to 'guarded' on every mount, which is the correct fail-safe
      // for a BRAND NEW session — but a reopened drawer, second tab, or
      // reconnect must reflect the session's REAL live mode (e.g. 'bypass'),
      // not silently relabel it 'guarded' while it keeps running unguarded.
      if(bdPermSel && d.permissionMode!=null) bdPermSel.value=d.permissionMode;
      if(bdPlanToggle) bdPlanToggle.checked=!!d.planMode;
      bdRenderAsk(d.pendingUi||null);
    });
    es.addEventListener('text',function(e){
      if(bd.sid!==mySid) return;
      bd.turnHadText=true;
      bdAppendMessage('bot','bot',parsed(e).text||'');
    });
    es.addEventListener('tool',function(e){
      if(bd.sid!==mySid) return;
      var d=parsed(e);
      bdAppendNote('',(d.name||'tool')+' '+(d.phase||'')+(d.isError?' (error)':''));
    });
    es.addEventListener('log',function(e){
      if(bd.sid!==mySid) return;
      bdAppendNote('',parsed(e).text||'');
    });
    es.addEventListener('reply',function(e){
      if(bd.sid!==mySid) return;
      if(!bd.turnHadText) bdAppendMessage('bot','bot',parsed(e).text||'');
      bd.turnHadText=false;
      bdSetTurnInFlight(false);
    });
    es.addEventListener('ask_user',function(e){
      if(bd.sid!==mySid) return;
      bdRenderAsk(parsed(e));
    });
    es.addEventListener('plan_state',function(e){
      if(bd.sid!==mySid) return;
      bdAppendNote('',(parsed(e).state||''));
    });
    es.addEventListener('error',function(e){
      if(bd.sid!==mySid) return;
      if(e&&e.data) bdAppendNote('err',parsed(e).text||'error');
    });
    // Reconnect: close + reopen with a bounded 2s backoff, capped at 5
    // attempts — the subscribe replay on reopen restores state + any pending
    // ask card, so no client-side state needs to be rebuilt by hand.
    es.onerror=function(){
      if(bd.sid!==mySid) return;
      bdCloseStream();
      bd.es=null;
      if(bd.esRetries>=5){
        bdAppendNote('err','${tJs("botboard.bdReconnectFailed", lang)}');
        return;
      }
      bd.esRetries++;
      bdAppendNote('','${tJs("botboard.bdReconnecting", lang)}');
      bd.esTimer=setTimeout(function(){
        if(bd.sid!==mySid) return;
        bdOpenSse();
      },2000);
    };
  }

  // ---- composer: message while idle, steer while a turn is in flight ----
  function bdSend(){
    if(!bdInputEl) return;
    var text=(bdInputEl.value||'').trim();
    if(!text||!bd.sid) return;
    bdInputEl.value='';
    bdAppendMessage('user','you',text);
    if(bd.turnInFlight){
      perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/steer',{message:text}).then(function(r){
        if(!r.ok){
          if(r.status===409&&r.j&&r.j.error==='no_turn') bdAppendNote('warn','${tJs("botboard.bdNoTurn", lang)}');
          else crowToast((r.j&&r.j.error)||'${tJs("botboard.bdSendFailed", lang)}',{type:'error'});
        }
      }).catch(function(){ crowToast('${tJs("botboard.bdSendFailed", lang)}',{type:'error'}); });
      return;
    }
    bd.turnHadText=false;
    bdSetTurnInFlight(true);
    // Track 3 Task 14: any images attached via the files row queue onto THIS
    // send only — cleared here regardless of outcome (a failed turn still
    // consumes the queue; re-attaching is one click away, same discipline the
    // textarea itself already applies by clearing before the request fires).
    var body={message:text};
    if(bd.uploads.length){
      body.images=bd.uploads.map(function(u){ return {mime:u.mime,data_b64:u.data_b64}; });
    }
    bd.uploads=[];
    bdRenderFilesQueue();
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/message',body).then(function(r){
      if(!r.ok){
        bdSetTurnInFlight(false);
        bdAppendNote('err',(r.j&&r.j.error)||'${tJs("botboard.bdSendFailed", lang)}');
      }
    }).catch(function(){
      bdSetTurnInFlight(false);
      bdAppendNote('err','${tJs("botboard.bdSendFailed", lang)}');
    });
  }
  if(bdSendBtn) bdSendBtn.onclick=bdSend;
  if(bdInputEl) bdInputEl.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'&&(ev.metaKey||ev.ctrlKey)){ ev.preventDefault(); bdSend(); }
  });
  if(bdAbortBtn) bdAbortBtn.onclick=function(){
    if(!bd.sid) return;
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/abort').then(function(r){
      if(!r.ok) crowToast((r.j&&r.j.error)||'${tJs("botboard.bdAbortFailed", lang)}',{type:'error'});
    }).catch(function(){ crowToast('${tJs("botboard.bdAbortFailed", lang)}',{type:'error'}); });
  };
  if(bdStopBtn) bdStopBtn.onclick=function(){
    if(!bd.sid||!confirm('${tJs("botboard.bdConfirmStop", lang)}')) return;
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/stop').then(function(r){
      if(!r.ok) crowToast((r.j&&r.j.error)||'${tJs("botboard.bdStopFailed", lang)}',{type:'error'});
    }).catch(function(){ crowToast('${tJs("botboard.bdStopFailed", lang)}',{type:'error'}); });
  };

  // ---- "pick a session" mode: a bot-level open with no live sid ----
  function bdLoadPicker(){
    if(!bdPickerEl) return;
    clearEl(bdPickerEl);
    perchApi('GET','/bots/'+encodeURIComponent(bd.botId)+'/sessions').then(function(r){
      clearEl(bdPickerEl);
      if(!r.ok||!r.j||!r.j.sessions){
        var e=document.createElement('div'); e.className='bb-msg err'; e.textContent='${tJs("botboard.bdSessionsLoadFailed", lang)}';
        bdPickerEl.appendChild(e);
        return;
      }
      var rows=r.j.sessions.filter(function(s){ return s.kind==='perch-live'; });
      if(!rows.length){
        var n=document.createElement('div'); n.className='bb-msg'; n.textContent='${tJs("botboard.bdNoSessions", lang)}';
        bdPickerEl.appendChild(n);
        return;
      }
      rows.forEach(function(row){
        var item=document.createElement('div'); item.className='bb-bd-picker-row';
        var label=document.createElement('span');
        label.textContent=(row.state||row.status||'')+(row.card_id!=null?' \\u2014 #'+row.card_id:'')+' \\u2014 '+(row.updated_at||'');
        var openBtn=document.createElement('button');
        openBtn.type='button'; openBtn.className='bb-btn bb-sec';
        openBtn.textContent='${tJs("botboard.roostActionOpen", lang)}';
        var sid=String(row.gateway_thread_id), botId=bd.botId, botName=bd.botName;
        openBtn.onclick=function(){ bdOpenSession(sid,botId,botName); };
        item.appendChild(label); item.appendChild(openBtn);
        bdPickerEl.appendChild(item);
      });
    }).catch(function(){
      clearEl(bdPickerEl);
      var e=document.createElement('div'); e.className='bb-msg err'; e.textContent='${tJs("botboard.bdSessionsLoadFailed", lang)}';
      bdPickerEl.appendChild(e);
    });
  }

  // Track 3 Task 14: every new surface (controls row, bindsAtWake affordance,
  // envelope pane, files queue, result gate) starts each drawer mount from
  // the SAME blank slate — called from both entry points below, right after
  // bdReset() clears the session-scoped bd object those surfaces read.
  function bdResetControlsUi(){
    bdSetOptionsDisabled();
    if(bdPermSel) bdPermSel.value='guarded';
    if(bdPlanToggle) bdPlanToggle.checked=false;
    if(bdBindsAtWakeEl) bdBindsAtWakeEl.style.display='none';
    if(bdControlsPaneEl){ clearEl(bdControlsPaneEl); bdControlsPaneEl.style.display='none'; }
    if(bdControlsToggle) bdControlsToggle.setAttribute('aria-expanded','false');
    if(bdResultEl) clearEl(bdResultEl);
    bd.uploads=[];
    bdRenderFilesQueue();
    bdUpdateCycleDisabled();
  }

  function bdShowPicker(botId,botName){
    bdReset();
    bdResetControlsUi();
    bd.botId=botId||null;
    bd.botName=botName||null;
    bdUpdateHeader();
    bdSetState(null);
    clearEl(bdTranscriptEl);
    clearEl(bdAskEl);
    if(bdCardLinkWrap) bdCardLinkWrap.style.display='none';
    bdSetComposerVisible(false);
    if(bdPickerEl) bdPickerEl.style.display='';
    bdLoadPicker();
  }

  // ---- the main entry: mount ONE session into the drawer ----
  function bdOpenSession(sid,botId,botName){
    bdReset();
    bdResetControlsUi();
    bd.sid=String(sid);
    bd.threadId=bd.sid;
    bd.botId=botId||null;
    bd.botName=botName||null;
    if(bdPickerEl) bdPickerEl.style.display='none';
    bdSetComposerVisible(true);
    clearEl(bdTranscriptEl);
    clearEl(bdAskEl);
    bdSetState(null);
    bdSetTurnInFlight(false);
    if(bdCardLinkWrap) bdCardLinkWrap.style.display='none';
    bdUpdateHeader();
    bdSetHashKey('bird',bd.sid);
    if(bd.botId){ bdLoadTranscript(); bdLoadSessionMeta(); }
    bdOpenSse();
  }

  function openBirdDrawer(sessionId,botId,botName){
    if(!bdEl) return;
    openDrawer(bdEl);
    bdEl.setAttribute('aria-hidden','false');
    if(bdBackdrop){ bdBackdrop.classList.add('bb-open'); bdBackdrop.setAttribute('aria-hidden','false'); }
    if(sessionId){ bdOpenSession(sessionId,botId,botName); }
    else if(botId){ bdShowPicker(botId,botName); }
  }

  function closeBirdDrawer(){
    closeDrawer(bdEl);
    if(bdEl) bdEl.setAttribute('aria-hidden','true');
    if(bdBackdrop){ bdBackdrop.classList.remove('bb-open'); bdBackdrop.setAttribute('aria-hidden','true'); }
    bdReset();
    bdSetHashKey('bird',null);
  }

  /** #card=<id> focus branch: scroll the card into view, and if a live bird
   * glyph sits on it, open the drawer for that session too. */
  function bdFocusCard(cardId){
    var card=document.querySelector('.bb-card[data-card="'+cardId+'"]');
    if(!card) return;
    if(card.scrollIntoView) card.scrollIntoView({block:'center'});
    card.classList.add('bb-card-focus');
    setTimeout(function(){ card.classList.remove('bb-card-focus'); },2000);
    var glyph=card.querySelector('.bb-bird[data-bird-sid]');
    if(glyph){
      var sid=glyph.getAttribute('data-bird-sid');
      if(sid) openBirdDrawer(sid);
    }
  }

  // Track 3 Task 14: attach-to-card reuses the roost strip's OWN dispatch
  // dialog/card-picker (client.js's openRoostAttachCard — function
  // declarations hoist across this whole shared IIFE, so referencing it here
  // even though it is defined further down in client.js is safe: by the time
  // this handler can actually FIRE, the entire script has already run once).
  if(bdAttachCardBtn) bdAttachCardBtn.onclick=function(){
    if(!bd.sid) return;
    openRoostAttachCard(bd.sid);
  };

  if($('bb-bd-close')) $('bb-bd-close').onclick=closeBirdDrawer;
  if(bdBackdrop) bdBackdrop.onclick=closeBirdDrawer;
  document.addEventListener('keydown',function(ev){
    if(ev.key==='Escape' && bdEl && bdEl.classList.contains('bb-open')) closeBirdDrawer();
  });
  if(bdMenuToggle) bdMenuToggle.onclick=function(ev){
    ev.stopPropagation();
    var open=bdMenu&&bdMenu.classList.contains('bb-open');
    if(bdMenu){ bdMenu.classList.toggle('bb-open',!open); bdMenu.setAttribute('aria-hidden',open?'true':'false'); }
    bdMenuToggle.setAttribute('aria-expanded',open?'false':'true');
  };
  document.addEventListener('click',function(ev){
    if(bdMenu && bdMenu.classList.contains('bb-open') && !(ev.target.closest && ev.target.closest('.bb-bd-menu-wrap'))){
      bdMenu.classList.remove('bb-open');
      bdMenu.setAttribute('aria-hidden','true');
      if(bdMenuToggle) bdMenuToggle.setAttribute('aria-expanded','false');
    }
  });
  `;
}
