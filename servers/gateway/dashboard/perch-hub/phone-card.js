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
 *    card with Hang up while live, and no transcript.
 *
 * Layout (spec 2026-10-02 "phone card polish"): every shape opens with the same
 * head (business name + a status pill) and a meta line (number · language).
 * Pending: GOAL / LIMITS sections, a collapsible MAY SHARE, checkbox rows, one
 * full-width "Approve and call now", then "Schedule for later ▸" and Reject.
 * Live: a running clock in the pill, the transcript as chat bubbles, and the
 * composer (Business says… / Send / Hang up) as the card's last row.
 * Terminal: an outcome-coloured pill, the answer in large text, the transcript
 * collapsed behind "Show transcript".
 */
export function perchPhoneCardJs(lang = "en") {
  return `
  /* ---- Perch phone call card (spec 2026-10-01, polish 2026-10-02) ------- */
  var PH_TITLE='${tJs("perch.phoneTitle", lang)}';
  var PH_GOAL='${tJs("perch.phoneGoal", lang)}';
  var PH_LIMITS='${tJs("perch.phoneLimits", lang)}';
  var PH_NO_LIMITS='${tJs("perch.phoneNoLimits", lang)}';
  var PH_PROPOSED='${tJs("perch.phoneProposedTime", lang)}';
  var PH_SHARE_LABEL='${tJs("perch.phoneShareLabel", lang)}';
  var PH_SHARE='${tJs("perch.phoneShare", lang)}';
  var PH_BUSINESS='${tJs("perch.phoneBusiness", lang)}';
  var PH_CLOUD='${tJs("perch.phoneAllowCloud", lang)}';
  var PH_NO_CLOUD='${tJs("perch.phoneNoCloud", lang)}';
  var PH_TOTP='${tJs("perch.phoneTotp", lang)}';
  var PH_APPROVE='${tJs("perch.phoneApprove", lang)}';
  var PH_SCHEDULE='${tJs("perch.phoneSchedule", lang)}';
  var PH_WHEN='${tJs("perch.phoneWhen", lang)}';
  var PH_APPROVE_AT='${tJs("perch.phoneApproveAt", lang)}';
  var PH_REJECT='${tJs("perch.phoneReject", lang)}';
  var PH_APPROVED_AT='${tJs("perch.phoneApprovedAt", lang)}';
  var PH_SCHEDULED='${tJs("perch.phoneScheduled", lang)}';
  var PH_STARTING='${tJs("perch.phoneStarting", lang)}';
  var PH_LIVE='${tJs("perch.phoneLive", lang)}';
  var PH_WRAPPING='${tJs("perch.phoneWrappingUp", lang)}';
  var PH_SAYS='${tJs("perch.phoneSays", lang)}';
  var PH_SEND='${tJs("perch.phoneSend", lang)}';
  var PH_STOP='${tJs("perch.phoneStop", lang)}';
  var PH_ANSWERED='${tJs("perch.phoneAnsweredPrompt", lang)}';
  var PH_SHOW_TX='${tJs("perch.phoneShowTranscript", lang)}';
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
  var PH_WHO_DIGITS='${tJs("perch.phoneWhoDigits", lang)}';
  /* Line states the runner reports, as the small centred notes in the transcript. */
  var PH_STATES={dialing:'${tJs("perch.phoneStateDialing", lang)}',answered:'${tJs("perch.phoneStateAnswered", lang)}',
    on_hold:'${tJs("perch.phoneStateOnHold", lang)}',ended:'${tJs("perch.phoneStateEnded", lang)}'};
  /* Every outcome (bundles/phone/server/plan.js OUTCOMES) -> [pill tone, label].
     ok = the goal was met; warn = try again / follow up; neutral = ended by a
     person; err = it could not work. */
  var PH_OUTCOMES={
    booked:['ok','${tJs("perch.phoneOutcomeBooked", lang)}'],
    info_gathered:['ok','${tJs("perch.phoneOutcomeInfoGathered", lang)}'],
    needs_callback:['warn','${tJs("perch.phoneOutcomeNeedsCallback", lang)}'],
    no_answer:['warn','${tJs("perch.phoneOutcomeNoAnswer", lang)}'],
    voicemail:['warn','${tJs("perch.phoneOutcomeVoicemail", lang)}'],
    busy:['warn','${tJs("perch.phoneOutcomeBusy", lang)}'],
    refused:['warn','${tJs("perch.phoneOutcomeRefused", lang)}'],
    phone_busy:['warn','${tJs("perch.phoneOutcomePhoneBusy", lang)}'],
    stopped:['neutral','${tJs("perch.phoneOutcomeStopped", lang)}'],
    taken_over:['neutral','${tJs("perch.phoneOutcomeTakenOver", lang)}'],
    line_lost:['neutral','${tJs("perch.phoneOutcomeLineLost", lang)}'],
    failed:['err','${tJs("perch.phoneOutcomeFailed", lang)}'],
    not_in_service:['err','${tJs("perch.phoneOutcomeNotInService", lang)}'],
    phone_unreachable:['err','${tJs("perch.phoneOutcomePhoneUnreachable", lang)}'],
    not_admissible:['err','${tJs("perch.phoneOutcomeNotAdmissible", lang)}']
  };

  /* call_id -> {node,view,key,hash,timer,clock,tx,prompt,pill,started,ended,totp,flash}
     for THIS transcript. Dies with the transcript at the same three seams as fileSeen. */
  var phoneCards={};
  /* phone_call frames that arrived before the history batch settled; replayed
     by loadPhoneCards so a card never lands above the transcript it belongs under. */
  var phoneBuf=[];
  /* whoami: cached only when the server really answered (S5). */
  var phoneWhoP=null, phoneWhoLast=null;
  /* S13: whoami 404'd — no phone bundle here; stop asking for this document. */
  var phoneNoBundle=false;

  function resetPhoneCards(){
    for(var k in phoneCards){ phoneStopPoll(phoneCards[k]); }
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
  /* I7: owner controls only for a local password session; Hang up for anyone. */
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
  /* The runner hung up and is writing the wrap-up (spec 2026-10-02): the last
     line state is 'ended' while the row is still live. */
  function phoneEnded(transcript){
    var t=Array.isArray(transcript)?transcript:[];
    for(var i=t.length-1;i>=0;i--){ var e=t[i]||{}; if(e.type==='state') return e.state==='ended'; }
    return false;
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
  /* US/Canada numbers as (512) 555-0101; anything else stays E.164. */
  function phoneNumberText(n){
    var s=String(n||''), m=/^[+]1([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(s);
    return m?'('+m[1]+') '+m[2]+'-'+m[3]:s;
  }
  /* started_at is SQLite datetime('now'): UTC with a space and no zone. */
  function phoneUtcMs(t){
    var s=String(t||'');
    if(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}(:[0-9]{2})?$/.test(s)) s=s.replace(' ','T')+'Z';
    return s?new Date(s).getTime():NaN;
  }
  function phoneClock(ms){
    var t=Math.max(0,Math.floor((ms||0)/1000)), m=Math.floor(t/60), sec=t%60;
    return m+':'+(sec<10?'0':'')+sec;
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
  /* [tone, label] for a finished row: the outcome when there is one, else the status. */
  function phoneTerminalPill(c){
    if(c.status==='done'&&c.outcome) return PH_OUTCOMES[c.outcome]||['neutral',String(c.outcome)];
    return ['neutral',phoneStatusText(c.status)];
  }
  function phoneKey(c){ return [c.status,c.plan_hash,c.event_seq,c.outcome||''].join('|'); }
  function phoneButton(text,cls){ var b=document.createElement('button'); b.type='button'; b.textContent=text; if(cls) b.className=cls; return b; }
  /* A checkbox row: box left, label right, the whole row is the hit target. */
  function phoneCheck(parent,text,sub){
    var lab=document.createElement('label'); lab.className='ph-check';
    var cb=document.createElement('input'); cb.type='checkbox'; lab.appendChild(cb);
    var tx=document.createElement('span'); tx.className='ph-check-text'; tx.appendChild(line('ph-check-main',text));
    if(sub) tx.appendChild(line('ph-check-sub',sub));
    lab.appendChild(tx); parent.appendChild(lab); return cb;
  }
  /* A small-caps label over a value. */
  function phoneSection(parent,label,cls,text){
    var s=document.createElement('div'); s.className='ph-sec';
    s.appendChild(line('ph-label',label)); s.appendChild(line(cls,text));
    parent.appendChild(s); return s;
  }
  /* The head every shape shares: business name, then the status pill. Returns
     the node whose text the pill shows (a live pill also carries a pulsing dot). */
  function phoneHead(n,title,tone,text){
    var h=document.createElement('div'); h.className='ph-head';
    h.appendChild(line('ph-title',title));
    var p=document.createElement('span'); p.className='ph-pill ph-pill-'+tone;
    var dot=document.createElement('span'); dot.className='ph-dot'; dot.setAttribute('aria-hidden','true');
    if(tone==='live') p.appendChild(dot);
    var t=document.createElement('span'); t.className='ph-pill-text'; t.textContent=text; p.appendChild(t);
    h.appendChild(p); n.appendChild(h); return t;
  }
  /* One transcript entry: the assistant's and the business's lines are bubbles
     (who is said to screen readers only); line states and keys are small notes. */
  function phoneLine(e){
    var t=(e.type==='agent'||e.type==='farend'||e.type==='dtmf')?e.type:'state';
    if(t==='agent'||t==='farend'){
      var b=document.createElement('div'); b.className='ph-t ph-t-'+t;
      var who=document.createElement('span'); who.className='ph-sr'; who.textContent=(t==='agent'?PH_WHO_AGENT:PH_WHO_BUSINESS)+': ';
      b.appendChild(who); b.appendChild(document.createTextNode(String(e.text||''))); return b;
    }
    var note=t==='dtmf'?PH_WHO_DIGITS+': '+String(e.digits||''):(PH_STATES[e.state]||String(e.state||''));
    return line('ph-t ph-t-'+t,'— '+note+' —');
  }
  function phoneFillTx(box,transcript){
    clearEl(box);
    (Array.isArray(transcript)?transcript:[]).forEach(function(e){ if(e&&typeof e==='object') box.appendChild(phoneLine(e)); });
    box.scrollTop=box.scrollHeight;
  }
  function phoneShell(id){
    var tr=el('perch-transcript'); if(!tr) return null;
    var rec=phoneCards[id];
    if(!rec){
      rec=phoneCards[id]={node:document.createElement('div'),view:'',key:'',hash:'',timer:null,clock:null,tx:null,prompt:null,pill:null,comp:null,started:NaN,ended:false,totp:null,flash:''};
      rec.node.className='entry phonecard';
      tr.appendChild(rec.node); tr.scrollTop=tr.scrollHeight;
    }
    return rec;
  }
  function phoneStopPoll(rec){
    if(!rec) return;
    if(rec.timer){ clearInterval(rec.timer); rec.timer=null; }
    if(rec.clock){ clearInterval(rec.clock); rec.clock=null; }
  }

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
         own frame (never child bytes), with Hang up while live (I7). */
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
      rec.key=key; rec.view=view; rec.hash=c.plan_hash||''; phoneStopPoll(rec); rec.tx=null; rec.prompt=null; rec.pill=null; rec.comp=null; rec.totp=null;
      clearEl(rec.node);
      var pill=view==='pending'?['wait',PH_ST_PENDING]:view==='queued'?['neutral',PH_STARTING]:view==='live'?['live',PH_LIVE]:phoneTerminalPill(c);
      if(view==='queued'&&phoneQueuedAt(c)) pill[1]=PH_SCHEDULED;
      rec.pill=phoneHead(rec.node,String(c.business_name||'')||PH_TITLE,pill[0],pill[1]);
      rec.node.appendChild(line('ph-meta',phoneNumberText(c.number_e164)+' · '+(c.language==='es'?'Español':'English')));
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
    phoneSection(n,PH_GOAL,'ph-goal',String(c.goal||''));
    phoneSection(n,PH_LIMITS,'ph-limits',phoneLimits(c.limits));
    var proposed=c.run_after?new Date(c.run_after):null;
    if(proposed&&!isNaN(proposed.getTime())) n.appendChild(line('ph-proposed',PH_PROPOSED+': '+proposed.toLocaleString()));
    var sh=(c.shareable&&typeof c.shareable==='object')?c.shareable:{}, keys=Object.keys(sh);
    if(!ctl.approve){
      if(keys.length) phoneSection(n,PH_SHARE_LABEL,'ph-share',keys.join(', '));
      n.appendChild(line('ph-note',PH_LOCAL_ONLY));
      return;
    }
    var form=document.createElement('form'); form.className='ph-form';
    form.onsubmit=function(ev){ ev.preventDefault(); };
    /* MAY SHARE: open when there is something to share (and to edit), else collapsed. */
    var tas={};
    var box=document.createElement('details'); box.className='ph-sec ph-more ph-sharebox'; box.open=keys.length>0;
    var sum=document.createElement('summary'); sum.className='ph-label'; sum.textContent=PH_SHARE_LABEL; box.appendChild(sum);
    if(keys.length){
      box.appendChild(line('ph-hint',PH_SHARE));
      keys.forEach(function(k){
        var lab=document.createElement('label'); lab.className='ph-field';
        lab.appendChild(line('ph-fname',k));
        var ta=document.createElement('textarea'); ta.rows=1; ta.maxLength=200; ta.value=String(sh[k]==null?'':sh[k]);
        lab.appendChild(ta); box.appendChild(lab); tas[k]=ta;
      });
    } else box.appendChild(line('ph-hint',PH_NO_LIMITS));
    form.appendChild(box);
    var biz=phoneCheck(form,PH_BUSINESS,'');
    var cloud=phoneCheck(form,PH_CLOUD,who.cloud_model||PH_NO_CLOUD);
    if(!who.cloud_model) cloud.disabled=true;
    var totp=null;
    if(who.totp_required){
      var tl=document.createElement('label'); tl.className='ph-field';
      tl.appendChild(line('ph-label',PH_TOTP));
      totp=document.createElement('input'); totp.type='text'; totp.inputMode='numeric'; totp.maxLength=6; totp.autocomplete='one-time-code';
      if(keepTotp) totp.value=keepTotp;
      tl.appendChild(totp); form.appendChild(tl);
      rec.totp=totp;
    }
    var err=line('ph-err','');
    var bNow=phoneButton(PH_APPROVE,'primary ph-primary');
    var row=document.createElement('div'); row.className='ph-secondary';
    var bSched=phoneButton(PH_SCHEDULE+' ▸','ph-link'); bSched.setAttribute('aria-expanded','false');
    var bRej=phoneButton(PH_REJECT,'ph-link ph-reject');
    row.appendChild(bSched); row.appendChild(bRej);
    /* Schedule for later: hidden until asked for; prefilled with the bot's proposal. */
    var sched=document.createElement('div'); sched.className='ph-sched'; sched.hidden=true;
    var when=document.createElement('input'); when.type='datetime-local';
    when.setAttribute('aria-label',PH_WHEN);
    when.value=phoneLocalInput(c.run_after);
    var bAt=phoneButton(PH_APPROVE_AT,'ph-at');
    sched.appendChild(when); sched.appendChild(bAt);
    form.appendChild(bNow); form.appendChild(row); form.appendChild(sched); form.appendChild(err);
    function approve(runAfter){
      /* "Approve and call now" sends run_after null: now, even if the bot proposed a time. */
      var body={plan_hash:c.plan_hash,business_confirmed:biz.checked,allow_cloud:cloud.checked,run_after:runAfter||null};
      if(totp) body.totp=totp.value;
      if(keys.length){ var ed={}; keys.forEach(function(k){ ed[k]=tas[k].value; }); body.edits={shareable:ed}; }
      phoneAct(c.id,'/approve',body,sid,err);
    }
    bNow.onclick=function(){ approve(null); };
    bSched.onclick=function(){
      sched.hidden=!sched.hidden;
      bSched.textContent=PH_SCHEDULE+(sched.hidden?' ▸':' ▾');
      bSched.setAttribute('aria-expanded',sched.hidden?'false':'true');
    };
    bAt.onclick=function(){ if(!when.value){ if(when.focus) when.focus(); return; } approve(new Date(when.value).toISOString()); };
    bRej.onclick=function(){ phoneAct(c.id,'/reject',{},sid,err); };
    n.appendChild(form);
  }
  /* An approved call whose time is still ahead: that time, else null. */
  function phoneQueuedAt(c){
    var ra=(c.status==='approved'&&c.run_after)?new Date(c.run_after):null;
    return (!!ra&&!isNaN(ra.getTime())&&ra.getTime()>Date.now())?ra:null;
  }
  function phoneRenderQueued(rec,c){
    var ra=phoneQueuedAt(c);
    rec.node.appendChild(line('ph-status',ra?PH_APPROVED_AT.split('{time}').join(ra.toLocaleString()):PH_STARTING));
  }
  function phoneRenderLive(rec,c,sid,ctl){
    var n=rec.node;
    rec.started=phoneUtcMs(c.started_at);
    rec.tx=document.createElement('div'); rec.tx.className='ph-transcript'; n.appendChild(rec.tx);
    rec.prompt=line('ph-prompt',PH_ANSWERED); n.appendChild(rec.prompt);
    var err=line('ph-err','');
    /* The composer is the card's last row: Business says… / Send / Hang up. */
    var comp=document.createElement(ctl.farend?'form':'div'); comp.className='ph-composer';
    if(ctl.farend){
      var inp=document.createElement('input'); inp.type='text'; inp.maxLength=1000; inp.placeholder=PH_SAYS;
      inp.setAttribute('aria-label',PH_SAYS);
      var send=document.createElement('button'); send.type='submit'; send.textContent=PH_SEND;
      comp.appendChild(inp); comp.appendChild(send);
      comp.onsubmit=function(ev){ ev.preventDefault(); var v=inp.value.trim(); if(!v) return; inp.value=''; phoneAct(c.id,'/farend',{text:v},sid,err); };
    }
    if(ctl.stop){ var b=phoneButton(PH_STOP,'ph-hangup'); b.onclick=function(){ phoneAct(c.id,'/stop',{},sid,err); }; comp.appendChild(b); }
    n.appendChild(comp); rec.comp=comp;
    n.appendChild(err);
    phoneLiveUpdate(rec,c);
    /* Frames are hints; polling is the source of truth for the transcript,
       matching the Phone panel (spec §4.4). */
    rec.timer=setInterval(function(){
      if(!live()||current.sid!==sid||phoneCards[c.id]!==rec||rec.view!=='live'){ phoneStopPoll(rec); return; }
      phoneRefetch(c.id,sid,'');
    },1500);
    /* The pill's running clock. Only ever touches this card's own nodes. */
    rec.clock=setInterval(function(){
      if(phoneCards[c.id]!==rec||rec.view!=='live'){ phoneStopPoll(rec); return; }
      phoneTick(rec);
    },1000);
  }
  function phoneTick(rec){
    if(!rec.pill) return;
    if(rec.ended) rec.pill.textContent=PH_WRAPPING;
    else rec.pill.textContent=isNaN(rec.started)?PH_LIVE:PH_LIVE+' '+phoneClock(Date.now()-rec.started);
  }
  function phoneLiveUpdate(rec,c){
    if(!rec.tx) return;
    phoneFillTx(rec.tx,c.transcript);
    rec.ended=phoneEnded(c.transcript);
    if(rec.ended) phoneWrapping(rec);
    phoneTick(rec);
    if(rec.prompt) rec.prompt.hidden=!phoneNeedsPrompt(c.transcript);
  }
  /* The line is down and the runner is writing its summary: the pill stops
     pulsing and turns neutral, and the composer goes away (a typed line would
     reach nobody). */
  function phoneWrapping(rec){
    var box=rec.pill&&rec.pill.parentNode;
    if(box){
      box.className='ph-pill ph-pill-neutral';
      for(var i=0;i<box.children.length;i++){ if(box.children[i].className==='ph-dot') box.children[i].hidden=true; }
    }
    if(rec.comp){
      rec.comp.hidden=true;
      for(var j=0;j<rec.comp.children.length;j++) rec.comp.children[j].disabled=true;
    }
  }
  function phoneRenderTerminal(rec,c){
    var n=rec.node;
    /* The answer first, large: what the call found out. */
    if(c.summary) n.appendChild(line('ph-answer',String(c.summary)));
    var b=c.booking;
    if(b&&typeof b==='object'){
      var parts=[b.date,b.time,b.location].filter(function(x){ return x!=null&&x!==''; }).map(String);
      if(parts.length) n.appendChild(line('ph-booking',parts.join(' · ')));
    }
    if(c.error&&phoneTerminalPill(c)[0]==='err') n.appendChild(line('ph-note',String(c.error)));
    var t=Array.isArray(c.transcript)?c.transcript:[];
    if(t.length){
      var box=document.createElement('details'); box.className='ph-more ph-txbox';
      var sum=document.createElement('summary'); sum.className='ph-toggle'; sum.textContent=PH_SHOW_TX; box.appendChild(sum);
      var tx=document.createElement('div'); tx.className='ph-transcript'; box.appendChild(tx);
      phoneFillTx(tx,t);
      n.appendChild(box);
    }
    var a=document.createElement('a'); a.className='ph-open'; a.href='/dashboard/phone?call='+encodeURIComponent(c.id); a.textContent=PH_OPEN;
    n.appendChild(a);
  }
  /* I7 read-only card for a viewer who cannot read the row (SSO/peer): status
     from the gateway frame, Hang up while live, no transcript. */
  function phonePointer(id,status,sid){
    var rec=phoneShell(id); if(!rec) return;
    var key='ptr|'+status; if(rec.key===key) return;
    rec.key=key; rec.view='pointer'; phoneStopPoll(rec); clearEl(rec.node);
    var v=phoneView(status);
    rec.pill=phoneHead(rec.node,PH_TITLE,v==='pending'?'wait':v==='live'?'live':'neutral',phoneStatusText(status));
    rec.node.appendChild(line('ph-note',PH_LOCAL_ONLY));
    if(v==='live'){
      var err=line('ph-err','');
      var comp=document.createElement('div'); comp.className='ph-composer';
      var b=phoneButton(PH_STOP,'ph-hangup'); b.onclick=function(){ phoneAct(id,'/stop',{},sid,err); };
      comp.appendChild(b); rec.node.appendChild(comp); rec.node.appendChild(err);
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
