import { tJs } from "../shared/i18n.js";

/**
 * The live browser tile in the Perch thread (spec 2026-10-27 §1, §4.2, §4.3
 * delivery, §4.5, §4.6; §7 items 4 and 10).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's
 * API / el / line / csrf / perchApi / live / current / HUB / bindOnce.
 * Same pattern as card-chip.js and artifact-card.js.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - Nothing server-sent reaches a markup sink: the hostname lands through
 *    textContent, a frame through an <img> src built from a data: URL (base64
 *    checked first), a shot through its own perch-api url (prefix checked).
 *
 * DOM, one tile per turn (key: the turn's anchor = its first browser toolCallId):
 *   div.entry.ph-btile[data-anchor][data-phase="live|done"][data-dim][data-operator]
 *     button.bt-frame > img.bt-img        the live frame, or the frozen shot
 *     div.bt-bar > span.bt-dot, span.bt-state (Live | Done), span.bt-host
 *     div.bt-note                          "You had the browser" (done, note operator)
 *     div.bt-actions > button.bt-take (live), button.bt-del (done with a shot)
 * Placed right after the anchor chip (div.toolwrap[data-call=<id>]), or after
 * the div.tool-group holding it in new mode; with no
 * such chip, at the end of the transcript (live) or by created_at among the
 * stamped history rows (a frozen tile from browserShots).
 *
 * Polling (GET …/interactive/:sid/browser/frame?after=<seq>&vw=<px>): one
 * poller per tile, only while an IntersectionObserver says the tile is on
 * screen AND document.visibilityState is "visible". Never more than one
 * request in flight. Each poller sits in HUB.streams (closed by HUB.retire on
 * turbo:before-render) and aborts its fetch through an AbortController.
 *   200 → show the frame, poll again after its seq    204 → poll again
 *   409 not_holder → dim the last frame, stop (a new live frame resumes)
 *   429 → stop, back off 5 s, resume once              404 / other → stop
 *
 * Frames (SSE "browser"):
 *   { phase:"live", anchor, domain, gen }            light / refresh the tile
 *   { phase:"done", anchor, domain, shot:{id,url}|null, note:"operator"|null }
 *   { phase:"operator", anchor, held:true|false }    Task 7: the operator took
 *       (held:true) or handed back (held:false) the browser during this turn.
 *       held:true → header "Waiting for you", the tile stops polling (the
 *       frame route answers not_holder anyway); held:false → header back to
 *       "Using the browser", polling resumes. anchor may be null (the live tile).
 * Take over dispatches a "perch:browser-takeover" CustomEvent on document,
 * detail { sid, anchor }: Task 7 opens its sheet from it.
 */
export function perchBrowserTileJs(lang = "en") {
  return `
  /* ---- live browser tile (spec 2026-10-27 §4.2/§4.3/§4.5) --------------- */
  var BT_LIVE='${tJs("perch.browserLive", lang)}';
  var BT_DONE='${tJs("perch.browserDone", lang)}';
  var BT_NEUTRAL='${tJs("perch.browserNeutral", lang)}';
  var BT_USING='${tJs("perch.browserUsing", lang)}';
  var BT_USING_NO_DOMAIN='${tJs("perch.browserUsingNoDomain", lang)}';
  var BT_WAITING='${tJs("perch.browserWaiting", lang)}';
  var BT_YOU_HAD='${tJs("perch.browserYouHadIt", lang)}';
  var BT_DELETE='${tJs("perch.browserDelete", lang)}';
  var BT_TAKE_OVER='${tJs("perch.takeOver", lang)}';
  var BT_BACKOFF_MS=5000, BT_MIN_GAP_MS=1000;

  /* key -> tile record, for THIS transcript; dies with it (resetBrowserTiles). */
  var btTiles={}, btSeq=0, btLiveKey=null, btIO=null, btGen=0, btShotSeen={};

  function btHost(domain){ return (typeof domain==='string'&&domain)?domain:BT_NEUTRAL; }
  /* A shot is only ever loaded from this hub's own perch-api. */
  function btShotOk(s){
    return !!s&&s.id!=null&&typeof s.url==='string'&&s.url.indexOf(API+'/interactive/')===0&&s.url.length<=512;
  }
  /* browser-<host>-<yyyymmdd>-<hhmmss>[-n].jpg (shots.js shotName); "page" = no host. */
  function btHostFromName(name){
    var m=/^browser-(.+)-[0-9]{8}-[0-9]{6}(-[0-9]+)?[.]jpg$/.exec(String(name||''));
    return (m&&m[1]!=='page')?m[1]:null;
  }

  /* The transcript row the tile goes after: the anchor chip itself, or in
     new mode the "See what happened" group holding it (the closest
     .tool-group), so a folded group never hides the tile. */
  function btChip(tr,anchor){
    if(!anchor) return null;
    var kids=tr.children||[];
    for(var i=0;i<kids.length;i++){
      var k=kids[i];
      if(k.getAttribute&&k.getAttribute('data-call')===anchor) return k;
      if(String(k.className||'').split(' ').indexOf('tool-group')>=0&&btInGroup(k,anchor)) return k;
    }
    return null;
  }
  function btInGroup(g,anchor){
    var parts=g.children||[];
    for(var i=0;i<parts.length;i++){
      var rows=parts[i].children||[];
      for(var j=0;j<rows.length;j++){
        if(rows[j].getAttribute&&rows[j].getAttribute('data-call')===anchor) return true;
      }
    }
    return false;
  }
  function btAfter(tr,node,ref){
    /* children is an HTMLCollection in a real document: no indexOf of its own */
    var kids=tr.children||[], i=Array.prototype.indexOf.call(kids,ref);
    var next=(i>=0&&i+1<kids.length)?kids[i+1]:null;
    if(next) tr.insertBefore(node,next); else tr.appendChild(node);
  }
  /* Before the first stamped history row newer than the shot (fbPlace's rule). */
  function btByTime(tr,at){
    var t=Date.parse(String(at||'').replace(' ','T')+'Z');
    if(!isFinite(t)) return null;
    var kids=tr.children||[];
    for(var i=0;i<kids.length;i++){
      var ts=Number(kids[i].getAttribute&&kids[i].getAttribute('data-ts'));
      if(ts&&ts>t) return kids[i];
    }
    return null;
  }

  function btMake(anchor){
    var t={ key:anchor?'a:'+anchor:'n:'+(++btSeq), anchor:anchor, sid:current.sid, phase:'live',
      onScreen:false, poller:null, halted:false, backedOff:false, retryTimer:null,
      operator:false, seq:0, shotId:null, domain:null, netRetried:false };
    var node=document.createElement('div'); node.className='entry ph-btile';
    node.setAttribute('data-anchor',anchor||'');
    node.setAttribute('data-phase','live');
    var frame=document.createElement('button'); frame.type='button'; frame.className='bt-frame';
    frame.hidden=true;
    var img=document.createElement('img'); img.className='bt-img'; img.alt='';
    frame.appendChild(img);
    var bar=document.createElement('div'); bar.className='bt-bar';
    var dot=document.createElement('span'); dot.className='bt-dot'; dot.setAttribute('aria-hidden','true');
    var st=document.createElement('span'); st.className='bt-state'; st.textContent=BT_LIVE;
    var host=document.createElement('span'); host.className='bt-host'; host.textContent=BT_NEUTRAL;
    bar.appendChild(dot); bar.appendChild(st); bar.appendChild(host);
    var note=line('bt-note',''); note.hidden=true;
    var acts=document.createElement('div'); acts.className='bt-actions';
    var take=document.createElement('button'); take.type='button'; take.className='bt-take'; take.textContent=BT_TAKE_OVER;
    var del=document.createElement('button'); del.type='button'; del.className='bt-del'; del.textContent=BT_DELETE;
    del.hidden=true;
    acts.appendChild(take); acts.appendChild(del);
    node.appendChild(frame); node.appendChild(bar); node.appendChild(note); node.appendChild(acts);
    t.node=node; t.frame=frame; t.img=img; t.state=st; t.host=host; t.note=note; t.take=take; t.del=del;
    /* Ruling B2: Take over only announces itself; Task 7 opens the sheet. */
    take.onclick=function(){ btTakeOver(t); };
    frame.onclick=function(){ if(t.phase==='live') btTakeOver(t); };
    del.onclick=function(){ btDelete(t); };
    btTiles[t.key]=t;
    return t;
  }
  function btTakeOver(t){
    /* a Done tile (its bot asked for you, then ended the turn) asks like a link:
       the server checks the ask is recent and no other bot has the browser */
    var detail={ sid:t.sid, anchor:t.anchor };
    if(t.phase!=='live') detail.link=true;
    try{ document.dispatchEvent(new CustomEvent('perch:browser-takeover',{ detail:detail })); }catch(e){}
  }
  function btSetHost(t,domain){
    if(typeof domain==='string'&&domain) t.domain=domain;
    t.host.textContent=btHost(t.domain);
    t.img.alt=btHost(t.domain);
    /* the live picture is the Take over control too: name it so */
    if(t.phase==='live') t.frame.setAttribute('aria-label',BT_TAKE_OVER+' \u00b7 '+btHost(t.domain));
  }
  function btDim(t,on){ if(on) t.node.setAttribute('data-dim','1'); else t.node.removeAttribute('data-dim'); }
  function btDrop(t){
    btStop(t); btUnobserve(t);
    if(t.node.parentNode) t.node.parentNode.removeChild(t.node);
    if(btTiles[t.key]===t) delete btTiles[t.key];
    if(btLiveKey===t.key){ btLiveKey=null; btHeader(); }
  }

  /* The thread header's status line. */
  function btHeader(){
    var e=el('perch-browser-status'); if(!e) return;
    var t=btLiveKey?btTiles[btLiveKey]:null;
    var text=(!t||t.phase!=='live')?'':t.operator?BT_WAITING
      :(t.domain?BT_USING.split('{domain}').join(t.domain):BT_USING_NO_DOMAIN);
    /* role=status: a screen reader announces every write, so write only a change */
    if(e.textContent!==text) e.textContent=text;
    if(e.hidden!==!text) e.hidden=!text;
  }

  /* ---- polling ------------------------------------------------------------ */
  function btStreamKey(t){ return 'btile:'+t.sid+':'+t.key; }
  function btVisible(){ return !document.visibilityState||document.visibilityState==='visible'; }
  function btVw(){ var w=Math.round(Number(window.innerWidth)||0); return w>0?w:0; }
  function btCanPoll(t){
    return live()&&btTiles[t.key]===t&&t.phase==='live'&&!t.halted&&!t.operator&&t.onScreen&&btVisible();
  }
  function btMaybeStart(t){
    if(t.poller||t.retryTimer||!btCanPoll(t)) return;
    var p={ seq:t.seq, closed:false, timer:null, ac:(typeof AbortController==='function')?new AbortController():null };
    p.close=function(){
      if(p.closed) return; p.closed=true;
      if(p.timer){ clearTimeout(p.timer); p.timer=null; }
      try{ if(p.ac) p.ac.abort(); }catch(e){}
    };
    t.poller=p; HUB.streams[btStreamKey(t)]=p;
    btPoll(t,p);
  }
  function btStopPoll(t){
    var p=t.poller; t.poller=null;
    if(!p) return;
    p.close();
    var k=btStreamKey(t); if(HUB.streams[k]===p) delete HUB.streams[k];
  }
  function btStop(t){
    btStopPoll(t);
    if(t.retryTimer){ clearTimeout(t.retryTimer); t.retryTimer=null; }
  }
  function btPoll(t,p){
    if(t.poller!==p||p.closed) return;
    if(!btCanPoll(t)){ btStopPoll(t); return; }
    var opts={ method:'GET', headers:{ 'X-Crow-Csrf':csrf() }, cache:'no-store' };
    if(p.ac) opts.signal=p.ac.signal;
    var sentAt=Date.now(), req;
    try{
      req=fetch(API+'/interactive/'+encodeURIComponent(t.sid)+'/browser/frame?after='+encodeURIComponent(String(p.seq))+'&vw='+btVw(),opts);
    }catch(e){ btStopPoll(t); return; }
    req.then(function(r){
      if(t.poller!==p||p.closed) return;
      var s=r.status;
      if(s===204){ t.netRetried=false; btNext(t,p,sentAt); return; }
      if(s===200){
        return r.json().then(function(f){
          if(t.poller!==p||p.closed) return;
          t.netRetried=false;
          /* a 200 that showed nothing new (refused, or seq not advanced) waits the gap too: never a tight loop */
          if(btShowFrame(t,p,f)) btPoll(t,p); else btNext(t,p,sentAt);
        },function(){ btStopPoll(t); });
      }
      btStopPoll(t);
      if(s===409){ btDim(t,true); t.halted=true; return; }
      if(s===429&&!t.backedOff){
        t.backedOff=true;
        t.retryTimer=setTimeout(function(){ t.retryTimer=null; btMaybeStart(t); },BT_BACKOFF_MS);
        return;
      }
      t.halted=true;
    },function(){
      /* aborted by us (closed): nothing. The network went away (a dozing
         phone): stop; one retry after 5 s if the tab is still visible, else
         the next visibility or intersection change starts a fresh poller */
      if(t.poller!==p||p.closed) return;
      btStopPoll(t);
      if(btVisible()&&!t.netRetried&&!t.retryTimer){
        t.netRetried=true;
        t.retryTimer=setTimeout(function(){ t.retryTimer=null; btMaybeStart(t); },BT_BACKOFF_MS);
      }
    });
  }
  /* The next poll, no sooner than BT_MIN_GAP_MS after the last one was sent:
     the long poll waits 2 s server side, so an early answer is not a busy loop. */
  function btNext(t,p,sentAt){
    var gap=BT_MIN_GAP_MS-(Date.now()-sentAt);
    if(gap>0){ p.timer=setTimeout(function(){ p.timer=null; btPoll(t,p); },gap); return; }
    btPoll(t,p);
  }
  /* True when a new frame was shown. A seq that is a valid integer beyond the
     current one advances even when its jpeg is refused (so a bad frame is
     never asked for again), but only a shown frame skips the poll gap. */
  function btShowFrame(t,p,f){
    if(!f||typeof f!=='object') return false;
    var seq=Number(f.seq);
    if(!(seq>p.seq&&Math.floor(seq)===seq&&seq<=9007199254740991)) return false;
    p.seq=seq; t.seq=seq;
    if(typeof f.jpeg!=='string'||!f.jpeg||!/^[A-Za-z0-9+\\/=]+$/.test(f.jpeg)) return false;
    t.img.src='data:image/jpeg;base64,'+f.jpeg;
    var w=Number(f.w), h=Number(f.h);
    if(w>0&&h>0){ t.img.setAttribute('width',String(Math.round(w))); t.img.setAttribute('height',String(Math.round(h))); }
    t.frame.hidden=false;
    btDim(t,false);
    return true;
  }

  /* On screen? One observer per instance; disconnected on retire. */
  function btObserve(t){
    if(typeof IntersectionObserver!=='function'){ t.onScreen=true; return; }
    if(!btIO){
      btIO=new IntersectionObserver(function(entries){
        if(!live()) return;
        for(var i=0;i<entries.length;i++){
          var t2=btByNode(entries[i].target); if(!t2) continue;
          t2.onScreen=!!entries[i].isIntersecting;
          if(t2.onScreen) btMaybeStart(t2); else btStopPoll(t2);
        }
      });
    }
    btIO.observe(t.node);
  }
  function btUnobserve(t){ if(btIO){ try{ btIO.unobserve(t.node); }catch(e){} } }
  function btByNode(n){ for(var k in btTiles){ if(btTiles[k].node===n) return btTiles[k]; } return null; }
  bindOnce(document,'visibilitychange','btVisibility',function(){
    if(!live()) return;
    var vis=btVisible();
    for(var k in btTiles){ if(vis) btMaybeStart(btTiles[k]); else btStopPoll(btTiles[k]); }
  });

  /* ---- frames ------------------------------------------------------------- */
  function btFind(anchor){
    if(anchor&&btTiles['a:'+anchor]) return btTiles['a:'+anchor];
    var cur=btLiveKey?btTiles[btLiveKey]:null;
    /* the turn's live tile when the frame names no anchor, or the anchorless
       tile of this turn when the anchor shows up later: one tile per turn */
    if(cur&&cur.phase==='live'&&(!anchor||!cur.anchor)) return cur;
    return null;
  }
  function btAdopt(t,anchor){
    if(!anchor||t.anchor) return;
    delete btTiles[t.key];
    var wasLive=btLiveKey===t.key;
    t.key='a:'+anchor; t.anchor=anchor; btTiles[t.key]=t;
    t.node.setAttribute('data-anchor',anchor);
    if(wasLive) btLiveKey=t.key;
  }
  function btPlaceLive(t){
    var tr=el('perch-transcript'); if(!tr) return;
    var chip=btChip(tr,t.anchor);
    if(chip){ btAfter(tr,t.node,chip); return; }
    tr.appendChild(t.node); tr.scrollTop=tr.scrollHeight;
  }
  function btFreeze(t,d){
    btStop(t); btUnobserve(t);
    t.phase='done'; t.node.setAttribute('data-phase','done');
    t.node.removeAttribute('data-operator'); t.operator=false;
    btDim(t,false);
    t.state.textContent=BT_DONE;
    /* a turn that parked on wait_for_user keeps its Take over */
    t.take.hidden=!(d&&d.ask===true);
    /* a frozen picture is not a control */
    t.frame.removeAttribute('aria-label'); t.frame.setAttribute('tabindex','-1'); t.frame.disabled=true;
    if(d&&d.domain) btSetHost(t,d.domain); else btSetHost(t,null);
    var shot=d?d.shot:null;
    if(d&&d.note==='operator'){
      t.img.removeAttribute('src'); t.frame.hidden=true;
      t.note.textContent=BT_YOU_HAD; t.note.hidden=false;
      t.shotId=null; t.del.hidden=true;
    } else if(btShotOk(shot)){
      t.img.removeAttribute('width'); t.img.removeAttribute('height');
      t.img.src=shot.url; t.frame.hidden=false;
      t.note.hidden=true;
      t.shotId=shot.id; btShotSeen[String(shot.id)]=true;
      t.del.hidden=false;
    } else {
      /* no shot was kept: nothing to show after a reload either */
      t.img.removeAttribute('src'); t.frame.hidden=true;
      t.shotId=null; t.del.hidden=true;
    }
    if(btLiveKey===t.key){ btLiveKey=null; btHeader(); }
  }
  function browserFrame(d){
    if(!d||typeof d!=='object'||!current.sid) return;
    var anchor=(typeof d.anchor==='string'&&d.anchor)?d.anchor:null;
    var t=btFind(anchor);
    if(d.phase==='live'){
      if(!t){ t=btMake(anchor); btPlaceLive(t); }
      else btAdopt(t,anchor);
      if(t.phase!=='live') return;                 /* a frozen tile never goes live again */
      var prev=btLiveKey?btTiles[btLiveKey]:null;
      if(prev&&prev!==t){ btStop(prev); prev.halted=true; }
      btLiveKey=t.key;
      btSetHost(t,d.domain);
      t.halted=false; t.backedOff=false; btDim(t,false);
      btObserve(t);
      btMaybeStart(t);
      btHeader();
      return;
    }
    if(d.phase==='operator'){
      if(!t||t.phase!=='live') return;
      t.operator=!!d.held;
      if(t.operator){ t.node.setAttribute('data-operator','1'); btStop(t); }
      else { t.node.removeAttribute('data-operator'); t.halted=false; btDim(t,false); btMaybeStart(t); }
      btHeader();
      return;
    }
    if(d.phase==='done'){
      if(d.shot&&d.shot.id!=null&&btShotSeen[String(d.shot.id)]&&(!t||t.phase==='done')) return;   /* history drew it */
      if(!t){
        if(!btShotOk(d.shot)&&d.note!=='operator') return;   /* nothing to show for a turn we never saw live */
        t=btMake(anchor); btPlaceLive(t);
      }
      btFreeze(t,d);
    }
  }

  /* Reload: the newest 20 shots, each a frozen tile in its turn's place. */
  function browserHistory(shots){
    var tr=el('perch-transcript'); if(!tr||!shots||!shots.length) return;
    var list=shots.slice().reverse();               /* the route sends newest first */
    for(var i=0;i<list.length;i++){
      var s=list[i];
      if(!btShotOk(s)||btShotSeen[String(s.id)]) continue;
      var anchor=(typeof s.turn_anchor==='string'&&s.turn_anchor)?s.turn_anchor:null;
      if(anchor&&btTiles['a:'+anchor]) continue;    /* one tile per turn */
      var t=btMake(anchor);
      var chip=btChip(tr,anchor);
      if(chip) btAfter(tr,t.node,chip);
      else { var ref=btByTime(tr,s.created_at); if(ref) tr.insertBefore(t.node,ref); else tr.appendChild(t.node); }
      btFreeze(t,{ domain:btHostFromName(s.name), shot:{ id:s.id, url:s.url }, note:null });
    }
  }

  function btDelete(t){
    if(t.shotId==null||t.del.disabled) return;
    t.del.disabled=true;
    var gen=btGen;
    perchApi('DELETE','/interactive/'+encodeURIComponent(t.sid)+'/browser-shots/'+encodeURIComponent(String(t.shotId))).then(function(r){
      if(!live()||gen!==btGen) return;
      if(r&&r.ok){ btDrop(t); return; }
      t.del.disabled=false;
    });
  }

  /* HUB.retire: every poller and the observer stop. */
  function retireBrowserTiles(){
    for(var k in btTiles) btStop(btTiles[k]);
    if(btIO){ try{ btIO.disconnect(); }catch(e){} btIO=null; }
  }
  /* A new transcript: none of the old tiles, their pollers or the header line. */
  function resetBrowserTiles(){
    retireBrowserTiles();
    btTiles={}; btLiveKey=null; btShotSeen={}; btGen++;
    btHeader();
    resetAppTiles();
  }

  /* ---- R1.2 PR 5: the embedded app tile ----------------------------------
     Any desktop (VNC) app opened from the launcher (the drawer or the
     session's apps sheet) while a session is open in new mode: the shell
     dispatches a cancelable "crow:open-app-tile" { appId }, and this handler
     calls preventDefault ONLY when it really opens a tile (so the shell closes
     its sheet and does not navigate). "Known desktop app": the launcher's own
     link for it (a.shell-app[data-app-kind="desktop"][data-app-id]) is on the
     page; the server then confirms it (GET …/apps/<id>/tile, the catalog) and
     says whether Take over is offered (lease declared AND enforced).

     DOM, one tile per app per transcript:
       div.entry.ph-atile[data-app][tabindex=-1][role=group]
         div.at-bar > span.at-name (the app's name), span.at-state (Watching)
         div.at-view > iframe.at-vnc  watch-only noVNC, a src built here from
                                      the server's /proxy/<id>/<path> (checked)
         div.to-pw-row, div.to-reauth the browser only: the Take over sheet's
                                      Copy password (the keychain + re-auth,
                                      take-over.js toPwParts), for the noVNC
                                      password prompt the watch view shows
         div.at-note                  "can't be shown here" (the server said no)
         div.at-actions > button.at-take (only when offered), a.at-open (the
                                      app's page, whenever Take over is not
                                      offered), button.at-close
     Take over opens the Take over sheet with detail.app (take-over.js). The
     browser's own tile (its crow_browser_* trigger, the CDP frames and shots)
     is above and unchanged; non-browser tool calls make no tile. */
  var AT_WATCHING='${tJs("perch.appTileWatching", lang)}';
  var AT_CLOSE='${tJs("perch.appTileClose", lang)}';
  var AT_UNAVAILABLE='${tJs("perch.appTileUnavailable", lang)}';
  var AT_OPEN='${tJs("perch.appTileOpen", lang)}';
  var AT_ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
  var AT_PATH=/^([A-Za-z0-9._~-]+\\/)*vnc(_lite)?[.]html$/;
  var atTiles={}, atGen=0;

  /* The launcher's link for a desktop app on this page, or null (an app the
     page never offered is not opened from an event alone). */
  function atLauncherLink(appId){
    if(typeof document.querySelectorAll!=='function') return null;
    var list=document.querySelectorAll('a.shell-app[data-app-kind="desktop"]');
    for(var i=0;i<list.length;i++){ if(list[i].getAttribute('data-app-id')===appId) return list[i]; }
    return null;
  }
  function atLabelOf(a,appId){
    var lb=a&&a.querySelector?a.querySelector('.shell-app-label'):null;
    var text=lb?String(lb.textContent||''):'';
    return text||appId;
  }
  /* The launcher link's own href for the tile's Open link: a page of this app
     under its proxy (/proxy/<id>/…), or null. */
  function atHref(a,appId){
    var h=a&&a.getAttribute?String(a.getAttribute('href')||''):'';
    var pre='/proxy/'+appId+'/';
    if(h.indexOf(pre)!==0||h.length>400||h.indexOf('..')>=0||h.indexOf('//',1)>=0) return null;
    return h;
  }
  /* /proxy/<id>/<plain path> from the server's src (its query is dropped: the
     tile builds its own), or null. */
  function atBase(appId,src){
    var str=String(src||''), q=str.indexOf('?'), base=q>=0?str.slice(0,q):str, pre='/proxy/'+appId+'/';
    if(base.indexOf(pre)!==0||base.length>300||base.indexOf('..')>=0||!AT_PATH.test(base.slice(pre.length))) return null;
    return base;
  }
  function atOpen(appId,label,href){
    var tr=el('perch-transcript'); if(!tr) return null;
    var t=atTiles[appId];
    if(t&&t.node.parentNode) return t;
    t={ id:appId, label:label, sid:current.sid, base:null, takeOver:false, frame:null, href:href, pwS:null };
    var node=document.createElement('div'); node.className='entry ph-atile';
    node.setAttribute('data-app',appId); node.setAttribute('role','group');
    node.setAttribute('aria-label',label); node.setAttribute('tabindex','-1');
    var bar=document.createElement('div'); bar.className='at-bar';
    var name=document.createElement('span'); name.className='at-name'; name.textContent=label;
    var st=document.createElement('span'); st.className='at-state'; st.textContent=AT_WATCHING;
    bar.appendChild(name); bar.appendChild(st);
    var view=document.createElement('div'); view.className='at-view';
    var note=line('at-note',''); note.hidden=true;
    var acts=document.createElement('div'); acts.className='at-actions';
    var take=document.createElement('button'); take.type='button'; take.className='at-take'; take.textContent=BT_TAKE_OVER;
    take.hidden=true;
    var open=null;
    if(href){
      open=document.createElement('a'); open.className='at-open btn btn-secondary'; open.textContent=AT_OPEN;
      open.setAttribute('href',href); open.setAttribute('data-turbo','false'); open.hidden=true;
    }
    var close=document.createElement('button'); close.type='button'; close.className='at-close'; close.textContent=AT_CLOSE;
    acts.appendChild(take); if(open) acts.appendChild(open); acts.appendChild(close);
    node.appendChild(bar); node.appendChild(view); node.appendChild(note); node.appendChild(acts);
    t.node=node; t.name=name; t.state=st; t.view=view; t.note=note; t.take=take; t.open=open; t.close=close;
    take.onclick=function(){ atTakeOver(t); };
    close.onclick=function(){ atDrop(t,true); };
    atTiles[appId]=t;
    tr.appendChild(node); tr.scrollTop=tr.scrollHeight;
    atLoad(t);
    return t;
  }
  function atLoad(t){
    var gen=atGen;
    perchApi('GET','/apps/'+encodeURIComponent(t.id)+'/tile').then(function(r){
      if(!live()||gen!==atGen||atTiles[t.id]!==t) return;
      var j=(r&&r.ok&&r.j&&typeof r.j==='object')?r.j:null;
      var base=(j&&j.id===t.id)?atBase(t.id,j.src):null;
      if(!base){ t.note.textContent=AT_UNAVAILABLE; t.note.hidden=false; t.state.hidden=true; if(t.open) t.open.hidden=false; return; }
      t.base=base;
      if(typeof j.label==='string'&&j.label){ t.label=j.label; t.name.textContent=j.label; t.node.setAttribute('aria-label',j.label); }
      var f=document.createElement('iframe'); f.className='at-vnc';
      f.setAttribute('title',t.label);
      f.setAttribute('src',base+'?view_only=true&autoconnect=true&resize=scale');
      t.view.appendChild(f); t.frame=f;
      t.takeOver=j.takeOver===true; t.take.hidden=!t.takeOver;
      /* never a dead end: no Take over, so the app's own page */
      if(t.open) t.open.hidden=t.takeOver;
      /* the browser's noVNC asks for its VNC password: the sheet's own Copy
         password, under the view (the same keychain lookup and re-auth) */
      if(t.id==='browser'&&typeof toPwParts==='function'){
        var ps={ inTile:true, closed:false, pwTimer:null, entryId:null, method:'password', retry:null };
        var parts=toPwParts(ps);
        t.node.insertBefore(parts.pwRow,t.note); t.node.insertBefore(parts.reauth,t.note);
        t.pwS=ps;
        toFindPassword(ps);
      }
    });
  }
  function atTakeOver(t){
    if(!t.takeOver||!t.base) return;
    var detail={ sid:t.sid, anchor:null, app:{ id:t.id, label:t.label, base:t.base } };
    try{ document.dispatchEvent(new CustomEvent('perch:browser-takeover',{ detail:detail })); }catch(e){}
  }
  /* Close the tile (not a hand back: a holding stays until its sheet's Hand back). */
  function atDrop(t,byUser){
    if(t.pwS&&typeof toPwClose==='function'){ toPwClose(t.pwS); t.pwS=null; }
    if(t.frame){ try{ t.frame.setAttribute('src','about:blank'); }catch(e){} }
    if(t.node.parentNode) t.node.parentNode.removeChild(t.node);
    if(atTiles[t.id]===t) delete atTiles[t.id];
    if(byUser){ var inp=el('perch-input'); if(inp&&inp.focus) inp.focus(); }
  }
  /* Turbo is about to snapshot the page: no tile's password row keeps a
     revealed password or a typed re-auth (take-over.js turbo:before-cache). */
  function atWipePasswords(){
    for(var k in atTiles){ var p=atTiles[k].pwS; if(p&&typeof toWipePassword==='function'){ toWipePassword(p); p.rInput.value=''; } }
  }
  function resetAppTiles(){
    for(var k in atTiles) atDrop(atTiles[k],false);
    atTiles={}; atGen++;
  }
  /* Into the tile now, and again once the launcher's dialog has closed (the
     drawer and the apps sheet are both modal: the page stays inert until the
     dialog closes, and its close puts focus back on its opener). */
  function atFocus(t){
    var go=function(){ if(live()&&atTiles[t.id]===t&&t.node.focus) t.node.focus(); };
    go();
    setTimeout(go,0);
  }
  bindOnce(document,'crow:open-app-tile','appTile',function(ev){
    if(!live()||!current.sid||!el('perch-session-sheet')) return;   /* an open session in new mode */
    var appId=ev&&ev.detail?ev.detail.appId:null;
    if(typeof appId!=='string'||!AT_ID.test(appId)) return;
    var a=atLauncherLink(appId); if(!a) return;
    var t=atOpen(appId,atLabelOf(a,appId),atHref(a,appId)); if(!t) return;
    if(ev.preventDefault) ev.preventDefault();
    atFocus(t);
  });
`;
}
