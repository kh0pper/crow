import { tJs } from "../shared/i18n.js";

/** The hub's client script. Emitted INSIDE a template literal — a bare
 *  backtick or ${ anywhere in here breaks the module at import time.
 *  tJs escapes \, ', ` and ${, so translations interpolate safely into
 *  single-quoted client strings. */
export function perchHubJs(lang = "en") {
  return `(function(){
  "use strict";
  var body=document.body;
  function setView(v){ body.setAttribute('data-view',v); }

  /* Tiny DOM helpers used throughout. Defined HERE, in the first task that
     emits a script, so no later task references something undefined. */
  function el(id){ return document.getElementById(id); }
  function clearEl(node){ while(node&&node.firstChild) node.removeChild(node.firstChild); }
  /* textContent only, never innerHTML — see Global Constraints. */
  function line(cls,text){ var d=document.createElement('div');
    if(cls) d.className=cls; d.textContent=text==null?'':String(text); return d; }

  /* The two transcript writers. Defined HERE because the error and
     empty-transcript paths call them, and those are the FIRST paths a user
     hits when something goes wrong — a ReferenceError there is invisible to a
     parse test (new Function binds at call time) and fatal at runtime. */
  function appendNote(text){
    var tr=el('perch-transcript'); if(!tr) return;
    tr.appendChild(line('entry note',text));
    tr.scrollTop=tr.scrollHeight;
  }
  function appendMessage(cls,who,text){
    var tr=el('perch-transcript'); if(!tr) return;
    var row=document.createElement('div'); row.className='entry '+cls;
    row.appendChild(line('who',who));
    row.appendChild(line('what',text));      /* textContent, never innerHTML */
    tr.appendChild(row);
    tr.scrollTop=tr.scrollHeight;
  }

  var API='/dashboard/perch-api';
  /* The hub is a STANDALONE document, so it does NOT get shared/layout.js's
     global fetch/XHR patch (layout.js:401-465) that attaches X-Crow-Csrf for
     every dashboard page. That is why the board's own perchApi sends no header
     and this one must. Do not "simplify" by copying the board's version: every
     POST would 403. */
  function csrf(){ var m=document.cookie.match(/(?:^|; )crow_csrf=([^;]*)/); return m?decodeURIComponent(m[1]):''; }
  function perchApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch(API+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    });
  }

  /* One row per live session, plus one per attached bot with none. A bot with
     no perch gateway record is omitted: POST /bots/<id>/interactive 403s. */
  function listRows(roost){
    var birds=(roost&&roost.birds)||[];
    var out=[];
    birds.forEach(function(b){
      if(!b||!b.perch_attached) return;
      var ss=b.sessions||[];
      if(!ss.length){ out.push({botId:b.id,botName:b.name,sessionId:null,state:'idle',cardId:null,pendingUi:false}); return; }
      var live=ss.filter(function(x){ return x&&x.state!=='stopped'; });
      if(!live.length){ out.push({botId:b.id,botName:b.name,sessionId:null,state:'idle',cardId:null,pendingUi:false}); return; }
      live.forEach(function(s){
        out.push({botId:b.id,botName:b.name,sessionId:s.sessionId,state:s.state,
                  cardId:s.cardId==null?null:s.cardId,pendingUi:!!s.pendingUi});
      });
    });
    /* Blocked-on-you first: those are the only rows that need you right now. */
    out.sort(function(a,b){
      if(!!b.pendingUi!==!!a.pendingUi) return b.pendingUi?1:-1;
      if(!!b.sessionId!==!!a.sessionId) return b.sessionId?1:-1;
      return String(a.botName).localeCompare(String(b.botName));
    });
    return out;
  }

  /* tJs escapes \\, ', \` and \${, so these interpolate safely. */
  var NO_SESSIONS='${tJs("perch.noSessions", lang)}';
  var WAITING_ON_YOU='${tJs("perch.waitingOnYou", lang)}';
  var OPEN_LABEL='${tJs("perch.open", lang)}';
  var TALK_LABEL='${tJs("perch.talk", lang)}';
  var START_FAILED='${tJs("perch.startFailed", lang)}';
  var NOT_ATTACHED='${tJs("perch.notAttached", lang)}';
  var ENGINE_REQUIRED='${tJs("perch.engineRequired", lang)}';

  var pendingNote=null;                 /* survives the loadList that follows a note */
  function showListNote(text){
    var body=el('perch-list-body'); clearEl(body); body.appendChild(line('empty',text));
  }
  /* renderList() ends with this, so a parked note survives the re-render that
     would otherwise erase it. */
  function flushPendingNote(){
    if(!pendingNote) return;
    el('perch-list-body').insertBefore(line('empty',pendingNote), el('perch-list-body').firstChild);
    pendingNote=null;
  }

  var rowIndex={};                    /* sessionId -> row, for a warm openSession */

  function renderList(rows){
    var body=el('perch-list-body'); if(!body) return;
    clearEl(body); rowIndex={};
    if(!rows.length){ body.appendChild(line('empty',NO_SESSIONS)); flushPendingNote(); return; }
    rows.forEach(function(r){
      var row=document.createElement('div'); row.className='roost-row';
      row.appendChild(line('roost-dot',''));
      var main=document.createElement('div'); main.className='roost-main';
      main.appendChild(line('roost-cwd',r.botName));
      main.appendChild(line('roost-when',r.pendingUi?WAITING_ON_YOU:r.state));
      row.appendChild(main);
      var b=document.createElement('button');
      b.type='button'; b.textContent=r.sessionId?OPEN_LABEL:TALK_LABEL;
      b.onclick=r.sessionId
        ? function(){ rowIndex[r.sessionId]=r; location.hash=r.sessionId; }
        : function(){ startSession(r.botId,r.botName); };
      row.appendChild(b);
      if(r.sessionId) rowIndex[r.sessionId]=r;
      body.appendChild(row);
    });
    flushPendingNote();               /* a parked note must survive this render */
  }

  /* A bot with no session: spawn, then let the hash router open it, so history
     stays correct and the cold-deep-link path is the same code. */
  function startSession(botId,botName){
    perchApi('POST','/bots/'+encodeURIComponent(botId)+'/interactive').then(function(r){
      if(r.status===409){ showListNote(ENGINE_REQUIRED); return; }
      if(r.status===403){ showListNote(NOT_ATTACHED); return; }
      if(!r.ok||!r.j||!r.j.sessionId){ showListNote(START_FAILED); return; }
      rowIndex[r.j.sessionId]={botId:botId,botName:botName,sessionId:r.j.sessionId};
      location.hash=r.j.sessionId;
    });
  }

  var listTimer=null;
  function loadList(){
    return perchApi('GET','/roost').then(function(r){
      if(r.ok&&r.j) renderList(listRows(r.j));
      else renderList([]);
    });
  }
  /* Poll only while the list is showing. In the chat view the SSE stream is
     already the live signal, so polling there is pure waste. */
  function startListPolling(){ stopListPolling(); listTimer=setInterval(loadList,10000); }
  function stopListPolling(){ if(listTimer){ clearInterval(listTimer); listTimer=null; } }
  window.addEventListener('focus',function(){ if(body.getAttribute('data-view')==='list') loadList(); });

  setView('list');
})();`;
}
