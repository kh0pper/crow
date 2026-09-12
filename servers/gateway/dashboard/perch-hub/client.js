import { tJs } from "../shared/i18n.js";
import { PERCH_SPLIT_MIN_WIDTH } from "./css.js";

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

  /* ── ONE ACTIVE INSTANCE PER DOCUMENT ─────────────────────────────────────
     The dashboard runs Turbo Drive (shared/layout.js's turboHead(), on unless
     CROW_ENABLE_TURBO=0). A Turbo visit REPLACES <body> WITHOUT reloading the
     JS realm, so this script runs again while every closure the previous run
     created is still alive — its EventSource, its 10s list-poll interval, and
     the listeners it put on \`window\` (hashchange, focus, visualViewport),
     which survive because \`window\` does.

     Those survivors are not inert. \`el()\` resolves by id AT CALL TIME, so an
     old instance writes into the NEW document. Measured, not theorised
     (tests/perch-hub-stream-leak.test.js, and the scratch reproduction it was
     written from): four visits to /dashboard/perch, then ONE tap on a session
     row, gives four openSession()s, four loadHistory()s, four live
     EventSource objects and four server-side /events connections — and
     "No transcript yet." four times. The operator's own typed message is the
     ONE thing not duplicated, because \`el('perch-send').onclick=\` is a single
     slot the newest instance owns outright: exactly the asymmetry in the
     transcript Kevin pasted (every streamed element ×6, his message ×1).

     So instances are made mutually exclusive HERE, rather than by closing one
     more path. A window-level registry gives two things a closure variable
     cannot:
       • streams closable BY IDENTITY. \`stream\` below only ever names THIS
         instance's connection; a previous instance's is unreachable from this
         closure, and the registry is the only thing that can still name it.
       • a generation counter, so a retired instance's window listeners become
         no-ops instead of a second writer. Every listener that outlives a
         document — including any added later, e.g. a matchMedia breakpoint
         listener — must be guarded with live().
     ──────────────────────────────────────────────────────────────────────── */
  var HUB=window.__crowPerchHub||(window.__crowPerchHub={gen:0,streams:{},retire:null});
  /* Retire the previous instance BEFORE this one wires anything up.
     BACKSTOP, not the mechanism: with Turbo present the outgoing instance has
     already retired itself on turbo:before-render below, and deleting this
     line leaves the whole leak suite green (measured). It is what still runs
     if that event never fires — a Turbo upgrade that renames it, or any other
     path that re-executes this script in a live document. */
  if(HUB.retire){ try{ HUB.retire(); }catch(e){} }
  var GEN=++HUB.gen, retired=false;
  /* True only for the instance that owns the document right now. */
  function live(){ return !retired&&HUB.gen===GEN; }
  HUB.retire=function(){
    retired=true;
    stopListPolling(); cancelReconnect(); closeStream();
    /* Anything left in the registry belongs to an instance older still (or to
       a session this one never held): close it by identity — that is the
       whole point of keeping the registry. */
    for(var k in HUB.streams){ try{ HUB.streams[k].close(); }catch(e){} delete HUB.streams[k]; }
  };

  /* ONE listener per realm, forwarding to whichever instance is current.

     live() alone made a retired instance's listeners inert but left them
     ATTACHED: measured with DOMDebugger.getEventListeners, five Turbo visits
     took window.focus and window.hashchange from 1 to 5 while the shell's own
     listeners stayed flat, and each retained closure holds rowIndex,
     launchBots, launchModels and pendingImages — the last carrying base64
     image data from any attach. The shell solves this two files away
     (layout.js:390 / :610, "Guarded so Turbo re-executing this script does not
     stack a new listener on every navigation"), and this is that guard with
     one addition it does not need: the shell's handlers act on the document by
     id, while these need INSTANCE state, so the single bound listener
     dispatches through HUB.handlers, which each new instance overwrites with
     its own. Bind once, always current, no growth.

     live() is kept inside each handler: a retired instance with no successor
     is still the registered handler, and must stay inert. */
  HUB.handlers=HUB.handlers||{};
  HUB.bound=HUB.bound||{};
  function bindOnce(target,type,key,fn){
    HUB.handlers[key]=fn;
    if(HUB.bound[key]||!target||!target.addEventListener) return;
    HUB.bound[key]=true;
    target.addEventListener(type,function(ev){
      var h=HUB.handlers[key]; if(h) h(ev);
    });
  }

  /* Turbo tears the document down before the next instance's script runs, so
     retire on the way out too: without it this instance keeps a live SSE
     connection (and a gateway-side subscriber) for the whole time the
     operator is looking at some other panel. */
  bindOnce(document,'turbo:before-render','beforeRender',function(){ if(live()) HUB.retire(); });

  /* The two transcript writers. Defined HERE because the error and
     empty-transcript paths call them, and those are the FIRST paths a user
     hits when something goes wrong — a ReferenceError there is invisible to a
     parse test (new Function binds at call time) and fatal at runtime. */
  function appendNote(text){
    var tr=el('perch-transcript'); if(!tr) return;
    tr.appendChild(line('entry note',text));
    tr.scrollTop=tr.scrollHeight;
  }
  /* Phase D2: the Activity rail. Log-ish frames (log, tool starts, plan
     state, soft error frames, the reconnect notice) land HERE, and the
     transcript keeps only user/bot messages, ask cards and the hard
     failures an operator must see where they read (a failed transcript
     load, a failed send, a lost connection, a stale ask). A timestamp
     leads each row because this rail is exactly where an operator
     reconstructs WHEN something happened. */
  function appendActivity(text){
    var list=el('perch-activity-list'); if(!list) return;
    var stamp='';
    try{ stamp=new Date().toLocaleTimeString()+'  '; }catch(e){}
    list.appendChild(line('activity-row',stamp+text));
    list.scrollTop=list.scrollHeight;
  }
  /* THE ONLY innerHTML assignment in this file, and the only one there may be.

     \`html\` is produced on the SERVER by servers/blog/renderer.js — marked
     plus sanitize-html with an explicit allow-list, the same path the memory
     panel uses — and reaches here on the transcript payload and on the SSE
     frame. Bot output is model-generated and can carry tool results read from
     files, so the RAW text is never trusted: appendMessage falls back to
     line()'s textContent whenever \`html\` is absent or empty, which is what a
     failed render, an older gateway, or a non-prose frame all produce. */
  function setSanitizedHtml(node,html){ node.innerHTML=html; }

  /* \`html\` is optional and server-rendered; without it this is byte-for-byte
     the old textContent behaviour. */
  function appendMessage(cls,who,text,html){
    var tr=el('perch-transcript'); if(!tr) return;
    var row=document.createElement('div'); row.className='entry '+cls;
    row.appendChild(line('who',who));
    if(html&&typeof html==='string'){
      var what=document.createElement('div');
      what.className='what md';
      setSanitizedHtml(what,html);
      row.appendChild(what);
    } else {
      row.appendChild(line('what',text));   /* textContent, never innerHTML */
    }
    tr.appendChild(row);
    tr.scrollTop=tr.scrollHeight;
  }

  var API='/dashboard/perch-api';
  /* Perch now renders inside the dashboard shell (perch-hub/html.js, via
     layout()), so shared/layout.js's global fetch/XHR patch DOES also attach
     X-Crow-Csrf to same-origin POSTs here. This function still sets it
     directly too: perchHubJs() is a plain script generator with no build
     step or dependency on layout.js's own inline script existing, unlike
     the board's client.js (bundled together, sharing that page's helpers) —
     so its perchApi has always read the cookie and set the header itself.
     Keeping that is belt-and-suspenders, not a workaround for a missing
     patch; do not "simplify" by dropping it on the assumption the shell's
     patch alone covers it — that couples this file to being loaded only
     inside the shell, which is more fragile than just keeping the header. */
  function csrf(){ var m=document.cookie.match(/(?:^|; )crow_csrf=([^;]*)/); return m?decodeURIComponent(m[1]):''; }
  function perchApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch(API+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){
      /* fetch() itself rejected — a destroyed socket, a dropped tunnel, a
         gateway restart. Resolving a well-formed failure object here, rather
         than leaving the promise rejected, means every existing .then at
         every call site (onStreamError's reconnect probe, send()'s
         SEND_FAILED note) runs on this path exactly as it does for an HTTP
         error, with no .catch needed at each call site. */
      return {ok:false,status:0,j:null};
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
                  cardId:s.cardId==null?null:s.cardId,pendingUi:!!s.pendingUi,
                  /* /roost carries the operator's name alongside the id
                     (routes/perch.js) — null when there isn't one. */
                  label:(s.label==null||s.label==='')?null:String(s.label)});
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

  /* Every perch-attached bot, whether or not it already has a live session.
     listRows() deliberately drops a bot's idle row the moment it has one live
     session, which is correct for a SESSION list and is exactly why the
     launcher cannot be derived from rows: on an instance where the one
     attached bot has eight live sessions there is no idle row left, and that
     is the state Kevin reported with no way to start a ninth. Same filter as
     listRows (perch_attached), same reason: POST /bots/<id>/interactive 403s
     for a bot with no perch gateway record. Reads the /roost payload
     loadList() already fetched — no second request. */
  function spawnableBots(roost){
    var birds=(roost&&roost.birds)||[];
    var out=[];
    birds.forEach(function(b){
      if(!b||!b.perch_attached) return;
      out.push({id:b.id,name:b.name||b.id});
    });
    out.sort(function(a,b){ return String(a.name).localeCompare(String(b.name)); });
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
  var NO_TRANSCRIPT='${tJs("perch.noTranscript", lang)}';
  var TRANSCRIPT_FAILED='${tJs("perch.transcriptFailed", lang)}';
  var RECONNECTING='${tJs("perch.reconnecting", lang)}';
  var RECONNECT_FAILED='${tJs("perch.reconnectFailed", lang)}';
  var ASK_STALE='${tJs("perch.askStale", lang)}';
  var STEER_LABEL='${tJs("perch.steer", lang)}';
  var SEND_LABEL='${tJs("perch.send", lang)}';
  var ASK_CONFIRM='${tJs("perch.askConfirm", lang)}';
  var ASK_DENY='${tJs("perch.askDeny", lang)}';
  var ASK_CANCEL='${tJs("perch.askCancel", lang)}';
  var ASK_SUBMIT='${tJs("perch.askSubmit", lang)}';
  var NO_ATTACHED_BOTS='${tJs("perch.noAttachedBots", lang)}';
  var MODEL_BOT_DEFAULT='${tJs("perch.modelBotDefault", lang)}';
  var MODEL_BOT_RESOLVES='${tJs("perch.modelBotResolves", lang)}';
  var MODEL_CURRENT_UNLISTED='${tJs("perch.modelCurrentUnlisted", lang)}';
  var LAUNCH_MODEL_FAILED='${tJs("perch.launchModelFailed", lang)}';
  var CLOSE_LABEL='${tJs("perch.close", lang)}';
  var CLOSE_CONFIRM='${tJs("perch.closeConfirm", lang)}';
  var CLOSE_FAILED='${tJs("perch.closeFailed", lang)}';
  var CLOSE_FAILED_FOR='${tJs("perch.closeFailedFor", lang)}';
  var ROW_CARD='${tJs("perch.rowCard", lang)}';
  var RENAME_LABEL='${tJs("perch.rename", lang)}';
  var RENAME_PROMPT='${tJs("perch.renamePrompt", lang)}';
  var RENAME_FAILED='${tJs("perch.renameFailed", lang)}';
  var ROOST_UNREACHABLE='${tJs("perch.roostUnreachable", lang)}';
  /* Open-anywhere C2: the directory picker's own strings. ASK_CANCEL
     ("Cancel") doubles as the modal's visible Cancel — dismiss must never
     depend on Escape alone (review S5). */
  var BROWSE_TITLE='${tJs("perch.browseTitle", lang)}';
  var CHOOSE_LABEL='${tJs("perch.choose", lang)}';
  var BROWSE_FAILED='${tJs("perch.browseFailed", lang)}';
  var CWD_INVALID='${tJs("perch.cwdInvalid", lang)}';
  /* Phase D2: the Session tab's cwd readout + change flow. */
  var CWD_DEFAULT_TEXT='${tJs("perch.cwdPlaceholder", lang)}';
  var CWD_CHANGE_NOTE='${tJs("perch.cwdChangeNote", lang)}';
  var CWD_BUSY='${tJs("perch.cwdBusy", lang)}';
  var CWD_CHANGE_FAILED='${tJs("perch.cwdChangeFailed", lang)}';

  /* Row identity. One bot with eight sessions renders eight rows that read
     "R4 Assistant / awake" and nothing else — measured verbatim in a browser
     as "R4AssistantawakeOpenCloseR4Assistant..." — so telling the mistakes
     from the real work meant Open, read the meta, Back, once per candidate,
     each pass sitting on top of an irreversible Close. Open is recoverable;
     Close is not, which is what makes identity load-bearing here rather than
     decorative. The engine mints "perchlive-" + 8 hex, so the hex alone is
     the short, unambiguous handle. */
  function shortSid(sid){ return String(sid==null?'':sid).replace(/^perchlive-/,''); }
  function rowSubtitle(r){
    if(!r) return '';
    var parts=[r.pendingUi?WAITING_ON_YOU:r.state];
    if(r.sessionId) parts.push(shortSid(r.sessionId));
    /* The card a session is working is the most human handle there is, when
       it has one. cardId is already on every row listRows() builds. */
    if(r.cardId!=null) parts.push(ROW_CARD.replace('{id}',String(r.cardId)));
    return parts.filter(Boolean).join(' \\u00b7 ');
  }
  /* What the confirm calls the session it is about to destroy. A confirm that
     names nothing cannot correct a mis-tap, which is the only thing it is
     there to do. */
  /* Names the session in the close confirmation. The operator's own name
     leads when there is one, but the bot and the short id STAY: an
     irreversible confirm has to name something unambiguous, and two sessions
     can carry the same name. */
  function sessionLabel(sid){
    var r=rowIndex[sid], short=shortSid(sid);
    var base=(r&&r.botName)?(r.botName+' '+short):short;
    return (r&&r.label)?(r.label+' ('+base+')'):base;
  }

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
      /* The name on its OWN line, above the unchanged subtitle. Folding it
         into rowSubtitle() instead would push state/id/card out of a 320px
         column; this keeps "state · id · card" exactly as it was, which is
         also the fallback when there is no name. textContent via line(),
         never innerHTML — this string came from an operator. */
      if(r.label) main.appendChild(line('roost-name',r.label));
      main.appendChild(line('roost-when',rowSubtitle(r)));
      row.appendChild(main);
      var b=document.createElement('button');
      b.type='button'; b.textContent=r.sessionId?OPEN_LABEL:TALK_LABEL;
      b.onclick=r.sessionId
        ? function(){ rowIndex[r.sessionId]=r; location.hash=r.sessionId; }
        : function(){ startSession(r.botId,r.botName); };
      row.appendChild(b);
      /* Only a live session can be closed; an idle bot row has nothing to
         stop. Second button, not a swipe or a long-press: this has to work
         with a thumb on a 412px screen. */
      if(r.sessionId){
        /* No confirm on this one: renaming is reversible and cheap. */
        var n=document.createElement('button');
        n.type='button'; n.className='roost-rename'; n.textContent=RENAME_LABEL;
        n.onclick=function(){ renameSession(r.sessionId,r.label||''); };
        row.appendChild(n);
        var x=document.createElement('button');
        x.type='button'; x.className='roost-close'; x.textContent=CLOSE_LABEL;
        x.onclick=function(){ stopSession(r.sessionId); };
        row.appendChild(x);
      }
      if(r.sessionId) rowIndex[r.sessionId]=r;
      body.appendChild(row);
    });
    flushPendingNote();               /* a parked note must survive this render */
  }

  /* The bots the launcher can spawn against, refreshed by every loadList().
     Empty until the first /roost answers — which is why #perch-new ships
     disabled in the markup rather than enabled-and-lying. */
  var launchBots=[];

  function sameBotIds(a,b){
    if(a.length!==b.length) return false;
    for(var i=0;i<a.length;i++){ if(a[i].id!==b[i].id) return false; }
    return true;
  }

  /* The launcher's one-line explainer. Factored out because loadList()'s
     failure branch needs it too — a greyed button with no reason beside it is
     the thing finding 3 was about. */
  function setLaunchNote(text){
    var note=el('perch-launch-note'); if(!note) return;
    note.textContent=text||'';
    note.hidden=!text;
  }

  function renderLauncher(bots){
    var btn=el('perch-new'), sel=el('perch-new-bot'),
        lbl=el('perch-new-bot-label');
    if(!btn) return;
    var changed=!sameBotIds(launchBots,bots);
    launchBots=bots;
    if(!bots.length){
      /* Never offer a spawn that is guaranteed to 403 — say why instead. */
      btn.disabled=true;
      if(sel){ sel.hidden=true; if(changed) clearEl(sel); }
      if(lbl) lbl.hidden=true;
      setLaunchNote(NO_ATTACHED_BOTS);
      hideLaunchModels();          /* no bot, no model list that means anything */
      return;
    }
    btn.disabled=false;
    setLaunchNote('');
    /* One attached bot is the common case (and Kevin's): no BOT picker, one
       tap. The MODEL picker is still offered — it is per-bot, not per-roster,
       and this is the path his instance actually takes. */
    if(bots.length===1){
      if(sel){ sel.hidden=true; if(changed) clearEl(sel); }
      if(lbl) lbl.hidden=true;
      syncLaunchModels();
      return;
    }
    if(lbl) lbl.hidden=false;
    if(sel){
      sel.hidden=false;
      /* Rebuild ONLY when the roster actually changed: this runs on every
         10s poll, and repopulating unconditionally would throw away the
         operator's pick mid-tap. */
      if(changed){
        var keep=sel.value;
        clearEl(sel);
        bots.forEach(function(b){
          var opt=document.createElement('option');
          opt.value=b.id; opt.textContent=b.name;
          sel.appendChild(opt);
        });
        if(keep&&bots.filter(function(b){ return b.id===keep; }).length) sel.value=keep;
      }
    }
    syncLaunchModels();
  }

  /* ---- the launcher's model picker ------------------------------------
     Models are per-bot, and the session whose model this chooses does not
     exist yet — so this reads GET /bots/<id>/models (perch-model-catalog.js
     behind it), NOT /interactive/<sid>/options, which is keyed on a session
     id. It follows whichever bot the roster select is on.

     \`botId\` is the roster the list belongs to; \`want\` is the fetch in
     flight. Fetching only when the bot CHANGES matters: renderLauncher runs
     on every 10s poll, and repopulating unconditionally would throw away the
     operator's pick mid-tap — the same reason the bot roster itself is
     rebuilt only on a real change. */
  var launchModels={botId:null,default:null,want:null};

  /* Which bot the launcher would spawn against right now. startNewSession()
     resolves the same thing for the same reason; both go through here so the
     model list and the spawn can never disagree about the bot. */
  function launchBotId(){
    if(!launchBots.length) return null;
    if(launchBots.length>1){
      var sel=el('perch-new-bot');
      var want=sel?String(sel.value||''):'';
      var hit=launchBots.filter(function(b){ return b.id===want; })[0];
      if(hit) return hit.id;
    }
    return launchBots[0].id;
  }

  function hideLaunchModels(){
    var sel=el('perch-new-model'), lbl=el('perch-new-model-label');
    if(sel){ sel.hidden=true; clearEl(sel); }
    if(lbl) lbl.hidden=true;
    /* want cleared too, so the next poll retries a list that failed to load
       rather than leaving the picker permanently absent. */
    launchModels={botId:null,default:null,want:null};
  }

  function renderLaunchModels(list,dflt){
    var sel=el('perch-new-model'), lbl=el('perch-new-model-label');
    if(!sel) return;
    clearEl(sel);
    var listed=dflt&&list.filter(function(m){ return (m&&m.provider)+'/'+(m&&m.id)===dflt; }).length>0;
    /* NO CONFIGURED DEFAULT — the common case on this instance: 3 of 5 R4 bot
       defs carry models:null, and a def naming a since-disabled provider row
       lands here too. Without this option nothing was preselected, the browser
       picked option 0, and startSession() then saw a value different from the
       (null) default and fired a REAL control() switch — so one tap on
       "New session" silently moved the session onto whatever sorted first in
       provider order, where spawn would have resolved model_resolver.mjs's own
       fallback. An empty value means "send no control at all", which is
       exactly what letting the spawn decide has to mean. */
    if(!listed){
      var none=document.createElement('option');
      none.value='';                                   /* startSession(): falsy => no control() */
      none.textContent=MODEL_BOT_RESOLVES;
      sel.appendChild(none);
    }
    list.forEach(function(m){
      var opt=document.createElement('option');
      var key=(m&&m.provider)+'/'+(m&&m.id);
      opt.value=key;
      /* modelOptionText carries the availability annotation, so an
         unavailable model reads as unavailable here exactly as it does in
         the drawer — never a silently selectable dead choice. */
      opt.textContent=modelOptionText(m)+(key===dflt?' \u2014 '+MODEL_BOT_DEFAULT:'');
      sel.appendChild(opt);
    });
    /* Pre-selected on the bot's own configured model when there IS one: an
       operator who does not care taps the button and gets what the bot was
       built with. With no default the sentinel above is option 0 and the
       browser selects it unaided — an explicit sel.value='' here was measured
       redundant (removing it left every test green), so it is not written. */
    if(listed) sel.value=dflt;
    sel.hidden=false;
    if(lbl) lbl.hidden=false;
  }

  function syncLaunchModels(){
    var botId=launchBotId();
    if(!botId){ hideLaunchModels(); return; }
    if(launchModels.botId===botId||launchModels.want===botId) return;   /* shown, or in flight */
    launchModels.want=botId;
    perchApi('GET','/bots/'+encodeURIComponent(botId)+'/models').then(function(r){
      if(launchModels.want!==botId) return;      /* the operator moved to another bot */
      if(!r.ok||!r.j||!Array.isArray(r.j.models)||!r.j.models.length){ hideLaunchModels(); return; }
      launchModels={botId:botId,default:r.j['default']||null,want:null};
      renderLaunchModels(r.j.models,launchModels.default);
    });
  }
  el('perch-new-bot').onchange=function(){ syncLaunchModels(); };

  /* The launch control's own handler. Resolves the bot from the picker when
     there is one, then hands off to startSession() verbatim — the 409/403/
     missing-sessionId handling, the rowIndex write, the hash navigation and
     the current.sid identity guard all live there and are not duplicated. */
  function startNewSession(){
    if(!launchBots.length){ setLaunchNote(NO_ATTACHED_BOTS); return; }
    var pick=launchBots[0];
    if(launchBots.length>1){
      var sel=el('perch-new-bot');
      var want=sel?String(sel.value||''):'';
      var hit=launchBots.filter(function(b){ return b.id===want; })[0];
      if(hit) pick=hit;
    }
    /* Only a list that belongs to THIS bot may speak for it — a picker still
       showing the previous bot's models must not choose for this spawn. */
    var msel=el('perch-new-model');
    var model=(msel&&!msel.hidden&&launchModels.botId===pick.id)?String(msel.value||''):'';
    /* Open-anywhere C2: the directory field. EMPTY means "the bot's
       default" and the key is NEVER sent — an empty string must not reach
       the route as a cwd it then validates and 400s. */
    var cwdEl=el('perch-new-cwd');
    var cwd=cwdEl?String(cwdEl.value||'').trim():'';
    startSession(pick.id,pick.name,model,cwd||null);
  }
  el('perch-new').onclick=startNewSession;

  /* ---- open-anywhere C2: the server-backed directory picker ------------
     A modal overlay fed by GET /browse (directory NAMES + paths only, never
     contents — routes/perch-interactive-api.js). One modal, two callers:
     the launcher's Browse button (onChoose writes #perch-new-cwd) and, from
     D2 on, the Session tab's "Change directory" (onChoose POSTs
     control({cwd})). Built lazily with createElement/textContent only — the
     house rule on innerHTML (setSanitizedHtml's comment) admits no second
     sink, and a directory name is operator-adjacent free text. */
  var browse={open:false,onChoose:null,path:''};

  function closeBrowseModal(){
    browse.open=false; browse.onChoose=null;
    var m=el('perch-browse-modal'); if(m) m.hidden=true;
  }

  function buildBrowseModal(){
    if(el('perch-browse-modal')) return;
    var root=el('perch-hub-root'); if(!root) return;
    var overlay=document.createElement('div'); overlay.id='perch-browse-modal'; overlay.hidden=true;
    var box=document.createElement('div'); box.className='browse-box';
    box.setAttribute('role','dialog'); box.setAttribute('aria-modal','true');
    box.setAttribute('aria-label',BROWSE_TITLE);
    var head=document.createElement('div'); head.className='browse-head';
    var pathEl=document.createElement('div'); pathEl.className='browse-path'; pathEl.id='perch-browse-path';
    head.appendChild(pathEl);
    var hint=document.createElement('div'); hint.className='browse-hint'; hint.id='perch-browse-hint'; hint.hidden=true;
    var list=document.createElement('div'); list.className='browse-list'; list.id='perch-browse-list';
    var foot=document.createElement('div'); foot.className='browse-foot';
    var choose=document.createElement('button'); choose.type='button'; choose.className='primary';
    choose.id='perch-browse-choose'; choose.textContent=CHOOSE_LABEL;
    var cancel=document.createElement('button'); cancel.type='button';
    cancel.id='perch-browse-cancel'; cancel.textContent=ASK_CANCEL;
    foot.appendChild(choose); foot.appendChild(cancel);
    box.appendChild(head); box.appendChild(hint); box.appendChild(list); box.appendChild(foot);
    overlay.appendChild(box);
    root.appendChild(overlay);
    /* Choose hands the CURRENT path (wherever navigation ended) to the
       caller and closes BEFORE invoking it, so a failure note the callback
       writes lands on a clean screen. */
    choose.onclick=function(){
      if(!browse.open) return;
      var fn=browse.onChoose, p=browse.path;
      closeBrowseModal();
      if(fn&&p) fn(p);
    };
    cancel.onclick=closeBrowseModal;
  }

  function loadBrowseDir(p){
    var q=p?('?path='+encodeURIComponent(p)):'';
    return perchApi('GET','/browse'+q).then(function(r){
      if(!browse.open) return;
      var list=el('perch-browse-list'); if(!list) return;
      if(!r.ok||!r.j||!Array.isArray(r.j.dirs)){
        /* A failed fetch is not an empty directory: keep the rows the
           operator can still navigate out of, and say what happened. */
        clearEl(list); list.appendChild(line('empty',BROWSE_FAILED));
        return;
      }
      browse.path=r.j.path;
      var pathEl=el('perch-browse-path'); if(pathEl) pathEl.textContent=r.j.path;
      clearEl(list);
      /* The '..' row uses the RESOLVED parent the endpoint reports — never a
         client-side string chop, which a symlinked dir would ping-pong. */
      if(r.j.parent&&r.j.parent!==r.j.path){
        var up=document.createElement('button'); up.type='button'; up.textContent='..';
        up.onclick=function(){ loadBrowseDir(r.j.parent); };
        list.appendChild(up);
      }
      r.j.dirs.forEach(function(d){
        if(!d||!d.name) return;
        var b=document.createElement('button'); b.type='button'; b.textContent=d.name;
        b.onclick=function(){ loadBrowseDir(d.path); };
        list.appendChild(b);
      });
      list.scrollTop=0;
    });
  }

  function openBrowseModal(opts){
    buildBrowseModal();
    var m=el('perch-browse-modal'); if(!m) return;
    browse.open=true;
    browse.onChoose=(opts&&opts.onChoose)||null;
    browse.path='';
    var hint=el('perch-browse-hint');
    if(hint){
      var note=(opts&&opts.note)||'';
      hint.textContent=note; hint.hidden=!note;
    }
    m.hidden=false;
    loadBrowseDir((opts&&opts.initial)||'');
    var c=el('perch-browse-cancel'); if(c&&c.focus) c.focus();
  }

  /* Escape closes the picker — the second dismiss path review S5 demands
     beside the visible Cancel button. document OUTLIVES a Turbo body swap,
     so this goes through the generation-checked registry like every other
     window/document listener in this file. */
  bindOnce(document,'keydown','browseEscape',function(ev){
    if(!live()) return;
    if(ev.key==='Escape'&&browse.open) closeBrowseModal();
  });

  var browseBtn=el('perch-browse-btn');
  if(browseBtn) browseBtn.onclick=function(){
    var f=el('perch-new-cwd');
    openBrowseModal({
      initial:f?String(f.value||'').trim():'',
      onChoose:function(p){ var f2=el('perch-new-cwd'); if(f2) f2.value=p; }
    });
  };

  /* engine.stop() (perch-interactive.js:1955) kills the pi child and parks the
     row: TERMINAL, no resume. Hence the confirm, whose copy says so — an
     accidental thumb on a phone must not destroy a conversation. The
     dashboard's own idiom for this is a native confirm guarded by an early
     return (bot-board/drawer.js:941), so that is what this uses.
     No mySid capture: this is keyed on the sid being STOPPED, not on whatever
     is open, so a stop fired from a list row while another session is open
     resolves against the right session. current.sid is consulted only to
     decide WHERE the outcome is shown — and, on success, to leave a chat view
     whose SSE stream the engine has just closed. */
  /* Rename, or clear a name. No confirm — this is reversible and touches no
     child; the confirm on stopSession() below exists because THAT is
     terminal. prompt() returning null is a CANCEL and must do nothing;
     returning '' is a deliberate CLEAR and must go through, which is why this
     branches on null rather than on falsiness. */
  function renameSession(sid,currentLabel){
    if(!sid) return;
    var next=prompt(RENAME_PROMPT,String(currentLabel==null?'':currentLabel));
    if(next===null) return;                       /* cancelled, not cleared */
    perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/rename',{label:next}).then(function(r){
      if(!r.ok){
        if(current.sid===sid) appendNote(RENAME_FAILED); else showListNote(RENAME_FAILED);
        return;
      }
      /* The engine normalizes (trim, cap, empty -> null), so the stored value
         is what comes BACK, never what was typed. */
      var stored=(r.j&&r.j.label)||null;
      if(rowIndex[sid]) rowIndex[sid].label=stored;
      if(current.sid===sid) showSessionName(stored);
      loadList();
    });
  }

  function stopSession(sid){
    if(!sid) return;
    if(!confirm(CLOSE_CONFIRM.replace('{session}',sessionLabel(sid)))) return;
    perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/stop').then(function(r){
      /* 404 no_such_session / 410 already stopped: the operator's goal is
         already true. Refresh, show nothing — an error there would be a lie. */
      if(r.ok||r.status===404||r.status===410){
        /* Navigate rather than call closeSession() directly, so applyHash ->
           closeSession runs and closeSession's setView('list') +
           startListPolling() + loadList() all fire.
           REPLACE, not assign: the #perchlive-<sid> entry we are leaving now
           points at a session that no longer exists. Pushing a new entry on
           top of it means Back lands on the dead deep link, which
           openSession's cold /roost miss bounces through
           noteAndReturnToList -> another entry -> Back again forever. The
           operator could never get behind this page. */
        if(current.sid===sid){ leaveToList(); return; }
        loadList();
        return;
      }
      var text=(r.j&&r.j.error)||CLOSE_FAILED;
      /* showListNote writes into #perch-list-body, which the chat view
         display:none's below 900px — so an in-chat failure goes to the
         transcript instead, the same split every other in-chat failure in
         this file uses (SEND_FAILED, ASK_STALE). */
      if(current.sid===sid){ appendNote(text); return; }
      /* Not the session on screen, but still IN a chat view: the operator
         closed this session, the POST was slow, and they moved on. The list
         body is hidden, so showListNote here is an invisible error about a
         session that is still alive and still costing a pi child. Park it —
         renderList flushes it the moment they come back to the list — and
         name the session, because it is no longer the one in front of them. */
      if(current.sid){ pendingNote=CLOSE_FAILED_FOR.replace('{session}',sessionLabel(sid)); return; }
      showListNote(text);
    });
  }

  /* A bot with no session: spawn, then let the hash router open it, so history
     stays correct and the cold-deep-link path is the same code.
     \`modelKey\` ("provider/id", optional) is the launcher's pick. A row-driven
     spawn passes none and behaves exactly as it always has.
     \`cwd\` (open-anywhere C2, optional) is the launcher's directory field;
     null means the key is never sent — the bot's default world root. */
  function startSession(botId,botName,modelKey,cwd){
    var mySid=current.sid;                  /* identity guard: a spawn resolving after the
                                                operator has opened another session must not
                                                yank them out of it */
    perchApi('POST','/bots/'+encodeURIComponent(botId)+'/interactive',cwd?{cwd:cwd}:undefined).then(function(r){
      if(current.sid!==mySid) return;
      /* setLaunchNote, not showListNote: a FAILED SPAWN is a fact about the
         launcher, and showListNote clears #perch-list-body — which would wipe
         every session row and, with them, every Close button, for up to the
         10s until the next poll. That was tolerable while the only spawn
         trigger was an idle row (a list with idle rows has nothing much to
         lose); the always-present launcher makes it routine, and it lands
         hardest on an operator whose actual job right now is closing
         sessions. The note belongs next to the control that produced it. */
      if(r.status===409){ setLaunchNote(ENGINE_REQUIRED); return; }
      if(r.status===403){ setLaunchNote(NOT_ATTACHED); return; }
      /* The route validated the directory before the engine ever saw it
         (open-anywhere C1): a stale picker choice — deleted between browse
         and spawn — lands here, and the note belongs beside the field. */
      if(r.status===400&&r.j&&r.j.error==='bad_cwd'){ setLaunchNote(CWD_INVALID); return; }
      if(!r.ok||!r.j||!r.j.sessionId){ setLaunchNote(START_FAILED); return; }
      var sid=r.j.sessionId;
      rowIndex[sid]={botId:botId,botName:botName,sessionId:sid};
      /* The model, applied BEFORE the first message and before the operator
         can send one. spawn() takes no model on purpose — the engine's
         control-before-wake path already exists (perch-interactive.js:78-92)
         and is the one the drawer's own picker uses. On a session this fresh
         the child is up but has never run a turn, so control() warms the
         chosen provider and set_model's it while nothing is in flight: the
         first turn is served by it, not a later switch.
         Nothing to do when the pick IS the bot's default — that is what the
         spawn already resolved, and a redundant switch would warm a provider
         twice for no change. */
      if(!modelKey||modelKey===launchModels.default){ location.hash=sid; return; }
      perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/control',controlBody('model',modelKey))
        .then(function(c){
          if(current.sid!==mySid) return;   /* same identity guard as the spawn above */
          /* A refused switch is not a refused session: the session is real
             and usable on the bot's own model, so say what happened and open
             it rather than stranding a live child behind an error. */
          if(!c.ok) setLaunchNote(LAUNCH_MODEL_FAILED);
          location.hash=sid;
        });
    });
  }

  var listTimer=null;
  function loadList(){
    return perchApi('GET','/roost').then(function(r){
      /* One payload, two renders: the rows AND the launcher's bot roster.
         Deriving the launcher from the same /roost response is what keeps
         this to a single request per poll. */
      if(r.ok&&r.j){ renderLauncher(spawnableBots(r.j)); renderList(listRows(r.j)); return; }
      /* A failed /roost is NOT an empty roost, and the old else branch said
         both of the wrong things at once: it rendered "No live sessions." (a
         lie) and skipped renderLauncher entirely, leaving #perch-new greyed
         out with no reason given. Measured live against a 503: greyed button,
         hidden note, false empty list — which is precisely the "I can only
         interact with what already exists" state this whole task exists to
         end, re-created by a gateway blip. Self-heals on the next 10s poll;
         permanent if the failure is.
         rowIndex is cleared but pendingNote is deliberately NOT flushed here:
         a parked note ("That session is gone.") survives the blip and lands
         on the next successful render, which is where it was going anyway. */
      rowIndex={};
      showListNote(ROOST_UNREACHABLE);
      if(launchBots.length){
        /* A roster we already know stays usable — the bots did not vanish
           because one poll failed, and spawning is still worth attempting. */
        var btn=el('perch-new'); if(btn) btn.disabled=false;
      } else {
        /* Never seen a roster: the button has nothing to spawn against, so
           say why rather than just greying out. */
        setLaunchNote(ROOST_UNREACHABLE);
      }
    });
  }
  /* Poll only while the list is showing. In the chat view the SSE stream is
     already the live signal, so polling there is pure waste. */
  /* Every timer and window listener below is gated on live(): they outlive
     the document Turbo replaces, and an ungated one is a retired instance
     still polling, still rendering rows, still opening streams. */
  function startListPolling(){ stopListPolling(); listTimer=setInterval(function(){ if(live()) loadList(); },10000); }
  function stopListPolling(){ if(listTimer){ clearInterval(listTimer); listTimer=null; } }

  /* Whether the session list is ON SCREEN, which is the only thing that
     decides whether it must keep polling — NOT which view is "current".
     At and above the split breakpoint (perch-hub/css.js's
     PERCH_SPLIT_MIN_WIDTH; the media query and this share the one constant)
     .hub-split is a two-column grid and body[data-view="chat"] #perch-list is
     display:block, so opening a session leaves the list right there beside it.
     Stopping the poll on open therefore froze a VISIBLE list: an operator on a
     1900px window saw "R4 Assistant / idle" with a Talk button next to the
     awake session he was typing in, and no Close anywhere on that surface,
     because Close only exists on a live row. */
  /* ONE MediaQueryList per realm: window.matchMedia() mints a new object every
     call, so a per-instance one could never be bound once. */
  var SPLIT=HUB.split||(HUB.split=(window.matchMedia?window.matchMedia('(min-width:${PERCH_SPLIT_MIN_WIDTH}px)'):null));
  function listOnScreen(){ return body.getAttribute('data-view')==='list'||!!(SPLIT&&SPLIT.matches); }
  function syncListPolling(){
    if(listOnScreen()){ startListPolling(); loadList(); }
    else stopListPolling();                    /* below the breakpoint it really is hidden */
  }
  /* Crossing the breakpoint changes the answer with no view change and no
     navigation — the same class of problem shared/layout.js's own sidebar
     matchMedia listener handles, and the same guard: a retired instance must
     not start polling again from here. */
  /* addListener is the pre-2019 Safari spelling; still the only one there —
     the shell's own breakpoint listener carries the same fallback
     (layout.js:~620), and without it the re-evaluation silently never binds on
     that browser. bindOnce handles the modern spelling; the legacy branch
     repeats its bookkeeping because MediaQueryList.addListener is not
     addEventListener. */
  if(SPLIT&&SPLIT.addEventListener){
    bindOnce(SPLIT,'change','splitChange',function(){ if(live()) syncListPolling(); });
  } else if(SPLIT&&SPLIT.addListener){
    HUB.handlers.splitChange=function(){ if(live()) syncListPolling(); };
    if(!HUB.bound.splitChange){
      HUB.bound.splitChange=true;
      SPLIT.addListener(function(ev){ var h=HUB.handlers.splitChange; if(h) h(ev); });
    }
  }

  bindOnce(window,'focus','focus',function(){
    if(!live()) return;
    if(listOnScreen()) loadList();
  });

  /* Engine-minted ids only: "perchlive-" + 8 hex (perch-interactive.js:1473).
     A loose pattern would admit ".." and this value is concatenated into an
     API path. Encoded at every use site as well, belt and braces. */
  function parseHash(h){
    var raw=String(h==null?'':h).replace(/^#/,'');
    return /^perchlive-[0-9a-f]{8}$/.test(raw)?{sessionId:raw}:null;
  }

  var current={sid:null};
  /* Images attached via attachFile(), queued for the NEXT send() only —
     drawer.js:406/916 does the same two-part attach: upload now (POST
     .../files), attach the wire-shape {mime,data_b64} array on the send that
     follows, then clear regardless of outcome. resetControls() also clears
     this so a new session never inherits a stale queue. */
  var pendingImages=[];

  function openSession(sid){
    if(current.sid===sid) return;          /* a re-entered hash is a no-op */
    closeStream();
    current.sid=sid;
    var mySid=sid;                          /* identity guard for every await below */
    setView('chat');
    /* SSE is the live signal for the CHAT. It says nothing about the list,
       which in split view is still on screen — so the poll stops only when the
       list is genuinely hidden. */
    syncListPolling();
    clearEl(el('perch-transcript')); clearEl(el('perch-ask'));
    clearEl(el('perch-activity-list'));   /* the previous session's log is not this one's */
    resetControls();                        /* the PREVIOUS session's picker must not bleed in */
    var known=rowIndex[sid];
    if(known){ showHeader(known.botId,known.botName); afterHeader(mySid,known.botId); return; }
    /* A cold deep link does not know the bot; ask /roost rather than guess. */
    perchApi('GET','/roost').then(function(r){
      if(current.sid!==mySid) return;       /* the hash moved on while we waited */
      var hit=r.ok&&r.j?listRows(r.j).filter(function(x){return x.sessionId===mySid;})[0]:null;
      if(!hit){ noteAndReturnToList(SESSION_GONE); return; }
      /* Cache it: sessionLabel() reads rowIndex to name the session in the
         close confirm, and without this a cold deep link would offer an
         irreversible "Close 22222222?" with no bot name on it. */
      rowIndex[mySid]=hit;
      showHeader(hit.botId,hit.botName); afterHeader(mySid,hit.botId);
    });
  }

  /* Stream FIRST, history second: the stream carries no backlog. */
  function afterHeader(sid,botId){ openStream(sid); loadHistory(botId,sid); loadOptions(sid); }

  function closeSession(){
    closeStream(); current.sid=null;
    setTurnInFlight(false);      /* the list has no Steer/Stop to show */
    setView('list'); startListPolling(); loadList();
  }

  /* A note set before loadList() resolves is wiped by renderList. Park it and
     let renderList re-append it — otherwise "That session is gone." is never
     seen, on exactly the dead-deep-link path it exists for. */
  /* Leave a session that no longer exists, WITHOUT stacking a history entry
     on top of a dead deep link. location.hash='' pushes one, so Back returns
     to #perchlive-<gone> -> openSession -> cold /roost miss ->
     noteAndReturnToList -> another entry: the operator can never get behind
     this page with Back.
     location.replace('#') is the form that works, and the alternative is a
     trap worth naming: location.replace(location.pathname+location.search)
     gives a tidier URL, adds no history entry either — and fires NO
     hashchange, so applyHash -> closeSession never runs and the view stays on
     a dead chat. Measured both in a real browser; '#' fires hashchange and
     leaves location.hash === ''. Do not "clean up" the trailing #. */
  function leaveToList(){ location.replace('#'); }
  function noteAndReturnToList(text){ pendingNote=text; leaveToList(); }   /* pendingNote: Task 2 */

  function applyHash(){
    var hit=parseHash(location.hash);
    if(hit) openSession(hit.sessionId); else closeSession();
  }
  bindOnce(window,'hashchange','hashchange',function(){ if(live()) applyHash(); });

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

  /** Drop \`es\` from the shared registry, whoever put it there. */
  function unregisterStream(es){
    for(var k in HUB.streams){ if(HUB.streams[k]===es) delete HUB.streams[k]; }
  }

  function closeStream(){
    cancelReconnect();                 /* timer only — NOT the retry counter */
    var es=stream; stream=null;        /* null FIRST: idempotent under a double call
                                          from openSession + hashchange */
    if(es){ try{ es.close(); }catch(e){} unregisterStream(es); }
  }

  function openStream(sid){
    closeStream();
    /* EXPLICIT REPLACE, by identity. closeStream() above can only reach the
       connection THIS instance holds; a stream opened for this session by an
       older instance (or by a path that lost its handle) is named only by the
       registry, and leaving it open is what multiplied every streamed event
       by the number of surviving instances. */
    var prev=HUB.streams[sid];
    if(prev){ try{ prev.close(); }catch(e){} delete HUB.streams[sid]; }
    var es=new EventSource(API+'/interactive/'+encodeURIComponent(sid)+'/events');
    stream=es;
    HUB.streams[sid]=es;
    es.onopen=function(){ resetBackoff(); };

    var on=function(type,fn){
      es.addEventListener(type,function(ev){
        if(!live()) return;                           /* a retired instance never writes */
        if(current.sid!==sid) return;                 /* identity guard, every listener */
        /* A native EventSource connection failure delivers a type "error"
           Event to every listener registered for "error" via addEventListener
           — not only es.onerror — and unlike a real engine error FRAME it
           carries no .data. Without this check, every dropped connection
           printed a bare "error" note here before onStreamError (bound
           through the single-slot es.onerror property) ever got to reconnect. */
        if(typeof ev.data!=='string') return;
        var d={}; try{ d=JSON.parse(ev.data); }catch(e){ d={}; }
        fn(d);
      });
    };
    on('state',function(d){
      setTurnInFlight(turnFlagFor(d));
      el('perch-state').textContent=d.state||'';
      /* The engine echoes the label on every state frame, so a rename made
         from the list row (or another tab) shows up here without a reload. */
      if(rowIndex[sid]) rowIndex[sid].label=d.label||null;
      showSessionName(d.label||null);
      /* Reflects the engine's own record (snapshot()/stateEvent() in
         perch-interactive.js), never the picker back at it — setting
         .value/.checked does not fire change, so this cannot loop. */
      /* d.model is servingModel(): pi's own /model, an auto-fallback, or the
         echo of our own switch. It was on the wire all along and ignored —
         which is how the picker came to assert a model nobody measured. */
      var modelSel=el('perch-model');
      if(modelSel&&d.model&&!modelSel.disabled) selectCurrentModel(modelSel,d.model);
      if(d.permissionMode){ var permSel=el('perch-permission'); if(permSel) permSel.value=d.permissionMode; }
      var planCb=el('perch-plan-mode'); if(planCb) planCb.checked=!!d.planMode;
      /* Open-anywhere D2: the Session tab's read-only cwd readout, refreshed
         from the engine's own record on every state frame (subscribe replays
         one on connect, so this is also how the tab learns cwd FIRST — there
         is no separate snapshot fetch). null = the bot's default directory.
         textContent only: the value is a filesystem path, never markup. */
      var cwdEl=el('perch-session-cwd');
      if(cwdEl) cwdEl.textContent=d.cwd||CWD_DEFAULT_TEXT;
    });
    /* MESSAGE-LEVEL, not delta-level (perch-interactive.js:1257 says so
       outright): one frame per COMPLETED assistant message, so each is
       rendered on arrival and nothing has to be patched afterwards. */
    on('text',function(d){
      /* The engine only emits \`text\` for a NON-EMPTY assistant message
         (perch-interactive.js's message_end branch), so an empty one here is a
         frame whose JSON did not parse — on()'s \`d={}\` fallback. Appending it
         put an empty entry in the transcript AND marked the turn rendered,
         suppressing the real reply. Skip it entirely. */
      if(!d.text) return;
      if(!histSettled){ histBuf.push(d); return; }   /* round 3 R4, see flushHistBuf */
      renderTextFrame(d);
    });
    on('tool',function(d){ if(d.phase==='start') appendActivity('[tool: '+(d.name||'?')+']'); });
    on('log',function(d){ if(d.text) appendActivity(d.text); });
    /* \`reply\` carries replyTextOf(end) — every assistant message of the turn
       CONCATENATED — so appending it unconditionally rendered a two-message
       turn three times: each message, then both again as one block. It cannot
       simply stop being handled either: it clears the turn flag, and its text
       comes from the agent_end the engine was handed rather than the child's
       accumulating log (which trimLog() empties), so it is the more
       authoritative source when it is the only one.
       So: append ONLY when nothing rendered for this turn. That case is real,
       not theoretical — the stream carries no backlog, so an operator who
       opens the drawer mid-turn sees no \`text\` frames for the messages already
       streamed, and \`reply\` is the only copy of that answer they will get.
       Flag read BEFORE setTurnInFlight(false), which is what resets it. */
    on('reply',function(d){
      /* Judged against THIS turn when the frame names one, and only against the
         client's transition flag when it does not. Read before
         setTurnInFlight(false), which is what resets that flag.
         Round 3 R4: while the history batch is still in flight the APPEND
         decision is buffered with the text frames — judging it now would
         compare against a transcript the batch has not filled yet. The
         composer state is NOT buffered: it never appears in the batch, and
         delaying Steer/Stop back to "sendable" is worse than one frame of
         lag on the prose. */
      if(!histSettled) histBuf.push({ reply:true, text:d.text, html:d.html, turnId:d.turnId });
      else {
        var already=d.turnId?(renderedTurn===d.turnId):turnRendered;
        if(!already&&d.text) appendMessage('bot','bot',d.text,d.html);
      }
      setTurnInFlight(false);
    });
    on('ask_user',function(d){ renderAsk(d); });
    on('error',function(d){ appendActivity(d.text||'error'); });
    on('plan_state',function(d){ var t=planStateText(d.state); if(t) appendActivity(t); });
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

  /* The name line in the chat header. textContent and \`hidden\` only — the
     value is operator free text and must never reach an HTML sink. */
  function showSessionName(label){
    var e=el('perch-session-name'); if(!e) return;
    e.textContent=label==null?'':String(label);
    e.hidden=!label;
  }
  function showHeader(botId,botName){
    el('perch-bot-name').textContent=botName||botId;
    /* The session id stays here, unchanged and on its own: it is the identity
       the close confirm and every API path use. */
    el('perch-session-meta').textContent=current.sid||'';
    var known=rowIndex[current.sid];
    showSessionName(known?known.label:null);
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
    appendActivity(RECONNECTING);   /* D2: chatter to the rail; the CAP is a hard failure and stays in chat */
    var mySid=current.sid;                          /* no parameter to get wrong */
    retryTimer=setTimeout(function(){
      if(!live()) return;                           /* retired mid-backoff */
      if(current.sid!==mySid) return;               /* navigated away mid-backoff */
      openStream(mySid);
    },2000);
  }

  function loadHistory(botId,sid){
    var mySid=sid;
    perchApi('GET','/bots/'+encodeURIComponent(botId)+'/sessions/'+encodeURIComponent(sid)+'/transcript')
      .then(function(r){
        if(current.sid!==mySid) return;            /* identity guard, as everywhere */
        /* A FAILED FETCH IS NOT AN EMPTY TRANSCRIPT. The old
           \`(r.ok&&r.j&&r.j.events)||[]\` collapsed a 500, a dropped tunnel and
           a logged-out session into the same "No transcript yet." — a
           reassuring sentence about a conversation that is still there. Say
           which happened. */
        if(!r.ok||!r.j){ appendNote(TRANSCRIPT_FAILED); flushHistBuf([]); return; }
        var events=r.j.events||[];
        if(!events.length){ appendNote(NO_TRANSCRIPT); flushHistBuf([]); return; }
        var batchTexts=[];
        events.filter(function(e){ return e&&e.type==='message'; }).forEach(function(e){
          var m=e.message||{};
          /* e.html is present only for an ASSISTANT message that had text
             (routes/perch.js's assistantHtml) — the operator's own typing is
             not markdown, and a pure tool-call message still renders as
             messageText()'s "[tool: name]" line. */
          var txt=messageText(m);
          if(String(m.role||'?')!=='user') batchTexts.push(txt);
          appendMessage(String(m.role||'?')==='user'?'user':'bot', String(m.role||'?'), txt, e.html);
        });
        flushHistBuf(batchTexts);
      });
  }

  /* Round 3 R4 — the subscribe/fetch seam. openStream subscribes BEFORE
     loadHistory resolves, and both writers hit the same completed message:
     the frame on arrival, the batch when the fetch lands after it. Measured
     shape of the duplicate the review named — and it is not adjacent to
     anything (the frame writes first, the whole batch appends behind it),
     so a last-entry comparison could never catch it. Transcript-writing
     text/reply frames park in histBuf until the batch settles; the flush
     renders each buffered entry unless its EXACT text is already on screen
     from the batch (bookkeeping still applies — that turn IS rendered), so
     a message that completed between subscribe and snapshot lands once.
     Failed or empty history flushes against nothing: the frames are then
     the only copy. Notes and state frames are never buffered — they are
     not in the batch, and delaying them delays the composer. */
  var histSettled=false;
  var histBuf=[];
  function renderTextFrame(d){
    appendMessage('bot','bot',d.text,d.html);
    if(d.turnId) renderedTurn=d.turnId; else turnRendered=true;
  }
  function flushHistBuf(batchTexts){
    histSettled=true;
    var buf=histBuf; histBuf=[];
    buf.forEach(function(f){
      if(f.reply){
        var already=f.turnId?(renderedTurn===f.turnId):turnRendered;
        if(!already&&f.text&&batchTexts.indexOf(f.text)<0) appendMessage('bot','bot',f.text,f.html);
        return;
      }
      if(batchTexts.indexOf(f.text)>=0){
        if(f.turnId) renderedTurn=f.turnId; else turnRendered=true;
        return;
      }
      renderTextFrame(f);
    });
  }

  /* Track 3 Task 4: session controls — model, thinking level, permission
     mode, plan mode.
     The two lists are gated SEPARATELY, because they no longer arrive or
     fail together. A hibernating session now answers with the instance's
     provider catalogue for \`models\` and \`thinkingLevels: null\` (the engine's
     options() doc says why: a model switch made while asleep binds at the
     next wake and really works, a thinking switch does nothing at all). A
     single shared gate would therefore disable the picker that WORKS because
     of the one that does not — which is exactly the empty, dead model
     dropdown this fixes. */
  /* "up" is deliberately undecorated: a working choice should read as the
     plain default. The name is on the payload; the drawer read m.label, which
     no provider row sets, and every model listed as provider/id for months. */
  function modelOptionText(m){
    var text=(m&&m.name)||((m&&m.provider)+'/'+(m&&m.id));
    if(m&&m.availability==='on_demand') text+=' \\u2014 ${tJs("perch.modelOnDemand", lang)}';
    else if(m&&m.availability==='unavailable') text+=' \\u2014 ${tJs("perch.modelUnavailable", lang)}';
    return text;
  }

  /* One list, one answer: a non-empty array is usable, anything else (null,
     [], absent, a non-array) is not. THE gate for both pickers — an
     \`optionsUsable()\` that ANDed the two lists together lived here until fix
     round 1 Q5 found it was called by nothing but its own tests. */
  function listUsable(a){ return !!(Array.isArray(a)&&a.length); }

  /* Point the model select at the model the session is ACTUALLY on.

     Fix round 1 Q1: nothing ever assigned modelSel.value, so a populated
     select read whichever option sorted first and asserted a model the
     session had never been measured on — on the one control this feature
     exists for, answering "which model is this session running?" wrongly.
     The empty disabled select it replaced was unhelpful but honest.

     A key the list does not carry is still the truth (a provider row removed
     since the session started, or a model pi resolved on its own), so it is
     PREPENDED rather than dropped: selecting nothing at all would report the
     same "don't know" as before. */
  function selectCurrentModel(sel,current){
    if(!sel||!current) return;
    for(var i=0;i<sel.options.length;i++){
      if(sel.options[i].value===current){ sel.value=current; return; }
    }
    var opt=document.createElement('option');
    opt.value=current;
    opt.textContent=current+' \u2014 '+MODEL_CURRENT_UNLISTED;
    sel.insertBefore(opt,sel.firstChild);
    sel.value=current;
  }

  /* Populates #perch-model / #perch-thinking from GET .../options, or
     disables each rather than leaving an empty-but-enabled dropdown — that
     is what made a hibernating session look broken. */
  function renderOptions(o){
    var modelSel=el('perch-model'), thinkSel=el('perch-thinking');
    if(!modelSel||!thinkSel) return;
    clearEl(modelSel); clearEl(thinkSel);
    var models=(o&&listUsable(o.models))?o.models:null;
    var levels=(o&&listUsable(o.thinkingLevels))?o.thinkingLevels:null;
    if(models){
      /* Fix round 3 R1: "the bot's own model" is also the REVOCATION option
         in the session picker (it already means "choose nothing" in the
         launcher). Selecting it POSTs control {model:null}: the engine clears
         the explicit choice and NULLs the row, so the next wake re-resolves
         from the def. Without this, a legacy row stamped before the column
         meant "explicit choice" could never be un-pinned from the UI. */
      var none=document.createElement('option');
      none.value='';
      none.textContent=MODEL_BOT_RESOLVES;
      modelSel.appendChild(none);
    }
    if(models) models.forEach(function(m){
      var opt=document.createElement('option');
      opt.value=(m&&m.provider)+'/'+(m&&m.id);
      opt.textContent=modelOptionText(m);
      modelSel.appendChild(opt);
    });
    if(levels) levels.forEach(function(lv){
      var opt=document.createElement('option');
      opt.value=lv; opt.textContent=lv;
      thinkSel.appendChild(opt);
    });
    /* Each select is enabled iff ITS OWN list arrived — never an empty
       dropdown that looks like a broken page, and never a disabled one for a
       list that is right there. */
    modelSel.disabled=!models; thinkSel.disabled=!levels;
    if(models) selectCurrentModel(modelSel,o&&o.current);
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
    switchTab('chat');           /* D2: a session opens on the conversation, never on the tab the last one was left on */
    var modelSel=el('perch-model'), thinkSel=el('perch-thinking');
    if(modelSel){ clearEl(modelSel); modelSel.disabled=true; }
    if(thinkSel){ clearEl(thinkSel); thinkSel.disabled=true; }
    showSessionName(null);       /* the PREVIOUS session's name must not bleed in */
    var permSel=el('perch-permission'); if(permSel) permSel.value='guarded';
    var planCb=el('perch-plan-mode'); if(planCb) planCb.checked=false;
    var cwdEl=el('perch-session-cwd'); if(cwdEl) cwdEl.textContent='';   /* nor its directory */
    setTurnInFlight(false);      /* the PREVIOUS session's Steer/Stop state must not bleed in */
    turnRendered=false;          /* nor its "this turn already rendered" bookkeeping */
    renderedTurn=null;           /* nor the turn id that bookkeeping now keys on */
    /* Round 3 R4: nor its history seam — closed again until THIS session's
       batch lands, with any frames still parked in it. */
    histSettled=false;
    histBuf=[];
    pendingImages=[];            /* nor its queued-but-unsent image */
  }

  /* routes/perch-interactive-api.js:531-540 reads permission_mode and
     plan_mode in snake_case and SILENTLY DROPS any other key — an operator
     flipping the permission mode gets a 200 and nothing changes. Every other
     body in this file is camelCase JS; these two stay snake_case on purpose. */
  function controlBody(kind,value){
    if(kind==='model'){
      /* '' is the revocation sentinel — see renderOptions. The route maps a
         present-but-null model to "clear the explicit choice". */
      if(value==='') return {model:null};
      var i=value.indexOf('/');
      return {model:{provider:value.slice(0,i),id:value.slice(i+1)}};
    }
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
  /* Which turn the transcript has already rendered text for.

     Fix round 2 N1: the previous version of this was a BOOLEAN reset on the
     false->true turnInFlight transition, and it survived a stream teardown. A
     reconnect that missed the separating turnInFlight:false frame — a 2s blip
     inside the client's own backoff, with turn 1 ending and turn 2 running
     inside it — therefore left the flag stale-true and suppressed turn 2's
     reply entirely. The engine's replay-on-subscribe does NOT close that: the
     replayed frame is turnInFlight:true and the client is already true, so
     there is no transition and no reset. Measured: turn 2's answer never
     rendered at all, which is worse than the duplicate the flag exists to
     prevent.

     Identity, not memory, is the fix: the frames now carry the turn they
     belong to, so \`reply\` judges its OWN turn. A cross-turn reconnect sees a
     different id and renders; a SAME-turn reconnect sees the same id and stays
     suppressed. The bare alternative — resetting the flag in openStream() —
     fixes the first case by reintroducing the second, and that trade is the
     reason this is a turn id instead. */
  var renderedTurn=null;
  /* The fallback for a frame that carries NO turn id (the child speaking
     outside a turn, or a gateway older than this script). Same transition-reset
     rule as before, and the same reason for it: several turnInFlight:true
     frames land inside one turn. */
  var turnRendered=false;
  function setTurnInFlight(flag){
    var next=!!flag;
    /* Reset on the false->TRUE TRANSITION only. stateEvent() is emitted for
       model_select, ask_user and aborts as well as turn start, so several
       frames carrying turnInFlight:true can land between the first \`text\` and
       the \`reply\` — resetting on every true frame would put the duplicate
       straight back. */
    if(next&&!turnInFlight) turnRendered=false;
    turnInFlight=next;
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
    var body={message:text};
    /* routes/perch-interactive-api.js's normalizeMessageImages reads
       body.images on /message only — /steer never looks at it, so attaching
       here regardless of path is harmless on a steer. Cleared immediately,
       matching the textarea's own discipline: a failed send still consumes
       the queue, and re-attaching is one tap away. */
    if(pendingImages.length) body.images=pendingImages;
    pendingImages=[];
    perchApi('POST',sendPath(mySid,turnInFlight),body).then(function(r){
      if(current.sid!==mySid) return;
      if(r.status===409){ setTurnInFlight(true); return; }   /* raced a turn start */
      if(!r.ok) appendNote((r.j&&r.j.error)||SEND_FAILED);
    });
  }

  /* ask_user cards. The real card shape (perch-interactive.js:222) uses \`method\` as the
     discriminator (select|input|confirm|editor, never \`kind\`), \`options\`
     as plain strings (never {value,label}), and answer() is a tri-state —
     cancelled first, then confirmed for a confirm card, else value. A
     confirm card answered with value reads at the engine as confirmed:false,
     which would silently DENY a permission prompt while looking approved. */
  function askOptions(card){
    if(!card||!card.requestId) return [];
    return Array.isArray(card.options)?card.options.slice():[];
  }

  /* renderAsk already branches on card.method (confirm/select handled above
     the call site, everything else falls to the input/editor branch below),
     so this carries only the two fields that branch actually reads. */
  function askFields(card){
    return {
      initial: (card&&card.prefill!=null)?String(card.prefill):'',
      placeholder: (card&&card.placeholder!=null)?String(card.placeholder):''
    };
  }

  /* Mirrors engine.answer's tri-state (perch-interactive.js:1904). cancelled
     is checked first there, so it is checked first here. A confirm card MUST
     answer with confirmed: sending value on one reads as a denial. */
  function answerPayloadFor(card,choice){
    var out={requestId:card.requestId};
    if(choice&&choice.cancelled){ out.cancelled=true; return out; }
    if(card.method==='confirm'){ out.confirmed=!!(choice&&choice.confirm); return out; }
    out.value=String(choice&&choice.value!=null?choice.value:'');
    return out;
  }

  /* Every continuation here carries the same mySid guard as the rest of the
     file: an answer that resolves after the operator has moved on must not
     write into the new session's pane. A 409 no_such_request means the card
     was already answered or the child died — clear the pane and say so
     rather than leaving a dead card on screen. */
  function answerAsk(card,choice){
    var mySid=current.sid;
    return perchApi('POST','/interactive/'+encodeURIComponent(mySid)+'/answer',
                    answerPayloadFor(card,choice)).then(function(r){
      if(current.sid!==mySid) return;
      clearEl(el('perch-ask'));
      if(r.status===409) appendNote(ASK_STALE);
    });
  }

  /* Writes into #perch-ask, which sits ABOVE the sticky composer: an
     ask_user frame blocks the turn until answered, so it must not be
     scrollable past inside the transcript. Built with createElement/
     textContent only — never innerHTML. */
  function renderAsk(card){
    var pane=el('perch-ask'); if(!pane) return;
    clearEl(pane);
    if(!card||!card.requestId) return;
    var frame=document.createElement('div'); frame.className='ask-card';
    if(card.title) frame.appendChild(line('ask-title',card.title));
    if(card.message) frame.appendChild(line('ask-message',card.message));

    var controls=document.createElement('div'); controls.className='ask-controls';

    if(card.method==='confirm'){
      var yes=document.createElement('button'); yes.type='button'; yes.textContent=ASK_CONFIRM;
      yes.onclick=function(){ answerAsk(card,{confirm:true}); };
      var no=document.createElement('button'); no.type='button'; no.textContent=ASK_DENY;
      no.onclick=function(){ answerAsk(card,{confirm:false}); };
      controls.appendChild(yes); controls.appendChild(no);
    } else if(card.method==='select'){
      /* options is an array of plain strings (cardFrom() does options.slice()
         on whatever pi sent) — never {value,label}. */
      askOptions(card).forEach(function(opt){
        var b=document.createElement('button'); b.type='button'; b.textContent=opt;
        b.onclick=function(){ answerAsk(card,{value:opt}); };
        controls.appendChild(b);
      });
    } else {
      var fields=askFields(card);
      var field=card.method==='editor'?document.createElement('textarea'):document.createElement('input');
      if(card.method!=='editor') field.type='text';
      field.value=fields.initial;
      field.placeholder=fields.placeholder;
      var submit=document.createElement('button'); submit.type='button'; submit.textContent=ASK_SUBMIT;
      submit.onclick=function(){ answerAsk(card,{value:field.value}); };
      controls.appendChild(field); controls.appendChild(submit);
    }

    /* Every card gets a cancel: without it, a card whose options do not fit
       the situation blocks the turn with no way out. */
    var cancel=document.createElement('button'); cancel.type='button'; cancel.textContent=ASK_CANCEL;
    cancel.onclick=function(){ answerAsk(card,{cancelled:true}); };
    controls.appendChild(cancel);

    frame.appendChild(controls);
    pane.appendChild(frame);
  }

  function attachFile(file){
    var mySid=current.sid;
    var isImage=/^image\\//.test(file.type);
    var reader=new FileReader();
    reader.onload=function(){
      /* result is "data:<mime>;base64,<payload>" — the route wants the payload. */
      var b64=String(reader.result||'').split(',')[1]||'';
      perchApi('POST','/interactive/'+encodeURIComponent(mySid)+'/files',
               {name:file.name,data_b64:b64}).then(function(r){
        if(current.sid!==mySid) return;
        if(r.ok){
          /* Queued onto send()'s pendingImages, in pi's wire shape
             {mime,data_b64} — an upload that isn't an image has nothing to
             queue: the model reads images, not arbitrary files. */
          if(isImage) pendingImages.push({mime:file.type,data_b64:b64});
          appendNote(FILE_QUEUED);
        } else {
          appendNote((r.j&&r.j.error)||FILE_FAILED);
        }
      });
    };
    reader.readAsDataURL(file);        /* 5 MB post-decode cap, route-side */
  }

  var attachBtn=el('perch-attach'), fileInput=el('perch-file-input');
  if(attachBtn&&fileInput){
    attachBtn.onclick=function(){ fileInput.click(); };
    fileInput.onchange=function(){
      if(fileInput.files&&fileInput.files[0]) attachFile(fileInput.files[0]);
      fileInput.value='';
    };
  }

  /* Carried-over fix: send(), closeSession() and the abort path were all
     written by an earlier task but never connected to the DOM — the chat
     view rendered and Send did nothing. #perch-back sets location.hash=''
     rather than calling closeSession() directly, so applyHash -> hashchange
     -> closeSession runs and browser history stays correct. */
  el('perch-send').onclick=send;
  el('perch-back').onclick=function(){ location.hash=''; };
  function abortTurn(){
    if(!current.sid) return;
    perchApi('POST','/interactive/'+encodeURIComponent(current.sid)+'/abort');
  }
  el('perch-abort').onclick=abortTurn;
  el('perch-close').onclick=function(){ stopSession(current.sid); };
  el('perch-rename').onclick=function(){
    var known=rowIndex[current.sid];
    renameSession(current.sid,(known&&known.label)||'');
  };

  /* ---- Phase D2: the tab surface ----------------------------------------
     Tab state is a plain variable, reset to 'chat' on every session open
     (resetControls). Switching is PURE VISIBILITY TOGGLING — it must never
     touch the EventSource, openStream, closeSession or any SSE lifecycle
     (review S6): the stream belongs to the SESSION, not to the tab, and a
     tab tap that reopened a stream would drop frames mid-turn. Deliberately
     NOT in the hash: the hash is the session router (#<sid> deep links);
     '#<sid>:<tab>' would fight every parseHash guard in this file for a
     convenience nobody deep-links to. */
  var TAB_NAMES=['chat','session','files','activity'];
  var tab='chat';
  function switchTab(name){
    if(TAB_NAMES.indexOf(name)<0) name='chat';
    tab=name;
    TAB_NAMES.forEach(function(nm){
      var sec=el('perch-tab-'+nm), btn=el('perch-tab-btn-'+nm);
      if(sec) sec.hidden=(nm!==name);
      if(btn) btn.setAttribute('aria-selected',nm===name?'true':'false');
    });
    /* Files fetches on ACTIVATION, never on session open (D3) — the chat
       fast path stays one less round trip. The typeof guard is temporary:
       D3 lands loadFiles in the very next step. */
    if(name==='files'&&typeof loadFiles==='function') loadFiles();
  }
  TAB_NAMES.forEach(function(nm){
    var btn=el('perch-tab-btn-'+nm);
    if(btn) btn.onclick=function(){ switchTab(nm); };
  });

  /* Session tab: "Change directory" reopens the SAME browse modal the
     launcher uses (one picker, two callers) and POSTs control({cwd}). The
     engine refuses mid-turn (409) and hibernates an awake child on accept —
     the modal's hint line says so BEFORE the operator chooses, and the
     hibernate's own log frame lands in the Activity rail. */
  var changeCwdBtn=el('perch-change-cwd');
  if(changeCwdBtn) changeCwdBtn.onclick=function(){
    if(!current.sid) return;
    var mySid=current.sid;
    openBrowseModal({
      initial:launchCwdInitial(),
      note:CWD_CHANGE_NOTE,
      onChoose:function(p){
        perchApi('POST','/interactive/'+encodeURIComponent(mySid)+'/control',{cwd:p}).then(function(r){
          if(current.sid!==mySid) return;
          var cwdEl=el('perch-session-cwd');
          if(r.ok){
            /* Optimistic write; the next state frame carries the engine's
               own record and overwrites this with the truth. */
            if(cwdEl) cwdEl.textContent=p;
            return;
          }
          if(r.status===409&&r.j&&r.j.error==='turn_in_progress'){ appendNote(CWD_BUSY); return; }
          if(r.status===400){ appendNote(CWD_INVALID); return; }
          appendNote((r.j&&r.j.error)||CWD_CHANGE_FAILED);
        });
      }
    });
  };
  /* The picker starts where the session is. The readout doubles as the
     source (textContent, set only from state frames) because there is no
     other client-side copy of cwd; the placeholder text means "default" and
     must not ride into the picker as a path. */
  function launchCwdInitial(){
    var cwdEl=el('perch-session-cwd');
    var shown=cwdEl?String(cwdEl.textContent||''):'';
    return (shown&&shown!==CWD_DEFAULT_TEXT)?shown:'';
  }

  /* iOS does not shrink the layout viewport for the keyboard, so dvh alone
     leaves the composer behind it. Offset the chat column by the hidden part. */
  if(window.visualViewport){
    var vv=window.visualViewport;
    var applyVV=function(){
      if(!live()) return;
      var hidden=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
      el('perch-chat').style.paddingBottom=hidden?hidden+'px':'';
    };
    bindOnce(vv,'resize','vvResize',applyVV);
    bindOnce(vv,'scroll','vvScroll',applyVV);
  }

  /* BOOTSTRAP — a hashchange event fires only on a LATER change to the hash;
     it never fires for the page's own initial load. Without this line, every
     direct load of this page — the /perch short link, a bookmarked #<sid>
     URL, a plain refresh — sits on the static "Loading sessions…" shell
     forever, because nothing else calls applyHash() or loadList() on first
     paint. parseHash being exhaustively unit-tested does not help: it is a
     pure function and it was green throughout. */
  if(parseHash(location.hash)) applyHash();
  else { startListPolling(); loadList(); }
})();`;
}
