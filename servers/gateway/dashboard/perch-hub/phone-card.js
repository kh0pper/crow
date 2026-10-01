import { tJs } from "../shared/i18n.js";

/**
 * The Perch phone call card (spec docs/superpowers/specs/2026-10-01-perch-phone-card-design.md §4.4).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's
 * el / line / clearEl / csrf / live / current / histSettled. Kept in its own
 * module so client.js only carries one-line hooks.
 *
 * Rules (house + spec):
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - I6: createElement/textContent only. business_name, goal, shareable values
 *    and transcript text are bot- or business-controlled and never markup.
 *  - I2: every card is built from the phone_calls row fetched by call_id; an SSE
 *    phone_call frame is only a hint to refetch.
 *  - I1: actions POST to /api/phone/calls/:id/{approve,reject,farend,stop}.
 *  - I7: approve/reject/farend controls only for a local password session
 *    (whoami.local === true); a non-local viewer gets a status-only pointer
 *    card with Stop while live, and no transcript.
 */
export function perchPhoneCardJs(lang = "en") {
  return `
  /* ---- Perch phone call card (spec 2026-10-01) ------------------------- */
  var PH_TITLE='${tJs("perch.phoneTitle", lang)}';
  var PH_GOAL='${tJs("perch.phoneGoal", lang)}';
  var PH_LIMITS='${tJs("perch.phoneLimits", lang)}';
  var PH_NO_LIMITS='${tJs("perch.phoneNoLimits", lang)}';
  var PH_LANG='${tJs("perch.phoneLanguage", lang)}';
  var PH_PROPOSED='${tJs("perch.phoneProposedTime", lang)}';
  var PH_SHARE='${tJs("perch.phoneShare", lang)}';
  var PH_BUSINESS='${tJs("perch.phoneBusiness", lang)}';
  var PH_CLOUD='${tJs("perch.phoneAllowCloud", lang)}';
  var PH_NO_CLOUD='${tJs("perch.phoneNoCloud", lang)}';
  var PH_TOTP='${tJs("perch.phoneTotp", lang)}';
  var PH_APPROVE='${tJs("perch.phoneApprove", lang)}';
  var PH_APPROVE_AT='${tJs("perch.phoneApproveAt", lang)}';
  var PH_REJECT='${tJs("perch.phoneReject", lang)}';
  var PH_APPROVED_AT='${tJs("perch.phoneApprovedAt", lang)}';
  var PH_STARTING='${tJs("perch.phoneStarting", lang)}';
  var PH_LIVE='${tJs("perch.phoneLive", lang)}';
  var PH_SAYS='${tJs("perch.phoneSays", lang)}';
  var PH_SEND='${tJs("perch.phoneSend", lang)}';
  var PH_STOP='${tJs("perch.phoneStop", lang)}';
  var PH_ANSWERED='${tJs("perch.phoneAnsweredPrompt", lang)}';
  var PH_OUTCOME='${tJs("perch.phoneOutcome", lang)}';
  var PH_OPEN='${tJs("perch.phoneOpenInPhone", lang)}';
  var PH_LOCAL_ONLY='${tJs("perch.phoneLocalOnly", lang)}';
  var PH_PLAN_CHANGED='${tJs("perch.phonePlanChanged", lang)}';
  var PH_FAILED='${tJs("perch.phoneActionFailed", lang)}';
  var PH_ST_PENDING='${tJs("perch.phoneStatusPending", lang)}';
  var PH_ST_REJECTED='${tJs("perch.phoneStatusRejected", lang)}';
  var PH_ST_EXPIRED='${tJs("perch.phoneStatusExpired", lang)}';
  var PH_ST_CANCELLED='${tJs("perch.phoneStatusCancelled", lang)}';
  var PH_ST_DONE='${tJs("perch.phoneStatusDone", lang)}';
  var PH_WHO_AGENT='${tJs("perch.phoneWhoAgent", lang)}';
  var PH_WHO_BUSINESS='${tJs("perch.phoneWhoBusiness", lang)}';
  var PH_WHO_STATE='${tJs("perch.phoneWhoState", lang)}';
  var PH_WHO_DIGITS='${tJs("perch.phoneWhoDigits", lang)}';

  /* call_id -> {node,view,key,hash,timer,tx,prompt,totp,flash} for THIS
     transcript. Dies with the transcript at the same three seams as fileSeen. */
  var phoneCards={};
  /* phone_call frames that arrived before the history batch settled; replayed
     by loadPhoneCards so a card never lands above the transcript it belongs under. */
  var phoneBuf=[];
  /* whoami: cached only when the server really answered (S5). */
  var phoneWhoP=null, phoneWhoLast=null;
  /* S13: whoami 404'd — no phone bundle here; stop asking for this document. */
  var phoneNoBundle=false;

  function resetPhoneCards(){
    for(var k in phoneCards){ if(phoneCards[k].timer) clearInterval(phoneCards[k].timer); }
    phoneCards={}; phoneBuf=[];
  }
  function phoneApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch('/api/phone'+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }
  function phoneNobody(){ return {local:false,totp_required:false,cloud_model:null}; }
  function phoneWhoami(){
    if(phoneNoBundle) return Promise.resolve(phoneNobody());
    if(phoneWhoP) return phoneWhoP;
    var p=phoneApi('GET','/whoami').then(function(r){
      if(r.ok&&r.j){
        phoneWhoLast={local:r.j.local===true,totp_required:r.j.totp_required===true,cloud_model:typeof r.j.cloud_model==='string'?r.j.cloud_model:null};
        return phoneWhoLast;
      }
      if(phoneWhoP===p) phoneWhoP=null;      /* a 500/502 mid-restart must not stick */
      if(r.status===404) phoneNoBundle=true;
      return phoneNobody();
    });
    phoneWhoP=p;
    return p;
  }
  /* pending | queued | live | terminal — the card's four shapes (spec §4.4). */
  function phoneView(status){
    if(status==='awaiting_approval') return 'pending';
    if(status==='approved'||status==='starting') return 'queued';
    if(status==='live') return 'live';
    return 'terminal';
  }
  /* I7: owner controls only for a local password session; Stop for anyone. */
  function phoneControls(who,view){
    var local=!!who&&who.local===true;
    return { approve: local&&view==='pending', farend: local&&view==='live', stop: view==='live' };
  }
  /* The business answered and nobody has typed its first line yet. */
  function phoneNeedsPrompt(transcript){
    var t=Array.isArray(transcript)?transcript:[], answered=false;
    for(var i=0;i<t.length;i++){
      var e=t[i]||{};
      if(e.type==='farend') return false;
      if(e.type==='state'&&e.state==='answered') answered=true;
    }
    return answered;
  }
  /* A card only ever lands in the chat that asked for the call. */
  function phoneBelongs(c,sid){
    return !!c&&typeof c.id==='string'&&!!c.deliver_to&&c.deliver_to.kind==='perch'&&c.deliver_to.session_id===sid;
  }
  /* S11: newest-first list in; open calls plus the newest finished one out, oldest first. */
  function phoneHistoryPick(calls){
    var out=[], term=false;
    (Array.isArray(calls)?calls:[]).forEach(function(c){
      if(!c||typeof c!=='object') return;
      if(phoneView(c.status)!=='terminal') out.push(c);
      else if(!term){ term=true; out.push(c); }
    });
    return out.reverse();
  }
  /* S4: an ISO time as a datetime-local value in the viewer's own clock. */
  function phoneLocalInput(iso){
    if(!iso) return '';
    var d=new Date(iso); if(isNaN(d.getTime())) return '';
    function p(n){ return (n<10?'0':'')+n; }
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
  }
  function phoneLimits(l){
    l=(l&&typeof l==='object')?l:{}; var out=[];
    if(l.date_range) out.push(String(l.date_range.from)+' – '+String(l.date_range.to));
    if(Array.isArray(l.days_of_week)&&l.days_of_week.length) out.push(l.days_of_week.join(', '));
    if(l.time_window) out.push(String(l.time_window.start)+'–'+String(l.time_window.end)+' '+String(l.time_window.tz||''));
    if(l.max_price) out.push('≤ '+String(l.max_price.amount)+' '+String(l.max_price.currency||''));
    if(l.duration_minutes) out.push(String(l.duration_minutes)+' min');
    if(l.notes) out.push(String(l.notes));
    return out.length?out.join('; '):PH_NO_LIMITS;
  }
  function phoneStatusText(status){
    var v=phoneView(status);
    if(v==='pending') return PH_ST_PENDING;
    if(v==='queued') return PH_STARTING;
    if(v==='live') return PH_LIVE;
    return ({done:PH_ST_DONE,rejected:PH_ST_REJECTED,expired:PH_ST_EXPIRED,cancelled:PH_ST_CANCELLED})[status]||String(status||'');
  }
  function phoneKey(c){ return [c.status,c.plan_hash,c.event_seq,c.outcome||''].join('|'); }
  function phoneButton(text){ var b=document.createElement('button'); b.type='button'; b.textContent=text; return b; }
  function phoneCheck(parent,text){
    var lab=document.createElement('label'); var cb=document.createElement('input'); cb.type='checkbox';
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' '+text)); parent.appendChild(lab); return cb;
  }
  function phoneLine(e){
    var t=(e.type==='agent'||e.type==='farend'||e.type==='dtmf')?e.type:'state';
    var who=t==='agent'?PH_WHO_AGENT:t==='farend'?PH_WHO_BUSINESS:t==='dtmf'?PH_WHO_DIGITS:PH_WHO_STATE;
    return line('ph-t ph-t-'+t, who+': '+String(e.text||e.digits||e.state||''));
  }
  function phoneShell(id){
    var tr=el('perch-transcript'); if(!tr) return null;
    var rec=phoneCards[id];
    if(!rec){
      rec=phoneCards[id]={node:document.createElement('div'),view:'',key:'',hash:'',timer:null,tx:null,prompt:null,totp:null,flash:''};
      rec.node.className='entry phonecard';
      tr.appendChild(rec.node); tr.scrollTop=tr.scrollHeight;
    }
    return rec;
  }
  function phoneStopPoll(rec){ if(rec&&rec.timer){ clearInterval(rec.timer); rec.timer=null; } }

  /* An SSE phone_call frame: a pointer only — refetch the row. */
  function phoneFrame(d,sid){
    if(!d||typeof d.call_id!=='string'||!d.call_id) return;
    phoneRefetch(d.call_id,sid,typeof d.status==='string'?d.status:'');
  }
  function phoneRefetch(id,sid,hint){
    phoneApi('GET','/calls/'+encodeURIComponent(id)).then(function(r){
      if(!live()||current.sid!==sid) return;
      if(r.ok&&r.j&&r.j.call){ upsertPhoneCard(r.j.call,sid,false); return; }
      /* Not a local password session: a status-only card from the gateway's
         own frame (never child bytes), with Stop while live (I7). */
      if(r.status===403&&hint) phonePointer(id,hint,sid);
    });
  }
  /* History: this chat's calls (I5-scoped server-side). 404 = no phone bundle,
     403 = not a local session; both mean no cards from history. */
  function loadPhoneCards(sid){
    var buf=phoneBuf; phoneBuf=[];
    phoneWhoami().then(function(){
      if(!live()||current.sid!==sid) return;
      if(phoneNoBundle) return;
      phoneApi('GET','/perch/'+encodeURIComponent(sid)+'/calls').then(function(r){
        if(!live()||current.sid!==sid) return;
        phoneHistoryPick((r.ok&&r.j&&Array.isArray(r.j.calls))?r.j.calls:[]).forEach(function(c){ upsertPhoneCard(c,sid,false); });
        buf.forEach(function(d){ phoneFrame(d,sid); });
      });
    });
  }
  function upsertPhoneCard(c,sid,force){
    if(!phoneBelongs(c,sid)) return;
    phoneWhoami().then(function(who){
      if(!live()||current.sid!==sid) return;
      var rec=phoneShell(c.id); if(!rec) return;
      var key=phoneKey(c), view=phoneView(c.status);
      if(!force&&rec.key===key) return;                  /* unchanged: keep a half-filled form */
      if(!force&&rec.view==='live'&&view==='live'){ rec.key=key; phoneLiveUpdate(rec,c); return; }
      /* S3: a pending plan that changed under the owner says so, and keeps a half-typed 2FA code. */
      if(rec.view==='pending'&&view==='pending'&&rec.hash&&rec.hash!==c.plan_hash) rec.flash=PH_PLAN_CHANGED;
      var keepTotp=(rec.view==='pending'&&rec.totp)?rec.totp.value:'';
      rec.key=key; rec.view=view; rec.hash=c.plan_hash||''; phoneStopPoll(rec); rec.tx=null; rec.prompt=null; rec.totp=null;
      clearEl(rec.node);
      rec.node.appendChild(line('ph-title',PH_TITLE+' — '+String(c.business_name||'')));
      rec.node.appendChild(line('ph-meta',String(c.number_e164||'')));
      if(rec.flash){ rec.node.appendChild(line('ph-err',rec.flash)); rec.flash=''; }
      var ctl=phoneControls(who,view);
      if(view==='pending') phoneRenderPending(rec,c,sid,who,ctl,keepTotp);
      else if(view==='queued') phoneRenderQueued(rec,c);
      else if(view==='live') phoneRenderLive(rec,c,sid,ctl);
      else phoneRenderTerminal(rec,c);
    });
  }
  function phoneRenderPending(rec,c,sid,who,ctl,keepTotp){
    var n=rec.node;
    n.appendChild(line('ph-status',PH_ST_PENDING));
    n.appendChild(line('ph-goal',PH_GOAL+': '+String(c.goal||'')));
    n.appendChild(line('ph-limits',PH_LIMITS+': '+phoneLimits(c.limits)));
    /* S4: the language is part of the plan hash and decides how the call sounds. */
    n.appendChild(line('ph-lang',PH_LANG+': '+(c.language==='es'?'Español':'English')));
    var proposed=c.run_after?new Date(c.run_after):null;
    if(proposed&&!isNaN(proposed.getTime())) n.appendChild(line('ph-proposed',PH_PROPOSED+': '+proposed.toLocaleString()));
    var sh=(c.shareable&&typeof c.shareable==='object')?c.shareable:{}, keys=Object.keys(sh);
    if(!ctl.approve){
      if(keys.length) n.appendChild(line('ph-share',PH_SHARE+': '+keys.join(', ')));
      n.appendChild(line('ph-note',PH_LOCAL_ONLY));
      return;
    }
    var form=document.createElement('form'); form.className='ph-form';
    form.onsubmit=function(ev){ ev.preventDefault(); };
    var tas={};
    if(keys.length){
      form.appendChild(line('ph-share',PH_SHARE));
      keys.forEach(function(k){
        var lab=document.createElement('label'); lab.textContent=k+' ';
        var ta=document.createElement('textarea'); ta.rows=1; ta.maxLength=200; ta.value=String(sh[k]==null?'':sh[k]);
        lab.appendChild(ta); form.appendChild(lab); tas[k]=ta;
      });
    }
    var biz=phoneCheck(form,PH_BUSINESS);
    var cloud=phoneCheck(form,PH_CLOUD+' ('+(who.cloud_model||PH_NO_CLOUD)+')');
    if(!who.cloud_model) cloud.disabled=true;
    var totp=null;
    if(who.totp_required){
      var tl=document.createElement('label'); tl.textContent=PH_TOTP+' ';
      totp=document.createElement('input'); totp.type='text'; totp.inputMode='numeric'; totp.maxLength=6; totp.autocomplete='one-time-code';
      if(keepTotp) totp.value=keepTotp;
      tl.appendChild(totp); form.appendChild(tl);
      rec.totp=totp;
    }
    var when=document.createElement('input'); when.type='datetime-local';
    when.setAttribute('aria-label',PH_APPROVE_AT);
    when.value=phoneLocalInput(c.run_after);
    var err=line('ph-err','');
    var acts=document.createElement('div'); acts.className='ph-actions';
    var bNow=phoneButton(PH_APPROVE), bAt=phoneButton(PH_APPROVE_AT), bRej=phoneButton(PH_REJECT);
    acts.appendChild(bNow); acts.appendChild(when); acts.appendChild(bAt); acts.appendChild(bRej);
    form.appendChild(acts); form.appendChild(err);
    function approve(runAfter){
      /* "Approve now" sends run_after null: now, even if the bot proposed a time. */
      var body={plan_hash:c.plan_hash,business_confirmed:biz.checked,allow_cloud:cloud.checked,run_after:runAfter||null};
      if(totp) body.totp=totp.value;
      if(keys.length){ var ed={}; keys.forEach(function(k){ ed[k]=tas[k].value; }); body.edits={shareable:ed}; }
      phoneAct(c.id,'/approve',body,sid,err);
    }
    bNow.onclick=function(){ approve(null); };
    bAt.onclick=function(){ if(!when.value){ when.focus(); return; } approve(new Date(when.value).toISOString()); };
    bRej.onclick=function(){ phoneAct(c.id,'/reject',{},sid,err); };
    n.appendChild(form);
  }
  function phoneRenderQueued(rec,c){
    var ra=(c.status==='approved'&&c.run_after)?new Date(c.run_after):null;
    var future=!!ra&&!isNaN(ra.getTime())&&ra.getTime()>Date.now();
    rec.node.appendChild(line('ph-status',future?PH_APPROVED_AT.split('{time}').join(ra.toLocaleString()):PH_STARTING));
  }
  function phoneRenderLive(rec,c,sid,ctl){
    var n=rec.node;
    n.appendChild(line('ph-status',PH_LIVE));
    rec.tx=document.createElement('div'); rec.tx.className='ph-transcript'; n.appendChild(rec.tx);
    rec.prompt=line('ph-prompt',PH_ANSWERED); n.appendChild(rec.prompt);
    var err=line('ph-err','');
    if(ctl.farend){
      var f=document.createElement('form'); f.className='ph-farend';
      var inp=document.createElement('input'); inp.type='text'; inp.maxLength=1000; inp.placeholder=PH_SAYS;
      inp.setAttribute('aria-label',PH_SAYS);
      var send=document.createElement('button'); send.type='submit'; send.textContent=PH_SEND;
      f.appendChild(inp); f.appendChild(send);
      f.onsubmit=function(ev){ ev.preventDefault(); var v=inp.value.trim(); if(!v) return; inp.value=''; phoneAct(c.id,'/farend',{text:v},sid,err); };
      n.appendChild(f);
    }
    if(ctl.stop){ var b=phoneButton(PH_STOP); b.onclick=function(){ phoneAct(c.id,'/stop',{},sid,err); }; n.appendChild(b); }
    n.appendChild(err);
    phoneLiveUpdate(rec,c);
    /* Frames are hints; polling is the source of truth for the transcript,
       matching the Phone panel (spec §4.4). */
    rec.timer=setInterval(function(){
      if(!live()||current.sid!==sid||phoneCards[c.id]!==rec||rec.view!=='live'){ phoneStopPoll(rec); return; }
      phoneRefetch(c.id,sid,'');
    },1500);
  }
  function phoneLiveUpdate(rec,c){
    if(!rec.tx) return;
    clearEl(rec.tx);
    (Array.isArray(c.transcript)?c.transcript:[]).forEach(function(e){ if(e&&typeof e==='object') rec.tx.appendChild(phoneLine(e)); });
    rec.tx.scrollTop=rec.tx.scrollHeight;
    if(rec.prompt) rec.prompt.hidden=!phoneNeedsPrompt(c.transcript);
  }
  function phoneRenderTerminal(rec,c){
    var n=rec.node;
    n.appendChild(line('ph-status',phoneStatusText(c.status)));
    if(c.outcome) n.appendChild(line('ph-outcome',PH_OUTCOME+': '+String(c.outcome)));
    if(c.summary) n.appendChild(line('ph-summary',String(c.summary)));
    var b=c.booking;
    if(b&&typeof b==='object'){
      var parts=[b.date,b.time,b.location].filter(function(x){ return x!=null&&x!==''; }).map(String);
      if(parts.length) n.appendChild(line('ph-booking',parts.join(' · ')));
    }
    var a=document.createElement('a'); a.className='ph-open'; a.href='/dashboard/phone?call='+encodeURIComponent(c.id); a.textContent=PH_OPEN;
    n.appendChild(a);
  }
  /* I7 read-only card for a viewer who cannot read the row (SSO/peer): status
     from the gateway frame, Stop while live, no transcript. */
  function phonePointer(id,status,sid){
    var rec=phoneShell(id); if(!rec) return;
    var key='ptr|'+status; if(rec.key===key) return;
    rec.key=key; rec.view='pointer'; phoneStopPoll(rec); clearEl(rec.node);
    rec.node.appendChild(line('ph-title',PH_TITLE));
    rec.node.appendChild(line('ph-status',phoneStatusText(status)));
    rec.node.appendChild(line('ph-note',PH_LOCAL_ONLY));
    if(phoneView(status)==='live'){
      var err=line('ph-err','');
      var b=phoneButton(PH_STOP); b.onclick=function(){ phoneAct(id,'/stop',{},sid,err); };
      rec.node.appendChild(b); rec.node.appendChild(err);
    }
  }
  function phoneAct(id,path,body,sid,errEl){
    if(errEl) errEl.textContent='';
    phoneApi('POST','/calls/'+encodeURIComponent(id)+path,body).then(function(r){
      if(!live()||current.sid!==sid) return;
      var rec=phoneCards[id];
      if(!r.ok){
        var code=r.j&&r.j.error;
        if(code==='plan_changed'||code==='not_pending'){
          /* I4: approved or edited elsewhere — refetch and show the fresh plan. */
          if(rec){ rec.key=''; rec.flash=code==='plan_changed'?PH_PLAN_CHANGED:''; }
          phoneRefetch(id,sid,'');
          return;
        }
        if(code==='totp_required'&&!(phoneWhoLast&&phoneWhoLast.totp_required)){
          /* S5: 2FA was turned on after this page asked — ask again and redraw with the field. */
          phoneWhoP=null;
          if(rec){ rec.key=''; rec.flash=PH_FAILED+' '+String((r.j&&r.j.message)||code); }
          phoneRefetch(id,sid,'');
          return;
        }
        if(errEl) errEl.textContent=PH_FAILED+' '+String((r.j&&(r.j.message||r.j.error))||r.status);
        return;
      }
      phoneRefetch(id,sid,'');
    });
  }
`;
}
