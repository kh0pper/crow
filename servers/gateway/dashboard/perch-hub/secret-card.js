import { tJs } from "../shared/i18n.js";

/**
 * The credential card in a Perch chat (R1.2 spec §10.1, §10.2; plan Task 3).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's el / line /
 * clearEl / perchApi / bindOnce / live / current. Kept in its own module (the phone-card.js
 * pattern) so client.js only carries one-line hooks.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the client code;
 *    only the tJs interpolations below.
 *  - The card comes from the engine's `secret_request` frame ({ id, label, state }, never a
 *    value) and, on load, from GET /interactive/:sid/secret. The label is the bot's text: it is
 *    written with textContent only, and the card says which bot asked for it.
 *  - The typed password (the connect sheet's rules, project-services/client.js): an
 *    input type=password with autocomplete=new-password, no name and no value attribute. Its
 *    value goes only into the POST body to /dashboard/perch-api/secret/:id; it is never put in a
 *    URL, storage, a data- attribute or the console. The field is emptied and removed when the
 *    value is sent, when the card closes or changes, on a session switch, before Turbo caches
 *    the page, before a Turbo visit and on pagehide.
 */
export function perchSecretCardJs(lang = "en") {
  return `
  /* ---- the credential card (spec 10) -------------------------------------- */
  var SEC_TITLE='${tJs("perch.secretTitle", lang)}';
  var SEC_TITLE_NONE='${tJs("perch.secretTitleNoLabel", lang)}';
  var SEC_ASKS='${tJs("perch.secretAsks", lang)}';
  var SEC_HELP='${tJs("perch.secretHelp", lang)}';
  var SEC_ENTER='${tJs("perch.secretEnter", lang)}';
  var SEC_SAVE='${tJs("perch.secretSave", lang)}';
  var SEC_SAVING='${tJs("perch.secretSaving", lang)}';
  var SEC_NOT_NOW='${tJs("perch.secretNotNow", lang)}';
  var SEC_FIELD='${tJs("perch.secretField", lang)}';
  var SEC_RESULT={
    done:'${tJs("perch.secretSaved", lang)}',
    closed:'${tJs("perch.secretClosed", lang)}',
    expired:'${tJs("perch.secretExpired", lang)}',
    gone:'${tJs("perch.secretGone", lang)}',
    not_set_up:'${tJs("perch.secretNotSetUp", lang)}',
    failed:'${tJs("perch.secretFailed", lang)}'
  };

  var secShown=null;     /* {id,label,state} on screen, or null */
  var secField=null;     /* the live password input, or null */
  var secGen=0;          /* bumped on every session switch: a late answer is dropped */

  function secFill(tpl,map){
    var out=String(tpl);
    for(var k in map) out=out.split('{'+k+'}').join(map[k]==null?'':String(map[k]));
    return out;
  }
  /* Empty the typed value and take the field out of the page. */
  function secWipe(){
    var f=secField; secField=null;
    if(!f) return;
    f.value='';
    if(f.parentNode) f.parentNode.removeChild(f);
  }
  function secPane(){ return el('perch-secret'); }
  function resetSecretCard(){
    secWipe(); secShown=null; secGen++;
    var p=secPane(); if(p) clearEl(p);
  }
  function secBot(){ return current.botName||current.botId||''; }

  function renderSecret(card){
    var pane=secPane(); if(!pane) return;
    secWipe(); clearEl(pane);
    secShown=card&&card.id?{id:String(card.id),label:card.label==null?null:String(card.label),state:card.state||'open'}:null;
    if(!secShown) return;
    var c=secShown;
    var frame=document.createElement('div'); frame.className='ask-card secret-card';
    frame.setAttribute('role','group');
    var title=line('ask-title secret-title',c.label?secFill(SEC_TITLE,{label:c.label}):SEC_TITLE_NONE);
    title.id='perch-secret-title';
    frame.setAttribute('aria-labelledby','perch-secret-title');
    frame.appendChild(title);
    if(c.label){
      var bot=secBot();
      if(bot) frame.appendChild(line('secret-asks',secFill(SEC_ASKS,{bot:bot,label:c.label})));
    }
    if(c.state!=='open'){
      frame.appendChild(line('secret-result',SEC_RESULT[c.state]||SEC_RESULT.gone));
      pane.appendChild(frame);
      return;
    }
    frame.appendChild(line('secret-help',SEC_HELP));
    var controls=document.createElement('div'); controls.className='ask-controls secret-controls';
    var enter=document.createElement('button'); enter.type='button'; enter.className='primary secret-enter'; enter.textContent=SEC_ENTER;
    var notNow=document.createElement('button'); notNow.type='button'; notNow.className='secret-not-now'; notNow.textContent=SEC_NOT_NOW;
    var status=line('secret-status',''); status.setAttribute('aria-live','polite');
    enter.onclick=function(){ secOpenField(c,controls,enter,notNow,status); };
    notNow.onclick=function(){ secCancel(c,notNow); };
    controls.appendChild(enter); controls.appendChild(notNow);
    frame.appendChild(controls);
    frame.appendChild(status);
    pane.appendChild(frame);
    pinTranscript();
  }

  function secOpenField(c,controls,enter,notNow,status){
    if(!secShown||secShown.id!==c.id||secShown.state!=='open') return;
    secWipe();
    var f=document.createElement('input');
    f.type='password';
    f.setAttribute('autocomplete','new-password');
    f.setAttribute('autocapitalize','off');
    f.setAttribute('spellcheck','false');
    f.setAttribute('aria-label',SEC_FIELD);
    f.className='secret-input';
    var save=document.createElement('button'); save.type='button'; save.className='primary secret-save'; save.textContent=SEC_SAVE;
    save.onclick=function(){ secSubmit(c,save,notNow,status); };
    f.onkeydown=function(ev){ if(ev&&ev.key==='Enter'){ ev.preventDefault(); secSubmit(c,save,notNow,status); } };
    secField=f;
    clearEl(controls);
    controls.appendChild(f); controls.appendChild(save); controls.appendChild(notNow);
    f.focus();
  }

  function secPath(c,sid){ return '/secret/'+encodeURIComponent(c.id)+'?sid='+encodeURIComponent(sid); }

  /* The answer's fixed code → the card's result. */
  function secResultFor(r){
    if(r&&r.ok&&r.j&&r.j.ok) return r.j.code==='closed'?'closed':'done';
    if(r&&r.j&&r.j.code==='not_set_up') return 'not_set_up';
    if(r&&r.status===410) return 'expired';
    if(r&&r.status===404) return 'gone';
    return 'failed';
  }

  function secSubmit(c,save,notNow,status){
    var f=secField;
    if(!f||!f.value||!secShown||secShown.id!==c.id) return;
    var mySid=current.sid, myGen=secGen;
    save.disabled=true; notNow.disabled=true; status.textContent=SEC_SAVING;
    var req=perchApi('POST',secPath(c,mySid),{value:f.value});
    secWipe();
    req.then(function(r){
      if(!live()||current.sid!==mySid||secGen!==myGen) return;
      if(!secShown||secShown.id!==c.id) return;
      renderSecret({id:c.id,label:c.label,state:secResultFor(r)});
    });
  }

  function secCancel(c,notNow){
    var mySid=current.sid, myGen=secGen;
    secWipe();
    notNow.disabled=true;
    perchApi('POST',secPath(c,mySid),{cancel:true}).then(function(r){
      if(!live()||current.sid!==mySid||secGen!==myGen) return;
      if(!secShown||secShown.id!==c.id) return;
      var st=secResultFor(r);
      renderSecret({id:c.id,label:c.label,state:st==='done'?'closed':st});
    });
  }

  /* A live frame: an open card is drawn unless it is already on screen (a typed value is never
     wiped by a replay); a settled one replaces this card only. */
  function secretFrame(d){
    if(!d||typeof d.id!=='string') return;
    if(d.state==='open'){
      if(secShown&&secShown.id===d.id) return;
      renderSecret(d);
      return;
    }
    if(secShown&&secShown.id===d.id&&secShown.state==='open') renderSecret(d);
  }

  /* On load: the open card from the gateway (a reload or a second tab). */
  function loadSecret(sid){
    if(!sid) return;
    var mySid=sid, myGen=secGen;
    perchApi('GET','/interactive/'+encodeURIComponent(mySid)+'/secret').then(function(r){
      if(!live()||current.sid!==mySid||secGen!==myGen) return;
      if(!r||!r.ok||!r.j||typeof r.j.id!=='string') return;
      if(secShown&&secShown.id===r.j.id) return;
      renderSecret({id:r.j.id,label:r.j.label,state:'open'});
    });
  }

  /* Never in a Turbo snapshot, never left behind by a visit or a closing page. */
  bindOnce(document,'turbo:before-cache','secretCache',function(){ secWipe(); var p=secPane(); if(p) clearEl(p); secShown=null; });
  bindOnce(document,'turbo:before-visit','secretVisit',function(){ secWipe(); });
  bindOnce(window,'pagehide','secretPagehide',function(){ secWipe(); });
`;
}
