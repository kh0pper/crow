import { tJs } from "../shared/i18n.js";

/**
 * The card offer, the "card made" system note and the card chip in the Perch chat
 * (redesign P5, Task 5.3).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's
 * API / el / line / clearEl / csrf / live / current. Same pattern as artifact-card.js.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the client
 *    code; only the tJs interpolations below.
 *  - Every bot-written string (the offer title, the project name) lands through
 *    textContent on a createElement node. Nothing here ever assigns HTML (C6).
 *  - The offer, the note and the chip are all drawn from server rows (GET offers, GET card).
 *    The lane in the chip comes from the server, never from the client. Deciding an offer
 *    sends nothing to the bot.
 *  - The note is a quiet centered line, not a message: no .msg, no .bubble, no avatar.
 *
 * Task 5.4 adds the review chips, drawn from the same GET card (result, decisions), under the
 * newest bot reply and only while something is open:
 *  - Accept posts the result id the chat SHOWED (409 = stale or decided: redraw from the server).
 *    A failure or partial result asks first (P3's confirm string), then sends accept_failure.
 *  - Ask for a change rejects that same result, then sends the operator's words to the bot as an
 *    ordinary message on this chat's /message (never through the composer). Until that send
 *    succeeds the words stay on screen with Send again, which resends only the message.
 *  - Accept on a card with an open decision is refused (answer_first) and says so.
 *  - A decision's options post #535's /dashboard/bot-board-api/card/:id/decision {index};
 *    Other... opens a field for other_text.
 *  - Not now writes nothing: the chips stay collapsed for this page view until something new
 *    (another result or question) is open.
 */
export function perchCardChipJs(lang = "en") {
  return `
  /* ---- card offer / system note / card chip (redesign P5, Task 5.3) ------ */
  var CC_OFFER_TITLE='${tJs("shell.offerTitle", lang)}';
  var CC_OFFER_MAKE='${tJs("shell.offerMake", lang)}';
  var CC_OFFER_NOT_NOW='${tJs("shell.offerNotNow", lang)}';
  var CC_MADE_NOTE='${tJs("shell.cardMadeNote", lang)}';
  var CC_DETAILS='${tJs("shell.cardDetails", lang)}';
  var CC_FAILED='${tJs("shell.offerFailed", lang)}';
  var CC_ACCEPT='${tJs("shell.accept", lang)}';
  var CC_ASK_CHANGE='${tJs("shell.askChange", lang)}';
  var CC_CHANGE_PH='${tJs("shell.changePlaceholder", lang)}';
  var CC_OTHER='${tJs("shell.other", lang)}';
  var CC_SEND='${tJs("perch.send", lang)}';
  var CC_CONFIRM='${tJs("shell.confirmNotFullSuccess", lang)}';
  var CC_CONFIRM_YES='${tJs("shell.confirmAcceptYes", lang)}';
  var CC_CONFIRM_NO='${tJs("shell.confirmAcceptNo", lang)}';
  var CC_CONFIRM_OUTCOMES=['failure','partial'];
  var CC_REFUSE_DECISION='${tJs("shell.refuseDecision", lang)}';
  var CC_SEND_AGAIN='${tJs("shell.sendAgain", lang)}';
  var CC_LANES={ needs_you:'${tJs("shell.laneNeedsYou", lang)}', working:'${tJs("shell.laneWorking", lang)}',
    up_next:'${tJs("shell.laneUpNext", lang)}', done:'${tJs("shell.laneDone", lang)}' };

  /* offerId -> {node,key} for THIS transcript; dies with it (resetCardChip). */
  var ccOffers={};
  var ccChip=null;
  var ccGen=0;
  var ccPrevState='';
  var ccReview=null;      /* {node,key}: the review chips drawn in THIS transcript */
  var ccDismissed={};     /* sid -> key the operator said Not now to; lives for the page view */
  var ccUnsent={};        /* sid -> {text,cardId,resultId}: change words the bot has not received yet */
  var CC_UNSENT_PREFIX='perch-unsent-change:';
  /* A failed change send is also kept in sessionStorage, so a real reload still offers Send again
     (the rejection already landed). Every storage call is wrapped, as perch drafts are. */
  function ccStore(){ try{ return window.sessionStorage||null; }catch(e){ return null; } }
  function ccUnsentSave(sid){
    var st=ccStore(), u=ccUnsent[sid]; if(!st||!u) return;
    try{ st.setItem(CC_UNSENT_PREFIX+sid,JSON.stringify({text:String(u.text),cardId:u.cardId,resultId:u.resultId})); }catch(e){}
  }
  /* Pending BEFORE request-change is posted (not yet owed: kept only in storage), so a reload
     mid-flight restores the words with Send again. */
  function ccPendingSave(sid,u){
    var st=ccStore(); if(!st) return;
    try{ st.setItem(CC_UNSENT_PREFIX+sid,JSON.stringify({text:String(u.text),cardId:u.cardId,resultId:u.resultId})); }catch(e){}
  }
  var ccRetained=null;    /* {sid,text}: words a refused request-change gives back to the field */
  function ccUnsentDrop(sid){ var st=ccStore(); if(!st) return; try{ st.removeItem(CC_UNSENT_PREFIX+sid); }catch(e){} }
  function ccUnsentLoad(sid){
    if(ccUnsent[sid]!=null) return;
    var st=ccStore(); if(!st) return;
    var raw=null; try{ raw=st.getItem(CC_UNSENT_PREFIX+sid); }catch(e){ raw=null; }
    if(!raw) return;
    var u=null; try{ u=JSON.parse(raw); }catch(e){ u=null; }
    if(u&&typeof u.text==='string'&&u.text.trim()) ccUnsent[sid]={text:u.text,cardId:u.cardId,resultId:u.resultId};
  }

  function resetCardChip(){ ccOffers={}; ccChip=null; ccReview=null; ccGen++; ccPrevState=''; }

  function ccFill(s,vals){
    var out=String(s);
    Object.keys(vals).forEach(function(k){ out=out.split('{'+k+'}').join(String(vals[k])); });
    return out;
  }
  function ccApi(method,path,body){ return ccFetch(method,API+path,body); }
  function ccFetch(method,url,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch(url,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }
  /* First descendant (or the node itself) carrying any of these classes. */
  function ccFind(node,classes){
    if(!node) return null;
    var have=String(node.className||'').split(/\\s+/);
    for(var i=0;i<classes.length;i++) if(have.indexOf(classes[i])>=0) return node;
    var kids=node.children||[];
    for(var k=0;k<kids.length;k++){ var f=ccFind(kids[k],classes); if(f) return f; }
    return null;
  }
  function ccDrop(node){ if(node&&node.parentNode) node.parentNode.removeChild(node); }
  function ccPlace(tr,old,fresh){
    if(old&&old.parentNode){ old.parentNode.insertBefore(fresh,old); old.parentNode.removeChild(old); }
    else tr.appendChild(fresh);
  }

  /* The pending offer: a card with the title, the board it would land on and two buttons. */
  function ccOfferCard(o,sid){
    var card=document.createElement('div'); card.className='artcard perch-offer';
    card.appendChild(line('art-eyebrow',CC_OFFER_TITLE));
    card.appendChild(line('art-title',String(o.title||'')));
    if(o.projectName) card.appendChild(line('art-meta',String(o.projectName)));
    var acts=document.createElement('div'); acts.className='art-actions';
    var make=document.createElement('button'); make.type='button'; make.className='offer-make'; make.textContent=CC_OFFER_MAKE;
    var no=document.createElement('button'); no.type='button'; no.className='offer-no'; no.textContent=CC_OFFER_NOT_NOW;
    var msg=line('offer-msg','');
    function decide(accept){
      if(make.disabled) return;
      make.disabled=true; no.disabled=true; msg.textContent='';
      var gen=ccGen;
      ccApi('POST','/offers/'+encodeURIComponent(String(o.id))+'/decide',{accept:accept}).then(function(r){
        if(!live()||current.sid!==sid||gen!==ccGen) return;
        if(r.ok||r.status===409){ loadCardOffers(sid); if(r.ok&&accept) loadCardChip(sid); return; }
        make.disabled=false; no.disabled=false; msg.textContent=CC_FAILED;
      });
    }
    make.onclick=function(){ decide(true); };
    no.onclick=function(){ decide(false); };
    acts.appendChild(make); acts.appendChild(no);
    card.appendChild(acts); card.appendChild(msg);
    return card;
  }

  /* The accepted offer, as a quiet centered line (never a message). */
  function ccNote(o){
    var n=document.createElement('div'); n.className='perch-sysnote';
    n.appendChild(line('sysnote-text',ccFill(CC_MADE_NOTE,{n:o.cardId,project:o.projectName==null?('#'+String(o.projectId)):o.projectName})));
    n.appendChild(line('sysnote-title',String(o.title||'')));
    return n;
  }

  function ccOfferKey(o){ return [o.status,o.title,o.cardId,o.projectId,o.projectName].join('|'); }

  function drawCardOffers(offers,sid){
    var tr=el('perch-transcript'); if(!tr) return;
    var rows=(Array.isArray(offers)?offers:[]).slice().reverse();   /* oldest first */
    var seen={};
    rows.forEach(function(o){
      if(!o||typeof o.id!=='number') return;
      var want=null;
      if(o.status==='pending') want='offer';
      else if(o.status==='accepted'&&o.cardId!=null) want='note';
      var rec=ccOffers[o.id];
      if(!want){ if(rec){ ccDrop(rec.node); delete ccOffers[o.id]; } return; }
      seen[o.id]=true;
      var key=ccOfferKey(o);
      if(rec&&rec.key===key) return;
      var node=want==='offer'?ccOfferCard(o,sid):ccNote(o);
      ccPlace(tr,rec&&rec.node,node);
      ccOffers[o.id]={node:node,key:key};
    });
    Object.keys(ccOffers).forEach(function(id){ if(!seen[id]){ ccDrop(ccOffers[id].node); delete ccOffers[id]; } });
  }

  function loadCardOffers(sid){
    if(!sid) return;
    var gen=ccGen;
    ccApi('GET','/interactive/'+encodeURIComponent(sid)+'/offers').then(function(r){
      if(!live()||current.sid!==sid||gen!==ccGen) return;
      if(!r.ok||!r.j) return;
      drawCardOffers(r.j.offers,sid);
    });
  }

  /* The chip: one per chat, the card this chat is linked to. The lane is the server's. */
  function drawCardChip(c){
    var tr=el('perch-transcript'); if(!tr) return;
    if(!c||!Number.isInteger(c.id)){ ccDrop(ccChip); ccChip=null; return; }
    var lane=CC_LANES[c.lane]||'';
    var wrap=document.createElement('div'); wrap.className='perch-cardchip';
    var a=document.createElement('a'); a.className='cardchip-link';
    a.href='/dashboard/board'+(c.projectId==null?'':'?project='+encodeURIComponent(String(c.projectId)))+'#card-'+String(c.id);
    a.appendChild(line('cardchip-ref','\\u21b3 #'+String(c.id)));
    a.appendChild(line('cardchip-title',String(c.title||'')));
    if(lane) a.appendChild(line('cardchip-lane',lane));
    var d=document.createElement('a'); d.className='cardchip-details';
    /* Mirrors panels/board/html.js detailsHref: the classic board resolves a card only on its bot's board. */
    d.href=c.botId?'/dashboard/bot-board?bot='+encodeURIComponent(String(c.botId))+'#open='+encodeURIComponent(String(c.id)):'/dashboard/bot-board?card='+encodeURIComponent(String(c.id));
    d.textContent=CC_DETAILS;
    wrap.appendChild(a); wrap.appendChild(d);
    ccPlace(tr,ccChip,wrap);
    ccChip=wrap;
  }

  function loadCardChip(sid){
    if(!sid) return;
    var gen=ccGen;
    ccApi('GET','/interactive/'+encodeURIComponent(sid)+'/card').then(function(r){
      if(!live()||current.sid!==sid||gen!==ccGen) return;
      if(!r.ok||!r.j) return;
      drawCardChip(r.j.card);
      drawReview(r.j,sid);
    });
  }

  /* ---- review chips: Accept / Ask for a change / a bot's questions (Task 5.4) ---- */
  function ccButton(cls,text,fn){
    var b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=text;
    b.onclick=fn; return b;
  }
  function ccReviewKey(card,result,decs){
    return JSON.stringify([card?card.id:null,result?result.id:null,decs.map(function(d){ return d.cardId; })]);
  }
  /* The server's answer is the truth: forget what is drawn, so the next draw starts clean. */
  function ccRefresh(sid){ if(ccReview) ccReview.key=''; loadCardChip(sid); }
  /* The operator's own words to the bot (R-P5-8): an ordinary message on this chat's /message,
     sent here and never through the composer, so its draft and pending files are not touched.
     The words stay in ccUnsent until a 2xx; any failure redraws them with Send again, which
     resends only the message (the rejection already landed and is never sent twice). */
  function ccDeliver(sid,btn){
    var u=ccUnsent[sid];
    if(u==null||(btn&&btn.disabled)) return;
    var text=u.text;
    if(btn) btn.disabled=true;
    ccApi('POST','/interactive/'+encodeURIComponent(sid)+'/message',{message:String(text)}).then(function(r){
      if(r.ok){
        if(ccUnsent[sid]===u){ delete ccUnsent[sid]; ccUnsentDrop(sid); }
        if(!live()||current.sid!==sid) return;
        if(typeof appendMessage==='function') appendMessage('user','you',String(text));
        ccRefresh(sid);
        return;
      }
      ccUnsentSave(sid);
      if(!live()||current.sid!==sid) return;
      ccShowUnsent(sid);
    });
  }
  function ccUnsentCard(sid){
    var wrap=document.createElement('div'); wrap.className='perch-review';
    var card=document.createElement('div'); card.className='artcard perch-review-unsent';
    var ta=document.createElement('textarea'); ta.className='review-input'; ta.maxLength=4000;
    ta.setAttribute('placeholder',CC_CHANGE_PH); ta.setAttribute('aria-label',CC_CHANGE_PH);
    ta.value=String(ccUnsent[sid].text);
    ta.oninput=function(){
      var v=String(ta.value||'').trim(), u=ccUnsent[sid];
      if(v&&u){ u.text=v; ccUnsentSave(sid); }
    };
    var acts=document.createElement('div'); acts.className='art-actions';
    var again=ccButton('review-resend',CC_SEND_AGAIN,function(){ ccDeliver(sid,again); });
    acts.appendChild(again);
    card.appendChild(ta); card.appendChild(line('review-msg',CC_FAILED)); card.appendChild(acts);
    wrap.appendChild(card);
    return wrap;
  }
  function ccShowUnsent(sid){
    var tr=el('perch-transcript'); if(!tr||ccUnsent[sid]==null) return;
    var node=ccUnsentCard(sid);
    if(ccReview) ccDrop(ccReview.node);
    tr.appendChild(node);
    ccReview={node:node,key:'unsent'};
  }
  function ccField(ph,label,onSubmit,max){
    var cap=max||4000;
    var box=document.createElement('div'); box.className='review-field'; box.hidden=true;
    var ta=document.createElement('textarea'); ta.className='review-input'; ta.maxLength=cap;
    ta.setAttribute('placeholder',ph); ta.setAttribute('aria-label',ph);
    var go=ccButton('review-send',label,function(){
      var text=String(ta.value||'').trim();
      if(!text||text.length>cap||go.disabled) return;
      onSubmit(text,go);
    });
    box.appendChild(ta); box.appendChild(go);
    box.input=ta;
    return box;
  }

  function ccResultCard(card,result,sid){
    var wrap=document.createElement('div'); wrap.className='artcard perch-review-result';
    wrap.appendChild(line('review-summary',String(result.summaryMd||'')));
    var acts=document.createElement('div'); acts.className='art-actions';
    var msg=line('review-msg','');
    var btns=[];
    function busy(on){ btns.forEach(function(b){ b.disabled=on; }); }
    var confirm=document.createElement('div'); confirm.className='review-confirm'; confirm.hidden=true;
    confirm.appendChild(line('review-confirm-text',CC_CONFIRM));
    var yes=ccButton('review-confirm-yes',CC_CONFIRM_YES,function(){ confirm.hidden=true; accept(true); });
    var no=ccButton('review-confirm-no',CC_CONFIRM_NO,function(){ confirm.hidden=true; busy(false); });
    confirm.appendChild(yes); confirm.appendChild(no);
    function accept(confirmed){
      if(acc.disabled&&!confirmed) return;
      busy(true); msg.textContent='';
      if(!confirmed&&CC_CONFIRM_OUTCOMES.indexOf(String(result.outcome))>=0){ confirm.hidden=false; return; }
      var body={result_id:result.id}; if(confirmed) body.accept_failure=true;
      var gen=ccGen;
      ccApi('POST','/cards/'+encodeURIComponent(String(card.id))+'/accept',body).then(function(r){
        if(!live()||current.sid!==sid||gen!==ccGen) return;
        if(r.status===409&&r.j&&r.j.error==='confirm_failure'&&!confirmed){ confirm.hidden=false; return; }
        if(r.status===409&&r.j&&r.j.error==='answer_first'){ busy(false); msg.textContent=CC_REFUSE_DECISION; return; }
        if(r.ok||r.status===409){ ccRefresh(sid); return; }
        busy(false); msg.textContent=CC_FAILED;
      });
    }
    var acc=ccButton('review-accept',CC_ACCEPT,function(){ accept(false); });
    var field=ccField(CC_CHANGE_PH,CC_ASK_CHANGE,function(text,go){
      busy(true); go.disabled=true; msg.textContent='';
      var gen=ccGen;
      ccPendingSave(sid,{text:text,cardId:card.id,resultId:result.id});
      ccApi('POST','/cards/'+encodeURIComponent(String(card.id))+'/request-change',{result_id:result.id,text:text}).then(function(r){
        /* Rejected: from here the words are owed to the bot, even if the operator left this chat. */
        if(r.ok){ ccUnsent[sid]={text:text,cardId:card.id,resultId:result.id}; if(ccReview&&ccReview.node===wrap.parentNode) ccReview.key='unsent'; ccDeliver(sid); return; }
        /* Not rejected: nothing is owed to the bot, so the stored words go. */
        if(ccUnsent[sid]==null) ccUnsentDrop(sid);
        if(r.status===409){ ccRetained={sid:sid,text:text}; if(live()&&current.sid===sid) ccRefresh(sid); return; }
        if(!live()||current.sid!==sid||gen!==ccGen) return;
        busy(false); go.disabled=false; msg.textContent=CC_FAILED;
      });
    });
    var ask=ccButton('review-change',CC_ASK_CHANGE,function(){
      if(ask.disabled) return;
      field.hidden=!field.hidden;
      if(!field.hidden&&field.input.focus) field.input.focus();
    });
    btns.push(acc,ask);
    acts.appendChild(acc); acts.appendChild(ask);
    wrap.appendChild(acts); wrap.appendChild(confirm); wrap.appendChild(field); wrap.appendChild(msg);
    return wrap;
  }

  function ccDecisionCard(d,sid){
    var wrap=document.createElement('div'); wrap.className='artcard perch-review-decision';
    wrap.appendChild(line('review-question',String(d.question||'')));
    var acts=document.createElement('div'); acts.className='review-options';
    var msg=line('review-msg','');
    var btns=[];
    function busy(on){ btns.forEach(function(b){ b.disabled=on; }); }
    function answer(body,go){
      if(go&&go.disabled) return;
      busy(true); if(go) go.disabled=true; msg.textContent='';
      var gen=ccGen;
      ccFetch('POST','/dashboard/bot-board-api/card/'+encodeURIComponent(String(d.cardId))+'/decision',body).then(function(r){
        if(!live()||current.sid!==sid||gen!==ccGen) return;
        if(r.ok||r.status===409){ ccRefresh(sid); return; }
        busy(false); if(go) go.disabled=false; msg.textContent=CC_FAILED;
      });
    }
    (Array.isArray(d.options)?d.options:[]).forEach(function(o){
      if(!o||!Number.isInteger(o.index)) return;
      var opt=document.createElement('div'); opt.className='review-option';
      var b=ccButton('review-opt'+(o.recommended?' review-opt-rec':''),String(o.label||''),function(){ if(!b.disabled) answer({index:o.index}); });
      btns.push(b);
      opt.appendChild(b);
      if(o.consequence) opt.appendChild(line('review-consequence',String(o.consequence)));
      acts.appendChild(opt);
    });
    var field=ccField(CC_OTHER,CC_SEND,function(text,go){ answer({index:-1,other_text:text},go); },2000);
    var other=ccButton('review-other',CC_OTHER,function(){
      if(other.disabled) return;
      field.hidden=!field.hidden;
      if(!field.hidden&&field.input.focus) field.input.focus();
    });
    btns.push(other);
    acts.appendChild(other);
    wrap.appendChild(acts); wrap.appendChild(field); wrap.appendChild(msg);
    return wrap;
  }

  /* Drawn under the newest bot reply, and only while the server says something is open. */
  function drawReview(j,sid){
    var tr=el('perch-transcript'); if(!tr) return;
    var card=j&&j.card&&Number.isInteger(j.card.id)?j.card:null;
    var result=card&&j.result&&Number.isInteger(j.result.id)?j.result:null;
    var decs=(j&&Array.isArray(j.decisions)?j.decisions:[]).filter(function(d){ return d&&Number.isInteger(d.cardId); });
    /* Words the bot has not received stay on screen, whatever else the server says (R-P5-8). */
    ccUnsentLoad(sid);
    if(ccUnsent[sid]!=null){
      if(ccReview&&ccReview.key==='unsent'&&ccReview.node.parentNode===tr){ ccDrop(ccReview.node); tr.appendChild(ccReview.node); }
      else ccShowUnsent(sid);
      return;
    }
    var key=ccReviewKey(card,result,decs);
    if((!result&&!decs.length)||ccDismissed[sid]===key){ if(ccReview) ccDrop(ccReview.node); ccReview=null; return; }
    if(ccReview&&ccReview.key===key&&ccReview.node.parentNode===tr){
      ccDrop(ccReview.node); tr.appendChild(ccReview.node);   /* keep what was typed; stay last */
      return;
    }
    var box=document.createElement('div'); box.className='perch-review';
    if(result) box.appendChild(ccResultCard(card,result,sid));
    decs.forEach(function(d){ box.appendChild(ccDecisionCard(d,sid)); });
    var notNow=ccButton('review-notnow',CC_OFFER_NOT_NOW,function(){
      ccDismissed[sid]=key;
      ccDrop(box); if(ccReview&&ccReview.node===box) ccReview=null;
    });
    /* Inside the last card's actions row, so it never floats outside the card. */
    var cards=box.children, lastCard=cards[cards.length-1];
    var row=ccFind(lastCard,['art-actions','review-options']);
    (row||box).appendChild(notNow);
    /* A refused change request gives the typed words back, with the refusal line. */
    if(ccRetained&&ccRetained.sid===sid){
      var rf=ccFind(box,['review-field']), rin=ccFind(rf,['review-input']), rm=ccFind(result?box.children[0]:null,['review-msg']);
      if(rin){
        rin.value=ccRetained.text; rf.hidden=false;
        if(rm) rm.textContent=CC_FAILED;
      }
      ccRetained=null;
    }
    if(ccReview) ccDrop(ccReview.node);
    tr.appendChild(box);
    ccReview={node:box,key:key};
  }

  /* A turn ended: the bot may have offered (or the card moved lanes). */
  function cardTurnState(st){
    var prev=ccPrevState; ccPrevState=String(st||'');
    if(prev==='working'&&ccPrevState!=='working'&&current.sid){ loadCardOffers(current.sid); loadCardChip(current.sid); }
  }
`;
}
