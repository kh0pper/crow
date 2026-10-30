import { tJs } from "../shared/i18n.js";
import { PERCH_SPLIT_MIN_WIDTH } from "./css.js";
import { perchPhoneCardJs } from "./phone-card.js";
import { perchArtifactCardJs } from "./artifact-card.js";
import { perchCardChipJs } from "./card-chip.js";
import { perchBriefingJs } from "./briefing-card.js";
import { sessionCardsJs } from "../shared/session-cards.js";
import { perchDictationJs } from "./dictation.js";
import { perchBrowserTileJs } from "./browser-tile.js";
import { perchBrowserFloatJs } from "./browser-float.js";
import { perchTakeOverJs } from "./take-over.js";
import { textSizeRuntimeJs, TEXT_SIZES, TEXT_SIZE_DEFAULT } from "../shared/text-size.js";

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
     transcript Casey pasted (every streamed element ×6, his message ×1).

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
    stopListPolling(); cancelReconnect(); stopWatchdog(); closeStream(); stopIdentRefresh();
    /* The keyboard flag belongs to this instance's chat (applyVV). */
    if(document.body&&typeof document.body.removeAttribute==='function') document.body.removeAttribute('data-perch-kb');
    /* The artifact viewer pane holds a document keydown listener while open
       (artifact-card.js): leaving the hub with it open must not strand it. */
    closeArtifactPane();
    /* Composer dictation (dictation.js): a Turbo visit releases the mic. */
    dictationCancel();
    /* Queue item 23a: no history retry fires from a retired instance, and
       any load still in flight is stale (live() already covers it; the
       token makes it explicit). */
    cancelHistRetry(); histGen++;
    /* Live browser tile: every frame poller aborts, the observer disconnects. */
    retireBrowserTiles();
    /* R1.2 PR 5: the app tiles go too, and with them the browser tile's
       password row (its revealed password and re-auth callback are wiped). */
    resetAppTiles();
    /* The Take over sheet closes with the page; the operator keeps the
       browser until Hand back or the 5-minute heartbeat loss. */
    closeTakeOver();
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

  /* SESSIONS COLUMN COLLAPSE (desktop, 2026-10-20). At and above the split
     breakpoint the operator can hide the session list while a chat is open
     (#perch-list-collapse) and bring it back (#perch-list-reveal, first in
     the chat head): the shell sidebar's pair (layout.js setSidebarCollapsed /
     focusSidebarControl). The rules live in sessions-collapse-css.js and only
     apply wide + chat-open, so the phone is untouched and closing the last
     session brings the list straight back without forgetting the choice.
     Read and applied HERE, at the top, before applyHash() can open a session
     and ask listOnScreen() whether to poll: a direct #sid load must not poll a
     list it is about to hide. Web Storage can throw (private window, blocked
     site data), so every access is guarded. No document or window listener:
     the buttons use onclick slots, which Turbo replaces with the elements. */
  function readCollapsed(){
    try{ return window.localStorage.getItem('crow-perch-sessions-collapsed')==='1'; }
    catch(e){ return false; }
  }
  var sessionsCollapsed=readCollapsed();
  function applySessionsCollapsed(){
    var root=el('perch-hub-root'); if(root) setToken(root,'sessions-collapsed',sessionsCollapsed);
    var ids=['perch-list-collapse','perch-list-reveal'];
    for(var i=0;i<ids.length;i++){
      var b=el(ids[i]); if(b) b.setAttribute('aria-expanded',sessionsCollapsed?'false':'true');
    }
  }
  /* Focus-neutral, like setSidebarCollapsed: only a user gesture moves focus. */
  function setSessionsCollapsed(on){
    sessionsCollapsed=!!on;
    try{ window.localStorage.setItem('crow-perch-sessions-collapsed',sessionsCollapsed?'1':'0'); }catch(e){}
    applySessionsCollapsed();
    syncListPolling();            /* hidden: stop polling; revealed: poll + load now */
  }
  /* The button that was pressed is about to vanish (display:none blurs it and
     focus falls back to body), so hand focus to the one that is live after
     the change. The class goes on FIRST: focus() on a still-hidden reveal
     button is a no-op. */
  function toggleSessions(){
    setSessionsCollapsed(!sessionsCollapsed);
    var next=el(sessionsCollapsed?'perch-list-reveal':'perch-list-collapse');
    if(next&&next.focus) next.focus();
  }
  applySessionsCollapsed();
  (function(){
    var c=el('perch-list-collapse'), r=el('perch-list-reveal');
    if(c) c.onclick=toggleSessions;
    if(r) r.onclick=toggleSessions;
  })();

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

  /* Wave 1: one-tap copy, ported from pi-lab's behaviour verbatim — a ✓
     flash for 1.2s, execCommand fallback for non-secure contexts
     (navigator.clipboard is undefined there; the dashboard can be served
     over plain http on the LAN). typeof-guarded for the vm test harness,
     which has no navigator at all. */
  function copyText(text,btn){
    var flash=function(){
      if(!btn) return;
      var orig=btn.textContent;
      btn.textContent='\\u2713';
      if(btn.classList) btn.classList.add('copied');
      setTimeout(function(){
        btn.textContent=orig;
        if(btn.classList) btn.classList.remove('copied');
      },1200);
    };
    if(typeof navigator!=='undefined'&&navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(String(text==null?'':text)).then(flash,function(){});
      return;
    }
    try{
      var ta=document.createElement('textarea');
      ta.value=String(text==null?'':text);
      ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      flash();
      document.body.removeChild(ta);
    }catch(e){}
  }

  /* Wave 1: every server-rendered code fence gets a copy button. The
     wrapper is minted HERE (client-side DOM surgery, never innerHTML): the
     button must be a SIBLING of the <pre>, not a child, or its own glyph
     pollutes pre.textContent — the copy source. Guarded on querySelectorAll
     because vm-harness elements do not carry it; the live CDP test measures
     the real thing. */
  function enhancePres(what){
    if(!what.querySelectorAll) return;
    var pres=what.querySelectorAll('pre');
    for(var i=0;i<pres.length;i++){
      var pre=pres[i];
      if(!pre.parentNode||pre.parentNode.className==='prewrap') continue;
      var wrap=document.createElement('div'); wrap.className='prewrap';
      pre.parentNode.insertBefore(wrap,pre);
      wrap.appendChild(pre);
      var b=document.createElement('button'); b.type='button'; b.className='copy-pre';
      b.textContent='\\u29c9'; b.setAttribute('aria-label',COPY_CODE_LABEL);
      b.onclick=(function(p,btn){ return function(){ copyText(p.textContent,btn); }; })(pre,b);
      wrap.appendChild(b);
    }
  }

  /* Design quick win 1: the row label is resolved HERE, in one place. A bot
     turn reads as the bot's display name (from showHeader, which always runs
     before the stream opens or history loads); the operator's own turn has no
     visible label (the boxed row reads as theirs) but keeps a visually hidden
     "You:" for screen readers. Any other role keeps its raw text. */
  function rowLabel(cls,who){
    if(cls==='user') return YOU_LABEL;
    if(who==='bot'||who==='assistant') return current.botName||current.botId||who;
    return who;
  }
  /* \`html\` is optional and server-rendered; without it this is byte-for-byte
     the old textContent behaviour. */
  function appendMessage(cls,who,text,html,ts){
    var tr=el('perch-transcript'); if(!tr) return;
    var row=document.createElement('div'); row.className='entry '+cls;
    /* Review L9: history rows carry their time so a reloaded feedback card
       can sit where its round was delivered (artifact-card.js fbPlace). */
    if(ts&&isFinite(ts)) row.setAttribute('data-ts',String(ts));
    row.appendChild(line(cls==='user'?'who vh':'who',rowLabel(cls,who)));
    if(html&&typeof html==='string'){
      var what=document.createElement('div');
      what.className='what md';
      setSanitizedHtml(what,html);
      enhancePres(what);                     /* Wave 1: copy buttons on fences */
      row.appendChild(what);
    } else {
      row.appendChild(line('what',text));   /* textContent, never innerHTML */
    }
    /* Wave 1: every BOT row is one tap from the clipboard — and the copy
       source is the RAW text (the markdown the model wrote), never the
       rendered DOM's textContent, which has lost the fences and links. */
    if(cls==='bot'){
      var cp=document.createElement('button'); cp.type='button'; cp.className='copy-msg';
      cp.textContent='\\u29c9'; cp.setAttribute('aria-label',COPY_MSG_LABEL);
      cp.onclick=(function(t,btn){ return function(){ copyText(t,btn); }; })(text,cp);
      row.appendChild(cp);
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
  /* Queue item 23a: a failed history load is retried ONCE, and only when a
     second try can answer differently — a dropped connection (status 0) or a
     5xx (a proxy 502 while the backend restarts). A 404 is deterministic: no
     such session, or a deleted bot; a session with no turn yet answers an
     empty 200, and this script is served by the same gateway as the route,
     so no older route answers it. An auth or client error will not fix
     itself in 1.5 s. A real restart is covered by the reconnect's resync. */
  function historyRetryable(status){ return status===0||(status>=500&&status<=599); }
  /* The Activity rail line for a failed history load. Only a short,
     code-shaped error is printed, never free text (an errno message carries
     a host path). A logged-out load follows the login redirect and arrives
     as a 200 that is not JSON, which "HTTP 200" alone would not explain. */
  function histFailLine(r,attempt){
    var st=r&&r.status, j=r&&r.j;
    var code=(j&&typeof j.error==='string'&&/^[a-z0-9_]{1,40}$/.test(j.error))?j.error:'';
    return 'history: '+(st?'HTTP '+st:'network')+(code?' '+code:'')+((r&&r.ok&&!j)?' (not JSON)':'')+
      ((!attempt&&historyRetryable(st))?' (retrying)':'');
  }

  /* One row per live session, plus one per attached bot with none. A bot with
     no perch gateway record is omitted: POST /bots/<id>/interactive 403s. */
  /* Shell P2: scope is the Chat tab's data-scope ("all", "unassigned" or a
     project id); a session outside it is not a row here. null (classic Perch)
     and "all" keep every session. A bot whose sessions are all elsewhere
     keeps its idle row, so it stays startable from this view. */
  function listRows(roost,scope){
    var birds=(roost&&roost.birds)||[];
    var out=[];
    birds.forEach(function(b){
      if(!b||!b.perch_attached) return;
      var ss=b.sessions||[];
      if(!ss.length){ out.push({botId:b.id,botName:b.name,sessionId:null,state:'idle',cardId:null,pendingUi:false}); return; }
      var running=ss.filter(function(x){ return x&&x.state!=='stopped'; });
      var live=running.filter(function(x){
        if(scope==null||scope==='all') return true;
        var p=x.projectId==null?null:Number(x.projectId);
        return scope==='unassigned'?p===null:p===Number(scope);
      });
      /* A bot whose live sessions are all in other projects is NOT idle: its
         startable row carries no state rather than a false "idle". */
      if(!live.length){ out.push({botId:b.id,botName:b.name,sessionId:null,state:running.length?'':'idle',cardId:null,pendingUi:false}); return; }
      live.forEach(function(s){
        out.push({botId:b.id,botName:b.name,sessionId:s.sessionId,state:s.state,
                  cardId:s.cardId==null?null:s.cardId,pendingUi:!!s.pendingUi,
                  /* /roost carries the operator's name alongside the id
                     (routes/perch.js) — null when there isn't one. */
                  label:(s.label==null||s.label==='')?null:String(s.label),
                  projectId:s.projectId==null?null:Number(s.projectId),
                  lastActivityAt:(typeof s.lastActivityAt==='string'&&s.lastActivityAt)?s.lastActivityAt:null});
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
     is the state Casey reported with no way to start a ninth. Same filter as
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
  /* Shell P2: the Chat tab's scope, written by html.js only in the new shell.
     null is classic Perch: no filter, no project on a spawn. */
  var SCOPE=(function(){
    var r=el('perch-hub-root');
    var v=(r&&r.getAttribute)?r.getAttribute('data-scope'):null;
    return (v==='all'||v==='unassigned'||/^[1-9][0-9]*$/.test(String(v)))?String(v):null;
  })();
  /* What a new session in this view is filed under: the project, "unassigned"
     in the Unassigned view, and nothing (the bot's own project) otherwise. */
  function scopeProject(){
    if(SCOPE==='unassigned') return 'unassigned';
    if(SCOPE&&/^[1-9][0-9]*$/.test(SCOPE)) return Number(SCOPE);
    return null;
  }
  var NO_SESSIONS='${tJs("perch.noSessions", lang)}';
  var WAITING_ON_YOU='${tJs("perch.waitingOnYou", lang)}';
  var OPEN_LABEL='${tJs("perch.open", lang)}';
  var TALK_LABEL='${tJs("perch.talk", lang)}';
  var YOU_LABEL='${tJs("perch.you", lang)}';
  var START_FAILED='${tJs("perch.startFailed", lang)}';
  var NOT_ATTACHED='${tJs("perch.notAttached", lang)}';
  var ENGINE_REQUIRED='${tJs("perch.engineRequired", lang)}';

  /* Interpolated at emit time. tJs escapes quotes, backticks and \${, so these
     are safe inside single-quoted literals. */
  var SESSION_GONE='${tJs("perch.sessionGone", lang)}';
  var SEND_FAILED='${tJs("perch.sendFailed", lang)}';
  var DRAFT_MAYBE_SENT='${tJs("perch.draftMaybeSent", lang)}';
  var BOT_START_FAILED='${tJs("perch.botStartFailed", lang)}';
  var TURN_FAILED='${tJs("perch.turnFailed", lang)}';
  var FILE_QUEUED='${tJs("perch.fileQueued", lang)}';
  var FILE_FAILED='${tJs("perch.fileFailed", lang)}';
  var NO_TRANSCRIPT='${tJs("perch.noTranscript", lang)}';
  var TRANSCRIPT_FAILED='${tJs("perch.transcriptFailed", lang)}';
  var RECONNECTING='${tJs("perch.reconnecting", lang)}';
  var ASK_STALE='${tJs("perch.askStale", lang)}';
  var ASK_EXPIRED='${tJs("perch.askExpired", lang)}';
  var STEER_LABEL='${tJs("perch.steer", lang)}';
  var SEND_LABEL='${tJs("perch.send", lang)}';
  var ASK_CONFIRM='${tJs("perch.askConfirm", lang)}';
  var ASK_DENY='${tJs("perch.askDeny", lang)}';
  var ASK_CANCEL='${tJs("perch.askCancel", lang)}';
  var ASK_SUBMIT='${tJs("perch.askSubmit", lang)}';
  /* PR-A: the combined multi-question ask card's own strings. */
  var ASK_SEND_ANSWERS='${tJs("perch.askSendAnswers", lang)}';
  var ASK_SEND_ANSWER='${tJs("perch.askSendAnswer", lang)}';
  var ASK_SENDING='${tJs("perch.askSending", lang)}';
  var ASK_MULTI_HINT='${tJs("perch.askMultiHint", lang)}';
  var ASK_OTHER_PH='${tJs("perch.askOtherPlaceholder", lang)}';
  var NO_ATTACHED_BOTS='${tJs("perch.noAttachedBots", lang)}';
  var MODEL_BOT_DEFAULT='${tJs("perch.modelBotDefault", lang)}';
  var MODEL_BOT_RESOLVES='${tJs("perch.modelBotResolves", lang)}';
  var MODEL_CURRENT_UNLISTED='${tJs("perch.modelCurrentUnlisted", lang)}';
  var MODEL_GROUP_NETWORK='${tJs("perch.modelGroupNetwork", lang)}';
  var MODEL_GROUP_CLOUD='${tJs("perch.modelGroupCloud", lang)}';
  var MODEL_GROUP_UNAVAILABLE='${tJs("perch.modelGroupUnavailable", lang)}';
  var MODEL_SHOW_UNAVAILABLE='${tJs("perch.modelShowUnavailable", lang)}';
  var MODEL_HIDE_UNAVAILABLE='${tJs("perch.modelHideUnavailable", lang)}';
  var LAUNCH_MODEL_FAILED='${tJs("perch.launchModelFailed", lang)}';
  var CLOSE_LABEL='${tJs("perch.close", lang)}';
  /* QW2: the row's one action menu. */
  var ROW_ACTIONS='${tJs("perch.rowActions", lang)}';
  var CLOSE_CONFIRM='${tJs("perch.closeConfirm", lang)}';
  var CLOSE_FAILED='${tJs("perch.closeFailed", lang)}';
  var CLOSE_FAILED_FOR='${tJs("perch.closeFailedFor", lang)}';
  var ROW_CARD='${tJs("perch.rowCard", lang)}';
  var RENAME_LABEL='${tJs("perch.rename", lang)}';
  var RENAME_PROMPT='${tJs("perch.renamePrompt", lang)}';
  var RENAME_FAILED='${tJs("perch.renameFailed", lang)}';
  /* PR-C (audit item 14): session archive — a roster action, never an engine
     one (an archived live child keeps running; it just leaves the list). */
  var ARCHIVE_LABEL='${tJs("perch.archive", lang)}';
  var ARCHIVE_FAILED='${tJs("perch.archiveFailed", lang)}';
  var UNARCHIVE_LABEL='${tJs("perch.unarchive", lang)}';
  var UNARCHIVE_FAILED='${tJs("perch.unarchiveFailed", lang)}';
  var ARCHIVED_LABEL='${tJs("perch.archived", lang)}';
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
  /* Phase D3: the Files tab. */
  var FILES_EMPTY='${tJs("perch.filesEmpty", lang)}';
  var FILES_FAILED='${tJs("perch.filesFailed", lang)}';
  /* PR-B (item 18): the Files tab's read-only cwd browser + text viewer. */
  var FILES_CWD_EMPTY='${tJs("perch.filesCwdEmpty", lang)}';
  var FILES_CWD_FAILED='${tJs("perch.filesCwdFailed", lang)}';
  var FILES_NO_CWD='${tJs("perch.filesNoCwd", lang)}';
  var FILES_VIEWER_FAILED='${tJs("perch.filesViewerFailed", lang)}';
  var FILES_VIEWER_UNSUPPORTED='${tJs("perch.filesViewerUnsupported", lang)}';
  var FILES_VIEWER_TRUNCATED='${tJs("perch.filesViewerTruncated", lang)}';
  /* Wave 1: copy buttons + non-image upload path injection. */
  var COPY_MSG_LABEL='${tJs("perch.copyMessage", lang)}';
  var COPY_CODE_LABEL='${tJs("perch.copyCode", lang)}';
  var FILE_QUEUED_PATH='${tJs("perch.fileQueuedPath", lang)}';
  var UPLOADED_HEADER='${tJs("perch.uploadedHeader", lang)}';
  /* Wave 2/3: facts card, plan checklist, tool chips, slash menu. */
  var PLAN_HEAD='${tJs("perch.planProgress", lang)}';
  var TOOL_RUNNING='${tJs("perch.toolRunning", lang)}';
  var TOOL_DONE='${tJs("perch.toolDone", lang)}';
  var TOOL_FAILED='${tJs("perch.toolFailed", lang)}';
  /* R1.2 PR 2: the "See what happened" line (new mode only). */
  var TG_S={ see:'${tJs("perch.toolGroupSee", lang)}', running:TOOL_RUNNING,
    step:'${tJs("perch.toolGroupStep", lang)}', steps:'${tJs("perch.toolGroupSteps", lang)}',
    failedOne:'${tJs("perch.toolGroupFailedOne", lang)}', failed:'${tJs("perch.toolGroupFailed", lang)}' };
  var COMMANDS_HIBERNATING='${tJs("perch.commandsHibernating", lang)}';
  /* PR-E (item 12): the chat's inline sent-file cards. */
  var FILE_DOWNLOAD='${tJs("perch.fileDownload", lang)}';
  var FILE_NOT_SERVABLE='${tJs("perch.fileNotServable", lang)}';

  /* Row identity. One bot with eight sessions renders eight rows that read
     "R4 Assistant / awake" and nothing else — measured verbatim in a browser
     as "R4AssistantawakeOpenCloseR4Assistant..." — so telling the mistakes
     from the real work meant Open, read the meta, Back, once per candidate,
     each pass sitting on top of an irreversible Close. Open is recoverable;
     Close is not, which is what makes identity load-bearing here rather than
     decorative. The engine mints "perchlive-" + 8 hex, so the hex alone is
     the short, unambiguous handle.
     QW2: the handle is shown only where it is NEEDED — when the row's
     visible text (bot, name, card) matches another row's in the same list.
     renderList decides (rowCollisions) and passes the verdict in; a named or
     carded row reads as itself without hex. */
  function shortSid(sid){ return String(sid==null?'':sid).replace(/^perchlive-/,''); }
  function rowSubtitle(r,showId){
    if(!r) return '';
    var parts=[r.pendingUi?WAITING_ON_YOU:r.state];
    if(showId&&r.sessionId) parts.push(shortSid(r.sessionId));
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

  /* QW2: which session rows would read the same as another row in the SAME
     list (live rows and archived rows are compared separately — they sit in
     different sections). The key is what the operator actually sees: bot,
     name, card. The state word is deliberately left out: it flickers between
     polls, and the id appearing and vanishing with it would be noise. */
  function rowCollisions(list,cardOf){
    var counts={}, keys={};
    (list||[]).forEach(function(r){
      if(!r||!r.sessionId) return;
      var k=[r.botName||r.botId||'',r.label||'',cardOf(r)].join('\\u0000');
      keys[r.sessionId]=k; counts[k]=(counts[k]||0)+1;
    });
    var out={};
    for(var sid in keys) out[sid]=counts[keys[sid]]>1;
    return out;
  }

  /* ---- QW2: the row's ⋯ menu ------------------------------------------
     Rename / Archive / Close moved off the row into one menu, opened INLINE
     below its row (the list body scrolls; a popover would clip). "Is a menu
     open" is read from the DOM every time, never kept in a variable:
     showListNote() clears the body on any failure, and a flag that outlived
     its menu would freeze the list for good. */
  var menuSeq=0;
  function hasClass(n,c){ return !!n&&String(n.className||'').split(' ').indexOf(c)>=0; }
  /* Depth-first search of a (small) list subtree. */
  function findIn(node,pred){
    var kids=(node&&node.children)||[];
    for(var i=0;i<kids.length;i++){
      if(pred(kids[i])) return kids[i];
      var hit=findIn(kids[i],pred); if(hit) return hit;
    }
    return null;
  }
  function openRowMenu(){
    return findIn(el('perch-list-body'),function(c){ return !c.hidden&&hasClass(c,'roost-menu'); });
  }
  function focusEl(n){ if(n&&n.focus) n.focus({preventScroll:true}); }
  /* keepDeferred: switching straight to another row's menu must not redraw
     the list (and with it the menu being opened) in between. */
  function setRowMenu(menu,open,refocus,keepDeferred){
    if(!menu) return;
    menu.hidden=!open;
    var trig=menu.__trigger;
    if(trig) trig.setAttribute('aria-expanded',open?'true':'false');
    if(open){ focusEl(menu.__items[0]); return; }
    if(refocus) focusEl(trig);
    /* A poll that arrived while the menu was open was parked; draw it now. */
    if(deferredList&&!keepDeferred){ var d=deferredList; deferredList=null; renderList(d.rows,d.archived); }
  }
  function closeRowMenu(refocus){ var m=openRowMenu(); if(m) setRowMenu(m,false,refocus); }

  function buildRowMenu(row,sid,actions){
    var more=document.createElement('button');
    more.type='button'; more.className='roost-more'; more.textContent='\\u22ef';
    more.setAttribute('data-sid',sid);
    more.setAttribute('aria-haspopup','menu');
    more.setAttribute('aria-expanded','false');
    /* A FUNCTION replacement: the label is operator text, and a string
       replacement would expand $& / $' inside it. */
    more.setAttribute('aria-label',ROW_ACTIONS.replace('{session}',function(){ return sessionLabel(sid); }));
    var menu=document.createElement('div');
    menu.className='roost-menu'; menu.id='roost-menu-'+(++menuSeq);
    menu.setAttribute('role','menu'); menu.hidden=true;
    more.setAttribute('aria-controls',menu.id);
    var items=[];
    actions.forEach(function(a){
      var it=document.createElement('button');
      it.type='button'; it.className=a.cls; it.textContent=a.label;
      it.setAttribute('role','menuitem'); it.setAttribute('tabindex','-1');
      /* Close and hand focus back BEFORE the action: prompt()/confirm()
         return focus to whatever had it, and that must be the trigger, not a
         menu that no longer exists. */
      it.onclick=function(){ setRowMenu(menu,false,true); a.run(); };
      items.push(it); menu.appendChild(it);
    });
    menu.__trigger=more; menu.__items=items;
    more.onclick=function(){
      var open=menu.hidden;
      if(open){ var other=openRowMenu(); if(other&&other!==menu) setRowMenu(other,false,false,true); }
      setRowMenu(menu,open,!open);
    };
    /* Enter and Space are the button's own click (which opens and focuses
       the first item); ArrowDown is the menu-button extra. */
    more.onkeydown=function(ev){
      if(!ev||ev.key!=='ArrowDown') return;
      if(ev.preventDefault) ev.preventDefault();
      if(menu.hidden) more.onclick(); else focusEl(items[0]);
    };
    menu.onkeydown=function(ev){
      var k=ev&&ev.key, i=items.indexOf(document.activeElement), n=items.length;
      if(k==='Escape'){
        /* Stop here: the document's own Escape handlers (the slash menu, the
           artifact pane) must not ALSO fire for this keypress. */
        if(ev.stopPropagation) ev.stopPropagation();
        if(ev.preventDefault) ev.preventDefault();
        setRowMenu(menu,false,true); return;
      }
      /* Tab: close, but draw a parked poll on the NEXT tick — redrawing
         inside this keydown removes the focused item before the browser
         moves focus, and focus falls to <body>. */
      if(k==='Tab'){
        setRowMenu(menu,false,false,true);
        setTimeout(function(){
          if(!openRowMenu()&&deferredList){ var d=deferredList; deferredList=null; renderList(d.rows,d.archived); }
        },0);
        return;
      }
      var next=-1;
      if(k==='ArrowDown') next=(i+1)%n;
      else if(k==='ArrowUp') next=(i<=0?n:i)-1;
      else if(k==='Home') next=0;
      else if(k==='End') next=n-1;
      if(next<0) return;
      if(ev.preventDefault) ev.preventDefault();
      focusEl(items[next]);
    };
    row.appendChild(more);
    row.appendChild(menu);
  }

  /* Outside click closes the open menu. document outlives a Turbo body swap,
     so this is the bindOnce + live() pattern. A click on the trigger (or in
     the menu) is the trigger's own business. */
  bindOnce(document,'click','rowMenuOutside',function(ev){
    if(!live()) return;
    var m=openRowMenu(); if(!m) return;
    var t=ev&&ev.target;
    if(t&&(m.contains(t)||(m.__trigger&&m.__trigger.contains(t)))) return;
    setRowMenu(m,false,false);
  });

  /* The latest /roost payload that arrived while a menu was open. Only the
     newest is worth drawing, so each poll overwrites it. */
  var deferredList=null;

  /* Which list control had focus, so a re-render can put it back. Only when
     focus was INSIDE the list body: a poll must never pull focus out of the
     composer. */
  /* The element whose children are the rows: the cards' list in new mode. */
  function listHost(body){
    return findIn(body,function(c){ return hasClass(c,'ph-list')&&!hasClass(c,'archived-list'); })||body;
  }
  function listFocusMark(body){
    var ae=document.activeElement;
    if(!ae||ae===body||!body.contains||!body.contains(ae)) return null;
    var sid=ae.getAttribute?ae.getAttribute('data-sid'):null;
    if(!sid) return null;
    var rows=listHost(body).children||[], idx=-1;
    for(var i=0;i<rows.length;i++){ if(rows[i].contains&&rows[i].contains(ae)){ idx=i; break; } }
    return {sid:sid,more:hasClass(ae,'roost-more'),idx:idx};
  }
  function restoreListFocus(body,mark){
    if(!mark) return;
    var target=findIn(body,function(c){
      return !!c.getAttribute&&c.getAttribute('data-sid')===mark.sid&&hasClass(c,'roost-more')===mark.more;
    });
    if(!target){
      /* The row is gone (closed, archived): the next row's ⋯ — which now sits
         at the same index — or, with none left, New session. */
      var r=mark.idx>=0?(listHost(body).children||[])[mark.idx]:null;
      target=findIn(r,function(c){ return hasClass(c,'roost-more'); })||el('perch-new')||document.querySelector('[data-ph-start]');
    }
    focusEl(target);
  }

  /* New mode (the session sheet exists): the list is the project home's
     session cards (shared/session-cards.js): title, bot, project, day; a live
     dot or a Waiting chip; never an id or a state word. The whole card opens
     the session; Rename and Archive sit in its menu. Idle bot rows are not
     drawn: "Start a session" above the list starts any bot. */
  var CARDS_MODE=!!el('perch-session-sheet');
  var SC_NO_SESSIONS='${tJs("shell.noSessions", lang)}';
  function cardModelOf(r){
    var p=projectOfRow(r,PROJECTS);
    var here=!!p&&SCOPE!=null&&/^[1-9][0-9]*$/.test(String(SCOPE))&&Number(SCOPE)===Number(r.projectId);
    return sessionCardModel({sessionId:r.sessionId,label:r.label,botName:r.botName||r.botId,state:r.state,
      pendingUi:r.pendingUi,lastAt:r.lastActivityAt},
      {projectName:(p&&!here)?p.name:null,projectSlug:sessionHref(r,PROJECTS,SCOPE)?p.slug:null});
  }
  /* The menu's name for a card: what the card itself reads as. */
  function cardName(m){ return [m.title||SC_UNTITLED,m.botName].filter(Boolean).join(' \u00b7 '); }
  function plainClick(ev){ return !!ev&&ev.button===0&&!ev.metaKey&&!ev.ctrlKey&&!ev.shiftKey&&!ev.altKey; }
  function renderCards(rows,archived){
    var body=el('perch-list-body'); if(!body) return;
    deferredList=null;
    var mark=listFocusMark(body);
    clearEl(body); rowIndex={};
    var arch=Array.isArray(archived)?archived:[];
    var live=(rows||[]).filter(function(r){ return !!(r&&r.sessionId); });
    live.sort(function(a,b){
      if(!!b.pendingUi!==!!a.pendingUi) return b.pendingUi?1:-1;
      var x=String(a.lastActivityAt||''), y=String(b.lastActivityAt||'');
      if(x!==y) return x<y?1:-1;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
    if(!live.length&&!arch.length){ body.appendChild(line('empty',SC_NO_SESSIONS)); flushPendingNote(); restoreListFocus(body,mark); return; }
    var now=new Date();
    if(live.length){
      var ul=document.createElement('ul'); ul.className='ph-list';
      live.forEach(function(r){
        rowIndex[r.sessionId]=r;
        var m=cardModelOf(r);
        var day=identDay(r,now,IDENT_LANG);
        var li=scCardEl(m,day?day.charAt(0).toUpperCase()+day.slice(1):'');
        var a=li.firstChild;
        /* Opened the way a row's Open did (openRow: in place, or through the
           project's scope); a modified click keeps the link's own behaviour. */
        a.onclick=function(ev){
          if(!plainClick(ev)) return;
          if(ev.preventDefault) ev.preventDefault();
          rowIndex[r.sessionId]=r; openRow(r);
        };
        buildRowMenu(li,r.sessionId,[
          {cls:'roost-rename',label:RENAME_LABEL,run:function(){ renameSession(r.sessionId,r.label||''); }},
          {cls:'roost-archive',label:ARCHIVE_LABEL,run:function(){ archiveSession(r.sessionId); }}
        ]);
        var more=findIn(li,function(c){ return hasClass(c,'roost-more'); });
        if(more){
          more.className='roost-more ph-card-more';
          more.setAttribute('aria-label',ROW_ACTIONS.replace('{session}',function(){ return cardName(m); }));
        }
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    renderArchivedCards(body,arch);
    flushPendingNote();
    restoreListFocus(body,mark);
  }
  /* The Archived toggle, as cards: title and bot, and Unarchive. */
  function renderArchivedCards(body,archived){
    if(!body||!archived||!archived.length) return;
    var head=document.createElement('button');
    head.type='button'; head.className='archived-toggle';
    head.textContent=ARCHIVED_LABEL+' ('+archived.length+')';
    head.setAttribute('aria-expanded',archivedOpen?'true':'false');
    var ul=document.createElement('ul'); ul.className='ph-list archived-list'; ul.hidden=!archivedOpen;
    archived.forEach(function(a){
      if(!a||!a.sessionId) return;
      var m=sessionCardModel({sessionId:a.sessionId,label:a.label,botName:a.botName||a.botId},{});
      var li=scCardEl(m,'');
      var link=li.firstChild, box=document.createElement('div');
      box.className='ph-row archived-row';
      while(link.firstChild) box.appendChild(link.firstChild);
      li.replaceChild(box,link);
      var u=document.createElement('button');
      u.type='button'; u.className='roost-rename ph-card-more ph-card-text'; u.textContent=UNARCHIVE_LABEL;
      u.setAttribute('data-sid',a.sessionId);
      u.onclick=function(){ unarchiveSession(a.sessionId); };
      li.appendChild(u);
      ul.appendChild(li);
    });
    head.onclick=function(){ archivedOpen=!archivedOpen; ul.hidden=!archivedOpen; head.setAttribute('aria-expanded',archivedOpen?'true':'false'); };
    body.appendChild(head);
    body.appendChild(ul);
  }

  function renderList(rows,archived){
    if(CARDS_MODE){ renderCards(rows,archived); return; }
    var body=el('perch-list-body'); if(!body) return;
    deferredList=null;
    var mark=listFocusMark(body);
    clearEl(body); rowIndex={};
    var arch=Array.isArray(archived)?archived:[];
    /* No live rows: say so, UNLESS archived sessions exist — then the
       Archived affordance below is the operator's way back in, and a flat
       "No sessions" would hide it. */
    if(!rows.length&&!arch.length){ body.appendChild(line('empty',NO_SESSIONS)); flushPendingNote(); restoreListFocus(body,mark); return; }
    var collide=rowCollisions(rows,function(r){ return r.cardId==null?'':String(r.cardId); });
    rows.forEach(function(r){
      var row=document.createElement('div'); row.className='roost-row';
      row.appendChild(line('roost-dot',''));
      var main=document.createElement('div'); main.className='roost-main';
      main.appendChild(line('roost-cwd',r.botName));
      /* The name on its OWN line, above the subtitle, so a long name cannot
         push state/card out of a 320px column. textContent via line(),
         never innerHTML — this string came from an operator. */
      if(r.label) main.appendChild(line('roost-name',r.label));
      main.appendChild(line('roost-when',rowSubtitle(r,!!collide[r.sessionId])));
      row.appendChild(main);
      /* Cached BEFORE the menu is built: its aria-label names the session
         through sessionLabel(), which reads rowIndex. */
      if(r.sessionId) rowIndex[r.sessionId]=r;
      var b=document.createElement('button');
      b.type='button'; b.textContent=r.sessionId?OPEN_LABEL:TALK_LABEL;
      if(r.sessionId) b.setAttribute('data-sid',r.sessionId);
      b.onclick=r.sessionId
        ? function(){ rowIndex[r.sessionId]=r; openRow(r); }
        : function(){ startSession(r.botId,r.botName); };
      row.appendChild(b);
      /* Only a live session has actions; an idle bot row has nothing to
         rename or stop. Rename and Archive are reversible (no confirm);
         Close is terminal and keeps its confirm in stopSession(). */
      if(r.sessionId){
        buildRowMenu(row,r.sessionId,[
          {cls:'roost-rename',label:RENAME_LABEL,run:function(){ renameSession(r.sessionId,r.label||''); }},
          {cls:'roost-archive',label:ARCHIVE_LABEL,run:function(){ archiveSession(r.sessionId); }},
          {cls:'roost-close',label:CLOSE_LABEL,run:function(){ stopSession(r.sessionId); }}
        ]);
      }
      body.appendChild(row);
    });
    renderArchived(body,arch);
    flushPendingNote();               /* a parked note must survive this render */
    restoreListFocus(body,mark);
  }

  /* PR-C (audit item 14): the "Archived" affordance. A collapsed toggle whose
     open/closed state persists across the 10s polls (archivedOpen), revealing
     archived sessions each with an Unarchive button. Built with closures — the
     toggle references its OWN container directly, so no runtime-id lookups and
     nothing new for the vm harness's IDS registry to know. */
  var archivedOpen=false;
  function renderArchived(body,archived){
    if(!body||!archived||!archived.length) return;
    var head=document.createElement('button');
    head.type='button'; head.className='archived-toggle';
    head.textContent=ARCHIVED_LABEL+' ('+archived.length+')';
    var cont=document.createElement('div'); cont.className='archived-list'; cont.hidden=!archivedOpen;
    /* Same id rule as the live rows, compared among archived rows only.
       Archived rows carry no card. */
    var collide=rowCollisions(archived,function(){ return ''; });
    archived.forEach(function(a){
      if(!a||!a.sessionId) return;
      var row=document.createElement('div'); row.className='roost-row archived-row';
      var main=document.createElement('div'); main.className='roost-main';
      main.appendChild(line('roost-cwd',a.botName||a.botId||''));
      if(a.label) main.appendChild(line('roost-name',a.label));
      main.appendChild(line('roost-when',rowSubtitle({state:a.state,sessionId:a.sessionId,cardId:null},!!collide[a.sessionId])));
      row.appendChild(main);
      var u=document.createElement('button');
      u.type='button'; u.className='roost-rename'; u.textContent=UNARCHIVE_LABEL;
      u.setAttribute('data-sid',a.sessionId);
      u.onclick=function(){ unarchiveSession(a.sessionId); };
      row.appendChild(u);
      cont.appendChild(row);
    });
    head.onclick=function(){ archivedOpen=!archivedOpen; cont.hidden=!archivedOpen; };
    body.appendChild(head);
    body.appendChild(cont);
  }
  /* Archive/unarchive are LIST actions: on success reload the roster (the
     session moves between the live list and the Archived section). They write
     only list-level surfaces (never a session pane), so they need no mySid
     identity guard. Failure parks a list note, matching rename/stop. */
  function archiveSession(sid){
    if(!sid) return;
    perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/archive',{}).then(function(r){
      if(!r.ok){ showListNote(ARCHIVE_FAILED); return; }
      loadList();
    });
  }
  function unarchiveSession(sid){
    if(!sid) return;
    perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/unarchive',{}).then(function(r){
      if(!r.ok){ showListNote(UNARCHIVE_FAILED); return; }
      loadList();
    });
  }

  /* The bots the launcher can spawn against, refreshed by every loadList().
     Empty until the first /roost answers — which is why #perch-new ships
     disabled in the markup rather than enabled-and-lying. */
  var launchBots=[];
  /* ?bot=<id> (the Bot Builder card's Chat link): the bot to preselect in
     the launcher's picker, applied once — the first time the roster offers
     that bot — and ignored when it is not offered. A later poll keeps the
     operator's own pick. */
  var wantBot=(function(){
    var m=/[?&]bot=([^&#]*)/.exec(String((location&&location.search)||''));
    if(!m) return null;
    try{ return decodeURIComponent(m[1].replace(/\\+/g,' '))||null; }catch(e){ return null; }
  })();

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
    /* One attached bot is the common case (and Casey's): no BOT picker, one
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
      if(wantBot&&bots.filter(function(b){ return b.id===wantBot; }).length){ sel.value=wantBot; wantBot=null; }
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
  var launchModels={botId:null,default:null,want:null,list:null,showAll:false};

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
    var sel=el('perch-new-model'), lbl=el('perch-new-model-label'), more=el('perch-new-model-more');
    if(sel){ sel.hidden=true; clearEl(sel); }
    if(lbl) lbl.hidden=true;
    if(more) more.hidden=true;
    /* want cleared too, so the next poll retries a list that failed to load
       rather than leaving the picker permanently absent. */
    launchModels={botId:null,default:null,want:null,list:null,showAll:false};
    syncLaunchSummary();
  }

  /* QW2: the "More options" summary names the model the next session will
     start on — the picker lives inside the collapsed details, and a changed
     pick must stay visible with it closed. Empty while there is no list. */
  function syncLaunchSummary(){
    var span=el('perch-launch-more-model'); if(!span) return;
    var sel=el('perch-new-model'), txt='';
    if(sel&&!sel.hidden){
      var opts=sel.options||[], want=String(sel.value||'');
      for(var i=0;i<opts.length;i++){ if(String(opts[i].value)===want){ txt=opts[i].textContent; break; } }
    }
    span.textContent=txt?(' \\u00b7 '+txt):'';
  }

  function renderLaunchModels(list,dflt){
    var sel=el('perch-new-model'), lbl=el('perch-new-model-label');
    if(!sel) return;
    /* The bot's default is PINNED first, outside the groups, whatever its
       state: the operator must always see what one tap launches on — an
       unreachable default reads as unreachable rather than disappearing. */
    var plan=planModelList(list,dflt);
    var listed=!!plan.pinned;
    /* NO CONFIGURED DEFAULT — the common case on this instance: 3 of 5 R4 bot
       defs carry models:null, and a def naming a since-disabled provider row
       lands here too. Without the sentinel nothing was preselected, the
       browser picked option 0, and startSession() then saw a value different
       from the (null) default and fired a REAL control() switch — so one tap
       on "New session" silently moved the session onto whatever sorted first
       in provider order, where spawn would have resolved model_resolver.mjs's
       own fallback. An empty value means "send no control at all", which is
       exactly what letting the spawn decide has to mean. */
    fillModelSelect(sel,plan,{sentinel:!listed,pinnedSuffix:' \u2014 '+MODEL_BOT_DEFAULT,showAll:launchModels.showAll});
    syncModelMore(el('perch-new-model-more'),plan,launchModels.showAll);
    /* Pre-selected on the bot's own configured model when there IS one: an
       operator who does not care taps the button and gets what the bot was
       built with. With no default the sentinel is option 0 and the browser
       selects it unaided — an explicit sel.value='' here was measured
       redundant (removing it left every test green), so it is not written. */
    if(listed) sel.value=dflt;
    sel.hidden=false;
    if(lbl) lbl.hidden=false;
    syncLaunchSummary();
  }

  /* "Show more (N)": re-render with the hidden entries in their own
     group (or without them), keeping the operator's pick when it survives. */
  var launchMore=el('perch-new-model-more');
  if(launchMore) launchMore.onclick=function(){
    var sel=el('perch-new-model');
    if(!sel||!launchModels.list) return;
    var keep=String(sel.value||'');
    launchModels.showAll=!launchModels.showAll;
    renderLaunchModels(launchModels.list,launchModels.default);
    if(selectHasValue(sel,keep)) sel.value=keep;
    syncLaunchSummary();
  };
  var launchModelSel=el('perch-new-model');
  if(launchModelSel) launchModelSel.onchange=syncLaunchSummary;

  function syncLaunchModels(){
    var botId=launchBotId();
    if(!botId){ hideLaunchModels(); return; }
    if(launchModels.botId===botId||launchModels.want===botId) return;   /* shown, or in flight */
    launchModels.want=botId;
    perchApi('GET','/bots/'+encodeURIComponent(botId)+'/models').then(function(r){
      if(launchModels.want!==botId) return;      /* the operator moved to another bot */
      if(!r.ok||!r.j||!Array.isArray(r.j.models)||!r.j.models.length){ hideLaunchModels(); return; }
      launchModels={botId:botId,default:r.j['default']||null,want:null,list:r.j.models,showAll:false};
      renderLaunchModels(r.j.models,launchModels.default);
    });
  }
  /* The operator's own pick ends the ?bot= preselect: a later poll that
     first offers that bot must not override what they chose. */
  if(el('perch-new-bot')) el('perch-new-bot').onchange=function(){ wantBot=null; syncLaunchModels(); };

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
  if(el('perch-new')) el('perch-new').onclick=startNewSession;   /* classic only: new mode starts from the shared start control */

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
    /* New mode: "Change directory" sits in the session sheet, a modal
       dialog. Everything outside the top layer is inert while it is open,
       this overlay included, so the sheet closes first. */
    if(SHEET&&SHEET.open){ sheetSkipFocus=true; closeSheet(); }
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
    if(ev.key!=='Escape') return;
    if(browse.open){ closeBrowseModal(); return; }
    var m=el('perch-cmdmenu');            /* Wave 3: Escape closes the slash menu too */
    if(m&&!m.hidden) m.hidden=true;
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
  function startSession(botId,botName,modelKey,cwd,opts){
    var mySid=current.sid;                  /* identity guard: a spawn resolving after the
                                                operator has opened another session must not
                                                yank them out of it */
    var spawnBody={}, spawnProject=scopeProject(), hasBody=false;
    if(cwd){ spawnBody.cwd=cwd; hasBody=true; }
    if(spawnProject!==null){ spawnBody.project_id=spawnProject; hasBody=true; }
    if(opts&&opts.briefing){ spawnBody.briefing=true; hasBody=true; }
    /* Resolves what happened, for a caller with its own note (the shared
       start control): {sid}, {note} or {stale} (the identity guard held). */
    function refused(text){ setLaunchNote(text); return {note:text}; }
    return perchApi('POST','/bots/'+encodeURIComponent(botId)+'/interactive',hasBody?spawnBody:undefined).then(function(r){
      if(current.sid!==mySid) return {stale:true};
      /* setLaunchNote, not showListNote: a FAILED SPAWN is a fact about the
         launcher, and showListNote clears #perch-list-body — which would wipe
         every session row and, with them, every Close button, for up to the
         10s until the next poll. That was tolerable while the only spawn
         trigger was an idle row (a list with idle rows has nothing much to
         lose); the always-present launcher makes it routine, and it lands
         hardest on an operator whose actual job right now is closing
         sessions. The note belongs next to the control that produced it. */
      if(r.status===409) return refused(ENGINE_REQUIRED);
      if(r.status===403) return refused(NOT_ATTACHED);
      /* The route validated the directory before the engine ever saw it
         (open-anywhere C1): a stale picker choice — deleted between browse
         and spawn — lands here, and the note belongs beside the field. */
      if(r.status===400&&r.j&&r.j.error==='bad_cwd'){
        /* QW2: the directory field lives in "More options" — open it, so the
           field this note is about is on screen beside it. */
        var moreOpts=el('perch-launch-more'); if(moreOpts) moreOpts.open=true;
        return refused(CWD_INVALID);
      }
      if(!r.ok||!r.j||!r.j.sessionId) return refused(START_FAILED);
      var sid=r.j.sessionId;
      rowIndex[sid]={botId:botId,botName:botName,sessionId:sid,projectId:typeof spawnProject==='number'?spawnProject:null};
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
      if(!modelKey||modelKey===launchModels.default){ location.hash=sid; return {sid:sid}; }
      return perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/control',controlBody('model',modelKey))
        .then(function(c){
          if(current.sid!==mySid) return {stale:true};   /* same identity guard as the spawn above */
          /* A refused switch is not a refused session: the session is real
             and usable on the bot's own model, so say what happened and open
             it rather than stranding a live child behind an error. */
          if(!c.ok) setLaunchNote(LAUNCH_MODEL_FAILED);
          location.hash=sid;
          return {sid:sid};
        });
    });
  }
  /* New mode: the shared start control (shared/session-cards.js) starts
     through here, so a Chat start is this startSession: the scope's filing,
     the rowIndex seed and the identity guard. A retired instance answers
     nothing; each new one installs its own. */
  HUB.startSession=function(botId,botName,opts){
    if(!live()) return null;
    /* A project's Chat asks for its briefing, as the project home does. */
    return startSession(botId,botName,null,null,{briefing:typeof scopeProject()==='number'||!!(opts&&opts.briefing)});
  };

  var listTimer=null;
  function loadList(){
    return perchApi('GET','/roost'+(SCOPE?'?scope='+encodeURIComponent(SCOPE):'')).then(function(r){
      /* One payload, two renders: the rows AND the launcher's bot roster.
         Deriving the launcher from the same /roost response is what keeps
         this to a single request per poll. */
      if(r.ok&&r.j){
        renderLauncher(spawnableBots(r.j));
        /* QW2: never redraw the rows under an open ⋯ menu — the operator is
           mid-choice. Park the payload; closing the menu draws it. */
        if(openRowMenu()){ deferredList={rows:listRows(r.j,SCOPE),archived:(r.j.archived||[])}; return; }
        renderList(listRows(r.j,SCOPE),(r.j.archived||[]));
        if(current.sid&&rowIndex[current.sid]) showIdent(current.botName||current.botId);   /* the head's day line and Back label follow the fresh row */
        return;
      }
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
  /* Collapsed on desktop (sessions-collapse-css.js) counts as hidden — but only
     while a chat is open: the collapse rules are keyed on data-view="chat",
     so in the list view the list is on screen whatever the stored choice. */
  function listOnScreen(){
    return body.getAttribute('data-view')==='list'||(!!(SPLIT&&SPLIT.matches)&&!sessionsCollapsed);
  }
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
  /* PHONE TRANSCRIPT (2026-10-02, Casey): under 600px the 64px role gutter
     beside every message wasted a fifth of the screen. #perch-hub-root gets
     .perch-narrow there, and css.js lays each message out full width with the
     role label on its own small line above it. A class (not a bare media
     query) so the one width rule is measurable from a fake DOM and shared by
     every narrow-only rule. Re-evaluated on resize (rotation, split-screen),
     through bindOnce + live() like every other window listener here. */
  var NARROW_MAX=599;
  function setToken(node,tok,on){
    var parts=String(node.className||'').split(/\\s+/).filter(function(x){ return x&&x!==tok; });
    if(on) parts.push(tok);
    node.className=parts.join(' ');
  }
  function applyNarrow(){
    var root=el('perch-hub-root'); if(!root) return;
    var w=window.innerWidth||0;
    setToken(root,'perch-narrow',w>0&&w<=NARROW_MAX);
  }
  applyNarrow();
  /* One resize listener: it also refits the head's context line (a rotation
     changes whether the day fits beside the project name) and keeps the
     floating browser preview inside the viewport (browser-float.js). */
  bindOnce(window,'resize','narrowResize',function(){ if(live()){ applyNarrow(); refreshIdent(); if(typeof applyVV==='function') applyVV(); bfResize(); } });

  /* TEXT SIZE. #407 (2026-10-02) gave Perch its own five-step A− / A / A+;
     since A11Y-TEXTSIZE (2026-10-03) the control is a CONSUMER of the
     dashboard-wide text size (shared/text-size.js): one per-device
     preference, also set from Settings › Text size, applied on the html element
     as data-text-size before first paint. The layout's head script already made
     window.crowTextSize; the fallback below is the SAME runtime source,
     interpolated, for a page without that head (and for the test harness).
     The chat tab's css (--pts) reads --crow-text-scale, so stepping here
     resizes the chat and the rest of the dashboard together. The old
     per-chat key migrates once, inside the runtime's first read. */
  var TS=window.crowTextSize||(window.crowTextSize=${textSizeRuntimeJs()});
  var TEXT_NAMES={${TEXT_SIZES.map((s) => "'" + s.id + "':'" + tJs(s.labelKey, lang) + "'").join(",")}};
  function applyTextStep(){
    var cur=TS.get(), ids=TS.ids, i=ids.indexOf(cur);
    TS.apply(cur);
    var out=el('perch-text-size-value');
    if(out){
      out.textContent=TEXT_NAMES[cur]||cur;
      /* Live region only AFTER this first fill: the server renders Default,
         and announcing the stored size on every page load is noise. */
      if(!out.getAttribute('aria-live')) out.setAttribute('aria-live','polite');
    }
    var dn=el('perch-text-smaller'), up=el('perch-text-larger'), rs=el('perch-text-reset');
    if(dn) dn.disabled=(i<=0);
    if(up) up.disabled=(i===ids.length-1);
    if(rs) rs.disabled=(cur==='${TEXT_SIZE_DEFAULT}');
  }
  function stepText(d){
    var ids=TS.ids, i=ids.indexOf(TS.get())+d;
    if(i<0||i>=ids.length) return;
    TS.set(ids[i]); applyTextStep();
  }
  applyTextStep();
  (function(){
    var dn=el('perch-text-smaller'), up=el('perch-text-larger'), rs=el('perch-text-reset');
    if(dn) dn.onclick=function(){ stepText(-1); };
    if(up) up.onclick=function(){ stepText(1); };
    if(rs) rs.onclick=function(){ TS.set('${TEXT_SIZE_DEFAULT}'); applyTextStep(); };
  })();
  /* Changed in another tab (the head script's storage listener re-applies
     the html element and fires this): refresh the readout and the button states. */
  bindOnce(window,'crow:text-size','textSize',function(){ if(live()) applyTextStep(); });

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

  /* Phone unlock / tab re-focus / pageshow / back online: a dozed socket is
     rediscovered NOW, not at the next backoff slot (which can be up to 30s
     away on a long streak). onStreamError closeStreams FIRST, so \'stream\' is
     null exactly in the window where a retry is pending or the radio just
     came back; a live stream is left alone. The re-open carries resync=true:
     the engine replays only state + the pending card on subscribe, so frames
     that COMPLETED while the socket was dead are re-fetched with the
     transcript instead of silently missing until a manual reload (Wave 1
     item 19; pi-lab has reloaded on every reconnect since day one). Guarded
     like every document/window listener (bindOnce + live()). */
  function reviveStream(){
    if(!live()) return;
    if(document.visibilityState&&document.visibilityState!=='visible') return;
    if(!current.sid||stream) return;
    cancelReconnect(); retries=0;
    openStream(current.sid,true);
  }
  bindOnce(document,'visibilitychange','visibility',function(){
    if(document.visibilityState==='visible'){ reviveStream(); refreshIdent(); }
    if(typeof applyVV==='function') applyVV();
  });
  bindOnce(window,'pageshow','pageshow',function(){ reviveStream(); if(typeof applyVV==='function') applyVV(); });
  bindOnce(window,'online','online',reviveStream);

  /* Engine-minted ids only: "perchlive-" + 8 hex (perch-interactive.js:1473).
     A loose pattern would admit ".." and this value is concatenated into an
     API path. Encoded at every use site as well, belt and braces. */
  function parseHash(h){
    var raw=String(h==null?'':h).replace(/^#/,'');
    return /^perchlive-[0-9a-f]{8}$/.test(raw)?{sessionId:raw}:null;
  }

  var current={sid:null,botName:null};
  /* Images attached via attachFile(), queued for the NEXT send() only —
     drawer.js:406/916 does the same two-part attach: upload now (POST
     .../files), attach the wire-shape {mime,data_b64} array on the send that
     follows, then clear regardless of outcome. resetControls() also clears
     this so a new session never inherits a stale queue. */
  var pendingImages=[];
  /* Wave 1: non-image uploads. The file is already on disk in the session's
     uploadsDir, and the model can no more SEE the upload than it can see
     the wire — so its PATH rides the next outgoing message (pi-lab's
     idiom, its wording). Images ride the wire; files ride the filesystem. */
  var pendingFilePaths=[];

  function openSession(sid){
    if(current.sid===sid) return;          /* a re-entered hash is a no-op */
    draftSave();                            /* the session being left keeps its unsent words */
    closeStream();
    current.sid=sid;
    current.botName=null;                   /* the previous bot's name must not label this one */
    var mySid=sid;                          /* identity guard for every await below */
    setView('chat');
    /* SSE is the live signal for the CHAT. It says nothing about the list,
       which in split view is still on screen — so the poll stops only when the
       list is genuinely hidden. */
    syncListPolling();
    clearEl(el('perch-transcript')); clearEl(el('perch-ask'));
    clearEl(el('perch-activity-list'));   /* the previous session's log is not this one's */
    toolChips={}; resetToolGroups();                         /* Wave 3: the chip index dies with the transcript */
    fileSeen={};                          /* PR-E: same seam for the card dedupe */
    resetPhoneCards();
    resetArtifactCards(); resetCardChip(); resetBriefing();
    resetBrowserTiles();                  /* live browser tile: its pollers and header line die with the transcript */
    resetControls();                        /* the PREVIOUS session's picker must not bleed in */
    draftRestore(sid);                      /* nor its composer text: this session's own draft, or empty */
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
    dictationCancel();           /* dictation.js: a hidden composer must never keep recording or upload */
    cancelHistRetry(); histGen++;   /* 23a: a load or retry for the session being left must not render */
    draftSave();                 /* Shell P2: its unsent words wait for it */
    closeStream(); current.sid=null; stopIdentRefresh(); applyMakeTab(null);
    resetBrowserTiles();         /* no frame poller outlives the chat it belongs to */
    setTurnInFlight(false);      /* the list has no Steer/Stop to show */
    closeSheet();                /* new mode: the sheet belongs to the session being left */
    closeAppsSheet();            /* so does its apps sheet (R1.2 PR 5) */
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

  /* An assistant message's text blocks only, joined as the engine's
     assistantTextOf joins them (R1.2 PR 2: new mode's history rows). */
  function assistantTextOnly(message){
    var content=message&&message.content;
    if(typeof content==='string') return content;
    if(!Array.isArray(content)) return '';
    return content.filter(function(b){ return b&&b.type==='text'&&typeof b.text==='string'; })
      .map(function(b){ return b.text; }).join('');
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
    stopWatchdog();                    /* Wave 1: no stream, nothing to watchdog */
    var es=stream; stream=null;        /* null FIRST: idempotent under a double call
                                          from openSession + hashchange */
    if(es){ try{ es.close(); }catch(e){} unregisterStream(es); }
  }

  function openStream(sid,resync){
    closeStream();
    stateSeen=false;   /* R1.2 PR 2: this stream has not replayed its state yet (histSettledIdle) */
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
    noteEvent();   /* Wave 1: a fresh socket starts with a fresh silence budget — the watchdog measures from HERE, not from the last frame of the previous stream */
    es.onopen=function(){ resetBackoff(); noteEvent(); if(resync) resyncHistory(); };
    /* Wave 1 item 20 fuel: the server's 30s named ping (sse.js) is the only
       traffic an IDLE-but-healthy stream sees, so it is what the watchdog
       measures silence against. Raw listener, not on(): a ping carries no
       session semantics and must never touch the transcript. */
    es.addEventListener('ping',function(){ if(live()) noteEvent(); });
    startWatchdog();

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
        noteEvent();                              /* Wave 1: any frame is liveness */
        var d={}; try{ d=JSON.parse(ev.data); }catch(e){ d={}; }
        fn(d);
      });
    };
    on('state',function(d){
      stateSeen=true;
      setTurnInFlight(turnFlagFor(d));
      cardTurnState(d.state);                 /* P5: a turn ending may mean a card offer or a lane move */
      /* An expired card leaves once the engine drops it (the next message). */
      if(askShown&&askShown.expired&&!d.pendingUi) renderAsk(null);
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
      if(modelSel&&d.model&&!modelSel.disabled){
        drawerModels.current=d.model;    /* the toggle's re-render pins what the session is on NOW */
        selectCurrentModel(modelSel,d.model);
      }
      if(d.permissionMode){ var permSel=el('perch-permission'); if(permSel) permSel.value=d.permissionMode; }
      var planCb=el('perch-plan-mode'); if(planCb) planCb.checked=!!d.planMode;
      /* Open-anywhere D2: the Session tab's read-only cwd readout, refreshed
         from the engine's own record on every state frame (subscribe replays
         one on connect, so this is also how the tab learns cwd FIRST — there
         is no separate snapshot fetch). null = the bot's default directory.
         textContent only: the value is a filesystem path, never markup. */
      var cwdEl=el('perch-session-cwd');
      if(cwdEl) cwdEl.textContent=d.cwd||CWD_DEFAULT_TEXT;
      /* Wave 2: the facts card rides the same frame — one source, one
         refresh path, no polling of its own. */
      renderFacts(d);
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
    on('tool',function(d){
      /* The chip, like text frames, waits for the history batch: a call that
         finished between subscribe and the fetch is ALSO in the batch (as a
         toolResult chip), and flushHistBuf drops the frame then. The rail
         line is not part of history, so it is not buffered. */
      if(!histSettled){
        if(d.phase==='start') appendActivity('[tool: '+(d.name||'?')+']');
        histBuf.push({ toolFrame:true, d:d });
        return;
      }
      if(d.phase==='start'){
        appendActivity('[tool: '+(d.name||'?')+']');
        appendToolChip(d);            /* Wave 3: the chat gets the live chip */
      } else if(d.phase==='end'){
        finishToolChip(d);
        if(String(d.name||'').indexOf('board_offer_card')>=0&&current.sid) loadCardOffers(current.sid);   /* P5 */
      }
    });
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
      lastSent=null;                  /* a reply proves the last send reached the bot */
      if(!histSettled) histBuf.push({ reply:true, text:d.text, html:d.html, turnId:d.turnId });
      else {
        var already=d.turnId?(renderedTurn===d.turnId):turnRendered;
        if(!already&&d.text) appendMessage('bot','bot',d.text,d.html);
      }
      setTurnInFlight(false);
    });
    on('file',function(d){
      if(!d||!d.name||d.kind==='browser_shot') return;
      if(!histSettled){ histBuf.push(d); return; }   /* round 3 R4 seam applies to cards too */
      var k=fileKey(d);
      if(fileSeen[k]) return;                        /* batch replay already drew it */
      fileSeen[k]=true;
      renderFileCard(d);
    });
    /* Live browser tile (spec 2026-10-27 §4.2): live / done / operator frames.
       Buffered with the tool frames until the history batch lands, so the
       tile finds its anchor chip and a shot the batch already drew is not
       drawn twice. */
    on('browser',function(d){
      if(!histSettled){ histBuf.push({ browserFrame:true, d:d }); return; }
      browserFrame(d);
    });
    on('ask_user',function(d){ renderAsk(d); });
    on('ask_expired',function(d){
      if(askShown&&d&&askShown.requestId===d.requestId) renderAsk(Object.assign({},askShown,{expired:true}));
    });
    /* Spec 2026-10-01: a phone_call frame is a pointer — phone-card.js refetches the row. */
    on('phone_call',function(d){
      if(!histSettled){ phoneBuf.push(d); return; }   /* replayed by loadPhoneCards once the history lands */
      phoneFrame(d,sid);
    });
    /* Spec v1.6 (chat-first PR-1): an artifact frame is a pointer —
       artifact-card.js refetches the store row. */
    on('artifact',function(d){
      if(!histSettled){ artBuf.push(d); return; }     /* replayed by loadArtifactCards once the history lands */
      artifactFrame(d,sid);
    });
    /* Strand 1 — the error-frame contract (perch-interactive.js emits five):
         turn_error (onTurnEnd: the turn ENDED in a model error, retries
           spent), stall and onTurnError (no reason)  → a danger row in the
           chat, once per turnId, plus the rail line;
         pi_exit (attachExit, refuseIfPiGone) → the rail line, and the
           send-failure note when a send is outstanding (the message went
           nowhere). Never a danger row: the note already says it.
         A frame with no turnId stays rail-only. turn_error does NOT drive
         showSendFailure: the send reached pi.
         Only turn_error rows come back on reload (pi persists the errored
         message); stall and refused-turn rows are live-only. */
    on('error',function(d){
      appendActivity(d.text||'error');
      /* The child DIED (pi exited at spawn — an unknown provider, a missing
         model — or mid-turn). That is not rail chrome: the operator's message
         went nowhere, so say why where they are reading. */
      if(d.reason==='pi_exit'){
        if(lastSent&&lastSent.sid===sid) showSendFailure(sid,d.text||'');
        return;
      }
      if(!d.turnId) return;
      if(!histSettled){ histBuf.push({ turnErr:true, text:d.text, turnId:d.turnId }); return; }
      drawTurnError(d.text, d.turnId);
    });
    on('plan_state',function(d){
      var t=planStateText(d.state); if(t) appendActivity(t);
      planState=(d&&d.state&&typeof d.state==='object')?d.state:null;
      renderPlan();                   /* Wave 2: bar + step checklist */
    });
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

  /* ---- new mode: the calm head (R1.2 PR 2) -------------------------------
     The bot's friendly name, a "# project · day" line, Back to the project
     home and the card line. Pure helpers first (unit-tested by extraction);
     every string reaches the DOM through textContent. */
  var IDENT_TODAY='${tJs("perch.identToday", lang)}';
  var IDENT_YESTERDAY='${tJs("perch.identYesterday", lang)}';
  var IDENT_LANG='${lang === "es" ? "es" : "en"}';
  var SHEET_TITLE_BOT='${tJs("perch.sheetTitleBot", lang)}';
  var BACK_PROJECT='${tJs("perch.backProject", lang)}', BACK_LIST='${tJs("perch.backList", lang)}';
  var APPS_EMPTY='${tJs("shell.appsEmptyProject", lang)}', APPS_LOADING='${tJs("shell.appsLoading", lang)}', APPS_FAILED='${tJs("shell.appsLoadFailed", lang)}';
  /* Classic keeps the 120px ceiling; the new-mode pill is capped by its CSS
     (five lines), so the script only has to follow the content. */
  var PILL=!!document.getElementById('perch-session-sheet');
  var PROJECTS=(function(){
    var n=document.getElementById('perch-projects'); if(!n) return [];
    try{ var v=JSON.parse(n.textContent||'[]'); return Array.isArray(v)?v:[]; }catch(e){ return []; }
  })();
  /* The session row's project, from the active-projects list the page
     carries. An unfiled session, or one whose project is not active, has none. */
  function projectOfRow(row,projects){
    if(!row||row.projectId==null||!Array.isArray(projects)) return null;
    var id=Number(row.projectId);
    for(var i=0;i<projects.length;i++){
      var p=projects[i];
      if(p&&Number(p.id)===id) return {slug:p.slug,name:p.name};
    }
    return null;
  }
  /* "today" / "yesterday" / a weekday (within the last week) / a short date,
     from the row's last-activity stamp (UTC "YYYY-MM-DD HH:MM:SS"). '' when
     the row carries none or it does not parse. */
  function identDay(row,now,lang){
    var s=row&&row.lastActivityAt; if(!s) return '';
    var d=new Date(String(s).replace(' ','T')+'Z');
    if(isNaN(d.getTime())) return '';
    var a=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
    var b=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
    var days=Math.round((b-a)/86400000);
    if(days<=0) return IDENT_TODAY;
    if(days===1) return IDENT_YESTERDAY;
    try{
      if(days<7) return d.toLocaleDateString(lang==='es'?'es':'en',{weekday:'long'});
      /* project-home/data.js relativeDay's rule: the year when it isn't this one. */
      var o={month:'short',day:'numeric'};
      if(d.getFullYear()!==now.getFullYear()) o.year='numeric';
      return d.toLocaleDateString(lang==='es'?'es':'en',o);
    }catch(e){ return d.toDateString(); }
  }
  /* The head's context line: the project's name, then the day when it fits
     (showIdent drops the day before the name would ellipsize). */
  function identSubtitle(row,projects,now,lang){
    var p=projectOfRow(row,projects);
    var day=identDay(row,now,lang);
    if(!p) return day;
    return p.name+(day?' \\u00b7 '+day:'');
  }
  /* Where a session row opens. A session filed in a project other than the
     view's scope opens through /dashboard/perch?project=<slug>, so the server
     renders that project's chip and scope (a real scope, never a relabel);
     anything else opens in place. New mode only: classic has no PROJECTS. */
  function sessionHref(row,projects,scope){
    var p=projectOfRow(row,projects); if(!p||!row||!row.sessionId) return null;
    if(scope!=null&&/^[1-9][0-9]*$/.test(String(scope))&&Number(scope)===Number(row.projectId)) return null;
    return '/dashboard/perch?project='+encodeURIComponent(p.slug)+'#'+encodeURIComponent(row.sessionId);
  }
  function openRow(r){
    var to=sessionHref(r,PROJECTS,SCOPE);
    if(to) location.href=to; else location.hash=r.sessionId;
  }
  /* Where Back goes: the session's project home, or null (the list). */
  function backTarget(row,projects){
    var p=projectOfRow(row,projects);
    return p?'/dashboard/project/'+encodeURIComponent(p.slug):null;
  }
  /* Head pieces that depend on the row; no-ops in classic Perch (no sheet). */
  function showIdent(botName){
    var sheet=el('perch-session-sheet'); if(!sheet) return;
    var row=rowIndex[current.sid];
    var pr=projectOfRow(row,PROJECTS);
    var full=identSubtitle(row,PROJECTS,new Date(),IDENT_LANG);
    var sub=el('perch-ident-sub');
    if(sub){
      sub.textContent=full;
      /* Phone review 2026-10-29: the day goes before the project name would
         ellipsize (the sheet below still carries the day). Measured after
         layout: showIdent can run while the chat view is still opening. */
      if(pr){
        var fit=function(){
          if(!live()||sub.textContent!==full) return;
          if(sub.scrollWidth>sub.clientWidth) sub.textContent=String(pr.name);
        };
        fit();
        if(typeof requestAnimationFrame==='function') requestAnimationFrame(fit);
      }
    }
    /* The full line, in the session sheet under its title. */
    var ss=el('perch-sheet-sub');
    if(ss) ss.textContent=full;
    var t=el('perch-sheet-title');
    if(t) t.textContent=SHEET_TITLE_BOT.split('{bot}').join(String(botName||''));
    /* Back is a "←" icon (html.js backIconButton): only its accessible name
       changes. data-home marks a filed session, which is what shows Back on
       desktop too (css.js), where the list beside the chat is otherwise
       the way back. */
    /* R1.2 PR 5: the apps button shows for a filed session only (it lists
       the session's project's apps). */
    var appsBtn=el('perch-apps-btn');
    if(appsBtn) appsBtn.hidden=!projectOfRow(row,PROJECTS);
    var back=el('perch-back');
    if(back){
      var home=!!backTarget(row,PROJECTS);
      var nm=home?BACK_PROJECT:BACK_LIST;
      back.setAttribute('aria-label',nm); back.setAttribute('title',nm);
      if(home) back.setAttribute('data-home',''); else if(back.removeAttribute) back.removeAttribute('data-home');
    }
  }
  /* The day line ("today" becomes "yesterday" at midnight) on a phone, where
     the list is hidden and its /roost poll (loadList's showIdent) stopped:
     redrawn from the open session's row as it is plus the current date, on
     a return to the tab and every 10 minutes while a session is open. No
     /roost request. New mode only (showIdent is a no-op without the sheet). */
  var IDENT_REFRESH_MS=600000, identTimer=null;
  function refreshIdent(){
    if(!live()||!current.sid) return;
    showIdent(current.botName||current.botId);
  }
  function startIdentRefresh(){
    stopIdentRefresh();
    if(!el('perch-session-sheet')) return;
    identTimer=setInterval(refreshIdent,IDENT_REFRESH_MS);
  }
  function stopIdentRefresh(){ if(identTimer){ clearInterval(identTimer); identTimer=null; } }
  /* The card line under the name: "#12 Card title", a link to the card. Fed
     by the card chip's own lookup (card-chip.js), so it adds no request. */
  /* R1.2 PR 3: the Make tab opens on This card from a card's chat. The server's
     href is kept in data-shell-href on the first change and restored when the
     session has no card (or closes). Any other base (no Make panel) is left alone. */
  /* Card mode ignores the project, and a ?project= link would rewrite the scope cookie on a Turbo
     hover prefetch: the card-scoped Make tab carries only the card. */
  function makeTabHref(base,cardId){
    var b=String(base||'');
    if(!Number.isInteger(cardId)||b.indexOf('/dashboard/make')!==0) return b;
    return '/dashboard/make?scope=card:'+String(cardId);
  }
  function applyMakeTab(c){
    if(typeof document.querySelector!=='function') return;
    var a=document.querySelector('a.shell-tab[data-shell-tab="make"]'); if(!a) return;
    var base=a.getAttribute('data-shell-href');
    if(base==null){ base=a.getAttribute('href')||''; a.setAttribute('data-shell-href',base); }
    a.setAttribute('href',makeTabHref(base,c?c.id:null));
  }
  function setHeadCard(c,href){
    applyMakeTab(c);
    var a=el('perch-card-line'); if(!a) return;
    if(!c||!Number.isInteger(c.id)){ a.hidden=true; a.textContent=''; a.removeAttribute('href'); return; }
    a.textContent='#'+String(c.id)+(c.title?' '+String(c.title):'');
    if(href) a.setAttribute('href',href);
    a.hidden=false;
  }
  function showHeader(botId,botName){
    /* Wave 1: the bot id is remembered for the session's life —
       resync-on-reconnect re-fetches the transcript BY BOT, and the cold
       deep-link path learns it from /roost before ever calling this. */
    current.botId=botId;
    current.botName=botName||null;          /* labels this session's bot rows (appendMessage) */
    el('perch-bot-name').textContent=botName||botId;
    /* The session id is the identity the close confirm and every API path
       use. It shows in the head on desktop; on phones (queue item 13) the
       head hides it and the Session tab's #perch-session-id carries it. In
       new mode html.js ships the head's copy hidden at every width; the
       sheet's Session section carries it. */
    el('perch-session-meta').textContent=current.sid||'';
    el('perch-session-id').textContent=current.sid||'';
    var known=rowIndex[current.sid];
    showSessionName(known?known.label:null);
    showIdent(botName||botId);
    startIdentRefresh();
  }
  /* Unbounded exponential backoff — the 2026-09-12 phone finding. The old cap
     (5 tries, fixed 2s) was written for a desktop browser and a gateway
     restart; on a phone the socket dies every time the screen dozes, and the
     radio can take longer than the whole 10s retry window to come back — so
     the operator unlocked their phone to a permanent "Lost the connection to
     this session" over a session that was perfectly alive (measured: the
     engine row sat at waiting-user with its last turn completed while the UI
     declared death). Now: retries never give up, 2s doubling to a 30s cap,
     reset ONLY on a stream that actually opened (resetBackoff, via onopen).
     Truly dead sessions are still detected — not by a retry budget but by
     onStreamError's options probe, whose 404/410/401 terminal statuses leave
     to the list. ONE "Reconnecting…" line per failure streak (first miss
     only) rides the Activity rail; repeating it every slot would paper the
     rail with noise.
     The two operations below stay separate, and conflating them is what made
     an earlier draft dead code: cancelling the TIMER must not reset the
     COUNTER, because onStreamError calls closeStream() (which cancels) before
     every scheduleReconnect(). The counter resets only when a stream
     actually opens. */
  var retries=0, retryTimer=null;
  function cancelReconnect(){ if(retryTimer){ clearTimeout(retryTimer); retryTimer=null; } }
  function resetBackoff(){ retries=0; }            /* called from onopen ONLY */
  function reconnectDelayMs(){
    var d=2000*Math.pow(2,retries-1);
    return d>30000?30000:d;
  }
  function scheduleReconnect(){
    retries++;
    if(retries===1) appendActivity(RECONNECTING);
    var mySid=current.sid;                          /* no parameter to get wrong */
    retryTimer=setTimeout(function(){
      retryTimer=null;
      if(!live()) return;                           /* retired mid-backoff */
      if(current.sid!==mySid) return;               /* navigated away mid-backoff */
      openStream(mySid,true);                       /* resync: the gap is exactly what this stream missed */
    },reconnectDelayMs());
  }

  /* Wave 1 item 20: the stale-ping watchdog. A dozed phone can leave a
     ZOMBIE socket that fires NO error event at all — visibilitychange
     covers the unlock, but a silently-dead socket on a FOREGROUND tab is
     only discoverable by the absence of traffic. The server pings every
     30s (sse.js's named ping), so 75s of silence while visible with a
     held stream is two missed pings plus scheduling slack: proved dead.
     Drop it and re-open WITH resync, because whatever completed during
     the zombie window is exactly what the transcript refetch is for.
     15s tick: worst-case discovery is 90s, versus never. */
  var lastEventAt=0, watchTimer=null;
  function noteEvent(){ lastEventAt=Date.now(); }
  function startWatchdog(){
    stopWatchdog();
    watchTimer=setInterval(function(){
      if(!live()) return;
      if(document.visibilityState&&document.visibilityState!=='visible') return;
      if(!current.sid||!stream) return;
      if(Date.now()-lastEventAt>75000){ closeStream(); openStream(current.sid,true); }
    },15000);
  }
  function stopWatchdog(){ if(watchTimer){ clearInterval(watchTimer); watchTimer=null; } }

  /* Wave 1 item 19: the resync itself. A REPLACE, never an append: the
     whole transcript refetches (the engine's own history endpoint is the
     source of truth), and the history seam re-opens so frames arriving
     DURING the refetch still dedupe through histBuf exactly as they do at
     first open. The turn-render bookkeeping (renderedTurn/turnRendered) is
     deliberately KEPT across a resync: the batch re-renders every completed
     message the live frames already showed, and that memory is what
     suppresses the in-flight turn's reply from appending its concatenation
     on top (the N1-within-turn duplicate). Clearing it re-broke exactly
     what N1 pins — measured red before this comment existed. The ask pane
     is untouched: the engine replays a pending card on the fresh subscribe,
     and renderAsk clears before it draws. */
  function resyncHistory(){
    var sid=current.sid, botId=current.botId;
    if(!sid||!botId) return;
    clearEl(el('perch-transcript'));
    toolChips={}; resetToolGroups();                    /* the chips just died with the transcript; a stale index would write into detached DOM */
    fileSeen={};
    resetPhoneCards();
    resetArtifactCards(); resetCardChip(); resetBriefing();
    resetBrowserTiles();
    histSettled=false; histBuf=[];
    seamEchoes=[];                   /* their rows died with the transcript */
    loadHistory(botId,sid);
  }

  /* Queue item 23a: every load takes a token (histGen). Only the newest load
     for the current session, in the instance that owns the document, may
     render: a load still in flight when the operator leaves and comes back
     (A, list, A), when a reconnect resyncs, or when a Turbo visit retires
     this instance would otherwise draw its batch a second time, or into the
     next page. A failed load retries once (historyRetryable) after
     HIST_RETRY_MS WITHOUT flushing: histSettled stays false, so live frames
     keep parking in histBuf and the seam dedupe still applies when the
     retry lands. */
  function cancelHistRetry(){ if(histRetryTimer){ clearTimeout(histRetryTimer); histRetryTimer=null; } }
  function logHistFail(r,attempt){
    var msg=histFailLine(r,attempt);
    try{ console.warn('[perch] '+msg); }catch(e){}
    appendActivity(msg);
  }
  function loadHistory(botId,sid,attempt){
    cancelHistRetry();
    var myGen=++histGen;
    var mySid=sid;
    histToolSeen={};
    renderedErrTurns={};
    /* PR-E: the transcript (messages) and the sent-file card history arrive in
       ONE join — the file cards flush only after BOTH land, so a slow history
       fetch can never interleave cards out of order with batch messages. */
    var histP=perchApi('GET','/interactive/'+encodeURIComponent(sid)+'/files/history')
      .then(function(h){
        var j=(h.ok&&h.j)||{};
        return { items:Array.isArray(j.items)?j.items:[], shots:Array.isArray(j.browserShots)?j.browserShots:[] };
      });
    Promise.all([
      perchApi('GET','/bots/'+encodeURIComponent(botId)+'/sessions/'+encodeURIComponent(sid)+'/transcript'),
      histP,
    ]).then(function(pair){
      var r=pair[0];
      if(!live()||myGen!==histGen||current.sid!==mySid) return;   /* identity guard + 23a load token */
        /* A FAILED FETCH IS NOT AN EMPTY TRANSCRIPT. The old
           \`(r.ok&&r.j&&r.j.events)||[]\` collapsed a 500, a dropped tunnel and
           a logged-out session into the same "No transcript yet." — a
           reassuring sentence about a conversation that is still there. Say
           which happened. */
        if(!r.ok||!r.j){
          logHistFail(r,attempt);
          if(!attempt&&historyRetryable(r.status)){
            histRetryTimer=setTimeout(function(){
              histRetryTimer=null;
              if(!live()||current.sid!==mySid||myGen!==histGen) return;
              loadHistory(botId,mySid,1);
            },HIST_RETRY_MS);
            return;
          }
          appendNote(TRANSCRIPT_FAILED); flushHistBuf([], pair[1].items, null, pair[1].shots); return;
        }
        var events=r.j.events||[];
        if(!events.length){ appendNote(NO_TRANSCRIPT); settleSeamEchoes([]); flushHistBuf([], pair[1].items, null, pair[1].shots); return; }
        var batchTexts=[], userTexts=[];
        /* Review M2: the error a buffered live frame may duplicate is only the
           snapshot's TAIL turn's (an errored message that is the batch's last
           message). An older turn's same-text error must not swallow a newer
           turn's frame — "400 invalid_tools" repeats every turn. */
        var tailErr=null;
        var msgs=events.filter(function(e){ return e&&e.type==='message'; });
        var histCallArgs={};   /* toolCallId -> its arguments, JSON (new mode's agent names) */
        /* Strand 1: pi keeps every errored attempt in the session file and
           its messages carry no turnId. An errored assistant message is the
           TURN's error only when no later assistant message precedes the next
           user message — the live rule (onTurnEnd reads the last one). */
        /* Known edge: a steer queued during a retry's backoff is injected as a
           user message before the retried answer, so the first attempt reads
           as a turn's end here (one extra row on reload). */
        function endsTurn(i){
          for(var j=i+1;j<msgs.length;j++){
            var r=String(((msgs[j]||{}).message||{}).role||'');
            if(r==='user') return true;
            if(r==='assistant') return false;
          }
          return true;
        }
        msgs.forEach(function(e,i){
          var m=e.message||{};
          /* A TOOL RESULT is not bot prose. Rendered as a 'bot' row it dumped
             a whole extracted article (157k chars, literal '#####' and all)
             into the chat on every reload, while the live stream shows the
             same result as a finished chip — so history draws the chip too,
             with the engine's own 2000-char cap (toolResultSnippet). */
          if(String(m.role||'')==='toolResult'){
            var rt=messageText(m);
            if(m.toolCallId!=null) histToolSeen[String(m.toolCallId)]=true;
            var hc={ name:m.toolName, toolCallId:'hist:'+String(m.toolCallId||'') };
            /* New mode: a subagent group names its agents on reload too, from
               the call's own arguments (never shown: history chips carry no args). */
            var ha=SHEET&&isSubagentTool(m.toolName)?histCallArgs[String(m.toolCallId)]:null;
            if(ha!=null) hc.agents=subagentNames(ha);
            appendToolChip(hc);
            finishToolChip({ toolCallId:'hist:'+String(m.toolCallId||''), isError:!!m.isError,
              resultText: rt.length>2000?rt.slice(0,2000)+'\\u2026':rt });
            return;
          }
          /* e.html is present only for an ASSISTANT message that had text
             (routes/perch.js's assistantHtml) — the operator's own typing is
             not markdown, and a pure tool-call message still renders as
             messageText()'s "[tool: name]" line. */
          var txt=messageText(m);
          var errored=String(m.role||'')==='assistant'&&m.stopReason==='error';
          /* R1.2 PR 2, new mode: a reloaded turn reads like the live one. The
             live stream draws an assistant message's TEXT only (the engine's
             assistantTextOf), so the "[tool: x]" lines a pure tool-call
             message rendered here would split one turn's chips into a group
             per call. A user line starts the next turn's groups. */
          if(SHEET){
            var role=String(m.role||'');
            if(role==='assistant'){
              (Array.isArray(m.content)?m.content:[]).forEach(function(b){
                if(b&&b.type==='toolCall'&&b.id!=null){
                  try{ histCallArgs[String(b.id)]=JSON.stringify(b.arguments==null?{}:b.arguments); }catch(x){}
                }
              });
              txt=assistantTextOnly(m);
              if(!txt&&!errored) return;
            } else if(role==='user'){ toolGroup=null; toolTurn++; }
          }
          /* An errored attempt with no text is not a bot message: drawing
             it was the empty bubble every failed turn left behind. */
          if(!(errored&&!txt)){
            var mts=Date.parse(String(e.timestamp||''))||Number(m.timestamp)||0;
            if(String(m.role||'?')!=='user') batchTexts.push(txt); else userTexts.push({text:txt,ts:mts});
            appendMessage(String(m.role||'?')==='user'?'user':'bot', String(m.role||'?'), txt, e.html, mts);
          }
          if(errored&&endsTurn(i)) drawTurnError(e.errorText, null);
          if(i===msgs.length-1) tailErr=errored?String(e.errorText||''):null;
        });
        if(SHEET){ toolGroupsSettleHistory(); histSettledIdle=!turnInFlight&&!stateSeen; }   /* R1.2 PR 2: a reload mid-turn reads "running", whichever arrives first */
        settleSeamEchoes(userTexts);
        flushHistBuf(batchTexts, pair[1].items, tailErr, pair[1].shots);
      });
  }

  /* Queue item 23a (review I2): the operator can send while the history is
     still loading, and the retry made that window ≥1.5 s. pi appends the
     message to the session file when its turn starts, so the batch that
     lands can already hold the line the composer echoed — and the seam
     dedupe (flushHistBuf) never covers user lines. Each echo drawn while the
     seam is open is settled here, just before the flush: matched against
     the batch's trailing user messages — same text AND persisted no earlier
     than 2 s before the send, so an operator repeating an older line
     ("continue" twice) keeps both — it is dropped (pi's copy is in its
     right place); unmatched it moves below the history it follows. */
  function seamEchoMatches(sent,batch){
    if(sent==null||sent===''||batch==null) return false;
    var b=unsentMatchText(batch);
    /* An upload send persists behind its path header (send()). */
    return b===sent||b.slice(-(sent.length+2))==='\\n\\n'+sent;
  }
  function settleSeamEchoes(userTexts){
    var echoes=seamEchoes; seamEchoes=[];
    if(!echoes.length) return;
    var tr=el('perch-transcript');
    var tail=userTexts.slice(-echoes.length);
    echoes.forEach(function(e){
      if(!e.row||!e.row.parentNode) return;
      for(var i=0;i<tail.length;i++){
        /* No timestamp: keep the echo. A duplicate line is harmless; a lost one is not. */
        if(tail[i].ts&&tail[i].ts>=e.sentAt-2000&&seamEchoMatches(e.text,tail[i].text)){ tail.splice(0,i+1); e.row.parentNode.removeChild(e.row); return; }
      }
      if(tr) tr.appendChild(e.row);
    });
    if(tr) tr.scrollTop=tr.scrollHeight;
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
  /* Queue item 23a: the history load token, the one pending retry, and the
     composer echoes drawn while the seam was open (settleSeamEchoes). */
  var histGen=0, histRetryTimer=null, seamEchoes=[];
  var HIST_RETRY_MS=1500;
  /* toolCallIds the history batch drew as chips (flushHistBuf dedupes the
     buffered live tool frames against it). */
  var histToolSeen={};
  /* PR-E: name+stored keys of file cards already rendered THIS transcript —
     dies with the transcript everywhere toolChips does (same seam). */
  var fileSeen={};
  /* Strand 1: turns that already have their danger row on screen. Dies
     with the transcript (reset in loadHistory, like histToolSeen). */
  var renderedErrTurns={};
  function drawTurnError(text,turnId){
    if(turnId){ if(renderedErrTurns[turnId]) return; renderedErrTurns[turnId]=true; }
    var tr=el('perch-transcript'); if(!tr) return;
    var row=document.createElement('div'); row.className='entry turnerr';
    row.appendChild(line('who',TURN_FAILED));
    row.appendChild(line('what',String(text||'')));   /* textContent, never innerHTML */
    tr.appendChild(row);
    tr.scrollTop=tr.scrollHeight;
  }
  function renderTextFrame(d){
    lastSent=null;        /* the bot answered: the last send reached it */
    appendMessage('bot','bot',d.text,d.html);
    if(d.turnId) renderedTurn=d.turnId; else turnRendered=true;
  }
  /* PR-E: a card's identity across the live/replay seam. name+stored, because
     the same original name can be sent twice (the jail stores report.png and
     report-2.png) and both are DISTINCT cards. String()ed explicitly — an
     earlier version of this used a bare pipe (x|''), a BITWISE or that
     collapsed every key to "0|0" and silently dropped the second card of any
     session. */
  function fileKey(d){ return String((d&&d.name)||'')+'|'+String((d&&d.stored)||''); }
  function flushHistBuf(batchTexts, sentFiles, tailErr, shots){
    histSettled=true;
    seamEchoes=[];   /* settled by the caller, or kept in place after a failed load */
    /* PR-E: persisted sent-file cards replay first (they are older context —
       the live buffer below can only hold TODAY's frames), deduped by
       name+stored against buffered frames so a file sent between subscribe and
       this batch lands exactly once. */
    var files=sentFiles||[];
    files.forEach(function(it){
      if(!it||!it.name) return;
      if(it.kind==='browser_shot') return;   /* a browser shot is a tile, never a sent-file card */
      fileSeen[fileKey(it)]=true;
      renderFileCard(it);
    });
    /* Live browser tile: the thread's kept shots, each frozen in its turn's
       place (after its anchor chip, else by created_at), BEFORE the buffered
       live frames replay — a done frame for a shot drawn here is not redrawn. */
    browserHistory(shots||[]);
    var buf=histBuf; histBuf=[];
    buf.forEach(function(f){
      if(f.browserFrame){ browserFrame(f.d); return; }
      if(f.toolFrame){
        var td=f.d||{};
        if(td.toolCallId!=null&&histToolSeen[String(td.toolCallId)]) return;   /* the batch drew it */
        if(td.phase==='start') appendToolChip(td);
        else if(td.phase==='end') finishToolChip(td);
        return;
      }
      if(f.type==='file'){
        if(fileSeen[fileKey(f)]) return;
        renderFileCard(f);
        return;
      }
      if(f.turnErr){
        /* Strand 1: the batch already drew this turn's error from the
           transcript (same server-side redaction, so the text is equal). */
        if(tailErr!=null&&tailErr===String(f.text||'')){ tailErr=null; renderedErrTurns[f.turnId]=true; return; }
        drawTurnError(f.text, f.turnId);
        return;
      }
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
    if(current.sid) replayUnsent(current.sid);
    loadPhoneCards(current.sid);   /* spec 2026-10-01: this chat's call cards, after the transcript and unsent notes */
    loadArtifactCards(current.sid);   /* spec v1.6: this chat's artifact cards, same discipline */
    loadCardOffers(current.sid);   /* P5: pending offers and the card-made notes */
    loadCardChip(current.sid);     /* P5: the card this chat is linked to */
    loadBriefing(current.sid);     /* R1.2 PR 4: the Briefing card on top, the summary in the Session tab */
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
    /* m.label is the server's readable name (perch-model-catalog.js
       pickerModels: the model's name, the provider appended only when two
       entries would read the same). A model pi cannot spawn on says so
       first — that is the reason it cannot be used, whatever answers. */
    var text=(m&&m.label)||(m&&m.name)||((m&&m.provider)+'/'+(m&&m.id));
    if(m&&m.runnable===false) text+=' \\u2014 ${tJs("perch.modelNotRunnable", lang)}';
    else if(m&&m.availability==='on_demand') text+=' \\u2014 ${tJs("perch.modelOnDemand", lang)}';
    else if(m&&m.availability==='unavailable') text+=' \\u2014 ${tJs("perch.modelUnavailable", lang)}';
    return text;
  }

  function modelKeyOf(m){ return (m&&m.provider)+'/'+(m&&m.id); }

  /* Offered by default: pi can spawn on it (runnable is not false) and
     something answers or will start (availability is not "unavailable").
     Everything else waits behind "Show more (N)" — never dropped. */
  function modelOffered(m){
    return !!m&&m.runnable!==false&&m.availability!=='unavailable';
  }

  /* Splits a picker list (already deduped + ordered server-side) into what
     the select shows: the pinned key (the bot's default in the launcher, the
     session's current model in the drawer) first and always, then the
     offered entries by group, and the rest held back for the toggle. */
  function planModelList(list,pinnedKey){
    var plan={pinned:null,network:[],cloud:[],hidden:[]};
    (Array.isArray(list)?list:[]).forEach(function(m){
      if(!m) return;
      if(pinnedKey&&!plan.pinned&&modelKeyOf(m)===pinnedKey){ plan.pinned=m; return; }
      if(!modelOffered(m)) plan.hidden.push(m);
      else if(m.group==='network') plan.network.push(m);
      else plan.cloud.push(m);
    });
    return plan;
  }

  /* Builds one model select from a plan: the "bot's own model" sentinel when
     asked, the pinned entry, then "On your network" and "Cloud" optgroups,
     and the held-back entries as a "Not usable right now" group only when shown. */
  function fillModelSelect(sel,plan,o){
    clearEl(sel);
    if(o.sentinel){
      var none=document.createElement('option');
      none.value='';                                   /* startSession(): falsy => no control() */
      none.textContent=MODEL_BOT_RESOLVES;
      sel.appendChild(none);
    }
    if(plan.pinned){
      var pin=document.createElement('option');
      pin.value=modelKeyOf(plan.pinned);
      pin.textContent=modelOptionText(plan.pinned)+(o.pinnedSuffix||'');
      sel.appendChild(pin);
    }
    function group(label,items){
      if(!items.length) return;
      var g=document.createElement('optgroup');
      g.label=label;
      items.forEach(function(m){
        var opt=document.createElement('option');
        opt.value=modelKeyOf(m);
        opt.textContent=modelOptionText(m);
        g.appendChild(opt);
      });
      sel.appendChild(g);
    }
    group(MODEL_GROUP_NETWORK,plan.network);
    group(MODEL_GROUP_CLOUD,plan.cloud);
    if(o.showAll) group(MODEL_GROUP_UNAVAILABLE,plan.hidden);
  }

  /* The toggle beside a model select: absent when nothing is held back. */
  function syncModelMore(btn,plan,showAll){
    if(!btn) return;
    var n=plan.hidden.length;
    btn.hidden=!n;
    btn.textContent=showAll?MODEL_HIDE_UNAVAILABLE:MODEL_SHOW_UNAVAILABLE+' ('+n+')';
    btn.setAttribute('aria-expanded',showAll?'true':'false');
  }

  function selectHasValue(sel,v){
    for(var i=0;i<sel.options.length;i++){ if(sel.options[i].value===v) return true; }
    return false;
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
    /* Fix round 1 M8: a model the catalogue DOES know (held back behind the
       toggle, or an alias of the pinned entry) reads by its label, not as a
       raw provider/id key. */
    var known=null, dl=(typeof drawerModels==='object'&&drawerModels&&drawerModels.list)||[];
    for(var j=0;j<dl.length;j++){ if(dl[j]&&modelKeyOf(dl[j])===current){ known=dl[j]; break; } }
    opt.textContent=(known?modelOptionText(known):current)+' \u2014 '+MODEL_CURRENT_UNLISTED;
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
    drawerModels.list=models;
    drawerModels.current=(o&&o.current)||null;
    /* Fix round 3 R1: "the bot's own model" (the sentinel) is also the
       REVOCATION option in the session picker (it already means "choose
       nothing" in the launcher). Selecting it POSTs control {model:null}:
       the engine clears the explicit choice and NULLs the row, so the next
       wake re-resolves from the def. Without this, a legacy row stamped
       before the column meant "explicit choice" could never be un-pinned
       from the UI. Same grouped view as the launcher, the session's current
       model pinned first. */
    if(models){
      var plan=planModelList(models,drawerModels.current);
      fillModelSelect(modelSel,plan,{sentinel:true,showAll:drawerModels.showAll});
      syncModelMore(el('perch-model-more'),plan,drawerModels.showAll);
    } else {
      var moreBtn=el('perch-model-more'); if(moreBtn) moreBtn.hidden=true;
    }
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

  /* The drawer's model list as last rendered, for its "Show more"
     toggle (reset per session by resetControls). */
  var drawerModels={list:null,current:null,showAll:false};
  var drawerMore=el('perch-model-more');
  if(drawerMore) drawerMore.onclick=function(){
    var sel=el('perch-model');
    if(!sel||!drawerModels.list) return;
    var keep=String(sel.value||'');
    drawerModels.showAll=!drawerModels.showAll;
    var plan=planModelList(drawerModels.list,drawerModels.current);
    fillModelSelect(sel,plan,{sentinel:true,showAll:drawerModels.showAll});
    syncModelMore(drawerMore,plan,drawerModels.showAll);
    /* Setting .value fires no change event: re-rendering never switches. */
    if(selectHasValue(sel,keep)) sel.value=keep;
    else selectCurrentModel(sel,drawerModels.current);
  };

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
    /* New mode: switchTab('chat') only closes the sheet. sheetTab is kept ON
       PURPOSE, so the sheet reopens on the tab last used, across sessions. */
    var modelSel=el('perch-model'), thinkSel=el('perch-thinking');
    if(modelSel){ clearEl(modelSel); modelSel.disabled=true; }
    if(thinkSel){ clearEl(thinkSel); thinkSel.disabled=true; }
    drawerModels={list:null,current:null,showAll:false};   /* nor its model list or toggle */
    var modelMore=el('perch-model-more'); if(modelMore) modelMore.hidden=true;
    showSessionName(null);       /* the PREVIOUS session's name must not bleed in */
    var permSel=el('perch-permission'); if(permSel) permSel.value='guarded';
    var planCb=el('perch-plan-mode'); if(planCb) planCb.checked=false;
    var cwdEl=el('perch-session-cwd'); if(cwdEl) cwdEl.textContent='';   /* nor its directory */
    cwdPath=''; closeFileViewer();   /* PR-B: nor its cwd browse cursor or open text viewer */
    /* PR-D: nor its narrowing pane — collapse + clear so the next session's
       envelope is fetched fresh, never shown from the previous bot. */
    narrowOpen=false;
    var nb=el('perch-narrow-body'); if(nb){ clearEl(nb); nb.hidden=true; }
    var nt=el('perch-narrow-toggle'); if(nt) nt.setAttribute('aria-expanded','false');
    setTurnInFlight(false);      /* the PREVIOUS session's Steer/Stop state must not bleed in */
    turnRendered=false;          /* nor its "this turn already rendered" bookkeeping */
    renderedTurn=null;           /* nor the turn id that bookkeeping now keys on */
    /* Round 3 R4: nor its history seam — closed again until THIS session's
       batch lands, with any frames still parked in it. */
    histSettled=false;
    histBuf=[];
    cancelHistRetry(); histGen++;   /* 23a: nor its pending history retry or in-flight load */
    seamEchoes=[];
    pendingImages=[];            /* nor its queued-but-unsent image */
    pendingFilePaths=[];         /* nor its queued upload paths (Wave 1) */
    setAttn(false);              /* nor its unanswered-question banner */
    /* Wave 2/3: the new session inherits none of the old one's readings. */
    planState=null; renderPlan();
    toolChips={}; resetToolGroups(); fileSeen={}; commandsCache=null; hideCmdMenu();
    resetPhoneCards();
    resetArtifactCards(); resetCardChip(); resetBriefing();
    resetFacts();
    /* Composer dictation: a switch drops the recording and frees the mic;
       each open re-probes the server (dictation.js). */
    dictationCancel(); dictationProbe();
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
    /* R1.2 PR 2: the turn's "See what happened" groups fold at its end. */
    if(SHEET&&!next&&turnInFlight) toolGroupsEndTurn();
    /* A history batch that settled idle and is followed by the session's
       first state frame saying a turn runs: the replay arrived late, so the
       batch's last turn IS the running one. Its groups go live again
       (toolGroupsSettleHistory) instead of a new turn starting. */
    var lateState=histSettledIdle; histSettledIdle=false;
    if(SHEET&&next&&!turnInFlight){
      if(lateState){ turnInFlight=true; toolGroupsSettleHistory(); }
      else { toolGroup=null; toolTurn++; }
    }
    turnInFlight=next;
    el('perch-send').textContent=turnInFlight?STEER_LABEL:SEND_LABEL;
    el('perch-abort').style.display=turnInFlight?'':'none';
    /* The working strip rides the SAME flag as the composer buttons — one
       source of truth, so the gear and the Steer flip can never disagree. */
    var w=el('perch-working'); if(w) w.hidden=!turnInFlight;
  }

  /* Shell P2: an unsent composer draft survives a reload, a Turbo visit to
     another tab and a switch to another session. Kept per session in
     sessionStorage (this tab only), saved 300 ms after typing stops and at
     once on turbo:before-visit and pagehide, restored when that session
     opens, and cleared when a send succeeds. Storage that throws (blocked,
     private mode) just means no drafts: the composer works as before. */
  var DRAFT_PREFIX='perch-draft:';
  /* The text of a send that has gone out and not yet been answered, per
     session. A reload mid-send never sees the answer, so the restored draft
     can be words the bot already has: it is restored anyway (never dropped
     silently) with a note. Cleared on success and on a refusal; a lost
     connection (status 0) is ambiguous, so it stays. */
  var INFLIGHT_PREFIX='perch-inflight:';
  var sendingNow={};                      /* sid -> true while THIS page awaits that send's answer */
  var draftTimer=null;
  function draftStore(){ try{ return window.sessionStorage||null; }catch(e){ return null; } }
  function draftCancel(){ if(draftTimer){ clearTimeout(draftTimer); draftTimer=null; } }
  function inflightGet(store,sid){ try{ return store.getItem(INFLIGHT_PREFIX+sid); }catch(e){ return null; } }
  function inflightMark(sid,text){
    var store=draftStore(); if(!store||!sid) return;
    try{ store.setItem(INFLIGHT_PREFIX+sid,String(text)); }catch(e){}
  }
  function inflightClear(sid){
    var store=draftStore(); if(!store||!sid) return;
    try{ store.removeItem(INFLIGHT_PREFIX+sid); }catch(e){}
  }
  function draftNote(show){ var n=el('perch-draft-note'); if(n){ n.hidden=!show; n.textContent=show?DRAFT_MAYBE_SENT:''; } }
  function draftSave(){
    draftCancel();
    var sid=current.sid, input=el('perch-input'), store=draftStore();
    if(!sid||!input||!store) return;
    var v=String(input.value==null?'':input.value);
    try{
      if(v.trim()) store.setItem(DRAFT_PREFIX+sid,v);
      else {
        /* An empty composer during a send is not an empty draft: leaving the
           page now must keep the words that are still in flight. */
        var fl=inflightGet(store,sid);
        if(fl&&fl.trim()) store.setItem(DRAFT_PREFIX+sid,fl); else store.removeItem(DRAFT_PREFIX+sid);
      }
    }catch(e){}
  }
  function draftSaveSoon(){
    draftCancel();
    draftTimer=setTimeout(function(){ draftTimer=null; if(live()) draftSave(); },300);
  }
  function draftRestore(sid){
    draftCancel();
    var input=el('perch-input'), store=draftStore();
    draftNote(false);
    if(!input||!store) return;              /* no storage: leave the composer exactly as it was */
    var v=null;
    try{ v=store.getItem(DRAFT_PREFIX+sid); }catch(e){ return; }
    input.value=v==null?'':String(v);
    input.style.height='auto';
    if(v) input.style.height=Math.min(input.scrollHeight||72,120)+'px';
    if(v&&PILL) input.style.height=(input.scrollHeight||44)+'px';
    /* A marker this page is not itself waiting on belongs to a send that was
       cut off by a reload: if the draft is that very text, say so. */
    if(!sendingNow[sid]){
      var fl=inflightGet(store,sid);
      if(fl!=null){
        if(v!=null&&String(v)===fl) draftNote(true);
        inflightClear(sid);
      }
    }
  }
  /* Clears only the draft that was sent: a late success must not delete
     words typed (and saved) after the send went out. */
  function draftClear(sid,sentText){
    var store=draftStore(); if(!store||!sid) return;
    try{ if(store.getItem(DRAFT_PREFIX+sid)===String(sentText)) store.removeItem(DRAFT_PREFIX+sid); }catch(e){}
  }
  /* A send that did not land (any non-2xx, or the network failing) gives
     the words back: into the composer when that session is still open and
     the composer is empty, else into its stored draft if it has none. */
  function draftKeepUnsent(sid,text){
    var input=el('perch-input');
    if(current.sid===sid&&input){
      if(!String(input.value==null?'':input.value).trim()) input.value=text;
      draftSave();
      return;
    }
    var store=draftStore(); if(!store||!sid) return;
    try{ if(store.getItem(DRAFT_PREFIX+sid)==null) store.setItem(DRAFT_PREFIX+sid,String(text)); }catch(e){}
  }
  bindOnce(document,'turbo:before-visit','draftBeforeVisit',function(){ if(live()) draftSave(); });
  bindOnce(window,'pagehide','draftPagehide',function(){ if(live()) draftSave(); });

  function send(){
    histSettledIdle=false;                 /* a turn the operator starts is a new turn */
    var input=el('perch-input'); if(!input) return;
    var text=input.value;
    if(!sendable(text)||!current.sid) return;
    var mySid=current.sid;
    appendMessage('user','you',text);      /* echo before the round trip */
    /* 23a: an echo drawn before the history lands is settled against it. */
    if(!histSettled){ var trE=el('perch-transcript'); if(trE&&trE.lastElementChild) seamEchoes.push({text:text,row:trE.lastElementChild,sentAt:Date.now()}); }
    input.value='';
    draftCancel();                         /* Shell P2: the draft stays stored until the send succeeds */
    draftNote(false);
    /* Shell P2: the words are in flight. Stored as the draft too, so a reload
       before the answer restores them (with a note) instead of losing them. */
    sendingNow[mySid]=true;
    inflightMark(mySid,text);
    var dst=draftStore();
    if(dst){ try{ dst.setItem(DRAFT_PREFIX+mySid,String(text)); }catch(e){} }
    input.style.height='auto';             /* Wave 1: the auto-grow collapses back after a send */
    var body={message:text};
    hideCmdMenu();                         /* Wave 3: a sent command closes its own menu */
    /* Wave 1: non-image uploads ride the message as PATHS — the file is
       already in the session's uploadsDir on this machine, and pi's read
       tool is not write-jailed, so the bot can open what the operator
       attached. The local echo stays the operator's own words; the prefix
       is for the model, not for the human. */
    if(pendingFilePaths.length){
      body.message=UPLOADED_HEADER+'\\n'+pendingFilePaths.map(function(p){return '- '+p;}).join('\\n')+'\\n\\n'+text;
    }
    /* routes/perch-interactive-api.js's normalizeMessageImages reads
       body.images on /message only — /steer never looks at it, so attaching
       here regardless of path is harmless on a steer. Cleared immediately,
       matching the textarea's own discipline: a failed send still consumes
       the queue, and re-attaching is one tap away. */
    if(pendingImages.length) body.images=pendingImages;
    pendingImages=[];
    pendingFilePaths=[];
    var rec={sid:mySid,text:text,counted:false,failed:false};
    lastSent=rec;
    perchApi('POST',sendPath(mySid,turnInFlight),body).then(function(r){
      /* B5: a 2xx means pi took this message — every older unsent message
         of this session now has one more delivered message AFTER it, which
         is how replayUnsent finds its place again. Counted before the
         identity guard: it is this session's bookkeeping, viewed or not. */
      if(r.ok&&!rec.failed){ rec.counted=true; bumpUnsentAfter(mySid,1); }
      /* Shell P2: delivered, so it is no longer a draft; refused or lost,
         the words come back so a reload cannot drop them. */
      delete sendingNow[mySid];
      if(r.ok||r.status>0) inflightClear(mySid);   /* answered; a lost connection (0) stays ambiguous */
      if(r.ok) draftClear(mySid,text); else draftKeepUnsent(mySid,text);
      if(current.sid!==mySid) return;
      var code=r.j&&r.j.error;
      /* Only a REAL turn race means "a turn is running" — every other 409
         (pi_gone above all: the bot's child died before the turn started) was
         read as one, flipping the composer to Steer and saying nothing. */
      if(r.status===409&&(code==='turn_in_progress'||!code)){ setTurnInFlight(true); return; }
      if(code==='pi_gone'){ showSendFailure(mySid,(r.j&&r.j.detail)||code); return; }
      /* Strand 2: the session's model can't take this bot's tools. The bot
         DID start, so no "could not start" label — the engine's sentence
         (model, both numbers, the ways out) is the whole note. */
      if(code==='tool_budget'){ showSendFailure(mySid,(r.j&&r.j.detail)||code,true); return; }
      if(!r.ok) appendNote(code||SEND_FAILED);
    });
  }

  /* A send whose bot could not start. The operator's own words STAY in the
     transcript (a reconnect's resyncHistory rebuilds it from pi's on-disk
     transcript, which never received them, so they are replayed from here),
     followed by the reason.
     Only while a send is OUTSTANDING: an exit with nothing pending (an idle
     child reaped, an OOM after the bot already answered) is not a send
     failure and stays on the Activity rail. One failure per send: the POST's
     pi_gone and the stream's pi_exit frame describe the same death, and
     whichever lands first consumes lastSent. */
  var lastSent=null;      /* {sid,text,counted,failed} of the last message sent, until a reply proves pi got it */
  /* sid -> [{text,note,after}] messages that never reached the bot. \`after\`
     counts the messages pi DID receive after this one; it anchors the
     replay to its original place, counted from the END of the rebuilt
     transcript so a tail-trimmed history cannot shift it. */
  var unsent={};
  function bumpUnsentAfter(sid,delta){
    (unsent[sid]||[]).forEach(function(u){ u.after=Math.max(0,(u.after||0)+delta); });
  }
  function showSendFailure(sid,detail,bare){
    if(!lastSent||lastSent.sid!==sid) return;
    var rec=lastSent;
    var sent=rec.text;
    lastSent=null;
    rec.failed=true;
    /* A POST that 2xx'd before the child died stays COUNTED: pi persists the
       user message at turn start (agent-session appendMessage on the user
       message_end), so it IS in the on-disk transcript. It is still kept as
       unsent — the death may have come before pi wrote it — but flagged, so
       replayUnsent drops it when the rebuilt transcript already has it. */
    var note=bare?String(detail||''):BOT_START_FAILED+' '+String(detail||'');
    appendNote(note);
    if(sent==null||sent==='') return;
    (unsent[sid]=unsent[sid]||[]).push({text:sent,note:note,after:0,maybeDelivered:!!rec.counted});
  }
  /* B5: replayed at its ORIGINAL position, not at the end. A message with
     \`after\` = k delivered messages behind it goes right before the k-th
     user message from the end of the rebuilt transcript (so after the
     replies to the message before it); k = 0 means it was the newest, and
     the end is its place. The user rows are read before any replay lands, so
     they are exactly pi's own. */
  /* The .what line of a transcript row (its text, without the who label). */
  function rowWhatText(row){
    var kids=(row&&row.children)||[];
    for(var i=0;i<kids.length;i++){
      if((' '+String(kids[i].className||'')+' ').indexOf(' what ')>=0) return String(kids[i].textContent||'');
    }
    return null;
  }
  /* A history row's text as the operator typed it: messageText() renders a
     non-text block (an attached image) as its own trailing "[image]" line,
     so a text+image send persists as "text\\n[image]". Strip trailing
     [type] placeholder lines before the dedupe's tail match. */
  function unsentMatchText(t){
    if(t==null) return null;
    var lines=String(t).split('\\n');
    while(lines.length&&/^\\[[a-zA-Z_]+\\]$/.test(lines[lines.length-1])) lines.pop();
    return lines.join('\\n');
  }
  function replayUnsent(sid){
    var list=unsent[sid]||[];
    if(!list.length) return;
    var tr=el('perch-transcript');
    var users=[];
    if(tr){
      for(var i=0;i<tr.children.length;i++){
        if((' '+String(tr.children[i].className||'')+' ').indexOf(' user ')>=0) users.push(tr.children[i]);
      }
    }
    /* Newest first, decide each entry's effective anchor and whether pi
       already has it. A maybe-delivered message (2xx, then the child died)
       that pi DID persist is the user row right before its anchor: drop it.
       Tail match — the history copy carries the upload-paths header when
       files rode along. One that pi did NOT persist was counted as delivered
       by every older entry, so they take one back off. Only flagged entries
       are deduped: a refused send (pi_gone) never reached pi, and the
       operator may well have typed the same words twice.
       Known limit: identical consecutive texts where the first was persisted
       and the second 2xx'd but died before pi wrote it — the second's echo is
       dropped (pi never had it either way; its reason stays on the rail). */
    var plan=[], missing=0;
    for(var k=list.length-1;k>=0;k--){
      var e=list[k], eff=Math.max(0,(e.after||0)-missing), skip=false;
      if(e.maybeDelivered){
        var prev=users[users.length-eff-1];
        var pt=prev?unsentMatchText(rowWhatText(prev)):null;
        if(pt!=null&&e.text&&pt.slice(-e.text.length)===e.text) skip=true;
        else missing++;
      }
      plan[k]={text:e.text,note:e.note,after:eff,skip:skip};
    }
    plan.forEach(function(u){
      if(u.skip) return;
      appendMessage('user','you',u.text);
      appendNote(u.note);
      if(!tr||!u.after||!users.length) return;
      var ref=users[Math.max(0,users.length-u.after)];
      var kids=tr.children;
      var noteRow=kids[kids.length-1], msgRow=kids[kids.length-2];
      tr.removeChild(noteRow); tr.removeChild(msgRow);
      tr.insertBefore(msgRow,ref); tr.insertBefore(noteRow,ref);
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
    if(card.method==='questions'){ out.answers=(choice&&choice.answers)||[]; return out; }
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
      setAttn(false);                          /* the banner dies with the card */
      /* request_expired: the question timed out or the turn was parked
         before this answer arrived — nothing was run, and the note says so. */
      if(r.status===409) appendNote(r.j&&r.j.error==='request_expired'?ASK_EXPIRED:ASK_STALE);
    });
  }

  /* Writes into #perch-ask, which sits ABOVE the sticky composer: an
     ask_user frame blocks the turn until answered, so it must not be
     scrollable past inside the transcript. Built with createElement/
     textContent only — never innerHTML. */
  function setAttn(show){ var b=el('perch-attn'); if(b) b.hidden=!show; }
  /* A card opening takes height from the transcript, which keeps its old
     scrollTop and so shows an older slice; re-pin it to the newest row (the
     running ask_user chip that explains the card). */
  function pinTranscript(){ var tr=el('perch-transcript'); if(tr) tr.scrollTop=tr.scrollHeight; }
  var askShown=null;                         /* the card on screen, for ask_expired */
  function renderAsk(card){
    var pane=el('perch-ask'); if(!pane) return;
    clearEl(pane);
    askShown=card&&card.requestId?card:null;
    if(!card||!card.requestId){ setAttn(false); return; }
    /* New mode: an ask is never hidden (spec 9.4). The card and the banner
       live in the chat, which the modal sheet makes inert, so it closes. */
    if(SHEET&&SHEET.open) closeSheet();
    /* R1.2 PR 5: so does the apps sheet. The browser hands focus back to the
       apps button as the modal closes, so the ask takes it once its card is
       drawn (the ask, not the apps button, is what needs the operator). */
    if(APPS_SHEET&&APPS_SHEET.open){
      appsSkipFocus=true; closeAppsSheet();
      setTimeout(function(){
        if(!live()) return;
        var f=document.querySelector('#perch-ask button,#perch-ask input,#perch-ask textarea,#perch-ask select');
        if(f&&f.focus) f.focus();
      },0);
    }
    plusClose(false);                        /* nor under the composer's "+" popover */
    /* 2026-10-20: an expired question stays on screen, read-only, so the
       operator sees what was asked; the session still waits for them. */
    if(card.expired){
      var xf=document.createElement('div'); xf.className='ask-card ask-card-expired';
      var xt=card.title||(card.questions&&card.questions[0]&&card.questions[0].question)||'';
      if(xt) xf.appendChild(line('ask-title',xt));
      if(card.message) xf.appendChild(line('ask-message',card.message));
      xf.appendChild(line('ask-expired',ASK_EXPIRED));
      pane.appendChild(xf);
      setAttn(true);
      pinTranscript();
      return;
    }
    /* PR-A: the combined multi-question card gets its own layout. */
    if(card.method==='questions'){ renderAskCombined(pane,card); return; }
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
    setAttn(true);                             /* Wave 1: say why the bot went quiet */
    pinTranscript();
  }

  /* PR-A (audit item 5): the combined multi-question ask card. Renders every
     question at once — optional header chip, question text, tappable options
     (bold label + dim description), an "Other…" free-text field — behind ONE
     Send-answers action. Submitting posts answers[] once; the engine replays
     them into the child's blocking dialog queue (the answer dance). Mirrors
     pi-lab's AskCard. Built with createElement/textContent only — never
     innerHTML — and className (not classList) to match the rest of the file.
     No async continuation lives here: the only POST is answerAsk's, which
     already carries the mySid identity guard. */
  function renderAskCombined(pane,card){
    var qs=Array.isArray(card.questions)?card.questions:[];
    if(!qs.length&&!card.message){ setAttn(false); return; }
    var frame=document.createElement('div'); frame.className='ask-card ask-combined';
    /* The engine's note (secrets hidden / possible secret shown), or why a
       card that could not be masked in full shows no questions. */
    if(card.message) frame.appendChild(line('ask-message',card.message));
    if(!qs.length){
      var nf=document.createElement('div'); nf.className='ask-foot';
      var nc=document.createElement('button'); nc.type='button'; nc.className='quiet'; nc.textContent=ASK_CANCEL;
      nc.onclick=function(){ answerAsk(card,{cancelled:true}); };
      nf.appendChild(nc); frame.appendChild(nf);
      pane.appendChild(frame);
      setAttn(true);
      pinTranscript();
      return;
    }
    /* The questions live in their own scroller (.ask-body) so that, when the
       pane is short (a phone), the options scroll and the Send / Cancel foot
       below stays on screen — css.js's "THE ASK PANE FITS ITS SPACE". */
    var qbody=document.createElement('div'); qbody.className='ask-body';
    var sel=qs.map(function(){ return []; });
    var other=qs.map(function(){ return ''; });
    var optBtns=qs.map(function(){ return []; });   /* per question: [{btn,label}] */
    var sent=false;
    var sendBtn=null;

    function ready(){
      return qs.every(function(q,i){ return sel[i].length>0 || (other[i]&&other[i].trim()!==''); });
    }
    function repaint(qi){
      optBtns[qi].forEach(function(ob){
        ob.btn.className=(sel[qi].indexOf(ob.label)>=0)?'ask-opt sel':'ask-opt';
      });
    }
    function refresh(){ if(sendBtn) sendBtn.disabled=(!ready()||sent); }

    qs.forEach(function(q,qi){
      var qd=document.createElement('div'); qd.className='ask-q';
      if(q.header){ var h=document.createElement('span'); h.className='ask-h'; h.textContent=String(q.header); qd.appendChild(h); }
      var t=document.createElement('div'); t.className='ask-t'; t.textContent=(q.question==null?'':String(q.question));
      if(q.multiSelect){ var mh=document.createElement('span'); mh.className='ask-multi'; mh.textContent=' '+ASK_MULTI_HINT; t.appendChild(mh); }
      qd.appendChild(t);
      var opts=document.createElement('div'); opts.className='ask-opts';
      (Array.isArray(q.options)?q.options:[]).forEach(function(o){
        var label=(o&&o.label!=null)?String(o.label):'';
        var b=document.createElement('button'); b.type='button'; b.className='ask-opt';
        var lb=document.createElement('b'); lb.textContent=label; b.appendChild(lb);
        if(o&&o.description){ var sp=document.createElement('span'); sp.textContent=String(o.description); b.appendChild(sp); }
        b.onclick=function(){
          if(sent) return;
          if(q.multiSelect){
            var ix=sel[qi].indexOf(label);
            if(ix>=0) sel[qi].splice(ix,1); else sel[qi].push(label);
          } else {
            sel[qi]=(sel[qi].indexOf(label)>=0)?[]:[label];
          }
          repaint(qi); refresh();
        };
        opts.appendChild(b);
        optBtns[qi].push({btn:b,label:label});
      });
      qd.appendChild(opts);
      var oi=document.createElement('input'); oi.type='text'; oi.className='ask-other'; oi.placeholder=ASK_OTHER_PH;
      oi.oninput=function(){ other[qi]=oi.value; refresh(); };
      qd.appendChild(oi);
      qbody.appendChild(qd);
    });
    frame.appendChild(qbody);

    var foot=document.createElement('div'); foot.className='ask-foot';
    sendBtn=document.createElement('button'); sendBtn.type='button'; sendBtn.className='ask-send primary';
    sendBtn.textContent=(qs.length>1?ASK_SEND_ANSWERS:ASK_SEND_ANSWER);
    sendBtn.disabled=true;
    sendBtn.onclick=function(){
      if(!ready()||sent) return;
      sent=true; sendBtn.disabled=true; sendBtn.textContent=ASK_SENDING;
      var answers=qs.map(function(q,i){
        var oth=(other[i]&&other[i].trim()!=='')?other[i].trim():null;
        return { question:(q.question==null?'':String(q.question)), selected:sel[i].slice(), other:oth };
      });
      answerAsk(card,{answers:answers});
    };
    var cancel=document.createElement('button'); cancel.type='button'; cancel.className='quiet'; cancel.textContent=ASK_CANCEL;
    cancel.onclick=function(){ if(sent) return; answerAsk(card,{cancelled:true}); };
    foot.appendChild(sendBtn); foot.appendChild(cancel);
    frame.appendChild(foot);

    pane.appendChild(frame);
    setAttn(true);
    pinTranscript();
    refresh();
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
          /* Images queue onto send()'s pendingImages in pi's wire shape
             {mime,data_b64}. Everything else queues its on-disk PATH
             (Wave 1): the upload landed in uploadsDir, and a path in the
             next message is what turns it from stored bytes into something
             the bot can actually read. */
          if(isImage) pendingImages.push({mime:file.type,data_b64:b64});
          else if(r.j&&r.j.full_path) pendingFilePaths.push(r.j.full_path);
          appendNote(isImage?FILE_QUEUED:FILE_QUEUED_PATH);
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

  /* R1.2 PR 2, new mode: the composer's "+" popover (html.js pillRow). It
     holds Attach and Dictate; it is a popover, not a modal: Escape closes it
     and returns focus to "+", a tap outside closes it, and focus is never
     trapped. "+" hides when neither entry is available, and re-checks when
     dictation's probe shows or hides the mic (dictShowMic calls plusSync). */
  var plusBtn=el('perch-plus'), plusMenu=el('perch-plus-menu');
  function plusSync(){
    if(!plusBtn||!plusMenu) return;
    var mic=el('perch-dictate');
    var any=!!attachBtn||!!(mic&&!mic.hidden);
    plusBtn.hidden=!any;
    if(!any) plusClose(false);
  }
  function plusClose(refocus){
    if(!plusBtn||!plusMenu||plusMenu.hidden) return;
    plusMenu.hidden=true;
    plusBtn.setAttribute('aria-expanded','false');
    if(refocus&&plusBtn.focus) plusBtn.focus();
  }
  /* A disclosure, not a menu widget (no aria-haspopup): opening it moves
     focus to its first visible entry. */
  function plusFirstItem(){
    var bs=plusMenu?plusMenu.querySelectorAll('button'):[];
    for(var i=0;i<bs.length;i++){ if(!bs[i].hidden) return bs[i]; }
    return null;
  }
  if(plusBtn&&plusMenu){
    plusBtn.onclick=function(){
      if(plusMenu.hidden){
        plusMenu.hidden=false; plusBtn.setAttribute('aria-expanded','true');
        var first=plusFirstItem(); if(first&&first.focus) first.focus();
      }
      else plusClose(false);
    };
    plusMenu.addEventListener('click',function(e){
      var b=e.target&&e.target.closest?e.target.closest('button'):null;
      if(!b) return;
      plusClose(false);                    /* choosing an entry closes the menu */
      /* The chosen entry just hid with the menu: focus that was left on it
         (or fell to the page) goes to the composer. A control the choice
         focused on purpose keeps it. */
      var a=document.activeElement;
      if(!a||a===document.body||a===b||plusMenu.contains(a)){
        var ci=el('perch-input'); if(ci&&ci.focus) ci.focus();
      }
    });
    bindOnce(document,'keydown','plusEsc',function(e){
      if(e.key==='Escape'&&plusMenu&&!plusMenu.hidden){ plusClose(true); }
    });
    bindOnce(document,'pointerdown','plusOutside',function(e){
      if(!plusMenu||plusMenu.hidden) return;
      var tg=e.target;
      if(plusMenu.contains(tg)||plusBtn.contains(tg)) return;
      plusClose(false);
    });
    /* Focus leaving the composer closes the menu (never steals focus). */
    var plusComposer=el('perch-composer');
    if(plusComposer) plusComposer.addEventListener('focusout',function(e){
      var to=e.relatedTarget;
      if(to&&plusComposer.contains(to)) return;
      plusClose(false);
    });
    plusSync();
  }

  /* Carried-over fix: send(), closeSession() and the abort path were all
     written by an earlier task but never connected to the DOM — the chat
     view rendered and Send did nothing. #perch-back sets location.hash=''
     rather than calling closeSession() directly, so applyHash -> hashchange
     -> closeSession runs and browser history stays correct. */
  el('perch-send').onclick=send;
  /* Wave 1: Enter sends, Shift+Enter newlines (pi-lab's composer rule
     verbatim — phone soft keyboards included, which is what its own
     mobile-first page ships), and the textarea grows with its content up
     to the CSS 120px ceiling, then scrolls inside itself. */
  var composerInput=el('perch-input');
  if(composerInput){
    composerInput.onkeydown=function(ev){
      if(ev&&ev.key==='Enter'&&!ev.shiftKey){
        if(ev.preventDefault) ev.preventDefault();
        send();
      }
    };
    composerInput.oninput=function(){
      this.style.height='auto';
      this.style.height=Math.min(this.scrollHeight||72,120)+'px';
      if(PILL) this.style.height=(this.scrollHeight||44)+'px';       /* the pill's CSS caps it at five lines */
      maybeCmdMenu(this.value);            /* Wave 3: '/' opens the command menu */
      draftSaveSoon();                     /* Shell P2: the unsent draft survives a reload */
    };
  }
  el('perch-back').onclick=function(){ location.hash=''; };
  /* New mode with a filed session: Back goes to its project's home instead.
     Unfiled (and classic, which has no sheet) keeps the hash route above. */
  if(el('perch-session-sheet')) el('perch-back').onclick=function(){
    var to=backTarget(rowIndex[current.sid],PROJECTS);
    if(to) location.href=to; else location.hash='';
  };
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
  /* R1.2 PR 2, new mode only: no tab bar. Session, Files and Activity live
     in the #perch-session-sheet dialog, opened from the bot's name, and the
     chat is ALWAYS on screen behind it. Its presence is the marker (html.js
     renders it only when the panel hands in a scope). In that mode 'chat'
     means "back to the conversation": the sheet closes and the last-used
     sheet tab is kept for the next open. */
  var SHEET=el('perch-session-sheet');
  var sheetTab='session';
  /* One-shot: the next close event leaves focus alone. Set when the sheet
     closes to hand focus to something else (the browse picker): close()
     queues the event, so its refocus would land AFTER the picker took focus. */
  var sheetSkipFocus=false;
  function switchTab(name){
    if(TAB_NAMES.indexOf(name)<0) name='chat';
    if(SHEET&&name==='chat'){ closeSheet(); return; }
    tab=name;
    if(SHEET) sheetTab=name;
    TAB_NAMES.forEach(function(nm){
      if(SHEET&&nm==='chat') return;          /* the chat never hides in new mode */
      var sec=el('perch-tab-'+nm), btn=el('perch-tab-btn-'+nm);
      if(sec) sec.hidden=(nm!==name);
      if(btn) btn.setAttribute('aria-selected',nm===name?'true':'false');
    });
    /* Files fetches on ACTIVATION, never on session open (D3) — the chat
       fast path stays one less round trip. */
    if(name==='files'){ loadCwd(cwdPath); loadFiles(); }
    bfResize();                   /* the floating browser preview's default spot follows the bottom bars */
  }
  TAB_NAMES.forEach(function(nm){
    var btn=el('perch-tab-btn-'+nm);
    if(btn) btn.onclick=function(){ switchTab(nm); };
  });
  /* The sheet follows the shell sheets (shell/client.js): showModal, so
     Escape is native; a click whose target is the dialog itself landed on
     the backdrop (.perch-sheet-inner fills the box); the close button; and
     focus returns to the bot-name button on every close path. */
  function closeSheet(){
    if(!SHEET||!SHEET.open) return;
    if(typeof SHEET.close==='function'){ SHEET.close(); return; }
    SHEET.removeAttribute('open');
    var b=el('perch-ident-btn'); if(current.sid&&b&&b.focus) b.focus();
  }
  function openSheet(){
    if(!SHEET||SHEET.open) return;
    switchTab(sheetTab);
    if(typeof SHEET.showModal==='function') SHEET.showModal();
    else SHEET.setAttribute('open','');
    var sel=el('perch-tab-btn-'+sheetTab); if(sel&&sel.focus) sel.focus();
  }
  if(SHEET){
    var identBtn=el('perch-ident-btn');
    if(identBtn) identBtn.onclick=openSheet;
    var sheetCloseBtn=el('perch-sheet-close');
    if(sheetCloseBtn) sheetCloseBtn.onclick=closeSheet;
    SHEET.addEventListener('click',function(e){ if(e.target===SHEET) closeSheet(); });
    SHEET.addEventListener('close',function(){
      /* A late close event (it fires a task after close()) that lands after
         a quick reopen belongs to the sheet that already closed: leave the
         reopened sheet and its focus alone (the apps sheet's rule below). */
      if(SHEET.open){ sheetSkipFocus=false; return; }
      if(sheetSkipFocus){ sheetSkipFocus=false; return; }
      if(!current.sid) return;              /* closed by leaving the session: the list owns focus */
      /* The shell sheets' rule: return focus only when it is PARKED (nowhere,
         on body/html, or still inside the closing dialog). A control that
         took focus right after the close keeps it. */
      var a=document.activeElement;
      if(a&&a!==document.body&&a!==document.documentElement&&!SHEET.contains(a)) return;
      var b=el('perch-ident-btn');
      if(b&&document.contains(b)&&b.focus) b.focus();
    });
    /* Turbo snapshots the body before it leaves; an open modal in that
       snapshot comes back open on Back. Once per document, like the shell's
       own guard, and it resolves the sheet by id at call time. */
    if(!HUB.sheetCacheBound){
      HUB.sheetCacheBound=true;
      document.addEventListener('turbo:before-cache',function(){
        var d=document.getElementById('perch-session-sheet');
        if(d&&d.open&&typeof d.close==='function') d.close();
        var ad=document.getElementById('perch-apps-sheet');
        if(ad&&ad.open&&typeof ad.close==='function') ad.close();
        /* R1.2 PR 3: a cached snapshot never carries the card-scoped Make link. */
        var m=document.querySelector('a.shell-tab[data-shell-tab="make"]');
        var base=m&&m.getAttribute('data-shell-href');
        if(base!=null) m.setAttribute('href',base);
      });
    }
  }

  /* ---- R1.2 PR 5: the session's apps sheet ------------------------------
     #perch-apps-btn (head, filed sessions only) opens #perch-apps-sheet, which
     lists the session's project's apps through the shell's launcher
     (window.CrowApps, shell/client.js: GET /dashboard/shell-api/apps, the
     drawer's tile renderer). Opening a desktop app there asks this session
     for an app tile (crow:open-app-tile) and the shell closes the sheet when
     it is handled; otherwise the link navigates. The sheet follows the
     session sheet's rules: showModal, backdrop and close button, focus back
     to the apps button when it is parked. */
  var APPS_SHEET=el('perch-apps-sheet');
  var appsGen=0;
  var appsSkipFocus=false;                  /* one-shot: the next close leaves focus alone (renderAsk) */
  function closeAppsSheet(){
    if(!APPS_SHEET||!APPS_SHEET.open) return;
    if(typeof APPS_SHEET.close==='function'){ APPS_SHEET.close(); return; }
    APPS_SHEET.removeAttribute('open');
  }
  function appsNote(grid,text){
    while(grid.firstChild) grid.removeChild(grid.firstChild);
    var p=document.createElement('p'); p.className='shell-apps-empty'; p.textContent=text; grid.appendChild(p);
  }
  function openAppsSheet(){
    if(!APPS_SHEET||APPS_SHEET.open) return;
    var grid=el('perch-apps-grid');
    var pr=projectOfRow(rowIndex[current.sid],PROJECTS);
    if(!grid||!pr) return;
    plusClose(false);                        /* never under the composer's "+" popover */
    var my=++appsGen;
    appsNote(grid,APPS_LOADING);
    if(typeof APPS_SHEET.showModal==='function') APPS_SHEET.showModal();
    else APPS_SHEET.setAttribute('open','');
    var c=el('perch-apps-close'); if(c&&c.focus) c.focus();
    var api=window.CrowApps;
    if(!api){ appsNote(grid,APPS_FAILED); return; }
    api.load(pr.slug).then(function(data){
      if(my!==appsGen) return;
      api.render(grid,data,{empty:APPS_EMPTY});
    },function(){
      if(my!==appsGen) return;
      appsNote(grid,APPS_FAILED);
    });
  }
  if(APPS_SHEET){
    var appsBtnEl=el('perch-apps-btn');
    if(appsBtnEl) appsBtnEl.onclick=openAppsSheet;
    var appsCloseBtn=el('perch-apps-close');
    if(appsCloseBtn) appsCloseBtn.onclick=closeAppsSheet;
    APPS_SHEET.addEventListener('click',function(e){ if(e.target===APPS_SHEET) closeAppsSheet(); });
    APPS_SHEET.addEventListener('close',function(){
      /* The close event fires a task after close() (the browser hands focus
         back inside close() itself), so a quick reopen can run first. Open
         again means this event belongs to the sheet that already closed: it
         must not drop the reopened sheet's answer or pull focus out of it. */
      if(APPS_SHEET.open){ appsSkipFocus=false; return; }
      appsGen++;                            /* a late answer never paints a closed sheet */
      if(appsSkipFocus){ appsSkipFocus=false; return; }
      if(!current.sid) return;              /* closed by leaving the session: the list owns focus */
      var a=document.activeElement;
      if(a&&a!==document.body&&a!==document.documentElement&&!APPS_SHEET.contains(a)) return;
      var b=el('perch-apps-btn');
      if(b&&!b.hidden&&document.contains(b)&&b.focus) b.focus();
    });
  }

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

  /* ---- Phase D3: the Files tab ------------------------------------------
     One GET /interactive/<sid>/files/list per activation (never on session
     open), rows linking the EXISTING workspace download route — the list
     adds no new serving path, and the jail's O_NOFOLLOW fd discipline is
     what makes each download safe, not anything about this markup. Rows are
     built with createElement/textContent only: names come from a filesystem
     a bot child can write to. */
  function fmtSize(b){
    b=Number(b)||0;
    return b>1048576?(b/1048576).toFixed(1)+'M':b>1024?Math.round(b/1024)+'K':b+'B';
  }
  function loadFiles(){
    var list=el('perch-files-list');
    if(!list||!current.sid) return;
    var mySid=current.sid;
    perchApi('GET','/interactive/'+encodeURIComponent(mySid)+'/files/list').then(function(r){
      if(current.sid!==mySid) return;                  /* identity guard, as everywhere */
      clearEl(list);
      if(!r.ok||!r.j||!Array.isArray(r.j.items)){ list.appendChild(line('empty',FILES_FAILED)); return; }
      if(!r.j.items.length){ list.appendChild(line('empty',FILES_EMPTY)); return; }
      r.j.items.forEach(function(it){
        if(!it||!it.name) return;
        var a=document.createElement('a'); a.className='file-row';
        a.href=API+'/interactive/'+encodeURIComponent(mySid)+'/workspace/'+encodeURIComponent(it.name);
        a.appendChild(line('file-name',it.name));
        var meta=fmtSize(it.size);
        try{ meta+=' \\u00b7 '+new Date(it.mtime).toLocaleString(); }catch(e){}
        a.appendChild(line('file-meta',meta));
        list.appendChild(a);
      });
    });
  }
  var filesRefresh=el('perch-files-refresh');
  if(filesRefresh) filesRefresh.onclick=function(){ loadCwd(cwdPath); loadFiles(); };

  /* ---- PR-B (audit item 18): read-only cwd browser + in-app text viewer ----
     The Files tab's TOP pane walks the session's OWN cwd (server-jailed under
     it via realpath; the uploadsDir is never listed). A dir row navigates; a
     file row opens the capped text viewer — a non-text file gets an honest
     "not viewable" line, NEVER a download (downloads stay outputs-jail-only
     via the fd-based workspace route below). Built with createElement/
     textContent only: names come from a filesystem a bot child can write to.
     cwdPath is the browse cursor (rel to the cwd root), reset on every session
     open so the next session never inherits a path. Both async continuations
     carry the file-wide mySid identity guard. */
  var cwdPath='';
  function closeFileViewer(){ var v=el('perch-file-viewer'); if(v) v.hidden=true; }
  function crumbBtn(label,target){
    var b=document.createElement('button'); b.type='button'; b.className='crumb'; b.textContent=label;
    b.onclick=function(){ closeFileViewer(); loadCwd(target); };
    return b;
  }
  function renderCrumbs(crumbs,d){
    if(!crumbs) return;
    var root=String(d.root||'').split('/').pop()||'/';
    var segs=d.rel?String(d.rel).split('/'):[];
    var last=crumbBtn(root,''); crumbs.appendChild(last);
    var acc='';
    segs.forEach(function(s){
      acc=acc?acc+'/'+s:s;
      var sep=document.createElement('span'); sep.className='crumb-sep'; sep.textContent='/'; crumbs.appendChild(sep);
      last=crumbBtn(s,acc); crumbs.appendChild(last);
    });
    last.setAttribute('aria-current','location'); last.onclick=null;   /* here, not a nav target */
  }
  function loadCwd(path){
    var list=el('perch-cwd-list'); var crumbs=el('perch-cwd-crumbs');
    if(!list||!current.sid) return;
    if(path==null) path=cwdPath;
    var mySid=current.sid;
    perchApi('GET','/interactive/'+encodeURIComponent(mySid)+'/cwd/list?path='+encodeURIComponent(path)).then(function(r){
      if(current.sid!==mySid) return;                  /* identity guard, as everywhere */
      clearEl(list); if(crumbs) clearEl(crumbs);
      if(r.status===409&&r.j&&r.j.error==='no_cwd'){ list.appendChild(line('empty',FILES_NO_CWD)); return; }
      if(!r.ok||!r.j){ list.appendChild(line('empty',FILES_CWD_FAILED)); return; }
      var d=r.j;
      cwdPath=d.rel||'';                                /* sync the cursor to the resolved path */
      renderCrumbs(crumbs,d);
      var dirs=Array.isArray(d.dirs)?d.dirs:[], files=Array.isArray(d.files)?d.files:[];
      if(!dirs.length&&!files.length){ list.appendChild(line('empty',FILES_CWD_EMPTY)); return; }
      dirs.forEach(function(it){
        if(!it||!it.name) return;
        var row=document.createElement('button'); row.type='button'; row.className='cwd-row cwd-dir';
        row.appendChild(line('cwd-name',it.name));
        row.onclick=function(){ closeFileViewer(); loadCwd(it.path); };
        list.appendChild(row);
      });
      files.forEach(function(it){
        if(!it||!it.name) return;
        var row=document.createElement('button'); row.type='button'; row.className='cwd-row cwd-file';
        row.appendChild(line('cwd-name',it.name));
        row.appendChild(line('cwd-meta',fmtSize(it.size)));
        row.onclick=function(){ openFileViewer(it.path); };
        list.appendChild(row);
      });
    });
  }
  function openFileViewer(path){
    var viewer=el('perch-file-viewer'); var body=el('perch-fv-body'); var nameEl=el('perch-fv-name');
    if(!viewer||!current.sid) return;
    var mySid=current.sid;
    if(nameEl) nameEl.textContent='';
    if(body) body.textContent='\\u2026';                 /* loading ellipsis */
    viewer.hidden=false;
    perchApi('GET','/interactive/'+encodeURIComponent(mySid)+'/cwd/read?path='+encodeURIComponent(path)).then(function(r){
      if(current.sid!==mySid) return;                   /* identity guard, as everywhere */
      if(!body) return;
      if(r.status===415){ body.textContent=FILES_VIEWER_UNSUPPORTED; return; }
      if(!r.ok||!r.j){ body.textContent=FILES_VIEWER_FAILED; return; }
      if(nameEl) nameEl.textContent=r.j.name||'';
      body.textContent=String(r.j.text||'')+(r.j.truncated?('\\n\\n'+FILES_VIEWER_TRUNCATED):'');
    });
  }
  var fvClose=el('perch-fv-close'); if(fvClose) fvClose.onclick=closeFileViewer;

  /* ---- PR-D (audit item 15): envelope + per-session tool narrowing pane ----
     Ported from the board card drawer (drawer.js:265-380) so hub-only sessions
     get per-session narrowing too. Bot Builder stays the ONLY WRITER of the
     envelope; this pane can only REMOVE tools for the session (the POST
     .../narrow route rejects widening), effective from the next message — a
     wake rebuilds the world. Reuses the drawer's botboard.bd* i18n strings
     (shared table, already EN+ES) and its tri-state narrowing semantics: a Set
     is a real narrowing, null is "reported, nothing narrowed", undefined is
     "not reported" — the middle must never collapse into the last. Envelope +
     the session's saved narrowing come in ONE call via ?threadId=. Checkboxes
     are tracked in a closure array (not querySelectorAll) so the pane is
     testable in the vm harness. The load continuation carries the file-wide
     mySid identity guard; saveNarrowing writes only its own (possibly detached
     after a session switch) message element, so it needs none. */
  var narrowOpen=false;
  function savedNarrowingFromEnvelope(env){
    if(!env||!Object.prototype.hasOwnProperty.call(env,'savedNarrowing')) return undefined;
    var list=env.savedNarrowing;
    if(list==null) return null;
    if(typeof list==='string'){ try{ list=JSON.parse(list); }catch(e){ return undefined; } }
    if(!Array.isArray(list)) return undefined;
    var s={}; list.forEach(function(id){ s[String(id)]=true; });
    return s;
  }
  function toggleNarrowPane(){
    var body=el('perch-narrow-body'), tog=el('perch-narrow-toggle');
    if(!body) return;
    if(narrowOpen){
      narrowOpen=false; body.hidden=true;
      if(tog) tog.setAttribute('aria-expanded','false');
      return;
    }
    narrowOpen=true; body.hidden=false;
    if(tog) tog.setAttribute('aria-expanded','true');
    loadNarrowPane();
  }
  function narrowPaneErr(){
    var body=el('perch-narrow-body'); if(!body) return;
    clearEl(body);
    var e=document.createElement('div'); e.className='narrow-msg err';
    e.textContent='${tJs("botboard.loadFailed", lang)}';
    body.appendChild(e);
  }
  function loadNarrowPane(){
    var body=el('perch-narrow-body');
    if(!body||!current.sid||!current.botId) return;
    var mySid=current.sid;
    clearEl(body);
    var loading=document.createElement('div'); loading.className='narrow-msg'; loading.textContent='\\u2026';
    body.appendChild(loading);
    perchApi('GET','/bots/'+encodeURIComponent(current.botId)+'/envelope?threadId='+encodeURIComponent(mySid)).then(function(r){
      if(current.sid!==mySid) return;                  /* identity guard, as everywhere */
      if(!r.ok||!r.j){ narrowPaneErr(); return; }
      renderNarrowPane(r.j);
    });
  }
  function renderNarrowPane(envelope){
    var body=el('perch-narrow-body'); if(!body) return;
    clearEl(body);
    var allowed=envelope.tools||[];
    var denied=envelope.denied||[];
    var saved=savedNarrowingFromEnvelope(envelope);
    var disabledSet=(saved&&typeof saved==='object')?saved:{};
    var head=document.createElement('div'); head.className='narrow-head';
    var skillsTxt=(envelope.skills||[]).length?(' \\u00b7 ${tJs("botboard.bdEnvelopeSkillsPrefix", lang)}'+envelope.skills.join(', ')):'';
    head.textContent='${tJs("botboard.bdEnvelopeModelPrefix", lang)}'+(envelope.model||'${tJs("botboard.bdEnvelopeModelUnset", lang)}')+skillsTxt;
    body.appendChild(head);
    var toolsWrap=document.createElement('div'); toolsWrap.className='narrow-tools';
    var toolBoxes=[];
    if(!allowed.length&&!denied.length){
      var none=document.createElement('div'); none.className='narrow-locked'; none.textContent='${tJs("botboard.bdToolsNone", lang)}';
      toolsWrap.appendChild(none);
    }
    allowed.forEach(function(tool){
      var label=document.createElement('label'); label.className='narrow-tool';
      var cb=document.createElement('input'); cb.type='checkbox';
      cb.checked=!disabledSet[String(tool.id)];
      cb.setAttribute('data-narrow-tool',tool.id);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' '+(tool.label||tool.id)));
      toolsWrap.appendChild(label);
      toolBoxes.push(cb);
    });
    denied.forEach(function(tool){
      var locked=document.createElement('div'); locked.className='narrow-locked';
      locked.textContent='\\uD83D\\uDD12 '+(tool.label||tool.id);
      toolsWrap.appendChild(locked);
    });
    body.appendChild(toolsWrap);
    var note=document.createElement('div'); note.className='narrow-note';
    note.textContent=(saved&&typeof saved==='object')?'${tJs("botboard.bdNarrowNoteSaved", lang)}'
      : saved===null?'${tJs("botboard.bdNarrowNoteEmpty", lang)}'
      : '${tJs("botboard.bdNarrowNoteUnknown", lang)}';
    body.appendChild(note);
    var narrowMsg=document.createElement('div'); narrowMsg.className='narrow-msg';
    body.appendChild(narrowMsg);
    toolsWrap.addEventListener('change',function(ev){
      if(ev.target&&ev.target.hasAttribute&&ev.target.hasAttribute('data-narrow-tool')) saveNarrowing(toolBoxes,narrowMsg,ev.target);
    });
  }
  function saveNarrowing(toolBoxes,narrowMsg,changedInput){
    if(!current.botId||!current.sid) return;
    var botId=current.botId, sid=current.sid;
    var disabled=toolBoxes.filter(function(b){ return !b.checked; }).map(function(b){ return b.getAttribute('data-narrow-tool'); });
    narrowMsg.className='narrow-msg'; narrowMsg.textContent='\\u2026';
    perchApi('POST','/bots/'+encodeURIComponent(botId)+'/sessions/'+encodeURIComponent(sid)+'/narrow',{disabled_tools:disabled}).then(function(r){
      if(r.ok){
        narrowMsg.textContent=disabled.length
          ? ('${tJs("botboard.bdNarrowedToPrefix", lang)}'+(toolBoxes.length-disabled.length)+'${tJs("botboard.bdNarrowedToMid", lang)}'+toolBoxes.length+'${tJs("botboard.bdNarrowedToSuffix", lang)}')
          : '${tJs("botboard.bdFullEnvelopeRestored", lang)}';
      } else {
        changedInput.checked=!changedInput.checked;
        narrowMsg.className='narrow-msg err';
        narrowMsg.textContent=(r.j&&r.j.error==='widening_rejected')?'${tJs("botboard.bdNarrowRejected", lang)}':'${tJs("botboard.bdNarrowFailed", lang)}';
      }
    });
  }
  var narrowToggle=el('perch-narrow-toggle'); if(narrowToggle) narrowToggle.onclick=toggleNarrowPane;

  /* ---- Wave 2: Session-tab facts + plan progress -------------------------
     All readings ride the state/plan_state frames the engine already emits
     (contextUsage = pi's own numbers captured at turn end; uptime/RSS are
     per-CHILD, so a hibernating session honestly shows dashes). A value
     that cannot be measured renders as an em dash — never a guess, never a
     stale reading from the previous session (resetControls clears). */
  var planState=null;
  function fmtUptime(sec){
    sec=Math.max(0,Math.round(Number(sec)||0));
    if(sec<60) return sec+'s';
    if(sec<3600) return Math.floor(sec/60)+'m';
    var h=Math.floor(sec/3600);
    return h+'h '+Math.floor((sec%3600)/60)+'m';
  }
  function resetFacts(){
    ['perch-fact-context','perch-fact-uptime','perch-fact-memory','perch-fact-tools'].forEach(function(id){
      var e=el(id); if(e) e.textContent='\\u2014';
    });
    var bar=el('perch-ctxbar'); if(bar) bar.hidden=true;
  }
  function renderFacts(d){
    if(!d) return;
    var cu=d.contextUsage;
    if(cu!==undefined){
      var c=el('perch-fact-context'), bar=el('perch-ctxbar'), fill=el('perch-ctxbar-fill');
      if(cu&&cu.percent!=null){
        var txt=Math.round(cu.percent)+'%';
        if(cu.tokens!=null&&cu.contextWindow) txt+=' \\u00b7 '+Math.round(cu.tokens/1000)+'k/'+Math.round(cu.contextWindow/1000)+'k';
        if(c) c.textContent=txt;
        if(fill) fill.style.width=Math.max(0,Math.min(100,Number(cu.percent)||0))+'%';
        if(bar) bar.hidden=false;
      } else {
        if(c) c.textContent='\\u2014';
        if(bar) bar.hidden=true;
      }
    }
    if(d.uptimeSeconds!==undefined){
      var u=el('perch-fact-uptime');
      if(u) u.textContent=d.uptimeSeconds==null?'\\u2014':fmtUptime(d.uptimeSeconds);
    }
    if(d.memoryMB!==undefined){
      var m=el('perch-fact-memory');
      if(m) m.textContent=d.memoryMB==null?'\\u2014':d.memoryMB+' MB';
    }
    if(d.toolCount!==undefined){
      var tc=el('perch-fact-tools');
      if(tc) tc.textContent=d.toolCount==null?'\\u2014':String(d.toolCount);
    }
  }
  function renderPlan(){
    var st=planState;
    var active=!!(st&&(st.enabled||st.executing));
    var card=el('perch-plan-card'), bar=el('perch-planbar'), fill=el('perch-planbar-fill');
    if(card) card.hidden=!active;
    var total=active?Number(st.todosTotal||0):0;
    if(bar) bar.hidden=!(active&&total>0);
    if(!active) return;
    var done=Number(st.todosDone||0);
    if(fill&&total>0) fill.style.width=Math.round(100*done/total)+'%';
    var head=el('perch-plan-head');
    if(head) head.textContent=PLAN_HEAD+(total>0?' \\u2014 '+done+'/'+total:'')+(st.executing?' \\u25b6':'');
    var steps=el('perch-plan-steps');
    if(!steps) return;
    clearEl(steps);
    var todos=Array.isArray(st.todos)?st.todos:[];
    var curIdx=-1;
    for(var i=0;i<todos.length;i++){ if(todos[i]&&!todos[i].completed){ curIdx=i; break; } }
    todos.forEach(function(td,i){
      if(!td) return;
      var row=document.createElement('div');
      row.className='plan-step'+(td.completed?' done':(i===curIdx?' cur':''));
      row.appendChild(line('sbox',td.completed?'\\u2611':(i===curIdx?'\\u25b6':'\\u2610')));
      row.appendChild(line('stxt',(td.step!=null?td.step+'. ':'')+String(td.text==null?'':td.text)));
      steps.appendChild(row);
    });
  }

  /* ---- Wave 3: inline tool chips -----------------------------------------
     pi-lab's shape: a pill per tool call with a spinner while running, tap
     to expand args/result. Chips are LIVE-TURN UI: they exist in the
     transcript while this client watched them happen; a reload or a resync
     redraws each from its toolResult message (loadHistory), finished and
     without args, and the Activity rail keeps the durable record. Args/results
     arrive pre-truncated by the engine (600/2000 chars) and land via
     textContent only — child-controlled bytes never reach a markup sink. */
  var toolChips={};
  function appendToolChip(d){
    var tr=el('perch-transcript'); if(!tr) return;
    var wrap=document.createElement('div'); wrap.className='entry toolwrap';
    /* The live browser tile anchors after this chip by its RAW call id
       (history chips are keyed 'hist:<id>'). */
    var hist=false;
    if(d&&d.toolCallId!=null){
      var cid=String(d.toolCallId); if(cid.indexOf('hist:')===0){ cid=cid.slice(5); hist=true; }
      if(cid) wrap.setAttribute('data-call',cid);
    }
    var chip=document.createElement('button'); chip.type='button'; chip.className='tool-chip';
    var spin=document.createElement('span'); spin.className='spin';
    var name=document.createElement('span'); name.className='tn'; name.textContent=(d&&d.name)||'?';
    var status=document.createElement('span'); status.textContent=TOOL_RUNNING;
    chip.appendChild(spin); chip.appendChild(name); chip.appendChild(status);
    var details=document.createElement('div'); details.className='tool-details'; details.hidden=true;
    if(d&&d.argsText!=null){
      details.appendChild(line('td-h','args'));
      var pa=document.createElement('pre'); pa.textContent=String(d.argsText);
      details.appendChild(pa);
    }
    chip.onclick=function(){ details.hidden=!details.hidden; };
    wrap.appendChild(chip); wrap.appendChild(details);
    /* New mode: the chip goes into its turn's "See what happened" group;
       classic appends it to the transcript exactly as before. typeof: the
       browser-tile harness lifts this function without the hub's scope. */
    var g=(typeof SHEET!=='undefined'&&SHEET)?toolGroupFor(tr):null;
    if(g){
      g.total++; g.running++;
      /* A live chip proves the turn is still going, but only while one is
         in flight: frames replayed by flushHistBuf after the turn's reply
         belong to a finished turn and fold as such. */
      if(!hist&&typeof turnInFlight!=='undefined'&&turnInFlight) g.ended=false;
      var agents=Array.isArray(d&&d.agents)?d.agents:
        (isSubagentTool(d&&d.name)?subagentNames(d&&d.argsText):[]);
      if(!isSubagentTool(d&&d.name)) g.others++;
      agents.forEach(function(a){ g.agents.push(a); });
      g.body.appendChild(wrap);
      toolGroupRefresh(g);
    } else tr.appendChild(wrap);
    tr.scrollTop=tr.scrollHeight;
    if(d&&d.toolCallId!=null) toolChips[d.toolCallId]={chip:chip,spin:spin,status:status,details:details,group:g};
  }
  function finishToolChip(d){
    var rec=(d&&d.toolCallId!=null)?toolChips[d.toolCallId]:null;
    /* An end without a start means the operator opened mid-call: the rail
       has the line, and minting a chip for a call nobody watched begin
       would show a "done" with no story. In new mode the chip IS minted
       (finished), so the group's "N steps" counts every step it says
       happened. */
    if(!rec&&typeof SHEET!=='undefined'&&SHEET&&d&&d.toolCallId!=null){
      appendToolChip({ name:d.name, toolCallId:d.toolCallId });
      rec=toolChips[d.toolCallId];
    }
    if(!rec) return;
    if(rec.spin&&rec.spin.parentNode) rec.spin.parentNode.removeChild(rec.spin);
    /* New mode: a refusal (chipFailed) reads as failed on the chip too, so the
       chip agrees with its group's count. Classic judges isError only. */
    var bad=rec.group?chipFailed(d):!!(d&&d.isError);
    rec.status.textContent=bad?TOOL_FAILED:TOOL_DONE;
    if(bad) rec.chip.className='tool-chip err';
    if(d&&d.resultText!=null){
      rec.details.appendChild(line('td-h',(d&&d.isError)?'error':'result'));
      var pr=document.createElement('pre'); pr.textContent=String(d.resultText);
      rec.details.appendChild(pr);
    }
    if(rec.group){
      rec.group.running=Math.max(0,rec.group.running-1);
      if(bad) rec.group.failed++;
      toolGroupRefresh(rec.group);
    }
    if(d&&d.toolCallId!=null) delete toolChips[d.toolCallId];
  }

  /* ---- R1.2 PR 2: "See what happened" (new mode only) --------------------
     Consecutive tool chips of one assistant turn sit in one
       div.tool-group[data-turn] > button.tool-group-line[aria-expanded]
                                 + div.tool-group-body > .toolwrap…
     The open group takes the next chip only while it is still the last
     thing in the transcript (a browser tile right after it does not
     count): any text, note, card or user line appended after it closes it,
     and the next tool starts a new group. So ask cards, sent-file cards and
     decision prompts can never land inside one. Never folded: a group with
     a running chip is expanded; it collapses when its turn ends with every
     chip finished. A failed group stays collapsed, its line in the error
     colour with the count. */
  var toolGroup=null, toolGroups=[], toolTurn=0;
  var toolGroupSeq=0;   /* body ids for aria-controls; never reset, so an id is never reused */
  /* The browser lease's refusals arrive as ordinary (isError:false) results;
     they are still steps that did not happen. Copied verbatim from TEXTS.busy,
     TEXTS.held and TEXTS.handedBack in bundles/browser/server/lease-guard.js (the guard the
     shared lease in servers/shared/browser-lease.js reports through). */
  var KNOWN_REFUSALS=[
    'The browser is busy: another bot is using it. Try again in a minute.',
    'The operator has the browser; call again to continue.',
    'The operator handed the browser back; call again.'
  ];
  function chipFailed(d){
    if(d&&d.isError) return true;
    var t=String((d&&d.resultText)||'');
    for(var i=0;i<KNOWN_REFUSALS.length;i++){ if(t.indexOf(KNOWN_REFUSALS[i])===0) return true; }
    return false;
  }
  /* pi's subagent tool (pi-lab extensions/subagent): single { agent },
     parallel { tasks:[{agent}] }, chain { chain:[{agent}] }. The args come
     pre-truncated (600 chars), so a long one does not parse: no names. */
  function subagentNames(argsText){
    var o;
    try{ o=JSON.parse(String(argsText)); }catch(e){ return []; }
    if(!o||typeof o!=='object') return [];
    var out=[];
    function add(a){ if(typeof a==='string'&&a&&out.indexOf(a)<0) out.push(a); }
    add(o.agent);
    [o.tasks,o.chain].forEach(function(l){
      if(Array.isArray(l)) l.forEach(function(t){ if(t&&typeof t==='object') add(t.agent); });
    });
    return out;
  }
  function isSubagentTool(name){ return /(^|__)subagent$/.test(String(name||'')); }
  /* s: the language's strings (TG_S). Never "all ok": a finished line says
     what ran, and a failure is counted. turnRunning: the group's turn is
     still going (the model is working), so even with every chip finished
     the line says "running" until the turn ends. */
  function groupLabel(c,s,turnRunning){
    var head=s.see+' \\u00b7 ';
    var failed=Number(c&&c.failed)||0;
    var tail=failed>0?', '+(failed===1?s.failedOne:s.failed.replace('{n}',String(failed))):'';
    /* Running never hides a failure: "running · 1 failed" until the turn ends. */
    if(Number(c&&c.running)>0||turnRunning) return head+s.running+(failed>0?' \\u00b7 '+(failed===1?s.failedOne:s.failed.replace('{n}',String(failed))):'');
    var names=[];
    ((c&&c.agents)||[]).forEach(function(a){ if(a&&names.indexOf(a)<0) names.push(a); });
    var n=Number(c&&c.total)||0;
    var steps=(n===1?s.step:s.steps.replace('{n}',String(n)));
    /* subagents alone: their names; with other tools beside them: names · N steps */
    if(names.length) return head+names.join(', ')+(Number(c&&c.others)>0?' \u00b7 '+steps:'')+tail;
    return head+steps+tail;
  }
  function toolGroupFor(tr){
    var g=toolGroup;
    if(g&&g.node.parentNode===tr&&g.turn===toolTurn){
      var kids=tr.children||[], i=Array.prototype.indexOf.call(kids,g.node), ok=i>=0;
      for(var j=i+1;ok&&j<kids.length;j++){
        if(String(kids[j].className||'').indexOf('ph-btile')<0) ok=false;
      }
      if(ok) return g;
    }
    var node=document.createElement('div'); node.className='tool-group';
    node.setAttribute('data-turn',String(toolTurn));
    var btn=document.createElement('button'); btn.type='button'; btn.className='tool-group-line';
    var body=document.createElement('div'); body.className='tool-group-body';
    body.id='perch-tg-'+(++toolGroupSeq);
    btn.setAttribute('aria-controls',body.id);
    node.appendChild(btn); node.appendChild(body);
    g={ node:node, line:btn, body:body, total:0, failed:0, running:0, others:0, agents:[], ended:true,
      open:true, turn:toolTurn };
    btn.onclick=function(){ toolGroupOpen(g,!g.open); };
    toolGroupOpen(g,true);
    tr.appendChild(node);
    toolGroup=g; toolGroups.push(g);
    return g;
  }
  function toolGroupOpen(g,open){
    /* Folding a body that holds focus would drop it on <body>: hand it to the line first. */
    if(!open&&g.open&&typeof document!=='undefined'&&document.activeElement&&g.body.contains&&
       g.body.contains(document.activeElement)&&g.line.focus) g.line.focus();
    g.open=!!open;
    g.body.hidden=!g.open;
    g.line.setAttribute('aria-expanded',g.open?'true':'false');
  }
  function toolGroupRefresh(g){
    g.line.textContent=groupLabel(g,TG_S,!g.ended);
    g.line.className='tool-group-line'+(g.failed>0?' err':'');
    if(g.running>0) toolGroupOpen(g,true);
    else if(g.ended) toolGroupOpen(g,false);
    /* else: every chip finished but the turn is still going, so it stays open until the turn ends */
  }
  /* The turn ended (setTurnInFlight's true->false): its groups fold once
     every chip in them is finished; the next turn's tools start fresh. */
  function toolGroupsEndTurn(){
    toolGroups.forEach(function(g){ if(!g.ended){ g.ended=true; toolGroupRefresh(g); } });
    toolGroups=toolGroups.filter(function(g){ return !g.ended||g.running>0; });
    toolGroup=null;
  }
  /* History settled while a turn runs (a reload mid-turn): the last turn's
     groups are that running turn's, so they are live again. Their line reads
     "running" and they stay open until the turn ends (toolGroupsEndTurn). */
  /* True from an idle history settle until the next state change or send:
     the window in which a late replayed state frame belongs to the batch's
     last turn (setTurnInFlight). */
  var histSettledIdle=false;
  /* Whether the current stream has delivered a state frame. The engine
     replays its state on subscribe, so an idle replay seen BEFORE the
     history settles already said "no turn": the window must not open then,
     or the next turn (from another client, the board) would rejoin the
     finished turn's groups. Reset in openStream, set in on('state'). */
  var stateSeen=false;
  function toolGroupsSettleHistory(){
    if(!turnInFlight) return;
    toolGroups.forEach(function(g){ if(g.ended&&g.turn===toolTurn){ g.ended=false; toolGroupOpen(g,true); toolGroupRefresh(g); } });
  }
  function resetToolGroups(){ toolGroup=null; toolGroups=[]; toolTurn=0; histSettledIdle=false; }

  /* ---- PR-E (item 12): inline sent-file cards -----------------------------
     pi-lab's shape: an image renders inline, anything else is a download card
     with name/caption/size; a file that could not be jail-copied renders
     name-only with a dim "not servable" note. Servable rows link the EXISTING
     fd-based workspace route — this adds no new serving path, and that jail's
     O_NOFOLLOW discipline is what makes each download safe, not this markup.
     createElement/textContent + encodeURIComponent only: names and captions
     are child-controlled bytes and never reach a markup sink. Rides live
     frames AND the /files/history reload batch (deduped by fileSeen). */
  function renderFileCard(d){
    var tr=el('perch-transcript'); if(!tr) return;
    var name=String(d.name||'');
    var servable=!!d.servable && !!d.stored;
    // stored is normally a basename; the in-jail case can carry a nested
    // relative path, so encode SEGMENT-wise (a blanket encodeURIComponent
    // would turn its '/' into %2F).
    var segs=String(d.stored).split('/').map(encodeURIComponent).join('/');
    var url=servable?API+'/interactive/'+encodeURIComponent(current.sid)+'/workspace/'+segs:'';
    var wrap=document.createElement('div'); wrap.className='entry filecard'+(servable?'':' dim');
    var isImg=servable && String(d.mime||'').indexOf('image/')===0;
    if(isImg){
      var img=document.createElement('img'); img.className='file-img'; img.src=url; img.alt=name;
      img.loading='lazy';
      wrap.appendChild(img);
    }
    wrap.appendChild(line('file-title',name));
    if(d.caption) wrap.appendChild(line('file-cap',String(d.caption)));
    var meta=fmtSize(d.size);
    if(servable){
      wrap.appendChild(line('file-meta',meta));
      var a=document.createElement('a'); a.className='file-dl'; a.href=url;
      a.setAttribute('download',name);
      a.textContent=FILE_DOWNLOAD;
      wrap.appendChild(a);
    }else{
      wrap.appendChild(line('file-meta',meta));
      wrap.appendChild(line('file-note',FILE_NOT_SERVABLE));
    }
    tr.appendChild(wrap);
    tr.scrollTop=tr.scrollHeight;
  }

${perchPhoneCardJs(lang)}

${perchArtifactCardJs(lang)}
${perchCardChipJs(lang)}
${perchBriefingJs(lang)}
${sessionCardsJs(lang)}

${perchDictationJs(lang)}

${perchBrowserTileJs(lang)}
${perchBrowserFloatJs(lang)}
${perchTakeOverJs(lang)}

  /* ---- Wave 3: the slash-command menu ------------------------------------
     Fed by pi's OWN get_commands registry through the engine (never a
     hardcoded list — a bot's commands depend on its loaded extensions and
     skills). One fetch per session, cached; the menu opens on a bare
     "/…" composer and filters as you type. A hibernating child has no
     registry to ask, and waking one because the operator typed "/" would
     be a lie of availability — the menu says "asleep" instead. */
  var commandsCache=null;              /* {list:[],hibernating:bool} per session */
  function hideCmdMenu(){ var m=el('perch-cmdmenu'); if(m){ m.hidden=true; clearEl(m); } }
  function maybeCmdMenu(val){
    var m=el('perch-cmdmenu'); if(!m) return;
    var v=String(val==null?'':val);
    if(!/^\\/[^\\s]*$/.test(v)){ m.hidden=true; return; }
    var q=v.slice(1).toLowerCase();
    if(commandsCache){ renderCmdList(q); return; }
    if(!current.sid) return;
    var mySid=current.sid;
    perchApi('GET','/interactive/'+encodeURIComponent(mySid)+'/commands').then(function(r){
      if(current.sid!==mySid) return;                     /* identity guard, as everywhere */
      commandsCache=(r.ok&&r.j&&Array.isArray(r.j.commands))
        ? {list:r.j.commands,hibernating:!!r.j.hibernating}
        : {list:[],hibernating:false};
      var inp=el('perch-input');
      var cur=inp?String(inp.value||''):'';
      if(/^\\/[^\\s]*$/.test(cur)) renderCmdList(cur.slice(1).toLowerCase());
    });
  }
  function renderCmdList(q){
    var m=el('perch-cmdmenu'); if(!m||!commandsCache) return;
    clearEl(m);
    var hits=commandsCache.list.filter(function(c){
      return String(c&&c.name||'').toLowerCase().indexOf(q)>=0;
    }).slice(0,30);
    if(!hits.length){
      if(commandsCache.hibernating){ m.appendChild(line('cmd-empty',COMMANDS_HIBERNATING)); m.hidden=false; }
      else m.hidden=true;
      return;
    }
    hits.forEach(function(c){
      var b=document.createElement('button'); b.type='button';
      var n=document.createElement('span'); n.className='cmd-name'; n.textContent='/'+c.name;
      b.appendChild(n);
      if(c.description){
        var ds=document.createElement('span'); ds.className='cmd-desc'; ds.textContent=String(c.description);
        b.appendChild(ds);
      }
      b.onclick=function(){
        var inp=el('perch-input');
        if(inp){ inp.value='/'+c.name+' '; if(inp.focus) inp.focus();
          /* the value changed without an input event — keep the grow in sync */
          inp.style.height='auto'; }
        m.hidden=true;
      };
      m.appendChild(b);
    });
    m.hidden=false;
  }

  /* iOS does not shrink the layout viewport for the keyboard, so dvh alone
     leaves the composer behind it. Offset the chat column by the hidden part. */
  /* Phone review 2026-10-29: the shell's Chat/Board/Make bar stays in an open
     chat, so while an on-screen keyboard is up body[data-perch-kb] lets
     css.js hide the bar and drop --shell-tabs-h, and the composer rides
     right above the keyboard. "Up" is two facts at once: a text field has
     focus, and more than KB_MIN_PX of the layout viewport is covered. The
     cover is measured zoom-proof (innerHeight - vv.height * vv.scale: a
     pinch zoom shrinks vv.height by exactly the scale, a keyboard does not),
     and the focus rule means a blur always brings the bar back, whatever the
     viewport reports. A browser that resizes the layout viewport instead
     covers nothing: the fixed bar then rides above the keyboard with the
     composer above it. */
  var KB_MIN_PX=120;
  function textFieldFocused(){
    var a=document.activeElement; if(!a||!a.tagName) return false;
    var tag=String(a.tagName).toUpperCase();
    if(tag==='TEXTAREA') return true;
    if(tag==='INPUT') return !/^(button|checkbox|radio|submit|reset|file|range|color|image|hidden)$/i.test(String(a.type||''));
    return !!a.isContentEditable;
  }
  if(window.visualViewport){
    var vv=window.visualViewport;
    var applyVV=function(){
      if(!live()) return;
      var hidden=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
      var scale=typeof vv.scale==='number'&&vv.scale>0?vv.scale:1;
      var covered=window.innerHeight-vv.height*scale;
      if(typeof body.setAttribute==='function'&&typeof body.removeAttribute==='function'){
        if(covered>KB_MIN_PX&&textFieldFocused()) body.setAttribute('data-perch-kb','');
        else body.removeAttribute('data-perch-kb');
      }
      el('perch-chat').style.paddingBottom=hidden?hidden+'px':'';
    };
    bindOnce(vv,'resize','vvResize',applyVV);
    bindOnce(vv,'scroll','vvScroll',applyVV);
    /* Some browsers fire none of the viewport events on a rotation, a return
       to the tab or a back-forward restore (window resize, visibilitychange
       and pageshow reuse their one listener each, further up); a blur moves
       focus a task later. */
    bindOnce(window,'orientationchange','vvOrient',applyVV);
    bindOnce(document,'focusout','vvFocusout',function(){ setTimeout(applyVV,0); });
    bindOnce(document,'focusin','vvFocusin',applyVV);
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
  takeOverFromLink();
  toMineRefresh();
})();`;
}
