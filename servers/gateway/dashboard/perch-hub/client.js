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
  /* Builds with textContent/createElement; never assigns innerHTML. */
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

  /* Interpolated at emit time. tJs escapes quotes, backticks and \${, so these
     are safe inside single-quoted literals. */
  var SESSION_GONE='${tJs("perch.sessionGone", lang)}';
  var SEND_FAILED='${tJs("perch.sendFailed", lang)}';
  var FILE_QUEUED='${tJs("perch.fileQueued", lang)}';
  var FILE_FAILED='${tJs("perch.fileFailed", lang)}';
  var ATTACH_FAILED='${tJs("perch.attachFailed", lang)}';
  var NO_TRANSCRIPT='${tJs("perch.noTranscript", lang)}';
  var RECONNECTING='${tJs("perch.reconnecting", lang)}';
  var RECONNECT_FAILED='${tJs("perch.reconnectFailed", lang)}';
  var ASK_STALE='${tJs("perch.askStale", lang)}';
  var STEER_LABEL='${tJs("perch.steer", lang)}';
  var SEND_LABEL='${tJs("perch.send", lang)}';

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

  /* Engine-minted ids only: "perchlive-" + 8 hex (perch-interactive.js:1473).
     A loose pattern would admit ".." and this value is concatenated into an
     API path. Encoded at every use site as well, belt and braces. */
  function parseHash(h){
    var raw=String(h==null?'':h).replace(/^#/,'');
    return /^perchlive-[0-9a-f]{8}$/.test(raw)?{sessionId:raw}:null;
  }

  var current={sid:null};

  function openSession(sid){
    if(current.sid===sid) return;          /* a re-entered hash is a no-op */
    closeStream();
    current.sid=sid;
    var mySid=sid;                          /* identity guard for every await below */
    setView('chat');
    stopListPolling();                      /* SSE is the live signal here */
    clearEl(el('perch-transcript')); clearEl(el('perch-ask'));
    resetControls();                        /* the PREVIOUS session's picker must not bleed in */
    var known=rowIndex[sid];
    if(known){ showHeader(known.botId,known.botName); afterHeader(mySid,known.botId); return; }
    /* A cold deep link does not know the bot; ask /roost rather than guess. */
    perchApi('GET','/roost').then(function(r){
      if(current.sid!==mySid) return;       /* the hash moved on while we waited */
      var hit=r.ok&&r.j?listRows(r.j).filter(function(x){return x.sessionId===mySid;})[0]:null;
      if(!hit){ noteAndReturnToList(SESSION_GONE); return; }
      showHeader(hit.botId,hit.botName); afterHeader(mySid,hit.botId);
    });
  }

  /* Stream FIRST, history second: the stream carries no backlog. */
  function afterHeader(sid,botId){ openStream(sid); loadHistory(botId,sid); loadOptions(sid); }

  function closeSession(){
    closeStream(); current.sid=null;
    setView('list'); startListPolling(); loadList();
  }

  /* A note set before loadList() resolves is wiped by renderList. Park it and
     let renderList re-append it — otherwise "That session is gone." is never
     seen, on exactly the dead-deep-link path it exists for. */
  function noteAndReturnToList(text){ pendingNote=text; location.hash=''; }   /* pendingNote: Task 2 */

  function applyHash(){
    var hit=parseHash(location.hash);
    if(hit) openSession(hit.sessionId); else closeSession();
  }
  window.addEventListener('hashchange',applyHash);

  function planStateText(st){
    if(!st||typeof st!=='object') return typeof st==='string'?st:'';
    if(!st.enabled&&!st.executing) return '';
    var total=Number(st.todosTotal||0), done=Number(st.todosDone||0);
    /* Interpolated at emit time, NOT bound to a script-level constant: the
       test extracts this function in isolation, and a free variable would
       throw ReferenceError before reaching any assertion. tJs escapes quotes,
       backticks and dollar-brace interpolation markers, so this is safe
       inside a single-quoted literal. */
    var head=st.executing?'${tJs("perch.planExecuting", lang)}':'${tJs("perch.planOn", lang)}';
    return total>0?head+' ('+done+'/'+total+')':head;
  }

  /* NOTE the '\\n' below: this whole script lives inside a template literal,
     so a single-backslash escape would become a REAL newline and split the string
     literal across lines. drawer.js:650 writes it the same way. */
  function messageText(message){
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

  /* drawer.js:829, verbatim in effect: mirror the engine, and a stopped
     session is never in flight whatever the frame says. */
  function turnFlagFor(st){ return (st&&st.state==='stopped')?false:!!(st&&st.turnInFlight); }

  function isTerminalStreamStatus(code){ return code===404||code===410||code===401; }

  var stream=null;

  function closeStream(){
    cancelReconnect();                 /* timer only — NOT the retry counter */
    var es=stream; stream=null;        /* null FIRST: idempotent under a double call
                                          from openSession + hashchange */
    if(es){ try{ es.close(); }catch(e){} }
  }

  function openStream(sid){
    closeStream();
    var es=new EventSource(API+'/interactive/'+encodeURIComponent(sid)+'/events');
    stream=es;
    es.onopen=function(){ resetBackoff(); };

    var on=function(type,fn){
      es.addEventListener(type,function(ev){
        if(current.sid!==sid) return;                 /* identity guard, every listener */
        var d={}; try{ d=JSON.parse(ev.data); }catch(e){ d={}; }
        fn(d);
      });
    };
    on('state',function(d){
      setTurnInFlight(turnFlagFor(d));
      el('perch-state').textContent=d.state||'';
      /* Reflects the engine's own record (snapshot()/stateEvent() in
         perch-interactive.js), never the picker back at it — setting
         .value/.checked does not fire change, so this cannot loop. */
      if(d.permissionMode){ var permSel=el('perch-permission'); if(permSel) permSel.value=d.permissionMode; }
      var planCb=el('perch-plan-mode'); if(planCb) planCb.checked=!!d.planMode;
    });
    on('text',function(d){ appendMessage('bot','bot',d.text||''); });
    on('tool',function(d){ if(d.phase==='start') appendNote('['+(d.name||'?')+']'); });
    on('log',function(d){ if(d.text) appendNote(d.text); });
    on('reply',function(d){ appendMessage('bot','bot',d.text||''); setTurnInFlight(false); });
    on('ask_user',function(d){ renderAsk(d); });
    on('error',function(d){ appendNote(d.text||'error'); });
    on('plan_state',function(d){ var t=planStateText(d.state); if(t) appendNote(t); });
    /* No 'attention' listener: attention is not a stream event —
       perch-interactive.js:1243/:1360 push it through pushAttention into the
       notification pipeline, and perch-interactive-api.js:349-351 enumerates
       the stream as state | text | tool | ask_user | log | reply | error plus
       plan_state. A listener for it would never fire. */

    /* openAuthedStream emits a NAMED session-expired event before closing when
       the dashboard session is invalidated (streams/authed-stream.js:50-53).
       Retrying that five times is five requests from a logged-out browser. */
    es.addEventListener('session-expired',function(){
      closeStream();
      location.href='/dashboard/login';
    });

    /* A session that was stopped or reaped while we watched answers 404/410 on
       reconnect. Terminal: say so and go back to the list. */
    function onStreamError(){
      closeStream();
      if(current.sid!==sid) return;
      perchApi('GET','/interactive/'+encodeURIComponent(sid)+'/options').then(function(r){
        if(current.sid!==sid) return;
        if(isTerminalStreamStatus(r.status)){ noteAndReturnToList(SESSION_GONE); return; }
        scheduleReconnect();                  /* bounded 2s backoff, cap 5 */
      });
    }
    es.onerror=onStreamError;
  }

  function showHeader(botId,botName){
    el('perch-bot-name').textContent=botName||botId;
    el('perch-session-meta').textContent=current.sid||'';
  }
  /* Bounded backoff. TWO separate operations, and conflating them is what made
     an earlier draft of this dead code: cancelling the TIMER must not reset the
     COUNTER, because onStreamError calls closeStream() (which cancels) before
     every scheduleReconnect(), so a combined reset meant retries could never
     reach 5 and the cap was unreachable. The counter resets only when a stream
     actually opens. */
  var retries=0, retryTimer=null;
  function cancelReconnect(){ if(retryTimer){ clearTimeout(retryTimer); retryTimer=null; } }
  function resetBackoff(){ retries=0; }            /* called from onopen ONLY */
  function scheduleReconnect(){
    if(retries>=5){ appendNote(RECONNECT_FAILED); return; }
    retries++;
    appendNote(RECONNECTING);
    var mySid=current.sid;                          /* no parameter to get wrong */
    retryTimer=setTimeout(function(){
      if(current.sid!==mySid) return;               /* navigated away mid-backoff */
      openStream(mySid);
    },2000);
  }

  function loadHistory(botId,sid){
    var mySid=sid;
    perchApi('GET','/bots/'+encodeURIComponent(botId)+'/sessions/'+encodeURIComponent(sid)+'/transcript')
      .then(function(r){
        if(current.sid!==mySid) return;            /* identity guard, as everywhere */
        var events=(r.ok&&r.j&&r.j.events)||[];
        if(!events.length){ appendNote(NO_TRANSCRIPT); return; }
        events.filter(function(e){ return e&&e.type==='message'; }).forEach(function(e){
          var m=e.message||{};
          appendMessage(String(m.role||'?')==='user'?'user':'bot', String(m.role||'?'), messageText(m));
        });
      });
  }

  /* Track 3 Task 4: session controls — model, thinking level, permission
     mode, plan mode. Both models and thinkingLevels are null while the
     session hibernates (perch-interactive.js:1877): the engine will not
     wake a child merely to list, so optionsUsable() gates a DISABLED pair
     of selects rather than an empty-but-enabled one. */
  /* "up" is deliberately undecorated: a working choice should read as the
     plain default. The name is on the payload; the drawer read m.label, which
     no provider row sets, and every model listed as provider/id for months. */
  function modelOptionText(m){
    var text=(m&&m.name)||((m&&m.provider)+'/'+(m&&m.id));
    if(m&&m.availability==='on_demand') text+=' \\u2014 ${tJs("perch.modelOnDemand", lang)}';
    else if(m&&m.availability==='unavailable') text+=' \\u2014 ${tJs("perch.modelUnavailable", lang)}';
    return text;
  }

  function optionsUsable(o){
    return !!(o&&Array.isArray(o.models)&&o.models.length
              &&Array.isArray(o.thinkingLevels)&&o.thinkingLevels.length);
  }

  /* Populates #perch-model / #perch-thinking from GET .../options, or
     disables both rather than leaving an empty-but-enabled dropdown — that
     is what made a hibernating session look broken. */
  function renderOptions(o){
    var modelSel=el('perch-model'), thinkSel=el('perch-thinking');
    if(!modelSel||!thinkSel) return;
    clearEl(modelSel); clearEl(thinkSel);
    if(!optionsUsable(o)){ modelSel.disabled=true; thinkSel.disabled=true; return; }
    o.models.forEach(function(m){
      var opt=document.createElement('option');
      opt.value=(m&&m.provider)+'/'+(m&&m.id);
      opt.textContent=modelOptionText(m);
      modelSel.appendChild(opt);
    });
    o.thinkingLevels.forEach(function(lv){
      var opt=document.createElement('option');
      opt.value=lv; opt.textContent=lv;
      thinkSel.appendChild(opt);
    });
    modelSel.disabled=false; thinkSel.disabled=false;
  }

  function loadOptions(sid){
    var mySid=sid;
    perchApi('GET','/interactive/'+encodeURIComponent(sid)+'/options').then(function(r){
      if(current.sid!==mySid) return;               /* identity guard, as everywhere */
      renderOptions(r.ok?r.j:null);
    });
  }

  /* A newly opened session starts with no known options and the default
     permission/plan state, cleared here so the PREVIOUS session's picker
     contents never bleed into this one while loadOptions() is in flight. */
  function resetControls(){
    var modelSel=el('perch-model'), thinkSel=el('perch-thinking');
    if(modelSel){ clearEl(modelSel); modelSel.disabled=true; }
    if(thinkSel){ clearEl(thinkSel); thinkSel.disabled=true; }
    var permSel=el('perch-permission'); if(permSel) permSel.value='guarded';
    var planCb=el('perch-plan-mode'); if(planCb) planCb.checked=false;
  }

  /* routes/perch-interactive-api.js:531-540 reads permission_mode and
     plan_mode in snake_case and SILENTLY DROPS any other key — an operator
     flipping the permission mode gets a 200 and nothing changes. Every other
     body in this file is camelCase JS; these two stay snake_case on purpose. */
  function controlBody(kind,value){
    if(kind==='model'){ var i=value.indexOf('/');
      return {model:{provider:value.slice(0,i),id:value.slice(i+1)}}; }
    if(kind==='thinking') return {thinking:value};
    if(kind==='permission') return {permission_mode:value};   /* snake_case */
    return {plan_mode:!!value};                                /* snake_case */
  }

  function sendControl(kind,value){
    if(!current.sid) return;
    perchApi('POST','/interactive/'+encodeURIComponent(current.sid)+'/control',controlBody(kind,value));
  }
  el('perch-model').onchange=function(){ sendControl('model',this.value); };
  el('perch-thinking').onchange=function(){ sendControl('thinking',this.value); };
  el('perch-permission').onchange=function(){ sendControl('permission',this.value); };
  el('perch-plan-mode').onchange=function(){ sendControl('plan',this.checked); };

  function sendable(text){ return String(text==null?'':text).trim().length>0; }
  function sendPath(sid,inFlight){
    return '/interactive/'+encodeURIComponent(sid)+(inFlight?'/steer':'/message');
  }

  var turnInFlight=false;
  function setTurnInFlight(flag){
    turnInFlight=!!flag;
    el('perch-send').textContent=turnInFlight?STEER_LABEL:SEND_LABEL;
    el('perch-abort').style.display=turnInFlight?'':'none';
  }

  function send(){
    var input=el('perch-input'); if(!input) return;
    var text=input.value;
    if(!sendable(text)||!current.sid) return;
    var mySid=current.sid;
    appendMessage('user','you',text);      /* echo before the round trip */
    input.value='';
    perchApi('POST',sendPath(mySid,turnInFlight),{message:text}).then(function(r){
      if(current.sid!==mySid) return;
      if(r.status===409){ setTurnInFlight(true); return; }   /* raced a turn start */
      if(!r.ok) appendNote((r.j&&r.j.error)||SEND_FAILED);
    });
  }

  /* BOOTSTRAP — the plan shipped without this once and everything looked fine.
     Task 7 navigates with location.href='/dashboard/perch#<sid>', a FULL page
     load, and a full load fires no hashchange. Without this line every board
     hand-off (talk, dispatch, open, answer, the bird glyph, the #bird= deep
     link) lands on a session list stuck on "Loading sessions…" forever,
     because nothing kicks the first loadList() either. parseHash being
     exhaustively unit-tested does not help: it is a pure function and it was
     green throughout. */
  if(parseHash(location.hash)) applyHash();
  else { startListPolling(); loadList(); }
})();`;
}
