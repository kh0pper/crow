import { tJs } from "../shared/i18n.js";

/**
 * Perch composer dictation (queue item 15): a one-shot recording in the chat
 * composer. Tap "Dictate", speak, then ■ Done (the text lands in the
 * composer to edit) or ↑ Send (it lands and is sent at once); ✕ drops it.
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), like phone-card.js and
 * artifact-card.js, so it shares that scope's el / current / send / csrf /
 * API / live / bindOnce / turnInFlight / STEER_LABEL / SEND_LABEL. client.js
 * carries only the hooks: resetControls() cancels and re-probes,
 * HUB.retire cancels.
 *
 * Its own audio path, NOT the header mic ("Talk to Crow", the kiosk's voice
 * loop): MediaRecorder, no VAD, no TTS, no turn loop, no Kiosk extension
 * needed. The server half is routes/perch-dictation.js. The recorder is a
 * small self-contained block (start / stop → Blob / cancel) another surface
 * can lift later; nothing is shared now.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - createElement/textContent only.
 *  - No raw document/window listener: the one document listener
 *    (visibilitychange) goes through bindOnce, guarded with live().
 *  - Every exit (stop, cancel, error, session switch, retire, hide) stops the
 *    tracks, closes the AudioContext (an idle one keeps a call-type stream
 *    alive in the Android app) and pairs captureStarting with captureEnded on
 *    the app's CrowAudioPort.
 *  - One microphone at a time (the kiosk's createMicGate idea): a stream that
 *    resolves after a cancel, a session switch, a retire or a hide has its
 *    tracks stopped at once and never starts a recording.
 */
export function perchDictationJs(lang = "en") {
  return `
  /* ---- Composer dictation (queue item 15) -------------------------------- */
  var DICT_STARTING='${tJs("perch.dictationStarting", lang)}';
  var DICT_RECORDING='${tJs("perch.dictationRecording", lang)}';
  var DICT_TRANSCRIBING='${tJs("perch.dictationTranscribing", lang)}';
  var DICT_VIA='${tJs("perch.dictationVia", lang)}';
  var DICT_EMPTY='${tJs("perch.dictationEmpty", lang)}';
  var DICT_BLOCKED='${tJs("perch.dictationBlocked", lang)}';
  var DICT_NO_MIC='${tJs("perch.dictationNoMic", lang)}';
  var DICT_BUSY='${tJs("perch.dictationBusy", lang)}';
  var DICT_PROFILE_CHANGED='${tJs("perch.dictationProfileChanged", lang)}';
  var DICT_TOO_MANY='${tJs("perch.dictationTooMany", lang)}';
  var DICT_TOO_LONG='${tJs("perch.dictationTooLong", lang)}';
  var DICT_TIMEOUT='${tJs("perch.dictationTimeout", lang)}';
  var DICT_FAILED='${tJs("perch.dictationFailed", lang)}';
  var DICT_MSG={empty:DICT_EMPTY,blocked:DICT_BLOCKED,noMic:DICT_NO_MIC,busy:DICT_BUSY,
    profileChanged:DICT_PROFILE_CHANGED,tooMany:DICT_TOO_MANY,tooLong:DICT_TOO_LONG,
    timeout:DICT_TIMEOUT,failed:DICT_FAILED};

  /* ---- pure helpers (unit-tested by extraction) ---- */
  /* The MIME ladder: opus in webm, opus in ogg, AAC in mp4 (Safari), else
     the browser's default ('' = let MediaRecorder choose). */
  function pickMimeType(isTypeSupported){
    var ladder=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'];
    if(typeof isTypeSupported!=='function') return '';
    for(var i=0;i<ladder.length;i++){ try{ if(isTypeSupported(ladder[i])) return ladder[i]; }catch(e){} }
    return '';
  }
  /* The default-mime rung leaves blob.type empty: fall back to what the
     recorder says it made, or the route answers 415. */
  function uploadType(blob,recorder){
    return (blob&&blob.type)||(recorder&&recorder.mimeType)||'';
  }
  /* Safari ignores the bitrate: 64 kbps AAC x 120 s is too close to the 1 MB
     cap, so the mp4 rung stops at 90 s. */
  function capSeconds(maxSeconds,mime){
    var cap=Number(maxSeconds)>0?Number(maxSeconds):60;
    if(String(mime||'').indexOf('audio/mp4')===0) cap=Math.min(cap,90);
    return cap;
  }
  function mergeTranscript(existing,text){
    var add=String(text==null?'':text).trim();
    var base=String(existing==null?'':existing);
    while(base.length&&(base.charAt(base.length-1)===' '||base.charAt(base.length-1)==='\\t')) base=base.slice(0,-1);
    if(!add) return base;
    if(!base) return add;
    if(base.charAt(base.length-1)==='\\n') return base+add;
    return base+' '+add;
  }
  function formatElapsed(ms){
    var s=Math.max(0,Math.floor((Number(ms)||0)/1000));
    var m=Math.floor(s/60), r=s%60;
    return m+':'+(r<10?'0':'')+r;
  }
  /* Everything the browser must offer before the mic may show. getUserMedia
     needs a secure context (Serve HTTPS or localhost; plain-http LAN access
     is not one), and a frame without allow="microphone" rejects it. */
  function dictationSupported(win,doc){
    if(!win||!win.isSecureContext) return false;
    var nav=win.navigator;
    if(!nav||!nav.mediaDevices||typeof nav.mediaDevices.getUserMedia!=='function') return false;
    if(typeof win.MediaRecorder!=='function') return false;
    try{
      var pol=doc&&(doc.permissionsPolicy||doc.featurePolicy);
      if(pol&&typeof pol.allowsFeature==='function'&&pol.allowsFeature('microphone')===false) return false;
    }catch(e){}
    return true;
  }
  /* (HTTP status, error code or DOMException name) -> a DICT_MSG key. */
  function errorKeyFor(status,code){
    if(code==='NotAllowedError'||code==='SecurityError') return 'blocked';
    if(code==='NotFoundError'||code==='OverconstrainedError'||code==='NotReadableError') return 'noMic';
    if(code==='empty') return 'empty';
    if(status===409&&code==='dictation_busy') return 'busy';
    if(status===409&&code==='profile_changed') return 'profileChanged';
    if(status===429) return 'tooMany';
    if(status===413) return 'tooLong';
    if(status===504) return 'timeout';
    return 'failed';
  }
  /* idle -> starting -> recording -> transcribing -> idle | error. */
  function nextState(state,ev){
    if(ev==='cancel') return 'idle';
    if(ev==='start') return state==='idle'?'starting':state;
    if(ev==='granted') return state==='starting'?'recording':state;
    if(ev==='stop'||ev==='cap') return state==='recording'?'transcribing':state;
    if(ev==='hide'){
      if(state==='starting') return 'idle';
      if(state==='recording') return 'transcribing';
      return state;
    }
    if(ev==='done') return state==='transcribing'?'idle':state;
    if(ev==='fail') return (state==='starting'||state==='transcribing'||state==='recording')?'error':state;
    if(ev==='retry') return state==='error'?'transcribing':state;
    return state;
  }

  /* ---- runtime ---- */
  var DICT={state:'idle',probe:null,supported:false,gen:0,sid:null,stream:null,rec:null,chunks:[],
    ctx:null,analyser:null,raf:0,tick:0,startedAt:0,capS:60,blob:null,mime:'',action:'done',
    portOpen:false,pausedPlayer:false,xhr:null,probeSeq:0};

  function dictSet(state,note){
    DICT.state=state;
    var comp=el('perch-composer'), bar=el('perch-dictation-bar');
    if(comp) comp.setAttribute('data-dictation',state);
    if(bar) bar.hidden=state==='idle';
    var st=el('perch-dict-status');
    if(st){
      var t='';
      if(state==='starting') t=DICT_STARTING;
      else if(state==='recording') t=DICT_RECORDING;
      else if(state==='transcribing') t=DICT_TRANSCRIBING;
      else if(state==='error') t=note||DICT_MSG.failed;
      st.textContent=t;
    }
    var retry=el('perch-dict-retry'); if(retry) retry.hidden=!(state==='error'&&DICT.blob);
    dictSendLabel();
    dictHint();
    /* Keyboard focus follows the bar, so it never drops to <body> when the
       control that had it (Done, Send, Retry) leaves the screen. */
    var cancelBtn=el('perch-dict-cancel');
    if(state==='transcribing'&&cancelBtn&&cancelBtn.focus) cancelBtn.focus();
    if(state==='error'){
      var target=(retry&&!retry.hidden)?retry:cancelBtn;
      if(target&&target.focus) target.focus();
    }
  }
  /* The bar's ↑ steers while a turn runs, because send() does. */
  function dictSendLabel(){
    var b=el('perch-dict-send'); if(!b) return;
    var word=turnInFlight?STEER_LABEL:SEND_LABEL;
    b.setAttribute('aria-label',word); b.setAttribute('title',word);
    var w=b.querySelector?b.querySelector('.dict-word'):null; if(w) w.textContent=word;
  }
  function dictHint(){
    var h=el('perch-dictation-hint'); if(!h) return;
    var p=DICT.probe;
    var show=!!(p&&p.cloud&&p.provider)&&(DICT.state==='recording'||DICT.state==='transcribing'||DICT.state==='error');
    h.textContent=show?DICT_VIA.split('{provider}').join(String(p.provider)):'';
    h.hidden=!show;
  }
  function dictShowMic(on){
    var mic=el('perch-dictate'); if(mic) mic.hidden=!on;
    var comp=el('perch-composer');
    if(comp&&comp.classList) comp.classList.toggle('has-dictate',!!on);
  }
  function dictPort(op){
    var port=window.CrowAudioPort;
    if(!port||typeof port.postMessage!=='function') return;
    try{ port.postMessage('{"op":"'+op+'"}'); }catch(e){}
  }
  function stopTracks(stream){
    try{ stream.getTracks().forEach(function(t){ try{ t.stop(); }catch(e){} }); }catch(e){}
  }
  /* The player bar: a local track is paused while the mic is open and
     resumed after. Glasses / kiosk playback is somewhere else: untouched. */
  function dictPausePlayer(){
    var p=window.crowPlayer;
    try{
      if(p&&p.isPlaying&&p.isPlaying()&&p.getBackend&&p.getBackend()==='local'){ p.toggle(); DICT.pausedPlayer=true; }
    }catch(e){}
  }
  function dictResumePlayer(){
    if(!DICT.pausedPlayer) return;
    DICT.pausedPlayer=false;
    var p=window.crowPlayer;
    try{ if(p&&p.isPlaying&&!p.isPlaying()&&p.getBackend&&p.getBackend()==='local') p.toggle(); }catch(e){}
  }
  /* Everything the microphone holds, released. Safe to call twice. */
  function dictTeardown(){
    if(DICT.raf&&window.cancelAnimationFrame){ try{ window.cancelAnimationFrame(DICT.raf); }catch(e){} }
    DICT.raf=0;
    if(DICT.tick){ clearInterval(DICT.tick); DICT.tick=0; }
    if(DICT.rec){ var r=DICT.rec; DICT.rec=null; r.ondataavailable=null; r.onstop=null; r.onerror=null;
      try{ if(r.state!=='inactive') r.stop(); }catch(e){} }
    if(DICT.stream){ stopTracks(DICT.stream); DICT.stream=null; }
    if(DICT.ctx){ var c=DICT.ctx; DICT.ctx=null; DICT.analyser=null; try{ c.close(); }catch(e){} }
    if(DICT.portOpen){ DICT.portOpen=false; dictPort('captureEnded'); }
    dictResumePlayer();
    var time=el('perch-dict-time'); if(time&&time.classList) time.classList.remove('late');
  }
  /* The hook: drop any recording or pending transcript, release the mic.
     Called by resetControls() (a session switch) and HUB.retire (a Turbo
     visit), and by the bar's ✕. */
  function dictationCancel(){
    if(!DICT) return;
    DICT.gen++;
    if(DICT.xhr){ try{ DICT.xhr.abort(); }catch(e){} DICT.xhr=null; }
    dictTeardown();
    DICT.blob=null; DICT.chunks=[];
    dictSet('idle');
  }
  function dictCancelByUser(){
    dictationCancel();
    var mic=el('perch-dictate'); if(mic&&!mic.hidden&&mic.focus) mic.focus();
  }

  /* Capability: the browser checks once per page instance, the server probe
     on every session open (resetControls). Until both say yes the mic stays
     hidden and the composer is exactly what it was. */
  DICT.supported=dictationSupported(window,document);
  function dictationProbe(){
    if(!DICT.supported){ dictShowMic(false); return; }
    var seq=++DICT.probeSeq;
    return perchApi('GET','/dictation').then(function(r){
      if(!live()||seq!==DICT.probeSeq) return;
      DICT.probe=(r.ok&&r.j)?r.j:null;
      dictShowMic(!!(DICT.probe&&DICT.probe.available));
      dictHint();
    });
  }

  function dictLevelDots(){
    var lv=el('perch-dict-level'); if(!lv) return [];
    if(!lv.children||lv.children.length===0){
      for(var i=0;i<28;i++) lv.appendChild(document.createElement('i'));
    }
    return lv.children;
  }
  function dictReducedMotion(){
    try{ return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(e){ return false; }
  }
  function dictMeter(token){
    var dots=dictLevelDots();
    if(!DICT.analyser||!dots.length||dictReducedMotion()||!window.requestAnimationFrame) return;
    var buf=new Uint8Array(DICT.analyser.fftSize);
    var hist=[];
    var frame=function(){
      if(token!==DICT.gen||DICT.state!=='recording'||!DICT.analyser) return;
      DICT.analyser.getByteTimeDomainData(buf);
      var peak=0;
      for(var i=0;i<buf.length;i++){ var v=Math.abs(buf[i]-128); if(v>peak) peak=v; }
      hist.push(Math.min(1,peak/64));
      if(hist.length>dots.length) hist.shift();
      for(var j=0;j<dots.length;j++){
        var a=hist[hist.length-dots.length+j];
        dots[j].style.transform='scaleY('+(1+5*(a||0)).toFixed(2)+')';
      }
      DICT.raf=window.requestAnimationFrame(frame);
    };
    DICT.raf=window.requestAnimationFrame(frame);
  }
  function dictTick(token){
    if(token!==DICT.gen||DICT.state!=='recording') return;
    var ms=Date.now()-DICT.startedAt;
    var time=el('perch-dict-time');
    if(time){
      time.textContent=formatElapsed(ms);
      if(time.classList) time.classList.toggle('late',DICT.capS*1000-ms<=10000);
    }
    dictSendLabel();
    if(ms>=DICT.capS*1000) dictStop('done');
  }

  /* ✕-safe start. The AudioContext is made (or resumed) synchronously inside
     the tap, before getUserMedia is awaited, or iOS leaves it suspended. */
  function dictStart(){
    if(nextState(DICT.state,'start')!=='starting') return;   /* double tap ignored */
    if(!DICT.probe||!DICT.probe.available||!current.sid) return;
    var AC=window.AudioContext||window.webkitAudioContext;
    try{ DICT.ctx=AC?new AC():null; if(DICT.ctx&&DICT.ctx.resume) DICT.ctx.resume().catch(function(){}); }catch(e){ DICT.ctx=null; }
    var token=++DICT.gen;
    DICT.sid=current.sid; DICT.blob=null; DICT.chunks=[]; DICT.action='done';
    dictSet('starting');
    var cancel=el('perch-dict-cancel'); if(cancel&&cancel.focus) cancel.focus();
    DICT.portOpen=true; dictPort('captureStarting');
    var p;
    try{
      p=window.navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:true,autoGainControl:true,channelCount:1}});
    }catch(e){ p=Promise.reject(e); }
    Promise.resolve(p).then(function(stream){
      /* The mic gate: anything that moved on while the prompt was up owns
         this stream now, and it is released at once. */
      if(token!==DICT.gen||!live()||DICT.state!=='starting'||current.sid!==DICT.sid||
         document.body.getAttribute('data-view')!=='chat'){ stopTracks(stream); return; }
      DICT.stream=stream;
      dictBeginRecording(token);
    },function(err){
      if(token!==DICT.gen) return;
      dictTeardown();
      dictSet('error',DICT_MSG[errorKeyFor(0,err&&err.name)]);
    });
  }
  function dictBeginRecording(token){
    var MR=window.MediaRecorder;
    var mime=pickMimeType(function(t){ return MR.isTypeSupported&&MR.isTypeSupported(t); });
    var rec;
    try{
      rec=mime?new MR(DICT.stream,{mimeType:mime,audioBitsPerSecond:32000}):new MR(DICT.stream,{audioBitsPerSecond:32000});
    }catch(e){ dictTeardown(); dictSet('error',DICT_MSG.failed); return; }
    DICT.rec=rec; DICT.chunks=[];
    rec.ondataavailable=function(ev){ if(token===DICT.gen&&ev.data&&ev.data.size) DICT.chunks.push(ev.data); };
    rec.onstop=function(){ dictRecorderStopped(token,rec); };
    /* A recorder that fails mid-recording (the device went away): stop now and
       transcribe what was captured, rather than waiting for Done or the cap. */
    rec.onerror=function(){ if(token===DICT.gen&&DICT.state==='recording') dictStop('done'); };
    /* A 1 s timeslice: what was captured is already in DICT.chunks if the
       recorder fails, instead of only in a final flush that may never come. */
    try{ rec.start(1000); }catch(e){ dictTeardown(); dictSet('error',DICT_MSG.failed); return; }
    DICT.capS=capSeconds(DICT.probe&&DICT.probe.maxSeconds,rec.mimeType||mime);
    if(DICT.ctx){
      try{
        var src=DICT.ctx.createMediaStreamSource(DICT.stream);
        var an=DICT.ctx.createAnalyser(); an.fftSize=256; src.connect(an); DICT.analyser=an;
      }catch(e){ DICT.analyser=null; }
    }
    DICT.startedAt=Date.now();
    var time=el('perch-dict-time'); if(time) time.textContent=formatElapsed(0);
    dictPausePlayer();
    dictSet(nextState('starting','granted'));
    var done=el('perch-dict-done'); if(done&&done.focus) done.focus();
    dictMeter(token);
    DICT.tick=setInterval(function(){ dictTick(token); },250);
  }
  /* ■ Done / ↑ Send / the cap / a hidden page: stop, then transcribe. */
  function dictStop(action){
    if(DICT.state!=='recording') return;
    DICT.action=action==='send'?'send':'done';
    var rec=DICT.rec;
    dictSet('transcribing');
    if(DICT.tick){ clearInterval(DICT.tick); DICT.tick=0; }
    if(!rec||rec.state==='inactive'){ dictRecorderStopped(DICT.gen,rec); return; }
    try{ rec.stop(); }catch(e){ dictRecorderStopped(DICT.gen,rec); }
  }
  function dictRecorderStopped(token,rec){
    if(token!==DICT.gen) return;
    var type=uploadType(DICT.chunks[0]||null,rec);
    DICT.blob=new Blob(DICT.chunks,{type:type});
    DICT.mime=uploadType(DICT.blob,rec);
    DICT.chunks=[];
    dictTeardown();                     /* the mic is released before the upload, not after */
    dictUpload();
  }
  function dictFocusInput(input){
    if(!input||!input.focus) return;
    input.focus();
    try{ var n=input.value.length; input.setSelectionRange(n,n); }catch(e){}
  }
  /* The upload. XHR, not fetch, only so ✕ can abort it; the server keeps a
     local job running anyway (its lock holds until it settles) and the
     result is dropped by the generation check. */
  function dictUpload(){
    if(!DICT.blob) return;
    var token=DICT.gen, mySid=DICT.sid, action=DICT.action;
    dictSet('transcribing');
    var done=function(status,j){
      DICT.xhr=null;
      if(token!==DICT.gen||!live()) return;
      if(current.sid!==mySid){ dictationCancel(); return; }
      var code=j&&j.error;
      if(status>=200&&status<300){
        var text=String((j&&j.text)||'').trim();
        if(!text){ dictSet('error',DICT_MSG.empty); return; }
        DICT.blob=null;
        var input=el('perch-input');
        if(input){
          input.value=mergeTranscript(input.value,text);
          input.style.height='auto';
          input.style.height=Math.min(input.scrollHeight||72,120)+'px';
          /* Shell P2 (client.js): a dictated draft is saved like a typed one. */
          if(typeof draftSave==='function') draftSave();
        }
        dictSet(nextState('transcribing','done'));
        if(action==='send'){ send(); dictFocusInput(input); return; }
        dictFocusInput(input);
        return;
      }
      /* A settings change since the probe: refresh where it goes (the hint),
         keep the Blob, and let the operator choose Retry. */
      if(status===409&&code==='profile_changed') dictationProbe();
      dictSet('error',DICT_MSG[errorKeyFor(status,code)]);
    };
    var x=new XMLHttpRequest();
    DICT.xhr=x;
    x.open('POST',API+'/dictation');
    var headers={'Content-Type':DICT.mime||'audio/webm','X-Crow-Csrf':csrf(),'X-Crow-Dictation-Profile':(DICT.probe&&DICT.probe.profileTag)||''};
    for(var h in headers) x.setRequestHeader(h,headers[h]);
    x.onload=function(){ var j=null; try{ j=JSON.parse(x.responseText); }catch(e){} done(x.status,j); };
    x.onerror=function(){ done(0,null); };
    x.send(DICT.blob);
  }

  /* Wiring: onclick slots (Turbo replaces the elements with the body), plus
     the one bound document listener. */
  (function(){
    /* A Turbo snapshot taken mid-recording must never come back on Back. */
    var comp=el('perch-composer'); if(comp) comp.setAttribute('data-dictation','idle');
    var bar=el('perch-dictation-bar'); if(bar) bar.hidden=true;
    var mic=el('perch-dictate');
    if(mic) mic.onclick=dictStart;
    var c=el('perch-dict-cancel'); if(c) c.onclick=dictCancelByUser;
    var d=el('perch-dict-done'); if(d) d.onclick=function(){ dictStop('done'); };
    var s=el('perch-dict-send'); if(s) s.onclick=function(){ dictStop('send'); };
    var r=el('perch-dict-retry'); if(r) r.onclick=function(){ if(DICT.state==='error'&&DICT.blob) dictUpload(); };
    /* Escape on the bar, not the document: stopPropagation keeps the artifact
       pane's document keydown from also firing. */
    if(bar) bar.onkeydown=function(ev){
      if(ev&&ev.key==='Escape'){ if(ev.stopPropagation) ev.stopPropagation(); if(ev.preventDefault) ev.preventDefault(); dictCancelByUser(); }
    };
  })();
  /* Hidden page: recording -> stop and transcribe into the composer (a locked
     phone keeps what was said); starting -> cancel quietly (the app's
     RECORD_AUDIO prompt is its own activity and pauses the WebView). */
  bindOnce(document,'visibilitychange','dictationHide',function(){
    if(!live()||document.visibilityState!=='hidden') return;
    var next=nextState(DICT.state,'hide');
    if(DICT.state==='starting'&&next==='idle') dictationCancel();
    else if(DICT.state==='recording') dictStop('done');
  });
`;
}
