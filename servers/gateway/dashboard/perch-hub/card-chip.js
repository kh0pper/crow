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
  var CC_LANES={ needs_you:'${tJs("shell.laneNeedsYou", lang)}', working:'${tJs("shell.laneWorking", lang)}',
    up_next:'${tJs("shell.laneUpNext", lang)}', done:'${tJs("shell.laneDone", lang)}' };

  /* offerId -> {node,key} for THIS transcript; dies with it (resetCardChip). */
  var ccOffers={};
  var ccChip=null;
  var ccGen=0;
  var ccPrevState='';

  function resetCardChip(){ ccOffers={}; ccChip=null; ccGen++; ccPrevState=''; }

  function ccFill(s,vals){
    var out=String(s);
    Object.keys(vals).forEach(function(k){ out=out.split('{'+k+'}').join(String(vals[k])); });
    return out;
  }
  function ccApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch(API+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
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
    a.href='/dashboard/board?project='+encodeURIComponent(String(c.projectId))+'#card-'+String(c.id);
    a.appendChild(line('cardchip-ref','\\u21b3 #'+String(c.id)));
    a.appendChild(line('cardchip-title',String(c.title||'')));
    if(lane) a.appendChild(line('cardchip-lane',lane));
    var d=document.createElement('a'); d.className='cardchip-details';
    d.href='/dashboard/bot-board#open='+String(c.id); d.textContent=CC_DETAILS;
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
    });
  }

  /* A turn ended: the bot may have offered (or the card moved lanes). */
  function cardTurnState(st){
    var prev=ccPrevState; ccPrevState=String(st||'');
    if(prev==='working'&&ccPrevState!=='working'&&current.sid){ loadCardOffers(current.sid); loadCardChip(current.sid); }
  }
`;
}
