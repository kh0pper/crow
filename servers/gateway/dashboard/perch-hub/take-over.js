import { tJs } from "../shared/i18n.js";

/**
 * The Take over sheet (spec 2026-10-27 §4.4, §7 items 7 and 13).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js) right after browser-tile.js,
 * so it shares that scope: API / el / line / csrf / perchApi / live / current /
 * HUB / bindOnce, and the tile's btFind / btHost.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - textContent only; the iframe src is a fixed same-origin path.
 *  - The VNC password is never logged and never kept: it is copied, or shown
 *    for 15 s when the clipboard refuses (iOS drops the tap's permission across
 *    the re-auth round trip), then wiped from the DOM and the variable.
 *
 * Lifecycle:
 *  - opened by the tile's "perch:browser-takeover" event (Take over, or a tap
 *    on the live picture), by a "?take-over=1" link (the wait_for_user
 *    attention item), or from the Browser panel;
 *  - R1.2 PR 5: the app tile sends the same event with detail.app
 *    { id, label, base } (base = the app's /proxy/<id>/<desktop path>). Another
 *    app's sheet runs the same states on POST …/apps/<id>/take-over |
 *    heartbeat | hand-back, has no password row, and never touches the
 *    browser's "You have the browser" control. The browser itself stays on
 *    …/browser/*. The browser's app tile reuses this sheet's Copy password
 *    row (toPwParts / toFindPassword, the same keychain reveal and re-auth)
 *    under its watch view, where noVNC asks for the VNC password;
 *  - POST …/browser/take-over → "held": the noVNC viewer loads; "pending": "The
 *    bot is finishing its step…" and a 1 s check until it switches;
 *  - held: a heartbeat every 15 s (the server keeps the holding 5 minutes
 *    without one, so a frozen phone tab does not lose it); "idle" from the
 *    server (5-minute loss) closes the sheet;
 *  - Hand back (POST …/browser/hand-back) is the only way the sheet gives the
 *    browser back; on an ended sheet (a 409 link) it only closes the sheet. A Turbo visit (HUB.retire), a hidden tab or a navigation
 *    closes the UI and stops its timers, and never hands back.
 */
export function perchTakeOverJs(lang = "en") {
  return `
  /* ---- the Take over sheet (spec 2026-10-27 §4.4) ------------------------ */
  var TO_HAND_BACK='${tJs("perch.handBack", lang)}';
  var TO_COPY='${tJs("perch.copyPassword", lang)}';
  var TO_NO_PASSWORD='${tJs("perch.noPassword", lang)}';
  var TO_FINISHING='${tJs("perch.botFinishing", lang)}';
  var TO_WAITING='${tJs("perch.browserWaiting", lang)}';
  var TO_NOT_WAITING='${tJs("perch.browserNotWaiting", lang)}';
  var TO_COPIED='${tJs("passwords.copied", lang)}';
  var TO_REAUTH_TITLE='${tJs("passwords.reauthTitle", lang)}';
  var TO_REAUTH_PASSWORD='${tJs("passwords.reauthPassword", lang)}';
  var TO_REAUTH_TOTP='${tJs("passwords.reauthTotp", lang)}';
  var TO_CONFIRM='${tJs("passwords.confirm", lang)}';
  var TO_CANCEL='${tJs("common.cancel", lang)}';
  var TO_PW_ERROR='${tJs("passwords.error", lang)}';
  var TO_FAILED='${tJs("shell.offerFailed", lang)}';
  var TO_KEYCHAIN='/dashboard/keychain/api';
  var TO_HEARTBEAT_MS=15000, TO_PENDING_MS=1000, TO_SHOW_PW_MS=15000;
  var toSheet=null;

  function toApi(path){ return perchApi('POST','/browser/'+path); }
  /* R1.2 PR 5: the sheet also takes over another desktop app (detail.app from
     the app tile): the same state machine on that app's own routes. The
     browser, from its tile or the launcher's, stays on /browser/. */
  var TO_APP_ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
  var TO_APP_PATH=/^([A-Za-z0-9._~-]+\\/)*vnc(_lite)?[.]html$/;
  function toAppOf(detail){
    var a=detail&&detail.app;
    if(!a||typeof a.id!=='string'||!TO_APP_ID.test(a.id)) return null;
    var pre='/proxy/'+a.id+'/', base=typeof a.base==='string'?a.base:'';
    if(base.indexOf(pre)!==0||!TO_APP_PATH.test(base.slice(pre.length))||base.indexOf('..')>=0) return null;
    return { id:a.id, label:typeof a.label==='string'?a.label:'', base:base };
  }
  function toIsBrowser(s){ return !s.app||s.app.id==='browser'; }
  function toOp(s,op){
    if(toIsBrowser(s)) return toApi(op);
    return perchApi('POST','/apps/'+encodeURIComponent(s.app.id)+'/'+op);
  }
  function toKeychain(method,path,body){
    var opts={ method:method, headers:{ 'X-Crow-Csrf':csrf() }, cache:'no-store' };
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch(TO_KEYCHAIN+path,opts).then(function(r){
      return r.json().catch(function(){ return null; }).then(function(j){ return { status:r.status, j:j||{} }; });
    },function(){ return { status:0, j:{} }; });
  }

  function toButton(cls,text){
    var b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=text; return b;
  }

  function openTakeOver(detail){
    if(!live()) return;
    if(toSheet){ if(toSheet.back.focus) toSheet.back.focus(); return; }
    var anchor=detail&&typeof detail.anchor==='string'?detail.anchor:null;
    var app=toAppOf(detail);
    if(detail&&detail.app&&!app) return;    /* an app the sheet cannot check never falls back to the browser */
    var tile=(!app&&typeof btFind==='function')?btFind(anchor):null;
    var s={ state:'opening', timer:null, pwTimer:null, secret:null, entryId:null, method:'password', closed:false, retry:null, app:app };
    var node=document.createElement('div'); node.className='ph-tosheet';
    node.setAttribute('role','dialog'); node.setAttribute('aria-modal','true');
    var head=document.createElement('div'); head.className='to-head';
    var host=document.createElement('span'); host.className='to-host';
    host.textContent=(app&&app.label)?app.label:(typeof btHost==='function')?btHost(tile?tile.domain:null):'';
    var back=toButton('to-back btn btn-primary',TO_HAND_BACK);
    head.appendChild(host); head.appendChild(back);
    var status=line('to-status',''); status.setAttribute('role','status'); status.hidden=true;
    var parts=toPwParts(s);
    var view=document.createElement('div'); view.className='to-view';
    node.appendChild(head); node.appendChild(status); node.appendChild(parts.pwRow); node.appendChild(parts.reauth); node.appendChild(view);
    s.node=node; s.status=status; s.back=back; s.view=view; s.host=host;
    toSheet=s;
    if(toIsBrowser(s)) toMine(false);
    (el('perch-hub-root')||document.body).appendChild(node);
    back.onclick=function(){ toHandBack(s); };
    if(back.focus) back.focus();
    if(!toIsBrowser(s)){
      /* another app: no keychain lookup (the browser's VNC password only) */
      perchApi('POST','/apps/'+encodeURIComponent(app.id)+'/take-over').then(function(r){
        /* its lease is not confirmed any more: nothing was taken; Hand back closes the sheet */
        if(r&&r.status===409){ if(toSheet===s&&!s.closed){ s.state='ended'; toSetStatus(s,TO_FAILED); } return; }
        toAnswer(s,r);
      });
      return;
    }
    toFindPassword(s);
    /* From a link: the server takes it only while that chat's turn uses the browser. */
    var body=(detail&&detail.link)?{ from:'link', sid:String(detail.sid||'') }:undefined;
    perchApi('POST','/browser/take-over',body).then(function(r){
      /* a stale link: say so (nothing was taken); Hand back closes the sheet */
      if(r&&r.status===409){ if(toSheet===s&&!s.closed){ s.state='ended'; toSetStatus(s,TO_NOT_WAITING); } return; }
      toAnswer(s,r);
    });
  }

  /* The password row and its re-auth panel, on s (s.copy, s.hint, s.pw,
     s.reauth, s.rInput, s.rErr). Built for the sheet, and for the browser's
     app tile (R1.2 PR 5: its watch view meets the same noVNC password prompt),
     where s.inTile is set: the same lookup, reveal and re-auth, alive until
     the tile closes (toPwClose) instead of until the sheet does. */
  function toPwParts(s){
    var pwRow=document.createElement('div'); pwRow.className='to-pw-row';
    var copy=toButton('to-copy btn btn-secondary',TO_COPY); copy.hidden=true;
    var hint=line('to-hint',''); hint.hidden=true;
    var pw=document.createElement('code'); pw.className='to-pw'; pw.hidden=true;
    pwRow.appendChild(copy); pwRow.appendChild(hint); pwRow.appendChild(pw);
    var reauth=document.createElement('div'); reauth.className='to-reauth'; reauth.hidden=true;
    var rTitle=line('to-reauth-title',TO_REAUTH_TITLE);
    var rInput=document.createElement('input'); rInput.className='to-reauth-input'; rInput.type='password';
    rInput.setAttribute('autocomplete','current-password');
    var rErr=line('to-reauth-error',''); rErr.setAttribute('role','alert');
    var rGo=toButton('to-reauth-go btn btn-primary',TO_CONFIRM);
    var rCancel=toButton('to-reauth-cancel btn btn-secondary',TO_CANCEL);
    reauth.appendChild(rTitle); reauth.appendChild(rInput); reauth.appendChild(rErr); reauth.appendChild(rGo); reauth.appendChild(rCancel);
    s.copy=copy; s.hint=hint; s.pw=pw; s.reauth=reauth; s.rInput=rInput; s.rErr=rErr;
    copy.onclick=function(){ toCopy(s); };
    rGo.onclick=function(){ toReauth(s); };
    rCancel.onclick=function(){ s.retry=null; rInput.value=''; reauth.hidden=true; };
    return { pwRow:pwRow, reauth:reauth };
  }
  /* A reply that arrives after its sheet (or its tile's row) closed is dropped. */
  function toGone(s){ return s.closed||(!s.inTile&&toSheet!==s); }
  /* The tile's row closes: nothing of the password is left. */
  function toPwClose(s){ s.closed=true; toWipePassword(s); s.rInput.value=''; s.retry=null; }

  function toSetStatus(s,text){ s.status.textContent=text; s.status.hidden=!text; }

  /* One server answer (take-over or heartbeat) → the sheet's state. */
  function toAnswer(s,r){
    if(s.closed||toSheet!==s) return;
    var st=r&&r.ok&&r.j?r.j.state:null;
    if(st==='held'){
      /* the bot is paused on you; Hand back is the way out */
      toSetStatus(s,TO_WAITING);
      if(s.state!=='held'){ s.state='held'; toViewer(s); }
      toSchedule(s,TO_HEARTBEAT_MS);
      return;
    }
    if(st==='pending'){
      s.state='pending'; toSetStatus(s,TO_FINISHING);
      toSchedule(s,TO_PENDING_MS);
      return;
    }
    if(st==='idle'){
      /* held: the browser went back (5-minute loss). Not yet held: the take-over gave up. */
      if(s.state==='held'){ closeTakeOver(); if(toIsBrowser(s)) toMine(false); return; }
      s.state='ended'; toSetStatus(s,TO_FAILED);
      return;
    }
    /* busy (503), no browser (404), a dropped connection: say so and keep checking; Hand back still closes */
    toSetStatus(s,TO_FAILED);
    if(s.state==='held') toSchedule(s,TO_HEARTBEAT_MS);
    else if(s.state==='pending') toSchedule(s,TO_PENDING_MS);
  }

  function toSchedule(s,ms){
    if(s.timer) clearTimeout(s.timer);
    s.timer=setTimeout(function(){
      s.timer=null;
      if(s.closed||toSheet!==s||!live()) return;
      toOp(s,'heartbeat').then(function(r){ toAnswer(s,r); });
    },ms);
  }

  function toViewer(s){
    if(s.frame) return;
    var f=document.createElement('iframe'); f.className='to-vnc';
    f.setAttribute('title',(s.app&&s.app.label)?s.app.label:'VNC');
    /* view_only pinned off: noVNC keeps that setting in its own browser storage, and the
       Browser panel's (and the app tile's) watch-only viewer sets it on the same origin */
    f.setAttribute('src',(s.app?s.app.base:'/proxy/browser/vnc.html')+'?autoconnect=true&resize=scale&view_only=false');
    s.view.appendChild(f); s.frame=f;
  }

  function toHandBack(s){
    /* ended (a dead link, or a take-over that gave up): this sheet never took
       the browser, so Hand back only closes it. A live holding elsewhere (another
       tab) is left alone, and its "You have the browser" control comes back. */
    if(s.state==='ended'){ closeTakeOver(); toMineRefresh(); return; }
    if(s.backing) return;
    s.backing=true; s.back.disabled=true;
    toOp(s,'hand-back').then(function(r){
      s.backing=false; s.back.disabled=false;
      if(s.closed||toSheet!==s) return;
      if(r&&r.ok){ closeTakeOver(); if(toIsBrowser(s)) toMine(false); return; }
      toSetStatus(s,TO_FAILED);
    });
  }

  /* ---- Copy password (the keychain's own reveal + re-auth, §7 item 13) ---- */
  function toFindPassword(s){
    toKeychain('GET','/entries').then(function(r){
      if(toGone(s)) return;
      var list=(r.status===200&&r.j&&Array.isArray(r.j.entries))?r.j.entries:[];
      var hit=null;
      for(var i=0;i<list.length;i++){
        var e=list[i];
        if(e&&e.bundle_id==='browser'&&e.env_key==='CROW_BROWSER_VNC_PASSWORD'&&e.readable!==false){ hit=e; break; }
      }
      if(r.j&&r.j.reauth_method==='totp') s.method='totp';
      if(!hit){ s.copy.hidden=true; s.hint.textContent=TO_NO_PASSWORD; s.hint.hidden=false; return; }
      s.entryId=hit.id; s.copy.hidden=false; s.hint.hidden=true;
    });
  }
  function toCopy(s){
    if(s.entryId==null||s.copying) return;
    s.copying=true;
    toKeychain('POST','/reveal',{ id:s.entryId, purpose:'copy' }).then(function(r){
      s.copying=false;
      if(toGone(s)) return;
      if(r.status===403&&r.j&&r.j.code==='reauth_required'){ toNeedAuth(s,function(){ toCopy(s); }); return; }
      if(r.status!==200||typeof r.j.secret!=='string'){ s.hint.textContent=TO_PW_ERROR; s.hint.hidden=false; return; }
      var secret=r.j.secret; r.j.secret=null;
      var clip=(typeof navigator!=='undefined'&&navigator.clipboard&&typeof navigator.clipboard.writeText==='function')?navigator.clipboard:null;
      var shown=function(){ toShowPassword(s,secret); secret=null; };
      if(!clip){ shown(); return; }
      var w;
      try{ w=clip.writeText(secret); }catch(e){ shown(); return; }
      Promise.resolve(w).then(function(){
        secret=null;
        if(s.closed) return;
        s.copy.textContent=TO_COPIED;
        setTimeout(function(){ if(!s.closed) s.copy.textContent=TO_COPY; },3000);
      },shown);
    });
  }
  /* The clipboard refused: show it briefly, then nothing of it is left. */
  function toShowPassword(s,secret){
    if(s.closed) return;
    s.pw.textContent=secret; s.pw.hidden=false;
    if(s.pwTimer) clearTimeout(s.pwTimer);
    s.pwTimer=setTimeout(function(){ s.pwTimer=null; toWipePassword(s); },TO_SHOW_PW_MS);
  }
  function toWipePassword(s){
    if(s.pwTimer){ clearTimeout(s.pwTimer); s.pwTimer=null; }
    s.pw.textContent=''; s.pw.hidden=true;
  }
  function toNeedAuth(s,retry){
    s.retry=retry;
    s.rInput.type=s.method==='totp'?'text':'password';
    s.rInput.setAttribute('placeholder',s.method==='totp'?TO_REAUTH_TOTP:TO_REAUTH_PASSWORD);
    s.rInput.setAttribute('aria-label',s.method==='totp'?TO_REAUTH_TOTP:TO_REAUTH_PASSWORD);
    s.rInput.value=''; s.rErr.textContent=''; s.reauth.hidden=false;
    if(s.rInput.focus) s.rInput.focus();
  }
  function toReauth(s){
    var v=String(s.rInput.value||'');
    var body=s.method==='totp'?{ totp_code:v }:{ password:v };
    toKeychain('POST','/reauth',body).then(function(r){
      s.rInput.value='';
      if(toGone(s)) return;
      if(r.status===200){
        s.reauth.hidden=true;
        var next=s.retry; s.retry=null;
        if(next) next();
        return;
      }
      s.rErr.textContent=(r.j&&typeof r.j.error==='string')?r.j.error:TO_PW_ERROR;
    });
  }

  /* Closes the UI only: the holding stays until Hand back or the 5-minute loss. */
  function closeTakeOver(){
    var s=toSheet; toSheet=null;
    if(!s) return;
    s.closed=true;
    if(s.timer){ clearTimeout(s.timer); s.timer=null; }
    toWipePassword(s);
    s.rInput.value='';
    if(s.frame){ try{ s.frame.setAttribute('src','about:blank'); }catch(e){} }
    if(s.node.parentNode) s.node.parentNode.removeChild(s.node);
  }

  /* "You have the browser · Hand back" (#perch-browser-mine): shown on load
     while the server says the operator holds or is taking the browser, so
     leaving the sheet never strands the operator without a way to hand back. */
  function toMine(on){ var b=el('perch-browser-mine'); if(b&&b.hidden!==!on) b.hidden=!on; }
  function toMineRefresh(){
    if(!el('perch-browser-mine')) return;
    perchApi('GET','/browser/state').then(function(r){
      if(!live()||toSheet) return;
      var st=r&&r.ok&&r.j?r.j.state:null;
      toMine(st==='held'||st==='pending');
    });
  }
  (function(){
    var b=el('perch-browser-mine'); if(!b) return;
    b.onclick=function(){
      if(b.disabled) return;
      b.disabled=true;
      toApi('hand-back').then(function(r){ b.disabled=false; if(r&&r.ok) toMine(false); });
    };
  })();

  bindOnce(document,'perch:browser-takeover','takeOver',function(ev){
    if(!live()) return;
    openTakeOver(ev&&ev.detail);
  });
  /* A "?take-over=1" link (the wait_for_user attention item, the Browser panel):
     open the sheet once, and drop the flag so a reload does not reopen it. */
  function takeOverFromLink(){
    var q=String(location.search||'');
    var m=/(^|[?&])take-over=(1|panel)(&|$)/.exec(q);
    if(!m) return;
    try{
      var rest=q.replace(/^[?]/,'').split('&').filter(function(p){ return p&&p!=='take-over=1'&&p!=='take-over=panel'; }).join('&');
      history.replaceState(history.state,'',location.pathname+(rest?'?'+rest:'')+location.hash);
    }catch(e){}
    /* "1": a needs-you item or a chat's link (checked against that chat's live
       turn). "panel": the Browser panel's own Take over of a non-Perch holder. */
    openTakeOver({ sid:current.sid, anchor:null, link:m[2]==='1' });
  }
`;
}
