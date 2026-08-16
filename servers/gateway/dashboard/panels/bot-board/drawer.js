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

  var BD_STATE_TEXT={
    awake:'${tJs("botboard.bdStateAwake", lang)}',
    hibernating:'${tJs("botboard.roostStateHibernating", lang)}',
    stopped:'${tJs("botboard.bdStateStopped", lang)}'
  };

  function bdBlank(){
    return {sid:null,botId:null,botName:null,threadId:null,cardId:null,
      es:null,esTimer:null,esRetries:0,turnInFlight:false,turnHadText:false,pendingCard:null};
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
  }

  function bdSetState(state){
    bd.state=state;
    if(bdStateEl) bdStateEl.textContent=state?(BD_STATE_TEXT[state]||state):'';
    if(bdHibernatingEl) bdHibernatingEl.style.display=(state==='hibernating')?'':'none';
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
    bodyEl.textContent=text;
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
      if(row.card_id!=null && bdCardLink && bdCardLinkWrap){
        bd.cardId=row.card_id;
        bdCardLink.textContent='${tJs("botboard.bdCardLinkPrefix", lang)}'+row.card_id;
        bdCardLink.href='/dashboard/bot-board#card='+encodeURIComponent(row.card_id);
        bdCardLinkWrap.style.display='';
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
  }

  function bdRenderAsk(card){
    bd.pendingCard=card;
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
      if(d.state==='stopped') bdSetTurnInFlight(false);
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
    perchApi('POST','/interactive/'+encodeURIComponent(bd.sid)+'/message',{message:text}).then(function(r){
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

  function bdShowPicker(botId,botName){
    bdReset();
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
