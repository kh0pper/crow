import { tJs } from "../shared/i18n.js";

/**
 * The mail draft card in a Perch chat (Crow Mail, plan 3, Task 10a).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), the staged-card.js pattern, so it shares that
 * scope's el / line / clearEl / live / current / csrf / perchApi. It renders in two places, through
 * the same builder:
 *  - the drafts whose `chat_thread_id` is this chat's own id, from GET
 *    /interactive/:sid/mail-drafts (the ids only), each read from the owner's draft route;
 *  - a draft named in the page's query (`?maildraft=md-…`), for a draft made in the reader, where
 *    there is no chat to list it. The id is checked against the store's own shape before a single
 *    request is made.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the client code; only the
 *    tJs interpolations below.
 *  - The card is built from the fetched draft ONLY, and every address, subject, body line, address
 *    name and comment reaches the page through textContent on a createElement node: a subject that
 *    looks like markup is text.
 *  - Every tap carries `draft.headHash` — the hash of the revision the person is looking at. The
 *    server's guarded update is the compare-and-set that refuses a draft that changed under their
 *    eyes (409 `changed`), and this client then re-reads and says why.
 *  - Nothing here can send by itself: Send and Schedule are two POSTs a finger makes, and a draft in
 *    any state that is not editable renders no Send at all.
 *  - The schedule sheet is the module spliced beside this one (panels/mail/schedule-sheet.js,
 *    Task 10b): both the Schedule button and Change time call `mailDraftSheet(draft, dueAtMs, onDone)`
 *    when that module has assigned it, and say so when it has not.
 */
export function perchMailDraftCardJs(lang = "en") {
  return `
  /* ---- the mail draft card (plan 3, task 10a) --------------------------- */
  var MDRAFT_LANG='${String(lang).replace(/[^a-z-]/g, "")}';
  var MDRAFT_HEAD='${tJs("mail.draftHead", lang)}';
  var MDRAFT_TO='${tJs("mail.draftTo", lang)}';
  var MDRAFT_CC='${tJs("mail.draftCc", lang)}';
  var MDRAFT_BCC='${tJs("mail.draftBcc", lang)}';
  var MDRAFT_SUBJECT='${tJs("mail.draftSubject", lang)}';
  var MDRAFT_NOSUBJECT='${tJs("mail.draftNoSubject", lang)}';
  var MDRAFT_FROM='${tJs("mail.draftFromLine", lang)}';
  var MDRAFT_FOLLOWS='${tJs("mail.draftFollowsRules", lang)}';
  var MDRAFT_NOTCHECKED='${tJs("mail.draftNotChecked", lang)}';
  var MDRAFT_SEND='${tJs("mail.draftSend", lang)}';
  var MDRAFT_SCHEDULE='${tJs("mail.draftSchedule", lang)}';
  var MDRAFT_MORE='${tJs("mail.draftMore", lang)}';
  var MDRAFT_EDIT='${tJs("mail.draftEdit", lang)}';
  var MDRAFT_SAVE='${tJs("mail.draftSaveDraft", lang)}';
  var MDRAFT_DISCARD='${tJs("mail.draftDiscard", lang)}';
  var MDRAFT_HISTORY='${tJs("mail.draftHistory", lang)}';
  var MDRAFT_HISTORY_ROW='${tJs("mail.draftHistoryRow", lang)}';
  var MDRAFT_NEW='${tJs("mail.draftNewRecipient", lang)}';
  var MDRAFT_CHANGED='${tJs("mail.draftChanged", lang)}';
  var MDRAFT_REPLYTO='${tJs("mail.draftReplyToDiffers", lang)}';
  var MDRAFT_NOTE='${tJs("mail.draftNote", lang)}';
  var MDRAFT_REVISING='${tJs("mail.draftRevising", lang)}';
  var MDRAFT_SENDING='${tJs("mail.draftSending", lang)}';
  var MDRAFT_UNDO='${tJs("mail.draftUndo", lang)}';
  var MDRAFT_SCHEDULED='${tJs("mail.draftScheduled", lang)}';
  var MDRAFT_CHANGE_TIME='${tJs("mail.draftChangeTime", lang)}';
  var MDRAFT_CANCEL_SEND='${tJs("mail.draftCancelSend", lang)}';
  var MDRAFT_MISSED='${tJs("mail.draftMissed", lang)}';
  var MDRAFT_CHANGED_SENTENCE='${tJs("mail.draftChangedSentence", lang)}';
  var MDRAFT_UNKNOWN='${tJs("mail.draftUnknown", lang)}';
  var MDRAFT_SENT='${tJs("mail.draftSent", lang)}';
  var MDRAFT_SYNCING='${tJs("mail.draftSyncing", lang)}';
  var MDRAFT_SIZE='${tJs("mail.draftSize", lang)}';
  var MDRAFT_FAILED='${tJs("mail.draftFailed", lang)}';
  var MDRAFT_DISCARDED='${tJs("mail.draftDiscarded", lang)}';
  var MDRAFT_CONFIRM_SEND='${tJs("mail.draftConfirmSend", lang)}';
  var MDRAFT_EDIT_CANCELS='${tJs("mail.draftEditCancelsSchedule", lang)}';
  var MDRAFT_WRITING_RULES='${tJs("mail.draftWritingRules", lang)}';
  var MDRAFT_AUDIENCE='${tJs("mail.draftAudience", lang)}';
  var MDRAFT_AUD_COLLEAGUE='${tJs("mail.draftAudienceColleague", lang)}';
  var MDRAFT_AUD_CLIENT='${tJs("mail.draftAudienceClient", lang)}';
  var MDRAFT_AUD_PERSONAL='${tJs("mail.draftAudiencePersonal", lang)}';
  var MDRAFT_COMMENT='${tJs("mail.draftComment", lang)}';
  var MDRAFT_REVISE='${tJs("mail.draftRevise", lang)}';
  var MDRAFT_NOTE_SEND='${tJs("mail.draftNoteSend", lang)}';
  var MDRAFT_CANCEL='${tJs("mail.draftCancel", lang)}';
  var MDRAFT_OFFLINE='${tJs("mail.draftOffline", lang)}';
  var MDRAFT_ERROR='${tJs("mail.draftError", lang)}';
  var MDRAFT_NOTOWNER='${tJs("mail.draftNotOwner", lang)}';
  var MDRAFT_FROZEN='${tJs("mail.draftFrozen", lang)}';
  var MDRAFT_CLOUD_OFF='${tJs("mail.draftCloudOff", lang)}';
  var MDRAFT_LOCAL_ONLY='${tJs("mail.draftLocalOnly", lang)}';
  var MDRAFT_TURN_OFF='${tJs("mail.draftTurnOff", lang)}';
  var MDRAFT_NOT_SCHEDULED='${tJs("mail.draftNotScheduled", lang)}';
  var MDRAFT_NOT_DISCARDABLE='${tJs("mail.draftNotDiscardable", lang)}';
  var MDRAFT_NEEDS_CANCEL='${tJs("mail.draftNeedsCancel", lang)}';
  var MDRAFT_SHEET_MISSING='${tJs("mail.draftScheduleUnavailable", lang)}';
  var MDRAFT_SAVED='${tJs("mail.draftSavedDraft", lang)}';
  var MDRAFT_NL=String.fromCharCode(10);
  var MDRAFT_DOT=' \\u00b7 ';
  /* A draft id, and nothing else, may reach a URL. */
  var MDRAFT_ID=/^md-[0-9a-f]{16}$/;
  var MDRAFT_QUERY=/(?:^|[?&])maildraft=([^&]*)/;
  /* The writing-rules editor the card links to: the Skills panel's own writing-rules page, which is
     where the writing_style context section the draft follows is edited. */
  var MDRAFT_RULES_HREF='/dashboard/skills?edit=writing-rules';
  var MDRAFT_API='/dashboard/mail/api';
  /* The store's own audience list (drafts/store.js DRAFT_AUDIENCES), with the chip's label. */
  var MDRAFT_AUDIENCES=['colleague','client','personal'];
  var MDRAFT_AUDIENCE_LABELS=[MDRAFT_AUD_COLLEAGUE,MDRAFT_AUD_CLIENT,MDRAFT_AUD_PERSONAL];
  /* The editable states, as the store's addRevision and the audience route define them. */
  var MDRAFT_EDITABLE={'draft':true,'failed':true,'missed':true};

  /* The draft hulls drawn so far: id -> the node, the answer key it was drawn from, and whether it
     was mounted at the top of the panel (the query card) rather than appended to the chat. */
  var mdraftNodes={};
  var mdraftKeys={};
  var mdraftQueryId=null;
  /* The schedule sheet, assigned by the module spliced beside this one (Task 10b):
     mailDraftSheet(draft, dueAt, onDone). Both schedule controls open it; a build that drops that
     module from the splice says so instead of doing nothing. */
  var mailDraftSheet=null;

  function mdraftFill(s,vals){
    var out=String(s);
    var keys=Object.keys(vals||{});
    for(var i=0;i<keys.length;i++) out=out.split('{'+keys[i]+'}').join(String(vals[keys[i]]));
    return out;
  }
  function mdraftText(v){ return v==null?'':String(v); }
  function mdraftList(v){ return Array.isArray(v)?v:[]; }
  function mdraftBtn(parent,cls,text,fn){
    var b=document.createElement('button');
    b.type='button'; b.className=cls; b.textContent=text; b.onclick=fn;
    parent.appendChild(b);
    return b;
  }
  function mdraftBusy(node,on){
    var kids=(node&&node.children)||[];
    for(var i=0;i<kids.length;i++){ if(kids[i]&&kids[i].tagName==='BUTTON') kids[i].disabled=on; }
  }
  function mdraftRemove(node){ if(node&&node.parentNode) node.parentNode.removeChild(node); }
  function mdraftFind(node,cls){
    if(!node) return null;
    if(String(node.className||'').split(' ').indexOf(cls)>=0) return node;
    var kids=node.children||[];
    for(var i=0;i<kids.length;i++){ var hit=mdraftFind(kids[i],cls); if(hit) return hit; }
    return null;
  }
  function mdraftAddr(entry){
    if(entry==null) return '';
    if(typeof entry==='string') return entry;
    return mdraftText(entry.address);
  }
  function mdraftHas(list,addr){
    var want=String(addr||'').toLowerCase();
    var arr=mdraftList(list);
    for(var i=0;i<arr.length;i++){ if(String(arr[i]||'').toLowerCase()===want) return true; }
    return false;
  }
  function mdraftBytes(list){
    var total=0, arr=mdraftList(list);
    for(var i=0;i<arr.length;i++){
      var size=Number(arr[i]&&arr[i].size);
      if(isFinite(size)&&size>0) total+=size;
    }
    return total;
  }
  function mdraftMb(bytes){ return (Number(bytes)/1048576).toFixed(1); }
  /* A time the person reads: the day and the clock for a schedule, the clock alone otherwise. */
  function mdraftTime(ms,withDay){
    var t=Number(ms);
    if(!isFinite(t)) return '';
    try{
      return withDay
        ? new Date(t).toLocaleString(MDRAFT_LANG,{weekday:'short',hour:'numeric',minute:'2-digit'})
        : new Date(t).toLocaleTimeString(MDRAFT_LANG,{hour:'numeric',minute:'2-digit'});
    }catch(e){ return new Date(t).toLocaleString(); }
  }
  /* One call on the owner's draft route. A rejected socket answers the offline line, never a throw. */
  function mdraftApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch(MDRAFT_API+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }
  /* A refusal's line: a fixed sentence of our own per code, else the server's own message, which is
     a fixed sentence too (no address, no subject, no body ever rides it). */
  function mdraftRefusal(r){
    var j=(r&&r.j)||null;
    if(!r||r.status===0) return MDRAFT_OFFLINE;
    var code=(j&&typeof j.error==='string')?j.error:'';
    if(code==='cloud_drafting_off') return MDRAFT_CLOUD_OFF;
    if(code==='local_models_only') return MDRAFT_LOCAL_ONLY;
    if(code==='delivery_unsupported'||code==='unavailable') return MDRAFT_TURN_OFF;
    if(code==='not_scheduled') return MDRAFT_NOT_SCHEDULED;
    if(code==='not_discardable') return MDRAFT_NOT_DISCARDABLE;
    if(code==='frozen') return (j&&j.needsCancel)?MDRAFT_NEEDS_CANCEL:MDRAFT_FROZEN;
    if(code==='changed') return MDRAFT_CHANGED_SENTENCE;
    if(r.status===403) return MDRAFT_NOTOWNER;
    if(j&&typeof j.message==='string'&&j.message) return j.message;
    return MDRAFT_ERROR;
  }
  /* After a refusal that means "the draft moved under you", read it again so the card shows the
     revision the server holds. */
  function mdraftSettleRefusal(r,after){
    var j=(r&&r.j)||null;
    if(j&&j.error==='changed'&&typeof after==='function') after();
    return mdraftRefusal(r);
  }

  /* ---- one draft, one card -------------------------------------------------- */
  function mdraftRcpts(card,label,list,flags,rev){
    var arr=mdraftList(list);
    for(var i=0;i<arr.length;i++){
      var addr=mdraftAddr(arr[i]);
      if(!addr) continue;
      var row=document.createElement('div'); row.className='mdraft-rcpt';
      row.appendChild(line('mdraft-label',label));
      var name=(arr[i]&&typeof arr[i]==='object'&&arr[i].name)?mdraftText(arr[i].name):'';
      if(name) row.appendChild(line('mdraft-name',name));
      row.appendChild(line('mdraft-addr',addr));
      if(mdraftHas(flags.newRecipients,addr)) row.appendChild(line('mdraft-new',MDRAFT_NEW));
      if(mdraftHas(flags.changedRecipients,addr)){
        row.appendChild(line('mdraft-changed',mdraftFill(MDRAFT_CHANGED,{n:rev})));
      }
      card.appendChild(row);
    }
  }

  /* The body, a line at a time: a tap on a line asks the bot about THAT line. A line the person
     already commented on, on this revision, shows the bubble while its comment waits. A frozen or
     finished draft shows the same text and no line to tap. */
  function mdraftBody(card,payload,refetch){
    var head=payload.head||{};
    var draft=payload.draft||{};
    var editable=!!MDRAFT_EDITABLE[String(draft.state||'')];
    var body=mdraftText(head.body);
    var rows=body.split(MDRAFT_NL);
    var wrap=document.createElement('div'); wrap.className='mdraft-body';
    card.appendChild(wrap);
    for(var i=0;i<rows.length;i++){
      (function(index,text){
        var seg=document.createElement('div'); seg.className='mdraft-lineseg';
        var row=document.createElement('div');
        row.className=editable?'mdraft-line':'mdraft-line mdraft-line-static';
        row.setAttribute('data-line',String(index));
        row.appendChild(line('mdraft-linetext',text));
        if(editable) row.onclick=function(){ mdraftCommentForm(seg,payload,refetch,index,text); };
        seg.appendChild(row);
        var waiting=editable?mdraftWaitingComment(payload,index):null;
        if(waiting) seg.appendChild(line('mdraft-revising',MDRAFT_REVISING));
        wrap.appendChild(seg);
      })(i,rows[i]);
    }
  }
  function mdraftWaitingComment(payload,index){
    var comments=mdraftList(payload.comments);
    var head=payload.head||{};
    for(var i=0;i<comments.length;i++){
      var c=comments[i]||{};
      if(String(c.state)!=='queued') continue;
      if(Number(c.rev)!==Number(head.rev)) continue;
      if(Number(c.lineIndex)!==Number(index)) continue;
      return c;
    }
    return null;
  }
  /* One comment on one line: the person's words, posted against the revision they are reading. */
  function mdraftCommentForm(seg,payload,refetch,index,quote){
    if(mdraftFind(seg,'mdraft-cform')) return;
    var draft=payload.draft||{};
    var head=payload.head||{};
    var form=document.createElement('div'); form.className='mdraft-form mdraft-cform';
    var box=document.createElement('textarea'); box.className='mdraft-comment';
    box.value=''; box.placeholder=MDRAFT_NOTE;
    var status=line('mdraft-comment-status','');
    var row=document.createElement('div'); row.className='mdraft-actions';
    mdraftBtn(row,'primary mdraft-comment-send',MDRAFT_COMMENT,function(){
      var text=String(box.value==null?'':box.value).trim();
      if(!text) return;
      mdraftBusy(row,true);
      mdraftApi('POST','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/comments',
        {rev:Number(head.rev),lineIndex:index,quote:mdraftText(quote),text:text}).then(function(r){
        if(!live()) return;
        if(r&&r.ok){ mdraftRemove(form); refetch(); return; }
        mdraftBusy(row,false);
        status.textContent=mdraftSettleRefusal(r,refetch);
      });
    });
    mdraftBtn(row,'mdraft-cancel',MDRAFT_CANCEL,function(){ mdraftRemove(form); });
    form.appendChild(box); form.appendChild(row); form.appendChild(status);
    seg.appendChild(form);
    if(box.focus) box.focus();
  }

  /* The audience chip row: one tap writes the draft's audience column, the hint the drafting turn
     reads. */
  function mdraftAudience(card,payload,refetch){
    var draft=payload.draft||{};
    var wrap=document.createElement('div'); wrap.className='mdraft-audience';
    wrap.appendChild(line('mdraft-label',MDRAFT_AUDIENCE));
    var status=line('mdraft-audience-status','');
    for(var i=0;i<MDRAFT_AUDIENCES.length;i++){
      (function(value,label){
        var on=String(draft.audience||'')===value;
        mdraftBtn(wrap,'mdraft-chip'+(on?' mdraft-chip-on':''),label,function(){
          mdraftApi('PATCH','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/audience',{audience:value}).then(function(r){
            if(!live()) return;
            if(r&&r.ok){ refetch(); return; }
            status.textContent=mdraftSettleRefusal(r,refetch);
          });
        });
      })(MDRAFT_AUDIENCES[i],MDRAFT_AUDIENCE_LABELS[i]);
    }
    wrap.appendChild(status);
    card.appendChild(wrap);
  }

  /* Draft history: every revision in order, with who wrote it. */
  function mdraftHistory(card,payload){
    var list=document.createElement('div'); list.className='mdraft-history-list'; list.hidden=true;
    var rows=mdraftList(payload.history);
    for(var i=0;i<rows.length;i++){
      var row=rows[i]||{};
      list.appendChild(line('mdraft-history-row',
        mdraftFill(MDRAFT_HISTORY_ROW,{n:Number(row.rev),author:mdraftText(row.author)})));
      if(row.note) list.appendChild(line('mdraft-note',mdraftText(row.note)));
    }
    card.appendChild(list);
    return list;
  }

  /* "Edit by hand": the person's own text, posted as the next revision. The Bcc is not offered here
     (it waits for the operator), and the head revision's attachments ride along so an edit never
     drops them. */
  function mdraftEditForm(card,actions,payload,refetch,status){
    if(mdraftFind(card,'mdraft-form')) return;
    var head=payload.head||{};
    var draft=payload.draft||{};
    var form=document.createElement('div'); form.className='mdraft-form';
    var fields={};
    var spec=[['to',MDRAFT_TO,mdraftList(head.to).map(mdraftAddr).join(', '),false],
      ['cc',MDRAFT_CC,mdraftList(head.cc).map(mdraftAddr).join(', '),false],
      ['subject',MDRAFT_SUBJECT,mdraftText(head.subject),false],
      ['body','',mdraftText(head.body),true]];
    for(var i=0;i<spec.length;i++){
      var entry=spec[i];
      var wrap=document.createElement('div'); wrap.className='mdraft-field';
      if(entry[1]){
        var label=document.createElement('label'); label.className='mdraft-label';
        label.textContent=entry[1];
        wrap.appendChild(label);
      }
      var input=entry[3]?document.createElement('textarea'):document.createElement('input');
      if(!entry[3]) input.type='text';
      input.value=entry[2];
      wrap.appendChild(input);
      form.appendChild(wrap);
      fields[entry[0]]=input;
    }
    var row=document.createElement('div'); row.className='mdraft-actions';
    mdraftBtn(row,'primary mdraft-save',MDRAFT_SAVE,function(){
      mdraftBusy(row,true);
      var split=function(v){
        var parts=String(v==null?'':v).split(','), out=[];
        for(var i=0;i<parts.length;i++){ var p=parts[i].trim(); if(p) out.push(p); }
        return out;
      };
      mdraftApi('POST','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/revisions',{
        expectHash:mdraftText(draft.headHash),
        to:split(fields.to.value),
        cc:split(fields.cc.value),
        subject:String(fields.subject.value==null?'':fields.subject.value),
        body:String(fields.body.value==null?'':fields.body.value),
        attachments:mdraftList(head.attachments)
      }).then(function(r){
        if(!live()) return;
        if(r&&r.ok){ mdraftRemove(form); refetch(); return; }
        mdraftBusy(row,false);
        status.textContent=mdraftSettleRefusal(r,refetch);
      });
    });
    mdraftBtn(row,'mdraft-cancel',MDRAFT_CANCEL,function(){ mdraftRemove(form); });
    form.appendChild(row);
    card.insertBefore(form,actions);
  }

  /* The note box: the person's words for the bot, posted as one drafting turn. */
  function mdraftNoteBox(card,draft,head,refetch,status){
    var bot=mdraftText(draft.botId);
    if(!bot) return;
    var wrap=document.createElement('div'); wrap.className='mdraft-notebox';
    var box=document.createElement('textarea'); box.className='mdraft-note'; box.placeholder=MDRAFT_NOTE;
    var row=document.createElement('div'); row.className='mdraft-actions';
    mdraftBtn(row,'primary mdraft-note-send',MDRAFT_NOTE_SEND,function(){
      var text=String(box.value==null?'':box.value).trim();
      if(!text) return;
      mdraftBusy(row,true);
      /* reviseFrom is the wording the person wrote by hand, when the head revision is theirs. */
      var mine=String((head&&head.author)||'')==='user'?mdraftText(head.body):null;
      mdraftApi('POST','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/turn',
        {botId:bot,instruction:text,reviseFrom:mine}).then(function(r){
        if(!live()) return;
        mdraftBusy(row,false);
        if(r&&r.ok){ box.value=''; refetch(); return; }
        status.textContent=mdraftSettleRefusal(r,refetch);
      });
    });
    wrap.appendChild(box); wrap.appendChild(row);
    card.appendChild(wrap);
  }

  function mdraftOpenSheet(draft,status,refetch){
    var due=draft&&draft.dueAt!=null?Number(draft.dueAt):null;
    if(typeof mailDraftSheet==='function'){ mailDraftSheet(draft,due,refetch); return; }
    status.textContent=MDRAFT_SHEET_MISSING;
  }

  /* The buttons, per state. Every one of them is a person's own press. */
  function mdraftActions(card,payload,refetch,status){
    var draft=payload.draft||{};
    var head=payload.head||{};
    var state=String(draft.state||'draft');
    var actions=document.createElement('div'); actions.className='mdraft-actions';
    card.appendChild(actions);
    var id=mdraftText(draft.id);
    var hash=mdraftText(draft.headHash);
    var post=function(action,body,after){
      mdraftBusy(actions,true);
      mdraftApi('POST','/drafts/'+encodeURIComponent(id)+'/'+action,body).then(function(r){
        if(!live()) return;
        if(r&&r.ok){ if(after) after(r); refetch(); return; }
        mdraftBusy(actions,false);
        status.textContent=mdraftSettleRefusal(r,refetch);
      });
    };
    var send=function(confirmUnknown){
      post('send',confirmUnknown?{hash:hash,confirmUnknown:true}:{hash:hash});
    };

    if(state==='sent'){
      var receipt=payload.receipt||null;
      var account=mdraftText((receipt&&receipt.accountLabel)||'');
      var when=mdraftTime((receipt&&receipt.sentAt)||draft.sentAt,true);
      var sentence=mdraftFill(MDRAFT_SENT,{account:account,time:when});
      var link=receipt&&typeof receipt.readerLink==='string'?receipt.readerLink:'';
      if(link.indexOf('/dashboard/mail?')===0){
        var a=document.createElement('a'); a.className='mdraft-sent'; a.href=link;
        a.textContent=sentence;
        status.appendChild(a);
      }else{
        status.textContent=sentence;
        card.appendChild(line('mdraft-syncing',MDRAFT_SYNCING));
      }
      return;
    }
    if(state==='discarded'){ status.textContent=MDRAFT_DISCARDED; return; }
    if(state==='holding'){
      status.textContent=MDRAFT_SENDING;
      mdraftBtn(actions,'mdraft-undo',MDRAFT_UNDO,function(){ post('undo',{}); });
      return;
    }
    if(state==='scheduled'){
      var from=mdraftText(head.from&&head.from.name?head.from.name:(head.from?head.from.address:''));
      status.textContent=mdraftFill(MDRAFT_SCHEDULED,{time:mdraftTime(draft.dueAt,true),account:from});
      mdraftBtn(actions,'mdraft-change-time',MDRAFT_CHANGE_TIME,function(){
        mdraftOpenSheet(draft,status,refetch);
      });
      mdraftBtn(actions,'mdraft-cancel-send',MDRAFT_CANCEL_SEND,function(){
        post('cancel-schedule',{});
      });
      card.appendChild(line('mdraft-edit-note',MDRAFT_EDIT_CANCELS));
      return;
    }
    if(state==='unknown'){
      /* Nobody knows whether it went out: the only words here are the could-not-confirm sentence,
         and a resend takes one more press after the person has looked in Sent. */
      status.textContent=MDRAFT_UNKNOWN;
      mdraftBtn(actions,'primary mdraft-send',MDRAFT_SEND,function(){
        if(mdraftFind(actions,'mdraft-confirm')) return;
        mdraftBtn(actions,'mdraft-confirm',MDRAFT_CONFIRM_SEND,function(){ send(true); });
      });
      return;
    }
    if(state==='failed'||state==='missed'){
      status.textContent=state==='missed'
        ? mdraftFill(MDRAFT_MISSED,{time:mdraftTime(draft.dueAt,false)})
        : MDRAFT_FAILED;
      mdraftBtn(actions,'primary mdraft-send',MDRAFT_SEND,function(){ send(false); });
      mdraftBtn(actions,'mdraft-schedule',MDRAFT_SCHEDULE,function(){ mdraftOpenSheet(draft,status,refetch); });
      mdraftMore(card,actions,draft,payload,refetch,status);
      return;
    }
    /* draft (and any state the card does not know): Send is the tap, Schedule freezes it. */
    mdraftBtn(actions,'primary mdraft-send',MDRAFT_SEND,function(){ send(false); });
    mdraftBtn(actions,'mdraft-schedule',MDRAFT_SCHEDULE,function(){ mdraftOpenSheet(draft,status,refetch); });
    mdraftMore(card,actions,draft,payload,refetch,status);
  }
  /* "..." — Edit by hand, Save as draft, Discard. Collapsed until the person opens it. */
  function mdraftMore(card,actions,draft,payload,refetch,status){
    var menu=document.createElement('div'); menu.className='mdraft-menu'; menu.hidden=true;
    mdraftBtn(menu,'mdraft-edit',MDRAFT_EDIT,function(){ mdraftEditForm(card,actions,payload,refetch,status); });
    mdraftBtn(menu,'mdraft-save',MDRAFT_SAVE,function(){
      mdraftBusy(menu,true);
      mdraftApi('POST','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/save-draft',
        {expectHash:mdraftText(draft.headHash)}).then(function(r){
        if(!live()) return;
        mdraftBusy(menu,false);
        if(r&&r.ok){
          var folder=(r.j&&typeof r.j.folder==='string')?r.j.folder:'';
          status.textContent=mdraftFill(MDRAFT_SAVED,{folder:folder});
          return;
        }
        status.textContent=mdraftSettleRefusal(r,refetch);
      });
    });
    mdraftBtn(menu,'mdraft-discard',MDRAFT_DISCARD,function(){
      mdraftBusy(menu,true);
      mdraftApi('POST','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/discard',{}).then(function(r){
        if(!live()) return;
        if(r&&r.ok){ refetch(); return; }
        mdraftBusy(menu,false);
        status.textContent=mdraftSettleRefusal(r,refetch);
      });
    });
    card.appendChild(menu);
    mdraftBtn(actions,'mdraft-more',MDRAFT_MORE,function(){ menu.hidden=!menu.hidden; });
  }

  /* One card, from one answer of the draft route. */
  function mdraftCard(payload,refetch){
    var draft=payload&&payload.draft?payload.draft:null;
    var head=payload&&payload.head?payload.head:null;
    if(!draft||!head) return null;
    var flags=(payload.flags&&typeof payload.flags==='object')?payload.flags:{};
    var subject=mdraftText(head.subject)||MDRAFT_NOSUBJECT;
    var from=head.from||{};
    var account=mdraftText(from.name)||mdraftText(from.address);
    /* The header names the bot that wrote it; a draft with no bot names the account it is from. */
    var bot=mdraftText(draft.botId)||account;
    var rev=Number(head.rev)||1;
    var card=document.createElement('div');
    card.className='entry mdraft-card';
    card.setAttribute('data-maildraft-id',mdraftText(draft.id));
    card.setAttribute('role','group');
    card.setAttribute('aria-label',mdraftFill(MDRAFT_HEAD,{bot:bot,subject:subject}));
    card.appendChild(line('mdraft-head',mdraftFill(MDRAFT_HEAD,{bot:bot,subject:subject})));

    mdraftRcpts(card,MDRAFT_TO,head.to,flags,rev);
    mdraftRcpts(card,MDRAFT_CC,head.cc,flags,rev);
    if(mdraftList(head.bcc).length) mdraftRcpts(card,MDRAFT_BCC,head.bcc,flags,rev);
    card.appendChild(line('mdraft-label',MDRAFT_SUBJECT));
    card.appendChild(line('mdraft-subject',subject));
    if(flags.replyToDiffers){
      card.appendChild(line('mdraft-replyto',mdraftFill(MDRAFT_REPLYTO,{address:mdraftText(flags.replyToDiffers)})));
    }
    card.appendChild(line('mdraft-from',
      mdraftFill(MDRAFT_FROM,{account:account,n:rev})+MDRAFT_DOT+(payload.voice?MDRAFT_FOLLOWS:MDRAFT_NOTCHECKED)));

    mdraftBody(card,payload,refetch);
    var bytes=mdraftBytes(head.attachments);
    if(bytes>0) card.appendChild(line('mdraft-size',mdraftFill(MDRAFT_SIZE,{n:mdraftMb(bytes)})));

    var editable=!!MDRAFT_EDITABLE[String(draft.state||'')];
    if(editable) mdraftAudience(card,payload,refetch);

    var status=line('mdraft-status',''); status.setAttribute('role','status');
    card.appendChild(status);
    mdraftActions(card,payload,refetch,status);

    /* The queues: one waiting comment means the bot is already on it; several wait for Revise. */
    var waiting=0;
    var comments=mdraftList(payload.comments);
    for(var ci=0;ci<comments.length;ci++) if(String((comments[ci]||{}).state)==='queued') waiting+=1;
    var tail=document.createElement('div'); tail.className='mdraft-actions';
    if(editable&&waiting>0){
      mdraftBtn(tail,'mdraft-revise',MDRAFT_REVISE,function(){
        mdraftBusy(tail,true);
        mdraftApi('POST','/drafts/'+encodeURIComponent(mdraftText(draft.id))+'/revise',
          {expectHash:mdraftText(draft.headHash),chatNote:null}).then(function(r){
          if(!live()) return;
          mdraftBusy(tail,false);
          if(r&&r.ok){ refetch(); return; }
          status.textContent=mdraftSettleRefusal(r,refetch);
        });
      });
    }
    if(editable) mdraftNoteBox(card,draft,head,refetch,status);
    card.appendChild(tail);

    /* Draft history and the writing rules: both read-only, both open in place. */
    var links=document.createElement('div'); links.className='mdraft-actions';
    var history=mdraftHistory(card,payload);
    mdraftBtn(links,'mdraft-history',MDRAFT_HISTORY,function(){ history.hidden=!history.hidden; });
    var rules=document.createElement('a'); rules.className='mdraft-rules'; rules.href=MDRAFT_RULES_HREF;
    rules.textContent=MDRAFT_WRITING_RULES;
    links.appendChild(rules);
    card.appendChild(links);
    return card;
  }

  /* ---- mounting ------------------------------------------------------------ */
  /* The key an answer is drawn from: a redraw only when something the card shows moved. */
  function mdraftKey(payload){
    var draft=payload.draft||{}, head=payload.head||{};
    var flags=payload.flags||{};
    return [mdraftText(draft.state),mdraftText(draft.headHash),mdraftText(draft.audience),
      mdraftText(draft.dueAt),mdraftText(draft.failReason),mdraftText(head.rev),
      mdraftText(head.subject),payload.voice?'1':'0',
      mdraftList(flags.newRecipients).join(','),mdraftList(flags.changedRecipients).join(','),
      mdraftText(flags.replyToDiffers),
      mdraftList(payload.comments).map(function(c){ return mdraftText(c&&c.id)+':'+mdraftText(c&&c.state); }).join(','),
      mdraftList(payload.history).length].join('|');
  }
  function mdraftDraw(payload,opts){
    var draft=payload&&payload.draft?payload.draft:null;
    if(!draft) return null;
    var id=mdraftText(draft.id);
    var key=mdraftKey(payload);
    var old=mdraftNodes[id];
    if(old&&old.parentNode&&mdraftKeys[id]===key) return old;
    var node=mdraftCard(payload,function(){ mdraftLoad(id,opts); });
    if(!node) return null;
    if(old&&old.parentNode){
      old.parentNode.insertBefore(node,old);
      old.parentNode.removeChild(old);
    }else{
      var tr=el('perch-transcript');
      if(!tr) return null;
      if(opts&&opts.top) tr.insertBefore(node,tr.firstChild);
      else tr.appendChild(node);
    }
    mdraftNodes[id]=node; mdraftKeys[id]=key;
    return node;
  }
  /* Read one draft and draw it. opts.top mounts it at the top of the panel (the query card);
     opts.sid is the chat the read was made for, so a read that lands after a session switch draws
     nothing. */
  function mdraftLoad(id,opts){
    var myId=mdraftText(id);
    if(!MDRAFT_ID.test(myId)) return null;
    return mdraftApi('GET','/drafts/'+encodeURIComponent(myId)).then(function(r){
      if(!live()) return null;
      if(opts&&opts.sid&&current.sid!==String(opts.sid)) return null;
      if(!r||!r.ok||!r.j||!r.j.draft) return null;
      return mdraftDraw(r.j,opts);
    });
  }
  /* The ids this chat's own drafts list returns. The list is ids only: each card is read from the
     draft route, which is where the fields, the flags and the receipt come from. */
  function loadMailDrafts(sid){
    if(!sid) return;
    var mySid=String(sid);
    perchApi('GET','/interactive/'+encodeURIComponent(mySid)+'/mail-drafts').then(function(r){
      if(!live()||current.sid!==mySid) return;
      if(!r||!r.ok||!r.j||!Array.isArray(r.j.drafts)) return;
      var ids=[];
      for(var i=0;i<r.j.drafts.length;i++){
        var entry=r.j.drafts[i];
        if(entry&&typeof entry.id==='string'&&MDRAFT_ID.test(entry.id)) ids.push(entry.id);
      }
      mdraftPrune(ids);
      /* Oldest first, so the newest draft lands last, where the eye already is. */
      for(var k=ids.length-1;k>=0;k--) mdraftLoad(ids[k],{sid:mySid});
    });
  }
  function mdraftPrune(ids){
    var keep={};
    for(var i=0;i<ids.length;i++) keep[ids[i]]=true;
    if(mdraftQueryId) keep[mdraftQueryId]=true;
    for(var k in mdraftNodes){
      if(keep[k]) continue;
      mdraftRemove(mdraftNodes[k]);
      delete mdraftNodes[k]; delete mdraftKeys[k];
    }
  }
  /* The draft id in the page's own query, checked against the store's shape BEFORE any request. */
  function mdraftQuery(){
    var q='';
    try{ q=mdraftText(location.search); }catch(e){ q=''; }
    var m=MDRAFT_QUERY.exec(q);
    if(!m) return null;
    return MDRAFT_ID.test(m[1])?m[1]:null;
  }
  /* A draft made in the reader has no chat to list it: it rides the page's query and is mounted at
     the top of the chat panel. The id is validated first; a malformed one asks for nothing. */
  function loadMailDraftFromQuery(){
    var id=mdraftQuery();
    if(!id) return;
    if(mdraftQueryId===id&&mdraftNodes[id]&&mdraftNodes[id].parentNode) return;
    mdraftQueryId=id;
    mdraftLoad(id,{top:true});
  }
  /* A session switch: the transcript, and every card in it, is gone. */
  function resetMailDrafts(){
    for(var k in mdraftNodes) mdraftRemove(mdraftNodes[k]);
    mdraftNodes={}; mdraftKeys={}; mdraftQueryId=null;
  }
`;
}