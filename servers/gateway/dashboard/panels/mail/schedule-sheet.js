import { tJs } from "../../shared/i18n.js";

/**
 * Crow Mail's schedule sheet (Crow Mail plan 3, Task 10b).
 *
 * Spliced INSIDE perchHubJs() (client.js) right after the draft card, so it shares that scope: the
 * card's owner-route call (`mdraftApi`), its refusal mapping (`mdraftRefusal`), its button and node
 * helpers and the `mdraftNodes` map it mounts its cards in. The card owns the two buttons this sheet
 * answers — Schedule on an editable draft and Change time on a scheduled one — and hands it the draft
 * it was drawn from plus the refetch to run once a schedule is taken.
 *
 * No time is computed here. The two shortcuts and the instant each one stands for come from
 * `GET /dashboard/mail/api/drafts/schedule-presets`, which reads them in the instance zone and from
 * the owner's working hours; a picked date and time is handed back to the same route as a bare wall
 * time (`?at=2026-11-12T07:30`) and returned as the zone-qualified ISO text the tap posts. So this
 * file holds no date arithmetic at all — no `new Date`, no `getTime`, no `setHours` — and the offsets
 * a schedule is stored with are always the server's.
 *
 * The tap itself is one POST of `{hash, dueAt}` with the hash the card was drawn from, exactly as Send
 * is, and it is a person's own press. The server refuses a stale hash, a time already past and one
 * past ninety days; the sheet says which, in a fixed sentence of its own. The line under the choices
 * is the plan's: a scheduled send is held by this Crow, so the computer has to be on.
 *
 * Emitted inside a template literal: no backtick and no dollar-brace in the client code, and every
 * string through tJs.
 */
export function perchMailScheduleSheetJs(lang = "en") {
  return `
  /* ---- the schedule sheet (plan 3, task 10b) --------------------------- */
  var MSCHED_TOMORROW='${tJs("mail.scheduleTomorrowMorning", lang)}';
  var MSCHED_WORKDAY='${tJs("mail.scheduleNextWorkDay", lang)}';
  var MSCHED_PICK='${tJs("mail.schedulePick", lang)}';
  var MSCHED_PICK_MISSING='${tJs("mail.schedulePickMissing", lang)}';
  var MSCHED_DATE='${tJs("mail.scheduleDateLabel", lang)}';
  var MSCHED_TIME='${tJs("mail.scheduleTimeLabel", lang)}';
  var MSCHED_BOX_ON='${tJs("mail.scheduleBoxOn", lang)}';
  var MSCHED_TOO_FAR='${tJs("mail.scheduleTooFar", lang)}';
  var MSCHED_AT='/drafts/schedule-presets?at=';
  var MSCHED_PRESETS='/drafts/schedule-presets';
  /* The sheet on screen, so a second press (or a card that redrew under it) never stacks two. */
  var mschedNode=null;

  function mschedClose(){ if(mschedNode) mdraftRemove(mschedNode); mschedNode=null; }
  /* Every button under a node is disabled while the tap is in flight: the sheet's own, and the card's
     Cancel, which lives one level up. */
  function mschedBusy(node,on){
    if(!node||!node.children) return;
    for(var i=0;i<node.children.length;i++){
      var child=node.children[i];
      if(child.tagName==='BUTTON') child.disabled=on; else mschedBusy(child,on);
    }
  }
  /* A shortcut's caption: the sheet's own name for it, and the time the server sent for it. A preset
     the answer does not carry keeps the name alone. */
  function mschedCaption(name,preset){
    var label=mdraftText(preset&&preset.label);
    return label?name+MDRAFT_DOT+label:name;
  }
  /* A refusal's line. Both windows the schedule tap can refuse (the minute's lead and the ninety-day
     horizon) have their own approved sentences; every other answer reads as the card's refusals do. */
  function mschedRefusal(r){
    var j=(r&&r.j)||null;
    if(j&&j.reason==='too_far') return MSCHED_TOO_FAR;
    return mdraftRefusal(r);
  }
  /* One labelled input, the card's own field shape. */
  function mschedField(label,input){
    var wrap=document.createElement('label'); wrap.className='mdraft-field msched-field';
    wrap.appendChild(line('mdraft-label',label));
    wrap.appendChild(input);
    return wrap;
  }
  function mschedInput(type,cls){
    var input=document.createElement('input');
    input.type=type; input.className=cls;
    return input;
  }
  /* The three ways to schedule: two shortcuts and a picked date and time. Each one ends in the same
     tap; only the instant differs, and every instant comes from the server. */
  function mschedOptions(host,presets,scheduleWith,status,sheet){
    var shortcuts=document.createElement('div'); shortcuts.className='mdraft-actions msched-shortcuts';
    var tomorrow=presets?presets.tomorrowMorning:null;
    var workday=presets?presets.nextWorkDay:null;
    mdraftBtn(shortcuts,'msched-tomorrow',mschedCaption(MSCHED_TOMORROW,tomorrow),function(){
      scheduleWith(mdraftText(tomorrow&&tomorrow.iso));
    });
    mdraftBtn(shortcuts,'msched-workday',mschedCaption(MSCHED_WORKDAY,workday),function(){
      scheduleWith(mdraftText(workday&&workday.iso));
    });
    host.appendChild(shortcuts);

    var pick=document.createElement('div'); pick.className='mdraft-actions msched-pick';
    var day=mschedInput('date','msched-date');
    var clock=mschedInput('time','msched-time');
    pick.appendChild(mschedField(MSCHED_DATE,day));
    pick.appendChild(mschedField(MSCHED_TIME,clock));
    mdraftBtn(pick,'msched-pick-go',MSCHED_PICK,function(){
      var dayValue=mdraftText(day.value), clockValue=mdraftText(clock.value);
      if(!dayValue||!clockValue){ status.textContent=MSCHED_PICK_MISSING; return; }
      mschedBusy(pick,true);
      /* The wall time the person picked, as the bare text the server resolves in the instance zone:
         this file never turns a date and a time into an instant, so it never needs an offset. */
      mdraftApi('GET',MSCHED_AT+encodeURIComponent(dayValue+'T'+clockValue)).then(function(r){
        if(!live()||mschedNode!==sheet) return;
        if(!r||!r.ok||!r.j||typeof r.j.iso!=='string'){
          mschedBusy(pick,false);
          status.textContent=mschedRefusal(r);
          return;
        }
        /* The tap disables every control, so the pick's own buttons stay as they are. */
        scheduleWith(r.j.iso);
      });
    });
    host.appendChild(pick);
  }

  /* The sheet: read the two shortcuts from the server, then draw them. Nothing is drawn from a time
     this file made up, so a box whose working hours or zone just changed shows the new ones. */
  function mschedOpen(draft,onDone){
    var id=mdraftText(draft&&draft.id);
    if(!MDRAFT_ID.test(id)) return;
    mschedClose();
    /* It sits inside the card it belongs to; a card that is not on screen (a redraw between the press
       and the answer) puts it at the end of the transcript rather than nowhere. */
    var host=mdraftNodes[id]||el('perch-transcript');
    if(!host) return;

    var sheet=document.createElement('div');
    sheet.className='msched-sheet';
    sheet.setAttribute('role','dialog');
    sheet.setAttribute('aria-label',MSCHED_PICK);
    var options=document.createElement('div'); options.className='msched-options';
    var status=line('mdraft-status msched-status',''); status.setAttribute('role','status');
    var foot=document.createElement('div'); foot.className='mdraft-actions msched-actions';
    mdraftBtn(foot,'msched-cancel',MDRAFT_CANCEL,function(){ mschedClose(); });
    sheet.appendChild(options);
    sheet.appendChild(line('msched-box',MSCHED_BOX_ON));
    sheet.appendChild(status);
    sheet.appendChild(foot);
    host.appendChild(sheet);
    mschedNode=sheet;

    /* The tap: one POST carrying the hash the card was drawn from and the instant the server gave. */
    function scheduleWith(iso){
      if(typeof iso!=='string'||iso===''){ status.textContent=MDRAFT_ERROR; return; }
      mschedBusy(options,true); mschedBusy(foot,true);
      mdraftApi('POST','/drafts/'+encodeURIComponent(id)+'/schedule',
        {hash:mdraftText(draft.headHash),dueAt:iso}).then(function(r){
        if(!live()||mschedNode!==sheet) return;
        if(r&&r.ok){ mschedClose(); if(typeof onDone==='function') onDone(); return; }
        mschedBusy(options,false); mschedBusy(foot,false);
        status.textContent=mschedRefusal(r);
      });
    }

    mdraftApi('GET',MSCHED_PRESETS).then(function(r){
      if(!live()||mschedNode!==sheet) return;
      if(!r||!r.ok||!r.j){ status.textContent=mschedRefusal(r); return; }
      mschedOptions(options,r.j,scheduleWith,status,sheet);
    });
  }

  /* What the card calls, from both its Schedule button and its Change time button. The due time a
     scheduled draft already carries is not needed: the person is choosing a new one. */
  mailDraftSheet=function(draft,dueAt,onDone){ mschedOpen(draft,onDone); };
`;
}